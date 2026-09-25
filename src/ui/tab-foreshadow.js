// 伏笔看板页：全书伏笔的埋下/回收状态总表；AI 从大纲整理，也可手动增删改

import { app } from '../app.js';
import {
    addForeshadowItem, analyzeForeshadowing, chaptersOpenFor, exportForeshadowJson, foreshadowMarkdown,
    mergeForeshadowItems, parseForeshadowJson, removeForeshadowItem, reopenForeshadowItem, resolveForeshadowItem, updateForeshadowItem,
} from '../foreshadow.js';
import { nextChapterNo } from '../planner.js';
import { createSnapshot } from '../store.js';
import { downloadFile, pickFile, readFileAsText, safeFileName } from '../utils.js';
import { busy, confirmDialog, esc, openDialog, optionList } from './common.js';

const FILTERS = [
    { value: 'open', label: '未回收' },
    { value: 'all', label: '全部' },
    { value: 'resolved', label: '已回收' },
];

export const foreshadowTab = {
    mount(el) {
        let filter = 'open';

        const openEditDialog = async (existing) => {
            const p = app.project;
            const f = existing || { text: '', status: 'open', plantedNo: Math.max(1, nextChapterNo(p) - 1), resolvedNo: null, notes: '' };
            const { value, root } = await openDialog({
                title: existing ? '编辑伏笔' : '添加伏笔',
                body: `
                    <div class="nl-field"><label>伏笔内容（具体到能一眼认出是同一条）</label><textarea class="nl-input nl-textarea" rows="2" data-f="text" placeholder="例如：江酒手上的旧疤的来历">${esc(f.text)}</textarea></div>
                    <div class="nl-grid2">
                        <div class="nl-field"><label>埋下章号</label><input class="nl-input" type="number" min="1" data-f="plantedNo" value="${f.plantedNo ?? ''}"></div>
                        <div class="nl-field"><label>状态</label><select class="nl-input" data-f="status">${optionList([{ value: 'open', label: '未回收' }, { value: 'resolved', label: '已回收' }], f.status)}</select></div>
                    </div>
                    <div class="nl-field" data-resolved-field><label>回收章号</label><input class="nl-input" type="number" min="1" data-f="resolvedNo" value="${f.resolvedNo ?? ''}"></div>
                    <div class="nl-field"><label>备注</label><textarea class="nl-input nl-textarea" rows="2" data-f="notes">${esc(f.notes || '')}</textarea></div>`,
                buttons: [{ label: '取消', value: null }, { label: '保存', value: 'ok', primary: true }],
                onMount: (b) => {
                    const statusSel = b.querySelector('[data-f="status"]');
                    const resolvedField = b.querySelector('[data-resolved-field]');
                    const sync = () => { resolvedField.style.display = statusSel.value === 'resolved' ? '' : 'none'; };
                    statusSel.addEventListener('change', sync);
                    sync();
                },
            });
            if (value !== 'ok') return;
            const v = (k) => root.querySelector(`[data-f="${k}"]`).value.trim();
            const data = {
                text: v('text'),
                status: v('status') === 'resolved' ? 'resolved' : 'open',
                plantedNo: v('plantedNo') ? Number(v('plantedNo')) : null,
                resolvedNo: v('status') === 'resolved' && v('resolvedNo') ? Number(v('resolvedNo')) : null,
                notes: v('notes'),
            };
            if (!data.text) return app.log('请填写伏笔内容', 'warn');
            const p2 = app.project;
            await createSnapshot(p2, existing ? '编辑伏笔前' : '添加伏笔前');
            if (existing) updateForeshadowItem(p2, existing.id, data);
            else addForeshadowItem(p2, data);
            await app.saveNow();
            app.log(existing ? '✏️ 已修改伏笔' : '🧩 已添加伏笔', 'success');
            render();
        };

        const render = () => {
            const p = app.project;
            const all = p.foreshadow || [];
            const list = filter === 'all' ? all : all.filter((f) => f.status === filter);
            const openCount = all.filter((f) => f.status === 'open').length;
            const oldestOpen = all
                .filter((f) => f.status === 'open')
                .map((f) => chaptersOpenFor(p, f))
                .filter((n) => Number.isFinite(n))
                .sort((a, b) => b - a)[0];
            el.innerHTML = `
            <section class="nl-card">
                <div class="nl-row nl-wrap">
                    <h3>伏笔看板</h3>
                    <span class="nl-spacer"></span>
                    <button class="nl-btn nl-sm" data-act="export" ${all.length ? '' : 'disabled'}>导出</button>
                    <button class="nl-btn nl-sm" data-act="import">导入</button>
                    <button class="nl-btn nl-sm" data-act="export-md" ${all.length ? '' : 'disabled'}>导出 Markdown</button>
                    <button class="nl-btn nl-sm nl-primary" data-act="analyze">🤖 从大纲整理</button>
                    <button class="nl-btn nl-sm" data-act="add">+ 添加伏笔</button>
                </div>
                <div class="nl-muted nl-small">读取「写大纲」里各章的「伏笔」字段，让 AI 识别哪些是新埋下的、哪些已经在后续章节回收，整理成这张总表；也可以手动增删改。${all.length ? `现在挂着 <b>${openCount}</b> 条未回收${Number.isFinite(oldestOpen) ? `，最久的一条已经埋了 <b>${oldestOpen}</b> 章` : ''}。` : ''}</div>
                <div class="nl-row nl-wrap">
                    <select class="nl-input nl-inline" data-act-input="filter">${optionList(FILTERS, filter)}</select>
                </div>
            </section>
            <section class="nl-card">
                ${list.length ? `<table class="nl-table"><thead><tr><th>伏笔</th><th>状态</th><th>埋下</th><th>回收</th><th>挂了几章</th><th></th></tr></thead><tbody>
                    ${list.map((f) => {
                        const openN = chaptersOpenFor(p, f);
                        return `<tr data-id="${esc(f.id)}">
                        <td>${esc(f.text)}${f.auto ? ' <span class="nl-muted nl-small" title="AI 整理得出">🤖</span>' : ''}${f.notes ? `<div class="nl-muted nl-small">${esc(f.notes)}</div>` : ''}</td>
                        <td>${f.status === 'resolved' ? '<span class="nl-tag nl-ok">已回收</span>' : '<span class="nl-tag nl-warn">未回收</span>'}</td>
                        <td class="nl-small">${Number.isFinite(f.plantedNo) ? `第${f.plantedNo}章` : '未知'}</td>
                        <td class="nl-small">${Number.isFinite(f.resolvedNo) ? `第${f.resolvedNo}章` : '—'}</td>
                        <td class="nl-small">${Number.isFinite(openN) ? openN : '—'}</td>
                        <td class="nl-row">
                            ${f.status === 'open'
                                ? `<button class="nl-icon-btn" data-act="resolve" data-id="${esc(f.id)}" title="标记为已回收">✅</button>`
                                : `<button class="nl-icon-btn" data-act="reopen" data-id="${esc(f.id)}" title="改回未回收">↩️</button>`}
                            <button class="nl-icon-btn" data-act="edit" data-id="${esc(f.id)}" title="编辑">✏️</button>
                            <button class="nl-icon-btn" data-act="del" data-id="${esc(f.id)}" title="删除">✕</button>
                        </td>
                    </tr>`;
                    }).join('')}
                </tbody></table>` : `<div class="nl-empty">${all.length ? '没有符合筛选条件的伏笔。' : '还没有伏笔数据。先在「写大纲」里给章节填写「伏笔」字段，再点“从大纲整理”。'}</div>`}
            </section>`;
        };

        const onClick = async (e) => {
            const btn = e.target.closest('[data-act]');
            if (!btn) return;
            const p = app.project;
            const item = () => (p.foreshadow || []).find((x) => x.id === btn.dataset.id);
            switch (btn.dataset.act) {
                case 'add':
                    await openEditDialog(null);
                    break;
                case 'edit':
                    await openEditDialog(item());
                    break;
                case 'resolve': {
                    const f = item();
                    if (!f) return;
                    await createSnapshot(p, '标记伏笔回收前');
                    resolveForeshadowItem(p, f.id);
                    await app.saveNow();
                    app.log(`✅ 已标记「${f.text}」回收`, 'success');
                    render();
                    break;
                }
                case 'reopen': {
                    const f = item();
                    if (!f) return;
                    reopenForeshadowItem(p, f.id);
                    await app.saveNow();
                    render();
                    break;
                }
                case 'del': {
                    const f = item();
                    if (!f) return;
                    if (!(await confirmDialog(`删除伏笔「${f.text}」？`, { danger: true, okLabel: '删除' }))) return;
                    await createSnapshot(p, '删除伏笔前');
                    removeForeshadowItem(p, f.id);
                    await app.saveNow();
                    render();
                    break;
                }
                case 'analyze':
                    await busy(btn, async () => {
                        const res = await analyzeForeshadowing(p, app.settings, { onLog: (m, l) => app.log(m, l) });
                        await app.saveNow();
                        app.log(`🧩 AI 整理伏笔看板：新增 ${res.added} 条${res.updated ? `，更新 ${res.updated} 条` : ''}`, 'success');
                    }, 'AI 整理中…');
                    render();
                    break;
                case 'export':
                    downloadFile(JSON.stringify(exportForeshadowJson(p), null, 2), `${safeFileName(p.bookName)}-伏笔.novelloom-foreshadow.json`);
                    break;
                case 'export-md':
                    downloadFile(foreshadowMarkdown(p), `${safeFileName(p.bookName)}-伏笔看板.md`, 'text/markdown');
                    break;
                case 'import': {
                    const file = await pickFile('.json,application/json');
                    if (!file) return;
                    try {
                        const list = parseForeshadowJson(JSON.parse(await readFileAsText(file)));
                        if (!list.length) throw new Error('文件里没有伏笔数据');
                        await createSnapshot(p, '导入伏笔前');
                        const res = mergeForeshadowItems(p, list);
                        await app.saveNow();
                        app.log(`📥 已导入伏笔：新增 ${res.added} 条，更新 ${res.updated} 条`, 'success');
                        render();
                    } catch (err) {
                        app.log(`导入失败：${err.message}`, 'error');
                    }
                    break;
                }
                default:
                    break;
            }
        };

        const onInput = (e) => {
            if (e.target.dataset.actInput === 'filter') {
                filter = e.target.value;
                render();
            }
        };

        el.addEventListener('click', onClick);
        el.addEventListener('change', onInput);
        render();
        return {};
    },
};
