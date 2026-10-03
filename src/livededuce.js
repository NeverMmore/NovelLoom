// 剧情推演（当前酒馆对话版）：不依赖 NovelLoom 项目/卡片，直接基于酒馆里正在进行的这个单人对话
// ——角色卡当前的实际设定 + 目前为止的聊天记录 + 这个对话当前会触发的世界书条目——推演接下来可能的发展。
// 和 deduce.js（角色卡页的剧情推演，推演的是 NovelLoom 项目里自己生成的卡）是两条独立的路，互不影响；
// 这里复用 deduce.js 里已经写好、测试过的走向/阶段 JSON 结构（normBranch/normStage/directionsText）和走向模板
// （branchTemplates 等，保存在扩展设置里，两条路共用同一套模板池），只是背景资料的收集方式不同：改成从
// SillyTavern.getContext() 读取角色卡字段、实际聊天记录、当前生效的世界书扫描结果。
// 结果存在这个对话自己的 chat_metadata 里（键名 CHAT_META_KEY），换一个对话或换一个角色都不会互相影响；
// 只支持单人角色对话，群聊（多角色、无固定 this_chid）不在这次范围内。

import { directionsText, normBranch, normStage, DEFAULT_BRANCH_COUNT } from './deduce.js';
import { extractJson, removeTags } from './json.js';
import { callLLM, chainFor } from './llm.js';
import { WRITING_RULES, getPrompt, render } from './prompts.js';
import { uniq, uid } from './utils.js';

export const CHAT_META_KEY = 'novel_loom_deduce';
/** 取最近多少条消息当作"目前聊到哪了"的参考；太多会让提示词无限增长，这里截断不代表更早的内容不存在 */
const CHAT_HISTORY_MESSAGES = 40;

export function ctx() {
    return globalThis.SillyTavern?.getContext?.();
}

/** 当前是否处于可以推演的单人角色对话（群聊/没有选中角色时不支持） */
export function hasActiveChat() {
    const c = ctx();
    if (!c) return false;
    if (c.groupId) return false;
    return Number.isInteger(c.characterId) && !!c.characters?.[c.characterId];
}

export function activeCharacterName() {
    const c = ctx();
    return c?.characters?.[c.characterId]?.name || c?.name2 || '';
}

/** 确保当前对话的 chat_metadata[CHAT_META_KEY] 结构完整，返回它本身（可直接修改，修改后记得调用 persistChatProjection） */
export function ensureChatProjection() {
    const c = ctx();
    if (!c) throw new Error('找不到 SillyTavern 上下文');
    if (!c.chatMetadata[CHAT_META_KEY] || typeof c.chatMetadata[CHAT_META_KEY] !== 'object') {
        c.chatMetadata[CHAT_META_KEY] = { branches: [], selectedBranchIds: [], stages: [], branchesUpdatedAt: 0, stagesUpdatedAt: 0 };
    }
    const pp = c.chatMetadata[CHAT_META_KEY];
    if (!Array.isArray(pp.branches)) pp.branches = [];
    if (!Array.isArray(pp.selectedBranchIds)) pp.selectedBranchIds = [];
    if (!Array.isArray(pp.stages)) pp.stages = [];
    return pp;
}

/** 落盘到这个对话自己的 chat_metadata（随聊天记录一起保存，不会跨对话/跨角色共享） */
export async function persistChatProjection() {
    const c = ctx();
    const pp = ensureChatProjection();
    c.updateChatMetadata({ [CHAT_META_KEY]: pp });
    await c.saveMetadata();
}

function cardContentText() {
    const c = ctx();
    const f = c.getCharacterCardFields({ chid: c.characterId });
    const greetings = [f.firstMessage, ...(f.alternateGreetings || [])].filter(Boolean);
    return [
        `姓名：${activeCharacterName()}`,
        f.description ? `描述：${f.description}` : '',
        f.personality ? `性格摘要：${f.personality}` : '',
        f.scenario ? `场景：${f.scenario}` : '',
        greetings[0] ? `开场白：${greetings[0]}` : '',
        f.mesExamples?.length ? `示例对话：${f.mesExamples.join('\n')}` : '',
        f.system ? `系统提示词：${f.system}` : '',
    ].filter(Boolean).join('\n\n');
}

/** 取最近若干条实际聊天记录，格式化成"现在已经聊到哪了"的文本 */
function chatHistoryText(limit = CHAT_HISTORY_MESSAGES) {
    const c = ctx();
    const msgs = (c.chat || []).filter((m) => !m.is_system && m.mes).slice(-limit);
    if (!msgs.length) return '（还没有聊天记录，这是对话刚开始，就从开场白往后推演）';
    return msgs.map((m) => `${m.name}：${m.mes}`).join('\n\n');
}

/** 这个对话当前实际会触发的世界书内容：直接用酒馆自己的扫描逻辑（isDryRun=true，不影响粘滞/冷却等状态），
 *  和真正发一条消息时注入的世界书资料一致，不需要我们自己猜该用哪本书、哪些条目 */
async function worldInfoText() {
    const c = ctx();
    try {
        const { worldInfoString } = await c.getWorldInfoPrompt(c.chat, c.maxContext, true);
        return String(worldInfoString || '').trim();
    } catch {
        return '';
    }
}

async function backgroundContext() {
    const wi = await worldInfoText();
    return [
        `最近的聊天记录（从这里的结尾继续往后推演，不要重复、也不要推翻已经发生过的内容）：\n\n${chatHistoryText()}`,
        wi ? `当前生效的世界书资料：\n\n${wi}` : '',
    ].filter(Boolean).join('\n\n---\n\n');
}

/**
 * @param {string[]} opt.directions 每条走向的方向提示，按顺序对应生成结果；留空字符串表示该条不限方向。
 */
export async function buildChatBranchesPrompt(settings, { count = DEFAULT_BRANCH_COUNT, instruction = '', directions = [] } = {}) {
    const dirs = directions.length ? directions : new Array(Math.max(2, Math.min(6, Number(count) || DEFAULT_BRANCH_COUNT))).fill('');
    const vars = {
        CARD_CONTENT: cardContentText(),
        CONTEXT: await backgroundContext(),
        COUNT: dirs.length,
        DIRECTIONS: directionsText(dirs),
        INSTRUCTION_LINE: instruction.trim() ? `整体额外要求（对每条走向都适用）：${instruction.trim()}` : '',
        WRITING_RULES,
    };
    return {
        system: render(getPrompt(settings, 'deduceChatBranchesSystem'), vars),
        prompt: render(getPrompt(settings, 'deduceChatBranches'), vars),
    };
}

/** 生成/重新生成并列走向：整体替换现有走向，并清空已选中状态；结果落盘到这个对话的 chat_metadata */
export async function generateChatBranches(settings, { signal, count = DEFAULT_BRANCH_COUNT, instruction = '', directions = [] } = {}) {
    const pp = ensureChatProjection();
    const { system, prompt } = await buildChatBranchesPrompt(settings, { count, instruction, directions });
    const res = await callLLM({
        api: settings.api, system, prompt, ...chainFor(settings, 'card'), expect: 'json', signal,
        maxTokens: Math.max(settings.api.maxTokens || 0, 4000),
    });
    const raw = removeTags(res.text, settings.extraction.filterTags);
    let json;
    try {
        json = extractJson(raw);
    } catch (e) {
        e.raw = raw;
        throw e;
    }
    const list = (Array.isArray(json) ? json : json.branches || json.走向 || []).map(normBranch).filter((b) => b.title || b.summary);
    if (!list.length) {
        const err = new Error('AI 没有返回剧情走向');
        err.raw = raw;
        throw err;
    }
    pp.branches = list;
    pp.selectedBranchIds = [];
    pp.branchesUpdatedAt = Date.now();
    await persistChatProjection();
    return pp.branches;
}

export async function addChatBranch({ title = '', summary = '' } = {}) {
    const pp = ensureChatProjection();
    const b = { id: uid('branch_'), title: String(title).trim(), summary: String(summary).trim(), createdAt: Date.now() };
    pp.branches.push(b);
    pp.branchesUpdatedAt = Date.now();
    await persistChatProjection();
    return b;
}

export async function updateChatBranch(id, patch = {}) {
    const pp = ensureChatProjection();
    const b = pp.branches.find((x) => x.id === id);
    if (!b) return null;
    if (patch.title !== undefined) b.title = String(patch.title).trim();
    if (patch.summary !== undefined) b.summary = String(patch.summary).trim();
    pp.branchesUpdatedAt = Date.now();
    await persistChatProjection();
    return b;
}

export async function removeChatBranch(id) {
    const pp = ensureChatProjection();
    pp.branches = pp.branches.filter((x) => x.id !== id);
    pp.selectedBranchIds = pp.selectedBranchIds.filter((x) => x !== id);
    pp.branchesUpdatedAt = Date.now();
    await persistChatProjection();
}

/** 设置当前选中的走向（可多选）；自动过滤掉不存在的 id */
export async function setSelectedChatBranches(ids) {
    const pp = ensureChatProjection();
    const valid = new Set(pp.branches.map((b) => b.id));
    pp.selectedBranchIds = uniq(ids).filter((id) => valid.has(id));
    await persistChatProjection();
    return pp.selectedBranchIds;
}

export async function buildChatStagesPrompt(settings, { instruction = '' } = {}) {
    const pp = ensureChatProjection();
    const selected = pp.branches.filter((b) => pp.selectedBranchIds.includes(b.id));
    if (!selected.length) throw new Error('请先至少选择一个剧情走向');
    const vars = {
        CARD_CONTENT: cardContentText(),
        CONTEXT: await backgroundContext(),
        BRANCHES: selected.map((b, i) => `${i + 1}. ${b.title}\n${b.summary}`).join('\n\n'),
        INSTRUCTION_LINE: instruction.trim() ? `额外要求：${instruction.trim()}` : '',
        WRITING_RULES,
    };
    return {
        system: render(getPrompt(settings, 'deduceChatStagesSystem'), vars),
        prompt: render(getPrompt(settings, 'deduceChatStages'), vars),
    };
}

/** 生成/重新生成分阶段推演：需要先选中至少一个走向；整体替换现有阶段；结果落盘到这个对话的 chat_metadata */
export async function generateChatStages(settings, { signal, instruction = '' } = {}) {
    const pp = ensureChatProjection();
    const { system, prompt } = await buildChatStagesPrompt(settings, { instruction });
    const res = await callLLM({
        api: settings.api, system, prompt, ...chainFor(settings, 'card'), expect: 'json', signal,
        maxTokens: Math.max(settings.api.maxTokens || 0, 5000),
    });
    const raw = removeTags(res.text, settings.extraction.filterTags);
    let json;
    try {
        json = extractJson(raw);
    } catch (e) {
        e.raw = raw;
        throw e;
    }
    const list = (Array.isArray(json) ? json : json.stages || json.阶段 || []).map(normStage).filter((s) => s.title || s.content);
    if (!list.length) {
        const err = new Error('AI 没有返回推演阶段');
        err.raw = raw;
        throw err;
    }
    pp.stages = list;
    pp.stagesUpdatedAt = Date.now();
    await persistChatProjection();
    return pp.stages;
}

export async function addChatStage({ title = '', content = '' } = {}) {
    const pp = ensureChatProjection();
    const s = { id: uid('stage_'), title: String(title).trim(), content: String(content).trim(), createdAt: Date.now(), updatedAt: Date.now() };
    pp.stages.push(s);
    pp.stagesUpdatedAt = Date.now();
    await persistChatProjection();
    return s;
}

export async function updateChatStage(id, patch = {}) {
    const pp = ensureChatProjection();
    const s = pp.stages.find((x) => x.id === id);
    if (!s) return null;
    if (patch.title !== undefined) s.title = String(patch.title).trim();
    if (patch.content !== undefined) s.content = String(patch.content).trim();
    s.updatedAt = Date.now();
    pp.stagesUpdatedAt = Date.now();
    await persistChatProjection();
    return s;
}

export async function removeChatStage(id) {
    const pp = ensureChatProjection();
    pp.stages = pp.stages.filter((x) => x.id !== id);
    pp.stagesUpdatedAt = Date.now();
    await persistChatProjection();
}

export function chatDeductionMarkdown() {
    const pp = ensureChatProjection();
    const lines = [`# ${activeCharacterName()} · 当前对话剧情推演`, ''];
    if (pp.branches.length) {
        lines.push('## 可能的走向', '');
        for (const b of pp.branches) lines.push(`- ${pp.selectedBranchIds.includes(b.id) ? '✅ ' : ''}**${b.title}**：${b.summary}`);
        lines.push('');
    }
    if (pp.stages.length) {
        lines.push('## 分阶段推演', '');
        pp.stages.forEach((s, i) => lines.push(`### ${i + 1}. ${s.title}`, '', s.content, ''));
    }
    return lines.join('\n');
}
