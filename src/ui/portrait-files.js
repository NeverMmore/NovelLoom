// 立绘「选择本地图片」的浏览器部分：读文件、解码、缩放编码（canvas）、上传到酒馆服务器、嵌进卡片，
// 以及预览用的「酒馆图片 → data:image」替换（沙箱 iframe 里请求 /user/images/… 可能带不上登录信息）。
// 什么时候原样上传、怎么压缩由 portrait-image.js 的纯函数决定；这里只负责执行。

import {
    EMBED_MIN_BUDGET, LOCAL_IMAGE_MAX_BYTES, bytesToBase64, dataUrlBytes, fmtK, imageFileTypeProblem, imageMimeOf, nextEmbedAttempt,
    planServerImage, serverImageName, sniffImageType,
} from '../portrait-image.js';
import { DATA_IMAGE_RE, PORTRAIT_DATA_URL_MAX, isOwnServerImage, portraitUrlKind, serverPortraitUrl } from '../statusbar-portraits.js';
import { ImageUploadError, uploadImageToST } from '../stio.js';

/**
 * 处理本地图片失败。kind：type（不是图片 / SVG / 太大的文件）、decode（浏览器解不开）、encode（编码失败）、
 * upload（上传到酒馆失败，可以改成嵌进卡片）、fetch（从酒馆读图失败）、size（压到最小也放不下）、budget（内嵌合计已满）
 */
export class LocalImageError extends Error {
    constructor(kind, message) {
        super(message);
        this.name = 'LocalImageError';
        this.kind = kind;
    }
}

async function readBytes(blob) {
    return new Uint8Array(await blob.arrayBuffer());
}

/** Blob → data: 地址 */
export function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result));
        r.onerror = () => reject(r.error || new Error('读取失败'));
        r.readAsDataURL(blob);
    });
}

/** 先看浏览器给的类型，再按文件开头的字节认格式：不是图片、是 SVG、文件太大都拒绝。返回 {bytes, format} */
async function readImageFile(blob) {
    const typeProblem = imageFileTypeProblem(blob?.type);
    if (typeProblem) throw new LocalImageError('type', typeProblem);
    if (!blob?.size) throw new LocalImageError('type', '文件是空的');
    if (blob.size > LOCAL_IMAGE_MAX_BYTES) throw new LocalImageError('type', `文件太大（${(blob.size / 1048576).toFixed(1)}MB，最多 ${Math.round(LOCAL_IMAGE_MAX_BYTES / 1048576)}MB）`);
    const bytes = await readBytes(blob);
    const format = sniffImageType(bytes.subarray(0, 64));
    if (format === 'svg') throw new LocalImageError('type', '不支持 SVG 图片');
    return { bytes, format };
}

/** 解码成可以画到 canvas 上的图片：优先 createImageBitmap，不行再用 <img> */
async function decodeImage(blob) {
    if (typeof createImageBitmap === 'function') {
        try {
            return await createImageBitmap(blob);
        } catch { /* 换 <img> 再试一次 */ }
    }
    const url = URL.createObjectURL(blob);
    try {
        return await new Promise((resolve, reject) => {
            const img = new Image();
            img.onload = () => resolve(img);
            img.onerror = () => reject(new Error('decode'));
            img.src = url;
        });
    } catch {
        throw new LocalImageError('decode', '图片解码失败：浏览器打不开这个文件（可能已损坏，或者是 HEIC 这类浏览器不支持的格式）');
    } finally {
        URL.revokeObjectURL(url);
    }
}

function sizeOf(img) {
    return { width: img.naturalWidth || img.width || 0, height: img.naturalHeight || img.height || 0 };
}

function release(img) {
    try {
        img?.close?.();
    } catch { /* ImageBitmap 才有 close */ }
}

function canvasToBlob(canvas, type, quality) {
    return new Promise((resolve) => {
        try {
            canvas.toBlob((b) => resolve(b), type, quality);
        } catch {
            resolve(null);
        }
    });
}

let webpEncodes = null; // 浏览器能不能编码 webp（第一次编码后记下）

/** 缩放并编码：webp（浏览器不支持编码 webp 时 toBlob 会给出 png，这时改用白底 jpeg） */
async function encodeImage(img, width, height, quality) {
    const draw = (bg) => {
        const c = document.createElement('canvas');
        c.width = width;
        c.height = height;
        const g = c.getContext('2d');
        if (!g) throw new LocalImageError('encode', '浏览器不能编码图片（canvas 不可用）');
        if (bg) {
            g.fillStyle = bg;
            g.fillRect(0, 0, width, height);
        }
        g.imageSmoothingEnabled = true;
        g.imageSmoothingQuality = 'high';
        g.drawImage(img, 0, 0, width, height);
        return c;
    };
    if (webpEncodes !== false) {
        const blob = await canvasToBlob(draw(null), 'image/webp', quality);
        if (blob && blob.type === 'image/webp') {
            webpEncodes = true;
            return blob;
        }
        webpEncodes = false;
    }
    const jpeg = await canvasToBlob(draw('#ffffff'), 'image/jpeg', quality);
    if (!jpeg || jpeg.type !== 'image/jpeg') throw new LocalImageError('encode', '浏览器没能重新编码这张图片');
    return jpeg;
}

/**
 * 存到酒馆服务器：按 planServerImage 原样上传或重新编码，文件名是内容哈希（nl_…，同一张图只存一份），文件夹是角色名。
 * @param {Blob} blob 本地文件或从内嵌图片还原的图片
 * @param {{folder?: string}} opt folder：imageFolderName(卡片在酒馆里的角色名)
 * @returns {Promise<{url: string, format: string, bytes: number, reencoded: boolean, note: string}>} url：存进配置的根相对地址（/user/images/…，已编码）；
 *   note：要告诉用户的变化（GIF 动图太大、被重新编码成静态图时），没有时为 ''
 * @throws {LocalImageError}
 */
export async function storeImageOnServer(blob, { folder = '' } = {}) {
    const { bytes, format } = await readImageFile(blob);
    const img = await decodeImage(blob);
    let up = bytes;
    let ext = format;
    let reencoded = false;
    try {
        const plan = planServerImage({ format, bytes: bytes.length, ...sizeOf(img) });
        if (plan.mode === 'encode') {
            const out = await encodeImage(img, plan.width, plan.height, plan.quality);
            up = await readBytes(out);
            ext = out.type === 'image/webp' ? 'webp' : 'jpg';
            reencoded = true;
        } else ext = plan.format;
    } finally {
        release(img);
    }
    let path;
    try {
        path = await uploadImageToST({ base64: bytesToBase64(up), format: ext, folder, filename: serverImageName(up) });
    } catch (e) {
        throw new LocalImageError('upload', e instanceof ImageUploadError ? e.message : `上传失败：${e?.message || e}`);
    }
    const url = serverPortraitUrl(path);
    if (!url) throw new LocalImageError('upload', `酒馆返回的图片路径用不了：${String(path).slice(0, 80)}`);
    const note = reencoded && format === 'gif' ? 'GIF 动图超过 4MB 或最长边超过 2048，存到酒馆服务器时转成了静态图（只保留第一帧）' : '';
    return { url, format: ext, bytes: up.length, reencoded, note };
}

/**
 * 嵌进卡片：缩到最长边 512 编码成 webp（不支持时 jpeg），按 nextEmbedAttempt 的计划降质量、缩尺寸，直到 data: 地址不超过 limit。
 * @param {Blob} blob
 * @param {{limit?: number}} opt limit：这张最多多少字（单张上限与内嵌合计剩下的，取小的）
 * @returns {Promise<{url: string, width: number, height: number, quality: number, chars: number, note: string}>}
 * @throws {LocalImageError}
 */
export async function embedImage(blob, { limit = PORTRAIT_DATA_URL_MAX } = {}) {
    if (limit < EMBED_MIN_BUDGET) throw new LocalImageError('budget', '内嵌图片合计已经快到上限了：这张改存到酒馆服务器吧');
    const { format } = await readImageFile(blob);
    const img = await decodeImage(blob);
    const src = sizeOf(img);
    let best = null;
    try {
        let attempt = nextEmbedAttempt(src, null, { limit });
        for (let n = 0; attempt && n < 24; n++) {
            const out = await encodeImage(img, attempt.width, attempt.height, attempt.quality);
            const url = await blobToDataUrl(out);
            const res = { ...attempt, url, chars: url.length };
            if (url.length <= limit) {
                best = res;
                break;
            }
            attempt = nextEmbedAttempt(src, res, { limit });
        }
    } finally {
        release(img);
    }
    if (!best) throw new LocalImageError('size', `压缩到最小也超过 ${fmtK(limit)} 字：这张改存到酒馆服务器吧`);
    if (!DATA_IMAGE_RE.test(best.url)) throw new LocalImageError('encode', '浏览器编码出的图片格式不对');
    return { ...best, note: format === 'gif' ? 'GIF 动图嵌进卡片后只保留第一帧' : '' };
}

/** 读酒馆服务器上的图片（同源，带登录信息）；只认图片类型，没有类型时按字节补上 */
export async function fetchServerImage(url) {
    if (portraitUrlKind(url) !== 'server') throw new LocalImageError('fetch', '不是酒馆服务器上的图片');
    let res;
    try {
        res = await fetch(url, { credentials: 'same-origin' });
    } catch {
        throw new LocalImageError('fetch', '连不上酒馆服务器，读不到这张图');
    }
    if (!res.ok) throw new LocalImageError('fetch', res.status === 404 ? '酒馆服务器上找不到这张图（可能已经被删掉了）' : `读取酒馆服务器上的图片失败（HTTP ${res.status}）`);
    const blob = await res.blob();
    const type = String(blob.type || res.headers.get('content-type') || '').toLowerCase();
    if (type.includes('svg')) throw new LocalImageError('fetch', '不支持 SVG 图片');
    if (type.startsWith('image/')) return blob;
    const format = sniffImageType(new Uint8Array(await blob.slice(0, 64).arrayBuffer()));
    const mime = format === 'svg' ? '' : imageMimeOf(format);
    if (!mime) throw new LocalImageError('fetch', '酒馆返回的不是图片');
    return new Blob([blob], { type: mime });
}

/** 内嵌图片（data:image）→ Blob */
export function dataUrlToBlob(url) {
    const d = DATA_IMAGE_RE.test(String(url ?? '')) ? dataUrlBytes(url) : null;
    if (!d) throw new LocalImageError('type', '不是内嵌图片');
    return new Blob([d.bytes], { type: d.mime });
}

// ---------------- 预览：酒馆图片换成 data:image ----------------

const PREVIEW_RAW_MAX = 1.5 * 1024 * 1024; // 再大的图预览里缩小一下，免得 srcdoc 太长
const PREVIEW_SIDE = 1024;
const PREVIEW_CACHE_ENTRIES = 160;
const PREVIEW_CACHE_CHARS = 48 * 1024 * 1024;
const PREVIEW_RETRY_MS = 30000; // 读失败的图过一会儿再试
/** url → {value: data:image|null, at} ；Map 的插入顺序就是最近使用的顺序 */
const previewCache = new Map();
let previewCacheChars = 0;

function cacheSet(url, value) {
    const old = previewCache.get(url);
    if (old) {
        previewCacheChars -= old.value?.length || 0;
        previewCache.delete(url);
    }
    previewCache.set(url, { value, at: Date.now() });
    previewCacheChars += value?.length || 0;
    for (const [k, v] of previewCache) {
        if (previewCache.size <= PREVIEW_CACHE_ENTRIES && previewCacheChars <= PREVIEW_CACHE_CHARS) break;
        if (k === url) continue;
        previewCache.delete(k);
        previewCacheChars -= v.value?.length || 0;
    }
}

async function previewDataUrl(url) {
    if (!isOwnServerImage(url)) return null; // 只替自己上传的图去读（见 previewSrcMap）
    const hit = previewCache.get(url);
    if (hit && (hit.value || Date.now() - hit.at < PREVIEW_RETRY_MS)) {
        previewCache.delete(url);
        previewCache.set(url, hit);
        return hit.value;
    }
    let value = null;
    try {
        const blob = await fetchServerImage(url);
        if (blob.size <= PREVIEW_RAW_MAX) value = await blobToDataUrl(blob);
        else {
            const img = await decodeImage(blob);
            try {
                const s = sizeOf(img);
                const k = Math.min(1, PREVIEW_SIDE / Math.max(1, s.width, s.height));
                value = await blobToDataUrl(await encodeImage(img, Math.max(1, Math.round(s.width * k)), Math.max(1, Math.round(s.height * k)), 0.85));
            } finally {
                release(img);
            }
        }
        if (!DATA_IMAGE_RE.test(value)) value = null;
    } catch {
        value = null;
    }
    cacheSet(url, value);
    return value;
}

/**
 * 预览用：把这些地址里 NovelLoom 自己上传的酒馆图片（/user/images/…/nl_<哈希>.…，isOwnServerImage）在父页面取来，
 * 换成 data:image（buildPreviewSrcdoc 的 opts.srcMap）。只换自己上传的：父页面是带着登录信息去读的，读到的内容会交给
 * 沙箱里的界面代码（可能来自导入的模板 / 卡片），不能让它借此读到图库里别的文件、或者试探文件在不在。
 * 手填的其他酒馆路径和取不到的都不放进结果（预览里退回直接加载原路径）。结果按地址缓存在内存里（有条数和字数上限）。
 * @param {Iterable<string>} urls
 * @returns {Promise<Object<string, string>>}
 */
export async function previewSrcMap(urls) {
    const list = [...new Set(urls || [])].filter(isOwnServerImage);
    const out = {};
    let next = 0;
    const worker = async () => {
        while (next < list.length) {
            const u = list[next++];
            const v = await previewDataUrl(u);
            if (v) out[u] = v;
        }
    };
    await Promise.all(Array.from({ length: Math.min(4, list.length) }, worker));
    return out;
}
