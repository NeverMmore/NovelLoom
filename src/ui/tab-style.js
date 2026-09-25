// 文风页：各任务使用哪种文风、编辑本书原著文风与预设、范文片段、禁用词、AI 提炼

import { app } from '../app.js';
import {
    COMMON_AI_BANNED, NO_STYLE_ID, PROJECT_STYLE_ID, STYLE_FIELDS, STYLE_TASKS,
    analyzeStyle, exportStyleJson, fixStyleUse, getStyleById, headingBefore, listStyleChoices, listStylePresets, makeSample,
    parseBanned, parseStyleJson, pickSamples, removeStylePreset, resolveStyleId, saveStylePreset, styleOptions, styleTextFor,
} from '../style.js';
import { downloadFile, estimateTokens, formatNumber, pickFile, readFileAsText, safeFileName, truncate, uniq } from '../utils.js';
import { busy, confirmDialog, esc, openDialog, optionList, promptDialog, qs } from './common.js';

const FIX_MODES = [
    { value: 'none', label: '只提示，不修改' },
    { value: 'replace', label: '按“词=>建议”自动替换' },
    { value: 'ai', label: 'AI 改写命中的句子（额外消耗 token）' },
];

export const styleTab = {
    mount(el) {
        // 导入的项目可能引用了本机没有的预设：改回默认
        fixStyleUse(app.project, app.settings);
        let editId = resolveStyleId(app.project, 'default');
        if (editId === NO_STYLE_ID) editId = PROJECT_STYLE_ID;

        const opts = () => {
            app.settings.styleOptions = styleOptions(app.settings);
            return app.settings.styleOptions;
        };
        const target = () => getStyleById(app.project, app.settings, editId);
        const isProject = () => editId === PROJECT_STYLE_ID;

        /** 修改当前编辑的文风（本书原著文风写进项目，预设写进设置） */
        const patch = (obj) => {
            if (isProject()) {
                Object.assign(app.project.style, obj);
                app.saveSoon();
            } else {
                const cur = target();
                const wasModified = cur.modified;
                saveStylePreset(app.settings, { ...cur, ...obj });
                app.saveSettings();
                if (cur.builtin && !wasModified) qs(el, '[data-modified]')?.removeAttribute('hidden');
            }
        };

        const taskSelect = (key) => {
            const p = app.project;
            const choices = listStyleChoices(p, app.settings);
            const items = key === 'default'
                ? choices.map((c) => ({ value: c.id, label: c.name }))
                : [{ value: '', label: '跟随默认' }, ...choices.map((c) => ({ value: c.id, label: c.name }))];
            return `<select class="nl-input" data-use="${key}">${optionList(items, p.styleUse[key] || '')}</select>`;
        };

        const sampleHtml = (prof) => (prof.samples.length
            ? prof.samples.map((s, i) => `
                <div class="nl-sample">
                    <div class="nl-row nl-wrap">
                        <b class="nl-small">范文 ${i + 1}</b>
                        <span class="nl-muted nl-small">${esc(s.source || '手动添加')} · ${formatNumber(s.text.length)} 字</span>
                        <span class="nl-spacer"></span>
                        <button class="nl-btn nl-sm" data-act="sample-edit" data-i="${i}">编辑</button>
                        <button class="nl-btn nl-sm" data-act="sample-up" data-i="${i}" ${i ? '' : 'disabled'}>↑</button>
                        <button class="nl-btn nl-sm nl-danger" data-act="sample-del" data-i="${i}">删除</button>
                    </div>
                    <div class="nl-small nl-sample-text">${esc(truncate(s.text, 240))}</div>
                </div>`).join('')
            : '<div class="nl-muted nl-small">还没有范文。范文会原样放进续写/角色卡提示词，让 AI 模仿句式、节奏和对话写法（不会照搬内容）。</div>');

        const render = () => {
            const p = app.project;
            const o = opts();
            const prof = target();
            const presets = listStylePresets(app.settings);
            const used = STYLE_TASKS.map((t) => ({ ...t, id: resolveStyleId(p, t.key) }));
            const nameOf = (id) => listStyleChoices(p, app.settings).find((c) => c.id === id)?.name || id;
            const sampleChars = prof.samples.reduce((n, s) => n + s.text.length, 0);
            const bannedCount = parseBanned(prof.banned).length;
            el.innerHTML = `
            <section class="nl-card">
                <h3>各任务使用的文风</h3>
                <div class="nl-muted nl-small">“本书原著文风”保存在当前项目里（提取时自动填写，可手动修改）；预设保存在插件设置里，所有项目通用。某个任务选“跟随默认”时使用默认文风。</div>
                <div class="nl-grid2">
                    <div class="nl-field"><label>默认</label>${taskSelect('default')}</div>
                    ${STYLE_TASKS.map((t) => `<div class="nl-field"><label>${esc(t.label)} <span class="nl-muted nl-small">${esc(t.hint)}</span></label>${taskSelect(t.key)}</div>`).join('')}
                </div>
                <div class="nl-row nl-wrap">
                    <span class="nl-muted nl-small">当前：${used.map((u) => `${esc(u.label)} → <b>${esc(nameOf(u.id))}</b>`).join('　')}</span>
                    <span class="nl-spacer"></span>
                    <button class="nl-btn nl-sm" data-act="preview">预览各任务的文风提示</button>
                </div>
            </section>

            <section class="nl-card">
                <details ${Object.keys(p.povStyles || {}).length ? 'open' : ''}>
                    <summary><b>多视角管理</b>（按角色单独指定文风）</summary>
                    <div class="nl-muted nl-small">给需要独立叙事风格的角色映射一个文风；在「写大纲」页把某一章标记为该角色的视角后，续写这一章会优先使用这里映射的文风；没标记视角、或角色没有映射时，仍用「续写」任务的默认文风。</div>
                    ${Object.keys(p.characters).length ? `
                    <div class="nl-pov-list">
                        ${Object.keys(p.characters).sort().map((name) => `
                        <div class="nl-row nl-wrap">
                            <span class="nl-small" style="min-width:110px">${esc(name)}</span>
                            <select class="nl-input nl-inline" data-pov-char="${esc(name)}">${optionList([{ value: '', label: '不映射（跟随默认）' }, ...listStyleChoices(p, app.settings).map((c) => ({ value: c.id, label: c.name }))], p.povStyles?.[name] || '')}</select>
                        </div>`).join('')}
                    </div>` : '<div class="nl-muted nl-small">还没有角色档案。</div>'}
                </details>
            </section>

            <section class="nl-card">
                <div class="nl-row nl-wrap">
                    <h3>编辑文风</h3>
                    <select class="nl-input nl-inline" data-edit-id>
                        ${optionList([
                            { value: PROJECT_STYLE_ID, label: '本书原著文风（当前项目）' },
                            ...presets.map((x) => ({ value: x.id, label: `${x.name}${x.builtin ? '（内置）' : ''}` })),
                        ], editId)}
                    </select>
                    <span class="nl-tag nl-warn" data-modified ${prof.modified ? '' : 'hidden'}>已修改</span>
                    <span class="nl-spacer"></span>
                    <button class="nl-btn nl-sm" data-act="new">新建预设</button>
                    <button class="nl-btn nl-sm" data-act="copy">另存为新预设</button>
                    ${!isProject() && !prof.builtin ? '<button class="nl-btn nl-sm" data-act="rename">重命名</button><button class="nl-btn nl-sm nl-danger" data-act="delete">删除</button>' : ''}
                    ${prof.builtin ? '<button class="nl-btn nl-sm" data-act="reset">恢复默认</button>' : ''}
                    ${!isProject() ? '<button class="nl-btn nl-sm" data-act="to-project" title="把这个预设的内容复制到本书原著文风">复制到本书文风</button>' : ''}
                </div>
                <div class="nl-row nl-wrap">
                    <button class="nl-btn nl-sm nl-primary nl-reroll" data-act="analyze" title="从原文挑选片段，让 AI 总结视角、语言、基调和写法规则">🎲 AI 从原文提炼</button>
                    <button class="nl-btn nl-sm" data-act="import">导入 JSON</button>
                    <button class="nl-btn nl-sm" data-act="export">导出 JSON</button>
                    <button class="nl-btn nl-sm" data-act="export-all">导出全部预设</button>
                </div>
                <div class="nl-grid3">
                    ${STYLE_FIELDS.map((f) => `<div class="nl-field"><label>${esc(f.label)}</label><input class="nl-input" data-sf="${f.key}" value="${esc(prof[f.key])}" placeholder="${esc(f.placeholder)}"></div>`).join('')}
                </div>
                <div class="nl-grid2">
                    <div class="nl-field"><label>写法规则（每行一条，越具体越好）</label>
                        <textarea class="nl-input nl-textarea" rows="6" data-sf="rules" placeholder="- 对话不加“他说道”，靠换行区分说话人&#10;- 心理活动一句带过，随即接动作&#10;- 章末留一个悬念">${esc(prof.rules)}</textarea></div>
                    <div class="nl-field"><label>备注（其他要求，会原样写进提示词）</label>
                        <textarea class="nl-input nl-textarea" rows="6" data-sf="notes" placeholder="例如：主角的吐槽用括号括起来；称呼莉莉丝为“魔女小姐”">${esc(prof.notes)}</textarea></div>
                </div>
            </section>

            <section class="nl-card">
                <div class="nl-row nl-wrap">
                    <h3>范文片段（${prof.samples.length} 段，${formatNumber(sampleChars)} 字）</h3>
                    <span class="nl-spacer"></span>
                    <button class="nl-btn nl-sm" data-act="sample-paste">粘贴范文</button>
                    <button class="nl-btn nl-sm" data-act="sample-pick">从原文选取</button>
                    <button class="nl-btn nl-sm" data-act="sample-auto">自动挑选</button>
                    ${prof.samples.length ? '<button class="nl-btn nl-sm nl-danger" data-act="sample-clear">清空</button>' : ''}
                </div>
                <div class="nl-muted nl-small">注入提示词时最多使用 ${formatNumber(Number(o.sampleMaxChars) || 0)} 字（下方“全局选项”可调），超出部分按顺序截掉。</div>
                <div class="nl-sample-list">${sampleHtml(prof)}</div>
            </section>

            <section class="nl-card">
                <div class="nl-row nl-wrap">
                    <h3>禁用词（<span data-banned-count>${bannedCount}</span>）</h3>
                    <span class="nl-spacer"></span>
                    <button class="nl-btn nl-sm" data-act="banned-common">导入常见 AI 腔</button>
                    <button class="nl-btn nl-sm" data-act="banned-count" title="统计每个禁用词在原文里出现的次数；原文常用的词不适合禁用">在原文中统计</button>
                </div>
                <div class="nl-muted nl-small">每行一个，也可以用逗号、顿号分隔多个；<code>词=>建议</code> 给出替换建议；<code>/正则/</code> 匹配句式；<code>#</code> 开头为注释。禁用词会写进提示词让 AI 提前避开，续写完成后自动扫描，角色卡审稿也会检查。</div>
                <textarea class="nl-input nl-textarea" rows="7" data-sf="banned" placeholder="仿佛, 宛如&#10;嘴角上扬=>笑了&#10;/一丝[^，。]{0,4}笑意/">${esc(prof.banned)}</textarea>
            </section>

            <section class="nl-card">
                <details ${o.globalBanned ? 'open' : ''}>
                    <summary><b>全局选项</b>（对所有文风生效）</summary>
                    <div class="nl-field"><label>全局禁用词（叠加在每种文风自己的禁用词之上）</label>
                        <textarea class="nl-input nl-textarea" rows="4" data-opt="globalBanned" placeholder="每行一个">${esc(o.globalBanned)}</textarea></div>
                    <div class="nl-grid3">
                        <div class="nl-field"><label>范文注入字数上限</label><input class="nl-input" type="number" min="0" step="100" data-opt="sampleMaxChars" value="${esc(o.sampleMaxChars)}"></div>
                        <div class="nl-field"><label>续写命中禁用词时</label><select class="nl-input" data-opt="fixMode">${optionList(FIX_MODES, o.fixMode)}</select></div>
                    </div>
                    <div class="nl-row nl-wrap nl-checks">
                        <label><input type="checkbox" data-opt="samplesInCard" ${o.samplesInCard ? 'checked' : ''}> 写角色卡时附带范文</label>
                        <label><input type="checkbox" data-opt="samplesInPlan" ${o.samplesInPlan ? 'checked' : ''}> 写大纲时附带范文</label>
                        <label><input type="checkbox" data-opt="bannedInPrompt" ${o.bannedInPrompt ? 'checked' : ''}> 把禁用词写进提示词</label>
                        <label><input type="checkbox" data-opt="checkContinuation" ${o.checkContinuation ? 'checked' : ''}> 续写完成后扫描禁用词</label>
                    </div>
                </details>
            </section>`;
        };

        // ---------- 范文 ----------
        const setSamples = (samples) => patch({ samples });

        const pickFromSource = async () => {
            const p = app.project;
            const chunks = p.chunks.filter((c) => c.content);
            if (!chunks.length) return app.log('项目里没有原文', 'warn');
            let added = 0;
            await openDialog({
                title: '从原文选取范文',
                wide: true,
                body: `
                    <div class="nl-row nl-wrap">
                        <select class="nl-input nl-grow" data-pick-chunk>${optionList(chunks.map((c) => ({ value: c.id, label: `${c.index + 1}. ${c.title}${c.origin === 'generated' ? '（续写）' : ''}` })), chunks[0].id)}</select>
                        <button class="nl-btn nl-primary" data-pick-add>添加选中部分</button>
                    </div>
                    <div class="nl-muted nl-small">在下方用鼠标选中一段（建议 300-800 字，对话与叙述都有），再点“添加选中部分”。<b data-pick-count></b></div>
                    <div class="nl-small nl-ok" data-pick-info></div>
                    <textarea class="nl-input nl-textarea nl-tall" readonly data-pick-text></textarea>`,
                buttons: [{ label: '完成', value: null, primary: true }],
                onMount: (b) => {
                    const sel = b.querySelector('[data-pick-chunk]');
                    const ta = b.querySelector('[data-pick-text]');
                    const info = b.querySelector('[data-pick-info]');
                    const count = b.querySelector('[data-pick-count]');
                    const load = () => {
                        ta.value = p.chunks.find((c) => c.id === sel.value)?.content || '';
                        ta.scrollTop = 0;
                        count.textContent = '';
                    };
                    sel.addEventListener('change', load);
                    ta.addEventListener('select', () => {
                        const n = ta.selectionEnd - ta.selectionStart;
                        count.textContent = n > 0 ? `已选中 ${n} 字` : '';
                    });
                    b.querySelector('[data-pick-add]').addEventListener('click', () => {
                        const text = ta.value.slice(ta.selectionStart, ta.selectionEnd).trim();
                        if (text.length < 20) {
                            info.textContent = '先在下方选中一段文字（至少 20 字）';
                            return;
                        }
                        const chunk = p.chunks.find((c) => c.id === sel.value);
                        const prof = target();
                        setSamples([...prof.samples, makeSample(truncate(text, 3000), `原文·${headingBefore(ta.value, ta.selectionStart) || chunk?.title || ''}`)]);
                        added++;
                        info.textContent = `✔ 已添加（${text.length} 字）。本次共添加 ${added} 段，可继续选取。`;
                    });
                    load();
                },
            });
            if (added) render();
        };

        const onClick = async (e) => {
            const btn = e.target.closest('[data-act]');
            if (!btn) return;
            e.preventDefault();
            const p = app.project;
            const prof = target();
            const i = Number(btn.dataset.i);
            switch (btn.dataset.act) {
                case 'preview': {
                    const body = STYLE_TASKS.map((t) => {
                        const text = styleTextFor(p, app.settings, t.key);
                        return `<h4>${esc(t.label)}（约 ${estimateTokens(text)} tokens）</h4><div class="nl-pre nl-small">${esc(text)}</div>`;
                    }).join('');
                    await openDialog({ title: '各任务提示词中的「文风」一节', wide: true, body });
                    return;
                }
                case 'new':
                case 'copy': {
                    const name = await promptDialog('预设名称', btn.dataset.act === 'copy' ? `${prof.name}（副本）` : '我的文风', { title: btn.dataset.act === 'copy' ? '另存为新预设' : '新建文风预设' });
                    if (!name?.trim()) return;
                    const base = btn.dataset.act === 'copy'
                        ? { ...prof, samples: prof.samples.map((s) => makeSample(s.text, s.source)) }
                        : {};
                    const created = saveStylePreset(app.settings, { ...base, id: '', builtin: false, name: name.trim() });
                    app.saveSettings();
                    editId = created.id;
                    app.log(`🎨 已创建文风预设「${created.name}」`, 'success');
                    return render();
                }
                case 'rename': {
                    const name = await promptDialog('新名称', prof.name, { title: '重命名预设' });
                    if (!name?.trim()) return;
                    patch({ name: name.trim() });
                    return render();
                }
                case 'delete': {
                    if (!(await confirmDialog(`删除文风预设「${prof.name}」？使用它的任务会改回默认。`, { danger: true, okLabel: '删除' }))) return;
                    removeStylePreset(app.settings, editId);
                    fixStyleUse(p, app.settings);
                    app.saveSettings();
                    await app.saveNow();
                    editId = PROJECT_STYLE_ID;
                    return render();
                }
                case 'reset': {
                    if (!prof.modified) return app.log('这个内置预设没有修改过');
                    if (!(await confirmDialog(`把内置预设「${prof.name}」恢复为默认内容？你对它的修改会丢失。`, { danger: true, okLabel: '恢复默认' }))) return;
                    removeStylePreset(app.settings, editId);
                    app.saveSettings();
                    return render();
                }
                case 'to-project': {
                    if (!(await confirmDialog(`用「${prof.name}」的内容覆盖本书原著文风（视角、语言、基调、规则、备注、范文、禁用词）？`))) return;
                    const { perspective, tone, mood, rules, notes, banned } = prof;
                    Object.assign(p.style, { perspective, tone, mood, rules, notes, banned, samples: prof.samples.map((s) => makeSample(s.text, s.source)) });
                    await app.saveNow();
                    editId = PROJECT_STYLE_ID;
                    app.log('已复制到本书原著文风', 'success');
                    return render();
                }
                case 'analyze': {
                    if (!p.chunks.some((c) => c.content)) return app.log('项目里没有原文', 'warn');
                    const r = await busy(btn, () => analyzeStyle(p, app.settings, { current: prof }), 'AI 分析中…');
                    if (!r) return;
                    const { value, root } = await openDialog({
                        title: 'AI 提炼的文风',
                        wide: true,
                        body: `
                            <div class="nl-muted nl-small">可以先修改再应用。应用后会覆盖「${esc(prof.name)}」的视角、语言、基调和写法规则；建议禁用词会追加到禁用词列表。</div>
                            ${STYLE_FIELDS.map((f) => `<div class="nl-field"><label>${esc(f.label)}</label><input class="nl-input" data-r="${f.key}" value="${esc(r[f.key])}"></div>`).join('')}
                            <div class="nl-field"><label>写法规则</label><textarea class="nl-input nl-textarea" rows="7" data-r="rules">${esc(r.rules)}</textarea></div>
                            <div class="nl-field"><label>建议禁用词</label><textarea class="nl-input nl-textarea" rows="3" data-r="banned">${esc(r.banned)}</textarea></div>`,
                        buttons: [{ label: '取消', value: null }, { label: '应用', value: 'ok', primary: true }],
                    });
                    if (value !== 'ok') return;
                    const g = (k) => root.querySelector(`[data-r="${k}"]`).value.trim();
                    const bannedLines = uniq([...String(prof.banned || '').split(/\r?\n/), ...g('banned').split(/\r?\n/)].map((x) => x.trim()).filter(Boolean));
                    patch({ perspective: g('perspective'), tone: g('tone'), mood: g('mood'), rules: g('rules'), banned: bannedLines.join('\n') });
                    if (isProject()) await app.saveNow();
                    app.log('🎨 已应用 AI 提炼的文风', 'success');
                    return render();
                }
                case 'import': {
                    const file = await pickFile('.json,application/json');
                    if (!file) return;
                    try {
                        const list = parseStyleJson(JSON.parse(await readFileAsText(file)));
                        if (!list.length) throw new Error('文件里没有文风数据');
                        let last = null;
                        for (const x of list) last = saveStylePreset(app.settings, { ...x, id: '', builtin: false });
                        app.saveSettings();
                        editId = last.id;
                        app.log(`📥 已导入 ${list.length} 个文风预设`, 'success');
                        render();
                    } catch (err) {
                        app.log(`导入失败：${err.message}`, 'error');
                    }
                    return;
                }
                case 'export':
                    return downloadFile(JSON.stringify(exportStyleJson(prof), null, 2), `${safeFileName(isProject() ? `${p.bookName}-文风` : prof.name)}.novelloom-style.json`);
                case 'export-all': {
                    const list = [exportStyleJson({ ...getStyleById(p, app.settings, PROJECT_STYLE_ID), name: `${p.bookName}·原著文风` }), ...listStylePresets(app.settings).filter((x) => !x.builtin || x.modified).map(exportStyleJson)];
                    return downloadFile(JSON.stringify({ type: 'novelloom-styles', presets: list }, null, 2), 'NovelLoom-文风预设.json');
                }
                case 'sample-paste': {
                    const text = await promptDialog('粘贴一段你想模仿的文字（可以来自其他作品，建议 300-800 字）', '', { title: '粘贴范文', multiline: true });
                    if (!text?.trim()) return;
                    const src = await promptDialog('来源（可留空）', '', { title: '范文来源' });
                    setSamples([...prof.samples, makeSample(truncate(text.trim(), 3000), src?.trim() || '粘贴')]);
                    return render();
                }
                case 'sample-pick':
                    return pickFromSource();
                case 'sample-auto': {
                    const picked = pickSamples(p, { count: 3, length: 500 });
                    if (!picked.length) return app.log('原文太短，挑不出范文', 'warn');
                    let replace = false;
                    if (prof.samples.length) {
                        const { value } = await openDialog({
                            title: '自动挑选范文',
                            body: `<div>从全书均匀挑出 ${picked.length} 段对话与叙述兼有的片段。</div>`,
                            buttons: [{ label: '取消', value: null }, { label: '追加', value: 'add' }, { label: '替换现有范文', value: 'replace', primary: true }],
                        });
                        if (!value) return;
                        replace = value === 'replace';
                    }
                    const list = picked.map((s) => makeSample(s.text, `自动·${s.source.replace(/^原文·/, '')}`));
                    setSamples(replace ? list : [...prof.samples, ...list]);
                    app.log(`🎨 已挑选 ${list.length} 段范文`, 'success');
                    return render();
                }
                case 'sample-clear':
                    if (!(await confirmDialog('清空全部范文？', { danger: true, okLabel: '清空' }))) return;
                    setSamples([]);
                    return render();
                case 'sample-del':
                    setSamples(prof.samples.filter((_, k) => k !== i));
                    return render();
                case 'sample-up': {
                    const list = prof.samples.slice();
                    [list[i - 1], list[i]] = [list[i], list[i - 1]];
                    setSamples(list);
                    return render();
                }
                case 'sample-edit': {
                    const s = prof.samples[i];
                    const { value, root } = await openDialog({
                        title: `编辑范文 ${i + 1}`,
                        wide: true,
                        body: `<div class="nl-field"><label>来源</label><input class="nl-input" data-f="source" value="${esc(s.source)}"></div>
                               <textarea class="nl-input nl-textarea nl-tall" data-f="text">${esc(s.text)}</textarea>`,
                        buttons: [{ label: '取消', value: null }, { label: '保存', value: 'ok', primary: true }],
                    });
                    if (value !== 'ok') return;
                    const text = root.querySelector('[data-f="text"]').value.trim();
                    const list = prof.samples.slice();
                    if (text) list[i] = { ...s, text, source: root.querySelector('[data-f="source"]').value.trim() };
                    else list.splice(i, 1);
                    setSamples(list);
                    return render();
                }
                case 'banned-common': {
                    const cur = String(prof.banned || '').trim();
                    if (cur.includes('常见 AI 腔')) return app.log('已经导入过了', 'warn');
                    patch({ banned: cur ? `${cur}\n\n${COMMON_AI_BANNED}` : COMMON_AI_BANNED });
                    return render();
                }
                case 'banned-count': {
                    const list = parseBanned([prof.banned, opts().globalBanned].join('\n'));
                    if (!list.length) return app.log('还没有禁用词', 'warn');
                    const src = p.chunks.filter((c) => c.origin !== 'generated').map((c) => c.content || '').join('\n');
                    const total = src.length || 1;
                    const rows = list.map((b) => {
                        b.re.lastIndex = 0;
                        const n = (src.match(b.re) || []).length;
                        return { ...b, n, per: (n / total) * 100000 };
                    }).sort((a, b) => b.n - a.n);
                    await openDialog({
                        title: '禁用词在原文中的出现次数',
                        wide: true,
                        body: `<div class="nl-muted nl-small">原文 ${formatNumber(total)} 字。原文里经常出现的词说明它本来就是这本书的写法，禁用它反而会让续写不像原著。</div>
                            <table class="nl-table"><thead><tr><th>禁用词</th><th>原文出现</th><th>每十万字</th><th></th></tr></thead><tbody>
                            ${rows.map((r) => `<tr><td>${esc(r.word)}${r.suggest ? ` → ${esc(r.suggest)}` : ''}</td><td>${r.n}</td><td>${r.per.toFixed(1)}</td><td>${r.per >= 5 ? '<span class="nl-warn">原文常用，建议移除</span>' : r.n ? '偶尔出现' : '<span class="nl-ok">未出现</span>'}</td></tr>`).join('')}
                            </tbody></table>`,
                    });
                    return;
                }
                default:
                    break;
            }
        };

        const onInput = (e) => {
            const t = e.target;
            if (t.dataset.sf) {
                patch({ [t.dataset.sf]: t.value });
                if (t.dataset.sf === 'banned') {
                    const c = qs(el, '[data-banned-count]');
                    if (c) c.textContent = String(parseBanned(t.value).length);
                }
            } else if (t.dataset.opt && t.type !== 'checkbox' && t.tagName !== 'SELECT') {
                opts()[t.dataset.opt] = t.type === 'number' ? Number(t.value) || 0 : t.value;
                app.saveSettings();
            }
        };

        const onChange = async (e) => {
            const t = e.target;
            if (t.dataset.use !== undefined) {
                app.project.styleUse[t.dataset.use] = t.value;
                await app.saveNow();
                return render();
            }
            if (t.dataset.povChar !== undefined) {
                const p = app.project;
                if (!p.povStyles) p.povStyles = {};
                if (t.value) p.povStyles[t.dataset.povChar] = t.value;
                else delete p.povStyles[t.dataset.povChar];
                await app.saveNow();
                return render();
            }
            if (t.dataset.editId !== undefined) {
                editId = t.value;
                return render();
            }
            if (t.dataset.opt && (t.type === 'checkbox' || t.tagName === 'SELECT')) {
                opts()[t.dataset.opt] = t.type === 'checkbox' ? t.checked : t.value;
                app.saveSettings();
            }
        };

        el.addEventListener('click', onClick);
        el.addEventListener('input', onInput);
        el.addEventListener('change', onChange);
        render();
        return { destroy: () => app.saveNow() };
    },
};
