// 分段提取管线：串行（滚动累积）/ 并行（独立）/ 分批（批内并行、批间累积）

import { callLLM, chainFor, isTokenLimitError } from './llm.js';
import { extractJson, removeTags } from './json.js';
import { addVolumeAt, applyExtraction, buildKnownContext, getVolumes, normalizeExtraction, priorVolumeSummaries, pruneGroupCards, prunePov, pruneRelationships, scanCensorArtifacts, volumeOf } from './project.js';
import { WRITING_RULES, buildCategoryGuide, buildExtractionTemplate, getPrompt, render } from './prompts.js';
import { abortError, estimateTokens, isAbortError, Semaphore } from './utils.js';
import { createSnapshot } from './store.js';
import { buildVolumeSummary } from './tools.js';

/** 为某段构建“已知资料”；分卷模式下只列本卷实体并附前卷梗概 */
export function knownContextFor(project, settings, chunk, mentionText, budget) {
    const ex = settings.extraction;
    const b = Number.isFinite(budget) ? budget : Number(ex.contextBudget) || 6000;
    if (!ex.volumeMode) return buildKnownContext(project, mentionText, b);
    const vol = volumeOf(project, chunk.index);
    return buildKnownContext(project, mentionText, b, {
        scope: { start: vol.startChunk, end: chunk.index - 1 },
        prelude: priorVolumeSummaries(project, chunk.index),
    });
}

export function buildExtractPrompt(project, settings, chunk, known) {
    const ex = settings.extraction;
    const cats = settings.categories || [];
    const optional = [];
    if (ex.extractOutline) optional.push('- important：标记关键转折、首次出现、名场面、核心设定揭示的章节，可附 1-2 句逐字原文。');
    if (ex.extractStyle) optional.push('- style：从叙事方式推断视角、语言风格、情绪基调（客观描述，不评价好坏）。');
    optional.push('- missing_names：原文用模糊说法指代、但后续创作需要具体名称的地名/人名/术语（没有就输出空数组）。');
    const knownText = known?.text ? `\n# 已知资料（来自前文，供参考与更新）\n${known.text}\n` : '';
    const knownRule = known?.text
        ? '- 【已知资料】中已有的实体：沿用其名称；只在本段有新信息时输出。输出时给出“融合旧信息与本段新信息后的完整版本”，不要只写增量；与本段无关的已知实体不要输出。'
        : '';
    const vars = {
        BOOK: project.bookName || project.name,
        CHUNK_NO: chunk.index + 1,
        CHUNK_TITLE: chunk.title,
        CHUNK_TEXT: chunk.content,
        CATEGORY_GUIDE: buildCategoryGuide(cats),
        OPTIONAL_GUIDE: optional.join('\n'),
        KNOWN: knownText,
        KNOWN_RULE: knownRule,
        JSON_TEMPLATE: buildExtractionTemplate(cats, { outline: ex.extractOutline, style: ex.extractStyle, quotes: ex.extractQuotes, important: ex.extractOutline }),
        WRITING_RULES,
        SUFFIX: ex.suffixPrompt ? `\n# 附加要求\n${ex.suffixPrompt}\n` : '',
    };
    return {
        system: render(getPrompt(settings, 'extractSystem'), vars),
        prompt: render(getPrompt(settings, 'extract'), vars),
    };
}

/** 角色档案里随提取逐段更新的文字字段（每次变化都记在 stages 里） */
const STAGE_FIELDS = ['identity', 'personality', 'relationship'];

/**
 * 这一段有没有可以清除的提取结果（只算 removeChunkContributions 真的会清掉的：角色经历/台词/阶段/别名、
 * 世界书修订、大纲、未回答的待核实名称等；手动角色的时间点、已回答的待核实名称、关系都不算）
 */
export function chunkHasContributions(project, idx) {
    const c = project.chunks[idx];
    if (!c) return false;
    if (c.status === 'done' || c.outline?.length || c.important?.length) return true;
    for (const ch of Object.values(project.characters)) {
        const onlyAnchor = ch.manual && ch.chunksSeen?.length === 1;
        if (ch.chunksSeen?.includes(idx) && !onlyAnchor) return true;
        if ([ch.experiences, ch.quotes, ch.dialogues, ch.stages].some((list) => (list || []).some((x) => x.chunk === idx))) return true;
        if (Object.values(ch.aliasSources || {}).some((src) => Array.isArray(src) && src.includes(idx))) return true;
    }
    for (const cat of Object.values(project.worldbook)) {
        for (const e of Object.values(cat)) {
            if ((e.sourceChunks || []).includes(idx) || (e.revisions || []).some((r) => r.chunk === idx)) return true;
        }
    }
    return (project.missingNames || []).some((m) => m.chunk === idx && !String(m.resolved || '').trim())
        || (project.censorFlags || []).some((x) => x.chunk === idx);
}

/**
 * 清除某分块对项目的贡献（用于重新提取）。
 * - 只有“这一段是它最后的出处”的角色/条目才会被删掉；手动新建的、锁定的都保留；
 * - 身份/性格/关系：只有这一段是该角色目前最晚出现的一段、且当前值就是这一段写进去的，才回退到之前真正写入过的记录；
 *   更早的记录已经被截掉时保留当前值；手动改过的值（和这一段写的不一样）不会被回退
 *   （想让手动修改在重新提取后也不被 AI 覆盖，请锁定角色）；
 * - 别名：清掉“只来自这一段”的别名（有出处记录的才清，手动加的和旧数据里的别名保留）；
 * - 关系图谱不动：提取本来就不产生关系，关系来自「AI 分析关系」或手动添加；
 * - 已经填写了答案的待核实名称保留；
 * @param {{prune?: boolean}} opt prune=false：重新提取时用。被清掉的角色马上会重新提取回来，
 *   所以不要连带删掉指向它们的关系、群聊卡成员和视角文风（默认 true，供真正删除分段时使用）
 */
export function removeChunkContributions(project, idx, { prune = true } = {}) {
    for (const [name, ch] of Object.entries(project.characters)) {
        const had = ch.chunksSeen.includes(idx);
        const laterSeen = ch.chunksSeen.some((c) => c > idx);
        const earlierSeen = ch.chunksSeen.some((c) => c < idx);
        if (!ch.locked && had && !laterSeen) {
            // 只看真正写进档案的阶段值（锁定/非最新段时 AI 的提议只记录不写入，标在 unapplied 里）
            const applied = (s, f) => s[f] && !(Array.isArray(s.unapplied) && s.unapplied.includes(f));
            for (const f of STAGE_FIELDS) {
                // 这个字段最后一次被写入，是否就是这一段的提取结果；当前值不一样说明手动改过，不回退
                const last = [...ch.stages].reverse().find((s) => applied(s, f));
                if (!last || last.chunk !== idx || last[f] !== ch[f]) continue;
                const prev = ch.stages.filter((s) => s.chunk < idx && applied(s, f)).pop();
                if (prev) ch[f] = prev[f];
                else if (!earlierSeen) ch[f] = '';
                // 更早出现过但没有记录（被 40 条上限截掉）：不知道之前是什么，保留当前值
            }
        }
        ch.experiences = ch.experiences.filter((e) => e.chunk !== idx);
        ch.quotes = ch.quotes.filter((q) => q.chunk !== idx);
        ch.dialogues = (ch.dialogues || []).filter((d) => d.chunk !== idx);
        ch.stages = ch.stages.filter((s) => s.chunk !== idx);
        if (ch.aliasSources && typeof ch.aliasSources === 'object') {
            for (const [a, src] of Object.entries(ch.aliasSources)) {
                if (!Array.isArray(src)) continue;
                const rest = src.filter((c) => c !== idx);
                if (rest.length) {
                    ch.aliasSources[a] = rest;
                } else {
                    delete ch.aliasSources[a];
                    ch.aliases = (ch.aliases || []).filter((x) => x !== a);
                }
            }
        }
        ch.chunksSeen = ch.chunksSeen.filter((c) => c !== idx);
        if (had && !ch.chunksSeen.length) {
            if (ch.manual) {
                ch.chunksSeen = [idx]; // 手动角色保留它的时间点，故事时间点筛选里不会消失
            } else if (!ch.locked) {
                delete project.characters[name];
                continue;
            }
        }
        ch.firstChunk = ch.chunksSeen.length ? Math.min(...ch.chunksSeen) : Infinity;
        ch.lastChunk = ch.chunksSeen.length ? Math.max(...ch.chunksSeen) : -1;
    }
    for (const cat of Object.values(project.worldbook)) {
        for (const [name, e] of Object.entries(cat)) {
            const had = (e.sourceChunks || []).includes(idx);
            e.sourceChunks = (e.sourceChunks || []).filter((c) => c !== idx);
            e.revisions = (e.revisions || []).filter((r) => r.chunk !== idx);
            if (e.revisions.length) e.content = e.revisions[e.revisions.length - 1].content;
            if (had && !e.sourceChunks.length && !e.locked) delete cat[name];
        }
    }
    project.missingNames = project.missingNames.filter((m) => m.chunk !== idx || String(m.resolved || '').trim());
    project.censorFlags = (project.censorFlags || []).filter((f) => f.chunk !== idx);
    if (prune) {
        pruneRelationships(project);
        pruneGroupCards(project);
        prunePov(project);
    }
    const chunk = project.chunks[idx];
    if (chunk) {
        chunk.outline = [];
        chunk.important = [];
    }
}

/**
 * 准备重新提取若干分段：从后往前清掉这些段的贡献，状态改回“待提取”。
 * 从后往前清，保证身份/性格等字段能一路回退到这些段之前的记录。
 * @param {number[]} indices 分段序号
 * @returns {number} 实际重置的段数
 */
export function resetChunksForReextract(project, indices) {
    const list = [...new Set(indices)].filter((i) => Number.isInteger(i) && project.chunks[i]).sort((a, b) => b - a);
    const before = new Set(Object.keys(project.characters));
    for (const i of list) {
        removeChunkContributions(project, i, { prune: false });
        const c = project.chunks[i];
        c.status = 'pending';
        c.error = '';
        c.lastRaw = '';
    }
    const removed = [...before].filter((n) => !project.characters[n]);
    if (removed.length) project.reextractPending = [...new Set([...(project.reextractPending || []), ...removed])];
    return list.length;
}

/** 从第 start 段（含）起全部重新提取的准备工作；start = 0 即全部重新提取 */
export function resetExtractionFrom(project, start = 0) {
    const from = Math.max(0, Math.floor(Number(start) || 0));
    return resetChunksForReextract(project, project.chunks.map((c) => c.index).filter((i) => i >= from));
}

/**
 * 提取单个分块（含 JSON 修复重试）
 * @returns {Promise<{result: object, raw: string}>}
 */
export async function extractChunk(project, settings, chunk, { known, signal, onLog, extraPrompt = '' } = {}) {
    const { system, prompt } = buildExtractPrompt(project, settings, chunk, known);
    const fullPrompt = extraPrompt ? `${prompt}\n\n# 本次重新提取的额外要求\n${extraPrompt}` : prompt;
    const followUps = [];
    const api = settings.api;
    const tagFilter = settings.extraction.filterTags;
    let raw = '';
    for (let attempt = 0; attempt < 2; attempt++) {
        const res = await callLLM({
            api,
            system,
            prompt: fullPrompt,
            followUps,
            ...chainFor(settings, 'extract', project),
            expect: 'json',
            signal,
            onNotice: (m, l) => onLog?.(`第 ${chunk.index + 1} 段：${m}`, l),
            onRetry: ({ attempt: a, wait, error }) => onLog?.(`⚠️ 第 ${chunk.index + 1} 段请求失败（${error.message}），${Math.round(wait / 1000)} 秒后第 ${a} 次重试`, 'warn'),
        });
        project.stats.calls++;
        project.stats.promptChars += (system?.length || 0) + fullPrompt.length;
        project.stats.completionChars += res.text.length;
        raw = removeTags(res.text, tagFilter);
        try {
            const json = extractJson(raw);
            return { result: normalizeExtraction(json, (settings.categories || []).map((c) => c.name)), raw };
        } catch (e) {
            if (attempt === 0) {
                onLog?.(`⚠️ 第 ${chunk.index + 1} 段输出不是合法 JSON，要求 AI 重新输出`, 'warn');
                followUps.push({ role: 'assistant', content: res.text.slice(0, 6000) });
                followUps.push({ role: 'user', content: '上面的输出不是合法 JSON（可能被截断或含未转义引号）。请重新输出完整、合法的 JSON 对象，只输出 JSON。字符串中的双引号请改用中文引号。' });
                continue;
            }
            e.raw = raw;
            throw e;
        }
    }
    throw new Error('提取失败');
}

/**
 * 提取任务运行器
 */
export class ExtractionRunner {
    constructor({ getProject, settings, save, onLog, onProgress, onChunk, onVolume }) {
        this.onVolume = onVolume;
        this.getProject = getProject;
        this.settings = settings;
        this.save = save;
        this.onLog = onLog || (() => {});
        this.onProgress = onProgress || (() => {});
        this.onChunk = onChunk || (() => {});
        this.controller = null;
        this.pauseRequested = false;
        this.running = false;
        this.processedSinceSnapshot = 0;
    }

    stop() {
        this.controller?.abort();
    }

    pause() {
        this.pauseRequested = true;
        this.onLog('⏸️ 已请求暂停：当前进行中的分块完成后停止', 'info');
    }

    /**
     * @param {{chunkIds?: string[], startIndex?: number, mode?: string, includeErrors?: boolean}} opt
     */
    async run(opt = {}) {
        if (this.running) throw new Error('提取任务已在运行');
        const project = this.getProject();
        if (!project) throw new Error('没有打开的项目');
        this.running = true;
        this.pauseRequested = false;
        this.controller = new AbortController();
        const signal = this.controller.signal;
        const ex = this.settings.extraction;
        const mode = opt.mode || ex.mode;
        const started = Date.now();

        let targets = project.chunks.filter((c) => (opt.chunkIds ? opt.chunkIds.includes(c.id) : (c.status === 'pending' || (opt.includeErrors !== false && c.status === 'error') || c.status === 'processing')));
        if (Number.isFinite(opt.startIndex)) targets = targets.filter((c) => c.index >= opt.startIndex);
        targets.sort((a, b) => a.index - b.index);
        const total = targets.length;
        let finished = 0;
        let failed = 0;
        this.onLog(`▶️ 开始提取：${total} 段，模式：${{ serial: '串行（滚动累积）', parallel: '并行（独立）', batch: '分批（批间累积）' }[mode] || mode}`, 'info');
        this.onProgress({ finished, failed, total, started });

        const volumeMode = !!ex.volumeMode;
        const tokenLimit = Number(ex.volumeTokenLimit) || 0;

        /** 在某段开新卷（分卷模式下上下文超限时） */
        const splitHere = async (chunk, reason) => {
            const vol = volumeOf(project, chunk.index);
            if (!volumeMode || chunk.index <= vol.startChunk) return false;
            const nv = addVolumeAt(project, chunk.index, { auto: 'overflow' });
            this.onLog(`📦 ${reason}，从第 ${chunk.index + 1} 段开始新的一卷「${nv.name}」`, 'warn');
            this.onVolume?.(nv);
            await ensurePrevSummary(chunk);
            return true;
        };

        /** 进入新卷前，为上一卷生成梗概（供前情提要使用） */
        const ensurePrevSummary = async (chunk) => {
            if (!volumeMode || !ex.volumeAutoSummary || signal.aborted) return;
            const vols = getVolumes(project);
            const vol = vols.find((v) => chunk.index >= v.startChunk && chunk.index <= v.endChunk);
            if (!vol || vol.implicit || vol.index === 0 || chunk.index !== vol.startChunk) return;
            const prev = vols[vol.index - 1];
            if (prev.summary) return;
            const chunksPrev = project.chunks.slice(prev.startChunk, prev.endChunk + 1);
            if (!chunksPrev.length || chunksPrev.some((c) => c.status !== 'done')) return;
            try {
                this.onLog(`🧭 生成「${prev.name}」卷梗概…`);
                await buildVolumeSummary(project, this.settings, prev.id, { signal });
                this.onLog(`🧭 「${prev.name}」卷梗概已生成`, 'success');
            } catch (e) {
                if (!isAbortError(e)) this.onLog(`⚠️ 卷梗概生成失败：${e.message}`, 'warn');
            }
        };

        const processOne = async (chunk, known, rebuild = null) => {
            chunk.status = 'processing';
            chunk.error = '';
            chunk.attempts = (chunk.attempts || 0) + 1;
            this.onChunk(chunk);
            const t0 = Date.now();
            let retriedOverflow = false;
            for (;;) {
                try {
                    const { result } = await extractChunk(project, this.settings, chunk, { known, signal, onLog: this.onLog });
                    return { chunk, result, known, ms: Date.now() - t0 };
                } catch (e) {
                    if (isAbortError(e) || signal.aborted) {
                        chunk.status = 'pending';
                        this.onChunk(chunk);
                        throw abortError();
                    }
                    if (isTokenLimitError(e.message) && !retriedOverflow && ex.volumeOnOverflow !== false && rebuild && (await splitHere(chunk, '上下文超限'))) {
                        retriedOverflow = true;
                        known = rebuild();
                        continue;
                    }
                    if (isTokenLimitError(e.message)) e.message += '（上下文超限：可开启分卷模式，或调小“每段最大字数”“已知资料注入上限”）';
                    return fail(chunk, e);
                }
            }
        };

        const fail = (chunk, e) => {
                chunk.status = 'error';
                chunk.error = e.message;
                chunk.lastRaw = String(e.raw || '').slice(0, 4000);
                project.stats.failures++;
                failed++;
                this.onLog(`❌ 第 ${chunk.index + 1} 段「${chunk.title}」失败：${e.message}`, 'error');
                this.onChunk(chunk);
                return null;
        };

        const commit = async (r, touched = null) => {
            if (!r) return null;
            let full = r.known?.full;
            if (touched && full) full = new Set([...full].filter((k) => !touched.has(k)));
            const summary = applyExtraction(project, r.chunk, r.result, { fullContext: full, verifyQuotes: ex.verifyQuotes });
            const flagged = scanCensorArtifacts(project, r.chunk, r.result);
            if (flagged) this.onLog(`⚠️ 第 ${r.chunk.index + 1} 段「${r.chunk.title}」疑似有 ${flagged} 处敏感词被替换成拼音/注音，已记入「大纲」页待核实列表`, 'warn');
            if (touched) {
                for (const n of [...summary.newCharacters, ...summary.updatedCharacters]) touched.add(`char:${n}`);
                for (const n of [...summary.newEntries, ...summary.updatedEntries]) touched.add(n.replace('/', ':'));
            }
            r.chunk.status = 'done';
            r.chunk.processedAt = Date.now();
            finished++;
            this.processedSinceSnapshot++;
            const bits = [];
            if (summary.newCharacters.length) bits.push(`新角色 ${summary.newCharacters.join('、')}`);
            if (summary.updatedCharacters.length) bits.push(`更新角色 ${summary.updatedCharacters.length}`);
            if (summary.newEntries.length) bits.push(`新条目 ${summary.newEntries.length}`);
            if (summary.updatedEntries.length) bits.push(`更新条目 ${summary.updatedEntries.length}`);
            this.onLog(`✅ 第 ${r.chunk.index + 1} 段「${r.chunk.title}」完成（${(r.ms / 1000).toFixed(1)}s）${bits.length ? `：${bits.join('，')}` : ''}`, 'success');
            this.onChunk(r.chunk);
            this.onProgress({ finished, failed, total, started });
            await this.save();
            const every = Number(ex.autoSnapshotEvery) || 0;
            if (every > 0 && this.processedSinceSnapshot >= every) {
                this.processedSinceSnapshot = 0;
                await createSnapshot(project, `自动快照（已完成 ${project.chunks.filter((c) => c.status === 'done').length} 段）`).catch(() => {});
            }
            return summary;
        };

        const budget = Number(ex.contextBudget) || 6000;
        try {
            if (mode === 'parallel') {
                const sem = new Semaphore(Number(ex.concurrency) || 3);
                const tasks = targets.map((chunk) => sem.run(async () => {
                    if (this.pauseRequested || signal.aborted) return;
                    // 独立模式：只给名称列表，不给完整旧档案（避免并发写冲突）
                    const make = () => {
                        const k = knownContextFor(project, this.settings, chunk, '', Math.min(budget, 2500));
                        k.full = new Set();
                        return k;
                    };
                    const r = await processOne(chunk, make(), make);
                    await commit(r);
                }, signal).catch((e) => {
                    if (!isAbortError(e)) throw e;
                }));
                await Promise.all(tasks);
            } else if (mode === 'batch') {
                const size = Math.max(1, Number(ex.concurrency) || 3);
                for (let i = 0; i < targets.length; i += size) {
                    if (this.pauseRequested || signal.aborted) break;
                    const batch = targets.slice(i, i + size);
                    for (const c of batch) await ensurePrevSummary(c);
                    const results = await Promise.all(batch.map((chunk) => {
                        const make = () => knownContextFor(project, this.settings, chunk, chunk.content, budget);
                        return processOne(chunk, make(), make);
                    }));
                    // 按顺序提交；同批中已被前一段更新过的实体，后一段改为追加合并，避免覆盖
                    const touched = new Set();
                    for (const r of results.filter(Boolean).sort((a, b) => a.chunk.index - b.chunk.index)) await commit(r, touched);
                }
            } else {
                for (const chunk of targets) {
                    if (this.pauseRequested || signal.aborted) break;
                    await ensurePrevSummary(chunk);
                    const make = () => knownContextFor(project, this.settings, chunk, chunk.content, budget);
                    let known = make();
                    // 分卷模式：预估提示词超过阈值时提前分卷
                    if (volumeMode && tokenLimit > 0) {
                        const { system, prompt } = buildExtractPrompt(project, this.settings, chunk, known);
                        const tokens = estimateTokens(system + prompt);
                        if (tokens > tokenLimit && (await splitHere(chunk, `提示词约 ${tokens} tokens，超过分卷阈值 ${tokenLimit}`))) known = make();
                    }
                    const r = await processOne(chunk, known, make);
                    await commit(r);
                }
            }
            // 分卷模式：为已全部完成、还没有梗概的卷生成梗概
            if (volumeMode && ex.volumeAutoSummary && !signal.aborted && !this.pauseRequested) {
                for (const v of getVolumes(project).filter((x) => !x.implicit && !x.summary)) {
                    const cs = project.chunks.slice(v.startChunk, v.endChunk + 1);
                    if (!cs.length || cs.some((c) => c.status !== 'done')) continue;
                    try {
                        this.onLog(`🧭 生成「${v.name}」卷梗概…`);
                        await buildVolumeSummary(project, this.settings, v.id, { signal });
                    } catch (e) {
                        if (isAbortError(e)) break;
                        this.onLog(`⚠️ 「${v.name}」卷梗概生成失败：${e.message}`, 'warn');
                    }
                }
            }
        } catch (e) {
            if (!isAbortError(e)) {
                this.onLog(`❌ 任务异常：${e.message}`, 'error');
                throw e;
            }
        } finally {
            for (const c of project.chunks) if (c.status === 'processing') c.status = 'pending';
            // 所有分段都提取完了：等待重新提取的角色名单作废（没有再提取回来的角色，留下的关系/群聊卡引用保持原样，不自动删除）
            if (project.reextractPending?.length && project.chunks.every((c) => c.status === 'done')) project.reextractPending = [];
            await this.save();
            this.running = false;
            const stopped = signal.aborted ? '（已停止）' : this.pauseRequested ? '（已暂停）' : '';
            this.onLog(`⏹️ 提取结束${stopped}：成功 ${finished}，失败 ${failed}，用时 ${Math.round((Date.now() - started) / 1000)} 秒`, 'info');
            this.onProgress({ finished, failed, total, started, done: true });
            this.controller = null;
        }
        return { finished, failed, total };
    }
}
