// UI 公共工具：对话框、设置绑定、格式化

import { escapeHtml, estimateTokens } from '../utils.js';
import { buildChainMessages, getChain } from '../llm.js';

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
            <div class="nl-dialog ${wide ? 'nl-dialog-wide' : ''}" role="dialog" aria-modal="true">
                <div class="nl-dialog-head"><b>${esc(title)}</b><button class="nl-icon-btn" data-close title="关闭">✕</button></div>
                <div class="nl-dialog-body"></div>
                <div class="nl-dialog-foot">${buttons.map((b, i) => `<button class="nl-btn ${b.primary ? 'nl-primary' : ''} ${b.danger ? 'nl-danger' : ''}" data-i="${i}">${esc(b.label)}</button>`).join('')}</div>
            </div>`;
        const bodyEl = overlay.querySelector('.nl-dialog-body');
        if (typeof body === 'string') bodyEl.innerHTML = body;
        else if (body) bodyEl.appendChild(body);
        const close = (value) => {
            overlay.remove();
            document.removeEventListener('keydown', onKey, true);
            resolve({ value, root: bodyEl });
        };
        const onKey = (e) => {
            if (e.key === 'Escape') {
                e.stopPropagation();
                close(dismissValue);
            }
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
        const first = bodyEl.querySelector('input, textarea, select');
        first?.focus();
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
                if (e.key === 'Enter') close('ok');
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
    return { pending: '⏳', processing: '🔄', done: '✅', error: '❗' }[status] || '·';
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
 * 统一的“重roll”按钮：所有 AI 生成内容旁用于就地重新生成的按钮，统一用 🎲 图标 + nl-reroll 标记类，方便一眼认出。
 * 具体的重新生成逻辑仍由调用方在各自的 onClick（data-act）里实现，这里只统一外观。
 * @param {string} act data-act 值
 * @param {string} attrs 额外拼进标签的属性字符串（例如 `data-id="${esc(c.id)}"`），调用方自行转义
 * @param {{label?:string, title?:string}} opt label 留空则只显示图标（适合紧凑的行内位置）
 */
export function rerollBtn(act, attrs = '', { label = '', title = '重新生成' } = {}) {
    if (!label) return `<button class="nl-icon-btn nl-reroll" data-act="${esc(act)}" ${attrs} title="${esc(title)}">🎲</button>`;
    return `<button class="nl-btn nl-sm nl-reroll" data-act="${esc(act)}" ${attrs} title="${esc(title)}">🎲 ${esc(label)}</button>`;
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
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = `<span class="nl-spin"></span>${esc(label)}`;
    }
    try {
        return await fn();
    } catch (e) {
        if (e?.name !== 'AbortError') {
            console.error('[NovelLoom]', e);
            await alertDialog(`${e.message || e}${e.raw ? `\n\nAI 原始输出（节选）：\n${String(e.raw).slice(0, 800)}` : ''}`, '出错了');
        }
        return undefined;
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = old;
        }
    }
}

export function emptyState(text, action = '') {
    return `<div class="nl-empty">${esc(text)}${action}</div>`;
}

const ROLE_LABEL = { system: '🔷 系统', user: '🟢 用户', assistant: '🟡 AI' };

/** 按消息链渲染提示词预览 */
export function chainPreviewHtml(settings, task, { system = '', prompt = '', book = '' } = {}) {
    const msgs = buildChainMessages(getChain(settings, task), { SYSTEM: system, PROMPT: prompt, BOOK: book, TASK: task });
    const tokens = msgs.reduce((n, m) => n + estimateTokens(m.content), 0);
    return `<div class="nl-muted nl-small">共 ${msgs.length} 条消息，约 ${tokens} tokens（消息链可在设置页修改）</div>${msgs
        .map((m) => `<h4 class="nl-role-${m.role}">${ROLE_LABEL[m.role] || m.role}</h4><div class="nl-pre nl-small">${esc(m.content)}</div>`)
        .join('')}`;
}
