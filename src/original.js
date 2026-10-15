// 原创写卡：不导入 TXT，按用户自己的设定写角色卡 / 世界卡。
//   1) 写卡表单的「写卡依据 → 原创设定」：单人卡填 角色名（可留空让 AI 起名）/ 角色设定 / 世界观·背景 / 参考氛围；
//      世界卡填 卡名（可留空）/ 世界观 / 主要角色（一行一个「名字：设定」）/ 参考氛围；
//   2) 写卡提示词 cardOriginal / cardOriginalSystem（见 prompts.js、cards.js 的 buildCardPrompt）：AI 按设定设计人物和世界，
//      除卡片字段外另外输出 character（单人卡）或 cast（世界卡，主要角色）和 lore（3-8 条世界书条目）；
//   3) 卡片记下 card.source = 'original'、card.original = {name, concept, world, ref, cast, characters, lore, saved}：
//      name / concept / world / ref / cast 是用户写的设定，characters / lore 是 AI 设计的人物和条目（存进项目后 savedAs 记项目里的名字）；
//      整卡重新生成、单字段重roll、剧情推演、状态栏都按这份设定（已经存进项目的以项目里的为准，用户可能在「角色」「世界书」页改过）；
//   4) 「把 AI 设计的角色和设定存进项目」：角色存成手动角色（manual + locked，重新提取不会删也不会改），条目存成手动条目；
//      项目里已有同名的角色或条目时由调用方问用户：覆盖，或者加后缀另存（不会悄悄并进别的角色）。
//      不存时人物和条目只放在卡上，写入酒馆时作为卡自己世界书里的条目（见 publish.js 的 cardExtraEntries）。
// 所有提示词都写明：涉及恋爱或亲密内容的人物（包括 {{user}}）都是成年人。不碰 DOM、不调用 AI。

import { IMPORTANCE_RANK, characterAt, characterProfileText, isSpecificAlias, normalizeCharacter, normalizeExtraction } from './project.js';
import { truncate, uniq } from './utils.js';

export const ORIGINAL_SOURCE = 'original';

/** 用户输入的长度上限 */
export const ORIGINAL_LIMITS = { name: 20, concept: 3000, world: 3000, ref: 200, cast: 3000 };
/** AI 设计结果的上限：人物个数、条目个数、条目正文字数 */
const DESIGN_LIMITS = { characters: 12, lore: 12, content: 2000 };

/** 同名时另存用的后缀：「名字（原创）」「名字（原创2）」… */
export const ORIGINAL_NAME_SUFFIX = '原创';

function isObj(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function cleanText(v, max) {
    return String(v ?? '').replace(/\r\n?/g, '\n').trim().slice(0, max);
}

/** 这张卡是不是原创写的 */
export function isOriginalCard(card) {
    return card?.source === ORIGINAL_SOURCE;
}

/** 项目里有没有可以「按原著资料」写卡的东西：原文分段或角色资料（都没有时写卡表单只能用原创设定） */
export function originalNovelAvailable(project) {
    return Object.keys(project?.characters || {}).length > 0 || (project?.chunks || []).some((c) => c.origin === 'source');
}

/** 项目有没有原文（原创项目、或分段被全部删掉的项目没有） */
export function projectHasSource(project) {
    return (project?.chunks || []).some((c) => c.origin === 'source');
}

/** 单人卡在还没有任何角色的项目里写：角色一定要存进项目（卡片关联项目里的角色） */
export function originalSaveForced(project, kind) {
    return kind !== 'world' && !Object.keys(project?.characters || {}).length;
}

/**
 * 规整用户写的原创设定（写卡表单 → 提示词）
 * @returns {{name: string, concept: string, world: string, ref: string, cast: string}}
 */
export function normalizeOriginalInput(raw) {
    const r = isObj(raw) ? raw : {};
    return {
        name: cleanText(r.name, ORIGINAL_LIMITS.name).replace(/\s+/g, ' '),
        concept: cleanText(r.concept, ORIGINAL_LIMITS.concept),
        world: cleanText(r.world, ORIGINAL_LIMITS.world),
        ref: cleanText(r.ref, ORIGINAL_LIMITS.ref).replace(/\s+/g, ' '),
        cast: cleanText(r.cast, ORIGINAL_LIMITS.cast),
    };
}

/** 写卡前检查原创设定填完整没有；有问题返回提示文字（单人卡必须写角色设定，世界卡必须写世界观） */
export function originalInputProblem(raw, kind) {
    const o = normalizeOriginalInput(raw);
    if (kind === 'world') return o.world ? '' : '请填写世界观：时代、地点、世界规则、主要势力……';
    return o.concept ? '' : '请填写角色设定：身份、外貌、性格、经历、和 {{user}} 的关系……';
}

// ---------------- AI 设计的人物与条目 ----------------

const DESIGN_TEXT_FIELDS = ['gender', 'age', 'identity', 'personality', 'relationship'];
const DESIGN_LIST_FIELDS = ['appearance', 'abilities', 'hardLimits', 'tabooTopics', 'verbalTics'];

function listOf(v, max) {
    const arr = Array.isArray(v) ? v : typeof v === 'string' ? v.split(/[\n；;]+/) : [];
    return uniq(arr.map((x) => (isObj(x) ? String(x.text ?? Object.values(x).join('：')) : String(x ?? '')).replace(/^[-*•\s]+/, '').trim())).slice(0, max);
}

/**
 * 规整卡上记的一个 AI 设计的人物（字段与项目的角色资料相同，经历是文字列表）；没有名字时返回 null。
 * savedAs：存进项目后项目里的角色名（加了后缀另存时与 name 不同）。
 */
export function normalizeDesignCharacter(raw) {
    if (!isObj(raw)) return null;
    const name = cleanText(raw.name, 40).replace(/\s+/g, ' ');
    if (!name) return null;
    const out = { name, aliases: listOf(raw.aliases, 8).filter((a) => a !== name) };
    for (const f of DESIGN_TEXT_FIELDS) out[f] = cleanText(raw[f], 500);
    for (const f of DESIGN_LIST_FIELDS) out[f] = listOf(raw[f], 16);
    out.experiences = listOf(raw.experiences, 20);
    out.importance = raw.importance in IMPORTANCE_RANK ? raw.importance : 'main';
    out.savedAs = cleanText(raw.savedAs, 60);
    return out;
}

/** 规整卡上记的一条 AI 设计的世界书条目；没有名称或内容时返回 null */
export function normalizeDesignEntry(raw) {
    if (!isObj(raw)) return null;
    const name = cleanText(raw.name, 40);
    const content = cleanText(raw.content, DESIGN_LIMITS.content);
    const category = cleanText(raw.category, 20);
    if (!name || !content || !category) return null;
    return { category, name, keywords: listOf(raw.keywords, 8).filter((k) => k.length <= 40), content, savedAs: cleanText(raw.savedAs, 60) };
}

/**
 * 规整卡上的原创设定 card.original；不是对象时返回 null。人物按名字、条目按「分类/名称」去重。
 * @returns {{name, concept, world, ref, cast, characters: object[], lore: object[], saved: boolean}|null}
 */
export function normalizeCardOriginal(raw) {
    if (!isObj(raw)) return null;
    const input = normalizeOriginalInput(raw);
    const characters = [];
    for (const c of Array.isArray(raw.characters) ? raw.characters : []) {
        const d = normalizeDesignCharacter(c);
        if (d && !characters.some((x) => x.name === d.name)) characters.push(d);
        if (characters.length >= DESIGN_LIMITS.characters) break;
    }
    const lore = [];
    for (const e of Array.isArray(raw.lore) ? raw.lore : []) {
        const d = normalizeDesignEntry(e);
        if (d && !lore.some((x) => x.category === d.category && x.name === d.name)) lore.push(d);
        if (lore.length >= DESIGN_LIMITS.lore) break;
    }
    return { ...input, characters, lore, saved: raw.saved === true };
}

/** 原创写卡时 lore 可以用的世界书分类：设置里启用的分类（「角色」除外，人物放在 character / cast 里） */
export function originalLoreCategories(settings) {
    const list = (settings?.categories || []).filter((c) => c?.enabled && c.name && c.name !== '角色').map((c) => c.name);
    return list.length ? list : ['世界观', '地点', '势力', '物品'];
}

/** AI 写的分类 → 可用的分类：完全相同 > 名字里含有可用分类（如「地点/场景」）> 世界观（或第一个可用分类） */
function pickCategory(raw, allowed) {
    const s = String(raw ?? '').trim();
    if (allowed.includes(s)) return s;
    const hit = allowed.find((c) => s && s.includes(c));
    if (hit) return hit;
    return allowed.includes('世界观') ? '世界观' : allowed[0];
}

const PEOPLE_CATEGORY_RE = /^(角色|人物|characters?)$/i;

function pickField(obj, keys) {
    for (const k of keys) if (obj?.[k] !== undefined && obj[k] !== null && obj[k] !== '') return obj[k];
    return undefined;
}

/**
 * 从 AI 的写卡回复里取出设计的人物与条目。
 *   单人卡：character（也认 角色 / characters[0]）；世界卡：cast（也认 characters / 主要角色）；
 *   lore：数组 [{category, name, keys, content}]，也认按分类分组的对象 {地点: [...]}。分类不在可用分类里时就近归类，人物类的条目丢掉。
 * 人物的字段名与原著提取一样宽松（中文字段名也认，见 project.js 的 normalizeExtraction）。
 * @param {object} json
 * @param {{kind?: string, settings?: object}} opt
 * @returns {{characters: object[], lore: object[]}}
 */
export function parseOriginalDesign(json, { kind = 'character', settings = null } = {}) {
    const src = isObj(json) ? json : {};
    let rawChars;
    if (kind === 'world') {
        const v = pickField(src, ['cast', 'characters', '主要角色', '角色']);
        rawChars = Array.isArray(v) ? v : isObj(v) ? Object.entries(v).map(([name, x]) => (isObj(x) ? { name, ...x } : { name, identity: String(x ?? '') })) : [];
    } else {
        const v = pickField(src, ['character', '角色', 'profile']);
        rawChars = isObj(v) ? [v] : Array.isArray(src.characters) && isObj(src.characters[0]) ? [src.characters[0]] : [];
    }
    const parsed = normalizeExtraction({ characters: rawChars }).characters;
    const characters = [];
    parsed.forEach((c, i) => {
        // normalizeExtraction 没写重要度时当作次要；原创的人物没写时按主要算（单人卡的角色本人一律主要）
        const rawImp = pickField(rawChars.find((r) => isObj(r) && String(pickField(r, ['name', '名称', '姓名', '名字']) ?? '').trim() === c.name) || rawChars[i], ['importance', '重要度']);
        const d = normalizeDesignCharacter({ ...c, importance: kind !== 'world' || rawImp === undefined ? 'main' : c.importance });
        if (d && !characters.some((x) => x.name === d.name)) characters.push(d);
    });

    const allowed = originalLoreCategories(settings);
    const loreSrc = pickField(src, ['lore', '世界书', 'entries', '条目']);
    const items = Array.isArray(loreSrc)
        ? loreSrc.filter(isObj).map((e) => ({ cat: pickField(e, ['category', '分类', 'type']), e }))
        : isObj(loreSrc) ? Object.entries(loreSrc).flatMap(([cat, list]) => (Array.isArray(list) ? list.filter(isObj).map((e) => ({ cat, e })) : [])) : [];
    const grouped = {};
    for (const { cat, e } of items) {
        if (PEOPLE_CATEGORY_RE.test(String(cat ?? '').trim())) continue;
        const c = pickCategory(cat, allowed);
        (grouped[c] = grouped[c] || []).push(e);
    }
    const entries = normalizeExtraction({ entries: grouped }).entries;
    const lore = [];
    for (const [category, list] of Object.entries(entries)) {
        for (const e of list) {
            const d = normalizeDesignEntry({ category, name: e.name, keywords: e.keywords, content: e.content });
            if (d && !lore.some((x) => x.category === d.category && x.name === d.name)) lore.push(d);
        }
    }
    return { characters: characters.slice(0, DESIGN_LIMITS.characters), lore: lore.slice(0, DESIGN_LIMITS.lore) };
}

/**
 * 设计出来的经历记在哪一段：-1 = 不属于任何分段的设定。任何时间点都算（characterAt 按 chunk <= 时间点筛），
 * 重新提取 / 删除 / 合并分段都碰不到它（removeChunkContributions 只删等于那一段的，remapChunkRefs 不改负数）；
 * 「角色」页显示成 [0]，保存时 [0] 又读回 -1。
 */
export const DESIGN_CHUNK = -1;

/** AI 设计的人物 → 项目的角色资料（normalizeCharacter 的形状；经历记在 DESIGN_CHUNK，任何时间点都算） */
export function designToCharacter(d, name = d?.name) {
    const c = normalizeCharacter({
        name,
        aliases: (d.aliases || []).filter((a) => a !== name),
        ...Object.fromEntries(DESIGN_TEXT_FIELDS.map((f) => [f, d[f] || ''])),
        ...Object.fromEntries(DESIGN_LIST_FIELDS.map((f) => [f, d[f] || []])),
        experiences: (d.experiences || []).map((text) => ({ chunk: DESIGN_CHUNK, text })),
        importance: d.importance || 'main',
        locked: true,
        manual: true,
    });
    // 与「角色」页手动新建的角色一样记在第 0 段：任何故事时间点都在
    c.chunksSeen = [0];
    c.firstChunk = 0;
    c.lastChunk = 0;
    return c;
}

/**
 * 当前的设定（给提示词和背景资料用）：已经存进项目、项目里还在的人物和条目以项目里的为准（用户可能在「角色」「世界书」页改过），
 * 名字仍用卡里的名字（加后缀另存时项目里叫「名字（原创）」）；其余用卡上记的设计。
 * @returns {{characters: object[], lore: {category, name, keywords, content}[]}} characters 是 normalizeCharacter 形状
 */
export function originalDesignView(project, original) {
    const o = normalizeCardOriginal(original);
    if (!o) return { characters: [], lore: [] };
    const characters = o.characters.map((d) => {
        const saved = o.saved && d.savedAs ? project?.characters?.[d.savedAs] : null;
        const base = saved ? characterAt(saved, Infinity) : designToCharacter(d);
        return { ...base, name: d.name, aliases: (base.aliases || []).filter((a) => a !== d.name && a !== d.savedAs) };
    });
    const lore = o.lore.map((e) => {
        const saved = o.saved && e.savedAs ? project?.worldbook?.[e.category]?.[e.savedAs] : null;
        return saved ? { category: e.category, name: e.name, keywords: saved.keywords || e.keywords, content: saved.content || e.content } : { category: e.category, name: e.name, keywords: e.keywords, content: e.content };
    });
    return { characters, lore };
}

function block(tag, text) {
    return `<${tag}>\n${text}\n</${tag}>`;
}

/**
 * 写卡提示词 {ORIGINAL}：用户写的原创设定；view（已经设计好时）另附「已定下的人物」「已定下的世界设定」。
 * @param {object} original card.original（或表单里的设定）
 * @param {{kind?: string, view?: {characters: object[], lore: object[]}|null, name?: string, fixed?: boolean}} opt
 *   name：已经定下的名字（用户没填、AI 起好的卡名 / 角色名）；fixed：已经设计好了（整卡重新生成、单字段重roll、背景资料）——
 *   这时不再说「由你来起」「由你设计」，免得 AI 一边收到定下的名字和人物，一边被要求重新起名、重新设计
 */
export function originalPromptText(original, { kind = 'character', view = null, name = '', fixed = !!view?.characters?.length } = {}) {
    const o = normalizeCardOriginal(original) || normalizeCardOriginal({});
    const lines = [];
    const shown = String(name || '').trim();
    /** 名字这一行：用户定的 > 已经定下的 > 新写卡时由 AI 起（已经设计好却没有名字时不写这一行） */
    const nameLine = (label) => {
        if (o.name) return `${label}：${o.name}（用户定的，不要改）`;
        if (shown) return `${label}：${shown}（已经定下，不要改）`;
        return fixed ? '' : `${label}：没有定，由你来起`;
    };
    if (kind === 'world') {
        lines.push('卡片类型：世界/旁白卡（{{char}} 是叙述者，扮演所有 NPC）');
        lines.push(nameLine('卡名'));
        lines.push(`世界观：\n${block('世界观', o.world || '（没有写）')}`);
        if (o.cast) lines.push(`主要角色（用户写了的人一定要有，名字和设定照用户写的）：\n${block('主要角色', o.cast)}`);
        else if (!fixed) lines.push('主要角色：没有写，由你按世界观设计 3-8 个。');
    } else {
        lines.push('卡片类型：单人角色卡（{{char}} 就是这个角色）');
        lines.push(nameLine('角色名'));
        lines.push(`角色设定：\n${block('角色设定', o.concept || '（没有写）')}`);
        lines.push(o.world ? `世界观 / 背景：\n${block('世界观', o.world)}` : '世界观 / 背景：没有写，按角色设定配一个合适、具体的背景。');
    }
    if (o.ref) lines.push(`参考氛围：${o.ref}（只借氛围和质感，不照搬其中的人物、名字和情节）`);
    let text = lines.filter(Boolean).join('\n');
    if (view?.characters?.length) {
        const who = kind === 'world' ? '已定下的主要角色（以此为准）' : '已定下的人物（{{char}} 本人，以此为准）';
        text += `\n\n## ${who}\n${view.characters.map((c) => characterProfileText(c, { maxExperiences: 12, withQuotes: false, withDialogues: false })).join('\n---\n')}`;
    }
    if (view?.lore?.length) text += `\n\n## 已定下的世界设定\n${view.lore.map((e) => `[${e.category}] ${e.name}\n${e.content}`).join('\n\n')}`;
    return text;
}

const DESIGN_CHARACTER_JSON = (indent, importance) => [
    '{',
    '  "name": "名字",',
    '  "aliases": ["别名或昵称"],',
    '  "gender": "",',
    '  "age": "",',
    '  "identity": "一句话身份",',
    '  "personality": "一句话性格（写成可观察的行为）",',
    '  "relationship": "与 {{user}} 和身边重要的人的关系（具体画面）",',
    '  "appearance": ["一眼能认出 TA 的外貌特征"],',
    '  "abilities": [],',
    '  "hardLimits": ["绝对不会做的事"],',
    '  "tabooTopics": ["忌讳的话题"],',
    '  "verbalTics": ["口癖、称呼习惯、句式特点"],',
    '  "experiences": ["让 TA 成为现在这样的关键经历"],',
    `  "importance": "${importance}"`,
    '}',
].map((l, i) => (i ? `${indent}${l}` : l)).join('\n');

/**
 * 写卡提示词 {DESIGN_GUIDE}：设计要求里随卡片类型变化的几条。
 * @param {{kind?: string, fixed?: boolean, name?: string, categories?: string[]}} opt
 *   fixed：人物和条目已经设计好（整卡重新生成 / 单字段重roll / 推演的背景资料），只重写卡片字段；name：用户定的名字（没有时为 ''）
 */
export function originalDesignGuide({ kind = 'character', fixed = false, name = '', categories = [] } = {}) {
    const world = kind === 'world';
    if (fixed) {
        return [
            `- 人物和世界设定已经定下（见上面「${world ? '已定下的主要角色' : '已定下的人物'}」「已定下的世界设定」）：沿用，不改名、不改设定，只重写卡片字段；不用再输出 character、cast 或 lore。`,
            name ? `- name 写「${name}」。` : '',
        ].filter(Boolean).join('\n');
    }
    const cats = (categories.length ? categories : ['世界观', '地点', '势力', '物品']).join('、');
    const lore = `- lore：3-8 条世界书条目，写卡片和扮演会用到的地点、组织、物品、规则（人物放在 ${world ? 'cast' : 'character'} 里，不放这里）。category 只能是：${cats}；content 用数据库格式（键: 值 / 列表），keys 写 1-4 个会在对话里出现的触发词（含名称本身）。`;
    if (world) {
        return [
            '- 先把这个世界和里面的人想清楚再写卡：在 cast 里给出 3-8 个主要角色的人物档案（字段与 NovelLoom 的角色资料相同，会存进项目，用来生成世界书）。用户在「主要角色」里写了的人都要有，名字和设定照用户写的，再按故事需要补充；importance 写 main（核心）或 support（重要配角）。',
            '- {{char}} 是叙述者、{{user}} 是用户，两者都不放进 cast；cast 里写角色的名字，不用 {{char}}，提到用户时写 {{user}}。description 里的主要角色一览与 cast 一致。',
            name ? `- 卡名：用户定的卡名是「${name}」，name 用它，不要改。` : '- 卡名：用户没有定卡名，起一个贴合这个世界的卡名（2-10 个字）写在 name 里。',
            lore,
        ].join('\n');
    }
    return [
        '- 先把人想清楚再写卡：在 character 里给出 {{char}} 的人物档案（字段与 NovelLoom 的角色资料相同，会存进项目，用来生成世界书），description 由它展开，两边的事实一致。character 里写 TA 的名字，不用 {{char}}；提到用户时写 {{user}}。',
        name ? `- 名字：用户定的名字是「${name}」，name 和 character.name 都用它，不要改。` : '- 名字：用户没有定名字，起一个贴合设定、好记的名字，name 和 character.name 用同一个。',
        lore,
        '- {{user}} 不写进 character，也不写成 lore 里的条目。',
    ].join('\n');
}

/** 写卡提示词 {DESIGN_FIELDS}：一致性要求里列出的设计字段 */
export function originalDesignFields({ kind = 'character', fixed = false } = {}) {
    if (fixed) return '与已定下的设定';
    return kind === 'world' ? '、cast 和 lore ' : '、character 和 lore ';
}

/**
 * 写卡提示词 {DESIGN_JSON}：JSON 模板末尾（接在 tags 后面，以逗号开头）的 character / cast 与 lore；已经设计好时为 ''。
 * @param {{kind?: string, fixed?: boolean, categories?: string[]}} opt
 */
export function originalDesignJson({ kind = 'character', fixed = false, categories = [] } = {}) {
    if (fixed) return '';
    const cat = categories.includes('地点') ? '地点' : categories[0] || '地点';
    const people = kind === 'world'
        ? `  "cast": [\n    ${DESIGN_CHARACTER_JSON('    ', 'main|support')}\n  ],`
        : `  "character": ${DESIGN_CHARACTER_JSON('  ', 'main')},`;
    return `,\n${people}\n  "lore": [\n    {"category": "${cat}", "name": "名称", "keys": ["触发词"], "content": "数据库格式的条目内容"}\n  ]`;
}

/**
 * 原创卡的背景资料（状态栏变量表、重新生成本书落点等只要背景的地方用）：用户的设定 + 当前的人物与世界设定；最多 maxChars 字。
 * @param {object} project
 * @param {object} card
 */
export function originalBackgroundText(project, card, { maxChars = 4000 } = {}) {
    const o = normalizeCardOriginal(card?.original);
    if (!o) return '';
    const view = originalDesignView(project, o);
    const world = card?.kind === 'world';
    // 卡已经写好了：名字和人物都是定下的（不让状态栏 / 落点 / 推演的 AI 再去起名、设计主要角色）
    const name = world ? card?.cardName || card?.data?.name || '' : o.characters[0]?.name || card?.data?.name || '';
    const parts = [`## 用户的原创设定\n${originalPromptText(o, { kind: world ? 'world' : 'character', name, fixed: true })}`];
    if (view.characters.length) {
        parts.push(`## ${card?.kind === 'world' ? '主要角色' : '角色资料'}\n${view.characters.map((c) => characterProfileText(c, { maxExperiences: 8, withQuotes: false, withDialogues: false })).join('\n---\n')}`);
    }
    if (view.lore.length) parts.push(`## 世界设定\n${view.lore.map((e) => `[${e.category}] ${e.name}\n${truncate(e.content, 600)}`).join('\n\n')}`);
    return truncate(parts.join('\n\n'), maxChars);
}

/** 世界/旁白卡的主要角色名（状态栏预填「主要角色」记录用）：卡里的名字；不是原创世界卡时为 null */
export function originalCastNames(card) {
    if (!isOriginalCard(card) || card?.kind !== 'world') return null;
    const o = normalizeCardOriginal(card.original);
    return o ? o.characters.map((c) => c.name) : null;
}

/** 卡上一句话说明（编辑框、日志用）：用户写的设定的开头 */
export function originalSummary(card) {
    const o = normalizeCardOriginal(card?.original);
    if (!o) return '';
    const head = card?.kind === 'world' ? o.world : o.concept;
    return truncate(String(head || '').replace(/\s+/g, ' '), 60);
}

// ---------------- 存进项目 ----------------

/** 另存用的名字：「名字（原创）」，已经有了就「名字（原创2）」「名字（原创3）」… */
export function suffixedName(base, taken) {
    for (let i = 1; ; i++) {
        const n = `${base}（${ORIGINAL_NAME_SUFFIX}${i > 1 ? i : ''}）`;
        if (!taken(n)) return n;
    }
}

/**
 * 同名另存的「影子」：加后缀另存时（「林晚（原创）」），卡里的名字「林晚」留作它的别名 / 关键词，好让这张卡的世界书照样触发；
 * 这个名字记在 originalShadow 上，只属于存它的那张原创卡——提取认人、认条目时不看它（不会让原来的「林晚」变得有歧义），
 * 别的卡写入酒馆时也不带这份副本（见 cardEntryFilter），免得它和原来的那个一起被触发、资料互相矛盾。
 */
function isShadow(item, name) {
    return !!item?.originalShadow && item.originalShadow === name;
}

/**
 * 项目里与这个人物名撞上的角色：名字相同（via 'name'），或者某个具体别名相同（via 'alias'；同名另存的影子别名不算）。
 * cardId：这张原创卡自己存进来的不算撞。
 * @returns {{via: 'name'|'alias', owner: string}|null} owner：撞上的那个角色的名字
 */
export function characterClash(project, name, { cardId = '' } = {}) {
    const n = String(name ?? '').trim();
    if (!n) return null;
    const chars = project?.characters || {};
    const own = (c) => !!cardId && c?.originalCardId === cardId;
    if (chars[n] && !own(chars[n])) return { via: 'name', owner: n };
    if (!isSpecificAlias(n)) return null;
    for (const [k, c] of Object.entries(chars)) {
        if (k === n || own(c)) continue;
        if ((c?.aliases || []).includes(n) && !isShadow(c, n)) return { via: 'alias', owner: k };
    }
    return null;
}

/**
 * 项目世界书里与这个条目撞上的：同分类同名（via 'name'，可以覆盖），或者别的条目的名字 / 关键词正好是这个名字（via 'keyword'；
 * 包括别的分类里的同名条目；同名另存的影子关键词不算）。cardId：这张原创卡自己存进来的不算撞。
 * @returns {{via: 'name'|'keyword', owner: string, category: string}|null}
 */
export function entryClash(project, category, name, { cardId = '' } = {}) {
    const n = String(name ?? '').trim();
    if (!n) return null;
    const wb = project?.worldbook || {};
    const own = (e) => !!cardId && e?.originalCardId === cardId;
    const exact = wb[category]?.[n];
    if (exact && !own(exact)) return { via: 'name', owner: n, category };
    for (const [cat, list] of Object.entries(wb)) {
        for (const [k, e] of Object.entries(list || {})) {
            if (!e || own(e) || (cat === category && k === n)) continue;
            if (k === n || ((e.keywords || []).includes(n) && !isShadow(e, n))) return { via: 'keyword', owner: k, category: cat };
        }
    }
    return null;
}

/**
 * 存进项目前的检查：哪些人物 / 条目与项目里已有的撞上了（同名，或者名字正好是别的角色的具体别名、别的条目的关键词）。
 * @returns {{characters: {name: string, exists: boolean}[], lore: {category: string, name: string, exists: boolean}[],
 *   collisions: {type: 'character'|'entry', name: string, category?: string, via: string, owner: string, ownerCategory?: string}[]}}
 *   via：'name' = 同名（可以覆盖）；'alias' / 'keyword' = 只是别名 / 关键词相同（总是加后缀另存）
 */
export function originalSavePlan(project, original) {
    const o = normalizeCardOriginal(original) || normalizeCardOriginal({});
    const characters = o.characters.map((c) => ({ name: c.name, clash: characterClash(project, c.name) }));
    const lore = o.lore.map((e) => ({ category: e.category, name: e.name, clash: entryClash(project, e.category, e.name) }));
    return {
        characters: characters.map((c) => ({ name: c.name, exists: !!c.clash })),
        lore: lore.map((e) => ({ category: e.category, name: e.name, exists: !!e.clash })),
        collisions: [
            ...characters.filter((c) => c.clash).map((c) => ({ type: 'character', name: c.name, via: c.clash.via, owner: c.clash.owner })),
            ...lore.filter((e) => e.clash).map((e) => ({ type: 'entry', category: e.category, name: e.name, via: e.clash.via, owner: e.clash.owner, ownerCategory: e.clash.category })),
        ],
    };
}

/**
 * 把卡上 AI 设计的人物和条目存进项目：人物存成手动角色（manual + locked），条目存成手动条目（locked，没有出处段落，重新提取不会删）。
 * 不经过提取用的合并规则（不会按别名并进别的角色）；别名已经是别的角色的名字或具体别名时不收。
 * 撞上项目里已有的（见 originalSavePlan）：同名且选了 overwrite 时替换；其余一律加后缀另存为新的，卡里的名字留作别名 / 关键词
 * （这张卡的世界书照样能触发），并记成影子（originalShadow，见 isShadow）。
 * @param {object} project
 * @param {object} card 原创卡（会改 card.original：saved = true、各项的 savedAs；单人卡的 card.charName 改成项目里的角色名）
 * @param {{collision?: 'suffix'|'overwrite'}} opt 同名时：suffix = 加后缀另存为新的（默认）；overwrite = 用新设计替换项目里的
 * @returns {{characters: {name: string, savedAs: string, overwritten: boolean, via: string, owner: string}[],
 *   lore: {category: string, name: string, savedAs: string, overwritten: boolean, via: string, owner: string}[]}}
 */
export function saveOriginalDesign(project, card, { collision = 'suffix' } = {}) {
    const o = normalizeCardOriginal(card?.original);
    if (!o) throw new Error('这张卡没有原创设定');
    const result = { characters: [], lore: [] };
    if (!project.characters || typeof project.characters !== 'object') project.characters = {};
    if (!project.worldbook || typeof project.worldbook !== 'object') project.worldbook = {};
    for (const d of o.characters) {
        const clash = characterClash(project, d.name);
        const overwrite = clash?.via === 'name' && collision === 'overwrite';
        const key = clash && !overwrite ? suffixedName(d.name, (n) => !!project.characters[n]) : d.name;
        const ownedByOther = (a) => Object.entries(project.characters).some(([k, c]) => k !== key && (k === a || (isSpecificAlias(a) && (c.aliases || []).includes(a))));
        const ch = designToCharacter(d, key);
        // 加后缀另存时把卡里的名字留作别名（这张卡的世界书按它触发），记成只属于这张卡的影子
        ch.aliases = uniq([key !== d.name ? d.name : null, ...ch.aliases.filter((a) => a !== key && !ownedByOther(a))]);
        if (key !== d.name) ch.originalShadow = d.name;
        if (card.id) ch.originalCardId = card.id;
        project.characters[key] = ch;
        d.savedAs = key;
        result.characters.push({ name: d.name, savedAs: key, overwritten: overwrite, via: clash?.via || '', owner: clash?.owner || '' });
    }
    const now = Date.now();
    for (const e of o.lore) {
        const clash = entryClash(project, e.category, e.name);
        const overwrite = clash?.via === 'name' && collision === 'overwrite';
        const cat = (project.worldbook[e.category] = project.worldbook[e.category] || {});
        const key = clash && !overwrite ? suffixedName(e.name, (n) => !!cat[n]) : e.name;
        cat[key] = {
            name: key, keywords: uniq([key, e.name, ...e.keywords]), content: e.content,
            sourceChunks: [], revisions: [], config: {}, locked: true, manual: true, updatedAt: now,
            ...(card.id ? { originalCardId: card.id } : {}),
            ...(key !== e.name ? { originalShadow: e.name } : {}),
        };
        e.savedAs = key;
        result.lore.push({ category: e.category, name: e.name, savedAs: key, overwritten: overwrite, via: clash?.via || '', owner: clash?.owner || '' });
    }
    o.saved = true;
    card.original = o;
    if (card.kind !== 'world' && o.characters[0]) card.charName = o.characters[0].savedAs || o.characters[0].name;
    return result;
}

/** 存进项目的结果 → 一句日志 */
export function originalSaveLog(result) {
    const chars = result.characters.map((c) => {
        if (c.savedAs === c.name) return `「${c.name}」${c.overwritten ? '（覆盖了同名角色）' : ''}`;
        return c.via === 'alias' ? `「${c.name}」（是「${c.owner}」的别名，另存为「${c.savedAs}」）` : `「${c.name}」（同名，另存为「${c.savedAs}」）`;
    });
    const byCat = {};
    for (const e of result.lore) byCat[e.category] = (byCat[e.category] || 0) + 1;
    const lore = Object.entries(byCat).map(([c, n]) => `${c} ${n}`).join('、');
    const renamed = result.lore.filter((e) => e.savedAs !== e.name).map((e) => `「${e.name}」→「${e.savedAs}」`);
    const overwritten = result.lore.filter((e) => e.overwritten).length;
    return [
        chars.length ? `角色 ${chars.join('、')}` : '',
        result.lore.length ? `${result.lore.length} 条世界书条目（${lore}）${renamed.length ? `，同名的另存为 ${renamed.join('、')}` : ''}${overwritten ? `，覆盖了 ${overwritten} 条同名条目` : ''}` : '',
    ].filter(Boolean).join('，');
}

/**
 * 原创卡写入时不带的项目资料：别的原创卡（项目里还在的）存进来的角色和条目——每张原创卡是自己的世界，
 * 同一个项目里写好几张不相干的原创卡时互不串味。提取的、手动加的、卡已经删掉的资料照常带上；不是原创卡时返回 null（全部带上）。
 * @returns {Set<string>|null} 要排除的原创卡 id
 */
export function otherOriginalCardIds(project, card) {
    if (!isOriginalCard(card)) return null;
    return new Set((project?.cards || []).filter((c) => c && c.id !== card.id && isOriginalCard(c)).map((c) => c.id));
}

/**
 * 写入酒馆时这张卡不带哪些项目资料（buildWorldbookEntries 的结果逐条判断）；什么都不排除时返回 null。
 *  - 原创卡：别的原创卡存进来的角色和条目（见 otherOriginalCardIds）；项目里与这张卡设计的人物 / 条目撞名的别人的资料
 *    （同名、别名或关键词相同，见 characterClash / entryClash）——比如原著里的「林晚」、提取的「雾港」：卡里的名字会把它们
 *    和这张卡自己的设定一起触发，两份资料互相矛盾；
 *  - 所有卡：别的原创卡同名另存的影子副本（它拿卡里的名字当别名 / 关键词，会和原来的那个一起被触发）。
 * 提取的、手动加的资料（不撞名时）照常带上。
 * @returns {(entry: {category: string, name: string}) => boolean} 返回 true = 不带
 */
export function cardEntryFilter(project, card) {
    const original = isOriginalCard(card);
    const myId = original ? String(card?.id || '') : '';
    const others = otherOriginalCardIds(project, card);
    const clashChars = new Set();
    const clashEntries = new Set();
    if (original) {
        const o = normalizeCardOriginal(card.original);
        // 撞上的可能不止一个（名字相同的一个 + 别名 / 关键词相同的几个）：逐个找出来，规则同 characterClash / entryClash
        for (const d of o?.characters || []) {
            for (const [k, c] of Object.entries(project?.characters || {})) {
                if (myId && c?.originalCardId === myId) continue;
                if (k === d.name || (isSpecificAlias(d.name) && (c?.aliases || []).includes(d.name) && !isShadow(c, d.name))) clashChars.add(k);
            }
        }
        for (const e of o?.lore || []) {
            for (const [cat, list] of Object.entries(project?.worldbook || {})) {
                for (const [k, x] of Object.entries(list || {})) {
                    if (!x || (myId && x.originalCardId === myId)) continue;
                    if (k === e.name || ((x.keywords || []).includes(e.name) && !isShadow(x, e.name))) clashEntries.add(`${cat}\u0001${k}`);
                }
            }
        }
    }
    // 项目世界书里的一条（buildWorldbookEntries 的结果）来自哪里：角色看 characters[name]，条目看 worldbook[分类][name]；
    // originalCardId = 哪张原创卡存进来的（提取的、手动加的没有）
    const filter = (entry) => {
        const isChar = entry?.category === '角色';
        const src = isChar ? project?.characters?.[entry?.name] : project?.worldbook?.[entry?.category]?.[entry?.name];
        if (!src) return false;
        const owner = String(src.originalCardId || '');
        if (owner && owner !== myId) {
            if (others?.has(owner)) return true;
            if (src.originalShadow) return true;
        }
        if (isChar ? clashChars.has(entry.name) : clashEntries.has(`${entry.category}\u0001${entry.name}`)) return true;
        return false;
    };
    return filter;
}

// ---------------- 写入酒馆：没存进项目时卡自己世界书里的条目 ----------------

/** 没存进项目的原创卡写入时有没有卡上的条目（人物 / 设定，放进卡自己的世界书；原创卡总是用自己的一本，见 publish.js 的 cardOwnWorld） */
export function originalHasOwnEntries(card) {
    if (!isOriginalCard(card)) return false;
    const o = normalizeCardOriginal(card.original);
    if (!o || o.saved) return false;
    return o.lore.length > 0 || (card.kind === 'world' ? o.characters.length > 0 : o.characters.length > 1);
}

/**
 * 没存进项目的原创卡：AI 设计的人物和条目作为卡自己世界书里的条目（存进项目后改由项目的世界书提供，这里返回 []）。
 * 条目的激活方式、位置、深度、顺序按设置里对应分类（与 worldbook.js 的 buildWorldbookEntries 相同）；分类关掉了的不写。
 * 单人卡的角色本人按「世界书中不重复写入该角色本人」处理。
 */
export function originalOwnEntries(settings, card) {
    if (!originalHasOwnEntries(card)) return [];
    const o = normalizeCardOriginal(card.original);
    const cats = settings?.categories || [];
    const conf = (name) => cats.find((c) => c.name === name) || null;
    const out = [];
    const nextOrder = (c, i) => Number(c?.order ?? 600) + (c?.autoIncrement === false ? 0 : i);
    const roleCat = conf('角色');
    if (!roleCat || roleCat.enabled) {
        const excludeSelf = card.kind !== 'world' && settings?.worldbook?.excludeCardCharacter !== false;
        o.characters.filter((_, i) => !(excludeSelf && i === 0)).forEach((d, i) => {
            const c = designToCharacter(d);
            out.push({
                category: '角色', name: d.name, keywords: uniq([d.name, ...d.aliases]), content: characterProfileText(c, { withQuotes: false, withDialogues: false }),
                constant: roleCat?.constant ?? false, position: Number(roleCat?.position ?? 0), depth: Number(roleCat?.depth ?? 4), order: nextOrder(roleCat || { order: 100 }, i), disable: false,
            });
        });
    }
    const idx = {};
    for (const e of o.lore) {
        const c = conf(e.category);
        if (c && !c.enabled) continue;
        idx[e.category] = (idx[e.category] ?? -1) + 1;
        out.push({
            category: e.category, name: e.name, keywords: uniq([e.name, ...e.keywords]), content: e.content,
            constant: c?.constant ?? false, position: Number(c?.position ?? 0), depth: Number(c?.depth ?? 4), order: nextOrder(c, idx[e.category]), disable: false,
        });
    }
    return out;
}
