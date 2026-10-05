// 卡的导向模板管理（写卡表单的「管理导向模板」和设置页共用）：
// 左边列出内置与我的模板，右边是选中模板的内容；内置模板只读，可「复制为我的模板」；
// 我的模板可以改名称、说明、写卡要求、词条正文和词条的插入深度 / 消息角色（以哪种消息插入聊天）/ 顺序，删除需要确认；可导入 / 导出 JSON。

import { app } from '../app.js';
import {
    ORIENTATION_LIMITS, ORIENTATION_ROLES, addOrientationTemplate, duplicateOrientationTemplate, exportOrientationTemplates,
    getOrientationTemplate, importOrientationTemplates, listOrientationTemplates, orientationFileName, orientationNameProblem,
    removeOrientationTemplate, uniqueOrientationName, updateOrientationTemplate, userOrientationTemplates,
} from '../orientation.js';
import { downloadFile, pickFile, readFileAsText } from '../utils.js';
import { alertDialog, confirmDialog, emptyState, esc, icon, openDialog, optionList } from './common.js';

/** 删除后选中哪一个：原位置上的下一个（删的是最后一个就选上一个） */
function idAfterDelete(idsBefore, deletedId, idsAfter) {
    if (!idsAfter.length) return '';
    const i = idsBefore.indexOf(deletedId);
    if (i < 0) return idsAfter[0];
    const pos = idsBefore.slice(0, i).filter((id) => idsAfter.includes(id)).length;
    return idsAfter[Math.min(pos, idsAfter.length - 1)];
}

const roleLabel = (v) => ORIENTATION_ROLES.find((r) => r.value === Number(v))?.label || '系统';

/** 内置模板（只读）的详情 */
function builtinDetailHtml(t) {
    return `
        <div class="nl-row nl-wrap">
            <h3 class="nl-grow" style="margin:0">${esc(t.name)}</h3>
            <button class="nl-btn nl-sm" data-ot-act="duplicate" title="复制成自己的模板，之后可以修改">${icon('copy', { size: 14 })}复制为我的模板</button>
            <button class="nl-btn nl-sm" data-ot-act="export">${icon('download', { size: 14 })}导出</button>
        </div>
        <div class="nl-row nl-wrap" style="margin:6px 0">
            <span class="nl-tag">内置</span>
            <span class="nl-tag" title="世界书词条插在聊天倒数第几条消息之前、以哪种消息插入、同一深度的先后">深度 ${esc(t.depth)} · 以${esc(roleLabel(t.role))}消息插入 · 顺序 ${esc(t.order)}</span>
        </div>
        <div class="nl-muted nl-small">${esc(t.brief)}</div>
        <div class="nl-field"><label>写卡要求（只给写卡 AI）</label><div class="nl-pre nl-small">${esc(t.cardGuide || '（无）')}</div></div>
        <div class="nl-field"><label>世界书词条正文（常驻）</label><div class="nl-pre nl-small">${esc(t.entry)}</div></div>`;
}

/** 我的模板：可编辑的表单 */
function mineDetailHtml(t) {
    return `
        <div class="nl-row nl-wrap">
            <h3 class="nl-grow" style="margin:0">${esc(t.name)}</h3>
            <button class="nl-btn nl-sm" data-ot-act="duplicate">${icon('copy', { size: 14 })}复制</button>
            <button class="nl-btn nl-sm" data-ot-act="export">${icon('download', { size: 14 })}导出</button>
            <button class="nl-icon-btn nl-danger" data-ot-act="delete" title="删除模板" aria-label="删除导向模板「${esc(t.name)}」">${icon('trash')}</button>
        </div>
        <div class="nl-field"><label for="nl-ot-name">名称</label><input class="nl-input" id="nl-ot-name" data-ot-f="name" maxlength="${ORIENTATION_LIMITS.name}" value="${esc(t.name)}"></div>
        <div class="nl-field"><label for="nl-ot-brief">一句话说明 <span class="nl-muted">（写卡表单里显示，也会交给写卡 AI）</span></label><textarea class="nl-input nl-textarea" id="nl-ot-brief" data-ot-f="brief" rows="2" maxlength="${ORIENTATION_LIMITS.brief}">${esc(t.brief)}</textarea></div>
        <div class="nl-field"><label for="nl-ot-guide">写卡要求 <span class="nl-muted">（只给写卡 AI：卡面怎么为这个导向铺垫）</span></label><textarea class="nl-input nl-textarea" id="nl-ot-guide" data-ot-f="cardGuide" rows="3" maxlength="${ORIENTATION_LIMITS.cardGuide}">${esc(t.cardGuide)}</textarea></div>
        <div class="nl-field"><label for="nl-ot-entry">世界书词条正文 <span class="nl-muted">（常驻条目「剧情导向：名称」；{{user}} / {{char}} 由酒馆在聊天时替换）</span></label><textarea class="nl-input nl-textarea nl-mono" id="nl-ot-entry" data-ot-f="entry" rows="8" maxlength="${ORIENTATION_LIMITS.entry}">${esc(t.entry)}</textarea></div>
        <div class="nl-grid3">
            <div class="nl-field"><label for="nl-ot-depth">插入深度</label><input class="nl-input" id="nl-ot-depth" type="number" min="0" step="1" data-ot-f="depth" value="${esc(t.depth)}" title="插在聊天倒数第几条消息之前（0 = 最新消息之后）"></div>
            <div class="nl-field"><label for="nl-ot-role">消息角色</label><select class="nl-input" id="nl-ot-role" data-ot-f="role" title="词条以哪种消息插入聊天：系统 / 用户 / AI">${optionList(ORIENTATION_ROLES, t.role)}</select></div>
            <div class="nl-field"><label for="nl-ot-order">顺序</label><input class="nl-input" id="nl-ot-order" type="number" step="1" data-ot-f="order" value="${esc(t.order)}" title="同一深度有多个词条时的先后，数字大的排在后面、更靠近最新消息"></div>
        </div>
        <div class="nl-small nl-err" data-ot-err role="alert" hidden></div>
        <div class="nl-row"><button class="nl-btn nl-primary" data-ot-act="save">保存</button><span class="nl-muted nl-small" data-ot-saved hidden>${icon('check', { size: 12 })} 已保存</span></div>`;
}

/**
 * 打开导向模板管理。关闭后返回（调用方据此刷新下拉框）。
 * @param {{select?: string}} opt select：打开时选中的模板 id
 */
export async function openOrientationTemplatesDialog({ select = '' } = {}) {
    const box = document.createElement('div');
    let selected = select;

    const render = () => {
        const list = listOrientationTemplates(app.settings);
        if (!list.some((t) => t.id === selected)) selected = list[0]?.id || '';
        const t = list.find((x) => x.id === selected) || null;
        const mine = userOrientationTemplates(app.settings);
        box.innerHTML = `
            <div class="nl-row nl-wrap">
                <div class="nl-muted nl-small nl-grow">导向决定写卡时卡面往哪个方向铺垫，并在卡自己的世界书里加一条常驻的「剧情导向」词条。模板存在扩展设置里，所有项目共用；内置模板不能修改，可以复制成自己的再改。</div>
                <button class="nl-btn nl-sm" data-ot-act="new">${icon('plus', { size: 14 })}新建</button>
                <button class="nl-btn nl-sm" data-ot-act="import">${icon('upload', { size: 14 })}导入 JSON</button>
                <button class="nl-btn nl-sm" data-ot-act="export-all" ${mine.length ? '' : 'disabled'} title="把我的模板全部导出成一个 JSON 文件">${icon('download', { size: 14 })}导出我的模板</button>
            </div>
            <div class="nl-split" style="margin-top:8px">
                <div class="nl-char-list" role="listbox" aria-label="导向模板">
                    ${list.map((x) => `
                    <div class="nl-char-item ${x.id === selected ? 'active' : ''}" role="option" tabindex="0" aria-selected="${x.id === selected}" data-ot-id="${esc(x.id)}">
                        <div class="nl-row"><b class="nl-grow">${esc(x.name)}</b>${x.builtin ? '<span class="nl-tag">内置</span>' : '<span class="nl-tag">我的</span>'}</div>
                        <div class="nl-small nl-clamp">${esc(x.brief || '（没有说明）')}</div>
                    </div>`).join('')}
                </div>
                <div data-ot-detail>${t ? (t.builtin ? builtinDetailHtml(t) : mineDetailHtml(t)) : emptyState('没有模板', '', { ico: 'file' })}</div>
            </div>`;
    };

    /** 右边我的模板表单改过、还没保存 */
    let dirty = false;

    /** 读右边表单里的值（我的模板） */
    const readForm = () => {
        const v = (k) => box.querySelector(`[data-ot-f="${k}"]`)?.value ?? '';
        return { name: v('name'), brief: v('brief'), cardGuide: v('cardGuide'), entry: v('entry'), depth: v('depth'), role: v('role'), order: v('order') };
    };

    const showErr = (msg) => {
        const err = box.querySelector('[data-ot-err]');
        if (!err) return;
        err.textContent = msg;
        err.hidden = !msg;
    };

    /** 保存右边的表单（我的模板）；名称有问题时提示并返回 false */
    const saveForm = () => {
        const t = getOrientationTemplate(app.settings, selected);
        if (!t || t.builtin || !dirty) return true;
        const data = readForm();
        const problem = orientationNameProblem(app.settings, data.name, t.id);
        if (problem) {
            showErr(problem);
            box.querySelector('[data-ot-f="name"]')?.focus();
            return false;
        }
        updateOrientationTemplate(app.settings, t.id, data);
        app.saveSettings();
        dirty = false;
        return true;
    };

    /** 换选中的模板：右边改过的先保存（名称有问题时留在原处） */
    const selectId = (id, focusSel = '') => {
        if (id !== selected && !saveForm()) return;
        dirty = false;
        selected = id;
        render();
        (focusSel ? box.querySelector(focusSel) : box.querySelector(`[data-ot-id="${CSS.escape(id)}"]`))?.focus();
    };

    const onClick = async (e) => {
        const item = e.target.closest('[data-ot-id]');
        if (item) return selectId(item.dataset.otId);
        const btn = e.target.closest('[data-ot-act]');
        if (!btn) return undefined;
        // 复制 / 导出用的是保存后的内容：右边改过的先保存
        if (['duplicate', 'export', 'export-all'].includes(btn.dataset.otAct) && !saveForm()) return undefined;
        const t = getOrientationTemplate(app.settings, selected);
        try {
            switch (btn.dataset.otAct) {
                case 'new': {
                    const created = addOrientationTemplate(app.settings, { name: uniqueOrientationName(app.settings, '我的导向'), brief: '', cardGuide: '', entry: '【剧情导向：我的导向】\n- ' });
                    app.saveSettings();
                    return selectId(created.id, '[data-ot-f="name"]');
                }
                case 'import': {
                    const file = await pickFile('.json,application/json');
                    if (!file) return undefined;
                    const created = importOrientationTemplates(app.settings, await readFileAsText(file));
                    app.saveSettings();
                    app.log(`已导入 ${created.length} 个导向模板：${created.map((x) => x.name).join('、')}`, 'success');
                    return selectId(created[0].id);
                }
                case 'export-all': {
                    const mine = userOrientationTemplates(app.settings);
                    if (!mine.length) return undefined;
                    downloadFile(JSON.stringify(exportOrientationTemplates(mine), null, 2), orientationFileName(mine));
                    return undefined;
                }
                case 'export':
                    if (t) downloadFile(JSON.stringify(exportOrientationTemplates([t]), null, 2), orientationFileName([t]));
                    return undefined;
                case 'duplicate': {
                    if (!t) return undefined;
                    const copy = duplicateOrientationTemplate(app.settings, t.id);
                    app.saveSettings();
                    app.log(`已复制为「${copy.name}」`, 'success');
                    return selectId(copy.id, '[data-ot-f="name"]');
                }
                case 'save': {
                    if (!t || t.builtin) return undefined;
                    dirty = true;
                    if (!saveForm()) return undefined;
                    selectId(t.id, '[data-ot-act="save"]');
                    box.querySelector('[data-ot-saved]')?.removeAttribute('hidden');
                    return undefined;
                }
                case 'delete': {
                    if (!t || t.builtin) return undefined;
                    if (!(await confirmDialog(`删除导向模板「${t.name}」？已经用它生成的角色卡不受影响（卡上存的是当时的内容）。`, { danger: true, okLabel: '删除' }))) return undefined;
                    const before = listOrientationTemplates(app.settings).map((x) => x.id);
                    removeOrientationTemplate(app.settings, t.id);
                    app.saveSettings();
                    app.log(`已删除导向模板「${t.name}」`, 'success');
                    return selectId(idAfterDelete(before, t.id, listOrientationTemplates(app.settings).map((x) => x.id)));
                }
                default:
                    return undefined;
            }
        } catch (err) {
            await alertDialog(err?.message || String(err), '出错了');
            return undefined;
        }
    };

    const onKey = (e) => {
        const item = e.target.closest?.('[data-ot-id]');
        if (!item) return;
        const items = [...box.querySelectorAll('[data-ot-id]')];
        const i = items.indexOf(item);
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            selectId(item.dataset.otId);
        } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            const next = items[i + (e.key === 'ArrowDown' ? 1 : -1)];
            if (next) selectId(next.dataset.otId);
        }
    };

    box.addEventListener('click', onClick);
    box.addEventListener('keydown', onKey);
    const onEdit = (e) => {
        if (!e.target.closest('[data-ot-f]')) return;
        dirty = true;
        showErr('');
        box.querySelector('[data-ot-saved]')?.setAttribute('hidden', '');
    };
    box.addEventListener('input', onEdit);
    box.addEventListener('change', onEdit);
    render();
    // 点「关闭」时先保存右边的修改：名称有问题（空 / 重名）就提示并留在对话框里
    await openDialog({ title: '卡的导向模板', wide: true, body: box, buttons: [{ label: '关闭', value: null, validate: () => saveForm() }] });
    // Esc、点遮罩或 × 关闭时不经过上面的检查：还有没保存的修改就保存，免得白改；名称有问题时名称不改、其他修改照样保存
    if (dirty && !saveForm()) {
        const t = getOrientationTemplate(app.settings, selected);
        if (t && !t.builtin) {
            try {
                const data = readForm();
                const problem = orientationNameProblem(app.settings, data.name, t.id);
                updateOrientationTemplate(app.settings, t.id, { ...data, name: t.name });
                app.saveSettings();
                app.log(`导向模板「${t.name}」的名称没有改（${problem}），其他修改已保存`, 'warn');
            } catch { /* ignore */ }
        }
    }
}
