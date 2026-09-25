// 项目页：导入小说、项目列表、任务导入导出

import { app } from '../app.js';
import { CHAPTER_REGEX_PRESETS } from '../constants.js';
import { detectChapters } from '../splitter.js';
import { deleteProject, listProjects, loadProject, saveProject } from '../store.js';
import { exportTask, parseTask } from '../io.js';
import { projectStats } from '../project.js';
import { formatNumber, pickFile, readFileAsText } from '../utils.js';
import { bindSettings, busy, confirmDialog, esc, fmtTime, optionList, promptDialog, qs } from './common.js';

export const projectTab = {
    mount(el, { switchTab }) {
        let pending = null; // { text, encoding, fileName }

        const render = async () => {
            const list = await listProjects();
            const p = app.project;
            const st = p ? projectStats(p) : null;
            el.innerHTML = `
            ${p ? `
            <section class="nl-card nl-current">
                <div class="nl-row">
                    <h3>当前项目：${esc(p.name)}</h3>
                    <span class="nl-spacer"></span>
                    <button class="nl-btn nl-sm" data-act="rename-current">重命名</button>
                </div>
                <div class="nl-stats">
                    <div><b>${formatNumber(st.chars)}</b><span>字</span></div>
                    <div><b>${st.chunks}</b><span>分段</span></div>
                    <div><b>${st.done}</b><span>已提取</span></div>
                    <div><b>${st.characters}</b><span>角色</span></div>
                    <div><b>${st.entries}</b><span>条目</span></div>
                    <div><b>${p.cards.length}</b><span>角色卡</span></div>
                    <div><b>${st.generated}</b><span>续写章</span></div>
                </div>
                <div class="nl-steps">
                    <button class="nl-step ${st.chunks ? 'ok' : ''}" data-goto="chunks">① 检查分段</button>
                    <button class="nl-step ${st.done === st.chunks && st.chunks ? 'ok' : ''}" data-goto="extract">② 提取资料</button>
                    <button class="nl-step ${st.characters ? 'ok' : ''}" data-goto="characters">③ 校对角色</button>
                    <button class="nl-step ${st.entries ? 'ok' : ''}" data-goto="worldbook">④ 校对世界书</button>
                    <button class="nl-step ${p.style?.samples?.length || p.style?.rules || p.style?.banned ? 'ok' : ''}" data-goto="style">⑤ 调整文风（可选）</button>
                    <button class="nl-step ${p.cards.length ? 'ok' : ''}" data-goto="cards">⑥ 生成角色卡并写入酒馆</button>
                    <button class="nl-step ${p.plan?.chapters?.length ? 'ok' : ''}" data-goto="plan">⑦ 写后续大纲（可选）</button>
                    <button class="nl-step ${st.generated ? 'ok' : ''}" data-goto="continue">⑧ 按大纲续写（可选）</button>
                </div>
                <div class="nl-muted">书名（用于提示词与世界书命名）：<input class="nl-input nl-inline" data-field="bookName" value="${esc(p.bookName)}"></div>
            </section>` : ''}

            <section class="nl-card">
                <h3>导入小说</h3>
                <div class="nl-row nl-wrap">
                    <button class="nl-btn nl-primary" data-act="pick">选择 TXT 文件</button>
                    <button class="nl-btn" data-act="paste">粘贴文本</button>
                    <span class="nl-muted">自动识别 UTF-8 / GBK / GB18030 / Big5 / UTF-16 编码</span>
                </div>
                <div class="nl-import-preview" ${pending ? '' : 'hidden'}>
                    <div class="nl-grid2">
                        <div class="nl-field"><label>书名</label><input class="nl-input" id="nl-bookname" value="${esc(pending?.name || '')}"></div>
                        <div class="nl-field"><label>编码 / 字数</label><div class="nl-muted">${esc(pending?.encoding || '')} · ${formatNumber(pending?.text?.length || 0)} 字</div></div>
                        <div class="nl-field"><label>章节识别</label><select class="nl-input" data-setting="chunking.regexPreset">${optionList([...CHAPTER_REGEX_PRESETS.map((x) => ({ value: x.id, label: x.name })), { value: 'custom', label: '自定义正则' }])}</select></div>
                        <div class="nl-field"><label>自定义正则（按行匹配）</label><input class="nl-input" data-setting="chunking.customRegex" placeholder="^\\s*第.+章.*$"></div>
                        <div class="nl-field"><label>每段最大字数</label><input class="nl-input" type="number" min="1000" step="1000" data-setting="chunking.chunkSize"></div>
                        <div class="nl-field"><label><input type="checkbox" data-setting="chunking.mergeSmall"> 过小的末段并入前一段</label></div>
                    </div>
                    <div class="nl-detect"></div>
                    <div class="nl-row">
                        <button class="nl-btn" data-act="detect">检测章节</button>
                        <button class="nl-btn nl-primary" data-act="create">创建项目</button>
                        <button class="nl-btn" data-act="cancel-import">取消</button>
                    </div>
                </div>
            </section>

            <section class="nl-card">
                <div class="nl-row"><h3>全部项目</h3><span class="nl-spacer"></span><button class="nl-btn nl-sm" data-act="import-task">导入任务文件</button></div>
                ${list.length ? `<div class="nl-list">${list.map((x) => `
                    <div class="nl-list-item ${x.id === p?.id ? 'active' : ''}">
                        <div class="nl-grow">
                            <b>${esc(x.name)}</b>
                            <div class="nl-muted">${x.doneCount}/${x.chunkCount} 段已提取 · ${x.characterCount} 角色 · 更新于 ${fmtTime(x.updatedAt)}</div>
                        </div>
                        ${x.id === p?.id ? '<span class="nl-tag">当前</span>' : `<button class="nl-btn nl-sm" data-act="open" data-id="${esc(x.id)}">打开</button>`}
                        <button class="nl-btn nl-sm" data-act="export" data-id="${esc(x.id)}">导出</button>
                        <button class="nl-btn nl-sm nl-danger" data-act="delete" data-id="${esc(x.id)}">删除</button>
                    </div>`).join('')}</div>` : '<div class="nl-muted">还没有项目。导入一本小说开始吧。</div>'}
            </section>

            <section class="nl-card nl-muted nl-small">
                工作流程：导入小说 → 自动分段 → 逐段提取章节概要、角色档案、世界书条目（前文资料会滚动注入后续段落）→ 校对 → 选择角色与故事时间点生成角色卡 → 一键写入酒馆（自动创建并绑定世界书）。
                可选：用 AI 续写新章节，新章节会回灌资料库；或在酒馆聊天里挂机续写。
            </section>`;
            bindSettings(el, app.settings, () => app.saveSettings());
        };

        const detect = () => {
            if (!pending) return;
            const box = qs(el, '.nl-detect');
            try {
                const chapters = detectChapters(pending.text, app.getChapterPattern());
                const { chunks } = app.splitText(pending.text);
                box.innerHTML = `<div class="nl-ok">识别到 <b>${chapters.length}</b> 个章节，将分为 <b>${chunks.length}</b> 段。</div>
                    <div class="nl-muted nl-small">${chapters.slice(0, 12).map((c) => esc(c.title)).join(' ｜ ')}${chapters.length > 12 ? ' …' : ''}</div>`;
            } catch (e) {
                box.innerHTML = `<div class="nl-err">${esc(e.message)}</div>`;
            }
        };

        const onClick = async (e) => {
            const btn = e.target.closest('[data-act], [data-goto]');
            if (!btn) return;
            if (btn.dataset.goto) return switchTab(btn.dataset.goto);
            const id = btn.dataset.id;
            switch (btn.dataset.act) {
                case 'pick': {
                    const file = await pickFile('.txt,text/plain');
                    if (!file) return;
                    await busy(btn, async () => {
                        const { text, encoding } = await app.readNovelFile(file);
                        pending = { text, encoding, fileName: file.name, name: file.name.replace(/\.[^.]+$/, '') };
                        await render();
                        detect();
                    }, '读取中…');
                    break;
                }
                case 'paste': {
                    const text = await promptDialog('粘贴小说正文', '', { title: '粘贴文本', multiline: true });
                    if (!text) return;
                    pending = { text: text.replace(/\r\n?/g, '\n'), encoding: '粘贴', fileName: '', name: '粘贴的小说' };
                    await render();
                    detect();
                    break;
                }
                case 'detect':
                    detect();
                    break;
                case 'cancel-import':
                    pending = null;
                    render();
                    break;
                case 'create': {
                    if (!pending) return;
                    if (app.isBusy()) return app.log('有任务正在运行，请先停止', 'warn');
                    const name = qs(el, '#nl-bookname').value.trim() || pending.name;
                    await busy(btn, async () => {
                        await app.createProjectFromText({ text: pending.text, fileName: pending.fileName, encoding: pending.encoding, name });
                        pending = null;
                    });
                    switchTab('chunks');
                    break;
                }
                case 'open':
                    if (app.isBusy()) return app.log('有任务正在运行，不能切换项目', 'warn');
                    await app.openProject(id);
                    break;
                case 'export': {
                    const pr = id === app.project?.id ? app.project : await loadProject(id);
                    if (pr) exportTask(pr);
                    break;
                }
                case 'delete': {
                    const ok = await confirmDialog('删除后无法恢复（包括所有快照）。建议先导出任务文件备份。', { title: '删除项目', okLabel: '删除', danger: true });
                    if (!ok) return;
                    if (id === app.project?.id) app.setProject(null);
                    await deleteProject(id);
                    render();
                    break;
                }
                case 'import-task': {
                    const file = await pickFile('.json,application/json');
                    if (!file) return;
                    await busy(btn, async () => {
                        const project = parseTask(JSON.parse(await readFileAsText(file)));
                        await saveProject(project);
                        app.setProject(project);
                        app.log(`📥 已导入任务「${project.name}」`, 'success');
                    });
                    break;
                }
                case 'rename-current': {
                    const name = await promptDialog('新名称', app.project.name, { title: '重命名项目' });
                    if (!name) return;
                    app.project.name = name.trim();
                    await app.saveNow();
                    app.events.emit('project', app.project);
                    break;
                }
                default:
                    break;
            }
        };

        const onChange = (e) => {
            if (e.target.dataset.field === 'bookName' && app.project) {
                app.project.bookName = e.target.value.trim() || app.project.name;
                app.saveSoon();
            }
            if (e.target.dataset.setting?.startsWith('chunking') && pending) detect();
        };

        el.addEventListener('click', onClick);
        el.addEventListener('change', onChange);
        render();
        return {};
    },
};
