// 一键写入酒馆：世界书 + 角色卡（绑定世界书、内嵌 character_book）

import { buildCardJson, buildPngCard } from './cards.js';
import { characterExistsInST, importCharacterToST, saveWorldToST } from './stio.js';
import { autoAllowCard } from './stallow.js';
import { normalizeCardOrientation, orientationEntry } from './orientation.js';
import { isWorldCard, statusBarActive, statusBarEntries } from './statusbar.js';
import { normalizeUserRole, userRoleCharName, userRoleEntry, userRoleHasEntry } from './userrole.js';
import { buildWorldbookEntries, toCharacterBook, toSTWorld } from './worldbook.js';
import { getVolumes } from './project.js';
import { safeFileName } from './utils.js';

export function baseWorldName(project, settings) {
    return (settings.worldbook.namePattern || '《{book}》世界书').replace('{book}', project.bookName);
}

export function volumeWorldName(project, settings, vol) {
    return `${baseWorldName(project, settings)}·${vol.name}`;
}

export function defaultWorldName(project, settings, timepoint = null) {
    const base = baseWorldName(project, settings);
    const last = project.chunks.length - 1;
    if (Number.isFinite(timepoint) && timepoint < last) {
        const vol = getVolumes(project).find((v) => !v.implicit && v.endChunk === timepoint);
        return vol ? `${base}（至${vol.name}末）` : `${base}（至第${timepoint + 1}段）`;
    }
    return base;
}

export function cardEntries(project, settings, card) {
    // 「不重复写入该角色本人」也适用于 {{user}} 扮演的原著角色（这个人的设定写在「{{user}} 的身份」条目里）
    const roleChar = userRoleCharName(project, normalizeUserRole(card.userRole, { exclude: card.kind === 'world' ? '' : card.charName }));
    const exclude = settings.worldbook.excludeCardCharacter ? [card.charName, roleChar].filter(Boolean) : [];
    return buildWorldbookEntries(project, settings, {
        excludeCharacters: exclude,
        uptoChunk: Number.isFinite(card.timepoint) ? card.timepoint : Infinity,
    });
}

export async function dataUrlToBlob(dataUrl) {
    const res = await fetch(dataUrl);
    return res.blob();
}

export function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result));
        r.onerror = () => reject(r.error);
        r.readAsDataURL(blob);
    });
}

/** 卡片已经记下的专用世界书名（状态栏卡记在 statusBar.worldName，其他卡记在 ownWorldName）；没有时为 '' */
function savedOwnWorldName(card) {
    return card?.statusBar?.worldName || card?.ownWorldName || '';
}

/** 专用世界书的基础名：「默认世界书名·角色名」（世界/旁白卡是「默认世界书名·卡片名」） */
function ownWorldBaseName(project, settings, card) {
    return `${defaultWorldName(project, settings, card.timepoint)}·${safeFileName(card.data?.name || card.charName, isWorldCard(card) ? '旁白' : '角色')}`;
}

/** 基础名被别的卡占了时依次试：「基础名·导向名」（有剧情导向时）、「基础名·2」「基础名·3」… */
function freeOwnWorldName(base, card, taken) {
    if (!taken.has(base)) return base;
    const o = normalizeCardOrientation(card?.orientation);
    const tag = o ? safeFileName(o.name, '') : '';
    if (tag && !taken.has(`${base}·${tag}`)) return `${base}·${tag}`;
    for (let i = 2; ; i++) if (!taken.has(`${base}·${i}`)) return `${base}·${i}`;
}

/**
 * 卡片专用的世界书名：「默认世界书名·角色名」（世界/旁白卡是「默认世界书名·卡片名」）。
 * 同一时间点的卡片默认共用一本世界书、写入时同名覆盖；而状态栏条目（MVU 只从角色绑定的世界书读 [initvar]）、
 * 剧情导向和「{{user}} 的身份」条目只属于这一张卡，所以带这些条目的卡要有自己的一本（见 cardOwnWorld）。
 * 第一次写入后记下名字（状态栏卡记在 card.statusBar.worldName，其他卡记在 card.ownWorldName），之后保持不变。
 * 用专用世界书时 card.worldName（普通写入用的“绑定世界书名称”）不起作用。
 *
 * 卡名一律是角色名（世界卡没填卡名时是书名），同一角色的几张卡（比如 NTL 版和纯爱版）基础名相同：
 * 还没记下名字时避开项目里其他卡已经记下的专用世界书名，以及排在前面、还没写入过的专用世界书卡按同样规则算出的名字
 * （按 project.cards 的顺序，前面的卡保留基础名；编辑框里显示的名字与写入时一致），见 freeOwnWorldName。
 * 否则后写入的卡会覆盖前一张卡的世界书，前一张卡在酒馆里读到的就是别人的剧情导向、{{user}} 的身份和状态栏变量。
 */
export function statusBarWorldName(project, settings, card) {
    const saved = savedOwnWorldName(card);
    if (saved) return saved;
    const cards = Array.isArray(project?.cards) ? project.cards.filter(Boolean) : [];
    // 同一张卡：同一个对象，或 id 相同（编辑框里拿卡片副本算名字时）
    const same = (c) => c === card || (!!card?.id && c.id === card.id);
    const taken = new Set();
    for (const c of cards) {
        if (same(c)) continue;
        for (const n of [c.statusBar?.worldName, c.ownWorldName]) if (n) taken.add(n);
    }
    const idx = cards.findIndex(same);
    const before = idx < 0 ? cards : cards.slice(0, idx);
    for (const c of before) {
        if (same(c) || savedOwnWorldName(c) || !cardOwnWorld(c)) continue;
        taken.add(freeOwnWorldName(ownWorldBaseName(project, settings, c), c, taken));
    }
    return freeOwnWorldName(ownWorldBaseName(project, settings, card), card, taken);
}

/** 同 statusBarWorldName（函数名沿用以前的，状态栏以外的卡也用它） */
export const cardOwnWorldName = statusBarWorldName;

/**
 * 只属于这张卡的世界书条目（状态栏条目除外）：「剧情导向：名称」（选了导向时）、「{{user}} 的身份」（扮演原著角色或自定义时）。
 * 都是常驻条目，跟着卡片自己的世界书和内嵌 character_book 走；取消导向 / 改回原创新身份后重新写入，条目随之去掉。
 */
export function cardExtraEntries(project, settings, card) {
    return [orientationEntry(card), userRoleEntry(project, card)].filter(Boolean);
}

/**
 * 这张卡写入时是否用自己专用的世界书：带状态栏、有本卡条目（剧情导向 / {{user}} 的身份），
 * 或者以前已经写入过专用世界书（card.ownWorldName；之后取消了导向，也写回同一本，把旧条目去掉）。
 */
export function cardOwnWorld(card) {
    return statusBarActive(card) || !!normalizeCardOrientation(card?.orientation) || userRoleHasEntry(card?.userRole) || !!card?.ownWorldName;
}

/**
 * 生成卡片 JSON（含世界书处理），不写入
 * @returns {{worldName: string, entries: object[], json: object, statusBar: boolean, ownWorld: boolean}}
 *   ownWorld：用卡片自己专用的世界书（见 cardOwnWorld）。此时 entries = （绑定或内嵌世界书开着时的）资料条目 + 本卡条目
 *   （剧情导向、{{user}} 的身份）+ 状态栏四个条目；内嵌的 character_book = （内嵌开着时的）资料条目 + 本卡条目 + 状态栏条目，
 *   名字与 extensions.world 相同。普通卡：共用的世界书（card.worldName 或默认名），条目 = 资料条目。
 */
export function prepareCard(project, settings, card) {
    const allowRecursion = settings.worldbook.allowRecursion;
    if (cardOwnWorld(card)) {
        const sbOn = statusBarActive(card);
        const worldName = statusBarWorldName(project, settings, card);
        const lore = settings.cards.linkWorldbook || settings.cards.embedWorldbook ? cardEntries(project, settings, card) : [];
        const own = [...cardExtraEntries(project, settings, card), ...(sbOn ? statusBarEntries(card) : [])];
        const entries = [...lore, ...own];
        const bookEntries = settings.cards.embedWorldbook ? entries : own;
        const json = buildCardJson(card, {
            worldName,
            characterBook: bookEntries.length || sbOn ? toCharacterBook(bookEntries, worldName, { allowRecursion }) : null,
            creator: settings.cards.creator,
            bookName: project.bookName,
            statusBar: sbOn ? settings.statusBar || {} : false,
        });
        return { worldName, entries, json, statusBar: sbOn, ownWorld: true };
    }
    const worldName = card.worldName || defaultWorldName(project, settings, card.timepoint);
    const entries = cardEntries(project, settings, card);
    const characterBook = settings.cards.embedWorldbook ? toCharacterBook(entries, worldName, { allowRecursion }) : null;
    const json = buildCardJson(card, {
        worldName: settings.cards.linkWorldbook ? worldName : '',
        characterBook,
        creator: settings.cards.creator,
        bookName: project.bookName,
        statusBar: false,
    });
    return { worldName, entries, json, statusBar: false, ownWorld: false };
}

/**
 * 写入酒馆。带状态栏的卡片总是写入并绑定它自己的世界书（即使没开“绑定世界书”），
 * 写入成功后把世界书名记到 card.statusBar.worldName，并按设置自动允许本卡的局部正则和角色脚本（afterPublishAllow）。
 * @param {{overwrite?: boolean, onLog?: Function}} opt onLog：自动授权的结果日志（不给时打到控制台）
 * @returns {Promise<{worldName: string, avatar: string, entryCount: number, statusBar: boolean, ownWorld: boolean, allow: object|null}>}
 */
export async function publishCard(project, settings, card, { overwrite = true, onLog = null } = {}) {
    const { worldName, entries, json, statusBar, ownWorld } = prepareCard(project, settings, card);
    // 专用世界书总是写入（即使没有条目也写，把以前写进去、现在已取消的剧情导向等条目清掉）
    if (ownWorld || (settings.cards.linkWorldbook && entries.length)) {
        await saveWorldToST(worldName, toSTWorld(entries, { allowRecursion: settings.worldbook.allowRecursion, name: worldName }));
    }
    const preserveName = overwrite && card.stAvatar && characterExistsInST(card.stAvatar) ? card.stAvatar : '';
    let avatar;
    if (card.avatarDataUrl) {
        const png = await buildPngCard(json, await dataUrlToBlob(card.avatarDataUrl));
        avatar = await importCharacterToST(png, `${safeFileName(json.name)}.png`, { preserveName });
    } else {
        const blob = new Blob([JSON.stringify(json)], { type: 'application/json' });
        avatar = await importCharacterToST(blob, `${safeFileName(json.name)}.json`, { preserveName });
    }
    card.stAvatar = avatar;
    // 名字分开记：状态栏卡的专用世界书记在 statusBar.worldName，其他专用世界书（剧情导向 / {{user}} 的身份）记在 ownWorldName；
    // card.worldName 仍是普通写入用的“绑定世界书名称”，以后关掉状态栏再写入时回到原来那本（不会把资料写进状态栏专用的那本）
    if (statusBar) card.statusBar.worldName = worldName;
    else if (ownWorld) card.ownWorldName = worldName;
    else card.worldName = worldName;
    card.publishedAt = Date.now();
    const allow = afterPublishAllow(settings, json, avatar, onLog);
    return { worldName, avatar, entryCount: entries.length, statusBar, ownWorld, allow };
}

/**
 * 写入成功后的自动授权（设置 cards.autoAllow，默认开）：卡片带局部正则 / 酒馆助手角色脚本时，替这张卡（按头像文件）
 * 加进酒馆的正则允许名单、在酒馆助手里启用脚本，见 stallow.js。不抛错，结果写进日志并随 publishCard 的结果返回。
 */
function afterPublishAllow(settings, json, avatar, onLog) {
    try {
        return autoAllowCard(settings, json, avatar, { onLog, name: json?.data?.name || json?.name || '' });
    } catch (e) {
        console.warn('[NovelLoom] 自动授权失败', e);
        return null;
    }
}

export async function publishWorldbook(project, settings, name, opt = {}) {
    const entries = buildWorldbookEntries(project, settings, opt);
    if (!entries.length) throw new Error('世界书为空，请先提取');
    await saveWorldToST(name, toSTWorld(entries, { allowRecursion: settings.worldbook.allowRecursion, name }));
    return entries.length;
}

/**
 * 分卷写入酒馆：每卷一本世界书，名为「《书名》世界书·卷名」
 * @returns {Promise<{name:string, count:number}[]>}
 */
export async function publishVolumeWorldbooks(project, settings, { scope } = {}) {
    const vols = getVolumes(project).filter((v) => !v.implicit);
    if (vols.length < 2) throw new Error('当前项目没有分卷');
    const results = [];
    for (const v of vols) {
        const entries = buildWorldbookEntries(project, settings, { volume: v, volumeScope: scope });
        if (!entries.length) continue;
        const name = volumeWorldName(project, settings, v);
        await saveWorldToST(name, toSTWorld(entries, { allowRecursion: settings.worldbook.allowRecursion, name }));
        results.push({ name, count: entries.length });
    }
    return results;
}
