// 一键写入酒馆：世界书 + 角色卡（绑定世界书、内嵌 character_book）

import { buildCardJson, buildPngCard } from './cards.js';
import { characterExistsInST, importCharacterToST, saveWorldToST } from './stio.js';
import { isWorldCard, statusBarActive, statusBarEntries } from './statusbar.js';
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
    const exclude = settings.worldbook.excludeCardCharacter && card.charName ? [card.charName] : [];
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

/**
 * 带状态栏的卡片专用的世界书名：「默认世界书名·角色名」（世界/旁白卡是「默认世界书名·卡片名」）。
 * 同一时间点的卡片默认共用一本世界书、写入时同名覆盖，而 MVU 只从角色绑定的世界书读 [initvar]，
 * 所以状态栏卡必须有自己的一本；第一次写入后记在 card.statusBar.worldName，之后保持不变。
 * 状态栏启用时 card.worldName（编辑框里的“绑定世界书名称”）不起作用。
 */
export function statusBarWorldName(project, settings, card) {
    if (card.statusBar?.worldName) return card.statusBar.worldName;
    return `${defaultWorldName(project, settings, card.timepoint)}·${safeFileName(card.data?.name || card.charName, isWorldCard(card) ? '旁白' : '角色')}`;
}

/**
 * 生成卡片 JSON（含世界书处理），不写入
 * @returns {{worldName: string, entries: object[], json: object, statusBar: boolean}}
 *   entries：写入酒馆的那本世界书的条目。启用状态栏时 = （绑定或内嵌世界书开着时的）资料条目 + 状态栏四个条目；
 *   内嵌的 character_book = （内嵌开着时的）资料条目 + 状态栏条目，名字与 extensions.world 相同。
 */
export function prepareCard(project, settings, card) {
    const allowRecursion = settings.worldbook.allowRecursion;
    if (statusBarActive(card)) {
        const worldName = statusBarWorldName(project, settings, card);
        const lore = settings.cards.linkWorldbook || settings.cards.embedWorldbook ? cardEntries(project, settings, card) : [];
        const sbEntries = statusBarEntries(card);
        const entries = [...lore, ...sbEntries];
        const bookEntries = settings.cards.embedWorldbook ? entries : sbEntries;
        const json = buildCardJson(card, {
            worldName,
            characterBook: toCharacterBook(bookEntries, worldName, { allowRecursion }),
            creator: settings.cards.creator,
            bookName: project.bookName,
            statusBar: settings.statusBar || {},
        });
        return { worldName, entries, json, statusBar: true };
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
    return { worldName, entries, json, statusBar: false };
}

/**
 * 写入酒馆。带状态栏的卡片总是写入并绑定它自己的世界书（即使没开“绑定世界书”），
 * 写入成功后把世界书名记到 card.statusBar.worldName。
 * @returns {Promise<{worldName: string, avatar: string, entryCount: number, statusBar: boolean}>}
 */
export async function publishCard(project, settings, card, { overwrite = true } = {}) {
    const { worldName, entries, json, statusBar } = prepareCard(project, settings, card);
    if (statusBar || (settings.cards.linkWorldbook && entries.length)) {
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
    // 两个名字分开记：状态栏卡的专用世界书记在 statusBar.worldName；card.worldName 仍是普通写入用的
    // “绑定世界书名称”，以后关掉状态栏再写入时回到原来那本（不会把资料写进状态栏专用的那本）
    if (statusBar) card.statusBar.worldName = worldName;
    else card.worldName = worldName;
    card.publishedAt = Date.now();
    return { worldName, avatar, entryCount: entries.length, statusBar };
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
