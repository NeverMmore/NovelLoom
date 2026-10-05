// 状态栏界面：NL 运行时（读取 MVU 的 stat_data 并填充 data-nl-* 绑定）、内置排版、
// 状态栏 HTML 文档的组装（bind / raw / auto 三种模式），以及 NovelLoom 内的沙箱预览 srcdoc。
// 全部是纯字符串构建，不碰 DOM，可在 node 里测试。

import {
    STATUS_TAG, buildInitialState, cloneJson, decodeFenceText, encodeFenceText, htmlSafe, isFrontendText, isPlainObj, jsLit,
    jsStr, simulateStRegexReplace, splitPath, unwrapStatusFence, wrapStatusFence,
} from './statusbar-base.js';
import {
    DATA_IMAGE_RE, PORTRAIT_DATA_URL_MAX, SERVER_IMAGE_PREFIX, isOwnServerImage, normalizePortraits, portraitChoiceId, portraitsActive,
} from './statusbar-portraits.js';

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
    '- 记录条目里的分组字段用点路径，例如 data-nl-item="服饰.上衣"；data-nl-item-stage="子路径" 显示该项数字所处阶段的名称，data-nl-item-show="子路径" 在该项的值为空/false/0 时隐藏（也可加 data-nl-eq / data-nl-ne）。',
    '- data-nl-group="子路径"：写在 data-nl-each 的模板里，里面再放一个 <template>，按变量表里这个分组的字段逐个复制（例如 服饰 → 上衣、下装、配饰）；小模板里 data-nl-key 显示字段名，data-nl-item="" 显示字段值，data-nl-item-bar="" / data-nl-item-stage="" 同理。写在 data-nl-each 外面时路径从第一层写起（例如 世界）。',
    '- 立绘：在记录的模板里放 <img data-nl-portrait="">，显示当前条目（角色）的立绘；模板外写 data-nl-portrait="名字"（是记录里的角色时再加 data-nl-portrait-record="记录路径"）。<button type="button" data-nl-portrait-next="">换一张</button> 在已解锁的立绘之间切换（不足两张时自动隐藏）。图片由用户在 NovelLoom 里配置，界面代码里不要写图片地址；没有图片或加载失败时显示带首字的占位块（class nl-portrait-ph，可以自己加样式），元素上的 data-nl-portrait-state 是 ok / loading / empty / error。',
    '- 每个绑定元素都会带上 data-nl-value="当前值"，可以用 CSS 属性选择器给枚举/布尔状态上色，例如 [data-nl-value="开心"]{color:#e88}；有阶段（stages）的进度条和阶段元素还带 data-nl-stage-index（当前阶段的序号，从 0 开始），例如 [data-nl-stage-index="2"]{--c:#e66}。',
    '- 可选：<script>window.nlRender = function (stat, ctx) { … }</script>，在绑定填完后调用；stat 是完整变量对象，ctx.get("路径", 默认值) 取值，ctx.spec 是变量表，ctx.meta("路径") 取该路径（包括记录条目里的字段）在变量表里的定义，ctx.root 是 document.body；用脚本新建了带 data-nl-portrait 的元素后调用 ctx.portraits() 填上立绘。只做显示，不要修改变量。',
].join('\n');

// 每行的 * 与 " 个数必须是偶数，且 * 旁边不能有空格：酒馆默认开启的「自动修复 Markdown」（power-user.js fixMarkdown）
// 会给个数为奇数的行末尾补一个 *（或 "），并删掉成对 * / _ 之间紧挨着它们的空格。（::after 等同于 *::after）
const BASE_CSS = [
    '*,*::before,::after{box-sizing:border-box}',
    'body{margin:0;background:transparent}',
    '[hidden]{display:none!important}',
    '[data-nl-text]{white-space:pre-line}',
    '.nl-empty-hint{margin:6px auto;max-width:760px;padding:8px 12px;border:1px dashed rgba(127,127,127,.6);border-radius:8px;font:13px/1.5 system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;color:#888;text-align:center}',
    // 立绘：容器里的图片铺满容器；占位块（运行时生成，带上 <img> 的 class，所以尺寸跟着界面自己的样式走）显示名字的首字
    'img[data-nl-portrait],.nl-portrait-img{object-fit:cover}',
    '.nl-portrait-img{display:block;width:100%;height:100%;border-radius:inherit}',
    '[data-nl-portrait]>.nl-portrait-ph{width:100%;height:100%;border-radius:inherit}',
    '.nl-portrait-ph:not([hidden]){display:flex!important;align-items:center;justify-content:center}',
    '.nl-portrait-ph{overflow:hidden;padding:.2em .4em;background:linear-gradient(135deg,hsl(var(--nl-ph-hue,220),38%,50%),hsl(var(--nl-ph-hue,220),44%,28%));color:#fff;font-weight:600;line-height:1;text-shadow:0 1px 2px rgba(0,0,0,.35);user-select:none}',
].join('\n');

// ---------------- NL 运行时 ----------------
// 这个函数不会在 NovelLoom 里执行，而是用 toString() 原样写进状态栏页面的 <script>。
// 约束（单元测试会检查）：不能引用模块里的任何变量；不能出现反引号、两个连续的左花括号、$ 后接数字或 <、</script；
// 不能出现 * 和双引号（酒馆的「自动修复 Markdown」会给 * 或 " 个数为奇数的行末尾补一个，脚本就坏了），乘 100 写成除以 0.01。
/* eslint-disable no-undef */
function nlRuntime() {
    'use strict';
    var SPEC = window.NL_SPEC || { variables: [] };
    var VARS = Object.create(null);
    (SPEC.variables || []).forEach(function (v) { VARS[v.path] = v; });
    var PORTRAITS = window.NL_PORTRAITS && typeof window.NL_PORTRAITS === 'object' ? window.NL_PORTRAITS : {};
    var PCHARS = PORTRAITS.characters && typeof PORTRAITS.characters === 'object' ? PORTRAITS.characters : {};
    var PPOOLS = Array.isArray(PORTRAITS.pools) ? PORTRAITS.pools : [];
    // 只有 NovelLoom 的沙箱预览会给：酒馆服务器上的立绘（/user/images/…）→ 父页面取来的 data:image（沙箱里可能带不上登录信息）
    var PSRC = window.NL_PREVIEW_SRC && typeof window.NL_PREVIEW_SRC === 'object' ? window.NL_PREVIEW_SRC : null;
    var CARD = String(window.NL_CARD_ID || 'card');
    var DASH = '—';
    var listening = false;
    var swapBound = false;
    var lastStat = {};
    var chosen = Object.create(null);

    function own(obj, k) {
        return !!obj && typeof obj === 'object' && Object.prototype.hasOwnProperty.call(obj, k);
    }
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
    // depth：0 = 绑定元素本身的值（对象按“键：值”逐行）；1 = 嵌在里面的对象（键 值，逗号分隔）；2 及以上再加括号
    function fmt(v, el, depth) {
        var d = depth || 0;
        if (isEmpty(v)) return attr(el, 'data-nl-empty') || DASH;
        if (typeof v === 'boolean') return v ? (attr(el, 'data-nl-true') || '✓') : (attr(el, 'data-nl-false') || '✗');
        if (typeof v === 'number') {
            var digits = attr(el, 'data-nl-digits');
            return digits ? v.toFixed(Number(digits)) : String(Math.round(v / 0.01) / 100);
        }
        if (Array.isArray(v)) return v.map(function (x) { return fmt(x, null, d + 1); }).join('、');
        if (typeof v === 'object') {
            if (d === 0) {
                return Object.keys(v).map(function (k) { return k + '：' + fmt(v[k], null, 1); }).join('\n');
            }
            var inline = Object.keys(v).map(function (k) { return k + ' ' + fmt(v[k], null, d + 1); }).join('，');
            return d > 1 ? '（' + inline + '）' : inline;
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
    // 阶段：返回当前所处阶段的下标（没有阶段或不是数字时 -1）
    function stageIndex(meta, v) {
        var stages = (meta && meta.stages) || [];
        var n = Number(v);
        var idx = -1;
        if (v === null || v === undefined || v === '' || typeof v === 'boolean' || !isFinite(n)) return idx;
        for (var i = 0; i < stages.length; i++) if (n >= stages[i].min) idx = i;
        return idx;
    }
    function stageLabel(meta, v) {
        var i = stageIndex(meta, v);
        return i < 0 ? '' : meta.stages[i].label;
    }
    function setStage(el, meta, v) {
        var i = stageIndex(meta, v);
        if (i < 0) el.removeAttribute('data-nl-stage-index');
        else el.setAttribute('data-nl-stage-index', String(i));
    }
    function setBar(el, v, meta) {
        var m = meta || {};
        var min = numAttr(el, 'data-nl-min', typeof m.min === 'number' ? m.min : 0);
        var max = numAttr(el, 'data-nl-max', typeof m.max === 'number' ? m.max : 100);
        el.style.setProperty('--nl-pct', pct(v, min, max).toFixed(1) + '%');
        if (m.stages && m.stages.length) setStage(el, m, v);
        setValueAttr(el, v);
    }
    function shown(el, v) {
        if (el.hasAttribute('data-nl-eq')) return String(v) === attr(el, 'data-nl-eq');
        if (el.hasAttribute('data-nl-ne')) return String(v) !== attr(el, 'data-nl-ne');
        return !isEmpty(v) && v !== false && v !== 0;
    }
    // 字段列表里按点路径找字段（分组.字段）
    function fieldOf(fields, sub) {
        var parts = String(sub).split('.');
        var list = fields || [];
        var f = null;
        for (var i = 0; i < parts.length; i++) {
            f = null;
            for (var j = 0; j < list.length; j++) if (list[j].key === parts[i]) f = list[j];
            if (!f) return null;
            list = f.fields || [];
        }
        return f;
    }
    function itemMeta(path, sub) {
        var meta = own(VARS, path) ? VARS[path] : null;
        var val = meta && meta.value;
        if (!val) return null;
        if (sub === '' || sub === null || sub === undefined) return val;
        return fieldOf(val.fields, sub);
    }
    // 绝对路径的定义：变量本身，或者记录条目里的字段（记录路径.键.字段[.子字段]）
    function metaOf(path) {
        if (own(VARS, path)) return VARS[path];
        var parts = String(path).split('.');
        for (var i = parts.length - 1; i >= 1; i--) {
            var head = parts.slice(0, i).join('.');
            var rec = own(VARS, head) ? VARS[head] : null;
            if (rec && rec.type === 'record') return parts.length === i + 1 ? rec.value || null : itemMeta(head, parts.slice(i + 1).join('.'));
        }
        return null;
    }
    // 分组的字段：变量表里的分组定义；固定分组（如 世界）取它下一层的变量；都没有时按值的键
    function groupMeta(path) {
        var m = metaOf(path);
        if (m && m.fields) return m;
        var prefix = path + '.';
        var fields = [];
        (SPEC.variables || []).forEach(function (v) {
            var rest = v.path.indexOf(prefix) === 0 ? v.path.slice(prefix.length) : '';
            if (rest && rest.indexOf('.') < 0 && v.widget !== 'hidden') fields.push({ key: rest, label: v.label, type: v.type, min: v.min, max: v.max, stages: v.stages });
        });
        return fields.length ? { fields: fields } : null;
    }
    // 在一个作用域（记录条目或分组字段）里填相对绑定
    function fillItems(root, value, metaFn) {
        root.querySelectorAll('[data-nl-item]').forEach(function (it) {
            var x = getPath(value, attr(it, 'data-nl-item'));
            it.textContent = fmt(x, it);
            setValueAttr(it, x);
        });
        root.querySelectorAll('[data-nl-item-bar]').forEach(function (it) {
            var sub = attr(it, 'data-nl-item-bar');
            setBar(it, getPath(value, sub), metaFn(sub));
        });
        root.querySelectorAll('[data-nl-item-stage]').forEach(function (it) {
            var sub = attr(it, 'data-nl-item-stage');
            var x = getPath(value, sub);
            var m = metaFn(sub);
            it.textContent = stageLabel(m, x) || attr(it, 'data-nl-empty') || '';
            setStage(it, m, x);
            setValueAttr(it, x);
        });
        root.querySelectorAll('[data-nl-item-show]').forEach(function (it) {
            it.hidden = !shown(it, getPath(value, attr(it, 'data-nl-item-show')));
        });
    }
    function clearGenerated(el) {
        var tpl = null;
        Array.prototype.slice.call(el.children).forEach(function (c) {
            if (c.hasAttribute('data-nl-gen')) el.removeChild(c);
            else if (!tpl && c.tagName === 'TEMPLATE') tpl = c;
        });
        return tpl;
    }
    function appendGenerated(el, frag, idx, field) {
        Array.prototype.slice.call(frag.childNodes).forEach(function (n) {
            if (n.nodeType !== 1) return;
            n.setAttribute('data-nl-gen', '');
            n.setAttribute('data-nl-index', String(idx));
            if (field !== null) n.setAttribute('data-nl-field', field);
            el.appendChild(n);
        });
    }
    function fillGroup(el, value, meta) {
        var tpl = clearGenerated(el);
        if (!tpl) return;
        var fields = meta && meta.fields && meta.fields.length ? meta.fields
            : value && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value).map(function (k) { return { key: k }; }) : [];
        fields.forEach(function (f, idx) {
            var x = value && typeof value === 'object' ? value[f.key] : undefined;
            var frag = tpl.content.cloneNode(true);
            frag.querySelectorAll('[data-nl-key]').forEach(function (k) { k.textContent = f.label || f.key; });
            fillItems(frag, x, function (sub) { return sub ? fieldOf(f.fields, sub) : f; });
            appendGenerated(el, frag, idx, f.key);
        });
        setValueAttr(el, value);
    }
    function fillEach(el, stat) {
        var path = attr(el, 'data-nl-each');
        var tpl = clearGenerated(el);
        if (!tpl) return;
        var v = getPath(stat, path);
        var isList = Array.isArray(v);
        var entries = [];
        if (isList) entries = v.map(function (x, i) { return [String(i), x]; });
        else if (v && typeof v === 'object') entries = Object.keys(v).map(function (k) { return [k, v[k]]; });
        entries.forEach(function (pair, idx) {
            var frag = tpl.content.cloneNode(true);
            frag.querySelectorAll('[data-nl-key]').forEach(function (k) { k.textContent = pair[0]; });
            fillItems(frag, pair[1], function (sub) { return itemMeta(path, sub); });
            frag.querySelectorAll('[data-nl-group]').forEach(function (g) {
                var sub = attr(g, 'data-nl-group');
                fillGroup(g, getPath(pair[1], sub), itemMeta(path, sub));
            });
            // 立绘：模板里 data-nl-portrait 的值为空时指当前条目（列表时是这一项的文字）
            frag.querySelectorAll('[data-nl-portrait],[data-nl-portrait-next]').forEach(function (p) {
                var lit = attr(p, p.hasAttribute('data-nl-portrait') ? 'data-nl-portrait' : 'data-nl-portrait-next');
                var nm = lit ? lit : isList ? (typeof pair[1] === 'string' ? pair[1] : '') : pair[0];
                p.setAttribute('data-nl-portrait-name', nm);
                if (!isList && !p.hasAttribute('data-nl-portrait-record')) p.setAttribute('data-nl-portrait-record', path);
            });
            appendGenerated(el, frag, idx, null);
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

    // ---- 立绘（地址来自 NovelLoom 的配置 window.NL_PORTRAITS，不是界面代码写的）----
    function hashStr(s) {
        var h = 0;
        var t = String(s);
        for (var i = 0; i < t.length; i++) h = ((h << 5) - h + t.charCodeAt(i)) | 0;
        return Math.abs(h);
    }
    function storeKey(name) {
        return 'nl-sb:' + CARD + ':' + name;
    }
    // 记在本地存储里的值（与 statusbar-portraits.js 的 portraitChoiceId 一致）：地址本身；内嵌图片太长，记成哈希 + 长度
    var idMemo = new Map(); // 内嵌图片很长：每张只算一次哈希
    function choiceId(url) {
        var s = String(url);
        if (s.slice(0, 5).toLowerCase() !== 'data:') return s;
        if (!idMemo.has(s)) idMemo.set(s, 'nl#' + hashStr(s).toString(36) + '.' + s.length.toString(36));
        return idMemo.get(s);
    }
    function savedIndex(urls, saved) {
        if (saved === null || saved === undefined) return -1;
        for (var i = 0; i < urls.length; i++) if (urls[i] === saved || choiceId(urls[i]) === saved) return i;
        return -1;
    }
    // 图片实际加载的地址：预览里换成父页面给的 data:image（只认酒馆服务器路径、只认 base64 的位图），其他时候就是配置的地址
    function srcOf(url) {
        var s = PSRC && String(url).indexOf('/user/images/') === 0 && own(PSRC, url) ? PSRC[url] : null;
        return typeof s === 'string' && /^data:image\/(?:png|jpe?g|gif|webp|avif|bmp);base64,/i.test(s) ? s : url;
    }
    // 手动选的立绘：先记在内存里，再尽量写进本地存储（沙箱预览或禁用存储时只在内存里）
    function storeGet(name) {
        if (own(chosen, name)) return chosen[name];
        try {
            var ls = window.localStorage;
            return ls ? ls.getItem(storeKey(name)) : null;
        } catch (e) {
            return null;
        }
    }
    function storeSet(name, value) {
        chosen[name] = value;
        try {
            var ls = window.localStorage;
            if (!ls) return;
            if (value === null) ls.removeItem(storeKey(name));
            else ls.setItem(storeKey(name), String(value));
        } catch (e) {
            // 只是记不住手动选择
        }
    }
    function charImages(name) {
        if (own(PCHARS, name)) return PCHARS[name];
        var t = String(name).trim().toLowerCase();
        var keys = Object.keys(PCHARS);
        for (var i = 0; i < keys.length; i++) if (keys[i].trim().toLowerCase() === t) return PCHARS[keys[i]];
        return [];
    }
    function condOk(c, entry, stat) {
        if (!c || !c.path) return true;
        var x = entry !== null && typeof entry === 'object' ? getPath(entry, c.path) : undefined;
        if (x === undefined) x = getPath(stat, c.path);
        if (c.op === '==') return String(x) === String(c.value);
        var n = Number(x);
        var m = Number(c.value);
        if (x === null || x === undefined || x === '' || typeof x === 'boolean' || !isFinite(n) || !isFinite(m)) return false;
        return c.op === '<=' ? n <= m : n >= m;
    }
    function portraitInfo(name, record, stat) {
        var holder = record ? getPath(stat, record) : stat;
        var entry = own(holder, name) ? holder[name] : undefined;
        var urls = [];
        (charImages(name) || []).forEach(function (img) {
            if (img && img.url && condOk(img.when, entry, stat)) urls.push(img.url);
        });
        var index = urls.length - 1;
        if (!urls.length && record) {
            for (var i = 0; i < PPOOLS.length; i++) {
                var p = PPOOLS[i];
                if (!p || p.record !== record) continue;
                var val = entry !== null && typeof entry === 'object' ? getPath(entry, p.field) : undefined;
                var hit = val !== undefined && val !== null && own(p.pools, String(val)) ? p.pools[String(val)] : p.fallback;
                if (hit && hit.length) {
                    urls = hit.slice();
                    break;
                }
            }
            index = urls.length ? hashStr(name) % urls.length : -1;
        }
        var dflt = index;
        var s = urls.length > 1 ? savedIndex(urls, storeGet(name)) : -1;
        if (s >= 0) index = s;
        return { name: name, urls: urls, index: index, dflt: dflt, url: index >= 0 ? urls[index] : '' };
    }
    function portraitName(el, name) {
        var n = attr(el, 'data-nl-portrait-name');
        if (n === null || n === '') n = attr(el, name);
        return n === null ? '' : String(n).trim();
    }
    function initialOf(name) {
        var a = Array.from(String(name || '').trim());
        return a.length ? a[0].toUpperCase() : '?';
    }
    function hostOf(img) {
        return img.hasAttribute('data-nl-portrait') ? img : img.parentNode;
    }
    function placeholderOf(img) {
        var ph = img.nextElementSibling;
        if (!ph || !ph.hasAttribute('data-nl-ph')) {
            ph = document.createElement('span');
            ph.setAttribute('data-nl-ph', '');
            ph.setAttribute('aria-hidden', 'true');
            if (img.hasAttribute('data-nl-gen')) ph.setAttribute('data-nl-gen', '');
            img.parentNode.insertBefore(ph, img.nextSibling);
        }
        return ph;
    }
    function setPortraitState(img, state) {
        var host = hostOf(img);
        var ph = placeholderOf(img);
        var ok = state === 'ok';
        if (host) host.setAttribute('data-nl-portrait-state', state);
        img.hidden = !ok;
        ph.hidden = ok;
    }
    function showPortrait(el, info) {
        var img = el;
        if (el.tagName !== 'IMG') {
            img = null;
            for (var i = 0; i < el.children.length; i++) {
                if (el.children[i].tagName === 'IMG' && el.children[i].classList.contains('nl-portrait-img')) img = el.children[i];
            }
            if (!img) {
                img = document.createElement('img');
                img.className = 'nl-portrait-img';
                el.insertBefore(img, el.firstChild);
            }
        }
        var ph = placeholderOf(img);
        ph.className = (img === el && img.className ? img.className + ' ' : '') + 'nl-portrait-ph';
        ph.textContent = initialOf(info.name);
        ph.style.setProperty('--nl-ph-hue', String(hashStr(info.name) % 360));
        el.setAttribute('data-nl-portrait-count', String(info.urls.length));
        img.alt = info.name;
        if (!img.hasAttribute('data-nl-ph-bound')) {
            img.setAttribute('data-nl-ph-bound', '');
            img.addEventListener('load', function () { if (img.getAttribute('src')) setPortraitState(img, 'ok'); });
            img.addEventListener('error', function () { setPortraitState(img, 'error'); });
        }
        var src = info.url ? srcOf(info.url) : '';
        if (!src) {
            if (img.hasAttribute('src')) img.removeAttribute('src');
            setPortraitState(img, 'empty');
        } else if (img.getAttribute('src') !== src) {
            img.setAttribute('referrerpolicy', 'no-referrer');
            setPortraitState(img, 'loading');
            img.setAttribute('src', src);
        } else if (img.complete) {
            setPortraitState(img, img.naturalWidth > 0 ? 'ok' : 'error');
        }
    }
    function applyPortraits(root) {
        var scope = root && root.querySelectorAll ? root : document;
        scope.querySelectorAll('[data-nl-portrait]').forEach(function (el) {
            var name = portraitName(el, 'data-nl-portrait');
            showPortrait(el, name ? portraitInfo(name, attr(el, 'data-nl-portrait-record') || '', lastStat) : { name: '', urls: [], index: -1, url: '' });
        });
        scope.querySelectorAll('[data-nl-portrait-next]').forEach(function (el) {
            var name = portraitName(el, 'data-nl-portrait-next');
            var n = name ? portraitInfo(name, attr(el, 'data-nl-portrait-record') || '', lastStat).urls.length : 0;
            el.setAttribute('data-nl-portrait-count', String(n));
            el.hidden = n < 2;
        });
    }
    // 换一张：捕获阶段处理并阻止冒泡，按钮放在可点击的卡片里也不会顺带打开卡片
    function onSwap(e) {
        var t = e.target && e.target.closest ? e.target.closest('[data-nl-portrait-next]') : null;
        if (!t) return;
        e.preventDefault();
        e.stopPropagation();
        var name = portraitName(t, 'data-nl-portrait-next');
        if (!name) return;
        var info = portraitInfo(name, attr(t, 'data-nl-portrait-record') || '', lastStat);
        if (info.urls.length < 2) return;
        var next = (info.index + 1) % info.urls.length;
        storeSet(name, next === info.dflt ? null : choiceId(info.urls[next]));
        applyPortraits(document);
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
        lastStat = stat;
        doc.querySelectorAll('[data-nl-each]').forEach(function (el) { fillEach(el, stat); });
        doc.querySelectorAll('[data-nl-group]').forEach(function (el) {
            // 记录模板里的分组已经按条目填过
            if (el.closest && el.closest('[data-nl-gen]')) return;
            var p = attr(el, 'data-nl-group');
            fillGroup(el, getPath(stat, p), groupMeta(p));
        });
        doc.querySelectorAll('[data-nl-text]').forEach(function (el) {
            var v = getPath(stat, attr(el, 'data-nl-text'));
            el.textContent = fmt(v, el);
            setValueAttr(el, v);
        });
        doc.querySelectorAll('[data-nl-bar]').forEach(function (el) {
            var p = attr(el, 'data-nl-bar');
            setBar(el, getPath(stat, p), metaOf(p));
        });
        doc.querySelectorAll('[data-nl-stage]').forEach(function (el) {
            var p = attr(el, 'data-nl-stage');
            var v = getPath(stat, p);
            var m = metaOf(p);
            el.textContent = stageLabel(m, v) || attr(el, 'data-nl-empty') || '';
            setStage(el, m, v);
            setValueAttr(el, v);
        });
        doc.querySelectorAll('[data-nl-show]').forEach(function (el) {
            el.hidden = !shown(el, getPath(stat, attr(el, 'data-nl-show')));
        });
        applyPortraits(doc);
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
                    meta: metaOf,
                    portraits: function (root) { applyPortraits(root || doc); },
                    portrait: function (name, record) {
                        var i = portraitInfo(String(name || ''), record || '', lastStat);
                        return { url: i.url ? srcOf(i.url) : '', urls: i.urls.map(srcOf), index: i.index };
                    },
                });
            } catch (e) {
                console.error('[NovelLoom] nlRender 出错', e);
            }
            applyPortraits(doc);
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
        if (!swapBound) {
            swapBound = true;
            document.addEventListener('click', onSwap, true);
        }
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

/** 记录值里的字段（分组带它自己的 fields）：键、类型、显示名、数字范围与阶段 */
function runtimeField(f) {
    const ff = { key: f.key, type: f.type };
    if (f.label) ff.label = f.label;
    if (Number.isFinite(f.min)) ff.min = f.min;
    if (Number.isFinite(f.max)) ff.max = f.max;
    if (f.stages?.length) ff.stages = f.stages.map((s) => ({ min: s.min, label: s.label }));
    if (f.type === 'object') ff.fields = (f.fields || []).map(runtimeField);
    return ff;
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
                if (v.value.fields) val.fields = v.value.fields.map(runtimeField);
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
        '.nlb-card h4{margin:0 0 4px;font-size:12px;font-weight:600;color:var(--nlb-muted);letter-spacing:.02em;display:flex;align-items:center;gap:6px}',
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
        '.nlb-lg{display:flex;flex-wrap:wrap;align-items:center;gap:2px 8px;flex:1 1 100%;min-width:0;padding-left:8px;border-left:2px solid var(--nlb-track)}',
        '.nlb-lgt{color:var(--nlb-muted);font-size:11px;font-weight:600}',
        '.nlb-av{width:28px;height:28px;border-radius:50%;flex:0 0 auto;font-size:12px}',
        '.nlb-card h4 .nlb-av{width:22px;height:22px;font-size:11px}',
    ].join('\n');
}

function labelOf(v) {
    if (v.label) return v.label;
    const segs = splitPath(v.path);
    return String(segs[segs.length - 1] || v.path).replace(/^[_$]+/, '') || v.path;
}

/** 记录条目里的一个字段（sub 是相对条目的点路径，分组字段是 分组.字段） */
function recordFieldHtml(f, sub) {
    const fk = htmlSafe(sub);
    const label = htmlSafe(f.label || f.key);
    const stage = f.type === 'number' && f.stages?.length ? ` <span class="nlb-stage" data-nl-item-stage="${fk}"></span>` : '';
    if (f.type === 'number' && Number.isFinite(f.min) && Number.isFinite(f.max)) {
        return `<span class="nlb-lf">${label}<b data-nl-item="${fk}"></b> <span class="nlb-ibar" data-nl-item-bar="${fk}"><i></i></span>${stage}</span>`;
    }
    return `<span class="nlb-lf">${label}<b data-nl-item="${fk}"></b>${stage}</span>`;
}

/** 记录条目里的分组：小标题 + 组内字段（一个子区块） */
function recordGroupHtml(g) {
    const inner = (g.fields || []).map((f) => recordFieldHtml(f, `${g.key}.${f.key}`)).join('');
    return `<span class="nlb-lg" data-nl-field-group="${htmlSafe(g.key)}"><span class="nlb-lgt">${htmlSafe(g.label || g.key)}</span>${inner}</span>`;
}

function itemHtml(v, { avatar = false } = {}) {
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
                inner = (val.fields || []).map((f) => (f.type === 'object' ? recordGroupHtml(f) : recordFieldHtml(f, f.key))).join('');
            } else if (val.type === 'number' && Number.isFinite(val.min) && Number.isFinite(val.max)) {
                inner = '<span class="nlb-lf"><b data-nl-item=""></b> <span class="nlb-ibar" data-nl-item-bar=""><i></i></span></span>';
            } else {
                inner = '<span class="nlb-lf"><b data-nl-item=""></b></span>';
            }
            const av = avatar ? '<img class="nlb-av" data-nl-portrait="" alt="">' : '';
            return `<div class="nlb-sub"><span class="nlb-k">${htmlSafe(labelOf(v))}</span><div class="nlb-list" data-nl-each="${p}" data-nl-empty="（空）"><template><div class="nlb-li">${av}<span class="nlb-lk" data-nl-key></span>${inner}</div></template></div></div>`;
        }
        default:
            return `<div class="nlb-row">${k}<span class="nlb-v" data-nl-text="${p}"></span></div>`;
    }
}

/**
 * 内置排版：每个第一层路径一张小卡片，按 widget 排版；不需要 AI。
 * @param {{title?:string, variables:object[]}} spec 规范化后的变量表
 * @param {'clean'|'night'|'paper'} theme
 * @param {{portraits?: object}} opt 配置了立绘时（portraitsActive），记录的每个条目前加一个小头像，
 *   有立绘的固定分组（例如 莉莉丝.好感度 里的「莉莉丝」）在卡片标题前加头像；没配置时输出与以前完全一样
 * @returns {string} 绑定模式的 HTML 片段（<style> + 标记）
 */
export function renderDefaultFragment(spec, theme = 'clean', { portraits = null } = {}) {
    const avatar = portraitsActive(portraits);
    const groups = new Map();
    for (const v of spec?.variables || []) {
        if (v.widget === 'hidden') continue;
        const segs = splitPath(v.path);
        const key = segs.length > 1 ? segs[0] : '';
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(v);
    }
    const title = spec?.title || '状态栏';
    const hasOwnPortrait = (key) => avatar && Object.prototype.hasOwnProperty.call(portraits.characters || {}, key) && portraits.characters[key]?.length > 0;
    const cards = [...groups.entries()].map(([key, vars]) => {
        const av = key && hasOwnPortrait(key) ? `<img class="nlb-av" data-nl-portrait="${htmlSafe(key)}" alt="">` : '';
        const head = key ? `<h4>${av}${htmlSafe(key.replace(/^[_$]+/, '') || key)}</h4>` : '';
        return `<section class="nlb-card">${head}${vars.map((v) => itemHtml(v, { avatar })).join('')}</section>`;
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
 * 立绘手动选择记在本地存储里的命名空间（键是 'nl-sb:<这个值>:<角色名>'）：NovelLoom 的卡片 id，
 * 没有时用状态栏正则的 uuid，只保留字母、数字、_ 和 -。
 */
export function statusBarStoreId(card) {
    const raw = String(card?.id || card?.statusBar?.ids?.regexBar || '');
    return raw.replace(/[^\w-]/g, '').slice(0, 64) || 'card';
}

// ---------------- 记住的立绘选择（聊天与预览共用） ----------------
// 酒馆助手的状态栏 iframe 与酒馆页面同源：运行时把手动换的立绘记在酒馆页面的本地存储里，键是 'nl-sb:<卡片>:<名字>'，
// 值是配置里的地址（内嵌图片记短 id，见 portraitChoiceId）。预览里酒馆图片换成了 data:image（NL_PREVIEW_SRC），但记的仍是原路径。
// NovelLoom 的预览是 sandbox iframe，自己访问不了本地存储：预览页面里装一个代用的 localStorage（见 previewMocks），
// 读的是父页面通过 buildPreviewSrcdoc 的 opts.store 传进来的记录，写的时候发 {type:'nl-store', key, value} 给父页面，
// 父页面（就是酒馆页面）用 writePortraitChoice 写进真正的本地存储。所以预览里换的图重新载入后还在，也和聊天里这张卡记着的是同一份。
// 父页面的本地存储不可用时退回到内存（只在这次打开的页面里有效）。

const STORE_KEY_NAME_MAX = 200;
/** 一张卡最多记多少条立绘选择（页面本地存储里本卡前缀的键 + 内存里的） */
export const STORE_ENTRIES_MAX = 200;
/**
 * 一张卡记着的立绘选择合计最多多少字（键 + 值）：不让预览把酒馆页面的本地存储（通常每个站点约 500 万字）塞满。
 * 现在的运行时只记地址或内嵌图片的短 id（portraitChoiceId），值很短；旧版本记的完整 data: 地址（最长 PORTRAIT_DATA_URL_MAX）也照样认。
 */
export const STORE_CHARS_MAX = 524288;
/** 页面本地存储不可用时记在内存里的选择，所有卡合计最多几条 */
const MEMORY_CHOICES_MAX = STORE_ENTRIES_MAX * 5;
const memoryChoices = new Map();

/** 立绘选择在本地存储里的键前缀：'nl-sb:<statusBarStoreId>:' */
export function portraitStorePrefix(card) {
    return `nl-sb:${statusBarStoreId(card)}:`;
}

function pageStorage() {
    try {
        return globalThis.localStorage || null;
    } catch {
        return null;
    }
}

function choiceKeyOk(prefix, key) {
    return typeof key === 'string' && key.startsWith(prefix) && key.length > prefix.length && key.length <= prefix.length + STORE_KEY_NAME_MAX && !/[\r\n]/.test(key);
}

// 值：地址（http(s) / 酒馆图片最长 2048 字）、内嵌图片的短 id，或旧版本记的完整 data: 地址——用卡片的单张上限，卡里能放的都认
function choiceValueOk(value) {
    return typeof value === 'string' && value.length > 0 && value.length <= PORTRAIT_DATA_URL_MAX;
}

/**
 * 这张卡记着的立绘选择 {键: 图片地址}（只取本卡前缀的键），交给 buildPreviewSrcdoc 的 opts.store。
 * @param {object} card
 * @param {Storage|null} [storage] 默认是当前页面的 localStorage（取不到时只用内存里的）
 */
export function readPortraitChoices(card, storage = pageStorage()) {
    const prefix = portraitStorePrefix(card);
    const out = {};
    try {
        const n = storage ? Number(storage.length) || 0 : 0;
        for (let i = 0; i < n && Object.keys(out).length < STORE_ENTRIES_MAX; i++) {
            const k = storage.key(i);
            if (!choiceKeyOk(prefix, k)) continue;
            const v = storage.getItem(k);
            if (choiceValueOk(v)) out[k] = v;
        }
    } catch { /* 读不了就只用内存里的 */ }
    for (const [k, v] of memoryChoices) if (k.startsWith(prefix)) out[k] = v;
    return out;
}

/** 这张卡配置的全部立绘地址（与编译进文档的 NL_PORTRAITS 同一份：角色的图片、图池各取值的图片与兜底） */
export function portraitChoiceUrls(card) {
    const p = documentPortraits(statusBarOf(card).portraits);
    const out = new Set();
    if (!p) return out;
    for (const list of Object.values(p.characters)) for (const img of list) out.add(img.url);
    for (const pool of p.pools) {
        for (const list of Object.values(pool.pools)) for (const url of list) out.add(url);
        for (const url of pool.fallback) out.add(url);
    }
    return out;
}

/** 预览发来的选择可以是哪些值：配置的每个地址，加上内嵌图片的短 id（portraitChoiceId，运行时现在记的就是它） */
function portraitChoiceValues(card) {
    const out = new Set();
    for (const url of portraitChoiceUrls(card)) {
        out.add(url);
        out.add(portraitChoiceId(url));
    }
    return out;
}

/** 立绘名字的比较形式：去掉首尾空白、小写（与运行时 charImages 找角色图片时的匹配一致） */
const choiceNameKey = (name) => String(name ?? '').trim().toLowerCase();

/**
 * 用这份数据渲染时状态栏里可能出现「换一张」的名字（choiceNameKey 形式）：配置了立绘的角色名，
 * 加上配了图池的记录（pool.record）在这份数据里的条目名。预览发来的 nl-store 只接受这些名字
 * （portraitChoiceProblem 的 opt.data），AI 写的界面代码造出来的其他名字不会占掉本卡的条数上限。
 * @param {object} card
 * @param {object|null} data 预览正在显示的 stat_data
 * @returns {Set<string>}
 */
export function portraitChoiceNames(card, data) {
    const p = documentPortraits(statusBarOf(card).portraits);
    const out = new Set();
    if (!p) return out;
    for (const name of Object.keys(p.characters)) out.add(choiceNameKey(name));
    for (const pool of p.pools) {
        let holder = data;
        for (const seg of splitPath(pool.record)) holder = isPlainObj(holder) && Object.prototype.hasOwnProperty.call(holder, seg) ? holder[seg] : undefined;
        if (isPlainObj(holder)) for (const k of Object.keys(holder)) out.add(choiceNameKey(k));
    }
    out.delete('');
    return out;
}

/** 本卡已经记着的选择：键 → 占用的字数（键 + 值），页面本地存储里本卡前缀的键（不管值是否合法）加上内存里的 */
function storedChoiceSizes(prefix, storage) {
    const out = new Map();
    try {
        const n = storage ? Number(storage.length) || 0 : 0;
        for (let i = 0; i < n; i++) {
            const k = storage.key(i);
            if (typeof k !== 'string' || !k.startsWith(prefix)) continue;
            const v = storage.getItem(k);
            out.set(k, k.length + (typeof v === 'string' ? v.length : 0));
        }
    } catch { /* 读不了就只算内存里的 */ }
    for (const [k, v] of memoryChoices) if (k.startsWith(prefix)) out.set(k, k.length + v.length);
    return out;
}

/**
 * 预览页面发来的一条立绘选择能不能记下（父页面处理 nl-store 前用它把关；writePortraitChoice 内部也先调用它）。
 * 预览里跑的是 AI 写的界面代码，消息内容不可信：
 * - 键必须是本卡前缀 'nl-sb:<卡>:' 加 1~200 字的名字（不含换行）；
 * - 值是 null（回到默认，删掉这条）或这张卡配置的某张立绘的地址（portraitChoiceUrls）/ 内嵌图片的短 id（portraitChoiceId），
 *   别的字符串一律拒绝；
 * - 本卡已经记着 STORE_ENTRIES_MAX 条时不再接受新的键（已有的键仍可改、可删）；合计超过 STORE_CHARS_MAX 字时拒绝；
 * - 给了 opt.data（预览正在显示的数据）时，名字还必须是用这份数据渲染时可能换图的（portraitChoiceNames），删除也一样——
 *   预览只能改它显示着的角色的选择，造出来的名字既不占条数上限，也删不掉聊天里记着的其他角色的选择。
 * @param {{data?: object|null}} [opt]
 * @returns {string} 可以记下时为空串，否则是原因
 */
export function portraitChoiceProblem(card, key, value, storage = pageStorage(), { data } = {}) {
    const prefix = portraitStorePrefix(card);
    if (!choiceKeyOk(prefix, key)) return '不是这张卡的立绘记录';
    if (data !== undefined && !portraitChoiceNames(card, data).has(choiceNameKey(key.slice(prefix.length)))) return '预览里没有这个角色的立绘';
    if (value === null) return '';
    if (!choiceValueOk(value)) return '立绘地址无效';
    if (!portraitChoiceValues(card).has(value)) return '不是这张卡配置的立绘地址';
    const have = storedChoiceSizes(prefix, storage);
    if (!have.has(key) && have.size >= STORE_ENTRIES_MAX) return `这张卡已经记着 ${STORE_ENTRIES_MAX} 条立绘选择`;
    let total = key.length + value.length;
    for (const [k, n] of have) if (k !== key) total += n;
    if (total > STORE_CHARS_MAX) return `这张卡记着的立绘选择合计超过 ${STORE_CHARS_MAX} 字`;
    return '';
}

/**
 * 预览页面发来的 {type:'nl-store', key, value}：经 portraitChoiceProblem 把关（本卡前缀的键；值是本卡的立绘地址，
 * null = 回到默认，删掉这条；条数与字数有上限），写进页面的本地存储；写不进去时记在内存里（内存也有上限）。返回是否接受了。
 */
export function writePortraitChoice(card, key, value, storage = pageStorage()) {
    if (portraitChoiceProblem(card, key, value, storage)) return false;
    try {
        if (!storage) throw new Error('no storage');
        if (value === null) storage.removeItem(key);
        else storage.setItem(key, value);
        memoryChoices.delete(key);
    } catch {
        if (value === null) memoryChoices.delete(key);
        else if (memoryChoices.has(key) || memoryChoices.size < MEMORY_CHOICES_MAX) memoryChoices.set(key, value);
        else return false;
    }
    return true;
}

/** buildPreviewSrcdoc 的 opts.store：只留本卡前缀的键与合法的值 */
function previewStore(card, store) {
    if (!isPlainObj(store)) return {};
    const prefix = portraitStorePrefix(card);
    const out = {};
    for (const [k, v] of Object.entries(store)) {
        if (Object.keys(out).length >= STORE_ENTRIES_MAX) break;
        if (choiceKeyOk(prefix, k) && choiceValueOk(v)) out[k] = v;
    }
    return out;
}

/** 编译进文档的立绘配置：按卡片的上限重新校验一遍（只留 http(s)、酒馆图片 /user/images/… 与 data:image），没有任何图片时为 null */
export function documentPortraits(portraits) {
    const p = normalizePortraits(portraits);
    return portraitsActive(p) ? p : null;
}

/**
 * buildPreviewSrcdoc 的 opts.srcMap → 预览页面里的 NL_PREVIEW_SRC：只留这份文档里配置的、NovelLoom 自己上传的酒馆图片
 * （/user/images/…/nl_<哈希>.…，isOwnServerImage；父页面带登录信息读来的图库文件不交给沙箱里别的路径），
 * 值必须是合法的 base64 位图 data:image（DATA_IMAGE_RE，不含 svg；不限长度——只在预览里用，不进卡片也不进导出）。
 * @param {object} card
 * @param {object|Map|null} srcMap {酒馆图片路径: 父页面取来的 data:image}
 * @param {object|undefined} portraits 预览覆盖的立绘（opts.override.portraits），没有时用卡片自己的
 */
function previewSrcs(card, srcMap, portraits) {
    const entries = srcMap instanceof Map ? [...srcMap] : isPlainObj(srcMap) ? Object.entries(srcMap) : [];
    if (!entries.length) return {};
    const urls = portraitChoiceUrls({ statusBar: { portraits: portraits !== undefined ? portraits : statusBarOf(card).portraits } });
    const out = {};
    for (const [k, v] of entries) {
        if (typeof k === 'string' && k.startsWith(SERVER_IMAGE_PREFIX) && urls.has(k) && isOwnServerImage(k) && typeof v === 'string' && DATA_IMAGE_RE.test(v)) out[k] = v;
    }
    return out;
}

/**
 * 组装状态栏正则里的完整 HTML 文档（不含外层代码块）。
 * - bind：AI 写的片段（为空时用内置排版）+ NL 运行时
 * - auto：内置排版 + NL 运行时
 * - raw：用户粘贴的完整文档，原样使用（没有 <body>/<head> 时补一层 <body>，否则酒馆助手不会渲染）；不注入运行时（也就没有立绘）
 * bind/auto 下配置了立绘时多一行 <script>window.NL_CARD_ID = "…";window.NL_PORTRAITS = {…};</script>（jsLit 转义），由运行时读取。
 * @param {object} card 带 statusBar 的角色卡
 * @param {{mode?:string, html?:string, theme?:string, spec?:object, portraits?:object}} override 预览未保存的编辑时覆盖对应字段
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
    const portraits = documentPortraits(override.portraits !== undefined ? override.portraits : sb.portraits);
    const cleaned = mode === 'bind' ? cleanFragment(html) : '';
    const fragment = cleaned || renderDefaultFragment(spec, theme, { portraits });
    return [
        '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">',
        `<style>\n${BASE_CSS}\n</style>`,
        '</head><body>',
        `<script>window.NL_SPEC = ${jsLit(runtimeSpec(spec))};</script>`,
        portraits ? `<script>window.NL_CARD_ID = ${jsStr(statusBarStoreId(card))};window.NL_PORTRAITS = ${jsLit(portraits)};</script>` : '',
        fragment,
        `<div class="nl-empty-hint" hidden>${htmlSafe(STATUS_EMPTY_HINT)}</div>`,
        `<script>\n${buildNlRuntime()}\n</script>`,
        '</body></html>',
    ].filter(Boolean).join('\n');
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
    // 沙箱里访问不了本地存储：换成一个代用品，读父页面传来的立绘选择（boot.store），写的时候告诉父页面（由它记进酒馆页面的本地存储）
    var storeBlocked = false;
    try {
        storeBlocked = !window.localStorage;
    } catch (e) {
        storeBlocked = true;
    }
    if (storeBlocked) {
        var mem = {};
        var seed = boot.store && typeof boot.store === 'object' ? boot.store : {};
        Object.keys(seed).forEach(function (k) { if (typeof seed[k] === 'string') mem[k] = seed[k]; });
        var has = function (k) { return Object.prototype.hasOwnProperty.call(mem, k); };
        var shim = {
            getItem: function (k) { return has(String(k)) ? mem[String(k)] : null; },
            setItem: function (k, v) {
                mem[String(k)] = String(v);
                post({ type: 'nl-store', key: String(k), value: String(v) });
            },
            removeItem: function (k) {
                delete mem[String(k)];
                post({ type: 'nl-store', key: String(k), value: null });
            },
            key: function (i) { return Object.keys(mem)[i] === undefined ? null : Object.keys(mem)[i]; },
            clear: function () { Object.keys(mem).forEach(function (k) { shim.removeItem(k); }); },
        };
        Object.defineProperty(shim, 'length', { get: function () { return Object.keys(mem).length; } });
        try {
            Object.defineProperty(window, 'localStorage', { configurable: true, enumerable: true, get: function () { return shim; } });
        } catch (e) { /* 换不掉时换图只记在内存里 */ }
    }
    // 酒馆服务器上的立绘：沙箱里请求 /user/images/… 可能带不上登录信息，父页面先取来换成 data:image（运行时的 srcOf 读它）。
    // 定义成只读：界面代码改不掉；运行时记住的选择仍是原来的路径，和聊天里的一样
    if (boot.src && typeof boot.src === 'object') {
        var srcs = Object.create(null);
        Object.keys(boot.src).forEach(function (k) { if (typeof boot.src[k] === 'string') srcs[k] = boot.src[k]; });
        try {
            Object.defineProperty(window, 'NL_PREVIEW_SRC', { value: Object.freeze(srcs), writable: false, configurable: false, enumerable: false });
        } catch (e) { /* 定义不了就直接加载原路径 */ }
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
 *              / {source:'nl-preview', type:'nl-store', key, value}（换了立绘：父页面用 writePortraitChoice 记下，value 为 null 表示回到默认）
 *   父 → iframe：{type:'nl-sample', stat}（替换示例变量并触发 mag_variable_update_ended）
 * @param {object} card 带 statusBar 的角色卡
 * @param {object} [sample] 示例 stat_data；缺省用 statusBar.sample，再缺省用变量表初始值
 * @param {{user?:string, char?:string, override?:object, tailwind?:string, cdn?:string, store?:object, srcMap?:object|Map}} opts
 *   override：传给 compileStatusDocument 的覆盖字段；tailwind：raw 模式下内联的 tailwind 运行时代码（父页面取到才传）；
 *   store：记着的立绘选择（readPortraitChoices），预览里代用的 localStorage 从这里读，只留本卡前缀的键；
 *   srcMap：{酒馆图片路径: data:image}，父页面取来的酒馆服务器立绘（previewSrcs 过滤）。只换图片实际加载的地址（window.NL_PREVIEW_SRC），
 *   文档里的 NL_PORTRAITS 与运行时记住的选择仍是原来的路径——不会写进卡片，也不会进导出
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
    const boot = { sample: cloneJson(data), user, char, store: previewStore(card, opts.store) };
    const src = mode === 'raw' ? {} : previewSrcs(card, opts.srcMap, opts.override?.portraits);
    if (Object.keys(src).length) boot.src = src;
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
