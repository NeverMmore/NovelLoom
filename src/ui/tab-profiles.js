// 用户画像页：左边列出画像，右边编辑选中的画像（改动自动保存）。不需要打开项目——画像存在扩展设置里，所有项目共用。
// 画像 = 偏好的导向 + 喜欢的元素 + 雷点 + 尺度 + {{user}} 的默认形象 + 叙事偏好 + 其他 + 「聊天时也照顾这些偏好」；
// 写卡时在「角色卡」页选一个画像，AI 按它量身定制（见 userprofile.js）。可新建、复制、删除（需确认）、导入 / 导出 JSON。
// 列表 + 编辑区由 mountProfilesEditor 渲染：「用户画像」页和写卡表单的「管理用户画像」对话框（openUserProfilesDialog）共用，
// 在写卡表单里管理画像不用离开角色卡页（表单里填了一半的内容不会丢）。

import { app } from '../app.js';
import { listOrientationTemplates } from '../orientation.js';
import {
    USER_PROFILE_INTENSITIES, USER_PROFILE_LIMITS, USER_PROFILE_TAG_GROUPS, addUserProfile, duplicateUserProfile, exportUserProfiles, getUserProfile,
    importUserProfiles, intensityInfo, isDislikedName, listUserProfiles, normalizeProfileTags, orientationConflicts, removeUserProfile, uniqueUserProfileName,
    updateUserProfile, userProfileFileName, userProfileNameProblem, userProfileSummary,
} from '../userprofile.js';
import { downloadFile, pickFile, readFileAsText } from '../utils.js';
import { alertDialog, confirmDialog, emptyState, esc, icon, openDialog } from './common.js';

/** 切换页面（或关掉对话框）后回来时仍选中上次的画像 */
let lastSelected = '';

const TAG_KINDS = {
    likes: { label: '喜欢的元素', note: '角色属性、外形服饰、癖好……写卡时自然融入，不会生硬罗列', placeholder: '输入后按回车或逗号添加' },
    dislikes: { label: '雷点', note: '绝对避免：卡里不出现，连暗示都不要', placeholder: '输入雷点，回车或逗号添加' },
};

/** 标签输入框能输入多长：够粘贴一整串用逗号隔开的标签（每个标签最多 12 字，规整时截短；截掉时会提示） */
const TAG_INPUT_MAX = USER_PROFILE_LIMITS.tag * USER_PROFILE_LIMITS.tags + USER_PROFILE_LIMITS.tags;

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
            <div class="nl-small nl-clamp">${esc(userProfileSummary(p, { max: 3 }))}</div>
        </div>`;
}

/** 一类标签（喜欢 / 雷点）的编辑区：已选的标签（可去掉）+ 输入框 + 分组的建议 */
function tagEditorHtml(p, kind) {
    const k = TAG_KINDS[kind];
    const tags = p[kind];
    const other = kind === 'likes' ? p.dislikes : p.likes;
    const otherLabel = kind === 'likes' ? '雷点' : '喜欢';
    const full = tags.length >= USER_PROFILE_LIMITS.tags;
    const chips = tags.map((t) => `<span class="nl-up-chip">${esc(t)}<button type="button" class="nl-up-chip-x" data-act="up-tag-remove" data-kind="${kind}" data-tag="${esc(t)}" title="去掉" aria-label="去掉「${esc(t)}」">${icon('close', { size: 12 })}</button></span>`).join('');
    const groups = USER_PROFILE_TAG_GROUPS.filter((g) => g.kind === kind).map((g) => `
        <div class="nl-up-sugg-group" role="group" aria-label="${esc(g.name)}">
            <span class="nl-up-sugg-name">${esc(g.name)}</span>
            <div class="nl-up-sugg-list">${g.tags.map((t) => {
        const on = tags.includes(t);
        const inOther = other.includes(t);
        const title = on ? `去掉「${t}」` : inOther ? `「${t}」现在在${otherLabel}里，点一下改到这里` : `添加「${t}」`;
        return `<button type="button" class="nl-seg-btn nl-up-sugg-btn ${on ? 'active' : ''} ${inOther ? 'nl-up-in-other' : ''}" aria-pressed="${on}" data-act="up-tag-toggle" data-kind="${kind}" data-tag="${esc(t)}" title="${esc(title)}">${esc(t)}</button>`;
    }).join('')}</div>
        </div>`).join('');
    return `
        <div class="nl-field nl-up-tags" data-up-tags="${kind}">
            <label for="nl-up-${kind}-input">${k.label} <span class="nl-muted">（${k.note}）</span></label>
            <div class="nl-up-tagbox" data-up-tagbox="${kind}">
                ${chips}
                <input class="nl-up-tag-input" id="nl-up-${kind}-input" data-up-tag-input="${kind}" maxlength="${TAG_INPUT_MAX}" placeholder="${full ? `最多 ${USER_PROFILE_LIMITS.tags} 个` : esc(k.placeholder)}" ${full ? 'disabled' : ''} aria-describedby="nl-up-${kind}-count" autocomplete="off">
            </div>
            <div class="nl-muted nl-small nl-num" id="nl-up-${kind}-count">已选 ${tags.length} / ${USER_PROFILE_LIMITS.tags} · 也可以输入任何自定义标签（每个最多 ${USER_PROFILE_LIMITS.tag} 字，可以一次粘贴多个，用逗号隔开）</div>
            <div class="nl-up-sugg">${groups}</div>
        </div>`;
}

/** 右边的编辑区 */
function detailHtml(p) {
    const orients = listOrientationTemplates(app.settings);
    const int = intensityInfo(p.intensity);
    // 偏好的导向同时又在雷点里（NTR / 后宫 这样两边都有的名字，很容易点错）：标出来并说明
    const conflicts = orientationConflicts(app.settings, p);
    return `
        <div class="nl-card-head nl-wrap">
            <div>
                <h3 data-up-title>${esc(p.name)}</h3>
                <div class="nl-card-desc">改动自动保存。写卡时在「角色卡」页的「用户画像」里选它。</div>
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
        const title = bad ? `「${t.name}」也在雷点里：写卡时不会推荐它当导向` : t.brief;
        return `<button type="button" class="nl-seg-btn ${on ? 'active' : ''} ${bad ? 'nl-up-in-other' : ''}" aria-pressed="${on}" data-act="up-orient" data-orient-id="${esc(t.id)}" title="${esc(title)}">${esc(t.name)}</button>`;
    }).join('')}</div>
            ${conflicts.length ? `<div class="nl-warn nl-small" id="nl-up-orient-conflict" data-up-orient-conflict>${icon('alert', { size: 12 })} ${esc(conflicts.map((o) => `「${o.name}」`).join('、'))}同时在雷点里：写卡时不会推荐它当导向；要是写卡时真的选了它当「卡的导向」，那张卡以卡的导向为准，这一项雷点不适用。</div>` : ''}
        </div>
        ${tagEditorHtml(p, 'likes')}
        ${tagEditorHtml(p, 'dislikes')}
        <div class="nl-field">
            <label id="nl-up-int-label">尺度</label>
            <div class="nl-seg" role="group" aria-labelledby="nl-up-int-label">${USER_PROFILE_INTENSITIES.map((x) => `<button type="button" class="nl-seg-btn ${x.value === p.intensity ? 'active' : ''}" aria-pressed="${x.value === p.intensity}" data-act="up-intensity" data-val="${x.value}">${esc(x.label)}</button>`).join('')}</div>
            <div class="nl-muted nl-small" data-up-int-hint>${esc(int.hint)}所有涉及恋爱或亲密内容的人物（包括 {{user}}）都是成年人。</div>
        </div>
        <div class="nl-field"><label for="nl-up-persona">{{user}} 的默认形象 <span class="nl-muted">（性别、年龄、外貌、身份……；只在「{{user}} 扮演」选原创新身份时使用）</span></label>
            <textarea class="nl-input nl-textarea" id="nl-up-persona" rows="3" data-up-f="persona" maxlength="${USER_PROFILE_LIMITS.text}" placeholder="例如：二十五岁的男性上班族，个子高、话不多，刚搬进这座城市">${esc(p.persona)}</textarea></div>
        <div class="nl-field"><label for="nl-up-style">叙事偏好 <span class="nl-muted">（与卡的文风冲突时以这里为准）</span></label>
            <input class="nl-input" id="nl-up-style" data-up-f="style" maxlength="${USER_PROFILE_LIMITS.text}" value="${esc(p.style)}" placeholder="例如：第二人称、细腻的心理描写、节奏快"></div>
        <div class="nl-field"><label for="nl-up-notes">其他 <span class="nl-muted">（想让写卡 AI 知道的其他事）</span></label>
            <textarea class="nl-input nl-textarea" id="nl-up-notes" rows="2" data-up-f="notes" maxlength="${USER_PROFILE_LIMITS.text}" placeholder="例如：喜欢有来有回的斗嘴；角色别太快动心">${esc(p.notes)}</textarea></div>
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
    if (d.upF) return `[data-up-f="${CSS.escape(d.upF)}"]`;
    if (d.act) {
        let sel = `[data-act="${CSS.escape(d.act)}"]`;
        for (const [k, attr] of [['kind', 'data-kind'], ['tag', 'data-tag'], ['val', 'data-val'], ['orientId', 'data-orient-id']]) {
            if (d[k] !== undefined) sel += `[${attr}="${CSS.escape(d[k])}"]`;
        }
        return sel;
    }
    return '';
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

    const profiles = () => listUserProfiles(app.settings);
    const current = () => getUserProfile(app.settings, selected);
    /** 重绘计数：延后的重绘发现期间已经重绘过（比如点了尺度按钮）就不再重绘 */
    let renders = 0;

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
        if (!list.length) {
            el.innerHTML = `<section class="nl-card">${emptyState('把你的口味存成画像：喜欢的元素、雷点、尺度和叙事偏好。写卡时选上它，AI 会把这些偏好化进角色的外貌、服饰、性格和开场白里。不需要先导入小说。', `<div class="nl-row nl-wrap" style="justify-content:center"><button class="nl-btn nl-primary" data-act="up-new">${icon('plus')}新建画像</button><button class="nl-btn" data-act="up-import">${icon('upload')}导入 JSON</button></div>`, { title: '还没有用户画像', ico: 'profile' })}</section>`;
        } else {
            const p = current();
            // 对话框里没有页面标题栏：新建 / 导入 / 导出全部放在顶部
            const tools = inPage ? '' : `<div class="nl-row nl-wrap nl-up-tools"><span class="nl-muted nl-small nl-grow">画像存在扩展设置里，所有项目共用；改动自动保存。</span>${actionsHtml(list.length, ' nl-sm')}</div>`;
            el.innerHTML = `${tools}
                <div class="nl-split">
                    <div class="nl-card nl-char-list" role="listbox" aria-label="用户画像" data-up-list></div>
                    <div class="nl-card nl-up-detail" data-up-detail>${p ? detailHtml(p) : ''}</div>
                </div>`;
            renderList();
        }
        if (el.isConnected) headerActions();
    };

    /**
     * 只重绘右边的编辑区；focusSel：重绘后把焦点放回去的元素。
     * 两个标签输入框里还没确认（没按回车）的文字跟着保留下来，不会因为点了别的按钮就没了。
     */
    const renderDetail = (focusSel = '') => {
        const box = el.querySelector('[data-up-detail]');
        const p = current();
        if (!box || !p) return render();
        renders++;
        const drafts = Object.fromEntries([...box.querySelectorAll('[data-up-tag-input]')].map((i) => [i.dataset.upTagInput, i.value]));
        const scroller = el.closest('.nl-main, .nl-dialog-body');
        const top = scroller?.scrollTop;
        box.innerHTML = detailHtml(p);
        for (const [kind, v] of Object.entries(drafts)) {
            const inp = v ? box.querySelector(`[data-up-tag-input="${kind}"]`) : null;
            if (inp && !inp.disabled) inp.value = v;
        }
        if (scroller && top !== undefined) scroller.scrollTop = top;
        if (focusSel) box.querySelector(focusSel)?.focus({ preventScroll: true });
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
        try {
            save({ [k]: val });
        } catch (err) {
            showErr(err?.message || String(err));
        }
    };

    /** 改标签的数据（不重绘编辑区）：加 / 去掉；加到一类时从另一类里去掉（同一个标签不会既喜欢又是雷点） */
    const saveTags = (kind, tags, opt = {}) => {
        const p = current();
        if (!p) return;
        const otherKind = kind === 'likes' ? 'dislikes' : 'likes';
        const next = normalizeProfileTags(tags);
        const tagKey = (t) => String(t).replace(/\s+/g, '').toLowerCase();
        const keys = new Set(next.map(tagKey));
        const patch = { [kind]: next, [otherKind]: p[otherKind].filter((t) => !keys.has(tagKey(t))) };
        if (tags.length > USER_PROFILE_LIMITS.tags && next.length >= USER_PROFILE_LIMITS.tags) app.log(`每类最多 ${USER_PROFILE_LIMITS.tags} 个标签，多出来的没有加上`, 'warn');
        save(patch, opt);
    };

    const setTags = (kind, tags, focusSel = '') => {
        if (!current()) return;
        saveTags(kind, tags);
        renderDetail(focusSel);
    };

    /** 输入框里的文字 → 标签（可以是逗号隔开的一串）；超过 12 字的截短并提示。清空输入框，返回要加的标签 */
    const takeTyped = (input) => {
        const raw = input.value;
        input.value = '';
        const pieces = String(raw).split(/[,，、;；\n]/).map((x) => x.replace(/^[#＃]+/, '').trim()).filter(Boolean);
        if (pieces.some((x) => x.length > USER_PROFILE_LIMITS.tag)) app.log(`每个标签最多 ${USER_PROFILE_LIMITS.tag} 字，超出的部分已截掉`, 'warn');
        return normalizeProfileTags(raw);
    };

    const addTyped = (input) => {
        const kind = input.dataset.upTagInput;
        const p = current();
        if (!p) return;
        const typed = takeTyped(input);
        if (!typed.length) return;
        setTags(kind, [...p[kind], ...typed], `[data-up-tag-input="${kind}"]`);
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
    const commitOnLeave = (input) => {
        const kind = input.dataset.upTagInput;
        const p = current();
        if (!p || !input.value.trim()) return;
        const typed = takeTyped(input);
        if (!typed.length) return;
        // 列表也等到点击完成后再重绘（点的可能正是左边另一个画像）
        saveTags(kind, [...p[kind], ...typed], { list: false });
        const before = renders;
        const run = () => {
            // 页面已经切走就不管；期间已经重绘过编辑区（点了尺度、标签等会重绘的按钮）：新标签已经显示，只刷新列表
            if (!el.isConnected) return;
            renderList();
            if (renders === before) renderDetail(selectorFor(document.activeElement, el));
        };
        if (pointerDown) {
            pendingRender = run;
            // 万一没收到松开（在窗口外松开鼠标）：过一会儿照样重绘
            setTimeout(() => {
                if (pendingRender !== run) return;
                pendingRender = null;
                run();
            }, 2000);
        } else {
            // 键盘（Tab）：等焦点落到下一个元素上，再重绘并把焦点放回它
            setTimeout(run, 0);
        }
    };

    const selectId = (id, focusSel = '') => {
        selected = id;
        lastSelected = id;
        render();
        const target = focusSel ? el.querySelector(focusSel) : (id ? el.querySelector(`[data-up-id="${CSS.escape(id)}"]`) : null);
        // 删掉了最后一个画像：焦点放到空状态的「新建画像」上，不掉到页面最外层
        (target || (!profiles().length ? el.querySelector('[data-act="up-new"]') : null))?.focus({ preventScroll: true });
    };

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
                    const created = importUserProfiles(app.settings, await readFileAsText(file));
                    app.saveSettings();
                    app.events.emit('nav');
                    app.log(`已导入 ${created.length} 个用户画像：${created.map((x) => x.name).join('、')}`, 'success');
                    return selectId(created[0].id);
                }
                case 'up-export-all': {
                    const list = profiles();
                    if (!list.length) return undefined;
                    downloadFile(JSON.stringify(exportUserProfiles(app.settings, list), null, 2), userProfileFileName(list));
                    return undefined;
                }
                case 'up-export':
                    if (p) downloadFile(JSON.stringify(exportUserProfiles(app.settings, [p]), null, 2), userProfileFileName([p]));
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
                    const has = p[kind].includes(tag);
                    if (!has && p[kind].length >= USER_PROFILE_LIMITS.tags) {
                        app.log(`每类最多 ${USER_PROFILE_LIMITS.tags} 个标签`, 'warn');
                        return undefined;
                    }
                    return setTags(kind, has ? p[kind].filter((t) => t !== tag) : [...p[kind], tag], `[data-act="up-tag-toggle"][data-kind="${kind}"][data-tag="${CSS.escape(tag)}"]`);
                }
                case 'up-tag-remove': {
                    if (!p) return undefined;
                    const { kind, tag } = btn.dataset;
                    return setTags(kind, p[kind].filter((t) => t !== tag), `[data-up-tag-input="${kind}"]`);
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
        const input = e.target.closest?.('[data-up-tag-input]');
        if (input) {
            if (e.isComposing) return;
            if (e.key === 'Enter' || e.key === ',') {
                e.preventDefault();
                addTyped(input);
            } else if (e.key === 'Backspace' && !input.value) {
                // 输入框是空的：退格去掉最后一个标签
                const kind = input.dataset.upTagInput;
                const p = current();
                if (p?.[kind]?.length) {
                    e.preventDefault();
                    setTags(kind, p[kind].slice(0, -1), `[data-up-tag-input="${kind}"]`);
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

    const onInput = (e) => {
        const input = e.target.closest?.('[data-up-tag-input]');
        if (input) {
            // 输入法打出的全角逗号、顿号不触发 keydown 的「,」：输入里出现分隔符时把前面的部分加进去
            if (e.type === 'input' && !e.isComposing && /[,，、;；\n]/.test(input.value)) addTyped(input);
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
                if (typed.length) saveTags(kind, [...current()[kind], ...typed]);
            }
            clearTimeout(savedTimer);
            clearTimeout(liveTimer);
            pendingRender = null;
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
