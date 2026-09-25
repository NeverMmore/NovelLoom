// 聊天挂机续写（沿用 novel-auto-generator 的思路重写）：
// 在当前酒馆聊天里自动发送提示词、等待 AI 回复、稳定检测、弹窗等待、失败重试、断点续传、定期导出

import { extractTagContents, removeTags } from './json.js';
import { sleep } from './utils.js';

function ctx() {
    return globalThis.SillyTavern?.getContext?.();
}

const $ = (sel) => document.querySelector(sel);

export function getChat() {
    return ctx()?.chat || [];
}

export function isGenerating() {
    const stop = $('#mes_stop');
    if (stop && stop.offsetParent !== null && getComputedStyle(stop).display !== 'none') return true;
    return false;
}

function hasActiveToast() {
    return !!document.querySelector('#toast-container .toast');
}

export async function waitForToastsClear(timeoutMs, postWaitMs, signal) {
    if (!hasActiveToast()) return;
    const t0 = Date.now();
    while (hasActiveToast() && Date.now() - t0 < timeoutMs) await sleep(500, signal);
    await sleep(postWaitMs, signal);
}

export function getMessageText(index, { raw = true } = {}) {
    const chat = getChat();
    const msg = chat[index];
    if (!msg) return '';
    if (raw) return String(msg.mes ?? '');
    const el = document.querySelector(`#chat .mes[mesid="${index}"] .mes_text`);
    return el ? el.innerText : String(msg.mes ?? '');
}

export function applyTagFilters(text, cg) {
    let t = String(text || '');
    if (cg.excludeTags) t = removeTags(t, cg.excludeTags);
    if (cg.extractMode === 'tags' && cg.extractTags) t = extractTagContents(t, cg.extractTags, cg.tagSeparator ?? '\n\n');
    return t.trim();
}

async function sendMessage(text) {
    const ta = $('#send_textarea');
    const btn = $('#send_but');
    if (!ta || !btn) throw new Error('找不到酒馆输入框或发送按钮');
    ta.value = text;
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(100);
    btn.click();
}

function lastAiIndex() {
    const chat = getChat();
    for (let i = chat.length - 1; i >= 0; i--) if (!chat[i].is_user && !chat[i].is_system) return i;
    return -1;
}

function aiCount() {
    return getChat().filter((m) => !m.is_user && !m.is_system).length;
}

async function waitForReply(prevAi, cg, signal, onLog) {
    const t0 = Date.now();
    const maxWait = Math.max(60000, Number(cg.toastTimeoutMs) || 300000) * 2;
    // 等待新的 AI 消息出现且生成结束（用 AI 消息数判断，避免把上一条回复误当成新回复）
    while (aiCount() <= prevAi || isGenerating()) {
        if (Date.now() - t0 > maxWait) throw new Error('等待 AI 回复超时');
        await sleep(500, signal);
    }
    await sleep(Number(cg.replyWaitMs) || 0, signal);
    // 稳定检测：最后一条 AI 消息内容连续多次不变
    let last = '';
    let stable = 0;
    const need = Math.max(1, Number(cg.stabilityRequiredCount) || 3);
    while (stable < need) {
        if (Date.now() - t0 > maxWait) break;
        const idx = lastAiIndex();
        const cur = idx >= 0 ? getMessageText(idx) : '';
        if (cur === last && !isGenerating()) stable++;
        else stable = 0;
        last = cur;
        await sleep(Number(cg.stabilityCheckInterval) || 1000, signal);
    }
    if (cg.toastDetection && hasActiveToast()) {
        onLog?.('⏳ 检测到弹窗，等待其他插件处理…');
        await waitForToastsClear(Number(cg.toastTimeoutMs) || 300000, Number(cg.postToastWaitMs) || 0, signal);
    }
    const idx = lastAiIndex();
    return { index: idx, text: idx >= 0 ? getMessageText(idx) : '' };
}

export class ChatGenRunner {
    /**
     * @param {{settings: object, saveSettings: Function, onLog?: Function, onProgress?: Function, onChapter?: Function, onAutoSave?: Function}} deps
     */
    constructor(deps) {
        this.deps = deps;
        this.controller = null;
        this.running = false;
    }

    get cg() {
        return this.deps.settings.chatgen;
    }

    pause() {
        this.cg.isPaused = true;
        this.deps.saveSettings();
        this.deps.onLog?.('⏸️ 本章完成后暂停');
    }

    stop() {
        this.cg.isRunning = false;
        this.cg.isPaused = false;
        this.deps.saveSettings();
        this.controller?.abort();
        try {
            ctx()?.stopGeneration?.();
        } catch { /* ignore */ }
    }

    reset() {
        this.stop();
        this.cg.currentChapter = 0;
        this.deps.saveSettings();
    }

    async run() {
        if (this.running) throw new Error('挂机续写已在运行');
        if (!ctx()) throw new Error('无法访问酒馆');
        if (ctx().characterId === undefined && !ctx().groupId) throw new Error('请先打开一个角色聊天');
        const cg = this.cg;
        const { onLog, onProgress, onChapter, onAutoSave, saveSettings } = this.deps;
        this.running = true;
        this.controller = new AbortController();
        const signal = this.controller.signal;
        cg.isRunning = true;
        cg.isPaused = false;
        saveSettings();
        const started = Date.now();
        onLog?.(`▶️ 挂机续写开始：从第 ${cg.currentChapter + 1} 章到第 ${cg.totalChapters} 章`);
        try {
            while (cg.currentChapter < cg.totalChapters) {
                if (signal.aborted || !cg.isRunning) break;
                if (cg.isPaused) {
                    onLog?.('⏸️ 已暂停');
                    break;
                }
                const no = cg.currentChapter + 1;
                let ok = false;
                for (let attempt = 0; attempt <= (Number(cg.maxRetries) || 0) && !ok; attempt++) {
                    if (signal.aborted) break;
                    if (attempt > 0) onLog?.(`🔄 第 ${no} 章重试 #${attempt}`);
                    while (isGenerating()) await sleep(1000, signal);
                    if (cg.toastDetection) await waitForToastsClear(Number(cg.toastTimeoutMs) || 300000, Number(cg.postToastWaitMs) || 0, signal);
                    const prevAi = aiCount();
                    await sendMessage(cg.prompt || '继续');
                    const reply = await waitForReply(prevAi, cg, signal, onLog);
                    const clean = applyTagFilters(reply.text, cg);
                    if (clean.length < (Number(cg.minChapterLength) || 0)) {
                        onLog?.(`⚠️ 第 ${no} 章回复过短（${clean.length} 字）`, 'warn');
                        continue;
                    }
                    ok = true;
                    cg.currentChapter++;
                    saveSettings();
                    onLog?.(`✅ 第 ${no} 章完成（${clean.length} 字）`, 'success');
                    onChapter?.({ no, index: reply.index, text: clean });
                    onProgress?.({ done: cg.currentChapter, total: cg.totalChapters, started });
                    const every = Number(cg.autoSaveInterval) || 0;
                    if (every > 0 && cg.currentChapter % every === 0) onAutoSave?.();
                }
                if (!ok && !signal.aborted) {
                    onLog?.(`❌ 第 ${no} 章多次失败，已停止`, 'error');
                    break;
                }
            }
            if (cg.currentChapter >= cg.totalChapters) onLog?.('🎉 挂机续写全部完成', 'success');
        } catch (e) {
            if (e?.name !== 'AbortError') onLog?.(`❌ 挂机续写出错：${e.message}`, 'error');
        } finally {
            this.running = false;
            this.controller = null;
            cg.isRunning = false;
            saveSettings();
            onProgress?.({ done: cg.currentChapter, total: cg.totalChapters, started, finished: true });
        }
    }
}

/**
 * 导出聊天为小说文本
 * @returns {{text: string, count: number, items: {floor:number, role:string, name:string, text:string}[]}}
 */
export function collectChatText(cg) {
    const chat = getChat();
    const start = cg.exportAll ? 0 : Math.max(0, Number(cg.exportStartFloor) || 0);
    const end = cg.exportAll ? chat.length - 1 : Math.min(chat.length - 1, Number(cg.exportEndFloor) || chat.length - 1);
    const items = [];
    for (let i = start; i <= end; i++) {
        const m = chat[i];
        if (!m || m.is_system) continue;
        if (m.is_user && !cg.exportIncludeUser) continue;
        if (!m.is_user && !cg.exportIncludeAI) continue;
        const text = applyTagFilters(getMessageText(i, { raw: cg.useRawContent }), cg);
        if (!text) continue;
        items.push({ floor: i, role: m.is_user ? 'user' : 'assistant', name: m.name, text });
    }
    return { text: items.map((x) => x.text).join('\n\n'), count: items.length, items };
}
