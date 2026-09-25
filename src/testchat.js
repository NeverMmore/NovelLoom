// 写卡前试聊：不写入酒馆，直接用当前草稿卡片的字段在插件内模拟对话，快速看看开场白与回复怎么样

import { callLLM } from './llm.js';
import { removeTags } from './json.js';

function resolveMacros(text, { charName, userName }) {
    return String(text || '')
        .replace(/\{\{char\}\}/gi, charName)
        .replace(/\{\{user\}\}/gi, userName);
}

/** 把草稿卡片的字段拼成一段“扮演须知”系统提示词 */
export function buildPersonaSystem(card, { userName = '你' } = {}) {
    const d = card.data;
    const charName = d.name || '角色';
    const parts = [`你正在扮演「${charName}」，与${userName}进行一对一对话。只以「${charName}」的第一人称说话与行动，不要跳出角色、不要输出旁白式的“作为 AI”之类说明，也不要替${userName}说话或描写${userName}的心理。`];
    if (d.description) parts.push(`# 角色设定\n${resolveMacros(d.description, { charName, userName })}`);
    if (d.personality) parts.push(`# 性格摘要\n${resolveMacros(d.personality, { charName, userName })}`);
    if (d.scenario) parts.push(`# 场景\n${resolveMacros(d.scenario, { charName, userName })}`);
    if (d.system_prompt) parts.push(`# 额外系统指令\n${resolveMacros(d.system_prompt, { charName, userName })}`);
    if (d.mes_example) parts.push(`# 说话方式参考（模仿其中的语气、句式与口癖，不要照抄内容）\n${resolveMacros(d.mes_example, { charName, userName })}`);
    parts.push('这是一次写卡前的快速试聊，用来检查角色是否立得住；正常对话即可，回复不用太长。');
    return parts.join('\n\n');
}

/**
 * 生成开场白（first_mes，宏已替换）；没有则返回空字符串
 */
export function greetingText(card, opt = {}) {
    return resolveMacros(card.data.first_mes || '', { charName: card.data.name || '角色', userName: opt.userName || '你' });
}

/**
 * 试聊一轮：history 是已经展示过的 {role:'user'|'assistant', content}[]（不含新的这条用户消息）
 * @returns {Promise<string>}
 */
export async function testChatReply(_project, settings, card, history, userMessage, { signal, api } = {}) {
    const msg = String(userMessage || '').trim();
    if (!msg) throw new Error('请输入消息');
    const userName = globalThis.SillyTavern?.getContext?.()?.name1 || '你';
    const system = buildPersonaSystem(card, { userName });
    const messages = [
        ...(history || []).map((m) => ({ role: m.role, content: m.content })),
        { role: 'user', content: msg },
    ];
    const res = await callLLM({
        api: api || settings.api,
        system,
        messages,
        expect: 'prose',
        signal,
        maxTokens: Math.max((api || settings.api)?.maxTokens || 0, 600),
    });
    const text = removeTags(res.text, settings.extraction?.filterTags).trim();
    if (!text) throw new Error('AI 没有返回内容');
    return text;
}
