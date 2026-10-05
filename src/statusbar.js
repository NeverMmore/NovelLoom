// 状态栏 / MVU 变量系统：纯逻辑（不调用 AI、不碰 DOM）。
// 一份变量表（spec，AI 以 JSON 给出，经 normalizeStatusSpec 规范化）编译出导出所需的全部内容：
//   zod 变量结构脚本、[initvar] 初始值、变量更新规则、变量输出格式、四个世界书条目、
//   五条局部正则（状态栏显示 / 不发送占位符 / 不发送更新块 / 折叠更新块×2）、tavern_helper 角色脚本。
// 依据：SillyTavern 1.19.0、JS-Slash-Runner（酒馆助手）4.11.3、MVU 0.190.0、mvu_zod 0.3.453。

import { DEFAULT_STATUS_BAR } from './constants.js';
import { extractJson } from './json.js';
import { estimateTokens } from './utils.js';
import {
    STATUS_TAG, buildInitialState, cloneJson, decodeFenceText, encodeFenceText, getPath, isFrontendText, isPlainObj, jsLit, jsStr,
    setPath, simulateStRegexReplace, splitPath, unwrapStatusFence, wrapStatusFence,
} from './statusbar-base.js';
import { cleanFragment, compileStatusDocument } from './statusbar-runtime.js';
import { emptyPortraits, normalizePortraits } from './statusbar-portraits.js';

export {
    STATUS_TAG, buildInitialState, decodeFenceText, encodeFenceText, getPath, htmlSafe, isFrontendText, jsLit, jsStr, setPath,
    simulateStRegexReplace, splitPath, unwrapStatusFence, wrapStatusFence,
} from './statusbar-base.js';
export {
    NL_SERVER_IMAGE_RE, PORTRAIT_DATA_TOTAL_MAX, PORTRAIT_DATA_URL_MAX, PORTRAIT_LIMITS, PORTRAIT_OPS, PORTRAIT_STORE_MODES, PORTRAIT_URL_MAX,
    PORTRAIT_WHEN_TEXT_MAX, SERVER_IMAGE_PREFIX, TEMPLATE_PORTRAIT_DATA_TOTAL_MAX, TEMPLATE_PORTRAIT_DATA_URL_MAX, TEMPLATE_PORTRAIT_LIMITS, emptyPortraits,
    isOwnServerImage, normalizePortraits, normalizeServerPortraitInput, portraitChoiceId, portraitHash, portraitInitial, portraitNameProblem,
    portraitStorageStats, portraitStoreOf, portraitUrlKind, portraitUrlList, portraitUrlProblem, portraitsActive, resolvePortrait, serverPathProblem,
    serverPortraitHint, serverPortraitUrl,
} from './statusbar-portraits.js';

export const STATUS_BAR_VERSION = 1;
/** 状态栏界面模式的显示名（编辑器与模板列表共用）：bind = AI 按变量表设计的绑定片段，auto = 内置排版，raw = 自定义 HTML */
export const STATUS_MODE_LABELS = Object.freeze({ bind: 'AI 设计', auto: '内置排版', raw: '自定义 HTML' });
export const VAR_TYPES = ['number', 'string', 'enum', 'boolean', 'list', 'record'];
export const VAR_TYPE_LABELS = { number: '数字', string: '文本', enum: '选项', boolean: '是/否', list: '列表', record: '记录' };
export const WIDGETS = ['text', 'bar', 'badge', 'tags', 'list', 'hidden'];
export const WIDGET_LABELS = { text: '文字', bar: '进度条', badge: '徽标', tags: '标签', list: '条目列表', hidden: '不显示' };
/** 每种类型允许的 widget（第一个之外的默认值见 defaultWidget） */
export const TYPE_WIDGETS = {
    number: ['bar', 'text', 'badge', 'hidden'],
    string: ['text', 'badge', 'hidden'],
    enum: ['badge', 'text', 'hidden'],
    boolean: ['badge', 'text', 'hidden'],
    list: ['tags', 'text', 'hidden'],
    record: ['list', 'text', 'hidden'],
};
/** 路径段里不能使用的名字（与 MVU 的数据结构或 JS 原型冲突） */
export const RESERVED_NAMES = ['stat_data', 'display_data', 'delta_data', 'schema', 'status_current_variables', 'status_current_variable', '__proto__', 'constructor', 'prototype'];
export const MAX_PATH_DEPTH = 3;
/** 记录的对象值最多几个字段（分组算一个），每个分组里最多几个字段；分组只能有一层 */
export const RECORD_FIELD_MAX = 8;
export const GROUP_FIELD_MAX = 6;
export const STATUS_BAR_IDS = ['regexBar', 'regexHideTag', 'regexStrip', 'regexFoldStreaming', 'regexFoldDone', 'scriptMvu', 'scriptSchema'];

/** 四个世界书条目的 comment（MVU 按 comment 识别：[initvar] 不分大小写包含即可，[mvu_update] 不锚定） */
export const ENTRY_COMMENTS = {
    initvar: '[initvar]变量初始化勿开',
    list: '变量列表',
    rules: '[mvu_update]变量更新规则',
    format: '[mvu_update]变量输出格式',
};
export const ENTRY_ORDER = 14720; // 照抄 StageDog 模板的 order（酒馆同深度条目的排序语义未验证）

export const REGEX_NAMES = {
    bar: '[NL界面]状态栏',
    hideTag: '[NL不发送]状态栏占位符',
    strip: '[NL不发送]去除变量更新',
    foldStreaming: '[NL折叠]变量更新中',
    foldDone: '[NL折叠]完整变量更新',
};

/** 导出被拒绝时抛出（状态栏界面有错误、替换串无法原样往返等） */
export class StatusBarExportError extends Error {
    constructor(message, details = []) {
        super(message);
        this.name = 'StatusBarExportError';
        this.details = details;
    }
}

// ---------------- 小工具 ----------------

/** uuid v4；非安全上下文（局域网 http）没有 crypto.randomUUID，退回 getRandomValues */
export function uuidv4() {
    const c = globalThis.crypto;
    if (typeof c?.randomUUID === 'function') {
        try {
            return c.randomUUID();
        } catch { /* 非安全上下文 */ }
    }
    const b = new Uint8Array(16);
    if (typeof c?.getRandomValues === 'function') c.getRandomValues(b);
    else for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function str(v, max = 0) {
    const s = v === undefined || v === null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
    const t = s.trim();
    return max > 0 && t.length > max ? t.slice(0, max) : t;
}

function num(v) {
    if (v === null || v === undefined || v === '' || typeof v === 'boolean') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
}

function uniqStrings(list) {
    const out = [];
    for (const x of list) if (x && !out.includes(x)) out.push(x);
    return out;
}

/** 说明/检查规则里只保留 {{user}}/{{char}} 宏（世界书会替换它们），其余 {{…}} 去掉 */
export function cleanMacroText(s, max = 0) {
    // split 带捕获组：奇数下标是 {{…}}，偶数下标是普通文字（普通文字里落单的 {{ / }} 也去掉）
    const t = String(s ?? '').split(/(\{\{[^{}]*\}\})/).map((part, i) => {
        if (i % 2 === 0) return part.replace(/\{\{|\}\}/g, '');
        const k = part.slice(2, -2).trim().toLowerCase();
        return k === 'user' || k === 'char' ? `{{${k}}}` : '';
    }).join('').trim();
    return max > 0 && t.length > max ? t.slice(0, max) : t;
}

function toBool(v) {
    if (typeof v === 'boolean') return v;
    if (typeof v === 'number') return v !== 0;
    return ['true', '是', 'yes', 'y', '1', '对', '有', 'on'].includes(String(v ?? '').trim().toLowerCase());
}

// ---------------- 状态栏对象（card.statusBar） ----------------

/** 全局默认（settings.statusBar）→ 单卡选项 */
export function defaultStatusBarOptions(settings) {
    const g = { ...DEFAULT_STATUS_BAR, ...(settings?.statusBar || {}) };
    return {
        showDepth: normalizeFloorCount(g.showDepth),
        keepUpdateDepth: normalizeFloorCount(g.keepUpdateDepth),
        foldUpdate: g.foldUpdate !== false,
        greetingTag: g.greetingTag !== false,
        analysisLang: g.analysisLang === 'zh' ? 'zh' : 'en',
        usageNote: g.usageNote !== false,
    };
}

/** 楼层数：正整数，或 null（= 不限）。0、负数、非数字都视为 null */
export function normalizeFloorCount(v) {
    const n = num(v);
    return n !== null && n >= 1 ? Math.min(999, Math.floor(n)) : null;
}

function newIds() {
    return Object.fromEntries(STATUS_BAR_IDS.map((k) => [k, uuidv4()]));
}

/** 新建一个空的状态栏对象（形状见 CONTRACT.md） */
export function createStatusBar(settings) {
    const g = { ...DEFAULT_STATUS_BAR, ...(settings?.statusBar || {}) };
    return {
        version: STATUS_BAR_VERSION,
        enabled: true,
        mode: g.htmlMode === 'auto' ? 'auto' : 'bind',
        templateId: null,
        // 卡片自己的变量上限：沿用结构套用模板时记下模板的上限（templateVarCap），null = 跟随设置；
        // 实际用的上限见 statusbar-templates.js 的 statusBarVarCap（设置里的上限、它、现有变量数取最大）
        maxVars: null,
        requirement: '',
        spec: { title: '状态栏', variables: [] },
        html: '',
        theme: ['clean', 'night', 'paper'].includes(g.theme) ? g.theme : 'clean',
        sample: null,
        options: defaultStatusBarOptions(settings),
        overrides: { schemaScript: null, updateRules: null, initvar: null },
        portraits: emptyPortraits(),
        ids: newIds(),
        worldName: '',
        stale: false,
        lint: { errors: [], warnings: [] },
        prev: null,
        error: '',
        generatedAt: 0,
        updatedAt: 0,
    };
}

/**
 * 确保 card.statusBar 结构完整并返回它（可直接修改）。不存在就新建；已有的只补齐缺失字段，
 * 不会重新规范化变量表，也不会更换已有的 id（id 必须跨多次导出保持稳定）。
 */
export function ensureStatusBar(card, settings) {
    if (!isPlainObj(card.statusBar)) card.statusBar = createStatusBar(settings);
    const sb = card.statusBar;
    const fresh = createStatusBar(settings);
    for (const [k, v] of Object.entries(fresh)) {
        if (sb[k] === undefined) sb[k] = v;
    }
    if (!['bind', 'raw', 'auto'].includes(sb.mode)) sb.mode = 'bind';
    if (!isPlainObj(sb.spec)) sb.spec = { title: '状态栏', variables: [] };
    if (!Array.isArray(sb.spec.variables)) sb.spec.variables = [];
    if (typeof sb.spec.title !== 'string') sb.spec.title = '状态栏';
    if (typeof sb.html !== 'string') sb.html = '';
    if (!isPlainObj(sb.options)) sb.options = {};
    for (const [k, v] of Object.entries(fresh.options)) if (sb.options[k] === undefined) sb.options[k] = v;
    sb.options.showDepth = normalizeFloorCount(sb.options.showDepth);
    sb.options.keepUpdateDepth = normalizeFloorCount(sb.options.keepUpdateDepth);
    if (!isPlainObj(sb.overrides)) sb.overrides = { schemaScript: null, updateRules: null, initvar: null };
    for (const k of ['schemaScript', 'updateRules', 'initvar']) if (sb.overrides[k] === undefined) sb.overrides[k] = null;
    // 立绘：只补齐结构，不重新校验地址（编辑器保存时用 normalizePortraits，编译文档时也会再校验一次）
    if (!isPlainObj(sb.portraits)) sb.portraits = emptyPortraits();
    if (!isPlainObj(sb.portraits.characters)) sb.portraits.characters = {};
    if (!Array.isArray(sb.portraits.pools)) sb.portraits.pools = [];
    if (!isPlainObj(sb.ids)) sb.ids = {};
    for (const k of STATUS_BAR_IDS) if (!sb.ids[k]) sb.ids[k] = uuidv4();
    if (!isPlainObj(sb.lint)) sb.lint = { errors: [], warnings: [] };
    if (!Array.isArray(sb.lint.errors)) sb.lint.errors = [];
    if (!Array.isArray(sb.lint.warnings)) sb.lint.warnings = [];
    return sb;
}

/** 导出时是否带状态栏：启用且至少有一个变量 */
export function statusBarActive(card) {
    const sb = card?.statusBar;
    return !!(sb && sb.enabled && Array.isArray(sb.spec?.variables) && sb.spec.variables.length);
}

/** 世界/旁白卡（card.kind === 'world'）：{{char}} 是旁白本身，状态栏要照顾整个群像 */
export function isWorldCard(card) {
    return card?.kind === 'world';
}

/**
 * 变量路径里 {{char}} 要换成的名字（normalizeStatusSpec 的 charName）：卡片名，没有时用 charName；
 * 世界/旁白卡的 {{char}} 就是旁白，名字缺失时用「旁白」，角色卡用「角色」。
 */
export function statusBarCharName(card) {
    return String(card?.data?.name || card?.charName || '').trim() || (isWorldCard(card) ? '旁白' : '角色');
}

const CAST_RANK = { main: 3, support: 2, minor: 1 };

/**
 * 世界/旁白卡的主要角色名（用来预先填进「主要角色」这类记录的初始条目）：到卡片时间点为止已经出场的角色，
 * 按重要度（main > support > minor）排序；有 main 时只取 main。名字不能当记录键的（含 . / 引号等）跳过。
 * @param {object} project
 * @param {object} card
 * @param {{limit?: number, all?: boolean}} opt limit：最多几个（默认 8）；all：不只取 main
 * @returns {string[]}
 */
export function worldCastNames(project, card, { limit = 8, all = false } = {}) {
    const upto = Number.isFinite(card?.timepoint) ? card.timepoint : Infinity;
    const list = Object.entries(project?.characters || {})
        .map(([key, c]) => ({ name: String(c?.name || key).trim(), rank: CAST_RANK[c?.importance] || 0, first: Number.isFinite(c?.firstChunk) ? c.firstChunk : 0 }))
        .filter((c) => c.name && !(c.first > upto) && !segmentProblem(c.name, { allowSpace: true }))
        .sort((a, b) => b.rank - a.rank || a.first - b.first);
    const mains = list.filter((c) => c.rank === CAST_RANK.main);
    return (all || !mains.length ? list : mains).slice(0, Math.max(0, limit)).map((c) => c.name);
}

// 按角色名记录的多人数据（主要角色 / NPC / 队友…）：立绘候选、界面示例里的立绘槽位、世界卡预填主要角色都只认它们；物品、任务这类记录不算
const CAST_WORD_RE = /角色|人物|成员|群像|女主|男主|伙伴|队友|同伴|NPC|人名|姓名/i;
const NOT_CAST_RE = /物品|道具|任务|技能|装备|地点|势力|属性|背包|库存/;
const NPC_RE = /NPC|路人|配角|龙套|群众/i;

function castRecordText(v) {
    return `${String(v.path || '').split('.').pop()} ${v.keyDesc || ''} ${v.label || ''}`;
}

/** 这个记录变量的键是不是角色名（按路径最后一段、keyDesc、label 判断） */
export function isCastRecord(v) {
    if (v?.type !== 'record') return false;
    const text = castRecordText(v);
    return CAST_WORD_RE.test(text) && !NOT_CAST_RE.test(text);
}

/**
 * 存放主要角色的记录路径：最后一段叫「主要角色」的优先，否则取第一个键是角色名、又不是 NPC/路人的记录；没有返回 ''。
 * @param {{variables: object[]}} spec
 */
export function castRecordPath(spec) {
    const recs = (spec?.variables || []).filter((v) => v?.type === 'record');
    const exact = recs.find((v) => String(v.path || '').split('.').pop() === '主要角色');
    if (exact) return exact.path;
    return recs.find((v) => isCastRecord(v) && !NPC_RE.test(castRecordText(v)))?.path || '';
}

/** 键是角色名的记录变量：castRecordPath 指向的那个 + isCastRecord 认出的（主要角色、NPC、队友…；物品、任务这类不算） */
export function castRecords(spec) {
    const main = castRecordPath(spec);
    return (spec?.variables || []).filter((v) => v?.type === 'record' && (v.path === main || isCastRecord(v)));
}

/**
 * 世界/旁白卡：把项目里的主要角色（worldCastNames）预先填进主要角色记录（castRecordPath）的初始条目，已有的条目保持原样。
 * 不是世界卡、没有这样的记录或拿不到角色名时原样返回。不修改传入的 spec。
 * @param {object} project
 * @param {object} card
 * @param {object} spec 规范化后的变量表
 * @param {{names?: string[], warnings?: string[]}} opt names：直接给出角色名（不给时用 worldCastNames(project, card)）
 * @returns {{spec: object, path: string, added: string[]}}
 */
export function seedWorldCastEntries(project, card, spec, { names = null, warnings = [] } = {}) {
    const path = isWorldCard(card) ? castRecordPath(spec) : '';
    if (!path) return { spec, path: '', added: [] };
    let list = names;
    if (!Array.isArray(list)) {
        try {
            list = worldCastNames(project, card);
        } catch {
            list = [];
        }
    }
    if (!list.length) return { spec, path, added: [] };
    const r = seedRecordEntries(spec, path, list, { warnings });
    return { spec: r.spec, path, added: r.added };
}

// ---------------- 变量表规范化 ----------------

const TYPE_ALIASES = {
    number: 'number', num: 'number', int: 'number', integer: 'number', float: 'number', double: 'number', 数字: 'number', 数值: 'number', 整数: 'number',
    string: 'string', str: 'string', text: 'string', 文本: 'string', 字符串: 'string',
    enum: 'enum', select: 'enum', choice: 'enum', option: 'enum', options: 'enum', 枚举: 'enum', 选项: 'enum',
    boolean: 'boolean', bool: 'boolean', 布尔: 'boolean', 开关: 'boolean', '是/否': 'boolean',
    list: 'list', array: 'list', tags: 'list', 'string[]': 'list', 列表: 'list', 数组: 'list',
    record: 'record', map: 'record', object: 'record', dict: 'record', 记录: 'record', 字典: 'record',
};

function inferType(raw) {
    const t = TYPE_ALIASES[String(raw.type ?? '').trim().toLowerCase()];
    if (t) return t;
    if (Array.isArray(raw.options) && raw.options.length) return 'enum';
    const init = raw.init ?? raw.value ?? raw.default;
    if (typeof init === 'number' || raw.min !== undefined || raw.max !== undefined) return 'number';
    if (typeof init === 'boolean') return 'boolean';
    if (Array.isArray(init)) return 'list';
    if (isPlainObj(init)) return 'record';
    return 'string';
}

/**
 * 检查单个路径段，返回错误原因（合法时返回空串）
 * @param {string} seg
 * @param {{allowSpace?: boolean}} opt allowSpace：记录的动态键允许包含空格
 */
export function segmentProblem(seg, { allowSpace = false } = {}) {
    const s = String(seg ?? '');
    if (!s) return '有空的路径段';
    if (s.length > 32) return `「${s.slice(0, 12)}…」太长（最多 32 字）`;
    if (/[./~"'`<>{}[\]\\]/.test(s)) return `「${s}」含有不允许的字符（. / ~ 引号 反引号 < > { } [ ] \\）`;
    if (allowSpace ? /[\t\r\n]|\s{2,}/.test(s) : /\s/.test(s)) return `「${s}」含有空白`;
    if (/^\d+$/.test(s)) return `「${s}」是纯数字（会被当成数组下标）`;
    if (/\$(\d|<)/.test(s)) return `「${s}」含有 $数字`;
    if (RESERVED_NAMES.includes(s)) return `「${s}」是保留名`;
    return '';
}

function replacePathMacros(path, charName) {
    const who = String(charName || '').trim() || '角色';
    return String(path)
        .replace(/\{\{\s*user\s*\}\}|<user>/gi, '主角')
        .replace(/\{\{\s*char\s*\}\}|<char>|<bot>/gi, who);
}

function normalizePathText(raw, charName) {
    let p = Array.isArray(raw) ? raw.map((x) => String(x).trim()).join('.') : String(raw ?? '').trim();
    p = replacePathMacros(p, charName);
    p = p.replace(/^\/+/, '');
    if (!p.includes('.') && p.includes('/')) p = p.split('/').join('.');
    p = p.replace(/^(?:stat_data|status_current_variables?)\./, '');
    return p.split('.').map((s) => s.trim()).join('.');
}

function normStages(raw) {
    let list = [];
    if (Array.isArray(raw)) list = raw;
    else if (isPlainObj(raw)) list = Object.entries(raw).map(([label, min]) => ({ label, min }));
    const out = [];
    for (const s of list) {
        if (!isPlainObj(s)) continue;
        const min = num(s.min ?? s.from ?? s.value);
        const label = cleanMacroText(s.label ?? s.name ?? s.title, 16);
        if (min === null || !label || out.some((x) => x.min === min)) continue;
        out.push({ min, label });
    }
    return out.sort((a, b) => a.min - b.min).slice(0, 8);
}

function rangeText(min, max) {
    return min !== null && max !== null ? `${min}~${max}` : min !== null ? `≥${min}` : `≤${max}`;
}

/**
 * 数字的 min/max/integer/init。min 大于 max 时对调，初始值超出范围时夹到范围内——两种修正都写进 warnings（where 是提示里的位置）。
 * @param {{warnings?: string[]|null, where?: string, fallback?: number|null}} opt fallback：没有给初始值时用来推断 integer 与初始值的默认数
 */
function normNumberMeta(raw, typeWord, { warnings = null, where = '', fallback = null } = {}) {
    let min = num(raw.min);
    let max = num(raw.max);
    if (min !== null && max !== null && min > max) {
        warnings?.push(`${where} 的最小值 ${min} 大于最大值 ${max}，已对调成 ${max}~${min}`);
        [min, max] = [max, min];
    }
    const given = num(raw.init ?? raw.value ?? raw.default);
    const initRaw = given ?? fallback;
    const integer = raw.integer !== undefined ? !!raw.integer
        : typeWord === 'integer' || typeWord === 'int' || typeWord === '整数' ? true
            : [initRaw, min, max].filter((x) => x !== null).every((x) => Number.isInteger(x));
    const init = coerceNumber(initRaw ?? (min !== null && min > 0 ? min : max !== null && max < 0 ? max : 0), { min, max, integer });
    if (given !== null && (integer ? Math.round(given) : given) !== init) {
        warnings?.push(`${where} 的初始值 ${given} 超出范围 ${rangeText(min, max)}，已改为 ${init}`);
    }
    return { min, max, integer, init };
}

/** 记录里单个数字的初始值：超出范围时夹取并提示 */
function clampedItem(n, meta, warnings, where) {
    const v = coerceNumber(n, meta);
    if (Number.isFinite(n) && (meta.integer ? Math.round(n) : n) !== v) warnings?.push(`${where} 的初始值 ${n} 超出范围 ${rangeText(meta.min ?? null, meta.max ?? null)}，已改为 ${v}`);
    return v;
}

function coerceNumber(n, { min, max, integer }) {
    let v = Number(n);
    if (!Number.isFinite(v)) v = min ?? 0;
    if (integer) v = Math.round(v);
    if (min !== null && min !== undefined) v = Math.max(min, v);
    if (max !== null && max !== undefined) v = Math.min(max, v);
    return v;
}

function normOptions(raw) {
    const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(/[|,，、/]/) : [];
    return uniqStrings(list.map((x) => cleanMacroText(typeof x === 'object' ? x?.label ?? x?.value ?? '' : x, 24))).slice(0, 16);
}

function coerceStr(v) {
    if (v === undefined || v === null) return '';
    if (typeof v === 'string') return cleanMacroText(v, 500);
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    return cleanMacroText(JSON.stringify(v), 500);
}

/**
 * 字段是不是分组：带了 fields 数组（type 写成 object / group / 分组 都可以，也可以不写）。
 * 没有 fields 的 object 类型字段仍按文本处理（与以前一致）。
 */
function isGroupRaw(raw) {
    return Array.isArray(raw.fields);
}

/**
 * 记录值里的一个字段。allowGroup 时还可以是一层分组 {key, type:'object', label?, fields:[基本字段…]}（分组里不能再有分组）。
 * 数字字段可以带 stages（与变量的 stages 一样，界面用 data-nl-item-stage 显示阶段名）。
 */
function normField(raw, warnings, where, { allowGroup = false } = {}) {
    if (!isPlainObj(raw)) return null;
    const key = str(raw.key ?? raw.name ?? raw.path, 32);
    const problem = segmentProblem(key);
    if (problem) {
        warnings.push(`${where} 的字段被丢弃：${problem}`);
        return null;
    }
    if (isGroupRaw(raw)) {
        if (!allowGroup) {
            warnings.push(`${where} 的分组「${key}」里又有分组，分组只能有一层，已丢弃`);
            return null;
        }
        const fields = [];
        const list = Array.isArray(raw.fields) ? raw.fields : [];
        for (const item of list) {
            const nf = normField(item, warnings, `${where} 的分组「${key}」`);
            if (!nf) continue;
            if (fields.some((x) => x.key === nf.key)) {
                warnings.push(`${where} 的分组「${key}」里字段「${nf.key}」重复，已丢弃后一个`);
                continue;
            }
            if (fields.length >= GROUP_FIELD_MAX) {
                warnings.push(`${where} 的分组「${key}」最多 ${GROUP_FIELD_MAX} 个字段，「${nf.key}」及之后的已丢弃`);
                break;
            }
            fields.push(nf);
        }
        if (!fields.length) {
            warnings.push(`${where} 的分组「${key}」没有可用的字段，已丢弃`);
            return null;
        }
        const g = { key, type: 'object', label: cleanMacroText(raw.label, 16), fields };
        if (!g.label) delete g.label;
        return g;
    }
    let type = TYPE_ALIASES[String(raw.type ?? '').trim().toLowerCase()] || inferType(raw);
    if (!['number', 'string', 'boolean', 'enum'].includes(type)) type = 'string';
    const f = { key, type, label: cleanMacroText(raw.label, 16) };
    if (type === 'number') {
        Object.assign(f, normNumberMeta(raw, String(raw.type ?? '').toLowerCase(), { warnings, where: `${where} 的字段「${key}」` }));
        const stages = normStages(raw.stages);
        if (stages.length) f.stages = stages;
    } else if (type === 'boolean') f.init = toBool(raw.init ?? raw.value ?? raw.default);
    else if (type === 'enum') {
        f.options = normOptions(raw.options ?? raw.enum);
        if (!f.options.length) {
            f.type = 'string';
            delete f.options;
            f.init = coerceStr(raw.init ?? raw.value ?? '');
        } else {
            const init = str(raw.init ?? raw.value);
            f.init = f.options.includes(init) ? init : f.options[0];
        }
    } else f.init = coerceStr(raw.init ?? raw.value ?? raw.default ?? '');
    if (!f.label) delete f.label;
    return f;
}

function normRecordValue(raw, warnings, where) {
    let v = raw;
    if (typeof v === 'string') v = { type: v };
    if (!isPlainObj(v)) v = { type: 'string' };
    let type = TYPE_ALIASES[String(v.type ?? '').trim().toLowerCase()];
    if (Array.isArray(v.fields) && v.fields.length) type = 'object';
    if (type === 'record') type = 'object';
    if (type === 'number') {
        const meta = normNumberMeta(v, String(v.type ?? '').toLowerCase(), { warnings, where: `${where} 的记录值`, fallback: 1 });
        return { type: 'number', ...meta };
    }
    if (type === 'object') {
        const fields = [];
        for (const f of Array.isArray(v.fields) ? v.fields : []) {
            const nf = normField(f, warnings, where, { allowGroup: true });
            if (!nf) continue;
            if (fields.some((x) => x.key === nf.key)) {
                warnings.push(`${where} 的记录字段「${nf.key}」重复，已丢弃后一个`);
                continue;
            }
            if (fields.length >= RECORD_FIELD_MAX) {
                warnings.push(`${where} 的记录最多 ${RECORD_FIELD_MAX} 个字段（分组算一个），「${nf.key}」及之后的已丢弃`);
                break;
            }
            fields.push(nf);
        }
        if (fields.length) return { type: 'object', fields };
        warnings.push(`${where} 的记录字段为空，按文本处理`);
    }
    return { type: 'string', init: '' };
}

/** 按字段规格强制转换一个基本字段的值（数字超出范围时夹取并写进 warnings） */
function coerceFieldValue(f, x, warnings, where) {
    if (f.type === 'number') {
        const n = num(x);
        return n === null ? coerceNumber(f.init, f) : clampedItem(n, f, warnings, where);
    }
    if (f.type === 'boolean') return x === undefined ? f.init : toBool(x);
    if (f.type === 'enum') return f.options.includes(String(x)) ? String(x) : f.init;
    return x === undefined ? f.init : coerceStr(x);
}

/** 按字段列表强制转换一个对象（记录值或其中的分组）：缺的字段补初始值，未知键丢弃 */
function coerceFieldsObject(fields, item, warnings, where) {
    const src = isPlainObj(item) ? item : {};
    const out = {};
    for (const f of fields) {
        out[f.key] = f.type === 'object'
            ? coerceFieldsObject(f.fields, src[f.key], warnings, `${where}的「${f.key}」`)
            : coerceFieldValue(f, src[f.key], warnings, `${where}的「${f.key}」`);
    }
    return out;
}

/** 按 value 规格强制转换记录里的单个值（规范化 init 时使用）；数字超出范围时夹取并写进 warnings */
function coerceRecordItem(val, item, warnings = null, where = '') {
    if (val.type === 'number') {
        const n = num(item);
        return n === null ? coerceNumber(val.init ?? 0, val) : clampedItem(n, val, warnings, where);
    }
    if (val.type === 'object') return coerceFieldsObject(val.fields, item, warnings, where);
    return coerceStr(item);
}

/** 记录新条目的默认值（字段都取初始值，分组是由初始值组成的对象）。value 是规范化后的 v.value */
export function defaultRecordItem(value) {
    return coerceRecordItem(isPlainObj(value) ? value : { type: 'string' }, undefined);
}

/**
 * 记录对象值的所有基本字段，分组展开成点路径：[{path:'身份', field}, {path:'服饰.上衣', field, group}]。
 * 不是对象值时返回空数组。界面（data-nl-item="服饰.上衣"）、规则、示例数据都按这个顺序。
 */
export function recordLeafFields(value) {
    const out = [];
    if (value?.type !== 'object') return out;
    for (const f of value.fields || []) {
        if (f.type === 'object') for (const ff of f.fields || []) out.push({ path: `${f.key}.${ff.key}`, field: ff, group: f });
        else out.push({ path: f.key, field: f });
    }
    return out;
}

function normRecordInit(raw, val, warnings, where) {
    let src = raw;
    if (Array.isArray(src)) src = Object.fromEntries(src.map((k) => [str(k, 32), undefined]));
    if (!isPlainObj(src)) return {};
    const out = {};
    for (const [k0, item] of Object.entries(src)) {
        const k = cleanMacroText(k0, 32);
        const problem = segmentProblem(k, { allowSpace: true });
        if (problem) {
            warnings.push(`${where} 的初始条目被丢弃：${problem}`);
            continue;
        }
        out[k] = coerceRecordItem(val, item, warnings, `${where} 的初始条目「${k}」`);
        if (Object.keys(out).length >= 30) break;
    }
    return out;
}

/** 变量占用的“叶子”数：记录的对象值按基本字段数计（分组按它里面的字段数计），与记录里有多少条目无关 */
export function variableLeafCount(v) {
    if (v?.type !== 'record' || v.value?.type !== 'object') return 1;
    const n = (v.value.fields || []).reduce((s, f) => s + (f?.type === 'object' ? (f.fields?.length || 0) : 1), 0);
    return Math.max(1, n);
}

export function countSpecLeaves(spec) {
    return (spec?.variables || []).reduce((n, v) => n + variableLeafCount(v), 0);
}

export function defaultWidget(v) {
    if (v.type === 'number') return v.min !== null && v.max !== null && v.min !== undefined && v.max !== undefined ? 'bar' : 'text';
    return { string: 'text', enum: 'badge', boolean: 'badge', list: 'tags', record: 'list' }[v.type] || 'text';
}

function normVariable(raw, ctx) {
    const { warnings } = ctx;
    if (!isPlainObj(raw)) return null;
    const path = normalizePathText(raw.path ?? raw.name ?? raw.key, ctx.charName);
    const segs = path.split('.');
    const where = `变量「${path || '（空）'}」`;
    if (!path) {
        warnings.push('有一个变量没有路径，已丢弃');
        return null;
    }
    if (segs.length > MAX_PATH_DEPTH) {
        warnings.push(`${where} 层级超过 ${MAX_PATH_DEPTH} 层，已丢弃`);
        return null;
    }
    for (const s of segs) {
        const problem = segmentProblem(s);
        if (problem) {
            warnings.push(`${where} 已丢弃：${problem}`);
            return null;
        }
    }
    const typeWord = String(raw.type ?? '').trim().toLowerCase();
    let type = inferType(raw);
    const v = { path, type, label: cleanMacroText(raw.label ?? raw.title, 16) || segs[segs.length - 1].replace(/^[_$]+/, '') || segs[segs.length - 1] };
    const initRaw = raw.init !== undefined ? raw.init : raw.value !== undefined && type !== 'record' ? raw.value : raw.default;
    if (type === 'enum') {
        const options = normOptions(raw.options ?? raw.enum ?? raw.values);
        if (!options.length) {
            warnings.push(`${where} 是选项类型但没有选项，改为文本`);
            type = v.type = 'string';
        } else {
            v.options = options;
            const init = str(initRaw);
            v.init = options.includes(init) ? init : options[0];
        }
    }
    if (type === 'number') {
        const meta = normNumberMeta({ ...raw, init: initRaw }, typeWord, { warnings, where });
        Object.assign(v, { init: meta.init, min: meta.min, max: meta.max, integer: meta.integer });
        const stages = normStages(raw.stages);
        if (stages.length) v.stages = stages;
    } else if (type === 'string') {
        v.init = coerceStr(initRaw);
        const format = cleanMacroText(raw.format, 60);
        if (format) v.format = format;
    } else if (type === 'boolean') {
        v.init = toBool(initRaw);
    } else if (type === 'list') {
        let list = initRaw;
        if (typeof list === 'string') list = list.split(/[,，、\n]/);
        if (!Array.isArray(list)) list = [];
        list = list.map((x) => coerceStr(x)).filter(Boolean);
        const maxItems = normalizeFloorCount(raw.maxItems ?? raw.max ?? raw.limit);
        v.maxItems = maxItems ? Math.min(maxItems, 50) : null;
        v.init = v.maxItems ? list.slice(-v.maxItems) : list;
    } else if (type === 'record') {
        v.keyDesc = cleanMacroText(raw.keyDesc ?? raw.key ?? '名称', 16) || '名称';
        v.value = normRecordValue(raw.value ?? raw.valueType ?? raw.item, warnings, where);
        v.init = normRecordInit(raw.init ?? raw.default ?? {}, v.value, warnings, where);
    }
    const allowed = TYPE_WIDGETS[type];
    const widget = String(raw.widget ?? '').trim();
    v.widget = allowed.includes(widget) ? widget : defaultWidget(v);
    const desc = cleanMacroText(raw.desc ?? raw.description, 200);
    if (desc) v.desc = desc;
    let check = raw.check ?? raw.rules ?? raw.rule ?? [];
    if (typeof check === 'string') check = check.split(/\r?\n/);
    if (!Array.isArray(check)) check = [];
    v.check = uniqStrings(check.map((c) => cleanMacroText(typeof c === 'string' ? c.replace(/^\s*[-*•]\s*/, '') : str(c), 160))).slice(0, 6);
    return v;
}

/**
 * 规范化 AI 返回（或用户编辑）的变量表。
 * @param {object|object[]} raw {title, variables:[…]} 或直接是变量数组
 * @param {{charName?: string, maxVars?: number, warnings?: string[]}} opt
 *   charName：{{char}}/<char> 在路径里替换成的名字；maxVars：叶子数上限（默认 12）；
 *   warnings：传入数组时收集被丢弃/修正的原因（包括 min 大于 max 被对调、初始值超出范围被夹取）
 * @returns {{title: string, variables: object[]}}
 */
export function normalizeStatusSpec(raw, { charName = '', maxVars = DEFAULT_STATUS_BAR.maxVars, warnings = [] } = {}) {
    const src = Array.isArray(raw) ? { variables: raw } : isPlainObj(raw?.spec) ? raw.spec : isPlainObj(raw) ? raw : {};
    const list = Array.isArray(src.variables) ? src.variables : Array.isArray(src.vars) ? src.vars : [];
    const title = cleanMacroText(src.title, 30) || '状态栏';
    const cap = Math.max(1, Math.floor(num(maxVars) || DEFAULT_STATUS_BAR.maxVars));
    const ctx = { charName, warnings };
    const leaves = new Set();
    const variables = [];
    let used = 0;
    for (const item of list) {
        const v = normVariable(item, ctx);
        if (!v) continue;
        if (leaves.has(v.path)) {
            warnings.push(`变量「${v.path}」重复，已丢弃后一个`);
            continue;
        }
        const segs = v.path.split('.');
        const prefixLeaf = segs.slice(0, -1).map((_, i) => segs.slice(0, i + 1).join('.')).find((p) => leaves.has(p));
        const isBranch = [...leaves].some((p) => p.startsWith(`${v.path}.`));
        if (prefixLeaf || isBranch) {
            warnings.push(`变量「${v.path}」与「${prefixLeaf || [...leaves].find((p) => p.startsWith(`${v.path}.`))}」冲突（不能既是变量又是分组），已丢弃`);
            continue;
        }
        const n = variableLeafCount(v);
        if (used + n > cap) {
            warnings.push(`变量超过上限 ${cap} 个，「${v.path}」及之后的变量已丢弃`);
            break;
        }
        used += n;
        leaves.add(v.path);
        variables.push(v);
    }
    return { title, variables };
}

/** 变量表的可读摘要（给提示词或界面用） */
export function specSummaryText(spec) {
    return (spec?.variables || []).map((v) => {
        const bits = [VAR_TYPE_LABELS[v.type] || v.type];
        if (v.type === 'number') {
            if (v.min !== null || v.max !== null) bits.push(`${v.min ?? '-∞'}~${v.max ?? '∞'}`);
            if (v.integer) bits.push('整数');
            if (v.stages?.length) bits.push(`阶段 ${v.stages.map((s) => `${s.min}+${s.label}`).join('/')}`);
        }
        if (v.type === 'enum') bits.push(v.options.join('/'));
        if (v.type === 'list' && v.maxItems) bits.push(`最多 ${v.maxItems} 项`);
        if (v.type === 'record') bits.push(`键：${v.keyDesc}；值：${v.value.type === 'object' ? v.value.fields.map((f) => (f.type === 'object' ? `${f.key}［${(f.fields || []).map((x) => x.key).join('、')}］` : f.key)).join('、') : VAR_TYPE_LABELS[v.value.type] || v.value.type}`);
        if (v.format) bits.push(`格式 ${v.format}`);
        bits.push(`显示：${WIDGET_LABELS[v.widget] || v.widget}`);
        return `- ${v.path}（${bits.join('，')}）初始值 ${JSON.stringify(v.init)}${v.desc ? `：${v.desc}` : ''}`;
    }).join('\n');
}

// ---------------- 记录条目与示例数据 ----------------

/**
 * 往记录变量的初始条目里加入一批名字（已有的跳过），每个新条目取 defaultRecordItem。
 * 用于世界/旁白卡：把项目里的主要角色（worldCastNames）预先填进「主要角色」这类记录。不修改传入的 spec。
 * @param {object} spec 规范化后的变量表
 * @param {string} path 记录变量的路径
 * @param {string[]} names
 * @param {{max?: number, warnings?: string[]}} opt max：条目总数上限（默认 30，与规范化一致）
 * @returns {{spec: object, added: string[]}}
 */
export function seedRecordEntries(spec, path, names, { max = 30, warnings = [] } = {}) {
    const out = cloneJson(spec || { title: '状态栏', variables: [] });
    const v = (out.variables || []).find((x) => x.path === path);
    const added = [];
    if (!v || v.type !== 'record') {
        warnings.push(`变量表里没有记录变量「${path}」`);
        return { spec: out, added };
    }
    if (!isPlainObj(v.init)) v.init = {};
    for (const raw of Array.isArray(names) ? names : []) {
        const k = cleanMacroText(raw, 32);
        if (!k || Object.prototype.hasOwnProperty.call(v.init, k)) continue;
        const problem = segmentProblem(k, { allowSpace: true });
        if (problem) {
            warnings.push(`「${path}」的条目「${k}」没有加入：${problem}`);
            continue;
        }
        if (Object.keys(v.init).length >= max) {
            warnings.push(`「${path}」最多 ${max} 个初始条目，「${k}」及之后的没有加入`);
            break;
        }
        v.init[k] = defaultRecordItem(v.value);
        added.push(k);
    }
    return { spec: out, added };
}

function randInt(rng, lo, hi) {
    return Math.round(lo + rng() * (hi - lo));
}

function randomFieldValue(f, rng) {
    if (f.type === 'object') return Object.fromEntries((f.fields || []).map((ff) => [ff.key, randomFieldValue(ff, rng)]));
    if (f.type === 'number') {
        const lo = f.min ?? 0;
        const hi = f.max ?? lo + 100;
        const x = lo + rng() * (hi - lo);
        return f.integer === false ? Math.round(x * 10) / 10 : Math.round(x);
    }
    if (f.type === 'enum') return f.options[Math.floor(rng() * f.options.length)] ?? f.init;
    if (f.type === 'boolean') return rng() < 0.5;
    return f.init || '示例';
}

/**
 * 记录里一个条目的随机示例值（数字在范围内随机、选项随机挑、是/否随机、文本保留初始值或写「示例」；分组逐个字段随机）。
 * @param {object} value 规范化后的 v.value
 * @param {{rng?: () => number}} opt rng：[0,1) 的随机数函数（测试时传固定序列）
 */
export function randomRecordItem(value, { rng = Math.random } = {}) {
    if (value?.type === 'number') {
        const lo = value.min ?? 0;
        return randInt(rng, lo, value.max ?? lo + 100);
    }
    if (value?.type === 'object') return randomFieldValue({ type: 'object', fields: value.fields }, rng);
    return '示例';
}

/**
 * 预览用的随机示例变量（「随机值」按钮）：每个变量按类型随机，记录保留初始条目的键（没有条目时造一个「示例」条目），
 * 最后按变量表校验规整（结果总能通过 parseStateWithSpec）。
 * @param {object} spec
 * @param {{rng?: () => number}} opt
 */
export function randomSampleState(spec, { rng = Math.random } = {}) {
    const out = buildInitialState(spec);
    for (const v of spec?.variables || []) {
        let val;
        switch (v.type) {
            case 'number':
            case 'enum':
            case 'boolean':
                val = randomFieldValue(v, rng);
                break;
            case 'list': {
                const base = v.init?.length ? v.init.slice() : ['示例一', '示例二'];
                val = base.filter(() => rng() < 0.75);
                if (!val.length) val = base.slice(0, 1);
                break;
            }
            case 'record': {
                const keys = Object.keys(v.init || {});
                val = Object.fromEntries((keys.length ? keys : ['示例']).map((k) => [k, randomRecordItem(v.value, { rng })]));
                break;
            }
            default:
                val = v.init || '示例文本';
        }
        setPath(out, v.path, val);
    }
    const r = parseStateWithSpec(spec, out);
    return r.ok ? r.data : buildInitialState(spec);
}

/**
 * 立绘编辑器里可选的名字：键是角色名的记录（castRecords：主要角色、NPC、队友…；物品、任务、属性这类记录不算）的初始条目
 * （record 是记录路径）+ 固定分组名（第一层路径，record 为 null）。
 * 示例数据里才有的条目（模板或 AI 写的演示名字）不在这里，见 portraitSampleCandidates。
 * @param {object} spec
 * @param {object} [sample] 不再使用（保留参数位置，旧的调用照常工作）
 * @returns {{name: string, record: string|null}[]}
 */
export function portraitCandidates(spec, sample = null) {
    const out = [];
    const seen = new Set();
    const add = (name, record) => {
        const id = JSON.stringify([record ?? '', name]);
        if (!name || seen.has(id)) return;
        seen.add(id);
        out.push({ name, record });
    };
    for (const v of castRecords(spec)) {
        for (const k of Object.keys(isPlainObj(v.init) ? v.init : {})) add(k, v.path);
    }
    for (const v of spec?.variables || []) {
        const segs = splitPath(v.path);
        if (segs.length > 1) add(segs[0], null);
    }
    return out;
}

/**
 * 只在示例数据里出现的角色名（键是角色名的记录里、初始条目没有的键）：{name, record, sample: true}，
 * 界面上应标成「示例数据」——它们是模板或 AI 写的演示条目，不一定是这个故事里的角色。
 * @param {object} spec
 * @param {object} sample 示例 stat_data
 * @returns {{name: string, record: string, sample: true}[]}
 */
export function portraitSampleCandidates(spec, sample) {
    if (!isPlainObj(sample)) return [];
    const out = [];
    for (const v of castRecords(spec)) {
        const init = isPlainObj(v.init) ? v.init : {};
        const s = getPath(sample, v.path);
        for (const k of Object.keys(isPlainObj(s) ? s : {})) {
            if (!k || Object.prototype.hasOwnProperty.call(init, k) || out.some((x) => x.record === v.path && x.name === k)) continue;
            out.push({ name: k, record: v.path, sample: true });
        }
    }
    return out;
}

// ---------------- 变量树 ----------------

function buildTree(spec) {
    const root = { children: new Map() };
    for (const v of spec?.variables || []) {
        let node = root;
        const segs = splitPath(v.path);
        segs.forEach((seg, i) => {
            if (i === segs.length - 1) {
                node.children.set(seg, { leaf: v });
                return;
            }
            if (!node.children.has(seg)) node.children.set(seg, { children: new Map() });
            node = node.children.get(seg);
        });
    }
    return root;
}

// ---------------- 编译：zod 变量结构脚本 ----------------

function numberTransform(m) {
    const hasMin = Number.isFinite(m.min);
    const hasMax = Number.isFinite(m.max);
    let e = m.integer ? 'Math.round(v)' : 'v';
    if (hasMin) e = `Math.max(${m.min}, ${e})`;
    if (hasMax) e = `Math.min(${m.max}, ${e})`;
    return e === 'v' ? '' : `.transform(v => ${e})`;
}

function zodNumber(m, init) {
    return `z.coerce.number().prefault(${jsLit(init)})${numberTransform(m)}`;
}

/** 记录值里的字段；分组 → 嵌套的 z.object({…}).prefault({})（pad 是分组所在那一行的缩进） */
function zodField(f, pad = '') {
    if (f.type === 'object') {
        const inner = (f.fields || []).map((ff) => `${pad}  ${jsStr(ff.key)}: ${zodField(ff)},`).join('\n');
        return `z.object({\n${inner}\n${pad}}).prefault({})`;
    }
    if (f.type === 'number') return zodNumber(f, f.init);
    if (f.type === 'boolean') return `nlBool().prefault(${jsLit(f.init)})`;
    if (f.type === 'enum') return `z.enum(${jsLit(f.options)}).prefault(${jsLit(f.init)})`;
    return `nlStr().prefault(${jsLit(f.init ?? '')})`;
}

function zodLeaf(v, pad) {
    switch (v.type) {
        case 'number':
            return zodNumber(v, v.init);
        case 'enum':
            return `z.enum(${jsLit(v.options)}).prefault(${jsLit(v.init)})`;
        case 'boolean':
            return `nlBool().prefault(${jsLit(v.init)})`;
        case 'list':
            return `z.array(nlStr()).prefault(${jsLit(v.init)})${v.maxItems ? `.transform(a => a.slice(-${v.maxItems}))` : ''}`;
        case 'record': {
            const key = `z.string().describe(${jsStr(v.keyDesc || '名称')})`;
            let val;
            if (v.value.type === 'number') val = zodNumber(v.value, v.value.init ?? 0);
            else if (v.value.type === 'object') {
                const inner = v.value.fields.map((f) => `${pad}    ${jsStr(f.key)}: ${zodField(f, `${pad}    `)},`).join('\n');
                val = `z.object({\n${inner}\n${pad}  }).prefault({})`;
            } else val = 'nlStr()';
            return `z.record(${key}, ${val}).prefault(${jsLit(v.init)})`;
        }
        default:
            return `nlStr().prefault(${jsLit(v.init ?? '')})`;
    }
}

function zodNode(node, depth) {
    const pad = '  '.repeat(depth);
    const lines = [];
    for (const [key, child] of node.children) {
        if (child.leaf) lines.push(`${pad}${jsStr(key)}: ${zodLeaf(child.leaf, pad)},`);
        else lines.push(`${pad}${jsStr(key)}: z.object({\n${zodNode(child, depth + 1)}\n${pad}}).prefault({}),`);
    }
    return lines.join('\n');
}

function safeUrl(url, fallback) {
    const s = String(url ?? '').trim();
    return /^https?:\/\/[^\s'"`<>\\]+$/.test(s) ? s : fallback;
}

/** 卡片脚本内容不能出现 </script（酒馆助手把内容原样放进 <script type="module">） */
function scriptSafe(code) {
    return String(code ?? '').replace(/<\/script/gi, '<\\/script');
}

/**
 * 变量表 → 「变量结构」角色脚本（zod 4，全局 z 由酒馆助手提供）。
 * 约定：数字用 z.coerce.number()，夹取写在 transform 里；每个字段 prefault(初始值)，每个对象 prefault({})；
 * 不用 strict/passthrough；Schema.parse 幂等。只用 Math，不依赖 lodash，可直接在 node 里用真实 zod 验证。
 */
export function compileSchemaScript(spec, { zodUrl = DEFAULT_STATUS_BAR.zodUrl } = {}) {
    const url = safeUrl(zodUrl, DEFAULT_STATUS_BAR.zodUrl);
    const body = zodNode(buildTree(spec), 1);
    return [
        '// 由 NovelLoom 生成：请在 NovelLoom 里修改变量后重新导出',
        `import { registerMvuSchema } from ${jsStr(url)};`,
        "const nlStr = () => z.preprocess(v => (typeof v === 'number' || typeof v === 'boolean' ? String(v) : v), z.string());",
        "const nlBool = () => z.preprocess(v => (v === 'true' || v === '是' ? true : v === 'false' || v === '否' ? false : v), z.boolean());",
        `export const Schema = z.object({\n${body}\n});`,
        '$(() => { registerMvuSchema(Schema); });',
        '',
    ].join('\n');
}

// ---------------- 编译：YAML ----------------

const YAML_PLAIN_KEY = /^[\p{L}\p{N}_][\p{L}\p{N}_\-·・]*$/u;
const YAML_SPECIAL = /^(?:true|false|null|yes|no|on|off|y|n|~)$/i;

function yamlKey(k) {
    const s = String(k);
    return YAML_PLAIN_KEY.test(s) && !YAML_SPECIAL.test(s) && !/^[-+]?(?:\d|\.\d)/.test(s) ? s : JSON.stringify(s);
}

function yamlScalar(v) {
    if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '0';
    if (typeof v === 'boolean') return v ? 'true' : 'false';
    if (v === null || v === undefined) return 'null';
    if (typeof v === 'string') return JSON.stringify(v);
    return JSON.stringify(v);
}

function yamlLines(value, indent) {
    const pad = ' '.repeat(indent);
    const lines = [];
    for (const [k, v] of Object.entries(value)) {
        const key = `${pad}${yamlKey(k)}:`;
        if (isPlainObj(v)) {
            if (!Object.keys(v).length) lines.push(`${key} {}`);
            else lines.push(key, ...yamlLines(v, indent + 2));
        } else if (Array.isArray(v)) {
            if (!v.length) lines.push(`${key} []`);
            else lines.push(key, ...v.map((x) => `${pad}  - ${yamlScalar(x)}`));
        } else lines.push(`${key} ${yamlScalar(v)}`);
    }
    return lines;
}

/** 任意 JSON 对象 → YAML 文本（键必要时加引号，字符串一律用 JSON 双引号写法） */
export function toYaml(obj) {
    return yamlLines(isPlainObj(obj) ? obj : {}, 0).join('\n');
}

/** 变量表 → [initvar] 条目内容：根键即 stat_data 的第一层（不带 stat_data 外壳） */
export function compileInitVar(spec) {
    return `${toYaml(buildInitialState(spec))}\n`;
}

function isReadonlyPath(path) {
    return splitPath(path).some((s) => s.startsWith('_'));
}

function recordTypeText(v) {
    const val = v.value || { type: 'string' };
    const key = `[${v.keyDesc || '名称'}: string]`;
    const rangeNote = (m) => {
        const lo = Number.isFinite(m.min);
        const hi = Number.isFinite(m.max);
        return lo && hi ? ` // ${m.min}~${m.max}` : lo ? ` // >=${m.min}` : hi ? ` // <=${m.max}` : '';
    };
    const stageNote = (f) => (f.stages?.length ? `${rangeNote(f) ? '，' : ' // '}阶段 ${f.stages.map((s) => `${s.min}+${s.label}`).join('/')}` : '');
    const fieldLine = (f, pad) => {
        const t = f.type === 'enum' ? f.options.map((o) => JSON.stringify(o)).join(' | ') : f.type;
        return `${pad}${f.key}: ${t};${f.type === 'number' ? `${rangeNote(f)}${stageNote(f)}` : ''}`;
    };
    if (val.type === 'object') {
        const fields = val.fields.flatMap((f) => (f.type === 'object'
            ? [`    ${f.key}: {`, ...(f.fields || []).map((ff) => fieldLine(ff, '      ')), '    };']
            : [fieldLine(f, '    ')]));
        return ['{', `  ${key}: {`, ...fields, '  }', '}'];
    }
    return ['{', `  ${key}: ${val.type};${val.type === 'number' ? rangeNote(val) : ''}`, '}'];
}

/** 带分组的记录：给 AI 几个 JSON Patch 路径的写法（第一个基本字段 + 每个分组的第一个字段，最多 4 条） */
function recordPathExamples(v) {
    if (v.value?.type !== 'object' || !v.value.fields.some((f) => f.type === 'object')) return [];
    const base = `/${splitPath(v.path).join('/')}/<${v.keyDesc || '名称'}>`;
    const out = [];
    const first = v.value.fields.find((f) => f.type !== 'object');
    if (first) out.push(`${base}/${first.key}`);
    for (const g of v.value.fields.filter((f) => f.type === 'object')) out.push(`${base}/${g.key}/${g.fields[0].key}`);
    return out.slice(0, 4);
}

function ruleLeafLines(v, indent) {
    const pad = ' '.repeat(indent);
    const lines = [];
    if (v.desc) lines.push(`${pad}desc: ${JSON.stringify(v.desc)}`);
    if (v.type === 'number') {
        lines.push(`${pad}type: ${v.integer ? 'integer' : 'number'}`);
        const hasMin = Number.isFinite(v.min);
        const hasMax = Number.isFinite(v.max);
        if (hasMin || hasMax) {
            const r = hasMin && hasMax ? `${v.min}~${v.max}` : hasMin ? `>=${v.min}` : `<=${v.max}`;
            lines.push(`${pad}range: ${/^-?[\d.]+~-?[\d.]+$/.test(r) ? r : JSON.stringify(r)}`);
        }
        if (v.stages?.length) lines.push(`${pad}stages:`, ...v.stages.map((s) => `${pad}  - ${JSON.stringify(`${s.min}+：${s.label}`)}`));
    } else if (v.type === 'enum') {
        lines.push(`${pad}options: [${v.options.map((o) => JSON.stringify(o)).join(', ')}]`);
    } else if (v.type === 'boolean') {
        lines.push(`${pad}type: boolean`);
    } else if (v.type === 'list') {
        lines.push(`${pad}type: string[]`);
        if (v.maxItems) lines.push(`${pad}maxItems: ${v.maxItems}`);
    } else if (v.type === 'record') {
        lines.push(`${pad}type: |-`, ...recordTypeText(v).map((l) => `${pad}  ${l}`));
        const paths = recordPathExamples(v);
        if (paths.length) lines.push(`${pad}paths:`, ...paths.map((p) => `${pad}  - ${JSON.stringify(p)}`));
    }
    if (v.type === 'string' && v.format) lines.push(`${pad}format: ${JSON.stringify(v.format)}`);
    if (v.check?.length) lines.push(`${pad}check:`, ...v.check.map((c) => `${pad}  - ${JSON.stringify(c)}`));
    if (!lines.length) lines.push(`${pad}type: string`);
    return lines;
}

function ruleNodeLines(node, indent) {
    const pad = ' '.repeat(indent);
    const lines = [];
    for (const [key, child] of node.children) {
        if (child.leaf) {
            lines.push(`${pad}${yamlKey(key)}:`, ...ruleLeafLines(child.leaf, indent + 2));
        } else {
            const inner = ruleNodeLines(child, indent + 2);
            if (inner.length) lines.push(`${pad}${yamlKey(key)}:`, ...inner);
        }
    }
    return lines;
}

/** 变量表 → [mvu_update]变量更新规则（YAML，根键「变量更新规则」；_ 开头的只读变量不列出） */
export function compileUpdateRules(spec) {
    const visible = { ...spec, variables: (spec?.variables || []).filter((v) => !isReadonlyPath(v.path)) };
    const lines = ruleNodeLines(buildTree(visible), 2);
    return lines.length ? `变量更新规则:\n${lines.join('\n')}\n` : '变量更新规则: {}\n';
}

/**
 * [mvu_update]变量输出格式：NovelLoom 自己的措辞，协议与 MVU 解析的一致
 * （<UpdateVariable> 包 <Analysis> 与 <JSONPatch>；replace→set、delta→add、insert/add→insert、remove、move）。
 * @param {{analysisLang?: 'en'|'zh'}} opt Analysis 用英文（默认，省 token）或中文
 */
export function compileOutputFormat({ analysisLang = 'en' } = {}) {
    const zh = analysisLang === 'zh';
    const analysis = zh
        ? ['<Analysis>（用中文写，不超过 120 字）', '- 本轮经过的时间：…', '- 逐个对照变量的 check，只依据本轮回复判断要不要更新：…', '</Analysis>']
        : ['<Analysis>(IN ENGLISH, no more than 80 words)', '- time passed in this reply: …', "- check each variable against its `check` rules, based only on this reply: …", '</Analysis>'];
    return [
        '变量输出格式:',
        '  规则:',
        '    - 每次回复写完正文后，在回复的最末尾一次性输出本轮的变量分析与更新命令，格式见下方「格式」',
        '    - 更新命令必须是合法的 JSON 数组，写法参照 JSON Patch（RFC 6902），只能使用 replace、delta、insert、remove、move 五种操作',
        '    - replace：把已有路径的值替换成新值',
        '    - delta：给数字变量加上变化量（正数增加，负数减少），只能用于数字',
        '    - insert：给对象新增一个键，或往数组里加元素；路径末尾写 /- 表示追加到数组末尾',
        '    - remove：删除对象里的某个键或数组里的某个元素',
        '    - move：把 from 路径的值移动到 to 路径',
        '    - 路径用 / 分隔，从变量的第一层写起，例如 /主角/位置；不要在路径前加 stat_data',
        '    - 名字以 _ 开头的变量是只读的，不要更新',
        '    - 有 options 的变量只能取 options 里的值；有 range 的数字不能超出范围',
        '    - 只根据本轮回复里实际发生的事情更新，没有变化的变量不要写；本轮没有任何变化时写空数组 []',
        '  格式: |-',
        '    <UpdateVariable>',
        ...analysis.map((l) => `    ${l}`),
        '    <JSONPatch>',
        '    [',
        '      { "op": "replace", "path": "/路径/变量", "value": "新值" },',
        '      { "op": "delta", "path": "/路径/数字变量", "value": 3 },',
        '      { "op": "insert", "path": "/路径/对象/新键", "value": "新值" },',
        '      { "op": "insert", "path": "/路径/数组/-", "value": "新元素" },',
        '      { "op": "remove", "path": "/路径/对象/键" },',
        '      { "op": "move", "from": "/原路径", "to": "/新路径" }',
        '    ]',
        '    </JSONPatch>',
        '    </UpdateVariable>',
        '',
    ].join('\n');
}

export const STATUS_LIST_CONTENT = '---\n<status_current_variable>\n{{format_message_variable::stat_data}}\n</status_current_variable>';

function overrideText(v) {
    return typeof v === 'string' && v.trim() ? v : null;
}

/**
 * 状态栏需要的四个世界书条目（NovelLoom 逻辑条目格式，带 comment / ignoreBudget / 递归覆盖），
 * 写入 ST 世界书文件，也会内嵌进 character_book。
 */
export function statusBarEntries(card) {
    const sb = card.statusBar || {};
    const spec = sb.spec || { variables: [] };
    const ov = sb.overrides || {};
    const base = { category: '状态栏', keywords: [], constant: true, order: ENTRY_ORDER, excludeRecursion: true, preventRecursion: true, role: 0 };
    return [
        { ...base, name: ENTRY_COMMENTS.initvar, comment: ENTRY_COMMENTS.initvar, content: overrideText(ov.initvar) ?? compileInitVar(spec), position: 0, depth: 4, disable: true, ignoreBudget: false },
        { ...base, name: ENTRY_COMMENTS.list, comment: ENTRY_COMMENTS.list, content: STATUS_LIST_CONTENT, position: 4, depth: 0, disable: false, ignoreBudget: true },
        { ...base, name: ENTRY_COMMENTS.rules, comment: ENTRY_COMMENTS.rules, content: overrideText(ov.updateRules) ?? compileUpdateRules(spec), position: 4, depth: 0, disable: false, ignoreBudget: true },
        { ...base, name: ENTRY_COMMENTS.format, comment: ENTRY_COMMENTS.format, content: compileOutputFormat({ analysisLang: sb.options?.analysisLang }), position: 4, depth: 0, disable: false, ignoreBudget: true },
    ];
}

/** 三个常驻条目（变量列表 / 更新规则 / 输出格式）每轮大约占用的 token */
export function estimateStatusBarTokens(card) {
    const entries = statusBarEntries(card);
    const listText = STATUS_LIST_CONTENT.replace('{{format_message_variable::stat_data}}', toYaml(buildInitialState(card.statusBar?.spec)));
    const list = estimateTokens(listText);
    const rules = estimateTokens(entries[2].content);
    const format = estimateTokens(entries[3].content);
    return { list, rules, format, total: list + rules + format };
}

// ---------------- 局部正则 ----------------

/**
 * 「显示几层」→ 状态栏正则的 maxDepth。
 * 酒馆的显示深度（public/script.js:1851-1853 messageFormatting）= 该消息之后的非系统消息条数：
 * 最新一条消息深度 0，再往前 1、2…，用户消息也计入。regex/engine.js:368 在 depth > maxDepth 时跳过这条正则
 * （maxDepth 为 null/NaN/负数时不限）。状态栏只出现在 AI 回复上，而 AI 回复与用户消息交替出现，
 * 所以“最新 N 层（AI 回复）”= maxDepth 2N-1：N=1 时最新 AI 回复无论后面有没有刚发出的用户消息（深度 0 或 1）都显示，
 * 更早的 AI 回复（深度 ≥2）不显示。注意：已渲染的旧楼层要等重新渲染（如重新打开聊天）才会按深度隐藏。
 * @param {number|null} showDepth 1 = 只最新一层；N = 最新 N 层；null = 每一层
 * @returns {number|null}
 */
export function showDepthToMaxDepth(showDepth) {
    const n = normalizeFloorCount(showDepth);
    return n === null ? null : n * 2 - 1;
}

/**
 * 「保留最近 K 轮的变量更新块给 AI 看」→ 「不发送」正则的 minDepth。
 * 组装提示词时（public/script.js:4504）深度 = coreChat.length - index - 1：刚发出的用户消息深度 0，
 * 上一条 AI 回复深度 1，再上一条 AI 回复深度 3…；engine.js:363 在 depth < minDepth 时跳过（即保留）。
 * 所以保留最近 K 条 AI 回复的更新块 = minDepth 2K（K=1 → 2，K=3 → 6，与社区卡「只发送最新3楼的变量更新」的 6 一致）。
 * @param {number|null} keep null/0 = 全部去掉
 */
export function keepUpdateDepthToMinDepth(keep) {
    const n = normalizeFloorCount(keep);
    return n === null ? null : n * 2;
}

function regexScript(id, scriptName, findRegex, replaceString, { placement, markdownOnly = false, promptOnly = false, runOnEdit = false, minDepth = null, maxDepth = null }) {
    return { id, scriptName, findRegex, replaceString, trimStrings: [], placement, disabled: false, markdownOnly, promptOnly, runOnEdit, substituteRegex: 0, minDepth, maxDepth };
}

function firstDiff(a, b) {
    let i = 0;
    while (i < a.length && i < b.length && a[i] === b[i]) i++;
    return i;
}

/**
 * 状态栏文档 → 状态栏正则的替换串（"\n```html\n" + 文档 + "\n```\n"），并模拟酒馆的替换展开做往返检查：
 * 展开后必须与原串完全一致（{{user}}/{{char}} 视为不变），否则拒绝导出。
 * 文档里的 & 先写成 &amp;（encodeFenceText）：酒馆把代码块交给酒馆助手时会解码一层 HTML 实体，
 * 这样 iframe 收到的正好是原文档（decodeFenceText(unwrapStatusFence(替换串)) === 文档）。
 * 同一步还把 *、奇数个 " 的行里的 "、挨着空白的 _ 写成数字实体，酒馆的「自动修复 Markdown」不会改动界面里的脚本和样式。
 * @throws {StatusBarExportError}
 */
export function buildStatusRegexReplace(doc) {
    const body = String(doc ?? '');
    if (body.includes('```')) throw new StatusBarExportError('状态栏界面里出现了 ```，会提前结束代码块，已阻止导出');
    if (!isFrontendText(body)) throw new StatusBarExportError('状态栏文档缺少 <body> / <head> / <html>，酒馆助手不会把它渲染成界面');
    const replace = wrapStatusFence(encodeFenceText(body));
    if (decodeFenceText(encodeFenceText(body)) !== body) throw new StatusBarExportError('状态栏界面无法原样写进代码块（HTML 实体转义没有往返），已阻止导出');
    const sim = simulateStRegexReplace(replace, { match: STATUS_TAG });
    if (sim !== replace) {
        const i = firstDiff(replace, sim);
        const near = replace.slice(Math.max(0, i - 20), i + 30).replace(/\n/g, '⏎');
        throw new StatusBarExportError(`状态栏界面经过酒馆正则替换后会被改写（位置 ${i} 附近：${near}），已阻止导出。请去掉 $数字、$<、{{…}} 宏或 <user>/<char> 这类占位符`, [near]);
    }
    return replace;
}

/**
 * 卡片的五条局部正则（data.extensions.regex_scripts）。
 * 1 状态栏显示（仅格式显示，maxDepth 来自 options.showDepth）2 提示词里去掉占位符 3 提示词里去掉更新块（minDepth 来自 options.keepUpdateDepth）
 * 4/5 折叠更新块（流式中 / 完成）——options.foldUpdate 关闭时不生成。
 * 界面有错误（lintStatusHtml 的 errors；bind 模式检查的就是 compileStatusDocument 实际嵌入的 cleanFragment 结果）
 * 或替换串不能往返时抛 StatusBarExportError。
 */
export function buildStatusRegexScripts(card) {
    const sb = card.statusBar || {};
    const ids = sb.ids || {};
    const opt = { ...defaultStatusBarOptions(null), ...(sb.options || {}) };
    if (sb.mode === 'bind' || sb.mode === 'raw') {
        const { errors } = lintStatusHtml(sb.html, { mode: sb.mode });
        if (errors.length) throw new StatusBarExportError(`状态栏界面有 ${errors.length} 个问题，已阻止导出：${errors.join('；')}。请在「状态栏」里修复，或关闭状态栏后再导出`, errors);
    }
    const replace = buildStatusRegexReplace(compileStatusDocument(card));
    const out = [
        regexScript(ids.regexBar, REGEX_NAMES.bar, STATUS_TAG, replace, { placement: [2], markdownOnly: true, runOnEdit: true, maxDepth: showDepthToMaxDepth(opt.showDepth) }),
        regexScript(ids.regexHideTag, REGEX_NAMES.hideTag, '/\\s*<StatusPlaceHolderImpl\\/>/g', '', { placement: [2], promptOnly: true }),
        regexScript(ids.regexStrip, REGEX_NAMES.strip, '/<(update(?:variable)?)>(?:(?!.*<\\/\\1>)(?:(?!<\\1>).)*$|(?:(?!<\\1>).)*<\\/\\1?>)/gsi', '', { placement: [1, 2], promptOnly: true, minDepth: keepUpdateDepthToMinDepth(opt.keepUpdateDepth) }),
    ];
    if (opt.foldUpdate !== false) {
        out.push(
            regexScript(ids.regexFoldStreaming, REGEX_NAMES.foldStreaming, '/<(update(?:variable)?)>(?!.*<\\/\\1>)\\s*((?:(?!<\\1>).)*)\\s*$/gsi', '\n\n<details>\n<summary>变量更新中…</summary>\n$2\n</details>\n', { placement: [1, 2], markdownOnly: true }),
            regexScript(ids.regexFoldDone, REGEX_NAMES.foldDone, '/<(update(?:variable)?)>\\s*((?:(?!<\\1>).)*)\\s*<\\/\\1>/gsi', '\n\n<details>\n<summary>变量更新</summary>\n$2\n</details>\n', { placement: [1, 2], markdownOnly: true }),
        );
    }
    return out;
}

// ---------------- 角色脚本（酒馆助手） ----------------

function scriptEntry(id, name, content, info) {
    return { type: 'script', enabled: true, name, id, content: scriptSafe(content), info, button: { enabled: true, buttons: [] }, data: {}, export_with: { data: true, button: true } };
}

/**
 * data.extensions.tavern_helper（对象形式，需要酒馆助手 4.6.0+）：两个启用的角色脚本——MVU 加载器与变量结构。
 * 每条都写全 type/enabled（默认是 false）与 button.buttons（空数组，MVU 自己会追加按钮），
 * 因为酒馆助手只要有一条不合法就会把整个脚本列表清空。
 * @param {object} card
 * @param {{mvuUrl?: string, zodUrl?: string}} urls 通常就是 settings.statusBar
 */
export function buildTavernHelper(card, urls = {}) {
    const sb = card.statusBar || {};
    const ids = sb.ids || {};
    const mvuUrl = safeUrl(urls.mvuUrl, DEFAULT_STATUS_BAR.mvuUrl);
    const schema = overrideText(sb.overrides?.schemaScript) ?? compileSchemaScript(sb.spec, { zodUrl: urls.zodUrl });
    return {
        scripts: [
            scriptEntry(ids.scriptMvu, 'MVU', `import '${mvuUrl}';`, 'MVU 变量框架（NovelLoom 生成）'),
            scriptEntry(ids.scriptSchema, '变量结构', schema, '变量结构由 NovelLoom 根据变量表生成；请在 NovelLoom 中修改后重新导出'),
        ],
        variables: {},
    };
}

// ---------------- 卡片导出的附加内容 ----------------

/** 开场白末尾加状态栏占位标签（已有则不重复加） */
export function withStatusTag(text) {
    const s = String(text ?? '');
    if (s.includes(STATUS_TAG)) return s;
    const t = s.trimEnd();
    return t ? `${t}\n\n${STATUS_TAG}` : STATUS_TAG;
}

export const STATUS_USAGE_NOTE_MARK = '【状态栏使用说明】';

/** 追加到作者备注的使用说明 */
export function statusBarUsageNote() {
    return [
        `${STATUS_USAGE_NOTE_MARK}本卡带 MVU 变量状态栏（由 NovelLoom 生成），需要：`,
        '1. 安装酒馆助手（JS-Slash-Runner）4.6 或更高版本，并允许本卡的角色脚本（首次打开会询问；拒绝过的话到 酒馆助手 → 脚本库 → 角色脚本 里启用）；',
        '2. 允许本卡的局部正则（首次打开时酒馆会询问）；',
        '3. 导入卡片时接受「导入内嵌世界书」，否则变量更新规则不会生效；',
        '4. 使用聊天补全（Chat Completion）接口。',
    ].join('\n');
}

/** extensions.novel_loom.statusBar：NovelLoom 重新导入这张卡时用来还原状态栏 */
export function statusBarMeta(card) {
    const sb = card.statusBar || {};
    return {
        version: STATUS_BAR_VERSION,
        mode: sb.mode || 'bind',
        templateId: sb.templateId ?? null,
        theme: sb.theme || 'clean',
        spec: cloneJson(sb.spec || { title: '状态栏', variables: [] }),
        html: sb.html || '',
        options: cloneJson(sb.options || {}),
        portraits: normalizePortraits(sb.portraits),
    };
}

// ---------------- 界面代码检查 ----------------

const LEGACY_MARKER_RE = /<(?:user|bot|char|group|charifnotgroup)>/i;

const JS_DANGER = [
    [/\bfetch\s*\(/, '网络请求（fetch）'],
    [/\bXMLHttpRequest\b|\bWebSocket\b|\bEventSource\b|\bsendBeacon\b/, '网络请求（XHR/WebSocket）'],
    [/\b(?:window\s*\.\s*)?(?:parent|top|opener)\s*(?:\.|\[)/, '访问上层页面（parent/top/opener）'],
    [/\b(?:localStorage|sessionStorage|indexedDB)\b|document\s*\.\s*cookie/, '本地存储或 Cookie'],
    [/\beval\s*\(|\bnew\s+Function\b|\bFunction\s*\(|\bset(?:Timeout|Interval)\s*\(\s*['"]/, '动态执行代码（eval/Function）'],
    [/\bimport\s*\(|^\s*import\s/m, 'import 模块'],
    [/\b(?:triggerSlash|generate|generateRaw|setChatMessages?|createChatMessages|deleteChatMessages|replaceVariables|insertOrAssignVariables|insertVariables|updateVariablesWith|deleteVariable|setVariables|replaceMvuData|replaceScriptButtons)\s*\(/, '会修改聊天或变量的接口'],
    [/\b(?:TavernHelper|SillyTavern)\b/, '直接访问酒馆对象'],
];

const EVENT_ATTR_RE = /^on[a-z]+$/i;
const BAD_URL_TEXT_RE = /\b(?:java|vb)script\s*:|\bdata\s*:\s*text\/html/i;
const URL_NAMED = { colon: ':', tab: '', newline: '', nbsp: '', amp: '&', lpar: '(', rpar: ')', sol: '/', period: '.' };

function isSpace(c) {
    return c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f';
}

/**
 * 所有开始标签的属性 [{name, value}]，按浏览器的规则切分（引号只在 = 之后才开始属性值，属性值里的 > 不结束标签），线性时间。
 * 不区分标签所在的位置：脚本字符串里拼出来的标签、注释里的标签也会被找出来（检查宁严勿松）。
 */
function tagAttrs(html) {
    const out = [];
    const n = html.length;
    let i = 0;
    while ((i = html.indexOf('<', i)) !== -1) {
        i++;
        if (!/[a-zA-Z]/.test(html[i] || '')) continue;
        while (i < n && !isSpace(html[i]) && html[i] !== '/' && html[i] !== '>') i++; // 标签名
        while (i < n) {
            while (i < n && (isSpace(html[i]) || html[i] === '/')) i++;
            if (i >= n || html[i] === '>') break;
            const start = i++;
            while (i < n && !isSpace(html[i]) && html[i] !== '/' && html[i] !== '>' && html[i] !== '=') i++;
            const name = html.slice(start, i).toLowerCase();
            let j = i;
            while (j < n && isSpace(html[j])) j++;
            let value = '';
            if (html[j] === '=') {
                j++;
                while (j < n && isSpace(html[j])) j++;
                const q = html[j];
                if (q === '"' || q === "'") {
                    const end = html.indexOf(q, j + 1);
                    value = html.slice(j + 1, end === -1 ? n : end);
                    j = end === -1 ? n : end + 1;
                } else {
                    const s = j;
                    while (j < n && !isSpace(html[j]) && html[j] !== '>') j++;
                    value = html.slice(s, j);
                }
                i = j;
            }
            out.push({ name, value });
        }
    }
    return out;
}

/** URL 里会被浏览器忽略（或可能被忽略）的字符：C0 控制符与空格、DEL~NBSP、各种 Unicode 空白与零宽字符 */
function urlIgnorable(cp) {
    return cp <= 0x20 || (cp >= 0x7f && cp <= 0xa0) || cp === 0x1680 || cp === 0x180e || (cp >= 0x2000 && cp <= 0x200f)
        || cp === 0x2028 || cp === 0x2029 || cp === 0x205f || cp === 0x3000 || cp === 0xfeff;
}

/** 浏览器解析属性里的 URL 时会解码实体（分号可省）并忽略空白与控制字符：按同样的方式还原后再检查协议 */
function urlText(value) {
    return String(value ?? '')
        .replace(/&#[xX]([0-9a-fA-F]{1,7});?|&#(\d{1,8});?/g, (m, hex, dec) => {
            const cp = hex !== undefined ? parseInt(hex, 16) : parseInt(dec, 10);
            return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : '';
        })
        .replace(/&([a-z]+);?/gi, (m, name) => URL_NAMED[name.toLowerCase()] ?? m)
        .replace(/[^]/gu, (c) => (urlIgnorable(c.codePointAt(0)) ? '' : c))
        .toLowerCase();
}

function isBadUrl(value) {
    return /^(?:javascript|vbscript):|^data:text\/html/.test(urlText(value));
}

function scriptTexts(html, attrs) {
    const out = [];
    for (const m of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi)) out.push(m[1]);
    for (const a of attrs) {
        if (EVENT_ATTR_RE.test(a.name)) out.push(a.value);
        else if (isBadUrl(a.value)) out.push(urlText(a.value));
    }
    for (const m of html.matchAll(/javascript:[^"'\s>]*/gi)) out.push(m[0]);
    return out.join('\n');
}

/** 内联事件属性（onclick=… 有没有引号都算）：标签里逐个属性找，再在去掉脚本/样式内容后的文字里兜底找一遍 */
function hasEventAttr(html, attrs) {
    if (attrs.some((a) => EVENT_ATTR_RE.test(a.name))) return true;
    const markup = html.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '');
    return /(?:^|[\s"'/])on[a-z]+\s*=/im.test(markup);
}

function hasBadUrl(html, attrs) {
    return BAD_URL_TEXT_RE.test(html) || attrs.some((a) => isBadUrl(a.value));
}

function bindingPaths(html) {
    const out = [];
    for (const m of html.matchAll(/data-nl-(?:text|bar|stage|show|each)\s*=\s*("([^"]*)"|'([^']*)')/gi)) out.push(m[2] ?? m[3] ?? '');
    return out;
}

function knownPath(spec, path) {
    const vars = spec?.variables || [];
    return vars.some((v) => v.path === path || v.path.startsWith(`${path}.`) || (v.type === 'record' && path.startsWith(`${v.path}.`)));
}

/**
 * 检查状态栏 HTML。errors 会阻止导出，warnings 只提示。
 * - 所有模式都是错误：$数字/$<（酒馆正则替换会吞掉）、{{…}} 宏（只允许 {{user}}/{{char}}）、```（会结束代码块）、
 *   <user>/<char>/<bot> 等旧式占位符、\{ / \}（宏引擎会去掉反斜杠）、<script> 标签不成对
 * - bind/auto（AI 或内置生成）是错误、raw（用户自己粘贴）只是警告：网络请求、访问 parent/top、本地存储、eval、
 *   import、外部脚本、内嵌页面、会修改聊天或变量的酒馆助手接口
 * - 只在 bind/auto 是错误（绑定运行时用不到它们）：onclick= 这类内联事件属性（有没有引号都算）、javascript: / vbscript: / data:text/html 地址
 * - 警告：vh 单位、position:fixed、外部图片/样式、体积过大；bind 模式下的 <html>/<head>/<body>、没有任何绑定、绑定了变量表里没有的路径
 * bind 模式检查的是 cleanFragment 之后的片段、raw 模式检查的是去掉外层代码块的文档——也就是 compileStatusDocument 实际嵌入的那一段。
 * @param {string} html bind 模式是片段，raw 模式是完整文档
 * @param {{mode?: 'bind'|'raw'|'auto', spec?: object}} opt
 * @returns {{errors: string[], warnings: string[]}}
 */
export function lintStatusHtml(html, { mode = 'bind', spec = null } = {}) {
    const errors = [];
    const warnings = [];
    const original = String(html ?? '');
    // 检查 compileStatusDocument 实际放进文档的那段文字：bind 是清理后的片段，raw 是去掉外层代码块的文档
    const s = mode === 'bind' ? cleanFragment(original) : mode === 'raw' ? unwrapStatusFence(original.trim()) : original;
    const strict = mode !== 'raw';
    const danger = strict ? errors : warnings;
    if (!s.trim()) {
        if (mode === 'raw') errors.push('自定义 HTML 为空');
        else if (mode === 'bind') warnings.push('界面代码为空，将使用内置排版');
        return { errors, warnings };
    }
    if (/\$(\d|<)/.test(s)) errors.push('出现了 $ 加数字或 $<（例如 $1），酒馆正则替换时会被换掉；jQuery 的 $( 不受影响');
    if (/\{\{(?!\s*(?:user|char)\s*\}\})/i.test(s)) errors.push('出现了 {{…}} 宏（只允许 {{user}} 和 {{char}}），酒馆会在显示前替换它');
    if (s.includes('```')) errors.push('出现了 ```，会提前结束状态栏所在的代码块');
    if (LEGACY_MARKER_RE.test(s)) errors.push('出现了 <user>、<char>、<bot> 这类旧式占位符，酒馆会把它换成名字；需要名字请写 {{user}} / {{char}}');
    if (/\\[{}]/.test(s)) errors.push('出现了 \\{ 或 \\}，酒馆的宏引擎会去掉花括号前的反斜杠（正则里请改用 [{] / [}] 或 \\x7b / \\x7d）');
    const opens = (s.match(/<script\b/gi) || []).length;
    const closes = (s.match(/<\/script\s*>/gi) || []).length;
    if (opens !== closes) errors.push('<script> 标签不成对（脚本里的字符串不能直接写 </script>）');

    const attrs = tagAttrs(s);
    const js = scriptTexts(s, attrs);
    for (const [re, label] of JS_DANGER) if (re.test(js)) danger.push(`脚本里有${label}`);
    if (/<script\b[^>]*\bsrc\s*=/i.test(s)) danger.push('引用了外部脚本（<script src>）');
    if (/<script\b[^>]*\btype\s*=\s*["']?module/i.test(s)) danger.push('使用了 <script type="module">');
    if (/<(?:iframe|object|embed|frame)\b/i.test(s)) danger.push('内嵌了其他页面（iframe/object/embed）');
    if (strict && hasEventAttr(s, attrs)) errors.push('出现了 onclick= 这类内联事件属性，状态栏界面不需要它们；要响应点击请在 <script> 里用 addEventListener');
    if (strict && hasBadUrl(s, attrs)) errors.push('出现了 javascript: / vbscript: / data:text/html 地址，状态栏界面不需要它们');
    if (/<(?:link|img|video|audio|source)\b[^>]*\b(?:src|href)\s*=\s*["']?\s*(?:https?:)?\/\//i.test(s) || /url\(\s*["']?\s*(?:https?:)?\/\//i.test(s) || /@import\b/i.test(s)) {
        warnings.push('引用了外部图片或样式，网络不通时会加载失败');
    }
    if (/\d(?:\.\d+)?vh\b/i.test(s)) warnings.push('使用了 vh 单位：消息里的界面高度随内容自动变化，vh 容易让高度异常');
    if (/position\s*:\s*fixed/i.test(s)) warnings.push('使用了 position: fixed：在消息里的界面中会错位');
    if (s.length > 60000) warnings.push(`界面代码有 ${Math.round(s.length / 1000)}K 字符，每条显示状态栏的消息都会带一份`);

    if (mode === 'bind') {
        if (/<!doctype|<html[\s>]|<head[\s>]|<body[\s>]/i.test(original)) warnings.push('绑定模式只需要片段，<html>/<head>/<body> 会被自动去掉');
        const paths = bindingPaths(s);
        if (!paths.length && !/nlRender|data-nl-(?:group|portrait)\b/.test(s)) warnings.push('没有任何 data-nl-* 绑定或 nlRender，界面不会显示变量');
        if (spec?.variables?.length) {
            const unknown = uniqStrings(paths.filter((p) => p && !knownPath(spec, p)));
            if (unknown.length) warnings.push(`绑定了变量表里没有的路径：${unknown.join('、')}`);
        }
    }
    if (mode === 'raw' && !/stat_data|getAllVariables|getVariables|Mvu|format_message_variable/.test(s)) {
        warnings.push('没有读取 stat_data / getAllVariables / Mvu，可能不会显示变量');
    }
    return { errors: uniqStrings(errors), warnings: uniqStrings(warnings) };
}

// ---------------- 变量校验（与编译出的 zod 结构等价，供预览/模拟用） ----------------

function parseLeafValue(v, value, path, errors) {
    const fail = (msg) => {
        errors.push(`${path}：${msg}`);
        return undefined;
    };
    const x = value === undefined ? cloneJson(v.init) : value;
    switch (v.type) {
        case 'number': {
            const n = typeof x === 'object' && x !== null && !Array.isArray(x) ? NaN : Number(x);
            if (!Number.isFinite(n)) return fail(`不是数字：${JSON.stringify(x)}`);
            return coerceNumber(n, v);
        }
        case 'enum':
            return typeof x === 'string' && v.options.includes(x) ? x : fail(`只能是 ${v.options.join('/')}，收到 ${JSON.stringify(x)}`);
        case 'boolean': {
            const b = x === 'true' || x === '是' ? true : x === 'false' || x === '否' ? false : x;
            return typeof b === 'boolean' ? b : fail(`不是是/否：${JSON.stringify(x)}`);
        }
        case 'list': {
            if (!Array.isArray(x)) return fail('不是列表');
            const out = [];
            for (const item of x) {
                const s = typeof item === 'number' || typeof item === 'boolean' ? String(item) : item;
                if (typeof s !== 'string') return fail(`列表项不是文本：${JSON.stringify(item)}`);
                out.push(s);
            }
            return v.maxItems ? out.slice(-v.maxItems) : out;
        }
        case 'record': {
            if (!isPlainObj(x)) return fail('不是记录（对象）');
            const out = {};
            for (const [k, item] of Object.entries(x)) {
                const r = parseRecordItem(v.value, item, `${path}.${k}`, errors);
                if (r === undefined) return undefined;
                out[k] = r;
            }
            return out;
        }
        default: {
            const s = typeof x === 'number' || typeof x === 'boolean' ? String(x) : x;
            return typeof s === 'string' ? s : fail(`不是文本：${JSON.stringify(x)}`);
        }
    }
}

/** 记录值（或其中的分组）：与 z.object({…}).prefault({}) 一致——缺失时按 {} 补默认值，不是对象时报错，未知键丢弃 */
function parseFieldsObject(fields, item, path, errors) {
    const src = item === undefined ? {} : item;
    if (!isPlainObj(src)) {
        errors.push(`${path}：不是对象`);
        return undefined;
    }
    const out = {};
    for (const f of fields) {
        const r = f.type === 'object'
            ? parseFieldsObject(f.fields || [], src[f.key], `${path}.${f.key}`, errors)
            : parseLeafValue(f, src[f.key], `${path}.${f.key}`, errors);
        if (r === undefined) return undefined;
        out[f.key] = r;
    }
    return out;
}

function parseRecordItem(val, item, path, errors) {
    if (val.type === 'number') return parseLeafValue({ ...val, type: 'number', init: val.init ?? 0 }, item, path, errors);
    if (val.type === 'object') return parseFieldsObject(val.fields, item, path, errors);
    return parseLeafValue({ type: 'string', init: '' }, item, path, errors);
}

function parseBranch(node, value, path, errors, loose) {
    const src = value === undefined ? {} : value;
    if (!isPlainObj(src)) {
        errors.push(`${path || '（根）'}：不是对象`);
        return undefined;
    }
    const out = loose ? { ...src } : {};
    for (const [key, child] of node.children) {
        const p = path ? `${path}.${key}` : key;
        const r = child.leaf ? parseLeafValue(child.leaf, src[key], p, errors) : parseBranch(child, src[key], p, errors, false);
        if (r === undefined) return undefined;
        out[key] = r;
    }
    return out;
}

/**
 * 用变量表校验并规整一份 stat_data，结果与 MVU 里 registerMvuSchema(Schema) 的效果一致：
 * 缺失字段补初始值，数字夹取/取整，选项值必须在 options 里，嵌套分组丢弃未知键（第一层保留未知键）。
 * @returns {{ok: boolean, data: object|null, errors: string[]}}
 */
export function parseStateWithSpec(spec, data) {
    const errors = [];
    const out = parseBranch(buildTree(spec), data, '', errors, true);
    return out === undefined ? { ok: false, data: null, errors } : { ok: true, data: out, errors };
}

// ---------------- JSON Patch（预览里的“模拟一轮更新”） ----------------

function patchSegments(path) {
    const p = String(path ?? '');
    if (!p || p === '/') return [];
    return p.replace(/^\//, '').split('/').map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~'));
}

function getSegs(obj, segs) {
    let cur = obj;
    for (const s of segs) {
        if (cur === null || cur === undefined || typeof cur !== 'object') return undefined;
        cur = cur[s];
    }
    return cur;
}

function hasSegs(obj, segs) {
    if (!segs.length) return true;
    const parent = getSegs(obj, segs.slice(0, -1));
    return parent !== null && typeof parent === 'object' && Object.prototype.hasOwnProperty.call(parent, segs[segs.length - 1]);
}

function setSegs(obj, segs, value) {
    let cur = obj;
    segs.forEach((s, i) => {
        if (i === segs.length - 1) {
            cur[s] = value;
            return;
        }
        if (cur[s] === null || typeof cur[s] !== 'object') cur[s] = {};
        cur = cur[s];
    });
}

function removeSegs(obj, segs) {
    const parent = getSegs(obj, segs.slice(0, -1));
    const last = segs[segs.length - 1];
    if (Array.isArray(parent)) parent.splice(Number(last), 1);
    else delete parent[last];
}

function applyOne(state, op) {
    const kind = String(op?.op ?? '').toLowerCase();
    const segs = patchSegments(op.path ?? op.to);
    if (segs.some((s) => s.startsWith('_'))) throw new Error('只读变量（_ 开头）不能更新');
    switch (kind) {
        case 'replace': {
            if (!segs.length) {
                if (!isPlainObj(op.value)) throw new Error('根路径只能替换成对象');
                return cloneJson(op.value);
            }
            setSegs(state, segs, cloneJson(op.value));
            return state;
        }
        case 'delta': {
            const cur = getSegs(state, segs);
            if (typeof cur !== 'number') throw new Error(`不能对非数字（${cur === undefined ? '不存在' : typeof cur}）做 delta`);
            const d = Number(op.value);
            if (!Number.isFinite(d)) throw new Error('delta 的值不是数字');
            setSegs(state, segs, cur + d);
            return state;
        }
        case 'insert':
        case 'add': {
            if (!segs.length) throw new Error('insert 需要路径');
            const parentSegs = segs.slice(0, -1);
            const key = segs[segs.length - 1];
            let container = parentSegs.length ? getSegs(state, parentSegs) : state;
            if (container === undefined || container === null) {
                container = key === '-' || /^\d+$/.test(key) ? [] : {};
                setSegs(state, parentSegs, container);
            }
            if (Array.isArray(container)) {
                const idx = key === '-' ? container.length : Number(key);
                if (!Number.isInteger(idx) || idx < 0 || idx > container.length) throw new Error(`数组下标不对：${key}`);
                container.splice(idx, 0, cloneJson(op.value));
            } else if (isPlainObj(container)) container[key] = cloneJson(op.value);
            else throw new Error('insert 的目标不是对象或数组');
            return state;
        }
        case 'remove': {
            if (!segs.length || !hasSegs(state, segs)) throw new Error('要删除的路径不存在');
            removeSegs(state, segs);
            return state;
        }
        case 'move': {
            const from = patchSegments(op.from);
            if (!from.length || !hasSegs(state, from)) throw new Error('move 的来源路径不存在');
            if (from.some((s) => s.startsWith('_'))) throw new Error('只读变量（_ 开头）不能移动');
            if (!segs.length) throw new Error('move 需要目标路径');
            const value = getSegs(state, from);
            removeSegs(state, from);
            setSegs(state, segs, value);
            return state;
        }
        default:
            throw new Error(`不支持的操作：${op?.op}`);
    }
}

/**
 * 按 MVU 的规则把 JSON Patch 应用到一份 stat_data（不修改传入的对象）。
 * 支持 replace / delta（仅数字）/ insert|add（路径末尾 /- 追加到数组）/ remove / move（from + to|path）；
 * 路径里任一段以 _ 开头的操作被忽略（只读）。传入 spec 时每步之后按变量表校验，校验失败的操作整条作废（MVU 也是这样）。
 * @returns {{state: object, applied: number, errors: string[]}}
 */
export function applyJsonPatch(state, ops, { spec = null } = {}) {
    let cur = cloneJson(isPlainObj(state) ? state : {});
    const errors = [];
    let applied = 0;
    (Array.isArray(ops) ? ops : []).forEach((op, i) => {
        const label = `第 ${i + 1} 条（${op?.op ?? '?'} ${op?.path ?? op?.to ?? ''}）`;
        try {
            let next = applyOne(cloneJson(cur), op);
            if (spec) {
                const r = parseStateWithSpec(spec, next);
                if (!r.ok) throw new Error(r.errors.join('；'));
                next = r.data;
            }
            cur = next;
            applied++;
        } catch (e) {
            errors.push(`${label}：${e.message}`);
        }
    });
    return { state: cur, applied, errors };
}

/** MVU 的 isJsonPatch（src/util.ts）：数组，且每一项都是带字符串 op 与 path（move 可以只有 to）的对象；不满足时 MVU 忽略整个块 */
function jsonPatchShapeProblem(patch) {
    if (!Array.isArray(patch)) return '内容不是 JSON 数组';
    const i = patch.findIndex((op) => !(isPlainObj(op) && typeof op.op === 'string' && (typeof op.path === 'string' || (op.op === 'move' && typeof op.to === 'string'))));
    return i < 0 ? '' : `第 ${i + 1} 项不是合法的 JSON Patch 操作（需要字符串 op 与 path）`;
}

function snippet(s, max = 40) {
    const t = String(s ?? '').replace(/\s+/g, ' ').trim();
    return t.length > max ? `${t.slice(0, max)}…` : t;
}

/**
 * 从一条 AI 回复里取出所有 <JSONPatch>/<json_patch> 块（与 MVU 的识别方式一致，可带 ``` 代码块；坏掉的 JSON 先尝试修复）。
 * @returns {{ops: object[], blocks: number, failures: {kind: 'json'|'shape', text: string, message: string}[]}}
 *   blocks：找到的块数；failures：找到了但用不了的块——kind 'json' 内容不是合法的 JSON，kind 'shape' 不是 JSON Patch 数组（MVU 会忽略整个块）
 */
export function parseJsonPatchBlocks(text) {
    const ops = [];
    const failures = [];
    let blocks = 0;
    const re = /<(json_?patch)>(?:\s*```.*)?((?:(?!<json_?patch>)[\s\S])*?)(?:```\s*)?<\/\1>/gim;
    for (const m of String(text ?? '').matchAll(re)) {
        blocks++;
        const body = m[2].trim();
        let parsed;
        try {
            parsed = JSON.parse(body);
        } catch (e) {
            try {
                parsed = extractJson(body);
            } catch {
                failures.push({ kind: 'json', text: body, message: body ? e.message : '块是空的' });
                continue;
            }
        }
        const problem = jsonPatchShapeProblem(parsed);
        if (problem) failures.push({ kind: 'shape', text: body, message: problem });
        else ops.push(...parsed);
    }
    return { ops, blocks, failures };
}

/** 从一条 AI 回复里取出所有 <JSONPatch>/<json_patch> 块的操作（解析失败的块被跳过；要知道失败原因用 parseJsonPatchBlocks） */
export function extractJsonPatch(text) {
    return parseJsonPatchBlocks(text).ops;
}

/**
 * 预览“模拟一轮更新”：从回复里取 JSONPatch 并应用到示例变量。
 * 没有任何块时报「没有找到」；找到了但解析不了的块逐个报原因（不会再误报成「没有找到」）。
 * @returns {{state: object, applied: number, errors: string[], ops: object[], failures: object[]}}
 */
export function applyReplyToState(state, text, { spec = null } = {}) {
    const { ops, blocks, failures } = parseJsonPatchBlocks(text);
    const r = applyJsonPatch(state, ops, { spec });
    const notes = failures.map((f) => (f.kind === 'json'
        ? `找到了 <JSONPatch> 块，但内容不是合法的 JSON：${f.message}${f.text ? `（块内容：${snippet(f.text)}）` : ''}`
        : `找到了 <JSONPatch> 块，但${f.message}，MVU 会忽略整个块${f.text ? `（块内容：${snippet(f.text)}）` : ''}`));
    if (!blocks) notes.push('回复里没有找到 <JSONPatch> 块');
    r.errors.unshift(...notes);
    return { ...r, ops, failures };
}
