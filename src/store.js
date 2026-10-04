// 持久化：设置走 ST extensionSettings；项目与快照走 IndexedDB（不可用时退回内存）

import { DB_NAME, DB_VERSION, DEFAULT_SETTINGS, DEFAULT_CATEGORIES, MODULE } from './constants.js';
import { mergeDefaults, structuredCloneSafe, uid } from './utils.js';

// ---------------- 设置 ----------------

function getCtx() {
    return globalThis.SillyTavern?.getContext?.();
}

let memorySettings = null;

export function getSettings() {
    const ctx = getCtx();
    let s;
    if (ctx?.extensionSettings) {
        if (!ctx.extensionSettings[MODULE]) ctx.extensionSettings[MODULE] = {};
        s = ctx.extensionSettings[MODULE];
    } else {
        memorySettings = memorySettings || {};
        s = memorySettings;
    }
    mergeDefaults(s, DEFAULT_SETTINGS);
    if (!Array.isArray(s.categories) || !s.categories.length) {
        s.categories = structuredCloneSafe(DEFAULT_CATEGORIES);
    }
    return s;
}

export function saveSettings() {
    getCtx()?.saveSettingsDebounced?.();
}

export function resetSettingsSection(key) {
    const s = getSettings();
    s[key] = structuredCloneSafe(key === 'categories' ? DEFAULT_CATEGORIES : DEFAULT_SETTINGS[key]);
    saveSettings();
}

// ---------------- IndexedDB ----------------

let dbPromise = null;
const memoryDb = { projects: new Map(), snapshots: new Map() };

function hasIDB() {
    return typeof indexedDB !== 'undefined';
}

function openDb() {
    if (!hasIDB()) return Promise.resolve(null);
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains('projects')) db.createObjectStore('projects', { keyPath: 'id' });
            if (!db.objectStoreNames.contains('snapshots')) {
                const s = db.createObjectStore('snapshots', { keyPath: 'id' });
                s.createIndex('projectId', 'projectId', { unique: false });
            }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => {
            console.warn('[NovelLoom] IndexedDB 不可用，改用内存存储', req.error);
            resolve(null);
        };
    });
    return dbPromise;
}

function tx(db, store, mode, fn) {
    return new Promise((resolve, reject) => {
        const t = db.transaction(store, mode);
        const os = t.objectStore(store);
        let result;
        Promise.resolve(fn(os)).then((r) => (result = r));
        t.oncomplete = () => resolve(result);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
    });
}

function reqP(req) {
    return new Promise((resolve, reject) => {
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

export async function dbPut(store, value) {
    const db = await openDb();
    if (!db) {
        memoryDb[store].set(value.id, structuredCloneSafe(value));
        return value.id;
    }
    await tx(db, store, 'readwrite', (os) => reqP(os.put(value)));
    return value.id;
}

export async function dbGet(store, id) {
    const db = await openDb();
    if (!db) return structuredCloneSafe(memoryDb[store].get(id)) ?? null;
    return (await tx(db, store, 'readonly', (os) => reqP(os.get(id)))) ?? null;
}

export async function dbDelete(store, id) {
    const db = await openDb();
    if (!db) {
        memoryDb[store].delete(id);
        return;
    }
    await tx(db, store, 'readwrite', (os) => reqP(os.delete(id)));
}

export async function dbAll(store) {
    const db = await openDb();
    if (!db) return [...memoryDb[store].values()].map(structuredCloneSafe);
    return (await tx(db, store, 'readonly', (os) => reqP(os.getAll()))) || [];
}

export async function dbByIndex(store, index, value) {
    const db = await openDb();
    if (!db) return [...memoryDb[store].values()].filter((v) => v[index] === value).map(structuredCloneSafe);
    return (await tx(db, store, 'readonly', (os) => reqP(os.index(index).getAll(value)))) || [];
}

// ---------------- 项目 ----------------

export async function listProjects() {
    const all = await dbAll('projects');
    return all
        .map((p) => ({
            id: p.id,
            name: p.name,
            updatedAt: p.updatedAt,
            createdAt: p.createdAt,
            chunkCount: p.chunks?.length || 0,
            doneCount: (p.chunks || []).filter((c) => c.status === 'done').length,
            characterCount: Object.keys(p.characters || {}).length,
        }))
        .sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function loadProject(id) {
    return id ? dbGet('projects', id) : null;
}

export async function saveProject(project) {
    project.updatedAt = Date.now();
    return dbPut('projects', project);
}

export async function deleteProject(id) {
    const snaps = await dbByIndex('snapshots', 'projectId', id);
    for (const s of snaps) await dbDelete('snapshots', s.id);
    await dbDelete('projects', id);
}

// ---------------- 快照（修改历史） ----------------

const SNAPSHOT_FIELDS = ['worldbook', 'characters', 'outline', 'cards', 'style', 'relationships', 'groupCards', 'povStyles', 'missingNames', 'censorFlags'];

/** 分段的提取状态（不含正文，正文太大且快照不会改动它）：恢复快照时按 id 写回，保证“待提取/已完成”与资料一致 */
const CHUNK_STATE_FIELDS = ['status', 'outline', 'important', 'error', 'processedAt'];

export async function createSnapshot(project, label = '手动快照') {
    const data = {};
    for (const f of SNAPSHOT_FIELDS) data[f] = structuredCloneSafe(project[f]);
    data.chunkState = (project.chunks || []).map((c) => {
        const s = { id: c.id };
        for (const f of CHUNK_STATE_FIELDS) if (c[f] !== undefined) s[f] = structuredCloneSafe(c[f]);
        return s;
    });
    const snap = {
        id: uid('s_'),
        projectId: project.id,
        createdAt: Date.now(),
        label,
        stats: {
            entries: Object.values(project.worldbook || {}).reduce((n, c) => n + Object.keys(c || {}).length, 0),
            characters: Object.keys(project.characters || {}).length,
        },
        data,
    };
    await dbPut('snapshots', snap);
    // 每个项目最多保留 50 个快照
    const all = (await dbByIndex('snapshots', 'projectId', project.id)).sort((a, b) => b.createdAt - a.createdAt);
    for (const old of all.slice(50)) await dbDelete('snapshots', old.id);
    return snap;
}

export async function listSnapshots(projectId) {
    const all = await dbByIndex('snapshots', 'projectId', projectId);
    return all.sort((a, b) => b.createdAt - a.createdAt).map(({ data, ...meta }) => meta);
}

export async function getSnapshot(id) {
    return dbGet('snapshots', id);
}

export async function restoreSnapshot(project, snapId) {
    const snap = await getSnapshot(snapId);
    if (!snap) throw new Error('快照不存在');
    for (const f of SNAPSHOT_FIELDS) {
        if (snap.data[f] !== undefined) project[f] = structuredCloneSafe(snap.data[f]);
    }
    // 旧快照没有 chunkState，分段状态保持不变；分段被增删过时只写回 id 还对得上的
    if (Array.isArray(snap.data.chunkState)) {
        const byId = new Map(snap.data.chunkState.map((s) => [s.id, s]));
        for (const c of project.chunks || []) {
            const s = byId.get(c.id);
            if (!s) continue;
            for (const f of CHUNK_STATE_FIELDS) {
                if (s[f] !== undefined) c[f] = structuredCloneSafe(s[f]);
                else if (f === 'outline' || f === 'important') c[f] = [];
                else if (f === 'error') c[f] = '';
                else delete c[f];
            }
            if (!c.status || c.status === 'processing') c.status = 'pending';
        }
    }
    return project;
}

export async function deleteSnapshot(id) {
    return dbDelete('snapshots', id);
}
