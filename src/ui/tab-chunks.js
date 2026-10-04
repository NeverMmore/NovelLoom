// 分段页：章节分块查看、编辑、合并、删除、重新分段

import { app } from '../app.js';
import { CHAPTER_REGEX_PRESETS } from '../constants.js';
import { removeChunkContributions } from '../extract.js';
import { addVolumeAt, chunkOutlineText, deleteChunkAt, detectVolumesFromChunks, getVolumes, mergeChunkWithNext, removeVolume, volumeRangeLabel } from '../project.js';
import { buildVolumeSummary } from '../tools.js';
import { rewriteSelection } from '../rewrite.js';
import { createSnapshot } from '../store.js';
import { formatNumber, truncate } from '../utils.js';
import { bindSettings, busy, confirmDialog, emptyState, esc, icon, openDialog, optionList, promptDialog, qs, qsa, rerollBtn, statusIcon } from './common.js';

const ORIGIN = { source: '原文', generated: '续写', chat: '聊天', mixed: '混合' };

export const chunksTab = {
    mount(el, { switchTab }) {
        let filter = 'all';
        let selecting = false;
        const selected = new Set();

        const render = () => {
            const p = app.project;
            const chunks = p.chunks.filter((c) => filter === 'all' || c.status === filter || (filter === 'generated' && c.origin !== 'source'));
            const vols = getVolumes(p).filter((v) => !v.implicit);
            const volHead = (c) => {
                const v = vols.find((x) => x.startChunk === c.index);
                if (!v) return '';
                const cs = p.chunks.slice(v.startChunk, v.endChunk + 1);
                return `<div class="nl-vol-head" data-vol="${esc(v.id)}">
                    <span>${icon('overview', { size: 14 })} <b>${esc(v.name)}</b></span>
                    <span class="nl-muted nl-small">${volumeRangeLabel(v)} · 已提取 ${cs.filter((x) => x.status === 'done').length}/${cs.length}${v.auto === 'overflow' ? ' · 超限自动分卷' : ''}</span>
                    ${v.summary ? '<span class="nl-tag nl-ok">有卷梗概</span>' : ''}
                    <span class="nl-spacer"></span>
                    <button class="nl-btn nl-sm" data-act="vol-summary" data-vol="${esc(v.id)}">卷梗概</button>
                    <button class="nl-btn nl-sm" data-act="vol-rename" data-vol="${esc(v.id)}">改名</button>
                    ${v.index > 0 ? `<button class="nl-btn nl-sm" data-act="vol-remove" data-vol="${esc(v.id)}" title="并入上一卷">取消分卷</button>` : ''}
                </div>`;
            };
            el.innerHTML = `
            <section class="nl-card">
                <details>
                    <summary><b>重新分段</b> <span class="nl-muted">（会清空已提取的资料，续写章节保留）</span></summary>
                    <div class="nl-grid3">
                        <div class="nl-field"><label>章节识别</label><select class="nl-input" data-setting="chunking.regexPreset">${optionList([...CHAPTER_REGEX_PRESETS.map((x) => ({ value: x.id, label: x.name })), { value: 'custom', label: '自定义正则' }])}</select></div>
                        <div class="nl-field"><label>自定义正则</label><input class="nl-input" data-setting="chunking.customRegex"></div>
                        <div class="nl-field"><label>每段最大字数</label><input class="nl-input" type="number" min="1000" step="1000" data-setting="chunking.chunkSize"></div>
                    </div>
                    <button class="nl-btn nl-danger" data-act="rechunk">按当前设置重新分段</button>
                </details>
            </section>
            <section class="nl-card">
                <div class="nl-card-head">
                    <div>
                        <h3>分卷</h3>
                        <div class="nl-card-desc">${vols.length ? `共 ${vols.length} 卷` : '未分卷'}${app.settings.extraction.volumeMode ? ' · 分卷模式已开启' : ' · 分卷模式未开启（在提取页开启）'}</div>
                        <div class="nl-card-desc">也可以在任意一段点“分卷”，从这一段开始新的一卷。分卷后可以按卷导出世界书、按卷生成梗概；开启分卷模式后，提取时只把本卷资料注入提示词，并附上前几卷的梗概。</div>
                    </div>
                    <button class="nl-btn nl-sm" data-act="vol-detect" title="按章节标题中的「第X卷 / 第X部」分卷">按标题自动分卷</button>
                    ${vols.length ? '<button class="nl-btn nl-sm" data-act="vol-clear">清除分卷</button>' : ''}
                </div>
            </section>
            <section class="nl-card">
                <div class="nl-row nl-wrap">
                    <div class="nl-seg">
                        ${[['all', '全部'], ['pending', '待提取'], ['done', '已完成'], ['error', '失败'], ['generated', '续写/聊天']].map(([v, l]) => `<button class="nl-seg-btn ${filter === v ? 'active' : ''}" data-filter="${v}">${l}</button>`).join('')}
                    </div>
                    <span class="nl-muted">共 ${p.chunks.length} 段 · ${formatNumber(p.chunks.reduce((n, c) => n + c.charCount, 0))} 字</span>
                    <span class="nl-spacer"></span>
                    <button class="nl-btn nl-sm" data-act="toggle-select">${selecting ? '退出多选' : '多选'}</button>
                    ${selecting ? `
                        <button class="nl-btn nl-sm" data-act="select-all">全选</button>
                        <button class="nl-btn nl-sm" data-act="reset-selected">标记待提取</button>
                        <button class="nl-btn nl-sm nl-primary" data-act="extract-selected">提取所选</button>
                        <button class="nl-btn nl-sm nl-danger" data-act="delete-selected">删除所选</button>` : ''}
                </div>
                <div class="nl-chunk-list">
                    ${chunks.map((c) => `${filter === 'all' ? volHead(c) : ''}
                    <div class="nl-chunk ${c.status}" data-id="${esc(c.id)}">
                        ${selecting ? `<input type="checkbox" class="nl-chk" data-id="${esc(c.id)}" ${selected.has(c.id) ? 'checked' : ''}>` : ''}
                        <span class="nl-chunk-status" title="${esc(c.error || c.status)}">${statusIcon(c.status)}</span>
                        <div class="nl-grow" data-act="view" data-id="${esc(c.id)}">
                            <div><b>#${c.index + 1}</b> ${esc(c.title)} ${c.origin !== 'source' ? `<span class="nl-tag">${ORIGIN[c.origin] || c.origin}</span>` : ''}</div>
                            <div class="nl-muted nl-small">${formatNumber(c.charCount)} 字${c.chapterTitles?.length > 1 ? ` · ${c.chapterTitles.length} 章` : ''}${c.outline?.length ? ` · ${esc(truncate(c.outline[0].notes, 60))}` : ''}${c.status === 'error' ? ` · <span class="nl-err">${esc(truncate(c.error, 60))}</span>` : ''}</div>
                        </div>
                        <div class="nl-chunk-actions">
                            ${rerollBtn('reextract', `data-id="${esc(c.id)}"`, { label: '重提', title: '清除本段贡献后重新提取' })}
                            <button class="nl-btn nl-sm" data-act="start-here" data-id="${esc(c.id)}" title="从这一段开始提取">从此提取</button>
                            <button class="nl-btn nl-sm" data-act="merge-next" data-id="${esc(c.id)}" title="与下一段合并">${icon('merge')}合并</button>
                            ${c.index > 0 && !vols.some((v) => v.startChunk === c.index) ? `<button class="nl-btn nl-sm" data-act="split-here" data-id="${esc(c.id)}" title="从这一段开始新的一卷">${icon('split')}分卷</button>` : ''}
                        </div>
                    </div>`).join('') || (filter === 'all'
                        ? emptyState('导入小说或按上方设置重新分段后，分段会出现在这里。', '', { title: '还没有分段', ico: 'chunks' })
                        : emptyState('换一个筛选条件，或查看全部分段。', '<button class="nl-btn nl-sm" data-filter="all">查看全部</button>', { title: '没有符合条件的分段', ico: 'filter' }))}
                </div>
            </section>`;
            bindSettings(el, app.settings, () => app.saveSettings());
        };

        const find = (id) => app.project.chunks.find((c) => c.id === id);

        const viewChunk = async (chunk) => {
            const imp = (chunk.important || []).map((i) => `<li><b>${esc(i.chapter || '')}</b> ${esc(i.reason)}${(i.quotes || []).map((q) => `<blockquote>${q.verified === false ? `<span class="nl-warn" title="未能在原文中逐字找到">${icon('alert', { size: 14, label: '未能在原文中逐字找到' })}</span>` : ''}「${esc(q.text)}」</blockquote>`).join('')}</li>`).join('');
            const body = `
                <div class="nl-muted">状态：${statusIcon(chunk.status)} ${esc(chunk.status)} · ${formatNumber(chunk.charCount)} 字 · 来源：${ORIGIN[chunk.origin] || chunk.origin}</div>
                ${chunk.error ? `<div class="nl-err">错误：${esc(chunk.error)}</div>` : ''}
                ${chunk.outline?.length ? `<h4>章节概要</h4><div class="nl-pre">${esc(chunkOutlineText(chunk))}</div>` : ''}
                ${imp ? `<h4>重要章节</h4><ul>${imp}</ul>` : ''}
                ${chunk.lastRaw ? `<details><summary>最后一次 AI 原始输出</summary><div class="nl-pre nl-small">${esc(chunk.lastRaw)}</div></details>` : ''}
                <h4>正文（可编辑）</h4>
                <textarea class="nl-input nl-textarea nl-tall" id="nl-chunk-content">${esc(chunk.content)}</textarea>
                <div class="nl-row nl-wrap" style="margin-top:6px">
                    <button class="nl-btn nl-sm" data-act="rewrite-sel">${icon('edit')}AI 重写选中部分</button>
                    <span class="nl-muted nl-small">先在上面的正文里选中要重写的一段，再点这个按钮</span>
                </div>`;
            const { value, root } = await openDialog({
                title: `#${chunk.index + 1} ${chunk.title}`,
                body,
                wide: true,
                buttons: [
                    { label: '关闭', value: null },
                    { label: '保存修改', value: 'save' },
                    { label: '保存并重新提取', value: 'save-extract', primary: true },
                ],
                onMount: (bodyEl) => {
                    const ta = bodyEl.querySelector('#nl-chunk-content');
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
                        const api = app.settings.api;
                        await busy(rewriteBtn, async () => {
                            const res = await rewriteSelection(app.project, app.settings, { text: ta.value, start, end, instruction, api, task: 'continue' });
                            ta.value = res.text;
                            ta.focus();
                            ta.setSelectionRange(res.start, res.end);
                            app.log(`✏️ 已重写选中部分（${res.rewritten.length} 字）${res.bannedHits ? `，仍有 ${res.bannedHits} 处禁用词` : ''}`, res.bannedHits ? 'warn' : 'success');
                        }, 'AI 重写中…');
                    });
                },
            });
            if (!value) return;
            const text = root.querySelector('#nl-chunk-content').value;
            if (text !== chunk.content) {
                chunk.content = text;
                chunk.charCount = text.length;
            }
            await app.saveNow();
            if (value === 'save-extract') await reextract(chunk, true);
            render();
        };

        const reextract = async (chunk, askExtra = true) => {
            if (app.isBusy()) return app.log('有任务正在运行，请稍后', 'warn');
            let extra = '';
            if (askExtra) {
                extra = await promptDialog('可选：给 AI 的额外要求（如“注意区分两个姓林的角色”）', '', { title: '重新提取', multiline: true });
                if (extra === null) return;
            }
            await createSnapshot(app.project, `重新提取 #${chunk.index + 1} 前`);
            removeChunkContributions(app.project, chunk.index);
            chunk.status = 'pending';
            const prevSuffix = app.settings.extraction.suffixPrompt;
            if (extra) app.settings.extraction.suffixPrompt = `${prevSuffix || ''}\n${extra}`.trim();
            try {
                await app.extraction.run({ chunkIds: [chunk.id], mode: 'serial' });
            } finally {
                app.settings.extraction.suffixPrompt = prevSuffix;
            }
            render();
        };

        const onClick = async (e) => {
            const f = e.target.closest('[data-filter]');
            if (f) {
                filter = f.dataset.filter;
                return render();
            }
            if (e.target.classList.contains('nl-chk')) {
                const id = e.target.dataset.id;
                if (e.target.checked) selected.add(id);
                else selected.delete(id);
                return;
            }
            const btn = e.target.closest('[data-act]');
            if (!btn) return;
            const chunk = btn.dataset.id ? find(btn.dataset.id) : null;
            const p = app.project;
            const vol = btn.dataset.vol ? p.volumes.find((v) => v.id === btn.dataset.vol) : null;
            switch (btn.dataset.act) {
                case 'split-here': {
                    const name = await promptDialog('新卷名称（留空自动编号）', '', { title: `从第 ${chunk.index + 1} 段开始新的一卷` });
                    if (name === null) return;
                    const v = addVolumeAt(p, chunk.index, { name: name.trim(), auto: 'manual' });
                    if (name.trim()) v.defaultName = false;
                    await app.saveNow();
                    app.log(`📦 已从第 ${chunk.index + 1} 段开始「${v.name}」`, 'success');
                    return render();
                }
                case 'vol-detect': {
                    const n = detectVolumesFromChunks(p);
                    await app.saveNow();
                    app.log(n ? `📦 按标题识别到 ${n} 卷` : '没有在章节标题中找到「第X卷 / 第X部」，可以手动分卷', n ? 'success' : 'warn');
                    return render();
                }
                case 'vol-clear':
                    if (!(await confirmDialog('清除全部分卷？（卷梗概也会一并删除，已提取的资料不受影响）'))) return;
                    p.volumes = [];
                    await app.saveNow();
                    return render();
                case 'vol-rename': {
                    const name = await promptDialog('卷名', vol.name, { title: '重命名卷' });
                    if (!name?.trim()) return;
                    vol.name = name.trim();
                    vol.defaultName = false;
                    await app.saveNow();
                    return render();
                }
                case 'vol-remove':
                    if (!(await confirmDialog(`取消「${vol.name}」？这一卷会并入上一卷。`))) return;
                    removeVolume(p, vol.id);
                    await app.saveNow();
                    return render();
                case 'vol-summary': {
                    const { value, root } = await openDialog({
                        title: `卷梗概：${vol.name}`,
                        wide: true,
                        body: `<div class="nl-muted nl-small">卷梗概会作为后续卷的“前情提要”，也用于角色卡、写大纲和续写的剧情背景。</div><textarea class="nl-input nl-textarea" rows="10" data-f="sum">${esc(vol.summary || '')}</textarea>`,
                        buttons: [{ label: '取消', value: null }, { label: 'AI 生成', value: 'ai' }, { label: '保存', value: 'save', primary: true }],
                    });
                    if (value === 'save') vol.summary = root.querySelector('[data-f="sum"]').value.trim();
                    if (value === 'ai') {
                        await busy(null, async () => {
                            app.log(`🧭 生成「${vol.name}」卷梗概…`);
                            await buildVolumeSummary(p, app.settings, vol.id, { onLog: (m) => app.log(m) });
                            app.log(`🧭 「${vol.name}」卷梗概已生成`, 'success');
                        });
                    }
                    if (value) await app.saveNow();
                    return render();
                }
                case 'view':
                    if (selecting) {
                        const cb = qs(el, `.nl-chk[data-id="${chunk.id}"]`);
                        cb.checked = !cb.checked;
                        if (cb.checked) selected.add(chunk.id);
                        else selected.delete(chunk.id);
                        return;
                    }
                    return viewChunk(chunk);
                case 'reextract':
                    return reextract(chunk);
                case 'start-here':
                    if (app.isBusy()) return app.log('有任务正在运行', 'warn');
                    app.pendingStartIndex = chunk.index;
                    switchTab('extract');
                    return;
                case 'merge-next': {
                    if (app.isBusy()) return app.log('有任务正在运行', 'warn');
                    if (chunk.index >= p.chunks.length - 1) return;
                    const ok = await confirmDialog(`把 #${chunk.index + 1} 与 #${chunk.index + 2} 合并为一段？已提取的资料会保留并重新编号。`);
                    if (!ok) return;
                    mergeChunkWithNext(p, chunk.index);
                    await app.saveNow();
                    return render();
                }
                case 'toggle-select':
                    selecting = !selecting;
                    selected.clear();
                    return render();
                case 'select-all':
                    qsa(el, '.nl-chk').forEach((cb) => {
                        cb.checked = true;
                        selected.add(cb.dataset.id);
                    });
                    return;
                case 'reset-selected':
                    for (const id of selected) {
                        const c = find(id);
                        if (c) c.status = 'pending';
                    }
                    await app.saveNow();
                    return render();
                case 'extract-selected': {
                    if (app.isBusy()) return app.log('有任务正在运行', 'warn');
                    const ids = [...selected];
                    if (!ids.length) return;
                    switchTab('extract');
                    app.extraction.run({ chunkIds: ids }).catch((err) => app.log(err.message, 'error'));
                    return;
                }
                case 'delete-selected': {
                    if (app.isBusy()) return app.log('有任务正在运行', 'warn');
                    if (!selected.size) return;
                    const ok = await confirmDialog(`删除所选 ${selected.size} 段？这些段落贡献的资料会一并清除。`, { danger: true, okLabel: '删除' });
                    if (!ok) return;
                    await createSnapshot(p, '删除分段前');
                    const idxs = [...selected].map((id) => find(id)?.index).filter((x) => x !== undefined).sort((a, b) => b - a);
                    for (const i of idxs) deleteChunkAt(p, i);
                    selected.clear();
                    await app.saveNow();
                    return render();
                }
                case 'rechunk': {
                    if (app.isBusy()) return app.log('有任务正在运行', 'warn');
                    const ok = await confirmDialog('重新分段会清空所有已提取的角色、世界书与大纲（续写章节与角色卡保留）。建议先创建快照或导出任务。继续？', { danger: true, okLabel: '重新分段' });
                    if (!ok) return;
                    await busy(btn, async () => {
                        await createSnapshot(p, '重新分段前');
                        await app.rechunk(app.getSourceText());
                        app.log(`✂️ 已重新分段：${app.project.chunks.length} 段`, 'success');
                    });
                    return render();
                }
                default:
                    break;
            }
        };

        el.addEventListener('click', onClick);
        const off = app.events.on('chunk', (c) => {
            const row = qs(el, `.nl-chunk[data-id="${c.id}"]`);
            if (row) {
                row.className = `nl-chunk ${c.status}`;
                const s = row.querySelector('.nl-chunk-status');
                if (s) s.innerHTML = statusIcon(c.status);
            }
        });
        render();
        if (app.pendingChunkId) {
            const c = find(app.pendingChunkId);
            delete app.pendingChunkId;
            if (c) viewChunk(c);
        }
        return { destroy: off };
    },
};
