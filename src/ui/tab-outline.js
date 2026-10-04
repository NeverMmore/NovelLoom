// 大纲页：故事梗概、文风概览、章节概要、重要章节、待确认名称

import { app } from '../app.js';
import { exportCharactersText, exportOutline } from '../io.js';
import { createSnapshot } from '../store.js';
import { buildStorySummary, buildVolumeSummary, findReplace } from '../tools.js';
import { getVolumes, volumeRangeLabel } from '../project.js';
import { truncate } from '../utils.js';
import { busy, emptyState, esc, icon, openDialog, qs, rerollBtn } from './common.js';
import { PROJECT_STYLE_ID, STYLE_TASKS, listStyleChoices, parseBanned, resolveStyleId } from '../style.js';

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

            ${p.missingNames.length ? `
            <section class="nl-card">
                <div class="nl-card-head">
                    <div>
                        <h3>待确认名称（${p.missingNames.length}）</h3>
                        <div class="nl-card-desc">原文用模糊说法指代的对象。填写具体名称后可一键替换进角色档案与世界书（替换前自动快照）。</div>
                    </div>
                    <button class="nl-btn nl-sm nl-primary" data-act="apply-names">把已填写的名称替换进资料</button>
                </div>
                <table class="nl-table"><thead><tr><th>类型</th><th>原文说法</th><th>上下文</th><th>确认名称</th><th></th></tr></thead><tbody>
                ${p.missingNames.map((m, i) => `<tr>
                    <td>${esc(m.type)}</td><td><b>${esc(m.vague)}</b></td><td class="nl-small">${esc(m.context)}</td>
                    <td><input class="nl-input" data-mn="${i}" value="${esc(m.resolved || '')}" placeholder="${esc(m.suggest || '')}"></td>
                    <td><button class="nl-icon-btn" data-act="del-mn" data-i="${i}" title="忽略" aria-label="忽略">${icon('close')}</button></td></tr>`).join('')}
                </tbody></table>
            </section>` : ''}

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

        const onClick = async (e) => {
            const btn = e.target.closest('[data-act]');
            if (!btn) return;
            const p = app.project;
            switch (btn.dataset.act) {
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
                    const todo = p.missingNames.filter((m) => m.resolved && m.vague && m.resolved !== m.vague);
                    if (!todo.length) return app.log('还没有填写任何确认名称', 'warn');
                    await createSnapshot(p, '替换待确认名称前');
                    let n = 0;
                    for (const m of todo) n += findReplace(p, { find: m.vague, replace: m.resolved, scope: ['worldbook', 'characters'] });
                    p.missingNames = p.missingNames.filter((m) => !todo.includes(m));
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
            else if (t.dataset.mn !== undefined) p.missingNames[Number(t.dataset.mn)].resolved = t.value.trim();
            else return;
            app.saveSoon();
        };

        el.addEventListener('click', onClick);
        el.addEventListener('change', onChange);
        render();
        return { destroy: () => qs(el, '[data-f="summary"]') && app.saveNow() };
    },
};
