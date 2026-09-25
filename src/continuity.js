// 连续性检查：续写完一章后，核对正文有没有和已建立的角色档案、世界设定打架
// （角色说了不该知道的事、物品/设定前后矛盾、言行违背既有性格、时间线不合理）——现在完全靠人工发现，这里让 AI 按已知资料核对一遍。

import { callLLM, chainFor } from './llm.js';
import { extractJson, removeTags } from './json.js';
import { getPrompt, render } from './prompts.js';
import { characterAt, characterProfileText, entryAt, IMPORTANCE_RANK } from './project.js';
import { truncate } from './utils.js';

const ISSUE_TYPES = {
    knowledge: '知道了不该知道的事',
    fact: '设定/描述前后矛盾',
    character: '言行违背既有性格',
    timeline: '时间线不合理',
    other: '其他',
};

export function issueTypeLabel(v) {
    return ISSUE_TYPES[v] || ISSUE_TYPES.other;
}

/**
 * 这一章核对时应该使用的“已知资料”时间点（分块序号）。
 * 已回灌：用回灌所在分块的前一段，避免这一章自己贡献的资料污染核对基准；
 * 未回灌：用当前状态即可——角色和世界书都还没被这一章更新过。
 */
function timepointFor(project, chapter) {
    if (chapter.chunkId) {
        const idx = project.chunks.findIndex((c) => c.id === chapter.chunkId);
        if (idx >= 0) return idx - 1;
    }
    return Infinity;
}

function relevantContext(project, settings, text, uptoChunk, maxChars = 5000) {
    const parts = [];
    let used = 0;
    const push = (t) => {
        if (!t || used + t.length > maxChars) return false;
        parts.push(t);
        used += t.length;
        return true;
    };
    const chars = Object.values(project.characters)
        .filter((c) => c.firstChunk <= uptoChunk && [c.name, ...c.aliases].some((n) => n && text.includes(n)))
        .sort((a, b) => IMPORTANCE_RANK[b.importance] - IMPORTANCE_RANK[a.importance]);
    for (const c of chars) push(`[角色]\n${characterProfileText(characterAt(c, uptoChunk), { maxExperiences: 6, maxQuotes: 3, withDialogues: false })}`);
    const cats = (settings.categories || []).filter((c) => c.enabled && c.name !== '角色');
    for (const cat of cats) {
        for (const e of Object.values(project.worldbook[cat.name] || {})) {
            const content = entryAt(e, uptoChunk);
            if (!content) continue;
            const mentioned = [e.name, ...(e.keywords || [])].some((k) => k && text.includes(k));
            if (!cat.constant && !mentioned) continue;
            push(`[${cat.name}] ${e.name}：${truncate(content, 300)}`);
        }
    }
    return parts.join('\n\n') || '（没有匹配到相关的已知设定，只能核对文本内部是否自相矛盾）';
}

export function buildContinuityPrompt(project, settings, chapter) {
    const uptoChunk = timepointFor(project, chapter);
    const vars = {
        BOOK: project.bookName,
        CHAPTER_TITLE: chapter.title,
        CONTEXT: relevantContext(project, settings, chapter.content, uptoChunk),
        TEXT: chapter.content,
    };
    return {
        system: render(getPrompt(settings, 'continuitySystem'), vars),
        prompt: render(getPrompt(settings, 'continuity'), vars),
    };
}

export function normalizeIssue(x) {
    return {
        type: ISSUE_TYPES[x?.type] ? x.type : 'other',
        severity: ['high', 'medium', 'low'].includes(x?.severity) ? x.severity : 'medium',
        quote: String(x?.quote || x?.原文 || '').trim(),
        problem: String(x?.problem || x?.问题 || '').trim(),
        evidence: String(x?.evidence || x?.依据 || '').trim(),
    };
}

/**
 * AI 核对一章续写正文是否与已建立设定矛盾；结果保存在 chapter.continuityCheck 上
 * @returns {Promise<ReturnType<typeof normalizeIssue>[]>}
 */
export async function checkContinuity(project, settings, chapterId, { signal, onLog } = {}) {
    const chapter = project.continuation.chapters.find((c) => c.id === chapterId);
    if (!chapter) throw new Error('找不到这一章');
    if (!chapter.content?.trim()) throw new Error('这一章还没有正文');
    const { system, prompt } = buildContinuityPrompt(project, settings, chapter);
    const res = await callLLM({
        api: settings.api,
        system,
        prompt,
        ...chainFor(settings, 'tools', project),
        expect: 'json',
        signal,
        onNotice: (m, l) => onLog?.(m, l),
    });
    const json = extractJson(removeTags(res.text, settings.extraction?.filterTags));
    const issues = (Array.isArray(json?.issues) ? json.issues : []).map(normalizeIssue).filter((i) => i.problem);
    chapter.continuityCheck = { issues, checkedAt: Date.now() };
    return issues;
}
