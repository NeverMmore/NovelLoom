// 大纲页：故事梗概、文风概览、章节概要、重要章节、待确认名称（含 AI 推断名称）

import { app } from '../app.js';
import { exportCharactersText, exportOutline } from '../io.js';
import {
    CONFIDENCE_LABELS,
    RESOLVED_BY_LABELS,
    SOURCE_LABELS,
    SOURCE_TITLES,
    buildResolveNamesPrompt,
    fillTopCandidates,
    nameResolveOptions,
    namesToResolve,
    normalizeNameResolve,
    pickCandidate,
    prepareNameItems,
    resolveMissingNames,
    resolvedByOf,
    riskyResolved,
    selectedCandidateIndex,
    typeResolved,
} from '../names.js';
import { createSnapshot, saveProject } from '../store.js';
import { buildStorySummary, buildVolumeSummary, findReplace } from '../tools.js';
import { getVolumes, volumeRangeLabel } from '../project.js';
import { isAbortError, truncate, uniq } from '../utils.js';
import { busy, chainPreviewHtml, confirmDialog, emptyState, esc, icon, openDialog, optionList, qs, rerollBtn } from './common.js';
import { PROJECT_STYLE_ID, STYLE_TASKS, listStyleChoices, parseBanned, resolveStyleId } from '../style.js';

// ---------------- 待确认名称 ----------------

// 正在进行的「AI 推断名称」放在 app.nameJob（切到别的页再回来仍能看到进度，也不会重复发起；回退快照时要检查）：
// items：正在推断的行（对象引用，行被删掉/重排也不会认错）；full：整批推断（标题栏显示进度与停止），否则是某一行的「换一批」；
// origin：从哪个按钮发起的（结束后把键盘焦点放回去）

/** 刚结束的推断是从哪个按钮发起的：只在结束那一刻的重绘里用一次 */
let lastOrigin = null;

/** 这个项目正在进行的推断（没有则 null） */
const jobOf = (p) => (app.nameJob && app.nameJob.projectId === p?.id ? app.nameJob : null);

function candTitle(c) {
    return [
        `${SOURCE_TITLES[c.source] || c.source} · ${CONFIDENCE_LABELS[c.confidence] || c.confidence}`,
        c.ref ? `对应：${c.ref}` : '',
        c.reason ? `理由：${c.reason}` : '',
        c.evidence ? `原文：「${c.evidence}」` : '',
    ].filter(Boolean).join('\n');
}

function srcBadge(source) {
    return `<span class="nl-mn-src nl-mn-src-${esc(source)}">${esc(SOURCE_LABELS[source] || source)}</span>`;
}

/** 确认名称的来源标记：AI 填入（未确认）/ 已选（点选候选）/ 手动 */
function byTagHtml(m) {
    const by = resolvedByOf(m);
    if (!by) return '';
    const title = { ai: 'AI 自动填入，还没经过你确认；点一下对应的候选即可确认', pick: '从 AI 候选里点选的', user: '手动填写的' }[by];
    return `<span class="nl-tag nl-mn-by-${by}" title="${esc(title)}">${esc(RESOLVED_BY_LABELS[by])}</span>`;
}

/** AI 自动填入、还没确认时的提示（直接显示，触屏看不到悬停提示） */
const AI_FILL_HINT = 'AI 自动填入，点高亮的候选确认';

/** 候选下方的说明：选中候选的理由与原文证据；没选时可展开看各候选的依据；没找到时显示原因（不用悬停也能看到，照顾触屏） */
function whyHtml(m) {
    const cands = m.ai?.candidates || [];
    const sel = selectedCandidateIndex(m);
    const hint = resolvedByOf(m) === 'ai' ? `<span class="nl-mn-hint">${esc(sel >= 0 ? AI_FILL_HINT : 'AI 自动填入，还没确认')}</span>` : '';
    if (sel >= 0) {
        const c = cands[sel];
        return `<div class="nl-mn-why">${srcBadge(c.source)}<span>${hint}<b>${esc(c.name)}</b>：${esc(c.reason || SOURCE_TITLES[c.source] || '')}${c.ref ? `（${esc(c.ref)}）` : ''}${c.evidence ? `<span class="nl-mn-ev">原文：「${esc(c.evidence)}」</span>` : ''}</span></div>`;
    }
    if (hint) return `<div class="nl-mn-why">${hint}</div>`;
    if (m.ai && !cands.length) {
        return `<div class="nl-mn-why nl-mn-none">${icon('info', { size: 14 })}<span>没找到合适的名称：${esc(m.ai.reason || 'AI 在原文片段和已有资料里都没有找到线索')}</span></div>`;
    }
    if (!cands.length) return '';
    return `<details class="nl-mn-more"><summary>各候选的依据</summary>${m.ai.reason ? `<div class="nl-mn-why">${esc(m.ai.reason)}</div>` : ''}<ul>${cands
        .map((c) => `<li><b>${esc(c.name)}</b>（${esc(SOURCE_LABELS[c.source] || c.source)} · ${esc(CONFIDENCE_LABELS[c.confidence] || c.confidence)}）：${esc(c.reason || SOURCE_TITLES[c.source] || '')}${c.ref ? `（${esc(c.ref)}）` : ''}${c.evidence ? `<span class="nl-mn-ev">原文：「${esc(c.evidence)}」</span>` : ''}</li>`)
        .join('')}</ul></details>`;
}

function candChip(c, i, k, sel) {
    const label = `${c.name}（${SOURCE_LABELS[c.source] || c.source}，${CONFIDENCE_LABELS[c.confidence] || c.confidence}）`;
    return `<button type="button" class="nl-mn-cand nl-mn-${esc(c.source)} nl-conf-${esc(c.confidence)}" data-act="mn-pick" data-i="${i}" data-c="${k}" aria-pressed="${k === sel}" title="${esc(candTitle(c))}" aria-label="${esc(label)}"><span class="nl-mn-cand-name">${esc(c.name)}</span>${srcBadge(c.source)}</button>`;
}

/** @param {object|null} job 这个项目正在进行的推断（app.nameJob） */
function nameRowHtml(m, i, job) {
    const cands = m.ai?.candidates || [];
    const sel = selectedCandidateIndex(m);
    const reroll = job?.items.has(m)
        ? `<button class="nl-btn nl-sm nl-reroll" disabled><span class="nl-spin"></span>推断中…</button>`
        : rerollBtn('mn-reroll', `data-i="${i}"${app.nameJob ? ' disabled' : ''}`, m.ai
            ? { label: '换一批', title: `让 AI 给「${m.vague}」换一批新的候选（已填写的名称保留）` }
            : { label: 'AI 推断', title: `只推断「${m.vague}」这一条` });
    return `<tr data-mn-row="${i}">
        <td class="nl-mn-c-type">${esc(m.type)}</td>
        <td class="nl-mn-c-vague"><b>${esc(m.vague)}</b></td>
        <td class="nl-mn-c-ctx nl-small">${esc(m.context)}</td>
        <td class="nl-mn-c-ans">
            <div class="nl-mn-input"><input class="nl-input" data-mn="${i}" value="${esc(m.resolved || '')}" placeholder="${esc(m.suggest || '')}" aria-label="「${esc(m.vague)}」的确认名称" aria-describedby="nl-mn-by-${i}"><span class="nl-mn-by" data-mn-by="${i}" id="nl-mn-by-${i}">${byTagHtml(m)}</span></div>
            <div class="nl-mn-cands" role="group" aria-label="「${esc(m.vague)}」的 AI 候选">${cands.map((c, k) => candChip(c, i, k, sel)).join('')}${reroll}</div>
            <div class="nl-mn-why-slot" data-mn-why="${i}">${whyHtml(m)}</div>
        </td>
        <td class="nl-mn-c-act"><button class="nl-icon-btn" data-act="del-mn" data-i="${i}" title="忽略" aria-label="忽略「${esc(m.vague)}」">${icon('close')}</button></td>
    </tr>`;
}

function hasFillable(p) {
    return p.missingNames.some((m) => m.ai?.candidates?.length && !String(m.resolved || '').trim());
}

function namesSectionHtml(p) {
    if (!p.missingNames.length) return '';
    const job = jobOf(p);
    const aiBtn = job?.full
        ? `<button class="nl-btn nl-sm nl-reroll" disabled><span class="nl-spin"></span>${esc(`AI 推断中…${job.progress ? ` ${job.progress}` : ''}`)}</button>
           <button class="nl-btn nl-sm nl-danger" data-act="mn-stop">${icon('stop', { size: 14 })}停止</button>`
        : rerollBtn('mn-ai', job ? 'disabled' : '', { label: 'AI 推断名称', title: 'AI 从原文片段和已有资料里给每条推断几个候选名称' });
    return `
            <section class="nl-card" data-sec="names">
                <div class="nl-card-head">
                    <div>
                        <h3>待确认名称（${p.missingNames.length}）</h3>
                        <div class="nl-card-desc">原文用模糊说法指代的对象。「AI 推断名称」给每条找几个候选：点一下填入（AI 已填的点一下是确认），再点取消；「AI 起名」表示原文里没有。填好后一键替换进角色档案与世界书（替换前自动快照）。</div>
                    </div>
                    ${aiBtn}
                    <button class="nl-btn nl-sm" data-act="mn-fill-top" title="没填写的行都填上 AI 给的第一个候选" ${hasFillable(p) ? '' : 'hidden'}${job ? ' disabled' : ''}>空行都填第一个候选</button>
                    <button class="nl-btn nl-sm nl-primary" data-act="apply-names"${job ? ' disabled title="AI 推断名称结束后再替换"' : ''}>把已填写的名称替换进资料</button>
                </div>
                <div class="nl-sr-only" role="status" aria-live="polite" data-mn-live></div>
                <table class="nl-table nl-mn-table"><thead><tr><th>类型</th><th>原文说法</th><th>上下文</th><th>确认名称 · AI 候选</th><th><span class="nl-sr-only">操作</span></th></tr></thead><tbody>
                ${p.missingNames.map((m, i) => nameRowHtml(m, i, job)).join('')}
                </tbody></table>
            </section>`;
}

const FILL_MODES = [
    ['confident', '只填把握大的（原文里有 / 已有角色或条目）'],
    ['top', '都先填第一个候选'],
    ['none', '不自动填，只给候选让我选'],
];

/** 「AI 推断名称」选项对话框；确定后把选项存进设置（下次和「换一批」沿用），返回选项，取消返回 null */
async function openNamesDialog(p) {
    const o = nameResolveOptions(app.settings);
    const nNew = namesToResolve(p, { overwrite: false }).length;
    const nAll = namesToResolve(p, { overwrite: true }).length;
    const read = (body) => normalizeNameResolve({
        overwrite: body.querySelector('input[name="nl-mn-scope"]:checked')?.value === 'all',
        count: body.querySelector('[data-f="count"]').value,
        batchSize: body.querySelector('[data-f="batchSize"]').value,
        autoFill: body.querySelector('input[name="nl-mn-fill"]:checked')?.value,
        invent: body.querySelector('[data-f="invent"]').checked,
        extra: body.querySelector('[data-f="extra"]').value,
    });
    const { value, root } = await openDialog({
        title: 'AI 推断名称',
        body: `
            <div class="nl-field" role="radiogroup" aria-label="推断范围">
                <div class="nl-mn-opt-title">范围</div>
                <label class="nl-row"><input type="radio" name="nl-mn-scope" value="new" ${o.overwrite ? '' : 'checked'}> 只推断还没推断过、也还没填写的（${nNew} 条）</label>
                <label class="nl-row"><input type="radio" name="nl-mn-scope" value="all" ${o.overwrite ? 'checked' : ''}> 全部重新推断（${nAll} 条，不动你手动填写或点选的）</label>
            </div>
            <div class="nl-grid2">
                <div class="nl-field"><label for="nl-mn-count">每条给几个候选</label><select id="nl-mn-count" class="nl-input" data-f="count">${optionList([2, 3, 4, 5, 6], o.count)}</select></div>
                <div class="nl-field"><label for="nl-mn-batch">每次请求处理几条</label><input id="nl-mn-batch" class="nl-input" type="number" min="1" max="12" step="1" data-f="batchSize" value="${o.batchSize}"></div>
            </div>
            <div class="nl-field" role="radiogroup" aria-label="自动填入空行">
                <div class="nl-mn-opt-title">自动填入空行</div>
                ${FILL_MODES.map(([v, l]) => `<label class="nl-row"><input type="radio" name="nl-mn-fill" value="${v}" ${o.autoFill === v ? 'checked' : ''}> ${esc(l)}</label>`).join('')}
            </div>
            <div class="nl-field"><label><input type="checkbox" data-f="invent" ${o.invent ? 'checked' : ''}> 原文找不到时让 AI 起名字（标成「AI 起名」，替换进资料前会再提醒）</label></div>
            <div class="nl-field"><label for="nl-mn-extra">额外要求 <span class="nl-muted">可选，追加到提示词末尾</span></label><textarea id="nl-mn-extra" class="nl-input nl-textarea" rows="2" data-f="extra" placeholder="例如：人名按古风取，地名用两个字">${esc(o.extra)}</textarea></div>
            <div class="nl-row nl-wrap"><span class="nl-muted nl-small" data-mn-est></span><span class="nl-spacer"></span><button type="button" class="nl-btn nl-sm" data-mn-preview>${icon('eye', { size: 14 })}预览提示词</button></div>`,
        buttons: [{ label: '取消', value: null }, { label: '开始推断', value: 'ok', primary: true }],
        onMount: (body) => {
            const est = body.querySelector('[data-mn-est]');
            const update = () => {
                const x = read(body);
                const n = x.overwrite ? nAll : nNew;
                est.textContent = n ? `将推断 ${n} 条，分 ${Math.ceil(n / x.batchSize)} 次请求` : '这个范围里没有需要推断的名称';
            };
            body.addEventListener('change', update);
            body.addEventListener('input', update);
            update();
            body.querySelector('[data-mn-preview]').addEventListener('click', async () => {
                const x = read(body);
                const all = namesToResolve(p, { overwrite: x.overwrite });
                if (!all.length) return app.log('这个范围里没有需要推断的名称', 'warn');
                const summary = p.outline?.summary || '';
                const batch = prepareNameItems(p, all.slice(0, x.batchSize), { summary });
                const { system, prompt } = buildResolveNamesPrompt(p, app.settings, batch, { ...x, summary });
                const total = Math.ceil(all.length / x.batchSize);
                await openDialog({
                    title: total > 1 ? `推断名称提示词预览（第 1/${total} 批，后面几批格式相同）` : '推断名称提示词预览',
                    wide: true,
                    body: chainPreviewHtml(app.settings, 'names', { system, prompt, book: p.bookName }),
                });
            });
        },
    });
    if (value !== 'ok') return null;
    const opts = read(root);
    app.settings.nameResolve = opts;
    app.saveSettings();
    return opts;
}

function styleSummary(p) {
    const s = p.style || {};
    const name = (id) => listStyleChoices(p, app.settings).find((c) => c.id === id)?.name || id;
    const parts = [];
    const own = [s.perspective, s.tone, s.mood].filter(Boolean).join('；');
    parts.push(own ? `原著：${own}` : '原著文风尚未提取');
    if (s.samples?.length) parts.push(`范文 ${s.samples.length} 段`);
    const nb = parseBanned(s.banned).length;
    if (nb) parts.push(`禁用词 ${nb} 个`);
    const other = STYLE_TASKS.filter((t) => resolveStyleId(p, t.key) !== PROJECT_STYLE_ID).map((t) => `${t.label}用「${name(resolveStyleId(p, t.key))}」`);
    if (other.length) parts.push(other.join('，'));
    return parts.join(' · ');
}

export const outlineTab = {
    mount(el, { switchTab, setActions }) {
        const render = () => {
            const p = app.project;
            const withOutline = p.chunks.filter((c) => c.outline?.length || c.important?.length);
            const vols = getVolumes(p).filter((v) => !v.implicit);
            el.innerHTML = `
            <section class="nl-card">
                <div class="nl-card-head">
                    <div><h3>故事梗概</h3></div>
                    ${rerollBtn('summary', '', { label: p.outline.summary ? '重新生成梗概' : 'AI 生成梗概', title: '重新生成故事梗概' })}
                </div>
                <textarea class="nl-input nl-textarea" rows="6" data-f="summary" placeholder="提取完成后可让 AI 根据章节概要生成；也可以手写。会用于角色卡、续写与“剧情大纲”世界书条目。">${esc(p.outline.summary)}</textarea>
            </section>

            ${vols.length ? `
            <section class="nl-card">
                <div class="nl-card-head">
                    <div><h3>分卷梗概（${vols.length} 卷）</h3></div>
                    <button class="nl-btn nl-sm" data-act="vol-sum-all">为缺少梗概的卷生成</button>
                </div>
                ${vols.map((v) => `
                <div class="nl-field">
                    <label>${esc(v.name)}（${volumeRangeLabel(v)}） ${rerollBtn('vol-sum', `data-vol="${esc(v.id)}"`, { label: v.summary ? '重新生成' : 'AI 生成', title: '重新生成本卷梗概' })}</label>
                    <textarea class="nl-input nl-textarea" rows="3" data-vol-sum="${esc(v.id)}" placeholder="卷梗概会作为后续卷的前情提要，也用于写大纲和续写">${esc(v.summary || '')}</textarea>
                </div>`).join('')}
            </section>` : ''}

            <section class="nl-card">
                <div class="nl-card-head">
                    <div>
                        <h3>文风</h3>
                        <div class="nl-card-desc">${esc(styleSummary(p))}</div>
                    </div>
                    <button class="nl-btn nl-sm" data-act="goto-style">${icon('style', { size: 14 })}打开文风设置</button>
                </div>
            </section>

            ${namesSectionHtml(p)}

            ${p.censorFlags?.length ? `
            <section class="nl-card">
                <div class="nl-card-head">
                    <div>
                        <h3>${icon('alert', { cls: 'nl-warn' })} 疑似被替换成拼音/注音的敏感词（${p.censorFlags.length}）</h3>
                        <div class="nl-card-desc">本地扫描发现的，不消耗 token：这些内容里含有注音符号，原文正常情况下不会出现，多半是接口/模型把这个字判定为敏感词后换成了拼音/注音，而不是直接拒绝整段。建议去对应分段核对原文再决定怎么改；点“核实”可以直接跳到那一段查看正文。</div>
                    </div>
                    <button class="nl-btn nl-sm nl-danger" data-act="clear-censor">清空列表</button>
                </div>
                <table class="nl-table"><thead><tr><th>分段</th><th>字段</th><th>内容</th><th></th></tr></thead><tbody>
                ${p.censorFlags.map((f) => `<tr>
                    <td class="nl-small">#${f.chunk + 1} ${esc(truncate(p.chunks[f.chunk]?.title || '', 20))}</td>
                    <td class="nl-small">${esc(f.field)}</td>
                    <td class="nl-small">${esc(truncate(f.text, 100))}</td>
                    <td class="nl-row">
                        <button class="nl-btn nl-sm" data-act="goto-chunk" data-chunk="${f.chunk}" title="跳到分段页查看这一段原文">核实</button>
                        <button class="nl-icon-btn" data-act="del-cf" data-id="${esc(f.id)}" title="忽略" aria-label="忽略">${icon('close')}</button>
                    </td></tr>`).join('')}
                </tbody></table>
            </section>` : ''}

            <section class="nl-card">
                <div class="nl-card-head">
                    <div><h3>章节概要（${withOutline.length} 段）</h3></div>
                </div>
                <div class="nl-outline">
                    ${withOutline.map((c) => `
                    <div class="nl-outline-chunk">
                        <div class="nl-row"><b>#${c.index + 1} ${esc(c.title)}</b><span class="nl-spacer"></span><button class="nl-btn nl-sm" data-act="edit-outline" data-i="${c.index}">编辑</button></div>
                        ${(c.outline || []).map((o) => `<div class="nl-small">${o.name ? `<b>${esc(o.name)}</b>：` : ''}${esc(o.notes)}</div>`).join('')}
                        ${(c.important || []).map((imp) => `<div class="nl-small nl-important">${icon('pin', { size: 14, label: '重要章节' })} ${esc(imp.chapter || '')} ${esc(imp.reason)}${(imp.quotes || []).map((q) => `<blockquote>「${esc(q.text)}」</blockquote>`).join('')}</div>`).join('')}
                    </div>`).join('') || emptyState('提取后每段的章节概要和重要章节会列在这里（在提取设置中开启“章节概要与重要章节”）。', '', { title: '还没有章节概要', ico: 'outline' })}
                </div>
            </section>`;
            // 页面级操作：整份大纲 / 全部角色档案的导出（页面已被切走时不再改动标题栏）
            if (el.parentNode) {
                setActions?.(`
                    <button class="nl-btn" data-act="export-outline">${icon('download')}导出大纲 Markdown</button>
                    <button class="nl-btn" data-act="export-chars">${icon('download')}导出角色档案 TXT</button>`, onClick);
            }
        };

        // 输入法正在拼写（中文输入）：这时重绘会换掉输入框、打断拼写，把拼音当成输入；等拼完再重绘
        let composing = false;
        let namesPending = false;

        /** 推断开始/结束、原来有焦点的按钮被换掉时，键盘焦点放到哪儿：进行中放「停止」；结束后放回发起推断的按钮 */
        const focusFallback = (p, fresh, wasInCard) => {
            const job = jobOf(p);
            if (job) return job.full ? fresh.querySelector('[data-act="mn-stop"]') : null;
            const o = lastOrigin && lastOrigin.projectId === p.id ? lastOrigin : null;
            if (o?.act === 'mn-reroll') {
                const i = p.missingNames.indexOf(o.row);
                if (i >= 0) return fresh.querySelector(`[data-act="mn-reroll"][data-i="${i}"]`);
            }
            return o || wasInCard ? fresh.querySelector('[data-act="mn-ai"]') : null;
        };

        /** 只重绘「待确认名称」卡片（AI 结果陆续回来时用），保留焦点、光标、输入框里原样的文字和展开的依据 */
        const renderNames = () => {
            const p = app.project;
            if (!p || !el.isConnected) return;
            const old = el.querySelector('section[data-sec="names"]');
            const html = namesSectionHtml(p);
            if (!old || !html) return render(); // 卡片出现或消失：整页重绘
            const a = document.activeElement;
            const inCard = !!a && old.contains(a);
            if (composing && inCard && a.dataset.mn !== undefined) {
                namesPending = true;
                return;
            }
            namesPending = false;
            let sel = '';
            let caret = null;
            let raw = null;
            if (inCard) {
                if (a.dataset.mn !== undefined) {
                    sel = `[data-mn="${a.dataset.mn}"]`;
                    caret = [a.selectionStart, a.selectionEnd];
                    raw = a.value;
                } else if (a.dataset.act) {
                    sel = `[data-act="${a.dataset.act}"]${a.dataset.i !== undefined ? `[data-i="${a.dataset.i}"]` : ''}${a.dataset.c !== undefined ? `[data-c="${a.dataset.c}"]` : ''}`;
                }
            }
            const open = [...old.querySelectorAll('[data-mn-why] details[open]')].map((d) => d.closest('[data-mn-why]').dataset.mnWhy);
            old.outerHTML = html;
            const fresh = el.querySelector('section[data-sec="names"]');
            for (const i of open) fresh.querySelector(`[data-mn-why="${i}"] details`)?.setAttribute('open', '');
            let target = sel ? fresh.querySelector(sel) : null;
            if (target && (target.disabled || target.hidden)) target = null;
            if (!target && (inCard || !a || a === document.body)) {
                // 原来有焦点的控件被换掉了（推断中变成进度、停止按钮消失、按钮隐藏），焦点会掉到 <body>
                target = focusFallback(p, fresh, inCard);
                if (target && (target.disabled || target.hidden)) target = null;
                caret = null;
                raw = null;
            }
            if (!target) return;
            // 输入框按存下的值（去掉了首尾空格）重建：只差首尾空格时放回原来打的字（打了“Anna ”还要接着打姓）
            if (raw !== null && raw !== target.value && raw.trim() === target.value.trim()) target.value = raw;
            target.focus({ preventScroll: true });
            if (caret && typeof target.setSelectionRange === 'function') {
                try {
                    target.setSelectionRange(caret[0], caret[1]);
                } catch { /* ignore */ }
            }
        };

        /** 读屏播报（卡片里固定的一块 role=status）：点选候选后告诉读屏用户发生了什么 */
        const announce = (text) => {
            const live = el.querySelector('[data-mn-live]');
            if (!live) return;
            live.textContent = '';
            if (text) setTimeout(() => { live.textContent = text; }, 50); // 先清空再写：同样的话连说两次也会念
        };

        /** 某一行的选择变了：就地更新候选的选中状态、来源标记、说明，不重绘整张表（焦点留在原处） */
        const refreshRow = (i) => {
            const m = app.project?.missingNames[i];
            const row = el.querySelector(`[data-mn-row="${i}"]`);
            if (!m || !row) return;
            const input = row.querySelector(`[data-mn="${i}"]`);
            if (input && document.activeElement !== input) input.value = m.resolved || '';
            const sel = selectedCandidateIndex(m);
            row.querySelectorAll('[data-act="mn-pick"]').forEach((b) => b.setAttribute('aria-pressed', String(Number(b.dataset.c) === sel)));
            const by = row.querySelector(`[data-mn-by="${i}"]`);
            if (by) by.innerHTML = byTagHtml(m);
            const why = row.querySelector(`[data-mn-why="${i}"]`);
            const html = whyHtml(m);
            if (why && why.innerHTML !== html) {
                // 内容没变就不动（输入时每个字都会走到这里，免得把展开的「各候选的依据」收起来）
                const wasOpen = !!why.querySelector('details[open]');
                why.innerHTML = html;
                if (wasOpen) why.querySelector('details')?.setAttribute('open', '');
            }
            const fill = el.querySelector('[data-act="mn-fill-top"]');
            if (fill) fill.hidden = !hasFillable(app.project);
        };

        /**
         * 发起推断：整批（标题栏显示进度、可停止）或某一行的「换一批」（single）。
         * 每批结果回来就写进项目并重绘卡片；停止或某批失败时，已完成的保留。
         */
        const runNames = async (btn, { indices, avoid, single = null }) => {
            const p = app.project;
            if (app.nameJob) return app.log('AI 正在推断名称，请等这一轮结束', 'warn');
            if (!indices.length) return app.log('没有需要推断的名称（已经推断过或填写过的不会重复推断；想重来请选「全部重新推断」）', 'warn');
            const o = nameResolveOptions(app.settings);
            const total = Math.ceil(indices.length / o.batchSize);
            // 行对象按发起时的下标记下：推断途中有行被忽略，下标会错位，按对象认
            const rowAt = new Map(indices.map((i) => [i, p.missingNames[i]]).filter(([, m]) => m));
            const job = {
                projectId: p.id,
                items: new Set(rowAt.values()),
                full: !single,
                progress: total > 1 ? `0/${total} 批` : '',
                ctl: new AbortController(),
                origin: single ? { act: 'mn-reroll', row: single } : { act: 'mn-ai' },
            };
            app.nameJob = job;
            let gone = 0; // 结果回来时这一行已经被忽略掉了：不算「AI 没有返回」
            // 推断途中切换/关闭/删除了项目：停止推断，之后不再保存发起时的那个对象。
            // 切到别的项目时先把已完成的批次存进去（打开别的项目不会替旧项目保存）；关闭时已经存过；
            // 删除的不能再写回去；重新打开了同一个项目（新的对象）时以新对象为准，不能拿旧对象覆盖
            let detached = ''; // switch = 切到别的项目；close = 关闭或删除；reopen = 重新打开了同一个项目
            const offProject = app.events.on('project', (np) => {
                if (np === p || detached) return;
                detached = !np ? 'close' : np.id !== p.id ? 'switch' : 'reopen';
                if (detached === 'switch') saveProject(p).catch((e) => app.log(`保存项目失败：${e.message}`, 'error'));
                job.ctl.abort();
            });
            const save = () => (!detached && app.project === p ? app.saveNow() : undefined);
            app.events.emit('names:progress');
            try {
                await busy(btn, async () => {
                    let res;
                    try {
                        res = await resolveMissingNames(p, app.settings, {
                            indices,
                            avoid,
                            ...(single ? { overwrite: false } : {}), // 换一批：已经填写的（含 AI 填入的）保留
                            signal: job.ctl.signal,
                            onLog: (m, l) => app.log(m, l),
                            onProgress: (pr) => {
                                job.progress = pr.batches > 1 ? `${pr.batch}/${pr.batches} 批` : '';
                                for (const i of pr.indices || []) {
                                    const m = rowAt.get(i);
                                    job.items.delete(m);
                                    if (m && !pr.failed && !p.missingNames.includes(m)) gone++;
                                }
                                if (!detached && app.project === p) app.saveSoon();
                                app.events.emit('names:progress');
                            },
                        });
                    } catch (err) {
                        if (!isAbortError(err) && !job.ctl.signal.aborted) throw err;
                        await save();
                        app.log({
                            switch: `已切换项目，「${p.name}」的 AI 推断名称已停止（已经完成的批次已存进该项目）`,
                            close: `项目「${p.name}」已关闭，AI 推断名称已停止`,
                            reopen: `项目「${p.name}」已重新打开，之前的 AI 推断名称已停止`,
                        }[detached] || '已停止推断名称，已经完成的批次保留', 'warn');
                        return;
                    }
                    await save();
                    const missed = Math.max(0, res.missed - gone);
                    if (single) {
                        if (!p.missingNames.includes(single)) return; // 这一行推断途中被忽略了
                        const c = single.ai?.candidates || [];
                        if (missed) app.log(`「${single.vague}」：AI 这次没有返回结果，保留原来的候选`, 'warn');
                        else if (res.kept) app.log(`「${single.vague}」没有更多新的候选了，保留原来的候选`, 'warn');
                        else if (c.length) app.log(`🎲 「${single.vague}」的候选：${c.map((x) => x.name).join('、')}${res.filled ? `（已填入「${single.resolved}」）` : ''}`, 'success');
                        else app.log(`「${single.vague}」：AI 没找到合适的名称${single.ai?.reason ? `（${single.ai.reason}）` : ''}`, 'warn');
                        return;
                    }
                    const parts = [`${res.total} 条中 ${res.offered} 条有候选`];
                    if (res.filled) parts.push(`自动填入 ${res.filled} 条`);
                    if (res.none) parts.push(`${res.none} 条没找到`);
                    if (missed) parts.push(`${missed} 条 AI 没有返回`);
                    if (gone) parts.push(`${gone} 条推断途中被忽略`);
                    if (res.failed) parts.push(`${res.failed} 批失败（原因见上方日志）`);
                    app.log(`🔎 AI 推断名称：${parts.join('，')}`, res.failed || missed ? 'warn' : 'success');
                }, 'AI 推断中…');
            } finally {
                offProject();
                if (app.nameJob === job) app.nameJob = null;
                // 结束这一刻的重绘把焦点放回发起推断的按钮（之后的重绘不再管）
                lastOrigin = { ...job.origin, projectId: p.id };
                app.events.emit('names:progress');
                lastOrigin = null;
            }
        };

        const onClick = async (e) => {
            const btn = e.target.closest('[data-act]');
            if (!btn) return;
            const p = app.project;
            switch (btn.dataset.act) {
                case 'mn-ai': {
                    if (app.nameJob) return app.log('AI 正在推断名称，请等这一轮结束', 'warn');
                    const o = await openNamesDialog(p);
                    if (!o || app.project !== p) return;
                    return runNames(el.querySelector('[data-act="mn-ai"]') || btn, { indices: namesToResolve(p, { overwrite: o.overwrite }) });
                }
                case 'mn-stop':
                    jobOf(p)?.ctl.abort();
                    return;
                case 'mn-reroll': {
                    const i = Number(btn.dataset.i);
                    const m = p.missingNames[i];
                    if (!m) return;
                    // 换一批：这次和之前给过的候选都不要再给
                    const avoid = m.ai ? uniq([...(m.ai.seen || []), ...(m.ai.candidates || []).map((c) => c.name)]).slice(-24) : [];
                    return runNames(btn, { indices: [i], avoid: avoid.length ? { [i]: avoid } : undefined, single: m });
                }
                case 'mn-pick': {
                    const i = Number(btn.dataset.i);
                    const m = p.missingNames[i];
                    const name = m?.ai?.candidates?.[Number(btn.dataset.c)]?.name || '';
                    const what = m ? pickCandidate(m, Number(btn.dataset.c)) : '';
                    if (!what) return;
                    app.saveSoon();
                    refreshRow(i);
                    // 选中状态（aria-pressed）在“确认”前后不变，读屏听不出区别：播报一句
                    return announce({ pick: `已填入「${name}」`, confirm: `已确认「${name}」`, clear: `已取消「${name}」` }[what]);
                }
                case 'mn-fill-top': {
                    if (jobOf(p)) return app.log('AI 正在推断名称，请等这一轮结束', 'warn');
                    const n = fillTopCandidates(p);
                    if (!n) return app.log('没有可以填的空行', 'warn');
                    await app.saveNow();
                    app.log(`已给 ${n} 个空行填上第一个候选（标为「AI 填入」，替换进资料前会再提醒）`, 'success');
                    return renderNames();
                }
                case 'goto-style':
                    return switchTab('style');
                case 'summary':
                    await busy(btn, async () => {
                        await buildStorySummary(p, app.settings);
                        await app.saveNow();
                        app.log('🧭 已生成故事梗概', 'success');
                    }, 'AI 生成中…');
                    return render();
                case 'vol-sum':
                case 'vol-sum-all': {
                    const ids = btn.dataset.act === 'vol-sum' ? [btn.dataset.vol] : getVolumes(p).filter((v) => !v.implicit && !v.summary).map((v) => v.id);
                    if (!ids.length) return app.log('所有卷都已有梗概');
                    await busy(btn, async () => {
                        for (const id of ids) {
                            const v = p.volumes.find((x) => x.id === id);
                            try {
                                await buildVolumeSummary(p, app.settings, id);
                                app.log(`🧭 「${v.name}」卷梗概已生成`, 'success');
                            } catch (err) {
                                app.log(`「${v.name}」：${err.message}`, 'warn');
                            }
                        }
                        await app.saveNow();
                    }, 'AI 生成中…');
                    return render();
                }
                case 'export-outline':
                    return exportOutline(p);
                case 'export-chars':
                    return exportCharactersText(p);
                case 'del-mn':
                    p.missingNames.splice(Number(btn.dataset.i), 1);
                    await app.saveNow();
                    return render();
                case 'del-cf':
                    p.censorFlags = (p.censorFlags || []).filter((f) => f.id !== btn.dataset.id);
                    await app.saveNow();
                    return render();
                case 'clear-censor':
                    p.censorFlags = [];
                    await app.saveNow();
                    return render();
                case 'goto-chunk': {
                    const c = p.chunks[Number(btn.dataset.chunk)];
                    if (!c) return app.log('这一段已经不存在了', 'warn');
                    app.pendingChunkId = c.id;
                    return switchTab('chunks');
                }
                case 'apply-names': {
                    // 推断进行中不能替换：AI 结果回来会改动（全部重新推断时还会清空）AI 填入的值
                    if (jobOf(p)) return app.log('AI 正在推断名称，请等这一轮结束再替换', 'warn');
                    // 先把要替换的说法和名称定下来：确认对话框打开期间值有变化，也只按列出来的替换，绝不拿空名称去替换
                    const pairs = p.missingNames
                        .map((m) => ({ m, vague: String(m.vague || ''), resolved: String(m.resolved || '').trim() }))
                        .filter((x) => x.vague && x.resolved && x.resolved !== x.vague);
                    if (!pairs.length) return app.log('还没有填写任何确认名称', 'warn');
                    // AI 自动填入还没确认的、AI 起的名字（原文里没有）：替换前列出来再确认一次
                    const risky = riskyResolved(pairs.map((x) => x.m));
                    if (risky.length) {
                        const lines = risky.map(({ m, reasons }) => `「${m.vague}」→「${m.resolved}」：${reasons.join('；')}`);
                        const how = risky.some(({ m }) => resolvedByOf(m) === 'ai') ? '\n\nAI 自动填入的名称，在那一行点一下高亮的候选就算确认。' : '';
                        const ok = await confirmDialog(`下面 ${risky.length} 个名称不是你亲自选定的，或者原文里并没有出现：\n\n${lines.join('\n')}${how}\n\n确定和其他已填写的名称一起替换进资料吗？替换前会自动保存快照，可以在「世界书 → 修改历史」中恢复。`, { title: '确认替换', okLabel: '仍然替换' });
                        if (!ok || app.project !== p) return;
                    }
                    await createSnapshot(p, '替换待确认名称前');
                    let n = 0;
                    for (const x of pairs) n += findReplace(p, { find: x.vague, replace: x.resolved, scope: ['worldbook', 'characters'] });
                    // 只移除值没变过的行（确认期间改了的留下，按新值再替换一次即可）
                    const done = new Set(pairs.filter((x) => String(x.m.resolved || '').trim() === x.resolved).map((x) => x.m));
                    p.missingNames = p.missingNames.filter((m) => !done.has(m));
                    await app.saveNow();
                    app.log(`🔁 已替换 ${n} 处模糊名称`, 'success');
                    return render();
                }
                case 'edit-outline': {
                    const c = p.chunks[Number(btn.dataset.i)];
                    const text = (c.outline || []).map((o) => `${o.name ? `${o.name}：` : ''}${o.notes}`).join('\n');
                    const { value, root } = await openDialog({
                        title: `编辑概要：${c.title}`,
                        wide: true,
                        body: `<div class="nl-field"><label>每行一章，格式“章节名：概要”</label><textarea class="nl-input nl-textarea nl-tall">${esc(text)}</textarea></div>`,
                        buttons: [{ label: '取消', value: null }, { label: '保存', value: 'ok', primary: true }],
                    });
                    if (value !== 'ok') return;
                    c.outline = root.querySelector('textarea').value.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
                        const m = l.match(/^(.{1,40}?)[：:](.+)$/);
                        return m ? { name: m[1].trim(), notes: m[2].trim() } : { name: '', notes: l };
                    });
                    await app.saveNow();
                    return render();
                }
                default:
                    break;
            }
        };

        const onChange = (e) => {
            const p = app.project;
            const t = e.target;
            if (t.dataset.f === 'summary') p.outline.summary = t.value;
            else if (t.dataset.volSum) {
                const v = p.volumes.find((x) => x.id === t.dataset.volSum);
                if (v) v.summary = t.value.trim();
            }
            else if (t.dataset.mn !== undefined) {
                const m = p.missingNames[Number(t.dataset.mn)];
                if (m) typeResolved(m, t.value);
            } else return;
            app.saveSoon();
        };

        // 确认名称边输入边记录：改动过就算手动填写，候选的选中状态跟着输入变化
        const recordInput = (t) => {
            const i = Number(t.dataset.mn);
            const m = app.project?.missingNames[i];
            if (!m) return;
            typeResolved(m, t.value);
            app.saveSoon();
            refreshRow(i);
        };
        const onInput = (e) => {
            const t = e.target;
            if (t.dataset?.mn === undefined) return;
            // 输入法还在拼写：框里是拼音，等拼完（compositionend）再记录
            if (e.isComposing || composing) return;
            recordInput(t);
        };
        const onCompositionStart = (e) => {
            if (e.target.dataset?.mn !== undefined) composing = true;
        };
        const onCompositionEnd = (e) => {
            if (e.target.dataset?.mn === undefined) return;
            composing = false;
            recordInput(e.target);
            // 拼写期间有 AI 结果回来、推迟了重绘：现在补上（放到下一轮，等浏览器把这次输入处理完）
            if (namesPending) setTimeout(() => { if (namesPending && !composing) renderNames(); }, 0);
        };

        el.addEventListener('click', onClick);
        el.addEventListener('change', onChange);
        el.addEventListener('input', onInput);
        el.addEventListener('compositionstart', onCompositionStart);
        el.addEventListener('compositionend', onCompositionEnd);
        const off = app.events.on('names:progress', () => renderNames());
        render();
        return {
            destroy: () => {
                off();
                return qs(el, '[data-f="summary"]') && app.saveNow();
            },
        };
    },
};
