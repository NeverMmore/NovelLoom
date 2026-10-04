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
import { icon } from './icons.js';
import { pipelineState } from './pipeline.js';
import { VERSION } from '../constants.js';

/** 页面：按流程阶段分组；desc 显示在页面标题下，告诉新手这一页做什么 */
const TABS = [
    { id: 'project', group: '概览', label: '项目', icon: 'overview', mod: projectTab, needProject: false, desc: '导入小说、切换项目，查看整条流程进行到哪一步。' },
    { id: 'chunks', group: '准备', label: '分段', icon: 'chunks', mod: chunksTab, needProject: true, desc: '检查自动分段的结果：合并、拆分、分卷，或直接改原文。' },
    { id: 'extract', group: '准备', label: '提取', icon: 'extract', mod: extractTab, needProject: true, desc: '逐段让 AI 提取章节概要、角色档案、世界书条目和文风。' },
    { id: 'characters', group: '整理', label: '角色', icon: 'characters', mod: charactersTab, needProject: true, desc: '校对角色档案、合并别名，锁定不想被后续提取覆盖的字段。' },
    { id: 'relations', group: '整理', label: '关系', icon: 'relations', mod: relationsTab, needProject: true, desc: '梳理角色之间已经确立的关系，供角色卡的「相关角色」使用。' },
    { id: 'worldbook', group: '整理', label: '世界书', icon: 'worldbook', mod: worldbookTab, needProject: true, desc: '编辑条目、查找替换、回退快照，一键写入酒馆。' },
    { id: 'outline', group: '整理', label: '大纲', icon: 'outline', mod: outlineTab, needProject: true, desc: '故事梗概、分卷梗概和每一章的概要。' },
    { id: 'style', group: '整理', label: '文风', icon: 'style', mod: styleTab, needProject: true, desc: '原著文风、范文与禁用词；按任务或视角角色选择文风。' },
    { id: 'cards', group: '生成', label: '角色卡', icon: 'cards', mod: cardsTab, needProject: true, desc: '生成角色卡和群聊场景卡，审稿、试聊后写入酒馆。' },
    { id: 'plan', group: '续写', label: '写大纲', icon: 'plan', mod: planTab, needProject: true, desc: '按你的要求规划接下来的章节，续写时逐章使用。' },
    { id: 'foreshadow', group: '续写', label: '伏笔看板', icon: 'foreshadow', mod: foreshadowTab, needProject: true, desc: '汇总全书伏笔，追踪哪些埋下了、哪些已经回收。' },
    { id: 'continue', group: '续写', label: '续写', icon: 'continue', mod: continueTab, needProject: false, desc: '按大纲逐章续写并回灌资料库，或在当前聊天里挂机续写。' },
    { id: 'settings', group: '', label: '设置', icon: 'settings', mod: settingsTab, needProject: false, desc: 'API 连接、提示词、消息链与防截断。' },
];

/** 侧栏各页右侧的数字：这一步做了多少 */
function navCount(id, p) {
    if (!p) return '';
    switch (id) {
        case 'chunks': return p.chunks.length || '';
        case 'extract': {
            const done = p.chunks.filter((c) => c.status === 'done').length;
            return p.chunks.length ? `${done}/${p.chunks.length}` : '';
        }
        case 'characters': return Object.keys(p.characters || {}).length || '';
        case 'relations': return (p.relationships || []).length || '';
        case 'worldbook': return Object.values(p.worldbook || {}).reduce((n, cat) => n + Object.keys(cat || {}).length, 0) || '';
        case 'outline': return p.chunks.reduce((n, c) => n + (c.outline?.length || 0), 0) || '';
        case 'cards': return ((p.cards || []).length + (p.groupCards || []).length) || '';
        case 'plan': return (p.plan?.chapters || []).filter((c) => c.status !== 'written').length || '';
        case 'foreshadow': return (p.foreshadow || []).filter((f) => f.status !== 'resolved').length || '';
        case 'continue': return (p.continuation?.chapters || []).length || '';
        default: return '';
    }
}

function navButton(t) {
    return `<button class="nl-nav-btn" data-tab="${t.id}" title="${esc(t.desc)}">${icon(t.icon)}<em>${t.label}</em><span class="nl-nav-count" data-count="${t.id}"></span></button>`;
}

function navHtml() {
    const groups = [];
    for (const t of TABS.filter((x) => x.group)) {
        let g = groups.find((x) => x.name === t.group);
        if (!g) groups.push((g = { name: t.group, tabs: [] }));
        g.tabs.push(t);
    }
    return groups.map((g) => `
        <div class="nl-nav-group" role="group" aria-label="${g.name}">
            ${g.name === '概览' ? '' : `<div class="nl-nav-label">${g.name}</div>`}
            ${g.tabs.map(navButton).join('')}
        </div>`).join('');
}

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
    const settings = TABS.find((t) => t.id === 'settings');
    root.innerHTML = `
        <div class="nl-window" role="dialog" aria-label="NovelLoom 小说织卡">
            <aside class="nl-sidebar">
                <div class="nl-side-head">
                    <div class="nl-brand" title="NovelLoom 小说织卡 v${VERSION}">${icon('spool', { size: 18 })}NovelLoom<small>v${VERSION}</small></div>
                    <select class="nl-input nl-project-select" title="切换项目" aria-label="当前项目"></select>
                </div>
                <nav class="nl-nav" aria-label="流程">${navHtml()}</nav>
                <div class="nl-side-foot">${navButton(settings)}</div>
            </aside>
            <div class="nl-body">
                <header class="nl-header">
                    <div class="nl-page-title"><h2 id="nl-page-title"></h2><p id="nl-page-desc"></p></div>
                    <div class="nl-page-actions" id="nl-page-actions"></div>
                    <div class="nl-window-actions">
                        <button class="nl-icon-btn" data-act="minimize" title="最小化（任务继续运行）" aria-label="最小化">${icon('minimize')}</button>
                        <button class="nl-icon-btn" data-act="close" title="关闭" aria-label="关闭">${icon('close')}</button>
                    </div>
                </header>
                <main class="nl-main"><div class="nl-tab" id="nl-tab"></div></main>
                <footer class="nl-logbar">
                    <div class="nl-logbar-head">
                        <b>${icon('log', { size: 14 })}日志</b>
                        <span class="nl-header-status" id="nl-busy" role="status"></span>
                        <span class="nl-log-last" role="status"></span>
                        <button class="nl-btn nl-sm nl-ghost" data-act="log-clear">清空</button>
                        <button class="nl-btn nl-sm nl-ghost" data-act="log-toggle" aria-expanded="false">展开</button>
                    </div>
                    <div class="nl-log" hidden></div>
                </footer>
            </div>
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
        fab.setAttribute('aria-label', '打开 NovelLoom');
        fab.innerHTML = icon('spool', { size: 20 });
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
            btn.setAttribute('aria-expanded', String(!log.hidden));
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
    qsa(root, '.nl-nav-btn').forEach((b) => {
        const on = b.dataset.tab === tab.id;
        b.classList.toggle('active', on);
        if (on) b.setAttribute('aria-current', 'page');
        else b.removeAttribute('aria-current');
    });
    setActions('');
    qs(root, '#nl-page-title').textContent = tab.label;
    qs(root, '#nl-page-desc').textContent = tab.desc;
    updateNav();
    // 每次挂载使用全新的容器：旧标签页的事件监听与迟到的异步渲染都落在已脱离的节点上，互不干扰
    const holder = qs(root, '#nl-tab');
    const el = document.createElement('div');
    el.className = 'nl-tab-body';
    el.dataset.tab = tab.id;
    holder.replaceChildren(el);
    qs(root, '.nl-main').scrollTop = 0;
    if (tab.needProject && !app.project) {
        el.innerHTML = `<div class="nl-empty">${icon(tab.icon, { size: 28 })}<div class="nl-empty-title">还没有打开项目</div><div>「${esc(tab.label)}」要用到一本已导入的小说。先在「项目」页导入 TXT，或打开已有项目。</div><button class="nl-btn nl-primary" data-goto="project">去项目页</button></div>`;
        el.querySelector('[data-goto]').addEventListener('click', () => switchTab('project'));
        current = null;
        return;
    }
    current = tab.mod.mount(el, { switchTab, setActions }) || null;
}

/**
 * 页面级操作放进页面标题栏右侧。页面在每次渲染时调用 setActions(html, onClick)：
 * onClick 就是页面自己处理 data-act 的那个函数，按钮在标题栏里点击时同样交给它处理。
 */
function setActions(html = '', onClick = null) {
    if (!root) return;
    const slot = qs(root, '#nl-page-actions');
    slot.innerHTML = html;
    slot.onclick = onClick ? (e) => {
        if (e.target.closest('[data-act], [data-goto]')) onClick(e);
    } : null;
}

/** 日志行：去掉消息开头的表情符号，改用绘制的级别图标（原始消息仍保存在 app.logs 里） */
const LOG_ICON = { success: 'check', warn: 'alert', error: 'alert' };
function logHtml(item, withTime) {
    const msg = String(item.message ?? '').replace(/^(?:\p{Extended_Pictographic}|️|‍|\s)+/u, '');
    const ico = LOG_ICON[item.level] ? icon(LOG_ICON[item.level], { size: 12, cls: 'nl-log-ico' }) : '';
    if (!withTime) return `${ico}${esc(msg)}`;
    const d = new Date(item.t);
    const time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
    return `<span class="nl-log-time">${time}</span>${ico}${esc(msg)}`;
}

function appendLog(item) {
    if (!root) return;
    const log = qs(root, '.nl-log');
    const d = new Date(item.t);
    const time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
    const line = document.createElement('div');
    line.className = `nl-log-line nl-log-${item.level}`;
    line.innerHTML = logHtml(item, true);
    line.title = `[${time}] ${item.message}`;
    log.appendChild(line);
    while (log.childElementCount > 400) log.firstElementChild.remove();
    if (!log.hidden) log.scrollTop = log.scrollHeight;
    qs(root, '.nl-log-last').innerHTML = logHtml(item, false);
    qs(root, '.nl-log-last').className = `nl-log-last nl-log-${item.level}`;
}

/** 侧栏：可用状态、各步的数量、完成 / 下一步标记、正在运行的任务（与项目页流程清单同一套判断） */
function updateNav() {
    if (!root) return;
    const p = app.project;
    const running = { extract: !!app.extraction?.running, continue: !!(app.continuation?.running || app.chatgen?.running) };
    const { steps, next } = pipelineState(p);
    for (const b of qsa(root, '.nl-nav-btn')) {
        const t = TABS.find((x) => x.id === b.dataset.tab);
        const step = steps.find((s) => s.tab === t.id);
        const isNext = !!next && next.tab === t.id;
        b.classList.toggle('nl-disabled', t.needProject && !p);
        b.classList.toggle('nl-running', !!running[t.id]);
        b.classList.toggle('nl-done', !!step?.ok);
        b.classList.toggle('nl-next', isNext);
        const cnt = qs(b, '.nl-nav-count');
        if (!cnt) continue;
        let html = running[t.id] ? '<span class="nl-spin" aria-label="运行中"></span>' : esc(String(navCount(t.id, p)));
        if (!running[t.id] && isNext) html = `<span class="nl-nav-next">下一步</span>${html}`;
        else if (!running[t.id] && step?.ok) html = `${html}${icon('check', { size: 12, cls: 'nl-nav-done', label: '已完成' })}`;
        if (cnt.innerHTML !== html) cnt.innerHTML = html;
    }
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
    updateNav();
}
