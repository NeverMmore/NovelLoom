// 写大纲：根据已知内容（梗概、分卷梗概、章节概要、角色现状、世界设定、前文）按用户要求规划后续章节

import { callLLM, chainFor } from './llm.js';
import { extractJson, removeTags } from './json.js';
import { buildOutlineText, countSourceChapters, getTailText, IMPORTANCE_RANK } from './project.js';
import { getPrompt, render } from './prompts.js';
import { styleTextFor } from './style.js';
import { downloadFile, safeFileName, truncate, uid, uniq } from './utils.js';

export const DETAIL_LEVELS = {
    brief: { label: '简要（每章 80–120 字）', text: '80–120 字' },
    standard: { label: '标准（每章 150–250 字）', text: '150–250 字' },
    detailed: { label: '详细（每章 300–500 字）', text: '300–500 字，写出场景顺序与关键对话要点' },
};

function ensurePlan(project) {
    if (!project.plan) project.plan = { chapters: [], arcs: [] };
    if (!Array.isArray(project.plan.chapters)) project.plan.chapters = [];
    if (!Array.isArray(project.plan.arcs)) project.plan.arcs = [];
    return project.plan;
}

/** 下一章（尚未写）的章号 */
export function nextChapterNo(project) {
    return countSourceChapters(project) + (project.continuation?.chapters?.length || 0) + 1;
}

export function sortedPlan(project) {
    return [...ensurePlan(project).chapters].sort((a, b) => a.no - b.no);
}

/** 某章号对应的、尚未写的规划 */
export function planForChapter(project, no) {
    return ensurePlan(project).chapters.find((c) => c.no === no && c.status !== 'written') || null;
}

export function upcomingPlans(project, afterNo, count = 2) {
    return sortedPlan(project).filter((c) => c.no > afterNo && c.status !== 'written').slice(0, count);
}

export function markPlanWritten(project, planId, writtenId) {
    const c = ensurePlan(project).chapters.find((x) => x.id === planId);
    if (c) {
        c.status = 'written';
        c.writtenId = writtenId;
    }
}

/** 续写章节被删除时，把对应规划恢复为“待写” */
export function unmarkPlanWritten(project, writtenId) {
    for (const c of ensurePlan(project).chapters) {
        if (c.writtenId === writtenId) {
            c.status = 'planned';
            c.writtenId = '';
        }
    }
}

/** 新规划的起始章号：已有规划之后，或下一章 */
export function planStartNo(project) {
    const next = nextChapterNo(project);
    const planned = ensurePlan(project).chapters.filter((c) => c.status !== 'written').map((c) => c.no);
    return Math.max(next, planned.length ? Math.max(...planned) + 1 : next);
}

export function formatPlanChapter(c, { withNo = true } = {}) {
    const lines = [`${withNo ? `第${c.no}章 ` : ''}${c.title || ''}`.trim()];
    if (c.summary) lines.push(`概要：${c.summary}`);
    if (c.pov) lines.push(`本章视角：${c.pov}`);
    if (c.characters?.length) lines.push(`出场：${c.characters.join('、')}`);
    if (c.events?.length) lines.push(`事件：${c.events.join('；')}`);
    if (c.foreshadowing?.length) lines.push(`伏笔：${c.foreshadowing.join('；')}`);
    if (c.scenes?.length) lines.push('场次（按顺序写完）：', ...c.scenes.map((s, i) => `  ${i + 1}. [${s.location || '地点未定'}] 在场：${s.characters?.length ? s.characters.join('、') : '未定'} — ${s.summary}`));
    if (c.hook) lines.push(`章末钩子：${c.hook}`);
    return lines.join('\n');
}

function normScene(s) {
    const list = (v) => uniq(Array.isArray(v) ? v.map(String) : String(v || '').split(/[，,、\n]+/));
    return {
        location: String(s?.location || s?.地点 || '').trim(),
        characters: list(s?.characters || s?.出场 || s?.角色 || []),
        summary: String(s?.summary || s?.概要 || s?.content || '').trim(),
    };
}

function mainCharacters(project, max = 8) {
    return Object.values(project.characters)
        .sort((a, b) => (IMPORTANCE_RANK[b.importance] - IMPORTANCE_RANK[a.importance]) || (b.lastChunk - a.lastChunk) || (b.chunksSeen.length - a.chunksSeen.length))
        .slice(0, max)
        .map((c) => {
            const exps = c.experiences.slice(-2).map((e) => e.text).join('；');
            return `- ${c.name}${c.aliases.length ? `（${c.aliases.slice(0, 2).join('/')}）` : ''}：${c.identity || '身份不明'}；性格：${truncate(c.personality, 50)}；关系：${truncate(c.relationship, 50)}${exps ? `；最近：${truncate(exps, 80)}` : ''}`;
        })
        .join('\n');
}

function worldText(project, settings, maxChars = 2500) {
    const parts = [];
    let used = 0;
    for (const cat of (settings.categories || []).filter((c) => c.enabled && c.constant && c.name !== '角色')) {
        for (const e of Object.values(project.worldbook[cat.name] || {})) {
            const t = `[${cat.name}] ${e.name}：${truncate(e.content.replace(/\s+/g, ' '), 300)}`;
            if (used + t.length > maxChars) break;
            parts.push(t);
            used += t.length;
        }
    }
    return parts.join('\n');
}

function storyText(project, maxChars) {
    const parts = [];
    if (project.outline?.summary) parts.push(`梗概：${project.outline.summary}`);
    const outline = buildOutlineText(project, Infinity, maxChars);
    if (outline) parts.push(outline);
    const gen = project.continuation?.chapters || [];
    // 没有回灌进资料库的续写章节，补上开头节选
    const unfed = gen.filter((g) => !g.chunkId).slice(-3);
    if (unfed.length) parts.push(`已续写章节（节选）：\n${unfed.map((g) => `【${g.title}】${truncate(g.content.replace(/\s+/g, ' '), 200)}`).join('\n')}`);
    return parts.join('\n\n');
}

/** 单次规划的章数上限 */
export const MAX_PLAN_COUNT = 60;

/** 每批章数：0 = 不分批（一次请求规划全部章数） */
export function planBatchSize(settings) {
    const n = Number(settings.planner?.batchSize);
    return Number.isFinite(n) && n > 0 ? Math.min(MAX_PLAN_COUNT, Math.floor(n)) : 0;
}

/** 分批时附在“用户要求”后面的说明（用 {REQUIREMENT} 带进去，自定义提示词模板也能生效） */
function batchNote(b) {
    return `【分批规划】本次总共规划第 ${b.fromNo}–${b.toNo} 章（共 ${b.toNo - b.fromNo + 1} 章），分 ${b.total} 批生成，这是第 ${b.index}/${b.total} 批，只写第 ${b.batchFrom}–${b.batchTo} 章。`
        + '上面的用户要求是针对全部章节的整体安排。'
        + (b.index > 1 ? '前几批已经规划好的章节见「已有的后续规划」，紧接着往下写，不要重复。' : '')
        + (b.index < b.total
            ? '只落实要求里属于这一批的部分，其余留给后续批次，不要把整体的高潮或结局提前塞进这一批。'
            : '这是最后一批：要求里还没落实的部分（包括高潮、结局、要回收的伏笔）都要在这一批完成。');
}

/** 本次规划的分批情况：起止章号、每批章数、批数（不分批时 total = 1） */
export function planBatches(project, settings, opt = {}) {
    const { startNo, count } = buildPlanPrompt(project, settings, opt);
    const size = planBatchSize(settings) || count;
    return { startNo, count, endNo: startNo + count - 1, size, total: Math.ceil(count / size) };
}

/** 某一批的请求参数 */
function batchOpt(opt, b, index, batchFrom) {
    const count = Math.min(b.size, b.endNo - batchFrom + 1);
    const batch = b.total > 1 ? { index, total: b.total, fromNo: b.startNo, toNo: b.endNo, batchFrom, batchTo: batchFrom + count - 1 } : undefined;
    return { ...opt, count, fromNo: batchFrom, batch };
}

/** “预览提示词”：分批时给出第一批实际发送的提示词 */
export function buildPlanPreview(project, settings, opt = {}) {
    const b = planBatches(project, settings, opt);
    const o = b.total > 1 ? batchOpt(opt, b, 1, b.startNo) : opt;
    return { ...buildPlanPrompt(project, settings, o), total: b.total };
}

/**
 * 构建写大纲提示词
 * @param {{count?: number, requirement?: string, detail?: string, fromNo?: number,
 *   batch?: {index:number, total:number, fromNo:number, toNo:number, batchFrom:number, batchTo:number}}} opt
 *   fromNo：从该章起重新规划（覆盖该章及之后尚未写的规划）；batch：分批规划时本批在整体中的位置
 */
export function buildPlanPrompt(project, settings, opt = {}) {
    const ps = settings.planner || {};
    const count = Math.max(1, Math.min(MAX_PLAN_COUNT, Number(opt.count ?? ps.count) || 10));
    const startNo = Number.isFinite(opt.fromNo) ? Math.max(nextChapterNo(project), opt.fromNo) : planStartNo(project);
    const detail = DETAIL_LEVELS[opt.detail || ps.detail] || DETAIL_LEVELS.standard;
    const existing = sortedPlan(project).filter((c) => c.status !== 'written' && c.no < startNo).slice(-10);
    const arcs = ensurePlan(project).arcs.slice(-3);
    const requirement = (opt.requirement ?? ps.requirement ?? '').trim() || '（无特别要求：顺着现有剧情与伏笔自然发展，保持原著风格）';
    const vars = {
        BOOK: project.bookName,
        COUNT: count,
        START_NO: startNo,
        END_NO: startNo + count - 1,
        REQUIREMENT: opt.batch ? `${requirement}\n\n${batchNote(opt.batch)}` : requirement,
        STYLE: styleTextFor(project, settings, 'plan'),
        STORY: storyText(project, Number(ps.contextChars) || 6000) || '（尚未提取章节概要）',
        CHARACTERS: mainCharacters(project) || '（尚无角色资料）',
        WORLD: worldText(project, settings) || '（无）',
        EXISTING: existing.map((c) => formatPlanChapter(c)).join('\n\n') || '（无）',
        ARCS: arcs.map((a) => `- 第${a.fromNo}–${a.toNo}章｜要求：${a.requirement || '无'}｜走向：${String(a.overview || '').replace(/\n+/g, '；')}`).join('\n') || '（无）',
        TAIL: getTailText(project, 1500),
        DETAIL: detail.text,
        SCENE_GUIDE: ps.useScenes
            ? '把每章拆成 3-5 个场次（scenes），每个场次写清地点、在场角色和发生的事；场次要能首尾衔接、按顺序写完就是这一章，覆盖 summary 里的内容，不要漏场景切换'
            : 'scenes 留空数组（未开启场次拆分）',
    };
    return {
        system: render(getPrompt(settings, 'planSystem'), vars),
        prompt: render(getPrompt(settings, 'plan'), vars),
        startNo,
        count,
    };
}

function normPlanChapter(c) {
    const list = (v) => uniq(Array.isArray(v) ? v.map(String) : String(v || '').split(/[；;、,，\n]+/));
    const title = String(c?.title || c?.name || '').replace(/^第\s*[0-9零〇一二两三四五六七八九十百千万]+\s*章\s*/, '').trim();
    return {
        title,
        summary: String(c?.summary || c?.content || c?.概要 || '').trim(),
        characters: list(c?.characters || c?.出场),
        events: list(c?.events || c?.事件),
        foreshadowing: list(c?.foreshadowing || c?.伏笔),
        scenes: Array.isArray(c?.scenes) ? c.scenes.map(normScene).filter((s) => s.location || s.summary) : [],
        hook: String(c?.hook || c?.钩子 || '').trim(),
    };
}

/** 请求一批大纲并解析（不改动项目） */
async function requestPlanBatch(project, settings, opt, { signal, onLog }) {
    const { system, prompt } = buildPlanPrompt(project, settings, opt);
    const res = await callLLM({
        api: settings.api, system, prompt, ...chainFor(settings, 'outline', project), expect: 'json', signal, maxTokens: Math.max(settings.api.maxTokens || 0, 8000),
        onNotice: (m, l) => onLog?.(m, l),
    });
    const raw = removeTags(res.text, settings.extraction.filterTags);
    let json;
    try {
        json = extractJson(raw);
    } catch (e) {
        e.raw = raw;
        throw e;
    }
    const list = (Array.isArray(json) ? json : json.chapters || json.章节 || []).map(normPlanChapter).filter((c) => c.title || c.summary);
    if (!list.length) {
        const err = new Error('AI 没有返回章节大纲');
        err.raw = raw;
        throw err;
    }
    // 分批时只取本批要求的章数，AI 多写的部分丢弃，避免和下一批章号重叠
    return { list: opt.batch ? list.slice(0, opt.count) : list, overview: String(json?.overview || json?.走向 || '').trim() };
}

/**
 * 生成后续章节大纲并写入项目。
 * 章数多时按 settings.planner.batchSize 分批请求：单次请求短，不容易被 API/网络中途断开；
 * 某一批失败时，已完成的批次保留在项目里，抛出的错误带 partial（{arc, chapters}），调用方应保存。
 * @returns {Promise<{arc: object, chapters: object[]}>}
 */
export async function generatePlan(project, settings, opt = {}, { signal, onLog } = {}) {
    const plan = ensurePlan(project);
    const ps = settings.planner || {};
    // 起止章号与分批沿用 planBatches，和“预览提示词”（buildPlanPreview）一致
    const b = planBatches(project, settings, opt);
    const { startNo, count, endNo, total } = b;
    const requirement = (opt.requirement ?? ps.requirement ?? '').trim();
    let arc = null;
    const chapters = [];
    const overviews = [];
    let nextNo = startNo;
    for (let index = 1; index <= total; index++) {
        const bo = batchOpt(opt, b, index, nextNo);
        const batchTo = nextNo + bo.count - 1;
        onLog?.(total > 1
            ? `📝 正在规划第 ${nextNo}–${batchTo} 章的大纲（第 ${index}/${total} 批，共 ${count} 章）…`
            : `📝 正在规划第 ${nextNo}–${batchTo} 章的大纲…`);
        let got;
        try {
            got = await requestPlanBatch(project, settings, bo, { signal, onLog });
        } catch (e) {
            if (arc && e && typeof e === 'object') {
                e.partial = { arc, chapters };
                const done = `已完成并保存第 ${arc.fromNo}–${arc.toNo} 章（${chapters.length} 章）`;
                if (e.name !== 'AbortError') {
                    e.message = `${done}；第 ${index}/${total} 批（第 ${nextNo}–${batchTo} 章）失败：${e.message || e}\n\n再点「生成后续大纲」会从第 ${arc.toNo + 1} 章接着往后规划（可以把「规划章数」改成剩下的 ${endNo - arc.toNo} 章）。`;
                }
                onLog?.(`📝 ${done}，第 ${index}/${total} 批未完成`, 'warn');
            }
            throw e;
        }
        if (!arc) {
            // 第一批成功后才移除旧规划：从某章起重新规划时，覆盖该章及之后尚未写的规划
            plan.chapters = plan.chapters.filter((c) => c.status === 'written' || c.no < startNo);
            arc = { id: uid('arc_'), requirement, overview: '', fromNo: startNo, toNo: startNo - 1, createdAt: Date.now() };
            plan.arcs.push(arc);
        }
        const items = got.list.map((c, i) => ({ id: uid('pl_'), no: nextNo + i, ...c, status: 'planned', writtenId: '', arcId: arc.id, createdAt: Date.now() }));
        plan.chapters.push(...items);
        plan.chapters.sort((a, b) => a.no - b.no);
        chapters.push(...items);
        if (got.overview) overviews.push(total > 1 ? `第${nextNo}–${nextNo + items.length - 1}章：${got.overview}` : got.overview);
        arc.overview = overviews.join('\n');
        arc.toNo = nextNo + items.length - 1;
        nextNo = arc.toNo + 1;
        // AI 少写了章数时，剩下的章号顺延到下一批；已经到最后一批则就此结束
        if (nextNo > endNo) break;
        if (index === total && nextNo <= endNo) onLog?.(`⚠️ AI 只返回了 ${chapters.length}/${count} 章`, 'warn');
    }
    onLog?.(`📝 已规划 ${chapters.length} 章（第 ${arc.fromNo}–${arc.toNo} 章）`, 'success');
    return { arc, chapters };
}

export function buildReviseChapterPrompt(project, settings, chapterId, instruction) {
    const all = sortedPlan(project);
    const cur = all.find((c) => c.id === chapterId);
    if (!cur) throw new Error('找不到这一章的大纲');
    const detail = DETAIL_LEVELS[settings.planner?.detail] || DETAIL_LEVELS.standard;
    const vars = {
        BOOK: project.bookName,
        NO: cur.no,
        INSTRUCTION: instruction?.trim() || '让本章更有冲突和推进，保持与前后章节衔接',
        STORY: truncate(storyText(project, 3000), 3500),
        PREV: all.filter((c) => c.no < cur.no).slice(-3).map((c) => formatPlanChapter(c)).join('\n\n') || '（无）',
        CURRENT: formatPlanChapter(cur),
        NEXT: all.filter((c) => c.no > cur.no).slice(0, 2).map((c) => formatPlanChapter(c)).join('\n\n') || '（无）',
        DETAIL: detail.text,
    };
    return { system: render(getPrompt(settings, 'planSystem'), vars), prompt: render(getPrompt(settings, 'planRevise'), vars), chapter: cur };
}

/** AI 重写某一章的大纲 */
export async function reviseChapterPlan(project, settings, chapterId, instruction, { signal } = {}) {
    const { system, prompt } = buildReviseChapterPrompt(project, settings, chapterId, instruction);
    const res = await callLLM({ api: settings.api, system, prompt, ...chainFor(settings, 'outline', project), expect: 'json', signal });
    const json = extractJson(removeTags(res.text, settings.extraction.filterTags));
    const next = normPlanChapter(json?.chapter || json);
    const target = ensurePlan(project).chapters.find((c) => c.id === chapterId);
    Object.assign(target, next, { updatedAt: Date.now() });
    return target;
}

/** 删除尚未写的规划（不传 fromNo 时全部删除） */
export function clearPlanned(project, fromNo = -Infinity) {
    const plan = ensurePlan(project);
    const before = plan.chapters.length;
    plan.chapters = plan.chapters.filter((c) => c.status === 'written' || c.no < fromNo);
    return before - plan.chapters.length;
}

/** 删除一章规划，并把后面尚未写的规划章号依次前移 */
export function deletePlanChapter(project, id) {
    const plan = ensurePlan(project);
    const cur = plan.chapters.find((c) => c.id === id);
    if (!cur) return;
    plan.chapters = plan.chapters.filter((c) => c.id !== id);
    if (cur.status !== 'written') for (const c of plan.chapters) if (c.status !== 'written' && c.no > cur.no) c.no--;
}

/** 在某章之后插入一章空白规划，后续章号顺延 */
export function insertPlanChapterAfter(project, afterNo) {
    const plan = ensurePlan(project);
    for (const c of plan.chapters) if (c.status !== 'written' && c.no > afterNo) c.no++;
    const ch = { id: uid('pl_'), no: afterNo + 1, title: '新章节', summary: '', characters: [], events: [], foreshadowing: [], scenes: [], hook: '', pov: '', status: 'planned', writtenId: '', createdAt: Date.now() };
    plan.chapters.push(ch);
    plan.chapters.sort((a, b) => a.no - b.no);
    return ch;
}

export function planMarkdown(project) {
    const plan = ensurePlan(project);
    const lines = [`# 《${project.bookName}》后续大纲`, ''];
    for (const a of plan.arcs) lines.push(`> 第${a.fromNo}–${a.toNo}章｜要求：${a.requirement || '无'}`, ...String(a.overview || '').split('\n').map((l) => `> ${l}`), '');
    for (const c of sortedPlan(project)) {
        lines.push(`## 第${c.no}章 ${c.title}${c.status === 'written' ? '（已写）' : ''}`, '');
        if (c.summary) lines.push(c.summary, '');
        if (c.pov) lines.push(`- 本章视角：${c.pov}`);
        if (c.characters?.length) lines.push(`- 出场：${c.characters.join('、')}`);
        if (c.events?.length) lines.push(`- 事件：${c.events.join('；')}`);
        if (c.foreshadowing?.length) lines.push(`- 伏笔：${c.foreshadowing.join('；')}`);
        if (c.scenes?.length) {
            lines.push('- 场次：');
            c.scenes.forEach((s, i) => lines.push(`  ${i + 1}. [${s.location || '地点未定'}] ${s.characters?.length ? s.characters.join('、') : '未定'} — ${s.summary}`));
        }
        if (c.hook) lines.push(`- 章末钩子：${c.hook}`);
        lines.push('');
    }
    return lines.join('\n');
}

export function exportPlan(project) {
    downloadFile(planMarkdown(project), `${safeFileName(project.bookName)}-后续大纲.md`, 'text/markdown');
}
