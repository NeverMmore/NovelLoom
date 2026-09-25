// API 续写：基于大纲、世界书与前文，逐章续写新内容；可选“边写边回灌”到资料库

import { callLLM, chainFor } from './llm.js';
import { removeTags } from './json.js';
import { applyExtraction, buildOutlineText, characterProfileText, countSourceChapters, getTailText, IMPORTANCE_RANK } from './project.js';
import { extractChunk, knownContextFor } from './extract.js';
import { getPrompt, render } from './prompts.js';
import { formatPlanChapter, markPlanWritten, planForChapter, upcomingPlans } from './planner.js';
import { bannedListFor, checkBanned, fixBannedInText, replaceBanned, styleOptions, styleTextFor } from './style.js';
import { isAbortError, truncate, uid } from './utils.js';

export { countSourceChapters, getTailText };

function relevantWorld(project, settings, focus, maxChars = 4000) {
    const parts = [];
    let used = 0;
    const push = (t) => {
        if (used + t.length > maxChars) return false;
        parts.push(t);
        used += t.length;
        return true;
    };
    const cats = settings.categories || [];
    for (const cat of cats.filter((c) => c.enabled && c.constant && c.name !== '角色')) {
        for (const e of Object.values(project.worldbook[cat.name] || {})) push(`[${cat.name}] ${e.name}：${truncate(e.content, 400)}`);
    }
    const chars = Object.values(project.characters)
        .filter((c) => [c.name, ...c.aliases].some((n) => n && focus.includes(n)))
        .sort((a, b) => IMPORTANCE_RANK[b.importance] - IMPORTANCE_RANK[a.importance]);
    for (const c of chars) push(`[角色]\n${characterProfileText(c, { maxExperiences: 4, maxQuotes: 3 })}`);
    for (const cat of cats.filter((c) => c.enabled && !c.constant && c.name !== '角色')) {
        for (const e of Object.values(project.worldbook[cat.name] || {})) {
            if ([e.name, ...(e.keywords || [])].some((k) => k && focus.includes(k))) push(`[${cat.name}] ${e.name}：${truncate(e.content, 400)}`);
        }
    }
    return parts.join('\n\n') || '（无）';
}

export function buildContinuePrompt(project, settings, { title, words, direction, plan = null, upcoming = [] }) {
    const cs = settings.continuation;
    const tail = getTailText(project, Number(cs.tailChars) || 3000);
    const vars = {
        BOOK: project.bookName,
        CHAPTER_TITLE: title,
        WORDS: words,
        // 大纲指定了本章视角角色时，优先用该角色在「多视角管理」里映射的文风（未映射则回退到续写任务的默认文风）
        STYLE: styleTextFor(project, settings, 'continue', plan?.pov),
        OUTLINE: [project.outline.summary && `梗概：${project.outline.summary}`, buildOutlineText(project, Infinity, 3000)].filter(Boolean).join('\n\n') || '（无）',
        WORLD: cs.useWorldbook ? relevantWorld(project, settings, `${tail}\n${direction || ''}`) : '（未启用）',
        DIRECTION: direction || (plan ? '按本章大纲推进。' : '顺着前文自然推进，制造新的冲突或进展。'),
        PLAN: plan
            ? `\n# 本章大纲（按此写）\n${formatPlanChapter(plan, { withNo: false })}\n${upcoming.length ? `\n# 后续章节大纲（只用于铺垫，不要提前写）\n${upcoming.map((c) => formatPlanChapter(c)).join('\n\n')}\n` : ''}`
            : '',
        TAIL: tail,
    };
    const template = getPrompt(settings, 'continue');
    let prompt = render(template, vars);
    // 旧的自定义模板没有 {PLAN} 占位符时，把大纲附在末尾
    if (plan && !template.includes('{PLAN}')) prompt += `\n${vars.PLAN}`;
    return {
        system: render(getPrompt(settings, 'continueSystem'), vars),
        prompt,
    };
}

function cleanChapter(text, title, filterTags) {
    let t = removeTags(text, filterTags).replace(/^```[a-z]*\n?|```$/g, '').trim();
    t = t.replace(/[（(]?未完待续[）)]?\s*$/, '').trim();
    const head = title.split(/\s/)[0];
    if (!t.startsWith(head)) t = `${title}\n\n${t}`;
    return t;
}

/**
 * 重roll：重新生成某一章已写好的续写正文（沿用原来的编号/大纲/方向/字数），就地替换。
 * 不会重新跑“回灌”（提取）流程——如果这一章已经回灌过，会把对应分段内容同步更新并标记为待提取，
 * 可以在「提取」/「分段」页用“重提”按原来的方式重新提取，避免这里悄悄重复一遍提取逻辑。
 */
export async function regenerateChapter(project, settings, chapterId, { signal, onLog, direction } = {}) {
    const chapter = project.continuation.chapters.find((c) => c.id === chapterId);
    if (!chapter) throw new Error('章节不存在');
    const cs = settings.continuation;
    const api = settings.continueApi?.enabled ? settings.continueApi : settings.api;
    const words = Math.max(300, chapter.content.length || Number(cs.wordsPerChapter) || 3000);
    const plan = cs.followPlan !== false ? planForChapter(project, chapter.no) : null;
    const upcoming = plan ? upcomingPlans(project, chapter.no, 2) : [];
    const dir = direction !== undefined ? direction : chapter.direction;
    const { system, prompt } = buildContinuePrompt(project, settings, { title: chapter.title, words, direction: dir, plan, upcoming });
    onLog?.(`🎲 正在重新生成「${chapter.title}」…`);
    const res = await callLLM({
        api,
        system,
        prompt,
        ...chainFor(settings, 'continue', project),
        expect: 'prose',
        signal,
        onNotice: (m, l) => onLog?.(`${chapter.title}：${m}`, l),
        maxTokens: Math.max(api.maxTokens || 0, Math.ceil(words * 2.2)),
    });
    let content = cleanChapter(res.text, chapter.title, settings.extraction.filterTags);
    if (content.length < Math.min(200, words * 0.2)) throw new Error(`生成内容过短（${content.length} 字），已取消`);
    const opt = styleOptions(settings);
    if (opt.checkContinuation) {
        const hits = checkBanned(content, project, settings, 'continue', plan?.pov);
        if (hits.length) {
            if (opt.fixMode === 'replace') {
                const r = replaceBanned(content, bannedListFor(project, settings, 'continue', plan?.pov));
                if (r.count) content = r.text;
            } else if (opt.fixMode === 'ai') {
                try {
                    content = await fixBannedInText(content, hits, project, settings, { signal, api, povChar: plan?.pov });
                } catch (e) {
                    if (isAbortError(e)) throw e;
                    onLog?.(`⚠️ AI 改写禁用词失败：${e.message}（保留原文）`, 'warn');
                }
            }
        }
    }
    chapter.content = content;
    chapter.direction = dir || '';
    chapter.continuityCheck = null;
    if (chapter.chunkId) {
        const chunk = project.chunks.find((c) => c.id === chapter.chunkId);
        if (chunk) {
            chunk.content = content;
            chunk.charCount = content.length;
            chunk.end = content.length;
            chunk.status = 'pending';
            chunk.error = '';
            chunk.processedAt = 0;
        }
    }
    return chapter;
}

export class ContinuationRunner {
    constructor({ getProject, settings, save, onLog, onProgress, onChapter }) {
        this.getProject = getProject;
        this.settings = settings;
        this.save = save;
        this.onLog = onLog || (() => {});
        this.onProgress = onProgress || (() => {});
        this.onChapter = onChapter || (() => {});
        this.controller = null;
        this.pauseRequested = false;
        this.running = false;
    }

    stop() {
        this.controller?.abort();
    }

    pause() {
        this.pauseRequested = true;
        this.onLog('⏸️ 当前章节完成后暂停', 'info');
    }

    /** 续写完成后扫描禁用词，按设置本地替换或 AI 改写；povChar 指定时优先用该角色映射的文风的禁用词 */
    async checkStyle(project, title, content, api, signal, povChar) {
        const opt = styleOptions(this.settings);
        if (!opt.checkContinuation) return content;
        let hits = checkBanned(content, project, this.settings, 'continue', povChar);
        if (!hits.length) return content;
        const words = [...new Set(hits.map((h) => h.match))];
        this.onLog(`🚫 ${title} 命中 ${hits.length} 处禁用词：${words.slice(0, 8).join('、')}${words.length > 8 ? '…' : ''}`, 'warn');
        if (opt.fixMode === 'replace') {
            const r = replaceBanned(content, bannedListFor(project, this.settings, 'continue', povChar));
            if (r.count) {
                content = r.text;
                hits = checkBanned(content, project, this.settings, 'continue', povChar);
                this.onLog(`🔧 已按建议替换 ${r.count} 处${hits.length ? `，仍有 ${hits.length} 处没有替换建议` : ''}`, 'info');
            }
        } else if (opt.fixMode === 'ai') {
            try {
                this.onLog(`🔧 正在让 AI 改写 ${title} 中的禁用词…`);
                content = await fixBannedInText(content, hits, project, this.settings, { signal, api, povChar });
                hits = checkBanned(content, project, this.settings, 'continue', povChar);
                this.onLog(`🔧 ${title} 已改写${hits.length ? `，仍剩 ${hits.length} 处` : '，禁用词已清除'}`, hits.length ? 'warn' : 'success');
            } catch (e) {
                if (isAbortError(e)) throw e;
                this.onLog(`⚠️ AI 改写失败：${e.message}（保留原文）`, 'warn');
            }
        }
        return content;
    }

    async run({ count, words, direction, feedback } = {}) {
        if (this.running) throw new Error('续写任务已在运行');
        const project = this.getProject();
        if (!project) throw new Error('没有打开的项目');
        const cs = this.settings.continuation;
        count = Math.max(1, Number(count ?? cs.chapters) || 1);
        words = Math.max(300, Number(words ?? cs.wordsPerChapter) || 3000);
        feedback = feedback ?? cs.feedback;
        const api = this.settings.continueApi?.enabled ? this.settings.continueApi : this.settings.api;
        this.running = true;
        this.pauseRequested = false;
        this.controller = new AbortController();
        const signal = this.controller.signal;
        let done = 0;
        const started = Date.now();
        this.onLog(`✍️ 开始续写 ${count} 章（每章约 ${words} 字）${feedback ? '，写完即回灌资料库' : ''}`, 'info');
        this.onProgress({ done, total: count, started });
        try {
            for (let i = 0; i < count; i++) {
                if (this.pauseRequested || signal.aborted) break;
                const no = countSourceChapters(project) + project.continuation.chapters.length + 1;
                const plan = cs.followPlan !== false ? planForChapter(project, no) : null;
                const title = plan?.title ? `第${no}章 ${plan.title}` : `第${no}章`;
                const upcoming = plan ? upcomingPlans(project, no, 2) : [];
                const { system, prompt } = buildContinuePrompt(project, this.settings, { title, words, direction, plan, upcoming });
                this.onLog(`✍️ 正在写 ${title}${plan ? '（按大纲）' : ''}…`);
                const res = await callLLM({
                    api,
                    system,
                    prompt,
                    ...chainFor(this.settings, 'continue', project),
                    expect: 'prose',
                    signal,
                    onNotice: (m, l) => this.onLog(`${title}：${m}`, l),
                    maxTokens: Math.max(api.maxTokens || 0, Math.ceil(words * 2.2)),
                    onRetry: ({ attempt, error }) => this.onLog(`⚠️ ${title} 请求失败（${error.message}），第 ${attempt} 次重试`, 'warn'),
                });
                let content = cleanChapter(res.text, title, this.settings.extraction.filterTags);
                if (content.length < Math.min(200, words * 0.2)) throw new Error(`${title} 内容过短（${content.length} 字），已停止`);
                content = await this.checkStyle(project, title, content, api, signal, plan?.pov);
                const firstLine = content.split('\n')[0].trim();
                const chapter = { id: uid('g_'), no, title: firstLine.length <= 40 ? firstLine : title, content, direction: direction || '', createdAt: Date.now(), chunkId: '', planId: plan?.id || '' };
                project.continuation.chapters.push(chapter);
                if (plan) markPlanWritten(project, plan.id, chapter.id);
                done++;
                this.onLog(`✅ ${chapter.title} 完成（${content.length} 字）`, 'success');
                this.onChapter(chapter);
                await this.save();

                if (feedback) {
                    const chunk = {
                        id: uid('c_'), index: project.chunks.length, title: chapter.title, chapterTitles: [chapter.title], content,
                        charCount: content.length, start: 0, end: content.length, origin: 'generated', status: 'processing', error: '', attempts: 1, outline: [], important: [], processedAt: 0,
                    };
                    project.chunks.push(chunk);
                    chapter.chunkId = chunk.id;
                    try {
                        const known = knownContextFor(project, this.settings, chunk, content);
                        const { result } = await extractChunk(project, this.settings, chunk, { known, signal, onLog: this.onLog });
                        applyExtraction(project, chunk, result, { fullContext: known.full, verifyQuotes: this.settings.extraction.verifyQuotes });
                        chunk.status = 'done';
                        chunk.processedAt = Date.now();
                        this.onLog(`🔁 ${chapter.title} 已回灌资料库`, 'success');
                    } catch (e) {
                        if (isAbortError(e)) {
                            chunk.status = 'pending';
                            throw e;
                        }
                        chunk.status = 'error';
                        chunk.error = e.message;
                        this.onLog(`⚠️ ${chapter.title} 回灌失败：${e.message}（可稍后在提取页重试）`, 'warn');
                    }
                    await this.save();
                }
                this.onProgress({ done, total: count, started });
            }
        } catch (e) {
            if (!isAbortError(e)) this.onLog(`❌ 续写失败：${e.message}`, 'error');
        } finally {
            this.running = false;
            this.controller = null;
            await this.save();
            this.onProgress({ done, total: count, started, finished: true });
            this.onLog(`⏹️ 续写结束：完成 ${done} 章`, 'info');
        }
        return done;
    }
}

export function exportContinuationText(project, { includeSource = false } = {}) {
    const parts = [];
    if (includeSource) parts.push(project.chunks.filter((c) => c.origin === 'source').map((c) => c.content).join(''));
    parts.push(project.continuation.chapters.map((c) => c.content).join('\n\n'));
    return parts.join('\n\n').trim();
}

