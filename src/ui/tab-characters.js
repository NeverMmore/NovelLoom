// 角色页：角色档案列表与编辑、AI 整理、别名合并

import { app } from '../app.js';
import { WI_POSITIONS } from '../constants.js';
import { IMPORTANCE_RANK, mergeCharactersInto, mergeEntriesInto, normalizeCharacter, pruneGroupCards, prunePov, pruneRelationships, renameCharacter } from '../project.js';
import { createSnapshot } from '../store.js';
import { consolidateCharacter, detectAliases, expandCharacter } from '../tools.js';
import { truncate, uniq } from '../utils.js';
import { busy, confirmDialog, emptyState, esc, icon, importanceLabel, openDialog, optionList, promptDialog, qs, qsa, rerollBtn } from './common.js';

/** 名单过长时只列前几个：「甲、乙、丙 等 12 个」 */
function nameList(names, max = 8) {
    return names.length > max ? `${names.slice(0, max).join('、')} 等 ${names.length} 个` : names.join('、');
}

/** 按重要度、出场段数排序（也用来挑合并时默认保留的角色） */
function byImportance(a, b) {
    return (IMPORTANCE_RANK[b.importance] - IMPORTANCE_RANK[a.importance]) || (b.chunksSeen.length - a.chunksSeen.length);
}

/** 台词/对话样本的原文校验标记：false = 原文里找不到，true = 已校验，未校验则不显示 */
function verifiedMark(verified) {
    if (verified === false) return `<span class="nl-warn" title="未能在原文中逐字找到">${icon('alert', { size: 14, label: '未能在原文中逐字找到' })}</span>`;
    if (verified) return `<span class="nl-ok" title="已校验">${icon('check', { size: 14, label: '已校验' })}</span>`;
    return '';
}

export async function aliasMergeFlow(category, btn) {
    const p = app.project;
    const groups = await busy(btn, () => detectAliases(p, app.settings, category, { onLog: (m) => app.log(m) }), 'AI 检测中…');
    if (!groups) return false;
    if (!groups.length) {
        app.log(`🔍 「${category}」未发现可合并的别名`, 'success');
        return false;
    }
    const body = `<div class="nl-muted">勾选要合并的组；可修改保留的规范名。</div>
        ${groups.map((g, i) => `
        <div class="nl-alias-group">
            <label><input type="checkbox" data-g="${i}" checked> 合并为</label>
            <select class="nl-input nl-inline" data-main="${i}">${optionList([g.main, ...g.aliases], g.main)}</select>
            <span>← ${g.aliases.map(esc).join('、')}</span>
            <div class="nl-muted nl-small">${esc(g.reason)}</div>
        </div>`).join('')}`;
    const { value, root } = await openDialog({ title: `别名合并：${category}`, body, wide: true, buttons: [{ label: '取消', value: null }, { label: '合并所选', value: 'ok', primary: true }] });
    if (value !== 'ok') return false;
    await createSnapshot(p, `别名合并（${category}）前`);
    let n = 0;
    groups.forEach((g, i) => {
        if (!root.querySelector(`[data-g="${i}"]`).checked) return;
        const main = root.querySelector(`[data-main="${i}"]`).value;
        const all = uniq([g.main, ...g.aliases]);
        const others = all.filter((x) => x !== main);
        try {
            if (category === '角色') mergeCharactersInto(p, main, others);
            else mergeEntriesInto(p, category, main, others);
            n++;
        } catch (e) {
            app.log(`合并失败：${e.message}`, 'error');
        }
    });
    await app.saveNow();
    app.log(`🔗 已合并 ${n} 组别名`, 'success');
    return true;
}

export const charactersTab = {
    mount(el, { switchTab, setActions }) {
        let search = '';
        let filter = 'all';
        let sort = 'importance';
        let current = null;
        // 多选模式：勾选若干角色后批量合并 / 删除（只在本页内有效，切换页面即退出）
        let selecting = false;
        const selected = new Set();
        let anchor = null; // Shift+点击 连选的起点

        const byOrder = (a, b) => {
            if (sort === 'first') return a.firstChunk - b.firstChunk;
            if (sort === 'name') return a.name.localeCompare(b.name, 'zh');
            return byImportance(a, b);
        };

        const list = () => {
            const chars = Object.values(app.project.characters);
            const s = search.trim();
            return chars
                .filter((c) => filter === 'all' || c.importance === filter)
                .filter((c) => !s || c.name.includes(s) || c.aliases.some((a) => a.includes(s)) || c.identity.includes(s))
                .sort(byOrder);
        };

        /** 已勾选且仍然存在的角色名（按当前排序，包括被搜索/筛选隐藏的） */
        const selectedNames = () => {
            const chars = app.project.characters;
            for (const n of [...selected]) if (!chars[n]) selected.delete(n);
            return Object.values(chars).filter((c) => selected.has(c.name)).sort(byOrder).map((c) => c.name);
        };

        const rows = () => qsa(el, '.nl-char-list .nl-char-item');

        /** 勾选状态变化后只同步复选框与行高亮，不重绘列表（保留焦点与滚动位置） */
        const syncChecks = () => {
            for (const row of rows()) {
                const on = selected.has(row.dataset.name);
                row.classList.toggle('active', on);
                const cb = row.querySelector('.nl-chk');
                if (cb) cb.checked = on;
            }
            updateSelBar();
        };

        const updateSelBar = (items = list()) => {
            const tog = qs(el, '[data-act="toggle-select"]');
            const bar = qs(el, '.nl-char-selbar');
            if (!tog || !bar) return;
            tog.textContent = selecting ? '退出多选' : '多选';
            tog.setAttribute('aria-pressed', String(selecting));
            bar.hidden = !selecting;
            if (!selecting) return;
            const names = selectedNames();
            const n = names.length;
            const visible = items.map((c) => c.name);
            const offList = names.filter((x) => !visible.includes(x)).length;
            qs(bar, '.nl-char-selcount').innerHTML = `已选 <b>${n}</b> 个角色${offList ? `<span class="nl-muted">（其中 ${offList} 个不在当前列表里）</span>` : ''}`;
            const all = qs(bar, '[data-act="select-all"], [data-act="select-none"]');
            const allOn = visible.length > 0 && visible.every((x) => selected.has(x));
            const filtered = !!search.trim() || filter !== 'all';
            all.dataset.act = allOn ? 'select-none' : 'select-all';
            all.textContent = allOn ? '全不选' : filtered ? `全选当前结果（${visible.length}）` : '全选';
            all.title = allOn ? '取消勾选当前列表里的角色' : '勾选当前搜索/筛选结果里的全部角色';
            all.disabled = !visible.length;
            const merge = qs(bar, '[data-act="merge-selected"]');
            merge.disabled = n < 2;
            merge.title = n < 2 ? '至少选 2 个角色才能合并' : `把所选 ${n} 个角色合并成一个`;
            const del = qs(bar, '[data-act="delete-selected"]');
            del.disabled = !n;
            qs(del, '.nl-char-dellabel').textContent = `删除所选（${n}）`;
        };

        const renderList = () => {
            const box = qs(el, '.nl-char-list');
            const items = list();
            // 重绘会替换掉行元素：记下键盘焦点所在的角色，重绘后放回去
            const f = document.activeElement;
            const focusName = f && box.contains(f) ? f.closest('.nl-char-item')?.dataset.name : undefined;
            box.innerHTML = items.map((c) => {
                const info = `
                    <div><b>${esc(c.name)}</b> <span class="nl-tag nl-imp-${c.importance}">${importanceLabel(c.importance)}</span>${c.locked ? ` <span class="nl-muted" title="已锁定">${icon('lock', { size: 13, label: '已锁定' })}</span>` : ''}</div>
                    <div class="nl-muted nl-small">${esc(truncate(c.identity || '（无身份）', 40))} · 出场 ${c.chunksSeen.length} 段</div>`;
                if (!selecting) {
                    return `
                <div class="nl-char-item ${current === c.name ? 'active' : ''}" data-name="${esc(c.name)}" tabindex="0" role="button">${info}
                </div>`;
                }
                const on = selected.has(c.name);
                return `
                <div class="nl-char-item ${on ? 'active' : ''}" data-name="${esc(c.name)}" style="display:flex;align-items:center;gap:var(--nl-s3);user-select:none">
                    <input type="checkbox" class="nl-chk" data-name="${esc(c.name)}" aria-label="选择「${esc(c.name)}」" ${on ? 'checked' : ''}>
                    <div class="nl-grow">${info}</div>
                </div>`;
            }).join('') || (Object.keys(app.project.characters).length
                ? emptyState('没有符合筛选条件的角色。', '', { ico: 'search' })
                : emptyState('先去「提取」页提取资料。', '<button class="nl-btn nl-sm" data-goto="extract">去提取</button>', { title: '没有角色', ico: 'characters' }));
            qs(el, '.nl-char-count').textContent = `${items.length} / ${Object.keys(app.project.characters).length}`;
            if (focusName !== undefined) {
                const row = rows().find((r) => r.dataset.name === focusName);
                (selecting ? row?.querySelector('.nl-chk') : row)?.focus({ preventScroll: true });
            }
            updateSelBar(items);
        };

        const setSelecting = (on) => {
            const f = document.activeElement;
            const focusInside = !!f && !!f.closest?.('.nl-char-list, .nl-char-selbar') && el.contains(f);
            selecting = on;
            selected.clear();
            anchor = null;
            renderList();
            // 退出多选时选择栏按钮会隐藏（复选框所在行的焦点已由 renderList 放回行上），其余情况把焦点交给「多选」开关
            if (!on && focusInside && !qs(el, '.nl-char-list').contains(document.activeElement)) qs(el, '[data-act="toggle-select"]')?.focus();
        };

        /** 多选模式下点击一行：切换勾选；按住 Shift 时把上次点击处到这里的一段设成同样的状态 */
        const toggleRow = (item, e) => {
            const name = item.dataset.name;
            const cb = item.querySelector('.nl-chk');
            // 点在复选框上时浏览器已经切换了勾选状态；点在行的其他位置由这里切换
            const on = e.target === cb ? cb.checked : !selected.has(name);
            let names = [name];
            if (e.shiftKey && anchor && anchor !== name) {
                const order = list().map((c) => c.name);
                const a = order.indexOf(anchor);
                const b = order.indexOf(name);
                if (a >= 0 && b >= 0) names = order.slice(Math.min(a, b), Math.max(a, b) + 1);
            }
            for (const n of names) {
                if (on) selected.add(n);
                else selected.delete(n);
            }
            anchor = name;
            syncChecks();
        };

        const renderDetail = () => {
            const box = qs(el, '.nl-char-detail');
            const c = current && app.project.characters[current];
            if (!c) {
                box.innerHTML = emptyState('选择左侧角色查看与编辑档案', '', { ico: 'characters' });
                return;
            }
            const cfg = c.entryConfig || {};
            const chunkTitle = (i) => app.project.chunks[i]?.title || `#${i + 1}`;
            box.innerHTML = `
                <div class="nl-card-head">
                    <div>
                        <h3>${esc(c.name)}</h3>
                        <div class="nl-card-desc">首次出场：${esc(chunkTitle(c.firstChunk))} · 最近：${esc(chunkTitle(c.lastChunk))}</div>
                    </div>
                    <button class="nl-btn nl-sm" data-act="make-card">${icon('cards', { size: 14 })}生成角色卡</button>
                </div>
                <div class="nl-grid3">
                    <div class="nl-field"><label>名称</label><input class="nl-input" data-f="name" value="${esc(c.name)}"></div>
                    <div class="nl-field"><label>别名（逗号分隔）</label><input class="nl-input" data-f="aliases" value="${esc(c.aliases.join('，'))}"></div>
                    <div class="nl-field"><label>重要度</label><select class="nl-input" data-f="importance">${optionList([{ value: 'main', label: '主要' }, { value: 'support', label: '重要' }, { value: 'minor', label: '次要' }], c.importance)}</select></div>
                    <div class="nl-field"><label>性别</label><input class="nl-input" data-f="gender" value="${esc(c.gender)}"></div>
                    <div class="nl-field"><label>年龄</label><input class="nl-input" data-f="age" value="${esc(c.age)}"></div>
                    <div class="nl-field"><label><input type="checkbox" data-f="locked" ${c.locked ? 'checked' : ''}> 锁定（后续提取不覆盖字段）</label></div>
                </div>
                <div class="nl-field"><label>身份</label><textarea class="nl-input nl-textarea" rows="2" data-f="identity">${esc(c.identity)}</textarea></div>
                <div class="nl-field"><label>性格</label><textarea class="nl-input nl-textarea" rows="2" data-f="personality">${esc(c.personality)}</textarea></div>
                <div class="nl-field"><label>关系</label><textarea class="nl-input nl-textarea" rows="2" data-f="relationship">${esc(c.relationship)}</textarea></div>
                <div class="nl-grid2">
                    <div class="nl-field"><label>外貌特征（每行一条）</label><textarea class="nl-input nl-textarea" rows="4" data-f="appearance">${esc(c.appearance.join('\n'))}</textarea></div>
                    <div class="nl-field"><label>能力（每行一条）</label><textarea class="nl-input nl-textarea" rows="4" data-f="abilities">${esc(c.abilities.join('\n'))}</textarea></div>
                </div>
                <details open><summary>人格颗粒度（决定扮演稳不稳）</summary>
                    <div class="nl-grid3">
                        <div class="nl-field"><label>绝对不会做的事（每行一条）</label><textarea class="nl-input nl-textarea" rows="3" data-f="hardLimits">${esc((c.hardLimits || []).join('\n'))}</textarea></div>
                        <div class="nl-field"><label>忌讳话题（每行一条）</label><textarea class="nl-input nl-textarea" rows="3" data-f="tabooTopics">${esc((c.tabooTopics || []).join('\n'))}</textarea></div>
                        <div class="nl-field"><label>口癖/说话习惯（每行一条）</label><textarea class="nl-input nl-textarea" rows="3" data-f="verbalTics">${esc((c.verbalTics || []).join('\n'))}</textarea></div>
                    </div>
                </details>
                <div class="nl-field"><label>经历（每行一条，行首 [段号] 用于时间点筛选）</label><textarea class="nl-input nl-textarea" rows="6" data-f="experiences">${esc(c.experiences.map((x) => `[${x.chunk + 1}] ${x.text}`).join('\n'))}</textarea></div>
                <div class="nl-field"><label>备注（会写入世界书与角色卡资料）</label><textarea class="nl-input nl-textarea" rows="2" data-f="notes">${esc(c.notes)}</textarea></div>
                <details>
                    <summary>NSFW 补充资料（与上面的日常资料分开存放）</summary>
                    <div class="nl-muted nl-small">身体细节、亲密偏好、尺度边界等——单独存放，生成角色卡时可以勾选要不要带上（见下方生成表单）。</div>
                    <div class="nl-field"><label>NSFW 补充资料</label><textarea class="nl-input nl-textarea" rows="4" data-f="nsfwNotes">${esc(c.nsfwNotes || '')}</textarea></div>
                    <div class="nl-row">${rerollBtn('expand-nsfw', '', { label: 'AI 扩写这部分', title: '重新生成 NSFW 补充资料' })}</div>
                </details>
                <div class="nl-field"><label>原文台词（${c.quotes.length}）</label>
                    <div class="nl-quotes">${c.quotes.map((q, i) => `
                        <div class="nl-quote">${verifiedMark(q.verified)}
                            <div class="nl-grow">「${esc(q.text)}」<span class="nl-muted nl-small">${esc(q.context || '')} · #${(q.chunk ?? 0) + 1}</span></div>
                            <button class="nl-icon-btn nl-danger" data-act="del-quote" data-i="${i}" title="删除" aria-label="删除">${icon('trash', { size: 14 })}</button></div>`).join('') || '<span class="nl-muted">无</span>'}
                    </div>
                </div>
                <div class="nl-field"><label>原文对话样本（${(c.dialogues || []).length}，写卡时优先用于 mes_example）</label>
                    <div class="nl-quotes">${(c.dialogues || []).map((d, i) => `
                        <div class="nl-quote">${verifiedMark(d.verified)}
                            <span class="nl-pre nl-small">${esc(d.text)}</span><span class="nl-muted nl-small">#${(d.chunk ?? 0) + 1}</span>
                            <button class="nl-icon-btn nl-danger" data-act="del-dialogue" data-i="${i}" title="删除" aria-label="删除">${icon('trash', { size: 14 })}</button></div>`).join('') || '<span class="nl-muted">无</span>'}
                    </div>
                </div>
                ${c.stages.length ? `<details><summary>变化记录（${c.stages.length}）</summary><div class="nl-small">${c.stages.map((s) => `<div>#${s.chunk + 1} ${['identity', 'personality', 'relationship'].filter((f) => s[f]).map((f) => `<b>${{ identity: '身份', personality: '性格', relationship: '关系' }[f]}</b>：${esc(s[f])}`).join('；')}</div>`).join('')}</div></details>` : ''}
                <details><summary>世界书条目设置</summary>
                    <div class="nl-grid3">
                        <div class="nl-field"><label>激活</label><select class="nl-input" data-cfg="constant">${optionList([{ value: '', label: '跟随分类' }, { value: 'true', label: '常驻' }, { value: 'false', label: '关键词' }], cfg.constant === undefined ? '' : String(cfg.constant))}</select></div>
                        <div class="nl-field"><label>位置</label><select class="nl-input" data-cfg="position">${optionList([{ value: '', label: '跟随分类' }, ...WI_POSITIONS], cfg.position ?? '')}</select></div>
                        <div class="nl-field"><label>深度 / 顺序</label><div class="nl-row"><input class="nl-input" type="number" data-cfg="depth" value="${cfg.depth ?? ''}" placeholder="深度"><input class="nl-input" type="number" data-cfg="order" value="${cfg.order ?? ''}" placeholder="顺序"></div></div>
                        <div class="nl-field"><label><input type="checkbox" data-cfg="disable" ${cfg.disable ? 'checked' : ''}> 不写入世界书</label></div>
                    </div>
                </details>
                <div class="nl-row nl-wrap">
                    <button class="nl-btn nl-primary" data-act="save">保存</button>
                    ${rerollBtn('consolidate', '', { label: 'AI 整理档案', title: '重新整理这个角色的档案' })}
                    ${rerollBtn('expand', '', { label: 'AI 扩写（写得更细致）', title: '重新扩写这个角色的档案' })}
                    <button class="nl-btn" data-act="merge-into">${icon('merge')}合并到其他角色…</button>
                    <span class="nl-spacer"></span>
                    <button class="nl-btn nl-danger" data-act="delete">${icon('trash')}删除</button>
                </div>`;
        };

        const render = () => {
            el.innerHTML = `
            <div class="nl-row nl-wrap">
                <input class="nl-input nl-inline" placeholder="搜索名称/别名/身份" aria-label="搜索角色" data-act-input="search" value="${esc(search)}">
                <select class="nl-input nl-inline" aria-label="重要度筛选" data-act-input="filter">${optionList([{ value: 'all', label: '全部' }, { value: 'main', label: '主要' }, { value: 'support', label: '重要' }, { value: 'minor', label: '次要' }], filter)}</select>
                <select class="nl-input nl-inline" aria-label="排序" data-act-input="sort">${optionList([{ value: 'importance', label: '按重要度' }, { value: 'first', label: '按出场顺序' }, { value: 'name', label: '按名称' }], sort)}</select>
                <span class="nl-muted nl-small nl-char-count"></span>
                <span class="nl-spacer"></span>
                <button class="nl-btn nl-sm" data-act="toggle-select" aria-pressed="${selecting}" title="勾选多个角色，批量合并或删除">${selecting ? '退出多选' : '多选'}</button>
            </div>
            <div class="nl-row nl-wrap nl-char-selbar" role="group" aria-label="对所选角色的批量操作" ${selecting ? '' : 'hidden'}>
                <span class="nl-char-selcount" aria-live="polite"></span>
                <button class="nl-btn nl-sm" data-act="select-all">全选</button>
                <span class="nl-spacer"></span>
                <button class="nl-btn nl-sm" data-act="merge-selected">${icon('merge')}合并到…</button>
                <button class="nl-btn nl-sm nl-danger" data-act="delete-selected">${icon('trash')}<span class="nl-char-dellabel">删除所选（0）</span></button>
                <button class="nl-btn nl-sm" data-act="cancel-select" title="退出多选（Esc）">取消</button>
            </div>
            <div class="nl-split">
                <div class="nl-card nl-char-list"></div>
                <div class="nl-card nl-char-detail"></div>
            </div>`;
            renderList();
            renderDetail();
            // 页面已被切走时（例如 AI 别名检测结束后 render）不再改动标题栏，免得覆盖其他页面的按钮
            if (el.isConnected) setActions?.(`<button class="nl-btn" data-act="add">${icon('plus')}手动新建</button><button class="nl-btn" data-act="alias">${icon('wand')}AI 别名检测</button>`, onClick);
        };

        const readForm = () => {
            const c = app.project.characters[current];
            const box = qs(el, '.nl-char-detail');
            const v = (f) => box.querySelector(`[data-f="${f}"]`);
            const newName = v('name').value.trim();
            c.aliases = uniq(v('aliases').value.split(/[，,、\n]/)).filter((a) => a !== c.name);
            c.importance = v('importance').value;
            c.gender = v('gender').value.trim();
            c.age = v('age').value.trim();
            // 手动删掉的别名，出处记录也一起清掉
            if (c.aliasSources) for (const a of Object.keys(c.aliasSources)) if (!c.aliases.includes(a)) delete c.aliasSources[a];
            c.locked = v('locked').checked;
            c.identity = v('identity').value.trim();
            c.personality = v('personality').value.trim();
            c.relationship = v('relationship').value.trim();
            c.appearance = uniq(v('appearance').value.split('\n'));
            c.abilities = uniq(v('abilities').value.split('\n'));
            c.hardLimits = uniq(v('hardLimits').value.split('\n'));
            c.tabooTopics = uniq(v('tabooTopics').value.split('\n'));
            c.verbalTics = uniq(v('verbalTics').value.split('\n'));
            c.notes = v('notes').value.trim();
            c.nsfwNotes = v('nsfwNotes').value.trim();
            c.experiences = v('experiences').value.split('\n').map((line) => {
                const m = line.match(/^\s*\[(\d+)\]\s*(.*)$/);
                return m ? { chunk: Number(m[1]) - 1, text: m[2].trim() } : { chunk: c.lastChunk, text: line.trim() };
            }).filter((x) => x.text);
            const cfg = {};
            for (const inp of box.querySelectorAll('[data-cfg]')) {
                const k = inp.dataset.cfg;
                if (inp.type === 'checkbox') {
                    if (inp.checked) cfg[k] = true;
                } else if (inp.value !== '') {
                    cfg[k] = k === 'constant' ? inp.value === 'true' : Number(inp.value);
                }
            }
            c.entryConfig = cfg;
            c.updatedAt = Date.now();
            if (newName && newName !== c.name) {
                renameCharacter(app.project, c.name, newName);
                current = newName;
            }
        };

        const onClick = async (e) => {
            const item = e.target.closest('.nl-char-item');
            if (item && selecting) return toggleRow(item, e);
            if (item) {
                current = item.dataset.name;
                renderList();
                renderDetail();
                if (window.innerWidth < 800) qs(el, '.nl-char-detail').scrollIntoView({ behavior: 'smooth' });
                return;
            }
            const go = e.target.closest('[data-goto]');
            if (go) return switchTab(go.dataset.goto);
            const btn = e.target.closest('[data-act]');
            if (!btn) return;
            const p = app.project;
            switch (btn.dataset.act) {
                case 'save':
                    try {
                        readForm();
                        await app.saveNow();
                        app.log(`💾 已保存角色「${current}」`, 'success');
                        renderList();
                        renderDetail();
                    } catch (err) {
                        app.log(err.message, 'error');
                    }
                    break;
                case 'consolidate':
                    readForm();
                    await createSnapshot(p, `整理角色「${current}」前`);
                    await busy(btn, async () => {
                        await consolidateCharacter(p, app.settings, current);
                        await app.saveNow();
                        app.log(`✨ 已整理角色「${current}」`, 'success');
                    }, 'AI 整理中…');
                    renderDetail();
                    break;
                case 'expand':
                case 'expand-nsfw': {
                    readForm();
                    const nsfw = btn.dataset.act === 'expand-nsfw';
                    await createSnapshot(p, `AI 扩写角色「${current}」前`);
                    await busy(btn, async () => {
                        await expandCharacter(p, app.settings, current, { nsfw });
                        await app.saveNow();
                        app.log(`✨ 已为角色「${current}」扩写${nsfw ? '（含 NSFW 补充资料）' : ''}`, 'success');
                    }, 'AI 扩写中…');
                    renderDetail();
                    break;
                }
                case 'merge-into': {
                    const others = Object.keys(p.characters).filter((n) => n !== current);
                    const { value, root } = await openDialog({
                        title: `把「${current}」合并到…`,
                        body: `<div class="nl-field"><select class="nl-input" aria-label="目标角色">${optionList(others)}</select><div class="nl-muted nl-small">「${esc(current)}」会成为目标角色的别名，经历与台词合并。</div></div>`,
                        buttons: [{ label: '取消', value: null }, { label: '合并', value: 'ok', primary: true }],
                    });
                    if (value !== 'ok') return;
                    const target = root.querySelector('select').value;
                    await createSnapshot(p, `合并角色「${current}」前`);
                    mergeCharactersInto(p, target, [current]);
                    current = target;
                    await app.saveNow();
                    render();
                    break;
                }
                case 'delete': {
                    if (!(await confirmDialog(`删除角色「${current}」？`, { danger: true, okLabel: '删除' }))) return;
                    await createSnapshot(p, `删除角色「${current}」前`);
                    delete p.characters[current];
                    pruneRelationships(p);
                    pruneGroupCards(p);
                    prunePov(p);
                    current = null;
                    await app.saveNow();
                    render();
                    break;
                }
                case 'del-quote': {
                    const c = p.characters[current];
                    c.quotes.splice(Number(btn.dataset.i), 1);
                    await app.saveNow();
                    renderDetail();
                    break;
                }
                case 'del-dialogue': {
                    const c = p.characters[current];
                    (c.dialogues || []).splice(Number(btn.dataset.i), 1);
                    await app.saveNow();
                    renderDetail();
                    break;
                }
                case 'add': {
                    const name = await promptDialog('角色名', '', { title: '新建角色' });
                    if (!name?.trim()) return;
                    if (p.characters[name.trim()]) return app.log('已存在同名角色', 'warn');
                    const c = normalizeCharacter({ name: name.trim(), importance: 'support', locked: true, manual: true });
                    c.firstChunk = 0;
                    c.lastChunk = 0;
                    c.chunksSeen = [0];
                    p.characters[c.name] = c;
                    current = c.name;
                    await app.saveNow();
                    render();
                    break;
                }
                case 'alias':
                    if (await aliasMergeFlow('角色', btn)) render();
                    break;
                case 'make-card':
                    app.pendingCardChar = current;
                    switchTab('cards');
                    break;
                case 'toggle-select':
                    setSelecting(!selecting);
                    break;
                case 'cancel-select':
                    setSelecting(false);
                    break;
                case 'select-all':
                    for (const c of list()) selected.add(c.name);
                    syncChecks();
                    break;
                case 'select-none':
                    for (const c of list()) selected.delete(c.name);
                    syncChecks();
                    break;
                case 'merge-selected': {
                    const names = selectedNames();
                    if (names.length < 2) return app.log('至少选择 2 个角色才能合并', 'warn');
                    if (app.isBusy()) return app.log('有任务正在运行，请等它结束后再合并', 'warn');
                    const chars = names.map((n) => p.characters[n]);
                    const keep = [...chars].sort(byImportance)[0].name;
                    const { value, root } = await openDialog({
                        title: `合并 ${names.length} 个角色`,
                        body: `<div class="nl-field"><label>保留哪个角色（其余的并入它）</label>
                            <select class="nl-input" aria-label="保留的角色">${optionList(chars.map((c) => ({ value: c.name, label: `${c.name}（${importanceLabel(c.importance)} · 出场 ${c.chunksSeen.length} 段）` })), keep)}</select></div>
                            <div class="nl-muted nl-small">要合并的角色：${esc(nameList(names))}</div>
                            <div class="nl-muted nl-small">其余角色的名字会变成保留角色的别名，经历、台词、外貌等资料并入它；关系图谱、群聊场景卡、多视角和角色卡里对它们的引用改为指向保留的角色。合并前会自动创建快照，可以在「世界书 → 修改历史」中恢复。</div>`,
                        buttons: [{ label: '取消', value: null }, { label: '合并', value: 'ok', primary: true }],
                    });
                    if (value !== 'ok') return;
                    const target = root.querySelector('select').value;
                    await createSnapshot(p, `合并 ${names.length} 个角色到「${target}」前`);
                    try {
                        mergeCharactersInto(p, target, names.filter((n) => n !== target));
                    } catch (err) {
                        return app.log(`合并失败：${err.message}`, 'error');
                    }
                    current = target;
                    selecting = false;
                    selected.clear();
                    anchor = null;
                    await app.saveNow();
                    app.log(`🔗 已把 ${names.length - 1} 个角色合并到「${target}」`, 'success');
                    render();
                    break;
                }
                case 'delete-selected': {
                    const names = selectedNames();
                    if (!names.length) return;
                    if (app.isBusy()) return app.log('有任务正在运行，请等它结束后再删除', 'warn');
                    const n = names.length;
                    const gone = new Set(names);
                    const locked = names.filter((x) => p.characters[x].locked).length;
                    const rels = (p.relationships || []).filter((r) => gone.has(r.from) || gone.has(r.to)).length;
                    const groups = (p.groupCards || []).filter((g) => g.members.some((m) => gone.has(m)));
                    const groupsDropped = groups.filter((g) => g.members.filter((m) => !gone.has(m) && p.characters[m]).length < 2).length;
                    const povRefs = Object.keys(p.povStyles || {}).filter((k) => gone.has(k)).length + (p.plan?.chapters || []).filter((c) => gone.has(c.pov)).length;
                    const cleanup = [
                        rels ? `· 关系图谱中与它们相连的 ${rels} 条关系` : '',
                        groups.length ? `· ${groups.length} 张群聊场景卡里的这些成员${groupsDropped ? `（其中 ${groupsDropped} 张会只剩不到 2 人，整张删除）` : ''}` : '',
                        povRefs ? `· 多视角（POV）设置里对它们的 ${povRefs} 处引用` : '',
                    ].filter(Boolean);
                    const msg = `将删除这 ${n} 个角色：\n${nameList(names)}`
                        + (locked ? `\n其中 ${locked} 个已锁定，也会一起删除。` : '')
                        + (cleanup.length ? `\n\n同时清理：\n${cleanup.join('\n')}` : '\n\n关系图谱、群聊场景卡和多视角（POV）设置里没有引用它们的内容。')
                        + '\n已生成的角色卡不会删除。'
                        + '\n\n删除前会自动创建快照，可以在「世界书 → 修改历史」中恢复。';
                    if (!(await confirmDialog(msg, { title: `删除 ${n} 个角色`, okLabel: `删除 ${n} 个角色`, danger: true }))) return;
                    await createSnapshot(p, `批量删除 ${n} 个角色前`);
                    for (const x of names) delete p.characters[x];
                    pruneRelationships(p);
                    pruneGroupCards(p);
                    prunePov(p);
                    if (current && !p.characters[current]) current = null;
                    selecting = false;
                    selected.clear();
                    anchor = null;
                    await app.saveNow();
                    app.log(`🗑️ 已删除 ${n} 个角色（删除前已创建快照）`, 'success');
                    render();
                    break;
                }
                default:
                    break;
            }
        };

        // 键盘：行上 Enter/空格 = 点击；↑↓ 在行（多选时为复选框）之间移动
        const onKeydown = (e) => {
            const item = e.target.closest?.('.nl-char-item');
            if (!item) return;
            if ((e.key === 'Enter' || e.key === ' ') && e.target === item) {
                e.preventDefault();
                item.click();
                return;
            }
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                const all = rows();
                const next = all[all.indexOf(item) + (e.key === 'ArrowDown' ? 1 : -1)];
                if (!next) return;
                e.preventDefault();
                (selecting ? next.querySelector('.nl-chk') : next)?.focus();
            }
        };

        // 主窗口在 document 的捕获阶段把 Esc 当作“最小化”。多选时在更早的 window 捕获阶段先接住，只退出多选；
        // 有对话框打开、窗口已最小化或本页已被切走时不拦截
        const onEsc = (e) => {
            if (e.key !== 'Escape' || !selecting || !el.isConnected || el.closest('.nl-hidden') || document.querySelector('.nl-dialog-overlay')) return;
            e.stopPropagation();
            setSelecting(false);
        };

        const onInput = (e) => {
            const k = e.target.dataset.actInput;
            if (!k) return;
            if (k === 'search') search = e.target.value;
            if (k === 'filter') filter = e.target.value;
            if (k === 'sort') sort = e.target.value;
            renderList();
        };

        el.addEventListener('click', onClick);
        el.addEventListener('input', onInput);
        el.addEventListener('change', onInput);
        el.addEventListener('keydown', onKeydown);
        window.addEventListener('keydown', onEsc, true);
        render();
        return { destroy: () => window.removeEventListener('keydown', onEsc, true) };
    },
};
