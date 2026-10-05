// 角色卡生成、审稿修订、卡片 JSON / PNG 构建

import { callLLM, chainFor } from './llm.js';
import { extractJson, removeTags } from './json.js';
import { lintCard, formatIssues } from './lint.js';
import { buildOutlineText, characterAt, characterProfileText, entryAt, IMPORTANCE_RANK } from './project.js';
import { WRITING_RULES, getPrompt, render } from './prompts.js';
import { relationLine, relationsAt } from './relations.js';
import {
    STATUS_USAGE_NOTE_MARK, buildStatusRegexScripts, buildTavernHelper, statusBarActive, statusBarEntries, statusBarMeta,
    statusBarUsageNote, withStatusTag,
} from './statusbar.js';
import { bannedRulesFor, styleTextFor } from './style.js';
import { normalizeCardOrientation, orientationPromptBlock, parseOrientationNotes } from './orientation.js';
import { normalizeUserRole, userRoleCharName, userRolePromptBlock } from './userrole.js';
import { truncate, uid, uniq } from './utils.js';
import { toCharacterBook } from './worldbook.js';

export const CARD_FIELDS = ['name', 'description', 'personality', 'scenario', 'first_mes', 'alternate_greetings', 'mes_example', 'system_prompt', 'post_history_instructions', 'creator_notes', 'tags'];

const CARD_FIELD_LABELS = {
    description: '描述',
    personality: '性格摘要',
    scenario: '场景',
    first_mes: '开场白',
    alternate_greetings: '备选开场白',
    mes_example: '示例对话',
    system_prompt: '系统提示词覆盖',
    post_history_instructions: '历史后指令',
    creator_notes: '作者备注',
};

export function timepointLabel(project, t) {
    if (!Number.isFinite(t) || t >= project.chunks.length - 1) return '全书结束时';
    const c = project.chunks[t];
    return c ? `第 ${t + 1} 段「${c.title}」结束时` : '全书结束时';
}

/** 相关角色：优先用关系图谱里已确立的明确关系，剩余名额再用启发式（共同出场段/互相提及/重要度）补齐 */
function relatedCharacters(project, target, upto, max = 6, settings) {
    const lines = [];
    const covered = new Set();
    for (const r of relationsAt(project, upto)) {
        if (r.from !== target.name && r.to !== target.name) continue;
        const otherName = r.from === target.name ? r.to : r.from;
        if (covered.has(otherName)) continue;
        const line = relationLine(project, target.name, otherName, r, upto, settings);
        if (!line) continue;
        lines.push(line);
        covered.add(otherName);
        if (lines.length >= max) break;
    }
    if (lines.length >= max) return lines.join('\n');

    const seen = new Set(target.chunksSeen.filter((c) => c <= upto));
    const text = `${target.relationship} ${target.experiences.map((e) => e.text).join(' ')}`;
    const heuristic = Object.values(project.characters)
        .filter((c) => c.name !== target.name && !covered.has(c.name) && c.firstChunk <= upto)
        .map((c) => {
            const shared = c.chunksSeen.filter((x) => seen.has(x)).length;
            const mentioned = [c.name, ...c.aliases].some((n) => n && text.includes(n)) ? 5 : 0;
            return { c, score: shared + mentioned + IMPORTANCE_RANK[c.importance] };
        })
        .filter((x) => x.score > 1)
        .sort((a, b) => b.score - a.score)
        .slice(0, max - lines.length)
        .map(({ c }) => {
            const v = characterAt(c, upto);
            return `- ${v.name}${v.aliases.length ? `（${v.aliases.slice(0, 3).join('/')}）` : ''}：${v.identity || '身份不明'}；${truncate(v.relationship, 60)}`;
        });
    return [...lines, ...heuristic].join('\n');
}

export function worldContext(project, settings, focusText, upto, maxChars = 5000) {
    const cats = settings.categories || [];
    const parts = [];
    let used = 0;
    const push = (t) => {
        if (used + t.length > maxChars) return false;
        parts.push(t);
        used += t.length;
        return true;
    };
    // 常驻分类优先
    for (const cat of cats.filter((c) => c.enabled && c.constant && c.name !== '角色')) {
        for (const e of Object.values(project.worldbook[cat.name] || {})) {
            const content = entryAt(e, upto);
            if (content === null || (Number.isFinite(upto) && e.sourceChunks?.length && Math.min(...e.sourceChunks) > upto)) continue;
            if (!push(`[${cat.name}] ${e.name}\n${content}`)) break;
        }
    }
    // 与角色相关的条目
    for (const cat of cats.filter((c) => c.enabled && !c.constant && c.name !== '角色')) {
        for (const e of Object.values(project.worldbook[cat.name] || {})) {
            const content = entryAt(e, upto);
            if (content === null || (Number.isFinite(upto) && e.sourceChunks?.length && Math.min(...e.sourceChunks) > upto)) continue;
            if (![e.name, ...(e.keywords || [])].some((k) => k && focusText.includes(k))) continue;
            push(`[${cat.name}] ${e.name}\n${truncate(content, 600)}`);
        }
    }
    return parts.join('\n\n') || '（无）';
}

/** 角色卡审稿：内置写卡规则 + 当前文风的禁用词 */
export function lintCardFor(project, settings, data) {
    return lintCard(data, { extraRules: project ? bannedRulesFor(project, settings, 'card') : [] });
}

/**
 * 卡片名：从不采用 AI 写的 name。单人卡 = 角色名；世界/旁白卡 = 表单里填的卡名，没填时用书名（默认是 TXT 文件名）。
 * @param {object} project
 * @param {{kind?: string, charName?: string, cardName?: string}} opt
 */
export function cardNameFor(project, opt = {}) {
    if (opt.kind === 'world') return String(opt.cardName ?? '').trim() || project?.bookName || project?.name || '旁白';
    return project?.characters?.[opt.charName]?.name || String(opt.charName ?? '').trim() || '角色';
}

/** 写卡用的 {{user}} 身份：单人卡不能扮演卡片本人；项目里已经没有的原著角色当作原创新身份 */
function userRoleFor(project, opt) {
    const r = normalizeUserRole(opt.userRole, { exclude: opt.kind === 'world' ? '' : opt.charName });
    return r.kind === 'character' && !project?.characters?.[r.charKey] ? normalizeUserRole(null) : r;
}

/**
 * 把一段要追加的内容放进提示词：模板里有占位符时已经由 render 填好；用户改过的模板里没有这个占位符时追加在末尾，
 * 保证 {{user}} 的身份、卡的导向照样生效。
 */
function appendIfMissing(template, prompt, key, block) {
    return block && !String(template).includes(`{${key}}`) ? `${prompt}\n\n${block}` : prompt;
}

/** 卡片记录 → 写卡选项（整卡重新生成、单字段重roll、推演的背景资料都用它，保持与生成时一致） */
export function cardPromptOpt(card) {
    return {
        kind: card.kind,
        charName: card.charName,
        cardName: card.kind === 'world' ? card.cardName || '' : '',
        timepoint: Number.isFinite(card.timepoint) ? card.timepoint : Infinity,
        requirement: card.requirement,
        greetings: card.data?.alternate_greetings?.length ?? 0,
        userRole: card.userRole || null,
        orientation: card.orientation || null,
    };
}

/**
 * 写卡提示词
 * @param {object} opt {kind, charName, cardName, timepoint, requirement, greetings, firstMesLen, userRole, orientation, askNotes}
 *   userRole：{{user}} 的身份（见 userrole.js）；orientation：卡的导向快照（见 orientation.js）；
 *   askNotes=false：导向段里不要求输出 orientation_notes（单字段重roll 等只把写卡提示词当背景资料时）
 */
export function buildCardPrompt(project, settings, opt) {
    const upto = Number.isFinite(opt.timepoint) ? opt.timepoint : Infinity;
    const isWorld = opt.kind === 'world';
    const role = userRoleFor(project, opt);
    const roleChar = role.kind === 'character' ? userRoleCharName(project, role) : '';
    let charName;
    let profile;
    let related;
    let focus;
    if (isWorld) {
        charName = cardNameFor(project, opt);
        // {{user}} 扮演的原著角色不放进主要角色资料（写卡时把这个人写成 {{user}}）
        const mains = Object.values(project.characters)
            .filter((c) => c.firstChunk <= upto && c.name !== roleChar)
            .sort((a, b) => (IMPORTANCE_RANK[b.importance] - IMPORTANCE_RANK[a.importance]) || (b.chunksSeen.length - a.chunksSeen.length))
            .slice(0, 12)
            .map((c) => characterProfileText(characterAt(c, upto), { maxExperiences: 3, maxQuotes: 2, withDialogues: false }));
        profile = mains.join('\n---\n') || '（尚无角色资料）';
        related = '（见上方角色资料）';
        focus = profile;
    } else {
        const ch = project.characters[opt.charName];
        if (!ch) throw new Error(`角色不存在：${opt.charName}`);
        const view = characterAt(ch, upto);
        charName = ch.name;
        profile = characterProfileText(view, { maxExperiences: 20, maxQuotes: 12 });
        related = relatedCharacters(project, view, upto, 6, settings) || '（无）';
        focus = profile;
    }
    let outline = '';
    if (project.outline?.summary && (!Number.isFinite(upto) || project.outline.summaryUpTo <= upto)) outline += `梗概：${project.outline.summary}\n\n`;
    outline += buildOutlineText(project, upto, 5000) || '（无）';

    const greetings = Number.isFinite(opt.greetings) ? opt.greetings : settings.cards.greetings;
    const orient = normalizeCardOrientation(opt.orientation);
    // 要 AI 另外输出 orientation_notes（开了「让 AI 结合本书细化」、不是只当背景资料时）：JSON 模板里也列出这个字段，免得 AI 照抄模板漏掉
    const askNotes = !!orient && orient.refine && opt.askNotes !== false;
    const orientationBlock = orientationPromptBlock(orient, { askNotes: opt.askNotes !== false });
    // 同时选了导向时，「{{user}} 的身份」里两人现在的关系以导向为准（原著关系只作底子）
    const userRoleBlock = userRolePromptBlock(project, role, { upto, world: isWorld, orientation: !!orientationBlock });
    const vars = {
        BOOK: project.bookName,
        CHAR_NAME: charName,
        CARD_KIND: isWorld ? '世界/旁白卡' : '单人角色卡',
        TIMEPOINT: timepointLabel(project, upto),
        CHAR_PROFILE: profile,
        RELATED: related,
        WORLD: worldContext(project, settings, focus, upto),
        OUTLINE: outline,
        STYLE: styleTextFor(project, settings, 'card'),
        REQUIREMENT: [opt.requirement, settings.cards.defaultRequirement].filter(Boolean).join('\n')
            || (role.kind === 'new' ? '（无特别要求，{{user}} 以原著中可自然融入的新身份出现）' : '（无特别要求）'),
        // 前后各带一个换行：模板里写成「{REQUIREMENT}\n{USER_ROLE}{ORIENTATION}\n# 字段写法」，没有内容时与原来的空行一致
        USER_ROLE: userRoleBlock ? `\n${userRoleBlock}\n` : '',
        ORIENTATION: orientationBlock ? `\n${orientationBlock}\n` : '',
        // 只在要求输出本书落点时填：JSON 模板里 creator_notes 后面多一行 orientation_notes（不要时提示词与原来一字不差）
        ORIENTATION_JSON: askNotes ? '\n  "orientation_notes": "- ……\\n- ……",' : '',
        GREETINGS: greetings,
        FIRST_MES_LEN: opt.firstMesLen || '400-800 字',
        WRITING_RULES,
    };
    const template = getPrompt(settings, 'card');
    let prompt = render(template, vars);
    prompt = appendIfMissing(template, prompt, 'USER_ROLE', userRoleBlock);
    prompt = appendIfMissing(template, prompt, 'ORIENTATION', orientationBlock);
    if (isWorld) prompt = `${prompt}\n\n${render(getPrompt(settings, 'worldCardExtra'), vars)}`;
    return { system: render(getPrompt(settings, 'cardSystem'), vars), prompt, charName, userRole: role };
}

function escapeRe(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 规整示例对话的说话人：行首是卡片名字（字面）加冒号（: 或 ：）的改成「{{char}}:」，
 * 行首是 {{user}} 扮演的原著角色名字的改成「{{user}}:」；已经写成 {{char}} / {{user}} 但用了全角冒号、
 * 行首有空白或大小写不对的也统一成「{{char}}: 」「{{user}}: 」。<START> 分组与其余内容不变。
 * 酒馆只认行首的「{{char}}:」「{{user}}:」（半角冒号，public/scripts/openai.js 的 parseExampleIntoIndividual 用 startsWith 判断），
 * 写成「{{char}}：」的行会被并进上一句或整组丢掉。
 * @param {string} text
 * @param {{charName?: string, userName?: string}} names
 */
export function normalizeMesExample(text, { charName = '', userName = '' } = {}) {
    let out = String(text ?? '');
    const swap = (name, macro) => {
        const n = String(name || '').trim();
        if (!n || /^\{\{(char|user)\}\}$/i.test(n)) return;
        out = out.replace(new RegExp(`^[ \\t]*${escapeRe(n)}[ \\t]*[:：][ \\t]*`, 'gm'), `${macro}: `);
    };
    // 两个名字一个包含另一个时（如「小酒」与「小酒儿」），先换长的
    const pairs = [[charName, '{{char}}'], [userName, '{{user}}']].filter(([n]) => String(n || '').trim()).sort((a, b) => String(b[0]).length - String(a[0]).length);
    for (const [n, m] of pairs) swap(n, m);
    return out.replace(/^[ \t]*\{\{(char|user)\}\}[ \t]*[:：][ \t]*/gim, (_, m) => `{{${m.toLowerCase()}}}: `);
}

/**
 * AI 返回的卡片 JSON → 卡片字段。name 一律用 opt.name（不采用 AI 写的名字），示例对话按 normalizeMesExample 规整说话人。
 * @param {object} json
 * @param {{name: string, userName?: string}} opt
 */
function normalizeCardData(json, { name, userName = '' }) {
    const d = json && typeof json === 'object' ? json : {};
    const str = (v) => (Array.isArray(v) ? v.join('\n') : (v === undefined || v === null ? '' : typeof v === 'object' ? JSON.stringify(v, null, 2) : String(v)));
    let mes = d.mes_example;
    if (Array.isArray(mes)) mes = mes.map((m) => (String(m).trim().startsWith('<START>') ? m : `<START>\n${m}`)).join('\n');
    return {
        name,
        description: str(d.description),
        personality: str(d.personality),
        scenario: str(d.scenario),
        first_mes: str(d.first_mes),
        alternate_greetings: (Array.isArray(d.alternate_greetings) ? d.alternate_greetings : d.alternate_greetings ? [d.alternate_greetings] : []).map(str).filter(Boolean),
        mes_example: normalizeMesExample(str(mes), { charName: name, userName }),
        system_prompt: str(d.system_prompt),
        post_history_instructions: str(d.post_history_instructions),
        creator_notes: str(d.creator_notes),
        tags: uniq(Array.isArray(d.tags) ? d.tags : String(d.tags || '').split(/[,，、]/)),
    };
}

/** 这张卡的 {{user}} 扮演的原著角色名（示例对话规整用）；没有时为 '' */
function cardUserName(project, card) {
    const r = normalizeUserRole(card?.userRole, { exclude: card?.kind === 'world' ? '' : card?.charName });
    return r.kind === 'character' ? userRoleCharName(project, r) : '';
}

/**
 * 生成角色卡
 * @param {object} opt 见 buildCardPrompt；卡片名按 cardNameFor（不采用 AI 写的 name）
 * @returns {Promise<object>} card 记录（带 userRole、orientation 快照；世界卡另记 cardName = 表单里填的卡名）
 */
export async function generateCard(project, settings, opt, { signal, onLog } = {}) {
    const { system, prompt, charName, userRole } = buildCardPrompt(project, settings, opt);
    onLog?.(`🎴 正在生成「${charName}」的角色卡…`);
    const res = await callLLM({
        api: settings.api, system, prompt, ...chainFor(settings, 'card', project), expect: 'json', signal, maxTokens: Math.max(settings.api.maxTokens || 0, 6000),
        onNotice: (m, l) => onLog?.(`「${charName}」${m}`, l),
    });
    const raw = removeTags(res.text, settings.extraction.filterTags);
    let json;
    try {
        json = extractJson(raw);
    } catch (e) {
        e.raw = raw;
        throw e;
    }
    const userName = userRole.kind === 'character' ? userRoleCharName(project, userRole) : '';
    const data = normalizeCardData(json, { name: charName, userName });
    let orientation = normalizeCardOrientation(opt.orientation);
    if (orientation) {
        // 沿用快照里已有的本书落点（整卡重新生成且没开细化时）；开了细化就用 AI 这次写的
        const notes = orientation.refine ? parseOrientationNotes(json) : '';
        orientation = { ...orientation, notes: notes || (orientation.refine ? '' : orientation.notes) };
        if (orientation.refine && !notes) onLog?.(`「${charName}」没有返回本书落点，可以在编辑里点「重新生成本书落点」`, 'warn');
    }
    const card = {
        id: uid('card_'),
        charName: opt.kind === 'world' ? '' : charName,
        kind: opt.kind || 'character',
        cardName: opt.kind === 'world' ? String(opt.cardName ?? '').trim() : '',
        timepoint: Number.isFinite(opt.timepoint) ? opt.timepoint : null,
        requirement: opt.requirement || '',
        userRole,
        orientation,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        data,
        lint: settings.cards.lintAfterGenerate ? lintCardFor(project, settings, data) : [],
        stAvatar: '',
        worldName: '',
    };
    return card;
}

export async function fixCardWithAI(project, settings, card, { signal } = {}) {
    const issues = card.lint?.length ? card.lint : lintCardFor(project, settings, card.data);
    const text = formatIssues(issues);
    if (!text) return card;
    const res = await callLLM({
        api: settings.api,
        system: getPrompt(settings, 'fixSystem'),
        prompt: render(getPrompt(settings, 'fix'), { WRITING_RULES, ISSUES: text, CARD_JSON: JSON.stringify(card.data, null, 2) }),
        ...chainFor(settings, 'card', project),
        expect: 'json',
        signal,
        maxTokens: Math.max(settings.api.maxTokens || 0, 6000),
    });
    const json = extractJson(removeTags(res.text, settings.extraction.filterTags));
    // 名称保持当前的（可能是用户改过的），不采用 AI 改的
    card.data = normalizeCardData({ ...card.data, ...json }, { name: card.data.name, userName: cardUserName(project, card) });
    card.lint = lintCardFor(project, settings, card.data);
    card.updatedAt = Date.now();
    return card;
}

/**
 * 单字段重roll：复用整卡的写卡提示词（人设/相关角色/世界观/大纲/文风/要求）作为背景资料，
 * 只让 AI 重新生成这一个字段，不动卡片其余部分。alternate_greetings 是唯一的多值字段，
 * 重roll 时会保持原有条数，仍用 "=====" 分隔。
 * @param {string} fieldKey CARD_FIELD_LABELS 里的字段名（name/tags 不支持，走各自的编辑框直接改）
 */
export async function regenerateCardField(project, settings, card, fieldKey, { signal, instruction = '' } = {}) {
    const label = CARD_FIELD_LABELS[fieldKey];
    if (!label) throw new Error(`字段「${fieldKey}」不支持重新生成`);
    const opt = { ...cardPromptOpt(card), askNotes: false };
    const { system: bgSystem, prompt: bgPrompt } = buildCardPrompt(project, settings, opt);
    const isGreetings = fieldKey === 'alternate_greetings';
    const n = Math.max(1, card.data.alternate_greetings.length || 1);
    const current = isGreetings ? card.data.alternate_greetings.join('\n=====\n') : card.data[fieldKey];
    const vars = {
        CONTEXT: `${bgSystem}\n\n${bgPrompt}`,
        FIELD_LABEL: label,
        CURRENT: current || '（当前为空）',
        FORMAT_NOTE: isGreetings ? `这个字段包含 ${n} 条备选开场白，每条之间用单独一行的 "=====" 分隔；请仍然输出 ${n} 条，用同样的分隔方式，不要加条目编号。` : '',
        INSTRUCTION_LINE: instruction.trim() ? `请按这个额外要求来写：${instruction.trim()}` : '',
        WRITING_RULES,
    };
    const res = await callLLM({
        api: settings.api,
        system: render(getPrompt(settings, 'cardFieldRegenSystem'), vars),
        prompt: render(getPrompt(settings, 'cardFieldRegen'), vars),
        ...chainFor(settings, 'card', project),
        expect: 'prose',
        signal,
        maxTokens: Math.max(settings.api.maxTokens || 0, 4000),
    });
    const text = removeTags(res.text, settings.extraction.filterTags).replace(/^```[a-z]*\n?|```$/g, '').trim();
    if (!text) throw new Error('AI 没有返回内容');
    if (isGreetings) {
        card.data.alternate_greetings = text.split(/\n*={5,}\n*/).map((x) => x.trim()).filter(Boolean);
    } else if (fieldKey === 'mes_example') {
        card.data.mes_example = normalizeMesExample(text, { charName: card.data.name, userName: cardUserName(project, card) });
    } else {
        card.data[fieldKey] = text;
    }
    card.lint = lintCardFor(project, settings, card.data);
    card.updatedAt = Date.now();
    return card;
}

/** 卡片内容（给 AI 看的纯文本，与 deduce.js 的 cardContentText 同一写法；这里不引用 deduce.js，避免循环依赖） */
function cardText(card) {
    const d = card.data || {};
    return [
        `姓名：${d.name}`,
        d.description ? `描述：${d.description}` : '',
        d.personality ? `性格摘要：${d.personality}` : '',
        d.scenario ? `场景：${d.scenario}` : '',
        d.first_mes ? `开场白：${truncate(d.first_mes, 1500)}` : '',
    ].filter(Boolean).join('\n\n');
}

/**
 * 「重新生成本书落点」的提示词：导向（名称、说明、词条正文）+ {{user}} 的身份 + 卡片内容 + 原著资料（角色资料 / 相关角色 / 剧情进展）。
 * @param {object} orientation 当前的导向（编辑框里可能已经改过词条正文）；不传时用 card.orientation
 * @returns {{system: string, prompt: string}}
 */
export function buildOrientationNotesPrompt(project, settings, card, { orientation = null, instruction = '' } = {}) {
    const o = normalizeCardOrientation(orientation || card.orientation);
    if (!o) throw new Error('这张卡没有选择剧情导向');
    const opt = cardPromptOpt(card);
    const upto = opt.timepoint;
    const isWorld = card.kind === 'world';
    const role = userRoleFor(project, opt);
    const parts = [];
    try {
        if (isWorld) {
            const roleChar = role.kind === 'character' ? userRoleCharName(project, role) : '';
            const mains = Object.values(project.characters || {})
                .filter((c) => c.firstChunk <= upto && c.name !== roleChar)
                .sort((a, b) => (IMPORTANCE_RANK[b.importance] - IMPORTANCE_RANK[a.importance]) || (b.chunksSeen.length - a.chunksSeen.length))
                .slice(0, 10)
                .map((c) => {
                    const v = characterAt(c, upto);
                    return `- ${v.name}：${v.identity || '身份不明'}；${truncate(v.relationship, 60)}`;
                });
            if (mains.length) parts.push(`## 主要角色\n${mains.join('\n')}`);
        } else if (project.characters?.[card.charName]) {
            const view = characterAt(project.characters[card.charName], upto);
            parts.push(`## 角色资料\n${characterProfileText(view, { maxExperiences: 8, maxQuotes: 3, withDialogues: false })}`);
            const related = relatedCharacters(project, view, upto, 8, settings);
            if (related) parts.push(`## 相关角色\n${related}`);
        }
        const outline = buildOutlineText(project, upto, 2500);
        if (outline) parts.push(`## 剧情进展\n${outline}`);
    } catch { /* 资料不全：只用已经拿到的部分 */ }
    // 这里一定有导向：「{{user}} 的身份」里两人现在的关系以导向为准（原创新身份时没有这一节）
    const roleBlock = userRolePromptBlock(project, role, { upto, world: isWorld, orientation: true });
    const vars = {
        BOOK: project.bookName,
        CHAR_NAME: card.data?.name || cardNameFor(project, opt),
        CARD_KIND: isWorld ? '世界/旁白卡' : '单人角色卡',
        TIMEPOINT: timepointLabel(project, upto),
        ORIENTATION_NAME: o.name,
        ORIENTATION_BRIEF: o.brief,
        ORIENTATION_ENTRY: o.entry || '（空）',
        USER_ROLE: roleBlock ? `\n${roleBlock}\n` : '',
        CARD_CONTENT: cardText(card),
        CONTEXT: parts.join('\n\n') || '（无）',
        INSTRUCTION_LINE: instruction.trim() ? `- 额外要求（优先满足）：${instruction.trim()}` : '',
    };
    const template = getPrompt(settings, 'orientationNotes');
    return {
        system: render(getPrompt(settings, 'orientationNotesSystem'), vars),
        prompt: appendIfMissing(template, render(template, vars), 'USER_ROLE', roleBlock),
    };
}

/**
 * 重新生成「剧情导向」词条的【本书落点】（只让 AI 写 orientation_notes，不动卡片其余部分）。
 * @param {{orientation?: object, instruction?: string, signal?: AbortSignal}} opt orientation：编辑框里当前的导向（不传时用 card.orientation）
 * @returns {Promise<string>} 规整后的本书落点（「- 」开头的若干行）；调用方决定写回哪里
 */
export async function regenerateOrientationNotes(project, settings, card, { orientation = null, instruction = '', signal } = {}) {
    const { system, prompt } = buildOrientationNotesPrompt(project, settings, card, { orientation, instruction });
    const res = await callLLM({
        api: settings.api, system, prompt, ...chainFor(settings, 'card', project), expect: 'json', signal,
        maxTokens: Math.max(settings.api.maxTokens || 0, 2000),
    });
    const raw = removeTags(res.text, settings.extraction.filterTags);
    let json = null;
    try {
        json = extractJson(raw);
    } catch { /* 不是 JSON：按「- 」开头的行取 */ }
    const notes = parseOrientationNotes(json, raw);
    if (!notes) {
        const err = new Error('AI 没有返回本书落点');
        err.raw = raw;
        throw err;
    }
    return notes;
}

/**
 * 构建 ST 可导入的角色卡 JSON（V3 规范，并带 V1 顶层字段以兼容旧版）
 * @param {object} card
 * @param {{worldName?: string, characterBook?: object|null, creator?: string, bookName?: string, statusBar?: object|false|null}} opt
 *   statusBar：settings.statusBar（取 MVU / mvu_zod 的 CDN 地址）；传 false 时即使卡片启用了状态栏也不输出。
 *   卡片的状态栏启用且有变量时（statusBarActive）额外输出：regex_scripts、tavern_helper、开场白占位标签、
 *   作者备注里的使用说明、extensions.novel_loom.statusBar；world 与 character_book.name 保持一致，
 *   没传 characterBook 时只用状态栏的四个条目建一本。
 * @throws {StatusBarExportError} 状态栏界面有错误时（见 buildStatusRegexScripts）
 */
export function buildCardJson(card, { worldName = '', characterBook = null, creator = '', bookName = '', statusBar = null } = {}) {
    const d = card.data;
    const sbOn = statusBar !== false && statusBarActive(card);
    let world = worldName || '';
    let book = characterBook;
    let firstMes = d.first_mes;
    let greetings = d.alternate_greetings;
    let notes = d.creator_notes;
    const extensions = {
        talkativeness: '0.5',
        fav: false,
        world,
        depth_prompt: { prompt: '', depth: 4, role: 'system' },
        novel_loom: { source: bookName, timepoint: card.timepoint, kind: card.kind },
    };
    if (sbOn) {
        const sb = card.statusBar;
        world = world || book?.name || sb.worldName || `${d.name}·状态栏`;
        if (!book) book = toCharacterBook(statusBarEntries(card), world);
        book = { ...book, name: world };
        extensions.world = world;
        extensions.regex_scripts = buildStatusRegexScripts(card);
        extensions.tavern_helper = buildTavernHelper(card, statusBar || {});
        extensions.novel_loom.statusBar = statusBarMeta(card);
        if (sb.options?.greetingTag !== false) {
            firstMes = withStatusTag(firstMes);
            greetings = (greetings || []).map(withStatusTag);
        }
        if (sb.options?.usageNote !== false && !String(notes || '').includes(STATUS_USAGE_NOTE_MARK)) {
            notes = notes ? `${notes}\n\n${statusBarUsageNote()}` : statusBarUsageNote();
        }
    }
    const data = {
        name: d.name,
        description: d.description,
        personality: d.personality,
        scenario: d.scenario,
        first_mes: firstMes,
        mes_example: d.mes_example,
        creator_notes: notes,
        system_prompt: d.system_prompt,
        post_history_instructions: d.post_history_instructions,
        tags: d.tags,
        creator: creator || '',
        character_version: '1.0',
        alternate_greetings: greetings,
        group_only_greetings: [],
        extensions,
    };
    if (book) data.character_book = book;
    return {
        name: d.name,
        description: d.description,
        personality: d.personality,
        scenario: d.scenario,
        first_mes: firstMes,
        mes_example: d.mes_example,
        creatorcomment: notes,
        avatar: 'none',
        talkativeness: '0.5',
        fav: false,
        tags: d.tags,
        spec: 'chara_card_v3',
        spec_version: '3.0',
        data,
        create_date: new Date().toISOString(),
    };
}

// ---------------- PNG 卡片 ----------------

const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        t[n] = c >>> 0;
    }
    return t;
})();

function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}

function utf8ToBase64(str) {
    const bytes = new TextEncoder().encode(str);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(bin);
}

function textChunk(keyword, text) {
    const enc = new TextEncoder();
    const k = enc.encode(keyword);
    const t = enc.encode(text); // base64 为 ASCII
    const data = new Uint8Array(k.length + 1 + t.length);
    data.set(k, 0);
    data[k.length] = 0;
    data.set(t, k.length + 1);
    const type = enc.encode('tEXt');
    const chunk = new Uint8Array(12 + data.length);
    const view = new DataView(chunk.buffer);
    view.setUint32(0, data.length);
    chunk.set(type, 4);
    chunk.set(data, 8);
    const crcInput = new Uint8Array(4 + data.length);
    crcInput.set(type, 0);
    crcInput.set(data, 4);
    view.setUint32(8 + data.length, crc32(crcInput));
    return chunk;
}

/** 移除已有的 chara/ccv3 文本块，并在 IEND 前写入新的 */
export function embedCardInPng(pngBytes, cardJson) {
    const src = new Uint8Array(pngBytes);
    const sig = [137, 80, 78, 71, 13, 10, 26, 10];
    if (!sig.every((b, i) => src[i] === b)) throw new Error('不是有效的 PNG 文件');
    const parts = [src.slice(0, 8)];
    let pos = 8;
    const dec = new TextDecoder();
    let iend = null;
    while (pos < src.length) {
        const view = new DataView(src.buffer, src.byteOffset + pos);
        const len = view.getUint32(0);
        const type = dec.decode(src.slice(pos + 4, pos + 8));
        const total = 12 + len;
        const chunk = src.slice(pos, pos + total);
        if (type === 'IEND') {
            iend = chunk;
            break;
        }
        if (type === 'tEXt') {
            const data = src.slice(pos + 8, pos + 8 + len);
            const zero = data.indexOf(0);
            const key = dec.decode(data.slice(0, zero)).toLowerCase();
            if (key === 'chara' || key === 'ccv3') {
                pos += total;
                continue;
            }
        }
        parts.push(chunk);
        pos += total;
    }
    const v2 = { ...cardJson, spec: 'chara_card_v2', spec_version: '2.0' };
    parts.push(textChunk('chara', utf8ToBase64(JSON.stringify(v2))));
    parts.push(textChunk('ccv3', utf8ToBase64(JSON.stringify(cardJson))));
    parts.push(iend || new Uint8Array([0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130]));
    const size = parts.reduce((n, p) => n + p.length, 0);
    const out = new Uint8Array(size);
    let o = 0;
    for (const p of parts) {
        out.set(p, o);
        o += p.length;
    }
    return out;
}

/** 生成占位头像（渐变底 + 名字） */
export async function makePlaceholderAvatar(name, { width = 400, height = 600 } = {}) {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const g = canvas.getContext('2d');
    let h = 0;
    for (const ch of String(name)) h = (h * 31 + ch.codePointAt(0)) % 360;
    const grad = g.createLinearGradient(0, 0, width, height);
    grad.addColorStop(0, `hsl(${h}, 45%, 38%)`);
    grad.addColorStop(1, `hsl(${(h + 50) % 360}, 50%, 18%)`);
    g.fillStyle = grad;
    g.fillRect(0, 0, width, height);
    g.fillStyle = 'rgba(255,255,255,0.92)';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    const text = String(name).slice(0, 8);
    const size = Math.min(96, Math.floor((width * 0.8) / Math.max(1, text.length)));
    g.font = `bold ${size}px "Microsoft YaHei", "PingFang SC", sans-serif`;
    g.fillText(text, width / 2, height / 2);
    return new Promise((resolve) => canvas.toBlob((b) => resolve(b), 'image/png'));
}

/** 把任意图片文件转成 PNG（Blob） */
export async function imageToPng(file) {
    const url = URL.createObjectURL(file);
    try {
        const img = await new Promise((resolve, reject) => {
            const i = new Image();
            i.onload = () => resolve(i);
            i.onerror = () => reject(new Error('图片无法读取'));
            i.src = url;
        });
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        canvas.getContext('2d').drawImage(img, 0, 0);
        return await new Promise((resolve) => canvas.toBlob((b) => resolve(b), 'image/png'));
    } finally {
        URL.revokeObjectURL(url);
    }
}

export async function buildPngCard(cardJson, avatarBlob) {
    const blob = avatarBlob || (await makePlaceholderAvatar(cardJson.name));
    const bytes = new Uint8Array(await blob.arrayBuffer());
    return new Blob([embedCardInPng(bytes, cardJson)], { type: 'image/png' });
}
