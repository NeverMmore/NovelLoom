// 状态栏 AI 生成（statusbar-ai.js）：变量表 JSON → 规范化、界面 ```html → 检查 → 修正重试 → 内置排版兜底、
// 保留路径的重新生成（只改初始值 / 只改规则）、沿用结构 / 只借外观模板、撤销、提示词与消息链注册。
// 全部用模拟的酒馆 generateRaw，不发真实请求。
import test from 'node:test';
import assert from 'node:assert/strict';

import { buildCardJson } from '../src/cards.js';
import { DEFAULT_SETTINGS } from '../src/constants.js';
import { CHAIN_TASKS, getChain } from '../src/llm.js';
import { DEFAULT_PROMPTS, PROMPT_LABELS, PROMPT_PLACEHOLDERS } from '../src/prompts.js';
import { createProject, normalizeCharacter, normalizeProject } from '../src/project.js';
import { buildStatusRegexScripts, ensureStatusBar, normalizeStatusSpec } from '../src/statusbar.js';
import {
    buildStatusHtmlPrompt, buildStatusSpecPrompt, checkStatusHtml, extractHtmlBlock, generateStatusBar, mergeKeptSpec,
    restoreStatusBarPrev, tryGenerateStatusBar,
} from '../src/statusbar-ai.js';
import { mergeDefaults, uid } from '../src/utils.js';

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
                const text = messages.map((m) => m.content).join('\n');
                const kind = text.includes('data-nl-bar="路径"') ? 'html' : 'spec';
                const call = { messages, text, kind, last: messages[messages.length - 1].content, n: calls.filter((c) => c.kind === kind).length };
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
    for (const k of ['statusSpecSystem', 'statusSpec', 'statusHtmlSystem', 'statusHtml']) {
        assert.ok(PROMPT_LABELS[k], `${k} 没有标签`);
        assert.ok(PROMPT_PLACEHOLDERS[k]?.length, `${k} 没有占位符列表`);
    }
    for (const ph of PROMPT_PLACEHOLDERS.statusSpec) assert.ok(DEFAULT_PROMPTS.statusSpec.includes(ph), `statusSpec 缺少 ${ph}`);
    for (const ph of PROMPT_PLACEHOLDERS.statusHtml) assert.ok(DEFAULT_PROMPTS.statusHtml.includes(ph), `statusHtml 缺少 ${ph}`);
    assert.ok(!DEFAULT_PROMPTS.statusHtml.includes('{{') && !DEFAULT_PROMPTS.statusHtmlSystem.includes('{{'));
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
    assert.match(spec.prompt, /不超过 12 个/);
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
    assert.equal(buildStatusSpecPrompt(p, s, c).prompt, '自定义：林小雨 最多 12 个', '用户在设置里改过的提示词生效');
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
