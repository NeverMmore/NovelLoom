// 续写页：API 续写（写完回灌资料库）+ 聊天挂机续写

import { app } from '../app.js';
import { buildContinuePrompt, countSourceChapters, exportContinuationText, regenerateChapter } from '../continue.js';
import { collectChatText } from '../chatgen.js';
import { deleteChunkAt } from '../project.js';
import { planForChapter, unmarkPlanWritten, upcomingPlans } from '../planner.js';
import { downloadFile, formatDuration, formatNumber, safeFileName, truncate } from '../utils.js';
import { bannedListFor, checkBanned, fixBannedInText, getStyleProfile, replaceBanned, styleOptions } from '../style.js';
import { rewriteSelection } from '../rewrite.js';
import { checkContinuity, issueTypeLabel } from '../continuity.js';
import { createSnapshot } from '../store.js';
import { bindSettings, busy, chainPreviewHtml, confirmDialog, emptyState, esc, fmtTime, icon, openDialog, promptDialog, qs, rerollBtn } from './common.js';

/** 连续性检查结果区域的 HTML */
function continuityBoxHtml(check) {
    if (!check) return '<div class="nl-muted nl-small" data-continuity-empty>还没有做过连续性检查。</div>';
    if (!check.issues.length) return `<div class="nl-small nl-ok">${icon('check', { size: 14 })} 未发现明显矛盾（${fmtTime(check.checkedAt)}）</div>`;
    return `<div class="nl-small nl-warn">${icon('alert', { size: 14 })} ${check.issues.length} 处疑似矛盾（${fmtTime(check.checkedAt)}）</div>${check.issues.map((i) => `
        <div class="nl-lint nl-lint-error">
            <b>${esc(issueTypeLabel(i.type))}</b>${i.severity === 'high' ? ' <span class="nl-tag nl-warn">高</span>' : ''}：${esc(i.problem)}
            ${i.quote ? `<div class="nl-muted nl-small">原文：「${esc(truncate(i.quote, 100))}」</div>` : ''}
            ${i.evidence ? `<div class="nl-muted nl-small">依据：${esc(i.evidence)}</div>` : ''}
        </div>`).join('')}`;
}

export const continueTab = {
    mount(el, { switchTab, setActions }) {
        let apiProgress = null;
        let chatProgress = null;

        const nextPlanText = (p) => {
            const no = countSourceChapters(p) + p.continuation.chapters.length + 1;
            const plan = planForChapter(p, no);
            const remain = (p.plan?.chapters || []).filter((c) => c.status !== 'written' && c.no >= no).length;
            if (!plan) return `下一章：第${no}章（没有对应大纲${remain ? `，已规划的章节从第${Math.min(...p.plan.chapters.filter((c) => c.status !== 'written').map((c) => c.no))}章开始` : ''}）`;
            return `下一章：第${no}章 ${esc(plan.title)}（按大纲，剩余 ${remain} 章规划）${app.settings.continuation.followPlan === false ? '，当前未启用按大纲写' : ''}`;
        };

        const styleLine = (p) => {
            const prof = getStyleProfile(p, app.settings, 'continue');
            const o = styleOptions(app.settings);
            const nb = bannedListFor(p, app.settings, 'continue').length;
            const fix = { none: '只提示', replace: '按建议替换', ai: 'AI 改写' }[o.fixMode] || '只提示';
            return `文风：<b>${esc(prof ? prof.name : '不指定')}</b>${prof?.samples?.length ? `（范文 ${prof.samples.length} 段）` : ''} · 禁用词 ${nb} 个${nb ? `，${o.checkContinuation ? `写完自动检查（${fix}）` : '不自动检查'}` : ''} <a href="#" data-act="goto-style">修改</a>`;
        };

        /** 更新续写章节正文（已回灌的同步更新分段内容） */
        const setChapterContent = (p, ch, content) => {
            ch.content = content;
            const chunk = p.chunks.find((c) => c.id === ch.chunkId);
            if (chunk) {
                chunk.content = content;
                chunk.charCount = content.length;
            }
        };

        const render = () => {
            const p = app.project;
            const cg = app.settings.chatgen;
            el.innerHTML = `
            ${p ? `
            <section class="nl-card">
                <div class="nl-card-head">
                    <div>
                        <h3>AI 续写（基于资料库）</h3>
                        <div class="nl-card-desc">用提取出的大纲、角色档案、世界书和前文结尾，逐章续写《${esc(p.bookName)}》。开启“回灌”后，每写完一章会立刻提取资料并合并进角色与世界书，后续章节和角色卡都能用上。</div>
                    </div>
                </div>
                <div class="nl-grid3">
                    <div class="nl-field"><label>续写章数</label><input class="nl-input" type="number" min="1" max="200" data-setting="continuation.chapters"></div>
                    <div class="nl-field"><label>每章字数</label><input class="nl-input" type="number" min="300" step="500" data-setting="continuation.wordsPerChapter"></div>
                    <div class="nl-field"><label>前文参考字数</label><input class="nl-input" type="number" min="500" step="500" data-setting="continuation.tailChars"></div>
                </div>
                <div class="nl-field"><label>续写方向（可留空）</label><textarea class="nl-input nl-textarea" rows="3" data-setting="continuation.direction" placeholder="例如：主角与反派在拍卖会正面交锋；新角色登场；走向 HE"></textarea></div>
                <div class="nl-row nl-wrap nl-checks">
                    <label><input type="checkbox" data-setting="continuation.feedback"> 写完回灌资料库（分段续写 + 提取）</label>
                    <label><input type="checkbox" data-setting="continuation.useWorldbook"> 参考世界书与角色档案</label>
                    <label><input type="checkbox" data-setting="continuation.followPlan"> 按「写大纲」页的规划逐章写</label>
                    <label><input type="checkbox" data-setting="continueApi.enabled"> 续写使用单独 API（在设置页配置）</label>
                </div>
                <div class="nl-row nl-wrap">
                    <button class="nl-btn nl-primary" data-act="api-start">${icon('play')}开始续写</button>
                    <button class="nl-btn" data-act="api-pause">${icon('pause')}暂停</button>
                    <button class="nl-btn nl-danger" data-act="api-stop">${icon('stop')}停止</button>
                    <button class="nl-btn" data-act="api-preview">${icon('eye')}预览提示词</button>
                </div>
                <div class="nl-progress"><div class="nl-progress-bar" data-bar="api" style="width:0%"></div><span class="nl-progress-text" data-text="api"></span></div>
                <div class="nl-muted nl-small">原文共 ${countSourceChapters(p)} 章 · 已续写 ${p.continuation.chapters.length} 章 · ${nextPlanText(p)}</div>
                <div class="nl-muted nl-small">${styleLine(p)}</div>
                <div class="nl-list">
                    ${p.continuation.chapters.slice().reverse().map((c) => {
                        const hits = checkBanned(c.content, p, app.settings, 'continue');
                        const words = [...new Set(hits.map((h) => h.match))];
                        return `
                    <div class="nl-list-item">
                        <div class="nl-grow" data-act="view-gen" data-id="${esc(c.id)}"><b>${esc(c.title)}</b><div class="nl-muted nl-small">${formatNumber(c.content.length)} 字 · ${c.chunkId ? '已回灌' : '未回灌'}${c.direction ? ` · 方向：${esc(truncate(c.direction, 30))}` : ''}</div>
                            ${hits.length ? `<div class="nl-small nl-warn" data-ban-hits>${icon('alert', { size: 14 })} ${hits.length} 处禁用词：${esc(words.slice(0, 6).join('、'))}${words.length > 6 ? '…' : ''}</div>` : ''}
                            ${c.continuityCheck ? (c.continuityCheck.issues.length ? `<div class="nl-small nl-warn">${icon('alert', { size: 14 })} ${c.continuityCheck.issues.length} 处疑似连续性矛盾</div>` : `<div class="nl-small nl-ok">${icon('check', { size: 14 })} 连续性核对通过</div>`) : ''}</div>
                        ${hits.length ? `<button class="nl-btn nl-sm" data-act="ban-replace" data-id="${esc(c.id)}" title="按“词=>建议”替换">按建议替换</button><button class="nl-btn nl-sm" data-act="ban-fix" data-id="${esc(c.id)}">AI 修正</button>` : ''}
                        <button class="nl-btn nl-sm" data-act="view-gen" data-id="${esc(c.id)}">查看/编辑</button>
                        ${rerollBtn('reroll-chapter', `data-id="${esc(c.id)}"`, { label: '重新生成', title: '整章重新生成（沿用原编号/大纲/方向）' })}
                        <button class="nl-btn nl-sm nl-danger" data-act="del-gen" data-id="${esc(c.id)}">删除</button>
                    </div>`;
                    }).join('')}
                </div>
            </section>` : `<section class="nl-card">${emptyState('AI 续写需要先在「项目」页导入小说。下方的聊天挂机续写可以直接使用。', '<button class="nl-btn" data-goto="project">去项目页</button>', { title: '还没有打开项目', ico: 'continue' })}</section>`}

            <section class="nl-card">
                <div class="nl-card-head">
                    <div>
                        <h3>聊天挂机续写</h3>
                        <div class="nl-card-desc">在当前打开的酒馆聊天里自动发送提示词、等待回复、失败重试，支持断点续传（兼容 novel-auto-generator 的用法）。适合已经有角色卡/预设的续写方式。</div>
                    </div>
                </div>
                <div class="nl-grid3">
                    <div class="nl-field"><label>目标章数</label><input class="nl-input" type="number" min="1" data-setting="chatgen.totalChapters"></div>
                    <div class="nl-field"><label>当前进度</label><div class="nl-row"><b data-cg-progress>${cg.currentChapter} / ${cg.totalChapters}</b></div></div>
                    <div class="nl-field"><label>发送的提示词</label><input class="nl-input" data-setting="chatgen.prompt"></div>
                </div>
                <div class="nl-row nl-wrap">
                    <button class="nl-btn nl-primary" data-act="cg-start">${icon('play')}${cg.currentChapter > 0 ? '继续' : '开始'}</button>
                    <button class="nl-btn" data-act="cg-pause">${icon('pause')}暂停</button>
                    <button class="nl-btn nl-danger" data-act="cg-stop">${icon('stop')}停止</button>
                    <button class="nl-btn" data-act="cg-reset">重置进度</button>
                </div>
                <div class="nl-progress"><div class="nl-progress-bar" data-bar="chat" style="width:0%"></div><span class="nl-progress-text" data-text="chat"></span></div>
                <details>
                    <summary>高级设置</summary>
                    <div class="nl-grid3">
                        <div class="nl-field"><label>回复后等待（毫秒）</label><input class="nl-input" type="number" data-setting="chatgen.replyWaitMs"></div>
                        <div class="nl-field"><label>稳定检测间隔（毫秒）</label><input class="nl-input" type="number" data-setting="chatgen.stabilityCheckInterval"></div>
                        <div class="nl-field"><label>稳定次数</label><input class="nl-input" type="number" data-setting="chatgen.stabilityRequiredCount"></div>
                        <div class="nl-field"><label>单章最大重试</label><input class="nl-input" type="number" data-setting="chatgen.maxRetries"></div>
                        <div class="nl-field"><label>最小章节字数</label><input class="nl-input" type="number" data-setting="chatgen.minChapterLength"></div>
                        <div class="nl-field"><label>每 N 章自动导出（0 关闭）</label><input class="nl-input" type="number" data-setting="chatgen.autoSaveInterval"></div>
                        <div class="nl-field"><label><input type="checkbox" data-setting="chatgen.toastDetection"> 弹窗检测（等待其他插件）</label></div>
                        <div class="nl-field"><label>弹窗等待超时（毫秒）</label><input class="nl-input" type="number" data-setting="chatgen.toastTimeoutMs"></div>
                        <div class="nl-field"><label>弹窗消失后额外等待（毫秒）</label><input class="nl-input" type="number" data-setting="chatgen.postToastWaitMs"></div>
                    </div>
                    <div class="nl-row nl-checks"><label><input type="checkbox" data-setting="chatgen.feedbackToProject"> 每章回复自动加入当前项目（作为“聊天”分段，可在提取页提取）</label></div>
                </details>
                <details>
                    <summary>导出聊天为小说 / 标签提取</summary>
                    <div class="nl-grid3">
                        <div class="nl-field"><label><input type="checkbox" data-setting="chatgen.exportAll"> 导出全部楼层</label></div>
                        <div class="nl-field"><label>起始楼层</label><input class="nl-input" type="number" data-setting="chatgen.exportStartFloor"></div>
                        <div class="nl-field"><label>结束楼层</label><input class="nl-input" type="number" data-setting="chatgen.exportEndFloor"></div>
                        <div class="nl-field"><label><input type="checkbox" data-setting="chatgen.exportIncludeUser"> 包含用户消息</label></div>
                        <div class="nl-field"><label><input type="checkbox" data-setting="chatgen.exportIncludeAI"> 包含 AI 回复</label></div>
                        <div class="nl-field"><label><input type="checkbox" data-setting="chatgen.useRawContent"> 读取原始内容（chat.mes）</label></div>
                        <div class="nl-field"><label>模式</label><select class="nl-input" data-setting="chatgen.extractMode"><option value="all">全部内容</option><option value="tags">只提取指定标签</option></select></div>
                        <div class="nl-field"><label>提取标签（白名单）</label><input class="nl-input" data-setting="chatgen.extractTags" placeholder="content"></div>
                        <div class="nl-field"><label>移除标签（黑名单）</label><input class="nl-input" data-setting="chatgen.excludeTags" placeholder="thinking think"></div>
                    </div>
                    <div class="nl-row nl-wrap">
                        <button class="nl-btn" data-act="chat-preview">${icon('eye')}预览</button>
                        <button class="nl-btn" data-act="chat-txt">${icon('download')}导出 TXT</button>
                        <button class="nl-btn" data-act="chat-json">${icon('download')}导出 JSON</button>
                        ${p ? '<button class="nl-btn" data-act="chat-to-project">把聊天内容加入当前项目</button>' : ''}
                    </div>
                </details>
            </section>`;
            bindSettings(el, app.settings, () => app.saveSettings());
            updateBars();
            // 页面级操作（导出整本续写）放进标题栏；切走后迟到的渲染不能改写别的页面的标题栏
            if (el.isConnected) {
                setActions?.(p ? `
                    <button class="nl-btn" data-act="export-gen">${icon('download')}导出续写 TXT</button>
                    <button class="nl-btn" data-act="export-all">${icon('download')}导出原文+续写 TXT</button>` : '', onClick);
            }
        };

        const updateBars = () => {
            const set = (k, pr, running) => {
                const bar = qs(el, `[data-bar="${k}"]`);
                const txt = qs(el, `[data-text="${k}"]`);
                if (!bar) return;
                if (!pr) {
                    bar.style.width = '0%';
                    txt.textContent = running ? '运行中…' : '';
                    return;
                }
                const pct = pr.total ? Math.round((pr.done / pr.total) * 100) : 0;
                bar.style.width = `${pct}%`;
                txt.textContent = `${pr.done}/${pr.total}${pr.started ? ` · 用时 ${formatDuration(Date.now() - pr.started)}` : ''}${pr.finished ? ' · 已结束' : ''}`;
            };
            set('api', apiProgress, app.continuation.running);
            const cg = app.settings.chatgen;
            set('chat', chatProgress || { done: cg.currentChapter, total: cg.totalChapters }, app.chatgen.running);
            const prog = qs(el, '[data-cg-progress]');
            if (prog) prog.textContent = `${cg.currentChapter} / ${cg.totalChapters}`;
        };

        const chatDownload = (asJson) => {
            const { text, count, items } = collectChatText(app.settings.chatgen);
            if (!count) return app.log('没有可导出的内容（检查楼层范围与标签设置）', 'warn');
            const name = safeFileName(globalThis.SillyTavern?.getContext?.()?.name2 || 'chat');
            if (asJson) downloadFile(JSON.stringify(items, null, 2), `${name}-小说.json`);
            else downloadFile(text, `${name}-小说.txt`, 'text/plain');
            app.log(`📤 已导出 ${count} 条消息`, 'success');
        };


        const onClick = async (e) => {
            const go = e.target.closest('[data-goto]');
            if (go) return switchTab(go.dataset.goto);
            const btn = e.target.closest('[data-act]');
            if (!btn) return;
            const p = app.project;
            switch (btn.dataset.act) {
                case 'api-start':
                    if (app.isBusy()) return app.log('已有任务在运行', 'warn');
                    app.continuation.run({ direction: app.settings.continuation.direction }).then(render).catch((err) => app.log(err.message, 'error'));
                    return;
                case 'api-pause':
                    return app.continuation.running && app.continuation.pause();
                case 'api-stop':
                    return app.continuation.stop();
                case 'api-preview': {
                    const no = countSourceChapters(p) + p.continuation.chapters.length + 1;
                    const plan = app.settings.continuation.followPlan !== false ? planForChapter(p, no) : null;
                    const title = plan?.title ? `第${no}章 ${plan.title}` : `第${no}章`;
                    const { system, prompt } = buildContinuePrompt(p, app.settings, { title, words: app.settings.continuation.wordsPerChapter, direction: app.settings.continuation.direction, plan, upcoming: plan ? upcomingPlans(p, no, 2) : [] });
                    await openDialog({ title: '续写提示词预览', wide: true, body: chainPreviewHtml(app.settings, 'continue', { system, prompt, book: p.bookName }) });
                    return;
                }
                case 'export-gen':
                    if (!p.continuation.chapters.length) return app.log('还没有续写章节', 'warn');
                    return downloadFile(exportContinuationText(p), `${safeFileName(p.bookName)}-续写.txt`, 'text/plain');
                case 'export-all':
                    return downloadFile(exportContinuationText(p, { includeSource: true }), `${safeFileName(p.bookName)}-原文+续写.txt`, 'text/plain');
                case 'view-gen': {
                    const ch = p.continuation.chapters.find((c) => c.id === btn.dataset.id);
                    if (!ch) return;
                    const povChar = p.plan?.chapters.find((x) => x.id === ch.planId)?.pov || '';
                    const { value, root } = await openDialog({
                        title: ch.title,
                        wide: true,
                        body: `${(() => {
                            const hits = checkBanned(ch.content, p, app.settings, 'continue', povChar);
                            return hits.length ? `<details class="nl-lint-box"><summary class="nl-warn">${icon('alert', { size: 14 })} ${hits.length} 处禁用词</summary>${hits.map((h) => `<div class="nl-lint nl-lint-error"><b>${esc(h.match)}</b>：${esc(h.context)} <span class="nl-muted">→ ${esc(h.tip)}</span></div>`).join('')}</details>` : '';
                        })()}<textarea class="nl-input nl-textarea nl-tall">${esc(ch.content)}</textarea>
                        <div class="nl-row nl-wrap" style="margin-top:6px">
                            <button class="nl-btn nl-sm" data-act="rewrite-sel">${icon('edit', { size: 14 })}AI 重写选中部分</button>
                            <span class="nl-muted nl-small">先在上面的正文里选中要重写的一段，再点这个按钮</span>
                        </div>
                        <div class="nl-muted nl-small">修改后如已回灌，请到「分段」页对对应分段点“重提”。</div>
                        <div class="nl-row nl-wrap" style="margin-top:10px">
                            <button class="nl-btn nl-sm" data-act="check-continuity">${icon('search', { size: 14 })}连续性检查</button>
                            <span class="nl-muted nl-small">核对已保存的正文有没有和已建立的角色档案、世界设定打架；如果改了上面的文本，先点“保存”再检查</span>
                        </div>
                        <div data-continuity-box style="margin-top:6px">${continuityBoxHtml(ch.continuityCheck)}</div>`,
                        buttons: [{ label: '关闭', value: null }, { label: '保存', value: 'ok', primary: true }],
                        onMount: (bodyEl) => {
                            const ta = bodyEl.querySelector('textarea');
                            const rewriteBtn = bodyEl.querySelector('[data-act="rewrite-sel"]');
                            rewriteBtn.addEventListener('click', async () => {
                                const start = ta.selectionStart;
                                const end = ta.selectionEnd;
                                if (start === end) return app.log('请先在正文里选中要重写的一段', 'warn');
                                const instruction = await promptDialog('重写要求', '', {
                                    title: 'AI 重写选中部分',
                                    multiline: true,
                                    placeholder: '例如：加入更多环境描写；让对话更冷淡一点；补一段心理活动',
                                });
                                if (!instruction?.trim()) return;
                                if (app.isBusy()) return app.log('已有任务在运行', 'warn');
                                const api = app.settings.continueApi?.enabled ? app.settings.continueApi : app.settings.api;
                                await busy(rewriteBtn, async () => {
                                    const res = await rewriteSelection(p, app.settings, { text: ta.value, start, end, instruction, api, task: 'continue', povChar });
                                    ta.value = res.text;
                                    ta.focus();
                                    ta.setSelectionRange(res.start, res.end);
                                    app.log(`✏️ 已重写选中部分（${res.rewritten.length} 字）${res.bannedHits ? `，仍有 ${res.bannedHits} 处禁用词` : ''}`, res.bannedHits ? 'warn' : 'success');
                                }, 'AI 重写中…');
                            });
                            const continuityBtn = bodyEl.querySelector('[data-act="check-continuity"]');
                            const continuityBox = bodyEl.querySelector('[data-continuity-box]');
                            continuityBtn.addEventListener('click', async () => {
                                if (app.isBusy()) return app.log('已有任务在运行', 'warn');
                                await busy(continuityBtn, async () => {
                                    const issues = await checkContinuity(p, app.settings, ch.id);
                                    await app.saveNow();
                                    continuityBox.innerHTML = continuityBoxHtml(ch.continuityCheck);
                                    app.log(issues.length ? `🔍 ${ch.title}：发现 ${issues.length} 处疑似连续性矛盾` : `🔍 ${ch.title}：未发现明显矛盾`, issues.length ? 'warn' : 'success');
                                }, '核对中…');
                            });
                        },
                    });
                    if (value !== 'ok') return;
                    setChapterContent(p, ch, root.querySelector('textarea').value);
                    await app.saveNow();
                    return render();
                }
                case 'goto-style':
                    e.preventDefault();
                    return switchTab('style');
                case 'reroll-chapter': {
                    const ch = p.continuation.chapters.find((c) => c.id === btn.dataset.id);
                    if (!ch) return;
                    if (app.isBusy()) return app.log('已有任务在运行', 'warn');
                    if (!(await confirmDialog(`整章重新生成「${ch.title}」？原来的正文会被替换${ch.chunkId ? '，已回灌的分段会标记为待重新提取' : ''}。`))) return;
                    await createSnapshot(p, `重新生成「${ch.title}」前`);
                    await busy(btn, async () => {
                        await regenerateChapter(p, app.settings, ch.id, { onLog: (m, l) => app.log(m, l) });
                        await app.saveNow();
                        app.log(`🎲 「${ch.title}」已重新生成`, 'success');
                    }, '重新生成中…');
                    return render();
                }
                case 'ban-replace': {
                    const ch = p.continuation.chapters.find((c) => c.id === btn.dataset.id);
                    if (!ch) return;
                    const r = replaceBanned(ch.content, bannedListFor(p, app.settings, 'continue'));
                    if (!r.count) return app.log('命中的禁用词都没有替换建议（在「文风」页用“词=>建议”的格式添加），可以用 AI 修正', 'warn');
                    setChapterContent(p, ch, r.text);
                    await app.saveNow();
                    app.log(`🔧 ${ch.title}：已替换 ${r.count} 处`, 'success');
                    return render();
                }
                case 'ban-fix': {
                    const ch = p.continuation.chapters.find((c) => c.id === btn.dataset.id);
                    if (!ch) return;
                    if (app.isBusy()) return app.log('已有任务在运行', 'warn');
                    const hits = checkBanned(ch.content, p, app.settings, 'continue');
                    const api = app.settings.continueApi?.enabled ? app.settings.continueApi : app.settings.api;
                    const text = await busy(btn, () => fixBannedInText(ch.content, hits, p, app.settings, { api }), 'AI 修正中…');
                    if (!text) return;
                    setChapterContent(p, ch, text);
                    await app.saveNow();
                    const left = checkBanned(text, p, app.settings, 'continue').length;
                    app.log(`🔧 ${ch.title} 已修正${left ? `，仍剩 ${left} 处` : '，禁用词已清除'}`, left ? 'warn' : 'success');
                    return render();
                }
                case 'del-gen': {
                    const ch = p.continuation.chapters.find((c) => c.id === btn.dataset.id);
                    if (!(await confirmDialog(`删除「${ch.title}」？回灌到资料库的内容也会一并清除。`, { danger: true, okLabel: '删除' }))) return;
                    const chunk = p.chunks.find((c) => c.id === ch.chunkId);
                    if (chunk) deleteChunkAt(p, chunk.index);
                    p.continuation.chapters.splice(p.continuation.chapters.indexOf(ch), 1);
                    unmarkPlanWritten(p, ch.id);
                    await app.saveNow();
                    return render();
                }
                case 'cg-start':
                    if (app.isBusy()) return app.log('已有任务在运行', 'warn');
                    app.chatgen.run().then(render).catch((err) => app.log(err.message, 'error'));
                    return;
                case 'cg-pause':
                    return app.chatgen.pause();
                case 'cg-stop':
                    app.chatgen.stop();
                    return render();
                case 'cg-reset':
                    if (!(await confirmDialog('把挂机进度归零？'))) return;
                    app.chatgen.reset();
                    chatProgress = null;
                    return render();
                case 'chat-preview': {
                    const { text, count } = collectChatText(app.settings.chatgen);
                    await openDialog({ title: `预览（${count} 条，${formatNumber(text.length)} 字）`, wide: true, body: `<div class="nl-pre nl-small">${esc(text.slice(0, 5000))}${text.length > 5000 ? '\n…' : ''}</div>` });
                    return;
                }
                case 'chat-txt':
                    return chatDownload(false);
                case 'chat-json':
                    return chatDownload(true);
                case 'chat-to-project': {
                    const { items } = collectChatText(app.settings.chatgen);
                    const ai = items.filter((x) => x.role === 'assistant');
                    if (!ai.length) return app.log('没有可加入的 AI 回复', 'warn');
                    if (!(await confirmDialog(`把 ${ai.length} 条 AI 回复加入项目（作为“聊天”分段，每条一段）？之后可在「提取」页提取。`))) return;
                    for (const x of ai) app.addChatChunk(x.text, `聊天 #${x.floor}`);
                    await app.saveNow();
                    app.log(`📥 已加入 ${ai.length} 段聊天内容`, 'success');
                    return switchTab('chunks');
                }
                default:
                    break;
            }
        };

        el.addEventListener('click', onClick);
        const offs = [
            app.events.on('continue:progress', (pr) => {
                apiProgress = pr;
                if (pr.finished) render();
                else updateBars();
            }),
            app.events.on('continue:chapter', () => render()),
            app.events.on('chatgen:progress', (pr) => {
                chatProgress = pr;
                updateBars();
            }),
            app.events.on('chatgen:chapter', () => updateBars()),
        ];
        render();
        return { destroy: () => offs.forEach((f) => f()) };
    },
};
