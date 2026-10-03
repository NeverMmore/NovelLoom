// NovelLoom 小说织卡 —— SillyTavern UI 扩展入口
// 导入 TXT 小说 → 分段提取大纲/角色/世界书 → 生成角色卡并写入酒馆；可选 AI 续写并回灌资料库

import { app } from './src/app.js';
import { VERSION } from './src/constants.js';
import { closeMain, openMain } from './src/ui/main.js';
import { openLiveDeduceDialog } from './src/ui/livededuce-dialog.js';

const SETTINGS_ID = 'nl-settings-panel';
const WAND_ID = 'nl-wand-button';
const WAND_DEDUCE_ID = 'nl-wand-deduce-button';

function ctx() {
    return globalThis.SillyTavern?.getContext?.();
}

function addSettingsPanel() {
    if (document.getElementById(SETTINGS_ID)) return;
    const host = document.getElementById('extensions_settings2') || document.getElementById('extensions_settings');
    if (!host) return;
    const wrap = document.createElement('div');
    wrap.id = SETTINGS_ID;
    wrap.innerHTML = `
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>🧵 NovelLoom 小说织卡</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <div class="nl-mini">
                    <div class="nl-mini-text">导入小说，自动生成角色卡与世界书，可选续写。v${VERSION}</div>
                    <div class="nl-mini-status" id="nl-mini-status"></div>
                    <div class="flex-container">
                        <div class="menu_button" data-nl-open="project">打开主界面</div>
                        <div class="menu_button" data-nl-open="cards">角色卡</div>
                        <div class="menu_button" data-nl-open="continue">续写</div>
                    </div>
                </div>
            </div>
        </div>`;
    wrap.addEventListener('click', (e) => {
        const b = e.target.closest('[data-nl-open]');
        if (b) openMain(b.dataset.nlOpen);
    });
    host.appendChild(wrap);
}

function addWandButton() {
    if (document.getElementById(WAND_ID)) return;
    const menu = document.getElementById('extensionsMenu');
    if (!menu) return;
    const item = document.createElement('div');
    item.id = WAND_ID;
    item.className = 'list-group-item flex-container flexGap5 interactable';
    item.tabIndex = 0;
    item.innerHTML = '<div class="fa-solid fa-book-open-reader extensionsMenuExtensionButton"></div><span>小说织卡</span>';
    item.addEventListener('click', () => openMain());
    menu.appendChild(item);
}

function addWandDeduceButton() {
    if (document.getElementById(WAND_DEDUCE_ID)) return;
    const menu = document.getElementById('extensionsMenu');
    if (!menu) return;
    const item = document.createElement('div');
    item.id = WAND_DEDUCE_ID;
    item.className = 'list-group-item flex-container flexGap5 interactable';
    item.tabIndex = 0;
    item.innerHTML = '<div class="fa-solid fa-route extensionsMenuExtensionButton"></div><span>推演当前对话</span>';
    item.addEventListener('click', () => openLiveDeduceDialog());
    menu.appendChild(item);
}

function registerSlashCommand() {
    const c = ctx();
    try {
        if (c?.SlashCommandParser?.addCommandObject && c?.SlashCommand?.fromProps) {
            c.SlashCommandParser.addCommandObject(c.SlashCommand.fromProps({
                name: 'novelloom',
                aliases: ['小说织卡'],
                helpString: '打开 NovelLoom 小说织卡。可带参数：project / chunks / extract / characters / relations / worldbook / outline / style / cards / plan / continue / settings',
                callback: async (_args, value) => {
                    await openMain(String(value || '').trim() || undefined);
                    return '';
                },
            }));
        }
    } catch (e) {
        console.warn('[NovelLoom] 注册斜杠命令失败', e);
    }
}

function updateMiniStatus() {
    const el = document.getElementById('nl-mini-status');
    if (!el) return;
    const bits = [];
    if (app.project) bits.push(`当前项目：${app.project.name}`);
    if (app.extraction?.running) bits.push('提取中');
    if (app.continuation?.running) bits.push('续写中');
    if (app.chatgen?.running) bits.push(`挂机中 ${app.settings.chatgen.currentChapter}/${app.settings.chatgen.totalChapters}`);
    el.textContent = bits.join(' · ');
}

async function init() {
    if (!ctx()) {
        console.error('[NovelLoom] 找不到 SillyTavern.getContext，插件未启动');
        return;
    }
    addSettingsPanel();
    addWandButton();
    addWandDeduceButton();
    registerSlashCommand();
    try {
        await app.init();
    } catch (e) {
        console.error('[NovelLoom] 初始化失败', e);
    }
    app.events.on('project', updateMiniStatus);
    app.events.on('extract:progress', updateMiniStatus);
    app.events.on('continue:progress', updateMiniStatus);
    app.events.on('chatgen:progress', updateMiniStatus);
    updateMiniStatus();
    // 暴露调试入口
    globalThis.NovelLoom = { app, open: openMain, close: closeMain, version: VERSION };
    console.log(`[NovelLoom] v${VERSION} 已加载`);
}

if (globalThis.jQuery) globalThis.jQuery(init);
else if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
