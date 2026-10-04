// 角色页：角色档案列表与编辑、AI 整理、别名合并

import { app } from '../app.js';
import { WI_POSITIONS } from '../constants.js';
import { IMPORTANCE_RANK, mergeCharactersInto, mergeEntriesInto, normalizeCharacter, pruneGroupCards, prunePov, pruneRelationships, renameCharacter } from '../project.js';
import { createSnapshot } from '../store.js';
import { consolidateCharacter, detectAliases, expandCharacter } from '../tools.js';
import { truncate, uniq } from '../utils.js';
import { busy, confirmDialog, emptyState, esc, icon, importanceLabel, openDialog, optionList, promptDialog, qs, rerollBtn } from './common.js';

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

        const list = () => {
            const chars = Object.values(app.project.characters);
            const s = search.trim();
            return chars
                .filter((c) => filter === 'all' || c.importance === filter)
                .filter((c) => !s || c.name.includes(s) || c.aliases.some((a) => a.includes(s)) || c.identity.includes(s))
                .sort((a, b) => {
                    if (sort === 'first') return a.firstChunk - b.firstChunk;
                    if (sort === 'name') return a.name.localeCompare(b.name, 'zh');
                    return (IMPORTANCE_RANK[b.importance] - IMPORTANCE_RANK[a.importance]) || (b.chunksSeen.length - a.chunksSeen.length);
                });
        };

        const renderList = () => {
            const box = qs(el, '.nl-char-list');
            const items = list();
            box.innerHTML = items.map((c) => `
                <div class="nl-char-item ${current === c.name ? 'active' : ''}" data-name="${esc(c.name)}">
                    <div><b>${esc(c.name)}</b> <span class="nl-tag nl-imp-${c.importance}">${importanceLabel(c.importance)}</span>${c.locked ? ` <span class="nl-muted" title="已锁定">${icon('lock', { size: 13, label: '已锁定' })}</span>` : ''}</div>
                    <div class="nl-muted nl-small">${esc(truncate(c.identity || '（无身份）', 40))} · 出场 ${c.chunksSeen.length} 段</div>
                </div>`).join('') || (Object.keys(app.project.characters).length
                ? emptyState('没有符合筛选条件的角色。', '', { ico: 'search' })
                : emptyState('先去「提取」页提取资料。', '<button class="nl-btn nl-sm" data-goto="extract">去提取</button>', { title: '没有角色', ico: 'characters' }));
            qs(el, '.nl-char-count').textContent = `${items.length} / ${Object.keys(app.project.characters).length}`;
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
                    const c = normalizeCharacter({ name: name.trim(), importance: 'support', locked: true });
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
                default:
                    break;
            }
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
        render();
        return {};
    },
};
