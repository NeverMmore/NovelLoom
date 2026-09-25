// 通用工具函数（纯函数为主，便于单元测试）

export function escapeHtml(text) {
    return String(text ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

export function uid(prefix = '') {
    const rnd = Math.random().toString(36).slice(2, 8);
    return `${prefix}${Date.now().toString(36)}${rnd}`;
}

export function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
        const t = setTimeout(resolve, ms);
        if (signal) {
            if (signal.aborted) {
                clearTimeout(t);
                reject(abortError());
                return;
            }
            signal.addEventListener('abort', () => {
                clearTimeout(t);
                reject(abortError());
            }, { once: true });
        }
    });
}

export function abortError(message = '已停止') {
    const e = new Error(message);
    e.name = 'AbortError';
    return e;
}

export function isAbortError(e) {
    return e?.name === 'AbortError' || /aborted|cancel/i.test(String(e?.message || ''));
}

/** 粗略 token 估算：中日韩字符按 1，其他按 4 字符 1 token */
export function estimateTokens(text) {
    const s = String(text || '');
    let cjk = 0;
    for (const ch of s) {
        const c = ch.codePointAt(0);
        if ((c >= 0x4e00 && c <= 0x9fff) || (c >= 0x3400 && c <= 0x4dbf) || (c >= 0x3040 && c <= 0x30ff) || (c >= 0xac00 && c <= 0xd7af) || (c >= 0xff00 && c <= 0xffef) || (c >= 0x3000 && c <= 0x303f)) cjk++;
    }
    return Math.ceil(cjk + (s.length - cjk) / 4);
}

export function formatDuration(ms) {
    const s = Math.max(0, Math.round(ms / 1000));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    if (h) return `${h}时${m}分`;
    if (m) return `${m}分${sec}秒`;
    return `${sec}秒`;
}

export function formatNumber(n) {
    n = Number(n) || 0;
    if (n >= 10000) return `${(n / 10000).toFixed(1)}万`;
    return String(n);
}

export function clamp(v, min, max) {
    return Math.min(max, Math.max(min, v));
}

export function debounce(fn, wait = 500) {
    let t = null;
    const wrapped = (...args) => {
        clearTimeout(t);
        t = setTimeout(() => fn(...args), wait);
    };
    wrapped.flush = (...args) => {
        clearTimeout(t);
        return fn(...args);
    };
    wrapped.cancel = () => clearTimeout(t);
    return wrapped;
}

export function isPlainObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** 用默认值补齐缺失字段，保留用户已有值与未知字段 */
export function mergeDefaults(target, defaults) {
    const out = isPlainObject(target) ? target : {};
    for (const [k, v] of Object.entries(defaults)) {
        if (out[k] === undefined) {
            out[k] = structuredCloneSafe(v);
        } else if (isPlainObject(v) && isPlainObject(out[k])) {
            mergeDefaults(out[k], v);
        }
    }
    return out;
}

export function structuredCloneSafe(v) {
    if (v === undefined) return undefined;
    try {
        return structuredClone(v);
    } catch {
        return JSON.parse(JSON.stringify(v));
    }
}

/** FNV-1a 32bit，用于内容指纹（非安全用途） */
export function hashString(str) {
    let h = 0x811c9dc5;
    const s = String(str ?? '');
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(16).padStart(8, '0');
}

const CN_DIGITS = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
const CN_UNITS = { 十: 10, 百: 100, 千: 1000, 万: 10000 };

/** 中文数字转整数：“一百二十三” → 123；纯阿拉伯/全角数字也支持 */
export function chineseNumToInt(str) {
    if (str == null) return NaN;
    let s = String(str).trim().replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xfee0));
    if (/^\d+$/.test(s)) return parseInt(s, 10);
    let total = 0;
    let section = 0;
    let number = 0;
    let seen = false;
    for (const ch of s) {
        if (ch in CN_DIGITS) {
            number = CN_DIGITS[ch];
            seen = true;
        } else if (ch in CN_UNITS) {
            const unit = CN_UNITS[ch];
            seen = true;
            if (unit === 10000) {
                section = (section + number) * unit;
                total += section;
                section = 0;
            } else {
                section += (number || 1) * unit;
            }
            number = 0;
        } else {
            return NaN;
        }
    }
    return seen ? total + section + number : NaN;
}

/** 自然排序比较（支持中文数字） */
export function naturalCompare(a, b) {
    const re = /(\d+|[零〇一二两三四五六七八九十百千万]+)/g;
    const ax = String(a).split(re);
    const bx = String(b).split(re);
    for (let i = 0; i < Math.min(ax.length, bx.length); i++) {
        if (ax[i] === bx[i]) continue;
        const an = chineseNumToInt(ax[i]);
        const bn = chineseNumToInt(bx[i]);
        if (!isNaN(an) && !isNaN(bn)) return an - bn;
        return ax[i].localeCompare(bx[i], 'zh');
    }
    return ax.length - bx.length;
}

export function uniq(arr) {
    return [...new Set((arr || []).filter((x) => x !== undefined && x !== null && String(x).trim() !== '').map((x) => String(x).trim()))];
}

export function truncate(text, max) {
    const s = String(text ?? '');
    return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** 规范化文本用于引用比对：去除空白差异、统一引号 */
export function normalizeForMatch(text) {
    return String(text ?? '')
        .replace(/[\s　]+/g, '')
        .replace(/[“”「」『』"]/g, '"')
        .replace(/[‘’']/g, "'")
        .replace(/…+/g, '…')
        .replace(/\.{3,}/g, '…');
}

export function downloadFile(content, filename, type = 'application/json') {
    const blob = content instanceof Blob ? content : new Blob([content], { type: `${type};charset=utf-8` });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function safeFileName(name, fallback = 'untitled') {
    const s = String(name || '').replace(/[\\/:*?"<>|\n\r\t]/g, '_').trim();
    return s || fallback;
}

export function pickFile(accept = '*/*', { multiple = false } = {}) {
    return new Promise((resolve) => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = accept;
        input.multiple = multiple;
        input.style.display = 'none';
        input.addEventListener('change', () => {
            const files = [...(input.files || [])];
            input.remove();
            resolve(multiple ? files : files[0] || null);
        });
        document.body.appendChild(input);
        input.click();
    });
}

export function readFileAsText(file) {
    return new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result));
        r.onerror = () => reject(r.error);
        r.readAsText(file, 'utf-8');
    });
}

export function readFileAsArrayBuffer(file) {
    return new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(r.result);
        r.onerror = () => reject(r.error);
        r.readAsArrayBuffer(file);
    });
}

/** 并发信号量 */
export class Semaphore {
    constructor(max) {
        this.max = Math.max(1, max | 0);
        this.active = 0;
        this.queue = [];
    }
    async acquire(signal) {
        if (this.active < this.max) {
            this.active++;
            return;
        }
        await new Promise((resolve, reject) => {
            const item = { resolve, reject };
            this.queue.push(item);
            signal?.addEventListener('abort', () => {
                const i = this.queue.indexOf(item);
                if (i >= 0) this.queue.splice(i, 1);
                reject(abortError());
            }, { once: true });
        });
        this.active++;
    }
    release() {
        this.active--;
        const next = this.queue.shift();
        if (next) next.resolve();
    }
    async run(fn, signal) {
        await this.acquire(signal);
        try {
            return await fn();
        } finally {
            this.release();
        }
    }
}

/** 简单的事件总线 */
export class Emitter {
    constructor() {
        this.map = new Map();
    }
    on(evt, fn) {
        if (!this.map.has(evt)) this.map.set(evt, new Set());
        this.map.get(evt).add(fn);
        return () => this.off(evt, fn);
    }
    off(evt, fn) {
        this.map.get(evt)?.delete(fn);
    }
    emit(evt, ...args) {
        for (const fn of [...(this.map.get(evt) || [])]) {
            try {
                fn(...args);
            } catch (e) {
                console.error('[NovelLoom] listener error', e);
            }
        }
    }
    clear() {
        this.map.clear();
    }
}
