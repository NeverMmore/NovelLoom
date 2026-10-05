// 写卡 v2：酒馆当前连接的宏保护（{{char}}/{{user}} 不被换成酒馆里打开的角色名）、卡片名规则、示例对话说话人规整、
// 「{{user}} 扮演」、卡的导向（模板库、写卡提示词、本书落点、卡片自己的世界书条目）
import test from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_CATEGORIES, DEFAULT_SETTINGS } from '../src/constants.js';
import { mergeDefaults } from '../src/utils.js';
import { createProject, mergeCharacter, mergeEntry, renameCharacter } from '../src/project.js';
import { buildChunks, detectChapters } from '../src/splitter.js';
import { buildCardPrompt, buildOrientationNotesPrompt, cardNameFor, generateCard, normalizeMesExample, regenerateCardField, regenerateOrientationNotes } from '../src/cards.js';
import { callLLM, shieldMacros, unshieldMacros } from '../src/llm.js';
import {
    BUILTIN_ORIENTATIONS, ORIENTATION_CUSTOM, ORIENTATION_PROMPT_LINES, addOrientationTemplate, duplicateOrientationTemplate, exportOrientationTemplates,
    getOrientationTemplate, importOrientationTemplates, listOrientationTemplates, normalizeOrientationTemplate, orientationEntry, orientationEntryContent,
    orientationFromPick, orientationPromptBlock, parseOrientationNotes, parseOrientationTemplates, removeOrientationTemplate, updateOrientationTemplate,
} from '../src/orientation.js';
import { USER_ROLE_ENTRY_TITLE, normalizeUserRole, userRoleEntry, userRolePromptBlock } from '../src/userrole.js';
import { cardExtraEntries, cardOwnWorld, prepareCard, publishCard, statusBarWorldName } from '../src/publish.js';
import { applyConfig } from '../src/io.js';
import { DEFAULT_PROMPTS, PROMPT_LABELS, PROMPT_PLACEHOLDERS } from '../src/prompts.js';
import { buildStatusSpecPrompt } from '../src/statusbar-ai.js';
import { ensureStatusBar, normalizeStatusSpec } from '../src/statusbar.js';
import { applyCardWorldInput, cardWorldField, cardWorldLabelHtml } from '../src/ui/tab-cards.js';

const NOVEL = ['第一章 魔女小姐', '江酒走进酒吧。莉莉丝坐在角落。', '第二章 女仆', '江酒穿上了女仆装。莉莉丝去参加魔女茶会。'].join('\n');

function settings() {
    const s = mergeDefaults({}, DEFAULT_SETTINGS);
    s.categories = structuredClone(DEFAULT_CATEGORIES);
    s.api.retries = 0;
    s.api.retryBaseMs = 500;
    s.antiTruncate.enabled = false;
    return s;
}

function project() {
    const chunks = detectChapters(NOVEL, '^第.+章.*$').map((ch) => buildChunks([ch], 1000, false)[0]);
    chunks.forEach((c, i) => (c.index = i));
    const p = createProject({ name: '魔女', text: NOVEL, chunks });
    mergeCharacter(p, { name: '江酒', identity: '莉莉丝的前男友', personality: '脸皮厚', importance: 'main' }, 0);
    mergeCharacter(p, { name: '莉莉丝', identity: '大魔女', importance: 'main' }, 0);
    mergeCharacter(p, { name: '姜小白', identity: '迷路的女孩', importance: 'support' }, 1);
    mergeEntry(p, '地点', { name: '酒吧', keywords: ['酒吧'], content: '莉莉丝经营的酒吧' }, 0);
    return p;
}

// ---------------- 酒馆宏替换的移植（public/scripts/macros.js evaluateMacros 的旧正则 + 新引擎的词法前提） ----------------

/** 酒馆旧宏引擎（evaluateMacros）里会碰到 NovelLoom 提示词的那些正则，按原样移植；env 里的 user/char 换成酒馆当前的名字 */
function stSubstitute(content, { user = 'Persona小明', char = 'Seraphina' } = {}) {
    if (!content) return '';
    const env = { user, char, persona: '人设描述', description: '卡片描述', personality: '性格', scenario: '场景', charIfNotGroup: char, group: char, model: 'gpt', original: '' };
    const pre = [
        { regex: /<USER>/gi, replace: () => user },
        { regex: /<BOT>/gi, replace: () => char },
        { regex: /<CHAR>/gi, replace: () => char },
        { regex: /<CHARIFNOTGROUP>/gi, replace: () => char },
        { regex: /<GROUP>/gi, replace: () => char },
        { regex: /{{roll[ : ]([^}]+)}}/gi, replace: () => '4' },
        { regex: /{{newline}}/gi, replace: () => '\n' },
        { regex: /(?:\r?\n)*{{trim}}(?:\r?\n)*/gi, replace: () => '' },
        { regex: /{{noop}}/gi, replace: () => '' },
        { regex: /{{input}}/gi, replace: () => '输入框' },
    ];
    const envMacros = Object.keys(env).map((k) => ({ regex: new RegExp(`{{${k}}}`, 'gi'), replace: () => env[k] }));
    const post = [
        { regex: /{{maxPrompt}}/gi, replace: () => '8000' },
        { regex: /{{lastMessage}}/gi, replace: () => '最后一条' },
        { regex: /{{reverse:(.+?)}}/gi, replace: (_, str) => Array.from(str).reverse().join('') },
        { regex: /\{\{\/\/([\s\S]*?)\}\}/gm, replace: () => '' },
        { regex: /{{time}}/gi, replace: () => '12:00' },
        { regex: /{{date}}/gi, replace: () => '2026-10-05' },
        { regex: /{{datetimeformat +([^}]*)}}/gi, replace: () => '格式' },
        { regex: /{{outlet::(.+?)}}/gi, replace: () => '' },
        { regex: /{{random\s?::?([^}]+)}}/gi, replace: () => '随机' },
        { regex: /{{pick\s?::?([^}]+)}}/gi, replace: () => '挑选' },
        { regex: /{{banned "(.*)"}}/gi, replace: () => '' },
        { regex: /{{timeDiff::(.*?)::(.*?)}}/gi, replace: () => '' },
        // getVariableMacros 的代表
        { regex: /{{setvar::([^:]+)::([^}]*)}}/gi, replace: () => '' },
        { regex: /{{getvar::([^}]+)}}/gi, replace: () => '变量' },
    ];
    for (const macro of [...pre, ...envMacros, ...post]) {
        if (!content) break;
        // 与酒馆一致：非 < 开头的宏在内容里没有 {{ 时直接短路
        if (!macro.regex.source.startsWith('<') && !content.includes('{{')) break;
        content = content.replace(macro.regex, macro.replace);
    }
    return content;
}

/** 新宏引擎（macros/engine）：预处理把 <USER> 等改写成宏，词法上 Macro.Start = /\{\{/、Macro.End = /\}\}/，后处理去掉 \{ \} 的反斜杠 */
function newEngineSees(content) {
    const pre = content.replace(/<USER>/gi, '{{user}}').replace(/<BOT>/gi, '{{char}}').replace(/<CHAR>/gi, '{{char}}').replace(/<GROUP>/gi, '{{group}}').replace(/<CHARIFNOTGROUP>/gi, '{{charIfNotGroup}}');
    return { macroStart: /\{\{/.test(pre), macroEnd: /\}\}/.test(pre), unescaped: pre.replace(/\\([{}])/g, '$1') !== pre };
}

const SAMPLES = [
    '在所有字段中用 {{char}} 指代角色本人、{{user}} 指代用户。',
    '"mes_example": "<START>\\n{{user}}: ……\\n{{char}}: ……"',
    '三个括号 {{{user}}} 和 }}} 以及 {{{{char}}}}',
    '旧式标记 <USER> <bot> <Char> <CHARIFNOTGROUP> <group>',
    '反斜杠 \\{\\{user\\}\\} 与 \\{ 单个',
    '嵌套 JSON {"a":{"b":{"c":1}}} 和 {{random::甲::乙}} {{// 注释}} {{trim}} {{setvar::x::1}}',
    '没有宏的普通文字',
];

test('shieldMacros：旧宏引擎（正则移植）替换不到任何东西，新引擎看不到 {{ / }}；还原后与原文一致', () => {
    for (const s of SAMPLES) {
        const shielded = shieldMacros(s);
        assert.ok(!shielded.includes('{{'), `不应残留 {{：${shielded}`);
        assert.ok(!shielded.includes('}}'), `不应残留 }}：${shielded}`);
        assert.equal(stSubstitute(shielded), shielded, `旧宏引擎不应改动：${s}`);
        const seen = newEngineSees(shielded);
        assert.deepEqual(seen, { macroStart: false, macroEnd: false, unescaped: false }, `新宏引擎不应识别：${s}`);
        assert.equal(unshieldMacros(shielded), s, '还原后与原文一致');
        // 不保护时酒馆确实会替换（证明移植的正则是有效的）
        if (/\{\{(char|user)\}\}|<USER>/i.test(s)) assert.notEqual(stSubstitute(s), s);
    }
    // 整个写卡提示词
    const p = project();
    const { system, prompt } = buildCardPrompt(p, settings(), { kind: 'character', charName: '莉莉丝', timepoint: Infinity });
    for (const t of [system, prompt]) {
        const shielded = shieldMacros(t);
        assert.ok(!/\{\{|\}\}/.test(shielded));
        assert.equal(stSubstitute(shielded), shielded);
        assert.equal(unshieldMacros(shielded), t);
        assert.ok(!stSubstitute(shielded).includes('Seraphina'));
    }
});

test('unshieldMacros：AI 照抄过来的零宽空格（花括号前后）都去掉，其他位置的不动', () => {
    assert.equal(unshieldMacros('{​{char}​}: 你好 ​{{user}}​'), '{{char}}: 你好 {{user}}');
    assert.equal(unshieldMacros('{​​{user}​​}'), '{{user}}');
    assert.equal(unshieldMacros('<​USER> 与 <​char>'), '<USER> 与 <char>');
    assert.equal(unshieldMacros('词​语'), '词​语');
    assert.equal(unshieldMacros('{"a":{"b":1}​}'), '{"a":{"b":1}}');
});

/** 模拟酒馆 generateRaw：createRawPrompt 对每条消息跑 substituteParams（并直接改写传进来的消息对象），AI 看到的是替换后的文字 */
function installTavern(reply, { onPrompt } = {}) {
    const seen = [];
    globalThis.SillyTavern = {
        getContext: () => ({
            name1: 'Persona小明',
            name2: 'Seraphina',
            async generateRaw({ prompt }) {
                for (const m of prompt) m.content = stSubstitute(m.content); // 与酒馆一样就地改写
                const text = prompt.map((m) => m.content).join('\n');
                seen.push(text);
                onPrompt?.(text);
                return typeof reply === 'function' ? reply(text) : reply;
            },
            stopGeneration() {},
            ConnectionManagerRequestService: {
                async sendRequest(id, msgs) {
                    const text = msgs.map((m) => m.content).join('\n');
                    seen.push(text);
                    return { content: typeof reply === 'function' ? reply(text) : reply };
                },
            },
        }),
    };
    return seen;
}

test('callLLM 酒馆当前连接：{{char}}/{{user}} 原样到达 AI（不被换成酒馆里打开的角色名），回复里的宏还原；传入的消息不被改写', async () => {
    const seen = installTavern('{​{char}​}: 坐。\n{{user}}: 好。');
    try {
        const messages = [{ role: 'system', content: '用 {{char}} 指代角色、{{user}} 指代用户' }, { role: 'user', content: '示例：{{char}}: 你好' }];
        const res = await callLLM({ api: { mode: 'tavern', retries: 0 }, messages: messages.slice(1), system: messages[0].content });
        assert.equal(res.text, '{{char}}: 坐。\n{{user}}: 好。');
        const aiSaw = seen[0].replace(/​/g, '');
        assert.match(aiSaw, /用 \{\{char\}\} 指代角色、\{\{user\}\} 指代用户/);
        assert.ok(!aiSaw.includes('Seraphina') && !aiSaw.includes('Persona小明'), aiSaw);
        assert.equal(messages[1].content, '示例：{{char}}: 你好', '调用方的消息对象不被酒馆改写');
        // tavernMacros：让酒馆照常替换（剧情推演·当前对话）
        await callLLM({ api: { mode: 'tavern', retries: 0 }, prompt: '{{char}} 和 {{user}}', tavernMacros: true });
        assert.equal(seen[1], 'Seraphina 和 Persona小明');
        // 连接配置档不做宏替换：原样发送，不插零宽空格
        await callLLM({ api: { mode: 'profile', profileId: 'p1', retries: 0 }, prompt: '{{char}} 和 {{user}}' });
        assert.equal(seen[2], '{{char}} 和 {{user}}');
    } finally {
        delete globalThis.SillyTavern;
    }
});

/**
 * 照 createRawPrompt 的写法拼文本补全的提示词（关掉指令模式时）：每条消息前加「名字: 」，name 没给时用 name1 / name2；
 * name 为空字符串时不加。返回拼好的文字。
 */
function stTextPrompt(prompt, { name1 = 'Persona小明', name2 = 'Seraphina' } = {}) {
    return prompt.map((m) => {
        let name = '';
        if (m.role === 'user') name = m.name ?? name1;
        if (m.role === 'assistant') name = m.name ?? name2;
        if (m.role === 'system') name = m.name ?? '';
        return (name ? `${name}: ` : '') + stSubstitute(m.content ?? '');
    }).join('\n');
}

/** 照 cleanUpMessage 的名字处理（allow_name1_display / allow_name2_display 都关着）：trimNames 时遇到「name1:」截断；总是删掉行首的「name2:」 */
function stCleanUp(text, { trimNames = true, name1 = 'Persona小明', name2 = 'Seraphina' } = {}) {
    let out = String(text);
    if (trimNames) {
        if (out.indexOf(`${name1}:`) === 0) out = '';
        const i = out.indexOf(`\n${name1}:`);
        if (i >= 0) out = out.substring(0, i);
    }
    out = out.replace(new RegExp(`(^|\n)${name2}:\\s*`, 'g'), '$1');
    if (trimNames && out.startsWith(`${name2}:`)) out = out.replace(`${name2}:`, '').trimStart();
    return out;
}

test('酒馆当前连接 · 文本补全：消息带空的 name，酒馆不在每条前面加当前的用户名 / 角色名；generateRaw 传 trimNames: false', async () => {
    const calls = [];
    const reply = '<START>\n{{user}}: 你好\nPersona小明: 我是江酒\n林黛玉: 嗯';
    globalThis.SillyTavern = {
        getContext: () => ({
            mainApi: 'textgenerationwebui',
            async generateRaw(opt) {
                const prompt = opt.prompt.map((m) => ({ ...m }));
                calls.push({ opt, text: stTextPrompt(prompt) });
                return stCleanUp(reply, { trimNames: opt.trimNames ?? true, name2: '林黛玉' });
            },
        }),
    };
    try {
        const res = await callLLM({ api: { mode: 'tavern', retries: 0 }, system: '系统说明', prompt: '写示例对话' });
        assert.ok(calls[0].opt.prompt.every((m) => m.name === ''), JSON.stringify(calls[0].opt.prompt));
        assert.equal(calls[0].opt.trimNames, false);
        assert.ok(!calls[0].text.includes('Persona小明') && !calls[0].text.includes('Seraphina'), calls[0].text);
        assert.equal(calls[0].text, '系统说明\n写示例对话');
        // 不再在「Persona小明:」处截断（江酒那行还在）；文本补全时行首的「当前角色名:」照旧被酒馆删掉（没有开关）
        assert.equal(res.text, '<START>\n{{user}}: 你好\nPersona小明: 我是江酒\n嗯');
        // 不传 name 时（旧的做法）酒馆会加上当前的名字：证明移植的拼法有效
        assert.match(stTextPrompt([{ role: 'user', content: 'x' }]), /^Persona小明: x$/);
        // 剧情推演·当前对话（tavernMacros）照旧：不改名字、用酒馆默认的 trimNames
        await callLLM({ api: { mode: 'tavern', retries: 0 }, prompt: '{{char}}', tavernMacros: true });
        assert.ok(calls[1].opt.prompt.every((m) => m.name === undefined));
        assert.equal(calls[1].opt.trimNames, true);
    } finally {
        delete globalThis.SillyTavern;
    }
});

test('酒馆当前连接 · 聊天补全：有 generateRawData 时取原始回复，不经过 cleanUpMessage（示例对话里「当前角色名:」的行不被删名字）；没有时退回 generateRaw', async () => {
    const reply = '<START>\n{{user}}: 你来了\n林黛玉: 嗯';
    const used = [];
    const ctxBase = {
        mainApi: 'openai',
        async generateRaw(opt) {
            used.push(['generateRaw', opt]);
            return stCleanUp(reply, { trimNames: opt.trimNames ?? true, name2: '林黛玉' });
        },
        async generateRawData(opt) {
            used.push(['generateRawData', opt]);
            return { choices: [{ message: { content: reply } }] };
        },
        extractMessageFromData: (data, api) => (api === 'openai' ? data?.choices?.[0]?.message?.content ?? '' : ''),
    };
    globalThis.SillyTavern = { getContext: () => ctxBase };
    try {
        const res = await callLLM({ api: { mode: 'tavern', retries: 0 }, prompt: '重新生成「示例对话」' });
        assert.equal(used[0][0], 'generateRawData');
        assert.ok(used[0][1].prompt.every((m) => m.name === undefined), '聊天补全不加 name 字段');
        assert.equal(res.text, reply, '「林黛玉:」原样保留，之后能规整成 {{char}}:');
        assert.equal(normalizeMesExample(res.text, { charName: '林黛玉' }), '<START>\n{{user}}: 你来了\n{{char}}: 嗯');
        // 回复为空：和酒馆一样报 No message generated（可重试）
        ctxBase.generateRawData = async () => ({ choices: [{ message: { content: '' } }] });
        await assert.rejects(() => callLLM({ api: { mode: 'tavern', retries: 0 }, prompt: 'x' }), /No message generated/);
        // 旧版酒馆没有 generateRawData：走 generateRaw（trimNames: false）
        delete ctxBase.generateRawData;
        used.length = 0;
        await callLLM({ api: { mode: 'tavern', retries: 0 }, prompt: 'x' });
        assert.equal(used[0][0], 'generateRaw');
        assert.equal(used[0][1].trimNames, false);
    } finally {
        delete globalThis.SillyTavern;
    }
});

// ---------------- 卡片名与示例对话 ----------------

const CARD_JSON = (extra = {}) => JSON.stringify({
    name: 'Seraphina', description: '基本信息', personality: '慢条斯理', scenario: '酒吧打烊后', first_mes: '“坐。”', alternate_greetings: ['雨夜。'],
    mes_example: '<START>\n江酒: 你好\n莉莉丝：坐。\n<START>\n{{user}}: 再来\n莉莉丝 : 好', tags: ['魔女'], ...extra,
});

test('卡片名：从不采用 AI 写的 name；单人卡 = 角色名，世界卡 = 表单里的卡名，没填用书名', async () => {
    const p = project();
    const s = settings();
    assert.equal(cardNameFor(p, { kind: 'character', charName: '莉莉丝' }), '莉莉丝');
    assert.equal(cardNameFor(p, { kind: 'world', cardName: '  ' }), '魔女');
    assert.equal(cardNameFor(p, { kind: 'world', cardName: '魔女旁白' }), '魔女旁白');
    installTavern(CARD_JSON());
    try {
        const c = await generateCard(p, s, { kind: 'character', charName: '莉莉丝', timepoint: Infinity });
        assert.equal(c.data.name, '莉莉丝');
        const w = await generateCard(p, s, { kind: 'world', timepoint: Infinity });
        assert.equal(w.data.name, '魔女', '世界卡默认用书名');
        assert.equal(w.cardName, '');
        const w2 = await generateCard(p, s, { kind: 'world', cardName: '下城区旁白', timepoint: Infinity });
        assert.equal(w2.data.name, '下城区旁白');
        assert.equal(w2.cardName, '下城区旁白');
    } finally {
        delete globalThis.SillyTavern;
    }
});

test('normalizeMesExample：行首的卡片名 → {{char}}:，{{user}} 扮演的角色名 → {{user}}:；<START> 与其他行不变', () => {
    const src = '<START>\n江酒: 你好\n莉莉丝：坐。\n  莉莉丝 ： 慢着\n莉莉丝说：不行\n<START>\n{{user}}: 再来\n江酒儿: 不是他';
    assert.equal(
        normalizeMesExample(src, { charName: '莉莉丝', userName: '江酒' }),
        '<START>\n{{user}}: 你好\n{{char}}: 坐。\n{{char}}: 慢着\n莉莉丝说：不行\n<START>\n{{user}}: 再来\n江酒儿: 不是他',
    );
    assert.equal(normalizeMesExample('<START>\n江酒: 你好', { charName: '莉莉丝' }), '<START>\n江酒: 你好', '没有 {{user}} 角色时不动别人的名字');
});

test('normalizeMesExample：已经写成宏但用了全角冒号 / 行首空白 / 大小写不对的说话人也规整成酒馆认得的「{{char}}: 」（酒馆按 startsWith 半角冒号识别）', () => {
    assert.equal(normalizeMesExample('{{char}}：嗯'), '{{char}}: 嗯');
    assert.equal(normalizeMesExample('{{User}} ：你好'), '{{user}}: 你好');
    assert.equal(normalizeMesExample('<START>\n{{user}}：你好\n{{char}}：嗯。\n  {{char}}:慢着', { charName: '莉莉丝' }), '<START>\n{{user}}: 你好\n{{char}}: 嗯。\n{{char}}: 慢着');
    // 不是行首说话人的不动
    assert.equal(normalizeMesExample('她说 {{char}}：不行\n{{char}}说：好'), '她说 {{char}}：不行\n{{char}}说：好');
    // 酒馆 parseExampleIntoIndividual 的判断：每个说话行都以「{{char}}:」或「{{user}}:」开头
    const out = normalizeMesExample('<START>\n{{user}}：你好\n莉莉丝：坐。', { charName: '莉莉丝' });
    for (const line of out.split('\n').slice(1)) assert.ok(line.startsWith('{{user}}:') || line.startsWith('{{char}}:'), line);
});

test('generateCard：{{user}} 扮演原著角色时示例对话里这个角色的台词改成 {{user}}；单字段重roll 示例对话同样规整', async () => {
    const p = project();
    const s = settings();
    installTavern((text) => (text.includes('重新生成「示例对话」') ? '<START>\n江酒：又见面了\n莉莉丝: 嗯' : CARD_JSON()));
    try {
        const c = await generateCard(p, s, { kind: 'character', charName: '莉莉丝', timepoint: Infinity, userRole: { kind: 'character', charKey: '江酒' } });
        assert.deepEqual(c.userRole, { kind: 'character', charKey: '江酒', text: '' });
        assert.equal(c.data.mes_example, '<START>\n{{user}}: 你好\n{{char}}: 坐。\n<START>\n{{user}}: 再来\n{{char}}: 好');
        await regenerateCardField(p, s, c, 'mes_example');
        assert.equal(c.data.mes_example, '<START>\n{{user}}: 又见面了\n{{char}}: 嗯');
    } finally {
        delete globalThis.SillyTavern;
    }
});

// ---------------- {{user}} 扮演 ----------------

test('normalizeUserRole：不认识的、没选角色、扮演卡片本人、自定义却没写内容都回到原创新身份', () => {
    assert.deepEqual(normalizeUserRole(null), { kind: 'new', charKey: '', text: '' });
    assert.deepEqual(normalizeUserRole({ kind: 'character', charKey: '' }), { kind: 'new', charKey: '', text: '' });
    assert.deepEqual(normalizeUserRole({ kind: 'character', charKey: '莉莉丝' }, { exclude: '莉莉丝' }), { kind: 'new', charKey: '', text: '' });
    assert.deepEqual(normalizeUserRole({ kind: 'custom', text: '  ' }), { kind: 'new', charKey: '', text: '' });
    assert.deepEqual(normalizeUserRole({ kind: 'custom', text: ' 调酒师 ', charKey: 'x' }), { kind: 'custom', charKey: '', text: '调酒师' });
    assert.deepEqual(normalizeUserRole({ kind: 'weird' }), { kind: 'new', charKey: '', text: '' });
});

test('写卡提示词 {USER_ROLE}：原著角色带资料（≤600 字）与写法要求；世界卡主要角色资料里去掉这个人；自定义；默认要求文字随之调整', () => {
    const p = project();
    const s = settings();
    p.characters['江酒'].experiences = Array.from({ length: 30 }, (_, i) => ({ chunk: 0, text: `经历${i}：`.padEnd(60, '长') }));
    const one = buildCardPrompt(p, s, { kind: 'character', charName: '莉莉丝', timepoint: Infinity, userRole: { kind: 'character', charKey: '江酒' } }).prompt;
    assert.match(one, /# \{\{user\}\} 的身份\n\{\{user\}\} 扮演原著角色「江酒」。「江酒」的资料：\n姓名: 江酒/);
    assert.match(one, /凡是指「江酒」的地方一律写成 \{\{user\}\}/);
    assert.match(one, /原著中 \{\{char\}\} 与「江酒」之间的关系，就是 \{\{char\}\} 与 \{\{user\}\} 的关系/);
    assert.match(one, /不替 \{\{user\}\} 说话、行动/);
    const block = userRolePromptBlock(p, { kind: 'character', charKey: '江酒' });
    const profile = block.split('的资料：\n')[1].split('\n- 卡片各字段')[0];
    assert.ok(profile.length <= 600, `资料不超过 600 字（${profile.length}）`);
    assert.match(one, /# 用户要求\n（无特别要求）\n\n# \{\{user\}\} 的身份/, '选了身份时默认要求不再说“新身份”');
    assert.ok(one.indexOf('# {{user}} 的身份') < one.indexOf('# 字段写法'), '放在字段写法前面');

    const world = buildCardPrompt(p, s, { kind: 'world', timepoint: Infinity, userRole: { kind: 'character', charKey: '江酒' } }).prompt;
    const profiles = world.split('# 角色资料（从原著提取）')[1].split('# 相关角色')[0];
    assert.ok(!profiles.includes('姓名: 江酒'), '世界卡的主要角色资料里没有 {{user}} 扮演的角色');
    assert.ok(profiles.includes('姓名: 莉莉丝'));
    assert.match(world, /主要角色一览里不要单独列出「江酒」/);
    // 世界卡的 {{char}} 是旁白：写的是原著里其他角色与这个人的关系
    assert.match(world, /原著中其他角色与「江酒」之间的关系，就是他们与 \{\{user\}\} 的关系/);
    assert.doesNotMatch(world, /原著中 \{\{char\}\} 与「江酒」/);

    const custom = buildCardPrompt(p, s, { kind: 'character', charName: '莉莉丝', timepoint: Infinity, userRole: { kind: 'custom', text: '新来的调酒师' } }).prompt;
    assert.match(custom, /\{\{user\}\} 的身份（用户设定）：新来的调酒师/);
    assert.match(custom, /「用户要求」里关于 \{\{user\}\} 身份的说法与这里冲突时，以这里为准/);
    assert.match(one, /「用户要求」里关于 \{\{user\}\} 身份的说法与这里冲突时，以这里为准/);
    // 原创新身份：不加「{{user}} 的身份」一节（用户可能在要求里写了 {{user}} 是原著里的谁，再说“不是任何角色”就矛盾了），
    // 没写要求时由「用户要求」的默认文字说明以新身份出现
    const plain = buildCardPrompt(p, s, { kind: 'character', charName: '莉莉丝', timepoint: Infinity }).prompt;
    assert.match(plain, /# 用户要求\n（无特别要求，\{\{user\}\} 以原著中可自然融入的新身份出现）\n\n# 字段写法/);
    assert.ok(!plain.includes('# {{user}} 的身份') && !plain.includes('不是原著中的任何角色'));
    const asked = buildCardPrompt(p, s, { kind: 'character', charName: '莉莉丝', timepoint: Infinity, requirement: '{{user}} 扮演原著里的江酒' }).prompt;
    assert.match(asked, /# 用户要求\n\{\{user\}\} 扮演原著里的江酒\n\n# 字段写法/, '用户要求里写的身份不被否定');
    assert.ok(!asked.includes('不是原著中的任何角色'));
    assert.equal(userRolePromptBlock(p, null), '');
    // 单人卡不能扮演卡片本人：当作原创新身份
    const self = buildCardPrompt(p, s, { kind: 'character', charName: '莉莉丝', timepoint: Infinity, userRole: { kind: 'character', charKey: '莉莉丝' } });
    assert.equal(self.userRole.kind, 'new');
});

test('写卡提示词 {ORIENTATION}：导向段逐字（名称 / 说明 / 写卡要求 / orientation_notes）；关掉细化时不要求 notes；自定义模板缺占位符时追加在末尾', () => {
    const p = project();
    const s = settings();
    const ntl = orientationFromPick(s, { id: 'orient_ntl', refine: true });
    const t = BUILTIN_ORIENTATIONS.find((x) => x.id === 'orient_ntl');
    const prompt = buildCardPrompt(p, s, { kind: 'character', charName: '莉莉丝', timepoint: Infinity, orientation: ntl }).prompt;
    const block = [`【卡的导向：NTL】${t.brief}`, `写卡要求：${t.cardGuide}`, ORIENTATION_PROMPT_LINES.notes].join('\n');
    assert.ok(prompt.includes(`\n${block}\n`), '导向段原样出现在提示词里');
    assert.ok(prompt.indexOf(block) < prompt.indexOf('# 字段写法'));
    const noRefine = buildCardPrompt(p, s, { kind: 'character', charName: '莉莉丝', timepoint: Infinity, orientation: { ...ntl, refine: false } }).prompt;
    assert.ok(noRefine.includes('【卡的导向：NTL】') && !noRefine.includes('orientation_notes'));
    const bg = buildCardPrompt(p, s, { kind: 'character', charName: '莉莉丝', timepoint: Infinity, orientation: ntl, askNotes: false }).prompt;
    assert.ok(bg.includes('【卡的导向：NTL】') && !bg.includes('orientation_notes'), '只作背景资料时不要求 notes');
    // 不限 + 原创新身份：和原来的提示词一样（没有多余的空行，JSON 模板里没有 orientation_notes）
    const none = buildCardPrompt(p, s, { kind: 'character', charName: '莉莉丝', timepoint: Infinity }).prompt;
    assert.match(none, /# 用户要求\n[^\n]+\n\n# 字段写法/);
    assert.match(none, /"creator_notes": "……",\n {2}"tags": \["……"\]\n\}/);
    // 开了细化：JSON 模板里也列出 orientation_notes（很多模型照抄模板的字段，只在前面提一句容易漏）；关掉细化 / 只作背景时没有
    const tpl = prompt.split('# 输出 JSON 模板')[1];
    assert.match(tpl, /"creator_notes": "……",\n {2}"orientation_notes": "- ……\\n- ……",\n {2}"tags"/);
    assert.ok(!noRefine.split('# 输出 JSON 模板')[1].includes('orientation_notes') && !bg.includes('orientation_notes'));
    assert.ok(PROMPT_PLACEHOLDERS.card.includes('{ORIENTATION_JSON}') && DEFAULT_PROMPTS.card.includes('"creator_notes": "……",{ORIENTATION_JSON}\n'));
    // 用户改过的模板没有占位符：追加在末尾；有占位符就不重复
    s.prompts.card = '为「{CHAR_NAME}」写卡。{REQUIREMENT}\n只输出 JSON。';
    const custom = buildCardPrompt(p, s, { kind: 'character', charName: '莉莉丝', timepoint: Infinity, orientation: ntl, userRole: { kind: 'character', charKey: '江酒' } }).prompt;
    assert.ok(custom.startsWith('为「莉莉丝」写卡。'));
    assert.ok(custom.includes('\n\n# {{user}} 的身份\n{{user}} 扮演原著角色「江酒」'));
    assert.ok(custom.endsWith(block), '导向段追加在最后');
    s.prompts.card = '{USER_ROLE}写卡{ORIENTATION}';
    const withPh = buildCardPrompt(p, s, { kind: 'character', charName: '莉莉丝', timepoint: Infinity, orientation: ntl }).prompt;
    assert.equal(withPh.split('【卡的导向：NTL】').length, 2, '有占位符时只出现一次');
    // 占位符登记在提示词设置里
    assert.ok(PROMPT_PLACEHOLDERS.card.includes('{USER_ROLE}') && PROMPT_PLACEHOLDERS.card.includes('{ORIENTATION}'));
    assert.ok(DEFAULT_PROMPTS.card.includes('{USER_ROLE}{ORIENTATION}'));
});

test('{{user}} 扮演原著角色 + 卡的导向：两人现在的关系以导向为准（原著关系只作底子），导向里的原伴侣 / 第三者不能是这个人；只有其中一个时没有这两句', () => {
    const p = project();
    const s = settings();
    const role = { kind: 'character', charKey: '江酒' };
    const ntr = orientationFromPick(s, { id: 'orient_ntr', refine: true });
    const PRECEDENCE = /原著中 \{\{char\}\} 与「江酒」之间的关系是两人关系的底子；「卡的导向」对两人现在关系的设定优先：保留「江酒」的身份和经历，按导向调整两人现在的关系。/;
    const NOT_X = /原伴侣、第三者等导向里的其他角色不能是「江酒」本人/;
    const both = buildCardPrompt(p, s, { kind: 'character', charName: '莉莉丝', timepoint: Infinity, userRole: role, orientation: ntr }).prompt;
    assert.match(both, PRECEDENCE);
    assert.match(both, NOT_X);
    assert.doesNotMatch(both, /就是 \{\{char\}\} 与 \{\{user\}\} 的关系；场景和开场白从这层关系出发/, '不再同时说原著关系就是现在的关系');
    const roleOnly = buildCardPrompt(p, s, { kind: 'character', charName: '莉莉丝', timepoint: Infinity, userRole: role }).prompt;
    assert.doesNotMatch(roleOnly, PRECEDENCE);
    assert.doesNotMatch(roleOnly, NOT_X);
    const orientOnly = buildCardPrompt(p, s, { kind: 'character', charName: '莉莉丝', timepoint: Infinity, userRole: { kind: 'custom', text: '调酒师' }, orientation: ntr }).prompt;
    assert.doesNotMatch(orientOnly, NOT_X);
    // 世界卡：其他角色与这个人的关系是底子，导向优先
    const world = buildCardPrompt(p, s, { kind: 'world', timepoint: Infinity, userRole: role, orientation: ntr }).prompt;
    assert.match(world, /原著中其他角色与「江酒」之间的关系是他们与 \{\{user\}\} 关系的底子；「卡的导向」对人物关系的设定优先/);
    // 重新生成本书落点的小提示词：一定有导向，同样以导向为准
    const card = baseCard({ userRole: role, orientation: ntr });
    assert.match(buildOrientationNotesPrompt(p, s, card).prompt, PRECEDENCE);

    // 世界书条目「{{user}} 的身份」：有导向时说明以剧情导向为准；世界卡写的是各角色与这个人的关系
    const entry = (extra) => userRoleEntry(p, baseCard({ userRole: role, ...extra })).content.split('\n\n')[0];
    assert.equal(entry({}), '{{user}} 扮演原著中的「江酒」。原著里「江酒」的经历、身份和人际关系都属于 {{user}}；{{char}} 与「江酒」之间的关系，就是 {{char}} 与 {{user}} 的关系。');
    assert.equal(entry({ orientation: ntr }), '{{user}} 扮演原著中的「江酒」。原著里「江酒」的经历、身份和人际关系都属于 {{user}}；{{char}} 与「江酒」之间的关系，就是 {{char}} 与 {{user}} 的关系，以此为基础；与「剧情导向」词条冲突时以剧情导向为准。');
    const w = entry({ kind: 'world', charName: '' });
    assert.equal(w, '{{user}} 扮演原著中的「江酒」。原著里「江酒」的经历、身份和人际关系都属于 {{user}}；原著里各角色与「江酒」之间的关系，就是他们与 {{user}} 的关系。');
    assert.ok(!w.includes('{{char}}'), '世界卡的 {{char}} 是旁白，不说 {{char}} 与这个人的关系');
});

test('generateCard：开了细化但 AI 没返回 orientation_notes 时提醒可以重新生成本书落点', async () => {
    const p = project();
    const s = settings();
    installTavern(CARD_JSON());
    const logs = [];
    try {
        const c = await generateCard(p, s, { kind: 'character', charName: '莉莉丝', timepoint: Infinity, orientation: orientationFromPick(s, { id: 'orient_ntl', refine: true }) }, { onLog: (m, l) => logs.push([m, l]) });
        assert.equal(c.orientation.notes, '');
        assert.ok(logs.some(([m, l]) => l === 'warn' && m.includes('没有返回本书落点') && m.includes('重新生成本书落点')), JSON.stringify(logs));
        logs.length = 0;
        await generateCard(p, s, { kind: 'character', charName: '莉莉丝', timepoint: Infinity, orientation: orientationFromPick(s, { id: 'orient_ntl', refine: false }) }, { onLog: (m, l) => logs.push([m, l]) });
        assert.ok(!logs.some(([m]) => m.includes('本书落点')), '没开细化时不提醒');
    } finally {
        delete globalThis.SillyTavern;
    }
});

// ---------------- 导向模板 ----------------

test('导向模板：内置 8 个只读；规整（长度、深度 / 角色 / 顺序）；新建 / 改 / 删 / 复制；重名与内置保护', () => {
    const s = settings();
    assert.deepEqual(BUILTIN_ORIENTATIONS.map((t) => t.name), ['纯爱', 'NTL', 'NTR', '后宫', '百合', '耽美', '虐恋', '日常']);
    assert.ok(BUILTIN_ORIENTATIONS.every((t) => t.entry.startsWith(`【剧情导向：${t.name}】\n- `) && t.depth === 4 && t.role === 0));
    const n = normalizeOrientationTemplate({ name: '  很长很长很长很长很长很长很长很长很长很长的名字  ', depth: '-3', role: 'user', order: 'x', entry: ' 正文 ' });
    assert.equal(n.name.length, 20);
    assert.equal(n.depth, 0);
    assert.equal(n.role, 1);
    assert.equal(n.order, 100);
    assert.equal(n.entry, '正文');
    assert.equal(normalizeOrientationTemplate({ role: 'assistant' }).role, 2);
    assert.equal(normalizeOrientationTemplate({ role: '' }).role, 0);

    const mine = addOrientationTemplate(s, { name: '师徒', brief: '师徒禁忌', cardGuide: '写师徒', entry: '【剧情导向：师徒】\n- 不能说破', depth: 2, order: 7 });
    assert.match(mine.id, /^otpl_/);
    assert.equal(listOrientationTemplates(s).length, 9);
    assert.throws(() => addOrientationTemplate(s, { name: ' 师 徒 ', entry: 'x' }), /同名/);
    assert.throws(() => addOrientationTemplate(s, { name: '纯爱', entry: 'x' }), /同名/);
    assert.throws(() => updateOrientationTemplate(s, 'orient_pure', { name: 'x' }), /内置导向不能修改/);
    const up = updateOrientationTemplate(s, mine.id, { entry: '新正文', role: 2 });
    assert.equal(up.entry, '新正文');
    assert.equal(up.role, 2);
    assert.equal(up.depth, 2, '没改的字段保留');
    const copy = duplicateOrientationTemplate(s, 'orient_ntl');
    assert.equal(copy.name, 'NTL 2', '复制内置模板：自动避开重名');
    assert.equal(copy.entry, getOrientationTemplate(s, 'orient_ntl').entry);
    assert.equal(removeOrientationTemplate(s, 'orient_pure'), false);
    assert.equal(removeOrientationTemplate(s, mine.id), true);
    assert.equal(getOrientationTemplate(s, mine.id), null);
});

test('导向模板导入导出：导出文件可再导入（重名改名）；认不出的文件报错；导入配置按 id 合并', () => {
    const s = settings();
    const a = addOrientationTemplate(s, { name: '师徒', brief: 'b', cardGuide: 'g', entry: 'e', depth: 3, role: 1, order: 9 });
    const file = exportOrientationTemplates([a]);
    assert.equal(file.type, 'novel_loom_orientation_templates');
    assert.deepEqual(file.templates[0], { name: '师徒', brief: 'b', cardGuide: 'g', entry: 'e', depth: 3, role: 1, order: 9 });
    const created = importOrientationTemplates(s, JSON.stringify(file));
    assert.equal(created[0].name, '师徒 2');
    assert.notEqual(created[0].id, a.id);
    assert.equal(parseOrientationTemplates({ name: '单个', entry: '正文' })[0].name, '单个');
    assert.throws(() => parseOrientationTemplates('{bad'), /不是有效的 JSON/);
    assert.throws(() => parseOrientationTemplates({ foo: 1 }), /不是 NovelLoom 导向模板文件/);
    assert.throws(() => parseOrientationTemplates({ templates: [{ name: '' }] }), /没有可用的导向模板/);

    // applyConfig：同 id 覆盖、新的追加、内置 id 与不合法的跳过、本机其他模板保留
    const t = settings();
    const keep = addOrientationTemplate(t, { name: '本机', entry: '本机正文' });
    const same = addOrientationTemplate(t, { name: '旧', entry: '旧正文' });
    applyConfig(t, { type: 'novel_loom_config', settings: { orientationTemplates: [
        { id: same.id, name: '新', entry: '新正文', depth: 99999 },
        { id: 'otpl_new1', name: '导入的', entry: '导入正文' },
        { id: 'orient_pure', name: '冒充内置', entry: 'x' },
        { id: 'otpl_bad', name: '', entry: '' },
        'junk',
    ] } });
    const ids = t.orientationTemplates.map((x) => x.id);
    assert.deepEqual(ids, [keep.id, same.id, 'otpl_new1']);
    assert.equal(t.orientationTemplates[1].name, '新');
    assert.equal(t.orientationTemplates[1].depth, 9999);
    assert.equal(getOrientationTemplate(t, 'orient_pure').name, '纯爱');
});

test('本书落点：orientation_notes 字符串 / 数组 / 编号列表都规整成「- 」开头的行；回复不是 JSON 时取「- 」行', () => {
    assert.equal(parseOrientationNotes({ orientation_notes: '1. 原伴侣是江酒\n- 第三者是姜小白\n\n* 阻碍：魔女契约' }), '- 原伴侣是江酒\n- 第三者是姜小白\n- 阻碍：魔女契约');
    assert.equal(parseOrientationNotes({ orientation_notes: ['甲', '- 乙'] }), '- 甲\n- 乙');
    assert.equal(parseOrientationNotes({ name: 'x' }), '');
    assert.equal(parseOrientationNotes(null, '好的：\n- 一\n- 二\n结束'), '- 一\n- 二');
    assert.equal(parseOrientationNotes({ orientation_notes: Array.from({ length: 12 }, (_, i) => `第${i}`) }).split('\n').length, 8, '最多 8 行');
});

test('generateCard：导向快照存在卡上，开了细化时解析 orientation_notes；关掉时不要 notes', async () => {
    const p = project();
    const s = settings();
    let lastPrompt = '';
    installTavern(CARD_JSON({ orientation_notes: '- 原伴侣：江酒\n- 关键阻碍：魔女契约' }), { onPrompt: (t) => { lastPrompt = t; } });
    try {
        const c = await generateCard(p, s, { kind: 'character', charName: '莉莉丝', timepoint: Infinity, orientation: orientationFromPick(s, { id: 'orient_ntl', refine: true }) });
        assert.equal(c.orientation.templateId, 'orient_ntl');
        assert.equal(c.orientation.name, 'NTL');
        assert.equal(c.orientation.notes, '- 原伴侣：江酒\n- 关键阻碍：魔女契约');
        assert.equal(c.orientation.depth, 4);
        assert.ok(lastPrompt.replace(/​/g, '').includes('orientation_notes'));
        const off = await generateCard(p, s, { kind: 'character', charName: '莉莉丝', timepoint: Infinity, orientation: orientationFromPick(s, { id: 'orient_ntl', refine: false }) });
        assert.equal(off.orientation.notes, '');
        assert.equal(off.orientation.refine, false);
        const none = await generateCard(p, s, { kind: 'character', charName: '莉莉丝', timepoint: Infinity });
        assert.equal(none.orientation, null);
        // 自定义导向（只这一次）
        const custom = orientationFromPick(s, { id: ORIENTATION_CUSTOM, customName: '师徒禁忌', customBrief: '师徒暗生情愫', refine: true });
        assert.equal(custom.entry, '【剧情导向：师徒禁忌】\n师徒暗生情愫');
        assert.equal(orientationPromptBlock(custom), `【卡的导向：师徒禁忌】师徒暗生情愫\n${ORIENTATION_PROMPT_LINES.notes}`);
        assert.equal(orientationFromPick(s, { id: ORIENTATION_CUSTOM }), null);
        assert.equal(orientationFromPick(s, { id: '' }), null);
    } finally {
        delete globalThis.SillyTavern;
    }
});

// ---------------- 卡片自己的世界书条目 ----------------

function baseCard(extra = {}) {
    return {
        id: 'c1', kind: 'character', charName: '莉莉丝', timepoint: null, stAvatar: '', worldName: '',
        data: { name: '莉莉丝', description: 'd', personality: 'p', scenario: 's', first_mes: '“坐。”', alternate_greetings: [], mes_example: '<START>', system_prompt: '', post_history_instructions: '', creator_notes: '', tags: [] },
        ...extra,
    };
}

test('世界书条目：剧情导向（常驻、@深度 4、系统角色，正文 + 【本书落点】）与「{{user}} 的身份」；原创新身份 / 不限时没有', () => {
    const p = project();
    const s = settings();
    const o = { ...orientationFromPick(s, { id: 'orient_ntl' }), notes: '- 原伴侣：江酒' };
    const e = orientationEntry({ orientation: o });
    assert.equal(e.comment, '剧情导向：NTL');
    assert.equal(e.name, '剧情导向：NTL');
    assert.deepEqual([e.constant, e.position, e.depth, e.role, e.disable], [true, 4, 4, 0, false]);
    assert.equal(e.content, `${o.entry}\n\n【本书落点】\n- 原伴侣：江酒`);
    assert.equal(orientationEntryContent({ ...o, notes: '' }), o.entry);
    assert.equal(orientationEntry({ orientation: null }), null);

    const ur = userRoleEntry(p, baseCard({ userRole: { kind: 'character', charKey: '江酒' } }));
    assert.equal(ur.comment, USER_ROLE_ENTRY_TITLE);
    assert.equal(ur.constant, true);
    assert.match(ur.content, /\{\{user\}\} 扮演原著中的「江酒」/);
    assert.match(ur.content, /姓名: 江酒/);
    assert.match(userRoleEntry(p, baseCard({ userRole: { kind: 'custom', text: '调酒师' } })).content, /^\{\{user\}\} 的身份：调酒师/);
    assert.equal(userRoleEntry(p, baseCard({ userRole: { kind: 'new' } })), null);
    assert.equal(userRoleEntry(p, baseCard({ userRole: { kind: 'character', charKey: '莉莉丝' } })), null, '扮演卡片本人无效');
    assert.deepEqual(cardExtraEntries(p, s, baseCard()), []);
});

test('prepareCard：带导向 / 身份条目的卡（没有状态栏）用自己的世界书，条目进世界书和内嵌 character_book；{{user}} 扮演的角色不重复写资料', () => {
    const p = project();
    const s = settings();
    const plain = prepareCard(p, s, baseCard());
    assert.equal(plain.ownWorld, false);
    assert.equal(plain.worldName, '《魔女》世界书');

    const c = baseCard({ orientation: { ...orientationFromPick(s, { id: 'orient_ntl' }), notes: '- 原伴侣：江酒' }, userRole: { kind: 'character', charKey: '江酒' } });
    assert.equal(cardOwnWorld(c), true);
    const r = prepareCard(p, s, c);
    assert.equal(r.ownWorld, true);
    assert.equal(r.statusBar, false);
    assert.equal(r.worldName, '《魔女》世界书·莉莉丝');
    assert.equal(r.json.data.extensions.world, r.worldName);
    assert.equal(r.json.data.character_book.name, r.worldName);
    const names = r.entries.map((e) => e.comment || `${e.category} - ${e.name}`);
    assert.ok(names.includes('剧情导向：NTL') && names.includes('{{user}} 的身份'), names.join(' | '));
    assert.ok(!r.entries.some((e) => e.category === '角色' && (e.name === '江酒' || e.name === '莉莉丝')), '卡片本人和 {{user}} 扮演的角色都不重复写入资料条目');
    assert.ok(r.entries.some((e) => e.category === '角色' && e.name === '姜小白'));
    const book = r.json.data.character_book.entries;
    const oe = book.find((e) => e.comment === '剧情导向：NTL');
    assert.equal(oe.constant, true);
    assert.equal(oe.extensions.position, 4);
    assert.equal(oe.extensions.depth, 4);
    assert.equal(oe.extensions.role, 0);
    assert.match(oe.content, /【本书落点】\n- 原伴侣：江酒$/);
    // 关掉内嵌与绑定：内嵌的只有本卡条目，仍然绑定自己的世界书
    const s2 = settings();
    s2.cards.linkWorldbook = false;
    s2.cards.embedWorldbook = false;
    const r2 = prepareCard(p, s2, c);
    assert.deepEqual(r2.json.data.character_book.entries.map((e) => e.comment), ['剧情导向：NTL', '{{user}} 的身份']);
    assert.equal(r2.json.data.extensions.world, '《魔女》世界书·莉莉丝');
    // 带状态栏：本卡条目在资料之后、状态栏条目之前
    const sb = baseCard({ orientation: orientationFromPick(s, { id: 'orient_pure' }) });
    ensureStatusBar(sb, s);
    sb.statusBar.spec = normalizeStatusSpec({ title: '莉莉丝', variables: [{ path: '莉莉丝.好感度', type: 'number', init: 20, min: 0, max: 100 }] });
    const r3 = prepareCard(p, s, sb);
    assert.equal(r3.statusBar, true);
    assert.deepEqual(r3.entries.slice(-5).map((e) => e.comment), ['剧情导向：纯爱', '[initvar]变量初始化勿开', '变量列表', '[mvu_update]变量更新规则', '[mvu_update]变量输出格式']);
});

/** unique：每张新卡导入成不同的头像文件（lilith、lilith1、lilith2…，像酒馆遇到同名文件时那样），更新时沿用原来的 */
function installPublishST({ unique = false } = {}) {
    const saved = { worlds: {}, imports: [] };
    let n = 0;
    const ctx = {
        name1: 'User', characters: [],
        getRequestHeaders: () => ({ 'Content-Type': 'application/json' }),
        async saveWorldInfo(name, data) { saved.worlds[name] = structuredClone(data); },
        async updateWorldInfoList() {},
        async getCharacters() {},
        extensionSettings: {},
        saveSettingsDebounced() {},
    };
    globalThis.SillyTavern = { getContext: () => ctx };
    const origFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
        if (url === '/api/characters/import') {
            const file = init.body.get('avatar');
            const preserved = init.body.get('preserved_name');
            saved.imports.push({ json: JSON.parse(await file.text()), preserved });
            const name = unique ? preserved || `lilith${n++ || ''}` : 'lilith';
            if (!ctx.characters.some((ch) => ch.avatar === `${name}.png`)) ctx.characters.push({ avatar: `${name}.png` });
            return new Response(JSON.stringify({ file_name: name }), { status: 200 });
        }
        return new Response('{}', { status: 404 });
    };
    return { saved, restore: () => { globalThis.fetch = origFetch; delete globalThis.SillyTavern; } };
}

test('publishCard：剧情导向写进卡自己的世界书；改导向后重新写入同一本被更新；改成「不限」后条目被去掉（仍写回同一本）', async () => {
    const p = project();
    const s = settings();
    s.cards.linkWorldbook = false;
    s.cards.embedWorldbook = false; // 绑定、内嵌都关：专用世界书里只有本卡条目（与状态栏卡同一规则）
    const { saved, restore } = installPublishST();
    const comments = (name) => Object.values(saved.worlds[name].entries).map((e) => e.comment);
    try {
        const c = baseCard({ orientation: { ...orientationFromPick(s, { id: 'orient_ntl' }), notes: '- 原伴侣：江酒' } });
        const r = await publishCard(p, s, c);
        assert.equal(r.ownWorld, true);
        assert.equal(c.ownWorldName, '《魔女》世界书·莉莉丝');
        assert.equal(c.worldName, '', '普通的“绑定世界书名称”不被覆盖');
        assert.deepEqual(comments(c.ownWorldName), ['剧情导向：NTL'], '没开绑定时专用世界书里只有本卡条目');
        const w = Object.values(saved.worlds[c.ownWorldName].entries)[0];
        assert.deepEqual([w.constant, w.position, w.depth, w.role], [true, 4, 4, 0]);
        assert.equal(saved.imports[0].json.data.extensions.world, c.ownWorldName);

        // 改导向：同一本里的条目被替换
        s.worldbook.namePattern = '《{book}》新名字';
        c.orientation = { ...orientationFromPick(s, { id: 'orient_pure' }), notes: '' };
        await publishCard(p, s, c);
        assert.deepEqual(comments('《魔女》世界书·莉莉丝'), ['剧情导向：纯爱'], '沿用记下的名字');
        assert.equal(saved.imports[1].preserved, 'lilith');

        // 不限：仍写回同一本（把旧条目清掉），卡片照样绑定它
        c.orientation = null;
        assert.equal(cardOwnWorld(c), true, '写入过专用世界书的卡继续用它');
        const r3 = await publishCard(p, s, c);
        assert.equal(r3.worldName, '《魔女》世界书·莉莉丝');
        assert.deepEqual(comments('《魔女》世界书·莉莉丝'), []);
        assert.ok(!(saved.imports[2].json.data.character_book?.entries || []).some((e) => /剧情导向/.test(e.comment)));
        // 资料条目开着时照常带上资料
        s.cards.linkWorldbook = true;
        await publishCard(p, s, c);
        assert.ok(comments('《魔女》世界书·莉莉丝').some((x) => /角色 - 江酒/.test(x)));
    } finally {
        restore();
    }
});

test('专用世界书名在项目里不重复：同一角色的两张卡（NTL / 纯爱）各写各的，互不覆盖；改成「不限」重新写入只清自己那本；记下的名字不再变', async () => {
    const p = project();
    const s = settings();
    s.cards.linkWorldbook = false;
    s.cards.embedWorldbook = false;
    const { saved, restore } = installPublishST({ unique: true });
    const comments = (name) => Object.values(saved.worlds[name].entries).map((e) => e.comment);
    try {
        const a = baseCard({ id: 'ca', orientation: { ...orientationFromPick(s, { id: 'orient_ntl' }), notes: '- 原伴侣：江酒' } });
        const b = baseCard({ id: 'cb', orientation: orientationFromPick(s, { id: 'orient_pure' }), userRole: { kind: 'custom', text: '新来的调酒师' } });
        p.cards.push(a, b);
        // 写入前：编辑框里显示的名字就是写入时用的（排在前面的卡保留基础名，后面的加上导向名）
        assert.equal(cardWorldField(p, s, a).shown, '《魔女》世界书·莉莉丝');
        assert.equal(cardWorldField(p, s, b).shown, '《魔女》世界书·莉莉丝·纯爱');
        // 后面的卡先写入也一样
        const rb = await publishCard(p, s, b);
        const ra = await publishCard(p, s, a);
        assert.equal(rb.worldName, '《魔女》世界书·莉莉丝·纯爱');
        assert.equal(ra.worldName, '《魔女》世界书·莉莉丝');
        assert.equal(b.ownWorldName, rb.worldName);
        assert.equal(a.ownWorldName, ra.worldName);
        assert.notEqual(a.stAvatar, b.stAvatar);
        assert.equal(saved.imports[0].json.data.extensions.world, rb.worldName);
        assert.equal(saved.imports[1].json.data.extensions.world, ra.worldName);
        assert.deepEqual(comments(ra.worldName), ['剧情导向：NTL'], 'A 的世界书只有 A 的导向');
        assert.deepEqual(comments(rb.worldName), ['剧情导向：纯爱', '{{user}} 的身份'], 'B 的世界书没被 A 覆盖');
        // A 改成「不限」再写入：只清 A 自己那本，B 的不动
        a.orientation = null;
        const ra2 = await publishCard(p, s, a);
        assert.equal(ra2.worldName, ra.worldName);
        assert.deepEqual(comments(ra.worldName), []);
        assert.deepEqual(comments(rb.worldName), ['剧情导向：纯爱', '{{user}} 的身份']);
        // 再次写入沿用记下的名字（即使现在基础名空出来了）
        const rb2 = await publishCard(p, s, b);
        assert.equal(rb2.worldName, '《魔女》世界书·莉莉丝·纯爱');
        assert.equal(saved.imports.at(-1).preserved, b.stAvatar);
        // 同一导向再来两张：导向名也被占了就用数字
        const c3 = baseCard({ id: 'cc', orientation: orientationFromPick(s, { id: 'orient_pure' }) });
        p.cards.push(c3);
        assert.equal(statusBarWorldName(p, s, c3), '《魔女》世界书·莉莉丝·2');
        const c4 = baseCard({ id: 'cd', orientation: orientationFromPick(s, { id: 'orient_ntr' }) });
        p.cards.push(c4);
        assert.equal(statusBarWorldName(p, s, c4), '《魔女》世界书·莉莉丝·NTR');
        // 世界卡没填卡名（都叫书名）同样不重名；没有专用世界书的普通卡不占名字
        const world = (id) => ({ ...baseCard({ id, kind: 'world', charName: '', userRole: { kind: 'custom', text: '旅人' } }), data: { ...baseCard().data, name: '魔女' } });
        const plain = { ...baseCard({ id: 'plain' }), data: { ...baseCard().data, name: '魔女' } };
        const w1 = world('w1');
        const w2 = world('w2');
        p.cards.push(plain, w1, w2);
        assert.equal(statusBarWorldName(p, s, w1), '《魔女》世界书·魔女');
        assert.equal(statusBarWorldName(p, s, w2), '《魔女》世界书·魔女·2');
        // 卡片副本（同 id，比如编辑框里拿草稿算）与原卡算同一张
        assert.equal(statusBarWorldName(p, s, { ...w2 }), '《魔女》世界书·魔女·2');
    } finally {
        restore();
    }
});

test('编辑框的“绑定世界书名称”：带导向的卡显示本卡专用的世界书，改名写进 ownWorldName；状态栏卡照旧', () => {
    const p = project();
    const s = settings();
    const c = baseCard({ orientation: orientationFromPick(s, { id: 'orient_daily' }) });
    const f = cardWorldField(p, s, c);
    assert.deepEqual(f, { sb: true, own: true, shown: '《魔女》世界书·莉莉丝' });
    assert.match(cardWorldLabelHtml(f.sb, f.own), /本卡专用/);
    assert.match(cardWorldLabelHtml(true), /状态栏卡专用/);
    applyCardWorldInput(c, f, f.shown);
    assert.equal(c.ownWorldName, undefined, '没改动不写死');
    applyCardWorldInput(c, f, '  莉莉丝·导向  ');
    assert.equal(c.ownWorldName, '莉莉丝·导向');
    assert.equal(c.worldName, '');
    assert.equal(statusBarWorldName(p, s, c), '莉莉丝·导向');
    // 状态栏卡（以前记着状态栏专用名）：写回 statusBar.worldName
    const sb = baseCard();
    ensureStatusBar(sb, s);
    sb.statusBar.spec = normalizeStatusSpec({ title: 'x', variables: [{ path: '莉莉丝.好感度', type: 'number', init: 1, min: 0, max: 9 }] });
    const f2 = cardWorldField(p, s, sb);
    assert.equal(f2.own, undefined);
    applyCardWorldInput(sb, f2, '状态栏专用');
    assert.equal(sb.statusBar.worldName, '状态栏专用');
});

test('改名 / 合并角色时，卡片上 {{user}} 扮演的角色跟着改', () => {
    const p = project();
    p.cards.push(baseCard({ userRole: { kind: 'character', charKey: '江酒', text: '' } }));
    renameCharacter(p, '江酒', '江小酒');
    assert.equal(p.cards[0].userRole.charKey, '江小酒');
});

// ---------------- 状态栏提示词 / 重新生成本书落点 ----------------

test('状态栏变量表提示词 {USER_ROLE}：主角 = {{user}} 扮演的角色；世界卡的主要角色名单里去掉这个人；模板缺占位符时追加', () => {
    const p = project();
    const s = settings();
    const c = baseCard({ userRole: { kind: 'character', charKey: '江酒' } });
    ensureStatusBar(c, s);
    const { prompt } = buildStatusSpecPrompt(p, s, c);
    assert.match(prompt, /# 主角（\{\{user\}\}）的身份\n主角就是 \{\{user\}\}，扮演原著角色「江酒」/);
    assert.ok(prompt.indexOf('# 主角（{{user}}）的身份') < prompt.indexOf('# 设计要求'));
    assert.ok(!prompt.includes('{USER_ROLE}'));
    const plainCard = baseCard();
    ensureStatusBar(plainCard, s);
    const plain = buildStatusSpecPrompt(p, s, plainCard).prompt;
    assert.ok(!plain.includes('主角（{{user}}）的身份'));
    assert.match(plain, /# 用户要求\n（无特别要求）\n\n# 设计要求/, '原创新身份时与原来一样');

    const w = { ...baseCard({ kind: 'world', charName: '', userRole: { kind: 'character', charKey: '江酒' } }), data: { ...baseCard().data, name: '魔女' } };
    ensureStatusBar(w, s);
    const wp = buildStatusSpecPrompt(p, s, w).prompt;
    const cast = wp.split('init 里为下面每个主要角色各写一个条目，键照抄名字，初始值符合开场白的情境：')[1].split('\n')[0];
    assert.ok(cast.includes('莉莉丝') && !cast.includes('江酒'), cast);
    s.prompts.statusSpec = '设计变量 {REQUIREMENT}';
    assert.ok(buildStatusSpecPrompt(p, s, c).prompt.endsWith('- 「江酒」就是主角：不要再为「江酒」建角色变量，也不要把「江酒」放进按角色名记录的记录里。'));
});

test('重新生成本书落点：小提示词（导向、词条正文、{{user}} 身份、卡片内容、原著资料）+ 写卡消息链；只返回 notes', async () => {
    const p = project();
    const s = settings();
    const card = baseCard({ orientation: orientationFromPick(s, { id: 'orient_ntr' }), userRole: { kind: 'custom', text: '莉莉丝的未婚夫' } });
    const { system, prompt } = buildOrientationNotesPrompt(p, s, card, { orientation: { ...card.orientation, entry: '改过的正文' }, instruction: '第三者用姜小白' });
    assert.match(system, /《魔女》/);
    assert.match(prompt, /【卡的导向：NTR】/);
    assert.match(prompt, /<词条正文>\n改过的正文\n<\/词条正文>/);
    assert.match(prompt, /\{\{user\}\} 的身份（用户设定）：莉莉丝的未婚夫/);
    assert.match(prompt, /姓名：莉莉丝/);
    assert.match(prompt, /额外要求（优先满足）：第三者用姜小白/);
    assert.ok(!/\{[A-Z_]+\}/.test(prompt), '占位符全部替换');
    assert.ok(PROMPT_LABELS.orientationNotes && PROMPT_LABELS.orientationNotesSystem && PROMPT_PLACEHOLDERS.orientationNotes.includes('{ORIENTATION_ENTRY}'));
    s.messageChains.card = [{ role: 'system', content: '写卡链 {SYSTEM}', enabled: true }, { role: 'user', content: '{PROMPT}', enabled: true }];
    let seen = '';
    installTavern('```json\n{"orientation_notes": "1. 第三者：姜小白\\n2. 阻碍：婚约"}\n```', { onPrompt: (t) => { seen = t; } });
    try {
        const notes = await regenerateOrientationNotes(p, s, card, { instruction: '' });
        assert.equal(notes, '- 第三者：姜小白\n- 阻碍：婚约');
        assert.ok(seen.startsWith('写卡链 '), '用写卡任务的消息链');
        assert.equal(card.orientation.notes, '', '只返回结果，不直接改卡片');
    } finally {
        delete globalThis.SillyTavern;
    }
    await assert.rejects(() => regenerateOrientationNotes(p, s, baseCard()), /没有选择剧情导向/);
});
