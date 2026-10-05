// 状态栏（MVU 变量）编辑对话框：变量 / 规则 / 界面 / 立绘 / 预览 / 导出 六个分页，
// 以及角色卡页用到的几个小件：卡片列表里的「状态栏」标签、写卡后接着生成状态栏、写入酒馆后的提示。
// 纯逻辑都在 statusbar.js / statusbar-runtime.js / statusbar-ai.js / statusbar-templates.js，这里只管界面。
// 不依赖 DOM 的部分（记录字段编辑、立绘草稿、各分页的 HTML 片段）导出给测试用。

import { errorText } from '../llm.js';
import { statusBarWorldName } from '../publish.js';
import { openCharacterInST, toast } from '../stio.js';
import {
    GROUP_FIELD_MAX, PORTRAIT_LIMITS, PORTRAIT_OPS, RECORD_FIELD_MAX, TYPE_WIDGETS, VAR_TYPES, VAR_TYPE_LABELS, WIDGET_LABELS,
    applyReplyToState, buildInitialState, buildStatusRegexReplace, buildStatusRegexScripts, buildTavernHelper, castRecordPath,
    compileInitVar, compileOutputFormat, compileSchemaScript, compileUpdateRules, countSpecLeaves, createStatusBar, ensureStatusBar,
    estimateStatusBarTokens, getPath, isWorldCard, lintStatusHtml, normalizeFloorCount, normalizePortraits, normalizeStatusSpec,
    parseStateWithSpec, portraitCandidates, portraitInitial, portraitNameProblem, portraitSampleCandidates, portraitUrlProblem, portraitsActive,
    randomRecordItem, randomSampleState, recordLeafFields, resolvePortrait, seedRecordEntries, segmentProblem, splitPath,
    statusBarActive, statusBarCharName, statusBarEntries, variableLeafCount, worldCastNames,
} from '../statusbar.js';
import { generateStatusBar } from '../statusbar-ai.js';
import {
    STATUSBAR_THEMES, STATUS_BINDING_GUIDE, buildPreviewSrcdoc, compileStatusDocument, portraitChoiceProblem, readPortraitChoices, renderDefaultFragment,
    writePortraitChoice,
} from '../statusbar-runtime.js';
import {
    STATUS_TEMPLATE_DESC_MAX, STATUS_TEMPLATE_MODE_LABELS, STATUS_TEMPLATE_NAME_MAX, addStatusBarTemplate, applyStatusBarTemplate,
    duplicateStatusBarTemplate, exportStatusBarTemplate, importStatusBarTemplate, listStatusBarTemplates, removeStatusBarTemplate,
    statusBarTemplateFileName, statusBarVarCap, templateFromStatusBar, templatePreviewCard, templateVarCap, uniqueStatusBarTemplateName,
    updateStatusBarTemplate,
} from '../statusbar-templates.js';
import { debounce, downloadFile, estimateTokens, pickFile, safeFileName } from '../utils.js';
import { alertDialog, busy, confirmDialog, emptyState, esc, icon, openDialog, optionList, rerollBtn } from './common.js';

const MIN_JSR = '4.6.0';
const TAILWIND_URL = '/scripts/extensions/third-party/JS-Slash-Runner/lib/tailwindcss.min.js';
const MODE_LABELS = { bind: 'AI 设计', auto: '内置排版', raw: '自定义 HTML' };
const TABS = [['vars', '变量'], ['rules', '规则'], ['ui', '界面'], ['portraits', '立绘'], ['preview', '预览'], ['export', '导出']];
/** 撤销时交换的字段（statusBar.prev 里有哪些就换哪些；套用模板时 prev 还带 overrides，模板带立绘时还有 portraits；maxVars 是卡片自己的变量上限） */
const PREV_KEYS = ['spec', 'html', 'mode', 'theme', 'sample', 'templateId', 'maxVars', 'overrides', 'portraits'];
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
        // 字段（分组里的字段按「分组.字段」）：用户填的那一项与规范化后的对照
        const walk = (rawList, normList, prefix) => {
            for (const f of Array.isArray(rawList) ? rawList : []) {
                if (!isObj(f)) continue;
                const key = String(f.key ?? f.name ?? '').trim();
                const nf = (normList || []).find((x) => x.key === key);
                if (!nf) continue;
                if (Array.isArray(f.fields)) {
                    if (nf.type === 'object' && !prefix) walk(f.fields, nf.fields, `${key}.`);
                    continue;
                }
                if (nf.type !== 'number') continue;
                out.push(...numberIssues(f, nf, { what: `字段「${prefix}${key}」的`, withInit: (f.init ?? f.value ?? f.default) !== undefined }));
            }
        };
        if (val.type === 'object') walk(rv.fields, val.fields, '');
        const init = isObj(raw.init) ? raw.init : {};
        const numLeaves = recordLeafFields(val).filter((l) => l.field.type === 'number');
        for (const [k, item] of Object.entries(init)) {
            const got = norm.init?.[k];
            if (got === undefined) continue;
            if (val.type === 'number') {
                const n = numOrNull(item);
                if (n !== null && n !== got) out.push(`初始条目「${k}」的值 ${n} 超出范围 ${fmtRange(val.min, val.max)}：现在按 ${got} 生效`);
            } else if (val.type === 'object' && isObj(item) && isObj(got)) {
                for (const { path, field: nf } of numLeaves) {
                    const n = numOrNull(getPath(item, path));
                    const g = getPath(got, path);
                    if (n !== null && n !== g) out.push(`初始条目「${k}」的「${path}」${n} 超出范围 ${fmtRange(nf.min, nf.max)}：现在按 ${g} 生效`);
                }
            }
        }
    }
    return out.length > 6 ? [...out.slice(0, 6), `……另有 ${out.length - 6} 处同类问题`] : out;
}

/** 规范化给出的、与上面重复的范围 / 初始值提示（有 rowRangeWarnings 时不再重复显示） */
const RANGE_WARN_RE = /最小值|最大值|范围|超出|初始值/;
/** 规范化给出的、记录字段取舍的提示（字段编辑器里已经逐项标出，见 recordFieldIssues） */
const FIELD_WARN_RE = /的字段被丢弃|的分组「[^」]*」(?:里|最多|没有可用)|的记录字段「|的记录最多|的记录字段为空/;

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
    // project：世界/旁白卡沿用结构时，把项目里的主要角色预先填进主要角色记录（不让 AI 调整时也不是空的）
    const res = applyStatusBarTemplate(card, template, mode, { settings: c.settings, project: c.project || null });
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

/** 「存为模板」里「连同立绘设置」那一项的说明；卡上没有立绘时返回 ''（不显示这一项） */
export function templatePortraitsOptionText(portraits) {
    if (!portraitsActive(portraits)) return '';
    const nc = Object.keys(portraits.characters || {}).length;
    const np = (portraits.pools || []).length;
    return `连同立绘设置（${nc ? `${nc} 个角色` : ''}${nc && np ? '、' : ''}${np ? `${np} 个图池` : ''}；图片地址会存进模板，导出模板时也会带上）`;
}

/**
 * 模板名称 + 说明。名称在框里就地检查（不能为空、不能与其他模板重名，不分大小写；改名时排除 exceptId 自己），
 * 有问题时提示并保持对话框打开。portraitsOption：非空时多一个「连同立绘设置」勾选框（默认不勾，图片地址是用户自己的），
 * 结果里带 portraits: true/false。
 */
async function nameDescDialog({ title, name = '', desc = '', settings = null, exceptId = null, portraitsOption = '' }) {
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
            <div class="nl-field"><label>说明（可选）</label><input class="nl-input" data-f="desc" maxlength="${STATUS_TEMPLATE_DESC_MAX}" value="${esc(desc)}" placeholder="例如：好感 + 心情 + 着装，浅色卡片" aria-label="模板说明"></div>
            ${portraitsOption ? `<label><input type="checkbox" data-f="portraits"> ${esc(portraitsOption)}</label>` : ''}`,
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
    const out = { name: root.querySelector('[data-f="name"]').value.replace(/\s+/g, ' ').trim(), desc: root.querySelector('[data-f="desc"]').value.trim() };
    if (portraitsOption) out.portraits = !!root.querySelector('[data-f="portraits"]')?.checked;
    return out;
}

/**
 * 模板的变量数与上限的说明（模板库与「套用模板」对话框共用）：沿用结构时的上限是 templateVarCap
 * （设置里的上限；模板自带更大的上限时用模板的，如「多人群像」）。
 * @returns {{n: number, cap: number, base: number, over: boolean, raised: boolean}}
 */
export function templateCapInfo(t, settings) {
    const n = t?.spec?.variables?.length ? countSpecLeaves(t.spec) : 0;
    const base = templateVarCap(null, settings);
    const cap = templateVarCap(t, settings);
    return { n, cap, base, over: n > cap, raised: cap > base && n > base };
}

/** 套用模板：沿用结构 / 只借外观，以及是否让 AI 按这张卡调整（只借外观时必须调用 AI，见 templateAiState） */
async function applyModeDialog(t, hasVars, settings) {
    const canStructure = !!t.spec?.variables?.length;
    const cap = templateCapInfo(t, settings);
    const over = !canStructure ? ''
        : cap.over ? `模板有 ${varCountText(t.spec)}，超过上限 ${cap.cap}：多出的变量会被丢弃。`
            : cap.raised ? `模板有 ${varCountText(t.spec)}，多于设置里的上限 ${cap.base}：这个模板自带上限 ${cap.cap}，会保留全部变量。` : '';
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
                <span><b>沿用结构</b><span class="nl-muted nl-small">${canStructure ? '变量表和界面都照搬模板（替换这张卡现有的状态栏和手写覆盖），再让 AI 按这张卡填写初始值和检查规则。' : '这个模板只有界面、没有变量表，不能沿用结构。'}</span>${over ? `<span class="${cap.over ? 'nl-warn' : 'nl-muted'} nl-small" data-sb-tpl-cap>${esc(over)}</span>` : ''}</span></label>
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

/** 模板库：列出内置与保存的模板；返回要套用的 {template, mode, ai}（或 null）。变量数按 countSpecLeaves 计，和 templateVarCap 比较 */
async function templateLibraryDialog(c, hasVars, charName = '') {
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
        const { n, cap, over: isOver, raised } = templateCapInfo(t, c.settings);
        const over = isOver ? ` <span class="nl-tag nl-warn" title="沿用结构时多出的变量会被丢弃">超过上限 ${cap}</span>`
            : raised ? ` <span class="nl-tag" title="多于设置里的变量上限；沿用结构时按模板自带的上限保留全部变量">自带上限 ${cap}</span>` : '';
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
                            const choice = await applyModeDialog(t, hasVars, c.settings);
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
// 「随机值」用 statusbar.js 的 randomSampleState（分组逐个字段随机，结果总能通过 parseStateWithSpec）

/** 一个基本字段（或变量）在示例回复里的一条更新：数字 +5、选项换一个、是/否取反、文本换成「示例更新」 */
function exampleOp(f, path) {
    if (f.type === 'number') return { op: 'delta', path, value: 5 };
    if (f.type === 'enum' && f.options?.length > 1) return { op: 'replace', path, value: f.options.find((o) => o !== f.init) };
    if (f.type === 'boolean') return { op: 'replace', path, value: !f.init };
    if (f.type === 'string') return { op: 'replace', path, value: '示例更新' };
    return null;
}

/**
 * 「填入示例回复」：按变量表拼一条带 <UpdateVariable> 的假回复，演示模拟更新。
 * 记录：有初始条目且字段里有分组时改第一个条目分组里的一个字段（/主要角色/莉艾丽/服饰/上衣），否则插入一个随机的新条目。
 */
export function exampleReply(spec) {
    const ops = [];
    const done = new Set();
    for (const v of spec?.variables || []) {
        if (isReadonlyPath(v.path) || done.has(v.type)) continue;
        const p = `/${splitPath(v.path).join('/')}`;
        let op = null;
        if (v.type === 'list') op = { op: 'insert', path: `${p}/-`, value: '新的一项' };
        else if (v.type === 'record') {
            const key = Object.keys(isObj(v.init) ? v.init : {})[0];
            const leaf = key !== undefined ? recordLeafFields(v.value).find((l) => l.group && exampleOp(l.field, '')) : null;
            op = leaf
                ? exampleOp(leaf.field, `${p}/${key}/${splitPath(leaf.path).join('/')}`)
                : { op: 'insert', path: `${p}/新条目`, value: randomRecordItem(v.value) };
        } else op = exampleOp(v, p);
        if (!op) continue;
        ops.push(op);
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

/** 记录值在表格里按哪种编辑：object（多个字段，含分组）/ number / string */
function recordValueKind(val) {
    if (!isObj(val)) return 'string';
    return val.type === 'object' || Array.isArray(val.fields) ? 'object' : val.type === 'number' ? 'number' : 'string';
}

// ---------------- 世界/旁白卡 ----------------

const WORLD_EMPTY_TEXT = '世界/旁白卡的状态栏为整个群像设计：每个主要角色一套状态（好感、心情、服饰……），剧情里途中出场的 NPC 由 AI 随时加入，再加上时间、地点等世界变量和主角自己的状态。可以让 AI 按这张卡设计一套变量和界面，也可以从模板开始，或者手动添加变量。';

/** 世界/旁白卡变量表上方的说明：{{char}} 是旁白，群像放进以角色名为键的记录 */
export function worldVarsHint(charName = '') {
    return `这是世界/旁白卡：{{char}} 是旁白（${charName || '旁白'}），不是某个角色。整个群像放进「主要角色」「NPC」这样的记录（键是角色名，每个角色一套字段，可以分组），共用的状态用 世界.时间、世界.地点、主角.身份 这样的固定变量。主要角色那个记录的初始值下面有「填入主要角色」。`;
}

/**
 * 变量表里这一行要不要放「填入主要角色」：只有世界/旁白卡、并且这一行正是主要角色的记录（castRecordPath：最后一段叫「主要角色」的，
 * 或者第一个按角色名记、又不是 NPC/路人的记录）。NPC、物品之类的记录没有这个按钮（项目里的主要角色不该填进去）。
 * @param {boolean} world 是不是世界/旁白卡
 * @param {object} spec 当前（规范化后的）变量表
 * @param {string} path 这一行规范化后的路径（这一行没生效时为空）
 */
export function seedCastAllowed(world, spec, path) {
    return !!world && !!path && path === castRecordPath(spec);
}

/**
 * 「填入主要角色」：把名字加进一个（已规范化的）记录变量的初始条目，已有的跳过，新条目取默认值（分组也一样）。
 * @param {object} norm 规范化后的记录变量
 * @param {string[]} names 一般是 worldCastNames(project, card)
 * @returns {{row: object, added: string[], text: string}} row：新的变量（仍是规范化后的样子）；text：给用户的结果说明
 */
export function seedRecordEntriesInto(norm, names) {
    const warnings = [];
    const res = seedRecordEntries({ variables: [norm] }, norm.path, names, { warnings });
    const text = res.added.length
        ? `已在「${norm.path}」里加入 ${res.added.length} 个角色：${res.added.join('、')}${warnings.length ? `（${warnings.join('；')}）` : ''}`
        : `「${norm.path}」里已经有这些角色了${warnings.length ? `（${warnings.join('；')}）` : ''}。`;
    return { row: res.spec.variables[0], added: res.added, text };
}

// ---------------- 记录的字段（含一层分组） ----------------

/** 记录字段可选的类型（分组里的字段也一样；分组本身用「添加分组」） */
export const FIELD_TYPES = ['number', 'string', 'enum', 'boolean'];

const isGroupField = (f) => isObj(f) && Array.isArray(f.fields);

/** 字段名，取法与 normalizeStatusSpec 一致：key / name / path，去掉首尾空白，最多 32 字 */
function fieldKeyOf(f) {
    const raw = isObj(f) ? f.key ?? f.name ?? f.path : undefined;
    const s = raw === undefined || raw === null ? '' : typeof raw === 'object' ? JSON.stringify(raw) : String(raw);
    return s.trim().slice(0, 32);
}

const optionsOf = (f) => (Array.isArray(f?.options) ? f.options : String(f?.options ?? '').split(/[|,，、/]/))
    .map((x) => String(x ?? '').trim()).filter(Boolean);

/** 字段引用：'2' 是第 3 项（字段或分组），'2.1' 是第 3 项（分组）里的第 2 个字段 → [2, 1]；不合法返回 null */
export function parseFieldRef(ref) {
    const m = String(ref ?? '').match(/^(\d+)(?:\.(\d+))?$/);
    return m ? [Number(m[1]), m[2] === undefined ? null : Number(m[2])] : null;
}

function fieldAt(value, ref) {
    const r = parseFieldRef(ref);
    if (!r || !isObj(value) || !Array.isArray(value.fields)) return null;
    const f = value.fields[r[0]];
    if (r[1] === null) return isObj(f) ? f : null;
    return isGroupField(f) && isObj(f.fields[r[1]]) ? f.fields[r[1]] : null;
}

/**
 * 逐项检查记录的「多个字段」值（表格里正在编辑、还没规范化的 {type:'object', fields}），取舍与 normalizeStatusSpec 一致：
 * 名字不合法、重名（后一个丢弃）、超过 RECORD_FIELD_MAX 项（分组算一项）或分组超过 GROUP_FIELD_MAX 个字段（之后的都丢弃）、
 * 分组里没有可用的字段（整组丢弃）、分组里又有分组 → 'err'（这一项没有生效）；选项字段没有选项 → 'warn'（按文本处理）。
 * @param {object} value
 * @returns {{items: Object<string, {level: 'err'|'warn', msg: string}[]>, top: string[], count: number, leaves: number, groups: Object<string, number>, errors: number, warns: number}}
 *   items 的键是字段引用（'2' / '2.1'）；count：生效的项数（分组算一项）；leaves：生效的基本字段数（与 variableLeafCount 一致）；
 *   groups：每个分组里生效的字段数
 */
export function recordFieldIssues(value) {
    const res = { items: {}, top: [], count: 0, leaves: 0, groups: {}, errors: 0, warns: 0 };
    const add = (ref, msg, level = 'err') => {
        (res.items[ref] ||= []).push({ level, msg });
        if (level === 'err') res.errors++;
        else res.warns++;
    };
    const enumCheck = (f, ref) => {
        if (String(f.type ?? '').trim().toLowerCase() === 'enum' && !optionsOf(f).length) add(ref, '选项字段还没有选项：现在按文本处理', 'warn');
    };
    const nameProblem = (key, what) => {
        if (!key) return `${what}名为空`;
        const p = segmentProblem(key);
        return p ? `${what}名${p}` : '';
    };
    const fields = isObj(value) && Array.isArray(value.fields) ? value.fields : [];
    const seen = new Set();
    let capped = false;
    for (const [j, f] of fields.entries()) {
        const ref = String(j);
        const what = isGroupField(f) ? '分组' : '字段';
        if (capped) {
            add(ref, `一条记录最多 ${RECORD_FIELD_MAX} 项（分组算一项）：这个${what}没有生效`);
            continue;
        }
        if (!isObj(f)) {
            add(ref, '不是 {key, type} 形式：没有生效');
            continue;
        }
        const key = fieldKeyOf(f);
        const problem = nameProblem(key, what);
        if (problem) {
            add(ref, `${problem}：这个${what}没有生效`);
            continue;
        }
        let n = 0;
        if (isGroupField(f)) {
            const kseen = new Set();
            let gcapped = false;
            for (const [k, ff] of f.fields.entries()) {
                const r2 = `${j}.${k}`;
                if (gcapped) {
                    add(r2, `一个分组最多 ${GROUP_FIELD_MAX} 个字段：这个字段没有生效`);
                    continue;
                }
                if (!isObj(ff)) {
                    add(r2, '不是 {key, type} 形式：没有生效');
                    continue;
                }
                const kk = fieldKeyOf(ff);
                const p2 = nameProblem(kk, '字段');
                if (p2) add(r2, `${p2}：这个字段没有生效`);
                else if (isGroupField(ff)) add(r2, '分组里不能再有分组：没有生效');
                else if (kseen.has(kk)) add(r2, `分组里已经有「${kk}」：重名的这个没有生效`);
                else if (n >= GROUP_FIELD_MAX) {
                    gcapped = true;
                    add(r2, `一个分组最多 ${GROUP_FIELD_MAX} 个字段：这个字段没有生效`);
                } else {
                    kseen.add(kk);
                    n++;
                    enumCheck(ff, r2);
                }
            }
            res.groups[ref] = n;
            if (!n) {
                add(ref, '分组里没有可用的字段：整个分组没有生效');
                continue;
            }
        }
        if (seen.has(key)) {
            add(ref, `已经有「${key}」：重名的这个${what}没有生效`);
            continue;
        }
        if (res.count >= RECORD_FIELD_MAX) {
            capped = true;
            add(ref, `一条记录最多 ${RECORD_FIELD_MAX} 项（分组算一项）：这个${what}没有生效`);
            continue;
        }
        seen.add(key);
        res.count++;
        if (isGroupField(f)) res.leaves += n;
        else {
            res.leaves++;
            enumCheck(f, ref);
        }
    }
    if (!res.count) res.top.push(fields.length ? '没有可用的字段：记录的值现在按文本处理' : '还没有字段：记录的值现在按文本处理，请添加字段');
    return res;
}

function uniqueFieldKey(list, base) {
    const keys = new Set(list.map(fieldKeyOf));
    let n = 1;
    while (keys.has(`${base}${n}`)) n++;
    return `${base}${n}`;
}

function objectFields(value) {
    if (!Array.isArray(value.fields)) value.fields = [];
    value.type = 'object';
    return value.fields;
}

/**
 * 在记录的字段末尾加一个文本字段（groupRef 给出时加在那个分组末尾），名字不重名（字段1、字段2……）。
 * 已到上限（RECORD_FIELD_MAX 项 / 分组 GROUP_FIELD_MAX 个字段）时不加。
 * @returns {string|null} 新字段的引用（'3' / '1.2'），没加时为 null
 */
export function addRecordField(value, groupRef = null) {
    if (!isObj(value)) return null;
    const fields = objectFields(value);
    const issues = recordFieldIssues(value);
    if (groupRef !== null && groupRef !== undefined && groupRef !== '') {
        const r = parseFieldRef(groupRef);
        const g = r && r[1] === null ? fields[r[0]] : null;
        if (!isGroupField(g) || (issues.groups[String(r[0])] ?? 0) >= GROUP_FIELD_MAX) return null;
        g.fields.push({ key: uniqueFieldKey(g.fields, '字段'), type: 'string', init: '' });
        return `${r[0]}.${g.fields.length - 1}`;
    }
    if (issues.count >= RECORD_FIELD_MAX) return null;
    fields.push({ key: uniqueFieldKey(fields, '字段'), type: 'string', init: '' });
    return String(fields.length - 1);
}

/** 加一个分组（自带一个文本字段，空分组不会生效）；已到 RECORD_FIELD_MAX 项时不加。返回新分组的引用或 null */
export function addRecordGroup(value) {
    if (!isObj(value)) return null;
    const fields = objectFields(value);
    if (recordFieldIssues(value).count >= RECORD_FIELD_MAX) return null;
    fields.push({ key: uniqueFieldKey(fields, '分组'), type: 'object', fields: [{ key: '字段1', type: 'string', init: '' }] });
    return String(fields.length - 1);
}

/**
 * 删掉一个字段或整个分组。记录只剩一项、分组只剩一个字段时不能删（空的会被规范化当成文本值 / 整组丢弃；
 * 删整个分组用分组的引用，改成数字或文本用「值的类型」）。返回是否删了
 */
export function removeRecordField(value, ref) {
    const r = parseFieldRef(ref);
    if (!r || !isObj(value) || !Array.isArray(value.fields)) return false;
    const [j, k] = r;
    if (k === null) {
        if (j >= value.fields.length || value.fields.length <= 1) return false;
        value.fields.splice(j, 1);
        return true;
    }
    const g = value.fields[j];
    if (!isGroupField(g) || k >= g.fields.length || g.fields.length <= 1) return false;
    g.fields.splice(k, 1);
    return true;
}

/** 在同一层里上移（dir < 0）或下移一个字段 / 分组；返回移动后的引用，移不动时为 null */
export function moveRecordField(value, ref, dir) {
    const r = parseFieldRef(ref);
    if (!r || !isObj(value) || !Array.isArray(value.fields)) return null;
    const [j, k] = r;
    const list = k === null ? value.fields : isGroupField(value.fields[j]) ? value.fields[j].fields : null;
    const from = k === null ? j : k;
    const to = from + (dir < 0 ? -1 : 1);
    if (!list || from >= list.length || to < 0 || to >= list.length) return null;
    [list[from], list[to]] = [list[to], list[from]];
    return k === null ? String(to) : `${j}.${to}`;
}

function resetFieldType(f, type) {
    const keep = { key: fieldKeyOf(f), label: f.label };
    for (const k of Object.keys(f)) delete f[k];
    const t = FIELD_TYPES.includes(type) ? type : 'string';
    Object.assign(f, { key: keep.key, type: t });
    if (keep.label) f.label = keep.label;
    if (t === 'number') Object.assign(f, { min: 0, max: 100, init: 0, integer: true });
    else if (t === 'enum') Object.assign(f, { options: ['选项一', '选项二'], init: '选项一' });
    else if (t === 'boolean') f.init = false;
    else f.init = '';
}

/**
 * 改记录里一个字段的一项：key / label / type / init / min / max / integer / stages / options；分组只能改 key 和 label。
 * 换类型时按新类型给默认值（保留名字和显示名）。返回是否改了。
 */
export function setRecordFieldProp(value, ref, prop, raw) {
    const f = fieldAt(value, ref);
    if (!f) return false;
    if (isGroupField(f) && prop !== 'key' && prop !== 'label') return false;
    switch (prop) {
        case 'key':
            f.key = String(raw ?? '').trim();
            delete f.name;
            delete f.path;
            break;
        case 'label': {
            const s = String(raw ?? '').trim();
            if (s) f.label = s;
            else delete f.label;
            break;
        }
        case 'type':
            resetFieldType(f, String(raw ?? ''));
            break;
        case 'init':
            f.init = f.type === 'number' ? numOrNull(raw) : f.type === 'boolean' ? raw === true || raw === 'true' : String(raw ?? '');
            break;
        case 'min':
        case 'max':
            f[prop] = numOrNull(raw);
            break;
        case 'integer':
            f.integer = raw === true || raw === 'true';
            break;
        case 'stages':
            f.stages = parseStages(raw);
            break;
        case 'options':
            f.options = optionsOf({ options: raw });
            break;
        default:
            return false;
    }
    return true;
}

/**
 * 字段 / 分组的名字（改名前后各取一次，给 renameRecordEntryField）：{key, group}，group 是分组里字段所在分组的名字
 * （改分组本身或顶层字段时为 null）；引用不对时为 null。
 */
export function recordFieldNameAt(value, ref) {
    const f = fieldAt(value, ref);
    if (!f) return null;
    const r = parseFieldRef(ref);
    return { key: fieldKeyOf(f), group: r[1] === null ? null : fieldKeyOf(value.fields[r[0]]) };
}

/**
 * 记录的字段 / 分组改名时，把条目里已有的值搬到新名字下（在 commitRows 规范化之前做：规范化会把旧名字下的值当成多余的丢掉，
 * 新名字取默认值，填好的初始条目和示例数据就都没了）。entries 是 {条目名: 条目}；group 给出时改的是这个分组里的字段
 * （entry[group][旧] → entry[group][新]），否则是顶层字段或整个分组（entry[旧] → entry[新]）。
 * 条目里新名字已经有值的不动（不覆盖），键的顺序不变。返回搬了几个条目。
 */
export function renameRecordEntryField(entries, oldKey, newKey, group = null) {
    const from = String(oldKey ?? '');
    const to = String(newKey ?? '');
    if (!isObj(entries) || !from || !to || from === to || PROTO_KEYS.includes(from) || PROTO_KEYS.includes(to)) return 0;
    let n = 0;
    for (const entry of Object.values(entries)) {
        const target = group === null || group === undefined ? entry : isObj(entry) && Object.hasOwn(entry, group) ? entry[group] : null;
        if (!isObj(target) || !Object.hasOwn(target, from) || Object.hasOwn(target, to)) continue;
        const pairs = Object.entries(target).map(([k, v]) => [k === from ? to : k, v]);
        for (const k of Object.keys(target)) delete target[k];
        for (const [k, v] of pairs) target[k] = v;
        n++;
    }
    return n;
}

const fieldAttrs = (i, ref, prop) => `data-sb-row="${i}" data-sb-fld="${ref}" data-sb-fp="${prop}"`;

function fieldMsgsHtml(list) {
    if (!list?.length) return '';
    return `<div class="nl-sb-fld-msg">${list.map((m) => `<div class="${m.level === 'err' ? 'nl-err' : 'nl-warn'} nl-small">${icon('alert', { size: 12 })} ${esc(m.msg)}</div>`).join('')}</div>`;
}

function fieldInitHtml(i, ref, f, who) {
    const a = `${fieldAttrs(i, ref, 'init')} aria-label="${esc(`${who}：默认值`)}"`;
    if (f.type === 'number') return `<input class="nl-input" type="number" step="any" ${a} value="${esc(f.init ?? '')}" placeholder="默认值">`;
    if (f.type === 'boolean') return `<select class="nl-input" ${a}>${optionList([{ value: 'true', label: '是' }, { value: 'false', label: '否' }], f.init === true || f.init === 'true' ? 'true' : 'false')}</select>`;
    if (f.type === 'enum') {
        const opts = optionsOf(f);
        return opts.length
            ? `<select class="nl-input" ${a}>${optionList(opts, opts.includes(String(f.init)) ? f.init : opts[0])}</select>`
            : `<input class="nl-input" ${a} value="" placeholder="先填选项" disabled>`;
    }
    return `<input class="nl-input" ${a} value="${esc(f.init ?? '')}" placeholder="默认值">`;
}

function fieldExtraHtml(i, ref, f, who) {
    if (f.type === 'number') {
        return `<input class="nl-input nl-sb-fld-num" type="number" step="any" ${fieldAttrs(i, ref, 'min')} value="${esc(f.min ?? '')}" placeholder="最小" aria-label="${esc(`${who}：最小值`)}">
            <span class="nl-muted">~</span>
            <input class="nl-input nl-sb-fld-num" type="number" step="any" ${fieldAttrs(i, ref, 'max')} value="${esc(f.max ?? '')}" placeholder="最大" aria-label="${esc(`${who}：最大值`)}">
            <label class="nl-small"><input type="checkbox" ${fieldAttrs(i, ref, 'integer')} ${f.integer !== false ? 'checked' : ''} aria-label="${esc(`${who}：整数`)}"> 整数</label>
            <input class="nl-input nl-grow" ${fieldAttrs(i, ref, 'stages')} value="${esc(fmtStages(f.stages))}" placeholder="阶段（可选）：30 熟悉，60 亲近" aria-label="${esc(`${who}：阶段`)}">`;
    }
    if (f.type === 'enum') return `<input class="nl-input nl-grow" ${fieldAttrs(i, ref, 'options')} value="${esc(fmtOptions(f.options))}" placeholder="选项，用 / 分隔" aria-label="${esc(`${who}：选项`)}">`;
    return '';
}

function fieldActBtn(i, ref, act, ico, title, who, disabled) {
    return `<button class="nl-icon-btn${act === 'sb-fld-del' ? ' nl-danger' : ''}" data-act="${act}" data-sb-i="${i}" data-sb-fld="${ref}" ${disabled ? 'disabled' : ''} title="${esc(title)}" aria-label="${esc(`${who}：${title}`)}">${icon(ico)}</button>`;
}

function fieldRowHtml(i, ref, f0, issues, { who, first, last, canDelete = true, delTitle = '删除' }) {
    const f = isObj(f0) ? f0 : {};
    const msgs = issues.items[ref] || [];
    const bad = msgs.some((m) => m.level === 'err');
    const t = FIELD_TYPES.includes(f.type) ? f.type : 'string';
    const ff = { ...f, type: t };
    return `
        <div class="nl-sb-fld${bad ? ' is-bad' : ''}" data-sb-fld-item="${ref}">
            <input class="nl-input" ${fieldAttrs(i, ref, 'key')} value="${esc(fieldKeyOf(f))}" placeholder="字段名" aria-label="${esc(`${who}：名字`)}"${bad ? ' aria-invalid="true"' : ''}>
            <input class="nl-input" ${fieldAttrs(i, ref, 'label')} value="${esc(f.label ?? '')}" placeholder="显示名（可选）" aria-label="${esc(`${who}：显示名`)}">
            <select class="nl-input" ${fieldAttrs(i, ref, 'type')} aria-label="${esc(`${who}：类型`)}">${optionList(FIELD_TYPES.map((x) => ({ value: x, label: VAR_TYPE_LABELS[x] })), t)}</select>
            ${fieldInitHtml(i, ref, ff, who)}
            <div class="nl-sb-fld-extra">${fieldExtraHtml(i, ref, ff, who)}</div>
            <div class="nl-sb-fld-acts">${fieldActBtn(i, ref, 'sb-fld-up', 'arrowUp', '上移', who, first)}${fieldActBtn(i, ref, 'sb-fld-down', 'arrowDown', '下移', who, last)}${fieldActBtn(i, ref, 'sb-fld-del', 'trash', delTitle, who, !canDelete)}</div>
            ${fieldMsgsHtml(msgs)}
        </div>`;
}

const ROOM_FULL = '已到变量上限（在「设置 → 状态栏」里可以调高）';

const LAST_ITEM = '记录至少要有一项（改成数字或文本请用上面的「值的类型」）';

function groupHtml(i, j, g, issues, { first, last, remaining, only = false }) {
    const ref = String(j);
    const key = fieldKeyOf(g);
    const who = key ? `分组「${key}」` : `第 ${j + 1} 项（分组）`;
    const msgs = issues.items[ref] || [];
    const bad = msgs.some((m) => m.level === 'err');
    const n = issues.groups[ref] ?? 0;
    const kids = g.fields;
    const full = n >= GROUP_FIELD_MAX;
    const addTitle = full ? `一个分组最多 ${GROUP_FIELD_MAX} 个字段` : remaining <= 0 ? ROOM_FULL : '在这个分组里加一个字段';
    const rows = kids.map((f, k) => {
        const kk = fieldKeyOf(f);
        return fieldRowHtml(i, `${j}.${k}`, f, issues, {
            who: kk ? `字段「${key || '分组'}.${kk}」` : `${who}的第 ${k + 1} 个字段`,
            first: k === 0,
            last: k === kids.length - 1,
            canDelete: kids.length > 1,
            delTitle: kids.length > 1 ? '删除' : '分组至少要有一个字段（删除整个分组用分组右上角的按钮）',
        });
    }).join('');
    return `
        <div class="nl-sb-grp${bad ? ' is-bad' : ''}" data-sb-fld-item="${ref}" role="group" aria-label="${esc(who)}">
            <div class="nl-sb-grp-head">
                <span class="nl-tag">分组</span>
                <input class="nl-input" ${fieldAttrs(i, ref, 'key')} value="${esc(key)}" placeholder="分组名，如 服饰" aria-label="${esc(`${who}：名字`)}"${bad ? ' aria-invalid="true"' : ''}>
                <input class="nl-input" ${fieldAttrs(i, ref, 'label')} value="${esc(g.label ?? '')}" placeholder="显示名（可选）" aria-label="${esc(`${who}：显示名`)}">
                <span class="nl-muted nl-small nl-num" data-sb-grp-count>${n} / ${GROUP_FIELD_MAX} 个字段</span>
                <span class="nl-spacer"></span>
                <div class="nl-sb-fld-acts">${fieldActBtn(i, ref, 'sb-fld-up', 'arrowUp', '上移', who, first)}${fieldActBtn(i, ref, 'sb-fld-down', 'arrowDown', '下移', who, last)}${fieldActBtn(i, ref, 'sb-fld-del', 'trash', only ? LAST_ITEM : '删除分组', who, only)}</div>
            </div>
            ${fieldMsgsHtml(msgs)}
            <div class="nl-sb-grp-body">${rows}</div>
            <div class="nl-row"><button class="nl-btn nl-sm" data-act="sb-fld-add" data-sb-i="${i}" data-sb-fld="${ref}" ${full || remaining <= 0 ? 'disabled' : ''} title="${esc(addTitle)}">${icon('plus', { size: 14 })}在分组里添加字段</button></div>
        </div>`;
}

/**
 * 记录「多个字段」值的编辑器（变量表里记录那一行下面单独一行）：基本字段一行一个，分组是带边框的一组（只能一层）；
 * 底部「添加字段 / 添加分组」，以及原来的 JSON 编辑框（data-sb-k="fields"）。
 * @param {number} i 行号
 * @param {object} value 这一行（未规范化的）记录值 {type:'object', fields}
 * @param {{issues?: object, remaining?: number, json?: string|null, jsonOpen?: boolean, path?: string}} opt
 *   remaining：变量上限还剩几个（≤ 0 时不能再加字段；行本身不生效时传 Infinity）；json：JSON 框里保留的原文（解析失败时）
 */
export function recordFieldsEditorHtml(i, value, { issues = null, remaining = Infinity, json = null, jsonOpen = false, path = '' } = {}) {
    const iss = issues || recordFieldIssues(value);
    const fields = isObj(value) && Array.isArray(value.fields) ? value.fields : [];
    const full = iss.count >= RECORD_FIELD_MAX;
    const noRoom = remaining <= 0;
    const addTitle = full ? `一条记录最多 ${RECORD_FIELD_MAX} 项（分组算一项）` : noRoom ? ROOM_FULL : '';
    const only = fields.length <= 1;
    const items = fields.map((f, j) => {
        const pos = { first: j === 0, last: j === fields.length - 1 };
        if (isGroupField(f)) return groupHtml(i, j, f, iss, { ...pos, remaining, only });
        const key = fieldKeyOf(f);
        return fieldRowHtml(i, String(j), f, iss, { ...pos, who: key ? `字段「${key}」` : `第 ${j + 1} 个字段`, canDelete: !only, delTitle: only ? LAST_ITEM : '删除' });
    }).join('');
    const left = Number.isFinite(remaining) ? ` · 变量上限还剩 ${Math.max(0, remaining)} 个` : '';
    return `
        <div class="nl-sb-fields" data-sb-fields="${i}" role="group" aria-label="${esc(`记录「${path || `第 ${i + 1} 行`}」每个条目的字段`)}">
            <div class="nl-sb-fields-head"><b>每个条目的字段</b><span class="nl-muted nl-small nl-num" data-sb-fields-count>${iss.count} / ${RECORD_FIELD_MAX} 项（分组算一项）· 算 ${iss.leaves} 个变量${left}</span></div>
            ${iss.top.map((m) => `<div class="nl-warn nl-small">${icon('alert', { size: 12 })} ${esc(m)}</div>`).join('')}
            <div class="nl-sb-fld-list">${items}</div>
            <div class="nl-row nl-wrap">
                <button class="nl-btn nl-sm" data-act="sb-fld-add" data-sb-i="${i}" data-sb-fld="" ${full || noRoom ? 'disabled' : ''}${addTitle ? ` title="${esc(addTitle)}"` : ''}>${icon('plus', { size: 14 })}添加字段</button>
                <button class="nl-btn nl-sm" data-act="sb-grp-add" data-sb-i="${i}" ${full || noRoom ? 'disabled' : ''} title="${esc(addTitle || '把几个字段归成一组，例如 服饰：上衣 / 下装 / 配饰')}">${icon('plus', { size: 14 })}添加分组</button>
                <span class="nl-muted nl-small">分组把几个字段归在一起（例如 服饰：上衣 / 下装 / 配饰），界面里可以整组显示；分组里不能再分组，每组最多 ${GROUP_FIELD_MAX} 个字段。</span>
            </div>
            <details class="nl-sb-fields-json" ${jsonOpen ? 'open' : ''}><summary>用 JSON 编辑字段</summary>
                <textarea class="nl-input nl-textarea nl-mono" rows="4" data-sb-row="${i}" data-sb-k="fields" spellcheck="false" aria-label="字段（JSON）">${esc(json ?? JSON.stringify(fields))}</textarea></details>
        </div>`;
}

// ---------------- 立绘（card.statusBar.portraits）的编辑草稿 ----------------

/** 解锁条件比较方式的显示文字 */
const OP_LABELS = { '>=': '≥ 至少', '<=': '≤ 至多', '==': '= 等于' };
const PROTO_KEYS = ['__proto__', 'constructor', 'prototype'];

/**
 * 「一行一个地址」的文本 → [{line, url}]：只按换行拆，每行去掉首尾空白后整行就是一个地址（地址中间有空格时整行不合法，
 * 不会被拆成两个地址、把前半截当成能用的存下来）；line 是文本框里的行号（从 1 起，空行也算），空行不算地址。
 */
export function urlLines(text) {
    return String(text ?? '').split(/\r\n|\r|\n/).map((s, k) => ({ line: k + 1, url: s.trim() })).filter((x) => x.url);
}

const splitUrls = (text) => urlLines(text).map((x) => x.url);

function whenDraft(w) {
    return isObj(w) && String(w.path ?? '').trim()
        ? { path: String(w.path), op: PORTRAIT_OPS.includes(w.op) ? w.op : '>=', value: w.value === undefined || w.value === null ? '' : String(w.value) }
        : { path: '', op: '>=', value: '' };
}

/**
 * 立绘配置 → 编辑用的草稿（输入框里的原文，可以暂时不合法）：
 * {chars: [{name, images: [{url, label, when: {path, op, value}}]}], pools: [{record, field, values: [{value, urls}], fallback}]}
 * when.path 为空 = 不设解锁条件；图池的 urls / fallback 是一行一个地址的文本。
 */
export function portraitDraftFrom(p) {
    const src = isObj(p) ? p : {};
    const chars = Object.entries(isObj(src.characters) ? src.characters : {}).map(([name, list]) => ({
        name,
        images: (Array.isArray(list) ? list : []).map((img) => (isObj(img)
            ? { url: String(img.url ?? ''), label: String(img.label ?? ''), when: whenDraft(img.when) }
            : { url: String(img ?? ''), label: '', when: whenDraft(null) })),
    }));
    const pools = (Array.isArray(src.pools) ? src.pools : []).filter(isObj).map((pl) => ({
        record: String(pl.record ?? ''),
        field: String(pl.field ?? ''),
        values: Object.entries(isObj(pl.pools) ? pl.pools : {}).map(([value, urls]) => ({ value, urls: (Array.isArray(urls) ? urls : []).join('\n') })),
        fallback: (Array.isArray(pl.fallback) ? pl.fallback : []).join('\n'),
    }));
    return { chars, pools };
}

function imageRaw(img) {
    const out = { url: String(img?.url ?? '').trim() };
    const label = String(img?.label ?? '').trim();
    if (label) out.label = label;
    const w = img?.when;
    if (isObj(w) && String(w.path ?? '').trim()) out.when = { path: String(w.path).trim(), op: w.op || '>=', value: w.value };
    return out;
}

function poolRaw(p) {
    const pools = {};
    for (const v of Array.isArray(p?.values) ? p.values : []) {
        const key = String(v?.value ?? '').trim();
        if (key) pools[key] = [...(pools[key] || []), ...splitUrls(v.urls)];
    }
    return { record: String(p?.record ?? '').trim(), field: String(p?.field ?? '').trim(), pools, fallback: splitUrls(p?.fallback) };
}

/** 草稿 → 交给 normalizePortraits 的原始配置（角色用 [{name, images}] 形式，重名时由规范化合并并提示） */
export function portraitDraftToRaw(d) {
    return {
        characters: (Array.isArray(d?.chars) ? d.chars : []).map((c) => ({ name: String(c?.name ?? '').trim(), images: (Array.isArray(c?.images) ? c.images : []).map(imageRaw) })),
        pools: (Array.isArray(d?.pools) ? d.pools : []).map(poolRaw),
    };
}

/** 解锁条件的问题（没设条件或没问题时返回 ''），取舍与 normalizePortraits 一致 */
export function portraitWhenProblem(when) {
    const path = String(when?.path ?? '').trim().replace(/^\/+/, '').replace(/\//g, '.');
    if (!path) return '';
    const segs = path.split('.');
    if (segs.length > 4) return `变量路径「${path}」超过 4 层`;
    if (segs.some((s) => !s || s !== s.trim() || s.length > 32 || /[~"'`<>{}[\]\\\t\r\n]/.test(s) || PROTO_KEYS.includes(s))) return `变量路径「${path}」不合法`;
    const op = String(when?.op ?? '>=').trim();
    if (!PORTRAIT_OPS.includes(op)) return `不支持的比较「${op}」`;
    if (op !== '==') {
        const v = when?.value;
        const n = typeof v === 'boolean' || v === null || v === undefined || String(v).trim() === '' ? NaN : Number(v);
        if (!Number.isFinite(n)) return `「${OP_LABELS[op].slice(0, 1)}」要和数字比较`;
    }
    return '';
}

/** 一段「一行一个地址」的文本里不合法的行（整行检查）：[{line, url, problem}]，line 是文本框里的行号 */
function badUrlLines(text) {
    return urlLines(text).map((x) => ({ ...x, problem: portraitUrlProblem(x.url) })).filter((x) => x.problem);
}

function urlLinesMsg(text) {
    const bad = badUrlLines(text);
    const list = splitUrls(text);
    const out = [];
    if (bad.length) out.push({ level: 'err', msg: `${bad.slice(0, 3).map((x) => `第 ${x.line} 行：${x.problem}`).join('；')}${bad.length > 3 ? `；另有 ${bad.length - 3} 行` : ''}（这些不会保存）` });
    if (list.length - bad.length > PORTRAIT_LIMITS.poolImages) out.push({ level: 'warn', msg: `最多 ${PORTRAIT_LIMITS.poolImages} 张，多出的不会保存` });
    return out;
}

/**
 * 立绘草稿逐项检查（编辑器标红用），与 normalizePortraits 的取舍一致：
 * - 角色名不合法 → err（这个角色不会保存）；重名 → warn（图片会合在一起）
 * - 图片地址为空 → empty（提示填写）；地址不合法 → err（这张不会保存）；解锁条件不合法 → warn（条件不会保存，这张一直可用）
 * - 图池：没选记录 / 字段、没有任何可用的图片、与前面的图池重复 → err；记录不在变量表里 → warn；取值为空、地址不合法 → err
 * @returns {{chars: {name: {level: string, msg: string}, images: {level: ''|'empty'|'err'|'warn', msg: string}[]}[],
 *   pools: {msgs: {level, msg}[], values: {level, msg}[][], fallback: {level, msg}[]}[], errors: number}}
 */
export function portraitDraftIssues(draft, spec = null) {
    const out = { chars: [], pools: [], errors: 0 };
    const err = (msg) => {
        out.errors++;
        return { level: 'err', msg };
    };
    const names = new Set();
    for (const c of Array.isArray(draft?.chars) ? draft.chars : []) {
        const name = String(c?.name ?? '').trim();
        const np = portraitNameProblem(name);
        let nameInfo = { level: '', msg: '' };
        if (np) nameInfo = err(`${np}：这个角色的立绘不会保存`);
        else if (names.has(name)) nameInfo = { level: 'warn', msg: `前面已经有「${name}」：两处的图片会合在一起` };
        names.add(name);
        const images = (Array.isArray(c?.images) ? c.images : []).map((img) => {
            const url = String(img?.url ?? '').trim();
            if (!url) return { level: 'empty', msg: '填入图片地址：http(s):// 开头的图床地址，或者较小的 data:image' };
            const up = portraitUrlProblem(url);
            if (up) return err(`${up}：这张图不会保存`);
            const wp = portraitWhenProblem(img?.when);
            if (wp) return { level: 'warn', msg: `${wp}：这个解锁条件不会保存（这张图一直可用）` };
            return { level: '', msg: '' };
        });
        out.chars.push({ name: nameInfo, images });
    }
    const pools = new Set();
    for (const p of Array.isArray(draft?.pools) ? draft.pools : []) {
        const raw = poolRaw(p);
        const msgs = [];
        const w = [];
        const kept = normalizePortraits({ pools: [raw] }, { warnings: w, spec }).pools.length > 0;
        const id = JSON.stringify([raw.record, raw.field]);
        if (!raw.record) msgs.push(err('先选一个记录变量（例如 NPC）：这个图池不会保存'));
        else if (!raw.field) msgs.push(err('先选按哪个字段取图（例如 阵营）：这个图池不会保存'));
        else {
            for (const x of w) {
                if (/^图池已丢弃/.test(x)) msgs.push(err(`${x.replace(/^图池已丢弃：/, '')}：这个图池不会保存`));
                else if (/暂时不会生效/.test(x)) msgs.push({ level: 'warn', msg: x.replace(/^图池「[^」]*」：/, '') });
            }
            if (kept && pools.has(id)) msgs.push(err(`前面已经有按「${raw.record} · ${raw.field}」取图的图池：这个不会保存`));
            else if (!kept && !msgs.some((m) => m.level === 'err')) msgs.push(err('还没有可用的图片：这个图池不会保存'));
        }
        if (kept) pools.add(id);
        const seenVals = new Set();
        const values = (Array.isArray(p?.values) ? p.values : []).map((v) => {
            const key = String(v?.value ?? '').trim();
            const list = urlLinesMsg(v?.urls);
            if (!key && splitUrls(v?.urls).length) list.unshift({ level: 'err', msg: '先填字段的值：这一组图片不会保存' });
            else if (key && seenVals.has(key)) list.unshift({ level: 'warn', msg: `前面已经有「${key}」：两组图片会合在一起` });
            if (key) seenVals.add(key);
            return list;
        });
        const fallback = urlLinesMsg(p?.fallback);
        out.errors += [...values.flat(), ...fallback].filter((m) => m.level === 'err').length;
        out.pools.push({ msgs, values, fallback });
    }
    return out;
}

/**
 * 当前界面会不会显示立绘：自定义 HTML 不注入运行时；AI 设计的界面里没有 data-nl-portrait 时也不会显示。
 * @returns {{level: 'ok'|'warn', text: string}}
 */
export function portraitDisplayNote(sb) {
    const mode = sb?.mode || 'bind';
    if (mode === 'raw') return { level: 'warn', text: '「自定义 HTML」模式不注入 NovelLoom 运行时，立绘不会显示。要显示立绘，请在「界面」里改用 AI 设计或内置排版。' };
    const html = mode === 'bind' ? String(sb?.html || '').trim() : '';
    if (!html) return { level: 'ok', text: '内置排版会在记录的每个条目前、以及有立绘的分组标题里显示头像。' };
    if (/data-nl-portrait(?!-)/.test(html)) return { level: 'ok', text: `当前界面里有立绘位置（data-nl-portrait）${/data-nl-portrait-next/.test(html) ? '和换图按钮' : ''}。` };
    return { level: 'warn', text: '当前界面里没有立绘位置（data-nl-portrait），配置的立绘不会显示：可以在「界面」里让 AI 重写外观，或者改用内置排版。' };
}

/** 立绘编辑器里一组提示的内容（err 红、warn 黄、其余灰） */
export function msgLinesInner(list) {
    const cls = (l) => (l === 'err' ? 'nl-err' : l === 'warn' ? 'nl-warn' : 'nl-muted');
    return (list || []).filter((m) => m?.msg).map((m) => `<div class="${cls(m.level)} nl-small">${m.level === 'err' || m.level === 'warn' ? `${icon('alert', { size: 12 })} ` : ''}${esc(m.msg)}</div>`).join('');
}

function msgLinesHtml(list, attrs = '') {
    return `<div class="nl-sb-pt-msg" ${attrs}>${msgLinesInner(list)}</div>`;
}

/** 缩略图：合法地址才放 <img>（no-referrer、懒加载）；加载失败由对话框把 data-state 改成 error，显示警告图标 */
export function portraitThumbHtml(url, name, { size = '', alt = '' } = {}) {
    const u = String(url ?? '').trim();
    const ok = !!u && !portraitUrlProblem(u);
    const state = !u ? 'empty' : ok ? 'loading' : 'bad';
    return `<span class="nl-sb-thumb${size ? ` nl-sb-thumb-${size}` : ''}" data-sb-thumb-wrap data-state="${state}">`
        + `<span class="nl-sb-thumb-ph" aria-hidden="true">${esc(portraitInitial(name))}</span>`
        + (ok ? `<img data-sb-thumb src="${esc(u)}" alt="${esc(alt)}" referrerpolicy="no-referrer" loading="lazy" decoding="async">` : '')
        + `<span class="nl-sb-thumb-err" role="img" aria-label="${state === 'bad' ? '地址不合法' : '图片加载失败'}" title="${state === 'bad' ? '地址不合法' : '图片加载失败：检查地址能不能直接打开，或者图床是否禁止外链'}">${icon('alert', { size: 14 })}</span>`
        + '</span>';
}

/** 解锁条件里可以选的变量：条目自己的字段（相对路径）、固定分组里的变量（相对路径），以及其他变量的完整路径 */
function whenPathOptions(spec, name, record) {
    const out = [];
    const add = (p) => {
        if (p && !out.includes(p)) out.push(p);
    };
    const vars = spec?.variables || [];
    if (record) {
        const rv = vars.find((v) => v.path === record);
        for (const l of recordLeafFields(rv?.value)) add(l.path);
    } else {
        for (const v of vars) if (v.type !== 'record' && v.path.startsWith(`${name}.`)) add(v.path.slice(name.length + 1));
    }
    for (const v of vars) if (v.type !== 'record' && v.type !== 'list') add(v.path);
    return out.slice(0, 40);
}

function portraitImgRowHtml(ci, ii, img, info, { name, res, dl, count }) {
    const url = String(img?.url ?? '').trim();
    const valid = !!url && !portraitUrlProblem(url);
    const who = `第 ${ii + 1} 张`;
    const a = (k) => `data-sb-pt="${k}" data-sb-pt-c="${ci}" data-sb-pt-i="${ii}"`;
    const cur = valid && !res.pooled && res.url === url;
    const locked = valid && !res.urls.includes(url);
    const w = isObj(img?.when) ? img.when : {};
    const msgId = `nl-sb-pt-msg-${ci}-${ii}`;
    const btn = (act, ico, title, dis) => `<button class="nl-icon-btn${act === 'sb-pt-img-del' ? ' nl-danger' : ''}" data-act="${act}" data-sb-pt-c="${ci}" data-sb-pt-i="${ii}" ${dis ? 'disabled' : ''} title="${esc(title)}" aria-label="${esc(`${who}：${title}`)}">${icon(ico)}</button>`;
    const tags = `${cur ? '<span class="nl-tag nl-sb-tag-cur">默认显示</span>' : ''}${locked ? `<span class="nl-tag" title="按「预览」里的示例数据，还没达到解锁条件">${icon('lock', { size: 12 })}未解锁</span>` : ''}`;
    return `
        <div class="nl-sb-pt-img${info?.level === 'err' ? ' is-bad' : ''}${cur ? ' is-current' : ''}" data-sb-pt-row="${ci}.${ii}">
            ${portraitThumbHtml(url, name, { alt: `「${name}」${who}` })}
            <div class="nl-sb-pt-fields">
                <div class="nl-row">
                    <input class="nl-input nl-grow nl-mono" ${a('url')} value="${esc(url)}" placeholder="https://… 或 data:image/…;base64,…" spellcheck="false" autocomplete="off" aria-label="${esc(`${who}：图片地址`)}" aria-describedby="${msgId}"${info?.level === 'err' ? ' aria-invalid="true"' : ''}>
                    <input class="nl-input nl-sb-pt-label" ${a('label')} value="${esc(img?.label ?? '')}" maxlength="16" placeholder="说明（可选）" aria-label="${esc(`${who}：说明`)}">
                </div>
                <div class="nl-row nl-wrap nl-sb-pt-when">
                    <span class="nl-muted nl-small">解锁条件</span>
                    <input class="nl-input" ${a('whenPath')} list="${dl}" value="${esc(w.path ?? '')}" placeholder="不设（一直可用）" aria-label="${esc(`${who}：解锁条件的变量`)}">
                    <select class="nl-input nl-inline" ${a('whenOp')} aria-label="${esc(`${who}：比较方式`)}">${optionList(PORTRAIT_OPS.map((o) => ({ value: o, label: OP_LABELS[o] })), PORTRAIT_OPS.includes(w.op) ? w.op : '>=')}</select>
                    <input class="nl-input nl-sb-pt-val" ${a('whenValue')} value="${esc(w.value ?? '')}" placeholder="值" aria-label="${esc(`${who}：解锁条件的值`)}">
                    ${tags}
                </div>
                ${msgLinesHtml(info?.msg ? [info] : [], `id="${msgId}" data-sb-pt-msg="${ci}.${ii}"`)}
            </div>
            <div class="nl-sb-fld-acts">${btn('sb-pt-img-up', 'arrowUp', '上移', ii === 0)}${btn('sb-pt-img-down', 'arrowDown', '下移', ii === count - 1)}${btn('sb-pt-img-del', 'trash', '删除', false)}</div>
        </div>`;
}

function portraitCharHtml(ci, c, info, ctx) {
    const name = String(c?.name ?? '').trim();
    // 变量表里的条目优先；只在示例数据里出现的名字也知道它在哪个记录里（取图池、解锁条件按条目算），但标成示例数据
    const cand = [...ctx.cands, ...(ctx.sampleCands || [])].filter((x) => x.name === name);
    const hit = cand.find((x) => x.record && !x.sample) || cand.find((x) => x.record);
    const record = hit?.record || '';
    const kind = record ? (hit.sample ? 'sample' : 'record') : cand.length ? 'fixed' : 'free';
    const res = resolvePortrait(ctx.portraits, name, { record, stat: ctx.stat });
    const imgs = Array.isArray(c?.images) ? c.images : [];
    const where = kind === 'record' ? `「${record}」里的条目` : kind === 'sample' ? `「${record}」里的条目（示例数据）` : kind === 'fixed' ? '固定分组' : '自己填的名字';
    const pos = imgs.findIndex((x) => String(x?.url ?? '').trim() === res.url);
    // 同名的角色写了两处时规范化会把图片合在一起：默认那张可能在另一处
    const status = !imgs.length ? '还没有图片'
        : !res.url ? '示例数据下没有解锁的图：显示首字占位'
            : res.pooled ? '没有解锁的图：从图池里取'
                : pos >= 0 ? `默认显示第 ${pos + 1} 张` : `默认显示另一处「${name}」里的图`;
    const dl = `nl-sb-pt-paths-${ci}`;
    const full = imgs.length >= PORTRAIT_LIMITS.images;
    const label = name || '（未命名）';
    return `
        <section class="nl-sb-pt-char${info?.name?.level === 'err' ? ' is-bad' : ''}" data-sb-pt-char="${ci}" aria-label="${esc(`「${label}」的立绘`)}">
            <div class="nl-sb-pt-head">
                ${portraitThumbHtml(res.url, name, { size: 'sm', alt: '' })}
                <input class="nl-input nl-sb-pt-name" data-sb-pt="name" data-sb-pt-c="${ci}" value="${esc(c?.name ?? '')}" placeholder="名字" aria-label="角色名"${info?.name?.level === 'err' ? ' aria-invalid="true"' : ''}>
                <span class="nl-muted nl-small nl-num">${esc(where)} · ${imgs.length} 张 · ${esc(status)}</span>
                <span class="nl-spacer"></span>
                <button class="nl-btn nl-sm" data-act="sb-pt-add-img" data-sb-pt-c="${ci}" ${full ? `disabled title="每个角色最多 ${PORTRAIT_LIMITS.images} 张"` : ''}>${icon('plus', { size: 14 })}添加图片</button>
                <button class="nl-icon-btn nl-danger" data-act="sb-pt-del-char" data-sb-pt-c="${ci}" title="删除这个角色的立绘" aria-label="${esc(`删除「${label}」的立绘`)}">${icon('trash')}</button>
            </div>
            ${msgLinesHtml(info?.name?.msg ? [info.name] : [])}
            ${kind === 'free' && name ? `<div class="nl-muted nl-small">变量表里没有叫「${esc(name)}」的条目或分组：界面里写了 data-nl-portrait="${esc(name)}" 的位置才会用到。</div>` : ''}
            ${kind === 'sample' ? `<div class="nl-muted nl-small" data-sb-pt-sample-note>「${esc(name)}」只在示例数据里出现（模板或 AI 写的演示名字）：聊天里「${esc(record)}」有同名的条目时才会用到。</div>` : ''}
            <datalist id="${dl}">${whenPathOptions(ctx.spec, name, record).map((p) => `<option value="${esc(p)}"></option>`).join('')}</datalist>
            <div class="nl-sb-pt-imgs">${imgs.map((img, ii) => portraitImgRowHtml(ci, ii, img, info?.images?.[ii], { name, res, dl, count: imgs.length })).join('')
                || '<div class="nl-muted nl-small nl-sb-pt-none">还没有图片：点「添加图片」，填入图床地址。</div>'}</div>
        </section>`;
}

function portraitPoolHtml(pi, pool, info, ctx) {
    const recs = ctx.records;
    const rec = recs.find((r) => r.path === pool.record);
    const recOpts = recs.map((r) => ({ value: r.path, label: r.path }));
    if (pool.record && !rec) recOpts.unshift({ value: pool.record, label: `${pool.record}（变量表里没有）` });
    if (!pool.record) recOpts.unshift({ value: '', label: '选择记录…' });
    const leaves = rec ? recordLeafFields(rec.value).map((l) => l.path) : [];
    const a = (k, extra = '') => `data-sb-pool="${k}" data-sb-pool-p="${pi}"${extra}`;
    let fieldCtl;
    if (leaves.length) {
        const opts = leaves.map((x) => ({ value: x, label: x }));
        if (pool.field && !leaves.includes(pool.field)) opts.unshift({ value: pool.field, label: `${pool.field}（没有这个字段）` });
        if (!pool.field) opts.unshift({ value: '', label: '选择字段…' });
        fieldCtl = `<select class="nl-input nl-inline" ${a('field')} aria-label="按哪个字段取图">${optionList(opts, pool.field)}</select>`;
    } else fieldCtl = `<input class="nl-input" ${a('field')} value="${esc(pool.field)}" placeholder="字段名，如 阵营" aria-label="按哪个字段取图">`;
    const leaf = rec ? recordLeafFields(rec.value).find((l) => l.path === pool.field) : null;
    const dl = `nl-sb-pool-vals-${pi}`;
    const values = Array.isArray(pool.values) ? pool.values : [];
    const valRows = values.map((v, vi) => {
        const key = String(v?.value ?? '').trim();
        const who = key ? `取值「${key}」` : `第 ${vi + 1} 个取值`;
        return `
            <div class="nl-sb-pool-val" data-sb-pool-row="${pi}.${vi}">
                <input class="nl-input" ${a('value', ` data-sb-pool-v="${vi}"`)} list="${dl}" value="${esc(v?.value ?? '')}" placeholder="字段的值，如 敌对" aria-label="${esc(`${who}：字段的值`)}">
                <div class="nl-sb-pool-urls">
                    <textarea class="nl-input nl-textarea nl-mono" rows="2" ${a('urls', ` data-sb-pool-v="${vi}"`)} spellcheck="false" placeholder="图片地址，一行一个" aria-label="${esc(`${who}：图片地址（一行一个）`)}">${esc(v?.urls ?? '')}</textarea>
                    <div class="nl-sb-thumbs">${splitUrls(v?.urls).slice(0, PORTRAIT_LIMITS.poolImages).map((u) => portraitThumbHtml(u, key || '?', { size: 'xs' })).join('')}</div>
                    ${msgLinesHtml(info?.values?.[vi], `data-sb-pool-msg="${pi}.${vi}"`)}
                </div>
                <button class="nl-icon-btn nl-danger" data-act="sb-pool-val-del" data-sb-pool-p="${pi}" data-sb-pool-v="${vi}" title="删除这个取值" aria-label="${esc(`删除${who}`)}">${icon('trash')}</button>
            </div>`;
    }).join('');
    const fullVals = values.length >= PORTRAIT_LIMITS.values;
    const label = pool.record && pool.field ? `「${pool.record} · ${pool.field}」` : `第 ${pi + 1} 个`;
    return `
        <section class="nl-sb-pt-pool${info?.msgs?.some((m) => m.level === 'err') ? ' is-bad' : ''}" data-sb-pool-box="${pi}" aria-label="${esc(`${label}图池`)}">
            <div class="nl-sb-pt-head">
                <span class="nl-small nl-muted">记录</span>
                <select class="nl-input nl-inline" ${a('record')} aria-label="图池用于哪个记录">${optionList(recOpts, pool.record)}</select>
                <span class="nl-small nl-muted">按字段</span>
                ${fieldCtl}
                <span class="nl-spacer"></span>
                <button class="nl-icon-btn nl-danger" data-act="sb-pool-del" data-sb-pool-p="${pi}" title="删除这个图池" aria-label="${esc(`删除${label}图池`)}">${icon('trash')}</button>
            </div>
            ${msgLinesHtml(info?.msgs)}
            <datalist id="${dl}">${(leaf?.field?.type === 'enum' ? leaf.field.options : []).map((o) => `<option value="${esc(o)}"></option>`).join('')}</datalist>
            <div class="nl-sb-pool-vals">${valRows || '<div class="nl-muted nl-small">还没有取值：点「添加取值」，例如 阵营 = 敌对 时用哪几张图。</div>'}</div>
            <div class="nl-row"><button class="nl-btn nl-sm" data-act="sb-pool-val-add" data-sb-pool-p="${pi}" ${fullVals ? `disabled title="最多 ${PORTRAIT_LIMITS.values} 个取值"` : ''}>${icon('plus', { size: 14 })}添加取值</button></div>
            <div class="nl-field"><label for="nl-sb-pool-fb-${pi}">兜底：字段的值没有对应的图片时用（一行一个）</label>
                <textarea class="nl-input nl-textarea nl-mono" rows="2" id="nl-sb-pool-fb-${pi}" ${a('fallback')} spellcheck="false" placeholder="可选">${esc(pool.fallback ?? '')}</textarea>
                <div class="nl-sb-thumbs">${splitUrls(pool.fallback).slice(0, PORTRAIT_LIMITS.poolImages).map((u) => portraitThumbHtml(u, '?', { size: 'xs' })).join('')}</div>
                ${msgLinesHtml(info?.fallback, `data-sb-pool-msg="${pi}.f"`)}
            </div>
        </section>`;
}

/**
 * 「立绘」分页的内容（纯 HTML，对话框负责事件）。
 * @param {{draft: object, spec?: object, sample?: object, portraits?: object, sb?: object, notes?: string[], newName?: string, newMsg?: string}} o
 *   draft：portraitDraftFrom 的草稿；portraits：规范化后正在生效的配置（取图状态按它和示例数据 sample 计算）；
 *   sb：用来判断当前界面会不会显示立绘；notes：保存时规范化给出的其他提示；newName / newMsg：「添加」输入框的内容与提示
 */
export function portraitsPanelHtml({ draft, spec = null, sample = null, portraits = null, sb = null, notes = [], newName = '', newMsg = '' }) {
    const d = { chars: Array.isArray(draft?.chars) ? draft.chars : [], pools: Array.isArray(draft?.pools) ? draft.pools : [] };
    const issues = portraitDraftIssues(d, spec);
    const ctx = {
        spec,
        stat: isObj(sample) ? sample : {},
        portraits: portraits || normalizePortraits(portraitDraftToRaw(d), { spec }),
        // 变量表里的角色（按角色名记的记录的初始条目 + 固定分组）；只在示例数据里出现的名字单独列出、标成「示例数据」
        cands: portraitCandidates(spec),
        sampleCands: portraitSampleCandidates(spec, sample),
        records: (spec?.variables || []).filter((v) => v.type === 'record'),
    };
    const used = new Set(d.chars.map((c) => String(c?.name ?? '').trim()));
    const free = ctx.cands.filter((x) => !used.has(x.name));
    const freeSample = ctx.sampleCands.filter((x) => !used.has(x.name) && !free.some((y) => y.name === x.name))
        .filter((x, k, all) => all.findIndex((y) => y.name === x.name) === k);
    const disp = portraitDisplayNote(sb);
    const fullChars = d.chars.length >= PORTRAIT_LIMITS.characters;
    const chipHtml = (x, title, extra = '') => `<button class="nl-btn nl-sm" data-act="sb-pt-add-name" data-sb-name="${esc(x.name)}"${extra} title="${esc(title)}" ${fullChars ? 'disabled' : ''}>${icon('plus', { size: 14 })}${esc(x.name)}</button>`;
    const chips = free.slice(0, 24).map((x) => chipHtml(x, x.record ? `「${x.record}」里的条目` : '固定分组')).join('');
    const sampleChips = freeSample.slice(0, 12).map((x) => chipHtml(x, `示例数据：「${x.record}」里只有示例数据才有的条目（模板或 AI 写的演示名字，不一定是这个故事里的角色）`, ' data-sb-sample')).join('');
    return `
        <div class="nl-card-desc">给角色配上立绘图片（你自己配置，不由 AI 生成）。状态栏里带 data-nl-portrait 的位置显示当前的图，换图按钮在已解锁的图之间轮换，玩家手动选的图记在他自己的浏览器里；没有图或图片打不开时显示名字首字的占位。只支持 http(s) 图床地址和较小的 data:image（不支持 svg）。</div>
        ${disp.level === 'warn'
        ? `<div class="nl-sb-note nl-sb-note-warn" data-sb-pt-display>${icon('alert')}<div class="nl-grow">${esc(disp.text)}</div></div>`
        : `<div class="nl-ok nl-small" data-sb-pt-display>${icon('check', { size: 14 })} ${esc(disp.text)}</div>`}
        <h4>角色立绘</h4>
        <div class="nl-muted nl-small">每个角色一组图片，按解锁顺序从上往下排：默认显示最后一张已解锁的图。解锁条件按条目自己的变量判断（例如 好感 ≥ 60），也可以写完整路径（例如 世界.章节 ≥ 3）。「默认显示」「未解锁」按「预览」里的示例数据计算。</div>
        <div class="nl-sb-pt-add">
            ${chips ? `<div class="nl-row nl-wrap nl-sb-pt-chips" role="group" aria-label="变量表里的角色">${chips}</div>` : ''}
            ${sampleChips ? `<div class="nl-row nl-wrap nl-sb-pt-chips" role="group" aria-label="示例数据里的名字" data-sb-pt-sample-chips><span class="nl-muted nl-small" title="只在「预览」的示例数据里出现：模板或 AI 写的演示名字，不一定是这个故事里的角色">示例数据：</span>${sampleChips}</div>` : ''}
            <div class="nl-row">
                <input class="nl-input nl-grow" data-sb-pt-new list="nl-sb-pt-cands" value="${esc(newName)}" placeholder="输入名字：记录的条目名、分组名，或界面里 data-nl-portrait 写的名字" aria-label="要添加立绘的名字" aria-describedby="nl-sb-pt-new-msg" ${fullChars ? 'disabled' : ''}>
                <datalist id="nl-sb-pt-cands">${free.map((x) => `<option value="${esc(x.name)}"></option>`).join('')}${freeSample.map((x) => `<option value="${esc(x.name)}" label="示例数据"></option>`).join('')}</datalist>
                <button class="nl-btn" data-act="sb-pt-add-char" ${fullChars ? `disabled title="最多 ${PORTRAIT_LIMITS.characters} 个角色"` : ''}>${icon('plus', { size: 14 })}添加</button>
            </div>
            <div class="nl-err nl-small" id="nl-sb-pt-new-msg" data-sb-pt-new-msg role="alert">${esc(newMsg)}</div>
        </div>
        <div class="nl-sb-pt-list">${d.chars.map((c, ci) => portraitCharHtml(ci, c, issues.chars[ci], ctx)).join('')
            || emptyState('从上面挑一个角色，或者输入名字添加。没有配置立绘时，状态栏的立绘位置显示名字首字的占位。', '', { title: '还没有立绘', ico: 'image' })}</div>
        <h4>图池</h4>
        <div class="nl-muted nl-small">没有自己立绘的条目（例如剧情里途中出场的 NPC）按某个字段的值从图池里挑一张；按名字固定挑选，不会每轮变化。</div>
        ${ctx.records.length ? '' : '<div class="nl-muted nl-small">变量表里还没有记录变量：图池按记录条目的字段取图，先在「变量」里加一个记录（例如 NPC）。</div>'}
        <div class="nl-sb-pt-list">${d.pools.map((p, pi) => portraitPoolHtml(pi, p, issues.pools[pi], ctx)).join('')}</div>
        <div class="nl-row nl-wrap">
            <button class="nl-btn nl-sm" data-act="sb-pool-add" ${!ctx.records.length || d.pools.length >= PORTRAIT_LIMITS.pools ? 'disabled' : ''}>${icon('plus', { size: 14 })}添加图池</button>
            <span class="nl-spacer"></span>
            <button class="nl-btn nl-sm" data-act="sb-goto-preview" title="在「预览」里看立绘和换图按钮的效果">${icon('eye', { size: 14 })}在预览里看效果</button>
        </div>
        ${issues.errors ? `<div class="nl-err nl-small" data-sb-pt-bad>${icon('alert', { size: 12 })} 有 ${issues.errors} 处标红：改好之前它们不会保存，关闭对话框后会被丢弃。</div>` : ''}
        ${notes.length ? `<div class="nl-warn nl-small" data-sb-pt-notes>${notes.map((n) => esc(n)).join('<br>')}</div>` : ''}`;
}

/**
 * 「立绘」分页里删掉一项、重绘之后焦点放到哪儿：返回按优先顺序排的选择器，对话框取第一个存在且可用的。
 * 依次是同一层的下一项（删掉后它挪到了原来的位置）、上一项、这一组的「添加」、外层的删除按钮，最后是添加名字的输入框、
 * 「添加」按钮和「立绘」分页按钮（总有一个在），焦点不会掉到 <body> 上。按删除之后的草稿计算。
 * @param {'sb-pt-img-del'|'sb-pt-del-char'|'sb-pool-del'|'sb-pool-val-del'} act
 * @param {{chars?: object[], pools?: object[]}} draft 删除之后的草稿
 * @param {{ci?: number, ii?: number, pi?: number, vi?: number}} at 删掉的那一项原来的位置
 * @returns {string[]}
 */
export function portraitDeleteFocus(act, draft, { ci = 0, ii = 0, pi = 0, vi = 0 } = {}) {
    const chars = Array.isArray(draft?.chars) ? draft.chars : [];
    const pools = Array.isArray(draft?.pools) ? draft.pools : [];
    const out = [];
    // 删掉第 k 项后还剩 n 项：先下一项（现在的第 k 项），再上一项
    const near = (k, n, sel) => {
        if (k < n) out.push(sel(k));
        if (k - 1 >= 0 && k - 1 < n) out.push(sel(k - 1));
    };
    const imgDel = (c) => (i) => `[data-act="sb-pt-img-del"][data-sb-pt-c="${c}"][data-sb-pt-i="${i}"]`;
    const charDel = (c) => `[data-act="sb-pt-del-char"][data-sb-pt-c="${c}"]`;
    const valDel = (p) => (v) => `[data-act="sb-pool-val-del"][data-sb-pool-p="${p}"][data-sb-pool-v="${v}"]`;
    const poolDel = (p) => `[data-act="sb-pool-del"][data-sb-pool-p="${p}"]`;
    if (act === 'sb-pt-img-del') {
        near(ii, Array.isArray(chars[ci]?.images) ? chars[ci].images.length : 0, imgDel(ci));
        if (ci < chars.length) out.push(`[data-act="sb-pt-add-img"][data-sb-pt-c="${ci}"]`, charDel(ci));
    } else if (act === 'sb-pt-del-char') {
        near(ci, chars.length, charDel);
    } else if (act === 'sb-pool-val-del') {
        near(vi, Array.isArray(pools[pi]?.values) ? pools[pi].values.length : 0, valDel(pi));
        if (pi < pools.length) out.push(`[data-act="sb-pool-val-add"][data-sb-pool-p="${pi}"]`, poolDel(pi));
    } else if (act === 'sb-pool-del') {
        near(pi, pools.length, poolDel);
        out.push('[data-act="sb-pool-add"]');
    }
    out.push('[data-sb-pt-new]', '[data-act="sb-pt-add-char"]', '[data-act="sb-tab"][data-tab="portraits"]');
    return out;
}

/**
 * 预览页面发来的 {type:'nl-store', key, value}：预览里跑的是 AI 写的界面代码，消息不可信。先用 portraitChoiceProblem 把关
 * （本卡前缀的键；值只能是 null = 回到默认，或这张卡配置的某张立绘的地址；本卡记着的条数、字数有上限），合格的才交给
 * writePortraitChoice 写进酒馆页面的本地存储。给了 opt.stat（预览正在显示的数据）时，名字还必须是预览里能换图的角色
 * （portraitChoiceNames：配置了立绘的角色、配了图池的记录在这份数据里的条目），造出来的名字不会占掉本卡的条数上限。
 * @param {object} card
 * @param {{key?: unknown, value?: unknown}} data 消息内容
 * @param {Storage|null} [storage] 默认是当前页面的 localStorage（测试时传入）
 * @param {{stat?: object|null}} [opt]
 * @returns {string} 记下了为空串，否则是拒绝的原因
 */
export function acceptPreviewStore(card, data, storage = undefined, { stat } = {}) {
    const key = data?.key;
    const value = data?.value === null ? null : data?.value;
    const problem = portraitChoiceProblem(card, key, value, storage, stat === undefined ? {} : { data: stat });
    if (problem) return problem;
    return writePortraitChoice(card, key, value, storage) ? '' : '没有记下';
}

/** 立绘草稿里新名字的问题（没问题返回 ''）：名字规则同 portraitNameProblem，不能和已有的重名 */
export function portraitNewNameProblem(draft, name) {
    const n = String(name ?? '').trim();
    if (!n) return '请输入名字';
    const p = portraitNameProblem(n);
    if (p) return p;
    if ((draft?.chars || []).some((c) => String(c?.name ?? '').trim() === n)) return `「${n}」已经在下面了`;
    if ((draft?.chars || []).length >= PORTRAIT_LIMITS.characters) return `最多 ${PORTRAIT_LIMITS.characters} 个角色`;
    return '';
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
    // charName：路径里 {{char}} 换成的名字（世界/旁白卡是旁白，见 statusBarCharName）；displayName：标题和日志里的卡片名
    const charName = statusBarCharName(card);
    const displayName = card.data?.name || card.charName || charName;
    const world = isWorldCard(card);
    // 变量表的上限（statusBarVarCap，与卡片列表等处同一个规则）：设置里的上限、卡片记着的上限（statusBar.maxVars：沿用结构套用
    // 「多人群像」这类模板时记下的 15）、这次编辑中卡上有过的变量数，三者取最大——卡上已有的变量不会因为设置里的上限调小了、
    // 或之后「只借外观」换了模板而在编辑时被当成超出上限丢掉，删掉几个之后也还能加回来。套用模板后 statusBar.maxVars 会变，所以每次现取。
    // 变量表被整个换掉（AI 生成、撤销、套用模板，都会 resetDraft）时 seenLeaves 跟着取最大：撤销回来的变量也不会被截掉。
    // AI 整体重新设计变量时用设置里的上限（与 generateStatusBar 一致）
    let seenLeaves = countSpecLeaves(sb.spec);
    const tableCap = () => statusBarVarCap(card, c.settings, { leaves: seenLeaves });
    const aiCap = () => templateVarCap(null, c.settings);
    const capTitle = () => {
        const cap = tableCap();
        const base = aiCap();
        if (cap <= base) return '变量上限在「设置 → 状态栏」里改；记录的每个字段各算一个';
        const why = Number(sb.maxVars) >= cap ? '套用的模板自带更大的上限' : '这次编辑中卡上已经有过这么多变量';
        return `这张卡的变量上限是 ${cap}（${why}；设置里的上限是 ${base}）；记录的每个字段各算一个`;
    };
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
        flash: null, // {level: 'ok'|'warn', text}：变量表下面的一次性提示
        sample: null,
        sampleMsg: '',
        reply: '',
        simMsg: '',
        width: 375,
        bg: 'dark',
        previewErrors: [],
        // 立绘：编辑草稿（可以暂时不合法，标红的不保存）、保存时规范化给出的其他提示、「添加」输入框
        pt: portraitDraftFrom(sb.portraits),
        ptNotes: [],
        ptNew: '',
        ptNewMsg: '',
    };
    const box = document.createElement('div');
    box.className = 'nl-sb';

    const saveSoon = debounce(() => c.save(), 600);
    const touch = () => {
        sb.updatedAt = Date.now();
        saveSoon();
    };

    const resetDraft = () => {
        seenLeaves = Math.max(seenLeaves, countSpecLeaves(sb.spec));
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
        const spec = normalizeStatusSpec({ title: st.title, variables: st.rows }, { charName, maxVars: tableCap(), warnings });
        const finalByPath = new Map(spec.variables.map((v) => [v.path, v]));
        const seen = new Set();
        const infos = st.rows.map((row) => {
            const w = [];
            // 记录的「多个字段」值：逐项检查（字段编辑器里就地标红），规范化给出的同类提示不再在行下重复
            const fields = isObj(row) && row.type === 'record' && isObj(row.value) && (row.value.type === 'object' || Array.isArray(row.value.fields))
                ? recordFieldIssues(row.value) : null;
            const notField = (x) => !fields || !FIELD_WARN_RE.test(x);
            const one = isObj(row) ? normalizeStatusSpec({ variables: [row] }, { charName, maxVars: 999, warnings: w }).variables[0] : null;
            if (!one) return { ok: false, msgs: w.length ? w : ['这一行不合法'], warns: [], range: [], all: w, fields };
            if (!finalByPath.has(one.path) || seen.has(one.path)) {
                const m = warnings.filter((x) => x.includes(`「${one.path}」`) && !w.includes(x));
                return { ok: false, msgs: m.length ? m : ['与其他变量冲突，或超出了变量上限'], warns: w.filter(notField), range: [], all: [...w, ...m], fields };
            }
            seen.add(one.path);
            const norm = finalByPath.get(one.path);
            const range = rowRangeWarnings(row, norm);
            // 规范化自己也可能报同样的范围问题：已经有逐项说明时不再重复
            const warns = (range.length ? w.filter((x) => !RANGE_WARN_RE.test(x)) : w).filter(notField);
            return { ok: true, msgs: [], warns, range, all: w, norm, fields };
        });
        return { spec, warnings, infos };
    };

    const commitRows = () => {
        st.flash = null; // 上一次操作的结果提示（填入主要角色等）：一改表格就收起
        const r = validate();
        sb.spec = r.spec;
        // 有范围问题、或字段编辑器里有标红 / 提示的行保留用户填的值（规范化后的值已经生效，就地有说明），
        // 其余换成规范化后的样子（否则名字填错的字段会被规范化直接丢掉，编辑器里就看不到了）
        const keepRaw = (x) => x.range.length || (x.fields && (x.fields.errors || x.fields.warns || x.fields.top.length));
        st.rows = st.rows.map((row, i) => (r.infos[i].ok && !keepRaw(r.infos[i]) ? clone(r.infos[i].norm) : row));
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
                <span class="nl-muted nl-small nl-num" data-sb-count title="${esc(capTitle())}">${n ? `${esc(varCountText(sb.spec, tableCap()))} · ${esc(MODE_LABELS[sb.mode] || sb.mode)}` : '还没有变量'}</span>
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
        const pt = sb.portraits || {};
        const ptN = Object.keys(pt.characters || {}).length + (pt.pools || []).length;
        const ptBad = portraitDraftIssues(st.pt, sb.spec).errors > 0;
        return statusTabsHtml(st.tab, {
            vars: sb.spec.variables.length ? ` <span class="nl-muted nl-num" title="${esc(varCountText(sb.spec, tableCap()))}">${countSpecLeaves(sb.spec)}</span>` : '',
            ui: blocked ? dot : '',
            portraits: ptBad ? dot : ptN ? ` <span class="nl-muted nl-num" title="${esc(`配置了 ${Object.keys(pt.characters || {}).length} 个角色的立绘、${(pt.pools || []).length} 个图池`)}">${ptN}</span>` : '',
            export: blocked ? dot : '',
        });
    };

    const panelHtml = () => {
        switch (st.tab) {
            case 'rules': return rulesPanel();
            case 'ui': return uiPanel();
            case 'portraits': return portraitsPanel();
            case 'preview': return previewPanel();
            case 'export': return exportPanel();
            default: return varsPanel();
        }
    };

    // ---------- 变量 ----------
    /** 把片段里的 data-k="字段" 换成 data-sb-row="行" data-sb-k="字段" */
    const withRow = (i, inner) => inner.replace(/data-k="/g, `data-sb-row="${i}" data-sb-k="`);

    const initCell = (v, i, info = null) => {
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
            case 'record': {
                // 世界/旁白卡的主要角色记录：可以一键把项目里的主要角色（到这张卡的时间点为止）加进初始条目（NPC、物品等记录没有）
                const seed = seedCastAllowed(world, sb.spec, info?.ok ? info.norm?.path : '') ? `<button class="nl-btn nl-sm" data-act="sb-seed-cast" data-sb-i="${i}" title="把项目里到这张卡的时间点为止出场的主要角色加进初始条目（已有的不变）">${icon('users', { size: 14 })}填入主要角色</button>` : '';
                return withRow(i, `<textarea class="nl-input nl-textarea nl-mono" rows="2" data-k="init" spellcheck="false" placeholder='{"名字": …}' aria-label="初始值（JSON）">${esc(raw ?? JSON.stringify(v.init ?? {}))}</textarea>`) + seed;
            }
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
                const vt = recordValueKind(val);
                return withRow(i, `
                    <input class="nl-input" data-k="keyDesc" value="${esc(v.keyDesc ?? '')}" placeholder="键的含义，如 角色名" aria-label="键的含义">
                    <select class="nl-input" data-k="valueType" aria-label="值的类型">${optionList([{ value: 'number', label: '值：数字' }, { value: 'string', label: '值：文本' }, { value: 'object', label: '值：多个字段' }], vt)}</select>
                    ${vt === 'number' ? `<div class="nl-row"><input class="nl-input" type="number" step="any" data-k="vmin" value="${esc(val.min ?? '')}" placeholder="最小" aria-label="值的最小值"><span class="nl-muted">~</span><input class="nl-input" type="number" step="any" data-k="vmax" value="${esc(val.max ?? '')}" placeholder="最大" aria-label="值的最大值"></div>` : ''}
                    ${vt === 'object' ? '<div class="nl-muted nl-small">字段在下面一行编辑</div>' : ''}`);
            }
            default:
                return '<span class="nl-muted">—</span>';
        }
    };

    /** 记录「多个字段」值的字段编辑器：表格里记录那一行下面单独一行（room：变量上限还剩几个） */
    const fieldsRowHtml = (v, i, info, room) => {
        if (v?.type !== 'record' || !isObj(v.value) || recordValueKind(v.value) !== 'object') return '';
        const json = st.rawEdits[`${i}:fields`];
        return `<tr class="nl-sb-fields-row ${info.ok ? '' : 'nl-sb-bad'}" data-sb-fields-row="${i}"><td colspan="8">${recordFieldsEditorHtml(i, v.value, {
            issues: info.fields || null,
            remaining: info.ok ? room : Infinity,
            json: json ?? null,
            jsonOpen: json !== undefined,
            path: v.path || '',
        })}</td></tr>`;
    };

    const rowHtml = (v, i, info, last, room = Infinity) => {
        const t = VAR_TYPES.includes(v?.type) ? v.type : 'string';
        const widgets = TYPE_WIDGETS[t] || ['text'];
        const msgs = [...info.msgs, ...(st.rawEdits[`${i}:err`] ? [st.rawEdits[`${i}:err`]] : [])];
        const leaves = info.norm ? variableLeafCount(info.norm) : 1;
        return `
            <tr class="${info.ok ? '' : 'nl-sb-bad'}" data-sb-tr="${i}">
                <td>${withRow(i, `<input class="nl-input" data-k="path" value="${esc(v?.path ?? '')}" placeholder="分组.变量" aria-label="路径">`)}${v?.path && isReadonlyPath(v.path) ? '<div class="nl-muted nl-small">只读（AI 不更新）</div>' : ''}${leaves > 1 ? `<div class="nl-muted nl-small" data-sb-leaves>算 ${leaves} 个变量（每个字段各算一个）</div>` : ''}</td>
                <td>${withRow(i, `<input class="nl-input" data-k="label" value="${esc(v?.label ?? '')}" aria-label="名称">`)}</td>
                <td>${withRow(i, `<select class="nl-input" data-k="type" aria-label="类型">${optionList(VAR_TYPES.map((x) => ({ value: x, label: VAR_TYPE_LABELS[x] })), t)}</select>`)}</td>
                <td class="nl-sb-col-init">${initCell({ ...v, type: t }, i, info)}</td>
                <td class="nl-sb-col-range"><div class="nl-sb-stack">${rangeCell({ ...v, type: t }, i)}</div></td>
                <td>${withRow(i, `<select class="nl-input" data-k="widget" aria-label="显示方式">${optionList(widgets.map((w) => ({ value: w, label: WIDGET_LABELS[w] || w })), widgets.includes(v?.widget) ? v.widget : widgets[0])}</select>`)}</td>
                <td>${withRow(i, `<input class="nl-input" data-k="desc" value="${esc(v?.desc ?? '')}" placeholder="（可选）" aria-label="说明">`)}</td>
                <td class="nl-sb-col-act">
                    <button class="nl-icon-btn" data-act="sb-row-up" data-sb-i="${i}" ${i === 0 ? 'disabled' : ''} title="上移" aria-label="上移">${icon('arrowUp')}</button>
                    <button class="nl-icon-btn" data-act="sb-row-down" data-sb-i="${i}" ${last ? 'disabled' : ''} title="下移" aria-label="下移">${icon('arrowDown')}</button>
                    <button class="nl-icon-btn nl-danger" data-act="sb-row-del" data-sb-i="${i}" title="删除" aria-label="删除">${icon('trash')}</button>
                </td>
            </tr>
            ${msgs.length || info.warns.length || info.range.length ? `<tr class="nl-sb-rowmsg ${info.ok ? '' : 'nl-sb-bad'}"><td colspan="8">${msgs.map((m) => `<div class="nl-err nl-small">${icon('alert', { size: 12 })} ${esc(m)}${info.ok ? '' : '（这一行没有生效）'}</div>`).join('')}${info.range.map((m) => `<div class="nl-warn nl-small" data-sb-range>${icon('alert', { size: 12 })} ${esc(m)}</div>`).join('')}${info.warns.map((m) => `<div class="nl-warn nl-small">${esc(m)}</div>`).join('')}</td></tr>` : ''}
            ${fieldsRowHtml({ ...v, type: t }, i, info, room)}`;
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
                    <textarea class="nl-input nl-textarea" rows="2" data-sb-f="requirement" placeholder="${world ? '例如：主要角色记录好感、心情和服饰；NPC 只记身份和阵营' : '例如：重点记录好感和体力；记录随身物品'}">${esc(sb.requirement || '')}</textarea></div>
                ${emptyState(world ? WORLD_EMPTY_TEXT : '状态栏会在每条 AI 回复下面显示角色当前的状态（好感、心情、位置……），并由 AI 在回复末尾按规则更新。可以让 AI 按这张卡设计一套变量和界面，也可以从模板开始，或者手动添加变量。', `
                    <div class="nl-row nl-wrap nl-sb-empty-acts">
                        <button class="nl-btn" data-act="sb-add-var">${icon('plus', { size: 14 })}手动添加变量</button>
                        <button class="nl-btn" data-act="sb-templates">${icon('file', { size: 14 })}从模板开始</button>
                        <button class="nl-btn nl-primary" data-act="sb-ai-first">AI 生成状态栏</button>
                    </div>`, { title: '还没有状态栏', ico: 'log' })}`;
        }
        const r = validate();
        const bad = r.infos.filter((x) => !x.ok).length;
        const room = tableCap() - countSpecLeaves(r.spec);
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
                        <tbody>${st.rows.map((v, i) => rowHtml(v, i, r.infos[i], i === st.rows.length - 1, room)).join('')}</tbody>
                    </table>
                </div>`;
        return `
            ${overridesOn() ? `<div class="nl-sb-note nl-sb-note-warn">${icon('alert')}<div class="nl-grow">「规则」里有手动覆盖的内容，不再与变量表同步：改这里的变量不会更新那些内容。</div></div>` : ''}
            <div class="nl-grid2">
                <div class="nl-field"><label>状态栏标题</label><input class="nl-input" data-sb-f="title" value="${esc(st.title)}" maxlength="30"></div>
                <div class="nl-field"><label>状态栏要求（AI 生成时参考）</label><input class="nl-input" data-sb-f="requirement" value="${esc(sb.requirement || '')}" placeholder="例如：重点记录好感和体力"></div>
            </div>
            ${world ? `<div class="nl-muted nl-small" data-sb-world-hint>${esc(worldVarsHint(charName))}</div>` : ''}
            <div class="nl-muted nl-small">路径用「.」分层，最多 3 层，例如 <code>${esc(world ? '世界.时间' : `${charName || '角色'}.好感度`)}</code>；某一段以 _ 开头的变量 AI 只读。${tokensLine()}</div>
            ${table}
            ${bad ? `<div class="nl-err nl-small">${icon('alert', { size: 12 })} 有 ${bad} 个变量没有生效（标红的行）：改好之前它们不会导出，关闭对话框后会被丢弃。</div>` : ''}
            ${st.notes.length ? `<div class="nl-muted nl-small">${st.notes.map((n) => esc(n)).join('<br>')}</div>` : ''}
            ${st.flash?.text ? `<div class="${st.flash.level === 'ok' ? 'nl-ok' : 'nl-warn'} nl-small" role="status" data-sb-flash>${esc(st.flash.text)}</div>` : ''}
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

    // ---------- 立绘 ----------
    const portraitsPanel = () => portraitsPanelHtml({
        draft: st.pt,
        spec: sb.spec,
        sample: sb.spec.variables.length ? ensureSample() : null,
        portraits: sb.portraits,
        sb,
        notes: st.ptNotes,
        newName: st.ptNew,
        newMsg: st.ptNewMsg,
    });

    /** 草稿 → sb.portraits（规范化：标红的不保存）；规范化给出的、编辑器里没有逐项标出的提示（合计超限、超出数量）留在 ptNotes */
    /** 立绘不是在立绘分页里改的（撤销、套用带立绘的模板）：草稿换成已保存的 */
    const syncPortraitDraft = () => {
        st.pt = portraitDraftFrom(sb.portraits);
        st.ptNotes = [];
        st.ptNewMsg = '';
    };

    const commitPortraits = () => {
        const warnings = [];
        sb.portraits = normalizePortraits(portraitDraftToRaw(st.pt), { warnings, spec: sb.spec });
        st.ptNotes = uniqWarnings(warnings.filter((w) => /合计|最多/.test(w)));
        refreshStatusBarLint(card);
        touch();
    };

    /** 预览分页里关于立绘的一行：配置了几个、当前界面会不会显示、换图按钮在预览里换的图会记住（与聊天共用） */
    const previewPortraitLine = () => {
        const p = sb.portraits;
        if (!portraitsActive(p)) return '';
        const d = portraitDisplayNote(sb);
        const nc = Object.keys(p.characters || {}).length;
        const np = (p.pools || []).length;
        const what = `立绘：${nc} 个角色${np ? `、${np} 个图池` : ''}。`;
        return d.level === 'warn'
            ? `<div class="nl-warn nl-small" data-sb-preview-pt>${icon('alert', { size: 12 })} ${esc(what + d.text)}</div>`
            : `<div class="nl-muted nl-small" data-sb-preview-pt>${icon('image', { size: 12 })} ${esc(`${what}状态栏里的换图按钮在这里也能点，换过的图会记住（和聊天里这张卡共用同一份记录，换回默认那张就不再记着）。`)}</div>`;
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
            ${previewPortraitLine()}
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
        // store：这张卡记着的立绘选择（与聊天里共用），预览里换的图重新载入后还在
        frame.srcdoc = buildPreviewSrcdoc(card, ensureSample(), { user: userName(), char: charName, tailwind, store: readPortraitChoices(card) });
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

    let storeRejected = false; // 预览发来的立绘记录被拒绝过（控制台只提醒一次）
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
        } else if (d.type === 'nl-store') {
            // 预览里点了「换一张」：记进酒馆页面的本地存储，聊天里的状态栏也按它显示（不合格的丢掉，控制台只提醒一次）
            const problem = acceptPreviewStore(card, d, undefined, { stat: ensureSample() });
            if (problem && !storeRejected) console.warn('[NovelLoom] 预览发来的立绘记录被拒绝：', problem);
            if (problem) storeRejected = true;
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

    /** 缩略图加载成功 / 失败：改外层的 data-state（失败时显示警告图标）。load / error 不冒泡，在 box 上用捕获阶段接 */
    const markThumb = (img, ok) => {
        const wrap = img.closest('[data-sb-thumb-wrap]');
        if (wrap) wrap.dataset.state = ok ? 'ok' : 'error';
    };
    const onThumbEvent = (e) => {
        const img = e.target;
        if (img?.tagName === 'IMG' && img.hasAttribute('data-sb-thumb') && box.contains(img)) markThumb(img, e.type === 'load');
    };

    const afterRender = () => {
        if (st.tab === 'preview' && sb.spec.variables.length) loadPreview();
        // 缓存里的图可能在挂上监听之前就已经加载完了
        for (const img of box.querySelectorAll('img[data-sb-thumb]')) if (img.complete) markThumb(img, img.naturalWidth > 0);
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
            c.log(`已更新「${displayName}」的状态栏：${varCountText(sb.spec)}`, 'success');
        }
        renderAll();
    };

    const snapshotOf = () => ({ spec: clone(sb.spec), html: sb.html, mode: sb.mode, theme: sb.theme, sample: clone(sb.sample ?? null), templateId: sb.templateId ?? null, maxVars: sb.maxVars ?? null });

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
        if ('portraits' in p) {
            sb.portraits = normalizePortraits(sb.portraits);
            syncPortraitDraft();
        }
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
        const ptBefore = JSON.stringify(sb.portraits ?? null);
        const res = await busy(btn, () => applyTemplateToCard(card, c, t, mode, { ai, warnings }), ai ? 'AI 调整中…' : '套用中…');
        // 模板带来的立绘已经并进 sb.portraits：立绘分页的草稿跟着换
        if (JSON.stringify(sb.portraits ?? null) !== ptBefore) syncPortraitDraft();
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

    // ---------- 立绘草稿的输入 ----------
    /** 把立绘 / 图池输入框的值写进草稿；返回是否是立绘的输入框 */
    const setPortraitInput = (el) => {
        const k = el.dataset.sbPt;
        if (k) {
            const ch = st.pt.chars[Number(el.dataset.sbPtC)];
            if (!ch) return true;
            if (k === 'name') {
                ch.name = el.value;
                return true;
            }
            const img = ch.images?.[Number(el.dataset.sbPtI)];
            if (!img) return true;
            if (!isObj(img.when)) img.when = { path: '', op: '>=', value: '' };
            if (k === 'url') img.url = el.value.trim();
            else if (k === 'label') img.label = el.value;
            else if (k === 'whenPath') img.when.path = el.value.trim();
            else if (k === 'whenOp') img.when.op = el.value;
            else if (k === 'whenValue') img.when.value = el.value.trim();
            return true;
        }
        const pk = el.dataset.sbPool;
        if (!pk) return false;
        const pool = st.pt.pools[Number(el.dataset.sbPoolP)];
        if (!pool) return true;
        if (pk === 'record') {
            pool.record = el.value;
            // 换了记录：按新记录的第一个字段取图（原来的字段多半不在新记录里）
            const rv = sb.spec.variables.find((v) => v.path === pool.record && v.type === 'record');
            const leaves = recordLeafFields(rv?.value).map((l) => l.path);
            if (leaves.length && !leaves.includes(pool.field)) pool.field = leaves[0];
        } else if (pk === 'field') pool.field = el.value.trim();
        else if (pk === 'fallback') pool.fallback = el.value;
        else {
            const v = pool.values?.[Number(el.dataset.sbPoolV)];
            if (v && pk === 'value') v.value = el.value;
            else if (v && pk === 'urls') v.urls = el.value;
        }
        return true;
    };

    /** 输入时就地更新这一项的提示（不重绘，不打断输入） */
    const refreshPortraitMsg = (el) => {
        const iss = portraitDraftIssues(st.pt, sb.spec);
        if (el.dataset.sbPt && el.dataset.sbPtI !== undefined) {
            const ci = Number(el.dataset.sbPtC);
            const ii = Number(el.dataset.sbPtI);
            const info = iss.chars[ci]?.images?.[ii];
            const box2 = box.querySelector(`[data-sb-pt-msg="${ci}.${ii}"]`);
            if (box2) box2.innerHTML = msgLinesInner(info?.msg ? [info] : []);
            const urlEl = box.querySelector(`[data-sb-pt="url"][data-sb-pt-c="${ci}"][data-sb-pt-i="${ii}"]`);
            urlEl?.setAttribute('aria-invalid', info?.level === 'err' ? 'true' : 'false');
        } else if (el.dataset.sbPool && el.dataset.sbPool !== 'record' && el.dataset.sbPool !== 'field') {
            const pi = Number(el.dataset.sbPoolP);
            const key = el.dataset.sbPool === 'fallback' ? 'f' : el.dataset.sbPoolV;
            const list = key === 'f' ? iss.pools[pi]?.fallback : iss.pools[pi]?.values?.[Number(key)];
            const box2 = box.querySelector(`[data-sb-pool-msg="${pi}.${key}"]`);
            if (box2) box2.innerHTML = msgLinesInner(list);
        }
    };

    /** 立绘分页里删掉一项并重绘之后：焦点放到旁边的一项（见 portraitDeleteFocus），不让它掉到 <body> 上 */
    const focusAfterPortraitDelete = (act, at) => {
        for (const sel of portraitDeleteFocus(act, st.pt, at)) {
            const el = box.querySelector(sel);
            if (el && !el.disabled) {
                el.focus();
                return;
            }
        }
    };

    /** 加一个角色的立绘（自带一行空图片，焦点放到地址框）；名字有问题时在输入框下提示 */
    const addPortraitChar = (name) => {
        const n = String(name ?? '').trim();
        const problem = portraitNewNameProblem(st.pt, n);
        if (problem) {
            st.ptNewMsg = problem;
            const msg = box.querySelector('[data-sb-pt-new-msg]');
            if (msg) msg.textContent = problem;
            box.querySelector('[data-sb-pt-new]')?.setAttribute('aria-invalid', 'true');
            return;
        }
        st.pt.chars.push({ name: n, images: [{ url: '', label: '', when: { path: '', op: '>=', value: '' } }] });
        st.ptNew = '';
        st.ptNewMsg = '';
        commitPortraits();
        renderAll();
        box.querySelector(`[data-sb-pt="url"][data-sb-pt-c="${st.pt.chars.length - 1}"][data-sb-pt-i="0"]`)?.focus();
    };

    // 字段名临时清空后再填上新名字：记着清空前的名字（按字段对象记；名字有问题的行保留原样，对象不变），填上时从它搬数据
    const renameFrom = new WeakMap();
    /** 这一行（还没规范化的原样）规范化后的路径：示例数据里按它找这个记录 */
    const rowPathOf = (row) => {
        try {
            return normalizeStatusSpec({ variables: [row] }, { charName, maxVars: 999 }).variables[0]?.path || '';
        } catch {
            return '';
        }
    };
    /**
     * 字段编辑器里改了记录的字段 / 分组的名字：这一行的初始条目、示例数据（编辑中的和卡上保存的）里这个记录的每个条目
     * 都把旧名字下的值搬到新名字下（新名字已经有值的条目不动）。在 commitRows 之前调用。
     */
    const migrateFieldRename = (row, field, before, after) => {
        if (!before || !after || !field) return;
        const from = before.key || renameFrom.get(field) || '';
        if (!after.key) {
            if (from) renameFrom.set(field, from);
            return;
        }
        renameFrom.delete(field);
        if (!from || from === after.key) return;
        const group = after.group;
        const path = rowPathOf(row);
        const lists = [row.init];
        for (const s of new Set([st.sample, sb.sample])) {
            const rec = isObj(s) && path ? getPath(s, path) : null;
            if (isObj(rec)) lists.push(rec);
        }
        for (const entries of lists) renameRecordEntryField(entries, from, after.key, group);
    };

    const onChange = async (e) => {
        const el = e.target;
        if (el.hasAttribute('data-sb-enable')) {
            sb.enabled = el.checked;
            touch();
            return renderAll();
        }
        if (el.hasAttribute('data-sb-pt-new')) {
            st.ptNew = el.value;
            return;
        }
        if (setPortraitInput(el)) {
            commitPortraits();
            return renderSoon();
        }
        const row = el.dataset.sbRow;
        // 记录字段编辑器（含分组）里的一项
        if (row !== undefined && el.dataset.sbFp) {
            const v = st.rows[Number(row)];
            if (!v || !isObj(v.value)) return;
            const val = el.type === 'checkbox' ? el.checked : el.value;
            const ref = el.dataset.sbFld;
            const before = el.dataset.sbFp === 'key' ? recordFieldNameAt(v.value, ref) : null;
            const field = before ? fieldAt(v.value, ref) : null;
            if (setRecordFieldProp(v.value, ref, el.dataset.sbFp, val)) {
                // 改名：先把初始条目和示例数据里的值搬到新名字下，再规范化（否则旧名字下的值会被当成多余的丢掉）
                if (before) migrateFieldRename(v, field, before, recordFieldNameAt(v.value, ref));
                // JSON 框里没解析成功的旧原文不再保留（下面按当前字段重新显示）
                delete st.rawEdits[`${row}:fields`];
                if (/^字段不是合法的 JSON/.test(st.rawEdits[`${row}:err`] || '')) delete st.rawEdits[`${row}:err`];
                commitRows();
                renderSoon();
            }
            return;
        }
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
        } else if (el.hasAttribute('data-sb-pt-new')) {
            st.ptNew = el.value;
            if (st.ptNewMsg) {
                st.ptNewMsg = '';
                const msg = box.querySelector('[data-sb-pt-new-msg]');
                if (msg) msg.textContent = '';
                el.setAttribute('aria-invalid', 'false');
            }
        } else if ((el.dataset.sbPt || el.dataset.sbPool) && el.tagName !== 'SELECT') {
            // 立绘：输入时只更新草稿和这一项的提示（地址合不合法），离开输入框时再保存并重绘缩略图
            setPortraitInput(el);
            refreshPortraitMsg(el);
        }
    };

    const onKeyDown = (e) => {
        // 「添加立绘」的名字框：回车直接添加（输入法选词时的回车不算）
        if (e.key === 'Enter' && !e.isComposing && e.target.hasAttribute?.('data-sb-pt-new')) {
            e.preventDefault();
            addPortraitChar(e.target.value);
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
                st.flash = null;
                return renderAll();
            case 'sb-ai-first':
            case 'sb-ai-all': {
                const r = await aiDialog({
                    title: act === 'sb-ai-first' ? 'AI 生成状态栏' : '全部重新生成状态栏',
                    intro: act !== 'sb-ai-first' ? '会替换现有的变量表和界面（可以撤销）。'
                        : world ? `AI 会为这张世界/旁白卡设计一套照顾整个群像的变量（主要角色、途中出场的 NPC、时间地点、主角……，最多 ${aiCap()} 个，记录的每个字段各算一个）和界面。`
                            : `AI 会按这张卡的设定设计一套变量（最多 ${aiCap()} 个，记录的每个字段各算一个）和界面。`,
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
                const base = sb.spec.title && sb.spec.title !== '状态栏' ? sb.spec.title : `${displayName}的状态栏`;
                const r = await nameDescDialog({
                    title: '存为状态栏模板', name: uniqueStatusBarTemplateName(c.settings, base), settings: c.settings,
                    portraitsOption: templatePortraitsOptionText(sb.portraits),
                });
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
                const choice = await templateLibraryDialog(c, sb.spec.variables.length > 0, charName);
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
            // ----- 记录的字段（含分组） -----
            case 'sb-fld-add':
            case 'sb-grp-add': {
                const v = st.rows[idx];
                if (!v) return;
                if (!isObj(v.value)) v.value = { type: 'object', fields: [] };
                const ref = act === 'sb-grp-add' ? addRecordGroup(v.value) : addRecordField(v.value, btn.dataset.sbFld || null);
                if (ref === null) return;
                delete st.rawEdits[`${idx}:fields`];
                commitRows();
                renderAll();
                const inp = box.querySelector(`[data-sb-row="${idx}"][data-sb-fld="${ref}"][data-sb-fp="key"]`);
                inp?.focus();
                inp?.select();
                return;
            }
            case 'sb-fld-up':
            case 'sb-fld-down': {
                const v = st.rows[idx];
                const to = v && isObj(v.value) ? moveRecordField(v.value, btn.dataset.sbFld, act === 'sb-fld-up' ? -1 : 1) : null;
                if (to === null) return;
                delete st.rawEdits[`${idx}:fields`];
                commitRows();
                renderAll();
                // 焦点跟着移动的那一项走（到头了就换到反方向的按钮上）
                const sel = (a) => `[data-act="${a}"][data-sb-i="${idx}"][data-sb-fld="${to}"]`;
                const next = box.querySelector(sel(act));
                (next && !next.disabled ? next : box.querySelector(sel(act === 'sb-fld-up' ? 'sb-fld-down' : 'sb-fld-up')))?.focus();
                return;
            }
            case 'sb-fld-del': {
                const v = st.rows[idx];
                if (!v || !isObj(v.value)) return;
                const ref = btn.dataset.sbFld;
                const r = parseFieldRef(ref);
                const g = r && r[1] === null ? v.value.fields?.[r[0]] : null;
                if (isGroupField(g) && g.fields.length && !(await confirmDialog(`删除分组「${fieldKeyOf(g) || `第 ${r[0] + 1} 项`}」和它里面的 ${g.fields.length} 个字段？`, { danger: true, okLabel: '删除' }))) return;
                if (!removeRecordField(v.value, ref)) return;
                delete st.rawEdits[`${idx}:fields`];
                commitRows();
                return renderAll();
            }
            case 'sb-seed-cast': {
                const r = validate();
                const norm = r.infos[idx]?.ok ? r.infos[idx].norm : null;
                if (!norm || norm.type !== 'record') {
                    st.flash = { level: 'warn', text: '这一行还没有生效，先改好再填入主要角色。' };
                    return renderAll();
                }
                // 只填进主要角色的记录（按钮只在那一行，这里再挡一次：表格变了之后旧按钮上的行号可能已经指向 NPC 之类的记录）
                if (!seedCastAllowed(world, r.spec, norm.path)) {
                    st.flash = { level: 'warn', text: `「${norm.path}」不是主要角色的记录：主要角色只填进${castRecordPath(r.spec) ? `「${castRecordPath(r.spec)}」` : '最后一段叫「主要角色」的记录'}。` };
                    return renderAll();
                }
                const names = c.project ? worldCastNames(c.project, card) : [];
                if (!names.length) {
                    st.flash = { level: 'warn', text: '项目里还没有到这张卡时间点为止出场的角色（先在「提取」里提取角色）。' };
                    return renderAll();
                }
                const res = seedRecordEntriesInto(norm, names);
                st.rows[idx] = res.row;
                delete st.rawEdits[`${idx}:init`];
                commitRows();
                st.flash = { level: res.added.length ? 'ok' : 'warn', text: res.text };
                c.log(res.text, res.added.length ? 'success' : 'info');
                return renderAll();
            }
            // ----- 立绘 -----
            case 'sb-pt-add-char':
                return addPortraitChar(box.querySelector('[data-sb-pt-new]')?.value ?? st.ptNew);
            case 'sb-pt-add-name':
                return addPortraitChar(btn.dataset.sbName);
            case 'sb-pt-del-char': {
                const ci = Number(btn.dataset.sbPtC);
                const ch = st.pt.chars[ci];
                if (!ch) return;
                const n = (ch.images || []).filter((x) => String(x?.url ?? '').trim()).length;
                if (n && !(await confirmDialog(`删除「${String(ch.name ?? '').trim() || '（未命名）'}」的 ${n} 张立绘？`, { danger: true, okLabel: '删除' }))) return;
                st.pt.chars.splice(ci, 1);
                commitPortraits();
                renderAll();
                return focusAfterPortraitDelete(act, { ci });
            }
            case 'sb-pt-add-img': {
                const ci = Number(btn.dataset.sbPtC);
                const ch = st.pt.chars[ci];
                if (!ch || (ch.images || []).length >= PORTRAIT_LIMITS.images) return;
                (ch.images ||= []).push({ url: '', label: '', when: { path: '', op: '>=', value: '' } });
                renderAll();
                box.querySelector(`[data-sb-pt="url"][data-sb-pt-c="${ci}"][data-sb-pt-i="${ch.images.length - 1}"]`)?.focus();
                return;
            }
            case 'sb-pt-img-up':
            case 'sb-pt-img-down':
            case 'sb-pt-img-del': {
                const ci = Number(btn.dataset.sbPtC);
                const ii = Number(btn.dataset.sbPtI);
                const list = st.pt.chars[ci]?.images;
                if (!list?.[ii]) return;
                if (act === 'sb-pt-img-del') list.splice(ii, 1);
                else {
                    const j = act === 'sb-pt-img-up' ? ii - 1 : ii + 1;
                    if (!list[j]) return;
                    [list[ii], list[j]] = [list[j], list[ii]];
                    commitPortraits();
                    renderAll();
                    const sel = (a) => `[data-act="${a}"][data-sb-pt-c="${ci}"][data-sb-pt-i="${j}"]`;
                    const next = box.querySelector(sel(act));
                    (next && !next.disabled ? next : box.querySelector(sel(act === 'sb-pt-img-up' ? 'sb-pt-img-down' : 'sb-pt-img-up')))?.focus();
                    return;
                }
                commitPortraits();
                renderAll();
                return focusAfterPortraitDelete(act, { ci, ii });
            }
            case 'sb-pool-add': {
                const rec = sb.spec.variables.find((v) => v.type === 'record');
                if (!rec || st.pt.pools.length >= PORTRAIT_LIMITS.pools) return;
                const leaves = recordLeafFields(rec.value).map((l) => l.path);
                st.pt.pools.push({ record: rec.path, field: leaves[0] || '', values: [{ value: '', urls: '' }], fallback: '' });
                renderAll();
                box.querySelector(`[data-sb-pool="value"][data-sb-pool-p="${st.pt.pools.length - 1}"][data-sb-pool-v="0"]`)?.focus();
                return;
            }
            case 'sb-pool-del': {
                const pi = Number(btn.dataset.sbPoolP);
                const pool = st.pt.pools[pi];
                if (!pool) return;
                const n = (pool.values || []).reduce((s, v) => s + splitUrls(v?.urls).length, 0) + splitUrls(pool.fallback).length;
                if (n && !(await confirmDialog(`删除这个图池（${n} 张图）？`, { danger: true, okLabel: '删除' }))) return;
                st.pt.pools.splice(pi, 1);
                commitPortraits();
                renderAll();
                return focusAfterPortraitDelete(act, { pi });
            }
            case 'sb-pool-val-add': {
                const pi = Number(btn.dataset.sbPoolP);
                const pool = st.pt.pools[pi];
                if (!pool || (pool.values || []).length >= PORTRAIT_LIMITS.values) return;
                (pool.values ||= []).push({ value: '', urls: '' });
                renderAll();
                box.querySelector(`[data-sb-pool="value"][data-sb-pool-p="${pi}"][data-sb-pool-v="${pool.values.length - 1}"]`)?.focus();
                return;
            }
            case 'sb-pool-val-del': {
                const pi = Number(btn.dataset.sbPoolP);
                const list = st.pt.pools[pi]?.values;
                const vi = Number(btn.dataset.sbPoolV);
                if (!list?.[vi]) return;
                list.splice(vi, 1);
                commitPortraits();
                renderAll();
                return focusAfterPortraitDelete(act, { pi, vi });
            }
            case 'sb-goto-preview':
                st.tab = 'preview';
                renderAll();
                box.querySelector('[data-act="sb-tab"][data-tab="preview"]')?.focus();
                return;
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
                st.sample = randomSampleState(sb.spec);
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
                else downloadFile(text, `${safeFileName(displayName, 'card')}-${btn.dataset.sbWhat}.json`);
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
    box.addEventListener('keydown', onKeyDown);
    box.addEventListener('load', onThumbEvent, true);
    box.addEventListener('error', onThumbEvent, true);
    box.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('pointerup', onPointerUp, true);
    window.addEventListener('pointercancel', onPointerUp, true);
    window.addEventListener('message', onMessage);
    refreshStatusBarLint(card);
    renderAll();
    try {
        await openDialog({ title: `状态栏：${displayName}${world ? '（世界卡）' : ''}`, wide: true, body: box, buttons: [{ label: '关闭', value: null }] });
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
