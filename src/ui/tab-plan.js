// 写大纲页：按要求规划后续章节大纲，编辑、单章重写、从某章起重新规划，并可直接按大纲续写

import { app } from '../app.js';
import {
    DETAIL_LEVELS, buildPlanPrompt, clearPlanned, deletePlanChapter, exportPlan, generatePlan,
    insertPlanChapterAfter, nextChapterNo, planStartNo, reviseChapterPlan, sortedPlan,
} from '../planner.js';
import { getStyleProfile } from '../style.js';
import { uniq } from '../utils.js';
import { bindSettings, busy, chainPreviewHtml, confirmDialog, esc, fmtTime, openDialog, optionList, promptDialog, qs, rerollBtn } from './common.js';

const REQUIREMENT_EXAMPLES = [
    '接下来 10 章进入新地图：主角离开下城区，前往魔女学院，途中遇到新的对手',
    '节奏放慢，多写日常与感情线；第 3 章左右让莉莉丝的过去揭露一部分',
    '最终走向 HE；本段剧情的高潮放在最后两章，并回收“魔女秘药”的伏笔',
];

export const planTab = {
    mount(el, { switchTab }) {
        let fromNo = null; // 从某章起重新规划

        const render = () => {
            const p = app.project;
            const ps = app.settings.planner;
            const chapters = sortedPlan(p);
            const pending = chapters.filter((c) => c.status !== 'written');
            const next = nextChapterNo(p);
            const start = Number.isFinite(fromNo) ? fromNo : planStartNo(p);
            el.innerHTML = `
            <section class="nl-card">
                <h3>写后续大纲</h3>
                <div class="nl-muted nl-small">根据已提取的梗概、分卷梗概、章节概要、主要角色现状、世界设定和前文结尾，按你的要求规划接下来的章节。规划好的大纲会被「续写」按章使用。下一章是<b>第 ${next} 章</b>${pending.length ? `，已规划到第 ${Math.max(...pending.map((c) => c.no))} 章` : ''}。</div>
                <div class="nl-grid3">
                    <div class="nl-field"><label>规划章数</label><input class="nl-input" type="number" min="1" max="60" data-setting="planner.count"></div>
                    <div class="nl-field"><label>每章详细程度</label><select class="nl-input" data-setting="planner.detail">${optionList(Object.entries(DETAIL_LEVELS).map(([value, d]) => ({ value, label: d.label })))}</select></div>
                    <div class="nl-field"><label>参考“故事至今”的字数上限</label><input class="nl-input" type="number" min="1000" step="1000" data-setting="planner.contextChars"></div>
                </div>
                <div class="nl-field"><label>你的要求（剧情走向、节奏、必须发生的事件、要回收的伏笔、结局倾向、新角色……）</label>
                    <textarea class="nl-input nl-textarea" rows="4" data-setting="planner.requirement" placeholder="${esc(REQUIREMENT_EXAMPLES.join('\n'))}"></textarea></div>
                <div class="nl-row nl-checks"><label><input type="checkbox" data-setting="planner.useScenes"> 拆分场次（每章细化到 3-5 个地点/在场角色/事件明确的场次，续写按场次写，走向更可控；会增加规划耗时）</label></div>
                <div class="nl-muted nl-small">文风：<b>${esc(getStyleProfile(p, app.settings, 'plan')?.name || '不指定')}</b>（规划时参考视角、基调和写法规则） <a href="#" data-act="goto-style">修改</a></div>
                <div class="nl-row nl-wrap">
                    ${Number.isFinite(fromNo)
                        ? `<span class="nl-tag">从第 ${fromNo} 章起重新规划（会覆盖第 ${fromNo} 章及之后尚未写的大纲） <a href="#" data-act="clear-from">✕</a></span>`
                        : `<span class="nl-muted">将规划第 ${start}–${start + (Number(ps.count) || 10) - 1} 章</span>`}
                    <span class="nl-spacer"></span>
                    <button class="nl-btn" data-act="preview">预览提示词</button>
                    <button class="nl-btn nl-primary" data-act="generate">${Number.isFinite(fromNo) ? '重新规划' : '生成后续大纲'}</button>
                </div>
            </section>

            ${p.plan.arcs.length ? `
            <section class="nl-card">
                <details>
                    <summary><b>规划记录（${p.plan.arcs.length}）</b></summary>
                    ${p.plan.arcs.slice().reverse().map((a) => `<div class="nl-arc"><div class="nl-small"><b>第 ${a.fromNo}–${a.toNo} 章</b> · ${fmtTime(a.createdAt)}</div><div class="nl-small nl-muted">要求：${esc(a.requirement || '无')}</div><div class="nl-small">${esc(a.overview || '')}</div></div>`).join('')}
                </details>
            </section>` : ''}

            <section class="nl-card">
                <div class="nl-row nl-wrap">
                    <h3>章节大纲（${chapters.length}，待写 ${pending.length}）</h3>
                    <span class="nl-spacer"></span>
                    ${pending.length ? `<button class="nl-btn nl-sm nl-primary" data-act="write">按大纲续写</button>` : ''}
                    <button class="nl-btn nl-sm" data-act="export" ${chapters.length ? '' : 'disabled'}>导出 Markdown</button>
                    <button class="nl-btn nl-sm nl-danger" data-act="clear" ${pending.length ? '' : 'disabled'}>清空待写大纲</button>
                </div>
                <div class="nl-plan-list">
                    ${chapters.map((c) => `
                    <div class="nl-plan ${c.status === 'written' ? 'written' : ''}" data-id="${esc(c.id)}">
                        <div class="nl-row nl-wrap">
                            <b>第 ${c.no} 章 ${esc(c.title)}</b>
                            ${c.status === 'written' ? '<span class="nl-tag nl-ok">已写</span>' : c.no === next ? '<span class="nl-tag nl-imp-main">下一章</span>' : '<span class="nl-tag">待写</span>'}
                            <span class="nl-spacer"></span>
                            ${c.status === 'written' ? '' : `
                            <button class="nl-btn nl-sm" data-act="edit" data-id="${esc(c.id)}">编辑</button>
                            ${rerollBtn('revise', `data-id="${esc(c.id)}"`, { label: 'AI 重写', title: '重新生成本章大纲' })}
                            <button class="nl-btn nl-sm" data-act="insert" data-id="${esc(c.id)}" title="在这一章后插入一章">插入↓</button>
                            <button class="nl-btn nl-sm" data-act="from-here" data-id="${esc(c.id)}" title="从这一章起按新要求重新规划">从此重规划</button>
                            <button class="nl-btn nl-sm nl-danger" data-act="delete" data-id="${esc(c.id)}">删除</button>`}
                        </div>
                        <div class="nl-small">${esc(c.summary)}</div>
                        <div class="nl-muted nl-small">
                            ${c.pov ? `🎭 视角：${esc(c.pov)}　` : ''}
                            ${c.characters?.length ? `👤 ${esc(c.characters.join('、'))}　` : ''}
                            ${c.events?.length ? `⚡ ${esc(c.events.join('；'))}　` : ''}
                            ${c.foreshadowing?.length ? `🧩 ${esc(c.foreshadowing.join('；'))}　` : ''}
                            ${c.hook ? `🎣 ${esc(c.hook)}` : ''}
                        </div>
                        ${c.scenes?.length ? `<div class="nl-small nl-muted">🎬 ${c.scenes.map((s) => esc(s.location || '？')).join(' → ')}</div>` : ''}
                    </div>`).join('') || '<div class="nl-muted">还没有大纲。填写要求后点“生成后续大纲”。</div>'}
                </div>
            </section>`;
            bindSettings(el, app.settings, () => app.saveSettings());
        };

        const editChapter = async (c) => {
            const { value, root } = await openDialog({
                title: `编辑第 ${c.no} 章大纲`,
                wide: true,
                body: `
                    <div class="nl-field"><label>章节名</label><input class="nl-input" data-f="title" value="${esc(c.title)}"></div>
                    <div class="nl-field"><label>概要</label><textarea class="nl-input nl-textarea" rows="7" data-f="summary">${esc(c.summary)}</textarea></div>
                    <div class="nl-grid3">
                        <div class="nl-field"><label>出场角色（逗号分隔）</label><input class="nl-input" data-f="characters" value="${esc((c.characters || []).join('，'))}"></div>
                        <div class="nl-field"><label>本章视角<span class="nl-muted nl-small">（多视角管理：按此角色映射的文风续写）</span></label>
                            <select class="nl-input" data-f="pov">${optionList([{ value: '', label: '跟随原视角/不指定' }, ...Object.keys(app.project.characters).sort().map((n) => ({ value: n, label: n }))], c.pov || '')}</select>
                        </div>
                        <div class="nl-field"><label>章末钩子</label><input class="nl-input" data-f="hook" value="${esc(c.hook || '')}"></div>
                    </div>
                    <div class="nl-field"><label>关键事件（每行一条）</label><textarea class="nl-input nl-textarea" rows="3" data-f="events">${esc((c.events || []).join('\n'))}</textarea></div>
                    <div class="nl-field"><label>伏笔（每行一条）</label><textarea class="nl-input nl-textarea" rows="2" data-f="foreshadowing">${esc((c.foreshadowing || []).join('\n'))}</textarea></div>
                    <div class="nl-field"><label>场次（每行一条，格式：地点｜在场角色（顿号分隔）｜概要）</label>
                        <textarea class="nl-input nl-textarea" rows="4" data-f="scenes" placeholder="客厅｜江酒、莉莉丝｜江酒提出分手，莉莉丝表面平静">${esc((c.scenes || []).map((s) => `${s.location}｜${(s.characters || []).join('、')}｜${s.summary}`).join('\n'))}</textarea>
                    </div>`,
                buttons: [{ label: '取消', value: null }, { label: '保存', value: 'ok', primary: true }],
            });
            if (value !== 'ok') return;
            const f = (k) => root.querySelector(`[data-f="${k}"]`).value;
            c.title = f('title').trim() || c.title;
            c.summary = f('summary').trim();
            c.characters = uniq(f('characters').split(/[，,、]/));
            c.pov = f('pov').trim();
            c.hook = f('hook').trim();
            c.events = uniq(f('events').split('\n'));
            c.foreshadowing = uniq(f('foreshadowing').split('\n'));
            c.scenes = f('scenes').split('\n').map((line) => line.trim()).filter(Boolean).map((line) => {
                const [location = '', chars = '', ...rest] = line.split('｜');
                return { location: location.trim(), characters: uniq(chars.split('、')), summary: rest.join('｜').trim() };
            });
            c.updatedAt = Date.now();
            await app.saveNow();
            render();
        };

        const onClick = async (e) => {
            const btn = e.target.closest('[data-act]');
            if (!btn) return;
            e.preventDefault();
            const p = app.project;
            const c = btn.dataset.id ? p.plan.chapters.find((x) => x.id === btn.dataset.id) : null;
            switch (btn.dataset.act) {
                case 'generate': {
                    if (app.isBusy()) return app.log('有任务正在运行，请稍后', 'warn');
                    if (Number.isFinite(fromNo) && !(await confirmDialog(`第 ${fromNo} 章及之后尚未写的大纲会被新规划替换。继续？`))) return;
                    const r = await busy(btn, () => generatePlan(p, app.settings, { fromNo: Number.isFinite(fromNo) ? fromNo : undefined }, { onLog: (m, l) => app.log(m, l) }), 'AI 规划中…');
                    if (!r) return;
                    fromNo = null;
                    await app.saveNow();
                    return render();
                }
                case 'preview': {
                    const { system, prompt } = buildPlanPrompt(p, app.settings, { fromNo: Number.isFinite(fromNo) ? fromNo : undefined });
                    await openDialog({ title: '写大纲提示词预览', wide: true, body: chainPreviewHtml(app.settings, 'outline', { system, prompt, book: p.bookName }) });
                    return;
                }
                case 'goto-style':
                    return switchTab('style');
                case 'clear-from':
                    fromNo = null;
                    return render();
                case 'from-here':
                    fromNo = c.no;
                    render();
                    qs(el, '[data-setting="planner.requirement"]')?.focus();
                    return;
                case 'edit':
                    return editChapter(c);
                case 'revise': {
                    const instruction = await promptDialog(`修改要求（留空则让 AI 自行加强冲突与衔接）`, '', { title: `AI 重写第 ${c.no} 章大纲`, multiline: true });
                    if (instruction === null) return;
                    await busy(btn, async () => {
                        await reviseChapterPlan(p, app.settings, c.id, instruction);
                        await app.saveNow();
                        app.log(`📝 已重写第 ${c.no} 章大纲`, 'success');
                    }, 'AI 重写中…');
                    return render();
                }
                case 'insert': {
                    const ch = insertPlanChapterAfter(p, c.no);
                    await app.saveNow();
                    render();
                    return editChapter(ch);
                }
                case 'delete':
                    if (!(await confirmDialog(`删除第 ${c.no} 章大纲？后面尚未写的章节会依次前移。`, { danger: true, okLabel: '删除' }))) return;
                    deletePlanChapter(p, c.id);
                    await app.saveNow();
                    return render();
                case 'clear': {
                    if (!(await confirmDialog('清空所有尚未写的大纲？（已写的章节记录保留）', { danger: true, okLabel: '清空' }))) return;
                    const n = clearPlanned(p);
                    await app.saveNow();
                    app.log(`已清空 ${n} 章待写大纲`);
                    return render();
                }
                case 'export':
                    return exportPlan(p);
                case 'write': {
                    if (app.isBusy()) return app.log('有任务正在运行，请稍后', 'warn');
                    const next = nextChapterNo(p);
                    const pending = sortedPlan(p).filter((x) => x.status !== 'written' && x.no >= next);
                    if (!pending.length || pending[0].no !== next) return app.log(`下一章是第 ${next} 章，但大纲从第 ${pending[0]?.no ?? '?'} 章开始，请先补齐或从第 ${next} 章重新规划`, 'warn');
                    let count = 0;
                    while (count < pending.length && pending[count].no === next + count) count++;
                    const n = await promptDialog(`按大纲续写几章？（连续的待写大纲共 ${count} 章）`, String(Math.min(count, app.settings.continuation.chapters || 3)), { title: '按大纲续写' });
                    if (!n) return;
                    app.settings.continuation.followPlan = true;
                    app.saveSettings();
                    switchTab('continue');
                    app.continuation.run({ count: Math.max(1, Math.min(count, Number(n) || 1)), direction: app.settings.continuation.direction }).catch((err) => app.log(err.message, 'error'));
                    return;
                }
                default:
                    break;
            }
        };

        el.addEventListener('click', onClick);
        const offs = [app.events.on('continue:chapter', () => render())];
        render();
        return { destroy: () => offs.forEach((f) => f()) };
    },
};

