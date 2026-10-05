// v0.15：状态栏变量上限最多 100、默认 20（已保存的旧值不变）；所有夹取口径一致
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { DEFAULT_SETTINGS, DEFAULT_STATUS_BAR, STATUS_BAR_VAR_CAP } from '../src/constants.js';
import { mergeDefaults, uid } from '../src/utils.js';
import { createProject, normalizeCharacter, normalizeProject } from '../src/project.js';
import { applyConfig, clampVarCap } from '../src/io.js';
import { countSpecLeaves, ensureStatusBar, normalizeStatusSpec } from '../src/statusbar.js';
import { buildStatusSpecPrompt } from '../src/statusbar-ai.js';
import {
    BUILTIN_STATUSBAR_TEMPLATES, TEMPLATE_VAR_CAP_MAX, TEMPLATE_VAR_CAP_MIN, addStatusBarTemplate, applyStatusBarTemplate, statusBarVarCap,
    templateFromStatusBar, templateVarCap,
} from '../src/statusbar-templates.js';

const settings = () => mergeDefaults({}, DEFAULT_SETTINGS);

function project() {
    const p = createProject({ name: '雨夜' });
    p.bookName = '雨夜';
    p.chunks = [0, 1].map((i) => ({ id: `c${i}`, index: i, title: `第${i + 1}章`, content: '', charCount: 100, end: 100, status: 'done' }));
    p.characters['林小雨'] = normalizeCharacter({ name: '林小雨', importance: 'main', identity: '咖啡馆店员', firstChunk: 0, lastChunk: 1, chunksSeen: [0, 1] });
    return normalizeProject(p);
}

function card() {
    return {
        id: uid('card_'), charName: '林小雨', kind: 'character', timepoint: null, requirement: '', stAvatar: '', worldName: '',
        data: { name: '林小雨', description: '咖啡馆店员', personality: '', scenario: '', first_mes: '雨停了。', alternate_greetings: [], mes_example: '', system_prompt: '', post_history_instructions: '', creator_notes: '', tags: [] },
    };
}

/** n 个数字变量（每个算一个） */
const manyVars = (n) => Array.from({ length: n }, (_, k) => ({ path: `世界.v${k}`, type: 'number', init: 1, min: 0, max: 9 }));

test('默认上限 20、范围 3~100；已保存的旧值（12、30）不变', () => {
    assert.equal(DEFAULT_STATUS_BAR.maxVars, 20);
    assert.deepEqual({ ...STATUS_BAR_VAR_CAP }, { min: 3, max: 100 });
    assert.ok(Object.isFrozen(STATUS_BAR_VAR_CAP));
    assert.equal(TEMPLATE_VAR_CAP_MIN, 3);
    assert.equal(TEMPLATE_VAR_CAP_MAX, 100);
    assert.equal(settings().statusBar.maxVars, 20);
    assert.equal(mergeDefaults({ statusBar: { maxVars: 12 } }, DEFAULT_SETTINGS).statusBar.maxVars, 12);
    assert.equal(mergeDefaults({ statusBar: { maxVars: 30 } }, DEFAULT_SETTINGS).statusBar.maxVars, 30);
});

test('applyConfig / clampVarCap：导入的变量上限夹到 3~100，不是数字时回到默认；配置里没有这一项时不动', () => {
    assert.equal(clampVarCap(100), 100);
    assert.equal(clampVarCap(150), 100);
    assert.equal(clampVarCap(1), 3);
    assert.equal(clampVarCap('64'), 64);
    assert.equal(clampVarCap(12.4), 12);
    assert.equal(clampVarCap('很多'), 20);
    assert.equal(clampVarCap(null), 20);
    assert.equal(clampVarCap(true), 20);
    const s = settings();
    applyConfig(s, { statusBar: { maxVars: 250 } });
    assert.equal(s.statusBar.maxVars, 100);
    applyConfig(s, { statusBar: { maxVars: 12 } });
    assert.equal(s.statusBar.maxVars, 12, '旧配置里的 12 原样保留');
    applyConfig(s, { statusBar: { theme: 'night' } });
    assert.equal(s.statusBar.maxVars, 12, '配置里没有上限时不动');
    applyConfig(s, { statusBar: { maxVars: 'x' } });
    assert.equal(s.statusBar.maxVars, 20);
});

test('变量表规范化与 AI 设计：上限 100 时 100 个变量都保留、第 101 个丢弃；提示词写明上限并提醒不必用满；设置里超过 100 的按 100', () => {
    const w = [];
    const spec = normalizeStatusSpec({ variables: manyVars(101) }, { maxVars: 100, warnings: w });
    assert.equal(countSpecLeaves(spec), 100);
    assert.ok(w.some((x) => x.includes('超过上限 100')));
    const s = settings();
    s.statusBar.maxVars = 100;
    const c = card();
    ensureStatusBar(c, s);
    assert.match(buildStatusSpecPrompt(project(), s, c).prompt, /变量总数不超过 100 个[^\n]*100 只是允许的最多个数，不必用满/);
    s.statusBar.maxVars = 500;
    assert.match(buildStatusSpecPrompt(project(), s, c).prompt, /变量总数不超过 100 个/, '设置里超过 100 的按 100');
});

test('模板与卡片的上限：模板自带上限最多 100；80 个变量的卡存成模板不截断、记下 80；设置 100 时 statusBarVarCap 是 100', () => {
    const s = settings();
    assert.equal(templateVarCap({ maxVars: 100 }, s), 100);
    assert.equal(templateVarCap({ maxVars: 250 }, s), 100);
    assert.equal(templateVarCap(null, s), 20);
    const c = card();
    const sb = ensureStatusBar(c, s);
    sb.spec = normalizeStatusSpec({ variables: manyVars(80) }, { maxVars: 100 });
    const data = templateFromStatusBar(c, { name: '八十' });
    assert.equal(data.maxVars, 80);
    const t = addStatusBarTemplate(s, { ...data, html: '<div data-nl-text="世界.v0"></div>', mode: 'bind' });
    assert.equal(countSpecLeaves(t.spec), 80, '存进模板的变量表不截断');
    assert.equal(t.maxVars, 80);
    const c2 = card();
    applyStatusBarTemplate(c2, t, 'structure', { settings: s });
    assert.equal(countSpecLeaves(c2.statusBar.spec), 80, '套用时按模板自带的上限全部保留');
    assert.equal(statusBarVarCap(c2, s), 80);
    s.statusBar.maxVars = 100;
    assert.equal(statusBarVarCap(c2, s), 100);
    // 「多人群像」：默认 20 下本来就放得下；说明里讲清楚只有设置里的上限更低时才靠模板自带的上限
    const ens = BUILTIN_STATUSBAR_TEMPLATES.find((x) => x.id === 'builtin_ensemble');
    assert.equal(templateVarCap(ens, settings()), 20);
    assert.match(ens.desc, /共 15 个变量，设置里的变量上限低于 15 时，套用也按模板自带的上限全部保留/);
});

test('设置页：变量上限输入框用 3~100、旁边有一句说明；「写入后自动允许」的开关和一句说明', () => {
    const src = readFileSync(new URL('../src/ui/tab-settings.js', import.meta.url), 'utf8');
    assert.match(src, /const SB_MAX_VARS = STATUS_BAR_VAR_CAP;/);
    assert.match(src, /sb\.maxVars = clampInt\(t\.value, SB_MAX_VARS\.min, SB_MAX_VARS\.max, DEFAULT_STATUS_BAR\.maxVars\)/);
    assert.match(src, /变量越多，每轮发送的规则和 AI 输出的更新就越长/);
    assert.match(src, /data-setting="cards\.autoAllow"/);
    assert.match(src, /写入酒馆后自动允许本卡的局部正则和角色脚本/);
    assert.equal(DEFAULT_SETTINGS.cards.autoAllow, true);
});
