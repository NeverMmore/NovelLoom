// 新功能测试：自定义消息链、分卷模式（含条目版本）、写大纲与按大纲续写
import test from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_CATEGORIES, DEFAULT_SETTINGS } from '../src/constants.js';
import { mergeDefaults } from '../src/utils.js';
import { buildChainMessages, callLLM, chainFor, DEEPSEEK_DEFAULT_ENDPOINT, getChain, isTokenLimitError, listModels, splitSystem } from '../src/llm.js';
import { buildChunks, detectChapters, splitNovel } from '../src/splitter.js';
import {
    addVolumeAt, applyExtraction, buildKnownContext, buildOutlineText, createProject, deleteChunkAt, detectVolumesFromChunks, entryAt,
    getVolumes, mergeCharacter, mergeChunkWithNext, mergeEntry, normalizeExtraction, removeVolume, setEntryContent, volumeOf,
} from '../src/project.js';
import { buildWorldbookEntries } from '../src/worldbook.js';
import { ExtractionRunner } from '../src/extract.js';
import { ContinuationRunner } from '../src/continue.js';
import {
    buildPlanPrompt, deletePlanChapter, generatePlan, insertPlanChapterAfter, nextChapterNo, planForChapter, reviseChapterPlan, sortedPlan, unmarkPlanWritten,
} from '../src/planner.js';
import { defaultWorldName } from '../src/publish.js';

function settings() {
    const s = mergeDefaults({}, DEFAULT_SETTINGS);
    s.categories = structuredClone(DEFAULT_CATEGORIES);
    s.api.retryBaseMs = 500;
    s.api.retries = 1;
    s.extraction.autoSnapshotEvery = 0;
    return s;
}

// ---------------- 模拟酒馆 ----------------

const calls = [];
let overflowOnce = null; // 某个段标题：第一次提取时抛出上下文超限

function respond(text) {
    if (text.includes('<source>')) {
        const src = text.split('<source>')[1].split('</source>')[0];
        const title = (text.match(/第 \d+ 段「([^」]+)」/) || [])[1] || '';
        if (overflowOnce && title.includes(overflowOnce) && text.includes('已知角色')) {
            overflowOnce = null;
            throw new Error("This model's maximum context length is 8192 tokens. context_length_exceeded");
        }
        const characters = [];
        for (const n of ['江酒', '莉莉丝', '姜小白', '白夜']) if (src.includes(n)) characters.push({ name: n, identity: `${n}的身份@${title}`, importance: n === '江酒' ? 'main' : 'support', experiences: [`${title}里${n}的经历`] });
        const entries = { 地点: [] };
        if (src.includes('酒吧')) entries.地点.push({ name: '酒吧', content: `酒吧@${title}` });
        if (src.includes('学院')) entries.地点.push({ name: '魔女学院', content: `学院@${title}` });
        return JSON.stringify({ chapters: [{ name: title, notes: `${title}的概要` }], characters, entries });
    }
    if (text.includes('本卷梗概')) {
        const vol = (text.match(/「([^」]+)」的章节概要/) || [])[1];
        return `${vol}：卷梗概内容`;
    }
    if (text.includes('规划接下来的')) {
        const n = Number((text.match(/规划接下来的 (\d+) 章/) || [])[1] || 3);
        const start = Number((text.match(/（第 (\d+) 章到第/) || [])[1]);
        return JSON.stringify({ overview: '主角离开下城区', chapters: Array.from({ length: n }, (_, i) => ({ title: `第${start + i}章 规划${i + 1}`, summary: `规划概要${i + 1}`, characters: ['江酒'], events: [`事件${i + 1}`], foreshadowing: [], hook: `钩子${i + 1}` })) });
    }
    if (text.includes('的大纲。') && text.includes('修改要求')) return JSON.stringify({ title: '改过的章', summary: '按要求重写', characters: ['莉莉丝'], events: ['新事件'], foreshadowing: ['伏笔'], hook: '新钩子' });
    if (text.includes('续写任务')) {
        const t = (text.match(/请续写《[^》]+》的下一章：([^，]+)，/) || [])[1];
        return `${t}\n\n${'江酒走在学院的长廊里。'.repeat(40)}`;
    }
    return '好';
}

function installST() {
    const ctx = {
        async generateRaw({ prompt }) {
            const list = Array.isArray(prompt) ? prompt : [{ role: 'user', content: prompt }];
            calls.push(list);
            return respond(list.map((m) => m.content).join('\n'));
        },
        stopGeneration() {},
    };
    globalThis.SillyTavern = { getContext: () => ctx };
    return ctx;
}

// ---------------- 消息链 ----------------

test('消息链：默认链、占位符、禁用、自动补 {PROMPT}', () => {
    assert.deepEqual(buildChainMessages(null, { SYSTEM: 'S', PROMPT: 'P' }), [{ role: 'system', content: 'S' }, { role: 'user', content: 'P' }]);
    const chain = [
        { role: 'system', content: '你在写《{BOOK}》', enabled: true },
        { role: 'system', content: '被禁用', enabled: false },
        { role: 'user', content: '{PROMPT}' },
        { role: 'assistant', content: '{', enabled: true },
    ];
    const out = buildChainMessages(chain, { SYSTEM: '', PROMPT: '任务', BOOK: '魔女' });
    assert.deepEqual(out.map((m) => m.role), ['system', 'user', 'assistant']);
    assert.equal(out[0].content, '你在写《魔女》');
    const noPrompt = buildChainMessages([{ role: 'system', content: '{SYSTEM}' }], { SYSTEM: 'S', PROMPT: 'P' });
    assert.deepEqual(noPrompt[noPrompt.length - 1], { role: 'user', content: 'P' });
    // 空的 {SYSTEM} 会被丢弃
    assert.equal(buildChainMessages(null, { SYSTEM: '', PROMPT: 'P' }).length, 1);
});

test('消息链：按任务取链，未自定义时沿用默认链', () => {
    const s = settings();
    assert.equal(getChain(s, 'extract'), s.messageChains.default);
    s.messageChains.extract = [{ role: 'user', content: '只提取：{PROMPT}' }];
    assert.equal(getChain(s, 'extract')[0].content, '只提取：{PROMPT}');
    s.messageChains.extract = [{ role: 'user', content: 'x', enabled: false }];
    assert.equal(getChain(s, 'extract'), s.messageChains.default, '全部禁用时回退默认链');
    const c = chainFor(s, 'card', { bookName: '魔女' });
    assert.equal(c.vars.BOOK, '魔女');
});

test('splitSystem：开头系统消息单独传，中间系统消息转为用户消息，合并同角色', () => {
    const r = splitSystem([
        { role: 'system', content: 'A' }, { role: 'system', content: 'B' },
        { role: 'assistant', content: '示例回答' }, { role: 'system', content: '补充规则' }, { role: 'user', content: '问题' },
    ]);
    assert.equal(r.system, 'A\n\nB');
    assert.equal(r.messages[0].role, 'user', '首条必须是用户');
    assert.equal(r.messages[1].role, 'assistant');
    assert.equal(r.messages[2].role, 'user');
    assert.ok(r.messages[2].content.includes('[系统指令]') && r.messages[2].content.includes('问题'));
});

test('消息链：角色按顺序传给酒馆，预填拼回回复开头', async () => {
    const ctx = installST();
    const seen = [];
    ctx.generateRaw = async ({ prompt }) => {
        seen.push(prompt);
        return '"a": 1}';
    };
    const chain = [{ role: 'system', content: '{SYSTEM}' }, { role: 'user', content: '{PROMPT}' }, { role: 'assistant', content: '{' }];
    const r = await callLLM({ api: { mode: 'tavern', retries: 0 }, system: '系统', prompt: '给我 JSON', chain });
    assert.deepEqual(seen[0].map((m) => m.role), ['system', 'user', 'assistant']);
    assert.equal(r.text, '{"a": 1}');
    const r2 = await callLLM({ api: { mode: 'tavern', retries: 0 }, prompt: 'x', chain, prependPrefill: false });
    assert.equal(r2.text, '"a": 1}');
});

test('消息链：Anthropic 与 OpenAI 直连的角色转换', async () => {
    const orig = globalThis.fetch;
    const bodies = [];
    globalThis.fetch = async (url, init) => {
        const body = JSON.parse(init.body);
        bodies.push({ url, body });
        const text = url.includes('anthropic') ? JSON.stringify({ content: [{ type: 'text', text: 'ok' }] }) : JSON.stringify({ choices: [{ message: { content: 'ok' } }] });
        return new Response(text, { status: 200 });
    };
    try {
        const chain = [{ role: 'system', content: '{SYSTEM}' }, { role: 'assistant', content: '示例' }, { role: 'user', content: '{PROMPT}' }];
        await callLLM({ api: { mode: 'anthropic', endpoint: 'https://api.anthropic.com', apiKey: 'k', model: 'm', retries: 0 }, system: 'S', prompt: 'P', chain });
        assert.equal(bodies[0].body.system, 'S');
        assert.deepEqual(bodies[0].body.messages.map((m) => m.role), ['user', 'assistant', 'user']);
        await callLLM({ api: { mode: 'openai', endpoint: 'http://x/v1', model: 'm', retries: 0 }, system: 'S', prompt: 'P', chain });
        assert.deepEqual(bodies[1].body.messages.map((m) => m.role), ['system', 'assistant', 'user']);
    } finally {
        globalThis.fetch = orig;
    }
});

test('DeepSeek 专属接口类型：复用 OpenAI 兼容请求，接口地址留空时用官方默认值', async () => {
    const orig = globalThis.fetch;
    const bodies = [];
    globalThis.fetch = async (url, init) => {
        bodies.push({ url, body: JSON.parse(init.body) });
        return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { status: 200 });
    };
    try {
        await callLLM({ api: { mode: 'deepseek', apiKey: 'k', model: 'deepseek-chat', retries: 0 }, prompt: 'P' });
        assert.equal(bodies[0].url, `${DEEPSEEK_DEFAULT_ENDPOINT}/chat/completions`, '留空接口地址应该自动用 DeepSeek 官方地址，而不是 OpenAI 的');
        assert.equal(bodies[0].body.model, 'deepseek-chat');

        await callLLM({ api: { mode: 'deepseek', endpoint: 'https://my-proxy.example.com/v1', apiKey: 'k', model: 'm', retries: 0 }, prompt: 'P' });
        assert.equal(bodies[1].url, 'https://my-proxy.example.com/v1/chat/completions', '填了自定义地址（例如中转）应该照用');
    } finally {
        globalThis.fetch = orig;
    }
});

test('DeepSeek deepseek-reasoner：reasoning_content 与正文分开返回，不混进 text，会触发一条 onNotice', async () => {
    const orig = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify({
        choices: [{ message: { content: '这是正文', reasoning_content: '这是思考过程，很长的推理……' }, finish_reason: 'stop' }],
    }), { status: 200 });
    try {
        const notices = [];
        const res = await callLLM({ api: { mode: 'deepseek', apiKey: 'k', model: 'deepseek-reasoner', retries: 0 }, prompt: 'P', onNotice: (m, l) => notices.push([m, l]) });
        assert.equal(res.text, '这是正文', '思考过程不应该混进正文');
        assert.equal(res.reasoning, '这是思考过程，很长的推理……');
        assert.ok(notices.some(([m, l]) => l === 'info' && /思考过程/.test(m)), '应该提示收到了思考过程');
    } finally {
        globalThis.fetch = orig;
    }
});

test('listModels：DeepSeek 模式拉取模型列表时也使用官方默认地址', async () => {
    const orig = globalThis.fetch;
    const urls = [];
    globalThis.fetch = async (url) => {
        urls.push(url);
        return new Response(JSON.stringify({ data: [{ id: 'deepseek-chat' }, { id: 'deepseek-reasoner' }] }), { status: 200 });
    };
    try {
        const list = await listModels({ mode: 'deepseek', apiKey: 'k' });
        assert.equal(urls[0], `${DEEPSEEK_DEFAULT_ENDPOINT}/models`);
        assert.deepEqual(list.map((m) => m.id), ['deepseek-chat', 'deepseek-reasoner']);
    } finally {
        globalThis.fetch = orig;
    }
});

test('上下文超限错误识别，且不做普通重试', async () => {
    assert.ok(isTokenLimitError('This model\'s maximum context length is 8192 tokens'));
    assert.ok(isTokenLimitError('prompt is too long: 210000 tokens > 200000 maximum'));
    assert.ok(isTokenLimitError('context_length_exceeded'));
    assert.ok(!isTokenLimitError('429 rate limit'));
    const ctx = installST();
    let n = 0;
    ctx.generateRaw = async () => {
        n++;
        throw new Error('context_length_exceeded 503');
    };
    await assert.rejects(callLLM({ api: { mode: 'tavern', retries: 3, retryBaseMs: 500 }, prompt: 'x' }));
    assert.equal(n, 1);
});

// ---------------- 分卷 ----------------

const VOL_NOVEL = [
    '第一卷 下城区', '第一章 酒吧', '江酒在酒吧里擦杯子。莉莉丝坐在角落。'.repeat(20),
    '第二章 雨夜', '姜小白走进酒吧。江酒给她倒水。'.repeat(20),
    '第二卷 学院', '第三章 入学', '江酒来到魔女学院，遇见白夜。'.repeat(20),
    '第四章 考试', '白夜在学院里考试，江酒旁观。'.repeat(20),
].join('\n');

function volProject() {
    const chapters = detectChapters(VOL_NOVEL, '^第.+章.*$');
    const chunks = chapters.map((ch) => buildChunks([ch], 1000, false)[0]);
    chunks.forEach((c, i) => (c.index = i));
    const p = createProject({ name: '魔女', text: VOL_NOVEL, chunks });
    detectVolumesFromChunks(p);
    return p;
}

test('按“第X卷”标题识别分卷，分段不跨卷', () => {
    const p = volProject();
    const vols = getVolumes(p);
    assert.equal(vols.length, 2);
    assert.equal(vols[0].name, '第一卷 下城区');
    assert.equal(vols[1].name, '第二卷 学院');
    assert.deepEqual([vols[0].startChunk, vols[0].endChunk, vols[1].startChunk, vols[1].endChunk], [0, 1, 2, 3]);
    assert.equal(volumeOf(p, 3).name, '第二卷 学院');
    // 即使 chunkSize 很大，两卷也不会合进同一段
    const { chunks } = splitNovel(VOL_NOVEL, { pattern: '^第.+章.*$', chunkSize: 100000, mergeSmall: true });
    assert.equal(chunks.length, 2);
    assert.deepEqual(chunks.map((c) => c.volumeKey), ['1', '2']);
});

test('手动分卷、取消分卷、删除/合并分段后卷边界保持一致', () => {
    const p = volProject();
    p.volumes = [];
    assert.equal(getVolumes(p)[0].implicit, true);
    const v = addVolumeAt(p, 2);
    assert.equal(getVolumes(p).length, 2);
    assert.equal(v.name, '第2卷');
    addVolumeAt(p, 3, { name: '外传' });
    assert.deepEqual(getVolumes(p).map((x) => x.name), ['第1卷', '第2卷', '外传']);
    removeVolume(p, v.id);
    assert.deepEqual(getVolumes(p).map((x) => [x.name, x.startChunk]), [['第1卷', 0], ['外传', 3]]);
    deleteChunkAt(p, 3); // 删掉“外传”的起始段
    assert.equal(getVolumes(p).length, 1, '越界的卷被移除，只剩一卷时视为未分卷');
    const q = volProject();
    mergeChunkWithNext(q, 1); // 把第一卷最后一段与第二卷第一段合并
    assert.deepEqual(getVolumes(q).map((x) => x.startChunk), [0, 2]);
});

test('条目版本：按时间点回放，追加乱序也一致，手动修改同步最新版本', () => {
    const p = volProject();
    mergeEntry(p, '地点', { name: '酒吧', content: 'A' }, 0);
    mergeEntry(p, '地点', { name: '酒吧', content: 'B' }, 2, { replace: true });
    const e = p.worldbook['地点']['酒吧'];
    assert.equal(entryAt(e, 0), 'A');
    assert.equal(entryAt(e, 1), 'A');
    assert.equal(entryAt(e, 3), 'B');
    assert.equal(e.content, 'B');
    // 乱序追加（并行模式）：第 1 段的信息应进入第 1 段及之后的版本
    mergeEntry(p, '地点', { name: '酒吧', content: 'C' }, 1);
    assert.equal(entryAt(e, 0), 'A');
    assert.equal(entryAt(e, 1), 'A\nC');
    assert.ok(entryAt(e, 2).includes('C'));
    setEntryContent(e, '手动改');
    assert.equal(entryAt(e, 3), '手动改');
    assert.equal(entryAt(e, 0), 'A');
    assert.equal(entryAt({ content: 'x', revisions: [] }, 0), 'x');
});

test('分卷世界书：只含本卷 / 截至卷末，内容取卷末版本', () => {
    const p = volProject();
    const s = settings();
    s.worldbook.includeOutlineEntry = false;
    for (const [i, name, content] of [[0, '酒吧', '酒吧v1'], [2, '魔女学院', '学院v2'], [3, '酒吧', '酒吧v4']]) mergeEntry(p, '地点', { name, content }, i, { replace: true });
    mergeCharacter(p, { name: '姜小白', aliases: [], experiences: ['迷路'], quotes: [], appearance: [], abilities: [], importance: 'support' }, 1);
    mergeCharacter(p, { name: '白夜', aliases: [], experiences: ['考试'], quotes: [], appearance: [], abilities: [], importance: 'support' }, 3);
    const [v1, v2] = getVolumes(p);
    const e1 = buildWorldbookEntries(p, s, { volume: v1, volumeScope: 'volume' });
    assert.deepEqual(e1.map((e) => e.name).sort(), ['姜小白', '酒吧'].sort());
    assert.equal(e1.find((e) => e.name === '酒吧').content, '酒吧v1');
    const e2 = buildWorldbookEntries(p, s, { volume: v2, volumeScope: 'volume' });
    assert.deepEqual(e2.map((e) => e.name).sort(), ['白夜', '魔女学院', '酒吧'].sort());
    assert.equal(e2.find((e) => e.name === '酒吧').content, '酒吧v4');
    const c2 = buildWorldbookEntries(p, s, { volume: v2, volumeScope: 'cumulative' });
    assert.ok(c2.some((e) => e.name === '姜小白'));
    // 角色卡时间点也用条目版本（防剧透）
    const early = buildWorldbookEntries(p, s, { uptoChunk: 1 });
    assert.equal(early.find((e) => e.name === '酒吧').content, '酒吧v1');
    assert.equal(defaultWorldName(p, s, v1.endChunk), '《魔女》世界书（至第一卷 下城区末）');
});

test('分卷上下文：只列本卷名称并附前情提要；长大纲用卷梗概代替', () => {
    const p = volProject();
    mergeCharacter(p, { name: '姜小白', aliases: [], experiences: [], quotes: [], appearance: [], abilities: [], importance: 'support' }, 1);
    mergeCharacter(p, { name: '江酒', aliases: [], experiences: [], quotes: [], appearance: [], abilities: [], importance: 'main' }, 0);
    const k = buildKnownContext(p, '白夜在考试', 5000, { scope: { start: 2, end: 2 }, prelude: '第一卷梗概' });
    assert.ok(k.text.includes('前情提要'));
    assert.ok(!k.text.includes('姜小白'), '上一卷的次要角色不在名单里');
    assert.ok(k.text.includes('江酒'), '主要角色始终在名单里');
    // 大纲压缩
    p.chunks.forEach((c) => (c.outline = [{ name: c.title, notes: '很长的概要'.repeat(30) }]));
    p.volumes[0].summary = '第一卷讲了下城区的故事';
    const text = buildOutlineText(p, 3, 500);
    assert.ok(text.includes('第一卷讲了下城区的故事'));
    assert.ok(text.includes('第四章'));
});

test('分卷模式提取：超限自动分卷重试、卷梗概、前情提要注入', async () => {
    installST();
    calls.length = 0;
    const p = volProject();
    p.volumes = []; // 没有卷标题的情况：靠超限自动分卷
    const s = settings();
    s.extraction.volumeMode = true;
    overflowOnce = '第三章';
    const logs = [];
    const runner = new ExtractionRunner({ getProject: () => p, settings: s, save: async () => {}, onLog: (m) => logs.push(m) });
    const r = await runner.run();
    assert.equal(r.failed, 0, logs.join('\n'));
    const vols = getVolumes(p);
    assert.equal(vols.length, 2, '第三章超限后应自动开第二卷');
    assert.equal(vols[1].startChunk, 2);
    assert.equal(vols[1].auto, 'overflow');
    assert.ok(vols[0].summary, '第一卷应生成卷梗概');
    assert.ok(vols[1].summary, '结束时第二卷也生成卷梗概');
    const retry = calls.filter((c) => c.some((m) => m.content.includes('第 3 段'))).pop();
    const text = retry.map((m) => m.content).join('\n');
    assert.ok(text.includes('前情提要'), '新卷第一段应带前情提要');
    assert.ok(!text.includes('已知角色：姜小白'), '上一卷的次要角色不再列入名单');
    assert.ok(logs.some((l) => l.includes('上下文超限')));
});

test('分卷模式提取：提示词超过阈值时提前分卷', async () => {
    installST();
    const p = volProject();
    p.volumes = [];
    const s = settings();
    s.extraction.volumeMode = true;
    s.extraction.volumeAutoSummary = false;
    s.extraction.volumeTokenLimit = 2150; // 第一段之后，已知资料一多就会超过
    const runner = new ExtractionRunner({ getProject: () => p, settings: s, save: async () => {} });
    await runner.run();
    assert.ok(getVolumes(p).length >= 2);
    assert.ok(getVolumes(p).every((v) => !v.summary));
});

// ---------------- 写大纲 ----------------

async function extracted() {
    installST();
    const p = volProject();
    const s = settings();
    await new ExtractionRunner({ getProject: () => p, settings: s, save: async () => {} }).run();
    return { p, s };
}

test('写大纲：章号衔接、要求与已有规划写入提示词、从某章起重规划', async () => {
    const { p, s } = await extracted();
    assert.equal(nextChapterNo(p), 5);
    s.planner.requirement = '主角要离开下城区';
    const { prompt, startNo } = buildPlanPrompt(p, s, { count: 3 });
    assert.equal(startNo, 5);
    assert.ok(prompt.includes('主角要离开下城区'));
    assert.ok(prompt.includes('第 5 章到第 7 章'));
    const r = await generatePlan(p, s, { count: 3 });
    assert.equal(r.chapters.length, 3);
    assert.deepEqual(sortedPlan(p).map((c) => c.no), [5, 6, 7]);
    assert.equal(sortedPlan(p)[0].title, '规划1', '去掉 AI 多写的“第X章”前缀');
    assert.equal(p.plan.arcs[0].overview, '主角离开下城区');
    // 再规划：接在已有规划之后，且提示词带上已有规划
    const { prompt: p2, startNo: s2 } = buildPlanPrompt(p, s, { count: 2 });
    assert.equal(s2, 8);
    assert.ok(p2.includes('规划概要3'));
    // 从第 6 章起重新规划：覆盖 6、7
    await generatePlan(p, s, { count: 2, fromNo: 6 });
    assert.deepEqual(sortedPlan(p).map((c) => c.no), [5, 6, 7]);
    assert.equal(sortedPlan(p)[1].summary, '规划概要1');
    // 单章重写、插入、删除
    const ch6 = sortedPlan(p)[1];
    await reviseChapterPlan(p, s, ch6.id, '让莉莉丝登场');
    assert.equal(sortedPlan(p)[1].title, '改过的章');
    insertPlanChapterAfter(p, 5);
    assert.deepEqual(sortedPlan(p).map((c) => c.no), [5, 6, 7, 8]);
    deletePlanChapter(p, sortedPlan(p)[1].id);
    assert.deepEqual(sortedPlan(p).map((c) => c.no), [5, 6, 7]);
});

test('按大纲续写：本章大纲与后续大纲进入提示词，写完标记已写，删除后恢复', async () => {
    const { p, s } = await extracted();
    await generatePlan(p, s, { count: 3 });
    calls.length = 0;
    const runner = new ContinuationRunner({ getProject: () => p, settings: s, save: async () => {} });
    const done = await runner.run({ count: 2, words: 500, feedback: false });
    assert.equal(done, 2);
    const first = calls.find((c) => c.some((m) => m.content.includes('续写任务'))).map((m) => m.content).join('\n');
    assert.ok(first.includes('本章大纲（按此写）'));
    assert.ok(first.includes('规划概要1'));
    assert.ok(first.includes('后续章节大纲'));
    assert.ok(first.includes('第5章 规划1'));
    const [c5, c6] = p.continuation.chapters;
    assert.equal(c5.title, '第5章 规划1');
    assert.equal(sortedPlan(p).filter((c) => c.status === 'written').length, 2);
    assert.equal(planForChapter(p, 7).title, '规划3');
    unmarkPlanWritten(p, c6.id);
    assert.equal(planForChapter(p, 6).title, '规划2');
    // 关闭“按大纲”后不注入
    s.continuation.followPlan = false;
    calls.length = 0;
    await new ContinuationRunner({ getProject: () => p, settings: s, save: async () => {} }).run({ count: 1, words: 500, feedback: false });
    const t = calls.flat().map((m) => m.content).join('\n');
    assert.ok(!t.includes('本章大纲（按此写）'));
});

test('提取结果合并：条目时间点与 applyExtraction 协同', () => {
    const p = volProject();
    applyExtraction(p, p.chunks[0], normalizeExtraction({ entries: { 地点: [{ name: '酒吧', content: '一' }] } }));
    applyExtraction(p, p.chunks[3], normalizeExtraction({ entries: { 地点: [{ name: '酒吧', content: '四' }] } }), { fullContext: new Set(['地点:酒吧']) });
    const e = p.worldbook['地点']['酒吧'];
    assert.equal(entryAt(e, 2), '一');
    assert.equal(entryAt(e, 3), '四');
});
