// 伏笔看板：结构化追踪全书伏笔的埋下与回收状态；AI 从各章大纲的「伏笔」字段整理，也可手动增删改
// 现状：写大纲时 foreshadowing 只是每章一份自由文本列表，混合记录埋下与回收，没有总表告诉你现在挂着几条、埋了多少章——这里把它结构化。

import { callLLM, chainFor } from './llm.js';
import { extractJson, removeTags } from './json.js';
import { getPrompt, render } from './prompts.js';
import { nextChapterNo, sortedPlan } from './planner.js';
import { normalizeForMatch, uid } from './utils.js';

export function ensureForeshadow(project) {
    if (!Array.isArray(project.foreshadow)) project.foreshadow = [];
    return project.foreshadow;
}

function toChapterNo(v) {
    if (v === null || v === undefined || v === '') return null;
    const n = Number.isFinite(v) ? v : Number(v);
    return Number.isFinite(n) ? n : null;
}

export function normalizeForeshadowItem(f = {}) {
    return {
        id: f.id || uid('fs_'),
        text: String(f.text || '').trim(),
        status: f.status === 'resolved' ? 'resolved' : 'open',
        plantedNo: toChapterNo(f.plantedNo),
        resolvedNo: toChapterNo(f.resolvedNo),
        notes: String(f.notes || '').trim(),
        auto: !!f.auto,
        createdAt: f.createdAt || Date.now(),
        updatedAt: f.updatedAt || Date.now(),
    };
}

// ---------------- CRUD ----------------

export function addForeshadowItem(project, data) {
    const list = ensureForeshadow(project);
    const f = normalizeForeshadowItem({ ...data, id: '' });
    if (!f.text) throw new Error('请填写伏笔内容');
    list.push(f);
    return f;
}

export function updateForeshadowItem(project, id, patch) {
    const list = ensureForeshadow(project);
    const f = list.find((x) => x.id === id);
    if (!f) return null;
    const next = normalizeForeshadowItem({ ...f, ...patch, id });
    Object.assign(f, next, { updatedAt: Date.now() });
    return f;
}

/** 标记已回收（默认回收于最新已写章节） */
export function resolveForeshadowItem(project, id, resolvedNo) {
    const no = Number.isFinite(resolvedNo) ? resolvedNo : Math.max(1, nextChapterNo(project) - 1);
    return updateForeshadowItem(project, id, { status: 'resolved', resolvedNo: no });
}

export function reopenForeshadowItem(project, id) {
    return updateForeshadowItem(project, id, { status: 'open', resolvedNo: null });
}

export function removeForeshadowItem(project, id) {
    const list = ensureForeshadow(project);
    const n = list.length;
    project.foreshadow = list.filter((x) => x.id !== id);
    return project.foreshadow.length !== n;
}

/** 这条伏笔已经挂了多少章还没回收（当前最新已写章节 - 埋下章节 + 1）；信息不足时返回 null */
export function chaptersOpenFor(project, item) {
    if (item.status !== 'open' || !Number.isFinite(item.plantedNo)) return null;
    const latest = Math.max(0, nextChapterNo(project) - 1);
    if (latest < item.plantedNo) return 0;
    return latest - item.plantedNo + 1;
}

// ---------------- AI 分析 ----------------

function chaptersText(project, maxChars = 8000) {
    const chapters = sortedPlan(project).filter((c) => c.foreshadowing?.length);
    const parts = [];
    let used = 0;
    for (const c of chapters) {
        const t = `第${c.no}章${c.title ? ` ${c.title}` : ''}：${c.foreshadowing.join('；')}`;
        if (used + t.length > maxChars) break;
        parts.push(t);
        used += t.length;
    }
    return parts.join('\n');
}

function existingText(project) {
    const list = ensureForeshadow(project);
    if (!list.length) return '（无）';
    return list
        .map((f) => `- 「${f.text}」：${f.status === 'resolved' ? `已在第${f.resolvedNo ?? '?'}章回收` : `第${Number.isFinite(f.plantedNo) ? f.plantedNo : '?'}章埋下，尚未回收`}`)
        .join('\n');
}

/**
 * 合并 AI（或导入）结果：按归一化文本匹配已有条目并更新状态；找不到匹配的新增
 * @returns {{added:number, updated:number}}
 */
export function mergeForeshadowItems(project, items) {
    const list = ensureForeshadow(project);
    let added = 0;
    let updated = 0;
    for (const it of items || []) {
        const text = String(it.text || it.伏笔 || '').trim();
        if (!text) continue;
        const key = normalizeForMatch(text);
        const existing = list.find((f) => normalizeForMatch(f.text) === key);
        const incoming = normalizeForeshadowItem(it);
        if (existing) {
            if (existing.status !== incoming.status || (incoming.status === 'resolved' && existing.resolvedNo !== incoming.resolvedNo)) {
                existing.status = incoming.status;
                if (Number.isFinite(incoming.plantedNo) && !Number.isFinite(existing.plantedNo)) existing.plantedNo = incoming.plantedNo;
                if (incoming.status === 'resolved') existing.resolvedNo = incoming.resolvedNo;
                existing.updatedAt = Date.now();
                updated++;
            }
        } else {
            list.push({ ...incoming, auto: true });
            added++;
        }
    }
    return { added, updated };
}

/** AI 从各章大纲的「伏笔」字段整理出结构化看板 */
export async function analyzeForeshadowing(project, settings, { signal, onLog } = {}) {
    const chapters = chaptersText(project);
    if (!chapters) throw new Error('大纲里还没有记录伏笔：在「写大纲」页给章节填写「伏笔」字段后再试');
    const vars = { BOOK: project.bookName, CHAPTERS: chapters, EXISTING: existingText(project) };
    const res = await callLLM({
        api: settings.api,
        system: render(getPrompt(settings, 'foreshadowSystem'), vars),
        prompt: render(getPrompt(settings, 'foreshadow'), vars),
        ...chainFor(settings, 'tools', project),
        expect: 'json',
        signal,
        onNotice: (m, l) => onLog?.(m, l),
    });
    const json = extractJson(removeTags(res.text, settings.extraction?.filterTags));
    const list = Array.isArray(json?.items) ? json.items : [];
    return mergeForeshadowItems(project, list);
}

// ---------------- 导出 ----------------

export function foreshadowMarkdown(project) {
    const list = ensureForeshadow(project);
    if (!list.length) return '';
    const lines = ['## 伏笔看板', '', '| 伏笔 | 状态 | 埋下 | 回收 |', '| --- | --- | --- | --- |'];
    for (const f of list) {
        lines.push(`| ${f.text.replace(/\|/g, '/')} | ${f.status === 'resolved' ? '已回收' : '未回收'} | ${Number.isFinite(f.plantedNo) ? `第${f.plantedNo}章` : '未知'} | ${Number.isFinite(f.resolvedNo) ? `第${f.resolvedNo}章` : '—'} |`);
    }
    return lines.join('\n');
}

export function exportForeshadowJson(project) {
    return {
        type: 'novelloom-foreshadow',
        version: 1,
        book: project.bookName,
        items: ensureForeshadow(project).map((f) => ({ text: f.text, status: f.status, plantedNo: f.plantedNo, resolvedNo: f.resolvedNo, notes: f.notes })),
    };
}

export function parseForeshadowJson(json) {
    const list = Array.isArray(json) ? json : Array.isArray(json?.items) ? json.items : [];
    return list.filter((f) => f && String(f.text || '').trim()).map((f) => normalizeForeshadowItem(f));
}
