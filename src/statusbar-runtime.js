// 状态栏界面：NL 运行时（读取 MVU 的 stat_data 并填充 data-nl-* 绑定）、内置排版、
// 状态栏 HTML 文档的组装（bind / raw / auto 三种模式），以及 NovelLoom 内的沙箱预览 srcdoc。
// 全部是纯字符串构建，不碰 DOM，可在 node 里测试。

import {
    STATUS_TAG, buildInitialState, cloneJson, decodeFenceText, encodeFenceText, htmlSafe, isFrontendText, isPlainObj, jsLit,
    simulateStRegexReplace, splitPath, unwrapStatusFence, wrapStatusFence,
} from './statusbar-base.js';

/** 内置排版的三套主题（CSS 变量） */
export const STATUSBAR_THEMES = [
    { value: 'clean', label: '简洁（浅色）' },
    { value: 'night', label: '夜色（深色）' },
    { value: 'paper', label: '纸笺（暖色）' },
];

export const STATUS_EMPTY_HINT = '变量尚未初始化：请在 酒馆助手 中启用本角色卡脚本';

/** 给 AI 写界面用的绑定说明（Phase 2 的 statusHtml 提示词 {BINDING_GUIDE} 直接用它） */
export const STATUS_BINDING_GUIDE = [
    '在元素上写 data-nl-* 属性绑定变量，路径用变量表里的点路径（例如 林小雨.好感度），NovelLoom 运行时会自动填值并在变量更新后刷新：',
    '- data-nl-text="路径"：显示值。数组用“、”连接；对象按“键：值”逐行显示；布尔值显示 data-nl-true / data-nl-false 的文字（默认 ✓ / ✗）；没有值时显示 data-nl-empty（默认 —）。',
    '- data-nl-bar="路径"：数字进度条，运行时把 0%~100% 写进该元素的 CSS 变量 --nl-pct（例如内部 <i style="width:var(--nl-pct)">）；范围取变量表的 min/max，也可用 data-nl-min / data-nl-max 覆盖。',
    '- data-nl-stage="路径"：显示数字当前所处阶段的名称（变量表里的 stages）。',
    '- data-nl-show="路径"：值为空/false/0 时隐藏该元素；加 data-nl-eq="值" 时只在等于该值时显示。',
    '- data-nl-each="路径"：里面放一个 <template>，对记录（对象）或列表逐项复制模板；模板里用 data-nl-key 显示键名，用 data-nl-item="子路径" 显示该项的值（列表或整项用 data-nl-item=""），用 data-nl-item-bar="子路径" 做该项的进度条；容器加 data-nl-empty="文字" 可在没有任何项时显示提示。',
    '- 每个绑定元素都会带上 data-nl-value="当前值"，可以用 CSS 属性选择器给枚举/布尔状态上色，例如 [data-nl-value="开心"]{color:#e88}。',
    '- 可选：<script>window.nlRender = function (stat, ctx) { … }</script>，在绑定填完后调用；stat 是完整变量对象，ctx.get("路径", 默认值) 取值，ctx.spec 是变量表，ctx.root 是 document.body。只做显示，不要修改变量。',
].join('\n');

// 每行的 * 与 " 个数必须是偶数，且 * 旁边不能有空格：酒馆默认开启的「自动修复 Markdown」（power-user.js fixMarkdown）
// 会给个数为奇数的行末尾补一个 *（或 "），并删掉成对 * / _ 之间紧挨着它们的空格。（::after 等同于 *::after）
const BASE_CSS = [
    '*,*::before,::after{box-sizing:border-box}',
    'body{margin:0;background:transparent}',
    '[hidden]{display:none!important}',
    '[data-nl-text]{white-space:pre-line}',
    '.nl-empty-hint{margin:6px auto;max-width:760px;padding:8px 12px;border:1px dashed rgba(127,127,127,.6);border-radius:8px;font:13px/1.5 system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;color:#888;text-align:center}',
].join('\n');

// ---------------- NL 运行时 ----------------
// 这个函数不会在 NovelLoom 里执行，而是用 toString() 原样写进状态栏页面的 <script>。
// 约束（单元测试会检查）：不能引用模块里的任何变量；不能出现反引号、两个连续的左花括号、$ 后接数字或 <、</script；
// 不能出现 * 和双引号（酒馆的「自动修复 Markdown」会给 * 或 " 个数为奇数的行末尾补一个，脚本就坏了），乘 100 写成除以 0.01。
/* eslint-disable no-undef */
function nlRuntime() {
    'use strict';
    var SPEC = window.NL_SPEC || { variables: [] };
    var VARS = {};
    (SPEC.variables || []).forEach(function (v) { VARS[v.path] = v; });
    var DASH = '—';
    var listening = false;

    function getPath(obj, path) {
        if (path === '' || path === null || path === undefined) return obj;
        var parts = String(path).split('.');
        var cur = obj;
        for (var i = 0; i < parts.length; i++) {
            if (cur === null || cur === undefined || typeof cur !== 'object') return undefined;
            cur = cur[parts[i]];
        }
        return cur;
    }
    function attr(el, name) {
        return el && el.getAttribute ? el.getAttribute(name) : null;
    }
    function isEmpty(v) {
        if (v === undefined || v === null || v === '') return true;
        if (Array.isArray(v)) return v.length === 0;
        if (typeof v === 'object') return Object.keys(v).length === 0;
        return false;
    }
    function fmt(v, el) {
        if (isEmpty(v)) return attr(el, 'data-nl-empty') || DASH;
        if (typeof v === 'boolean') return v ? (attr(el, 'data-nl-true') || '✓') : (attr(el, 'data-nl-false') || '✗');
        if (typeof v === 'number') {
            var digits = attr(el, 'data-nl-digits');
            return digits ? v.toFixed(Number(digits)) : String(Math.round(v / 0.01) / 100);
        }
        if (Array.isArray(v)) return v.map(function (x) { return fmt(x); }).join('、');
        if (typeof v === 'object') {
            return Object.keys(v).map(function (k) {
                var x = v[k];
                if (x && typeof x === 'object' && !Array.isArray(x)) {
                    return k + '：' + Object.keys(x).map(function (kk) { return kk + ' ' + fmt(x[kk]); }).join('，');
                }
                return k + '：' + fmt(x);
            }).join('\n');
        }
        return String(v);
    }
    function setValueAttr(el, v) {
        if (v === undefined || v === null) el.removeAttribute('data-nl-value');
        else if (Array.isArray(v)) el.setAttribute('data-nl-value', String(v.length));
        else if (typeof v === 'object') el.setAttribute('data-nl-value', String(Object.keys(v).length));
        else el.setAttribute('data-nl-value', String(v));
    }
    function numAttr(el, name, dflt) {
        var a = attr(el, name);
        if (a === null || a === '') return dflt;
        var n = Number(a);
        return isFinite(n) ? n : dflt;
    }
    function pct(v, min, max) {
        var n = Number(v);
        if (typeof v === 'boolean' || v === null || v === '' || !isFinite(n) || !isFinite(min) || !isFinite(max) || max === min) return 0;
        return Math.max(0, Math.min(100, (n - min) / (max - min) / 0.01));
    }
    function setBar(el, v, meta) {
        var m = meta || {};
        var min = numAttr(el, 'data-nl-min', typeof m.min === 'number' ? m.min : 0);
        var max = numAttr(el, 'data-nl-max', typeof m.max === 'number' ? m.max : 100);
        el.style.setProperty('--nl-pct', pct(v, min, max).toFixed(1) + '%');
        setValueAttr(el, v);
    }
    function stageOf(path, v) {
        var stages = (VARS[path] && VARS[path].stages) || [];
        var n = Number(v);
        var label = '';
        if (v === null || v === '' || !isFinite(n)) return label;
        for (var i = 0; i < stages.length; i++) if (n >= stages[i].min) label = stages[i].label;
        return label;
    }
    function shown(el, v) {
        if (el.hasAttribute('data-nl-eq')) return String(v) === attr(el, 'data-nl-eq');
        if (el.hasAttribute('data-nl-ne')) return String(v) !== attr(el, 'data-nl-ne');
        return !isEmpty(v) && v !== false && v !== 0;
    }
    function itemMeta(path, sub) {
        var meta = VARS[path];
        var val = meta && meta.value;
        if (!val) return null;
        if (!sub) return val;
        var fields = val.fields || [];
        for (var i = 0; i < fields.length; i++) if (fields[i].key === sub) return fields[i];
        return null;
    }
    function fillEach(el, stat) {
        var path = attr(el, 'data-nl-each');
        var tpl = null;
        Array.prototype.slice.call(el.children).forEach(function (c) {
            if (c.hasAttribute('data-nl-gen')) el.removeChild(c);
            else if (!tpl && c.tagName === 'TEMPLATE') tpl = c;
        });
        if (!tpl) return;
        var v = getPath(stat, path);
        var entries = [];
        if (Array.isArray(v)) entries = v.map(function (x, i) { return [String(i), x]; });
        else if (v && typeof v === 'object') entries = Object.keys(v).map(function (k) { return [k, v[k]]; });
        entries.forEach(function (pair, idx) {
            var frag = tpl.content.cloneNode(true);
            frag.querySelectorAll('[data-nl-key]').forEach(function (k) { k.textContent = pair[0]; });
            frag.querySelectorAll('[data-nl-item]').forEach(function (it) {
                var x = getPath(pair[1], attr(it, 'data-nl-item'));
                it.textContent = fmt(x, it);
                setValueAttr(it, x);
            });
            frag.querySelectorAll('[data-nl-item-bar]').forEach(function (it) {
                var sub = attr(it, 'data-nl-item-bar');
                setBar(it, getPath(pair[1], sub), itemMeta(path, sub));
            });
            Array.prototype.slice.call(frag.childNodes).forEach(function (n) {
                if (n.nodeType !== 1) return;
                n.setAttribute('data-nl-gen', '');
                n.setAttribute('data-nl-index', String(idx));
                el.appendChild(n);
            });
        });
        if (!entries.length && el.hasAttribute('data-nl-empty')) {
            var span = document.createElement('span');
            span.className = 'nl-each-empty';
            span.setAttribute('data-nl-gen', '');
            span.textContent = attr(el, 'data-nl-empty');
            el.appendChild(span);
        }
        setValueAttr(el, v);
    }
    function read() {
        try {
            if (typeof getAllVariables === 'function') {
                var all = getAllVariables();
                if (all && all.stat_data && typeof all.stat_data === 'object') return all.stat_data;
            }
        } catch (e) {
            console.warn('[NovelLoom] 读取变量失败', e);
        }
        return {};
    }
    function currentId() {
        try { return typeof getCurrentMessageId === 'function' ? getCurrentMessageId() : null; } catch (e) { return null; }
    }
    function lastId() {
        try { return typeof getLastMessageId === 'function' ? getLastMessageId() : null; } catch (e) { return null; }
    }
    function render(data) {
        var stat = data && typeof data === 'object' ? data : read();
        var doc = document;
        doc.querySelectorAll('[data-nl-each]').forEach(function (el) { fillEach(el, stat); });
        doc.querySelectorAll('[data-nl-text]').forEach(function (el) {
            var v = getPath(stat, attr(el, 'data-nl-text'));
            el.textContent = fmt(v, el);
            setValueAttr(el, v);
        });
        doc.querySelectorAll('[data-nl-bar]').forEach(function (el) {
            var p = attr(el, 'data-nl-bar');
            setBar(el, getPath(stat, p), VARS[p]);
        });
        doc.querySelectorAll('[data-nl-stage]').forEach(function (el) {
            var p = attr(el, 'data-nl-stage');
            var v = getPath(stat, p);
            el.textContent = stageOf(p, v) || attr(el, 'data-nl-empty') || '';
            setValueAttr(el, v);
        });
        doc.querySelectorAll('[data-nl-show]').forEach(function (el) {
            el.hidden = !shown(el, getPath(stat, attr(el, 'data-nl-show')));
        });
        var empty = !stat || Object.keys(stat).length === 0;
        var hint = doc.querySelector('.nl-empty-hint');
        if (hint) hint.hidden = !empty;
        if (doc.body) doc.body.classList.toggle('nl-is-empty', empty);
        if (typeof window.nlRender === 'function') {
            try {
                window.nlRender(stat, {
                    get: function (p, dflt) { var x = getPath(stat, p); return x === undefined ? dflt : x; },
                    spec: SPEC,
                    root: doc.body,
                    messageId: currentId(),
                    fmt: fmt,
                });
            } catch (e) {
                console.error('[NovelLoom] nlRender 出错', e);
            }
        }
    }
    function listen() {
        // MVU 没加载（例如没启用角色脚本）时 window.Mvu 不存在：只显示初始提示，不报错
        var M = window.Mvu;
        if (listening || !M || !M.events || typeof eventOn !== 'function') return;
        listening = true;
        eventOn(M.events.VARIABLE_UPDATE_ENDED, function (vars) {
            // 事件先于 MVU 把变量写进楼层：最新楼层直接用事件里的数据，其他楼层重新读取自己的快照
            var cur = currentId();
            var last = lastId();
            var data = vars && vars.stat_data && typeof vars.stat_data === 'object' ? vars.stat_data : null;
            render(data && (cur === null || last === null || cur === last) ? data : null);
        });
    }
    function init() {
        render();
        listen();
        if (typeof waitGlobalInitialized !== 'function') return undefined;
        return Promise.resolve()
            .then(function () { return waitGlobalInitialized('Mvu'); })
            .then(function () { render(); listen(); }, function () {
                // MVU 未加载：保持初始提示
            });
    }
    var start = typeof errorCatched === 'function' ? errorCatched(init) : init;
    if (typeof $ === 'function') $(start);
    else if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
    else start();
}
/* eslint-enable no-undef */

/** NL 运行时脚本正文（放进 <script> 标签里） */
export function buildNlRuntime() {
    return `(${nlRuntime.toString()})();`;
}

/** 运行时需要的变量表子集（不含 desc/check，减小体积） */
export function runtimeSpec(spec) {
    return {
        title: spec?.title || '',
        variables: (spec?.variables || []).map((v) => {
            const o = { path: v.path, type: v.type, label: v.label || '' };
            if (v.type === 'number') {
                if (Number.isFinite(v.min)) o.min = v.min;
                if (Number.isFinite(v.max)) o.max = v.max;
                if (v.stages?.length) o.stages = v.stages.map((s) => ({ min: s.min, label: s.label }));
            }
            if (v.type === 'enum') o.options = [...(v.options || [])];
            if (v.type === 'record' && v.value) {
                const val = { type: v.value.type };
                if (Number.isFinite(v.value.min)) val.min = v.value.min;
                if (Number.isFinite(v.value.max)) val.max = v.value.max;
                if (v.value.fields) {
                    val.fields = v.value.fields.map((f) => {
                        const ff = { key: f.key, type: f.type };
                        if (Number.isFinite(f.min)) ff.min = f.min;
                        if (Number.isFinite(f.max)) ff.max = f.max;
                        return ff;
                    });
                }
                o.value = val;
            }
            if (v.widget) o.widget = v.widget;
            return o;
        }),
    };
}

// ---------------- 内置排版 ----------------

const THEME_CSS = {
    clean: '--nlb-bg:#ffffff;--nlb-card:#f6f7f9;--nlb-fg:#1f2329;--nlb-muted:#6b7280;--nlb-accent:#4f7cff;--nlb-track:#e3e6eb;--nlb-border:#dfe3e8;--nlb-badge:#eef2ff;--nlb-badge-fg:#3451c7;',
    night: '--nlb-bg:#16181d;--nlb-card:#1f232a;--nlb-fg:#e6e8eb;--nlb-muted:#9aa3ae;--nlb-accent:#7aa2ff;--nlb-track:#2c313a;--nlb-border:#2f343d;--nlb-badge:#263150;--nlb-badge-fg:#b9caff;',
    paper: '--nlb-bg:#fbf6ec;--nlb-card:#f4ecdc;--nlb-fg:#3b2f22;--nlb-muted:#8a7660;--nlb-accent:#b0653a;--nlb-track:#e6d9c1;--nlb-border:#e2d4b8;--nlb-badge:#f1e1c8;--nlb-badge-fg:#8a4a22;',
};

function themeOf(theme) {
    return THEME_CSS[theme] ? theme : 'clean';
}

function defaultCss(theme) {
    const t = themeOf(theme);
    return [
        `.nlb{${THEME_CSS[t]}max-width:760px;margin:4px auto;color:var(--nlb-fg);background:var(--nlb-bg);border:1px solid var(--nlb-border);border-radius:10px;font:13px/1.5 system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;overflow:hidden}`,
        '.nlb>summary{cursor:pointer;list-style:none;padding:8px 12px;font-weight:600;display:flex;align-items:center;gap:6px;user-select:none}',
        '.nlb>summary::-webkit-details-marker{display:none}',
        '.nlb>summary::before{content:"▸";color:var(--nlb-muted);transition:transform .15s}',
        '.nlb[open]>summary::before{transform:rotate(90deg)}',
        '.nlb-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:8px;padding:0 10px 10px}',
        '.nlb-card{background:var(--nlb-card);border-radius:8px;padding:8px 10px;min-width:0}',
        '.nlb-card h4{margin:0 0 4px;font-size:12px;font-weight:600;color:var(--nlb-muted);letter-spacing:.02em}',
        '.nlb-row{display:flex;align-items:center;gap:8px;padding:2px 0;min-width:0}',
        '.nlb-k{flex:0 0 auto;color:var(--nlb-muted);max-width:45%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
        '.nlb-v{flex:1 1 auto;min-width:0;text-align:right;overflow-wrap:anywhere}',
        '.nlb-num{flex:0 0 auto;min-width:2.5em;text-align:right;font-variant-numeric:tabular-nums}',
        '.nlb-bar{flex:1 1 auto;height:6px;border-radius:3px;background:var(--nlb-track);overflow:hidden;min-width:40px}',
        '.nlb-bar>i,.nlb-ibar>i{display:block;height:100%;width:var(--nl-pct,0%);background:var(--nlb-accent);border-radius:inherit;transition:width .3s}',
        '.nlb-stage{flex:0 0 auto;font-size:12px;color:var(--nlb-accent)}',
        '.nlb-badge{display:inline-block;padding:0 8px;border-radius:999px;background:var(--nlb-badge);color:var(--nlb-badge-fg);font-size:12px;line-height:20px}',
        '.nlb-badge[data-nl-value="false"]{opacity:.55}',
        '.nlb-tags{display:flex;flex-wrap:wrap;gap:4px;justify-content:flex-end;flex:1 1 auto}',
        '.nlb-tag{padding:0 6px;border-radius:4px;background:var(--nlb-track);font-size:12px;line-height:20px}',
        '.nlb-list{display:flex;flex-direction:column;gap:2px;padding:2px 0}',
        '.nlb-li{display:flex;flex-wrap:wrap;align-items:center;gap:4px 8px;padding:2px 0;border-top:1px dashed var(--nlb-border)}',
        '.nlb-li:first-of-type{border-top:0}',
        '.nlb-lk{font-weight:600}',
        '.nlb-lf{color:var(--nlb-muted);font-size:12px}',
        '.nlb-lf b{font-weight:500;color:var(--nlb-fg);margin-left:2px}',
        '.nlb-ibar{display:inline-block;width:60px;height:5px;border-radius:3px;background:var(--nlb-track);overflow:hidden}',
        '.nl-each-empty{color:var(--nlb-muted);font-size:12px}',
        '.nlb-sub{display:block}',
    ].join('\n');
}

function labelOf(v) {
    if (v.label) return v.label;
    const segs = splitPath(v.path);
    return String(segs[segs.length - 1] || v.path).replace(/^[_$]+/, '') || v.path;
}

function itemHtml(v) {
    const p = htmlSafe(v.path);
    const k = `<span class="nlb-k">${htmlSafe(labelOf(v))}</span>`;
    switch (v.widget) {
        case 'bar': {
            const stage = v.stages?.length ? `<span class="nlb-stage" data-nl-stage="${p}"></span>` : '';
            return `<div class="nlb-row">${k}<span class="nlb-bar" data-nl-bar="${p}"><i></i></span><span class="nlb-num" data-nl-text="${p}"></span>${stage}</div>`;
        }
        case 'badge':
            return `<div class="nlb-row">${k}<span class="nlb-v"><span class="nlb-badge" data-nl-text="${p}"></span></span></div>`;
        case 'tags':
            return `<div class="nlb-row">${k}<div class="nlb-tags" data-nl-each="${p}" data-nl-empty="无"><template><span class="nlb-tag" data-nl-item=""></span></template></div></div>`;
        case 'list': {
            const val = v.value || { type: 'string' };
            let inner;
            if (val.type === 'object') {
                inner = (val.fields || []).map((f) => {
                    const fk = htmlSafe(f.key);
                    if (f.type === 'number' && Number.isFinite(f.min) && Number.isFinite(f.max)) {
                        return `<span class="nlb-lf">${htmlSafe(f.label || f.key)}<b data-nl-item="${fk}"></b> <span class="nlb-ibar" data-nl-item-bar="${fk}"><i></i></span></span>`;
                    }
                    return `<span class="nlb-lf">${htmlSafe(f.label || f.key)}<b data-nl-item="${fk}"></b></span>`;
                }).join('');
            } else if (val.type === 'number' && Number.isFinite(val.min) && Number.isFinite(val.max)) {
                inner = '<span class="nlb-lf"><b data-nl-item=""></b> <span class="nlb-ibar" data-nl-item-bar=""><i></i></span></span>';
            } else {
                inner = '<span class="nlb-lf"><b data-nl-item=""></b></span>';
            }
            return `<div class="nlb-sub"><span class="nlb-k">${htmlSafe(labelOf(v))}</span><div class="nlb-list" data-nl-each="${p}" data-nl-empty="（空）"><template><div class="nlb-li"><span class="nlb-lk" data-nl-key></span>${inner}</div></template></div></div>`;
        }
        default:
            return `<div class="nlb-row">${k}<span class="nlb-v" data-nl-text="${p}"></span></div>`;
    }
}

/**
 * 内置排版：每个第一层路径一张小卡片，按 widget 排版；不需要 AI。
 * @param {{title?:string, variables:object[]}} spec 规范化后的变量表
 * @param {'clean'|'night'|'paper'} theme
 * @returns {string} 绑定模式的 HTML 片段（<style> + 标记）
 */
export function renderDefaultFragment(spec, theme = 'clean') {
    const groups = new Map();
    for (const v of spec?.variables || []) {
        if (v.widget === 'hidden') continue;
        const segs = splitPath(v.path);
        const key = segs.length > 1 ? segs[0] : '';
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(v);
    }
    const title = spec?.title || '状态栏';
    const cards = [...groups.entries()].map(([key, vars]) => {
        const head = key ? `<h4>${htmlSafe(key.replace(/^[_$]+/, '') || key)}</h4>` : '';
        return `<section class="nlb-card">${head}${vars.map(itemHtml).join('')}</section>`;
    });
    return [
        `<style>\n${defaultCss(theme)}\n</style>`,
        `<details class="nlb nlb-theme-${themeOf(theme)}" open><summary>${htmlSafe(title)}</summary>`,
        `<div class="nlb-grid">${cards.join('\n') || '<section class="nlb-card"><span class="nlb-k">（变量表为空）</span></section>'}</div>`,
        '</details>',
    ].join('\n');
}

// ---------------- 文档组装 ----------------

/**
 * 绑定模式片段里去掉文档级标签和外层代码块（浏览器会容忍，但片段不该带）。
 * 反复去到不再变化为止：去掉一层后拼出来的新标签（例如 <bo<body>dy>）也会被去掉，
 * 所以 lintStatusHtml 检查的与 compileStatusDocument 嵌入的是同一段文字。
 */
export function cleanFragment(html) {
    let s = String(html ?? '').trim();
    for (;;) {
        const next = unwrapStatusFence(s)
            .replace(/<!doctype[^>]*>/gi, '')
            .replace(/<\/?html\b[^>]*>/gi, '')
            .replace(/<\/?head\b[^>]*>/gi, '')
            .replace(/<\/?body\b[^>]*>/gi, '')
            .trim();
        if (next === s) return s; // 每一轮只会变短，必然停下
        s = next;
    }
}

function statusBarOf(card) {
    return card?.statusBar || {};
}

/**
 * 组装状态栏正则里的完整 HTML 文档（不含外层代码块）。
 * - bind：AI 写的片段（为空时用内置排版）+ NL 运行时
 * - auto：内置排版 + NL 运行时
 * - raw：用户粘贴的完整文档，原样使用（没有 <body>/<head> 时补一层 <body>，否则酒馆助手不会渲染）；不注入运行时
 * @param {object} card 带 statusBar 的角色卡
 * @param {{mode?:string, html?:string, theme?:string, spec?:object}} override 预览未保存的编辑时覆盖对应字段
 */
export function compileStatusDocument(card, override = {}) {
    const sb = statusBarOf(card);
    const mode = override.mode || sb.mode || 'bind';
    const html = override.html !== undefined ? override.html : sb.html;
    const theme = override.theme || sb.theme || 'clean';
    const spec = override.spec || sb.spec || { variables: [] };
    if (mode === 'raw') {
        const doc = unwrapStatusFence(String(html ?? '').trim());
        return isFrontendText(doc) ? doc : `<body>\n${doc}\n</body>`;
    }
    const cleaned = mode === 'bind' ? cleanFragment(html) : '';
    const fragment = cleaned || renderDefaultFragment(spec, theme);
    return [
        '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">',
        `<style>\n${BASE_CSS}\n</style>`,
        '</head><body>',
        `<script>window.NL_SPEC = ${jsLit(runtimeSpec(spec))};</script>`,
        fragment,
        `<div class="nl-empty-hint" hidden>${htmlSafe(STATUS_EMPTY_HINT)}</div>`,
        `<script>\n${buildNlRuntime()}\n</script>`,
        '</body></html>',
    ].join('\n');
}

// ---------------- NovelLoom 内的沙箱预览 ----------------

const CDN = 'https://testingcf.jsdelivr.net';

// 与 nlRuntime 一样用 toString() 写进预览页面，不能引用模块里的变量
function previewMocks(boot) {
    var sample = boot.sample || {};
    var bus = {};
    function clone(v) { return v === undefined ? undefined : JSON.parse(JSON.stringify(v)); }
    function post(msg) {
        try { msg.source = 'nl-preview'; window.parent.postMessage(msg, '*'); } catch (e) { /* ignore */ }
    }
    function report(e) {
        post({ type: 'nl-error', message: String((e && (e.stack || e.message)) || e) });
    }
    if (typeof window._ === 'undefined') {
        window._ = {
            get: function (obj, path, dflt) {
                var parts = Array.isArray(path) ? path : String(path).split('.');
                var cur = obj;
                for (var i = 0; i < parts.length; i++) {
                    if (cur === null || cur === undefined) return dflt;
                    cur = cur[parts[i]];
                }
                return cur === undefined ? dflt : cur;
            },
        };
    }
    if (typeof window.$ === 'undefined') {
        window.$ = function (fn) {
            if (typeof fn === 'function') {
                if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn);
                else setTimeout(fn, 0);
            }
        };
    }
    function on(name, fn) {
        (bus[name] = bus[name] || []).push(fn);
        return { stop: function () { off(name, fn); } };
    }
    function off(name, fn) {
        bus[name] = (bus[name] || []).filter(function (f) { return f !== fn; });
    }
    function emit(name) {
        var args = Array.prototype.slice.call(arguments, 1);
        (bus[name] || []).slice().forEach(function (fn) {
            try { fn.apply(null, args); } catch (e) { report(e); }
        });
        return Promise.resolve();
    }
    var MVU = {
        events: {
            VARIABLE_INITIALIZED: 'mag_variable_initialized',
            VARIABLE_UPDATE_STARTED: 'mag_variable_update_started',
            VARIABLE_UPDATE_ENDED: 'mag_variable_update_ended',
            COMMAND_PARSED: 'mag_command_parsed',
            BEFORE_MESSAGE_UPDATE: 'mag_before_message_update',
        },
        getMvuData: function () { return { stat_data: clone(sample) }; },
    };
    window.getAllVariables = function () { return { stat_data: clone(sample) }; };
    window.getVariables = function () { return { stat_data: clone(sample) }; };
    window.getCurrentMessageId = function () { return 1; };
    window.getLastMessageId = function () { return 1; };
    window.eventOn = on;
    window.eventOnce = function (name, fn) {
        var wrapped = function () { off(name, wrapped); return fn.apply(null, arguments); };
        return on(name, wrapped);
    };
    window.eventEmit = emit;
    window.eventRemoveListener = off;
    window.errorCatched = function (fn) {
        return function () {
            try {
                var r = fn.apply(this, arguments);
                if (r && typeof r.then === 'function') return r.catch(report);
                return r;
            } catch (e) {
                report(e);
                return undefined;
            }
        };
    };
    var noop = function () {};
    window.toastr = { success: noop, info: noop, warning: noop, error: function (m) { post({ type: 'nl-error', message: String(m) }); }, clear: noop };
    window.SillyTavern = { name1: boot.user, name2: boot.char };
    window.tavern_events = {};
    window.iframe_events = {};
    window.waitGlobalInitialized = function (name) {
        if (name === 'Mvu') window.Mvu = MVU;
        return Promise.resolve();
    };
    window.addEventListener('error', function (e) { report(e.error || e.message); });
    window.addEventListener('unhandledrejection', function (e) { report(e.reason); });
    window.addEventListener('message', function (e) {
        if (e.source !== window.parent) return;
        var d = e.data;
        if (!d || d.type !== 'nl-sample') return;
        sample = d.stat && typeof d.stat === 'object' ? d.stat : {};
        emit('mag_variable_update_started', { stat_data: clone(sample) });
        emit('mag_variable_update_ended', { stat_data: clone(sample) }, {});
    });
    // 按内容实际占的高度报给父页面（不用 documentElement.scrollHeight：它不会小于 iframe 当前的高度，
    // 内容变少时 iframe 就缩不回去）；算上子元素的下外边距，免得被 overflow:hidden 裁掉
    function contentHeight() {
        var body = document.body;
        if (!body) return document.documentElement.scrollHeight;
        var top = body.getBoundingClientRect().top;
        var h = top + body.scrollHeight;
        for (var i = 0; i < body.children.length; i++) {
            var el = body.children[i];
            var cs = window.getComputedStyle(el);
            if (cs.display === 'none' || cs.position === 'fixed') continue;
            var b = el.getBoundingClientRect().bottom + (parseFloat(cs.marginBottom) || 0);
            if (b > h) h = b;
        }
        return Math.ceil(h);
    }
    function sendHeight() {
        post({ type: 'nl-height', height: contentHeight() });
    }
    window.addEventListener('load', sendHeight);
    document.addEventListener('DOMContentLoaded', function () {
        if (typeof ResizeObserver === 'function') new ResizeObserver(sendHeight).observe(document.body);
        sendHeight();
    });
}

/**
 * 模拟酒馆显示状态栏时对正则替换串做的全部处理，得到 iframe 实际收到的文档：
 * 和导出一样写进代码块（& → &amp;）→ 正则替换展开（{{user}}/{{char}} 换成名字，与酒馆一样不转义）→ 去掉代码块 → 解码一层 HTML 实体
 */
export function simulateShownDocument(doc, { user = 'User', char = 'Char' } = {}) {
    const replace = wrapStatusFence(encodeFenceText(doc));
    return decodeFenceText(unwrapStatusFence(simulateStRegexReplace(replace, { match: STATUS_TAG, user: String(user ?? ''), char: String(char ?? '') })));
}

/**
 * NovelLoom 状态栏预览：给 <iframe sandbox="allow-scripts" referrerpolicy="no-referrer" srcdoc> 用的完整页面。
 * 内容就是酒馆显示导出卡片时 iframe 收到的文档（simulateShownDocument：同一套替换模拟、去掉代码块、解码一层实体），外面套一层模拟的酒馆助手环境：
 * getAllVariables / getVariables / getCurrentMessageId / getLastMessageId / waitGlobalInitialized(→ window.Mvu)
 * / eventOn 系列 / errorCatched / toastr / SillyTavern{name1,name2} / tavern_events / iframe_events。
 * 页面与父窗口的消息（父窗口要校验 e.source === iframe.contentWindow）：
 *   iframe → 父：{source:'nl-preview', type:'nl-height', height} / {source:'nl-preview', type:'nl-error', message}
 *   父 → iframe：{type:'nl-sample', stat}（替换示例变量并触发 mag_variable_update_ended）
 * @param {object} card 带 statusBar 的角色卡
 * @param {object} [sample] 示例 stat_data；缺省用 statusBar.sample，再缺省用变量表初始值
 * @param {{user?:string, char?:string, override?:object, tailwind?:string, cdn?:string}} opts
 *   override：传给 compileStatusDocument 的覆盖字段；tailwind：raw 模式下内联的 tailwind 运行时代码（父页面取到才传）
 */
export function buildPreviewSrcdoc(card, sample, opts = {}) {
    const sb = statusBarOf(card);
    const spec = opts.override?.spec || sb.spec || { variables: [] };
    const data = isPlainObj(sample) ? sample : isPlainObj(sb.sample) ? sb.sample : buildInitialState(spec);
    const user = opts.user || 'User';
    const char = opts.char || card?.data?.name || 'Char';
    const cdn = String(opts.cdn || CDN).replace(/\/+$/, '');
    const mode = opts.override?.mode || sb.mode || 'bind';
    const doc = compileStatusDocument(card, opts.override || {});
    // 与导出同一条路径：正则替换串（& 写成 &amp;）→ 酒馆替换模拟 → 去掉代码块 → 解码一层实体（酒馆助手拿到的就是这个）
    const shown = simulateShownDocument(doc, { user, char });
    const boot = { sample: cloneJson(data), user, char };
    const tailwind = mode === 'raw' && opts.tailwind ? `<script>${String(opts.tailwind).replace(/<\/script/gi, '<\\/script')}</script>` : '';
    return [
        '<!DOCTYPE html>',
        '<html>',
        '<head>',
        '<meta charset="utf-8">',
        '<meta name="viewport" content="width=device-width, initial-scale=1.0">',
        '<style>*,*::before,*::after{box-sizing:border-box;}html,body{margin:0!important;padding:0;overflow:hidden!important;max-width:100%!important;}:root{--TH-viewport-height:600px;}</style>',
        `<link rel="stylesheet" href="${htmlSafe(cdn)}/npm/@fortawesome/fontawesome-free/css/all.min.css">`,
        `<script src="${htmlSafe(cdn)}/npm/jquery/dist/jquery.min.js"></script>`,
        `<script src="${htmlSafe(cdn)}/npm/lodash/lodash.min.js"></script>`,
        tailwind,
        `<script>(${previewMocks.toString()})(${jsLit(boot)});</script>`,
        '</head>',
        '<body>',
        shown,
        '</body>',
        '</html>',
    ].filter(Boolean).join('\n');
}
