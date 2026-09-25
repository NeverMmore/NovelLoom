// 一键写入酒馆：世界书 + 角色卡（绑定世界书、内嵌 character_book）

import { buildCardJson, buildPngCard } from './cards.js';
import { characterExistsInST, importCharacterToST, saveWorldToST } from './stio.js';
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

/** 生成卡片 JSON（含世界书处理），不写入 */
export function prepareCard(project, settings, card) {
    const worldName = card.worldName || defaultWorldName(project, settings, card.timepoint);
    const entries = cardEntries(project, settings, card);
    const characterBook = settings.cards.embedWorldbook ? toCharacterBook(entries, worldName, { allowRecursion: settings.worldbook.allowRecursion }) : null;
    const json = buildCardJson(card, {
        worldName: settings.cards.linkWorldbook ? worldName : '',
        characterBook,
        creator: settings.cards.creator,
        bookName: project.bookName,
    });
    return { worldName, entries, json };
}

/**
 * 写入酒馆
 * @returns {Promise<{worldName: string, avatar: string, entryCount: number}>}
 */
export async function publishCard(project, settings, card, { overwrite = true } = {}) {
    const { worldName, entries, json } = prepareCard(project, settings, card);
    if (settings.cards.linkWorldbook && entries.length) {
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
    card.worldName = worldName;
    card.publishedAt = Date.now();
    return { worldName, avatar, entryCount: entries.length };
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
