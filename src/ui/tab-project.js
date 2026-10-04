// 项目页：导入小说、项目列表、任务导入导出

import { app } from '../app.js';
import { CHAPTER_REGEX_PRESETS } from '../constants.js';
import { detectChapters } from '../splitter.js';
import { deleteProject, listProjects, loadProject, saveProject } from '../store.js';
import { exportTask, parseTask } from '../io.js';
import { projectStats } from '../project.js';
import { formatNumber, pickFile, readFileAsText } from '../utils.js';
import { bindSettings, busy, confirmDialog, emptyState, esc, fmtTime, icon, optionList, promptDialog, qs } from './common.js';
import { pipelineState } from './pipeline.js';

export const projectTab = {
    mount(el, { switchTab }) {
        let pending = null; // { text, encoding, fileName }

        /** 流程清单：每一步是否完成、做了多少；第一个没完成的必做步骤标为“下一步” */
        const pipeline = (p) => {
            const { steps, next } = pipelineState(p);
            return steps.map((s, i) => `
                <button class="nl-pipe-row ${s.ok ? 'ok' : ''} ${s === next ? 'next' : ''}" data-goto="${s.tab}">
                    <span class="nl-pipe-mark">${s.ok ? icon('check', { size: 12, label: '已完成' }) : i + 1}</span>
                    <span class="nl-pipe-name">${s.name}${s.optional ? '<small>可选</small>' : ''}${s === next ? '<small>下一步</small>' : ''}</span>
                    <span class="nl-pipe-note">${esc(s.note)}</span>
                    ${icon('chevronRight', { size: 14, cls: 'nl-pipe-go' })}
                </button>`).join('');
        };

        const render = async () => {
            const list = await listProjects();
            const p = app.project;
            const st = p ? projectStats(p) : null;
            el.innerHTML = `
            ${p ? `
            <section class="nl-card nl-current">
                <div class="nl-card-head">
                    <div>
                        <h3>${esc(p.name)}</h3>
                        <div class="nl-card-desc">${formatNumber(st.chars)} 字 · 更新于 ${fmtTime(p.updatedAt)}</div>
                    </div>
                    <button class="nl-btn nl-sm" data-act="rename-current">重命名</button>
                </div>
                <div class="nl-pipeline nl-stats">${pipeline(p)}</div>
                <div class="nl-field"><label for="nl-book-field">书名 <span class="nl-muted">用于提示词与世界书命名</span></label><input class="nl-input" id="nl-book-field" style="max-width: 360px" data-field="bookName" value="${esc(p.bookName)}"></div>
            </section>` : ''}

            <section class="nl-card">
                <div class="nl-card-head">
                    <div>
                        <h3>导入小说</h3>
                        <div class="nl-card-desc">自动识别 UTF-8 / GBK / GB18030 / Big5 / UTF-16 编码，按章节分段。</div>
                    </div>
                </div>
                <div class="nl-row nl-wrap">
                    <button class="nl-btn ${p ? '' : 'nl-primary'}" data-act="pick">${icon('upload')}选择 TXT 文件</button>
                    <button class="nl-btn" data-act="paste">粘贴文本</button>
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
                <div class="nl-card-head">
                    <div>
                        <h3>全部项目</h3>
                        <div class="nl-card-desc">项目保存在浏览器里；导出的任务文件可以在别的设备上导入继续。</div>
                    </div>
                    <button class="nl-btn nl-sm" data-act="import-task">${icon('download', { size: 14 })}导入任务文件</button>
                </div>
                ${list.length ? `<div class="nl-list">${list.map((x) => `
                    <div class="nl-list-item ${x.id === p?.id ? 'active' : ''}">
                        <div class="nl-grow">
                            <b>${esc(x.name)}</b>
                            <div class="nl-muted nl-small">${x.doneCount}/${x.chunkCount} 段已提取 · ${x.characterCount} 个角色 · 更新于 ${fmtTime(x.updatedAt)}</div>
                        </div>
                        ${x.id === p?.id ? '<span class="nl-tag nl-imp-main">当前</span>' : `<button class="nl-btn nl-sm" data-act="open" data-id="${esc(x.id)}">打开</button>`}
                        <button class="nl-btn nl-sm" data-act="export" data-id="${esc(x.id)}">导出</button>
                        <button class="nl-btn nl-sm nl-danger" data-act="delete" data-id="${esc(x.id)}">删除</button>
                    </div>`).join('')}</div>`
                    : emptyState('工作流程：导入小说 → 自动分段 → 逐段提取章节概要、角色档案、世界书条目（前文资料会滚动注入后续段落）→ 校对 → 生成角色卡并写入酒馆。可选：按大纲续写新章节，新章节会回灌资料库。', '', { title: '还没有项目', ico: 'overview' })}
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
