// 状态栏对话框（src/ui/statusbar-dialog.js）里不依赖 DOM 的部分：写入酒馆后的提示（当前打开的就是这张卡）、
// 套用模板（只借外观必须调用 AI、没有变化时不算成功、收集提示）、变量表的范围提示、模板重名检查、
// 变量数口径（countSpecLeaves）、分页条、没用过的状态栏按当前默认值刷新。AI 调用全部用模拟的酒馆 generateRaw。
import test from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_SETTINGS } from '../src/constants.js';
import { createProject, normalizeCharacter, normalizeProject } from '../src/project.js';
import { ensureStatusBar, normalizeStatusSpec } from '../src/statusbar.js';
import { BUILTIN_STATUSBAR_TEMPLATES, STATUS_TEMPLATE_NAME_MAX, addStatusBarTemplate } from '../src/statusbar-templates.js';
import {
    SAME_CHAR_RELOAD_NOTE, applyTemplateToCard, cardOpenInST, generateStatusBarForCard, openStatusBarPublishHint,
    refreshPristineStatusBar, rowRangeWarnings, statusBarPristine, statusBarPublishHintHtml, statusBarTagHtml, statusTabsHtml,
    templateAiState, templateNameProblem, varCountText,
} from '../src/ui/statusbar-dialog.js';
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
    p.chunks = [0, 1].map((i) => ({ id: `c${i}`, index: i, title: `第${i + 1}章`, content: '', charCount: 100, end: 100, status: 'done' }));
    p.characters['林小雨'] = normalizeCharacter({ name: '林小雨', importance: 'main', identity: '咖啡馆店员', firstChunk: 0, lastChunk: 1, chunksSeen: [0, 1] });
    return normalizeProject(p);
}

function card(extra = {}) {
    return {
        id: uid('card_'), charName: '林小雨', kind: 'character', timepoint: null, requirement: '', createdAt: Date.now(), updatedAt: Date.now(),
        data: {
            name: '林小雨', description: '咖啡馆店员，话少。', personality: '慢热', scenario: '雨夜的咖啡馆', first_mes: '雨停了。', alternate_greetings: [],
            mes_example: '', system_prompt: '', post_history_instructions: '', creator_notes: '', tags: ['都市'],
        },
        lint: [], stAvatar: '', worldName: '',
        ...extra,
    };
}

/** 模拟酒馆：generateRaw 按提示词区分「变量表」与「界面」两类调用；可带当前打开的角色等上下文 */
function installST(handler, extra = {}) {
    const calls = [];
    globalThis.SillyTavern = {
        getContext: () => ({
            async generateRaw({ prompt }) {
                const messages = Array.isArray(prompt) ? prompt : [{ role: 'user', content: String(prompt) }];
                const text = messages.map((m) => m.content).join('\n');
                const kind = text.includes('data-nl-bar="路径"') ? 'html' : 'spec';
                calls.push({ kind, text });
                return handler({ kind, text });
            },
            stopGeneration() {},
            ...extra,
        }),
    };
    return calls;
}

const SPEC = {
    title: '林小雨的状态',
    variables: [
        { path: '世界.时间', type: 'string', init: '傍晚', label: '时间' },
        { path: '林小雨.好感度', type: 'number', init: 30, min: 0, max: 100, integer: true, widget: 'bar' },
        { path: '林小雨.心情', type: 'enum', options: ['平静', '开心', '低落'], init: '平静' },
    ],
};

const HTML_A = '<style>.a{color:#eee}</style><div class="a"><span data-nl-text="世界.时间"></span><div data-nl-bar="林小雨.好感度"><i></i></div><span data-nl-text="林小雨.心情"></span></div>';
const HTML_B = '<style>.b{color:#0ff;border:1px solid #f0f}</style><section class="b"><b data-nl-text="林小雨.心情"></b><span data-nl-text="世界.时间"></span><div data-nl-bar="林小雨.好感度"><i></i></div></section>';

const specReply = (obj) => `\`\`\`json\n${JSON.stringify(obj, null, 2)}\n\`\`\``;
const htmlReply = (html) => `\`\`\`html\n${html}\n\`\`\``;

function seeded(s) {
    const c = card();
    const sb = ensureStatusBar(c, s);
    sb.spec = normalizeStatusSpec(SPEC, { charName: '林小雨' });
    sb.mode = 'bind';
    sb.html = HTML_A;
    return c;
}

function ctx(s, logs = []) {
    return { app: { log: (m, l = 'info') => logs.push([m, l]) }, project: project(), settings: s };
}

// ---------------- (a) 写入酒馆后的提示 ----------------

test('写入后提示：写入的正是酒馆里当前打开的角色时，提示先换个角色再切回来（或刷新页面），并记一条 warn', async () => {
    const c = card({ stAvatar: '林小雨' });
    const s = settings();
    ensureStatusBar(c, s).spec = normalizeStatusSpec(SPEC, { charName: '林小雨' });

    installST(() => '', { characters: [{ avatar: '别人.png' }, { avatar: '林小雨.png' }], characterId: '1', extensionSettings: {} });
    assert.equal(cardOpenInST(c), true);
    const html = statusBarPublishHintHtml(c, '雨夜·林小雨');
    assert.ok(html.includes('data-sb-reopen') && html.includes(SAME_CHAR_RELOAD_NOTE));
    assert.match(html, /先切换到别的角色，再切回这个角色/);
    assert.match(html, /data-sb-hide-hint/);

    // 勾过「不再提示」也要在日志里提醒（不弹框，不需要 DOM）
    c.statusBar.hideHint = true;
    const logs = [];
    await openStatusBarPublishHint(c, ctx(s, logs));
    assert.deepEqual(logs.map((x) => x[1]), ['warn']);
    assert.ok(logs[0][0].includes(SAME_CHAR_RELOAD_NOTE));

    // 当前打开的是别的角色 / 没有打开角色 / 还没写入酒馆：不提示
    installST(() => '', { characters: [{ avatar: '别人.png' }, { avatar: '林小雨.png' }], characterId: '0', extensionSettings: {} });
    assert.equal(cardOpenInST(c), false);
    assert.ok(!statusBarPublishHintHtml(c, 'w').includes('data-sb-reopen'));
    assert.match(statusBarPublishHintHtml(c, 'w'), /在酒馆打开这个角色/);
    const logs2 = [];
    await openStatusBarPublishHint(c, ctx(s, logs2));
    assert.deepEqual(logs2, []);
    installST(() => '', { characters: [{ avatar: '林小雨.png' }], characterId: undefined });
    assert.equal(cardOpenInST(c), false);
    installST(() => '', { characters: [{ avatar: '.png' }], characterId: 0 });
    assert.equal(cardOpenInST(card({ stAvatar: '' })), false);
    delete globalThis.SillyTavern;
});

// ---------------- (b)(c) 套用模板 ----------------

test('templateAiState：只借外观必须调用 AI（复选框锁定为勾选）；内置排版模板借外观且已有变量时不需要 AI；沿用结构由用户决定', () => {
    const bind = { mode: 'bind', html: HTML_B };
    const auto = { mode: 'auto' };
    assert.deepEqual(templateAiState(bind, true, 'structure'), { locked: false, checked: null, note: '' });
    const look = templateAiState(bind, true, 'look');
    assert.equal(look.locked, true);
    assert.equal(look.checked, true);
    assert.match(look.note, /必须调用 AI/);
    assert.equal(templateAiState(bind, false, 'look').checked, true);
    assert.match(templateAiState(bind, false, 'look').note, /先设计变量/);
    assert.deepEqual([templateAiState(auto, true, 'look').locked, templateAiState(auto, true, 'look').checked], [true, false]);
    assert.equal(templateAiState(auto, false, 'look').checked, true, '内置排版模板、卡上还没有变量：要 AI 先设计变量');
});

test('applyTemplateToCard 只借外观：AI 按本卡变量重写界面；不调用 AI 时界面没有变化，changed 为 false（不能算套用成功）', async () => {
    const s = settings();
    const tpl = { id: 'sbtpl_look', name: '霓虹', mode: 'bind', theme: 'night', html: HTML_B, spec: null };

    const c1 = seeded(s);
    const calls1 = installST(() => { throw new Error('不应调用 AI'); });
    const r1 = await applyTemplateToCard(c1, { project: project(), settings: s, log: () => {} }, tpl, 'look', { ai: false });
    assert.equal(calls1.length, 0);
    assert.equal(r1.changed, false, '只换了配色和 templateId，绑定界面不用配色，效果不变');
    assert.equal(r1.ai, false);

    const c2 = seeded(s);
    const calls2 = installST((call) => {
        assert.equal(call.kind, 'html');
        return htmlReply(HTML_B);
    });
    const r2 = await applyTemplateToCard(c2, { project: project(), settings: s, log: () => {} }, tpl, 'look', { ai: true });
    assert.equal(calls2.length, 1);
    assert.equal(r2.changed, true);
    assert.equal(r2.ai, true);
    assert.equal(c2.statusBar.html, HTML_B);
    assert.equal(c2.statusBar.prev.html, HTML_A, '撤销回到套用模板之前');

    // 内置排版的模板、卡上还没有变量：AI 先设计变量（只设计变量，界面用内置排版）
    const c3 = card();
    const calls3 = installST((call) => (call.kind === 'spec' ? specReply(SPEC) : htmlReply(HTML_B)));
    const r3 = await applyTemplateToCard(c3, { project: project(), settings: s, log: () => {} }, { id: 'sbtpl_auto', name: '素', mode: 'auto', theme: 'paper' }, 'look', { ai: true });
    assert.deepEqual(calls3.map((x) => x.kind), ['spec']);
    assert.equal(c3.statusBar.mode, 'auto');
    assert.equal(c3.statusBar.theme, 'paper');
    assert.ok(c3.statusBar.spec.variables.length > 0);
    assert.equal(r3.changed, true);
    delete globalThis.SillyTavern;
});

test('applyTemplateToCard 沿用结构：套用与 AI 合并时的提示都收进 warnings（清除手写覆盖、AI 给的初始值不合法……）', async () => {
    const s = settings();
    const c = seeded(s);
    c.statusBar.overrides.updateRules = '手写的规则';
    const tpl = { id: 'sbtpl_struct', name: '结构', mode: 'bind', theme: 'night', html: HTML_B, spec: SPEC };
    installST(() => specReply({ variables: [{ path: '世界.时间', init: '深夜' }, { path: '林小雨.心情', init: '暴怒' }, { path: '林小雨.好感度', init: 40 }] }));
    const warnings = [];
    const r = await applyTemplateToCard(c, { project: project(), settings: s, log: () => {} }, tpl, 'structure', { ai: true, warnings });
    assert.equal(r.warnings, warnings);
    assert.ok(warnings.some((w) => w.includes('已清除手写')), warnings.join('\n'));
    assert.ok(warnings.some((w) => w.includes('林小雨.心情') && w.includes('不合法')), warnings.join('\n'));
    assert.equal(c.statusBar.spec.variables.find((v) => v.path === '世界.时间').init, '深夜');
    assert.equal(r.changed, true);
    delete globalThis.SillyTavern;
});

test('generateStatusBarForCard：规范化的提示逐条记成 warn，成功日志里的变量数按 countSpecLeaves 计', async () => {
    const s = settings();
    s.statusBar.htmlMode = 'auto';
    const c = card();
    installST(() => specReply({
        title: '状态',
        variables: [
            ...SPEC.variables,
            { path: 'bad path.x', type: 'string', init: '' },
            { path: '主角.物品', type: 'record', keyDesc: '物品名', value: { type: 'object', fields: [{ key: '数量', type: 'number', min: 0, init: 1 }, { key: '描述', type: 'string' }] }, init: {} },
        ],
    }));
    const logs = [];
    assert.equal(await generateStatusBarForCard(c, ctx(s, logs)), true);
    const warns = logs.filter((x) => x[1] === 'warn').map((x) => x[0]);
    assert.ok(warns.some((m) => m.includes('bad path')), warns.join('\n'));
    const ok = logs.find((x) => x[1] === 'success')[0];
    assert.match(ok, /5 个变量（记录的每个字段各算一个）/);
    delete globalThis.SillyTavern;
});

// ---------------- (d) 变量表的范围提示 ----------------

const normOne = (row) => normalizeStatusSpec({ variables: [row] }, { maxVars: 999 }).variables[0];

test('rowRangeWarnings：最小值大于最大值、初始值超出范围 / 不是整数 / 没填，都提示用户填的值和实际生效的值', () => {
    const swap = { path: '林小雨.好感度', type: 'number', init: 30, min: 200, max: 100, integer: true };
    const n1 = normOne(swap);
    const w1 = rowRangeWarnings(swap, n1);
    assert.ok(w1.some((m) => m.includes('最小值 200 大于最大值 100') && m.includes(`${n1.min} ~ ${n1.max}`)), w1.join('\n'));

    const over = { path: 'a.b', type: 'number', init: 150, min: 0, max: 100, integer: true };
    const n2 = normOne(over);
    const w2 = rowRangeWarnings(over, n2);
    if (n2.init !== 150) assert.ok(w2.some((m) => m.includes('初始值 150 超出范围 0 ~ 100') && m.endsWith(`按 ${n2.init} 生效`)), w2.join('\n'));

    const frac = { path: 'a.b', type: 'number', init: 3.6, min: 0, max: 10, integer: true };
    assert.deepEqual(rowRangeWarnings(frac, normOne(frac)), ['初始值 3.6 不是整数：现在按 4 生效']);

    const blank = { path: 'a.b', type: 'number', init: null, min: 5, max: 10, integer: true };
    assert.match(rowRangeWarnings(blank, normOne(blank))[0], /没有填初始值：现在按 \d+ 生效/);

    const fine = { path: 'a.b', type: 'number', init: 30, min: 0, max: 100, integer: true };
    assert.deepEqual(rowRangeWarnings(fine, normOne(fine)), []);
    assert.deepEqual(rowRangeWarnings({ path: 'a.c', type: 'string', init: 'x' }, normOne({ path: 'a.c', type: 'string', init: 'x' })), []);
    assert.deepEqual(rowRangeWarnings(swap, null), [], '不合法的行另有出错提示');
});

test('rowRangeWarnings：记录的数字值范围、对象字段范围、初始条目超出范围', () => {
    const rec = { path: '主角.物品', type: 'record', keyDesc: '物品名', value: { type: 'number', min: 10, max: 0, integer: true }, init: { 雨伞: 50 } };
    const n = normOne(rec);
    const w = rowRangeWarnings(rec, n);
    assert.ok(w.some((m) => m.startsWith('值的最小值 10 大于最大值 0')), w.join('\n'));
    if (n.init['雨伞'] !== 50) assert.ok(w.some((m) => m.includes('初始条目「雨伞」的值 50 超出范围')), w.join('\n'));

    const obj = {
        path: '主角.关系', type: 'record', keyDesc: '角色名',
        value: { type: 'object', fields: [{ key: '好感', type: 'number', min: 100, max: 0, init: 5 }, { key: '状态', type: 'string', init: '' }] },
        init: { 林小雨: { 好感: 500, 状态: '平静' } },
    };
    const no = normOne(obj);
    const wo = rowRangeWarnings(obj, no);
    assert.ok(wo.some((m) => m.startsWith('字段「好感」的最小值 100 大于最大值 0')), wo.join('\n'));
    if (no.init['林小雨']['好感'] !== 500) assert.ok(wo.some((m) => m.includes('初始条目「林小雨」的「好感」500 超出范围')), wo.join('\n'));

    const okRec = { path: '主角.物品', type: 'record', keyDesc: '物品名', value: { type: 'number', min: 0, max: 99, integer: true }, init: { 雨伞: 1 } };
    assert.deepEqual(rowRangeWarnings(okRec, normOne(okRec)), []);
});

// ---------------- (e) 模板名称 ----------------

test('templateNameProblem：不能为空、不能超长、不能与其他模板重名（不分大小写、空白规整），改名时排除自己', () => {
    const s = settings();
    const mine = addStatusBarTemplate(s, { name: '我的模板', mode: 'auto', spec: SPEC });
    assert.equal(templateNameProblem(s, '   '), '请输入模板名称');
    assert.match(templateNameProblem(s, 'x'.repeat(STATUS_TEMPLATE_NAME_MAX + 1)), /最多/);
    const rpg = BUILTIN_STATUSBAR_TEMPLATES.find((t) => /[A-Za-z]/.test(t.name)) || BUILTIN_STATUSBAR_TEMPLATES[0];
    assert.match(templateNameProblem(s, ` ${rpg.name.toLowerCase()} `), /已有同名的模板/);
    assert.match(templateNameProblem(s, '我的模板'), /已有同名的模板「我的模板」/);
    assert.match(templateNameProblem(s, '我的  模板'.replace('  ', '')), /已有同名/);
    assert.equal(templateNameProblem(s, '我的模板', mine.id), '', '改名时可以保留原名');
    assert.match(templateNameProblem(s, rpg.name, mine.id), /已有同名/, '改名成别的模板的名字不行');
    assert.equal(templateNameProblem(s, '新名字'), '');
});

// ---------------- (f) 变量数口径 ----------------

test('变量数一律按 countSpecLeaves：记录的每个字段各算一个；卡片标签和工具栏用同一个说法', () => {
    const spec = normalizeStatusSpec({
        variables: [
            { path: '林小雨.好感度', type: 'number', init: 1, min: 0, max: 100 },
            { path: '主角.关系', type: 'record', value: { type: 'object', fields: [{ key: '好感', type: 'number', min: 0, max: 100 }, { key: '状态', type: 'string' }, { key: '在场', type: 'boolean' }] }, init: {} },
        ],
    }, { maxVars: 99 });
    assert.equal(varCountText(spec, 12), '4 / 12 个变量（记录的每个字段各算一个）');
    assert.equal(varCountText(normalizeStatusSpec(SPEC), 12), '3 / 12 个变量');
    const c = card();
    const sb = ensureStatusBar(c, settings());
    sb.spec = spec;
    assert.match(statusBarTagHtml(c), /4 个变量（记录的每个字段各算一个）/);
});

// ---------------- (g) 分页条 ----------------

test('分页条：aria-pressed 的按钮组（不是半套 ARIA tabs），保留 data-act / data-tab', () => {
    const html = statusTabsHtml('rules', { vars: ' <span class="nl-num">4</span>' });
    assert.ok(!/role="tab"|role="tablist"|aria-selected/.test(html));
    assert.match(html, /class="nl-seg nl-sb-tabs" role="group" aria-label="[^"]+"/);
    assert.match(html, /aria-pressed="true" data-act="sb-tab" data-tab="rules"/);
    assert.equal((html.match(/aria-pressed="false"/g) || []).length, 4);
    assert.match(html, /data-tab="vars">变量 <span class="nl-num">4<\/span>/);
});

// ---------------- (h) 没用过的状态栏 ----------------

test('没用过的状态栏按当前设置刷新模式 / 配色 / 选项；用过（有变量、编辑过、生成过）就不动', () => {
    const s1 = settings();
    const c = card();
    const sb = ensureStatusBar(c, s1); // 之前打开过一次对话框
    assert.equal(sb.mode, 'bind');
    const s2 = settings();
    Object.assign(s2.statusBar, { htmlMode: 'auto', theme: 'night', showDepth: null, analysisLang: 'zh' });
    assert.equal(statusBarPristine(sb), true);
    assert.equal(refreshPristineStatusBar(sb, s2), true);
    assert.deepEqual([sb.mode, sb.theme, sb.options.showDepth, sb.options.analysisLang], ['auto', 'night', null, 'zh']);

    for (const touch of [(x) => { x.updatedAt = 1; }, (x) => { x.generatedAt = 1; }, (x) => { x.html = '<div></div>'; }, (x) => { x.spec = normalizeStatusSpec(SPEC); }, (x) => { x.templateId = 'builtin_general'; }]) {
        const b = ensureStatusBar(card(), s1);
        touch(b);
        assert.equal(statusBarPristine(b), false);
        assert.equal(refreshPristineStatusBar(b, s2), false);
        assert.equal(b.options.showDepth, 1, '用户设过的不被覆盖');
    }
});

test('generateStatusBarForCard：卡上留着一个没用过的状态栏时，第一次生成用现在的默认值（内置排版就不调用界面）', async () => {
    const c = card();
    ensureStatusBar(c, settings()); // 当时默认是 AI 设计界面
    const s2 = settings();
    Object.assign(s2.statusBar, { htmlMode: 'auto', theme: 'paper', showDepth: 3 });
    const calls = installST((call) => (call.kind === 'spec' ? specReply(SPEC) : htmlReply(HTML_A)));
    assert.equal(await generateStatusBarForCard(c, ctx(s2)), true);
    assert.deepEqual(calls.map((x) => x.kind), ['spec']);
    assert.deepEqual([c.statusBar.mode, c.statusBar.theme, c.statusBar.options.showDepth], ['auto', 'paper', 3]);
    delete globalThis.SillyTavern;
});
