// 状态栏 AI 生成（statusbar-ai.js）：变量表 JSON → 规范化、界面 ```html → 检查 → 修正重试 → 内置排版兜底、
// 保留路径的重新生成（只改初始值 / 只改规则）、沿用结构 / 只借外观模板、撤销、提示词与消息链注册。
// 全部用模拟的酒馆 generateRaw，不发真实请求。
import test from 'node:test';
import assert from 'node:assert/strict';

import { buildCardJson } from '../src/cards.js';
import { DEFAULT_SETTINGS, DEFAULT_STATUS_BAR } from '../src/constants.js';
import { CHAIN_TASKS, getChain } from '../src/llm.js';
import { DEFAULT_PROMPTS, PROMPT_LABELS, PROMPT_PLACEHOLDERS } from '../src/prompts.js';
import { createProject, normalizeCharacter, normalizeProject } from '../src/project.js';
import {
    buildInitialState, buildStatusRegexScripts, compileUpdateRules, countSpecLeaves, ensureStatusBar, lintStatusHtml,
    normalizeStatusSpec, parseStateWithSpec,
} from '../src/statusbar.js';
import {
    buildStatusHtmlPrompt, buildStatusSpecPrompt, castRecordPath, checkStatusHtml, extractHtmlBlock, generateStatusBar, isCastRecord,
    mergeKeptSpec, restoreStatusBarPrev, statusLayoutGuide, statusTypeGuide, statusWorldJsonTemplate, tryGenerateStatusBar,
} from '../src/statusbar-ai.js';
import { compileStatusDocument } from '../src/statusbar-runtime.js';
import { mergeDefaults, uid } from '../src/utils.js';
import { openStatusDocument } from './minidom.js';

function settings() {
    const s = mergeDefaults({}, DEFAULT_SETTINGS);
    s.api.retryBaseMs = 200;
    s.api.retries = 0;
    return s;
}

function project() {
    const p = createProject({ name: '雨夜' });
    p.bookName = '雨夜';
    p.chunks = [0, 1, 2].map((i) => ({ id: `c${i}`, index: i, title: `第${i + 1}章`, content: '', charCount: 100, end: 100, status: 'done' }));
    p.characters['林小雨'] = normalizeCharacter({ name: '林小雨', importance: 'main', identity: '咖啡馆店员', firstChunk: 0, lastChunk: 2, chunksSeen: [0, 1, 2] });
    return normalizeProject(p);
}

function card(data = {}) {
    return {
        id: uid('card_'),
        charName: '林小雨',
        kind: 'character',
        timepoint: null,
        requirement: '',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        data: {
            name: '林小雨', description: '咖啡馆店员，话少。', personality: '慢热', scenario: '雨夜的咖啡馆',
            first_mes: '雨停了。林小雨把最后一把椅子倒扣在桌上，抬头看见你还站在门口。', alternate_greetings: [], mes_example: '',
            system_prompt: '', post_history_instructions: '', creator_notes: '', tags: ['都市', '日常'],
            ...data,
        },
        lint: [],
        stAvatar: '',
        worldName: '',
    };
}

/** 模拟酒馆 generateRaw：按提示词内容区分「变量表」与「界面」两类调用，记录每次收到的消息 */
function installST(handler) {
    const calls = [];
    globalThis.SillyTavern = {
        getContext: () => ({
            async generateRaw({ prompt }) {
                const messages = Array.isArray(prompt) ? prompt : [{ role: 'user', content: String(prompt) }];
                // 酒馆当前连接模式下 NovelLoom 给 {{ }} 中间插了零宽空格（见 llm.js shieldMacros）；模拟的 AI 照常读出原文
                const plain = (t) => String(t).replace(/​/g, '');
                const text = plain(messages.map((m) => m.content).join('\n'));
                const kind = text.includes('data-nl-bar="路径"') ? 'html' : 'spec';
                const call = { messages, text, kind, last: plain(messages[messages.length - 1].content), n: calls.filter((c) => c.kind === kind).length };
                calls.push(call);
                return handler(call);
            },
            stopGeneration() {},
        }),
    };
    return calls;
}

const AI_SPEC = {
    title: '林小雨的状态',
    variables: [
        { path: '世界.时间', type: 'string', init: '4月8日 傍晚', label: '时间', check: ['每轮按剧情推进'] },
        { path: '{{char}}.好感度', type: 'number', init: 130, min: 0, max: 100, integer: true, widget: 'bar', check: ['根据{{user}}的言行调整', '单次变化 ±(1~5)'] },
        { path: '林小雨.心情', type: 'enum', options: ['平静', '开心', '低落'], init: '开心', check: ['随对话变化'] },
        { path: '{{user}}.物品', type: 'record', keyDesc: '物品名', value: { type: 'number', min: 0, integer: true }, init: { 雨伞: 1 }, check: ['获得用 insert'] },
        { path: 'bad path.x', type: 'string', init: '' },
    ],
};

const GOOD_HTML = [
    '<style>.sb-box{padding:8px;border-radius:8px;background:#222;color:#eee}.sb-bar{height:6px;background:#444}.sb-bar i{display:block;height:100%;width:var(--nl-pct);background:#e88}</style>',
    '<div class="sb-box"><b>林小雨</b> <span data-nl-text="世界.时间"></span>',
    '<div class="sb-bar" data-nl-bar="林小雨.好感度"><i></i></div>',
    '<span data-nl-text="林小雨.心情"></span>',
    '<ul data-nl-each="主角.物品"><template><li><span data-nl-key></span>×<span data-nl-item=""></span></li></template></ul></div>',
].join('\n');

const BAD_HTML = '<div data-nl-text="世界.时间"></div><script>fetch("/api/x"); var s = "$1";</script>';

function specReply(obj) {
    return `好的，变量表如下：\n\`\`\`json\n${JSON.stringify(obj, null, 2)}\n\`\`\``;
}

function htmlReply(html) {
    return `\`\`\`html\n${html}\n\`\`\``;
}

/** 已经有一套状态栏（变量表 + AI 界面）的卡 */
function seededCard(s) {
    const c = card();
    const sb = ensureStatusBar(c, s);
    sb.spec = normalizeStatusSpec(AI_SPEC, { charName: '林小雨' });
    sb.html = GOOD_HTML;
    sb.mode = 'bind';
    return c;
}

// ---------------- 注册 ----------------

test('提示词与消息链：四个状态栏提示词有默认值/标签/占位符，界面提示词不含 {{，消息链任务 statusbar 可回退到默认链', () => {
    for (const k of Object.keys(PROMPT_LABELS)) assert.ok(DEFAULT_PROMPTS[k], `${k} 没有默认提示词`);
    for (const k of ['statusSpecSystem', 'statusSpec', 'statusSpecWorld', 'statusHtmlSystem', 'statusHtml', 'statusHtmlWorld']) {
        assert.ok(PROMPT_LABELS[k], `${k} 没有标签`);
        assert.ok(PROMPT_PLACEHOLDERS[k]?.length, `${k} 没有占位符列表`);
    }
    for (const k of ['statusSpec', 'statusSpecWorld', 'statusHtml', 'statusHtmlWorld']) {
        for (const ph of PROMPT_PLACEHOLDERS[k]) assert.ok(DEFAULT_PROMPTS[k].includes(ph), `${k} 缺少 ${ph}`);
    }
    assert.deepEqual(PROMPT_PLACEHOLDERS.statusSpecSystem, PROMPT_PLACEHOLDERS.statusSpec, '系统提示与主提示用同一组变量渲染');
    assert.deepEqual(PROMPT_PLACEHOLDERS.statusHtmlSystem, PROMPT_PLACEHOLDERS.statusHtml);
    for (const k of ['statusHtml', 'statusHtmlSystem', 'statusHtmlWorld']) assert.ok(!DEFAULT_PROMPTS[k].includes('{{'), `${k} 里不应出现 {{`);
    // 浏览器冒烟测试的模拟 AI 靠这两句区分请求：变量表提示词（含世界卡附加说明）里不能出现“设计状态栏界面”
    assert.match(DEFAULT_PROMPTS.statusSpec, /设计状态栏变量表/);
    assert.match(DEFAULT_PROMPTS.statusHtml, /设计状态栏界面/);
    assert.ok(!DEFAULT_PROMPTS.statusSpec.includes('设计状态栏界面') && !DEFAULT_PROMPTS.statusSpecWorld.includes('设计状态栏界面'));
    assert.match(DEFAULT_PROMPTS.statusHtml, /```html/);
    // lintStatusHtml 在 AI 设计模式下把内联事件属性和 javascript: 地址当成错误：提示词的硬性规则里要先说清楚
    assert.match(DEFAULT_PROMPTS.statusHtml, /onclick=/);
    assert.match(DEFAULT_PROMPTS.statusHtml, /javascript:/);

    assert.ok(CHAIN_TASKS.some((t) => t.value === 'statusbar' && t.label === '状态栏（变量/界面）'));
    const s = settings();
    assert.equal(getChain(s, 'statusbar'), s.messageChains.default, '没有自己的链时用默认链');
    s.messageChains.statusbar = [{ role: 'system', content: '【状态栏专用链】{SYSTEM}', enabled: true }, { role: 'user', content: '{PROMPT}', enabled: true }];
    assert.equal(getChain(s, 'statusbar'), s.messageChains.statusbar);
});

test('buildStatusSpecPrompt / buildStatusHtmlPrompt：占位符全部替换，带上卡片内容、上限、示例数据与绑定说明', () => {
    const s = settings();
    const p = project();
    const c = seededCard(s);
    c.statusBar.requirement = '突出好感变化';
    const spec = buildStatusSpecPrompt(p, s, c, { instruction: '加一个天气变量' });
    for (const t of [spec.system, spec.prompt]) assert.doesNotMatch(t, /\{[A-Z_]+\}/);
    assert.match(spec.prompt, /《雨夜》的角色卡「林小雨」/);
    assert.match(spec.prompt, /雨停了。林小雨把最后一把椅子倒扣在桌上/, '带上开场白');
    assert.match(spec.prompt, /咖啡馆店员/, '带上原著角色资料');
    assert.match(spec.prompt, /不超过 20 个/, '默认上限 20');
    assert.match(spec.prompt, /20 只是允许的最多个数，不必用满/, '上限调大后也提醒 AI 宁少勿滥');
    assert.match(spec.prompt, /突出好感变化/);
    assert.match(spec.prompt, /额外要求（优先满足）：加一个天气变量/);
    assert.match(spec.prompt, /"path":"林小雨\.好感度"/, 'JSON 模板用角色名');
    assert.doesNotMatch(spec.prompt, /沿用的变量结构/);

    const html = buildStatusHtmlPrompt(p, s, c, { instruction: '霓虹风' });
    for (const t of [html.system, html.prompt]) {
        assert.doesNotMatch(t, /\{[A-Z_]+\}/);
        assert.ok(!t.includes('{{'), '界面提示词里不应出现 {{');
    }
    assert.match(html.prompt, /林小雨\.好感度（数字，0~100/);
    assert.match(html.prompt, /"雨伞": 1/, '示例数据');
    assert.match(html.prompt, /data-nl-each="路径"/, '绑定说明');
    assert.match(html.prompt, /《雨夜》的题材/);
    assert.match(html.prompt, /题材标签：都市、日常/);
    assert.match(html.prompt, /额外要求（优先满足）：霓虹风/);

    s.prompts = { statusSpec: '自定义：{CHAR_NAME} 最多 {MAX_VARS} 个' };
    assert.equal(buildStatusSpecPrompt(p, s, c).prompt, '自定义：林小雨 最多 20 个', '用户在设置里改过的提示词生效');
});

// ---------------- 解析工具 ----------------

test('extractHtmlBlock：取第一个 html 代码块；其次内容以 < 开头的代码块；没有代码块时取标签部分；被截断的代码块取到结尾', () => {
    assert.equal(extractHtmlBlock('好的：\n```html\n<div>a</div>\n```\n说明文字。\n```html\n<div>b</div>\n```'), '<div>a</div>');
    assert.equal(extractHtmlBlock('```css\n.a{}\n```\n```html\n<b>x</b>\n```'), '<b>x</b>');
    assert.equal(extractHtmlBlock('```\n<style>.a{}</style><i>y</i>\n```'), '<style>.a{}</style><i>y</i>');
    assert.equal(extractHtmlBlock('这是界面：\n<style>.a{}</style>\n<div>z</div>\n以上。'), '<style>.a{}</style>\n<div>z</div>');
    assert.equal(extractHtmlBlock('```html\n<div>被截断'), '<div>被截断');
    assert.equal(extractHtmlBlock('```json\n{"a":1}\n```'), '');
    assert.equal(extractHtmlBlock('我设计好了。'), '');
    assert.equal(extractHtmlBlock('```HTML\r\n<p>CRLF</p>\r\n```'), '<p>CRLF</p>');
});

test('checkStatusHtml：好的片段通过；危险代码、$1、未知宏、空内容都是错误；未知路径只是提示', () => {
    const spec = normalizeStatusSpec(AI_SPEC, { charName: '林小雨' });
    assert.deepEqual(checkStatusHtml(GOOD_HTML, spec).errors, []);
    const bad = checkStatusHtml(BAD_HTML, spec).errors.join('；');
    assert.match(bad, /网络请求/);
    assert.match(bad, /\$ 加数字/);
    assert.match(checkStatusHtml('<div data-nl-text="世界.时间">{{random}}</div>', spec).errors.join(''), /宏/);
    assert.match(checkStatusHtml('', spec).errors[0], /没有找到/);
    const r = checkStatusHtml('<div data-nl-text="不存在.变量"></div>', spec);
    assert.deepEqual(r.errors, []);
    assert.match(r.warnings.join(''), /不存在\.变量/);
});

test('mergeKeptSpec：按路径（含 {{char}} / 斜杠 / stat_data 前缀写法）合并，只取 init 或 desc/check，结构不变', () => {
    const base = normalizeStatusSpec(AI_SPEC, { charName: '林小雨' });
    const warnings = [];
    const { spec, matched } = mergeKeptSpec(base, {
        title: '新标题',
        variables: [
            { path: '/世界/时间', type: 'number', init: '深夜', check: ['新规则'] },
            { path: '{{char}}.好感度', init: '55', min: 50, max: 60, widget: 'text' },
            { path: 'stat_data.林小雨.心情', init: '暴怒' },
            { path: '主角.物品', init: { 钥匙: 2, 坏键: 'x' } },
        ],
    }, { init: true, rules: false, charName: '林小雨', warnings });
    assert.equal(matched, 4);
    assert.equal(spec.title, base.title, '不允许改标题时保留原标题');
    assert.deepEqual(spec.variables.map((v) => v.path), base.variables.map((v) => v.path));
    const by = Object.fromEntries(spec.variables.map((v) => [v.path, v]));
    assert.equal(by['世界.时间'].type, 'string');
    assert.equal(by['世界.时间'].init, '深夜');
    assert.deepEqual(by['世界.时间'].check, ['每轮按剧情推进'], '只改初始值时规则不变');
    assert.equal(by['林小雨.好感度'].init, 55);
    assert.equal(by['林小雨.好感度'].min, 0, '范围保持原样');
    assert.equal(by['林小雨.好感度'].widget, 'bar');
    assert.equal(by['林小雨.心情'].init, '开心', '不合法的选项值保留原值');
    assert.ok(warnings.some((w) => w.includes('林小雨.心情') && w.includes('不合法')));
    assert.deepEqual(by['主角.物品'].init, { 钥匙: 2, 坏键: 1 }, '记录里不合法的值按值类型的默认值（1）规整');

    const r2 = mergeKeptSpec(base, { title: '林小雨·今夜', variables: [{ path: '世界.时间', init: '午夜', desc: '当前时刻', check: '规则一\n规则二' }] }, { init: false, rules: true, allowTitle: true, charName: '林小雨', warnings: [] });
    assert.equal(r2.spec.title, '林小雨·今夜');
    assert.equal(r2.spec.variables[0].init, '4月8日 傍晚', '只改规则时初始值不变');
    assert.equal(r2.spec.variables[0].desc, '当前时刻');
    assert.deepEqual(r2.spec.variables[0].check, ['规则一', '规则二']);
    assert.equal(mergeKeptSpec(base, { variables: [{ path: '别的.变量', init: 1 }] }, { charName: '林小雨' }).matched, 0);
});

// ---------------- 整体生成 ----------------

test('generateStatusBar：变量表（代码块里的 JSON → 规范化）+ 界面（```html → 检查通过），可直接导出', async () => {
    const s = settings();
    const p = project();
    const c = card();
    const calls = installST((call) => (call.kind === 'spec' ? specReply(AI_SPEC) : htmlReply(GOOD_HTML)));
    const warnings = [];
    const logs = [];
    const sb = await generateStatusBar(p, s, c, { warnings, onLog: (m) => logs.push(m), requirement: ' 重点体现好感变化 ' });

    assert.deepEqual(calls.map((x) => x.kind), ['spec', 'html']);
    assert.match(calls[0].text, /雨停了。林小雨/);
    assert.match(calls[0].text, /重点体现好感变化/);
    assert.match(calls[1].text, /林小雨\.好感度/);
    assert.match(calls[1].text, /"雨伞": 1/);
    assert.ok(!calls[1].text.includes('{{'), '界面请求里没有 {{');

    assert.equal(sb, c.statusBar);
    assert.equal(sb.requirement, '重点体现好感变化');
    assert.equal(sb.spec.title, '林小雨的状态');
    assert.deepEqual(sb.spec.variables.map((v) => v.path), ['世界.时间', '林小雨.好感度', '林小雨.心情', '主角.物品']);
    assert.equal(sb.spec.variables[1].init, 100, '初始值按范围夹取');
    assert.ok(warnings.some((w) => w.includes('bad path')), '被丢弃的变量记入 warnings');
    assert.equal(sb.mode, 'bind');
    assert.equal(sb.html, GOOD_HTML);
    assert.deepEqual(sb.lint.errors, []);
    assert.equal(sb.error, '');
    assert.equal(sb.prev, null, '第一次生成没有可撤销的内容');
    assert.equal(sb.sample, null);
    assert.ok(sb.generatedAt > 0 && sb.updatedAt === sb.generatedAt);
    assert.ok(logs.some((m) => m.includes('设计「林小雨」的状态栏变量')));

    const json = buildCardJson(c, {});
    const bar = json.data.extensions.regex_scripts[0];
    assert.match(bar.replaceString, /sb-box/);
    assert.match(json.data.first_mes, /<StatusPlaceHolderImpl\/>$/);
});

test('generateStatusBar：变量表不是 JSON 时带着原因重试一次', async () => {
    const s = settings();
    const c = card();
    const calls = installST((call) => {
        if (call.kind === 'spec') return call.n === 0 ? '变量表如下：暂时还没想好。' : specReply(AI_SPEC);
        return htmlReply(GOOD_HTML);
    });
    const sb = await generateStatusBar(project(), s, c);
    const specCalls = calls.filter((x) => x.kind === 'spec');
    assert.equal(specCalls.length, 2);
    assert.match(specCalls[1].last, /不是合法 JSON/);
    assert.equal(specCalls[1].messages.at(-2).role, 'assistant');
    assert.match(specCalls[1].messages.at(-2).content, /暂时还没想好/);
    assert.equal(sb.spec.variables.length, 4);
});

test('generateStatusBar：规范化后没有可用变量 → 重试一次 → 仍然没有则报错，原有变量表不变，记下 error', async () => {
    const s = settings();
    const c = seededCard(s);
    const before = JSON.stringify(c.statusBar.spec);
    const calls = installST(() => specReply({ variables: [{ path: 'a b', type: 'string' }, { path: 'stat_data', type: 'number' }] }));
    await assert.rejects(generateStatusBar(project(), s, c, { parts: ['spec'] }), /没有可用的变量/);
    assert.equal(calls.length, 2);
    assert.match(calls[1].last, /没有可用的变量/);
    assert.equal(JSON.stringify(c.statusBar.spec), before);
    assert.equal(c.statusBar.html, GOOD_HTML);
    assert.match(c.statusBar.error, /没有可用的变量/);
    assert.equal(c.statusBar.prev, null);
});

test('generateStatusBar：界面没通过检查 → 把错误发回去重试 → 第二次通过', async () => {
    const s = settings();
    const c = card();
    const calls = installST((call) => (call.kind === 'spec' ? specReply(AI_SPEC) : htmlReply(call.n === 0 ? BAD_HTML : GOOD_HTML)));
    const logs = [];
    const sb = await generateStatusBar(project(), s, c, { onLog: (m) => logs.push(m) });
    const htmlCalls = calls.filter((x) => x.kind === 'html');
    assert.equal(htmlCalls.length, 2);
    assert.match(htmlCalls[1].last, /没有通过检查/);
    assert.match(htmlCalls[1].last, /网络请求/);
    assert.match(htmlCalls[1].last, /\$ 加数字/);
    assert.match(htmlCalls[1].messages.at(-2).content, /fetch/, '把上一次的代码作为 AI 消息带上');
    assert.equal(sb.mode, 'bind');
    assert.equal(sb.html, GOOD_HTML);
    assert.equal(sb.error, '');
    assert.ok(logs.some((m) => m.includes('没有通过检查')));
});

test('generateStatusBar：界面两次都没通过检查 → 改用内置排版并记下提示，导出不受影响', async () => {
    const s = settings();
    const c = card();
    installST((call) => (call.kind === 'spec' ? specReply(AI_SPEC) : htmlReply(BAD_HTML)));
    const warnings = [];
    const sb = await generateStatusBar(project(), s, c, { warnings });
    assert.equal(sb.mode, 'auto');
    assert.match(sb.error, /两次都没有通过检查.*内置排版/);
    assert.match(sb.lint.warnings[0], /内置排版/);
    assert.deepEqual(sb.lint.errors, []);
    assert.equal(sb.html, BAD_HTML, 'AI 写的代码保留下来，方便手动修改');
    assert.ok(warnings.some((w) => w.includes('内置排版')));
    const scripts = buildStatusRegexScripts(c);
    assert.match(scripts[0].replaceString, /nlb-grid/, '导出用内置排版');
    assert.doesNotMatch(scripts[0].replaceString, /fetch/);
});

test('generateStatusBar：回复里没有 html 代码块 → 提示 AI 只输出代码块 → 仍没有则改用内置排版', async () => {
    const s = settings();
    const c = card();
    const calls = installST((call) => (call.kind === 'spec' ? specReply(AI_SPEC) : '界面已经设计好了。'));
    const sb = await generateStatusBar(project(), s, c);
    const htmlCalls = calls.filter((x) => x.kind === 'html');
    assert.equal(htmlCalls.length, 2);
    assert.match(htmlCalls[1].last, /没有找到 ```html 代码块/);
    assert.equal(sb.mode, 'auto');
    assert.match(sb.error, /没有找到/);
});

test('generateStatusBar：界面请求失败时，新变量表照常保存并改用内置排版；只重写界面时失败则报错且不改动', async () => {
    const s = settings();
    const c = card();
    installST((call) => {
        if (call.kind === 'spec') return specReply(AI_SPEC);
        throw new Error('boom 400 bad request');
    });
    const sb = await generateStatusBar(project(), s, c);
    assert.equal(sb.spec.variables.length, 4);
    assert.equal(sb.mode, 'auto');
    assert.match(sb.error, /请求失败.*boom 400/);

    const c2 = seededCard(s);
    await assert.rejects(generateStatusBar(project(), s, c2, { parts: ['html'] }), /boom 400/);
    assert.equal(c2.statusBar.html, GOOD_HTML);
    assert.equal(c2.statusBar.mode, 'bind');
    assert.match(c2.statusBar.error, /boom 400/);
    assert.equal(c2.statusBar.prev, null);
});

test('generateStatusBar：全局默认内置排版（htmlMode auto）时只生成变量表，不调用界面', async () => {
    const s = settings();
    s.statusBar.htmlMode = 'auto';
    const c = card();
    const calls = installST((call) => (call.kind === 'spec' ? specReply(AI_SPEC) : htmlReply(GOOD_HTML)));
    const sb = await generateStatusBar(project(), s, c);
    assert.deepEqual(calls.map((x) => x.kind), ['spec']);
    assert.equal(sb.mode, 'auto');
    assert.deepEqual(sb.lint, { errors: [], warnings: [] });
    assert.ok(buildStatusRegexScripts(c).length >= 3);
});

test('generateStatusBar：消息链用 statusbar 任务自己的链', async () => {
    const s = settings();
    s.messageChains.statusbar = [{ role: 'system', content: '【状态栏专用链】{SYSTEM}', enabled: true }, { role: 'user', content: '{PROMPT}', enabled: true }];
    const calls = installST((call) => (call.kind === 'spec' ? specReply(AI_SPEC) : htmlReply(GOOD_HTML)));
    await generateStatusBar(project(), s, card());
    assert.ok(calls.every((x) => x.messages[0].content.startsWith('【状态栏专用链】')));
});

// ---------------- 部分重新生成 ----------------

test('只重写规则：路径/类型/初始值不变，只换 desc/check；AI 改的路径和类型被忽略；可撤销、可重做', async () => {
    const s = settings();
    const c = seededCard(s);
    c.statusBar.sample = { 世界: { 时间: '午后' }, 林小雨: { 好感度: 70, 心情: '平静' }, 主角: { 物品: {} } };
    const old = JSON.parse(JSON.stringify(c.statusBar.spec));
    const calls = installST(() => specReply({
        variables: [
            { path: '世界.时间', init: '改掉', desc: '当前时间', check: ['每轮推进 10-30 分钟'] },
            { path: '/林小雨/好感度', type: 'string', init: 5, check: ['单次 ±3'] },
            { path: '不存在.变量', init: 1, check: ['x'] },
        ],
    }));
    const warnings = [];
    const sb = await generateStatusBar(project(), s, c, { parts: ['rules'], warnings });
    assert.equal(calls.length, 1, '只调用变量表');
    assert.match(calls[0].text, /沿用的变量结构/);
    assert.match(calls[0].text, /init 不用输出/);
    assert.match(calls[0].text, /"path":"林小雨\.心情"/, '既定变量表发给 AI');

    assert.deepEqual(sb.spec.variables.map((v) => v.path), old.variables.map((v) => v.path));
    const by = Object.fromEntries(sb.spec.variables.map((v) => [v.path, v]));
    assert.equal(by['世界.时间'].init, '4月8日 傍晚');
    assert.equal(by['世界.时间'].desc, '当前时间');
    assert.deepEqual(by['世界.时间'].check, ['每轮推进 10-30 分钟']);
    assert.equal(by['林小雨.好感度'].type, 'number');
    assert.equal(by['林小雨.好感度'].init, 100);
    assert.deepEqual(by['林小雨.好感度'].check, ['单次 ±3']);
    assert.deepEqual(by['林小雨.心情'].check, ['随对话变化'], 'AI 没返回的变量保持原样');
    assert.ok(warnings.some((w) => w.includes('林小雨.心情') && w.includes('主角.物品')));
    assert.equal(sb.html, GOOD_HTML, '界面不动');
    assert.equal(sb.sample.林小雨.好感度, 70, '只改规则时保留示例数据');
    assert.deepEqual(sb.prev.spec, old);

    assert.equal(restoreStatusBarPrev(c), true);
    assert.deepEqual(c.statusBar.spec, old);
    assert.deepEqual(c.statusBar.prev.spec.variables[0].check, ['每轮推进 10-30 分钟'], '撤销后 prev 存着刚才的结果');
    assert.equal(restoreStatusBarPrev(c), true);
    assert.deepEqual(c.statusBar.spec.variables[0].check, ['每轮推进 10-30 分钟'], '再点一次就是重做');
    assert.equal(restoreStatusBarPrev({ statusBar: { prev: null } }), false);
});

test('只更新初始值：规则不变，示例数据重置，stale 清除；没有变量表时报错', async () => {
    const s = settings();
    const c = seededCard(s);
    c.statusBar.stale = true;
    c.statusBar.sample = { 世界: { 时间: '午后' } };
    installST(() => specReply({ variables: [{ path: '世界.时间', init: '深夜' }, { path: '林小雨.好感度', init: '55' }, { path: '林小雨.心情', init: '暴怒' }, { path: '主角.物品', init: { 钥匙: 2 } }] }));
    const warnings = [];
    const sb = await generateStatusBar(project(), s, c, { parts: ['init'], warnings });
    const by = Object.fromEntries(sb.spec.variables.map((v) => [v.path, v]));
    assert.equal(by['世界.时间'].init, '深夜');
    assert.deepEqual(by['世界.时间'].check, ['每轮按剧情推进']);
    assert.equal(by['林小雨.好感度'].init, 55);
    assert.equal(by['林小雨.心情'].init, '开心');
    assert.deepEqual(by['主角.物品'].init, { 钥匙: 2 });
    assert.ok(warnings.some((w) => w.includes('不合法')));
    assert.equal(sb.sample, null);
    assert.equal(sb.stale, false);

    const empty = card();
    installST(() => specReply(AI_SPEC));
    await assert.rejects(generateStatusBar(project(), s, empty, { parts: ['init', 'rules'] }), /还没有变量表/);
    assert.match(empty.statusBar.error, /还没有变量表/);
});

test('只重写界面（带额外要求）：把当前界面一起发给 AI 修改；变量表不动；没有额外要求时不带当前界面', async () => {
    const s = settings();
    const c = seededCard(s);
    const NEW_HTML = GOOD_HTML.replace('#222', '#123');
    let calls = installST(() => htmlReply(NEW_HTML));
    const sb = await generateStatusBar(project(), s, c, { parts: ['html'], instruction: '底色换成深蓝' });
    assert.deepEqual(calls.map((x) => x.kind), ['html']);
    assert.match(calls[0].text, /<当前界面>/);
    assert.match(calls[0].text, /sb-box/);
    assert.match(calls[0].text, /额外要求（优先满足）：底色换成深蓝/);
    assert.equal(sb.html, NEW_HTML);
    assert.equal(sb.prev.html, GOOD_HTML);
    assert.equal(sb.spec.variables.length, 4);

    calls = installST(() => htmlReply(GOOD_HTML));
    await generateStatusBar(project(), s, c, { parts: ['html'] });
    assert.doesNotMatch(calls[0].text, /<当前界面>/);
});

// ---------------- 模板 ----------------

const TEMPLATE = {
    id: 'sbtpl_test',
    name: '测试模板',
    mode: 'bind',
    theme: 'night',
    spec: {
        title: '通用',
        variables: [
            { path: '世界.地点', type: 'string', init: '', check: ['场景切换时更新'] },
            { path: '{{char}}.好感度', type: 'number', min: 0, max: 100, integer: true, init: 0, widget: 'bar', check: ['单次 ±(1~5)'] },
        ],
    },
    html: '<style>.tp{color:#0ff}</style><div class="tp" data-nl-text="世界.地点"></div><div data-nl-bar="林小雨.好感度"><i></i></div>',
};

test('沿用结构（structure）：模板变量表经 {TEMPLATE_SPEC} 交给 AI，只填初始值与规则；界面/主题沿用模板；也能按 id 从设置里找模板', async () => {
    const s = settings();
    const c = card();
    const calls = installST((call) => {
        assert.equal(call.kind, 'spec', '沿用结构不生成界面');
        return specReply({ title: '林小雨的状态', variables: [{ path: '世界.地点', init: '咖啡馆', check: ['离开咖啡馆时更新'] }, { path: '林小雨.好感度', init: 35, check: ['单次 ±2'] }] });
    });
    const sb = await generateStatusBar(project(), s, c, { templateMode: 'structure', template: TEMPLATE });
    assert.equal(calls.length, 1);
    assert.match(calls[0].text, /沿用的变量结构/);
    assert.match(calls[0].text, /"path":"林小雨\.好感度"/, '模板路径里的 {{char}} 换成角色名');
    assert.deepEqual(sb.spec.variables.map((v) => v.path), ['世界.地点', '林小雨.好感度']);
    assert.equal(sb.spec.variables[0].init, '咖啡馆');
    assert.equal(sb.spec.variables[1].init, 35);
    assert.deepEqual(sb.spec.variables[1].check, ['单次 ±2']);
    assert.equal(sb.spec.title, '林小雨的状态', '沿用结构时可以改标题');
    assert.equal(sb.html, TEMPLATE.html);
    assert.equal(sb.mode, 'bind');
    assert.equal(sb.theme, 'night');
    assert.equal(sb.templateId, 'sbtpl_test');
    assert.deepEqual(sb.lint.errors, []);

    s.statusBarTemplates = [TEMPLATE];
    const c2 = card();
    installST(() => specReply({ variables: [{ path: '世界.地点', init: '车站' }, { path: '林小雨.好感度', init: 10 }] }));
    const sb2 = await generateStatusBar(project(), s, c2, { templateMode: 'structure', templateId: 'sbtpl_test' });
    assert.equal(sb2.spec.variables[0].init, '车站');
    assert.equal(sb2.templateId, 'sbtpl_test');

    await assert.rejects(generateStatusBar(project(), s, card(), { templateMode: 'structure', template: { id: 'x', name: '空模板', html: '<div></div>' } }), /没有变量表/);
});

test('沿用结构：模板变量超过上限时按上限截断（与套用模板一致），AI 返回了多出的变量也不会带回来，并提示丢弃', async () => {
    const s = settings();
    s.statusBar.maxVars = 1;
    const c = card();
    const calls = installST(() => specReply({ variables: [{ path: '世界.地点', init: '咖啡馆' }, { path: '林小雨.好感度', init: 35 }] }));
    const warnings = [];
    const sb = await generateStatusBar(project(), s, c, { templateMode: 'structure', template: TEMPLATE, warnings });
    assert.deepEqual(sb.spec.variables.map((v) => v.path), ['世界.地点'], '多出的变量被丢弃');
    assert.equal(sb.spec.variables[0].init, '咖啡馆');
    assert.doesNotMatch(calls[0].text, /林小雨\.好感度/, '交给 AI 的结构里也没有多出的变量');
    assert.ok(warnings.some((w) => w.includes('超过上限 1')), '提示超过上限');
});

test('只借外观（style）：已有变量表时只重写界面，模板界面作为 {STYLE_REF}，主题跟随模板', async () => {
    const s = settings();
    const c = seededCard(s);
    const oldSpec = JSON.stringify(c.statusBar.spec);
    const style = { id: 'builtin_cyber', name: '赛博朋克', mode: 'bind', theme: 'night', html: '<style>.cy{border:1px solid #0ff;box-shadow:0 0 8px #f0f}</style><div class="cy" data-nl-text="角色.名字"></div>' };
    const calls = installST((call) => {
        assert.equal(call.kind, 'html');
        return htmlReply(GOOD_HTML);
    });
    const sb = await generateStatusBar(project(), s, c, { templateMode: 'style', template: style });
    assert.equal(calls.length, 1);
    assert.match(calls[0].text, /<参考界面>/);
    assert.match(calls[0].text, /box-shadow:0 0 8px #f0f/);
    assert.match(calls[0].text, /不要照抄其中的变量/);
    assert.equal(JSON.stringify(sb.spec), oldSpec);
    assert.equal(sb.html, GOOD_HTML);
    assert.equal(sb.theme, 'night');
    assert.equal(sb.templateId, 'builtin_cyber');

    const fresh = card();
    const calls2 = installST((call) => (call.kind === 'spec' ? specReply(AI_SPEC) : htmlReply(GOOD_HTML)));
    await generateStatusBar(project(), s, fresh, { templateMode: 'style', template: style });
    assert.deepEqual(calls2.map((x) => x.kind), ['spec', 'html'], '没有变量表时先设计变量');
});

// ---------------- 中止与“不抛错”版本 ----------------

test('用户中止：不改动状态栏、不写 error；tryGenerateStatusBar 返回 aborted', async () => {
    const s = settings();
    const c = seededCard(s);
    const before = JSON.stringify(c.statusBar);
    const ctl = new AbortController();
    installST(() => {
        ctl.abort();
        return new Promise(() => {});
    });
    await assert.rejects(generateStatusBar(project(), s, c, { signal: ctl.signal }), (e) => e.name === 'AbortError');
    assert.equal(JSON.stringify(c.statusBar), before);

    const ctl2 = new AbortController();
    ctl2.abort();
    installST(() => specReply(AI_SPEC));
    const r = await tryGenerateStatusBar(project(), s, c, { signal: ctl2.signal });
    assert.equal(r.ok, false);
    assert.equal(r.aborted, true);
    assert.equal(c.statusBar.error, '');
});

test('tryGenerateStatusBar：失败时不抛错，卡片内容不受影响，statusBar.error 记下原因；成功时带回 warnings', async () => {
    const s = settings();
    const c = card();
    installST(() => {
        throw new Error('quota exceeded 402');
    });
    const r = await tryGenerateStatusBar(project(), s, c, { requirement: '简洁' });
    assert.equal(r.ok, false);
    assert.ok(r.error);
    assert.match(c.statusBar.error, /quota exceeded 402/);
    assert.equal(c.statusBar.requirement, '简洁');
    assert.equal(c.data.name, '林小雨');
    assert.equal(c.statusBar.spec.variables.length, 0);

    installST((call) => (call.kind === 'spec' ? specReply(AI_SPEC) : htmlReply(GOOD_HTML)));
    const ok = await tryGenerateStatusBar(project(), s, c);
    assert.equal(ok.ok, true);
    assert.equal(ok.statusBar, c.statusBar);
    assert.equal(c.statusBar.error, '');
    assert.ok(ok.warnings.some((w) => w.includes('bad path')));
});

test('重新设计变量时有手动覆盖：提示“不再与变量表同步”', async () => {
    const s = settings();
    const c = seededCard(s);
    c.statusBar.overrides.updateRules = '变量更新规则: 手写';
    installST(() => specReply(AI_SPEC));
    const warnings = [];
    await generateStatusBar(project(), s, c, { parts: ['spec'], warnings });
    assert.ok(warnings.some((w) => w.includes('不再与变量表同步')));
    assert.equal(c.statusBar.prev.html, GOOD_HTML);
});

// ---------------- v0.12：世界/旁白卡、记录里的分组字段、立绘槽位 ----------------

/** 雨城：三个主要角色（苏晴第 3 章才出场）+ 一个配角 */
function castProject() {
    const p = createProject({ name: '雨城' });
    p.bookName = '雨城';
    p.chunks = [0, 1, 2].map((i) => ({ id: `c${i}`, index: i, title: `第${i + 1}章`, content: '', charCount: 100, end: 100, status: 'done' }));
    p.characters['林小雨'] = normalizeCharacter({ name: '林小雨', importance: 'main', identity: '咖啡馆店员', firstChunk: 0, lastChunk: 2, chunksSeen: [0, 1, 2] });
    p.characters['周默'] = normalizeCharacter({ name: '周默', importance: 'main', identity: '刑警', firstChunk: 1, lastChunk: 2, chunksSeen: [1, 2] });
    p.characters['苏晴'] = normalizeCharacter({ name: '苏晴', importance: 'main', identity: '记者', firstChunk: 2, lastChunk: 2, chunksSeen: [2] });
    p.characters['老陈'] = normalizeCharacter({ name: '老陈', importance: 'support', identity: '房东', firstChunk: 0, lastChunk: 1, chunksSeen: [0, 1] });
    return normalizeProject(p);
}

/** 世界/旁白卡，时间点在第 2 章（苏晴还没出场） */
function worldCard(data = {}) {
    const c = card({
        name: '雨城旁白', description: '多雨的海港城市。', personality: '', scenario: '雨城的夜晚',
        first_mes: '雨下了整整一夜。旧城区的路灯一盏盏亮起，你撑着伞站在咖啡馆门口。', tags: ['都市', '群像'], ...data,
    });
    c.kind = 'world';
    c.charName = '';
    c.timepoint = 1;
    return c;
}

const WORLD_SPEC = {
    title: '雨城群像',
    variables: [
        { path: '世界.时间', type: 'string', init: '雨夜 23:00', label: '时间', check: ['每轮按剧情推进'] },
        { path: '世界.地点', type: 'string', init: '旧城区', label: '地点', check: ['场景切换时更新'] },
        { path: '主角.身份', type: 'string', init: '外地来的记者', label: '身份', check: ['身份暴露时更新'] },
        {
            path: '主要角色', type: 'record', keyDesc: '角色名', label: '主要角色', widget: 'list',
            value: {
                type: 'object',
                fields: [
                    { key: '身份', type: 'string', init: '' },
                    { key: '好感', type: 'number', min: 0, max: 100, integer: true, init: 30, stages: [{ min: 0, label: '陌生' }, { min: 40, label: '信任' }, { min: 80, label: '亲密' }] },
                    { key: '心情', type: 'enum', options: ['平静', '开心', '低落'], init: '平静' },
                    { key: '服饰', label: '穿着', type: 'object', fields: [{ key: '上衣', type: 'string', init: '' }, { key: '下装', type: 'string', init: '' }] },
                ],
            },
            init: { 林小雨: { 身份: '咖啡馆店员', 好感: 140, 心情: '开心', 服饰: { 上衣: '白衬衫', 下装: '长裙' } } },
            check: ['好感按与{{user}}的互动变化，单次 ±(1~5)', '换装时更新 服饰'],
        },
        {
            path: 'NPC', type: 'record', keyDesc: 'NPC 名', label: 'NPC', widget: 'list',
            value: { type: 'object', fields: [{ key: '身份', type: 'string', init: '' }, { key: '好感', type: 'number', min: 0, max: 100, integer: true, init: 20 }] },
            init: {},
            check: ['新的 NPC 登场时用 insert 新增'],
        },
    ],
};

const WORLD_HTML = [
    '<style>.sb-w{padding:8px;border-radius:10px;background:#16161d;color:#eee;font:13px/1.5 sans-serif}.sb-hud{display:flex;gap:8px}',
    '.sb-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:6px}.sb-card{padding:6px;border:1px solid #444;border-radius:8px}',
    '.sb-av{width:40px;height:40px;border-radius:50%}.sb-bar{display:block;height:4px;background:#333}.sb-bar i{display:block;height:100%;width:var(--nl-pct);background:#e88}',
    '[data-nl-stage-index="2"]{color:#f9a}</style>',
    '<div class="sb-w"><div class="sb-hud"><span data-nl-text="世界.时间"></span><span data-nl-text="世界.地点"></span><span data-nl-text="主角.身份"></span></div>',
    '<details open><summary>主要角色</summary><div class="sb-grid sb-main" data-nl-each="主要角色" data-nl-empty="暂无"><template><article class="sb-card"><img class="sb-av" data-nl-portrait="" alt=""><button type="button" class="sb-swap" data-nl-portrait-next="">换</button><b class="sb-name" data-nl-key></b><span class="sb-bar" data-nl-item-bar="好感"><i></i></span><span class="sb-stage" data-nl-item-stage="好感"></span><span class="sb-top" data-nl-item="服饰.上衣"></span><ul class="sb-dress" data-nl-group="服饰"><template><li><span class="k" data-nl-key></span><span class="v" data-nl-item=""></span></li></template></ul></article></template></div></details>',
    '<details><summary>NPC</summary><div class="sb-grid sb-npc" data-nl-each="NPC" data-nl-empty="暂无 NPC"><template><article class="sb-card"><img class="sb-av" data-nl-portrait="" alt=""><b class="sb-name" data-nl-key></b><span class="sb-id" data-nl-item="身份"></span></article></template></div></details></div>',
].join('\n');

test('类型说明 / 群像 JSON 模板：讲清分组写法与计数；群像模板本身合法、在默认上限内；角色记录的识别', () => {
    const tg = statusTypeGuide('林小雨');
    assert.match(tg, /"key":"服饰","type":"object","fields":\[/);
    assert.match(tg, /带 1-8 个字段的 object/);
    assert.match(tg, /里面最多 6 个字段/);
    assert.match(tg, /分组里不能再套分组/);
    assert.match(tg, /\{"条目名":\{"好感":30,"服饰":\{"上衣":"白衬衫","下装":"长裙"\}\}\}/, 'init 里分组是嵌套对象');
    assert.match(tg, /主要角色\.条目名\.服饰\.上衣/);
    assert.match(tg, /分组里的每个字段各算 1 个，与记录里有多少条目无关/);
    assert.match(tg, /也可以带 stages/);
    assert.match(tg, /如 世界、林小雨、主角/);
    assert.match(statusTypeGuide('雨城旁白', { world: true }), /如 世界、主角，或者直接是按角色名记录的 record，如 主要角色、NPC/);
    assert.ok(tg.includes('widget（显示方式）'), '浏览器冒烟测试靠这句识别变量表请求');

    const warnings = [];
    const spec = normalizeStatusSpec(JSON.parse(statusWorldJsonTemplate('雨城旁白', ['林小雨', '周默'])), { charName: '雨城旁白', warnings });
    assert.deepEqual(warnings, [], '模板照抄就能通过规范化');
    assert.equal(countSpecLeaves(spec), 10);
    assert.ok(countSpecLeaves(spec) <= DEFAULT_STATUS_BAR.maxVars);
    const cast = spec.variables.find((v) => v.path === '主要角色');
    assert.deepEqual(Object.keys(cast.init), ['林小雨'], '初始条目以第一个主要角色为例');
    assert.deepEqual(cast.init.林小雨.服饰, { 上衣: '…', 下装: '…' });
    assert.equal(cast.value.fields.find((f) => f.key === '服饰').type, 'object');
    assert.equal(cast.value.fields.find((f) => f.key === '好感').stages.length, 3);
    assert.deepEqual(spec.variables.find((v) => v.path === 'NPC').init, {});
    assert.match(statusWorldJsonTemplate(), /"init":\{"角色名":/, '没有主要角色资料时用占位名');

    const rec = (path, keyDesc) => ({ path, type: 'record', keyDesc, value: { type: 'string' } });
    assert.equal(castRecordPath(spec), '主要角色');
    assert.equal(castRecordPath({ variables: [rec('NPC', '角色名'), rec('角色', '角色名')] }), '角色', '不把 NPC 记录当成主要角色');
    assert.equal(castRecordPath({ variables: [rec('主角.物品', '物品名'), rec('群像.主要角色', '名字')] }), '群像.主要角色');
    assert.equal(castRecordPath({ variables: [rec('主角.物品', '物品名'), rec('NPC', 'NPC 名')] }), '');
    assert.equal(isCastRecord(rec('NPC', 'NPC 名')), true);
    assert.equal(isCastRecord(rec('主角.队友', '队友名')), true);
    assert.equal(isCastRecord(rec('主角.任务', '任务名')), false);
    assert.equal(isCastRecord({ path: '世界.时间', type: 'string' }), false);
});

test('世界/旁白卡：变量表按群像设计（主要角色名单写进提示词），生成后把漏掉的主要角色补进「主要角色」；界面提示词带分组与立绘示例；导出与运行时正常', async () => {
    const s = settings();
    const p = castProject();
    const c = worldCard();
    const calls = installST((call) => (call.kind === 'spec' ? specReply(WORLD_SPEC) : htmlReply(WORLD_HTML)));
    const logs = [];
    const sb = await generateStatusBar(p, s, c, { onLog: (m) => logs.push(m) });

    assert.deepEqual(calls.map((x) => x.kind), ['spec', 'html']);
    const specText = calls[0].text;
    assert.match(specText, /《雨城》的世界\/旁白卡「雨城旁白」设计状态栏变量表/);
    assert.match(specText, /# 世界\/旁白卡的变量设计/);
    assert.match(specText, /初始值符合开场白的情境：林小雨、周默\n/, '主要角色名单（只到卡片时间点）');
    assert.doesNotMatch(specText, /苏晴/, '时间点之后才出场的角色不写进提示词');
    assert.match(specText, /"path":"主要角色","type":"record"/);
    assert.match(specText, /"init":\{"林小雨":\{"身份":"…"/);
    assert.match(specText, /"key":"服饰","type":"object","fields"/);
    assert.doesNotMatch(specText, /"path":"雨城旁白\./, '世界卡的 JSON 模板里没有单个角色的分组');
    assert.ok(!specText.includes('设计状态栏界面'));

    // 变量表：AI 写了的条目保持原样（好感按范围夹取），漏掉的主要角色按默认值补上；NPC 留空
    assert.deepEqual(sb.spec.variables.map((v) => v.path), ['世界.时间', '世界.地点', '主角.身份', '主要角色', 'NPC']);
    const cast = sb.spec.variables[3];
    assert.deepEqual(Object.keys(cast.init), ['林小雨', '周默']);
    assert.deepEqual(cast.init.林小雨, { 身份: '咖啡馆店员', 好感: 100, 心情: '开心', 服饰: { 上衣: '白衬衫', 下装: '长裙' } });
    assert.deepEqual(cast.init.周默, { 身份: '', 好感: 30, 心情: '平静', 服饰: { 上衣: '', 下装: '' } });
    assert.equal(cast.value.fields[3].label, '穿着');
    assert.deepEqual(cast.value.fields[1].stages.map((x) => x.label), ['陌生', '信任', '亲密']);
    assert.deepEqual(sb.spec.variables[4].init, {});
    assert.equal(countSpecLeaves(sb.spec), 10);
    assert.ok(logs.some((m) => m.includes('设计「雨城旁白」的状态栏变量')));
    assert.ok(logs.some((m) => m.includes('预先填进「主要角色」：周默')));
    assert.match(compileUpdateRules(sb.spec), /\/主要角色\/<角色名>\/服饰\/上衣/);

    // 界面提示词：世界卡附加说明 + 按本卡变量表的绑定示例（角色卡片、分组、立绘槽位）
    const htmlText = calls[1].text;
    assert.match(htmlText, /为世界\/旁白卡「雨城旁白」设计状态栏界面/);
    assert.match(htmlText, /# 世界\/旁白卡的界面/);
    assert.match(htmlText, /目前的主要角色：林小雨、周默/);
    assert.match(htmlText, /# 本卡的绑定示例/);
    assert.match(htmlText, /data-nl-each="主要角色"/);
    assert.match(htmlText, /data-nl-each="NPC"/);
    assert.match(htmlText, /data-nl-group="服饰"/);
    assert.match(htmlText, /data-nl-item="服饰\.上衣"/);
    assert.match(htmlText, /<img class="sb-av" data-nl-portrait="" alt="">/);
    assert.match(htmlText, /<button type="button" class="sb-swap" data-nl-portrait-next="">/);
    assert.match(htmlText, /还没有配置立绘图片/);
    assert.match(htmlText, /不要写 src 或任何图片地址/);
    assert.match(htmlText, /"周默": \{/, '示例数据里有补上的主要角色');
    assert.match(htmlText, /服饰［上衣、下装］/, '变量表摘要列出分组字段');
    assert.ok(!htmlText.includes('{{'), '界面请求里没有 {{');

    assert.equal(sb.mode, 'bind');
    assert.equal(sb.html, WORLD_HTML);
    assert.deepEqual(sb.lint, { errors: [], warnings: [] });

    // 导出：与角色卡一样带开场白标签和状态栏正则
    const json = buildCardJson(c, {});
    assert.match(json.data.first_mes, /<StatusPlaceHolderImpl\/>$/);
    assert.match(json.data.extensions.regex_scripts[0].replaceString, /sb-grid/);

    // 运行时：每个主要角色一张卡片，分组逐字段生成，没配立绘时显示首字占位
    const stat = buildInitialState(sb.spec);
    stat.NPC = { 码头老板: { 身份: '码头老板', 好感: 10 } };
    const env = openStatusDocument(compileStatusDocument(c), { stat });
    assert.deepEqual(env.errors, []);
    const d = env.document;
    const mains = d.querySelectorAll('.sb-main .sb-card');
    assert.deepEqual(mains.map((x) => x.querySelector('.sb-name').textContent), ['林小雨', '周默']);
    assert.equal(mains[0].querySelector('.sb-top').textContent, '白衬衫');
    assert.equal(mains[0].querySelector('.sb-stage').textContent, '亲密');
    assert.deepEqual(mains[0].querySelectorAll('.sb-dress li').map((li) => [li.querySelector('.k').textContent, li.querySelector('.v').textContent]), [['上衣', '白衬衫'], ['下装', '长裙']]);
    assert.equal(mains[1].querySelector('.sb-av').getAttribute('data-nl-portrait-state'), 'empty');
    assert.equal(mains[1].querySelector('[data-nl-ph]').textContent, '周');
    assert.deepEqual(d.querySelectorAll('.sb-npc .sb-card').map((x) => x.querySelector('.sb-id').textContent), ['码头老板']);
});

test('世界/旁白卡：没有名字时 {{char}} 是「旁白」；改过的提示词没有 {WORLD_GUIDE} 时附加说明接在末尾；附加说明也能在设置里改', async () => {
    const s = settings();
    const p = castProject();
    const anon = worldCard({ name: '' });
    const spec = normalizeStatusSpec(WORLD_SPEC, { charName: '旁白' });
    const r = buildStatusSpecPrompt(p, s, anon);
    for (const t of [r.system, r.prompt]) assert.doesNotMatch(t, /\{[A-Z_]+\}/);
    assert.match(r.prompt, /《雨城》的世界\/旁白卡「旁白」/);
    assert.match(r.prompt, /「旁白」是叙述者兼所有 NPC 的扮演者/);
    const h = buildStatusHtmlPrompt(p, s, anon, { spec });
    for (const t of [h.system, h.prompt]) {
        assert.doesNotMatch(t, /\{[A-Z_]+\}/);
        assert.ok(!t.includes('{{'));
    }

    installST(() => specReply({ variables: [{ path: '{{char}}.视角', type: 'enum', options: ['全知', '有限'], init: '有限' }, WORLD_SPEC.variables[3]] }));
    const logs = [];
    const sb = await generateStatusBar(p, s, anon, { parts: ['spec'], onLog: (m) => logs.push(m) });
    assert.deepEqual(sb.spec.variables.map((v) => v.path), ['旁白.视角', '主要角色']);
    assert.deepEqual(Object.keys(sb.spec.variables[1].init), ['林小雨', '周默']);
    assert.ok(logs.some((m) => m.includes('设计「旁白」的状态栏变量')));

    s.prompts = { statusSpec: '自定义：{CHAR_NAME}', statusSpecWorld: '群像名单：{CAST}', statusHtml: '界面：{CHAR_NAME}', statusHtmlWorld: '多人界面：{CAST}' };
    assert.equal(buildStatusSpecPrompt(p, s, anon).prompt, '自定义：旁白\n\n群像名单：林小雨、周默');
    assert.equal(buildStatusHtmlPrompt(p, s, anon, { spec }).prompt, '界面：旁白\n\n多人界面：林小雨、周默');
    assert.equal(buildStatusSpecPrompt(p, s, card()).prompt, '自定义：林小雨', '角色卡不带世界卡附加说明');
    s.prompts = { statusSpecWorld: '群像名单：{CAST}' };
    assert.match(buildStatusSpecPrompt(p, s, anon).prompt, /label 是界面上显示的短名.*\n\n群像名单：林小雨、周默\n\n# 类型说明/, '默认模板里 {WORLD_GUIDE} 在设计要求之后');
    const empty = createProject({ name: '空' });
    assert.match(buildStatusSpecPrompt(empty, settings(), anon).prompt, /初始值符合开场白的情境：（项目里还没有主要角色资料，按角色卡内容列出主要角色）/);
});

const CAST_TEMPLATE = {
    id: 'sbtpl_cast',
    name: '群像测试',
    mode: 'bind',
    theme: 'night',
    spec: {
        title: '群像',
        variables: [
            { path: '世界.时间', type: 'string', init: '', check: ['每轮推进'] },
            {
                path: '主要角色', type: 'record', keyDesc: '角色名',
                value: {
                    type: 'object',
                    fields: [
                        { key: '好感', type: 'number', min: 0, max: 100, integer: true, init: 20 },
                        { key: '心情', type: 'enum', options: ['平静', '开心'], init: '平静' },
                        { key: '服饰', type: 'object', fields: [{ key: '上衣', type: 'string', init: '' }, { key: '下装', type: 'string', init: '' }] },
                    ],
                },
                init: {},
                check: ['…'],
            },
            { path: 'NPC', type: 'record', keyDesc: 'NPC 名', value: { type: 'object', fields: [{ key: '身份', type: 'string', init: '' }] }, init: {}, check: ['新 NPC 登场时 insert'] },
        ],
    },
    html: '<div data-nl-text="世界.时间"></div><div data-nl-each="主要角色"><template><img data-nl-portrait="" alt=""><b data-nl-key></b><span data-nl-item="服饰.上衣"></span></template></div>',
};

test('世界/旁白卡沿用结构（保留路径）：提示词带分组 init 写法与主要角色名单（<变量表> 仍是纯 JSON），合并后补上漏掉的主要角色；只重写规则时不补', async () => {
    const s = settings();
    const p = castProject();
    const c = worldCard();
    const calls = installST(() => specReply({
        variables: [
            { path: '世界.时间', init: '雨夜' },
            { path: '主要角色', init: { 林小雨: { 好感: 66, 服饰: { 上衣: '雨衣', 帽子: '多余的键' } } }, check: ['好感单次 ±(1~5)'] },
            { path: 'NPC', init: {} },
        ],
    }));
    const sb = await generateStatusBar(p, s, c, { templateMode: 'structure', template: CAST_TEMPLATE });
    assert.equal(calls.length, 1);
    const text = calls[0].text;
    assert.match(text, /沿用的变量结构/);
    assert.match(text, /分组字段写成嵌套对象/);
    assert.match(text, /「主要角色」按角色名记录，init 里为这些主要角色各写一个条目（键照抄名字）：林小雨、周默。/);
    assert.doesNotMatch(text, /世界\/旁白卡的变量设计/, '结构已定时不带整体设计的说明');
    const kept = text.match(/<变量表>\n([\s\S]*?)\n<\/变量表>/);
    assert.deepEqual(JSON.parse(kept[1]).map((v) => v.path), ['世界.时间', '主要角色', 'NPC'], '<变量表> 块仍是纯 JSON（冒烟测试的模拟 AI 直接解析它）');

    const cast = sb.spec.variables[1];
    assert.deepEqual(cast.init, {
        林小雨: { 好感: 66, 心情: '平静', 服饰: { 上衣: '雨衣', 下装: '' } },
        周默: { 好感: 20, 心情: '平静', 服饰: { 上衣: '', 下装: '' } },
    }, '分组缺的字段补初始值、未知键丢弃；漏掉的主要角色补上');
    assert.deepEqual(cast.check, ['好感单次 ±(1~5)']);
    assert.equal(sb.html, CAST_TEMPLATE.html);
    assert.equal(sb.templateId, 'sbtpl_cast');
    assert.deepEqual(sb.lint.errors, []);
    assert.equal(parseStateWithSpec(sb.spec, buildInitialState(sb.spec)).ok, true);

    // 只重写规则：不动初始值，也不补条目，提示词里也没有名单
    delete sb.spec.variables[1].init.周默;
    const calls2 = installST(() => specReply({ variables: [{ path: '主要角色', check: ['新规则'] }] }));
    const sb2 = await generateStatusBar(p, s, c, { parts: ['rules'] });
    assert.doesNotMatch(calls2[0].text, /各写一个条目/);
    assert.doesNotMatch(calls2[0].text, /分组字段写成嵌套对象/);
    assert.deepEqual(Object.keys(sb2.spec.variables[1].init), ['林小雨']);
    assert.deepEqual(sb2.spec.variables[1].check, ['新规则']);
});

const TEAM_SPEC = {
    title: '林小雨的状态',
    variables: [
        { path: '世界.时间', type: 'string', init: '傍晚' },
        { path: '{{char}}.好感度', type: 'number', min: 0, max: 100, integer: true, init: 30 },
        {
            path: '主角.队友', type: 'record', keyDesc: '队友名',
            value: {
                type: 'object',
                fields: [
                    { key: '职业', type: 'string', init: '' },
                    {
                        key: '状态', type: 'object', label: '当前状态',
                        fields: [
                            { key: '体力', type: 'number', min: 0, max: 10, integer: true, init: 10, stages: [{ min: 0, label: '力竭' }, { min: 5, label: '尚可' }] },
                            { key: '心情', type: 'enum', options: ['平静', '紧张'], init: '平静' },
                        ],
                    },
                ],
            },
            init: { 阿哲: { 职业: '向导', 状态: { 体力: 7, 心情: '紧张' } } },
        },
        { path: '主角.物品', type: 'record', keyDesc: '物品名', value: { type: 'object', fields: [{ key: '数量', type: 'number', min: 0, integer: true, init: 1 }] }, init: { 雨伞: { 数量: 1 } } },
    ],
};

test('角色卡的记录带分组：变量表保留分组与字段阶段；界面提示词按本卡变量表给出 data-nl-group / 点路径 / 立绘槽位示例（只给角色记录）', async () => {
    const s = settings();
    const c = card();
    const calls = installST((call) => (call.kind === 'spec' ? specReply(TEAM_SPEC) : htmlReply(GOOD_HTML)));
    const sb = await generateStatusBar(project(), s, c);
    const team = sb.spec.variables.find((v) => v.path === '主角.队友');
    assert.equal(team.value.fields[1].type, 'object');
    assert.equal(team.value.fields[1].label, '当前状态');
    assert.deepEqual(team.value.fields[1].fields.map((f) => f.key), ['体力', '心情']);
    assert.deepEqual(team.value.fields[1].fields[0].stages.map((x) => x.label), ['力竭', '尚可']);
    assert.deepEqual(team.init.阿哲, { 职业: '向导', 状态: { 体力: 7, 心情: '紧张' } });
    assert.equal(countSpecLeaves(sb.spec), 6);

    assert.match(calls[0].text, /《雨夜》的角色卡「林小雨」/);
    assert.doesNotMatch(calls[0].text, /世界\/旁白卡/);
    const html = calls[1].text;
    assert.match(html, /为角色卡「林小雨」设计状态栏界面/);
    assert.doesNotMatch(html, /世界\/旁白卡的界面/);
    const guide = html.slice(html.indexOf('# 本卡的绑定示例'), html.indexOf('# 风格'));
    assert.match(guide, /「主角\.队友」的每个条目是一个角色/);
    assert.match(guide, /data-nl-group="状态"/);
    assert.match(guide, /data-nl-item="状态\.体力"/);
    assert.match(guide, /<summary>当前状态<\/summary>/);
    assert.doesNotMatch(guide, /主角\.物品/, '物品记录不是角色，也没有分组：不给示例');
    assert.match(guide, /可选：在「林小雨」的名字旁放立绘槽位 <img class="sb-av" data-nl-portrait="林小雨" alt="">/);
    assert.match(guide, /还没有配置立绘图片/);
    assert.equal(sb.mode, 'bind');
});

test('statusLayoutGuide：示例片段本身通过检查、能在运行时渲染；已配置的立绘只列名字不泄露地址；没有可示例的内容时为空', () => {
    const spec = normalizeStatusSpec(TEAM_SPEC, { charName: '林小雨' });
    const guide = statusLayoutGuide(spec, { charName: '林小雨' });
    assert.ok(guide.startsWith('\n# 本卡的绑定示例') && guide.endsWith('\n'));
    const examples = guide.split('\n').filter((l) => l.startsWith('<div class="sb-list"'));
    assert.equal(examples.length, 1);
    assert.deepEqual(checkStatusHtml(examples[0], spec), { errors: [], warnings: [] });
    const stat = buildInitialState(spec);
    stat.主角.队友.小周 = { 职业: '司机', 状态: { 体力: 2, 心情: '平静' } };
    const env = openStatusDocument(compileStatusDocument({ statusBar: { mode: 'bind', spec, html: examples[0] } }), { stat });
    assert.deepEqual(env.errors, []);
    const cards = env.document.querySelectorAll('.sb-card');
    assert.deepEqual(cards.map((x) => x.querySelector('.sb-name').textContent), ['阿哲', '小周']);
    assert.deepEqual(cards[0].querySelectorAll('.sb-kv').map((x) => x.textContent), ['体力：7', '心情：紧张']);
    assert.equal(cards[0].querySelector('.sb-val').textContent, '向导');
    assert.equal(cards[1].querySelector('[data-nl-ph]').textContent, '小');

    // 群像模板：两个角色记录各一个示例，都通过检查；世界卡不给单个角色的立绘建议
    const world = normalizeStatusSpec(JSON.parse(statusWorldJsonTemplate('雨城旁白', ['林小雨'])), { charName: '雨城旁白' });
    const wguide = statusLayoutGuide(world, { charName: '雨城旁白', world: true });
    const wex = wguide.split('\n').filter((l) => l.startsWith('<div class="sb-list"'));
    assert.deepEqual(wex.map((l) => l.match(/data-nl-each="([^"]+)"/)[1]), ['主要角色', 'NPC']);
    assert.deepEqual(checkStatusHtml(wex.join('\n'), world), { errors: [], warnings: [] });
    assert.deepEqual(lintStatusHtml(wex.join('\n'), { mode: 'bind', spec: world }), { errors: [], warnings: [] });
    assert.match(wex[0], /data-nl-item-stage="好感"/, '有阶段的数字字段带阶段名');
    assert.doesNotMatch(wguide, /可选：在/);

    // 已配置立绘：列出名字与立绘池，不把图片地址写进提示词
    const portraits = {
        characters: { 林小雨: [{ url: 'https://img.example.com/lin.png' }] },
        pools: [{ record: '主角.队友', field: '状态.心情', pools: { 紧张: ['https://img.example.com/t.png'] }, fallback: [] }],
    };
    const g2 = statusLayoutGuide(spec, { charName: '林小雨', portraits });
    assert.match(g2, /用户已经配置了立绘：林小雨；「主角\.队友」里按「状态\.心情」分配的立绘池/);
    assert.doesNotMatch(g2, /img\.example|还没有配置/);
    const c = card();
    ensureStatusBar(c, settings()).portraits = portraits;
    const hp = buildStatusHtmlPrompt(project(), settings(), c, { spec });
    assert.match(hp.prompt, /用户已经配置了立绘：林小雨/);
    assert.doesNotMatch(hp.prompt, /img\.example/);

    // 没有记录、没有角色自己的分组、也没有立绘：不加这一节；隐藏的记录不给示例
    const plainSpec = normalizeStatusSpec({ variables: [{ path: '世界.时间', type: 'string' }, { path: '主角.金币', type: 'number', min: 0, max: 999 }] });
    assert.equal(statusLayoutGuide(plainSpec, { charName: '林小雨' }), '');
    assert.equal(statusLayoutGuide(null), '');
    assert.match(statusLayoutGuide(plainSpec, { charName: '林小雨', portraits: { characters: { 主角: ['https://img.example.com/me.png'] } } }), /用户已经配置了立绘：主角/);
    const hidden = normalizeStatusSpec({ variables: [{ ...TEAM_SPEC.variables[2], widget: 'hidden' }] });
    assert.equal(statusLayoutGuide(hidden, { charName: '林小雨' }), '');
    const plainCard = card();
    ensureStatusBar(plainCard, settings());
    const plainPrompt = buildStatusHtmlPrompt(project(), settings(), plainCard, { spec: plainSpec }).prompt;
    assert.doesNotMatch(plainPrompt, /本卡的绑定示例/);
    assert.match(plainPrompt, /data-nl-bar="路径"[\s\S]*\n\n# 风格\n/, '没有示例时版式与以前一致');
});

test('套用「多人群像」（模板自带上限 15）后让 AI 调整：15 个变量全部保留，不按设置上限 12 截掉 NPC；世界卡补上主要角色；撤销连同模板带来的立绘一起换回', async () => {
    const { applyStatusBarTemplate, getStatusBarTemplate } = await import('../src/statusbar-templates.js');
    const s = settings();
    s.statusBar.maxVars = 12; // 老用户的设置：v0.15 之前的默认上限 12（新默认 20 时 15 个变量本来就放得下）
    const p = castProject();
    const c = worldCard();
    const own = { characters: { 林小雨: [{ url: 'https://img.example.com/lin.png' }] }, pools: [] };
    ensureStatusBar(c, s).portraits = own;
    const tpl = {
        ...getStatusBarTemplate(s, 'builtin_ensemble'),
        portraits: { characters: { 周默: [{ url: 'https://img.example.com/zhou.png' }] }, pools: [{ record: 'NPC', field: '阵营', pools: { 守卫: ['https://img.example.com/g.png'] }, fallback: [] }] },
    };
    assert.equal(countSpecLeaves(tpl.spec), 15);
    const res = applyStatusBarTemplate(c, tpl, 'structure', { settings: s });
    assert.deepEqual(res.ai, { parts: ['init', 'rules'], templateMode: 'structure' });
    const undoTo = c.statusBar.prev;
    assert.deepEqual(Object.keys(undoTo.portraits.characters), ['林小雨'], 'prev 里是套用前的立绘');
    // 保留路径：AI 照抄 <变量表> 的路径与初始值，只改规则
    const calls = installST((call) => {
        const kept = JSON.parse(call.text.match(/<变量表>\n([\s\S]*?)\n<\/变量表>/)[1]);
        return specReply({ variables: kept.map((v) => ({ path: v.path, init: v.init, check: ['按剧情更新'] })) });
    });
    const warnings = [];
    const sb = await generateStatusBar(p, s, c, { ...res.ai, template: tpl, warnings });
    assert.equal(calls.length, 1);
    const sent = JSON.parse(calls[0].text.match(/<变量表>\n([\s\S]*?)\n<\/变量表>/)[1]).map((v) => v.path);
    assert.deepEqual(sent, ['世界.时间', '世界.地点', '主角.身份', '主要角色', 'NPC'], '交给 AI 的结构没有被截掉');
    assert.deepEqual(sb.spec.variables.map((v) => v.path), sent);
    assert.equal(countSpecLeaves(sb.spec), 15);
    assert.ok(!warnings.some((w) => /超过上限|丢弃/.test(w)), warnings.join('\n'));
    assert.deepEqual(Object.keys(sb.spec.variables[3].init), ['林小雨', '周默'], '世界卡：主要角色按名单补上（时间点前出场的 main）');
    assert.deepEqual(sb.spec.variables[3].init.周默.服饰, { 上衣: '', 下装: '', 配饰: '' });
    assert.deepEqual(sb.spec.variables[4].init, {}, 'NPC 不预填');
    assert.deepEqual(lintStatusHtml(sb.html, { mode: 'bind', spec: sb.spec }), { errors: [], warnings: [] }, '界面绑定的 NPC 仍在变量表里');
    assert.deepEqual(Object.keys(sb.portraits.characters).sort(), ['周默', '林小雨'], '模板的立绘并进来，卡片自己的保留');
    assert.equal(sb.portraits.pools.length, 1);

    // 一步撤销（与对话框的套用流程一样：prev 恢复成套用前的快照）：立绘也换回套用前的，再撤销一次又换回来
    sb.prev = undoTo;
    assert.equal(restoreStatusBarPrev(c), true);
    assert.deepEqual(Object.keys(c.statusBar.portraits.characters), ['林小雨']);
    assert.deepEqual(c.statusBar.portraits.pools, []);
    assert.equal(c.statusBar.spec.variables.length, 0, '变量表回到套用前（空）');
    assert.equal(restoreStatusBarPrev(c), true);
    assert.deepEqual(Object.keys(c.statusBar.portraits.characters).sort(), ['周默', '林小雨']);
    assert.equal(countSpecLeaves(c.statusBar.spec), 15);
    // AI 自己的撤销快照不带 portraits：不碰立绘
    const before = JSON.stringify(c.statusBar.portraits);
    installST((call) => specReply({ variables: JSON.parse(call.text.match(/<变量表>\n([\s\S]*?)\n<\/变量表>/)[1]).map((v) => ({ path: v.path, check: ['新规则'] })) }));
    await generateStatusBar(p, s, c, { parts: ['rules'] });
    assert.equal(countSpecLeaves(c.statusBar.spec), 15, '只重写规则时按卡片现有变量表合并，也不截断');
    assert.ok(!('portraits' in c.statusBar.prev));
    assert.equal(restoreStatusBarPrev(c), true);
    assert.equal(JSON.stringify(c.statusBar.portraits), before);
});

test('卡片自己的变量上限：沿用结构的 AI 调整记下模板的上限；之后按别的模板「只借外观」重写界面、只重写规则都不降低；整体重新设计时回到设置里的', async () => {
    const { applyStatusBarTemplate, getStatusBarTemplate, statusBarVarCap } = await import('../src/statusbar-templates.js');
    const s = settings();
    s.statusBar.maxVars = 12; // 老用户的设置：v0.15 之前的默认上限 12
    const p = castProject();
    const c = worldCard();
    const ens = getStatusBarTemplate(s, 'builtin_ensemble');
    const keep = (call) => specReply({ variables: JSON.parse(call.text.match(/<变量表>\n([\s\S]*?)\n<\/变量表>/)[1]).map((v) => ({ path: v.path, init: v.init, check: ['按剧情更新'] })) });

    // 不经过 applyStatusBarTemplate、直接让 AI 按模板沿用结构（写卡流程）：也记下上限
    installST(keep);
    await generateStatusBar(p, s, c, { templateMode: 'structure', template: ens });
    assert.equal(c.statusBar.templateId, 'builtin_ensemble');
    assert.equal(c.statusBar.maxVars, 15);
    assert.equal(countSpecLeaves(c.statusBar.spec), 15);

    // 只借外观：按「赛博朋克」重写界面——templateId 变了，上限不变，变量表校验仍保留 NPC
    const cyber = getStatusBarTemplate(s, 'builtin_cyberpunk');
    const calls = installST(() => htmlReply('<div class="hud"><b data-nl-text="世界.时间"></b> <i data-nl-text="世界.地点"></i><ul data-nl-each="NPC"><template><li data-nl-key></li></template></ul></div>'));
    const r = applyStatusBarTemplate(c, cyber, 'look', { settings: s });
    await generateStatusBar(p, s, c, { ...r.ai, template: cyber });
    assert.equal(calls.length, 1);
    assert.equal(c.statusBar.templateId, 'builtin_cyberpunk');
    assert.equal(c.statusBar.mode, 'bind');
    assert.equal(c.statusBar.maxVars, 15, '只借外观不降低');
    assert.equal(statusBarVarCap(c, s), 15);
    const w = [];
    const kept = normalizeStatusSpec(c.statusBar.spec, { charName: '雨城旁白', maxVars: statusBarVarCap(c, s), warnings: w });
    assert.deepEqual(kept.variables.map((v) => v.path), ['世界.时间', '世界.地点', '主角.身份', '主要角色', 'NPC']);
    assert.deepEqual(w, []);

    // 只重写规则（按本卡变量表）：不动
    installST(keep);
    await generateStatusBar(p, s, c, { parts: ['rules'] });
    assert.equal(c.statusBar.maxVars, 15);
    assert.equal(countSpecLeaves(c.statusBar.spec), 15);

    // 整体重新设计：变量表按设置里的上限（12）生成，卡片的上限回到跟随设置；撤销回来后按现有变量数仍是 15
    installST((call) => (call.kind === 'spec' ? specReply(WORLD_SPEC) : htmlReply('<div data-nl-text="世界.时间"></div>')));
    await generateStatusBar(p, s, c, { parts: ['spec'] });
    assert.ok(countSpecLeaves(c.statusBar.spec) <= 12);
    assert.equal(c.statusBar.maxVars, null);
    assert.equal(statusBarVarCap(c, s), 12);
    assert.equal(restoreStatusBarPrev(c), true);
    assert.equal(countSpecLeaves(c.statusBar.spec), 15);
    assert.equal(c.statusBar.maxVars, 15, '撤销也换回卡片记着的上限（prev 里存着 maxVars）');
    assert.equal(statusBarVarCap(c, s), 15, '撤销回到 15 个变量，不会被截掉');
    // 删掉几个变量之后上限也还是 15（不只靠现有变量数）；再点一次（重做）回到跟随设置
    assert.equal(statusBarVarCap({ statusBar: { ...c.statusBar, spec: { variables: c.statusBar.spec.variables.slice(0, 3) } } }, s), 15);
    assert.equal(restoreStatusBarPrev(c), true);
    assert.equal(c.statusBar.maxVars, null);
    delete globalThis.SillyTavern;
});
