// 状态栏模板：内置模板的完整性（变量表、界面检查、导出往返、真实 zod）、增删改查与内置保护、套用、导入导出、配置合并
// zod 是 devDependency：没装（没跑 npm install）时相关用例自动跳过。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
    BUILTIN_STATUSBAR_TEMPLATES, STATUS_TEMPLATE_FILE_TYPE, STATUS_TEMPLATE_MODE_LABELS, addStatusBarTemplate, applyStatusBarTemplate,
    duplicateStatusBarTemplate, exportStatusBarTemplate, findStatusBarRegex, getStatusBarTemplate, importStatusBarTemplate,
    isBuiltinStatusBarTemplate, listStatusBarTemplates, parseStatusBarTemplate, removeStatusBarTemplate, statusBarTemplateFileName,
    templateFromCardJson, templateFromStatusBar, templatePreviewCard, templateStyleRef, uniqueStatusBarTemplateName, updateStatusBarTemplate,
} from '../src/statusbar-templates.js';
import {
    STATUS_MODE_LABELS, buildInitialState, buildStatusRegexScripts, compileSchemaScript, countSpecLeaves, ensureStatusBar,
    isFrontendText, lintStatusHtml, normalizeStatusSpec, parseStateWithSpec, unwrapStatusFence,
} from '../src/statusbar.js';
import { buildPreviewSrcdoc, cleanFragment, renderDefaultFragment } from '../src/statusbar-runtime.js';
import { DEFAULT_SETTINGS, DEFAULT_STATUS_BAR } from '../src/constants.js';
import { buildCardJson } from '../src/cards.js';
import { applyConfig } from '../src/io.js';
import { mergeDefaults } from '../src/utils.js';

let z = null;
try {
    ({ z } = await import('zod'));
} catch { /* 未安装 */ }
const needZod = { skip: z ? false : '需要 devDependency zod（npm install）' };

/** 把编译出的变量结构脚本变成真实的 zod Schema：去掉 import 行和 $(…) 注册行，注入 z */
function loadSchema(code) {
    const body = code.split('\n').filter((l) => !/^import\s/.test(l) && !/^\$\(/.test(l)).join('\n').replace('export const Schema', 'const Schema');
    return new Function('z', `${body}\nreturn Schema;`)(z);
}

function settings() {
    return mergeDefaults({}, DEFAULT_SETTINGS);
}

const clone = (v) => JSON.parse(JSON.stringify(v));

function card(extra = {}) {
    return { id: 'c1', kind: 'character', charName: '林夕', data: { name: '林夕', first_mes: '放学后。', alternate_greetings: [], creator_notes: '' }, ...extra };
}

/** 用模板的变量表和界面做一张启用状态栏的卡 */
function cardWithTemplate(t) {
    const c = card();
    ensureStatusBar(c, settings());
    Object.assign(c.statusBar, { spec: clone(t.spec), html: t.html, mode: t.mode, theme: t.theme, sample: clone(t.sample) });
    return c;
}

const USER_TPL = {
    name: '  我的模板  ',
    desc: '测试用',
    mode: 'bind',
    spec: { title: '测试', variables: [{ path: '甲.好感', type: 'number', init: 10, min: 0, max: 100 }, { path: '甲.心情', type: 'enum', options: ['好', '坏'], init: '好' }] },
    html: '<div><b data-nl-text="甲.好感"></b><i data-nl-text="甲.心情"></i></div>',
    theme: 'paper',
    sample: { 甲: { 好感: 50, 心情: '坏' } },
};

// ---------------- 内置模板 ----------------

test('内置模板：正好四个（通用 / RPG / 校园恋爱 / 赛博朋克），只读且已冻结', () => {
    assert.deepEqual(BUILTIN_STATUSBAR_TEMPLATES.map((t) => t.name), ['通用', 'RPG', '校园恋爱', '赛博朋克']);
    const ids = BUILTIN_STATUSBAR_TEMPLATES.map((t) => t.id);
    assert.equal(new Set(ids).size, 4);
    for (const t of BUILTIN_STATUSBAR_TEMPLATES) {
        assert.ok(t.id.startsWith('builtin_'), t.id);
        assert.equal(t.builtin, true);
        assert.equal(t.mode, 'bind');
        assert.ok(['clean', 'night', 'paper'].includes(t.theme));
        assert.ok(t.desc && t.desc.length <= 200);
        assert.ok(Object.isFrozen(t) && Object.isFrozen(t.spec) && Object.isFrozen(t.spec.variables[0]));
        assert.ok(isBuiltinStatusBarTemplate(t.id));
        assert.throws(() => { t.spec.variables.push({}); }, TypeError);
    }
    assert.ok(Object.isFrozen(BUILTIN_STATUSBAR_TEMPLATES));
    assert.equal(isBuiltinStatusBarTemplate('sbtpl_x'), false);
});

test('模式显示名：模板列表与状态栏编辑器共用一份，bind 叫「AI 设计」', () => {
    assert.equal(STATUS_TEMPLATE_MODE_LABELS, STATUS_MODE_LABELS);
    assert.deepEqual({ ...STATUS_TEMPLATE_MODE_LABELS }, { bind: 'AI 设计', auto: '内置排版', raw: '自定义 HTML' });
    assert.ok(Object.isFrozen(STATUS_MODE_LABELS));
});

test('内置模板：变量表 ≤12 个叶子，经 normalizeStatusSpec 不变且没有警告', () => {
    for (const t of BUILTIN_STATUSBAR_TEMPLATES) {
        const warnings = [];
        const again = normalizeStatusSpec(t.spec, { maxVars: DEFAULT_STATUS_BAR.maxVars, warnings });
        assert.deepEqual(warnings, [], t.name);
        assert.deepEqual(again, clone(t.spec), `${t.name} 的变量表应已规范化`);
        const n = countSpecLeaves(t.spec);
        assert.ok(n >= 6 && n <= 12, `${t.name}：${n} 个叶子`);
        assert.ok(t.spec.title);
    }
});

test('内置模板：界面通过 lintStatusHtml（无错误、无警告），只用 {{user}}/{{char}}，不引用外部资源', () => {
    for (const t of BUILTIN_STATUSBAR_TEMPLATES) {
        const r = lintStatusHtml(t.html, { mode: 'bind', spec: t.spec });
        assert.deepEqual(r.errors, [], `${t.name}：${r.errors.join('；')}`);
        assert.deepEqual(r.warnings, [], `${t.name}：${r.warnings.join('；')}`);
        for (const m of t.html.matchAll(/\{\{([^{}]*)\}\}/g)) assert.ok(['user', 'char'].includes(m[1]), `${t.name} 出现了 {{${m[1]}}}`);
        assert.ok(!/https?:\/\//i.test(t.html), `${t.name} 引用了外部地址`);
        assert.ok(!/<img\b|localStorage|sessionStorage|`/i.test(t.html), t.name);
        assert.ok(!/\bvh\b|\d+vh|position\s*:\s*fixed/i.test(t.html), t.name);
        assert.equal(cleanFragment(t.html), t.html.trim(), `${t.name} 应该是片段（不带 <html>/<body>）`);
    }
});

test('内置模板：每个变量都在界面里用到（绑定或 nlRender 脚本）', () => {
    for (const t of BUILTIN_STATUSBAR_TEMPLATES) {
        for (const v of t.spec.variables) {
            const bound = new RegExp(`data-nl-(?:text|bar|stage|show|each)="${v.path.replace(/\./g, '\\.')}"`).test(t.html);
            const scripted = t.html.includes(`'${v.path}'`);
            assert.ok(bound || scripted, `${t.name} 的变量 ${v.path} 没有显示在界面上`);
        }
    }
});

test('内置模板：示例数据符合变量表（校验后原样不变）', () => {
    for (const t of BUILTIN_STATUSBAR_TEMPLATES) {
        assert.ok(t.sample && typeof t.sample === 'object', t.name);
        const r = parseStateWithSpec(t.spec, t.sample);
        assert.equal(r.ok, true, `${t.name}：${r.errors.join('；')}`);
        assert.deepEqual(r.data, clone(t.sample), `${t.name} 的示例数据不是规整后的形状`);
    }
});

test('内置模板：导出的正则能原样经过酒馆替换，状态栏文档完整', () => {
    for (const t of BUILTIN_STATUSBAR_TEMPLATES) {
        const c = cardWithTemplate(t);
        const scripts = buildStatusRegexScripts(c);
        assert.equal(scripts.length, 5, t.name);
        const doc = scripts[0].replaceString;
        assert.ok(doc.includes('<body>') && doc.includes('window.NL_SPEC'), t.name);
        assert.ok(doc.includes(cleanFragment(t.html).slice(0, 40)), `${t.name} 的界面应原样出现在替换串里`);
        assert.equal((doc.match(/<script\b/gi) || []).length, (doc.match(/<\/script>/gi) || []).length, t.name);
    }
});

test('内置模板 + 真实 zod：parse({}) 等于初始值，示例数据原样通过，结果幂等', needZod, () => {
    for (const t of BUILTIN_STATUSBAR_TEMPLATES) {
        const Schema = loadSchema(compileSchemaScript(t.spec));
        const init = Schema.parse({});
        assert.deepEqual(init, buildInitialState(t.spec), t.name);
        assert.deepEqual(Schema.parse(init), init, `${t.name} 应幂等`);
        const sample = Schema.parse(clone(t.sample));
        assert.deepEqual(sample, clone(t.sample), `${t.name} 的示例数据应原样通过 zod`);
        assert.deepEqual(Schema.parse(sample), sample);
    }
});

test('内置模板：预览页面带模拟环境，{{char}}/{{user}} 换成名字', () => {
    for (const t of BUILTIN_STATUSBAR_TEMPLATES) {
        const html = buildPreviewSrcdoc(templatePreviewCard(t, { charName: '林夕' }), t.sample, { user: '阿远', char: '林夕' });
        assert.ok(html.includes('window.getAllVariables') && html.includes('data-nl-'), t.name);
        assert.ok(!html.includes('{{char}}') && !html.includes('{{user}}'), t.name);
        if (t.html.includes('{{char}}')) assert.ok(html.includes('林夕'), t.name);
        if (t.html.includes('{{user}}')) assert.ok(html.includes('阿远'), t.name);
    }
});

test('赛博朋克模板：卡片网格 + 详情弹层，用通用字段，不带具体人物、图片和本地存储', () => {
    const t = BUILTIN_STATUSBAR_TEMPLATES.find((x) => x.name === '赛博朋克');
    const rec = t.spec.variables.find((v) => v.type === 'record' && v.value.type === 'object');
    assert.ok(rec, '应有多角色记录');
    assert.deepEqual(rec.value.fields.map((f) => f.key), ['身份', '阵营', '好感', '心情', '状态', '想法']);
    assert.deepEqual(rec.init, {}, '变量表里不预置具体角色');
    assert.ok(t.html.includes(`data-nl-each="${rec.path}"`));
    assert.ok(/class="cy-detail"[^>]*hidden/.test(t.html), '详情弹层默认隐藏');
    assert.ok(t.html.includes('window.nlRender'));
    assert.ok(!/url\(|<img|localStorage|indexedDB/i.test(t.html));
});

// ---------------- 列表与增删改查 ----------------

test('listStatusBarTemplates：内置在前、返回副本；用户模板规整；同 id 的覆盖与无 id 的项被忽略', () => {
    const s = settings();
    s.statusBarTemplates = [
        { id: 'builtin_general', name: '假冒的通用', mode: 'auto', spec: USER_TPL.spec },
        { name: '没有 id' },
        { id: 'sbtpl_a', name: '  A  ', mode: 'weird', spec: USER_TPL.spec, html: '', theme: 'nope' },
    ];
    const list = listStatusBarTemplates(s);
    assert.deepEqual(list.map((t) => t.id), ['builtin_general', 'builtin_rpg', 'builtin_campus', 'builtin_cyberpunk', 'sbtpl_a']);
    assert.equal(list[0].name, '通用');
    assert.equal(list[0].builtin, true);
    const a = list[4];
    assert.equal(a.name, 'A');
    assert.equal(a.builtin, false);
    assert.equal(a.mode, 'auto', '没有界面代码的模板按内置排版处理');
    assert.equal(a.theme, 'clean');
    list[0].spec.variables.length = 0;
    assert.ok(BUILTIN_STATUSBAR_TEMPLATES[0].spec.variables.length > 0, '改返回值不影响内置模板');
    assert.equal(listStatusBarTemplates({}).length, 4, '没有 statusBarTemplates 字段也能用');
    assert.equal(getStatusBarTemplate(s, 'sbtpl_a').name, 'A');
    assert.equal(getStatusBarTemplate(s, 'nope'), null);
});

test('addStatusBarTemplate：名称必填、去空白、不能与已有（含内置）重名；id 为 sbtpl_；内容规整', () => {
    const s = settings();
    const t = addStatusBarTemplate(s, USER_TPL);
    assert.match(t.id, /^sbtpl_/);
    assert.equal(t.name, '我的模板');
    assert.equal(t.theme, 'paper');
    assert.ok(t.createdAt > 0 && t.updatedAt === t.createdAt);
    assert.deepEqual(t.spec, normalizeStatusSpec(USER_TPL.spec, { maxVars: 64 }));
    assert.equal(s.statusBarTemplates.length, 1);
    assert.throws(() => addStatusBarTemplate(s, { ...USER_TPL, name: '   ' }), /名称/);
    assert.throws(() => addStatusBarTemplate(s, { ...USER_TPL, name: '我的模板' }), /同名/);
    assert.throws(() => addStatusBarTemplate(s, { ...USER_TPL, name: 'rpg' }), /同名/, '与内置重名（不分大小写）');
    assert.throws(() => addStatusBarTemplate(s, { name: '空的', spec: null, html: '' }), /没有变量也没有界面/);
    assert.throws(() => addStatusBarTemplate(s, { name: '空 raw', mode: 'raw', html: ' ', spec: USER_TPL.spec }), /不能为空/);
    assert.throws(() => addStatusBarTemplate(s, { name: '太大', mode: 'raw', html: 'x'.repeat(200001) }), /太大/);
    const raw = addStatusBarTemplate(s, { name: '只有界面', mode: 'raw', html: '<body>x</body>' });
    assert.equal(raw.spec, null);
    assert.equal(addStatusBarTemplate(s, { name: '长'.repeat(40), spec: USER_TPL.spec }).name.length, 30, '名称截到 30 字');
});

test('updateStatusBarTemplate：只改给出的字段；改名查重；内置模板会抛错；找不到返回 null', () => {
    const s = settings();
    const t = addStatusBarTemplate(s, USER_TPL);
    addStatusBarTemplate(s, { ...USER_TPL, name: '另一个' });
    const u = updateStatusBarTemplate(s, t.id, { desc: '新的说明', theme: 'night' });
    assert.equal(u.desc, '新的说明');
    assert.equal(u.theme, 'night');
    assert.equal(u.name, '我的模板');
    assert.equal(u.html, USER_TPL.html);
    assert.equal(u.createdAt, t.createdAt);
    assert.equal(updateStatusBarTemplate(s, t.id, { name: ' 新名字 ' }).name, '新名字');
    assert.equal(updateStatusBarTemplate(s, t.id, { name: '新名字' }).name, '新名字', '改成自己的名字不算重名');
    assert.throws(() => updateStatusBarTemplate(s, t.id, { name: '另一个' }), /同名/);
    assert.throws(() => updateStatusBarTemplate(s, t.id, { name: '' }), /名称/);
    assert.throws(() => updateStatusBarTemplate(s, 'builtin_rpg', { name: '改名' }), /内置/);
    assert.throws(() => updateStatusBarTemplate(s, 'builtin_rpg', { desc: 'x' }), /内置/);
    assert.equal(updateStatusBarTemplate(s, 'sbtpl_none', { desc: 'x' }), null);
    assert.equal(getStatusBarTemplate(s, 'builtin_rpg').name, 'RPG');
});

test('removeStatusBarTemplate：内置模板删不掉；用户模板可删', () => {
    const s = settings();
    const t = addStatusBarTemplate(s, USER_TPL);
    for (const b of BUILTIN_STATUSBAR_TEMPLATES) assert.equal(removeStatusBarTemplate(s, b.id), false);
    s.statusBarTemplates.push({ id: 'builtin_general', name: '假冒' });
    assert.equal(removeStatusBarTemplate(s, 'builtin_general'), false, '即使设置里混进了同 id 的项');
    assert.equal(listStatusBarTemplates(s).filter((x) => x.builtin).length, 4);
    assert.equal(removeStatusBarTemplate(s, t.id), true);
    assert.equal(removeStatusBarTemplate(s, t.id), false);
    assert.equal(getStatusBarTemplate(s, t.id), null);
    assert.equal(removeStatusBarTemplate({}, 'x'), false);
});

test('duplicateStatusBarTemplate / uniqueStatusBarTemplateName：复制内置模板成用户模板，自动避开重名', () => {
    const s = settings();
    const c1 = duplicateStatusBarTemplate(s, 'builtin_cyberpunk');
    assert.equal(c1.name, '赛博朋克 副本');
    assert.equal(c1.html, BUILTIN_STATUSBAR_TEMPLATES[3].html);
    assert.deepEqual(c1.spec, clone(BUILTIN_STATUSBAR_TEMPLATES[3].spec));
    assert.equal(c1.builtin, undefined);
    assert.equal(duplicateStatusBarTemplate(s, 'builtin_cyberpunk').name, '赛博朋克 副本 2');
    assert.equal(duplicateStatusBarTemplate(s, 'builtin_rpg', '我的 RPG').name, '我的 RPG');
    assert.equal(duplicateStatusBarTemplate(s, 'nope'), null);
    assert.equal(uniqueStatusBarTemplateName(s, '通用'), '通用 2');
    assert.equal(uniqueStatusBarTemplateName(s, '全新'), '全新');
    assert.equal(updateStatusBarTemplate(s, c1.id, { desc: '可以改了' }).desc, '可以改了');
});

test('templateFromStatusBar：把卡片状态栏做成模板（没有界面代码时按内置排版）', () => {
    const c = cardWithTemplate(BUILTIN_STATUSBAR_TEMPLATES[0]);
    const t = templateFromStatusBar(c, { name: '林夕的栏', desc: '说明' });
    assert.equal(t.name, '林夕的栏');
    assert.equal(t.mode, 'bind');
    assert.deepEqual(t.spec, c.statusBar.spec);
    assert.notEqual(t.spec, c.statusBar.spec, '是副本');
    assert.deepEqual(t.sample, c.statusBar.sample);
    c.statusBar.html = '';
    const auto = templateFromStatusBar(c);
    assert.equal(auto.mode, 'auto');
    assert.equal(auto.html, '');
    assert.equal(auto.name, '林夕的状态栏');
    const s = settings();
    const saved = addStatusBarTemplate(s, templateFromStatusBar(cardWithTemplate(BUILTIN_STATUSBAR_TEMPLATES[1]), { name: '存档' }));
    assert.equal(getStatusBarTemplate(s, saved.id).spec.variables.length, BUILTIN_STATUSBAR_TEMPLATES[1].spec.variables.length);
});

// ---------------- 套用 ----------------

test('applyStatusBarTemplate 沿用结构：复制变量表/界面/主题/示例，保留 id 与选项，清掉手写覆盖，记下撤销点', () => {
    const s = settings();
    const c = card();
    ensureStatusBar(c, s);
    const sb = c.statusBar;
    sb.spec = normalizeStatusSpec(USER_TPL.spec);
    sb.html = USER_TPL.html;
    sb.overrides.updateRules = '手写规则';
    sb.options.showDepth = 3;
    sb.worldName = '《书》·林夕';
    const ids = { ...sb.ids };
    const tpl = getStatusBarTemplate(s, 'builtin_campus');
    const r = applyStatusBarTemplate(c, tpl, 'structure', { settings: s });
    assert.equal(r.statusBar, sb);
    assert.deepEqual(sb.spec, tpl.spec);
    assert.notEqual(sb.spec, tpl.spec);
    assert.equal(sb.html, tpl.html);
    assert.equal(sb.mode, 'bind');
    assert.equal(sb.theme, 'paper');
    assert.deepEqual(sb.sample, tpl.sample);
    assert.equal(sb.templateId, 'builtin_campus');
    assert.deepEqual(sb.ids, ids);
    assert.equal(sb.options.showDepth, 3);
    assert.equal(sb.worldName, '《书》·林夕');
    assert.deepEqual(sb.overrides, { schemaScript: null, updateRules: null, initvar: null });
    assert.equal(r.warnings.length, 1);
    assert.match(r.warnings[0], /覆盖/);
    assert.deepEqual(sb.lint, { errors: [], warnings: [] });
    assert.deepEqual(r.ai, { parts: ['init', 'rules'], templateMode: 'structure' });
    assert.equal(sb.prev.html, USER_TPL.html);
    assert.equal(sb.prev.overrides.updateRules, '手写规则');
    assert.deepEqual(sb.prev.spec, normalizeStatusSpec(USER_TPL.spec));
    assert.ok(sb.updatedAt > 0);
    // 卡片上的副本可以随便改，不影响模板
    sb.spec.variables.pop();
    assert.equal(getStatusBarTemplate(s, 'builtin_campus').spec.variables.length, tpl.spec.variables.length);
});

test('applyStatusBarTemplate 沿用结构：按 maxVars 截断并给出提示；卡片没有状态栏时自动创建', () => {
    const s = settings();
    s.statusBar.maxVars = 5;
    const c = card();
    const tpl = getStatusBarTemplate(s, 'builtin_rpg');
    const r = applyStatusBarTemplate(c, tpl, 'structure', { settings: s });
    assert.ok(c.statusBar && c.statusBar.ids.regexBar);
    assert.ok(countSpecLeaves(c.statusBar.spec) <= 5);
    assert.ok(r.warnings.some((w) => /上限/.test(w)));
    const r2 = applyStatusBarTemplate(card(), tpl, 'structure', { maxVars: 30 });
    assert.equal(countSpecLeaves(r2.statusBar.spec), countSpecLeaves(tpl.spec));
});

test('applyStatusBarTemplate 只借外观：保留变量表与界面，换主题，交给 AI 重写界面；内置排版模板直接切换', () => {
    const s = settings();
    const c = card();
    ensureStatusBar(c, s);
    c.statusBar.spec = normalizeStatusSpec(USER_TPL.spec);
    c.statusBar.html = USER_TPL.html;
    c.statusBar.sample = { 甲: { 好感: 1, 心情: '好' } };
    const spec = clone(c.statusBar.spec);
    const r = applyStatusBarTemplate(c, getStatusBarTemplate(s, 'builtin_cyberpunk'), 'look', { settings: s });
    assert.deepEqual(c.statusBar.spec, spec);
    assert.equal(c.statusBar.html, USER_TPL.html, '界面等 AI 重写');
    assert.equal(c.statusBar.mode, 'bind');
    assert.equal(c.statusBar.theme, 'night');
    assert.deepEqual(c.statusBar.sample, { 甲: { 好感: 1, 心情: '好' } });
    assert.equal(c.statusBar.templateId, 'builtin_cyberpunk');
    assert.deepEqual(r.ai, { parts: ['html'], templateMode: 'style' });
    assert.equal(c.statusBar.prev.theme, 'clean');
    // 'style' 是别名；内置排版模板不需要 AI
    const autoTpl = addStatusBarTemplate(s, { name: '纸笺排版', mode: 'auto', theme: 'paper', spec: USER_TPL.spec });
    const r2 = applyStatusBarTemplate(c, getStatusBarTemplate(s, autoTpl.id), 'style', { settings: s });
    assert.equal(r2.ai, null);
    assert.equal(c.statusBar.mode, 'auto');
    assert.equal(c.statusBar.theme, 'paper');
    assert.deepEqual(c.statusBar.spec, spec);
});

test('applyStatusBarTemplate：没有变量表的模板不能沿用结构；未知方式与空模板报错', () => {
    const s = settings();
    const rawTpl = addStatusBarTemplate(s, { name: '只有界面', mode: 'raw', html: '<body><script>getAllVariables()</script></body>' });
    assert.throws(() => applyStatusBarTemplate(card(), getStatusBarTemplate(s, rawTpl.id), 'structure', { settings: s }), /只借外观/);
    const r = applyStatusBarTemplate(card(), getStatusBarTemplate(s, rawTpl.id), 'look', { settings: s });
    assert.deepEqual(r.ai, { parts: ['html'], templateMode: 'style' });
    assert.throws(() => applyStatusBarTemplate(card(), BUILTIN_STATUSBAR_TEMPLATES[0], 'merge'), /未知/);
    assert.throws(() => applyStatusBarTemplate(card(), null, 'structure'), /没有找到/);
});

test('套用内置模板后整张卡能导出（buildCardJson 带正则、脚本与模板 id）', () => {
    for (const t of BUILTIN_STATUSBAR_TEMPLATES) {
        const c = card();
        applyStatusBarTemplate(c, t, 'structure', { settings: settings() });
        const json = buildCardJson(c, { statusBar: DEFAULT_STATUS_BAR });
        assert.equal(json.data.extensions.regex_scripts.length, 5, t.name);
        assert.equal(json.data.extensions.tavern_helper.scripts.length, 2, t.name);
        assert.equal(json.data.extensions.novel_loom.statusBar.templateId, t.id);
    }
});

test('templateStyleRef / templatePreviewCard', () => {
    const t = BUILTIN_STATUSBAR_TEMPLATES[2];
    assert.equal(templateStyleRef(t), t.html.trim());
    const auto = { name: 'a', mode: 'auto', theme: 'night', spec: USER_TPL.spec };
    assert.equal(templateStyleRef(auto), renderDefaultFragment(normalizeStatusSpec(USER_TPL.spec, { maxVars: 64 }), 'night'));
    assert.equal(templateStyleRef({ name: 'r', mode: 'raw', html: '\n```html\n<body>hi</body>\n```\n' }), '<body>hi</body>');
    const pc = templatePreviewCard(t, { charName: '林夕' });
    assert.equal(pc.data.name, '林夕');
    assert.equal(pc.statusBar.html, t.html);
    assert.deepEqual(pc.statusBar.sample, clone(t.sample));
    assert.equal(templatePreviewCard({ name: 'x', mode: 'raw', html: '<body>x</body>' }).statusBar.spec.variables.length, 0);
});

// ---------------- 导入导出 ----------------

test('exportStatusBarTemplate / parseStatusBarTemplate：单个模板 JSON 往返（对象或文本）', () => {
    const t = BUILTIN_STATUSBAR_TEMPLATES[3];
    const out = exportStatusBarTemplate(t);
    assert.equal(out.type, STATUS_TEMPLATE_FILE_TYPE);
    assert.equal(out.version, 1);
    assert.equal(out.id, undefined);
    assert.equal(out.builtin, undefined);
    const text = JSON.stringify(out, null, 2);
    for (const input of [JSON.parse(text), text, String.fromCharCode(0xfeff) + text]) {
        const p = parseStatusBarTemplate(input);
        assert.equal(p.name, '赛博朋克');
        assert.equal(p.mode, 'bind');
        assert.equal(p.html, t.html);
        assert.deepEqual(p.spec, clone(t.spec));
        assert.deepEqual(p.sample, clone(t.sample));
        assert.equal(p.theme, 'night');
    }
    assert.equal(statusBarTemplateFileName({ name: 'a/b:c' }), 'a_b_c.状态栏模板.json');
    assert.throws(() => parseStatusBarTemplate('not json'), /JSON/);
    assert.throws(() => parseStatusBarTemplate({ foo: 1 }), /不是/);
    assert.throws(() => parseStatusBarTemplate([1, 2]), /不是/);
    assert.throws(() => parseStatusBarTemplate({ type: STATUS_TEMPLATE_FILE_TYPE, name: 'x', spec: null, html: '' }), /没有变量也没有界面/);
    assert.equal(parseStatusBarTemplate({ type: STATUS_TEMPLATE_FILE_TYPE, spec: USER_TPL.spec }).name, '导入的状态栏模板');
});

test('importStatusBarTemplate：保存为用户模板，重名时自动改名；导入的内置模板变成可编辑的副本', () => {
    const s = settings();
    const a = importStatusBarTemplate(s, exportStatusBarTemplate(BUILTIN_STATUSBAR_TEMPLATES[0]));
    assert.equal(a.name, '通用 2');
    assert.match(a.id, /^sbtpl_/);
    const b = importStatusBarTemplate(s, JSON.stringify(exportStatusBarTemplate(BUILTIN_STATUSBAR_TEMPLATES[0])));
    assert.equal(b.name, '通用 3');
    assert.equal(s.statusBarTemplates.length, 2);
    assert.equal(updateStatusBarTemplate(s, a.id, { name: '我的通用' }).name, '我的通用');
});

test('parseStatusBarTemplate：从角色卡 JSON 导入（NovelLoom 导出的卡 / 社区卡的状态栏正则）', () => {
    const c = card();
    applyStatusBarTemplate(c, BUILTIN_STATUSBAR_TEMPLATES[1], 'structure', { settings: settings() });
    const json = buildCardJson(c, { statusBar: DEFAULT_STATUS_BAR });
    const p = parseStatusBarTemplate(JSON.parse(JSON.stringify(json)));
    assert.equal(p.name, '林夕的状态栏');
    assert.equal(p.mode, 'bind');
    assert.equal(p.html, BUILTIN_STATUSBAR_TEMPLATES[1].html);
    assert.deepEqual(p.spec, clone(BUILTIN_STATUSBAR_TEMPLATES[1].spec));

    const doc = '<!doctype html><html><body><div id="s"></div><script>const d = getAllVariables().stat_data;</script></body></html>';
    const community = {
        spec: 'chara_card_v3',
        data: {
            name: '某卡', first_mes: 'hi',
            extensions: {
                regex_scripts: [
                    { scriptName: '对 AI 隐藏状态栏', findRegex: '<StatusPlaceHolderImpl/>', replaceString: '', promptOnly: true },
                    { scriptName: '状态栏', findRegex: '<StatusPlaceHolderImpl/>', replaceString: `\n\`\`\`\n${doc}\n\`\`\`\n`, promptOnly: false, markdownOnly: true },
                ],
            },
        },
    };
    const q = parseStatusBarTemplate(community);
    assert.equal(q.name, '某卡的状态栏');
    assert.equal(q.mode, 'raw');
    assert.equal(q.spec, null);
    assert.equal(q.html, doc);
    assert.throws(() => parseStatusBarTemplate({ spec: 'chara_card_v2', data: { name: '无', extensions: {} } }), /没有找到状态栏/);
});

test('findStatusBarRegex：跳过停用的、作用于消息本身的、只作用于提示词的、替换出来不是前端页面的正则，多条时取最长的', () => {
    const page = (n) => `\n\`\`\`html\n<body><div>${'x'.repeat(n)}</div><script>getAllVariables()</script></body>\n\`\`\`\n`;
    const re = (name, extra) => ({ scriptName: name, findRegex: '<StatusPlaceHolderImpl/>', replaceString: page(10), markdownOnly: true, promptOnly: false, disabled: false, ...extra });
    const scripts = [
        re('[问题修复]无状态栏开这个', { findRegex: '/(?<!<StatusPlaceHolderImpl\\/>\\s*)$/g', replaceString: '<StatusPlaceHolderImpl/>', disabled: true }),
        re('停用的大界面', { replaceString: page(500), disabled: true }),
        re('改写消息本身', { replaceString: page(400), markdownOnly: false }),
        re('对 AI 隐藏', { replaceString: page(300), promptOnly: true, markdownOnly: false }),
        re('[显示]占位', { findRegex: '/(?:<StatusPlaceHolderImpl\\s*\\/>\\s*)*(<UpdateVariable>)/g', replaceString: '$1 占位文字' }),
        re('小界面'),
        re('不相关的大界面', { findRegex: '<UpdateVariable>', replaceString: page(600) }),
        re('大界面', { replaceString: page(200) }),
        re('没有 markdownOnly 字段', { replaceString: page(100), markdownOnly: undefined }),
        null,
        'x',
    ];
    assert.equal(findStatusBarRegex(scripts).scriptName, '大界面');
    assert.equal(findStatusBarRegex(scripts.filter((s) => s?.scriptName !== '大界面')).scriptName, '没有 markdownOnly 字段', '缺少 markdownOnly 视为仅显示');
    assert.equal(findStatusBarRegex(scripts.slice(0, 5)), null);
    assert.equal(findStatusBarRegex(undefined), null);
    const card = { spec: 'chara_card_v3', data: { name: '某卡', extensions: { regex_scripts: scripts.slice(0, 5) } } };
    assert.throws(() => parseStatusBarTemplate(card), /没有找到状态栏/, '只有修复正则与占位正则时不算有状态栏');
    card.data.extensions.regex_scripts = scripts;
    assert.equal(templateFromCardJson(card).html, unwrapStatusFence(page(200).trim()));
});

// 从用户真实的 MVU 角色卡里抽出来的 JSON（不在仓库里；没有这个目录时跳过）
const REAL_CARDS_DIR = process.env.NL_MVU_CARDS_DIR
    || 'C:\\Users\\DavidZ\\AppData\\Local\\Temp\\claude\\E--Sillytraven-NovelLoom\\deb68bb9-65be-41e5-810d-db393209897b\\scratchpad\\mvu-research\\cards';
const REAL_CARDS = fs.existsSync(REAL_CARDS_DIR) ? fs.readdirSync(REAL_CARDS_DIR).filter((f) => f.endsWith('.chara.json')) : [];
/** 每张卡应选中的状态栏正则（null = 没有状态栏界面，导入时报「没有找到」） */
const REAL_CARD_PICKS = {
    'WuWa Solaris-3 MVU Edition': '[状态栏]MVU浪潮状态栏',
    '云无心 v4.2 MVUEJS 重构版': '状态栏界面',
    '催眠app二改MVU': '前端',
    '全职法师-mvu': '状态栏美化',
    '女奴训练师_DND5Emvu版本': '状态栏美化',
    '家族模拟器-MVU': null,
    '星月私立高等学院 MVU 2.5.0': '状态栏美化 HUD v2.5.0-r4',
    '末日之后 MVU 0.4.1': null,
    '永恒之美艺术展览馆·MVU Zod': '永恒之美·状态栏',
    '皮兰港-MVU·ZOD': '[应该是没问题了的]状态栏',
    '魔法少女MVU测试': null,
    '魔法少女侵蚀技术检证实验记录MVU.v0.2': null,
};

test('真实 MVU 角色卡：从卡里导入状态栏时选中真正的状态栏正则', { skip: REAL_CARDS.length ? false : `没有真实卡片目录（${REAL_CARDS_DIR}，可用环境变量 NL_MVU_CARDS_DIR 指定）` }, () => {
    let known = 0;
    for (const f of REAL_CARDS) {
        const key = f.replace(/\.chara\.json$/, '');
        const json = JSON.parse(fs.readFileSync(path.join(REAL_CARDS_DIR, f), 'utf8'));
        const scripts = (json.data || json).extensions?.regex_scripts || [];
        const bar = findStatusBarRegex(scripts);
        if (Object.prototype.hasOwnProperty.call(REAL_CARD_PICKS, key)) {
            assert.equal(bar?.scriptName ?? null, REAL_CARD_PICKS[key], key);
            known++;
        }
        if (!bar) {
            assert.throws(() => parseStatusBarTemplate(json), /没有找到状态栏/, key);
            continue;
        }
        assert.ok(!bar.disabled && bar.markdownOnly !== false && !bar.promptOnly, key);
        const html = unwrapStatusFence(String(bar.replaceString).trim());
        assert.ok(isFrontendText(html), key);
        const t = templateFromCardJson(json);
        assert.equal(t.mode, 'raw', key);
        assert.equal(t.html, html, key);
        try {
            assert.equal(parseStatusBarTemplate(json).html, html, key);
        } catch (e) {
            assert.match(e.message, /太大/, `${key}：${e.message}`); // 超过 200K 的界面（星月的 HUD 有 266K）不能存成模板
        }
    }
    assert.ok(known >= 1, '目录里没有任何已知的卡');
});

test('applyConfig：statusBar 按字段合并，statusBarTemplates 按 id 合并（保留本机其他模板，跳过无 id 项）', () => {
    const s = settings();
    const mine = addStatusBarTemplate(s, USER_TPL);
    const other = addStatusBarTemplate(s, { ...USER_TPL, name: '会被覆盖' });
    applyConfig(s, {
        type: 'novel_loom_config',
        settings: {
            statusBar: { maxVars: 8, analysisLang: 'zh', showDepth: null },
            statusBarTemplates: [
                { ...exportStatusBarTemplate(BUILTIN_STATUSBAR_TEMPLATES[2]), id: other.id, name: '来自配置' },
                { ...exportStatusBarTemplate(BUILTIN_STATUSBAR_TEMPLATES[3]), id: 'sbtpl_new', name: '新模板' },
                { name: '没有 id 的模板', spec: USER_TPL.spec },
            ],
        },
    });
    assert.equal(s.statusBar.maxVars, 8);
    assert.equal(s.statusBar.analysisLang, 'zh');
    assert.equal(s.statusBar.showDepth, null);
    assert.equal(s.statusBar.mvuUrl, DEFAULT_STATUS_BAR.mvuUrl, '没给的字段保留');
    const list = listStatusBarTemplates(s).filter((t) => !t.builtin);
    assert.deepEqual(list.map((t) => t.name), ['我的模板', '来自配置', '新模板']);
    assert.equal(list[0].id, mine.id);
    assert.equal(list[1].id, other.id);
    assert.equal(list[1].html, BUILTIN_STATUSBAR_TEMPLATES[2].html);
});
