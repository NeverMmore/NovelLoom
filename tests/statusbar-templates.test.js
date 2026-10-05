// 状态栏模板：内置模板的完整性（变量表、界面检查、导出往返、真实 zod）、增删改查与内置保护、套用、导入导出、配置合并；
// v0.12：「多人群像」模板（分组字段、立绘位、分页、详情层的运行时行为）、模板自带的变量上限、模板携带立绘设置
// zod 是 devDependency：没装（没跑 npm install）时相关用例自动跳过。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

import {
    BUILTIN_STATUSBAR_TEMPLATES, STATUS_TEMPLATE_FILE_TYPE, STATUS_TEMPLATE_MODE_LABELS, TEMPLATE_VAR_CAP_MAX, addStatusBarTemplate,
    applyStatusBarTemplate, duplicateStatusBarTemplate, exportStatusBarTemplate, findStatusBarRegex, getStatusBarTemplate,
    importStatusBarTemplate, isBuiltinStatusBarTemplate, listStatusBarTemplates, parseStatusBarTemplate, removeStatusBarTemplate,
    statusBarTemplateFileName, statusBarVarCap, templateFromCardJson, templateFromStatusBar, templatePreviewCard, templateStyleRef,
    templateVarCap, uniqueStatusBarTemplateName, updateStatusBarTemplate,
} from '../src/statusbar-templates.js';
import {
    STATUS_MODE_LABELS, buildInitialState, buildStatusRegexReplace, buildStatusRegexScripts, compileSchemaScript, countSpecLeaves,
    ensureStatusBar, isFrontendText, lintStatusHtml, normalizePortraits, normalizeStatusSpec, parseStateWithSpec, portraitCandidates,
    portraitSampleCandidates, seedRecordEntries, unwrapStatusFence,
} from '../src/statusbar.js';
import { buildPreviewSrcdoc, cleanFragment, compileStatusDocument, renderDefaultFragment } from '../src/statusbar-runtime.js';
import { DEFAULT_SETTINGS, DEFAULT_STATUS_BAR } from '../src/constants.js';
import { buildCardJson } from '../src/cards.js';
import { applyConfig } from '../src/io.js';
import { mergeDefaults } from '../src/utils.js';
import { Element, openStatusDocument } from './minidom.js';
import { PROSES, scriptsOf, stFixMarkdown, stIframeText } from './stsim.js';

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

test('内置模板：正好五个（通用 / RPG / 校园恋爱 / 赛博朋克 / 多人群像），只读且已冻结', () => {
    assert.deepEqual(BUILTIN_STATUSBAR_TEMPLATES.map((t) => t.name), ['通用', 'RPG', '校园恋爱', '赛博朋克', '多人群像']);
    const ids = BUILTIN_STATUSBAR_TEMPLATES.map((t) => t.id);
    assert.equal(new Set(ids).size, 5);
    assert.equal(ids[4], 'builtin_ensemble');
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

test('内置模板：变量表不超过各自的上限（默认 12，模板自带的 maxVars 最多 30），经 normalizeStatusSpec 不变且没有警告', () => {
    for (const t of BUILTIN_STATUSBAR_TEMPLATES) {
        const n = countSpecLeaves(t.spec);
        // 只有变量多于默认上限的模板才带自己的上限，而且正好是它需要的数
        assert.equal(t.maxVars, n > DEFAULT_STATUS_BAR.maxVars ? n : null, t.name);
        assert.ok(n >= 6 && n <= (t.maxVars ?? DEFAULT_STATUS_BAR.maxVars) && n <= TEMPLATE_VAR_CAP_MAX, `${t.name}：${n} 个叶子`);
        const warnings = [];
        const again = normalizeStatusSpec(t.spec, { maxVars: t.maxVars ?? DEFAULT_STATUS_BAR.maxVars, warnings });
        assert.deepEqual(warnings, [], t.name);
        assert.deepEqual(again, clone(t.spec), `${t.name} 的变量表应已规范化`);
        assert.ok(t.spec.title);
        assert.equal(t.portraits, null, '内置模板不带立绘');
    }
    assert.deepEqual(BUILTIN_STATUSBAR_TEMPLATES.filter((t) => t.maxVars).map((t) => [t.name, t.maxVars]), [['多人群像', 15]]);
});

test('内置模板：界面通过 lintStatusHtml（无错误、无警告），只用 {{user}}/{{char}}，不引用外部资源', () => {
    for (const t of BUILTIN_STATUSBAR_TEMPLATES) {
        const r = lintStatusHtml(t.html, { mode: 'bind', spec: t.spec });
        assert.deepEqual(r.errors, [], `${t.name}：${r.errors.join('；')}`);
        assert.deepEqual(r.warnings, [], `${t.name}：${r.warnings.join('；')}`);
        for (const m of t.html.matchAll(/\{\{([^{}]*)\}\}/g)) assert.ok(['user', 'char'].includes(m[1]), `${t.name} 出现了 {{${m[1]}}}`);
        assert.ok(!/https?:\/\//i.test(t.html), `${t.name} 引用了外部地址`);
        assert.ok(!/localStorage|sessionStorage|indexedDB|`/i.test(t.html), t.name);
        // 图片只能是运行时填的立绘位：<img data-nl-portrait…>，不写地址
        for (const m of t.html.matchAll(/<img\b[^>]*>/gi)) {
            assert.match(m[0], /\bdata-nl-portrait\b/, `${t.name}：${m[0]}`);
            assert.doesNotMatch(m[0], /\bsrc(?:set)?\s*=/i, `${t.name}：${m[0]}`);
        }
        assert.ok(!/url\(|data:image/i.test(t.html), `${t.name} 不内嵌图片`);
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
    assert.deepEqual(list.map((t) => t.id), ['builtin_general', 'builtin_rpg', 'builtin_campus', 'builtin_cyberpunk', 'builtin_ensemble', 'sbtpl_a']);
    assert.equal(list[0].name, '通用');
    assert.equal(list[0].builtin, true);
    const a = list[5];
    assert.equal(a.name, 'A');
    assert.equal(a.builtin, false);
    assert.equal(a.mode, 'auto', '没有界面代码的模板按内置排版处理');
    assert.equal(a.theme, 'clean');
    list[0].spec.variables.length = 0;
    assert.ok(BUILTIN_STATUSBAR_TEMPLATES[0].spec.variables.length > 0, '改返回值不影响内置模板');
    assert.equal(listStatusBarTemplates({}).length, 5, '没有 statusBarTemplates 字段也能用');
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
    assert.equal(listStatusBarTemplates(s).filter((x) => x.builtin).length, 5);
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

// ---------------- v0.12：多人群像模板 ----------------

const ENS = BUILTIN_STATUSBAR_TEMPLATES.find((t) => t.id === 'builtin_ensemble');
// 1×1 与 2×1 的 PNG（合法的 data:image 地址，不连任何外部主机）
const PNG_A = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGM4ERAAAANMAWmFQTGjAAAAAElFTkSuQmCC';
const PNG_B = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAIAAAB7QOjdAAAAD0lEQVR4nGMICDgREHACAAjvAtGOlatMAAAAAElFTkSuQmCC';
const ENS_PORTRAITS = {
    characters: { 沈遥: [{ url: PNG_A }, { url: PNG_B, when: '好感 >= 60' }], 林栖: [{ url: PNG_A }] },
    pools: [{ record: 'NPC', field: '阵营', pools: { 本地居民: [PNG_A] }, fallback: [PNG_B] }],
};

function ensembleDoc(portraits = null) {
    const statusBar = { mode: 'bind', html: ENS.html, spec: clone(ENS.spec), theme: ENS.theme };
    if (portraits) statusBar.portraits = portraits;
    return compileStatusDocument({ id: 'c1', statusBar });
}

function openEnsemble({ stat = clone(ENS.sample), portraits = null } = {}) {
    return openStatusDocument(ensembleDoc(portraits), { stat });
}

/** 卡片 / 详情的名字（第一个 data-nl-key） */
const keyText = (el) => el?.querySelector('[data-nl-key]')?.textContent ?? '';
const pressKey = (doc, key) => {
    for (const l of doc.listeners.keydown || []) l.fn.call(doc, { key, preventDefault() {} });
};
const fireChange = (doc, target) => {
    for (const l of doc.listeners.change || []) l.fn.call(doc, { target });
};

test('多人群像模板：世界/主角 + 主要角色（含 服饰 分组、好感阶段）+ NPC 两个记录，共 15 个变量；不预置具体角色，示例是 3 个主要角色 + 2 个 NPC', () => {
    assert.ok(ENS);
    assert.equal(ENS.mode, 'bind');
    assert.equal(ENS.theme, 'night');
    assert.deepEqual(ENS.spec.variables.map((v) => v.path), ['世界.时间', '世界.地点', '主角.身份', '主要角色', 'NPC']);
    const [, , , main, npc] = ENS.spec.variables;
    assert.deepEqual(main.value.fields.map((f) => f.key), ['身份', '阵营', '好感', '心情', '心理活动', '服饰']);
    const outfit = main.value.fields[5];
    assert.equal(outfit.type, 'object');
    assert.deepEqual(outfit.fields.map((f) => [f.key, f.type]), [['上衣', 'string'], ['下装', 'string'], ['配饰', 'string']]);
    assert.deepEqual(npc.value.fields.map((f) => f.key), ['身份', '阵营', '好感', '心情']);
    for (const rec of [main, npc]) {
        const aff = rec.value.fields.find((f) => f.key === '好感');
        assert.deepEqual([aff.min, aff.max, aff.integer], [0, 100, true]);
        assert.deepEqual(aff.stages.map((s) => s.min), [0, 20, 40, 60, 80], '五个阶段，正好对应五段好感条');
        assert.equal(rec.value.fields.find((f) => f.key === '心情').type, 'enum');
        assert.deepEqual(rec.init, {}, '变量表里不预置具体角色');
        assert.ok(rec.check.some((c) => /insert/.test(c)));
    }
    assert.equal(countSpecLeaves(ENS.spec), 15);
    assert.deepEqual(Object.keys(ENS.sample.主要角色).length, 3);
    assert.deepEqual(Object.keys(ENS.sample.NPC).length, 2);
    // 示例里的名字只在示例数据里，界面代码不写死任何人；也没有用户示例卡里的那类字段
    for (const k of [...Object.keys(ENS.sample.主要角色), ...Object.keys(ENS.sample.NPC)]) assert.ok(!ENS.html.includes(k), k);
    const all = JSON.stringify([ENS.spec, ENS.sample, ENS.html, ENS.desc]);
    for (const bad of ['NSFW', '洗脑', '怀孕', '受孕', '淫', '身材', '胸', '催眠']) assert.ok(!all.includes(bad), bad);
    // 世界/旁白卡：把项目的主要角色预先填进「主要角色」，结果仍是规范化的、初始值能通过校验
    const seeded = seedRecordEntries(ENS.spec, '主要角色', ['甲', '乙']);
    assert.deepEqual(seeded.added, ['甲', '乙']);
    assert.deepEqual(normalizeStatusSpec(seeded.spec, { maxVars: ENS.maxVars }), seeded.spec);
    assert.deepEqual(seeded.spec.variables[3].init.甲, { 身份: '', 阵营: '', 好感: 30, 心情: '平静', 心理活动: '', 服饰: { 上衣: '', 下装: '', 配饰: '' } });
    assert.equal(parseStateWithSpec(seeded.spec, buildInitialState(seeded.spec)).ok, true);
});

test('多人群像模板：界面结构——两个记录各有卡片网格与详情层，立绘位 + 换一张按钮，服饰用分组子模板，按钮不嵌套，详情默认隐藏', () => {
    const h = ENS.html;
    assert.equal(h.split('data-nl-each="主要角色"').length - 1, 2, '主要角色：卡片网格 + 详情层');
    assert.equal(h.split('data-nl-each="NPC"').length - 1, 2, 'NPC：卡片网格 + 详情层');
    assert.equal(h.split('data-nl-group="服饰"').length - 1, 1, '服饰分组只在主要角色的详情里');
    assert.equal(h.split('<img class="qx-img" data-nl-portrait="" alt="">').length - 1, 4, '卡片与详情各有立绘位');
    assert.equal(h.split('<button type="button" class="qx-swap" data-nl-portrait-next=""').length - 1, 4);
    assert.equal(h.split('<section class="qx-dt" role="dialog" hidden>').length - 1, 2);
    assert.ok(h.includes('data-nl-item-bar="好感"') && h.includes('data-nl-item-stage="好感"'));
    assert.ok(h.includes('data-nl-item="服饰.上衣"') === false, '服饰按分组子模板逐项生成，不写死字段');
    assert.ok(/<input class="qx-radio" type="radio" name="qx-tab" id="qx-t-main" checked>/.test(h));
    for (const p of ['世界.时间', '世界.地点', '主角.身份']) assert.ok(h.includes(`data-nl-text="${p}"`), p);
    // <button> 里不能再放 <button>（浏览器会把外层提前结束）
    for (const m of h.matchAll(/<button\b[^>]*>([\s\S]*?)<\/button>/g)) assert.ok(!m[1].includes('<button'), m[0].slice(0, 80));
    // 脚本里只用 minidom 也支持的选择器（没有 > 、#id），也不碰存储与上层页面
    const js = scriptsOf(h).join('\n');
    for (const m of js.matchAll(/querySelector(?:All)?\('([^']*)'\)|closest\('([^']*)'\)/g)) assert.ok(!/[>#]/.test(m[1] ?? m[2]), m[0]);
    assert.ok(!/\b(?:parent|top|opener)\s*[.[]|Storage|cookie/.test(js));
});

test('多人群像模板（运行时）：卡片与详情按记录生成；分页计数、好感阶段颜色、分组字段、心理活动气泡、没有立绘时的占位块', () => {
    const env = openEnsemble();
    const d = env.document;
    assert.deepEqual(env.errors, []);
    const cards = d.querySelectorAll('.qx-card');
    assert.deepEqual(cards.map(keyText), ['沈遥', '林栖', '白芷', '老周', '巡夜卫兵']);
    assert.deepEqual(cards.map((c) => c.getAttribute('data-nl-stage-index')), ['3', '2', '0', '2', '1'], '好感阶段抄到卡片根元素上');
    assert.deepEqual(cards.map((c) => c.querySelector('.qx-st').textContent), ['亲近', '友好', '冷淡', '友好', '普通']);
    assert.deepEqual(cards.map((c) => c.querySelector('.qx-seg').style.props['--nl-pct']), ['68.0%', '42.0%', '15.0%', '55.0%', '20.0%']);
    assert.deepEqual(cards.map((c) => c.querySelector('.qx-mood').getAttribute('data-nl-value')), ['愉快', '紧张', '平静', '愉快', '疲惫']);
    assert.deepEqual(d.querySelectorAll('[data-qx-count]').map((e) => e.textContent), ['3', '2', '3', '2']);
    assert.equal(cards[0].querySelector('.qx-open').getAttribute('aria-label'), '沈遥：查看详情');
    // 没配立绘：每个立绘位都是带首字的占位块，换一张按钮隐藏
    for (const c of cards) {
        assert.equal(c.querySelector('img[data-nl-portrait]').getAttribute('data-nl-portrait-state'), 'empty');
        assert.equal(c.querySelector('.nl-portrait-ph').textContent, [...keyText(c)][0]);
        assert.equal(c.querySelector('.nl-portrait-ph').className, 'qx-img nl-portrait-ph', '占位块带上 <img> 的 class，跟着立绘位的尺寸');
        assert.equal(c.querySelector('.qx-swap').hidden, true);
    }
    const dts = d.querySelectorAll('.qx-dt');
    assert.deepEqual(dts.map(keyText), ['沈遥', '林栖', '白芷', '老周', '巡夜卫兵']);
    assert.ok(dts.every((x) => x.hidden), '详情默认都隐藏');
    assert.equal(dts[0].getAttribute('data-nl-stage-index'), '3');
    const rows = (dt) => dt.querySelectorAll('.qx-kvr').map((r) => `${r.querySelector('dt').textContent}=${r.querySelector('dd').textContent}`);
    assert.deepEqual(rows(dts[0]), ['上衣=靛青短褂', '下装=灰布长裤', '配饰=铜框眼镜']);
    assert.deepEqual(rows(dts[2]), ['上衣=白麻长衫', '下装=束脚裤', '配饰=—']);
    assert.equal(dts[0].querySelector('.qx-think').textContent, '这次的货单总算对上了。');
    assert.equal(dts[0].querySelector('.qx-think').hidden, false);
    assert.equal(dts[2].querySelector('.qx-think').hidden, true, '没有心理活动时不显示气泡');
    assert.equal(dts[0].querySelector('.qx-chip').textContent, '亲近');
    assert.equal(dts[3].querySelector('[data-nl-group]'), null, 'NPC 的详情没有服饰');
    assert.equal(dts[3].querySelector('.qx-think'), null);
    assert.equal(dts[3].querySelector('.qx-kick').textContent, 'NPC');
    // 阵营为空时不显示阵营标签
    const st2 = clone(ENS.sample);
    st2.NPC.老周.阵营 = '';
    env.update(st2);
    assert.equal(d.querySelectorAll('.qx-card')[3].querySelector('.qx-fac').hidden, true);
    // 记录为空：显示空状态提示，计数为 0
    env.update({ ...clone(ENS.sample), 主要角色: {}, NPC: {} });
    assert.equal(d.querySelectorAll('.qx-card').length, 0);
    assert.deepEqual(d.querySelectorAll('.nl-each-empty').map((e) => e.textContent), ['还没有主要角色', '还没有登场的 NPC']);
    assert.deepEqual(d.querySelectorAll('[data-qx-count]').map((e) => e.textContent), ['0', '0', '0', '0']);
    assert.deepEqual(env.errors, []);
});

test('多人群像模板（运行时）：点卡片打开对应详情；× / Esc / 点外面 / 切换分页关闭，焦点回到卡片；变量更新后详情保持，条目被删掉时自动关闭', () => {
    const focused = [];
    Element.prototype.focus = function focus() { focused.push(this); };
    try {
        const stat = clone(ENS.sample);
        stat.主要角色.老周 = { ...stat.主要角色.白芷, 身份: '同名的主要角色' }; // 两个记录里有同名条目：按记录区分
        const env = openEnsemble({ stat });
        const d = env.document;
        const card = (rec, name) => d.querySelectorAll('.qx-card').find((c) => keyText(c) === name && c.closest('[data-nl-each]').getAttribute('data-nl-each') === rec);
        const shown = () => d.querySelectorAll('.qx-dt').filter((x) => !x.hidden).map((x) => `${x.closest('[data-nl-each]').getAttribute('data-nl-each')}/${keyText(x)}`);
        const isOpen = () => d.querySelector('.qx-stage').classList.contains('is-open');
        const inert = () => d.querySelectorAll('.qx-panel').map((p) => p.hasAttribute('inert'));

        d.click(card('主要角色', '林栖').querySelector('.qx-open'));
        assert.deepEqual(shown(), ['主要角色/林栖']);
        assert.ok(isOpen());
        assert.deepEqual(inert(), [true, true], '详情开着时下面的卡片不可操作');
        assert.equal(focused.at(-1).className, 'qx-x', '焦点移到关闭按钮');
        assert.equal(d.querySelector('.qx-dt:not([hidden])').getAttribute('aria-label'), '林栖的详情');
        d.click(d.querySelector('.qx-dt:not([hidden]) .qx-kv'));
        assert.deepEqual(shown(), ['主要角色/林栖'], '点详情里面不关闭');
        pressKey(d, 'Enter');
        assert.deepEqual(shown(), ['主要角色/林栖']);
        pressKey(d, 'Escape');
        assert.deepEqual(shown(), []);
        assert.ok(!isOpen());
        assert.deepEqual(inert(), [false, false]);
        assert.equal(focused.at(-1).className, 'qx-open');
        assert.equal(keyText(focused.at(-1).closest('.qx-card')), '林栖', 'Esc 后焦点回到刚才那张卡片');

        d.click(card('主要角色', '沈遥').querySelector('.qx-open'));
        d.click(d.querySelector('.qx-dt:not([hidden]) .qx-x'));
        assert.deepEqual(shown(), []);
        assert.equal(keyText(focused.at(-1).closest('.qx-card')), '沈遥');

        d.click(card('主要角色', '沈遥').querySelector('.qx-open'));
        d.click(d.querySelector('.qx-stage'));
        assert.deepEqual(shown(), [], '点变暗的卡片区域关闭');

        d.click(card('主要角色', '白芷').querySelector('.qx-open'));
        const n = focused.length;
        fireChange(d, d.querySelectorAll('.qx-radio')[1]);
        assert.deepEqual(shown(), [], '切换分页时关闭');
        assert.equal(focused.length, n, '切换分页不抢焦点');

        // 同名条目按记录区分（详情开着时卡片区是 inert，浏览器会拦下点击；这里先关掉再点另一张）
        d.click(card('NPC', '老周').querySelector('.qx-open'));
        assert.deepEqual(shown(), ['NPC/老周']);
        assert.equal(d.querySelector('.qx-dt:not([hidden]) .qx-dr').textContent, '旅店老板');
        pressKey(d, 'Escape');
        assert.equal(focused.at(-1).closest('[data-nl-each]').getAttribute('data-nl-each'), 'NPC', '焦点回到 NPC 里的那张');
        d.click(card('主要角色', '老周').querySelector('.qx-open'));
        assert.deepEqual(shown(), ['主要角色/老周']);
        assert.equal(d.querySelector('.qx-dt:not([hidden]) .qx-dr').textContent, '同名的主要角色');
        pressKey(d, 'Escape');

        // 变量更新：详情重新生成，仍显示同一个角色，颜色跟着新阶段
        d.click(card('NPC', '老周').querySelector('.qx-open'));
        const next = clone(stat);
        next.NPC.老周.好感 = 90;
        env.update(next);
        assert.deepEqual(shown(), ['NPC/老周']);
        assert.equal(d.querySelector('.qx-dt:not([hidden])').getAttribute('data-nl-stage-index'), '4');
        assert.equal(d.querySelector('.qx-dt:not([hidden]) .qx-chip').textContent, '信赖');
        assert.ok(isOpen());
        // 条目被删掉：详情自动关闭，卡片区恢复可用
        delete next.NPC.老周;
        env.update(next);
        assert.deepEqual(shown(), []);
        assert.ok(!isOpen());
        assert.deepEqual(inert(), [false, false]);
        assert.deepEqual(d.querySelectorAll('[data-qx-count]').map((e) => e.textContent), ['4', '1', '4', '1']);
        assert.deepEqual(env.errors, []);
    } finally {
        delete Element.prototype.focus;
    }
});

test('多人群像模板（运行时）+ 立绘：卡片和详情显示已解锁的最高一张，NPC 按阵营取图池；换一张不会打开详情，并同步到详情里', () => {
    const env = openEnsemble({ portraits: ENS_PORTRAITS });
    const d = env.document;
    assert.deepEqual(env.errors, []);
    const imgOf = (el) => el.querySelector('img[data-nl-portrait]');
    const cards = d.querySelectorAll('.qx-card');
    assert.deepEqual(cards.map((c) => imgOf(c).getAttribute('src') ?? null), [PNG_B, PNG_A, null, PNG_A, PNG_B], '沈遥好感 68 解锁第二张；白芷没有图；老周按「本地居民」取图池，卫兵用兜底');
    assert.deepEqual(cards.map((c) => imgOf(c).getAttribute('data-nl-portrait-state')), ['loading', 'loading', 'empty', 'loading', 'loading']);
    assert.deepEqual(cards.map((c) => c.querySelector('.qx-swap').hidden), [false, true, true, true, true], '只有沈遥有两张可换');
    const img = imgOf(cards[0]);
    img.complete = true;
    img.naturalWidth = 90;
    img.fire('load');
    assert.equal(img.getAttribute('data-nl-portrait-state'), 'ok');
    assert.equal(img.nextElementSibling.hidden, true, '加载成功后占位块隐藏');
    // 换一张：运行时在捕获阶段处理并阻止冒泡，卡片不会被打开
    d.click(cards[0].querySelector('.qx-swap'));
    assert.equal(imgOf(cards[0]).getAttribute('src'), PNG_A);
    assert.ok(!d.querySelector('.qx-stage').classList.contains('is-open'), '换一张不会打开详情');
    assert.equal(env.window.localStorage.getItem('nl-sb:c1:沈遥'), PNG_A);
    assert.equal(imgOf(d.querySelectorAll('.qx-dt')[0]).getAttribute('src'), PNG_A, '详情里的立绘一起换');
    d.click(cards[0].querySelector('.qx-open'));
    assert.equal(d.querySelectorAll('.qx-dt').filter((x) => !x.hidden).length, 1);
    assert.deepEqual(env.errors, []);
});

test('多人群像模板：带立绘的文档也能原样经过酒馆的正则替换、「自动修复 Markdown」与一层实体解码，每个脚本都能解析', () => {
    for (const portraits of [null, ENS_PORTRAITS]) {
        const doc = ensembleDoc(portraits);
        assert.equal(doc.includes('window.NL_PORTRAITS = '), !!portraits);
        for (const line of doc.split('\n')) {
            assert.equal((line.split('*').length - 1) % 2, 0, line.slice(0, 100));
            assert.equal((line.split('"').length - 1) % 2, 0, line.slice(0, 100));
        }
        const replace = buildStatusRegexReplace(doc);
        for (const prose of PROSES) {
            const shown = stIframeText(stFixMarkdown(`${prose}\n\n${replace}`, true));
            assert.equal(shown, doc, `正文：${prose}`);
            for (const code of scriptsOf(shown)) assert.doesNotThrow(() => new vm.Script(code), prose);
        }
    }
});

test('多人群像模板：预览页面（模板预览卡）带上立绘配置，{{user}} 换成名字；没有立绘时不多那一行', () => {
    const plain = buildPreviewSrcdoc(templatePreviewCard(ENS, { charName: '旁白' }), ENS.sample, { user: '阿远', char: '旁白' });
    assert.ok(!plain.includes('window.NL_PORTRAITS = '));
    assert.ok(plain.includes('阿远') && !plain.includes('{{user}}'));
    const pc = templatePreviewCard({ ...ENS, portraits: ENS_PORTRAITS }, { charName: '旁白' });
    assert.deepEqual(pc.statusBar.portraits, normalizePortraits(ENS_PORTRAITS));
    const withPics = buildPreviewSrcdoc(pc, ENS.sample, { user: '阿远', char: '旁白' });
    assert.ok(withPics.includes('window.NL_PORTRAITS = ') && withPics.includes(PNG_B));
    assert.equal(templatePreviewCard(ENS).statusBar.portraits, undefined);
});

// ---------------- v0.12：模板自带的变量上限 ----------------

test('模板自带的变量上限：套用「多人群像」时按 15 保留全部变量（并提示），显式 maxVars 仍然截断；templateVarCap / statusBarVarCap', () => {
    const s = settings();
    assert.equal(s.statusBar.maxVars, 12);
    assert.equal(templateVarCap(ENS, s), 15);
    assert.equal(templateVarCap(BUILTIN_STATUSBAR_TEMPLATES[0], s), 12);
    assert.equal(templateVarCap(ENS, { statusBar: { maxVars: 20 } }), 20, '设置里的上限更大时用设置的');
    assert.equal(templateVarCap({ maxVars: 99 }, s), TEMPLATE_VAR_CAP_MAX);
    assert.equal(templateVarCap({ maxVars: 'x' }, null), 12);
    assert.equal(templateVarCap(null, { statusBar: { maxVars: 5 } }), 5);

    const c = card();
    const r = applyStatusBarTemplate(c, getStatusBarTemplate(s, 'builtin_ensemble'), 'structure', { settings: s });
    assert.deepEqual(c.statusBar.spec, clone(ENS.spec));
    assert.equal(countSpecLeaves(c.statusBar.spec), 15);
    assert.ok(r.warnings.some((w) => /15 个变量.*上限 12.*15.*全部/.test(w)), r.warnings.join('；'));
    assert.deepEqual(c.statusBar.lint, { errors: [], warnings: [] }, '界面绑定的路径都还在');
    assert.equal(c.statusBar.maxVars, 15, '沿用结构时把模板的上限记在卡上');
    assert.equal(statusBarVarCap(c, s), 15, '卡片记着更大的上限');
    assert.equal(statusBarVarCap(card(), s), 12);
    c.statusBar.templateId = 'sbtpl_gone';
    assert.equal(statusBarVarCap(c, s), 15, '上限记在卡上，不再跟着 templateId 去找模板（模板删了、换了都不变）');

    const c2 = card();
    const r2 = applyStatusBarTemplate(c2, ENS, 'structure', { settings: s, maxVars: 12 });
    assert.deepEqual(c2.statusBar.spec.variables.map((v) => v.path), ['世界.时间', '世界.地点', '主角.身份', '主要角色']);
    assert.ok(r2.warnings.some((w) => /上限 12/.test(w)) && !r2.warnings.some((w) => /模板自带/.test(w)));

    const s20 = settings();
    s20.statusBar.maxVars = 20;
    const r3 = applyStatusBarTemplate(card(), ENS, 'structure', { settings: s20 });
    assert.ok(!r3.warnings.some((w) => /模板自带/.test(w)), '设置的上限够用时不提示');
    assert.equal(countSpecLeaves(r3.statusBar.spec), 15);

    // 复制、导出、导入都保留模板自带的上限；没有时不写这个字段
    const dup = duplicateStatusBarTemplate(s, 'builtin_ensemble');
    assert.equal(dup.maxVars, 15);
    assert.equal(templateVarCap(getStatusBarTemplate(s, dup.id), s), 15);
    const out = exportStatusBarTemplate(ENS);
    assert.equal(out.maxVars, 15);
    assert.equal('portraits' in out, false);
    assert.equal('maxVars' in exportStatusBarTemplate(BUILTIN_STATUSBAR_TEMPLATES[0]), false);
    assert.equal(parseStatusBarTemplate(JSON.stringify(out)).maxVars, 15);
    const u = addStatusBarTemplate(s, { ...USER_TPL, name: '上限', maxVars: 99 });
    assert.equal(u.maxVars, 30);
    assert.equal(updateStatusBarTemplate(s, u.id, { maxVars: 1 }).maxVars, 3);
    assert.equal(updateStatusBarTemplate(s, u.id, { maxVars: '无' }).maxVars, null);
    assert.equal(addStatusBarTemplate(s, { ...USER_TPL, name: '没写上限' }).maxVars, null);
    // 把卡片存成模板：变量多于默认上限时记下需要的上限
    assert.equal(templateFromStatusBar(c2).maxVars, null);
    const c3 = card();
    applyStatusBarTemplate(c3, ENS, 'structure', { settings: s });
    assert.equal(templateFromStatusBar(c3).maxVars, 15);
});

test('卡片自己的变量上限（statusBar.maxVars）：沿用结构「多人群像」后再「只借外观」换模板，上限仍是 15，变量表校验不丢 NPC（审查复现 t4）', () => {
    const s = settings();
    const c = { id: 'c1', kind: 'world', data: { name: '旁白', first_mes: 'x', alternate_greetings: [] } };
    applyStatusBarTemplate(c, getStatusBarTemplate(s, 'builtin_ensemble'), 'structure', { settings: s });
    assert.equal(countSpecLeaves(c.statusBar.spec), 15);
    assert.equal(statusBarVarCap(c, s), 15);
    const r = applyStatusBarTemplate(c, getStatusBarTemplate(s, 'builtin_cyberpunk'), 'look', { settings: s });
    assert.equal(c.statusBar.templateId, 'builtin_cyberpunk');
    assert.deepEqual(r.ai, { parts: ['html'], templateMode: 'style' });
    assert.equal(c.statusBar.maxVars, 15, '只借外观不动卡片的上限');
    assert.equal(statusBarVarCap(c, s), 15);
    // 对话框的变量表校验（statusbar-dialog.js 的 validate）用的就是 statusBarVarCap
    const w = [];
    const re = normalizeStatusSpec({ title: c.statusBar.spec.title, variables: c.statusBar.spec.variables }, { charName: '旁白', maxVars: statusBarVarCap(c, s), warnings: w });
    assert.deepEqual(re.variables.map((v) => v.path), ['世界.时间', '世界.地点', '主角.身份', '主要角色', 'NPC']);
    assert.deepEqual(w, []);
    // 内置排版的模板（只借外观直接切到 auto）也一样
    applyStatusBarTemplate(c, { id: 'x_auto', name: '内置', mode: 'auto', theme: 'paper', spec: null, html: '' }, 'look', { settings: s });
    assert.equal(statusBarVarCap(c, s), 15);
    // 再沿用结构套一个小模板：上限回到那个模板的（设置里的 12），卡上的变量也换成了它的
    applyStatusBarTemplate(c, getStatusBarTemplate(s, 'builtin_general'), 'structure', { settings: s });
    assert.equal(c.statusBar.maxVars, 12);
    assert.equal(statusBarVarCap(c, s), 12);
});

test('statusBarVarCap：取设置里的上限、卡片记着的上限、现有变量数三者的最大值；leaves 可指定（例如打开对话框时的变量数）', () => {
    const s = settings();
    const c = card();
    ensureStatusBar(c, s);
    assert.equal(c.statusBar.maxVars, null, '新建的状态栏跟随设置');
    assert.equal(statusBarVarCap(c, s), 12);
    assert.equal(statusBarVarCap(null, s), 12);
    assert.equal(statusBarVarCap(c, { statusBar: { maxVars: 20 } }), 20);
    // 没有记下上限、但变量比设置里的多（例如设置里的上限后来调小了，或旧版本套用的模板）：按现有变量数，编辑时不会丢
    c.statusBar.spec = normalizeStatusSpec(ENS.spec, { maxVars: 30 });
    assert.equal(statusBarVarCap(c, s), 15);
    assert.equal(statusBarVarCap(c, s, { leaves: 18 }), 18);
    assert.equal(statusBarVarCap(c, s, { leaves: 3 }), 12);
    // 卡上记的上限：超出 3~30 的按 3~30，无效的忽略
    c.statusBar.spec = { title: 't', variables: [] };
    c.statusBar.maxVars = 99;
    assert.equal(statusBarVarCap(c, s), TEMPLATE_VAR_CAP_MAX);
    c.statusBar.maxVars = '很多';
    assert.equal(statusBarVarCap(c, s), 12);
    // 设置 20 下套用「多人群像」：记下 20；设置调回 12 后仍按 20（卡上的变量是在 20 下建的）
    const s20 = settings();
    s20.statusBar.maxVars = 20;
    const c2 = card();
    applyStatusBarTemplate(c2, ENS, 'structure', { settings: s20 });
    assert.equal(c2.statusBar.maxVars, 20);
    assert.equal(statusBarVarCap(c2, s), 20);
    // 显式 maxVars：记下的就是它（设置里的上限更大时仍按设置的）
    const c3 = card();
    applyStatusBarTemplate(c3, ENS, 'structure', { settings: s, maxVars: 12 });
    assert.equal(c3.statusBar.maxVars, 12);
    assert.equal(statusBarVarCap(c3, s), 12);
});

test('沿用结构套用到世界卡：给了 project（或 cast）时把主要角色预先填进「主要角色」，不让 AI 调整也不是空的；示例数据里的名字单独标出', () => {
    const s = settings();
    const project = {
        characters: {
            a: { name: '艾琳', importance: 'main', firstChunk: 0 },
            b: { name: '布兰', importance: 'main', firstChunk: 2 },
            c: { name: '路人甲', importance: 'minor', firstChunk: 0 },
            d: { name: '后来者', importance: 'main', firstChunk: 9 },
        },
    };
    const world = () => ({ id: 'w1', kind: 'world', timepoint: 5, data: { name: '旁白', first_mes: 'x', alternate_greetings: [] } });
    const w = world();
    const r = applyStatusBarTemplate(w, ENS, 'structure', { settings: s, project });
    const sb = w.statusBar;
    const main = sb.spec.variables.find((v) => v.path === '主要角色');
    assert.deepEqual(Object.keys(main.init), ['艾琳', '布兰'], '到卡片时间点为止出场的主要角色');
    assert.deepEqual(main.init.艾琳, { 身份: '', 阵营: '', 好感: 30, 心情: '平静', 心理活动: '', 服饰: { 上衣: '', 下装: '', 配饰: '' } });
    assert.deepEqual(sb.spec.variables.find((v) => v.path === 'NPC').init, {}, 'NPC 不预填');
    assert.ok(r.warnings.includes('已把 2 个主要角色预先填进「主要角色」：艾琳、布兰'), r.warnings.join('\n'));
    assert.equal(countSpecLeaves(sb.spec), 15);
    assert.deepEqual(normalizeStatusSpec(sb.spec, { maxVars: 30 }), sb.spec, '预填后仍是规范化的变量表');
    assert.deepEqual(sb.lint, { errors: [], warnings: [] });
    assert.equal(parseStateWithSpec(sb.spec, buildInitialState(sb.spec)).ok, true);
    assert.deepEqual(sb.sample, clone(ENS.sample), '示例数据照旧是模板的');
    // 立绘候选：真正的主要角色 + 固定分组；示例数据里的演示名字单独给出（界面标「示例数据」）
    assert.deepEqual(portraitCandidates(sb.spec, sb.sample).map((x) => x.name), ['艾琳', '布兰', '世界', '主角']);
    assert.deepEqual(portraitSampleCandidates(sb.spec, sb.sample).map((x) => `${x.record}:${x.name}`), ['主要角色:沈遥', '主要角色:林栖', '主要角色:白芷', 'NPC:老周', 'NPC:巡夜卫兵']);

    // 直接给 cast
    const w2 = world();
    applyStatusBarTemplate(w2, ENS, 'structure', { settings: s, cast: ['甲', 'a.b', '乙'] });
    assert.deepEqual(Object.keys(w2.statusBar.spec.variables.find((v) => v.path === '主要角色').init), ['甲', '乙']);
    // 没给 project / cast、角色卡、只借外观：都不预填
    const w3 = world();
    applyStatusBarTemplate(w3, ENS, 'structure', { settings: s });
    assert.deepEqual(w3.statusBar.spec.variables.find((v) => v.path === '主要角色').init, {});
    const ch = card();
    applyStatusBarTemplate(ch, ENS, 'structure', { settings: s, project });
    assert.deepEqual(ch.statusBar.spec.variables.find((v) => v.path === '主要角色').init, {});
    const w4 = world();
    ensureStatusBar(w4, s).spec = normalizeStatusSpec({ title: 't', variables: [{ path: '主要角色', type: 'record', keyDesc: '角色名', value: { type: 'string' }, init: {} }] }, { maxVars: 30 });
    const before = clone(w4.statusBar.spec);
    applyStatusBarTemplate(w4, ENS, 'look', { settings: s, project });
    assert.deepEqual(w4.statusBar.spec, before);
    // 模板里没有角色记录：什么都不做
    const w5 = world();
    const r5 = applyStatusBarTemplate(w5, BUILTIN_STATUSBAR_TEMPLATES[0], 'structure', { settings: s, project });
    assert.ok(!r5.warnings.some((x) => x.includes('预先填进')));
});

// ---------------- v0.12：模板携带立绘设置 ----------------

test('模板携带立绘：从带立绘的 NovelLoom 卡片 JSON 导入时带上（连同需要的变量上限），导出 / 导入往返；没有立绘的卡为 null', () => {
    const s = settings();
    const src = card({ id: 'c9' });
    applyStatusBarTemplate(src, ENS, 'structure', { settings: s });
    src.statusBar.portraits = clone(ENS_PORTRAITS);
    const json = JSON.parse(JSON.stringify(buildCardJson(src, { statusBar: DEFAULT_STATUS_BAR })));
    const fromCard = templateFromCardJson(json);
    assert.deepEqual(fromCard.portraits, normalizePortraits(ENS_PORTRAITS));
    assert.equal(fromCard.maxVars, 15);
    const t = parseStatusBarTemplate(json);
    assert.deepEqual(t.portraits, normalizePortraits(ENS_PORTRAITS));
    assert.equal(t.maxVars, 15);
    assert.deepEqual(t.spec, clone(ENS.spec), '模板里的变量表不按设置截断');

    const saved = importStatusBarTemplate(s, json);
    assert.deepEqual(getStatusBarTemplate(s, saved.id).portraits, normalizePortraits(ENS_PORTRAITS));
    const out = exportStatusBarTemplate(saved);
    assert.deepEqual(out.portraits, normalizePortraits(ENS_PORTRAITS));
    assert.deepEqual(parseStatusBarTemplate(JSON.stringify(out)).portraits, normalizePortraits(ENS_PORTRAITS));

    const plain = card();
    applyStatusBarTemplate(plain, BUILTIN_STATUSBAR_TEMPLATES[1], 'structure', { settings: s });
    const plainTpl = parseStatusBarTemplate(JSON.parse(JSON.stringify(buildCardJson(plain, { statusBar: DEFAULT_STATUS_BAR }))));
    assert.equal(plainTpl.portraits, null);
    assert.equal(plainTpl.maxVars, null);
    // 不合法的地址被丢掉，一张合法图都没有时整个为 null
    assert.equal(parseStatusBarTemplate({ ...out, portraits: { characters: { 甲: [{ url: 'javascript:alert(1)' }] } } }).portraits, null);
});

test('模板携带立绘：沿用结构时并进卡片的立绘（同名角色与同一图池以卡片自己的为准），记进撤销点；只借外观、模板没有立绘时不动卡片的立绘', () => {
    const s = settings();
    const tpl = { ...clone(ENS), id: 'sbtpl_pics', builtin: false, name: '带立绘的群像', portraits: clone(ENS_PORTRAITS) };
    const own = {
        characters: { 沈遥: [{ url: 'https://img.example.com/own.png' }] },
        pools: [{ record: 'NPC', field: '阵营', pools: {}, fallback: ['https://img.example.com/npc.png'] }],
    };
    const target = card();
    ensureStatusBar(target, s);
    target.statusBar.portraits = clone(own);
    const r = applyStatusBarTemplate(target, tpl, 'structure', { settings: s });
    const p = target.statusBar.portraits;
    assert.deepEqual(Object.keys(p.characters), ['沈遥', '林栖']);
    assert.deepEqual(p.characters.沈遥, own.characters.沈遥, '同名角色用卡片自己的');
    assert.deepEqual(p.characters.林栖, [{ url: PNG_A }]);
    assert.deepEqual(p.pools, normalizePortraits(own).pools, '同一记录 + 字段的图池用卡片自己的');
    assert.deepEqual(target.statusBar.prev.portraits, own, '撤销点里有套用前的立绘');
    assert.ok(r.warnings.some((w) => /立绘设置：1 个角色（林栖）/.test(w)), r.warnings.join('；'));
    assert.ok(compileStatusDocument(target).includes('window.NL_PORTRAITS = '));

    // 卡片还没有立绘：整份带过来
    const fresh = card();
    const r2 = applyStatusBarTemplate(fresh, tpl, 'structure', { settings: s });
    assert.deepEqual(fresh.statusBar.portraits, normalizePortraits(ENS_PORTRAITS));
    assert.ok(r2.warnings.some((w) => /2 个角色（沈遥、林栖），1 个图池/.test(w)), r2.warnings.join('；'));

    // 模板没有立绘：卡片的立绘原样不动，撤销点里也不记
    const keep = card();
    ensureStatusBar(keep, s);
    keep.statusBar.portraits = clone(own);
    applyStatusBarTemplate(keep, ENS, 'structure', { settings: s });
    assert.deepEqual(keep.statusBar.portraits, own);
    assert.equal('portraits' in keep.statusBar.prev, false);

    // 只借外观：立绘不动
    const look = card();
    ensureStatusBar(look, s);
    look.statusBar.spec = normalizeStatusSpec(USER_TPL.spec);
    look.statusBar.html = USER_TPL.html;
    const empty = clone(look.statusBar.portraits);
    applyStatusBarTemplate(look, tpl, 'look', { settings: s });
    assert.deepEqual(look.statusBar.portraits, empty);
});

test('templateFromStatusBar：立绘默认不带（是用户自己的图片地址），portraits: true 时带上；没有合法图片时为 null', () => {
    const c = card();
    applyStatusBarTemplate(c, ENS, 'structure', { settings: settings() });
    c.statusBar.portraits = clone(ENS_PORTRAITS);
    assert.equal(templateFromStatusBar(c).portraits, null);
    assert.deepEqual(templateFromStatusBar(c, { portraits: true }).portraits, normalizePortraits(ENS_PORTRAITS));
    const s = settings();
    const saved = addStatusBarTemplate(s, templateFromStatusBar(c, { name: '存档', portraits: true }));
    assert.deepEqual(saved.portraits, normalizePortraits(ENS_PORTRAITS));
    assert.equal(saved.maxVars, 15);
    assert.equal(updateStatusBarTemplate(s, saved.id, { portraits: null }).portraits, null);
    c.statusBar.portraits = { characters: { 沈遥: [{ url: 'ftp://x/y.png' }] }, pools: [] };
    assert.equal(templateFromStatusBar(c, { portraits: true }).portraits, null);
});

test('世界/旁白卡套用模板与存为模板：模板的路径与卡片无关（{{char}} 存成「角色」），没有名字的世界卡默认模板名是「旁白的状态栏」', () => {
    const s = settings();
    const tpl = { id: 'sbtpl_char', name: '带角色名', mode: 'auto', spec: { variables: [{ path: '{{char}}.好感', type: 'number', min: 0, max: 100, init: 10 }, { path: '世界.时间', type: 'string' }] } };
    const world = card({ kind: 'world', charName: '', data: { name: '', first_mes: '雨夜。', alternate_greetings: [], creator_notes: '' } });
    applyStatusBarTemplate(world, tpl, 'structure', { settings: s });
    assert.deepEqual(world.statusBar.spec.variables.map((v) => v.path), ['角色.好感', '世界.时间']);
    assert.equal(templateFromStatusBar(world).name, '旁白的状态栏');
    const named = card();
    applyStatusBarTemplate(named, tpl, 'structure', { settings: s });
    assert.deepEqual(named.statusBar.spec.variables.map((v) => v.path), ['角色.好感', '世界.时间'], '与卡片名无关');
    assert.equal(templateFromStatusBar(named).name, '林夕的状态栏');
    const nameless = card({ charName: '', data: { name: '', first_mes: '', alternate_greetings: [], creator_notes: '' } });
    assert.equal(templateFromStatusBar(nameless).name, '角色的状态栏');
});
