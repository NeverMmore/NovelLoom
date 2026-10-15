// 用户画像：保存用户的口味（偏好的导向、喜欢的元素、雷点、尺度、{{user}} 的默认形象、叙事偏好、其他说明），写卡时量身定制。
//   1) 画像存在扩展设置 settings.userProfiles（跨项目共用，导入配置时按 id 合并）；最多一个默认画像（写卡表单默认选它）；
//   2) 写卡时选一个画像 → 卡片记下快照 card.userProfile = {id, name, likes, dislikes, intensity, persona, style, notes, orientations, chatEntry}，
//      之后改画像不影响已生成的卡；单字段重roll、整卡重新生成都用这份快照；
//   3) 写卡提示词里加「为这位用户量身定制」一节（{USER_PROFILE}），状态栏变量表提示词里加简短的「用户偏好」一节；
//   4) 快照的 chatEntry 开着时，卡自己的世界书里多一个常驻条目「用户偏好」（固定文字，不由 AI 写），排在「剧情导向」之后，
//      见 publish.js 的 cardExtraEntries。
// 所有提示词与条目都写明：涉及恋爱或亲密内容的人物（包括 {{user}}）都是成年人。内置的标签建议里没有未成年属性的标签。
// 雷点与本次「卡的导向」同名时（比如雷点里有 NTR、却选了 NTR 导向）以卡的导向为准，这一项雷点不写进提示词和条目（见 effectiveDislikes）。
// 不碰 DOM、不调用 AI。

import { ORIENTATION_DEFAULTS, getOrientationTemplate, listOrientationTemplates, normalizeCardOrientation } from './orientation.js';
import { uid } from './utils.js';

/** 导出文件的 type */
export const USER_PROFILE_FILE_TYPE = 'novel_loom_user_profiles';

/** 长度上限：名称、单个标签的字数，每类标签的个数，文字说明（形象 / 叙事偏好 / 其他）的字数 */
export const USER_PROFILE_LIMITS = { name: 20, tag: 12, tags: 40, text: 1000, orientations: 20 };

/** 尺度：label 是界面上的名字；card 写进写卡提示词，chat 写进「用户偏好」条目，status 写进状态栏变量表提示词 */
export const USER_PROFILE_INTENSITIES = [
    {
        value: 'sfw',
        label: '清水',
        hint: '感情止于心动、牵手和拥抱，不写性内容。',
        card: '清水——感情止于心动、牵手和拥抱，不写性内容，也不写带挑逗意味的身体描写。',
        chat: '清水——感情止于心动、牵手和拥抱，不写性内容。',
    },
    {
        value: 'suggestive',
        label: '暧昧擦边',
        hint: '可以暧昧、调情，有身体接触的张力，点到为止。',
        card: '暧昧擦边——可以有暧昧、调情和身体接触带来的张力，点到为止，不写露骨的性描写。',
        chat: '暧昧擦边——可以暧昧、调情，有身体接触的张力，点到为止，不写露骨的性描写。',
    },
    {
        value: 'explicit',
        label: '可以露骨',
        hint: '亲密场面可以直接、具体地描写（只在成年人之间）。',
        card: '可以露骨——亲密场面可以直接、具体地描写，但要贴合人物和两人当下的关系，不为写而写。',
        chat: '可以露骨——亲密场面可以直接、具体地描写，但要贴合人物和当下的关系。',
    },
];
export const USER_PROFILE_DEFAULT_INTENSITY = 'suggestive';

/**
 * 内置的标签建议（只是可以点选的标签，用户可以输入任何自定义标签）。
 * kind：likes = 「喜欢」下面的建议，dislikes = 「雷点」下面的建议。不含未成年属性的标签。
 */
export const USER_PROFILE_TAG_GROUPS = [
    { name: '角色属性', kind: 'likes', tags: ['傲娇', '病娇', '三无', '元气', '温柔', '高冷', '御姐', '人妻', '青梅竹马', '女仆', '大小姐', '学姐', '女上司', '腹黑', '天然呆', '小恶魔', '强势', '反差'] },
    { name: '外形与服饰', kind: 'likes', tags: ['黑丝', '白丝', '丝袜', '制服', '职业装', '旗袍', '眼镜', '长发', '双马尾', '兽耳', '异色瞳', '高挑', '娇小', '丰满', '肌肉'] },
    { name: '癖好与偏好', kind: 'likes', tags: ['足控', '腿控', '手控', '声控', '气味', '恋物', '支配', '臣服', '调教', '暧昧拉扯', '慢热', '主动', '被动', '甜宠', '反差萌'] },
    { name: '常见雷点', kind: 'dislikes', tags: ['NTR', '背叛', '死亡', '血腥', '虐待', '怀孕', '多人', '后宫', '绿帽', '强迫'] },
];

/** 成年人一条里 {{user}} 的那半句：{{user}} 也是亲密内容里的一方，形象或身份写了未成年的年龄时不能照写 */
const USER_ADULT_CLAUSE = '{{user}} 的形象或身份里写了未满 18 岁的年龄时，把 {{user}} 写成成年人，或者不让 {{user}} 进入恋爱和亲密内容。';
/** 写卡提示词与条目里固定的最后一条：成年人（明确包括 {{user}}） */
export const USER_PROFILE_ADULT_LINE = `所有涉及恋爱或亲密内容的人物（包括 {{user}}）都是成年人（18 岁以上）：原著里未成年的角色不写进恋爱或亲密内容，年龄不明的一律按成年人来写；${USER_ADULT_CLAUSE}`;
/** 原创写卡（没有原著）时的成年人一条 */
export const USER_PROFILE_ADULT_LINE_ORIGINAL = `所有涉及恋爱或亲密内容的人物（包括 {{user}}）都是成年人（18 岁以上）：设定里未成年的角色不写进恋爱或亲密内容，年龄没有交代的一律写成成年人；${USER_ADULT_CLAUSE}`;
/** 「用户偏好」条目的标题（备注） */
export const USER_PROFILE_ENTRY_TITLE = '用户偏好';

function isObj(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function cleanText(v, max) {
    return String(v ?? '').replace(/\r\n?/g, '\n').trim().slice(0, max);
}

/** 名字 / 标签比较：去掉空白、不分大小写 */
function key(s) {
    return String(s ?? '').replace(/\s+/g, '').toLowerCase();
}

/**
 * 规整标签列表：数组或用逗号 / 顿号 / 换行分隔的字符串；去掉首尾空白和开头的 #，每个最多 12 字，去重（不分大小写），最多 40 个。
 * @returns {string[]}
 */
export function normalizeProfileTags(v) {
    const raw = Array.isArray(v) ? v : typeof v === 'string' ? v.split(/[,，、;；\n]/) : [];
    const out = [];
    const seen = new Set();
    for (const x of raw) {
        if (isObj(x) || Array.isArray(x)) continue;
        const t = String(x ?? '').replace(/^[#＃]+/, '').replace(/\s+/g, ' ').trim().slice(0, USER_PROFILE_LIMITS.tag).trim();
        if (!t || seen.has(key(t))) continue;
        seen.add(key(t));
        out.push(t);
        if (out.length >= USER_PROFILE_LIMITS.tags) break;
    }
    return out;
}

function intensityValue(v) {
    return USER_PROFILE_INTENSITIES.some((x) => x.value === v) ? v : USER_PROFILE_DEFAULT_INTENSITY;
}

export function intensityInfo(v) {
    return USER_PROFILE_INTENSITIES.find((x) => x.value === intensityValue(v));
}

/** 偏好的导向：模板 id 列表（去重，最多 20 个；这里不检查是否还存在，用的时候再丢掉已经删掉的） */
function orientationIds(v) {
    const list = Array.isArray(v) ? v : [];
    const out = [];
    for (const x of list) {
        const id = String(isObj(x) ? x.id ?? '' : x ?? '').trim();
        if (!id || out.includes(id)) continue;
        out.push(id);
        if (out.length >= USER_PROFILE_LIMITS.orientations) break;
    }
    return out;
}

/**
 * 规整一个画像的内容（不含 id / 时间）。名称为空时用 fallbackName。
 * 同一个标签同时在「喜欢」和「雷点」里时只留在雷点里（宁可避开）。
 * @returns {{name, isDefault, orientations, likes, dislikes, intensity, persona, style, notes, chatEntry}}
 */
export function normalizeUserProfile(raw, { fallbackName = '' } = {}) {
    const p = isObj(raw) ? raw : {};
    const dislikes = normalizeProfileTags(p.dislikes);
    const bad = new Set(dislikes.map(key));
    return {
        name: cleanText(p.name, USER_PROFILE_LIMITS.name) || cleanText(fallbackName, USER_PROFILE_LIMITS.name),
        isDefault: p.isDefault === true,
        orientations: orientationIds(p.orientations),
        likes: normalizeProfileTags(p.likes).filter((t) => !bad.has(key(t))),
        dislikes,
        intensity: intensityValue(p.intensity),
        persona: cleanText(p.persona, USER_PROFILE_LIMITS.text),
        style: cleanText(p.style, USER_PROFILE_LIMITS.text),
        notes: cleanText(p.notes, USER_PROFILE_LIMITS.text),
        chatEntry: p.chatEntry !== false,
    };
}

/** 规整存进设置的一个画像（含 id / 时间）；不是对象时返回 null */
export function normalizeStoredUserProfile(raw) {
    if (!isObj(raw)) return null;
    const p = normalizeUserProfile(raw, { fallbackName: '未命名画像' });
    const id = /^uprof_[\w-]+$/.test(String(raw.id || '')) ? String(raw.id) : uid('uprof_');
    const now = Date.now();
    return { id, ...p, createdAt: Number(raw.createdAt) || now, updatedAt: Number(raw.updatedAt) || now };
}

function storedList(settings) {
    if (!Array.isArray(settings.userProfiles)) settings.userProfiles = [];
    return settings.userProfiles;
}

/** 列表里最多一个默认画像：只保留第一个（就地修改，返回同一个数组） */
function keepSingleDefault(list) {
    let seen = false;
    for (const p of list) {
        if (!isObj(p) || p.isDefault !== true) continue;
        if (seen) p.isDefault = false;
        seen = true;
    }
    return list;
}

/** 全部画像（规整后的副本，跳过不合法的项与重复 id；最多一个默认） */
export function listUserProfiles(settings) {
    const list = Array.isArray(settings?.userProfiles) ? settings.userProfiles : [];
    const seen = new Set();
    const out = [];
    for (const raw of list) {
        if (!isObj(raw) || !raw.id || seen.has(String(raw.id))) continue;
        seen.add(String(raw.id));
        out.push({ id: String(raw.id), ...normalizeUserProfile(raw, { fallbackName: '未命名画像' }), createdAt: raw.createdAt || 0, updatedAt: raw.updatedAt || 0 });
    }
    return keepSingleDefault(out);
}

export function getUserProfile(settings, id) {
    if (!id) return null;
    return listUserProfiles(settings).find((p) => p.id === id) || null;
}

/** 默认画像；没有时返回 null */
export function defaultUserProfile(settings) {
    return listUserProfiles(settings).find((p) => p.isDefault) || null;
}

/** 在现有画像名里找一个不重复的名字（「名字」「名字 2」…） */
export function uniqueUserProfileName(settings, base, exceptId = '') {
    const b = cleanText(base, USER_PROFILE_LIMITS.name) || '我的画像';
    const taken = new Set(listUserProfiles(settings).filter((p) => p.id !== exceptId).map((p) => key(p.name)));
    if (!taken.has(key(b))) return b;
    for (let i = 2; i < 1000; i++) {
        const suffix = ` ${i}`;
        const n = `${b.slice(0, USER_PROFILE_LIMITS.name - suffix.length)}${suffix}`;
        if (!taken.has(key(n))) return n;
    }
    return `${b.slice(0, USER_PROFILE_LIMITS.name - 6)} ${Date.now() % 100000}`;
}

/** 名称有什么问题（空 / 与其他画像重名），没问题返回 '' */
export function userProfileNameProblem(settings, name, exceptId = '') {
    const n = cleanText(name, USER_PROFILE_LIMITS.name);
    if (!n) return '名称不能为空';
    if (listUserProfiles(settings).some((p) => p.id !== exceptId && key(p.name) === key(n))) return '已经有同名的画像';
    return '';
}

/** 设为默认（id 为空 = 取消默认）：其他画像的默认标记同时去掉 */
export function setDefaultUserProfile(settings, id) {
    for (const p of storedList(settings)) {
        if (!isObj(p)) continue;
        const on = !!id && p.id === id;
        if (p.isDefault !== on) p.isDefault = on;
    }
}

/** 新建画像；重名时抛错。isDefault 为 true 时其他画像不再是默认 */
export function addUserProfile(settings, data = {}) {
    const p = normalizeUserProfile(data);
    const problem = userProfileNameProblem(settings, p.name);
    if (problem) throw new Error(problem);
    const now = Date.now();
    const item = { id: uid('uprof_'), ...p, createdAt: now, updatedAt: now };
    if (item.isDefault) setDefaultUserProfile(settings, '');
    storedList(settings).push(item);
    return item;
}

const FIELDS = ['name', 'isDefault', 'orientations', 'likes', 'dislikes', 'intensity', 'persona', 'style', 'notes', 'chatEntry'];

/** 修改画像（patch 里出现的字段才改）；改名改成空名或重名时抛错，找不到返回 null */
export function updateUserProfile(settings, id, patch = {}) {
    const list = storedList(settings);
    const i = list.findIndex((x) => isObj(x) && x.id === id);
    if (i < 0) return null;
    const cur = list[i];
    const merged = normalizeUserProfile({
        ...Object.fromEntries(FIELDS.map((k) => [k, cur[k]])),
        ...Object.fromEntries(FIELDS.filter((k) => patch[k] !== undefined).map((k) => [k, patch[k]])),
    });
    // 只在名称真的改了时检查（导入配置后可能已经有重名的画像，不能因此改不了别的字段）
    if (key(merged.name) !== key(cur.name)) {
        const problem = userProfileNameProblem(settings, merged.name, id);
        if (problem) throw new Error(problem);
    }
    const next = { ...cur, ...merged, id, createdAt: cur.createdAt || Date.now(), updatedAt: Date.now() };
    list[i] = next;
    if (patch.isDefault !== undefined) setDefaultUserProfile(settings, next.isDefault ? id : (list.find((x) => isObj(x) && x.isDefault)?.id || ''));
    return next;
}

/** 删除画像；不存在返回 false */
export function removeUserProfile(settings, id) {
    if (!Array.isArray(settings?.userProfiles)) return false;
    const n = settings.userProfiles.length;
    settings.userProfiles = settings.userProfiles.filter((p) => p?.id !== id);
    return settings.userProfiles.length !== n;
}

/** 复制画像（副本不是默认），名字自动避开重名 */
export function duplicateUserProfile(settings, id) {
    const src = getUserProfile(settings, id);
    if (!src) return null;
    return addUserProfile(settings, { ...src, isDefault: false, name: uniqueUserProfileName(settings, `${src.name} 副本`) });
}

/** 偏好的导向里还存在的模板（内置 + 我的模板）：[{id, name}]；已经删掉的模板悄悄丢掉 */
export function profileOrientations(settings, profile) {
    const out = [];
    for (const id of orientationIds(profile?.orientations)) {
        const t = getOrientationTemplate(settings, id);
        if (t) out.push({ id: t.id, name: t.name });
    }
    return out;
}

/** 这个名字（导向名）是不是画像里的雷点（不分大小写、去掉空白比较；画像可以是设置里的画像或卡片快照） */
export function isDislikedName(profile, name) {
    const k = key(name);
    return !!k && normalizeProfileTags(profile?.dislikes).some((t) => key(t) === k);
}

/**
 * 实际要避开的雷点：去掉与本次「卡的导向」同名的那一项（用户既然选了这个导向，这张卡以卡的导向为准）。
 * @param {object|null} profile 设置里的画像或卡片快照
 * @param {string} orientationName 本次卡的导向的名称（没有导向时为 ''）
 * @returns {{dislikes: string[], overridden: string[]}} overridden：因为与卡的导向同名而不适用的雷点
 */
export function effectiveDislikes(profile, orientationName = '') {
    const all = normalizeProfileTags(profile?.dislikes);
    const k = key(orientationName);
    if (!k) return { dislikes: all, overridden: [] };
    return { dislikes: all.filter((t) => key(t) !== k), overridden: all.filter((t) => key(t) === k) };
}

/** 偏好的导向里同时又在雷点里的（画像自相矛盾，多半是点错了）：[{id, name}] */
export function orientationConflicts(settings, profile) {
    return profileOrientations(settings, profile).filter((o) => isDislikedName(profile, o.name));
}

/**
 * 写卡表单「按画像选导向」的快捷按钮：选了画像、画像里有偏好的导向（还存在的），而且表单里的卡的导向是「不限」时才给；
 * 只给按钮，不替用户改导向。同时也在雷点里的导向不给（不把雷点当推荐）。
 * @param {object} settings
 * @param {object|null} profile 设置里的画像（或快照）
 * @param {string} orientationId 表单里当前的导向（'' = 不限）
 * @returns {{id: string, name: string}[]}
 */
export function profileOrientationPicks(settings, profile, orientationId = '') {
    if (!profile || orientationId) return [];
    return profileOrientations(settings, profile).filter((o) => !isDislikedName(profile, o.name));
}

// ---------------- 导入导出 ----------------

/** 导出用的 JSON（一个或多个画像；不含 id、默认标记与时间；偏好的导向另附名字，换一台电脑导入时按名字找回） */
export function exportUserProfiles(settings, list) {
    const items = (Array.isArray(list) ? list : [list]).filter(Boolean).map((raw) => {
        const p = normalizeUserProfile(raw);
        delete p.isDefault;
        // 只导出还存在的导向，id 与名字一一对应
        const os = profileOrientations(settings, p);
        return { ...p, orientations: os.map((o) => o.id), orientationNames: os.map((o) => o.name) };
    });
    return { type: USER_PROFILE_FILE_TYPE, version: 1, profiles: items };
}

export function userProfileFileName(list) {
    const items = Array.isArray(list) ? list : [list];
    const one = items.length === 1 ? cleanText(items[0]?.name, USER_PROFILE_LIMITS.name) : '';
    return one ? `${one.replace(/[\\/:*?"<>|]/g, '_')}.用户画像.json` : '用户画像.json';
}

/** 导入的偏好导向：id 在本机存在就用；不存在时按导出时附带的名字找同名模板 */
function resolveImportedOrientations(settings, raw, ids) {
    const names = Array.isArray(raw?.orientationNames) ? raw.orientationNames.map((n) => key(n)) : [];
    const out = [];
    ids.forEach((id, i) => {
        let t = getOrientationTemplate(settings, id);
        if (!t && names[i]) t = profileOrientationByName(settings, names[i]);
        if (t && !out.includes(t.id)) out.push(t.id);
    });
    // 只有名字没有 id（手写的文件）
    if (!ids.length) {
        for (const n of names) {
            const t = profileOrientationByName(settings, n);
            if (t && !out.includes(t.id)) out.push(t.id);
        }
    }
    return out;
}

/** 按名字（不分大小写、去掉空白）找导向模板（内置 + 我的模板） */
function profileOrientationByName(settings, nameKey) {
    return listOrientationTemplates(settings).find((t) => key(t.name) === nameKey) || null;
}

/**
 * 解析导入的 JSON（文本或对象）：本插件的画像文件 {type, profiles:[…]}、画像数组、或单个画像对象。
 * @returns {object[]} 规整后的画像内容（没有 id、不是默认）
 * @throws {Error} 认不出格式或一个可用的画像都没有时
 */
export function parseUserProfiles(input, settings = null) {
    let json = input;
    if (typeof json === 'string') {
        try {
            json = JSON.parse(json.trim());
        } catch {
            throw new Error('文件不是有效的 JSON');
        }
    }
    let list;
    if (Array.isArray(json)) list = json;
    else if (isObj(json) && Array.isArray(json.profiles)) list = json.profiles;
    else if (isObj(json) && Array.isArray(json.userProfiles)) list = json.userProfiles;
    else if (isObj(json) && json.name !== undefined && (json.likes !== undefined || json.dislikes !== undefined || json.persona !== undefined || json.intensity !== undefined)) list = [json];
    else throw new Error('不是 NovelLoom 用户画像文件');
    const out = list.filter(isObj).map((raw) => {
        const p = normalizeUserProfile(raw);
        p.isDefault = false;
        if (settings) p.orientations = resolveImportedOrientations(settings, raw, p.orientations);
        return p;
    }).filter((p) => p.name);
    if (!out.length) throw new Error('文件里没有可用的用户画像（需要名称）');
    return out;
}

/** 导入并保存（每个都是新的画像，重名时自动改名，都不是默认）；返回新建的画像 */
export function importUserProfiles(settings, input) {
    return parseUserProfiles(input, settings).map((p) => addUserProfile(settings, { ...p, name: uniqueUserProfileName(settings, p.name) }));
}

/**
 * 导入配置时合并画像：按 id 覆盖本机同 id 的、追加没有的（与导向模板同一口径），逐个规整。
 * 导入的配置里有默认画像时以导入的为准（本机其他画像不再是默认）；最后保证最多一个默认。
 * @returns {object[]} 合并后的列表（也写回 settings.userProfiles）
 */
export function mergeUserProfiles(settings, incoming) {
    const cur = Array.isArray(settings.userProfiles) ? settings.userProfiles : [];
    let incomingDefault = '';
    for (const raw of Array.isArray(incoming) ? incoming : []) {
        if (!isObj(raw) || !raw.id) continue;
        const item = normalizeStoredUserProfile(raw);
        if (!item || item.id !== raw.id) continue;
        if (item.isDefault && !incomingDefault) incomingDefault = item.id;
        const i = cur.findIndex((x) => x?.id === item.id);
        if (i >= 0) cur[i] = item;
        else cur.push(item);
    }
    settings.userProfiles = cur;
    if (incomingDefault) setDefaultUserProfile(settings, incomingDefault);
    keepSingleDefault(cur);
    return cur;
}

// ---------------- 写卡时的画像（卡片快照） ----------------

/**
 * 设置里的画像 → 卡片快照；找不到画像时返回 null。偏好的导向记成 [{id, name}]（只留还存在的模板）。
 * @param {object} settings
 * @param {string|object} profile 画像 id 或画像对象
 * @param {{chatEntry?: boolean}} opt chatEntry：这次写卡是否加「用户偏好」条目（不给时用画像自己的设置）
 */
export function userProfileSnapshot(settings, profile, { chatEntry } = {}) {
    const p = typeof profile === 'string' ? getUserProfile(settings, profile) : isObj(profile) ? profile : null;
    if (!p) return null;
    const n = normalizeUserProfile(p, { fallbackName: '未命名画像' });
    return normalizeCardUserProfile({
        id: String(p.id || ''),
        name: n.name,
        likes: n.likes,
        dislikes: n.dislikes,
        intensity: n.intensity,
        persona: n.persona,
        style: n.style,
        notes: n.notes,
        orientations: profileOrientations(settings, n),
        chatEntry: chatEntry === undefined ? n.chatEntry : chatEntry !== false,
    });
}

/** 规整卡片上的画像快照；没有画像时返回 null */
export function normalizeCardUserProfile(raw) {
    if (!isObj(raw)) return null;
    const n = normalizeUserProfile({ ...raw, orientations: [] }, { fallbackName: '用户画像' });
    const orientations = [];
    for (const o of Array.isArray(raw.orientations) ? raw.orientations : []) {
        const name = cleanText(isObj(o) ? o.name : o, 20);
        if (!name || orientations.some((x) => key(x.name) === key(name))) continue;
        orientations.push({ id: String(isObj(o) ? o.id ?? '' : ''), name });
        if (orientations.length >= USER_PROFILE_LIMITS.orientations) break;
    }
    return {
        id: String(raw.id ?? ''),
        name: n.name,
        likes: n.likes,
        dislikes: n.dislikes,
        intensity: n.intensity,
        persona: n.persona,
        style: n.style,
        notes: n.notes,
        orientations,
        chatEntry: n.chatEntry,
    };
}

/** 快照和设置里同 id 的画像内容是否不同（画像页改过之后）；画像已经删掉时返回 false */
export function userProfileSnapshotOutdated(settings, snapshot) {
    const s = normalizeCardUserProfile(snapshot);
    if (!s?.id) return false;
    const fresh = userProfileSnapshot(settings, s.id, { chatEntry: s.chatEntry });
    if (!fresh) return false;
    return JSON.stringify(fresh) !== JSON.stringify(s);
}

function listText(tags) {
    return tags.join('、');
}

/**
 * 写卡提示词里的「为这位用户量身定制」一节（含标题，前后不带空行）；没有画像时为 ''。空的项不写。
 * @param {object|null} profile 卡片快照（或 userProfileSnapshot 的结果）
 * @param {{orientation?: boolean, orientationName?: string, userRoleKind?: string, original?: boolean}} opt
 *   orientation：本次选了卡的导向（偏好的导向只作参考，以卡的导向为准）；
 *   orientationName：本次卡的导向的名称——雷点里与它同名的一项不适用（以卡的导向为准，并写明这一点，免得 AI 收到两条相反的要求）；
 *   userRoleKind：「{{user}} 扮演」的方式，只有原创新身份（new）时才写 {{user}} 的默认形象；
 *   original：原创写卡（没有原著：偏好与用户的设定冲突时以设定为准，成年人一条也按设定说）
 */
export function userProfilePromptBlock(profile, { orientation = false, orientationName = '', userRoleKind = 'new', original = false } = {}) {
    const p = normalizeCardUserProfile(profile);
    if (!p) return '';
    const { dislikes, overridden } = effectiveDislikes(p, orientationName);
    // 偏好的导向里同时又是雷点的不列（画像自相矛盾时不把雷点当偏好推荐）
    const preferred = p.orientations.filter((o) => !isDislikedName(p, o.name));
    const lines = [
        '# 为这位用户量身定制',
        '这张卡写给一位口味明确的用户。把下面的偏好化进卡里，让 TA 一读就觉得“懂我”，而不是把偏好贴在卡上。',
    ];
    if (p.likes.length) lines.push(`- 喜欢的元素：${listText(p.likes)}。挑和这个角色、${original ? '这个设定' : '这本书'}相称的，自然融入角色的外貌、服饰、性格、习惯、场景、开场白和示例对话（比如变成角色的穿着习惯、小动作、口头禅，或两人相处的契机）；不要生硬罗列，也不要每句话都提，不必每一样都用上。`);
    if (dislikes.length) lines.push(`- 雷点（一律避免）：${listText(dislikes)}。卡片的任何字段都不出现这些内容，连暗示、伏笔和可能的发展方向都不要留。`);
    if (overridden.length) lines.push(`- 雷点里的「${overridden[0]}」就是本次「卡的导向」：这张卡以卡的导向为准，这一项雷点不适用。`);
    lines.push(`- 尺度：${intensityInfo(p.intensity).card}`);
    // 叙事偏好跟着这张卡选的画像走，「文风」是整个项目的（常常是从原著提取的）：视角和写法冲突时以这里为准
    if (p.style) lines.push(`- 叙事偏好：${p.style}。开场白、备选开场白和示例对话按这个写；与「文风」一节的视角或写法冲突时以这里为准，「文风」里其余的要求照常执行。用第二人称“你”时只写“你”看到、听到、感觉到的，仍不替“你”说话、行动或做决定。`);
    if (preferred.length) {
        lines.push(`- 偏好的导向：${listText(preferred.map((o) => o.name))}。${orientation
            ? '仅作参考：本次已经选了「卡的导向」，以卡的导向为准。'
            : '仅作参考：可以在人物关系和开场白里为这些方向留出余地，不改变人物的底色。'}`);
    }
    if (p.persona && userRoleKind === 'new') lines.push(`- {{user}} 的默认形象：${p.persona}。{{user}} 以原创新身份出现（{{user}} 是成年人），按这个形象安排 {{user}} 的身份、外貌和与 {{char}} 的切入关系；「用户要求」里另写了 {{user}} 的身份时以「用户要求」为准。`);
    if (p.notes) lines.push(`- 其他：${p.notes}`);
    lines.push(original
        ? '- 偏好与用户的原创设定冲突时：设定里写明的以设定为准，偏好体现在设定没写到、可以发挥的地方（穿着、习惯、场景、相处方式）；「用户要求」与这里冲突时以「用户要求」为准。'
        : '- 偏好与原著冲突时：人物的底色、关键经历和关系以原著为准，偏好体现在可以发挥的地方（穿着、习惯、场景、相处方式）；「用户要求」与这里冲突时以「用户要求」为准。');
    lines.push(`- ${original ? USER_PROFILE_ADULT_LINE_ORIGINAL : USER_PROFILE_ADULT_LINE}`);
    return lines.join('\n');
}

/**
 * 状态栏变量表提示词里的「用户偏好」一节（简短：喜欢的元素里值得追踪的做成变量，雷点不出现）；没有画像时为 ''。
 * @param {object|null} profile 卡片快照
 * @param {{orientationName?: string}} opt orientationName：这张卡的导向名称（雷点里与它同名的一项不适用，见 effectiveDislikes）
 */
export function userProfileStatusText(profile, { orientationName = '' } = {}) {
    const p = normalizeCardUserProfile(profile);
    if (!p) return '';
    const { dislikes } = effectiveDislikes(p, orientationName);
    const lines = ['# 用户偏好', '这张卡是为一位口味明确的用户写的，变量设计可以照顾 TA 的偏好：'];
    if (p.likes.length) lines.push(`- 喜欢的元素：${listText(p.likes)}。其中能在扮演中变化、值得追踪的，可以做成变量或记录里的字段（例如 足控、丝袜 → 服饰里的袜子和鞋子；制服 → 当前着装；支配、臣服 → 主导权或服从度）；和这张卡无关的不用硬加，也不要为了凑偏好超出变量上限。`);
    if (dislikes.length) lines.push(`- 雷点（一律避免）：${listText(dislikes)}。不设计与这些内容有关的变量，desc 和 check 里也不要出现。`);
    lines.push(`- 尺度：${intensityInfo(p.intensity).label}。变量名、desc 和 check 都不超出这个尺度。`);
    lines.push('- 所有涉及恋爱或亲密内容的人物（包括 {{user}}）都是成年人（18 岁以上）。');
    return lines.join('\n');
}

/**
 * 「重新生成本书落点」提示词里的 {USER_PROFILE_LINE}：画像的雷点（与卡的导向同名的不算）和成年人一条，每行以「- 」开头、末尾带换行；
 * 没有画像时为 ''（提示词与以前一字不差）。
 * @param {object|null} profile 卡片快照
 * @param {{orientationName?: string, original?: boolean, adult?: boolean}} opt adult=false：模板里已经写了成年人一条（原创卡的模板）
 */
export function userProfileNotesLines(profile, { orientationName = '', original = false, adult = true } = {}) {
    const p = normalizeCardUserProfile(profile);
    if (!p) return '';
    const { dislikes } = effectiveDislikes(p, orientationName);
    const lines = [];
    if (dislikes.length) lines.push(`- 雷点（一律避免）：${listText(dislikes)}。落点里不出现这些内容，连暗示和可能的发展方向都不要留。`);
    if (adult) lines.push(`- ${original ? USER_PROFILE_ADULT_LINE_ORIGINAL : USER_PROFILE_ADULT_LINE}`);
    return lines.length ? `${lines.join('\n')}\n` : '';
}

/**
 * 「用户偏好」条目的正文（固定文字，不由 AI 写）；没有画像时为 ''。
 * @param {object|null} profile 卡片快照
 * @param {{orientationName?: string}} opt orientationName：这张卡的导向名称——与它同名的雷点不写进「绝对避免」
 *   （否则聊天的 AI 每一轮同时收到「剧情导向：NTR」和「绝对避免：NTR」两条相反的常驻要求）
 */
export function userProfileEntryContent(profile, { orientationName = '' } = {}) {
    const p = normalizeCardUserProfile(profile);
    if (!p) return '';
    const { dislikes } = effectiveDislikes(p, orientationName);
    return [
        `【${USER_PROFILE_ENTRY_TITLE}】`,
        p.likes.length ? `聊天时照顾 {{user}} 的偏好：${listText(p.likes)}。在合适的时候自然地带出来（角色的穿着、小动作、对话和场景），不要每次回复都提，也不要生硬堆砌。` : '',
        dislikes.length ? `绝对避免：${listText(dislikes)}。不写这些内容，也不把剧情往这些方向引。` : '',
        `尺度：${intensityInfo(p.intensity).chat}`,
        p.style ? `叙事偏好：${p.style}。` : '',
        '所有涉及恋爱或亲密内容的人物（包括 {{user}}）都是成年人。',
    ].filter(Boolean).join('\n');
}

/** 这张卡要不要在自己的世界书里加「用户偏好」条目（选了画像且 chatEntry 开着） */
export function userProfileHasEntry(card) {
    const p = normalizeCardUserProfile(card?.userProfile);
    return !!p && p.chatEntry;
}

/**
 * 卡片自己的世界书里的「用户偏好」逻辑条目（见 worldbook.js 的条目字段）；没有画像或关掉了 chatEntry 时返回 null。
 * 常驻、@深度 4、系统角色；顺序比「剧情导向」小 1（同一深度里排在剧情导向前面，剧情导向更靠近最新消息、优先）；不参与递归。
 */
export function userProfileEntry(card) {
    if (!userProfileHasEntry(card)) return null;
    const o = normalizeCardOrientation(card?.orientation);
    const order = (o ? o.order : ORIENTATION_DEFAULTS.order) - 1;
    return {
        category: '偏好', name: USER_PROFILE_ENTRY_TITLE, comment: USER_PROFILE_ENTRY_TITLE, keywords: [], content: userProfileEntryContent(card.userProfile, { orientationName: o?.name || '' }),
        constant: true, position: 4, depth: 4, role: 0, order, disable: false,
        excludeRecursion: true, preventRecursion: true,
    };
}

/**
 * 一行摘要（写卡表单、画像列表、编辑框里显示）：喜欢 / 雷点 / 尺度 / 叙事。
 * @param {object|null} profile 设置里的画像或快照
 * @param {{max?: number}} opt max：每类最多列几个标签
 */
export function userProfileSummary(profile, { max = 4 } = {}) {
    if (!profile) return '';
    const p = normalizeUserProfile(profile);
    const few = (tags) => (tags.length > max ? `${tags.slice(0, max).join('、')} 等 ${tags.length} 项` : tags.join('、'));
    return [
        p.likes.length ? `喜欢 ${few(p.likes)}` : '',
        p.dislikes.length ? `雷点 ${few(p.dislikes)}` : '',
        `尺度 ${intensityInfo(p.intensity).label}`,
        p.style ? `叙事 ${p.style.length > 16 ? `${p.style.slice(0, 16)}…` : p.style}` : '',
    ].filter(Boolean).join(' · ');
}
