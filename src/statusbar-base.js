// 状态栏（MVU 变量）的底层纯函数：JS/HTML 安全转义、酒馆正则替换模拟、路径读写、初始状态。
// 只依赖内置对象，不引用其他 NovelLoom 模块，statusbar.js 与 statusbar-runtime.js 都从这里取，避免循环依赖。
// 对外请从 statusbar.js 引用（这里的导出在 statusbar.js 里原样再导出）。

/** MVU 固定使用的占位标签：MVU 会在它处理过的每条 AI 回复末尾追加 "\n\n<StatusPlaceHolderImpl/>" */
export const STATUS_TAG = '<StatusPlaceHolderImpl/>';

const LS = String.fromCharCode(0x2028);
const PS = String.fromCharCode(0x2029);
const JS_UNSAFE = { '<': '\\u003c', '>': '\\u003e', '$': '\\u0024', '{': '\\u007b', '}': '\\u007d', '`': '\\u0060', '*': '\\u002a', [LS]: '\\u2028', [PS]: '\\u2029' };
// 字符串内容里逐个扫描：先吃掉转义序列（\" 单独处理），再替换不安全的字符
const JS_STRING_RE = new RegExp('\\\\.|[<>${}`*' + LS + PS + ']', 'g');

/**
 * 任意 JSON 值 → JS 字面量文本。字符串里的 < > $ { } ` * 与转义的引号 \" 写成 \uXXXX：
 * 不会出现 </script、{{宏}}、$1 这类会被浏览器或酒馆正则替换误伤的序列；
 * 每行的 * 与 " 个数也总是偶数（酒馆的「自动修复 Markdown」会给个数为奇数的行末尾补一个，见 power-user.js fixMarkdown）。
 * 对象/数组的结构性花括号保留（JSON 的结构里不可能出现 "{{"）。
 */
export function jsLit(value) {
    const text = JSON.stringify(value === undefined ? null : value);
    return text.replace(/"(?:[^"\\]|\\.)*"/g, (tok) => {
        const body = tok.slice(1, -1).replace(JS_STRING_RE, (m) => (m === '\\"' ? '\\u0022' : m.length > 1 ? m : JS_UNSAFE[m]));
        return `"${body}"`;
    });
}

/** 字符串 → 安全的 JS 字符串字面量（带引号） */
export function jsStr(s) {
    return jsLit(String(s ?? ''));
}

/**
 * HTML 文本/属性转义，并把 $ { } ` * 也写成字符实体：生成的 HTML 放进酒馆正则替换串后不会被改写，
 * 也不会让某一行的 * 个数变成奇数（酒馆的「自动修复 Markdown」会在这种行末尾补一个 *）
 */
export function htmlSafe(text) {
    return String(text ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;')
        .replace(/\$/g, '&#36;')
        .replace(/\{/g, '&#123;')
        .replace(/\}/g, '&#125;')
        .replace(/`/g, '&#96;')
        .replace(/\*/g, '&#42;');
}

export function isPlainObj(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
}

export function cloneJson(v) {
    return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
}

/** "a.b.c" → ['a','b','c']；变量路径的段里不允许出现 "."（规范化时已保证） */
export function splitPath(path) {
    if (Array.isArray(path)) return path.map(String);
    const s = String(path ?? '');
    return s ? s.split('.') : [];
}

/** 按点路径取值（空路径返回对象本身） */
export function getPath(obj, path) {
    let cur = obj;
    for (const seg of splitPath(path)) {
        if (cur === null || cur === undefined || typeof cur !== 'object') return undefined;
        cur = cur[seg];
    }
    return cur;
}

/** 按点路径写值，沿途缺失的层级建成普通对象 */
export function setPath(obj, path, value) {
    const segs = splitPath(path);
    if (!segs.length) return value;
    let cur = obj;
    segs.forEach((seg, i) => {
        if (i === segs.length - 1) {
            cur[seg] = value;
            return;
        }
        if (!isPlainObj(cur[seg]) && !Array.isArray(cur[seg])) cur[seg] = {};
        cur = cur[seg];
    });
    return obj;
}

/** 变量表 → 初始状态（stat_data 的内容，不带 stat_data 外壳） */
export function buildInitialState(spec) {
    const out = {};
    for (const v of spec?.variables || []) setPath(out, v.path, cloneJson(v.init));
    return out;
}

/** JS-Slash-Runner 判断一个代码块是否渲染成前端页面的条件（src/util/is_frontend.ts） */
export function isFrontendText(text) {
    return ['html>', '<head>', '<body'].some((t) => String(text ?? '').includes(t));
}

/** 状态栏正则的替换串：前置换行保证代码块从新的一行开始（酒馆助手只把 <pre> 代码块渲染成 iframe） */
export function wrapStatusFence(doc) {
    return `\n\`\`\`html\n${doc}\n\`\`\`\n`;
}

/** wrapStatusFence 的逆操作；不是代码块时原样返回 */
export function unwrapStatusFence(text) {
    const m = String(text ?? '').match(/^\s*```[^\n]*\n([\s\S]*?)\n```\s*$/);
    return m ? m[1] : String(text ?? '');
}

// fixMarkdown 认作空白、会在 * / _ 旁边删掉的字符（写成 \u 转义，源文件里不出现不可见字符）
const MD_SPACE_CLASS = '[\\t \\u00a0\\u1680\\u2000-\\u200a\\u202f\\u205f\\u3000\\ufeff]';
const MD_SPACE_UNDERSCORE_RE = new RegExp(`(${MD_SPACE_CLASS})_|_(?=${MD_SPACE_CLASS})`, 'g');

/**
 * 酒馆显示消息时，代码块里的文字会被解码一层 HTML 实体再交给酒馆助手：
 * showdown 把代码块内容的 & < > 转义，messageFormatting（public/script.js）随后把 <code> 里的 &amp; 换回 &，
 * 酒馆助手再用 $pre.find('code').text() 取出代码（浏览器在这一步解码实体）。
 * 所以写进代码块之前先把每个 & 写成 &amp;，iframe 拿到的就是原文（&lt; 仍是 &lt;，&& 仍是 &&）。
 *
 * 借同一层解码，再把酒馆「自动修复 Markdown」（默认开启，power-user.js fixMarkdown，在正则替换之后、转成 HTML 之前
 * 对整条消息运行）会改动的字符写成数字实体，AI 或用户写的界面里有乘号、* 选择器、奇数个引号时也能原样到达 iframe：
 *   - 每个 * → &#42;（fixMarkdown 会给 * 个数为奇数的行末尾补一个 *，还会删掉成对 * 之间紧挨着 * 的空白）
 *   - " 个数为奇数的行里的 " → &#34;（同样会在行末补一个 "）
 *   - 紧挨着空白的 _ → &#95;（成对 _ 之间紧挨着 _ 的空白会被删掉；不挨着空白的 _ 不受影响，保持原样）
 */
export function encodeFenceText(doc) {
    return String(doc ?? '')
        .replace(/&/g, '&amp;')
        .replace(/\*/g, '&#42;')
        .split('\n')
        .map((line) => ((line.split('"').length - 1) % 2 ? line.replace(/"/g, '&#34;') : line))
        .join('\n')
        .replace(MD_SPACE_UNDERSCORE_RE, (m, before) => (before === undefined ? '&#95;' : `${before}&#95;`));
}

// 命名实体 → 码位（写成数字，源文件里不出现不可见字符）
const NAMED_ENTITIES = Object.fromEntries(Object.entries({
    amp: 0x26, AMP: 0x26, lt: 0x3c, LT: 0x3c, gt: 0x3e, GT: 0x3e, quot: 0x22, QUOT: 0x22, apos: 0x27, nbsp: 0xa0,
    copy: 0xa9, reg: 0xae, trade: 0x2122, hellip: 0x2026, mdash: 0x2014, ndash: 0x2013, middot: 0xb7,
    times: 0xd7, divide: 0xf7, laquo: 0xab, raquo: 0xbb, ldquo: 0x201c, rdquo: 0x201d, lsquo: 0x2018,
    rsquo: 0x2019, bull: 0x2022, deg: 0xb0, yen: 0xa5, euro: 0x20ac, hearts: 0x2665, ensp: 0x2002, emsp: 0x2003,
}).map(([k, cp]) => [k, String.fromCodePoint(cp)]));
const REPLACEMENT_CHAR = String.fromCharCode(0xfffd);

/**
 * 模拟上面那一层解码（encodeFenceText 的逆操作）：&amp; &lt; &#36; &#x24; 等字符实体 → 字符，只解一层。
 * 支持数字实体与常用的命名实体；不认识的命名实体原样保留（iframe 解析 HTML 时还会再解码，结果基本一致）。
 */
export function decodeFenceText(text) {
    return String(text ?? '').replace(/&(?:#(\d{1,8})|#[xX]([0-9a-fA-F]{1,7})|([a-zA-Z][a-zA-Z0-9]{0,31}));/g, (m, dec, hex, name) => {
        if (name !== undefined) return Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, name) ? NAMED_ENTITIES[name] : m;
        const cp = dec !== undefined ? parseInt(dec, 10) : parseInt(hex, 16);
        return cp > 0 && cp <= 0x10ffff && (cp < 0xd800 || cp > 0xdfff) ? String.fromCodePoint(cp) : REPLACEMENT_CHAR;
    });
}

const LEGACY_MARKERS = [
    [/<USER>/gi, '{{user}}'],
    [/<BOT>/gi, '{{char}}'],
    [/<CHAR>/gi, '{{char}}'],
    [/<GROUP>/gi, '{{group}}'],
    [/<CHARIFNOTGROUP>/gi, '{{charIfNotGroup}}'],
];

/**
 * 模拟酒馆 1.19 runRegexScript 对替换串的处理（public/scripts/extensions/regex/engine.js:419-444）：
 *   1) {{match}} → $0
 *   2) $数字 / $<名字> → 对应捕获组（没有就是空串）
 *   3) 对结果整体跑 substituteParams：旧式 <USER>/<BOT>/<CHAR>/<GROUP>/<CHARIFNOTGROUP>（不分大小写）先改写成宏，再展开 {{…}} 宏，
 *      最后去掉花括号前的反斜杠（\{ → {）
 * 未知的 {{…}} 一律按“会被改掉”处理（替换成空串），所以用它做往返检查是保守的。
 * @param {string} replaceString
 * @param {{match?: string, groups?: string[], named?: object, user?: string, char?: string, group?: string}} opt
 *   user/char 传 '{{user}}'/'{{char}}' 时这两个宏保持原样（用于往返检查）；预览时传真实名字
 */
export function simulateStRegexReplace(replaceString, { match = '', groups = [], named = {}, user = '{{user}}', char = '{{char}}', group = '' } = {}) {
    let s = String(replaceString ?? '').replace(/{{match}}/gi, '$0');
    s = s.replace(/\$(\d+)|\$<([^>]+)>/g, (_m, num, name) => {
        let v;
        if (num !== undefined) v = Number(num) === 0 ? match : groups[Number(num) - 1];
        else v = named?.[name];
        return v ? String(v) : '';
    });
    for (const [re, to] of LEGACY_MARKERS) s = s.replace(re, to);
    s = s.replace(/\{\{([^{}]*)\}\}/g, (m, inner) => {
        const key = String(inner).trim().toLowerCase();
        if (key === 'user') return user;
        if (key === 'char') return char;
        if (key === 'group') return group || char;
        if (key === 'charifnotgroup') return char;
        return '';
    });
    // 新宏引擎（1.19 默认开启）的后处理：\{ → {、\} → }（macros/engine/MacroEngine.js:302-308）
    return s.replace(/\\([{}])/g, '$1');
}
