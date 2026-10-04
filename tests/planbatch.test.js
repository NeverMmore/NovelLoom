// v0.8.3：写大纲分批生成（单次请求短，不容易被 API 中途断开）+ 酒馆后端笼统报错（“未知错误”）的说明
import test from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_CATEGORIES, DEFAULT_SETTINGS } from '../src/constants.js';
import { mergeDefaults } from '../src/utils.js';
import { createProject, normalizeCharacter, normalizeProject } from '../src/project.js';
import { buildPlanPreview, buildPlanPrompt, generatePlan, planBatchSize, sortedPlan } from '../src/planner.js';
import { callLLM, errorText, LLMError, tavernError } from '../src/llm.js';

function settings() {
    const s = mergeDefaults({}, DEFAULT_SETTINGS);
    s.categories = structuredClone(DEFAULT_CATEGORIES);
    s.api.retryBaseMs = 1;
    s.api.retries = 0;
    return s;
}

function project() {
    const p = createProject({ name: '测试' });
    p.chunks = [0, 1, 2].map((i) => ({ id: `c${i}`, index: i, title: `第${i + 1}章`, chapterTitles: [`第${i + 1}章`], content: '', origin: 'source' }));
    p.characters['江酒'] = normalizeCharacter({ name: '江酒', importance: 'main', firstChunk: 0, lastChunk: 2, chunksSeen: [0, 1, 2] });
    return normalizeProject(p);
}

/** 模拟酒馆：按提示词里的“规划接下来的 N 章（第 S 章到…）”返回 N 章；fail(i) 为真时第 i 次调用抛错 */
function installST({ fail = () => null, extra = 0 } = {}) {
    const prompts = [];
    globalThis.SillyTavern = {
        getContext: () => ({
            async generateRaw({ prompt }) {
                const text = Array.isArray(prompt) ? prompt.map((m) => m.content).join('\n') : prompt;
                prompts.push(text);
                const err = fail(prompts.length);
                if (err) throw err;
                const n = Number(text.match(/规划接下来的 (\d+) 章/)[1]);
                const start = Number(text.match(/（第 (\d+) 章到第/)[1]);
                return JSON.stringify({
                    overview: `走向${start}`,
                    chapters: Array.from({ length: n + extra }, (_, i) => ({ title: `章${start + i}`, summary: `概要${start + i}` })),
                });
            },
            stopGeneration() {},
        }),
    };
    return prompts;
}

test('planBatchSize：默认每批 5 章；0/非法值 = 不分批', () => {
    const s = settings();
    assert.equal(planBatchSize(s), 5);
    s.planner.batchSize = 0;
    assert.equal(planBatchSize(s), 0);
    s.planner.batchSize = 'abc';
    assert.equal(planBatchSize(s), 0);
    s.planner.batchSize = 999;
    assert.equal(planBatchSize(s), 60);
});

test('generatePlan 分批：每批单独请求，章号连续，只记一条规划记录，后一批带上前一批的规划', async () => {
    const p = project();
    const s = settings();
    s.planner.batchSize = 2;
    const prompts = installST();
    const { arc, chapters } = await generatePlan(p, s, { count: 5 });
    assert.equal(prompts.length, 3);
    assert.match(prompts[0], /第 4 章到第 5 章/);
    assert.match(prompts[1], /第 6 章到第 7 章/);
    assert.match(prompts[2], /规划接下来的 1 章大纲（第 8 章到第 8 章）/);
    assert.match(prompts[0], /分批规划】本次总共规划第 4–8 章（共 5 章），分 3 批生成，这是第 1\/3 批/);
    assert.match(prompts[1], /概要5/, '第 2 批的“已有的后续规划”应包含第 1 批的结果');
    assert.deepEqual(chapters.map((c) => c.no), [4, 5, 6, 7, 8]);
    assert.deepEqual(sortedPlan(p).map((c) => c.title), ['章4', '章5', '章6', '章7', '章8']);
    assert.equal(p.plan.arcs.length, 1);
    assert.equal(arc.fromNo, 4);
    assert.equal(arc.toNo, 8);
    assert.ok(chapters.every((c) => c.arcId === arc.id));
    assert.equal(arc.overview, '第4–5章：走向4\n第6–7章：走向6\n第8–8章：走向8');
    assert.match(prompts[2], /走向：第4–5章：走向4；第6–7章：走向6/, '多行走向在提示词里压成一行');
    // 前几批：留给后续批次；最后一批：把没落实的高潮/结局/伏笔都完成，不能再叫它“留给后续批次”
    assert.match(prompts[0], /其余留给后续批次/);
    assert.match(prompts[1], /其余留给后续批次/);
    assert.match(prompts[2], /这是最后一批：要求里还没落实的部分（包括高潮、结局、要回收的伏笔）都要在这一批完成/);
    assert.doesNotMatch(prompts[2], /留给后续批次|不要把整体的高潮或结局提前/);
});

test('buildPlanPreview：分批时预览的就是第一批实际发送的提示词；不分批时与原来一致', async () => {
    const s = settings();
    s.planner.batchSize = 2;
    s.planner.count = 5;
    const preview = buildPlanPreview(project(), s);
    assert.equal(preview.total, 3);
    const prompts = installST();
    await generatePlan(project(), s);
    assert.ok(prompts[0].includes(preview.prompt), '预览内容应与第一批实际发送的提示词相同');
    assert.ok(prompts[0].includes(preview.system));

    s.planner.batchSize = 0;
    const p = project();
    const single = buildPlanPreview(p, s);
    assert.equal(single.total, 1);
    assert.equal(single.prompt, buildPlanPrompt(p, s).prompt);
});

test('generatePlan 分批：AI 多写的章数丢弃，不和下一批章号重叠', async () => {
    const p = project();
    const s = settings();
    s.planner.batchSize = 2;
    installST({ extra: 1 });
    const { chapters } = await generatePlan(p, s, { count: 4 });
    assert.deepEqual(chapters.map((c) => c.no), [4, 5, 6, 7]);
    assert.deepEqual(chapters.map((c) => c.title), ['章4', '章5', '章6', '章7']);
});

test('generatePlan 不分批（batchSize = 0）或章数不超过每批章数：只请求一次，提示词不带分批说明', async () => {
    const p = project();
    const s = settings();
    s.planner.batchSize = 0;
    let prompts = installST();
    await generatePlan(p, s, { count: 6 });
    assert.equal(prompts.length, 1);
    assert.doesNotMatch(prompts[0], /分批规划/);
    assert.equal(p.plan.arcs[0].overview, '走向4');

    s.planner.batchSize = 5;
    prompts = installST();
    await generatePlan(project(), s, { count: 5 });
    assert.equal(prompts.length, 1);
    assert.doesNotMatch(prompts[0], /分批规划/);
});

test('generatePlan 分批中途失败：已完成的批次保留，错误带 partial 并说明从哪章接着规划', async () => {
    const p = project();
    const s = settings();
    s.planner.batchSize = 2;
    installST({ fail: (i) => (i === 2 ? new Error('未知错误') : null) });
    const err = await generatePlan(p, s, { count: 5 }).catch((e) => e);
    assert.ok(err instanceof Error);
    assert.ok(err.partial, '应带上已完成的部分');
    assert.deepEqual(err.partial.chapters.map((c) => c.no), [4, 5]);
    assert.match(err.message, /已完成并保存第 4–5 章/);
    assert.match(err.message, /第 2\/3 批（第 6–7 章）失败/);
    assert.match(err.message, /从第 6 章接着往后规划/);
    assert.match(err.message, /剩下的 3 章/);
    assert.deepEqual(sortedPlan(p).map((c) => c.no), [4, 5]);
    assert.equal(p.plan.arcs.length, 1);
    assert.equal(p.plan.arcs[0].toNo, 5);
    // 接着点“生成”：从第 6 章往后规划
    installST();
    const { startNo } = buildPlanPrompt(p, s, { count: 3 });
    assert.equal(startNo, 6);
});

test('generatePlan 从某章起重新规划：第一批失败时旧规划原样保留；成功后才覆盖', async () => {
    const p = project();
    const s = settings();
    s.planner.batchSize = 2;
    installST();
    await generatePlan(p, s, { count: 4 });
    const before = sortedPlan(p).map((c) => `${c.no}:${c.title}`);
    installST({ fail: () => new Error('未知错误') });
    const err = await generatePlan(p, s, { count: 4, fromNo: 5 }).catch((e) => e);
    assert.ok(err instanceof Error);
    assert.equal(err.partial, undefined);
    assert.deepEqual(sortedPlan(p).map((c) => `${c.no}:${c.title}`), before, '第一批就失败时不能删掉旧规划');

    let n = 0;
    installST({ fail: () => (++n === 2 ? new Error('断开') : null) });
    const err2 = await generatePlan(p, s, { count: 4, fromNo: 5 }).catch((e) => e);
    assert.ok(err2.partial);
    // 第 5、6 章是新规划；旧的第 7 章已按“从第 5 章起重新规划”的语义移除
    assert.deepEqual(sortedPlan(p).map((c) => c.no), [4, 5, 6]);
});

test('errorText：酒馆直接 throw 的响应 JSON 也能取出原因', () => {
    assert.equal(errorText({ error: { message: 'max_tokens too large', code: 400 } }), '[400] max_tokens too large');
    assert.equal(errorText({ error: true }), '{"error":true}');
    assert.equal(errorText(new Error('boom')), 'boom');
    assert.equal(errorText('纯文本'), '纯文本');
    assert.match(errorText(undefined), /未知错误/);
});

test('tavernError：酒馆后端只回 {error: true}（前端显示“未知错误”）时补上原因说明并可重试', () => {
    // 酒馆当前连接（generateRaw）：中文界面显示“未知错误”
    // 连接配置档：酒馆 1.19 把 'Response not OK' 包成 new Error('API request failed', { cause })
    const bare = [
        new Error('未知错误'),
        new Error('Unknown error'),
        { error: true },
        new Error('Response not OK'),
        new Error('API request failed', { cause: new Error('Response not OK') }),
        new Error('API request failed', { cause: new Error('未知错误') }),
    ];
    for (const raw of bare) {
        const e = tavernError('酒馆生成失败', raw);
        assert.ok(e instanceof LLMError);
        assert.equal(e.retryable, true, `应可重试：${errorText(raw)}`);
        assert.match(e.message, /命令行窗口/);
        assert.match(e.message, /每批章数/);
    }
    assert.match(tavernError('连接配置档请求失败', bare[4]).message, /接口地址、密钥或模型/);
    // 额度不足等：酒馆 throw new Error(对象) → “[object Object]”，不是断线，不重试
    const quota = tavernError('酒馆生成失败', new Error({ error: { message: 'Too Many Requests' }, quota_error: true }));
    assert.equal(quota.retryable, false);
    assert.match(quota.message, /额度/);
    assert.doesNotMatch(quota.message, /Premature close/);
    // 有具体原因的错误原样带出
    const other = tavernError('连接配置档请求失败', { error: { message: 'Invalid API key' } });
    assert.equal(other.message, '连接配置档请求失败：Invalid API key');
    assert.equal(other.retryable, false);
    const wrapped = tavernError('连接配置档请求失败', new Error('API request failed', { cause: new Error('Invalid API key') }));
    assert.match(wrapped.message, /Invalid API key/);
});

test('callLLM 酒馆模式：遇到“未知错误”会自动重试', async () => {
    const s = settings();
    s.api.retries = 1;
    let n = 0;
    globalThis.SillyTavern = {
        getContext: () => ({
            async generateRaw() {
                n++;
                if (n === 1) throw new Error('未知错误');
                return '好';
            },
            stopGeneration() {},
        }),
    };
    const res = await callLLM({ api: s.api, prompt: '你好' });
    assert.equal(res.text, '好');
    assert.equal(res.attempts, 2);
});
