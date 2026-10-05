// 卡的导向：写卡时选一个剧情导向（纯爱 / NTL / NTR / 后宫 …），
//   1) 写卡提示词里追加「导向段」（名称、说明、写卡要求；开了「让 AI 结合本书细化」时让 AI 另外输出 orientation_notes）；
//   2) 卡片记下导向快照 card.orientation = {templateId, name, brief, cardGuide, entry, notes, refine, depth, role, order}，
//      之后改模板不影响已生成的卡；
//   3) 写入酒馆 / 导出时，卡自己的世界书里多一个常驻条目「剧情导向：名称」（正文 = entry + 【本书落点】notes），
//      插在聊天深度 depth（默认 4、系统角色），见 publish.js 的 cardExtraEntries。
// 内置模板只读；用户模板存在扩展设置 settings.orientationTemplates（跨项目共用，导入配置时按 id 合并）。
// 不碰 DOM、不调用 AI（重新生成本书落点在 cards.js 的 regenerateOrientationNotes）。

import { truncate, uid } from './utils.js';

/** 自定义导向（只用这一次，不存成模板）在下拉框里的值 */
export const ORIENTATION_CUSTOM = '__custom__';
/** 用户模板文件的 type */
export const ORIENTATION_FILE_TYPE = 'novel_loom_orientation_templates';

export const ORIENTATION_LIMITS = { name: 20, brief: 200, cardGuide: 1500, entry: 4000, notes: 2000 };
export const ORIENTATION_DEFAULTS = { depth: 4, role: 0, order: 100 };
/** 词条的角色：与世界书条目 role 一致（0 系统 / 1 用户 / 2 AI） */
export const ORIENTATION_ROLES = [{ value: 0, label: '系统' }, { value: 1, label: '用户' }, { value: 2, label: 'AI' }];

/** 内置模板（文字逐字使用，见设计稿；「不限」不加任何东西，不在列表里） */
export const BUILTIN_ORIENTATIONS = [
    {
        id: 'orient_pure',
        name: '纯爱',
        brief: '一对一、双向奔赴的恋爱，没有第三者插足，重在心动、信任与陪伴。',
        cardGuide: '让卡面（性格、场景、开场白）为 {{user}} 与 {{char}} 之间慢慢升温的感情留出空间：写出两人相识或重逢的契机、彼此吸引的点，以及一两个需要一起跨过的小阻碍。不要安排情敌、出轨或背叛。',
        entry: `【剧情导向：纯爱】
- 故事的核心是 {{user}} 与 {{char}} 之间专一、双向的感情。感情要一步步来：从在意、试探、心动，到确认心意，再到相互依靠；不要跳步，也不要让关系原地打转。
- 多写细节里的心意：记得对方说过的话、不经意的照顾、欲言又止、独处时的沉默与靠近。
- 冲突来自误会、自卑、身份差距或外部阻力，而不是第三者或背叛；每次冲突过去，两人的关系都更近一步。
- 其他角色可以起哄、助攻、成为朋友，但不会介入两人的感情。
- 亲密场面以情感为先，温柔、有分寸，重在彼此确认心意。`,
    },
    {
        id: 'orient_ntl',
        name: 'NTL',
        brief: '{{user}} 主动接近、夺走原本属于别人的恋人或伴侣（寝取り），重在禁忌感、攻势与对方的动摇。',
        cardGuide: '为 {{char}} 设定一个现有的恋人或伴侣（优先取自原著关系，没有就合理新增），写清两人关系的现状和裂缝；开场白把 {{user}} 放在能接近 {{char}} 的位置，暗示可乘之机。{{char}} 不应一开始就倒向 {{user}}。',
        entry: `【剧情导向：NTL】
- {{char}} 已有恋人或伴侣（下称“原伴侣”）。主线是 {{user}} 逐渐走进 {{char}} 的心里，让 {{char}} 从忠于原伴侣，一步步动摇、挣扎，直到做出选择。
- 动摇要有过程，也要有理由：原伴侣的疏忽、冷淡、误解或缺点，和 {{user}} 带来的理解、刺激与被需要的感觉形成对比。不要让 {{char}} 轻易变心。
- 持续描写 {{char}} 的内心拉扯：罪恶感、对原伴侣残留的感情、害怕被发现、对 {{user}} 越来越难以抗拒。
- 原伴侣是真实存在的人，会关心、会起疑、会在关键时刻出现，制造紧张感与被发现的危机；不要把原伴侣写成摆设。
- 节奏上先是暧昧和越界的小事，再到无法回头的事；每一步都让 {{char}} 意识到自己在越线。`,
    },
    {
        id: 'orient_ntr',
        name: 'NTR',
        brief: '{{user}} 的恋人或伴侣被他人一步步夺走（寝取られ），重在不安、嫉妒与失去的过程。',
        cardGuide: '设定 {{char}} 与 {{user}} 已是恋人或伴侣，并引入（或从原著中选取）一个会接近 {{char}} 的第三者，写清第三者的特点和接近的契机；开场白先展现两人关系的温度，再埋下第三者出现的伏笔。',
        entry: `【剧情导向：NTR】
- {{char}} 是 {{user}} 的恋人或伴侣。故事里有一个逐渐接近 {{char}} 的第三者，主线是 {{char}} 被一步步牵引过去的过程，以及 {{user}} 察觉到的不安。
- 第三者要有吸引力和手段：了解 {{char}} 的弱点，在 {{user}} 缺席时出现，给 {{char}} 带来 {{user}} 给不了的东西。
- 变化循序渐进、有迹可循：{{char}} 对第三者的称呼、聊的话题、回消息的速度、身上的小变化，让 {{user}} 能察觉到异样。
- {{char}} 对 {{user}} 仍有感情，会愧疚、会掩饰、会犹豫；不要突然性格大变或无缘无故背叛。
- 故事走向由 {{user}} 的行动决定：挽回、对质或放任都会真实地影响剧情，可以挽回，也可能失去。
- 不替 {{user}} 做决定，不描写 {{user}} 的内心，只呈现 {{user}} 能看到、听到的线索。`,
    },
    {
        id: 'orient_harem',
        name: '后宫',
        brief: '多位角色同时对 {{user}} 抱有好感，重在各自的心意、相处与彼此之间的微妙关系。',
        cardGuide: '给出至少两三位可能倾心于 {{user}} 的角色（优先从原著选取），写出她们各自的性格反差和与 {{user}} 关系的起点；开场白安排能让多位角色登场或被提及的场景。',
        entry: `【剧情导向：后宫】
- 多位角色会逐渐对 {{user}} 产生好感。每个人心动和表达的方式都不一样：有人直球，有人别扭，有人默默付出；保持各自的个性，不要写成同一个模板。
- 每位角色都有自己的生活和目标，不是只围着 {{user}} 转；好感从具体的事件中产生。
- 角色之间可以竞争、吃醋、试探，也可以有友情和默契；矛盾点到为止，不演变成互相伤害。
- 轮流给不同角色戏份，适时让被冷落的角色出场，保持群像平衡。
- 关系进展由 {{user}} 的选择推动，不替 {{user}} 做决定。`,
    },
    {
        id: 'orient_yuri',
        name: '百合',
        brief: '女性角色之间的恋爱或亲密情感，重在细腻的心意与关系的变化。',
        cardGuide: '以女性角色之间的感情为主线：{{user}} 是女性时，{{user}} 就是感情的一方；否则让 {{char}} 与另一位女性角色的感情成为主线，{{user}} 作为见证者或推动者。写出关系的起点、各自的心结和吸引点。',
        entry: `【剧情导向：百合】
- 故事的主要感情线发生在女性角色之间（{{user}} 是女性时，{{user}} 就是其中一方）。
- 重在细腻：眼神、触碰、称呼的变化、只对彼此展露的一面；感情可以从友情、憧憬或竞争中慢慢变质。
- 写出她们面对这份感情时的犹豫与勇气：世俗的眼光、身边人的看法、对自己心意的不确定。
- 不让男性角色介入这段感情，男性角色只作为背景或朋友出现。
- 亲密场面以情感为先，温柔而有张力。`,
    },
    {
        id: 'orient_bl',
        name: '耽美',
        brief: '男性角色之间的恋爱或羁绊，重在张力、默契与关系的变化。',
        cardGuide: '以男性角色之间的感情为主线：{{user}} 是男性时，{{user}} 就是感情的一方；否则让 {{char}} 与另一位男性角色的感情成为主线，{{user}} 作为见证者或推动者。写出关系的起点、立场与吸引点。',
        entry: `【剧情导向：耽美】
- 故事的主要感情线发生在男性角色之间（{{user}} 是男性时，{{user}} 就是其中一方）。
- 重在张力与细节：针锋相对、并肩作战、互相照顾、只在对方面前示弱；感情从竞争、默契或依赖中慢慢浮现。
- 写出他们面对这份感情时的挣扎：身份立场、身边人的眼光、对自己心意的否认与承认。
- 不让女性角色介入这段感情，女性角色作为背景、朋友或助攻出现。
- 亲密场面以情感为先，克制而有张力。`,
    },
    {
        id: 'orient_angst',
        name: '虐恋',
        brief: '爱而不得，误会与伤害交织，重在情感冲击，结局由剧情决定。',
        cardGuide: '给 {{user}} 与 {{char}} 设定一个让两人难以在一起的根本阻碍（立场对立、身份阻隔、旧怨、误会或命运），写进场景和性格里；开场白在温度与裂痕之间取得张力。',
        entry: `【剧情导向：虐恋】
- {{user}} 与 {{char}} 的感情注定曲折：立场对立、身份阻隔、误会、旧怨或命运的捉弄，让两人爱而不得。
- 每一次靠近都伴随代价：说不出口的真相、不得不做的选择、伤害对方也伤害自己的决定。
- 情绪要有起伏：在痛苦中穿插短暂的温柔与希望，让失去更痛，也让和解更珍贵。
- “虐”要有合理动机，不为虐而虐；不要无端恶意或人格突变。
- 结局不预设：由 {{user}} 的选择决定是破镜重圆、遗憾错过，还是别的结局。`,
    },
    {
        id: 'orient_daily',
        name: '日常',
        brief: '轻松温馨的日常相处，没有大起大落，重在生活气息与关系的慢慢加深。',
        cardGuide: '把场景和开场白落在具体的日常里（住处、学校、工作、街区），写出角色的生活习惯和与 {{user}} 的相处方式；不要在开场制造重大危机。',
        entry: `【剧情导向：日常】
- 故事以日常生活为主：吃饭、上学或上班、出门、节日、小小的意外；节奏舒缓，不刻意制造大冲突。
- 重在生活气息和相处的细节：习惯、口头禅、彼此之间的玩笑与默契。
- 小事件可以推动关系慢慢变化，但不急于推进；让 {{user}} 享受和角色们在一起的时间。
- 适时引入季节、天气、地点的变化，让日常不重复。`,
    },
].map((t) => Object.freeze({ ...t, builtin: true, ...ORIENTATION_DEFAULTS }));

/** 写卡提示词里加入的导向段（选了导向时追加；{name} {brief} {cardGuide} 换成导向的内容） */
export const ORIENTATION_PROMPT_LINES = {
    head: '【卡的导向：{name}】{brief}',
    guide: '写卡要求：{cardGuide}',
    notes: '另外在 JSON 里输出字段 orientation_notes（字符串，3-6 行，每行以“- ”开头）：结合本书的人物与设定，写出这个导向在本书里的具体落点，例如谁是原伴侣或第三者、哪些角色可能倾心于 {{user}}、关键阻碍或冲突是什么。只写设定，不写剧情过程；会追加到世界书「剧情导向」词条的【本书落点】部分。',
};

/** 词条正文里【本书落点】的分隔 */
export const ORIENTATION_NOTES_HEAD = '【本书落点】';

function isObj(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function cleanText(v, max) {
    return String(v ?? '').replace(/\r\n?/g, '\n').trim().slice(0, max);
}

function clampInt(v, min, max, fallback) {
    const n = Math.round(Number(v));
    return Number.isFinite(n) && String(v ?? '').trim() !== '' ? Math.min(max, Math.max(min, n)) : fallback;
}

/** 词条角色：0 / 1 / 2，也认 system / user / assistant；其他回到默认（系统） */
function roleValue(v) {
    const named = { system: 0, user: 1, assistant: 2 };
    if (typeof v === 'string' && named[v.trim().toLowerCase()] !== undefined) return named[v.trim().toLowerCase()];
    const n = Number(v);
    return String(v ?? '').trim() !== '' && [0, 1, 2].includes(n) ? n : ORIENTATION_DEFAULTS.role;
}

/** 名字比较：去掉空白、不分大小写 */
function nameKey(s) {
    return String(s ?? '').replace(/\s+/g, '').toLowerCase();
}

/**
 * 规整一个导向模板的内容（不含 id / 时间）。名称为空时用 fallbackName。
 * @returns {{name, brief, cardGuide, entry, depth, role, order}}
 */
export function normalizeOrientationTemplate(raw, { fallbackName = '' } = {}) {
    const t = isObj(raw) ? raw : {};
    const name = cleanText(t.name, ORIENTATION_LIMITS.name) || cleanText(fallbackName, ORIENTATION_LIMITS.name);
    return {
        name,
        brief: cleanText(t.brief, ORIENTATION_LIMITS.brief),
        cardGuide: cleanText(t.cardGuide, ORIENTATION_LIMITS.cardGuide),
        entry: cleanText(t.entry, ORIENTATION_LIMITS.entry),
        depth: clampInt(t.depth, 0, 9999, ORIENTATION_DEFAULTS.depth),
        role: roleValue(t.role),
        order: clampInt(t.order, -99999, 99999, ORIENTATION_DEFAULTS.order),
    };
}

/** 规整存进设置的一个用户模板（含 id / 时间）；不合法（没有名字也没有正文）返回 null */
export function normalizeStoredOrientationTemplate(raw) {
    if (!isObj(raw)) return null;
    const t = normalizeOrientationTemplate(raw);
    if (!t.name && !t.entry) return null;
    const id = /^otpl_[\w-]+$/.test(String(raw.id || '')) ? String(raw.id) : uid('otpl_');
    const now = Date.now();
    return { id, ...t, name: t.name || '未命名导向', createdAt: Number(raw.createdAt) || now, updatedAt: Number(raw.updatedAt) || now };
}

function storedList(settings) {
    if (!Array.isArray(settings.orientationTemplates)) settings.orientationTemplates = [];
    return settings.orientationTemplates;
}

/** 用户自己的导向模板（规整后的副本，跳过不合法的项与重复 id） */
export function userOrientationTemplates(settings) {
    const list = Array.isArray(settings?.orientationTemplates) ? settings.orientationTemplates : [];
    const seen = new Set(BUILTIN_ORIENTATIONS.map((t) => t.id));
    const out = [];
    for (const raw of list) {
        if (!isObj(raw) || !raw.id || seen.has(String(raw.id))) continue;
        seen.add(String(raw.id));
        const t = normalizeOrientationTemplate(raw);
        out.push({ id: String(raw.id), builtin: false, ...t, name: t.name || '未命名导向', createdAt: raw.createdAt || 0, updatedAt: raw.updatedAt || 0 });
    }
    return out;
}

/** 全部导向模板：内置在前（只读副本），然后是用户模板 */
export function listOrientationTemplates(settings) {
    return [...BUILTIN_ORIENTATIONS.map((t) => ({ ...t })), ...userOrientationTemplates(settings)];
}

export function getOrientationTemplate(settings, id) {
    if (!id) return null;
    return listOrientationTemplates(settings).find((t) => t.id === id) || null;
}

export function isBuiltinOrientation(id) {
    return BUILTIN_ORIENTATIONS.some((t) => t.id === id);
}

/** 在现有模板名里找一个不重复的名字（「名字」「名字 2」…） */
export function uniqueOrientationName(settings, base, exceptId = '') {
    const b = cleanText(base, ORIENTATION_LIMITS.name) || '我的导向';
    const taken = new Set(listOrientationTemplates(settings).filter((t) => t.id !== exceptId).map((t) => nameKey(t.name)));
    if (!taken.has(nameKey(b))) return b;
    for (let i = 2; i < 1000; i++) {
        const suffix = ` ${i}`;
        const n = `${b.slice(0, ORIENTATION_LIMITS.name - suffix.length)}${suffix}`;
        if (!taken.has(nameKey(n))) return n;
    }
    return `${b.slice(0, ORIENTATION_LIMITS.name - 6)} ${Date.now() % 100000}`;
}

/** 名称有什么问题（空 / 与其他模板重名），没问题返回 '' */
export function orientationNameProblem(settings, name, exceptId = '') {
    const n = cleanText(name, ORIENTATION_LIMITS.name);
    if (!n) return '名称不能为空';
    if (listOrientationTemplates(settings).some((t) => t.id !== exceptId && nameKey(t.name) === nameKey(n))) return '已经有同名的导向模板';
    return '';
}

/** 新建用户模板；重名时抛错 */
export function addOrientationTemplate(settings, data) {
    const t = normalizeOrientationTemplate(data);
    const problem = orientationNameProblem(settings, t.name);
    if (problem) throw new Error(problem);
    const now = Date.now();
    const item = { id: uid('otpl_'), ...t, createdAt: now, updatedAt: now };
    storedList(settings).push(item);
    return item;
}

/** 修改用户模板（patch 里出现的字段才改）；内置模板抛错，找不到返回 null */
export function updateOrientationTemplate(settings, id, patch = {}) {
    if (isBuiltinOrientation(id)) throw new Error('内置导向不能修改，可以先「复制为我的模板」再改');
    const list = storedList(settings);
    const i = list.findIndex((x) => isObj(x) && x.id === id);
    if (i < 0) return null;
    const cur = list[i];
    const fields = ['name', 'brief', 'cardGuide', 'entry', 'depth', 'role', 'order'];
    const merged = normalizeOrientationTemplate({ ...Object.fromEntries(fields.map((k) => [k, cur[k]])), ...Object.fromEntries(fields.filter((k) => patch[k] !== undefined).map((k) => [k, patch[k]])) });
    const problem = orientationNameProblem(settings, merged.name, id);
    if (problem) throw new Error(problem);
    const next = { ...cur, ...merged, id, createdAt: cur.createdAt || Date.now(), updatedAt: Date.now() };
    list[i] = next;
    return next;
}

/** 删除用户模板；内置或不存在返回 false */
export function removeOrientationTemplate(settings, id) {
    if (isBuiltinOrientation(id) || !Array.isArray(settings?.orientationTemplates)) return false;
    const n = settings.orientationTemplates.length;
    settings.orientationTemplates = settings.orientationTemplates.filter((t) => t?.id !== id);
    return settings.orientationTemplates.length !== n;
}

/** 复制任一模板（含内置）成新的用户模板，名字自动避开重名 */
export function duplicateOrientationTemplate(settings, id) {
    const src = getOrientationTemplate(settings, id);
    if (!src) return null;
    return addOrientationTemplate(settings, { ...src, name: uniqueOrientationName(settings, src.builtin ? src.name : `${src.name} 副本`) });
}

/** 导出用的 JSON（一个或多个模板；不含 id、内置标记与时间） */
export function exportOrientationTemplates(list) {
    const items = (Array.isArray(list) ? list : [list]).filter(Boolean).map((t) => normalizeOrientationTemplate(t));
    return { type: ORIENTATION_FILE_TYPE, version: 1, templates: items };
}

export function orientationFileName(list) {
    const items = Array.isArray(list) ? list : [list];
    const one = items.length === 1 ? cleanText(items[0]?.name, ORIENTATION_LIMITS.name) : '';
    return `${(one || '导向模板').replace(/[\\/:*?"<>|]/g, '_')}.导向模板.json`;
}

/**
 * 解析导入的 JSON（文本或对象）：本插件的导向模板文件 {type, templates:[…]}、模板数组、或单个模板对象。
 * @returns {object[]} 规整后的模板内容（没有 id）
 * @throws {Error} 认不出格式或一个可用的模板都没有时
 */
export function parseOrientationTemplates(input) {
    let json = input;
    if (typeof json === 'string') {
        try {
            json = JSON.parse(json.trim());
        } catch {
            throw new Error('文件不是有效的 JSON');
        }
    }
    let list;
    if (Array.isArray(json)) list = json;
    else if (isObj(json) && Array.isArray(json.templates)) list = json.templates;
    else if (isObj(json) && Array.isArray(json.orientationTemplates)) list = json.orientationTemplates;
    else if (isObj(json) && (json.entry !== undefined || json.cardGuide !== undefined) && json.name !== undefined) list = [json];
    else throw new Error('不是 NovelLoom 导向模板文件');
    const out = list.filter(isObj).map((t) => normalizeOrientationTemplate(t)).filter((t) => t.name && (t.entry || t.brief || t.cardGuide));
    if (!out.length) throw new Error('文件里没有可用的导向模板（需要名称和词条正文）');
    return out;
}

/** 导入并保存（每个都是新的用户模板，重名时自动改名）；返回新建的模板 */
export function importOrientationTemplates(settings, input) {
    return parseOrientationTemplates(input).map((t) => addOrientationTemplate(settings, { ...t, name: uniqueOrientationName(settings, t.name) }));
}

/**
 * 导入配置时合并用户模板：按 id 覆盖本机同 id 的、追加没有的（与 relationTemplates / statusBarTemplates 同一口径），逐个规整。
 * @returns {object[]} 合并后的列表（也写回 settings.orientationTemplates）
 */
export function mergeOrientationTemplates(settings, incoming) {
    const cur = Array.isArray(settings.orientationTemplates) ? settings.orientationTemplates : [];
    for (const raw of Array.isArray(incoming) ? incoming : []) {
        if (!isObj(raw) || !raw.id || isBuiltinOrientation(raw.id)) continue;
        const item = normalizeStoredOrientationTemplate(raw);
        if (!item || item.id !== raw.id) continue;
        const i = cur.findIndex((x) => x?.id === item.id);
        if (i >= 0) cur[i] = item;
        else cur.push(item);
    }
    settings.orientationTemplates = cur;
    return cur;
}

// ---------------- 写卡时的导向（卡片快照） ----------------

/**
 * 写卡表单的选择 → 导向快照（不含 notes）；选「不限」或内容为空时返回 null。
 * @param {object} settings
 * @param {{id?: string, customName?: string, customBrief?: string, refine?: boolean}} pick
 *   id：'' = 不限；ORIENTATION_CUSTOM = 自定义（只这一次，用 customName / customBrief）；其他为模板 id
 */
export function orientationFromPick(settings, { id = '', customName = '', customBrief = '', refine = true } = {}) {
    if (!id) return null;
    if (id === ORIENTATION_CUSTOM) {
        const name = cleanText(customName, ORIENTATION_LIMITS.name);
        const brief = cleanText(customBrief, ORIENTATION_LIMITS.brief);
        if (!name && !brief) return null;
        const n = name || '自定义';
        return {
            templateId: ORIENTATION_CUSTOM, name: n, brief, cardGuide: '', entry: `【剧情导向：${n}】${brief ? `\n${brief}` : ''}`,
            notes: '', refine: refine !== false, ...ORIENTATION_DEFAULTS,
        };
    }
    const t = getOrientationTemplate(settings, id);
    if (!t) return null;
    return { templateId: t.id, name: t.name, brief: t.brief, cardGuide: t.cardGuide, entry: t.entry, notes: '', refine: refine !== false, depth: t.depth, role: t.role, order: t.order };
}

/** 规整卡片上的导向快照；没有导向（不限）时返回 null */
export function normalizeCardOrientation(raw) {
    if (!isObj(raw)) return null;
    const t = normalizeOrientationTemplate(raw);
    if (!t.name && !t.entry) return null;
    return {
        templateId: String(raw.templateId ?? ''),
        ...t,
        name: t.name || '自定义',
        notes: cleanText(raw.notes, ORIENTATION_LIMITS.notes),
        refine: raw.refine !== false,
    };
}

function fill(line, o) {
    return line.replace(/\{(name|brief|cardGuide)\}/g, (_, k) => String(o[k] ?? ''));
}

/**
 * 写卡提示词里的导向段：导向名称与说明、写卡要求（有的话）、要求输出 orientation_notes（refine 开着时）。
 * @param {object|null} orientation 卡片快照或 orientationFromPick 的结果
 * @param {{askNotes?: boolean}} opt askNotes=false：不要求输出 orientation_notes（只作背景资料时）
 * @returns {string} 没有导向时为 ''
 */
export function orientationPromptBlock(orientation, { askNotes = true } = {}) {
    const o = normalizeCardOrientation(orientation);
    if (!o) return '';
    const lines = [fill(ORIENTATION_PROMPT_LINES.head, o)];
    if (o.cardGuide) lines.push(fill(ORIENTATION_PROMPT_LINES.guide, o));
    if (askNotes && o.refine) lines.push(ORIENTATION_PROMPT_LINES.notes);
    return lines.join('\n');
}

/**
 * 把 AI 返回的 orientation_notes 规整成「- 」开头的若干行（字符串或数组都行；最多 8 行）。
 * 去掉代码块标记、空行与编号，每行补上「- 」。
 */
export function normalizeOrientationNotes(v) {
    if (v === undefined || v === null) return '';
    let lines;
    if (Array.isArray(v)) lines = v.map((x) => (isObj(x) ? Object.values(x).join('：') : String(x ?? '')));
    else if (isObj(v)) lines = Object.entries(v).map(([k, x]) => `${k}：${x}`);
    else lines = String(v).replace(/```[a-z]*\n?|```/gi, '').split(/\r?\n/);
    const out = lines
        .map((l) => String(l).trim().replace(/^(?:[-*•·]|\d+[.、)）])\s*/, '').trim())
        .filter(Boolean)
        .slice(0, 8)
        .map((l) => `- ${l}`);
    return truncate(out.join('\n'), ORIENTATION_LIMITS.notes);
}

/**
 * 从 AI 的回复里取 orientation_notes：JSON 对象的 orientation_notes 字段（也认 notes / 本书落点）；
 * 回复不是 JSON 时取「- 」开头的行。
 */
export function parseOrientationNotes(json, rawText = '') {
    if (isObj(json)) {
        const v = json.orientation_notes ?? json.orientationNotes ?? json.notes ?? json['本书落点'];
        if (v !== undefined) return normalizeOrientationNotes(v);
    }
    if (Array.isArray(json)) return normalizeOrientationNotes(json);
    const lines = String(rawText || '').split(/\r?\n/).filter((l) => /^\s*[-*•]\s*\S/.test(l));
    return normalizeOrientationNotes(lines.join('\n'));
}

/** 世界书「剧情导向」词条的正文：entry，有本书落点时接上【本书落点】 */
export function orientationEntryContent(orientation) {
    const o = normalizeCardOrientation(orientation);
    if (!o) return '';
    const entry = o.entry || `【剧情导向：${o.name}】${o.brief ? `\n${o.brief}` : ''}`;
    return o.notes ? `${entry}\n\n${ORIENTATION_NOTES_HEAD}\n${o.notes}` : entry;
}

/** 词条的标题（备注） */
export function orientationEntryTitle(orientation) {
    const o = normalizeCardOrientation(orientation);
    return o ? `剧情导向：${o.name}` : '';
}

/**
 * 卡片自己的世界书里的「剧情导向」逻辑条目（见 worldbook.js 的条目字段）；没有导向时返回 null。
 * 常驻、@深度（position 4）插入，深度 / 角色 / 顺序取自导向快照；不参与递归。
 */
export function orientationEntry(card) {
    const o = normalizeCardOrientation(card?.orientation);
    if (!o) return null;
    const title = orientationEntryTitle(o);
    return {
        category: '导向', name: title, comment: title, keywords: [], content: orientationEntryContent(o),
        constant: true, position: 4, depth: o.depth, role: o.role, order: o.order, disable: false,
        excludeRecursion: true, preventRecursion: true,
    };
}
