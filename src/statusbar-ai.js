// 状态栏（MVU 变量）的 AI 生成：
//   1) 变量表：AI 按 JSON 模板输出 → extractJson → normalizeStatusSpec（不合法 JSON / 没有可用变量时带着原因重试一次）
//   2) 界面（绑定模式）：AI 输出一个 ```html 片段 → 取第一个 html 代码块 → lintStatusHtml + 导出往返检查
//      → 有错误时把错误发回去重试一次 → 仍失败就改用内置排版（mode 'auto'）并记下提示
// 可单独生成的部分（parts）：spec（整体重新设计）、init（保留路径，只更新初始值）、rules（保留路径，只重写 desc/check）、html（界面）。
// 模板（templateMode）：structure = 沿用结构（模板变量表经 {TEMPLATE_SPEC} 交给 AI，只填初始值与规则；界面沿用模板）；
//                      style = 只借外观（模板界面作为 {STYLE_REF}，AI 按本卡变量表重写界面）。
// 每次成功都把生成前的 {spec, html, mode, theme, sample, templateId} 存进 statusBar.prev，restoreStatusBarPrev 一步撤销。
// 世界/旁白卡（card.kind === 'world'）：{{char}} 是旁白（statusBarCharName），变量表按群像设计——「主要角色」记录（生成后用
//   worldCastNames 把项目里的主要角色预先填进初始条目）、「NPC」记录（扮演中 insert）、世界.* 与 主角.*；
//   提示词多一段可在设置里修改的「世界卡附加说明」（statusSpecWorld / statusHtmlWorld，填进 {WORLD_GUIDE}）。
// 界面提示词的 {LAYOUT_GUIDE} 按本卡变量表给出绑定示例：记录逐项生成、分组（data-nl-group / 点路径）、立绘槽位与换图按钮。
// 不碰 DOM；调用 AI 走 callLLM + chainFor(settings, 'statusbar')。注意：cards.js 不要反过来引用本模块（避免循环依赖）。

import { DEFAULT_STATUS_BAR } from './constants.js';
import { timepointLabel, worldContext } from './cards.js';
import { cardContentText } from './deduce.js';
import { extractJson, removeTags } from './json.js';
import { callLLM, chainFor, errorText } from './llm.js';
import { IMPORTANCE_RANK, buildOutlineText, characterAt, characterProfileText } from './project.js';
import { getPrompt, render } from './prompts.js';
import {
    GROUP_FIELD_MAX, MAX_PATH_DEPTH, RECORD_FIELD_MAX, buildInitialState, buildStatusRegexReplace, castRecordPath, countSpecLeaves,
    ensureStatusBar, isCastRecord, isWorldCard, lintStatusHtml, normalizePortraits, normalizeStatusSpec, parseStateWithSpec, portraitsActive,
    seedWorldCastEntries, specSummaryText, statusBarCharName, worldCastNames,
} from './statusbar.js';
import { STATUS_BINDING_GUIDE, STATUSBAR_THEMES, cleanFragment, compileStatusDocument, renderDefaultFragment } from './statusbar-runtime.js';
import { templateVarCap } from './statusbar-templates.js';
import { abortError, isAbortError, truncate } from './utils.js';

/** generateStatusBar 的 parts 可选值 */
export const STATUS_PARTS = ['spec', 'init', 'rules', 'html'];

const THEMES = STATUSBAR_THEMES.map((t) => t.value);
const MODES = ['bind', 'raw', 'auto'];

const BAD_JSON_FEEDBACK = '上面的输出不是合法 JSON（可能被截断或含未转义的引号）。请重新输出完整、合法的 JSON 对象，只输出 JSON。字符串中的双引号请改用中文引号。';

function isObj(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function clone(v) {
    return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
}

function statusCfg(settings) {
    return { ...DEFAULT_STATUS_BAR, ...(settings?.statusBar || {}) };
}

function maxVarsOf(settings) {
    const n = Number(statusCfg(settings).maxVars);
    return Number.isFinite(n) && n >= 1 ? Math.floor(n) : DEFAULT_STATUS_BAR.maxVars;
}

/** 路径里 {{char}} 换成的名字：卡片名；世界/旁白卡没有名字时是「旁白」 */
function charNameOf(card) {
    return statusBarCharName(card);
}

function cardKindText(card) {
    return isWorldCard(card) ? '世界/旁白卡' : '角色卡';
}

/** 世界/旁白卡的主要角色名（写进提示词、预填进「主要角色」记录）；资料不全时返回空数组 */
function castNamesOf(project, card) {
    if (!isWorldCard(card)) return [];
    try {
        return worldCastNames(project, card);
    } catch {
        return [];
    }
}

function castText(names, fallback) {
    return names.length ? names.join('、') : fallback;
}

// 按角色名记录的多人数据（主要角色 / NPC / 队友…）的判断在 statusbar.js（立绘候选也用它），这里照旧导出
export { castRecordPath, isCastRecord };

/** 世界/旁白卡：把项目里的主要角色预先填进「主要角色」记录（AI 已经写了的条目保持原样） */
function seedWorldCast(project, card, spec, { warnings, onLog }) {
    const r = seedWorldCastEntries(project, card, spec, { names: castNamesOf(project, card), warnings });
    if (r.added.length) onLog?.(`🧩 已把 ${r.added.length} 个主要角色预先填进「${r.path}」：${r.added.join('、')}`);
    return r.spec;
}

function bookOf(project) {
    return project?.bookName || project?.name || '';
}

function uptoOf(card) {
    return Number.isFinite(card?.timepoint) ? card.timepoint : Infinity;
}

function instructionLine(instruction) {
    const s = String(instruction || '').trim();
    return s ? `- 额外要求（优先满足）：${s}` : '';
}

// ---------------- 提示词 ----------------

function timepointText(project, card) {
    try {
        return project?.chunks ? timepointLabel(project, uptoOf(card)) : '全书结束时';
    } catch {
        return '全书结束时';
    }
}

/** 原著背景（精简版）：角色资料 + 相关世界设定 + 到时间点为止的剧情进展。资料不全时只返回能拿到的部分 */
function backgroundContext(project, settings, card) {
    if (!project) return '（无）';
    const upto = uptoOf(card);
    const parts = [];
    let focus = '';
    try {
        const ch = card.kind !== 'world' && card.charName ? project.characters?.[card.charName] : null;
        if (ch) {
            const profile = characterProfileText(characterAt(ch, upto), { maxExperiences: 8, maxQuotes: 3, maxDialogues: 1 });
            parts.push(`## 角色资料\n${profile}`);
            focus = profile;
        } else {
            const mains = Object.values(project.characters || {})
                .filter((c) => !(c.firstChunk > upto))
                .sort((a, b) => (IMPORTANCE_RANK[b.importance] || 0) - (IMPORTANCE_RANK[a.importance] || 0))
                .slice(0, 8)
                .map((c) => {
                    const v = characterAt(c, upto);
                    return `- ${v.name}：${v.identity || '身份不明'}`;
                });
            if (mains.length) {
                parts.push(`## 主要角色\n${mains.join('\n')}`);
                focus = mains.join('\n');
            }
        }
        const world = worldContext(project, settings, `${focus}\n${card.data?.description || ''}\n${card.data?.scenario || ''}`, upto, 2500);
        if (world && world !== '（无）') parts.push(`## 世界设定\n${world}`);
        const outline = buildOutlineText(project, upto, 2500);
        if (outline) parts.push(`## 剧情进展（到时间点为止）\n${outline}`);
    } catch { /* 资料不全：只用已经拿到的部分，角色卡内容另有 {CARD_CONTENT} */ }
    return parts.join('\n\n') || '（无）';
}

/** {TYPE_GUIDE} 里分组写法的示例（只用在 record 的 object 值里） */
const GROUP_FIELD_EXAMPLE = { key: '服饰', type: 'object', fields: [{ key: '上衣', type: 'string', init: '' }, { key: '下装', type: 'string', init: '' }] };
const GROUP_INIT_EXAMPLE = { 条目名: { 好感: 30, 服饰: { 上衣: '白衬衫', 下装: '长裙' } } };

/**
 * {TYPE_GUIDE}：变量类型、记录的分组字段、计数方式、显示方式与路径写法
 * @param {string} charName 路径里角色分组的示例名
 * @param {{world?: boolean}} opt world：世界/旁白卡（第一层的示例换成 世界 / 主角 / 按角色名记录的 record）
 */
export function statusTypeGuide(charName = '', { world = false } = {}) {
    const who = charName || '角色名';
    const first = world ? '世界、主角，或者直接是按角色名记录的 record，如 主要角色、NPC' : `世界、${who}、主角`;
    return [
        '- number：数字。必须给 min 和 max；整数加 "integer": true；可选 stages（数值阶段，按 min 从小到大，例如 0 戒备 / 40 信任 / 80 依恋），界面会显示当前所处的阶段。',
        '- string：短文本，如时间、地点、着装、当前目标；可用 format 说明写法（如 "YYYY年MM月DD日 HH:MM"）。',
        '- enum：只能取 options 里的值（2-8 个），适合心情、关系阶段、剧情阶段。',
        '- boolean：是/否，如是否在场、是否知道某个秘密。',
        '- list：文本列表，如身体状态、近期事件；用 maxItems 限制条数（超出时只保留最新的）。',
        `- record：键名不固定的记录，如物品栏（键是物品名）、任务表（键是任务名）、多个角色各自的状态（键是角色名）；keyDesc 说明键是什么；value 是 number、string，或带 1-${RECORD_FIELD_MAX} 个字段的 object（字段类型 number / string / boolean / enum；数字字段要给 min / max，也可以带 stages）。新条目用 insert 加入，删除用 remove。`,
        `- 分组（只能用在 record 的 object 值里）：同类字段可以收进一层分组，写法 ${JSON.stringify(GROUP_FIELD_EXAMPLE)}。一个分组在 fields 里算一个字段，里面最多 ${GROUP_FIELD_MAX} 个字段，只能是 number / string / boolean / enum，分组里不能再套分组。init 里分组写成嵌套对象，如 ${JSON.stringify(GROUP_INIT_EXAMPLE)}；扮演中更新时的完整路径是 记录.条目名.分组.字段（如 主要角色.条目名.服饰.上衣），变量的 path 只写到记录本身。`,
        '- 计数：普通变量每个算 1 个；record 按字段计，分组里的每个字段各算 1 个，与记录里有多少条目无关。',
        '- widget（显示方式）：text 文字 / bar 进度条（有范围的数字）/ badge 徽标（选项、是否）/ tags 标签（列表）/ list 条目列表（记录）/ hidden 不显示（只给 AI 记账）。',
        `- path（路径）：用“.”分隔的中文短名，最多 ${MAX_PATH_DEPTH} 层，第一层通常是分组（如 ${first}）；用户一律写作“主角”；每段不能含空格、引号、/ . ~ < > { } [ ] 等符号，不能是纯数字；以 _ 开头的变量 AI 只能读、不能改。`,
    ].join('\n');
}

/** {JSON_TEMPLATE}（整体设计时）：每个变量一行的示例 */
export function statusJsonTemplate(charName = '') {
    const who = charName || '角色名';
    const vars = [
        { path: '世界.时间', type: 'string', init: '…', format: 'YYYY年MM月DD日 HH:MM', label: '时间', widget: 'text', check: ['每轮按剧情推进'] },
        { path: '世界.地点', type: 'string', init: '…', label: '地点', widget: 'text', check: ['场景切换时更新'] },
        { path: `${who}.好感度`, type: 'number', init: 30, min: 0, max: 100, integer: true, label: '好感', widget: 'bar', stages: [{ min: 0, label: '戒备' }, { min: 40, label: '信任' }, { min: 80, label: '依恋' }], desc: `${who}对{{user}}的好感`, check: ['…', '单次变化 ±(1~5)'] },
        { path: `${who}.心情`, type: 'enum', options: ['平静', '开心', '低落'], init: '平静', label: '心情', widget: 'badge', check: ['…'] },
        { path: `${who}.在场`, type: 'boolean', init: true, label: '在场', widget: 'badge', check: ['…'] },
        { path: `${who}.状态`, type: 'list', init: [], maxItems: 5, label: '状态', widget: 'tags', check: ['…'] },
        { path: '主角.物品', type: 'record', keyDesc: '物品名', value: { type: 'object', fields: [{ key: '数量', type: 'number', min: 0, integer: true, init: 1 }, { key: '描述', type: 'string', init: '' }] }, init: { 物品名: { 数量: 1, 描述: '…' } }, label: '物品', widget: 'list', check: ['获得时用 insert 新增，失去时用 remove 删除'] },
    ];
    return jsonTemplateText(`状态栏标题（如：${who}的状态）`, vars);
}

function jsonTemplateText(title, vars) {
    return `{\n  "title": ${JSON.stringify(title)},\n  "variables": [\n${vars.map((v) => `    ${JSON.stringify(v)}`).join(',\n')}\n  ]\n}`;
}

/**
 * {JSON_TEMPLATE}（世界/旁白卡整体设计时）：世界.* / 主角.* + 「主要角色」记录（带好感阶段与「服饰」分组，init 以第一个主要角色为例）
 * + 「NPC」记录（init 为空，扮演中 insert）。共 10 个叶子，在默认上限 12 以内。
 * @param {string} charName 卡片名（标题示例用）
 * @param {string[]} cast 主要角色名
 */
export function statusWorldJsonTemplate(charName = '', cast = []) {
    const first = (Array.isArray(cast) && cast.find((x) => String(x || '').trim())) || '角色名';
    const vars = [
        { path: '世界.时间', type: 'string', init: '…', format: 'YYYY年MM月DD日 HH:MM', label: '时间', widget: 'text', check: ['每轮按剧情推进'] },
        { path: '世界.地点', type: 'string', init: '…', label: '地点', widget: 'text', check: ['场景切换时更新'] },
        { path: '主角.身份', type: 'string', init: '…', label: '身份', widget: 'text', check: ['…'] },
        {
            path: '主要角色', type: 'record', keyDesc: '角色名', label: '主要角色', widget: 'list',
            value: {
                type: 'object',
                fields: [
                    { key: '身份', type: 'string', init: '' },
                    { key: '好感', type: 'number', min: 0, max: 100, integer: true, init: 30, stages: [{ min: 0, label: '陌生' }, { min: 40, label: '信任' }, { min: 80, label: '亲密' }] },
                    { key: '心情', type: 'enum', options: ['平静', '开心', '低落'], init: '平静' },
                    { key: '服饰', type: 'object', fields: [{ key: '上衣', type: 'string', init: '' }, { key: '下装', type: 'string', init: '' }] },
                ],
            },
            init: { [first]: { 身份: '…', 好感: 30, 心情: '平静', 服饰: { 上衣: '…', 下装: '…' } } },
            check: ['每个主要角色一个条目，键是角色名', '好感按与{{user}}的互动变化，单次 ±(1~5)', '换装时更新 服饰'],
        },
        {
            path: 'NPC', type: 'record', keyDesc: 'NPC 名', label: 'NPC', widget: 'list',
            value: { type: 'object', fields: [{ key: '身份', type: 'string', init: '' }, { key: '好感', type: 'number', min: 0, max: 100, integer: true, init: 20 }] },
            init: {},
            check: ['新的 NPC 登场并与{{user}}互动时用 insert 新增', '长期不再出场时用 remove 删除'],
        },
    ];
    return jsonTemplateText(`状态栏标题（如：${charName || '世界'}·群像）`, vars);
}

function keepTask({ init, rules }) {
    if (init && rules) return '按这张卡开场白的情境重新填写每个变量的 init（初始值），并重写每个变量的 desc 和 1-3 条 check';
    if (init) return '按这张卡开场白的情境重新填写每个变量的 init（初始值），desc 和 check 不用输出';
    return '重写每个变量的 desc 和 1-3 条 check（什么情况下更新、怎么更新、变化幅度），init 不用输出';
}

/** 世界/旁白卡在保留路径模式下更新初始值时：提醒 AI 给每个主要角色写一个条目 */
function keepCastLine(base, cast) {
    const path = castRecordPath(base);
    if (!path || !cast.length) return '';
    return `这是世界/旁白卡：「${path}」按角色名记录，init 里为这些主要角色各写一个条目（键照抄名字）：${cast.join('、')}。`;
}

/**
 * {TEMPLATE_SPEC}：保留路径的模式（沿用模板结构 / 只更新初始值 / 只重写规则）下，交给 AI 的既定变量表。
 * <变量表> 块里只放 JSON 数组（浏览器冒烟测试的模拟 AI 直接解析它），补充说明写在块外面。
 */
function keepSection(base, opt) {
    const extra = [];
    if (opt.init && base.variables.some((v) => v.type === 'record' && v.value?.type === 'object')) {
        extra.push(`记录（record）的 init 写成 {条目名: {字段: 值}}，字段按该变量的 value.fields 写全；分组字段写成嵌套对象，如 ${JSON.stringify(GROUP_INIT_EXAMPLE)}。`);
    }
    if (opt.init && opt.castLine) extra.push(opt.castLine);
    return [
        '',
        '# 沿用的变量结构（优先于上面的设计要求）',
        '下面这张变量表的结构已经确定：每个变量的 path、type、label、options、min / max、stages、widget 都保持不变，不增删变量，不改路径。',
        `本次只需要：${keepTask(opt)}。`,
        ...extra,
        '<变量表>',
        `[\n${base.variables.map((v) => `  ${JSON.stringify(v)}`).join(',\n')}\n]`,
        '</变量表>',
        '按下方 JSON 模板输出，variables 里每个变量一项，path 原样照抄。',
        '',
    ].join('\n');
}

function keepJsonTemplate(base, { init, rules, title }) {
    const ex = base.variables[0] || { path: '分组.变量', init: '' };
    const item = { path: ex.path };
    if (init) item.init = ex.init;
    if (rules) {
        item.desc = '…';
        item.check = ['…'];
    }
    const head = title ? `  "title": ${JSON.stringify(base.title || '状态栏')},\n` : '';
    return `{\n${head}  "variables": [\n    ${JSON.stringify(item)},\n    …（每个变量一项，path 照抄变量表）\n  ]\n}`;
}

/**
 * 变量表提示词。base 不为空时是“保留路径”模式：结构来自 base，AI 只填 init（init）和/或 desc/check（rules）。
 * @returns {{system: string, prompt: string}}
 */
/**
 * 世界卡附加说明（设置里可改的 statusSpecWorld / statusHtmlWorld）渲染后的文字；主提示模板里没有 {WORLD_GUIDE}（用户改过的旧模板）时
 * 由调用方接在主提示末尾，世界卡照样能拿到这段说明。
 */
function worldGuideText(settings, key, vars) {
    return render(getPrompt(settings, key), vars).trim();
}

function withWorldGuide(template, prompt, guide) {
    return guide && !String(template).includes('{WORLD_GUIDE}') ? `${prompt}\n\n${guide}` : prompt;
}

/**
 * 变量表提示词。base 不为空时是“保留路径”模式：结构来自 base，AI 只填 init（init）和/或 desc/check（rules）。
 * 世界/旁白卡：整体设计时带上世界卡附加说明（{WORLD_GUIDE}，含主要角色名单）与群像版 JSON 模板；保留路径模式下更新初始值时，
 * 提醒 AI 为每个主要角色写一个条目。
 * @returns {{system: string, prompt: string}}
 */
export function buildStatusSpecPrompt(project, settings, card, { base = null, init = true, rules = true, allowTitle = false, instruction = '' } = {}) {
    const charName = charNameOf(card);
    const world = isWorldCard(card);
    const cast = castNamesOf(project, card);
    const sb = card.statusBar || {};
    const guide = world && !base
        ? worldGuideText(settings, 'statusSpecWorld', { CHAR_NAME: charName, CAST: castText(cast, '（项目里还没有主要角色资料，按角色卡内容列出主要角色）') })
        : '';
    const vars = {
        BOOK: bookOf(project),
        CHAR_NAME: charName,
        CARD_KIND: cardKindText(card),
        TIMEPOINT: timepointText(project, card),
        CARD_CONTENT: cardContentText(card),
        CONTEXT: backgroundContext(project, settings, card),
        REQUIREMENT: String(sb.requirement || '').trim() || '（无特别要求）',
        MAX_VARS: base ? countSpecLeaves(base) : maxVarsOf(settings),
        WORLD_GUIDE: guide,
        TEMPLATE_SPEC: base ? keepSection(base, { init, rules, castLine: world ? keepCastLine(base, cast) : '' }) : '',
        TYPE_GUIDE: statusTypeGuide(charName, { world }),
        JSON_TEMPLATE: base ? keepJsonTemplate(base, { init, rules, title: allowTitle }) : world ? statusWorldJsonTemplate(charName, cast) : statusJsonTemplate(charName),
        INSTRUCTION_LINE: instructionLine(instruction),
    };
    const template = getPrompt(settings, 'statusSpec');
    return {
        system: render(getPrompt(settings, 'statusSpecSystem'), vars),
        prompt: withWorldGuide(template, render(template, vars), guide),
    };
}

function sampleFor(spec, sample) {
    if (isObj(sample)) {
        const r = parseStateWithSpec(spec, sample);
        if (r.ok) return r.data;
    }
    return buildInitialState(spec);
}

function defaultStyleRef(project, card) {
    const tags = (Array.isArray(card.data?.tags) ? card.data.tags : []).filter(Boolean).slice(0, 6);
    const book = bookOf(project);
    return [
        `按${book ? `《${book}》` : '这张角色卡'}的题材与氛围自行决定配色、字体与装饰，做出有辨识度的设计，不要千篇一律的白底灰字。`,
        tags.length ? `题材标签：${tags.join('、')}` : '',
    ].filter(Boolean).join('\n');
}

function templateStyleRef(html) {
    return `参照下面这份界面的视觉风格（配色、字体、边框、装饰与布局手法），但按本卡的变量表重新写标记和绑定，不要照抄其中的变量、文字和数据：\n<参考界面>\n${truncate(String(html).trim(), 12000)}\n</参考界面>`;
}

function currentStyleRef(html) {
    return `下面是当前的界面。按“额外要求”在它的基础上修改，没有提到的部分尽量保持原样：\n<当前界面>\n${truncate(String(html).trim(), 12000)}\n</当前界面>`;
}

function escText(s) {
    return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
}

function hasRange(f) {
    return Number.isFinite(f?.min) && Number.isFinite(f?.max);
}

/** 一个记录变量的界面示例：data-nl-each 逐项生成卡片；角色记录带立绘槽位与换图按钮；有分组时用 data-nl-group 放进 <details> */
function recordExample(v, { portrait }) {
    const parts = [];
    if (portrait) parts.push('<img class="sb-av" data-nl-portrait="" alt=""><button type="button" class="sb-swap" data-nl-portrait-next="">换</button>');
    parts.push('<b class="sb-name" data-nl-key></b>');
    if (v.value?.type === 'object') {
        const top = v.value.fields || [];
        const bar = top.find((f) => f.type === 'number' && hasRange(f));
        if (bar) {
            parts.push(`<span class="sb-bar" data-nl-item-bar="${bar.key}"><i></i></span>`);
            if (bar.stages?.length) parts.push(`<span class="sb-stage" data-nl-item-stage="${bar.key}"></span>`);
        }
        for (const f of top.filter((x) => x !== bar && x.type !== 'object').slice(0, 2)) parts.push(`<span class="sb-val" data-nl-item="${f.key}"></span>`);
        const g = top.find((f) => f.type === 'object');
        if (g) {
            parts.push(`<details class="sb-more"><summary>${escText(g.label || g.key)}</summary><div class="sb-grp" data-nl-group="${g.key}"><template><span class="sb-kv"><span data-nl-key></span>：<span data-nl-item=""></span></span></template></div></details>`);
        }
    } else {
        parts.push('<span class="sb-val" data-nl-item=""></span>');
    }
    return `<div class="sb-list" data-nl-each="${v.path}" data-nl-empty="暂无"><template><div class="sb-card">${parts.join('')}</div></template></div>`;
}

/** 用户已经配置的立绘（名字与立绘池）；没有任何图片时返回 '' */
function portraitNote(raw) {
    let p = null;
    try {
        p = normalizePortraits(raw);
    } catch {
        p = null;
    }
    if (!p || !portraitsActive(p)) return '';
    const clean = (s) => String(s ?? '').replace(/[{}<>`$"]/g, '');
    const names = Object.entries(p.characters || {}).filter(([, list]) => Array.isArray(list) && list.length).map(([n]) => clean(n)).filter(Boolean);
    const shown = names.slice(0, 12);
    const pools = (p.pools || []).map((x) => `「${clean(x.record)}」里按「${clean(x.field)}」分配的立绘池`);
    const what = [shown.length ? `${shown.join('、')}${names.length > shown.length ? ` 等 ${names.length} 个角色` : ''}` : '', ...pools].filter(Boolean).join('；');
    return `- 用户已经配置了立绘：${what}。界面里要给这些角色留出立绘槽位（记录里的角色放在 data-nl-each 的模板里，不在记录里的写 data-nl-portrait="名字"）。`;
}

/**
 * {LAYOUT_GUIDE}：按本卡变量表给出的绑定示例——角色记录（键是角色名）逐个生成卡片并放立绘槽位与换图按钮、
 * 记录里的分组用 data-nl-group 或点路径（data-nl-item="服饰.上衣"）、单人卡可选的立绘槽位，以及用户的立绘配置情况。
 * 变量表里既没有角色记录、也没有带分组的记录、也没有角色自己的分组，且没有配置立绘时返回 ''。
 * @param {{variables: object[]}} spec 规范化后的变量表
 * @param {{charName?: string, world?: boolean, portraits?: object|null}} opt
 * @returns {string} 以换行开头和结尾（直接放进提示词），或 ''
 */
export function statusLayoutGuide(spec, { charName = '', world = false, portraits = null } = {}) {
    const vars = (spec?.variables || []).filter((v) => v && v.widget !== 'hidden');
    const recs = vars.filter((v) => v.type === 'record');
    const grouped = (v) => v.value?.type === 'object' && (v.value.fields || []).some((f) => f.type === 'object');
    const picked = [...recs.filter(isCastRecord), ...recs.filter((v) => !isCastRecord(v) && grouped(v))].slice(0, 3);
    const lines = [];
    for (const v of picked) {
        const cast = isCastRecord(v);
        const g = v.value?.type === 'object' ? (v.value.fields || []).find((f) => f.type === 'object') : null;
        const bits = [cast
            ? `「${v.path}」的每个条目是一个角色：用 data-nl-each 逐个生成角色卡片，卡片里放立绘槽位 <img data-nl-portrait=""> 和换图按钮 <button type="button" data-nl-portrait-next="">`
            : `「${v.path}」：用 data-nl-each 逐项生成`];
        if (g?.fields?.length) bits.push(`分组「${g.key}」用 data-nl-group="${g.key}" 按字段逐个生成，也可以直接写点路径，如 data-nl-item="${g.key}.${g.fields[0].key}"`);
        lines.push(`- ${bits.join('；')}。例如：`, recordExample(v, { portrait: cast }));
    }
    const own = !world && charName && vars.some((v) => String(v.path || '').startsWith(`${charName}.`)) ? charName : '';
    if (own) lines.push(`- 可选：在「${own}」的名字旁放立绘槽位 <img class="sb-av" data-nl-portrait="${own}" alt="">，需要时再加换图按钮 <button type="button" data-nl-portrait-next="${own}">换</button>。`);
    const note = portraitNote(portraits);
    if (!lines.length && !note) return '';
    lines.push(note || '- 目前还没有配置立绘图片：立绘槽位会显示带名字首字的占位块（class nl-portrait-ph，可以给它加样式），用户之后在 NovelLoom 的「立绘」里添加图片后自动显示。');
    lines.push('- 立绘槽位和换图按钮只负责占位：不要写 src 或任何图片地址；换图按钮的点击由运行时处理（不会触发外层卡片的点击），不要再给它绑定点击事件。');
    return ['', '# 本卡的绑定示例（结构可以照着写，样式自己设计）', ...lines, ''].join('\n');
}

/**
 * 界面提示词（绑定模式片段）
 * @param {{spec?: object, sample?: object|null, styleRef?: string, instruction?: string}} opt
 *   styleRef 为空时用默认的“按题材自行设计”；sample 不合法或为空时用变量表初始值。
 *   {LAYOUT_GUIDE} 按变量表与 statusBar.portraits 生成；世界/旁白卡另带世界卡附加说明（{WORLD_GUIDE}）。
 */
export function buildStatusHtmlPrompt(project, settings, card, { spec = null, sample = null, styleRef = '', instruction = '' } = {}) {
    const sb = card.statusBar || {};
    const s = spec || sb.spec || { title: '状态栏', variables: [] };
    const charName = charNameOf(card);
    const world = isWorldCard(card);
    // 界面里不需要宏：变量说明/示例数据里的 {{user}}/{{char}} 换成名字，免得 AI 照抄进代码
    const plain = (t) => String(t).replace(/\{\{\s*user\s*\}\}/gi, '主角').replace(/\{\{\s*char\s*\}\}/gi, charName || '角色');
    const guide = world
        ? plain(worldGuideText(settings, 'statusHtmlWorld', { CHAR_NAME: charName, CAST: castText(castNamesOf(project, card), '（见示例数据）') }))
        : '';
    const vars = {
        CHAR_NAME: charName,
        CARD_KIND: cardKindText(card),
        SPEC_SUMMARY: plain(`标题：${s.title || '状态栏'}\n${specSummaryText(s)}`),
        SAMPLE_JSON: plain(JSON.stringify(sampleFor(s, sample), null, 2)),
        BINDING_GUIDE: STATUS_BINDING_GUIDE,
        LAYOUT_GUIDE: plain(statusLayoutGuide(s, { charName, world, portraits: sb.portraits })),
        STYLE_REF: styleRef || defaultStyleRef(project, card),
        WORLD_GUIDE: guide ? `\n${guide}\n` : '',
        REQUIREMENT: String(sb.requirement || '').trim() || '（无特别要求）',
        INSTRUCTION_LINE: instructionLine(instruction),
    };
    const template = getPrompt(settings, 'statusHtml');
    return {
        system: render(getPrompt(settings, 'statusHtmlSystem'), vars),
        prompt: withWorldGuide(template, render(template, vars), guide),
    };
}

// ---------------- 解析 AI 输出 ----------------

const HTML_START = /<(?:style|div|section|details|main|article|header|aside|nav|table|ul|ol|span|p|svg|template|figure|h[1-6]|!--)\b/i;

/**
 * 从 AI 回复里取界面代码：第一个 ```html 代码块；没有就取第一个内容以 < 开头的代码块；
 * 完全没有代码块时取从第一个 HTML 标签到最后一个 > 的文字。没写完的代码块（被截断）取到结尾。找不到返回 ''。
 */
export function extractHtmlBlock(text) {
    const t = String(text ?? '').replace(/\r\n/g, '\n');
    const blocks = [...t.matchAll(/```[ \t]*([\w-]*)[^\n]*\n([\s\S]*?)(?:```|$)/g)].map((m) => ({ lang: m[1].toLowerCase(), body: m[2].trim() }));
    const pick = blocks.find((b) => b.lang === 'html' || b.lang === 'htm') || blocks.find((b) => b.body.startsWith('<'));
    if (pick) return pick.body;
    if (blocks.length) return '';
    const i = t.search(HTML_START);
    if (i < 0) return '';
    const body = t.slice(i);
    return body.slice(0, body.lastIndexOf('>') + 1).trim();
}

/**
 * AI 界面片段的检查：lintStatusHtml（绑定模式，带变量表）+ 组装成文档后做一次导出往返检查（buildStatusRegexReplace）。
 * 空片段算错误（AI 没给代码）。
 * @returns {{errors: string[], warnings: string[]}}
 */
export function checkStatusHtml(html, spec) {
    if (!String(html ?? '').trim()) return { errors: ['回复里没有找到 ```html 代码块'], warnings: [] };
    const r = lintStatusHtml(html, { mode: 'bind', spec });
    if (!r.errors.length) {
        try {
            buildStatusRegexReplace(compileStatusDocument({ statusBar: { mode: 'bind', html, spec, theme: 'clean' } }));
        } catch (e) {
            r.errors.push(e.message);
        }
    }
    return r;
}

function htmlRepairFeedback(check) {
    if (check.errors.length === 1 && /没有找到/.test(check.errors[0])) {
        return '上面的回复里没有找到 ```html 代码块。请只输出一个 ```html 代码块，里面是完整的界面代码（<style> + 带 data-nl-* 绑定的标记 + 可选的 nlRender 脚本）。';
    }
    return [
        '上面的界面代码没有通过检查，导出时会被拒绝：',
        ...check.errors.map((e) => `- ${e}`),
        ...(check.warnings.length ? ['另外还有这些提示，能改就一起改：', ...check.warnings.map((w) => `- ${w}`)] : []),
        '请修正后重新输出完整的界面代码，仍然只输出一个 ```html 代码块。',
    ].join('\n');
}

function pathKey(raw, charName) {
    let p = Array.isArray(raw) ? raw.map((x) => String(x).trim()).join('.') : String(raw ?? '').trim();
    const who = String(charName || '').trim() || '角色';
    p = p.replace(/\{\{\s*user\s*\}\}|<user>/gi, '主角').replace(/\{\{\s*char\s*\}\}|<char>|<bot>/gi, who);
    p = p.replace(/^\/+/, '');
    if (!p.includes('.') && p.includes('/')) p = p.split('/').join('.');
    p = p.replace(/^(?:stat_data|status_current_variables?)\./, '');
    return p.split('.').map((s) => s.trim()).join('.');
}

const BOOL_WORDS = ['true', 'false', '是', '否', 'yes', 'no', '1', '0'];

/** AI 给的初始值能不能用于这个变量（不能用时保留原值，而不是让规范化悄悄改成默认值） */
function usableInit(v, val) {
    if (val === undefined) return false;
    switch (v.type) {
        case 'number':
            return val !== null && val !== '' && typeof val !== 'boolean' && typeof val !== 'object' && Number.isFinite(Number(val));
        case 'enum':
            return (v.options || []).includes(String(val));
        case 'boolean':
            return typeof val === 'boolean' || BOOL_WORDS.includes(String(val).trim().toLowerCase());
        case 'list':
            return Array.isArray(val) || typeof val === 'string';
        case 'record':
            return isObj(val) || Array.isArray(val);
        default:
            return val !== null && (typeof val !== 'object' || Array.isArray(val));
    }
}

/**
 * 保留路径模式：把 AI 返回的变量（按 path 对应）合并进既定变量表，只取 init（init 为 true 时）和 desc/check（rules 为 true 时），
 * 其余字段一律以 base 为准，再整体规范化，并确认路径没有变化。AI 漏掉的变量、不合法的初始值都保留原值并记入 warnings。
 * @param {{title: string, variables: object[]}} base 规范化过的变量表
 * @param {object|object[]} aiJson AI 返回的 {title?, variables:[{path, init?, desc?, check?}]}（或直接是数组）
 * @returns {{spec: {title: string, variables: object[]}, matched: number}}
 */
export function mergeKeptSpec(base, aiJson, { init = true, rules = true, allowTitle = false, charName = '', warnings = [] } = {}) {
    const src = Array.isArray(aiJson) ? { variables: aiJson } : isObj(aiJson?.spec) ? aiJson.spec : isObj(aiJson) ? aiJson : {};
    const list = Array.isArray(src.variables) ? src.variables : [];
    const byPath = new Map();
    for (const item of list) {
        if (!isObj(item)) continue;
        const key = pathKey(item.path ?? item.name ?? item.key, charName);
        if (key && !byPath.has(key)) byPath.set(key, item);
    }
    const missing = [];
    let matched = 0;
    const merged = base.variables.map((v) => {
        const out = clone(v);
        const ai = byPath.get(v.path);
        if (!ai) {
            missing.push(v.path);
            return out;
        }
        matched++;
        if (init) {
            const val = ai.init !== undefined ? ai.init : v.type === 'record' ? undefined : ai.value;
            if (usableInit(v, val)) out.init = val;
            else if (val !== undefined) warnings.push(`「${v.path}」的初始值 ${JSON.stringify(val)} 不合法，保留原值`);
        }
        if (rules) {
            if (ai.check !== undefined) out.check = ai.check;
            const desc = ai.desc ?? ai.description;
            if (desc !== undefined) {
                if (String(desc).trim()) out.desc = desc;
                else delete out.desc;
            }
        }
        return out;
    });
    if (missing.length && matched) warnings.push(`AI 没有返回这些变量，保留原值：${missing.join('、')}`);
    const title = allowTitle && typeof src.title === 'string' && src.title.trim() ? src.title : base.title;
    const spec = normalizeStatusSpec({ title, variables: merged }, { charName, maxVars: Math.max(1, countSpecLeaves(base)), warnings });
    const before = base.variables.map((v) => v.path).join('\n');
    const after = spec.variables.map((v) => v.path).join('\n');
    if (before !== after) throw new Error('合并后的变量路径与原变量表不一致，已放弃这次结果');
    return { spec, matched };
}

// ---------------- 生成步骤 ----------------

function llmOptions(settings, project, { signal, onLog, expect, minTokens }) {
    return {
        api: settings.api,
        ...chainFor(settings, 'statusbar', project),
        expect,
        signal,
        maxTokens: Math.max(settings.api?.maxTokens || 0, minTokens),
        onNotice: (m, l) => onLog?.(`状态栏：${m}`, l),
        onRetry: ({ attempt, wait, error }) => onLog?.(`⚠️ 状态栏请求失败（${error.message}），${Math.round(wait / 1000)} 秒后第 ${attempt} 次重试`, 'warn'),
    };
}

async function runSpecStep(project, settings, card, { base, init, rules, allowTitle, instruction, signal, onLog, warnings }) {
    const { system, prompt } = buildStatusSpecPrompt(project, settings, card, { base, init, rules, allowTitle, instruction });
    const charName = charNameOf(card);
    const followUps = [];
    for (let attempt = 0; attempt < 2; attempt++) {
        const res = await callLLM({ system, prompt, followUps, ...llmOptions(settings, project, { signal, onLog, expect: 'json', minTokens: 4000 }) });
        const raw = removeTags(res.text, settings.extraction?.filterTags);
        let json;
        try {
            json = extractJson(raw);
        } catch {
            if (attempt === 0) {
                onLog?.('⚠️ 状态栏变量表不是合法 JSON，要求 AI 重新输出', 'warn');
                followUps.push({ role: 'assistant', content: res.text.slice(0, 6000) }, { role: 'user', content: BAD_JSON_FEEDBACK });
                continue;
            }
            const err = new Error('AI 返回的状态栏变量表不是合法 JSON（已要求重新输出一次）');
            err.raw = raw;
            throw err;
        }
        const w = [];
        let spec;
        let ok;
        if (base) {
            const r = mergeKeptSpec(base, json, { init, rules, allowTitle, charName, warnings: w });
            spec = r.spec;
            ok = r.matched > 0;
        } else {
            spec = normalizeStatusSpec(json, { charName, maxVars: maxVarsOf(settings), warnings: w });
            ok = spec.variables.length > 0;
        }
        if (ok) {
            warnings.push(...w);
            return spec;
        }
        const why = base ? '里没有一个变量的 path 与既定变量表一致' : `里没有可用的变量${w.length ? `（${w.slice(0, 6).join('；')}）` : ''}`;
        if (attempt === 0) {
            onLog?.(`⚠️ 状态栏变量表${why}，要求 AI 重新输出`, 'warn');
            followUps.push(
                { role: 'assistant', content: res.text.slice(0, 6000) },
                {
                    role: 'user',
                    content: base
                        ? '上面的输出里没有一个变量的 path 与给定的变量表一致。请按 JSON 模板重新输出，variables 里每个变量一项，path 从变量表原样照抄，只输出 JSON。'
                        : `上面的变量表${why}。请严格按 JSON 模板重新输出完整的 JSON 对象（variables 至少有 1 个变量，路径用中文短名、最多 ${MAX_PATH_DEPTH} 层），只输出 JSON。`,
                },
            );
            continue;
        }
        const err = new Error(`AI 返回的状态栏变量表${why}`);
        err.raw = raw;
        throw err;
    }
    throw new Error('状态栏变量表生成失败');
}

/** @returns {Promise<{html: string, errors: string[], warnings: string[]}>} errors 不为空表示重试后仍未通过 */
async function runHtmlStep(project, settings, card, { spec, sample, styleRef, instruction, signal, onLog }) {
    const { system, prompt } = buildStatusHtmlPrompt(project, settings, card, { spec, sample, styleRef, instruction });
    const followUps = [];
    let last = { html: '', errors: [], warnings: [] };
    for (let attempt = 0; attempt < 2; attempt++) {
        const res = await callLLM({ system, prompt, followUps, ...llmOptions(settings, project, { signal, onLog, expect: 'prose', minTokens: 6000 }) });
        const raw = removeTags(res.text, settings.extraction?.filterTags);
        const html = cleanFragment(extractHtmlBlock(raw));
        const check = checkStatusHtml(html, spec);
        last = { html, errors: check.errors, warnings: check.warnings };
        if (!check.errors.length) return last;
        if (attempt === 0) {
            onLog?.(`⚠️ 状态栏界面没有通过检查（${check.errors.length} 个问题），要求 AI 修正`, 'warn');
            followUps.push({ role: 'assistant', content: res.text.slice(0, 16000) }, { role: 'user', content: htmlRepairFeedback(check) });
        }
    }
    return last;
}

// ---------------- 状态栏对象的更新 ----------------

// maxVars（卡片自己的变量上限）也一起存：撤销整体重新设计时回到之前套用模板记下的上限，撤销套用时回到套用前的
function snapshot(sb) {
    return clone({ spec: sb.spec, html: sb.html || '', mode: sb.mode, theme: sb.theme, sample: sb.sample ?? null, templateId: sb.templateId ?? null, maxVars: sb.maxVars ?? null });
}

function hasContent(snap) {
    return !!(snap?.spec?.variables?.length || String(snap?.html || '').trim());
}

/** 当前实际生效的界面的检查结果（auto 用内置排版，总是干净的）；note 放在 warnings 最前面 */
function effectiveLint(sb, note = '') {
    const r = sb.mode === 'auto'
        ? lintStatusHtml(renderDefaultFragment(sb.spec, sb.theme), { mode: 'auto', spec: sb.spec })
        : lintStatusHtml(sb.html, { mode: sb.mode, spec: sb.spec });
    if (note) r.warnings.unshift(note);
    return r;
}

function resolveTemplate(settings, sb, opts) {
    if (isObj(opts.template)) return opts.template;
    const id = opts.templateId || sb.templateId;
    if (!id) return null;
    return (Array.isArray(settings?.statusBarTemplates) ? settings.statusBarTemplates : []).find((t) => t?.id === id) || null;
}

function resolveParts(parts, sb, templateMode) {
    let list;
    if (parts === undefined || parts === null) {
        if (templateMode === 'structure') list = ['init', 'rules'];
        else if (templateMode === 'style') list = sb.spec?.variables?.length ? ['html'] : ['spec', 'html'];
        else list = sb.mode === 'bind' ? ['spec', 'html'] : ['spec'];
    } else {
        list = (Array.isArray(parts) ? parts : [parts]).map(String);
    }
    list = list.filter((p) => STATUS_PARTS.includes(p));
    if (templateMode === 'structure' && list.includes('spec')) list = [...list.filter((p) => p !== 'spec'), 'init', 'rules'];
    if (list.includes('spec')) list = list.filter((p) => p !== 'init' && p !== 'rules');
    if (!list.length) throw new Error('没有指定要生成的部分（spec / init / rules / html）');
    return { spec: list.includes('spec'), init: list.includes('init'), rules: list.includes('rules'), html: list.includes('html') };
}

/**
 * 保留路径模式的既定变量表：沿用结构时取模板的变量表（按变量上限截断，与 applyStatusBarTemplate 一致，
 * 否则 AI 合并后会把套用时已丢弃的变量又带回来），否则取卡片当前的
 */
function keepBase(sb, template, templateMode, charName, { maxVars = DEFAULT_STATUS_BAR.maxVars, warnings = [] } = {}) {
    if (templateMode === 'structure' && template) {
        if (!isObj(template.spec) && !Array.isArray(template.spec)) throw new Error(`模板「${template.name || template.id || '未命名'}」没有变量表，不能沿用结构`);
        const spec = normalizeStatusSpec(template.spec, { charName, maxVars, warnings });
        if (!spec.variables.length) throw new Error(`模板「${template.name || template.id || '未命名'}」的变量表是空的，不能沿用结构`);
        return spec;
    }
    if (!sb.spec?.variables?.length) throw new Error('还没有变量表：请先让 AI 设计变量，或套用一个模板');
    return sb.spec;
}

/**
 * 用 AI 生成（或部分重新生成）一张卡的状态栏，直接更新 card.statusBar（先 ensureStatusBar）并返回它。
 * @param {object} project
 * @param {object} settings
 * @param {object} card
 * @param {object} [opts]
 * @param {AbortSignal} [opts.signal]
 * @param {string[]} [opts.parts] 'spec' 整体重新设计变量 | 'init' 保留路径只更新初始值 | 'rules' 保留路径只重写 desc/check | 'html' 绑定模式界面。
 *   不传时：沿用结构 → ['init','rules']；只借外观 → 已有变量表时 ['html']，否则 ['spec','html']；其他 → 卡片 mode 为 bind 时 ['spec','html']，auto/raw 时 ['spec']。
 *   含 'spec' 时 init/rules 被忽略（整体设计已包含）。
 * @param {string} [opts.instruction] 额外要求（变量表与界面提示词都会带上）；只重写界面且已有绑定模式界面时，会把当前界面一起发给 AI 在其基础上修改
 * @param {'structure'|'style'|null} [opts.templateMode] 沿用结构 / 只借外观
 * @param {object} [opts.template] 模板对象 {id, name, mode, spec, html, theme}；不传时按 opts.templateId 或 statusBar.templateId 在 settings.statusBarTemplates 里找（内置模板需要调用方传入）
 * @param {string} [opts.requirement] 传入时写进 statusBar.requirement（状态栏要求）
 * @param {Function} [opts.onLog] (message, level) 进度与警告
 * @param {string[]} [opts.warnings] 传入数组时收集规范化/合并/兜底的提示
 * @returns {Promise<object>} card.statusBar
 * 失败（不含用户中止）时设置 statusBar.error 后抛出，变量表与界面保持原样；界面两次都没通过检查时改用内置排版（mode 'auto'），
 * 提示写进 statusBar.error 与 statusBar.lint.warnings。
 */
export async function generateStatusBar(project, settings, card, opts = {}) {
    const { signal, onLog } = opts;
    const instruction = String(opts.instruction || '').trim();
    const warnings = Array.isArray(opts.warnings) ? opts.warnings : [];
    const sb = ensureStatusBar(card, settings);
    if (typeof opts.requirement === 'string') sb.requirement = opts.requirement.trim();
    const templateMode = opts.templateMode === 'structure' || opts.templateMode === 'style' ? opts.templateMode : null;
    const template = templateMode ? resolveTemplate(settings, sb, opts) : null;
    const charName = charNameOf(card);
    const before = snapshot(sb);
    const next = { spec: sb.spec, html: sb.html, mode: sb.mode, theme: sb.theme, templateId: sb.templateId ?? null, maxVars: sb.maxVars ?? null };
    let specChanged = false;
    let initChanged = false;
    let note = '';
    try {
        const want = resolveParts(opts.parts, sb, templateMode);
        if (want.spec || want.init || want.rules) {
            // 沿用结构时的上限与 applyStatusBarTemplate 一致（模板自带更大的上限时用模板的，如「多人群像」的 15），否则会把套用时保留的变量截掉
            const base = want.spec ? null : keepBase(sb, template, templateMode, charName, { maxVars: templateVarCap(template, settings), warnings });
            onLog?.(want.spec ? `🧩 正在设计「${charName}」的状态栏变量…` : `🧩 正在更新「${charName}」状态栏的${want.init && want.rules ? '初始值与规则' : want.init ? '初始值' : '更新规则'}…`);
            next.spec = await runSpecStep(project, settings, card, {
                base, init: want.init, rules: want.rules, allowTitle: templateMode === 'structure', instruction, signal, onLog, warnings,
            });
            // 世界/旁白卡：重新生成了初始值时，把项目里的主要角色补进「主要角色」记录（AI 漏掉的才补，已写的保持原样）
            if (isWorldCard(card) && (want.spec || want.init)) next.spec = seedWorldCast(project, card, next.spec, { warnings, onLog });
            // 卡片自己的变量上限（statusBarVarCap 取它、设置里的上限与当前变量数中最大的）：变量表照模板的结构来时记下模板的上限；
            // 整体重新设计时变量表按设置里的上限生成，不再沿用之前模板的上限；只借外观、只按本卡变量表更新初始值 / 规则时不动它
            if (want.spec) next.maxVars = null;
            else if (template && templateMode === 'structure') next.maxVars = templateVarCap(template, settings);
            specChanged = true;
            initChanged = want.spec || want.init;
        }
        if (template && templateMode === 'structure') {
            if (MODES.includes(template.mode)) next.mode = template.mode;
            if (typeof template.html === 'string') next.html = template.html;
            if (THEMES.includes(template.theme)) next.theme = template.theme;
            if (template.id) next.templateId = template.id;
        } else if (template && templateMode === 'style') {
            if (THEMES.includes(template.theme)) next.theme = template.theme;
            if (template.id) next.templateId = template.id;
        }
        if (want.html) {
            if (signal?.aborted) throw abortError();
            if (!next.spec?.variables?.length) throw new Error('还没有变量表：请先让 AI 设计变量，再生成界面');
            let styleRef = '';
            if (templateMode === 'style' && String(template?.html || '').trim()) styleRef = templateStyleRef(template.html);
            else if (!want.spec && instruction && sb.mode === 'bind' && cleanFragment(sb.html)) styleRef = currentStyleRef(cleanFragment(sb.html));
            onLog?.(`🎨 正在设计「${charName}」的状态栏界面…`);
            let result;
            try {
                result = await runHtmlStep(project, settings, card, { spec: next.spec, sample: initChanged ? null : sb.sample, styleRef, instruction, signal, onLog });
            } catch (e) {
                // 变量表已经生成好时，界面请求失败不连累变量表：改用内置排版，稍后可单独重新生成界面
                if (isAbortError(e) || !specChanged) throw e;
                result = { html: null, errors: [], requestError: errorText(e) };
            }
            if (result.requestError) {
                note = `AI 设计状态栏界面时请求失败（${result.requestError}），已改用内置排版，可稍后在「界面」里重新生成`;
                next.mode = 'auto';
            } else if (result.errors.length) {
                note = `AI 设计的状态栏界面两次都没有通过检查（${result.errors.slice(0, 3).join('；')}），已改用内置排版`
                    + `${before.mode === 'bind' && cleanFragment(before.html) ? '；点「撤销」可恢复之前的界面' : ''}；AI 写的代码保留在「界面」里，修正后可切回 AI 设计`;
                next.mode = 'auto';
                next.html = result.html;
            } else {
                next.html = result.html;
                next.mode = 'bind';
            }
            if (note) {
                warnings.push(note);
                onLog?.(`⚠️ ${note}`, 'warn');
            }
        }
        if (signal?.aborted) throw abortError();
    } catch (e) {
        if (!isAbortError(e)) sb.error = errorText(e);
        throw e;
    }

    const now = Date.now();
    if (hasContent(before)) sb.prev = before;
    sb.spec = next.spec;
    sb.html = typeof next.html === 'string' ? next.html : '';
    sb.mode = MODES.includes(next.mode) ? next.mode : 'bind';
    sb.theme = THEMES.includes(next.theme) ? next.theme : 'clean';
    sb.templateId = next.templateId ?? null;
    sb.maxVars = next.maxVars;
    if (initChanged) {
        sb.sample = null;
        sb.stale = false;
    } else if (specChanged && isObj(sb.sample)) {
        const r = parseStateWithSpec(sb.spec, sb.sample);
        sb.sample = r.ok ? r.data : null;
    }
    if (specChanged && Object.values(sb.overrides || {}).some((x) => typeof x === 'string' && x.trim())) {
        warnings.push('变量结构脚本 / 更新规则 / 初始值里有手动覆盖的内容，它们不会随新的变量表更新（不再与变量表同步）');
    }
    sb.error = note;
    sb.lint = effectiveLint(sb, note);
    sb.generatedAt = now;
    sb.updatedAt = now;
    card.updatedAt = now;
    return sb;
}

/**
 * 写卡流程里用的“不抛错”版本：失败时卡片照常保留，statusBar.error 记下原因。
 * @returns {Promise<{ok: boolean, aborted?: boolean, statusBar: object, warnings: string[], error: Error|null}>}
 *   用户中止时 ok:false、aborted:true，且不写 statusBar.error。
 */
export async function tryGenerateStatusBar(project, settings, card, opts = {}) {
    const warnings = Array.isArray(opts.warnings) ? opts.warnings : [];
    try {
        const statusBar = await generateStatusBar(project, settings, card, { ...opts, warnings });
        return { ok: true, statusBar, warnings, error: null };
    } catch (e) {
        const statusBar = ensureStatusBar(card, settings);
        if (isAbortError(e)) return { ok: false, aborted: true, statusBar, warnings, error: e };
        if (!statusBar.error) statusBar.error = errorText(e);
        return { ok: false, statusBar, warnings, error: e };
    }
}

/**
 * 一步撤销：用 statusBar.prev 换回上一次生成前的 {spec, html, mode, theme, sample, templateId, maxVars}，
 * 当前内容存进 prev（再点一次就是重做）。没有 prev 时返回 false。
 */
export function restoreStatusBarPrev(card) {
    const sb = card?.statusBar;
    if (!isObj(sb?.prev)) return false;
    const cur = snapshot(sb);
    const p = sb.prev;
    sb.spec = isObj(p.spec) && Array.isArray(p.spec.variables) ? clone(p.spec) : { title: '状态栏', variables: [] };
    sb.html = typeof p.html === 'string' ? p.html : '';
    sb.mode = MODES.includes(p.mode) ? p.mode : 'bind';
    sb.theme = THEMES.includes(p.theme) ? p.theme : 'clean';
    sb.sample = isObj(p.sample) ? clone(p.sample) : null;
    sb.templateId = p.templateId ?? null;
    // 卡片自己的变量上限（旧版本存的 prev 没有这一项：保持现在的）
    if ('maxVars' in p) sb.maxVars = p.maxVars ?? null;
    // 套用带立绘的模板时 prev 里还有套用前的立绘（applyStatusBarTemplate）：一起换回来，再点一次又换回去
    if ('portraits' in p) {
        cur.portraits = clone(sb.portraits ?? null);
        sb.portraits = normalizePortraits(p.portraits);
    }
    sb.prev = cur;
    sb.error = '';
    sb.lint = effectiveLint(sb);
    sb.updatedAt = Date.now();
    return true;
}
