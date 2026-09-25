// 角色卡页：生成、编辑、审稿、写入酒馆、导出

import { app } from '../app.js';
import { buildCardPrompt, buildPngCard, fixCardWithAI, generateCard, imageToPng, lintCardFor, regenerateCardField, timepointLabel } from '../cards.js';
import { buildGroupPrompt, generateGroupCard, groupCardMarkdown, publishGroupCard } from '../group.js';
import { getVolumes, IMPORTANCE_RANK } from '../project.js';
import { blobToDataUrl, dataUrlToBlob, defaultWorldName, prepareCard, publishCard } from '../publish.js';
import { characterExistsInST, openCharacterInST } from '../stio.js';
import { bannedRulesFor, getStyleProfile } from '../style.js';
import { greetingText, testChatReply } from '../testchat.js';
import { downloadFile, estimateTokens, pickFile, safeFileName, truncate, uniq } from '../utils.js';
import { bindSettings, busy, chainPreviewHtml, confirmDialog, esc, fmtTime, importanceLabel, openDialog, optionList, promptDialog, rerollBtn } from './common.js';

const GREETING_SEP = '\n\n=====\n\n';

function lintSummary(lint = []) {
    const err = lint.filter((i) => i.level === 'error').length;
    const warn = lint.filter((i) => i.level === 'warn').length;
    if (!err && !warn) return '<span class="nl-ok">✔ 审稿通过</span>';
    return `<span class="${err ? 'nl-err' : 'nl-warn'}">${err ? `❗${err} 处问题 ` : ''}${warn ? `⚠️${warn} 处提醒` : ''}</span>`;
}

export const cardsTab = {
    mount(el, { switchTab }) {
        const form = { kind: 'character', charName: app.pendingCardChar || '', timepoint: '', requirement: '', greetings: app.settings.cards.greetings, firstMesLen: '400-800 字', avatarDataUrl: '' };
        delete app.pendingCardChar;
        const groupForm = { members: new Set(), timepoint: '', requirement: '' };

        /** 角色名 → 该角色已写入酒馆的 avatar 文件名（不含 .png）；没有则返回空字符串 */
        const resolveAvatar = (name) => {
            const cards = app.project.cards.filter((c) => c.charName === name && c.stAvatar && characterExistsInST(c.stAvatar));
            return cards.length ? cards[cards.length - 1].stAvatar : '';
        };

        const charOptions = () => Object.values(app.project.characters)
            .sort((a, b) => (IMPORTANCE_RANK[b.importance] - IMPORTANCE_RANK[a.importance]) || (b.chunksSeen.length - a.chunksSeen.length))
            .map((c) => ({ value: c.name, label: `${c.name}（${importanceLabel(c.importance)} · ${c.chunksSeen.length} 段）` }));

        const timeOptions = () => {
            const vols = getVolumes(app.project).filter((v) => !v.implicit);
            const opts = [{ value: '', label: '全书结束时（使用全部资料）' }];
            for (const c of app.project.chunks) {
                const v = vols.find((x) => x.startChunk === c.index);
                if (v) opts.push({ value: String(v.endChunk), label: `📦 ${v.name} 卷末（第 ${v.endChunk + 1} 段）` });
                opts.push({ value: String(c.index), label: `　第 ${c.index + 1} 段结束时：${truncate(c.title, 30)}` });
            }
            return opts;
        };

        const render = () => {
            const p = app.project;
            const chars = charOptions();
            if (!form.charName && chars.length) form.charName = chars[0].value;
            el.innerHTML = `
            <section class="nl-card">
                <h3>生成角色卡</h3>
                <div class="nl-row nl-wrap">
                    ${form.avatarDataUrl ? `<img class="nl-avatar" src="${form.avatarDataUrl}" data-form-avatar-img>` : '<div class="nl-avatar nl-avatar-empty" data-form-avatar-img>🎴</div>'}
                    <div class="nl-field nl-grow">
                        <label>封面（可选，先选好再生成；也可以生成后在编辑里改）</label>
                        <div class="nl-row"><button class="nl-btn nl-sm" data-act="form-avatar">上传封面</button>${form.avatarDataUrl ? '<button class="nl-btn nl-sm" data-act="form-avatar-clear">清除封面</button>' : ''}</div>
                    </div>
                </div>
                <div class="nl-grid2">
                    <div class="nl-field"><label>卡片类型</label><select class="nl-input" data-form="kind">${optionList([{ value: 'character', label: '单人角色卡（{{char}} = 某个角色）' }, { value: 'world', label: '世界/旁白卡（{{char}} = 叙述者，扮演所有 NPC）' }], form.kind)}</select></div>
                    <div class="nl-field" ${form.kind === 'world' ? 'hidden' : ''}><label>角色</label><select class="nl-input" data-form="charName">${optionList(chars, form.charName)}</select></div>
                    <div class="nl-field"><label>故事时间点（防剧透：只用该时间点之前的资料）</label><select class="nl-input" data-form="timepoint">${optionList(timeOptions(), form.timepoint)}</select></div>
                    <div class="nl-field"><label>备选开场白数量 / 开场白长度</label><div class="nl-row"><input class="nl-input" type="number" min="0" max="6" data-form="greetings" value="${form.greetings}"><input class="nl-input" data-form="firstMesLen" value="${esc(form.firstMesLen)}"></div></div>
                </div>
                <div class="nl-field"><label>你的要求（{{user}} 的身份、与角色的关系、开场场景、尺度、视角等）</label>
                    <textarea class="nl-input nl-textarea" rows="3" data-form="requirement" placeholder="例如：{{user}} 是刚转学来的同桌；开场在放学后的天台；第二人称叙述">${esc(form.requirement)}</textarea></div>
                <details>
                    <summary>写卡选项</summary>
                    <div class="nl-grid2">
                        <div class="nl-field"><label>作者名（写入卡片 creator）</label><input class="nl-input" data-setting="cards.creator"></div>
                        <div class="nl-field"><label>世界书命名（{book} = 书名）</label><input class="nl-input" data-setting="worldbook.namePattern"></div>
                    </div>
                    <div class="nl-field"><label>默认要求（每张卡都会附加）</label><textarea class="nl-input nl-textarea" rows="2" data-setting="cards.defaultRequirement"></textarea></div>
                    <div class="nl-row nl-wrap nl-checks">
                        <label><input type="checkbox" data-setting="cards.linkWorldbook"> 写入酒馆时创建并绑定世界书</label>
                        <label><input type="checkbox" data-setting="cards.embedWorldbook"> 卡内嵌世界书（导出分享用）</label>
                        <label><input type="checkbox" data-setting="worldbook.excludeCardCharacter"> 世界书中不重复写入该角色本人</label>
                        <label><input type="checkbox" data-setting="worldbook.includeOutlineEntry"> 附带“剧情大纲”常驻条目</label>
                        <label><input type="checkbox" data-setting="worldbook.includeStyleEntry"> 附带“文风”条目</label>
                        <label><input type="checkbox" data-setting="cards.lintAfterGenerate"> 生成后自动审稿</label>
                    </div>
                </details>
                <div class="nl-muted nl-small">文风：<b>${esc(getStyleProfile(p, app.settings, 'card')?.name || '不指定')}</b>（用于开场白与示例对话；勾选“文风”条目时也写进世界书）${bannedRulesFor(p, app.settings, 'card').length ? ` · 审稿会检查 ${bannedRulesFor(p, app.settings, 'card').length} 个禁用词` : ''} <a href="#" data-act="goto-style">修改</a></div>
                <div class="nl-row">
                    <button class="nl-btn nl-primary" data-act="generate" ${!chars.length && form.kind !== 'world' ? 'disabled' : ''}>生成</button>
                    <button class="nl-btn" data-act="preview">预览提示词</button>
                    ${!chars.length ? '<span class="nl-muted">还没有角色资料，请先提取。</span>' : ''}
                </div>
            </section>

            <section class="nl-card">
                <h3>已生成的角色卡（${p.cards.length}）</h3>
                <div class="nl-cards">
                    ${p.cards.slice().reverse().map((c) => `
                    <div class="nl-cardbox" data-id="${esc(c.id)}">
                        ${c.avatarDataUrl ? `<img class="nl-avatar" src="${c.avatarDataUrl}" alt="">` : '<div class="nl-avatar nl-avatar-empty">🎴</div>'}
                        <div class="nl-grow">
                            <div><b>${esc(c.data.name)}</b> <span class="nl-tag">${c.kind === 'world' ? '世界卡' : '角色卡'}</span> ${c.stAvatar ? (characterExistsInST(c.stAvatar) ? '<span class="nl-tag nl-ok">已在酒馆</span>' : '<span class="nl-tag">酒馆中已删除</span>') : ''}</div>
                            <div class="nl-muted nl-small">${esc(timepointLabel(p, Number.isFinite(c.timepoint) ? c.timepoint : Infinity))} · ${fmtTime(c.updatedAt)} · 约 ${estimateTokens(c.data.description + c.data.first_mes)} tokens</div>
                            <div class="nl-small">${lintSummary(c.lint)}</div>
                            <div class="nl-small nl-clamp">${esc(truncate(c.data.first_mes, 120))}</div>
                        </div>
                        <div class="nl-card-actions">
                            <button class="nl-btn nl-sm" data-act="edit" data-id="${esc(c.id)}">编辑</button>
                            <button class="nl-btn nl-sm" data-act="testchat" data-id="${esc(c.id)}" title="写入酒馆前先在这里聊两句，看看开场白和回复怎么样">💬 试聊</button>
                            <button class="nl-btn nl-sm nl-primary" data-act="publish" data-id="${esc(c.id)}">${c.stAvatar ? '更新到酒馆' : '写入酒馆'}</button>
                            ${c.stAvatar && characterExistsInST(c.stAvatar) ? `<button class="nl-btn nl-sm" data-act="open-st" data-id="${esc(c.id)}">在酒馆打开</button>` : ''}
                            <button class="nl-btn nl-sm" data-act="json" data-id="${esc(c.id)}">导出 JSON</button>
                            <button class="nl-btn nl-sm" data-act="png" data-id="${esc(c.id)}">导出 PNG</button>
                            ${rerollBtn('regen', `data-id="${esc(c.id)}"`, { label: '重新生成', title: '整张卡重新生成' })}
                            <button class="nl-btn nl-sm nl-danger" data-act="delete" data-id="${esc(c.id)}">删除</button>
                        </div>
                    </div>`).join('') || '<div class="nl-muted">还没有角色卡</div>'}
                </div>
            </section>

            <section class="nl-card">
                <h3>群聊场景卡</h3>
                <div class="nl-muted nl-small">挑几个已经确立关系的角色，AI 设计一个可以把他们放进同一个酒馆群聊的开场情境；写入酒馆时会把这些角色已发布的卡拉进一个新建的群聊（每个角色需要先在上面写入酒馆）。</div>
                <div class="nl-grid2">
                    <div class="nl-field"><label>参与角色（至少两个）</label>
                        <div class="nl-row nl-wrap nl-checks">
                            ${chars.map((c) => `<label><input type="checkbox" data-group-member value="${esc(c.value)}" ${groupForm.members.has(c.value) ? 'checked' : ''}> ${esc(c.value)}</label>`).join('') || '<span class="nl-muted">还没有角色资料</span>'}
                        </div>
                    </div>
                    <div class="nl-field"><label>故事时间点</label><select class="nl-input" data-group-form="timepoint">${optionList(timeOptions(), groupForm.timepoint)}</select></div>
                </div>
                <div class="nl-field"><label>你的要求（这场戏发生的场合、{{user}}的切入方式等）</label><textarea class="nl-input nl-textarea" rows="2" data-group-form="requirement">${esc(groupForm.requirement)}</textarea></div>
                <div class="nl-row"><button class="nl-btn nl-primary" data-act="group-generate">生成群聊场景</button><button class="nl-btn" data-act="group-preview">预览提示词</button></div>
                <div class="nl-cards" style="margin-top:8px">
                    ${p.groupCards.map((g) => `
                    <div class="nl-cardbox" data-gid="${esc(g.id)}">
                        <div class="nl-avatar nl-avatar-empty">👥</div>
                        <div class="nl-grow">
                            <div><b>${esc(g.name)}</b> ${g.stGroupId ? '<span class="nl-tag nl-ok">已在酒馆</span>' : ''}</div>
                            <div class="nl-muted nl-small">${esc(g.members.join('、'))} · ${fmtTime(g.updatedAt)}</div>
                            <div class="nl-small nl-clamp">${esc(truncate(g.data.first_mes || g.data.scenario, 120))}</div>
                        </div>
                        <div class="nl-card-actions">
                            <button class="nl-btn nl-sm" data-act="group-edit" data-gid="${esc(g.id)}">查看/编辑</button>
                            <button class="nl-btn nl-sm nl-primary" data-act="group-publish" data-gid="${esc(g.id)}">${g.stGroupId ? '更新群聊' : '创建群聊'}</button>
                            <button class="nl-btn nl-sm" data-act="group-md" data-gid="${esc(g.id)}">复制 Markdown</button>
                            <button class="nl-btn nl-sm nl-danger" data-act="group-delete" data-gid="${esc(g.id)}">删除</button>
                        </div>
                    </div>`).join('') || '<div class="nl-muted">还没有群聊场景卡</div>'}
                </div>
            </section>`;
            bindSettings(el, app.settings, () => app.saveSettings());
        };

        const opts = () => ({
            kind: form.kind,
            charName: form.charName,
            timepoint: form.timepoint === '' ? Infinity : Number(form.timepoint),
            requirement: form.requirement,
            greetings: Number(form.greetings) || 0,
            firstMesLen: form.firstMesLen,
        });

        const editCard = async (card) => {
            const d = card.data;
            const field = (k, label, rows = 4, val = d[k]) => `<div class="nl-field"><label>${label} <span class="nl-muted nl-small" data-tok="${k}">${estimateTokens(val)} tokens</span> ${rerollBtn('reroll-field', `data-field="${k}"`, { title: '只重新生成这一个字段，其余部分不变' })}</label><textarea class="nl-input nl-textarea" rows="${rows}" data-card="${k}">${esc(val)}</textarea></div>`;
            const lintHtml = (lint) => (lint?.length ? lint.map((i) => `<div class="nl-lint nl-lint-${i.level}"><b>[${esc(i.fieldLabel)}] ${esc(i.type)}</b>：${esc(i.context)} <span class="nl-muted">→ ${esc(i.tip)}</span></div>`).join('') : '<div class="nl-ok">✔ 没有发现问题</div>');
            const { value, root } = await openDialog({
                title: `编辑角色卡：${d.name}`,
                wide: true,
                body: `
                    <div class="nl-row nl-wrap">
                        ${card.avatarDataUrl ? `<img class="nl-avatar" src="${card.avatarDataUrl}" data-avatar-img>` : '<div class="nl-avatar nl-avatar-empty" data-avatar-img>🎴</div>'}
                        <button class="nl-btn nl-sm" data-card-act="avatar">上传头像</button>
                        <button class="nl-btn nl-sm" data-card-act="avatar-clear">清除头像</button>
                        <div class="nl-field nl-grow"><label>名称</label><input class="nl-input" data-card="name" value="${esc(d.name)}"></div>
                        <div class="nl-field nl-grow"><label>绑定世界书名称</label><input class="nl-input" data-card-world value="${esc(card.worldName || defaultWorldName(app.project, app.settings, card.timepoint))}"></div>
                    </div>
                    <details class="nl-lint-box" open><summary>审稿（本地规则，不耗 token）</summary><div data-lint>${lintHtml(card.lint)}</div>
                        <div class="nl-row"><button class="nl-btn nl-sm" data-card-act="lint">重新扫描</button><button class="nl-btn nl-sm" data-card-act="fix">AI 按审稿意见修正</button></div></details>
                    ${field('description', '描述（description）', 12)}
                    ${field('personality', '性格摘要（personality）', 2)}
                    ${field('scenario', '场景（scenario）', 3)}
                    ${field('first_mes', '开场白（first_mes）', 10)}
                    ${field('alternate_greetings', '备选开场白（用 ===== 分隔）', 8, d.alternate_greetings.join(GREETING_SEP))}
                    ${field('mes_example', '示例对话（mes_example）', 8)}
                    <details><summary>更多字段</summary>
                        ${field('system_prompt', '系统提示词覆盖（system_prompt）', 3)}
                        ${field('post_history_instructions', '历史后指令（post_history_instructions）', 3)}
                        ${field('creator_notes', '作者备注（creator_notes）', 2)}
                        <div class="nl-field"><label>标签（逗号分隔）</label><input class="nl-input" data-card="tags" value="${esc(d.tags.join('，'))}"></div>
                    </details>`,
                buttons: [{ label: '取消', value: null }, { label: '保存', value: 'save' }, { label: '保存并写入酒馆', value: 'publish', primary: true }],
                onMount: (r) => {
                    const collect = () => readCardForm(r, card);
                    r.addEventListener('input', (e) => {
                        const k = e.target.dataset.card;
                        const tok = k && r.querySelector(`[data-tok="${k}"]`);
                        if (tok) tok.textContent = `${estimateTokens(e.target.value)} tokens`;
                    });
                    r.addEventListener('click', async (e) => {
                        const rerollField = e.target.closest('[data-act="reroll-field"]');
                        if (rerollField) {
                            const k = rerollField.dataset.field;
                            if (app.isBusy()) return app.log('已有任务在运行', 'warn');
                            const instruction = await promptDialog('可选：给这个字段的额外要求（留空则让 AI 自行发挥）', '', { title: '重新生成这个字段', multiline: true });
                            if (instruction === null) return;
                            card.data = collect();
                            await busy(rerollField, async () => {
                                await regenerateCardField(app.project, app.settings, card, k, { instruction });
                                const inp = r.querySelector(`[data-card="${k}"]`);
                                if (inp) inp.value = k === 'alternate_greetings' ? card.data.alternate_greetings.join(GREETING_SEP) : card.data[k];
                                const tok = r.querySelector(`[data-tok="${k}"]`);
                                if (tok) tok.textContent = `${estimateTokens(inp ? inp.value : '')} tokens`;
                                r.querySelector('[data-lint]').innerHTML = lintHtml(card.lint);
                            }, '重新生成中…');
                            return;
                        }
                        const b = e.target.closest('[data-card-act]');
                        if (!b) return;
                        const act = b.dataset.cardAct;
                        if (act === 'avatar') {
                            const file = await pickFile('image/*');
                            if (!file) return;
                            const png = await imageToPng(file);
                            card.avatarDataUrl = await blobToDataUrl(png);
                            const img = r.querySelector('[data-avatar-img]');
                            img.outerHTML = `<img class="nl-avatar" src="${card.avatarDataUrl}" data-avatar-img>`;
                        } else if (act === 'avatar-clear') {
                            card.avatarDataUrl = '';
                            r.querySelector('[data-avatar-img]').outerHTML = '<div class="nl-avatar nl-avatar-empty" data-avatar-img>🎴</div>';
                        } else if (act === 'lint') {
                            const data = collect();
                            card.lint = lintCardFor(app.project, app.settings, data);
                            r.querySelector('[data-lint]').innerHTML = lintHtml(card.lint);
                        } else if (act === 'fix') {
                            card.data = collect();
                            card.lint = lintCardFor(app.project, app.settings, card.data);
                            if (!card.lint.filter((i) => i.level !== 'info').length) return;
                            await busy(b, async () => {
                                await fixCardWithAI(app.project, app.settings, card);
                                for (const [k, v] of Object.entries(card.data)) {
                                    const inp = r.querySelector(`[data-card="${k}"]`);
                                    if (!inp) continue;
                                    inp.value = k === 'alternate_greetings' ? v.join(GREETING_SEP) : k === 'tags' ? v.join('，') : v;
                                }
                                r.querySelector('[data-lint]').innerHTML = lintHtml(card.lint);
                            }, 'AI 修正中…');
                        }
                    });
                },
            });
            if (!value) return;
            card.data = readCardForm(root, card);
            card.worldName = root.querySelector('[data-card-world]').value.trim();
            card.lint = lintCardFor(app.project, app.settings, card.data);
            card.updatedAt = Date.now();
            await app.saveNow();
            if (value === 'publish') await doPublish(card);
            render();
        };

        const readCardForm = (r, card) => {
            const g = (k) => r.querySelector(`[data-card="${k}"]`)?.value ?? card.data[k];
            return {
                ...card.data,
                name: String(g('name')).trim() || card.data.name,
                description: g('description'),
                personality: g('personality'),
                scenario: g('scenario'),
                first_mes: g('first_mes'),
                alternate_greetings: String(g('alternate_greetings') || '').split(/\n*={5,}\n*/).map((x) => x.trim()).filter(Boolean),
                mes_example: g('mes_example'),
                system_prompt: g('system_prompt'),
                post_history_instructions: g('post_history_instructions'),
                creator_notes: g('creator_notes'),
                tags: uniq(String(r.querySelector('[data-card="tags"]')?.value ?? card.data.tags.join(',')).split(/[,，、]/)),
            };
        };

        const testChatDialog = async (card) => {
            const history = []; // {role, content}[]，仅在对话框内临时保存，关闭即丢弃
            const bubble = (role, text) => `<div class="nl-tc-msg nl-tc-${role}"><b>${role === 'user' ? '你' : esc(card.data.name)}</b><div class="nl-pre nl-small">${esc(text)}</div></div>`;
            const box = document.createElement('div');
            const renderMsgs = () => {
                const greet = greetingText(card);
                box.querySelector('[data-tc-msgs]').innerHTML = (greet ? bubble('assistant', greet) : '<div class="nl-muted nl-small">这张卡还没有开场白</div>') + history.map((m) => bubble(m.role, m.content)).join('');
                const wrap = box.querySelector('[data-tc-msgs]');
                wrap.scrollTop = wrap.scrollHeight;
            };
            box.innerHTML = `
                <div class="nl-muted nl-small">不会写入酒馆，也不会消耗额外资料；只是用当前草稿的设定快速聊两句，关闭即丢弃。</div>
                <div class="nl-tc-msgs" data-tc-msgs></div>
                <div class="nl-row" style="margin-top:6px">
                    <textarea class="nl-input nl-textarea" rows="2" data-tc-input placeholder="按 Enter 发送，Shift+Enter 换行"></textarea>
                    <button class="nl-btn nl-primary" data-tc-send>发送</button>
                    <button class="nl-btn" data-tc-reset title="清空对话，重新开始">重来</button>
                </div>`;
            renderMsgs();
            const send = async () => {
                const ta = box.querySelector('[data-tc-input]');
                const text = ta.value.trim();
                if (!text) return;
                ta.value = '';
                const priorHistory = [{ role: 'assistant', content: greetingText(card) || '（无开场白）' }, ...history];
                history.push({ role: 'user', content: text });
                renderMsgs();
                const btn = box.querySelector('[data-tc-send]');
                await busy(btn, async () => {
                    const reply = await testChatReply(app.project, app.settings, card, priorHistory, text);
                    history.push({ role: 'assistant', content: reply });
                    renderMsgs();
                }, '思考中…');
            };
            box.querySelector('[data-tc-send]').addEventListener('click', send);
            box.querySelector('[data-tc-reset]').addEventListener('click', () => {
                history.length = 0;
                renderMsgs();
            });
            box.querySelector('[data-tc-input]').addEventListener('keydown', (e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    send();
                }
            });
            await openDialog({ title: `试聊：${card.data.name}`, wide: true, body: box, buttons: [{ label: '关闭', value: null }] });
        };

        const groupOpts = () => ({
            names: [...groupForm.members],
            timepoint: groupForm.timepoint === '' ? Infinity : Number(groupForm.timepoint),
            requirement: groupForm.requirement,
        });

        const editGroupCard = async (g) => {
            const { value, root } = await openDialog({
                title: `群聊场景卡：${g.name}`,
                wide: true,
                body: `
                    <div class="nl-field"><label>名称</label><input class="nl-input" data-g="name" value="${esc(g.name)}"></div>
                    <div class="nl-muted nl-small">成员：${esc(g.members.join('、'))}</div>
                    <div class="nl-field"><label>场景（scenario）</label><textarea class="nl-input nl-textarea" rows="4" data-g="scenario">${esc(g.data.scenario)}</textarea></div>
                    <div class="nl-field"><label>开场白（first_mes）</label><textarea class="nl-input nl-textarea" rows="8" data-g="first_mes">${esc(g.data.first_mes)}</textarea></div>
                    <div class="nl-field"><label>各角色在这场戏里的处境</label>
                        ${g.members.map((n) => `<div class="nl-row"><b style="width:6em">${esc(n)}</b><input class="nl-input" data-gnote="${esc(n)}" value="${esc(g.data.notes[n] || '')}"></div>`).join('')}
                    </div>
                    <div class="nl-muted nl-small">群聊没有专门的“开场白”接口，写入酒馆只会创建群聊并把这几个角色拉进去；上面这段场景/开场白/处境说明可以复制到群聊的第一条消息或作者注释里，帮助扮演更准。</div>`,
                buttons: [{ label: '取消', value: null }, { label: '保存', value: 'ok', primary: true }],
            });
            if (value !== 'ok') return;
            g.name = root.querySelector('[data-g="name"]').value.trim() || g.name;
            g.data.scenario = root.querySelector('[data-g="scenario"]').value;
            g.data.first_mes = root.querySelector('[data-g="first_mes"]').value;
            for (const n of g.members) g.data.notes[n] = root.querySelector(`[data-gnote="${CSS.escape(n)}"]`)?.value || '';
            g.updatedAt = Date.now();
            await app.saveNow();
            render();
        };

        const doPublish = async (card, btn) => {
            await busy(btn, async () => {
                const r = await publishCard(app.project, app.settings, card, { overwrite: true });
                await app.saveNow();
                app.log(`🎴 已写入酒馆：角色「${card.data.name}」${app.settings.cards.linkWorldbook ? `，绑定世界书「${r.worldName}」（${r.entryCount} 条）` : ''}`, 'success');
                globalThis.toastr?.success(`角色「${card.data.name}」已写入酒馆`, 'NovelLoom');
            }, '写入中…');
        };

        const onClick = async (e) => {
            const btn = e.target.closest('[data-act]');
            if (!btn) return;
            const p = app.project;
            const card = btn.dataset.id ? p.cards.find((c) => c.id === btn.dataset.id) : null;
            switch (btn.dataset.act) {
                case 'generate':
                case 'regen': {
                    const o = card ? { kind: card.kind, charName: card.charName, timepoint: Number.isFinite(card.timepoint) ? card.timepoint : Infinity, requirement: card.requirement, greetings: card.data.alternate_greetings.length, firstMesLen: form.firstMesLen } : opts();
                    if (o.kind !== 'world' && !p.characters[o.charName]) return app.log('请选择角色', 'warn');
                    const result = await busy(btn, () => generateCard(p, app.settings, o, { onLog: (m) => app.log(m) }), 'AI 写卡中…');
                    if (!result) return;
                    if (card) {
                        result.id = card.id;
                        result.avatarDataUrl = card.avatarDataUrl;
                        result.stAvatar = card.stAvatar;
                        result.worldName = card.worldName;
                        p.cards[p.cards.indexOf(card)] = result;
                    } else {
                        result.avatarDataUrl = form.avatarDataUrl || '';
                        p.cards.push(result);
                    }
                    await app.saveNow();
                    app.log(`🎴 已生成「${result.data.name}」${result.lint.length ? `，审稿发现 ${result.lint.filter((i) => i.level !== 'info').length} 处可改进` : ''}`, 'success');
                    render();
                    return editCard(result);
                }
                case 'goto-style':
                    e.preventDefault();
                    return switchTab('style');
                case 'form-avatar': {
                    const file = await pickFile('image/*');
                    if (!file) return;
                    const png = await imageToPng(file);
                    form.avatarDataUrl = await blobToDataUrl(png);
                    return render();
                }
                case 'form-avatar-clear':
                    form.avatarDataUrl = '';
                    return render();
                case 'preview': {
                    try {
                        const { system, prompt } = buildCardPrompt(p, app.settings, opts());
                        await openDialog({ title: '写卡提示词预览', wide: true, body: chainPreviewHtml(app.settings, 'card', { system, prompt, book: p.bookName }) });
                    } catch (err) {
                        app.log(err.message, 'error');
                    }
                    return;
                }
                case 'edit':
                    return editCard(card);
                case 'testchat':
                    return testChatDialog(card);
                case 'publish':
                    await doPublish(card, btn);
                    return render();
                case 'open-st':
                    try {
                        await openCharacterInST(card.stAvatar);
                    } catch (err) {
                        app.log(err.message, 'error');
                    }
                    return;
                case 'json': {
                    const { json } = prepareCard(p, app.settings, card);
                    downloadFile(JSON.stringify(json, null, 2), `${safeFileName(card.data.name)}.json`);
                    return;
                }
                case 'png': {
                    await busy(btn, async () => {
                        const { json } = prepareCard(p, app.settings, card);
                        const blob = await buildPngCard(json, card.avatarDataUrl ? await dataUrlToBlob(card.avatarDataUrl) : null);
                        downloadFile(blob, `${safeFileName(card.data.name)}.png`, 'image/png');
                    });
                    return;
                }
                case 'delete':
                    if (!(await confirmDialog(`删除角色卡「${card.data.name}」？（不会删除酒馆里已写入的角色）`, { danger: true, okLabel: '删除' }))) return;
                    p.cards.splice(p.cards.indexOf(card), 1);
                    await app.saveNow();
                    return render();
                case 'group-generate': {
                    if (groupForm.members.size < 2) return app.log('请至少勾选两个角色', 'warn');
                    const g = await busy(btn, () => generateGroupCard(p, app.settings, groupOpts(), { onLog: (m) => app.log(m) }), 'AI 设计中…');
                    if (!g) return;
                    p.groupCards.push(g);
                    await app.saveNow();
                    app.log(`👥 已生成群聊场景「${g.name}」`, 'success');
                    render();
                    return editGroupCard(g);
                }
                case 'group-preview': {
                    if (groupForm.members.size < 2) return app.log('请至少勾选两个角色', 'warn');
                    try {
                        const { system, prompt } = buildGroupPrompt(p, app.settings, groupOpts());
                        await openDialog({ title: '群聊场景提示词预览', wide: true, body: chainPreviewHtml(app.settings, 'card', { system, prompt, book: p.bookName }) });
                    } catch (err) {
                        app.log(err.message, 'error');
                    }
                    return;
                }
                case 'group-edit': {
                    const g = p.groupCards.find((x) => x.id === btn.dataset.gid);
                    if (g) await editGroupCard(g);
                    return;
                }
                case 'group-publish': {
                    const g = p.groupCards.find((x) => x.id === btn.dataset.gid);
                    if (!g) return;
                    await busy(btn, async () => {
                        await publishGroupCard(g, resolveAvatar);
                        await app.saveNow();
                        app.log(`👥 群聊「${g.name}」已${g.stGroupId ? '更新' : '创建'}`, 'success');
                        globalThis.toastr?.success(`群聊「${g.name}」已写入酒馆`, 'NovelLoom');
                    }, '写入中…');
                    return render();
                }
                case 'group-md': {
                    const g = p.groupCards.find((x) => x.id === btn.dataset.gid);
                    if (!g) return;
                    try {
                        await navigator.clipboard.writeText(groupCardMarkdown(g));
                        app.log('📋 已复制到剪贴板', 'success');
                    } catch {
                        downloadFile(groupCardMarkdown(g), `${safeFileName(g.name)}.md`, 'text/markdown');
                    }
                    return;
                }
                case 'group-delete': {
                    const g = p.groupCards.find((x) => x.id === btn.dataset.gid);
                    if (!g) return;
                    if (!(await confirmDialog(`删除群聊场景卡「${g.name}」？（不会删除酒馆里已创建的群聊）`, { danger: true, okLabel: '删除' }))) return;
                    p.groupCards.splice(p.groupCards.indexOf(g), 1);
                    await app.saveNow();
                    return render();
                }
                default:
                    break;
            }
        };

        const onFormChange = (e) => {
            if (e.target.hasAttribute('data-group-member')) {
                if (e.target.checked) groupForm.members.add(e.target.value);
                else groupForm.members.delete(e.target.value);
                return;
            }
            const gk = e.target.dataset.groupForm;
            if (gk) {
                groupForm[gk] = e.target.value;
                return;
            }
            const k = e.target.dataset.form;
            if (!k) return;
            form[k] = e.target.value;
            if (k === 'kind') render();
        };

        el.addEventListener('click', onClick);
        el.addEventListener('change', onFormChange);
        el.addEventListener('input', onFormChange);
        render();
        return {};
    },
};

