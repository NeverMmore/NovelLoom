// 设置页：API、分类、默认条目、提示词模板、配置导入导出

import { app } from '../app.js';
import { DEFAULT_ANTI_TRUNCATE, DEFAULT_CATEGORIES, WI_POSITIONS } from '../constants.js';
import { applyConfig, exportConfig } from '../io.js';
import { API_MODES, CHAIN_TASKS, DEEPSEEK_DEFAULT_ENDPOINT, DEEPSEEK_MODELS, DEFAULT_CHAIN, GEMINI_SAFETY_OPTIONS, listModels, testApi } from '../llm.js';
import { DEFAULT_PROMPTS, PROMPT_LABELS, PROMPT_PLACEHOLDERS } from '../prompts.js';
import { pickFile, readFileAsText, structuredCloneSafe } from '../utils.js';
import { bindSettings, busy, chainPreviewHtml, confirmDialog, emptyState, esc, icon, openDialog, optionList, qs } from './common.js';

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
