// 用户画像页：左边列出画像，右边编辑选中的画像（改动自动保存）。不需要打开项目——画像存在扩展设置里，所有项目共用。
// 画像 = 偏好的导向 + 喜欢的元素 + 雷点 + 尺度 + {{user}} 的默认形象 + 叙事偏好 + 其他 + 「聊天时也照顾这些偏好」；
// 写卡时在「角色卡」页选一个画像，AI 按它量身定制（见 userprofile.js）。可新建、复制、删除（需确认）、导入 / 导出 JSON。
// 列表 + 编辑区由 mountProfilesEditor 渲染：「用户画像」页和写卡表单的「管理用户画像」对话框（openUserProfilesDialog）共用，
// 在写卡表单里管理画像不用离开角色卡页（表单里填了一半的内容不会丢）。
// 每一项的可选内容都可以添加自定义的并保存进常用库（所有画像共用，见 profilelib.js），管理的控件按需出现：
//   - 喜欢 / 雷点 / 叙事偏好：每个建议分组末尾的「添加」把自己的标签存进这个分组；「编辑常用标签」里删掉自定义的、隐藏内置的
//     （「恢复默认」放回来）、新建 / 重命名 / 删除自定义分组；画像里输入的、常用库里没有的标签可以「存进常用标签」；
//   - 尺度：「自定义尺度」新建（名称 + 写进提示词的说明），「管理自定义尺度」里修改、删除；
//   - 偏好的导向：「新建导向」打开导向模板管理并新建一个，关掉后马上出现并选上；
//   - {{user}} 的默认形象、其他：「存为常用」「插入常用…」。
// 自定义的项（标签、分组名、尺度、我的导向模板）文字后面带一个小圆点，和内置的区分开。

import { app } from '../app.js';
import { getOrientationTemplate, listOrientationTemplates } from '../orientation.js';
import {
    PROFILE_LIBRARY_LIMITS, PROFILE_SNIPPET_FIELDS, PROFILE_TAG_TARGETS, STYLE_GROUP_ID, TAG_SEPARATORS, USER_PROFILE_DEFAULT_INTENSITY, addCustomIntensity,
    addLibraryGroup, addLibraryTags, addProfileSnippet, cleanTagList, intensityInfo, intensityNameProblem, intensityUsage, libKey, libraryGroupNameProblem,
    libraryGroupOfTag, libraryGroups, libraryMergeSummary, profileIntensities, profileLibraryCounts, profileSnippets, removeCustomIntensity, removeLibraryGroup, removeLibraryTag,
    removeProfileSnippet, renameLibraryGroup, restoreLibraryTags, snippetDefaultName, tagKey, trimEndPunct, updateCustomIntensity,
} from '../profilelib.js';
import {
    USER_PROFILE_LIMITS, addUserProfile, duplicateUserProfile, exportUserProfiles, getUserProfile, importUserProfileFile, isDislikedName, joinStyleTags,
    listUserProfiles, normalizeProfileTags, orientationConflicts, profileIntensityInfo, removeUserProfile, styleTags, uniqueUserProfileName, updateUserProfile,
    userProfileFileName, userProfileNameProblem, userProfileSummary,
} from '../userprofile.js';
import { downloadFile, pickFile, readFileAsText } from '../utils.js';
import { alertDialog, confirmDialog, emptyState, esc, icon, openDialog, promptDialog } from './common.js';
import { openOrientationTemplatesDialog } from './orientation-dialog.js';

const LIB = PROFILE_LIBRARY_LIMITS;

/** 切换页面（或关掉对话框）后回来时仍选中上次的画像 */
let lastSelected = '';

/** 三类标签编辑区：喜欢 / 雷点（数组）、叙事偏好（字符串，按 、/，/, 拆成一项一项） */
const TAG_KINDS = {
    likes: { label: '喜欢的元素', note: '角色属性、外形服饰、癖好……写卡时自然融入，不会生硬罗列', placeholder: '输入后按回车或逗号添加', noun: '标签', lib: '常用标签' },
    dislikes: { label: '雷点', note: '绝对避免：卡里不出现，连暗示都不要', placeholder: '输入雷点，回车或逗号添加', noun: '标签', lib: '常用标签' },
    style: { label: '叙事偏好', note: '与卡的文风冲突时以这里为准', placeholder: '例如：第二人称，回车或逗号添加', noun: '写法', lib: '常用写法' },
};

/** 一项最多几个字：标签 12 字，叙事偏好 20 字 */
const tagMax = (kind) => (kind === 'style' ? USER_PROFILE_LIMITS.styleTag : USER_PROFILE_LIMITS.tag);
/** 标签输入框能输入多长：够粘贴一整串用逗号隔开的标签（规整时截短；截掉时会提示） */
const tagInputMax = (kind) => (kind === 'style' ? USER_PROFILE_LIMITS.text : USER_PROFILE_LIMITS.tag * USER_PROFILE_LIMITS.tags + USER_PROFILE_LIMITS.tags);

/** 画像里一类已选的标签 */
const tagsOf = (p, kind) => (kind === 'style' ? styleTags(p.style) : p[kind]);
/** 这一类满了（输入框停用）：喜欢 / 雷点各 40 个；叙事偏好整段 1000 字 */
const isFull = (p, kind) => (kind === 'style' ? p.style.length >= USER_PROFILE_LIMITS.text : p[kind].length >= USER_PROFILE_LIMITS.tags);
/** 输入框里的一串文字拆成一项一项（不截短，用来判断有没有超长的） */
const splitPieces = (raw) => String(raw ?? '').split(TAG_SEPARATORS).map((x) => x.replace(/^[#＃]+/, '').trim()).filter(Boolean);
/** 规整输入的标签（喜欢 / 雷点每个 12 字，叙事偏好每项 20 字） */
const cleanTyped = (kind, raw) => (kind === 'style' ? cleanTagList(raw, { max: tagMax('style'), count: 1000 }) : normalizeProfileTags(raw));
/** 同一个标签：不分大小写、不管空白；叙事偏好末尾的标点也不算（存进画像时会去掉，「多写对话。」就是「多写对话」） */
const sameTag = (a, b, kind) => tagKey(kind, a) === tagKey(kind, b);

/** 自定义项的标记：文字后面一个小圆点（读屏念「自定义」） */
const CUSTOM_MARK = '<span class="nl-up-dot" aria-hidden="true"></span><span class="nl-sr-only">（自定义）</span>';

/** 删除后选中哪一个：原位置上的下一个（删的是最后一个就选上一个） */
function idAfterDelete(idsBefore, deletedId, idsAfter) {
    if (!idsAfter.length) return '';
    const i = idsBefore.indexOf(deletedId);
    if (i < 0) return idsAfter[0];
    const pos = idsBefore.slice(0, i).filter((id) => idsAfter.includes(id)).length;
    return idsAfter[Math.min(pos, idsAfter.length - 1)];
}

/** 列表里一行 */
function rowHtml(p, selected) {
    const on = p.id === selected;
    return `
        <div class="nl-char-item ${on ? 'active' : ''}" role="option" tabindex="0" aria-selected="${on}" data-up-id="${esc(p.id)}">
            <div class="nl-row"><b class="nl-grow nl-up-row-name">${esc(p.name)}</b>${p.isDefault ? '<span class="nl-tag" title="写卡时默认选这个画像">默认</span>' : ''}</div>
            <div class="nl-small nl-clamp">${esc(userProfileSummary(p, { max: 3, settings: app.settings }))}</div>
        </div>`;
}

/** 分组在界面和读屏里的名字（叙事偏好只有一个「常用」分组） */
function groupLabel(kind, g) {
    return kind === 'style' ? '叙事偏好的常用写法' : g.name;
}

/** 选择画像标签的建议按钮（点一下加上 / 去掉） */
function suggBtnHtml(kind, item, tags, other, otherLabel) {
    const t = item.tag;
    const on = tags.some((x) => sameTag(x, t, kind));
    const inOther = other.some((x) => sameTag(x, t, kind));
    const title = on ? `去掉「${t}」` : inOther ? `「${t}」现在在${otherLabel}里，点一下改到这里` : `添加「${t}」`;
    return `<button type="button" class="nl-seg-btn nl-up-sugg-btn ${on ? 'active' : ''} ${inOther ? 'nl-up-in-other' : ''}" aria-pressed="${on}" data-act="up-tag-toggle" data-kind="${kind}" data-tag="${esc(t)}" title="${esc(item.builtin ? title : `${title}（自定义的${TAG_KINDS[kind].lib}）`)}">${esc(t)}${item.builtin ? '' : CUSTOM_MARK}</button>`;
}

/** 「编辑常用标签」时的标签：带 ×（内置的是隐藏，自定义的是删掉） */
function libChipHtml(kind, g, item) {
    const noun = TAG_KINDS[kind].noun;
    const label = item.builtin ? `隐藏内置${noun}「${item.tag}」（可以恢复默认）` : `从${TAG_KINDS[kind].lib}里删掉「${item.tag}」`;
    return `<span class="nl-up-chip nl-up-libchip"><span class="nl-up-chip-t">${esc(item.tag)}</span>${item.builtin ? '' : CUSTOM_MARK}<button type="button" class="nl-up-chip-x" data-act="up-lib-tag-remove" data-kind="${kind}" data-group="${esc(g.id)}" data-tag="${esc(item.tag)}" title="${item.builtin ? '隐藏（可以恢复默认）' : '删掉'}" aria-label="${esc(label)}">${icon('close', { size: 12 })}</button></span>`;
}

/** 编辑常用标签时分组末尾的操作：恢复默认（内置分组有隐藏的标签时）/ 重命名、删除分组（自定义分组） */
function groupActsHtml(kind, g) {
    const acts = [];
    if (g.builtin && g.hidden.length) {
        acts.push(`<button type="button" class="nl-up-link" data-act="up-lib-restore" data-kind="${kind}" data-group="${esc(g.id)}" aria-label="${esc(`恢复「${groupLabel(kind, g)}」的默认（放回 ${g.hidden.length} 个隐藏的内置${TAG_KINDS[kind].noun}）`)}" title="${esc(`放回隐藏的内置${TAG_KINDS[kind].noun}：${g.hidden.join('、')}（自定义的不受影响）`)}">恢复默认（${g.hidden.length}）</button>`);
    }
    if (!g.builtin) {
        acts.push(`<button type="button" class="nl-up-link" data-act="up-lib-group-rename" data-kind="${kind}" data-group="${esc(g.id)}" aria-label="重命名分组「${esc(g.name)}」" aria-haspopup="dialog">重命名</button>`);
        acts.push(`<button type="button" class="nl-up-link nl-up-link-danger" data-act="up-lib-group-delete" data-kind="${kind}" data-group="${esc(g.id)}" aria-label="删除分组「${esc(g.name)}」" aria-haspopup="dialog">删除分组</button>`);
    }
    return acts.length ? `<span class="nl-up-group-acts">${acts.join('')}</span>` : '';
}

/**
 * 一个建议分组：分组名 + 标签（平时点选，编辑时带 ×）+ 「添加」（点了变成输入框）。
 * 平时「添加」= 存进这个分组 + 选进当前画像；编辑常用标签时只存进分组。note：这个分组上一次添加的提示（跳过了哪些、为什么）
 */
function groupHtml(kind, g, { tags, other, otherLabel, editing, adding, note }) {
    const name = groupLabel(kind, g);
    const noun = TAG_KINDS[kind].noun;
    const isAdding = adding && adding.kind === kind && adding.group === g.id;
    const myNote = note && note.kind === kind && note.group === g.id ? note.msg : '';
    const noteId = `nl-up-libnote-${kind}`;
    const items = g.items.map((i) => (editing ? libChipHtml(kind, g, i) : suggBtnHtml(kind, i, tags, other, otherLabel))).join('');
    const what = editing ? `存进「${name}」` : `存进「${name}」并加到这个画像`;
    const addCtl = isAdding
        ? `<input class="nl-up-lib-input" data-up-lib-input="${esc(g.id)}" data-kind="${kind}" maxlength="${tagInputMax(kind)}" placeholder="${editing ? `存常用${noun}，回车` : `新${noun}，回车添加`}" aria-label="${esc(`新${noun}：${what}（回车或逗号添加，Esc 收起）`)}" ${myNote ? `aria-describedby="${noteId}"` : ''} autocomplete="off">`
        : `<button type="button" class="nl-up-add" data-act="up-lib-add" data-kind="${kind}" data-group="${esc(g.id)}" title="${esc(editing ? `把自己的${noun}存进「${name}」，以后每个画像都能点选` : `把自己的${noun}存进「${name}」（以后每个画像都能点选），同时加到这个画像`)}" aria-label="${esc(editing ? `往「${name}」里添加常用${noun}` : `添加${noun}：存进「${name}」并加到这个画像`)}">${icon('plus', { size: 12 })}${editing ? '添加常用' : '添加'}</button>`;
    const noteHtml = myNote ? `<span class="nl-small nl-warn nl-up-lib-note" id="${noteId}" role="status" data-up-lib-note>${esc(myNote)}</span>` : '';
    return `
        <div class="nl-up-sugg-group" role="group" aria-label="${esc(name)}" data-up-group="${esc(g.id)}">
            <span class="nl-up-sugg-name" ${g.builtin ? '' : 'title="自定义分组"'}>${esc(g.name)}${g.builtin ? '' : CUSTOM_MARK}</span>
            <div class="nl-up-sugg-list">${items}${addCtl}${editing ? groupActsHtml(kind, g) : ''}${noteHtml}</div>
        </div>`;
}

/**
 * 画像里有、常用库里没有的标签（太长、存不进常用库的不算）。
 * 隐藏的内置标签也算常用库里有的（刚隐藏了画像里正在用的标签，不会马上又让你「存进常用标签」）
 */
function unsavedTags(p, kind) {
    const known = new Set(libraryGroups(app.settings, kind).flatMap((g) => [...g.items.map((i) => i.tag), ...g.hidden]).map((t) => tagKey(kind, t)));
    return tagsOf(p, kind).filter((t) => !known.has(tagKey(kind, t)) && t.length <= tagMax(kind));
}

function unsavedHtml(kind, unsaved) {
    const k = TAG_KINDS[kind];
    const few = unsaved.slice(0, 3).map((t) => `「${t}」`).join('');
    const more = unsaved.length > 3 ? ` 等 ${unsaved.length} 个` : '';
    const style = kind === 'style';
    return `<div class="nl-up-unsaved nl-small" data-up-unsaved="${kind}"><span class="nl-muted">${esc(few + more)}不在${k.lib}里</span><button type="button" class="nl-up-link" data-act="up-lib-save-typed" data-kind="${kind}" ${style ? '' : 'aria-haspopup="dialog"'} aria-label="${esc(`把${k.label}里输入的${k.noun}存进${k.lib}${style ? '' : '…'}`)}" title="${style ? '存进叙事偏好的常用写法，以后每个画像都能点选' : '选一个分组存进去，以后每个画像都能点选'}">${style ? '存进常用写法' : '存进常用标签…'}</button></div>`;
}

/** 一类标签（喜欢 / 雷点 / 叙事偏好）的编辑区：已选的标签（可去掉）+ 输入框 + 分组的建议（常用库） */
function tagEditorHtml(p, kind, ui) {
    const k = TAG_KINDS[kind];
    const tags = tagsOf(p, kind);
    const other = kind === 'likes' ? p.dislikes : kind === 'dislikes' ? p.likes : [];
    const otherLabel = kind === 'likes' ? '雷点' : '喜欢';
    const full = isFull(p, kind);
    const editing = ui.editing.has(kind);
    const groups = libraryGroups(app.settings, kind);
    const unsaved = unsavedTags(p, kind);
    const chips = tags.map((t) => `<span class="nl-up-chip"><span class="nl-up-chip-t">${esc(t)}</span><button type="button" class="nl-up-chip-x" data-act="up-tag-remove" data-kind="${kind}" data-tag="${esc(t)}" title="去掉" aria-label="去掉「${esc(t)}」">${icon('close', { size: 12 })}</button></span>`).join('');
    const count = kind === 'style'
        ? `已选 ${tags.length} 项 · 也可以输入自己的写法（每项最多 ${tagMax(kind)} 字，可以一次粘贴多个，用逗号隔开）`
        : `已选 ${tags.length} / ${USER_PROFILE_LIMITS.tags} · 也可以输入任何自定义标签（每个最多 ${USER_PROFILE_LIMITS.tag} 字，可以一次粘贴多个，用逗号隔开）`;
    const fullText = kind === 'style' ? `最多 ${USER_PROFILE_LIMITS.text} 字` : `最多 ${USER_PROFILE_LIMITS.tags} 个`;
    return `
        <div class="nl-field nl-up-tags" data-up-tags="${kind}">
            <label for="nl-up-${kind}-input">${k.label} <span class="nl-muted">（${k.note}）</span></label>
            <div class="nl-up-tagbox" data-up-tagbox="${kind}">
                ${chips}
                <input class="nl-up-tag-input" id="nl-up-${kind}-input" data-up-tag-input="${kind}" maxlength="${tagInputMax(kind)}" placeholder="${full ? fullText : esc(k.placeholder)}" ${full ? 'disabled' : ''} aria-describedby="nl-up-${kind}-count" autocomplete="off">
            </div>
            <div class="nl-up-meta">
                <span class="nl-muted nl-small nl-num nl-grow" id="nl-up-${kind}-count">${count}</span>
                <button type="button" class="nl-up-link" data-act="up-lib-edit" data-kind="${kind}" aria-label="${esc(editing ? `完成编辑${k.label}的${k.lib}` : `编辑${k.label}的${k.lib}`)}" title="${editing ? '回到点选' : `删掉自定义的、隐藏内置的${kind === 'style' ? '' : '、管理分组'}（不影响已经选进画像的）`}">${editing ? '完成编辑' : `编辑${k.lib}`}</button>
            </div>
            ${unsaved.length ? unsavedHtml(kind, unsaved) : ''}
            <div class="nl-up-sugg ${editing ? 'nl-up-editing' : ''}" data-up-sugg="${kind}">
                ${groups.map((g) => groupHtml(kind, g, { tags, other, otherLabel, editing, adding: ui.adding, note: ui.libNote })).join('')}
                ${editing ? `<div class="nl-up-sugg-foot">${kind === 'style' ? '' : `<button type="button" class="nl-btn nl-sm" data-act="up-lib-group-new" data-kind="${kind}" aria-haspopup="dialog">${icon('plus', { size: 14 })}新建分组</button>`}<span class="nl-muted nl-small">${k.lib}所有画像共用；删掉、隐藏都不影响已经选进画像的${k.noun}。</span></div>` : ''}
            </div>
        </div>`;
}

/** 尺度：内置三档 + 自定义尺度（点选）、「自定义尺度」、管理自定义尺度（修改 / 删除） */
function intensityHtml(p, ui) {
    const list = profileIntensities(app.settings);
    const info = profileIntensityInfo(p, app.settings);
    const customs = list.filter((x) => x.custom);
    const manage = ui.intManage && customs.length;
    const seg = list.map((x) => {
        const on = x.value === info.value;
        return `<button type="button" class="nl-seg-btn ${on ? 'active' : ''}" aria-pressed="${on}" data-act="up-intensity" data-val="${esc(x.value)}" title="${esc(x.custom ? `自定义尺度：${x.desc}` : x.hint)}">${esc(x.label)}${x.custom ? CUSTOM_MARK : ''}</button>`;
    }).join('');
    const rows = manage ? `
        <div class="nl-up-int-list" data-up-int-list>
            ${customs.map((x) => `
            <div class="nl-up-int-row">
                <div class="nl-grow"><b>${esc(x.label)}</b><div class="nl-muted nl-small">${esc(x.desc)}</div></div>
                <button type="button" class="nl-btn nl-sm" data-act="up-int-edit" data-val="${esc(x.value)}" aria-label="编辑尺度「${esc(x.label)}」" aria-haspopup="dialog">${icon('edit', { size: 14 })}编辑</button>
                <button type="button" class="nl-icon-btn nl-danger" data-act="up-int-delete" data-val="${esc(x.value)}" title="删除尺度" aria-label="删除尺度「${esc(x.label)}」">${icon('trash')}</button>
            </div>`).join('')}
        </div>` : '';
    return `
        <div class="nl-field" data-up-int>
            <label id="nl-up-int-label">尺度</label>
            <div class="nl-seg" role="group" aria-labelledby="nl-up-int-label">${seg}<button type="button" class="nl-up-add" data-act="up-int-new" aria-haspopup="dialog" title="新建一个自己的尺度：名称 + 写进提示词的说明，所有画像都能选">${icon('plus', { size: 12 })}自定义尺度</button></div>
            <div class="nl-up-meta">
                <span class="nl-muted nl-small nl-grow" data-up-int-hint>${esc(info.hint)}所有涉及恋爱或亲密内容的人物（包括 {{user}}）都是成年人。</span>
                ${customs.length ? `<button type="button" class="nl-up-link" data-act="up-int-manage" aria-expanded="${manage ? 'true' : 'false'}">${manage ? '收起' : `管理自定义尺度（${customs.length}）`}</button>` : ''}
            </div>
            ${info.missing ? `<div class="nl-warn nl-small" data-up-int-missing>${icon('alert', { size: 12 })} 这个画像原来选的自定义尺度已经删掉了，现在按默认的「${esc(info.label)}」写。</div>` : ''}
            ${rows}
        </div>`;
}

/** 文字框下面的「插入常用…」「存为常用」 */
function snippetBarHtml(field, ui) {
    const n = profileSnippets(app.settings, field).length;
    const label = PROFILE_SNIPPET_FIELDS[field];
    const note = ui.snipNote?.field === field ? ui.snipNote.msg : '';
    const noteId = `nl-up-snipnote-${field}`;
    return `<div class="nl-up-snip-bar">
        ${n ? `<button type="button" class="nl-up-link" data-act="up-snip-insert" data-field="${field}" aria-haspopup="dialog" aria-label="${esc(`插入「${label}」的常用文字（${n} 条）`)}" title="插入或替换成存过的常用文字">插入常用…（${n}）</button>` : ''}
        <button type="button" class="nl-up-link" data-act="up-snip-save" data-field="${field}" aria-haspopup="dialog" aria-label="${esc(`把「${label}」的文字存为常用`)}" ${note ? `aria-describedby="${noteId}"` : ''} title="把框里的文字存成常用，以后每个画像都能一键插入">存为常用</button>
        ${note ? `<span class="nl-small nl-warn" id="${noteId}" role="status" data-up-snip-note>${esc(note)}</span>` : ''}
    </div>`;
}

/** 右边的编辑区 */
function detailHtml(p, ui) {
    const orients = listOrientationTemplates(app.settings);
    // 偏好的导向同时又在雷点里（NTR / 后宫 这样两边都有的名字，很容易点错）：标出来并说明
    const conflicts = orientationConflicts(app.settings, p);
    return `
        <div class="nl-card-head nl-wrap">
            <div>
                <h3 data-up-title>${esc(p.name)}</h3>
                <div class="nl-card-desc">改动自动保存。写卡时在「角色卡」页的「用户画像」里选它。每一项都可以添加自己的选项，存进常用库，所有画像都能用。</div>
            </div>
            <div class="nl-row nl-up-acts">
                <button class="nl-btn nl-sm" data-act="up-duplicate">${icon('copy', { size: 14 })}复制</button>
                <button class="nl-btn nl-sm" data-act="up-export">${icon('download', { size: 14 })}导出</button>
                <button class="nl-icon-btn nl-danger" data-act="up-delete" title="删除画像" aria-label="删除用户画像「${esc(p.name)}」">${icon('trash')}</button>
            </div>
        </div>
        <div class="nl-grid2">
            <div class="nl-field"><label for="nl-up-name">名称</label><input class="nl-input" id="nl-up-name" data-up-f="name" maxlength="${USER_PROFILE_LIMITS.name}" value="${esc(p.name)}" aria-describedby="nl-up-err"></div>
            <div class="nl-field nl-up-default"><label class="nl-check-line"><input type="checkbox" data-up-f="isDefault" ${p.isDefault ? 'checked' : ''}><span>设为默认 <span class="nl-muted">（写卡时默认选它）</span></span></label></div>
        </div>
        <div class="nl-small nl-err" id="nl-up-err" data-up-err role="alert" hidden></div>
        <div class="nl-field">
            <label id="nl-up-orient-label">偏好的导向 <span class="nl-muted">（可多选，仅作参考：写卡时「卡的导向」选「不限」会给出快捷按钮，不会替你改）</span></label>
            <div class="nl-seg" role="group" aria-labelledby="nl-up-orient-label" ${conflicts.length ? 'aria-describedby="nl-up-orient-conflict"' : ''}>${orients.map((t) => {
        const on = p.orientations.includes(t.id);
        const bad = isDislikedName(p, t.name);
        const title = bad ? `「${t.name}」也在雷点里：写卡时不会推荐它当导向` : `${t.brief || ''}${t.builtin ? '' : '（我的导向模板）'}`;
        return `<button type="button" class="nl-seg-btn ${on ? 'active' : ''} ${bad ? 'nl-up-in-other' : ''}" aria-pressed="${on}" data-act="up-orient" data-orient-id="${esc(t.id)}" title="${esc(title)}">${esc(t.name)}${t.builtin ? '' : CUSTOM_MARK}</button>`;
    }).join('')}<button type="button" class="nl-up-add" data-act="up-orient-new" aria-haspopup="dialog" title="新建一个自己的导向模板（写卡表单和其他画像也能用）；改过后关掉会自动选上，没改就关掉不会留下">${icon('plus', { size: 12 })}新建导向</button></div>
            ${conflicts.length ? `<div class="nl-warn nl-small" id="nl-up-orient-conflict" data-up-orient-conflict>${icon('alert', { size: 12 })} ${esc(conflicts.map((o) => `「${o.name}」`).join('、'))}同时在雷点里：写卡时不会推荐它当导向；要是写卡时真的选了它当「卡的导向」，那张卡以卡的导向为准，这一项雷点不适用。</div>` : ''}
        </div>
        ${tagEditorHtml(p, 'likes', ui)}
        ${tagEditorHtml(p, 'dislikes', ui)}
        ${intensityHtml(p, ui)}
        <div class="nl-field"><label for="nl-up-persona">{{user}} 的默认形象 <span class="nl-muted">（性别、年龄、外貌、身份……；只在「{{user}} 扮演」选原创新身份时使用）</span></label>
            <textarea class="nl-input nl-textarea" id="nl-up-persona" rows="3" data-up-f="persona" maxlength="${USER_PROFILE_LIMITS.text}" placeholder="例如：二十五岁的男性上班族，个子高、话不多，刚搬进这座城市">${esc(p.persona)}</textarea>
            ${snippetBarHtml('persona', ui)}</div>
        ${tagEditorHtml(p, 'style', ui)}
        <div class="nl-field"><label for="nl-up-notes">其他 <span class="nl-muted">（想让写卡 AI 知道的其他事）</span></label>
            <textarea class="nl-input nl-textarea" id="nl-up-notes" rows="2" data-up-f="notes" maxlength="${USER_PROFILE_LIMITS.text}" placeholder="例如：喜欢有来有回的斗嘴；角色别太快动心">${esc(p.notes)}</textarea>
            ${snippetBarHtml('notes', ui)}</div>
        <div class="nl-field">
            <label class="nl-check-line"><input type="checkbox" data-up-f="chatEntry" ${p.chatEntry ? 'checked' : ''} aria-describedby="nl-up-chat-note"> 聊天时也照顾这些偏好</label>
            <div class="nl-muted nl-small" id="nl-up-chat-note">写卡时在卡自己的世界书里加一条常驻的「用户偏好」条目（喜欢的元素、雷点、尺度和叙事偏好，固定文字，插在聊天深度 4），聊天的 AI 也会照顾你的口味；每次写卡可以单独关掉。</div>
        </div>
        <div class="nl-row"><span class="nl-muted nl-small" data-up-saved>${icon('check', { size: 12 })} 改动自动保存</span><span class="nl-sr-only" role="status" aria-live="polite" data-up-live></span></div>`;
}

/** 重绘后把焦点放回“同一个”元素用的选择器（重绘会换掉所有节点）；认不出时返回 '' */
function selectorFor(node, root) {
    if (!node || !root?.contains(node) || node === root) return '';
    const d = node.dataset || {};
    if (d.upTagInput) return `[data-up-tag-input="${CSS.escape(d.upTagInput)}"]`;
    if (d.upLibInput) return `[data-up-lib-input="${CSS.escape(d.upLibInput)}"][data-kind="${CSS.escape(d.kind || '')}"]`;
    if (d.upF) return `[data-up-f="${CSS.escape(d.upF)}"]`;
    if (d.act) {
        let sel = `[data-act="${CSS.escape(d.act)}"]`;
        for (const [k, attr] of [['kind', 'data-kind'], ['tag', 'data-tag'], ['val', 'data-val'], ['orientId', 'data-orient-id'], ['group', 'data-group'], ['field', 'data-field']]) {
            if (d[k] !== undefined) sel += `[${attr}="${CSS.escape(d[k])}"]`;
        }
        return sel;
    }
    return '';
}

const addSel = (kind, group) => `[data-act="up-lib-add"][data-kind="${kind}"][data-group="${CSS.escape(group)}"]`;
const libInputSel = (kind, group) => `[data-up-lib-input="${CSS.escape(group)}"][data-kind="${kind}"]`;

// ---------------- 对话框 ----------------

/**
 * 带校验的小表单对话框：validate(body) 返回错误文字时提示并留在对话框里；输入框里按回车 = 点主按钮。
 * @returns {Promise<HTMLElement|null>} 确定时返回表单（读里面的值），取消时 null
 */
async function formDialog({ title, html, okLabel = '确定', validate = () => '', onMount = null }) {
    const body = document.createElement('div');
    body.innerHTML = `${html}<div class="nl-small nl-err" data-form-err role="alert" hidden></div>`;
    const showErr = (msg) => {
        const err = body.querySelector('[data-form-err]');
        err.textContent = msg;
        err.hidden = !msg;
    };
    const { value } = await openDialog({
        title,
        body,
        buttons: [{ label: '取消', value: null }, {
            label: okLabel, value: 'ok', primary: true,
            validate: () => {
                const msg = validate(body);
                showErr(msg || '');
                return !msg;
            },
        }],
        onMount: (b) => {
            b.addEventListener('keydown', (e) => {
                // 文字输入框里按回车 = 点主按钮（多行文字框里回车照常换行；输入法选词时的回车不算）
                if (e.key !== 'Enter' || e.isComposing || !e.target.matches?.('input[type="text"], input:not([type])')) return;
                e.preventDefault();
                b.closest('.nl-dialog')?.querySelector('.nl-dialog-foot .nl-primary')?.click();
            });
            // 改了内容：上一次的错误提示不再适用，先收起来（再点确定时重新检查）
            b.addEventListener('input', () => showErr(''));
            b.addEventListener('change', () => showErr(''));
            onMount?.(b);
        },
    });
    return value === 'ok' ? body : null;
}

/** 新建 / 重命名标签分组 */
async function groupDialog({ title, name = '', target = 'likes', exceptId = '', withTarget = true }) {
    const body = await formDialog({
        title,
        okLabel: exceptId ? '保存' : '新建分组',
        html: `
            <div class="nl-field"><label for="nl-up-g-name">分组名称 <span class="nl-muted">（最多 ${LIB.groupName} 字）</span></label><input class="nl-input" type="text" id="nl-up-g-name" data-g-name maxlength="${LIB.groupName}" value="${esc(name)}" placeholder="例如：我的癖好" autocomplete="off"></div>
            ${withTarget ? `<fieldset class="nl-up-fieldset"><legend>用在</legend><div class="nl-row nl-wrap">${Object.entries(PROFILE_TAG_TARGETS).map(([v, l]) => `<label class="nl-check-line"><input type="radio" name="nl-up-g-target" value="${v}" ${v === target ? 'checked' : ''}><span>${esc(l)}</span></label>`).join('')}</div></fieldset>` : ''}`,
        validate: (b) => libraryGroupNameProblem(app.settings, b.querySelector('[data-g-name]').value, exceptId),
    });
    if (!body) return null;
    return { name: body.querySelector('[data-g-name]').value, target: body.querySelector('input[name="nl-up-g-target"]:checked')?.value || target };
}

/** 新建 / 修改自定义尺度：名称 + 说明（说明写进写卡提示词和「用户偏好」条目） */
async function intensityDialog(cur = null) {
    const body = await formDialog({
        title: cur ? `编辑尺度「${cur.label}」` : '新建尺度',
        okLabel: cur ? '保存' : '新建',
        html: `
            <div class="nl-field"><label for="nl-up-i-name">名称 <span class="nl-muted">（最多 ${LIB.intensityName} 字）</span></label><input class="nl-input" type="text" id="nl-up-i-name" data-i-name maxlength="${LIB.intensityName}" value="${esc(cur?.label || '')}" placeholder="例如：纯情慢热" autocomplete="off"></div>
            <div class="nl-field"><label for="nl-up-i-desc">说明 <span class="nl-muted">（写进写卡提示词和「用户偏好」条目，代替内置尺度的说明；最多 ${LIB.intensityDesc} 字）</span></label><textarea class="nl-input nl-textarea" id="nl-up-i-desc" data-i-desc rows="3" maxlength="${LIB.intensityDesc}" placeholder="例如：感情慢慢升温，可以有心动和暧昧的小动作，亲吻点到为止，不写性内容。">${esc(cur?.desc || '')}</textarea></div>
            <div class="nl-muted nl-small">所有涉及恋爱或亲密内容的人物（包括 {{user}}）一律是成年人：这一条写在每个提示词的最后，不受尺度影响。</div>`,
        validate: (b) => intensityNameProblem(app.settings, b.querySelector('[data-i-name]').value, cur?.value || '')
            || (b.querySelector('[data-i-desc]').value.trim() ? '' : '说明不能为空：写清楚这个尺度能写到什么程度'),
    });
    if (!body) return null;
    return { name: body.querySelector('[data-i-name]').value, desc: body.querySelector('[data-i-desc]').value };
}

/** 「存进常用标签…」：选分组（或新建分组）、勾选要存的标签 */
async function saveTypedDialog(kind, tags, groups, last) {
    const def = groups.some((g) => g.id === last) ? last : groups[0]?.id;
    const body = await formDialog({
        title: `存进常用标签 · ${TAG_KINDS[kind].label}`,
        okLabel: '存进常用标签',
        html: `
            <div class="nl-field"><label for="nl-up-s-group">存进哪个分组</label><select class="nl-input" id="nl-up-s-group" data-s-group>${groups.map((g) => `<option value="${esc(g.id)}" ${g.id === def ? 'selected' : ''}>${esc(g.name)}${g.builtin ? '' : '（自定义）'}</option>`).join('')}<option value="__new">新建分组…</option></select></div>
            <div class="nl-field" data-s-new hidden><label for="nl-up-s-name">新分组的名称 <span class="nl-muted">（最多 ${LIB.groupName} 字）</span></label><input class="nl-input" type="text" id="nl-up-s-name" data-s-name maxlength="${LIB.groupName}" placeholder="例如：我的癖好" autocomplete="off"></div>
            <fieldset class="nl-up-fieldset"><legend>要存的标签</legend><div class="nl-row nl-wrap">${tags.map((t) => `<label class="nl-check-line"><input type="checkbox" data-s-tag value="${esc(t)}" checked><span>${esc(t)}</span></label>`).join('')}</div></fieldset>
            <div class="nl-muted nl-small">存进去之后，每个画像都能在这个分组里点选它们。</div>`,
        validate: (b) => {
            if (!b.querySelectorAll('[data-s-tag]:checked').length) return '至少勾选一个标签';
            if (b.querySelector('[data-s-group]').value === '__new') return libraryGroupNameProblem(app.settings, b.querySelector('[data-s-name]').value);
            return '';
        },
        onMount: (b) => {
            b.querySelector('[data-s-group]').addEventListener('change', (e) => {
                const box = b.querySelector('[data-s-new]');
                box.hidden = e.target.value !== '__new';
                if (!box.hidden) b.querySelector('[data-s-name]').focus();
            });
        },
    });
    if (!body) return null;
    return {
        group: body.querySelector('[data-s-group]').value,
        name: body.querySelector('[data-s-name]').value,
        tags: [...body.querySelectorAll('[data-s-tag]:checked')].map((x) => x.value),
    };
}

/**
 * 「插入常用…」：列出这一种文字的常用文字，插入（接在后面）/ 替换 / 删除。
 * @returns {Promise<{mode: 'insert'|'replace', text: string, name: string}|null>}
 */
async function snippetsDialog(field) {
    const box = document.createElement('div');
    const renderList = () => {
        const list = profileSnippets(app.settings, field);
        box.innerHTML = list.length
            ? `<div class="nl-muted nl-small">「插入」接在现有文字后面，「替换」换掉现有文字。常用文字所有画像共用。</div>
               <div class="nl-up-snip-list" role="list">${list.map((s) => `
                <div class="nl-up-snip-row" role="listitem" data-snip-id="${esc(s.id)}">
                    <div class="nl-grow nl-up-snip-text"><b>${esc(s.name)}</b><div class="nl-muted nl-small nl-clamp">${esc(s.text)}</div></div>
                    <div class="nl-row nl-up-snip-acts">
                        <button type="button" class="nl-btn nl-sm" data-snip-act="insert" data-snip-id="${esc(s.id)}" aria-label="插入「${esc(s.name)}」">插入</button>
                        <button type="button" class="nl-btn nl-sm" data-snip-act="replace" data-snip-id="${esc(s.id)}" aria-label="用「${esc(s.name)}」替换现有文字">替换</button>
                        <button type="button" class="nl-icon-btn nl-danger" data-snip-act="delete" data-snip-id="${esc(s.id)}" title="删除这段常用文字" aria-label="删除常用文字「${esc(s.name)}」">${icon('trash')}</button>
                    </div>
                </div>`).join('')}</div>`
            : emptyState('在文字框下面点「存为常用」，就能把写好的文字存起来，以后一键插入。', '', { title: '还没有常用文字', ico: 'file' });
    };
    renderList();
    const { value } = await openDialog({
        title: `常用文字 · ${PROFILE_SNIPPET_FIELDS[field]}`,
        body: box,
        buttons: [{ label: '关闭', value: null }],
        onMount: (b, close) => {
            // 打开后焦点放在第一段的「插入」上（对话框默认聚焦底部的按钮）
            setTimeout(() => box.querySelector('[data-snip-act="insert"]')?.focus(), 0);
            b.addEventListener('click', async (e) => {
                const btn = e.target.closest('[data-snip-act]');
                if (!btn) return;
                const list = profileSnippets(app.settings, field);
                const s = list.find((x) => x.id === btn.dataset.snipId);
                if (!s) return;
                if (btn.dataset.snipAct !== 'delete') {
                    close({ mode: btn.dataset.snipAct, text: s.text, name: s.name });
                    return;
                }
                if (!(await confirmDialog(`删除常用文字「${s.name}」？已经填进画像里的文字不受影响。`, { danger: true, okLabel: '删除' }))) return;
                const i = list.indexOf(s);
                removeProfileSnippet(app.settings, s.id);
                app.saveSettings();
                app.log(`已删除常用文字「${s.name}」`, 'success');
                renderList();
                const rest = profileSnippets(app.settings, field);
                const next = rest[Math.min(i, rest.length - 1)];
                (next ? box.querySelector(`[data-snip-act="insert"][data-snip-id="${CSS.escape(next.id)}"]`) : b.closest('.nl-dialog')?.querySelector('.nl-dialog-foot button'))?.focus();
            });
        },
    });
    return value || null;
}

/** 导出画像前问一下要不要连同常用库一起导出（常用库里没有自己加的东西时不问） */
async function askExportOptions() {
    const c = profileLibraryCounts(app.settings);
    if (!c.total) return { library: false };
    const parts = [
        c.tags ? `标签 ${c.tags} 个` : '', c.groups ? `分组 ${c.groups} 个` : '', c.intensities ? `尺度 ${c.intensities} 个` : '',
        c.styleTags ? `叙事偏好 ${c.styleTags} 个` : '', c.snippets ? `常用文字 ${c.snippets} 段` : '',
    ].filter(Boolean).join('、');
    const body = await formDialog({
        title: '导出用户画像',
        okLabel: '导出',
        html: `
            <label class="nl-check-line"><input type="checkbox" data-exp-lib checked><span>连同常用库一起导出 <span class="nl-muted">（你加的${esc(parts)}）</span></span></label>
            <div class="nl-muted nl-small">导入时常用库会合并进对方的常用库（不重复，也不会替对方隐藏内置标签）。画像用到的自定义尺度不管勾不勾都会带上。</div>`,
    });
    if (!body) return null;
    return { library: body.querySelector('[data-exp-lib]').checked };
}

/**
 * 画像列表 + 编辑区（「用户画像」页与「管理用户画像」对话框共用）。改动自动保存进扩展设置。
 * @param {HTMLElement} el 容器
 * @param {{select?: string, setActions?: Function|null}} opt
 *   select：先选中哪个画像（不给时选上次的）；setActions：页面标题栏放「新建 / 导入 / 导出全部」（页面用），
 *   不给时这几个按钮放在容器顶部（对话框用）
 * @returns {{destroy: () => void, selected: () => string}}
 */
export function mountProfilesEditor(el, { select = '', setActions = null } = {}) {
    let selected = select || lastSelected || '';
    const inPage = typeof setActions === 'function';
    /**
     * 编辑区的界面状态（常用库是所有画像共用的，换画像时保留）：editing 哪几类在「编辑常用标签」；adding 哪个分组的「添加」输入框开着；
     * intManage 自定义尺度的管理列表是否展开；lastSaveGroup「存进常用标签」上次选的分组；
     * libNote 往分组里存常用标签时的提示 {kind, group, msg}（跳过了哪些、为什么），显示在那个分组旁边，下一次输入或 Esc 时收起；
     * snipNote「存为常用」存不进去的原因 {field, msg}，显示在按钮旁边，改了框里的文字就收起
     */
    const ui = { editing: new Set(), adding: null, intManage: false, lastSaveGroup: {}, libNote: null, snipNote: null };

    const profiles = () => listUserProfiles(app.settings);
    const current = () => getUserProfile(app.settings, selected);
    /** 重绘计数：延后的重绘发现期间已经重绘过（比如点了尺度按钮）就不再重绘 */
    let renders = 0;
    /** 正在换掉编辑区的节点：这期间的 focusout（被移走的输入框）不算用户离开 */
    let rendering = false;

    const actionsHtml = (n, sm = '') => `
        <button class="nl-btn${sm}" data-act="up-new">${icon('plus', sm ? { size: 14 } : {})}新建画像</button>
        <button class="nl-btn${sm}" data-act="up-import">${icon('upload', sm ? { size: 14 } : {})}导入 JSON</button>
        <button class="nl-btn${sm}" data-act="up-export-all" ${n ? '' : 'disabled'} title="把全部画像导出成一个 JSON 文件">${icon('download', sm ? { size: 14 } : {})}导出全部</button>`;

    const headerActions = () => {
        if (inPage) setActions(actionsHtml(profiles().length), onClick);
    };

    const renderList = () => {
        const box = el.querySelector('[data-up-list]');
        if (!box) return;
        const f = document.activeElement;
        const focusId = f && box.contains(f) ? f.closest('[data-up-id]')?.dataset.upId : '';
        box.innerHTML = profiles().map((p) => rowHtml(p, selected)).join('');
        if (focusId) box.querySelector(`[data-up-id="${CSS.escape(focusId)}"]`)?.focus({ preventScroll: true });
    };

    const render = () => {
        renders++;
        const list = profiles();
        if (!list.some((p) => p.id === selected)) selected = list[0]?.id || '';
        lastSelected = selected;
        rendering = true;
        if (!list.length) {
            el.innerHTML = `<section class="nl-card">${emptyState('把你的口味存成画像：喜欢的元素、雷点、尺度和叙事偏好。写卡时选上它，AI 会把这些偏好化进角色的外貌、服饰、性格和开场白里。不需要先导入小说。', `<div class="nl-row nl-wrap" style="justify-content:center"><button class="nl-btn nl-primary" data-act="up-new">${icon('plus')}新建画像</button><button class="nl-btn" data-act="up-import">${icon('upload')}导入 JSON</button></div>`, { title: '还没有用户画像', ico: 'profile' })}</section>`;
        } else {
            const p = current();
            // 对话框里没有页面标题栏：新建 / 导入 / 导出全部放在顶部
            const tools = inPage ? '' : `<div class="nl-row nl-wrap nl-up-tools"><span class="nl-muted nl-small nl-grow">画像存在扩展设置里，所有项目共用；改动自动保存。</span>${actionsHtml(list.length, ' nl-sm')}</div>`;
            el.innerHTML = `${tools}
                <div class="nl-split">
                    <div class="nl-card nl-char-list" role="listbox" aria-label="用户画像" data-up-list></div>
                    <div class="nl-card nl-up-detail" data-up-detail>${p ? detailHtml(p, ui) : ''}</div>
                </div>`;
            renderList();
        }
        rendering = false;
        if (el.isConnected) headerActions();
    };

    /**
     * 只重绘右边的编辑区；focusSel：重绘后把焦点放回去的元素（可以给几个选择器，用第一个找得到、没停用的）；
     * scroll：焦点元素不在视野里时滚过去（新建的分组可能在另一类里）。
     * 标签输入框和「添加」输入框里还没确认（没按回车）的文字跟着保留下来，不会因为点了别的按钮就没了。
     */
    const renderDetail = (focusSel = '', { scroll = false } = {}) => {
        const box = el.querySelector('[data-up-detail]');
        const p = current();
        if (!box || !p) return render();
        renders++;
        const drafts = Object.fromEntries([...box.querySelectorAll('[data-up-tag-input]')].map((i) => [i.dataset.upTagInput, i.value]));
        const libDraft = box.querySelector('[data-up-lib-input]');
        const libVal = libDraft?.value ? { sel: libInputSel(libDraft.dataset.kind, libDraft.dataset.upLibInput), value: libDraft.value } : null;
        const scroller = el.closest('.nl-main, .nl-dialog-body');
        const top = scroller?.scrollTop;
        rendering = true;
        box.innerHTML = detailHtml(p, ui);
        rendering = false;
        for (const [kind, v] of Object.entries(drafts)) {
            const inp = v ? box.querySelector(`[data-up-tag-input="${kind}"]`) : null;
            if (inp && !inp.disabled) inp.value = v;
        }
        if (libVal) {
            const inp = box.querySelector(libVal.sel);
            if (inp) inp.value = libVal.value;
        }
        if (scroller && top !== undefined) scroller.scrollTop = top;
        for (const sel of (Array.isArray(focusSel) ? focusSel : [focusSel]).filter(Boolean)) {
            const t = box.querySelector(sel);
            if (!t || t.disabled) continue;
            t.focus({ preventScroll: true });
            if (scroll) t.scrollIntoView?.({ block: 'nearest' });
            break;
        }
        // 新出现的提示（存不进常用库的原因）：读屏播报一次（提示本身是重绘时新插进来的，不一定会被念出来）
        for (const n of [ui.libNote, ui.snipNote]) {
            if (!n || n.said) continue;
            n.said = true;
            setTimeout(() => {
                const live = el.querySelector('[data-up-live]');
                if (live) live.textContent = n.msg;
            }, 50);
        }
        return undefined;
    };

    const showErr = (msg) => {
        const err = el.querySelector('[data-up-err]');
        if (!err) return;
        err.textContent = msg;
        err.hidden = !msg;
    };

    let savedTimer = 0;
    let liveTimer = 0;
    /**
     * 「已自动保存」：看得见的文字马上换（2 秒后换回「改动自动保存」）；读屏只在停手 1 秒后播报一次，
     * 不会每打一个字就念一遍，也不念换回去的那一下。
     */
    const flashSaved = () => {
        const s = el.querySelector('[data-up-saved]');
        if (!s) return;
        if (!s.textContent.includes('已自动保存')) s.innerHTML = `${icon('check', { size: 12 })} 已自动保存`;
        clearTimeout(savedTimer);
        savedTimer = setTimeout(() => {
            if (s.isConnected) s.innerHTML = `${icon('check', { size: 12 })} 改动自动保存`;
        }, 2000);
        clearTimeout(liveTimer);
        liveTimer = setTimeout(() => {
            const live = el.querySelector('[data-up-live]');
            if (!live) return;
            live.textContent = '已自动保存';
            // 过一会儿清空：下一次保存还能再播报
            liveTimer = setTimeout(() => {
                if (live.isConnected) live.textContent = '';
            }, 3000);
        }, 1000);
    };

    /**
     * 保存一处修改：写进设置、刷新列表与侧栏数字（名称有问题时抛错，由调用方提示）。
     * list=false：先不重绘左边的列表（按下鼠标的那一刻重绘会换掉正要点的那一行，见 commitOnLeave）
     */
    const save = (patch, { list = true } = {}) => {
        const p = current();
        if (!p) return null;
        const next = updateUserProfile(app.settings, p.id, patch);
        app.saveSettings();
        app.events.emit('nav');
        if (list) renderList();
        flashSaved();
        return next;
    };

    /** 常用库改了：保存设置（自动保存，和画像的改动一样） */
    const saveLib = ({ list = false } = {}) => {
        app.saveSettings();
        if (list) renderList();
        flashSaved();
    };

    /**
     * 常用库加标签的结果：写进日志，并返回要显示在分组旁边的提示（恢复到别的分组里的内置标签、跳过的和原因；没有时 ''）。
     * 日志条在对话框里被挡住，只靠日志的话「添加」没反应时用户看不到原因
     */
    const reportLib = (res, name, kind, group) => {
        const notes = [];
        if (res.added.length) app.log(`已存进「${name}」：${res.added.join('、')}`, 'success');
        if (res.restored.length) {
            app.log(`已恢复内置${TAG_KINDS[kind].noun}：${res.restored.join('、')}`, 'success');
            for (const t of res.restored) {
                const where = libraryGroupOfTag(app.settings, kind, t);
                if (where && where.id !== group) notes.push(`「${t}」是「${groupLabel(kind, where)}」里隐藏的内置${TAG_KINDS[kind].noun}，已经在那里恢复显示`);
            }
        }
        if (res.skipped.length) {
            const msg = res.skipped.map((s) => `「${s.tag}」${s.reason}`).join('；');
            app.log(msg, 'warn');
            notes.push(msg);
        }
        return notes.join('；');
    };

    const groupOf = (kind, id) => libraryGroups(app.settings, kind).find((g) => g.id === id) || null;

    /**
     * 「添加」输入框里的文字存进分组（只存数据，不重绘）。select：不在「编辑常用标签」时，存进去（或恢复显示）的同时选进当前画像
     * （已经选了的、在另一类里的不动，免得悄悄从雷点挪到喜欢）。跳过的标签和原因记在 ui.libNote，显示在分组旁边。
     * @returns {string} 没存进去的标签（用「、」连起来，留在输入框里改）；输入框是空的时 ''
     */
    const addLibTyped = (kind, group, raw, { select = true, list = true } = {}) => {
        const pieces = splitPieces(raw);
        ui.libNote = null;
        if (!pieces.length) return '';
        const notes = [];
        if (pieces.some((x) => x.length > tagMax(kind))) {
            const msg = `每个${TAG_KINDS[kind].noun}最多 ${tagMax(kind)} 字，超出的部分已截掉`;
            app.log(msg, 'warn');
            notes.push(msg);
        }
        const g = groupOf(kind, group);
        const name = g ? groupLabel(kind, g) : TAG_KINDS[kind].lib;
        const res = addLibraryTags(app.settings, group, raw);
        const note = reportLib(res, name, kind, group);
        if (note) notes.push(note);
        if (res.added.length || res.restored.length) saveLib();
        const p = current();
        if (select && p && !ui.editing.has(kind)) {
            const have = tagsOf(p, kind);
            const other = kind === 'likes' ? p.dislikes : kind === 'dislikes' ? p.likes : [];
            const fresh = [...res.added, ...res.restored].filter((t) => !have.some((x) => sameTag(x, t, kind)));
            const inOther = fresh.filter((t) => other.some((x) => sameTag(x, t, kind)));
            const picked = fresh.filter((t) => !inOther.includes(t));
            if (picked.length) {
                saveTags(kind, [...have, ...picked], { list });
                app.log(`已加到画像「${p.name}」：${picked.join('、')}`, 'success');
            }
            if (inOther.length) notes.push(`${inOther.map((t) => `「${t}」`).join('')}在这个画像的${kind === 'likes' ? '雷点' : '喜欢'}里，只存进了常用标签（要改过来就点一下它）`);
        }
        if (notes.length) ui.libNote = { kind, group, msg: notes.join('；') };
        return res.skipped.map((s) => s.tag).join('、');
    };

    /** 文字 / 勾选框的改动：名称为空或重名时名称不保存（其他照样保存）并提示 */
    const onFieldEdit = (e) => {
        const f = e.target.closest('[data-up-f]');
        if (!f) return;
        const p = current();
        if (!p) return;
        const k = f.dataset.upF;
        if (k === 'name') {
            const problem = userProfileNameProblem(app.settings, f.value, p.id);
            showErr(problem ? `${problem}，名称暂时没有保存` : '');
            if (problem) return;
            save({ name: f.value });
            const title = el.querySelector('[data-up-title]');
            if (title) title.textContent = f.value.trim();
            return;
        }
        const val = f.type === 'checkbox' ? f.checked : f.value;
        if (ui.snipNote?.field === k) {
            // 改了文字：「存为常用」上一次存不进去的原因不再适用（不重绘，光标不动）
            ui.snipNote = null;
            el.querySelector('[data-up-snip-note]')?.remove();
            el.querySelector(`[data-act="up-snip-save"][data-field="${k}"]`)?.removeAttribute('aria-describedby');
        }
        try {
            save({ [k]: val });
        } catch (err) {
            showErr(err?.message || String(err));
        }
    };

    /** 改标签的数据（不重绘编辑区）：加 / 去掉；加到一类时从另一类里去掉（同一个标签不会既喜欢又是雷点）；叙事偏好存成一段文字 */
    const saveTags = (kind, tags, opt = {}) => {
        const p = current();
        if (!p) return;
        if (kind === 'style') {
            const list = styleTags(tags);
            let kept = list;
            const joined = (arr) => arr.map((t) => trimEndPunct(t)).filter(Boolean).join('、');
            while (kept.length && joined(kept).length > USER_PROFILE_LIMITS.text) kept = kept.slice(0, -1);
            if (kept.length < list.length) app.log(`叙事偏好最多 ${USER_PROFILE_LIMITS.text} 字，多出来的没有加上`, 'warn');
            save({ style: joinStyleTags(kept) }, opt);
            return;
        }
        const otherKind = kind === 'likes' ? 'dislikes' : 'likes';
        const next = normalizeProfileTags(tags);
        const keys = new Set(next.map(libKey));
        const patch = { [kind]: next, [otherKind]: p[otherKind].filter((t) => !keys.has(libKey(t))) };
        if (tags.length > USER_PROFILE_LIMITS.tags && next.length >= USER_PROFILE_LIMITS.tags) app.log(`每类最多 ${USER_PROFILE_LIMITS.tags} 个标签，多出来的没有加上`, 'warn');
        save(patch, opt);
    };

    const setTags = (kind, tags, focusSel = '') => {
        if (!current()) return;
        saveTags(kind, tags);
        renderDetail(focusSel);
    };

    /** 输入框里的文字 → 标签（可以是逗号隔开的一串）；超长的截短并提示。清空输入框，返回要加的标签 */
    const takeTyped = (input) => {
        const kind = input.dataset.upTagInput;
        const raw = input.value;
        input.value = '';
        if (splitPieces(raw).some((x) => x.length > tagMax(kind))) {
            app.log(kind === 'style' ? `叙事偏好每项最多 ${tagMax(kind)} 字，超出的部分已截掉` : `每个标签最多 ${USER_PROFILE_LIMITS.tag} 字，超出的部分已截掉`, 'warn');
        }
        return cleanTyped(kind, raw);
    };

    const addTyped = (input) => {
        const kind = input.dataset.upTagInput;
        const p = current();
        if (!p) return;
        const typed = takeTyped(input);
        if (!typed.length) return;
        setTags(kind, [...tagsOf(p, kind), ...typed], `[data-up-tag-input="${kind}"]`);
    };

    // 输入框失去焦点（点了别处、按 Tab）时把没确认的文字也加进去。先只存数据、马上清空输入框；
    // 重绘等鼠标松开（点击完成）之后再做——在按下鼠标的那一刻就重绘，会换掉正要点的按钮，这一下点击就丢了
    let pointerDown = false;
    let pendingRender = null;
    const onPointerDown = () => {
        pointerDown = true;
    };
    const onPointerUp = () => {
        pointerDown = false;
        if (!pendingRender) return;
        const run = pendingRender;
        pendingRender = null;
        // click 在 pointerup 之后同一轮派发：等它处理完再重绘
        setTimeout(run, 0);
    };
    /** 延后的重绘：鼠标按着时等松开（点击完成）后再做，键盘（Tab）时等焦点落到下一个元素上 */
    const deferRender = (run) => {
        if (pointerDown) {
            pendingRender = run;
            // 万一没收到松开（在窗口外松开鼠标）：过一会儿照样重绘
            setTimeout(() => {
                if (pendingRender !== run) return;
                pendingRender = null;
                run();
            }, 2000);
        } else {
            setTimeout(run, 0);
        }
    };
    /** 页面已经切走就不管；期间已经重绘过编辑区（点了尺度、标签等会重绘的按钮）：新内容已经显示，只刷新列表 */
    const rerenderAfter = (before, { list = true } = {}) => () => {
        if (!el.isConnected) return;
        if (list) renderList();
        if (renders === before) renderDetail(selectorFor(document.activeElement, el));
    };
    const commitOnLeave = (input) => {
        const kind = input.dataset.upTagInput;
        const p = current();
        if (!p || !input.value.trim()) return;
        const typed = takeTyped(input);
        if (!typed.length) return;
        // 列表也等到点击完成后再重绘（点的可能正是左边另一个画像）
        saveTags(kind, [...tagsOf(p, kind), ...typed], { list: false });
        deferRender(rerenderAfter(renders));
    };

    /** 「添加」输入框失去焦点：里面的文字存进分组，收起输入框（窗口本身失去焦点时不算，回来时焦点还在输入框里） */
    const onFocusOut = (e) => {
        if (rendering) return;
        const input = e.target.closest?.('[data-up-lib-input]');
        if (!input || !el.contains(input) || !document.hasFocus()) return;
        const kind = input.dataset.kind;
        const group = input.dataset.upLibInput;
        const raw = input.value;
        if (!raw.trim()) {
            // 空的输入框：直接收起（上一次的提示留着，直到下一次输入）
            if (ui.adding?.kind === kind && ui.adding.group === group) ui.adding = null;
            deferRender(rerenderAfter(renders, { list: false }));
            return;
        }
        // 列表也等到点击完成后再重绘（点的可能正是左边另一个画像；这时选进去的仍是原来那个画像）
        const rest = addLibTyped(kind, group, raw, { list: false });
        input.value = rest;
        // 有没存进去的（重复、满了）：输入框留着，里面是没存进去的那几个，旁边是原因；否则收起
        if (!rest && ui.adding?.kind === kind && ui.adding.group === group) ui.adding = null;
        deferRender(rerenderAfter(renders));
    };

    const selectId = (id, focusSel = '') => {
        selected = id;
        lastSelected = id;
        // 上一个画像那里的提示不带过来
        ui.snipNote = null;
        ui.libNote = null;
        render();
        const target = focusSel ? el.querySelector(focusSel) : (id ? el.querySelector(`[data-up-id="${CSS.escape(id)}"]`) : null);
        // 删掉了最后一个画像：焦点放到空状态的「新建画像」上，不掉到页面最外层
        (target || (!profiles().length ? el.querySelector('[data-act="up-new"]') : null))?.focus({ preventScroll: true });
    };

    /** 导出：常用库里有自己加的东西时先问要不要一起导出 */
    const exportProfiles = async (list) => {
        const opt = await askExportOptions();
        if (!opt) return;
        downloadFile(JSON.stringify(exportUserProfiles(app.settings, list, opt), null, 2), userProfileFileName(list));
    };

    /** 常用库的操作（data-act 以 up-lib- / up-int- / up-snip- / up-orient-new 开头）；返回 true = 认识这个操作 */
    async function onLibraryAction(btn, p) {
        const { kind, group } = btn.dataset;
        switch (btn.dataset.act) {
            case 'up-lib-edit':
                if (ui.editing.has(kind)) ui.editing.delete(kind);
                else ui.editing.add(kind);
                renderDetail(`[data-act="up-lib-edit"][data-kind="${kind}"]`);
                return true;
            case 'up-lib-add':
                ui.adding = { kind, group };
                renderDetail(libInputSel(kind, group));
                return true;
            case 'up-lib-tag-remove': {
                const { tag } = btn.dataset;
                // 删掉后焦点放到同一分组里的下一个（没有就上一个，都没有就放到「添加」上）
                const siblings = [...(btn.closest('.nl-up-sugg-list')?.querySelectorAll('[data-act="up-lib-tag-remove"]') || [])];
                const i = siblings.indexOf(btn);
                const next = siblings[i + 1] || siblings[i - 1] || null;
                const r = removeLibraryTag(app.settings, group, tag);
                if (!r) return true;
                saveLib();
                const noun = TAG_KINDS[kind].noun;
                app.log(r === 'hidden' ? `已隐藏内置${noun}「${tag}」（可以在这个分组里「恢复默认」）` : `已从${TAG_KINDS[kind].lib}里删掉「${tag}」`, 'success');
                renderDetail([next ? selectorFor(next, el) : '', addSel(kind, group)]);
                return true;
            }
            case 'up-lib-restore': {
                const n = restoreLibraryTags(app.settings, group);
                if (n) {
                    saveLib();
                    app.log(`已恢复「${groupLabel(kind, groupOf(kind, group) || { name: '' })}」里隐藏的 ${n} 个内置${TAG_KINDS[kind].noun}`, 'success');
                }
                renderDetail(addSel(kind, group));
                return true;
            }
            case 'up-lib-group-new': {
                const r = await groupDialog({ title: '新建分组', target: kind });
                if (!r) return true;
                const g = addLibraryGroup(app.settings, r);
                saveLib();
                app.log(`已新建分组「${g.name}」（用在${PROFILE_TAG_TARGETS[g.target]}），可以往里面添加常用标签了`, 'success');
                // 还在管理常用标签：新分组所在的那一类也进入「编辑常用标签」（接着输入的只存进分组，不选进画像；改名、删除就在旁边）
                ui.editing.add(g.target);
                ui.adding = { kind: g.target, group: g.id };
                renderDetail(libInputSel(g.target, g.id), { scroll: true });
                return true;
            }
            case 'up-lib-group-rename': {
                const g = groupOf(kind, group);
                if (!g) return true;
                const r = await groupDialog({ title: `重命名分组「${g.name}」`, name: g.name, exceptId: g.id, withTarget: false });
                if (!r) return true;
                renameLibraryGroup(app.settings, g.id, r.name);
                saveLib();
                app.log(`分组「${g.name}」改名为「${r.name.trim()}」`, 'success');
                renderDetail(`[data-act="up-lib-group-rename"][data-kind="${kind}"][data-group="${CSS.escape(g.id)}"]`);
                return true;
            }
            case 'up-lib-group-delete': {
                const g = groupOf(kind, group);
                if (!g) return true;
                if (!(await confirmDialog(`删除分组「${g.name}」${g.items.length ? `和里面的 ${g.items.length} 个常用标签` : ''}？已经加到画像里的标签不受影响。`, { danger: true, okLabel: '删除' }))) return true;
                const ids = libraryGroups(app.settings, kind).map((x) => x.id);
                removeLibraryGroup(app.settings, g.id);
                if (ui.adding?.group === g.id) ui.adding = null;
                saveLib();
                app.log(`已删除分组「${g.name}」`, 'success');
                const rest = libraryGroups(app.settings, kind);
                const next = rest[Math.min(ids.indexOf(g.id), rest.length - 1)];
                renderDetail([next ? addSel(kind, next.id) : '', `[data-act="up-lib-group-new"][data-kind="${kind}"]`]);
                return true;
            }
            case 'up-lib-save-typed': {
                if (!p) return true;
                const tags = unsavedTags(p, kind);
                if (!tags.length) return true;
                const focus = [`[data-up-tag-input="${kind}"]`, `[data-act="up-lib-edit"][data-kind="${kind}"]`];
                /** 存完：跳过的（重复、满了）显示在那个分组旁边 */
                const done = (res, gid, name) => {
                    const note = reportLib(res, name, kind, gid);
                    ui.libNote = note ? { kind, group: gid, msg: note } : null;
                    saveLib();
                    renderDetail(focus);
                };
                if (kind === 'style') {
                    done(addLibraryTags(app.settings, STYLE_GROUP_ID, tags), STYLE_GROUP_ID, '叙事偏好的常用写法');
                    return true;
                }
                const r = await saveTypedDialog(kind, tags, libraryGroups(app.settings, kind), ui.lastSaveGroup[kind]);
                if (!r) return true;
                let gid = r.group;
                if (gid === '__new') {
                    const g = addLibraryGroup(app.settings, { name: r.name, target: kind });
                    app.log(`已新建分组「${g.name}」`, 'success');
                    gid = g.id;
                }
                ui.lastSaveGroup[kind] = gid;
                done(addLibraryTags(app.settings, gid, r.tags), gid, groupOf(kind, gid)?.name || '');
                return true;
            }
            case 'up-int-new': {
                if (!p) return true;
                const r = await intensityDialog();
                if (!r) return true;
                const x = addCustomIntensity(app.settings, r);
                // 新建的尺度直接用在这个画像上（点一下内置的就能换回去）
                save({ intensity: x.id });
                app.log(`已新建尺度「${x.name}」，这个画像改用它`, 'success');
                renderDetail(`[data-act="up-intensity"][data-val="${CSS.escape(x.id)}"]`);
                return true;
            }
            case 'up-int-manage':
                ui.intManage = !ui.intManage;
                renderDetail('[data-act="up-int-manage"]');
                return true;
            case 'up-int-edit': {
                const cur = profileIntensities(app.settings).find((x) => x.custom && x.value === btn.dataset.val);
                if (!cur) return true;
                const r = await intensityDialog(cur);
                if (!r) return true;
                updateCustomIntensity(app.settings, cur.value, r);
                saveLib({ list: true });
                app.log(`尺度「${r.name.trim()}」已保存（已经生成的卡上存的是当时的说明，不受影响）`, 'success');
                renderDetail(`[data-act="up-int-edit"][data-val="${CSS.escape(cur.value)}"]`);
                return true;
            }
            case 'up-int-delete': {
                const customs = profileIntensities(app.settings).filter((x) => x.custom);
                const cur = customs.find((x) => x.value === btn.dataset.val);
                if (!cur) return true;
                const n = intensityUsage(app.settings, cur.value);
                const def = intensityInfo(USER_PROFILE_DEFAULT_INTENSITY).label;
                if (!(await confirmDialog(`删除尺度「${cur.label}」？${n ? `有 ${n} 个画像正在用它，删除后改回默认的「${def}」。` : ''}已经生成的角色卡不受影响（卡上存的是当时的名称和说明）。`, { danger: true, okLabel: '删除' }))) return true;
                const i = customs.indexOf(cur);
                const r = removeCustomIntensity(app.settings, cur.value);
                app.events.emit('nav');
                saveLib({ list: true });
                app.log(`已删除尺度「${cur.label}」${r.profiles ? `，${r.profiles} 个画像改回了默认的「${def}」` : ''}`, 'success');
                const rest = profileIntensities(app.settings).filter((x) => x.custom);
                if (!rest.length) ui.intManage = false;
                const next = rest[Math.min(i, rest.length - 1)];
                renderDetail([next ? `[data-act="up-int-edit"][data-val="${CSS.escape(next.value)}"]` : '', '[data-act="up-int-new"]']);
                return true;
            }
            case 'up-snip-save': {
                const field = btn.dataset.field;
                const ta = el.querySelector(`[data-up-f="${field}"]`);
                const text = (ta?.value ?? p?.[field] ?? '').trim();
                if (!text) {
                    app.log(`「${PROFILE_SNIPPET_FIELDS[field]}」是空的：先写点内容再存为常用`, 'warn');
                    ta?.focus();
                    return true;
                }
                // 先检查存不存得进去（一样的已经存过、满了），免得起好名字才告诉你存不了；原因显示在按钮旁边（对话框里看不到日志条）
                const mine = profileSnippets(app.settings, field);
                const same = mine.find((s) => s.text === text.replace(/\r\n?/g, '\n').slice(0, LIB.snippetText));
                const problem = same ? `一样的内容已经存过了（「${same.name}」），在「插入常用…」里就能找到`
                    : mine.length >= LIB.snippets ? `每一种最多存 ${LIB.snippets} 段常用文字，先在「插入常用…」里删掉几段` : '';
                if (problem) {
                    app.log(problem, 'warn');
                    ui.snipNote = { field, msg: problem };
                    renderDetail(`[data-act="up-snip-save"][data-field="${field}"]`);
                    return true;
                }
                const name = await promptDialog('给这段文字起个名字（以后在「插入常用…」里按名字找）', snippetDefaultName(text), { title: '存为常用', maxlength: LIB.snippetName });
                if (name === null) return true;
                try {
                    const s = addProfileSnippet(app.settings, field, { name, text });
                    ui.snipNote = null;
                    saveLib();
                    app.log(`已存为常用文字「${s.name}」`, 'success');
                } catch (err) {
                    app.log(err?.message || String(err), 'warn');
                    ui.snipNote = { field, msg: err?.message || String(err) };
                }
                renderDetail(`[data-act="up-snip-save"][data-field="${field}"]`);
                return true;
            }
            case 'up-snip-insert': {
                const field = btn.dataset.field;
                const backFocus = [`[data-act="up-snip-insert"][data-field="${field}"]`, `[data-act="up-snip-save"][data-field="${field}"]`];
                const r = await snippetsDialog(field);
                if (!r || !current()) {
                    // 对话框里可能删掉了几段：按钮上的数字跟着变
                    renderDetail(backFocus);
                    return true;
                }
                const textNow = () => el.querySelector(`[data-up-f="${field}"]`)?.value ?? current()?.[field] ?? '';
                // 替换会扔掉框里现有的文字（重绘后浏览器的撤销也没了）：先确认
                const old = textNow().trim();
                if (r.mode === 'replace' && old && old !== r.text.trim()
                    && !(await confirmDialog(`用「${r.name}」替换现有的 ${old.length} 字？原来的文字不会保留。`, { danger: true, okLabel: '替换' }))) {
                    renderDetail(backFocus);
                    return true;
                }
                // 确认期间可能换了画像：按现在选中的画像和框里现在的文字来
                const cur = current();
                if (!cur) return true;
                const before = textNow();
                let next = r.mode === 'replace' || !before.trim() ? r.text : `${before.replace(/\s+$/, '')}\n${r.text}`;
                if (next.length > USER_PROFILE_LIMITS.text) {
                    next = next.slice(0, USER_PROFILE_LIMITS.text);
                    app.log(`最多 ${USER_PROFILE_LIMITS.text} 字，多出来的没有加上`, 'warn');
                }
                save({ [field]: next });
                app.log(`已${r.mode === 'replace' ? '替换成' : '插入'}常用文字「${r.name}」`, 'success');
                renderDetail(`[data-up-f="${field}"]`);
                const t = el.querySelector(`[data-up-f="${field}"]`);
                t?.setSelectionRange?.(t.value.length, t.value.length);
                return true;
            }
            case 'up-orient-new': {
                const { createdId } = await openOrientationTemplatesDialog({ create: true });
                const cur = current();
                if (!cur) return true;
                // 新建的导向马上出现在这里，并加进偏好的导向（点一下就能去掉；偏好的导向已经满了时只出现、不选上）
                if (createdId && !cur.orientations.includes(createdId) && cur.orientations.length < USER_PROFILE_LIMITS.orientations) {
                    save({ orientations: [...cur.orientations, createdId] });
                    app.log(`已新建导向「${getOrientationTemplate(app.settings, createdId)?.name || ''}」，并加到偏好的导向`, 'success');
                    renderDetail([`[data-act="up-orient"][data-orient-id="${CSS.escape(createdId)}"]`, '[data-act="up-orient-new"]']);
                } else {
                    renderDetail('[data-act="up-orient-new"]');
                }
                return true;
            }
            default:
                return false;
        }
    }

    async function onClick(e) {
        const item = e.target.closest('[data-up-id]');
        if (item && el.contains(item)) return selectId(item.dataset.upId);
        const btn = e.target.closest('[data-act]');
        if (!btn) {
            // 点到标签框的空白处（内边距、标签之间、行尾）：聚焦框里的输入框，跟普通输入框一样
            const tagbox = e.target.closest?.('[data-up-tagbox]');
            if (tagbox && el.contains(tagbox) && !e.target.closest('input, button')) tagbox.querySelector('[data-up-tag-input]:not(:disabled)')?.focus();
            return undefined;
        }
        const p = current();
        try {
            if (await onLibraryAction(btn, p)) return undefined;
            switch (btn.dataset.act) {
                case 'up-new': {
                    // 第一个画像自动设为默认（写卡表单默认就选它）
                    const created = addUserProfile(app.settings, { name: uniqueUserProfileName(app.settings, '我的画像'), isDefault: !profiles().length });
                    app.saveSettings();
                    app.events.emit('nav');
                    app.log(`已新建用户画像「${created.name}」`, 'success');
                    return selectId(created.id, '[data-up-f="name"]');
                }
                case 'up-import': {
                    const file = await pickFile('.json,application/json');
                    if (!file) return undefined;
                    const { profiles: created, library } = importUserProfileFile(app.settings, await readFileAsText(file));
                    app.saveSettings();
                    app.events.emit('nav');
                    const lib = libraryMergeSummary(library);
                    app.log(`已导入 ${created.length} 个用户画像：${created.map((x) => x.name).join('、')}${lib ? `；常用库新增 ${lib}` : ''}`, 'success');
                    return selectId(created[0].id);
                }
                case 'up-export-all': {
                    const list = profiles();
                    if (list.length) await exportProfiles(list);
                    return undefined;
                }
                case 'up-export':
                    if (p) await exportProfiles([p]);
                    return undefined;
                case 'up-duplicate': {
                    if (!p) return undefined;
                    const copy = duplicateUserProfile(app.settings, p.id);
                    app.saveSettings();
                    app.events.emit('nav');
                    app.log(`已复制为「${copy.name}」`, 'success');
                    return selectId(copy.id, '[data-up-f="name"]');
                }
                case 'up-delete': {
                    if (!p) return undefined;
                    if (!(await confirmDialog(`删除用户画像「${p.name}」？已经用它生成的角色卡不受影响（卡上存的是当时的内容）。`, { danger: true, okLabel: '删除' }))) return undefined;
                    const before = profiles().map((x) => x.id);
                    removeUserProfile(app.settings, p.id);
                    app.saveSettings();
                    app.events.emit('nav');
                    app.log(`已删除用户画像「${p.name}」`, 'success');
                    return selectId(idAfterDelete(before, p.id, profiles().map((x) => x.id)));
                }
                case 'up-orient': {
                    if (!p) return undefined;
                    const id = btn.dataset.orientId;
                    const next = p.orientations.includes(id) ? p.orientations.filter((x) => x !== id) : [...p.orientations, id];
                    save({ orientations: next });
                    return renderDetail(`[data-act="up-orient"][data-orient-id="${CSS.escape(id)}"]`);
                }
                case 'up-intensity':
                    if (!p) return undefined;
                    save({ intensity: btn.dataset.val });
                    return renderDetail(`[data-act="up-intensity"][data-val="${CSS.escape(btn.dataset.val)}"]`);
                case 'up-tag-toggle': {
                    if (!p) return undefined;
                    const { kind, tag } = btn.dataset;
                    const tags = tagsOf(p, kind);
                    const has = tags.some((t) => sameTag(t, tag, kind));
                    if (!has && isFull(p, kind)) {
                        app.log(kind === 'style' ? `叙事偏好最多 ${USER_PROFILE_LIMITS.text} 字` : `每类最多 ${USER_PROFILE_LIMITS.tags} 个标签`, 'warn');
                        return undefined;
                    }
                    return setTags(kind, has ? tags.filter((t) => !sameTag(t, tag, kind)) : [...tags, tag], `[data-act="up-tag-toggle"][data-kind="${kind}"][data-tag="${CSS.escape(tag)}"]`);
                }
                case 'up-tag-remove': {
                    if (!p) return undefined;
                    const { kind, tag } = btn.dataset;
                    return setTags(kind, tagsOf(p, kind).filter((t) => t !== tag), `[data-up-tag-input="${kind}"]`);
                }
                default:
                    return undefined;
            }
        } catch (err) {
            await alertDialog(err?.message || String(err), '出错了');
            return undefined;
        }
    }

    const onKey = (e) => {
        const libInput = e.target.closest?.('[data-up-lib-input]');
        if (libInput) {
            if (e.isComposing) return;
            if (e.key === 'Enter' || e.key === ',') {
                e.preventDefault();
                const { kind } = libInput.dataset;
                const group = libInput.dataset.upLibInput;
                // 输入框留着，接着加下一个；没存进去的留在框里，旁边说明原因
                libInput.value = addLibTyped(kind, group, libInput.value);
                renderDetail(libInputSel(kind, group));
            }
            return;
        }
        const input = e.target.closest?.('[data-up-tag-input]');
        if (input) {
            if (e.isComposing) return;
            if (e.key === 'Enter' || e.key === ',') {
                e.preventDefault();
                addTyped(input);
            } else if (e.key === 'Backspace' && !input.value) {
                // 输入框是空的：退格去掉最后一个标签。叙事偏好里旧版留下的长句（比一项的上限长，删了就打不回原样）不用退格删，
                // 只能点它的 ×，免得按一下退格整句没了
                const kind = input.dataset.upTagInput;
                const p = current();
                const tags = p ? tagsOf(p, kind) : [];
                const last = tags[tags.length - 1];
                if (last !== undefined && !(kind === 'style' && last.length > tagMax('style'))) {
                    e.preventDefault();
                    setTags(kind, tags.slice(0, -1), `[data-up-tag-input="${kind}"]`);
                }
            }
            return;
        }
        const item = e.target.closest?.('[data-up-id]');
        if (!item) return;
        const items = [...el.querySelectorAll('[data-up-id]')];
        const i = items.indexOf(item);
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            selectId(item.dataset.upId);
        } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            const next = items[i + (e.key === 'ArrowDown' ? 1 : -1)];
            if (next) selectId(next.dataset.upId);
        }
    };

    // 「添加」输入框里按 Esc：收起输入框（不存），焦点回到「添加」。要在 window 的捕获阶段拦下，
    // 否则外面的对话框（「管理用户画像」）先收到 Esc 把整个对话框关掉
    const onEscCapture = (e) => {
        if (e.key !== 'Escape' || e.isComposing) return;
        const input = e.target?.closest?.('[data-up-lib-input]');
        if (!input || !el.contains(input)) return;
        e.preventDefault();
        e.stopPropagation();
        const { kind } = input.dataset;
        const group = input.dataset.upLibInput;
        input.value = '';
        ui.adding = null;
        ui.libNote = null;
        renderDetail(addSel(kind, group));
    };

    const onInput = (e) => {
        const libInput = e.target.closest?.('[data-up-lib-input]');
        if (libInput) {
            const { kind } = libInput.dataset;
            const group = libInput.dataset.upLibInput;
            // 输入法打出的全角逗号、顿号不触发 keydown 的「,」：输入里出现分隔符时把前面的部分存进去
            if (e.type === 'input' && !e.isComposing && TAG_SEPARATORS.test(libInput.value)) {
                libInput.value = addLibTyped(kind, group, libInput.value);
                renderDetail(libInputSel(kind, group));
            } else if (e.type === 'input' && ui.libNote?.kind === kind && ui.libNote.group === group) {
                // 接着改输入框里的文字：上一次的提示不再适用，收起来（不重绘，焦点和光标不动）
                ui.libNote = null;
                el.querySelector('[data-up-lib-note]')?.remove();
                libInput.removeAttribute('aria-describedby');
            }
            return;
        }
        const input = e.target.closest?.('[data-up-tag-input]');
        if (input) {
            // 输入法打出的全角逗号、顿号不触发 keydown 的「,」：输入里出现分隔符时把前面的部分加进去
            if (e.type === 'input' && !e.isComposing && TAG_SEPARATORS.test(input.value)) addTyped(input);
            // 离开输入框（change）时还有没确认的文字：也加进去，不悄悄丢掉
            else if (e.type === 'change') commitOnLeave(input);
            return;
        }
        // 文字在输入时保存，勾选框在 change 时保存（勾选框也会触发 input，只处理一次）
        const f = e.target.closest('[data-up-f]');
        if (f && (f.type === 'checkbox' ? e.type === 'change' : e.type === 'input')) onFieldEdit(e);
    };

    el.addEventListener('click', onClick);
    el.addEventListener('keydown', onKey);
    el.addEventListener('input', onInput);
    el.addEventListener('change', onInput);
    el.addEventListener('focusout', onFocusOut);
    window.addEventListener('keydown', onEscCapture, true);
    // 按下鼠标的地方可能在编辑区外面（页面标题栏的按钮、对话框底部的「完成」）：在 window 上听
    window.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('pointerup', onPointerUp, true);
    window.addEventListener('pointercancel', onPointerUp, true);
    render();
    return {
        selected: () => selected,
        destroy() {
            // 切走页面 / 关掉对话框时输入框里还有没确认的标签：照样存下
            for (const input of el.querySelectorAll('[data-up-tag-input]')) {
                if (!input.value.trim() || !current()) continue;
                const kind = input.dataset.upTagInput;
                const typed = takeTyped(input);
                if (typed.length) saveTags(kind, [...tagsOf(current(), kind), ...typed]);
            }
            // 「添加」输入框里没确认的常用标签：同样存下
            for (const input of el.querySelectorAll('[data-up-lib-input]')) {
                const raw = input.value;
                input.value = '';
                if (raw.trim()) addLibTyped(input.dataset.kind, input.dataset.upLibInput, raw, { select: false });
            }
            clearTimeout(savedTimer);
            clearTimeout(liveTimer);
            pendingRender = null;
            window.removeEventListener('keydown', onEscCapture, true);
            window.removeEventListener('pointerdown', onPointerDown, true);
            window.removeEventListener('pointerup', onPointerUp, true);
            window.removeEventListener('pointercancel', onPointerUp, true);
        },
    };
}

/**
 * 「管理用户画像」对话框（写卡表单用）：和「用户画像」页一样的列表 + 编辑区，关掉后回到写卡表单，表单里的内容都在。
 * @param {{select?: string}} opt select：先选中的画像（写卡表单里选的那个）
 * @returns {Promise<string>} 关闭时选中的画像 id
 */
export async function openUserProfilesDialog({ select = '' } = {}) {
    const box = document.createElement('div');
    box.className = 'nl-up-dialog';
    let editor = null;
    await openDialog({
        title: '用户画像',
        wide: true,
        body: box,
        buttons: [{ label: '完成', value: null, primary: true }],
        onMount: () => {
            editor = mountProfilesEditor(box, { select });
        },
    });
    const id = editor?.selected() || '';
    editor?.destroy();
    return id;
}

export const profilesTab = {
    mount(el, { setActions }) {
        return mountProfilesEditor(el, { setActions: setActions || (() => {}) });
    },
};
