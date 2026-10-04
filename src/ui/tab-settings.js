// 设置页：API、分类、默认条目、状态栏（MVU 变量）与状态栏模板库、提示词模板、配置导入导出

import { app } from '../app.js';
import { DEFAULT_ANTI_TRUNCATE, DEFAULT_CATEGORIES, DEFAULT_STATUS_BAR, WI_POSITIONS } from '../constants.js';
import { applyConfig, exportConfig } from '../io.js';
import { API_MODES, CHAIN_TASKS, DEEPSEEK_DEFAULT_ENDPOINT, DEEPSEEK_MODELS, DEFAULT_CHAIN, GEMINI_SAFETY_OPTIONS, listModels, testApi } from '../llm.js';
import { DEFAULT_PROMPTS, PROMPT_LABELS, PROMPT_PLACEHOLDERS } from '../prompts.js';
import { countSpecLeaves, specSummaryText } from '../statusbar.js';
import { STATUSBAR_THEMES, buildPreviewSrcdoc } from '../statusbar-runtime.js';
import {
    STATUS_TEMPLATE_MODE_LABELS, STATUS_TEMPLATE_NAME_MAX, duplicateStatusBarTemplate, exportStatusBarTemplate, getStatusBarTemplate,
    importStatusBarTemplate, listStatusBarTemplates, removeStatusBarTemplate, statusBarTemplateFileName, templatePreviewCard,
    updateStatusBarTemplate,
} from '../statusbar-templates.js';
import { downloadFile, pickFile, readFileAsText, structuredCloneSafe } from '../utils.js';
import { alertDialog, bindSettings, busy, chainPreviewHtml, confirmDialog, emptyState, esc, icon, openDialog, optionList, qs } from './common.js';
import { templateNameProblem, varCountText } from './statusbar-dialog.js';

const DIRECT_MODES = ['openai', 'deepseek', 'gemini', 'anthropic'];

function apiSection(key, title) {
    const a = app.settings[key];
    const profiles = globalThis.SillyTavern?.getContext?.()?.extensionSettings?.connectionManager?.profiles || [];
    return `
    <section class="nl-card" data-api="${key}">
        <div class="nl-card-head"><div><h3>${title}</h3></div></div>
        ${key === 'continueApi' ? '<div class="nl-row nl-checks"><label><input type="checkbox" data-setting="continueApi.enabled"> 启用（不勾选时续写沿用主 API）</label></div>' : ''}
        <div class="nl-field"><label>接口类型</label><select class="nl-input" data-setting="${key}.mode">${optionList(API_MODES)}</select></div>
        <div class="nl-api-mode" data-mode="tavern" ${a.mode === 'tavern' ? '' : 'hidden'}>
            <div class="nl-muted nl-small">使用酒馆当前选中的 API 与模型（generateRaw，不带聊天预设）。回复长度沿用酒馆里的“最大回复长度”，提取与写卡建议调到 4000 以上。停止任务会同时停止酒馆里正在进行的生成；并行较多时推荐改用连接配置档。</div>
        </div>
        <div class="nl-api-mode" data-mode="profile" ${a.mode === 'profile' ? '' : 'hidden'}>
            <div class="nl-field"><label>连接配置档（在酒馆「连接配置档」扩展中创建）</label>
                <select class="nl-input" data-setting="${key}.profileId"><option value="">（请选择）</option>${profiles.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}${p.model ? `（${esc(p.model)}）` : ''}</option>`).join('')}</select></div>
            <div class="nl-row nl-checks"><label><input type="checkbox" data-setting="${key}.includePreset"> 使用配置档里的采样预设</label></div>
            <div class="nl-muted nl-small">通过酒馆后端转发，密钥由酒馆保管，不受浏览器跨域限制，可安全并行、可单独中止。推荐。</div>
        </div>
        <div class="nl-api-mode" data-mode="direct" ${DIRECT_MODES.includes(a.mode) ? '' : 'hidden'}>
            <div class="nl-grid2">
                <div class="nl-field"><label>接口地址（可留空用官方）</label><input class="nl-input" data-setting="${key}.endpoint" placeholder="${a.mode === 'deepseek' ? DEEPSEEK_DEFAULT_ENDPOINT : 'https://api.openai.com/v1'}"></div>
                <div class="nl-field"><label>API Key</label><input class="nl-input" type="password" autocomplete="off" data-setting="${key}.apiKey"></div>
                <div class="nl-field"><label>模型</label><div class="nl-row"><input class="nl-input" data-setting="${key}.model" list="nl-models-${key}"><datalist id="nl-models-${key}">${a.mode === 'deepseek' ? DEEPSEEK_MODELS.map((m) => `<option value="${esc(m.id)}">${esc(m.name)}</option>`).join('') : ''}</datalist><button class="nl-btn nl-sm" data-act="models" data-key="${key}">拉取</button></div></div>
            </div>
            <div class="nl-field" ${a.mode === 'gemini' ? '' : 'hidden'} data-gemini-only><label>Gemini 安全阈值（Gemini 官方参数，只对 Gemini 生效）</label><select class="nl-input" data-setting="${key}.geminiSafety">${optionList(GEMINI_SAFETY_OPTIONS)}</select></div>
            <div class="nl-muted nl-small">${a.mode === 'deepseek' ? 'DeepSeek 官方接口：接口地址与模型留空会自动填入官方默认值；deepseek-reasoner 返回的思考过程会自动与正文分开，不会混进卡片/JSON 等输出。密钥保存在酒馆扩展设置中。' : '浏览器直连：密钥保存在酒馆扩展设置中；部分服务商会因跨域（CORS）拒绝，此时请改用“连接配置档”。'}</div>
        </div>
        <div class="nl-grid3">
            <div class="nl-field"><label>温度</label><input class="nl-input" type="number" step="0.05" min="0" max="2" data-setting="${key}.temperature"></div>
            <div class="nl-field"><label>最大输出 tokens</label><input class="nl-input" type="number" step="500" min="500" data-setting="${key}.maxTokens"></div>
            <div class="nl-field"><label>单次超时（秒）</label><input class="nl-input" type="number" min="30" data-setting="${key}.timeoutSec"></div>
            <div class="nl-field"><label>失败重试次数</label><input class="nl-input" type="number" min="0" max="6" data-setting="${key}.retries"></div>
            <div class="nl-field"><label>重试基础间隔（毫秒）</label><input class="nl-input" type="number" min="500" step="500" data-setting="${key}.retryBaseMs"></div>
        </div>
        <div class="nl-row"><button class="nl-btn" data-act="test" data-key="${key}">测试连接</button><span class="nl-muted" data-test-result="${key}"></span></div>
    </section>`;
}

// ---------------- 状态栏（MVU 变量）全局选项 ----------------

const SB_HTML_MODES = [{ value: 'ai', label: 'AI 设计界面' }, { value: 'auto', label: '内置排版（不调用 AI）' }];
const SB_LANGS = [{ value: 'en', label: '英文（省 token）' }, { value: 'zh', label: '中文' }];
const SB_SHOW_MODES = [{ value: 'one', label: '只最新一层' }, { value: 'n', label: '最新 N 层' }, { value: 'all', label: '每一层' }];
const SB_KEEP_MODES = [{ value: 'none', label: '全部去掉（省 token）' }, { value: 'k', label: '保留最近 K 轮' }];
const SB_MAX_VARS = { min: 3, max: 30 };
const SB_URL_LABELS = { mvuUrl: 'MVU 脚本地址', zodUrl: '变量结构脚本（mvu_zod）地址' };

function sbConf() {
    const s = app.settings;
    if (!s.statusBar || typeof s.statusBar !== 'object') s.statusBar = { ...DEFAULT_STATUS_BAR };
    return s.statusBar;
}

/** 与导出时的检查一致（statusbar.js safeUrl）：不是 http(s) 地址就会改用默认地址 */
function sbUrlProblem(v) {
    const t = String(v ?? '').trim();
    if (!t) return '留空时导出会使用默认地址';
    return /^https?:\/\/[^\s'"`<>\\]+$/.test(t) ? '' : '不是 http(s) 地址，导出时会改用默认地址';
}

function clampInt(v, min, max, fallback) {
    const n = Math.round(Number(v));
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

function statusBarSection() {
    const sb = sbConf();
    const show = sb.showDepth === null || sb.showDepth === undefined ? 'all' : Number(sb.showDepth) >= 2 ? 'n' : 'one';
    const showN = Number(sb.showDepth) >= 2 ? Number(sb.showDepth) : 3;
    const keep = Number(sb.keepUpdateDepth) >= 1 ? 'k' : 'none';
    const keepK = Number(sb.keepUpdateDepth) >= 1 ? Number(sb.keepUpdateDepth) : 3;
    const urlField = (key) => {
        const warn = sbUrlProblem(sb[key]);
        return `
            <div class="nl-field"><label for="nl-sb-${key}">${SB_URL_LABELS[key]}</label>
                <div class="nl-row">
                    <input class="nl-input nl-grow nl-mono" id="nl-sb-${key}" data-setting="statusBar.${key}" spellcheck="false" autocomplete="off" placeholder="${esc(DEFAULT_STATUS_BAR[key])}">
                    <button class="nl-icon-btn" data-act="sb-url-reset" data-key="${key}" title="恢复默认地址" aria-label="恢复${SB_URL_LABELS[key]}的默认值">${icon('undo')}</button>
                </div>
                <div class="nl-small nl-warn" data-sb-url-warn="${key}" ${warn ? '' : 'hidden'}>${icon('alert', { size: 12 })} <span>${esc(warn)}</span></div>
            </div>`;
    };
    return `
            <section class="nl-card" data-statusbar-settings>
                <div class="nl-card-head">
                    <div>
                        <h3>状态栏（MVU 变量）</h3>
                        <div class="nl-card-desc">写卡时可以同时生成一个随剧情更新的状态栏，导出的角色卡需要酒馆助手 4.6 或更高版本。显示与发送相关的选项是新建状态栏时的默认值，已有的状态栏在角色卡的「状态栏」里单独修改；脚本地址在导出角色卡时读取，变量上限在 AI 设计变量时读取。</div>
                    </div>
                    <button class="nl-btn nl-sm" data-act="sb-templates" title="查看、导入、导出状态栏模板">${icon('file')}模板库<span class="nl-muted" data-sb-tpl-count>（${listStatusBarTemplates(app.settings).length}）</span></button>
                </div>
                <div class="nl-grid2">${urlField('mvuUrl')}${urlField('zodUrl')}</div>
                <div class="nl-grid3">
                    <div class="nl-field"><label for="nl-sb-maxVars">变量上限 <span class="nl-muted">（${SB_MAX_VARS.min}–${SB_MAX_VARS.max}，记录的每个字段各算一个）</span></label>
                        <input class="nl-input" id="nl-sb-maxVars" type="number" min="${SB_MAX_VARS.min}" max="${SB_MAX_VARS.max}" step="1" data-sb="maxVars" value="${esc(sb.maxVars ?? DEFAULT_STATUS_BAR.maxVars)}"></div>
                    <div class="nl-field"><label for="nl-sb-htmlMode">默认界面</label><select class="nl-input" id="nl-sb-htmlMode" data-setting="statusBar.htmlMode">${optionList(SB_HTML_MODES)}</select></div>
                    <div class="nl-field"><label for="nl-sb-theme">内置排版主题</label><select class="nl-input" id="nl-sb-theme" data-setting="statusBar.theme">${optionList(STATUSBAR_THEMES)}</select></div>
                    <div class="nl-field"><label for="nl-sb-lang">变量分析（Analysis）语言</label><select class="nl-input" id="nl-sb-lang" data-setting="statusBar.analysisLang">${optionList(SB_LANGS)}</select></div>
                    <div class="nl-field"><label for="nl-sb-show">状态栏显示在</label>
                        <div class="nl-row">
                            <select class="nl-input nl-grow" id="nl-sb-show" data-sb="showMode">${optionList(SB_SHOW_MODES, show)}</select>
                            <input class="nl-input nl-num" type="number" min="2" max="99" step="1" data-sb="showN" value="${showN}" title="显示在最新几层 AI 回复上" aria-label="显示在最新几层 AI 回复上" ${show === 'n' ? '' : 'hidden'}>
                        </div></div>
                    <div class="nl-field"><label for="nl-sb-keep">历史消息里的变量更新块</label>
                        <div class="nl-row">
                            <select class="nl-input nl-grow" id="nl-sb-keep" data-sb="keepMode">${optionList(SB_KEEP_MODES, keep)}</select>
                            <input class="nl-input nl-num" type="number" min="1" max="20" step="1" data-sb="keepK" value="${keepK}" title="发给 AI 时保留最近几轮回复里的变量更新块" aria-label="保留最近几轮的变量更新块" ${keep === 'k' ? '' : 'hidden'}>
                        </div></div>
                </div>
                <div class="nl-row nl-wrap nl-checks">
                    <label><input type="checkbox" data-setting="statusBar.foldUpdate"> 聊天里把变量更新块折叠起来</label>
                    <label><input type="checkbox" data-setting="statusBar.greetingTag"> 开场白也显示状态栏</label>
                    <label><input type="checkbox" data-setting="statusBar.usageNote"> 在作者备注里附上使用说明</label>
                </div>
            </section>`;
}

// ---------------- 状态栏模板库 ----------------

/** 编辑用户模板的名称与说明；返回 {name, desc}，取消时返回 null */
async function templateMetaDialog(t) {
    const { value, root } = await openDialog({
        title: '编辑模板',
        body: `
            <div class="nl-field"><label for="nl-sbt-name">名称</label><input class="nl-input" id="nl-sbt-name" maxlength="${STATUS_TEMPLATE_NAME_MAX}" value="${esc(t.name)}"></div>
            <div class="nl-field"><label for="nl-sbt-desc">说明 <span class="nl-muted">（可选）</span></label><textarea class="nl-input nl-textarea" id="nl-sbt-desc" rows="3" maxlength="200">${esc(t.desc || '')}</textarea></div>
            <div class="nl-small nl-err" data-sbt-err hidden></div>`,
        buttons: [
            { label: '取消', value: null },
            {
                label: '保存', value: 'ok', primary: true,
                validate: (b) => {
                    // 与状态栏对话框、updateStatusBarTemplate 同一口径（空白合并、不分大小写），不会通过这里却在保存时抛错
                    const msg = templateNameProblem(app.settings, b.querySelector('#nl-sbt-name').value, t.id);
                    const err = b.querySelector('[data-sbt-err]');
                    err.textContent = msg;
                    err.hidden = !msg;
                    return !msg;
                },
            },
        ],
    });
    if (value !== 'ok') return null;
    return { name: root.querySelector('#nl-sbt-name').value, desc: root.querySelector('#nl-sbt-desc').value };
}

/**
 * 删除一个模板后选中哪一个：原来位置上的下一个（删的是最后一个就选上一个）；一个都不剩返回 ''
 * @param {string[]} idsBefore 删除前列表里的 id（按显示顺序）
 * @param {string} deletedId
 * @param {string[]} idsAfter 删除后列表里的 id
 */
export function templateIdAfterDelete(idsBefore, deletedId, idsAfter) {
    if (!idsAfter.length) return '';
    const i = idsBefore.indexOf(deletedId);
    if (i < 0) return idsAfter[0];
    // 删除前排在它前面的、现在还在的个数 = 它的下一个在新列表里的位置
    const pos = idsBefore.slice(0, i).filter((id) => idsAfter.includes(id)).length;
    return idsAfter[Math.min(pos, idsAfter.length - 1)];
}

/**
 * 模板库详情里的变量数标签：与状态栏对话框同一口径（varCountText，记录的每个字段各算一个）；
 * 超过当前变量上限时另加一个警告标签（沿用结构时多出的变量会被丢弃，与对话框里的模板库一致）
 */
export function templateVarTagsHtml(t, maxVars = DEFAULT_STATUS_BAR.maxVars) {
    const n = t?.spec ? countSpecLeaves(t.spec) : 0;
    if (!n) return '<span class="nl-tag">只有界面，没有变量表</span>';
    const over = n > maxVars ? ` <span class="nl-tag nl-warn" title="沿用结构时多出的变量会被丢弃">超过上限 ${maxVars}</span>` : '';
    return `<span class="nl-tag">${esc(varCountText(t.spec))}</span>${over}`;
}

/**
 * 状态栏模板库（设置页入口）：左边列出内置与保存的模板，右边是选中模板的说明和沙箱预览（与导出到酒馆后看到的一致）。
 * 可以导入 / 导出单个模板 JSON，复制任意模板，编辑或删除自己的模板；内置模板只读。
 * 把模板套用到某张卡在角色卡的「状态栏」里进行。
 */
export async function openStatusBarTemplateLibrary() {
    const box = document.createElement('div');
    const st = globalThis.SillyTavern?.getContext?.();
    const userName = st?.name1 || '你';
    const charName = '示例角色';
    let selected = '';
    let bg = 'dark';
    let frame = null;
    const BG = { dark: 'rgb(27 28 32)', light: 'rgb(243 242 238)' };

    const detailHtml = (t) => {
        const n = t.spec ? countSpecLeaves(t.spec) : 0;
        const actions = t.builtin
            ? `<button class="nl-btn nl-sm" data-tpl-act="duplicate" title="复制成自己的模板，之后可以修改">${icon('copy', { size: 14 })}复制为我的模板</button>
               <button class="nl-btn nl-sm" data-tpl-act="export">${icon('download', { size: 14 })}导出</button>`
            : `<button class="nl-btn nl-sm" data-tpl-act="edit">${icon('edit', { size: 14 })}改名 / 说明</button>
               <button class="nl-btn nl-sm" data-tpl-act="duplicate">${icon('copy', { size: 14 })}复制</button>
               <button class="nl-btn nl-sm" data-tpl-act="export">${icon('download', { size: 14 })}导出</button>
               <button class="nl-icon-btn nl-danger" data-tpl-act="delete" title="删除模板" aria-label="删除模板「${esc(t.name)}」">${icon('trash')}</button>`;
        return `
            <div class="nl-row nl-wrap">
                <h3 class="nl-grow" style="margin:0">${esc(t.name)}</h3>
                ${actions}
            </div>
            <div class="nl-row nl-wrap" style="margin:6px 0">
                ${t.builtin ? '<span class="nl-tag">内置</span>' : ''}
                <span class="nl-tag">${esc(STATUS_TEMPLATE_MODE_LABELS[t.mode] || t.mode)}</span>
                ${templateVarTagsHtml(t, app.settings.statusBar?.maxVars || DEFAULT_STATUS_BAR.maxVars)}
            </div>
            <div class="nl-muted nl-small">${esc(t.desc || '（没有说明）')}</div>
            <div class="nl-row" style="margin:10px 0 6px">
                <span class="nl-muted nl-small nl-grow">预览（示例数据）</span>
                <div class="nl-seg" role="group" aria-label="预览背景">
                    <button class="nl-seg-btn ${bg === 'dark' ? 'active' : ''}" data-tpl-bg="dark" aria-pressed="${bg === 'dark'}">深色聊天</button>
                    <button class="nl-seg-btn ${bg === 'light' ? 'active' : ''}" data-tpl-bg="light" aria-pressed="${bg === 'light'}">浅色聊天</button>
                </div>
            </div>
            <div data-tpl-stage style="padding:12px;border:1px solid var(--nl-line);border-radius:8px;background:${BG[bg]};max-height:560px;overflow:auto"></div>
            <div class="nl-small nl-warn" data-tpl-err hidden></div>
            ${t.spec ? `<details style="margin-top:8px"><summary>变量表（${n} 个）</summary><div class="nl-pre nl-small">${esc(specSummaryText(t.spec))}</div></details>` : ''}`;
    };

    const mountPreview = (t) => {
        frame = null;
        const stage = box.querySelector('[data-tpl-stage]');
        if (!stage || !t) return;
        const f = document.createElement('iframe');
        // 沙箱里只允许脚本，不给 allow-same-origin：模板里的代码碰不到酒馆页面
        f.setAttribute('sandbox', 'allow-scripts');
        f.setAttribute('referrerpolicy', 'no-referrer');
        f.setAttribute('title', `「${t.name}」预览`);
        f.style.cssText = 'display:block;width:100%;height:180px;border:0;background:transparent';
        f.srcdoc = buildPreviewSrcdoc(templatePreviewCard(t, { charName }), t.sample || undefined, { user: userName, char: charName });
        stage.appendChild(f);
        frame = f;
    };

    const render = () => {
        const list = listStatusBarTemplates(app.settings);
        if (!list.some((t) => t.id === selected)) selected = list[0]?.id || '';
        const t = list.find((x) => x.id === selected) || null;
        box.innerHTML = `
            <div class="nl-row nl-wrap">
                <div class="nl-muted nl-small nl-grow">模板保存变量表和界面，存在扩展设置里，所有项目共用。内置模板不能修改或删除，可以复制成自己的模板。写卡时在「写卡选项」里选择模板，或在角色卡的「状态栏」里套用。</div>
                <button class="nl-btn nl-sm" data-tpl-act="import">${icon('upload', { size: 14 })}导入模板 JSON</button>
            </div>
            <div class="nl-split" style="margin-top:8px">
                <div class="nl-char-list" role="listbox" aria-label="状态栏模板">
                    ${list.map((x) => `
                    <div class="nl-char-item ${x.id === selected ? 'active' : ''}" role="option" tabindex="0" aria-selected="${x.id === selected}" data-tpl-id="${esc(x.id)}">
                        <div class="nl-row"><b class="nl-grow">${esc(x.name)}</b>${x.builtin ? '<span class="nl-tag">内置</span>' : ''}</div>
                        <div class="nl-small">${x.spec ? `${countSpecLeaves(x.spec)} 个变量` : '只有界面'} · ${esc(STATUS_TEMPLATE_MODE_LABELS[x.mode] || x.mode)}</div>
                    </div>`).join('')}
                </div>
                <div data-tpl-detail>${t ? detailHtml(t) : emptyState('导入别人分享的模板 JSON，或在角色卡的「状态栏」里点「存为模板」。', '', { title: '没有模板', ico: 'file' })}</div>
            </div>`;
        mountPreview(t);
    };

    const select = (id) => {
        selected = id;
        render();
        box.querySelector(`[data-tpl-id="${CSS.escape(id)}"]`)?.focus();
    };

    const onMessage = (e) => {
        if (!frame || e.source !== frame.contentWindow) return;
        const d = e.data || {};
        if (d.source !== 'nl-preview') return;
        if (d.type === 'nl-height') frame.style.height = `${Math.min(Math.max(60, Number(d.height) || 0), 1200)}px`;
        if (d.type === 'nl-error') {
            const err = box.querySelector('[data-tpl-err]');
            if (err && err.hidden) {
                err.textContent = `预览出错：${String(d.message || '').split('\n')[0].slice(0, 200)}`;
                err.hidden = false;
            }
        }
    };

    const onClick = async (e) => {
        const item = e.target.closest('[data-tpl-id]');
        if (item) return select(item.dataset.tplId);
        const bgBtn = e.target.closest('[data-tpl-bg]');
        if (bgBtn) {
            bg = bgBtn.dataset.tplBg;
            const stage = box.querySelector('[data-tpl-stage]');
            if (stage) stage.style.background = BG[bg];
            box.querySelectorAll('[data-tpl-bg]').forEach((b) => {
                b.classList.toggle('active', b === bgBtn);
                b.setAttribute('aria-pressed', String(b === bgBtn));
            });
            return undefined;
        }
        const btn = e.target.closest('[data-tpl-act]');
        if (!btn) return undefined;
        const t = getStatusBarTemplate(app.settings, selected);
        try {
            switch (btn.dataset.tplAct) {
                case 'import': {
                    const file = await pickFile('.json,application/json');
                    if (!file) return undefined;
                    const created = importStatusBarTemplate(app.settings, await readFileAsText(file));
                    app.saveSettings();
                    app.log(`已导入状态栏模板「${created.name}」`, 'success');
                    return select(created.id);
                }
                case 'export':
                    if (!t) return undefined;
                    downloadFile(JSON.stringify(exportStatusBarTemplate(t), null, 2), statusBarTemplateFileName(t));
                    return undefined;
                case 'duplicate': {
                    if (!t) return undefined;
                    const copy = duplicateStatusBarTemplate(app.settings, t.id);
                    app.saveSettings();
                    app.log(`已复制为「${copy.name}」`, 'success');
                    return select(copy.id);
                }
                case 'edit': {
                    if (!t || t.builtin) return undefined;
                    const r = await templateMetaDialog(t);
                    if (!r) return undefined;
                    updateStatusBarTemplate(app.settings, t.id, r);
                    app.saveSettings();
                    return select(t.id);
                }
                case 'delete': {
                    if (!t || t.builtin) return undefined;
                    if (!(await confirmDialog(`删除状态栏模板「${t.name}」？已经套用过它的角色卡不受影响。`, { danger: true, okLabel: '删除' }))) return undefined;
                    const idsBefore = listStatusBarTemplates(app.settings).map((x) => x.id);
                    removeStatusBarTemplate(app.settings, t.id);
                    app.saveSettings();
                    app.log(`已删除状态栏模板「${t.name}」`, 'success');
                    // 删除按钮随重绘消失，焦点会掉到 <body>：选中原位置上的下一个模板并把焦点放到它上面；列表空了就放到“导入模板 JSON”
                    const next = templateIdAfterDelete(idsBefore, t.id, listStatusBarTemplates(app.settings).map((x) => x.id));
                    if (next) return select(next);
                    selected = '';
                    render();
                    box.querySelector('[data-tpl-act="import"]')?.focus();
                    return undefined;
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
        const item = e.target.closest?.('[data-tpl-id]');
        if (!item) return;
        const items = [...box.querySelectorAll('[data-tpl-id]')];
        const i = items.indexOf(item);
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            select(item.dataset.tplId);
        } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            const next = items[i + (e.key === 'ArrowDown' ? 1 : -1)];
            if (next) select(next.dataset.tplId);
        }
    };

    box.addEventListener('click', onClick);
    box.addEventListener('keydown', onKey);
    window.addEventListener('message', onMessage);
    render();
    try {
        await openDialog({ title: '状态栏模板库', wide: true, body: box, buttons: [{ label: '关闭', value: null }] });
    } finally {
        window.removeEventListener('message', onMessage);
        frame = null;
    }
}

export const settingsTab = {
    mount(el, { setActions } = {}) {
        let promptKey = 'extract';
        let chainTask = 'default';

        const chains = () => {
            const s = app.settings;
            if (!s.messageChains || typeof s.messageChains !== 'object') s.messageChains = {};
            if (!Array.isArray(s.messageChains.default) || !s.messageChains.default.length) s.messageChains.default = structuredCloneSafe(DEFAULT_CHAIN);
            if (!Array.isArray(s.messageChains[chainTask])) s.messageChains[chainTask] = [];
            return s.messageChains;
        };

        const chainSection = () => {
            const list = chains()[chainTask];
            const own = chainTask === 'default' || list.length > 0;
            const roleOpts = [{ value: 'system', label: '系统' }, { value: 'user', label: '用户' }, { value: 'assistant', label: 'AI' }];
            const roleDot = { system: 'nl-info', user: 'nl-ok', assistant: 'nl-warn' };
            const hasPrompt = list.some((m) => m.enabled !== false && String(m.content || '').includes('{PROMPT}'));
            return `
            <section class="nl-card">
                <div class="nl-card-head">
                    <div>
                        <h3>消息链（自定义消息角色）</h3>
                        <div class="nl-card-desc">每次调用 AI 时按这里的顺序发送消息，可以设置每条消息的角色。占位符：<code>{SYSTEM}</code> 任务的系统提示、<code>{PROMPT}</code> 任务的主提示、<code>{BOOK}</code> 书名。可以加入破限/人设系统消息、示例对话，或在末尾放一条 AI 预填（如“{”）。单个任务没有自定义时沿用默认链；链里没有 {PROMPT} 时会自动把主提示追加成最后一条用户消息。酒馆当前连接接文本补全后端时，角色会被合并成纯文本。</div>
                    </div>
                </div>
                <div class="nl-row nl-wrap">
                    <select class="nl-input nl-inline" data-chain-task aria-label="要编辑消息链的任务">${optionList(CHAIN_TASKS.map((t) => ({ value: t.value, label: `${t.label}${t.value !== 'default' && chains()[t.value]?.length ? '（已自定义）' : ''}` })), chainTask)}</select>
                </div>
                ${own ? `
                <div class="nl-field"><div class="nl-chain">
                    ${list.map((m, i) => `
                    <div class="nl-chain-msg role-${esc(m.role || 'user')} ${m.enabled === false ? 'off' : ''}" data-ci="${i}">
                        <div class="nl-row nl-wrap">
                            <span class="nl-dot ${roleDot[m.role || 'user'] || ''}" aria-hidden="true"></span>
                            <select class="nl-input nl-inline" data-cf="role" aria-label="消息角色">${optionList(roleOpts, m.role || 'user')}</select>
                            <label><input type="checkbox" data-cf="enabled" ${m.enabled === false ? '' : 'checked'}> 启用</label>
                            <span class="nl-spacer"></span>
                            <button class="nl-icon-btn" data-act="chain-up" data-i="${i}" title="上移" aria-label="上移" ${i === 0 ? 'disabled' : ''}>${icon('arrowUp')}</button>
                            <button class="nl-icon-btn" data-act="chain-down" data-i="${i}" title="下移" aria-label="下移" ${i === list.length - 1 ? 'disabled' : ''}>${icon('arrowDown')}</button>
                            <button class="nl-icon-btn nl-danger" data-act="chain-del" data-i="${i}" title="删除" aria-label="删除">${icon('trash')}</button>
                        </div>
                        <textarea class="nl-input nl-textarea nl-mono" rows="${Math.min(8, Math.max(2, String(m.content || '').split('\n').length))}" data-cf="content">${esc(m.content || '')}</textarea>
                    </div>`).join('') || emptyState('用下方按钮添加系统、用户或 AI 消息。', '', { title: '消息链是空的', ico: 'message' })}
                </div></div>
                ${list.length && !hasPrompt ? `<div class="nl-warn nl-small">${icon('alert')} 链里没有 {PROMPT}，任务主提示会自动追加在最后。</div>` : ''}
                <div class="nl-row nl-wrap">
                    <button class="nl-btn nl-sm" data-act="chain-add" data-role="system">${icon('plus')}系统消息</button>
                    <button class="nl-btn nl-sm" data-act="chain-add" data-role="user">${icon('plus')}用户消息</button>
                    <button class="nl-btn nl-sm" data-act="chain-add" data-role="assistant">${icon('plus')}AI 消息 / 预填</button>
                    <span class="nl-spacer"></span>
                    <button class="nl-btn nl-sm" data-act="chain-preview">预览</button>
                    <button class="nl-btn nl-sm" data-act="chain-reset">${chainTask === 'default' ? '恢复默认' : '清除（改用默认链）'}</button>
                </div>` : `
                <div class="nl-row nl-wrap"><span class="nl-muted">这个任务目前沿用默认链。</span><button class="nl-btn nl-sm" data-act="chain-copy">以默认链为模板自定义</button></div>`}
                <div class="nl-row nl-checks"><label><input type="checkbox" data-setting="chainOptions.prependPrefill"> 链以 AI 预填结尾时，把预填内容拼回回复开头（方便解析 JSON）</label></div>
            </section>`;
        };

        const antiTruncateSection = () => `
            <section class="nl-card" data-anti-truncate>
                <div class="nl-card-head">
                    <div>
                        <h3>防截断</h3>
                        <div class="nl-card-desc">回复写到一半断掉，通常有三种原因，插件分别处理：
                            <br>① <b>长度用完</b>（最常见）：检测到截断后自动让 AI 从断点接着写，再把内容拼好。直连接口按服务商返回的结束原因判断；酒馆当前连接和连接配置档拿不到结束原因，改为检查正文是否停在半句、JSON 是否没有闭合。酒馆当前连接的回复长度取酒馆里的“最大回复长度”，写长章节时建议调大。
                            <br>② <b>服务商内容过滤</b>（如 Gemini 的 SAFETY、OpenAI 的 content_filter）：单独识别并提示，不当作长度截断反复接续。Gemini 可在上方接口设置里调整安全阈值。
                            <br>③ <b>模型拒绝</b>：识别后直接提示，不做无效重试。</div>
                    </div>
                </div>
                <div class="nl-row nl-wrap nl-checks">
                    <label><input type="checkbox" data-setting="antiTruncate.enabled"> 截断时自动接续</label>
                    <label><input type="checkbox" data-setting="antiTruncate.detectRefusal"> 识别模型拒绝与服务商过滤，并给出明确提示</label>
                </div>
                <div class="nl-grid3">
                    <div class="nl-field"><label>每次最多接续</label><input class="nl-input" type="number" min="1" max="10" data-setting="antiTruncate.maxContinues"></div>
                    <div class="nl-field"><label>接续方式</label><select class="nl-input" data-setting="antiTruncate.style">${optionList([
                        { value: 'auto', label: '自动（Claude 直连用预填，其余用追问）' },
                        { value: 'prefill', label: '预填：把已写内容作为 AI 消息，让模型直接接着写' },
                        { value: 'ask', label: '追问：再发一条“从断点继续”的消息' },
                    ])}</select></div>
                </div>
                <div class="nl-field"><label>接续提示（追问方式使用；{TAIL} = 中断处的最后 30 字）</label>
                    <textarea class="nl-input nl-textarea" rows="3" data-setting="antiTruncate.prompt"></textarea></div>
                <div class="nl-row"><span class="nl-spacer"></span><button class="nl-btn nl-sm" data-act="anti-reset">恢复默认</button></div>
            </section>`;

        const render = () => {
            const s = app.settings;
            el.innerHTML = `
            ${apiSection('api', 'AI 接口（提取 / 写卡 / 整理）')}
            ${apiSection('continueApi', '续写专用接口（可选）')}
            ${antiTruncateSection()}
            ${chainSection()}

            <section class="nl-card">
                <div class="nl-card-head">
                    <div>
                        <h3>世界书分类</h3>
                        <div class="nl-card-desc">“提取指南”会直接写进提示词，告诉 AI 这个分类要提取什么。<span class="nl-dot nl-info" aria-hidden="true"></span> 常驻 = 始终注入；<span class="nl-dot nl-ok" role="img" aria-label="关键词"></span> = 关键词出现时注入。</div>
                    </div>
                    <button class="nl-btn nl-sm" data-act="cat-add">${icon('plus')}新增分类</button>
                    <button class="nl-btn nl-sm" data-act="cat-reset">恢复默认</button>
                </div>
                <div class="nl-cats">
                    ${s.categories.map((c, i) => `
                    <div class="nl-cat" data-i="${i}">
                        <div class="nl-row nl-wrap">
                            <label><input type="checkbox" data-c="enabled" ${c.enabled ? 'checked' : ''}> 启用</label>
                            <input class="nl-input nl-inline" data-c="name" value="${esc(c.name)}" ${c.name === '角色' ? 'disabled' : ''} style="width:8em">
                            <select class="nl-input nl-inline" data-c="constant" aria-label="注入方式">${optionList([{ value: 'false', label: '关键词' }, { value: 'true', label: '常驻' }], String(!!c.constant))}</select>
                            <select class="nl-input nl-inline" data-c="position">${optionList(WI_POSITIONS, c.position)}</select>
                            <label>深度 <input class="nl-input nl-inline nl-num" type="number" data-c="depth" value="${c.depth}"></label>
                            <label>顺序 <input class="nl-input nl-inline nl-num" type="number" data-c="order" value="${c.order}"></label>
                            <label><input type="checkbox" data-c="autoIncrement" ${c.autoIncrement ? 'checked' : ''}> 顺序递增</label>
                            ${c.name === '角色' ? '' : `<button class="nl-icon-btn nl-danger" data-act="cat-del" data-i="${i}" title="删除分类" aria-label="删除分类">${icon('trash')}</button>`}
                        </div>
                        ${c.name === '角色' ? '<div class="nl-muted nl-small">角色条目由角色档案自动生成。</div>' : `<textarea class="nl-input nl-textarea" rows="2" data-c="guide" placeholder="提取指南">${esc(c.guide || '')}</textarea>`}
                    </div>`).join('')}
                </div>
            </section>

            <section class="nl-card">
                <div class="nl-card-head">
                    <div>
                        <h3>默认条目</h3>
                        <div class="nl-card-desc">每次写入/导出世界书时自动附加，例如扮演准则、禁止事项。</div>
                    </div>
                    <button class="nl-btn nl-sm" data-act="def-add">${icon('plus')}新增</button>
                </div>
                ${s.defaultEntries.map((d, i) => `
                <div class="nl-cat" data-d="${i}">
                    <div class="nl-row nl-wrap">
                        <input class="nl-input nl-inline" data-dk="name" value="${esc(d.name)}" placeholder="名称">
                        <input class="nl-input nl-inline" data-dk="category" value="${esc(d.category || '默认')}" placeholder="分类" style="width:6em">
                        <input class="nl-input nl-inline" data-dk="keywords" value="${esc((d.keywords || []).join('，'))}" placeholder="关键词">
                        <label><input type="checkbox" data-dk="constant" ${d.constant ? 'checked' : ''}> 常驻</label>
                        <label>顺序 <input class="nl-input nl-inline nl-num" type="number" data-dk="order" value="${d.order ?? 50}"></label>
                        <button class="nl-icon-btn nl-danger" data-act="def-del" data-i="${i}" title="删除条目" aria-label="删除条目">${icon('trash')}</button>
                    </div>
                    <textarea class="nl-input nl-textarea" rows="3" data-dk="content" placeholder="内容">${esc(d.content || '')}</textarea>
                </div>`).join('') || emptyState('点「新增」添加一条，写入或导出世界书时会自动带上。', '', { title: '还没有默认条目', ico: 'worldbook' })}
            </section>

            <section class="nl-card">
                <div class="nl-card-head"><div><h3>世界书选项</h3></div></div>
                <div class="nl-row nl-wrap nl-checks">
                    <label><input type="checkbox" data-setting="worldbook.allowRecursion"> 允许条目递归触发</label>
                    <label><input type="checkbox" data-setting="worldbook.includeOutlineEntry"> 附带“剧情大纲”常驻条目</label>
                    <label><input type="checkbox" data-setting="worldbook.includeStyleEntry"> 附带“文风”条目</label>
                </div>
                <div class="nl-grid3">
                    <div class="nl-field"><label>角色条目最多写入经历数</label><input class="nl-input" type="number" min="0" data-setting="extraction.maxExperiences"></div>
                    <div class="nl-field"><label>角色条目最多写入台词数</label><input class="nl-input" type="number" min="0" data-setting="extraction.maxQuotes"></div>
                    <div class="nl-field"><label>角色条目最多写入对话样本数</label><input class="nl-input" type="number" min="0" data-setting="extraction.maxDialogues"></div>
                </div>
            </section>
            ${statusBarSection()}

            <section class="nl-card">
                <div class="nl-card-head"><div><h3>提示词模板</h3></div></div>
                <div class="nl-row nl-wrap">
                    <select class="nl-input nl-inline" data-prompt-key aria-label="要编辑的提示词模板">${optionList(Object.entries(PROMPT_LABELS).map(([value, label]) => ({ value, label: `${label}${app.settings.prompts[value] ? '（已修改）' : ''}` })), promptKey)}</select>
                    <span class="nl-spacer"></span>
                    <button class="nl-btn nl-sm" data-act="prompt-reset">恢复此模板默认</button>
                </div>
                <div class="nl-muted nl-small">占位符：${esc((PROMPT_PLACEHOLDERS[promptKey] || ['{BOOK}', '{WRITING_RULES}']).join(' '))}（ST 宏如 {{user}} 原样保留）</div>
                <textarea class="nl-input nl-textarea nl-tall nl-mono" data-prompt-text>${esc(app.settings.prompts[promptKey] || DEFAULT_PROMPTS[promptKey])}</textarea>
                <div class="nl-row"><button class="nl-btn nl-primary" data-act="prompt-save">保存模板</button></div>
            </section>`;
            bindSettings(el, app.settings, (path) => {
                app.saveSettings();
                if (path === 'statusBar.mvuUrl' || path === 'statusBar.zodUrl') updateUrlWarn(path.slice('statusBar.'.length));
                if (path.endsWith('.mode')) {
                    const key = path.split('.')[0];
                    prefillDeepseek(key);
                    toggleModes();
                }
            });
            toggleModes();
            // 配置导入导出作用于全部设置，放在页面标题栏
            setActions?.(`
                <button class="nl-btn" data-act="cfg-export" title="导出配置（不含密钥）">${icon('download')}导出（不含密钥）</button>
                <button class="nl-btn" data-act="cfg-export-keys" title="导出配置（含密钥）">${icon('download')}导出（含密钥）</button>
                <button class="nl-btn" data-act="cfg-import">${icon('upload')}导入配置</button>`, onClick);
        };

        /** 切到 DeepSeek 专属接口类型时，接口地址/模型留空的话自动填入官方默认值 */
        const prefillDeepseek = (key) => {
            const a = app.settings[key];
            if (a.mode !== 'deepseek') return;
            let changed = false;
            if (!a.endpoint) {
                a.endpoint = DEEPSEEK_DEFAULT_ENDPOINT;
                changed = true;
            }
            if (!a.model) {
                a.model = DEEPSEEK_MODELS[0].id;
                changed = true;
            }
            if (!changed) return;
            app.saveSettings();
            const sec = el.querySelector(`[data-api="${key}"]`);
            const epInput = sec?.querySelector(`[data-setting="${key}.endpoint"]`);
            if (epInput) epInput.value = a.endpoint;
            const modelInput = sec?.querySelector(`[data-setting="${key}.model"]`);
            if (modelInput) modelInput.value = a.model;
        };

        const updateUrlWarn = (key) => {
            const box = el.querySelector(`[data-sb-url-warn="${key}"]`);
            if (!box) return;
            const msg = sbUrlProblem(sbConf()[key]);
            box.hidden = !msg;
            const text = box.querySelector('span');
            if (text) text.textContent = msg;
        };

        /** 状态栏选项里不能直接用 data-setting 绑定的控件：变量上限要夹取，显示层数 / 保留轮数由「下拉 + 数字」组合成 1 | N | null */
        const onStatusBarChange = (t) => {
            const sec = t.closest('[data-statusbar-settings]');
            const sb = sbConf();
            const k = t.dataset.sb;
            if (k === 'maxVars') {
                sb.maxVars = clampInt(t.value, SB_MAX_VARS.min, SB_MAX_VARS.max, DEFAULT_STATUS_BAR.maxVars);
                t.value = sb.maxVars;
            } else if (k === 'showMode' || k === 'showN') {
                const mode = qs(sec, '[data-sb="showMode"]').value;
                const nInput = qs(sec, '[data-sb="showN"]');
                const n = clampInt(nInput.value, 2, 99, 3);
                nInput.value = n;
                nInput.hidden = mode !== 'n';
                sb.showDepth = mode === 'all' ? null : mode === 'n' ? n : 1;
            } else if (k === 'keepMode' || k === 'keepK') {
                const mode = qs(sec, '[data-sb="keepMode"]').value;
                const kInput = qs(sec, '[data-sb="keepK"]');
                const n = clampInt(kInput.value, 1, 20, 3);
                kInput.value = n;
                kInput.hidden = mode !== 'k';
                sb.keepUpdateDepth = mode === 'k' ? n : null;
            } else return;
            app.saveSettings();
        };

        const toggleModes = () => {
            for (const sec of el.querySelectorAll('[data-api]')) {
                const mode = app.settings[sec.dataset.api].mode;
                for (const m of sec.querySelectorAll('.nl-api-mode')) {
                    const want = m.dataset.mode === 'direct' ? DIRECT_MODES.includes(mode) : m.dataset.mode === mode;
                    m.hidden = !want;
                }
                const g = sec.querySelector('[data-gemini-only]');
                if (g) g.hidden = mode !== 'gemini';
            }
        };

        const onClick = async (e) => {
            const btn = e.target.closest('[data-act]');
            if (!btn) return;
            const s = app.settings;
            switch (btn.dataset.act) {
                case 'anti-reset':
                    s.antiTruncate = structuredCloneSafe(DEFAULT_ANTI_TRUNCATE);
                    app.saveSettings();
                    return render();
                case 'sb-url-reset': {
                    const key = btn.dataset.key;
                    if (!(key in SB_URL_LABELS)) return;
                    sbConf()[key] = DEFAULT_STATUS_BAR[key];
                    app.saveSettings();
                    const input = el.querySelector(`[data-setting="statusBar.${key}"]`);
                    if (input) input.value = DEFAULT_STATUS_BAR[key];
                    updateUrlWarn(key);
                    return;
                }
                case 'sb-templates': {
                    await openStatusBarTemplateLibrary();
                    const count = el.querySelector('[data-sb-tpl-count]');
                    if (count) count.textContent = `（${listStatusBarTemplates(s).length}）`;
                    return;
                }
                case 'test': {
                    const key = btn.dataset.key;
                    const out = qs(el, `[data-test-result="${key}"]`);
                    out.textContent = '';
                    await busy(btn, async () => {
                        try {
                            const r = await testApi(s[key]);
                            out.innerHTML = `<span class="nl-ok">${icon('check')} 成功（${(r.ms / 1000).toFixed(1)}s）：${esc(r.text.slice(0, 40))}</span>`;
                        } catch (err) {
                            out.innerHTML = `<span class="nl-err">${icon('alert')} ${esc(err.message)}</span>`;
                        }
                    }, '测试中…');
                    return;
                }
                case 'models': {
                    const key = btn.dataset.key;
                    await busy(btn, async () => {
                        const list = await listModels(s[key]);
                        qs(el, `#nl-models-${key}`).innerHTML = list.map((m) => `<option value="${esc(m.id)}">${esc(m.name)}</option>`).join('');
                        app.log(`已拉取 ${list.length} 个模型`, 'success');
                    }, '拉取中…');
                    return;
                }
                case 'cat-add':
                    s.categories.push({ name: `新分类${s.categories.length}`, builtin: false, enabled: true, constant: false, position: 0, depth: 4, order: 600, autoIncrement: true, guide: '' });
                    app.saveSettings();
                    return render();
                case 'cat-del':
                    if (!(await confirmDialog('删除这个分类？已提取的条目会保留在项目中，显示为未分类。', { danger: true }))) return;
                    s.categories.splice(Number(btn.dataset.i), 1);
                    app.saveSettings();
                    return render();
                case 'cat-reset':
                    if (!(await confirmDialog('恢复默认分类设置？', { danger: true }))) return;
                    s.categories = structuredCloneSafe(DEFAULT_CATEGORIES);
                    app.saveSettings();
                    return render();
                case 'def-add':
                    s.defaultEntries.push({ category: '默认', name: '扮演准则', keywords: [], content: '', constant: true, position: 0, depth: 4, order: 50 });
                    app.saveSettings();
                    return render();
                case 'def-del':
                    s.defaultEntries.splice(Number(btn.dataset.i), 1);
                    app.saveSettings();
                    return render();
                case 'prompt-save': {
                    const v = qs(el, '[data-prompt-text]').value;
                    if (v.trim() === DEFAULT_PROMPTS[promptKey].trim()) delete s.prompts[promptKey];
                    else s.prompts[promptKey] = v;
                    app.saveSettings();
                    app.log(`已保存提示词模板：${PROMPT_LABELS[promptKey]}`, 'success');
                    return render();
                }
                case 'prompt-reset':
                    delete s.prompts[promptKey];
                    app.saveSettings();
                    return render();
                case 'cfg-export':
                    return exportConfig(s);
                case 'cfg-export-keys':
                    if (!(await confirmDialog('导出文件将包含 API 密钥，请勿分享给他人。继续？'))) return;
                    return exportConfig(s, { includeKeys: true });
                case 'chain-add': {
                    const list = chains()[chainTask];
                    const role = btn.dataset.role;
                    const hasPrompt = list.some((m) => String(m.content || '').includes('{PROMPT}'));
                    list.push({ role, content: role === 'user' && !hasPrompt ? '{PROMPT}' : '', enabled: true });
                    app.saveSettings();
                    return render();
                }
                case 'chain-del':
                case 'chain-up':
                case 'chain-down': {
                    const list = chains()[chainTask];
                    const i = Number(btn.dataset.i);
                    if (btn.dataset.act === 'chain-del') list.splice(i, 1);
                    else {
                        const j = btn.dataset.act === 'chain-up' ? i - 1 : i + 1;
                        if (j < 0 || j >= list.length) return;
                        [list[i], list[j]] = [list[j], list[i]];
                    }
                    app.saveSettings();
                    return render();
                }
                case 'chain-copy':
                    chains()[chainTask] = structuredCloneSafe(chains().default);
                    app.saveSettings();
                    return render();
                case 'chain-reset':
                    if (!(await confirmDialog(chainTask === 'default' ? '恢复为默认消息链（系统提示 + 用户提示）？' : '清除这个任务的自定义消息链，改用默认链？', { danger: true }))) return;
                    chains()[chainTask] = chainTask === 'default' ? structuredCloneSafe(DEFAULT_CHAIN) : [];
                    app.saveSettings();
                    return render();
                case 'chain-preview': {
                    const book = app.project?.bookName || '书名';
                    await openDialog({
                        title: `消息链预览：${CHAIN_TASKS.find((t) => t.value === chainTask)?.label}`,
                        wide: true,
                        body: chainPreviewHtml(s, chainTask, { system: '〔这里是任务的系统提示〕', prompt: '〔这里是任务的主提示：原文、资料、输出格式等〕', book }),
                    });
                    return;
                }
                case 'cfg-import': {
                    const file = await pickFile('.json,application/json');
                    if (!file) return;
                    try {
                        applyConfig(s, JSON.parse(await readFileAsText(file)));
                        app.saveSettings();
                        app.log('已导入配置', 'success');
                        render();
                    } catch (err) {
                        await openDialog({ title: '导入失败', body: esc(err.message) });
                    }
                    return;
                }
                default:
                    break;
            }
        };

        const onChainInput = (e) => {
            const t = e.target;
            const box = t.closest('[data-ci]');
            if (!box || !t.dataset.cf) return false;
            const m = chains()[chainTask][Number(box.dataset.ci)];
            if (!m) return true;
            if (t.dataset.cf === 'content') m.content = t.value;
            else if (t.dataset.cf === 'enabled') m.enabled = t.checked;
            else if (t.dataset.cf === 'role') m.role = t.value;
            app.saveSettings();
            if (e.type === 'change' && t.dataset.cf !== 'content') render();
            return true;
        };

        const onChange = (e) => {
            const t = e.target;
            const s = app.settings;
            if (t.matches('[data-chain-task]')) {
                chainTask = t.value;
                return render();
            }
            if (t.dataset.sb) return onStatusBarChange(t);
            if (onChainInput(e)) return;
            if (t.matches('[data-prompt-key]')) {
                promptKey = t.value;
                return render();
            }
            const catEl = t.closest('[data-i].nl-cat');
            if (catEl && t.dataset.c) {
                const c = s.categories[Number(catEl.dataset.i)];
                const k = t.dataset.c;
                if (t.type === 'checkbox') c[k] = t.checked;
                else if (k === 'constant') c[k] = t.value === 'true';
                else if (['position', 'depth', 'order'].includes(k)) c[k] = Number(t.value);
                else if (k === 'name') {
                    const v = t.value.trim();
                    if (!v || s.categories.some((x, i) => x.name === v && i !== Number(catEl.dataset.i))) {
                        t.value = c.name;
                        return app.log('分类名不能为空或重复', 'warn');
                    }
                    if (app.project?.worldbook[c.name] && !app.project.worldbook[v]) {
                        app.project.worldbook[v] = app.project.worldbook[c.name];
                        delete app.project.worldbook[c.name];
                        app.saveSoon();
                    }
                    c.name = v;
                } else c[k] = t.value;
                app.saveSettings();
                return;
            }
            const defEl = t.closest('[data-d]');
            if (defEl && t.dataset.dk) {
                const d = s.defaultEntries[Number(defEl.dataset.d)];
                const k = t.dataset.dk;
                if (t.type === 'checkbox') d[k] = t.checked;
                else if (k === 'keywords') d[k] = t.value.split(/[，,、]/).map((x) => x.trim()).filter(Boolean);
                else if (k === 'order') d[k] = Number(t.value);
                else d[k] = t.value;
                app.saveSettings();
            }
        };

        el.addEventListener('click', onClick);
        el.addEventListener('change', onChange);
        el.addEventListener('input', (e) => {
            if (e.target.dataset.cf === 'content') onChainInput(e);
        });
        render();
        return {};
    },
};
