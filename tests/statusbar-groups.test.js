// v0.12：记录条目里的分组字段（服饰 {上衣, 下装, 配饰} 这类），从规范化一路到运行时与内置排版
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';

import {
    GROUP_FIELD_MAX, RECORD_FIELD_MAX, applyJsonPatch, applyReplyToState, buildInitialState, buildStatusRegexReplace, compileInitVar,
    compileSchemaScript, compileUpdateRules, countSpecLeaves, defaultRecordItem, lintStatusHtml, normalizeStatusSpec, parseStateWithSpec,
    randomRecordItem, randomSampleState, recordLeafFields, specSummaryText, variableLeafCount,
} from '../src/statusbar.js';
import { compileStatusDocument, renderDefaultFragment, runtimeSpec, STATUS_BINDING_GUIDE } from '../src/statusbar-runtime.js';
import { openStatusDocument } from './minidom.js';
import { PROSES, loadSchema, scriptsOf, seededRng, stFixMarkdown, stIframeText } from './stsim.js';

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

const RAW = {
    title: '群像',
    variables: [
        { path: '世界.时间', type: 'string', init: '清晨', label: '时间' },
        { path: '世界.地点', type: 'string', init: '旧城区', label: '地点' },
        {
            path: '主要角色', type: 'record', keyDesc: '角色名', label: '主要角色',
            value: {
                type: 'object',
                fields: [
                    { key: '身份', type: 'string', init: '' },
                    { key: '好感', type: 'number', min: 0, max: 100, integer: true, init: 20, stages: [{ min: 0, label: '陌生' }, { min: 40, label: '信任' }, { min: 80, label: '依恋' }] },
                    { key: '心情', type: 'enum', options: ['平静', '开心', '低落'], init: '平静' },
                    { key: '服饰', label: '穿着', type: 'object', fields: [{ key: '上衣', type: 'string', init: '白衬衫' }, { key: '下装', type: 'string', init: '' }, { key: '配饰', type: 'string', init: '' }] },
                    { key: '状态', type: '分组', fields: [{ key: '心理活动', type: 'string', init: '' }, { key: '体力', type: 'number', min: 0, max: 10, init: 10 }] },
                ],
            },
            init: { 莉艾丽: { 身份: '学生', 好感: 45, 服饰: { 上衣: '风衣' } }, 卡尔: {} },
            widget: 'list',
        },
        { path: 'NPC', type: 'record', keyDesc: '名字', value: { type: 'object', fields: [{ key: '阵营', type: 'string' }, { key: '好感', type: 'number', min: 0, max: 100, init: 0 }] }, init: {} },
    ],
};

function spec(extra = {}) {
    return normalizeStatusSpec(RAW, { maxVars: 30, ...extra });
}

// ---------------- 规范化 ----------------

test('normalizeStatusSpec：记录值可以带一层分组，分组字段规整、带阶段、初始条目按分组补默认值', () => {
    const warnings = [];
    const s = normalizeStatusSpec(RAW, { maxVars: 30, warnings });
    assert.deepEqual(warnings, []);
    const v = s.variables.find((x) => x.path === '主要角色');
    assert.deepEqual(v.value.fields.map((f) => [f.key, f.type]), [['身份', 'string'], ['好感', 'number'], ['心情', 'enum'], ['服饰', 'object'], ['状态', 'object']]);
    const dress = v.value.fields[3];
    assert.equal(dress.label, '穿着');
    assert.deepEqual(dress.fields.map((f) => [f.key, f.init]), [['上衣', '白衬衫'], ['下装', ''], ['配饰', '']]);
    assert.deepEqual(v.value.fields[1].stages, [{ min: 0, label: '陌生' }, { min: 40, label: '信任' }, { min: 80, label: '依恋' }], '记录字段也可以有阶段');
    assert.deepEqual(v.init.莉艾丽, { 身份: '学生', 好感: 45, 心情: '平静', 服饰: { 上衣: '风衣', 下装: '', 配饰: '' }, 状态: { 心理活动: '', 体力: 10 } });
    assert.deepEqual(v.init.卡尔, defaultRecordItem(v.value));
    assert.deepEqual(defaultRecordItem(v.value), { 身份: '', 好感: 20, 心情: '平静', 服饰: { 上衣: '白衬衫', 下装: '', 配饰: '' }, 状态: { 心理活动: '', 体力: 10 } });
    // 再规范化一次结果不变（编辑器每次改动都会重新规范化）
    const again = [];
    assert.deepEqual(normalizeStatusSpec(s, { maxVars: 30, warnings: again }), s);
    assert.deepEqual(again, []);
    assert.match(specSummaryText(s), /值：身份、好感、心情、服饰［上衣、下装、配饰］、状态［心理活动、体力］/);
});

test('normalizeStatusSpec：分组只能一层、空分组与重复字段被丢弃、超过上限的字段被丢弃，原因都写进 warnings', () => {
    const fields = [
        { key: '甲', type: 'string' },
        { key: '甲', type: 'number' },
        { key: '外层', type: 'object', fields: [{ key: '内层', type: 'object', fields: [{ key: 'x', type: 'string' }] }, { key: '留下', type: 'string' }] },
        { key: '空组', type: 'group', fields: [] },
        { key: '坏组', type: 'object', fields: [{ key: 'a.b', type: 'string' }] },
        { key: '大组', fields: Array.from({ length: GROUP_FIELD_MAX + 2 }, (_, i) => ({ key: `f${i}`, type: 'string' })) },
    ];
    const warnings = [];
    const s = normalizeStatusSpec([{ path: '记录', type: 'record', value: { type: 'object', fields } }], { maxVars: 30, warnings });
    const val = s.variables[0].value;
    assert.deepEqual(val.fields.map((f) => f.key), ['甲', '外层', '大组']);
    assert.deepEqual(val.fields[1].fields.map((f) => f.key), ['留下'], '分组里的分组被丢弃');
    assert.equal(val.fields[2].fields.length, GROUP_FIELD_MAX);
    const text = warnings.join('\n');
    assert.match(text, /字段「甲」重复/);
    assert.match(text, /分组「内层」里又有分组，分组只能有一层/);
    assert.match(text, /分组「空组」没有可用的字段/);
    assert.match(text, /分组「坏组」没有可用的字段/);
    assert.match(text, new RegExp(`分组「大组」最多 ${GROUP_FIELD_MAX} 个字段`));
    // 没有 fields 数组的 object 字段仍按文本处理（与以前一致）
    const s4 = normalizeStatusSpec([{ path: '记录', type: 'record', value: { fields: [{ key: '备注', type: 'object' }] } }]);
    assert.deepEqual(s4.variables[0].value.fields, [{ key: '备注', type: 'string', init: '' }]);
    // 记录最多 RECORD_FIELD_MAX 个字段（分组算一个）
    const many = Array.from({ length: RECORD_FIELD_MAX + 1 }, (_, i) => ({ key: `k${i}`, type: 'string' }));
    const w2 = [];
    const s2 = normalizeStatusSpec([{ path: '记录', type: 'record', value: { type: 'object', fields: many } }], { maxVars: 30, warnings: w2 });
    assert.equal(s2.variables[0].value.fields.length, RECORD_FIELD_MAX);
    assert.match(w2.join('\n'), new RegExp(`最多 ${RECORD_FIELD_MAX} 个字段`));
    // 分组字段的初始值超出范围被夹取并提示
    const w3 = [];
    const s3 = normalizeStatusSpec([{ path: '记录', type: 'record', value: { fields: [{ key: '组', fields: [{ key: '数', type: 'number', min: 0, max: 5 }] }] }, init: { 某人: { 组: { 数: 9, 未知: 1 }, 多余: 2 } } }], { warnings: w3 });
    assert.deepEqual(s3.variables[0].init, { 某人: { 组: { 数: 5 } } });
    assert.match(w3.join('\n'), /初始条目「某人」的「组」的「数」 的初始值 9 超出范围 0~5，已改为 5/);
});

test('叶子数：分组按组内字段计，与记录里有多少条目无关；上限按叶子数截断', () => {
    const s = spec();
    const v = s.variables.find((x) => x.path === '主要角色');
    assert.equal(variableLeafCount(v), 3 + 3 + 2, '身份/好感/心情 + 服饰 3 + 状态 2');
    assert.equal(countSpecLeaves(s), 2 + 8 + 2);
    const withMore = { ...v, init: { ...v.init, 甲: {}, 乙: {}, 丙: {} } };
    assert.equal(variableLeafCount(withMore), 8, '条目数不影响叶子数');
    const warnings = [];
    const capped = normalizeStatusSpec(RAW, { maxVars: 9, warnings });
    assert.deepEqual(capped.variables.map((x) => x.path), ['世界.时间', '世界.地点']);
    assert.match(warnings.join('\n'), /变量超过上限 9 个，「主要角色」及之后的变量已丢弃/);
    assert.deepEqual(recordLeafFields(v.value).map((x) => x.path), ['身份', '好感', '心情', '服饰.上衣', '服饰.下装', '服饰.配饰', '状态.心理活动', '状态.体力']);
    assert.equal(recordLeafFields(v.value)[3].group.key, '服饰');
    assert.deepEqual(recordLeafFields({ type: 'number' }), []);
});

// ---------------- 编译 ----------------

test('compileSchemaScript：分组编译成嵌套的 z.object(…).prefault({})', () => {
    const code = compileSchemaScript(spec());
    assert.ok(code.includes('"服饰": z.object({'));
    assert.ok(code.includes('"上衣": nlStr().prefault("白衬衫"),'));
    assert.ok(code.includes('"体力": z.coerce.number().prefault(10).transform(v => Math.min(10, Math.max(0, Math.round(v)))),'));
    assert.equal((code.match(/\}\)\.prefault\(\{\}\)/g) || []).length >= 4, true, '记录值与两个分组都 prefault({})');
    assert.ok(!/<\/script/i.test(code));
});

test('compileSchemaScript + 真实 zod：分组缺失时补默认值、未知键丢弃、嵌套数字夹取、非法值被拒绝、幂等', needZod, () => {
    const s = spec();
    const Schema = loadSchema(compileSchemaScript(s), z);
    const init = buildInitialState(s);
    assert.deepEqual(Schema.parse({}), init);
    const a = Schema.parse({ 主要角色: { 新人: {}, 莉艾丽: { 服饰: { 上衣: 3, 帽子: 'x' }, 状态: { 体力: '12.6' }, 未知: 1 } } });
    assert.deepEqual(a.主要角色.新人, defaultRecordItem(s.variables[2].value));
    assert.deepEqual(a.主要角色.莉艾丽.服饰, { 上衣: '3', 下装: '', 配饰: '' });
    assert.equal(a.主要角色.莉艾丽.状态.体力, 10);
    assert.ok(!('未知' in a.主要角色.莉艾丽));
    assert.deepEqual(Schema.parse(a), a, '幂等');
    assert.equal(Schema.safeParse({ 主要角色: { 莉艾丽: { 服饰: '风衣' } } }).success, false, '分组不是对象');
    assert.equal(Schema.safeParse({ 主要角色: { 莉艾丽: { 服饰: null } } }).success, false);
    assert.equal(Schema.safeParse({ 主要角色: { 莉艾丽: { 心情: '狂喜' } } }).success, false);
    assert.equal(Schema.safeParse({ 主要角色: { 莉艾丽: { 状态: { 体力: 'abc' } } } }).success, false);
});

test('parseStateWithSpec 与真实 zod 在分组上的结果一致', needZod, () => {
    const s = spec();
    const Loose = z.looseObject(loadSchema(compileSchemaScript(s), z).shape);
    const inputs = [
        {},
        { 主要角色: { 甲: {} } },
        { 主要角色: { 甲: { 服饰: { 上衣: true, 下装: 5, 多余: 1 }, 状态: {} } } },
        { 主要角色: { 甲: { 服饰: [] } } },
        { 主要角色: { 甲: { 服饰: 'x' } } },
        { 主要角色: { 甲: { 状态: { 体力: -4 } } }, 其他: 1 },
        { 主要角色: { 甲: { 状态: { 体力: { a: 1 } } } } },
        { 主要角色: { 甲: null } },
        { NPC: { 路人: { 好感: '101' } } },
    ];
    for (const input of inputs) {
        const zr = Loose.safeParse(structuredClone(input));
        const mine = parseStateWithSpec(s, structuredClone(input));
        assert.equal(mine.ok, zr.success, JSON.stringify(input));
        if (zr.success) assert.deepEqual(mine.data, zr.data, JSON.stringify(input));
    }
});

test('compileInitVar：分组写成嵌套的 YAML，往返一致', needYaml, () => {
    const s = spec();
    const text = compileInitVar(s);
    assert.deepEqual(YAML.parse(text), buildInitialState(s));
    assert.match(text, /\n {2}莉艾丽:\n {4}身份: "学生"\n[\s\S]*\n {4}服饰:\n {6}上衣: "风衣"\n/);
});

test('compileUpdateRules：记录的类型说明里分组嵌套展开，给出 JSON Patch 路径示例与阶段', needYaml, () => {
    const text = compileUpdateRules(spec());
    const r = YAML.parse(text).变量更新规则;
    const t = r.主要角色.type;
    assert.match(t, /\[角色名: string\]: \{\n {4}身份: string;\n {4}好感: number; \/\/ 0~100，阶段 0\+陌生\/40\+信任\/80\+依恋\n/);
    assert.match(t, /\n {4}服饰: \{\n {6}上衣: string;\n {6}下装: string;\n {6}配饰: string;\n {4}\};\n/);
    assert.match(t, /\n {6}体力: number; \/\/ 0~10\n/);
    assert.deepEqual(r.主要角色.paths, ['/主要角色/<角色名>/身份', '/主要角色/<角色名>/服饰/上衣', '/主要角色/<角色名>/状态/心理活动']);
    assert.ok(!('paths' in r.NPC), '没有分组的记录不加路径示例');
});

// ---------------- JSON Patch ----------------

test('applyJsonPatch：分组字段的路径 /主要角色/莉艾丽/服饰/上衣，新条目补默认值，非法操作整条作废', () => {
    const s = spec();
    const st = buildInitialState(s);
    const r = applyJsonPatch(st, [
        { op: 'replace', path: '/主要角色/莉艾丽/服饰/上衣', value: '皮夹克' },
        { op: 'delta', path: '/主要角色/莉艾丽/状态/体力', value: -15 },
        { op: 'insert', path: '/主要角色/新来的', value: { 身份: '旅人', 服饰: { 配饰: '斗篷' } } },
        { op: 'replace', path: '/主要角色/卡尔/服饰', value: '盔甲' },
        { op: 'insert', path: '/主要角色/路人/服饰/上衣', value: '布衣' },
        { op: 'remove', path: '/主要角色/莉艾丽/服饰/下装' },
        { op: 'replace', path: '/主要角色/卡尔/心情', value: '狂喜' },
    ], { spec: s });
    assert.equal(r.applied, 5);
    assert.equal(r.errors.length, 2);
    assert.match(r.errors[0], /第 4 条（replace \/主要角色\/卡尔\/服饰）：主要角色\.卡尔\.服饰：不是对象/);
    assert.match(r.errors[1], /第 7 条/);
    const m = r.state.主要角色;
    assert.equal(m.莉艾丽.服饰.上衣, '皮夹克');
    assert.equal(m.莉艾丽.状态.体力, 0, '嵌套数字夹取');
    assert.deepEqual(m.新来的, { ...defaultRecordItem(s.variables[2].value), 身份: '旅人', 服饰: { 上衣: '白衬衫', 下装: '', 配饰: '斗篷' } });
    assert.equal(m.路人.服饰.上衣, '布衣');
    assert.equal(m.路人.好感, 20, '自动建出的条目补默认值');
    assert.equal(m.莉艾丽.服饰.下装, '', '删掉的分组字段按变量表补回默认值（MVU 的 schema 也会补）');
    assert.deepEqual(m.卡尔.服饰, { 上衣: '白衬衫', 下装: '', 配饰: '' });
    const reply = applyReplyToState(st, '正文\n<UpdateVariable><JSONPatch>[{"op":"replace","path":"/主要角色/卡尔/服饰/配饰","value":"徽章"}]</JSONPatch></UpdateVariable>', { spec: s });
    assert.deepEqual(reply.errors, []);
    assert.equal(reply.state.主要角色.卡尔.服饰.配饰, '徽章');
});

// ---------------- 示例数据 ----------------

test('randomSampleState / randomRecordItem：分组逐字段随机，结果总能通过变量表与 zod 校验，固定随机数时可重复', () => {
    const s = spec();
    const a = randomSampleState(s, { rng: seededRng(7) });
    const b = randomSampleState(s, { rng: seededRng(7) });
    assert.deepEqual(a, b, '同一随机序列结果相同');
    assert.deepEqual(Object.keys(a.主要角色), ['莉艾丽', '卡尔'], '保留初始条目的键');
    assert.deepEqual(Object.keys(a.NPC), ['示例'], '没有条目时造一个示例条目');
    const r = parseStateWithSpec(s, a);
    assert.ok(r.ok);
    assert.deepEqual(r.data, a);
    for (const seed of [1, 2, 3, 4, 5]) {
        const x = randomSampleState(s, { rng: seededRng(seed) });
        const lia = x.主要角色.莉艾丽;
        assert.ok(lia.好感 >= 0 && lia.好感 <= 100 && Number.isInteger(lia.好感));
        assert.ok(['平静', '开心', '低落'].includes(lia.心情));
        assert.ok(lia.状态.体力 >= 0 && lia.状态.体力 <= 10);
        assert.equal(typeof lia.服饰.上衣, 'string');
    }
    const item = randomRecordItem(s.variables[2].value, { rng: seededRng(3) });
    assert.deepEqual(Object.keys(item), ['身份', '好感', '心情', '服饰', '状态']);
    assert.deepEqual(Object.keys(item.服饰), ['上衣', '下装', '配饰']);
    assert.equal(typeof randomRecordItem({ type: 'number', min: 5, max: 6 }, { rng: () => 0.99 }), 'number');
    assert.equal(randomRecordItem({ type: 'string' }), '示例');
    if (z) assert.ok(z.looseObject(loadSchema(compileSchemaScript(s), z).shape).safeParse(a).success);
});

// ---------------- 运行时与内置排版 ----------------

test('runtimeSpec：记录字段带显示名、范围、阶段，分组带自己的字段', () => {
    const rs = runtimeSpec(spec());
    const v = rs.variables.find((x) => x.path === '主要角色');
    assert.deepEqual(v.value.fields[1], { key: '好感', type: 'number', min: 0, max: 100, stages: [{ min: 0, label: '陌生' }, { min: 40, label: '信任' }, { min: 80, label: '依恋' }] });
    assert.deepEqual(v.value.fields[3], { key: '服饰', type: 'object', label: '穿着', fields: [{ key: '上衣', type: 'string' }, { key: '下装', type: 'string' }, { key: '配饰', type: 'string' }] });
    assert.ok(!JSON.stringify(rs).includes('"init"'), '运行时变量表不带初始值');
});

test('renderDefaultFragment：分组显示成条目里的子区块，绑定用点路径，三套主题都通过检查', () => {
    const s = spec();
    for (const theme of ['clean', 'night', 'paper']) {
        const f = renderDefaultFragment(s, theme);
        assert.deepEqual(lintStatusHtml(f, { mode: 'bind', spec: s }), { errors: [], warnings: [] }, theme);
    }
    const f = renderDefaultFragment(s);
    assert.ok(f.includes('<span class="nlb-lg" data-nl-field-group="服饰"><span class="nlb-lgt">穿着</span>'));
    assert.ok(f.includes('data-nl-item="服饰.上衣"'));
    assert.ok(f.includes('data-nl-item-bar="状态.体力"'));
    assert.ok(f.includes('data-nl-item-stage="好感"'), '有阶段的数字字段显示阶段名');
    assert.ok(!f.includes('data-nl-portrait'), '没有配置立绘时不加头像');
    assert.ok(STATUS_BINDING_GUIDE.includes('data-nl-item="服饰.上衣"'));
    assert.ok(STATUS_BINDING_GUIDE.includes('data-nl-group'));
    assert.ok(!STATUS_BINDING_GUIDE.includes('{{'));
});

test('状态栏文档带分组时，经过「自动修复 Markdown」与一层实体解码后 iframe 收到的仍是原文，脚本都能解析', () => {
    const s = normalizeStatusSpec({
        title: '群像*"标题',
        variables: [
            { path: '主要角色', type: 'record', keyDesc: '名*字', value: { type: 'object', fields: [{ key: '好感', type: 'number', min: 0, max: 100, stages: [{ min: 0, label: '低*' }] }, { key: '服饰', label: '服"饰', fields: [{ key: '上衣', label: 'a _b', type: 'string', init: '星*号"引号' }] }] }, init: { 'a*b': {} } },
        ],
    }, { maxVars: 30 });
    const fragment = [
        '<div class="g" data-nl-each="主要角色"><template><section><b data-nl-key></b><i data-nl-item="服饰.上衣"></i>',
        '<ul data-nl-group="服饰"><template><li><span data-nl-key></span>：<span data-nl-item=""></span></li></template></ul></section></template></div>',
        '<script>window.nlRender = function (stat, ctx) { var m = ctx.meta("主要角色.a*b.好感"); document.title = m ? m.max * 1 : ""; };</script>',
    ].join('\n');
    const docs = [
        compileStatusDocument({ statusBar: { mode: 'auto', spec: s } }),
        compileStatusDocument({ statusBar: { mode: 'bind', spec: s, html: fragment } }),
    ];
    for (const doc of docs) {
        const replace = buildStatusRegexReplace(doc);
        for (const prose of PROSES) {
            const shown = stIframeText(stFixMarkdown(`${prose}\n\n${replace}`, true));
            assert.equal(shown, doc, `正文：${prose}`);
            for (const code of scriptsOf(shown)) assert.doesNotThrow(() => new vm.Script(code));
        }
    }
});

function grouped() {
    const s = spec();
    const stat = {
        世界: { 时间: '黄昏', 地点: '码头' },
        主要角色: {
            莉艾丽: { 身份: '学生', 好感: 85, 心情: '开心', 服饰: { 上衣: '风衣', 下装: '长裙', 配饰: '' }, 状态: { 心理活动: '有点紧张', 体力: 4 } },
            卡尔: { 身份: '骑士', 好感: 10, 心情: '平静', 服饰: { 上衣: '盔甲', 下装: '', 配饰: '剑' }, 状态: { 心理活动: '', 体力: 10 } },
        },
        NPC: {},
    };
    return { s, stat };
}

test('NL 运行时：模板里的点路径、分组子模板、条目内阶段与显隐、绝对路径指向记录字段', () => {
    const { s, stat } = grouped();
    const html = [
        '<div id="cast" data-nl-each="主要角色"><template><article class="card">',
        '<b class="name" data-nl-key></b><i class="top" data-nl-item="服饰.上衣"></i>',
        '<span class="bar" data-nl-item-bar="状态.体力"></span><em class="stage" data-nl-item-stage="好感"></em>',
        '<p class="think" data-nl-item-show="状态.心理活动" data-nl-item="状态.心理活动"></p>',
        '<span class="happy" data-nl-item-show="心情" data-nl-eq="开心">☺</span>',
        '<ul class="dress" data-nl-group="服饰"><template><li><span class="k" data-nl-key></span><span class="v" data-nl-item=""></span></li></template></ul>',
        '</article></template></div>',
        '<dl class="world" data-nl-group="世界"><template><dt data-nl-key></dt><dd data-nl-item=""></dd></template></dl>',
        '<span class="abs-bar" data-nl-bar="主要角色.莉艾丽.好感"></span><span class="abs-stage" data-nl-stage="主要角色.莉艾丽.好感"></span>',
        '<span class="abs-text" data-nl-text="主要角色.莉艾丽.服饰"></span>',
    ].join('');
    const env = openStatusDocument(compileStatusDocument({ statusBar: { mode: 'bind', spec: s, html } }), { stat });
    const d = env.document;
    assert.deepEqual(env.errors, []);
    const cards = d.querySelectorAll('article.card');
    assert.equal(cards.length, 2);
    const [lia, karl] = cards;
    assert.equal(lia.querySelector('.name').textContent, '莉艾丽');
    assert.equal(lia.querySelector('.top').textContent, '风衣');
    assert.equal(lia.querySelector('.bar').style.getPropertyValue('--nl-pct'), '40.0%', '分组里的数字用字段的范围 0~10');
    assert.equal(lia.querySelector('.stage').textContent, '依恋');
    assert.equal(lia.querySelector('.stage').getAttribute('data-nl-stage-index'), '2');
    assert.equal(karl.querySelector('.stage').getAttribute('data-nl-stage-index'), '0');
    assert.equal(lia.querySelector('.think').hidden, false);
    assert.equal(karl.querySelector('.think').hidden, true, '空的心理活动隐藏');
    assert.equal(lia.querySelector('.happy').hidden, false);
    assert.equal(karl.querySelector('.happy').hidden, true);
    const items = lia.querySelectorAll('.dress li');
    assert.deepEqual(items.map((li) => [li.querySelector('.k').textContent, li.querySelector('.v').textContent, li.getAttribute('data-nl-field')]), [['上衣', '风衣', '上衣'], ['下装', '长裙', '下装'], ['配饰', '—', '配饰']]);
    const world = d.querySelector('dl.world');
    assert.deepEqual(world.querySelectorAll('dt').map((x) => x.textContent), ['时间', '地点'], '固定分组按变量表的下一层');
    assert.deepEqual(world.querySelectorAll('dd').map((x) => x.textContent), ['黄昏', '码头']);
    assert.equal(d.querySelector('.abs-bar').style.getPropertyValue('--nl-pct'), '85.0%');
    assert.equal(d.querySelector('.abs-bar').getAttribute('data-nl-stage-index'), '2');
    assert.equal(d.querySelector('.abs-stage').textContent, '依恋');
    assert.equal(d.querySelector('.abs-text').textContent, '上衣：风衣\n下装：长裙\n配饰：—');
    // 再来一轮更新：生成的节点被替换而不是叠加
    env.update({ ...stat, 主要角色: { 卡尔: { ...stat.主要角色.卡尔, 服饰: { 上衣: '便服', 下装: '', 配饰: '' } } } });
    assert.equal(d.querySelectorAll('article.card').length, 1);
    assert.equal(d.querySelector('article.card .top').textContent, '便服');
    assert.equal(d.querySelectorAll('dl.world dt').length, 2, '固定分组也不叠加');
    assert.equal(d.querySelectorAll('article.card .dress li').length, 3);
});

test('NL 运行时：内置排版里的分组子区块与阶段在运行时正确填充；对象值的文字显示把嵌套分组写在一行', () => {
    const { s, stat } = grouped();
    const env = openStatusDocument(compileStatusDocument({ statusBar: { mode: 'auto', spec: s } }), { stat });
    const lis = env.document.querySelectorAll('.nlb-li');
    assert.equal(lis.length, 2);
    const groupBox = lis[0].querySelector('.nlb-lg');
    assert.equal(groupBox.querySelector('.nlb-lgt').textContent, '穿着');
    assert.deepEqual(groupBox.querySelectorAll('b').map((b) => b.textContent), ['风衣', '长裙', '—']);
    assert.equal(lis[0].querySelector('[data-nl-item-stage="好感"]').textContent, '依恋');
    const text = compileStatusDocument({ statusBar: { mode: 'bind', spec: s, html: '<pre data-nl-text="主要角色"></pre>' } });
    const env2 = openStatusDocument(text, { stat });
    assert.equal(env2.document.querySelector('pre').textContent.split('\n')[0], '莉艾丽：身份 学生，好感 85，心情 开心，服饰 （上衣 风衣，下装 长裙，配饰 —），状态 （心理活动 有点紧张，体力 4）');
});
