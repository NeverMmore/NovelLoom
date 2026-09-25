// 管线测试：用模拟的酒馆上下文跑通 提取 → 角色卡 → 续写 → 写入
import test from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_CATEGORIES, DEFAULT_SETTINGS } from '../src/constants.js';
import { mergeDefaults } from '../src/utils.js';
import { createProject } from '../src/project.js';
import { buildChunks, detectChapters } from '../src/splitter.js';
import { ExtractionRunner } from '../src/extract.js';
import { ContinuationRunner } from '../src/continue.js';
import { generateCard, buildCardPrompt } from '../src/cards.js';
import { callLLM } from '../src/llm.js';
import { detectAliases, buildStorySummary } from '../src/tools.js';
import { prepareCard, publishWorldbook } from '../src/publish.js';

const NOVEL = [
    '第一章 魔女小姐', '江酒走进酒吧。莉莉丝坐在角落，黑色长裙拖到地上。', '“没错，今晚我是来跟你提分手的。”江酒说。', '莉莉丝把一瓶紫色魔药推到他面前。'.repeat(3),
    '第二章 女仆', '江酒穿上了女仆装。小酒在镜子前转了一圈。莉莉丝去参加魔女茶会。'.repeat(3),
    '第三章 下城区', '姜小白在雨中迷路，走进了下城区的酒吧。江酒给她倒了一杯热水。'.repeat(3),
].join('\n');

const calls = [];
let failFirst = 0;

function extractionResponse(prompt) {
    const src = prompt.split('<source>')[1]?.split('</source>')[0] || '';
    const title = (prompt.match(/第 (\d+) 段「([^」]+)」/) || [])[2] || '';
    const characters = [];
    if (src.includes('江酒')) characters.push({ name: '江酒', aliases: src.includes('小酒') ? ['小酒'] : [], identity: src.includes('女仆') || prompt.includes('身份: 莉莉丝的女仆') ? '莉莉丝的女仆' : '渣男', personality: '脸皮厚，被抓包也照样笑', relationship: '莉莉丝的前男友', experiences: [`${title}的经历`], quotes: src.includes('分手') ? [{ text: '没错，今晚我是来跟你提分手的。', context: '赴约' }, { text: '编造的台词', context: 'x' }] : [], importance: 'main' });
    if (src.includes('莉莉丝')) characters.push({ name: '莉莉丝', identity: '大魔女', personality: '说话慢条斯理', relationship: '江酒的主人', appearance: ['黑色长裙'], importance: 'main' });
    if (src.includes('姜小白')) characters.push({ name: '姜小白', identity: '迷路的女孩', importance: 'support' });
    const entries = { 地点: [], 世界观: [] };
    if (src.includes('酒吧')) entries.地点.push({ name: '酒吧', keywords: ['酒吧'], content: src.includes('下城区') ? '位于下城区' : '莉莉丝经营的酒吧' });
    if (src.includes('魔药')) entries.世界观.push({ name: '魔女秘药', keywords: ['魔药'], content: '喝下会成为见习魔女' });
    return JSON.stringify({ chapters: [{ name: title, notes: `${title}的概要，发生了一些事情` }], characters, entries, style: { perspective: '第三人称', tone: '口语化', mood: '轻松' } });
}

function mockLLM(prompt, system) {
    if (prompt.includes('<source>')) return '<thinking>分析中</thinking>```json\n' + extractionResponse(prompt) + '\n```';
    if (prompt.includes('字段写法')) {
        return JSON.stringify({
            name: '莉莉丝', description: '基本信息:\n  姓名: 莉莉丝\n性格调色盘:\n  底色: 骄傲', personality: '慢条斯理', scenario: '酒吧打烊后',
            first_mes: '莉莉丝把最后一只杯子倒扣在吧台上——仿佛早就知道你会来。', alternate_greetings: ['雨夜，门铃响了。'], mes_example: ['{{user}}: 你好\n{{char}}: 坐。'], tags: ['魔女'],
        });
    }
    if (prompt.includes('续写任务')) {
        const t = (prompt.match(/请续写《[^》]+》的下一章：([^，]+)，/) || [])[1];
        return `${t} 雨夜\n\n${'江酒擦着杯子，莉莉丝在楼上翻书。'.repeat(30)}`;
    }
    if (prompt.includes('指向同一实体的名称组')) return '{"groups": [{"main": "江酒", "aliases": ["不存在的人"], "reason": "x"}]}';
    if (prompt.includes('故事梗概')) return '江酒被莉莉丝变成女仆。';
    return '好';
}

function installST() {
    const saved = { worlds: {}, imports: [] };
    const ctx = {
        name1: 'User',
        name2: '莉莉丝',
        characters: [],
        extensionSettings: {},
        saveSettingsDebounced() {},
        getRequestHeaders: () => ({ 'Content-Type': 'application/json', 'X-CSRF-Token': 't' }),
        async generateRaw({ prompt, systemPrompt }) {
            const text = Array.isArray(prompt) ? prompt.map((m) => m.content).join('\n') : prompt;
            calls.push({ text, system: systemPrompt });
            if (failFirst > 0) {
                failFirst--;
                throw new Error('429 rate limit');
            }
            await new Promise((r) => setTimeout(r, 2));
            return mockLLM(text, systemPrompt);
        },
        async saveWorldInfo(name, data) {
            saved.worlds[name] = data;
        },
        async updateWorldInfoList() {},
        getWorldInfoNames: () => Object.keys(saved.worlds),
        stopGeneration() {},
    };
    globalThis.SillyTavern = { getContext: () => ctx };
    return saved;
}

function settings() {
    const s = mergeDefaults({}, DEFAULT_SETTINGS);
    s.categories = structuredClone(DEFAULT_CATEGORIES);
    s.api.retryBaseMs = 500;
    s.extraction.autoSnapshotEvery = 0;
    return s;
}

function project() {
    // 每章一块
    const chunks = detectChapters(NOVEL, '^第.+章.*$').map((ch) => buildChunks([ch], 1000, false)[0]);
    chunks.forEach((c, i) => (c.index = i));
    return createProject({ name: '魔女', text: NOVEL, chunks });
}

async function runExtraction(mode) {
    installST();
    const s = settings();
    s.extraction.mode = mode;
    const p = project();
    const logs = [];
    const runner = new ExtractionRunner({ getProject: () => p, settings: s, save: async () => {}, onLog: (m) => logs.push(m) });
    const r = await runner.run();
    return { p, s, r, logs };
}

test('串行提取：滚动累积、别名合并、引用校验、已知资料注入', async () => {
    calls.length = 0;
    const { p, r } = await runExtraction('serial');
    assert.equal(r.finished, p.chunks.length);
    assert.equal(r.failed, 0);
    assert.ok(p.chunks.every((c) => c.status === 'done'));
    const j = p.characters['江酒'];
    assert.ok(j, '应有江酒');
    assert.equal(j.identity, '莉莉丝的女仆', '后续段落的身份应覆盖');
    assert.ok(j.aliases.includes('小酒'));
    assert.equal(j.quotes.length, 1, '编造的引用应被逐字校验过滤');
    assert.equal(p.characters['姜小白'].importance, 'support');
    assert.ok(p.worldbook['地点']['酒吧']);
    assert.equal(p.style.perspective, '第三人称');
    // 第二段起提示词中应注入已知资料
    const second = calls.find((c) => c.text.includes('第 2 段'));
    assert.ok(second.text.includes('已知资料'));
    assert.ok(second.text.includes('姓名: 江酒'));
    // replace 模式：第三段 AI 看过“酒吧”的完整内容，输出替换旧内容
    assert.equal(p.worldbook['地点']['酒吧'].content, '位于下城区');
});

test('并行与分批模式也能完成且结果一致', async () => {
    for (const mode of ['parallel', 'batch']) {
        const { p, r } = await runExtraction(mode);
        assert.equal(r.failed, 0, mode);
        assert.ok(p.characters['江酒'] && p.characters['莉莉丝'] && p.characters['姜小白'], mode);
        assert.ok(p.characters['江酒'].stages.length >= 2, `${mode}：各段的身份变化都记录在阶段里`);
    }
});

test('LLM 重试：429 后自动重试成功', async () => {
    installST();
    failFirst = 1;
    const retries = [];
    const res = await callLLM({ api: { mode: 'tavern', retries: 2, retryBaseMs: 500 }, prompt: 'hi', onRetry: (x) => retries.push(x) });
    assert.equal(res.text, '好');
    assert.equal(retries.length, 1);
    assert.equal(res.attempts, 2);
});

test('LLM 中止：停止信号立即结束等待', async () => {
    installST();
    const ctl = new AbortController();
    const p = callLLM({ api: { mode: 'tavern', retries: 0 }, prompt: 'hi', signal: ctl.signal });
    ctl.abort();
    await assert.rejects(p, (e) => e.name === 'AbortError');
});

test('OpenAI 兼容直连模式', async () => {
    const orig = globalThis.fetch;
    let seen;
    globalThis.fetch = async (url, init) => {
        seen = { url, body: JSON.parse(init.body), headers: init.headers };
        return new Response(JSON.stringify({ choices: [{ message: { content: '直连成功' } }] }), { status: 200 });
    };
    try {
        const res = await callLLM({ api: { mode: 'openai', endpoint: 'http://127.0.0.1:5000/v1/', apiKey: 'k', model: 'm', retries: 0 }, system: 'sys', prompt: 'hi' });
        assert.equal(res.text, '直连成功');
        assert.equal(seen.url, 'http://127.0.0.1:5000/v1/chat/completions');
        assert.equal(seen.body.messages[0].role, 'system');
        assert.equal(seen.headers.Authorization, 'Bearer k');
    } finally {
        globalThis.fetch = orig;
    }
});

test('HTTP 400 不重试，503 重试', async () => {
    const orig = globalThis.fetch;
    let n = 0;
    globalThis.fetch = async () => {
        n++;
        return new Response('bad', { status: n === 1 ? 503 : 400 });
    };
    try {
        await assert.rejects(callLLM({ api: { mode: 'openai', endpoint: 'http://x/v1', model: 'm', retries: 3, retryBaseMs: 500 }, prompt: 'hi' }), /HTTP 400/);
        assert.equal(n, 2);
    } finally {
        globalThis.fetch = orig;
    }
});

test('角色卡生成：时间点、审稿、世界书排除本人', async () => {
    const { p, s } = await runExtraction('serial');
    const { prompt } = buildCardPrompt(p, s, { kind: 'character', charName: '莉莉丝', timepoint: 0 });
    assert.ok(!prompt.includes('姜小白'), '时间点 0 之前没有姜小白，不应剧透');
    const card = await generateCard(p, s, { kind: 'character', charName: '莉莉丝', timepoint: Infinity });
    assert.equal(card.data.name, '莉莉丝');
    assert.equal(card.data.mes_example.startsWith('<START>'), true);
    assert.ok(card.lint.some((i) => i.type === '破折号'));
    assert.ok(card.lint.some((i) => i.type === '模糊词'));
    p.cards.push(card);
    const { json, entries, worldName } = prepareCard(p, s, card);
    assert.equal(worldName, '《魔女》世界书');
    assert.ok(!entries.some((e) => e.category === '角色' && e.name === '莉莉丝'));
    assert.ok(entries.some((e) => e.name === '江酒'));
    assert.equal(json.data.extensions.world, '《魔女》世界书');
    assert.equal(json.data.character_book.entries.length, entries.length);
    // 早期时间点的卡片绑定独立世界书
    const early = { ...card, timepoint: 0, worldName: '' };
    assert.equal(prepareCard(p, s, early).worldName, '《魔女》世界书（至第1段）');
    // 世界卡
    const world = await generateCard(p, s, { kind: 'world', timepoint: Infinity });
    assert.equal(world.kind, 'world');
});

test('写入酒馆世界书', async () => {
    const { p, s } = await runExtraction('serial');
    const saved = installST();
    const n = await publishWorldbook(p, s, '测试世界书');
    assert.ok(n > 3);
    const w = saved.worlds['测试世界书'];
    assert.equal(Object.keys(w.entries).length, n);
    assert.ok(Object.values(w.entries).some((e) => e.comment === '角色 - 江酒'));
});

test('续写：逐章生成并回灌资料库', async () => {
    const { p, s } = await runExtraction('serial');
    const before = p.chunks.length;
    const logs = [];
    const runner = new ContinuationRunner({ getProject: () => p, settings: s, save: async () => {}, onLog: (m) => logs.push(m) });
    const done = await runner.run({ count: 2, words: 500, direction: '江酒想逃跑', feedback: true });
    assert.equal(done, 2);
    assert.equal(p.continuation.chapters.length, 2);
    assert.equal(p.continuation.chapters[0].title, '第4章 雨夜');
    assert.equal(p.continuation.chapters[1].no, 5);
    assert.equal(p.chunks.length, before + 2);
    assert.ok(p.chunks.slice(-2).every((c) => c.origin === 'generated' && c.status === 'done'));
    assert.ok(p.characters['江酒'].chunksSeen.includes(before), '续写章节应回灌角色出场记录');
    // 续写提示词包含前文与方向
    const cont = calls.filter((c) => c.text.includes('续写任务')).pop();
    assert.ok(cont.text.includes('江酒想逃跑'));
    assert.ok(cont.text.includes('<previous>'));
});

test('别名检测过滤不存在的名称；剧情梗概', async () => {
    const { p, s } = await runExtraction('serial');
    const groups = await detectAliases(p, s, '角色');
    assert.equal(groups.length, 0);
    const sum = await buildStorySummary(p, s);
    assert.equal(sum, '江酒被莉莉丝变成女仆。');
});

test('提取管线自动扫描注音符号并记入 censorFlags（独立 mock，不影响其它用例）', async () => {
    // 用一个只返回注音符号的最小 mock，不复用共享的 mockLLM/extractionResponse
    globalThis.SillyTavern = {
        getContext: () => ({
            name1: 'User', name2: '莉莉丝', characters: [], extensionSettings: {},
            saveSettingsDebounced() {},
            getRequestHeaders: () => ({ 'Content-Type': 'application/json', 'X-CSRF-Token': 't' }),
            async generateRaw() {
                await new Promise((r) => setTimeout(r, 2));
                return JSON.stringify({
                    chapters: [{ name: '第一章', notes: '捡到了无法行动的可怜ㄒㄧㄠˇ丧尸' }],
                    characters: [{ name: '江酒', identity: '渣男' }],
                });
            },
            async saveWorldInfo() {}, async updateWorldInfoList() {}, getWorldInfoNames: () => [], stopGeneration() {},
        }),
    };
    const s = settings();
    s.extraction.mode = 'serial';
    const p = project();
    const logs = [];
    const runner = new ExtractionRunner({ getProject: () => p, settings: s, save: async () => {}, onLog: (m) => logs.push(m) });
    const r = await runner.run();
    assert.equal(r.failed, 0);
    assert.equal(p.censorFlags.length, p.chunks.length, '每段的响应都含注音符号，各记一条');
    assert.deepEqual(p.censorFlags.map((f) => f.chunk).sort((a, b) => a - b), p.chunks.map((c) => c.index));
    assert.ok(p.censorFlags.every((f) => f.text.includes('ㄒㄧㄠˇ')));
    assert.ok(logs.some((m) => m.includes('疑似有') && m.includes('敏感词被替换成拼音/注音')), '应在日志中给出警告');
});
