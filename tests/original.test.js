// 原创写卡（不导入 TXT）：空项目的形状与各处在没有分段时的表现；原创写卡提示词（单人卡 / 世界卡、所有附加段落、自定义模板追加、
// 已定下设定时的重写）；AI 回复里 character / cast / lore 的解析；存进项目的规则（手动角色 / 条目、同名覆盖或加后缀、改名同步、
// 重新提取不删）；整卡重新生成、单字段重roll、剧情推演背景、本书落点按原创设定；写入酒馆（没存时作为卡自己世界书的条目、存了走项目世界书）；
// 状态栏（世界卡的主要角色、背景资料）；写卡表单的说明文字
import test from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_CATEGORIES, DEFAULT_SETTINGS } from '../src/constants.js';
import { mergeDefaults } from '../src/utils.js';
import {
    buildOutlineText, characterAt, createEmptyProject, createProject, deleteChunkAt, findCharacterKey, findEntryKey, freeOriginalProjectName, getTailText,
    getVolumes, mergeCharacter, mergeChunkWithNext, mergeEntry, normalizeProject, projectStats, renameCharacter,
} from '../src/project.js';
import { buildChunks, detectChapters } from '../src/splitter.js';
import { buildCardPrompt, buildOrientationNotesPrompt, cardPromptOpt, generateCard, regenerateCardField, timepointLabel } from '../src/cards.js';
import { orientationFromPick, ORIENTATION_PROMPT_LINES } from '../src/orientation.js';
import { cardEntries, cardExtraEntries, cardOwnWorld, defaultWorldName, prepareCard, publishCard } from '../src/publish.js';
import { DEFAULT_PROMPTS, PROMPT_LABELS, PROMPT_PLACEHOLDERS, WRITING_RULES } from '../src/prompts.js';
import { buildStatusSpecPrompt } from '../src/statusbar-ai.js';
import { ensureStatusBar, worldCastNames } from '../src/statusbar.js';
import { buildWorldbookEntries } from '../src/worldbook.js';
import { removeChunkContributions, resetChunksForReextract } from '../src/extract.js';
import { nextChapterNo } from '../src/planner.js';
import { addUserProfile, userProfileSnapshot } from '../src/userprofile.js';
import { userRoleEntry, userRoleLabel, userRoleStatusText } from '../src/userrole.js';
import { listStylePresets, NO_STYLE_ID } from '../src/style.js';
import {
    isOriginalCard, normalizeCardOriginal, originalBackgroundText, originalCastNames, originalDesignView, originalHasOwnEntries, originalInputProblem,
    originalLoreCategories, originalNovelAvailable, originalOwnEntries, originalPromptText, originalSaveForced, originalSaveLog, originalSavePlan,
    parseOriginalDesign, projectHasSource, saveOriginalDesign, suffixedName,
} from '../src/original.js';
import { pipelineState } from '../src/ui/pipeline.js';
import {
    cardSourceNote, cardStyleName, cardWorldField, originalInputSummary, originalSaveNote, originalSaveStateText, sourceWord, userRoleFormNote, userRoleKindOptions,
} from '../src/ui/tab-cards.js';

const ADULT = '所有涉及恋爱或亲密内容的人物（包括 {{user}}）都是成年人';

function settings() {
    const s = mergeDefaults({}, DEFAULT_SETTINGS);
    s.categories = structuredClone(DEFAULT_CATEGORIES);
    s.api.retries = 0;
    s.api.retryBaseMs = 500;
    s.antiTruncate.enabled = false;
    return s;
}

const NOVEL = ['第一章 魔女小姐', '江酒走进酒吧。莉莉丝坐在角落。', '第二章 女仆', '江酒穿上了女仆装。'].join('\n');

function novelProject() {
    const chunks = detectChapters(NOVEL, '^第.+章.*$').map((ch) => buildChunks([ch], 1000, false)[0]);
    chunks.forEach((c, i) => (c.index = i));
    const p = createProject({ name: '魔女', text: NOVEL, chunks });
    mergeCharacter(p, { name: '江酒', identity: '莉莉丝的前男友', importance: 'main' }, 0);
    mergeCharacter(p, { name: '莉莉丝', identity: '大魔女', importance: 'main' }, 0);
    mergeEntry(p, '地点', { name: '酒吧', keywords: ['酒吧'], content: '莉莉丝经营的酒吧' }, 0);
    return p;
}

/** AI 的原创写卡回复（单人卡） */
const SINGLE_REPLY = {
    name: 'AI 写的名字', description: '基本信息:\n  姓名: 林晚', personality: '慢', scenario: '雨天的书店', first_mes: '“又下雨了。”', alternate_greetings: ['雨停了。'],
    mes_example: '<START>\n{{user}}: 还开着吗？\n林晚: 开着。', creator_notes: '原创', tags: ['原创'],
    character: {
        name: '林晚', aliases: ['阿晚'], gender: '女', age: '二十四岁', identity: '雾港旧书店的店主', personality: '说话慢', relationship: '{{user}} 是常来避雨的客人',
        appearance: ['左耳戴铜质书签耳坠'], verbalTics: ['称呼客人为“先生”'], experiences: ['十九岁继承了祖母的旧书店'],
    },
    lore: [
        { category: '地点', name: '雾港旧书店', keys: ['旧书店'], content: '位置: 雾港老城区' },
        { category: '组织', name: '港务署', keys: '港务署，港务', content: '性质: 管理码头' },
        { category: '地点/场景', name: '三号码头', keys: [], content: '夜里有渡轮' },
        { category: '人物', name: '不该出现', content: '人物不放进 lore' },
    ],
};

/** AI 的原创写卡回复（世界卡） */
const WORLD_REPLY = {
    name: '雾港旧事', description: '世界总览', personality: '', scenario: '雾夜', first_mes: '汽笛声穿过浓雾。', alternate_greetings: [], mes_example: '<START>\n{{char}}: 雾港。', tags: ['港城'],
    cast: [
        { 名字: '沈砚', 身份: '雾港警署的探长', 性格: '嘴硬心软', 重要度: 'main' },
        { name: '阿绫', identity: '茶楼老板娘' },
        { name: '老周', identity: '摆渡人', importance: 'support' },
    ],
    lore: { 世界观: [{ name: '雾港', keywords: ['雾港'], content: '常年起雾' }], 地点: [{ name: '码头茶楼', content: '三号码头' }] },
};

function installTavern(reply, seen) {
    globalThis.SillyTavern = {
        getContext: () => ({
            async generateRaw({ prompt }) {
                const text = prompt.map((m) => m.content).join('\n').replace(/​/g, '');
                seen.push(text);
                return typeof reply === 'function' ? reply(text) : reply;
            },
            stopGeneration() {},
        }),
    };
}

// ---------------- 空项目 ----------------

test('createEmptyProject：没有分段、original = true、source.fileName 为空；normalizeProject 保留标记；各处在没有分段时不出错', () => {
    const p = createEmptyProject({ name: '  我的原创  ' });
    assert.equal(p.name, '我的原创');
    assert.equal(p.bookName, '我的原创');
    assert.equal(p.original, true);
    assert.deepEqual(p.chunks, []);
    assert.equal(p.source.fileName, '');
    assert.equal(p.source.totalChars, 0);
    assert.equal(createEmptyProject().name, '原创项目');
    const n = normalizeProject(structuredClone(p));
    assert.equal(n.original, true);
    assert.deepEqual(n.chunks, []);
    // 没有分段时的公共函数
    assert.equal(projectHasSource(p), false);
    assert.equal(originalNovelAvailable(p), false);
    assert.equal(timepointLabel(p, Infinity), '全书结束时');
    assert.equal(defaultWorldName(p, settings(), null), '《我的原创》世界书');
    assert.deepEqual(buildWorldbookEntries(p, settings()), []);
    assert.equal(buildOutlineText(p), '');
    assert.equal(getVolumes(p).length, 1);
    assert.equal(getTailText(p), '');
    assert.equal(nextChapterNo(p), 1);
    assert.deepEqual({ ...projectStats(p) }, { chunks: 0, done: 0, error: 0, pending: 0, characters: 0, entries: 0, chars: 0, generated: 0 });
    // 有了角色就可以「按项目资料」写卡
    p.characters['林晚'] = { name: '林晚' };
    assert.equal(originalNovelAvailable(p), true);
    assert.equal(projectHasSource(p), false);
    assert.equal(projectHasSource(novelProject()), true);
});

test('流程清单：没有原文的项目不需要分段和提取，下一步是「角色卡」原创写卡；写了卡之后没有必做的步骤；小说项目照旧', () => {
    const p = createEmptyProject({ name: '原创' });
    const st = pipelineState(p);
    assert.deepEqual(st.steps.map((s) => s.tab), ['cards', 'characters', 'worldbook', 'relations', 'style']);
    assert.equal(st.next.tab, 'cards');
    assert.equal(st.steps[0].name, '原创写卡并写入酒馆');
    assert.ok(st.steps.slice(1).every((s) => s.optional));
    p.cards.push({ id: 'c' });
    assert.equal(pipelineState(p).next, null);
    const n = pipelineState(novelProject());
    assert.equal(n.steps[0].tab, 'chunks');
    assert.equal(n.next.tab, 'extract');
});

// ---------------- 提示词 ----------------

test('原创写卡提示词（单人卡）：用户的设定、设计要求（character + lore、可用分类）、成年人一条、写作规则、JSON 模板带 character / lore；系统提示独立', () => {
    const p = createEmptyProject({ name: '原创' });
    const s = settings();
    const { system, prompt, charName, fixed } = buildCardPrompt(p, s, {
        kind: 'character', source: 'original', timepoint: Infinity, greetings: 2,
        original: { name: '', concept: '雾港旧书店的店主，二十四岁', world: '常年起雾的港城', ref: '港片' },
    });
    assert.equal(charName, '');
    assert.equal(fixed, false);
    assert.equal(system, DEFAULT_PROMPTS.cardOriginalSystem);
    assert.ok(prompt.startsWith('# 任务\n按用户的原创设定写一张单人角色卡（名字由你来起）。'));
    assert.ok(prompt.includes('角色名：没有定，由你来起'));
    assert.ok(prompt.includes('<角色设定>\n雾港旧书店的店主，二十四岁\n</角色设定>'));
    assert.ok(prompt.includes('<世界观>\n常年起雾的港城\n</世界观>'));
    assert.ok(prompt.includes('参考氛围：港片（只借氛围和质感，不照搬其中的人物、名字和情节）'));
    assert.ok(prompt.includes('- 名字：用户没有定名字，起一个贴合设定、好记的名字，name 和 character.name 用同一个。'));
    assert.ok(prompt.includes('category 只能是：世界观、地点、势力、物品；'), '默认启用的分类（角色、事件、玩法规则除外）');
    assert.ok(prompt.includes('- 卡片的每个字段、character 和 lore 说的都是同一批人物、同一个世界'));
    assert.ok(prompt.includes('未成年的角色不写进恋爱或亲密内容') && prompt.includes(ADULT));
    assert.ok(prompt.includes(WRITING_RULES));
    assert.ok(prompt.includes('"tags": ["……"],\n  "character": {\n    "name": "名字",'));
    assert.ok(prompt.includes('"importance": "main"\n  },\n  "lore": [\n    {"category": "地点", "name": "名称", "keys": ["触发词"], "content": "数据库格式的条目内容"}\n  ]\n}\n只输出 JSON。'));
    assert.ok(prompt.includes('（未指定文风：按设定和用户要求把握语气、节奏和对话写法）'), '没有前文，不说「保持前文风格」');
    assert.ok(prompt.includes('（无特别要求，{{user}} 以符合设定的新身份出现）'));
    assert.ok(!prompt.includes('{') || !/\{[A-Z_]+\}/.test(prompt), '占位符都填好了');
    assert.ok(!prompt.includes('# 世界卡说明'));
    // 用户定了名字
    const named = buildCardPrompt(p, s, { kind: 'character', source: 'original', original: { name: '林晚', concept: 'x' } });
    assert.equal(named.charName, '林晚');
    assert.ok(named.prompt.includes('写一张单人角色卡（林晚）') && named.prompt.includes('角色名：林晚（用户定的，不要改）') && named.prompt.includes('用户定的名字是「林晚」'));
    // 关掉的分类不能用；启用的自定义分类可以用
    s.categories.find((c) => c.name === '物品').enabled = false;
    s.categories.find((c) => c.name === '事件').enabled = true;
    assert.deepEqual(originalLoreCategories(s), ['世界观', '地点', '势力', '事件']);
    assert.ok(buildCardPrompt(p, s, { kind: 'character', source: 'original', original: { concept: 'x' } }).prompt.includes('category 只能是：世界观、地点、势力、事件；'));
});

test('原创写卡提示词（世界卡）：卡名 / 世界观 / 主要角色；cast 的设计要求与 JSON 模板；接上世界卡说明', () => {
    const p = createEmptyProject({ name: '原创' });
    const { prompt, charName } = buildCardPrompt(p, settings(), {
        kind: 'world', source: 'original', cardName: '雾港旧事',
        original: { name: '雾港旧事', world: '常年起雾的港城', cast: '沈砚：探长\n阿绫：茶楼老板娘' },
    });
    assert.equal(charName, '雾港旧事');
    assert.ok(prompt.includes('写一张世界/旁白卡（雾港旧事）'));
    assert.ok(prompt.includes('卡片类型：世界/旁白卡（{{char}} 是叙述者，扮演所有 NPC）'));
    assert.ok(prompt.includes('卡名：雾港旧事（用户定的，不要改）'));
    assert.ok(prompt.includes('<主要角色>\n沈砚：探长\n阿绫：茶楼老板娘\n</主要角色>'));
    assert.ok(prompt.includes('在 cast 里给出 3-8 个主要角色的人物档案'));
    assert.ok(prompt.includes('{{char}} 是叙述者、{{user}} 是用户，两者都不放进 cast'));
    assert.ok(prompt.includes('"cast": [\n    {\n      "name": "名字",'));
    assert.ok(prompt.includes('"importance": "main|support"\n    }\n  ],'));
    assert.ok(prompt.trimEnd().endsWith(DEFAULT_PROMPTS.worldCardExtra));
    const noCast = buildCardPrompt(p, settings(), { kind: 'world', source: 'original', original: { world: '港城' } });
    assert.equal(noCast.charName, '');
    assert.ok(noCast.prompt.includes('主要角色：没有写，由你按世界观设计 3-8 个。') && noCast.prompt.includes('写一张世界/旁白卡（卡名由你来起）'));
    assert.ok(noCast.prompt.includes('在 cast 里给出 3-8 个主要角色'), '两处说的个数一致');
});

test('原创写卡提示词的附加段落：{{user}} 扮演项目里的角色、卡的导向（本卡落点）、用户画像（按设定为准、成年人）都在设计要求前面；自定义模板缺占位符时追加', () => {
    const p = novelProject();
    const s = settings();
    const prof = userProfileSnapshot(s, addUserProfile(s, { name: '足控党', likes: ['黑丝'], dislikes: ['NTR'], persona: '高个上班族', orientations: ['orient_ntl'] }));
    const opt = {
        kind: 'character', source: 'original', original: { concept: '旧书店店主' },
        userRole: { kind: 'character', charKey: '江酒' }, orientation: orientationFromPick(s, { id: 'orient_ntl' }), userProfile: prof,
    };
    const { prompt } = buildCardPrompt(p, s, opt);
    const i = (t) => prompt.indexOf(t);
    assert.ok(i('# {{user}} 的身份') > i('# 用户要求') && i('【卡的导向：NTL】') > i('# {{user}} 的身份') && i('# 为这位用户量身定制') > i('【卡的导向：NTL】') && i('# 设计要求') > i('# 为这位用户量身定制'));
    assert.ok(prompt.includes('{{user}} 扮演项目里的角色「江酒」。'));
    assert.ok(prompt.includes('{{char}} 是按用户设定原创的角色：按「江酒」的身份和经历，结合用户的设定安排 {{char}} 与 {{user}} 的关系和相遇的契机，「卡的导向」对两人关系的设定优先。'));
    assert.ok(!prompt.includes('原著中 {{char}} 与「江酒」'), '原创卡没有「原著中的关系」');
    assert.ok(prompt.includes(ORIENTATION_PROMPT_LINES.notesOriginal) && !prompt.includes(ORIENTATION_PROMPT_LINES.notes));
    assert.ok(prompt.includes('"creator_notes": "……",\n  "orientation_notes": "- ……\\n- ……",\n  "tags": ["……"],\n  "character": {'));
    assert.ok(prompt.includes('- 喜欢的元素：黑丝。挑和这个角色、这个设定相称的'));
    assert.ok(prompt.includes('- 偏好与用户的原创设定冲突时：设定里写明的以设定为准'));
    assert.ok(prompt.includes('- 所有涉及恋爱或亲密内容的人物（包括 {{user}}）都是成年人（18 岁以上）：设定里未成年的角色不写进恋爱或亲密内容，年龄没有交代的一律写成成年人；{{user}} 的形象或身份里写了未满 18 岁的年龄时，把 {{user}} 写成成年人，或者不让 {{user}} 进入恋爱和亲密内容。'));
    assert.ok(!prompt.includes('{{user}} 的默认形象'), '扮演项目里的角色时不写默认形象');
    assert.ok(!prompt.includes('原著里未成年'));
    // 世界卡 + 扮演项目里的角色
    const w = buildCardPrompt(p, s, { ...opt, kind: 'world', orientation: null }).prompt;
    assert.ok(w.includes('- 按「江酒」的身份和经历把 {{user}} 放进这个世界；主要角色与 {{user}} 的关系按用户的设定安排。'));
    assert.ok(w.includes('- 主要角色和 cast 里都不要单独列出「江酒」'));
    // 自定义模板：没有这些占位符时追加在末尾（新写卡一定要人物和条目）
    s.prompts.cardOriginal = '按设定写卡：{ORIGINAL}\n只输出 JSON。';
    const custom = buildCardPrompt(p, s, opt).prompt;
    assert.ok(custom.startsWith('按设定写卡：卡片类型：单人角色卡'));
    for (const t of ['# {{user}} 的身份', '【卡的导向：NTL】', '# 为这位用户量身定制', '# 设计要求\n- 先把人想清楚再写卡', '# 另外输出\n在同一个 JSON 对象里另外输出这些字段：\n{\n  "character": {']) assert.ok(custom.includes(t), t);
    // 提示词登记：设置页可以改
    assert.equal(PROMPT_LABELS.cardOriginal, '原创写卡 · 主提示');
    assert.equal(PROMPT_LABELS.cardOriginalSystem, '原创写卡 · 系统提示');
    for (const ph of ['{ORIGINAL}', '{DESIGN_GUIDE}', '{DESIGN_JSON}', '{USER_PROFILE}', '{ORIENTATION_JSON}']) assert.ok(PROMPT_PLACEHOLDERS.cardOriginal.includes(ph), ph);
    // {BOOK}（项目名）可以用，默认模板里不用
    for (const ph of PROMPT_PLACEHOLDERS.cardOriginal.filter((x) => x !== '{BOOK}')) assert.ok(DEFAULT_PROMPTS.cardOriginal.includes(ph), `默认模板里有 ${ph}`);
});

// ---------------- 解析与生成 ----------------

test('parseOriginalDesign：单人卡的 character、世界卡的 cast（数组 / 对象、中文字段名）；lore 就近归类，人物类条目丢掉', () => {
    const s = settings();
    const one = parseOriginalDesign(SINGLE_REPLY, { kind: 'character', settings: s });
    assert.equal(one.characters.length, 1);
    const c = one.characters[0];
    assert.deepEqual([c.name, c.aliases, c.identity, c.importance, c.experiences, c.verbalTics], ['林晚', ['阿晚'], '雾港旧书店的店主', 'main', ['十九岁继承了祖母的旧书店'], ['称呼客人为“先生”']]);
    assert.deepEqual(one.lore.map((e) => `${e.category}/${e.name}`), ['地点/雾港旧书店', '地点/三号码头', '世界观/港务署']);
    assert.deepEqual(one.lore.find((e) => e.name === '港务署').keywords, ['港务署', '港务']);
    const world = parseOriginalDesign(WORLD_REPLY, { kind: 'world', settings: s });
    assert.deepEqual(world.characters.map((x) => [x.name, x.identity, x.importance]), [['沈砚', '雾港警署的探长', 'main'], ['阿绫', '茶楼老板娘', 'main'], ['老周', '摆渡人', 'support']]);
    assert.equal(world.characters[0].personality, '嘴硬心软');
    assert.deepEqual(world.lore.map((e) => `${e.category}/${e.name}`), ['世界观/雾港', '地点/码头茶楼']);
    const asObj = parseOriginalDesign({ cast: { 沈砚: { identity: '探长' }, 阿绫: '老板娘' } }, { kind: 'world', settings: s });
    assert.deepEqual(asObj.characters.map((x) => [x.name, x.identity]), [['沈砚', '探长'], ['阿绫', '老板娘']]);
    assert.deepEqual(parseOriginalDesign({}, { kind: 'character' }), { characters: [], lore: [] });
    assert.deepEqual(parseOriginalDesign(null, { kind: 'world' }), { characters: [], lore: [] });
});

test('generateCard（原创）：卡上记 source / original（用户的设定 + 设计）；名字用用户定的 > AI 设计的；世界卡没定卡名时用 AI 起的；没有 character 时记一份简要的', async () => {
    const p = createEmptyProject({ name: '原创' });
    const s = settings();
    const seen = [];
    const logs = [];
    installTavern((t) => JSON.stringify(t.includes('世界/旁白卡') ? WORLD_REPLY : SINGLE_REPLY), seen);
    try {
        const c = await generateCard(p, s, { kind: 'character', source: 'original', original: { concept: '旧书店店主', world: '港城' }, timepoint: Infinity }, { onLog: (m, l) => logs.push([m, l]) });
        assert.equal(c.source, 'original');
        assert.equal(isOriginalCard(c), true);
        assert.equal(c.timepoint, null);
        assert.equal(c.charName, '林晚');
        assert.equal(c.data.name, '林晚', '用 AI 设计的名字，不用 AI 写的 name');
        assert.equal(c.data.mes_example, '<START>\n{{user}}: 还开着吗？\n{{char}}: 开着。', '示例对话里的名字换成 {{char}}');
        assert.equal(c.original.concept, '旧书店店主');
        assert.equal(c.original.saved, false);
        assert.equal(c.original.characters[0].name, '林晚');
        assert.equal(c.original.lore.length, 3);
        assert.ok(seen[0].includes('"character": {'));
        assert.ok(logs[0][0].includes('正在按原创设定写「原创角色」'));
        // 用户定了名字：以用户的为准（AI 设计里的名字也改过来）
        const named = await generateCard(p, s, { kind: 'character', source: 'original', original: { name: '苏晚', concept: 'x' } });
        assert.equal(named.data.name, '苏晚');
        assert.equal(named.charName, '苏晚');
        assert.equal(named.original.characters[0].name, '苏晚');
        // 世界卡：卡名没定时用 AI 起的；cast 记在 original.characters
        const w = await generateCard(p, s, { kind: 'world', source: 'original', original: { world: '港城' } });
        assert.equal(w.cardName, '雾港旧事');
        assert.equal(w.data.name, '雾港旧事');
        assert.equal(w.charName, '');
        assert.deepEqual(w.original.characters.map((x) => x.name), ['沈砚', '阿绫', '老周']);
        // AI 没给 character：记一份简要的，并提醒
        installTavern(JSON.stringify({ name: '无名', description: 'd', personality: '冷淡', first_mes: 'f', tags: [] }), seen);
        const bare = await generateCard(p, s, { kind: 'character', source: 'original', original: { concept: 'x' } }, { onLog: (m, l) => logs.push([m, l]) });
        assert.equal(bare.data.name, '无名');
        assert.deepEqual(bare.original.characters.map((x) => [x.name, x.personality]), [['无名', '冷淡']]);
        assert.ok(logs.some(([m, l]) => l === 'warn' && m.includes('没有返回人物档案')));
        assert.ok(logs.some(([m, l]) => l === 'warn' && m.includes('没有返回世界书条目')));
    } finally {
        delete globalThis.SillyTavern;
    }
});

// ---------------- 存进项目 ----------------

function originalCard(extra = {}) {
    return {
        id: 'oc1', kind: 'character', charName: '林晚', source: 'original', timepoint: null, stAvatar: '', worldName: '',
        original: normalizeCardOriginal({ concept: '旧书店店主', world: '港城', ...parseOriginalDesign(SINGLE_REPLY, { kind: 'character', settings: settings() }) }),
        data: { name: '林晚', description: 'd', personality: 'p', scenario: 's', first_mes: '“又下雨了。”', alternate_greetings: [], mes_example: '<START>', system_prompt: '', post_history_instructions: '', creator_notes: '', tags: [] },
        ...extra,
    };
}

test('存进项目：角色存成手动角色（manual + locked，任何时间点都在），条目存成手动条目（没有出处段落）；重新提取不会删；改名时卡上的记录跟着改', () => {
    const p = createEmptyProject({ name: '原创' });
    const c = originalCard();
    assert.deepEqual(originalSavePlan(p, c.original).collisions, []);
    const res = saveOriginalDesign(p, c);
    assert.deepEqual(res.characters, [{ name: '林晚', savedAs: '林晚', overwritten: false, via: '', owner: '' }]);
    const ch = p.characters['林晚'];
    assert.equal(ch.manual, true);
    assert.equal(ch.locked, true);
    assert.deepEqual(ch.chunksSeen, [0]);
    assert.equal(ch.identity, '雾港旧书店的店主');
    assert.deepEqual(ch.aliases, ['阿晚']);
    assert.deepEqual(ch.experiences, [{ chunk: -1, text: '十九岁继承了祖母的旧书店' }], '设计出来的经历不属于任何分段');
    assert.equal(ch.originalShadow, undefined, '没撞名时没有影子别名');
    const e = p.worldbook['地点']['雾港旧书店'];
    assert.deepEqual([e.locked, e.manual, e.sourceChunks, e.keywords, e.content], [true, true, [], ['雾港旧书店', '旧书店'], '位置: 雾港老城区']);
    assert.ok(p.worldbook['世界观']['港务署']);
    assert.equal(c.original.saved, true);
    assert.equal(originalSaveLog(res), '角色 「林晚」，3 条世界书条目（地点 2、世界观 1）');
    // 项目的世界书里有它们（角色本人按「不重复写入该角色本人」去掉）
    const entries = buildWorldbookEntries(p, settings());
    assert.deepEqual(entries.filter((x) => x.category !== '剧情').map((x) => x.name).sort(), ['三号码头', '林晚', '港务署', '雾港旧书店'].sort());
    assert.deepEqual(cardEntries(p, settings(), c).map((x) => x.name).sort(), ['三号码头', '港务署', '雾港旧书店'].sort());
    // 在有原文的项目里重新提取某一段：手动角色和条目都留着
    const n = novelProject();
    const c2 = originalCard();
    saveOriginalDesign(n, c2);
    removeChunkContributions(n, 0);
    assert.ok(n.characters['林晚'] && n.worldbook['地点']['雾港旧书店'], '重新提取不删原创存进来的资料');
    // 设计出来的经历也留着（重新提取第 1 段、删掉 / 合并第 1 段都不碰它们）；任何时间点都看得到
    assert.deepEqual(n.characters['林晚'].experiences, [{ chunk: -1, text: '十九岁继承了祖母的旧书店' }]);
    resetChunksForReextract(n, [0, 1]);
    assert.equal(n.characters['林晚'].experiences.length, 1, '全部重新提取');
    mergeChunkWithNext(n, 0);
    assert.equal(n.characters['林晚'].experiences.length, 1, '合并分段');
    deleteChunkAt(n, 0);
    assert.deepEqual(n.characters['林晚'].experiences, [{ chunk: -1, text: '十九岁继承了祖母的旧书店' }], '删掉分段');
    assert.equal(characterAt(n.characters['林晚'], 0).experiences.length, 1);
    const view = originalDesignView(n, c2.original);
    assert.equal(view.characters[0].experiences.length, 1, '整卡重新生成、状态栏等用的设定里经历还在');
    // 改名：卡上记的 savedAs 跟着改
    n.cards.push(c2);
    renameCharacter(n, '林晚', '林晚晚');
    assert.equal(c2.charName, '林晚晚');
    assert.equal(c2.original.characters[0].savedAs, '林晚晚');
});

test('存进项目时同名：默认加后缀另存（不并进已有的角色，卡里的名字留作别名）；选覆盖时替换；后缀依次往后排', () => {
    const p = novelProject();
    mergeCharacter(p, { name: '林晚', identity: '原著里的林晚', importance: 'support' }, 1);
    mergeEntry(p, '地点', { name: '雾港旧书店', keywords: [], content: '原著里的书店' }, 1);
    const c = originalCard();
    const plan = originalSavePlan(p, c.original);
    assert.deepEqual(plan.collisions, [
        { type: 'character', name: '林晚', via: 'name', owner: '林晚' },
        { type: 'entry', category: '地点', name: '雾港旧书店', via: 'name', owner: '雾港旧书店', ownerCategory: '地点' },
    ]);
    const res = saveOriginalDesign(p, c, { collision: 'suffix' });
    assert.equal(p.characters['林晚'].identity, '原著里的林晚', '原来的角色不动');
    const saved = p.characters['林晚（原创）'];
    assert.equal(saved.identity, '雾港旧书店的店主');
    assert.deepEqual(saved.aliases, ['林晚', '阿晚'], '卡里的名字留作别名，世界书照样能触发');
    assert.equal(saved.originalShadow, '林晚', '这个别名只属于这张卡');
    assert.equal(p.worldbook['地点']['雾港旧书店（原创）'].originalShadow, '雾港旧书店');
    assert.equal(c.charName, '林晚（原创）', '单人卡关联项目里的新角色');
    assert.equal(c.data.name, '林晚', '卡名不变');
    assert.equal(p.worldbook['地点']['雾港旧书店'].content, '原著里的书店');
    assert.equal(p.worldbook['地点']['雾港旧书店（原创）'].content, '位置: 雾港老城区');
    assert.ok(originalSaveLog(res).includes('「林晚」（同名，另存为「林晚（原创）」）'));
    assert.equal(suffixedName('林晚', (n) => !!p.characters[n]), '林晚（原创2）');
    // 覆盖
    const c2 = originalCard();
    const res2 = saveOriginalDesign(p, c2, { collision: 'overwrite' });
    assert.equal(p.characters['林晚'].identity, '雾港旧书店的店主');
    assert.equal(p.characters['林晚'].manual, true);
    assert.equal(c2.charName, '林晚');
    assert.deepEqual(res2.characters, [{ name: '林晚', savedAs: '林晚', overwritten: true, via: 'name', owner: '林晚' }]);
    assert.equal(p.characters['林晚'].originalShadow, undefined, '覆盖的不是影子');
    assert.ok(originalSaveLog(res2).includes('覆盖了同名角色'));
    // 别名已经是别的角色的名字时不收
    const c3 = originalCard();
    c3.original.characters[0].aliases = ['江酒', '晚晚'];
    saveOriginalDesign(p, c3);
    assert.deepEqual(p.characters['林晚（原创2）'].aliases, ['林晚', '晚晚']);
});

test('单人卡在还没有角色的项目里一定要存；写卡表单的说明文字与选项', () => {
    const p = createEmptyProject();
    assert.equal(originalSaveForced(p, 'character'), true);
    assert.equal(originalSaveForced(p, 'world'), false);
    p.characters['甲'] = { name: '甲' };
    assert.equal(originalSaveForced(p, 'character'), false);
    assert.equal(originalInputProblem({ concept: ' ' }, 'character'), '请填写角色设定：身份、外貌、性格、经历、和 {{user}} 的关系……');
    assert.equal(originalInputProblem({ concept: '店主' }, 'character'), '');
    assert.equal(originalInputProblem({ concept: '店主' }, 'world'), '请填写世界观：时代、地点、世界规则、主要势力……');
    assert.equal(originalInputProblem({ world: '港城' }, 'world'), '');
    assert.ok(cardSourceNote(true, false).startsWith('这个项目没有原文和角色资料'));
    assert.ok(cardSourceNote(true, true).startsWith('不用原文'));
    assert.ok(cardSourceNote(false, true, true).startsWith('按提取出的原著资料'));
    assert.ok(cardSourceNote(false, true, false).startsWith('按项目里已有的角色资料'));
    assert.ok(originalSaveNote(true).includes('一定会存进项目'));
    assert.ok(originalSaveNote(false, false).includes('写入酒馆时作为卡自己世界书里的条目'));
    assert.deepEqual(userRoleKindOptions(true, false).map((k) => k.value), ['new', 'custom'], '没有角色时不给「项目里的角色」');
    assert.equal(userRoleKindOptions(true, true).find((k) => k.value === 'character').label, '项目里的角色');
    assert.equal(userRoleKindOptions(false, false).find((k) => k.value === 'character').label, '原著角色');
    assert.ok(userRoleFormNote('new', '', 'character', true).includes('新身份'));
    assert.ok(userRoleFormNote('character', '江酒', 'character', true).includes('按 TA 的身份和经历'));
    const c = originalCard();
    assert.ok(originalSaveStateText(c).startsWith('没有存进项目：角色「林晚」和 3 条世界书条目'));
    saveOriginalDesign(createEmptyProject(), c);
    assert.ok(originalSaveStateText(c).includes('已存进项目'));
    assert.ok(originalInputSummary(c).startsWith('角色名：（没填，AI 起的名字）\n\n角色设定：\n旧书店店主'));
});

// ---------------- 重新生成 / 重roll 用原创设定 ----------------

test('整卡重新生成、单字段重roll、剧情推演背景按卡上的原创设定：已定下的人物（存进项目后以项目里的为准）和世界设定，不再要 AI 设计；卡的名字和关联不变', async () => {
    const p = createEmptyProject({ name: '原创' });
    const s = settings();
    const c = originalCard();
    saveOriginalDesign(p, c);
    p.cards.push(c);
    // 用户在「角色」页改了这个角色
    p.characters['林晚'].personality = '改过的性格：说话很快';
    const opt = cardPromptOpt(c);
    assert.equal(opt.source, 'original');
    assert.equal(opt.original, c.original);
    assert.equal(cardPromptOpt({ kind: 'character', charName: 'x', data: {} }).source, undefined, '普通卡不带 source');
    const { prompt, fixed, charName } = buildCardPrompt(p, s, opt);
    assert.equal(fixed, true);
    assert.equal(charName, '林晚');
    assert.ok(prompt.includes('## 已定下的人物（{{char}} 本人，以此为准）\n姓名: 林晚'));
    assert.ok(prompt.includes('性格: 改过的性格：说话很快'), '存进项目后以项目里的为准');
    assert.ok(prompt.includes('## 已定下的世界设定\n[地点] 雾港旧书店\n位置: 雾港老城区'));
    assert.ok(prompt.includes('人物和世界设定已经定下'));
    assert.ok(!prompt.includes('"character": {') && !prompt.includes('"lore": ['), '不再要 AI 设计');
    assert.ok(prompt.includes('"tags": ["……"]\n}'));
    const seen = [];
    installTavern((t) => (t.includes('重新生成「开场白」') ? '“新的开场。”' : JSON.stringify({ ...SINGLE_REPLY, name: '别的名字', character: { name: '别人' } })), seen);
    try {
        await regenerateCardField(p, s, c, 'first_mes');
        assert.equal(c.data.first_mes, '“新的开场。”');
        assert.ok(seen.at(-1).includes('已定下的人物') && seen.at(-1).includes('雾港旧书店'), '重roll 的背景资料是原创设定');
        const r = await generateCard(p, s, { ...cardPromptOpt(c) });
        assert.equal(r.data.name, '林晚');
        assert.equal(r.charName, '林晚');
        assert.equal(r.source, 'original');
        assert.deepEqual(r.original, c.original, '整卡重新生成不改设计');
        // 没存进项目的卡：用卡上记的设计
        const u = originalCard();
        const up = buildCardPrompt(createEmptyProject(), s, cardPromptOpt(u)).prompt;
        assert.ok(up.includes('性格: 说话慢') && up.includes('已定下的人物'));
    } finally {
        delete globalThis.SillyTavern;
    }
});

test('重新生成本书落点：原创卡的背景是用户的设定和设计（不拿项目里的原著大纲）；{{user}} 的身份按原创写', () => {
    const p = novelProject();
    p.outline.summary = '原著梗概';
    const s = settings();
    const c = originalCard({ orientation: orientationFromPick(s, { id: 'orient_ntl' }), userRole: { kind: 'character', charKey: '江酒' } });
    const { system, prompt } = buildOrientationNotesPrompt(p, s, c);
    assert.ok(prompt.includes('## 用户的原创设定') && prompt.includes('## 角色资料\n姓名: 林晚'));
    assert.ok(!prompt.includes('## 剧情进展'));
    assert.ok(prompt.includes('{{user}} 扮演项目里的角色「江酒」'));
    // 原创卡的落点模板：不说“原著”“本书”，成年人一条写在模板里
    assert.equal(system, DEFAULT_PROMPTS.orientationNotesOriginalSystem);
    assert.ok(system.includes('熟悉这张原创卡设定的角色卡作者') && !system.includes('《'));
    assert.ok(prompt.includes('# 卡片设定（原创）') && prompt.includes('结合这张卡的人物与设定') && prompt.includes('其他角色写设定里的名字'));
    assert.ok(!prompt.includes('原著资料') && !prompt.includes('原著里的名字') && !prompt.includes('结合本书'), prompt);
    assert.ok(prompt.includes(ADULT));
    assert.ok(!prompt.includes('雷点'), '没有画像时没有雷点一行');
    // 带画像：雷点（与导向同名的不算）；成年人一条只出现一次
    const prof = userProfileSnapshot(s, addUserProfile(s, { name: '怕虐党', dislikes: ['死亡', '血腥', 'NTL'] }));
    const withP = buildOrientationNotesPrompt(p, s, { ...c, userProfile: prof }).prompt;
    assert.ok(withP.includes('- 雷点（一律避免）：死亡、血腥。落点里不出现这些内容，连暗示和可能的发展方向都不要留。'), withP);
    assert.equal(withP.split(ADULT).length, 2);
    assert.ok(PROMPT_LABELS.orientationNotesOriginal && PROMPT_PLACEHOLDERS.orientationNotesOriginal.includes('{USER_PROFILE_LINE}'));
    // 用户改过的模板没有 {USER_PROFILE_LINE}：雷点追加在末尾
    s.prompts.orientationNotesOriginal = '落点：{CONTEXT}';
    assert.ok(buildOrientationNotesPrompt(p, s, { ...c, userProfile: prof }).prompt.endsWith('连暗示和可能的发展方向都不要留。'));
});

// ---------------- 写入酒馆 ----------------

test('没存进项目的原创卡：人物（世界卡的主要角色；单人卡的本人按设置不重复）和条目作为卡自己世界书里的条目（分类的激活方式、位置、顺序）；存进项目后改由项目世界书提供', () => {
    const s = settings();
    const p = novelProject();
    const c = originalCard();
    assert.equal(originalHasOwnEntries(c), true);
    assert.equal(cardOwnWorld(c), true);
    const own = originalOwnEntries(s, c);
    assert.deepEqual(own.map((e) => `${e.category}/${e.name}`), ['地点/雾港旧书店', '地点/三号码头', '世界观/港务署']);
    const place = own[0];
    assert.deepEqual([place.constant, place.position, place.depth, place.order, place.keywords], [false, 0, 4, 200, ['雾港旧书店', '旧书店']]);
    assert.equal(own[1].order, 201);
    assert.equal(own[2].constant, true, '世界观分类是常驻');
    // 写入：卡自己的世界书 = 项目资料 + 原创条目；内嵌的 character_book 也有
    const r = prepareCard(p, s, c);
    assert.equal(r.ownWorld, true);
    assert.equal(r.worldName, '《魔女》世界书·林晚');
    const names = r.entries.map((e) => e.name);
    for (const n of ['雾港旧书店', '三号码头', '港务署', '酒吧']) assert.ok(names.includes(n), n);
    assert.ok(r.json.data.character_book.entries.some((e) => e.comment === '地点 - 雾港旧书店'));
    assert.deepEqual(cardExtraEntries(p, s, c).map((e) => e.name), ['雾港旧书店', '三号码头', '港务署']);
    // 关掉的分类不写
    s.categories.find((x) => x.name === '世界观').enabled = false;
    assert.ok(!originalOwnEntries(s, c).some((e) => e.name === '港务署'));
    s.categories.find((x) => x.name === '世界观').enabled = true;
    // 单人卡关掉「不重复写入该角色本人」时本人也写
    s.worldbook.excludeCardCharacter = false;
    assert.equal(originalOwnEntries(s, c)[0].name, '林晚');
    s.worldbook.excludeCardCharacter = true;
    // 世界卡：主要角色都写
    const w = { ...originalCard(), id: 'w1', kind: 'world', charName: '', cardName: '雾港旧事', original: normalizeCardOriginal({ world: '港城', ...parseOriginalDesign(WORLD_REPLY, { kind: 'world', settings: s }) }) };
    assert.deepEqual(originalOwnEntries(s, w).map((e) => `${e.category}/${e.name}`), ['角色/沈砚', '角色/阿绫', '角色/老周', '世界观/雾港', '地点/码头茶楼']);
    assert.ok(originalOwnEntries(s, w)[0].content.includes('身份: 雾港警署的探长'));
    // 存进项目后：没有卡上的条目，资料走项目的世界书；但仍写进这张卡自己的一本（每张原创卡带的资料不同，不能共用《原创》世界书）
    const e = createEmptyProject({ name: '原创' });
    const c2 = originalCard();
    saveOriginalDesign(e, c2);
    assert.equal(originalHasOwnEntries(c2), false);
    assert.equal(cardOwnWorld(c2), true);
    assert.deepEqual(originalOwnEntries(s, c2), []);
    const r2 = prepareCard(e, s, c2);
    assert.equal(r2.ownWorld, true);
    assert.equal(r2.worldName, '《原创》世界书·林晚');
    assert.equal(r2.json.data.extensions.world, '《原创》世界书·林晚');
    assert.deepEqual(r2.entries.map((x) => x.name).sort(), ['三号码头', '港务署', '雾港旧书店'].sort());
    // 卡上的条目与项目里同分类同名的（原著提取的「酒吧」）：只留卡上的
    const bar = originalCard();
    bar.original.lore.push({ category: '地点', name: '酒吧', keywords: [], content: '原创的酒吧', savedAs: '' });
    const bars = prepareCard(p, s, bar).entries.filter((x) => x.category === '地点' && x.name === '酒吧');
    assert.deepEqual(bars.map((x) => x.content), ['原创的酒吧']);
    // 普通卡不受影响
    assert.equal(originalHasOwnEntries({ kind: 'character', original: c.original }), false);
});

test('同一个项目里的几张原创卡互不串味：写入时不带别的原创卡存进来的角色和条目；提取的、手动加的、卡已删掉的照常带；普通卡全部带', () => {
    const s = settings();
    const p = createEmptyProject({ name: '原创' });
    const a = originalCard({ id: 'A' });
    saveOriginalDesign(p, a);
    const b = {
        ...originalCard({ id: 'B', kind: 'world', charName: '', cardName: '雾港旧事' }),
        original: normalizeCardOriginal({ world: '港城', ...parseOriginalDesign(WORLD_REPLY, { kind: 'world', settings: s }) }),
    };
    saveOriginalDesign(p, b);
    assert.equal(p.characters['林晚'].originalCardId, 'A');
    assert.equal(p.worldbook['世界观']['雾港'].originalCardId, 'B');
    p.cards.push(a, b);
    mergeEntry(p, '地点', { name: '手动加的码头', keywords: [], content: '谁都能用' }, -1);
    const names = (card) => cardEntries(p, s, card).map((e) => e.name).sort();
    assert.deepEqual(names(a), ['三号码头', '手动加的码头', '港务署', '雾港旧书店'].sort(), 'A 不带 B 的主要角色和条目');
    assert.deepEqual(names(b), ['沈砚', '阿绫', '老周', '雾港', '码头茶楼', '手动加的码头'].sort(), 'B 不带 A 的角色和条目');
    // 普通卡（按项目资料写的）全部带上
    const plain = { id: 'C', kind: 'world', charName: '', timepoint: null };
    assert.equal(cardEntries(p, s, plain).length, 10, '4 个角色 + 5 条设计的条目 + 1 条手动的');
    // B 删掉之后，它存进来的资料谁都能用
    p.cards.splice(1, 1);
    assert.ok(names(a).includes('沈砚') && names(a).includes('雾港'));
    // 规整项目时保留记号
    assert.equal(normalizeProject(structuredClone(p)).characters['林晚'].originalCardId, 'A');
});

test('publishCard（原创世界卡 + 卡的导向 + 用户画像 + 状态栏）：卡自己的世界书里有主要角色、条目、剧情导向、用户偏好和状态栏条目', async () => {
    const s = settings();
    s.cards.linkWorldbook = false;
    s.cards.embedWorldbook = false;
    const p = createEmptyProject({ name: '原创' });
    const prof = userProfileSnapshot(s, addUserProfile(s, { name: '足控党', likes: ['黑丝'] }));
    const w = {
        id: 'w1', kind: 'world', charName: '', cardName: '雾港旧事', source: 'original', timepoint: null, stAvatar: '', worldName: '',
        orientation: orientationFromPick(s, { id: 'orient_ntl' }), userProfile: prof,
        original: normalizeCardOriginal({ world: '港城', ...parseOriginalDesign(WORLD_REPLY, { kind: 'world', settings: s }) }),
        data: { name: '雾港旧事', description: 'd', personality: '', scenario: '', first_mes: 'f', alternate_greetings: [], mes_example: '', system_prompt: '', post_history_instructions: '', creator_notes: '', tags: [] },
    };
    const sb = ensureStatusBar(w, s);
    sb.enabled = true;
    sb.spec = { variables: [{ path: '世界.时间', type: 'string', init: '夜', check: ['推进'] }] };
    sb.html = '';
    const saved = { worlds: {} };
    const ctx = {
        name1: 'User', characters: [], getRequestHeaders: () => ({}), async saveWorldInfo(n, d) { saved.worlds[n] = structuredClone(d); }, async updateWorldInfoList() {},
        async getCharacters() {}, extensionSettings: {}, saveSettingsDebounced() {},
    };
    globalThis.SillyTavern = { getContext: () => ctx };
    const origFetch = globalThis.fetch;
    globalThis.fetch = async (url) => (url === '/api/characters/import' ? new Response(JSON.stringify({ file_name: 'w' }), { status: 200 }) : new Response('{}', { status: 404 }));
    try {
        const r = await publishCard(p, s, w);
        assert.equal(r.statusBar, true);
        const comments = Object.values(saved.worlds[r.worldName].entries).map((e) => e.comment);
        for (const t of ['角色 - 沈砚', '角色 - 阿绫', '世界观 - 雾港', '地点 - 码头茶楼', '剧情导向：NTL', '用户偏好']) assert.ok(comments.includes(t), t);
        assert.ok(comments.some((t) => t.includes('[initvar]')), '状态栏条目');
    } finally {
        globalThis.fetch = origFetch;
        delete globalThis.SillyTavern;
    }
});

test('{{user}} 的身份条目（原创卡）：只交代身份和经历，没有「原著中的关系」', () => {
    const p = novelProject();
    const c = originalCard({ userRole: { kind: 'character', charKey: '江酒' } });
    const e = userRoleEntry(p, c);
    assert.ok(e.content.startsWith('{{user}} 扮演「江酒」：「江酒」的经历、身份和人际关系都属于 {{user}}。'));
    assert.ok(!e.content.includes('{{char}} 与「江酒」之间的关系'));
    // 编辑框里的一句话说明、状态栏提示词里的主角身份：原创卡不说“原著角色”
    assert.equal(userRoleLabel(p, c.userRole, { original: true }), '项目里的角色「江酒」');
    assert.equal(userRoleLabel(p, c.userRole), '原著角色「江酒」');
    const sb = userRoleStatusText(p, c);
    assert.ok(sb.includes('扮演项目里的角色「江酒」') && sb.includes('在卡片开场时的状态') && !sb.includes('原著'), sb);
    assert.ok(userRoleStatusText(p, { ...c, source: undefined }).includes('扮演原著角色「江酒」'));
});

test('写卡表单的「文风」一行：原创项目的项目文风空着时显示「未设置（按设定把握）」，填过时「项目文风」；小说项目照旧「本书原著文风」；选了预设或不指定照旧', () => {
    const s = settings();
    const empty = createEmptyProject();
    assert.equal(cardStyleName(empty, s), '未设置（按设定把握）');
    empty.style = { ...empty.style, tone: '冷峻克制' };
    assert.equal(cardStyleName(empty, s), '项目文风');
    assert.equal(cardStyleName(novelProject(), s), '本书原著文风');
    const preset = listStylePresets(s)[0];
    empty.styleUse = { ...empty.styleUse, card: preset.id };
    assert.equal(cardStyleName(empty, s), preset.name);
    empty.styleUse.card = NO_STYLE_ID;
    assert.equal(cardStyleName(empty, s), '不指定');
});

// ---------------- 状态栏 ----------------

test('状态栏（原创卡）：世界卡的主要角色是设计的那几个（不是项目里全部角色）；背景资料是原创设定；时间点是开场时；带画像时有「用户偏好」', () => {
    const s = settings();
    const p = novelProject();
    const w = {
        id: 'w1', kind: 'world', charName: '', cardName: '雾港旧事', source: 'original', timepoint: null,
        original: normalizeCardOriginal({ world: '常年起雾的港城', ...parseOriginalDesign(WORLD_REPLY, { kind: 'world', settings: s }) }),
        userProfile: userProfileSnapshot(s, addUserProfile(s, { name: '足控党', likes: ['丝袜'] })),
        data: { name: '雾港旧事', description: 'd', first_mes: 'f', alternate_greetings: [], tags: [] },
    };
    assert.deepEqual(originalCastNames(w), ['沈砚', '阿绫', '老周']);
    assert.deepEqual(worldCastNames(p, w), ['沈砚', '阿绫', '老周']);
    assert.deepEqual(worldCastNames(p, { ...w, userRole: { kind: 'character', charKey: '阿绫' } }), ['沈砚', '老周']);
    assert.equal(originalCastNames({ ...w, kind: 'character' }), null);
    ensureStatusBar(w, s);
    const { prompt } = buildStatusSpecPrompt(p, s, w);
    assert.ok(prompt.includes('故事时间点：卡片开场时'));
    assert.ok(prompt.includes('## 用户的原创设定') && prompt.includes('常年起雾的港城'));
    assert.ok(prompt.includes('沈砚、阿绫、老周'), '主要角色名单');
    assert.ok(!prompt.includes('莉莉丝') && !prompt.includes('酒吧'), '不拿项目里其他的原著资料');
    assert.ok(prompt.includes('# 用户偏好') && prompt.includes(ADULT));
    // 单人原创卡：背景里有角色资料
    const c = originalCard();
    ensureStatusBar(c, s);
    assert.ok(buildStatusSpecPrompt(p, s, c).prompt.includes('## 角色资料\n姓名: 林晚'));
});

test('内置提示词与原创写卡的提示词都写明成年人（包括 {{user}}），而且成年人一条优先于「照办」', () => {
    for (const k of ['cardOriginal', 'cardOriginalSystem', 'orientationNotesOriginal']) assert.ok(DEFAULT_PROMPTS[k].includes(ADULT), k);
    assert.ok(DEFAULT_PROMPTS.cardOriginal.includes('设定里没有交代年龄的角色一律写成成年人'));
    // 系统提示要 AI「照办」用户的每一处设定：写明唯一的例外是成年人规则，并且它优先
    const sys = DEFAULT_PROMPTS.cardOriginalSystem;
    assert.ok(sys.includes('唯一的例外是成年人规则') && sys.includes('这一条优先于用户的任何设定和偏好'));
    assert.ok(sys.indexOf('唯一的例外是成年人规则') > sys.indexOf('不改名、不改设定、不弱化'));
    assert.ok(DEFAULT_PROMPTS.cardOriginal.includes('一律照办（成年人一条除外，见下）') && DEFAULT_PROMPTS.cardOriginal.includes('这一条优先于上面的“照办”和用户的任何设定、偏好。'));
    const { system } = buildCardPrompt(createEmptyProject(), settings(), { kind: 'character', source: 'original', original: { concept: '十六岁的高中生，暗恋 {{user}}' } });
    assert.ok(system.includes(ADULT));
});

// ---------------- 修正：每张原创卡自己的世界书、撞名、重新设计、名字已定下、没有原文时的说法 ----------------

test('每张原创卡写入自己的一本世界书（存没存进项目都一样）：同一项目里的两张原创卡、原创卡和小说卡不再共用《书名》世界书，后写入的不会覆盖前一张', async () => {
    const s = settings();
    const p = createEmptyProject({ name: '我的原创' });
    const a = originalCard({ id: 'A' });
    saveOriginalDesign(p, a);
    const b = originalCard({ id: 'B', charName: '沈砚' });
    b.original = normalizeCardOriginal({
        concept: '探长', characters: [{ name: '沈砚', identity: '雾港警署的探长' }],
        lore: [{ category: '地点', name: '白塔', keywords: ['白塔'], content: '港口的灯塔' }],
    });
    b.data = { ...b.data, name: '沈砚' };
    saveOriginalDesign(p, b);
    p.cards.push(a, b);
    assert.equal(cardOwnWorld(a), true);
    const ra = prepareCard(p, s, a);
    const rb = prepareCard(p, s, b);
    assert.equal(ra.worldName, '《我的原创》世界书·林晚');
    assert.equal(rb.worldName, '《我的原创》世界书·沈砚');
    assert.notEqual(ra.worldName, rb.worldName);
    assert.ok(ra.entries.some((e) => e.name === '雾港旧书店') && !ra.entries.some((e) => e.name === '白塔'));
    assert.ok(rb.entries.some((e) => e.name === '白塔') && !rb.entries.some((e) => e.name === '雾港旧书店'));
    // 写入酒馆：各写各的，B 不会把 A 的世界书换成自己的设定
    const saved = {};
    const ctx = {
        name1: 'User', characters: [], getRequestHeaders: () => ({}), async saveWorldInfo(n, d) { saved[n] = structuredClone(d); }, async updateWorldInfoList() {},
        async getCharacters() {}, extensionSettings: {}, saveSettingsDebounced() {},
    };
    globalThis.SillyTavern = { getContext: () => ctx };
    const origFetch = globalThis.fetch;
    globalThis.fetch = async (url) => (url === '/api/characters/import' ? new Response(JSON.stringify({ file_name: 'x' }), { status: 200 }) : new Response('{}', { status: 404 }));
    try {
        await publishCard(p, s, a);
        await publishCard(p, s, b);
        const names = (w) => Object.values(saved[w].entries).map((e) => e.comment);
        assert.ok(names('《我的原创》世界书·林晚').includes('地点 - 雾港旧书店') && !names('《我的原创》世界书·林晚').includes('地点 - 白塔'));
        assert.ok(names('《我的原创》世界书·沈砚').includes('地点 - 白塔'));
        assert.equal(saved['《我的原创》世界书'], undefined, '共用的那本没有写');
        assert.equal(a.ownWorldName, '《我的原创》世界书·林晚');
        assert.equal(a.worldName, '');
    } finally {
        globalThis.fetch = origFetch;
        delete globalThis.SillyTavern;
    }
    // 小说项目：小说卡仍用共用的那本，原创卡用自己的
    const n = novelProject();
    const oc = originalCard({ id: 'O' });
    saveOriginalDesign(n, oc);
    n.cards.push(oc);
    const novelCard = { id: 'N', kind: 'character', charName: '莉莉丝', timepoint: null, data: { name: '莉莉丝', description: '', first_mes: '', alternate_greetings: [], tags: [] } };
    assert.equal(prepareCard(n, s, novelCard).worldName, '《魔女》世界书');
    assert.equal(prepareCard(n, s, oc).worldName, '《魔女》世界书·林晚');
    // 编辑框里「绑定世界书名称」显示的也是这张卡自己的那本
    assert.deepEqual(cardWorldField(n, s, oc), { sb: true, own: true, shown: '《魔女》世界书·林晚' });
});

test('撞名另存：名字是别的角色的具体别名 / 别的条目的关键词也算撞上；另存的副本只给这张卡用——这张卡不带原来那份，别的卡不带副本，提取认人不受影响', () => {
    const s = settings();
    const p = novelProject();
    // 原著里的「林晚晚」有个别名「林晚」；原著条目「雾港」的关键词里有「雾港旧书店」
    mergeCharacter(p, { name: '林晚晚', aliases: ['林晚'], identity: '原著里的女侠', importance: 'main' }, 1);
    mergeEntry(p, '地点', { name: '雾港', keywords: ['雾港', '雾港旧书店'], content: '海盗窝' }, 1);
    assert.equal(findCharacterKey(p, '晚姐', ['林晚']), '林晚晚', '存之前：凭别名「林晚」认得出林晚晚');
    const c = originalCard();
    const plan = originalSavePlan(p, c.original);
    assert.deepEqual(plan.collisions, [
        { type: 'character', name: '林晚', via: 'alias', owner: '林晚晚' },
        { type: 'entry', category: '地点', name: '雾港旧书店', via: 'keyword', owner: '雾港', ownerCategory: '地点' },
    ]);
    // 只是别名 / 关键词相同：选了覆盖也照样另存（没有同名的可以覆盖）
    const res = saveOriginalDesign(p, c, { collision: 'overwrite' });
    assert.deepEqual(res.characters, [{ name: '林晚', savedAs: '林晚（原创）', overwritten: false, via: 'alias', owner: '林晚晚' }]);
    assert.equal(p.characters['林晚（原创）'].originalShadow, '林晚');
    assert.equal(p.worldbook['地点']['雾港旧书店（原创）'].originalShadow, '雾港旧书店');
    assert.equal(p.characters['林晚晚'].identity, '原著里的女侠');
    assert.ok(originalSaveLog(res).includes('「林晚」（是「林晚晚」的别名，另存为「林晚（原创）」）'));
    // 提取认人 / 认条目：影子别名和影子关键词不算，原来的照样认得出
    assert.equal(findCharacterKey(p, '晚姐', ['林晚']), '林晚晚', '存之后：仍然认得出，不会变成有歧义');
    assert.equal(findCharacterKey(p, '林晚'), '林晚晚');
    assert.equal(findEntryKey(p, '地点', '雾港旧书店'), '雾港');
    // 这张原创卡：不带原著里的「林晚晚」和「雾港」（会被卡里的名字一起触发、和卡的设定打架）
    p.cards.push(c);
    const mine = cardEntries(p, s, c).map((e) => e.name);
    assert.ok(!mine.includes('林晚晚') && !mine.includes('雾港'), mine.join('、'));
    assert.ok(mine.includes('雾港旧书店（原创）') && mine.includes('酒吧'));
    // 别的卡（小说卡）：不带这张卡的影子副本，原著的照常
    const novelCard = { id: 'N', kind: 'world', charName: '', timepoint: null };
    const theirs = cardEntries(p, s, novelCard).map((e) => e.name);
    assert.ok(!theirs.includes('林晚（原创）') && !theirs.includes('雾港旧书店（原创）'), theirs.join('、'));
    assert.ok(theirs.includes('林晚晚') && theirs.includes('雾港') && theirs.includes('港务署'), '没撞名的原创资料照常带');
    // 原著里同名的角色（不是别名）：同样不带进这张原创卡
    const q = novelProject();
    mergeCharacter(q, { name: '林晚', identity: '原著里的林晚', importance: 'support' }, 1);
    const c2 = originalCard({ id: 'C2' });
    saveOriginalDesign(q, c2);
    q.cards.push(c2);
    assert.equal(c2.charName, '林晚（原创）');
    const names2 = cardEntries(q, s, c2).map((e) => e.name);
    assert.ok(!names2.includes('林晚') && !names2.includes('林晚（原创）'), names2.join('、'));
    assert.equal(findCharacterKey(q, '晚姐', ['林晚']), '林晚');
    // 没存进项目的原创卡（世界卡的主要角色同名）：项目里那个同样不带
    const w = { ...originalCard({ id: 'W', kind: 'world', charName: '', cardName: '雾港旧事' }), original: normalizeCardOriginal({ world: '港城', characters: [{ name: '莉莉丝', identity: '原创的莉莉丝' }] }) };
    q.cards.push(w);
    const r = prepareCard(q, s, w);
    assert.deepEqual(r.entries.filter((e) => e.name === '莉莉丝').map((e) => e.content.includes('原创的莉莉丝')), [true], '只有卡上的那个');
});

test('原创世界卡没有主要角色（AI 没给 cast）但条目存进了项目：整卡重新生成 / 重roll 按已定下的设定写，不重新设计，saved 和 savedAs 不丢，不会多出第二套条目', async () => {
    const s = settings();
    const p = createEmptyProject({ name: '原创' });
    const w = {
        id: 'W1', kind: 'world', charName: '', cardName: '雾港旧事', source: 'original', timepoint: null, stAvatar: '', worldName: '',
        original: normalizeCardOriginal({ world: '港城', characters: [], lore: [{ category: '地点', name: '码头', keywords: ['码头'], content: '三号码头' }] }),
        data: { name: '雾港旧事', description: 'd', personality: '', scenario: '', first_mes: 'f', alternate_greetings: [], mes_example: '', system_prompt: '', post_history_instructions: '', creator_notes: '', tags: [] },
    };
    saveOriginalDesign(p, w);
    p.cards.push(w);
    assert.equal(w.original.saved, true);
    const { prompt, fixed } = buildCardPrompt(p, s, cardPromptOpt(w));
    assert.equal(fixed, true);
    assert.ok(!prompt.includes('"cast": [') && !prompt.includes('"lore": ['), '不再要 AI 设计');
    assert.ok(prompt.includes('## 已定下的世界设定\n[地点] 码头\n三号码头'));
    assert.ok(prompt.includes('卡名：雾港旧事（已经定下，不要改）'));
    assert.ok(!prompt.includes('由你来起') && !prompt.includes('由你按世界观设计'), prompt.slice(0, 600));
    const seen = [];
    installTavern(JSON.stringify({ ...WORLD_REPLY, lore: [{ category: '地点', name: '新码头', content: '不该出现' }] }), seen);
    try {
        const r = await generateCard(p, s, cardPromptOpt(w));
        assert.equal(r.original.saved, true);
        assert.equal(r.original.lore[0].savedAs, '码头');
        assert.deepEqual(r.original.lore.map((e) => e.name), ['码头'], '没有重新设计');
        r.id = w.id;
        p.cards[0] = r;
        assert.deepEqual(prepareCard(p, s, r).entries.filter((e) => e.category === '地点').map((e) => e.name), ['码头'], '只有一套条目');
    } finally {
        delete globalThis.SillyTavern;
    }
    // 还没设计好（没有人物、没有条目、没存）：仍然是新写卡
    assert.equal(buildCardPrompt(p, s, { kind: 'world', source: 'original', original: { world: '港城' } }).fixed, false);
});

test('名字已经定下（AI 起的名字、设计好的主要角色）：整卡重新生成、重roll、状态栏 / 落点的背景资料都不再说「由你来起」「由你设计」', () => {
    const s = settings();
    const p = createEmptyProject({ name: '原创' });
    // 单人卡：用户没填名字，AI 起名「林晚」
    const c = originalCard();
    assert.equal(c.original.name, '');
    const single = buildCardPrompt(p, s, cardPromptOpt(c)).prompt;
    assert.ok(single.includes('角色名：林晚（已经定下，不要改）') && single.includes('- name 写「林晚」。'));
    assert.ok(!single.includes('由你来起'), single.slice(0, 400));
    // 世界卡：卡名和主要角色都是 AI 定的
    const w = { ...originalCard({ id: 'w1', kind: 'world', charName: '', cardName: '雾港旧事' }), original: normalizeCardOriginal({ world: '港城', ...parseOriginalDesign(WORLD_REPLY, { kind: 'world', settings: s }) }) };
    w.data = { ...w.data, name: '雾港旧事' };
    saveOriginalDesign(p, w);
    const world = buildCardPrompt(p, s, cardPromptOpt(w)).prompt;
    assert.ok(world.includes('卡名：雾港旧事（已经定下，不要改）') && world.includes('## 已定下的主要角色（以此为准）'));
    assert.ok(!world.includes('由你来起') && !world.includes('由你按世界观设计'), world.slice(0, 600));
    // 背景资料（状态栏变量表、本书落点、推演）
    for (const card of [c, w]) {
        const bg = originalBackgroundText(p, card);
        assert.ok(!bg.includes('由你来起') && !bg.includes('由你按世界观设计'), bg.slice(0, 300));
    }
    assert.ok(originalBackgroundText(p, w).includes('卡名：雾港旧事（已经定下，不要改）'));
    assert.ok(originalBackgroundText(p, c).includes('角色名：林晚（已经定下，不要改）'));
    ensureStatusBar(w, s);
    assert.ok(!buildStatusSpecPrompt(p, s, w).prompt.includes('由你按世界观设计'));
    // 用户自己写了主要角色：照样附上用户写的
    assert.ok(originalPromptText({ world: '港城', cast: '沈砚：探长' }, { kind: 'world', name: '雾港旧事', fixed: true }).includes('<主要角色>\n沈砚：探长\n</主要角色>'));
    // 新写卡（还没设计）：仍由 AI 起名、设计 3-8 个
    const fresh = originalPromptText({ world: '港城' }, { kind: 'world' });
    assert.ok(fresh.includes('卡名：没有定，由你来起') && fresh.includes('由你按世界观设计 3-8 个'));
});

test('没有原文的项目：没填名字的原创项目依次叫「原创项目」「原创项目 2」…；「项目资料」写卡时的说明不说原著', () => {
    assert.equal(freeOriginalProjectName([]), '原创项目');
    assert.equal(freeOriginalProjectName(['魔女']), '原创项目');
    assert.equal(freeOriginalProjectName(['原创项目', '原创项目 2', '魔女']), '原创项目 3');
    assert.equal(sourceWord(true, false), '你的设定');
    assert.equal(sourceWord(false, true), '项目资料');
    assert.equal(sourceWord(false, false), '原著');
    const note = userRoleFormNote('character', '林晚', 'character', false, true);
    assert.ok(note.includes('项目资料里 TA 和 {{char}} 的关系') && !note.includes('原著'), note);
    assert.ok(!userRoleFormNote('new', '', 'character', false, true).includes('原著'));
    assert.ok(!userRoleFormNote('character', '林晚', 'world', false, true).includes('原著'));
    assert.ok(userRoleFormNote('new', '', 'character').includes('原著'), '小说项目照旧');
    // 「项目资料」模式：保留「项目里的角色」这一项，只是改名
    assert.equal(userRoleKindOptions(true, true).find((k) => k.value === 'character').label, '项目里的角色');
});

test('没有原文的项目里点「AI 生成梗概」：说明可以手写，不叫人去提取', async () => {
    const { buildStorySummary } = await import('../src/tools.js');
    await assert.rejects(() => buildStorySummary(createEmptyProject(), settings()), /这个项目没有原文，也就没有章节概要可以总结：可以直接手写故事梗概/);
    await assert.rejects(() => buildStorySummary(novelProject(), settings()), /还没有章节概要，请先提取/);
});
