// 剧情推演（当前酒馆对话版）的入口弹窗：从魔杖菜单直接打开，不依赖 NovelLoom 主界面/项目。
// UI 交互方式照抄角色卡页里成熟的「并列走向 → 勾选 → 分阶段」流程（见 tab-cards.js 的 deduceDialog），
// 只是数据来源换成 livededuce.js（读酒馆当前这个单人对话的角色卡字段 + 聊天记录 + 世界书，存到 chat_metadata）。

import { app } from '../app.js';
import { addBranchTemplate, branchTemplates, DEFAULT_BRANCH_COUNT, removeBranchTemplate, updateBranchTemplate } from '../deduce.js';
import {
    activeCharacterName, addChatBranch, addChatStage, chatDeductionMarkdown, ensureChatProjection,
    generateChatBranches, generateChatStages, hasActiveChat, removeChatBranch, removeChatStage,
    setSelectedChatBranches, updateChatBranch, updateChatStage,
} from '../livededuce.js';
import { downloadFile, safeFileName } from '../utils.js';
import { alertDialog, busy, confirmDialog, esc, openDialog, promptDialog, rerollBtn } from './common.js';

const editBranchDialog = async (existing) => {
    const b = existing || { title: '', summary: '' };
    const { value, root } = await openDialog({
        title: existing ? '编辑走向' : '添加走向',
        body: `
            <div class="nl-field"><label>标题</label><input class="nl-input" data-f="title" value="${esc(b.title)}"></div>
            <div class="nl-field"><label>概要</label><textarea class="nl-input nl-textarea" rows="4" data-f="summary">${esc(b.summary)}</textarea></div>`,
        buttons: [{ label: '取消', value: null }, { label: '保存', value: 'ok', primary: true }],
    });
    if (value !== 'ok') return null;
    const title = root.querySelector('[data-f="title"]').value.trim();
    const summary = root.querySelector('[data-f="summary"]').value.trim();
    if (!title && !summary) return null;
    return { title, summary };
};

const editStageDialog = async (existing) => {
    const s = existing || { title: '', content: '' };
    const { value, root } = await openDialog({
        title: existing ? '编辑阶段' : '添加阶段',
        body: `
            <div class="nl-field"><label>标题</label><input class="nl-input" data-f="title" value="${esc(s.title)}"></div>
            <div class="nl-field"><label>内容</label><textarea class="nl-input nl-textarea" rows="6" data-f="content">${esc(s.content)}</textarea></div>`,
        buttons: [{ label: '取消', value: null }, { label: '保存', value: 'ok', primary: true }],
    });
    if (value !== 'ok') return null;
    const title = root.querySelector('[data-f="title"]').value.trim();
    const content = root.querySelector('[data-f="content"]').value.trim();
    if (!title && !content) return null;
    return { title, content };
};

/** 走向模板选择/管理：和角色卡页共用同一套模板池（存在扩展设置里），这里直接复用 deduce.js 的读写函数 */
const pickTemplateDialog = async () => {
    const tpls = branchTemplates(app.settings);
    if (!tpls.length) {
        await alertDialog('还没有保存的模板。可以先在走向槽位里写点方向提示，点 💾 存成模板。', '没有模板');
        return null;
    }
    const { value } = await openDialog({
        title: '选择一个走向模板',
        body: `<div class="nl-cards">${tpls.map((t) => `
            <div class="nl-cardbox" data-tpl="${esc(t.id)}" style="cursor:pointer">
                <div class="nl-grow"><b>${esc(t.label)}</b><div class="nl-small nl-muted">${esc(t.hint)}</div></div>
            </div>`).join('')}</div>`,
        buttons: [{ label: '取消', value: null }],
        onMount: (root, close) => {
            root.addEventListener('click', (e) => {
                const box = e.target.closest('[data-tpl]');
                if (!box) return;
                const t = tpls.find((x) => x.id === box.dataset.tpl);
                close(t ? t.hint : null);
            });
        },
    });
    return value;
};

const openBranchTemplatesDialog = async () => {
    const tpls = branchTemplates(app.settings);
    const body = `
        <div class="nl-muted nl-small">模板存的是"大方向点子"，套用时会由 AI 结合当前角色和对话的具体情况重新展开，不是原样照抄。和角色卡页的走向模板是同一套，保存在扩展设置里，所有地方共用。</div>
        <table class="nl-table" style="margin-top:8px">
            <thead><tr><th>名称</th><th>方向提示</th><th></th></tr></thead>
            <tbody>
                ${tpls.map((t) => `<tr data-tplid="${esc(t.id)}">
                    <td><input class="nl-input" data-tpl-label value="${esc(t.label)}"></td>
                    <td><input class="nl-input" data-tpl-hint value="${esc(t.hint)}"></td>
                    <td><button class="nl-icon-btn" data-tpl-del title="删除">✕</button></td>
                </tr>`).join('') || '<tr><td colspan="3" class="nl-muted">还没有保存的模板</td></tr>'}
                <tr>
                    <td><input class="nl-input" data-tpl-new-label placeholder="名称，例如「反目成仇」"></td>
                    <td><input class="nl-input" data-tpl-new-hint placeholder="方向提示，例如「两人因为一个误会彻底决裂」"></td>
                    <td><button class="nl-btn nl-sm" data-tpl-add>+ 添加</button></td>
                </tr>
            </tbody>
        </table>`;
    const { value } = await openDialog({
        title: '走向模板管理',
        wide: true,
        body,
        buttons: [{ label: '关闭', value: null }],
        onMount: (r, close) => {
            r.addEventListener('change', (e) => {
                const tr = e.target.closest('[data-tplid]');
                if (!tr) return;
                const id = tr.dataset.tplid;
                if (e.target.matches('[data-tpl-label]')) updateBranchTemplate(app.settings, id, { label: e.target.value });
                if (e.target.matches('[data-tpl-hint]')) updateBranchTemplate(app.settings, id, { hint: e.target.value });
                app.saveSettings();
            });
            r.addEventListener('click', async (e) => {
                if (e.target.matches('[data-tpl-del]')) {
                    const tr = e.target.closest('[data-tplid]');
                    const t = tpls.find((x) => x.id === tr.dataset.tplid);
                    if (!(await confirmDialog(`删除模板「${t?.label}」？`, { danger: true, okLabel: '删除' }))) return;
                    removeBranchTemplate(app.settings, tr.dataset.tplid);
                    app.saveSettings();
                    close('refresh');
                } else if (e.target.matches('[data-tpl-add]')) {
                    const labelInput = r.querySelector('[data-tpl-new-label]');
                    const hintInput = r.querySelector('[data-tpl-new-hint]');
                    try {
                        addBranchTemplate(app.settings, { label: labelInput.value, hint: hintInput.value });
                        app.saveSettings();
                        close('refresh');
                    } catch (err) {
                        app.log(err.message, 'error');
                    }
                }
            });
        },
    });
    if (value === 'refresh') await openBranchTemplatesDialog();
};

const openGenBranchesDialog = async (pp) => {
    const hints = pp.branches.length ? pp.branches.map((b) => b.title) : new Array(DEFAULT_BRANCH_COUNT).fill('');
    const box = document.createElement('div');
    const slotRow = (hint, i) => `
        <div class="nl-row nl-wrap" data-slot-idx="${i}" style="align-items:center">
            <span class="nl-muted nl-small" style="width:1.6em">${i + 1}.</span>
            <input class="nl-input nl-grow" data-slot-hint placeholder="不限方向，由 AI 自由发挥" value="${esc(hint)}">
            <button class="nl-icon-btn" data-act="pick-tpl" title="套用已保存的模板">📑</button>
            <button class="nl-icon-btn" data-act="save-tpl" title="把这条方向存成模板">💾</button>
            <button class="nl-icon-btn" data-act="del-slot" title="删除这一条">✕</button>
        </div>`;
    const renderSlots = () => {
        box.querySelector('[data-slots]').innerHTML = hints.map(slotRow).join('');
    };
    box.innerHTML = `
        <div class="nl-muted nl-small">会结合目前实际的聊天记录和当前生效的世界书来推演。可以不干预，直接点下面「生成」；也可以给某一条单独写方向提示，或套用保存的模板——留空的条目不限方向，由 AI 自由发挥，但会和其他几条有明显区别。</div>
        <div data-slots style="margin:8px 0"></div>
        <div class="nl-row">
            <button class="nl-btn nl-sm" data-act="add-slot">+ 加一条走向</button>
            <span class="nl-spacer"></span>
            <button class="nl-btn nl-sm" data-act="manage-tpl">⚙️ 管理模板</button>
        </div>
        <div class="nl-field" style="margin-top:8px"><label>整体额外要求（可选，对每条走向都适用）</label><textarea class="nl-input nl-textarea" rows="3" data-instruction></textarea></div>`;
    renderSlots();

    box.addEventListener('input', (e) => {
        if (!e.target.matches('[data-slot-hint]')) return;
        const i = Number(e.target.closest('[data-slot-idx]').dataset.slotIdx);
        hints[i] = e.target.value;
    });
    box.addEventListener('click', async (e) => {
        const btn = e.target.closest('[data-act]');
        if (!btn) return;
        const slotEl = btn.closest('[data-slot-idx]');
        const i = slotEl ? Number(slotEl.dataset.slotIdx) : -1;
        switch (btn.dataset.act) {
            case 'add-slot':
                if (hints.length >= 8) { app.log('最多 8 条走向', 'warn'); return; }
                hints.push('');
                renderSlots();
                return;
            case 'del-slot':
                if (hints.length <= 2) { app.log('至少保留 2 条走向', 'warn'); return; }
                hints.splice(i, 1);
                renderSlots();
                return;
            case 'pick-tpl': {
                const hint = await pickTemplateDialog();
                if (hint === null) return;
                hints[i] = hint;
                renderSlots();
                return;
            }
            case 'save-tpl': {
                const cur = (hints[i] || '').trim();
                if (!cur) { app.log('这一条还没有方向内容，先写点什么再存', 'warn'); return; }
                const label = await promptDialog('模板名称', cur.slice(0, 16), { title: '存为走向模板' });
                if (!label) return;
                try {
                    addBranchTemplate(app.settings, { label, hint: cur });
                    app.saveSettings();
                    app.log(`💾 已保存模板「${label}」`, 'success');
                } catch (err) {
                    app.log(err.message, 'error');
                }
                return;
            }
            case 'manage-tpl':
                await openBranchTemplatesDialog();
                return;
            default:
                return;
        }
    });

    const { value } = await openDialog({
        title: pp.branches.length ? '重新生成走向' : '生成走向',
        wide: true,
        body: box,
        buttons: [{ label: '取消', value: null }, { label: '生成', value: 'ok', primary: true }],
    });
    if (value !== 'ok') return null;
    const instruction = box.querySelector('[data-instruction]').value.trim();
    return { instruction, directions: hints.map((h) => h.trim()) };
};

/** 魔杖菜单的新入口：对当前这个单人角色对话做剧情推演，结果挂在这个对话自己的 chat_metadata 上 */
export async function openLiveDeduceDialog() {
    if (!hasActiveChat()) {
        await alertDialog('请先打开一个单人角色的对话（群聊暂不支持），再来推演接下来的剧情走向。', '还没有可推演的对话');
        return;
    }
    const pp = ensureChatProjection();
    const box = document.createElement('div');

    const branchItem = (b) => `
        <div class="nl-cardbox" data-bid="${esc(b.id)}">
            <label class="nl-row" style="align-items:flex-start">
                <input type="checkbox" data-branch-check value="${esc(b.id)}" ${pp.selectedBranchIds.includes(b.id) ? 'checked' : ''}>
            </label>
            <div class="nl-grow">
                <b>${esc(b.title)}</b>
                <div class="nl-small">${esc(b.summary)}</div>
            </div>
            <div class="nl-card-actions">
                <button class="nl-icon-btn" data-act="edit-branch" data-bid="${esc(b.id)}" title="编辑">✏️</button>
                <button class="nl-icon-btn" data-act="del-branch" data-bid="${esc(b.id)}" title="删除">✕</button>
            </div>
        </div>`;
    const stageItem = (s, i) => `
        <div class="nl-cardbox" data-sid="${esc(s.id)}">
            <div class="nl-grow">
                <b>${i + 1}. ${esc(s.title)}</b>
                <div class="nl-small nl-pre">${esc(s.content)}</div>
            </div>
            <div class="nl-card-actions">
                <button class="nl-icon-btn" data-act="edit-stage" data-sid="${esc(s.id)}" title="编辑">✏️</button>
                <button class="nl-icon-btn" data-act="del-stage" data-sid="${esc(s.id)}" title="删除">✕</button>
            </div>
        </div>`;

    const renderBody = () => {
        box.innerHTML = `
            <div class="nl-muted nl-small">基于<b>这个角色当前的卡面设定</b>、<b>目前为止实际聊到哪了</b>、以及<b>当前生效的世界书</b>，推演接下来可能的发展——会从对话目前的结尾处继续往后走，不会重复或推翻已经发生过的内容。结果只跟着这个对话走，换一个对话或角色互不影响；不会改动角色卡本身。</div>
            <section class="nl-card">
                <div class="nl-row nl-wrap">
                    <h4>可能的走向</h4>
                    <span class="nl-spacer"></span>
                    ${rerollBtn('gen-branches', '', { label: pp.branches.length ? '重新生成走向' : '生成走向' })}
                    <button class="nl-btn nl-sm" data-act="add-branch">+ 手动添加</button>
                    <button class="nl-btn nl-sm" data-act="manage-tpl" title="管理走向模板：保存的大方向点子，和角色卡页共用">📑 走向模板</button>
                </div>
                <div class="nl-cards">${pp.branches.length ? pp.branches.map(branchItem).join('') : '<div class="nl-muted nl-small">还没有走向，点上面生成，或者手动添加。</div>'}</div>
            </section>
            <section class="nl-card">
                <div class="nl-row nl-wrap">
                    <h4>分阶段推演</h4>
                    <span class="nl-spacer"></span>
                    ${rerollBtn('gen-stages', '', { label: pp.stages.length ? '重新推演' : '开始推演' })}
                    <button class="nl-btn nl-sm" data-act="add-stage">+ 手动添加</button>
                    <button class="nl-btn nl-sm" data-act="export-md" ${pp.branches.length || pp.stages.length ? '' : 'disabled'}>复制 Markdown</button>
                </div>
                ${pp.selectedBranchIds.length ? '' : '<div class="nl-muted nl-small">先在上面勾选至少一个走向，再来推演具体的分阶段发展。</div>'}
                <div class="nl-cards">${pp.stages.length ? pp.stages.map(stageItem).join('') : '<div class="nl-muted nl-small">还没有分阶段推演。</div>'}</div>
            </section>`;
    };
    renderBody();

    box.addEventListener('change', async (e) => {
        if (!e.target.hasAttribute('data-branch-check')) return;
        const ids = pp.selectedBranchIds.slice();
        const id = e.target.value;
        const i = ids.indexOf(id);
        if (e.target.checked && i < 0) ids.push(id);
        else if (!e.target.checked && i >= 0) ids.splice(i, 1);
        await setSelectedChatBranches(ids);
        renderBody();
    });

    box.addEventListener('click', async (e) => {
        const btn = e.target.closest('[data-act]');
        if (!btn) return;
        switch (btn.dataset.act) {
            case 'gen-branches': {
                if (app.isBusy()) return app.log('已有任务在运行', 'warn');
                const res = await openGenBranchesDialog(pp);
                if (!res) return;
                await busy(btn, async () => {
                    await generateChatBranches(app.settings, res);
                }, '推演中…');
                return renderBody();
            }
            case 'manage-tpl':
                await openBranchTemplatesDialog();
                return;
            case 'add-branch': {
                const b = await editBranchDialog(null);
                if (!b) return;
                await addChatBranch(b);
                return renderBody();
            }
            case 'edit-branch': {
                const cur = pp.branches.find((x) => x.id === btn.dataset.bid);
                if (!cur) return;
                const b = await editBranchDialog(cur);
                if (!b) return;
                await updateChatBranch(cur.id, b);
                return renderBody();
            }
            case 'del-branch':
                if (!(await confirmDialog('删除这个走向？', { danger: true, okLabel: '删除' }))) return;
                await removeChatBranch(btn.dataset.bid);
                return renderBody();
            case 'gen-stages': {
                if (!pp.selectedBranchIds.length) return app.log('请先勾选至少一个走向', 'warn');
                if (app.isBusy()) return app.log('已有任务在运行', 'warn');
                const instruction = await promptDialog('可选：给这次分阶段推演的额外要求（留空则让 AI 自行发挥）', '', { title: '分阶段推演', multiline: true });
                if (instruction === null) return;
                await busy(btn, async () => {
                    await generateChatStages(app.settings, { instruction });
                }, '推演中…');
                return renderBody();
            }
            case 'add-stage': {
                const s = await editStageDialog(null);
                if (!s) return;
                await addChatStage(s);
                return renderBody();
            }
            case 'edit-stage': {
                const cur = pp.stages.find((x) => x.id === btn.dataset.sid);
                if (!cur) return;
                const s = await editStageDialog(cur);
                if (!s) return;
                await updateChatStage(cur.id, s);
                return renderBody();
            }
            case 'del-stage':
                if (!(await confirmDialog('删除这个阶段？', { danger: true, okLabel: '删除' }))) return;
                await removeChatStage(btn.dataset.sid);
                return renderBody();
            case 'export-md':
                try {
                    await navigator.clipboard.writeText(chatDeductionMarkdown());
                    app.log('📋 已复制到剪贴板', 'success');
                } catch {
                    downloadFile(chatDeductionMarkdown(), `${safeFileName(activeCharacterName() || '当前对话')}-剧情推演.md`, 'text/markdown');
                }
                return;
            default:
                return;
        }
    });

    await openDialog({ title: `剧情推演：${activeCharacterName()}（当前对话）`, wide: true, body: box, buttons: [{ label: '关闭', value: null }] });
}
