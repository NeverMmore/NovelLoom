// UI 公共工具：对话框、设置绑定、格式化

import { escapeHtml, estimateTokens } from '../utils.js';
import { buildChainMessages, errorText, getChain } from '../llm.js';
import { icon } from './icons.js';

export { icon };

export const esc = escapeHtml;

export function qs(root, sel) {
    return root.querySelector(sel);
}

export function qsa(root, sel) {
    return [...root.querySelectorAll(sel)];
}

export function getPath(obj, path) {
    return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

export function setPath(obj, path, value) {
    const keys = path.split('.');
    let o = obj;
    for (let i = 0; i < keys.length - 1; i++) {
        if (o[keys[i]] == null || typeof o[keys[i]] !== 'object') o[keys[i]] = {};
        o = o[keys[i]];
    }
    o[keys[keys.length - 1]] = value;
}

/**
 * 双向绑定：<input data-setting="extraction.mode">
 * @param {HTMLElement} root
 * @param {object} settings
 * @param {Function} onChange (path, value)
 */
export function bindSettings(root, settings, onChange) {
    for (const el of qsa(root, '[data-setting]')) {
        const path = el.dataset.setting;
        const v = getPath(settings, path);
        if (el.type === 'checkbox') el.checked = !!v;
        else if (v !== undefined && v !== null) el.value = v;
        const handler = () => {
            let val;
            if (el.type === 'checkbox') val = el.checked;
            else if (el.type === 'number' || el.dataset.type === 'number') val = el.value === '' ? 0 : Number(el.value);
            else val = el.value;
            setPath(settings, path, val);
            onChange?.(path, val, el);
        };
        el.addEventListener(el.tagName === 'SELECT' || el.type === 'checkbox' ? 'change' : 'input', handler);
    }
}

let dialogZ = 10050;

/** 这个遮罩是不是当前最上面的对话框（后打开的追加在 body 末尾，叠在上面） */
function isTopDialog(overlay) {
    const all = document.querySelectorAll('.nl-dialog-overlay');
    return all.length > 0 && all[all.length - 1] === overlay;
}

/**
 * 通用对话框
 * @param {{title: string, body: string|HTMLElement, buttons?: {label:string, value:any, primary?:boolean, danger?:boolean}[], wide?: boolean, onMount?: Function}} opt
 * @returns {Promise<{value:any, root:HTMLElement}>}
 */
export function openDialog({ title, body, buttons = [{ label: '关闭', value: null }], wide = false, onMount, dismissValue = null }) {
    return new Promise((resolve) => {
        const overlay = document.createElement('div');
        overlay.className = 'nl-dialog-overlay';
        overlay.style.zIndex = String(++dialogZ);
        overlay.innerHTML = `
            <div class="nl-dialog ${wide ? 'nl-dialog-wide' : ''}" role="dialog" aria-modal="true" aria-label="${esc(title)}">
                <div class="nl-dialog-head"><b>${esc(title)}</b><button class="nl-icon-btn" data-close title="关闭" aria-label="关闭">${icon('close')}</button></div>
                <div class="nl-dialog-body"></div>
                <div class="nl-dialog-foot">${buttons.map((b, i) => `<button class="nl-btn ${b.primary ? 'nl-primary' : ''} ${b.danger ? 'nl-danger' : ''}" data-i="${i}">${esc(b.label)}</button>`).join('')}</div>
            </div>`;
        const bodyEl = overlay.querySelector('.nl-dialog-body');
        if (typeof body === 'string') bodyEl.innerHTML = body;
        else if (body) bodyEl.appendChild(body);
        // 关闭后把焦点还给打开对话框的那个按钮（它已经被重新渲染掉的话就算了）
        const opener = document.activeElement;
        const close = (value) => {
            overlay.remove();
            document.removeEventListener('keydown', onKey, true);
            if (opener?.isConnected && !document.activeElement?.closest?.('.nl-dialog-overlay')) {
                try {
                    opener.focus({ preventScroll: true });
                } catch { /* ignore */ }
            }
            resolve({ value, root: bodyEl });
        };
        const onKey = (e) => {
            if (e.key !== 'Escape') return;
            // 每个对话框都在 document 上挂了捕获阶段的监听，stopPropagation 拦不住同一节点上的其他监听：
            // 叠着好几个对话框时只让最上面那个响应 Esc，下面的（比如还没保存的编辑框）原样留着
            if (!isTopDialog(overlay)) return;
            e.stopPropagation();
            close(dismissValue);
        };
        overlay.addEventListener('click', async (e) => {
            if (e.target === overlay || e.target.closest('[data-close]')) return close(dismissValue);
            const btn = e.target.closest('.nl-dialog-foot button');
            if (!btn) return;
            const b = buttons[Number(btn.dataset.i)];
            if (b.validate) {
                const ok = await b.validate(bodyEl);
                if (!ok) return;
            }
            close(b.value);
        });
        document.addEventListener('keydown', onKey, true);
        document.body.appendChild(overlay);
        onMount?.(bodyEl, close);
        // 焦点移进对话框（避免焦点留在背后的按钮上，回车又打开一个对话框）：
        // 有输入框就聚焦输入框；危险操作的确认框聚焦“取消”，防止回车误删；其他聚焦主按钮
        const first = bodyEl.querySelector('input, textarea, select');
        const foot = overlay.querySelector('.nl-dialog-foot');
        if (first) first.focus();
        else if (foot?.querySelector('.nl-danger')) foot.querySelector('button')?.focus();
        else (foot?.querySelector('.nl-primary') || foot?.querySelector('button:last-child') || overlay.querySelector('[data-close]'))?.focus();
    });
}

export async function confirmDialog(message, { title = '确认', okLabel = '确定', danger = false } = {}) {
    const { value } = await openDialog({
        title,
        body: `<div class="nl-pre">${esc(message)}</div>`,
        buttons: [{ label: '取消', value: false }, { label: okLabel, value: true, primary: !danger, danger }],
        dismissValue: false,
    });
    return !!value;
}

export async function promptDialog(message, defaultValue = '', { title = '输入', multiline = false, placeholder = '' } = {}) {
    const input = multiline
        ? `<textarea class="nl-input nl-textarea" rows="6" placeholder="${esc(placeholder)}">${esc(defaultValue)}</textarea>`
        : `<input class="nl-input" type="text" value="${esc(defaultValue)}" placeholder="${esc(placeholder)}">`;
    const { value, root } = await openDialog({
        title,
        body: `<div class="nl-field"><label>${esc(message)}</label>${input}</div>`,
        buttons: [{ label: '取消', value: null }, { label: '确定', value: 'ok', primary: true }],
        onMount: (b, close) => {
            const el = b.querySelector('input');
            el?.addEventListener('keydown', (e) => {
                // 阻止这次回车继续传给接下来打开的对话框（否则会直接“确认”下一个对话框）；输入法选词时的回车不算
                if (e.key === 'Enter' && !e.isComposing) {
                    e.preventDefault();
                    close('ok');
                }
            });
        },
    });
    if (value !== 'ok') return null;
    return root.querySelector('input, textarea').value;
}

export async function alertDialog(message, title = '提示') {
    await openDialog({ title, body: `<div class="nl-pre">${esc(message)}</div>`, buttons: [{ label: '知道了', value: true, primary: true }] });
}

export function statusIcon(status) {
    const map = {
        pending: ['nl-dot', '待处理'],
        processing: ['nl-spin nl-accent-ink', '处理中'],
        done: ['nl-dot nl-ok', '已完成'],
        error: ['nl-dot nl-err', '出错'],
    };
    const [cls, label] = map[status] || ['nl-dot', String(status || '')];
    return `<span class="${cls}" role="img" aria-label="${label}" title="${label}"></span>`;
}

export function importanceLabel(i) {
    return { main: '主要', support: '重要', minor: '次要' }[i] || i;
}

export function fmtTime(t) {
    if (!t) return '';
    const d = new Date(t);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * 统一的“重roll”按钮：所有 AI 生成内容旁用于就地重新生成的按钮，统一用骰子图标 + nl-reroll 标记类，方便一眼认出。
 * 具体的重新生成逻辑仍由调用方在各自的 onClick（data-act）里实现，这里只统一外观。
 * @param {string} act data-act 值
 * @param {string} attrs 额外拼进标签的属性字符串（例如 `data-id="${esc(c.id)}"`），调用方自行转义
 * @param {{label?:string, title?:string}} opt label 留空则只显示图标（适合紧凑的行内位置）
 */
export function rerollBtn(act, attrs = '', { label = '', title = '重新生成' } = {}) {
    if (!label) return `<button class="nl-icon-btn nl-reroll" data-act="${esc(act)}" ${attrs} title="${esc(title)}" aria-label="${esc(title)}">${icon('dice')}</button>`;
    return `<button class="nl-btn nl-sm nl-reroll" data-act="${esc(act)}" ${attrs} title="${esc(title)}">${icon('dice')}${esc(label)}</button>`;
}

export function optionList(items, selected) {
    return items.map((it) => {
        const v = typeof it === 'object' ? it.value : it;
        const l = typeof it === 'object' ? it.label : it;
        return `<option value="${esc(v)}" ${String(v) === String(selected) ? 'selected' : ''}>${esc(l)}</option>`;
    }).join('');
}

/** 包装异步按钮：执行期间禁用并显示状态，出错弹提示 */
export async function busy(btn, fn, label = '处理中…') {
    const old = btn?.innerHTML;
    // 同一个操作可能同时出现在页面标题栏和空状态里：运行期间把相同 data-act（与 data-id）的按钮一起禁用，避免重复发起
    const twins = btn?.dataset?.act
        ? [...document.querySelectorAll('.nl-root button[data-act], .nl-dialog-overlay button[data-act]')]
            .filter((b) => b !== btn && !b.disabled && b.dataset.act === btn.dataset.act && (b.dataset.id || '') === (btn.dataset.id || ''))
        : [];
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = `<span class="nl-spin"></span>${esc(label)}`;
    }
    twins.forEach((b) => { b.disabled = true; });
    try {
        return await fn();
    } catch (e) {
        if (e?.name !== 'AbortError') {
            console.error('[NovelLoom]', e);
            await alertDialog(`${errorText(e)}${e?.raw ? `\n\nAI 原始输出（节选）：\n${String(e.raw).slice(0, 800)}` : ''}`, '出错了');
        }
        return undefined;
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = old;
        }
        twins.forEach((b) => { b.disabled = false; });
    }
}

/**
 * 空状态：说明这里会出现什么、下一步做什么
 * @param {string} text 说明文字
 * @param {string} action 按钮等 HTML（调用方转义）
 * @param {{title?: string, ico?: string}} opt
 */
export function emptyState(text, action = '', { title = '', ico = '' } = {}) {
    return `<div class="nl-empty">${ico ? icon(ico, { size: 28 }) : ''}${title ? `<div class="nl-empty-title">${esc(title)}</div>` : ''}<div>${esc(text)}</div>${action}</div>`;
}

const ROLE_LABEL = { system: '系统', user: '用户', assistant: 'AI' };

/** 按消息链渲染提示词预览 */
export function chainPreviewHtml(settings, task, { system = '', prompt = '', book = '' } = {}) {
    const msgs = buildChainMessages(getChain(settings, task), { SYSTEM: system, PROMPT: prompt, BOOK: book, TASK: task });
    const tokens = msgs.reduce((n, m) => n + estimateTokens(m.content), 0);
    return `<div class="nl-muted nl-small">共 ${msgs.length} 条消息，约 ${tokens} tokens（消息链可在设置页修改）</div>${msgs
        .map((m) => `<h4 class="nl-role-${m.role}"><span class="nl-dot" style="background: currentColor"></span>${ROLE_LABEL[m.role] || m.role}</h4><div class="nl-pre nl-small">${esc(m.content)}</div>`)
        .join('')}`;
}
