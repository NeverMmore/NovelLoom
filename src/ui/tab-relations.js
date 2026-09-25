// 关系页：人物关系图谱可视化 + 编辑表 + AI 分析（防剧透：按故事时间点筛选）

import { app } from '../app.js';
import { getVolumes, IMPORTANCE_RANK } from '../project.js';
import {
    addCustomRelationType,
    addRelationship,
    allRelationTypes,
    analyzeRelationships,
    customRelationTypes,
    exportRelationshipsJson,
    mergeRelationships,
    parseRelationshipsJson,
    relationsAt,
    relationTypeColor,
    relationTypeLabel,
    removeCustomRelationType,
    removeRelationship,
    updateRelationship,
} from '../relations.js';
import { createSnapshot } from '../store.js';
import { downloadFile, pickFile, readFileAsText, safeFileName, truncate } from '../utils.js';
import { alertDialog, busy, confirmDialog, esc, openDialog, optionList } from './common.js';

function timeOptions(project) {
    const vols = getVolumes(project).filter((v) => !v.implicit);
    const opts = [{ value: '', label: '全书结束时（使用全部资料）' }];
    for (const c of project.chunks) {
        const v = vols.find((x) => x.startChunk === c.index);
        if (v) opts.push({ value: String(v.endChunk), label: `📦 ${v.name} 卷末（第 ${v.endChunk + 1} 段）` });
        opts.push({ value: String(c.index), label: `　第 ${c.index + 1} 段结束时：${truncate(c.title, 30)}` });
    }
    return opts;
}

function layoutNodes(names, w, h) {
    const cx = w / 2;
    const cy = h / 2;
    const r = Math.max(60, Math.min(cx, cy) - 50);
    return names.map((name, i) => {
        const a = (i / Math.max(1, names.length)) * Math.PI * 2 - Math.PI / 2;
        return { name, x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) };
    });
}

/** 圆形关系图：节点按名称环形排布，边按类型着色，非双向的边带箭头 */
function buildSvg(edges, names, focus, settings) {
    if (!names.length) return '<div class="nl-empty">还没有可展示的关系。用「+ 添加关系」手动添加，或点「🤖 AI 分析关系」自动提取。</div>';
    const W = 640;
    const H = 420;
    const nodes = layoutNodes(names, W, H);
    const pos = new Map(nodes.map((n) => [n.name, n]));
    const types = [...new Set(edges.map((e) => e.type))];
    const defs = types.map((t) => `<marker id="nl-arrow-${esc(t)}" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto" markerUnits="userSpaceOnUse"><path d="M0,0 L6,3 L0,6 Z" fill="${relationTypeColor(t, settings)}"></path></marker>`).join('');
    const lines = edges.map((r) => {
        const a = pos.get(r.from);
        const b = pos.get(r.to);
        if (!a || !b) return '';
        const dim = focus && r.from !== focus && r.to !== focus;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const len = Math.hypot(dx, dy) || 1;
        const pad = 22;
        const x1 = a.x + (dx / len) * pad;
        const y1 = a.y + (dy / len) * pad;
        const x2 = b.x - (dx / len) * pad;
        const y2 = b.y - (dy / len) * pad;
        return `<line data-id="${r.id}" x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="${relationTypeColor(r.type, settings)}" stroke-width="2" opacity="${dim ? 0.2 : 0.9}" ${r.mutual ? '' : `marker-end="url(#nl-arrow-${esc(r.type)})"`} class="nl-rel-edge"><title>${esc(r.from)} ${r.mutual ? '↔' : '→'} ${esc(r.to)}：${esc(relationTypeLabel(r.type, settings))}${r.label ? `，${esc(r.label)}` : ''}</title></line>`;
    }).join('');
    const dots = nodes.map((n) => {
        const dim = focus && n.name !== focus;
        return `<g class="nl-rel-node ${n.name === focus ? 'active' : ''}" data-name="${esc(n.name)}" opacity="${dim ? 0.35 : 1}">
            <circle cx="${n.x.toFixed(1)}" cy="${n.y.toFixed(1)}" r="18"></circle>
            <text x="${n.x.toFixed(1)}" y="${n.y.toFixed(1)}" text-anchor="middle" dominant-baseline="central">${esc(truncate(n.name, 4))}</text>
            <title>${esc(n.name)}</title>
        </g>`;
    }).join('');
    return `<svg class="nl-rel-svg" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg"><defs>${defs}</defs>${lines}${dots}</svg>`;
}

export const relationsTab = {
    mount(el) {
        let upto = '';
        let typeFilter = 'all';
        let focus = null;

        const uptoNum = () => (upto === '' ? Infinity : Number(upto));

        const edgesAll = () => relationsAt(app.project, uptoNum());
        const edgesFiltered = () => {
            let list = edgesAll();
            if (typeFilter !== 'all') list = list.filter((r) => r.type === typeFilter);
            if (focus) list = list.filter((r) => r.from === focus || r.to === focus);
            return list;
        };

        const openEditDialog = async (existing) => {
            const p = app.project;
            const names = Object.values(p.characters)
                .sort((a, b) => (IMPORTANCE_RANK[b.importance] - IMPORTANCE_RANK[a.importance]) || (b.chunksSeen.length - a.chunksSeen.length))
                .map((c) => c.name);
            if (names.length < 2) return alertDialog('至少需要 2 个已提取的角色才能建立关系。先去「角色」页或「提取」页积累角色资料。');
            const r = existing || {
                from: names[0],
                to: names[1],
                type: 'friend',
                mutual: true,
                label: '',
                notes: '',
                chunk: p.chunks.length ? p.chunks.length - 1 : 0,
            };
            const chunkOpts = p.chunks.map((c) => ({ value: String(c.index), label: `第 ${c.index + 1} 段：${truncate(c.title, 30)}` }));
            const body = `
                <div class="nl-grid2">
                    <div class="nl-field"><label>角色 A</label><select class="nl-input" data-f="from">${optionList(names, r.from)}</select></div>
                    <div class="nl-field"><label>角色 B</label><select class="nl-input" data-f="to">${optionList(names, r.to)}</select></div>
                    <div class="nl-field"><label>关系类型</label><select class="nl-input" data-f="type">${optionList(allRelationTypes(app.settings), r.type)}</select></div>
                    <div class="nl-field"><label><input type="checkbox" data-f="mutual" ${r.mutual ? 'checked' : ''}> 双向（不勾选表示 A → B 单向，如暗恋、师徒）</label></div>
                </div>
                <div class="nl-field"><label>说明（一句话，写具体画面而不是空泛评价）</label><input class="nl-input" data-f="label" value="${esc(r.label)}" placeholder="例如：从小一起长大，互相救过对方性命"></div>
                <div class="nl-field"><label>备注</label><textarea class="nl-input nl-textarea" rows="2" data-f="notes">${esc(r.notes || '')}</textarea></div>
                ${chunkOpts.length ? `<div class="nl-field"><label>建立于（故事时间点，用于角色卡防剧透筛选）</label><select class="nl-input" data-f="chunk">${optionList(chunkOpts, String(r.chunk))}</select></div>` : ''}`;
            const { value, root } = await openDialog({
                title: existing ? `编辑关系：${existing.from} ${existing.mutual ? '↔' : '→'} ${existing.to}` : '添加关系',
                body,
                wide: true,
                buttons: [{ label: '取消', value: null }, { label: '保存', value: 'ok', primary: true }],
            });
            if (value !== 'ok') return;
            const v = (f) => root.querySelector(`[data-f="${f}"]`);
            const data = {
                from: v('from').value,
                to: v('to').value,
                type: v('type').value,
                mutual: v('mutual').checked,
                label: v('label').value.trim(),
                notes: v('notes').value.trim(),
                chunk: v('chunk') ? Number(v('chunk').value) : 0,
            };
            if (data.from === data.to) return app.log('不能选择同一个角色', 'warn');
            const p2 = app.project;
            await createSnapshot(p2, existing ? '编辑关系前' : '添加关系前');
            try {
                if (existing) updateRelationship(p2, existing.id, data, app.settings);
                else addRelationship(p2, data, app.settings);
                await app.saveNow();
                app.log(existing ? `✏️ 已修改关系：${data.from} ${data.mutual ? '↔' : '→'} ${data.to}` : `🔗 已添加关系：${data.from} ${data.mutual ? '↔' : '→'} ${data.to}`, 'success');
                render();
            } catch (e) {
                app.log(e.message, 'error');
            }
        };

        /** 自定义关系类型管理：新增/改名/改色/删除，保存在扩展设置里，跨项目共享 */
        const openTypesDialog = async () => {
            const custom = customRelationTypes(app.settings);
            const body = `
                <div class="nl-muted nl-small">自定义类型保存在扩展设置里，所有项目共用。删除某个类型不会改动已经用它标注过的关系（只是它不再出现在下拉选项里）。</div>
                <table class="nl-table" style="margin-top:8px">
                    <thead><tr><th>颜色</th><th>名称</th><th></th></tr></thead>
                    <tbody>
                        ${custom.map((t) => `<tr data-ctype="${esc(t.value)}">
                            <td><input type="color" data-ct-color value="${esc(t.color)}"></td>
                            <td><input class="nl-input" data-ct-label value="${esc(t.label)}"></td>
                            <td><button class="nl-icon-btn" data-ct-del title="删除">✕</button></td>
                        </tr>`).join('') || '<tr><td colspan="3" class="nl-muted">还没有自定义类型</td></tr>'}
                        <tr>
                            <td><input type="color" data-ct-new-color value="#3fb6c9"></td>
                            <td><input class="nl-input" data-ct-new-label placeholder="新类型名称，例如「养父女」"></td>
                            <td><button class="nl-btn nl-sm" data-ct-add>+ 添加</button></td>
                        </tr>
                    </tbody>
                </table>`;
            const { value } = await openDialog({
                title: '自定义关系类型',
                wide: true,
                body,
                buttons: [{ label: '关闭', value: null }],
                onMount: (r, close) => {
                    r.addEventListener('change', (e) => {
                        const tr = e.target.closest('[data-ctype]');
                        if (!tr) return;
                        const v = tr.dataset.ctype;
                        if (e.target.matches('[data-ct-color]')) updateCustomRelationType(app.settings, v, { color: e.target.value });
                        if (e.target.matches('[data-ct-label]')) updateCustomRelationType(app.settings, v, { label: e.target.value });
                        app.saveSettings();
                        render();
                    });
                    r.addEventListener('click', async (e) => {
                        if (e.target.matches('[data-ct-del]')) {
                            const tr = e.target.closest('[data-ctype]');
                            const v = tr.dataset.ctype;
                            const t = custom.find((x) => x.value === v);
                            if (!(await confirmDialog(`删除自定义关系类型「${t?.label}」？`, { danger: true, okLabel: '删除' }))) return;
                            removeCustomRelationType(app.settings, v);
                            app.saveSettings();
                            close('refresh');
                        } else if (e.target.matches('[data-ct-add]')) {
                            const labelInput = r.querySelector('[data-ct-new-label]');
                            const colorInput = r.querySelector('[data-ct-new-color]');
                            try {
                                addCustomRelationType(app.settings, { label: labelInput.value, color: colorInput.value });
                                app.saveSettings();
                                close('refresh');
                            } catch (err) {
                                app.log(err.message, 'error');
                            }
                        }
                    });
                },
            });
            render();
            if (value === 'refresh') await openTypesDialog();
        };

        const render = () => {
            const p = app.project;
            const edges = edgesFiltered();
            const graphEdges = focus ? edgesAll().filter((r) => typeFilter === 'all' || r.type === typeFilter) : edges;
            const names = [...new Set(graphEdges.flatMap((r) => [r.from, r.to]))].sort((a, b) => a.localeCompare(b, 'zh'));
            el.innerHTML = `
            <section class="nl-card">
                <div class="nl-row nl-wrap">
                    <div class="nl-field"><label>故事时间点（防剧透：只显示此前已建立的关系）</label><select class="nl-input nl-inline" data-act-input="upto">${optionList(timeOptions(p), upto)}</select></div>
                    <div class="nl-field"><label>类型筛选</label><select class="nl-input nl-inline" data-act-input="type">${optionList([{ value: 'all', label: '全部类型' }, ...allRelationTypes(app.settings)], typeFilter)}</select></div>
                    <span class="nl-spacer"></span>
                    <button class="nl-btn nl-sm" data-act="manage-types">⚙️ 自定义类型</button>
                    <button class="nl-btn nl-sm" data-act="export">导出</button>
                    <button class="nl-btn nl-sm" data-act="import">导入</button>
                    <button class="nl-btn nl-sm" data-act="analyze">🤖 AI 分析关系</button>
                    <button class="nl-btn nl-sm nl-primary" data-act="add">+ 添加关系</button>
                </div>
                ${focus ? `<div class="nl-row nl-muted nl-small">只看「${esc(focus)}」的关系 <button class="nl-icon-btn" data-act="clear-focus" title="清除">✕</button></div>` : ''}
            </section>
            <section class="nl-card nl-rel-graph">${buildSvg(graphEdges, names, focus, app.settings)}</section>
            <section class="nl-card">
                <h3>关系列表（${edges.length}）</h3>
                ${edges.length ? `<table class="nl-table"><thead><tr><th>角色</th><th></th><th>角色</th><th>类型</th><th>说明</th><th>建立于</th><th></th></tr></thead><tbody>
                    ${edges.map((r) => `<tr data-id="${esc(r.id)}">
                        <td><a data-act="focus-name" data-name="${esc(r.from)}">${esc(r.from)}</a></td>
                        <td>${r.mutual ? '↔' : '→'}</td>
                        <td><a data-act="focus-name" data-name="${esc(r.to)}">${esc(r.to)}</a></td>
                        <td><span class="nl-tag" style="border-color:${relationTypeColor(r.type, app.settings)};color:${relationTypeColor(r.type, app.settings)}">${esc(relationTypeLabel(r.type, app.settings))}</span>${r.auto ? ' <span class="nl-muted nl-small" title="AI 自动分析得出">🤖</span>' : ''}</td>
                        <td>${esc(r.label || '')}</td>
                        <td class="nl-muted nl-small">第 ${r.chunk + 1} 段</td>
                        <td class="nl-row"><button class="nl-icon-btn" data-act="edit" data-id="${esc(r.id)}" title="编辑">✏️</button><button class="nl-icon-btn" data-act="del" data-id="${esc(r.id)}" title="删除">✕</button></td>
                    </tr>`).join('')}
                </tbody></table>` : `<div class="nl-empty">${p.relationships?.length ? '没有符合筛选条件的关系。' : '还没有任何关系数据。'}</div>`}
            </section>`;
        };

        const onClick = async (e) => {
            const node = e.target.closest('.nl-rel-node');
            if (node) {
                focus = focus === node.dataset.name ? null : node.dataset.name;
                return render();
            }
            const nameLink = e.target.closest('[data-act="focus-name"]');
            if (nameLink) {
                focus = focus === nameLink.dataset.name ? null : nameLink.dataset.name;
                return render();
            }
            const btn = e.target.closest('[data-act]');
            if (!btn) return;
            const p = app.project;
            switch (btn.dataset.act) {
                case 'add':
                    await openEditDialog(null);
                    break;
                case 'edit': {
                    const r = (p.relationships || []).find((x) => x.id === btn.dataset.id);
                    if (r) await openEditDialog(r);
                    break;
                }
                case 'del': {
                    const r = (p.relationships || []).find((x) => x.id === btn.dataset.id);
                    if (!r) return;
                    if (!(await confirmDialog(`删除「${r.from} ${r.mutual ? '↔' : '→'} ${r.to}」这条关系？`, { danger: true, okLabel: '删除' }))) return;
                    await createSnapshot(p, '删除关系前');
                    removeRelationship(p, r.id);
                    await app.saveNow();
                    render();
                    break;
                }
                case 'clear-focus':
                    focus = null;
                    render();
                    break;
                case 'manage-types':
                    await openTypesDialog();
                    break;
                case 'analyze':
                    await busy(btn, async () => {
                        const res = await analyzeRelationships(p, app.settings, { upto: uptoNum(), onLog: (m, l) => app.log(m, l) });
                        await app.saveNow();
                        app.log(`🔗 AI 分析关系：新增 ${res.added} 条${res.updated ? `，更新 ${res.updated} 条` : ''}${res.skipped ? `，跳过 ${res.skipped} 条（角色名无法匹配）` : ''}`, 'success');
                    }, 'AI 分析中…');
                    render();
                    break;
                case 'export':
                    downloadFile(JSON.stringify(exportRelationshipsJson(p), null, 2), `${safeFileName(p.bookName)}-关系.novelloom-relations.json`);
                    break;
                case 'import': {
                    const file = await pickFile('.json,application/json');
                    if (!file) return;
                    try {
                        const list = parseRelationshipsJson(JSON.parse(await readFileAsText(file)));
                        if (!list.length) throw new Error('文件里没有关系数据');
                        await createSnapshot(p, '导入关系前');
                        const res = mergeRelationships(p, list, p.chunks.length ? p.chunks.length - 1 : 0, app.settings);
                        await app.saveNow();
                        app.log(`📥 已导入关系：新增 ${res.added} 条，更新 ${res.updated} 条`, 'success');
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
            const k = e.target.dataset.actInput;
            if (!k) return;
            if (k === 'upto') upto = e.target.value;
            if (k === 'type') typeFilter = e.target.value;
            render();
        };

        el.addEventListener('click', onClick);
        el.addEventListener('change', onInput);
        render();
        return {};
    },
};
