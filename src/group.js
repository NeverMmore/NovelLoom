// 群聊/多人场景卡：基于已确立的人物关系，为多个角色生成一段可放进同一个 ST 群聊的开场情境，
// 并把这几个角色已经写入酒馆的卡片拉进一个新建（或更新）的群聊。

import { worldContext } from './cards.js';
import { callLLM, chainFor } from './llm.js';
import { extractJson, removeTags } from './json.js';
import { characterAt, characterProfileText } from './project.js';
import { getPrompt, render, WRITING_RULES } from './prompts.js';
import { relationLine, relationsAt } from './relations.js';
import { createGroupInST, updateGroupInST } from './stio.js';
import { uid } from './utils.js';

/** 群聊里两两之间已确立的关系（去重：A-B 只显示一次） */
function pairRelations(project, names, upto) {
    const set = new Set(names);
    const seen = new Set();
    const lines = [];
    for (const r of relationsAt(project, upto)) {
        if (!set.has(r.from) || !set.has(r.to)) continue;
        const key = [r.from, r.to].sort().join('\u0001');
        if (seen.has(key)) continue;
        seen.add(key);
        const line = relationLine(project, r.from, r.to, r, upto);
        if (line) lines.push(line);
    }
    return lines.join('\n') || '（没有已确立的明确关系，按角色各自的性格自然互动）';
}

export function buildGroupPrompt(project, settings, opt = {}) {
    const upto = Number.isFinite(opt.timepoint) ? opt.timepoint : Infinity;
    const names = opt.names || [];
    const chars = names.map((n) => project.characters[n]).filter(Boolean);
    if (chars.length < 2) throw new Error('至少选择两个角色');
    const profiles = chars.map((c) => characterProfileText(characterAt(c, upto), { maxExperiences: 6, maxQuotes: 3 })).join('\n---\n');
    const vars = {
        BOOK: project.bookName,
        TIMEPOINT: Number.isFinite(upto) && upto < project.chunks.length - 1 ? `第 ${upto + 1} 段结束时` : '全书结束时',
        PROFILES: profiles,
        RELATIONS: pairRelations(project, names, upto),
        WORLD: worldContext(project, settings, profiles, upto),
        REQUIREMENT: opt.requirement?.trim() || '（无特别要求，自然设计一个这几个角色会同时在场的场景）',
        FIRST_MES_LEN: opt.firstMesLen || '300-600 字',
        WRITING_RULES,
    };
    return {
        system: render(getPrompt(settings, 'groupSystem'), vars),
        prompt: render(getPrompt(settings, 'group'), vars),
        names: chars.map((c) => c.name),
    };
}

/**
 * AI 生成群聊场景（scenario / first_mes / 每个角色在这场戏里的处境）
 * @returns {Promise<object>} groupCard 记录
 */
export async function generateGroupCard(project, settings, opt, { signal, onLog } = {}) {
    const { system, prompt, names } = buildGroupPrompt(project, settings, opt);
    onLog?.(`👥 正在为「${names.join('、')}」设计群聊场景…`);
    const res = await callLLM({
        api: settings.api, system, prompt, ...chainFor(settings, 'card', project), expect: 'json', signal,
        onNotice: (m, l) => onLog?.(`群聊场景：${m}`, l),
    });
    const raw = removeTags(res.text, settings.extraction.filterTags);
    let json;
    try {
        json = extractJson(raw);
    } catch (e) {
        e.raw = raw;
        throw e;
    }
    const notes = json?.notes && typeof json.notes === 'object' ? json.notes : {};
    return {
        id: uid('grp_'),
        name: `${names.join('、')} · 群聊`,
        members: names,
        timepoint: Number.isFinite(opt.timepoint) ? opt.timepoint : null,
        requirement: opt.requirement || '',
        data: {
            scenario: String(json?.scenario || '').trim(),
            first_mes: String(json?.first_mes || '').trim(),
            notes: Object.fromEntries(names.map((n) => [n, String(notes[n] || '').trim()])),
        },
        createdAt: Date.now(),
        updatedAt: Date.now(),
        stGroupId: '',
    };
}

/** 群聊场景导出为 Markdown（复制粘贴到酒馆群聊的第一条消息/作者注释里用） */
export function groupCardMarkdown(groupCard) {
    const d = groupCard.data;
    const lines = [`# ${groupCard.name}`, ''];
    if (d.scenario) lines.push('## 场景', d.scenario, '');
    if (d.first_mes) lines.push('## 开场白', d.first_mes, '');
    const noteLines = Object.entries(d.notes || {}).filter(([, v]) => v);
    if (noteLines.length) {
        lines.push('## 各角色在这场戏里的处境');
        for (const [n, v] of noteLines) lines.push(`- **${n}**：${v}`);
    }
    return lines.join('\n');
}

/**
 * 把群聊场景涉及的角色写入酒馆群聊：要求每个角色都已经有写入过酒馆的角色卡（能拿到 avatar 文件名）
 * @param {(name:string) => string} resolveAvatar 角色名 → 该角色已写入酒馆的 avatar 文件名（不含 .png），没有则返回空字符串
 * @returns {Promise<string>} 群组 id
 */
export async function publishGroupCard(groupCard, resolveAvatar) {
    const missing = groupCard.members.filter((n) => !resolveAvatar(n));
    if (missing.length) throw new Error(`以下角色还没有写入酒馆，请先在「角色卡」页把他们的卡写入酒馆：${missing.join('、')}`);
    const members = groupCard.members.map((n) => `${resolveAvatar(n)}.png`);
    if (groupCard.stGroupId) {
        await updateGroupInST({ id: groupCard.stGroupId, name: groupCard.name, members });
        return groupCard.stGroupId;
    }
    const id = await createGroupInST({
        name: groupCard.name,
        members,
        allow_self_responses: false,
        activation_strategy: 0, // NATURAL
        generation_mode: 0, // SWAP
        disabled_members: [],
        chat_metadata: {},
        fav: false,
        chat_id: String(Date.now()),
        chats: [String(Date.now())],
        auto_mode_delay: 5,
    });
    groupCard.stGroupId = id;
    groupCard.publishedAt = Date.now();
    return id;
}
