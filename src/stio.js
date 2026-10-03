// 与 SillyTavern 交互：世界书写入、角色导入、刷新列表

function ctx() {
    const c = globalThis.SillyTavern?.getContext?.();
    if (!c) throw new Error('无法访问 SillyTavern 上下文');
    return c;
}

function headers(omitContentType = false) {
    const c = ctx();
    let h;
    try {
        h = c.getRequestHeaders({ omitContentType });
    } catch {
        h = c.getRequestHeaders();
    }
    h = { ...h };
    if (omitContentType) delete h['Content-Type'];
    return h;
}

export async function getWorldNames() {
    const c = ctx();
    if (typeof c.getWorldInfoNames === 'function') return c.getWorldInfoNames();
    const res = await fetch('/api/settings/get', { method: 'POST', headers: headers(), body: JSON.stringify({}) });
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data?.world_names) ? data.world_names : [];
}

/**
 * 保存世界书到酒馆（同名覆盖）
 * @param {string} name
 * @param {{entries: object}} data
 */
export async function saveWorldToST(name, data) {
    const c = ctx();
    if (!name) throw new Error('世界书名称为空');
    if (typeof c.saveWorldInfo === 'function') {
        await c.saveWorldInfo(name, data, true);
    } else {
        const res = await fetch('/api/worldinfo/edit', { method: 'POST', headers: headers(), body: JSON.stringify({ name, data }) });
        if (!res.ok) throw new Error(`保存世界书失败：HTTP ${res.status}`);
    }
    try {
        await c.updateWorldInfoList?.();
    } catch (e) {
        console.warn('[NovelLoom] updateWorldInfoList 失败', e);
    }
    return name;
}

export async function loadWorldFromST(name) {
    const c = ctx();
    if (typeof c.loadWorldInfo === 'function') return c.loadWorldInfo(name);
    const res = await fetch('/api/worldinfo/get', { method: 'POST', headers: headers(), body: JSON.stringify({ name }) });
    return res.ok ? res.json() : null;
}

/**
 * 导入角色卡到酒馆
 * @param {Blob} blob JSON 或 PNG
 * @param {string} fileName 含扩展名
 * @param {{preserveName?: string}} opt preserveName：覆盖已有角色（其 avatar 文件名，不含 .png）
 * @returns {Promise<string>} 角色文件名（不含扩展名）
 */
export async function importCharacterToST(blob, fileName, { preserveName = '' } = {}) {
    const c = ctx();
    const ext = (fileName.match(/\.(\w+)$/)?.[1] || 'json').toLowerCase();
    const file = new File([blob], fileName, { type: ext === 'png' ? 'image/png' : 'application/json' });
    const form = new FormData();
    form.append('avatar', file);
    form.append('file_type', ext);
    form.append('user_name', c.name1 || 'User');
    if (preserveName) form.append('preserved_name', preserveName.replace(/\.png$/i, ''));
    const res = await fetch('/api/characters/import', { method: 'POST', headers: headers(true), body: form, cache: 'no-cache' });
    if (!res.ok) throw new Error(`导入角色失败：HTTP ${res.status}`);
    const data = await res.json();
    if (data?.error || !data?.file_name) throw new Error('酒馆返回导入错误（请检查卡片内容）');
    try {
        await c.getCharacters?.();
    } catch (e) {
        console.warn('[NovelLoom] 刷新角色列表失败', e);
    }
    return String(data.file_name).replace(/\.png$/i, '');
}

export function findCharacterIndex(avatarName) {
    const c = ctx();
    const target = `${String(avatarName).replace(/\.png$/i, '')}.png`;
    return (c.characters || []).findIndex((ch) => ch.avatar === target);
}

export async function openCharacterInST(avatarName) {
    const c = ctx();
    const idx = findCharacterIndex(avatarName);
    if (idx < 0) throw new Error('在酒馆中找不到该角色（可能已被删除）');
    await c.selectCharacterById?.(idx);
    return idx;
}

export function characterExistsInST(avatarName) {
    try {
        return avatarName ? findCharacterIndex(avatarName) >= 0 : false;
    } catch {
        return false;
    }
}

/**
 * 创建酒馆群聊（POST /api/groups/create）；返回酒馆分配的群组 id
 * @param {{name:string, members:string[], allow_self_responses?:boolean, activation_strategy?:number, generation_mode?:number}} body
 *   members：角色的 avatar 文件名（含 .png），即 importCharacterToST 的返回值 + '.png'
 * @returns {Promise<string>} 群组 id
 */
export async function createGroupInST(body) {
    const res = await fetch('/api/groups/create', { method: 'POST', headers: headers(), body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`创建群聊失败：HTTP ${res.status}（请确认酒馆版本支持群聊 API）`);
    const data = await res.json().catch(() => null);
    const id = data?.id ?? data?.chat_id ?? body.id;
    if (!id) throw new Error('酒馆没有返回群组 id');
    return String(id);
}

/** 更新已创建的群聊（POST /api/groups/edit，需要完整 group 对象，最少带 id） */
export async function updateGroupInST(body) {
    if (!body?.id) throw new Error('缺少群组 id');
    const res = await fetch('/api/groups/edit', { method: 'POST', headers: headers(), body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`更新群聊失败：HTTP ${res.status}`);
    return true;
}

/** 群聊是否仍存在于酒馆（用于判断“已在酒馆”状态） */
export async function groupExistsInST(id) {
    if (!id) return false;
    try {
        const res = await fetch('/api/groups/all', { method: 'POST', headers: headers() });
        if (!res.ok) return false;
        const list = await res.json().catch(() => []);
        return Array.isArray(list) && list.some((g) => String(g.id) === String(id));
    } catch {
        return false;
    }
}

export function toast(type, message, title = 'NovelLoom') {
    const t = globalThis.toastr;
    if (t?.[type]) t[type](message, title);
    else console.log(`[NovelLoom] ${type}: ${message}`);
}
