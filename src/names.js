// 待确认名称：AI 推断具体名称（每条一次给几个候选，让用户挑）
// 纯函数部分（取原文片段、候选资料、提示词、解析、写回）不依赖 DOM 和 AI，便于单元测试；
// resolveMissingNames 负责分批调用 AI，单批失败只记日志、不影响其他批。

import { DEFAULT_NAME_RESOLVE } from './constants.js';
import { extractJson, removeTags } from './json.js';
import { callLLM, chainFor, errorText } from './llm.js';
import { GENERIC_ALIASES, IMPORTANCE_RANK, isSpecificAlias } from './project.js';
import { getPrompt, render } from './prompts.js';
import { abortError, isAbortError, normalizeForMatch, uniq } from './utils.js';

/** 自动填入空行：confident = 只填把握大的原文/已有候选；top = 都先填第一个；none = 只给候选 */
export const AUTO_FILL_MODES = ['confident', 'top', 'none'];
/** 候选来源的短标签（候选按钮上的小徽标）：text = 原文里出现过；existing = 已有角色/条目；invented = AI 起的名字 */
export const SOURCE_LABELS = { text: '原文', existing: '已有', invented: 'AI 起名' };
/** 候选来源的完整说明（提示框、导出） */
export const SOURCE_TITLES = { text: '原文里出现过', existing: '已有角色或世界书条目', invented: 'AI 起的名字，原文里没有' };
export const CONFIDENCE_LABELS = { high: '把握大', medium: '有线索', low: '只是猜测' };
/** 确认名称是怎么来的：ai = AI 自动填入（还没确认）；pick = 点选了候选；user = 手动填写 */
export const RESOLVED_BY_LABELS = { ai: 'AI 填入', pick: '已选', user: '手动' };

/** 候选名称的长度上限、理由/原文证据的长度上限 */
const NAME_MAX = 30;
const NOTE_MAX = 120;

/** 不能当作具体名称的泛称：角色泛称之外再补一些地点/占位说法 */
const GENERIC_NAMES = new Set([
    ...GENERIC_ALIASES,
    '某地', '某处', '某个地方', '那里', '这里', '那边', '这边', '那个地方', '这个地方', '那家店', '这家店', '那个人', '这个人', '那位', '这位', '那位大人',
    '未知', '不详', '不明', '无', '暂无', '没有', '无名', '无名氏', '未命名', '待定', '未知名称', '原文未提及', '原文没有', 'unknown', 'none', 'null', 'n/a', 'na', 'tbd',
]);

const clip = (s, n) => {
    const t = String(s ?? '').replace(/\s+/g, ' ').trim();
    return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/** 比较用的键：去掉空白和标点，忽略大小写（“那家店” / “ 那家店。” 视为同一个） */
export function nameKey(s) {
    return String(s ?? '')
        .replace(/[\s"'“”‘’「」『』《》〈〉【】[\]()（）<>{}.,，。、;；:：!！?？…·\-—_~～/\\|]/g, '')
        .toLowerCase();
}

/** 对回原文说法用的键：AI 常在说法前加序号（“1. 那家店”“## 2、那家店”）、在后面加括号注释（“那家店（地点）”），先去掉再比 */
export function vagueKey(s) {
    const t = String(s ?? '')
        .trim()
        .replace(/^(#+\s*)?\d+\s*[.、)）]\s*/, '')
        .replace(/\s*[（(][^（）()]*[）)]\s*$/, '');
    return nameKey(t);
}

// ---------------- 选项 ----------------

function intIn(v, min, max, def) {
    // 空值（输入框清空）当作没填，用默认值，不要变成 0 再夹到下限
    const n = v === '' || v === null || v === undefined ? NaN : Math.round(Number(v));
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
}

/** 规整「AI 推断名称」的选项（设置里的 nameResolve，或对话框/调用方传入的覆盖值） */
export function normalizeNameResolve(raw) {
    const d = DEFAULT_NAME_RESOLVE;
    const o = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    return {
        invent: o.invent === undefined ? d.invent : !!o.invent,
        count: intIn(o.count, 2, 6, d.count),
        autoFill: AUTO_FILL_MODES.includes(o.autoFill) ? o.autoFill : d.autoFill,
        overwrite: o.overwrite === undefined ? d.overwrite : !!o.overwrite,
        batchSize: intIn(o.batchSize, 1, 12, d.batchSize),
        extra: typeof o.extra === 'string' ? o.extra.slice(0, 500) : d.extra,
    };
}

/** 设置里保存的选项，叠加本次调用传入的值（undefined 的不覆盖） */
export function nameResolveOptions(settings, override = {}) {
    const merged = { ...(settings?.nameResolve || {}) };
    for (const [k, v] of Object.entries(override || {})) if (v !== undefined) merged[k] = v;
    return normalizeNameResolve(merged);
}

// ---------------- 行状态 ----------------

/** 这一行的确认名称是怎么来的；有值但没有记录的（旧数据 / 手动填写）当作手动 */
export function resolvedByOf(m) {
    if (!String(m?.resolved || '').trim()) return '';
    return ['ai', 'pick', 'user'].includes(m.resolvedBy) ? m.resolvedBy : 'user';
}

/** 当前填写的名称正好是第几个候选（没有则 -1） */
export function selectedCandidateIndex(m) {
    const v = String(m?.resolved || '').trim();
    if (!v) return -1;
    return (m.ai?.candidates || []).findIndex((c) => c.name === v);
}

/**
 * 点了第 k 个候选：没选中的 → 填进去（点选）；已经选中、但是 AI 自动填的 → 确认（变成点选）；已经点选的 → 清空
 * @returns {'pick'|'confirm'|'clear'|''} 做了什么
 */
export function pickCandidate(m, k) {
    const c = m?.ai?.candidates?.[k];
    if (!c) return '';
    if (selectedCandidateIndex(m) === k) {
        if (resolvedByOf(m) === 'ai') {
            m.resolvedBy = 'pick';
            return 'confirm';
        }
        m.resolved = '';
        delete m.resolvedBy;
        return 'clear';
    }
    m.resolved = c.name;
    m.resolvedBy = 'pick';
    return 'pick';
}

/** 手动输入：有内容就算手动填写，清空则不再记录来源 */
export function typeResolved(m, value) {
    const v = String(value ?? '').trim();
    if (v === String(m.resolved || '').trim() && resolvedByOf(m)) return;
    m.resolved = v;
    if (v) m.resolvedBy = 'user';
    else delete m.resolvedBy;
}

/** 「空行都填第一个候选」：没填写、有候选的行填上第一个（算作 AI 自动填入，替换前会再提醒） */
export function fillTopCandidates(project) {
    let n = 0;
    for (const m of project.missingNames || []) {
        const top = m?.ai?.candidates?.[0];
        if (!top || String(m.resolved || '').trim()) continue;
        m.resolved = top.name;
        m.resolvedBy = 'ai';
        n++;
    }
    return n;
}

/** 替换进资料前需要再确认的行：AI 自动填入还没确认的，或者填的是 AI 起的名字 */
export function riskyResolved(list) {
    return (list || [])
        .filter((m) => String(m?.resolved || '').trim())
        .map((m) => {
            const c = (m.ai?.candidates || [])[selectedCandidateIndex(m)];
            const reasons = [];
            if (resolvedByOf(m) === 'ai') reasons.push('AI 自动填入，你还没确认');
            if (c?.source === 'invented') reasons.push('AI 起的名字，原文里没有');
            return { m, reasons };
        })
        .filter((x) => x.reasons.length);
}

/**
 * 导出大纲 Markdown 里的一行：确认名称来自 AI 时注明来源（原文 / 已有 / AI 起名、是否自动填入），还没填写时列出 AI 候选
 */
export function missingNameMarkdown(m) {
    const cands = m?.ai?.candidates || [];
    const val = String(m?.resolved || '').trim();
    const c = cands[selectedCandidateIndex(m)];
    const by = resolvedByOf(m);
    const note = [c ? `AI 候选·${SOURCE_LABELS[c.source] || c.source}` : '', by === 'ai' ? 'AI 自动填入，未确认' : ''].filter(Boolean).join('，');
    const more = !val && cands.length ? `；AI 候选：${cands.map((x) => `${x.name}（${SOURCE_LABELS[x.source] || x.source}）`).join(' / ')}` : '';
    return `- [${m?.type || ''}] ${m?.vague || ''} → ${val || m?.suggest || '?'}${note ? `〔${note}〕` : ''}（${m?.context || ''}${more}）`;
}

/**
 * 需要推断的行（project.missingNames 的下标）
 * overwrite=false：还没推断过、也还没填写的；overwrite=true：除了手动填写或点选的以外全部（AI 填入的会重新推断）
 */
export function namesToResolve(project, { overwrite = false } = {}) {
    const out = [];
    (project.missingNames || []).forEach((m, i) => {
        if (!String(m?.vague || '').trim()) return;
        const by = resolvedByOf(m);
        if (overwrite ? !by || by === 'ai' : !by && !m.ai) out.push(i);
    });
    return out;
}

// ---------------- 原文片段 ----------------

function cleanPassage(s) {
    // 行内的连续空白（含全角空格，JS 的 \s 已包括）压成一个空格；换行连同前后的空白压成一个换行
    return String(s || '').replace(/\r/g, '').replace(/[^\S\n]+/g, ' ').replace(/ *\n\s*/g, '\n').trim();
}

function allIndexes(text, needle, cap = 200) {
    const out = [];
    if (!needle) return out;
    let i = text.indexOf(needle);
    while (i >= 0 && out.length < cap) {
        out.push(i);
        i = text.indexOf(needle, i + needle.length);
    }
    return out;
}

function sliceWindow(content, pos, len, radius) {
    const from = Math.max(0, pos - radius);
    const to = Math.min(content.length, pos + len + radius);
    return { from, to };
}

function mergeRanges(ranges) {
    const sorted = [...ranges].sort((a, b) => a.from - b.from);
    const out = [];
    for (const r of sorted) {
        const last = out[out.length - 1];
        if (last && r.from <= last.to + 20) last.to = Math.max(last.to, r.to);
        else out.push({ ...r });
    }
    return out;
}

function cutRange(content, r) {
    return `${r.from > 0 ? '…' : ''}${cleanPassage(content.slice(r.from, r.to))}${r.to < content.length ? '…' : ''}`;
}

/** 参与取片段的分段：原文分段，外加这一条自己所在的分段 own（续写/挂机生成的分段是 AI 写的，不当作原文证据） */
function usableChunk(c, own = false) {
    return !!c && typeof c.content === 'string' && (own || !c.origin || c.origin === 'source');
}

/**
 * 给一条待确认名称收集原文片段（确定性，不调用 AI）：
 * - 所在分段里该说法前后各约 radius 字，最多 maxHits 处（优先提取时记下的那句上下文所在位置）；所在分段缺失或找不到时退回提取时记下的上下文；
 * - 其他分段里出现该说法的地方各取一小段（radius 约 extraRadius），优先后文（真名常常在后文才揭晓），再往前找，最多 maxExtra 段；
 * - 总字数不超过 budget，长篇小说也不会把提示词撑爆。
 * @returns {{passages: {chunk:number, title:string, text:string, kind:'source'|'context'|'later'|'earlier'}[], chars:number}}
 */
export function gatherNameContext(project, item, opts = {}) {
    const { radius = 400, maxHits = 3, extraRadius = 250, maxExtra = 4, budget = 3200 } = opts;
    const vague = String(item?.vague || '').trim();
    const chunks = Array.isArray(project?.chunks) ? project.chunks : [];
    const srcIdx = Number.isInteger(item?.chunk) ? item.chunk : -1;
    const src = chunks[srcIdx];
    const passages = [];
    let used = 0;

    // 所在分段：选出现的位置
    let picked = [];
    if (vague && usableChunk(src, true)) {
        const content = src.content;
        const hits = allIndexes(content, vague);
        if (hits.length) {
            const ctx = String(item.context || '').trim();
            const ctxPos = ctx ? content.indexOf(ctx.length > 60 ? ctx.slice(0, 60) : ctx) : -1;
            const first = ctxPos >= 0 ? hits.reduce((best, h) => (Math.abs(h - ctxPos) < Math.abs(best - ctxPos) ? h : best), hits[0]) : hits[0];
            picked = [first, ...hits.filter((h) => h !== first)].slice(0, Math.max(1, maxHits));
            // 片段字数按预算缩小：所在分段最多占预算的 65%
            const share = Math.floor((budget * 0.65) / picked.length);
            const r = Math.max(40, Math.min(radius, Math.floor((share - vague.length) / 2)));
            for (const range of mergeRanges(picked.map((h) => sliceWindow(content, h, vague.length, r)))) {
                const text = cutRange(content, range);
                passages.push({ chunk: srcIdx, title: String(src.title || ''), text, kind: 'source' });
                used += text.length;
            }
        }
    }
    if (!passages.length) {
        const ctx = cleanPassage(item?.context);
        if (ctx) {
            const text = ctx.length > budget / 2 ? `${ctx.slice(0, Math.floor(budget / 2) - 1)}…` : ctx;
            passages.push({ chunk: srcIdx, title: String(src?.title || ''), text, kind: 'context' });
            used += text.length;
        }
    }

    // 其他分段：先后文（由近到远），再前文（由近到远）
    if (vague && maxExtra > 0) {
        const others = [];
        chunks.forEach((c, ci) => {
            if (ci === srcIdx || !usableChunk(c)) return;
            const pos = c.content.indexOf(vague);
            if (pos >= 0) others.push({ c, ci, pos });
        });
        const later = others.filter((x) => x.ci > srcIdx).sort((a, b) => a.ci - b.ci);
        const earlier = others.filter((x) => x.ci < srcIdx).sort((a, b) => b.ci - a.ci);
        const list = [...later, ...earlier].slice(0, maxExtra);
        let left = budget - used;
        for (let k = 0; k < list.length; k++) {
            const per = Math.floor(left / (list.length - k));
            const r = Math.min(extraRadius, Math.floor((per - vague.length - 2) / 2));
            if (r < Math.min(30, extraRadius)) break; // 预算快用完了：剩下的片段太短没意义
            const { c, ci, pos } = list[k];
            const text = cutRange(c.content, sliceWindow(c.content, pos, vague.length, r));
            passages.push({ chunk: ci, title: String(c.title || ''), text, kind: ci > srcIdx ? 'later' : 'earlier' });
            used += text.length;
            left = budget - used;
        }
    }
    return { passages, chars: used };
}

// ---------------- 候选资料（每批共用） ----------------

/**
 * 已有角色与世界书条目，写进提示词供 AI 对照（existing 候选必须用这里的名字）
 * @returns {{characters:{name:string, aliases:string[], desc:string}[], entries:{category:string, name:string, keywords:string[]}[]}}
 */
export function buildNameCandidates(project, { maxCharacters = 80, maxEntries = 150 } = {}) {
    const fin = (n) => (Number.isFinite(n) ? n : 1e9);
    const characters = Object.values(project?.characters || {})
        .filter((c) => c && String(c.name || '').trim())
        .sort((a, b) => (IMPORTANCE_RANK[b.importance] || 0) - (IMPORTANCE_RANK[a.importance] || 0) || fin(a.firstChunk) - fin(b.firstChunk) || String(a.name).localeCompare(String(b.name), 'zh'))
        .slice(0, maxCharacters)
        .map((c) => ({
            name: c.name,
            aliases: uniq(c.aliases).filter((a) => a !== c.name).slice(0, 4),
            desc: clip(c.identity || c.relationship || '', 40),
        }));
    // 世界书条目：各分类轮流取，条目多时每个分类都能出现
    const cats = Object.entries(project?.worldbook || {}).map(([category, list]) => ({
        category,
        items: Object.entries(list || {}).map(([key, e]) => ({ category, name: String(e?.name || key), keywords: uniq(e?.keywords).filter((k) => k !== (e?.name || key)).slice(0, 2) })),
    }));
    const entries = [];
    for (let i = 0; entries.length < maxEntries && cats.some((c) => c.items.length > i); i++) {
        for (const c of cats) {
            if (entries.length >= maxEntries) break;
            if (c.items[i]) entries.push(c.items[i]);
        }
    }
    entries.sort((a, b) => cats.findIndex((c) => c.category === a.category) - cats.findIndex((c) => c.category === b.category));
    return { characters, entries };
}

/** 名称 → 已有角色/条目（含够具体的角色别名），用于核对 AI 说的 existing 是否真的存在 */
export function existingNameMap(project) {
    const map = new Map();
    const put = (name, ref) => {
        const k = nameKey(name);
        if (k && !map.has(k)) map.set(k, { name: String(name).trim(), ref });
    };
    const chars = Object.values(project?.characters || {}).filter((c) => c?.name);
    for (const c of chars) put(c.name, `角色「${c.name}」`);
    for (const c of chars) for (const a of c.aliases || []) if (isSpecificAlias(a)) put(a, `角色「${c.name}」的别名`);
    for (const [cat, list] of Object.entries(project?.worldbook || {})) {
        for (const [key, e] of Object.entries(list || {})) put(e?.name || key, `${cat}「${e?.name || key}」`);
    }
    // 条目的关键词（提示词里写成“又称”）也算已有名称；放在所有角色名、别名、条目名之后，不会盖掉真正的名字
    for (const [cat, list] of Object.entries(project?.worldbook || {})) {
        for (const [key, e] of Object.entries(list || {})) {
            for (const k of e?.keywords || []) {
                if (typeof k === 'string' && isSpecificAlias(k) && !/^\/.+\/[a-z]*$/i.test(k.trim())) put(k, `${cat}「${e?.name || key}」的关键词`);
            }
        }
    }
    return map;
}

// ---------------- 提示词 ----------------

function charactersText(list) {
    if (!list.length) return '（暂无）';
    return list.map((c) => `- ${c.name}${c.aliases.length ? `（别名：${c.aliases.join('、')}）` : ''}${c.desc ? `：${c.desc}` : ''}`).join('\n');
}

function entriesText(list) {
    if (!list.length) return '（暂无）';
    const by = new Map();
    for (const e of list) {
        if (!by.has(e.category)) by.set(e.category, []);
        by.get(e.category).push(`${e.name}${e.keywords.length ? `（又称 ${e.keywords.join('、')}）` : ''}`);
    }
    return [...by].map(([cat, names]) => `- ${cat}：${names.join('、')}`).join('\n');
}

function passageLabel(p) {
    if (p.kind === 'context') return '提取时记下的上下文';
    const title = clip(p.title, 20);
    return `第 ${p.chunk + 1} 段${title ? `「${title}」` : ''}${p.kind === 'later' ? '·后文' : p.kind === 'earlier' ? '·前文' : ''}`;
}

function itemsText(batch) {
    return batch.map((it, n) => {
        const lines = [`## ${n + 1}. 「${it.vague}」（类型：${it.type || '未注明'}）`];
        if (it.suggest && nameKey(it.suggest) !== nameKey(it.vague)) lines.push(`提取时给的建议名称（不一定出自原文）：${it.suggest}`);
        if (it.avoid?.length) lines.push(`不要再给：${it.avoid.join('、')}`);
        lines.push('原文片段：');
        if (!it.passages?.length) lines.push('（没有找到原文片段）');
        for (const p of it.passages || []) lines.push(`[${passageLabel(p)}] ${p.text}`);
        return lines.join('\n');
    }).join('\n\n');
}

/**
 * 准备一批待推断的条目：原文片段、用于核对“原文里有没有”的文本、不要再给的名称
 * @param {number[]} indices project.missingNames 的下标
 * @param {{avoid?: Record<number,string[]>|Map<number,string[]>, summary?: string, context?: object}} opt
 */
export function prepareNameItems(project, indices, { avoid, summary = '', context } = {}) {
    const avoidOf = (i) => uniq(avoid instanceof Map ? avoid.get(i) : avoid?.[i]).slice(0, 24);
    return indices
        .map((i) => ({ i, m: project.missingNames?.[i] }))
        .filter(({ m }) => m && String(m.vague || '').trim())
        .map(({ i, m }) => {
            const { passages } = gatherNameContext(project, m, context);
            return {
                index: i,
                row: m, // 行对象：推断途中行被删掉/重排也能认准（写回时用）
                vague: String(m.vague).trim(),
                type: String(m.type || '').trim(),
                suggest: String(m.suggest || '').trim(),
                context: String(m.context || '').trim(),
                passages,
                // “原文里出现过”按发给 AI 的片段核对；梗概是从原文整理来的，里面出现的名字也算
                haystack: [...passages.map((p) => p.text), m.context || '', summary].join('\n'),
                avoid: avoidOf(i),
            };
        });
}

/**
 * 生成一批的提示词
 * @param {{count?:number, invent?:boolean, extra?:string, lists?:ReturnType<typeof buildNameCandidates>, summary?:string}} opt
 */
export function buildResolveNamesPrompt(project, settings, batch, opt = {}) {
    const o = normalizeNameResolve({ count: opt.count, invent: opt.invent, extra: opt.extra });
    const lists = opt.lists || buildNameCandidates(project);
    const summary = clip(opt.summary ?? project?.outline?.summary ?? '', 800);
    const vars = {
        BOOK: project?.bookName || project?.name || '',
        COUNT: String(o.count),
        SUMMARY: summary || '（暂无故事梗概）',
        CHARACTERS: charactersText(lists.characters),
        ENTRIES: entriesText(lists.entries),
        ITEMS: itemsText(batch),
        INVENT_RULE: o.invent
            ? '- invented：原文片段和已有资料里都找不到具体名称时，由你按本书的命名风格（参考已有角色名、地名的用字和格式）起一个贴切的新名字。evidence 留空，reason 说明为什么这样起。'
            : '- 这次不要自己起名字：只给 text 和 existing 两种候选，找不到就输出空数组，不要硬凑。',
        INVENT_ORDER: o.invent
            ? `invented 候选放在最后，用来把候选补足到 ${o.count} 个；原文已经明确给出名称时可以少给或不给。`
            : '不要给 invented 候选。',
        EXTRA: o.extra.trim() ? `\n# 额外要求\n${o.extra.trim()}\n` : '',
    };
    return {
        system: render(getPrompt(settings, 'resolveNamesSystem'), vars),
        prompt: render(getPrompt(settings, 'resolveNames'), vars),
    };
}

// ---------------- 解析 ----------------

const QUOTES_ANYWHERE = /[“”‘’「」『』《》〈〉【】]/g;

/** 规整 AI 给的候选名称；不像具体名称的（空、太长、多行、就是模糊说法本身、泛称）返回空字符串 */
export function sanitizeCandidateName(raw, vague = '') {
    if (raw == null || typeof raw === 'object') return '';
    let s = String(raw).trim();
    if (/[\r\n]/.test(s)) return '';
    s = s.replace(/\s*[（(][^（）()]*[）)]\s*$/, ''); // 去掉结尾的括号注释：江酒（又名小酒）
    s = s.replace(QUOTES_ANYWHERE, '').replace(/^["'[\]\s]+|["'[\]\s]+$/g, '');
    s = s.replace(/\s+/g, ' ').replace(/^[：:，,。.、;；\s-]+|[：:，,。.、;；!！?？\s]+$/g, '').trim();
    if (s.length < 2 || s.length > NAME_MAX) return '';
    const key = nameKey(s);
    const vKey = nameKey(vague);
    if (!key || key === vKey) return '';
    // 模糊说法里截出来的一小段（“那家酒楼”里的“酒楼”“家酒楼”）也不是具体名称
    if (vKey && vKey.includes(key) && vKey.length - key.length <= 3) return '';
    // 泛称，含“掌柜的”“老板的”这种带“的”的说法
    const bare = s.replace(/的$/, '');
    if ([s, s.toLowerCase(), bare].some((x) => GENERIC_NAMES.has(x))) return '';
    return s;
}

function normSource(v) {
    const s = String(v ?? '').trim().toLowerCase();
    if (/^(text|original|source|quote|from[_ ]?text|原文|文中)/.test(s)) return 'text';
    if (/^(existing|exist|known|database|entry|character|worldbook|已有|现有|资料)/.test(s)) return 'existing';
    if (/^(invent|new|ai|created|generated|guess|起名|原创|新)/.test(s)) return 'invented';
    return '';
}

function normConfidence(v) {
    if (typeof v === 'number' && Number.isFinite(v)) {
        const x = v > 1 ? v / 100 : v;
        return x >= 0.75 ? 'high' : x >= 0.4 ? 'medium' : 'low';
    }
    const s = String(v ?? '').trim().toLowerCase();
    if (/^(high|h|高|很高|确定)/.test(s)) return 'high';
    if (/^(low|l|低|猜)/.test(s)) return 'low';
    return 'medium';
}

const LIST_KEYS = ['results', 'result', 'items', 'names', 'data', 'list', 'answers', 'output', 'outputs', 'missing_names', 'missingNames', '待确认名称', '结果'];
/** 一条结果（而不是一个候选）才有的字段 */
const ITEM_FIELDS = ['vague', '原文说法', '模糊说法', 'term', 'candidates', '候选', 'options', 'names', 'suggestions'];

const isPlainObject = (x) => !!x && typeof x === 'object' && !Array.isArray(x);
/** 像一条结果：{vague, candidates, ...} */
const looksLikeItem = (x) => isPlainObject(x) && ITEM_FIELDS.some((k) => k in x);
/** 像一个候选：字符串，或带名字、没有结果字段的对象 */
const looksLikeCandidate = (x) => typeof x === 'string' || (isPlainObject(x) && ['name', '名称', 'resolved', 'value'].some((k) => k in x) && !looksLikeItem(x));

/**
 * 把各种形状的 AI 输出统一成 [{key, pos, data}]
 * @param {Set<string>} keys 这一批各条原文说法的 vagueKey（判断 {"某个键": [...]} 是按说法做键还是一层包装）
 */
function resultEntries(json, itemCount, keys) {
    if (Array.isArray(json)) {
        // 只有一条时（「换一批」），候选名字或候选对象直接排成的数组就是这一条的候选；多条时按位置一条一个
        if (itemCount === 1 && json.length > 1 && json.every(looksLikeCandidate)) return [{ key: null, pos: 0, data: json }];
        if (json.length && json.every((x) => typeof x === 'string')) {
            return itemCount === 1 ? [{ key: null, pos: 0, data: json }] : json.map((s, pos) => ({ key: null, pos, data: [s] }));
        }
        return json.map((data, pos) => ({ key: null, pos, data }));
    }
    if (!isPlainObject(json)) return [];
    for (const k of LIST_KEYS) if (Array.isArray(json[k])) return resultEntries(json[k], itemCount, keys);
    if (looksLikeItem(json) || 'name' in json) return [{ key: null, pos: 0, data: json }];
    // 其他包装键（{"answer": [...]}）：里面是一条条结果就拆开；只有一条时，唯一的数组就是它的候选（键不是这一条的说法时）
    const own = Object.keys(json);
    const arrays = Object.values(json).filter(Array.isArray);
    const wrapped = arrays.find((a) => a.some(looksLikeItem))
        || (itemCount === 1 && own.length === 1 && arrays.length === 1 && !/^\d+$/.test(own[0]) && !keys.has(vagueKey(own[0])) ? arrays[0] : null);
    if (wrapped) return resultEntries(wrapped, itemCount, keys);
    // {"那家店": [...]} 或 {"1": {...}}：按说法做键的没有位置（pos = -1，对象键的先后不可靠）
    return Object.entries(json).map(([k, data]) => (/^\d+$/.test(k) ? { key: null, pos: Number(k) - 1, data } : { key: k, pos: -1, data }));
}

function entryParts(d) {
    if (Array.isArray(d)) return { vague: '', reason: '', cands: d };
    if (typeof d === 'string') return { vague: '', reason: '', cands: [d] };
    if (!d || typeof d !== 'object') return null;
    const vague = d.vague ?? d.原文说法 ?? d.模糊说法 ?? d.term ?? '';
    let cands = d.candidates ?? d.候选 ?? d.options ?? d.names ?? d.suggestions;
    let reason = d.reason ?? d.理由 ?? d.note ?? '';
    if (cands !== undefined && cands !== null && !Array.isArray(cands)) cands = [cands];
    // 一个认识的字段都没有（{"x": 1}）：不是一条结果
    if (!vague && !cands && !reason && !(d.name ?? d.名称 ?? d.resolved)) return null;
    if (!cands) {
        // 每条只给了一个名字：{vague, name, source, ...} 当作只有一个候选
        if (d.name ?? d.名称 ?? d.resolved) {
            cands = [d];
            reason = '';
        } else {
            cands = [];
        }
    }
    return { vague: typeof vague === 'string' ? vague : '', reason, cands };
}

function evidenceIn(hayN, evidence) {
    const pieces = String(evidence).split(/…+|\.{3,}/).map((x) => normalizeForMatch(x).toLowerCase()).filter((x) => x.length >= 2);
    return pieces.length > 0 && pieces.every((x) => hayN.includes(x));
}

/**
 * 核对并规整一个候选：来源以本地核对为准（名字是已有角色/条目 → existing；在发给 AI 的原文片段里出现过 → text；
 * 都不是 → 允许起名时算 invented，否则丢掉）。AI 说的来源和核对结果对不上（说原文有但找不到、说已有但没有）时把握降为 low；
 * 说的是真的、只是归类不同（原文里出现的名字正好也是已有角色）不降。
 * @param {string|null} hayN 发给 AI 的全部文本（核对引文用）；hayText：去掉了模糊说法本身的文本（核对“原文里出现过”用，
 *   说法本身到处都是，它的一小截不能算原文证据）；null = 没有可核对的文本
 */
function normalizeCandidate(raw, it, hayN, hayText, { invent, existing }) {
    const obj = raw && typeof raw === 'object' ? raw : { name: raw };
    const name = sanitizeCandidateName(obj.name ?? obj.名称 ?? obj.value ?? obj.resolved, it.vague);
    if (!name) return null;
    const claimed = normSource(obj.source ?? obj.来源 ?? obj.type);
    const ex = existing ? existing.get(nameKey(name)) : null;
    const inText = hayText === null ? null : name.length >= 2 && hayText.includes(normalizeForMatch(name).toLowerCase());
    let source;
    if (ex) source = 'existing';
    else if (claimed === 'existing' && !existing) source = 'existing'; // 没有资料可核对时相信 AI
    else if (inText === true) source = 'text';
    else if (inText === null && claimed === 'text') source = 'text';
    else if (invent) source = 'invented';
    else return null;
    let confidence = normConfidence(obj.confidence ?? obj.把握 ?? obj.置信度);
    const claimTrue = !claimed || claimed === source || (claimed === 'text' && inText === true) || (claimed === 'existing' && !!ex);
    if (!claimTrue) confidence = 'low';
    if (source === 'invented' && confidence === 'high') confidence = 'medium'; // 自己起的名字谈不上“把握大”
    let evidence = source === 'invented' ? '' : clip(obj.evidence ?? obj.原文 ?? obj.quote ?? '', NOTE_MAX);
    if (evidence && hayN !== null && !evidenceIn(hayN, evidence)) evidence = ''; // 不是原文的“引文”不展示
    const out = { name: ex ? ex.name : name, source, confidence, reason: clip(obj.reason ?? obj.理由 ?? '', NOTE_MAX), evidence };
    if (ex) out.ref = ex.ref;
    return out;
}

/**
 * 解析 AI 的推断结果（宽松：代码块、前后闲聊、包在对象里、每条只给一个名字都能认），按原文说法对回各条，对不上时按顺序
 * @param {string|any} raw AI 原始输出（或已解析的 JSON）
 * @param {{index:number, vague:string, haystack?:string, avoid?:string[]}[]} items 这一批的条目（prepareNameItems 的结果）
 * @param {{count?:number, invent?:boolean, existing?:Map|null}} opt existing：existingNameMap 的结果
 * @returns {({index:number, vague:string, reason:string, candidates:object[], avoid:string[]}|null)[]} 与 items 一一对应；AI 没返回的条目为 null
 */
export function parseResolveNamesResult(raw, items, { count = DEFAULT_NAME_RESOLVE.count, invent = true, existing = null } = {}) {
    const json = typeof raw === 'string' ? extractJson(raw) : raw;
    const n = Math.min(6, Math.max(1, Math.round(Number(count)) || DEFAULT_NAME_RESOLVE.count));
    // 说法 → 这一批里用这个说法的各条（“那位大人”和“那位大人。”规整后相同，各自要拿到自己的答案）
    const keys = items.map((it) => vagueKey(it.vague));
    const keyToPos = new Map();
    keys.forEach((key, k) => {
        if (!key) return;
        if (!keyToPos.has(key)) keyToPos.set(key, []);
        keyToPos.get(key).push(k);
    });
    const got = items.map(() => null);
    const add = (k, parts) => {
        if (!got[k]) got[k] = { reason: '', cands: [] };
        got[k].cands.push(...parts.cands);
        if (!got[k].reason && parts.reason) got[k].reason = parts.reason;
    };
    const entries = resultEntries(json, items.length, new Set(keyToPos.keys()));
    const rest = [];
    let matched = 0;
    let shifted = false; // 有对上说法、但不在自己位置上的：AI 漏了或调换了顺序，不能再按位置对
    for (const e of entries) {
        const parts = entryParts(e.data);
        if (!parts) continue;
        const rawV = String(e.key || parts.vague || '').trim();
        const ks = keyToPos.get(vagueKey(rawV));
        if (!ks) {
            rest.push({ pos: e.pos, parts, key: vagueKey(rawV) });
            continue;
        }
        // 先找说法一字不差、还空着的；再找第一个还空着的；都有了就并到它所在位置那一条（或第一条）
        const free = ks.filter((x) => !got[x]);
        const k = free.find((x) => String(items[x].vague).trim() === rawV) ?? free[0] ?? (ks.includes(e.pos) ? e.pos : ks[0]);
        add(k, parts);
        matched++;
        if (e.pos >= 0 && k !== e.pos) shifted = true;
    }
    // 对不上原文说法的：
    // 1. 和唯一一条还空着的说法互相包含（“那家店铺” / “家店”）→ 就是它；
    // 2. 没有错位迹象时按位置补（条数和这一批相同、对上的都在自己位置上、或者本来就没写说法）；
    // 3. 最后只剩一条结果、一条空着的 → 配成一对。
    const left = [];
    for (const r of rest) {
        const hits = r.key.length >= 2
            ? items.map((_, k) => k).filter((k) => !got[k] && keys[k].length >= 2 && (keys[k].includes(r.key) || r.key.includes(keys[k])))
            : [];
        if (hits.length === 1) add(hits[0], r.parts);
        else left.push(r);
    }
    const posOk = (r) => !shifted && (entries.length === items.length || matched > 0 || !r.key);
    const unplaced = [];
    for (const r of left) {
        if (posOk(r) && r.pos >= 0 && r.pos < items.length && !got[r.pos]) add(r.pos, r.parts);
        else unplaced.push(r);
    }
    const empty = got.map((g, k) => (g ? -1 : k)).filter((k) => k >= 0);
    if (unplaced.length === 1 && empty.length === 1) add(empty[0], unplaced[0].parts);
    // 有输出、却一条都对不上：多半是格式不对（包了一层不认识的键、说法全写错了），当作解析失败，让 AI 按模板重输
    if (entries.length && items.length && got.every((g) => !g)) {
        const err = new Error('AI 的输出对不上任何一条待确认名称');
        err.code = 'JSON_PARSE';
        err.feedback = MISMATCH_FEEDBACK;
        throw err;
    }

    return items.map((it, k) => {
        if (!got[k]) return null;
        const hayN = typeof it.haystack === 'string' ? normalizeForMatch(it.haystack).toLowerCase() : null;
        // 核对“原文里出现过”时去掉模糊说法本身：它在每个片段里都有，它的一小截（“酒楼”）不能算原文证据
        const vN = normalizeForMatch(it.vague).toLowerCase();
        const hayText = hayN === null ? null : vN ? hayN.split(vN).join('\n') : hayN;
        const avoidKeys = new Set((it.avoid || []).map(nameKey));
        const seen = new Set();
        const list = [];
        for (const c of got[k].cands) {
            const x = normalizeCandidate(c, it, hayN, hayText, { invent, existing });
            if (!x) continue;
            const key = nameKey(x.name);
            if (seen.has(key) || avoidKeys.has(key)) continue;
            seen.add(key);
            list.push(x);
        }
        // 原文 / 已有的排在 AI 起名的前面，同组内保持 AI 给的顺序
        const sorted = [...list.filter((c) => c.source !== 'invented'), ...list.filter((c) => c.source === 'invented')].slice(0, n);
        const out = { index: it.index, vague: it.vague, reason: clip(got[k].reason, NOTE_MAX), candidates: sorted, avoid: it.avoid || [] };
        if (it.row) out.row = it.row;
        return out;
    });
}

// ---------------- 写回 ----------------

function findTarget(project, r) {
    const list = project.missingNames || [];
    // 带着行对象的（resolveMissingNames 发出的）：这一行推断途中被忽略/替换掉了就不再写回，免得落到同名的别的行上
    if (r.row) return list.includes(r.row) ? r.row : null;
    const at = list[r.index];
    if (!r.vague) return at || null;
    const key = nameKey(r.vague);
    if (at && nameKey(at.vague) === key) return at;
    return list.find((m) => nameKey(m?.vague) === key) || null;
}

/**
 * 把推断结果写回 project.missingNames：候选存到 item.ai；按 autoFill 填空行。
 * 手动填写或点选的值永远不动；overwrite 时 AI 之前自动填入的值会按这次的结果重新填。
 * @param {{overwrite?:boolean, autoFill?:'confident'|'top'|'none', keepIfEmpty?:boolean}} opt
 *   keepIfEmpty：这次一个候选都没有时保留原来的候选（「换一批」没有更多新名字时用）
 * @returns {{filled:number, offered:number, none:number, missed:number, kept:number}}
 */
export function applyResolveResults(project, results, { overwrite = false, autoFill = 'confident', keepIfEmpty = false } = {}) {
    const counts = { filled: 0, offered: 0, none: 0, missed: 0, kept: 0 };
    for (const r of results || []) {
        const target = r ? findTarget(project, r) : null;
        if (!target) {
            counts.missed++;
            continue;
        }
        const cands = Array.isArray(r.candidates) ? r.candidates : [];
        if (!cands.length && keepIfEmpty && target.ai?.candidates?.length) {
            counts.none++;
            counts.kept++;
            continue;
        }
        // 当前填写的值正好是某个旧候选：记下它，候选换掉后仍放在最前面（保留来源标记、理由和「AI 起名」提醒）
        const prevSel = target.ai?.candidates?.[selectedCandidateIndex(target)] || null;
        target.ai = { candidates: cands, reason: String(r.reason || ''), at: Date.now() };
        if (r.avoid?.length) target.ai.seen = [...r.avoid];
        if (cands.length) counts.offered++;
        else counts.none++;
        const by = resolvedByOf(target);
        if (overwrite && by === 'ai') {
            target.resolved = '';
            delete target.resolvedBy;
        } else if (by) {
            // 按名字一字不差比较（和 selectedCandidateIndex 一致）：新候选里没有这个名字，它就会失去选中标记
            if (prevSel && !cands.some((c) => c.name === prevSel.name)) target.ai.candidates = [prevSel, ...cands];
            continue;
        }
        const top = cands[0];
        const pick = !top ? null : autoFill === 'top' ? top : autoFill === 'confident' && top.source !== 'invented' && top.confidence === 'high' ? top : null;
        if (pick) {
            target.resolved = pick.name;
            target.resolvedBy = 'ai';
            counts.filled++;
        }
    }
    return counts;
}

// ---------------- 调用 AI ----------------

const BAD_JSON_FEEDBACK = '上面的输出不是合法 JSON（可能被截断或含未转义引号）。请重新输出完整、合法的 JSON 数组，只输出 JSON。字符串中的双引号请改用中文引号。';
const MISMATCH_FEEDBACK = '上面的输出对不上要推断的条目。请按模板重新输出完整的 JSON 数组：每条一个对象，vague 照抄原文说法，candidates 是候选数组。只输出 JSON。';

async function runNameBatch(project, settings, batch, o, shared, { signal, onLog, label }) {
    const { system, prompt } = buildResolveNamesPrompt(project, settings, batch, { ...o, lists: shared.lists, summary: shared.summary });
    const followUps = [];
    for (let attempt = 0; attempt < 2; attempt++) {
        const res = await callLLM({
            api: settings.api,
            system,
            prompt,
            followUps,
            ...chainFor(settings, 'names', project),
            expect: 'json',
            signal,
            onNotice: (m, l) => onLog?.(`推断名称${label}：${m}`, l),
            onRetry: ({ attempt: a, wait, error }) => onLog?.(`⚠️ 推断名称${label}请求失败（${error.message}），${Math.round(wait / 1000)} 秒后第 ${a} 次重试`, 'warn'),
        });
        const raw = removeTags(res.text, settings.extraction?.filterTags);
        try {
            return parseResolveNamesResult(raw, batch, { count: o.count, invent: o.invent, existing: shared.existing });
        } catch (e) {
            if (attempt === 0 && e?.code === 'JSON_PARSE') {
                onLog?.(`⚠️ 推断名称${label}的输出${e.feedback ? '对不上要推断的条目' : '不是合法 JSON'}，要求 AI 重新输出`, 'warn');
                followUps.push({ role: 'assistant', content: res.text.slice(0, 6000) }, { role: 'user', content: e.feedback || BAD_JSON_FEEDBACK });
                continue;
            }
            e.raw = raw;
            throw e;
        }
    }
    throw new Error('推断名称失败');
}

/**
 * AI 推断待确认名称：分批请求（每批 batchSize 条），每批的结果马上写回（中途停止或某批失败，已完成的保留）。
 * @param {{indices?:number[], overwrite?:boolean, invent?:boolean, count?:number, autoFill?:string, batchSize?:number,
 *   avoid?:Record<number,string[]>|Map<number,string[]>, extra?:string, signal?:AbortSignal,
 *   onProgress?:(p:{batch:number, batches:number, done:number, total:number, indices:number[], failed:boolean})=>void, onLog?:Function}} opt
 *   onProgress 在每批写回之后调用（indices：这一批的行；失败的批也会报告，failed = true）；停止后回来的那一批不再写回；
 *   未传的选项用设置里保存的 nameResolve；indices 不传时按 overwrite 选范围（见 namesToResolve）；
 *   avoid：每条（按下标）不要再给的名称，「换一批」用，此时这一条没有新候选会保留原来的
 * @returns {Promise<{total:number, batches:number, filled:number, offered:number, none:number, missed:number, kept:number, failed:number, errors:string[]}>}
 */
export async function resolveMissingNames(project, settings, opt = {}) {
    const { indices, avoid, signal, onProgress, onLog } = opt;
    const o = nameResolveOptions(settings, { overwrite: opt.overwrite, invent: opt.invent, count: opt.count, autoFill: opt.autoFill, batchSize: opt.batchSize, extra: opt.extra });
    const idx = Array.isArray(indices) ? indices.filter((i) => Number.isInteger(i) && project.missingNames?.[i]) : namesToResolve(project, { overwrite: o.overwrite });
    const summary = String(project.outline?.summary || '');
    const items = prepareNameItems(project, idx, { avoid, summary });
    const out = { total: items.length, batches: 0, filled: 0, offered: 0, none: 0, missed: 0, kept: 0, failed: 0, errors: [] };
    if (!items.length) return out;
    const shared = { lists: buildNameCandidates(project), existing: existingNameMap(project), summary };
    const batches = [];
    for (let i = 0; i < items.length; i += o.batchSize) batches.push(items.slice(i, i + o.batchSize));
    out.batches = batches.length;
    let done = 0;
    let lastErr = null;
    for (let b = 0; b < batches.length; b++) {
        if (signal?.aborted) throw abortError();
        const batch = batches[b];
        const label = batches.length > 1 ? `（第 ${b + 1}/${batches.length} 批）` : '';
        let failed = false;
        try {
            const results = await runNameBatch(project, settings, batch, o, shared, { signal, onLog, label });
            if (signal?.aborted) throw abortError(); // 已经停止（或切换了项目）：回来晚了的这一批不再写回
            const keepIfEmpty = !!avoid;
            const c = applyResolveResults(project, results, { overwrite: o.overwrite, autoFill: o.autoFill, keepIfEmpty });
            for (const k of ['filled', 'offered', 'none', 'missed', 'kept']) out[k] += c[k];
        } catch (e) {
            if (isAbortError(e) || signal?.aborted) throw e;
            out.failed++;
            failed = true;
            lastErr = e;
            const msg = `${label || ''}${batch.map((x) => `「${x.vague}」`).join('')}：${errorText(e)}`;
            out.errors.push(msg);
            onLog?.(`⚠️ 推断名称失败${msg}`, 'warn');
        }
        done += batch.length;
        onProgress?.({ batch: b + 1, batches: batches.length, done, total: items.length, indices: batch.map((x) => x.index), failed });
    }
    // 全部失败：当作出错抛给调用方（界面会弹出原因）；部分失败已经写进日志，成功的结果保留
    if (out.failed === batches.length && lastErr) throw lastErr;
    return out;
}
