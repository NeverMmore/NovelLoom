// 文风：本书原著文风 + 全局文风预设、按任务选择、范文片段、自定义禁用词

import { DEFAULT_STYLE_OPTIONS } from './constants.js';
import { callLLM, chainFor } from './llm.js';
import { extractJson, removeTags } from './json.js';
import { lintText } from './lint.js';
import { getPrompt, render } from './prompts.js';
import { truncate, uid, uniq } from './utils.js';

export const PROJECT_STYLE_ID = '__project';
export const NO_STYLE_ID = '__none';

/** 可单独指定文风的任务（default 为其余任务的默认值） */
export const STYLE_TASKS = [
    { key: 'card', label: '角色卡', hint: '影响开场白、示例对话，以及世界书里的「文风」条目' },
    { key: 'plan', label: '写大纲', hint: '只用视角、基调与写法规则，不带范文' },
    { key: 'continue', label: '续写', hint: '完整使用：写法规则 + 范文 + 禁用词' },
];

export const STYLE_FIELDS = [
    { key: 'perspective', label: '叙事视角', placeholder: '如：第三人称有限视角，主要跟随主角' },
    { key: 'tone', label: '语言风格', placeholder: '如：短句为主，口语化，少用修辞' },
    { key: 'mood', label: '情绪基调', placeholder: '如：轻松诙谐，偶尔温情' },
];

export { DEFAULT_STYLE_OPTIONS };

/** 常见 AI 腔，可一键导入到禁用词 */
export const COMMON_AI_BANNED = `# 常见 AI 腔（可自行删改；词=>建议 表示可按建议替换）
仿佛, 宛如, 似乎, 恍若
嘴角上扬=>笑了
嘴角勾起=>笑了
眼中闪过一丝
一抹笑意
带着一丝
不易察觉
不容置疑
深吸一口气
空气仿佛凝固
心湖, 泛起涟漪
指节泛白
喉结滚动
微微一怔=>一愣
下意识地
命运的齿轮
/(?:一丝|一抹)[^，。！？\\n]{0,4}(?:笑意|狡黠|玩味|宠溺)/`;

function blankProfile(extra = {}) {
    return { perspective: '', tone: '', mood: '', rules: '', notes: '', samples: [], banned: '', ...extra };
}

/** 内置文风模板（只读；编辑后以同 id 覆盖保存在设置里，可恢复默认） */
export const BUILTIN_STYLE_PRESETS = [
    {
        id: 'b_light', name: '轻小说风', builtin: true,
        perspective: '第一人称或贴近主角的第三人称，读者跟着主角的吐槽走',
        tone: '口语化，短句短段，对话占比高；允许内心吐槽与夸张的反应，但不堆砌网络流行语',
        mood: '轻松明快，日常中带一点温情',
        rules: '- 用对话和动作推进，少用大段环境描写\n- 吐槽要落在具体的事上，一段最多一次\n- 角色说话各有口癖和称呼习惯，读者不看提示也能分出是谁在说\n- 场景切换用空行，不写“与此同时”',
        notes: '', samples: [], banned: '',
    },
    {
        id: 'b_wuxia', name: '古风武侠', builtin: true,
        perspective: '第三人称，全知与有限视角交替，打斗时贴近出手的人',
        tone: '半文半白，句子凝练，多用短句和四字词；动作描写干脆利落，少用形容词',
        mood: '苍劲洒脱，快意恩仇里带些苍凉',
        rules: '- 招式写动作与结果，不写“一股强大的力量”\n- 对话用古人的称呼与语气（阁下、在下、姑娘），不出现现代词汇\n- 景物描写一两句点到为止，服务于人物心境\n- 人物情绪通过动作和一句话表达，不直接宣告',
        notes: '', samples: [], banned: 'OK, 搞定, 酷, 帅气, 没问题=>无妨\n厉害=>了得',
    },
    {
        id: 'b_web', name: '网文爽文', builtin: true,
        perspective: '第三人称有限视角，紧跟主角',
        tone: '节奏快，短句短段，一段不超过三行；用词直白有力',
        mood: '热血张扬，压抑后必有释放',
        rules: '- 每章至少一个冲突和一个爽点（打脸、突破、收获、反转）\n- 配角的反应（震惊、议论）用来放大主角的表现，但一次不超过三句\n- 章末留钩子：新的危机、悬念或即将到来的对决\n- 不写大段心理独白，想法用一句话带过后立刻行动',
        notes: '', samples: [], banned: '',
    },
    {
        id: 'b_literary', name: '严肃文学', builtin: true,
        perspective: '第三人称有限视角，自由间接引语',
        tone: '克制、准确，注重细节与白描，句式长短交错；少用形容词和副词，不用成语堆砌',
        mood: '沉静内敛，情绪埋在细节下面',
        rules: '- 情绪不宣告，用动作、物件和环境的细节呈现\n- 对话简短，有潜台词，不把意思说满\n- 留白：场景在情绪最满之前结束\n- 比喻只在必要时用，且要新鲜、具体',
        notes: '', samples: [], banned: '仿佛, 宛如, 不禁, 情不自禁, 心中五味杂陈',
    },
    {
        id: 'b_second', name: '第二人称沉浸式', builtin: true,
        perspective: '第二人称“你”，读者即主角；只写“你”能看到、听到、感到的内容',
        tone: '现在时的临场感，句子短，感官细节具体；不替“你”做重大决定，不写“你”的长篇心理',
        mood: '沉浸、紧凑',
        rules: '- 每段以“你”的感知或行动为中心\n- 其他角色通过对白和动作表现，不写他们的内心\n- 段落结尾留出“你”可以回应或行动的空间\n- 适合酒馆角色扮演：开场白里把{{user}}写成“你”',
        notes: '', samples: [], banned: '',
    },
];

// ---------------- 数据 ----------------

export function normalizeStyleProfile(p = {}) {
    const out = blankProfile();
    for (const k of ['perspective', 'tone', 'mood', 'notes']) out[k] = String(p[k] ?? '');
    out.rules = Array.isArray(p.rules) ? p.rules.map((r) => `- ${String(r).replace(/^[-*•]\s*/, '')}`).join('\n') : String(p.rules ?? '');
    out.banned = Array.isArray(p.banned) ? p.banned.map((b) => (typeof b === 'string' ? b : `${b.word}${b.suggest ? `=>${b.suggest}` : ''}`)).join('\n') : String(p.banned ?? '');
    out.samples = (Array.isArray(p.samples) ? p.samples : [])
        .map((s) => (typeof s === 'string' ? { text: s } : s))
        .filter((s) => s && String(s.text || '').trim())
        .map((s) => ({ id: s.id || uid('s_'), text: String(s.text).trim(), source: String(s.source || '') }));
    if (p.id) out.id = String(p.id);
    if (p.name) out.name = String(p.name);
    if (p.builtin) out.builtin = true;
    return out;
}

/** 补齐项目里的文风字段 */
export function normalizeProjectStyle(project) {
    project.style = normalizeStyleProfile(project.style || {});
    delete project.style.id;
    delete project.style.name;
    const use = project.styleUse && typeof project.styleUse === 'object' ? project.styleUse : {};
    project.styleUse = { default: use.default || PROJECT_STYLE_ID, card: use.card || '', plan: use.plan || '', continue: use.continue || '' };
    return project;
}

export function styleOptions(settings) {
    return { ...DEFAULT_STYLE_OPTIONS, ...(settings?.styleOptions || {}) };
}

/** 全部预设：内置（含用户覆盖）+ 用户自建 */
export function listStylePresets(settings) {
    const user = Array.isArray(settings?.stylePresets) ? settings.stylePresets : [];
    const builtins = BUILTIN_STYLE_PRESETS.map((b) => {
        const o = user.find((u) => u.id === b.id);
        return o ? { ...normalizeStyleProfile({ ...b, ...o }), id: b.id, builtin: true, modified: true } : { ...normalizeStyleProfile(b), id: b.id, builtin: true };
    });
    const own = user.filter((u) => !BUILTIN_STYLE_PRESETS.some((b) => b.id === u.id)).map((u) => ({ ...normalizeStyleProfile(u), id: u.id, name: u.name || '未命名文风' }));
    return [...builtins, ...own];
}

export function getStylePreset(settings, id) {
    return listStylePresets(settings).find((p) => p.id === id) || null;
}

export function projectStyleProfile(project) {
    return { ...normalizeStyleProfile(project?.style || {}), id: PROJECT_STYLE_ID, name: '本书原著文风' };
}

/** 文风选项（用于下拉框） */
export function listStyleChoices(_project, settings) {
    return [
        { id: PROJECT_STYLE_ID, name: '本书原著文风' },
        ...listStylePresets(settings).map((p) => ({ id: p.id, name: `${p.name}${p.builtin ? '（内置）' : ''}` })),
        { id: NO_STYLE_ID, name: '不指定文风' },
    ];
}

export function getStyleById(project, settings, id) {
    if (id === NO_STYLE_ID) return null;
    if (!id || id === PROJECT_STYLE_ID) return projectStyleProfile(project);
    return getStylePreset(settings, id) || projectStyleProfile(project);
}

/** 某任务实际使用的文风 id */
export function resolveStyleId(project, task) {
    const use = project?.styleUse || {};
    return (task && task !== 'default' && use[task]) || use.default || PROJECT_STYLE_ID;
}

/** 某角色在「多视角管理」里映射的文风 id；未映射返回空字符串 */
export function resolvePovStyleId(project, charName) {
    return (charName && project?.povStyles && project.povStyles[charName]) || '';
}

/**
 * 某任务实际使用的文风档案；“不指定文风”返回 null
 * @param {string} [povChar] 指定时优先用该角色在「多视角管理」里映射的文风，未映射则回退到任务的默认文风
 */
export function getStyleProfile(project, settings, task, povChar) {
    const povId = povChar ? resolvePovStyleId(project, povChar) : '';
    return getStyleById(project, settings, povId || resolveStyleId(project, task));
}

/** 保存预设（新建 / 更新 / 覆盖内置） */
export function saveStylePreset(settings, profile) {
    if (!Array.isArray(settings.stylePresets)) settings.stylePresets = [];
    const p = normalizeStyleProfile(profile);
    p.id = profile.id || uid('sty_');
    p.name = String(profile.name || '').trim() || '未命名文风';
    const isBuiltin = BUILTIN_STYLE_PRESETS.some((b) => b.id === p.id);
    if (isBuiltin) p.builtin = true;
    else delete p.builtin;
    const i = settings.stylePresets.findIndex((u) => u.id === p.id);
    if (i >= 0) settings.stylePresets[i] = p;
    else settings.stylePresets.push(p);
    return p;
}

/** 删除自建预设，或把内置预设恢复默认 */
export function removeStylePreset(settings, id) {
    if (!Array.isArray(settings.stylePresets)) return false;
    const n = settings.stylePresets.length;
    settings.stylePresets = settings.stylePresets.filter((u) => u.id !== id);
    return settings.stylePresets.length !== n;
}

/** 预设被删除后，把引用它的任务（及多视角映射）改回默认 */
export function fixStyleUse(project, settings) {
    const ids = new Set([PROJECT_STYLE_ID, NO_STYLE_ID, ...listStylePresets(settings).map((p) => p.id)]);
    if (project?.styleUse) {
        for (const k of Object.keys(project.styleUse)) {
            if (project.styleUse[k] && !ids.has(project.styleUse[k])) project.styleUse[k] = k === 'default' ? PROJECT_STYLE_ID : '';
        }
    }
    if (project?.povStyles) {
        for (const k of Object.keys(project.povStyles)) {
            if (project.povStyles[k] && !ids.has(project.povStyles[k])) delete project.povStyles[k];
        }
    }
}

export function isStyleEmpty(p) {
    if (!p) return true;
    return !['perspective', 'tone', 'mood', 'rules', 'notes', 'banned'].some((k) => String(p[k] || '').trim()) && !p.samples?.length;
}

// ---------------- 禁用词 ----------------

function escapeRe(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 解析禁用词文本
 * 每行一个；“词=>建议”给出替换建议；/正则/flags 为正则；不含 => 的普通行可用逗号、顿号分隔多个词；# 开头为注释
 * @returns {{word:string, suggest:string, re:RegExp, regex:boolean}[]}
 */
export function parseBanned(text) {
    const out = [];
    const seen = new Set();
    for (const raw of String(text || '').split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || line.startsWith('#')) continue;
        const arrow = line.search(/\s*=>\s*/);
        const head = arrow >= 0 ? line.slice(0, arrow).trim() : line;
        const suggest = arrow >= 0 ? line.slice(arrow).replace(/^\s*=>\s*/, '').trim() : '';
        const m = head.match(/^\/(.+)\/([a-z]*)$/);
        if (m) {
            try {
                const re = new RegExp(m[1], `${m[2].replace(/g/g, '')}g`);
                if (!seen.has(head)) out.push({ word: head, suggest, re, regex: true });
                seen.add(head);
            } catch {
                // 无效正则当作普通词
                if (!seen.has(head)) out.push({ word: head, suggest, re: new RegExp(escapeRe(head), 'g'), regex: false });
                seen.add(head);
            }
            continue;
        }
        const words = arrow >= 0 ? [head] : head.split(/[,，、;；]\s*/);
        for (const w of words.map((x) => x.trim()).filter(Boolean)) {
            if (seen.has(w)) continue;
            seen.add(w);
            out.push({ word: w, suggest, re: new RegExp(escapeRe(w), 'g'), regex: false });
        }
    }
    return out;
}

/** 文风自带 + 全局禁用词 */
export function bannedListFor(project, settings, task, povChar) {
    const profile = getStyleProfile(project, settings, task, povChar);
    return parseBanned([profile?.banned || '', styleOptions(settings).globalBanned || ''].join('\n'));
}

/** 转为本地审稿规则（lintText 的 extraRules） */
export function bannedRules(list) {
    return list.map((b, i) => ({
        id: `ban_${i}`,
        type: '禁用词',
        level: 'error',
        re: b.re,
        tip: b.suggest ? `改为「${b.suggest}」或改写句子` : '改写这句，不要用这个词',
        suggest: b.suggest,
    }));
}

export function bannedRulesFor(project, settings, task, povChar) {
    return bannedRules(bannedListFor(project, settings, task, povChar));
}

/** 扫描一段正文中的禁用词 */
export function checkBanned(text, project, settings, task = 'continue', povChar) {
    const rules = bannedRulesFor(project, settings, task, povChar);
    if (!rules.length) return [];
    return lintText(text, { extraRules: rules, onlyExtra: true });
}

/** 按“词=>建议”本地替换；返回替换后的文本与替换次数 */
export function replaceBanned(text, list) {
    let s = String(text || '');
    let count = 0;
    for (const b of list) {
        if (!b.suggest) continue;
        b.re.lastIndex = 0;
        s = s.replace(b.re, () => {
            count++;
            return b.suggest;
        });
    }
    return { text: s, count };
}

// ---------------- 提示词 ----------------

/**
 * 把文风档案渲染成提示词里的「文风」一节
 * @param {object|null} profile
 * @param {{withSamples?:boolean, maxSampleChars?:number, withBanned?:boolean, extraBanned?:string, empty?:string}} opt
 */
export function styleBlock(profile, { withSamples = true, maxSampleChars = 1500, withBanned = true, extraBanned = '', empty = '（未设置文风，保持前文风格）' } = {}) {
    if (!profile) return '（不指定文风，保持前文风格）';
    const lines = [];
    if (profile.perspective?.trim()) lines.push(`视角：${profile.perspective.trim()}`);
    if (profile.tone?.trim()) lines.push(`语言：${profile.tone.trim()}`);
    if (profile.mood?.trim()) lines.push(`基调：${profile.mood.trim()}`);
    const rules = String(profile.rules || '').split(/\r?\n/).map((r) => r.trim()).filter(Boolean);
    if (rules.length) lines.push(`写法规则：\n${rules.map((r) => (/^[-*•\d]/.test(r) ? r : `- ${r}`)).join('\n')}`);
    if (profile.notes?.trim()) lines.push(`备注：${profile.notes.trim()}`);
    if (withBanned) {
        const banned = parseBanned([profile.banned || '', extraBanned || ''].join('\n'));
        const words = banned.filter((b) => !b.regex).map((b) => b.word);
        if (words.length) lines.push(`禁用词（正文中不要出现）：${words.slice(0, 80).join('、')}`);
    }
    if (withSamples && profile.samples?.length && maxSampleChars > 0) {
        let left = maxSampleChars;
        const parts = [];
        for (const s of profile.samples) {
            if (left < 80) break;
            const t = truncate(s.text.trim(), left);
            parts.push(`<sample>\n${t}\n</sample>`);
            left -= t.length;
        }
        if (parts.length) lines.push(`范文片段（只模仿句式、节奏、用词和对话写法，不照搬其中的内容、人物和情节）：\n${parts.join('\n')}`);
    }
    return lines.join('\n') || empty;
}

/**
 * 某任务的「文风」一节（已按任务决定是否带范文）
 * @param {string} [povChar] 指定时优先用该角色在「多视角管理」里映射的文风
 */
export function styleTextFor(project, settings, task, povChar) {
    const opt = styleOptions(settings);
    const profile = getStyleProfile(project, settings, task, povChar);
    const withSamples = task === 'plan' ? opt.samplesInPlan : task === 'card' ? opt.samplesInCard : true;
    return styleBlock(profile, {
        withSamples,
        maxSampleChars: Number(opt.sampleMaxChars) || 0,
        withBanned: opt.bannedInPrompt !== false && task !== 'plan',
        extraBanned: opt.globalBanned,
    });
}

/** 世界书「文风」条目的内容（不带范文，适合常驻） */
export function styleEntryText(profile, settings) {
    if (!profile) return '';
    const opt = styleOptions(settings);
    const t = styleBlock(profile, { withSamples: false, withBanned: opt.bannedInPrompt !== false, extraBanned: opt.globalBanned, empty: '' });
    return t;
}

// ---------------- 范文片段 ----------------

const HEADING_RE = /^\s*(?:第[零〇一二两三四五六七八九十百千万0-9０-９]+[章回卷节部篇集幕]|Chapter\s*\d+|序章|楔子|尾声|番外)/i;
const QUOTE_RE = /[“「『"][^”」』"\n]{1,200}[”」』"]/g;

function scoreWindow(text) {
    const len = text.length || 1;
    let dialog = 0;
    for (const m of text.matchAll(QUOTE_RE)) dialog += m[0].length;
    const narration = len - dialog;
    // 对话与叙述都要有：取两者较小值占比；段落数适中加分
    const paras = text.split('\n').filter((p) => p.trim()).length;
    let score = Math.min(dialog, narration) / len + Math.min(paras, 6) * 0.02;
    if (/https?:|www\.|本书|作者|求(?:票|收藏|月票)|PS[:：]/i.test(text)) score -= 1;
    return score;
}

/**
 * 从原文自动挑选范文：全书均匀分成 count 段，每段挑一个对话与叙述兼有的片段
 * @returns {{text:string, source:string}[]}
 */
export function pickSamples(project, { count = 3, length = 500 } = {}) {
    const chunks = (project?.chunks || []).filter((c) => c.origin !== 'generated' && c.content);
    if (!chunks.length) return [];
    // 以段落为单位建立全书索引
    const paras = [];
    chunks.forEach((c) => {
        let heading = '';
        for (const p of c.content.split(/\r?\n/)) {
            const t = p.trim();
            if (!t) continue;
            if (HEADING_RE.test(t) && t.length <= 40) heading = t;
            paras.push({ text: t, chunk: c, heading });
        }
    });
    if (!paras.length) return [];
    const skipHead = Math.floor(paras.length * 0.02);
    const usable = paras.length - skipHead;
    const n = Math.max(1, Math.min(count, usable));
    const out = [];
    for (let r = 0; r < n; r++) {
        const from = skipHead + Math.floor((usable * r) / n);
        const to = skipHead + Math.floor((usable * (r + 1)) / n);
        const stride = Math.max(1, Math.floor((to - from) / 60));
        let best = null;
        for (let i = from; i < to; i += stride) {
            const win = [];
            let size = 0;
            for (let j = i; j < to && size < length; j++) {
                if (HEADING_RE.test(paras[j].text)) {
                    if (win.length) break;
                    continue;
                }
                win.push(paras[j]);
                size += paras[j].text.length + 1;
            }
            if (!win.length) continue;
            const text = truncate(win.map((w) => w.text).join('\n'), Math.round(length * 1.3));
            // 太短的片段降权，但短篇里仍可入选
            const score = scoreWindow(text) - (size < Math.min(length * 0.5, 120) ? 0.5 : 0);
            if (!best || score > best.score) best = { text, score, chunk: win[0].chunk, heading: win[0].heading };
        }
        if (best) out.push({ text: best.text, source: `原文·${best.heading || best.chunk.title || `第${best.chunk.index + 1}段`}` });
    }
    return out;
}

/** 文本中某位置之前最近的章节标题（用于标注范文来源） */
export function headingBefore(text, pos) {
    const lines = String(text || '').slice(0, pos).split(/\r?\n/).reverse();
    return lines.map((l) => l.trim()).find((l) => l.length <= 40 && HEADING_RE.test(l)) || '';
}

export function makeSample(text, source = '') {
    return { id: uid('s_'), text: String(text || '').trim(), source };
}

// ---------------- AI ----------------

/**
 * AI 提炼文风：从原文片段总结视角/语言/基调/写法规则/建议禁用词
 * @returns {Promise<{perspective:string,tone:string,mood:string,rules:string,banned:string}>}
 */
export async function analyzeStyle(project, settings, { signal, excerpts, current } = {}) {
    const list = excerpts?.length ? excerpts : pickSamples(project, { count: 6, length: 700 });
    if (!list.length) throw new Error('没有可分析的原文');
    const cur = current || projectStyleProfile(project);
    const vars = {
        BOOK: project.bookName,
        CURRENT: styleBlock(cur, { withSamples: false, empty: '（无）' }),
        SAMPLES: list.map((s, i) => `<excerpt no="${i + 1}">\n${typeof s === 'string' ? s : s.text}\n</excerpt>`).join('\n'),
    };
    const res = await callLLM({
        api: settings.api,
        system: render(getPrompt(settings, 'styleAnalyzeSystem'), vars),
        prompt: render(getPrompt(settings, 'styleAnalyze'), vars),
        ...chainFor(settings, 'tools', project),
        expect: 'json',
        signal,
    });
    const json = extractJson(removeTags(res.text, settings.extraction?.filterTags)) || {};
    const toText = (v) => (Array.isArray(v) ? v.join('；') : String(v ?? '')).trim();
    const rules = Array.isArray(json.rules) ? json.rules : String(json.rules || '').split(/\r?\n/);
    const banned = Array.isArray(json.banned) ? json.banned : String(json.banned || '').split(/[\r\n,，、]/);
    return {
        perspective: toText(json.perspective ?? json.视角),
        tone: toText(json.tone ?? json.语言),
        mood: toText(json.mood ?? json.基调),
        rules: uniq(rules.map((r) => String(r).replace(/^[-*•]\s*/, '').trim()).filter(Boolean)).map((r) => `- ${r}`).join('\n'),
        banned: uniq(banned.map((b) => String(b).trim()).filter(Boolean)).join('\n'),
    };
}

/**
 * AI 改写命中禁用词的句子，其余内容保持不变
 * @returns {Promise<string>}
 */
export async function fixBannedInText(text, issues, project, settings, { signal, api, task = 'continue', povChar } = {}) {
    if (!issues?.length) return text;
    const vars = {
        BOOK: project.bookName,
        STYLE: styleTextFor(project, settings, task, povChar),
        ISSUES: uniq(issues.map((i) => `- 「${i.match}」：${i.tip}（${i.context}）`)).slice(0, 60).join('\n'),
        TEXT: text,
    };
    const useApi = api || settings.api;
    const res = await callLLM({
        api: useApi,
        system: render(getPrompt(settings, 'styleFixSystem'), vars),
        prompt: render(getPrompt(settings, 'styleFix'), vars),
        ...chainFor(settings, 'tools', project),
        expect: 'prose',
        signal,
        maxTokens: Math.max(useApi?.maxTokens || 0, Math.ceil(text.length * 2.2)),
    });
    let out = removeTags(res.text, settings.extraction?.filterTags).trim();
    const m = out.match(/<text>([\s\S]*?)<\/text>/);
    if (m) out = m[1].trim();
    out = out.replace(/^```[a-z]*\n?|```$/g, '').trim();
    // 防御：结果明显残缺时保留原文
    if (out.length < text.length * 0.6) throw new Error(`修正结果过短（${out.length} / ${text.length} 字），已保留原文`);
    return out;
}

// ---------------- 导入导出 ----------------

export function exportStyleJson(profile) {
    const p = normalizeStyleProfile(profile);
    return {
        type: 'novelloom-style',
        version: 1,
        name: profile.name || '文风',
        perspective: p.perspective,
        tone: p.tone,
        mood: p.mood,
        rules: p.rules,
        notes: p.notes,
        banned: p.banned,
        samples: p.samples.map((s) => ({ text: s.text, source: s.source })),
    };
}

/** 解析导入的文风 JSON（单个或数组） */
export function parseStyleJson(json) {
    const arr = Array.isArray(json) ? json : Array.isArray(json?.presets) ? json.presets : [json];
    return arr
        .filter((x) => x && typeof x === 'object' && ['perspective', 'tone', 'mood', 'rules', 'notes', 'banned', 'samples'].some((k) => k in x))
        .map((x) => ({ ...normalizeStyleProfile(x), name: String(x.name || '导入的文风') }));
}
