// 创意工坊（card studio）：从一句创意（「飞机失事，在荒岛上和 7 个美女共同求生」）一步步做出一张群像世界/旁白卡。
//   1) 大纲（generateOutline）：标题、一句话故事、世界观 / 规则 / 基调 / 地点、{{user}} 的位置、角色阵容、故事阶段；
//      可以只重新生成一部分：world（世界观）、cast（没锁定的角色）、stages（阶段）、member（换掉一个角色），锁定的角色原样保留；
//   2) 角色细节（generateCharacterDetails / generateCharacter / rerollCharacterField）：每个角色一次请求，逐个进行，
//      外貌、穿着、性格、说话方式、示例台词、背景、和 {{user}} 的关系、好感变化（4-5 级）、秘密（线索 + 揭露条件）、立绘提示词；
//      可以只重写其中一项；一个角色失败不影响别的，可以随时停止；
//   3) 开场白（generateOpeners / generateOpener）：每个阶段一段，默认前面的阶段已经发生，结尾把局面交给 {{user}}；
//      示例对话（generateExample，可选）：旁白替几个角色说话的写法；
//   4) 生成卡（buildStudioCard）：不调用 AI，按草稿组装一张世界卡（{{char}} = 旁白，扮演所有角色）：
//      开场白 = 第一个阶段的开场白，备选开场白 = 其余阶段的（按顺序，作者备注里写明哪一条是哪个阶段）；
//      卡自己的世界书（写入时见 publish.js）：每个角色一条（全部细节，秘密写明揭露前不说破）、每个地点一条、常驻的「故事阶段」，
//      以及选了时的剧情导向 / 用户偏好 / {{user}} 的身份；角色和地点另外存进项目（手动角色 / 手动条目，撞名规则同原创写卡），
//      状态栏预填主要角色、角色卡页的单字段重roll 都靠它们。「更新卡片」重新组装同一张卡（id、写入酒馆的绑定不变）。
//      状态栏（可选）用 generateStudioStatusBar，默认套用「多人群像」模板。
// 草稿的数据形状、规整、增删改都在 studio-base.js（这里全部再导出）。调用 AI 走 callLLM + chainFor(settings, 'studio')，
// 消息链没单独设置时沿用写角色卡的链。所有提示词都写明：所有角色都是成年人，涉及恋爱或亲密内容的人物（包括 {{user}}）都是成年人。
// AI 的输出一律当作不可信的文字：只经过规整后存进草稿，界面显示时要转义。不碰 DOM。

import { lintCardFor, normalizeMesExample, originalStyleText } from './cards.js';
import { extractJson, removeTags } from './json.js';
import { callLLM, chainFor, errorText } from './llm.js';
import { characterClash, designToCharacter, entryClash, normalizeCardOriginal, originalLoreCategories, suffixedName } from './original.js';
import { normalizeCardOrientation, orientationFromPick, orientationPromptBlock, parseOrientationNotes } from './orientation.js';
import { isSpecificAlias, pruneGroupCards, prunePov, pruneRelationships, renameCharacter } from './project.js';
import { WRITING_RULES, getPrompt, render } from './prompts.js';
import { generateStatusBar } from './statusbar-ai.js';
import { castRecords, ensureStatusBar, seedWorldCastEntries } from './statusbar.js';
import { cloneJson } from './statusbar-base.js';
import { applyStatusBarTemplate, getStatusBarTemplate } from './statusbar-templates.js';
import {
    STUDIO_DETAIL_FIELDS, STUDIO_LIMITS, STUDIO_SOURCE, STUDIO_STATUSBAR_TEMPLATE, castAgeText, detailsFilled, emptyDetails, emptyOutline, normalizeCastMember,
    normalizeDetails, normalizeLocation, normalizeOutline, normalizeStage, pickKey, premiseCastCount, pruneStudio, studioCastStatus, studioDetailField,
    studioHasOutline, studioOpenerStatus, studioOutlineTouched, studioProgress, studioStageLabel, textOf,
} from './studio-base.js';
import { normalizeUserRole, userRoleLabel, userRolePromptBlock } from './userrole.js';
import { normalizeCardUserProfile, userProfilePromptBlock, userProfileSnapshot } from './userprofile.js';
import { abortError, hashString, isAbortError, truncate, uid, uniq } from './utils.js';

export * from './studio-base.js';

/** generateOutline 的 mode：all 整份（锁定的角色保留）/ world 世界观 / cast 没锁定的角色 / stages 故事阶段 / member 换掉一个角色 */
export const OUTLINE_MODES = Object.freeze(['all', 'world', 'cast', 'stages', 'member']);
export const OUTLINE_MODE_LABELS = Object.freeze({ all: '整份大纲', world: '世界观', cast: '角色阵容', stages: '故事阶段', member: '这个角色' });

const BAD_JSON_FEEDBACK = '上面的输出不是合法 JSON（可能被截断或含未转义的引号）。请重新输出完整、合法的 JSON 对象，只输出 JSON。字符串中的双引号请改用中文引号。';

function isObj(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function oneLine(v, max = 200) {
    return String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function touch(studio) {
    studio.updatedAt = Date.now();
}

/** 解析出了问题、值得带着原因让 AI 重写一次的错误（e.feedback 是发回给 AI 的话） */
function feedbackError(message, feedback = '') {
    const e = new Error(message);
    e.feedback = feedback || `${message}。请按 JSON 模板重新输出完整的 JSON 对象，只输出 JSON。`;
    return e;
}

// ---------------- 选项 → 写卡用的快照 ----------------

/** 构思选的卡的导向（快照，不含本卡落点）；不限时为 null */
export function studioOrientation(settings, studio) {
    const o = studio?.options || {};
    return orientationFromPick(settings, { id: o.orientationId, customName: o.orientationName, customBrief: o.orientationBrief, refine: true });
}

/** 构思选的用户画像快照；没选或画像已经删掉时为 null */
export function studioProfile(settings, studio) {
    const id = studio?.options?.profileId;
    return id ? userProfileSnapshot(settings, id) : null;
}

/** {{user}} 的身份：原创新身份，或自定义（写了内容时） */
export function studioUserRole(studio) {
    return normalizeUserRole(studio?.options?.userRole);
}

/** 这次的人数：选项里的 > 创意里写明的（「7 个美女」）> 没有（null，让 AI 定） */
export function studioCastCount(studio) {
    return Number(studio?.options?.count) || premiseCastCount(studio?.premise) || null;
}

function styleText(project, settings) {
    try {
        return originalStyleText(project, settings);
    } catch {
        return '（未指定文风：按创意和用户要求把握语气、节奏和对话写法）';
    }
}

function wrap(block) {
    return block ? `\n${block}\n` : '';
}

/** 几个提示词共用的变量：文风、用户要求、{{user}} 的身份、卡的导向、用户画像 */
function sharedVars(project, settings, studio, { askNotes = false } = {}) {
    const role = studioUserRole(studio);
    const orient = studioOrientation(settings, studio);
    // 导向模板是给小说写卡用的（「优先从原著选取」）：创意工坊没有原著，从大纲里的角色里选
    let orientationBlock = orientationPromptBlock(orient, { askNotes, original: true }).replace(/（优先从原著(?:中)?选取）/g, '（从大纲里的角色中选）');
    // 导向模板是按单人卡写的（「为 {{char}} 设定一个恋人」），群像世界卡里的 {{char}} 是旁白：说明一下落在谁身上
    if (orientationBlock) orientationBlock += '\n- 这是一张群像世界卡：导向里说的 {{char}} 指故事里的角色，可以落在其中一个或几个角色身上，按群像来安排。';
    // 写单个角色 / 开场白时：上面的写卡要求是对整张卡的安排，这个角色在导向里的位置看大纲里的「剧情导向的落点」
    if (orientationBlock && !askNotes && String(studio?.outline?.orientationNotes || '').trim()) {
        orientationBlock += '\n- 写卡要求是对整张卡的安排；每个角色在导向里的位置以大纲里的「剧情导向的落点」为准（不是每个角色都要倾心于 {{user}}）。';
    }
    const userRoleBlock = userRolePromptBlock(project, role, { world: true, orientation: !!orientationBlock, original: true });
    const userProfileBlock = userProfilePromptBlock(studioProfile(settings, studio), {
        orientation: !!orientationBlock, orientationName: orient?.name || '', userRoleKind: role.kind, original: true,
    });
    const extra = String(studio?.options?.extra || '').trim();
    return {
        blocks: { USER_ROLE: userRoleBlock, ORIENTATION: orientationBlock, USER_PROFILE: userProfileBlock },
        vars: {
            BOOK: project?.bookName || project?.name || '',
            STYLE: styleText(project, settings),
            REQUIREMENT: [extra, settings?.cards?.defaultRequirement].filter(Boolean).join('\n')
                || (role.kind === 'new' ? '（无特别要求，{{user}} 以符合创意的新身份出现）' : '（无特别要求）'),
            USER_ROLE: wrap(userRoleBlock),
            ORIENTATION: wrap(orientationBlock),
            USER_PROFILE: wrap(userProfileBlock),
            WRITING_RULES,
        },
    };
}

/** 渲染模板；用户改过的模板里没有某个占位符时，把对应的内容追加在末尾（{{user}} 的身份、导向、画像、JSON 模板照样生效） */
function renderWith(settings, key, vars, appendBlocks = {}) {
    const template = getPrompt(settings, key);
    let text = render(template, vars);
    for (const [k, block] of Object.entries(appendBlocks)) {
        if (block && !String(template).includes(`{${k}}`)) text = `${text}\n\n${block}`;
    }
    return text;
}

function instructionLine(instruction) {
    const s = String(instruction || '').trim();
    return s ? `\n- 额外要求（优先满足）：${s}` : '';
}

// ---------------- 给 AI 看的文字 ----------------

function kv(label, value) {
    const v = String(value ?? '').trim();
    if (!v) return '';
    return v.includes('\n') ? `${label}:\n${v.split('\n').map((l) => `  ${l}`).join('\n')}` : `${label}: ${v}`;
}

/** 一个角色在大纲里的一行：名字（年龄，身份）：一句话 */
function castLine(m) {
    const head = [castAgeText(m), m.gender, m.identity].filter(Boolean).join('，');
    return `${m.name || '（未命名）'}${m.aliases?.length ? `（又称 ${m.aliases.join('、')}）` : ''}（${head}）${m.oneLiner ? `：${m.oneLiner}` : ''}${m.tags?.length ? `　标签：${m.tags.join('、')}` : ''}`;
}

function memberText(m) {
    return [
        `姓名: ${m.name}`, m.aliases.length ? `别名: ${m.aliases.join('、')}` : '', m.gender ? `性别: ${m.gender}` : '', `年龄: ${castAgeText(m)}`,
        m.identity ? `身份: ${m.identity}` : '', m.oneLiner ? `一句话: ${m.oneLiner}` : '', m.tags.length ? `标签: ${m.tags.join('、')}` : '',
    ].filter(Boolean).join('\n');
}

function stageText(s, i) {
    return [`${i + 1}. ${s.name || '未命名'}${s.time ? `（${s.time}）` : ''}`, s.summary ? `   处境：${s.summary.replace(/\n+/g, ' ')}` : '', s.conflict ? `   核心冲突：${s.conflict.replace(/\n+/g, ' ')}` : '']
        .filter(Boolean).join('\n');
}

/** 大纲（世界观、地点、{{user}} 的位置；withCast / withStages 时附上角色和阶段） */
export function studioOutlineText(studio, { withCast = false, withStages = false } = {}) {
    const o = studio?.outline || emptyOutline();
    const parts = [
        o.title ? `标题：${o.title}` : '',
        o.logline ? `一句话故事：${o.logline}` : '',
        o.world.setting ? `## 世界观\n${o.world.setting}` : '',
        o.world.rules ? `## 世界规则\n${o.world.rules}` : '',
        o.world.tone ? `## 基调\n${o.world.tone}` : '',
        o.world.locations.some((l) => l.name) ? `## 主要地点\n${o.world.locations.filter((l) => l.name).map((l) => `- ${l.name}${l.desc ? `：${l.desc.replace(/\n+/g, ' ')}` : ''}`).join('\n')}` : '',
        o.userRole ? `## {{user}} 的位置\n${o.userRole}` : '',
        o.orientationNotes ? `## 剧情导向的落点\n${o.orientationNotes}` : '',
        withCast && o.cast.length ? `## 角色\n${o.cast.map((m) => `- ${castLine(m)}${m.locked ? '（用户锁定）' : ''}`).join('\n')}` : '',
        withStages && o.stages.length ? `## 故事阶段\n${o.stages.map(stageText).join('\n')}` : '',
    ];
    return parts.filter(Boolean).join('\n') || '（大纲还是空的）';
}

function stagesText(studio) {
    const list = studio?.outline?.stages || [];
    return list.length ? list.map(stageText).join('\n') : '（还没有阶段）';
}

/** 写了内容的好感等级（跳过角色页里刚加的空行） */
function affectionOf(d) {
    return (d?.affection || []).filter((a) => a && (String(a.label || '').trim() || String(a.behavior || '').trim()));
}

/** 一个角色已经写好的细节（给其他角色、开场白做参考时的简要版） */
function detailsBrief(d, { secret = false } = {}) {
    if (!detailsFilled(d)) return '';
    const cut = (s, n) => truncate(oneLine(s, 400), n);
    return [
        d.appearance ? `  外貌：${cut(d.appearance, 60)}` : '',
        d.personality ? `  性格：${cut(d.personality, 80)}` : '',
        d.speech ? `  说话：${cut(d.speech, 60)}` : '',
        d.relationToUser ? `  和 {{user}}：${cut(d.relationToUser, 60)}` : '',
        affectionOf(d).length ? `  好感：${affectionOf(d).map((a, i) => a.label || `第 ${i + 1} 级`).join(' → ')}` : '',
        secret && d.secret?.content ? `  秘密（不要和 TA 的重样）：${cut(d.secret.content, 40)}` : '',
        !secret && d.secret?.hints ? `  秘密的线索（只能暗示）：${cut(d.secret.hints, 60)}` : '',
    ].filter(Boolean).join('\n');
}

function othersText(studio, castId) {
    const list = (studio?.outline?.cast || []).filter((c) => c.id !== castId && c.name);
    if (!list.length) return '（没有其他角色）';
    return list.map((c) => {
        const brief = detailsBrief(studio.details?.[c.id], { secret: true });
        return `- ${castLine(c)}${brief ? `\n${brief}` : ''}`;
    }).join('\n');
}

function castBriefText(studio) {
    const list = (studio?.outline?.cast || []).filter((c) => c.name);
    if (!list.length) return '（还没有角色）';
    return list.map((c) => {
        const brief = detailsBrief(studio.details?.[c.id]);
        return `- ${castLine(c)}${brief ? `\n${brief}` : ''}`;
    }).join('\n');
}

/** 一个角色全部细节的文字（只重写一项时作为「当前内容」；写进世界书的版本见 studioCharacterEntryText） */
function detailsText(d) {
    if (!d) return '（还没有写）';
    const lines = [
        kv('外貌', d.appearance), kv('穿着', d.outfit), kv('性格', d.personality), kv('说话方式', d.speech),
        d.sampleLines?.length ? `示例台词:\n${d.sampleLines.map((l) => `  - 「${l}」`).join('\n')}` : '',
        kv('背景经历', d.background), kv('与 {{user}} 的关系', d.relationToUser),
        affectionOf(d).length ? `好感变化:\n${affectionOf(d).map((a, i) => `  ${i + 1}. ${a.label}：${a.behavior}`).join('\n')}` : '',
        d.secret?.content ? `秘密: ${d.secret.content}${d.secret.hints ? `\n  线索: ${d.secret.hints}` : ''}${d.secret.reveal ? `\n  揭露条件: ${d.secret.reveal}` : ''}` : '',
        kv('立绘提示词', d.portraitPrompt),
    ].filter(Boolean);
    return lines.join('\n') || '（还没有写）';
}

// ---------------- 大纲 ----------------

const CAST_JSON = '{"name": "名字", "aliases": ["昵称"], "gender": "女|男", "age": "24", "identity": "身份或职业", "one_liner": "性格底色 + 在群体里的作用", "tags": ["标签"]}';
const STAGE_JSON = '{"name": "阶段名", "time": "第 1 天", "summary": "这一阶段的处境和大致走向", "conflict": "核心冲突或悬念"}';
const WORLD_JSON = [
    '"world": {',
    '    "setting": "时代 / 地点 / 处境（数据库格式）",',
    '    "rules": "硬规则，每行一条",',
    '    "tone": "基调与氛围",',
    '    "locations": [',
    '      {"name": "地点名", "desc": "样子、用途、在故事里的作用"}',
    '    ]',
    '  }',
].join('\n');
const NOTES_JSON = '"orientation_notes": "- ……\\n- ……"';

/** 大纲的 JSON 模板（随这次要改的部分变化） */
function outlineJsonTemplate(mode, { notes = false } = {}) {
    const fields = [];
    if (mode === 'all' || mode === 'world') {
        fields.push('"title": "卡名"', '"logline": "一句话故事"', WORLD_JSON, '"user_role": "{{user}} 的身份、为什么在场、和众人的关系、切入点"');
    }
    if (mode === 'all' || mode === 'cast') fields.push(`"cast": [\n    ${CAST_JSON}\n  ]`);
    if (mode === 'all' || mode === 'stages') fields.push(`"stages": [\n    ${STAGE_JSON}\n  ]`);
    if (mode === 'member') fields.push(`"member": ${CAST_JSON}`);
    if (notes) fields.push(NOTES_JSON);
    return `{\n  ${fields.join(',\n  ')}\n}`;
}

function lockedText(studio) {
    const locked = (studio?.outline?.cast || []).filter((c) => c.locked && c.name);
    return locked.length ? `\n# 用户锁定的角色（原样保留，算在人数里）\n${locked.map((c) => `- ${castLine(c)}`).join('\n')}\n` : '';
}

/**
 * 大纲提示词（设计群像故事大纲）。
 * @param {{mode?: string, memberId?: string, instruction?: string}} opt mode 见 OUTLINE_MODES；member 时 memberId 是要换掉的角色
 * @returns {{system: string, prompt: string, mode: string, count: number|null}}
 */
export function buildOutlinePrompt(project, settings, studio, { mode = 'all', memberId = '', instruction = '' } = {}) {
    if (!OUTLINE_MODES.includes(mode)) throw new Error(`未知的重新生成方式：${mode}`);
    const o = studio.outline;
    const locked = o.cast.filter((c) => c.locked && c.name);
    const count = mode === 'cast' ? studioCastCount(studio) || o.cast.length || null : studioCastCount(studio);
    const stages = Number(studio.options.stages) || null;
    const member = mode === 'member' ? o.cast.find((c) => c.id === memberId) : null;
    if (mode === 'member' && !member) throw new Error('要换掉的角色已经不在大纲里了');
    const fromPremise = !studio.options.count && count && premiseCastCount(studio.premise) === count;
    const countRule = count
        ? `正好 ${count} 人（不含 {{user}}${fromPremise ? '，创意里写明的' : ''}）${locked.length ? `，其中 ${locked.length} 人是用户锁定的（见「用户锁定的角色」）` : ''}`
        : '没有指定：按创意决定（创意里写了人数就照办），一般 3-8 人，不含 {{user}}';
    const stageRule = stages ? `正好 ${stages} 个阶段` : '没有指定：按故事需要分 4-6 个阶段';
    const orient = studioOrientation(settings, studio);
    const askNotes = !!orient?.refine && (mode === 'all' || mode === 'cast');
    const { vars: shared, blocks } = sharedVars(project, settings, studio, { askNotes });
    let current = '';
    let modeRule = '';
    if (mode === 'all') {
        current = lockedText(studio);
        if (locked.length) modeRule = '\n- 「用户锁定的角色」原样写进 cast（名字、年龄、身份、一句话、标签都不改），其余角色重新设计，和锁定的角色互补。';
    } else {
        current = `\n# 当前大纲（以此为准，只改要你改的部分）\n<当前大纲>\n${studioOutlineText(studio, { withCast: true, withStages: true })}\n</当前大纲>\n${mode === 'cast' ? lockedText(studio) : ''}`;
        if (mode === 'world') {
            modeRule = '\n\n# 这次只改世界观\n只重新设计 title、logline、world 和 user_role（只重新设计世界观）：「当前大纲」里的角色和阶段保持不变，新的世界观要放得下他们。只输出模板里的这几个字段。';
        } else if (mode === 'cast') {
            modeRule = `\n\n# 这次只改角色阵容\n只重新设计 cast（只重新设计角色阵容）：「用户锁定的角色」原样保留，其余换成新的人物${count ? `，一共 ${count} 人` : ''}；世界观和阶段保持不变，新角色要放得进「当前大纲」的世界和阶段。只输出模板里的字段。`;
        } else if (mode === 'stages') {
            modeRule = '\n\n# 这次只改故事阶段\n只重新设计 stages（只重新设计故事阶段）：世界观和角色保持不变，阶段要用上这些角色和地点。只输出模板里的字段。';
        } else {
            modeRule = `\n\n# 这次只换掉一位角色\n只重新设计「${member.name || '未命名'}」这一位（只换掉一位角色）：换成一个新的人物填这个位置——名字、年龄、身份、一句话、标签都换，和其他角色明显区分开；世界观、其他角色和阶段保持不变。只输出模板里的 member。`;
        }
    }
    const jsonTemplate = outlineJsonTemplate(mode, { notes: askNotes });
    const vars = {
        ...shared,
        PREMISE: String(studio.premise || '').trim() || '（没有写，按「当前大纲」来）',
        COUNT_RULE: countRule,
        STAGE_RULE: stageRule,
        CURRENT: current,
        MODE_RULE: modeRule,
        INSTRUCTION_LINE: instructionLine(instruction),
        JSON_TEMPLATE: jsonTemplate,
    };
    const prompt = renderWith(settings, 'studioOutline', vars, {
        ...blocks, CURRENT: current.trim(), MODE_RULE: modeRule.trim(), JSON_TEMPLATE: `# 输出 JSON 模板\n${jsonTemplate}`,
    });
    return { system: renderWith(settings, 'studioOutlineSystem', vars), prompt, mode, count };
}

function rawCastList(v) {
    if (Array.isArray(v)) return v;
    if (isObj(v)) return Object.entries(v).map(([name, x]) => (isObj(x) ? { name, ...x } : { name, one_liner: String(x ?? '') }));
    return [];
}

/** AI 的角色阵容 → 规整好的新角色（没名字、重名的丢掉；id 一律新编，之后再和旧的对上） */
function freshCast(list, warnings) {
    const out = [];
    for (const raw of rawCastList(list)) {
        const m = normalizeCastMember(isObj(raw) ? { ...raw, id: uid('sc_'), locked: false } : null, { warnings });
        if (!m?.name || out.some((x) => x.name === m.name)) continue;
        out.push(m);
    }
    return out;
}

/**
 * 新的角色阵容：锁定的角色原样留在原来的位置，没锁定的位置依次换成 AI 给的新角色，多的接在后面；
 * 名字和身份都没变的沿用原来的 id（已经写好的细节不丢）。人数定了时去掉多出来的（从后往前，只去没锁定的），少了记一句。
 */
function mergeCast(current, fresh, { count = null, warnings }) {
    const locked = current.filter((c) => c.locked);
    const pool = fresh.filter((m) => !locked.some((l) => l.name === m.name));
    const oldFree = current.filter((c) => !c.locked);
    for (const m of pool) {
        const old = oldFree.find((o) => o.name === m.name && o.identity === m.identity);
        if (old && !pool.some((x) => x !== m && x.id === old.id)) m.id = old.id;
    }
    const result = [];
    let i = 0;
    for (const c of current) {
        if (c.locked) result.push(c);
        else if (i < pool.length) result.push(pool[i++]);
    }
    while (i < pool.length) result.push(pool[i++]);
    const target = Math.min(STUDIO_LIMITS.cast, count ? Math.max(count, locked.length) : STUDIO_LIMITS.cast);
    while (result.length > target) {
        let k = -1;
        for (let j = result.length - 1; j >= 0; j--) {
            if (!result[j].locked) {
                k = j;
                break;
            }
        }
        if (k < 0) break;
        result.splice(k, 1);
    }
    if (count && result.length < count) warnings.push(`AI 只给了 ${result.length} 个角色（要 ${count} 个），可以在大纲里手动添加，或再生成一次角色阵容`);
    return result;
}

function mergeStages(current, list, { count = null, warnings }) {
    const out = [];
    for (const raw of Array.isArray(list) ? list : []) {
        const s = normalizeStage(isObj(raw) ? { ...raw, id: uid('ss_') } : null);
        if (!s || (!s.name && !s.summary)) continue;
        const old = current.find((o) => o.name && o.name === s.name && o.time === s.time);
        if (old && !out.some((x) => x.id === old.id)) s.id = old.id;
        out.push(s);
    }
    const max = Math.min(STUDIO_LIMITS.stages, count || STUDIO_LIMITS.stages);
    if (out.length > max) out.length = max;
    if (count && out.length < count) warnings.push(`AI 只给了 ${out.length} 个阶段（要 ${count} 个）`);
    return out;
}

/**
 * 解析大纲的回复并和当前大纲合并（不修改 current）。字段名宽松：snake_case / camelCase / 中文都认，cast 也认按名字分组的对象。
 * 年龄写成未满 18 岁的改成 18 岁、身份里的学生 / 未成年说法换掉，都记进 warnings。
 * @param {object} json
 * @param {{mode?: string, current?: object, memberId?: string, count?: number|null, stages?: number|null}} opt
 * @returns {{outline: object, warnings: string[]}}
 * @throws 带 feedback 的错误：缺了这次必须有的部分（可以带着原因让 AI 重写一次）
 */
export function parseStudioOutline(json, { mode = 'all', current = null, memberId = '', count = null, stages = null } = {}) {
    const warnings = [];
    const src = isObj(json) ? json : {};
    const cur = normalizeOutline(current || emptyOutline());
    const out = normalizeOutline(cur);
    if (mode === 'all' || mode === 'world') {
        const w = pickKey(src, ['world', '世界观', '世界']);
        const wo = isObj(w) ? w : { setting: w };
        const pick = (keys) => pickKey(wo, keys) ?? pickKey(src, keys);
        const setting = textOf(pick(['setting', '设定', '背景', '时代']), STUDIO_LIMITS.setting);
        const rules = textOf(pick(['rules', '规则', '世界规则']), STUDIO_LIMITS.rules);
        const tone = oneLine(textOf(pick(['tone', '基调', '氛围']), STUDIO_LIMITS.tone), STUDIO_LIMITS.tone);
        const locRaw = pick(['locations', '地点', '主要地点']);
        const locations = [];
        for (const l of Array.isArray(locRaw) ? locRaw : isObj(locRaw) ? Object.entries(locRaw).map(([name, desc]) => ({ name, desc })) : []) {
            const x = normalizeLocation(l);
            if (x?.name && !locations.some((y) => y.name === x.name)) locations.push(x);
            if (locations.length >= STUDIO_LIMITS.locations) break;
        }
        const title = oneLine(pickKey(src, ['title', '卡名', '标题', 'name']), STUDIO_LIMITS.title);
        const logline = oneLine(pickKey(src, ['logline', '一句话故事', '简介']), STUDIO_LIMITS.logline);
        const userRole = textOf(pickKey(src, ['user_role', 'userRole', 'user', '用户身份', '{{user}} 的位置']), STUDIO_LIMITS.userRole);
        if (!setting && !rules && !locations.length && !title) {
            throw feedbackError('AI 没有返回世界观（world）', '上面的回复里没有 world（世界观）。请按 JSON 模板重新输出完整的 JSON 对象，只输出 JSON。');
        }
        out.title = title || out.title;
        out.logline = logline || out.logline;
        out.world = {
            setting: setting || out.world.setting,
            rules: rules || out.world.rules,
            tone: tone || out.world.tone,
            locations: locations.length ? locations : out.world.locations,
        };
        out.userRole = userRole || out.userRole;
    }
    if (mode === 'all' || mode === 'cast') {
        const fresh = freshCast(pickKey(src, ['cast', 'characters', '角色', '主要角色']), warnings);
        if (!fresh.length && !(mode === 'all' && cur.cast.some((c) => c.locked))) {
            throw feedbackError('AI 没有返回角色阵容（cast）', '上面的回复里没有 cast（角色阵容），或者角色都没有名字。请按 JSON 模板重新输出完整的 JSON 对象，只输出 JSON。');
        }
        out.cast = mergeCast(cur.cast, fresh, { count, warnings });
    }
    if (mode === 'all' || mode === 'stages') {
        const list = pickKey(src, ['stages', '阶段', '故事阶段']);
        const merged = mergeStages(cur.stages, list, { count: stages, warnings });
        if (!merged.length) throw feedbackError('AI 没有返回故事阶段（stages）', '上面的回复里没有 stages（故事阶段）。请按 JSON 模板重新输出完整的 JSON 对象，只输出 JSON。');
        out.stages = merged;
    }
    if (mode === 'member') {
        const i = cur.cast.findIndex((c) => c.id === memberId);
        if (i < 0) throw new Error('要换掉的角色已经不在大纲里了');
        const raw = pickKey(src, ['member', 'character', '角色']) ?? rawCastList(pickKey(src, ['cast', 'characters']))[0];
        const m = normalizeCastMember(isObj(raw) ? { ...raw, id: uid('sc_'), locked: false } : null, { warnings });
        if (!m?.name) throw feedbackError('AI 没有返回新的角色（member）', '上面的回复里没有 member（新的角色）或者没有名字。请按 JSON 模板重新输出，只输出 JSON。');
        if (cur.cast.some((c, j) => j !== i && c.name === m.name)) {
            throw feedbackError(`新角色的名字「${m.name}」和别的角色重复`, `新角色的名字「${m.name}」和大纲里的其他角色重复了。请换一个不重复的名字，按 JSON 模板重新输出，只输出 JSON。`);
        }
        out.cast[i] = m;
        // 换掉的是另一个人：导向落点、阶段里还写着原来那个人时提醒一句（不自动替换，新的人不一定接得住原来的安排）
        const oldName = cur.cast[i].name;
        if (oldName && oldName !== m.name) {
            const where = [
                out.orientationNotes.includes(oldName) ? '导向落点' : '',
                ...out.stages.map((s, k) => (`${s.summary}\n${s.conflict}`.includes(oldName) ? `第 ${k + 1} 阶段` : '')),
            ].filter(Boolean);
            if (where.length) warnings.push(`${where.join('、')}里还提到「${oldName}」（已经换成「${m.name}」），可以在大纲里改一下`);
        }
    }
    const notes = parseOrientationNotes(src);
    if (notes) out.orientationNotes = notes;
    return { outline: normalizeOutline(out), warnings };
}

/** 调用 AI 拿一个 JSON 回复并解析；不是合法 JSON、或者 parse 抛出带 feedback 的错误时，带着原因重试一次 */
async function askJson(project, settings, { system, prompt, signal, onLog, label, minTokens, parse }) {
    const followUps = [];
    let lastErr = null;
    for (let attempt = 0; attempt < 2; attempt++) {
        if (signal?.aborted) throw abortError();
        const res = await callLLM({
            api: settings.api, system, prompt, followUps, ...chainFor(settings, 'studio', project), expect: 'json', signal,
            maxTokens: Math.max(settings.api?.maxTokens || 0, minTokens),
            onNotice: (m, l) => onLog?.(`${label}${m}`, l),
        });
        const raw = removeTags(res.text, settings.extraction?.filterTags);
        let json;
        try {
            json = extractJson(raw);
        } catch (e) {
            e.raw = raw;
            lastErr = e;
            followUps.push({ role: 'assistant', content: String(res.text).slice(0, 6000) }, { role: 'user', content: BAD_JSON_FEEDBACK });
            if (attempt === 0) onLog?.(`${label}返回的不是合法 JSON，重试一次…`, 'warn');
            continue;
        }
        try {
            return parse(json);
        } catch (e) {
            if (!e.feedback) throw e;
            e.raw = raw;
            lastErr = e;
            followUps.push({ role: 'assistant', content: String(res.text).slice(0, 6000) }, { role: 'user', content: e.feedback });
            if (attempt === 0) onLog?.(`${label}${e.message}，重试一次…`, 'warn');
        }
    }
    throw lastErr || new Error('AI 没有返回可用的内容');
}

/** 调用 AI 拿一段正文；parse 抛出带 feedback 的错误时带着原因重试一次 */
async function askProse(project, settings, { system, prompt, signal, onLog, label, minTokens, parse }) {
    const followUps = [];
    let lastErr = null;
    for (let attempt = 0; attempt < 2; attempt++) {
        if (signal?.aborted) throw abortError();
        const res = await callLLM({
            api: settings.api, system, prompt, followUps, ...chainFor(settings, 'studio', project), expect: 'prose', signal,
            maxTokens: Math.max(settings.api?.maxTokens || 0, minTokens),
            onNotice: (m, l) => onLog?.(`${label}${m}`, l),
        });
        const raw = removeTags(res.text, settings.extraction?.filterTags);
        try {
            return parse(raw);
        } catch (e) {
            if (!e.feedback) throw e;
            e.raw = raw;
            lastErr = e;
            followUps.push({ role: 'assistant', content: String(res.text).slice(0, 6000) }, { role: 'user', content: e.feedback });
            if (attempt === 0) onLog?.(`${label}${e.message}，重试一次…`, 'warn');
        }
    }
    throw lastErr || new Error('AI 没有返回可用的内容');
}

/**
 * 生成大纲（或只重新生成其中一部分），结果写回 studio.outline（就地修改）：锁定的角色原样保留；
 * 换掉的角色 / 阶段对应的细节和开场白一并清掉（outlineRerollImpact 可以先算出会清掉多少）。
 * @param {{mode?: string, memberId?: string, instruction?: string, signal?: AbortSignal, onLog?: Function}} opt
 * @returns {Promise<{outline: object, warnings: string[], removed: {details: number, openers: number}}>}
 */
export async function generateOutline(project, settings, studio, { mode = 'all', memberId = '', instruction = '', signal, onLog } = {}) {
    if (!OUTLINE_MODES.includes(mode)) throw new Error(`未知的重新生成方式：${mode}`);
    if (mode === 'all' && !String(studio.premise || '').trim() && !studioOutlineTouched(studio)) throw new Error('请先写下你的创意');
    // 只改一部分时要大纲里已经有东西（阶段删光了也可以只重新生成阶段）
    if (mode !== 'all' && !studioOutlineTouched(studio)) throw new Error('还没有大纲：先生成整份大纲');
    if (mode === 'member') {
        const m = studio.outline.cast.find((c) => c.id === memberId);
        if (!m) throw new Error('要换掉的角色已经不在大纲里了');
        if (m.locked) throw new Error(`「${m.name}」已经锁定：先解锁再换`);
    }
    const { system, prompt, count } = buildOutlinePrompt(project, settings, studio, { mode, memberId, instruction });
    const what = mode === 'member' ? `换掉「${studio.outline.cast.find((c) => c.id === memberId)?.name || ''}」` : `生成${OUTLINE_MODE_LABELS[mode]}`;
    onLog?.(`🧭 正在为「${studio.title || '构思'}」${what}…`);
    const result = await askJson(project, settings, {
        system, prompt, signal, onLog, label: '「大纲」', minTokens: 8000,
        parse: (json) => parseStudioOutline(json, { mode, current: studio.outline, memberId, count, stages: Number(studio.options.stages) || null }),
    });
    if (signal?.aborted) throw abortError();
    studio.outline = result.outline;
    const removed = pruneStudio(studio);
    if (!String(studio.title || '').trim() && result.outline.title) studio.title = result.outline.title;
    if (studio.step < 2) studio.step = 2;
    touch(studio);
    for (const w of result.warnings) onLog?.(`⚠️ ${w}`, 'warn');
    return { outline: studio.outline, warnings: result.warnings, removed };
}

// ---------------- 角色细节 ----------------

/** 立绘提示词模板开头的性别词；性别没写（或认不出）时只写 adult（不给「adult woman|adult man」这种会被照抄的占位） */
function portraitGenderWord(m) {
    const g = String(m.gender || '');
    // 先认女性（female 里含 male）
    if (/女|\bfemale\b|\bwoman\b|\bgirl\b/i.test(g)) return 'adult woman';
    if (/男|\bmale\b|\bman\b|\bboy\b/i.test(g)) return 'adult man';
    return 'adult';
}

const DETAIL_JSON = {
    appearance: '"appearance": "外貌（数据库格式）"',
    outfit: '"outfit": "现在的穿着和随身物品"',
    personality: '"personality": "性格调色盘（数据库格式）"',
    speech: '"speech": "说话方式"',
    sampleLines: '"sample_lines": ["台词", "台词", "台词"]',
    background: '"background": "关键经历"',
    relationToUser: '"relation_to_user": "和 {{user}} 的关系与初始态度"',
    affection: [
        '"affection": [',
        '    {"level": 1, "label": "戒备", "behavior": "这一级时对 {{user}} 的具体表现"},',
        '    {"level": 2, "label": "熟悉", "behavior": "……"},',
        '    {"level": 3, "label": "信任", "behavior": "……"},',
        '    {"level": 4, "label": "依恋", "behavior": "……"}',
        '  ]',
    ].join('\n'),
    secret: '"secret": {"content": "秘密本身", "hints": "平时露出的蛛丝马迹", "reveal": "揭露条件"}',
    portraitPrompt: '"portrait_prompt": "{GENDER}, ……"',
};

function detailJsonTemplate(m, field = '') {
    const keys = field ? [field] : Object.keys(DETAIL_JSON);
    return `{\n  ${keys.map((k) => DETAIL_JSON[k].replace('{GENDER}', portraitGenderWord(m))).join(',\n  ')}\n}`;
}

/** 用户已经写了的细节项（补全时原样保留）：字段 key 列表 */
function filledDetailKeys(d) {
    if (!d) return [];
    return STUDIO_DETAIL_FIELDS.map((f) => f.key).filter((k) => {
        const v = d[k];
        if (k === 'secret') return !!(v?.content || v?.hints || v?.reveal);
        if (k === 'affection') return affectionOf(d).length > 0;
        return Array.isArray(v) ? v.length > 0 : !!String(v || '').trim();
    });
}

/**
 * 角色细节提示词（展开角色细节）。field 给了时只重写这一项（其余各项作为「当前内容」给 AI 看）；
 * complete 时是补全：用户已经写了的几项原样保留，其余各项按它们补全。
 * @param {{field?: string, instruction?: string, complete?: boolean}} opt field：STUDIO_DETAIL_FIELDS 的 key
 * @returns {{system: string, prompt: string}}
 */
export function buildCharacterPrompt(project, settings, studio, castId, { field = '', instruction = '', complete = false } = {}) {
    const m = studio.outline.cast.find((c) => c.id === castId);
    if (!m) throw new Error('这个角色已经不在大纲里了');
    if (!m.name) throw new Error('这个角色还没有名字：先在大纲里填上');
    const f = field ? studioDetailField(field) : null;
    if (field && !f) throw new Error(`不认识的字段：${field}`);
    const { vars: shared, blocks } = sharedVars(project, settings, studio);
    const cur = studio.details?.[castId];
    const kept = !f && complete ? filledDetailKeys(cur) : [];
    let modeRule = '';
    if (f) {
        modeRule = `\n\n# 这次只重写一项\n只重写「${f.label}」这一项（只重写这一项）：其余各项保持下面的「当前内容」不变，新写的「${f.label}」要和它们对得上，写法要和当前的有实质区别。只输出模板里的这一个字段。\n<当前内容>\n${detailsText(cur)}\n</当前内容>`;
    } else if (kept.length) {
        const labels = kept.map((k) => studioDetailField(k).label).join('、');
        modeRule = `\n\n# 这次是补全\n用户已经写了这个角色的${labels}（见下面的「已经写好的内容」）：这几项原样保留，不要改写；把其余各项补全，和已经写好的内容对得上。JSON 里照样输出全部字段（已经写好的几项原样抄上）。\n<已经写好的内容>\n${detailsText(cur)}\n</已经写好的内容>`;
    }
    const jsonTemplate = detailJsonTemplate(m, f?.key || '');
    const vars = {
        ...shared,
        TITLE: studio.outline.title || studio.title || '未命名',
        NAME: m.name,
        AGE: castAgeText(m),
        OUTLINE: studioOutlineText(studio),
        MEMBER: memberText(m),
        OTHERS: othersText(studio, castId),
        STAGES: stagesText(studio),
        MODE_RULE: modeRule,
        INSTRUCTION_LINE: instructionLine(instruction),
        JSON_TEMPLATE: jsonTemplate,
    };
    const prompt = renderWith(settings, 'studioCharacter', vars, { ...blocks, MODE_RULE: modeRule.trim(), JSON_TEMPLATE: `# 输出 JSON 模板\n${jsonTemplate}` });
    return { system: renderWith(settings, 'studioCharacterSystem', vars), prompt };
}

/**
 * 解析角色细节的回复：整份（field 为空，至少要有性格 / 外貌 / 说话方式 / 背景中的一项）或只有一项（field）。
 * 也认外面包了一层 {"character": {...}} 的。立绘提示词去掉未成年的标签和名字、补上 adult。
 * @returns {object} 整份细节；field 时只有 {[field]: 值}
 * @throws 带 feedback 的错误：缺了要的内容
 */
export function parseStudioCharacter(json, { field = '', names = [] } = {}) {
    let src = isObj(json) ? json : {};
    const inner = pickKey(src, ['character', 'details', 'detail', '角色']);
    if (isObj(inner) && !pickKey(src, ['personality', 'appearance', 'speech', 'background', '性格', '外貌'])) src = inner;
    const d = normalizeDetails(src, { names });
    if (field) {
        const f = studioDetailField(field);
        if (!f) throw new Error(`不认识的字段：${field}`);
        const v = d[f.key];
        const empty = Array.isArray(v) ? !v.length : f.key === 'secret' ? !v.content : !String(v || '').trim();
        if (empty) throw feedbackError(`AI 没有返回「${f.label}」`, `上面的回复里没有 ${f.json}（${f.label}）。请按 JSON 模板重新输出，只输出 JSON。`);
        return { [f.key]: v };
    }
    if (!detailsFilled(d)) throw feedbackError('AI 没有返回角色细节', '上面的回复里没有角色细节（personality、appearance 等字段都是空的）。请按 JSON 模板重新输出完整的 JSON 对象，只输出 JSON。');
    return d;
}

/**
 * 把一次生成的结果写进草稿：整份时替换这个角色的细节（记下 generatedAt：整个展开过）；只重写一项时只改这一项，其余保持不变；
 * complete（补全）时用户已经写了的几项原样保留（秘密按小项保留），其余用 AI 的。
 * @returns {object} 这个角色现在的细节
 */
export function applyCharacterResult(studio, castId, result, { field = '', complete = false } = {}) {
    const now = Date.now();
    const f = field ? studioDetailField(field) : null;
    const base = studio.details[castId] || emptyDetails();
    if (f) {
        studio.details[castId] = { ...base, [f.key]: result[f.key], updatedAt: now };
    } else {
        const next = { ...emptyDetails(), ...result, updatedAt: now, generatedAt: now };
        if (complete) {
            for (const k of filledDetailKeys(base)) {
                next[k] = k === 'secret'
                    ? { content: base.secret.content || next.secret?.content || '', hints: base.secret.hints || next.secret?.hints || '', reveal: base.secret.reveal || next.secret?.reveal || '' }
                    : base[k];
            }
        }
        studio.details[castId] = next;
    }
    delete studio.errors[castId];
    touch(studio);
    return studio.details[castId];
}

/**
 * 生成（或重写）一个角色的细节；field 给了时只重写这一项；complete 时补全（用户写了的几项保留，见 buildCharacterPrompt）。
 * 失败时把原因记在 studio.errors[castId]（停止除外）再抛出。
 * @param {{field?: string, instruction?: string, complete?: boolean, signal?: AbortSignal, onLog?: Function}} opt
 * @returns {Promise<object>} 这个角色现在的细节
 */
export async function generateCharacter(project, settings, studio, castId, { field = '', instruction = '', complete = false, signal, onLog } = {}) {
    const m = studio.outline.cast.find((c) => c.id === castId);
    try {
        const fill = !field && complete && filledDetailKeys(studio.details?.[castId]).length > 0;
        const { system, prompt } = buildCharacterPrompt(project, settings, studio, castId, { field, instruction, complete: fill });
        const f = field ? studioDetailField(field) : null;
        onLog?.(f ? `🎲 正在重写「${m.name}」的${f.label}…` : fill ? `👤 正在补全「${m.name}」…` : `👤 正在展开「${m.name}」…`);
        const result = await askJson(project, settings, {
            system, prompt, signal, onLog, label: `「${m.name}」`, minTokens: f ? 3000 : 5000,
            parse: (json) => parseStudioCharacter(json, { field, names: [m.name, ...m.aliases] }),
        });
        if (signal?.aborted) throw abortError();
        // 生成期间角色被删掉了：结果不要了
        if (!studio.outline.cast.some((c) => c.id === castId)) throw new Error(`「${m.name}」已经不在大纲里了`);
        return applyCharacterResult(studio, castId, result, { field, complete: fill });
    } catch (e) {
        if (!isAbortError(e) && !signal?.aborted && studio.outline.cast.some((c) => c.id === castId) && !field) {
            studio.errors[castId] = errorText(e).slice(0, STUDIO_LIMITS.error);
        }
        throw e;
    }
}

/** 只重写一个角色的某一项（骰子）：其余各项不变 */
export function rerollCharacterField(project, settings, studio, castId, field, opt = {}) {
    if (!studioDetailField(field)) throw new Error(`不认识的字段：${field}`);
    return generateCharacter(project, settings, studio, castId, { ...opt, field });
}

/**
 * 依次处理一批（角色 / 阶段）：已经写好的跳过（overwrite 除外），一个失败记下原因接着下一个，停止时马上结束。
 * onProgress({phase, index, total, id, name, status: 'running'|'done'|'error'|'skipped'|'stopped', error?})
 */
async function runSequential(studio, items, { phase, overwrite, filled, run, signal, onProgress, onLog }) {
    const result = { done: [], failed: [], skipped: [], stopped: false };
    const total = items.length;
    for (let i = 0; i < total; i++) {
        const it = items[i];
        const base = { phase, index: i, total, id: it.id, name: it.name };
        if (signal?.aborted) {
            result.stopped = true;
            break;
        }
        if (!overwrite && filled(it)) {
            result.skipped.push(it.id);
            onProgress?.({ ...base, status: 'skipped' });
            continue;
        }
        onProgress?.({ ...base, status: 'running' });
        try {
            await run(it);
            result.done.push(it.id);
            onProgress?.({ ...base, status: 'done' });
        } catch (e) {
            if (isAbortError(e) || signal?.aborted) {
                result.stopped = true;
                onProgress?.({ ...base, status: 'stopped' });
                break;
            }
            const msg = errorText(e);
            studio.errors[it.id] = msg.slice(0, STUDIO_LIMITS.error);
            result.failed.push({ id: it.id, name: it.name, error: msg });
            onProgress?.({ ...base, status: 'error', error: msg });
            onLog?.(`「${it.name}」没生成出来：${msg}`, 'error');
        }
    }
    return result;
}

/**
 * 依次展开角色细节（大纲里的顺序；后面的角色能看到前面已经写好的，免得重样）。
 * 只填了一部分的角色（studioCastStatus 为 partial）补全：写了的几项保留；overwrite 时整个重写。
 * @param {{ids?: string[]|null, overwrite?: boolean, signal?: AbortSignal, onLog?: Function, onProgress?: Function}} opt
 *   ids：只处理这些角色（不给时全部）；overwrite：已经写好的也重写
 * @returns {Promise<{done: string[], failed: {id, name, error}[], skipped: string[], stopped: boolean}>}
 */
export async function generateCharacterDetails(project, settings, studio, { ids = null, overwrite = false, signal, onLog, onProgress } = {}) {
    const items = studio.outline.cast.filter((c) => c.name && (!ids || ids.includes(c.id))).map((c) => ({ id: c.id, name: c.name }));
    return runSequential(studio, items, {
        phase: 'character', overwrite, signal, onProgress, onLog,
        filled: (it) => studioCastStatus(studio, it.id) === 'done',
        run: (it) => generateCharacter(project, settings, studio, it.id, { signal, onLog, complete: !overwrite && studioCastStatus(studio, it.id) === 'partial' }),
    });
}

// ---------------- 开场白 ----------------

function stageBlock(s) {
    return [`名称：${s.name || '未命名'}`, s.time ? `时间：${s.time}` : '', s.summary ? `处境：${s.summary}` : '', s.conflict ? `核心冲突：${s.conflict}` : ''].filter(Boolean).join('\n');
}

/**
 * 开场白提示词（写这一阶段的开场白）：默认前面的阶段已经发生；叙述视角按用户画像的叙事偏好。
 * @param {{instruction?: string}} opt
 * @returns {{system: string, prompt: string}}
 */
export function buildOpenerPrompt(project, settings, studio, stageId, { instruction = '' } = {}) {
    const list = studio.outline.stages;
    const i = list.findIndex((s) => s.id === stageId);
    if (i < 0) throw new Error('这个阶段已经不在大纲里了');
    const s = list[i];
    const { vars: shared, blocks } = sharedVars(project, settings, studio);
    const style = studioProfile(settings, studio)?.style || '';
    // 怎么指代用户写在这里（模板里不写死）：第二人称时旁白用“你”，台词里照样叫 {{user}}
    const second = /第二人称|“你”/.test(style);
    const narrative = !style
        ? '旁白用第三人称叙述，提到用户时写 {{user}}；也可以用第二人称“你”指代 {{user}}，全篇统一。'
        : second
            ? `叙事偏好：${style}（按这个写）：旁白里用“你”指代 {{user}}，全篇统一（角色的台词里可以直接叫 {{user}}）；只写“你”看到、听到、身体感觉到的，不写“你”的想法和情绪。`
            : `叙事偏好：${style}（按这个写）；提到用户时写 {{user}}。`;
    const cur = String(studio.openers?.[stageId] || '').trim();
    const current = cur ? `\n\n# 当前的开场白（重写：写法要和它有实质区别）\n<当前内容>\n${cur}\n</当前内容>` : '';
    const vars = {
        ...shared,
        TITLE: studio.outline.title || studio.title || '未命名',
        STAGE_LABEL: studioStageLabel(studio, stageId),
        OUTLINE: studioOutlineText(studio),
        CAST: castBriefText(studio),
        PREVIOUS: i ? list.slice(0, i).map(stageText).join('\n') : '（没有：这是故事的开头）',
        STAGE: stageBlock(s),
        OPENER_LEN: studio.options.openerLen || '400-800 字',
        NARRATIVE: narrative,
        CONTINUITY: i
            ? '默认前面的阶段都已经发生：开头用一两句自然交代现在的局面（过了多久、发生过什么、大家处境如何），不要写成列表式的前情提要，也不要把前面的事重讲一遍。'
            : '这是故事的第一个阶段：没有前情，从故事的开头写起，几句话交代清楚大家为什么会在这里。',
        INSTRUCTION_LINE: instructionLine(instruction),
        CURRENT: current,
    };
    const prompt = renderWith(settings, 'studioOpener', vars, { ...blocks, CURRENT: current.trim() });
    return { system: renderWith(settings, 'studioOpenerSystem', vars), prompt };
}

/**
 * 解析开场白：去掉代码块、「开场白：」之类的前缀；整段被包成 JSON（{"opener": "…"}）时取出正文。
 * @returns {string}
 */
export function parseStudioOpener(text) {
    let s = String(text ?? '').replace(/\r\n?/g, '\n').trim();
    s = s.replace(/^```[a-z]*\n?/i, '').replace(/\n?```\s*$/, '').trim();
    if (/^\{[\s\S]*\}$/.test(s)) {
        try {
            const v = pickKey(extractJson(s), ['opener', 'first_mes', 'text', 'content', '开场白']);
            if (typeof v === 'string') s = v.trim();
        } catch { /* 不是 JSON：按正文处理 */ }
    }
    s = s.replace(/^(?:#+\s*)?(?:开场白|first_mes|opener)(?:\s*[:：]\s*|\s*\n)/i, '').trim();
    return s.slice(0, STUDIO_LIMITS.opener);
}

function parseOpenerOrRetry(raw) {
    const s = parseStudioOpener(raw);
    if (s.length < 20) throw feedbackError('AI 没有返回开场白', '上面的回复不是开场白正文（是空的或太短）。请直接输出开场白正文，不要标题、JSON 或代码块。');
    return s;
}

/**
 * 写（或重写）一个阶段的开场白，写回 studio.openers[stageId]。失败时把原因记在 studio.errors[stageId] 再抛出（停止除外）。
 * @returns {Promise<string>}
 */
export async function generateOpener(project, settings, studio, stageId, { instruction = '', signal, onLog } = {}) {
    const label = studioStageLabel(studio, stageId) || '这个阶段';
    try {
        const { system, prompt } = buildOpenerPrompt(project, settings, studio, stageId, { instruction });
        onLog?.(`🎬 正在写${label}的开场白…`);
        const text = await askProse(project, settings, { system, prompt, signal, onLog, label: `${label}的开场白`, minTokens: 4000, parse: parseOpenerOrRetry });
        if (signal?.aborted) throw abortError();
        if (!studio.outline.stages.some((s) => s.id === stageId)) throw new Error(`${label}已经不在大纲里了`);
        studio.openers[stageId] = text;
        delete studio.errors[stageId];
        touch(studio);
        return text;
    } catch (e) {
        if (!isAbortError(e) && !signal?.aborted && studio.outline.stages.some((s) => s.id === stageId)) studio.errors[stageId] = errorText(e).slice(0, STUDIO_LIMITS.error);
        throw e;
    }
}

/** 重写一个阶段的开场白（骰子）：同 generateOpener（当前的开场白作为参考，要求写法有实质区别） */
export const rerollOpener = generateOpener;

/**
 * 依次写各阶段的开场白（阶段的顺序）。参数和返回值同 generateCharacterDetails（phase 为 'opener'）。
 */
export async function generateOpeners(project, settings, studio, { ids = null, overwrite = false, signal, onLog, onProgress } = {}) {
    const items = studio.outline.stages.filter((s) => !ids || ids.includes(s.id)).map((s) => ({ id: s.id, name: studioStageLabel(studio, s.id) }));
    return runSequential(studio, items, {
        phase: 'opener', overwrite, signal, onProgress, onLog,
        filled: (it) => studioOpenerStatus(studio, it.id) === 'done',
        run: (it) => generateOpener(project, settings, studio, it.id, { signal, onLog }),
    });
}

// ---------------- 示例对话 ----------------

export function buildExamplePrompt(project, settings, studio, { instruction = '' } = {}) {
    const { vars: shared, blocks } = sharedVars(project, settings, studio);
    const cast = (studio.outline.cast || []).filter((c) => c.name).map((c) => {
        const d = studio.details?.[c.id];
        return [`- ${castLine(c)}`, d?.speech ? `  说话：${oneLine(d.speech, 200)}` : '', d?.sampleLines?.length ? `  示例台词：${d.sampleLines.slice(0, 3).map((l) => `「${l}」`).join(' ')}` : '']
            .filter(Boolean).join('\n');
    }).join('\n') || '（还没有角色）';
    const vars = {
        ...shared,
        TITLE: studio.outline.title || studio.title || '未命名',
        OUTLINE: studioOutlineText(studio, { withStages: true }),
        CAST: cast,
        INSTRUCTION_LINE: instructionLine(instruction),
    };
    const prompt = renderWith(settings, 'studioExample', vars, { USER_ROLE: blocks.USER_ROLE, USER_PROFILE: blocks.USER_PROFILE });
    return { system: renderWith(settings, 'studioExampleSystem', vars), prompt };
}

/** 解析示例对话：去掉代码块，从第一个 <START> 开始（没有时补一个），说话人规整成「{{char}}: 」「{{user}}: 」 */
export function parseStudioExample(text, { title = '' } = {}) {
    let s = String(text ?? '').replace(/\r\n?/g, '\n').trim();
    s = s.replace(/^```[a-z]*\n?/i, '').replace(/\n?```\s*$/, '').trim();
    const i = s.indexOf('<START>');
    if (i > 0) s = s.slice(i);
    else if (i < 0 && s) s = `<START>\n${s}`;
    return normalizeMesExample(s, { charName: title }).slice(0, STUDIO_LIMITS.example);
}

/** 写示例对话，写回 studio.example。 */
export async function generateExample(project, settings, studio, { instruction = '', signal, onLog } = {}) {
    try {
        const { system, prompt } = buildExamplePrompt(project, settings, studio, { instruction });
        onLog?.('💬 正在写示例对话…');
        const title = studio.outline.title || studio.title || '';
        const text = await askProse(project, settings, {
            system, prompt, signal, onLog, label: '示例对话', minTokens: 4000,
            parse: (raw) => {
                const s = parseStudioExample(raw, { title });
                if (!/\{\{char\}\}:/.test(s)) throw feedbackError('AI 没有返回示例对话', '上面的回复不是示例对话。请按要求输出 3 组以 <START> 开头、“{{user}}: ……”和“{{char}}: ……”交替的示例对话，只输出示例对话本身。');
                return s;
            },
        });
        if (signal?.aborted) throw abortError();
        studio.example = text;
        delete studio.errors.example;
        touch(studio);
        return text;
    } catch (e) {
        if (!isAbortError(e) && !signal?.aborted) studio.errors.example = errorText(e).slice(0, STUDIO_LIMITS.error);
        throw e;
    }
}

/**
 * 「全部生成」：先依次展开角色，再依次写各阶段的开场白，最后（选了示例对话时）写示例对话；已经写好的跳过（overwrite 除外）。
 * 停止时马上结束；一个角色 / 阶段失败不影响其余的。
 * @returns {Promise<{characters: object, openers: object, example: 'done'|'skipped'|'error'|'off'|null, stopped: boolean}>}
 *   characters / openers 同 generateCharacterDetails 的返回值；example 为 null 表示没轮到（前面停止了）
 */
export async function generateStudioContent(project, settings, studio, { overwrite = false, signal, onLog, onProgress } = {}) {
    const empty = { done: [], failed: [], skipped: [], stopped: false };
    const characters = await generateCharacterDetails(project, settings, studio, { overwrite, signal, onLog, onProgress });
    if (characters.stopped) return { characters, openers: empty, example: null, stopped: true };
    const openers = await generateOpeners(project, settings, studio, { overwrite, signal, onLog, onProgress });
    if (openers.stopped) return { characters, openers, example: null, stopped: true };
    let example = 'off';
    if (studio.options.examples) {
        if (!overwrite && String(studio.example || '').trim()) {
            example = 'skipped';
            onProgress?.({ phase: 'example', index: 0, total: 1, id: 'example', name: '示例对话', status: 'skipped' });
        } else {
            onProgress?.({ phase: 'example', index: 0, total: 1, id: 'example', name: '示例对话', status: 'running' });
            try {
                await generateExample(project, settings, studio, { signal, onLog });
                example = 'done';
                onProgress?.({ phase: 'example', index: 0, total: 1, id: 'example', name: '示例对话', status: 'done' });
            } catch (e) {
                if (isAbortError(e) || signal?.aborted) {
                    onProgress?.({ phase: 'example', index: 0, total: 1, id: 'example', name: '示例对话', status: 'stopped' });
                    return { characters, openers, example: null, stopped: true };
                }
                example = 'error';
                onProgress?.({ phase: 'example', index: 0, total: 1, id: 'example', name: '示例对话', status: 'error', error: errorText(e) });
                onLog?.(`示例对话没生成出来：${errorText(e)}`, 'error');
            }
        }
    }
    return { characters, openers, example, stopped: false };
}

// ---------------- 生成卡 ----------------

/** 草稿能不能做成卡：有问题时返回提示文字（没有大纲 / 没有一段开场白），可以时返回 '' */
export function studioCardProblem(studio) {
    if (!studioHasOutline(studio)) return '还没有大纲：先在第 2 步生成大纲';
    if (!studioProgress(studio).openersDone) return '还没有开场白：先在第 3 步至少写好一个阶段的开场白';
    return '';
}

function locationCategory(settings) {
    const cats = originalLoreCategories(settings);
    return cats.includes('地点') ? '地点' : cats[0] || '地点';
}

function lines(text) {
    return String(text ?? '').split('\n').map((l) => l.replace(/^[-*•\s]+/, '').trim()).filter(Boolean);
}

/** 写进世界书的角色条目正文：大纲里的定位 + 全部细节（立绘提示词除外）；秘密写明揭露条件满足前不说破 */
export function studioCharacterEntryText(m, d) {
    const name = m.name;
    const det = d || emptyDetails();
    const out = [
        `姓名: ${name}`,
        m.aliases?.length ? `别名: ${m.aliases.join('、')}` : '',
        m.gender ? `性别: ${m.gender}` : '',
        `年龄: ${castAgeText(m)}`,
        m.identity ? `身份: ${m.identity}` : '',
        m.oneLiner ? `定位: ${m.oneLiner}` : '',
        kv('外貌', det.appearance),
        kv('穿着', det.outfit),
        kv('性格', det.personality),
        kv('说话方式', det.speech),
        det.sampleLines?.length ? `示例台词:\n${det.sampleLines.map((l) => `  - 「${l}」`).join('\n')}` : '',
        kv('背景经历', det.background),
        kv('与 {{user}} 的关系', det.relationToUser),
    ];
    const levels = affectionOf(det);
    if (levels.length) {
        out.push(`好感变化（${name}对 {{user}} 的态度按现在好感所在的那一级来表现；好感随互动一级一级变化，不跳级）:\n${levels.map((a, i) => `  ${i + 1}. ${a.label || `第 ${i + 1} 级`}：${a.behavior}`).join('\n')}`);
    }
    if (det.secret?.content) {
        out.push([
            `秘密（只有旁白知道）: ${det.secret.content}`,
            det.secret.hints ? `  平时露出的线索: ${det.secret.hints.replace(/\n+/g, '；')}` : '',
            det.secret.reveal ? `  揭露条件: ${det.secret.reveal.replace(/\n+/g, '；')}` : '',
            `  ${det.secret.reveal ? '揭露条件满足之前' : '在剧情发展到合适的时机之前'}，${name}不会主动说出这个秘密，旁白也不直接点破，只通过线索暗示。`,
        ].filter(Boolean).join('\n'));
    }
    if (m.tags?.length) out.push(`标签: ${m.tags.join('、')}`);
    out.push(`${name}是成年人。`);
    return out.filter(Boolean).join('\n');
}

/** 写进世界书的地点条目正文：带上地点名（酒馆只把正文发给模型，几个地点同时触发时要分得清是哪里） */
export function studioLocationEntryText(l) {
    return [`地点: ${l.name}`, l.desc ? `说明: ${l.desc}` : ''].filter(Boolean).join('\n');
}

/** 写好了开场白的阶段（按阶段顺序）：第一段是卡的开场白，其余是备选开场白 */
export function studioGreetings(studio) {
    return (studio?.outline?.stages || [])
        .filter((s) => String(studio.openers?.[s.id] || '').trim())
        .map((s) => ({ stageId: s.id, label: studioStageLabel(studio, s.id), time: s.time, text: studio.openers[s.id].trim() }));
}

/** 「开场白 = 第 1 阶段「坠机」；备选开场白 1 = 第 3 阶段「获救」」 */
function greetingMapText(greetings) {
    return greetings.map((g, i) => `${i ? `备选开场白 ${i}` : '开场白'} = ${g.label}`).join('；');
}

/** 常驻的「故事阶段」条目正文：每个阶段的处境和核心冲突、各条开场白从哪个阶段开始 + 旁白推进的规则 */
export function studioStagesEntryText(studio) {
    const list = studio.outline.stages;
    const greetings = studioGreetings(studio);
    return [
        '【故事阶段】旁白按这个顺序推进故事；现在处在哪个阶段，看开场白和聊天的进展。',
        list.map((s, i) => [`${i + 1}. ${s.name || '未命名'}${s.time ? `（${s.time}）` : ''}`, s.summary ? `   处境：${s.summary.replace(/\n+/g, ' ')}` : '', s.conflict ? `   核心冲突：${s.conflict.replace(/\n+/g, ' ')}` : ''].filter(Boolean).join('\n')).join('\n'),
        greetings.length > 1 ? `开场白对应的阶段：${greetingMapText(greetings)}。聊天从哪一段开场白开始，故事就从那个阶段开始，之前的阶段都已经发生。` : '',
        '推进规则：',
        '- 当前阶段的核心冲突有了结果，或 {{user}} 的行动促成了转折时，再自然过渡到下一阶段；过渡时用旁白交代时间流逝和处境变化。',
        '- 不跳过阶段，不提前透露后面阶段的事件；阶段是故事的骨架，{{user}} 的选择可以改变事情怎么发生、结局如何。',
        '- 从后面的阶段开始时，各角色的好感从符合这一阶段关系的那一级起步（以开场白里的态度为准），之后再一级一级变化。',
    ].filter(Boolean).join('\n');
}

/** 卡的描述：故事、世界观、规则、基调、{{user}} 的位置、角色一览、阶段概览、旁白规则 */
export function studioDescription(studio) {
    const o = studio.outline;
    const cast = o.cast.filter((c) => c.name);
    const sec = (title, body) => (String(body || '').trim() ? `【${title}】\n${String(body).trim()}` : '');
    return [
        sec('故事', o.logline),
        sec('世界观', o.world.setting),
        sec('世界规则', o.world.rules),
        sec('基调', o.world.tone),
        sec('{{user}} 的位置', o.userRole),
        sec('主要角色（详细设定、好感变化和秘密在世界书里，提到名字时调出）', cast.map((c) => `- ${c.name}（${[castAgeText(c), c.identity].filter(Boolean).join('，')}）${c.oneLiner ? `：${c.oneLiner}` : ''}`).join('\n')),
        sec('故事阶段（详见世界书「故事阶段」）', o.stages.map((s, i) => `${i + 1}. ${s.name || '未命名'}${s.time ? `（${s.time}）` : ''}`).join('\n')),
        sec('旁白规则', [
            '- {{char}} 是旁白，同时扮演上面所有角色：用叙述交代场景和动作，每个角色的台词用 TA 自己的口吻、口癖和说话节奏，不混淆，不让所有人一个腔调。',
            '- 每个角色对 {{user}} 的态度按世界书里这个角色的「好感变化」现在所在的那一级来表现；好感随互动一级一级变化，不跳级，也不会无缘无故倒退。从后面阶段的开场白开始时，好感从符合那个阶段关系的那一级起步（以开场白里的态度为准）。',
            '- 每个角色的秘密只在「揭露条件」满足时才会说出或被揭穿；之前只通过线索暗示，旁白不直接点破。',
            '- 故事按「故事阶段」推进，不跳过阶段，不提前剧透；{{user}} 的选择可以改变事情的走向。',
            '- 不替 {{user}} 说话、行动或做决定，不描写 {{user}} 的心理活动；把选择留给 {{user}}。',
            '- 所有角色都是成年人。',
        ].join('\n')),
    ].filter(Boolean).join('\n\n');
}

/**
 * 卡的场景（scenario，酒馆每次都会带上）：写成默认的起点，而不是固定的「现在」——
 * 从备选开场白（后面的阶段）开始聊天时，以那段开场白所在的阶段为准。
 */
function studioScenario(studio, greetings) {
    const first = studio.outline.stages.find((s) => s.id === greetings[0]?.stageId);
    if (!first) return '';
    return [
        `故事默认从${greetings[0].label}${first.time ? `（${first.time}）` : ''}开始${first.summary ? `：${first.summary}` : '。'}`,
        first.conflict ? `核心冲突：${first.conflict}` : '',
        greetings.length > 1 ? '如果聊天从备选开场白开始，当前处在那段开场白所在的阶段（见世界书「故事阶段」），之前的阶段都已经发生；以开场白为准，之后随剧情推进。' : '',
    ].filter(Boolean).join('\n');
}

/** 卡上的原创设定（card.original）：世界观文字 + 角色（项目的角色资料形状）+ 地点条目；存进项目后记下 savedAs */
function studioOriginal(settings, studio) {
    const o = studio.outline;
    const world = [
        o.logline ? `一句话故事：${o.logline}` : '',
        o.world.setting ? `世界观：\n${o.world.setting}` : '',
        o.world.rules ? `世界规则：\n${o.world.rules}` : '',
        o.world.tone ? `基调：${o.world.tone}` : '',
        o.userRole ? `{{user}} 的位置：\n${o.userRole}` : '',
        o.stages.length ? `故事阶段：\n${o.stages.map((s, i) => `${i + 1}. ${s.name}${s.time ? `（${s.time}）` : ''}：${oneLine(s.summary, 120)}`).join('\n')}` : '',
    ].filter(Boolean).join('\n');
    const characters = o.cast.filter((c) => c.name).map((m) => {
        const d = studio.details?.[m.id] || emptyDetails();
        return {
            name: m.name, aliases: m.aliases, gender: m.gender, age: castAgeText(m), identity: m.identity,
            personality: d.personality || m.oneLiner, relationship: d.relationToUser,
            appearance: [...lines(d.appearance), ...lines(d.outfit).map((l) => `穿着：${l}`)],
            verbalTics: lines(d.speech), experiences: lines(d.background), importance: 'main',
        };
    });
    const category = locationCategory(settings);
    const lore = o.world.locations.filter((l) => l.name).map((l) => ({ category, name: l.name, keywords: [l.name], content: studioLocationEntryText(l) }));
    return normalizeCardOriginal({ name: '', concept: '', world, ref: '', cast: '', characters, lore, saved: false });
}

/** 卡上记的本卡世界书条目（card.studio.entries）：故事阶段、每个角色、每个地点（写入时的激活方式见 studio-base.js 的 studioOwnEntries） */
export function studioEntries(settings, studio) {
    const o = studio.outline;
    const out = [];
    if (o.stages.length) out.push({ kind: 'stages', category: '剧情', name: '故事阶段', keywords: [], content: studioStagesEntryText(studio) });
    for (const m of o.cast.filter((c) => c.name)) {
        out.push({ kind: 'character', category: '角色', name: m.name, keywords: uniq([m.name, ...m.aliases]), content: studioCharacterEntryText(m, studio.details?.[m.id]) });
    }
    const category = locationCategory(settings);
    for (const l of o.world.locations.filter((x) => x.name)) out.push({ kind: 'location', category, name: l.name, keywords: [l.name], content: studioLocationEntryText(l) });
    return out;
}

/**
 * 按草稿算出卡里由构思决定的内容（不调用 AI、不改项目）：卡片字段、本卡条目、开场白对应的阶段、导向 / 画像 / {{user}} 的身份快照。
 * @throws 草稿还不能做成卡时（见 studioCardProblem）
 */
function studioCardParts(project, settings, studio) {
    const problem = studioCardProblem(studio);
    if (problem) throw new Error(problem);
    const o = studio.outline;
    const name = o.title || studio.title || '群像故事';
    const greetings = studioGreetings(studio);
    const orient = studioOrientation(settings, studio);
    const orientation = orient ? normalizeCardOrientation({ ...orient, notes: o.orientationNotes || '' }) : null;
    const profile = normalizeCardUserProfile(studioProfile(settings, studio));
    const cast = o.cast.filter((c) => c.name);
    const notes = [
        `NovelLoom 创意工坊做的群像世界卡${o.logline ? `：${o.logline}` : '。'}`,
        `{{char}} 是旁白，扮演全部 ${cast.length} 个角色（${cast.map((c) => c.name).join('、')}）；角色的详细设定在卡自带的世界书里。`,
        '开场白对应的故事阶段：',
        ...greetings.map((g, i) => `- ${i ? `备选开场白 ${i}` : '开场白'}：${g.label}${g.time ? `（${g.time}）` : ''}`),
    ].join('\n');
    const data = {
        name,
        description: studioDescription(studio),
        personality: oneLine(o.world.tone || o.logline, 200),
        scenario: studioScenario(studio, greetings),
        first_mes: greetings[0].text,
        alternate_greetings: greetings.slice(1).map((g) => g.text),
        mes_example: studio.options.examples && String(studio.example || '').trim() ? normalizeMesExample(studio.example, { charName: name }) : '',
        creator_notes: notes,
        tags: uniq(['群像', '原创', orientation?.name]).slice(0, 6),
    };
    return {
        name, data, greetings, cast, orientation, profile,
        userRole: studioUserRole(studio),
        requirement: studio.options.extra || '',
        entries: studioEntries(settings, studio),
    };
}

/** 卡里由构思决定的内容的指纹（判断「草稿改过、卡还没更新」用） */
function partsKey(parts) {
    return hashString(JSON.stringify([parts.data, parts.entries, parts.orientation, parts.profile, parts.userRole, parts.requirement]));
}

/** 按现在的草稿做成卡时的内容指纹；草稿还不能做成卡时为 '' */
export function studioCardContentKey(project, settings, studio) {
    try {
        return partsKey(studioCardParts(project, settings, studio));
    } catch {
        return '';
    }
}

/**
 * 按草稿组装一张世界/旁白卡（不调用 AI、不改项目）：卡名 = 大纲标题；开场白 = 第一个写好的阶段，备选开场白 = 之后的阶段（按顺序）。
 * 传入 card（以前生成的那张）时沿用它的 id、头像、写入酒馆的绑定、状态栏、系统提示词和历史后指令；id 给了时新卡用这个 id。
 * card.studio.contentKey 记下这次的内容指纹（studioCardStale 用它判断草稿改过之后卡还没更新）。
 * @returns {object} 卡片记录（source = 'studio'，studioId；card.original 是原创设定，card.studio 记本卡条目和各条开场白对应的阶段）
 * @throws 草稿还不能做成卡时（见 studioCardProblem）
 */
export function assembleStudioCard(project, settings, studio, { card: prev = null, id = '' } = {}) {
    const parts = studioCardParts(project, settings, studio);
    const data = {
        ...parts.data,
        system_prompt: prev?.data?.system_prompt || '',
        post_history_instructions: prev?.data?.post_history_instructions || '',
    };
    const now = Date.now();
    const card = {
        id: prev?.id || id || uid('card_'),
        charName: '',
        kind: 'world',
        cardName: parts.name,
        source: STUDIO_SOURCE,
        studioId: studio.id,
        timepoint: null,
        requirement: parts.requirement,
        userRole: parts.userRole,
        orientation: parts.orientation,
        userProfile: parts.profile,
        createdAt: prev?.createdAt || now,
        updatedAt: now,
        data,
        lint: settings?.cards?.lintAfterGenerate ? lintCardFor(project, settings, data) : [],
        stAvatar: prev?.stAvatar || '',
        worldName: prev?.worldName || '',
        original: studioOriginal(settings, studio),
        studio: {
            entries: parts.entries,
            greetings: parts.greetings.map(({ stageId, label }) => ({ stageId, label })),
            cast: parts.cast.map((c) => ({ id: c.id, name: c.name })),
            keys: isObj(prev?.studio?.keys) ? { ...prev.studio.keys } : {},
            builtAt: now,
            contentKey: partsKey(parts),
        },
    };
    for (const k of ['avatarDataUrl', 'ownWorldName', 'statusBar', 'publishedAt']) if (prev?.[k] !== undefined) card[k] = prev[k];
    return card;
}

/**
 * 草稿改过、做好的卡还没更新：按现在的草稿组装出来的内容和卡上记的指纹不一样（在角色卡页直接改卡不算）。
 * 没有卡、草稿还不能做成卡、或者卡上没有指纹（旧版本做的）时为 false。
 */
export function studioCardStale(project, settings, studio) {
    const key = studioExistingCard(project, studio)?.studio?.contentKey;
    if (!key) return false;
    const now = studioCardContentKey(project, settings, studio);
    return !!now && now !== key;
}

/** 这份构思已经生成过的卡（还在项目里、确实是这份构思的）；没有时为 null */
export function studioExistingCard(project, studio) {
    if (!studio?.cardId) return null;
    return (project?.cards || []).find((c) => c?.id === studio.cardId && c.source === STUDIO_SOURCE && c.studioId === studio.id) || null;
}

/**
 * 生成卡前的检查：哪些角色 / 地点和项目里别人的资料撞名了（这份构思以前存进来的不算；以前已经加后缀另存的继续用那个名字，不算）。
 * via：'name' 同名（可以选覆盖）；'alias' / 'keyword' 只是别名 / 关键词相同（总是加后缀另存）。
 * @returns {{collisions: {type: 'character'|'entry', name: string, category?: string, via: string, owner: string}[], canOverwrite: boolean}}
 */
export function studioSavePlan(project, settings, studio) {
    const prev = studioExistingCard(project, studio);
    const cardId = prev?.id || '';
    const prevO = normalizeCardOriginal(prev?.original);
    const kept = (name, savedAs) => !!savedAs && savedAs !== name;
    const collisions = [];
    for (const m of studio.outline.cast.filter((c) => c.name)) {
        if (kept(m.name, prevO?.characters.find((d) => d.name === m.name)?.savedAs)) continue;
        const c = characterClash(project, m.name, { cardId });
        if (c) collisions.push({ type: 'character', name: m.name, via: c.via, owner: c.owner });
    }
    const category = locationCategory(settings);
    for (const l of studio.outline.world.locations.filter((x) => x.name)) {
        if (kept(l.name, prevO?.lore.find((e) => e.category === category && e.name === l.name)?.savedAs)) continue;
        const c = entryClash(project, category, l.name, { cardId });
        if (c) collisions.push({ type: 'entry', name: l.name, category, via: c.via, owner: c.owner, ownerCategory: c.category });
    }
    return { collisions, canOverwrite: collisions.some((c) => c.via === 'name') };
}

/**
 * 把卡上的角色和地点存进项目（原创写卡的存法：角色存成手动角色、地点存成手动条目，记着是这张卡存的）。可以反复存（「更新卡片」）：
 *  - 这张卡以前存过的（按角色 id / 名字对上）就地更新；角色改了名字时项目里的那份跟着改名（关系图谱等一起改）；
 *    以前同名另存（「林晚（原创）」）的继续用那个名字；用户在「角色」「世界书」页改过的条目设置、备注保留；
 *  - 和项目里别人的资料撞名时：同名且选了 overwrite 时替换，否则加后缀另存（卡里的名字留作别名 / 关键词）；
 *  - 这张卡以前存的、现在不在卡上的角色和条目删掉（别的卡还在用的角色不删）。
 * 会改 card.original（saved = true、各项的 savedAs）和 card.studio.keys（角色 id → 项目里的名字）。
 * @param {{collision?: 'suffix'|'overwrite', previous?: object|null}} opt previous：以前生成的那张卡（对上以前存的名字）
 * @returns {{characters: object[], lore: object[], removed: {characters: string[], lore: {category: string, name: string}[]}}}
 */
export function saveStudioDesign(project, card, { collision = 'suffix', previous = null } = {}) {
    const o = normalizeCardOriginal(card?.original);
    if (!o) throw new Error('这张卡没有可以存进项目的设定');
    if (!project.characters || typeof project.characters !== 'object') project.characters = {};
    if (!project.worldbook || typeof project.worldbook !== 'object') project.worldbook = {};
    const own = (x) => !!x && !!card.id && x.originalCardId === card.id;
    const prevO = normalizeCardOriginal(previous?.original);
    const prevKeys = isObj(previous?.studio?.keys) ? previous.studio.keys : isObj(card.studio?.keys) ? card.studio.keys : {};
    const prevByName = new Map((prevO?.characters || []).filter((d) => d.savedAs).map((d) => [d.name, d.savedAs]));
    const castIdOf = new Map((card.studio?.cast || []).map((c) => [c.name, c.id]));
    const result = { characters: [], lore: [], removed: { characters: [], lore: [] } };
    const keep = new Set();
    const keys = {};
    for (const d of o.characters) {
        const castId = castIdOf.get(d.name) || '';
        // 以前存的那份：先按角色 id 找，找不到（比如在「角色」页改过名、id 记的还是旧名字）再按卡上记的 savedAs 找
        const prevKey = [castId && prevKeys[castId], prevByName.get(d.name)].find((k) => k && own(project.characters[k]) && !keep.has(k)) || '';
        const clash = characterClash(project, d.name, { cardId: card.id });
        const overwrite = clash?.via === 'name' && collision === 'overwrite';
        let key;
        if (!clash || overwrite) key = d.name;
        else if (prevKey && project.characters[prevKey]?.originalShadow === d.name) key = prevKey;
        else key = suffixedName(d.name, (n) => !!project.characters[n] && n !== prevKey);
        if (keep.has(key)) key = suffixedName(d.name, (n) => !!project.characters[n] || keep.has(n));
        const old = prevKey ? project.characters[prevKey] : own(project.characters[key]) ? project.characters[key] : null;
        if (prevKey && prevKey !== key) {
            // 改了名字：把以前存的那份改名（关系图谱、群聊卡、视角跟着改）；新名字被别人的同名角色占着（选了覆盖）时直接换掉
            if (!project.characters[key]) renameCharacter(project, prevKey, key);
            else delete project.characters[prevKey];
        }
        const ch = designToCharacter(d, key);
        const ownedByOther = (a) => Object.entries(project.characters).some(([k, c]) => k !== key && (k === a || (isSpecificAlias(a) && (c?.aliases || []).includes(a))));
        ch.aliases = uniq([key !== d.name ? d.name : null, ...ch.aliases.filter((a) => a !== key && !ownedByOther(a))]);
        if (key !== d.name) ch.originalShadow = d.name;
        ch.originalCardId = card.id;
        for (const f of ['entryConfig', 'notes', 'nsfwNotes']) if (old?.[f] && (typeof old[f] !== 'object' || Object.keys(old[f]).length)) ch[f] = old[f];
        project.characters[key] = ch;
        keep.add(key);
        d.savedAs = key;
        if (castId) keys[castId] = key;
        result.characters.push({ name: d.name, savedAs: key, overwritten: overwrite, via: clash?.via || '', owner: clash?.owner || '' });
    }
    // 以前存的、现在不在卡上的角色：删掉（别的卡还在用的留着）
    for (const [k, c] of Object.entries(project.characters)) {
        if (!own(c) || keep.has(k)) continue;
        const used = (project.cards || []).some((x) => x && x.id !== card.id && (x.charName === k || x.userRole?.charKey === k));
        if (used) continue;
        delete project.characters[k];
        result.removed.characters.push(k);
    }
    if (result.removed.characters.length) {
        pruneRelationships(project);
        pruneGroupCards(project);
        prunePov(project);
    }
    const now = Date.now();
    const keepLore = new Set();
    const prevLore = new Map((prevO?.lore || []).filter((e) => e.savedAs).map((e) => [`${e.category}\u0001${e.name}`, e.savedAs]));
    for (const e of o.lore) {
        const cat = (project.worldbook[e.category] = project.worldbook[e.category] || {});
        let prevKey = prevLore.get(`${e.category}\u0001${e.name}`) || '';
        if (prevKey && !own(cat[prevKey])) prevKey = '';
        const clash = entryClash(project, e.category, e.name, { cardId: card.id });
        const overwrite = clash?.via === 'name' && collision === 'overwrite';
        let key;
        if (!clash || overwrite) key = e.name;
        else if (prevKey && cat[prevKey]?.originalShadow === e.name) key = prevKey;
        else key = suffixedName(e.name, (n) => !!cat[n] && n !== prevKey);
        const old = own(cat[key]) ? cat[key] : prevKey ? cat[prevKey] : null;
        if (prevKey && prevKey !== key) delete cat[prevKey];
        cat[key] = {
            name: key, keywords: uniq([key, e.name, ...e.keywords]), content: e.content,
            sourceChunks: [], revisions: [], config: isObj(old?.config) ? old.config : {}, locked: true, manual: true, updatedAt: now,
            originalCardId: card.id,
            ...(key !== e.name ? { originalShadow: e.name } : {}),
        };
        keepLore.add(`${e.category}\u0001${key}`);
        e.savedAs = key;
        result.lore.push({ category: e.category, name: e.name, savedAs: key, overwritten: overwrite, via: clash?.via || '', owner: clash?.owner || '' });
    }
    for (const [catName, list] of Object.entries(project.worldbook)) {
        for (const [k, x] of Object.entries(list || {})) {
            if (!own(x) || keepLore.has(`${catName}\u0001${k}`)) continue;
            delete list[k];
            result.removed.lore.push({ category: catName, name: k });
        }
    }
    o.saved = true;
    card.original = o;
    if (!isObj(card.studio)) card.studio = {};
    card.studio.keys = keys;
    return result;
}

/**
 * 更新卡片时让状态栏里按角色名记的记录（「主要角色」等，见 statusbar.js 的 castRecords）跟上阵容的变化：
 * 大纲里改了名字的角色（按角色 id 对上）把初始条目挪到新名字下（新名字已经有条目时去掉旧的），删掉的角色的条目去掉；
 * 不是上一张卡阵容里的名字（用户自己加的条目）不动。有变化时状态栏标记为「可能过时」并在 warnings 里记一句。
 * 不修改上一张卡的状态栏（换成新的对象）。
 */
function syncStatusBarCast(card, prev, warnings) {
    const sb = card.statusBar;
    if (!prev || !sb?.spec?.variables?.length) return;
    const newById = new Map((card.studio?.cast || []).map((c) => [c.id, c.name]));
    const prevKeys = isObj(prev.studio?.keys) ? prev.studio.keys : {};
    const renames = new Map();
    const removed = new Set();
    for (const c of prev.studio?.cast || []) {
        if (!c?.id || !c.name) continue;
        const now = newById.get(c.id);
        if (now === c.name) continue;
        if (now) renames.set(c.name, now);
        else {
            removed.add(c.name);
            if (prevKeys[c.id] && ![...newById.values()].includes(prevKeys[c.id])) removed.add(prevKeys[c.id]);
        }
    }
    if (!renames.size && !removed.size) return;
    const spec = cloneJson(sb.spec);
    const paths = new Set(castRecords(spec).map((v) => v.path));
    const did = { renamed: new Set(), removed: new Set() };
    for (const v of spec.variables || []) {
        if (!paths.has(v.path) || !isObj(v.init)) continue;
        const next = [];
        for (const [k, val] of Object.entries(v.init)) {
            const to = renames.get(k);
            if (to) {
                did.renamed.add(`${k} → ${to}`);
                const taken = Object.prototype.hasOwnProperty.call(v.init, to) && !renames.has(to) && !removed.has(to);
                if (!taken && !next.some(([x]) => x === to)) next.push([to, val]);
                continue;
            }
            if (removed.has(k)) {
                did.removed.add(k);
                continue;
            }
            next.push([k, val]);
        }
        v.init = Object.fromEntries(next);
    }
    card.statusBar = { ...sb, spec, stale: true };
    const parts = [did.renamed.size ? [...did.renamed].join('、') : '', did.removed.size ? `已删掉 ${[...did.removed].join('、')}` : ''].filter(Boolean);
    warnings.push(parts.length
        ? `角色阵容变了，状态栏里按角色记的初始条目已跟着改：${parts.join('；')}（其他变量的初始值和规则可能也要在「状态栏」里更新）`
        : '角色阵容变了：状态栏的初始值和规则可能要在「状态栏」里更新');
}

/**
 * 生成卡 / 更新卡片：按草稿组装卡（assembleStudioCard），把角色和地点存进项目（saveStudioDesign），
 * 新卡放进 project.cards，更新时原位替换同一张卡（id、头像、写入酒馆的绑定、状态栏都沿用）。
 * 状态栏已经有变量时，大纲里新加的角色补进「主要角色」记录。之后 studio.cardId 指向这张卡、步骤到 4。
 * @param {{collision?: 'suffix'|'overwrite'}} opt 和项目里别人的资料同名时：加后缀另存（默认）或覆盖，见 studioSavePlan
 * @returns {{card: object, created: boolean, saved: object, warnings: string[]}}
 */
export function buildStudioCard(project, settings, studio, { collision = 'suffix' } = {}) {
    if (!Array.isArray(project.cards)) project.cards = [];
    const prev = studioExistingCard(project, studio);
    // 以前生成的卡被删掉了（或回退快照时没了）：新卡沿用原来的 id，以前存进项目的角色和条目仍算这张卡的，不会被当成撞名另存一份
    const reuse = !prev && studio.cardId && !project.cards.some((c) => c?.id === studio.cardId) ? studio.cardId : '';
    const card = assembleStudioCard(project, settings, studio, { card: prev, id: reuse });
    const saved = saveStudioDesign(project, card, { collision, previous: prev });
    const warnings = [];
    if (prev) project.cards[project.cards.indexOf(prev)] = card;
    else project.cards.push(card);
    if (card.statusBar?.spec?.variables?.length) {
        syncStatusBarCast(card, prev, warnings);
        const r = seedWorldCastEntries(project, card, card.statusBar.spec, { warnings });
        card.statusBar.spec = r.spec;
        if (r.added.length) warnings.push(`已把新加的角色补进状态栏的「${r.path}」：${r.added.join('、')}`);
    }
    studio.cardId = card.id;
    studio.step = 4;
    touch(studio);
    return { card, created: !prev, saved, warnings };
}

/** 生成状态栏时套用的模板 id：设置里选的（默认「多人群像」），模板不存在或设成 '' 时为 ''（让 AI 按群像设计） */
export function studioStatusBarTemplateId(settings) {
    const id = settings?.studio?.statusBarTemplateId ?? STUDIO_STATUSBAR_TEMPLATE;
    if (!id) return '';
    try {
        return getStatusBarTemplate(settings, id) ? id : '';
    } catch {
        return '';
    }
}

/**
 * 给创意工坊的卡生成状态栏（与写卡流程里的世界卡一样）：模板有变量表时「沿用结构」，项目里存着的主要角色预先填进「主要角色」记录，
 * AI 只按这张卡填初始值和更新规则；没有模板时让 AI 按群像设计变量表（和界面）。失败时抛出（状态栏的 error 里也记着），卡片不受影响。
 * 界面里也可以直接用 ui/statusbar-dialog.js 的 generateStatusBarForCard(card, ctx, {templateId: studioStatusBarTemplateId(settings)})。
 * @param {{templateId?: string, requirement?: string, signal?: AbortSignal, onLog?: Function, warnings?: string[]}} opt
 * @returns {Promise<{statusBar: object, warnings: string[]}>}
 */
export async function generateStudioStatusBar(project, settings, card, { templateId = studioStatusBarTemplateId(settings), requirement = '', signal, onLog, warnings = [] } = {}) {
    const sb = ensureStatusBar(card, settings);
    sb.enabled = true;
    if (requirement) sb.requirement = String(requirement).trim();
    let tpl = null;
    try {
        tpl = templateId ? getStatusBarTemplate(settings, templateId) : null;
    } catch {
        tpl = null;
    }
    if (tpl?.spec?.variables?.length) {
        const res = applyStatusBarTemplate(card, tpl, 'structure', { settings, project });
        warnings.push(...(res.warnings || []));
        // 一步撤销回到套用模板之前（与状态栏对话框里套用模板一致）
        const undo = card.statusBar.prev;
        try {
            if (res.ai) await generateStatusBar(project, settings, card, { ...res.ai, template: tpl, signal, onLog, warnings });
        } finally {
            card.statusBar.prev = undo;
        }
    } else {
        await generateStatusBar(project, settings, card, { parts: sb.mode === 'bind' ? ['spec', 'html'] : ['spec'], signal, onLog, warnings });
    }
    return { statusBar: card.statusBar, warnings };
}

/**
 * 第 4 步「生成卡」的摘要：卡里会有什么、还缺什么。
 * @returns {{problem: string, title: string, cast: number, missingDetails: string[], stages: number, greetings: number, missingOpeners: string[],
 *   entries: {characters: number, locations: number, stages: number, total: number}, extras: string[], statusBar: boolean, examples: boolean,
 *   examplesWanted: boolean, orientation: string, profile: string, userRole: string, card: object|null, stale: boolean}}
 *   missingDetails：还没展开完的角色（没展开或只填了一部分）；extras：写入酒馆时另加的常驻条目（导向、用户偏好、{{user}} 的身份）
 */
export function studioCardSummary(project, settings, studio) {
    const o = studio.outline;
    const cast = o.cast.filter((c) => c.name);
    const prog = studioProgress(studio);
    const entries = {
        characters: cast.length,
        locations: o.world.locations.filter((l) => l.name).length,
        stages: o.stages.length ? 1 : 0,
    };
    entries.total = entries.characters + entries.locations + entries.stages;
    const orient = studioOrientation(settings, studio);
    const profile = studioProfile(settings, studio);
    const role = studioUserRole(studio);
    // 写入酒馆时卡自己的世界书里另加的常驻条目（publish.js 的 cardExtraEntries）
    const extras = [orient ? `剧情导向「${orient.name}」` : '', profile?.chatEntry ? `用户偏好「${profile.name}」` : '', role.kind === 'custom' ? '{{user}} 的身份' : ''].filter(Boolean);
    return {
        problem: studioCardProblem(studio),
        title: o.title || studio.title || '',
        cast: cast.length,
        missingDetails: cast.filter((c) => studioCastStatus(studio, c.id) !== 'done').map((c) => c.name),
        stages: o.stages.length,
        greetings: prog.openersDone,
        missingOpeners: o.stages.filter((s) => studioOpenerStatus(studio, s.id) !== 'done').map((s) => studioStageLabel(studio, s.id)),
        entries,
        extras,
        statusBar: !!studio.options.statusBar,
        examples: !!studio.options.examples && prog.example,
        examplesWanted: !!studio.options.examples,
        orientation: orient?.name || '',
        profile: profile?.name || '',
        userRole: userRoleLabel(project, role, { original: true }),
        card: studioExistingCard(project, studio),
        stale: studioCardStale(project, settings, studio),
    };
}
