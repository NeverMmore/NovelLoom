// 状态栏立绘（card.statusBar.portraits）：用户配置的图片地址、解锁条件与按字段取图的图池。
// 纯函数，只依赖 statusbar-base.js：statusbar.js（编辑 / 导出）与 statusbar-runtime.js（编译进文档的 NL_PORTRAITS）都从这里取。
// 立绘是 NovelLoom 的配置，不是 AI 写的界面代码：地址只允许 http(s)、酒馆服务器上的图片（/user/images/…，「选择本地图片」上传的）
// 与 data:image（「嵌进卡片」压缩后的），编译时经 jsLit 转义写进文档，由受信任的 NL 运行时读取（data-nl-portrait / data-nl-portrait-next），
// 所以界面检查不把它们当作外部资源。

import { isPlainObj } from './statusbar-base.js';

/** 卡片里单张 data:image 地址的最大长度（字符数，约 96KB 的图片；「嵌进卡片」压缩到 512px 后通常远小于它） */
export const PORTRAIT_DATA_URL_MAX = 131072;
/** 一张卡所有 data:image 地址合计的最大长度（超出的部分丢弃并提示） */
export const PORTRAIT_DATA_TOTAL_MAX = 786432;
/**
 * 状态栏模板里的内嵌图片上限（比卡片小）：模板存在扩展设置里（酒馆的 settings.json，每次改设置都整份保存），
 * 大图请先存到酒馆服务器再存模板。TEMPLATE_PORTRAIT_LIMITS 展开后直接传给 normalizePortraits。
 */
export const TEMPLATE_PORTRAIT_DATA_URL_MAX = 32768;
export const TEMPLATE_PORTRAIT_DATA_TOTAL_MAX = 196608;
export const TEMPLATE_PORTRAIT_LIMITS = Object.freeze({ dataUrlMax: TEMPLATE_PORTRAIT_DATA_URL_MAX, dataTotalMax: TEMPLATE_PORTRAIT_DATA_TOTAL_MAX, scope: 'template' });
/** http(s) 地址与酒馆图片路径的最大长度 */
export const PORTRAIT_URL_MAX = 2048;
/** 酒馆服务器上的图片（POST /api/images/upload 存在 user/images/<文件夹>/ 下，GET /user/images/* 读取）：根相对路径的前缀 */
export const SERVER_IMAGE_PREFIX = '/user/images/';
/** 「选择本地图片」默认存到哪儿（settings.statusBar.portraitStore）：server = 酒馆服务器；embed = 压缩后嵌进卡片 */
export const PORTRAIT_STORE_MODES = ['server', 'embed'];
/** 数量上限：角色数、每个角色的图片数、图池数、每个图池的取值数、每个取值（及兜底）的图片数 */
export const PORTRAIT_LIMITS = Object.freeze({ characters: 60, images: 12, pools: 8, values: 24, poolImages: 12 });
/** 解锁条件允许的比较方式 */
export const PORTRAIT_OPS = ['>=', '<=', '=='];

const OP_ALIASES = { '>=': '>=', '≥': '>=', '=>': '>=', '<=': '<=', '≤': '<=', '=<': '<=', '==': '==', '=': '==', '===': '==' };
/** 合法的内嵌图片地址：base64 的 png / jpeg / gif / webp / avif / bmp（不含 svg） */
export const DATA_IMAGE_RE = /^data:image\/(?:png|jpe?g|gif|webp|avif|bmp);base64,[A-Za-z0-9+/]+={0,2}$/i;
const HTTP_URL_RE = /^https?:\/\/[^\s"'`<>\\{}|^]+$/i;
// 酒馆图片路径的一段：只有不需要编码的字符（字母、数字、- _ . ~）与 %XX 转义；中文、空格、引号等都要先编码（serverPortraitUrl）
const SERVER_SEG_RE = /^(?:[A-Za-z0-9\-_.~]|%[0-9A-Fa-f]{2})+$/;
const SERVER_EXT_RE = /\.(?:png|jpe?g|jfif|gif|webp|bmp)$/i;
const PROTO_NAMES = ['__proto__', 'constructor', 'prototype'];

/** 空的立绘配置 */
export function emptyPortraits() {
    return { characters: {}, pools: [] };
}

/**
 * 内嵌图片超限时的建议。状态栏模板里的上限更小（TEMPLATE_PORTRAIT_LIMITS）：要分享只能用图床地址
 * （酒馆服务器上的图不随模板走，改成内嵌又多半超过模板的上限），只在本机用才建议存到酒馆服务器。
 */
function dataHint(scope) {
    return scope === 'template' ? '要分享请改用图床地址；只在本机用可以在「立绘」页改存到酒馆服务器' : '请改用图床地址，或存到酒馆服务器';
}

/**
 * 酒馆图片路径（/user/images/<段>/…/<文件名>）的问题，合法时返回空串。
 * 每段非空、只有 URL 安全字符或 %XX 转义；解码后不能是 . / ..，也不能含 / \ % 或控制字符——
 * 酒馆读文件时会把路径解码两次（Express 一次、users.js createRouteHandler 再一次），所以 %252F、%2E%2E 这类写法一律拒绝；
 * 最后一段以图片扩展名结尾（png / jpg / jpeg / jfif / gif / webp / bmp，不分大小写）。
 */
export function serverPathProblem(url) {
    const s = String(url ?? '');
    if (!s.startsWith(SERVER_IMAGE_PREFIX)) return `酒馆图片的地址要以 ${SERVER_IMAGE_PREFIX} 开头`;
    if (s.length > PORTRAIT_URL_MAX) return `地址太长（最多 ${PORTRAIT_URL_MAX} 字）`;
    const segs = s.slice(SERVER_IMAGE_PREFIX.length).split('/');
    for (const seg of segs) {
        if (!seg) return '酒馆图片的路径里有空的一段';
        if (!SERVER_SEG_RE.test(seg)) return '酒馆图片的路径里有空白、引号、问号、# 或其他需要编码的字符';
        let dec;
        try {
            dec = decodeURIComponent(seg);
        } catch {
            return '酒馆图片的路径里有不完整的 %XX 编码';
        }
        if (dec === '.' || dec === '..') return '酒馆图片的路径里不能有 . 或 .. 这样的一段';
        if (/[/\\%\u0000-\u001f\u007f]/.test(dec)) return '酒馆图片的路径里有编码过的斜杠、反斜杠、% 或控制字符';
    }
    if (!SERVER_EXT_RE.test(segs[segs.length - 1])) return '酒馆图片要以 .png / .jpg / .jpeg / .jfif / .gif / .webp / .bmp 结尾';
    return '';
}

/** 路径的一段 → 地址里的写法：encodeURIComponent，再把它不编码的 ! ' ( ) * 也编码（地址里只剩字母、数字、- _ . ~ 与 %XX） */
function encodeSegment(seg) {
    return encodeURIComponent(seg).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/**
 * 酒馆上传接口返回的路径（{path: '/user/images/<文件夹>/<文件名>'，Windows 上也是正斜杠，没有编码）→ 存进配置的根相对地址：
 * 每一段 encodeSegment 编码。以酒馆返回的为准（它会按 sanitize-filename 改掉文件夹名和文件名里不允许的字符）。
 * 返回的路径不在 user/images 下、或编码后通不过 serverPathProblem（例如文件夹名里有 %）时返回 ''。
 */
export function serverPortraitUrl(responsePath) {
    const s = String(responsePath ?? '').replace(/\\/g, '/').replace(/^\/+/, '');
    const head = SERVER_IMAGE_PREFIX.slice(1);
    if (!s.startsWith(head)) return '';
    const segs = s.slice(head.length).split('/');
    if (segs.some((x) => !x || x === '.' || x === '..')) return '';
    const url = SERVER_IMAGE_PREFIX + segs.map(encodeSegment).join('/');
    return serverPathProblem(url) ? '' : url;
}

/**
 * 用户手填的酒馆图片路径 → 规范写法（serverPortraitUrl 的逐段编码），填的不是酒馆图片路径或没法规范时原样返回（去掉首尾空白）。
 * 接受 /user/images/… 或 user/images/…（不带 ? #）；每段先解码一次（已经编码过的不会编码两次），解码失败、
 * 解码后含 / \ % 的段不动（交给 portraitUrlProblem 报错）。这样从酒馆图库里抄来的路径——中文文件夹、空格、
 * 「生成图片」扩展起的带 @ 的文件名（角色名_2026-10-05@12h00m00s000ms.png）——不用自己编码也能用。
 */
export function normalizeServerPortraitInput(input) {
    const s = String(input ?? '').trim();
    const m = s.match(/^\/?user\/images\/(.+)$/);
    if (!m || /[?#]/.test(s)) return s;
    const segs = [];
    for (const seg of m[1].split('/')) {
        let dec;
        try {
            dec = decodeURIComponent(seg);
        } catch {
            return s;
        }
        if (!dec || /[/\\%]/.test(dec)) return s;
        segs.push(dec);
    }
    return serverPortraitUrl(SERVER_IMAGE_PREFIX + segs.join('/')) || s;
}

/** NovelLoom 自己上传的酒馆图片：文件名是内容哈希（nl_ + 16 位十六进制，见 portrait-image.js 的 serverImageName） */
export const NL_SERVER_IMAGE_RE = /\/nl_[0-9a-f]{16}\.(?:png|jpe?g|gif|webp|bmp)$/i;

/**
 * 是不是 NovelLoom 自己上传到酒馆服务器的图片（合法的 /user/images/… 路径，文件名 nl_<哈希>）。
 * 预览只替换这种：父页面带着登录信息去读、再交给沙箱里的界面代码，不能替导入的模板 / 卡片去读图库里别的文件。
 */
export function isOwnServerImage(url) {
    return portraitUrlKind(url) === 'server' && NL_SERVER_IMAGE_RE.test(String(url ?? '').trim());
}

/**
 * 检查一个立绘地址，合法时返回空串，否则返回中文原因。只允许：
 * - http(s)://（不含空白、引号、尖括号、反斜杠、花括号等）；
 * - 酒馆服务器上的图片 /user/images/…（见 serverPathProblem）；
 * - 不超过 dataUrlMax 字的 base64 data:image（png/jpeg/gif/webp/avif/bmp，不含 svg）。卡片默认 PORTRAIT_DATA_URL_MAX，模板更小。
 * @param {string} url
 * @param {{dataUrlMax?: number, scope?: 'card'|'template'}} [opt]
 */
export function portraitUrlProblem(url, { dataUrlMax = PORTRAIT_DATA_URL_MAX, scope = 'card' } = {}) {
    const s = String(url ?? '').trim();
    if (!s) return '地址为空';
    if (/^data:/i.test(s)) {
        if (!DATA_IMAGE_RE.test(s)) return '只支持 base64 编码的 png / jpeg / gif / webp / avif / bmp 图片（data:image/…;base64,…）';
        if (s.length > dataUrlMax) return `内嵌图片太大（${Math.round(s.length / 1024)}K 字，${scope === 'template' ? '模板里每张' : ''}最多 ${Math.round(dataUrlMax / 1024)}K）：${dataHint(scope)}`;
        return '';
    }
    if (s.startsWith('/')) return s.startsWith(SERVER_IMAGE_PREFIX) ? serverPathProblem(s) : '只支持 http(s) 图床地址、酒馆服务器上的图片（/user/images/…）或 data:image';
    if (!/^https?:\/\//i.test(s)) return '只支持 http:// 或 https:// 开头的图片地址、酒馆服务器上的图片（/user/images/…）或 data:image';
    if (s.length > PORTRAIT_URL_MAX) return `地址太长（最多 ${PORTRAIT_URL_MAX} 字）`;
    if (!HTTP_URL_RE.test(s)) return '地址里有空白、引号、尖括号、花括号或反斜杠';
    return '';
}

/**
 * 立绘地址存在哪儿：http = 图床；server = 酒馆服务器（/user/images/…）；embed = 嵌在卡片里（data:image）；'' = 不合法
 * @returns {'http'|'server'|'embed'|''}
 */
export function portraitUrlKind(url) {
    const s = String(url ?? '').trim();
    if (!s || portraitUrlProblem(s)) return '';
    return /^data:/i.test(s) ? 'embed' : s.startsWith(SERVER_IMAGE_PREFIX) ? 'server' : 'http';
}

/** settings.statusBar.portraitStore 的有效值：'embed' 或默认的 'server' */
export function portraitStoreOf(settings) {
    return settings?.statusBar?.portraitStore === 'embed' ? 'embed' : 'server';
}

/** 配置（规范化前后都行）里的全部图片地址，按出现顺序（同一张图用在几处就出现几次）：角色的图片、图池各取值的图片与兜底 */
export function portraitUrlList(p) {
    const out = [];
    const src = isPlainObj(p) ? p : {};
    const add = (x) => {
        const u = String(isPlainObj(x) ? x.url ?? x.src ?? '' : x ?? '').trim();
        if (u) out.push(u);
    };
    const chars = Array.isArray(src.characters) ? src.characters.map((c) => c?.images ?? []) : isPlainObj(src.characters) ? Object.values(src.characters) : [];
    for (const list of chars) for (const x of Array.isArray(list) ? list : [list]) add(x);
    for (const pool of Array.isArray(src.pools) ? src.pools : []) {
        if (!isPlainObj(pool)) continue;
        for (const list of isPlainObj(pool.pools) ? Object.values(pool.pools) : []) for (const x of Array.isArray(list) ? list : [list]) add(x);
        for (const x of Array.isArray(pool.fallback) ? pool.fallback : pool.fallback ? [pool.fallback] : []) add(x);
    }
    return out;
}

/**
 * 立绘按存放位置统计（「立绘」页的内嵌用量、分享提示用）：
 * server / embed / http 是不重复的图片张数；embedChars 是内嵌图片合计的字数，按出现次数算（与 normalizePortraits 的合计上限、
 * 编译进文档的 NL_PORTRAITS 一致：同一张内嵌图片用在两处占两份）。
 * @returns {{server: number, embed: number, http: number, embedChars: number}}
 */
export function portraitStorageStats(p) {
    const seen = { server: new Set(), embed: new Set(), http: new Set() };
    let embedChars = 0;
    for (const url of portraitUrlList(p)) {
        const kind = portraitUrlKind(url);
        if (!kind) continue;
        seen[kind].add(url);
        if (kind === 'embed') embedChars += url.length;
    }
    return { server: seen.server.size, embed: seen.embed.size, http: seen.http.size, embedChars };
}

/**
 * 有立绘存在酒馆服务器上时的分享提示（没有时返回 ''）：「导出」「立绘」分页、导出角色卡、存 / 导出模板时显示，不阻止操作。
 * 卡片：指明真正能改的按钮（「立绘」页顶部的「全部改成内嵌」、每张图旁边的「改成内嵌」；上面的存法切换只管之后选的图）。
 * 模板：内嵌图片的上限小得多（512px 的立绘通常放不下），所以建议改用图床地址。
 * @param {object} p 立绘配置
 * @param {'card'|'template'} [what] 分享的是卡还是模板
 */
export function serverPortraitHint(p, what = 'card') {
    const n = portraitStorageStats(p).server;
    if (!n) return '';
    return what === 'template'
        ? `${n} 张立绘存在酒馆服务器上，把模板导出分享给别人时不会跟着走，对方会看到首字占位；要分享请改用图床（http）地址，模板里只能内嵌 ${Math.round(TEMPLATE_PORTRAIT_DATA_URL_MAX / 1024)}K 字以内的小图`
        : `${n} 张立绘存在酒馆服务器上，把卡分享给别人时不会跟着走，对方会看到首字占位；要分享请在「立绘」页点「全部改成内嵌」（或每张图旁边的「改成内嵌」）`;
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
        const problem = portraitUrlProblem(url, ctx);
        if (problem) {
            ctx.warnings.push(`${where}的图片已丢弃：${problem}${url ? `（${url.slice(0, 40)}${url.length > 40 ? '…' : ''}）` : ''}`);
            continue;
        }
        if (/^data:/i.test(url)) {
            if (ctx.dataUsed + url.length > ctx.dataTotalMax) {
                ctx.warnings.push(`${where}的内嵌图片已丢弃：${ctx.scope === 'template' ? '模板里的' : ''}内嵌图片合计超过 ${Math.round(ctx.dataTotalMax / 1024)}K 字，${dataHint(ctx.scope)}`);
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
 * @param {{warnings?: string[], spec?: object, dataUrlMax?: number, dataTotalMax?: number, scope?: 'card'|'template'}} opt
 *   warnings 收集丢弃/修正的原因；给了 spec 时提示图池指向的记录不存在；
 *   dataUrlMax / dataTotalMax：内嵌图片每张、合计的上限（默认是卡片的；状态栏模板传 ...TEMPLATE_PORTRAIT_LIMITS，提示也换成模板的说法）
 * @returns {{characters: object, pools: object[]}}
 */
export function normalizePortraits(raw, { warnings = [], spec = null, dataUrlMax = PORTRAIT_DATA_URL_MAX, dataTotalMax = PORTRAIT_DATA_TOTAL_MAX, scope = 'card' } = {}) {
    const src = isPlainObj(raw) ? raw : {};
    const ctx = { warnings, dataUsed: 0, dataUrlMax, dataTotalMax, scope };
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

/**
 * 手动选的立绘记在本地存储里的值（与 NL 运行时里的 choiceId 一致）：地址本身；内嵌图片（data:）动辄几万字，
 * 记成 'nl#' + 哈希 + '.' + 长度（都是 36 进制），不把酒馆页面的本地存储塞满。旧版本记的完整 data: 地址照样认。
 */
export function portraitChoiceId(url) {
    const s = String(url ?? '');
    return /^data:/i.test(s) ? `nl#${portraitHash(s).toString(36)}.${s.length.toString(36)}` : s;
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
 * @param {{record?: string, stat?: object, saved?: string|null}} opt record：所在的记录路径；stat：当前变量；
 *   saved：用户手动选过的那张（本地存储里的值：地址，或内嵌图片的 portraitChoiceId）
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
    const s = saved === null || saved === undefined ? -1 : urls.findIndex((u) => u === saved || portraitChoiceId(u) === saved);
    if (s >= 0) index = s;
    return { name: n, urls, index, url: index >= 0 ? urls[index] : '', pooled };
}
