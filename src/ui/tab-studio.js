// 创意工坊页：从一句创意出发，一步步做成一张群像世界/旁白卡（数据、提示词与 AI 调用见 studio.js / studio-base.js）。
//   上面是这个项目里的构思草稿（打开 / 重命名 / 删除 / 新建构思），下面是打开的那份构思的四步：
//   1 创意 → 2 大纲 → 3 角色与开场白 → 4 生成卡（可以回到前面的步骤；后面的步骤要等前面的内容有了才能进）。
//   没打开项目时也能写创意：点「生成大纲」时新建一个原创项目（用创意的标题命名）放这份构思；打开的是小说项目时可以选放进哪里。
//   长任务（生成大纲、全部生成、展开一个角色、重写一项、写一段开场白、生成卡）都走 app.runStudioJob：
//   标题栏显示进度和「停止」，切到别的页面再回来仍能看到进度（每一步的进展由 app.events 的 'studio:progress' 通知）。
//   编辑随写随存：输入停顿一会儿、离开输入框时写回草稿（规整：年龄写成未满 18 岁的改成 18 岁、立绘提示词补上 adult）并保存。
//   重绘时保留输入焦点、光标和没写回的原样文字（长任务每完成一项都会重绘，不打断正在写的内容）；输入法选词期间不重绘。
//   AI 写的内容一律当作不可信的文字：转义后显示。

import { app } from '../app.js';
import { errorText } from '../llm.js';
import { projectHasSource } from '../original.js';
import { ORIENTATION_CUSTOM, getOrientationTemplate } from '../orientation.js';
import { createEmptyProject } from '../project.js';
import { publishCard } from '../publish.js';
import { getStatusBarTemplate } from '../statusbar-templates.js';
import {
    OUTLINE_MODE_LABELS, STUDIO_LIMITS, STUDIO_OPENER_LENS, STUDIO_STEPS, STUDIO_UNTITLED, addStudio, adultAge, assembleStudioCard, buildCharacterPrompt,
    buildExamplePrompt, buildOpenerPrompt, buildOutlinePrompt, buildStudioCard, castAgeText, createStudio, defaultStudioOptions, emptyDetails, generateCharacter,
    generateExample, generateOpener, generateOutline, generateStudioContent, getStudio, listStudios, outlineRerollImpact, premiseCastCount, removeStudio,
    renameStudio, rerollCharacterField, studioAddCast, studioAddLocation, studioAddStage, studioCardSummary, studioCastStatus, studioDetailField,
    studioCardStale, studioExistingCard, studioHasOutline, studioMoveStage, studioOpenerStatus, studioOrientation, studioOutlineTouched, studioPortraitPromptsText,
    studioProgress, studioRemoveCast, studioRemoveLocation, studioRemoveStage, studioRenameCastPatch, studioSavePlan, studioSetLocked, studioStageLabel, studioStatusBarTemplateId,
    studioStepEnabled, studioTitleFromPremise, updateStudio,
} from '../studio.js';
import { defaultUserProfile, getUserProfile, listUserProfiles } from '../userprofile.js';
import { debounce, isAbortError } from '../utils.js';
import { alertDialog, busy, chainPreviewHtml, confirmDialog, esc, fmtTime, getPath, icon, openDialog, optionList, promptDialog, rerollBtn, setPath } from './common.js';
import { openOrientationTemplatesDialog } from './orientation-dialog.js';
import { generateStatusBarForCard, openStatusBarPublishHint, statusBarTagHtml } from './statusbar-dialog.js';
import { orientationOptionsHtml, userProfileFormNote, userProfileOptionsHtml } from './tab-cards.js';
import { openUserProfilesDialog } from './tab-profiles.js';

// ---------------- 页面状态 ----------------

/**
 * 切到别的页再回来保留：哪个项目、打开的构思（'' = 新构思表单）、第 3 步选中的标签（角色 id / 'openers' / 'example'）、
 * 新构思表单里写了一半的内容、第 4 步撞名时的选择
 */
const view = { projectId: null, studioId: '', tab: '', draft: null, collision: 'suffix', publishing: false };

/** 新构思表单（还没存进项目）：创意 + 选项；target：打开的是小说项目时放进哪里（new = 新建原创项目 / current = 当前项目） */
function freshDraft() {
    const def = defaultUserProfile(app.settings);
    return { premise: '', options: { ...defaultStudioOptions(app.settings), profileId: def?.id || '' }, target: 'new' };
}

function draftTitle(s) {
    return s?.title || s?.outline?.title || studioTitleFromPremise(s?.premise) || STUDIO_UNTITLED;
}

/** 最近改过的那份构思 */
function latestStudio(p) {
    return listStudios(p).slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0] || null;
}

/** 项目换了（或刚打开页面）：打开最近改过的构思；从角色卡页「在创意工坊打开」过来时打开那一份 */
function syncView() {
    const p = app.project;
    const pid = p?.id || '';
    if (view.projectId !== pid) {
        view.projectId = pid;
        view.studioId = latestStudio(p)?.id || '';
        view.tab = '';
    }
    if (app.pendingStudioId !== undefined) {
        const id = app.pendingStudioId;
        delete app.pendingStudioId;
        if (p && getStudio(p, id)) {
            view.studioId = id;
            view.tab = '';
        } else if (id) {
            app.log('这张卡的构思已经不在这个项目里了（可能被删掉了）', 'warn');
        }
    }
    if (view.studioId && !getStudio(p, view.studioId)) view.studioId = latestStudio(p)?.id || '';
    if (!view.studioId && !view.draft) view.draft = freshDraft();
}

function current() {
    return app.project && view.studioId ? getStudio(app.project, view.studioId) : null;
}

/** 这份构思正在运行的长任务（没有时 null） */
function jobFor(s) {
    const j = app.studioJob;
    return j && s && j.studioId === s.id && j.projectId === (app.project?.id || '') ? j : null;
}

function emitProgress() {
    app.events.emit('studio:progress', app.studioJob);
}

const log = (m, l) => app.log(m, l);

const sbCtx = () => ({ app, project: app.project, settings: app.settings, save: () => app.saveNow(), saveSettings: () => app.saveSettings(), onChange: () => {} });

/**
 * 运行一个创意工坊长任务（见 app.runStudioJob）：同一时间只有一个；运行中切换 / 关闭了项目就停下。
 * 出错时弹出原因（带 AI 原始输出的节选）；停止时记一句，已经写好的保留。结束后保存项目（还是同一个项目时）。
 * @param {object} s 构思
 * @param {{label: string, kind: string, target?: string, field?: string}} meta kind：outline / content / character / field / opener / example / build
 * @param {(signal: AbortSignal) => Promise<any>} fn
 * @returns {Promise<any>} fn 的结果；出错或停止时 undefined
 */
async function runJob(s, meta, fn) {
    if (app.studioJob) {
        app.log('创意工坊已经有任务在运行：等它结束，或点标题栏的「停止」', 'warn');
        return undefined;
    }
    const p = app.project;
    let detached = false;
    const off = app.events.on('project', (np) => {
        if (np === p || detached) return;
        detached = true;
        app.stopStudioJob();
    });
    try {
        return await app.runStudioJob({ studioId: s.id, label: meta.label }, (signal) => {
            Object.assign(app.studioJob, { kind: meta.kind, target: meta.target || '', field: meta.field || '', current: meta.target || '', progress: null });
            emitProgress();
            return fn(signal);
        });
    } catch (e) {
        if (isAbortError(e) || detached) {
            app.log(detached ? `项目已切换，「${draftTitle(s)}」的${meta.label}已停止` : `已停止：${meta.label}（已经写好的内容保留）`, 'warn');
            return undefined;
        }
        console.error('[NovelLoom]', e);
        app.log(`${meta.label}没有完成：${errorText(e)}`, 'error');
        await alertDialog(`${errorText(e)}${e?.raw ? `\n\nAI 原始输出（节选）：\n${String(e.raw).slice(0, 800)}` : ''}`, '出错了');
        return undefined;
    } finally {
        off();
        if (!detached && app.project === p) await app.saveNow();
        app.events.emit('studio:progress', null);
        app.events.emit('nav');
    }
}

/** 重新生成前的对话框：说明会清掉什么（warn），可以写额外要求。取消时 null，否则是额外要求（可能是空字符串） */
async function rerollDialog({ title, message = '', warn = '', okLabel = '重新生成', placeholder = '' }) {
    const { value, root } = await openDialog({
        title,
        body: `${warn ? `<div class="nl-sb-note nl-sb-note-warn" role="alert">${icon('alert')}<div class="nl-grow">${esc(warn)}</div></div>` : ''}
            ${message ? `<div class="nl-card-desc nl-st-dialog-msg">${esc(message)}</div>` : ''}
            <div class="nl-field"><label for="nl-st-ins">额外要求 <span class="nl-muted">（可选，留空则让 AI 自行发挥）</span></label>
            <textarea class="nl-input nl-textarea" id="nl-st-ins" rows="3" maxlength="500" placeholder="${esc(placeholder)}"></textarea></div>`,
        buttons: [{ label: '取消', value: null }, { label: okLabel, value: 'ok', primary: true }],
    });
    if (value !== 'ok') return null;
    return String(root.querySelector('textarea')?.value || '').trim();
}

/** 复制到剪贴板：剪贴板不可用时退回到选中文字复制，再不行就弹出文字让用户自己复制 */
async function copyText(text, what) {
    const t = String(text || '');
    if (!t) return app.log(`没有可以复制的${what}`, 'warn');
    try {
        await navigator.clipboard.writeText(t);
        return app.log(`📋 已复制${what}`, 'success');
    } catch { /* 退回 */ }
    try {
        const ta = document.createElement('textarea');
        ta.value = t;
        ta.setAttribute('readonly', '');
        ta.style.cssText = 'position:fixed;left:-9999px;top:0';
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand('copy');
        ta.remove();
        if (ok) return app.log(`📋 已复制${what}`, 'success');
    } catch { /* 退回 */ }
    await openDialog({ title: `复制${what}`, body: `<div class="nl-field"><label for="nl-st-copy">剪贴板不可用，请手动全选复制：</label><textarea class="nl-input nl-textarea nl-mono" id="nl-st-copy" rows="8" readonly>${esc(t)}</textarea></div>` });
    return undefined;
}

// ---------------- 小部件 ----------------

const STATUS_DOT = { empty: ['nl-dot', '未生成'], partial: ['nl-dot nl-warn', '部分填写'], done: ['nl-dot nl-ok', '完成'], error: ['nl-dot nl-err', '出错'] };

function dotHtml(st) {
    if (st === 'running') return '<span class="nl-spin nl-accent-ink nl-st-spin" role="img" aria-label="生成中" title="生成中"></span>';
    const [cls, label] = STATUS_DOT[st] || STATUS_DOT.empty;
    return `<span class="${cls}" role="img" aria-label="${label}" title="${label}"></span>`;
}

/** 一个角色 / 阶段 / 示例对话现在的状态：running（正在生成）/ done / error / empty */
function itemStatus(s, id, kind) {
    if (jobFor(s)?.current === id) return 'running';
    if (kind === 'cast') return studioCastStatus(s, id);
    if (kind === 'stage') return studioOpenerStatus(s, id);
    if (String(s.example || '').trim()) return 'done';
    return s.errors?.example ? 'error' : 'empty';
}

/** 标题栏里的进度文字 */
function progressText(job) {
    const pr = job?.progress;
    if (job?.kind === 'content' && pr) {
        const what = { character: '展开角色', opener: '写开场白', example: '写示例对话' }[pr.phase] || '生成';
        return pr.phase === 'example' ? `${what}…` : `${what} ${pr.index + 1}/${pr.total}：${pr.name}`;
    }
    return `${job?.label || '生成中'}…`;
}

/** 第 3 步的整体进度：角色 + 开场白 + 示例对话（选了时） */
function overallProgress(s) {
    const pr = studioProgress(s);
    const ex = s.options.examples ? 1 : 0;
    const total = pr.cast + pr.stages + ex;
    const done = pr.castDone + pr.openersDone + (ex && pr.example ? 1 : 0);
    return { ...pr, done, total };
}

/** 这一步算不算做完了（步骤条上打勾） */
function stepDone(s, step) {
    if (!s) return false;
    if (step === 1 || step === 2) return studioHasOutline(s);
    if (step === 3) {
        const pr = studioProgress(s);
        return pr.cast > 0 && pr.castDone === pr.cast && pr.openersDone === pr.stages;
    }
    // 草稿改过、卡还没更新时第 4 步不打勾
    return !!studioExistingCard(app.project, s) && !studioCardStale(app.project, app.settings, s);
}

/** 做好的卡的标签：已生成卡（绿色），草稿改过、卡还没更新时换成提醒（琥珀色） */
function cardTagHtml(p, s) {
    if (!studioExistingCard(p, s)) return '';
    return studioCardStale(p, app.settings, s)
        ? '<span class="nl-tag nl-warn" title="草稿改过之后还没点「更新卡片」：角色卡页和酒馆里的还是旧的内容">草稿改过，卡还没更新</span>'
        : '<span class="nl-tag nl-ok" title="已经做成卡（在「角色卡」页）">已生成卡</span>';
}

/** 打开的构思：标题、概况、重命名 / 删除（新构思时只有标题） */
function headHtml(s) {
    if (!s) return '<div class="nl-st-head"><h3>新的构思</h3><span class="nl-muted nl-small">写下创意，生成大纲后存进草稿</span></div>';
    const t = draftTitle(s);
    return `
    <div class="nl-st-head">
        <h3>${esc(t)}</h3>
        <span class="nl-muted nl-small nl-num">${s.outline.cast.length ? `${s.outline.cast.length} 个角色 · ${s.outline.stages.length} 个阶段 · ` : ''}更新于 ${esc(fmtTime(s.updatedAt))}</span>
        ${cardTagHtml(app.project, s)}
        <span class="nl-spacer"></span>
        <button class="nl-icon-btn" data-act="rename" data-id="${esc(s.id)}" title="重命名构思" aria-label="重命名「${esc(t)}」">${icon('edit')}</button>
        <button class="nl-icon-btn nl-danger" data-act="delete" data-id="${esc(s.id)}" title="删除构思" aria-label="删除「${esc(t)}」">${icon('trash')}</button>
    </div>`;
}

/** 步骤条；shown：现在显示的是哪一步（草稿记的步骤进不去时显示的是第 1 步） */
function stepperHtml(s, shown = 1) {
    const cur = shown;
    const why = { 2: '先生成大纲', 3: '大纲里还要有名字的角色和至少一个阶段', 4: '先在第 3 步写好至少一段开场白' };
    return `<nav class="nl-st-stepper" aria-label="构思步骤"><ol class="nl-st-steps">${STUDIO_STEPS.map((st) => {
        const on = st.value === cur;
        const enabled = s ? studioStepEnabled(s, st.value) : st.value === 1;
        const done = stepDone(s, st.value);
        const title = enabled ? `第 ${st.value} 步：${st.label}` : `第 ${st.value} 步：${st.label}（${why[st.value]}）`;
        return `<li><button type="button" class="nl-st-step${done ? ' is-done' : ''}" data-act="goto-step" data-step="${st.value}" ${on ? 'aria-current="step"' : ''} ${enabled ? '' : 'disabled'} title="${esc(title)}">`
            + `<span class="nl-st-step-mark">${done && !on ? icon('check', { size: 12 }) : st.value}</span><span class="nl-st-step-name">${esc(st.label)}</span></button></li>`;
    }).join('')}</ol></nav>`;
}

/**
 * 草稿列表：项目里有两份以上构思（或者正在写新构思、项目里已经有构思）时才显示——只有一份时，它就是下面打开的那份
 * （标题、重命名、删除都在步骤条上面那一栏）
 */
function draftsHtml(p) {
    const list = listStudios(p).slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    if (list.length < (view.studioId ? 2 : 1)) return '';
    return `
    <section class="nl-card" data-st-drafts>
        <div class="nl-card-head">
            <div><h3>全部构思（${list.length}）</h3><div class="nl-card-desc">每份构思一步步做成一张群像世界卡；草稿跟着项目保存，随时回来接着改。</div></div>
        </div>
        <div class="nl-list nl-st-drafts">
            ${list.map((s) => {
                const active = s.id === view.studioId;
                const step = STUDIO_STEPS.find((x) => x.value === s.step) || STUDIO_STEPS[0];
                const t = draftTitle(s);
                const running = !!jobFor(s);
                return `
                <div class="nl-list-item nl-st-draft${active ? ' active' : ''}">
                    <button type="button" class="nl-st-draft-open" data-act="open" data-id="${esc(s.id)}" ${active ? 'aria-current="true"' : ''}>
                        <span class="nl-st-draft-title">${esc(t)}</span>
                        <span class="nl-muted nl-small nl-num">第 ${step.value} 步 · ${esc(step.label)}${s.outline.cast.length ? ` · ${s.outline.cast.length} 个角色` : ''} · ${esc(fmtTime(s.updatedAt))}</span>
                    </button>
                    ${running ? '<span class="nl-spin nl-accent-ink" role="img" aria-label="正在生成" title="正在生成"></span>' : ''}
                    ${cardTagHtml(p, s)}
                    <button class="nl-icon-btn" data-act="rename" data-id="${esc(s.id)}" title="重命名" aria-label="重命名「${esc(t)}」">${icon('edit')}</button>
                    <button class="nl-icon-btn nl-danger" data-act="delete" data-id="${esc(s.id)}" title="删除" aria-label="删除「${esc(t)}」">${icon('trash')}</button>
                </div>`;
            }).join('')}
        </div>
    </section>`;
}

// ---------------- 第 1 步：创意 ----------------

const USER_ROLE_OPTIONS = [{ value: 'new', label: '原创新身份（默认）' }, { value: 'custom', label: '自定义' }];

function premiseNote(premise) {
    const n = premiseCastCount(premise);
    return n
        ? `创意里写了 ${n} 个人：大纲会正好设计 ${n} 个角色（不含 {{user}}；下面的「人数」可以改）。`
        : '写得越具体（人数、身份、关系、处境），AI 越照办；没写到的由 AI 补全。';
}

function userRoleNote(kind) {
    return kind === 'custom'
        ? '按这段身份设计大纲；卡自己的世界书里会加一条「{{user}} 的身份」。'
        : '{{user}} 以符合创意的新身份出现：AI 在大纲里安排 TA 的身份和切入点（第 2 步可以改）。';
}

/**
 * 第 1 步的表单：src 是新构思表单（view.draft）或打开的构思（字段同 studio.premise / studio.options）
 * @param {object} src
 * @param {{s: object|null}} opt s：打开的构思（新构思时为 null）
 */
function step1Html(src, { s = null } = {}) {
    const p = app.project;
    const o = src.options;
    const n = premiseCastCount(src.premise);
    const profiles = listUserProfiles(app.settings);
    const prof = o.profileId ? getUserProfile(app.settings, o.profileId) : null;
    const orientId = o.orientationId && (o.orientationId === ORIENTATION_CUSTOM || getOrientationTemplate(app.settings, o.orientationId)) ? o.orientationId : '';
    const tpl = orientId && orientId !== ORIENTATION_CUSTOM ? getOrientationTemplate(app.settings, orientId) : null;
    const role = o.userRole?.kind === 'custom' ? 'custom' : 'new';
    const hasOutline = !!s && studioOutlineTouched(s);
    const running = !!app.studioJob;
    // 新构思放在哪里：没打开项目 → 新建原创项目；打开的是小说项目 → 让用户选
    let place = '';
    if (!s && !p) {
        place = `<div class="nl-sb-note" data-st-place>${icon('info')}<div class="nl-grow">还没有打开项目：点「生成大纲」时会新建一个原创项目（用创意的标题命名）存放这份构思，做成卡时角色和地点也存进这个项目。</div></div>`;
    } else if (!s && projectHasSource(p)) {
        const t = view.draft.target === 'current' ? 'current' : 'new';
        place = `
        <div class="nl-field" data-st-place>
            <label id="nl-st-target-l">存放到</label>
            <div class="nl-seg" role="group" aria-labelledby="nl-st-target-l" aria-describedby="nl-st-target-note">
                <button type="button" class="nl-seg-btn ${t === 'new' ? 'active' : ''}" aria-pressed="${t === 'new'}" data-act="target" data-val="new">新建原创项目</button>
                <button type="button" class="nl-seg-btn ${t === 'current' ? 'active' : ''}" aria-pressed="${t === 'current'}" data-act="target" data-val="current">当前项目「${esc(p.name)}」</button>
            </div>
            <div class="nl-muted nl-small" id="nl-st-target-note">做成卡时，角色和地点会存进项目（手动角色 / 条目）。放进小说项目会和原著资料放在一起；和原著无关的故事建议新建原创项目。</div>
        </div>`;
    }
    return `
    <section class="nl-card" data-st-step1>
        <div class="nl-card-head">
            <div><h3>创意</h3><div class="nl-card-desc">写下你想要的故事：AI 先设计大纲（世界观、角色阵容、故事阶段），你确认后再逐个展开角色、为每个阶段写开场白，最后做成一张世界/旁白卡（{{char}} 是旁白，扮演所有角色）。</div></div>
        </div>
        <div class="nl-field">
            <label for="nl-st-premise">你的创意 <span class="nl-muted">（必填，一句话也行）</span></label>
            <textarea class="nl-input nl-textarea" id="nl-st-premise" rows="4" data-sf="premise" maxlength="${STUDIO_LIMITS.premise}" aria-required="true" aria-describedby="nl-st-premise-note" placeholder="例如：我想做一张飞机失事，在荒岛上和 7 个美女共同求生的故事">${esc(src.premise)}</textarea>
            <div class="nl-muted nl-small" id="nl-st-premise-note" data-st-premise-note>${esc(premiseNote(src.premise))}</div>
        </div>
        <div class="nl-grid3">
            <div class="nl-field"><label for="nl-st-count">人数 <span class="nl-muted">（可选）</span></label>
                <input class="nl-input" id="nl-st-count" type="number" min="1" max="${STUDIO_LIMITS.cast}" data-sf="options.count" value="${esc(o.count)}" placeholder="${n ? `按创意：${n} 人` : 'AI 决定'}"></div>
            <div class="nl-field"><label for="nl-st-stages">阶段数 <span class="nl-muted">（可选）</span></label>
                <input class="nl-input" id="nl-st-stages" type="number" min="2" max="${STUDIO_LIMITS.stages}" data-sf="options.stages" value="${esc(o.stages)}" placeholder="AI 决定（4-6 个）"></div>
            <div class="nl-field"><label for="nl-st-olen">开场白长度</label>
                <input class="nl-input" id="nl-st-olen" list="nl-st-olens" data-sf="options.openerLen" maxlength="${STUDIO_LIMITS.openerLen}" value="${esc(o.openerLen)}">
                <datalist id="nl-st-olens">${STUDIO_OPENER_LENS.map((x) => `<option value="${esc(x)}"></option>`).join('')}</datalist></div>
        </div>
        <div class="nl-grid2">
            <div class="nl-field">
                <label for="nl-st-profile">用户画像 <span class="nl-muted">（按你的口味量身定制）</span></label>
                <div class="nl-row">
                    <select class="nl-input nl-grow" id="nl-st-profile" data-sf="options.profileId" aria-describedby="nl-st-profile-note">${userProfileOptionsHtml(app.settings, prof ? prof.id : '')}</select>
                    <button class="nl-btn nl-sm" data-act="profile-manage" title="新建、修改、导入导出用户画像">${icon('profile', { size: 14 })}管理用户画像</button>
                </div>
                <div class="nl-muted nl-small" id="nl-st-profile-note">${esc(userProfileFormNote(prof, profiles.length > 0, true, true, app.settings))}</div>
            </div>
            <div class="nl-field">
                <label for="nl-st-orient">卡的导向</label>
                <div class="nl-row">
                    <select class="nl-input nl-grow" id="nl-st-orient" data-sf="options.orientationId" aria-describedby="nl-st-orient-note">${orientationOptionsHtml(app.settings, orientId)}</select>
                    <button class="nl-btn nl-sm" data-act="orientation-manage" title="查看内置导向，新建、修改、导入导出自己的导向模板">${icon('settings', { size: 14 })}管理导向模板</button>
                </div>
                <div class="nl-orient-custom" ${orientId === ORIENTATION_CUSTOM ? '' : 'hidden'}>
                    <input class="nl-input" data-sf="options.orientationName" aria-label="导向名称" maxlength="${STUDIO_LIMITS.orientationName}" placeholder="导向名称，例如「荒岛恋曲」" value="${esc(o.orientationName)}">
                    <textarea class="nl-input nl-textarea" rows="2" data-sf="options.orientationBrief" aria-label="导向说明" maxlength="${STUDIO_LIMITS.orientationBrief}" placeholder="说明这次想要的剧情方向">${esc(o.orientationBrief)}</textarea>
                </div>
                <div class="nl-muted nl-small" id="nl-st-orient-note">${esc(tpl ? tpl.brief : orientId === ORIENTATION_CUSTOM ? '自定义导向：写进卡自己世界书里的「剧情导向」条目。' : '不限：按创意和你的要求写。')}</div>
            </div>
        </div>
        <div class="nl-grid2">
            <div class="nl-field">
                <label for="nl-st-role">{{user}} 的身份</label>
                <select class="nl-input" id="nl-st-role" data-sf="options.userRole.kind" aria-describedby="nl-st-role-note">${optionList(USER_ROLE_OPTIONS, role)}</select>
                <textarea class="nl-input nl-textarea" rows="2" data-sf="options.userRole.text" aria-label="{{user}} 的身份" maxlength="${STUDIO_LIMITS.userRoleText}" placeholder="例如：{{user}} 是这趟航班的副机长，二十八岁，懂一点急救" ${role === 'custom' ? '' : 'hidden'}>${esc(o.userRole?.text || '')}</textarea>
                <div class="nl-muted nl-small" id="nl-st-role-note">${esc(userRoleNote(role))}</div>
            </div>
            <div class="nl-field">
                <label for="nl-st-extra">额外要求 <span class="nl-muted">（可选）</span></label>
                <textarea class="nl-input nl-textarea" id="nl-st-extra" rows="3" data-sf="options.extra" maxlength="${STUDIO_LIMITS.extra}" placeholder="例如：基调偏轻松，有一点悬疑；每个人都有一技之长；第二人称叙述">${esc(o.extra)}</textarea>
            </div>
        </div>
        <div class="nl-row nl-wrap nl-checks">
            <label><input type="checkbox" data-sf="options.examples" ${o.examples ? 'checked' : ''}> 写示例对话 <span class="nl-muted">（示范旁白怎么替不同的角色说话）</span></label>
        </div>
        ${place}
        <div class="nl-row nl-wrap">
            <button class="nl-btn nl-primary" data-act="outline" ${running ? 'disabled' : ''}>${hasOutline ? `${icon('dice', { size: 14 })}重新生成大纲` : '生成大纲'}</button>
            <button class="nl-btn" data-act="preview" data-what="outline">预览提示词</button>
            ${hasOutline ? '<span class="nl-spacer"></span><button class="nl-btn" data-act="goto-step" data-step="2">查看大纲</button>' : ''}
        </div>
    </section>`;
}

// ---------------- 第 2 步：大纲 ----------------

/**
 * 正在重新生成大纲的哪些部分（这份构思的大纲任务；没有时都是 false）：这些部分完成前只读，免得改了又被结果盖掉。
 * @returns {{world: boolean, cast: (m: object) => boolean, stages: boolean, notes: boolean, label: string}}
 */
function outlineLocks(s) {
    const job = jobFor(s);
    const t = job?.kind === 'outline' ? job.target || 'all' : '';
    const member = t && !['all', 'world', 'cast', 'stages'].includes(t) ? s.outline.cast.find((c) => c.id === t) : null;
    return {
        world: t === 'all' || t === 'world',
        cast: (m) => (!m.locked && (t === 'all' || t === 'cast')) || (!!member && m.id === member.id),
        stages: t === 'all' || t === 'stages',
        notes: t === 'all' || t === 'cast',
        label: !t ? '' : member ? `正在换掉「${member.name || '这个角色'}」` : `正在重新生成${OUTLINE_MODE_LABELS[t] || '大纲'}`,
    };
}

/** 一格带小标题的输入（窄屏时显示小标题：表头在窄屏放不下） */
function cell(cls, cap, control) {
    return `<label class="nl-st-cell ${cls}"><span class="nl-st-cap" aria-hidden="true">${cap}</span>${control}</label>`;
}

function locRowHtml(l, i, ro) {
    const r = ro ? 'readonly' : '';
    return `
    <div class="nl-st-loc">
        <input class="nl-input" data-loc="${i}" data-lf="name" maxlength="${STUDIO_LIMITS.locationName}" value="${esc(l.name)}" placeholder="地点名" aria-label="第 ${i + 1} 个地点的名字" ${r}>
        <textarea class="nl-input nl-textarea" rows="2" data-loc="${i}" data-lf="desc" maxlength="${STUDIO_LIMITS.locationDesc}" placeholder="样子、用途、在故事里的作用" aria-label="第 ${i + 1} 个地点的说明" ${r}>${esc(l.desc)}</textarea>
        <button class="nl-icon-btn nl-danger" data-act="loc-remove" data-i="${i}" title="删除这个地点" aria-label="删除地点「${esc(l.name || `第 ${i + 1} 个`)}」" ${ro ? 'disabled' : ''}>${icon('trash')}</button>
    </div>`;
}

function memberRowHtml(s, m, i, running, ro) {
    const name = m.name || `第 ${i + 1} 个角色`;
    const filled = studioCastStatus(s, m.id) === 'done';
    const r = ro ? 'readonly' : '';
    const input = (cf, cls, cap, label, attrs) => cell(cls, cap, `<input class="nl-input" data-cast="${esc(m.id)}" data-cf="${cf}" ${attrs} aria-label="${esc(label)}" title="${esc(label)}" ${r}>`);
    return `
    <div class="nl-st-member${m.locked ? ' is-locked' : ''}">
        <span class="nl-st-num" aria-hidden="true">${i + 1}</span>
        ${input('name', 'nl-st-m-name', '名字', `第 ${i + 1} 个角色的名字`, `maxlength="${STUDIO_LIMITS.name}" value="${esc(m.name)}" placeholder="名字"`)}
        ${input('gender', 'nl-st-m-gender', '性别', `${name}的性别`, `maxlength="${STUDIO_LIMITS.gender}" value="${esc(m.gender)}" placeholder="性别"`)}
        ${input('age', 'nl-st-m-age', '年龄', `${name}的年龄（18 岁以上）`, `maxlength="${STUDIO_LIMITS.age}" value="${esc(m.age)}" placeholder="年龄（成年）"`)}
        ${input('identity', 'nl-st-m-ident', '身份', `${name}的身份`, `maxlength="${STUDIO_LIMITS.identity}" value="${esc(m.identity)}" placeholder="身份 / 职业"`)}
        <div class="nl-st-acts">
            <button class="nl-icon-btn nl-st-lock${m.locked ? ' is-on' : ''}" data-act="cast-lock" data-id="${esc(m.id)}" aria-pressed="${m.locked}" title="${m.locked ? '已锁定：重新生成角色阵容时原样保留（点一下解锁）' : '锁定：重新生成角色阵容时原样保留'}" aria-label="锁定「${esc(name)}」" ${ro ? 'disabled' : ''}>${icon(m.locked ? 'lock' : 'unlock')}</button>
            ${rerollBtn('reroll-member', `data-id="${esc(m.id)}" ${running || m.locked ? 'disabled' : ''}`, { title: m.locked ? '已锁定：先解锁才能换掉' : `换掉「${name}」：换成一个新的人物${filled ? '（已经展开的细节会清掉）' : ''}` })}
            <button class="nl-icon-btn nl-danger" data-act="cast-remove" data-id="${esc(m.id)}" title="删除这个角色" aria-label="删除「${esc(name)}」" ${ro ? 'disabled' : ''}>${icon('trash')}</button>
        </div>
        ${input('oneLiner', 'nl-st-m-line', '一句话人设', `${name}的一句话人设`, `maxlength="${STUDIO_LIMITS.oneLiner}" value="${esc(m.oneLiner)}" placeholder="一句话人设：性格底色 + 在群体里的作用"`)}
        ${input('tags', 'nl-st-m-tags', '标签', `${name}的标签`, `value="${esc(m.tags.join('、'))}" placeholder="标签，用顿号隔开"`)}
    </div>`;
}

function stageRowHtml(st, i, n, ro) {
    const name = st.name || `第 ${i + 1} 阶段`;
    const r = ro ? 'readonly' : '';
    const dis = ro ? 'disabled' : '';
    return `
    <div class="nl-st-stage">
        <span class="nl-st-num" aria-hidden="true">${i + 1}</span>
        ${cell('nl-st-g-name', '阶段名', `<input class="nl-input" data-stage="${esc(st.id)}" data-gf="name" maxlength="${STUDIO_LIMITS.stageName}" value="${esc(st.name)}" placeholder="阶段名" aria-label="第 ${i + 1} 阶段的名字" title="第 ${i + 1} 阶段的名字" ${r}>`)}
        ${cell('nl-st-g-time', '时间', `<input class="nl-input" data-stage="${esc(st.id)}" data-gf="time" maxlength="${STUDIO_LIMITS.stageTime}" value="${esc(st.time)}" placeholder="时间，如「第 1 天」" aria-label="${esc(name)}的时间" title="${esc(name)}的时间" ${r}>`)}
        <div class="nl-st-acts">
            <button class="nl-icon-btn" data-act="stage-up" data-id="${esc(st.id)}" title="上移" aria-label="上移「${esc(name)}」" ${i === 0 || ro ? 'disabled' : ''}>${icon('arrowUp')}</button>
            <button class="nl-icon-btn" data-act="stage-down" data-id="${esc(st.id)}" title="下移" aria-label="下移「${esc(name)}」" ${i === n - 1 || ro ? 'disabled' : ''}>${icon('arrowDown')}</button>
            <button class="nl-icon-btn nl-danger" data-act="stage-remove" data-id="${esc(st.id)}" title="删除这个阶段" aria-label="删除「${esc(name)}」" ${dis}>${icon('trash')}</button>
        </div>
        <label class="nl-st-mini nl-st-g-sum"><span class="nl-st-mini-cap">处境和走向</span><textarea class="nl-input nl-textarea" rows="2" data-stage="${esc(st.id)}" data-gf="summary" maxlength="${STUDIO_LIMITS.stageSummary}" placeholder="这一阶段的处境和大致走向" aria-label="${esc(name)}的处境和走向" ${r}>${esc(st.summary)}</textarea></label>
        <label class="nl-st-mini nl-st-g-conf"><span class="nl-st-mini-cap">核心冲突</span><textarea class="nl-input nl-textarea" rows="2" data-stage="${esc(st.id)}" data-gf="conflict" maxlength="${STUDIO_LIMITS.stageConflict}" placeholder="这一阶段的核心冲突或悬念" aria-label="${esc(name)}的核心冲突" ${r}>${esc(st.conflict)}</textarea></label>
    </div>`;
}

function step2Html(s) {
    const o = s.outline;
    const running = !!app.studioJob;
    const dis = running ? 'disabled' : '';
    const orient = studioOrientation(app.settings, s);
    const unlocked = o.cast.filter((c) => !c.locked).length;
    const lk = outlineLocks(s);
    const rw = lk.world ? 'readonly' : '';
    const lockNote = lk.label ? `<div class="nl-sb-note" role="status" data-st-outline-busy>${icon('info')}<div class="nl-grow">${esc(lk.label)}…（完成前不能编辑要重新生成的部分）</div></div>` : '';
    return `
    ${lockNote}
    <section class="nl-card">
        <div class="nl-card-head">
            <div><h3>故事与世界观</h3><div class="nl-card-desc">卡名、一句话故事、世界观、规则、基调和 {{user}} 的位置写进卡的描述，扮演时旁白一直遵守。</div></div>
            ${rerollBtn('reroll-outline', `data-mode="world" ${dis}`, { label: '重新生成世界观', title: '只重新生成卡名、一句话故事、世界观、地点和 {{user}} 的位置；角色和阶段不变' })}
        </div>
        <div class="nl-grid2">
            <div class="nl-field"><label for="nl-st-title">卡名</label><input class="nl-input" id="nl-st-title" data-sf="outline.title" maxlength="${STUDIO_LIMITS.title}" value="${esc(o.title)}" placeholder="例如「孤岛七日」" ${rw}></div>
            <div class="nl-field"><label for="nl-st-tone">基调</label><input class="nl-input" id="nl-st-tone" data-sf="outline.world.tone" maxlength="${STUDIO_LIMITS.tone}" value="${esc(o.world.tone)}" placeholder="基调与氛围，一句话" ${rw}></div>
        </div>
        <div class="nl-field"><label for="nl-st-logline">一句话故事</label><input class="nl-input" id="nl-st-logline" data-sf="outline.logline" maxlength="${STUDIO_LIMITS.logline}" value="${esc(o.logline)}" ${rw}></div>
        <div class="nl-grid2">
            <div class="nl-field"><label for="nl-st-setting">世界观</label><textarea class="nl-input nl-textarea" id="nl-st-setting" rows="6" data-sf="outline.world.setting" maxlength="${STUDIO_LIMITS.setting}" placeholder="时代、地点、处境的来龙去脉" ${rw}>${esc(o.world.setting)}</textarea></div>
            <div class="nl-field"><label for="nl-st-rules">世界规则</label><textarea class="nl-input nl-textarea" id="nl-st-rules" rows="6" data-sf="outline.world.rules" maxlength="${STUDIO_LIMITS.rules}" placeholder="这个处境里的硬规则，每行一条" ${rw}>${esc(o.world.rules)}</textarea></div>
        </div>
        <div class="nl-field"><label for="nl-st-userrole">{{user}} 的位置</label><textarea class="nl-input nl-textarea" id="nl-st-userrole" rows="3" data-sf="outline.userRole" maxlength="${STUDIO_LIMITS.userRole}" placeholder="{{user}} 在故事里的身份、为什么在场、和众人的关系、从哪里切入" ${rw}>${esc(o.userRole)}</textarea></div>
        ${orient || o.orientationNotes ? `<div class="nl-field"><label for="nl-st-onotes">导向落点 <span class="nl-muted">（「${esc(orient?.name || '剧情导向')}」在这个故事里怎么落地，写进「剧情导向」条目，也给写角色和开场白的 AI 看）</span></label><textarea class="nl-input nl-textarea" id="nl-st-onotes" rows="3" data-sf="outline.orientationNotes" placeholder="- ……" ${lk.notes ? 'readonly' : ''}>${esc(o.orientationNotes)}</textarea></div>` : ''}
    </section>

    <section class="nl-card">
        <div class="nl-card-head">
            <div><h3>主要地点（${o.world.locations.length}）</h3><div class="nl-card-desc">每个地点写成卡自己世界书里的一条，提到名字时调出。</div></div>
            <button class="nl-btn nl-sm" data-act="loc-add" ${o.world.locations.length >= STUDIO_LIMITS.locations || lk.world ? 'disabled' : ''}>${icon('plus', { size: 14 })}添加地点</button>
        </div>
        <div class="nl-st-locs">${o.world.locations.map((l, i) => locRowHtml(l, i, lk.world)).join('') || '<div class="nl-muted nl-small">还没有地点：可以重新生成世界观，或者手动添加。</div>'}</div>
    </section>

    <section class="nl-card">
        <div class="nl-card-head">
            <div><h3>角色阵容（${o.cast.length}/${STUDIO_LIMITS.cast}）</h3><div class="nl-card-desc">锁定的角色在重新生成阵容时原样保留。所有角色都是成年人：年龄写成未满 18 岁的会改成 18 岁。</div></div>
            <div class="nl-row nl-wrap">
                <button class="nl-btn nl-sm" data-act="cast-add" ${o.cast.length >= STUDIO_LIMITS.cast || lk.label ? 'disabled' : ''}>${icon('plus', { size: 14 })}添加角色</button>
                ${rerollBtn('reroll-outline', `data-mode="cast" ${dis || (unlocked ? '' : 'disabled')}`, { label: '重新生成阵容', title: '只重新生成没锁定的角色；世界观和阶段不变' })}
            </div>
        </div>
        <div class="nl-st-cast-head" aria-hidden="true"><span></span><span>名字 / 一句话人设</span><span>性别</span><span>年龄</span><span>身份 / 标签</span></div>
        <div class="nl-st-cast">${o.cast.map((m, i) => memberRowHtml(s, m, i, running, lk.cast(m))).join('') || '<div class="nl-muted nl-small">还没有角色：点「添加角色」，或者重新生成阵容。</div>'}</div>
    </section>

    <section class="nl-card">
        <div class="nl-card-head">
            <div><h3>故事阶段（${o.stages.length}/${STUDIO_LIMITS.stages}）</h3><div class="nl-card-desc">故事会经历的几个阶段，按时间顺序。第 3 步为每个阶段写一段开场白，做成卡后就是可以选的开场白。</div></div>
            <div class="nl-row nl-wrap">
                <button class="nl-btn nl-sm" data-act="stage-add" ${o.stages.length >= STUDIO_LIMITS.stages || lk.stages ? 'disabled' : ''}>${icon('plus', { size: 14 })}添加阶段</button>
                ${rerollBtn('reroll-outline', `data-mode="stages" ${dis}`, { label: '重新生成阶段', title: '只重新生成故事阶段；世界观和角色不变' })}
            </div>
        </div>
        <div class="nl-st-stages">${o.stages.map((st, i) => stageRowHtml(st, i, o.stages.length, lk.stages)).join('') || '<div class="nl-muted nl-small">还没有阶段：点「添加阶段」，或者重新生成阶段。</div>'}</div>
    </section>

    <div class="nl-row nl-wrap nl-st-foot">
        ${rerollBtn('reroll-outline', `data-mode="all" ${dis}`, { label: '重新生成整份大纲', title: '整份大纲重新设计（锁定的角色保留）' })}
        <button class="nl-btn" data-act="preview" data-what="outline">预览提示词</button>
        <span class="nl-spacer"></span>
        <button class="nl-btn nl-primary" data-act="goto-step" data-step="3" ${studioHasOutline(s) ? '' : 'disabled title="大纲里还要有名字的角色和至少一个阶段"'}>下一步：展开角色${icon('chevronRight', { size: 14 })}</button>
    </div>`;
}

// ---------------- 第 3 步：角色与开场白 ----------------

/** 第 3 步的标签：每个角色一个，加「开场白」、（选了示例对话或已经有时）「示例对话」 */
function tabList(s) {
    const tabs = s.outline.cast.map((m, i) => ({ key: m.id, label: m.name || `第 ${i + 1} 个角色`, status: itemStatus(s, m.id, 'cast') }));
    const pr = studioProgress(s);
    const job = jobFor(s);
    const openerRunning = job && s.outline.stages.some((x) => x.id === job.current);
    tabs.push({ key: 'openers', label: `开场白 ${pr.openersDone}/${pr.stages}`, status: openerRunning ? 'running' : pr.stages && pr.openersDone === pr.stages ? 'done' : s.outline.stages.some((x) => s.errors?.[x.id]) ? 'error' : 'empty' });
    if (s.options.examples || pr.example) tabs.push({ key: 'example', label: '示例对话', status: itemStatus(s, 'example', 'example') });
    return tabs;
}

function activeTab(s) {
    const tabs = tabList(s);
    if (!tabs.some((t) => t.key === view.tab)) view.tab = tabs[0]?.key || 'openers';
    return view.tab;
}

function tabsHtml(s) {
    const cur = activeTab(s);
    return tabList(s).map((t, i) => {
        const on = t.key === cur;
        // 读屏先念名字再念状态（圆点本身对读屏隐藏）
        const label = t.status === 'running' ? '生成中' : (STATUS_DOT[t.status] || STATUS_DOT.empty)[1];
        return `<button type="button" class="nl-st-tab" role="tab" id="nl-st-tab-${i}" data-act="tab" data-tab-key="${esc(t.key)}" aria-selected="${on}" aria-controls="nl-st-panel" tabindex="${on ? 0 : -1}">`
            + `<span aria-hidden="true" class="nl-st-tab-dot">${dotHtml(t.status)}</span><span class="nl-st-tab-label">${esc(t.label)}</span><span class="nl-sr-only">（${label}）</span></button>`;
    }).join('');
}

/**
 * 只重写一项的骰子：还没生成（或上次出错、什么都没有）的角色不能「重写」一项——先整个生成（免得只写了一项就算完成）
 * @param {string} why 不能用时的说明（'' = 能用）
 */
function fieldDice(castId, field, label, why) {
    return rerollBtn('field', `data-id="${esc(castId)}" data-field="${field}" ${why ? 'disabled' : ''}`, { title: why || `只重写「${label}」这一项，其余不变` });
}

/** 字段标题行：标签 + 只重写这一项的骰子 */
function fieldHead(id, label, castId, field, why) {
    return `<div class="nl-st-fhead"><label for="${id}">${label}</label>${fieldDice(castId, field, label, why)}</div>`;
}

function charPanelHtml(s, m) {
    const d = s.details[m.id] || emptyDetails();
    const st = itemStatus(s, m.id, 'cast');
    const ro = st === 'running';
    const roAttr = ro ? 'readonly' : '';
    const running = !!app.studioJob;
    // 骰子不能用的原因：正在生成 / 有别的任务 / 还没生成这个角色
    const why = ro || running ? '等当前的任务完成' : st === 'empty' || st === 'error' ? '先生成这个角色' : '';
    const ta = (key, label, rows, val, { mono = false, max = STUDIO_LIMITS[key] || 1500, ph = '' } = {}) => `
        <div class="nl-field">
            ${fieldHead(`nl-st-d-${key}`, label, m.id, key, why)}
            <textarea class="nl-input nl-textarea${mono ? ' nl-mono' : ''}" id="nl-st-d-${key}" rows="${rows}" data-det="${esc(m.id)}" data-df="${key}" maxlength="${max}" placeholder="${esc(ph)}" ${roAttr}>${esc(val)}</textarea>
        </div>`;
    const levels = d.affection || [];
    const meta = [castAgeText(m), m.gender, m.identity].filter(Boolean).join(' · ');
    const errNote = s.errors?.[m.id] ? `<div class="nl-sb-note nl-sb-note-err" role="alert">${icon('alert')}<div class="nl-grow">上次没生成出来：${esc(s.errors[m.id])}</div></div>` : '';
    const note = st === 'running'
        ? `<div class="nl-sb-note" role="status">${icon('info')}<div class="nl-grow">正在生成「${esc(m.name)}」…（完成前不能编辑）</div></div>`
        : st === 'error'
            ? errNote
            : st === 'empty'
                ? `<div class="nl-sb-note">${icon('info')}<div class="nl-grow">还没有展开：点「生成这个角色」让 AI 按大纲写出全部细节，也可以直接在下面填写。</div></div>`
                : st === 'partial'
                    ? `${errNote}<div class="nl-sb-note nl-sb-note-warn">${icon('alert')}<div class="nl-grow">只填了一部分：点「补全这个角色」让 AI 按大纲补全其余各项（你写好的几项原样保留）；「全部生成」也会补全。</div></div>`
                    : '';
    return `
    <div class="nl-st-panel-head">
        <div class="nl-grow">
            <div class="nl-st-panel-title"><b>${esc(m.name || '未命名')}</b>${m.locked ? ` ${icon('lock', { size: 14, label: '已锁定' })}` : ''} <span class="nl-muted nl-small">${esc(meta)}</span></div>
            ${m.oneLiner ? `<div class="nl-muted nl-small">${esc(m.oneLiner)}</div>` : ''}
        </div>
        <button class="nl-btn" data-act="preview" data-what="character" data-id="${esc(m.id)}">预览提示词</button>
        ${st === 'done'
            ? rerollBtn('char-gen', `data-id="${esc(m.id)}" ${running ? 'disabled' : ''}`, { label: '重写这个角色', title: '整个角色重新展开（大纲里的定位不变）' })
            : `<button class="nl-btn" data-act="char-gen" data-id="${esc(m.id)}" ${running ? 'disabled' : ''}>${st === 'partial' ? '补全这个角色' : '生成这个角色'}</button>`}
    </div>
    ${note}
    <div class="nl-grid2">
        ${ta('appearance', '外貌', 4, d.appearance, { ph: '一眼能认出 TA 的特征' })}
        ${ta('outfit', '穿着', 4, d.outfit, { ph: '现在身上穿的、随身带的东西' })}
    </div>
    ${ta('personality', '性格', 5, d.personality, { ph: '底色 + 主色调，每种写具体行为' })}
    <div class="nl-grid2">
        ${ta('speech', '说话方式', 4, d.speech, { ph: '口癖、称呼、句子长短和节奏' })}
        ${ta('sampleLines', '示例台词', 4, (d.sampleLines || []).join('\n'), { max: STUDIO_LIMITS.sampleLines * (STUDIO_LIMITS.sampleLine + 1), ph: '一行一句，3-5 句' })}
    </div>
    <div class="nl-grid2">
        ${ta('background', '背景经历', 5, d.background, { ph: '让 TA 成为现在这样的关键事件' })}
        ${ta('relationToUser', '与 {{user}} 的关系', 5, d.relationToUser, { ph: '现在的关系、第一印象和初始态度' })}
    </div>
    <div class="nl-st-group" role="group" aria-labelledby="nl-st-aff-t">
        <div class="nl-st-fhead"><span class="nl-st-group-title" id="nl-st-aff-t">好感变化</span>${fieldDice(m.id, 'affection', '好感变化', why)}
            <span class="nl-spacer"></span><button class="nl-btn nl-sm" data-act="aff-add" data-id="${esc(m.id)}" ${ro || levels.length >= STUDIO_LIMITS.affection ? 'disabled' : ''}>${icon('plus', { size: 14 })}添加一级</button></div>
        <div class="nl-muted nl-small">从低到高，每一级写 TA 对 {{user}} 的具体表现：语气、距离、愿意为 {{user}} 做什么、会透露什么。</div>
        <div class="nl-st-affs">${levels.map((a, i) => `
            <div class="nl-st-aff">
                <span class="nl-st-num" aria-hidden="true">${i + 1}</span>
                <input class="nl-input" data-det="${esc(m.id)}" data-aff="${i}" data-af="label" maxlength="${STUDIO_LIMITS.affectionLabel}" value="${esc(a.label)}" placeholder="阶段名，如「戒备」" aria-label="第 ${i + 1} 级的名字" ${roAttr}>
                <textarea class="nl-input nl-textarea" rows="2" data-det="${esc(m.id)}" data-aff="${i}" data-af="behavior" maxlength="${STUDIO_LIMITS.affectionBehavior}" placeholder="到了这一级时对 {{user}} 的具体表现" aria-label="第 ${i + 1} 级的表现" ${roAttr}>${esc(a.behavior)}</textarea>
                <button class="nl-icon-btn nl-danger" data-act="aff-remove" data-id="${esc(m.id)}" data-i="${i}" title="删除这一级" aria-label="删除第 ${i + 1} 级" ${ro ? 'disabled' : ''}>${icon('trash')}</button>
            </div>`).join('') || '<div class="nl-muted nl-small">还没有好感等级。</div>'}</div>
    </div>
    <div class="nl-st-group" role="group" aria-labelledby="nl-st-sec-t">
        <div class="nl-st-fhead"><span class="nl-st-group-title" id="nl-st-sec-t">秘密与隐藏剧情</span>${fieldDice(m.id, 'secret', '秘密与隐藏剧情', why)}</div>
        <div class="nl-grid3">
            <div class="nl-field"><label for="nl-st-sec-c">秘密本身</label><textarea class="nl-input nl-textarea" id="nl-st-sec-c" rows="4" data-det="${esc(m.id)}" data-df="secret.content" maxlength="${STUDIO_LIMITS.secretContent}" ${roAttr}>${esc(d.secret?.content || '')}</textarea></div>
            <div class="nl-field"><label for="nl-st-sec-h">平时露出的线索</label><textarea class="nl-input nl-textarea" id="nl-st-sec-h" rows="4" data-det="${esc(m.id)}" data-df="secret.hints" maxlength="${STUDIO_LIMITS.secretHints}" ${roAttr}>${esc(d.secret?.hints || '')}</textarea></div>
            <div class="nl-field"><label for="nl-st-sec-r">揭露条件</label><textarea class="nl-input nl-textarea" id="nl-st-sec-r" rows="4" data-det="${esc(m.id)}" data-df="secret.reveal" maxlength="${STUDIO_LIMITS.secretReveal}" ${roAttr}>${esc(d.secret?.reveal || '')}</textarea></div>
        </div>
        <div class="nl-muted nl-small">写进世界书时会注明：揭露条件满足之前，TA 不会说出来，旁白也只通过线索暗示。</div>
    </div>
    <div class="nl-st-group" role="group" aria-labelledby="nl-st-pp-t">
        <div class="nl-st-fhead"><span class="nl-st-group-title" id="nl-st-pp-t">立绘提示词</span>${fieldDice(m.id, 'portraitPrompt', '立绘提示词', why)}
            <span class="nl-spacer"></span><button class="nl-btn nl-sm" data-act="copy-portrait" data-id="${esc(m.id)}">${icon('copy', { size: 14 })}复制</button></div>
        <textarea class="nl-input nl-textarea nl-mono" rows="3" data-det="${esc(m.id)}" data-df="portraitPrompt" maxlength="${STUDIO_LIMITS.portraitPrompt}" aria-labelledby="nl-st-pp-t" aria-describedby="nl-st-pp-note" placeholder="adult woman, ……" ${roAttr}>${esc(d.portraitPrompt)}</textarea>
        <div class="nl-muted nl-small" id="nl-st-pp-note">英文标签，给 AI 绘图用（不写进卡片）；只描写成年人的样子，不写名字。</div>
    </div>`;
}

function openersPanelHtml(s) {
    const job = jobFor(s);
    const running = !!app.studioJob;
    const written = s.outline.stages.filter((x) => studioOpenerStatus(s, x.id) === 'done').map((x) => x.id);
    return `
    <div class="nl-st-panel-head">
        <div class="nl-grow"><div class="nl-muted nl-small">每个阶段一段开场白：默认前面的阶段已经发生，结尾把局面交给 {{user}}。做成卡时第一段是开场白，其余按阶段顺序成为备选开场白，开聊时可以选从哪个阶段开始。</div></div>
    </div>
    <div class="nl-st-openers">${s.outline.stages.map((st, i) => {
        const status = job?.current === st.id ? 'running' : studioOpenerStatus(s, st.id);
        const k = written.indexOf(st.id);
        const role = k === 0 ? '卡里的开场白' : k > 0 ? `备选开场白 ${k}` : '还没有写';
        const text = s.openers[st.id] || '';
        return `
        <div class="nl-st-opener">
            <div class="nl-st-opener-head">
                <span class="nl-st-num" aria-hidden="true">${i + 1}</span>
                <b>${esc(st.name || `第 ${i + 1} 阶段`)}</b>
                ${st.time ? `<span class="nl-muted nl-small">${esc(st.time)}</span>` : ''}
                ${dotHtml(status)}
                <span class="nl-tag">${esc(role)}</span>
                <span class="nl-st-opener-acts">
                    <button class="nl-btn nl-sm" data-act="preview" data-what="opener" data-id="${esc(st.id)}">预览提示词</button>
                    ${text
                        ? rerollBtn('opener', `data-id="${esc(st.id)}" ${running ? 'disabled' : ''}`, { label: '重写', title: `重写${studioStageLabel(s, st.id)}的开场白` })
                        : `<button class="nl-btn nl-sm" data-act="opener" data-id="${esc(st.id)}" ${running ? 'disabled' : ''}>写开场白</button>`}
                </span>
            </div>
            ${st.summary ? `<div class="nl-muted nl-small nl-st-opener-sum">${esc(st.summary)}</div>` : ''}
            ${status === 'error' ? `<div class="nl-err nl-small" role="alert">${icon('alert', { size: 12 })} 上次没写出来：${esc(s.errors[st.id] || '')}</div>` : ''}
            <textarea class="nl-input nl-textarea" rows="8" data-opener="${esc(st.id)}" maxlength="${STUDIO_LIMITS.opener}" aria-label="${esc(studioStageLabel(s, st.id))}的开场白" placeholder="${status === 'running' ? '正在写…' : '还没有写：点「写开场白」，或者直接在这里写'}" ${status === 'running' ? 'readonly' : ''}>${esc(text)}</textarea>
        </div>`;
    }).join('')}</div>`;
}

function examplePanelHtml(s) {
    const st = itemStatus(s, 'example', 'example');
    const running = !!app.studioJob;
    return `
    <div class="nl-st-panel-head">
        <div class="nl-grow"><div class="nl-muted nl-small">示例对话（mes_example）示范旁白怎么叙述、怎么替不同的角色说话；做成卡时写进卡片。${s.options.examples ? '' : '（第 1 步没有勾选「写示例对话」：做卡时不会带上）'}</div></div>
        <button class="nl-btn" data-act="preview" data-what="example">预览提示词</button>
        ${String(s.example || '').trim()
            ? rerollBtn('example', running ? 'disabled' : '', { label: '重写示例对话', title: '重新写示例对话' })
            : `<button class="nl-btn" data-act="example" ${running ? 'disabled' : ''}>写示例对话</button>`}
    </div>
    ${st === 'error' ? `<div class="nl-sb-note nl-sb-note-err" role="alert">${icon('alert')}<div class="nl-grow">上次没写出来：${esc(s.errors.example || '')}</div></div>` : ''}
    <textarea class="nl-input nl-textarea" rows="14" data-sf="example" maxlength="${STUDIO_LIMITS.example}" aria-label="示例对话" placeholder="<START>&#10;{{user}}: ……&#10;{{char}}: ……" ${st === 'running' ? 'readonly' : ''}>${esc(s.example)}</textarea>`;
}

function panelHtml(s) {
    const key = activeTab(s);
    if (key === 'openers') return openersPanelHtml(s);
    if (key === 'example') return examplePanelHtml(s);
    const m = s.outline.cast.find((c) => c.id === key);
    return m ? charPanelHtml(s, m) : '';
}

function step3Html(s) {
    const job = jobFor(s);
    const running = !!app.studioJob;
    const ov = overallProgress(s);
    const allDone = ov.total > 0 && ov.done === ov.total;
    // 「全部生成 / 全部重写」进行中：按这一轮已经处理了几项算进度（全部重写时内容本来就是满的）
    const runBar = job?.kind === 'content' && job.runTotal > 0;
    const barDone = runBar ? Math.min(job.runDone || 0, job.runTotal) : ov.done;
    const barTotal = runBar ? job.runTotal : ov.total;
    const pct = barTotal ? Math.round((barDone / barTotal) * 100) : 0;
    const tabs = tabList(s);
    const curIdx = Math.max(0, tabs.findIndex((t) => t.key === activeTab(s)));
    return `
    <section class="nl-card">
        <div class="nl-card-head">
            <div><h3>角色与开场白</h3><div class="nl-card-desc nl-num">角色 ${ov.castDone}/${ov.cast} 已展开 · 开场白 ${ov.openersDone}/${ov.stages}${s.options.examples ? ` · 示例对话${ov.example ? '已写' : '未写'}` : ''}</div></div>
            <div class="nl-row nl-wrap">
                <button class="nl-btn nl-sm" data-act="copy-portraits">${icon('copy', { size: 14 })}复制全部立绘提示词</button>
                ${rerollBtn('regen-all', running ? 'disabled' : '', { label: '全部重写', title: '已经写好的角色、开场白和示例对话也重新生成' })}
                <button class="nl-btn nl-primary" data-act="gen-all" ${running || allDone ? 'disabled' : ''} title="${allDone ? '都写好了；想重来可以「全部重写」' : '依次展开没写的角色，再写没写的开场白和示例对话'}">${allDone ? '已全部生成' : ov.done ? '继续生成' : '全部生成'}</button>
            </div>
        </div>
        <div class="nl-st-progress" data-st-progress>
            <div class="nl-progress" role="progressbar" aria-label="${runBar ? '这一轮的进度' : '角色与开场白的完成度'}" aria-valuemin="0" aria-valuemax="${barTotal}" aria-valuenow="${barDone}"${job?.kind === 'content' ? ` aria-valuetext="${esc(progressText(job))}"` : ''}><div class="nl-progress-bar" style="width:${pct}%"></div><span class="nl-progress-text">${job?.kind === 'content' ? esc(progressText(job)) : `${ov.done}/${ov.total}`}</span></div>
            ${job ? `<button class="nl-btn nl-danger" data-act="stop">${icon('stop', { size: 14 })}停止</button>` : ''}
        </div>
        <div class="nl-st-tabs" role="tablist" aria-label="角色与开场白" data-st-tabs>${tabsHtml(s)}</div>
        <div class="nl-st-panel" role="tabpanel" id="nl-st-panel" aria-labelledby="nl-st-tab-${curIdx}" data-st-panel>${panelHtml(s)}</div>
    </section>
    <div class="nl-row nl-wrap nl-st-foot">
        <button class="nl-btn" data-act="goto-step" data-step="2">${icon('chevronRight', { size: 14, cls: 'nl-st-back' })}回到大纲</button>
        <span class="nl-spacer"></span>
        <button class="nl-btn nl-primary" data-act="goto-step" data-step="4" ${studioStepEnabled(s, 4) ? '' : 'disabled title="先写好至少一段开场白"'}>下一步：生成卡${icon('chevronRight', { size: 14 })}</button>
    </div>`;
}

// ---------------- 第 4 步：生成卡 ----------------

function sumRow(label, value, { warn = '' } = {}) {
    return `<div class="nl-st-sum-row"><div class="nl-st-sum-k">${esc(label)}</div><div class="nl-st-sum-v">${value}${warn ? `<div class="nl-warn nl-small">${icon('alert', { size: 12 })} ${esc(warn)}</div>` : ''}</div></div>`;
}

function step4Html(s) {
    const p = app.project;
    const sum = studioCardSummary(p, app.settings, s);
    const card = sum.card;
    const running = !!app.studioJob;
    // 写入酒馆时另加的常驻条目（导向、用户偏好、{{user}} 的身份）也算进条数：和卡自己世界书里最后的条数一致
    const extras = sum.extras;
    const plan = sum.problem ? { collisions: [], canOverwrite: false } : studioSavePlan(p, app.settings, s);
    const sbTpl = studioStatusBarTemplateId(app.settings);
    let sbName = '';
    try {
        sbName = sbTpl ? getStatusBarTemplate(app.settings, sbTpl)?.name || '' : '';
    } catch { /* 模板不存在 */ }
    // 状态栏算「已生成」要有变量（生成失败或中途停止时只有空的状态栏：还可以勾选后「更新卡片」重试）
    const hasSb = !!card?.statusBar?.spec?.variables?.length;
    const sbErr = !hasSb && card?.statusBar?.error ? `上次生成失败：${card.statusBar.error}` : '';
    const greet = sum.greetings ? `${sum.greetings} 段：开场白${sum.greetings > 1 ? ` + ${sum.greetings - 1} 条备选开场白` : ''}（按阶段顺序）` : '还没有';
    const coll = plan.collisions.length ? `
        <div class="nl-st-group" data-st-collision>
            <div class="nl-st-group-title">项目里已有同名的资料</div>
            <div class="nl-small">${plan.collisions.map((c) => `${c.type === 'character' ? '角色' : `${esc(c.category)}`}「${esc(c.name)}」${c.via === 'name' ? '' : c.via === 'alias' ? '（是别的角色的别名）' : '（是别的条目的关键词）'}`).join('、')}</div>
            ${plan.canOverwrite ? `
            <div class="nl-seg" role="group" aria-label="同名时怎么存">
                <button type="button" class="nl-seg-btn ${view.collision !== 'overwrite' ? 'active' : ''}" aria-pressed="${view.collision !== 'overwrite'}" data-act="collision" data-val="suffix">另存为新的（加后缀）</button>
                <button type="button" class="nl-seg-btn ${view.collision === 'overwrite' ? 'active' : ''}" aria-pressed="${view.collision === 'overwrite'}" data-act="collision" data-val="overwrite">覆盖项目里的</button>
            </div>` : ''}
            <div class="nl-muted nl-small">${view.collision === 'overwrite' && plan.canOverwrite ? '同名的角色和条目换成这份构思的。' : '加后缀另存（如「林夏（原创）」），卡里仍用原来的名字；这张卡写入酒馆时不带项目里原来那份。'}</div>
        </div>` : '';
    return `
    <section class="nl-card">
        <div class="nl-card-head">
            <div><h3>${card ? '更新卡片' : '生成卡'}</h3><div class="nl-card-desc">做成一张世界/旁白卡：{{char}} 是旁白，扮演所有角色；每个角色的设定、地点和故事阶段写进卡自己的世界书，各阶段的开场白是可以选的开场白。和「多人群像」状态栏很搭。</div></div>
            <button class="nl-btn" data-act="card-preview" ${sum.problem ? 'disabled' : ''}>${icon('eye', { size: 14 })}预览卡片内容</button>
        </div>
        ${sum.problem ? `<div class="nl-sb-note nl-sb-note-warn" role="alert">${icon('alert')}<div class="nl-grow">${esc(sum.problem)}</div></div>` : ''}
        <div class="nl-st-sum">
            ${sumRow('卡名', `<b>${esc(sum.title || '（还没有）')}</b>`)}
            ${sumRow('世界书条目', `<span class="nl-num">${sum.entries.total + extras.length} 条</span><span class="nl-muted">：角色 ${sum.entries.characters} · 地点 ${sum.entries.locations}${sum.entries.stages ? ` · 故事阶段总览 ${sum.entries.stages}（常驻）` : ''}${extras.length ? ` · ${esc(extras.join(' · '))}` : ''}</span>`,
                { warn: sum.missingDetails.length ? `${sum.missingDetails.length} 个角色还没展开完（${sum.missingDetails.join('、')}）：世界书里只有大纲里的定位和已经填了的几项` : '' })}
            ${sumRow('开场白', esc(greet), { warn: sum.missingOpeners.length && sum.greetings ? `${sum.missingOpeners.join('、')}还没有开场白，不会出现在卡里` : '' })}
            ${sumRow('示例对话', `<label><input type="checkbox" data-sf="options.examples" ${s.options.examples ? 'checked' : ''}> 带上示例对话</label> <span class="nl-muted nl-small">${s.options.examples ? (sum.examples ? '已写好' : '还没有写（在第 3 步「示例对话」里写）') : '不带'}</span>`)}
            ${sumRow('状态栏', hasSb
                ? `已生成${card.statusBar.enabled === false ? '（已关闭）' : ''} <span class="nl-muted nl-small">在「角色卡」页的「状态栏」里修改；更新卡片时保留（改名、删掉的角色跟着改）</span>`
                : `<label><input type="checkbox" data-sf="options.statusBar" ${s.options.statusBar ? 'checked' : ''}> 同时生成状态栏</label> <span class="nl-muted nl-small">${sbName ? `套用「${esc(sbName)}」模板，主要角色预先填好` : 'AI 按群像设计'}${sbErr ? '；勾选后点「更新卡片」重试' : ''}</span>`,
                { warn: sbErr })}
            ${sumRow('定制', `<span class="nl-muted">导向：</span>${esc(sum.orientation || '不限')} <span class="nl-muted">· 画像：</span>${esc(sum.profile || '不使用')} <span class="nl-muted">· {{user}}：</span>${esc(sum.userRole)}`)}
        </div>
        ${coll}
        ${sum.stale ? `<div class="nl-sb-note nl-sb-note-warn" role="status" data-st-stale>${icon('alert')}<div class="nl-grow">草稿改过之后还没更新卡片：「角色卡」页和酒馆里的还是旧的内容。点「更新卡片」按现在的草稿重新组装。</div></div>` : ''}
        <div class="nl-row nl-wrap">
            <button class="nl-btn nl-primary" data-act="build" ${sum.problem || running || view.publishing ? 'disabled' : ''} ${view.publishing ? 'title="正在写入酒馆，写完再更新"' : ''}>${card ? '更新卡片' : '生成角色卡'}</button>
            <span class="nl-muted nl-small">${card ? '按现在的草稿重新组装同一张卡（写入酒馆的绑定、头像、状态栏不变）。' : '角色存成项目里的手动角色，地点存成手动条目。'}</span>
        </div>
    </section>
    ${card ? `
    <section class="nl-card" data-st-card>
        <div class="nl-card-head">
            <div><h3>已生成的卡</h3><div class="nl-card-desc">可以去「角色卡」页编辑、试聊、改状态栏，或直接写入酒馆。</div></div>
        </div>
        <div class="nl-cardbox">
            ${card.avatarDataUrl ? `<img class="nl-avatar" src="${esc(card.avatarDataUrl)}" alt="">` : `<div class="nl-avatar nl-avatar-empty">${icon('cards', { size: 24 })}</div>`}
            <div class="nl-grow">
                <div><b>${esc(card.data.name)}</b> <span class="nl-tag">世界卡</span> <span class="nl-tag">创意工坊</span> ${statusBarTagHtml(card)} ${card.stAvatar ? '<span class="nl-tag nl-ok">已写入酒馆</span>' : ''} ${sum.stale ? '<span class="nl-tag nl-warn">草稿改过，卡还没更新</span>' : ''}</div>
                <div class="nl-muted nl-small nl-num">${esc(fmtTime(card.updatedAt))} · 开场白 ${1 + (card.data.alternate_greetings || []).length} 段 · 本卡世界书条目 ${(card.studio?.entries || []).length} 条</div>
                <div class="nl-small nl-clamp">${esc(String(card.data.first_mes || '').slice(0, 160))}</div>
            </div>
            <div class="nl-card-actions">
                <button class="nl-btn nl-sm" data-act="edit-card" data-id="${esc(card.id)}">${icon('edit', { size: 14 })}去角色卡页编辑</button>
                <button class="nl-btn nl-sm" data-act="publish" data-id="${esc(card.id)}" ${running || view.publishing ? 'disabled' : ''} ${sum.stale ? 'title="草稿改过，卡还没更新：先点「更新卡片」，不然写入的是旧的内容"' : ''}>${icon('upload', { size: 14 })}${card.stAvatar ? '更新到酒馆' : '写入酒馆'}</button>
            </div>
        </div>
    </section>` : ''}
    <div class="nl-row nl-wrap nl-st-foot">
        <button class="nl-btn" data-act="goto-step" data-step="3">${icon('chevronRight', { size: 14, cls: 'nl-st-back' })}回到角色与开场白</button>
    </div>`;
}

// ---------------- 写回草稿 ----------------

/** 一个输入框绑定的草稿位置现在的值（显示用：标签用顿号连起来、示例台词一行一句） */
function boundValue(s, t) {
    const d = t.dataset;
    if (d.sf) {
        const v = getPath(s || view.draft, d.sf);
        return v === undefined || v === null ? '' : String(v);
    }
    if (!s) return t.value;
    if (d.cast) {
        const m = s.outline.cast.find((c) => c.id === d.cast);
        if (!m) return t.value;
        return d.cf === 'tags' ? m.tags.join('、') : String(m[d.cf] ?? '');
    }
    if (d.stage) return String(s.outline.stages.find((x) => x.id === d.stage)?.[d.gf] ?? t.value);
    if (d.loc !== undefined) return String(s.outline.world.locations[Number(d.loc)]?.[d.lf] ?? t.value);
    if (d.det) {
        const det = s.details[d.det] || emptyDetails();
        if (d.aff !== undefined) return String(det.affection?.[Number(d.aff)]?.[d.af] ?? t.value);
        if (d.df === 'sampleLines') return (det.sampleLines || []).join('\n');
        if (d.df.startsWith('secret.')) return String(det.secret?.[d.df.slice(7)] ?? '');
        return String(det[d.df] ?? '');
    }
    if (d.opener) return String(s.openers[d.opener] || '');
    return t.value;
}

/** 由点路径和值拼出 updateStudio 的补丁（options.userRole.kind → {options: {userRole: {kind}}}） */
function pathPatch(path, value) {
    const patch = {};
    setPath(patch, path, value);
    return patch;
}

/**
 * 把一个输入框的值写回草稿（新构思表单写进 view.draft）；写回成功返回 true。
 * 角色 / 地点改成和别的重名时不写回（还原输入框并提示）；年龄写成未满 18 岁的改成 18 岁并提示。
 */
function commitInput(t) {
    const p = app.project;
    const s = current();
    const d = t.dataset;
    const v = t.type === 'checkbox' ? t.checked : t.value;
    if (d.sf) {
        if (!s) {
            if (view.draft) setPath(view.draft, d.sf, v);
            return true;
        }
        updateStudio(p, s.id, pathPatch(d.sf, v));
        return true;
    }
    if (!s) return false;
    if (d.cast) {
        const m = s.outline.cast.find((c) => c.id === d.cast);
        if (!m) return false;
        let val = v;
        if (d.cf === 'name') {
            const n = String(v).trim();
            if (n && s.outline.cast.some((c) => c.id !== m.id && c.name === n)) {
                app.log(`已经有一个叫「${n}」的角色了，换个名字吧`, 'warn');
                t.value = m.name;
                return false;
            }
        }
        if (d.cf === 'age') {
            const warnings = [];
            val = adultAge(v, { name: m.name, warnings });
            for (const w of warnings) app.log(w, 'warn');
        }
        if (d.cf === 'name') {
            // 改名（同一个人）：导向落点和阶段里写着旧名字的地方跟着改
            const oldName = m.name;
            const { patch, where } = studioRenameCastPatch(s, m.id, val);
            updateStudio(p, s.id, { outline: patch });
            if (where.length) app.log(`${where.join('、')}里的「${oldName}」已跟着改成「${String(val).trim()}」`);
            return true;
        }
        updateStudio(p, s.id, { outline: { cast: s.outline.cast.map((c) => (c.id === m.id ? { ...c, [d.cf]: val } : c)) } });
        return true;
    }
    if (d.stage) {
        updateStudio(p, s.id, { outline: { stages: s.outline.stages.map((x) => (x.id === d.stage ? { ...x, [d.gf]: v } : x)) } });
        return true;
    }
    if (d.loc !== undefined) {
        const i = Number(d.loc);
        const list = s.outline.world.locations;
        if (!list[i]) return false;
        if (d.lf === 'name') {
            const n = String(v).trim();
            if (n && list.some((l, j) => j !== i && l.name === n)) {
                app.log(`已经有一个叫「${n}」的地点了，换个名字吧`, 'warn');
                t.value = list[i].name;
                return false;
            }
        }
        updateStudio(p, s.id, { outline: { world: { locations: list.map((l, j) => (j === i ? { ...l, [d.lf]: v } : l)) } } });
        return true;
    }
    if (d.det) {
        if (!s.outline.cast.some((c) => c.id === d.det)) return false;
        const det = s.details[d.det] || emptyDetails();
        let patch;
        if (d.aff !== undefined) {
            const i = Number(d.aff);
            patch = { affection: (det.affection || []).map((a, j) => (j === i ? { ...a, [d.af]: v } : a)) };
        } else if (d.df.startsWith('secret.')) {
            patch = { secret: { ...(det.secret || {}), [d.df.slice(7)]: v } };
        } else {
            patch = { [d.df]: v };
        }
        updateStudio(p, s.id, { details: { [d.det]: patch } });
        return true;
    }
    if (d.opener) {
        if (!s.outline.stages.some((x) => x.id === d.opener)) return false;
        updateStudio(p, s.id, { openers: { [d.opener]: v } });
        return true;
    }
    return false;
}

const BOUND = '[data-sf], [data-cast], [data-stage], [data-loc][data-lf], [data-det], [data-opener]';

// 重绘时用来找回焦点的属性
const FOCUS_ATTRS = ['data-act', 'data-id', 'data-mode', 'data-step', 'data-val', 'data-field', 'data-i', 'data-what', 'data-tab-key',
    'data-sf', 'data-cast', 'data-cf', 'data-stage', 'data-gf', 'data-loc', 'data-lf', 'data-det', 'data-df', 'data-aff', 'data-af', 'data-opener'];

/**
 * 重绘前记下焦点所在的控件：怎么找回它、里面的文字和光标、是不是只读，以及草稿里这个位置现在的值（bound）。
 * @param {HTMLElement} root
 * @param {object|null} s 打开的构思（新构思表单时为 null）
 */
function focusSnapshot(root, s) {
    const a = document.activeElement;
    if (!a || !root.contains(a)) return null;
    const sel = FOCUS_ATTRS.filter((k) => a.hasAttribute(k)).map((k) => `[${k}="${CSS.escape(a.getAttribute(k))}"]`).join('');
    if (!sel) return null;
    const text = (a.tagName === 'TEXTAREA' || (a.tagName === 'INPUT' && !['checkbox', 'radio', 'number'].includes(a.type)));
    return {
        sel: `${a.tagName.toLowerCase()}${sel}`, text, value: text ? a.value : null, start: text ? a.selectionStart : null, end: text ? a.selectionEnd : null,
        scroll: a.scrollTop, ro: !!a.readOnly, bound: text ? boundValue(s, a) : null,
    };
}

/**
 * 重绘后把焦点放回原来那个控件。正在写的那一栏保留原样的文字（写回草稿时会去掉首尾空格、把年龄规整成「xx 岁」，
 * 打字打到一半时不能把刚敲的空格吞掉、把「1」改成 18 岁）。
 * 只有草稿里这个位置在重绘期间没变（AI 没有写进新内容）、原来那一栏也不是只读的时候才放回原样的文字——
 * 不然新生成的开场白、细节会被焦点里的旧文字盖掉（地点按序号对应，重新生成后也不会把旧名字放到新地点上）。
 * @param {HTMLElement} root
 * @param {object|null} snap focusSnapshot 的结果
 * @param {object|null} s 打开的构思
 * @returns {HTMLElement|null} 文字和草稿里的不一样的那一栏（调用方记成「还没写回」，离开时再写回）
 */
function focusRestore(root, snap, s) {
    if (!snap) return null;
    const n = root.querySelector(snap.sel);
    if (!n || n.disabled) return null;
    let differs = null;
    if (snap.text && !snap.ro && !n.readOnly && snap.value !== null && n.value !== snap.value && boundValue(s, n) === snap.bound) {
        n.value = snap.value;
        differs = n;
    }
    try {
        n.focus({ preventScroll: true });
        if (snap.text && typeof snap.start === 'number') n.setSelectionRange(snap.start, snap.end);
    } catch { /* ignore */ }
    n.scrollTop = snap.scroll || 0;
    return differs;
}

/** 写到一半不写回的栏（年龄、角色 / 地点的名字）：离开输入框时才写回（写回时会规整年龄、拦下重名） */
function commitOnLeave(t) {
    return t.dataset.cf === 'age' || t.dataset.cf === 'name' || t.dataset.lf === 'name';
}

// ---------------- 页面 ----------------

export const studioTab = {
    mount(el, { switchTab, setActions }) {
        const dirty = new Set();
        let composing = false;
        let pendingRender = false;

        /** 把还没写回的输入写回草稿；keepFocused：正在写的年龄 / 名字先不写回（重绘时用，离开输入框时再写回） */
        const flush = ({ keepFocused = false } = {}) => {
            flushSoon.cancel();
            let changed = false;
            for (const t of [...dirty]) {
                if (keepFocused && t === document.activeElement && commitOnLeave(t)) continue;
                dirty.delete(t);
                if (t.isConnected && commitInput(t)) changed = true;
            }
            if (changed && current()) app.saveSoon();
            return changed;
        };
        const flushSoon = debounce(() => flush({ keepFocused: true }), 600);

        const headerHtml = (s) => {
            const job = app.studioJob;
            if (job) return `<span class="nl-header-status" role="status"><span class="nl-spin"></span><span class="nl-st-job-text">${esc(progressText(job))}</span></span><button class="nl-btn nl-danger" data-act="stop">${icon('stop')}停止</button>`;
            return app.project && (s || listStudios(app.project).length) ? `<button class="nl-btn" data-act="new">${icon('plus')}新建构思</button>` : '';
        };

        /**
         * 标题栏：内容没变时不重画（长任务每完成一项都会重绘页面，重画标题栏会让键盘焦点从「停止」上掉下来）；
         * 运行中只更新进度文字（读屏的 role="status" 也保持同一个元素，进度变化会被念出来）。
         */
        let lastHeader = null;
        const updateHeader = (s) => {
            const hh = headerHtml(s);
            if (hh === lastHeader) return;
            const slot = document.getElementById('nl-page-actions');
            const jobText = slot?.querySelector('.nl-st-job-text');
            if (app.studioJob && jobText && slot.querySelector('[data-act="stop"]')) {
                jobText.textContent = progressText(app.studioJob);
                lastHeader = hh;
                return;
            }
            setActions(hh, onClick);
            lastHeader = hh;
        };

        const render = () => {
            // 新建项目时页面会重新挂载：旧的这一份不再画（也不能抢走标题栏的按钮）
            if (!el.isConnected) return;
            if (composing) {
                pendingRender = true;
                return;
            }
            pendingRender = false;
            flush({ keepFocused: true });
            syncView();
            const p = app.project;
            const s = current();
            const snap = focusSnapshot(el, s);
            const tabs = el.querySelector('[data-st-tabs]');
            const tabsScroll = tabs ? tabs.scrollLeft : 0;
            const step = s ? s.step : 1;
            // 草稿记的步骤进不去时（比如大纲里的阶段删光了）显示第 1 步，步骤条也标第 1 步
            let shown = 1;
            if (s && step >= 2 && step <= 4 && studioStepEnabled(s, step)) shown = step;
            const body = !s ? step1Html(view.draft, {}) : shown === 2 ? step2Html(s) : shown === 3 ? step3Html(s) : shown === 4 ? step4Html(s) : step1Html(s, { s });
            el.innerHTML = `
                ${p ? draftsHtml(p) : ''}
                <section class="nl-card nl-st-head-card">${headHtml(s)}${stepperHtml(s, shown)}</section>
                ${body}`;
            updateHeader(s);
            const nt = el.querySelector('[data-st-tabs]');
            if (nt) nt.scrollLeft = tabsScroll;
            // 旧的输入框（还没写回的）已经换成新的：新的这一栏接着算「还没写回」
            for (const t of [...dirty]) if (!t.isConnected) dirty.delete(t);
            const differs = focusRestore(el, snap, s);
            if (differs) dirty.add(differs);
        };
        /** 改了选项之类要重绘时：等这一轮焦点移动（Tab 到下一栏）完成后再重绘，焦点留在新的那一栏 */
        const renderSoon = () => setTimeout(render, 0);

        /** 长任务有进展 / 开始 / 结束：重绘（保留焦点和写了一半的文字） */
        const onJob = () => render();

        /** 换到第 3 步的某个标签（键盘或点击）：只重绘标签和面板，焦点放到新的标签上 */
        const selectTab = (key, focus = false) => {
            const s = current();
            if (!s) return;
            flush();
            view.tab = key;
            render();
            const btn = el.querySelector(`[data-act="tab"][data-tab-key="${CSS.escape(key)}"]`);
            if (btn) {
                btn.scrollIntoView({ block: 'nearest', inline: 'nearest' });
                if (focus) btn.focus();
            }
        };

        const goStep = (s, step) => {
            if (!studioStepEnabled(s, step)) return;
            updateStudio(app.project, s.id, { step });
            app.saveSoon();
            render();
            el.closest('.nl-main')?.scrollTo?.({ top: 0 });
        };

        /** 新构思：按表单新建（没打开项目、或打开的是小说项目且选了新建时新建原创项目） */
        const createFromDraft = async () => {
            const d = view.draft || freshDraft();
            if (!String(d.premise || '').trim()) {
                app.log('请先写下你的创意', 'warn');
                el.querySelector('[data-sf="premise"]')?.focus();
                return null;
            }
            const init = { premise: d.premise, options: d.options };
            let s;
            if (!app.project || (projectHasSource(app.project) && d.target !== 'current')) {
                if (app.isBusy()) {
                    app.log('有任务正在运行，不能新建项目，请稍后', 'warn');
                    return null;
                }
                // 新建项目会触发页面重新挂载：先把要打开的构思记好，新的页面实例接着显示进度
                const r = await app.createStudioProject(init);
                s = r.studio;
            } else {
                s = addStudio(app.project, app.settings, init);
                await app.saveNow();
            }
            view.projectId = app.project.id;
            view.studioId = s.id;
            view.tab = '';
            view.draft = null;
            app.events.emit('nav');
            return s;
        };

        const runOutline = async (s, { mode = 'all', memberId = '', instruction = '' } = {}) => {
            const member = mode === 'member' ? s.outline.cast.find((c) => c.id === memberId) : null;
            const first = mode === 'all' && !studioOutlineTouched(s);
            const label = member ? `换掉「${member.name}」` : first ? '生成大纲' : `重新生成${OUTLINE_MODE_LABELS[mode]}`;
            const res = await runJob(s, { label, kind: 'outline', target: memberId || mode }, (signal) => generateOutline(app.project, app.settings, s, { mode, memberId, instruction, signal, onLog: log }));
            if (!res) return;
            const o = res.outline;
            const cleared = [res.removed.details ? `清掉了 ${res.removed.details} 个角色的细节` : '', res.removed.openers ? `${res.removed.openers} 段开场白` : ''].filter(Boolean).join('、');
            app.log(`🧭 「${draftTitle(s)}」${label}完成：${o.cast.length} 个角色、${o.stages.length} 个阶段、${o.world.locations.length} 个地点${cleared ? `（${cleared}）` : ''}`, 'success');
        };

        /** 「全部生成」/「全部重写」：进度条按这一轮处理了几项走（runDone / runTotal：角色 + 阶段 + 选了时的示例对话） */
        const runContent = async (s, overwrite) => {
            const total = s.outline.cast.filter((c) => c.name).length + s.outline.stages.length + (s.options.examples ? 1 : 0);
            const res = await runJob(s, { label: overwrite ? '全部重写' : '全部生成', kind: 'content' }, (signal) => {
                Object.assign(app.studioJob, { runDone: 0, runTotal: total });
                return generateStudioContent(app.project, app.settings, s, {
                    overwrite, signal, onLog: log,
                    onProgress: (ev) => {
                        const job = app.studioJob;
                        if (!job) return;
                        job.progress = ev;
                        job.current = ev.status === 'running' ? ev.id : '';
                        if (['done', 'skipped', 'error'].includes(ev.status)) job.runDone = (job.runDone || 0) + 1;
                        if (ev.status === 'done') app.saveSoon();
                        emitProgress();
                    },
                });
            });
            if (!res) return;
            const c = res.characters;
            const o = res.openers;
            const done = [c.done.length ? `${c.done.length} 个角色` : '', o.done.length ? `${o.done.length} 段开场白` : '', res.example === 'done' ? '示例对话' : ''].filter(Boolean).join('、');
            const parts = done || '没有需要写的';
            const failed = [...c.failed, ...o.failed];
            if (res.example === 'error') failed.push({ name: '示例对话' });
            const what = overwrite ? '全部重写' : '全部生成';
            if (res.stopped) app.log(done ? `已停止「${what}」：这次写好的保留（${done}），没轮到的保持原样` : `已停止「${what}」：还没写完一项，原来的内容都保留`, 'warn');
            else if (failed.length) app.log(`「${what}」结束：写好了 ${parts}；${failed.map((f) => f.name).join('、')} 没生成出来，可以单独重试`, 'warn');
            else app.log(`✨ 「${draftTitle(s)}」${what}完成：${parts}`, 'success');
        };

        /** 生成 / 重写一个角色（只填了一部分的补全：写了的几项保留），或只重写其中一项 */
        const runCharacter = async (s, m, { field = '', instruction = '' } = {}) => {
            const f = field ? studioDetailField(field) : null;
            const complete = !f && studioCastStatus(s, m.id) === 'partial';
            const label = f ? `重写「${m.name}」的${f.label}` : complete ? `补全「${m.name}」` : `展开「${m.name}」`;
            const res = await runJob(s, { label, kind: f ? 'field' : 'character', target: m.id, field }, (signal) => (f
                ? rerollCharacterField(app.project, app.settings, s, m.id, field, { instruction, signal, onLog: log })
                : generateCharacter(app.project, app.settings, s, m.id, { instruction, complete, signal, onLog: log })));
            if (res) app.log(f ? `🎲 已重写「${m.name}」的${f.label}` : complete ? `👤 已补全「${m.name}」` : `👤 已展开「${m.name}」`, 'success');
        };

        const runOpener = async (s, stageId, instruction = '') => {
            const label = `写${studioStageLabel(s, stageId)}的开场白`;
            const res = await runJob(s, { label, kind: 'opener', target: stageId }, (signal) => generateOpener(app.project, app.settings, s, stageId, { instruction, signal, onLog: log }));
            if (res) app.log(`🎬 已写好${studioStageLabel(s, stageId)}的开场白`, 'success');
        };

        const runExample = async (s, instruction = '') => {
            const res = await runJob(s, { label: '写示例对话', kind: 'example', target: 'example' }, (signal) => generateExample(app.project, app.settings, s, { instruction, signal, onLog: log }));
            if (res) app.log('💬 已写好示例对话', 'success');
        };

        const runBuild = async (s) => {
            const p = app.project;
            const prev = studioExistingCard(p, s);
            const plan = studioSavePlan(p, app.settings, s);
            const collision = plan.canOverwrite && view.collision === 'overwrite' ? 'overwrite' : 'suffix';
            const res = await runJob(s, { label: prev ? '更新卡片' : '生成角色卡', kind: 'build' }, async (signal) => {
                const r = buildStudioCard(app.project, app.settings, s, { collision });
                await app.saveNow(); // 先保存卡片：后面的状态栏失败也不会丢卡
                // 还没有可用的状态栏（没生成过、上次失败或中途停止）时生成；「停止」会中止这一步，卡片照常保留
                if (s.options.statusBar && !r.card.statusBar?.spec?.variables?.length) {
                    if (app.studioJob) app.studioJob.label = `为「${r.card.data.name}」生成状态栏`;
                    emitProgress();
                    const before = r.card.statusBar ? structuredClone(r.card.statusBar) : undefined;
                    try {
                        await generateStatusBarForCard(r.card, sbCtx(), { templateId: studioStatusBarTemplateId(app.settings), signal });
                    } catch (e) {
                        // 停止：状态栏回到生成之前（不留下只套了一半的模板），下次「更新卡片」再生成
                        if (isAbortError(e) || signal.aborted) {
                            if (before) r.card.statusBar = before;
                            else delete r.card.statusBar;
                        }
                        throw e;
                    }
                    if (!signal.aborted) await app.saveNow();
                }
                return r;
            });
            if (!res) return;
            const c = res.card;
            const renamed = res.saved.characters.filter((x) => x.savedAs !== x.name).map((x) => `${x.name} → ${x.savedAs}`);
            app.log(`🎴 已${res.created ? '生成' : '更新'}世界卡「${c.data.name}」：本卡世界书 ${(c.studio?.entries || []).length} 条，开场白 ${1 + c.data.alternate_greetings.length} 段${c.data.mes_example ? '，带示例对话' : ''}${c.statusBar?.spec?.variables?.length ? '，带状态栏' : ''}`, 'success');
            app.log(`角色 ${res.saved.characters.length} 个、地点 ${res.saved.lore.length} 个已存进项目${renamed.length ? `（同名另存：${renamed.join('、')}）` : ''}${res.saved.removed.characters.length ? `；不在卡上的角色已从项目里删掉：${res.saved.removed.characters.join('、')}` : ''}`);
            for (const w of res.warnings) app.log(`⚠️ ${w}`, 'warn');
        };

        /**
         * 写入酒馆。写入期间不能「更新卡片」（更新会换掉卡片对象，写入酒馆的绑定会记到旧的那个上）；
         * 万一卡片对象还是被换掉了，把绑定（头像文件名、世界书名、写入时间）补到项目里现在那张卡上。
         */
        const doPublish = async (card, btn) => {
            const s = current();
            if (s && studioExistingCard(app.project, s)?.id === card.id && studioCardStale(app.project, app.settings, s)) {
                const ok = await confirmDialog('草稿改过之后还没点「更新卡片」：写入酒馆的会是旧的内容。仍然写入？', { title: '卡还没更新', okLabel: '仍然写入' });
                if (!ok) return;
            }
            view.publishing = true;
            const buildBtn = el.querySelector('[data-act="build"]');
            if (buildBtn) buildBtn.disabled = true;
            let r;
            try {
                r = await busy(btn, async () => {
                    const res = await publishCard(app.project, app.settings, card, { overwrite: true, onLog: () => {} });
                    const live = app.project?.cards.find((c) => c.id === card.id);
                    if (live && live !== card) {
                        for (const k of ['stAvatar', 'ownWorldName', 'publishedAt', 'worldName']) if (card[k] !== undefined) live[k] = card[k];
                        if (live.statusBar && card.statusBar?.worldName) live.statusBar.worldName = card.statusBar.worldName;
                    }
                    await app.saveNow();
                    app.log(`🎴 已写入酒馆：角色「${card.data.name}」，绑定世界书「${res.worldName}」（${res.entryCount} 条）${res.statusBar ? '，带状态栏' : ''}`, 'success');
                    if (res.allow) app.log(res.allow.message, res.allow.level);
                    globalThis.toastr?.success(`「${card.data.name}」已写入酒馆`, 'NovelLoom');
                    return res;
                }, '写入中…');
            } finally {
                view.publishing = false;
            }
            if (r?.statusBar) await openStatusBarPublishHint(card, sbCtx());
            render();
        };

        /** 预览提示词：大纲 / 某个角色 / 某段开场白 / 示例对话 */
        const preview = async (what, id) => {
            const s = current();
            try {
                let r;
                let title = '';
                if (what === 'outline') {
                    // 新构思还没存进项目：用一份临时的构思和项目拼提示词
                    const src = s || createStudio(app.settings, { premise: view.draft?.premise || '', options: view.draft?.options || {} });
                    r = buildOutlinePrompt(app.project || createEmptyProject({ name: studioTitleFromPremise(src.premise) }), app.settings, src);
                    title = '大纲提示词预览';
                } else if (what === 'character') {
                    r = buildCharacterPrompt(app.project, app.settings, s, id);
                    title = '角色细节提示词预览';
                } else if (what === 'opener') {
                    r = buildOpenerPrompt(app.project, app.settings, s, id);
                    title = '开场白提示词预览';
                } else {
                    r = buildExamplePrompt(app.project, app.settings, s);
                    title = '示例对话提示词预览';
                }
                await openDialog({ title, wide: true, body: chainPreviewHtml(app.settings, 'studio', { system: r.system, prompt: r.prompt }) });
            } catch (err) {
                app.log(errorText(err), 'error');
            }
        };

        /** 预览卡片内容：描述、开场白对应的阶段、本卡世界书条目（不改项目） */
        const cardPreview = async (s) => {
            let card;
            try {
                card = assembleStudioCard(app.project, app.settings, s, { card: studioExistingCard(app.project, s) });
            } catch (err) {
                return app.log(errorText(err), 'error');
            }
            const entries = card.studio.entries;
            await openDialog({
                title: `卡片内容：${card.data.name}`,
                wide: true,
                body: `
                    <h4>描述（description）</h4><div class="nl-pre nl-small">${esc(card.data.description)}</div>
                    <h4>场景（scenario）</h4><div class="nl-pre nl-small">${esc(card.data.scenario)}</div>
                    <h4>开场白</h4><div class="nl-pre nl-small">${esc(card.studio.greetings.map((g, i) => `${i ? `备选开场白 ${i}` : '开场白'}：${g.label}`).join('\n'))}</div>
                    <h4>本卡世界书（${entries.length} 条）</h4>
                    <div class="nl-st-sum">${entries.map((e) => sumRow(e.kind === 'stages' ? '故事阶段（常驻）' : e.kind === 'character' ? '角色' : e.category, `<b>${esc(e.name)}</b><div class="nl-muted nl-small nl-clamp">${esc(String(e.content).slice(0, 200))}</div>`)).join('')}</div>`,
            });
            return undefined;
        };

        const onClick = async (e) => {
            const btn = e.target.closest('[data-act]');
            if (!btn || btn.disabled) return;
            const act = btn.dataset.act;
            if (act !== 'stop') flush();
            const p = app.project;
            const s = current();
            const id = btn.dataset.id || '';
            switch (act) {
                case 'stop':
                    app.stopStudioJob();
                    return;
                case 'new':
                    view.studioId = '';
                    view.draft = view.draft || freshDraft();
                    render();
                    el.querySelector('[data-sf="premise"]')?.focus();
                    return;
                case 'open':
                    if (id === view.studioId) return;
                    view.studioId = id;
                    view.tab = '';
                    render();
                    return;
                case 'rename': {
                    const t = getStudio(p, id);
                    if (!t) return;
                    const name = await promptDialog('构思的名字（只在草稿列表里用；卡名在第 2 步改）', draftTitle(t), { title: '重命名构思', maxlength: STUDIO_LIMITS.title });
                    if (name === null) return;
                    renameStudio(p, id, name);
                    await app.saveNow();
                    render();
                    return;
                }
                case 'delete': {
                    const t = getStudio(p, id);
                    if (!t) return;
                    if (jobFor(t)) return app.log('这份构思正在生成，先停止再删除', 'warn');
                    const ok = await confirmDialog(`删除构思「${draftTitle(t)}」？已经做成的卡不受影响（在「角色卡」页）。`, { title: '删除构思', okLabel: '删除', danger: true });
                    if (!ok) return;
                    removeStudio(p, id);
                    if (view.studioId === id) view.studioId = latestStudio(p)?.id || '';
                    await app.saveNow();
                    app.events.emit('nav');
                    app.log(`已删除构思「${draftTitle(t)}」`);
                    render();
                    return;
                }
                case 'goto-step':
                    if (s) goStep(s, Number(btn.dataset.step));
                    return;
                case 'target':
                    if (view.draft) view.draft.target = btn.dataset.val === 'current' ? 'current' : 'new';
                    render();
                    return;
                case 'profile-manage':
                    await openUserProfilesDialog({ select: (s || view.draft)?.options?.profileId || '' });
                    app.events.emit('nav');
                    render();
                    return;
                case 'orientation-manage': {
                    const oid = (s || view.draft)?.options?.orientationId || '';
                    await openOrientationTemplatesDialog({ select: oid && oid !== ORIENTATION_CUSTOM ? oid : '' });
                    render();
                    return;
                }
                case 'preview':
                    return preview(btn.dataset.what, id);
                case 'card-preview':
                    if (s) await cardPreview(s);
                    return;
                case 'outline': {
                    if (app.studioJob) return app.log('创意工坊已经有任务在运行', 'warn');
                    let target = s;
                    let instruction = '';
                    if (!target) {
                        target = await createFromDraft();
                        if (!target) return;
                        render();
                    } else {
                        if (!String(target.premise || '').trim()) {
                            app.log('请先写下你的创意', 'warn');
                            return el.querySelector('[data-sf="premise"]')?.focus();
                        }
                        // 大纲里已经有内容（哪怕阶段删光了）：先说明会清掉什么，确认后再整份重新生成
                        if (studioOutlineTouched(target)) {
                            const imp = outlineRerollImpact(target, 'all');
                            const locked = target.outline.cast.filter((c) => c.locked).length;
                            instruction = await rerollDialog({
                                title: '重新生成整份大纲',
                                message: `按现在的创意和选项重新设计世界观、角色阵容和故事阶段${locked ? `；锁定的 ${locked} 个角色原样保留` : ''}。`,
                                warn: imp.details || imp.openers ? `会清掉 ${[imp.details ? `${imp.details} 个没锁定角色的细节` : '', imp.openers ? `${imp.openers} 段开场白` : ''].filter(Boolean).join('、')}。` : '',
                            });
                            if (instruction === null) return;
                        }
                    }
                    return runOutline(target, { mode: 'all', instruction });
                }
                case 'reroll-outline': {
                    if (!s) return;
                    const mode = btn.dataset.mode;
                    const imp = outlineRerollImpact(s, mode);
                    const locked = s.outline.cast.filter((c) => c.locked).length;
                    const msg = {
                        all: `重新设计世界观、角色阵容和故事阶段${locked ? `；锁定的 ${locked} 个角色原样保留` : ''}。`,
                        world: '只重新生成卡名、一句话故事、世界观、规则、基调、地点和 {{user}} 的位置；角色和阶段不变。',
                        cast: `只重新生成没锁定的角色${locked ? `（锁定的 ${locked} 个保留）` : ''}；世界观和阶段不变。名字和身份没变的角色保留已经写好的细节。`,
                        stages: '只重新生成故事阶段；世界观和角色不变。',
                    }[mode];
                    const instruction = await rerollDialog({
                        title: `重新生成${OUTLINE_MODE_LABELS[mode]}`,
                        message: msg,
                        warn: imp.details || imp.openers ? `会清掉 ${[imp.details ? `${imp.details} 个角色的细节` : '', imp.openers ? `${imp.openers} 段开场白` : ''].filter(Boolean).join('、')}。` : '',
                        placeholder: mode === 'cast' ? '例如：多一个和 {{user}} 不对付的人；职业更分散' : mode === 'stages' ? '例如：中间加一个外来者登岛的阶段' : '',
                    });
                    if (instruction === null) return;
                    return runOutline(s, { mode, instruction });
                }
                case 'reroll-member': {
                    const m = s?.outline.cast.find((c) => c.id === id);
                    if (!m) return;
                    const imp = outlineRerollImpact(s, 'member', id);
                    const instruction = await rerollDialog({
                        title: `换掉「${m.name || '这个角色'}」`,
                        message: '换成一个新的人物填这个位置（名字、年龄、身份都换），世界观、其他角色和阶段不变。',
                        warn: imp.details ? `「${m.name}」已经展开的细节会清掉。` : '',
                        okLabel: '换掉',
                        placeholder: '例如：换成一个更年长、更冷静的人',
                    });
                    if (instruction === null) return;
                    return runOutline(s, { mode: 'member', memberId: id, instruction });
                }
                case 'cast-add': {
                    if (!s) return;
                    const m = studioAddCast(s);
                    if (!m) return app.log(`最多 ${STUDIO_LIMITS.cast} 个角色`, 'warn');
                    app.saveSoon();
                    render();
                    el.querySelector(`[data-cast="${CSS.escape(m.id)}"][data-cf="name"]`)?.focus();
                    return;
                }
                case 'cast-remove': {
                    const m = s?.outline.cast.find((c) => c.id === id);
                    if (!m) return;
                    const filled = ['done', 'partial'].includes(studioCastStatus(s, id));
                    if ((m.name || filled) && !(await confirmDialog(`删除角色「${m.name || '未命名'}」？${filled ? '已经展开的细节会一起删掉。' : ''}`, { title: '删除角色', okLabel: '删除', danger: true }))) return;
                    studioRemoveCast(s, id);
                    app.saveSoon();
                    render();
                    return;
                }
                case 'cast-lock': {
                    const m = s?.outline.cast.find((c) => c.id === id);
                    if (!m) return;
                    studioSetLocked(s, id, !m.locked);
                    app.saveSoon();
                    render();
                    return;
                }
                case 'stage-add': {
                    if (!s) return;
                    const st = studioAddStage(s);
                    if (!st) return app.log(`最多 ${STUDIO_LIMITS.stages} 个阶段`, 'warn');
                    app.saveSoon();
                    render();
                    el.querySelector(`[data-stage="${CSS.escape(st.id)}"][data-gf="name"]`)?.focus();
                    return;
                }
                case 'stage-remove': {
                    const st = s?.outline.stages.find((x) => x.id === id);
                    if (!st) return;
                    const has = String(s.openers[id] || '').trim();
                    if ((st.name || st.summary || has) && !(await confirmDialog(`删除阶段「${st.name || '未命名'}」？${has ? '这个阶段的开场白会一起删掉。' : ''}`, { title: '删除阶段', okLabel: '删除', danger: true }))) return;
                    studioRemoveStage(s, id);
                    app.saveSoon();
                    render();
                    return;
                }
                case 'stage-up':
                case 'stage-down': {
                    if (!s || !studioMoveStage(s, id, act === 'stage-up' ? -1 : 1)) return;
                    app.saveSoon();
                    render();
                    // 移到头了（这个按钮变成不能点）：焦点放到同一行的另一个方向上，不掉到页面外
                    const q = (a) => el.querySelector(`[data-act="${a}"][data-id="${CSS.escape(id)}"]`);
                    const b = q(act);
                    if (!b || b.disabled) q(act === 'stage-up' ? 'stage-down' : 'stage-up')?.focus();
                    return;
                }
                case 'loc-add': {
                    if (!s) return;
                    if (!studioAddLocation(s)) return app.log(`最多 ${STUDIO_LIMITS.locations} 个地点`, 'warn');
                    app.saveSoon();
                    render();
                    el.querySelector(`[data-loc="${s.outline.world.locations.length - 1}"][data-lf="name"]`)?.focus();
                    return;
                }
                case 'loc-remove': {
                    if (!s) return;
                    const i = Number(btn.dataset.i);
                    const l = s.outline.world.locations[i];
                    if (!l) return;
                    if ((l.name || l.desc) && !(await confirmDialog(`删除地点「${l.name || '未命名'}」？`, { title: '删除地点', okLabel: '删除', danger: true }))) return;
                    studioRemoveLocation(s, i);
                    app.saveSoon();
                    render();
                    return;
                }
                case 'tab':
                    selectTab(btn.dataset.tabKey);
                    return;
                case 'gen-all':
                    if (s) await runContent(s, false);
                    return;
                case 'regen-all': {
                    if (!s) return;
                    const ok = await confirmDialog('已经写好的角色细节、开场白和示例对话都会重新生成（你手动改过的也会被替换）。继续？', { title: '全部重写', okLabel: '全部重写' });
                    if (ok) await runContent(s, true);
                    return;
                }
                case 'char-gen': {
                    const m = s?.outline.cast.find((c) => c.id === id);
                    if (!m) return;
                    if (!m.name) return app.log('这个角色还没有名字：先在第 2 步填上', 'warn');
                    let instruction = '';
                    if (studioCastStatus(s, id) === 'done') {
                        instruction = await rerollDialog({ title: `重写「${m.name}」`, message: '整个角色重新展开：外貌、性格、说话方式、好感变化、秘密……都换一版（大纲里的定位不变）。', placeholder: '例如：更冷淡一点；和林夏的关系写得更紧张' });
                        if (instruction === null) return;
                    }
                    return runCharacter(s, m, { instruction });
                }
                case 'field': {
                    const m = s?.outline.cast.find((c) => c.id === id);
                    const f = studioDetailField(btn.dataset.field);
                    if (!m || !f) return;
                    const instruction = await rerollDialog({ title: `重写「${m.name}」的${f.label}`, message: `只重写「${f.label}」这一项，其余各项不变。`, placeholder: '例如：更具体一点；换一个方向' });
                    if (instruction === null) return;
                    return runCharacter(s, m, { field: f.key, instruction });
                }
                case 'aff-add': {
                    if (!s) return;
                    const det = s.details[id] || emptyDetails();
                    if ((det.affection || []).length >= STUDIO_LIMITS.affection) return;
                    updateStudio(p, s.id, { details: { [id]: { affection: [...(det.affection || []), { label: '', behavior: '' }] } } });
                    app.saveSoon();
                    render();
                    el.querySelector(`[data-det="${CSS.escape(id)}"][data-aff="${(s.details[id]?.affection?.length || 1) - 1}"][data-af="label"]`)?.focus();
                    return;
                }
                case 'aff-remove': {
                    if (!s) return;
                    const det = s.details[id];
                    const i = Number(btn.dataset.i);
                    if (!det?.affection?.[i]) return;
                    updateStudio(p, s.id, { details: { [id]: { affection: det.affection.filter((_, j) => j !== i) } } });
                    app.saveSoon();
                    render();
                    return;
                }
                case 'copy-portrait': {
                    const m = s?.outline.cast.find((c) => c.id === id);
                    return copyText(s?.details[id]?.portraitPrompt || '', m ? `「${m.name}」的立绘提示词` : '立绘提示词');
                }
                case 'copy-portraits':
                    return s ? copyText(studioPortraitPromptsText(s), '全部立绘提示词') : undefined;
                case 'opener': {
                    if (!s) return;
                    let instruction = '';
                    if (String(s.openers[id] || '').trim()) {
                        instruction = await rerollDialog({ title: `重写${studioStageLabel(s, id)}的开场白`, message: '换一种写法重写这段开场白（会参考现在的版本，写法要有实质区别）。', placeholder: '例如：从夜里篝火边开场；让苏晴先开口' });
                        if (instruction === null) return;
                    }
                    return runOpener(s, id, instruction);
                }
                case 'example': {
                    if (!s) return;
                    let instruction = '';
                    if (String(s.example || '').trim()) {
                        instruction = await rerollDialog({ title: '重写示例对话', message: '重新写 3 组示例对话。' });
                        if (instruction === null) return;
                    }
                    return runExample(s, instruction);
                }
                case 'collision':
                    view.collision = btn.dataset.val === 'overwrite' ? 'overwrite' : 'suffix';
                    render();
                    return;
                case 'build':
                    if (view.publishing) return app.log('正在写入酒馆：写完再更新卡片', 'warn');
                    if (s) await runBuild(s);
                    return;
                case 'edit-card':
                    app.pendingEditCardId = id;
                    return switchTab('cards');
                case 'publish': {
                    const card = p?.cards.find((c) => c.id === id);
                    if (card) await doPublish(card, btn);
                    return;
                }
                default:
            }
        };

        const onInput = (e) => {
            const t = e.target;
            if (!t.matches?.(BOUND) || t.type === 'checkbox' || t.tagName === 'SELECT') return;
            dirty.add(t);
            if (t.dataset.sf === 'premise') {
                const note = el.querySelector('[data-st-premise-note]');
                if (note) note.textContent = premiseNote(t.value);
                const n = premiseCastCount(t.value);
                const cnt = el.querySelector('[data-sf="options.count"]');
                if (cnt) cnt.placeholder = n ? `按创意：${n} 人` : 'AI 决定';
            }
            // 年龄、名字写到一半不写回（写回时会把「1」改成 18 岁、把重名的还原），离开输入框时再写回
            if (commitOnLeave(t)) return;
            flushSoon();
        };

        /** 写回一栏，并把规整后的值显示出来（年龄补上「岁」或改成 18 岁、立绘提示词补上 adult、标签用顿号连起来） */
        const commitAndShow = (t) => {
            dirty.delete(t);
            const ok = commitInput(t);
            if (current()) app.saveSoon();
            if (ok && t.type !== 'checkbox' && t.tagName !== 'SELECT') {
                const v = boundValue(current(), t);
                if (v !== t.value) t.value = v;
            }
            return ok;
        };

        const onChange = (e) => {
            const t = e.target;
            if (!t.matches?.(BOUND)) return;
            if (!commitAndShow(t)) return;
            // 改了会影响页面其他部分的选项、名字：重绘（等焦点移到下一栏后再画，焦点保留）
            const sf = t.dataset.sf || '';
            if (['options.profileId', 'options.orientationId', 'options.userRole.kind', 'options.examples', 'options.statusBar', 'outline.title'].includes(sf) || t.dataset.cf === 'name') renderSoon();
        };

        /** 离开输入框：还没写回的（重绘后接着写的那一栏不会再触发 change）写回 */
        const onFocusOut = (e) => {
            const t = e.target;
            if (dirty.has(t)) commitAndShow(t);
        };

        /** 第 3 步的标签：左右方向键 / Home / End 切换（选中即显示） */
        const onKeydown = (e) => {
            const tab = e.target.closest?.('[role="tab"]');
            if (!tab || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
            const all = [...el.querySelectorAll('[role="tab"]')];
            const i = all.indexOf(tab);
            const j = e.key === 'Home' ? 0 : e.key === 'End' ? all.length - 1 : (i + (e.key === 'ArrowRight' ? 1 : -1) + all.length) % all.length;
            e.preventDefault();
            selectTab(all[j].dataset.tabKey, true);
        };

        const onCompStart = () => {
            composing = true;
        };
        const onCompEnd = () => {
            composing = false;
            if (pendingRender) setTimeout(() => !composing && pendingRender && render(), 0);
        };

        el.addEventListener('click', onClick);
        el.addEventListener('input', onInput);
        el.addEventListener('change', onChange);
        el.addEventListener('focusout', onFocusOut);
        el.addEventListener('keydown', onKeydown);
        el.addEventListener('compositionstart', onCompStart);
        el.addEventListener('compositionend', onCompEnd);
        const offs = [app.events.on('studio:progress', onJob), app.events.on('studio:job', onJob)];
        render();
        return {
            destroy() {
                flush();
                for (const off of offs) off();
            },
        };
    },
};
