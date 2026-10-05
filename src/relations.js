// 人物关系图谱：结构化的角色关系边，AI 分析、手动编辑、防剧透过滤、接入角色卡
// 关系类型是自由文本：内置 8 种 + 用户的自定义类型只是参考（建议），AI 和用户都可以直接写更贴切的短类型
// （师兄妹、青梅竹马、主仆……）。与已知类型的 value 或显示名相同时存成那个 value，否则存这段文字本身（见 normalizeRelationType）。

import { callLLM, chainFor } from './llm.js';
import { extractJson, removeTags } from './json.js';
import { getPrompt, render } from './prompts.js';
import { characterAt, characterProfileText, IMPORTANCE_RANK } from './project.js';
import { hashString, truncate, uid, uniq } from './utils.js';

export const RELATIONSHIP_TYPES = [
    { value: 'romantic', label: '爱慕/恋人', color: '#e0668f' },
    { value: 'family', label: '家人', color: '#4a90d9' },
    { value: 'friend', label: '朋友', color: '#4caf7d' },
    { value: 'mentor', label: '师徒/上下级', color: '#9b7fd4' },
    { value: 'ally', label: '同伴/盟友', color: '#59b3b3' },
    { value: 'rival', label: '对手/竞争', color: '#d9a441' },
    { value: 'enemy', label: '敌对', color: '#d9534f' },
    { value: 'other', label: '其他', color: '#8a8a8a' },
];

/**
 * 自由类型（不是已知类型）按关键词归到一个内置大类，只用来给它配颜色（以前也用来把 AI 写的中文类型换成内置类型）。
 * 同门、师徒、主仆放在「家人」前面：师兄妹、徒弟、弟子里的「兄」「弟」不是亲属。
 */
const TYPE_GUESS = [
    [/恋|爱慕|喜欢|夫妻|情侣|暗恋|前男友|前女友|未婚妻|未婚夫/, 'romantic'],
    [/同门|师兄|师姐|师弟|师妹/, 'ally'],
    [/师徒|师父|师傅|师尊|徒弟|弟子|主仆|主人|仆|侍从|侍女|护卫|上级|下属|上司|老板|下级/, 'mentor'],
    [/家人|父|母|兄|弟|姐|妹|子|女儿|儿子|亲人|夫人|丈夫|妻子/, 'family'],
    [/同伴|盟友|队友|战友|搭档/, 'ally'],
    [/对手|竞争|情敌/, 'rival'],
    [/敌|仇|恨/, 'enemy'],
    [/朋友|挚友|好友|同学|同事|青梅|竹马|发小|闺蜜|知己/, 'friend'],
];

/** 自由填写的关系类型最多几个字 */
export const RELATION_TYPE_MAX = 8;
/** 自定义类型的 value（ctype_…）：类型被删除后，已有关系仍保留这个编号 */
const CUSTOM_VALUE_RE = /^ctype_[\w-]+$/;
const OTHER_COLOR = '#8a8a8a';

// ---------------- 自定义关系类型（保存在扩展设置里，跨项目共享） ----------------

const CUSTOM_TYPE_COLORS = ['#3fb6c9', '#c77dd1', '#7d9c3f', '#cc8b5c', '#5c8fcc', '#a3a34a', '#c96fa0', '#6fa8c9'];

/** 用户在设置中新增的自定义关系类型（不含内置类型） */
export function customRelationTypes(settings) {
    const list = Array.isArray(settings?.customRelationTypes) ? settings.customRelationTypes : [];
    return list.filter((t) => t?.value && t?.label).map((t) => ({ value: String(t.value), label: String(t.label), color: t.color || '#8a8a8a', custom: true }));
}

/** 内置 + 自定义类型的合并列表（自定义类型若与内置 value 冲突则忽略，避免覆盖内置语义） */
export function allRelationTypes(settings) {
    const custom = customRelationTypes(settings);
    if (!custom.length) return RELATIONSHIP_TYPES;
    const builtinValues = new Set(RELATIONSHIP_TYPES.map((t) => t.value));
    return [...RELATIONSHIP_TYPES, ...custom.filter((t) => !builtinValues.has(t.value))];
}

export function addCustomRelationType(settings, { label, color } = {}) {
    if (!Array.isArray(settings.customRelationTypes)) settings.customRelationTypes = [];
    const lbl = String(label || '').trim();
    if (!lbl) throw new Error('请输入关系类型名称');
    if (allRelationTypes(settings).some((t) => t.label === lbl)) throw new Error('已存在同名的关系类型');
    const t = { value: uid('ctype_'), label: lbl, color: color || CUSTOM_TYPE_COLORS[settings.customRelationTypes.length % CUSTOM_TYPE_COLORS.length] };
    settings.customRelationTypes.push(t);
    return t;
}

export function updateCustomRelationType(settings, value, patch = {}) {
    const t = (settings.customRelationTypes || []).find((x) => x.value === value);
    if (!t) return null;
    if (patch.label !== undefined) {
        const lbl = String(patch.label).trim();
        if (lbl) t.label = lbl;
    }
    if (patch.color) t.color = patch.color;
    return t;
}

/** 删除自定义类型；已使用该类型的关系边保留原 value（不会被强制改为「其他」），只是不再出现在下拉选项里 */
export function removeCustomRelationType(settings, value) {
    if (!Array.isArray(settings.customRelationTypes)) return false;
    const n = settings.customRelationTypes.length;
    settings.customRelationTypes = settings.customRelationTypes.filter((t) => t.value !== value);
    return settings.customRelationTypes.length !== n;
}

// ---------------- 关系模板（保存在扩展设置里，跨项目共享） ----------------
// 一个模板 = 名称 + 关系类型 + 单向/双向 + 说明写法；说明里的 {A}/{B} 代表两个角色。
// 手动添加/编辑关系时可一键套用；「AI 分析关系」时写进提示词，让 AI 优先按这些模板归类。

export function relationTemplates(settings) {
    const list = Array.isArray(settings?.relationTemplates) ? settings.relationTemplates : [];
    return list
        .filter((t) => t?.id && String(t.name || '').trim())
        .map((t) => ({ id: String(t.id), name: String(t.name).trim(), type: String(t.type || 'other'), mutual: !!t.mutual, label: String(t.label || ''), createdAt: t.createdAt || 0 }));
}

export function addRelationTemplate(settings, { name, type = 'other', mutual = false, label = '' } = {}) {
    if (!Array.isArray(settings.relationTemplates)) settings.relationTemplates = [];
    const n = String(name || '').trim();
    if (!n) throw new Error('请输入模板名称');
    if (relationTemplates(settings).some((t) => t.name === n)) throw new Error('已存在同名的关系模板');
    const t = { id: uid('rtpl_'), name: n, type: normalizeRelationType(type, settings), mutual: !!mutual, label: String(label || '').trim(), createdAt: Date.now() };
    settings.relationTemplates.push(t);
    return t;
}

export function updateRelationTemplate(settings, id, patch = {}) {
    const t = (settings.relationTemplates || []).find((x) => x.id === id);
    if (!t) return null;
    if (patch.name !== undefined) {
        const n = String(patch.name).trim();
        if (n && !relationTemplates(settings).some((x) => x.id !== id && x.name === n)) t.name = n;
    }
    if (patch.type !== undefined) t.type = normalizeRelationType(patch.type, settings);
    if (patch.mutual !== undefined) t.mutual = !!patch.mutual;
    if (patch.label !== undefined) t.label = String(patch.label).trim();
    return t;
}

export function removeRelationTemplate(settings, id) {
    if (!Array.isArray(settings.relationTemplates)) return false;
    const n = settings.relationTemplates.length;
    settings.relationTemplates = settings.relationTemplates.filter((t) => t.id !== id);
    return settings.relationTemplates.length !== n;
}

/** 套用模板：返回要填进关系的类型、方向和说明（{A}/{B} 换成两个角色名；角色还没选时保留占位符） */
export function applyRelationTemplate(template, from = '', to = '') {
    const label = String(template?.label || '')
        .replace(/\{A\}/g, from || '{A}')
        .replace(/\{B\}/g, to || '{B}');
    return { type: template?.type || 'other', mutual: !!template?.mutual, label };
}

/**
 * 「AI 分析关系」提示词里的 {TYPES}：参考类型（内置 + 自定义）与「可以写更贴切的短类型」的说明，加上用户的关系模板。
 * 说明写在这里而不只在主提示里，用户改过的旧提示词（用 {TYPES}）也能拿到。
 */
export function relationTypesPromptText(settings) {
    const types = allRelationTypes(settings).map((t) => `${t.value}=${t.label}`).join('、');
    const head = `参考类型（type 写等号前的代码或等号后的中文名都可以）：${types}\n这些只是参考：参考类型不够贴切时，type 直接写一个更准确的简短关系词（2-6 个字，最多 ${RELATION_TYPE_MAX} 个字），如 师兄妹、青梅竹马、主仆、宿敌、养父女；不要为了套用参考类型写成笼统的 other。`;
    const tpls = relationTemplates(settings);
    if (!tpls.length) return head;
    const typeText = (v) => (findRelationType(v, settings) ? `${v}（${relationTypeLabel(v, settings)}）` : v);
    const lines = tpls.map((t) => `- ${t.name}：type=${typeText(t.type)}，${t.mutual ? '双向' : '单向 A→B'}${t.label ? `，说明写法参考：${t.label}` : ''}`);
    return `${head}\n\n用户常用的关系模板（判断关系时优先套用这些模板的类型与方向；说明可参照写法，把 {A}/{B} 换成具体角色并写出本书的具体情节）：\n${lines.join('\n')}`;
}

/** 已知类型（内置 + 自定义）里 value 为 v 的那个；没有时按显示名找 */
function findRelationType(v, settings) {
    const s = String(v ?? '').trim();
    if (!s) return null;
    const types = allRelationTypes(settings);
    return types.find((t) => t.value === s) || types.find((t) => t.label === s) || null;
}

/**
 * 关系类型规整（AI 分析、手动填写、关系模板、导入共用）：去掉首尾空白和括号引号，最多 8 个字；
 * 与已知类型（内置 + 自定义）的 value（不分大小写）或显示名相同时换成它的 value，否则把这段文字本身当作类型。空值为 other。
 * 自定义类型的编号（ctype_…）即使那个类型已被删除也原样保留（删除自定义类型不改动已有关系）。
 */
export function normalizeRelationType(v, settings) {
    const raw = String(v ?? '').replace(/\s+/g, ' ').trim();
    const types = allRelationTypes(settings);
    const known = (x) => types.find((t) => t.value.toLowerCase() === x.toLowerCase() || t.label === x);
    const exact = raw && known(raw);
    if (exact) return exact.value;
    // 整个包在引号或括号里时去掉（「师兄妹」→ 师兄妹）；只有一边的不动（养父女（改））
    const s = raw.replace(/^[「『“"'（(【[]([^]*)[」』”"'）)】\]]$/, '$1').trim();
    if (!s) return 'other';
    const hit = known(s);
    if (hit) return hit.value;
    if (CUSTOM_VALUE_RE.test(s)) return s;
    const short = Array.from(s).slice(0, RELATION_TYPE_MAX).join('').trim();
    return known(short)?.value || short;
}

/** 类型的显示名：已知类型用它的名字，自由类型就是它自己；已删除的自定义类型（只剩编号）和空值显示为「其他」 */
export function relationTypeLabel(v, settings) {
    const t = findRelationType(v, settings);
    if (t) return t.label;
    const s = String(v ?? '').trim();
    return !s || CUSTOM_VALUE_RE.test(s) ? '其他' : s;
}

/**
 * 类型的颜色：已知类型用它的颜色；自由类型按关键词归到内置大类时用那一类的颜色（师兄妹 → 同伴/盟友），
 * 归不了类时按文字算一个固定的颜色（同一个类型每次都一样）；已删除的自定义类型和空值是「其他」的灰色。
 */
export function relationTypeColor(v, settings) {
    const t = findRelationType(v, settings);
    if (t) return t.color || OTHER_COLOR;
    const s = String(v ?? '').trim();
    if (!s || CUSTOM_VALUE_RE.test(s)) return OTHER_COLOR;
    const g = guessType(s);
    if (g) return RELATIONSHIP_TYPES.find((x) => x.value === g).color;
    return hashedTypeColor(s);
}

function hslToRgb(h, s, l) {
    const c = (1 - Math.abs(2 * l - 1)) * s;
    const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
    const m = l - c / 2;
    const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
    return [r + m, g + m, b + m].map((v) => Math.round(v * 255));
}

/** WCAG 相对亮度（0~1） */
function relLuminance([r, g, b]) {
    const lin = (v) => {
        const c = v / 255;
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/**
 * 按文字算的固定颜色：色相取哈希，饱和度 55%，明度按色相调到相对亮度约 0.17——
 * 不管什么色相，在深色和浅色聊天主题上的对比度都在 3.5 左右（和内置类型的颜色一样是中等明度）。返回 #rrggbb。
 */
export function hashedTypeColor(text) {
    const h = parseInt(hashString(text), 16) % 360;
    let lo = 0.15;
    let hi = 0.85;
    for (let i = 0; i < 18; i++) {
        const mid = (lo + hi) / 2;
        if (relLuminance(hslToRgb(h, 0.55, mid)) < 0.17) lo = mid;
        else hi = mid;
    }
    return `#${hslToRgb(h, 0.55, (lo + hi) / 2).map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

function guessType(text) {
    const s = String(text || '');
    for (const [re, type] of TYPE_GUESS) if (re.test(s)) return type;
    return '';
}

/**
 * 筛选、图例、计数用的类型键：已知类型（含按显示名存下的自由文字）归到它的 value，其余就是文字本身，空值为 other。
 * 例如 AI 先写了自由类型「师兄妹」，之后用户新建了同名的自定义类型（ctype_…）：旧关系存的还是文字「师兄妹」、
 * 新关系存的是 ctype_…，两者在筛选和图例里算同一类（设置跨项目共用，在读取时归并，不改动已存的数据）。
 */
export function relationTypeKey(v, settings) {
    const s = String(v ?? '').trim();
    return findRelationType(s, settings)?.value || s || 'other';
}

/**
 * 项目里实际用到的关系类型（筛选、图例用，按 relationTypeKey 归并）：已知类型按内置 / 自定义的顺序在前，
 * 自由类型按条数多少、再按名字排在后面。
 * @param {object[]} list 关系边（通常是 project.relationships）
 * @returns {{value:string, label:string, color:string, count:number, known:boolean}[]}
 */
export function relationTypesInUse(list, settings) {
    const counts = new Map();
    for (const r of list || []) {
        const v = relationTypeKey(r?.type, settings);
        counts.set(v, (counts.get(v) || 0) + 1);
    }
    const known = allRelationTypes(settings).filter((t) => counts.has(t.value)).map((t) => ({ value: t.value, label: t.label, color: relationTypeColor(t.value, settings), count: counts.get(t.value), known: true }));
    const knownValues = new Set(known.map((t) => t.value));
    const free = [...counts.keys()]
        .filter((v) => !knownValues.has(v))
        .map((v) => ({ value: v, label: CUSTOM_VALUE_RE.test(v) ? '其他（已删除的类型）' : relationTypeLabel(v, settings), color: relationTypeColor(v, settings), count: counts.get(v), known: false }))
        .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, 'zh'));
    return [...known, ...free];
}

/** 关系类型输入框的候选（datalist）：已知类型的显示名，再加上项目里已经用过的自由类型（去重） */
export function relationTypeSuggestions(settings, list = []) {
    const out = allRelationTypes(settings).map((t) => t.label);
    for (const t of relationTypesInUse(list, settings)) if (!t.known && !out.includes(t.label)) out.push(t.label);
    return out;
}

export function normalizeRelationship(r = {}, settings) {
    return {
        id: r.id || uid('rel_'),
        from: String(r.from || '').trim(),
        to: String(r.to || '').trim(),
        type: normalizeRelationType(r.type, settings),
        label: String(r.label || '').trim(),
        mutual: !!r.mutual,
        notes: String(r.notes || '').trim(),
        chunk: Number.isFinite(r.chunk) ? r.chunk : 0,
        auto: !!r.auto,
        updatedAt: r.updatedAt || Date.now(),
    };
}

// ---------------- CRUD ----------------

export function addRelationship(project, data, settings) {
    if (!Array.isArray(project.relationships)) project.relationships = [];
    const r = normalizeRelationship({ ...data, id: '' }, settings);
    if (!r.from || !r.to || r.from === r.to) throw new Error('请选择两个不同的角色');
    project.relationships.push(r);
    return r;
}

export function updateRelationship(project, id, patch, settings) {
    const r = (project.relationships || []).find((x) => x.id === id);
    if (!r) return null;
    const next = normalizeRelationship({ ...r, ...patch, id }, settings);
    Object.assign(r, next);
    r.updatedAt = Date.now();
    return r;
}

export function removeRelationship(project, id) {
    const n = (project.relationships || []).length;
    project.relationships = (project.relationships || []).filter((x) => x.id !== id);
    return project.relationships.length !== n;
}

/** 某个角色相关的全部关系（含作为 from 或 to 出现的） */
export function relationsFor(project, name) {
    return (project.relationships || []).filter((r) => r.from === name || r.to === name);
}

/** 到某个时间点（分块序号）为止已经建立的关系（用于防剧透） */
export function relationsAt(project, upto = Infinity) {
    return (project.relationships || []).filter((r) => r.chunk <= upto);
}

/** 关系图谱里出现过的角色名（用于图谱只画有关系的节点） */
export function relationNames(project, upto = Infinity) {
    const set = new Set();
    for (const r of relationsAt(project, upto)) {
        set.add(r.from);
        set.add(r.to);
    }
    return [...set];
}

// ---------------- AI 分析 ----------------

function resolveCharName(project, name) {
    const n = String(name || '').trim();
    if (!n) return '';
    if (project.characters[n]) return n;
    for (const c of Object.values(project.characters)) {
        if (c.aliases?.includes(n)) return c.name;
    }
    return '';
}

/**
 * 合并 AI 分析结果：按（from,to,type）去重，已有的更新说明，没有的新增
 * @returns {{added:number, updated:number, skipped:number}}
 */
export function mergeRelationships(project, list, chunkIndex = 0, settings) {
    if (!Array.isArray(project.relationships)) project.relationships = [];
    let added = 0;
    let updated = 0;
    let skipped = 0;
    for (const item of list || []) {
        const from = resolveCharName(project, item.from ?? item.人物1 ?? item.a);
        const to = resolveCharName(project, item.to ?? item.人物2 ?? item.b);
        if (!from || !to || from === to) {
            skipped++;
            continue;
        }
        // 有 type 时按自由类型规整（已知类型换成它的 value，其他保留原文）；只有一句「关系」描述时按关键词归类
        const rawType = item.type ?? item.类型;
        const type = String(rawType ?? '').trim() ? normalizeRelationType(rawType, settings) : (guessType(item.关系) || 'other');
        const label = String(item.label ?? item.关系 ?? item.说明 ?? '').trim();
        const mutual = item.mutual !== undefined ? !!item.mutual : true;
        const existing = project.relationships.find((r) => (r.from === from && r.to === to) || (r.mutual && mutual && r.from === to && r.to === from));
        if (existing) {
            if (label && label !== existing.label) {
                existing.label = label;
                existing.type = type;
                existing.updatedAt = Date.now();
                updated++;
            }
        } else {
            project.relationships.push(normalizeRelationship({ from, to, type, label, mutual, chunk: chunkIndex, auto: true }, settings));
            added++;
        }
    }
    return { added, updated, skipped };
}

/**
 * AI 分析人物关系：读取角色档案，整理出已确立的关系
 * @param {{signal?:AbortSignal, onLog?:Function, upto?:number}} opt upto：只用到该分块为止的角色资料（防剧透，默认全书）
 */
export async function analyzeRelationships(project, settings, { signal, onLog, upto = Infinity } = {}) {
    const chars = Object.values(project.characters)
        .filter((c) => c.firstChunk <= upto)
        .sort((a, b) => IMPORTANCE_RANK[b.importance] - IMPORTANCE_RANK[a.importance])
        .slice(0, 20);
    if (chars.length < 2) throw new Error('角色数量不足（至少需要 2 个已提取的角色）');
    const profiles = chars.map((c) => characterProfileText(characterAt(c, upto), { maxExperiences: 6, maxQuotes: 4 })).join('\n---\n');
    const existing = relationsAt(project, upto)
        .map((r) => `- ${r.from} → ${r.to}（${relationTypeLabel(r.type, settings)}）：${r.label || '（无说明）'}`)
        .join('\n') || '（无）';
    const vars = {
        BOOK: project.bookName,
        PROFILES: truncate(profiles, 12000),
        EXISTING: existing,
        TYPES: relationTypesPromptText(settings),
    };
    const res = await callLLM({
        api: settings.api,
        system: render(getPrompt(settings, 'relationSystem'), vars),
        prompt: render(getPrompt(settings, 'relation'), vars),
        ...chainFor(settings, 'tools', project),
        expect: 'json',
        signal,
        onNotice: (m, l) => onLog?.(m, l),
    });
    const json = extractJson(removeTags(res.text, settings.extraction?.filterTags));
    const list = Array.isArray(json?.relationships) ? json.relationships : [];
    const upToChunk = Number.isFinite(upto) ? upto : Math.max(0, project.chunks.length - 1);
    return mergeRelationships(project, list, upToChunk, settings);
}

// ---------------- 渲染 ----------------

/** 某角色的关系摘要行（用于角色卡「相关角色」等） */
export function relationLine(project, name, otherName, r, upto, settings) {
    const other = project.characters[otherName];
    if (!other) return '';
    const v = characterAt(other, upto);
    const dir = r.mutual ? relationTypeLabel(r.type, settings) : r.from === name ? relationTypeLabel(r.type, settings) : `${relationTypeLabel(r.type, settings)}·对方视角`;
    return `- ${v.name}${v.aliases?.length ? `（${v.aliases.slice(0, 3).join('/')}）` : ''}：${dir}${r.label ? `，${r.label}` : ''}`;
}

/** 关系图谱的 Markdown 表格（导出用） */
export function relationsMarkdown(project, settings) {
    const list = project.relationships || [];
    if (!list.length) return '';
    const lines = ['## 人物关系', '', '| 角色 | 关系 | 角色 | 说明 |', '| --- | --- | --- | --- |'];
    for (const r of list) {
        lines.push(`| ${r.from} | ${r.mutual ? '↔' : '→'} ${relationTypeLabel(r.type, settings)} | ${r.to} | ${(r.label || '').replace(/\|/g, '/')} |`);
    }
    return lines.join('\n');
}

export function exportRelationshipsJson(project) {
    return { type: 'novelloom-relationships', version: 1, book: project.bookName, relationships: (project.relationships || []).map((r) => ({ from: r.from, to: r.to, type: r.type, label: r.label, mutual: r.mutual, notes: r.notes })) };
}

export function parseRelationshipsJson(json) {
    const list = Array.isArray(json) ? json : Array.isArray(json?.relationships) ? json.relationships : [];
    return uniq(list.map((r) => JSON.stringify({ from: r.from, to: r.to, type: r.type, label: r.label, mutual: r.mutual }))).map((s) => JSON.parse(s));
}
