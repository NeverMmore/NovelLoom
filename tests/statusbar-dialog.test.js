// 状态栏对话框（src/ui/statusbar-dialog.js）里不依赖 DOM 的部分：写入酒馆后的提示（当前打开的就是这张卡）、
// 套用模板（只借外观必须调用 AI、没有变化时不算成功、收集提示）、变量表的范围提示、模板重名检查、
// 变量数口径（countSpecLeaves）、分页条、没用过的状态栏按当前默认值刷新。AI 调用全部用模拟的酒馆 generateRaw。
// v0.12：世界/旁白卡（写卡选项、填入主要角色）、记录字段里的分组（编辑器的增删改与检查）、「立绘」分页（草稿、检查、HTML）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { DEFAULT_SETTINGS } from '../src/constants.js';
import { createProject, normalizeCharacter, normalizeProject } from '../src/project.js';
import {
    GROUP_FIELD_MAX, PORTRAIT_LIMITS, RECORD_FIELD_MAX, applyReplyToState, buildInitialState, countSpecLeaves, ensureStatusBar, normalizePortraits,
    normalizeStatusSpec, portraitUrlProblem, variableLeafCount,
} from '../src/statusbar.js';
import { restoreStatusBarPrev } from '../src/statusbar-ai.js';
import { BUILTIN_STATUSBAR_TEMPLATES, STATUS_TEMPLATE_NAME_MAX, addStatusBarTemplate, statusBarVarCap } from '../src/statusbar-templates.js';
import {
    SAME_CHAR_RELOAD_NOTE, acceptPreviewStore, addRecordField, addRecordGroup, applyTemplateToCard, cardOpenInST, exampleReply, generateStatusBarForCard,
    moveRecordField, openStatusBarPublishHint, parseFieldRef, portraitDeleteFocus, portraitDisplayNote, portraitDraftFrom, portraitDraftIssues,
    portraitDraftToRaw, portraitNewNameProblem, portraitThumbHtml, portraitWhenProblem, portraitsPanelHtml, recordFieldIssues,
    recordFieldNameAt, recordFieldsEditorHtml, refreshPristineStatusBar, removeRecordField, renameRecordEntryField, rowRangeWarnings,
    seedCastAllowed, seedRecordEntriesInto, setRecordFieldProp, statusBarPristine, statusBarPublishHintHtml, statusBarTagHtml, statusTabsHtml,
    templateAiState, templateCapInfo, templateNameProblem, templatePortraitsOptionText, urlLines, varCountText, worldVarsHint,
} from '../src/ui/statusbar-dialog.js';
import { STORE_ENTRIES_MAX } from '../src/statusbar-runtime.js';
import { statusBarButtonTitle, statusBarFormNote } from '../src/ui/tab-cards.js';
import { memoryStorage } from './minidom.js';
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

test('分页条：aria-pressed 的按钮组（不是半套 ARIA tabs），保留 data-act / data-tab；「立绘」在界面和预览之间', () => {
    const html = statusTabsHtml('rules', { vars: ' <span class="nl-num">4</span>' });
    assert.ok(!/role="tab"|role="tablist"|aria-selected/.test(html));
    assert.match(html, /class="nl-seg nl-sb-tabs" role="group" aria-label="[^"]+"/);
    assert.match(html, /aria-pressed="true" data-act="sb-tab" data-tab="rules"/);
    assert.equal((html.match(/aria-pressed="false"/g) || []).length, 5);
    assert.match(html, /data-tab="vars">变量 <span class="nl-num">4<\/span>/);
    const order = [...html.matchAll(/data-tab="(\w+)"/g)].map((m) => m[1]);
    assert.deepEqual(order, ['vars', 'rules', 'ui', 'portraits', 'preview', 'export']);
    assert.match(statusTabsHtml('portraits'), /aria-pressed="true" data-act="sb-tab" data-tab="portraits">立绘/);
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

// ================ v0.12 ================

/** 群像用的记录（带两个分组）；init 里有两个条目 */
const CAST = {
    path: '主要角色', type: 'record', keyDesc: '角色名', label: '主要角色',
    value: {
        type: 'object',
        fields: [
            { key: '身份', type: 'string', init: '' },
            { key: '好感', type: 'number', min: 0, max: 100, integer: true, init: 20, stages: [{ min: 0, label: '陌生' }, { min: 60, label: '信任' }] },
            { key: '服饰', type: 'object', label: '穿着', fields: [{ key: '上衣', type: 'string', init: '白衬衫' }, { key: '下装', type: 'string', init: '' }] },
        ],
    },
    init: { 莉艾丽: { 身份: '学生', 好感: 70 }, 卡尔: { 好感: 10 } },
};
const WORLD_SPEC = {
    title: '群像',
    variables: [
        { path: '世界.时间', type: 'string', init: '清晨' },
        { path: '主角.声望', type: 'number', min: 0, max: 100, init: 5 },
        CAST,
        { path: 'NPC', type: 'record', keyDesc: '名字', value: { type: 'object', fields: [{ key: '阵营', type: 'enum', options: ['友好', '敌对'], init: '友好' }, { key: '好感', type: 'number', min: 0, max: 100, init: 0 }] }, init: {} },
    ],
};
const normWorld = () => normalizeStatusSpec(WORLD_SPEC, { maxVars: 30 });
const clone = (v) => JSON.parse(JSON.stringify(v));

// ---------------- (i) 世界/旁白卡 ----------------

test('写卡选项：世界/旁白卡也能勾「同时生成状态栏」，说明讲为整个群像设计；tab-cards 里不再有「暂不支持」的限制', () => {
    const w = statusBarFormNote('world');
    assert.match(w, /群像/);
    assert.match(w, /\{\{char\}\} 是旁白/);
    assert.match(w, /NPC/);
    assert.match(statusBarFormNote('character'), /好感、心情、位置/);
    assert.ok(!/暂不支持/.test(w + statusBarFormNote('character')));
    assert.match(statusBarButtonTitle({ kind: 'world' }), /群像.*立绘/);
    assert.match(statusBarButtonTitle({ kind: 'character' }), /立绘/);
    const src = readFileSync(new URL('../src/ui/tab-cards.js', import.meta.url), 'utf8');
    assert.ok(!src.includes('暂不支持状态栏'), '世界卡的限制已经去掉');
    assert.ok(!/kind === 'world' \? '' : `<button[^`]*data-act="statusbar"/.test(src), '世界卡也有「状态栏」按钮');
    assert.ok(!/wantStatusBar = \(\) => [^;]*kind !== 'world'/.test(src));
});

test('世界/旁白卡：变量表说明讲 {{char}} 是旁白、群像放进记录；「填入主要角色」把项目角色加进初始条目（已有的不变，新条目按分组取默认值）', () => {
    assert.match(worldVarsHint('雾港'), /\{\{char\}\} 是旁白（雾港）/);
    assert.match(worldVarsHint(''), /旁白（旁白）/);
    const norm = normWorld().variables.find((v) => v.path === '主要角色');
    const res = seedRecordEntriesInto(norm, ['莉艾丽', '塞拉', '老周']);
    assert.deepEqual(res.added, ['塞拉', '老周']);
    assert.match(res.text, /加入 2 个角色：塞拉、老周/);
    assert.deepEqual(res.row.init['塞拉'], { 身份: '', 好感: 20, 服饰: { 上衣: '白衬衫', 下装: '' } });
    assert.equal(res.row.init['莉艾丽'].好感, 70, '已有条目不变');
    assert.deepEqual(normalizeStatusSpec({ variables: [res.row] }, { maxVars: 30 }).variables[0], res.row, '结果仍是规范化后的样子');
    const again = seedRecordEntriesInto(res.row, ['塞拉', 'a.b']);
    assert.deepEqual(again.added, []);
    assert.match(again.text, /已经有这些角色了/);
    assert.match(again.text, /a\.b/, '不能当键的名字说明原因');
});

test('generateStatusBarForCard：世界/旁白卡也能生成（写卡流程不再跳过）', async () => {
    const s = settings();
    s.statusBar.htmlMode = 'auto';
    const w = card({ kind: 'world', charName: '', data: { ...card().data, name: '雾港' } });
    installST(() => specReply(WORLD_SPEC));
    const logs = [];
    assert.equal(await generateStatusBarForCard(w, ctx(s, logs)), true, logs.map((x) => x[0]).join('\n'));
    assert.ok(w.statusBar.spec.variables.some((v) => v.type === 'record'));
    assert.match(statusBarTagHtml(w), /状态栏/);
    delete globalThis.SillyTavern;
});

// ---------------- (j) 记录字段里的分组 ----------------

test('recordFieldIssues：与 normalizeStatusSpec 的取舍一致（生效的项数 / 叶子数 / 被丢弃的项）', () => {
    const cases = [
        CAST.value,
        { type: 'object', fields: [{ key: '甲', type: 'string' }, { key: '甲', type: 'number' }, { key: 'a.b', type: 'string' }, { key: '', type: 'string' }] },
        { type: 'object', fields: [{ key: '组', type: 'object', fields: [] }, { key: '乙', type: 'enum', options: [] }] },
        { type: 'object', fields: [{ key: '组', type: 'object', fields: [{ key: '内', type: 'object', fields: [{ key: 'x' }] }, { key: '外', type: 'string' }] }] },
        { type: 'object', fields: Array.from({ length: RECORD_FIELD_MAX + 2 }, (_, k) => ({ key: `f${k}`, type: 'string' })) },
        { type: 'object', fields: [{ key: '组', fields: Array.from({ length: GROUP_FIELD_MAX + 2 }, (_, k) => ({ key: `g${k}`, type: 'number' })) }, { key: '组', type: 'string' }] },
    ];
    for (const value of cases) {
        const iss = recordFieldIssues(value);
        const norm = normalizeStatusSpec({ variables: [{ path: 'R', type: 'record', value, init: {} }] }, { maxVars: 99 }).variables[0];
        const kept = norm.value.type === 'object' ? norm.value.fields : [];
        assert.equal(iss.count, kept.length, JSON.stringify(value));
        if (kept.length) assert.equal(iss.leaves, variableLeafCount(norm), JSON.stringify(value));
        // 被标 err 的顶层项正好是规范化丢掉的
        const errTop = value.fields.map((_, j) => (iss.items[String(j)] || []).some((m) => m.level === 'err'));
        assert.equal(errTop.filter((x) => !x).length, kept.length, JSON.stringify(iss.items));
        for (const [j, f] of value.fields.entries()) {
            if (!Array.isArray(f.fields) || errTop[j]) continue;
            const ng = kept.find((x) => x.key === f.key);
            assert.equal(iss.groups[String(j)], ng.fields.length);
        }
    }
    const dup = recordFieldIssues(cases[1]);
    assert.match(dup.items['1'][0].msg, /已经有「甲」/);
    assert.match(dup.items['2'][0].msg, /字段名「a\.b」含有不允许的字符/);
    assert.match(dup.items['3'][0].msg, /字段名为空/);
    const g = recordFieldIssues(cases[2]);
    assert.match(g.items['0'][0].msg, /分组里没有可用的字段/);
    assert.deepEqual(g.items['1'], [{ level: 'warn', msg: '选项字段还没有选项：现在按文本处理' }]);
    assert.match(recordFieldIssues(cases[3]).items['0.0'][0].msg, /分组里不能再有分组/);
    assert.match(recordFieldIssues(cases[4]).items[String(RECORD_FIELD_MAX)][0].msg, new RegExp(`最多 ${RECORD_FIELD_MAX} 项`));
    assert.match(recordFieldIssues(cases[5]).items[`0.${GROUP_FIELD_MAX}`][0].msg, new RegExp(`最多 ${GROUP_FIELD_MAX} 个字段`));
    assert.deepEqual(recordFieldIssues({ type: 'object', fields: [] }).top, ['还没有字段：记录的值现在按文本处理，请添加字段']);
});

test('记录字段编辑：添加字段 / 分组（不重名，到上限就不加）、分组里加字段、删除（最后一项不能删）、上下移动、改类型和各项', () => {
    const value = clone(CAST.value);
    assert.equal(addRecordGroup(value), '3');
    assert.deepEqual(value.fields[3], { key: '分组1', type: 'object', fields: [{ key: '字段1', type: 'string', init: '' }] });
    assert.equal(addRecordField(value, '3'), '3.1');
    assert.equal(value.fields[3].fields[1].key, '字段2');
    assert.equal(addRecordField(value), '4');
    assert.equal(value.fields[4].key, '字段1');
    assert.equal(addRecordField(value, '0'), null, '不是分组');
    // 新加的分组规范化后保留（自带一个字段，不会被当成空分组丢掉）
    const norm = normalizeStatusSpec({ variables: [{ ...CAST, value }] }, { maxVars: 99 }).variables[0];
    assert.deepEqual(norm.value.fields.map((f) => f.key), ['身份', '好感', '服饰', '分组1', '字段1']);
    assert.equal(variableLeafCount(norm), 1 + 1 + 2 + 2 + 1);

    // 上限：分组 GROUP_FIELD_MAX 个字段、记录 RECORD_FIELD_MAX 项
    while (addRecordField(value, '3') !== null);
    assert.equal(value.fields[3].fields.length, GROUP_FIELD_MAX);
    while (addRecordField(value) !== null);
    assert.equal(value.fields.length, RECORD_FIELD_MAX);
    assert.equal(addRecordGroup(value), null);

    // 删除：分组里最后一个字段、记录最后一项不能删；整组可以删
    const v2 = { type: 'object', fields: [{ key: '组', type: 'object', fields: [{ key: '甲', type: 'string' }] }] };
    assert.equal(removeRecordField(v2, '0.0'), false);
    assert.equal(removeRecordField(v2, '0'), false, '记录至少一项');
    v2.fields.push({ key: '乙', type: 'string' });
    assert.equal(removeRecordField(v2, '0'), true);
    assert.deepEqual(v2.fields.map((f) => f.key), ['乙']);
    assert.equal(removeRecordField(v2, '9'), false);

    // 移动
    const v3 = clone(CAST.value);
    assert.equal(moveRecordField(v3, '2', -1), '1');
    assert.deepEqual(v3.fields.map((f) => f.key), ['身份', '服饰', '好感']);
    assert.equal(moveRecordField(v3, '1.0', 1), '1.1');
    assert.deepEqual(v3.fields[1].fields.map((f) => f.key), ['下装', '上衣']);
    assert.equal(moveRecordField(v3, '0', -1), null);
    assert.equal(moveRecordField(v3, '1.1', 1), null);

    // 改各项
    const v4 = clone(CAST.value);
    assert.ok(setRecordFieldProp(v4, '2.0', 'type', 'enum'));
    assert.deepEqual(v4.fields[2].fields[0], { key: '上衣', type: 'enum', options: ['选项一', '选项二'], init: '选项一' });
    assert.ok(setRecordFieldProp(v4, '2.0', 'options', '风衣 / 校服、礼服'));
    assert.deepEqual(v4.fields[2].fields[0].options, ['风衣', '校服', '礼服']);
    assert.ok(setRecordFieldProp(v4, '1', 'init', '35'));
    assert.equal(v4.fields[1].init, 35);
    assert.ok(setRecordFieldProp(v4, '1', 'stages', '0 冷淡，50 友好'));
    assert.deepEqual(v4.fields[1].stages, [{ min: 0, label: '冷淡' }, { min: 50, label: '友好' }]);
    assert.ok(setRecordFieldProp(v4, '1', 'integer', false));
    assert.equal(v4.fields[1].integer, false);
    assert.ok(setRecordFieldProp(v4, '0', 'type', 'boolean'));
    assert.ok(setRecordFieldProp(v4, '0', 'init', 'true'));
    assert.equal(v4.fields[0].init, true);
    assert.ok(setRecordFieldProp(v4, '2', 'key', ' 穿着 '));
    assert.equal(v4.fields[2].key, '穿着');
    assert.ok(setRecordFieldProp(v4, '2', 'label', ''));
    assert.equal('label' in v4.fields[2], false);
    assert.equal(setRecordFieldProp(v4, '2', 'type', 'number'), false, '分组只能改名字和显示名');
    assert.equal(setRecordFieldProp(v4, '7', 'key', 'x'), false);
    assert.deepEqual([parseFieldRef('2'), parseFieldRef('2.10'), parseFieldRef('x'), parseFieldRef('1.')], [[2, null], [2, 10], null, null]);
    const n4 = normalizeStatusSpec({ variables: [{ ...CAST, value: v4, init: {} }] }, { maxVars: 99 }).variables[0];
    assert.deepEqual(n4.value.fields[2], { key: '穿着', type: 'object', fields: [{ key: '上衣', type: 'enum', options: ['风衣', '校服', '礼服'], init: '风衣' }, { key: '下装', type: 'string', init: '' }] });
});

test('recordFieldsEditorHtml：字段一行一个、分组带边框，选择器 / aria / 计数 / 标红 / 上限禁用，保留 JSON 编辑框（data-sb-k="fields"）', () => {
    const html = recordFieldsEditorHtml(2, CAST.value, { remaining: 3, path: '主要角色' });
    assert.match(html, /data-sb-fields="2" role="group" aria-label="记录「主要角色」每个条目的字段"/);
    assert.match(html, /3 \/ 8 项（分组算一项）· 算 4 个变量 · 变量上限还剩 3 个/);
    assert.match(html, /data-sb-row="2" data-sb-fld="2\.1" data-sb-fp="key" value="下装"[^>]*aria-label="字段「服饰\.下装」：名字"/);
    assert.match(html, /data-sb-row="2" data-sb-fld="2" data-sb-fp="label" value="穿着"/);
    assert.match(html, /class="nl-sb-grp" data-sb-fld-item="2" role="group" aria-label="分组「服饰」"/);
    assert.match(html, /2 \/ 6 个字段/);
    assert.match(html, /data-act="sb-fld-add" data-sb-i="2" data-sb-fld="2"\s+title="在这个分组里加一个字段"/, '分组里的「添加字段」可用');
    assert.match(html, /data-act="sb-grp-add" data-sb-i="2" /);
    assert.match(html, /data-sb-row="2" data-sb-k="fields"/);
    assert.match(html, /data-sb-fp="stages" value="0 陌生，60 信任"/);
    assert.match(html, /data-act="sb-fld-up" data-sb-i="2" data-sb-fld="0" disabled/, '第一项不能上移');
    assert.ok(!/<details class="nl-sb-fields-json" open/.test(html));
    // 变量上限用完：添加按钮都禁用并说明
    const full = recordFieldsEditorHtml(0, CAST.value, { remaining: 0 });
    assert.match(full, /data-act="sb-fld-add" data-sb-i="0" data-sb-fld="" disabled title="已到变量上限/);
    assert.match(full, /data-act="sb-grp-add" data-sb-i="0" disabled/);
    // 有问题的项标红，JSON 原文保留并展开
    const bad = { type: 'object', fields: [{ key: 'a b', type: 'string' }, { key: '组', type: 'object', fields: [{ key: '甲', type: 'enum', options: [] }] }] };
    const bh = recordFieldsEditorHtml(0, bad, { json: '[{', jsonOpen: true });
    assert.match(bh, /class="nl-sb-fld is-bad" data-sb-fld-item="0"/);
    assert.match(bh, /aria-invalid="true"/);
    assert.match(bh, /字段名「a b」含有空白：这个字段没有生效/);
    assert.match(bh, /选项字段还没有选项/);
    assert.match(bh, /<details class="nl-sb-fields-json" open>/);
    assert.match(bh, />\[\{<\/textarea>/);
    assert.match(bh, /data-act="sb-fld-del" data-sb-i="0" data-sb-fld="1\.0" disabled title="分组至少要有一个字段/);
    // 只有一项时不能删
    const one = recordFieldsEditorHtml(0, { type: 'object', fields: [{ key: '甲', type: 'string' }] });
    assert.match(one, /data-act="sb-fld-del" data-sb-i="0" data-sb-fld="0" disabled title="记录至少要有一项/);
    // 名字里的特殊字符被转义
    assert.match(recordFieldsEditorHtml(0, { type: 'object', fields: [{ key: '"><b>', type: 'string' }] }), /value="&quot;&gt;&lt;b&gt;"/);
});

test('rowRangeWarnings：分组里的数字字段（最小值大于最大值、初始条目超出范围）也提示', () => {
    const row = clone(CAST);
    row.value.fields[2] = { key: '状态', type: 'object', fields: [{ key: '体力', type: 'number', min: 10, max: 0, init: 5 }, { key: '心理', type: 'string' }] };
    row.init = { 莉艾丽: { 状态: { 体力: 99 } } };
    const norm = normalizeStatusSpec({ variables: [row] }, { maxVars: 99 }).variables[0];
    const w = rowRangeWarnings(row, norm);
    assert.ok(w.some((m) => m.startsWith('字段「状态.体力」的最小值 10 大于最大值 0')), w.join('\n'));
    assert.ok(w.some((m) => m.includes('初始条目「莉艾丽」的「状态.体力」99 超出范围 0 ~ 10：现在按 10 生效')), w.join('\n'));
});

test('exampleReply：记录有分组时改第一个条目分组里的字段，生成的回复能完整应用', () => {
    const spec = normWorld();
    const reply = exampleReply(spec);
    assert.match(reply, /"path": "\/主要角色\/莉艾丽\/服饰\/上衣"/);
    const r = applyReplyToState(buildInitialState(spec), reply, { spec });
    assert.deepEqual(r.errors, []);
    assert.equal(r.applied, r.ops.length);
    assert.equal(r.state.主要角色.莉艾丽.服饰.上衣, '示例更新');
    // 没有初始条目的记录：插入一个新条目（分组按字段随机）
    const s2 = normalizeStatusSpec({ variables: [{ ...CAST, init: {} }] }, { maxVars: 99 });
    const r2 = applyReplyToState(buildInitialState(s2), exampleReply(s2), { spec: s2 });
    assert.deepEqual(r2.errors, []);
    assert.equal(typeof r2.state.主要角色.新条目.服饰, 'object');
});

// ---------------- (k) 立绘 ----------------

const URL_A = 'https://img.example.com/a.png';
const URL_B = 'https://img.example.com/b.webp';
const URL_C = 'https://img.example.com/c.jpg';
const PORTRAITS = {
    characters: {
        莉艾丽: [{ url: URL_A, label: '日常' }, { url: URL_B, when: { path: '好感', op: '>=', value: 60 } }, { url: URL_C, when: { path: '好感', op: '>=', value: 90 } }],
        主角: [{ url: URL_A }],
    },
    pools: [{ record: 'NPC', field: '阵营', pools: { 敌对: [URL_B, URL_C] }, fallback: [URL_A] }],
};

test('立绘草稿：normalizePortraits ⇄ 草稿往返不变；草稿里的空行、空取值不进配置', () => {
    const p = normalizePortraits(PORTRAITS);
    const d = portraitDraftFrom(p);
    assert.deepEqual(d.chars[0].images[1], { url: URL_B, label: '', when: { path: '好感', op: '>=', value: '60' } });
    assert.deepEqual(d.chars[0].images[0].when, { path: '', op: '>=', value: '' });
    assert.deepEqual(d.pools[0], { record: 'NPC', field: '阵营', values: [{ value: '敌对', urls: `${URL_B}\n${URL_C}` }], fallback: URL_A });
    assert.deepEqual(normalizePortraits(portraitDraftToRaw(d)), p);
    d.chars[0].images.push({ url: '', label: '', when: { path: '', op: '>=', value: '' } });
    d.pools[0].values.push({ value: '', urls: '' });
    assert.deepEqual(normalizePortraits(portraitDraftToRaw(d)), p);
    assert.deepEqual(portraitDraftFrom(null), { chars: [], pools: [] });
});

test('portraitWhenProblem：与 normalizePortraits 保留解锁条件的判断一致', () => {
    const whens = [
        { path: '', op: '>=', value: '' }, { path: '好感', op: '>=', value: '60' }, { path: '好感', op: '<=', value: '' },
        { path: '好感', op: '>=', value: 'abc' }, { path: '心情', op: '==', value: '' }, { path: '心情', op: '==', value: '开心' },
        { path: 'a.b.c.d.e', op: '>=', value: '1' }, { path: 'a..b', op: '>=', value: '1' }, { path: '/世界/章节', op: '>=', value: '3' },
        { path: 'x"y', op: '>=', value: '1' }, { path: '好感', op: '!=', value: '1' }, { path: '__proto__', op: '>=', value: '1' },
    ];
    for (const w of whens) {
        const n = normalizePortraits({ characters: { 甲: [{ url: URL_A, when: w.path ? w : undefined }] } });
        const keptWhen = !!n.characters['甲'][0].when;
        const problem = portraitWhenProblem(w);
        assert.equal(!problem, keptWhen || !w.path, `${JSON.stringify(w)} → ${problem}`);
    }
    assert.match(portraitWhenProblem({ path: '好感', op: '>=', value: 'x' }), /要和数字比较/);
});

test('portraitDraftIssues：标红的正好是规范化会丢掉的（地址、名字、图池），解锁条件无效只是提醒', () => {
    const spec = normWorld();
    const d = {
        chars: [
            { name: '莉艾丽', images: [{ url: URL_A, when: { path: '' } }, { url: 'ftp://x/y.png' }, { url: '' }, { url: URL_B, when: { path: '好感', op: '>=', value: '高' } }] },
            { name: 'a/b', images: [{ url: URL_A }] },
            { name: '莉艾丽', images: [{ url: URL_C }] },
        ],
        pools: [
            { record: 'NPC', field: '阵营', values: [{ value: '敌对', urls: `${URL_A}\njavascript:alert(1)` }, { value: '', urls: URL_B }, { value: '敌对', urls: URL_C }], fallback: '' },
            { record: '', field: '', values: [{ value: '友好', urls: URL_A }], fallback: '' },
            { record: '不存在', field: '阵营', values: [{ value: '友好', urls: URL_A }], fallback: '' },
            { record: 'NPC', field: '阵营', values: [], fallback: URL_A },
            { record: 'NPC', field: '好感', values: [], fallback: '' },
        ],
    };
    const iss = portraitDraftIssues(d, spec);
    const lv = (x) => x.level;
    assert.deepEqual(iss.chars[0].images.map(lv), ['', 'err', 'empty', 'warn']);
    assert.match(iss.chars[0].images[1].msg, /只支持 http/);
    assert.match(iss.chars[0].images[3].msg, /要和数字比较：这个解锁条件不会保存/);
    assert.equal(iss.chars[1].name.level, 'err');
    assert.equal(iss.chars[2].name.level, 'warn');
    assert.match(iss.chars[2].name.msg, /合在一起/);
    assert.deepEqual(iss.pools[0].msgs, []);
    assert.match(iss.pools[0].values[0][0].msg, /第 2 行/);
    assert.match(iss.pools[0].values[1][0].msg, /先填字段的值/);
    assert.match(iss.pools[0].values[2][0].msg, /前面已经有「敌对」/);
    assert.match(iss.pools[1].msgs[0].msg, /先选一个记录变量/);
    assert.deepEqual(iss.pools[2].msgs.map(lv), ['warn']);
    assert.match(iss.pools[2].msgs[0].msg, /变量表里没有记录变量「不存在」/);
    assert.match(iss.pools[3].msgs[0].msg, /前面已经有按「NPC · 阵营」取图的图池/);
    assert.match(iss.pools[4].msgs[0].msg, /还没有可用的图片/);
    // 与规范化对照：标红的角色 / 图片 / 图池都被丢掉，没标红的都留下
    const warnings = [];
    const n = normalizePortraits(portraitDraftToRaw(d), { warnings, spec });
    assert.deepEqual(Object.keys(n.characters), ['莉艾丽']);
    assert.deepEqual(n.characters['莉艾丽'].map((x) => x.url), [URL_A, URL_B, URL_C]);
    assert.equal(n.characters['莉艾丽'][1].when, undefined, '无效的解锁条件不保存');
    assert.deepEqual(n.pools.map((p) => [p.record, p.field]), [['NPC', '阵营'], ['不存在', '阵营']]);
    assert.deepEqual(n.pools[0].pools['敌对'], [URL_A, URL_C]);
    assert.equal(iss.errors, 1 + 1 + 1 + 1 + 1 + 1 + 1, '坏地址 ×2、坏名字、空取值、没选记录、重复图池、没有图片');
    assert.equal(portraitDraftIssues({ chars: [], pools: [] }).errors, 0);
});

test('portraitNewNameProblem / portraitDisplayNote / portraitThumbHtml', () => {
    const d = { chars: [{ name: '莉艾丽', images: [] }], pools: [] };
    assert.equal(portraitNewNameProblem(d, ' '), '请输入名字');
    assert.match(portraitNewNameProblem(d, '莉艾丽'), /已经在下面了/);
    assert.match(portraitNewNameProblem(d, 'a.b'), /不允许的字符/);
    assert.equal(portraitNewNameProblem(d, '塞拉'), '');
    const many = { chars: Array.from({ length: PORTRAIT_LIMITS.characters }, (_, k) => ({ name: `c${k}`, images: [] })), pools: [] };
    assert.match(portraitNewNameProblem(many, '新'), /最多/);

    assert.equal(portraitDisplayNote({ mode: 'raw', html: '<body></body>' }).level, 'warn');
    assert.equal(portraitDisplayNote({ mode: 'auto', html: 'x' }).level, 'ok');
    assert.equal(portraitDisplayNote({ mode: 'bind', html: '' }).level, 'ok');
    assert.equal(portraitDisplayNote({ mode: 'bind', html: '<div data-nl-text="a"></div>' }).level, 'warn');
    assert.equal(portraitDisplayNote({ mode: 'bind', html: '<button data-nl-portrait-next="">换</button>' }).level, 'warn', '只有换图按钮不算');
    const ok = portraitDisplayNote({ mode: 'bind', html: '<img data-nl-portrait=""><button data-nl-portrait-next="">换</button>' });
    assert.equal(ok.level, 'ok');
    assert.match(ok.text, /换图按钮/);

    const t = portraitThumbHtml(URL_A, '莉艾丽', { alt: '第 1 张' });
    assert.match(t, /data-state="loading"/);
    assert.match(t, /<img data-sb-thumb src="https:\/\/img\.example\.com\/a\.png" alt="第 1 张" referrerpolicy="no-referrer" loading="lazy"/);
    assert.match(t, /aria-hidden="true">莉</);
    const bad = portraitThumbHtml('javascript:alert(1)', '莉艾丽');
    assert.match(bad, /data-state="bad"/);
    assert.ok(!bad.includes('<img'), '不合法的地址不放进 <img>');
    assert.match(portraitThumbHtml('', 'x', { size: 'sm' }), /class="nl-sb-thumb nl-sb-thumb-sm" data-sb-thumb-wrap data-state="empty"/);
    assert.equal(portraitUrlProblem(URL_A), '');
});

test('portraitsPanelHtml：候选角色（记录条目 + 固定分组）、默认显示 / 未解锁、缩略图、图池、界面不显示立绘时提醒', () => {
    const spec = normWorld();
    const sample = buildInitialState(spec); // 莉艾丽 好感 70：解锁到第 2 张
    const p = normalizePortraits(PORTRAITS, { spec });
    const html = portraitsPanelHtml({ draft: portraitDraftFrom(p), spec, sample, portraits: p, sb: { mode: 'bind', html: '<div data-nl-text="世界.时间"></div>' } });
    assert.match(html, /data-sb-pt-display/);
    assert.match(html, /nl-sb-note-warn" data-sb-pt-display/, '当前界面没有立绘位置');
    // 候选：卡尔（记录条目）、世界（固定分组）没配置的出现在按钮里；已配置的莉艾丽 / 主角不出现
    assert.match(html, /data-act="sb-pt-add-name" data-sb-name="卡尔" title="「主要角色」里的条目"/);
    assert.match(html, /data-act="sb-pt-add-name" data-sb-name="世界" title="固定分组"/);
    assert.ok(!/data-sb-name="莉艾丽"/.test(html));
    // 莉艾丽：第 2 张是默认，第 3 张未解锁
    const row = (ci, ii) => html.split(`data-sb-pt-row="${ci}.${ii}"`)[1].split('data-sb-pt-row=')[0];
    assert.match(row(0, 1), /默认显示/);
    assert.ok(!/默认显示/.test(row(0, 0)));
    assert.match(row(0, 2), /未解锁/);
    assert.match(html, /「主要角色」里的条目 · 3 张 · 默认显示第 2 张/);
    assert.match(html, /固定分组 · 1 张 · 默认显示第 1 张/);
    assert.match(html, /data-sb-pt="whenPath" data-sb-pt-c="0" data-sb-pt-i="1" list="nl-sb-pt-paths-0" value="好感"/);
    assert.match(html, /<datalist id="nl-sb-pt-paths-0"><option value="身份"><\/option><option value="好感"><\/option><option value="服饰\.上衣"><\/option>/);
    assert.match(html, /<datalist id="nl-sb-pt-paths-1"><option value="声望"><\/option>/, '固定分组的相对路径');
    assert.match(html, /<select class="nl-input nl-inline" data-sb-pt="whenOp"[^>]*><option value="&gt;=" selected>≥ 至少/);
    assert.equal((html.match(/referrerpolicy="no-referrer"/g) || []).length, (html.match(/<img /g) || []).length, '每张缩略图都不带 referrer');
    // 图池：记录下拉、按字段下拉、取值（选项字段给出候选）、兜底
    assert.match(html, /data-sb-pool="record" data-sb-pool-p="0" aria-label="图池用于哪个记录"><option value="主要角色"\s*>主要角色<\/option><option value="NPC" selected>NPC/);
    assert.match(html, /data-sb-pool="field" data-sb-pool-p="0" aria-label="按哪个字段取图"><option value="阵营" selected>/);
    assert.match(html, /<datalist id="nl-sb-pool-vals-0"><option value="友好"><\/option><option value="敌对"><\/option><\/datalist>/);
    assert.match(html, /data-sb-pool="fallback" data-sb-pool-p="0"[^>]*>https:\/\/img\.example\.com\/a\.png<\/textarea>/);
    assert.match(html, /data-act="sb-pool-add" >/);
    assert.match(html, /data-act="sb-goto-preview"/);
    // 每个 id 只出现一次
    const ids = [...html.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]);
    assert.equal(new Set(ids).size, ids.length, ids.join(','));

    // 内置排版：显示立绘；没有记录变量时不能加图池；空草稿显示空状态
    const empty = portraitsPanelHtml({ draft: { chars: [], pools: [] }, spec: normalizeStatusSpec(SPEC), sb: { mode: 'auto' } });
    assert.match(empty, /nl-ok nl-small" data-sb-pt-display/);
    assert.match(empty, /还没有立绘/);
    assert.match(empty, /data-act="sb-pool-add" disabled/);
    assert.match(empty, /data-sb-name="世界"/);

    // 草稿里有问题：标红、给出原因，名字被转义
    const bad = portraitsPanelHtml({ draft: { chars: [{ name: '<b>', images: [{ url: 'http://a b' }] }], pools: [] }, spec, sb: { mode: 'auto' }, newName: '"x', newMsg: '请输入名字' });
    assert.match(bad, /class="nl-sb-pt-char is-bad"/);
    assert.match(bad, /value="&lt;b&gt;"/);
    assert.ok(!bad.includes('<b>'));
    assert.match(bad, /aria-invalid="true"/);
    assert.match(bad, /data-sb-pt-bad>/);
    assert.match(bad, /data-sb-pt-new list="nl-sb-pt-cands" value="&quot;x"/);
    assert.match(bad, /data-sb-pt-new-msg role="alert">请输入名字</);
});

// ---------------- v0.12 集成：模板自带的变量上限、模板带立绘 ----------------

test('模板自带上限（「多人群像」15）：模板库 / 套用对话框按 templateVarCap 比较；套用 + AI 调整保留全部变量；变量表按 statusBarVarCap 校验', async () => {
    const s = settings();
    s.statusBar.maxVars = 12; // 老用户的设置：v0.15 之前的默认上限 12
    const ens = BUILTIN_STATUSBAR_TEMPLATES.find((t) => t.id === 'builtin_ensemble');
    assert.deepEqual(templateCapInfo(ens, s), { n: 15, cap: 15, base: 12, over: false, raised: true }, '不再标「超过上限 12」');
    const cyber = BUILTIN_STATUSBAR_TEMPLATES.find((t) => t.id === 'builtin_cyberpunk');
    assert.equal(templateCapInfo(cyber, s).raised, false);
    s.statusBar.maxVars = 5;
    assert.deepEqual(templateCapInfo(cyber, s).over, true, '没有自带上限的模板仍按设置比较');
    s.statusBar.maxVars = 20;
    assert.deepEqual(templateCapInfo(ens, s), { n: 15, cap: 20, base: 20, over: false, raised: false });
    s.statusBar.maxVars = 12;
    assert.deepEqual(templateCapInfo({ name: '只有界面', html: '<div></div>' }, s), { n: 0, cap: 12, base: 12, over: false, raised: false });

    // 对话框的套用流程（沿用结构 + 让 AI 调整，默认勾选）：AI 照抄路径，NPC 不会被截掉
    const c = seeded(s);
    installST(({ text }) => {
        const kept = JSON.parse(text.match(/<变量表>\n([\s\S]*?)\n<\/变量表>/)[1]);
        return specReply({ variables: kept.map((v) => ({ path: v.path, init: v.init, check: ['按剧情更新'] })) });
    });
    const warnings = [];
    const r = await applyTemplateToCard(c, ctx(s), ens, 'structure', { ai: true, warnings });
    assert.equal(r.ai, true);
    assert.deepEqual(c.statusBar.spec.variables.map((v) => v.path), ['世界.时间', '世界.地点', '主角.身份', '主要角色', 'NPC']);
    assert.ok(warnings.some((w) => w.includes('按模板自带的上限 15 保留全部变量')), warnings.join('\n'));
    assert.ok(!warnings.some((w) => /丢弃|没有的路径/.test(w)), warnings.join('\n'));
    assert.deepEqual(c.statusBar.lint, { errors: [], warnings: [] });
    assert.equal(c.statusBar.templateId, 'builtin_ensemble');
    assert.equal(c.statusBar.prev.spec.variables.length, 3, '撤销回到套用前');
    delete globalThis.SillyTavern;

    // 对话框源码：变量表校验 / 计数 / 字段编辑器余量用 statusBarVarCap（套用后每次现取），AI 整体设计的说明用设置里的上限
    const src = readFileSync(new URL('../src/ui/statusbar-dialog.js', import.meta.url), 'utf8');
    assert.match(src, /let seenLeaves = countSpecLeaves\(sb\.spec\);\n\s+const tableCap = \(\) => statusBarVarCap\(card, c\.settings, \{ leaves: seenLeaves \}\);/);
    // 变量表被整个换掉（AI 生成、撤销、套用模板都走 resetDraft）时，按换上来的变量数取最大
    assert.match(src, /const resetDraft = \(\) => \{\n\s+seenLeaves = Math\.max\(seenLeaves, countSpecLeaves\(sb\.spec\)\);/);
    assert.match(src, /normalizeStatusSpec\(\{ title: st\.title, variables: st\.rows \}, \{ charName, maxVars: tableCap\(\), warnings \}\)/);
    assert.doesNotMatch(src, /c\.settings\.statusBar\?\.maxVars/);
    assert.match(src, /const PREV_KEYS = \[[^\]]*'portraits'\]/, '撤销也换回模板带来的立绘');
});

test('存为模板：卡上有立绘时多一个「连同立绘设置」（默认不勾）；没有立绘时不显示', () => {
    assert.equal(templatePortraitsOptionText(null), '');
    assert.equal(templatePortraitsOptionText(normalizePortraits({})), '');
    const p = normalizePortraits({
        characters: { 林小雨: ['https://img.example.com/a.png'], 周默: ['https://img.example.com/b.png'] },
        pools: [{ record: 'NPC', field: '阵营', pools: { 守卫: ['https://img.example.com/g.png'] } }],
    });
    assert.equal(templatePortraitsOptionText(p), '连同立绘设置（2 个角色、1 个图池；图片地址会存进模板，导出模板时也会带上）');
    assert.match(templatePortraitsOptionText(normalizePortraits({ pools: p.pools })), /^连同立绘设置（1 个图池；/);
    const src = readFileSync(new URL('../src/ui/statusbar-dialog.js', import.meta.url), 'utf8');
    assert.match(src, /portraitsOption \? `<label><input type="checkbox" data-f="portraits">/, '勾选框默认不勾');
    assert.match(src, /templateFromStatusBar\(card, r\)/, '对话框结果（含 portraits）直接交给 templateFromStatusBar');
});

// ---------------- v0.12 复查修正 ----------------

test('字段改名：顶层字段、整个分组、分组里的字段改名后，初始条目和示例数据里的值跟着搬过去（新名字已有值的不覆盖）', () => {
    // 模拟对话框的流程：取改名前的名字 → setRecordFieldProp → 按前后名字搬数据 → 规范化（commitRows）
    const rename = (row, samples, ref, newKey) => {
        const before = recordFieldNameAt(row.value, ref);
        assert.ok(setRecordFieldProp(row.value, ref, 'key', newKey));
        const after = recordFieldNameAt(row.value, ref);
        let n = renameRecordEntryField(row.init, before.key, after.key, after.group);
        for (const s of samples) n += renameRecordEntryField(s['主要角色'], before.key, after.key, after.group);
        return n;
    };
    const row = clone(normWorld().variables.find((v) => v.path === '主要角色'));
    row.init['莉艾丽'].服饰.上衣 = '风衣';
    const sample = { 主要角色: clone(row.init) };
    sample['主要角色']['卡尔'].身份 = '侦探';

    // 顶层字段：身份 → 职业
    assert.deepEqual(recordFieldNameAt(row.value, '0'), { key: '身份', group: null });
    assert.equal(rename(row, [sample], '0', '职业'), 4, '初始条目 2 个 + 示例 2 个');
    let norm = normalizeStatusSpec({ variables: [row] }, { maxVars: 30 }).variables[0];
    assert.equal(norm.init['莉艾丽'].职业, '学生');
    assert.deepEqual(Object.keys(row.init['莉艾丽']), ['职业', '好感', '服饰'], '键的顺序不变');
    assert.equal(sample['主要角色']['卡尔'].职业, '侦探');
    assert.ok(!('身份' in sample['主要角色']['卡尔']));

    // 整个分组：服饰 → 衣着（组里的值整个搬过去）
    assert.deepEqual(recordFieldNameAt(row.value, '2'), { key: '服饰', group: null });
    rename(row, [sample], '2', '衣着');
    norm = normalizeStatusSpec({ variables: [row] }, { maxVars: 30 }).variables[0];
    assert.deepEqual(norm.init['莉艾丽'].衣着, { 上衣: '风衣', 下装: '' });
    assert.equal(sample['主要角色']['莉艾丽'].衣着.上衣, '风衣');

    // 分组里的字段：衣着.上衣 → 外套
    assert.deepEqual(recordFieldNameAt(row.value, '2.0'), { key: '上衣', group: '衣着' });
    rename(row, [sample], '2.0', '外套');
    norm = normalizeStatusSpec({ variables: [row] }, { maxVars: 30 }).variables[0];
    assert.equal(norm.init['莉艾丽'].衣着.外套, '风衣');
    assert.equal(norm.init['卡尔'].衣着.外套, '白衬衫');
    assert.deepEqual(sample['主要角色']['莉艾丽'].衣着, { 外套: '风衣', 下装: '' });

    // 新名字已经有值：不覆盖（旧值留在原处，交给规范化处理）
    const entries = { 甲: { 身份: '旧', 职业: '已有' }, 乙: { 身份: '只有旧的' }, 丙: '不是对象' };
    assert.equal(renameRecordEntryField(entries, '身份', '职业'), 1);
    assert.deepEqual(entries, { 甲: { 身份: '旧', 职业: '已有' }, 乙: { 职业: '只有旧的' }, 丙: '不是对象' });
    // 不搬的情况：名字没变、新名字为空、原型名、不是对象、分组不存在
    assert.equal(renameRecordEntryField(entries, '职业', '职业'), 0);
    assert.equal(renameRecordEntryField(entries, '职业', ''), 0);
    assert.equal(renameRecordEntryField(entries, '职业', '__proto__'), 0);
    assert.equal(renameRecordEntryField(null, 'a', 'b'), 0);
    assert.equal(renameRecordEntryField(entries, '职业', '岗位', '没有这个分组'), 0);
    assert.equal(Object.getPrototypeOf(entries['乙']), Object.prototype);
    assert.equal(recordFieldNameAt(row.value, '9'), null);

    // 对话框：改名时在 commitRows 之前搬数据（初始条目 + 编辑中的示例 + 卡上保存的示例）
    const src = readFileSync(new URL('../src/ui/statusbar-dialog.js', import.meta.url), 'utf8');
    assert.match(src, /if \(before\) migrateFieldRename\(v, field, before, recordFieldNameAt\(v\.value, ref\)\);[\s\S]{0,400}?commitRows\(\);/);
    assert.match(src, /for \(const s of new Set\(\[st\.sample, sb\.sample\]\)\)/);
});

test('「填入主要角色」只在主要角色的记录那一行（castRecordPath），NPC / 物品记录没有；角色卡没有', () => {
    const spec = normWorld();
    assert.equal(seedCastAllowed(true, spec, '主要角色'), true);
    assert.equal(seedCastAllowed(true, spec, 'NPC'), false);
    assert.equal(seedCastAllowed(true, spec, '世界.时间'), false);
    assert.equal(seedCastAllowed(true, spec, ''), false, '没生效的行');
    assert.equal(seedCastAllowed(false, spec, '主要角色'), false, '角色卡没有这个按钮');
    // 没有叫「主要角色」的记录时取第一个按角色名记、又不是 NPC 的记录；物品记录永远没有
    const other = normalizeStatusSpec({
        variables: [
            { path: '背包', type: 'record', keyDesc: '物品名', value: { type: 'number', min: 0, max: 99 }, init: {} },
            { path: 'NPC', type: 'record', keyDesc: '角色名', value: { type: 'string' }, init: {} },
            { path: '同伴', type: 'record', keyDesc: '角色名', value: { type: 'string' }, init: {} },
        ],
    }, { maxVars: 30 });
    assert.equal(seedCastAllowed(true, other, '同伴'), true);
    assert.equal(seedCastAllowed(true, other, '背包'), false);
    assert.equal(seedCastAllowed(true, other, 'NPC'), false);
    const src = readFileSync(new URL('../src/ui/statusbar-dialog.js', import.meta.url), 'utf8');
    assert.match(src, /const seed = seedCastAllowed\(world, sb\.spec, info\?\.ok \? info\.norm\?\.path : ''\)/, '按钮只放在主要角色那一行');
    assert.match(src, /if \(!seedCastAllowed\(world, r\.spec, norm\.path\)\)/, '点按钮时再挡一次');
});

test('立绘分页删除之后的焦点：下一项 → 上一项 → 这一组的添加 → 外层 → 添加名字 / 分页按钮（不会掉到 body 上）', () => {
    // 删除之后的草稿
    const d = {
        chars: [{ name: '甲', images: [{ url: URL_A }, { url: URL_B }] }, { name: '乙', images: [] }],
        pools: [{ record: 'NPC', field: '阵营', values: [{ value: '敌对', urls: URL_A }], fallback: '' }],
    };
    const tail = ['[data-sb-pt-new]', '[data-act="sb-pt-add-char"]', '[data-act="sb-tab"][data-tab="portraits"]'];
    // 删了 甲 的第 0 张：现在的第 0 张（原来的下一张）
    assert.deepEqual(portraitDeleteFocus('sb-pt-img-del', d, { ci: 0, ii: 0 }).slice(0, 2), [
        '[data-act="sb-pt-img-del"][data-sb-pt-c="0"][data-sb-pt-i="0"]',
        '[data-act="sb-pt-add-img"][data-sb-pt-c="0"]',
    ]);
    // 删的是最后一张：上一张
    assert.equal(portraitDeleteFocus('sb-pt-img-del', d, { ci: 0, ii: 2 })[0], '[data-act="sb-pt-img-del"][data-sb-pt-c="0"][data-sb-pt-i="1"]');
    // 删光了：这个角色的「添加图片」
    assert.deepEqual(portraitDeleteFocus('sb-pt-img-del', d, { ci: 1, ii: 0 }), [
        '[data-act="sb-pt-add-img"][data-sb-pt-c="1"]', '[data-act="sb-pt-del-char"][data-sb-pt-c="1"]', ...tail,
    ]);
    // 删角色：下一个角色 / 上一个角色 / 添加名字
    assert.equal(portraitDeleteFocus('sb-pt-del-char', d, { ci: 1 })[0], '[data-act="sb-pt-del-char"][data-sb-pt-c="1"]');
    assert.equal(portraitDeleteFocus('sb-pt-del-char', d, { ci: 2 })[0], '[data-act="sb-pt-del-char"][data-sb-pt-c="1"]');
    assert.deepEqual(portraitDeleteFocus('sb-pt-del-char', { chars: [], pools: [] }, { ci: 0 }), tail);
    // 删图池：下一个 / 上一个 / 「添加图池」
    assert.deepEqual(portraitDeleteFocus('sb-pool-del', { chars: [], pools: [] }, { pi: 0 }), ['[data-act="sb-pool-add"]', ...tail]);
    assert.equal(portraitDeleteFocus('sb-pool-del', d, { pi: 1 })[0], '[data-act="sb-pool-del"][data-sb-pool-p="0"]');
    // 删取值：下一个 / 上一个 / 「添加取值」 / 图池的删除
    assert.equal(portraitDeleteFocus('sb-pool-val-del', d, { pi: 0, vi: 0 })[0], '[data-act="sb-pool-val-del"][data-sb-pool-p="0"][data-sb-pool-v="0"]');
    assert.deepEqual(portraitDeleteFocus('sb-pool-val-del', d, { pi: 0, vi: 1 }).slice(0, 3), [
        '[data-act="sb-pool-val-del"][data-sb-pool-p="0"][data-sb-pool-v="0"]', '[data-act="sb-pool-val-add"][data-sb-pool-p="0"]', '[data-act="sb-pool-del"][data-sb-pool-p="0"]',
    ]);
    // 每个选择器都能在面板 HTML 里找到对应的元素（分页按钮在分页条里）
    const html = portraitsPanelHtml({ draft: d, spec: normWorld(), sb: { mode: 'auto' } }) + statusTabsHtml('portraits');
    const tags = html.split('<');
    for (const act of ['sb-pt-img-del', 'sb-pt-del-char', 'sb-pool-del', 'sb-pool-val-del']) {
        for (const sel of portraitDeleteFocus(act, d, { ci: 0, ii: 0, pi: 0, vi: 0 })) {
            const attrs = [...sel.matchAll(/\[([\w-]+)(?:="([^"]*)")?\]/g)];
            const hit = tags.some((tag) => attrs.every(([, a, v]) => (v === undefined ? new RegExp(`\\s${a}[\\s=>]`).test(tag) : tag.includes(`${a}="${v}"`))));
            assert.ok(hit, `${act}: ${sel}`);
        }
    }
    // 对话框：四种删除重绘后都调用 focusAfterPortraitDelete
    const src = readFileSync(new URL('../src/ui/statusbar-dialog.js', import.meta.url), 'utf8');
    assert.equal((src.match(/renderAll\(\);\n\s+return focusAfterPortraitDelete\(act, \{/g) || []).length, 4);
});

test('图池地址：只按换行拆、整行检查（中间有空格的地址整行标红，不会被拆开存下前半截），提示写「第 N 行」', () => {
    assert.deepEqual(urlLines(`${URL_A}\n\n  ${URL_B}  \r\nhttps://img.example.com/x y.png\r${URL_C}`), [
        { line: 1, url: URL_A }, { line: 3, url: URL_B }, { line: 4, url: 'https://img.example.com/x y.png' }, { line: 5, url: URL_C },
    ]);
    const d = { chars: [], pools: [{ record: 'NPC', field: '阵营', values: [{ value: '敌对', urls: `${URL_A}\n\nhttps://img.example.com/x y.png\n${URL_B}` }], fallback: `ftp://a/b.png\n${URL_C}` }] };
    const iss = portraitDraftIssues(d, normWorld());
    assert.equal(iss.pools[0].values[0].length, 1);
    assert.match(iss.pools[0].values[0][0].msg, /^第 3 行：地址里有空白/);
    assert.match(iss.pools[0].fallback[0].msg, /^第 1 行：只支持 http/);
    assert.equal(iss.errors, 2);
    const raw = portraitDraftToRaw(d);
    assert.deepEqual(raw.pools[0].pools['敌对'], [URL_A, 'https://img.example.com/x y.png', URL_B], '整行交给规范化，不拆开');
    const n = normalizePortraits(raw, { spec: normWorld() });
    assert.deepEqual(n.pools[0].pools['敌对'], [URL_A, URL_B], '不合法的整行不保存，也不会留下半截地址');
    assert.deepEqual(n.pools[0].fallback, [URL_C]);
    // 缩略图条按行取，不会把半截地址当成图片
    const html = portraitsPanelHtml({ draft: d, spec: normWorld(), sb: { mode: 'auto' } });
    assert.ok(!html.includes('src="https://img.example.com/x"'));
});

test('预览发来的 nl-store：经 portraitChoiceProblem 把关，只记本卡前缀的键 + 本卡配置的立绘地址（或 null），条数有上限', () => {
    const c = card({ id: 'card_store' });
    const sb = ensureStatusBar(c, settings());
    sb.spec = normWorld();
    sb.portraits = normalizePortraits(PORTRAITS, { spec: sb.spec });
    const storage = memoryStorage();
    const k = (name) => `nl-sb:card_store:${name}`;
    assert.equal(acceptPreviewStore(c, { key: k('莉艾丽'), value: URL_B }, storage), '');
    assert.equal(storage.getItem(k('莉艾丽')), URL_B);
    // 不是本卡配置的地址、别的卡的键、undefined、超长 data:、对象：一律拒绝，存储不变
    assert.match(acceptPreviewStore(c, { key: k('莉艾丽'), value: 'https://evil.example.com/x.png' }, storage), /不是这张卡配置的立绘地址/);
    assert.match(acceptPreviewStore(c, { key: 'nl-sb:other:莉艾丽', value: URL_A }, storage), /不是这张卡的立绘记录/);
    assert.match(acceptPreviewStore(c, { key: k('莉艾丽') }, storage), /立绘地址无效/, '没有 value 不算删除');
    assert.notEqual(acceptPreviewStore(c, { key: k('x'), value: `data:image/png;base64,${'A'.repeat(40000)}` }, storage), '');
    assert.notEqual(acceptPreviewStore(c, { key: { startsWith: () => true }, value: URL_A }, storage), '');
    assert.notEqual(acceptPreviewStore(c, null, storage), '');
    assert.equal(storage.getItem(k('莉艾丽')), URL_B);
    // null：回到默认，删掉这条
    assert.equal(acceptPreviewStore(c, { key: k('莉艾丽'), value: null }, storage), '');
    assert.equal(storage.getItem(k('莉艾丽')), null);
    // 界面代码造出大量不同的名字：最多记 STORE_ENTRIES_MAX 条，不会把酒馆页面的本地存储塞满
    let ok = 0;
    for (let i = 0; i < STORE_ENTRIES_MAX + 50; i++) if (!acceptPreviewStore(c, { key: k(`n${i}`), value: URL_A }, storage)) ok++;
    assert.equal(ok, STORE_ENTRIES_MAX);
    assert.equal(storage.map.size, STORE_ENTRIES_MAX);
    // 对话框的消息处理只走这一个入口，并带上预览正在显示的数据（只认预览里能换图的名字）
    const src = readFileSync(new URL('../src/ui/statusbar-dialog.js', import.meta.url), 'utf8');
    assert.match(src, /d\.type === 'nl-store'\) \{[^}]*const problem = acceptPreviewStore\(card, d, undefined, \{ stat: ensureSample\(\) \}\);/);
    assert.equal((src.match(/writePortraitChoice\(/g) || []).length, 1, '只在 acceptPreviewStore 里、把关之后写');
});

test('预览发来的 nl-store 带着预览的数据（opt.stat）：造出来的名字一个都不记，不会占满条数上限、挡住正常的换图', () => {
    const c = card({ id: 'card_store_stat' });
    const sb = ensureStatusBar(c, settings());
    sb.spec = normWorld();
    sb.portraits = normalizePortraits(PORTRAITS, { spec: sb.spec });
    const stat = { 主要角色: { 莉艾丽: { 好感: 70 } }, NPC: { 保安甲: { 阵营: '敌对' } } };
    const storage = memoryStorage();
    const k = (name) => `nl-sb:card_store_stat:${name}`;
    for (let i = 0; i < STORE_ENTRIES_MAX + 50; i++) assert.match(acceptPreviewStore(c, { key: k(`n${i}`), value: URL_A }, storage, { stat }), /预览里没有这个角色的立绘/);
    assert.equal(storage.map.size, 0);
    // 配置了立绘的角色、图池记录 NPC 在预览数据里的条目：照常记下、照常回到默认
    assert.equal(acceptPreviewStore(c, { key: k('莉艾丽'), value: URL_B }, storage, { stat }), '');
    assert.equal(acceptPreviewStore(c, { key: k('保安甲'), value: URL_C }, storage, { stat }), '');
    assert.deepEqual([...storage.map.keys()].sort(), [k('保安甲'), k('莉艾丽')].sort());
    assert.equal(acceptPreviewStore(c, { key: k('保安甲'), value: null }, storage, { stat }), '');
    // 预览里没有的名字（聊天里才出场的 NPC）：预览既不能记，也不能删
    storage.setItem(k('聊天里的NPC'), URL_A);
    assert.match(acceptPreviewStore(c, { key: k('聊天里的NPC'), value: null }, storage, { stat }), /预览里没有这个角色的立绘/);
    assert.equal(storage.getItem(k('聊天里的NPC')), URL_A);
});

test('变量表上限按卡片规则（statusBarVarCap）：设置、卡上记着的 maxVars、打开时的变量数取最大；删掉几个后还能加回来', () => {
    const s = settings();
    s.statusBar.maxVars = 12; // 设置里的上限 12（老用户的设置；新默认是 20）
    const c = card();
    const sb = ensureStatusBar(c, s);
    const vars = Array.from({ length: 14 }, (_, k) => ({ path: `世界.v${k}`, type: 'number', init: 1, min: 0, max: 9 }));
    sb.spec = normalizeStatusSpec({ variables: vars }, { maxVars: 30 });
    const openLeaves = 14;
    // 没有模板、设置里的上限是 12：卡上已有的 14 个不能当成超出上限丢掉
    assert.equal(statusBarVarCap(c, s, { leaves: openLeaves }), 14);
    const warnings = [];
    assert.equal(normalizeStatusSpec({ variables: sb.spec.variables }, { maxVars: statusBarVarCap(c, s, { leaves: openLeaves }), warnings }).variables.length, 14);
    assert.ok(!warnings.some((w) => /上限/.test(w)), warnings.join('\n'));
    // 删掉 3 个之后：仍按打开时的 14 个算（还能加回来），不是按现在的 11 个
    sb.spec = normalizeStatusSpec({ variables: vars.slice(0, 11) }, { maxVars: 30 });
    assert.equal(statusBarVarCap(c, s, { leaves: openLeaves }), 14);
    // 卡上记着的上限（套用「多人群像」时记下 15）更大时用它；设置更大时用设置
    sb.maxVars = 15;
    assert.equal(statusBarVarCap(c, s, { leaves: openLeaves }), 15);
    s.statusBar.maxVars = 20;
    assert.equal(statusBarVarCap(c, s, { leaves: openLeaves }), 20);
    const src = readFileSync(new URL('../src/ui/statusbar-dialog.js', import.meta.url), 'utf8');
    assert.ok(!/statusBarVarCap\(card, c\.settings\)(?!,)/.test(src), '对话框不再只按模板算上限');
});

test('撤销也换回卡片自己的变量上限（maxVars）：撤销套用「多人群像」回到跟随设置，再点一次（重做）又是 15；对话框的撤销与 restoreStatusBarPrev 一致', async () => {
    const s = settings();
    s.statusBar.maxVars = 12; // 设置里的上限 12（老用户的设置；新默认是 20）
    const ens = BUILTIN_STATUSBAR_TEMPLATES.find((t) => t.id === 'builtin_ensemble');
    const c = card({ kind: 'world', charName: '', data: { ...card().data, name: '雾港' } });
    ensureStatusBar(c, s);
    c.statusBar.spec = normalizeStatusSpec({ variables: [{ path: '世界.时间', type: 'string', init: '清晨' }] });
    await applyTemplateToCard(c, ctx(s), ens, 'structure', { ai: false });
    assert.equal(c.statusBar.maxVars, 15);
    assert.equal(c.statusBar.prev.maxVars, null, '撤销点里有套用前的上限');
    // 撤销：上限回到跟随设置（不再按 15 放宽）；再点一次（重做）回到 15，15 个变量照样保留
    assert.equal(restoreStatusBarPrev(c), true);
    assert.equal(c.statusBar.maxVars, null);
    assert.equal(statusBarVarCap(c, s), 12);
    assert.equal(restoreStatusBarPrev(c), true);
    assert.equal(c.statusBar.maxVars, 15);
    assert.equal(countSpecLeaves(c.statusBar.spec), 15);
    // 旧版本存下的撤销点没有 maxVars：撤销时保持现在的上限
    c.statusBar.prev = { spec: normalizeStatusSpec({ variables: [{ path: '世界.时间', type: 'string' }] }), html: '', mode: 'auto', theme: 'clean', sample: null, templateId: null };
    assert.equal(restoreStatusBarPrev(c), true);
    assert.equal(c.statusBar.maxVars, 15);
    assert.equal(c.statusBar.prev.maxVars, 15);
    // 对话框自己的撤销按同一份字段交换
    const src = readFileSync(new URL('../src/ui/statusbar-dialog.js', import.meta.url), 'utf8');
    assert.match(src, /const PREV_KEYS = \[[^\]]*'maxVars'[^\]]*\]/);
    assert.match(src, /const snapshotOf = \(\) => \(\{[^\n]*maxVars: sb\.maxVars \?\? null \}\);/);
});

test('世界/旁白卡套用「多人群像」（不让 AI 调整）：项目里的主要角色预先填进「主要角色」，NPC 不填', async () => {
    const s = settings();
    const w = card({ kind: 'world', charName: '', data: { ...card().data, name: '雾港' } });
    const ens = BUILTIN_STATUSBAR_TEMPLATES.find((t) => t.id === 'builtin_ensemble');
    const warnings = [];
    const r = await applyTemplateToCard(w, ctx(s), ens, 'structure', { ai: false, warnings });
    assert.equal(r.ai, false);
    const cast = w.statusBar.spec.variables.find((v) => v.path === '主要角色');
    assert.deepEqual(Object.keys(cast.init), ['林小雨']);
    assert.deepEqual(w.statusBar.spec.variables.find((v) => v.path === 'NPC').init, {});
    assert.ok(warnings.some((x) => /预先填进「主要角色」：林小雨/.test(x)), warnings.join('\n'));
});

test('立绘候选：只在示例数据里出现的名字单独一组、标「示例数据」；配置了这样的名字时知道它在哪个记录里', () => {
    const spec = normWorld();
    const sample = buildInitialState(spec);
    sample['主要角色']['沈遥'] = { 身份: '演示', 好感: 40, 服饰: { 上衣: '', 下装: '' } };
    sample.NPC = { 老周: { 阵营: '敌对', 好感: 0 } };
    const p = normalizePortraits(PORTRAITS, { spec });
    const draft = portraitDraftFrom(p);
    draft.chars.push({ name: '老周', images: [] });
    const html = portraitsPanelHtml({ draft, spec, sample, portraits: p, sb: { mode: 'auto' } });
    const main = html.split('aria-label="变量表里的角色">')[1].split('</div>')[0];
    const demo = html.split('data-sb-pt-sample-chips>')[1].split('</div>')[0];
    assert.match(main, /data-sb-name="卡尔"/, '初始条目照常列出');
    assert.ok(!/沈遥|老周/.test(main), '示例数据里的名字不混进变量表的角色');
    assert.match(html, /role="group" aria-label="示例数据里的名字" data-sb-pt-sample-chips><span class="nl-muted nl-small"[^>]*>示例数据：<\/span>/);
    assert.match(demo, /data-sb-name="沈遥" data-sb-sample title="示例数据：「主要角色」里只有示例数据才有的条目/);
    assert.ok(!/data-sb-name="老周"/.test(demo), '已经配置的不再列出');
    assert.match(html, /<option value="沈遥" label="示例数据"><\/option>/);
    // 配置了只在示例数据里的名字：知道它在 NPC 记录里（不是「自己填的名字」），并说明是示例数据
    const sec = html.split('data-sb-pt-char="2"')[1];
    assert.match(sec, /「NPC」里的条目（示例数据） · 0 张/);
    assert.match(sec, /data-sb-pt-sample-note>「老周」只在示例数据里出现/);
    assert.ok(!/变量表里没有叫「老周」/.test(sec));
    // 没有示例数据时没有这一组
    assert.ok(!portraitsPanelHtml({ draft: { chars: [], pools: [] }, spec, sb: { mode: 'auto' } }).includes('data-sb-pt-sample-chips'));
});

test('立绘标题：默认那张在另一处同名的角色里时说「默认显示另一处「X」里的图」，不再出现「第 0 张」', () => {
    const spec = normWorld();
    const d = { chars: [{ name: '莉艾丽', images: [{ url: URL_A }] }, { name: '莉艾丽', images: [{ url: URL_B }] }], pools: [] };
    const p = normalizePortraits(portraitDraftToRaw(d), { spec });
    assert.deepEqual(p.characters['莉艾丽'].map((x) => x.url), [URL_A, URL_B], '同名的两处合在一起');
    const html = portraitsPanelHtml({ draft: d, spec, sample: buildInitialState(spec), portraits: p, sb: { mode: 'auto' } });
    const sec = (ci) => html.split(`data-sb-pt-char="${ci}"`)[1].split('data-sb-pt-char=')[0];
    assert.match(sec(0), /1 张 · 默认显示另一处「莉艾丽」里的图/);
    assert.match(sec(1), /1 张 · 默认显示第 1 张/);
    assert.ok(!html.includes('第 0 张'));
});
