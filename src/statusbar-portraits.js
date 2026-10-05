// 状态栏立绘（card.statusBar.portraits）：用户配置的图片地址、解锁条件与按字段取图的图池。
// 纯函数，只依赖 statusbar-base.js：statusbar.js（编辑 / 导出）与 statusbar-runtime.js（编译进文档的 NL_PORTRAITS）都从这里取。
// 立绘是 NovelLoom 的配置，不是 AI 写的界面代码：地址只允许 http(s) 与较小的 data:image，编译时经 jsLit 转义写进文档，
// 由受信任的 NL 运行时读取（data-nl-portrait / data-nl-portrait-next），所以界面检查不把它们当作外部资源。

import { isPlainObj } from './statusbar-base.js';

/** 单张 data:image 地址的最大长度（字符数，约 24KB 的图片） */
export const PORTRAIT_DATA_URL_MAX = 32768;
/** 一张卡所有 data:image 地址合计的最大长度（超出的部分丢弃并提示） */
export const PORTRAIT_DATA_TOTAL_MAX = 196608;
/** http(s) 地址的最大长度 */
export const PORTRAIT_URL_MAX = 2048;
/** 数量上限：角色数、每个角色的图片数、图池数、每个图池的取值数、每个取值（及兜底）的图片数 */
export const PORTRAIT_LIMITS = Object.freeze({ characters: 60, images: 12, pools: 8, values: 24, poolImages: 12 });
/** 解锁条件允许的比较方式 */
export const PORTRAIT_OPS = ['>=', '<=', '=='];

const OP_ALIASES = { '>=': '>=', '≥': '>=', '=>': '>=', '<=': '<=', '≤': '<=', '=<': '<=', '==': '==', '=': '==', '===': '==' };
const DATA_IMAGE_RE = /^data:image\/(?:png|jpe?g|gif|webp|avif|bmp);base64,[A-Za-z0-9+/]+={0,2}$/i;
const HTTP_URL_RE = /^https?:\/\/[^\s"'`<>\\{}|^]+$/i;
const PROTO_NAMES = ['__proto__', 'constructor', 'prototype'];

/** 空的立绘配置 */
export function emptyPortraits() {
    return { characters: {}, pools: [] };
}

/**
 * 检查一个立绘地址，合法时返回空串，否则返回中文原因。
 * 只允许 http(s)://（不含空白、引号、尖括号、反斜杠、花括号等）与不超过 PORTRAIT_DATA_URL_MAX 字的 base64 data:image（png/jpeg/gif/webp/avif/bmp，不含 svg）。
 */
export function portraitUrlProblem(url) {
    const s = String(url ?? '').trim();
    if (!s) return '地址为空';
    if (/^data:/i.test(s)) {
        if (!DATA_IMAGE_RE.test(s)) return '只支持 base64 编码的 png / jpeg / gif / webp / avif / bmp 图片（data:image/…;base64,…）';
        if (s.length > PORTRAIT_DATA_URL_MAX) return `内嵌图片太大（${Math.round(s.length / 1024)}K 字，最多 ${Math.round(PORTRAIT_DATA_URL_MAX / 1024)}K）：请改用图床地址`;
        return '';
    }
    if (!/^https?:\/\//i.test(s)) return '只支持 http:// 或 https:// 开头的图片地址';
    if (s.length > PORTRAIT_URL_MAX) return `地址太长（最多 ${PORTRAIT_URL_MAX} 字）`;
    if (!HTTP_URL_RE.test(s)) return '地址里有空白、引号、尖括号、花括号或反斜杠';
    return '';
}

function text(v, max) {
    const s = String(v ?? '').replace(/\{\{[^{}]*\}\}/g, '').replace(/[{}<>`]/g, '').replace(/\s+/g, ' ').trim();
    return max > 0 && s.length > max ? s.slice(0, max) : s;
}

/** 立绘的角色名（记录的键或固定分组名）：去掉首尾空白，1~32 字，不含控制字符与 . / 引号等，不能是原型名 */
export function portraitNameProblem(name) {
    const s = String(name ?? '').trim();
    if (!s) return '名字为空';
    if (s.length > 32) return `「${s.slice(0, 12)}…」太长（最多 32 字）`;
    if (/[\u0000-\u001f\u007f./~"'`<>{}[\]\\]/.test(s)) return `「${s}」含有不允许的字符`;
    if (PROTO_NAMES.includes(s)) return `「${s}」是保留名`;
    return '';
}

/** 点路径（解锁条件的 path、图池的 record / field）：1~maxSegs 段，每段非空、不含 / ~ 引号 尖括号 花括号 方括号 反斜杠 */
function pathProblem(path, maxSegs) {
    const s = String(path ?? '').trim();
    if (!s) return '路径为空';
    const segs = s.split('.');
    if (segs.length > maxSegs) return `「${s}」超过 ${maxSegs} 层`;
    for (const seg of segs) {
        if (!seg || seg !== seg.trim()) return `「${s}」有空的路径段`;
        if (seg.length > 32 || /[/~"'`<>{}[\]\\\t\r\n]/.test(seg) || PROTO_NAMES.includes(seg)) return `「${s}」含有不允许的字符`;
    }
    return '';
}

/** 文字写的解锁条件最多几个字（路径最多 4 段、值最多 32 字，正常写法远短于此；更长的当作看不懂） */
export const PORTRAIT_WHEN_TEXT_MAX = 80;
// 文字条件里的比较符：同一位置先试长的（=== 不会被读成 == 加上值「= …」）
const WHEN_TEXT_OPS = ['===', '>=', '<=', '==', '=>', '=<', '≥', '≤', '='];

/**
 * 拆开 "好感 >= 60" 这样的文字条件：取最靠左、两边都不为空的比较符（逐位置用 startsWith 比较，线性时间，
 * 不用带重叠量词的正则——超长的空白串会让那种正则回溯成平方级）。拆不开时返回 null。
 */
function parseWhenText(s) {
    const t = s.trim();
    for (let i = 1; i < t.length; i++) {
        for (const op of WHEN_TEXT_OPS) {
            if (!t.startsWith(op, i)) continue;
            const path = t.slice(0, i).trim();
            const value = t.slice(i + op.length).trim();
            if (path && value) return { path, op, value };
        }
    }
    return null;
}

/** 解锁条件：{path, op, value} 或 "好感 >= 60" 这样的文字；无效时返回 null 并写 warnings */
function normWhen(raw, warnings, where) {
    if (raw === undefined || raw === null || raw === '') return null;
    let src = raw;
    if (typeof src === 'string') {
        const m = src.length > PORTRAIT_WHEN_TEXT_MAX ? null : parseWhenText(src);
        if (!m) {
            warnings.push(`${where}的解锁条件「${text(src.slice(0, 60), 30)}」看不懂，已去掉（写法如：好感 >= 60）`);
            return null;
        }
        src = m;
    }
    if (!isPlainObj(src)) return null;
    const path = String(src.path ?? '').trim().replace(/^\/+/, '').replace(/\//g, '.');
    const problem = pathProblem(path, 4);
    const op = OP_ALIASES[String(src.op ?? '>=').trim()];
    if (problem || !op) {
        warnings.push(`${where}的解锁条件无效（${problem || `不支持的比较「${String(src.op ?? '').trim().slice(0, 8)}」，只能用 >= <= ==`}），已去掉`);
        return null;
    }
    if (op === '==') {
        const value = typeof src.value === 'string' ? text(src.value, 32) : src.value === undefined || src.value === null ? '' : String(src.value);
        return { path, op, value };
    }
    const n = typeof src.value === 'boolean' || src.value === null || src.value === '' ? NaN : Number(src.value);
    if (!Number.isFinite(n)) {
        warnings.push(`${where}的解锁条件「${path} ${op} ${text(src.value, 12)}」需要数字，已去掉`);
        return null;
    }
    return { path, op, value: n };
}

/** 一组图片：每项是地址字符串或 {url, label?, when?}；withMeta 为 false 时只要地址（图池） */
function normImages(list, ctx, where, { withMeta = true, max = PORTRAIT_LIMITS.images } = {}) {
    const out = [];
    const src = Array.isArray(list) ? list : list === undefined || list === null || list === '' ? [] : [list];
    for (const item of src) {
        const raw = isPlainObj(item) ? item : { url: item };
        const url = String(raw.url ?? raw.src ?? '').trim();
        const problem = portraitUrlProblem(url);
        if (problem) {
            ctx.warnings.push(`${where}的图片已丢弃：${problem}${url ? `（${url.slice(0, 40)}${url.length > 40 ? '…' : ''}）` : ''}`);
            continue;
        }
        if (/^data:/i.test(url)) {
            if (ctx.dataUsed + url.length > PORTRAIT_DATA_TOTAL_MAX) {
                ctx.warnings.push(`${where}的内嵌图片已丢弃：内嵌图片合计超过 ${Math.round(PORTRAIT_DATA_TOTAL_MAX / 1024)}K 字，请改用图床地址`);
                continue;
            }
            ctx.dataUsed += url.length;
        }
        if (!withMeta) {
            if (!out.includes(url)) out.push(url);
        } else {
            const img = { url };
            const label = text(raw.label ?? raw.name ?? raw.title, 16);
            if (label) img.label = label;
            const when = normWhen(raw.when ?? raw.unlock ?? raw.condition, ctx.warnings, where);
            if (when) img.when = when;
            out.push(img);
        }
        if (out.length >= max) {
            if (src.length > max) ctx.warnings.push(`${where}最多 ${max} 张图片，多出的已丢弃`);
            break;
        }
    }
    return out;
}

function normCharacters(raw, ctx) {
    let entries = [];
    if (Array.isArray(raw)) entries = raw.filter(isPlainObj).map((x) => [x.name ?? x.key, x.images ?? x.urls ?? x.list ?? []]);
    else if (isPlainObj(raw)) entries = Object.entries(raw);
    const out = {};
    for (const [name0, list] of entries) {
        if (Object.keys(out).length >= PORTRAIT_LIMITS.characters) {
            ctx.warnings.push(`立绘最多配置 ${PORTRAIT_LIMITS.characters} 个角色，多出的已丢弃`);
            break;
        }
        const name = String(name0 ?? '').trim();
        const problem = portraitNameProblem(name);
        if (problem) {
            ctx.warnings.push(`立绘的角色名无效：${problem}`);
            continue;
        }
        if (Object.prototype.hasOwnProperty.call(out, name)) {
            ctx.warnings.push(`立绘里「${name}」重复，已合并`);
        }
        const images = normImages(list, ctx, `「${name}」`);
        if (!images.length) continue;
        out[name] = [...(out[name] || []), ...images].slice(0, PORTRAIT_LIMITS.images);
    }
    return out;
}

function normPools(raw, ctx, spec) {
    const out = [];
    for (const p of Array.isArray(raw) ? raw : isPlainObj(raw) ? [raw] : []) {
        if (!isPlainObj(p)) continue;
        if (out.length >= PORTRAIT_LIMITS.pools) {
            ctx.warnings.push(`最多 ${PORTRAIT_LIMITS.pools} 个图池，多出的已丢弃`);
            break;
        }
        const record = String(p.record ?? p.path ?? '').trim().replace(/^\/+/, '').replace(/\//g, '.');
        const field = String(p.field ?? p.key ?? '').trim().replace(/\//g, '.');
        const problem = pathProblem(record, 3) || pathProblem(field, 2);
        if (problem) {
            ctx.warnings.push(`图池已丢弃：${problem}`);
            continue;
        }
        const where = `图池「${record} · ${field}」`;
        if (out.some((x) => x.record === record && x.field === field)) {
            ctx.warnings.push(`${where}重复，已丢弃后一个`);
            continue;
        }
        const pools = {};
        let n = 0;
        for (const [value0, list] of isPlainObj(p.pools) ? Object.entries(p.pools) : []) {
            const value = text(value0, 32);
            if (!value || PROTO_NAMES.includes(value)) continue;
            const urls = normImages(list, ctx, `${where}「${value}」`, { withMeta: false, max: PORTRAIT_LIMITS.poolImages });
            if (!urls.length) continue;
            pools[value] = [...(pools[value] || []), ...urls].slice(0, PORTRAIT_LIMITS.poolImages);
            if (++n >= PORTRAIT_LIMITS.values) break;
        }
        const fallback = normImages(p.fallback ?? p.default ?? [], ctx, `${where}的兜底`, { withMeta: false, max: PORTRAIT_LIMITS.poolImages });
        if (!Object.keys(pools).length && !fallback.length) continue;
        if (spec?.variables) {
            const v = spec.variables.find((x) => x.path === record);
            if (!v || v.type !== 'record') ctx.warnings.push(`${where}：变量表里没有记录变量「${record}」，暂时不会生效`);
        }
        out.push({ record, field, pools, fallback });
    }
    return out;
}

/**
 * 规范化立绘配置（card.statusBar.portraits）。
 * @param {object} raw {characters: {名字: [{url, label?, when?: {path, op: '>='|'<='|'==', value}}]}, pools: [{record, field, pools: {取值: [url]}, fallback: [url]}]}
 *   characters 也接受 [{name, images}]；图片也可以直接写地址字符串；when 也接受 "好感 >= 60" 这样的文字。
 * @param {{warnings?: string[], spec?: object}} opt warnings 收集丢弃/修正的原因；给了 spec 时提示图池指向的记录不存在
 * @returns {{characters: object, pools: object[]}}
 */
export function normalizePortraits(raw, { warnings = [], spec = null } = {}) {
    const src = isPlainObj(raw) ? raw : {};
    const ctx = { warnings, dataUsed: 0 };
    return {
        characters: normCharacters(src.characters ?? src.chars, ctx),
        pools: normPools(src.pools, ctx, spec),
    };
}

/** 是否配置了至少一张图（角色图片或图池） */
export function portraitsActive(p) {
    if (!isPlainObj(p)) return false;
    const chars = isPlainObj(p.characters) ? Object.values(p.characters) : [];
    if (chars.some((list) => Array.isArray(list) && list.length)) return true;
    return (Array.isArray(p.pools) ? p.pools : []).some((x) => isPlainObj(x) && ((Array.isArray(x.fallback) && x.fallback.length) || (isPlainObj(x.pools) && Object.values(x.pools).some((l) => Array.isArray(l) && l.length))));
}

/** 字符串的稳定哈希（与 NL 运行时里的 hashStr 一致：h = h × 31 + 码元，取 32 位后的绝对值） */
export function portraitHash(s) {
    let h = 0;
    const t = String(s ?? '');
    for (let i = 0; i < t.length; i++) h = ((h << 5) - h + t.charCodeAt(i)) | 0;
    return Math.abs(h);
}

/** 占位图上显示的字：名字的第一个字符（大写） */
export function portraitInitial(name) {
    const a = Array.from(String(name ?? '').trim());
    return a.length ? a[0].toUpperCase() : '?';
}

function condOk(c, entry, stat) {
    if (!c || !c.path) return true;
    const get = (obj, path) => String(path).split('.').reduce((cur, k) => (cur !== null && cur !== undefined && typeof cur === 'object' ? cur[k] : undefined), obj);
    let x = entry !== null && typeof entry === 'object' ? get(entry, c.path) : undefined;
    if (x === undefined) x = get(stat, c.path);
    if (c.op === '==') return String(x) === String(c.value);
    const n = Number(x);
    const m = Number(c.value);
    if (x === null || x === undefined || x === '' || typeof x === 'boolean' || !Number.isFinite(n) || !Number.isFinite(m)) return false;
    return c.op === '<=' ? n <= m : n >= m;
}

/**
 * 与 NL 运行时同样的取图逻辑（预览面板、测试用）：某个角色当前可用的图片与默认选中的那张。
 * 自己的图片按顺序过滤出已解锁的，默认是最后一张（“最高”解锁）；一张都没有时从图池里按 record + field 取，默认按名字稳定挑一张。
 * @param {object} portraits 规范化后的配置
 * @param {string} name 角色名（记录的键或固定分组名）
 * @param {{record?: string, stat?: object, saved?: string|null}} opt record：所在的记录路径；stat：当前变量；saved：用户手动选过的地址
 * @returns {{name: string, urls: string[], index: number, url: string, pooled: boolean}}
 */
export function resolvePortrait(portraits, name, { record = '', stat = {}, saved = null } = {}) {
    const p = isPlainObj(portraits) ? portraits : emptyPortraits();
    const own = (o, k) => isPlainObj(o) && Object.prototype.hasOwnProperty.call(o, k);
    const n = String(name ?? '').trim();
    const rec = record ? String(record).split('.').reduce((cur, k) => (cur !== null && cur !== undefined && typeof cur === 'object' ? cur[k] : undefined), stat) : undefined;
    const entry = record ? (own(rec, n) ? rec[n] : undefined) : own(stat, n) ? stat[n] : undefined;
    let list = own(p.characters, n) ? p.characters[n] : null;
    if (!list) {
        const k = Object.keys(p.characters || {}).find((x) => x.trim().toLowerCase() === n.toLowerCase());
        list = k ? p.characters[k] : [];
    }
    let urls = (list || []).filter((img) => img && img.url && condOk(img.when, entry, stat)).map((img) => img.url);
    let index = urls.length - 1;
    let pooled = false;
    if (!urls.length && record) {
        for (const pool of p.pools || []) {
            if (pool.record !== record) continue;
            const val = entry !== null && typeof entry === 'object' ? String(pool.field).split('.').reduce((cur, k) => (cur !== null && cur !== undefined && typeof cur === 'object' ? cur[k] : undefined), entry) : undefined;
            const hit = val !== undefined && val !== null && own(pool.pools, String(val)) ? pool.pools[String(val)] : pool.fallback;
            if (hit && hit.length) {
                urls = hit.slice();
                break;
            }
        }
        index = urls.length ? portraitHash(n) % urls.length : -1;
        pooled = urls.length > 0;
    }
    const s = saved === null || saved === undefined ? -1 : urls.indexOf(saved);
    if (s >= 0) index = s;
    return { name: n, urls, index, url: index >= 0 ? urls[index] : '', pooled };
}
