// 测试用的极简 DOM：只实现 NL 运行时（statusbar-runtime.js 的 nlRuntime）用到的那部分，
// 外加一个够用的 HTML 解析器（标签、属性、文本、<template> 内容、<script>/<style> 原文、空元素）。
// 不是通用实现：选择器只支持 tag / .class / [attr] / [attr="v"] 的组合与逗号列表。
import vm from 'node:vm';

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const RAW = new Set(['script', 'style']);
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: String.fromCharCode(0xa0) };

function decode(s) {
    return String(s).replace(/&(?:#(\d+)|#[xX]([0-9a-fA-F]+)|([a-zA-Z]+));/g, (m, d, h, n) => {
        if (n) return ENT[n] ?? m;
        return String.fromCodePoint(d ? Number(d) : parseInt(h, 16));
    });
}

function compileCompound(one) {
    const tests = [];
    const re = /([a-zA-Z][\w-]*)|\.([\w-]+)|\[([\w-]+)(?:="([^"]*)")?\]|:not\(\[([\w-]+)\]\)/y;
    let pos = 0;
    while (pos < one.length) {
        re.lastIndex = pos;
        const m = re.exec(one);
        if (!m) throw new Error(`minidom：不支持的选择器 ${one}`);
        pos = re.lastIndex;
        const [, tag, cls, name, value, notName] = m;
        if (tag) tests.push((el) => el.tagName === tag.toUpperCase());
        else if (cls) tests.push((el) => el.classList.contains(cls));
        else if (name && value !== undefined) tests.push((el) => el.getAttribute(name) === value);
        else if (name) tests.push((el) => el.hasAttribute(name));
        else if (notName) tests.push((el) => !el.hasAttribute(notName));
    }
    return (el) => el.nodeType === 1 && tests.every((t) => t(el));
}

/** 选择器：逗号列表，每项是用空格分隔的后代选择器链（tag / .class / [attr] / [attr="v"] / :not([attr]) 的组合） */
function compileSelector(sel) {
    const parts = String(sel).split(',').map((s) => s.trim()).filter(Boolean).map((one) => {
        const chain = one.split(/\s+/).map(compileCompound);
        return (el) => {
            if (!chain[chain.length - 1](el)) return false;
            let k = chain.length - 2;
            for (let e = el.parentNode; e && k >= 0; e = e.parentNode) if (e.nodeType === 1 && chain[k](e)) k--;
            return k < 0;
        };
    });
    return (el) => el.nodeType === 1 && parts.some((p) => p(el));
}

class Node {
    constructor(type, doc) {
        this.nodeType = type;
        this.ownerDocument = doc;
        this.parentNode = null;
        this.childNodes = [];
    }

    get firstChild() {
        return this.childNodes[0] || null;
    }

    get nextSibling() {
        const sib = this.parentNode ? this.parentNode.childNodes : [];
        const i = sib.indexOf(this);
        return i >= 0 ? sib[i + 1] || null : null;
    }

    get children() {
        return this.childNodes.filter((c) => c.nodeType === 1);
    }

    get textContent() {
        return this.childNodes.map((c) => c.textContent).join('');
    }

    set textContent(v) {
        for (const c of this.childNodes) c.parentNode = null;
        this.childNodes = [];
        const s = String(v ?? '');
        if (s) this.appendChild(new Text(s, this.ownerDocument));
    }

    appendChild(n) {
        if (n.nodeType === 11) {
            for (const c of [...n.childNodes]) this.appendChild(c);
            return n;
        }
        if (n.parentNode) n.parentNode.removeChild(n);
        n.parentNode = this;
        this.childNodes.push(n);
        return n;
    }

    insertBefore(n, ref) {
        if (!ref) return this.appendChild(n);
        if (n.nodeType === 11) {
            for (const c of [...n.childNodes]) this.insertBefore(c, ref);
            return n;
        }
        if (n.parentNode) n.parentNode.removeChild(n);
        const i = this.childNodes.indexOf(ref);
        if (i < 0) throw new Error('minidom：insertBefore 的参照节点不是子节点');
        n.parentNode = this;
        this.childNodes.splice(i, 0, n);
        return n;
    }

    removeChild(n) {
        const i = this.childNodes.indexOf(n);
        if (i < 0) throw new Error('minidom：removeChild 的节点不是子节点');
        this.childNodes.splice(i, 1);
        n.parentNode = null;
        return n;
    }

    walk(fn) {
        for (const c of this.childNodes) {
            if (c.nodeType !== 1) continue;
            fn(c);
            c.walk(fn);
        }
    }

    querySelectorAll(sel) {
        const m = compileSelector(sel);
        const out = [];
        this.walk((el) => {
            if (m(el)) out.push(el);
        });
        return out;
    }

    querySelector(sel) {
        return this.querySelectorAll(sel)[0] || null;
    }
}

class Text extends Node {
    constructor(data, doc) {
        super(3, doc);
        this.data = String(data);
    }

    get textContent() {
        return this.data;
    }

    set textContent(v) {
        this.data = String(v ?? '');
    }

    cloneNode() {
        return new Text(this.data, this.ownerDocument);
    }
}

class Fragment extends Node {
    constructor(doc) {
        super(11, doc);
    }

    cloneNode(deep) {
        const f = new Fragment(this.ownerDocument);
        if (deep) for (const c of this.childNodes) f.appendChild(c.cloneNode(true));
        return f;
    }
}

class Element extends Node {
    constructor(tag, doc) {
        super(1, doc);
        this.tagName = String(tag).toUpperCase();
        this.attrs = new Map();
        this.listeners = {};
        const props = {};
        this.style = {
            props,
            setProperty: (k, v) => { props[k] = String(v); },
            getPropertyValue: (k) => props[k] ?? '',
        };
        if (this.tagName === 'TEMPLATE') this.content = new Fragment(doc);
        // <img>：测试里用 loadImage / failImage 模拟加载结果
        this.naturalWidth = 0;
        this.complete = false;
    }

    getAttribute(n) {
        return this.attrs.has(n) ? this.attrs.get(n) : null;
    }

    setAttribute(n, v) {
        this.attrs.set(n, String(v));
        if (this.tagName === 'IMG' && n === 'src') {
            this.complete = false;
            this.naturalWidth = 0;
        }
    }

    removeAttribute(n) {
        this.attrs.delete(n);
    }

    hasAttribute(n) {
        return this.attrs.has(n);
    }

    get hidden() {
        return this.hasAttribute('hidden');
    }

    set hidden(v) {
        if (v) this.setAttribute('hidden', '');
        else this.removeAttribute('hidden');
    }

    get alt() {
        return this.getAttribute('alt') ?? '';
    }

    set alt(v) {
        this.setAttribute('alt', v);
    }

    get className() {
        return this.getAttribute('class') ?? '';
    }

    set className(v) {
        this.setAttribute('class', v);
    }

    get classList() {
        const el = this;
        const list = () => el.className.split(/\s+/).filter(Boolean);
        return {
            contains: (c) => list().includes(c),
            add: (c) => { if (!list().includes(c)) el.className = [...list(), c].join(' '); },
            remove: (c) => { el.className = list().filter((x) => x !== c).join(' '); },
            toggle: (c, force) => {
                const on = force === undefined ? !list().includes(c) : !!force;
                if (on) el.classList.add(c);
                else el.classList.remove(c);
                return on;
            },
        };
    }

    get nextElementSibling() {
        const p = this.parentNode;
        if (!p) return null;
        const sib = p.childNodes;
        for (let i = sib.indexOf(this) + 1; i < sib.length; i++) if (sib[i].nodeType === 1) return sib[i];
        return null;
    }

    closest(sel) {
        const m = compileSelector(sel);
        for (let e = this; e && e.nodeType === 1; e = e.parentNode) if (m(e)) return e;
        return null;
    }

    addEventListener(type, fn, capture) {
        (this.listeners[type] ||= []).push({ fn, capture: !!(capture === true || capture?.capture) });
    }

    /** 直接触发本元素上的监听器（load / error 这类不冒泡的事件） */
    fire(type) {
        for (const l of this.listeners[type] || []) l.fn.call(this, { type, target: this });
    }

    cloneNode(deep) {
        const e = new Element(this.tagName, this.ownerDocument);
        for (const [k, v] of this.attrs) e.attrs.set(k, v);
        if (deep) for (const c of this.childNodes) e.appendChild(c.cloneNode(true));
        if (this.content) e.content = this.content.cloneNode(true);
        return e;
    }

    get outerHTML() {
        const attrs = [...this.attrs].map(([k, v]) => (v === '' ? ` ${k}` : ` ${k}="${v.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}"`)).join('');
        const tag = this.tagName.toLowerCase();
        if (VOID.has(tag)) return `<${tag}${attrs}>`;
        const inner = this.content ? this.content.childNodes : this.childNodes;
        return `<${tag}${attrs}>${inner.map((c) => (c.nodeType === 1 ? c.outerHTML : c.data)).join('')}</${tag}>`;
    }
}

class Document extends Node {
    constructor() {
        super(9, null);
        this.ownerDocument = this;
        this.readyState = 'complete';
        this.listeners = {};
        this.documentElement = new Element('html', this);
        this.body = new Element('body', this);
        this.documentElement.appendChild(this.body);
        this.appendChild(this.documentElement);
    }

    createElement(tag) {
        return new Element(tag, this);
    }

    createDocumentFragment() {
        return new Fragment(this);
    }

    addEventListener(type, fn, capture) {
        (this.listeners[type] ||= []).push({ fn, capture: !!(capture === true || capture?.capture) });
    }

    /** 模拟一次点击：document 的捕获监听 → 目标与祖先的监听（冒泡）→ document 的冒泡监听；stopPropagation 生效 */
    click(target) {
        let stopped = false;
        const ev = { type: 'click', target, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() { stopped = true; } };
        for (const l of this.listeners.click || []) if (l.capture && !stopped) l.fn.call(this, ev);
        for (let e = target; e && e !== this && !stopped; e = e.parentNode) {
            for (const l of e.listeners?.click || []) if (!stopped) l.fn.call(e, ev);
        }
        for (const l of this.listeners.click || []) if (!l.capture && !stopped) l.fn.call(this, ev);
        return ev;
    }
}

/** HTML 片段 → 节点，挂到 parent 下（<template> 的内容进 .content） */
export function parseInto(parent, html) {
    const doc = parent.ownerDocument;
    const stack = [parent];
    const top = () => stack[stack.length - 1];
    const container = (el) => (el.content ? el.content : el);
    const s = String(html);
    let i = 0;
    while (i < s.length) {
        if (s.startsWith('<!--', i)) {
            const end = s.indexOf('-->', i + 4);
            i = end < 0 ? s.length : end + 3;
            continue;
        }
        if (/^<![a-zA-Z]/.test(s.slice(i, i + 3))) {
            i = s.indexOf('>', i) + 1;
            continue;
        }
        const close = s.slice(i).match(/^<\/([a-zA-Z][\w-]*)\s*>/);
        if (close) {
            const tag = close[1].toUpperCase();
            for (let k = stack.length - 1; k > 0; k--) {
                const el = stack[k].nodeType === 11 ? null : stack[k];
                if (el && el.tagName === tag) {
                    stack.length = k;
                    break;
                }
            }
            i += close[0].length;
            continue;
        }
        const open = s.slice(i).match(/^<([a-zA-Z][\w-]*)/);
        if (open) {
            const tag = open[1].toLowerCase();
            const el = doc.createElement(tag);
            let j = i + open[0].length;
            for (;;) {
                while (j < s.length && /[\s/]/.test(s[j])) j++;
                if (j >= s.length || s[j] === '>') break;
                const nm = s.slice(j).match(/^[^\s/>=]+/)[0];
                j += nm.length;
                while (/\s/.test(s[j] || '')) j++;
                let val = '';
                if (s[j] === '=') {
                    j++;
                    while (/\s/.test(s[j] || '')) j++;
                    const q = s[j];
                    if (q === '"' || q === "'") {
                        const e = s.indexOf(q, j + 1);
                        val = s.slice(j + 1, e);
                        j = e + 1;
                    } else {
                        const m = s.slice(j).match(/^[^\s>]*/)[0];
                        val = m;
                        j += m.length;
                    }
                }
                el.attrs.set(nm.toLowerCase(), decode(val));
            }
            i = j + 1;
            container(top()).appendChild(el);
            if (RAW.has(tag)) {
                const end = s.toLowerCase().indexOf(`</${tag}`, i);
                const body = s.slice(i, end < 0 ? s.length : end);
                if (body) el.appendChild(new Text(body, doc));
                i = end < 0 ? s.length : s.indexOf('>', end) + 1;
            } else if (!VOID.has(tag)) {
                stack.push(el);
            }
            continue;
        }
        const next = s.indexOf('<', i + 1);
        const text = s.slice(i, next < 0 ? s.length : next);
        if (text) container(top()).appendChild(new Text(decode(text), doc));
        i = next < 0 ? s.length : next;
    }
}

/** 一个只在内存里的 localStorage；throws 为 true 时每次访问都抛错（模拟沙箱 iframe） */
export function memoryStorage({ throws = false } = {}) {
    const map = new Map();
    const guard = () => {
        if (throws) throw new Error('SecurityError: storage is not available');
    };
    return {
        map,
        getItem: (k) => { guard(); return map.has(k) ? map.get(k) : null; },
        setItem: (k, v) => { guard(); map.set(k, String(v)); },
        removeItem: (k) => { guard(); map.delete(k); },
        key: (i) => { guard(); const k = [...map.keys()][i]; return k === undefined ? null : k; },
        get length() { guard(); return map.size; },
    };
}

/**
 * 在 node 里“打开”一份状态栏文档：解析 <body> 的内容，按顺序执行其中的 <script>（NL_SPEC、NL_PORTRAITS、界面脚本、运行时）。
 * @param {string} doc compileStatusDocument 的结果
 * @param {{stat?: object, storage?: object|'throw'|null, globals?: object, prelude?: string[]}} opt stat：getAllVariables().stat_data；
 *   storage：localStorage 的替身（'throw' = 访问即抛错，和浏览器一样可以被重新定义；null = 没有 localStorage）；
 *   prelude：先于文档里的脚本执行的代码（例如预览页面 <head> 里模拟酒馆助手的那段）
 * @returns {{window: object, document: Document, update: (s: object) => void, errors: string[]}}
 *   update：换掉变量并触发 MVU 的 VARIABLE_UPDATE_ENDED（运行时重新渲染）；errors：运行时 console.error 的内容
 */
export function openStatusDocument(doc, { stat = {}, storage = undefined, globals = {}, prelude = [] } = {}) {
    const body = doc.slice(doc.indexOf('<body>') + '<body>'.length, doc.lastIndexOf('</body>'));
    const document = new Document();
    parseInto(document.body, body);
    let current = stat;
    const errors = [];
    const handlers = [];
    const win = {
        document,
        console: { log() {}, warn() {}, error: (...a) => errors.push(a.map(String).join(' ')) },
        getAllVariables: () => ({ stat_data: JSON.parse(JSON.stringify(current)) }),
        Mvu: { events: { VARIABLE_UPDATE_ENDED: 'mag_variable_update_ended' } },
        eventOn: (name, fn) => {
            if (name === 'mag_variable_update_ended') handlers.push(fn);
        },
        ...globals,
    };
    if (storage === 'throw') {
        Object.defineProperty(win, 'localStorage', { configurable: true, get() { throw new Error('SecurityError'); } });
    } else if (storage !== null) {
        win.localStorage = storage || memoryStorage();
    }
    win.window = win;
    const ctx = vm.createContext(win);
    for (const code of prelude) vm.runInContext(code, ctx);
    for (const el of document.body.querySelectorAll('script')) vm.runInContext(el.textContent, ctx);
    return {
        window: win,
        document,
        errors,
        /** 模拟 MVU 一轮更新：换掉变量并触发 VARIABLE_UPDATE_ENDED（运行时重新渲染） */
        update(s) {
            current = s;
            for (const h of handlers) h({ stat_data: JSON.parse(JSON.stringify(s)) });
        },
    };
}

export { Document, Element };
