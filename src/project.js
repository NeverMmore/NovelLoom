// 项目数据模型、实体合并、世界书构建
// 设计参考：ai4rpg/tavern-cards 的故事大纲规范（章节概要 / 角色 identity·personality·relationship / 原文引用逐字校验）

import { normalizeProjectStyle, PROJECT_STYLE_ID } from './style.js';
import { hashString, normalizeForMatch, structuredCloneSafe, uid, uniq } from './utils.js';

export const IMPORTANCE_RANK = { main: 3, support: 2, minor: 1 };

export function createProject({ name, fileName = '', encoding = '', text = '', chunks = [] }) {
    const now = Date.now();
    return {
        id: uid('p_'),
        version: 1,
        name: name || fileName.replace(/\.[^.]+$/, '') || '未命名项目',
        bookName: name || fileName.replace(/\.[^.]+$/, '') || '未命名',
        createdAt: now,
        updatedAt: now,
        source: { fileName, encoding, totalChars: text.length, hash: hashString(text) },
        chunks,
        characters: {},
        worldbook: {},
        outline: { summary: '', summaryUpTo: -1 },
        style: { perspective: '', tone: '', mood: '', rules: '', notes: '', samples: [], banned: '' },
        /** 各任务使用的文风：值为 __project（本书原著文风）/ 预设 id / __none；任务值为空时沿用 default */
        styleUse: { default: PROJECT_STYLE_ID, card: '', plan: '', continue: '' },
        /** 多视角管理：{角色名: 文风预设id}；某章大纲指定了 pov 角色时，续写优先用该角色映射的文风 */
        povStyles: {},
        missingNames: [],
        cards: [],
        continuation: { chapters: [] },
        volumes: [],
        relationships: [],
        groupCards: [],
        /** 伏笔看板：结构化追踪伏笔的埋下与回收（章号引用大纲 plan.chapters 的 no） */
        foreshadow: [],
        /** 疑似敏感词被 AI 换成拼音/注音等替代写法（本地扫描提取结果发现，不消耗 token）：{id, chunk, field, text, createdAt} */
        censorFlags: [],
        plan: { chapters: [], arcs: [] },
        stats: { calls: 0, failures: 0, promptChars: 0, completionChars: 0 },
    };
}

/** 兼容旧数据/导入数据，补齐字段 */
export function normalizeProject(p) {
    const base = createProject({ name: p?.name });
    const out = { ...base, ...p };
    out.chunks = Array.isArray(out.chunks) ? out.chunks : [];
    out.chunks.forEach((c, i) => {
        c.index = i;
        c.outline = Array.isArray(c.outline) ? c.outline : [];
        c.important = Array.isArray(c.important) ? c.important : [];
        c.status = c.status || 'pending';
        c.origin = c.origin || 'source';
        c.charCount = c.content?.length || 0;
    });
    out.characters = out.characters && typeof out.characters === 'object' ? out.characters : {};
    for (const [k, ch] of Object.entries(out.characters)) out.characters[k] = normalizeCharacter({ ...ch, name: ch.name || k });
    out.worldbook = out.worldbook && typeof out.worldbook === 'object' ? out.worldbook : {};
    for (const cat of Object.values(out.worldbook)) {
        for (const e of Object.values(cat || {})) {
            if (!Array.isArray(e.revisions)) e.revisions = [];
            if (!Array.isArray(e.sourceChunks)) e.sourceChunks = [];
        }
    }
    out.volumes = Array.isArray(out.volumes) ? out.volumes.filter((v) => v && Number.isFinite(v.startChunk)) : [];
    out.plan = { chapters: [], arcs: [], ...(out.plan || {}) };
    out.plan.chapters = Array.isArray(out.plan.chapters) ? out.plan.chapters : [];
    out.plan.arcs = Array.isArray(out.plan.arcs) ? out.plan.arcs : [];
    out.outline = { ...base.outline, ...(out.outline || {}) };
    out.style = { ...base.style, ...(out.style || {}) };
    normalizeProjectStyle(out);
    out.cards = Array.isArray(out.cards) ? out.cards : [];
    out.relationships = Array.isArray(out.relationships)
        ? out.relationships
              .filter((r) => r && r.from && r.to && r.from !== r.to)
              .map((r) => ({
                  id: r.id || uid('rel_'),
                  from: String(r.from).trim(),
                  to: String(r.to).trim(),
                  type: r.type || 'other',
                  label: String(r.label || '').trim(),
                  mutual: !!r.mutual,
                  notes: String(r.notes || '').trim(),
                  chunk: Number.isFinite(r.chunk) ? r.chunk : 0,
                  auto: !!r.auto,
                  updatedAt: r.updatedAt || Date.now(),
              }))
        : [];
    out.groupCards = Array.isArray(out.groupCards)
        ? out.groupCards
              .filter((g) => g && Array.isArray(g.members) && g.members.length >= 2)
              .map((g) => ({
                  id: g.id || uid('grp_'),
                  name: String(g.name || g.members.join('、')).trim(),
                  members: uniq(g.members),
                  timepoint: Number.isFinite(g.timepoint) ? g.timepoint : null,
                  requirement: String(g.requirement || ''),
                  data: {
                      scenario: String(g.data?.scenario || ''),
                      first_mes: String(g.data?.first_mes || ''),
                      notes: g.data?.notes && typeof g.data.notes === 'object' ? g.data.notes : {},
                  },
                  createdAt: g.createdAt || Date.now(),
                  updatedAt: g.updatedAt || Date.now(),
                  stGroupId: String(g.stGroupId || ''),
                  publishedAt: g.publishedAt || 0,
              }))
        : [];
    out.continuation = { chapters: [], ...(out.continuation || {}) };
    out.povStyles = out.povStyles && typeof out.povStyles === 'object' ? out.povStyles : {};
    out.foreshadow = Array.isArray(out.foreshadow)
        ? out.foreshadow
              .filter((f) => f && String(f.text || '').trim())
              .map((f) => ({
                  id: f.id || uid('fs_'),
                  text: String(f.text || '').trim(),
                  status: f.status === 'resolved' ? 'resolved' : 'open',
                  plantedNo: Number.isFinite(f.plantedNo) ? f.plantedNo : null,
                  resolvedNo: Number.isFinite(f.resolvedNo) ? f.resolvedNo : null,
                  notes: String(f.notes || ''),
                  auto: !!f.auto,
                  createdAt: f.createdAt || Date.now(),
                  updatedAt: f.updatedAt || Date.now(),
              }))
        : [];
    out.stats = { ...base.stats, ...(out.stats || {}) };
    out.missingNames = Array.isArray(out.missingNames) ? out.missingNames : [];
    out.censorFlags = Array.isArray(out.censorFlags)
        ? out.censorFlags
              .filter((f) => f && String(f.text || '').trim())
              .map((f) => ({
                  id: f.id || uid('cf_'),
                  chunk: Number.isFinite(f.chunk) ? f.chunk : 0,
                  field: String(f.field || '').trim(),
                  text: String(f.text || '').trim(),
                  createdAt: f.createdAt || Date.now(),
              }))
        : [];
    return out;
}

export function normalizeCharacter(c = {}) {
    return {
        name: String(c.name || '').trim(),
        aliases: uniq(c.aliases),
        gender: c.gender || '',
        age: c.age || '',
        identity: c.identity || '',
        personality: c.personality || '',
        relationship: c.relationship || '',
        appearance: uniq(c.appearance),
        abilities: uniq(c.abilities),
        /** 人格颗粒度：绝对不会做的事 / 忌讳话题（雷点） / 口癖与说话习惯——比整段 personality 更利于 AI 把角色演稳 */
        hardLimits: uniq(c.hardLimits),
        tabooTopics: uniq(c.tabooTopics),
        verbalTics: uniq(c.verbalTics),
        experiences: Array.isArray(c.experiences) ? c.experiences : [],
        /** 从原文抓取的真实多轮对白（verbatim，用于 mes_example 保住对话节奏），区别于 quotes（单句台词） */
        dialogues: Array.isArray(c.dialogues) ? c.dialogues : [],
        quotes: Array.isArray(c.quotes) ? c.quotes : [],
        importance: c.importance in IMPORTANCE_RANK ? c.importance : 'minor',
        chunksSeen: Array.isArray(c.chunksSeen) ? c.chunksSeen : [],
        firstChunk: Number.isFinite(c.firstChunk) ? c.firstChunk : Infinity,
        lastChunk: Number.isFinite(c.lastChunk) ? c.lastChunk : -1,
        stages: Array.isArray(c.stages) ? c.stages : [],
        locked: !!c.locked,
        /** 手动新建的角色：重新提取时不会因为“没有出处”被删除 */
        manual: !!c.manual,
        /** 别名的出处：{别名: [分段序号...]}，只记录提取时 AI 带进来的别名；重新提取某段时清掉只来自这一段的别名。手动加的、旧数据里的别名没有记录，一直保留 */
        aliasSources: c.aliasSources && typeof c.aliasSources === 'object' && !Array.isArray(c.aliasSources) ? c.aliasSources : {},
        notes: c.notes || '',
        /** NSFW 补充资料：与身份/性格/外貌等日常向字段分开存放，生成角色卡时可选择是否带上（见 characterProfileText 的 withNsfw） */
        nsfwNotes: c.nsfwNotes || '',
        entryConfig: c.entryConfig || {},
        updatedAt: c.updatedAt || Date.now(),
    };
}

// ---------------- 查找 ----------------

/**
 * 太泛的称呼：很多角色都会被这样叫，只凭它们不能认定是同一个人。
 * 单个字的别名（如“林”）同理，见 isSpecificAlias。
 */
export const GENERIC_ALIASES = new Set([
    '他', '她', '它', '我', '你', '您', '他们', '她们', '我们', '你们', '对方', '那人', '此人', '某人', '众人', '主角', '男主', '女主', '男主角', '女主角',
    '少爷', '小姐', '大小姐', '公子', '姑娘', '少女', '少年', '男人', '女人', '男子', '女子', '老人', '孩子', '小孩', '小鬼', '丫头', '小子',
    '老师', '师父', '师傅', '师尊', '师兄', '师姐', '师弟', '师妹', '前辈', '学长', '学姐', '学弟', '学妹', '同学', '班长', '队长', '老板', '老大', '大哥', '大姐',
    '主人', '主上', '大人', '殿下', '陛下', '王爷', '王妃', '皇上', '公主', '王子', '先生', '女士', '夫人', '太太', '老婆', '老公', '妻子', '丈夫', '相公', '娘子',
    '父亲', '母亲', '爸爸', '妈妈', '爸', '妈', '爹', '娘', '哥哥', '姐姐', '弟弟', '妹妹', '哥', '姐', '弟', '妹', '叔叔', '阿姨', '爷爷', '奶奶', '外公', '外婆',
    '魔女', '魔王', '勇者', '圣女', '神', '女神', '医生', '护士', '警察', '店长', '掌柜', '管家', '女仆', '仆人', '侍女', '侍卫', '将军', '宗主', '掌门', '长老',
]);

/** 能否凭这个别名认定是同一个角色：至少两个字，且不是泛称 */
export function isSpecificAlias(alias) {
    const s = String(alias || '').trim();
    return s.length >= 2 && !GENERIC_ALIASES.has(s);
}

/**
 * 找到与 AI 输出的名字对应的已有角色。
 * 规则（避免不同角色被“滚雪球”式地并到一起）：
 * 1. 名字与已有角色名完全相同 → 就是它；
 * 2. 名字是某个已有角色的别名 → 只有唯一匹配时才算；
 * 3. 别名与已有角色的名字/别名相同 → 只认够具体的别名（isSpecificAlias），且只有唯一匹配时才算；
 * 匹配到多个角色时视为有歧义，不合并（返回 null，按新角色处理，之后可在角色页手动合并）。
 */
export function findCharacterKey(project, name, aliases = []) {
    const n = String(name || '').trim();
    if (!n) return null;
    if (project.characters[n]) return n;
    const entries = Object.entries(project.characters);
    const byName = entries.filter(([, ch]) => (ch.aliases || []).includes(n)).map(([key]) => key);
    const specific = uniq(aliases).filter((a) => a !== n && isSpecificAlias(a));
    const byAlias = entries
        .filter(([key, ch]) => specific.some((a) => a === key || (ch.aliases || []).includes(a)))
        .map(([key]) => key);
    if (byName.length === 1) {
        // 名字只指向一个角色，但具体别名指向的是别人：名字是泛称时信别名，否则视为有歧义
        if (!byAlias.length || byAlias.includes(byName[0])) return byName[0];
        if (!isSpecificAlias(n)) return byAlias.length === 1 ? byAlias[0] : null;
        return null;
    }
    // 名字有歧义时，用具体别名帮忙确认是哪一个
    if (byName.length > 1) {
        const both = byName.filter((k) => byAlias.includes(k));
        return both.length === 1 ? both[0] : null;
    }
    return byAlias.length === 1 ? byAlias[0] : null;
}

export function findEntryKey(project, category, name, keywords = []) {
    const cat = project.worldbook[category];
    if (!cat) return null;
    const n = String(name || '').trim();
    if (cat[n]) return n;
    for (const [key, e] of Object.entries(cat)) {
        if ((e.keywords || []).includes(n)) return key;
        if (keywords.includes(key)) return key;
    }
    return null;
}

// ---------------- 解析 AI 输出 ----------------

const FIELD_ALIASES = {
    name: ['name', '名称', '姓名', '名字'],
    aliases: ['aliases', 'alias', '别名', '称呼'],
    gender: ['gender', '性别'],
    age: ['age', '年龄', 'birth_year'],
    identity: ['identity', '身份'],
    personality: ['personality', '性格'],
    relationship: ['relationship', '关系'],
    appearance: ['appearance', '外貌', '外貌特征'],
    abilities: ['abilities', '能力', '技能'],
    hardLimits: ['hardLimits', 'hard_limits', '绝对不做', '绝对不会做的事', '底线'],
    tabooTopics: ['tabooTopics', 'taboo_topics', '忌讳话题', '雷点', '禁忌话题'],
    verbalTics: ['verbalTics', 'verbal_tics', '口癖', '说话习惯', '口头禅'],
    experiences: ['experiences', 'experience', '经历', '本段经历', 'events'],
    dialogues: ['dialogues', 'dialogue', '对话样本', '对白样本', '对话片段'],
    quotes: ['quotes', '引用', '台词', '原文引用'],
    importance: ['importance', '重要度', 'role'],
    keywords: ['keywords', 'keys', '关键词'],
    content: ['content', '内容', 'description', 'summary', '描述'],
};

function pick(obj, field) {
    if (!obj || typeof obj !== 'object') return undefined;
    for (const k of FIELD_ALIASES[field] || [field]) {
        if (obj[k] !== undefined && obj[k] !== null && obj[k] !== '') return obj[k];
    }
    return undefined;
}

const SEP_SENTENCE = /[\n；;]+/;
const SEP_WORD = /[\n；;、,，/]+/;

function toList(v, sep = SEP_SENTENCE) {
    if (v === undefined || v === null || v === '') return [];
    if (Array.isArray(v)) return v;
    if (typeof v === 'string') return v.split(sep).map((x) => x.replace(/^[-*•\s]+/, '').trim()).filter(Boolean);
    return [v];
}

function toText(v) {
    if (v === undefined || v === null) return '';
    if (Array.isArray(v)) return v.map(toText).filter(Boolean).join('；');
    if (typeof v === 'object') return Object.entries(v).map(([k, x]) => `${k}: ${toText(x)}`).join('\n');
    return String(v).trim();
}

function normImportance(v) {
    const s = String(v || '').toLowerCase();
    if (/main|主角|核心|主要/.test(s)) return 'main';
    if (/support|配角|重要/.test(s)) return 'support';
    return 'minor';
}

function normQuotes(v) {
    return (typeof v === 'string' ? [v] : toList(v))
        .map((q) => (typeof q === 'string' ? { text: q } : q))
        .filter((q) => q && q.text)
        .map((q) => ({ text: String(q.text).trim(), context: toText(q.context || q.上下文 || ''), function: toText(q.function || q.用途 || '') }));
}

/** 对话样本：一来一回的多轮原文对白（与 quotes 的单句台词不同），逐字保留换行 */
function normDialogues(v) {
    if (v === undefined || v === null || v === '') return [];
    const list = Array.isArray(v) ? v : [v];
    return list
        .map((d) => (typeof d === 'string' ? { text: d } : d))
        .filter((d) => d && (d.text || d.内容))
        .map((d) => ({ text: String(d.text || d.内容).trim() }))
        .filter((d) => d.text);
}

/**
 * 规范化一次提取的 JSON 结果
 * @returns {{chapters:{name:string,notes:string}[], characters:object[], entries:Record<string,object[]>, important:object[], style:object|null, missingNames:object[]}}
 */
export function normalizeExtraction(json, categoryNames = []) {
    const src = json && typeof json === 'object' ? json : {};
    const out = { chapters: [], characters: [], entries: {}, important: [], style: null, missingNames: [] };

    const chapters = src.chapters || src.章节 || src.outline || src.大纲 || [];
    for (const c of toList(chapters)) {
        if (typeof c === 'string') out.chapters.push({ name: '', notes: c });
        else if (c) out.chapters.push({ name: toText(c.name || c.章节 || c.title || ''), notes: toText(c.notes || c.概要 || c.summary || '') });
    }

    const chars = [...toList(src.characters || src.角色 || [])];
    const entriesSrc = src.entries || src.世界书 || src.条目 || {};
    if (entriesSrc && typeof entriesSrc === 'object') {
        for (const [cat, list] of Object.entries(entriesSrc)) {
            if (cat === '角色' || cat === 'characters') {
                chars.push(...toList(list));
                continue;
            }
            const items = Array.isArray(list)
                ? list
                : (list && typeof list === 'object' ? Object.entries(list).map(([name, v]) => ({ name, ...(typeof v === 'object' ? v : { content: v }) })) : []);
            const norm = items
                .map((e) => ({
                    name: toText(pick(e, 'name')),
                    keywords: uniq(toList(pick(e, 'keywords'), SEP_WORD).map(String)),
                    content: toText(pick(e, 'content')),
                }))
                .filter((e) => e.name && e.content);
            if (norm.length) out.entries[cat] = (out.entries[cat] || []).concat(norm);
        }
    }
    // 兼容：分类直接放在顶层（如 {"地点": [...]}）
    for (const cat of categoryNames) {
        if (cat === '角色' || out.entries[cat] || !Array.isArray(src[cat])) continue;
        out.entries[cat] = src[cat]
              .map((e) => ({ name: toText(pick(e, 'name')), keywords: uniq(toList(pick(e, 'keywords'), SEP_WORD).map(String)), content: toText(pick(e, 'content')) }))
            .filter((e) => e.name && e.content);
    }

    for (const c of chars) {
        if (!c || typeof c !== 'object') continue;
        const name = toText(pick(c, 'name'));
        if (!name) continue;
        out.characters.push({
            name,
            aliases: uniq(toList(pick(c, 'aliases'), SEP_WORD).map(String)).filter((a) => a !== name),
            gender: toText(pick(c, 'gender')),
            age: toText(pick(c, 'age')),
            identity: toText(pick(c, 'identity')),
            personality: toText(pick(c, 'personality')),
            relationship: toText(pick(c, 'relationship')),
            appearance: uniq(toList(pick(c, 'appearance')).map(toText)),
            abilities: uniq(toList(pick(c, 'abilities')).map(toText)),
            hardLimits: uniq(toList(pick(c, 'hardLimits')).map(toText)),
            tabooTopics: uniq(toList(pick(c, 'tabooTopics')).map(toText)),
            verbalTics: uniq(toList(pick(c, 'verbalTics')).map(toText)),
            experiences: uniq(toList(pick(c, 'experiences')).map(toText)),
            dialogues: normDialogues(pick(c, 'dialogues')),
            quotes: normQuotes(pick(c, 'quotes')),
            importance: normImportance(pick(c, 'importance')),
        });
    }

    for (const imp of toList(src.important || src.important_chapters || src.重要章节 || [])) {
        if (!imp || typeof imp !== 'object') continue;
        out.important.push({ chapter: toText(imp.chapter || imp.章节 || ''), reason: toText(imp.reason || imp.原因 || ''), quotes: normQuotes(imp.quotes) });
    }

    const st = src.style || src.style_hints || src.文风;
    if (st && typeof st === 'object') {
        out.style = {
            perspective: toText(st.perspective || st.视角 || ''),
            tone: toText(st.tone || st.语言 || st.语言风格 || ''),
            mood: toText(st.mood || st.基调 || st.情绪基调 || ''),
            notes: toText(st.notes || st.备注 || ''),
        };
    }

    for (const m of toList(src.missing_names || src.missingNames || src.缺失名称 || [])) {
        if (m && typeof m === 'object') out.missingNames.push({ type: toText(m.type || m.类型 || ''), vague: toText(m.vague || m.名称 || m.name || ''), context: toText(m.context || m.上下文 || ''), suggest: toText(m.suggest || m.建议 || '') });
    }
    return out;
}

// ---------------- 引用校验 ----------------

export function verifyQuote(quoteText, sourceText) {
    const q = normalizeForMatch(quoteText);
    if (q.length < 2) return false;
    return normalizeForMatch(sourceText).includes(q);
}

// ---------------- 合并 ----------------

/**
 * 合并一个角色
 * @param {object} project
 * @param {object} incoming normalizeExtraction 输出的角色
 * @param {number} chunkIndex
 * @param {{replace?: boolean, sourceText?: string, verify?: boolean, maxQuotesStore?: number}} opt
 *   replace=true 表示 AI 在提示中看到了该角色的完整旧档案，输出为“更新后的版本”
 */
export function mergeCharacter(project, incoming, chunkIndex, opt = {}) {
    const key = findCharacterKey(project, incoming.name, incoming.aliases);
    const isNew = !key;
    const ch = isNew ? normalizeCharacter({ name: incoming.name }) : project.characters[key];
    if (isNew) project.characters[ch.name] = ch;

    // 别名：若 AI 用了别名作为 name，把它记入别名。
    // 不收下属于其他角色的名字，也不收已被其他角色占用的具体别名，避免以后把别人并进来（泛称可以多人共用，匹配时本来就不认）
    const ownedByOther = (a) => Object.entries(project.characters).some(([k, c]) => c !== ch && (k === a || (isSpecificAlias(a) && (c.aliases || []).includes(a))));
    const allNames = uniq([incoming.name, ...(incoming.aliases || [])]).filter((n) => n !== ch.name && !ownedByOther(n));
    if (!ch.aliasSources || typeof ch.aliasSources !== 'object') ch.aliasSources = {};
    for (const a of allNames) {
        // 只给“本次新加的”或“已经有出处记录的”别名记出处；没有记录的旧别名视为手动/旧数据，保持永久
        if (!ch.aliases.includes(a)) ch.aliasSources[a] = [chunkIndex];
        else if (Array.isArray(ch.aliasSources[a]) && !ch.aliasSources[a].includes(chunkIndex)) ch.aliasSources[a].push(chunkIndex);
    }
    ch.aliases = uniq([...ch.aliases, ...allNames]);

    const isLatest = chunkIndex >= ch.lastChunk;
    const stageChange = {};
    const unapplied = [];
    for (const f of ['gender', 'age']) {
        if (incoming[f] && (!ch[f] || (isLatest && !ch.locked))) ch[f] = incoming[f];
    }
    for (const f of ['identity', 'personality', 'relationship']) {
        const v = incoming[f];
        if (!v || v === ch[f]) continue;
        if (!ch[f]) {
            ch[f] = v;
            stageChange[f] = v;
        } else if (!ch.locked && (opt.replace || isLatest)) {
            ch[f] = v;
            stageChange[f] = v;
        } else {
            stageChange[f] = v;
            unapplied.push(f);
        }
    }
    if (Object.keys(stageChange).length) {
        ch.stages.push({ chunk: chunkIndex, ...stageChange, ...(unapplied.length ? { unapplied } : {}) });
        ch.stages.sort((a, b) => a.chunk - b.chunk);
        if (ch.stages.length > 40) ch.stages.splice(0, ch.stages.length - 40);
    }
    ch.appearance = uniq([...ch.appearance, ...(incoming.appearance || [])]).slice(0, 16);
    ch.abilities = uniq([...ch.abilities, ...(incoming.abilities || [])]).slice(0, 16);
    ch.hardLimits = uniq([...ch.hardLimits, ...(incoming.hardLimits || [])]).slice(0, 16);
    ch.tabooTopics = uniq([...ch.tabooTopics, ...(incoming.tabooTopics || [])]).slice(0, 16);
    ch.verbalTics = uniq([...ch.verbalTics, ...(incoming.verbalTics || [])]).slice(0, 16);

    const dlgSet = new Set(ch.dialogues.map((d) => normalizeForMatch(d.text)));
    for (const d of incoming.dialogues || []) {
        const n = normalizeForMatch(d.text);
        if (!n || dlgSet.has(n)) continue;
        const verified = opt.sourceText ? verifyQuote(d.text, opt.sourceText) : null;
        if (opt.verify && verified === false) continue;
        ch.dialogues.push({ text: d.text, chunk: chunkIndex, verified });
        dlgSet.add(n);
    }
    if (ch.dialogues.length > 12) ch.dialogues.splice(0, ch.dialogues.length - 12);

    const expSet = new Set(ch.experiences.map((e) => e.text));
    for (const t of incoming.experiences || []) {
        if (!expSet.has(t)) {
            ch.experiences.push({ chunk: chunkIndex, text: t });
            expSet.add(t);
        }
    }
    ch.experiences.sort((a, b) => a.chunk - b.chunk);
    if (ch.experiences.length > 80) ch.experiences.splice(0, ch.experiences.length - 80);

    const qSet = new Set(ch.quotes.map((q) => normalizeForMatch(q.text)));
    for (const q of incoming.quotes || []) {
        const n = normalizeForMatch(q.text);
        if (!n || qSet.has(n)) continue;
        const verified = opt.sourceText ? verifyQuote(q.text, opt.sourceText) : null;
        if (opt.verify && verified === false) continue;
        ch.quotes.push({ text: q.text, context: q.context || '', chunk: chunkIndex, verified });
        qSet.add(n);
    }
    const maxQ = opt.maxQuotesStore || 30;
    if (ch.quotes.length > maxQ) ch.quotes.splice(0, ch.quotes.length - maxQ);

    if (IMPORTANCE_RANK[incoming.importance] > IMPORTANCE_RANK[ch.importance]) ch.importance = incoming.importance;
    if (!ch.chunksSeen.includes(chunkIndex)) ch.chunksSeen.push(chunkIndex);
    ch.firstChunk = Math.min(ch.firstChunk, chunkIndex);
    ch.lastChunk = Math.max(ch.lastChunk, chunkIndex);
    ch.updatedAt = Date.now();
    return { key: ch.name, isNew };
}

const MAX_REVISIONS = 30;

/** 条目在某个时间点（分块序号）时的内容；没有修订记录时返回当前内容；该时间点尚未出现则返回 null */
export function entryAt(e, uptoChunk = Infinity) {
    if (!Number.isFinite(uptoChunk) || !e.revisions?.length) return e.content;
    let hit = null;
    for (const r of e.revisions) if (r.chunk <= uptoChunk) hit = r;
    return hit ? hit.content : null;
}

/** 用户手动修改条目内容：当前内容与最新修订一起更新 */
export function setEntryContent(e, content) {
    e.content = content;
    if (e.revisions?.length) e.revisions[e.revisions.length - 1].content = content;
    e.updatedAt = Date.now();
}

function trimRevisions(e) {
    e.revisions.sort((a, b) => a.chunk - b.chunk);
    if (e.revisions.length > MAX_REVISIONS) e.revisions.splice(0, e.revisions.length - MAX_REVISIONS);
}

export function mergeEntry(project, category, incoming, chunkIndex, opt = {}) {
    if (!project.worldbook[category]) project.worldbook[category] = {};
    const cat = project.worldbook[category];
    const key = findEntryKey(project, category, incoming.name, incoming.keywords);
    const tracked = Number.isFinite(chunkIndex) && chunkIndex >= 0;
    if (!key) {
        cat[incoming.name] = {
            name: incoming.name,
            keywords: uniq([incoming.name, ...(incoming.keywords || [])]),
            content: incoming.content,
            sourceChunks: [chunkIndex],
            revisions: tracked ? [{ chunk: chunkIndex, content: incoming.content }] : [],
            config: {},
            locked: false,
            updatedAt: Date.now(),
        };
        return { key: incoming.name, isNew: true };
    }
    const e = cat[key];
    if (!Array.isArray(e.revisions)) e.revisions = [];
    e.keywords = uniq([...(e.keywords || []), ...(incoming.keywords || []), incoming.name !== key ? incoming.name : null]);
    if (!e.locked && incoming.content && incoming.content !== e.content) {
        const inc = incoming.content.trim();
        if (opt.replace) {
            if (tracked) {
                const same = e.revisions.find((r) => r.chunk === chunkIndex);
                if (same) same.content = inc;
                else e.revisions.push({ chunk: chunkIndex, content: inc });
                trimRevisions(e);
                e.content = e.revisions[e.revisions.length - 1].content;
            } else {
                e.content = inc;
            }
        } else if (!normalizeForMatch(e.content).includes(normalizeForMatch(inc))) {
            if (tracked && e.revisions.length) {
                // 追加：该时间点的版本 = 此前最近版本 + 新内容；更晚的版本也补上这段内容（乱序合并时保持一致）
                const before = [...e.revisions].reverse().find((r) => r.chunk < chunkIndex);
                const same = e.revisions.find((r) => r.chunk === chunkIndex);
                const base = same ? same.content : before ? before.content : '';
                const merged = base ? `${base.trim()}\n${inc}` : inc;
                if (same) same.content = merged;
                else e.revisions.push({ chunk: chunkIndex, content: merged });
                for (const r of e.revisions) {
                    if (r.chunk > chunkIndex && !normalizeForMatch(r.content).includes(normalizeForMatch(inc))) r.content = `${r.content.trim()}\n${inc}`;
                }
                trimRevisions(e);
                e.content = e.revisions[e.revisions.length - 1].content;
            } else {
                e.content = `${e.content.trim()}\n${inc}`;
                if (tracked) e.revisions.push({ chunk: chunkIndex, content: e.content });
            }
        }
    }
    if (!e.sourceChunks.includes(chunkIndex)) e.sourceChunks.push(chunkIndex);
    e.updatedAt = Date.now();
    return { key, isNew: false };
}

/**
 * 把一次提取结果合并进项目
 * @param {object} project
 * @param {object} chunk
 * @param {ReturnType<typeof normalizeExtraction>} result
 * @param {{fullContext?: Set<string>, verifyQuotes?: boolean}} opt fullContext: 在提示词中给出了完整旧内容的实体（"char:名" / "分类:名"）
 */
export function applyExtraction(project, chunk, result, opt = {}) {
    const idx = chunk.index;
    const full = opt.fullContext || new Set();
    const summary = { newCharacters: [], updatedCharacters: [], newEntries: [], updatedEntries: [] };

    chunk.outline = result.chapters.length ? result.chapters : chunk.outline;
    chunk.important = result.important.map((imp) => ({
        ...imp,
        quotes: imp.quotes
            .map((q) => ({ ...q, verified: verifyQuote(q.text, chunk.content) }))
            .filter((q) => !opt.verifyQuotes || q.verified),
    }));

    for (const c of result.characters) {
        const replace = full.has(`char:${findCharacterKey(project, c.name, c.aliases) || c.name}`);
        const r = mergeCharacter(project, c, idx, { replace, sourceText: chunk.content, verify: opt.verifyQuotes });
        (r.isNew ? summary.newCharacters : summary.updatedCharacters).push(r.key);
    }
    for (const [cat, list] of Object.entries(result.entries)) {
        for (const e of list) {
            const replace = full.has(`${cat}:${findEntryKey(project, cat, e.name, e.keywords) || e.name}`);
            const r = mergeEntry(project, cat, e, idx, { replace });
            (r.isNew ? summary.newEntries : summary.updatedEntries).push(`${cat}/${r.key}`);
        }
    }
    if (result.style) {
        for (const k of ['perspective', 'tone', 'mood', 'notes']) {
            if (result.style[k] && !project.style[k]) project.style[k] = result.style[k];
        }
    }
    for (const m of result.missingNames) {
        if (!project.missingNames.some((x) => x.vague === m.vague)) project.missingNames.push({ ...m, chunk: idx, resolved: '' });
    }
    return summary;
}

// ---------------- 疑似敏感词替换检测 ----------------
// 有些接口/模型会把它判定为“敏感”的字用拼音或注音符号代替，而不是直接拒绝整段——
// 结果就混进提取出的概要/角色资料/世界书里，不容易发现。这里本地扫描一次提取结果，
// 命中注音符号（正常小说正文几乎不会出现）就记下来，供「大纲」页提醒用户去核实。

const PHONETIC_RE = /[ㄅ-ㄯㆠ-ㆺ]/;

function collectPhoneticHits(result) {
    const hits = [];
    const check = (field, text) => {
        if (typeof text === 'string' && PHONETIC_RE.test(text)) hits.push({ field, text: text.trim() });
    };
    for (const c of result.chapters || []) {
        check(`章节概要·${c.name || '（无标题）'}`, c.name);
        check(`章节概要·${c.name || '（无标题）'}`, c.notes);
    }
    for (const c of result.characters || []) {
        const label = `角色·${c.name || '？'}`;
        for (const f of ['identity', 'personality', 'relationship', 'gender', 'age']) check(`${label}·${f}`, c[f]);
        for (const f of ['appearance', 'abilities', 'hardLimits', 'tabooTopics', 'verbalTics', 'aliases']) {
            for (const t of c[f] || []) check(`${label}·${f}`, t);
        }
        for (const e of c.experiences || []) check(`${label}·经历`, e?.text ?? e);
        for (const q of c.quotes || []) check(`${label}·原文台词`, q?.text ?? q);
        for (const d of c.dialogues || []) check(`${label}·对话样本`, d?.text ?? d);
    }
    for (const [cat, list] of Object.entries(result.entries || {})) {
        for (const e of list || []) {
            const label = `${cat}·${e.name || '？'}`;
            check(label, e.content);
            for (const k of e.keywords || []) check(`${label}·关键词`, k);
        }
    }
    for (const imp of result.important || []) {
        check(`重要章节·${imp.chapter || ''}`, imp.reason);
        for (const q of imp.quotes || []) check(`重要章节·${imp.chapter || ''}`, q?.text ?? q);
    }
    return hits;
}

export function ensureCensorFlags(project) {
    if (!Array.isArray(project.censorFlags)) project.censorFlags = [];
    return project.censorFlags;
}

/**
 * 本地扫描一次提取结果，把含注音符号（疑似敏感词被替换）的字段记进 project.censorFlags
 * @returns {number} 本次新增的条数
 */
export function scanCensorArtifacts(project, chunk, result) {
    const hits = collectPhoneticHits(result);
    if (!hits.length) return 0;
    const list = ensureCensorFlags(project);
    let added = 0;
    for (const h of hits) {
        if (!h.text) continue;
        if (list.some((f) => f.chunk === chunk.index && f.field === h.field && f.text === h.text)) continue;
        list.push({ id: uid('cf_'), chunk: chunk.index, field: h.field, text: h.text, createdAt: Date.now() });
        added++;
    }
    return added;
}

// ---------------- 时间点视图 ----------------

/** 获取某时间点（分块序号）时的角色视图：只包含该时间点及之前的信息 */
export function characterAt(ch, uptoChunk = Infinity) {
    const c = structuredCloneSafe(ch);
    if (!Number.isFinite(uptoChunk)) return c;
    c.experiences = c.experiences.filter((e) => e.chunk <= uptoChunk);
    c.quotes = c.quotes.filter((q) => q.chunk === undefined || q.chunk <= uptoChunk);
    const stages = c.stages.filter((s) => s.chunk <= uptoChunk);
    // 从阶段记录回放字段
    const later = c.stages.filter((s) => s.chunk > uptoChunk);
    for (const f of ['identity', 'personality', 'relationship']) {
        if (!later.some((s) => s[f])) continue;
        const last = [...stages].reverse().find((s) => s[f]);
        c[f] = last ? last[f] : '';
    }
    c.stages = stages;
    return c;
}

// ---------------- 文本化 ----------------

export function characterProfileText(ch, { maxExperiences = 12, maxQuotes = 8, withQuotes = true, maxDialogues = 4, withDialogues = true, withNsfw = true } = {}) {
    const lines = [`姓名: ${ch.name}`];
    if (ch.aliases?.length) lines.push(`别名: ${ch.aliases.join('、')}`);
    if (ch.gender) lines.push(`性别: ${ch.gender}`);
    if (ch.age) lines.push(`年龄: ${ch.age}`);
    if (ch.identity) lines.push(`身份: ${ch.identity}`);
    if (ch.appearance?.length) lines.push('外貌特征:', ...ch.appearance.map((a) => `  - ${a}`));
    if (ch.personality) lines.push(`性格: ${ch.personality}`);
    if (ch.verbalTics?.length) lines.push('口癖/说话习惯:', ...ch.verbalTics.map((a) => `  - ${a}`));
    if (ch.hardLimits?.length) lines.push('绝对不会做的事:', ...ch.hardLimits.map((a) => `  - ${a}`));
    if (ch.tabooTopics?.length) lines.push('忌讳话题:', ...ch.tabooTopics.map((a) => `  - ${a}`));
    if (ch.abilities?.length) lines.push('能力:', ...ch.abilities.map((a) => `  - ${a}`));
    if (ch.relationship) lines.push(`关系: ${ch.relationship}`);
    const exps = (ch.experiences || []).slice(-maxExperiences);
    if (exps.length) lines.push('经历:', ...exps.map((e) => `  - ${e.text}`));
    if (withQuotes) {
        const qs = (ch.quotes || []).filter((q) => q.verified !== false).slice(-maxQuotes);
        if (qs.length) lines.push('代表台词:', ...qs.map((q) => `  - 「${q.text}」${q.context ? `（${q.context}）` : ''}`));
    }
    if (withDialogues && maxDialogues > 0) {
        const ds = (ch.dialogues || []).filter((d) => d.verified !== false).slice(-maxDialogues);
        if (ds.length) lines.push('原文对话样本（写 mes_example 时优先参考真实的对话节奏与句式）:', ...ds.map((d) => `  ---\n${d.text.split('\n').map((l) => `  ${l}`).join('\n')}`));
    }
    if (ch.notes) lines.push(`备注: ${ch.notes}`);
    if (withNsfw && ch.nsfwNotes) lines.push(`NSFW 补充资料: ${ch.nsfwNotes}`);
    return lines.join('\n');
}

export function chunkOutlineText(chunk) {
    if (!chunk.outline?.length) return '';
    return chunk.outline.map((o) => `${o.name ? `${o.name}：` : ''}${o.notes}`).join('\n');
}

/**
 * 大纲文本（到某分块为止）。超出 maxChars 时：已完成且有卷梗概的早期卷用卷梗概代替，
 * 仍然过长则早期部分只保留每块第一句。
 */
export function buildOutlineText(project, uptoIndex = Infinity, maxChars = 6000) {
    const chunks = project.chunks.filter((c) => c.index <= uptoIndex && c.outline?.length);
    const pieces = chunks.map((c) => ({ full: `【${c.title}】\n${chunkOutlineText(c)}`, short: `【${c.title}】${(c.outline[0]?.notes || '').slice(0, 80)}`, chunk: c.index }));
    let text = pieces.map((p) => p.full).join('\n');
    if (text.length <= maxChars) return text;

    let list = pieces;
    const vols = getVolumes(project).filter((v) => !v.implicit);
    if (vols.length > 1) {
        const lastIdx = Number.isFinite(uptoIndex) ? uptoIndex : project.chunks.length - 1;
        const curVol = volumeOf(project, lastIdx);
        const summarized = vols.filter((v) => v.summary && v.endChunk < (curVol?.startChunk ?? 0));
        if (summarized.length) {
            list = [];
            const emitted = new Set();
            for (const p of pieces) {
                const v = summarized.find((x) => p.chunk >= x.startChunk && p.chunk <= x.endChunk);
                if (!v) {
                    list.push(p);
                } else if (!emitted.has(v.id)) {
                    emitted.add(v.id);
                    const t = `【${v.name}·梗概】${v.summary}`;
                    list.push({ full: t, short: t.slice(0, 300), chunk: p.chunk });
                }
            }
            text = list.map((p) => p.full).join('\n');
            if (text.length <= maxChars) return text;
        }
    }
    const compact = [];
    let budget = maxChars;
    for (let i = list.length - 1; i >= 0; i--) {
        const piece = budget > list[i].full.length * 2 ? list[i].full : list[i].short;
        if (budget - piece.length < 0) break;
        compact.unshift(piece);
        budget -= piece.length;
    }
    return compact.join('\n');
}

/**
 * 构建注入提取提示词的“已知资料”
 * @returns {{text: string, full: Set<string>}}
 */
export function buildKnownContext(project, chunkText, budget = 6000, { categories = null, scope = null, prelude = '' } = {}) {
    const full = new Set();
    const parts = [];
    let used = 0;
    const src = String(chunkText || '');
    const mentioned = (names) => names.some((n) => n && n.length >= 1 && src.includes(n));
    // 分卷模式：只把本卷出现过的实体（和主要角色）列入“其他已知名称”
    const inScope = (chunksList) => !scope || !chunksList?.length || chunksList.some((c) => c >= scope.start && c <= scope.end);

    // 0) 前情提要（前几卷的梗概）
    if (prelude) {
        const t = `## 前情提要（前几卷梗概）\n${prelude.slice(0, Math.floor(budget * 0.25))}`;
        parts.push(t);
        used += t.length;
    }

    // 1) 本段提到的角色：给完整档案（本卷出场过的优先）
    const chars = Object.values(project.characters).sort((a, b) => (IMPORTANCE_RANK[b.importance] - IMPORTANCE_RANK[a.importance]) || (b.chunksSeen.length - a.chunksSeen.length));
    const mentionedChars = chars.filter((c) => mentioned([c.name, ...c.aliases])).sort((a, b) => Number(inScope(b.chunksSeen)) - Number(inScope(a.chunksSeen)));
    const charBlocks = [];
    for (const c of mentionedChars) {
        const t = characterProfileText(c, { maxExperiences: 6, maxQuotes: 0, withQuotes: false });
        if (used + t.length > budget * 0.6) break;
        charBlocks.push(t);
        used += t.length;
        full.add(`char:${c.name}`);
    }
    if (charBlocks.length) parts.push(`## 本段出场角色的已有档案（如有新信息，输出更新后的完整字段）\n${charBlocks.join('\n---\n')}`);

    // 2) 本段提到的条目：给完整内容
    const entryBlocks = [];
    for (const [cat, entries] of Object.entries(project.worldbook)) {
        if (categories && !categories.includes(cat)) continue;
        for (const e of Object.values(entries)) {
            if (!mentioned([e.name, ...(e.keywords || [])])) continue;
            const t = `[${cat}] ${e.name}\n${e.content}`;
            if (used + t.length > budget * 0.9) break;
            entryBlocks.push(t);
            used += t.length;
            full.add(`${cat}:${e.name}`);
        }
    }
    if (entryBlocks.length) parts.push(`## 本段涉及条目的已有内容（如有新信息，输出融合后的完整 content）\n${entryBlocks.join('\n---\n')}`);

    // 3) 其余已知名称：只列名字，避免重复建条目
    const others = chars
        .filter((c) => !full.has(`char:${c.name}`) && (c.importance === 'main' || inScope(c.chunksSeen)))
        .map((c) => (c.identity ? `${c.name}（${c.identity.slice(0, 16)}）` : c.name));
    const otherEntries = [];
    for (const [cat, entries] of Object.entries(project.worldbook)) {
        const names = Object.entries(entries).filter(([n, e]) => !full.has(`${cat}:${n}`) && inScope(e.sourceChunks)).map(([n]) => n);
        if (names.length) otherEntries.push(`${cat}：${names.join('、')}`);
    }
    let nameList = '';
    if (others.length) nameList += `已知角色：${others.join('、')}\n`;
    if (otherEntries.length) nameList += otherEntries.join('\n');
    if (nameList) {
        const remain = Math.max(500, budget - used);
        parts.push(`## 其他已知名称（同一实体请沿用这些名字，不要新建重复条目）\n${nameList.slice(0, remain)}`);
    }
    return { text: parts.join('\n\n'), full };
}

// ---------------- 统计 ----------------

export function projectStats(project) {
    const chunks = project.chunks || [];
    return {
        chunks: chunks.length,
        done: chunks.filter((c) => c.status === 'done').length,
        error: chunks.filter((c) => c.status === 'error').length,
        pending: chunks.filter((c) => c.status === 'pending').length,
        characters: Object.keys(project.characters || {}).length,
        entries: Object.values(project.worldbook || {}).reduce((n, c) => n + Object.keys(c || {}).length, 0),
        chars: chunks.reduce((n, c) => n + (c.charCount || 0), 0),
        generated: project.continuation?.chapters?.length || 0,
    };
}

/** 角色改名/合并后同步关系图谱：把指向 oldName 的边改指向 newName，去掉产生的自环并去重 */
export function renameInRelationships(project, oldName, newName) {
    if (!Array.isArray(project.relationships) || !project.relationships.length) return;
    for (const r of project.relationships) {
        if (r.from === oldName) r.from = newName;
        if (r.to === oldName) r.to = newName;
    }
    project.relationships = project.relationships.filter((r) => r.from !== r.to);
    dedupeRelationships(project);
}

/** 清理关系图谱中指向已不存在角色的边（角色被删除后调用） */
/** 角色是否还在：被“重新提取”暂时清掉、等着提取回来的角色也算（见 extract.js 的 resetChunksForReextract） */
function characterAlive(project, name) {
    return !!project.characters[name] || (Array.isArray(project.reextractPending) && project.reextractPending.includes(name));
}

export function pruneRelationships(project) {
    if (!Array.isArray(project.relationships) || !project.relationships.length) return;
    project.relationships = project.relationships.filter((r) => characterAlive(project, r.from) && characterAlive(project, r.to));
}

/** 角色改名/合并后同步群聊场景卡：成员名与 notes 的 key 一起改 */
export function renameInGroupCards(project, oldName, newName) {
    if (!Array.isArray(project.groupCards) || !project.groupCards.length) return;
    for (const g of project.groupCards) {
        if (!g.members.includes(oldName)) continue;
        g.members = uniq(g.members.map((n) => (n === oldName ? newName : n)));
        if (g.data?.notes && oldName in g.data.notes) {
            g.data.notes[newName] = g.data.notes[oldName];
            delete g.data.notes[oldName];
        }
        g.updatedAt = Date.now();
    }
}

/** 清理成员不足两人的群聊场景卡（角色被删除后调用） */
export function pruneGroupCards(project) {
    if (!Array.isArray(project.groupCards) || !project.groupCards.length) return;
    for (const g of project.groupCards) g.members = g.members.filter((n) => characterAlive(project, n));
    project.groupCards = project.groupCards.filter((g) => g.members.length >= 2);
}

/** 角色改名/合并后同步多视角管理：povStyles 的 key 与大纲章节的 pov 字段一起改 */
export function renameInPov(project, oldName, newName) {
    if (project.povStyles && Object.prototype.hasOwnProperty.call(project.povStyles, oldName)) {
        // 合并时目标角色已有自己的视角文风，则保留目标的
        if (!Object.prototype.hasOwnProperty.call(project.povStyles, newName)) project.povStyles[newName] = project.povStyles[oldName];
        delete project.povStyles[oldName];
    }
    for (const c of project.plan?.chapters || []) {
        if (c.pov === oldName) c.pov = newName;
    }
}

/** 清理多视角管理中已不存在的角色（角色被删除后调用） */
export function prunePov(project) {
    if (project.povStyles) {
        for (const k of Object.keys(project.povStyles)) {
            if (!characterAlive(project, k)) delete project.povStyles[k];
        }
    }
    for (const c of project.plan?.chapters || []) {
        if (c.pov && !characterAlive(project, c.pov)) c.pov = '';
    }
}

function dedupeRelationships(project) {
    const seen = new Set();
    project.relationships = project.relationships.filter((r) => {
        const key = `${r.from}\u0001${r.to}\u0001${r.type}`;
        const revKey = r.mutual ? `${r.to}\u0001${r.from}\u0001${r.type}` : key;
        if (seen.has(key) || seen.has(revKey)) return false;
        seen.add(key);
        return true;
    });
}

/** 重命名角色（同步别名、卡片引用、关系图谱） */
export function renameCharacter(project, oldName, newName) {
    newName = String(newName || '').trim();
    if (!newName || oldName === newName) return false;
    if (project.characters[newName]) throw new Error(`已存在角色「${newName}」`);
    const ch = project.characters[oldName];
    if (!ch) return false;
    delete project.characters[oldName];
    ch.name = newName;
    ch.aliases = uniq([...ch.aliases.filter((a) => a !== newName), oldName]);
    project.characters[newName] = ch;
    for (const card of project.cards) if (card.charName === oldName) card.charName = newName;
    renameInRelationships(project, oldName, newName);
    renameInGroupCards(project, oldName, newName);
    renameInPov(project, oldName, newName);
    return true;
}

/** 合并多个角色为一个（别名合并） */
export function mergeCharactersInto(project, targetName, sourceNames) {
    const target = project.characters[targetName];
    if (!target) throw new Error(`角色不存在：${targetName}`);
    for (const n of sourceNames) {
        if (n === targetName) continue;
        const s = project.characters[n];
        if (!s) continue;
        target.aliases = uniq([...target.aliases, n, ...s.aliases]).filter((a) => a !== targetName);
        // 合并来的别名带上原来的出处（被合并角色自己的名字是人为合并的结果，不记出处，重新提取也不会清掉）
        target.aliasSources = target.aliasSources || {};
        for (const [a, src] of Object.entries(s.aliasSources || {})) {
            if (a === targetName || !Array.isArray(src)) continue;
            target.aliasSources[a] = uniq([...(target.aliasSources[a] || []), ...src].map(String)).map(Number);
        }
        delete target.aliasSources[n];
        if (s.manual) target.manual = true;
        for (const f of ['gender', 'age', 'identity', 'personality', 'relationship']) if (!target[f] && s[f]) target[f] = s[f];
        target.appearance = uniq([...target.appearance, ...s.appearance]);
        target.abilities = uniq([...target.abilities, ...s.abilities]);
        target.hardLimits = uniq([...target.hardLimits, ...(s.hardLimits || [])]);
        target.tabooTopics = uniq([...target.tabooTopics, ...(s.tabooTopics || [])]);
        target.verbalTics = uniq([...target.verbalTics, ...(s.verbalTics || [])]);
        if (!target.nsfwNotes && s.nsfwNotes) target.nsfwNotes = s.nsfwNotes;
        target.experiences = [...target.experiences, ...s.experiences].sort((a, b) => a.chunk - b.chunk);
        const seen = new Set();
        target.quotes = [...target.quotes, ...s.quotes].filter((q) => {
            const k = normalizeForMatch(q.text);
            if (seen.has(k)) return false;
            seen.add(k);
            return true;
        });
        const dlgSeen = new Set();
        target.dialogues = [...target.dialogues, ...(s.dialogues || [])].filter((d) => {
            const k = normalizeForMatch(d.text);
            if (dlgSeen.has(k)) return false;
            dlgSeen.add(k);
            return true;
        });
        target.stages = [...target.stages, ...s.stages].sort((a, b) => a.chunk - b.chunk);
        target.chunksSeen = uniq([...target.chunksSeen, ...s.chunksSeen].map(String)).map(Number).sort((a, b) => a - b);
        target.firstChunk = Math.min(target.firstChunk, s.firstChunk);
        target.lastChunk = Math.max(target.lastChunk, s.lastChunk);
        if (IMPORTANCE_RANK[s.importance] > IMPORTANCE_RANK[target.importance]) target.importance = s.importance;
        delete project.characters[n];
        for (const card of project.cards) if (card.charName === n) card.charName = targetName;
        renameInRelationships(project, n, targetName);
        renameInGroupCards(project, n, targetName);
        renameInPov(project, n, targetName);
    }
    return target;
}

export function mergeEntriesInto(project, category, targetName, sourceNames, targetCategory = category) {
    const cat = project.worldbook[category] || {};
    const tgtCat = (project.worldbook[targetCategory] = project.worldbook[targetCategory] || {});
    let target = tgtCat[targetName] || cat[targetName];
    if (!target) throw new Error(`条目不存在：${targetName}`);
    if (!tgtCat[targetName]) {
        tgtCat[targetName] = target;
        delete cat[targetName];
    }
    for (const n of sourceNames) {
        if (n === targetName) continue;
        const s = cat[n];
        if (!s) continue;
        target.keywords = uniq([...target.keywords, n, ...(s.keywords || [])]);
        if (!normalizeForMatch(target.content).includes(normalizeForMatch(s.content))) target.content = `${target.content}\n${s.content}`;
        target.sourceChunks = [...new Set([...(target.sourceChunks || []), ...(s.sourceChunks || [])])];
        delete cat[n];
    }
    if (target.revisions?.length) target.revisions[target.revisions.length - 1].content = target.content;
    target.updatedAt = Date.now();
    return target;
}

// ---------------- 分块增删合并（同步重映射所有引用） ----------------

/** 用 mapFn(oldIndex) → newIndex|null 重映射项目中的所有分块引用 */
export function remapChunkRefs(project, mapFn) {
    const m = (i) => (Number.isFinite(i) ? mapFn(i) : i);
    for (const [name, ch] of Object.entries(project.characters)) {
        ch.experiences = ch.experiences.map((e) => ({ ...e, chunk: m(e.chunk) })).filter((e) => e.chunk !== null);
        ch.quotes = ch.quotes.map((q) => ({ ...q, chunk: m(q.chunk) })).filter((q) => q.chunk !== null);
        ch.dialogues = (ch.dialogues || []).map((d) => ({ ...d, chunk: m(d.chunk) })).filter((d) => d.chunk !== null);
        ch.stages = ch.stages.map((s) => ({ ...s, chunk: m(s.chunk) })).filter((s) => s.chunk !== null);
        const hadSeen = ch.chunksSeen.length > 0;
        const oldFirst = ch.firstChunk;
        ch.chunksSeen = [...new Set(ch.chunksSeen.map(m).filter((x) => x !== null))].sort((a, b) => a - b);
        if (ch.aliasSources && typeof ch.aliasSources === 'object') {
            for (const [a, src] of Object.entries(ch.aliasSources)) {
                if (!Array.isArray(src)) continue;
                const mapped = [...new Set(src.map(m).filter((x) => x !== null))];
                if (mapped.length) {
                    ch.aliasSources[a] = mapped;
                } else {
                    // 只来自被删掉那一段的别名，随那一段一起去掉
                    delete ch.aliasSources[a];
                    ch.aliases = (ch.aliases || []).filter((x) => x !== a);
                }
            }
        }
        if (hadSeen && !ch.chunksSeen.length) {
            if (ch.manual) {
                const t = Number.isFinite(oldFirst) ? mapFn(oldFirst) : 0;
                ch.chunksSeen = [t === null ? Math.max(0, oldFirst - 1) : t]; // 手动角色保留时间点
            } else if (!ch.locked) {
                delete project.characters[name];
                continue;
            }
        }
        ch.firstChunk = ch.chunksSeen.length ? Math.min(...ch.chunksSeen) : Infinity;
        ch.lastChunk = ch.chunksSeen.length ? Math.max(...ch.chunksSeen) : -1;
    }
    for (const cat of Object.values(project.worldbook)) {
        for (const [name, e] of Object.entries(cat)) {
            const had = (e.sourceChunks || []).length > 0;
            e.sourceChunks = [...new Set((e.sourceChunks || []).map(m).filter((x) => x !== null))];
            e.revisions = (e.revisions || []).map((r) => ({ ...r, chunk: m(r.chunk) })).filter((r) => r.chunk !== null);
            if (e.revisions.length) e.content = e.revisions[e.revisions.length - 1].content;
            if (had && !e.sourceChunks.length && !e.locked) delete cat[name];
        }
    }
    if (project.volumes?.length) {
        for (const v of project.volumes) {
            const t = mapFn(v.startChunk);
            v.startChunk = t === null ? v.startChunk : t; // 被删掉的起始段：顺延到下一段（删除后序号不变）
        }
        normalizeVolumes(project);
    }
    project.missingNames = project.missingNames.map((x) => ({ ...x, chunk: m(x.chunk) })).filter((x) => x.chunk !== null);
    project.censorFlags = ensureCensorFlags(project).map((x) => ({ ...x, chunk: m(x.chunk) })).filter((x) => x.chunk !== null);
    for (const card of project.cards) {
        if (Number.isFinite(card.timepoint)) {
            const t = mapFn(card.timepoint);
            card.timepoint = t === null ? Math.max(0, card.timepoint - 1) : t;
        }
    }
    if (Array.isArray(project.relationships) && project.relationships.length) {
        for (const r of project.relationships) {
            if (Number.isFinite(r.chunk)) {
                const t = mapFn(r.chunk);
                r.chunk = t === null ? Math.max(0, r.chunk - 1) : t;
            }
        }
    }
    pruneRelationships(project);
    pruneGroupCards(project);
    prunePov(project);
}

/** 删除分块并清除其贡献 */
export function deleteChunkAt(project, idx) {
    const chunk = project.chunks[idx];
    if (!chunk) return;
    project.chunks.splice(idx, 1);
    remapChunkRefs(project, (i) => (i === idx ? null : i > idx ? i - 1 : i));
    project.chunks.forEach((c, i) => (c.index = i));
    if (project.continuation?.chapters) {
        for (const ch of project.continuation.chapters) if (ch.chunkId === chunk.id) ch.chunkId = '';
    }
}

/** 把 idx 与 idx+1 两块合并为一块（引用映射到合并后的块） */
export function mergeChunkWithNext(project, idx) {
    const a = project.chunks[idx];
    const b = project.chunks[idx + 1];
    if (!a || !b) throw new Error('没有可合并的下一段');
    for (const v of project.volumes || []) if (v.startChunk === idx + 1) v.startChunk = idx + 2;
    const merged = {
        ...a,
        title: `${(a.chapterTitles || [a.title])[0]} ～ ${(b.chapterTitles || [b.title]).slice(-1)[0]}`,
        chapterTitles: [...(a.chapterTitles || [a.title]), ...(b.chapterTitles || [b.title])],
        content: a.content + b.content,
        charCount: a.content.length + b.content.length,
        end: b.end,
        outline: [...(a.outline || []), ...(b.outline || [])],
        important: [...(a.important || []), ...(b.important || [])],
        status: a.status === 'done' && b.status === 'done' ? 'done' : 'pending',
        origin: a.origin === b.origin ? a.origin : 'mixed',
    };
    project.chunks.splice(idx, 2, merged);
    remapChunkRefs(project, (i) => (i <= idx ? i : i - 1));
    project.chunks.forEach((c, i) => (c.index = i));
    return merged;
}

// ---------------- 分卷 ----------------

/** 规范化卷列表：排序、去重、越界剔除、首卷从 0 开始、默认卷名重新编号 */
export function normalizeVolumes(project) {
    const n = project.chunks.length;
    let vols = (project.volumes || []).filter((v) => v && Number.isFinite(v.startChunk) && v.startChunk < n);
    vols.sort((a, b) => a.startChunk - b.startChunk);
    vols = vols.filter((v, i) => i === 0 || v.startChunk !== vols[i - 1].startChunk);
    if (vols.length) vols[0].startChunk = 0;
    if (vols.length === 1 && vols[0].auto !== 'heading' && !vols[0].summary) vols = [];
    vols.forEach((v, i) => {
        if (v.defaultName !== false && (!v.name || /^第\d+卷$/.test(v.name))) {
            v.name = `第${i + 1}卷`;
            v.defaultName = true;
        }
    });
    project.volumes = vols;
    return vols;
}

/** 卷列表（带 endChunk / index）；未分卷时返回一个覆盖全书的隐式卷 */
export function getVolumes(project) {
    const n = project.chunks?.length || 0;
    const vols = (project.volumes || []).filter((v) => Number.isFinite(v.startChunk) && v.startChunk < Math.max(1, n)).sort((a, b) => a.startChunk - b.startChunk);
    if (!vols.length) return [{ id: '__all', name: '全书', startChunk: 0, endChunk: Math.max(0, n - 1), implicit: true, index: 0, summary: '' }];
    return vols.map((v, i) => ({ ...v, index: i, startChunk: i === 0 ? 0 : v.startChunk, endChunk: i + 1 < vols.length ? vols[i + 1].startChunk - 1 : Math.max(0, n - 1) }));
}

export function volumeOf(project, chunkIndex) {
    const vols = getVolumes(project);
    return vols.find((v) => chunkIndex >= v.startChunk && chunkIndex <= v.endChunk) || vols[vols.length - 1];
}

/** 从某段开始新的一卷 */
export function addVolumeAt(project, chunkIndex, { name = '', auto = 'manual' } = {}) {
    project.volumes = project.volumes || [];
    if (!project.volumes.length) project.volumes.push({ id: uid('v_'), name: '', startChunk: 0, auto: 'initial', summary: '', createdAt: Date.now() });
    let v = project.volumes.find((x) => x.startChunk === chunkIndex);
    if (!v) {
        v = { id: uid('v_'), name: name || '', startChunk: chunkIndex, auto, summary: '', createdAt: Date.now(), defaultName: !name };
        project.volumes.push(v);
    }
    normalizeVolumes(project);
    return project.volumes.find((x) => x.id === v.id) || v;
}

/** 取消某卷（并入上一卷） */
export function removeVolume(project, id) {
    project.volumes = (project.volumes || []).filter((v) => v.id !== id);
    normalizeVolumes(project);
}

/** 根据分段标题里的「第X卷」自动分卷；保留同起点卷已有的梗概与改名 */
export function detectVolumesFromChunks(project) {
    const detected = [];
    let lastKey = null;
    project.chunks.forEach((c, i) => {
        if (c.origin !== 'source') return;
        const key = c.volumeKey ?? null;
        if (key !== null && key !== lastKey) {
            detected.push({ startChunk: detected.length ? i : 0, name: c.volumeName || '', key });
            lastKey = key;
        }
    });
    if (detected.length < 2) return 0;
    const old = project.volumes || [];
    project.volumes = detected.map((d) => {
        const prev = old.find((v) => v.startChunk === d.startChunk);
        return prev ? { ...prev, auto: prev.auto === 'manual' ? 'manual' : 'heading' } : { id: uid('v_'), name: d.name, startChunk: d.startChunk, auto: 'heading', summary: '', createdAt: Date.now(), defaultName: !d.name };
    });
    normalizeVolumes(project);
    return project.volumes.length;
}

/** 卷的范围字符串，如「第 3–10 段」 */
export function volumeRangeLabel(v) {
    return v.startChunk === v.endChunk ? `第 ${v.startChunk + 1} 段` : `第 ${v.startChunk + 1}–${v.endChunk + 1} 段`;
}

/** 某卷之前各卷的梗概（用于前情提要） */
export function priorVolumeSummaries(project, chunkIndex, maxChars = 1500) {
    const cur = volumeOf(project, chunkIndex);
    const prior = getVolumes(project).filter((v) => !v.implicit && v.endChunk < cur.startChunk && v.summary);
    const parts = [];
    let used = 0;
    for (let i = prior.length - 1; i >= 0; i--) {
        const t = `【${prior[i].name}】${prior[i].summary}`;
        if (used + t.length > maxChars) break;
        parts.unshift(t);
        used += t.length;
    }
    return parts.join('\n');
}

// ---------------- 续写用的公共函数 ----------------

export function countSourceChapters(project) {
    const titles = new Set();
    for (const c of project.chunks.filter((x) => x.origin === 'source')) {
        for (const t of c.chapterTitles?.length ? c.chapterTitles : [c.title]) titles.add(String(t).replace(/（\d+\/\d+）$/, ''));
    }
    return titles.size;
}

/** 取前文尾部：优先续写章节，其次原文最后一块 */
export function getTailText(project, maxChars = 3000) {
    const gen = project.continuation.chapters;
    let text = '';
    for (let i = gen.length - 1; i >= 0 && text.length < maxChars; i--) text = `${gen[i].content}\n\n${text}`;
    if (text.length < maxChars) {
        const sources = project.chunks.filter((c) => c.origin !== 'generated');
        for (let i = sources.length - 1; i >= 0 && text.length < maxChars; i--) text = `${sources[i].content}\n${text}`;
    }
    return text.slice(-maxChars).replace(/^[^\n]*\n/, '');
}
