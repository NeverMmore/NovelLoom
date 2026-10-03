// 剧情推演：根据角色卡当前的实际内容（而不是原著后续大纲）+ 相关世界书/人物背景，
// 先给出几个并列的可能走向，用户选定其中一个或几个后，再推演出具体的分阶段发展。
// 结果挂在卡片自己身上（card.plotProjection），不写回卡片字段，也不写入 project.plan。

import { buildCardPrompt } from './cards.js';
import { extractJson, removeTags } from './json.js';
import { callLLM, chainFor } from './llm.js';
import { WRITING_RULES, getPrompt, render } from './prompts.js';
import { uid, uniq } from './utils.js';

export const DEFAULT_BRANCH_COUNT = 3;

/** 确保 card.plotProjection 结构完整，返回它本身（可直接修改） */
export function ensureProjection(card) {
    if (!card.plotProjection || typeof card.plotProjection !== 'object') {
        card.plotProjection = { branches: [], selectedBranchIds: [], stages: [], branchesUpdatedAt: 0, stagesUpdatedAt: 0 };
    }
    const pp = card.plotProjection;
    if (!Array.isArray(pp.branches)) pp.branches = [];
    if (!Array.isArray(pp.selectedBranchIds)) pp.selectedBranchIds = [];
    if (!Array.isArray(pp.stages)) pp.stages = [];
    return pp;
}

function cardContentText(card) {
    const d = card.data;
    return [
        `姓名：${d.name}`,
        d.description ? `描述：${d.description}` : '',
        d.personality ? `性格摘要：${d.personality}` : '',
        d.scenario ? `场景：${d.scenario}` : '',
        d.first_mes ? `开场白：${d.first_mes}` : '',
        d.mes_example ? `示例对话：${d.mes_example}` : '',
        d.system_prompt ? `系统提示词：${d.system_prompt}` : '',
    ].filter(Boolean).join('\n\n');
}

/** 复用写卡提示词的完整输出（人物设定/相关角色/世界观/大纲/文风）作为背景参考，不重复实现一遍上下文收集 */
function backgroundContext(project, settings, card) {
    const opt = {
        kind: card.kind,
        charName: card.charName,
        timepoint: Number.isFinite(card.timepoint) ? card.timepoint : Infinity,
        requirement: card.requirement,
        greetings: card.data.alternate_greetings.length,
    };
    const { system, prompt } = buildCardPrompt(project, settings, opt);
    return `${system}\n\n${prompt}`;
}

// ---------------- 走向模板（保存在扩展设置里，跨项目共享） ----------------

/** 保存的是"大方向点子"（标题+简短说明），套用到某张卡的走向槽位时由 AI 结合这张卡的具体设定重新展开，不是原样照抄 */
export function branchTemplates(settings) {
    const list = Array.isArray(settings?.branchTemplates) ? settings.branchTemplates : [];
    return list.filter((t) => t?.label).map((t) => ({ id: String(t.id), label: String(t.label), hint: String(t.hint || t.label), createdAt: t.createdAt || 0 }));
}

export function addBranchTemplate(settings, { label, hint } = {}) {
    if (!Array.isArray(settings.branchTemplates)) settings.branchTemplates = [];
    const lbl = String(label || '').trim();
    if (!lbl) throw new Error('请输入模板名称');
    if (branchTemplates(settings).some((t) => t.label === lbl)) throw new Error('已存在同名的模板');
    const t = { id: uid('btpl_'), label: lbl, hint: String(hint || lbl).trim() || lbl, createdAt: Date.now() };
    settings.branchTemplates.push(t);
    return t;
}

export function updateBranchTemplate(settings, id, patch = {}) {
    const t = (settings.branchTemplates || []).find((x) => x.id === id);
    if (!t) return null;
    if (patch.label !== undefined) {
        const lbl = String(patch.label).trim();
        if (lbl) t.label = lbl;
    }
    if (patch.hint !== undefined) t.hint = String(patch.hint).trim() || t.label;
    return t;
}

export function removeBranchTemplate(settings, id) {
    if (!Array.isArray(settings.branchTemplates)) return false;
    const n = settings.branchTemplates.length;
    settings.branchTemplates = settings.branchTemplates.filter((t) => t.id !== id);
    return settings.branchTemplates.length !== n;
}

/** 把每条走向的方向提示（可能有空槽位，表示"不限方向"）渲染成提示词里的一段列表 */
export function directionsText(directions) {
    return directions
        .map((d, i) => `${i + 1}. ${String(d || '').trim() || '（不限方向，由你自由发挥，但要和其他几条有明显区别）'}`)
        .join('\n');
}

/**
 * @param {string[]} opt.directions 每条走向的方向提示，按顺序对应生成结果；留空字符串表示该条不限方向。
 *   不传时退化为 opt.count 个空槽位（全部不限方向），用于兼容只要"生成 N 条走向"而不干预方向的旧调用方式。
 */
export function buildBranchesPrompt(project, settings, card, { count = DEFAULT_BRANCH_COUNT, instruction = '', directions = [] } = {}) {
    const dirs = directions.length ? directions : new Array(Math.max(2, Math.min(6, Number(count) || DEFAULT_BRANCH_COUNT))).fill('');
    const vars = {
        CARD_CONTENT: cardContentText(card),
        CONTEXT: backgroundContext(project, settings, card),
        COUNT: dirs.length,
        DIRECTIONS: directionsText(dirs),
        INSTRUCTION_LINE: instruction.trim() ? `整体额外要求（对每条走向都适用）：${instruction.trim()}` : '',
        WRITING_RULES,
    };
    return {
        system: render(getPrompt(settings, 'deduceBranchesSystem'), vars),
        prompt: render(getPrompt(settings, 'deduceBranches'), vars),
    };
}

export function normBranch(b) {
    return {
        id: uid('branch_'),
        title: String(b?.title || b?.标题 || '').trim(),
        summary: String(b?.summary || b?.概要 || b?.content || '').trim(),
        createdAt: Date.now(),
    };
}

/** 生成/重新生成并列走向：整体替换现有走向，并清空已选中状态（旧的选择对新走向没有意义）
 *  directions 为每条走向的方向提示（见 buildBranchesPrompt），用于支持"干预走向"：用户可以给每条走向单独写方向，
 *  或者套用一个已保存的模板的 hint，留空的槽位则不限方向、由 AI 自由发挥。 */
export async function generateBranches(project, settings, card, { signal, count = DEFAULT_BRANCH_COUNT, instruction = '', directions = [] } = {}) {
    const pp = ensureProjection(card);
    const { system, prompt } = buildBranchesPrompt(project, settings, card, { count, instruction, directions });
    const res = await callLLM({
        api: settings.api, system, prompt, ...chainFor(settings, 'card', project), expect: 'json', signal,
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
    return pp.branches;
}

export function addBranch(card, { title = '', summary = '' } = {}) {
    const pp = ensureProjection(card);
    const b = { id: uid('branch_'), title: String(title).trim(), summary: String(summary).trim(), createdAt: Date.now() };
    pp.branches.push(b);
    pp.branchesUpdatedAt = Date.now();
    return b;
}

export function updateBranch(card, id, patch = {}) {
    const pp = ensureProjection(card);
    const b = pp.branches.find((x) => x.id === id);
    if (!b) return null;
    if (patch.title !== undefined) b.title = String(patch.title).trim();
    if (patch.summary !== undefined) b.summary = String(patch.summary).trim();
    pp.branchesUpdatedAt = Date.now();
    return b;
}

export function removeBranch(card, id) {
    const pp = ensureProjection(card);
    pp.branches = pp.branches.filter((x) => x.id !== id);
    pp.selectedBranchIds = pp.selectedBranchIds.filter((x) => x !== id);
    pp.branchesUpdatedAt = Date.now();
}

/** 设置当前选中的走向（可多选）；自动过滤掉不存在的 id */
export function setSelectedBranches(card, ids) {
    const pp = ensureProjection(card);
    const valid = new Set(pp.branches.map((b) => b.id));
    pp.selectedBranchIds = uniq(ids).filter((id) => valid.has(id));
    return pp.selectedBranchIds;
}

export function buildStagesPrompt(project, settings, card, { instruction = '' } = {}) {
    const pp = ensureProjection(card);
    const selected = pp.branches.filter((b) => pp.selectedBranchIds.includes(b.id));
    if (!selected.length) throw new Error('请先至少选择一个剧情走向');
    const vars = {
        CARD_CONTENT: cardContentText(card),
        CONTEXT: backgroundContext(project, settings, card),
        BRANCHES: selected.map((b, i) => `${i + 1}. ${b.title}\n${b.summary}`).join('\n\n'),
        INSTRUCTION_LINE: instruction.trim() ? `额外要求：${instruction.trim()}` : '',
        WRITING_RULES,
    };
    return {
        system: render(getPrompt(settings, 'deduceStagesSystem'), vars),
        prompt: render(getPrompt(settings, 'deduceStages'), vars),
    };
}

export function normStage(s) {
    return {
        id: uid('stage_'),
        title: String(s?.title || s?.标题 || '').trim(),
        content: String(s?.content || s?.summary || s?.内容 || '').trim(),
        createdAt: Date.now(),
        updatedAt: Date.now(),
    };
}

/** 生成/重新生成分阶段推演：需要先选中至少一个走向；整体替换现有阶段 */
export async function generateStages(project, settings, card, { signal, instruction = '' } = {}) {
    const pp = ensureProjection(card);
    const { system, prompt } = buildStagesPrompt(project, settings, card, { instruction });
    const res = await callLLM({
        api: settings.api, system, prompt, ...chainFor(settings, 'card', project), expect: 'json', signal,
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
    return pp.stages;
}

export function addStage(card, { title = '', content = '' } = {}) {
    const pp = ensureProjection(card);
    const s = { id: uid('stage_'), title: String(title).trim(), content: String(content).trim(), createdAt: Date.now(), updatedAt: Date.now() };
    pp.stages.push(s);
    pp.stagesUpdatedAt = Date.now();
    return s;
}

export function updateStage(card, id, patch = {}) {
    const pp = ensureProjection(card);
    const s = pp.stages.find((x) => x.id === id);
    if (!s) return null;
    if (patch.title !== undefined) s.title = String(patch.title).trim();
    if (patch.content !== undefined) s.content = String(patch.content).trim();
    s.updatedAt = Date.now();
    pp.stagesUpdatedAt = Date.now();
    return s;
}

export function removeStage(card, id) {
    const pp = ensureProjection(card);
    pp.stages = pp.stages.filter((x) => x.id !== id);
    pp.stagesUpdatedAt = Date.now();
}

export function deductionMarkdown(card) {
    const pp = ensureProjection(card);
    const lines = [`# ${card.data.name} · 剧情推演`, ''];
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
