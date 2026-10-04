// v0.10：角色不再被泛称/歧义别名并到一起；重新提取（选中段 / 从某段起 / 全部）先清干净旧贡献
import test from 'node:test';
import assert from 'node:assert/strict';

import { createProject, findCharacterKey, isSpecificAlias, mergeCharacter, normalizeCharacter, normalizeProject } from '../src/project.js';
import { chunkHasContributions, removeChunkContributions, resetChunksForReextract, resetExtractionFrom } from '../src/extract.js';

function project(n = 4) {
    const p = createProject({ name: '测试' });
    p.chunks = Array.from({ length: n }, (_, i) => ({ id: `c${i}`, index: i, title: `第${i + 1}章`, chapterTitles: [`第${i + 1}章`], content: `正文${i}`, origin: 'source', status: 'done' }));
    return normalizeProject(p);
}

test('isSpecificAlias：泛称和单字不能用来认人', () => {
    for (const a of ['小姐', '师父', '主人', '她', '林', '', ' ']) assert.equal(isSpecificAlias(a), false, a);
    for (const a of ['小酒', '林默', '莉莉']) assert.equal(isSpecificAlias(a), true, a);
});

test('findCharacterKey：同名直接命中；名字是唯一角色的别名时命中', () => {
    const p = project();
    p.characters['江酒'] = normalizeCharacter({ name: '江酒', aliases: ['小酒'] });
    assert.equal(findCharacterKey(p, '江酒'), '江酒');
    assert.equal(findCharacterKey(p, '小酒'), '江酒');
    assert.equal(findCharacterKey(p, '酒哥', ['小酒']), '江酒', '具体别名相同 → 同一人');
});

test('findCharacterKey：只靠泛称（小姐/师父）不会把不同角色认成同一个', () => {
    const p = project();
    p.characters['莉莉丝'] = normalizeCharacter({ name: '莉莉丝', aliases: ['小姐'] });
    assert.equal(findCharacterKey(p, '苏晚', ['小姐']), null);
    assert.equal(findCharacterKey(p, '林', ['林']), null);
});

test('findCharacterKey：名字同时是两个角色的别名时有歧义，不合并；具体别名能消除歧义', () => {
    const p = project();
    p.characters['林默'] = normalizeCharacter({ name: '林默', aliases: ['阿林', '默默'] });
    p.characters['林雪'] = normalizeCharacter({ name: '林雪', aliases: ['阿林', '雪儿'] });
    assert.equal(findCharacterKey(p, '阿林'), null);
    assert.equal(findCharacterKey(p, '阿林', ['雪儿']), '林雪');
    // 两个具体别名分别指向两个人 → 也有歧义
    assert.equal(findCharacterKey(p, '某人', ['默默', '雪儿']), null);
});

test('mergeCharacter：不收别人的名字或已被别人占用的具体别名（防止滚雪球）', () => {
    const p = project();
    p.characters['江酒'] = normalizeCharacter({ name: '江酒', aliases: ['小酒'], chunksSeen: [0], firstChunk: 0, lastChunk: 0 });
    p.characters['莉莉丝'] = normalizeCharacter({ name: '莉莉丝', aliases: ['魔女小姐'], chunksSeen: [0], firstChunk: 0, lastChunk: 0 });
    // AI 在第 2 段给江酒带上了“莉莉丝”“魔女小姐”这种别名（输出出错）
    const r = mergeCharacter(p, { name: '江酒', aliases: ['莉莉丝', '魔女小姐', '江同学', '小姐'] }, 1);
    assert.equal(r.key, '江酒');
    assert.deepEqual(p.characters['江酒'].aliases.sort(), ['小姐', '小酒', '江同学'].sort());
    // 之后再出现“魔女小姐”，仍然归莉莉丝
    assert.equal(findCharacterKey(p, '魔女小姐'), '莉莉丝');
});

test('removeChunkContributions：手动新建的角色和条目不会因为重新提取别的段被删除', () => {
    const p = project();
    p.characters['手动角色'] = normalizeCharacter({ name: '手动角色' });
    p.characters['江酒'] = normalizeCharacter({ name: '江酒', chunksSeen: [1], firstChunk: 1, lastChunk: 1 });
    p.worldbook['地点'] = {
        手动地点: { name: '手动地点', content: 'x', keywords: [], sourceChunks: [], revisions: [] },
        酒吧: { name: '酒吧', content: 'y', keywords: [], sourceChunks: [1], revisions: [{ chunk: 1, content: 'y' }] },
    };
    removeChunkContributions(p, 1);
    assert.ok(p.characters['手动角色'], '没有出处的角色保留');
    assert.ok(!p.characters['江酒'], '只出现在这一段的角色被删');
    assert.ok(p.worldbook['地点']['手动地点'], '没有出处的条目保留');
    assert.ok(!p.worldbook['地点']['酒吧']);
});

test('removeChunkContributions：身份/性格若是这一段写的，回退到前面段落的记录；手动改过的不动', () => {
    const p = project();
    p.characters['江酒'] = normalizeCharacter({
        name: '江酒', chunksSeen: [0, 2], firstChunk: 0, lastChunk: 2,
        identity: '女仆', personality: '我手动改的性格', relationship: '前男友',
        stages: [
            { chunk: 0, identity: '渣男', personality: '脸皮厚', relationship: '前男友' },
            { chunk: 2, identity: '女仆', personality: '变得乖巧' },
        ],
    });
    removeChunkContributions(p, 2);
    const c = p.characters['江酒'];
    assert.equal(c.identity, '渣男', '第 3 段写的身份回退到第 1 段');
    assert.equal(c.personality, '我手动改的性格', '当前值不是第 3 段写的 → 视为手动修改，保留');
    assert.equal(c.relationship, '前男友');
    assert.deepEqual(c.stages.map((s) => s.chunk), [0]);
});

test('resetExtractionFrom：从某段起清掉贡献并改回待提取，之前的段不动', () => {
    const p = project(4);
    p.characters['江酒'] = normalizeCharacter({
        name: '江酒', chunksSeen: [0, 2, 3], firstChunk: 0, lastChunk: 3, identity: 'C',
        experiences: [{ chunk: 0, text: 'a' }, { chunk: 2, text: 'b' }, { chunk: 3, text: 'c' }],
        stages: [{ chunk: 0, identity: 'A' }, { chunk: 2, identity: 'B' }, { chunk: 3, identity: 'C' }],
    });
    p.characters['姜小白'] = normalizeCharacter({ name: '姜小白', chunksSeen: [2, 3], firstChunk: 2, lastChunk: 3 });
    p.chunks[3].status = 'error';
    p.chunks[3].error = '超时';
    const n = resetExtractionFrom(p, 2);
    assert.equal(n, 2);
    assert.deepEqual(p.chunks.map((c) => c.status), ['done', 'done', 'pending', 'pending']);
    assert.equal(p.chunks[3].error, '');
    assert.ok(!p.characters['姜小白'], '只在被重置段出现的角色被清掉');
    const c = p.characters['江酒'];
    assert.deepEqual(c.experiences.map((e) => e.text), ['a']);
    assert.equal(c.identity, 'A', '从后往前回退：C → B → A');
    assert.equal(c.lastChunk, 0);
});

test('resetChunksForReextract：只重置选中的段；全部重新提取 = 从第 1 段起', () => {
    const p = project(3);
    p.characters['江酒'] = normalizeCharacter({ name: '江酒', chunksSeen: [0, 1, 2], firstChunk: 0, lastChunk: 2, experiences: [{ chunk: 0, text: 'a' }, { chunk: 1, text: 'b' }, { chunk: 2, text: 'c' }] });
    p.characters['锁定的'] = normalizeCharacter({ name: '锁定的', locked: true, chunksSeen: [1], firstChunk: 1, lastChunk: 1 });
    assert.equal(resetChunksForReextract(p, [1, 1, 99]), 1, '去重并忽略不存在的段');
    assert.deepEqual(p.chunks.map((c) => c.status), ['done', 'pending', 'done']);
    assert.deepEqual(p.characters['江酒'].experiences.map((e) => e.text), ['a', 'c']);
    assert.ok(p.characters['锁定的'], '锁定的角色保留');
    resetExtractionFrom(p, 0);
    assert.deepEqual(p.chunks.map((c) => c.status), ['pending', 'pending', 'pending']);
    assert.ok(!p.characters['江酒']);
    assert.ok(p.characters['锁定的']);
});

// ---------------- 评审后的修正 ----------------

test('别名出处：重新提取某段会清掉只来自这一段的别名，被错误并进来的人能重新分开（用户的实际情况）', () => {
    const p = project(4);
    // 第 1 段：林风；第 4 段 AI 把“苏少爷”并进了林风
    mergeCharacter(p, { name: '林风', aliases: ['少爷'], identity: '林家少爷' }, 0);
    mergeCharacter(p, { name: '林风', aliases: ['苏少爷'], identity: '苏家独子' }, 3);
    assert.ok(p.characters['林风'].aliases.includes('苏少爷'));
    assert.deepEqual(p.characters['林风'].aliasSources['苏少爷'], [3]);
    resetExtractionFrom(p, 3);
    assert.ok(!p.characters['林风'].aliases.includes('苏少爷'), '只来自第 4 段的别名被清掉');
    assert.ok(p.characters['林风'].aliases.includes('少爷'), '第 1 段的别名保留');
    assert.equal(p.characters['林风'].identity, '林家少爷');
    assert.equal(findCharacterKey(p, '苏少爷'), null, '重新提取时“苏少爷”会成为单独的角色');
});

test('别名出处：手动加的、旧数据里没有出处记录的别名不会被清掉；合并来的别名带着出处', () => {
    const p = project(3);
    p.characters['江酒'] = normalizeCharacter({ name: '江酒', aliases: ['老江'], chunksSeen: [0, 1], firstChunk: 0, lastChunk: 1 });
    mergeCharacter(p, { name: '江酒', aliases: ['小酒'] }, 1);
    removeChunkContributions(p, 1);
    assert.deepEqual(p.characters['江酒'].aliases, ['老江'], '没有出处的旧别名保留，第 2 段带来的“小酒”清掉');
});

test('重新提取不连带删除指向角色的手动关系、群聊卡和视角文风（角色马上会提取回来）', () => {
    const p = project(2);
    mergeCharacter(p, { name: '江酒' }, 0);
    mergeCharacter(p, { name: '莉莉丝' }, 1);
    mergeCharacter(p, { name: '姜小白' }, 1);
    p.relationships = [{ id: 'r1', from: '江酒', to: '莉莉丝', type: 'romantic', chunk: 0, auto: false }];
    p.groupCards = [{ id: 'g1', members: ['莉莉丝', '江酒', '姜小白'] }];
    p.povStyles = { 莉莉丝: 'style_x' };
    resetExtractionFrom(p, 1);
    assert.ok(!p.characters['莉莉丝'], '只来自第 2 段的角色暂时被清掉');
    assert.equal(p.relationships.length, 1, '手动关系保留');
    assert.equal(p.groupCards[0].members.length, 3, '群聊卡成员保留');
    assert.equal(p.povStyles['莉莉丝'], 'style_x', '视角文风保留');
    // 真正删除分段时仍然会清理（默认 prune）
    removeChunkContributions(p, 0);
    assert.equal(p.relationships.length, 0);
});

test('手动新建的角色：取消锁定后重新提取它所在的段也不会被删除，时间点保留', () => {
    const p = project(2);
    p.characters['手动'] = normalizeCharacter({ name: '手动', manual: true, locked: false, chunksSeen: [0], firstChunk: 0, lastChunk: 0 });
    resetExtractionFrom(p, 0);
    assert.ok(p.characters['手动']);
    assert.deepEqual(p.characters['手动'].chunksSeen, [0]);
    assert.equal(p.characters['手动'].firstChunk, 0);
});

test('回退规则：后面的段还在时不回退；更早的记录被截掉时保留当前值；手动修改不回退；没写入过的提议不算', () => {
    const p = project(6);
    // (1) 只重置中间的第 3 段，第 4 段仍在：不回退
    p.characters['A'] = normalizeCharacter({ name: 'A', identity: 'X', chunksSeen: [0, 2, 3], firstChunk: 0, lastChunk: 3, stages: [{ chunk: 0, identity: 'W' }, { chunk: 2, identity: 'X' }] });
    removeChunkContributions(p, 2);
    assert.equal(p.characters['A'].identity, 'X');
    // (2) 更早出现过、但没有更早的记录（被截掉）：保留当前值，不清空
    p.characters['B'] = normalizeCharacter({ name: 'B', identity: 'Y', chunksSeen: [0, 3], firstChunk: 0, lastChunk: 3, stages: [{ chunk: 3, identity: 'Y' }] });
    removeChunkContributions(p, 3);
    assert.equal(p.characters['B'].identity, 'Y');
    // (3) 当前值是手动改过的（和这一段写的不一样）：不回退
    p.characters['C'] = normalizeCharacter({ name: 'C', identity: '手动值', chunksSeen: [1, 3], firstChunk: 1, lastChunk: 3, stages: [{ chunk: 1, identity: 'A1' }, { chunk: 3, identity: 'A3' }] });
    removeChunkContributions(p, 3);
    assert.equal(p.characters['C'].identity, '手动值');
    // (4) 锁定期间 AI 的提议只记录不写入（unapplied），回退时跳过它，退到真正写入过的值
    p.characters['D'] = normalizeCharacter({ name: 'D', identity: 'A5', chunksSeen: [1, 3, 5], firstChunk: 1, lastChunk: 5, stages: [{ chunk: 1, identity: 'A1' }, { chunk: 3, identity: 'A3', unapplied: ['identity'] }, { chunk: 5, identity: 'A5' }] });
    removeChunkContributions(p, 5);
    assert.equal(p.characters['D'].identity, 'A1');
});

test('mergeCharacter：锁定时 AI 的新身份只记录为 unapplied 阶段，不覆盖', () => {
    const p = project(3);
    mergeCharacter(p, { name: '江酒', identity: '渣男' }, 0);
    p.characters['江酒'].locked = true;
    mergeCharacter(p, { name: '江酒', identity: '女仆' }, 1);
    const c = p.characters['江酒'];
    assert.equal(c.identity, '渣男');
    assert.deepEqual(c.stages.find((s) => s.chunk === 1).unapplied, ['identity']);
});

test('删除/合并分段时，别名出处跟着重映射；只来自被删段的别名一起去掉；手动角色和手动条目不被删除', async () => {
    const { deleteChunkAt } = await import('../src/project.js');
    const p = project(5);
    mergeCharacter(p, { name: '江酒' }, 0);
    mergeCharacter(p, { name: '江酒', aliases: ['错名'] }, 1);
    mergeCharacter(p, { name: '江酒', aliases: ['小酒'] }, 3);
    p.characters['手动'] = normalizeCharacter({ name: '手动', manual: true, chunksSeen: [1], firstChunk: 1, lastChunk: 1 });
    p.worldbook['地点'] = { 手动地点: { name: '手动地点', content: 'x', keywords: [], sourceChunks: [], revisions: [] } };
    deleteChunkAt(p, 1);
    const c = p.characters['江酒'];
    assert.ok(!c.aliases.includes('错名'), '只来自被删段的别名去掉');
    assert.deepEqual(c.aliasSources['小酒'], [2], '后面的段序号前移');
    assert.ok(p.characters['手动'], '手动角色不删');
    assert.ok(p.worldbook['地点']['手动地点'], '没有出处的手动条目不删');
});

test('重新提取暂时清掉的角色：在提取完成前，删除别的分段触发的清理不会删掉指向它们的关系/群聊卡', async () => {
    const { deleteChunkAt } = await import('../src/project.js');
    const p = project(4);
    mergeCharacter(p, { name: '甲' }, 0);
    mergeCharacter(p, { name: '乙' }, 2);
    mergeCharacter(p, { name: '丙' }, 2);
    p.relationships = [{ id: 'r', from: '甲', to: '乙', type: 'friend', chunk: 0, auto: false }];
    p.groupCards = [{ id: 'g', members: ['甲', '乙', '丙'] }];
    resetChunksForReextract(p, [2]);
    assert.deepEqual(p.reextractPending.sort(), ['丙', '乙']);
    deleteChunkAt(p, 3);
    assert.equal(p.relationships.length, 1);
    assert.equal(p.groupCards[0].members.length, 3);
});

test('chunkHasContributions：手动角色的时间点、已回答的待核实名称、关系不算“有资料”', () => {
    const p = project(2);
    for (const c of p.chunks) c.status = 'pending';
    p.characters['手动'] = normalizeCharacter({ name: '手动', manual: true, chunksSeen: [0], firstChunk: 0, lastChunk: 0 });
    p.missingNames = [{ vague: '那家店', chunk: 0, resolved: '酒吧' }];
    p.relationships = [{ id: 'r', from: '手动', to: '手动', chunk: 0, auto: true }];
    assert.equal(chunkHasContributions(p, 0), false);
    p.missingNames.push({ vague: '那个人', chunk: 0, resolved: '' });
    assert.equal(chunkHasContributions(p, 0), true);
});

test('已经填写答案的待核实名称不会因为重新提取被删除', () => {
    const p = project(2);
    p.missingNames = [{ vague: '那家店', chunk: 1, resolved: '莉莉丝酒吧' }, { vague: '那个人', chunk: 1, resolved: '' }];
    resetExtractionFrom(p, 1);
    assert.deepEqual(p.missingNames.map((m) => m.vague), ['那家店']);
});

test('findCharacterKey：名字是泛称、具体别名却指向别人时，以具体别名为准', () => {
    const p = project();
    p.characters['林风'] = normalizeCharacter({ name: '林风', aliases: ['少爷'] });
    p.characters['苏墨'] = normalizeCharacter({ name: '苏墨', aliases: ['苏少爷'] });
    assert.equal(findCharacterKey(p, '少爷', ['苏少爷']), '苏墨');
    assert.equal(findCharacterKey(p, '少爷'), '林风', '只有泛称且唯一时仍然认作同一人');
    p.characters['林风'].aliases.push('风哥');
    assert.equal(findCharacterKey(p, '风哥', ['苏少爷']), null, '具体名字和具体别名指向不同的人 → 有歧义');
});

test('chunkHasContributions：只残留经历/别名出处的段也算有资料', () => {
    const p = project(2);
    p.chunks[1].status = 'pending';
    p.characters['X'] = normalizeCharacter({ name: 'X', chunksSeen: [0], experiences: [{ chunk: 1, text: '残留' }] });
    assert.equal(chunkHasContributions(p, 1), true);
    p.characters['X'].experiences = [];
    p.characters['X'].aliasSources = { 小X: [1] };
    assert.equal(chunkHasContributions(p, 1), true);
    p.characters['X'].aliasSources = {};
    assert.equal(chunkHasContributions(p, 1), false);
});
