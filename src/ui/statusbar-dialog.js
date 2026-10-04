// 状态栏（MVU 变量）编辑对话框：变量 / 规则 / 界面 / 预览 / 导出 五个分页，
// 以及角色卡页用到的几个小件：卡片列表里的「状态栏」标签、写卡后接着生成状态栏、写入酒馆后的提示。
// 纯逻辑都在 statusbar.js / statusbar-runtime.js / statusbar-ai.js / statusbar-templates.js，这里只管界面。

import { errorText } from '../llm.js';
import { statusBarWorldName } from '../publish.js';
import { openCharacterInST, toast } from '../stio.js';
import {
    TYPE_WIDGETS, VAR_TYPES, VAR_TYPE_LABELS, WIDGET_LABELS,
    applyReplyToState, buildInitialState, buildStatusRegexReplace, buildStatusRegexScripts, buildTavernHelper,
    compileInitVar, compileOutputFormat, compileSchemaScript, compileUpdateRules, countSpecLeaves, createStatusBar, ensureStatusBar,
    estimateStatusBarTokens, lintStatusHtml, normalizeFloorCount, normalizeStatusSpec, parseStateWithSpec, setPath,
    splitPath, statusBarActive, statusBarEntries, variableLeafCount,
} from '../statusbar.js';
import { generateStatusBar } from '../statusbar-ai.js';
import { STATUSBAR_THEMES, STATUS_BINDING_GUIDE, buildPreviewSrcdoc, compileStatusDocument, renderDefaultFragment } from '../statusbar-runtime.js';
import {
    STATUS_TEMPLATE_DESC_MAX, STATUS_TEMPLATE_MODE_LABELS, STATUS_TEMPLATE_NAME_MAX, addStatusBarTemplate, applyStatusBarTemplate,
    duplicateStatusBarTemplate, exportStatusBarTemplate, importStatusBarTemplate, listStatusBarTemplates, removeStatusBarTemplate,
    statusBarTemplateFileName, templateFromStatusBar, templatePreviewCard, uniqueStatusBarTemplateName, updateStatusBarTemplate,
} from '../statusbar-templates.js';
import { debounce, downloadFile, estimateTokens, pickFile, safeFileName } from '../utils.js';
import { alertDialog, busy, confirmDialog, emptyState, esc, icon, openDialog, optionList, rerollBtn } from './common.js';

const MIN_JSR = '4.6.0';
const TAILWIND_URL = '/scripts/extensions/third-party/JS-Slash-Runner/lib/tailwindcss.min.js';
const MODE_LABELS = { bind: 'AI 设计', auto: '内置排版', raw: '自定义 HTML' };
const TABS = [['vars', '变量'], ['rules', '规则'], ['ui', '界面'], ['preview', '预览'], ['export', '导出']];
/** 撤销时交换的字段（statusBar.prev 里有哪些就换哪些；套用模板时 prev 还带 overrides） */
const PREV_KEYS = ['spec', 'html', 'mode', 'theme', 'sample', 'templateId', 'overrides'];
const OVERRIDES = [
    ['updateRules', '[mvu_update]变量更新规则'],
    ['initvar', '[initvar]变量初始化勿开（初始值 YAML）'],
    ['schemaScript', '「变量结构」角色脚本（zod）'],
];

// ---------------- 小工具 ----------------

const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function ctxOf(ctx = {}) {
    const a = ctx.app || {};
    return {
        app: a,
        project: ctx.project || a.project,
        settings: ctx.settings || a.settings || {},
        save: ctx.save || (() => a.saveNow?.()),
        saveSettings: ctx.saveSettings || (() => a.saveSettings?.()),
        log: (m, l = 'info') => (typeof a.log === 'function' ? a.log(m, l) : console.log('[NovelLoom]', m)),
        isBusy: () => !!a.isBusy?.(),
        onChange: typeof ctx.onChange === 'function' ? ctx.onChange : () => {},
    };
}

function stContext() {
    try {
        return globalThis.SillyTavern?.getContext?.() || null;
    } catch {
        return null;
    }
}

function userName() {
    return stContext()?.name1 || 'User';
}

async function copyText(text) {
    try {
        await navigator.clipboard.writeText(text);
        return true;
    } catch { /* 局域网 http 不是安全上下文，没有 clipboard，退回 execCommand */ }
    try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', '');
        ta.style.cssText = 'position:fixed;left:-9999px;opacity:0';
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand('copy');
        ta.remove();
        return ok;
    } catch {
        return false;
    }
}

let tailwindText = null;
/** 自定义 HTML 模式的预览要用酒馆助手自带的 tailwind（父页面取到文本后内联进沙箱）；取不到就算了 */
function loadTailwind() {
    if (!tailwindText) {
        tailwindText = fetch(TAILWIND_URL, { cache: 'force-cache' })
            .then((r) => (r.ok ? r.text() : ''))
            .then((t) => (/^\s*</.test(t) ? '' : t)) // 404 时有的服务器回 HTML 页面
            .catch(() => '');
    }
    return tailwindText;
}

function numOrNull(v) {
    if (v === '' || v === null || v === undefined) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
}

function fmtStages(stages) {
    if (typeof stages === 'string') return stages;
    return Array.isArray(stages) ? stages.map((s) => `${s.min} ${s.label}`).join('，') : '';
}

/** 「30 熟悉，60 亲近」/「30:熟悉, 60:亲近」→ [{min, label}] */
function parseStages(text) {
    const out = [];
    for (const part of String(text || '').split(/[,，;；\n]+/)) {
        const m = part.trim().match(/^(-?\d+(?:\.\d+)?)\s*[:：=]?\s*(.+)$/);
        if (m) out.push({ min: Number(m[1]), label: m[2].trim() });
    }
    return out;
}

const fmtOptions = (o) => (Array.isArray(o) ? o.join(' / ') : String(o ?? ''));
const fmtList = (init) => (Array.isArray(init) ? init.join('、') : String(init ?? ''));
const isReadonlyPath = (path) => splitPath(path).some((s) => s.startsWith('_'));

function versionAtLeast(v, min) {
    const a = String(v).split('.').map((n) => parseInt(n, 10) || 0);
    const b = String(min).split('.').map((n) => parseInt(n, 10) || 0);
    for (let i = 0; i < 3; i++) {
        if ((a[i] || 0) > (b[i] || 0)) return true;
        if ((a[i] || 0) < (b[i] || 0)) return false;
    }
    return true;
}

function tavernHelperVersion() {
    try {
        const v = globalThis.TavernHelper?.getTavernHelperVersion?.();
        return typeof v === 'string' ? v : '';
    } catch {
        return '';
    }
}

function avatarFile(card) {
    return card?.stAvatar ? `${String(card.stAvatar).replace(/\.png$/i, '')}.png` : '';
}

/** 本卡（按头像文件）是否已在酒馆的「允许局部正则」名单里 */
export function cardRegexAllowed(card) {
    const list = stContext()?.extensionSettings?.character_allowed_regex;
    const a = avatarFile(card);
    return !!(a && Array.isArray(list) && list.includes(a));
}

export const SAME_CHAR_RELOAD_NOTE = '这张卡就是酒馆里当前打开的角色：酒馆助手还在运行写入之前的旧脚本。测试前请先切换到别的角色再切回来，或者刷新页面。';

/**
 * 这张卡是不是酒馆里当前打开的角色（按头像文件比对 characters[characterId].avatar）。
 * 是的话，酒馆助手（JS-Slash-Runner）还在运行写入前的旧角色脚本，要换个角色再切回来（或刷新页面）才会载入新的。
 */
export function cardOpenInST(card) {
    const c = stContext();
    const a = avatarFile(card);
    const id = c?.characterId;
    if (!a || id === undefined || id === null || id === '') return false;
    return String(c.characters?.[id]?.avatar || '') === a;
}

// ---------------- 变量数 ----------------

/**
 * 变量数（与变量上限比较的口径）：按 countSpecLeaves 计，记录的对象值每个字段各算一个，
 * 和设置页的模板库、AI 生成时的上限一致。「8 / 12 个变量（记录的每个字段各算一个）」
 */
export function varCountText(spec, maxVars = 0) {
    const n = countSpecLeaves(spec);
    const rows = spec?.variables?.length || 0;
    return `${n}${maxVars ? ` / ${maxVars}` : ''} 个变量${n !== rows ? '（记录的每个字段各算一个）' : ''}`;
}

// ---------------- 还没用过的状态栏 ----------------

/** 还没用过的状态栏：没有变量和界面，也从没生成、编辑或套用过模板；它的模式 / 配色 / 聊天选项只是创建时的全局默认 */
export function statusBarPristine(sb) {
    return isObj(sb) && !sb.spec?.variables?.length && !String(sb.html || '').trim()
        && !sb.generatedAt && !sb.updatedAt && !sb.prev && !sb.templateId;
}

/**
 * 没用过的状态栏按当前的全局设置刷新模式、配色和聊天选项：只是打开看过一次「状态栏」不应把当时的默认值固定在卡上
 * （之后在设置里改了默认值，第一次生成时要用新的）。返回是否刷新了。
 */
export function refreshPristineStatusBar(sb, settings) {
    if (!statusBarPristine(sb)) return false;
    const fresh = createStatusBar(settings);
    sb.mode = fresh.mode;
    sb.theme = fresh.theme;
    sb.options = fresh.options;
    return true;
}

// ---------------- 模板名称 ----------------

const tplNameKey = (s) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, STATUS_TEMPLATE_NAME_MAX).toLowerCase();

/**
 * 模板名称的问题（没问题返回 ''）：不能为空、不超过 STATUS_TEMPLATE_NAME_MAX 字、不能与其他模板重名（不分大小写，
 * 和 statusbar-templates.js 的比较方式一样；改名时排除正在改的那个模板 exceptId）
 */
export function templateNameProblem(settings, name, exceptId = null) {
    const n = String(name ?? '').replace(/\s+/g, ' ').trim();
    if (!n) return '请输入模板名称';
    if (n.length > STATUS_TEMPLATE_NAME_MAX) return `名称最多 ${STATUS_TEMPLATE_NAME_MAX} 个字`;
    let list = [];
    try {
        list = listStatusBarTemplates(settings) || [];
    } catch {
        list = [];
    }
    const clash = list.find((t) => t.id !== exceptId && tplNameKey(t.name) === tplNameKey(n));
    return clash ? `已有同名的模板「${clash.name}」，请换一个名字` : '';
}

// ---------------- 套用模板时是否调用 AI ----------------

/**
 * 套用模板对话框里「让 AI 按这张卡调整」的状态。只借外观要由 AI 按这张卡的变量重写界面（卡上还没有变量时先设计变量），
 * 所以必须调用 AI；内置排版的模板借外观、卡上已有变量时只换配色，用不到 AI。
 * @param {object} t 模板
 * @param {boolean} hasVars 卡上是否已有变量
 * @param {'structure'|'look'} mode
 * @returns {{locked: boolean, checked: boolean|null, note: string}} locked 时复选框禁用并固定为 checked；否则由用户决定（checked 为 null）
 */
export function templateAiState(t, hasVars, mode) {
    if (mode !== 'look') return { locked: false, checked: null, note: '' };
    if (t?.mode === 'auto' && hasVars) return { locked: true, checked: false, note: '内置排版的模板只换配色，不需要 AI。' };
    return {
        locked: true,
        checked: true,
        note: hasVars ? '只借外观时，界面要由 AI 按这张卡的变量重写，所以必须调用 AI。' : '这张卡还没有变量：要由 AI 先设计变量，所以必须调用 AI。',
    };
}

// ---------------- 变量表里的范围问题 ----------------

const fmtRange = (min, max) => `${min ?? '不限'} ~ ${max ?? '不限'}`;
const isBlank = (v) => v === undefined || v === null || (typeof v === 'string' && !v.trim());

/** 一个数字（变量 / 记录值 / 字段）的范围与初始值问题；raw 是用户填的，norm 是规范化后实际生效的 */
function numberIssues(raw, norm, { what = '', withInit = true } = {}) {
    const out = [];
    const min = numOrNull(raw?.min);
    const max = numOrNull(raw?.max);
    if (min !== null && max !== null && min > max) out.push(`${what}最小值 ${min} 大于最大值 ${max}：现在按 ${fmtRange(norm.min, norm.max)} 生效，请改正`);
    if (!withInit) return out;
    const init = raw?.init ?? raw?.value ?? raw?.default; // 与 normalizeStatusSpec 取初始值的顺序一致
    const n = numOrNull(init);
    if (isBlank(init)) out.push(`${what}没有填初始值：现在按 ${norm.init} 生效`);
    else if (n === null) out.push(`${what}初始值「${String(init).slice(0, 20)}」不是数字：现在按 ${norm.init} 生效`);
    else if (n !== norm.init) {
        out.push(norm.integer && !Number.isInteger(n) && Math.round(n) === norm.init
            ? `${what}初始值 ${n} 不是整数：现在按 ${norm.init} 生效`
            : `${what}初始值 ${n} 超出范围 ${fmtRange(norm.min, norm.max)}：现在按 ${norm.init} 生效`);
    }
    return out;
}

/**
 * 变量表一行里会被规范化悄悄改掉的数字：最小值大于最大值、初始值超出范围（或不是整数、没填）。
 * 这些行仍然生效（按规范化后的值），但表格里保留用户填的值并在行下提示，而不是直接把输入框里的数字改掉。
 * @param {object} raw 表格里的一行（用户输入）
 * @param {object} norm 这一行规范化后的变量（不合法的行传 null）
 * @returns {string[]}
 */
export function rowRangeWarnings(raw, norm) {
    if (!isObj(raw) || !isObj(norm)) return [];
    let out = [];
    if (norm.type === 'number') out = numberIssues(raw, norm);
    else if (norm.type === 'record' && isObj(norm.value)) {
        const rv = isObj(raw.value) ? raw.value : {};
        const val = norm.value;
        if (val.type === 'number') out.push(...numberIssues(rv, val, { what: '值的', withInit: false }));
        const fields = val.type === 'object' && Array.isArray(rv.fields) ? rv.fields : [];
        for (const f of fields) {
            const key = String(f?.key ?? f?.name ?? '').trim();
            const nf = val.fields?.find((x) => x.key === key);
            if (!isObj(f) || nf?.type !== 'number') continue;
            out.push(...numberIssues(f, nf, { what: `字段「${key}」的`, withInit: (f.init ?? f.value ?? f.default) !== undefined }));
        }
        const init = isObj(raw.init) ? raw.init : {};
        for (const [k, item] of Object.entries(init)) {
            const got = norm.init?.[k];
            if (got === undefined) continue;
            if (val.type === 'number') {
                const n = numOrNull(item);
                if (n !== null && n !== got) out.push(`初始条目「${k}」的值 ${n} 超出范围 ${fmtRange(val.min, val.max)}：现在按 ${got} 生效`);
            } else if (val.type === 'object' && isObj(item) && isObj(got)) {
                for (const nf of val.fields || []) {
                    if (nf.type !== 'number') continue;
                    const n = numOrNull(item[nf.key]);
                    if (n !== null && n !== got[nf.key]) out.push(`初始条目「${k}」的「${nf.key}」${n} 超出范围 ${fmtRange(nf.min, nf.max)}：现在按 ${got[nf.key]} 生效`);
                }
            }
        }
    }
    return out.length > 6 ? [...out.slice(0, 6), `……另有 ${out.length - 6} 处同类问题`] : out;
}

/** 规范化给出的、与上面重复的范围 / 初始值提示（有 rowRangeWarnings 时不再重复显示） */
const RANGE_WARN_RE = /最小值|最大值|范围|超出|初始值/;

/** 去重并去掉空的提示；exclude 里的（例如已经显示在出错提示条里的）不再重复 */
function uniqWarnings(list, exclude = []) {
    const skip = new Set(exclude.filter(Boolean));
    const out = [];
    for (const w of list || []) {
        const s = String(w ?? '').trim();
        if (s && !skip.has(s) && !out.includes(s)) out.push(s);
    }
    return out;
}

/**
 * 「允许本卡正则」：征得同意后把头像文件加进 extension_settings.character_allowed_regex
 * （与酒馆首次打开角色时弹窗里点「允许」效果相同，见 regex/engine.js allowScopedScripts）
 */
async function allowCardRegexWithConsent(card) {
    const c = stContext();
    const a = avatarFile(card);
    if (!c?.extensionSettings || !a) {
        await alertDialog('需要先把这张卡写入酒馆，才能允许它的局部正则。', '还不能允许');
        return false;
    }
    const ok = await confirmDialog(
        `允许角色「${card.data?.name || a}」（${a}）的局部正则？\n\n和酒馆第一次打开这个角色时弹窗里点「允许」效果一样：本卡自带的正则（显示状态栏、发送给 AI 前去掉变量更新块、折叠更新块）会开始生效。如果正在和这个角色聊天，重新打开聊天后生效；以后可以在酒馆的「正则」扩展里关掉。`,
        { title: '允许本卡正则', okLabel: '允许' },
    );
    if (!ok) return false;
    const es = c.extensionSettings;
    if (!Array.isArray(es.character_allowed_regex)) es.character_allowed_regex = [];
    if (!es.character_allowed_regex.includes(a)) es.character_allowed_regex.push(a);
    try {
        c.saveSettingsDebounced?.();
    } catch (e) {
        console.warn('[NovelLoom] 保存酒馆设置失败', e);
    }
    return true;
}

/** 环境检查：酒馆助手版本、本卡正则是否已允许、当前接口 */
function envChecks(card) {
    const out = [];
    const ver = tavernHelperVersion();
    if (!ver) out.push({ level: 'warn', text: `没有检测到酒馆助手（JS-Slash-Runner）：状态栏和 MVU 都靠它运行，需要 ${MIN_JSR} 或更高版本` });
    else if (!versionAtLeast(ver, MIN_JSR)) out.push({ level: 'err', text: `酒馆助手版本 ${ver} 太旧，读不了本卡的脚本，需要 ${MIN_JSR} 或更高版本` });
    else out.push({ level: 'ok', text: `酒馆助手 ${ver}` });
    if (!card.stAvatar) out.push({ level: 'info', text: '还没写入酒馆：写入后可以在这里允许本卡的局部正则' });
    else if (cardRegexAllowed(card)) out.push({ level: 'ok', text: '已允许本卡的局部正则' });
    else out.push({ level: 'warn', text: '还没允许本卡的局部正则（第一次在酒馆打开这个角色时会询问）', allow: true });
    const api = stContext()?.mainApi;
    if (api && api !== 'openai') out.push({ level: 'warn', text: '当前接口不是聊天补全（Chat Completion），MVU 状态栏需要聊天补全' });
    return out;
}

function checkLine(c) {
    const ico = c.level === 'ok' ? icon('check', { size: 14 }) : c.level === 'info' ? icon('info', { size: 14 }) : icon('alert', { size: 14 });
    const cls = c.level === 'ok' ? 'nl-ok' : c.level === 'err' ? 'nl-err' : c.level === 'warn' ? 'nl-warn' : 'nl-muted';
    const btn = c.allow ? ' <button class="nl-btn nl-sm" data-act="sb-allow-regex">允许本卡正则</button>' : '';
    return `<div class="nl-sb-check"><span class="${cls}">${ico}</span><span class="nl-grow">${esc(c.text)}</span>${btn}</div>`;
}

/**
 * 重新检查状态栏界面并记到 statusBar.lint（卡片列表的警告色、导出前的提示都看它）。
 * 绑定/自定义模式跑 lintStatusHtml；没有错误时再模拟一次酒馆正则替换（与导出同一检查）。
 */
export function refreshStatusBarLint(card) {
    const sb = card.statusBar;
    if (!sb) return { errors: [], warnings: [] };
    let res = { errors: [], warnings: [] };
    if (sb.mode === 'bind' || sb.mode === 'raw') res = lintStatusHtml(sb.html, { mode: sb.mode, spec: sb.spec });
    if (!res.errors.length && sb.spec?.variables?.length) {
        try {
            buildStatusRegexReplace(compileStatusDocument(card));
        } catch (e) {
            res = { ...res, errors: [...res.errors, e.message] };
        }
    }
    sb.lint = { errors: [...res.errors], warnings: [...res.warnings] };
    return sb.lint;
}

/** 卡片列表里的「状态栏」标签：过时（整卡重新生成过）、界面有错误、上次生成出错时用警告色 */
export function statusBarTagHtml(card) {
    const sb = card?.statusBar;
    if (!sb) return '';
    const n = sb.spec?.variables?.length || 0;
    if (!n) return sb.error ? `<span class="nl-tag nl-err" title="${esc(`生成状态栏出错：${sb.error}`)}">${icon('alert', { size: 12 })}状态栏未生成</span>` : '';
    if (!sb.enabled) return '<span class="nl-tag" title="状态栏已关闭，导出时不带">状态栏（关）</span>';
    const issues = [];
    if (sb.stale) issues.push('整卡重新生成过，变量初始值可能过时');
    if (sb.lint?.errors?.length) issues.push(`界面有 ${sb.lint.errors.length} 个问题，导出会被阻止`);
    if (sb.error) issues.push(`上次生成出错：${sb.error}`);
    const title = issues.length ? issues.join('；') : `带 MVU 变量状态栏：${varCountText(sb.spec)}`;
    return `<span class="nl-tag ${issues.length ? 'nl-warn' : ''}" title="${esc(title)}">${issues.length ? icon('alert', { size: 12 }) : ''}状态栏</span>`;
}

/** 写卡用的模板下拉选项：自动 + 内置 + 保存的 */
export function statusBarTemplateOptions(settings) {
    let list = [];
    try {
        list = listStatusBarTemplates(settings) || [];
    } catch (e) {
        console.warn('[NovelLoom] 读取状态栏模板失败', e);
    }
    return [{ value: '', label: '自动（AI 按角色设计）' }, ...list.map((t) => ({ value: t.id, label: t.builtin ? `${t.name}（内置）` : t.name }))];
}

/** 默认要让 AI 生成哪些部分：内置排版 / 自定义 HTML 不需要 AI 写界面 */
function defaultParts(sb) {
    return sb.mode === 'bind' ? ['spec', 'html'] : ['spec'];
}

function findTemplate(settings, id) {
    if (!id) return null;
    try {
        return (listStatusBarTemplates(settings) || []).find((t) => t.id === id) || null;
    } catch {
        return null;
    }
}

/** 状态栏实际效果的指纹（变量表、手写覆盖、组装好的界面文档）：用来判断套用模板后到底有没有变化 */
function statusBarFingerprint(card) {
    const sb = card?.statusBar;
    if (!isObj(sb)) return '';
    let doc = '';
    try {
        doc = compileStatusDocument(card);
    } catch {
        doc = JSON.stringify([sb.mode, sb.html, sb.theme]);
    }
    return JSON.stringify({ spec: sb.spec, overrides: sb.overrides, doc });
}

/**
 * 套用模板并（需要时）让 AI 按这张卡调整。applyStatusBarTemplate 会把套用前的状态存进 statusBar.prev，
 * AI 生成又会覆盖 prev，所以结束后把 prev 改回套用前，「撤销」一步回到套用模板之前。
 * 卡上还没有变量时（只借外观）先由 AI 设计变量：模板有界面时接着参照它写界面，内置排版的模板只设计变量。
 * @param {'structure'|'look'} mode 沿用结构 / 只借外观
 * @param {{ai?: boolean, instruction?: string, warnings?: string[]}} opt warnings：传入数组时收集套用和 AI 生成时的提示
 *   （模板变量表规范化、AI 结果合并、界面兜底等，含超出范围 / 最小值大于最大值之类的修正）
 * @returns {Promise<{warnings: string[], changed: boolean, ai: boolean}>} changed：状态栏的实际效果是否有变化；ai：是否调用了 AI
 */
export async function applyTemplateToCard(card, c, template, mode, { ai = true, instruction = '', warnings = [] } = {}) {
    const before = statusBarFingerprint(card);
    const res = applyStatusBarTemplate(card, template, mode, { settings: c.settings });
    warnings.push(...(res.warnings || []));
    const sb = card.statusBar;
    const undoTo = sb.prev;
    let next = res.ai ? { ...res.ai } : null;
    if (!sb.spec.variables.length) next = next ? { ...next, parts: ['spec', 'html'] } : { parts: ['spec'] };
    let ran = false;
    if (ai && next) {
        try {
            await generateStatusBar(c.project, c.settings, card, { ...next, template, instruction, onLog: c.log, warnings });
            ran = true;
        } finally {
            sb.prev = undoTo;
        }
    }
    return { warnings, changed: statusBarFingerprint(card) !== before, ai: ran };
}

/** 把生成 / 套用时收集的提示逐条记进日志（warn）；exclude 里的（已经单独提示过的）跳过。返回去重后的列表 */
function logWarnings(c, warnings, exclude = []) {
    const list = uniqWarnings(warnings, exclude);
    for (const w of list) c.log(`⚠️ 状态栏：${w}`, 'warn');
    return list;
}

/**
 * 写卡流程里接着生成状态栏（在写卡的同一个 busy 里调用）。失败不抛出：错误记到 statusBar.error 并提示，卡片照常保留。
 * 选了模板时：模板有变量表就「沿用结构」（AI 只按这张卡填初始值和规则），只有界面就「只借外观」。
 * @param {object} card 刚生成的角色卡
 * @param {object} ctx { app, project, settings }
 * @param {{requirement?: string, templateId?: string}} opt
 * @returns {Promise<boolean>} 是否成功
 */
export async function generateStatusBarForCard(card, ctx, { requirement = '', templateId = '' } = {}) {
    const c = ctxOf(ctx);
    const sb = ensureStatusBar(card, c.settings);
    refreshPristineStatusBar(sb, c.settings);
    sb.requirement = String(requirement || '').trim();
    const warnings = [];
    try {
        const tpl = findTemplate(c.settings, templateId);
        if (tpl) {
            await applyTemplateToCard(card, c, tpl, tpl.spec?.variables?.length ? 'structure' : 'look', { warnings });
            if (!sb.spec.variables.length) await generateStatusBar(c.project, c.settings, card, { parts: ['spec'], onLog: c.log, warnings });
        } else {
            await generateStatusBar(c.project, c.settings, card, { parts: defaultParts(sb), onLog: c.log, warnings });
        }
        refreshStatusBarLint(card);
        logWarnings(c, warnings, [sb.error]); // 界面兜底的提示 generateStatusBar 已经记过一次（也在 statusBar.error 里）
        c.log(`已为「${card.data.name}」生成状态栏：${varCountText(sb.spec)}`, 'success');
        return true;
    } catch (e) {
        if (e?.name === 'AbortError') throw e;
        sb.error = errorText(e);
        c.log(`「${card.data.name}」的状态栏没生成出来：${sb.error}（角色卡已保存，可以稍后在「状态栏」里重试）`, 'error');
        toast('warning', `角色卡已保存，但状态栏没生成出来：${sb.error}`);
        return false;
    }
}

// ---------------- 写入酒馆后的提示 ----------------

/**
 * 写入一张带状态栏的卡后弹出的说明（SPEC §3.4）：导入内嵌世界书、允许本卡正则（可一键、需确认）、
 * 允许酒馆助手脚本、使用聊天补全；勾选「这张卡不再提示」后记在 statusBar.hideHint。
 */
/** 写入酒馆后提示框的正文（底部按钮由 openDialog 提供）；这张卡正是酒馆里当前打开的角色时，最上面提示先换个角色再切回来 */
export function statusBarPublishHintHtml(card, world = '') {
    const allowed = cardRegexAllowed(card);
    const jsr = envChecks(card).filter((x) => !x.allow && x.level !== 'ok' && x.level !== 'info');
    const reopen = cardOpenInST(card);
    return `
        ${reopen ? `<div class="nl-sb-note nl-sb-note-warn" data-sb-reopen role="alert">${icon('alert')}<div class="nl-grow">${esc(SAME_CHAR_RELOAD_NOTE)}</div></div>` : ''}
        <div class="nl-card-desc">「${esc(card.data?.name || '')}」带 MVU 变量状态栏。第一次在酒馆里用之前，请确认下面几件事：</div>
        <ol class="nl-sb-steps">
            <li>${reopen ? '先切换到别的角色，再切回这个角色（或者刷新页面）' : '在酒馆打开这个角色'}。如果弹出「导入内嵌世界书」，选<b>是</b>：变量的初始值和更新规则在世界书「${esc(world)}」里（NovelLoom 已经替你绑定好了）。</li>
            <li>允许本卡的局部正则（酒馆第一次打开时会询问）。
                ${allowed ? `<span class="nl-ok nl-small">${icon('check', { size: 14 })} 已允许</span>` : '<button class="nl-btn nl-sm" data-act="sb-allow-regex">允许本卡正则</button>'}</li>
            <li>允许酒馆助手运行本卡的脚本（第一次打开时同样会询问）；拒绝过的话，到 酒馆助手 → 脚本库 → 角色脚本 里启用。</li>
            <li>使用聊天补全（Chat Completion）接口。</li>
        </ol>
        ${jsr.map(checkLine).join('')}
        <div class="nl-muted nl-small">以后用「更新到酒馆」覆盖同一个角色时，这两项授权都会保留（酒馆按头像文件记录）。</div>
        <label class="nl-sb-hint-hide"><input type="checkbox" data-sb-hide-hint> 这张卡不再提示</label>`;
}

export async function openStatusBarPublishHint(card, ctx = {}) {
    const c = ctxOf(ctx);
    const sb = card.statusBar;
    if (!sb) return;
    // 写入的正是酒馆里当前打开的角色：酒馆助手不会自己重新载入角色脚本。即使勾过「不再提示」也要在日志里说一声
    if (cardOpenInST(card)) c.log(`「${card.data?.name || ''}」：${SAME_CHAR_RELOAD_NOTE}`, 'warn');
    if (sb.hideHint) return;
    const world = sb.worldName || (c.project ? statusBarWorldName(c.project, c.settings, card) : '');
    const box = document.createElement('div');
    const render = () => {
        const hide = !!box.querySelector('[data-sb-hide-hint]')?.checked;
        box.innerHTML = statusBarPublishHintHtml(card, world);
        if (hide) box.querySelector('[data-sb-hide-hint]').checked = true;
    };
    render();
    box.addEventListener('click', async (e) => {
        if (!e.target.closest('[data-act="sb-allow-regex"]')) return;
        if (await allowCardRegexWithConsent(card)) render();
    });
    let body = null;
    const pending = openDialog({
        title: '状态栏卡：在酒馆里使用前',
        body: box,
        buttons: [{ label: '在酒馆打开', value: 'open' }, { label: '知道了', value: 'ok', primary: true }],
        onMount: (r) => {
            body = r;
        },
    });
    // openDialog 会把焦点放在第一个输入控件（「这张卡不再提示」）上；这里是说明框，焦点应在「知道了」，回车直接关掉
    body?.closest('.nl-dialog')?.querySelector('.nl-dialog-foot .nl-primary')?.focus();
    const { value, root } = await pending;
    if (root.querySelector('[data-sb-hide-hint]')?.checked) {
        sb.hideHint = true;
        await c.save();
    }
    if (value === 'open') {
        try {
            await openCharacterInST(card.stAvatar);
        } catch (err) {
            c.log(err.message, 'error');
        }
    }
}

/**
 * 状态栏对话框的分页条：和其他分段按钮一样是 aria-pressed 的按钮组（切换的是下面同一块面板的内容，
 * 不是 ARIA tabs，所以不带 role=tab / tablist）。badges：{分页键: 追加在名字后的 HTML（调用方转义）}
 */
export function statusTabsHtml(active, badges = {}) {
    return `<div class="nl-seg nl-sb-tabs" role="group" aria-label="状态栏设置分页">${TABS.map(([k, l]) => `<button class="nl-seg-btn ${active === k ? 'active' : ''}" aria-pressed="${active === k}" data-act="sb-tab" data-tab="${k}">${l}${badges[k] || ''}</button>`).join('')}</div>`;
}

// ---------------- 小对话框 ----------------

/** AI 生成前的确认：可选的状态栏要求、额外要求、是否同时重写界面 */
async function aiDialog({ title, intro = '', requirement = null, withHtml = null, okLabel = '生成' }) {
    const { value, root } = await openDialog({
        title,
        body: `
            ${intro ? `<div class="nl-card-desc">${esc(intro)}</div>` : ''}
            ${requirement !== null ? `<div class="nl-field"><label>状态栏要求（会保存在这张卡上，以后重新生成也会用）</label><textarea class="nl-input nl-textarea" rows="2" data-f="requirement" placeholder="例如：重点记录好感和体力；记录随身物品">${esc(requirement)}</textarea></div>` : ''}
            <div class="nl-field"><label>这次的额外要求（可选，留空则让 AI 自行发挥）</label><textarea class="nl-input nl-textarea" rows="3" data-f="instruction"></textarea></div>
            ${withHtml !== null ? `<label><input type="checkbox" data-f="html" ${withHtml ? 'checked' : ''}> 同时重写界面（变量变了，旧界面可能对不上）</label>` : ''}`,
        buttons: [{ label: '取消', value: null }, { label: okLabel, value: 'ok', primary: true }],
    });
    if (value !== 'ok') return null;
    return {
        requirement: root.querySelector('[data-f="requirement"]')?.value.trim() ?? null,
        instruction: root.querySelector('[data-f="instruction"]').value.trim(),
        html: !!root.querySelector('[data-f="html"]')?.checked,
    };
}

/**
 * 模板名称 + 说明。名称在框里就地检查（不能为空、不能与其他模板重名，不分大小写；改名时排除 exceptId 自己），
 * 有问题时提示并保持对话框打开。
 */
async function nameDescDialog({ title, name = '', desc = '', settings = null, exceptId = null }) {
    const check = (r) => {
        const input = r.querySelector('[data-f="name"]');
        const msg = templateNameProblem(settings, input.value, exceptId);
        const err = r.querySelector('[data-sb-name-err]');
        err.textContent = msg;
        err.hidden = !msg;
        input.setAttribute('aria-invalid', msg ? 'true' : 'false');
        if (msg) input.focus();
        return !msg;
    };
    const { value, root } = await openDialog({
        title,
        body: `
            <div class="nl-field"><label>名称</label><input class="nl-input" data-f="name" maxlength="${STATUS_TEMPLATE_NAME_MAX}" value="${esc(name)}" aria-label="模板名称" aria-describedby="nl-sb-name-err"></div>
            <div class="nl-small nl-err" id="nl-sb-name-err" data-sb-name-err role="alert" hidden></div>
            <div class="nl-field"><label>说明（可选）</label><input class="nl-input" data-f="desc" maxlength="${STATUS_TEMPLATE_DESC_MAX}" value="${esc(desc)}" placeholder="例如：好感 + 心情 + 着装，浅色卡片" aria-label="模板说明"></div>`,
        buttons: [{ label: '取消', value: null }, { label: '保存', value: 'ok', primary: true, validate: check }],
        onMount: (r) => {
            // 改了名字就收起上一次的提示（再点保存时重新检查）
            r.querySelector('[data-f="name"]').addEventListener('input', () => {
                const err = r.querySelector('[data-sb-name-err]');
                if (!err.hidden) {
                    err.hidden = true;
                    r.querySelector('[data-f="name"]').setAttribute('aria-invalid', 'false');
                }
            });
        },
    });
    if (value !== 'ok') return null;
    return { name: root.querySelector('[data-f="name"]').value.replace(/\s+/g, ' ').trim(), desc: root.querySelector('[data-f="desc"]').value.trim() };
}

/** 套用模板：沿用结构 / 只借外观，以及是否让 AI 按这张卡调整（只借外观时必须调用 AI，见 templateAiState） */
async function applyModeDialog(t, hasVars, maxVars) {
    const canStructure = !!t.spec?.variables?.length;
    const n = canStructure ? countSpecLeaves(t.spec) : 0;
    const over = n > maxVars ? `模板有 ${varCountText(t.spec)}，超过上限 ${maxVars}：多出的变量会被丢弃。` : '';
    const lookNote = t.mode === 'auto'
        ? hasVars ? '保留这张卡的变量表，改用内置排版和模板的配色（不需要 AI）。' : '这张卡还没有变量：AI 会先设计变量，再用内置排版和模板的配色显示。'
        : hasVars ? '保留这张卡的变量表，让 AI 参照模板的界面风格重写界面。' : '这张卡还没有变量：AI 会先设计变量，再参照模板的界面风格写界面。';
    let userAi = true; // 用户自己在「沿用结构」下的选择：切到只借外观再切回来时还原
    const sync = (root) => {
        const mode = root.querySelector('input[name="nl-sb-tpl-mode"]:checked')?.value || 'look';
        const s = templateAiState(t, hasVars, mode);
        const cb = root.querySelector('[data-f="ai"]');
        const note = root.querySelector('[data-sb-ai-note]');
        cb.disabled = s.locked;
        cb.checked = s.locked ? s.checked : userAi;
        note.textContent = s.note;
        note.hidden = !s.note;
    };
    const { value, root } = await openDialog({
        title: `套用模板「${t.name}」`,
        body: `
            <label class="nl-sb-choice"><input type="radio" name="nl-sb-tpl-mode" value="structure" ${canStructure ? 'checked' : 'disabled'}>
                <span><b>沿用结构</b><span class="nl-muted nl-small">${canStructure ? '变量表和界面都照搬模板（替换这张卡现有的状态栏和手写覆盖），再让 AI 按这张卡填写初始值和检查规则。' : '这个模板只有界面、没有变量表，不能沿用结构。'}</span>${over ? `<span class="nl-warn nl-small">${esc(over)}</span>` : ''}</span></label>
            <label class="nl-sb-choice"><input type="radio" name="nl-sb-tpl-mode" value="look" ${canStructure ? '' : 'checked'}>
                <span><b>只借外观</b><span class="nl-muted nl-small">${esc(lookNote)}</span></span></label>
            <label><input type="checkbox" data-f="ai" checked> 套用后让 AI 按这张卡调整（会调用 AI；不勾选则只复制模板）</label>
            <div class="nl-muted nl-small" data-sb-ai-note hidden></div>`,
        buttons: [{ label: '取消', value: null }, { label: '套用', value: 'ok', primary: true }],
        onMount: (r) => {
            r.addEventListener('change', (e) => {
                if (e.target.matches('[data-f="ai"]') && !e.target.disabled) userAi = e.target.checked;
                else if (e.target.name === 'nl-sb-tpl-mode') sync(r);
            });
            sync(r);
        },
    });
    if (value !== 'ok') return null;
    const mode = root.querySelector('input[name="nl-sb-tpl-mode"]:checked')?.value || 'look';
    const s = templateAiState(t, hasVars, mode);
    return { mode, ai: s.locked ? s.checked : !!root.querySelector('[data-f="ai"]')?.checked };
}

/** 单独看一眼某个状态栏（模板预览用）：沙箱 iframe，高度跟随内容 */
async function previewOnlyDialog(card, sample, title) {
    const box = document.createElement('div');
    box.innerHTML = `
        <div class="nl-sb-stage is-dark"><div class="nl-sb-frame-wrap" style="width:720px">
            <iframe class="nl-sb-frame" sandbox="allow-scripts" referrerpolicy="no-referrer" title="状态栏预览"></iframe>
        </div></div>
        <div class="nl-muted nl-small" style="margin-top:8px">用模板自带的示例数据显示；套用后会换成这张卡自己的变量。</div>`;
    const frame = box.querySelector('iframe');
    const onMsg = (e) => {
        if (e.source !== frame.contentWindow || e.data?.source !== 'nl-preview' || e.data.type !== 'nl-height') return;
        frame.style.height = `${Math.max(40, Math.min(4000, Number(e.data.height) || 0))}px`;
    };
    window.addEventListener('message', onMsg);
    const tailwind = card.statusBar?.mode === 'raw' ? await loadTailwind() : '';
    frame.srcdoc = buildPreviewSrcdoc(card, sample, { user: userName(), char: card.data?.name, tailwind });
    try {
        await openDialog({ title, wide: true, body: box, buttons: [{ label: '关闭', value: null }] });
    } finally {
        window.removeEventListener('message', onMsg);
    }
}

/** 模板库：列出内置与保存的模板；返回要套用的 {template, mode, ai}（或 null）。变量数按 countSpecLeaves 计，和上限 maxVars 比较 */
async function templateLibraryDialog(c, hasVars, charName = '', maxVars = 12) {
    const box = document.createElement('div');
    let list = [];
    const render = () => {
        try {
            list = listStatusBarTemplates(c.settings) || [];
        } catch (e) {
            list = [];
            c.log(`读取状态栏模板失败：${errorText(e)}`, 'error');
        }
        box.innerHTML = `
            <div class="nl-card-desc">模板保存变量表和界面，存在扩展设置里，所有项目共用。内置模板不能修改或删除，可以先复制成自己的模板。也可以导入别人分享的模板文件，或者带状态栏的角色卡 JSON。</div>
            <div class="nl-row"><button class="nl-btn nl-sm" data-act="tpl-import">${icon('upload', { size: 14 })}导入模板 / 角色卡 JSON</button></div>
            <div class="nl-list">${list.map((t) => {
        const n = t.spec ? countSpecLeaves(t.spec) : 0;
        const over = n > maxVars ? ` <span class="nl-tag nl-warn" title="沿用结构时多出的变量会被丢弃">超过上限 ${maxVars}</span>` : '';
        return `
                <div class="nl-list-item" data-tpl-id="${esc(t.id)}">
                    <div class="nl-grow">
                        <div><b>${esc(t.name)}</b> ${t.builtin ? '<span class="nl-tag">内置</span>' : ''} <span class="nl-muted nl-small">${n ? esc(varCountText(t.spec)) : '只有界面'} · ${esc(STATUS_TEMPLATE_MODE_LABELS[t.mode] || t.mode || '')}</span>${over}</div>
                        ${t.desc ? `<div class="nl-small nl-muted">${esc(t.desc)}</div>` : ''}
                    </div>
                    <button class="nl-icon-btn" data-act="tpl-preview" title="预览" aria-label="预览">${icon('eye')}</button>
                    <button class="nl-icon-btn" data-act="tpl-dup" title="复制成我的模板" aria-label="复制成我的模板">${icon('copy')}</button>
                    <button class="nl-icon-btn" data-act="tpl-export" title="导出 JSON" aria-label="导出 JSON">${icon('download')}</button>
                    ${t.builtin ? '' : `<button class="nl-icon-btn" data-act="tpl-rename" title="改名 / 改说明" aria-label="改名 / 改说明">${icon('edit')}</button>
                    <button class="nl-icon-btn nl-danger" data-act="tpl-del" title="删除" aria-label="删除">${icon('trash')}</button>`}
                    <button class="nl-btn nl-sm" data-act="tpl-apply">套用</button>
                </div>`;
    }).join('') || emptyState('还没有模板。在状态栏对话框里点「存为模板」，或者导入别人分享的模板 JSON。', '', { title: '没有模板', ico: 'file' })}</div>`;
    };
    render();
    const { value } = await openDialog({
        title: '状态栏模板库',
        wide: true,
        body: box,
        buttons: [{ label: '关闭', value: null }],
        onMount: (root, close) => {
            root.addEventListener('click', async (e) => {
                const btn = e.target.closest('[data-act]');
                if (!btn) return;
                const t = list.find((x) => x.id === btn.closest('[data-tpl-id]')?.dataset.tplId);
                try {
                    switch (btn.dataset.act) {
                        case 'tpl-import': {
                            const file = await pickFile('.json,application/json');
                            if (!file) return;
                            let json;
                            try {
                                json = JSON.parse(await file.text());
                            } catch {
                                throw new Error('文件不是合法的 JSON');
                            }
                            const saved = importStatusBarTemplate(c.settings, json); // 重名时自动改名
                            c.saveSettings();
                            c.log(`已导入状态栏模板「${saved?.name || ''}」`, 'success');
                            render();
                            return;
                        }
                        case 'tpl-preview': {
                            if (!t) return;
                            const pc = templatePreviewCard(t, { charName });
                            await previewOnlyDialog(pc, t.sample || null, `模板预览：${t.name}`);
                            return;
                        }
                        case 'tpl-dup': {
                            if (!t) return;
                            const copy = duplicateStatusBarTemplate(c.settings, t.id);
                            c.saveSettings();
                            c.log(`已复制成模板「${copy?.name || ''}」`, 'success');
                            render();
                            return;
                        }
                        case 'tpl-apply': {
                            if (!t) return;
                            const choice = await applyModeDialog(t, hasVars, maxVars);
                            if (choice) close({ template: t, ...choice });
                            return;
                        }
                        case 'tpl-export': {
                            if (!t) return;
                            downloadFile(JSON.stringify(exportStatusBarTemplate(t), null, 2), statusBarTemplateFileName(t));
                            return;
                        }
                        case 'tpl-rename': {
                            if (!t) return;
                            const r = await nameDescDialog({ title: '修改模板', name: t.name, desc: t.desc || '', settings: c.settings, exceptId: t.id });
                            if (!r) return;
                            updateStatusBarTemplate(c.settings, t.id, r);
                            c.saveSettings();
                            render();
                            return;
                        }
                        case 'tpl-del': {
                            if (!t) return;
                            if (!(await confirmDialog(`删除状态栏模板「${t.name}」？`, { danger: true, okLabel: '删除' }))) return;
                            removeStatusBarTemplate(c.settings, t.id);
                            c.saveSettings();
                            render();
                            return;
                        }
                        default:
                            return;
                    }
                } catch (err) {
                    await alertDialog(errorText(err), '出错了');
                }
            });
        },
    });
    return value || null;
}

// ---------------- 预览用的示例数据 ----------------

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

function randomRecordItem(val) {
    if (val?.type === 'number') {
        const lo = val.min ?? 0;
        const hi = val.max ?? lo + 100;
        return Math.round(lo + Math.random() * (hi - lo));
    }
    if (val?.type === 'object') {
        const o = {};
        for (const f of val.fields || []) {
            if (f.type === 'number') o[f.key] = Math.round((f.min ?? 0) + Math.random() * ((f.max ?? (f.min ?? 0) + 100) - (f.min ?? 0)));
            else if (f.type === 'enum') o[f.key] = pick(f.options);
            else if (f.type === 'boolean') o[f.key] = Math.random() < 0.5;
            else o[f.key] = f.init || '示例';
        }
        return o;
    }
    return '示例';
}

/** 随机示例值：数字在范围内随机、选项随机挑、是/否随机；文本保留初始值 */
function randomSample(spec) {
    const out = buildInitialState(spec);
    for (const v of spec?.variables || []) {
        let val;
        switch (v.type) {
            case 'number': {
                const lo = v.min ?? 0;
                const hi = v.max ?? lo + 100;
                const x = lo + Math.random() * (hi - lo);
                val = v.integer ? Math.round(x) : Math.round(x * 10) / 10;
                break;
            }
            case 'enum':
                val = pick(v.options);
                break;
            case 'boolean':
                val = Math.random() < 0.5;
                break;
            case 'list':
                val = v.init?.length ? v.init.slice().sort(() => Math.random() - 0.5) : ['示例一', '示例二'].slice(0, 1 + Math.floor(Math.random() * 2));
                break;
            case 'record': {
                const keys = Object.keys(v.init || {});
                val = keys.length ? Object.fromEntries(keys.map((k) => [k, randomRecordItem(v.value)])) : { 示例: randomRecordItem(v.value) };
                break;
            }
            default:
                val = v.init || '示例文本';
        }
        setPath(out, v.path, val);
    }
    const r = parseStateWithSpec(spec, out);
    return r.ok ? r.data : out;
}

/** 「填入示例回复」：按变量表拼一条带 <UpdateVariable> 的假回复，演示模拟更新 */
function exampleReply(spec) {
    const ops = [];
    const done = new Set();
    for (const v of spec?.variables || []) {
        if (isReadonlyPath(v.path) || done.has(v.type)) continue;
        const p = `/${splitPath(v.path).join('/')}`;
        if (v.type === 'number') ops.push({ op: 'delta', path: p, value: 5 });
        else if (v.type === 'enum' && v.options.length > 1) ops.push({ op: 'replace', path: p, value: v.options.find((o) => o !== v.init) });
        else if (v.type === 'boolean') ops.push({ op: 'replace', path: p, value: !v.init });
        else if (v.type === 'list') ops.push({ op: 'insert', path: `${p}/-`, value: '新的一项' });
        else if (v.type === 'string') ops.push({ op: 'replace', path: p, value: '示例更新' });
        else if (v.type === 'record') ops.push({ op: 'insert', path: `${p}/新条目`, value: randomRecordItem(v.value) });
        else continue;
        done.add(v.type);
        if (ops.length >= 4) break;
    }
    return [
        '（正文）……',
        '',
        '<UpdateVariable>',
        '<Analysis>example: a few variables changed in this reply</Analysis>',
        '<JSONPatch>',
        JSON.stringify(ops, null, 2),
        '</JSONPatch>',
        '</UpdateVariable>',
    ].join('\n');
}

// ---------------- 变量表编辑 ----------------

function resetType(v, type) {
    const keep = { path: v.path, label: v.label, desc: v.desc, check: v.check };
    for (const k of Object.keys(v)) delete v[k];
    Object.assign(v, keep, { type });
    if (v.desc === undefined) delete v.desc;
    if (v.check === undefined) delete v.check;
    switch (type) {
        case 'number':
            Object.assign(v, { init: 0, min: 0, max: 100, integer: true });
            break;
        case 'enum':
            Object.assign(v, { options: ['选项一', '选项二'], init: '选项一' });
            break;
        case 'boolean':
            v.init = false;
            break;
        case 'list':
            Object.assign(v, { init: [], maxItems: null });
            break;
        case 'record':
            Object.assign(v, { keyDesc: '名称', value: { type: 'number', min: 0, max: 100, init: 0 }, init: {} });
            break;
        default:
            v.init = '';
    }
}

function defaultRecordValue(t) {
    if (t === 'number') return { type: 'number', min: 0, max: 100, init: 0 };
    if (t === 'object') return { type: 'object', fields: [{ key: '状态', type: 'string', init: '' }, { key: '好感', type: 'number', min: 0, max: 100, init: 0 }] };
    return { type: 'string', init: '' };
}

// ---------------- 主对话框 ----------------

/**
 * 状态栏编辑对话框。编辑即时生效并保存（不需要点保存）；变量表里不合法的行不生效，关闭对话框后丢弃。
 * @param {object} card 角色卡（会 ensureStatusBar）
 * @param {{app?: object, project?: object, settings?: object, save?: Function, saveSettings?: Function, onChange?: Function}} ctx
 */
export async function openStatusBarDialog(card, ctx = {}) {
    const c = ctxOf(ctx);
    const hadStatusBar = isObj(card.statusBar);
    const sb = ensureStatusBar(card, c.settings);
    // 卡上的状态栏还没用过：按现在的全局设置刷新模式 / 配色 / 选项（之前打开过一次不应把当时的默认值固定下来）
    refreshPristineStatusBar(sb, c.settings);
    const charName = card.data?.name || card.charName || '';
    const maxVars = c.settings.statusBar?.maxVars || 12;
    const st = {
        tab: 'vars',
        json: false,
        jsonText: '',
        jsonError: '',
        rows: clone(sb.spec.variables) || [],
        title: sb.spec.title || '状态栏',
        rawEdits: {}, // `${行}:${字段}` → 用户输入但解析失败的原文（JSON 之类），重绘时保留
        notes: [],
        runNotes: null, // {title, list}：上一次 AI 生成 / 套用模板时的提示（规范化、合并、兜底），显示在顶部，可关闭
        flash: '',
        sample: null,
        sampleMsg: '',
        reply: '',
        simMsg: '',
        width: 375,
        bg: 'dark',
        previewErrors: [],
    };
    const box = document.createElement('div');
    box.className = 'nl-sb';

    const saveSoon = debounce(() => c.save(), 600);
    const touch = () => {
        sb.updatedAt = Date.now();
        saveSoon();
    };

    const resetDraft = () => {
        st.rows = clone(sb.spec.variables) || [];
        st.title = sb.spec.title || '状态栏';
        st.rawEdits = {};
        st.notes = [];
        st.json = false;
        st.jsonError = '';
        st.sample = null;
        st.previewErrors = [];
    };

    // 逐行规范化：每行单独规范化看它自己的问题，整表规范化看重复/冲突/超出上限。
    // range：会被规范化悄悄改掉的数字（最小值大于最大值、初始值超出范围），行仍然生效，但表格里保留用户填的值并提示
    const validate = () => {
        const warnings = [];
        const spec = normalizeStatusSpec({ title: st.title, variables: st.rows }, { charName, maxVars, warnings });
        const finalByPath = new Map(spec.variables.map((v) => [v.path, v]));
        const seen = new Set();
        const infos = st.rows.map((row) => {
            const w = [];
            const one = isObj(row) ? normalizeStatusSpec({ variables: [row] }, { charName, maxVars: 999, warnings: w }).variables[0] : null;
            if (!one) return { ok: false, msgs: w.length ? w : ['这一行不合法'], warns: [], range: [], all: w };
            if (!finalByPath.has(one.path) || seen.has(one.path)) {
                const m = warnings.filter((x) => x.includes(`「${one.path}」`) && !w.includes(x));
                return { ok: false, msgs: m.length ? m : ['与其他变量冲突，或超出了变量上限'], warns: w, range: [], all: [...w, ...m] };
            }
            seen.add(one.path);
            const norm = finalByPath.get(one.path);
            const range = rowRangeWarnings(row, norm);
            // 规范化自己也可能报同样的范围问题：已经有逐项说明时不再重复
            const warns = range.length ? w.filter((x) => !RANGE_WARN_RE.test(x)) : w;
            return { ok: true, msgs: [], warns, range, all: w, norm };
        });
        return { spec, warnings, infos };
    };

    const commitRows = () => {
        const r = validate();
        sb.spec = r.spec;
        // 有范围问题的行保留用户填的值（规范化后的值已经生效，行下有说明），其余换成规范化后的样子
        st.rows = st.rows.map((row, i) => (r.infos[i].ok && !r.infos[i].range.length ? clone(r.infos[i].norm) : row));
        const inline = new Set(r.infos.flatMap((x) => x.all));
        st.notes = r.warnings.filter((w) => !inline.has(w));
        refreshStatusBarLint(card);
        touch();
    };

    // ---------- 重绘（保留焦点与滚动位置） ----------
    const focusSelector = (el) => {
        if (!el || !box.contains(el)) return '';
        const attrs = [...el.attributes].filter((a) => a.name.startsWith('data-sb-') || a.name === 'data-act' || a.name === 'data-tab' || a.name === 'data-mode');
        return attrs.length ? attrs.map((a) => `[${a.name}="${CSS.escape(a.value)}"]`).join('') : '';
    };
    const chromeHtml = () => `${toolbarHtml()}${bannersHtml()}${tabsHtml()}`;
    const renderAll = () => {
        pendingRender = false;
        const sel = focusSelector(document.activeElement);
        const scroller = box.closest('.nl-dialog-body');
        const top = scroller?.scrollTop;
        box.innerHTML = `<div class="nl-sb-chrome" data-sb-chrome>${chromeHtml()}</div><div class="nl-sb-panel" data-sb-panel>${panelHtml()}</div>`;
        if (scroller) scroller.scrollTop = top;
        if (sel) {
            const el = box.querySelector(sel);
            if (el) {
                try {
                    el.focus({ preventScroll: true });
                } catch { /* ignore */ }
            }
        }
        afterRender();
    };
    /** 只重绘顶部工具栏 / 提示条 / 分页（输入时更新错误数之类，不打断正在编辑的控件） */
    const renderChrome = () => {
        const el = box.querySelector('[data-sb-chrome]');
        if (el) el.innerHTML = chromeHtml();
    };
    // change 在焦点离开时触发：如果是因为用户正按下鼠标去点别的按钮，立刻重绘会把那个按钮换掉、这次点击就丢了，
    // 所以按下期间先记着，松开（click 处理完）之后再重绘；键盘操作时等焦点移到下一个控件后再重绘并恢复焦点
    let pointerDown = false;
    let pendingRender = false;
    const renderSoon = () => {
        if (pointerDown) pendingRender = true;
        else setTimeout(renderAll, 0);
    };
    const onPointerDown = () => {
        pointerDown = true;
    };
    const onPointerUp = () => {
        if (!pointerDown) return;
        pointerDown = false;
        if (pendingRender) setTimeout(() => pendingRender && renderAll(), 0);
    };

    // ---------- 顶部工具栏、提示条、分页 ----------
    const toolbarHtml = () => {
        const n = sb.spec.variables.length;
        const lintErr = sb.lint?.errors?.length || 0;
        return `
            <div class="nl-row nl-wrap nl-sb-toolbar">
                <label title="关闭后导出/写入酒馆时不带状态栏，变量表保留"><input type="checkbox" data-sb-enable ${sb.enabled ? 'checked' : ''}> 导出时带上状态栏</label>
                <span class="nl-muted nl-small nl-num" data-sb-count title="变量上限在「设置 → 状态栏」里改；记录的每个字段各算一个">${n ? `${esc(varCountText(sb.spec, maxVars))} · ${esc(MODE_LABELS[sb.mode] || sb.mode)}` : '还没有变量'}</span>
                ${lintErr ? `<span class="nl-tag nl-err">${icon('alert', { size: 12 })}界面有 ${lintErr} 个问题</span>` : ''}
                <span class="nl-spacer"></span>
                ${n ? rerollBtn('sb-ai-all', '', { label: '全部重新生成', title: '让 AI 按这张卡重新设计变量和界面' }) : ''}
                <button class="nl-btn nl-sm" data-act="sb-save-tpl" ${n ? '' : 'disabled'} title="把当前的变量表和界面存成模板，其他卡也能用">${icon('save', { size: 14 })}存为模板</button>
                <button class="nl-btn nl-sm" data-act="sb-templates" title="内置模板和你保存的模板">${icon('file', { size: 14 })}模板库</button>
                <button class="nl-btn nl-sm" data-act="sb-undo" ${sb.prev ? '' : 'disabled'} title="撤销上一次 AI 生成或套用模板（再点一次恢复）">${icon('undo', { size: 14 })}撤销</button>
            </div>`;
    };

    const bannersHtml = () => [
        sb.stale ? `<div class="nl-sb-note nl-sb-note-warn">${icon('alert')}<div class="nl-grow">角色卡已经整卡重新生成，状态栏沿用了旧的变量和初始值，可能和新卡对不上。</div>
            ${rerollBtn('sb-ai-init', '', { label: 'AI 更新初始值', title: '保留变量，只让 AI 按新卡重新填初始值' })}
            <button class="nl-btn nl-sm nl-ghost" data-act="sb-stale-dismiss">保持不变</button></div>` : '',
        sb.error ? `<div class="nl-sb-note nl-sb-note-err">${icon('alert')}<div class="nl-grow">上次生成状态栏时出错：${esc(sb.error)}</div>
            <button class="nl-icon-btn" data-act="sb-error-dismiss" title="关闭这条提示" aria-label="关闭这条提示">${icon('close')}</button></div>` : '',
        st.runNotes?.list?.length ? `<div class="nl-sb-note nl-sb-note-warn" data-sb-run-notes>${icon('alert')}<div class="nl-grow"><b>${esc(st.runNotes.title)}</b>
            ${st.runNotes.list.map((m) => `<div class="nl-small">${esc(m)}</div>`).join('')}</div>
            <button class="nl-icon-btn" data-act="sb-notes-dismiss" title="关闭这条提示" aria-label="关闭这条提示">${icon('close')}</button></div>` : '',
    ].join('');

    /** 记下这次 AI 生成 / 套用模板的提示（去重；已经在出错提示条里的不再重复），并逐条记进日志 */
    const showRunNotes = (title, warnings) => {
        const list = logWarnings(c, warnings, [sb.error]);
        st.runNotes = list.length ? { title, list } : null;
    };

    const tabsHtml = () => {
        const blocked = !!(sb.spec.variables.length && sb.lint?.errors?.length);
        const dot = ' <span class="nl-dot nl-err" role="img" aria-label="有错误"></span>';
        return statusTabsHtml(st.tab, {
            vars: sb.spec.variables.length ? ` <span class="nl-muted nl-num" title="${esc(varCountText(sb.spec, maxVars))}">${countSpecLeaves(sb.spec)}</span>` : '',
            ui: blocked ? dot : '',
            export: blocked ? dot : '',
        });
    };

    const panelHtml = () => {
        switch (st.tab) {
            case 'rules': return rulesPanel();
            case 'ui': return uiPanel();
            case 'preview': return previewPanel();
            case 'export': return exportPanel();
            default: return varsPanel();
        }
    };

    // ---------- 变量 ----------
    /** 把片段里的 data-k="字段" 换成 data-sb-row="行" data-sb-k="字段" */
    const withRow = (i, inner) => inner.replace(/data-k="/g, `data-sb-row="${i}" data-sb-k="`);

    const initCell = (v, i) => {
        const raw = st.rawEdits[`${i}:init`];
        switch (v.type) {
            case 'number':
                return withRow(i, `<input class="nl-input" type="number" step="any" data-k="init" value="${esc(v.init ?? '')}" aria-label="初始值">`);
            case 'enum': {
                const opts = Array.isArray(v.options) ? v.options : String(v.options || '').split(/[|,，、/]/).map((x) => x.trim()).filter(Boolean);
                return withRow(i, `<select class="nl-input" data-k="init" aria-label="初始值">${optionList(opts, v.init)}</select>`);
            }
            case 'boolean':
                return withRow(i, `<select class="nl-input" data-k="init" aria-label="初始值">${optionList([{ value: 'true', label: '是' }, { value: 'false', label: '否' }], v.init ? 'true' : 'false')}</select>`);
            case 'list':
                return withRow(i, `<input class="nl-input" data-k="init" value="${esc(fmtList(v.init))}" placeholder="用、分隔" aria-label="初始值">`);
            case 'record':
                return withRow(i, `<textarea class="nl-input nl-textarea nl-mono" rows="2" data-k="init" spellcheck="false" placeholder='{"名字": …}' aria-label="初始值（JSON）">${esc(raw ?? JSON.stringify(v.init ?? {}))}</textarea>`);
            default:
                return withRow(i, `<input class="nl-input" data-k="init" value="${esc(v.init ?? '')}" aria-label="初始值">`);
        }
    };

    const rangeCell = (v, i) => {
        switch (v.type) {
            case 'number':
                return withRow(i, `
                    <div class="nl-row"><input class="nl-input" type="number" step="any" data-k="min" value="${esc(v.min ?? '')}" placeholder="最小" aria-label="最小值"><span class="nl-muted">~</span><input class="nl-input" type="number" step="any" data-k="max" value="${esc(v.max ?? '')}" placeholder="最大" aria-label="最大值"></div>
                    <label class="nl-small"><input type="checkbox" data-k="integer" ${v.integer !== false ? 'checked' : ''}> 整数</label>
                    <input class="nl-input" data-k="stages" value="${esc(fmtStages(v.stages))}" placeholder="阶段（可选）：30 熟悉，60 亲近" aria-label="阶段">`);
            case 'enum':
                return withRow(i, `<input class="nl-input" data-k="options" value="${esc(fmtOptions(v.options))}" placeholder="选项，用 / 分隔" aria-label="选项">`);
            case 'list':
                return withRow(i, `<div class="nl-row"><span class="nl-muted nl-small">最多</span><input class="nl-input" type="number" min="1" data-k="maxItems" value="${esc(v.maxItems ?? '')}" placeholder="不限" aria-label="最多几项"><span class="nl-muted nl-small">项</span></div>`);
            case 'string':
                return withRow(i, `<input class="nl-input" data-k="format" value="${esc(v.format ?? '')}" placeholder="格式（可选），如 HH:MM" aria-label="格式">`);
            case 'record': {
                const val = isObj(v.value) ? v.value : { type: 'string' };
                const vt = val.type === 'object' || Array.isArray(val.fields) ? 'object' : val.type === 'number' ? 'number' : 'string';
                const rawFields = st.rawEdits[`${i}:fields`];
                return withRow(i, `
                    <input class="nl-input" data-k="keyDesc" value="${esc(v.keyDesc ?? '')}" placeholder="键的含义，如 角色名" aria-label="键的含义">
                    <select class="nl-input" data-k="valueType" aria-label="值的类型">${optionList([{ value: 'number', label: '值：数字' }, { value: 'string', label: '值：文本' }, { value: 'object', label: '值：多个字段' }], vt)}</select>
                    ${vt === 'number' ? `<div class="nl-row"><input class="nl-input" type="number" step="any" data-k="vmin" value="${esc(val.min ?? '')}" placeholder="最小" aria-label="值的最小值"><span class="nl-muted">~</span><input class="nl-input" type="number" step="any" data-k="vmax" value="${esc(val.max ?? '')}" placeholder="最大" aria-label="值的最大值"></div>` : ''}
                    ${vt === 'object' ? `<textarea class="nl-input nl-textarea nl-mono" rows="3" data-k="fields" spellcheck="false" aria-label="字段（JSON）">${esc(rawFields ?? JSON.stringify(val.fields || []))}</textarea>` : ''}`);
            }
            default:
                return '<span class="nl-muted">—</span>';
        }
    };

    const rowHtml = (v, i, info, last) => {
        const t = VAR_TYPES.includes(v?.type) ? v.type : 'string';
        const widgets = TYPE_WIDGETS[t] || ['text'];
        const msgs = [...info.msgs, ...(st.rawEdits[`${i}:err`] ? [st.rawEdits[`${i}:err`]] : [])];
        const leaves = info.norm ? variableLeafCount(info.norm) : 1;
        return `
            <tr class="${info.ok ? '' : 'nl-sb-bad'}" data-sb-tr="${i}">
                <td>${withRow(i, `<input class="nl-input" data-k="path" value="${esc(v?.path ?? '')}" placeholder="分组.变量" aria-label="路径">`)}${v?.path && isReadonlyPath(v.path) ? '<div class="nl-muted nl-small">只读（AI 不更新）</div>' : ''}${leaves > 1 ? `<div class="nl-muted nl-small" data-sb-leaves>算 ${leaves} 个变量（每个字段各算一个）</div>` : ''}</td>
                <td>${withRow(i, `<input class="nl-input" data-k="label" value="${esc(v?.label ?? '')}" aria-label="名称">`)}</td>
                <td>${withRow(i, `<select class="nl-input" data-k="type" aria-label="类型">${optionList(VAR_TYPES.map((x) => ({ value: x, label: VAR_TYPE_LABELS[x] })), t)}</select>`)}</td>
                <td class="nl-sb-col-init">${initCell({ ...v, type: t }, i)}</td>
                <td class="nl-sb-col-range"><div class="nl-sb-stack">${rangeCell({ ...v, type: t }, i)}</div></td>
                <td>${withRow(i, `<select class="nl-input" data-k="widget" aria-label="显示方式">${optionList(widgets.map((w) => ({ value: w, label: WIDGET_LABELS[w] || w })), widgets.includes(v?.widget) ? v.widget : widgets[0])}</select>`)}</td>
                <td>${withRow(i, `<input class="nl-input" data-k="desc" value="${esc(v?.desc ?? '')}" placeholder="（可选）" aria-label="说明">`)}</td>
                <td class="nl-sb-col-act">
                    <button class="nl-icon-btn" data-act="sb-row-up" data-sb-i="${i}" ${i === 0 ? 'disabled' : ''} title="上移" aria-label="上移">${icon('arrowUp')}</button>
                    <button class="nl-icon-btn" data-act="sb-row-down" data-sb-i="${i}" ${last ? 'disabled' : ''} title="下移" aria-label="下移">${icon('arrowDown')}</button>
                    <button class="nl-icon-btn nl-danger" data-act="sb-row-del" data-sb-i="${i}" title="删除" aria-label="删除">${icon('trash')}</button>
                </td>
            </tr>
            ${msgs.length || info.warns.length || info.range.length ? `<tr class="nl-sb-rowmsg ${info.ok ? '' : 'nl-sb-bad'}"><td colspan="8">${msgs.map((m) => `<div class="nl-err nl-small">${icon('alert', { size: 12 })} ${esc(m)}${info.ok ? '' : '（这一行没有生效）'}</div>`).join('')}${info.range.map((m) => `<div class="nl-warn nl-small" data-sb-range>${icon('alert', { size: 12 })} ${esc(m)}</div>`).join('')}${info.warns.map((m) => `<div class="nl-warn nl-small">${esc(m)}</div>`).join('')}</td></tr>` : ''}`;
    };

    const tokensLine = () => {
        if (!sb.spec.variables.length) return '';
        const t = estimateStatusBarTokens(card);
        return `每轮常驻约 <b class="nl-num">${t.total}</b> tokens（变量列表 ${t.list} · 更新规则 ${t.rules} · 输出格式 ${t.format}）`;
    };

    const overridesOn = () => Object.values(sb.overrides || {}).some((x) => typeof x === 'string' && x.trim());

    const varsPanel = () => {
        const ai = rerollBtn('sb-ai-spec', '', { label: 'AI 重新设计', title: '让 AI 按这张卡重新设计变量表' });
        if (!st.rows.length && !st.json) {
            return `
                <div class="nl-field"><label>状态栏要求（可选，AI 生成时参考，会保存在这张卡上）</label>
                    <textarea class="nl-input nl-textarea" rows="2" data-sb-f="requirement" placeholder="例如：重点记录好感和体力；记录随身物品">${esc(sb.requirement || '')}</textarea></div>
                ${emptyState('状态栏会在每条 AI 回复下面显示角色当前的状态（好感、心情、位置……），并由 AI 在回复末尾按规则更新。可以让 AI 按这张卡设计一套变量和界面，也可以从模板开始，或者手动添加变量。', `
                    <div class="nl-row nl-wrap nl-sb-empty-acts">
                        <button class="nl-btn" data-act="sb-add-var">${icon('plus', { size: 14 })}手动添加变量</button>
                        <button class="nl-btn" data-act="sb-templates">${icon('file', { size: 14 })}从模板开始</button>
                        <button class="nl-btn nl-primary" data-act="sb-ai-first">AI 生成状态栏</button>
                    </div>`, { title: '还没有状态栏', ico: 'log' })}`;
        }
        const r = validate();
        const bad = r.infos.filter((x) => !x.ok).length;
        const table = st.json ? `
                <div class="nl-muted nl-small">直接编辑变量表 JSON（{ "title": …, "variables": [ … ] }），离开输入框后生效；不合法的变量不会生效，原因写在下面。</div>
                <textarea class="nl-input nl-textarea nl-mono" rows="18" data-sb-f="json" spellcheck="false" aria-label="变量表 JSON">${esc(st.jsonText)}</textarea>
                ${st.jsonError ? `<div class="nl-err nl-small">${icon('alert', { size: 12 })} ${esc(st.jsonError)}</div>` : ''}
                ${r.infos.some((x) => !x.ok) ? `<div class="nl-err nl-small">${r.infos.map((x, i) => (x.ok ? '' : `第 ${i + 1} 个变量没有生效：${esc(x.msgs.join('；'))}`)).filter(Boolean).join('<br>')}</div>` : ''}
                ${r.infos.some((x) => x.ok && x.range.length) ? `<div class="nl-warn nl-small" data-sb-range>${r.infos.map((x, i) => (x.ok && x.range.length ? `第 ${i + 1} 个变量「${esc(x.norm?.path || '')}」：${esc(x.range.join('；'))}` : '')).filter(Boolean).join('<br>')}</div>` : ''}`
            : `
                <div class="nl-sb-scroll">
                    <table class="nl-table nl-sb-table">
                        <thead><tr><th>路径</th><th>名称</th><th>类型</th><th>初始值</th><th>范围或选项</th><th>显示</th><th>说明</th><th aria-label="操作"></th></tr></thead>
                        <tbody>${st.rows.map((v, i) => rowHtml(v, i, r.infos[i], i === st.rows.length - 1)).join('')}</tbody>
                    </table>
                </div>`;
        return `
            ${overridesOn() ? `<div class="nl-sb-note nl-sb-note-warn">${icon('alert')}<div class="nl-grow">「规则」里有手动覆盖的内容，不再与变量表同步：改这里的变量不会更新那些内容。</div></div>` : ''}
            <div class="nl-grid2">
                <div class="nl-field"><label>状态栏标题</label><input class="nl-input" data-sb-f="title" value="${esc(st.title)}" maxlength="30"></div>
                <div class="nl-field"><label>状态栏要求（AI 生成时参考）</label><input class="nl-input" data-sb-f="requirement" value="${esc(sb.requirement || '')}" placeholder="例如：重点记录好感和体力"></div>
            </div>
            <div class="nl-muted nl-small">路径用「.」分层，最多 3 层，例如 <code>${esc(charName || '角色')}.好感度</code>；某一段以 _ 开头的变量 AI 只读。${tokensLine()}</div>
            ${table}
            ${bad ? `<div class="nl-err nl-small">${icon('alert', { size: 12 })} 有 ${bad} 个变量没有生效（标红的行）：改好之前它们不会导出，关闭对话框后会被丢弃。</div>` : ''}
            ${st.notes.length ? `<div class="nl-muted nl-small">${st.notes.map((n) => esc(n)).join('<br>')}</div>` : ''}
            ${st.flash ? `<div class="nl-warn nl-small">${esc(st.flash)}</div>` : ''}
            <div class="nl-row nl-wrap">
                <button class="nl-btn nl-sm" data-act="sb-add-var" ${st.json ? 'disabled' : ''}>${icon('plus', { size: 14 })}添加变量</button>
                <button class="nl-btn nl-sm" data-act="sb-json-toggle">${st.json ? '表格编辑' : 'JSON 编辑'}</button>
                <span class="nl-spacer"></span>
                ${ai}
            </div>`;
    };

    // ---------- 规则 ----------
    const rulesPanel = () => {
        if (!sb.spec.variables.length) return emptyState('先在「变量」里添加变量，这里会显示每个变量的检查规则和编译出来的世界书条目。', '', { title: '还没有变量', ico: 'log' });
        const r = validate();
        const o = sb.options;
        const keepOpts = [{ value: '', label: '全部去掉（推荐，省 token）' }, ...[1, 2, 3, 5].map((n) => ({ value: String(n), label: `保留最近 ${n} 轮` }))];
        if (o.keepUpdateDepth && ![1, 2, 3, 5].includes(o.keepUpdateDepth)) keepOpts.push({ value: String(o.keepUpdateDepth), label: `保留最近 ${o.keepUpdateDepth} 轮` });
        const ruleText = (typeof sb.overrides?.updateRules === 'string' && sb.overrides.updateRules.trim()) ? sb.overrides.updateRules : compileUpdateRules(sb.spec);
        const initText = (typeof sb.overrides?.initvar === 'string' && sb.overrides.initvar.trim()) ? sb.overrides.initvar : compileInitVar(sb.spec);
        const formatText = compileOutputFormat({ analysisLang: o.analysisLang });
        const ovOn = (k) => typeof sb.overrides?.[k] === 'string' && !!sb.overrides[k].trim();
        return `
            <div class="nl-card-desc">每个变量的「检查规则」会写进世界书条目 [mvu_update]变量更新规则，告诉 AI 什么时候、怎样更新它。每行一条，最多 6 条。</div>
            <div class="nl-sb-checks">
                ${st.rows.map((v, i) => (r.infos[i]?.ok ? `
                <div class="nl-field">
                    <label><code>${esc(v.path)}</code> ${esc(v.label || '')} <span class="nl-muted nl-small">${esc(VAR_TYPE_LABELS[v.type] || v.type)}</span>${isReadonlyPath(v.path) ? ' <span class="nl-tag">只读，不写进规则</span>' : ''}</label>
                    <textarea class="nl-input nl-textarea" rows="2" data-sb-row="${i}" data-sb-k="check" placeholder="例如：只在 {{user}} 明显示好时增加，每次 1~5">${esc((v.check || []).join('\n'))}</textarea>
                </div>` : '')).join('')}
            </div>
            <div class="nl-row nl-wrap">${rerollBtn('sb-ai-rules', '', { label: 'AI 重写规则', title: '保留变量，只让 AI 重写检查规则和说明' })}</div>
            <div class="nl-grid2">
                <div class="nl-field"><label>变量分析（&lt;Analysis&gt;）用的语言</label><select class="nl-input" data-sb-opt="analysisLang">${optionList([{ value: 'en', label: '英文（省 token，推荐）' }, { value: 'zh', label: '中文' }], o.analysisLang)}</select></div>
                <div class="nl-field"><label>发给 AI 的聊天记录里，保留几轮变量更新块</label><select class="nl-input" data-sb-opt="keepUpdateDepth">${optionList(keepOpts, o.keepUpdateDepth ? String(o.keepUpdateDepth) : '')}</select></div>
            </div>
            <h4>编译结果（只读，写进本卡专用世界书）</h4>
            <details><summary>${esc('[mvu_update]变量更新规则')}${ovOn('updateRules') ? '（已手动覆盖）' : ''} · 约 ${estimateTokens(ruleText)} tokens</summary><pre class="nl-pre nl-mono nl-sb-code">${esc(ruleText)}</pre></details>
            <details><summary>${esc('[mvu_update]变量输出格式')} · 约 ${estimateTokens(formatText)} tokens</summary><pre class="nl-pre nl-mono nl-sb-code">${esc(formatText)}</pre></details>
            <details><summary>${esc('[initvar]变量初始化勿开')}${ovOn('initvar') ? '（已手动覆盖）' : ''}</summary><pre class="nl-pre nl-mono nl-sb-code">${esc(initText)}</pre></details>
            <details class="nl-sb-adv" ${overridesOn() ? 'open' : ''}><summary>高级：手动覆盖编译结果</summary>
                <div class="nl-sb-note nl-sb-note-warn">${icon('alert')}<div class="nl-grow">填了覆盖内容的那一项<b>不再与变量表同步</b>：之后改变量、AI 重新生成都不会更新它，需要自己维护。留空 = 使用根据变量表自动生成的内容。</div></div>
                ${OVERRIDES.map(([k, label]) => `
                <div class="nl-field">
                    <label>${esc(label)} ${ovOn(k) ? '<span class="nl-tag nl-warn">已覆盖 · 不再与变量表同步</span>' : ''}</label>
                    <textarea class="nl-input nl-textarea nl-mono" rows="${ovOn(k) ? 10 : 3}" data-sb-ov="${k}" spellcheck="false" placeholder="留空 = 自动生成">${esc(sb.overrides?.[k] || '')}</textarea>
                    <div class="nl-row">
                        <button class="nl-btn nl-sm" data-act="sb-ov-fill" data-sb-key="${k}">填入当前自动生成的内容</button>
                        <button class="nl-btn nl-sm nl-danger" data-act="sb-ov-clear" data-sb-key="${k}" ${ovOn(k) ? '' : 'disabled'}>清除覆盖，恢复同步</button>
                    </div>
                </div>`).join('')}
            </details>`;
    };

    // ---------- 界面 ----------
    const lintPanelHtml = () => {
        if (sb.mode === 'auto') return `<div class="nl-ok nl-small">${icon('check', { size: 14 })} 内置排版由 NovelLoom 生成，不需要检查</div>`;
        const L = refreshStatusBarLint(card);
        const lines = [
            ...L.errors.map((m) => `<div class="nl-lint nl-lint-error"><b>${icon('alert', { size: 12 })} 错误</b>：${esc(m)}</div>`),
            ...L.warnings.map((m) => `<div class="nl-lint nl-lint-warn"><b>提醒</b>：${esc(m)}</div>`),
        ];
        const head = L.errors.length
            ? `<div class="nl-err nl-small">有 ${L.errors.length} 个错误：修好之前，带状态栏的导出和写入酒馆都会被阻止。</div>`
            : `<div class="nl-ok nl-small">${icon('check', { size: 14 })} 没有错误${L.warnings.length ? `，${L.warnings.length} 条提醒不影响导出` : ''}</div>`;
        return head + lines.join('');
    };

    const showDepthHtml = () => {
        const o = sb.options;
        const mode = o.showDepth === null ? 'all' : o.showDepth === 1 ? '1' : 'n';
        return `
            <div class="nl-field"><label>状态栏显示在哪些回复上</label>
                <div class="nl-row">
                    <select class="nl-input nl-inline" data-sb-opt="showDepthMode">${optionList([{ value: '1', label: '只最新一层' }, { value: 'n', label: '最新 N 层' }, { value: 'all', label: '每一层' }], mode)}</select>
                    ${mode === 'n' ? `<input class="nl-input nl-num" type="number" min="2" max="99" data-sb-opt="showDepthN" value="${esc(o.showDepth)}" aria-label="层数"><span class="nl-muted nl-small">层</span>` : ''}
                </div>
            </div>`;
    };

    const uiPanel = () => {
        const modeSeg = `<div class="nl-seg" role="group" aria-label="界面写法">${['bind', 'auto', 'raw'].map((m) => `<button class="nl-seg-btn ${sb.mode === m ? 'active' : ''}" aria-pressed="${sb.mode === m}" data-act="sb-mode" data-mode="${m}">${MODE_LABELS[m]}</button>`).join('')}</div>`;
        const themeSel = (note) => `<div class="nl-field"><label>内置排版的配色${note ? ` <span class="nl-muted">${esc(note)}</span>` : ''}</label><select class="nl-input" data-sb-f="theme">${optionList(STATUSBAR_THEMES, sb.theme)}</select></div>`;
        let body;
        if (sb.mode === 'bind') {
            body = `
                <div class="nl-card-desc">AI 按变量表写的界面片段：&lt;style&gt; + 带 data-nl-* 绑定的标记（可带一小段 nlRender 脚本），NovelLoom 会自动接上读取变量的运行时。留空则使用内置排版。</div>
                <div class="nl-field"><label>界面代码 <span class="nl-muted nl-small nl-num" data-sb-len>${sb.html.length} 字符</span></label>
                    <textarea class="nl-input nl-textarea nl-mono nl-sb-code-edit" rows="14" data-sb-f="html" spellcheck="false" placeholder="留空 = 内置排版">${esc(sb.html)}</textarea></div>
                <div class="nl-row nl-wrap">
                    ${rerollBtn('sb-ai-html', '', { label: 'AI 重写外观', title: '保留变量，只让 AI 重写界面' })}
                    <button class="nl-btn nl-sm" data-act="sb-html-default" title="把内置排版的代码填进来，在它的基础上修改">用内置排版作为起点</button>
                </div>
                <details><summary>data-nl-* 绑定写法</summary><div class="nl-pre nl-small">${esc(STATUS_BINDING_GUIDE)}</div></details>
                ${themeSel('（界面代码为空时生效）')}`;
        } else if (sb.mode === 'raw') {
            body = `
                <div class="nl-card-desc">粘贴一份完整的 HTML 文档（社区状态栏那种）。NovelLoom 不注入运行时，需要自己用 getAllVariables() / Mvu 读取 stat_data；可以用 {{user}} / {{char}}。有风险的写法在这里只是提醒，请自己确认来源可信。</div>
                <div class="nl-field"><label>HTML 文档 <span class="nl-muted nl-small nl-num" data-sb-len>${sb.html.length} 字符</span></label>
                    <textarea class="nl-input nl-textarea nl-mono nl-sb-code-edit" rows="16" data-sb-f="html" spellcheck="false" placeholder="&lt;!doctype html&gt;&lt;html&gt;&lt;head&gt;…&lt;/head&gt;&lt;body&gt;…&lt;/body&gt;&lt;/html&gt;">${esc(sb.html)}</textarea></div>`;
        } else {
            body = `
                <div class="nl-card-desc">不调用 AI：按变量表自动排版，每个第一层分组一张小卡片；数字有范围的显示进度条，选项和是/否显示徽标。</div>
                ${themeSel('')}`;
        }
        return `
            ${modeSeg}
            ${body}
            <div class="nl-sb-lint" data-sb-lint>${lintPanelHtml()}</div>
            <h4>在聊天里</h4>
            <div class="nl-grid2">${showDepthHtml()}</div>
            <div class="nl-row nl-wrap nl-checks">
                <label><input type="checkbox" data-sb-opt="foldUpdate" ${sb.options.foldUpdate !== false ? 'checked' : ''}> 把回复里的变量更新块折叠起来</label>
                <label><input type="checkbox" data-sb-opt="greetingTag" ${sb.options.greetingTag !== false ? 'checked' : ''}> 开场白下面也显示状态栏</label>
            </div>
            <div class="nl-muted nl-small">「最新 N 层」按 AI 回复计。已经显示出来的旧楼层，要重新打开聊天后才会隐藏。</div>`;
    };

    // ---------- 预览 ----------
    const ensureSample = () => {
        const spec = sb.spec;
        let base = st.sample || (isObj(sb.sample) ? sb.sample : null) || buildInitialState(spec);
        const r = parseStateWithSpec(spec, base);
        if (!r.ok) base = buildInitialState(spec);
        st.sample = r.ok ? r.data : base;
        return st.sample;
    };

    const previewPanel = () => {
        if (!sb.spec.variables.length) return emptyState('先在「变量」里添加变量，或者让 AI 生成，这里就能看到状态栏在聊天里的样子。', '', { title: '还没有变量', ico: 'eye' });
        const sample = ensureSample();
        const seg = (act, key, items, label) => `<div class="nl-seg" role="group" aria-label="${label}">${items.map(([v, l]) => `<button class="nl-seg-btn ${String(st[key]) === String(v) ? 'active' : ''}" aria-pressed="${String(st[key]) === String(v)}" data-act="${act}" data-sb-val="${v}">${l}</button>`).join('')}</div>`;
        return `
            <div class="nl-row nl-wrap">
                ${seg('sb-width', 'width', [[375, '手机 375'], [720, '宽屏 720']], '预览宽度')}
                ${seg('sb-bg', 'bg', [['theme', '主题背景'], ['dark', '深色'], ['light', '浅色']], '预览背景')}
                <span class="nl-spacer"></span>
                <button class="nl-btn nl-sm" data-act="sb-preview-reload">${icon('refresh', { size: 14 })}重新载入</button>
            </div>
            <div class="nl-sb-stage is-${st.bg}">
                <div class="nl-sb-frame-wrap" style="width:${st.width}px">
                    <iframe class="nl-sb-frame" data-sb-frame sandbox="allow-scripts" referrerpolicy="no-referrer" title="状态栏预览"></iframe>
                </div>
            </div>
            <div data-sb-preview-errs>${previewErrsHtml()}</div>
            <div class="nl-muted nl-small">预览在沙箱里运行，用的是模拟的酒馆助手 / MVU 环境，内容和导出到酒馆的完全一致（{{user}}/{{char}} 已换成名字）；字体图标、jQuery、lodash 从 CDN 加载。</div>
            <div class="nl-grid2">
                <div class="nl-field"><label>示例变量（stat_data）</label>
                    <textarea class="nl-input nl-textarea nl-mono" rows="12" data-sb-f="sample" spellcheck="false" aria-label="示例变量 JSON">${esc(JSON.stringify(sample, null, 2))}</textarea>
                    <div class="nl-row nl-wrap">
                        <button class="nl-btn nl-sm" data-act="sb-sample-apply">应用</button>
                        <button class="nl-btn nl-sm" data-act="sb-sample-init">初始值</button>
                        <button class="nl-btn nl-sm" data-act="sb-sample-random">随机值</button>
                    </div>
                    <div data-sb-sample-msg>${st.sampleMsg}</div>
                </div>
                <div class="nl-field"><label>模拟一轮更新：粘贴一条 AI 回复</label>
                    <textarea class="nl-input nl-textarea nl-mono" rows="12" data-sb-f="reply" spellcheck="false" placeholder="……正文……&#10;&lt;UpdateVariable&gt;&#10;&lt;JSONPatch&gt;[ … ]&lt;/JSONPatch&gt;&#10;&lt;/UpdateVariable&gt;" aria-label="AI 回复">${esc(st.reply)}</textarea>
                    <div class="nl-row nl-wrap">
                        <button class="nl-btn nl-sm" data-act="sb-sim">模拟一轮更新</button>
                        <button class="nl-btn nl-sm" data-act="sb-sim-example">填入示例回复</button>
                    </div>
                    <div data-sb-sim-msg>${st.simMsg}</div>
                </div>
            </div>`;
    };

    const previewErrsHtml = () => (st.previewErrors.length
        ? `<div class="nl-sb-note nl-sb-note-err">${icon('alert')}<div class="nl-grow"><b>界面脚本报错</b>${st.previewErrors.map((m) => `<div class="nl-mono nl-small">${esc(m)}</div>`).join('')}</div></div>`
        : '');

    const frameEl = () => box.querySelector('[data-sb-frame]');
    const loadPreview = async () => {
        const frame = frameEl();
        if (!frame) return;
        st.previewErrors = [];
        const errs = box.querySelector('[data-sb-preview-errs]');
        if (errs) errs.innerHTML = '';
        const tailwind = sb.mode === 'raw' ? await loadTailwind() : '';
        if (frameEl() !== frame) return; // 等待期间换了分页
        // 从很矮开始，等页面报上内容高度（避免先闪一下旧高度）
        frame.style.height = '32px';
        frame.srcdoc = buildPreviewSrcdoc(card, ensureSample(), { user: userName(), char: charName, tailwind });
    };
    const postSample = () => {
        const frame = frameEl();
        try {
            frame?.contentWindow?.postMessage({ type: 'nl-sample', stat: clone(st.sample) }, '*');
        } catch (e) {
            console.warn('[NovelLoom] 预览通信失败', e);
        }
    };
    const setSampleText = () => {
        const ta = box.querySelector('[data-sb-f="sample"]');
        if (ta) ta.value = JSON.stringify(st.sample, null, 2);
    };
    const setMsg = (sel, key, html) => {
        st[key] = html;
        const el = box.querySelector(sel);
        if (el) el.innerHTML = html;
    };
    const okMsg = (t) => `<div class="nl-ok nl-small">${icon('check', { size: 12 })} ${esc(t)}</div>`;
    const errMsg = (list) => list.map((m) => `<div class="nl-err nl-small">${icon('alert', { size: 12 })} ${esc(m)}</div>`).join('');

    const onMessage = (e) => {
        const frame = frameEl();
        if (!frame || e.source !== frame.contentWindow) return;
        const d = e.data;
        if (!d || d.source !== 'nl-preview') return;
        if (d.type === 'nl-height') {
            const h = Math.max(40, Math.min(4000, Number(d.height) || 0));
            frame.style.height = `${h}px`;
        } else if (d.type === 'nl-error') {
            const m = String(d.message || '').slice(0, 400);
            if (m && !st.previewErrors.includes(m) && st.previewErrors.length < 6) st.previewErrors.push(m);
            const el = box.querySelector('[data-sb-preview-errs]');
            if (el) el.innerHTML = previewErrsHtml();
        }
    };

    // ---------- 导出 ----------
    const exportData = () => {
        let regex = null;
        let regexError = null;
        try {
            regex = buildStatusRegexScripts(card);
        } catch (e) {
            regexError = e;
        }
        let helper = null;
        let helperError = null;
        try {
            helper = buildTavernHelper(card, c.settings.statusBar || {});
        } catch (e) {
            helperError = e;
        }
        return { regex, regexError, helper, helperError, entries: statusBarEntries(card) };
    };

    const exportPanel = () => {
        const d = exportData();
        const active = statusBarActive(card);
        const world = c.project ? statusBarWorldName(c.project, c.settings, card) : sb.worldName;
        const codeBlock = (what, title, obj, err) => `
            <div class="nl-sb-export">
                <div class="nl-row"><b class="nl-grow">${esc(title)}</b>${err ? '' : `<button class="nl-btn nl-sm" data-act="sb-copy" data-sb-what="${what}">${icon('copy', { size: 14 })}复制</button>`}</div>
                ${err ? `<div class="nl-err nl-small">${esc(err.message || String(err))}</div>` : `<pre class="nl-pre nl-mono nl-sb-code">${esc(JSON.stringify(obj, null, 2))}</pre>`}
            </div>`;
        return `
            ${active ? '' : `<div class="nl-sb-note nl-sb-note-warn">${icon('info')}<div class="nl-grow">${sb.enabled ? '还没有变量' : '状态栏已关闭'}：导出和写入酒馆时不会带上状态栏。</div></div>`}
            ${d.regexError ? `<div class="nl-sb-note nl-sb-note-err">${icon('alert')}<div class="nl-grow"><b>导出会被阻止</b><div>${esc(d.regexError.message)}</div></div></div>` : ''}
            <h4>环境检查</h4>
            <div class="nl-sb-checklist">${envChecks(card).map(checkLine).join('')}</div>
            <div class="nl-muted nl-small">酒馆助手的「角色脚本」开关存在酒馆助手自己的设置里，NovelLoom 读不到：第一次打开这张卡时会弹窗询问；拒绝过的话，到 酒馆助手 → 脚本库 → 角色脚本 里启用。</div>
            <h4>导出设置</h4>
            <div class="nl-grid2">
                <div class="nl-field"><label>本卡专用世界书（可在「编辑」里改名）</label><input class="nl-input" readonly value="${esc(world || '')}"></div>
            </div>
            <div class="nl-row nl-wrap nl-checks">
                <label><input type="checkbox" data-sb-opt="usageNote" ${sb.options.usageNote !== false ? 'checked' : ''}> 在作者备注里附上状态栏使用说明</label>
            </div>
            <h4>导出内容（只读）</h4>
            ${codeBlock('regex', `局部正则 regex_scripts${d.regex ? `（${d.regex.length} 条）` : ''}`, d.regex, d.regexError)}
            ${codeBlock('helper', '酒馆助手角色脚本 tavern_helper', d.helper, d.helperError)}
            ${codeBlock('entries', `世界书条目（${d.entries.length} 条）`, d.entries, null)}`;
    };

    const afterRender = () => {
        if (st.tab === 'preview' && sb.spec.variables.length) loadPreview();
    };

    // ---------- AI ----------
    const runAi = async (btn, opts, label, after = null) => {
        if (c.isBusy()) return c.log('已有任务在运行，请稍后', 'warn');
        const warnings = [];
        const ok = await busy(btn, async () => {
            await generateStatusBar(c.project, c.settings, card, { onLog: c.log, ...opts, warnings });
            return true;
        }, label);
        if (ok) after?.();
        resetDraft();
        refreshStatusBarLint(card);
        await c.save();
        if (ok) {
            showRunNotes('AI 生成时的提示', warnings);
            c.log(`已更新「${charName}」的状态栏：${varCountText(sb.spec)}`, 'success');
        }
        renderAll();
    };

    const snapshotOf = () => ({ spec: clone(sb.spec), html: sb.html, mode: sb.mode, theme: sb.theme, sample: clone(sb.sample ?? null), templateId: sb.templateId ?? null });

    // 一步撤销：和 statusbar-ai.js 的 restoreStatusBarPrev 一样交换 prev 与当前（再点一次就是重做），
    // 另外套用模板时 prev 里带的 overrides 也一起换回来
    const doUndo = async () => {
        const p = sb.prev;
        if (!isObj(p)) return;
        const cur = {};
        for (const k of PREV_KEYS) {
            if (!(k in p)) continue;
            cur[k] = clone(sb[k] ?? null);
            sb[k] = clone(p[k]);
        }
        if (!isObj(sb.spec) || !Array.isArray(sb.spec.variables)) sb.spec = { title: '状态栏', variables: [] };
        if (typeof sb.html !== 'string') sb.html = '';
        if (!['bind', 'raw', 'auto'].includes(sb.mode)) sb.mode = 'bind';
        if (!isObj(sb.overrides)) sb.overrides = { schemaScript: null, updateRules: null, initvar: null };
        sb.prev = cur;
        sb.error = '';
        resetDraft();
        refreshStatusBarLint(card);
        touch();
        await c.save();
        c.log('已撤销（再点一次「撤销」可以恢复）', 'info');
        renderAll();
    };

    const applyTemplate = async (btn, choice) => {
        const { template: t, mode, ai } = choice;
        if (c.isBusy() && ai) return c.log('已有任务在运行，请稍后', 'warn');
        const warnings = [];
        const res = await busy(btn, () => applyTemplateToCard(card, c, t, mode, { ai, warnings }), ai ? 'AI 调整中…' : '套用中…');
        resetDraft();
        refreshStatusBarLint(card);
        touch();
        await c.save();
        if (res) {
            showRunNotes(`套用模板「${t.name}」时的提示`, warnings);
            const how = mode === 'structure' ? '沿用结构' : '只借外观';
            if (res.changed) c.log(`已套用状态栏模板「${t.name}」（${how}）`, 'success');
            else c.log(`套用状态栏模板「${t.name}」（${how}）后状态栏没有变化`, 'info');
        }
        renderAll();
    };

    // ---------- 事件 ----------
    const setRowField = (i, k, el) => {
        const v = st.rows[i];
        if (!v) return false;
        const val = el.type === 'checkbox' ? el.checked : el.value;
        delete st.rawEdits[`${i}:err`];
        switch (k) {
            case 'path': v.path = String(val).trim(); break;
            case 'label': v.label = val; break;
            case 'type': resetType(v, val); break;
            case 'init':
                if (v.type === 'number') v.init = numOrNull(val);
                else if (v.type === 'boolean') v.init = val === 'true';
                else if (v.type === 'record') {
                    try {
                        const o = JSON.parse(val || '{}');
                        if (!isObj(o)) throw new Error('需要是 { 键: 值 } 形式的对象');
                        v.init = o;
                        delete st.rawEdits[`${i}:init`];
                    } catch (e) {
                        st.rawEdits[`${i}:init`] = val;
                        st.rawEdits[`${i}:err`] = `初始值不是合法的 JSON 对象：${e.message}`;
                        return true;
                    }
                } else v.init = val;
                break;
            case 'min': case 'max': v[k] = numOrNull(val); break;
            case 'integer': v.integer = !!val; break;
            case 'stages': v.stages = parseStages(val); break;
            case 'options': v.options = val; break;
            case 'maxItems': v.maxItems = numOrNull(val); break;
            case 'format': v.format = val; break;
            case 'keyDesc': v.keyDesc = val; break;
            case 'valueType': v.value = defaultRecordValue(val); v.init = {}; break;
            case 'vmin': case 'vmax': v.value = { ...(isObj(v.value) ? v.value : { type: 'number' }), [k === 'vmin' ? 'min' : 'max']: numOrNull(val) }; break;
            case 'fields':
                try {
                    const f = JSON.parse(val || '[]');
                    if (!Array.isArray(f)) throw new Error('需要是 [ {key, type, …} ] 形式的数组');
                    v.value = { type: 'object', fields: f };
                    delete st.rawEdits[`${i}:fields`];
                } catch (e) {
                    st.rawEdits[`${i}:fields`] = val;
                    st.rawEdits[`${i}:err`] = `字段不是合法的 JSON 数组：${e.message}`;
                    return true;
                }
                break;
            case 'widget': v.widget = val; break;
            case 'desc': v.desc = val; break;
            case 'check': v.check = String(val).split(/\r?\n/).map((x) => x.trim()).filter(Boolean); break;
            default: return false;
        }
        return true;
    };

    const setOption = (k, el) => {
        const o = sb.options;
        switch (k) {
            case 'analysisLang': o.analysisLang = el.value === 'zh' ? 'zh' : 'en'; break;
            case 'keepUpdateDepth': o.keepUpdateDepth = normalizeFloorCount(el.value); break;
            case 'showDepthMode':
                o.showDepth = el.value === 'all' ? null : el.value === '1' ? 1 : (o.showDepth > 1 ? o.showDepth : 3);
                break;
            case 'showDepthN': {
                const n = normalizeFloorCount(el.value);
                o.showDepth = n || 3;
                break;
            }
            case 'foldUpdate': case 'greetingTag': case 'usageNote': o[k] = !!el.checked; break;
            default: return;
        }
        touch();
    };

    const onChange = async (e) => {
        const el = e.target;
        if (el.hasAttribute('data-sb-enable')) {
            sb.enabled = el.checked;
            touch();
            return renderAll();
        }
        const row = el.dataset.sbRow;
        if (row !== undefined && el.dataset.sbK) {
            if (setRowField(Number(row), el.dataset.sbK, el)) {
                commitRows();
                if (el.dataset.sbK === 'check') return; // 规则页：只改规则，不必重绘（避免打断连续输入）
                renderSoon();
            }
            return;
        }
        const f = el.dataset.sbF;
        if (f === 'title') {
            st.title = el.value;
            commitRows();
            return renderSoon();
        }
        if (f === 'requirement') {
            sb.requirement = el.value.trim();
            return touch();
        }
        if (f === 'json') {
            st.jsonText = el.value;
            let parsed;
            try {
                parsed = JSON.parse(el.value);
            } catch (err) {
                st.jsonError = `JSON 格式不对：${err.message}`;
                return renderSoon();
            }
            st.jsonError = '';
            if (isObj(parsed) && typeof parsed.title === 'string') st.title = parsed.title;
            st.rows = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.variables) ? parsed.variables : [];
            st.rawEdits = {};
            commitRows();
            st.jsonText = JSON.stringify({ title: st.title, variables: st.rows }, null, 2);
            return renderSoon();
        }
        if (f === 'theme') {
            sb.theme = el.value;
            touch();
            return renderSoon();
        }
        if (f === 'html') {
            sb.html = el.value;
            touch();
            return lintSoon(); // 输入时已经安排过检查；这里只确保最后一次改动也检查到
        }
        if (f === 'reply') {
            st.reply = el.value;
            return;
        }
        if (el.dataset.sbOpt) {
            setOption(el.dataset.sbOpt, el);
            return renderSoon();
        }
        if (el.dataset.sbOv) {
            const k = el.dataset.sbOv;
            sb.overrides[k] = el.value.trim() ? el.value : null;
            refreshStatusBarLint(card);
            touch();
            return renderSoon();
        }
    };

    const lintSoon = debounce(() => {
        const el = box.querySelector('[data-sb-lint]');
        if (el) el.innerHTML = lintPanelHtml(); // lintPanelHtml 会重新检查并记到 statusBar.lint
        else refreshStatusBarLint(card);
        // 工具栏里有按钮：鼠标正按着（可能就是要点其中一个）时等松开后整体重绘
        if (pointerDown) pendingRender = true;
        else renderChrome();
    }, 300);

    const onInput = (e) => {
        const el = e.target;
        if (el.dataset.sbF === 'html') {
            sb.html = el.value;
            const len = box.querySelector('[data-sb-len]');
            if (len) len.textContent = `${el.value.length} 字符`;
            touch();
            lintSoon();
        } else if (el.dataset.sbF === 'reply') {
            st.reply = el.value;
        } else if (el.dataset.sbF === 'json') {
            st.jsonText = el.value;
        }
    };

    const onClick = async (e) => {
        const btn = e.target.closest('[data-act]');
        if (!btn || btn.disabled) return;
        const act = btn.dataset.act;
        const idx = Number(btn.dataset.sbI);
        switch (act) {
            case 'sb-tab':
                st.tab = btn.dataset.tab;
                return renderAll();
            case 'sb-ai-first':
            case 'sb-ai-all': {
                const r = await aiDialog({
                    title: act === 'sb-ai-first' ? 'AI 生成状态栏' : '全部重新生成状态栏',
                    intro: act === 'sb-ai-first' ? `AI 会按这张卡的设定设计一套变量（最多 ${maxVars} 个，记录的每个字段各算一个）和界面。` : '会替换现有的变量表和界面（可以撤销）。',
                    requirement: act === 'sb-ai-first' ? null : sb.requirement || '',
                });
                if (!r) return;
                if (r.requirement !== null) sb.requirement = r.requirement;
                return runAi(btn, { parts: defaultParts(sb), instruction: r.instruction }, 'AI 设计中…', () => { sb.stale = false; });
            }
            case 'sb-ai-spec': {
                const r = await aiDialog({ title: 'AI 重新设计变量', intro: '会替换现有的变量表（可以撤销）。', withHtml: sb.mode === 'bind' && !!sb.html.trim() });
                if (!r) return;
                return runAi(btn, { parts: r.html ? ['spec', 'html'] : ['spec'], instruction: r.instruction }, 'AI 设计中…');
            }
            case 'sb-ai-rules': {
                const r = await aiDialog({ title: 'AI 重写规则', intro: '保留变量的路径、类型和初始值，只重写检查规则和说明。', okLabel: '重写' });
                if (!r) return;
                return runAi(btn, { parts: ['rules'], instruction: r.instruction }, 'AI 重写中…');
            }
            case 'sb-ai-html': {
                const r = await aiDialog({ title: 'AI 重写外观', intro: '保留变量表，只重写界面代码（可以撤销）。', okLabel: '重写' });
                if (!r) return;
                return runAi(btn, { parts: ['html'], instruction: r.instruction }, 'AI 设计中…');
            }
            case 'sb-ai-init':
                return runAi(btn, { parts: ['init'] }, 'AI 更新中…', () => { sb.stale = false; });
            case 'sb-stale-dismiss':
                sb.stale = false;
                touch();
                return renderAll();
            case 'sb-error-dismiss':
                sb.error = '';
                touch();
                return renderAll();
            case 'sb-notes-dismiss':
                st.runNotes = null;
                return renderAll();
            case 'sb-undo':
                return doUndo();
            case 'sb-save-tpl': {
                const base = sb.spec.title && sb.spec.title !== '状态栏' ? sb.spec.title : `${charName}的状态栏`;
                const r = await nameDescDialog({ title: '存为状态栏模板', name: uniqueStatusBarTemplateName(c.settings, base), settings: c.settings });
                if (!r) return;
                try {
                    addStatusBarTemplate(c.settings, templateFromStatusBar(card, r));
                    c.saveSettings();
                    c.log(`已保存状态栏模板「${r.name}」`, 'success');
                } catch (err) {
                    await alertDialog(errorText(err), '保存模板失败');
                }
                return;
            }
            case 'sb-templates': {
                const choice = await templateLibraryDialog(c, sb.spec.variables.length > 0, charName, maxVars);
                if (choice) await applyTemplate(btn, choice);
                return;
            }
            case 'sb-add-var': {
                const names = new Set(st.rows.map((r) => r?.path));
                let n = st.rows.length + 1;
                while (names.has(`新变量${n}`)) n++;
                st.rows.push({ path: `新变量${n}`, type: 'number', label: '', init: 50, min: 0, max: 100, integer: true });
                commitRows();
                renderAll();
                const inp = box.querySelector(`[data-sb-row="${st.rows.length - 1}"][data-sb-k="path"]`);
                inp?.focus();
                inp?.select();
                return;
            }
            case 'sb-json-toggle':
                st.json = !st.json;
                st.jsonError = '';
                if (st.json) st.jsonText = JSON.stringify({ title: st.title, variables: st.rows }, null, 2);
                return renderAll();
            case 'sb-row-up':
            case 'sb-row-down': {
                const j = act === 'sb-row-up' ? idx - 1 : idx + 1;
                if (!st.rows[idx] || !st.rows[j]) return;
                [st.rows[idx], st.rows[j]] = [st.rows[j], st.rows[idx]];
                st.rawEdits = {};
                commitRows();
                return renderAll();
            }
            case 'sb-row-del': {
                const v = st.rows[idx];
                if (!v) return;
                if (!(await confirmDialog(`删除变量「${v.path || v.label || `第 ${idx + 1} 个`}」？`, { danger: true, okLabel: '删除' }))) return;
                st.rows.splice(idx, 1);
                st.rawEdits = {};
                commitRows();
                return renderAll();
            }
            case 'sb-ov-fill': {
                const k = btn.dataset.sbKey;
                const text = k === 'updateRules' ? compileUpdateRules(sb.spec) : k === 'initvar' ? compileInitVar(sb.spec) : compileSchemaScript(sb.spec, { zodUrl: c.settings.statusBar?.zodUrl });
                sb.overrides[k] = text;
                touch();
                return renderAll();
            }
            case 'sb-ov-clear': {
                const k = btn.dataset.sbKey;
                if (!(await confirmDialog('清除这一项的手动覆盖内容，恢复为根据变量表自动生成？手改的内容会丢失。', { danger: true, okLabel: '清除' }))) return;
                sb.overrides[k] = null;
                refreshStatusBarLint(card);
                touch();
                return renderAll();
            }
            case 'sb-mode':
                sb.mode = btn.dataset.mode;
                refreshStatusBarLint(card);
                touch();
                return renderAll();
            case 'sb-html-default':
                if (sb.html.trim() && !(await confirmDialog('用内置排版的代码替换当前的界面代码？', { okLabel: '替换' }))) return;
                sb.prev = snapshotOf();
                sb.html = renderDefaultFragment(sb.spec, sb.theme);
                refreshStatusBarLint(card);
                touch();
                return renderAll();
            case 'sb-width':
                st.width = Number(btn.dataset.sbVal) || 375;
                return renderAll();
            case 'sb-bg':
                st.bg = btn.dataset.sbVal;
                return renderAll();
            case 'sb-preview-reload':
                return loadPreview();
            case 'sb-sample-apply': {
                const ta = box.querySelector('[data-sb-f="sample"]');
                let obj;
                try {
                    obj = JSON.parse(ta.value);
                } catch (err) {
                    return setMsg('[data-sb-sample-msg]', 'sampleMsg', errMsg([`JSON 格式不对：${err.message}`]));
                }
                const r = parseStateWithSpec(sb.spec, obj);
                if (!r.ok) return setMsg('[data-sb-sample-msg]', 'sampleMsg', errMsg(r.errors));
                st.sample = r.data;
                sb.sample = clone(r.data);
                touch();
                setSampleText();
                postSample();
                return setMsg('[data-sb-sample-msg]', 'sampleMsg', okMsg('已应用（不合规的值已按变量表修正）'));
            }
            case 'sb-sample-init':
                st.sample = buildInitialState(sb.spec);
                sb.sample = null;
                touch();
                setSampleText();
                postSample();
                return setMsg('[data-sb-sample-msg]', 'sampleMsg', okMsg('已换成初始值'));
            case 'sb-sample-random':
                st.sample = randomSample(sb.spec);
                sb.sample = clone(st.sample);
                touch();
                setSampleText();
                postSample();
                return setMsg('[data-sb-sample-msg]', 'sampleMsg', okMsg('已换成随机值'));
            case 'sb-sim-example': {
                st.reply = exampleReply(sb.spec);
                const ta = box.querySelector('[data-sb-f="reply"]');
                if (ta) ta.value = st.reply;
                return;
            }
            case 'sb-sim': {
                const text = box.querySelector('[data-sb-f="reply"]')?.value ?? st.reply;
                st.reply = text;
                const r = applyReplyToState(ensureSample(), text, { spec: sb.spec });
                st.sample = r.state;
                setSampleText();
                postSample();
                const head = r.ops.length ? okMsg(`应用了 ${r.applied} / ${r.ops.length} 条更新`) : '';
                return setMsg('[data-sb-sim-msg]', 'simMsg', head + errMsg(r.errors));
            }
            case 'sb-copy': {
                const d = exportData();
                const obj = btn.dataset.sbWhat === 'regex' ? d.regex : btn.dataset.sbWhat === 'helper' ? d.helper : d.entries;
                const text = JSON.stringify(obj, null, 2);
                if (await copyText(text)) c.log('已复制到剪贴板', 'success');
                else downloadFile(text, `${safeFileName(charName, 'card')}-${btn.dataset.sbWhat}.json`);
                return;
            }
            case 'sb-allow-regex':
                if (await allowCardRegexWithConsent(card)) renderAll();
                return;
            default:
                return;
        }
    };

    box.addEventListener('click', onClick);
    box.addEventListener('change', onChange);
    box.addEventListener('input', onInput);
    box.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('pointerup', onPointerUp, true);
    window.addEventListener('pointercancel', onPointerUp, true);
    window.addEventListener('message', onMessage);
    refreshStatusBarLint(card);
    renderAll();
    try {
        await openDialog({ title: `状态栏：${charName}`, wide: true, body: box, buttons: [{ label: '关闭', value: null }] });
    } finally {
        window.removeEventListener('message', onMessage);
        window.removeEventListener('pointerup', onPointerUp, true);
        window.removeEventListener('pointercancel', onPointerUp, true);
        pendingRender = false;
        lintSoon.cancel();
        saveSoon.cancel();
        refreshStatusBarLint(card);
        // 只是打开看了看（原来没有状态栏，也什么都没改、没生成）：不把空状态栏连同此刻的默认值存进卡片
        if (!hadStatusBar && card.statusBar === sb && statusBarPristine(sb) && !sb.requirement && !sb.error) delete card.statusBar;
        await c.save();
        c.onChange();
    }
}
