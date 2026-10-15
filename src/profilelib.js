// 用户画像的常用库：画像里的每一项都可以添加自己的选项并保存，所有画像共用（存在扩展设置 settings.profileLibrary，跨项目）。
//   - 标签分组（「喜欢」「雷点」下面的建议）：内置分组在代码里（USER_PROFILE_TAG_GROUPS），库里只存「加进内置分组的自定义标签」和
//     「隐藏的内置标签」，读的时候合并——插件更新时新增的内置标签照样出现；自定义分组（名称 + 用在 喜欢 / 雷点）整个存在库里；
//   - 尺度：内置三档在代码里，库里存自定义尺度 {id, name, desc}，desc 代替内置的说明写进写卡提示词与「用户偏好」条目；
//   - 叙事偏好的建议：内置建议在代码里，库里存自定义建议与隐藏的内置建议（与标签分组同一套：一个 id 为 'style' 的分组）；
//   - 常用文字：{{user}} 的默认形象（persona）/ 其他（notes）的常用片段 {id, field, name, text}，可以插入或替换。
// 库的形状：{ groups: [{id, tags, hidden}（内置分组） | {id:'ugrp_…', name, target, tags}（自定义分组）],
//            intensities: [{id:'uint_…', name, desc}], style: {tags, hidden}, snippets: [{id:'usnip_…', field, name, text}] }
// 内置的标签与建议里没有未成年属性的词。用户自己加的是用户自己的文字；所有提示词里「成年人」一条不受影响（见 userprofile.js）。
// 不碰 DOM、不调用 AI。

import { uid } from './utils.js';

/** 常用库的上限 */
export const PROFILE_LIBRARY_LIMITS = {
    /** 标签字数 */
    tag: 12,
    /** 每个分组最多几个自定义标签（内置标签不算） */
    groupTags: 60,
    /** 自定义分组个数 */
    groups: 30,
    groupName: 10,
    intensities: 20,
    intensityName: 8,
    intensityDesc: 200,
    /** 叙事偏好一项的字数（比标签长：「多写环境和感官细节」这样的短句） */
    styleTag: 20,
    styleTags: 60,
    /** 每一种文字（形象 / 其他）最多几段常用文字 */
    snippets: 50,
    snippetName: 20,
    snippetText: 1000,
};
const L = PROFILE_LIBRARY_LIMITS;

/** 尺度：label 是界面上的名字；card 写进写卡提示词，chat 写进「用户偏好」条目，status 写进状态栏变量表提示词（内置的只写名字） */
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
 * 内置的标签建议（只是可以点选的标签，用户可以输入任何自定义标签，也可以往分组里加自己的常用标签）。
 * kind：likes = 「喜欢」下面的建议，dislikes = 「雷点」下面的建议。id 固定（常用库按 id 记自定义标签与隐藏的内置标签）。不含未成年属性的标签。
 */
export const USER_PROFILE_TAG_GROUPS = [
    { id: 'traits', name: '角色属性', kind: 'likes', tags: ['傲娇', '病娇', '三无', '元气', '温柔', '高冷', '御姐', '人妻', '青梅竹马', '女仆', '大小姐', '学姐', '女上司', '腹黑', '天然呆', '小恶魔', '强势', '反差'] },
    { id: 'looks', name: '外形与服饰', kind: 'likes', tags: ['黑丝', '白丝', '丝袜', '制服', '职业装', '旗袍', '眼镜', '长发', '双马尾', '兽耳', '异色瞳', '高挑', '娇小', '丰满', '肌肉'] },
    { id: 'kinks', name: '癖好与偏好', kind: 'likes', tags: ['足控', '腿控', '手控', '声控', '气味', '恋物', '支配', '臣服', '调教', '暧昧拉扯', '慢热', '主动', '被动', '甜宠', '反差萌'] },
    { id: 'nogo', name: '常见雷点', kind: 'dislikes', tags: ['NTR', '背叛', '死亡', '血腥', '虐待', '怀孕', '多人', '后宫', '绿帽', '强迫'] },
];

/** 叙事偏好的内置建议 */
export const USER_PROFILE_STYLE_SUGGESTIONS = ['第二人称', '第三人称', '细腻心理', '对话多', '环境描写多', '节奏快', '慢热', '简洁', '文艺', '口语化'];

/** 叙事偏好的建议在常用库里当作一个分组：id */
export const STYLE_GROUP_ID = 'style';

/** 常用文字用在哪个字段：field → 字段名 */
export const PROFILE_SNIPPET_FIELDS = { persona: '{{user}} 的默认形象', notes: '其他' };

/** 标签分组用在哪一类 */
export const PROFILE_TAG_TARGETS = { likes: '喜欢的元素', dislikes: '雷点' };

/** 只认自己的键（导入的文件里写 '__proto__'、'constructor' 这样的名字不算） */
const isTarget = (v) => typeof v === 'string' && Object.hasOwn(PROFILE_TAG_TARGETS, v);
const isSnippetField = (v) => typeof v === 'string' && Object.hasOwn(PROFILE_SNIPPET_FIELDS, v);

const CUSTOM_GROUP_RE = /^ugrp_[\w-]{1,40}$/;
/** 自定义尺度的 id */
export const CUSTOM_INTENSITY_RE = /^uint_[\w-]{1,40}$/;
const SNIPPET_RE = /^usnip_[\w-]{1,40}$/;

const BUILTIN_GROUPS = new Map(USER_PROFILE_TAG_GROUPS.map((g) => [g.id, g]));

function isObj(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** 名字 / 标签比较：去掉空白、不分大小写 */
export function libKey(s) {
    return String(s ?? '').replace(/\s+/g, '').toLowerCase();
}
const key = libKey;

/** 一行的短文字（名称、尺度说明）：合并空白（含换行），去首尾空白，截到 max 字 */
function cleanLine(v, max) {
    return String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max).trim();
}

function cleanText(v, max) {
    return String(v ?? '').replace(/\r\n?/g, '\n').trim().slice(0, max);
}

/** 去掉末尾的标点（拼句子时用：「说明」后面统一接「。」） */
export function trimEndPunct(s) {
    return String(s ?? '').replace(/[。．.！!；;，,、\s]+$/u, '');
}

/**
 * 一类里比较标签用的键：叙事偏好的一项末尾的标点不算（存进画像时末尾的标点会去掉，「多写对话。」和「多写对话」是同一项），
 * 喜欢 / 雷点的标签原样比较（只去空白、不分大小写）
 */
export function tagKey(kind, s) {
    return kind === 'style' ? key(trimEndPunct(s)) : key(s);
}

/** 叙事偏好的常用写法：规整后再去掉每项末尾的标点（和画像里存的一致），去重 */
function cleanStyleList(v, count) {
    return cleanTagList(cleanTagList(v, { max: L.styleTag, count: 10000 }).map((t) => trimEndPunct(t)), { max: L.styleTag, count });
}

/** 标签的分隔符：逗号、顿号、分号、换行（全角半角都算） */
export const TAG_SEPARATORS = /[,，、;；\n]/;

/**
 * 规整一串标签：数组或用分隔符隔开的字符串；去掉首尾空白和开头的 #、合并空白，每个最多 max 字，去重（不分大小写），最多 count 个。
 * @returns {string[]}
 */
export function cleanTagList(v, { max = L.tag, count = 40 } = {}) {
    const raw = Array.isArray(v) ? v : typeof v === 'string' ? v.split(TAG_SEPARATORS) : [];
    const out = [];
    const seen = new Set();
    for (const x of raw) {
        if (isObj(x) || Array.isArray(x)) continue;
        const t = String(x ?? '').replace(/^[#＃]+/, '').replace(/\s+/g, ' ').trim().slice(0, max).trim();
        if (!t || seen.has(key(t))) continue;
        seen.add(key(t));
        out.push(t);
        if (out.length >= count) break;
    }
    return out;
}

export function isBuiltinTagGroup(id) {
    return BUILTIN_GROUPS.has(id);
}

export function emptyProfileLibrary() {
    return { groups: [], intensities: [], style: { tags: [], hidden: [] }, snippets: [] };
}

/** 常用文字的默认名称：第一行的前 12 个字 */
export function snippetDefaultName(text) {
    const line = String(text ?? '').split('\n').map((x) => x.trim()).find(Boolean) || '';
    return line.length > 12 ? `${line.slice(0, 12)}…` : line;
}

/** 在 taken（已经用掉的名字的键）里找一个不重复的名字：name、name2、name3……（截到 max 字）；找不到返回 '' */
function uniqueName(name, max, taken) {
    let n = name;
    for (let i = 2; taken.has(key(n)) && i < 100; i++) n = `${name.slice(0, max - String(i).length)}${i}`;
    return taken.has(key(n)) ? '' : n;
}

/**
 * 规整常用库（返回新对象）：不认识的项丢掉、超出上限的截掉、重复的合并；内置分组只留自定义标签与隐藏的内置标签。
 * 自定义分组、自定义尺度的名称不能为空（尺度的说明也不能为空）；和内置的或前面的重名时自动改名（「名称2」）留下，不丢掉。
 */
export function normalizeProfileLibrary(raw) {
    const r = isObj(raw) ? raw : {};
    const groups = [];
    const byId = new Map();
    let customGroups = 0;
    const groupNames = new Set(USER_PROFILE_TAG_GROUPS.map((g) => key(g.name)));
    for (const g of Array.isArray(r.groups) ? r.groups : []) {
        if (!isObj(g)) continue;
        const id = String(g.id ?? '');
        const builtin = BUILTIN_GROUPS.get(id);
        if (builtin) {
            const bkeys = new Set(builtin.tags.map(key));
            let cur = byId.get(id);
            if (!cur) {
                cur = { id, tags: [], hidden: [] };
                byId.set(id, cur);
                groups.push(cur);
            }
            cur.tags = cleanTagList([...cur.tags, ...cleanTagList(g.tags, { count: 10000 })].filter((t) => !bkeys.has(key(t))), { count: L.groupTags });
            const hidden = new Set([...cur.hidden, ...cleanTagList(g.hidden, { count: 10000 })].map(key));
            cur.hidden = builtin.tags.filter((t) => hidden.has(key(t)));
            continue;
        }
        if (customGroups >= L.groups) continue;
        const name = cleanLine(g.name, L.groupName);
        if (!name) continue;
        // 和内置分组（包括插件更新后新增的内置分组）或前面的分组重名：改个名字留下，不丢掉用户的标签
        const n = uniqueName(name, L.groupName, groupNames);
        if (!n) continue;
        const gid = CUSTOM_GROUP_RE.test(id) && !byId.has(id) ? id : uid('ugrp_');
        const target = isTarget(g.target) ? g.target : isTarget(g.kind) ? g.kind : 'likes';
        const item = { id: gid, name: n, target, tags: cleanTagList(g.tags, { count: L.groupTags }) };
        byId.set(gid, item);
        groupNames.add(key(n));
        groups.push(item);
        customGroups++;
    }
    const intensities = [];
    const taken = new Set(USER_PROFILE_INTENSITIES.map((x) => key(x.label)));
    for (const x of Array.isArray(r.intensities) ? r.intensities : []) {
        if (!isObj(x) || intensities.length >= L.intensities) continue;
        const name = cleanLine(x.name, L.intensityName);
        const desc = cleanLine(x.desc, L.intensityDesc);
        if (!name || !desc) continue;
        // 和内置尺度（包括以后新增的）或前面的尺度重名：改个名字留下（id 不变，用它的画像照样认得）
        const n = uniqueName(name, L.intensityName, taken);
        if (!n) continue;
        taken.add(key(n));
        const id = CUSTOM_INTENSITY_RE.test(String(x.id ?? '')) && !intensities.some((y) => y.id === x.id) ? String(x.id) : uid('uint_');
        intensities.push({ id, name: n, desc });
    }
    const st = isObj(r.style) ? r.style : {};
    const skeys = new Set(USER_PROFILE_STYLE_SUGGESTIONS.map(key));
    const styleHidden = new Set(cleanStyleList(st.hidden, 10000).map(key));
    const style = {
        tags: cleanStyleList(st.tags, 10000).filter((t) => !skeys.has(key(t))).slice(0, L.styleTags),
        hidden: USER_PROFILE_STYLE_SUGGESTIONS.filter((t) => styleHidden.has(key(t))),
    };
    const snippets = [];
    for (const s of Array.isArray(r.snippets) ? r.snippets : []) {
        if (!isObj(s) || !isSnippetField(s.field)) continue;
        if (snippets.filter((x) => x.field === s.field).length >= L.snippets) continue;
        const text = cleanText(s.text, L.snippetText);
        if (!text || snippets.some((x) => x.field === s.field && x.text === text)) continue;
        const name = cleanLine(s.name, L.snippetName) || snippetDefaultName(text);
        const id = SNIPPET_RE.test(String(s.id ?? '')) && !snippets.some((x) => x.id === s.id) ? String(s.id) : uid('usnip_');
        snippets.push({ id, field: s.field, name, text });
    }
    return { groups, intensities, style, snippets };
}

/** 已经规整过的库对象（之后只经过本模块的函数修改，不必每次重新规整；换成新对象时——导入配置、外部改写——再规整一次） */
const NORMALIZED = new WeakSet();

/** 设置里的常用库：没规整过时规整并写回 settings.profileLibrary；返回库对象本身（修改它就是修改设置） */
export function profileLibrary(settings) {
    if (!settings || typeof settings !== 'object') return emptyProfileLibrary();
    const cur = settings.profileLibrary;
    if (isObj(cur) && NORMALIZED.has(cur)) return cur;
    const lib = normalizeProfileLibrary(cur);
    NORMALIZED.add(lib);
    settings.profileLibrary = lib;
    return lib;
}

// ---------------- 标签分组（含叙事偏好的建议） ----------------

/**
 * 一类（likes / dislikes / style）的建议分组，内置的与自定义的合并好：
 * 内置分组按代码里的顺序（内置标签去掉隐藏的，后面接自定义标签），然后是自定义分组（按创建顺序）；style 只有一个分组。
 * @returns {{id: string, name: string, target: string, builtin: boolean, items: {tag: string, builtin: boolean}[], hidden: string[], custom: number}[]}
 */
export function libraryGroups(settings, kind) {
    const lib = profileLibrary(settings);
    if (kind === 'style') {
        const hidden = new Set(lib.style.hidden.map(key));
        return [{
            id: STYLE_GROUP_ID, name: '常用', target: 'style', builtin: true,
            items: [...USER_PROFILE_STYLE_SUGGESTIONS.filter((t) => !hidden.has(key(t))).map((tag) => ({ tag, builtin: true })), ...lib.style.tags.map((tag) => ({ tag, builtin: false }))],
            hidden: USER_PROFILE_STYLE_SUGGESTIONS.filter((t) => hidden.has(key(t))),
            custom: lib.style.tags.length,
        }];
    }
    const out = [];
    // 同一个标签只出现一次：看得见的内置标签优先，自定义的按分组顺序第一次出现的那个（旧数据、导入的数据里可能有重复的）
    const seen = new Set();
    for (const b of USER_PROFILE_TAG_GROUPS) {
        if (b.kind !== kind) continue;
        const hidden = new Set((lib.groups.find((g) => g.id === b.id)?.hidden || []).map(key));
        for (const t of b.tags) if (!hidden.has(key(t))) seen.add(key(t));
    }
    const firstSeen = (tags) => tags.filter((t) => {
        const k = key(t);
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
    });
    for (const b of USER_PROFILE_TAG_GROUPS) {
        if (b.kind !== kind) continue;
        const stored = lib.groups.find((g) => g.id === b.id);
        const hidden = new Set((stored?.hidden || []).map(key));
        const custom = firstSeen(stored?.tags || []);
        out.push({
            id: b.id, name: b.name, target: kind, builtin: true,
            items: [...b.tags.filter((t) => !hidden.has(key(t))).map((tag) => ({ tag, builtin: true })), ...custom.map((tag) => ({ tag, builtin: false }))],
            hidden: b.tags.filter((t) => hidden.has(key(t))),
            custom: custom.length,
        });
    }
    for (const g of lib.groups) {
        if (BUILTIN_GROUPS.has(g.id) || g.target !== kind) continue;
        const tags = firstSeen(g.tags);
        out.push({ id: g.id, name: g.name, target: kind, builtin: false, items: tags.map((tag) => ({ tag, builtin: false })), hidden: [], custom: tags.length });
    }
    return out;
}

/** 这个标签在这一类的常用库里看得见的那个分组（不分大小写、去掉空白比较）；没有时返回 null */
export function libraryGroupOfTag(settings, kind, tag) {
    const k = tagKey(kind, tag);
    if (!k) return null;
    return libraryGroups(settings, kind).find((g) => g.items.some((i) => tagKey(kind, i.tag) === k)) || null;
}

/** 这个标签是不是这一类里别的内置分组（不是 groupId）里隐藏的内置标签：是的话返回 {group, entry, tag} */
function hiddenBuiltinElsewhere(lib, kind, groupId, k) {
    for (const b of USER_PROFILE_TAG_GROUPS) {
        if (b.kind !== kind || b.id === groupId) continue;
        const tag = b.tags.find((x) => key(x) === k);
        if (!tag) continue;
        const entry = lib.groups.find((g) => g.id === b.id);
        if (entry?.hidden?.some((h) => key(h) === k)) return { group: b, entry, tag };
    }
    return null;
}

/** 分组的规格：内置 / 自定义 / 叙事偏好；create：内置分组在库里还没有记录时建一条。找不到返回 null */
function groupSlot(lib, groupId, create = false) {
    if (groupId === STYLE_GROUP_ID) {
        return { kind: 'style', name: '叙事偏好', builtinTags: USER_PROFILE_STYLE_SUGGESTIONS, entry: lib.style, max: L.styleTag, count: L.styleTags };
    }
    const builtin = BUILTIN_GROUPS.get(groupId);
    let entry = lib.groups.find((g) => g.id === groupId) || null;
    if (builtin) {
        if (!entry && create) {
            entry = { id: groupId, tags: [], hidden: [] };
            lib.groups.push(entry);
        }
        return { kind: builtin.kind, name: builtin.name, builtinTags: builtin.tags, entry, max: L.tag, count: L.groupTags };
    }
    if (!entry) return null;
    return { kind: entry.target, name: entry.name, builtinTags: [], entry, max: L.tag, count: L.groupTags };
}

/**
 * 往一个分组里存常用标签（可以一次多个：数组或逗号隔开的字符串；叙事偏好每项末尾的标点去掉）。
 * 是这个分组里被隐藏的内置标签时恢复显示；是这一类里别的内置分组里隐藏的内置标签时：restoreHidden（用户自己加的）在它原来的分组里
 * 恢复显示，否则（导入时，不替用户改隐藏的选择）跳过——都不会在别的分组里存一份重复的；
 * 这一类里已经有（任何分组里看得见）的跳过；分组满了的跳过。
 * @returns {{added: string[], restored: string[], skipped: {tag: string, reason: string}[]}}
 * @throws {Error} 分组不存在
 */
export function addLibraryTags(settings, groupId, tags, { restoreHidden = true } = {}) {
    const lib = profileLibrary(settings);
    const slot = groupSlot(lib, groupId, true);
    if (!slot) throw new Error('这个分组已经不存在了');
    const added = [];
    const restored = [];
    const skipped = [];
    const list = slot.kind === 'style' ? cleanStyleList(tags, 10000) : cleanTagList(tags, { max: slot.max, count: 10000 });
    for (const t of list) {
        const k = tagKey(slot.kind, t);
        const bt = slot.builtinTags.find((x) => tagKey(slot.kind, x) === k);
        if (bt && slot.entry.hidden.some((h) => tagKey(slot.kind, h) === k)) {
            const hidden = new Set(slot.entry.hidden.filter((h) => tagKey(slot.kind, h) !== k).map(key));
            slot.entry.hidden = slot.builtinTags.filter((x) => hidden.has(key(x)));
            restored.push(bt);
            continue;
        }
        const other = slot.kind === 'style' ? null : hiddenBuiltinElsewhere(lib, slot.kind, groupId, k);
        if (other) {
            if (restoreHidden) {
                other.entry.hidden = other.entry.hidden.filter((h) => key(h) !== k);
                restored.push(other.tag);
            } else {
                skipped.push({ tag: t, reason: `是「${other.group.name}」里隐藏的内置标签（可以在那里恢复默认）` });
            }
            continue;
        }
        const where = libraryGroupOfTag(settings, slot.kind, t);
        if (where) {
            skipped.push({ tag: t, reason: `已经在「${where.name}」里` });
            continue;
        }
        if (slot.entry.tags.length >= slot.count) {
            skipped.push({ tag: t, reason: `「${slot.name}」最多存 ${slot.count} 个自定义的` });
            continue;
        }
        slot.entry.tags.push(t);
        added.push(t);
    }
    return { added, restored, skipped };
}

/**
 * 从分组里拿掉一个常用标签：内置标签是隐藏（可以恢复默认），自定义标签是删掉。已经加到画像里的标签不受影响。
 * @returns {'hidden'|'removed'|null}
 */
export function removeLibraryTag(settings, groupId, tag) {
    const lib = profileLibrary(settings);
    const slot = groupSlot(lib, groupId, true);
    if (!slot) return null;
    const k = tagKey(slot.kind, tag);
    if (!k) return null;
    const bt = slot.builtinTags.find((t) => tagKey(slot.kind, t) === k);
    if (bt) {
        if (slot.entry.hidden.some((h) => key(h) === key(bt))) return null;
        const hidden = new Set([...slot.entry.hidden, bt].map(key));
        slot.entry.hidden = slot.builtinTags.filter((t) => hidden.has(key(t)));
        return 'hidden';
    }
    const n = slot.entry.tags.length;
    slot.entry.tags = slot.entry.tags.filter((t) => tagKey(slot.kind, t) !== k);
    return slot.entry.tags.length !== n ? 'removed' : null;
}

/**
 * 恢复分组里隐藏的内置标签（这个分组里自定义的标签不受影响）；返回恢复了几个。
 * 这一类别的分组里存着同样的自定义标签（旧数据、导入的）：删掉那一份，同一个标签只出现一次（内置的那个）。
 */
export function restoreLibraryTags(settings, groupId) {
    const lib = profileLibrary(settings);
    const slot = groupSlot(lib, groupId);
    if (!slot?.entry?.hidden?.length) return 0;
    const n = slot.entry.hidden.length;
    const back = new Set(slot.entry.hidden.map(key));
    slot.entry.hidden = [];
    if (slot.kind !== 'style') {
        for (const g of lib.groups) {
            if (g.id === groupId || (BUILTIN_GROUPS.get(g.id)?.kind ?? g.target) !== slot.kind) continue;
            g.tags = g.tags.filter((t) => !back.has(key(t)));
        }
    }
    return n;
}

/** 分组名称有什么问题（空 / 与内置或自定义分组重名），没问题返回 '' */
export function libraryGroupNameProblem(settings, name, exceptId = '') {
    const n = cleanLine(name, L.groupName);
    if (!n) return '分组名称不能为空';
    const lib = profileLibrary(settings);
    const all = [...USER_PROFILE_TAG_GROUPS.map((g) => ({ id: g.id, name: g.name })), ...lib.groups.filter((g) => !BUILTIN_GROUPS.has(g.id))];
    if (all.some((g) => g.id !== exceptId && key(g.name) === key(n))) return '已经有同名的分组';
    return '';
}

/** 新建自定义分组 {name, target: 'likes'|'dislikes'}；名称有问题或个数到了上限时抛错 */
export function addLibraryGroup(settings, { name, target = 'likes' } = {}) {
    const problem = libraryGroupNameProblem(settings, name);
    if (problem) throw new Error(problem);
    const lib = profileLibrary(settings);
    if (lib.groups.filter((g) => !BUILTIN_GROUPS.has(g.id)).length >= L.groups) throw new Error(`最多 ${L.groups} 个自定义分组`);
    const item = { id: uid('ugrp_'), name: cleanLine(name, L.groupName), target: isTarget(target) ? target : 'likes', tags: [] };
    lib.groups.push(item);
    return item;
}

/** 自定义分组改名；内置分组、空名、重名时抛错 */
export function renameLibraryGroup(settings, id, name) {
    if (BUILTIN_GROUPS.has(id) || id === STYLE_GROUP_ID) throw new Error('内置分组不能改名');
    const lib = profileLibrary(settings);
    const g = lib.groups.find((x) => x.id === id);
    if (!g) throw new Error('这个分组已经不存在了');
    const problem = libraryGroupNameProblem(settings, name, id);
    if (problem) throw new Error(problem);
    g.name = cleanLine(name, L.groupName);
    return g;
}

/** 删除自定义分组（连同里面的常用标签；已经加到画像里的标签不受影响）；返回删掉的分组，内置分组或不存在时返回 null */
export function removeLibraryGroup(settings, id) {
    if (BUILTIN_GROUPS.has(id)) return null;
    const lib = profileLibrary(settings);
    const g = lib.groups.find((x) => x.id === id);
    if (!g) return null;
    lib.groups = lib.groups.filter((x) => x.id !== id);
    return g;
}

// ---------------- 尺度 ----------------

/** 自定义尺度 → 与内置尺度同样的字段（card / chat 用「名称——说明。」，status 用「名称——说明」；desc 是用户写的原文） */
export function customIntensityInfo({ id, name, desc }) {
    const d = trimEndPunct(desc);
    const text = d ? `${name}——${d}。` : `${name}。`;
    return { value: id, label: name, desc: String(desc ?? ''), hint: d ? `${d}。` : '', card: text, chat: text, status: d ? `${name}——${d}` : name, custom: true };
}

function builtinInfo(x) {
    return { ...x, status: x.label, custom: false };
}

/** 全部尺度：内置三档 + 自定义（按创建顺序） */
export function profileIntensities(settings) {
    return [...USER_PROFILE_INTENSITIES.map(builtinInfo), ...profileLibrary(settings).intensities.map(customIntensityInfo)];
}

/**
 * 尺度的信息：内置的直接给；自定义的在 settings 的常用库里找。认不出时按默认尺度（自定义尺度已经删掉时 missing = true）。
 * @returns {{value, label, hint, card, chat, status, custom: boolean, missing?: boolean}}
 */
export function intensityInfo(v, settings = null) {
    const b = USER_PROFILE_INTENSITIES.find((x) => x.value === v);
    if (b) return builtinInfo(b);
    const isCustom = typeof v === 'string' && CUSTOM_INTENSITY_RE.test(v);
    if (isCustom && settings) {
        const c = profileLibrary(settings).intensities.find((x) => x.id === v);
        if (c) return customIntensityInfo(c);
    }
    const d = builtinInfo(USER_PROFILE_INTENSITIES.find((x) => x.value === USER_PROFILE_DEFAULT_INTENSITY));
    return isCustom ? { ...d, missing: true } : d;
}

/** 尺度 id 在这台电脑上能不能用：内置的、常用库里还在的自定义尺度；用不了时返回默认尺度。map：导入时的 id 对照（导入的 id → 本机 id） */
export function resolveIntensityId(settings, v, map = null) {
    if (USER_PROFILE_INTENSITIES.some((x) => x.value === v)) return v;
    if (typeof v !== 'string' || !CUSTOM_INTENSITY_RE.test(v)) return USER_PROFILE_DEFAULT_INTENSITY;
    const id = (map && map[v]) || v;
    return profileLibrary(settings).intensities.some((x) => x.id === id) ? id : USER_PROFILE_DEFAULT_INTENSITY;
}

/** 自定义尺度的名称有什么问题（空 / 和内置尺度或别的自定义尺度重名），没问题返回 '' */
export function intensityNameProblem(settings, name, exceptId = '') {
    const n = cleanLine(name, L.intensityName);
    if (!n) return '名称不能为空';
    if (USER_PROFILE_INTENSITIES.some((x) => key(x.label) === key(n))) return '和内置的尺度重名';
    if (profileLibrary(settings).intensities.some((x) => x.id !== exceptId && key(x.name) === key(n))) return '已经有同名的尺度';
    return '';
}

function checkIntensity(settings, { name, desc }, exceptId = '') {
    const problem = intensityNameProblem(settings, name, exceptId);
    if (problem) throw new Error(problem);
    const d = cleanLine(desc, L.intensityDesc);
    if (!d) throw new Error('说明不能为空：写清楚这个尺度能写到什么程度');
    return { name: cleanLine(name, L.intensityName), desc: d };
}

/** 新建自定义尺度 {name, desc}；返回 {id, name, desc} */
export function addCustomIntensity(settings, data = {}) {
    const v = checkIntensity(settings, data);
    const lib = profileLibrary(settings);
    if (lib.intensities.length >= L.intensities) throw new Error(`最多 ${L.intensities} 个自定义尺度`);
    const item = { id: uid('uint_'), ...v };
    lib.intensities.push(item);
    return item;
}

/** 修改自定义尺度（名称、说明）；找不到时抛错。已经生成的卡上存的是当时的名称和说明，不受影响 */
export function updateCustomIntensity(settings, id, data = {}) {
    const lib = profileLibrary(settings);
    const cur = lib.intensities.find((x) => x.id === id);
    if (!cur) throw new Error('这个尺度已经不存在了');
    const v = checkIntensity(settings, { name: data.name ?? cur.name, desc: data.desc ?? cur.desc }, id);
    Object.assign(cur, v);
    return cur;
}

/** 正在用这个尺度的画像个数 */
export function intensityUsage(settings, id) {
    return (Array.isArray(settings?.userProfiles) ? settings.userProfiles : []).filter((p) => isObj(p) && p.intensity === id).length;
}

/**
 * 删除自定义尺度：正在用它的画像改回默认尺度。已经生成的卡不受影响（卡上存的是当时的名称和说明）。
 * @returns {{removed: object|null, profiles: number}} profiles：改回默认尺度的画像个数
 */
export function removeCustomIntensity(settings, id) {
    const lib = profileLibrary(settings);
    const removed = lib.intensities.find((x) => x.id === id) || null;
    if (!removed) return { removed: null, profiles: 0 };
    lib.intensities = lib.intensities.filter((x) => x.id !== id);
    let profiles = 0;
    for (const p of Array.isArray(settings.userProfiles) ? settings.userProfiles : []) {
        if (!isObj(p) || p.intensity !== id) continue;
        p.intensity = USER_PROFILE_DEFAULT_INTENSITY;
        p.updatedAt = Date.now();
        profiles++;
    }
    return { removed, profiles };
}

// ---------------- 常用文字 ----------------

/** 一种文字（persona / notes）的常用文字 */
export function profileSnippets(settings, field) {
    return profileLibrary(settings).snippets.filter((s) => s.field === field);
}

/**
 * 存一段常用文字 {name, text}：名称为空时取第一行；同名时自动加「 2」；一模一样的文字已经存过时抛错。
 * @returns {{id, field, name, text}}
 */
export function addProfileSnippet(settings, field, { name = '', text = '' } = {}) {
    if (!isSnippetField(field)) throw new Error('不认识的字段');
    const t = cleanText(text, L.snippetText);
    if (!t) throw new Error('内容是空的，先写点什么再存');
    const lib = profileLibrary(settings);
    const mine = lib.snippets.filter((s) => s.field === field);
    const same = mine.find((s) => s.text === t);
    if (same) throw new Error(`一样的内容已经存过了（「${same.name}」）`);
    if (mine.length >= L.snippets) throw new Error(`每一种最多存 ${L.snippets} 段常用文字`);
    const base = cleanLine(name, L.snippetName) || snippetDefaultName(t);
    let n = base;
    for (let i = 2; mine.some((s) => key(s.name) === key(n)) && i < 1000; i++) n = `${base.slice(0, L.snippetName - String(i).length - 1)} ${i}`;
    const item = { id: uid('usnip_'), field, name: n, text: t };
    lib.snippets.push(item);
    return item;
}

export function removeProfileSnippet(settings, id) {
    const lib = profileLibrary(settings);
    const n = lib.snippets.length;
    lib.snippets = lib.snippets.filter((s) => s.id !== id);
    return lib.snippets.length !== n;
}

// ---------------- 导入导出 ----------------

/** 常用库里自己加的东西有多少（导出时说明用）：自定义标签、自定义分组、隐藏的内置标签、自定义尺度、叙事偏好、常用文字 */
export function profileLibraryCounts(settings) {
    const lib = profileLibrary(settings);
    const c = {
        tags: lib.groups.reduce((n, g) => n + g.tags.length, 0),
        groups: lib.groups.filter((g) => !BUILTIN_GROUPS.has(g.id)).length,
        hidden: lib.groups.reduce((n, g) => n + (g.hidden?.length || 0), 0) + lib.style.hidden.length,
        intensities: lib.intensities.length,
        styleTags: lib.style.tags.length,
        snippets: lib.snippets.length,
    };
    c.total = c.tags + c.groups + c.intensities + c.styleTags + c.snippets;
    return c;
}

/** 导出用的常用库（副本）；hidden=false 时不带隐藏的内置标签（分享画像给别人时不替别人隐藏东西） */
export function exportProfileLibrary(settings, { hidden = true } = {}) {
    const lib = structuredClone(profileLibrary(settings));
    lib.groups = lib.groups
        .map((g) => (BUILTIN_GROUPS.has(g.id) ? { id: g.id, tags: g.tags, ...(hidden ? { hidden: g.hidden } : {}) } : g))
        .filter((g) => !BUILTIN_GROUPS.has(g.id) || g.tags.length || g.hidden?.length);
    if (!hidden) lib.style = { tags: lib.style.tags, hidden: [] };
    return lib;
}

/** 只带这些自定义尺度的库（导出画像时总是带上画像用到的自定义尺度，否则导入后认不出来） */
export function libraryForIntensities(settings, ids) {
    const want = new Set((ids || []).filter((v) => typeof v === 'string' && CUSTOM_INTENSITY_RE.test(v)));
    const intensities = profileLibrary(settings).intensities.filter((x) => want.has(x.id)).map((x) => ({ ...x }));
    return intensities.length ? { intensities } : null;
}

/**
 * 把导入的常用库合并进本机的库（不重复）：
 * - 标签：按分组合并，这一类里已经有的跳过；自定义分组按 id（byId）或 名称 + 用在哪里 找本机的分组，没有时新建（重名时自动改名）；
 * - 尺度：按 id（byId 时用导入的名称和说明覆盖本机的）或名称找本机的，没有时新建；返回 intensityMap（导入的 id → 本机 id），
 *   导入的画像按它改尺度 id；
 * - 叙事偏好、常用文字：没有的才加（常用文字按同一字段、同样的文字判断）；
 * - hidden：是否合并隐藏的内置标签（导入配置时合并；导入别人的画像文件时不替你隐藏东西）。
 * @returns {{intensityMap: Object<string,string>, added: {tags: number, groups: number, intensities: number, styleTags: number, snippets: number, hidden: number}}}
 */
export function mergeProfileLibrary(settings, incoming, { hidden = false, byId = false } = {}) {
    const inc = normalizeProfileLibrary(incoming);
    const lib = profileLibrary(settings);
    const added = { tags: 0, groups: 0, intensities: 0, styleTags: 0, snippets: 0, hidden: 0 };
    // 导入的标签是本机隐藏的内置标签时跳过（不替用户恢复隐藏的选择）
    const addTags = (gid, tags) => {
        if (!tags.length) return;
        added.tags += addLibraryTags(settings, gid, tags, { restoreHidden: false }).added.length;
    };
    for (const g of inc.groups) {
        if (BUILTIN_GROUPS.has(g.id)) {
            addTags(g.id, g.tags);
            if (hidden && g.hidden.length) {
                for (const t of g.hidden) if (removeLibraryTag(settings, g.id, t) === 'hidden') added.hidden++;
            }
            continue;
        }
        const custom = lib.groups.filter((x) => !BUILTIN_GROUPS.has(x.id));
        let local = (byId && custom.find((x) => x.id === g.id)) || custom.find((x) => x.target === g.target && key(x.name) === key(g.name)) || null;
        if (!local) {
            if (custom.length >= L.groups) continue;
            let name = g.name;
            for (let i = 2; libraryGroupNameProblem(settings, name) && i < 100; i++) name = `${g.name.slice(0, L.groupName - String(i).length)}${i}`;
            if (libraryGroupNameProblem(settings, name)) continue;
            local = { id: lib.groups.some((x) => x.id === g.id) ? uid('ugrp_') : g.id, name, target: g.target, tags: [] };
            lib.groups.push(local);
            added.groups++;
        }
        addTags(local.id, g.tags);
    }
    const intensityMap = {};
    for (const x of inc.intensities) {
        const byIdHit = lib.intensities.find((y) => y.id === x.id);
        if (byIdHit) {
            if (byId && !intensityNameProblem(settings, x.name, x.id)) Object.assign(byIdHit, { name: x.name, desc: x.desc });
            intensityMap[x.id] = byIdHit.id;
            continue;
        }
        const byName = lib.intensities.find((y) => key(y.name) === key(x.name));
        if (byName) {
            intensityMap[x.id] = byName.id;
            continue;
        }
        if (lib.intensities.length >= L.intensities || intensityNameProblem(settings, x.name)) continue;
        lib.intensities.push({ id: x.id, name: x.name, desc: x.desc });
        intensityMap[x.id] = x.id;
        added.intensities++;
    }
    added.styleTags += inc.style.tags.length ? addLibraryTags(settings, STYLE_GROUP_ID, inc.style.tags, { restoreHidden: false }).added.length : 0;
    if (hidden) {
        for (const t of inc.style.hidden) if (removeLibraryTag(settings, STYLE_GROUP_ID, t) === 'hidden') added.hidden++;
    }
    for (const s of inc.snippets) {
        try {
            addProfileSnippet(settings, s.field, s);
            added.snippets++;
        } catch { /* 一样的内容已经有了、或者满了：跳过 */ }
    }
    return { intensityMap, added };
}

/** 合并结果的一句话（日志用）；什么都没加时为 '' */
export function libraryMergeSummary(added) {
    if (!added) return '';
    const parts = [
        added.tags ? `标签 ${added.tags} 个` : '',
        added.groups ? `分组 ${added.groups} 个` : '',
        added.intensities ? `尺度 ${added.intensities} 个` : '',
        added.styleTags ? `叙事偏好 ${added.styleTags} 个` : '',
        added.snippets ? `常用文字 ${added.snippets} 段` : '',
    ].filter(Boolean);
    return parts.join('、');
}
