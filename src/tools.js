// 资料整理工具：别名检测、条目/角色整理、剧情梗概、查找替换

import { callLLM, chainFor } from './llm.js';
import { extractJson, removeTags } from './json.js';
import { buildOutlineText, characterProfileText, chunkOutlineText, getVolumes, normalizeCharacter, setEntryContent } from './project.js';
import { WRITING_RULES, getPrompt, render } from './prompts.js';
import { truncate, uniq } from './utils.js';

async function askJson(settings, systemKey, promptKey, vars, signal) {
    const res = await callLLM({
        api: settings.api,
        system: render(getPrompt(settings, systemKey), vars),
        prompt: render(getPrompt(settings, promptKey), { WRITING_RULES, ...vars }),
        ...chainFor(settings, 'tools', { bookName: vars.BOOK }),
        expect: 'json',
        signal,
    });
    return extractJson(removeTags(res.text, settings.extraction.filterTags));
}

/**
 * AI 别名检测
 * @returns {Promise<{main:string, aliases:string[], reason:string}[]>}
 */
export async function detectAliases(project, settings, category, { signal, onLog } = {}) {
    let items;
    if (category === '角色') {
        items = Object.values(project.characters).map((c) => ({ name: c.name, desc: [c.identity, c.aliases.length ? `别名:${c.aliases.join('/')}` : '', c.gender].filter(Boolean).join('；') }));
    } else {
        items = Object.values(project.worldbook[category] || {}).map((e) => ({ name: e.name, desc: truncate(e.content.replace(/\s+/g, ' '), 60) }));
    }
    if (items.length < 2) return [];
    const names = new Set(items.map((i) => i.name));
    const groups = [];
    const batchSize = 120;
    for (let i = 0; i < items.length; i += batchSize) {
        const batch = items.slice(i, i + batchSize);
        onLog?.(`🔍 检测「${category}」别名：${i + 1}-${i + batch.length} / ${items.length}`);
        const json = await askJson(settings, 'aliasSystem', 'alias', {
            BOOK: project.bookName,
            CATEGORY: category,
            ITEMS: batch.map((it) => `- ${it.name}：${it.desc || '（无简介）'}`).join('\n'),
        }, signal);
        for (const g of json?.groups || []) {
            const main = String(g.main || '').trim();
            const aliases = uniq(g.aliases).filter((a) => a !== main && names.has(a));
            if (!names.has(main) || !aliases.length) continue;
            groups.push({ main, aliases, reason: String(g.reason || '') });
        }
    }
    // 传递合并：A=B, B=C → A,B,C
    const merged = [];
    for (const g of groups) {
        const hit = merged.find((m) => m.main === g.main || m.aliases.includes(g.main) || g.aliases.includes(m.main) || g.aliases.some((a) => m.aliases.includes(a)));
        if (hit) {
            hit.aliases = uniq([...hit.aliases, g.main, ...g.aliases]).filter((a) => a !== hit.main);
            hit.reason += `；${g.reason}`;
        } else {
            merged.push({ ...g });
        }
    }
    return merged;
}

export async function consolidateEntry(project, settings, category, name, { signal } = {}) {
    const e = project.worldbook[category]?.[name];
    if (!e) throw new Error('条目不存在');
    const json = await askJson(settings, 'consolidateSystem', 'consolidate', { BOOK: project.bookName, CATEGORY: category, NAME: name, CONTENT: e.content }, signal);
    const content = typeof json === 'string' ? json : json?.content;
    if (!content || typeof content !== 'string') throw new Error('AI 未返回 content');
    setEntryContent(e, content.trim());
    if (Array.isArray(json.keywords) && json.keywords.length) e.keywords = uniq([name, ...e.keywords, ...json.keywords]);
    e.updatedAt = Date.now();
    return e;
}

export async function consolidateCharacter(project, settings, name, { signal } = {}) {
    const c = project.characters[name];
    if (!c) throw new Error('角色不存在');
    const json = await askJson(settings, 'consolidateSystem', 'characterConsolidate', {
        BOOK: project.bookName,
        NAME: name,
        CONTENT: characterProfileText(c, { maxExperiences: 80, withQuotes: false }),
    }, signal);
    const fixed = normalizeCharacter({ ...c, ...json, name: c.name });
    for (const f of ['gender', 'age', 'identity', 'personality', 'relationship']) if (json[f]) c[f] = String(json[f]);
    if (Array.isArray(json.aliases)) c.aliases = uniq([...c.aliases, ...json.aliases]).filter((a) => a !== c.name);
    if (Array.isArray(json.appearance)) c.appearance = fixed.appearance;
    if (Array.isArray(json.abilities)) c.abilities = fixed.abilities;
    if (Array.isArray(json.hardLimits)) c.hardLimits = fixed.hardLimits;
    if (Array.isArray(json.tabooTopics)) c.tabooTopics = fixed.tabooTopics;
    if (Array.isArray(json.verbalTics)) c.verbalTics = fixed.verbalTics;
    if (Array.isArray(json.experiences) && json.experiences.length) {
        // 整理后的经历丢失了分块序号，按原经历的最后分块号分配（保留时间点筛选能力的近似）
        const last = c.experiences.length ? c.experiences[c.experiences.length - 1].chunk : c.lastChunk;
        const first = c.experiences.length ? c.experiences[0].chunk : c.firstChunk;
        const n = json.experiences.length;
        c.experiences = json.experiences.map((t, i) => ({ chunk: Math.round(first + ((last - first) * i) / Math.max(1, n - 1)), text: String(t) }));
    }
    c.updatedAt = Date.now();
    return c;
}

export async function expandCharacter(project, settings, name, { signal, nsfw = false } = {}) {
    const c = project.characters[name];
    if (!c) throw new Error('角色不存在');
    const json = await askJson(settings, 'characterExpandSystem', 'characterExpand', {
        BOOK: project.bookName,
        NAME: name,
        CONTENT: characterProfileText(c, { maxExperiences: 80, withQuotes: true, withDialogues: true, withNsfw: true }),
        NSFW_GUIDE: nsfw
            ? '- nsfwNotes：补充一段限成人向使用场景的私密细节(身体特征、亲密偏好、尺度边界等)，要与角色已有的「绝对不会做的事」「忌讳话题」保持一致，不违背角色既有性格；这部分内容只会用于角色卡的补充资料，不会公开展示。'
            : '- 本次不需要生成 nsfwNotes，留空字符串即可，不要覆盖已有内容。',
    }, signal);
    if (json.identity) c.identity = String(json.identity);
    if (json.personality) c.personality = String(json.personality);
    if (json.relationship) c.relationship = String(json.relationship);
    if (Array.isArray(json.appearance) && json.appearance.length) c.appearance = uniq([...c.appearance, ...json.appearance]).slice(0, 16);
    if (Array.isArray(json.abilities) && json.abilities.length) c.abilities = uniq([...c.abilities, ...json.abilities]).slice(0, 16);
    if (nsfw && json.nsfwNotes) c.nsfwNotes = String(json.nsfwNotes).trim();
    c.updatedAt = Date.now();
    return c;
}

export async function buildStorySummary(project, settings, { signal, uptoIndex = Infinity } = {}) {
    const outline = buildOutlineText(project, uptoIndex, 30000);
    if (!outline) throw new Error('还没有章节概要，请先提取');
    const res = await callLLM({
        api: settings.api,
        system: getPrompt(settings, 'summarySystem'),
        prompt: render(getPrompt(settings, 'summary'), { BOOK: project.bookName, OUTLINE: outline }),
        ...chainFor(settings, 'tools', project),
        signal,
    });
    project.outline.summary = removeTags(res.text, settings.extraction.filterTags).trim();
    project.outline.summaryUpTo = Number.isFinite(uptoIndex) ? uptoIndex : project.chunks.length - 1;
    return project.outline.summary;
}

/** 为某一卷生成卷梗概 */
export async function buildVolumeSummary(project, settings, volumeId, { signal } = {}) {
    const vol = getVolumes(project).find((v) => v.id === volumeId);
    if (!vol) throw new Error('卷不存在');
    const outline = project.chunks
        .slice(vol.startChunk, vol.endChunk + 1)
        .filter((c) => c.outline?.length)
        .map((c) => `【${c.title}】\n${chunkOutlineText(c)}`)
        .join('\n')
        .slice(0, 30000);
    if (!outline) throw new Error(`「${vol.name}」还没有章节概要，请先提取`);
    const res = await callLLM({
        api: settings.api,
        system: getPrompt(settings, 'summarySystem'),
        prompt: render(getPrompt(settings, 'volumeSummary'), { BOOK: project.bookName, VOLUME: vol.name, OUTLINE: outline }),
        ...chainFor(settings, 'tools', project),
        signal,
    });
    const target = project.volumes.find((v) => v.id === volumeId);
    target.summary = removeTags(res.text, settings.extraction.filterTags).trim();
    target.summaryAt = Date.now();
    return target.summary;
}

/**
 * 查找替换（本地，不消耗 token）
 * @returns {number} 替换次数
 */
export function findReplace(project, { find, replace = '', regex = false, caseSensitive = false, scope = ['characters', 'worldbook'] }) {
    if (!find) return 0;
    let re;
    try {
        re = regex ? new RegExp(find, caseSensitive ? 'g' : 'gi') : new RegExp(find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), caseSensitive ? 'g' : 'gi');
    } catch (e) {
        throw new Error(`正则无效：${e.message}`);
    }
    let count = 0;
    const rep = (s) => {
        if (typeof s !== 'string') return s;
        return s.replace(re, (...m) => {
            count++;
            return regex ? m[0].replace(new RegExp(re.source, re.flags.replace('g', '')), replace) : replace;
        });
    };
    if (scope.includes('worldbook')) {
        for (const cat of Object.values(project.worldbook)) {
            for (const e of Object.values(cat)) {
                e.content = rep(e.content);
                e.keywords = e.keywords.map(rep);
                // 历史版本也一起替换（不重复计数）
                const before = count;
                for (const r of e.revisions || []) r.content = rep(r.content);
                count = before;
            }
        }
    }
    if (scope.includes('characters')) {
        for (const c of Object.values(project.characters)) {
            for (const f of ['identity', 'personality', 'relationship', 'gender', 'age', 'notes']) c[f] = rep(c[f]);
            c.appearance = c.appearance.map(rep);
            c.abilities = c.abilities.map(rep);
            c.experiences.forEach((e) => (e.text = rep(e.text)));
            c.aliases = c.aliases.map(rep);
        }
    }
    if (scope.includes('cards')) {
        for (const card of project.cards) {
            for (const [k, v] of Object.entries(card.data || {})) {
                if (typeof v === 'string') card.data[k] = rep(v);
                else if (Array.isArray(v)) card.data[k] = v.map(rep);
            }
        }
    }
    return count;
}

/** 统计匹配数（不修改） */
export function countMatches(project, opts) {
    const clone = JSON.parse(JSON.stringify({ worldbook: project.worldbook, characters: project.characters, cards: project.cards }));
    return findReplace(clone, opts);
}
