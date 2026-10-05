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

/** 上传图片到酒馆失败：status 是 HTTP 状态码（连不上酒馆时为 0），message 是给用户看的中文说明 */
export class ImageUploadError extends Error {
    constructor(message, status = 0) {
        super(message);
        this.name = 'ImageUploadError';
        this.status = status;
    }
}

/** 上传失败的状态码 → 中文说明 */
export function uploadErrorText(status, detail = '') {
    const tail = detail ? `：${String(detail).slice(0, 80)}` : '';
    if (!status) return '连不上酒馆服务器（网络断开，或者酒馆没有在运行）';
    if (status === 401 || status === 403) return `酒馆拒绝了上传（HTTP ${status}：登录可能已过期，刷新酒馆页面后再试）`;
    if (status === 413) return '图片太大，酒馆拒绝接收（HTTP 413）';
    if (status === 404) return '这个酒馆版本没有图片上传接口（HTTP 404）';
    if (status === 400) return `酒馆不接受这张图片（HTTP 400${tail}）`;
    if (status >= 500) return `酒馆保存图片失败（HTTP ${status}${tail}）`;
    return `上传失败（HTTP ${status}${tail}）`;
}

/**
 * 上传一张图片到酒馆（POST /api/images/upload，与酒馆自己的 saveBase64AsFile 一样的请求体，带 CSRF 请求头）。
 * 酒馆把它存成 user/images/<folder>/<filename>.<format>（文件夹名、文件名按 sanitize-filename 处理；同名覆盖）。
 * 从不调用删除接口：删掉的立绘仍留在这个角色的图库里。
 * @param {{base64: string, format: string, folder?: string, filename?: string}} img base64 不带 data: 前缀；format 是扩展名（png / jpg / webp / gif / bmp）
 * @returns {Promise<string>} 酒馆返回的路径（'/user/images/…'，没有编码）
 * @throws {ImageUploadError}
 */
export async function uploadImageToST({ base64, format, folder = '', filename = '' }) {
    let h;
    try {
        h = headers();
    } catch {
        throw new ImageUploadError(uploadErrorText(0), 0);
    }
    const body = { image: base64, format };
    if (folder) body.ch_name = folder;
    if (filename) body.filename = filename;
    let res;
    try {
        res = await fetch('/api/images/upload', { method: 'POST', headers: h, body: JSON.stringify(body) });
    } catch {
        throw new ImageUploadError(uploadErrorText(0), 0);
    }
    if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new ImageUploadError(uploadErrorText(res.status, typeof data?.error === 'string' ? data.error : ''), res.status);
    }
    const data = await res.json().catch(() => null);
    if (typeof data?.path !== 'string' || !data.path) throw new ImageUploadError('酒馆没有返回图片的保存路径', res.status);
    return data.path;
}

export function toast(type, message, title = 'NovelLoom') {
    const t = globalThis.toastr;
    if (t?.[type]) t[type](message, title);
    else console.log(`[NovelLoom] ${type}: ${message}`);
}
