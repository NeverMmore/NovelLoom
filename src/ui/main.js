// 主窗口外壳：导航、标签页切换、日志面板

import { app } from '../app.js';
import { listProjects } from '../store.js';
import { esc, qs, qsa } from './common.js';
import { projectTab } from './tab-project.js';
import { chunksTab } from './tab-chunks.js';
import { extractTab } from './tab-extract.js';
import { charactersTab } from './tab-characters.js';
import { worldbookTab } from './tab-worldbook.js';
import { outlineTab } from './tab-outline.js';
import { styleTab } from './tab-style.js';
import { relationsTab } from './tab-relations.js';
import { cardsTab } from './tab-cards.js';
import { continueTab } from './tab-continue.js';
import { planTab } from './tab-plan.js';
import { foreshadowTab } from './tab-foreshadow.js';
import { settingsTab } from './tab-settings.js';
import { VERSION } from '../constants.js';

const TABS = [
    { id: 'project', label: '项目', icon: '📚', mod: projectTab, needProject: false },
    { id: 'chunks', label: '分段', icon: '✂️', mod: chunksTab, needProject: true },
    { id: 'extract', label: '提取', icon: '⚙️', mod: extractTab, needProject: true },
    { id: 'characters', label: '角色', icon: '👤', mod: charactersTab, needProject: true },
    { id: 'relations', label: '关系', icon: '🔗', mod: relationsTab, needProject: true },
    { id: 'worldbook', label: '世界书', icon: '📖', mod: worldbookTab, needProject: true },
    { id: 'outline', label: '大纲', icon: '🧭', mod: outlineTab, needProject: true },
    { id: 'style', label: '文风', icon: '🎨', mod: styleTab, needProject: true },
    { id: 'cards', label: '角色卡', icon: '🎴', mod: cardsTab, needProject: true },
    { id: 'plan', label: '写大纲', icon: '📝', mod: planTab, needProject: true },
    { id: 'foreshadow', label: '伏笔看板', icon: '🧩', mod: foreshadowTab, needProject: true },
    { id: 'continue', label: '续写', icon: '✍️', mod: continueTab, needProject: false },
    { id: 'settings', label: '设置', icon: '🔧', mod: settingsTab, needProject: false },
];

let root = null;
let current = null;
let currentTabId = 'project';
let unsubs = [];

export function isOpen() {
    return !!root;
}

export async function openMain(tabId) {
    await app.init();
    if (root) {
        if (tabId) switchTab(tabId);
        return;
    }
    root = document.createElement('div');
    root.id = 'nl-root';
    root.className = 'nl-root';
    root.innerHTML = `
        <div class="nl-window" role="dialog" aria-label="NovelLoom">
            <header class="nl-header">
                <div class="nl-brand">🧵 NovelLoom <small>小说织卡 v${VERSION}</small></div>
                <div class="nl-header-project">
                    <select class="nl-input nl-project-select" title="切换项目"></select>
                </div>
                <div class="nl-header-status" id="nl-busy"></div>
                <button class="nl-icon-btn" data-act="minimize" title="最小化（任务继续运行）">—</button>
                <button class="nl-icon-btn" data-act="close" title="关闭">✕</button>
            </header>
            <div class="nl-body">
                <nav class="nl-nav">${TABS.map((t) => `<button class="nl-nav-btn" data-tab="${t.id}"><span>${t.icon}</span><em>${t.label}</em></button>`).join('')}</nav>
                <main class="nl-main"><div class="nl-tab" id="nl-tab"></div></main>
            </div>
            <footer class="nl-logbar">
                <div class="nl-logbar-head">
                    <b>日志</b><span class="nl-log-last"></span>
                    <span class="nl-spacer"></span>
                    <button class="nl-btn nl-sm" data-act="log-clear">清空</button>
                    <button class="nl-btn nl-sm" data-act="log-toggle">展开</button>
                </div>
                <div class="nl-log" hidden></div>
            </footer>
        </div>`;
    document.body.appendChild(root);

    root.addEventListener('click', onRootClick);
    qs(root, '.nl-project-select').addEventListener('change', onProjectSelect);
    unsubs.push(app.events.on('log', appendLog));
    unsubs.push(app.events.on('project', () => {
        refreshProjectSelect();
        switchTab(currentTabId, true);
    }));
    const busyTick = setInterval(updateBusy, 1000);
    unsubs.push(() => clearInterval(busyTick));
    for (const l of app.logs.slice(-200)) appendLog(l);
    await refreshProjectSelect();
    switchTab(tabId || app.settings.ui.lastTab || 'project', true);
    document.addEventListener('keydown', onKey, true);
}

export function closeMain() {
    if (!root) return;
    try {
        current?.destroy?.();
    } catch (e) {
        console.warn(e);
    }
    current = null;
    for (const u of unsubs) u();
    unsubs = [];
    document.removeEventListener('keydown', onKey, true);
    root.remove();
    root = null;
    app.saveNow();
}

function onKey(e) {
    if (e.key === 'Escape' && root && !document.querySelector('.nl-dialog-overlay')) {
        e.stopPropagation();
        minimize();
    }
}

function minimize() {
    if (!root) return;
    root.classList.add('nl-hidden');
    showFloatingButton();
}

function showFloatingButton() {
    let fab = document.getElementById('nl-fab');
    if (!fab) {
        fab = document.createElement('button');
        fab.id = 'nl-fab';
        fab.className = 'nl-fab';
        fab.title = '打开 NovelLoom';
        fab.textContent = '🧵';
        fab.addEventListener('click', () => {
            fab.remove();
            if (root) root.classList.remove('nl-hidden');
            else openMain();
        });
        document.body.appendChild(fab);
    }
}

async function onRootClick(e) {
    const btn = e.target.closest('[data-act], [data-tab]');
    if (!btn || !root.contains(btn)) return;
    if (btn.dataset.tab && btn.classList.contains('nl-nav-btn')) {
        switchTab(btn.dataset.tab);
        return;
    }
    switch (btn.dataset.act) {
        case 'close':
            if (app.isBusy()) {
                minimize();
                app.log('任务仍在运行，窗口已最小化（右下角 🧵 可重新打开）');
            } else {
                closeMain();
            }
            break;
        case 'minimize':
            minimize();
            break;
        case 'log-toggle': {
            const log = qs(root, '.nl-log');
            log.hidden = !log.hidden;
            btn.textContent = log.hidden ? '展开' : '收起';
            if (!log.hidden) log.scrollTop = log.scrollHeight;
            break;
        }
        case 'log-clear':
            app.logs.length = 0;
            qs(root, '.nl-log').innerHTML = '';
            qs(root, '.nl-log-last').textContent = '';
            break;
        default:
            break;
    }
}

async function refreshProjectSelect() {
    if (!root) return;
    const sel = qs(root, '.nl-project-select');
    const list = await listProjects();
    sel.innerHTML = `<option value="">（未打开项目）</option>${list.map((p) => `<option value="${esc(p.id)}" ${p.id === app.project?.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}`;
}

async function onProjectSelect(e) {
    const id = e.target.value;
    if (app.isBusy()) {
        app.log('有任务正在运行，不能切换项目', 'warn');
        e.target.value = app.project?.id || '';
        return;
    }
    if (!id) await app.closeProject();
    else await app.openProject(id);
}

export function switchTab(id, force = false) {
    if (!root) return;
    const tab = TABS.find((t) => t.id === id) || TABS[0];
    if (!force && tab.id === currentTabId && current) return;
    try {
        current?.destroy?.();
    } catch (e) {
        console.warn(e);
    }
    currentTabId = tab.id;
    app.settings.ui.lastTab = tab.id;
    app.saveSettings();
    qsa(root, '.nl-nav-btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab.id));
    qsa(root, '.nl-nav-btn').forEach((b) => {
        const t = TABS.find((x) => x.id === b.dataset.tab);
        b.classList.toggle('nl-disabled', t.needProject && !app.project);
    });
    // 每次挂载使用全新的容器：旧标签页的事件监听与迟到的异步渲染都落在已脱离的节点上，互不干扰
    const holder = qs(root, '#nl-tab');
    const el = document.createElement('div');
    el.className = 'nl-tab-body';
    el.dataset.tab = tab.id;
    holder.replaceChildren(el);
    qs(root, '.nl-main').scrollTop = 0;
    if (tab.needProject && !app.project) {
        el.innerHTML = `<div class="nl-empty">请先在「项目」页导入小说或打开一个项目。<br><button class="nl-btn nl-primary" data-goto="project">去项目页</button></div>`;
        el.querySelector('[data-goto]').addEventListener('click', () => switchTab('project'));
        current = null;
        return;
    }
    current = tab.mod.mount(el, { switchTab }) || null;
}

function appendLog(item) {
    if (!root) return;
    const log = qs(root, '.nl-log');
    const d = new Date(item.t);
    const time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
    const line = document.createElement('div');
    line.className = `nl-log-line nl-log-${item.level}`;
    line.textContent = `[${time}] ${item.message}`;
    log.appendChild(line);
    while (log.childElementCount > 400) log.firstElementChild.remove();
    if (!log.hidden) log.scrollTop = log.scrollHeight;
    qs(root, '.nl-log-last').textContent = item.message;
    qs(root, '.nl-log-last').className = `nl-log-last nl-log-${item.level}`;
}

function updateBusy() {
    if (!root) return;
    const parts = [];
    if (app.extraction?.running) parts.push('提取中');
    if (app.continuation?.running) parts.push('续写中');
    if (app.chatgen?.running) parts.push('挂机中');
    const el = qs(root, '#nl-busy');
    el.innerHTML = parts.length ? `<span class="nl-spin"></span>${parts.join(' · ')}` : '';
    const fab = document.getElementById('nl-fab');
    if (fab) fab.classList.toggle('nl-fab-busy', parts.length > 0);
}
