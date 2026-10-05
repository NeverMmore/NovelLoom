// v0.15：关系类型是自由文本——AI 和用户可以写更贴切的短类型（师兄妹、青梅竹马、主仆），内置 + 自定义类型只是参考
import test from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_SETTINGS } from '../src/constants.js';
import { mergeDefaults } from '../src/utils.js';
import { createProject, normalizeCharacter, normalizeProject } from '../src/project.js';
import { DEFAULT_PROMPTS } from '../src/prompts.js';
import {
    RELATIONSHIP_TYPES, RELATION_TYPE_MAX, addCustomRelationType, addRelationTemplate, addRelationship, analyzeRelationships,
    exportRelationshipsJson, hashedTypeColor, mergeRelationships, normalizeRelationType, parseRelationshipsJson, relationLine,
    relationTemplates, relationTypeColor, relationTypeKey, relationTypeLabel, relationTypeSuggestions, relationTypesInUse, relationTypesPromptText,
    relationsMarkdown, removeCustomRelationType, updateRelationTemplate, updateRelationship,
} from '../src/relations.js';
import { bindTypeInputs, typeInputText } from '../src/ui/tab-relations.js';

function settings() {
    const s = mergeDefaults({}, DEFAULT_SETTINGS);
    s.api.retryBaseMs = 200;
    s.api.retries = 0;
    return s;
}

function project() {
    const p = createProject({ name: '测试' });
    p.chunks = [0, 1, 2].map((i) => ({ id: `c${i}`, title: `第${i + 1}章`, content: '' }));
    const mk = (name, extra = {}) => normalizeCharacter({ name, importance: 'main', firstChunk: 0, lastChunk: 2, chunksSeen: [0, 1, 2], ...extra });
    p.characters['江酒'] = mk('江酒');
    p.characters['莉莉丝'] = mk('莉莉丝', { identity: '大魔女' });
    p.characters['姜小白'] = mk('姜小白', { importance: 'support' });
    return normalizeProject(p);
}

const colorOf = (v) => RELATIONSHIP_TYPES.find((t) => t.value === v).color;

/** WCAG 相对亮度与对比度（检查按文字算出的颜色在深色 / 浅色主题上都看得清） */
function luminance(hex) {
    const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
function contrast(a, b) {
    const [x, y] = [luminance(a), luminance(b)].sort((m, n) => n - m);
    return (x + 0.05) / (y + 0.05);
}

test('normalizeRelationType：去空白、最多 8 个字；与已知类型（含自定义）的 value 或名字相同时换成 value，否则保留原文', () => {
    const s = settings();
    assert.equal(RELATION_TYPE_MAX, 8);
    assert.equal(normalizeRelationType('  师兄妹 ', s), '师兄妹');
    assert.equal(normalizeRelationType('青梅竹马', s), '青梅竹马');
    assert.equal(normalizeRelationType('主仆', s), '主仆');
    assert.equal(normalizeRelationType('朋友', s), 'friend', '内置类型的名字');
    assert.equal(normalizeRelationType('爱慕/恋人', s), 'romantic');
    assert.equal(normalizeRelationType('Romantic', s), 'romantic', 'value 不分大小写');
    assert.equal(normalizeRelationType('enemy', s), 'enemy');
    assert.equal(normalizeRelationType('「师兄妹」', s), '师兄妹', '整个包在引号里时去掉');
    assert.equal(normalizeRelationType('“朋友”', s), 'friend');
    assert.equal(normalizeRelationType('亦师亦友的忘年之交关系', s), '亦师亦友的忘年之', '超过 8 个字截断');
    assert.equal(Array.from(normalizeRelationType('𠀀𠀁𠀂𠀃𠀄𠀅𠀆𠀇𠀈', s)).length, 8, '按字（码点）截断，不切开代理对');
    assert.equal(normalizeRelationType('', s), 'other');
    assert.equal(normalizeRelationType(null, s), 'other');
    assert.equal(normalizeRelationType('   ', s), 'other');
    const ct = addCustomRelationType(s, { label: '养父女（改）' });
    assert.equal(normalizeRelationType('养父女（改）', s), ct.value, '自定义类型的名字（只有一边括号的不去掉）');
    assert.equal(normalizeRelationType(ct.value, s), ct.value);
    assert.equal(normalizeRelationType(ct.value, null), ct.value, '自定义类型的编号即使不认识也原样保留，不截断');
    removeCustomRelationType(s, ct.value);
    assert.equal(normalizeRelationType(ct.value, s), ct.value, '删除自定义类型后已有关系仍保留编号');
});

test('relationTypeLabel / relationTypeColor：已知类型用自己的名字和颜色；自由类型名字就是它自己，颜色按大类或按文字算', () => {
    const s = settings();
    assert.equal(relationTypeLabel('romantic', s), '爱慕/恋人');
    assert.equal(relationTypeLabel('师兄妹', s), '师兄妹');
    assert.equal(relationTypeLabel('', s), '其他');
    assert.equal(relationTypeLabel('ctype_gone123', s), '其他', '已删除的自定义类型不显示编号');
    assert.equal(relationTypeColor('romantic', s), colorOf('romantic'));
    assert.equal(relationTypeColor('师兄妹', s), colorOf('ally'), '同门归到同伴/盟友');
    assert.equal(relationTypeColor('徒弟', s), colorOf('mentor'), '徒弟不是家人');
    assert.equal(relationTypeColor('主仆', s), colorOf('mentor'));
    assert.equal(relationTypeColor('青梅竹马', s), colorOf('friend'));
    assert.equal(relationTypeColor('宿敌', s), colorOf('enemy'));
    assert.equal(relationTypeColor('暗恋', s), colorOf('romantic'));
    assert.equal(relationTypeColor('养父女', s), colorOf('family'));
    assert.equal(relationTypeColor('ctype_gone123', s), '#8a8a8a');
    const ct = addCustomRelationType(s, { label: '契约', color: '#123456' });
    assert.equal(relationTypeLabel(ct.value, s), '契约');
    assert.equal(relationTypeColor(ct.value, s), '#123456');
    // 归不了类的自由类型：按文字算的固定颜色（每次一样），#rrggbb
    const c1 = relationTypeColor('契约者', settings());
    assert.match(c1, /^#[0-9a-f]{6}$/);
    assert.equal(relationTypeColor('契约者', settings()), c1, '同一个类型颜色固定');
    assert.equal(c1, hashedTypeColor('契约者'));
    assert.notEqual(hashedTypeColor('契约者'), hashedTypeColor('共犯'));
});

test('hashedTypeColor：任何文字算出的颜色在深色（#17171c）和浅色（#f3f2ee）聊天主题上都看得清', () => {
    let minDark = Infinity;
    let minLight = Infinity;
    for (let i = 0; i < 600; i++) {
        const c = hashedTypeColor(`类型${i}`);
        minDark = Math.min(minDark, contrast(c, '#17171c'));
        minLight = Math.min(minLight, contrast(c, '#f3f2ee'));
    }
    assert.ok(minDark >= 3, `深色主题上的最低对比度 ${minDark.toFixed(2)}`);
    assert.ok(minLight >= 3, `浅色主题上的最低对比度 ${minLight.toFixed(2)}`);
});

test('提示词：{TYPES} 说明类型只是参考、可以写更贴切的短类型；默认的关系提示词也这样说，并给出自由类型的示例', () => {
    const s = settings();
    const text = relationTypesPromptText(s);
    assert.match(text, /romantic=爱慕\/恋人/);
    assert.match(text, /只是参考/);
    assert.match(text, /师兄妹、青梅竹马、主仆/);
    assert.match(text, /最多 8 个字/);
    assert.doesNotMatch(text, /关系模板/);
    // 模板里的自由类型直接写，已知类型带名字
    addRelationTemplate(s, { name: '同门', type: '师兄妹', mutual: true, label: '{A}和{B}拜在同一位师父门下' });
    addRelationTemplate(s, { name: '老友', type: '朋友', mutual: true });
    const withTpl = relationTypesPromptText(s);
    assert.match(withTpl, /- 同门：type=师兄妹，双向，说明写法参考：\{A\}和\{B\}拜在同一位师父门下/);
    assert.match(withTpl, /- 老友：type=friend（朋友），双向/);
    const p = DEFAULT_PROMPTS.relation;
    assert.match(p, /\{TYPES\}/);
    assert.match(p, /上面的类型只是参考/);
    assert.match(p, /师兄妹/);
    assert.doesNotMatch(p, /从上面的关系类型中选一个/);
});

test('mergeRelationships / analyzeRelationships：AI 写的自由类型原样保存，已知类型的名字换成 value；只有一句「关系」时按关键词归类', async () => {
    const p = project();
    const s = settings();
    const res = mergeRelationships(p, [
        { from: '江酒', to: '莉莉丝', type: '前任', mutual: false, label: '分手后成了她的女仆' },
        { from: '江酒', to: '姜小白', type: '朋友', mutual: true, label: '雨夜相遇' },
        { 人物1: '莉莉丝', 人物2: '姜小白', 关系: '莉莉丝是姜小白的师父' },
    ], 0, s);
    assert.equal(res.added, 3);
    assert.deepEqual(p.relationships.map((r) => r.type), ['前任', 'friend', 'mentor']);
    // 导出 / 导入形状不变：type 字段就是文字
    const json = exportRelationshipsJson(p);
    assert.equal(json.relationships[0].type, '前任');
    const p2 = project();
    mergeRelationships(p2, parseRelationshipsJson(JSON.parse(JSON.stringify(json))), 0, s);
    assert.deepEqual(p2.relationships.map((r) => r.type), ['前任', 'friend', 'mentor']);
    assert.match(relationsMarkdown(p, s), /\| 江酒 \| → 前任 \| 莉莉丝 \|/);
    assert.equal(relationLine(p, '江酒', '莉莉丝', p.relationships[0], Infinity, s), '- 莉莉丝：前任，分手后成了她的女仆');

    // AI 分析：提示词带上说明，回复里的自由类型保留
    const p3 = project();
    let seen = '';
    globalThis.SillyTavern = {
        getContext: () => ({
            async generateRaw({ prompt }) {
                seen = Array.isArray(prompt) ? prompt.map((m) => m.content).join('\n') : prompt;
                return JSON.stringify({ relationships: [{ from: '江酒', to: '姜小白', type: '师兄妹', mutual: true, label: '同在莉莉丝门下' }] });
            },
            stopGeneration() {},
        }),
    };
    try {
        await analyzeRelationships(p3, s);
    } finally {
        delete globalThis.SillyTavern;
    }
    assert.match(seen, /只是参考/);
    assert.equal(p3.relationships[0].type, '师兄妹');
});

test('updateRelationship / 关系模板：类型按自由文本规整；模板里填已知类型的名字存成 value', () => {
    const p = project();
    const s = settings();
    const r = addRelationship(p, { from: '江酒', to: '莉莉丝', type: '主仆', chunk: 0 }, s);
    assert.equal(r.type, '主仆');
    updateRelationship(p, r.id, { type: '敌对' }, s);
    assert.equal(r.type, 'enemy');
    updateRelationship(p, r.id, { type: '  宿敌  ' }, s);
    assert.equal(r.type, '宿敌');
    const t = addRelationTemplate(s, { name: '同门', type: '师兄妹' });
    assert.equal(t.type, '师兄妹');
    updateRelationTemplate(s, t.id, { type: '同伴/盟友' });
    assert.equal(relationTemplates(s)[0].type, 'ally');
    updateRelationTemplate(s, t.id, { type: '' });
    assert.equal(relationTemplates(s)[0].type, 'other');
});

test('relationTypesInUse / relationTypeSuggestions：筛选、图例只列项目里用到的类型（已知在前，自由类型按条数）；输入框候选加上用过的自由类型', () => {
    const s = settings();
    const ct = addCustomRelationType(s, { label: '契约' });
    const list = [
        { type: '师兄妹' }, { type: 'romantic' }, { type: '主仆' }, { type: '师兄妹' }, { type: ct.value }, { type: 'friend' }, { type: 'ctype_gone' },
    ];
    const used = relationTypesInUse(list, s);
    assert.deepEqual(used.map((t) => t.value), ['romantic', 'friend', ct.value, '师兄妹', 'ctype_gone', '主仆']);
    assert.deepEqual(used.map((t) => t.count), [1, 1, 1, 2, 1, 1]);
    assert.equal(used.find((t) => t.value === '师兄妹').color, colorOf('ally'));
    assert.equal(used.find((t) => t.value === 'ctype_gone').label, '其他（已删除的类型）');
    assert.deepEqual(used.map((t) => t.known), [true, true, true, false, false, false]);
    const sug = relationTypeSuggestions(s, list);
    assert.ok(sug.includes('朋友') && sug.includes('契约') && sug.includes('师兄妹') && sug.includes('主仆'));
    assert.equal(sug.filter((x) => x === '师兄妹').length, 1);
    assert.ok(!sug.some((x) => x.startsWith('ctype_')));
    assert.deepEqual(relationTypesInUse([], s), []);
});

test('relationTypeKey：自由文字与之后新建的同名自定义类型在筛选 / 图例里算同一类（不改动已存的数据）', () => {
    const s = settings();
    const p = project();
    // AI 先写了自由类型「师兄妹」；之后用户新建同名的自定义类型，新关系存成 ctype_…
    addRelationship(p, { from: '江酒', to: '姜小白', type: '师兄妹' }, s);
    const ct = addCustomRelationType(s, { label: '师兄妹' });
    addRelationship(p, { from: '莉莉丝', to: '姜小白', type: '师兄妹' }, s);
    assert.deepEqual(p.relationships.map((r) => r.type), ['师兄妹', ct.value], '已存的数据不变');
    assert.equal(relationTypeKey('师兄妹', s), ct.value);
    assert.equal(relationTypeKey(ct.value, s), ct.value);
    assert.equal(relationTypeKey(' 朋友 ', s), 'friend');
    assert.equal(relationTypeKey('', s), 'other');
    assert.equal(relationTypeKey('青梅竹马', s), '青梅竹马');
    assert.equal(relationTypeKey('ctype_gone', s), 'ctype_gone');
    const used = relationTypesInUse(p.relationships, s);
    assert.deepEqual(used, [{ value: ct.value, label: '师兄妹', color: ct.color, count: 2, known: true }], '只有一个「师兄妹」，两条都算进去');
    // 按 key 筛选时两条都在（关系页的类型筛选 / 图例用的就是这个比较）
    assert.equal(p.relationships.filter((r) => relationTypeKey(r.type, s) === used[0].value).length, 2);
    assert.equal(relationTypeSuggestions(s, p.relationships).filter((x) => x === '师兄妹').length, 1);
    // 删掉自定义类型后又分开：文字「师兄妹」回到自由类型，编号显示为已删除的类型
    removeCustomRelationType(s, ct.value);
    assert.deepEqual(relationTypesInUse(p.relationships, s).map((t) => [t.value, t.count]).sort(), [[ct.value, 1], ['师兄妹', 1]].sort());
});

/** 够 bindTypeInputs 用的假输入框与容器：closest / dataset / value / placeholder，事件由测试直接调用 */
function fakeTypeInput(value) {
    const input = { value, placeholder: '例如：朋友、师兄妹', dataset: {} };
    input.closest = (sel) => (sel === 'input[data-type-input]' ? input : null);
    return input;
}
function fakeRoot() {
    const handlers = {};
    return { handlers, addEventListener: (type, fn) => { handlers[type] = fn; } };
}

test('关系类型输入框：聚焦时清空（浏览器才会列出全部候选）、原来的文字放进占位文字；离开时没填就放回原来的；读值按原来的文字算', () => {
    const root = fakeRoot();
    bindTypeInputs(root);
    const input = fakeTypeInput('敌对');
    root.handlers.focusin({ target: input });
    assert.equal(input.value, '');
    assert.equal(input.placeholder, '敌对');
    assert.equal(typeInputText(input), '敌对', '还没输入时代表原来的类型（Esc 关闭、清空后失焦都不会变成「其他」）');
    root.handlers.focusout({ target: input });
    assert.equal(input.value, '敌对');
    assert.equal(input.placeholder, '例如：朋友、师兄妹');
    assert.equal(input.dataset.typePrev, undefined);
    // 输入了新类型：离开时保留新的
    root.handlers.focusin({ target: input });
    input.value = '师兄妹';
    assert.equal(typeInputText(input), '师兄妹');
    root.handlers.focusout({ target: input });
    assert.equal(input.value, '师兄妹');
    // 空的输入框（新模板行）聚焦不改占位文字；其他元素不受影响
    const empty = fakeTypeInput('');
    root.handlers.focusin({ target: empty });
    assert.equal(empty.placeholder, '例如：朋友、师兄妹');
    root.handlers.focusout({ target: empty });
    assert.equal(empty.value, '');
    const other = { value: 'x', closest: () => null };
    root.handlers.focusin({ target: other });
    assert.equal(other.value, 'x');
    assert.equal(typeInputText(null), '');
});

test('旧数据照常使用：内置 value、自定义类型编号都不变；normalizeProject 不改 type', () => {
    const s = settings();
    const ct = addCustomRelationType(s, { label: '契约' });
    const p = createProject({ name: '旧' });
    p.relationships = [
        { id: 'r1', from: '甲', to: '乙', type: 'romantic' },
        { id: 'r2', from: '甲', to: '丙', type: ct.value },
        { id: 'r3', from: '乙', to: '丙', type: '' },
    ];
    const n = normalizeProject(p);
    assert.deepEqual(n.relationships.map((r) => r.type), ['romantic', ct.value, 'other']);
    assert.deepEqual(n.relationships.map((r) => relationTypeLabel(r.type, s)), ['爱慕/恋人', '契约', '其他']);
});
