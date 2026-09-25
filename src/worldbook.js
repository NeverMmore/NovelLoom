// 项目 → 世界书（ST 格式 / 角色卡内嵌 character_book）以及反向导入

import { buildOutlineText, characterAt, characterProfileText, chunkOutlineText, entryAt } from './project.js';
import { getStyleProfile, styleEntryText } from './style.js';
import { uniq } from './utils.js';

/**
 * 生成逻辑条目列表
 * @param {object} project
 * @param {object} settings 全局设置（categories / worldbook / extraction）
 * @param {{excludeCharacters?: string[], uptoChunk?: number, onlyCategories?: string[], volume?: object, volumeScope?: 'volume'|'cumulative'}} opt
 *   volume：只生成某一卷的世界书（内容截至卷末）；volumeScope=volume 时只含本卷出场的实体
 */
export function buildWorldbookEntries(project, settings, opt = {}) {
    const cats = settings.categories || [];
    const wbs = settings.worldbook || {};
    const ex = settings.extraction || {};
    const vol = opt.volume || null;
    const onlyVol = !!vol && (opt.volumeScope || wbs.volumeScope || 'volume') === 'volume';
    const upto = vol ? vol.endChunk : Number.isFinite(opt.uptoChunk) ? opt.uptoChunk : Infinity;
    const inVol = (list) => !onlyVol || !list?.length || list.some((c) => c >= vol.startChunk && c <= vol.endChunk);
    const exclude = new Set(opt.excludeCharacters || []);
    const out = [];

    for (const cat of cats) {
        if (!cat.enabled) continue;
        if (opt.onlyCategories && !opt.onlyCategories.includes(cat.name)) continue;
        let idx = 0;
        const nextOrder = (override) => {
            if (override !== undefined && override !== '' && override !== null) return Number(override);
            const o = cat.autoIncrement ? Number(cat.order) + idx : Number(cat.order);
            idx++;
            return o;
        };

        if (cat.name === '角色') {
            const chars = Object.values(project.characters)
                .filter((c) => !exclude.has(c.name))
                .filter((c) => !Number.isFinite(upto) || c.firstChunk <= upto)
                .filter((c) => inVol(c.chunksSeen))
                .sort((a, b) => a.firstChunk - b.firstChunk);
            for (const raw of chars) {
                const c = characterAt(raw, upto);
                if (onlyVol) {
                    c.experiences = c.experiences.filter((e) => e.chunk >= vol.startChunk);
                    c.quotes = c.quotes.filter((q) => q.chunk === undefined || q.chunk >= vol.startChunk);
                }
                const cfg = raw.entryConfig || {};
                out.push({
                    category: '角色',
                    name: c.name,
                    keywords: uniq([c.name, ...c.aliases]),
                    content: characterProfileText(c, { maxExperiences: ex.maxExperiences ?? 12, maxQuotes: ex.maxQuotes ?? 8 }),
                    constant: cfg.constant ?? cat.constant,
                    position: Number(cfg.position ?? cat.position),
                    depth: Number(cfg.depth ?? cat.depth),
                    order: nextOrder(cfg.order),
                    disable: !!cfg.disable,
                    updatedAt: raw.updatedAt || 0,
                });
            }
            continue;
        }

        const entries = project.worldbook[cat.name] || {};
        for (const e of Object.values(entries)) {
            const srcs = (e.sourceChunks || []).filter((x) => x >= 0);
            if (Number.isFinite(upto) && srcs.length && Math.min(...srcs) > upto) continue;
            if (!inVol(srcs)) continue;
            const content = entryAt(e, upto);
            if (content === null || !String(content).trim()) continue;
            const cfg = e.config || {};
            out.push({
                category: cat.name,
                name: e.name,
                keywords: uniq(e.keywords?.length ? e.keywords : [e.name]),
                content,
                constant: cfg.constant ?? cat.constant,
                position: Number(cfg.position ?? cat.position),
                depth: Number(cfg.depth ?? cat.depth),
                order: nextOrder(cfg.order),
                disable: !!cfg.disable,
                updatedAt: e.updatedAt || 0,
            });
        }
    }

    // 不在分类表里的“孤儿”分类（例如导入的），按绿灯处理
    const known = new Set(cats.map((c) => c.name));
    for (const [catName, entries] of Object.entries(project.worldbook)) {
        if (known.has(catName)) continue;
        if (opt.onlyCategories && !opt.onlyCategories.includes(catName)) continue;
        let i = 0;
        for (const e of Object.values(entries)) {
            const cfg = e.config || {};
            out.push({
                category: catName, name: e.name, keywords: uniq(e.keywords?.length ? e.keywords : [e.name]), content: e.content,
                constant: cfg.constant ?? false, position: Number(cfg.position ?? 0), depth: Number(cfg.depth ?? 4), order: Number(cfg.order ?? 600 + i++), disable: !!cfg.disable, updatedAt: e.updatedAt || 0,
            });
        }
    }

    if (!opt.onlyCategories && wbs.includeOutlineEntry && onlyVol) {
        const notes = project.chunks.slice(vol.startChunk, vol.endChunk + 1).filter((c) => c.outline?.length).map((c) => `【${c.title}】\n${chunkOutlineText(c)}`).join('\n').slice(0, 4000);
        const text = [vol.summary && `本卷梗概：${vol.summary}`, notes].filter(Boolean).join('\n\n');
        if (text) out.push({ category: '剧情', name: `剧情大纲·${vol.name}`, keywords: ['剧情大纲'], content: text, constant: true, position: 0, depth: 4, order: 5, disable: false });
    } else if (!opt.onlyCategories && wbs.includeOutlineEntry) {
        const outline = buildOutlineText(project, upto, 4000);
        const summary = Number.isFinite(upto) && project.outline?.summaryUpTo > upto ? '' : project.outline?.summary;
        if (outline || summary) {
            out.push({
                category: '剧情', name: '剧情大纲', keywords: ['剧情大纲'],
                content: summary ? `${summary}\n\n${outline}`.trim() : outline,
                constant: true, position: 0, depth: 4, order: 5, disable: false,
            });
        }
    }
    if (!opt.onlyCategories && wbs.includeStyleEntry) {
        const t = styleEntryText(getStyleProfile(project, settings, 'card'), settings);
        if (t) out.push({ category: '文风', name: '文风', keywords: ['文风'], content: t, constant: true, position: 4, depth: 4, order: 1, disable: false });
    }

    for (const d of settings.defaultEntries || []) {
        if (!d?.name || !d?.content) continue;
        out.push({
            category: d.category || '默认', name: d.name, keywords: uniq(d.keywords?.length ? d.keywords : [d.name]), content: d.content,
            constant: !!d.constant, position: Number(d.position ?? 0), depth: Number(d.depth ?? 4), order: Number(d.order ?? 50), disable: false,
        });
    }
    return out;
}

/** 转为 ST 世界书文件格式 {entries: {uid: entry}} */
export function toSTWorld(entries, { allowRecursion = false, name = '', description = '' } = {}) {
    const result = { entries: {} };
    entries.forEach((e, i) => {
        result.entries[i] = {
            uid: i,
            key: e.keywords,
            keysecondary: [],
            comment: `${e.category} - ${e.name}`,
            content: e.content,
            constant: !!e.constant,
            vectorized: false,
            selective: true,
            selectiveLogic: 0,
            addMemo: true,
            order: e.order,
            position: e.position,
            disable: !!e.disable,
            ignoreBudget: false,
            excludeRecursion: !allowRecursion,
            preventRecursion: !allowRecursion,
            matchPersonaDescription: false,
            matchCharacterDescription: false,
            matchCharacterPersonality: false,
            matchCharacterDepthPrompt: false,
            matchScenario: false,
            matchCreatorNotes: false,
            delayUntilRecursion: false,
            probability: 100,
            useProbability: true,
            depth: e.depth,
            outletName: '',
            group: '',
            groupOverride: false,
            groupWeight: 100,
            scanDepth: null,
            caseSensitive: null,
            matchWholeWords: null,
            useGroupScoring: null,
            automationId: '',
            role: 0,
            sticky: null,
            cooldown: null,
            delay: null,
            triggers: [],
            displayIndex: i,
        };
    });
    if (name || description) result.originalData = { name, description };
    return result;
}

/** 转为角色卡 V2/V3 的 character_book */
export function toCharacterBook(entries, name, { allowRecursion = false } = {}) {
    return {
        name,
        description: '',
        scan_depth: 2,
        token_budget: 2048,
        recursive_scanning: allowRecursion,
        extensions: {},
        entries: entries.map((e, i) => ({
            id: i,
            keys: e.keywords,
            secondary_keys: [],
            comment: `${e.category} - ${e.name}`,
            content: e.content,
            constant: !!e.constant,
            selective: true,
            insertion_order: e.order,
            enabled: !e.disable,
            position: e.position === 0 ? 'before_char' : 'after_char',
            use_regex: true,
            extensions: {
                position: e.position,
                exclude_recursion: !allowRecursion,
                prevent_recursion: !allowRecursion,
                delay_until_recursion: false,
                display_index: i,
                probability: 100,
                useProbability: true,
                depth: e.depth,
                selectiveLogic: 0,
                group: '',
                group_override: false,
                group_weight: 100,
                scan_depth: null,
                case_sensitive: null,
                match_whole_words: null,
                use_group_scoring: false,
                automation_id: '',
                role: 0,
                vectorized: false,
                sticky: null,
                cooldown: null,
                delay: null,
                triggers: [],
                ignore_budget: false,
            },
        })),
    };
}

/**
 * 解析外部世界书（ST 世界书文件 / 角色卡 character_book / 本插件导出）为逻辑条目
 * @returns {{category:string,name:string,keywords:string[],content:string,constant:boolean,position:number,depth:number,order:number}[]}
 */
export function parseExternalWorld(json) {
    let list = [];
    if (json?.entries && !Array.isArray(json.entries)) list = Object.values(json.entries);
    else if (Array.isArray(json?.entries)) list = json.entries;
    else if (json?.data?.character_book?.entries) list = json.data.character_book.entries;
    else if (json?.character_book?.entries) list = json.character_book.entries;
    const out = [];
    for (const e of list) {
        if (!e) continue;
        const comment = String(e.comment ?? e.name ?? '');
        const m = comment.match(/^(.+?)\s+-\s+(.+)$/);
        const keys = e.key ?? e.keys ?? [];
        const name = (m ? m[2] : comment) || (Array.isArray(keys) ? keys[0] : '') || '未命名';
        out.push({
            category: m ? m[1] : '导入',
            name: String(name).trim(),
            keywords: uniq(Array.isArray(keys) ? keys : String(keys).split(',')),
            content: String(e.content ?? ''),
            constant: !!e.constant,
            position: Number(e.extensions?.position ?? e.position ?? 0) || 0,
            depth: Number(e.depth ?? e.extensions?.depth ?? 4),
            order: Number(e.order ?? e.insertion_order ?? 100),
        });
    }
    return out.filter((e) => e.content);
}
