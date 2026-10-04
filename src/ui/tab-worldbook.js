// 世界书页：分类条目浏览编辑、AI 整理、查找替换、快照、写入酒馆、导入导出

import { app } from '../app.js';
import { WI_POSITIONS } from '../constants.js';
import { exportVolumes, exportWorldbook, mergeExternalWorld } from '../io.js';
import { getVolumes, volumeRangeLabel } from '../project.js';
import { publishVolumeWorldbooks, publishWorldbook } from '../publish.js';
import { getWorldNames } from '../stio.js';
import { createSnapshot, deleteSnapshot, listSnapshots, restoreSnapshot } from '../store.js';
import { consolidateEntry, countMatches, findReplace } from '../tools.js';
import { buildWorldbookEntries } from '../worldbook.js';
import { estimateTokens, pickFile, readFileAsText, truncate, uniq } from '../utils.js';
import { aliasMergeFlow } from './tab-characters.js';
import { bindSettings, busy, confirmDialog, emptyState, esc, fmtTime, icon, openDialog, optionList, promptDialog, qs, rerollBtn } from './common.js';

/** 激活方式标记：常驻 / 关键词触发 / 未分类 */
const activationDot = (constant) => (constant === undefined
    ? '<span class="nl-dot" role="img" aria-label="未分类" title="未分类"></span>'
    : constant
        ? '<span class="nl-dot nl-info" role="img" aria-label="常驻" title="常驻"></span>'
        : '<span class="nl-dot nl-ok" role="img" aria-label="关键词触发" title="关键词触发"></span>');

export async function snapshotsDialog() {
    const p = app.project;
    const draw = async (root) => {
        const snaps = await listSnapshots(p.id);
        root.querySelector('.nl-snaps').innerHTML = snaps.map((s) => `
            <div class="nl-list-item">
                <div class="nl-grow"><b>${esc(s.label)}</b><div class="nl-muted nl-small">${fmtTime(s.createdAt)} · ${s.stats?.characters ?? '?'} 角色 · ${s.stats?.entries ?? '?'} 条目</div></div>
                <button class="nl-btn nl-sm" data-snap-restore="${esc(s.id)}">回退到此</button>
                <button class="nl-btn nl-sm nl-danger" data-snap-del="${esc(s.id)}">删除</button>
            </div>`).join('') || emptyState('快照会列在这里，可以随时回退到其中任何一个。', '', { title: '暂无快照', ico: 'history' });
    };
    await openDialog({
        title: '修改历史（快照）',
        wide: true,
        body: '<div class="nl-row nl-wrap"><button class="nl-btn nl-primary" data-snap-new>创建快照</button><span class="nl-muted nl-small">批量操作前会自动创建快照；每个项目保留最近 50 个。</span></div><div class="nl-snaps nl-list"></div>',
        onMount: (root) => {
            draw(root);
            root.addEventListener('click', async (e) => {
                const t = e.target;
                if (t.matches('[data-snap-new]')) {
                    const label = await promptDialog('快照名称', `手动快照 ${fmtTime(Date.now())}`);
                    if (label === null) return;
                    await createSnapshot(p, label || '手动快照');
                    draw(root);
                } else if (t.dataset.snapRestore) {
                    if (app.isBusy()) return app.log('有任务正在运行（例如提取），请先停止再回退快照', 'warn');
                    if (!(await confirmDialog('回退会用快照内容覆盖当前的角色、世界书、大纲、角色卡、人物关系、群聊场景卡、视角文风、待核实名称，以及各分段的提取状态（分段正文和续写章节不变）。回退前会先自动保存当前状态为快照。继续？'))) return;
                    if (app.isBusy()) return app.log('有任务正在运行（例如提取），请先停止再回退快照', 'warn');
                    await createSnapshot(p, '回退前自动保存');
                    await restoreSnapshot(p, t.dataset.snapRestore);
                    await app.saveNow();
                    app.events.emit('project', p);
                    app.log('⏪ 已回退到快照', 'success');
                    draw(root);
                } else if (t.dataset.snapDel) {
                    await deleteSnapshot(t.dataset.snapDel);
                    draw(root);
                }
            });
        },
    });
}

export const worldbookTab = {
    mount(el, { switchTab, setActions }) {
        let cat = null;
        let search = '';
        let volFilter = '';
        const currentVol = () => (volFilter ? getVolumes(app.project).find((v) => v.id === volFilter) : null);
        const inVol = (e) => {
            const v = currentVol();
            return !v || !(e.sourceChunks || []).some((x) => x >= 0) || e.sourceChunks.some((x) => x >= v.startChunk && x <= v.endChunk);
        };
        const countIn = (c) => Object.values(app.project.worldbook[c] || {}).filter(inVol).length;

        const categories = () => {
            const names = app.settings.categories.filter((c) => c.name !== '角色' && (c.enabled || Object.keys(app.project.worldbook[c.name] || {}).length)).map((c) => c.name);
            for (const k of Object.keys(app.project.worldbook)) if (!names.includes(k)) names.push(k);
            return names;
        };

        const render = () => {
            const p = app.project;
            const cats = categories();
            if (!cat || !cats.includes(cat)) cat = cats.find((c) => Object.keys(p.worldbook[c] || {}).length) || cats[0];
            const vols = getVolumes(p).filter((v) => !v.implicit);
            if (volFilter && !vols.some((v) => v.id === volFilter)) volFilter = '';
            const total = buildWorldbookEntries(p, app.settings, currentVol() ? { volume: currentVol() } : {}).length;
            el.innerHTML = `
            <section class="nl-card">
                <div class="nl-card-desc">「角色」条目由角色档案自动生成，请在「角色」页编辑。写入酒馆时同名世界书会被覆盖。${vols.length ? '选中某一卷时，条目列表只显示该卷出现过的条目，“预览”显示该卷世界书的最终内容（截至卷末）。' : ''}</div>
                <div class="nl-row nl-wrap">
                    <button class="nl-btn" data-act="preview">预览最终条目（${total}）</button>
                    <button class="nl-btn" data-act="export-diff" title="只导出上次导出之后新增或修改的条目">导出变更</button>
                    <span class="nl-spacer"></span>
                    <button class="nl-btn nl-sm" data-act="replace">查找替换</button>
                    <button class="nl-btn nl-sm" data-act="snapshots">修改历史</button>
                </div>
                ${vols.length ? `
                <div class="nl-row nl-wrap nl-vol-bar">
                    <span class="nl-muted nl-small">${icon('filter', { size: 14 })} 查看</span>
                    <select class="nl-input nl-inline" data-vol-filter>${optionList([{ value: '', label: `全书（${vols.length} 卷合并）` }, ...vols.map((v) => ({ value: v.id, label: `${v.name}（${volumeRangeLabel(v)}）` }))], volFilter)}</select>
                    <select class="nl-input nl-inline" data-setting="worldbook.volumeScope" title="分卷世界书包含哪些条目">${optionList([{ value: 'volume', label: '分卷：只含本卷出场的角色与条目' }, { value: 'cumulative', label: '分卷：截至卷末的全部资料' }])}</select>
                    <button class="nl-btn nl-sm" data-act="publish-volumes">分卷写入酒馆</button>
                    <button class="nl-btn nl-sm" data-act="export-volumes">分卷导出</button>
                </div>` : ''}
            </section>
            <div class="nl-seg nl-cat-tabs">
                <button class="nl-seg-btn" data-goto="characters">${icon('characters', { size: 14 })}角色（${Object.keys(p.characters).length}）</button>
                ${cats.map((c) => {
                    const conf = app.settings.categories.find((x) => x.name === c);
                    return `<button class="nl-seg-btn ${c === cat ? 'active' : ''}" data-cat="${esc(c)}">${activationDot(conf ? !!conf.constant : undefined)}${esc(c)}（${countIn(c)}）</button>`;
                }).join('')}
            </div>
            <section class="nl-card">
                <div class="nl-row nl-wrap">
                    <input class="nl-input nl-inline" placeholder="搜索" data-search value="${esc(search)}">
                    <span class="nl-spacer"></span>
                    <button class="nl-btn nl-sm" data-act="add">${icon('plus', { size: 14 })}新建条目</button>
                    <button class="nl-btn nl-sm" data-act="alias">AI 别名检测</button>
                    <button class="nl-btn nl-sm" data-act="consolidate-all">AI 整理本分类长条目</button>
                </div>
                <div class="nl-entry-list">${entriesHtml()}</div>
            </section>`;
            bindSettings(el, app.settings, () => app.saveSettings());
            // 页面级操作：整本世界书的导入、导出、写入酒馆。
            // 只在本页仍挂载时设置：AI 整理、回退快照等异步操作结束后的 render() 可能落在已脱离的旧容器上，
            // 不能把标题栏换成旧闭包的按钮（或覆盖其他页面的按钮）
            if (el.isConnected) setActions?.(`
                <button class="nl-btn" data-act="import" title="合并导入外部世界书（JSON），导入的条目默认锁定">${icon('upload')}合并导入</button>
                <button class="nl-btn" data-act="export">${icon('download')}导出 JSON</button>
                <button class="nl-btn nl-primary" data-act="publish">写入酒馆世界书</button>`, onClick);
        };

        const entriesHtml = () => {
            const p = app.project;
            const entries = Object.values(p.worldbook[cat] || {}).filter(inVol).filter((e) => !search || e.name.includes(search) || e.content.includes(search) || e.keywords.some((k) => k.includes(search)));
            return entries.map((e) => `
                    <div class="nl-entry" data-name="${esc(e.name)}">
                        <div class="nl-row"><b>${esc(e.name)}</b>${e.locked ? icon('lock', { size: 14, label: '已锁定', cls: 'nl-muted' }) : ''}${e.config?.disable ? '<span class="nl-tag">不写入</span>' : ''}<span class="nl-spacer"></span><span class="nl-muted nl-small">${estimateTokens(e.content)} tokens · ${(e.sourceChunks || []).length} 段</span>${rerollBtn('reroll-entry', `data-cat="${esc(cat)}" data-name="${esc(e.name)}"`, { title: 'AI 重新整理这条' })}</div>
                        <div class="nl-muted nl-small">${icon('zap', { size: 14, label: '关键词' })} ${esc(e.keywords.join('、'))}</div>
                        <div class="nl-small nl-clamp">${esc(truncate(e.content, 200))}</div>
                    </div>`).join('') || `<div style="grid-column: 1 / -1">${search
                ? emptyState(`没有名称、关键词或内容包含“${search}”的条目。`, '', { title: '没有匹配的条目', ico: 'search' })
                : emptyState('提取时会自动生成本分类的条目，也可以点“新建条目”手动添加。', '', { title: '这个分类还没有条目', ico: 'worldbook' })}</div>`;
        };

        const editEntry = async (name) => {
            const p = app.project;
            const isNew = !name;
            const e = isNew ? { name: '', keywords: [], content: '', config: {}, locked: true, sourceChunks: [] } : p.worldbook[cat][name];
            const cfg = e.config || {};
            const allCats = categories();
            const { value, root } = await openDialog({
                title: isNew ? `新建条目（${cat}）` : `编辑：${e.name}`,
                wide: true,
                body: `
                    <div class="nl-grid2">
                        <div class="nl-field"><label>名称</label><input class="nl-input" data-f="name" value="${esc(e.name)}"></div>
                        <div class="nl-field"><label>分类</label><select class="nl-input" data-f="cat">${optionList(allCats, cat)}</select></div>
                    </div>
                    <div class="nl-field"><label>关键词（逗号分隔）</label><input class="nl-input" data-f="keywords" value="${esc(e.keywords.join('，'))}"></div>
                    <div class="nl-field"><label>内容 <span class="nl-muted" data-tokens>${estimateTokens(e.content)} tokens</span></label><textarea class="nl-input nl-textarea nl-tall" data-f="content">${esc(e.content)}</textarea></div>
                    <div class="nl-grid3">
                        <div class="nl-field"><label>激活</label><select class="nl-input" data-cfg="constant">${optionList([{ value: '', label: '跟随分类' }, { value: 'true', label: '常驻' }, { value: 'false', label: '关键词' }], cfg.constant === undefined ? '' : String(cfg.constant))}</select></div>
                        <div class="nl-field"><label>位置</label><select class="nl-input" data-cfg="position">${optionList([{ value: '', label: '跟随分类' }, ...WI_POSITIONS], cfg.position ?? '')}</select></div>
                        <div class="nl-field"><label>深度 / 顺序</label><div class="nl-row"><input class="nl-input" type="number" data-cfg="depth" value="${cfg.depth ?? ''}" placeholder="深度"><input class="nl-input" type="number" data-cfg="order" value="${cfg.order ?? ''}" placeholder="顺序"></div></div>
                    </div>
                    <div class="nl-row nl-checks">
                        <label><input type="checkbox" data-cfg="disable" ${cfg.disable ? 'checked' : ''}> 不写入世界书</label>
                        <label><input type="checkbox" data-f="locked" ${e.locked ? 'checked' : ''}> 锁定（后续提取不覆盖内容）</label>
                    </div>
                    ${e.revisions?.length > 1 ? `<details><summary>版本记录（${e.revisions.length}，用于按时间点/按卷生成世界书）</summary>${e.revisions.slice().reverse().map((r) => `<div class="nl-small"><b>第 ${r.chunk + 1} 段后</b>：${esc(truncate(r.content.replace(/\s+/g, ' '), 160))}</div>`).join('')}</details>` : ''}`,
                buttons: [
                    ...(isNew ? [] : [{ label: '删除', value: 'delete', danger: true }, { label: 'AI 整理', value: 'consolidate' }]),
                    { label: '取消', value: null },
                    { label: '保存', value: 'save', primary: true },
                ],
                onMount: (r) => r.querySelector('[data-f="content"]').addEventListener('input', (ev) => {
                    r.querySelector('[data-tokens]').textContent = `${estimateTokens(ev.target.value)} tokens`;
                }),
            });
            if (!value) return;
            if (value === 'delete') {
                if (!(await confirmDialog(`删除条目「${e.name}」？`, { danger: true, okLabel: '删除' }))) return;
                delete p.worldbook[cat][e.name];
                await app.saveNow();
                return render();
            }
            const f = (k) => root.querySelector(`[data-f="${k}"]`);
            const newName = f('name').value.trim();
            if (!newName) return app.log('名称不能为空', 'warn');
            const newCat = f('cat').value;
            const updated = {
                ...e,
                name: newName,
                keywords: uniq([newName, ...f('keywords').value.split(/[，,、\n]/)]),
                content: f('content').value.trim(),
                locked: f('locked').checked,
                updatedAt: Date.now(),
            };
            // 手动修改的内容同步到最新版本
            if (updated.content !== e.content && updated.revisions?.length) {
                updated.revisions = updated.revisions.map((r, i, a) => (i === a.length - 1 ? { ...r, content: updated.content } : r));
            }
            const c2 = {};
            for (const inp of root.querySelectorAll('[data-cfg]')) {
                const k = inp.dataset.cfg;
                if (inp.type === 'checkbox') {
                    if (inp.checked) c2[k] = true;
                } else if (inp.value !== '') c2[k] = k === 'constant' ? inp.value === 'true' : Number(inp.value);
            }
            updated.config = c2;
            if (!isNew) delete p.worldbook[cat][e.name];
            p.worldbook[newCat] = p.worldbook[newCat] || {};
            p.worldbook[newCat][newName] = updated;
            if (value === 'consolidate') {
                cat = newCat;
                await app.saveNow();
                await busy(null, async () => {
                    app.log(`✨ AI 整理「${newName}」…`);
                    await createSnapshot(p, `整理条目「${newName}」前`);
                    await consolidateEntry(p, app.settings, newCat, newName);
                    app.log(`✨ 已整理「${newName}」`, 'success');
                });
            }
            await app.saveNow();
            render();
            if (value === 'consolidate') editEntry(newName);
        };

        const onClick = async (e) => {
            // 分类切换按钮只有 data-cat；条目上的「重新整理」按钮也带 data-cat，但它有 data-act，要交给下面的 switch
            const tabBtn = e.target.closest('[data-cat]:not([data-act])');
            if (tabBtn) {
                cat = tabBtn.dataset.cat;
                return render();
            }
            const go = e.target.closest('[data-goto]');
            if (go) return switchTab(go.dataset.goto);
            const entry = e.target.closest('.nl-entry');
            if (entry && !e.target.closest('[data-act]')) return editEntry(entry.dataset.name);
            const btn = e.target.closest('[data-act]');
            if (!btn) return;
            const p = app.project;
            switch (btn.dataset.act) {
                case 'add':
                    return editEntry(null);
                case 'reroll-entry': {
                    if (app.isBusy()) return app.log('有任务正在运行，请稍后', 'warn');
                    const catName = btn.dataset.cat;
                    const name = btn.dataset.name;
                    await createSnapshot(p, `AI 整理「${name}」前`);
                    await busy(btn, async () => {
                        await consolidateEntry(p, app.settings, catName, name);
                        await app.saveNow();
                        app.log(`✨ 已整理「${name}」`, 'success');
                    }, 'AI 整理中…');
                    return render();
                }
                case 'alias':
                    if (await aliasMergeFlow(cat, btn)) render();
                    return;
                case 'consolidate-all': {
                    const list = Object.values(p.worldbook[cat] || {}).filter((x) => !x.locked && x.content.length > 300);
                    if (!list.length) return app.log('本分类没有需要整理的长条目（>300 字且未锁定）');
                    if (!(await confirmDialog(`将用 AI 逐条整理 ${list.length} 个条目，会消耗 token。继续？`))) return;
                    await createSnapshot(p, `批量整理「${cat}」前`);
                    await busy(btn, async () => {
                        for (const x of list) {
                            try {
                                await consolidateEntry(p, app.settings, cat, x.name);
                                app.log(`✨ 已整理「${x.name}」`, 'success');
                            } catch (err) {
                                app.log(`整理「${x.name}」失败：${err.message}`, 'error');
                            }
                        }
                        await app.saveNow();
                    }, 'AI 整理中…');
                    return render();
                }
                case 'publish': {
                    const def = (app.settings.worldbook.namePattern || '《{book}》世界书').replace('{book}', p.bookName);
                    const name = await promptDialog('世界书名称（同名会覆盖）', def, { title: '写入酒馆' });
                    if (!name) return;
                    const exists = (await getWorldNames().catch(() => [])).includes(name);
                    if (exists && !(await confirmDialog(`酒馆中已存在世界书「${name}」，覆盖它？`, { okLabel: '覆盖' }))) return;
                    await busy(btn, async () => {
                        const n = await publishWorldbook(p, app.settings, name);
                        app.log(`📖 已写入酒馆世界书「${name}」：${n} 条`, 'success');
                        globalThis.toastr?.success(`已写入世界书「${name}」（${n} 条）`, 'NovelLoom');
                    }, '写入中…');
                    return;
                }
                case 'export': {
                    const n = exportWorldbook(p, app.settings);
                    app.log(`📤 已导出世界书 ${n} 条`, 'success');
                    return app.saveNow();
                }
                case 'export-diff': {
                    if (!p.lastWorldExportAt) return app.log('还没有导出过，请先完整导出一次', 'warn');
                    const n = exportWorldbook(p, app.settings, { since: p.lastWorldExportAt });
                    app.log(n ? `📤 已导出 ${n} 条变更` : '上次导出后没有变更', n ? 'success' : 'info');
                    return app.saveNow();
                }
                case 'import': {
                    const file = await pickFile('.json,application/json');
                    if (!file) return;
                    await busy(btn, async () => {
                        const json = JSON.parse(await readFileAsText(file));
                        await createSnapshot(p, '合并导入世界书前');
                        const n = mergeExternalWorld(p, json);
                        await app.saveNow();
                        app.log(`📥 已合并导入 ${n} 个条目（导入条目默认锁定）`, 'success');
                    });
                    return render();
                }
                case 'publish-volumes': {
                    const vols = getVolumes(p).filter((v) => !v.implicit);
                    if (!(await confirmDialog(`为 ${vols.length} 卷各写入一本世界书（名为「世界书名·卷名」，同名覆盖）？`))) return;
                    await busy(btn, async () => {
                        const r = await publishVolumeWorldbooks(p, app.settings, { scope: app.settings.worldbook.volumeScope });
                        app.log(`📖 已分卷写入酒馆：${r.map((x) => `${x.name}（${x.count}）`).join('、')}`, 'success');
                        globalThis.toastr?.success(`已写入 ${r.length} 本分卷世界书`, 'NovelLoom');
                    }, '写入中…');
                    return;
                }
                case 'export-volumes': {
                    const n = exportVolumes(p, app.settings, { scope: app.settings.worldbook.volumeScope });
                    app.log(`📤 已分卷导出 ${n} 个文件`, 'success');
                    return;
                }
                case 'preview': {
                    const entries = buildWorldbookEntries(p, app.settings, currentVol() ? { volume: currentVol() } : {});
                    const tokens = entries.reduce((n, x) => n + estimateTokens(x.content), 0);
                    await openDialog({
                        title: `${currentVol() ? `「${currentVol().name}」` : '最终'}世界书预览：${entries.length} 条，约 ${tokens} tokens`,
                        wide: true,
                        body: `<table class="nl-table"><thead><tr><th>分类</th><th>名称</th><th>激活</th><th>位置</th><th>顺序</th><th>tokens</th></tr></thead><tbody>
                            ${entries.map((x) => `<tr class="${x.disable ? 'nl-dim' : ''}"><td>${esc(x.category)}</td><td title="${esc(x.keywords.join('、'))}">${esc(x.name)}</td><td>${x.constant ? '<span class="nl-dot nl-info"></span> 常驻' : '<span class="nl-dot nl-ok"></span> 关键词'}</td><td>${esc(WI_POSITIONS.find((w) => w.value === x.position)?.label || x.position)}</td><td>${x.order}</td><td>${estimateTokens(x.content)}</td></tr>`).join('')}
                            </tbody></table>`,
                    });
                    return;
                }
                case 'replace':
                    await replaceDialog();
                    return render();
                case 'snapshots':
                    await snapshotsDialog();
                    return render();
                default:
                    break;
            }
        };

        const replaceDialog = async () => {
            const p = app.project;
            const { value, root } = await openDialog({
                title: '查找替换（不消耗 token）',
                body: `
                    <div class="nl-field"><label>查找</label><input class="nl-input" data-f="find"></div>
                    <div class="nl-field"><label>替换为</label><input class="nl-input" data-f="replace"></div>
                    <div class="nl-row nl-checks">
                        <label><input type="checkbox" data-f="regex"> 正则</label>
                        <label><input type="checkbox" data-f="case"> 区分大小写</label>
                        <label><input type="checkbox" data-scope="worldbook" checked> 世界书</label>
                        <label><input type="checkbox" data-scope="characters" checked> 角色档案</label>
                        <label><input type="checkbox" data-scope="cards"> 角色卡</label>
                    </div>
                    <div class="nl-muted" data-count></div>`,
                buttons: [{ label: '取消', value: null }, { label: '统计匹配', value: 'count', validate: (r) => {
                    const o = readOpts(r);
                    try {
                        r.querySelector('[data-count]').textContent = `匹配 ${countMatches(p, o)} 处`;
                    } catch (err) {
                        r.querySelector('[data-count]').textContent = err.message;
                    }
                    return false;
                } }, { label: '全部替换', value: 'ok', primary: true }],
            });
            if (value !== 'ok') return;
            const opts = readOpts(root);
            if (!opts.find) return;
            await createSnapshot(p, `替换「${opts.find}」前`);
            const n = findReplace(p, opts);
            await app.saveNow();
            app.log(`🔁 已替换 ${n} 处`, 'success');
        };

        const readOpts = (r) => ({
            find: r.querySelector('[data-f="find"]').value,
            replace: r.querySelector('[data-f="replace"]').value,
            regex: r.querySelector('[data-f="regex"]').checked,
            caseSensitive: r.querySelector('[data-f="case"]').checked,
            scope: [...r.querySelectorAll('[data-scope]')].filter((x) => x.checked).map((x) => x.dataset.scope),
        });

        const onChange = (e) => {
            if (e.target.matches('[data-vol-filter]')) {
                volFilter = e.target.value;
                render();
            }
        };

        const onInput = (e) => {
            if (e.target.matches('[data-search]') && !e.isComposing) {
                search = e.target.value;
                qs(el, '.nl-entry-list').innerHTML = entriesHtml();
            }
        };

        el.addEventListener('click', onClick);
        el.addEventListener('input', onInput);
        el.addEventListener('compositionend', onInput);
        el.addEventListener('change', onChange);
        render();
        return {};
    },
};

