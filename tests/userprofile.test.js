// 用户画像：规整、默认画像唯一、增删改复制、导入导出、导入配置按 id 合并；写卡提示词的「为这位用户量身定制」一节
// （内容、空项省略、自定义模板追加、没有画像时一字不差、成年人一条）、状态栏变量表提示词的「用户偏好」、
// 卡自己的世界书里的「用户偏好」条目（文字、位置、写入 / 更新 / 去掉）、写卡表单「按画像选导向」
import test from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_CATEGORIES, DEFAULT_SETTINGS } from '../src/constants.js';
import { mergeDefaults } from '../src/utils.js';
import { createProject, mergeCharacter, mergeEntry } from '../src/project.js';
import { buildChunks, detectChapters } from '../src/splitter.js';
import { buildCardPrompt, buildOrientationNotesPrompt, cardPromptOpt, generateCard, regenerateCardField } from '../src/cards.js';
import { addOrientationTemplate, orientationFromPick, removeOrientationTemplate } from '../src/orientation.js';
import { cardExtraEntries, cardOwnWorld, prepareCard, publishCard } from '../src/publish.js';
import { applyConfig } from '../src/io.js';
import { DEFAULT_PROMPTS, PROMPT_PLACEHOLDERS } from '../src/prompts.js';
import { buildStatusSpecPrompt } from '../src/statusbar-ai.js';
import { ensureStatusBar } from '../src/statusbar.js';
import {
    USER_PROFILE_ADULT_LINE, USER_PROFILE_ADULT_LINE_ORIGINAL, USER_PROFILE_FILE_TYPE, USER_PROFILE_LIMITS, USER_PROFILE_TAG_GROUPS, addUserProfile,
    defaultUserProfile, duplicateUserProfile, effectiveDislikes, exportUserProfiles, getUserProfile, importUserProfiles, isDislikedName, listUserProfiles,
    mergeUserProfiles, normalizeCardUserProfile, normalizeProfileTags, normalizeStoredUserProfile, normalizeUserProfile, orientationConflicts,
    parseUserProfiles, profileOrientationPicks, profileOrientations, removeUserProfile, setDefaultUserProfile, updateUserProfile, userProfileEntry,
    userProfileEntryContent, userProfileFileName, userProfileHasEntry, userProfileNameProblem, userProfileNotesLines, userProfilePromptBlock,
    userProfileSnapshot, userProfileSnapshotOutdated, userProfileStatusText, userProfileSummary,
} from '../src/userprofile.js';
import { orientationDislikeNote, userProfileFormNote, userProfileOptionsHtml, userProfileTagHtml } from '../src/ui/tab-cards.js';

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

function baseCard(extra = {}) {
    return {
        id: 'c1', kind: 'character', charName: '莉莉丝', timepoint: null, stAvatar: '', worldName: '',
        data: { name: '莉莉丝', description: 'd', personality: 'p', scenario: 's', first_mes: '“坐。”', alternate_greetings: [], mes_example: '<START>', system_prompt: '', post_history_instructions: '', creator_notes: '', tags: [] },
        ...extra,
    };
}

/** 一个内容齐全的画像（偏好 NTL、纯爱） */
const FULL = {
    name: '足控党', orientations: ['orient_ntl', 'orient_pure'], likes: ['黑丝', '足控', '傲娇'], dislikes: ['NTR', '血腥'], intensity: 'suggestive',
    persona: '二十五岁的男性上班族，个子高、话不多', style: '第二人称、细腻心理', notes: '喜欢斗嘴', chatEntry: true,
};

// ---------------- 规整与默认画像 ----------------

test('规整：标签去空白 / 去 # / 去重（不分大小写）、每个最多 12 字、最多 40 个；文字最多 1000 字；尺度不认识时回到暧昧擦边；喜欢与雷点重复时只留雷点', () => {
    assert.deepEqual(normalizeProfileTags(' 黑丝 ,#足控，傲娇、黑丝\nntr；NTR'), ['黑丝', '足控', '傲娇', 'ntr']);
    assert.deepEqual(normalizeProfileTags(['一二三四五六七八九十一二三四', '', null, { a: 1 }, '  x  y ']), ['一二三四五六七八九十一二', 'x y']);
    const many = Array.from({ length: 50 }, (_, i) => `标签${i}`);
    assert.equal(normalizeProfileTags(many).length, USER_PROFILE_LIMITS.tags);
    const n = normalizeUserProfile({ name: '  我的  ', likes: ['黑丝', 'NTR'], dislikes: ['ntr'], intensity: 'wild', persona: 'x'.repeat(1200), style: ' 第二人称 ', orientations: ['orient_ntl', 'orient_ntl', '', { id: 'orient_pure' }] });
    assert.equal(n.name, '我的');
    assert.deepEqual(n.likes, ['黑丝'], '雷点里有的不会同时算喜欢');
    assert.deepEqual(n.dislikes, ['ntr']);
    assert.equal(n.intensity, 'suggestive');
    assert.equal(n.persona.length, USER_PROFILE_LIMITS.text);
    assert.equal(n.style, '第二人称');
    assert.deepEqual(n.orientations, ['orient_ntl', 'orient_pure']);
    assert.equal(n.chatEntry, true, '「聊天时也照顾这些偏好」默认开');
    assert.equal(n.isDefault, false);
    assert.equal(normalizeUserProfile({ chatEntry: false }).chatEntry, false);
    const stored = normalizeStoredUserProfile({ id: 'bad id', name: '' });
    assert.match(stored.id, /^uprof_/);
    assert.equal(stored.name, '未命名画像');
    assert.equal(normalizeStoredUserProfile({ id: 'uprof_abc', name: 'a' }).id, 'uprof_abc');
    assert.equal(normalizeStoredUserProfile('x'), null);
});

test('画像增删改复制：重名 / 空名拦下；默认画像最多一个（新建、修改、设为默认、列表规整时都保证）', () => {
    const s = settings();
    assert.deepEqual(s.userProfiles, [], '默认设置里有空列表');
    const a = addUserProfile(s, { ...FULL, isDefault: true });
    assert.match(a.id, /^uprof_/);
    assert.throws(() => addUserProfile(s, { name: ' 足控党 ' }), /同名/);
    assert.throws(() => addUserProfile(s, { name: '' }), /不能为空/);
    const b = addUserProfile(s, { name: '纯爱党', isDefault: true });
    assert.equal(defaultUserProfile(s).id, b.id, '新建的默认画像取代原来的');
    assert.equal(getUserProfile(s, a.id).isDefault, false);
    updateUserProfile(s, a.id, { isDefault: true, likes: ['白丝'] });
    assert.equal(defaultUserProfile(s).id, a.id);
    assert.equal(listUserProfiles(s).filter((p) => p.isDefault).length, 1);
    assert.deepEqual(getUserProfile(s, a.id).likes, ['白丝']);
    assert.deepEqual(getUserProfile(s, a.id).dislikes, ['NTR', '血腥'], 'patch 里没有的字段不变');
    assert.throws(() => updateUserProfile(s, a.id, { name: '纯爱党' }), /同名/);
    assert.equal(userProfileNameProblem(s, '纯爱党 ', a.id), '已经有同名的画像');
    assert.equal(userProfileNameProblem(s, '足控党', a.id), '', '自己的名字不算重名');
    updateUserProfile(s, a.id, { isDefault: false });
    assert.equal(defaultUserProfile(s), null, '取消默认后没有默认画像');
    setDefaultUserProfile(s, b.id);
    assert.equal(defaultUserProfile(s).id, b.id);
    const copy = duplicateUserProfile(s, b.id);
    assert.equal(copy.name, '纯爱党 副本');
    assert.equal(copy.isDefault, false, '副本不是默认');
    assert.equal(removeUserProfile(s, copy.id), true);
    assert.equal(removeUserProfile(s, copy.id), false);
    // 存储里被改坏成两个默认：列表只认第一个
    s.userProfiles.forEach((p) => { p.isDefault = true; });
    assert.equal(listUserProfiles(s).filter((p) => p.isDefault).length, 1);
    assert.equal(defaultUserProfile(s).id, a.id);
});

// ---------------- 导入导出 / 导入配置 ----------------

test('导出文件可再导入（重名改名、不是默认）；我的导向模板按名字找回；认不出的文件报错', () => {
    const s = settings();
    const mine = addOrientationTemplate(s, { name: '师徒', entry: '【剧情导向：师徒】' });
    const a = addUserProfile(s, { ...FULL, orientations: ['orient_ntl', mine.id, 'otpl_gone'], isDefault: true });
    const file = exportUserProfiles(s, [getUserProfile(s, a.id)]);
    assert.equal(file.type, USER_PROFILE_FILE_TYPE);
    assert.equal(file.profiles[0].isDefault, undefined, '导出不带默认标记');
    assert.deepEqual(file.profiles[0].orientations, ['orient_ntl', mine.id], '已经删掉的导向不导出');
    assert.deepEqual(file.profiles[0].orientationNames, ['NTL', '师徒']);
    assert.equal(userProfileFileName([a]), '足控党.用户画像.json');
    assert.equal(userProfileFileName([a, a]), '用户画像.json');
    const again = importUserProfiles(s, JSON.stringify(file));
    assert.equal(again[0].name, '足控党 2');
    assert.equal(again[0].isDefault, false);
    assert.deepEqual(again[0].likes, FULL.likes);
    // 换一台电脑：我的模板 id 不同，按名字找回
    const s2 = settings();
    const mine2 = addOrientationTemplate(s2, { name: '师徒', entry: '【剧情导向：师徒】' });
    const imported = importUserProfiles(s2, file);
    assert.deepEqual(imported[0].orientations, ['orient_ntl', mine2.id]);
    assert.equal(defaultUserProfile(s2), null, '导入的画像不会成为默认');
    // 单个画像对象、数组也认
    assert.equal(parseUserProfiles({ name: '单个', likes: '黑丝,白丝' })[0].likes.length, 2);
    assert.equal(parseUserProfiles([{ name: '数组' }]).length, 1);
    assert.throws(() => parseUserProfiles('{oops'), /不是有效的 JSON/);
    assert.throws(() => parseUserProfiles({ foo: 1 }), /不是 NovelLoom 用户画像文件/);
    assert.throws(() => parseUserProfiles({ profiles: [{ name: '' }] }), /没有可用的用户画像/);
});

test('导入配置（applyConfig）：画像按 id 合并、逐个规整，不覆盖本机其他画像；导入的默认画像为准，最多一个默认', () => {
    const s = settings();
    const local = addUserProfile(s, { name: '本机', isDefault: true });
    const other = addUserProfile(s, { name: '本机二' });
    const incoming = [
        { id: other.id, name: '改过的本机二', likes: ['黑丝', '黑丝', '一二三四五六七八九十一二三'], intensity: 'explicit', isDefault: true },
        { id: 'uprof_new', name: '新来的', dislikes: 'NTR，血腥', isDefault: true },
        { id: '', name: '没有 id 的不要' },
        'garbage',
    ];
    applyConfig(s, { type: 'novel_loom_config', settings: { userProfiles: incoming } });
    const list = listUserProfiles(s);
    assert.deepEqual(list.map((p) => p.name), ['本机', '改过的本机二', '新来的']);
    const two = getUserProfile(s, other.id);
    assert.deepEqual(two.likes, ['黑丝', '一二三四五六七八九十一二']);
    assert.equal(two.intensity, 'explicit');
    assert.deepEqual(getUserProfile(s, 'uprof_new').dislikes, ['NTR', '血腥']);
    assert.equal(defaultUserProfile(s).id, other.id, '导入的配置里第一个默认画像为准');
    assert.equal(s.userProfiles.filter((p) => p.isDefault).length, 1);
    assert.equal(getUserProfile(s, local.id).isDefault, false);
    // 配置里没有这一项时不动
    applyConfig(s, { type: 'novel_loom_config', settings: { cards: { creator: 'x' } } });
    assert.equal(listUserProfiles(s).length, 3);
    // 导入后和本机重名（不同 id）：仍然可以改别的字段，只有改名时才检查重名
    applyConfig(s, { userProfiles: [{ id: 'uprof_dup', name: '本机' }] });
    assert.deepEqual(updateUserProfile(s, 'uprof_dup', { likes: ['眼镜'] }).likes, ['眼镜']);
    assert.throws(() => updateUserProfile(s, 'uprof_new', { name: '本机' }), /同名/);
    // mergeUserProfiles 直接用：没有默认画像时保留本机的默认
    const s2 = settings();
    const keep = addUserProfile(s2, { name: '甲', isDefault: true });
    mergeUserProfiles(s2, [{ id: 'uprof_x', name: '乙' }]);
    assert.equal(defaultUserProfile(s2).id, keep.id);
});

// ---------------- 写卡提示词 ----------------

const EXPECTED_BLOCK = [
    '# 为这位用户量身定制',
    '这张卡写给一位口味明确的用户。把下面的偏好化进卡里，让 TA 一读就觉得“懂我”，而不是把偏好贴在卡上。',
    '- 喜欢的元素：黑丝、足控、傲娇。挑和这个角色、这本书相称的，自然融入角色的外貌、服饰、性格、习惯、场景、开场白和示例对话（比如变成角色的穿着习惯、小动作、口头禅，或两人相处的契机）；不要生硬罗列，也不要每句话都提，不必每一样都用上。',
    '- 雷点（一律避免）：NTR、血腥。卡片的任何字段都不出现这些内容，连暗示、伏笔和可能的发展方向都不要留。',
    '- 尺度：暧昧擦边——可以有暧昧、调情和身体接触带来的张力，点到为止，不写露骨的性描写。',
    '- 叙事偏好：第二人称、细腻心理。开场白、备选开场白和示例对话按这个写；与「文风」一节的视角或写法冲突时以这里为准，「文风」里其余的要求照常执行。用第二人称“你”时只写“你”看到、听到、感觉到的，仍不替“你”说话、行动或做决定。',
    '- 偏好的导向：NTL、纯爱。仅作参考：可以在人物关系和开场白里为这些方向留出余地，不改变人物的底色。',
    '- {{user}} 的默认形象：二十五岁的男性上班族，个子高、话不多。{{user}} 以原创新身份出现（{{user}} 是成年人），按这个形象安排 {{user}} 的身份、外貌和与 {{char}} 的切入关系；「用户要求」里另写了 {{user}} 的身份时以「用户要求」为准。',
    '- 其他：喜欢斗嘴',
    '- 偏好与原著冲突时：人物的底色、关键经历和关系以原著为准，偏好体现在可以发挥的地方（穿着、习惯、场景、相处方式）；「用户要求」与这里冲突时以「用户要求」为准。',
    '- 所有涉及恋爱或亲密内容的人物（包括 {{user}}）都是成年人（18 岁以上）：原著里未成年的角色不写进恋爱或亲密内容，年龄不明的一律按成年人来写；{{user}} 的形象或身份里写了未满 18 岁的年龄时，把 {{user}} 写成成年人，或者不让 {{user}} 进入恋爱和亲密内容。',
].join('\n');

test('「为这位用户量身定制」一节：逐字内容；空项省略；选了卡的导向时偏好的导向以卡的导向为准；{{user}} 的默认形象只在原创新身份时写；最后一条是成年人', () => {
    const s = settings();
    const snap = userProfileSnapshot(s, addUserProfile(s, FULL));
    assert.deepEqual(snap.orientations, [{ id: 'orient_ntl', name: 'NTL' }, { id: 'orient_pure', name: '纯爱' }]);
    assert.equal(userProfilePromptBlock(snap), EXPECTED_BLOCK);
    const withOrient = userProfilePromptBlock(snap, { orientation: true });
    assert.ok(withOrient.includes('- 偏好的导向：NTL、纯爱。仅作参考：本次已经选了「卡的导向」，以卡的导向为准。'));
    for (const kind of ['character', 'custom']) assert.ok(!userProfilePromptBlock(snap, { userRoleKind: kind }).includes('默认形象'), `${kind}：以「{{user}} 扮演」为准`);
    // 只有名字：只剩尺度、原著优先与成年人
    const bare = userProfilePromptBlock({ name: '空', intensity: 'sfw' });
    assert.equal(bare.split('\n').length, 5);
    assert.ok(bare.includes('- 尺度：清水——感情止于心动、牵手和拥抱，不写性内容，也不写带挑逗意味的身体描写。'));
    assert.ok(!/喜欢的元素|雷点|叙事偏好|偏好的导向|默认形象|其他：/.test(bare));
    for (const b of [EXPECTED_BLOCK, bare, userProfilePromptBlock({ ...FULL, intensity: 'explicit' })]) assert.ok(b.endsWith(`- ${USER_PROFILE_ADULT_LINE}`), '成年人永远是最后一条');
    assert.ok(userProfilePromptBlock({ ...FULL, intensity: 'explicit' }).includes('可以露骨——亲密场面可以直接、具体地描写'));
    assert.equal(userProfilePromptBlock(null), '');
});

test('写卡提示词 {USER_PROFILE}：在用户要求 / 身份 / 导向之后、字段写法之前；没有画像时与改动前的模板一字不差；自定义模板缺占位符时追加在末尾', () => {
    const p = project();
    const s = settings();
    const snap = userProfileSnapshot(s, addUserProfile(s, FULL));
    const base = { kind: 'character', charName: '莉莉丝', timepoint: Infinity };
    const withP = buildCardPrompt(p, s, { ...base, userProfile: snap }).prompt;
    assert.ok(withP.includes(`\n\n${EXPECTED_BLOCK}\n\n# 字段写法`), '一节前后各空一行');
    // 有导向：导向段在前，画像在后；画像里说以卡的导向为准
    const ntl = orientationFromPick(s, { id: 'orient_ntl', refine: false });
    const both = buildCardPrompt(p, s, { ...base, userProfile: snap, orientation: ntl, userRole: { kind: 'character', charKey: '江酒' } }).prompt;
    assert.ok(both.indexOf('【卡的导向：NTL】') < both.indexOf('# 为这位用户量身定制'));
    assert.ok(both.indexOf('# {{user}} 的身份') < both.indexOf('【卡的导向：NTL】'));
    assert.ok(both.includes('以卡的导向为准') && !both.includes('默认形象'), '扮演原著角色时不写默认形象');
    assert.ok(both.includes('NTR、血腥') && both.includes(USER_PROFILE_ADULT_LINE));
    // 没有画像：和改动前（模板里没有 {USER_PROFILE}）一字不差
    const none = buildCardPrompt(p, s, base);
    s.prompts.card = DEFAULT_PROMPTS.card.replace('{USER_PROFILE}', '');
    const old = buildCardPrompt(p, s, base);
    assert.equal(none.prompt, old.prompt);
    assert.equal(none.system, old.system);
    assert.equal(buildCardPrompt(p, s, { ...base, userProfile: null }).prompt, old.prompt);
    delete s.prompts.card;
    assert.match(none.prompt, /# 用户要求\n[^\n]+\n\n# 字段写法/);
    // 用户改过的模板没有占位符：追加在末尾；有占位符时只出现一次
    s.prompts.card = '为「{CHAR_NAME}」写卡。{REQUIREMENT}\n只输出 JSON。';
    const custom = buildCardPrompt(p, s, { ...base, userProfile: snap, orientation: ntl }).prompt;
    assert.ok(custom.endsWith(`\n\n${EXPECTED_BLOCK.replace('仅作参考：可以在人物关系和开场白里为这些方向留出余地，不改变人物的底色。', '仅作参考：本次已经选了「卡的导向」，以卡的导向为准。')}`));
    assert.ok(custom.indexOf('【卡的导向：NTL】') < custom.indexOf('# 为这位用户量身定制'));
    s.prompts.card = '{USER_PROFILE}写卡';
    assert.equal(buildCardPrompt(p, s, { ...base, userProfile: snap }).prompt.split('# 为这位用户量身定制').length, 2);
    // 占位符登记
    assert.ok(PROMPT_PLACEHOLDERS.card.includes('{USER_PROFILE}'));
    assert.ok(DEFAULT_PROMPTS.card.includes('{USER_ROLE}{ORIENTATION}{USER_PROFILE}\n# 字段写法'));
    // 世界卡同样带上
    delete s.prompts.card;
    assert.ok(buildCardPrompt(p, s, { kind: 'world', timepoint: Infinity, userProfile: snap }).prompt.includes(EXPECTED_BLOCK));
});

test('状态栏变量表提示词：带画像的卡多一节简短的「用户偏好」（值得追踪的喜欢元素、雷点、尺度、成年人）；没有画像时一字不差；模板缺占位符时追加', () => {
    const p = project();
    const s = settings();
    const snap = userProfileSnapshot(s, addUserProfile(s, FULL));
    const c = baseCard({ userProfile: snap });
    ensureStatusBar(c, s);
    const text = userProfileStatusText(snap);
    assert.equal(text, [
        '# 用户偏好',
        '这张卡是为一位口味明确的用户写的，变量设计可以照顾 TA 的偏好：',
        '- 喜欢的元素：黑丝、足控、傲娇。其中能在扮演中变化、值得追踪的，可以做成变量或记录里的字段（例如 足控、丝袜 → 服饰里的袜子和鞋子；制服 → 当前着装；支配、臣服 → 主导权或服从度）；和这张卡无关的不用硬加，也不要为了凑偏好超出变量上限。',
        '- 雷点（一律避免）：NTR、血腥。不设计与这些内容有关的变量，desc 和 check 里也不要出现。',
        '- 尺度：暧昧擦边。变量名、desc 和 check 都不超出这个尺度。',
        '- 所有涉及恋爱或亲密内容的人物（包括 {{user}}）都是成年人（18 岁以上）。',
    ].join('\n'));
    const { prompt } = buildStatusSpecPrompt(p, s, c);
    assert.ok(prompt.includes(`\n\n${text}\n\n# 设计要求`));
    const plainCard = baseCard();
    ensureStatusBar(plainCard, s);
    const plain = buildStatusSpecPrompt(p, s, plainCard);
    assert.match(plain.prompt, /# 用户要求\n（无特别要求）\n\n# 设计要求/);
    s.prompts.statusSpec = DEFAULT_PROMPTS.statusSpec.replace('{USER_PROFILE}', '');
    assert.equal(buildStatusSpecPrompt(p, s, plainCard).prompt, plain.prompt, '没有画像时与改动前一字不差');
    s.prompts.statusSpec = '设计变量 {REQUIREMENT}';
    assert.ok(buildStatusSpecPrompt(p, s, c).prompt.endsWith(text));
    assert.ok(PROMPT_PLACEHOLDERS.statusSpec.includes('{USER_PROFILE}') && PROMPT_PLACEHOLDERS.statusSpecSystem.includes('{USER_PROFILE}'));
    assert.ok(DEFAULT_PROMPTS.statusSpec.includes('{USER_ROLE}{USER_PROFILE}\n# 设计要求'));
});

// ---------------- 生成 / 重roll 用卡上的快照 ----------------

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

const CARD_JSON = JSON.stringify({ name: 'x', description: '基本信息', personality: '慢', scenario: '酒吧', first_mes: '“坐。”', alternate_greetings: [], mes_example: '<START>\n{{char}}: 坐', tags: ['魔女'] });

test('generateCard 把画像快照存在卡上；整卡重新生成、单字段重roll 用卡上的快照（之后改画像不影响）', async () => {
    const p = project();
    const s = settings();
    const prof = addUserProfile(s, FULL);
    const seen = [];
    installTavern((t) => (t.includes('重新生成「开场白」') ? '“新的开场。”' : CARD_JSON), seen);
    try {
        const c = await generateCard(p, s, { kind: 'character', charName: '莉莉丝', timepoint: Infinity, userProfile: userProfileSnapshot(s, prof.id, { chatEntry: false }) });
        assert.equal(c.userProfile.id, prof.id);
        assert.equal(c.userProfile.name, '足控党');
        assert.equal(c.userProfile.chatEntry, false, '这次写卡单独关掉了条目');
        assert.deepEqual(c.userProfile.likes, FULL.likes);
        assert.ok(seen.at(-1).includes('# 为这位用户量身定制'));
        // 画像页改了画像：卡上的快照不变，重roll 仍按快照写
        updateUserProfile(s, prof.id, { likes: ['白丝'], dislikes: ['死亡'] });
        assert.equal(userProfileSnapshotOutdated(s, c.userProfile), true);
        assert.deepEqual(cardPromptOpt(c).userProfile, c.userProfile);
        await regenerateCardField(p, s, c, 'first_mes');
        const rp = seen.at(-1);
        assert.ok(rp.includes('- 喜欢的元素：黑丝、足控、傲娇。') && rp.includes('NTR、血腥') && !rp.includes('白丝'), '重roll 用卡上的快照');
        assert.equal(c.data.first_mes, '“新的开场。”');
        const regen = await generateCard(p, s, { ...cardPromptOpt(c) });
        assert.deepEqual(regen.userProfile, c.userProfile, '整卡重新生成沿用快照');
        const none = await generateCard(p, s, { kind: 'character', charName: '莉莉丝', timepoint: Infinity });
        assert.equal(none.userProfile, null);
        assert.ok(!seen.at(-1).includes('量身定制'));
    } finally {
        delete globalThis.SillyTavern;
    }
});

// ---------------- 卡自己的世界书条目 ----------------

const EXPECTED_ENTRY = [
    '【用户偏好】',
    '聊天时照顾 {{user}} 的偏好：黑丝、足控、傲娇。在合适的时候自然地带出来（角色的穿着、小动作、对话和场景），不要每次回复都提，也不要生硬堆砌。',
    '绝对避免：NTR、血腥。不写这些内容，也不把剧情往这些方向引。',
    '尺度：暧昧擦边——可以暧昧、调情，有身体接触的张力，点到为止，不写露骨的性描写。',
    '叙事偏好：第二人称、细腻心理。',
    '所有涉及恋爱或亲密内容的人物（包括 {{user}}）都是成年人。',
].join('\n');

test('「用户偏好」条目：固定文字（喜欢 / 雷点 / 尺度 / 叙事 / 成年人），常驻、@深度 4、系统角色，顺序比剧情导向小 1；关掉 chatEntry 或没有画像时没有', () => {
    const s = settings();
    const snap = userProfileSnapshot(s, addUserProfile(s, FULL));
    assert.equal(userProfileEntryContent(snap), EXPECTED_ENTRY);
    assert.equal(userProfileEntryContent({ name: '空', intensity: 'sfw' }), '【用户偏好】\n尺度：清水——感情止于心动、牵手和拥抱，不写性内容。\n所有涉及恋爱或亲密内容的人物（包括 {{user}}）都是成年人。');
    const e = userProfileEntry(baseCard({ userProfile: snap }));
    assert.equal(e.comment, '用户偏好');
    assert.equal(e.name, '用户偏好');
    assert.deepEqual([e.constant, e.position, e.depth, e.role, e.order, e.disable], [true, 4, 4, 0, 99, false]);
    assert.equal(e.content, EXPECTED_ENTRY);
    const mine = addOrientationTemplate(s, { name: '我的', entry: '【剧情导向：我的】', order: 9 });
    assert.equal(userProfileEntry(baseCard({ userProfile: snap, orientation: orientationFromPick(s, { id: mine.id }) })).order, 8, '跟着导向的顺序');
    assert.equal(userProfileEntry(baseCard({ userProfile: { ...snap, chatEntry: false } })), null);
    assert.equal(userProfileHasEntry(baseCard({ userProfile: { ...snap, chatEntry: false } })), false);
    assert.equal(userProfileEntry(baseCard()), null);
});

test('prepareCard：带「用户偏好」条目的卡用自己的世界书，条目排在剧情导向之后、{{user}} 的身份之前；只关掉条目的普通卡不用专用世界书', () => {
    const p = project();
    const s = settings();
    const snap = userProfileSnapshot(s, addUserProfile(s, FULL));
    const c = baseCard({ userProfile: snap, orientation: orientationFromPick(s, { id: 'orient_ntl' }), userRole: { kind: 'character', charKey: '江酒' } });
    assert.deepEqual(cardExtraEntries(p, s, c).map((e) => e.comment), ['剧情导向：NTL', '用户偏好', '{{user}} 的身份']);
    const s2 = settings();
    s2.cards.linkWorldbook = false;
    s2.cards.embedWorldbook = false;
    const r = prepareCard(p, s2, c);
    assert.deepEqual(r.json.data.character_book.entries.map((e) => e.comment), ['剧情导向：NTL', '用户偏好', '{{user}} 的身份']);
    const be = r.json.data.character_book.entries.find((e) => e.comment === '用户偏好');
    assert.equal(be.constant, true);
    assert.equal(be.extensions.position, 4);
    assert.equal(be.extensions.depth, 4);
    assert.equal(be.extensions.role, 0);
    assert.equal(be.content, EXPECTED_ENTRY);
    // 只有画像（没有导向 / 身份）：同样用自己的世界书
    const only = baseCard({ userProfile: snap });
    assert.equal(cardOwnWorld(only), true);
    assert.equal(prepareCard(p, s, only).worldName, '《魔女》世界书·莉莉丝');
    // 画像关掉了条目：和普通卡一样
    const off = baseCard({ userProfile: { ...snap, chatEntry: false } });
    assert.equal(cardOwnWorld(off), false);
    assert.equal(prepareCard(p, s, off).worldName, '《魔女》世界书');
});

/** 模拟酒馆的世界书保存与角色导入 */
function installPublishST() {
    const saved = { worlds: {}, imports: [] };
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
            saved.imports.push({ json: JSON.parse(await file.text()), preserved: init.body.get('preserved_name') });
            if (!ctx.characters.some((ch) => ch.avatar === 'lilith.png')) ctx.characters.push({ avatar: 'lilith.png' });
            return new Response(JSON.stringify({ file_name: 'lilith' }), { status: 200 });
        }
        return new Response('{}', { status: 404 });
    };
    return { saved, restore: () => { globalThis.fetch = origFetch; delete globalThis.SillyTavern; } };
}

test('publishCard：「用户偏好」写进卡自己的世界书；改画像后重新写入同一本被更新；关掉条目 / 不使用画像后条目被去掉（仍写回同一本）', async () => {
    const p = project();
    const s = settings();
    s.cards.linkWorldbook = false;
    s.cards.embedWorldbook = false;
    const { saved, restore } = installPublishST();
    const book = () => Object.values(saved.worlds['《魔女》世界书·莉莉丝'].entries);
    try {
        const prof = addUserProfile(s, FULL);
        const c = baseCard({ userProfile: userProfileSnapshot(s, prof.id) });
        const r = await publishCard(p, s, c);
        assert.equal(r.ownWorld, true);
        assert.equal(c.ownWorldName, '《魔女》世界书·莉莉丝');
        assert.deepEqual(book().map((e) => e.comment), ['用户偏好']);
        const w = book()[0];
        assert.deepEqual([w.constant, w.position, w.depth, w.role, w.order], [true, 4, 4, 0, 99]);
        assert.equal(w.content, EXPECTED_ENTRY);
        assert.equal(saved.imports[0].json.data.extensions.world, '《魔女》世界书·莉莉丝');
        // 换成画像页里的新版本：同一本里的条目被更新
        updateUserProfile(s, prof.id, { likes: ['白丝'], dislikes: [] });
        c.userProfile = userProfileSnapshot(s, prof.id);
        await publishCard(p, s, c);
        assert.equal(book().length, 1);
        assert.ok(book()[0].content.includes('聊天时照顾 {{user}} 的偏好：白丝。') && !book()[0].content.includes('绝对避免'));
        // 关掉条目：仍写回同一本，把条目去掉
        c.userProfile = { ...c.userProfile, chatEntry: false };
        assert.equal(cardOwnWorld(c), true, '写入过专用世界书的卡继续用它');
        const r3 = await publishCard(p, s, c);
        assert.equal(r3.worldName, '《魔女》世界书·莉莉丝');
        assert.deepEqual(book(), []);
        // 不使用画像：同样没有
        c.userProfile = null;
        await publishCard(p, s, c);
        assert.deepEqual(book(), []);
        assert.ok(!(saved.imports.at(-1).json.data.character_book?.entries || []).some((e) => e.comment === '用户偏好'));
    } finally {
        restore();
    }
});

// ---------------- 写卡表单 ----------------

test('按画像选导向：选了画像、画像里有还存在的偏好导向、卡的导向是「不限」时才给按钮；删掉的模板悄悄丢掉', () => {
    const s = settings();
    const mine = addOrientationTemplate(s, { name: '师徒', entry: '【剧情导向：师徒】' });
    const prof = addUserProfile(s, { name: '甲', orientations: ['orient_ntl', mine.id, 'otpl_nope'] });
    assert.deepEqual(profileOrientationPicks(s, getUserProfile(s, prof.id), ''), [{ id: 'orient_ntl', name: 'NTL' }, { id: mine.id, name: '师徒' }]);
    assert.deepEqual(profileOrientationPicks(s, getUserProfile(s, prof.id), 'orient_pure'), [], '已经选了导向时不给（不替用户改）');
    assert.deepEqual(profileOrientationPicks(s, null, ''), [], '没选画像');
    assert.deepEqual(profileOrientationPicks(s, addUserProfile(s, { name: '乙' }), ''), [], '画像里没有偏好的导向');
    removeOrientationTemplate(s, mine.id);
    assert.deepEqual(profileOrientations(s, getUserProfile(s, prof.id)), [{ id: 'orient_ntl', name: 'NTL' }]);
    assert.deepEqual(getUserProfile(s, prof.id).orientations, ['orient_ntl', mine.id, 'otpl_nope'], '设置里存的 id 不动，用的时候丢掉');
    assert.deepEqual(userProfileSnapshot(s, prof.id).orientations, [{ id: 'orient_ntl', name: 'NTL' }]);
});

test('写卡表单与卡片列表的显示：下拉选项（不使用 / 画像，默认标出来 / 卡上已删除的画像）、一行摘要、列表标签', () => {
    const s = settings();
    const a = addUserProfile(s, { ...FULL, isDefault: true });
    const b = addUserProfile(s, { name: '纯爱党' });
    const html = userProfileOptionsHtml(s, a.id);
    assert.match(html, /<option value="" >不使用<\/option>/);
    assert.ok(html.includes(`<option value="${a.id}" selected>足控党（默认）</option>`));
    assert.ok(html.includes(`<option value="${b.id}" >纯爱党</option>`));
    const snap = userProfileSnapshot(s, a.id);
    removeUserProfile(s, a.id);
    assert.ok(userProfileOptionsHtml(s, a.id, { current: snap }).includes(`<option value="${a.id}" selected>足控党（这张卡上的）</option>`));
    assert.equal(userProfileSummary(FULL), '喜欢 黑丝、足控、傲娇 · 雷点 NTR、血腥 · 尺度 暧昧擦边 · 叙事 第二人称、细腻心理');
    assert.equal(userProfileFormNote(FULL), '会按这个画像量身定制：喜欢 黑丝、足控、傲娇 · 雷点 NTR、血腥 · 尺度 暧昧擦边 · 叙事 第二人称、细腻心理。');
    assert.match(userProfileFormNote(null, false), /还没有用户画像/);
    assert.equal(userProfileFormNote(null, true), '不使用画像：按原著和你的要求写。');
    assert.equal(userProfileFormNote(null, true, true), '不使用画像：按你的设定和你的要求写。');
    assert.equal(userProfileFormNote(null, true, false, true), '不使用画像：按项目资料和你的要求写。', '没有原文的项目不说原著');
    assert.match(userProfileFormNote(null, false), /点「管理用户画像」/);
    assert.match(userProfileTagHtml(baseCard({ userProfile: snap })), /画像：足控党/);
    assert.equal(userProfileTagHtml(baseCard()), '');
    assert.equal(normalizeCardUserProfile(null), null);
});

test('内置标签建议：分组齐全、没有未成年属性的标签；所有提示词与条目都写明成年人', () => {
    const all = USER_PROFILE_TAG_GROUPS.flatMap((g) => g.tags);
    assert.deepEqual(USER_PROFILE_TAG_GROUPS.map((g) => [g.name, g.kind]), [['角色属性', 'likes'], ['外形与服饰', 'likes'], ['癖好与偏好', 'likes'], ['常见雷点', 'dislikes']]);
    for (const bad of ['萝莉', '正太', '幼', '小学', '初中', '中学生', '未成年', '童']) assert.ok(!all.some((t) => t.includes(bad)), bad);
    assert.ok(all.includes('足控') && all.includes('黑丝') && all.includes('NTR'));
    assert.ok(all.every((t) => t.length <= USER_PROFILE_LIMITS.tag));
    for (const intensity of ['sfw', 'suggestive', 'explicit']) {
        const sp = { name: 'x', intensity };
        // 成年人一条点名包括 {{user}}：{{user}} 也是亲密内容里的一方
        for (const t of [userProfilePromptBlock(sp), userProfilePromptBlock(sp, { original: true }), userProfileStatusText(sp), userProfileEntryContent(sp), userProfileNotesLines(sp)]) {
            assert.ok(t.includes('所有涉及恋爱或亲密内容的人物（包括 {{user}}）都是成年人'), t);
        }
    }
    assert.ok(USER_PROFILE_ADULT_LINE.includes('{{user}} 的形象或身份里写了未满 18 岁的年龄时，把 {{user}} 写成成年人，或者不让 {{user}} 进入恋爱和亲密内容。'));
    assert.ok(USER_PROFILE_ADULT_LINE_ORIGINAL.startsWith('所有涉及恋爱或亲密内容的人物（包括 {{user}}）都是成年人（18 岁以上）：设定里未成年的角色'));
    // 默认形象写了未成年的年龄：照样写进提示词（用户的原话），但紧跟着说明 {{user}} 是成年人，最后一条成年人规则也点名 {{user}}
    const minor = userProfilePromptBlock({ name: 'x', persona: '十六岁的高中生', intensity: 'explicit' });
    assert.ok(minor.includes('- {{user}} 的默认形象：十六岁的高中生。{{user}} 以原创新身份出现（{{user}} 是成年人）'));
    assert.ok(minor.endsWith(`- ${USER_PROFILE_ADULT_LINE}`));
});

// ---------------- 雷点与卡的导向冲突 ----------------

test('雷点与卡的导向同名：提示词里这一项雷点不适用并写明以卡的导向为准；「用户偏好」条目、状态栏、本书落点都不再「绝对避免」它；画像自相矛盾时不推荐也不列为偏好', () => {
    const s = settings();
    const p = project();
    // 画像：偏好的导向里有 NTR（点错了），雷点里也有 NTR 和后宫
    const prof = addUserProfile(s, { name: '矛盾党', orientations: ['orient_ntr', 'orient_ntl'], likes: ['黑丝'], dislikes: ['ntr', '后宫', '血腥'] });
    const stored = getUserProfile(s, prof.id);
    assert.deepEqual(orientationConflicts(s, stored), [{ id: 'orient_ntr', name: 'NTR' }], '比较时不分大小写');
    assert.equal(isDislikedName(stored, ' N T R '), true);
    assert.equal(isDislikedName(stored, 'NTL'), false);
    assert.deepEqual(profileOrientationPicks(s, stored, ''), [{ id: 'orient_ntl', name: 'NTL' }], '雷点里的导向不当快捷按钮推荐');
    assert.deepEqual(effectiveDislikes(stored, 'NTR'), { dislikes: ['后宫', '血腥'], overridden: ['ntr'] });
    assert.deepEqual(effectiveDislikes(stored, ''), { dislikes: ['ntr', '后宫', '血腥'], overridden: [] });
    const snap = userProfileSnapshot(s, prof.id);
    // 没有选导向：偏好的导向里不列 NTR（它是雷点），雷点照常
    const plain = userProfilePromptBlock(snap);
    assert.ok(plain.includes('- 偏好的导向：NTL。') && !plain.includes('偏好的导向：NTR'));
    assert.ok(plain.includes('- 雷点（一律避免）：ntr、后宫、血腥。'));
    // 选了 NTR 当卡的导向：雷点里去掉 NTR，并写明以卡的导向为准
    const ntr = orientationFromPick(s, { id: 'orient_ntr', refine: false });
    const prompt = buildCardPrompt(p, s, { kind: 'character', charName: '莉莉丝', timepoint: Infinity, orientation: ntr, userProfile: snap }).prompt;
    assert.ok(prompt.includes('- 雷点（一律避免）：后宫、血腥。卡片的任何字段'));
    assert.ok(prompt.includes('- 雷点里的「ntr」就是本次「卡的导向」：这张卡以卡的导向为准，这一项雷点不适用。'));
    assert.ok(!/雷点（一律避免）：[^\n]*ntr/i.test(prompt));
    // 「用户偏好」条目：不再「绝对避免：NTR」（否则和「剧情导向：NTR」条目每一轮都打架）
    const card = baseCard({ userProfile: snap, orientation: ntr });
    const entry = userProfileEntry(card);
    assert.ok(entry.content.includes('绝对避免：后宫、血腥。') && !/绝对避免：[^\n]*ntr/i.test(entry.content), entry.content);
    assert.ok(userProfileEntryContent(snap).includes('绝对避免：ntr、后宫、血腥。'), '没有导向时照常');
    const comments = cardExtraEntries(p, s, card).map((e) => e.comment);
    assert.deepEqual(comments, ['剧情导向：NTR', '用户偏好']);
    // 状态栏变量表：雷点里同样去掉 NTR
    assert.ok(userProfileStatusText(snap, { orientationName: 'NTR' }).includes('- 雷点（一律避免）：后宫、血腥。'));
    ensureStatusBar(card, s);
    assert.ok(buildStatusSpecPrompt(p, s, card).prompt.includes('- 雷点（一律避免）：后宫、血腥。不设计'));
    // 本书落点：雷点（去掉 NTR）+ 成年人
    const notes = buildOrientationNotesPrompt(p, s, card).prompt;
    assert.ok(notes.includes('- 雷点（一律避免）：后宫、血腥。落点里不出现这些内容'), notes);
    assert.ok(notes.includes(`- ${USER_PROFILE_ADULT_LINE}`));
    // 写卡表单的提醒
    assert.equal(orientationDislikeNote(stored, 'NTR'), '用户画像「矛盾党」把「NTR」列为雷点：这张卡以卡的导向为准，写卡时这一项雷点不适用（其余雷点照样避开）。');
    assert.equal(orientationDislikeNote(stored, 'NTL'), '');
    assert.equal(orientationDislikeNote(null, 'NTR'), '');
});

test('本书落点提示词 {USER_PROFILE_LINE}：没有画像时与改动前一字不差；有画像时雷点和成年人两行；自定义模板缺占位符时追加', () => {
    const s = settings();
    const p = project();
    const ntl = orientationFromPick(s, { id: 'orient_ntl', refine: true });
    const plain = baseCard({ orientation: ntl });
    const none = buildOrientationNotesPrompt(p, s, plain).prompt;
    s.prompts.orientationNotes = DEFAULT_PROMPTS.orientationNotes.replace('{USER_PROFILE_LINE}', '');
    assert.equal(buildOrientationNotesPrompt(p, s, plain).prompt, none, '没有画像时一字不差');
    delete s.prompts.orientationNotes;
    const snap = userProfileSnapshot(s, addUserProfile(s, FULL));
    const withP = buildOrientationNotesPrompt(p, s, baseCard({ orientation: ntl, userProfile: snap })).prompt;
    assert.ok(withP.includes(`其他角色写原著里的名字。\n- 雷点（一律避免）：NTR、血腥。落点里不出现这些内容，连暗示和可能的发展方向都不要留。\n- ${USER_PROFILE_ADULT_LINE}\n`));
    assert.equal(userProfileNotesLines(null), '');
    assert.equal(userProfileNotesLines({ name: 'x' }), `- ${USER_PROFILE_ADULT_LINE}\n`, '没有雷点时只有成年人一条');
    s.prompts.orientationNotes = '落点：{CARD_CONTENT}';
    assert.ok(buildOrientationNotesPrompt(p, s, baseCard({ orientation: ntl, userProfile: snap })).prompt.endsWith(`- ${USER_PROFILE_ADULT_LINE}`));
    assert.ok(PROMPT_PLACEHOLDERS.orientationNotes.includes('{USER_PROFILE_LINE}'));
});

test('叙事偏好与文风：写明冲突时以叙事偏好为准（文风其余照常），第二人称也不替 {{user}} 说话、行动', () => {
    const block = userProfilePromptBlock({ name: 'x', style: '第二人称' });
    assert.ok(block.includes('- 叙事偏好：第二人称。开场白、备选开场白和示例对话按这个写；与「文风」一节的视角或写法冲突时以这里为准'));
    assert.ok(block.includes('仍不替“你”说话、行动或做决定'));
    assert.ok(!userProfilePromptBlock({ name: 'x' }).includes('叙事偏好'));
});
