// 「{{user}} 扮演」：写卡时选 {{user}} 是谁——原创新身份（默认）/ 原著里的某个角色 / 自定义一段身份说明。
// 存在卡片上 card.userRole = {kind: 'new'|'character'|'custom', charKey, text}（charKey 是项目里的角色名）。
// 用在：写卡提示词的 {USER_ROLE}、状态栏变量表提示词的 {USER_ROLE}（主角.* 变量按这个身份设计）、
// 卡片自己的世界书里的常驻条目「{{user}} 的身份」（kind 为 character / custom 时，见 publish.js 的 cardExtraEntries），
// 以及写卡结果里示例对话说话人的规整（这个角色的名字 → {{user}}）。不碰 DOM、不调用 AI。

import { normalizeCardOrientation } from './orientation.js';
import { characterAt, characterProfileText } from './project.js';
import { truncate } from './utils.js';

export const USER_ROLE_KINDS = [
    { value: 'new', label: '原创新身份（默认）' },
    { value: 'character', label: '原著角色' },
    { value: 'custom', label: '自定义' },
];

export const USER_ROLE_TEXT_MAX = 1000;
/** 提示词与世界书条目里附带的原著角色资料的最大字数 */
export const USER_ROLE_PROFILE_MAX = 600;
/** 世界书条目的标题（备注） */
export const USER_ROLE_ENTRY_TITLE = '{{user}} 的身份';

function isObj(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * 规整 {{user}} 的身份；不认识的 kind、选了原著角色却没有角色、自定义却没写内容时都回到 'new'。
 * @param {object} raw
 * @param {{exclude?: string}} opt exclude：单人卡自己的角色名（{{user}} 不能扮演 {{char}} 本人）
 * @returns {{kind: 'new'|'character'|'custom', charKey: string, text: string}}
 */
export function normalizeUserRole(raw, { exclude = '' } = {}) {
    const r = isObj(raw) ? raw : {};
    const kind = USER_ROLE_KINDS.some((k) => k.value === r.kind) ? r.kind : 'new';
    const charKey = String(r.charKey ?? '').trim();
    const text = String(r.text ?? '').replace(/\r\n?/g, '\n').trim().slice(0, USER_ROLE_TEXT_MAX);
    if (kind === 'character' && charKey && charKey !== exclude) return { kind, charKey, text: '' };
    if (kind === 'custom' && text) return { kind, charKey: '', text };
    return { kind: 'new', charKey: '', text: '' };
}

/** 需要在卡片世界书里写「{{user}} 的身份」条目吗（原著角色 / 自定义） */
export function userRoleHasEntry(role) {
    const r = normalizeUserRole(role);
    return r.kind !== 'new';
}

/** {{user}} 扮演的原著角色名（kind 不是 character 时为 ''） */
export function userRoleCharName(project, role) {
    const r = normalizeUserRole(role);
    if (r.kind !== 'character') return '';
    return project?.characters?.[r.charKey]?.name || r.charKey;
}

/** 这个原著角色到时间点为止的简要资料（不超过 600 字）；项目里已经没有这个角色时为 '' */
export function userRoleProfile(project, role, upto = Infinity) {
    const r = normalizeUserRole(role);
    if (r.kind !== 'character') return '';
    const ch = project?.characters?.[r.charKey];
    if (!ch) return '';
    try {
        const view = characterAt(ch, Number.isFinite(upto) ? upto : Infinity);
        return truncate(characterProfileText(view, { maxExperiences: 4, maxQuotes: 2, withDialogues: false, withNsfw: false }), USER_ROLE_PROFILE_MAX);
    } catch {
        return '';
    }
}

/** 一句话说明（表单、编辑框里显示） */
export function userRoleLabel(project, role) {
    const r = normalizeUserRole(role);
    if (r.kind === 'character') return `原著角色「${userRoleCharName(project, r)}」`;
    if (r.kind === 'custom') return `自定义：${truncate(r.text, 40)}`;
    return '原创新身份';
}

/** 「用户要求」里另写了 {{user}} 的身份时，以「{{user}} 的身份」一节为准 */
const USER_ROLE_WINS = '- 「用户要求」里关于 {{user}} 身份的说法与这里冲突时，以这里为准。';

/**
 * 写卡提示词里的「{{user}} 的身份」一节（含标题，前后不带空行）；原创新身份时为 ''
 * （不加这一节：用户可能在「用户要求」里另写了 {{user}} 是谁，再说“不是原著中的任何角色”就自相矛盾了；
 * 什么都没写时「用户要求」的默认文字会说明 {{user}} 以新身份出现，见 cards.js 的 buildCardPrompt）。
 * @param {object} project
 * @param {object} role card.userRole
 * @param {{upto?: number, world?: boolean, orientation?: boolean}} opt
 *   world：世界/旁白卡（{{char}} 是旁白：原著里各角色与这个人的关系就是他们与 {{user}} 的关系；主要角色一览里不再单独列出这个人）；
 *   orientation：同时选了卡的导向（两人现在的关系以导向为准，原著关系只作底子）
 */
export function userRolePromptBlock(project, role, { upto = Infinity, world = false, orientation = false } = {}) {
    const r = normalizeUserRole(role);
    if (r.kind === 'character') {
        const name = userRoleCharName(project, r);
        const profile = userRoleProfile(project, r, upto);
        let relation;
        if (world) {
            relation = orientation
                ? `- 原著中其他角色与「${name}」之间的关系是他们与 {{user}} 关系的底子；「卡的导向」对人物关系的设定优先：保留「${name}」的身份和经历，按导向调整现在的关系。`
                : `- 原著中其他角色与「${name}」之间的关系，就是他们与 {{user}} 的关系；场景和开场白从这些关系出发。`;
        } else {
            relation = orientation
                ? `- 原著中 {{char}} 与「${name}」之间的关系是两人关系的底子；「卡的导向」对两人现在关系的设定优先：保留「${name}」的身份和经历，按导向调整两人现在的关系。`
                : `- 原著中 {{char}} 与「${name}」之间的关系，就是 {{char}} 与 {{user}} 的关系；场景和开场白从这层关系出发。`;
        }
        return [
            '# {{user}} 的身份',
            `{{user}} 扮演原著角色「${name}」。${profile ? `「${name}」的资料：\n${profile}` : ''}`,
            `- 卡片各字段里凡是指「${name}」的地方一律写成 {{user}}（包括别人对「${name}」的称呼和提到「${name}」的叙述），不要出现「${name}」这个名字。`,
            relation,
            orientation ? `- 原伴侣、第三者等导向里的其他角色不能是「${name}」本人。` : '',
            world ? `- 主要角色一览里不要单独列出「${name}」，写到这个人时一律写成 {{user}}。` : '',
            USER_ROLE_WINS,
            '- 不替 {{user}} 说话、行动，不描写 {{user}} 的心理活动。',
        ].filter(Boolean).join('\n');
    }
    if (r.kind === 'custom') {
        return [
            '# {{user}} 的身份',
            `{{user}} 的身份（用户设定）：${r.text}`,
            '- 按这个身份安排 {{user}} 与 {{char}} 的关系、场景和开场白里的切入点。',
            USER_ROLE_WINS,
            '- 不替 {{user}} 说话、行动，不描写 {{user}} 的心理活动。',
        ].join('\n');
    }
    return '';
}

/**
 * 状态栏变量表提示词里的说明（主角 = {{user}} 是谁）；原创新身份时为 ''。
 * @param {object} project
 * @param {object} card
 */
export function userRoleStatusText(project, card) {
    const r = normalizeUserRole(card?.userRole, { exclude: card?.kind === 'world' ? '' : card?.charName });
    const upto = Number.isFinite(card?.timepoint) ? card.timepoint : Infinity;
    if (r.kind === 'character') {
        const name = userRoleCharName(project, r);
        const profile = userRoleProfile(project, r, upto);
        return [
            '# 主角（{{user}}）的身份',
            `主角就是 {{user}}，扮演原著角色「${name}」。${profile ? `「${name}」的资料：\n${profile}` : ''}`,
            `- 主角.* 的变量按「${name}」的身份、处境和能力设计，初始值符合「${name}」在故事时间点时的状态。`,
            `- 「${name}」就是主角：不要再为「${name}」建角色变量，也不要把「${name}」放进按角色名记录的记录里。`,
        ].join('\n');
    }
    if (r.kind === 'custom') {
        return ['# 主角（{{user}}）的身份', `主角就是 {{user}}：${r.text}`, '- 主角.* 的变量按这个身份设计。'].join('\n');
    }
    return '';
}

/**
 * 卡片自己的世界书里的「{{user}} 的身份」逻辑条目；原创新身份时返回 null。
 * 常驻，放在角色定义之后（position 1）。世界/旁白卡的 {{char}} 是旁白：写的是原著里各角色与这个人的关系；
 * 卡片带剧情导向时，原著关系只作底子，与「剧情导向」词条冲突时以导向为准。
 */
export function userRoleEntry(project, card) {
    const r = normalizeUserRole(card?.userRole, { exclude: card?.kind === 'world' ? '' : card?.charName });
    if (r.kind === 'new') return null;
    let content;
    if (r.kind === 'character') {
        const name = userRoleCharName(project, r);
        const profile = userRoleProfile(project, r, Number.isFinite(card?.timepoint) ? card.timepoint : Infinity);
        const relation = card?.kind === 'world'
            ? `原著里各角色与「${name}」之间的关系，就是他们与 {{user}} 的关系`
            : `{{char}} 与「${name}」之间的关系，就是 {{char}} 与 {{user}} 的关系`;
        const tail = normalizeCardOrientation(card?.orientation) ? '，以此为基础；与「剧情导向」词条冲突时以剧情导向为准。' : '。';
        content = [
            `{{user}} 扮演原著中的「${name}」。原著里「${name}」的经历、身份和人际关系都属于 {{user}}；${relation}${tail}`,
            profile ? `「${name}」的资料：\n${profile}` : '',
            '不替 {{user}} 说话、行动，不描写 {{user}} 的心理活动。',
        ].filter(Boolean).join('\n\n');
    } else {
        content = `{{user}} 的身份：${r.text}\n\n不替 {{user}} 说话、行动，不描写 {{user}} 的心理活动。`;
    }
    return {
        category: '身份', name: USER_ROLE_ENTRY_TITLE, comment: USER_ROLE_ENTRY_TITLE, keywords: [], content,
        constant: true, position: 1, depth: 4, role: 0, order: 3, disable: false,
        excludeRecursion: true, preventRecursion: true,
    };
}
