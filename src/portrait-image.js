// 立绘「选择本地图片」的纯逻辑（不碰 DOM / canvas，可在 node 里测试）：认出文件的真实格式、决定存到酒馆服务器时
// 原样上传还是重新编码、「嵌进卡片」的压缩计划（尺寸 + 质量阶梯）、内容哈希（同一张图只存一份）与上传用的文件夹名。
// 真正的解码、编码、上传在 ui/portrait-files.js。

/** 酒馆接受的图片格式（SillyTavern 1.19 src/constants.js 的 MEDIA_EXTENSIONS 里的图片部分；没有 avif / svg） */
export const ST_IMAGE_FORMATS = ['png', 'jpg', 'jpeg', 'jfif', 'webp', 'gif', 'bmp'];
/** 存到酒馆服务器时原样上传的条件：酒馆认的格式、不超过 4MB、最长边不超过 2048（GIF 动图也就保持会动） */
export const SERVER_RAW_MAX_BYTES = 4 * 1024 * 1024;
export const SERVER_RAW_MAX_SIDE = 2048;
/** 否则重新编码成 webp（浏览器不支持时 jpeg），最长边不超过 1600 */
export const SERVER_REENCODE_SIDE = 1600;
export const SERVER_REENCODE_QUALITY = 0.88;
/** 嵌进卡片：最长边 512，质量按 0.85 → 0.75 → 0.65 → 0.55 往下试，还放不下就把尺寸缩小（每次至少 ×0.8） */
export const EMBED_MAX_SIDE = 512;
export const EMBED_QUALITIES = Object.freeze([0.85, 0.75, 0.65, 0.55]);
export const EMBED_SHRINK = 0.8;
/** 缩到最长边小于这个还放不下就放弃（改存到酒馆服务器） */
export const EMBED_MIN_SIDE = 48;
/** 嵌进卡片时内嵌图片合计只剩这么多字以下就不再尝试 */
export const EMBED_MIN_BUDGET = 6144;
/** 选择的本地文件最大多少字节（再大就不读了，几十 MB 的图片多半是误选） */
export const LOCAL_IMAGE_MAX_BYTES = 40 * 1024 * 1024;

const ASCII = (bytes, start, text) => [...text].every((c, i) => bytes[start + i] === c.charCodeAt(0));

/**
 * 按文件开头的字节认出图片格式（不信文件名和浏览器给的 MIME）：
 * 'png' | 'jpg' | 'gif' | 'webp' | 'bmp' | 'avif' | 'heic' | 'svg'；认不出时 ''。
 * @param {Uint8Array|number[]} bytes 至少前 32 个字节
 */
export function sniffImageType(bytes) {
    const b = bytes || [];
    if (b.length >= 8 && b[0] === 0x89 && ASCII(b, 1, 'PNG') && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return 'png';
    if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg';
    if (b.length >= 6 && (ASCII(b, 0, 'GIF87a') || ASCII(b, 0, 'GIF89a'))) return 'gif';
    if (b.length >= 12 && ASCII(b, 0, 'RIFF') && ASCII(b, 8, 'WEBP')) return 'webp';
    if (b.length >= 12 && ASCII(b, 4, 'ftyp')) {
        const brand = String.fromCharCode(b[8], b[9], b[10], b[11]);
        if (brand === 'avif' || brand === 'avis') return 'avif';
        if (/^(?:heic|heix|hevc|heim|heis|mif1|msf1)$/.test(brand)) return 'heic';
    }
    if (b.length >= 2 && b[0] === 0x42 && b[1] === 0x4d) return 'bmp';
    // SVG 是文本：去掉 BOM 和空白后以 <svg 或 <?xml 开头
    let i = b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf ? 3 : 0;
    while (i < b.length && i < 64 && (b[i] === 0x20 || b[i] === 0x09 || b[i] === 0x0a || b[i] === 0x0d)) i++;
    if (b[i] === 0x3c && (ASCII(b, i, '<svg') || ASCII(b, i, '<?xml') || ASCII(b, i, '<!DOCTYPE svg'))) return 'svg';
    return '';
}

/** 格式 → MIME（预览时给没有类型的图片补上） */
export function imageMimeOf(format) {
    return { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', jfif: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', avif: 'image/avif' }[format] || '';
}

/**
 * 浏览器给的文件类型能不能当图片处理（没问题返回 ''）：只收 image/*，不收 SVG（矢量图里可以带脚本）。
 * 类型为空时先放过，读出字节后再按 sniffImageType 判断。
 */
export function imageFileTypeProblem(type) {
    const t = String(type ?? '').trim().toLowerCase();
    if (!t) return '';
    if (!t.startsWith('image/')) return '不是图片';
    if (t.includes('svg')) return '不支持 SVG 图片';
    return '';
}

/** 等比缩小到最长边不超过 maxSide（不放大），宽高取整、至少 1 */
export function fitSize(width, height, maxSide) {
    const w = Math.max(1, Math.round(Number(width) || 1));
    const h = Math.max(1, Math.round(Number(height) || 1));
    const side = Math.max(w, h);
    if (side <= maxSide) return { width: w, height: h };
    const k = maxSide / side;
    return { width: Math.max(1, Math.round(w * k)), height: Math.max(1, Math.round(h * k)) };
}

/**
 * 存到酒馆服务器：原样上传还是重新编码。
 * 酒馆认的格式（png / jpg / gif / webp / bmp）、不超过 SERVER_RAW_MAX_BYTES、最长边不超过 SERVER_RAW_MAX_SIDE → 原样上传（GIF 保持会动）；
 * 否则（avif / heic 等酒馆不收的格式、太大）重新编码成 webp，最长边不超过 SERVER_REENCODE_SIDE。
 * @param {{format: string, bytes: number, width: number, height: number}} info format 是 sniffImageType 的结果
 * @returns {{mode: 'raw', format: string} | {mode: 'encode', width: number, height: number, quality: number}}
 */
export function planServerImage({ format = '', bytes = 0, width = 0, height = 0 } = {}) {
    const side = Math.max(Number(width) || 0, Number(height) || 0);
    if (ST_IMAGE_FORMATS.includes(format) && bytes > 0 && bytes <= SERVER_RAW_MAX_BYTES && side > 0 && side <= SERVER_RAW_MAX_SIDE) {
        return { mode: 'raw', format: format === 'jpeg' || format === 'jfif' ? 'jpg' : format };
    }
    return { mode: 'encode', ...fitSize(width, height, SERVER_REENCODE_SIDE), quality: SERVER_REENCODE_QUALITY };
}

/**
 * 嵌进卡片的压缩计划：给出下一次编码的尺寸与质量（纯函数，调用方编码后把得到的 data: 地址长度交回来）。
 * 第一次：最长边缩到 maxSide，质量 0.85；超出 limit 时先按质量阶梯往下（0.75、0.65、0.55），
 * 质量到底后缩小尺寸：每次至少 ×0.8，超出很多时按「字数大致与面积成正比」一步缩到位（边长 × √(limit / 字数) × 0.95）。
 * @param {{width: number, height: number}} src 原图尺寸
 * @param {{width: number, height: number, quality: number, chars: number}|null} last 上一次尝试与它的 data: 地址长度；null = 第一次
 * @param {{limit: number, maxSide?: number, minSide?: number}} opt limit：这张图最多多少字
 * @returns {{width: number, height: number, quality: number}|null} null = 上一次已经够小，或缩到 minSide 以下也放不下
 */
export function nextEmbedAttempt(src, last, { limit, maxSide = EMBED_MAX_SIDE, minSide = EMBED_MIN_SIDE } = {}) {
    if (!last) return { ...fitSize(src?.width, src?.height, maxSide), quality: EMBED_QUALITIES[0] };
    if (last.chars <= limit) return null;
    const qi = EMBED_QUALITIES.indexOf(last.quality);
    if (qi >= 0 && qi < EMBED_QUALITIES.length - 1) return { width: last.width, height: last.height, quality: EMBED_QUALITIES[qi + 1] };
    const side = Math.max(last.width, last.height);
    const k = Math.max(0.25, Math.min(EMBED_SHRINK, Math.sqrt(limit / Math.max(1, last.chars)) * 0.95));
    const next = Math.floor(side * k);
    if (next < minSide) return null;
    return { ...fitSize(last.width, last.height, next), quality: last.quality };
}

/**
 * 字节内容的哈希：16 位十六进制（两路 32 位的 cyrb53 式混合，不需要安全上下文——局域网 http 打开的酒馆没有 crypto.subtle）。
 * 上传的文件名用它（nl_<哈希>），同一张图反复选择只存一份，文件名里也不会出现用户的原文件名。
 * @param {Uint8Array|number[]} bytes
 */
export function hashBytes(bytes) {
    const n = bytes?.length || 0;
    let h1 = 0xdeadbeef ^ n;
    let h2 = 0x41c6ce57 ^ n;
    for (let i = 0; i < n; i++) {
        const b = bytes[i];
        h1 = Math.imul(h1 ^ b, 2654435761);
        h2 = Math.imul(h2 ^ b, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (h2 >>> 0).toString(16).padStart(8, '0') + (h1 >>> 0).toString(16).padStart(8, '0');
}

/** 上传到酒馆的文件名（不含扩展名；酒馆按 format 补上）：nl_ + 内容哈希 */
export function serverImageName(bytes) {
    return `nl_${hashBytes(bytes)}`;
}

/**
 * 上传到酒馆时的文件夹名（ch_name）：卡片写进酒馆时的角色名，图片就在这个角色的「图库」里（酒馆的图库扩展按角色名找文件夹）。
 * 酒馆还会按 sanitize-filename 去掉 / ? < > \ : * | " 等字符；这里只把 % 换成 _（酒馆读文件时会把路径解码两次，带 % 的文件夹名读不出来），
 * 去掉控制字符，限制长度。
 */
export function imageFolderName(name) {
    return String(name ?? '').replace(/[\u0000-\u001f\u007f]/g, '').replace(/%/g, '_').trim().slice(0, 100);
}

/** 字节 → base64（分段转换，几 MB 的图片也不会撑爆参数个数） */
export function bytesToBase64(bytes) {
    let s = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) s += String.fromCharCode.apply(null, bytes.subarray ? bytes.subarray(i, i + CHUNK) : bytes.slice(i, i + CHUNK));
    return btoa(s);
}

/** base64 data: 地址 → {mime（小写）, bytes: Uint8Array}；不是 base64 的 data: 地址时返回 null。前缀不分大小写（与 DATA_IMAGE_RE 一致） */
export function dataUrlBytes(url) {
    const m = String(url ?? '').match(/^data:([^;,]+);base64,([A-Za-z0-9+/]*={0,2})$/i);
    if (!m) return null;
    const bin = atob(m[2]);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return { mime: m[1].toLowerCase(), bytes: out };
}

/** 字数 / 字节数的简短写法：1024 进制的 K（一位小数，≥ 100K 时取整），给内嵌图片的用量和标签用 */
export function fmtK(n) {
    const k = (Number(n) || 0) / 1024;
    if (k >= 100) return `${Math.round(k)}K`;
    return `${Math.max(0, Math.round(k * 10) / 10)}K`;
}
