// 创意工坊（card studio）的数据模型：构思草稿的形状、上限与规整、草稿的增删改、步骤与进度、卡上记的本卡世界书条目。
// 一份构思（project.studios 里的一项）从一句创意出发，分四步做成一张世界/旁白卡：
//   1 创意（premise + 选项）→ 2 大纲（世界观 / 地点 / {{user}} 的位置 / 角色阵容 / 故事阶段）
//   → 3 角色与开场白（每个角色的细节、每个阶段的开场白）→ 4 生成卡（见 studio.js 的 buildStudioCard）。
// 草稿跟着项目保存（导出 / 导入任务时一起带上；不进快照）。AI 调用、提示词、卡片组装都在 studio.js（它会把这里的全部导出再导出一次）；
// 这里只放纯数据，只引用 utils.js / orientation.js，project.js 用它规整项目（不会形成循环引用）。
// 安全：所有角色都是成年人——年龄写成未满 18 岁的一律改成 18 岁并记下提示，身份里的学生 / 未成年说法换成成年人的，
// 立绘提示词去掉未成年的标签、补上 adult。不碰 DOM、不调用 AI。

import { normalizeOrientationNotes } from './orientation.js';
import { chineseNumToInt, uid, uniq } from './utils.js';

/** 创意工坊做出来的卡：card.source（同时也算原创卡，见 original.js 的 isOriginalCard） */
export const STUDIO_SOURCE = 'studio';

/** 每个项目最多几份构思、各项的个数与字数上限 */
export const STUDIO_LIMITS = Object.freeze({
    drafts: 50,
    title: 40,
    premise: 3000,
    extra: 1000,
    userRoleText: 1000,
    openerLen: 20,
    orientationName: 20,
    orientationBrief: 200,
    cast: 12,
    stages: 8,
    locations: 12,
    name: 20,
    aliases: 4,
    alias: 12,
    gender: 10,
    age: 20,
    identity: 60,
    oneLiner: 200,
    tags: 6,
    tag: 12,
    logline: 300,
    setting: 3000,
    rules: 2000,
    tone: 300,
    locationName: 30,
    locationDesc: 600,
    userRole: 1000,
    stageName: 30,
    stageTime: 40,
    stageSummary: 1000,
    stageConflict: 600,
    appearance: 1000,
    outfit: 600,
    personality: 1500,
    speech: 600,
    sampleLines: 6,
    sampleLine: 200,
    background: 1500,
    relationToUser: 800,
    affection: 6,
    affectionLabel: 12,
    affectionBehavior: 500,
    secretContent: 800,
    secretHints: 800,
    secretReveal: 400,
    portraitPrompt: 800,
    opener: 8000,
    example: 6000,
    error: 300,
});

/** 人数（count）与阶段数（stages）的取值范围；'' = 让 AI 按创意决定 */
export const STUDIO_COUNT_RANGE = Object.freeze({ min: 1, max: STUDIO_LIMITS.cast });
export const STUDIO_STAGE_RANGE = Object.freeze({ min: 2, max: STUDIO_LIMITS.stages });

export const STUDIO_STEPS = Object.freeze([
    { value: 1, label: '创意' },
    { value: 2, label: '大纲' },
    { value: 3, label: '角色与开场白' },
    { value: 4, label: '生成卡' },
]);

/** 开场白长度的常用选项（也可以自由填写） */
export const STUDIO_OPENER_LENS = Object.freeze(['200-400 字', '400-800 字', '800-1200 字']);
export const STUDIO_DEFAULT_OPENER_LEN = '400-800 字';
/** 构思默认的状态栏模板：「多人群像」（为整个群像设计，主要角色按名字记） */
export const STUDIO_STATUSBAR_TEMPLATE = 'builtin_ensemble';
/** 没起名字的构思 */
export const STUDIO_UNTITLED = '未命名构思';

/**
 * 每个角色的细节字段：key = 草稿里的字段名，json = AI 输出 JSON 里的字段名，label = 界面与提示词里的名字。
 * 立绘提示词只给 AI 绘图用，不写进世界书。
 */
export const STUDIO_DETAIL_FIELDS = Object.freeze([
    { key: 'appearance', json: 'appearance', label: '外貌' },
    { key: 'outfit', json: 'outfit', label: '穿着' },
    { key: 'personality', json: 'personality', label: '性格' },
    { key: 'speech', json: 'speech', label: '说话方式' },
    { key: 'sampleLines', json: 'sample_lines', label: '示例台词' },
    { key: 'background', json: 'background', label: '背景经历' },
    { key: 'relationToUser', json: 'relation_to_user', label: '与 {{user}} 的关系' },
    { key: 'affection', json: 'affection', label: '好感变化' },
    { key: 'secret', json: 'secret', label: '秘密与隐藏剧情' },
    { key: 'portraitPrompt', json: 'portrait_prompt', label: '立绘提示词' },
].map((f) => Object.freeze(f)));

export function studioDetailField(key) {
    return STUDIO_DETAIL_FIELDS.find((f) => f.key === key || f.json === key) || null;
}

function isObj(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function cleanText(v, max) {
    return String(v ?? '').replace(/\r\n?/g, '\n').trim().slice(0, max);
}

function oneLine(v, max) {
    return String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

/** 取第一个有值的字段（AI 的字段名不统一：snake_case / camelCase / 中文都认） */
export function pickKey(obj, keys) {
    if (!isObj(obj)) return undefined;
    for (const k of keys) if (obj[k] !== undefined && obj[k] !== null && obj[k] !== '') return obj[k];
    return undefined;
}

/** 任意值 → 文字：数组一项一行，对象「键: 值」一行一项 */
export function textOf(v, max = 4000) {
    if (v === undefined || v === null) return '';
    if (Array.isArray(v)) return cleanText(v.map((x) => textOf(x, max)).filter(Boolean).join('\n'), max);
    if (isObj(v)) return cleanText(Object.entries(v).map(([k, x]) => `${k}: ${textOf(x, max)}`).join('\n'), max);
    return cleanText(v, max);
}

function listOf(v, { count, max }) {
    const arr = Array.isArray(v) ? v : typeof v === 'string' ? v.split(/[\n,，、;；]+/) : [];
    return uniq(arr.map((x) => oneLine(isObj(x) ? Object.values(x).join(' ') : x, max).replace(/^#/, ''))).slice(0, count);
}

function intIn(v, { min, max }) {
    if (v === '' || v === null || v === undefined || typeof v === 'boolean') return '';
    const n = Math.round(Number(String(v).replace(/[^\d.-]/g, '')));
    if (!Number.isFinite(n)) return '';
    return Math.min(max, Math.max(min, n));
}

// ---------------- 成年人 ----------------

/**
 * 年龄里指未成年人的说法：出现就按未成年处理（同时写了成年的数字时留下那个数字，「1500 岁，外表像初中生」→ 1500 岁）。
 * 也认古称（及笄、豆蔻、垂髫、总角、束发）；「幼儿园老师」不算。
 */
const MINOR_AGE_WORDS = /未成年|儿童|幼女|幼童|幼(?!儿园老师)|稚龄|小学|初中|高中|中学|国中|(?:高|初|国)[一二三]|萝莉|正太|少女|少年|青春期|孩子|小孩|及笄|豆蔻|垂髫|总角|束发|\bJK\b|\bteen|\bminor\b|\bchild/i;
/** 年龄里明确是成年人的说法 */
const ADULT_AGE_WORDS = /(?<!未)成年|成人|\badult\b/i;
/** 「未满 18」「18 岁以下」这类上限说法：数字不超过 20 时也按未成年处理 */
const AGE_UPPER_WORDS = /未满|不满|不到|以下|之下|\bunder\b|\bbelow\b/i;
/**
 * 身份 / 一句话里换成成年人说法的词（标签里出现时整个标签去掉）。
 * 「高中老师」「中学教师」「幼儿园老师」这类成年人的身份不动；「高中生物老师」「高中生活」「身高一米七」不算。
 */
const NOT_STUDENT = '(?![物理化态活涯命意产])';
const MINOR_IDENTITY_SWAPS = [
    [new RegExp(`(?:女子?|男)?(?:小学|国小|初中|国中|高中|中学)(?:女|男)?(?:学)?生${NOT_STUDENT}`, 'g'), '大学生'],
    [new RegExp(`(?:高|初|国)[一二三](?:新|学)?生${NOT_STUDENT}`, 'g'), '大学生'],
    [/女子(?:中学|高)生/g, '大学生'],
    [/(?:小学|国小|初中|国中|高中|中学)(?:女孩|男孩|少女|少年)/g, '大学生'],
    [/未成年/g, '成年'],
    [/(?:萝莉|正太)控/g, ''],
    [/(?:合法|小)?萝莉|正太/g, '娇小的成年人'],
    [/\bJK制服/gi, '制服'],
    [/\bJK\b/gi, ''],
];

const CN_NUM_RUN = /[零〇一二两三四五六七八九十百千万]+/g;
const CN_NUM_HEAD = /^(?:[一二两三四五六七八九]?万)?(?:[一二两三四五六七八九]?千)?(?:[一二两三四五六七八九]?百)?[零〇]?(?:[一二两三四五六七八九]?十)?[一二两三四五六七八九]?/;

/**
 * 年龄文字里出现的全部数字，按出现的先后（阿拉伯数字和中文数字：「二十出头」→ 20，「三千岁」→ 3000）。
 * 「十七八岁」「二十七八」这类约数取前面的数（17、27）；单独一个「一」「两」（后面不是「岁」）不算数字。
 * @returns {number[]}
 */
export function ageNumbers(text) {
    const s = String(text ?? '').replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xfee0));
    const out = [];
    for (const m of s.matchAll(/\d{1,5}/g)) out.push({ n: Number(m[0]), at: m.index });
    for (const m of s.matchAll(CN_NUM_RUN)) {
        const run = m[0];
        if (run.length < 2 && !/[十百千万]/.test(run) && !/^\s*(?:周岁|岁|歲)/.test(s.slice(m.index + 1))) continue;
        const head = run.match(CN_NUM_HEAD)[0] || run;
        const n = head === '万' ? 10000 : chineseNumToInt(head);
        if (Number.isFinite(n)) out.push({ n, at: m.index });
    }
    return out.sort((a, b) => a.at - b.at).map((x) => x.n);
}

/** 年龄文字里的第一个数字；没有时为 null（见 ageNumbers） */
export function ageNumber(text) {
    const list = ageNumbers(text);
    return list.length ? list[0] : null;
}

/**
 * 判断一段年龄文字是不是写成了未成年：任何一个数字小于 18（「1500 岁，外表 12 岁」）、「未满 18」这类上限说法、
 * 或者出现未成年的说法（少女、初中生、萝莉、及笄……，即使同时写了成年的数字）。
 * 是的话只留下成年的部分：最大的那个 18 以上的数字（「1500 岁」），没有时写明成年的留「成年」，否则「18 岁」。
 * @returns {{minor: boolean, text: string}}
 */
function ageVerdict(s) {
    const nums = ageNumbers(s);
    const adultNums = nums.filter((n) => n >= 18);
    if (nums.some((n) => n <= 20) && AGE_UPPER_WORDS.test(s)) {
        const big = nums.filter((n) => n > 20);
        return { minor: true, text: big.length ? `${Math.max(...big)} 岁` : '18 岁' };
    }
    if (nums.some((n) => n < 18) || MINOR_AGE_WORDS.test(s)) {
        return { minor: true, text: adultNums.length ? `${Math.max(...adultNums)} 岁` : ADULT_AGE_WORDS.test(s) ? '成年' : '18 岁' };
    }
    return { minor: false, text: s };
}

/**
 * 规整年龄：写成未成年的（见 ageVerdict）只留下成年的部分（通常是「18 岁」），并在 warnings 里记一句；
 * 只写了数字的补上「岁」；空着时保持空（用到时按「成年」写，见 castAgeText）。
 * @param {string} raw
 * @param {{name?: string, warnings?: string[]}} opt
 */
export function adultAge(raw, { name = '', warnings = null } = {}) {
    const s = oneLine(raw, STUDIO_LIMITS.age);
    if (!s) return '';
    const v = ageVerdict(s);
    if (v.minor) {
        const who = name ? `「${name}」` : '角色';
        warnings?.push(`${who}的年龄写成了「${s}」，已改成${/\d/.test(v.text) ? ` ${v.text}` : `「${v.text}」`}（所有角色都是成年人）`);
        return v.text;
    }
    if (/^\d{1,5}$/.test(s)) return `${s} 岁`;
    return s;
}

/**
 * 提示词和卡片里用的年龄：没写时是「成年」；写成未成年的按 adultAge 的规则只留成年的部分（旧版本存下的数据也一样）；
 * 没写数字、也没写明成年的（「年龄不详」）、只写了上限的（「30 岁以下」：没说下限）前面加上「成年」，让每个角色的年龄都写明是成年人。
 */
export function castAgeText(member) {
    const s = oneLine(member?.age, STUDIO_LIMITS.age);
    if (!s) return '成年';
    const t = ageVerdict(s).text;
    if (ADULT_AGE_WORDS.test(t)) return t;
    if (ageNumbers(t).some((n) => n >= 18) && !AGE_UPPER_WORDS.test(t)) return t;
    return `成年（${t}）`;
}

/** 身份 / 一句话里的学生、未成年说法换成成年人的（换了时在 warnings 里记一句） */
export function adultText(text, { name = '', field = '身份', warnings = null } = {}) {
    let out = String(text ?? '');
    const before = out;
    for (const [re, to] of MINOR_IDENTITY_SWAPS) out = out.replace(re, to);
    out = out.replace(/\s{2,}/g, ' ').trim();
    if (out !== before.trim()) warnings?.push(`${name ? `「${name}」` : '角色'}的${field}里有未成年的说法，已改成成年人的（所有角色都是成年人）`);
    return out;
}

/** 标签：带未成年说法的整个去掉（「高中女生」「JK」不改写成别的标签），去掉时在 warnings 里记一句 */
function adultTags(list, { name = '', warnings = null } = {}) {
    const out = [];
    for (const t of list) {
        const w = [];
        const x = adultText(t, { name, field: '标签', warnings: w });
        if (w.length) {
            warnings?.push(`${name ? `「${name}」` : '角色'}的标签「${t}」是未成年的说法，已去掉（所有角色都是成年人）`);
            continue;
        }
        if (x) out.push(x);
    }
    return uniq(out);
}

/** 立绘提示词里不能出现的标签（未成年、儿童化；「aged 12」「15-year-old」「seventeen years old」「high school」都算，「aged 25」「middle-aged」不算） */
const MINOR_TAG_RE = new RegExp([
    '\\b(?:loli(?:ta)?|shota|child(?:ren|ish|like)?|child-like|kids?|toddler|infant|baby|underaged?|minor|aged? down|age regression|preteen|teen(?:s|age|ager)?',
    '|young girl|little (?:girl|boy)|school ?(?:girl|boy|uniform)|elementary|middle school|high school|jk',
    '|(?:1[0-7]|[1-9])\\s*(?:years?[ -]old|yo|y\\/o)|(?:1[0-7]|[1-9])\\s*-?\\s*(?:years?|yrs?)[ -]?old|aged?\\s*(?:1[0-7]|[1-9])',
    '|(?:thir|four|fif|six|seven)teen[ -]years?[ -]old|adolescen(?:t|ce)|juvenile|pubescent|high ?school(?:er)?|junior ?high|schoolchild|randoseru)\\b',
].join(''), 'i');
const ADULT_TAG_RE = /\b(?:adult|mature|grown|(?:[2-9]\d|1[89])\s*-?\s*(?:years?|yrs?)[ -]?old|(?:[2-9]\d|1[89])\s*(?:yo|y\/o)|(?:early|mid|late)[ -]?[2-9]0s)\b/i;
/** 中日韩文字：提示词要求只写英文标签，带这些文字的标签（「少女」「校服」）去掉 */
const CJK_RE = /[぀-ヿ㐀-鿿豈-﫿가-힯]/;

/**
 * 规整立绘提示词：逗号分隔的英文标签，去掉未成年 / 儿童化的标签、带中文的标签和角色的名字，没有成年标签时在最前面补上 adult。
 * 照抄了模板占位（「adult woman|adult man」）的改成 adult。
 * @param {string|string[]} raw
 * @param {{names?: string[]}} opt names：这个角色的名字和别名（不写进提示词）
 */
export function normalizePortraitPrompt(raw, { names = [] } = {}) {
    const src = Array.isArray(raw) ? raw.join(',') : String(raw ?? '');
    const banned = names.map((n) => String(n || '').trim()).filter(Boolean);
    const tags = uniq(src.replace(/```[a-z]*|```/gi, '').split(/[,，\n]+/)
        .map((t) => t.replace(/\s+/g, ' ').trim().replace(/^adult (?:woman|man)\s*\|\s*adult (?:woman|man)$/i, 'adult')))
        .filter((t) => t && !MINOR_TAG_RE.test(t) && !CJK_RE.test(t) && !banned.some((n) => t.includes(n)));
    if (!tags.length) return '';
    if (!tags.some((t) => ADULT_TAG_RE.test(t))) tags.unshift('adult');
    let out = '';
    for (const t of tags) {
        const next = out ? `${out}, ${t}` : t;
        if (next.length > STUDIO_LIMITS.portraitPrompt) break;
        out = next;
    }
    return out;
}

// ---------------- 大纲 ----------------

/**
 * 规整一个角色（大纲里的一行）；不是对象时返回 null。名字可以是空的（大纲页刚加的空行），AI 的结果另外丢掉没名字的。
 * @param {object} raw 也认 AI 的字段名：one_liner / 一句话 / 身份 / 年龄…
 * @param {{warnings?: string[]}} opt 年龄改成 18 岁、身份换掉未成年说法时记一句
 * @returns {{id, name, aliases, gender, age, identity, oneLiner, tags, locked}|null}
 */
export function normalizeCastMember(raw, { warnings = null } = {}) {
    if (!isObj(raw)) return null;
    const name = oneLine(pickKey(raw, ['name', '名字', '姓名', '名称']), STUDIO_LIMITS.name);
    const tags = adultTags(listOf(pickKey(raw, ['tags', '标签']), { count: STUDIO_LIMITS.tags, max: STUDIO_LIMITS.tag }), { name, warnings });
    return {
        id: typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim().slice(0, 60) : uid('sc_'),
        name,
        aliases: listOf(pickKey(raw, ['aliases', '别名', '昵称']), { count: STUDIO_LIMITS.aliases, max: STUDIO_LIMITS.alias }).filter((a) => a !== name),
        gender: oneLine(pickKey(raw, ['gender', '性别']), STUDIO_LIMITS.gender),
        age: adultAge(pickKey(raw, ['age', '年龄']), { name, warnings }),
        identity: adultText(oneLine(pickKey(raw, ['identity', '身份', '职业']), STUDIO_LIMITS.identity), { name, warnings }),
        oneLiner: adultText(oneLine(pickKey(raw, ['oneLiner', 'one_liner', 'oneliner', 'summary', '一句话', '人设', '简介']), STUDIO_LIMITS.oneLiner), { name, field: '一句话人设', warnings }),
        tags,
        locked: raw.locked === true,
    };
}

/** 规整一个故事阶段；不是对象时返回 null */
export function normalizeStage(raw) {
    if (!isObj(raw)) return null;
    return {
        id: typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim().slice(0, 60) : uid('ss_'),
        name: oneLine(pickKey(raw, ['name', '名称', '阶段', 'title']), STUDIO_LIMITS.stageName),
        time: oneLine(pickKey(raw, ['time', '时间', 'when']), STUDIO_LIMITS.stageTime),
        summary: textOf(pickKey(raw, ['summary', '概要', '处境', 'situation', 'desc']), STUDIO_LIMITS.stageSummary),
        conflict: textOf(pickKey(raw, ['conflict', '冲突', '核心冲突', '悬念']), STUDIO_LIMITS.stageConflict),
    };
}

/** 规整一个地点；不是对象（或字符串）时返回 null。名字和说明都空着的也留着（大纲页刚加的空行），用到时跳过没名字的 */
export function normalizeLocation(raw) {
    const r = typeof raw === 'string' ? { name: raw } : raw;
    if (!isObj(r)) return null;
    const name = oneLine(pickKey(r, ['name', '名称', '地点']), STUDIO_LIMITS.locationName);
    const desc = textOf(pickKey(r, ['desc', 'description', 'content', '说明', '描述']), STUDIO_LIMITS.locationDesc);
    return { name, desc };
}

/** 空大纲 */
export function emptyOutline() {
    return { title: '', logline: '', world: { setting: '', rules: '', tone: '', locations: [] }, userRole: '', cast: [], stages: [], orientationNotes: '' };
}

/**
 * 规整大纲：各项按上限截断；角色最多 12 个、阶段最多 8 个、地点最多 12 个，id 重复的重新编号。
 * @param {object} raw
 * @param {{warnings?: string[]}} opt
 */
export function normalizeOutline(raw, { warnings = null } = {}) {
    const r = isObj(raw) ? raw : {};
    const w = isObj(r.world) ? r.world : {};
    const ids = new Set();
    const freshId = (item, prefix) => {
        if (ids.has(item.id)) item.id = uid(prefix);
        ids.add(item.id);
        return item;
    };
    const locations = [];
    for (const l of Array.isArray(w.locations) ? w.locations : []) {
        const x = normalizeLocation(l);
        if (x && !locations.some((y) => y.name && y.name === x.name)) locations.push(x);
        if (locations.length >= STUDIO_LIMITS.locations) break;
    }
    return {
        title: oneLine(r.title, STUDIO_LIMITS.title),
        logline: oneLine(r.logline, STUDIO_LIMITS.logline),
        world: {
            setting: textOf(w.setting, STUDIO_LIMITS.setting),
            rules: textOf(w.rules, STUDIO_LIMITS.rules),
            tone: oneLine(textOf(w.tone, STUDIO_LIMITS.tone), STUDIO_LIMITS.tone),
            locations,
        },
        userRole: textOf(r.userRole, STUDIO_LIMITS.userRole),
        cast: (Array.isArray(r.cast) ? r.cast : []).map((c) => normalizeCastMember(c, { warnings })).filter(Boolean).slice(0, STUDIO_LIMITS.cast).map((c) => freshId(c, 'sc_')),
        stages: (Array.isArray(r.stages) ? r.stages : []).map(normalizeStage).filter(Boolean).slice(0, STUDIO_LIMITS.stages).map((s) => freshId(s, 'ss_')),
        orientationNotes: normalizeOrientationNotes(r.orientationNotes || ''),
    };
}

// ---------------- 角色细节 ----------------

function stripQuotes(s) {
    return String(s ?? '').replace(/^[-*•\s]+/, '').replace(/^[“"「『]+|[”"」』]+$/g, '').trim();
}

/**
 * 好感变化：[{level, label, behavior}]，也认 {戒备: '……'} 和「戒备：……」一行一级；level 按顺序重新编号。
 * 数组里名称和表现都空着的一级也留着（角色页刚加的空行），写进提示词和世界书时跳过。
 */
export function normalizeAffection(raw) {
    let items = [];
    if (Array.isArray(raw)) items = raw;
    else if (isObj(raw)) items = Object.entries(raw).map(([label, behavior]) => ({ label, behavior }));
    else if (typeof raw === 'string') items = raw.split(/\n+/).filter((l) => l.trim());
    const out = [];
    for (const it of items) {
        let label = '';
        let behavior = '';
        if (isObj(it)) {
            label = oneLine(pickKey(it, ['label', 'name', '阶段', '名称', 'stage']), STUDIO_LIMITS.affectionLabel);
            behavior = textOf(pickKey(it, ['behavior', 'behaviour', 'desc', '表现', '行为', 'content']), STUDIO_LIMITS.affectionBehavior);
            if (Array.isArray(raw) && !label && !behavior) {
                out.push({ level: out.length + 1, label: '', behavior: '' });
                if (out.length >= STUDIO_LIMITS.affection) break;
                continue;
            }
        } else {
            const m = String(it).replace(/^[-*•\s]*(?:\d+[.、)）]\s*)?/, '').match(/^([^:：]{1,12})[:：]\s*([\s\S]+)$/);
            if (m) {
                label = oneLine(m[1], STUDIO_LIMITS.affectionLabel);
                behavior = cleanText(m[2], STUDIO_LIMITS.affectionBehavior);
            } else behavior = cleanText(it, STUDIO_LIMITS.affectionBehavior);
        }
        if (!label && !behavior) continue;
        out.push({ level: out.length + 1, label, behavior });
        if (out.length >= STUDIO_LIMITS.affection) break;
    }
    return out;
}

/** 秘密：{content, hints, reveal}，也认中文字段名；只给一段文字时当作 content */
export function normalizeSecret(raw) {
    if (typeof raw === 'string') return { content: cleanText(raw, STUDIO_LIMITS.secretContent), hints: '', reveal: '' };
    const r = isObj(raw) ? raw : {};
    return {
        content: textOf(pickKey(r, ['content', 'secret', '秘密', '内容']), STUDIO_LIMITS.secretContent),
        hints: textOf(pickKey(r, ['hints', 'hint', 'clues', '线索', '暗示', '蛛丝马迹']), STUDIO_LIMITS.secretHints),
        reveal: textOf(pickKey(r, ['reveal', 'trigger', 'condition', '揭露条件', '揭露', '触发条件', '条件']), STUDIO_LIMITS.secretReveal),
    };
}

export function normalizeSampleLines(raw) {
    const arr = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(/\n+/) : [];
    return uniq(arr.map((x) => oneLine(stripQuotes(isObj(x) ? Object.values(x).join(' ') : x), STUDIO_LIMITS.sampleLine))).slice(0, STUDIO_LIMITS.sampleLines);
}

/** 空的角色细节 */
export function emptyDetails() {
    return {
        appearance: '', outfit: '', personality: '', speech: '', sampleLines: [], background: '', relationToUser: '',
        affection: [], secret: { content: '', hints: '', reveal: '' }, portraitPrompt: '', updatedAt: 0, generatedAt: 0,
    };
}

/**
 * 规整一个角色的细节（草稿里存的，或 AI 返回的：snake_case / 中文字段名都认）。
 * @param {object} raw
 * @param {{names?: string[]}} opt names：这个角色的名字和别名（立绘提示词里去掉）
 */
export function normalizeDetails(raw, { names = [] } = {}) {
    const r = isObj(raw) ? raw : {};
    const L = STUDIO_LIMITS;
    return {
        appearance: textOf(pickKey(r, ['appearance', '外貌']), L.appearance),
        outfit: textOf(pickKey(r, ['outfit', 'clothing', '穿着', '服装', '着装']), L.outfit),
        personality: textOf(pickKey(r, ['personality', '性格']), L.personality),
        speech: textOf(pickKey(r, ['speech', 'speaking', '说话方式', '口癖']), L.speech),
        sampleLines: normalizeSampleLines(pickKey(r, ['sampleLines', 'sample_lines', 'lines', 'quotes', '示例台词', '台词'])),
        background: textOf(pickKey(r, ['background', 'backstory', '背景', '背景经历', '经历']), L.background),
        relationToUser: textOf(pickKey(r, ['relationToUser', 'relation_to_user', 'relationship', '与{{user}}的关系', '关系']), L.relationToUser),
        affection: normalizeAffection(pickKey(r, ['affection', 'affection_levels', '好感', '好感变化'])),
        secret: normalizeSecret(pickKey(r, ['secret', '秘密', '隐藏剧情']) ?? {}),
        portraitPrompt: normalizePortraitPrompt(pickKey(r, ['portraitPrompt', 'portrait_prompt', 'portrait', '立绘提示词']) ?? '', { names }),
        updatedAt: Number.isFinite(r.updatedAt) ? r.updatedAt : 0,
        // 整个角色由 AI 展开（或补全）过的时间；只重写一项、手动填写不算（见 studioCastStatus）
        generatedAt: Number.isFinite(r.generatedAt) ? r.generatedAt : 0,
    };
}

/** 角色的核心细节：外貌 / 性格 / 说话方式 / 背景 */
const CORE_DETAILS = ['appearance', 'personality', 'speech', 'background'];

/** 细节写了没有（核心细节中的任何一项有内容就算） */
export function detailsFilled(d) {
    return !!d && CORE_DETAILS.some((k) => String(d[k] || '').trim());
}

/** 核心细节都写了（手动填全的角色也算展开完了） */
export function detailsComplete(d) {
    return !!d && CORE_DETAILS.every((k) => String(d[k] || '').trim());
}

// ---------------- 构思草稿 ----------------

/** 构思的选项（新建时的默认值来自设置 settings.studio） */
export function defaultStudioOptions(settings = null) {
    const g = isObj(settings?.studio) ? settings.studio : {};
    return {
        count: '',
        stages: '',
        profileId: '',
        orientationId: '',
        orientationName: '',
        orientationBrief: '',
        userRole: { kind: 'new', text: '' },
        extra: '',
        openerLen: oneLine(g.openerLen, STUDIO_LIMITS.openerLen) || STUDIO_DEFAULT_OPENER_LEN,
        statusBar: g.statusBar !== false,
        examples: g.examples !== false,
    };
}

/** 规整构思的选项；userRole 只有原创新身份（new）和自定义（custom，要写内容） */
export function normalizeStudioOptions(raw, settings = null) {
    const r = isObj(raw) ? raw : {};
    const d = defaultStudioOptions(settings);
    const role = isObj(r.userRole) ? r.userRole : {};
    const roleText = cleanText(role.text, STUDIO_LIMITS.userRoleText);
    return {
        count: intIn(r.count, STUDIO_COUNT_RANGE),
        stages: intIn(r.stages, STUDIO_STAGE_RANGE),
        profileId: oneLine(r.profileId, 80),
        orientationId: oneLine(r.orientationId, 80),
        orientationName: oneLine(r.orientationName, STUDIO_LIMITS.orientationName),
        orientationBrief: cleanText(r.orientationBrief, STUDIO_LIMITS.orientationBrief),
        // 选了自定义还没写内容时保持 custom（界面上的选项不跳回去）；写卡时 normalizeUserRole 会把空的自定义当作原创新身份
        userRole: role.kind === 'custom' ? { kind: 'custom', text: roleText } : { kind: 'new', text: '' },
        extra: cleanText(r.extra, STUDIO_LIMITS.extra),
        openerLen: oneLine(r.openerLen, STUDIO_LIMITS.openerLen) || d.openerLen,
        statusBar: typeof r.statusBar === 'boolean' ? r.statusBar : d.statusBar,
        examples: typeof r.examples === 'boolean' ? r.examples : d.examples,
    };
}

/**
 * 规整一份构思（存进项目的草稿）。细节 / 开场白 / 出错记录只留还在大纲里的角色和阶段。
 * @returns {object|null} 不是对象时返回 null
 */
export function normalizeStudio(raw, settings = null) {
    if (!isObj(raw)) return null;
    const outline = normalizeOutline(raw.outline);
    const castIds = new Set(outline.cast.map((c) => c.id));
    const stageIds = new Set(outline.stages.map((s) => s.id));
    const details = {};
    for (const [id, d] of Object.entries(isObj(raw.details) ? raw.details : {})) {
        const m = outline.cast.find((c) => c.id === id);
        if (m) details[id] = normalizeDetails(d, { names: [m.name, ...m.aliases] });
    }
    const openers = {};
    for (const [id, t] of Object.entries(isObj(raw.openers) ? raw.openers : {})) {
        const text = cleanText(t, STUDIO_LIMITS.opener);
        if (stageIds.has(id) && text) openers[id] = text;
    }
    const errors = {};
    for (const [id, e] of Object.entries(isObj(raw.errors) ? raw.errors : {})) {
        const text = oneLine(e, STUDIO_LIMITS.error);
        if (text && (castIds.has(id) || stageIds.has(id) || id === 'example')) errors[id] = text;
    }
    const step = Math.round(Number(raw.step));
    const now = Date.now();
    return {
        id: typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim().slice(0, 60) : uid('studio_'),
        title: oneLine(raw.title, STUDIO_LIMITS.title),
        premise: cleanText(raw.premise, STUDIO_LIMITS.premise),
        step: step >= 1 && step <= 4 ? step : 1,
        options: normalizeStudioOptions(raw.options, settings),
        outline,
        details,
        openers,
        example: cleanText(raw.example, STUDIO_LIMITS.example),
        errors,
        cardId: oneLine(raw.cardId, 80),
        createdAt: Number.isFinite(raw.createdAt) ? raw.createdAt : now,
        updatedAt: Number.isFinite(raw.updatedAt) ? raw.updatedAt : now,
    };
}

/** 规整项目里的构思列表（project.studios）：跳过不合法的项与重复 id，最多 STUDIO_LIMITS.drafts 份 */
export function normalizeStudios(list, settings = null) {
    const out = [];
    const seen = new Set();
    for (const raw of Array.isArray(list) ? list : []) {
        const s = normalizeStudio(raw, settings);
        if (!s || seen.has(s.id)) continue;
        seen.add(s.id);
        out.push(s);
        if (out.length >= STUDIO_LIMITS.drafts) break;
    }
    return out;
}

/** 新的空构思（不放进项目）；init 里可以带 title / premise / options */
export function createStudio(settings = null, init = {}) {
    const now = Date.now();
    return normalizeStudio({ ...(isObj(init) ? init : {}), id: uid('studio_'), step: 1, createdAt: now, updatedAt: now }, settings);
}

export function listStudios(project) {
    return Array.isArray(project?.studios) ? project.studios : [];
}

export function getStudio(project, id) {
    return listStudios(project).find((s) => s.id === id) || null;
}

/**
 * 在项目里新建一份构思（放在最前面）；用户画像默认选设置里的默认画像。满了（50 份）时抛错。
 * @param {object} project
 * @param {object} settings
 * @param {{title?: string, premise?: string, options?: object}} init
 */
export function addStudio(project, settings, init = {}) {
    if (!Array.isArray(project.studios)) project.studios = [];
    if (project.studios.length >= STUDIO_LIMITS.drafts) throw new Error(`每个项目最多 ${STUDIO_LIMITS.drafts} 份构思，请先删掉不要的`);
    const defProfile = (Array.isArray(settings?.userProfiles) ? settings.userProfiles : []).find((p) => isObj(p) && p.isDefault === true && p.id);
    const options = { ...(defProfile ? { profileId: String(defProfile.id) } : {}), ...(isObj(init.options) ? init.options : {}) };
    const s = createStudio(settings, { ...init, options });
    project.studios.unshift(s);
    return s;
}

export function removeStudio(project, id) {
    const list = listStudios(project);
    const i = list.findIndex((s) => s.id === id);
    if (i < 0) return false;
    list.splice(i, 1);
    return true;
}

export function renameStudio(project, id, title) {
    const s = getStudio(project, id);
    if (!s) return null;
    s.title = oneLine(title, STUDIO_LIMITS.title);
    s.updatedAt = Date.now();
    return s;
}

/**
 * 改一份构思（界面里的编辑自动保存时用）：title / premise / step / example 直接替换；options、outline（含 world）按字段合并；
 * details 按角色合并（{castId: {字段: 值}}），openers 按阶段替换。改完整份重新规整（就地修改同一个对象）。
 * @returns {object|null} 改好的构思；找不到时 null
 */
export function updateStudio(project, id, patch = {}) {
    const s = getStudio(project, id);
    if (!s || !isObj(patch)) return s;
    const next = { ...s };
    for (const k of ['title', 'premise', 'step', 'example', 'cardId']) if (patch[k] !== undefined) next[k] = patch[k];
    if (isObj(patch.options)) next.options = { ...s.options, ...patch.options, ...(isObj(patch.options.userRole) ? { userRole: { ...s.options.userRole, ...patch.options.userRole } } : {}) };
    if (isObj(patch.outline)) {
        next.outline = { ...s.outline, ...patch.outline };
        if (isObj(patch.outline.world)) next.outline.world = { ...s.outline.world, ...patch.outline.world };
    }
    if (isObj(patch.details)) {
        next.details = { ...s.details };
        for (const [cid, d] of Object.entries(patch.details)) next.details[cid] = isObj(d) ? { ...(s.details[cid] || emptyDetails()), ...d, updatedAt: Date.now() } : d;
    }
    if (isObj(patch.openers)) next.openers = { ...s.openers, ...patch.openers };
    const n = normalizeStudio({ ...next, updatedAt: Date.now() });
    for (const k of Object.keys(s)) delete s[k];
    Object.assign(s, n);
    return s;
}

function touch(studio) {
    studio.updatedAt = Date.now();
}

/** 删掉不在大纲里的角色细节、开场白和出错记录（改了阵容 / 阶段之后） */
export function pruneStudio(studio) {
    const castIds = new Set(studio.outline.cast.map((c) => c.id));
    const stageIds = new Set(studio.outline.stages.map((s) => s.id));
    let details = 0;
    let openers = 0;
    for (const id of Object.keys(studio.details || {})) {
        if (castIds.has(id)) continue;
        if (detailsFilled(studio.details[id])) details++;
        delete studio.details[id];
    }
    for (const id of Object.keys(studio.openers || {})) {
        if (stageIds.has(id)) continue;
        if (String(studio.openers[id] || '').trim()) openers++;
        delete studio.openers[id];
    }
    for (const id of Object.keys(studio.errors || {})) if (!castIds.has(id) && !stageIds.has(id) && id !== 'example') delete studio.errors[id];
    return { details, openers };
}

// ---- 大纲页的增删（就地修改；成功时更新 updatedAt） ----

/** 加一个角色（满 12 个时返回 null） */
export function studioAddCast(studio, init = {}) {
    if (studio.outline.cast.length >= STUDIO_LIMITS.cast) return null;
    const m = normalizeCastMember({ ...(isObj(init) ? init : {}), id: uid('sc_') });
    studio.outline.cast.push(m);
    touch(studio);
    return m;
}

export function studioRemoveCast(studio, castId) {
    const i = studio.outline.cast.findIndex((c) => c.id === castId);
    if (i < 0) return false;
    studio.outline.cast.splice(i, 1);
    delete studio.details[castId];
    delete studio.errors[castId];
    touch(studio);
    return true;
}

export function studioSetLocked(studio, castId, locked) {
    const m = studio.outline.cast.find((c) => c.id === castId);
    if (!m) return false;
    m.locked = !!locked;
    touch(studio);
    return true;
}

/**
 * 大纲表格里给一个角色改名（同一个人）时的补丁（给 updateStudio 的 outline）：角色的名字，以及导向落点、阶段的处境和冲突里
 * 写着旧名字的地方跟着改（旧名字只有一个字时不替换，免得误伤别的词）。
 * @returns {{patch: object, where: string[]}} where：跟着改了的地方（导向落点 / 故事阶段）
 */
export function studioRenameCastPatch(studio, castId, newName) {
    const o = studio.outline;
    const m = o.cast.find((c) => c.id === castId);
    const name = String(newName ?? '').trim();
    const patch = { cast: o.cast.map((c) => (c.id === castId ? { ...c, name } : c)) };
    const where = [];
    const old = m?.name || '';
    if (!m || !name || !old || old === name || old.length < 2) return { patch, where };
    const swap = (t) => String(t || '').split(old).join(name);
    if (String(o.orientationNotes || '').includes(old)) {
        patch.orientationNotes = swap(o.orientationNotes);
        where.push('导向落点');
    }
    if (o.stages.some((x) => `${x.summary}\n${x.conflict}`.includes(old))) {
        patch.stages = o.stages.map((x) => ({ ...x, summary: swap(x.summary), conflict: swap(x.conflict) }));
        where.push('故事阶段');
    }
    return { patch, where };
}

/** 加一个阶段（index 不给时加在最后；满 8 个时返回 null） */
export function studioAddStage(studio, init = {}, index = null) {
    if (studio.outline.stages.length >= STUDIO_LIMITS.stages) return null;
    const s = normalizeStage({ ...(isObj(init) ? init : {}), id: uid('ss_') });
    const i = Number.isInteger(index) ? Math.max(0, Math.min(studio.outline.stages.length, index)) : studio.outline.stages.length;
    studio.outline.stages.splice(i, 0, s);
    touch(studio);
    return s;
}

export function studioRemoveStage(studio, stageId) {
    const i = studio.outline.stages.findIndex((s) => s.id === stageId);
    if (i < 0) return false;
    studio.outline.stages.splice(i, 1);
    delete studio.openers[stageId];
    delete studio.errors[stageId];
    touch(studio);
    return true;
}

/** 阶段上移（delta = -1）/ 下移（+1）；到头了返回 false */
export function studioMoveStage(studio, stageId, delta) {
    const list = studio.outline.stages;
    const i = list.findIndex((s) => s.id === stageId);
    const j = i + Math.sign(Number(delta) || 0);
    if (i < 0 || j < 0 || j >= list.length || i === j) return false;
    [list[i], list[j]] = [list[j], list[i]];
    touch(studio);
    return true;
}

export function studioAddLocation(studio, init = {}) {
    const list = studio.outline.world.locations;
    if (list.length >= STUDIO_LIMITS.locations) return null;
    const l = { name: oneLine(init?.name, STUDIO_LIMITS.locationName), desc: cleanText(init?.desc, STUDIO_LIMITS.locationDesc) };
    list.push(l);
    touch(studio);
    return l;
}

export function studioRemoveLocation(studio, index) {
    const list = studio.outline.world.locations;
    if (!Number.isInteger(index) || index < 0 || index >= list.length) return false;
    list.splice(index, 1);
    touch(studio);
    return true;
}

// ---------------- 进度与步骤 ----------------

/** 有可用的大纲：至少一个有名字的角色和一个阶段 */
export function studioHasOutline(studio) {
    return !!studio?.outline?.cast?.some((c) => c.name) && (studio?.outline?.stages?.length || 0) > 0;
}

/** 大纲里有没有任何内容（卡名、世界观、地点、角色、阶段……）：有就能打开第 2 步接着改（删光了阶段也能回去手动加） */
export function studioOutlineTouched(studio) {
    const o = studio?.outline;
    if (!o) return false;
    const w = o.world || {};
    return !!(o.title || o.logline || o.userRole || o.orientationNotes || w.setting || w.rules || w.tone || w.locations?.length || o.cast?.length || o.stages?.length);
}

/**
 * 一个角色的状态：'empty' 未生成 / 'partial' 只填了一部分（手动写了几项、或只重写过其中一项，还没整个展开）/
 * 'done' 完成（AI 整个展开过，或核心细节都写了）/ 'error' 上次出错、什么都没有（「生成中」由界面自己记）。
 * 「全部生成」会补全 partial 的角色（写了的保留）。
 */
export function studioCastStatus(studio, castId) {
    const d = studio?.details?.[castId];
    if (detailsFilled(d)) return d.generatedAt || detailsComplete(d) ? 'done' : 'partial';
    return studio?.errors?.[castId] ? 'error' : 'empty';
}

/** 一个阶段的开场白状态：'empty' / 'done' / 'error' */
export function studioOpenerStatus(studio, stageId) {
    if (String(studio?.openers?.[stageId] || '').trim()) return 'done';
    return studio?.errors?.[stageId] ? 'error' : 'empty';
}

/** 进度：角色细节写了几个、开场白写了几段、有没有示例对话 */
export function studioProgress(studio) {
    const cast = studio?.outline?.cast || [];
    const stages = studio?.outline?.stages || [];
    return {
        cast: cast.length,
        castDone: cast.filter((c) => studioCastStatus(studio, c.id) === 'done').length,
        stages: stages.length,
        openersDone: stages.filter((s) => studioOpenerStatus(studio, s.id) === 'done').length,
        example: !!String(studio?.example || '').trim(),
    };
}

/**
 * 某一步现在能不能进：1 创意总是可以；2 大纲要大纲里有内容（studioOutlineTouched）；
 * 3 角色与开场白要有可用的大纲（有名字的角色和阶段）；4 生成卡还要至少一段开场白。
 */
export function studioStepEnabled(studio, step) {
    if (step <= 1) return true;
    if (step === 2) return studioOutlineTouched(studio);
    if (!studioHasOutline(studio)) return false;
    if (step <= 3) return true;
    return studioProgress(studio).openersDone > 0;
}

/** 「第 2 阶段「求生」」：阶段在大纲里的序号与名字；找不到时 '' */
export function studioStageLabel(studio, stageId) {
    const list = studio?.outline?.stages || [];
    const i = list.findIndex((s) => s.id === stageId);
    if (i < 0) return '';
    return `第 ${i + 1} 阶段「${list[i].name || '未命名'}」`;
}

/** 「复制全部立绘提示词」的文字：每个角色一段【名字】+ 提示词；没有立绘提示词的跳过 */
export function studioPortraitPromptsText(studio) {
    return (studio?.outline?.cast || [])
        .map((c) => ({ c, p: String(studio.details?.[c.id]?.portraitPrompt || '').trim() }))
        .filter((x) => x.p)
        .map((x) => `【${x.c.name || '未命名'}】\n${x.p}`)
        .join('\n\n');
}

/**
 * 重新生成大纲的某一部分会清掉多少已经写好的内容（确认框用）：
 * all = 整份大纲（没锁定的角色的细节、全部开场白）；cast = 没锁定的角色；stages = 全部开场白；member = 这一个角色；world 不清。
 * @returns {{details: number, openers: number}}
 */
export function outlineRerollImpact(studio, mode = 'all', memberId = '') {
    const cast = studio?.outline?.cast || [];
    const filled = (c) => detailsFilled(studio?.details?.[c.id]);
    const openers = Object.values(studio?.openers || {}).filter((t) => String(t || '').trim()).length;
    if (mode === 'world') return { details: 0, openers: 0 };
    if (mode === 'member') return { details: cast.filter((c) => c.id === memberId && filled(c)).length, openers: 0 };
    if (mode === 'stages') return { details: 0, openers };
    const details = cast.filter((c) => !c.locked && filled(c)).length;
    return { details, openers: mode === 'all' ? openers : 0 };
}

// ---------------- 创意里的线索 ----------------

const CN_NUM = '[0-9０-９]+|[一二两三四五六七八九十]+';
// 数字前面不能是「第」或别的数字（「第三名」是名次；「十二名」不能从「二」开始算）
const NUM_START = '(?<![第0-9０-９一二两三四五六七八九十])';
const PEOPLE = '美女|美人|女孩|女生|女人|女性|姑娘|男人|男生|男性|帅哥|角色|人物|同伴|伙伴|幸存者|队友|室友|女主|男主|成员|学姐|同事|闺蜜|朋友|姐妹|兄弟|房客|租客|乘客|船员|邻居|客人|旅人|冒险者|佣兵|嫌疑人|人';
// 「位」「名」本身就是数人的量词：后面跟什么人都算（「五位房客」「三名船员」）；「个」要跟上表里的人（「三个月」不算）
const COUNT_RES = [
    new RegExp(`${NUM_START}(${CN_NUM})\\s*(?:位|名)\\s*[^\\s\\d，。,.、；;：:！!？?“”"'（）()]`),
    new RegExp(`${NUM_START}(${CN_NUM})\\s*个\\s*(?:[^\\s，。,.、；;！!？?]{0,4}?)(?:${PEOPLE})`),
];

/** 创意里写明的人数（「7个美女」「七位幸存者」「五位房客」）；没写或超出 1-12 时为 null */
export function premiseCastCount(premise) {
    const text = String(premise ?? '');
    const hits = COUNT_RES.map((re) => text.match(re)).filter(Boolean).sort((a, b) => a.index - b.index);
    if (!hits.length) return null;
    const n = chineseNumToInt(hits[0][1]);
    return Number.isFinite(n) && n >= STUDIO_COUNT_RANGE.min && n <= STUDIO_COUNT_RANGE.max ? n : null;
}

/** 从创意里取一个短标题（新建项目、草稿列表用）：去掉「我想做一张」这类开头，取第一个分句，最多 12 个字 */
export function studioTitleFromPremise(premise) {
    let s = String(premise ?? '').replace(/\s+/g, ' ').trim();
    s = s.replace(/^(?:我)?(?:想|要|打算|希望)?(?:做|写|搞|弄|来)?(?:一张|一个|一份|个|张)?(?:关于)?/, '').trim();
    s = s.split(/[，。,.!！?？；;：:\n]/)[0].replace(/的(?:故事|卡|角色卡|世界卡)$/, '').trim();
    return s.slice(0, 12);
}

/** 新建原创项目的名字：标题（或「原创项目」）没被已有项目用掉时直接用，否则依次加「 2」「 3」… */
export function studioProjectName(title, taken = []) {
    const base = oneLine(title, STUDIO_LIMITS.title) || '原创项目';
    const used = new Set(taken.map((n) => String(n ?? '').trim()));
    if (!used.has(base)) return base;
    for (let i = 2; ; i++) if (!used.has(`${base} ${i}`)) return `${base} ${i}`;
}

// ---------------- 卡片上记的本卡世界书条目 ----------------

/** 卡上记的条目（card.studio.entries）的种类 → 用设置里哪个分类的激活方式、位置和顺序 */
const ENTRY_KIND_CATEGORY = { rules: '世界观', stages: '剧情', character: '角色', location: '地点' };

/** 是不是创意工坊做的卡 */
export function isStudioCard(card) {
    return card?.source === STUDIO_SOURCE;
}

/**
 * 创意工坊卡自己世界书里的条目（写入酒馆时由 publish.js 的 cardExtraEntries 带上）：
 * 世界规则（常驻）、故事阶段（常驻）、每个角色一条、每个地点一条——内容在生成卡时写好记在 card.studio.entries。
 * 激活方式、位置、深度、顺序按设置里对应分类（角色 / 地点 / 世界观）；故事阶段固定常驻、排在最前面。
 * 分类在设置里关掉了也照样写（这些条目是这张卡的核心设定）。
 */
export function studioOwnEntries(settings, card) {
    if (!isStudioCard(card)) return [];
    const list = Array.isArray(card?.studio?.entries) ? card.studio.entries : [];
    const cats = settings?.categories || [];
    const conf = (name) => cats.find((c) => c?.name === name) || null;
    const idx = {};
    const out = [];
    for (const e of list) {
        if (!isObj(e) || !String(e.content || '').trim() || !String(e.name || '').trim()) continue;
        if (e.kind === 'stages') {
            // 不受世界书预算限制：角色条目多、预算溢出时酒馆按 order 从高到低丢条目，阶段推进规则不能第一个被丢掉
            out.push({ category: e.category || '剧情', name: e.name, keywords: uniq(e.keywords || []), content: e.content, constant: true, position: 0, depth: 4, order: 6, disable: false, ignoreBudget: true });
            continue;
        }
        const catName = ENTRY_KIND_CATEGORY[e.kind] || e.category;
        const c = conf(catName) || conf(e.category);
        idx[catName] = (idx[catName] ?? -1) + 1;
        const base = Number(c?.order ?? (e.kind === 'rules' ? 10 : e.kind === 'character' ? 100 : 200));
        out.push({
            category: e.category || catName,
            name: e.name,
            keywords: uniq([e.name, ...(e.keywords || [])]),
            content: e.content,
            constant: e.kind === 'rules' ? true : (c?.constant ?? false),
            position: Number(c?.position ?? 0),
            depth: Number(c?.depth ?? 4),
            order: base + (c?.autoIncrement === false ? 0 : idx[catName]),
            disable: false,
        });
    }
    return out;
}
