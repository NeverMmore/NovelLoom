// 提取页：模式与参数、分类开关、运行控制、进度

import { app } from '../app.js';
import { buildExtractPrompt, knownContextFor, resetExtractionFrom } from '../extract.js';
import { getVolumes, projectStats, volumeOf } from '../project.js';
import { API_MODES } from '../llm.js';
import { createSnapshot } from '../store.js';
import { formatDuration, formatNumber } from '../utils.js';
import { bindSettings, busy, chainPreviewHtml, esc, icon, openDialog, optionList, qs } from './common.js';

const MODES = [
    { value: 'serial', label: '串行 · 滚动累积（最连贯，推荐）' },
    { value: 'batch', label: '分批 · 批内并行、批间累积（较快）' },
    { value: 'parallel', label: '并行 · 各段独立（最快，重复较多）' },
];

export const extractTab = {
    mount(el, { switchTab }) {
        let progress = null;

        const apiSummary = () => {
            const a = app.settings.api;
            const mode = API_MODES.find((m) => m.value === a.mode)?.label || a.mode;
            if (a.mode === 'profile') {
                const prof = globalThis.SillyTavern?.getContext?.()?.extensionSettings?.connectionManager?.profiles?.find((x) => x.id === a.profileId);
                return `${mode}：${prof ? prof.name : '未选择'}`;
            }
            if (a.mode === 'tavern') return mode;
            return `${mode}：${a.model || '未填写模型'}`;
        };

        const volInfo = () => {
            const vols = getVolumes(app.project).filter((v) => !v.implicit);
            if (!vols.length) return '未分卷';
            const next = app.project.chunks.find((c) => c.status !== 'done');
            return next ? `共 ${vols.length} 卷 · 下一段属于「${volumeOf(app.project, next.index).name}」` : `共 ${vols.length} 卷`;
        };

        const render = () => {
            const p = app.project;
            const st = projectStats(p);
            const start = app.pendingStartIndex;
            el.innerHTML = `
            <section class="nl-card">
                <div class="nl-row nl-wrap">
                    <span>API：<b>${esc(apiSummary())}</b></span>
                    <button class="nl-btn nl-sm" data-goto="settings">更改</button>
                    <span class="nl-spacer"></span>
                    <span class="nl-muted">已提取 ${st.done}/${st.chunks} 段 · 失败 ${st.error} · 调用 ${p.stats.calls} 次 · 约 ${formatNumber(Math.round((p.stats.promptChars + p.stats.completionChars) * 0.8))} tokens</span>
                </div>
            </section>

            <section class="nl-card">
                <div class="nl-card-head">
                    <div><h3>提取设置</h3></div>
                </div>
                <div class="nl-grid2">
                    <div class="nl-field"><label>处理模式</label><select class="nl-input" data-setting="extraction.mode">${optionList(MODES)}</select></div>
                    <div class="nl-field"><label>并发数 / 每批段数（并行、分批模式）</label><input class="nl-input" type="number" min="1" max="10" data-setting="extraction.concurrency"></div>
                    <div class="nl-field"><label>“已知资料”注入上限（字）</label><input class="nl-input" type="number" min="0" step="500" data-setting="extraction.contextBudget"></div>
                    <div class="nl-field"><label>每完成 N 段自动快照（0 关闭）</label><input class="nl-input" type="number" min="0" data-setting="extraction.autoSnapshotEvery"></div>
                </div>
                <div class="nl-row nl-wrap nl-checks">
                    <label><input type="checkbox" data-setting="extraction.extractOutline"> 章节概要与重要章节</label>
                    <label><input type="checkbox" data-setting="extraction.extractStyle"> 文风</label>
                    <label><input type="checkbox" data-setting="extraction.extractQuotes"> 角色原文台词</label>
                    <label title="引用必须能在原文中逐字找到，否则丢弃"><input type="checkbox" data-setting="extraction.verifyQuotes"> 引用逐字校验</label>
                </div>
                <div class="nl-field"><label>分类（勾选即提取；<span class="nl-dot nl-info"></span> 常驻 / <span class="nl-dot nl-ok"></span> 关键词触发，详细配置见设置页）</label>
                    <div class="nl-row nl-wrap nl-checks">
                        ${app.settings.categories.map((c, i) => `<label><input type="checkbox" data-cat="${i}" ${c.enabled ? 'checked' : ''}> ${c.constant ? '<span class="nl-dot nl-info" role="img" aria-label="常驻" title="常驻"></span>' : '<span class="nl-dot nl-ok" role="img" aria-label="关键词触发" title="关键词触发"></span>'} ${esc(c.name)}</label>`).join('')}
                    </div>
                </div>
                <details ${app.settings.extraction.volumeMode || getVolumes(p).some((v) => !v.implicit) ? 'open' : ''}>
                    <summary>分卷模式 ${app.settings.extraction.volumeMode ? `<span class="nl-tag nl-ok">已开启 · ${volInfo()}</span>` : ''}</summary>
                    <div class="nl-muted nl-small">长篇小说推荐开启。开启后提取时只把<b>本卷</b>出现过的角色与条目列入“已知资料”，并附上前几卷的卷梗概作为前情提要，提示词不会随全书增长而失控；遇到上下文超限会自动从当前段开新卷并重试。分卷可在「分段」页按“第X卷”标题自动识别或手动设置。</div>
                    <div class="nl-row nl-wrap nl-checks">
                        <label><input type="checkbox" data-setting="extraction.volumeMode"> 开启分卷模式</label>
                        <label><input type="checkbox" data-setting="extraction.volumeOnOverflow"> 接口报上下文超限时自动分卷并重试</label>
                        <label><input type="checkbox" data-setting="extraction.volumeAutoSummary"> 每卷结束自动生成卷梗概</label>
                    </div>
                    <div class="nl-field"><label>提示词预估超过多少 tokens 时自动开新卷（0 = 不按阈值，只在报错时分卷）</label><input class="nl-input nl-inline" type="number" min="0" step="1000" data-setting="extraction.volumeTokenLimit"></div>
                </details>
                <details>
                    <summary>高级</summary>
                    <div class="nl-field"><label>过滤标签（移除 AI 输出中的思考内容，逗号分隔）</label><input class="nl-input" data-setting="extraction.filterTags"></div>
                    <div class="nl-field"><label>附加要求（追加到每次提取的提示词末尾）</label><textarea class="nl-input nl-textarea" rows="3" data-setting="extraction.suffixPrompt" placeholder="例如：主角叫“我”时，统一记为“林默”"></textarea></div>
                </details>
            </section>

            <section class="nl-card">
                <div class="nl-row nl-wrap">
                    <button class="nl-btn nl-primary" data-act="start">${st.done ? '继续提取' : '开始提取'}</button>
                    <button class="nl-btn" data-act="pause">暂停</button>
                    <button class="nl-btn nl-danger" data-act="stop">停止</button>
                    <button class="nl-btn" data-act="retry" ${st.error ? '' : 'disabled'}>只重试失败段（${st.error}）</button>
                    <button class="nl-btn" data-act="reextract" ${st.done + st.error ? 'title="清除已提取的结果，从头或从某一段起重新提取"' : 'disabled title="还没有提取过的分段"'}>重新提取…</button>
                    <button class="nl-btn" data-act="preview">预览下一段提示词</button>
                    ${Number.isFinite(start) ? `<span class="nl-tag">从第 ${start + 1} 段开始 <a href="#" data-act="clear-start" title="取消" aria-label="取消">${icon('close', { size: 12 })}</a></span>` : ''}
                </div>
                <div class="nl-progress"><div class="nl-progress-bar" style="width:0%"></div><span class="nl-progress-text"></span></div>
                <div class="nl-muted nl-small">提示：串行模式会把前文已提取的角色档案与条目注入后续段落，让资料“滚动累积”；随时可以暂停，进度自动保存，下次继续。</div>
            </section>`;
            bindSettings(el, app.settings, () => app.saveSettings());
            updateProgress();
        };

        const updateProgress = () => {
            const bar = qs(el, '.nl-progress-bar');
            const txt = qs(el, '.nl-progress-text');
            if (!bar) return;
            const p = app.project;
            const st = projectStats(p);
            if (progress && app.extraction.running) {
                const pct = progress.total ? Math.round(((progress.finished + progress.failed) / progress.total) * 100) : 0;
                const elapsed = Date.now() - progress.started;
                const per = progress.finished ? elapsed / progress.finished : 0;
                const eta = per ? per * (progress.total - progress.finished - progress.failed) : 0;
                bar.style.width = `${pct}%`;
                txt.textContent = `本次 ${progress.finished + progress.failed}/${progress.total} · 用时 ${formatDuration(elapsed)}${eta ? ` · 预计剩余 ${formatDuration(eta)}` : ''}`;
            } else {
                const pct = st.chunks ? Math.round((st.done / st.chunks) * 100) : 0;
                bar.style.width = `${pct}%`;
                txt.textContent = `总进度 ${st.done}/${st.chunks}（${pct}%）`;
            }
        };

        const start = (opt = {}) => {
            if (app.isBusy()) return app.log('已有任务在运行', 'warn');
            const startIndex = app.pendingStartIndex;
            delete app.pendingStartIndex;
            app.extraction.run({ startIndex, ...opt }).then(() => render()).catch((e) => app.log(e.message, 'error'));
        };

        /** 重新提取：选择范围 → 快照 → 清除这些段的提取结果 → 按原流程开始提取 */
        const reextract = async (btn) => {
            if (app.isBusy()) return app.log('已有任务在运行', 'warn');
            const p0 = app.project;
            if (!p0?.chunks.length) return;
            const firstTodo = p0.chunks.find((c) => c.status !== 'done');
            const chunkLabel = (c) => {
                const t = c.title.length > 24 ? `${c.title.slice(0, 24)}…` : c.title;
                const s = c.status === 'done' ? '' : c.status === 'error' ? '（失败）' : '（未提取）';
                return `#${c.index + 1} ${t}${s}`;
            };
            const mode = app.settings.extraction.mode;
            const modeName = (MODES.find((m) => m.value === mode)?.label || mode).split(' · ')[0];
            const tip = mode === 'serial'
                ? '<div class="nl-muted nl-small">当前是串行模式：前文资料逐段累积，结果最连贯，角色最不容易混在一起。</div>'
                : `<label><input type="checkbox" data-f="serial"> 这次改用串行模式（当前为「${esc(modeName)}」；串行最连贯，角色最不容易混在一起）</label>`;
            const { value, root } = await openDialog({
                title: '重新提取',
                body: `
                    <div class="nl-field" role="radiogroup" aria-label="重新提取范围">
                        <div class="nl-row"><label class="nl-row"><input type="radio" name="nl-reex-scope" value="all" checked> 全部重新提取（共 ${p0.chunks.length} 段）</label></div>
                        <div class="nl-row nl-wrap">
                            <label class="nl-row"><input type="radio" name="nl-reex-scope" value="from"> 从</label>
                            <select class="nl-input nl-inline" data-f="from" aria-label="从哪一段起重新提取">${optionList(p0.chunks.map((c) => ({ value: c.index, label: chunkLabel(c) })), firstTodo ? firstTodo.index : 0)}</select>
                            <span>这一段起重新提取</span>
                        </div>
                        <div class="nl-muted nl-small" data-reex-count></div>
                    </div>
                    <div class="nl-field nl-small">
                        <div><b>会清除：</b>这些分段提取出的角色经历、原文台词和对话示例、由这些分段带进来的别名，世界书条目的修订，章节概要。只出自这些分段的角色和条目会先被删除、再重新提取出来；角色的身份、性格、关系描述退回到这些分段之前的版本（你手动改过的不会被退回，但重新提取时 AI 可能再次改写——想原样保留，请先在「角色」页锁定该角色）。</div>
                        <div><b>会保留：</b>手动新建或已锁定的角色和条目、人物关系（含 AI 分析出的）、群聊场景卡、视角文风、已经填写的待核实名称、角色卡、续写章节、文风设置。</div>
                        <div class="nl-muted">旧版本提取出的别名没有出处记录，不会被清掉：如果某个角色已经混进了别人的名字，先在「角色」页删掉它（或编辑别名）再重新提取，最彻底的是「全部重新提取」。</div>
                        <div class="nl-muted">开始前会自动保存快照「重新提取前」，不满意可以在「世界书 → 修改历史」中恢复（含分段的提取状态和关系）。</div>
                    </div>
                    <div class="nl-field"><div>${tip}</div></div>`,
                buttons: [{ label: '取消', value: null }, { label: '重新提取', value: 'ok', danger: true }],
                onMount: (body) => {
                    const sel = body.querySelector('[data-f="from"]');
                    const fromRadio = body.querySelector('input[name="nl-reex-scope"][value="from"]');
                    const count = body.querySelector('[data-reex-count]');
                    const update = () => {
                        const from = fromRadio.checked ? Number(sel.value) : 0;
                        const list = p0.chunks.filter((c) => c.index >= from);
                        const done = list.filter((c) => c.status === 'done').length;
                        count.textContent = `将重置 ${list.length} 段（其中 ${done} 段已提取过），然后重新提取。`;
                    };
                    const pickFrom = () => {
                        fromRadio.checked = true;
                        update();
                    };
                    sel.addEventListener('pointerdown', pickFrom);
                    sel.addEventListener('change', pickFrom);
                    body.addEventListener('change', (e) => e.target.name === 'nl-reex-scope' && update());
                    update();
                },
            });
            if (value !== 'ok') return;
            if (app.isBusy()) return app.log('已有任务在运行', 'warn');
            const p = app.project;
            if (p !== p0) return;
            const from = root.querySelector('input[name="nl-reex-scope"]:checked')?.value === 'from' ? Number(root.querySelector('[data-f="from"]').value) || 0 : 0;
            const serial = !!root.querySelector('[data-f="serial"]')?.checked;
            const ok = await busy(btn, async () => {
                await createSnapshot(p, '重新提取前');
                const n = resetExtractionFrom(p, from);
                delete app.pendingStartIndex;
                await app.saveNow();
                app.log(`🔁 已清除${from ? `第 ${from + 1} 段起` : '全部'} ${n} 段的提取结果，开始重新提取`, 'info');
                return true;
            }, '准备中…');
            if (!ok) return;
            if (el.isConnected) render();
            start({ startIndex: from, ...(serial ? { mode: 'serial' } : {}) });
        };

        const onClick = async (e) => {
            const btn = e.target.closest('[data-act], [data-goto]');
            if (!btn) return;
            if (btn.dataset.goto) return switchTab(btn.dataset.goto);
            e.preventDefault();
            switch (btn.dataset.act) {
                case 'start':
                    return start();
                case 'pause':
                    return app.extraction.running && app.extraction.pause();
                case 'stop':
                    return app.extraction.stop();
                case 'retry': {
                    const ids = app.project.chunks.filter((c) => c.status === 'error').map((c) => c.id);
                    return start({ chunkIds: ids });
                }
                case 'reextract':
                    return reextract(btn);
                case 'clear-start':
                    delete app.pendingStartIndex;
                    return render();
                case 'preview': {
                    const p = app.project;
                    const chunk = p.chunks.find((c) => c.status !== 'done') || p.chunks[0];
                    if (!chunk) return;
                    const known = app.settings.extraction.mode === 'parallel' ? knownContextFor(p, app.settings, chunk, '', 2500) : knownContextFor(p, app.settings, chunk, chunk.content);
                    const { system, prompt } = buildExtractPrompt(p, app.settings, chunk, known);
                    await openDialog({
                        title: `提示词预览：#${chunk.index + 1} ${chunk.title}`,
                        wide: true,
                        body: chainPreviewHtml(app.settings, 'extract', { system, prompt, book: p.bookName }),
                    });
                    return;
                }
                default:
                    break;
            }
        };

        const onChange = (e) => {
            if (e.target.dataset.cat !== undefined) {
                app.settings.categories[Number(e.target.dataset.cat)].enabled = e.target.checked;
                app.saveSettings();
            }
        };

        el.addEventListener('click', onClick);
        el.addEventListener('change', onChange);
        const offs = [
            app.events.on('volume', () => render()),
            app.events.on('extract:progress', (pr) => {
                progress = pr;
                if (pr.done) render();
                else updateProgress();
            }),
        ];
        render();
        return { destroy: () => offs.forEach((f) => f()) };
    },
};
