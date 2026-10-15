// 用户画像的常用库（每一项都可以添加自定义的并保存）：规整与上限、内置分组合并（自定义标签、隐藏 / 恢复内置标签）、
// 自定义分组（喜欢 / 雷点）、自定义尺度（解析、卡片快照、删掉后的回退）、叙事偏好的字符串 ↔ 一项一项、常用文字、
// 画像文件与配置的导入导出、没有自定义内容时所有提示词与条目一字不差、内置内容里没有未成年属性的词
import test from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_CATEGORIES, DEFAULT_SETTINGS } from '../src/constants.js';
import { mergeDefaults } from '../src/utils.js';
import { createProject, mergeCharacter } from '../src/project.js';
import { buildChunks, detectChapters } from '../src/splitter.js';
import { buildCardPrompt, buildOrientationNotesPrompt } from '../src/cards.js';
import { orientationFromPick } from '../src/orientation.js';
import { cardExtraEntries } from '../src/publish.js';
import { applyConfig } from '../src/io.js';
import { getSettings } from '../src/store.js';
import { buildStatusSpecPrompt } from '../src/statusbar-ai.js';
import { ensureStatusBar } from '../src/statusbar.js';
import {
    PROFILE_LIBRARY_LIMITS, STYLE_GROUP_ID, USER_PROFILE_INTENSITIES, USER_PROFILE_STYLE_SUGGESTIONS, USER_PROFILE_TAG_GROUPS, addCustomIntensity,
    addLibraryGroup, addLibraryTags, addProfileSnippet, exportProfileLibrary, intensityInfo, intensityNameProblem, libraryGroupNameProblem, libraryGroupOfTag,
    libraryGroups, libraryMergeSummary, mergeProfileLibrary, normalizeProfileLibrary, profileIntensities, profileLibrary, profileLibraryCounts, profileSnippets,
    removeCustomIntensity, removeLibraryGroup, removeLibraryTag, removeProfileSnippet, renameLibraryGroup, resolveIntensityId, restoreLibraryTags,
    tagKey, updateCustomIntensity,
} from '../src/profilelib.js';
import {
    USER_PROFILE_ADULT_LINE, addUserProfile, exportUserProfiles, getUserProfile, importUserProfileFile, joinStyleTags, normalizeCardUserProfile, normalizeUserProfile,
    profileIntensityInfo, styleTags, updateUserProfile, userProfileEntry, userProfileEntryContent, userProfileNotesLines, userProfilePromptBlock, userProfileSnapshot,
    userProfileSnapshotOutdated, userProfileStatusText, userProfileSummary,
} from '../src/userprofile.js';
import { userProfileFormNote } from '../src/ui/tab-cards.js';

const NOVEL = ['第一章 魔女小姐', '江酒走进酒吧。莉莉丝坐在角落。', '第二章 女仆', '江酒穿上了女仆装。'].join('\n');

function settings() {
    const s = mergeDefaults({}, DEFAULT_SETTINGS);
    s.categories = structuredClone(DEFAULT_CATEGORIES);
    s.api.retries = 0;
    s.antiTruncate.enabled = false;
    return s;
}

function project() {
    const chunks = detectChapters(NOVEL, '^第.+章.*$').map((ch) => buildChunks([ch], 1000, false)[0]);
    chunks.forEach((c, i) => (c.index = i));
    const p = createProject({ name: '魔女', text: NOVEL, chunks });
    mergeCharacter(p, { name: '莉莉丝', identity: '大魔女', importance: 'main' }, 0);
    return p;
}

const FULL = {
    name: '足控党', orientations: ['orient_ntl', 'orient_pure'], likes: ['黑丝', '足控', '傲娇'], dislikes: ['NTR', '血腥'], intensity: 'suggestive',
    persona: '二十五岁的男性上班族，个子高、话不多', style: '第二人称、细腻心理', notes: '喜欢斗嘴', chatEntry: true,
};

/** 一个塞满自定义内容的常用库（都不被画像用到） */
function fillLibrary(s) {
    addLibraryTags(s, 'traits', ['猫娘', '狐娘']);
    removeLibraryTag(s, 'traits', '人妻');
    const g = addLibraryGroup(s, { name: '我的雷点', target: 'dislikes' });
    addLibraryTags(s, g.id, '黑暗结局，鬼畜');
    addCustomIntensity(s, { name: '纯情慢热', desc: '感情慢慢升温，亲吻点到为止，不写性内容。' });
    addLibraryTags(s, STYLE_GROUP_ID, ['多写环境', '短句']);
    removeLibraryTag(s, STYLE_GROUP_ID, '文艺');
    addProfileSnippet(s, 'persona', { name: '上班族', text: '三十岁的上班族' });
    addProfileSnippet(s, 'notes', { text: '别太快动心' });
    return g;
}

// ---------------- 规整与上限 ----------------

test('常用库规整：默认设置里是空库；不认识的项丢掉；内置分组只留自定义标签与隐藏的内置标签；上限（标签 12 字、每组 60 个、30 个分组、尺度 20 个）', () => {
    const s = settings();
    assert.deepEqual(s.profileLibrary, { groups: [], intensities: [], style: { tags: [], hidden: [] }, snippets: [] });
    const n = normalizeProfileLibrary({
        groups: [
            { id: 'traits', tags: ['傲娇', '猫娘', ' 猫娘 ', '#狐娘', '一二三四五六七八九十一二三'], hidden: ['人妻', '不存在的', '温柔'] },
            { id: 'traits', tags: ['兔娘'], hidden: ['高冷'] },
            { id: 'ugrp_a', name: '  我的分组  ', target: 'dislikes', tags: 'A,B，a' },
            { id: 'ugrp_a', name: '同 id 的第二个', tags: [] },
            { id: 'whatever', name: '角色属性', tags: ['和内置分组重名'] },
            { name: '', tags: ['没有名字'] },
            'garbage', null,
        ],
        intensities: [
            { id: 'uint_x', name: '纯情慢热', desc: '慢慢来。' },
            { id: 'uint_x', name: '同 id', desc: 'x' },
            { name: '清水', desc: '和内置重名' },
            { name: '没有说明', desc: '' },
            { name: '一二三四五六七八九', desc: '名称截到 8 字\n换行合并' },
        ],
        style: { tags: ['第二人称', '多写环境', '多写环境'], hidden: ['文艺', '不是内置的'] },
        snippets: [{ field: 'persona', text: '  一段  ' }, { field: 'persona', text: '一段' }, { field: 'oops', text: 'x' }, { field: 'notes', name: '', text: '第一行很长很长很长很长很长很长\n第二行' }],
    });
    const traits = n.groups.find((g) => g.id === 'traits');
    assert.deepEqual(traits, { id: 'traits', tags: ['猫娘', '狐娘', '一二三四五六七八九十一二', '兔娘'], hidden: ['温柔', '高冷', '人妻'] }, '内置标签不进自定义；隐藏的按内置顺序');
    const mine = n.groups.filter((g) => g.id !== 'traits');
    assert.equal(mine.length, 3);
    assert.deepEqual([mine[0].id, mine[0].name, mine[0].target, mine[0].tags], ['ugrp_a', '我的分组', 'dislikes', ['A', 'B']]);
    assert.notEqual(mine[1].id, 'ugrp_a', '重复的 id 换一个新的');
    assert.equal(mine[1].target, 'likes', '没写用在哪里时是喜欢');
    assert.deepEqual([mine[2].name, mine[2].tags], ['角色属性2', ['和内置分组重名']], '和内置分组重名：改名留下，标签不丢');
    assert.deepEqual(n.intensities.map((x) => [x.name, x.desc]), [['纯情慢热', '慢慢来。'], ['同 id', 'x'], ['清水2', '和内置重名'], ['一二三四五六七八', '名称截到 8 字 换行合并']]);
    assert.equal(n.intensities[0].id, 'uint_x');
    assert.notEqual(n.intensities[1].id, 'uint_x');
    assert.deepEqual(n.style, { tags: ['多写环境'], hidden: ['文艺'] });
    assert.deepEqual(n.snippets.map((x) => [x.field, x.name, x.text]), [['persona', '一段', '一段'], ['notes', '第一行很长很长很长很长很…','第一行很长很长很长很长很长很长\n第二行']]);
    // 上限
    const many = normalizeProfileLibrary({
        groups: [{ id: 'looks', tags: Array.from({ length: 80 }, (_, i) => `标签${i}`) }, ...Array.from({ length: 40 }, (_, i) => ({ id: `ugrp_${i}`, name: `分组${i}` }))],
        intensities: Array.from({ length: 30 }, (_, i) => ({ name: `尺度${i}`, desc: 'x' })),
    });
    assert.equal(many.groups.find((g) => g.id === 'looks').tags.length, PROFILE_LIBRARY_LIMITS.groupTags);
    assert.equal(many.groups.filter((g) => g.id.startsWith('ugrp_')).length, PROFILE_LIBRARY_LIMITS.groups);
    assert.equal(many.intensities.length, PROFILE_LIBRARY_LIMITS.intensities);
    assert.deepEqual(normalizeProfileLibrary('garbage'), { groups: [], intensities: [], style: { tags: [], hidden: [] }, snippets: [] });
});

test('profileLibrary：规整一次后写回设置；换成新对象（导入、外部改写）时重新规整；读取设置时（store）也规整', () => {
    const s = settings();
    s.profileLibrary = { groups: [{ id: 'traits', tags: ['猫娘', '傲娇'] }] };
    const lib = profileLibrary(s);
    assert.equal(s.profileLibrary, lib);
    assert.deepEqual(lib.groups[0].tags, ['猫娘']);
    assert.equal(profileLibrary(s), lib, '同一个对象不重复规整');
    delete s.profileLibrary;
    assert.deepEqual(profileLibrary(s).groups, []);
    // store.getSettings：扩展设置里存的旧库（或坏掉的库）读出来就是规整好的
    globalThis.SillyTavern = { getContext: () => ({ extensionSettings: { novel_loom: { profileLibrary: { groups: 'bad', intensities: [{ name: '甲', desc: '乙' }] } } } }) };
    try {
        const st = getSettings();
        assert.deepEqual(st.profileLibrary.groups, []);
        assert.equal(st.profileLibrary.intensities[0].name, '甲');
        assert.deepEqual(st.profileLibrary.style, { tags: [], hidden: [] });
        assert.deepEqual(st.profileLibrary.snippets, []);
    } finally {
        delete globalThis.SillyTavern;
    }
    // 旧设置里没有这一项：mergeDefaults 补上空库
    const old = mergeDefaults({ userProfiles: [] }, DEFAULT_SETTINGS);
    assert.deepEqual(old.profileLibrary, { groups: [], intensities: [], style: { tags: [], hidden: [] }, snippets: [] });
});

test('规整：用在哪里 / 常用文字的字段只认自己的键（__proto__、constructor、toString 这样的名字不算）', () => {
    const n = normalizeProfileLibrary(JSON.parse(JSON.stringify({
        groups: [
            { id: 'ugrp_b', name: '甲', target: '__proto__', tags: ['t'] },
            { id: 'ugrp_c', name: '乙', target: 'constructor', kind: 'toString', tags: ['u'] },
            { id: 'ugrp_d', name: '丙', kind: 'dislikes' },
        ],
        snippets: [{ field: 'toString', text: 'x' }, { field: '__proto__', text: 'y' }, { field: 'constructor', text: 'z' }, { field: 'notes', text: 'ok' }],
    })));
    assert.deepEqual(n.groups.map((g) => [g.name, g.target]), [['甲', 'likes'], ['乙', 'likes'], ['丙', 'dislikes']]);
    assert.deepEqual(n.snippets.map((x) => [x.field, x.text]), [['notes', 'ok']]);
    // 回到喜欢的分组在界面上看得见（能改名、删除），也不会占着名字让同名的新建失败
    const s = settings();
    s.profileLibrary = n;
    assert.deepEqual(libraryGroups(s, 'likes').filter((g) => !g.builtin).map((g) => g.name), ['甲', '乙']);
    assert.equal(addLibraryGroup(s, { name: '丁', target: '__proto__' }).target, 'likes');
    assert.equal(addLibraryGroup(s, { name: '戊', target: 'hasOwnProperty' }).target, 'likes');
    assert.throws(() => addProfileSnippet(s, 'toString', { text: 'x' }), /不认识的字段/);
    assert.throws(() => addProfileSnippet(s, '__proto__', { text: 'x' }), /不认识的字段/);
});

test('规整：自定义分组 / 尺度和内置的（包括以后新增的内置）或前面的重名时改名留下，标签、说明和 id 都不丢', () => {
    const n = normalizeProfileLibrary({
        groups: [
            { id: 'ugrp_x', name: '常见雷点', target: 'dislikes', tags: ['黑暗结局'] },
            { id: 'ugrp_y', name: '我的', tags: ['甲'] },
            { id: 'ugrp_z', name: '我的', tags: ['乙'] },
            { id: 'ugrp_w', name: '一二三四五六七八九十', tags: ['丙'] },
            { id: 'ugrp_v', name: '一二三四五六七八九十', tags: ['丁'] },
        ],
        intensities: [{ id: 'uint_a', name: '清水', desc: '我自己的清水' }, { id: 'uint_b', name: '慢热', desc: '一' }, { id: 'uint_c', name: '慢热', desc: '二' }],
    });
    assert.deepEqual(n.groups.map((g) => [g.id, g.name, g.tags]), [
        ['ugrp_x', '常见雷点2', ['黑暗结局']], ['ugrp_y', '我的', ['甲']], ['ugrp_z', '我的2', ['乙']],
        ['ugrp_w', '一二三四五六七八九十', ['丙']], ['ugrp_v', '一二三四五六七八九2', ['丁']],
    ]);
    assert.ok(n.groups.every((g) => g.name.length <= PROFILE_LIBRARY_LIMITS.groupName));
    assert.deepEqual(n.intensities.map((x) => [x.id, x.name, x.desc]), [['uint_a', '清水2', '我自己的清水'], ['uint_b', '慢热', '一'], ['uint_c', '慢热2', '二']]);
    // 用这个尺度的画像照样认得（不是 missing）
    const s = settings();
    s.profileLibrary = n;
    const info = intensityInfo('uint_a', s);
    assert.equal(info.custom, true);
    assert.equal(info.missing, undefined);
    assert.equal(info.card, '清水2——我自己的清水。');
    assert.deepEqual(libraryGroups(s, 'dislikes').map((g) => g.name), ['常见雷点', '常见雷点2']);
});

// ---------------- 标签分组 ----------------

test('标签分组：内置分组合并自定义标签、隐藏的内置标签不显示；加标签（一次多个、截短、这一类已有的跳过、隐藏的恢复、满了跳过）；删掉 / 隐藏 / 恢复默认', () => {
    const s = settings();
    const likes = () => libraryGroups(s, 'likes');
    assert.deepEqual(likes().map((g) => [g.id, g.name, g.builtin]), [['traits', '角色属性', true], ['looks', '外形与服饰', true], ['kinks', '癖好与偏好', true]]);
    assert.deepEqual(libraryGroups(s, 'dislikes').map((g) => g.id), ['nogo']);
    assert.deepEqual(likes()[0].items.map((i) => i.tag), USER_PROFILE_TAG_GROUPS[0].tags, '没有自定义时就是内置标签');
    const r = addLibraryTags(s, 'traits', '猫娘，狐娘、傲娇、黑丝；一二三四五六七八九十一二三');
    assert.deepEqual(r.added, ['猫娘', '狐娘', '一二三四五六七八九十一二']);
    assert.deepEqual(r.skipped, [{ tag: '傲娇', reason: '已经在「角色属性」里' }, { tag: '黑丝', reason: '已经在「外形与服饰」里' }]);
    const traits = likes()[0];
    assert.deepEqual(traits.items.slice(-3), [{ tag: '猫娘', builtin: false }, { tag: '狐娘', builtin: false }, { tag: '一二三四五六七八九十一二', builtin: false }]);
    assert.equal(traits.custom, 3);
    // 雷点那一类有的标签可以加进喜欢（两类各自独立）
    assert.deepEqual(addLibraryTags(s, 'kinks', ['NTR']).added, ['NTR']);
    assert.equal(libraryGroupOfTag(s, 'likes', ' ntr ').id, 'kinks');
    assert.equal(libraryGroupOfTag(s, 'dislikes', 'NTR').id, 'nogo');
    // 内置的隐藏、自定义的删掉；已经加进画像的标签不受影响
    const prof = addUserProfile(s, { name: '甲', likes: ['猫娘', '人妻'] });
    assert.equal(removeLibraryTag(s, 'traits', '人妻'), 'hidden');
    assert.equal(removeLibraryTag(s, 'traits', '人妻'), null, '已经隐藏了');
    assert.equal(removeLibraryTag(s, 'traits', '猫娘'), 'removed');
    assert.equal(removeLibraryTag(s, 'traits', '不存在'), null);
    assert.ok(!likes()[0].items.some((i) => i.tag === '人妻' || i.tag === '猫娘'));
    assert.deepEqual(likes()[0].hidden, ['人妻']);
    assert.deepEqual(getUserProfile(s, prof.id).likes, ['猫娘', '人妻'], '画像里的标签不动');
    // 隐藏的内置标签：往同一个分组里加就是恢复；「恢复默认」放回全部隐藏的
    removeLibraryTag(s, 'traits', '温柔');
    assert.deepEqual(addLibraryTags(s, 'traits', '人妻').restored, ['人妻']);
    assert.deepEqual(likes()[0].hidden, ['温柔']);
    assert.equal(restoreLibraryTags(s, 'traits'), 1);
    assert.equal(restoreLibraryTags(s, 'traits'), 0);
    assert.deepEqual(likes()[0].items.filter((i) => i.builtin).map((i) => i.tag), USER_PROFILE_TAG_GROUPS[0].tags, '恢复后内置标签按原来的顺序');
    assert.ok(likes()[0].items.some((i) => i.tag === '狐娘'), '恢复默认不删自定义的');
    // 每组最多 60 个自定义
    const res = addLibraryTags(s, 'looks', Array.from({ length: 65 }, (_, i) => `外形${i}`));
    assert.equal(res.added.length, PROFILE_LIBRARY_LIMITS.groupTags);
    assert.equal(res.skipped.length, 5);
    assert.match(res.skipped[0].reason, /最多存 60 个/);
    assert.throws(() => addLibraryTags(s, 'ugrp_nope', ['x']), /不存在/);
});

test('隐藏的内置标签不会在别的分组里多出一份：自己加的在原来的分组里恢复显示；导入的跳过；「恢复默认」与读的时候都去掉重复的', () => {
    const s = settings();
    const likesTags = () => libraryGroups(s, 'likes').flatMap((g) => g.items.map((i) => i.tag));
    const count = (t) => likesTags().filter((x) => x === t).length;
    // 隐藏了「角色属性」里的 傲娇，再往「外形与服饰」里加 傲娇：在「角色属性」里恢复显示，不在外形与服饰里存一份
    assert.equal(removeLibraryTag(s, 'traits', '傲娇'), 'hidden');
    assert.equal(count('傲娇'), 0);
    const r = addLibraryTags(s, 'looks', '傲娇');
    assert.deepEqual([r.added, r.restored, r.skipped], [[], ['傲娇'], []]);
    assert.equal(libraryGroupOfTag(s, 'likes', '傲娇').id, 'traits');
    assert.equal(count('傲娇'), 1);
    assert.deepEqual(libraryGroups(s, 'likes')[0].hidden, []);
    // 自定义分组也一样
    const g = addLibraryGroup(s, { name: '我的', target: 'likes' });
    removeLibraryTag(s, 'kinks', '慢热');
    assert.deepEqual(addLibraryTags(s, g.id, '慢热').restored, ['慢热']);
    assert.equal(count('慢热'), 1);
    // 导入（restoreHidden: false）：不替用户恢复隐藏的，跳过并说明原因
    removeLibraryTag(s, 'kinks', '慢热');
    const imp = addLibraryTags(s, g.id, ['慢热', '猫耳'], { restoreHidden: false });
    assert.deepEqual(imp.added, ['猫耳']);
    assert.deepEqual(imp.skipped, [{ tag: '慢热', reason: '是「癖好与偏好」里隐藏的内置标签（可以在那里恢复默认）' }]);
    assert.equal(count('慢热'), 0);
    const other = settings();
    const og = addLibraryGroup(other, { name: '我的', target: 'likes' });
    addLibraryTags(other, og.id, ['慢热', '猫耳']);
    const m = mergeProfileLibrary(s, exportProfileLibrary(other, { hidden: false }), { hidden: false });
    assert.equal(m.added.tags, 0, '导入的 慢热 是本机隐藏的内置标签：跳过；猫耳 已经有了');
    assert.deepEqual(libraryGroups(s, 'likes')[2].hidden, ['慢热'], '隐藏的选择不变');
    restoreLibraryTags(s, 'kinks');
    assert.equal(count('慢热'), 1, '恢复默认后只出现一次');
    // 旧数据 / 导入的数据里已经有重复（自定义分组里的标签正好是别的分组隐藏的内置标签）：恢复默认时去掉自定义的那份
    const d = settings();
    d.profileLibrary = { groups: [{ id: 'kinks', hidden: ['慢热'] }, { id: 'ugrp_m', name: '我的', tags: ['慢热', '猫耳'] }, { id: 'looks', tags: ['傲娇'] }] };
    const dl = () => libraryGroups(d, 'likes').flatMap((x) => x.items.map((i) => i.tag));
    assert.equal(dl().filter((t) => t === '慢热').length, 1, '隐藏时自定义分组里的那份照样显示');
    assert.equal(dl().filter((t) => t === '傲娇').length, 1, '读的时候：看得见的内置标签优先，重复的自定义标签不显示');
    assert.equal(libraryGroups(d, 'likes')[1].custom, 0);
    assert.equal(restoreLibraryTags(d, 'kinks'), 1);
    assert.deepEqual(d.profileLibrary.groups.find((x) => x.id === 'ugrp_m').tags, ['猫耳'], '恢复默认：自定义分组里重复的那份删掉');
    assert.equal(dl().filter((t) => t === '慢热').length, 1);
    assert.equal(libraryGroupOfTag(d, 'likes', '慢热').id, 'kinks');
    // 雷点那一类不受喜欢这一类隐藏的影响
    removeLibraryTag(d, 'traits', '强势');
    const dg = addLibraryGroup(d, { name: '我的雷点', target: 'dislikes' });
    assert.deepEqual(addLibraryTags(d, dg.id, '强势').added, ['强势']);
    assert.deepEqual(libraryGroups(d, 'likes')[0].hidden, ['强势']);
});

test('叙事偏好的常用写法：每项末尾的标点不算（和画像里存的一致），「多写对话。」就是「多写对话」；旧版带标点的内置写法认得出来', () => {
    const s = settings();
    assert.equal(tagKey('style', '多写对话。'), tagKey('style', '多写对话'));
    assert.notEqual(tagKey('likes', 'NTR!'), tagKey('likes', 'NTR'), '喜欢 / 雷点的标签照原样比较');
    const r = addLibraryTags(s, STYLE_GROUP_ID, '多写对话。，细腻心理。、短句！');
    assert.deepEqual(r.added, ['多写对话', '短句']);
    assert.deepEqual(r.skipped, [{ tag: '细腻心理', reason: '已经在「常用」里' }]);
    assert.deepEqual(addLibraryTags(s, STYLE_GROUP_ID, '多写对话').skipped.map((x) => x.tag), ['多写对话']);
    assert.equal(libraryGroupOfTag(s, 'style', '细腻心理。').id, STYLE_GROUP_ID);
    assert.equal(libraryGroupOfTag(s, 'style', '多写对话。').id, STYLE_GROUP_ID);
    // 画像里存的（joinStyleTags 去掉末尾标点）和常用写法里的是同一项
    const items = libraryGroups(s, 'style')[0].items.map((i) => i.tag);
    for (const t of styleTags(joinStyleTags(['多写对话。', '细腻心理。']))) assert.ok(items.includes(t), t);
    // 存着带标点的旧数据：规整时去掉，和内置的重复的合并
    const n = normalizeProfileLibrary({ style: { tags: ['多写对话。', '多写对话', '细腻心理。', '短句！'], hidden: ['文艺。'] } });
    assert.deepEqual(n.style, { tags: ['多写对话', '短句'], hidden: ['文艺'] });
    // 隐藏 / 删掉也认得带标点的写法
    assert.equal(removeLibraryTag(s, STYLE_GROUP_ID, '文艺。'), 'hidden');
    assert.deepEqual(libraryGroups(s, 'style')[0].hidden, ['文艺']);
    assert.equal(removeLibraryTag(s, STYLE_GROUP_ID, '多写对话。'), 'removed');
    assert.equal(libraryGroupOfTag(s, 'style', '多写对话'), null);
});

test('自定义分组：新建（名称必填、不能和内置或别的分组重名、最多 30 个、用在喜欢或雷点）、改名、删除（画像里的标签不受影响）', () => {
    const s = settings();
    assert.equal(libraryGroupNameProblem(s, '  '), '分组名称不能为空');
    assert.equal(libraryGroupNameProblem(s, '角色属性'), '已经有同名的分组');
    const a = addLibraryGroup(s, { name: '兽人', target: 'likes' });
    const b = addLibraryGroup(s, { name: '我的雷点', target: 'dislikes' });
    assert.match(a.id, /^ugrp_/);
    assert.throws(() => addLibraryGroup(s, { name: ' 兽 人 ' }), /同名/);
    assert.deepEqual(libraryGroups(s, 'likes').map((g) => g.name), ['角色属性', '外形与服饰', '癖好与偏好', '兽人']);
    assert.deepEqual(libraryGroups(s, 'dislikes').map((g) => g.name), ['常见雷点', '我的雷点']);
    addLibraryTags(s, a.id, ['狼人', '龙人']);
    addLibraryTags(s, b.id, '黑暗结局');
    assert.deepEqual(addLibraryTags(s, b.id, 'NTR').skipped, [{ tag: 'NTR', reason: '已经在「常见雷点」里' }]);
    assert.equal(libraryGroups(s, 'likes').at(-1).builtin, false);
    assert.deepEqual(libraryGroups(s, 'likes').at(-1).items, [{ tag: '狼人', builtin: false }, { tag: '龙人', builtin: false }]);
    renameLibraryGroup(s, a.id, '兽人控');
    assert.equal(libraryGroups(s, 'likes').at(-1).name, '兽人控');
    assert.throws(() => renameLibraryGroup(s, a.id, '我的雷点'), /同名/);
    assert.throws(() => renameLibraryGroup(s, 'traits', 'x'), /内置分组不能改名/);
    const prof = addUserProfile(s, { name: '甲', likes: ['狼人'], dislikes: ['黑暗结局'] });
    assert.equal(removeLibraryGroup(s, b.id).name, '我的雷点');
    assert.equal(removeLibraryGroup(s, b.id), null);
    assert.equal(removeLibraryGroup(s, 'nogo'), null, '内置分组不能删');
    assert.deepEqual(getUserProfile(s, prof.id).dislikes, ['黑暗结局'], '画像里的标签照样在');
    for (let i = libraryGroups(s, 'likes').filter((g) => !g.builtin).length; i < PROFILE_LIBRARY_LIMITS.groups; i++) addLibraryGroup(s, { name: `分组${i}` });
    assert.throws(() => addLibraryGroup(s, { name: '再来一个' }), /最多 30 个/);
});

// ---------------- 尺度 ----------------

test('自定义尺度：新建 / 修改 / 删除；名称不能为空、不能和内置或别的重名；说明必填；解析成与内置同样的字段；删掉后用它的画像改回默认', () => {
    const s = settings();
    assert.equal(intensityNameProblem(s, ''), '名称不能为空');
    assert.equal(intensityNameProblem(s, '清水'), '和内置的尺度重名');
    assert.throws(() => addCustomIntensity(s, { name: '重口', desc: '  ' }), /说明不能为空/);
    const x = addCustomIntensity(s, { name: '纯情慢热', desc: '感情慢慢升温，亲吻点到为止，不写性内容。' });
    assert.match(x.id, /^uint_/);
    assert.throws(() => addCustomIntensity(s, { name: '纯情慢热', desc: 'x' }), /同名/);
    assert.deepEqual(profileIntensities(s).map((i) => [i.label, i.custom]), [['清水', false], ['暧昧擦边', false], ['可以露骨', false], ['纯情慢热', true]]);
    const info = intensityInfo(x.id, s);
    assert.deepEqual(info, {
        value: x.id, label: '纯情慢热', desc: '感情慢慢升温，亲吻点到为止，不写性内容。', hint: '感情慢慢升温，亲吻点到为止，不写性内容。',
        card: '纯情慢热——感情慢慢升温，亲吻点到为止，不写性内容。', chat: '纯情慢热——感情慢慢升温，亲吻点到为止，不写性内容。',
        status: '纯情慢热——感情慢慢升温，亲吻点到为止，不写性内容', custom: true,
    });
    // 内置的照旧（status 是名字）；不认识的回到默认；自定义 id 没有 settings 或找不到时按默认并标 missing
    assert.equal(intensityInfo('sfw').card, USER_PROFILE_INTENSITIES[0].card);
    assert.equal(intensityInfo('sfw').status, '清水');
    assert.equal(intensityInfo('wild').value, 'suggestive');
    assert.equal(intensityInfo('wild').missing, undefined);
    assert.equal(intensityInfo('uint_gone', s).missing, true);
    assert.equal(intensityInfo('uint_gone', s).value, 'suggestive');
    // 画像存自定义尺度 id；摘要、表单说明用常用库里的名字
    const p = addUserProfile(s, { name: '甲', intensity: x.id });
    assert.equal(getUserProfile(s, p.id).intensity, x.id);
    assert.equal(normalizeUserProfile({ intensity: 'uint_whatever' }).intensity, 'uint_whatever', '规整画像时不检查自定义尺度在不在');
    assert.equal(userProfileSummary(getUserProfile(s, p.id), { settings: s }), '尺度 纯情慢热');
    assert.equal(userProfileFormNote(getUserProfile(s, p.id), true, false, false, s), '会按这个画像量身定制：尺度 纯情慢热。');
    // 修改
    updateCustomIntensity(s, x.id, { name: '慢热', desc: '慢慢来' });
    assert.equal(intensityInfo(x.id, s).card, '慢热——慢慢来。');
    assert.equal(intensityInfo(x.id, s).desc, '慢慢来', '说明是用户写的原文');
    assert.throws(() => updateCustomIntensity(s, x.id, { name: '清水' }), /重名/);
    assert.throws(() => updateCustomIntensity(s, 'uint_nope', { name: 'a', desc: 'b' }), /不存在/);
    // 删除：用它的画像改回默认
    const q = addUserProfile(s, { name: '乙', intensity: x.id });
    const r = removeCustomIntensity(s, x.id);
    assert.equal(r.removed.name, '慢热');
    assert.equal(r.profiles, 2);
    assert.equal(getUserProfile(s, p.id).intensity, 'suggestive');
    assert.equal(getUserProfile(s, q.id).intensity, 'suggestive');
    assert.deepEqual(removeCustomIntensity(s, x.id), { removed: null, profiles: 0 });
    // 导入的画像引用了不存在的自定义尺度：读的时候按默认（标 missing），快照按默认
    s.userProfiles.push({ id: 'uprof_ghost', name: '幽灵', intensity: 'uint_ghost' });
    const ghost = getUserProfile(s, 'uprof_ghost');
    assert.equal(profileIntensityInfo(ghost, s).missing, true);
    assert.equal(userProfileSnapshot(s, 'uprof_ghost').intensity, 'suggestive');
    assert.equal(userProfileSnapshot(s, 'uprof_ghost').intensityName, undefined);
    assert.equal(resolveIntensityId(s, 'uint_ghost'), 'suggestive');
    assert.equal(resolveIntensityId(s, 'explicit'), 'explicit');
    assert.equal(resolveIntensityId(s, 'nonsense'), 'suggestive');
});

test('自定义尺度写进提示词与条目：卡片快照带名称和说明；之后改名、删掉，已经生成的卡照样用快照里的；快照能看出画像改过', () => {
    const s = settings();
    const p0 = project();
    const x = addCustomIntensity(s, { name: '纯情慢热', desc: '感情慢慢升温，亲吻点到为止，不写性内容。' });
    const prof = addUserProfile(s, { ...FULL, intensity: x.id });
    const snap = userProfileSnapshot(s, prof.id);
    assert.equal(snap.intensity, x.id);
    assert.equal(snap.intensityName, '纯情慢热');
    assert.equal(snap.intensityDesc, '感情慢慢升温，亲吻点到为止，不写性内容。');
    assert.deepEqual(Object.keys(snap), ['id', 'name', 'likes', 'dislikes', 'intensity', 'intensityName', 'intensityDesc', 'persona', 'style', 'notes', 'orientations', 'chatEntry']);
    const LINE = '纯情慢热——感情慢慢升温，亲吻点到为止，不写性内容。';
    const block = userProfilePromptBlock(snap);
    assert.ok(block.includes(`\n- 尺度：${LINE}\n`), block);
    assert.ok(block.endsWith(`- ${USER_PROFILE_ADULT_LINE}`), '成年人一条照样是最后一条');
    assert.ok(userProfileEntryContent(snap).includes(`\n尺度：${LINE}\n`));
    assert.ok(userProfileEntryContent(snap).endsWith('所有涉及恋爱或亲密内容的人物（包括 {{user}}）都是成年人。'));
    assert.ok(userProfileStatusText(snap).includes('\n- 尺度：纯情慢热——感情慢慢升温，亲吻点到为止，不写性内容。变量名、desc 和 check 都不超出这个尺度。\n'));
    assert.ok(buildCardPrompt(p0, s, { kind: 'character', charName: '莉莉丝', timepoint: Infinity, userProfile: snap }).prompt.includes(`- 尺度：${LINE}`));
    const card = { id: 'c1', kind: 'character', charName: '莉莉丝', data: { name: '莉莉丝' }, userProfile: snap };
    ensureStatusBar(card, s);
    assert.ok(buildStatusSpecPrompt(p0, s, card).prompt.includes('- 尺度：纯情慢热——'));
    assert.ok(userProfileEntry(card).content.includes(LINE));
    assert.equal(userProfileSummary(snap), '喜欢 黑丝、足控、傲娇 · 雷点 NTR、血腥 · 尺度 纯情慢热 · 叙事 第二人称、细腻心理');
    assert.equal(userProfileSnapshotOutdated(s, snap), false);
    // 改了尺度的说明：快照还是旧的（提示词不变），但能看出画像（尺度）改过
    updateCustomIntensity(s, x.id, { desc: '更慢一点' });
    assert.equal(userProfileSnapshotOutdated(s, snap), true);
    assert.ok(userProfilePromptBlock(snap).includes(LINE));
    // 删掉这个尺度：卡上的快照照样能用；最新版本按默认尺度
    removeCustomIntensity(s, x.id);
    assert.deepEqual(normalizeCardUserProfile(snap), snap, '快照规整后不变');
    assert.ok(userProfilePromptBlock(snap).includes(LINE));
    assert.ok(cardExtraEntries(p0, s, card).find((e) => e.comment === '用户偏好').content.includes(LINE));
    assert.equal(userProfileSnapshot(s, prof.id).intensity, 'suggestive');
    assert.equal(userProfileSnapshotOutdated(s, snap), true);
    // 快照里只有 id 没有名称和说明（坏掉的快照）：按默认尺度
    const broken = normalizeCardUserProfile({ ...snap, intensityName: '', intensityDesc: '' });
    assert.equal(broken.intensity, 'suggestive');
    assert.equal(broken.intensityName, undefined);
    assert.ok(userProfilePromptBlock(broken).includes('- 尺度：暧昧擦边——'));
});

// ---------------- 没有自定义内容时一字不差 ----------------

test('常用库里有各种自定义内容、但画像只用内置的：快照、写卡 / 状态栏 / 本书落点提示词、「用户偏好」条目与空库时一字不差', () => {
    const plain = settings();
    const custom = settings();
    fillLibrary(custom);
    const p0 = project();
    for (const intensity of ['sfw', 'suggestive', 'explicit']) {
        const a = userProfileSnapshot(plain, addUserProfile(plain, { ...FULL, name: `甲${intensity}`, intensity }));
        const b = userProfileSnapshot(custom, addUserProfile(custom, { ...FULL, name: `甲${intensity}`, intensity }));
        assert.deepEqual({ ...b, id: '' }, { ...a, id: '' });
        assert.deepEqual(Object.keys(b), ['id', 'name', 'likes', 'dislikes', 'intensity', 'persona', 'style', 'notes', 'orientations', 'chatEntry'], '内置尺度的快照没有多出来的字段');
        assert.equal(userProfilePromptBlock(b), userProfilePromptBlock(a));
        assert.equal(userProfilePromptBlock(b, { original: true }), userProfilePromptBlock(a, { original: true }));
        assert.equal(userProfileStatusText(b), userProfileStatusText(a));
        assert.equal(userProfileEntryContent(b), userProfileEntryContent(a));
        assert.equal(userProfileNotesLines(b), userProfileNotesLines(a));
        const opt = { kind: 'character', charName: '莉莉丝', timepoint: Infinity };
        assert.equal(buildCardPrompt(p0, custom, { ...opt, userProfile: b }).prompt, buildCardPrompt(p0, plain, { ...opt, userProfile: a }).prompt);
        assert.equal(buildCardPrompt(p0, custom, opt).prompt, buildCardPrompt(p0, plain, opt).prompt, '不选画像时也一样');
        const ntl = orientationFromPick(plain, { id: 'orient_ntl', refine: true });
        const ca = { id: 'c', kind: 'character', charName: '莉莉丝', data: { name: '莉莉丝', description: 'd' }, orientation: ntl, userProfile: a };
        const cb = { ...ca, userProfile: b };
        assert.equal(buildOrientationNotesPrompt(p0, custom, cb).prompt, buildOrientationNotesPrompt(p0, plain, ca).prompt);
        ensureStatusBar(ca, plain);
        ensureStatusBar(cb, custom);
        assert.equal(buildStatusSpecPrompt(p0, custom, cb).prompt, buildStatusSpecPrompt(p0, plain, ca).prompt);
        assert.equal(userProfileSummary(getUserProfile(custom, b.id), { settings: custom }), userProfileSummary(getUserProfile(plain, a.id), { settings: plain }));
    }
    // 逐字核对一处（与 v0.16.0 相同）
    const snap = userProfileSnapshot(custom, addUserProfile(custom, { ...FULL, name: '核对' }));
    assert.equal(userProfileEntryContent(snap), [
        '【用户偏好】',
        '聊天时照顾 {{user}} 的偏好：黑丝、足控、傲娇。在合适的时候自然地带出来（角色的穿着、小动作、对话和场景），不要每次回复都提，也不要生硬堆砌。',
        '绝对避免：NTR、血腥。不写这些内容，也不把剧情往这些方向引。',
        '尺度：暧昧擦边——可以暧昧、调情，有身体接触的张力，点到为止，不写露骨的性描写。',
        '叙事偏好：第二人称、细腻心理。',
        '所有涉及恋爱或亲密内容的人物（包括 {{user}}）都是成年人。',
    ].join('\n'));
});

// ---------------- 叙事偏好 ----------------

test('叙事偏好：字符串 ↔ 一项一项（按 、/，/,/； 拆开，去重，不截短旧的长句）；导入的数组用「、」连起来；内置建议 + 自定义建议 + 隐藏', () => {
    assert.deepEqual(styleTags('第二人称，细腻心理、 节奏快,第二人称'), ['第二人称', '细腻心理', '节奏快']);
    const legacy = '用第二人称写，多写心理活动和环境描写，不要写太多对话，节奏慢一点。';
    assert.deepEqual(styleTags(legacy), ['用第二人称写', '多写心理活动和环境描写', '不要写太多对话', '节奏慢一点。']);
    assert.deepEqual(styleTags('一整句很长很长的旧版叙事偏好没有任何逗号也照样保留不截短'), ['一整句很长很长的旧版叙事偏好没有任何逗号也照样保留不截短']);
    assert.deepEqual(styleTags(''), []);
    assert.equal(joinStyleTags(['第二人称。', '细腻心理', '', '第二人称']), '第二人称、细腻心理');
    assert.equal(joinStyleTags(styleTags(legacy)), '用第二人称写、多写心理活动和环境描写、不要写太多对话、节奏慢一点');
    // 画像里存的仍然是字符串：旧的自由文字原样保留（没动过就一字不差），数组（导入的文件）连起来
    assert.equal(normalizeUserProfile({ style: legacy }).style, legacy);
    assert.equal(normalizeUserProfile({ style: ['第二人称', '对话多'] }).style, '第二人称、对话多');
    assert.ok(userProfilePromptBlock({ name: 'x', style: joinStyleTags(['第二人称', '对话多']) }).includes('- 叙事偏好：第二人称、对话多。开场白'));
    assert.ok(userProfileEntryContent({ name: 'x', style: ['第二人称', '对话多'] }).includes('\n叙事偏好：第二人称、对话多。\n'));
    // 建议
    const s = settings();
    const g = () => libraryGroups(s, 'style')[0];
    assert.deepEqual(g().items.map((i) => i.tag), USER_PROFILE_STYLE_SUGGESTIONS);
    assert.equal(g().id, STYLE_GROUP_ID);
    const r = addLibraryTags(s, STYLE_GROUP_ID, '多写环境和感官细节，第二人称，一二三四五六七八九十一二三四五六七八九十一');
    assert.deepEqual(r.added, ['多写环境和感官细节', '一二三四五六七八九十一二三四五六七八九十'], '每项最多 20 字');
    assert.deepEqual(r.skipped, [{ tag: '第二人称', reason: '已经在「常用」里' }]);
    assert.equal(removeLibraryTag(s, STYLE_GROUP_ID, '文艺'), 'hidden');
    assert.ok(!g().items.some((i) => i.tag === '文艺'));
    assert.deepEqual(g().hidden, ['文艺']);
    assert.equal(removeLibraryTag(s, STYLE_GROUP_ID, '多写环境和感官细节'), 'removed');
    assert.equal(restoreLibraryTags(s, STYLE_GROUP_ID), 1);
    assert.ok(g().items.some((i) => i.tag === '文艺'));
    assert.equal(libraryGroupOfTag(s, 'style', '第二人称').id, STYLE_GROUP_ID);
});

// ---------------- 常用文字 ----------------

test('常用文字：按字段（形象 / 其他）存；名称为空时取第一行、同名自动编号；一样的文字不重复存；上限；删除', () => {
    const s = settings();
    const a = addProfileSnippet(s, 'persona', { name: '上班族', text: '  二十五岁的男性上班族\n个子高  ' });
    assert.deepEqual([a.field, a.name, a.text], ['persona', '上班族', '二十五岁的男性上班族\n个子高']);
    const b = addProfileSnippet(s, 'persona', { name: '上班族', text: '三十岁的上班族' });
    assert.equal(b.name, '上班族 2');
    assert.equal(addProfileSnippet(s, 'notes', { text: '喜欢有来有回的斗嘴，角色别太快动心' }).name, '喜欢有来有回的斗嘴，角色…');
    assert.throws(() => addProfileSnippet(s, 'persona', { text: '二十五岁的男性上班族\n个子高' }), /已经存过了（「上班族」）/);
    assert.throws(() => addProfileSnippet(s, 'persona', { text: '   ' }), /内容是空的/);
    assert.throws(() => addProfileSnippet(s, 'style', { text: 'x' }), /不认识的字段/);
    assert.deepEqual(profileSnippets(s, 'persona').map((x) => x.name), ['上班族', '上班族 2']);
    assert.equal(profileSnippets(s, 'notes').length, 1);
    assert.equal(removeProfileSnippet(s, a.id), true);
    assert.equal(removeProfileSnippet(s, a.id), false);
    assert.deepEqual(profileSnippets(s, 'persona').map((x) => x.name), ['上班族 2']);
    for (let i = profileSnippets(s, 'notes').length; i < PROFILE_LIBRARY_LIMITS.snippets; i++) addProfileSnippet(s, 'notes', { text: `第 ${i} 段` });
    assert.throws(() => addProfileSnippet(s, 'notes', { text: '再来一段' }), /最多存 50 段/);
    assert.equal(addProfileSnippet(s, 'persona', { text: 'persona 不受 notes 的上限影响' }).field, 'persona');
});

// ---------------- 导入导出 ----------------

test('画像导出：画像用到的自定义尺度总是带上；选了「连同常用库」时带上整个库（不带隐藏的内置标签）；没有自定义内容时和以前一样', () => {
    const s = settings();
    const plainFile = exportUserProfiles(s, [getUserProfile(s, addUserProfile(s, FULL).id)]);
    assert.deepEqual(Object.keys(plainFile), ['type', 'version', 'profiles'], '没有自定义内容时没有 library');
    assert.deepEqual(Object.keys(exportUserProfiles(s, [getUserProfile(s, s.userProfiles[0].id)], { library: true })), ['type', 'version', 'profiles'], '库是空的时也没有');
    const g = fillLibrary(s);
    const x = profileIntensities(s).find((i) => i.custom);
    const prof = getUserProfile(s, addUserProfile(s, { ...FULL, name: '用自定义尺度', intensity: x.value }).id);
    const only = exportUserProfiles(s, [prof]);
    assert.deepEqual(only.library, { intensities: [{ id: x.value, name: '纯情慢热', desc: '感情慢慢升温，亲吻点到为止，不写性内容。' }] });
    assert.equal(only.profiles[0].intensity, x.value);
    const all = exportUserProfiles(s, [prof], { library: true });
    assert.deepEqual(all.library.groups, [{ id: 'traits', tags: ['猫娘', '狐娘'] }, { id: g.id, name: '我的雷点', target: 'dislikes', tags: ['黑暗结局', '鬼畜'] }], '不带隐藏的内置标签');
    assert.deepEqual(all.library.style, { tags: ['多写环境', '短句'], hidden: [] });
    assert.equal(all.library.snippets.length, 2);
    assert.equal(all.library.intensities.length, 1);
    // 整个库（配置里用）带隐藏的
    const full = exportProfileLibrary(s);
    assert.deepEqual(full.groups[0], { id: 'traits', tags: ['猫娘', '狐娘'], hidden: ['人妻'] });
    assert.deepEqual(full.style.hidden, ['文艺']);
    const c = profileLibraryCounts(s);
    assert.deepEqual([c.tags, c.groups, c.hidden, c.intensities, c.styleTags, c.snippets, c.total], [4, 1, 2, 1, 2, 2, 10]);
    // 删掉的自定义尺度：导出时按默认
    s.userProfiles.push({ id: 'uprof_ghost', name: '幽灵', intensity: 'uint_ghost' });
    const ghost = exportUserProfiles(s, [getUserProfile(s, 'uprof_ghost')]);
    assert.equal(ghost.profiles[0].intensity, 'suggestive');
    assert.equal(ghost.library, undefined);
});

test('画像导入：导入到干净的设置里，常用库合并进来、自定义尺度换成本机 id；再导入一次不重复；同名的尺度和分组合并；不替你隐藏内置标签', () => {
    const src = settings();
    const g = fillLibrary(src);
    const x = profileIntensities(src).find((i) => i.custom);
    const prof = getUserProfile(src, addUserProfile(src, { ...FULL, name: '用自定义尺度', intensity: x.value, likes: ['猫娘', '黑丝'] }).id);
    const file = JSON.stringify(exportUserProfiles(src, [prof], { library: true }));

    const dst = settings();
    const r = importUserProfileFile(dst, file);
    assert.equal(r.profiles.length, 1);
    assert.deepEqual(r.library, { tags: 4, groups: 1, intensities: 1, styleTags: 2, snippets: 2, hidden: 0 });
    assert.equal(libraryMergeSummary(r.library), '标签 4 个、分组 1 个、尺度 1 个、叙事偏好 2 个、常用文字 2 段');
    const imported = getUserProfile(dst, r.profiles[0].id);
    assert.equal(imported.intensity, x.value, '本机没有这个 id：沿用');
    assert.equal(intensityInfo(imported.intensity, dst).label, '纯情慢热');
    assert.deepEqual(libraryGroups(dst, 'likes')[0].items.slice(-2).map((i) => i.tag), ['猫娘', '狐娘']);
    assert.ok(libraryGroups(dst, 'likes')[0].items.some((i) => i.tag === '人妻'), '导入画像不隐藏本机的内置标签');
    assert.deepEqual(libraryGroups(dst, 'dislikes').at(-1).items.map((i) => i.tag), ['黑暗结局', '鬼畜']);
    assert.equal(libraryGroups(dst, 'dislikes').at(-1).id, g.id);
    assert.equal(profileSnippets(dst, 'persona').length, 1);
    assert.ok(userProfilePromptBlock(userProfileSnapshot(dst, imported.id)).includes('- 尺度：纯情慢热——'));
    // 再导入一次：画像改名，常用库不重复
    const again = importUserProfileFile(dst, file);
    assert.equal(again.profiles[0].name, '用自定义尺度 2');
    assert.deepEqual(again.library, { tags: 0, groups: 0, intensities: 0, styleTags: 0, snippets: 0, hidden: 0 });
    assert.equal(libraryMergeSummary(again.library), '');
    assert.equal(profileIntensities(dst).filter((i) => i.custom).length, 1);
    assert.equal(libraryGroups(dst, 'dislikes').length, 2);
    // 另一台电脑上已经有同名的尺度和分组（不同 id）：合并到本机的，画像用本机的 id
    const other = settings();
    const mine = addCustomIntensity(other, { name: '纯情慢热', desc: '本机自己的说明' });
    const myGroup = addLibraryGroup(other, { name: '我的雷点', target: 'dislikes' });
    const r3 = importUserProfileFile(other, file);
    assert.equal(getUserProfile(other, r3.profiles[0].id).intensity, mine.id);
    assert.equal(intensityInfo(mine.id, other).desc, '本机自己的说明', '本机的说明不被覆盖');
    assert.deepEqual(libraryGroups(other, 'dislikes').map((x2) => x2.id), ['nogo', myGroup.id]);
    assert.deepEqual(libraryGroups(other, 'dislikes')[1].items.map((i) => i.tag), ['黑暗结局', '鬼畜']);
    // 只带了用到的尺度（没勾「连同常用库」）的文件：尺度照样认得
    const third = settings();
    const r4 = importUserProfileFile(third, exportUserProfiles(src, [prof]));
    assert.equal(intensityInfo(getUserProfile(third, r4.profiles[0].id).intensity, third).label, '纯情慢热');
    assert.equal(libraryGroups(third, 'dislikes').length, 1, '没带库的其他部分');
    // 文件里的自定义尺度认不出来（没有 library）：按默认
    const bare = settings();
    const r5 = importUserProfileFile(bare, { profiles: [{ name: '孤儿', intensity: 'uint_lost' }] });
    assert.equal(getUserProfile(bare, r5.profiles[0].id).intensity, 'suggestive');
    assert.equal(r5.library, null);
});

test('导入配置（applyConfig）：常用库合并（含隐藏的内置标签）、自定义尺度按 id 合并并更新、画像的尺度跟着换；导出配置带上常用库；配置里没有这一项时不动', () => {
    const src = settings();
    fillLibrary(src);
    const x = profileIntensities(src).find((i) => i.custom);
    addUserProfile(src, { ...FULL, intensity: x.value });
    const config = JSON.parse(JSON.stringify({ type: 'novel_loom_config', settings: src }));
    assert.ok(config.settings.profileLibrary.intensities.length === 1, '配置导出（整个设置）带常用库');

    const dst = settings();
    addLibraryTags(dst, 'looks', ['本机的标签']);
    applyConfig(dst, config);
    assert.deepEqual(libraryGroups(dst, 'likes')[0].hidden, ['人妻'], '导入配置时隐藏的内置标签也合并');
    assert.deepEqual(libraryGroups(dst, 'style')[0].hidden, ['文艺']);
    assert.ok(libraryGroups(dst, 'likes')[1].items.some((i) => i.tag === '本机的标签'), '本机的自定义标签还在');
    assert.ok(libraryGroups(dst, 'likes')[0].items.some((i) => i.tag === '猫娘'));
    const p = dst.userProfiles.find((q) => q.name === '足控党');
    assert.equal(p.intensity, x.value);
    assert.equal(intensityInfo(p.intensity, dst).label, '纯情慢热');
    // 同 id 的尺度：导入配置以导入的为准
    const cfg2 = structuredClone(config);
    cfg2.settings.profileLibrary.intensities[0].desc = '新的说明';
    applyConfig(dst, cfg2);
    assert.equal(intensityInfo(x.value, dst).desc, '新的说明');
    assert.equal(profileIntensities(dst).filter((i) => i.custom).length, 1);
    assert.equal(profileSnippets(dst, 'persona').length, 1, '常用文字不重复');
    // 配置里没有常用库：不动
    const before = JSON.stringify(dst.profileLibrary);
    applyConfig(dst, { type: 'novel_loom_config', settings: { cards: { creator: 'x' } } });
    assert.equal(JSON.stringify(dst.profileLibrary), before);
    // 配置里的画像用了自定义尺度、配置里却没有这个尺度：按默认
    applyConfig(dst, { userProfiles: [{ id: 'uprof_lost', name: '孤儿', intensity: 'uint_lost' }] });
    assert.equal(dst.userProfiles.find((q) => q.id === 'uprof_lost').intensity, 'suggestive');
    // mergeProfileLibrary 直接用：不合并隐藏时本机的内置标签都还在
    const d2 = settings();
    mergeProfileLibrary(d2, src.profileLibrary, { hidden: false });
    assert.deepEqual(libraryGroups(d2, 'likes')[0].hidden, []);
});

// ---------------- 安全 ----------------

test('内置的标签、叙事偏好建议和尺度里没有未成年属性的词；自定义的内容不改变成年人一条', () => {
    const builtin = [
        ...USER_PROFILE_TAG_GROUPS.flatMap((g) => [g.name, ...g.tags]),
        ...USER_PROFILE_STYLE_SUGGESTIONS,
        ...USER_PROFILE_INTENSITIES.flatMap((x) => [x.label, x.hint, x.card, x.chat]),
    ];
    for (const bad of ['萝莉', '正太', '幼', '小学', '初中', '中学生', '未成年', '童', '学生妹', 'loli', 'shota']) {
        assert.ok(!builtin.some((t) => t.toLowerCase().includes(bad)), bad);
    }
    assert.ok(USER_PROFILE_STYLE_SUGGESTIONS.every((t) => t.length <= PROFILE_LIBRARY_LIMITS.styleTag));
    // 用户自己加的尺度说明照样写进去，成年人一条仍然是最后一条，原样不变
    const s = settings();
    const x = addCustomIntensity(s, { name: '随便写', desc: '什么都可以写。' });
    const snap = userProfileSnapshot(s, addUserProfile(s, { name: '甲', intensity: x.id, persona: '十六岁' }));
    const block = userProfilePromptBlock(snap);
    assert.ok(block.endsWith(`- ${USER_PROFILE_ADULT_LINE}`));
    assert.ok(userProfilePromptBlock(snap, { original: true }).includes('所有涉及恋爱或亲密内容的人物（包括 {{user}}）都是成年人（18 岁以上）：设定里'));
    for (const t of [userProfileStatusText(snap), userProfileEntryContent(snap), userProfileNotesLines(snap)]) assert.ok(t.includes('所有涉及恋爱或亲密内容的人物（包括 {{user}}）都是成年人'), t);
    // 画像的其他字段不受库影响
    updateUserProfile(s, s.userProfiles[0].id, { likes: ['猫娘'] });
    assert.deepEqual(getUserProfile(s, s.userProfiles[0].id).likes, ['猫娘']);
});
