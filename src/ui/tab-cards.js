// 角色卡页：生成、编辑、审稿、写入酒馆、导出

import { app } from '../app.js';
import {
    buildCardPrompt, buildPngCard, cardPromptOpt, fixCardWithAI, generateCard, imageToPng, lintCardFor, regenerateCardField, regenerateOrientationNotes,
    timepointLabel,
} from '../cards.js';
import {
    addBranch, addBranchTemplate, addStage, branchTemplates, deductionMarkdown, DEFAULT_BRANCH_COUNT, ensureProjection,
    generateBranches, generateStages, removeBranch, removeBranchTemplate, removeStage, setSelectedBranches, updateBranch,
    updateBranchTemplate, updateStage,
} from '../deduce.js';
import { buildGroupPrompt, generateGroupCard, groupCardMarkdown, publishGroupCard } from '../group.js';
import { getVolumes, IMPORTANCE_RANK } from '../project.js';
import { errorText } from '../llm.js';
import {
    ORIENTATION_CUSTOM, getOrientationTemplate, listOrientationTemplates, normalizeCardOrientation, orientationEntryTitle, orientationFromPick,
} from '../orientation.js';
import { blobToDataUrl, cardOwnWorld, dataUrlToBlob, defaultWorldName, prepareCard, publishCard, statusBarWorldName } from '../publish.js';
import { characterExistsInST, openCharacterInST } from '../stio.js';
import { castRecordPath, serverPortraitHint, statusBarActive } from '../statusbar.js';
import { getStatusBarTemplate } from '../statusbar-templates.js';
import { bannedRulesFor, getStyleProfile } from '../style.js';
import { greetingText, testChatReply } from '../testchat.js';
import { USER_ROLE_KINDS, normalizeUserRole, userRoleLabel } from '../userrole.js';
import { downloadFile, estimateTokens, pickFile, safeFileName, truncate, uniq } from '../utils.js';
import { alertDialog, bindSettings, busy, chainPreviewHtml, confirmDialog, emptyState, esc, fmtTime, icon, importanceLabel, openDialog, optionList, promptDialog, rerollBtn } from './common.js';
import { openOrientationTemplatesDialog } from './orientation-dialog.js';
import { generateStatusBarForCard, openStatusBarDialog, openStatusBarPublishHint, statusBarTagHtml, statusBarTemplateOptions } from './statusbar-dialog.js';

const GREETING_SEP = '\n\n=====\n\n';

/** 没有封面/头像时的占位（attrs 由调用方拼好，例如 data-avatar-img） */
const avatarEmpty = (attrs = '', ico = 'cards') => `<div class="nl-avatar nl-avatar-empty" ${attrs}>${icon(ico, { size: 24 })}</div>`;

function lintSummary(lint = []) {
    const err = lint.filter((i) => i.level === 'error').length;
    const warn = lint.filter((i) => i.level === 'warn').length;
    if (!err && !warn) return `<span class="nl-ok">${icon('check', { size: 14 })} 审稿通过</span>`;
    return [
        err ? `<span class="nl-err">${icon('alert', { size: 14 })} ${err} 处问题</span>` : '',
        warn ? `<span class="nl-warn">${icon('alert', { size: 14 })} ${warn} 处提醒</span>` : '',
    ].filter(Boolean).join(' ');
}

/**
 * 编辑框里“绑定世界书名称”这一栏显示什么：带状态栏的卡写入它自己的一本世界书（statusBar.worldName），
 * 这一栏显示并修改的是那个名字；带剧情导向 / {{user}} 身份条目（或以前写入过专用世界书）的卡同样用自己的一本（ownWorldName，own: true）；
 * 其他卡是 card.worldName（留空 = 默认命名）。
 * @returns {{sb: boolean, shown: string, own?: true}} sb：显示的是不是卡片专用的世界书；own：专用世界书不是因为状态栏；shown：显示出来的值
 */
export function cardWorldField(project, settings, card) {
    const sb = statusBarActive(card);
    if (!sb && cardOwnWorld(card)) return { sb: true, own: true, shown: statusBarWorldName(project, settings, card) };
    return { sb, shown: sb ? statusBarWorldName(project, settings, card) : (card.worldName || defaultWorldName(project, settings, card.timepoint)) };
}

/** “绑定世界书名称”这一栏的标签（own：专用世界书不是因为状态栏，而是因为本卡条目） */
export function cardWorldLabelHtml(sb, own = false) {
    if (sb && own) return '绑定世界书名称 <span class="nl-muted" title="带剧情导向或 {{user}} 身份条目的卡写入并绑定自己专用的一本世界书（资料条目 + 本卡条目）">（本卡专用）</span>';
    return sb ? '绑定世界书名称 <span class="nl-muted" title="带状态栏的卡总是写入并绑定自己专用的一本世界书（资料条目 + 状态栏条目）">（状态栏卡专用）</span>' : '绑定世界书名称';
}

/**
 * 保存编辑框时把“绑定世界书名称”写回：写哪个字段由这一栏**显示时**的模式（field.sb）决定，不看保存时状态栏开没开——
 * 在编辑框里打开状态栏设置把状态栏关掉后原样保存，不会把状态栏专用世界书的名字写进 card.worldName（反过来也一样）。
 * 专用世界书的名字写回它当前的来源：已经记着状态栏专用名（或显示时是状态栏卡）写 statusBar.worldName，否则写 ownWorldName。
 * @param {object} card
 * @param {{sb: boolean, shown: string, own?: boolean}} field cardWorldField() 的结果（显示这一栏时的模式与值）
 * @param {string} input 输入框的值
 */
export function applyCardWorldInput(card, field, input) {
    const v = String(input ?? '').trim();
    if (field.sb) {
        // 没改动就不写死（留空 = 跟随默认命名）；清空也是回到默认
        if (v === String(field.shown).trim()) return;
        if (card.statusBar && (card.statusBar.worldName || !field.own)) card.statusBar.worldName = v;
        else card.ownWorldName = v;
        return;
    }
    card.worldName = v;
}

/**
 * 写卡选项里「同时生成状态栏」下面的说明：世界/旁白卡的状态栏为整个群像设计（{{char}} 是旁白）。
 * @param {'character'|'world'} kind
 */
export function statusBarFormNote(kind) {
    const tail = '导出的卡需要酒馆助手（JS-Slash-Runner）4.6 以上。生成后可以在卡片的「状态栏」里修改、配立绘、预览。';
    return kind === 'world'
        ? `世界/旁白卡的状态栏为整个群像设计：{{char}} 是旁白，AI 会把项目里的主要角色（到所选时间点为止）各记一套状态（好感、心情、服饰……），剧情中途出场的 NPC 随时加入，再加上时间、地点和主角自己的状态。${tail}`
        : `写完角色卡后接着让 AI 设计一套变量（好感、心情、位置……）和显示在每条回复下面的状态栏。${tail}`;
}

/**
 * 写卡选项里「状态栏模板」的下拉选项：世界/旁白卡的「自动」写成按群像设计（AI 按群像出变量表），其余同 statusBarTemplateOptions。
 * @param {object} settings
 * @param {'character'|'world'} kind
 */
export function cardStatusBarTemplateOptions(settings, kind) {
    const list = statusBarTemplateOptions(settings);
    return kind === 'world' ? list.map((o) => (o.value === '' ? { ...o, label: '自动（AI 按群像设计）' } : o)) : list;
}

export const WORLD_SINGLE_TEMPLATE_WARNING = '这个模板只记一个角色，不适合世界卡；建议用 自动 或 多人群像';

/**
 * 世界/旁白卡选了只记一个角色的模板时，「状态栏模板」下面的提示；没问题返回 ''。
 * 只看会被「沿用结构」的模板（有变量表）：变量表里没有主要角色记录（castRecordPath 为 ''）就提示。
 * 只有界面的模板只借外观，变量表仍由 AI 按群像设计，不提示。
 * @param {object} settings
 * @param {'character'|'world'} kind
 * @param {string} templateId '' = 自动
 */
export function statusBarTemplateWorldWarning(settings, kind, templateId) {
    if (kind !== 'world' || !templateId) return '';
    let t = null;
    try {
        t = getStatusBarTemplate(settings, templateId);
    } catch {
        return '';
    }
    if (!t?.spec?.variables?.length) return '';
    return castRecordPath(t.spec) ? '' : WORLD_SINGLE_TEMPLATE_WARNING;
}

/** 「状态栏模板」下面放提示的位置（总是在，没有提示时隐藏；换模板时由 syncStatusBarTemplateWarning 更新） */
export function statusBarTemplateWarningHtml(text) {
    return `<div class="nl-warn nl-small" id="nl-sb-tpl-warn" data-sb-tpl-warn role="status" ${text ? '' : 'hidden'}>${text ? `${icon('alert', { size: 12 })} ${esc(text)}` : ''}</div>`;
}

/**
 * 换了模板（或卡片类型）后更新提示，不整页重绘（否则“写卡选项”会收起来）。
 * @param {HTMLElement} root 写卡表单所在的容器
 * @param {string} text statusBarTemplateWorldWarning() 的结果
 */
export function syncStatusBarTemplateWarning(root, text) {
    const box = root?.querySelector('[data-sb-tpl-warn]');
    if (!box) return;
    box.innerHTML = text ? `${icon('alert', { size: 12 })} ${esc(text)}` : '';
    box.toggleAttribute('hidden', !text);
    const sel = root.querySelector('select[data-setting="cards.statusBarTemplateId"]');
    if (!sel) return;
    if (text) sel.setAttribute('aria-describedby', 'nl-sb-tpl-warn');
    else sel.removeAttribute('aria-describedby');
}

/** 卡片列表里「状态栏」按钮的说明（世界卡和角色卡都有） */
export function statusBarButtonTitle(card) {
    return card?.kind === 'world'
        ? 'MVU 变量状态栏（为整个群像设计）：变量、更新规则、界面、立绘、预览'
        : 'MVU 变量状态栏：变量、更新规则、界面、立绘、预览';
}

/** 导出 JSON / PNG 后：状态栏的立绘有存在酒馆服务器上的，提醒分享出去不会跟着走（不阻止导出） */
function exportPortraitHint(card) {
    const hint = statusBarActive(card) ? serverPortraitHint(card.statusBar?.portraits) : '';
    if (hint) app.log(`「${card.data?.name || ''}」：${hint}`, 'warn');
}

/**
 * 「卡的导向」下拉框的选项：不限、内置、我的、自定义（只这一次）。
 * @param {object} settings
 * @param {string} selected
 * @param {{current?: object|null}} opt current：卡片上的导向快照（编辑框用；模板已删除或是自定义时也列出来）
 */
export function orientationOptionsHtml(settings, selected, { current = null, custom = true } = {}) {
    const all = listOrientationTemplates(settings);
    const opt = (list) => optionList(list.map((t) => ({ value: t.id, label: t.name })), selected);
    const mine = all.filter((t) => !t.builtin);
    const cur = normalizeCardOrientation(current);
    const orphan = cur && !all.some((t) => t.id === cur.templateId)
        ? `<option value="${esc(cur.templateId || ORIENTATION_CUSTOM)}" ${selected === (cur.templateId || ORIENTATION_CUSTOM) ? 'selected' : ''}>${esc(cur.name)}（这张卡上的）</option>`
        : '';
    return [
        `<option value="" ${selected ? '' : 'selected'}>不限</option>`,
        orphan,
        `<optgroup label="内置">${opt(all.filter((t) => t.builtin))}</optgroup>`,
        mine.length ? `<optgroup label="我的模板">${opt(mine)}</optgroup>` : '',
        custom && !orphan.includes(`value="${ORIENTATION_CUSTOM}"`) ? `<option value="${ORIENTATION_CUSTOM}" ${selected === ORIENTATION_CUSTOM ? 'selected' : ''}>自定义（只这一次：输入名称和说明）</option>` : '',
    ].join('');
}

/**
 * 「{{user}} 扮演」下面的说明
 * @param {string} kind new | character | custom
 * @param {string} charName {{user}} 扮演的原著角色
 * @param {string} cardKind character | world
 */
export function userRoleFormNote(kind, charName = '', cardKind = 'character') {
    const who = charName ? `「${charName}」` : '这个角色';
    // 选了原著角色 / 自定义时身份以这里为准，上面的「你的要求」里不用再写（写了冲突时也以这里为准）
    const noDup = '上面的要求里不用再写 {{user}} 的身份。';
    if (kind === 'character' && cardKind === 'world') return `AI 会把${who}写成 {{user}}，原著里其他角色和 TA 的关系就是和你的关系，主要角色一览里不再单独列出 TA；卡自己的世界书里会加一条「{{user}} 的身份」。${noDup}`;
    if (kind === 'character') return `AI 会把${who}写成 {{user}}，原著里 TA 和 {{char}} 的关系就是你和 {{char}} 的关系（选了卡的导向时以导向为准）；卡自己的世界书里会加一条「{{user}} 的身份」。${noDup}`;
    if (kind === 'custom') return `按这段身份写卡；卡自己的世界书里会加一条「{{user}} 的身份」。${noDup}`;
    return '{{user}} 不是原著里的任何人；具体身份（如“刚转学来的同桌”）可以写在上面的要求里。';
}

/** 卡片列表里的「剧情导向」标签（没有导向时为空） */
export function orientationTagHtml(card) {
    const o = normalizeCardOrientation(card?.orientation);
    return o ? `<span class="nl-tag" title="剧情导向（写入酒馆时是卡自己世界书里的常驻条目）">导向：${esc(o.name)}</span>` : '';
}

/**
 * 写卡表单里记住的选择（切换页面后保留）。{{user}} 扮演（方式、角色、自定义的身份）和卡名只在同一个项目里沿用：
 * 换了项目还沿用「原著角色」的话，会默默选中新项目的第一个角色当 {{user}}。
 */
let lastCardForm = null;
const REMEMBERED_FORM_KEYS = ['userRoleKind', 'userRoleChar', 'userRoleText', 'orientationId', 'orientationCustomName', 'orientationCustomBrief', 'orientationRefine', 'cardName'];
const PROJECT_FORM_KEYS = new Set(['userRoleKind', 'userRoleChar', 'userRoleText', 'cardName']);

export const cardsTab = {
    mount(el, { switchTab }) {
        const form = {
            kind: 'character', charName: app.pendingCardChar || '', cardName: '', timepoint: '', requirement: '', greetings: app.settings.cards.greetings, firstMesLen: '400-800 字', avatarDataUrl: '', statusBarRequirement: '',
            userRoleKind: 'new', userRoleChar: '', userRoleText: '',
            orientationId: '', orientationCustomName: '', orientationCustomBrief: '', orientationRefine: true,
        };
        if (lastCardForm) {
            for (const k of REMEMBERED_FORM_KEYS) {
                if (PROJECT_FORM_KEYS.has(k) && lastCardForm.projectId !== app.project?.id) continue;
                if (lastCardForm[k] !== undefined) form[k] = lastCardForm[k];
            }
        }
        const rememberForm = () => {
            lastCardForm = { projectId: app.project?.id, ...Object.fromEntries(REMEMBERED_FORM_KEYS.map((k) => [k, form[k]])) };
        };
        delete app.pendingCardChar;
        const groupForm = { members: new Set(), timepoint: '', requirement: '' };
        /** 状态栏对话框的上下文（见 statusbar-dialog.js） */
        const sbCtx = () => ({ app, project: app.project, settings: app.settings, save: () => app.saveNow(), saveSettings: () => app.saveSettings(), onChange: () => render() });
        /** 这次写卡是否接着生成状态栏（角色卡和世界/旁白卡都可以；世界卡的状态栏为整个群像设计） */
        const wantStatusBar = () => !!app.settings.cards.statusBar;

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
                if (v) opts.push({ value: String(v.endChunk), label: `${v.name} 卷末（第 ${v.endChunk + 1} 段）` });
                opts.push({ value: String(c.index), label: `　第 ${c.index + 1} 段结束时：${truncate(c.title, 30)}` });
            }
            return opts;
        };

        /** 「{{user}} 扮演 → 原著角色」可选的角色：单人卡不能选卡片本人 */
        const userRoleChars = () => charOptions().filter((c) => form.kind === 'world' || c.value !== form.charName);
        /** 记住的「{{user}} 扮演」角色在当前可选列表里时返回它，否则空串 */
        const userRoleCharValid = () => (userRoleChars().some((c) => c.value === form.userRoleChar) ? form.userRoleChar : '');
        const userRoleCharHtml = () => {
            const list = userRoleChars();
            if (!list.length) return '<option value="">（没有别的角色）</option>';
            // 记住的角色不在这个项目里（或正好是这张单人卡本人）时不要悄悄换成第一个角色：显示「请选择」，生成前会提示；
            // 记住的值不清掉——换回别的卡片角色后它又有效时照样选中
            const cur = userRoleCharValid();
            return `${cur ? '' : '<option value="" selected>请选择角色…</option>'}${optionList(list, cur)}`;
        };

        /** 「{{user}} 扮演」「卡的导向」切换后只更新这几处显示，不整页重绘（否则“写卡选项”会收起来） */
        const syncFormExtras = () => {
            const kind = form.userRoleKind;
            el.querySelector('[data-ur-char]')?.toggleAttribute('hidden', kind !== 'character');
            el.querySelector('[data-ur-custom]')?.toggleAttribute('hidden', kind !== 'custom');
            const note = el.querySelector('[data-ur-note]');
            if (note) note.textContent = userRoleFormNote(kind, userRoleCharValid(), form.kind);
            const id = form.orientationId;
            el.querySelector('[data-orient-custom]')?.toggleAttribute('hidden', id !== ORIENTATION_CUSTOM);
            el.querySelector('[data-orient-refine]')?.toggleAttribute('hidden', !id);
            const brief = el.querySelector('[data-orient-brief]');
            if (brief) {
                const t = id && id !== ORIENTATION_CUSTOM ? getOrientationTemplate(app.settings, id) : null;
                brief.textContent = t ? t.brief : id === ORIENTATION_CUSTOM ? '输入这次的导向名称和说明（不存成模板）。' : '不加导向，按原著和你的要求写。';
            }
        };

        const render = () => {
            const p = app.project;
            const chars = charOptions();
            if (!form.charName && chars.length) form.charName = chars[0].value;
            if (form.orientationId && form.orientationId !== ORIENTATION_CUSTOM && !getOrientationTemplate(app.settings, form.orientationId)) form.orientationId = '';
            const sbTpls = cardStatusBarTemplateOptions(app.settings, form.kind);
            if (!sbTpls.some((t) => t.value === (app.settings.cards.statusBarTemplateId || ''))) app.settings.cards.statusBarTemplateId = '';
            const sbTplId = app.settings.cards.statusBarTemplateId || '';
            const sbTplWarn = statusBarTemplateWorldWarning(app.settings, form.kind, sbTplId);
            const sbOn = !!app.settings.cards.statusBar;
            el.innerHTML = `
            <section class="nl-card">
                <div class="nl-card-head">
                    <div><h3>新建角色卡</h3></div>
                </div>
                <div class="nl-row nl-wrap">
                    ${form.avatarDataUrl ? `<img class="nl-avatar" src="${form.avatarDataUrl}" data-form-avatar-img>` : avatarEmpty('data-form-avatar-img')}
                    <div class="nl-field nl-grow">
                        <label>封面（可选，先选好再生成；也可以生成后在编辑里改）</label>
                        <div class="nl-row"><button class="nl-btn nl-sm" data-act="form-avatar">${icon('upload', { size: 14 })}上传封面</button>${form.avatarDataUrl ? '<button class="nl-btn nl-sm" data-act="form-avatar-clear">清除封面</button>' : ''}</div>
                    </div>
                </div>
                <div class="nl-grid2">
                    <div class="nl-field"><label>卡片类型</label><select class="nl-input" data-form="kind">${optionList([{ value: 'character', label: '单人角色卡（{{char}} = 某个角色）' }, { value: 'world', label: '世界/旁白卡（{{char}} = 叙述者，扮演所有 NPC）' }], form.kind)}</select></div>
                    <div class="nl-field" ${form.kind === 'world' ? 'hidden' : ''}><label>角色</label><select class="nl-input" data-form="charName">${optionList(chars, form.charName)}</select></div>
                    <div class="nl-field" ${form.kind === 'world' ? '' : 'hidden'}><label for="nl-card-name">卡名 <span class="nl-muted">（留空 = 书名）</span></label><input class="nl-input" id="nl-card-name" data-form="cardName" value="${esc(form.cardName)}" placeholder="${esc(p.bookName)}"></div>
                    <div class="nl-field"><label>故事时间点（防剧透：只用该时间点之前的资料）</label><select class="nl-input" data-form="timepoint">${optionList(timeOptions(), form.timepoint)}</select></div>
                    <div class="nl-field"><label>备选开场白数量 / 开场白长度</label><div class="nl-row"><input class="nl-input" type="number" min="0" max="6" data-form="greetings" value="${form.greetings}"><input class="nl-input" data-form="firstMesLen" value="${esc(form.firstMesLen)}"></div></div>
                </div>
                <div class="nl-field"><label>你的要求（与角色的关系、开场场景、尺度、视角等）</label>
                    <textarea class="nl-input nl-textarea" rows="3" data-form="requirement" placeholder="例如：开场在放学后的天台；{{char}} 对 {{user}} 还有戒心；第二人称叙述">${esc(form.requirement)}</textarea></div>
                <div class="nl-grid2">
                    <div class="nl-field">
                        <label for="nl-ur-kind">{{user}} 扮演</label>
                        <select class="nl-input" id="nl-ur-kind" data-form="userRoleKind" aria-describedby="nl-ur-note">${optionList(USER_ROLE_KINDS, form.userRoleKind)}</select>
                        <select class="nl-input" data-form="userRoleChar" data-ur-char aria-label="{{user}} 扮演的原著角色" ${form.userRoleKind === 'character' ? '' : 'hidden'}>${userRoleCharHtml()}</select>
                        <textarea class="nl-input nl-textarea" rows="2" data-form="userRoleText" data-ur-custom aria-label="{{user}} 的身份" placeholder="例如：{{user}} 是莉莉丝新雇的调酒师，二十岁，刚搬到下城区" ${form.userRoleKind === 'custom' ? '' : 'hidden'}>${esc(form.userRoleText)}</textarea>
                        <div class="nl-muted nl-small" id="nl-ur-note" data-ur-note>${esc(userRoleFormNote(form.userRoleKind, userRoleCharValid(), form.kind))}</div>
                    </div>
                    <div class="nl-field">
                        <label for="nl-orient">卡的导向</label>
                        <div class="nl-row">
                            <select class="nl-input nl-grow" id="nl-orient" data-form="orientationId" aria-describedby="nl-orient-brief">${orientationOptionsHtml(app.settings, form.orientationId)}</select>
                            <button class="nl-btn nl-sm" data-act="orientation-manage" title="查看内置导向，新建、修改、导入导出自己的导向模板">${icon('settings', { size: 14 })}管理导向模板</button>
                        </div>
                        <div class="nl-orient-custom" data-orient-custom ${form.orientationId === ORIENTATION_CUSTOM ? '' : 'hidden'}>
                            <input class="nl-input" data-form="orientationCustomName" aria-label="导向名称" maxlength="20" placeholder="导向名称，例如「师徒禁忌」" value="${esc(form.orientationCustomName)}">
                            <textarea class="nl-input nl-textarea" rows="2" data-form="orientationCustomBrief" aria-label="导向说明" maxlength="200" placeholder="说明这次想要的剧情方向，例如：{{user}} 是 {{char}} 的徒弟，师徒之间暗生情愫，但谁都不敢说破">${esc(form.orientationCustomBrief)}</textarea>
                        </div>
                        <div class="nl-muted nl-small" id="nl-orient-brief" data-orient-brief></div>
                        <label class="nl-check-line" data-orient-refine ${form.orientationId ? '' : 'hidden'}><input type="checkbox" data-form="orientationRefine" ${form.orientationRefine ? 'checked' : ''}> 让 AI 结合本书细化导向词条</label>
                    </div>
                </div>
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
                    <div class="nl-sb-form">
                        <label><input type="checkbox" data-setting="cards.statusBar"> 同时生成状态栏（MVU 变量）${form.kind === 'world' ? '：为整个群像设计' : ''}</label>
                        <div class="nl-muted nl-small" data-sb-form-note>${esc(statusBarFormNote(form.kind))}</div>
                        <div class="nl-grid2" data-sb-form-opts ${sbOn ? '' : 'hidden'}>
                            <div class="nl-field"><label>状态栏模板</label><select class="nl-input" data-setting="cards.statusBarTemplateId"${sbTplWarn ? ' aria-describedby="nl-sb-tpl-warn"' : ''}>${optionList(sbTpls, sbTplId)}</select>${statusBarTemplateWarningHtml(sbTplWarn)}</div>
                            <div class="nl-field"><label>状态栏要求（可选）</label><input class="nl-input" data-form="statusBarRequirement" value="${esc(form.statusBarRequirement)}" placeholder="${form.kind === 'world' ? '例如：主要角色记录好感、心情和服饰；NPC 只记身份和阵营' : '例如：重点记录好感和体力；记录随身物品'}"></div>
                        </div>
                    </div>
                </details>
                <div class="nl-muted nl-small">文风：<b>${esc(getStyleProfile(p, app.settings, 'card')?.name || '不指定')}</b>（用于开场白与示例对话；勾选“文风”条目时也写进世界书）${bannedRulesFor(p, app.settings, 'card').length ? ` · 审稿会检查 ${bannedRulesFor(p, app.settings, 'card').length} 个禁用词` : ''} <a href="#" data-act="goto-style">修改</a></div>
                <div class="nl-row">
                    <button class="nl-btn nl-primary" data-act="generate" ${!chars.length && form.kind !== 'world' ? 'disabled' : ''}>生成</button>
                    <button class="nl-btn" data-act="preview">预览提示词</button>
                    <span class="nl-muted nl-small" data-sb-gen-hint ${sbOn ? '' : 'hidden'}>会同时生成状态栏</span>
                    ${!chars.length ? '<span class="nl-muted">还没有角色资料，请先提取。</span>' : ''}
                </div>
            </section>

            <section class="nl-card">
                <div class="nl-card-head">
                    <div><h3>已生成的角色卡（${p.cards.length}）</h3></div>
                </div>
                <div class="nl-cards">
                    ${p.cards.slice().reverse().map((c) => `
                    <div class="nl-cardbox" data-id="${esc(c.id)}">
                        ${c.avatarDataUrl ? `<img class="nl-avatar" src="${c.avatarDataUrl}" alt="">` : avatarEmpty()}
                        <div class="nl-grow">
                            <div><b>${esc(c.data.name)}</b> <span class="nl-tag">${c.kind === 'world' ? '世界卡' : '角色卡'}</span> ${statusBarTagHtml(c)} ${orientationTagHtml(c)} ${c.stAvatar ? (characterExistsInST(c.stAvatar) ? '<span class="nl-tag nl-ok">已在酒馆</span>' : '<span class="nl-tag">酒馆中已删除</span>') : ''}</div>
                            <div class="nl-muted nl-small">${esc(timepointLabel(p, Number.isFinite(c.timepoint) ? c.timepoint : Infinity))} · ${fmtTime(c.updatedAt)} · 约 ${estimateTokens(c.data.description + c.data.first_mes)} tokens</div>
                            <div class="nl-small">${lintSummary(c.lint)}</div>
                            <div class="nl-small nl-clamp">${esc(truncate(c.data.first_mes, 120))}</div>
                        </div>
                        <div class="nl-card-actions">
                            <button class="nl-btn nl-sm" data-act="edit" data-id="${esc(c.id)}">编辑</button>
                            <button class="nl-btn nl-sm" data-act="testchat" data-id="${esc(c.id)}" title="写入酒馆前先在这里聊两句，看看开场白和回复怎么样">${icon('message', { size: 14 })}试聊</button>
                            <button class="nl-btn nl-sm" data-act="deduce" data-id="${esc(c.id)}" title="根据这张卡当前的设定和相关世界书，推演剧情走向">${icon('crystal', { size: 14 })}剧情推演</button>
                            <button class="nl-btn nl-sm" data-act="statusbar" data-id="${esc(c.id)}" title="${esc(statusBarButtonTitle(c))}">状态栏</button>
                            <button class="nl-btn nl-sm" data-act="publish" data-id="${esc(c.id)}">${icon('upload', { size: 14 })}${c.stAvatar ? '更新到酒馆' : '写入酒馆'}</button>
                            ${c.stAvatar && characterExistsInST(c.stAvatar) ? `<button class="nl-btn nl-sm" data-act="open-st" data-id="${esc(c.id)}">在酒馆打开</button>` : ''}
                            <button class="nl-btn nl-sm" data-act="json" data-id="${esc(c.id)}">导出 JSON</button>
                            <button class="nl-btn nl-sm" data-act="png" data-id="${esc(c.id)}">导出 PNG</button>
                            ${rerollBtn('regen', `data-id="${esc(c.id)}"`, { label: '重新生成', title: '整张卡重新生成' })}
                            <button class="nl-btn nl-sm nl-danger" data-act="delete" data-id="${esc(c.id)}">删除</button>
                        </div>
                    </div>`).join('') || emptyState('在上面选好角色和故事时间点后点「生成」，生成的角色卡会出现在这里，可以审稿、试聊后写入酒馆。', '', { title: '还没有角色卡', ico: 'cards' })}
                </div>
            </section>

            <section class="nl-card">
                <div class="nl-card-head">
                    <div>
                        <h3>群聊场景卡</h3>
                        <div class="nl-card-desc">挑几个已经确立关系的角色，AI 设计一个可以把他们放进同一个酒馆群聊的开场情境；写入酒馆时会把这些角色已发布的卡拉进一个新建的群聊（每个角色需要先在上面写入酒馆）。</div>
                    </div>
                </div>
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
                        ${avatarEmpty('', 'users')}
                        <div class="nl-grow">
                            <div><b>${esc(g.name)}</b> ${g.stGroupId ? '<span class="nl-tag nl-ok">已在酒馆</span>' : ''}</div>
                            <div class="nl-muted nl-small">${esc(g.members.join('、'))} · ${fmtTime(g.updatedAt)}</div>
                            <div class="nl-small nl-clamp">${esc(truncate(g.data.first_mes || g.data.scenario, 120))}</div>
                        </div>
                        <div class="nl-card-actions">
                            <button class="nl-btn nl-sm" data-act="group-edit" data-gid="${esc(g.id)}">查看/编辑</button>
                            <button class="nl-btn nl-sm" data-act="group-publish" data-gid="${esc(g.id)}">${icon('upload', { size: 14 })}${g.stGroupId ? '更新群聊' : '创建群聊'}</button>
                            <button class="nl-btn nl-sm" data-act="group-md" data-gid="${esc(g.id)}">${icon('copy', { size: 14 })}复制 Markdown</button>
                            <button class="nl-btn nl-sm nl-danger" data-act="group-delete" data-gid="${esc(g.id)}">删除</button>
                        </div>
                    </div>`).join('') || emptyState('勾选至少两个角色后点「生成群聊场景」，生成的群聊场景卡会出现在这里。', '', { title: '还没有群聊场景卡', ico: 'users' })}
                </div>
            </section>`;
            bindSettings(el, app.settings, () => app.saveSettings());
            syncFormExtras();
        };

        const opts = () => ({
            kind: form.kind,
            charName: form.charName,
            cardName: form.kind === 'world' ? form.cardName : '',
            timepoint: form.timepoint === '' ? Infinity : Number(form.timepoint),
            requirement: form.requirement,
            greetings: Number(form.greetings) || 0,
            firstMesLen: form.firstMesLen,
            userRole: { kind: form.userRoleKind, charKey: form.userRoleKind === 'character' ? form.userRoleChar : '', text: form.userRoleKind === 'custom' ? form.userRoleText : '' },
            orientation: orientationFromPick(app.settings, {
                id: form.orientationId, customName: form.orientationCustomName, customBrief: form.orientationCustomBrief, refine: form.orientationRefine,
            }),
        });

        /** 生成前检查表单里「{{user}} 扮演」「卡的导向」是否填完整；有问题返回提示文字 */
        const formProblem = () => {
            if (form.userRoleKind === 'character' && !userRoleChars().some((c) => c.value === form.userRoleChar)) return '请选择 {{user}} 扮演的原著角色';
            if (form.userRoleKind === 'custom' && !String(form.userRoleText || '').trim()) return '请填写 {{user}} 的身份，或改回「原创新身份」';
            if (form.orientationId === ORIENTATION_CUSTOM && !String(form.orientationCustomName || '').trim() && !String(form.orientationCustomBrief || '').trim()) return '请填写自定义导向的名称和说明，或选择别的导向';
            return '';
        };

        const editCard = async (card) => {
            const d = card.data;
            const field = (k, label, rows = 4, val = d[k]) => `<div class="nl-field"><label>${label} <span class="nl-muted nl-small" data-tok="${k}">${estimateTokens(val)} tokens</span> ${rerollBtn('reroll-field', `data-field="${k}"`, { title: '只重新生成这一个字段，其余部分不变' })}</label><textarea class="nl-input nl-textarea" rows="${rows}" data-card="${k}">${esc(val)}</textarea></div>`;
            const lintHtml = (lint) => (lint?.length ? lint.map((i) => `<div class="nl-lint nl-lint-${i.level}"><b>[${esc(i.fieldLabel)}] ${esc(i.type)}</b>：${esc(i.context)} <span class="nl-muted">→ ${esc(i.tip)}</span></div>`).join('') : `<div class="nl-ok">${icon('check', { size: 14 })} 没有发现问题</div>`);
            // 带状态栏的卡写入它自己的一本世界书（statusBar.worldName），编辑框显示并修改的是这个名字；
            // 保存时按这一栏显示时的模式写回（见 applyCardWorldInput），不按保存那一刻状态栏开没开
            let worldField = cardWorldField(app.project, app.settings, card);
            // 剧情导向：编辑框里的草稿（换导向、改词条正文 / 本书落点都先改草稿，保存时写回 card.orientation）
            const savedOrient = normalizeCardOrientation(card.orientation);
            const orientId = (o) => (o ? o.templateId || ORIENTATION_CUSTOM : '');
            /** 编辑框里剧情导向一节的当前内容 → 导向快照；选了「不限」返回 null */
            const readOrientEdit = (r) => {
                const id = r.querySelector('[data-orient-pick]')?.value || '';
                if (!id) return null;
                const base = id === orientId(savedOrient) ? savedOrient : orientationFromPick(app.settings, { id, refine: true });
                if (!base) return null;
                const entry = r.querySelector('[data-orient-entry]')?.value ?? base.entry;
                const notes = r.querySelector('[data-orient-notes]')?.value ?? base.notes;
                return normalizeCardOrientation({ ...base, entry, notes, refine: base.refine || !!String(notes).trim() });
            };
            const { value, root } = await openDialog({
                title: `编辑角色卡：${d.name}`,
                wide: true,
                body: `
                    <div class="nl-row nl-wrap nl-card-edit-head">
                        ${card.avatarDataUrl ? `<img class="nl-avatar" src="${card.avatarDataUrl}" data-avatar-img>` : avatarEmpty('data-avatar-img')}
                        <button class="nl-btn nl-sm" data-card-act="avatar">${icon('upload', { size: 14 })}上传头像</button>
                        <button class="nl-btn nl-sm" data-card-act="avatar-clear">清除头像</button>
                        <div class="nl-field nl-grow"><label>名称</label><input class="nl-input" data-card="name" value="${esc(d.name)}"></div>
                        <div class="nl-field nl-grow"><label data-card-world-label>${cardWorldLabelHtml(worldField.sb, worldField.own)}</label><input class="nl-input" data-card-world value="${esc(worldField.shown)}"></div>
                    </div>
                    <details class="nl-lint-box" open><summary>审稿（本地规则，不耗 token）</summary><div data-lint>${lintHtml(card.lint)}</div>
                        <div class="nl-row"><button class="nl-btn nl-sm" data-card-act="lint">重新扫描</button><button class="nl-btn nl-sm" data-card-act="fix">AI 按审稿意见修正</button></div></details>
                    ${field('description', '描述（description）', 12)}
                    ${field('personality', '性格摘要（personality）', 2)}
                    ${field('scenario', '场景（scenario）', 3)}
                    ${field('first_mes', '开场白（first_mes）', 10)}
                    ${field('alternate_greetings', '备选开场白（用 ===== 分隔）', 8, d.alternate_greetings.join(GREETING_SEP))}
                    ${field('mes_example', '示例对话（mes_example）', 8)}
                    <section class="nl-orient-edit" data-orient-edit>
                        <div class="nl-row nl-wrap">
                            <label class="nl-orient-edit-title" for="nl-oe-pick">剧情导向</label>
                            <select class="nl-input nl-grow" id="nl-oe-pick" data-orient-pick>${orientationOptionsHtml(app.settings, orientId(savedOrient), { current: savedOrient, custom: false })}</select>
                            ${rerollBtn('reroll-orient-notes', savedOrient ? '' : 'disabled', { label: '重新生成本书落点', title: '只让 AI 结合本书重新写【本书落点】，词条正文和卡片其余部分不变' })}
                        </div>
                        <div class="nl-muted nl-small" data-orient-edit-note>${savedOrient ? `写入酒馆时放进这张卡自己的世界书：常驻条目「${esc(orientationEntryTitle(savedOrient))}」，插在聊天深度 ${esc(savedOrient.depth)}。` : '不限：不加剧情导向词条。'}</div>
                        <div data-orient-edit-body ${savedOrient ? '' : 'hidden'}>
                            <div class="nl-field"><label for="nl-oe-entry">词条正文</label><textarea class="nl-input nl-textarea" id="nl-oe-entry" rows="6" data-orient-entry>${esc(savedOrient?.entry || '')}</textarea></div>
                            <div class="nl-field"><label for="nl-oe-notes">本书落点 <span class="nl-muted">（接在词条正文后面的【本书落点】；留空就只有正文）</span></label><textarea class="nl-input nl-textarea" id="nl-oe-notes" rows="4" data-orient-notes placeholder="- 原伴侣是……&#10;- 关键阻碍是……">${esc(savedOrient?.notes || '')}</textarea></div>
                        </div>
                        <div class="nl-muted nl-small">{{user}} 扮演：${esc(userRoleLabel(app.project, card.userRole))}${normalizeUserRole(card.userRole).kind !== 'new' ? '（写成卡自己世界书里的「{{user}} 的身份」条目）' : ''}</div>
                    </section>
                    <details><summary>更多字段</summary>
                        ${field('system_prompt', '系统提示词覆盖（system_prompt）', 3)}
                        ${field('post_history_instructions', '历史后指令（post_history_instructions）', 3)}
                        ${field('creator_notes', '作者备注（creator_notes）', 2)}
                        <div class="nl-field"><label>标签（逗号分隔）</label><input class="nl-input" data-card="tags" value="${esc(d.tags.join('，'))}"></div>
                        <div class="nl-field"><label>状态栏（MVU 变量）${card.kind === 'world' ? ' <span class="nl-muted nl-small">世界/旁白卡：为整个群像设计</span>' : ''}</label><div class="nl-row">${statusBarTagHtml(card) || '<span class="nl-muted nl-small">这张卡还没有状态栏</span>'}<button class="nl-btn nl-sm" data-card-act="statusbar">打开状态栏设置</button></div></div>
                    </details>`,
                buttons: [{ label: '取消', value: null }, { label: '保存', value: 'save' }, { label: '保存并写入酒馆', value: 'publish', primary: true }],
                onMount: (r) => {
                    const collect = () => readCardForm(r, card);
                    r.addEventListener('input', (e) => {
                        const k = e.target.dataset.card;
                        const tok = k && r.querySelector(`[data-tok="${k}"]`);
                        if (tok) tok.textContent = `${estimateTokens(e.target.value)} tokens`;
                    });
                    // 每个导向在这个编辑框里改过的正文和落点（按下拉框的值记）：换导向前先记下当前的，误换了再换回来时恢复刚才的编辑
                    // （取消对话框则全部不保存）
                    const orientDrafts = {};
                    let prevOrientId = orientId(savedOrient);
                    // 换导向：换回改过的导向时恢复刚才的正文和落点；第一次换到卡上原来的导向时用卡上的；
                    // 换成别的模板时正文换成模板的、落点清空（可以再点骰子重新生成）
                    r.querySelector('[data-orient-pick]')?.addEventListener('change', (e) => {
                        const id = e.target.value;
                        const body = r.querySelector('[data-orient-edit-body]');
                        const note = r.querySelector('[data-orient-edit-note]');
                        const reroll = r.querySelector('[data-act="reroll-orient-notes"]');
                        const entryEl = r.querySelector('[data-orient-entry]');
                        const notesEl = r.querySelector('[data-orient-notes]');
                        if (prevOrientId) orientDrafts[prevOrientId] = { entry: entryEl.value, notes: notesEl.value };
                        prevOrientId = id;
                        const next = !id ? null : id === orientId(savedOrient) ? savedOrient : orientationFromPick(app.settings, { id, refine: true });
                        body?.toggleAttribute('hidden', !next);
                        if (reroll) reroll.disabled = !next;
                        if (note) note.textContent = next ? `写入酒馆时放进这张卡自己的世界书：常驻条目「${orientationEntryTitle(next)}」，插在聊天深度 ${next.depth}。${next === savedOrient ? '' : '换了导向，可以点「重新生成本书落点」让 AI 按新导向写。'}` : '不限：不加剧情导向词条。';
                        if (!next) return;
                        const kept = orientDrafts[id];
                        entryEl.value = kept ? kept.entry : next.entry;
                        notesEl.value = kept ? kept.notes : next === savedOrient ? next.notes : '';
                    });
                    r.addEventListener('click', async (e) => {
                        const rerollNotes = e.target.closest('[data-act="reroll-orient-notes"]');
                        if (rerollNotes) {
                            const draft = readOrientEdit(r);
                            if (!draft) return undefined;
                            if (app.isBusy()) return app.log('已有任务在运行', 'warn');
                            const instruction = await promptDialog('可选：对本书落点的额外要求（留空则让 AI 自行发挥）', '', { title: '重新生成本书落点', multiline: true });
                            if (instruction === null) return undefined;
                            const pick = r.querySelector('[data-orient-pick]');
                            const pickedId = pick?.value || '';
                            await busy(rerollNotes, async () => {
                                const notes = await regenerateOrientationNotes(app.project, app.settings, { ...card, data: collect() }, { orientation: draft, instruction });
                                // 生成期间换了导向：这份落点是按原来的导向写的，不填进现在的导向；记在原来导向的草稿里，换回去就能看到
                                if ((pick?.value || '') !== pickedId) {
                                    orientDrafts[pickedId] = { ...(orientDrafts[pickedId] || { entry: draft.entry }), notes };
                                    app.log(`本书落点已按「${draft.name}」生成，但剧情导向已经换了，没有填进去；换回「${draft.name}」就能看到`, 'warn');
                                    return;
                                }
                                r.querySelector('[data-orient-notes]').value = notes;
                            }, '生成中…');
                            // busy 结束会把按钮重新启用；现在选的是「不限」时保持禁用
                            rerollNotes.disabled = !pick?.value;
                            return undefined;
                        }
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
                            r.querySelector('[data-avatar-img]').outerHTML = avatarEmpty('data-avatar-img');
                        } else if (act === 'statusbar') {
                            // 不关闭编辑框：状态栏对话框叠在上面，关掉后回到这里继续编辑
                            await openStatusBarDialog(card, sbCtx());
                            const tag = statusBarTagHtml(card);
                            const host = b.parentElement;
                            if (host) {
                                host.innerHTML = `${tag || '<span class="nl-muted nl-small">这张卡还没有状态栏</span>'}<button class="nl-btn nl-sm" data-card-act="statusbar">打开状态栏设置</button>`;
                                // 原来有焦点的按钮被换掉了，焦点会掉到 <body>：放回新按钮上（Esc / 关闭后键盘还停在原处）
                                if (!document.activeElement || document.activeElement === document.body) host.querySelector('[data-card-act="statusbar"]')?.focus({ preventScroll: true });
                            }
                            // 状态栏开关变了：世界书名称这一栏没改过的话换成对应模式的名字和标签；改过就保留输入，仍按原来的模式保存
                            const next = cardWorldField(app.project, app.settings, card);
                            const worldInp = r.querySelector('[data-card-world]');
                            if (next.sb !== worldField.sb && worldInp && worldInp.value.trim() === String(worldField.shown).trim()) {
                                worldField = next;
                                worldInp.value = next.shown;
                                const lab = r.querySelector('[data-card-world-label]');
                                if (lab) lab.innerHTML = cardWorldLabelHtml(next.sb);
                            }
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
            card.orientation = readOrientEdit(root);
            applyCardWorldInput(card, worldField, root.querySelector('[data-card-world]').value);
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

        const editBranchDialog = async (existing) => {
            const b = existing || { title: '', summary: '' };
            const { value, root } = await openDialog({
                title: existing ? '编辑走向' : '添加走向',
                body: `
                    <div class="nl-field"><label>标题</label><input class="nl-input" data-f="title" value="${esc(b.title)}"></div>
                    <div class="nl-field"><label>概要</label><textarea class="nl-input nl-textarea" rows="4" data-f="summary">${esc(b.summary)}</textarea></div>`,
                buttons: [{ label: '取消', value: null }, { label: '保存', value: 'ok', primary: true }],
            });
            if (value !== 'ok') return null;
            const title = root.querySelector('[data-f="title"]').value.trim();
            const summary = root.querySelector('[data-f="summary"]').value.trim();
            if (!title && !summary) return null;
            return { title, summary };
        };

        const editStageDialog = async (existing) => {
            const s = existing || { title: '', content: '' };
            const { value, root } = await openDialog({
                title: existing ? '编辑阶段' : '添加阶段',
                body: `
                    <div class="nl-field"><label>标题</label><input class="nl-input" data-f="title" value="${esc(s.title)}"></div>
                    <div class="nl-field"><label>内容</label><textarea class="nl-input nl-textarea" rows="6" data-f="content">${esc(s.content)}</textarea></div>`,
                buttons: [{ label: '取消', value: null }, { label: '保存', value: 'ok', primary: true }],
            });
            if (value !== 'ok') return null;
            const title = root.querySelector('[data-f="title"]').value.trim();
            const content = root.querySelector('[data-f="content"]').value.trim();
            if (!title && !content) return null;
            return { title, content };
        };

        /** 简单的模板选择器：点一个模板，返回它的方向提示文本（不是直接当成走向，套用后还会结合卡面重新展开） */
        const pickTemplateDialog = async () => {
            const tpls = branchTemplates(app.settings);
            if (!tpls.length) {
                await alertDialog('还没有保存的模板。可以先在走向槽位里写点方向提示，点 💾 存成模板。', '没有模板');
                return null;
            }
            const { value } = await openDialog({
                title: '选择一个走向模板',
                body: `<div class="nl-cards">${tpls.map((t) => `
                    <div class="nl-cardbox" data-tpl="${esc(t.id)}" style="cursor:pointer">
                        <div class="nl-grow"><b>${esc(t.label)}</b><div class="nl-small nl-muted">${esc(t.hint)}</div></div>
                    </div>`).join('')}</div>`,
                buttons: [{ label: '取消', value: null }],
                onMount: (root, close) => {
                    root.addEventListener('click', (e) => {
                        const box = e.target.closest('[data-tpl]');
                        if (!box) return;
                        const t = tpls.find((x) => x.id === box.dataset.tpl);
                        close(t ? t.hint : null);
                    });
                },
            });
            return value;
        };

        /** 走向模板管理：保存在扩展设置里，跨项目共享；改名/改提示可就地编辑，删除需要二次确认 */
        const openBranchTemplatesDialog = async () => {
            const tpls = branchTemplates(app.settings);
            const body = `
                <div class="nl-muted nl-small">模板存的是"大方向点子"，套用到某张卡的走向槽位时，会由 AI 结合这张卡的具体设定重新展开，不是原样照抄。保存在扩展设置里，所有项目共用。</div>
                <table class="nl-table" style="margin-top:8px">
                    <thead><tr><th>名称</th><th>方向提示</th><th></th></tr></thead>
                    <tbody>
                        ${tpls.map((t) => `<tr data-tplid="${esc(t.id)}">
                            <td><input class="nl-input" data-tpl-label value="${esc(t.label)}"></td>
                            <td><input class="nl-input" data-tpl-hint value="${esc(t.hint)}"></td>
                            <td><button class="nl-icon-btn nl-danger" data-tpl-del title="删除" aria-label="删除">${icon('trash')}</button></td>
                        </tr>`).join('') || '<tr><td colspan="3" class="nl-muted">还没有保存的模板</td></tr>'}
                        <tr>
                            <td><input class="nl-input" data-tpl-new-label placeholder="名称，例如「反目成仇」"></td>
                            <td><input class="nl-input" data-tpl-new-hint placeholder="方向提示，例如「两人因为一个误会彻底决裂」"></td>
                            <td><button class="nl-btn nl-sm" data-tpl-add>${icon('plus', { size: 14 })}添加</button></td>
                        </tr>
                    </tbody>
                </table>`;
            const { value } = await openDialog({
                title: '走向模板管理',
                wide: true,
                body,
                buttons: [{ label: '关闭', value: null }],
                onMount: (r, close) => {
                    r.addEventListener('change', (e) => {
                        const tr = e.target.closest('[data-tplid]');
                        if (!tr) return;
                        const id = tr.dataset.tplid;
                        if (e.target.matches('[data-tpl-label]')) updateBranchTemplate(app.settings, id, { label: e.target.value });
                        if (e.target.matches('[data-tpl-hint]')) updateBranchTemplate(app.settings, id, { hint: e.target.value });
                        app.saveSettings();
                    });
                    r.addEventListener('click', async (e) => {
                        // 按钮里是 SVG 图标，点到图标时 e.target 是 svg/path，所以用 closest 找按钮
                        if (e.target.closest('[data-tpl-del]')) {
                            const tr = e.target.closest('[data-tplid]');
                            const t = tpls.find((x) => x.id === tr.dataset.tplid);
                            if (!(await confirmDialog(`删除模板「${t?.label}」？`, { danger: true, okLabel: '删除' }))) return;
                            removeBranchTemplate(app.settings, tr.dataset.tplid);
                            app.saveSettings();
                            close('refresh');
                        } else if (e.target.closest('[data-tpl-add]')) {
                            const labelInput = r.querySelector('[data-tpl-new-label]');
                            const hintInput = r.querySelector('[data-tpl-new-hint]');
                            try {
                                addBranchTemplate(app.settings, { label: labelInput.value, hint: hintInput.value });
                                app.saveSettings();
                                close('refresh');
                            } catch (err) {
                                app.log(err.message, 'error');
                            }
                        }
                    });
                },
            });
            if (value === 'refresh') await openBranchTemplatesDialog();
        };

        /** 生成/重新生成走向：干预方式是给每条走向单独写方向提示（留空=不限方向），也可以套用/存成模板；
         *  重新生成时默认带入上次各条走向的标题，方便只改其中一条、其余大致保持不变。 */
        const openGenBranchesDialog = async (pp) => {
            const hints = pp.branches.length ? pp.branches.map((b) => b.title) : new Array(DEFAULT_BRANCH_COUNT).fill('');
            const box = document.createElement('div');
            const slotRow = (hint, i) => `
                <div class="nl-row nl-wrap" data-slot-idx="${i}">
                    <span class="nl-muted nl-small" style="width:1.6em">${i + 1}.</span>
                    <input class="nl-input nl-grow" data-slot-hint placeholder="不限方向，由 AI 自由发挥" value="${esc(hint)}">
                    <button class="nl-icon-btn" data-act="pick-tpl" title="套用已保存的模板" aria-label="套用已保存的模板">${icon('file')}</button>
                    <button class="nl-icon-btn" data-act="save-tpl" title="把这条方向存成模板" aria-label="把这条方向存成模板">${icon('save')}</button>
                    <button class="nl-icon-btn" data-act="del-slot" title="删除这一条" aria-label="删除这一条">${icon('close')}</button>
                </div>`;
            const renderSlots = () => {
                box.querySelector('[data-slots]').innerHTML = hints.map(slotRow).join('');
            };
            box.innerHTML = `
                <div class="nl-muted nl-small">可以不干预，直接点下面「生成」；也可以给某一条单独写方向提示，或套用保存的模板——留空的条目不限方向，由 AI 自由发挥，但会和其他几条有明显区别。</div>
                <div class="nl-list" data-slots style="margin-bottom:8px"></div>
                <div class="nl-row">
                    <button class="nl-btn nl-sm" data-act="add-slot">${icon('plus', { size: 14 })}加一条走向</button>
                    <span class="nl-spacer"></span>
                    <button class="nl-btn nl-sm" data-act="manage-tpl">${icon('settings', { size: 14 })}管理模板</button>
                </div>
                <div class="nl-field"><label>整体额外要求（可选，对每条走向都适用）</label><textarea class="nl-input nl-textarea" rows="3" data-instruction></textarea></div>`;
            renderSlots();

            box.addEventListener('input', (e) => {
                if (!e.target.matches('[data-slot-hint]')) return;
                const i = Number(e.target.closest('[data-slot-idx]').dataset.slotIdx);
                hints[i] = e.target.value;
            });
            box.addEventListener('click', async (e) => {
                const btn = e.target.closest('[data-act]');
                if (!btn) return;
                const slotEl = btn.closest('[data-slot-idx]');
                const i = slotEl ? Number(slotEl.dataset.slotIdx) : -1;
                switch (btn.dataset.act) {
                    case 'add-slot':
                        if (hints.length >= 8) { app.log('最多 8 条走向', 'warn'); return; }
                        hints.push('');
                        renderSlots();
                        return;
                    case 'del-slot':
                        if (hints.length <= 2) { app.log('至少保留 2 条走向', 'warn'); return; }
                        hints.splice(i, 1);
                        renderSlots();
                        return;
                    case 'pick-tpl': {
                        const hint = await pickTemplateDialog();
                        if (hint === null) return;
                        hints[i] = hint;
                        renderSlots();
                        return;
                    }
                    case 'save-tpl': {
                        const cur = (hints[i] || '').trim();
                        if (!cur) { app.log('这一条还没有方向内容，先写点什么再存', 'warn'); return; }
                        const label = await promptDialog('模板名称', cur.slice(0, 16), { title: '存为走向模板' });
                        if (!label) return;
                        try {
                            addBranchTemplate(app.settings, { label, hint: cur });
                            app.saveSettings();
                            app.log(`💾 已保存模板「${label}」`, 'success');
                        } catch (err) {
                            app.log(err.message, 'error');
                        }
                        return;
                    }
                    case 'manage-tpl':
                        await openBranchTemplatesDialog();
                        return;
                    default:
                        return;
                }
            });

            const { value } = await openDialog({
                title: pp.branches.length ? '重新生成走向' : '生成走向',
                wide: true,
                body: box,
                buttons: [{ label: '取消', value: null }, { label: '生成', value: 'ok', primary: true }],
            });
            if (value !== 'ok') return null;
            const instruction = box.querySelector('[data-instruction]').value.trim();
            return { instruction, directions: hints.map((h) => h.trim()) };
        };

        const deduceDialog = async (card) => {
            const pp = ensureProjection(card);
            const box = document.createElement('div');
            box.className = 'nl-tab-body'; // 竖排并留出版块间距，两个版块不贴在一起

            const branchItem = (b) => `
                <div class="nl-cardbox" data-bid="${esc(b.id)}">
                    <label class="nl-row" style="align-items:flex-start">
                        <input type="checkbox" data-branch-check value="${esc(b.id)}" ${pp.selectedBranchIds.includes(b.id) ? 'checked' : ''}>
                    </label>
                    <div class="nl-grow">
                        <b>${esc(b.title)}</b>
                        <div class="nl-small">${esc(b.summary)}</div>
                    </div>
                    <div class="nl-card-actions">
                        <button class="nl-icon-btn" data-act="edit-branch" data-bid="${esc(b.id)}" title="编辑" aria-label="编辑">${icon('edit')}</button>
                        <button class="nl-icon-btn nl-danger" data-act="del-branch" data-bid="${esc(b.id)}" title="删除" aria-label="删除">${icon('trash')}</button>
                    </div>
                </div>`;
            const stageItem = (s, i) => `
                <div class="nl-cardbox" data-sid="${esc(s.id)}">
                    <div class="nl-grow">
                        <b>${i + 1}. ${esc(s.title)}</b>
                        <div class="nl-small nl-pre">${esc(s.content)}</div>
                    </div>
                    <div class="nl-card-actions">
                        <button class="nl-icon-btn" data-act="edit-stage" data-sid="${esc(s.id)}" title="编辑" aria-label="编辑">${icon('edit')}</button>
                        <button class="nl-icon-btn nl-danger" data-act="del-stage" data-sid="${esc(s.id)}" title="删除" aria-label="删除">${icon('trash')}</button>
                    </div>
                </div>`;

            // 版块标题栏里按钮多：nl-wrap 让按钮在窄屏换行；标题用 flex-basis auto，否则 card-head 默认的 flex:1（basis 0）会把标题挤成一字一行
            const renderBody = () => {
                box.innerHTML = `
                    <div class="nl-muted nl-small">基于这张卡<b>当前</b>的实际设定（不是原著后续大纲）和相关世界书，先给出几个并列的可能走向；勾选其中一个或几个后，再推演出具体的分阶段发展。不会自动写回卡片字段或项目大纲，只挂在这张卡自己身上，可以随时编辑、删除、导出。</div>
                    <section class="nl-card">
                        <div class="nl-card-head nl-wrap">
                            <div style="flex: 1 1 auto"><h3>可能的走向</h3></div>
                            ${rerollBtn('gen-branches', '', { label: pp.branches.length ? '重新生成走向' : '生成走向' })}
                            <button class="nl-btn nl-sm" data-act="add-branch">${icon('plus', { size: 14 })}手动添加</button>
                            <button class="nl-btn nl-sm" data-act="manage-tpl" title="管理走向模板：保存的大方向点子，跨项目共用">${icon('file', { size: 14 })}走向模板</button>
                        </div>
                        <div class="nl-cards">${pp.branches.length ? pp.branches.map(branchItem).join('') : emptyState('还没有走向，点上面生成，或者手动添加。', '', { ico: 'crystal' })}</div>
                    </section>
                    <section class="nl-card">
                        <div class="nl-card-head nl-wrap">
                            <div style="flex: 1 1 auto">
                                <h3>分阶段推演</h3>
                                ${pp.selectedBranchIds.length ? '' : '<div class="nl-card-desc">先在上面勾选至少一个走向，再来推演具体的分阶段发展。</div>'}
                            </div>
                            ${rerollBtn('gen-stages', '', { label: pp.stages.length ? '重新推演' : '开始推演' })}
                            <button class="nl-btn nl-sm" data-act="add-stage">${icon('plus', { size: 14 })}手动添加</button>
                            <button class="nl-btn nl-sm" data-act="export-md" ${pp.branches.length || pp.stages.length ? '' : 'disabled'}>${icon('copy', { size: 14 })}复制 Markdown</button>
                        </div>
                        <div class="nl-cards">${pp.stages.length ? pp.stages.map(stageItem).join('') : emptyState('勾选上面的走向后点「开始推演」，分阶段发展会出现在这里；也可以手动添加。', '', { title: '还没有分阶段推演', ico: 'plan' })}</div>
                    </section>`;
            };
            renderBody();

            box.addEventListener('change', async (e) => {
                if (!e.target.hasAttribute('data-branch-check')) return;
                const ids = pp.selectedBranchIds.slice();
                const id = e.target.value;
                const i = ids.indexOf(id);
                if (e.target.checked && i < 0) ids.push(id);
                else if (!e.target.checked && i >= 0) ids.splice(i, 1);
                setSelectedBranches(card, ids);
                await app.saveNow();
                renderBody();
            });

            box.addEventListener('click', async (e) => {
                const btn = e.target.closest('[data-act]');
                if (!btn) return;
                switch (btn.dataset.act) {
                    case 'gen-branches': {
                        if (app.isBusy()) return app.log('已有任务在运行', 'warn');
                        const res = await openGenBranchesDialog(pp);
                        if (!res) return;
                        await busy(btn, async () => {
                            await generateBranches(app.project, app.settings, card, res);
                            await app.saveNow();
                        }, '推演中…');
                        return renderBody();
                    }
                    case 'manage-tpl':
                        await openBranchTemplatesDialog();
                        return;
                    case 'add-branch': {
                        const b = await editBranchDialog(null);
                        if (!b) return;
                        addBranch(card, b);
                        await app.saveNow();
                        return renderBody();
                    }
                    case 'edit-branch': {
                        const cur = pp.branches.find((x) => x.id === btn.dataset.bid);
                        if (!cur) return;
                        const b = await editBranchDialog(cur);
                        if (!b) return;
                        updateBranch(card, cur.id, b);
                        await app.saveNow();
                        return renderBody();
                    }
                    case 'del-branch':
                        if (!(await confirmDialog('删除这个走向？', { danger: true, okLabel: '删除' }))) return;
                        removeBranch(card, btn.dataset.bid);
                        await app.saveNow();
                        return renderBody();
                    case 'gen-stages': {
                        if (!pp.selectedBranchIds.length) return app.log('请先勾选至少一个走向', 'warn');
                        if (app.isBusy()) return app.log('已有任务在运行', 'warn');
                        const instruction = await promptDialog('可选：给这次分阶段推演的额外要求（留空则让 AI 自行发挥）', '', { title: '分阶段推演', multiline: true });
                        if (instruction === null) return;
                        await busy(btn, async () => {
                            await generateStages(app.project, app.settings, card, { instruction });
                            await app.saveNow();
                        }, '推演中…');
                        return renderBody();
                    }
                    case 'add-stage': {
                        const s = await editStageDialog(null);
                        if (!s) return;
                        addStage(card, s);
                        await app.saveNow();
                        return renderBody();
                    }
                    case 'edit-stage': {
                        const cur = pp.stages.find((x) => x.id === btn.dataset.sid);
                        if (!cur) return;
                        const s = await editStageDialog(cur);
                        if (!s) return;
                        updateStage(card, cur.id, s);
                        await app.saveNow();
                        return renderBody();
                    }
                    case 'del-stage':
                        if (!(await confirmDialog('删除这个阶段？', { danger: true, okLabel: '删除' }))) return;
                        removeStage(card, btn.dataset.sid);
                        await app.saveNow();
                        return renderBody();
                    case 'export-md':
                        try {
                            await navigator.clipboard.writeText(deductionMarkdown(card));
                            app.log('📋 已复制到剪贴板', 'success');
                        } catch {
                            downloadFile(deductionMarkdown(card), `${safeFileName(card.data.name)}-剧情推演.md`, 'text/markdown');
                        }
                        return;
                    default:
                        return;
                }
            });

            await openDialog({ title: `剧情推演：${card.data.name}`, wide: true, body: box, buttons: [{ label: '关闭', value: null }] });
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
            const r = await busy(btn, async () => {
                const res = await publishCard(app.project, app.settings, card, { overwrite: true, onLog: () => {} });
                await app.saveNow();
                app.log(`🎴 已写入酒馆：角色「${card.data.name}」${app.settings.cards.linkWorldbook || res.statusBar || res.ownWorld ? `，绑定世界书「${res.worldName}」（${res.entryCount} 条）` : ''}${res.statusBar ? '，带状态栏' : ''}${normalizeCardOrientation(card.orientation) ? `，剧情导向「${normalizeCardOrientation(card.orientation).name}」` : ''}`, 'success');
                // 写入后自动允许本卡的局部正则 / 角色脚本（设置页「状态栏」一节可关）的结果，排在写入结果后面
                if (res.allow) app.log(res.allow.message, res.allow.level);
                globalThis.toastr?.success(`角色「${card.data.name}」已写入酒馆`, 'NovelLoom');
                return res;
            }, '写入中…');
            // 带状态栏的卡：提示导入内嵌世界书、允许本卡正则（可一键，需确认）、允许酒馆助手脚本
            if (r?.statusBar) await openStatusBarPublishHint(card, sbCtx());
        };

        const onClick = async (e) => {
            const btn = e.target.closest('[data-act]');
            if (!btn) return;
            const p = app.project;
            const card = btn.dataset.id ? p.cards.find((c) => c.id === btn.dataset.id) : null;
            switch (btn.dataset.act) {
                case 'generate':
                case 'regen': {
                    // 整卡重新生成沿用这张卡生成时的选项（{{user}} 的身份、卡的导向快照、世界卡的卡名）
                    const o = card ? { ...cardPromptOpt(card), firstMesLen: form.firstMesLen } : opts();
                    if (o.kind !== 'world' && !p.characters[o.charName]) return app.log('请选择角色', 'warn');
                    if (!card) {
                        const problem = formProblem();
                        if (problem) return app.log(problem, 'warn');
                    }
                    // 新建时按“写卡选项”接着生成状态栏；整卡重新生成只沿用旧状态栏（标记为过时），不重新生成
                    const withStatusBar = !card && wantStatusBar();
                    const sbOpt = { requirement: form.statusBarRequirement, templateId: app.settings.cards.statusBarTemplateId || '' };
                    const result = await busy(btn, async () => {
                        const r = await generateCard(p, app.settings, o, { onLog: (m, l) => app.log(m, l) });
                        if (card) {
                            r.id = card.id;
                            r.avatarDataUrl = card.avatarDataUrl;
                            r.stAvatar = card.stAvatar;
                            r.worldName = card.worldName;
                            if (card.ownWorldName) r.ownWorldName = card.ownWorldName;
                            if (card.statusBar) {
                                r.statusBar = card.statusBar;
                                if (r.statusBar.spec?.variables?.length) r.statusBar.stale = true;
                            }
                            p.cards[p.cards.indexOf(card)] = r;
                        } else {
                            r.avatarDataUrl = form.avatarDataUrl || '';
                            p.cards.push(r);
                        }
                        await app.saveNow(); // 先保存卡片：后面的状态栏失败也不会丢卡
                        if (withStatusBar) {
                            btn.innerHTML = `<span class="nl-spin"></span>${esc('AI 生成状态栏中…')}`;
                            await generateStatusBarForCard(r, sbCtx(), sbOpt);
                            await app.saveNow();
                        }
                        return r;
                    }, 'AI 写卡中…');
                    if (!result) return;
                    app.log(`🎴 已生成「${result.data.name}」${result.lint.length ? `，审稿发现 ${result.lint.filter((i) => i.level !== 'info').length} 处可改进` : ''}`, 'success');
                    if (card && result.statusBar?.stale) app.log(`「${result.data.name}」的状态栏沿用了旧的变量和初始值，可能需要在「状态栏」里更新初始值`, 'warn');
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
                case 'orientation-manage': {
                    await openOrientationTemplatesDialog({ select: form.orientationId && form.orientationId !== ORIENTATION_CUSTOM ? form.orientationId : '' });
                    // 模板可能新增、改名或删除：只刷新下拉框（选中的被删掉了就回到「不限」），不整页重绘
                    if (form.orientationId && form.orientationId !== ORIENTATION_CUSTOM && !getOrientationTemplate(app.settings, form.orientationId)) form.orientationId = '';
                    const sel = el.querySelector('[data-form="orientationId"]');
                    if (sel) sel.innerHTML = orientationOptionsHtml(app.settings, form.orientationId);
                    rememberForm();
                    syncFormExtras();
                    return;
                }
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
                case 'deduce':
                    return deduceDialog(card);
                case 'statusbar':
                    return openStatusBarDialog(card, sbCtx());
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
                    let json;
                    try {
                        ({ json } = prepareCard(p, app.settings, card)); // 状态栏界面有错误时会拒绝导出（StatusBarExportError）
                    } catch (err) {
                        return alertDialog(errorText(err), '导出失败');
                    }
                    downloadFile(JSON.stringify(json, null, 2), `${safeFileName(card.data.name)}.json`);
                    exportPortraitHint(card);
                    return;
                }
                case 'png': {
                    const ok = await busy(btn, async () => {
                        const { json } = prepareCard(p, app.settings, card);
                        const blob = await buildPngCard(json, card.avatarDataUrl ? await dataUrlToBlob(card.avatarDataUrl) : null);
                        downloadFile(blob, `${safeFileName(card.data.name)}.png`, 'image/png');
                        return true;
                    });
                    if (ok) exportPortraitHint(card);
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
            if (e.target.dataset.setting === 'cards.statusBar') {
                // 只切换显示，不整页重绘（否则“写卡选项”会收起来）
                const on = e.target.checked;
                el.querySelector('[data-sb-form-opts]')?.toggleAttribute('hidden', !on);
                el.querySelector('[data-sb-gen-hint]')?.toggleAttribute('hidden', !on);
                return;
            }
            if (e.target.dataset.setting === 'cards.statusBarTemplateId') {
                syncStatusBarTemplateWarning(el, statusBarTemplateWorldWarning(app.settings, form.kind, e.target.value));
                return;
            }
            const k = e.target.dataset.form;
            if (!k) return;
            form[k] = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
            if (REMEMBERED_FORM_KEYS.includes(k)) rememberForm();
            if (k === 'kind') return render();
            if (k === 'charName' && e.type === 'change') {
                // 单人卡换了角色：「{{user}} 扮演」的原著角色列表里去掉新的卡片角色
                const sel = el.querySelector('[data-ur-char]');
                if (sel) sel.innerHTML = userRoleCharHtml();
                rememberForm();
            }
            if (['userRoleKind', 'userRoleChar', 'orientationId', 'charName'].includes(k)) syncFormExtras();
        };

        el.addEventListener('click', onClick);
        el.addEventListener('change', onFormChange);
        el.addEventListener('input', onFormChange);
        render();
        return {};
    },
};

