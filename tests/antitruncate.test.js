// 防截断测试：截断识别、自动接续（追问 / 预填）、拒绝与服务商过滤识别
import test from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_ANTI_TRUNCATE, DEFAULT_CATEGORIES, DEFAULT_SETTINGS } from '../src/constants.js';
import { mergeDefaults } from '../src/utils.js';
import { callLLM, chainFor, joinContinuation, jsonUnclosed, looksLikeRefusal, looksTruncated } from '../src/llm.js';
import { createProject } from '../src/project.js';
import { buildChunks, detectChapters } from '../src/splitter.js';
import { extractChunk } from '../src/extract.js';
import { applyConfig } from '../src/io.js';

const AT = { ...DEFAULT_ANTI_TRUNCATE };

function settings() {
    const s = mergeDefaults({}, DEFAULT_SETTINGS);
    s.categories = structuredClone(DEFAULT_CATEGORIES);
    s.api.retries = 0;
    s.api.retryBaseMs = 200;
    return s;
}

/** 模拟酒馆 generateRaw：按顺序返回预设回复，记录每次收到的消息 */
function installTavern(replies) {
    const calls = [];
    globalThis.SillyTavern = {
        getContext: () => ({
            async generateRaw({ prompt }) {
                calls.push(prompt);
                const r = replies[Math.min(calls.length - 1, replies.length - 1)];
                return typeof r === 'function' ? r(prompt) : r;
            },
            stopGeneration() {},
        }),
    };
    return calls;
}

/** 模拟 fetch：按顺序返回 JSON 响应体 */
function installFetch(bodies) {
    const calls = [];
    globalThis.fetch = async (url, init) => {
        calls.push({ url: String(url), body: JSON.parse(init.body) });
        const b = bodies[Math.min(calls.length - 1, bodies.length - 1)];
        return { ok: true, status: 200, text: async () => JSON.stringify(b) };
    };
    return calls;
}

// ---------------- 识别 ----------------

test('截断识别：JSON 未闭合、正文停在半句、思考标签里断开', () => {
    assert.equal(jsonUnclosed('{"a": "b'), true);
    assert.equal(jsonUnclosed('```json\n{"a": [1, 2'), true);
    assert.equal(jsonUnclosed('{"a": "含 } 的字符串"}'), false);
    assert.equal(jsonUnclosed('{"a": 1}\n以上是结果'), false, '闭合后的说明文字不算截断');
    assert.equal(jsonUnclosed('<thinking>先分析 {'), true);
    assert.equal(jsonUnclosed('<thinking>分析 {</thinking>{"a":1}'), false);
    assert.equal(jsonUnclosed('没有 JSON'), false);
    assert.equal(looksTruncated('他推开门，看见', 'prose'), true);
    assert.equal(looksTruncated('他推开门。', 'prose'), false);
    assert.equal(looksTruncated('“走吧。”', 'prose'), false);
    assert.equal(looksTruncated('他推开门，看见', undefined), false, '没有 expect 时不做内容判断');
});

test('拒绝识别：短回复里的拒绝用语；正文里角色说的话不算', () => {
    assert.equal(looksLikeRefusal('抱歉，我无法继续这个请求。', 'prose'), true);
    assert.equal(looksLikeRefusal("I'm sorry, but I can't help with that.", 'json'), true);
    assert.equal(looksLikeRefusal('<think>考虑</think>作为一个AI，我不能生成这类内容。', 'prose'), true);
    assert.equal(looksLikeRefusal('“抱歉，我不能去。”江酒说。'.repeat(40), 'prose'), false);
    assert.equal(looksLikeRefusal('{"reason": "抱歉，我无法"}', 'json'), false);
});

test('拼接接续：去掉重复的衔接部分；JSON 整段重来时用新的', () => {
    assert.equal(joinContinuation('他走进酒吧，莉莉丝', '莉莉丝抬起头。', 'prose'), '他走进酒吧，莉莉丝莉莉丝抬起头。', '不足四字的重叠可能是巧合，不去除');
    assert.equal(joinContinuation('他走进酒吧，看见莉莉丝', '看见莉莉丝抬起头。', 'prose'), '他走进酒吧，看见莉莉丝抬起头。');
    assert.equal(joinContinuation('{"a": "前半', '段"}', 'json'), '{"a": "前半段"}');
    assert.equal(joinContinuation('{"a": "前半', '```json\n{"a": "完整"}\n```', 'json'), '{"a": "完整"}');
});

// ---------------- 自动接续 ----------------

test('酒馆模式：正文停在半句 → 追问接续并拼接；回复 [END] 时停止', async () => {
    const calls = installTavern(['第5章\n\n江酒推开门，', '推开门，莉莉丝在等他。', '[END]']);
    const notices = [];
    const res = await callLLM({ api: { mode: 'tavern', retries: 0 }, system: 'S', prompt: '续写', antiTruncate: AT, expect: 'prose', onNotice: (m) => notices.push(m) });
    assert.equal(res.text, '第5章\n\n江酒推开门，莉莉丝在等他。');
    assert.equal(res.continues, 1);
    assert.equal(calls.length, 2);
    const second = calls[1];
    assert.equal(second.at(-2).role, 'assistant');
    assert.equal(second.at(-2).content, '第5章\n\n江酒推开门，');
    assert.match(second.at(-1).content, /“第5章 江酒推开门，”处中断/);
    assert.ok(notices[0].includes('疑似在中途断开'));

    // 模型认为已经写完
    const c2 = installTavern(['他走了', '[END]']);
    const r2 = await callLLM({ api: { mode: 'tavern', retries: 0 }, prompt: 'x', antiTruncate: AT, expect: 'prose' });
    assert.equal(r2.text, '他走了');
    assert.equal(c2.length, 2);
});

test('接续次数上限；关闭后不接续；没有 expect 时只看结束原因', async () => {
    let calls = installTavern(['他走', '了一步', '又一步', '再一步']);
    const notices = [];
    const r = await callLLM({ api: { mode: 'tavern', retries: 0 }, prompt: 'x', antiTruncate: { ...AT, maxContinues: 2 }, expect: 'prose', onNotice: (m) => notices.push(m) });
    assert.equal(r.text, '他走了一步又一步');
    assert.equal(calls.length, 3);
    assert.ok(notices.at(-1).includes('已接续 2 次仍未写完'));
    calls = installTavern(['他走', '了']);
    await callLLM({ api: { mode: 'tavern', retries: 0 }, prompt: 'x', antiTruncate: { ...AT, enabled: false }, expect: 'prose' });
    assert.equal(calls.length, 1);
    calls = installTavern(['他走', '了']);
    await callLLM({ api: { mode: 'tavern', retries: 0 }, prompt: 'x', antiTruncate: AT });
    assert.equal(calls.length, 1);
});

test('OpenAI 兼容：finish_reason=length → 追问接续', async () => {
    const calls = installFetch([
        { choices: [{ message: { content: '{"name": "莉莉丝", "first_mes": "她把杯子' }, finish_reason: 'length' }] },
        { choices: [{ message: { content: '倒扣在吧台上。"}' }, finish_reason: 'stop' }] },
    ]);
    const res = await callLLM({ api: { mode: 'openai', apiKey: 'k', model: 'm', retries: 0 }, system: 'S', prompt: 'P', antiTruncate: AT, expect: 'json' });
    assert.equal(res.text, '{"name": "莉莉丝", "first_mes": "她把杯子倒扣在吧台上。"}');
    assert.deepEqual(JSON.parse(res.text).first_mes, '她把杯子倒扣在吧台上。');
    assert.deepEqual(calls[1].body.messages.map((m) => m.role), ['system', 'user', 'assistant', 'user']);
});

test('Anthropic：max_tokens → 预填接续（已写内容作为最后一条 AI 消息，去掉末尾空白）', async () => {
    const calls = installFetch([
        { content: [{ type: 'text', text: '江酒推开门，\n' }], stop_reason: 'max_tokens' },
        { content: [{ type: 'text', text: '莉莉丝在等他。' }], stop_reason: 'end_turn' },
    ]);
    const res = await callLLM({ api: { mode: 'anthropic', apiKey: 'k', retries: 0 }, system: 'S', prompt: 'P', antiTruncate: AT, expect: 'prose' });
    assert.equal(res.text, '江酒推开门，莉莉丝在等他。');
    const msgs = calls[1].body.messages;
    assert.equal(msgs.at(-1).role, 'assistant');
    assert.equal(msgs.at(-1).content, '江酒推开门，');
});

test('消息链末尾有 AI 预填时：接续用完整的已写内容替换预填', async () => {
    const calls = installTavern(['"a": "前', '半"}']);
    const chain = [{ role: 'system', content: '{SYSTEM}' }, { role: 'user', content: '{PROMPT}' }, { role: 'assistant', content: '{' }];
    const res = await callLLM({ api: { mode: 'tavern', retries: 0 }, system: 'S', prompt: 'P', chain, antiTruncate: AT, expect: 'json' });
    assert.equal(res.text, '{"a": "前半"}');
    const assistants = calls[1].filter((m) => m.role === 'assistant');
    assert.equal(assistants.length, 1);
    assert.equal(assistants[0].content, '{"a": "前');
});

// ---------------- 拒绝与过滤 ----------------

test('模型拒绝：明确报错且不重试', async () => {
    const calls = installTavern(['抱歉，我无法继续这个请求。']);
    await assert.rejects(
        () => callLLM({ api: { mode: 'tavern', retries: 2, retryBaseMs: 10 }, prompt: 'x', antiTruncate: AT, expect: 'prose' }),
        (e) => e.kind === 'refusal' && /不是截断/.test(e.message),
    );
    assert.equal(calls.length, 1);
    // 关闭识别时照常返回
    installTavern(['抱歉，我无法继续这个请求。']);
    const r = await callLLM({ api: { mode: 'tavern', retries: 0 }, prompt: 'x', antiTruncate: { ...AT, detectRefusal: false }, expect: 'prose' });
    assert.match(r.text, /抱歉/);
});

test('Gemini：安全阈值参数；SAFETY 拦截明确报错且不重试', async () => {
    let calls = installFetch([{ candidates: [{ content: { parts: [{ text: '好。' }] }, finishReason: 'STOP' }] }]);
    await callLLM({ api: { mode: 'gemini', apiKey: 'k', retries: 0, geminiSafety: 'OFF' }, prompt: 'x' });
    assert.ok(calls[0].body.safetySettings.every((x) => x.threshold === 'OFF'));
    calls = installFetch([{ candidates: [{ content: { parts: [{ text: '好。' }] }, finishReason: 'STOP' }] }]);
    await callLLM({ api: { mode: 'gemini', apiKey: 'k', retries: 0, geminiSafety: '' }, prompt: 'x' });
    assert.equal(calls[0].body.safetySettings, undefined, '留空时使用服务商默认');

    calls = installFetch([{ candidates: [{ finishReason: 'SAFETY' }] }]);
    await assert.rejects(() => callLLM({ api: { mode: 'gemini', apiKey: 'k', retries: 2, retryBaseMs: 10 }, prompt: 'x' }), (e) => e.kind === 'filtered' && /SAFETY/.test(e.message));
    assert.equal(calls.length, 1);
    calls = installFetch([{ promptFeedback: { blockReason: 'PROHIBITED_CONTENT' } }]);
    await assert.rejects(() => callLLM({ api: { mode: 'gemini', apiKey: 'k', retries: 0 }, prompt: 'x' }), /拦截了提示词/);
});

test('OpenAI：content_filter 空回复报错；有部分内容时提示且不接续', async () => {
    installFetch([{ choices: [{ message: { content: '' }, finish_reason: 'content_filter' }] }]);
    await assert.rejects(() => callLLM({ api: { mode: 'openai', retries: 0 }, prompt: 'x' }), (e) => e.kind === 'filtered');
    const calls = installFetch([{ choices: [{ message: { content: '他推开门，' }, finish_reason: 'content_filter' }] }]);
    const notices = [];
    const r = await callLLM({ api: { mode: 'openai', retries: 0 }, prompt: 'x', antiTruncate: AT, expect: 'prose', onNotice: (m) => notices.push(m) });
    assert.equal(r.text, '他推开门，');
    assert.equal(calls.length, 1);
    assert.ok(notices[0].includes('内容过滤'));
});

// ---------------- 接入 ----------------

test('提取：JSON 被截断时自动接续后解析成功（不再走“重新输出”）', async () => {
    const s = settings();
    const text = '第一章 酒吧\n江酒走进酒吧。莉莉丝坐在角落。';
    const chunks = buildChunks(detectChapters(text, '^第.+章.*$'), 1000, false);
    const p = createProject({ name: '魔女', text, chunks });
    const full = JSON.stringify({ chapters: [{ name: '第一章 酒吧', notes: '江酒走进酒吧' }], characters: [{ name: '江酒', identity: '酒保', importance: 'main' }, { name: '莉莉丝', identity: '魔女', importance: 'main' }], entries: {} });
    const cut = Math.floor(full.length / 2);
    const calls = installTavern([`\`\`\`json\n${full.slice(0, cut)}`, full.slice(cut)]);
    const logs = [];
    const { result } = await extractChunk(p, s, p.chunks[0], { known: { text: '' }, onLog: (m) => logs.push(m) });
    assert.deepEqual(result.characters.map((c) => c.name), ['江酒', '莉莉丝']);
    assert.equal(calls.length, 2);
    assert.ok(logs.some((l) => l.includes('第 1 段：✂️')));
    assert.ok(!logs.some((l) => l.includes('不是合法 JSON')));
});

test('设置：chainFor 带上防截断配置；配置导入导出', () => {
    const s = settings();
    assert.equal(chainFor(s, 'extract', { bookName: 'x' }).antiTruncate, s.antiTruncate);
    assert.equal(s.antiTruncate.enabled, true);
    assert.equal(s.api.geminiSafety, 'BLOCK_NONE');
    applyConfig(s, { antiTruncate: { maxContinues: 5 } });
    assert.equal(s.antiTruncate.maxContinues, 5);
    assert.equal(s.antiTruncate.enabled, true);
});
