// LLM 调用层：酒馆当前连接 / 酒馆连接配置档 / OpenAI 兼容 / Gemini / Anthropic
// 带超时、重试（指数退避）、中止

import { abortError, isAbortError, sleep } from './utils.js';

export const API_MODES = [
    { value: 'tavern', label: '酒馆当前连接（generateRaw）' },
    { value: 'profile', label: '酒馆连接配置档（Connection Profile，推荐并行）' },
    { value: 'openai', label: '自定义 OpenAI 兼容接口' },
    { value: 'deepseek', label: 'DeepSeek（官方接口）' },
    { value: 'gemini', label: 'Google Gemini' },
    { value: 'anthropic', label: 'Anthropic Claude' },
];

/** DeepSeek 专属接口类型的默认值：官方地址 + 常用模型（deepseek-reasoner 会返回单独的 reasoning_content，见 callOpenAI） */
export const DEEPSEEK_DEFAULT_ENDPOINT = 'https://api.deepseek.com';
export const DEEPSEEK_MODELS = [
    { id: 'deepseek-chat', name: 'deepseek-chat（V3，不带思考过程）' },
    { id: 'deepseek-reasoner', name: 'deepseek-reasoner（R1，带思考过程，会自动分离不进入正文）' },
];

const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504, 520, 522, 524, 529]);
const RETRYABLE_TEXT = /rate.?limit|overloaded|resource_exhausted|temporarily unavailable|timeout|timed out|network|fetch failed|ECONNRESET|socket|503|502|529|empty response|No message generated|过载|限流|超时/i;

export class LLMError extends Error {
    constructor(message, { status = 0, retryable = false, raw = '', kind = '' } = {}) {
        super(message);
        this.name = 'LLMError';
        this.status = status;
        this.retryable = retryable;
        this.raw = raw;
        /** refusal = 模型拒绝；filtered = 服务商内容过滤 */
        this.kind = kind;
    }
}

/**
 * 从任意抛出值里取出可读的错误信息。
 * 酒馆的 ConnectionManagerRequestService / generateRaw 出错时可能直接 throw 响应 JSON（不是 Error），
 * 只读 e.message 会丢掉真正的原因（只剩“未知错误”/undefined）。
 */
export function errorText(e) {
    if (e == null) return '未知错误（没有错误信息）';
    if (typeof e === 'string') return e;
    const pick = (v) => (typeof v === 'string' && v.trim() ? v.trim() : '');
    const nested = e.error && typeof e.error === 'object' ? e.error : null;
    const parts = uniqText([
        pick(e.message),
        pick(nested?.message),
        pick(typeof e.error === 'string' ? e.error : ''),
        pick(e.response),
        pick(e.statusText),
        pick(e.cause?.message) || pick(e.cause),
    ]);
    const status = e.status || nested?.status || nested?.code || '';
    if (parts.length) return `${status ? `[${status}] ` : ''}${parts.join('：')}`;
    try {
        const json = JSON.stringify(e);
        if (json && json !== '{}') return json.slice(0, 500);
    } catch { /* ignore */ }
    return String(e);
}

/** 酒馆后端只回了 {error: true}（没有原因）时，酒馆当前连接（generateRaw）给出的笼统报错，含中文界面的“未知错误” */
const BARE_BACKEND_ERROR = /^(?:Unknown error|未知错误|An unknown error occurred|发生未知错误|\{"error":true\})$/i;
/** 连接配置档模式下，酒馆后端回 {error: true} 或非 2xx 时的报错 */
const PROFILE_NOT_OK = /^Response not OK$/i;
/** 酒馆 throw new Error(对象) 得到的报错：常见于额度不足 / 内容审核，酒馆一般会同时弹窗 */
const OBJECT_ERROR = /^\[object Object\]$/;

const DROPPED_HINT = '最常见的是一次生成时间太长，连接被 API 或网络中途断开（命令行里是 Premature close / ECONNRESET / socket hang up 之类）。'
    + '可以减少单次生成的内容（写大纲：把「每批章数」调小、降低每章详细程度），或在插件设置里改用「DeepSeek（官方接口）」等直连方式。';

/** 连接配置档会把真正的错误包一层：new Error('API request failed', { cause }) */
function unwrapTavernError(e) {
    let cur = e;
    for (let i = 0; i < 5 && cur && typeof cur === 'object' && cur.cause && /^API request failed$/i.test(String(cur.message || '').trim()); i++) cur = cur.cause;
    return cur;
}

/**
 * 把酒馆（generateRaw / 连接配置档）抛出的错误包装成 LLMError。
 * 酒馆后端与 API 通信失败时（例如 DeepSeek 的 Premature close），只给前端回 {error: true}，
 * 前端只能显示“未知错误”，这里补上原因说明，并当作可重试的错误（多为连接中途断开）。
 */
export function tavernError(prefix, e) {
    const msg = errorText(e);
    const inner = errorText(unwrapTavernError(e)).trim();
    if (BARE_BACKEND_ERROR.test(inner)) {
        return new LLMError(`${prefix}：酒馆后端调用 API 失败，但没有把具体原因传给插件（酒馆只显示“${inner}”，真正的原因在酒馆的命令行窗口里）。${DROPPED_HINT}`, { retryable: true });
    }
    if (PROFILE_NOT_OK.test(inner)) {
        return new LLMError(`${prefix}：酒馆后端返回失败（Response not OK），没有把具体原因传给插件，真正的原因在酒馆的命令行窗口里。${DROPPED_HINT}`
            + '如果每次都立刻失败，多半是这个连接配置档的接口地址、密钥或模型有误，可以先在酒馆里切到这个配置档正常聊一句试试。', { retryable: true });
    }
    if (OBJECT_ERROR.test(inner)) {
        return new LLMError(`${prefix}：酒馆报告了 API 错误，但错误内容无法读取（[object Object]）。常见于额度不足、余额耗尽或内容审核拦截，酒馆一般会同时弹出提示；具体原因请看酒馆的弹窗或命令行窗口。重试通常无效。`);
    }
    return new LLMError(`${prefix}：${msg}`, { retryable: RETRYABLE_TEXT.test(msg) });
}

function uniqText(list) {
    const out = [];
    for (const s of list) if (s && !out.some((x) => x.includes(s))) out.push(s);
    return out;
}

function ctx() {
    return globalThis.SillyTavern?.getContext?.();
}

/** 合并多个 AbortSignal */
function linkSignals(...signals) {
    const ctl = new AbortController();
    for (const s of signals.filter(Boolean)) {
        if (s.aborted) {
            ctl.abort(s.reason);
            break;
        }
        s.addEventListener('abort', () => ctl.abort(s.reason), { once: true });
    }
    return ctl;
}

function withAbort(promise, signal) {
    if (!signal) return promise;
    if (signal.aborted) return Promise.reject(abortError());
    return new Promise((resolve, reject) => {
        const onAbort = () => reject(signal.reason?.name === 'TimeoutError' ? new LLMError('请求超时', { retryable: true }) : abortError());
        signal.addEventListener('abort', onAbort, { once: true });
        promise.then(
            (v) => {
                signal.removeEventListener('abort', onAbort);
                resolve(v);
            },
            (e) => {
                signal.removeEventListener('abort', onAbort);
                reject(e);
            },
        );
    });
}

/** 默认消息链：系统提示 + 用户提示（与未配置消息链时的行为一致） */
export const DEFAULT_CHAIN = [
    { role: 'system', content: '{SYSTEM}', enabled: true },
    { role: 'user', content: '{PROMPT}', enabled: true },
];

const ROLES = new Set(['system', 'user', 'assistant']);

/** 可单独配置消息链的任务 */
export const CHAIN_TASKS = [
    { value: 'default', label: '默认（所有任务）' },
    { value: 'extract', label: '分段提取' },
    { value: 'card', label: '写角色卡 / 群聊场景卡 / 审稿修订' },
    { value: 'outline', label: '写大纲' },
    { value: 'continue', label: '续写正文' },
    { value: 'tools', label: '整理 / 别名 / 梗概 / 关系分析' },
    { value: 'rewrite', label: '局部重写' },
];

/** 取某任务的消息链：任务自己的链（有启用消息时）> 默认链 > 内置默认 */
export function getChain(settings, task) {
    const chains = settings?.messageChains || {};
    const own = chains[task];
    if (task !== 'default' && Array.isArray(own) && own.some((m) => m && m.enabled !== false)) return own;
    const def = chains.default;
    return Array.isArray(def) && def.some((m) => m && m.enabled !== false) ? def : DEFAULT_CHAIN;
}

/** 生成 callLLM 所需的消息链参数 */
export function chainFor(settings, task, project) {
    return {
        chain: getChain(settings, task),
        vars: { BOOK: project?.bookName || project?.name || '', TASK: task },
        prependPrefill: settings?.chainOptions?.prependPrefill !== false,
        antiTruncate: settings?.antiTruncate,
    };
}

/**
 * 按消息链生成消息数组
 * @param {{role:string, content:string, enabled?:boolean}[]} chain
 * @param {Record<string,string>} vars 占位符：SYSTEM / PROMPT / BOOK …
 * @returns {{role:string, content:string}[]}
 */
export function buildChainMessages(chain, vars = {}) {
    const list = (Array.isArray(chain) && chain.length ? chain : DEFAULT_CHAIN).filter((m) => m && m.enabled !== false);
    const usesPrompt = list.some((m) => String(m.content || '').includes('{PROMPT}'));
    const out = list
        .map((m) => ({
            role: ROLES.has(m.role) ? m.role : 'user',
            content: String(m.content ?? '').replace(/\{(SYSTEM|PROMPT|BOOK|TASK)\}/g, (_, k) => String(vars[k] ?? '')),
        }))
        .filter((m) => m.content.trim().length > 0);
    // 链里没有 {PROMPT} 时自动补上，避免任务内容丢失
    if (!usesPrompt && vars.PROMPT) out.push({ role: 'user', content: String(vars.PROMPT) });
    return out;
}

function toMessages({ system, messages, prompt, chain, vars, followUps }) {
    let list;
    if (Array.isArray(chain)) {
        list = buildChainMessages(chain, { ...(vars || {}), SYSTEM: system || '', PROMPT: prompt ?? '' });
    } else {
        const main = Array.isArray(messages) && messages.length ? messages : [{ role: 'user', content: String(prompt ?? '') }];
        list = [...(system ? [{ role: 'system', content: String(system) }] : []), ...main];
    }
    list = list.map((m) => ({ role: ROLES.has(m.role) ? m.role : 'user', content: String(m.content ?? '') }));
    if (Array.isArray(followUps) && followUps.length) list = [...list, ...followUps.map((m) => ({ role: m.role || 'user', content: String(m.content ?? '') }))];
    const last = list[list.length - 1];
    const prefill = last && last.role === 'assistant' ? last.content : '';
    return { list, prefill };
}

/** 拆出开头的系统消息；中间的系统消息转成带标记的用户消息；合并相邻同角色消息 */
export function splitSystem(list, { firstRoleUser = true } = {}) {
    let i = 0;
    const sys = [];
    while (i < list.length && list[i].role === 'system') sys.push(list[i++].content);
    const rest = [];
    for (const m of list.slice(i)) {
        const role = m.role === 'assistant' ? 'assistant' : 'user';
        const content = m.role === 'system' ? `[系统指令]\n${m.content}` : m.content;
        const lastMsg = rest[rest.length - 1];
        if (lastMsg && lastMsg.role === role) lastMsg.content += `\n\n${content}`;
        else rest.push({ role, content });
    }
    if (firstRoleUser && rest[0]?.role !== 'user') rest.unshift({ role: 'user', content: '请根据以下对话执行任务。' });
    return { system: sys.join('\n\n'), messages: rest };
}

function flatten(list) {
    return list.map((m) => (m.role === 'user' ? m.content : `[${m.role === 'system' ? '系统' : 'AI'}]\n${m.content}`)).join('\n\n');
}

export function isTokenLimitError(message) {
    const s = String(message || '').slice(0, 1000);
    return /prompt is too long|context.?length|context_length|maximum context|max_prompt_tokens|too many tokens|tokens?[^\n]{0,40}exceed|exceed[^\n]{0,40}(token|context)|input tokens|超出.{0,6}(上下文|长度|token)|上下文.{0,6}(超|过长)/i.test(s);
}

// ---------------- 截断 / 拒绝 / 过滤识别 ----------------

/** 因长度上限被截断的结束原因 */
export function isLengthFinish(finish) {
    return /^(length|max_tokens|MAX_TOKENS|model_length)$/i.test(String(finish || ''));
}

/** 因服务商内容过滤而停止的结束原因 */
export function isFilteredFinish(finish) {
    return /^(content_filter|SAFETY|PROHIBITED_CONTENT|BLOCKLIST|SPII|RECITATION|IMAGE_SAFETY|refusal)$/i.test(String(finish || ''));
}

function stripThinking(text) {
    return String(text || '').replace(/<(think|thinking|reasoning)>[\s\S]*?<\/\1>/gi, '');
}

/** JSON 是否没有闭合（从第一个 { 或 [ 开始扫描，忽略字符串里的括号） */
export function jsonUnclosed(text) {
    const s = stripThinking(text);
    if (/<(think|thinking|reasoning)>/i.test(s)) return true; // 截断在思考标签里
    const start = s.search(/[{[]/);
    if (start < 0) return false;
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = start; i < s.length; i++) {
        const c = s[i];
        if (inStr) {
            if (esc) esc = false;
            else if (c === '\\') esc = true;
            else if (c === '"') inStr = false;
            continue;
        }
        if (c === '"') inStr = true;
        else if (c === '{' || c === '[') depth++;
        else if (c === '}' || c === ']') {
            depth--;
            if (depth <= 0) return false;
        }
    }
    return depth > 0 || inStr;
}

/**
 * 没有结束原因可用时（酒馆当前连接 / 连接配置档），根据内容判断是否在中途断开
 * @param {'json'|'prose'|undefined} expect
 */
export function looksTruncated(text, expect) {
    const t = stripThinking(text).replace(/\s+$/, '');
    if (!t) return false;
    if (expect === 'json') return jsonUnclosed(text);
    if (expect === 'prose') return !/[。！？!?…~～”’」』）)\]】》.．—\-*"'`>]$/.test(t);
    return false;
}

const REFUSAL_RE = /^[\s\S]{0,60}?(?:I(?:'m| am) (?:sorry|unable|not able)|I can(?:'|no)t (?:help|assist|continue|write|create|provide|produce|comply)|I won'?t (?:write|continue|create|produce)|I must decline|As an AI|抱歉[，,]?\s*(?:我|但我)(?:无法|不能)|对不起[，,]?\s*(?:我|但我)(?:无法|不能)|我无法(?:继续|完成|提供|生成|协助|满足|创作)|我不能(?:继续|提供|生成|协助|满足|创作)|作为(?:一个)?(?:AI|人工智能|语言模型))/i;

/** 回复是否像模型拒绝（很短、不是 JSON、开头是拒绝用语） */
export function looksLikeRefusal(text, expect) {
    const t = stripThinking(text).trim();
    if (!t || t.length > 500) return false;
    if (expect === 'json' && /^(```|\{|\[)/.test(t)) return false;
    return REFUSAL_RE.test(t);
}

/** 拼接接续内容：去掉重复的衔接部分；JSON 若整段重来则用新的 */
export function joinContinuation(a, b, expect) {
    let more = String(b || '');
    if (expect === 'json') {
        const t = more.replace(/^\s*```(?:json)?\s*/i, '');
        if (/^\s*\{/.test(t) && !jsonUnclosed(t) && /\}\s*(```)?\s*$/.test(t) && jsonUnclosed(a)) return t.replace(/```\s*$/, '').trim();
        more = t.replace(/```\s*$/, '');
    }
    const max = Math.min(a.length, more.length, 400);
    for (let k = max; k >= 4; k--) {
        if (a.endsWith(more.slice(0, k))) {
            more = more.slice(k);
            break;
        }
    }
    return a + more;
}

const END_RE = /^\s*[[【(（]?\s*(?:END|完|已完成|已完整)\s*[\]】)）]?\s*[。.]?\s*$/i;

async function httpJson(url, init, signal) {
    let res;
    try {
        res = await fetch(url, { ...init, signal });
    } catch (e) {
        if (isAbortError(e)) throw signal?.reason?.name === 'TimeoutError' ? new LLMError('请求超时', { retryable: true }) : abortError();
        throw new LLMError(`网络错误：${e.message}（若为跨域 CORS 问题，请改用“酒馆连接配置档”模式）`, { retryable: true });
    }
    const text = await res.text();
    if (!res.ok) {
        throw new LLMError(`HTTP ${res.status}：${text.slice(0, 300)}`, { status: res.status, retryable: RETRYABLE_STATUS.has(res.status), raw: text });
    }
    try {
        return JSON.parse(text);
    } catch {
        throw new LLMError(`响应不是 JSON：${text.slice(0, 200)}`, { retryable: true, raw: text });
    }
}

// ---------------- 各模式实现 ----------------

async function callTavern({ list, signal, userSignal }) {
    const c = ctx();
    if (!c?.generateRaw) throw new LLMError('无法访问酒馆 generateRaw，请确认 SillyTavern 版本');
    // 只有用户主动停止时才调用 stopGeneration（它会停止酒馆内所有生成）；超时只放弃等待
    const onAbort = () => {
        try {
            c.stopGeneration?.();
        } catch { /* ignore */ }
    };
    userSignal?.addEventListener('abort', onAbort, { once: true });
    try {
        let result;
        try {
            // 注意：不传 responseLength。酒馆用全局变量临时替换回复长度，并发调用时可能把用户的设置永久改掉；
            // 因此酒馆模式沿用用户在酒馆里设置的“最大回复长度”。
            result = await withAbort(c.generateRaw({ prompt: list }), signal);
        } catch (e) {
            if (isAbortError(e) || e instanceof LLMError) throw e;
            // 旧版酒馆：位置参数 + 字符串
            if (/is not a function|Cannot read|prompt\.map|substring|trim/i.test(String(e?.message))) {
                result = await withAbort(c.generateRaw(flatten(list)), signal);
            } else {
                throw tavernError('酒馆生成失败', e);
            }
        }
        return { text: String(result ?? '') };
    } finally {
        userSignal?.removeEventListener('abort', onAbort);
    }
}

async function callProfile({ list, maxTokens, signal, api }) {
    const c = ctx();
    const svc = c?.ConnectionManagerRequestService;
    if (!svc) throw new LLMError('当前酒馆不支持连接配置档（需要较新版本并启用 Connection Manager）');
    if (!api.profileId) throw new LLMError('请先在设置中选择一个连接配置档');
    try {
        const res = await svc.sendRequest(api.profileId, list, maxTokens || 4096, {
            stream: false,
            signal,
            extractData: true,
            includePreset: !!api.includePreset,
            includeInstruct: true,
        });
        const text = typeof res === 'string' ? res : (res?.content ?? '');
        return { text: String(text), reasoning: res?.reasoning || '' };
    } catch (e) {
        if (isAbortError(e) || signal?.aborted) throw signal?.reason?.name === 'TimeoutError' ? new LLMError('请求超时', { retryable: true }) : abortError();
        throw tavernError('连接配置档请求失败', e);
    }
}

function openaiUrl(endpoint, defaultBase = 'https://api.openai.com/v1') {
    let base = String(endpoint || defaultBase).trim().replace(/\/+$/, '');
    if (/\/chat\/completions$/.test(base)) return base;
    return `${base}/chat/completions`;
}

async function callOpenAI({ list, maxTokens, temperature, signal, api }) {
    const msgs = list;
    const headers = { 'Content-Type': 'application/json' };
    if (api.apiKey) headers.Authorization = `Bearer ${api.apiKey}`;
    const body = { model: api.model, messages: msgs, temperature, max_tokens: maxTokens, stream: false };
    const defaultBase = api.mode === 'deepseek' ? DEEPSEEK_DEFAULT_ENDPOINT : 'https://api.openai.com/v1';
    const data = await httpJson(openaiUrl(api.endpoint, defaultBase), { method: 'POST', headers, body: JSON.stringify(body) }, signal);
    const choice = data?.choices?.[0];
    const text = choice?.message?.content ?? choice?.text ?? '';
    if (data?.error) throw new LLMError(`API 错误：${data.error.message || JSON.stringify(data.error)}`, { retryable: RETRYABLE_TEXT.test(JSON.stringify(data.error)) });
    const out = Array.isArray(text) ? text.map((t) => t.text || '').join('') : String(text);
    if (!out.trim() && isFilteredFinish(choice?.finish_reason)) {
        throw new LLMError(`被服务商的内容过滤拦截（${choice.finish_reason}），这不是长度截断，重试通常无效`, { kind: 'filtered' });
    }
    if (!out.trim() && choice?.message?.refusal) throw new LLMError(`模型拒绝了这次请求：${choice.message.refusal}`, { kind: 'refusal' });
    return { text: out, reasoning: choice?.message?.reasoning_content || '', finish: choice?.finish_reason };
}

const GEMINI_CATEGORIES = ['HARM_CATEGORY_HARASSMENT', 'HARM_CATEGORY_HATE_SPEECH', 'HARM_CATEGORY_SEXUALLY_EXPLICIT', 'HARM_CATEGORY_DANGEROUS_CONTENT'];

export const GEMINI_SAFETY_OPTIONS = [
    { value: 'BLOCK_NONE', label: 'BLOCK_NONE（不拦截）' },
    { value: 'OFF', label: 'OFF（关闭过滤，部分模型支持）' },
    { value: 'BLOCK_ONLY_HIGH', label: 'BLOCK_ONLY_HIGH（只拦截高风险）' },
    { value: '', label: '服务商默认' },
];

async function callGemini({ list, maxTokens, temperature, signal, api }) {
    const base = String(api.endpoint || 'https://generativelanguage.googleapis.com').replace(/\/+$/, '');
    const model = api.model || 'gemini-2.5-flash';
    const url = `${base}/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(api.apiKey || '')}`;
    const { system, messages } = splitSystem(list);
    const contents = messages.map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));
    const body = {
        contents,
        generationConfig: { temperature, maxOutputTokens: maxTokens },
    };
    // Gemini 官方的安全阈值参数；留空则使用服务商默认
    const threshold = api.geminiSafety === undefined ? 'BLOCK_NONE' : api.geminiSafety;
    if (threshold) body.safetySettings = GEMINI_CATEGORIES.map((category) => ({ category, threshold }));
    if (system) body.systemInstruction = { parts: [{ text: system }] };
    const data = await httpJson(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, signal);
    const cand = data?.candidates?.[0];
    const parts = cand?.content?.parts || [];
    const text = parts.filter((p) => !p.thought).map((p) => p.text || '').join('');
    if (!text && data?.promptFeedback?.blockReason) {
        throw new LLMError(`Gemini 拦截了提示词（${data.promptFeedback.blockReason}），这不是长度截断。可在设置里调整 Gemini 安全阈值，或精简提示词中的敏感内容`, { kind: 'filtered' });
    }
    if (!text && isFilteredFinish(cand?.finishReason)) {
        throw new LLMError(`Gemini 安全过滤拦截了回复（${cand.finishReason}），这不是长度截断。可在设置里调整 Gemini 安全阈值`, { kind: 'filtered' });
    }
    return { text, finish: cand?.finishReason };
}

async function callAnthropic({ list, maxTokens, temperature, signal, api }) {
    const base = String(api.endpoint || 'https://api.anthropic.com').replace(/\/+$/, '');
    const url = /\/v1\/messages$/.test(base) ? base : `${base}/v1/messages`;
    // Anthropic 要求 user/assistant 交替、首条为 user，系统提示单独传
    const { system, messages: msgs } = splitSystem(list);
    const body = { model: api.model || 'claude-sonnet-4-5', max_tokens: maxTokens || 4096, messages: msgs, temperature };
    if (system) body.system = system;
    const data = await httpJson(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-api-key': api.apiKey || '',
            'anthropic-version': '2023-06-01',
            'anthropic-dangerous-direct-browser-access': 'true',
        },
        body: JSON.stringify(body),
    }, signal);
    const text = (data?.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
    if (!text.trim() && data?.stop_reason === 'refusal') throw new LLMError('模型拒绝了这次请求（stop_reason: refusal），这不是长度截断', { kind: 'refusal' });
    return { text, finish: data?.stop_reason };
}

const IMPL = { tavern: callTavern, profile: callProfile, openai: callOpenAI, deepseek: callOpenAI, gemini: callGemini, anthropic: callAnthropic };

/** 单次请求（含超时与失败重试） */
async function requestWithRetry(impl, list, req, api) {
    const retries = Math.max(0, Number(api.retries ?? 2));
    const baseMs = Math.max(500, Number(api.retryBaseMs ?? 2000));
    const timeoutMs = Math.max(10, Number(api.timeoutSec ?? 300)) * 1000;
    let lastErr;
    for (let attempt = 0; attempt <= retries; attempt++) {
        if (req.signal?.aborted) throw abortError();
        const timeoutCtl = new AbortController();
        const timer = setTimeout(() => {
            const e = new Error('timeout');
            e.name = 'TimeoutError';
            timeoutCtl.abort(e);
        }, timeoutMs);
        const linked = linkSignals(req.signal, timeoutCtl.signal);
        try {
            const res = await impl({
                list,
                maxTokens: req.maxTokens ?? api.maxTokens,
                temperature: req.temperature ?? api.temperature,
                signal: linked.signal,
                userSignal: req.signal,
                api,
            });
            if (!res.text || !String(res.text).trim()) throw new LLMError('AI 返回了空内容（empty response；可能是服务商过滤，或酒馆里的回复长度设得太小）', { retryable: true });
            return { ...res, attempts: attempt + 1 };
        } catch (e) {
            if (req.signal?.aborted) throw abortError();
            lastErr = e;
            const retryable = !isTokenLimitError(e?.message) && (e instanceof LLMError ? e.retryable : RETRYABLE_TEXT.test(String(e?.message)));
            if (!retryable || attempt >= retries) break;
            const wait = Math.min(60000, baseMs * 2 ** attempt + Math.random() * 500);
            req.onRetry?.({ attempt: attempt + 1, wait, error: e });
            await sleep(wait, req.signal);
        } finally {
            clearTimeout(timer);
        }
    }
    throw lastErr instanceof Error ? lastErr : new LLMError(String(lastErr));
}

/**
 * 统一调用入口
 * @param {{system?: string, prompt?: string, messages?: {role:string,content:string}[], chain?: object[], vars?: object,
 *   followUps?: {role:string,content:string}[], prependPrefill?: boolean, maxTokens?: number, temperature?: number,
 *   signal?: AbortSignal, api: object, onRetry?: Function, onNotice?: Function,
 *   antiTruncate?: {enabled?:boolean, maxContinues?:number, style?:string, prompt?:string, detectRefusal?:boolean},
 *   expect?: 'json'|'prose'}} req
 *   chain：消息链（{SYSTEM}/{PROMPT}/{BOOK} 占位符）；followUps：追加在链之后的消息（如 JSON 修复重试）
 *   antiTruncate：被截断时自动接续；expect：输出类型，用于在没有结束原因时判断是否中途断开、是否为拒绝
 * @returns {Promise<{text:string, reasoning?:string, finish?:string, ms:number, attempts:number, continues:number}>}
 */
export async function callLLM(req) {
    const api = req.api || {};
    const impl = IMPL[api.mode] || callTavern;
    const { list, prefill } = toMessages(req);
    const started = Date.now();
    const at = req.antiTruncate || {};
    let res = await requestWithRetry(impl, list, req, api);
    let attempts = res.attempts;
    // 思考模型（如 deepseek-reasoner）的思考过程在 callOpenAI/callProfile 里已经和正文分开返回（reasoning 字段），
    // 不会进入 res.text、不会被当成正文或 JSON 解析；这里只是让调用方知道确实收到了，并原样丢弃，避免它悄悄混进输出。
    if (res.reasoning) req.onNotice?.(`🧠 已收到思考过程（约 ${res.reasoning.length} 字，已与正文分开，不会进入输出）`, 'info');
    // 消息链以 assistant 预填结尾时，模型只会返回续写部分，这里把预填拼回开头
    if (prefill && req.prependPrefill !== false && !String(res.text).trimStart().startsWith(prefill.trim())) res.text = prefill + res.text;

    if (at.detectRefusal && req.expect && looksLikeRefusal(res.text, req.expect)) {
        throw new LLMError(`AI 拒绝了这次请求（不是截断，重试通常无效）：「${stripThinking(res.text).trim().slice(0, 120)}」`, { kind: 'refusal', raw: res.text });
    }
    if (isFilteredFinish(res.finish)) req.onNotice?.(`⚠️ 回复被服务商的内容过滤中断（${res.finish}），内容可能不完整`, 'warn');

    let continues = 0;
    const max = Math.max(0, Math.min(10, Number(at.maxContinues ?? 3)));
    if (at.enabled) {
        // 接续时以“完整的已写内容”作为 AI 消息，替换掉链末尾的预填
        const base = prefill ? list.slice(0, -1) : list;
        const style = at.style === 'prefill' || at.style === 'ask' ? at.style : api.mode === 'anthropic' ? 'prefill' : 'ask';
        while (continues < max) {
            const cut = isLengthFinish(res.finish) || (!res.finish && looksTruncated(res.text, req.expect));
            if (!cut) break;
            continues++;
            req.onNotice?.(`✂️ 回复${res.finish ? `达到长度上限（${res.finish}）` : '疑似在中途断开'}，第 ${continues} 次自动接续…`, 'warn');
            const partial = style === 'prefill' ? String(res.text).replace(/\s+$/, '') : String(res.text);
            const msgs = [...base, { role: 'assistant', content: partial }];
            if (style === 'ask') {
                const tail = stripThinking(partial).replace(/\s+/g, ' ').trim().slice(-30);
                msgs.push({ role: 'user', content: String(at.prompt || '请从中断处直接接着写，不要重复。').replace(/\{TAIL\}/g, tail) });
            }
            let more;
            try {
                more = await requestWithRetry(impl, msgs, req, api);
            } catch (e) {
                if (isAbortError(e)) throw e;
                req.onNotice?.(`⚠️ 接续失败（${e.message}），保留已生成的部分`, 'warn');
                break;
            }
            attempts += more.attempts;
            if (END_RE.test(stripThinking(more.text))) {
                res = { ...res, finish: 'stop' };
                break;
            }
            res = { ...more, text: joinContinuation(partial, more.text, req.expect) };
            if (isFilteredFinish(res.finish)) {
                req.onNotice?.(`⚠️ 接续内容被服务商的内容过滤中断（${res.finish}）`, 'warn');
                break;
            }
        }
        if (continues && continues >= max && (isLengthFinish(res.finish) || (!res.finish && looksTruncated(res.text, req.expect)))) {
            req.onNotice?.(`⚠️ 已接续 ${max} 次仍未写完，请调大“最大输出 tokens”或酒馆里的回复长度`, 'warn');
        }
    }
    return { ...res, ms: Date.now() - started, attempts, continues };
}

/** 列出可用模型（自定义接口）或连接配置档 */
export async function listModels(api) {
    if (api.mode === 'profile') {
        const profiles = ctx()?.extensionSettings?.connectionManager?.profiles || [];
        return profiles.map((p) => ({ id: p.id, name: `${p.name}${p.model ? `（${p.model}）` : ''}` }));
    }
    if (api.mode === 'openai' || api.mode === 'deepseek') {
        const defaultBase = api.mode === 'deepseek' ? DEEPSEEK_DEFAULT_ENDPOINT : 'https://api.openai.com/v1';
        const base = String(api.endpoint || defaultBase).replace(/\/+$/, '').replace(/\/chat\/completions$/, '');
        const headers = api.apiKey ? { Authorization: `Bearer ${api.apiKey}` } : {};
        const data = await httpJson(`${base}/models`, { headers }, undefined);
        return (data?.data || data?.models || []).map((m) => ({ id: m.id || m.name, name: m.id || m.name }));
    }
    if (api.mode === 'gemini') {
        const base = String(api.endpoint || 'https://generativelanguage.googleapis.com').replace(/\/+$/, '');
        const data = await httpJson(`${base}/v1beta/models?key=${encodeURIComponent(api.apiKey || '')}`, {}, undefined);
        return (data?.models || []).filter((m) => (m.supportedGenerationMethods || []).includes('generateContent')).map((m) => ({ id: m.name.replace(/^models\//, ''), name: m.displayName || m.name }));
    }
    if (api.mode === 'anthropic') {
        const base = String(api.endpoint || 'https://api.anthropic.com').replace(/\/+$/, '');
        const data = await httpJson(`${base}/v1/models`, { headers: { 'x-api-key': api.apiKey || '', 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' } }, undefined);
        return (data?.data || []).map((m) => ({ id: m.id, name: m.display_name || m.id }));
    }
    return [];
}

export async function testApi(api) {
    const res = await callLLM({ api: { ...api, retries: 0, timeoutSec: 60 }, prompt: '请只回复两个字：你好', maxTokens: 50 });
    return res;
}
