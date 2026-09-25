// 文风测试：预设与按任务选择、范文、禁用词、提示词接入、续写检查与修正
import test from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_CATEGORIES, DEFAULT_SETTINGS } from '../src/constants.js';
import { mergeDefaults } from '../src/utils.js';
import { createProject, normalizeProject, applyExtraction, normalizeExtraction } from '../src/project.js';
import { buildChunks, detectChapters } from '../src/splitter.js';
import {
    BUILTIN_STYLE_PRESETS, COMMON_AI_BANNED, NO_STYLE_ID, PROJECT_STYLE_ID,
    analyzeStyle, bannedRulesFor, checkBanned, exportStyleJson, fixBannedInText, fixStyleUse, getStyleProfile, listStyleChoices,
    listStylePresets, parseBanned, parseStyleJson, pickSamples, removeStylePreset, replaceBanned, resolveStyleId, saveStylePreset,
    styleBlock, styleTextFor,
} from '../src/style.js';
import { buildContinuePrompt, ContinuationRunner } from '../src/continue.js';
import { buildPlanPrompt } from '../src/planner.js';
import { buildCardPrompt, lintCardFor } from '../src/cards.js';
import { buildWorldbookEntries } from '../src/worldbook.js';
import { lintText } from '../src/lint.js';
import { applyConfig } from '../src/io.js';

function settings() {
    const s = mergeDefaults({}, DEFAULT_SETTINGS);
    s.categories = structuredClone(DEFAULT_CATEGORIES);
    s.api.retryBaseMs = 200;
    s.api.retries = 0;
    s.extraction.autoSnapshotEvery = 0;
    return s;
}

const TEXT = [
    '第一章 魔女小姐',
    '江酒走进酒吧，雨水顺着伞尖滴在地板上。',
    '“你迟到了。”莉莉丝没抬头，手指敲了敲吧台。',
    '“路上堵车。”江酒把伞靠在墙边。',
    '她把一瓶紫色魔药推过来，瓶底在木头上划出一道水痕。'.repeat(2),
    '第二章 女仆',
    '江酒穿上了女仆装，对着镜子转了一圈。',
    '“挺合身。”莉莉丝说，“明天开始打扫阁楼。”',
    '他叹了口气，拎起扫帚上楼。楼梯吱呀作响，灰尘在光里打转。'.repeat(2),
    '第三章 下城区',
    '姜小白在雨中迷路，推开了酒吧的门。',
    '“请问……这里是下城区吗？”',
    '江酒给她倒了一杯热水，指了指窗外的霓虹灯。'.repeat(2),
].join('\n');

function project() {
    const chunks = detectChapters(TEXT, '^第.+章.*$').map((ch) => buildChunks([ch], 1000, false)[0]);
    chunks.forEach((c, i) => (c.index = i));
    const p = createProject({ name: '魔女', text: TEXT, chunks });
    p.characters['江酒'] = { name: '江酒', aliases: [], identity: '酒保', personality: '懒散', relationship: '', appearance: [], abilities: [], experiences: [], quotes: [], importance: 'main', firstChunk: 0, chunksSeen: [0], stages: [] };
    return normalizeProject(p);
}

// ---------------- 禁用词 ----------------

test('parseBanned：逗号分隔、替换建议、正则、注释、去重、无效正则', () => {
    const list = parseBanned(`# 注释
仿佛, 宛如、似乎
嘴角上扬 => 笑了
仿佛
/一丝[^，。]{0,4}笑意/
/[unclosed/
`);
    assert.deepEqual(list.map((b) => b.word), ['仿佛', '宛如', '似乎', '嘴角上扬', '/一丝[^，。]{0,4}笑意/', '/[unclosed/']);
    assert.equal(list[3].suggest, '笑了');
    assert.equal(list[4].regex, true);
    assert.ok(list[4].re.test('她眼里带着一丝淡淡笑意'));
    assert.equal(list[5].regex, false, '无效正则按普通词处理');
    assert.ok(parseBanned(COMMON_AI_BANNED).length > 15);
});

test('checkBanned / replaceBanned：文风禁用词 + 全局禁用词', () => {
    const p = project();
    const s = settings();
    p.style.banned = '仿佛\n嘴角上扬=>笑了';
    s.styleOptions.globalBanned = '不由得';
    const text = '他嘴角上扬，仿佛早就料到。她不由得后退一步。';
    const hits = checkBanned(text, p, s, 'continue');
    assert.deepEqual(hits.map((h) => h.match), ['嘴角上扬', '仿佛', '不由得']);
    assert.equal(hits[0].type, '禁用词');
    const r = replaceBanned(text, parseBanned(p.style.banned));
    assert.equal(r.count, 1);
    assert.equal(r.text, '他笑了，仿佛早就料到。她不由得后退一步。');
});

test('lintText 合并重复命中；角色卡审稿带上禁用词', () => {
    const p = project();
    const s = settings();
    p.style.banned = '仿佛\n端起酒杯';
    const issues = lintCardFor(p, s, { first_mes: '她仿佛没听见，端起酒杯。', description: '' });
    // “仿佛”同时命中内置模糊词规则与禁用词，只报一次
    assert.equal(issues.filter((i) => i.match === '仿佛').length, 1);
    assert.ok(issues.some((i) => i.match === '端起酒杯' && i.type === '禁用词'));
    assert.equal(lintText('仿佛', { extraRules: bannedRulesFor(p, s, 'card'), onlyExtra: true }).length, 1);
});

// ---------------- 预设与按任务选择 ----------------

test('预设：内置可修改并恢复默认，自建可删除，删除后任务回到默认', () => {
    const s = settings();
    const p = project();
    assert.equal(listStylePresets(s).length, BUILTIN_STYLE_PRESETS.length);
    const wuxia = listStylePresets(s).find((x) => x.id === 'b_wuxia');
    saveStylePreset(s, { ...wuxia, tone: '改过的语言' });
    const after = listStylePresets(s).find((x) => x.id === 'b_wuxia');
    assert.equal(after.tone, '改过的语言');
    assert.equal(after.modified, true);
    assert.equal(after.builtin, true);
    assert.equal(listStylePresets(s).length, BUILTIN_STYLE_PRESETS.length, '覆盖内置不增加条目');
    removeStylePreset(s, 'b_wuxia');
    assert.equal(listStylePresets(s).find((x) => x.id === 'b_wuxia').tone, BUILTIN_STYLE_PRESETS.find((x) => x.id === 'b_wuxia').tone);

    const mine = saveStylePreset(s, { name: '我的', perspective: '第一人称' });
    assert.ok(mine.id.startsWith('sty_'));
    p.styleUse.continue = mine.id;
    assert.equal(getStyleProfile(p, s, 'continue').perspective, '第一人称');
    removeStylePreset(s, mine.id);
    fixStyleUse(p, s);
    assert.equal(p.styleUse.continue, '');
    assert.equal(resolveStyleId(p, 'continue'), PROJECT_STYLE_ID);
    assert.ok(listStyleChoices(p, s).some((c) => c.id === NO_STYLE_ID));
});

test('按任务选择文风：跟随默认、单独指定、不指定、找不到时回退本书文风', () => {
    const s = settings();
    const p = project();
    p.style.perspective = '第三人称';
    assert.equal(getStyleProfile(p, s, 'card').name, '本书原著文风');
    p.styleUse.default = 'b_light';
    assert.equal(getStyleProfile(p, s, 'plan').name, '轻小说风');
    p.styleUse.card = PROJECT_STYLE_ID;
    assert.equal(getStyleProfile(p, s, 'card').perspective, '第三人称');
    p.styleUse.continue = NO_STYLE_ID;
    assert.equal(getStyleProfile(p, s, 'continue'), null);
    assert.match(styleTextFor(p, s, 'continue'), /不指定文风/);
    p.styleUse.plan = 'sty_不存在';
    assert.equal(getStyleProfile(p, s, 'plan').name, '本书原著文风');
});

test('旧项目数据补齐文风字段；提取结果只填空字段', () => {
    const old = normalizeProject({ name: '旧', chunks: [], style: { perspective: '第一人称', tone: '', mood: '', notes: '备注A' } });
    assert.equal(old.style.notes, '备注A');
    assert.deepEqual(old.style.samples, []);
    assert.equal(old.style.banned, '');
    assert.deepEqual(old.styleUse, { default: PROJECT_STYLE_ID, card: '', plan: '', continue: '' });
    const p = project();
    const r = normalizeExtraction({ style: { perspective: '第三人称', tone: '口语', mood: '轻松', notes: '多对话' } });
    p.style.tone = '已手写';
    applyExtraction(p, p.chunks[0], r, {});
    assert.equal(p.style.perspective, '第三人称');
    assert.equal(p.style.tone, '已手写');
    assert.equal(p.style.notes, '多对话');
});

// ---------------- 提示词 ----------------

test('styleBlock：视角/语言/基调/规则/备注/禁用词/范文，范文按上限截断', () => {
    const block = styleBlock({
        perspective: '第三人称', tone: '短句', mood: '轻松', rules: '对话多\n- 章末留钩子', notes: '称呼她为魔女小姐',
        banned: '仿佛\n/正则不写进提示/', samples: [{ text: '甲'.repeat(300) }, { text: '乙'.repeat(300) }, { text: '丙'.repeat(300) }],
    }, { maxSampleChars: 500 });
    assert.match(block, /视角：第三人称/);
    assert.match(block, /- 对话多\n- 章末留钩子/);
    assert.match(block, /备注：称呼她为魔女小姐/);
    assert.match(block, /禁用词（正文中不要出现）：仿佛/);
    assert.doesNotMatch(block, /正则不写进提示/);
    assert.match(block, /只模仿句式/);
    assert.equal((block.match(/<sample>/g) || []).length, 2);
    assert.doesNotMatch(block, /丙/);
    assert.match(styleBlock({}), /未设置文风/);
});

test('续写/写大纲/角色卡提示词使用各自的文风（修复：备注进入续写与写大纲）', () => {
    const s = settings();
    const p = project();
    Object.assign(p.style, { perspective: '第三人称', notes: '备注：主角吐槽用括号', rules: '- 对话多', banned: '仿佛', samples: [{ id: 's1', text: '“你迟到了。”莉莉丝没抬头。', source: '原文' }] });
    const cont = buildContinuePrompt(p, s, { title: '第4章', words: 2000 }).prompt;
    assert.match(cont, /# 文风/);
    assert.match(cont, /主角吐槽用括号/);
    assert.match(cont, /<sample>\n“你迟到了。”/);
    assert.match(cont, /禁用词（正文中不要出现）：仿佛/);

    const plan = buildPlanPrompt(p, s, { count: 3 }).prompt;
    assert.match(plan, /主角吐槽用括号/);
    assert.doesNotMatch(plan, /<sample>/, '写大纲默认不带范文');
    assert.doesNotMatch(plan, /禁用词（/);
    s.styleOptions.samplesInPlan = true;
    assert.match(buildPlanPrompt(p, s, { count: 3 }).prompt, /<sample>/);

    p.styleUse.card = 'b_second';
    const card = buildCardPrompt(p, s, { charName: '江酒' }).prompt;
    assert.match(card, /第二人称“你”/);
    assert.doesNotMatch(card, /主角吐槽用括号/);
    s.styleOptions.bannedInPrompt = false;
    assert.doesNotMatch(buildContinuePrompt(p, s, { title: '第4章', words: 2000 }).prompt, /禁用词（正文中不要出现）/);
});

test('世界书「文风」条目使用角色卡的文风，不带范文', () => {
    const s = settings();
    const p = project();
    s.worldbook.includeStyleEntry = true;
    Object.assign(p.style, { perspective: '第三人称', rules: '- 对话多', samples: [{ id: 's', text: '范文内容', source: '' }] });
    let e = buildWorldbookEntries(p, s).find((x) => x.name === '文风');
    assert.match(e.content, /视角：第三人称/);
    assert.match(e.content, /对话多/);
    assert.doesNotMatch(e.content, /范文内容/);
    p.styleUse.card = NO_STYLE_ID;
    e = buildWorldbookEntries(p, s).find((x) => x.name === '文风');
    assert.equal(e, undefined);
});

// ---------------- 范文 ----------------

test('pickSamples：均匀挑选、跳过章节标题、优先对话与叙述兼有', () => {
    const p = project();
    const picked = pickSamples(p, { count: 2, length: 80 });
    assert.equal(picked.length, 2);
    for (const s of picked) {
        assert.doesNotMatch(s.text, /^第.章/m);
        assert.match(s.text, /“/);
        assert.match(s.source, /^原文·/);
    }
    assert.notEqual(picked[0].text, picked[1].text);
    assert.deepEqual(pickSamples(p, { count: 2, length: 80 }), picked, '结果稳定');
    assert.deepEqual(pickSamples(createProject({ name: 'x' })), []);
});

test('导入导出文风 JSON；配置导入按 id 合并预设', () => {
    const json = exportStyleJson({ name: '测试', perspective: '第一人称', samples: [{ id: 'x', text: '范文', source: '粘贴' }], banned: '仿佛' });
    assert.equal(json.type, 'novelloom-style');
    const back = parseStyleJson(JSON.parse(JSON.stringify(json)));
    assert.equal(back[0].name, '测试');
    assert.equal(back[0].samples[0].text, '范文');
    assert.equal(parseStyleJson({ presets: [json, { foo: 1 }] }).length, 1);
    // 数组形式的规则与禁用词
    const arr = parseStyleJson({ name: 'A', rules: ['短句', '- 多对话'], banned: [{ word: '嘴角上扬', suggest: '笑了' }] })[0];
    assert.equal(arr.rules, '- 短句\n- 多对话');
    assert.equal(arr.banned, '嘴角上扬=>笑了');

    const s = settings();
    saveStylePreset(s, { id: 'sty_a', name: '本机A' });
    applyConfig(s, { type: 'novel_loom_config', settings: { stylePresets: [{ id: 'sty_b', name: '导入B' }, { id: 'sty_a', name: '覆盖A' }], styleOptions: { fixMode: 'replace' } } });
    assert.deepEqual(s.stylePresets.map((x) => x.name), ['覆盖A', '导入B']);
    assert.equal(s.styleOptions.fixMode, 'replace');
    assert.equal(s.styleOptions.sampleMaxChars, 1500, '未提供的选项保留');
});

// ---------------- AI ----------------

const calls = [];
let chapterText = '';

function installST() {
    globalThis.SillyTavern = {
        getContext: () => ({
            async generateRaw({ prompt }) {
                const text = prompt.map((m) => m.content).join('\n');
                calls.push(text);
                if (text.includes('提炼这本书的文风')) {
                    return '```json\n{"perspective":"第三人称有限","tone":"短句","mood":"轻松","rules":["对话推进","- 少用形容词","对话推进"],"banned":["仿佛","宛如"]}\n```';
                }
                if (text.includes('出现了禁用词')) {
                    const body = text.split('<text>\n')[1].split('\n</text>')[0];
                    return body.replace(/仿佛|嘴角上扬/g, '');
                }
                if (text.includes('续写任务')) {
                    const t = (text.match(/请续写《[^》]+》的下一章：([^，]+)，/) || [])[1];
                    return `${t}\n\n${chapterText}`;
                }
                return '好';
            },
            stopGeneration() {},
        }),
    };
}

test('AI 提炼文风：解析 JSON，规则去重加前缀，发送原文片段', async () => {
    installST();
    calls.length = 0;
    const p = project();
    const r = await analyzeStyle(p, settings());
    assert.equal(r.perspective, '第三人称有限');
    assert.equal(r.rules, '- 对话推进\n- 少用形容词');
    assert.equal(r.banned, '仿佛\n宛如');
    assert.match(calls[0], /<excerpt no="1">/);
});

test('AI 修正禁用词：只改命中处；结果过短时保留原文', async () => {
    installST();
    const p = project();
    const s = settings();
    p.style.banned = '仿佛';
    const text = `他仿佛睡着了。${'雨一直下。'.repeat(20)}`;
    const fixed = await fixBannedInText(text, checkBanned(text, p, s), p, s);
    assert.equal(fixed, text.replace('仿佛', ''));
    const bad = `${'仿佛'.repeat(50)}好`;
    await assert.rejects(() => fixBannedInText(bad, checkBanned(bad, p, s), p, s), /过短/);
});

test('续写：写完扫描禁用词，按建议替换 / AI 改写', async () => {
    installST();
    const run = async (fixMode) => {
        const p = project();
        const s = settings();
        s.continuation.feedback = false;
        s.styleOptions.fixMode = fixMode;
        p.style.banned = '嘴角上扬=>笑了\n仿佛';
        chapterText = `江酒嘴角上扬，仿佛什么都没发生。${'他擦着杯子。'.repeat(60)}`;
        const logs = [];
        const r = new ContinuationRunner({ getProject: () => p, settings: s, save: async () => {}, onLog: (m) => logs.push(m) });
        await r.run({ count: 1, words: 500 });
        return { content: p.continuation.chapters[0].content, logs };
    };
    const none = await run('none');
    assert.match(none.content, /嘴角上扬/);
    assert.ok(none.logs.some((l) => l.includes('命中 2 处禁用词')));
    const rep = await run('replace');
    assert.match(rep.content, /江酒笑了，仿佛/);
    assert.ok(rep.logs.some((l) => l.includes('仍有 1 处没有替换建议')));
    const ai = await run('ai');
    assert.doesNotMatch(ai.content, /仿佛|嘴角上扬/);
    assert.ok(ai.logs.some((l) => l.includes('禁用词已清除')));
});
