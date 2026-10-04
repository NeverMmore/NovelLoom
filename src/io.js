// 导入导出：任务（完整项目）、配置、世界书、大纲、角色资料

import { VERSION } from './constants.js';
import { buildOutlineText, characterProfileText, getVolumes, mergeEntry, normalizeProject } from './project.js';
import { buildWorldbookEntries, parseExternalWorld, toSTWorld } from './worldbook.js';
import { downloadFile, safeFileName, structuredCloneSafe, uid } from './utils.js';

export function exportTask(project) {
    const data = { type: 'novel_loom_task', version: VERSION, exportedAt: new Date().toISOString(), project };
    downloadFile(JSON.stringify(data), `${safeFileName(project.name)}.novelloom.json`);
}

export function parseTask(json) {
    const p = json?.type === 'novel_loom_task' ? json.project : json?.project || json;
    if (!p?.chunks) throw new Error('不是 NovelLoom 任务文件');
    const project = normalizeProject(structuredCloneSafe(p));
    project.id = uid('p_');
    project.name = `${project.name}（导入）`;
    return project;
}

/** 导出配置（默认去掉 API 密钥） */
export function exportConfig(settings, { includeKeys = false } = {}) {
    const s = structuredCloneSafe(settings);
    delete s.activeProjectId;
    if (!includeKeys) {
        if (s.api) s.api.apiKey = '';
        if (s.continueApi) s.continueApi.apiKey = '';
    }
    s.chatgen = { ...s.chatgen, currentChapter: 0, isRunning: false, isPaused: false };
    downloadFile(JSON.stringify({ type: 'novel_loom_config', version: VERSION, settings: s }, null, 2), 'NovelLoom-config.json');
}

export function applyConfig(settings, json) {
    const s = json?.type === 'novel_loom_config' ? json.settings : json;
    if (!s || typeof s !== 'object') throw new Error('不是 NovelLoom 配置文件');
    for (const key of ['api', 'continueApi', 'chunking', 'extraction', 'worldbook', 'cards', 'continuation', 'chatgen', 'prompts', 'categories', 'defaultEntries', 'messageChains', 'chainOptions', 'planner', 'stylePresets', 'styleOptions', 'antiTruncate']) {
        if (s[key] === undefined) continue;
        if (key === 'stylePresets' && Array.isArray(s[key])) {
            // 文风预设按 id 合并，不覆盖本机其他预设
            const cur = Array.isArray(settings.stylePresets) ? settings.stylePresets : [];
            for (const p of structuredCloneSafe(s[key])) {
                if (!p?.id) continue;
                const i = cur.findIndex((x) => x.id === p.id);
                if (i >= 0) cur[i] = p;
                else cur.push(p);
            }
            settings.stylePresets = cur;
        } else if (key === 'api' || key === 'continueApi') {
            const keep = settings[key]?.apiKey;
            settings[key] = { ...settings[key], ...s[key] };
            if (!s[key].apiKey && keep) settings[key].apiKey = keep;
        } else if (Array.isArray(s[key])) {
            settings[key] = structuredCloneSafe(s[key]);
        } else if (typeof s[key] === 'object') {
            settings[key] = { ...settings[key], ...structuredCloneSafe(s[key]) };
        }
    }
    // 跨项目共享的自定义列表：按 id 合并，不覆盖本机已有的其他项
    for (const [key, idKey] of [['customRelationTypes', 'value'], ['relationTemplates', 'id'], ['branchTemplates', 'id']]) {
        if (!Array.isArray(s[key])) continue;
        const cur = Array.isArray(settings[key]) ? settings[key] : [];
        for (const item of structuredCloneSafe(s[key])) {
            if (!item?.[idKey]) continue;
            const i = cur.findIndex((x) => x?.[idKey] === item[idKey]);
            if (i >= 0) cur[i] = item;
            else cur.push(item);
        }
        settings[key] = cur;
    }
    settings.chatgen.isRunning = false;
}

/**
 * 导出世界书
 * @param {{since?: number}} opt since：只导出该时间之后新增/修改的条目（“导出变更”）
 */
export function exportWorldbook(project, settings, opt = {}) {
    let entries = buildWorldbookEntries(project, settings, opt);
    if (opt.since) entries = entries.filter((e) => (e.updatedAt || 0) > opt.since);
    if (!entries.length) return 0;
    const data = toSTWorld(entries, { allowRecursion: settings.worldbook.allowRecursion, name: project.bookName });
    const name = opt.name || settings.worldbook.namePattern.replace('{book}', project.bookName);
    downloadFile(JSON.stringify(data, null, 2), `${safeFileName(name)}${opt.since ? '-变更' : ''}.json`);
    project.lastWorldExportAt = Date.now();
    return entries.length;
}

/** 分卷导出：每卷一个 JSON 文件 */
export function exportVolumes(project, settings, { scope } = {}) {
    const vols = getVolumes(project).filter((v) => !v.implicit);
    let files = 0;
    for (const v of vols) {
        const entries = buildWorldbookEntries(project, settings, { volume: v, volumeScope: scope });
        if (!entries.length) continue;
        const name = `${settings.worldbook.namePattern.replace('{book}', project.bookName)}·${v.name}`;
        downloadFile(JSON.stringify(toSTWorld(entries, { allowRecursion: settings.worldbook.allowRecursion, name }), null, 2), `${safeFileName(name)}.json`);
        files++;
    }
    return files;
}

/**
 * 合并外部世界书到项目
 * @returns {number} 合并条目数
 */
export function mergeExternalWorld(project, json, { targetCategory = '' } = {}) {
    const list = parseExternalWorld(json);
    let n = 0;
    for (const e of list) {
        const cat = targetCategory || e.category || '导入';
        if (cat === '角色') {
            // 外部角色条目作为普通条目导入到“导入角色”分类，避免破坏结构化档案
            mergeEntry(project, '导入角色', { name: e.name, keywords: e.keywords, content: e.content }, -1, { replace: true });
        } else {
            mergeEntry(project, cat, { name: e.name, keywords: e.keywords, content: e.content }, -1, { replace: true });
        }
        const target = project.worldbook[cat === '角色' ? '导入角色' : cat]?.[e.name];
        if (target) {
            target.config = { ...(target.config || {}), constant: e.constant, position: e.position, depth: e.depth, order: e.order };
            target.sourceChunks = (target.sourceChunks || []).filter((x) => x !== -1);
            target.locked = true;
        }
        n++;
    }
    return n;
}

export function exportOutline(project) {
    const lines = [`# 《${project.bookName}》故事大纲`, ''];
    if (project.outline.summary) lines.push('## 梗概', '', project.outline.summary, '');
    const vols = getVolumes(project).filter((v) => !v.implicit);
    if (vols.length) {
        lines.push('## 分卷', '');
        for (const v of vols) lines.push(`### ${v.name}（第 ${v.startChunk + 1}–${v.endChunk + 1} 段）`, '', v.summary || '（暂无卷梗概）', '');
    }
    lines.push('## 章节概要', '', buildOutlineText(project, Infinity, 10_000_000), '');
    const imp = project.chunks.flatMap((c) => (c.important || []).map((i) => ({ ...i, chunk: c.title })));
    if (imp.length) {
        lines.push('## 重要章节', '');
        for (const i of imp) {
            lines.push(`- **${i.chapter || i.chunk}**：${i.reason}`);
            for (const q of i.quotes || []) lines.push(`  > 「${q.text}」${q.function ? `（${q.function}）` : ''}`);
        }
        lines.push('');
    }
    const s = project.style || {};
    if (s.perspective || s.tone || s.mood || s.rules || s.notes) {
        lines.push('## 文风', '');
        if (s.perspective) lines.push(`- 视角：${s.perspective}`);
        if (s.tone) lines.push(`- 语言：${s.tone}`);
        if (s.mood) lines.push(`- 基调：${s.mood}`);
        if (s.rules) lines.push('- 写法规则：', ...String(s.rules).split(/\r?\n/).filter((r) => r.trim()).map((r) => `  ${r.trim()}`));
        if (s.notes) lines.push(`- 备注：${s.notes}`);
        lines.push('');
    }
    if (project.missingNames.length) {
        lines.push('## 待确认名称', '');
        for (const m of project.missingNames) lines.push(`- [${m.type}] ${m.vague} → ${m.resolved || m.suggest || '?'}（${m.context}）`);
    }
    downloadFile(lines.join('\n'), `${safeFileName(project.bookName)}-大纲.md`, 'text/markdown');
}

export function exportCharactersText(project) {
    const text = Object.values(project.characters)
        .sort((a, b) => a.firstChunk - b.firstChunk)
        .map((c) => characterProfileText(c, { maxExperiences: 100, maxQuotes: 100 }))
        .join('\n\n---\n\n');
    downloadFile(text, `${safeFileName(project.bookName)}-角色档案.txt`, 'text/plain');
}
