// 写卡选项里的「状态栏模板」（src/ui/tab-cards.js）：世界/旁白卡的「自动」写成按群像设计；
// 世界卡选了只记一个角色的模板（变量表里没有主要角色记录）时在下拉框下面提示。
// 以及 style.css 的「一行一种控件高度」规则也覆盖立绘分页的标题行（.nl-sb-pt-head）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { DEFAULT_SETTINGS } from '../src/constants.js';
import { addStatusBarTemplate } from '../src/statusbar-templates.js';
import {
    WORLD_SINGLE_TEMPLATE_WARNING, cardStatusBarTemplateOptions, statusBarTemplateWarningHtml, statusBarTemplateWorldWarning,
    syncStatusBarTemplateWarning,
} from '../src/ui/tab-cards.js';
import { statusBarTemplateOptions } from '../src/ui/statusbar-dialog.js';
import { mergeDefaults } from '../src/utils.js';

const settings = () => mergeDefaults({}, DEFAULT_SETTINGS);

test('状态栏模板下拉：世界/旁白卡的「自动」写成按群像设计，角色卡不变，其余选项与 statusBarTemplateOptions 一致', () => {
    const s = settings();
    const base = statusBarTemplateOptions(s);
    const world = cardStatusBarTemplateOptions(s, 'world');
    const char = cardStatusBarTemplateOptions(s, 'character');
    assert.equal(world[0].value, '');
    assert.equal(world[0].label, '自动（AI 按群像设计）');
    assert.equal(char[0].label, '自动（AI 按角色设计）');
    assert.deepEqual(char, base);
    assert.deepEqual(world.slice(1), base.slice(1), '模板选项不变');
    assert.deepEqual(world.map((o) => o.value), base.map((o) => o.value), '值不变：已选的模板仍然有效');
    assert.equal(base[0].label, '自动（AI 按角色设计）', '不改动共用的选项列表');
});

test('世界卡选了只记一个角色的模板：提示「只记一个角色，不适合世界卡」；群像模板、自动、角色卡、只借外观的模板不提示', () => {
    const s = settings();
    assert.equal(WORLD_SINGLE_TEMPLATE_WARNING, '这个模板只记一个角色，不适合世界卡；建议用 自动 或 多人群像');
    for (const id of ['builtin_general', 'builtin_rpg', 'builtin_campus']) {
        assert.equal(statusBarTemplateWorldWarning(s, 'world', id), WORLD_SINGLE_TEMPLATE_WARNING, id);
        assert.equal(statusBarTemplateWorldWarning(s, 'character', id), '', `${id}：角色卡不提示`);
    }
    assert.equal(statusBarTemplateWorldWarning(s, 'world', 'builtin_ensemble'), '', '多人群像有「主要角色」记录');
    assert.equal(statusBarTemplateWorldWarning(s, 'world', ''), '', '自动');
    assert.equal(statusBarTemplateWorldWarning(s, 'world', 'no_such_template'), '', '找不到的模板（会被重置成自动）');
    assert.equal(statusBarTemplateWorldWarning(null, 'world', 'builtin_general'), WORLD_SINGLE_TEMPLATE_WARNING, '没有设置时仍能读内置模板');

    // 用户模板：有主要角色记录的不提示；只有单人变量的提示；只有界面的（只借外观，变量表由 AI 按群像设计）不提示
    const cast = addStatusBarTemplate(s, {
        name: '我的群像',
        spec: { variables: [{ path: '主要角色', type: 'record', keyDesc: '角色名', value: { type: 'object', fields: [{ key: '好感', type: 'number', min: 0, max: 100, init: 0 }] }, init: {} }] },
    });
    const single = addStatusBarTemplate(s, { name: '单人', spec: { variables: [{ path: '好感', type: 'number', min: 0, max: 100, init: 10 }] } });
    const look = addStatusBarTemplate(s, { name: '只有界面', mode: 'raw', html: '<div class="x">{{好感}}</div>' });
    assert.equal(statusBarTemplateWorldWarning(s, 'world', cast.id), '');
    assert.equal(statusBarTemplateWorldWarning(s, 'world', single.id), WORLD_SINGLE_TEMPLATE_WARNING);
    assert.equal(statusBarTemplateWorldWarning(s, 'world', look.id), '');
    // 设置里的模板列表坏了也不抛错
    assert.equal(statusBarTemplateWorldWarning({ statusBarTemplates: 'oops' }, 'world', 'x'), '');
});

test('提示的位置总是在（没有提示时隐藏）；换模板时只更新提示和下拉框的 aria-describedby，不整页重绘', () => {
    const empty = statusBarTemplateWarningHtml('');
    assert.match(empty, /data-sb-tpl-warn/);
    assert.match(empty, /id="nl-sb-tpl-warn"/);
    assert.match(empty, / hidden>/);
    assert.ok(!empty.includes('不适合'));
    const shown = statusBarTemplateWarningHtml(WORLD_SINGLE_TEMPLATE_WARNING);
    assert.ok(!/ hidden>/.test(shown));
    assert.match(shown, /class="nl-warn nl-small"/);
    assert.ok(shown.includes('不适合世界卡'));
    assert.ok(statusBarTemplateWarningHtml('<b>&</b>').includes('&lt;b&gt;&amp;&lt;/b&gt;'), '提示文字要转义');

    const fake = () => {
        const attrs = new Map();
        return {
            innerHTML: '',
            setAttribute: (k, v) => attrs.set(k, String(v)),
            removeAttribute: (k) => attrs.delete(k),
            hasAttribute: (k) => attrs.has(k),
            getAttribute: (k) => (attrs.has(k) ? attrs.get(k) : null),
            toggleAttribute: (k, on) => (on ? attrs.set(k, '') : attrs.delete(k)),
        };
    };
    const box = fake();
    const sel = fake();
    box.setAttribute('hidden', '');
    const root = { querySelector: (q) => (q === '[data-sb-tpl-warn]' ? box : q === 'select[data-setting="cards.statusBarTemplateId"]' ? sel : null) };
    syncStatusBarTemplateWarning(root, WORLD_SINGLE_TEMPLATE_WARNING);
    assert.equal(box.hasAttribute('hidden'), false);
    assert.ok(box.innerHTML.includes('不适合世界卡'));
    assert.equal(sel.getAttribute('aria-describedby'), 'nl-sb-tpl-warn');
    syncStatusBarTemplateWarning(root, '');
    assert.equal(box.hasAttribute('hidden'), true);
    assert.equal(box.innerHTML, '');
    assert.equal(sel.hasAttribute('aria-describedby'), false);
    syncStatusBarTemplateWarning({ querySelector: () => null }, WORLD_SINGLE_TEMPLATE_WARNING); // 表单不在页面上：什么也不做
    syncStatusBarTemplateWarning(null, '');
});

test('写卡表单接上了：下拉选项按卡片类型取、下面有提示位置、换模板时更新提示', () => {
    const src = readFileSync(new URL('../src/ui/tab-cards.js', import.meta.url), 'utf8');
    assert.match(src, /const sbTpls = cardStatusBarTemplateOptions\(app\.settings, form\.kind\)/);
    assert.match(src, /data-setting="cards\.statusBarTemplateId"[^>]*>\$\{optionList\(sbTpls, sbTplId\)\}<\/select>\$\{statusBarTemplateWarningHtml\(sbTplWarn\)\}/);
    assert.match(src, /dataset\.setting === 'cards\.statusBarTemplateId'\) \{\s*syncStatusBarTemplateWarning\(el, statusBarTemplateWorldWarning\(app\.settings, form\.kind, e\.target\.value\)\)/);
});

test('style.css：立绘分页的标题行（.nl-sb-pt-head）里有输入框 / 下拉框时，小按钮也提到正常高度（宽屏 32px，≤800px 30px）', () => {
    const css = readFileSync(new URL('../style.css', import.meta.url), 'utf8');
    const rules = [...css.matchAll(/:is\(([^)]*)\):has\(> \.nl-input, > \.nl-btn:not\(\.nl-sm\), > select\) > \.nl-btn\.nl-sm \{ height: (\d+)px;/g)];
    assert.equal(rules.length, 2, '宽屏一条，窄屏一条');
    for (const [, list] of rules) assert.ok(list.split(',').map((x) => x.trim()).includes('.nl-sb-pt-head'), list);
    assert.deepEqual(rules.map((r) => r[2]), ['32', '30']);
    const noComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '');
    const depth = (i) => { const s = noComments(css.slice(0, i)); return (s.match(/\{/g) || []).length - (s.match(/\}/g) || []).length; };
    assert.equal(depth(rules[0].index), 0, '32px 那条在最外层');
    assert.equal(depth(rules[1].index), 1, '30px 那条在 @media 块里');
    assert.equal(css.slice(css.lastIndexOf('@media', rules[1].index)).match(/^@media[^{]*/)[0].trim(), '@media (max-width: 800px)');
});
