// v0.10：关系模板（类型 + 方向 + 说明写法），手动套用 + 写进「AI 分析关系」提示词；配置导入按 id 合并
import test from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_SETTINGS } from '../src/constants.js';
import { mergeDefaults } from '../src/utils.js';
import {
    addCustomRelationType, addRelationTemplate, applyRelationTemplate, relationTemplates, relationTypesPromptText,
    removeRelationTemplate, updateRelationTemplate,
} from '../src/relations.js';
import { applyConfig } from '../src/io.js';

const settings = () => mergeDefaults({}, DEFAULT_SETTINGS);

test('关系模板：默认没有；增删改，名称不能为空或重名', () => {
    const s = settings();
    assert.deepEqual(relationTemplates(s), []);
    const t = addRelationTemplate(s, { name: '青梅竹马', type: 'friend', mutual: true, label: '{A}和{B}从小一起长大' });
    assert.ok(t.id.startsWith('rtpl_'));
    assert.throws(() => addRelationTemplate(s, { name: '  ' }), /名称/);
    assert.throws(() => addRelationTemplate(s, { name: '青梅竹马' }), /同名/);
    const t2 = addRelationTemplate(s, { name: '暗恋' });
    updateRelationTemplate(s, t2.id, { name: '青梅竹马' });
    assert.equal(relationTemplates(s).find((x) => x.id === t2.id).name, '暗恋', '改名成已有名称时忽略');
    updateRelationTemplate(s, t2.id, { type: 'romantic', mutual: false, label: '{A}暗恋{B}' });
    assert.deepEqual(relationTemplates(s).map((x) => [x.name, x.type, x.mutual]), [['青梅竹马', 'friend', true], ['暗恋', 'romantic', false]]);
    assert.ok(removeRelationTemplate(s, t.id));
    assert.equal(relationTemplates(s).length, 1);
});

test('applyRelationTemplate：{A}/{B} 换成两个角色名；角色没选时保留占位符', () => {
    const tpl = { type: 'mentor', mutual: false, label: '{A}收{B}为徒，{B}一直敬重{A}' };
    assert.deepEqual(applyRelationTemplate(tpl, '莉莉丝', '江酒'), { type: 'mentor', mutual: false, label: '莉莉丝收江酒为徒，江酒一直敬重莉莉丝' });
    assert.equal(applyRelationTemplate(tpl, '莉莉丝', '').label, '莉莉丝收{B}为徒，{B}一直敬重莉莉丝');
});

test('relationTypesPromptText：没有模板时与原来一致；有模板时附上类型、方向和说明写法（含自定义类型名）', () => {
    const s = settings();
    const plain = relationTypesPromptText(s);
    assert.match(plain, /romantic=爱慕\/恋人/);
    assert.doesNotMatch(plain, /关系模板/);
    const ct = addCustomRelationType(s, { label: '养父女' });
    addRelationTemplate(s, { name: '收养', type: ct.value, mutual: false, label: '{A}收养了{B}' });
    const text = relationTypesPromptText(s);
    assert.match(text, /关系模板/);
    assert.match(text, new RegExp(`收养：type=${ct.value}（养父女），单向 A→B，说明写法参考：\\{A\\}收养了\\{B\\}`));
});

test('applyConfig：自定义类型与关系模板按 id 合并，不覆盖本机其他项', () => {
    const s = settings();
    const mine = addRelationTemplate(s, { name: '本机模板' });
    applyConfig(s, { type: 'novel_loom_config', settings: {
        relationTemplates: [{ id: 'rtpl_x', name: '导入的模板', type: 'ally', mutual: true, label: '' }, { id: mine.id, name: '本机模板（导入版）', type: 'friend' }],
        customRelationTypes: [{ value: 'ctype_x', label: '宿敌', color: '#ff0000' }],
    } });
    assert.deepEqual(relationTemplates(s).map((t) => t.name).sort(), ['导入的模板', '本机模板（导入版）'].sort());
    assert.equal(s.customRelationTypes[0].label, '宿敌');
});
