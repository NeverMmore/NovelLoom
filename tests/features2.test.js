// v0.6 新功能测试：人格颗粒度/台词库、写卡前试聊、群聊场景卡、场次拆分、多视角管理、伏笔看板、连续性检查
import test from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_CATEGORIES, DEFAULT_SETTINGS } from '../src/constants.js';
import { mergeDefaults } from '../src/utils.js';
import {
    characterProfileText, createProject, deleteChunkAt, mergeCharacter, mergeCharactersInto, normalizeCharacter,
    normalizeExtraction, normalizeProject, pruneGroupCards, prunePov, renameCharacter,
} from '../src/project.js';
import { removeChunkContributions } from '../src/extract.js';
import { buildPersonaSystem, greetingText, testChatReply } from '../src/testchat.js';
import { buildGroupPrompt, generateGroupCard, groupCardMarkdown, publishGroupCard } from '../src/group.js';
import {
    buildPlanPrompt, formatPlanChapter, generatePlan, insertPlanChapterAfter, sortedPlan,
} from '../src/planner.js';
import { buildContinuePrompt } from '../src/continue.js';
import { fixStyleUse, getStyleProfile, resolvePovStyleId, saveStylePreset, styleTextFor } from '../src/style.js';
import {
    addForeshadowItem, analyzeForeshadowing, chaptersOpenFor, exportForeshadowJson, foreshadowMarkdown,
    mergeForeshadowItems, parseForeshadowJson, removeForeshadowItem, reopenForeshadowItem, resolveForeshadowItem, updateForeshadowItem,
} from '../src/foreshadow.js';
import { buildContinuityPrompt, checkContinuity, normalizeIssue } from '../src/continuity.js';

function settings() {
    const s = mergeDefaults({}, DEFAULT_SETTINGS);
    s.categories = structuredClone(DEFAULT_CATEGORIES);
    s.api.retryBaseMs = 100;
    s.api.retries = 0;
    return s;
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

function project() {
    const p = createProject({ name: '测试' });
    p.chunks = [0, 1, 2].map((i) => ({ id: `c${i}`, index: i, title: `第${i + 1}章`, chapterTitles: [`第${i + 1}章`], content: '', origin: 'source' }));
    const mk = (name, extra = {}) => normalizeCharacter({ name, importance: 'main', firstChunk: 0, lastChunk: 2, chunksSeen: [0, 1, 2], ...extra });
    p.characters['江酒'] = mk('江酒');
    p.characters['莉莉丝'] = mk('莉莉丝', { identity: '大魔女' });
    return normalizeProject(p);
}

// ==================== 人格颗粒度 + 台词库 ====================

test('normalizeCharacter：人格颗粒度字段与对话样本默认为空数组', () => {
    const c = normalizeCharacter({ name: '江酒' });
    assert.deepEqual(c.hardLimits, []);
    assert.deepEqual(c.tabooTopics, []);
    assert.deepEqual(c.verbalTics, []);
    assert.deepEqual(c.dialogues, []);
});

test('normalizeExtraction：解析人格颗粒度字段与对话样本（含中文别名）', () => {
    const out = normalizeExtraction({
        characters: [{
            name: '江酒', identity: '渣男', hardLimits: ['绝对不会伤害孩子'], tabooTopics: '母亲的死',
            verbalTics: ['开口先说“小事一桩”'], dialogues: [{ text: '“喝吗？”\n“不喝。”' }],
        }],
    });
    const c = out.characters[0];
    assert.deepEqual(c.hardLimits, ['绝对不会伤害孩子']);
    assert.deepEqual(c.tabooTopics, ['母亲的死']);
    assert.deepEqual(c.verbalTics, ['开口先说“小事一桩”']);
    assert.equal(c.dialogues.length, 1);
    assert.match(c.dialogues[0].text, /喝吗/);
});

test('mergeCharacter：累积并去重人格颗粒度字段，对话样本按原文校验且上限 12 条', () => {
    const p = project();
    const source = '江酒说：“喝吗？”\n他又说：“不喝。”';
    mergeCharacter(p, { name: '江酒', hardLimits: ['不伤害孩子'], tabooTopics: ['母亲'], verbalTics: ['口癖A'], dialogues: [{ text: '“喝吗？”\n他又说：“不喝。”' }] }, 0, { sourceText: source, verify: true });
    mergeCharacter(p, { name: '江酒', hardLimits: ['不伤害孩子', '不背叛朋友'], verbalTics: ['口癖A'], dialogues: [{ text: '编造的、原文里没有的对话' }] }, 1, { sourceText: source, verify: true });
    const ch = p.characters['江酒'];
    assert.deepEqual(ch.hardLimits, ['不伤害孩子', '不背叛朋友'], '去重追加');
    assert.deepEqual(ch.tabooTopics, ['母亲']);
    assert.deepEqual(ch.verbalTics, ['口癖A'], '重复口癖不应该重复追加');
    assert.equal(ch.dialogues.length, 1, '原文里验证不通过的对话样本应该被拒绝（verify:true）');
});

test('characterProfileText：人格颗粒度与原文对话样本会渲染进档案文本', () => {
    const ch = normalizeCharacter({
        name: '江酒', hardLimits: ['不伤害孩子'], tabooTopics: ['母亲的死'], verbalTics: ['开口先说“小事一桩”'],
        dialogues: [{ text: '“喝吗？”\n“不喝。”', verified: true }],
    });
    const text = characterProfileText(ch, { withDialogues: true, maxDialogues: 2 });
    assert.match(text, /绝对不会做的事:\n {2}- 不伤害孩子/);
    assert.match(text, /忌讳话题:\n {2}- 母亲的死/);
    assert.match(text, /口癖\/说话习惯:\n {2}- 开口先说/);
    assert.match(text, /原文对话样本/);
    assert.match(text, /喝吗/);
    const noDialogues = characterProfileText(ch, { withDialogues: false });
    assert.ok(!noDialogues.includes('原文对话样本'));
});

test('mergeCharactersInto：合并角色时人格颗粒度字段与对话样本一起并入目标角色', () => {
    const p = project();
    p.characters['江酒'].hardLimits = ['不伤害孩子'];
    p.characters['莉莉丝'].hardLimits = ['不背叛朋友', '不伤害孩子'];
    p.characters['莉莉丝'].dialogues = [{ text: '“晚安。”', chunk: 0 }];
    mergeCharactersInto(p, '江酒', ['莉莉丝']);
    assert.deepEqual(p.characters['江酒'].hardLimits.sort(), ['不伤害孩子', '不背叛朋友'].sort());
    assert.equal(p.characters['江酒'].dialogues.length, 1);
});

test('extract.removeChunkContributions：清除某段贡献时同步过滤该段贡献的对话样本', () => {
    const p = project();
    p.characters['江酒'].dialogues = [{ text: 'A', chunk: 0 }, { text: 'B', chunk: 1 }];
    removeChunkContributions(p, 0);
    assert.deepEqual(p.characters['江酒'].dialogues.map((d) => d.text), ['B']);
});

// ==================== 写卡前试聊 ====================

test('buildPersonaSystem / greetingText：解析 {{char}}/{{user}} 宏', () => {
    const card = { data: { name: '莉莉丝', description: '{{char}}是魔女，{{user}}是她的雇员。', personality: '', scenario: '', mes_example: '', first_mes: '欢迎你，{{user}}。' } };
    const sys = buildPersonaSystem(card, { userName: '江酒' });
    assert.match(sys, /扮演「莉莉丝」/);
    assert.match(sys, /莉莉丝是魔女，江酒是她的雇员/);
    assert.equal(greetingText(card, { userName: '江酒' }), '欢迎你，江酒。');
});

test('testChatReply：系统提示 + 历史 + 新消息一起发送，返回清理后的文本；空消息报错', async () => {
    let seenJoined = '';
    installST((text) => {
        seenJoined = text;
        return '<thinking>...</thinking>好的，请问你需要什么？';
    });
    const card = { data: { name: '莉莉丝', description: '魔女', personality: '', scenario: '', mes_example: '', first_mes: '' } };
    const s = settings();
    const reply = await testChatReply(null, s, card, [{ role: 'user', content: '你好' }, { role: 'assistant', content: '嗯？' }], '再聊聊', {});
    assert.equal(reply, '好的，请问你需要什么？');
    assert.match(seenJoined, /扮演「莉莉丝」/);
    assert.match(seenJoined, /你好/);
    assert.match(seenJoined, /再聊聊/);
    await assert.rejects(testChatReply(null, s, card, [], '   '), /请输入消息/);
});

// ==================== 群聊/多人场景卡 ====================

test('buildGroupPrompt：至少两个角色，按时间点防剧透生成资料', () => {
    const p = project();
    p.characters['江酒'].stages = [{ chunk: 0, identity: '路人' }];
    p.characters['江酒'].identity = '莉莉丝的前男友';
    assert.throws(() => buildGroupPrompt(p, settings(), { names: ['江酒'] }), /至少选择两个角色/);
    const { system, prompt, names } = buildGroupPrompt(p, settings(), { names: ['江酒', '莉莉丝'], timepoint: 0 });
    assert.deepEqual(names.sort(), ['江酒', '莉莉丝'].sort());
    assert.match(system, /群聊场景设计师/);
    assert.match(prompt, /第 1 段结束时/);
});

test('generateGroupCard / groupCardMarkdown：解析 AI JSON，导出 Markdown', async () => {
    const p = project();
    installST(() => JSON.stringify({ scenario: '酒吧打烊后', first_mes: '灯光暗下来。', notes: { 江酒: '有点心虚', 莉莉丝: '气定神闲' } }));
    const card = await generateGroupCard(p, settings(), { names: ['江酒', '莉莉丝'] });
    assert.equal(card.data.scenario, '酒吧打烊后');
    assert.deepEqual(card.members.sort(), ['江酒', '莉莉丝'].sort());
    assert.equal(card.data.notes['江酒'], '有点心虚');
    const md = groupCardMarkdown(card);
    assert.match(md, /## 场景\n酒吧打烊后/);
    assert.match(md, /\*\*江酒\*\*：有点心虚/);
});

test('publishGroupCard：成员缺少酒馆头像时报错；否则创建/更新群聊并记录 stGroupId', async () => {
    const groupCard = { name: '江酒、莉莉丝 · 群聊', members: ['江酒', '莉莉丝'], stGroupId: '' };
    await assert.rejects(publishGroupCard(groupCard, () => ''), /还没有写入酒馆/);

    const origFetch = globalThis.fetch;
    const calls = [];
    globalThis.fetch = async (url, init) => {
        calls.push({ url, body: JSON.parse(init.body) });
        if (url === '/api/groups/create') return new Response(JSON.stringify({ id: 'grp_1' }), { status: 200 });
        if (url === '/api/groups/edit') return new Response('{}', { status: 200 });
        return new Response('{}', { status: 404 });
    };
    globalThis.SillyTavern = { getContext: () => ({ getRequestHeaders: () => ({ 'Content-Type': 'application/json' }) }) };
    try {
        const id = await publishGroupCard(groupCard, (n) => (n === '江酒' ? 'jiangjiu' : 'lilith'));
        assert.equal(id, 'grp_1');
        assert.equal(groupCard.stGroupId, 'grp_1');
        assert.deepEqual(calls[0].body.members, ['jiangjiu.png', 'lilith.png']);
        await publishGroupCard(groupCard, (n) => (n === '江酒' ? 'jiangjiu' : 'lilith'));
        assert.equal(calls[1].url, '/api/groups/edit', '已有 stGroupId 时应该更新而不是重新创建');
    } finally {
        globalThis.fetch = origFetch;
    }
});

test('groupCards 数据同步：改名 / 合并 / 手动删除人物、分块删除后成员不足两人会被清理', () => {
    const p = project();
    p.groupCards.push({ id: 'g1', name: '群', members: ['江酒', '莉莉丝'], timepoint: null, requirement: '', data: { scenario: '', first_mes: '', notes: { 江酒: 'x' } }, createdAt: 0, updatedAt: 0, stGroupId: '' });
    renameCharacter(p, '江酒', '酒酒');
    assert.deepEqual(p.groupCards[0].members.sort(), ['莉莉丝', '酒酒'].sort());
    assert.equal(p.groupCards[0].data.notes['酒酒'], 'x');
    delete p.characters['莉莉丝'];
    pruneGroupCards(p);
    assert.equal(p.groupCards.length, 0, '成员不足两人的群聊卡应该被清理');
});

// ==================== 场次/节拍拆分 ====================

test('formatPlanChapter：渲染场次列表（地点/在场角色/概要）', () => {
    const c = { no: 3, title: '摊牌', summary: '概要', scenes: [{ location: '酒吧', characters: ['江酒', '莉莉丝'], summary: '江酒提出分手' }] };
    const text = formatPlanChapter(c);
    assert.match(text, /场次（按顺序写完）：\n {2}1\. \[酒吧\] 在场：江酒、莉莉丝 — 江酒提出分手/);
});

test('buildPlanPrompt：SCENE_GUIDE 按 useScenes 开关切换', () => {
    const p = project();
    const s1 = settings();
    s1.planner.useScenes = false;
    assert.match(buildPlanPrompt(p, s1).prompt, /scenes 留空数组/);
    const s2 = settings();
    s2.planner.useScenes = true;
    assert.match(buildPlanPrompt(p, s2).prompt, /拆成 3-5 个场次/);
});

test('generatePlan：解析 AI 返回的 scenes 字段并写入规划', async () => {
    const p = project();
    installST(() => JSON.stringify({
        overview: '走向',
        chapters: [{ title: '摊牌', summary: '概要', characters: ['江酒'], events: [], foreshadowing: [], scenes: [{ location: '酒吧', characters: ['江酒', '莉莉丝'], summary: '摊牌' }], hook: '钩子' }],
    }));
    const s = settings();
    s.planner.useScenes = true;
    const { chapters } = await generatePlan(p, s, { count: 1 });
    assert.equal(chapters[0].scenes.length, 1);
    assert.equal(chapters[0].scenes[0].location, '酒吧');
    assert.deepEqual(sortedPlan(p)[0].scenes[0].characters.sort(), ['江酒', '莉莉丝'].sort());
});

test('insertPlanChapterAfter：新插入的空白章节带空场次与空视角', () => {
    const p = project();
    const ch = insertPlanChapterAfter(p, 0);
    assert.deepEqual(ch.scenes, []);
    assert.equal(ch.pov, '');
});

// ==================== 多视角管理 ====================

test('resolvePovStyleId / getStyleProfile：povChar 映射优先于任务默认文风', () => {
    const p = project();
    const s = settings();
    const preset = saveStylePreset(s, { name: '江酒视角', rules: '- 第一人称，吐槽多', banned: '仿佛' });
    p.povStyles['江酒'] = preset.id;
    assert.equal(resolvePovStyleId(p, '江酒'), preset.id);
    assert.equal(resolvePovStyleId(p, '莉莉丝'), '');
    const prof = getStyleProfile(p, s, 'continue', '江酒');
    assert.equal(prof.id, preset.id);
    const fallback = getStyleProfile(p, s, 'continue', '莉莉丝');
    assert.equal(fallback.name, '本书原著文风');
});

test('styleTextFor：povChar 指定时使用映射预设的写法规则与禁用词', () => {
    const p = project();
    const s = settings();
    const preset = saveStylePreset(s, { name: '莉莉丝视角', rules: '- 慢条斯理，少用感叹号', banned: '哇塞' });
    p.povStyles['莉莉丝'] = preset.id;
    const text = styleTextFor(p, s, 'continue', '莉莉丝');
    assert.match(text, /慢条斯理/);
    assert.match(text, /哇塞/);
    const defaultText = styleTextFor(p, s, 'continue');
    assert.ok(!defaultText.includes('慢条斯理'));
});

test('buildContinuePrompt：大纲标记了本章视角角色时，STYLE 使用该角色映射的文风', () => {
    const p = project();
    const s = settings();
    const preset = saveStylePreset(s, { name: '江酒视角', rules: '- 第一人称吐槽体' });
    p.povStyles['江酒'] = preset.id;
    const plan = { no: 1, title: '开场', pov: '江酒' };
    const { prompt } = buildContinuePrompt(p, s, { title: '第1章', words: 1000, plan, upcoming: [] });
    assert.match(prompt, /第一人称吐槽体/);
    assert.match(prompt, /本章视角：江酒/, '本章大纲块里也应该点明视角角色');
});

test('多视角数据同步：改名/删除角色时 povStyles 与 plan.chapters[].pov 一起清理', () => {
    const p = project();
    const s = settings();
    const preset = saveStylePreset(s, { name: 'X' });
    p.povStyles['江酒'] = preset.id;
    p.plan.chapters.push({ id: 'pl1', no: 1, title: '', summary: '', characters: [], events: [], foreshadowing: [], scenes: [], hook: '', pov: '江酒', status: 'planned' });
    renameCharacter(p, '江酒', '酒酒');
    assert.equal(p.povStyles['酒酒'], preset.id);
    assert.ok(!('江酒' in p.povStyles));
    assert.equal(p.plan.chapters[0].pov, '酒酒');
    delete p.characters['酒酒'];
    prunePov(p);
    assert.ok(!('酒酒' in p.povStyles));
    assert.equal(p.plan.chapters[0].pov, '');
});

test('fixStyleUse：预设被删除后，povStyles 里指向它的映射被清除', () => {
    const p = project();
    const s = settings();
    p.povStyles['江酒'] = 'no-such-preset-id';
    fixStyleUse(p, s);
    assert.ok(!('江酒' in p.povStyles));
});

// ==================== 伏笔看板 ====================

function projectWithPlan() {
    const p = normalizeProject(createProject({ name: '测试' })); // 不带原文分段，章号只由 continuation.chapters 决定
    p.continuation.chapters.push({ id: 'w1' }, { id: 'w2' }, { id: 'w3' }); // 已写 3 章，nextChapterNo = 4
    p.plan.chapters.push(
        { id: 'pl1', no: 1, title: '第一章', summary: '', characters: [], events: [], foreshadowing: ['江酒手上的旧疤的来历'], scenes: [], hook: '', pov: '', status: 'written' },
        { id: 'pl2', no: 2, title: '第二章', summary: '', characters: [], events: [], foreshadowing: ['莉莉丝身世成谜'], scenes: [], hook: '', pov: '', status: 'written' },
        { id: 'pl3', no: 3, title: '第三章', summary: '', characters: [], events: [], foreshadowing: ['莉莉丝身世揭晓：她其实是被诅咒的公主'], scenes: [], hook: '', pov: '', status: 'written' },
    );
    return p;
}

test('伏笔看板 CRUD：添加、编辑、标记回收/重新打开、删除', () => {
    const p = project();
    const f = addForeshadowItem(p, { text: '江酒手上的旧疤的来历', plantedNo: 1 });
    assert.equal(p.foreshadow.length, 1);
    assert.throws(() => addForeshadowItem(p, { text: '' }), /请填写伏笔内容/);
    updateForeshadowItem(p, f.id, { notes: '备注' });
    assert.equal(p.foreshadow[0].notes, '备注');
    resolveForeshadowItem(p, f.id, 5);
    assert.equal(p.foreshadow[0].status, 'resolved');
    assert.equal(p.foreshadow[0].resolvedNo, 5);
    reopenForeshadowItem(p, f.id);
    assert.equal(p.foreshadow[0].status, 'open');
    assert.equal(p.foreshadow[0].resolvedNo, null);
    assert.equal(removeForeshadowItem(p, f.id), true);
    assert.equal(p.foreshadow.length, 0);
});

test('chaptersOpenFor：按当前最新已写章节计算挂了多少章；已回收或无埋下章号时返回 null', () => {
    const p = projectWithPlan(); // nextChapterNo = 4，latest = 3
    const f = addForeshadowItem(p, { text: '伏笔A', plantedNo: 1 });
    assert.equal(chaptersOpenFor(p, f), 3);
    const resolved = addForeshadowItem(p, { text: '伏笔B', plantedNo: 1, status: 'resolved', resolvedNo: 2 });
    assert.equal(chaptersOpenFor(p, resolved), null);
    const noPlant = addForeshadowItem(p, { text: '伏笔C' });
    assert.equal(chaptersOpenFor(p, noPlant), null);
});

test('mergeForeshadowItems：按归一化文本去重，状态变化才算更新', () => {
    const p = project();
    const r1 = mergeForeshadowItems(p, [{ text: '江酒手上的旧疤的来历', plantedNo: 1, status: 'open' }]);
    assert.deepEqual(r1, { added: 1, updated: 0 });
    const r2 = mergeForeshadowItems(p, [{ text: '江酒手上的旧疤的来历', plantedNo: 1, status: 'open' }]);
    assert.deepEqual(r2, { added: 0, updated: 0 }, '状态没变化不应该算更新');
    const r3 = mergeForeshadowItems(p, [{ text: '江酒手上的旧疤的来历', status: 'resolved', resolvedNo: 3 }]);
    assert.deepEqual(r3, { added: 0, updated: 1 });
    assert.equal(p.foreshadow[0].status, 'resolved');
    assert.equal(p.foreshadow[0].resolvedNo, 3);
});

test('analyzeForeshadowing：从各章大纲的「伏笔」字段拼装提示词，AI 结果合并进看板；大纲没有伏笔记录时报错', async () => {
    const p = projectWithPlan();
    let seenPrompt = '';
    installST((text) => {
        seenPrompt = text;
        return JSON.stringify({ items: [
            { text: '江酒手上的旧疤的来历', plantedNo: 1, status: 'open' },
            { text: '莉莉丝身世成谜', plantedNo: 2, status: 'resolved', resolvedNo: 3 },
        ] });
    });
    const res = await analyzeForeshadowing(p, settings());
    assert.match(seenPrompt, /第1章.*旧疤的来历/);
    assert.equal(res.added, 2);
    assert.equal(p.foreshadow.find((f) => f.text.includes('身世成谜')).status, 'resolved');

    const empty = project();
    await assert.rejects(analyzeForeshadowing(empty, settings()), /还没有记录伏笔/);
});

test('foreshadowMarkdown / exportForeshadowJson / parseForeshadowJson：导出与导入', () => {
    const p = project();
    assert.equal(foreshadowMarkdown(p), '');
    addForeshadowItem(p, { text: '伏笔A', plantedNo: 1, status: 'resolved', resolvedNo: 2 });
    assert.match(foreshadowMarkdown(p), /\| 伏笔A \| 已回收 \| 第1章 \| 第2章 \|/);
    const json = exportForeshadowJson(p);
    assert.equal(json.type, 'novelloom-foreshadow');
    const parsed = parseForeshadowJson(json);
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0].text, '伏笔A');
});

// ==================== 连续性检查 ====================

test('buildContinuityPrompt：按分块时间点取“已知设定”，排除这一章自己贡献/揭晓的资料', () => {
    const p = project();
    p.chunks.push({ id: 'c3', index: 3, title: '摊牌', content: '莉莉丝陪着江酒去买菜。', origin: 'generated' });
    p.characters['莉莉丝'] = normalizeCharacter({
        name: '莉莉丝', identity: '大魔女（真实身份揭晓）', firstChunk: 0, lastChunk: 3, chunksSeen: [0, 1, 2, 3],
        stages: [{ chunk: 0, identity: '旅人' }, { chunk: 3, identity: '大魔女（真实身份揭晓）' }],
    });
    const fedBack = { id: 'g1', title: '第四章', content: '莉莉丝陪着江酒去买菜。', chunkId: 'c3' };
    const { prompt: p1 } = buildContinuityPrompt(p, settings(), fedBack);
    assert.match(p1, /身份: 旅人/);
    assert.ok(!p1.includes('真实身份揭晓'), '已回灌章节应该用回灌前一段作为核对基准，避免用这一章自己揭晓的身份当依据');

    const notFedBack = { id: 'g2', title: '第五章', content: '莉莉丝陪着江酒去买菜。', chunkId: '' };
    const { prompt: p2 } = buildContinuityPrompt(p, settings(), notFedBack);
    assert.match(p2, /身份: 大魔女（真实身份揭晓）/, '未回灌的章节还没有更新角色资料，直接用当前状态即可');
});

test('checkContinuity：解析 AI 返回的矛盾清单并保存到章节上；没有正文或找不到章节时报错', async () => {
    const p = project();
    p.continuation.chapters.push({ id: 'g1', title: '第四章', content: '莉莉丝说出了连她自己都还不知道的秘密。', chunkId: '' });
    installST(() => JSON.stringify({ issues: [
        { type: 'knowledge', severity: 'high', quote: '莉莉丝说出了连她自己都还不知道的秘密', problem: '角色说出了不该知道的事', evidence: '角色档案里这段经历还没有发生' },
        { type: 'weird-type', problem: '类型不合法也应该被归一化为 other' },
    ] }));
    const issues = await checkContinuity(p, settings(), 'g1');
    assert.equal(issues.length, 2);
    assert.equal(issues[0].type, 'knowledge');
    assert.equal(issues[1].type, 'other');
    assert.equal(p.continuation.chapters[0].continuityCheck.issues.length, 2);
    assert.ok(p.continuation.chapters[0].continuityCheck.checkedAt > 0);

    await assert.rejects(checkContinuity(p, settings(), 'no-such-id'), /找不到这一章/);
    p.continuation.chapters.push({ id: 'g2', title: '空', content: '' });
    await assert.rejects(checkContinuity(p, settings(), 'g2'), /还没有正文/);
});

test('normalizeIssue：非法 type/severity 归一化为默认值', () => {
    assert.equal(normalizeIssue({ type: 'x', problem: 'p' }).type, 'other');
    assert.equal(normalizeIssue({ severity: 'x', problem: 'p' }).severity, 'medium');
    assert.equal(normalizeIssue({ type: 'timeline', severity: 'high', problem: 'p' }).type, 'timeline');
});

// ==================== 与既有同步机制的交叉验证（remapChunkRefs 触发 prunePov） ====================

test('remapChunkRefs（删段场景）：角色被移除时同步清理 povStyles 与 groupCards', () => {
    const p = project();
    const s = settings();
    const preset = saveStylePreset(s, { name: 'X' });
    p.povStyles['莉莉丝'] = preset.id;
    p.groupCards.push({ id: 'g1', name: '群', members: ['江酒', '莉莉丝'], timepoint: null, requirement: '', data: { scenario: '', first_mes: '', notes: {} }, createdAt: 0, updatedAt: 0, stGroupId: '' });
    p.characters['莉莉丝'].chunksSeen = [0];
    p.characters['莉莉丝'].firstChunk = 0;
    p.characters['莉莉丝'].lastChunk = 0;
    deleteChunkAt(p, 0);
    assert.ok(!p.characters['莉莉丝'], '莉莉丝只在被删的段出现过，应该被移除');
    assert.ok(!('莉莉丝' in p.povStyles));
    assert.equal(p.groupCards.length, 0);
});
