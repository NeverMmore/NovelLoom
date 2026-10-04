// 人物关系图谱：结构化的角色关系边，AI 分析、手动编辑、防剧透过滤、接入角色卡

import { callLLM, chainFor } from './llm.js';
import { extractJson, removeTags } from './json.js';
import { getPrompt, render } from './prompts.js';
import { characterAt, characterProfileText, IMPORTANCE_RANK } from './project.js';
import { truncate, uid, uniq } from './utils.js';

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

const TYPE_GUESS = [
    [/恋|爱慕|喜欢|夫妻|情侣|暗恋|前男友|前女友|未婚妻|未婚夫/, 'romantic'],
    [/家人|父|母|兄|弟|姐|妹|子|女儿|儿子|亲人|夫人|丈夫|妻子/, 'family'],
    [/师徒|师父|师傅|徒弟|上级|下属|上司|老板|下级/, 'mentor'],
    [/同伴|盟友|队友|战友|搭档/, 'ally'],
    [/对手|竞争|情敌/, 'rival'],
    [/敌|仇|恨/, 'enemy'],
    [/朋友|挚友|好友|同学|同事/, 'friend'],
];

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
    const t = { id: uid('rtpl_'), name: n, type: String(type || 'other'), mutual: !!mutual, label: String(label || '').trim(), createdAt: Date.now() };
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
    if (patch.type !== undefined) t.type = String(patch.type || 'other');
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

/** 「AI 分析关系」提示词里的 {TYPES}：可用类型，加上用户的关系模板（没有模板时与原来一致） */
export function relationTypesPromptText(settings) {
    const types = allRelationTypes(settings).map((t) => `${t.value}=${t.label}`).join('、');
    const tpls = relationTemplates(settings);
    if (!tpls.length) return types;
    const lines = tpls.map((t) => `- ${t.name}：type=${t.type}（${relationTypeLabel(t.type, settings)}），${t.mutual ? '双向' : '单向 A→B'}${t.label ? `，说明写法参考：${t.label}` : ''}`);
    return `${types}\n\n用户常用的关系模板（判断关系时优先套用这些模板的类型与方向；说明可参照写法，把 {A}/{B} 换成具体角色并写出本书的具体情节）：\n${lines.join('\n')}`;
}

export function relationTypeLabel(v, settings) {
    return allRelationTypes(settings).find((t) => t.value === v)?.label || '其他';
}
export function relationTypeColor(v, settings) {
    return allRelationTypes(settings).find((t) => t.value === v)?.color || '#8a8a8a';
}

function guessType(text) {
    const s = String(text || '');
    for (const [re, type] of TYPE_GUESS) if (re.test(s)) return type;
    return '';
}

export function normalizeRelationship(r = {}, settings) {
    return {
        id: r.id || uid('rel_'),
        from: String(r.from || '').trim(),
        to: String(r.to || '').trim(),
        type: allRelationTypes(settings).some((t) => t.value === r.type) ? r.type : (guessType(r.type) || 'other'),
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
        const type = allRelationTypes(settings).some((t) => t.value === item.type) ? item.type : (guessType(item.type ?? item.关系) || 'other');
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
