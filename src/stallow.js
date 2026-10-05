// 写入酒馆后自动允许本卡的局部正则与酒馆助手（JS-Slash-Runner）角色脚本（设置 cards.autoAllow，默认开）。
// 只动这张卡（按头像文件名，如 card_1.png）的那一项，不碰其他角色的授权。
//
// 局部正则：酒馆每次取脚本时都实时读 extension_settings.character_allowed_regex（public/scripts/extensions/regex/engine.js 的
//   getScriptsByType / isScopedScriptsAllowed / allowScopedScripts），把头像文件名加进去再 saveSettingsDebounced 就立即生效。
// 角色脚本：酒馆助手 4.x 的全局设置在 pinia store「global_settings」（src/store/settings/global.ts）里：启动时从
//   extension_settings.tavern_helper 解析一次，之后由它自己 watch 整个对象写回 extension_settings 并保存。只改 extension_settings
//   它看不到，下次它写回时还会被覆盖，所以优先改 store：#tavern_helper 上挂的 Vue 应用 → $pinia → _s.get('global_settings')，
//   把头像加进 settings.script.enabled.characters（启用本卡脚本，src/store/scripts.ts 的 character.enabled 就是查这个名单），
//   同时加进 popuped.characters（src/panel/script/use_check_enablement_popup.ts：在名单里就不再弹窗询问），它的 watch 会保存。
//   找不到 store 时退而改 extension_settings.tavern_helper（有这个结构的话）并保存，刷新酒馆页面后生效。

const JSR_STORE_ID = 'global_settings';
const NO_AVATAR = '还不知道这张卡在酒馆里的头像文件';

function stContext() {
    try {
        return globalThis.SillyTavern?.getContext?.() || null;
    } catch {
        return null;
    }
}

function errText(e) {
    return String(e?.message || e || '未知错误').slice(0, 120);
}

/** 酒馆里的头像文件名（带 .png；NovelLoom 记的 card.stAvatar 不带） */
export function avatarFileName(avatar) {
    const a = String(avatar ?? '').trim().replace(/\.png$/i, '');
    return a ? `${a}.png` : '';
}

/** 卡片 JSON 带局部正则（data.extensions.regex_scripts 非空） */
export function cardHasScopedRegex(json) {
    const list = json?.data?.extensions?.regex_scripts;
    return Array.isArray(list) && list.length > 0;
}

/** 卡片 JSON 带酒馆助手角色脚本（data.extensions.tavern_helper.scripts 非空；兼容旧的 [[键, 值]] 数组写法） */
export function cardHasHelperScripts(json) {
    let th = json?.data?.extensions?.tavern_helper;
    if (Array.isArray(th)) {
        try {
            th = Object.fromEntries(th);
        } catch {
            return false;
        }
    }
    return Array.isArray(th?.scripts) && th.scripts.length > 0;
}

/**
 * 酒馆助手的全局设置 store：#tavern_helper（酒馆助手面板的挂载点）上的 Vue 应用 → pinia → 'global_settings'。
 * 找不到（没装、没启用、版本不同）或形状不对时返回 null。
 */
export function jsrSettingsStore(doc = globalThis.document) {
    try {
        const store = doc?.getElementById?.('tavern_helper')?.__vue_app__?.config?.globalProperties?.$pinia?._s?.get?.(JSR_STORE_ID);
        return Array.isArray(store?.settings?.script?.enabled?.characters) ? store : null;
    } catch {
        return null;
    }
}

function addOnce(list, item) {
    if (!Array.isArray(list) || list.includes(item)) return false;
    list.push(item);
    return true;
}

/**
 * 允许本卡的局部正则（与酒馆首次打开角色时弹窗里点「允许」相同）。
 * @returns {{status: 'added'|'already'|'failed', error?: string}}
 */
export function allowCardRegex(avatar, ctx = stContext()) {
    const a = avatarFileName(avatar);
    try {
        if (!a) throw new Error(NO_AVATAR);
        const es = ctx?.extensionSettings;
        if (!es || typeof es !== 'object') throw new Error('无法访问酒馆的扩展设置');
        if (!Array.isArray(es.character_allowed_regex)) es.character_allowed_regex = [];
        if (es.character_allowed_regex.includes(a)) return { status: 'already' };
        es.character_allowed_regex.push(a);
        ctx.saveSettingsDebounced?.();
        return { status: 'added' };
    } catch (e) {
        return { status: 'failed', error: errText(e) };
    }
}

/**
 * 在酒馆助手里启用本卡的角色脚本。
 * store：改了酒馆助手的 store（立即生效，由它自己保存）；fallback：改了 extension_settings.tavern_helper（刷新酒馆页面后生效）；
 * already：已经启用；missing：没找到酒馆助手的设置；failed：出错。
 * @returns {{status: 'store'|'fallback'|'already'|'missing'|'failed', error?: string}}
 */
export function enableCardScripts(avatar, { ctx = stContext(), doc = globalThis.document } = {}) {
    const a = avatarFileName(avatar);
    try {
        if (!a) throw new Error(NO_AVATAR);
        const store = jsrSettingsStore(doc);
        if (store) {
            const s = store.settings.script;
            const added = addOnce(s.enabled.characters, a);
            addOnce(s.popuped?.characters, a);
            return { status: added ? 'store' : 'already' };
        }
        const th = ctx?.extensionSettings?.tavern_helper;
        if (!Array.isArray(th?.script?.enabled?.characters)) return { status: 'missing' };
        const added = addOnce(th.script.enabled.characters, a);
        const popped = addOnce(th.script.popuped?.characters, a);
        if (added || popped) ctx.saveSettingsDebounced?.();
        return { status: added ? 'fallback' : 'already' };
    } catch (e) {
        return { status: 'failed', error: errText(e) };
    }
}

/** 本卡的角色脚本是否已在酒馆助手里启用（先看 store，没有时看 extension_settings）；不知道时 null */
export function cardScriptsEnabled(avatar, { ctx = stContext(), doc = globalThis.document } = {}) {
    const a = avatarFileName(avatar);
    if (!a) return null;
    try {
        const store = jsrSettingsStore(doc);
        const list = store ? store.settings.script.enabled.characters : ctx?.extensionSettings?.tavern_helper?.script?.enabled?.characters;
        return Array.isArray(list) ? list.includes(a) : null;
    } catch {
        return null;
    }
}

const REGEX_TEXT = {
    added: '已允许局部正则',
    already: '局部正则早已允许',
};
const SCRIPT_TEXT = {
    store: '已启用角色脚本',
    already: '角色脚本早已启用',
    fallback: '已启用角色脚本（写进了酒馆助手的设置，需要刷新酒馆页面后生效）',
    missing: '没有找到酒馆助手（JS-Slash-Runner）的设置：装好并启用酒馆助手后，到 酒馆助手 → 脚本库 → 角色脚本 里启用本卡的脚本',
};

/**
 * 写入酒馆后自动授权（publishCard 成功、知道头像文件后调用）：卡片带局部正则就加进酒馆的允许名单，
 * 带酒馆助手角色脚本就在酒馆助手里启用。设置关掉（settings.cards.autoAllow === false）或卡片两样都没有时什么都不做，返回 null。
 * 不会抛错：每一步的结果放在返回值里，并用 onLog 记一行中文日志（有没成功的就用 warn）。
 * @param {object} settings 扩展设置
 * @param {object} json 写入的卡片 JSON（chara_card_v3）
 * @param {string} avatar 酒馆里的头像文件名（带不带 .png 都行）
 * @param {{onLog?: Function, ctx?: object, doc?: Document, name?: string}} opt
 * @returns {{regex: object|null, scripts: object|null, message: string, level: 'success'|'warn'}|null}
 */
export function autoAllowCard(settings, json, avatar, { onLog = null, ctx = stContext(), doc = globalThis.document, name = '' } = {}) {
    if (settings?.cards?.autoAllow === false) return null;
    const wantRegex = cardHasScopedRegex(json);
    const wantScripts = cardHasHelperScripts(json);
    if (!wantRegex && !wantScripts) return null;
    const regex = wantRegex ? allowCardRegex(avatar, ctx) : null;
    const scripts = wantScripts ? enableCardScripts(avatar, { ctx, doc }) : null;
    const parts = [];
    let level = 'success';
    if (regex) {
        if (regex.status === 'failed') {
            parts.push(`允许局部正则失败（${regex.error}），请在酒馆第一次打开这个角色时允许`);
            level = 'warn';
        } else parts.push(REGEX_TEXT[regex.status]);
    }
    if (scripts) {
        if (scripts.status === 'failed') parts.push(`启用角色脚本失败（${scripts.error}），请到 酒馆助手 → 脚本库 → 角色脚本 里启用`);
        else parts.push(SCRIPT_TEXT[scripts.status]);
        if (scripts.status === 'failed' || scripts.status === 'fallback' || scripts.status === 'missing') level = 'warn';
    }
    const who = String(name || json?.data?.name || json?.name || avatarFileName(avatar) || '').trim();
    const message = `自动授权${who ? `「${who}」` : ''}：${parts.join('；')}`;
    if (typeof onLog === 'function') {
        try {
            onLog(message, level);
        } catch (e) {
            console.warn('[NovelLoom]', e);
        }
    } else console.info('[NovelLoom]', message);
    return { regex, scripts, message, level };
}
