// 人物关系图谱测试：CRUD、时间点筛选、AI 分析合并去重、改名/合并/删段同步、角色卡接入
import test from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_SETTINGS } from '../src/constants.js';
import { mergeDefaults } from '../src/utils.js';
import { createProject, deleteChunkAt, mergeCharactersInto, normalizeCharacter, normalizeProject, pruneRelationships, renameCharacter } from '../src/project.js';
import { removeChunkContributions } from '../src/extract.js';
import { buildCardPrompt } from '../src/cards.js';
import {
    addCustomRelationType,
    addRelationship,
    allRelationTypes,
    analyzeRelationships,
    exportRelationshipsJson,
    mergeRelationships,
    normalizeRelationship,
    parseRelationshipsJson,
    relationLine,
    relationNames,
    relationsAt,
    relationsFor,
    relationsMarkdown,
    removeCustomRelationType,
    removeRelationship,
    updateCustomRelationType,
    updateRelationship,
} from '../src/relations.js';

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

function installST(mockFn) {
    globalThis.SillyTavern = {
        getContext: () => ({
            async generateRaw({ prompt }) {
                const text = Array.isArray(prompt) ? prompt.map((m) => m.content).join('\n') : prompt;
                return mockFn(text);
            },
            stopGeneration() {},
        }),
    };
}

// ---------------- 数据模型 / CRUD ----------------

test('normalizeRelationship：默认值、按中文关系词猜测类型', () => {
    const r = normalizeRelationship({ from: '江酒', to: '莉莉丝', type: '前男友' });
    assert.equal(r.type, 'romantic');
    assert.equal(r.mutual, false);
    assert.equal(r.auto, false);
    assert.ok(r.id.startsWith('rel_'));
    const r2 = normalizeRelationship({ from: 'a', to: 'b', type: '完全无法识别的类型' });
    assert.equal(r2.type, 'other');
});

test('addRelationship：写入并拒绝同一角色', () => {
    const p = project();
    const r = addRelationship(p, { from: '江酒', to: '莉莉丝', type: 'romantic', mutual: false, label: '曾经的恋人', chunk: 0 });
    assert.equal(p.relationships.length, 1);
    assert.equal(r.from, '江酒');
    assert.throws(() => addRelationship(p, { from: '江酒', to: '江酒' }), /不同的角色/);
});

test('updateRelationship / removeRelationship', () => {
    const p = project();
    const r = addRelationship(p, { from: '江酒', to: '莉莉丝', type: 'friend', chunk: 0 });
    const updated = updateRelationship(p, r.id, { label: '换了个说法', type: 'romantic' });
    assert.equal(updated.label, '换了个说法');
    assert.equal(updated.type, 'romantic');
    assert.equal(updateRelationship(p, 'no-such-id', {}), null);
    assert.equal(removeRelationship(p, r.id), true);
    assert.equal(p.relationships.length, 0);
    assert.equal(removeRelationship(p, r.id), false, '再删一次应该返回 false');
});

test('relationsFor / relationsAt / relationNames：按角色、按故事时间点筛选（防剧透）', () => {
    const p = project();
    addRelationship(p, { from: '江酒', to: '莉莉丝', type: 'romantic', chunk: 0 });
    addRelationship(p, { from: '江酒', to: '姜小白', type: 'friend', chunk: 2 });
    assert.equal(relationsFor(p, '莉莉丝').length, 1);
    assert.equal(relationsFor(p, '江酒').length, 2);
    assert.equal(relationsAt(p, 0).length, 1);
    assert.equal(relationsAt(p, 1).length, 1);
    assert.equal(relationsAt(p, 2).length, 2);
    assert.deepEqual(relationNames(p, 0).sort(), ['江酒', '莉莉丝']);
});

test('relationLine：单向关系标注“对方视角”，角色不存在时返回空字符串', () => {
    const p = project();
    const r = addRelationship(p, { from: '江酒', to: '莉莉丝', type: 'romantic', mutual: false, label: '曾经的恋人', chunk: 0 });
    assert.equal(relationLine(p, '江酒', '莉莉丝', r, Infinity), '- 莉莉丝：爱慕/恋人，曾经的恋人');
    assert.match(relationLine(p, '莉莉丝', '江酒', r, Infinity), /对方视角/);
    assert.equal(relationLine(p, '江酒', '不存在的人', r, Infinity), '');
});

test('relationsMarkdown / exportRelationshipsJson / parseRelationshipsJson：导出与去重导入', () => {
    const p = project();
    assert.equal(relationsMarkdown(p), '', '没有关系时应返回空字符串');
    addRelationship(p, { from: '江酒', to: '莉莉丝', type: 'romantic', mutual: false, label: '曾经的恋人', chunk: 0 });
    assert.match(relationsMarkdown(p), /\| 江酒 \| → 爱慕\/恋人 \| 莉莉丝 \| 曾经的恋人 \|/);
    const json = exportRelationshipsJson(p);
    assert.equal(json.type, 'novelloom-relationships');
    assert.equal(json.relationships.length, 1);
    const parsed = parseRelationshipsJson(json);
    assert.equal(parsed.length, 1);
    const dup = parseRelationshipsJson({ relationships: [...json.relationships, ...json.relationships] });
    assert.equal(dup.length, 1, '重复数据应该被去重');
});

test('自定义关系类型：新增/改名改色/删除，保存在扩展设置里，与内置类型合并使用', () => {
    const s = settings();
    assert.deepEqual(allRelationTypes(s), allRelationTypes(undefined), '没有自定义类型时应等于内置列表');

    const t = addCustomRelationType(s, { label: '养父女' });
    assert.equal(t.label, '养父女');
    assert.ok(t.value);
    assert.equal(s.customRelationTypes.length, 1);
    assert.ok(allRelationTypes(s).some((x) => x.value === t.value && x.label === '养父女'));

    assert.throws(() => addCustomRelationType(s, { label: '养父女' }), /已存在/, '重名应拒绝');
    assert.throws(() => addCustomRelationType(s, { label: '' }), /请输入/);

    const updated = updateCustomRelationType(s, t.value, { label: '养父女（改）', color: '#123456' });
    assert.equal(updated.label, '养父女（改）');
    assert.equal(updated.color, '#123456');
    assert.equal(updateCustomRelationType(s, 'no-such', {}), null);

    // 自定义类型在 normalizeRelationship / addRelationship 中生效（不传 settings 时仍按内置类型识别，不报错）
    const p = project();
    const r = addRelationship(p, { from: '江酒', to: '莉莉丝', type: t.value, chunk: 0 }, s);
    assert.equal(r.type, t.value, '自定义类型应原样保留，而不是被判定为 other');
    const rNoSettings = normalizeRelationship({ from: 'a', to: 'b', type: t.value });
    assert.equal(rNoSettings.type, 'other', '不传 settings 时无法识别自定义类型，回退到 other');

    assert.equal(removeCustomRelationType(s, t.value), true);
    assert.equal(s.customRelationTypes.length, 0);
    assert.equal(removeCustomRelationType(s, t.value), false, '再删一次应返回 false');
});

// ---------------- AI 合并去重 ----------------

test('mergeRelationships：别名解析、按 (from,to,type) 去重更新、无法识别的角色跳过', () => {
    const p = project();
    p.characters['江酒'].aliases = ['小酒'];
    const res1 = mergeRelationships(p, [
        { from: '小酒', to: '莉莉丝', type: 'romantic', mutual: false, label: '曾经的恋人' },
        { from: '莉莉丝', to: '路人甲', type: 'friend' }, // 路人甲不存在，应跳过
    ], 0);
    assert.deepEqual(res1, { added: 1, updated: 0, skipped: 1 });
    assert.equal(p.relationships[0].from, '江酒', '别名应解析为规范名');
    assert.equal(p.relationships[0].auto, true);

    // 同一对 (from,to) 再次出现：更新说明而不是新增
    const res2 = mergeRelationships(p, [{ from: '江酒', to: '莉莉丝', type: 'romantic', label: '如今是雇佣关系' }], 1);
    assert.deepEqual(res2, { added: 0, updated: 1, skipped: 0 });
    assert.equal(p.relationships.length, 1);
    assert.equal(p.relationships[0].label, '如今是雇佣关系');

    // 双向关系反过来出现也应该算同一条
    const res3 = mergeRelationships(p, [{ from: '姜小白', to: '江酒', type: 'friend', mutual: true }], 1);
    assert.equal(res3.added, 1);
    const res4 = mergeRelationships(p, [{ from: '江酒', to: '姜小白', type: 'friend', mutual: true, label: '雨夜相遇' }], 1);
    assert.deepEqual(res4, { added: 0, updated: 1, skipped: 0 }, '互相关系反过来出现应算同一条');
});

test('analyzeRelationships：拼装提示词（含已有记录）、解析结果并写入；角色不足时报错', async () => {
    const p = project();
    addRelationship(p, { from: '江酒', to: '莉莉丝', type: 'friend', label: '旧记录', chunk: 0 });
    let seenPrompt = '';
    installST((text) => {
        seenPrompt = text;
        return JSON.stringify({ relationships: [{ from: '江酒', to: '姜小白', type: 'friend', mutual: true, label: '雨夜相遇' }] });
    });
    const res = await analyzeRelationships(p, settings());
    assert.match(seenPrompt, /姓名: 江酒/);
    assert.match(seenPrompt, /旧记录/, '已有关系应该写进 EXISTING 段落，避免 AI 重复输出');
    assert.equal(res.added, 1);
    assert.equal(p.relationships.length, 2);

    const p2 = project();
    p2.characters = { 江酒: p2.characters['江酒'] };
    await assert.rejects(() => analyzeRelationships(p2, settings()), /至少需要 2 个/);
});

// ---------------- 与角色改名 / 合并 / 分段删除同步 ----------------

test('renameCharacter：同步关系图谱里的引用', () => {
    const p = project();
    addRelationship(p, { from: '江酒', to: '莉莉丝', type: 'romantic', chunk: 0 });
    addRelationship(p, { from: '姜小白', to: '莉莉丝', type: 'friend', chunk: 0 });
    renameCharacter(p, '江酒', '酒酒');
    assert.deepEqual(p.relationships.map((r) => r.from).sort(), ['姜小白', '酒酒']);
    assert.ok(!p.characters['江酒'] && p.characters['酒酒']);
});

test('mergeCharactersInto：合并角色后关系重定向到目标角色，自环与重复边被清理', () => {
    const p = project();
    addRelationship(p, { from: '江酒', to: '莉莉丝', type: 'friend', chunk: 0, label: '老朋友' });
    addRelationship(p, { from: '姜小白', to: '莉莉丝', type: 'friend', chunk: 1, label: '新朋友' }); // 合并后与上面重复
    addRelationship(p, { from: '江酒', to: '姜小白', type: 'friend', chunk: 0 }); // 合并后变成自环
    mergeCharactersInto(p, '江酒', ['姜小白']);
    assert.ok(!p.relationships.some((r) => r.from === r.to), '不应该留下自环');
    assert.equal(p.relationships.filter((r) => r.from === '江酒' && r.to === '莉莉丝').length, 1, '重复边应该被去重');
});

test('pruneRelationships：清除指向已不存在角色的边', () => {
    const p = project();
    addRelationship(p, { from: '江酒', to: '莉莉丝', type: 'friend', chunk: 0 });
    delete p.characters['莉莉丝'];
    pruneRelationships(p);
    assert.equal(p.relationships.length, 0);
});

test('deleteChunkAt：角色因分段删除而被移除时，指向它的关系同步清理；保留的关系 chunk 同步重映射', () => {
    const p = project();
    p.characters['姜小白'].chunksSeen = [0];
    p.characters['姜小白'].firstChunk = 0;
    p.characters['姜小白'].lastChunk = 0;
    addRelationship(p, { from: '江酒', to: '姜小白', type: 'friend', chunk: 0 });
    addRelationship(p, { from: '江酒', to: '莉莉丝', type: 'friend', chunk: 1 });
    deleteChunkAt(p, 0);
    assert.ok(!p.characters['姜小白'], '姜小白只在被删的段出现过，应该被移除');
    assert.equal(p.relationships.length, 1, '指向姜小白的关系应该被清理');
    assert.equal(p.relationships[0].to, '莉莉丝');
    assert.equal(p.relationships[0].chunk, 0, '剩余关系的 chunk 应该跟着重映射（原为 1，段 0 被删后变为 0）');
});

test('extract.removeChunkContributions：清除某段贡献时同步清理该段建立的关系', () => {
    const p = project();
    addRelationship(p, { from: '江酒', to: '莉莉丝', type: 'romantic', chunk: 0 });
    addRelationship(p, { from: '江酒', to: '莉莉丝', type: 'friend', chunk: 1 });
    removeChunkContributions(p, 1);
    assert.equal(p.relationships.length, 1);
    assert.equal(p.relationships[0].type, 'romantic');
});

// ---------------- 角色卡接入 ----------------

test('buildCardPrompt：「相关角色」优先使用关系图谱里的明确关系，再用启发式补齐剩余名额', () => {
    const p = project();
    p.characters['江酒'].relationship = '';
    p.characters['江酒'].experiences = [];
    addRelationship(p, { from: '江酒', to: '莉莉丝', type: 'romantic', mutual: false, label: '曾经的恋人', chunk: 0 });
    const { prompt } = buildCardPrompt(p, settings(), { kind: 'character', charName: '江酒' });
    assert.match(prompt, /# 相关角色\n- 莉莉丝：爱慕\/恋人，曾经的恋人/);
    assert.match(prompt, /姜小白/, '没有明确关系的角色仍应通过启发式（共同出场段 + 重要度）补齐');
});
