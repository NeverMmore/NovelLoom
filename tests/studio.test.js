// 创意工坊（v0.18）：构思草稿的规整与上限（成年人、人数、阶段、文字长度）、项目里的保存与导入；大纲的解析与部分重新生成（锁定的角色保留）；
// 角色细节的解析（好感、秘密、立绘提示词）与只重写一项；开场白 / 示例对话的解析；逐个生成的进度、出错隔离与停止；
// 组装世界卡（字段、开场白顺序、作者备注、本卡世界书条目、秘密的说明、故事阶段）、存进项目（手动角色 / 条目、撞名、改名、删掉不用的）、
// 「更新卡片」沿用同一张卡；写入酒馆；提示词（用户画像 / 卡的导向 / {{user}} 的身份 / 成年人）、消息链回退、设置与导入配置、状态栏预填主要角色
import test from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_CATEGORIES, DEFAULT_SETTINGS } from '../src/constants.js';
import { mergeDefaults } from '../src/utils.js';
import { createEmptyProject, createProject, mergeCharacter, normalizeProject, renameCharacter } from '../src/project.js';
import { CHAIN_TASKS, getChain } from '../src/llm.js';
import { DEFAULT_PROMPTS, PROMPT_LABELS, PROMPT_PLACEHOLDERS, getPrompt } from '../src/prompts.js';
import { applyConfig, parseTask } from '../src/io.js';
import { cardOwnWorld, prepareCard, publishCard } from '../src/publish.js';
import { cardPromptOpt, buildCardPrompt } from '../src/cards.js';
import { isOriginalCard, originalCastNames } from '../src/original.js';
import { addUserProfile } from '../src/userprofile.js';
import { ensureStatusBar, normalizeStatusSpec, statusBarCharName, worldCastNames } from '../src/statusbar.js';
import { applyStatusBarTemplate, getStatusBarTemplate } from '../src/statusbar-templates.js';
import {
    STUDIO_LIMITS, STUDIO_SOURCE, addStudio, adultAge, adultText, applyCharacterResult, assembleStudioCard, buildCharacterPrompt, buildExamplePrompt, buildOpenerPrompt,
    buildOutlinePrompt, buildStudioCard, castAgeText, createStudio, generateCharacterDetails, generateOpeners, generateOutline, generateStudioContent,
    generateStudioStatusBar, getStudio, normalizeDetails, normalizePortraitPrompt, normalizeStudio, normalizeStudioOptions, outlineRerollImpact,
    parseStudioCharacter, parseStudioExample, parseStudioOpener, parseStudioOutline, premiseCastCount, removeStudio, renameStudio, rerollCharacterField,
    rerollOpener, studioAddCast, studioAddStage, studioCardProblem, studioCardSummary, studioCastStatus, studioMoveStage, studioOwnEntries,
    studioPortraitPromptsText, studioProgress, studioProjectName, studioRemoveCast, studioSavePlan, studioStatusBarTemplateId, studioStepEnabled,
    studioTitleFromPremise, updateStudio, studioOutlineTouched, studioRemoveStage, studioCardStale, studioCardContentKey, studioRenameCastPatch,
} from '../src/studio.js';

const ADULT = '所有涉及恋爱或亲密内容的人物（包括 {{user}}）都是成年人';
const PREMISE = '我想做一张飞机失事，在荒岛上和7个美女共同求生的故事';
const NAMES = ['林晚', '苏晴', '许若', '陈曦', '周岚', '叶棠', '顾青'];

function settings() {
    const s = mergeDefaults({}, DEFAULT_SETTINGS);
    s.categories = structuredClone(DEFAULT_CATEGORIES);
    s.api.retries = 0;
    s.api.retryBaseMs = 500;
    s.antiTruncate.enabled = false;
    return s;
}

/** 模拟酒馆当前连接：handler(text, n) 按提示词里的标记回复（n = 第几次请求） */
function installTavern(handler, seen = []) {
    globalThis.SillyTavern = {
        getContext: () => ({
            async generateRaw({ prompt }) {
                const text = prompt.map((m) => m.content).join('\n').replace(/​/g, '');
                seen.push(text);
                return typeof handler === 'function' ? handler(text, seen.length) : handler;
            },
            stopGeneration() {},
        }),
    };
    return seen;
}

function outlineReply({ names = NAMES, stages = 3, extra = {} } = {}) {
    return {
        title: '荒岛七日',
        logline: '一架航班坠落在无名岛，{{user}} 和七位幸存者要撑到救援到来。',
        world: {
            setting: '时代: 现代\n地点: 南太平洋的无名火山岛',
            rules: '淡水只有岛中央的一处泉眼\n夜里涨潮会淹没南滩',
            tone: '紧张里带着暧昧',
            locations: [{ name: '坠机残骸', desc: '断成两截的机身，白天当仓库' }, { name: '淡水潭', desc: '岛中央的泉眼' }],
        },
        user_role: '{{user}} 是同机的退伍军医，众人里唯一懂急救的人。',
        cast: names.map((n, i) => ({ name: n, aliases: i === 0 ? ['晚晚'] : [], gender: '女', age: String(22 + i), identity: '空乘', one_liner: `性格${i}`, tags: ['可靠'] })),
        stages: [
            { name: '坠机', time: '第 1 天', summary: '残骸起火，众人四散。', conflict: '谁来带头' },
            { name: '求生', time: '第 2-7 天', summary: '分工找水找食物。', conflict: '淡水不够' },
            { name: '获救', time: '第 30 天', summary: '远处出现船影。', conflict: '有人不想走' },
        ].slice(0, stages),
        ...extra,
    };
}

function characterReply(name) {
    return {
        appearance: `${name}：短发，左眉有疤`,
        outfit: '撕破的制服',
        personality: '底色: 冷静\n- 遇到危险先数人头',
        speech: '句子短，叫 {{user}}「医生」',
        sample_lines: ['“先止血。”', '「别慌」', '- 水留给伤员'],
        background: '- 十年空乘\n- 经历过一次迫降',
        relation_to_user: '同机乘客，起初只当他是麻烦',
        affection: [{ level: 1, label: '戒备', behavior: '保持距离' }, { level: 2, label: '熟悉', behavior: '会分水给他' }, '信任：把伤口交给他处理', { label: '依恋', behavior: '夜里守在他旁边' }],
        secret: { content: '她偷藏了一部卫星电话', hints: ['常独自去海边', '口袋鼓着'], reveal: '好感到信任以上，或第 3 阶段' },
        portrait_prompt: `woman, teen, short hair, ${name}, school uniform, scar`,
    };
}

/** 模拟 AI：按提示词里的标记回复大纲 / 角色 / 开场白 / 示例对话 */
function studioAI({ outline = outlineReply(), failChar = '', openerText = null } = {}) {
    return (text) => {
        if (text.includes('设计群像故事大纲')) return JSON.stringify(outline);
        if (text.includes('展开角色细节')) {
            const name = text.match(/展开角色「(.+?)」的细节/)?.[1] || '';
            if (failChar && name === failChar) return '我拒绝';
            return JSON.stringify(characterReply(name));
        }
        if (text.includes('写这一阶段的开场白')) {
            const label = text.match(/的(第 \d+ 阶段「.+?」)写一段开场白/)?.[1] || '';
            return openerText ?? `\`\`\`\n开场白：\n${label}：海浪拍上沙滩，林晚把急救包推过来：“你是医生？”\n\`\`\``;
        }
        if (text.includes('写示例对话')) return '好的：\n<START>\n{{user}}: 水呢？\n荒岛七日：林晚：“在潭边。”';
        return '{}';
    };
}

async function fullStudio(s = settings(), p = createEmptyProject({ name: '荒岛' }), init = {}) {
    const st = addStudio(p, s, { premise: PREMISE, ...init });
    installTavern(studioAI());
    try {
        await generateOutline(p, s, st);
        await generateStudioContent(p, s, st);
    } finally {
        delete globalThis.SillyTavern;
    }
    return { s, p, st };
}

// ---------------- 草稿的规整 ----------------

test('成年人：年龄小于 18 的改成 18 岁并提示；中文数字照常；外表 / 看起来像未成年的只留成年的数字；空着时写成「成年」；身份里的学生说法换掉', () => {
    const w = [];
    assert.equal(adultAge('16', { name: '许若', warnings: w }), '18 岁');
    assert.equal(adultAge('十六岁', { warnings: w }), '18 岁');
    assert.equal(adultAge('未成年', { warnings: w }), '18 岁');
    assert.equal(w.length, 3);
    assert.match(w[0], /「许若」的年龄写成了「16」，已改成 18 岁/);
    assert.equal(adultAge('24'), '24 岁');
    assert.equal(adultAge('二十出头'), '二十出头');
    assert.equal(adultAge(''), '');
    assert.equal(castAgeText({ age: '' }), '成年');
    // 约数取前面的数、「未满 18」这类上限说法、没写数字的少女 / teen / 古称都改成 18 岁；「三千岁」「18 岁以上」照常
    for (const a of ['十七八岁', '未满18岁', '18 岁以下', '不到 18', '少女', 'teen', '高三学生', '及笄之年', '豆蔻年华']) {
        const ws = [];
        assert.equal(adultAge(a, { warnings: ws }), '18 岁', a);
        assert.equal(ws.length, 1, a);
    }
    for (const a of ['二十七八岁', '三千岁', '18 岁以上', '一直18岁']) {
        const ws = [];
        assert.equal(adultAge(a, { warnings: ws }), a, a);
        assert.deepEqual(ws, [], a);
    }
    // 「千年萝莉」写法：同时写了成年的数字和未成年的外表 / 说法——只留成年的数字（或「成年」），并提示
    for (const [a, to] of [['1500岁，外表12岁', '1500 岁'], ['看起来像初中生，实际25岁', '25 岁'], ['看着像高中生，实际 25 岁', '25 岁'], ['千岁萝莉', '1000 岁'], ['外表像少女，实际已成年', '成年'], ['看起来不到20，实际25', '25 岁']]) {
        const ws = [];
        assert.equal(adultAge(a, { name: '甲', warnings: ws }), to, a);
        assert.equal(ws.length, 1, a);
        assert.ok(ws[0].includes(`「${a}」`), ws[0]);
    }
    // 旧版本存下的年龄（没经过新的规整）写进提示词和卡片时也一样
    assert.equal(castAgeText({ age: '1500岁，外表12岁' }), '1500 岁');
    assert.equal(castAgeText({ age: '千岁萝莉' }), '1000 岁');
    assert.equal(castAgeText({ age: '豆蔻年华' }), '18 岁');
    // 没写数字、也没写明成年的年龄，写进提示词和卡片时前面加上「成年」
    assert.equal(castAgeText({ age: '年龄不详' }), '成年（年龄不详）');
    assert.equal(castAgeText({ age: '二十出头' }), '二十出头');
    assert.equal(castAgeText({ age: '16' }), '18 岁');
    // 只写了上限（没说下限）的也加上「成年」；写明成年的不加
    assert.equal(castAgeText({ age: '30 岁以下' }), '成年（30 岁以下）');
    assert.equal(castAgeText({ age: '成年，30 岁以下' }), '成年，30 岁以下');
    assert.equal(castAgeText({ age: '25' }), '25');
    assert.equal(adultText('高三学生，身高一米七'), '大学生，身高一米七');
    // 学生说法：性别字在中间、年级、「新生」也认；成年人的身份（「高中生物老师」「高中老师」）不动
    for (const t of ['女高中生', '高中生', '初中女生', '高中女生', '中学女生', '小学女生', '高一新生', '国三生', '国中女生', '女子高生']) {
        const ws = [];
        assert.equal(adultText(t, { warnings: ws }), '大学生', t);
        assert.equal(ws.length, 1, t);
    }
    for (const t of ['高中生物老师', '初中生物老师', '中学生物教研组长', '高中生活回忆', '高中老师', '身高一米七', '中学教师', '幼儿园老师', '高中学历']) {
        const ws = [];
        assert.equal(adultText(t, { warnings: ws }), t, t);
        assert.deepEqual(ws, [], t);
    }
    assert.equal(adultText('外表是个初中女生'), '外表是个大学生');
    for (const t of ['小萝莉', '正太', '合法萝莉']) {
        const ws = [];
        const out = adultText(t, { warnings: ws });
        assert.ok(out && !/萝莉|正太/.test(out) && ws.length === 1, `${t} → ${out}`);
    }
    assert.equal(adultText('JK制服爱好者'), '制服爱好者');
    assert.equal(adultText('萝莉控大叔'), '大叔');
    const warnings = [];
    const st = normalizeStudio({ outline: { cast: [{ name: '陈曦', age: 15, identity: '女高中生', one_liner: '班上的萝莉', tags: ['JK', '学霸', '高中女生'] }] } });
    const m = st.outline.cast[0];
    assert.equal(m.age, '18 岁');
    assert.equal(m.identity, '大学生');
    assert.ok(!/萝莉/.test(m.oneLiner));
    assert.deepEqual(m.tags, ['学霸'], '带未成年说法的标签整个去掉');
    // 解析 AI 的大纲时记下提示
    const r = parseStudioOutline(outlineReply({ names: ['甲', '乙'] , extra: { cast: [{ name: '甲', age: '17', identity: '高中生' }, { name: '乙', age: '30' }] } }));
    assert.deepEqual(r.outline.cast.map((c) => [c.name, c.age, c.identity]), [['甲', '18 岁', '大学生'], ['乙', '30 岁', '']]);
    assert.ok(r.warnings.some((x) => x.includes('「甲」的年龄')) && r.warnings.some((x) => x.includes('「甲」的身份')));
    assert.deepEqual(warnings, []);
    // 「1500 岁，外表 12 岁」：解析大纲时只留成年的数字并提示；写进提示词和世界书的都没有「外表 12 岁」
    const loli = parseStudioOutline(outlineReply({ extra: { cast: [{ name: '甲', age: '1500岁，外表12岁', identity: '初中女生' }, { name: '乙', age: '30' }] } }));
    assert.equal(loli.outline.cast[0].age, '1500 岁');
    assert.ok(loli.warnings.some((x) => x.includes('「甲」的年龄写成了「1500岁，外表12岁」')));
    const p = createEmptyProject({ name: 'x' });
    const s = settings();
    const sd = addStudio(p, s, { premise: PREMISE });
    sd.outline = loli.outline;
    sd.outline.cast[0].age = '1500岁，外表12岁'; // 旧数据：没规整过
    const cp = buildCharacterPrompt(p, s, sd, sd.outline.cast[1].id).prompt;
    assert.ok(!cp.includes('外表12岁') && cp.includes('甲（1500 岁'), cp.slice(0, 200));
});

test('立绘提示词：去掉未成年 / 儿童化的标签、中文标签和名字，没有成年标签时补 adult；已有 adult / 25 years old 时不重复；照抄的占位改成 adult', () => {
    assert.equal(normalizePortraitPrompt('woman, teen, loli, 16 years old, short hair, 林晚, school uniform', { names: ['林晚'] }), 'adult, woman, short hair');
    assert.equal(normalizePortraitPrompt('woman, 15-year-old'), 'adult, woman');
    assert.equal(normalizePortraitPrompt('woman, aged 16'), 'adult, woman');
    assert.equal(normalizePortraitPrompt('少女, 校服, long hair'), 'adult, long hair');
    assert.equal(normalizePortraitPrompt('adult woman, petite, aged 12 appearance, 12-year-old look, adolescent, seventeen years old, highschool, junior high student'), 'adult woman, petite');
    assert.equal(normalizePortraitPrompt('adult woman|adult man, long hair'), 'adult, long hair');
    assert.equal(normalizePortraitPrompt('woman, 25-year-old, aged 25, aged 105, middle-aged, mid-20s'), 'woman, 25-year-old, aged 25, aged 105, middle-aged, mid-20s', '成年的年龄标签不动');
    assert.equal(normalizePortraitPrompt(['adult woman', 'long hair'], {}), 'adult woman, long hair');
    assert.equal(normalizePortraitPrompt('25 years old, woman'), '25 years old, woman');
    assert.equal(normalizePortraitPrompt('woman, childlike, aged down, underaged, long hair'), 'adult, woman, long hair');
    assert.equal(normalizePortraitPrompt(''), '');
    assert.ok(normalizePortraitPrompt(Array(300).fill('tag').map((t, i) => `${t}${i}`).join(',')).length <= STUDIO_LIMITS.portraitPrompt);
});

test('normalizeStudio：上限（角色 12、阶段 8、地点 12、文字长度），选项（人数 1-12、阶段 2-8、留空让 AI 定）；细节 / 开场白只留还在大纲里的', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ id: `sc_${i}`, name: `人${i}`, age: 30 }));
    const st = normalizeStudio({
        title: 'x'.repeat(100), premise: 'p'.repeat(5000), step: 9,
        options: { count: 99, stages: 1, openerLen: '', userRole: { kind: 'custom', text: '' }, statusBar: false },
        outline: {
            cast: many, stages: Array.from({ length: 12 }, (_, i) => ({ id: `ss_${i}`, name: `阶段${i}` })),
            world: { setting: 's'.repeat(9999), locations: Array.from({ length: 20 }, (_, i) => ({ name: `地${i}` })) },
        },
        details: { sc_0: { personality: '冷静', portrait_prompt: 'girl' }, gone: { personality: 'x' } },
        openers: { ss_0: '开场', ss_99: '不在了' },
        errors: { sc_1: '出错了', nope: 'x' },
    });
    assert.equal(st.title.length, STUDIO_LIMITS.title);
    assert.equal(st.premise.length, STUDIO_LIMITS.premise);
    assert.equal(st.step, 1);
    assert.equal(st.outline.cast.length, 12);
    assert.equal(st.outline.stages.length, 8);
    assert.equal(st.outline.world.locations.length, 12);
    assert.equal(st.outline.world.setting.length, STUDIO_LIMITS.setting);
    assert.deepEqual(Object.keys(st.details), ['sc_0']);
    assert.equal(st.details.sc_0.portraitPrompt, 'adult, girl');
    assert.deepEqual(st.openers, { ss_0: '开场' });
    assert.deepEqual(st.errors, { sc_1: '出错了' });
    assert.equal(st.options.count, 12);
    assert.equal(st.options.stages, 2);
    assert.equal(st.options.openerLen, '400-800 字');
    assert.deepEqual(st.options.userRole, { kind: 'custom', text: '' }, '选了自定义还没写：保持 custom');
    assert.equal(st.options.statusBar, false);
    assert.equal(normalizeStudioOptions({ count: '', stages: 'abc' }).count, '');
    assert.equal(normalizeStudioOptions({ stages: '' }).stages, '');
    assert.equal(normalizeStudio(null), null);
});

test('草稿的增删改：addStudio 放在最前面、默认画像；改名、updateStudio 合并、删除；大纲页的加减角色 / 阶段；进度与步骤', () => {
    const s = settings();
    const prof = addUserProfile(s, { name: '我的口味', isDefault: true }).id;
    const p = createEmptyProject({ name: '原创' });
    const a = addStudio(p, s, { premise: PREMISE });
    const b = addStudio(p, s, { title: '第二个' });
    assert.deepEqual(p.studios.map((x) => x.id), [b.id, a.id]);
    assert.equal(a.options.profileId, prof);
    assert.equal(a.options.openerLen, '400-800 字');
    assert.equal(renameStudio(p, a.id, '  荒岛  ').title, '荒岛');
    updateStudio(p, a.id, { options: { count: 7, userRole: { kind: 'custom', text: '医生' } }, outline: { title: '荒岛七日', world: { tone: '紧张' } } });
    assert.equal(getStudio(p, a.id).options.count, 7);
    assert.deepEqual(getStudio(p, a.id).options.userRole, { kind: 'custom', text: '医生' });
    assert.equal(getStudio(p, a.id).outline.world.tone, '紧张');
    assert.equal(getStudio(p, a.id), a, '就地修改同一个对象');
    // 大纲页
    const m1 = studioAddCast(a, { name: '林晚', age: '24' });
    const m2 = studioAddCast(a, { name: '苏晴' });
    const s1 = studioAddStage(a, { name: '坠机' });
    const s2 = studioAddStage(a, { name: '求生' });
    assert.ok(studioMoveStage(a, s2.id, -1));
    assert.deepEqual(a.outline.stages.map((x) => x.name), ['求生', '坠机']);
    assert.equal(studioMoveStage(a, s2.id, -1), false);
    assert.equal(studioStepEnabled(a, 3), true);
    assert.equal(studioStepEnabled(a, 4), false, '还没有开场白');
    updateStudio(p, a.id, { details: { [m1.id]: { personality: '冷静' } }, openers: { [s1.id]: '开场' } });
    // 只手动填了一项：只算「部分填写」，「全部生成」会补全
    assert.equal(studioCastStatus(a, m1.id), 'partial');
    assert.equal(studioCastStatus(a, m2.id), 'empty');
    assert.deepEqual(studioProgress(a), { cast: 2, castDone: 0, stages: 2, openersDone: 1, example: false });
    // 外貌、性格、说话方式、背景都手动写了：算完成
    updateStudio(p, a.id, { details: { [m1.id]: { appearance: '短发', speech: '话少', background: '空乘' } } });
    assert.equal(studioCastStatus(a, m1.id), 'done');
    assert.deepEqual(studioProgress(a), { cast: 2, castDone: 1, stages: 2, openersDone: 1, example: false });
    assert.equal(studioStepEnabled(a, 4), true);
    // 刚加的空行（地点、好感等级）保存时留着，写进提示词 / 世界书时跳过
    updateStudio(p, a.id, { outline: { world: { locations: [{ name: '', desc: '' }] } }, details: { [m1.id]: { affection: [{ label: '戒备', behavior: '远远看着' }, { label: '', behavior: '' }] } } });
    assert.equal(a.outline.world.locations.length, 1);
    assert.equal(a.details[m1.id].affection.length, 2);
    const entry = studioOwnEntries(s, { source: STUDIO_SOURCE, studio: { entries: [] } });
    assert.deepEqual(entry, []);
    assert.ok(studioRemoveCast(a, m1.id));
    assert.equal(a.details[m1.id], undefined);
    // 阶段删光了：第 2 步还能进（回去手动加阶段），第 3 步要等有阶段
    for (const st of [...a.outline.stages]) studioRemoveStage(a, st.id);
    assert.equal(studioOutlineTouched(a), true);
    assert.equal(studioStepEnabled(a, 2), true);
    assert.equal(studioStepEnabled(a, 3), false);
    assert.equal(studioStepEnabled(createStudio(s, { premise: 'x' }), 2), false, '大纲还是空的：第 2 步进不去');
    assert.ok(removeStudio(p, b.id));
    assert.equal(p.studios.length, 1);
    assert.throws(() => { for (let i = 0; i < 60; i++) addStudio(p, s, {}); }, /最多 50 份/);
});

test('项目：normalizeProject 规整构思；导出 / 导入任务带上构思；快照不含构思', async () => {
    const p = createEmptyProject({ name: '荒岛' });
    addStudio(p, settings(), { premise: PREMISE });
    const n = normalizeProject(structuredClone(p));
    assert.equal(n.studios.length, 1);
    assert.equal(n.studios[0].premise, PREMISE);
    const imported = parseTask({ type: 'novel_loom_task', project: structuredClone(p) });
    assert.equal(imported.studios[0].premise, PREMISE);
    assert.deepEqual(normalizeProject({ name: 'x', studios: 'bad' }).studios, []);
    const store = await import('../src/store.js');
    const snap = await store.createSnapshot(n, '测试');
    assert.equal(snap.data.studios, undefined);
});

test('创意里的线索：人数（7个美女 / 七位幸存者）、短标题、新项目名不重名', () => {
    assert.equal(premiseCastCount(PREMISE), 7);
    assert.equal(premiseCastCount('末日里和七位幸存者躲在商场'), 7);
    assert.equal(premiseCastCount('3 名同事被困电梯'), 3);
    assert.equal(premiseCastCount('一个人的冒险故事吧'), 1);
    assert.equal(premiseCastCount('荒岛求生'), null);
    assert.equal(premiseCastCount('20个人'), null);
    // 「位」「名」后面跟什么人都算；「个」要跟上人；名次、时间不算
    assert.equal(premiseCastCount('雪山旅馆被暴风雪困住，五位房客各怀秘密'), 5);
    assert.equal(premiseCastCount('十二名船员'), 12);
    assert.equal(premiseCastCount('和三个闺蜜去露营'), 3);
    assert.equal(premiseCastCount('三个月后重逢'), null);
    assert.equal(premiseCastCount('比赛第三名的选手'), null);
    assert.equal(studioTitleFromPremise(PREMISE), '飞机失事');
    assert.equal(studioTitleFromPremise('末日商场，七位幸存者'), '末日商场');
    assert.equal(studioProjectName('飞机失事', ['飞机失事', '飞机失事 2']), '飞机失事 3');
    assert.equal(studioProjectName('', []), '原创项目');
});

// ---------------- 提示词 ----------------

test('提示词注册：八个创意工坊提示词有默认值、标签和占位符（主提示里都有）；消息链任务 studio 默认沿用写角色卡的链', () => {
    for (const k of ['studioOutline', 'studioCharacter', 'studioOpener', 'studioExample']) {
        for (const key of [k, `${k}System`]) {
            assert.ok(DEFAULT_PROMPTS[key] && PROMPT_LABELS[key] && PROMPT_PLACEHOLDERS[key]?.length, key);
            assert.match(PROMPT_LABELS[key], /^创意工坊 · /);
        }
        for (const ph of PROMPT_PLACEHOLDERS[k]) assert.ok(DEFAULT_PROMPTS[k].includes(ph), `${k} 缺少 ${ph}`);
        assert.deepEqual(PROMPT_PLACEHOLDERS[`${k}System`], PROMPT_PLACEHOLDERS[k], '系统提示与主提示用同一组变量渲染');
        assert.match(DEFAULT_PROMPTS[`${k}System`], /成年人（18 岁以上）/);
    }
    // 冒烟测试的模拟 AI 靠这些标记区分请求，彼此不能混
    const marks = { studioOutline: '设计群像故事大纲', studioCharacter: '展开角色细节', studioOpener: '写这一阶段的开场白', studioExample: '写示例对话' };
    for (const [k, m] of Object.entries(marks)) {
        for (const other of Object.keys(marks)) assert.equal(DEFAULT_PROMPTS[other].includes(m), other === k, `${other} / ${m}`);
    }
    const t = CHAIN_TASKS.find((x) => x.value === 'studio');
    assert.ok(t && t.label.startsWith('创意工坊') && t.fallback === 'card');
    const s = settings();
    assert.equal(getChain(s, 'studio'), s.messageChains.default);
    s.messageChains.card = [{ role: 'system', content: '写卡破限 {SYSTEM}', enabled: true }, { role: 'user', content: '{PROMPT}', enabled: true }];
    assert.equal(getChain(s, 'studio'), s.messageChains.card, '没有自定义时沿用写角色卡的链');
    s.messageChains.studio = [{ role: 'user', content: '工坊 {PROMPT}', enabled: true }];
    assert.equal(getChain(s, 'studio'), s.messageChains.studio);
    s.messageChains.studio = [{ role: 'user', content: '关掉的', enabled: false }];
    assert.equal(getChain(s, 'studio'), s.messageChains.card);
});

test('大纲提示词：创意、人数（创意里写明的 7 人）、成年人、{{user}} 的身份、卡的导向（要本卡落点）、用户画像（按设定为准、成年人）、JSON 模板', () => {
    const s = settings();
    const prof = addUserProfile(s, { name: '我的口味', likes: ['黑丝'], dislikes: ['NTR'], style: '第二人称' }).id;
    const p = createEmptyProject({ name: '荒岛' });
    const st = addStudio(p, s, { premise: PREMISE, options: { profileId: prof, orientationId: 'orient_pure', userRole: { kind: 'custom', text: '{{user}} 是同机的退伍军医' }, extra: '多写海岛的细节' } });
    const { system, prompt } = buildOutlinePrompt(p, s, st);
    assert.match(system, /所有角色都是成年人（18 岁以上）/);
    assert.ok(prompt.includes(PREMISE));
    assert.ok(prompt.includes('正好 7 人（不含 {{user}}，创意里写明的）'));
    assert.ok(prompt.includes('按故事需要分 4-6 个阶段'));
    assert.ok(prompt.includes('age 写数字，18 岁以上（所有角色都是成年人）'));
    assert.ok(prompt.includes(ADULT));
    assert.ok(prompt.includes('# {{user}} 的身份') && prompt.includes('同机的退伍军医'));
    assert.ok(prompt.includes('【卡的导向：纯爱】') && prompt.includes('orientation_notes') && prompt.includes('导向里说的 {{char}} 指故事里的角色'));
    assert.ok(prompt.includes('# 为这位用户量身定制') && prompt.includes('黑丝') && prompt.includes('设定里写明的以设定为准'));
    assert.ok(prompt.includes('多写海岛的细节'));
    assert.ok(prompt.includes('"cast": [') && prompt.includes('"stages": [') && prompt.includes('"user_role"'));
    assert.ok(!/\{[A-Z_]+\}/.test(prompt.replace(/\{\{(?:user|char)\}\}/g, '')), '没有剩下的占位符');
    // 定了人数和阶段数
    st.options.count = 5;
    st.options.stages = 4;
    const p2 = buildOutlinePrompt(p, s, st).prompt;
    assert.ok(p2.includes('正好 5 人（不含 {{user}}）') && p2.includes('正好 4 个阶段'));
    // 用户改过的模板没有占位符：照样追加身份、导向、画像和 JSON 模板
    s.prompts.studioOutline = '按创意设计（设计群像故事大纲）：{PREMISE}';
    const custom = buildOutlinePrompt(p, s, st).prompt;
    assert.ok(custom.includes('# {{user}} 的身份') && custom.includes('【卡的导向：纯爱】') && custom.includes('# 为这位用户量身定制') && custom.includes('# 输出 JSON 模板'));
});

test('大纲的部分重新生成：提示词带当前大纲和这次只改哪一部分；锁定的角色列出来；JSON 模板跟着变', () => {
    const s = settings();
    const p = createEmptyProject({ name: '荒岛' });
    const st = addStudio(p, s, { premise: PREMISE });
    st.outline = parseStudioOutline(outlineReply()).outline;
    st.outline.cast[1].locked = true;
    const all = buildOutlinePrompt(p, s, st, { mode: 'all' }).prompt;
    assert.ok(all.includes('# 用户锁定的角色（原样保留，算在人数里）\n- 苏晴'));
    assert.ok(all.includes('「用户锁定的角色」原样写进 cast'));
    const world = buildOutlinePrompt(p, s, st, { mode: 'world', instruction: '换成雪山' }).prompt;
    assert.ok(world.includes('只重新设计世界观') && world.includes('<当前大纲>') && world.includes('额外要求（优先满足）：换成雪山'));
    assert.ok(world.includes('"world": {') && !world.includes('"cast": ['));
    const cast = buildOutlinePrompt(p, s, st, { mode: 'cast' }).prompt;
    assert.ok(cast.includes('只重新设计角色阵容') && cast.includes('一共 7 人') && cast.includes('"cast": [') && !cast.includes('"stages": ['));
    const stages = buildOutlinePrompt(p, s, st, { mode: 'stages' }).prompt;
    assert.ok(stages.includes('只重新设计故事阶段') && stages.includes('"stages": [') && !stages.includes('"world": {'));
    const member = buildOutlinePrompt(p, s, st, { mode: 'member', memberId: st.outline.cast[3].id }).prompt;
    assert.ok(member.includes('只重新设计「陈曦」这一位') && member.includes('"member": {'));
    assert.throws(() => buildOutlinePrompt(p, s, st, { mode: 'nope' }), /未知的重新生成方式/);
});

test('角色 / 开场白 / 示例对话的提示词：大纲、这个角色、其他角色（已展开的附简要细节）、阶段；只重写一项带当前内容；成年人；叙事偏好', () => {
    const s = settings();
    const prof = addUserProfile(s, { name: '口味', style: '第二人称“你”' }).id;
    const p = createEmptyProject({ name: '荒岛' });
    const st = addStudio(p, s, { premise: PREMISE, options: { profileId: prof } });
    st.outline = parseStudioOutline(outlineReply()).outline;
    const [a, b] = st.outline.cast;
    applyCharacterResult(st, a.id, normalizeDetails(characterReply('林晚')));
    const { system, prompt } = buildCharacterPrompt(p, s, st, b.id);
    assert.match(system, /这个角色是成年人（18 岁以上）/);
    assert.ok(prompt.includes('展开角色「苏晴」的细节'));
    assert.ok(prompt.includes('姓名: 苏晴') && prompt.includes('年龄: 23 岁'));
    assert.ok(prompt.includes('- 林晚（又称 晚晚）（22 岁，女，空乘）') && prompt.includes('秘密（不要和 TA 的重样）：她偷藏了一部卫星电话'));
    assert.ok(prompt.includes('1. 坠机（第 1 天）'));
    assert.ok(prompt.includes('TA 是成年人，年龄按大纲（23 岁）') && prompt.includes(ADULT));
    assert.ok(prompt.includes('"portrait_prompt": "adult woman, ……"') && prompt.includes('"affection": ['));
    const one = buildCharacterPrompt(p, s, st, a.id, { field: 'secret', instruction: '秘密和走私有关' }).prompt;
    assert.ok(one.includes('只重写「秘密与隐藏剧情」这一项（只重写这一项）') && one.includes('<当前内容>') && one.includes('秘密: 她偷藏了一部卫星电话'));
    assert.ok(one.includes('"secret": {') && !one.includes('"appearance":') && one.includes('秘密和走私有关'));
    assert.throws(() => buildCharacterPrompt(p, s, st, a.id, { field: 'nope' }), /不认识的字段/);
    // 开场白：第一阶段没有前情；之后的阶段默认前面已经发生；叙事偏好；角色只给秘密的线索
    const op1 = buildOpenerPrompt(p, s, st, st.outline.stages[0].id).prompt;
    assert.ok(op1.includes('第 1 阶段「坠机」写一段开场白') && op1.includes('（没有：这是故事的开头）') && op1.includes('这是故事的第一个阶段'));
    const op2 = buildOpenerPrompt(p, s, st, st.outline.stages[1].id).prompt;
    assert.ok(op2.includes('默认前面的阶段都已经发生') && op2.includes('# 前面的阶段（已经发生）\n1. 坠机'));
    assert.ok(op2.includes('叙事偏好：第二人称“你”（按这个写）') && op2.includes('篇幅 400-800 字'));
    assert.ok(op2.includes('秘密的线索（只能暗示）') && !op2.includes('偷藏了一部卫星电话'));
    assert.ok(op2.includes('不替 {{user}} 说话、行动或做决定') && op2.includes('所有角色都是成年人'));
    st.openers[st.outline.stages[1].id] = '旧的开场白';
    assert.ok(buildOpenerPrompt(p, s, st, st.outline.stages[1].id).prompt.includes('# 当前的开场白（重写：写法要和它有实质区别）\n<当前内容>\n旧的开场白'));
    const ex = buildExamplePrompt(p, s, st).prompt;
    assert.ok(ex.includes('写示例对话') && ex.includes('<START>') && ex.includes('示例台词：「先止血。」'));
});

// ---------------- 解析 ----------------

test('parseStudioOutline：字段名宽松（中文 / camelCase / cast 按名字分组）；人数、阶段数定了时截掉多的、少了提示；缺部分时要 AI 重写', () => {
    const r = parseStudioOutline({
        卡名: '雪山', 世界观: { 设定: '雪山', 规则: '夜里零下三十度', 地点: { 木屋: '半山腰的避难所' } }, userRole: '向导',
        角色: { 阿雪: { 年龄: '26', 身份: '向导', 一句话: '话少' }, 小林: '登山客' }, 阶段: [{ 名称: '暴雪', 时间: '第 1 夜', 概要: '被困' }],
    });
    assert.equal(r.outline.title, '雪山');
    assert.equal(r.outline.world.rules, '夜里零下三十度');
    assert.deepEqual(r.outline.world.locations, [{ name: '木屋', desc: '半山腰的避难所' }]);
    assert.deepEqual(r.outline.cast.map((c) => [c.name, c.age, c.oneLiner]), [['阿雪', '26 岁', '话少'], ['小林', '', '登山客']]);
    assert.deepEqual(r.outline.stages.map((x) => [x.name, x.time, x.summary]), [['暴雪', '第 1 夜', '被困']]);
    const cut = parseStudioOutline(outlineReply(), { count: 5, stages: 2 });
    assert.equal(cut.outline.cast.length, 5);
    assert.equal(cut.outline.stages.length, 2);
    const few = parseStudioOutline(outlineReply({ names: ['甲', '乙'] }), { count: 4, stages: 5 });
    assert.ok(few.warnings.some((w) => w.includes('只给了 2 个角色（要 4 个）')) && few.warnings.some((w) => w.includes('只给了 3 个阶段（要 5 个）')));
    assert.throws(() => parseStudioOutline({ title: 'x', world: { setting: 'y' }, stages: [{ name: 'a' }] }), (e) => !!e.feedback && /cast/.test(e.message));
    assert.throws(() => parseStudioOutline({ title: 'x', world: { setting: 'y' }, cast: [{ name: 'a' }] }), (e) => !!e.feedback && /stages/.test(e.message));
    assert.throws(() => parseStudioOutline({ cast: [{ name: 'a' }], stages: [{ name: 'b' }] }), (e) => !!e.feedback && /world/.test(e.message));
    const notes = parseStudioOutline(outlineReply({ extra: { orientation_notes: ['林晚 倾心于 {{user}}', '苏晴 是阻碍'] } }));
    assert.equal(notes.outline.orientationNotes, '- 林晚 倾心于 {{user}}\n- 苏晴 是阻碍');
});

test('重新生成大纲时锁定的角色原样保留（位置、id、细节都不变）；名字和身份没变的沿用 id；只换世界观 / 阶段时别的部分不动；换掉一个角色', () => {
    const cur = parseStudioOutline(outlineReply()).outline;
    cur.cast[1].locked = true;
    cur.cast[4].locked = true;
    const lockedIds = [cur.cast[1].id, cur.cast[4].id];
    // 整份重新生成：AI 又把锁定的人写了一遍（名字一样、设定不同）——以锁定的为准
    const reply = outlineReply({ names: ['苏晴', '新一', '新二', '新三', '新四', '新五', '新六'] });
    reply.cast[0].identity = '被 AI 改掉的身份';
    const r = parseStudioOutline(reply, { mode: 'all', current: cur, count: 7 });
    assert.deepEqual(r.outline.cast.map((c) => c.name), ['新一', '苏晴', '新二', '新三', '周岚', '新四', '新五']);
    assert.deepEqual([r.outline.cast[1].id, r.outline.cast[4].id], lockedIds);
    assert.equal(r.outline.cast[1].identity, '空乘');
    assert.ok(r.outline.cast[1].locked && r.outline.cast[4].locked);
    // 只换角色阵容：世界观和阶段不动；名字和身份都没变的沿用原来的 id
    const keepSame = outlineReply({ names: ['林晚', 'A', 'B', 'C', 'D', 'E', 'F'] });
    const c2 = parseStudioOutline({ cast: keepSame.cast }, { mode: 'cast', current: cur, count: 7 });
    assert.equal(c2.outline.cast[0].id, cur.cast[0].id, '林晚 没变：沿用 id');
    assert.deepEqual([c2.outline.cast[1].name, c2.outline.cast[4].name], ['苏晴', '周岚']);
    assert.deepEqual(c2.outline.stages.map((x) => x.id), cur.stages.map((x) => x.id));
    assert.equal(c2.outline.world.setting, cur.world.setting);
    // 只换世界观
    const w = parseStudioOutline({ title: '雪山七日', world: { setting: '雪山', locations: [{ name: '木屋', desc: 'd' }] } }, { mode: 'world', current: cur });
    assert.equal(w.outline.title, '雪山七日');
    assert.equal(w.outline.world.rules, cur.world.rules, '没给的部分保持原样');
    assert.deepEqual(w.outline.cast.map((c) => c.id), cur.cast.map((c) => c.id));
    // 只换阶段：名字和时间都没变的沿用 id
    const st = parseStudioOutline({ stages: [{ name: '坠机', time: '第 1 天', summary: '新的' }, { name: '暴雨', time: '第 3 天' }] }, { mode: 'stages', current: cur });
    assert.equal(st.outline.stages[0].id, cur.stages[0].id);
    assert.notEqual(st.outline.stages[1].id, cur.stages[1].id);
    assert.deepEqual(st.outline.cast.map((c) => c.id), cur.cast.map((c) => c.id));
    // 换掉一个角色：新 id，其余不变；重名时要 AI 重写
    const m = parseStudioOutline({ member: { name: '韩露', age: '31', identity: '机长' } }, { mode: 'member', current: cur, memberId: cur.cast[2].id });
    assert.equal(m.outline.cast[2].name, '韩露');
    assert.notEqual(m.outline.cast[2].id, cur.cast[2].id);
    assert.deepEqual(m.outline.cast.filter((_, i) => i !== 2).map((c) => c.id), cur.cast.filter((_, i) => i !== 2).map((c) => c.id));
    assert.throws(() => parseStudioOutline({ member: { name: '林晚' } }, { mode: 'member', current: cur, memberId: cur.cast[2].id }), (e) => !!e.feedback && /重复/.test(e.message));
});

test('generateOutline：生成后步骤到 2、标题跟上；不合法 JSON 重试一次；只换角色阵容时清掉被换掉的人的细节；锁定的人不能单独换', async () => {
    const s = settings();
    const p = createEmptyProject({ name: '荒岛' });
    const st = addStudio(p, s, { premise: PREMISE });
    const logs = [];
    const seen = installTavern((t, n) => (n === 1 ? '我需要再想想，先不输出。' : JSON.stringify(outlineReply())));
    try {
        await assert.rejects(generateOutline(p, s, st, { mode: 'cast' }), /还没有大纲/);
        const r = await generateOutline(p, s, st, { onLog: (m, l) => logs.push([m, l]) });
        assert.equal(seen.length, 2);
        assert.ok(seen[1].includes('上面的输出不是合法 JSON'));
        assert.equal(r.outline.cast.length, 7);
        assert.equal(st.step, 2);
        assert.equal(st.title, '荒岛七日');
        assert.ok(logs.some(([m, l]) => l === 'warn' && m.includes('重试一次')));
        // 展开了两个人，锁定其中一个，再换角色阵容
        const [a, b] = st.outline.cast;
        applyCharacterResult(st, a.id, normalizeDetails(characterReply('林晚')));
        applyCharacterResult(st, b.id, normalizeDetails(characterReply('苏晴')));
        st.outline.cast[1].locked = true;
        assert.deepEqual(outlineRerollImpact(st, 'cast'), { details: 1, openers: 0 });
        assert.deepEqual(outlineRerollImpact(st, 'world'), { details: 0, openers: 0 });
        installTavern(JSON.stringify({ cast: outlineReply({ names: ['甲', '乙', '丙', '丁', '戊', '己', '庚'] }).cast }));
        const r2 = await generateOutline(p, s, st, { mode: 'cast' });
        assert.deepEqual(r2.removed, { details: 1, openers: 0 });
        assert.equal(st.details[b.id].personality, characterReply('苏晴').personality, '锁定的人的细节还在');
        assert.equal(st.details[a.id], undefined);
        await assert.rejects(generateOutline(p, s, st, { mode: 'member', memberId: b.id }), /已经锁定/);
    } finally {
        delete globalThis.SillyTavern;
    }
});

test('parseStudioCharacter：好感变化（对象 / 字符串 / 缺 level）、秘密（中文字段名 / 只给一段文字）、示例台词去引号、立绘提示词成年；外面包一层也认；只要一项时缺了要重写', () => {
    const d = parseStudioCharacter(characterReply('林晚'), { names: ['林晚'] });
    assert.deepEqual(d.affection.map((a) => [a.level, a.label]), [[1, '戒备'], [2, '熟悉'], [3, '信任'], [4, '依恋']]);
    assert.equal(d.affection[2].behavior, '把伤口交给他处理');
    assert.deepEqual(d.secret, { content: '她偷藏了一部卫星电话', hints: '常独自去海边\n口袋鼓着', reveal: '好感到信任以上，或第 3 阶段' });
    assert.deepEqual(d.sampleLines, ['先止血。', '别慌', '水留给伤员']);
    assert.equal(d.portraitPrompt, 'adult, woman, short hair, scar');
    assert.equal(d.relationToUser, '同机乘客，起初只当他是麻烦');
    const zh = parseStudioCharacter({ character: { 外貌: '高个子', 性格: '急躁', 秘密: '欠了赌债', 好感: { 冷淡: '不理人', 友好: '会笑' } } });
    assert.equal(zh.appearance, '高个子');
    assert.deepEqual(zh.secret, { content: '欠了赌债', hints: '', reveal: '' });
    assert.deepEqual(zh.affection.map((a) => a.label), ['冷淡', '友好']);
    const many = parseStudioCharacter({ personality: 'x', affection: Array.from({ length: 9 }, (_, i) => ({ label: `级${i}`, behavior: 'b' })), sample_lines: Array(9).fill(0).map((_, i) => `台词${i}`) });
    assert.equal(many.affection.length, STUDIO_LIMITS.affection);
    assert.equal(many.sampleLines.length, STUDIO_LIMITS.sampleLines);
    assert.deepEqual(parseStudioCharacter({ secret: { content: '新秘密' } }, { field: 'secret' }), { secret: { content: '新秘密', hints: '', reveal: '' } });
    assert.throws(() => parseStudioCharacter({ appearance: 'x' }, { field: 'secret' }), (e) => !!e.feedback);
    assert.throws(() => parseStudioCharacter({ portrait_prompt: 'adult' }), (e) => !!e.feedback);
});

test('只重写一项：只改这一项，其余字段不变；AI 漏了这一项时重试一次', async () => {
    const s = settings();
    const p = createEmptyProject({ name: '荒岛' });
    const st = addStudio(p, s, { premise: PREMISE });
    st.outline = parseStudioOutline(outlineReply()).outline;
    const a = st.outline.cast[0];
    applyCharacterResult(st, a.id, normalizeDetails(characterReply('林晚')));
    const before = structuredClone(st.details[a.id]);
    const seen = installTavern((t, n) => (n === 1 ? JSON.stringify({ appearance: '只给了外貌' }) : JSON.stringify({ personality: '底色: 暴躁' })));
    try {
        const d = await rerollCharacterField(p, s, st, a.id, 'personality', { instruction: '更凶一点' });
        assert.equal(seen.length, 2);
        assert.ok(seen[0].includes('只重写「性格」这一项') && seen[0].includes('更凶一点'));
        assert.equal(d.personality, '底色: 暴躁');
        for (const k of ['appearance', 'outfit', 'speech', 'sampleLines', 'background', 'relationToUser', 'affection', 'secret', 'portraitPrompt']) assert.deepEqual(d[k], before[k], k);
        assert.throws(() => rerollCharacterField(p, s, st, a.id, 'nope'), /不认识的字段/);
    } finally {
        delete globalThis.SillyTavern;
    }
});

test('parseStudioOpener / parseStudioExample：去掉代码块和「开场白：」前缀、JSON 包着的也认；示例对话从 <START> 开始、说话人规整', () => {
    assert.equal(parseStudioOpener('```\n开场白：\n海浪拍上沙滩。\n```'), '海浪拍上沙滩。');
    assert.equal(parseStudioOpener('# 开场白\n海浪。'), '海浪。');
    assert.equal(parseStudioOpener('{"opener": "火光映着沙滩。"}'), '火光映着沙滩。');
    assert.equal(parseStudioOpener('开场白很长的一句话'), '开场白很长的一句话', '正文里的「开场白」不动');
    assert.ok(parseStudioOpener('长'.repeat(20000)).length <= STUDIO_LIMITS.opener);
    assert.equal(parseStudioExample('好的：\n<START>\n{{user}}：水呢？\n荒岛七日: 在潭边。', { title: '荒岛七日' }), '<START>\n{{user}}: 水呢？\n{{char}}: 在潭边。');
    assert.equal(parseStudioExample('{{char}}: 嗯。'), '<START>\n{{char}}: 嗯。');
});

// ---------------- 逐个生成 ----------------

test('全部生成：先展开角色再写开场白、最后示例对话；进度回调；一个角色失败不影响别的、记下原因；已经写好的跳过（overwrite 除外）', async () => {
    const s = settings();
    const p = createEmptyProject({ name: '荒岛' });
    const st = addStudio(p, s, { premise: PREMISE });
    installTavern(studioAI({ failChar: '许若' }));
    const events = [];
    try {
        await generateOutline(p, s, st);
        const r = await generateStudioContent(p, s, st, { onProgress: (e) => events.push(e) });
        assert.equal(r.characters.done.length, 6);
        assert.deepEqual(r.characters.failed.map((f) => f.name), ['许若']);
        assert.equal(r.openers.done.length, 3);
        assert.equal(r.example, 'done');
        assert.equal(r.stopped, false);
        const xu = st.outline.cast.find((c) => c.name === '许若');
        assert.equal(studioCastStatus(st, xu.id), 'error');
        assert.ok(st.errors[xu.id]);
        assert.deepEqual([...new Set(events.map((e) => e.phase))], ['character', 'opener', 'example']);
        assert.deepEqual(events.filter((e) => e.id === xu.id).map((e) => e.status), ['running', 'error']);
        assert.ok(events.find((e) => e.phase === 'character' && e.status === 'done').total === 7);
        assert.match(st.openers[st.outline.stages[1].id], /^第 2 阶段「求生」：海浪拍上沙滩/);
        assert.equal(st.example, '<START>\n{{user}}: 水呢？\n{{char}}: 林晚：“在潭边。”');
        // 再来一次：写好的跳过，只补失败的那个
        installTavern(studioAI());
        const again = await generateCharacterDetails(p, s, st);
        assert.deepEqual(again.done, [xu.id]);
        assert.equal(again.skipped.length, 6);
        assert.equal(st.errors[xu.id], undefined);
        const seen = installTavern(studioAI());
        const ov = await generateOpeners(p, s, st, { overwrite: true, ids: [st.outline.stages[0].id] });
        assert.equal(ov.done.length, 1);
        assert.equal(seen.length, 1);
        assert.ok(seen[0].includes('# 当前的开场白（重写'));
    } finally {
        delete globalThis.SillyTavern;
    }
});

test('停止：正在等的请求被中止后马上结束，已经写好的保留，没轮到的保持未生成；停止不算出错', async () => {
    const s = settings();
    const p = createEmptyProject({ name: '荒岛' });
    const st = addStudio(p, s, { premise: PREMISE });
    st.outline = parseStudioOutline(outlineReply()).outline;
    const ctl = new AbortController();
    let n = 0;
    globalThis.SillyTavern = {
        getContext: () => ({
            async generateRaw({ prompt }) {
                const text = prompt.map((m) => m.content).join('\n').replace(/​/g, '');
                n++;
                if (n === 3) {
                    // 用户点了停止：这次请求不会再有回复
                    ctl.abort();
                    return new Promise(() => {});
                }
                return JSON.stringify(characterReply(text.match(/展开角色「(.+?)」/)[1]));
            },
            stopGeneration() {},
        }),
    };
    const events = [];
    try {
        const r = await generateStudioContent(p, s, st, { signal: ctl.signal, onProgress: (e) => events.push(e) });
        assert.equal(r.stopped, true);
        assert.equal(r.characters.done.length, 2);
        assert.equal(r.characters.failed.length, 0);
        assert.equal(r.openers.done.length, 0);
        assert.equal(r.example, null);
        assert.equal(events.at(-1).status, 'stopped');
        assert.equal(Object.keys(st.errors).length, 0);
        assert.equal(studioProgress(st).castDone, 2);
    } finally {
        delete globalThis.SillyTavern;
    }
});

// ---------------- 生成卡 ----------------

test('组装世界卡：卡名 = 标题；描述（世界观、规则、{{user}} 的位置、角色一览、阶段、旁白规则）；开场白按阶段顺序（缺的跳过）；作者备注写明对应关系', async () => {
    const { s, p, st } = await fullStudio();
    const s2 = st.outline.stages[1].id;
    delete st.openers[s2];
    const card = assembleStudioCard(p, s, st);
    assert.equal(card.kind, 'world');
    assert.equal(card.source, STUDIO_SOURCE);
    assert.equal(card.studioId, st.id);
    assert.equal(isOriginalCard(card), true);
    assert.equal(card.data.name, '荒岛七日');
    assert.equal(card.cardName, '荒岛七日');
    for (const t of ['【世界观】', '南太平洋的无名火山岛', '【世界规则】', '淡水只有岛中央的一处泉眼', '【{{user}} 的位置】', '退伍军医', '- 林晚（22 岁，空乘）：性格0', '1. 坠机（第 1 天）', '【旁白规则】', '不替 {{user}} 说话', '所有角色都是成年人']) {
        assert.ok(card.data.description.includes(t), t);
    }
    assert.match(card.data.first_mes, /^第 1 阶段「坠机」/);
    assert.equal(card.data.alternate_greetings.length, 1);
    assert.match(card.data.alternate_greetings[0], /^第 3 阶段「获救」/);
    assert.ok(card.data.creator_notes.includes('- 开场白：第 1 阶段「坠机」（第 1 天）\n- 备选开场白 1：第 3 阶段「获救」（第 30 天）'));
    // 场景写成默认的起点：从备选开场白（后面的阶段）开始时以那段开场白为准
    assert.ok(card.data.scenario.startsWith('故事默认从第 1 阶段「坠机」（第 1 天）开始：残骸起火'), card.data.scenario);
    assert.ok(card.data.scenario.includes('核心冲突：谁来带头') && card.data.scenario.includes('如果聊天从备选开场白开始，当前处在那段开场白所在的阶段'));
    assert.ok(card.data.description.includes('从后面阶段的开场白开始时，好感从符合那个阶段关系的那一级起步'));
    const stagesText = card.studio.entries.find((e) => e.kind === 'stages').content;
    assert.ok(stagesText.includes('开场白对应的阶段：开场白 = 第 1 阶段「坠机」；备选开场白 1 = 第 3 阶段「获救」'), stagesText);
    assert.ok(stagesText.includes('各角色的好感从符合这一阶段关系的那一级起步'));
    assert.equal(card.data.mes_example, '<START>\n{{user}}: 水呢？\n{{char}}: 林晚：“在潭边。”');
    assert.equal(card.data.personality, '紧张里带着暧昧');
    assert.deepEqual(card.data.tags, ['群像', '原创']);
    assert.deepEqual(card.studio.greetings.map((g) => g.label), ['第 1 阶段「坠机」', '第 3 阶段「获救」']);
    assert.equal(card.timepoint, null);
    // 关掉示例对话
    st.options.examples = false;
    assert.equal(assembleStudioCard(p, s, st).data.mes_example, '');
    // 还不能做成卡
    const empty = addStudio(p, s, { premise: 'x' });
    assert.match(studioCardProblem(empty), /还没有大纲/);
    assert.throws(() => assembleStudioCard(p, s, empty), /还没有大纲/);
    empty.outline = structuredClone(st.outline);
    assert.match(studioCardProblem(empty), /还没有开场白/);
});

test('本卡世界书条目：每个角色一条（全部细节、好感一级一级、秘密写明揭露前不说破、没有立绘提示词）、每个地点一条、常驻的故事阶段', async () => {
    const { s, p, st } = await fullStudio();
    st.details[st.outline.cast[0].id].affection.push({ level: 5, label: '', behavior: '' });
    const card = assembleStudioCard(p, s, st);
    const entries = studioOwnEntries(s, card);
    const chars = entries.filter((e) => e.category === '角色');
    assert.equal(chars.length, 7);
    const lin = chars.find((e) => e.name === '林晚');
    assert.deepEqual(lin.keywords, ['林晚', '晚晚']);
    assert.equal(lin.constant, false);
    assert.equal(lin.order, 100);
    for (const t of ['年龄: 22 岁', '外貌: 林晚：短发，左眉有疤', '穿着: 撕破的制服', '说话方式:', '  - 「先止血。」', '好感变化（林晚对 {{user}} 的态度按现在好感所在的那一级来表现', '  2. 熟悉：会分水给他',
        '秘密（只有旁白知道）: 她偷藏了一部卫星电话', '揭露条件: 好感到信任以上，或第 3 阶段', '揭露条件满足之前，林晚不会主动说出这个秘密，旁白也不直接点破', '林晚是成年人。']) {
        assert.ok(lin.content.includes(t), t);
    }
    assert.ok(!lin.content.includes('short hair') && !lin.content.includes('立绘'), '立绘提示词不写进世界书');
    assert.ok(lin.content.includes('  4. 依恋：夜里守在他旁边') && !lin.content.includes('5. '), '空着的一级跳过');
    const stages = entries.find((e) => e.name === '故事阶段');
    assert.equal(stages.constant, true);
    assert.equal(stages.category, '剧情');
    assert.equal(stages.ignoreBudget, true, '世界书预算溢出时不被丢掉');
    assert.ok(stages.content.includes('2. 求生（第 2-7 天）\n   处境：分工找水找食物。\n   核心冲突：淡水不够'));
    assert.ok(stages.content.includes('不跳过阶段，不提前透露后面阶段的事件'));
    // 地点条目的正文带上地点名（酒馆只把正文发给模型）
    assert.deepEqual(entries.filter((e) => e.category === '地点').map((e) => [e.name, e.content]), [['坠机残骸', '地点: 坠机残骸\n说明: 断成两截的机身，白天当仓库'], ['淡水潭', '地点: 淡水潭\n说明: 岛中央的泉眼']]);
    assert.deepEqual(studioOwnEntries(s, { ...card, source: 'original' }), [], '不是创意工坊的卡没有');
});

test('buildStudioCard：卡放进项目；角色和地点存进项目（手动、锁定、记着这张卡）；写入时用自己的一本世界书，里面是本卡条目，项目里的副本不重复', async () => {
    const { s, p, st } = await fullStudio();
    const r = buildStudioCard(p, s, st);
    assert.equal(r.created, true);
    assert.equal(p.cards.length, 1);
    assert.equal(st.cardId, r.card.id);
    assert.equal(st.step, 4);
    assert.deepEqual(Object.keys(p.characters), NAMES);
    const lin = p.characters['林晚'];
    assert.ok(lin.manual && lin.locked);
    assert.equal(lin.originalCardId, r.card.id);
    assert.equal(lin.age, '22 岁');
    assert.equal(lin.personality, '底色: 冷静\n- 遇到危险先数人头');
    assert.ok(lin.appearance.includes('穿着：撕破的制服'));
    assert.equal(p.worldbook['地点']['淡水潭'].originalCardId, r.card.id);
    assert.equal(r.card.original.saved, true);
    assert.equal(r.card.original.characters[0].savedAs, '林晚');
    assert.equal(r.card.studio.keys[st.outline.cast[0].id], '林晚');
    // 状态栏预填主要角色用卡里的名字
    assert.deepEqual(originalCastNames(r.card), NAMES);
    assert.equal(cardOwnWorld(r.card), true);
    const prep = prepareCard(p, s, r.card);
    assert.equal(prep.ownWorld, true);
    const names = prep.entries.map((e) => `${e.category}/${e.name}`);
    assert.equal(names.filter((n) => n === '角色/林晚').length, 1, '项目里的副本不再带一份');
    assert.ok(names.includes('剧情/故事阶段') && names.includes('地点/淡水潭'));
    assert.equal(prep.entries.find((e) => e.name === '故事阶段').ignoreBudget, true);
    assert.equal(p.worldbook['地点']['淡水潭'].content, '地点: 淡水潭\n说明: 岛中央的泉眼');
    assert.ok(prep.entries.find((e) => e.name === '林晚').content.includes('秘密（只有旁白知道）'));
    assert.equal(prep.json.data.alternate_greetings.length, 2);
    assert.equal(prep.json.data.character_book.entries.length, prep.entries.length);
});

test('更新卡片：同一张卡（id、头像、写入酒馆的绑定、状态栏沿用）；改名的角色在项目里跟着改名；去掉的角色删掉；新加的补进状态栏', async () => {
    const { s, p, st } = await fullStudio();
    const first = buildStudioCard(p, s, st).card;
    first.stAvatar = 'huangdao.png';
    first.ownWorldName = '《荒岛》世界书·荒岛七日';
    first.avatarDataUrl = 'data:image/png;base64,AAAA';
    first.data.system_prompt = '用户自己写的系统提示';
    ensureStatusBar(first, s);
    first.statusBar.spec = normalizeStatusSpec({ variables: [{ path: '主要角色', type: 'record', keyDesc: '角色名', value: { type: 'object', fields: [{ key: '好感', type: 'number', min: 0, max: 100 }] }, init: {} }] }, { charName: statusBarCharName(first), maxVars: 20 });
    p.relationships = [{ id: 'r1', from: '苏晴', to: '林晚', type: 'friend', label: '', mutual: true }];
    // 苏晴 改名为 苏晴晴；顾青 删掉；加一个 韩露
    st.outline.cast[1].name = '苏晴晴';
    studioRemoveCast(st, st.outline.cast[6].id);
    const han = studioAddCast(st, { name: '韩露', age: '31', identity: '机长' });
    st.openers[st.outline.stages[0].id] = '新的第一段开场白，海风吹过残骸。';
    const r = buildStudioCard(p, s, st);
    assert.equal(r.created, false);
    assert.equal(r.card.id, first.id);
    assert.equal(p.cards.length, 1);
    assert.equal(p.cards[0], r.card);
    assert.equal(r.card.stAvatar, 'huangdao.png');
    assert.equal(r.card.ownWorldName, '《荒岛》世界书·荒岛七日');
    assert.equal(r.card.avatarDataUrl, 'data:image/png;base64,AAAA');
    assert.equal(r.card.data.system_prompt, '用户自己写的系统提示');
    assert.equal(r.card.data.first_mes, '新的第一段开场白，海风吹过残骸。');
    assert.ok(Object.keys(p.characters).includes('苏晴晴') && !p.characters['苏晴']);
    assert.equal(p.relationships[0].from, '苏晴晴', '关系图谱跟着改名');
    assert.ok(!p.characters['顾青']);
    assert.deepEqual(r.saved.removed.characters, ['顾青']);
    assert.ok(p.characters['韩露']);
    assert.equal(r.card.studio.keys[han.id], '韩露');
    assert.ok(Object.keys(r.card.statusBar.spec.variables[0].init).includes('韩露'), '新加的角色补进「主要角色」');
    assert.ok(r.warnings.some((w) => w.includes('韩露')));
    assert.ok(studioOwnEntries(s, r.card).some((e) => e.name === '韩露'));
    // 再更新一次不会多出带后缀的副本
    buildStudioCard(p, s, st);
    assert.ok(!Object.keys(p.characters).some((k) => k.includes('（原创')));
    assert.equal(Object.keys(p.characters).length, 7);
    // 卡在角色卡页被删掉了：重新生成的卡沿用原来的 id，存进项目的角色仍算它的（不会另存「林晚（原创）」）
    p.cards = [];
    const again = buildStudioCard(p, s, st);
    assert.equal(again.created, true);
    assert.equal(again.card.id, first.id);
    assert.ok(!Object.keys(p.characters).some((k) => k.includes('（原创')));
    assert.equal(p.characters['林晚'].originalCardId, first.id);
});

test('撞名：项目里已经有同名的别人的角色 / 条目——默认加后缀另存（卡里的名字留作别名，写入时不带原来那份）；选覆盖时替换；更新时沿用另存的名字', async () => {
    const s = settings();
    const p = createProject({ name: '原著' });
    mergeCharacter(p, { name: '林晚', identity: '原著里的林晚', importance: 'main' }, 0);
    p.worldbook['地点'] = { 淡水潭: { name: '淡水潭', keywords: ['淡水潭'], content: '原著的潭', sourceChunks: [0], revisions: [], config: {} } };
    const { st } = await fullStudio(s, p);
    const plan = studioSavePlan(p, s, st);
    assert.deepEqual(plan.collisions.map((c) => [c.type, c.name, c.via]), [['character', '林晚', 'name'], ['entry', '淡水潭', 'name']]);
    assert.equal(plan.canOverwrite, true);
    const r = buildStudioCard(p, s, st);
    assert.equal(p.characters['林晚'].identity, '原著里的林晚', '原来的没动');
    const saved = p.characters['林晚（原创）'];
    assert.ok(saved && saved.aliases.includes('林晚') && saved.originalShadow === '林晚');
    assert.equal(p.worldbook['地点']['淡水潭（原创）'].originalCardId, r.card.id);
    const prep = prepareCard(p, s, r.card);
    const lin = prep.entries.filter((e) => e.category === '角色' && e.keywords.includes('林晚'));
    assert.equal(lin.length, 1, '原著的林晚和另存的副本都不带，只有本卡条目');
    assert.ok(lin[0].content.includes('秘密（只有旁白知道）'));
    // 更新：继续用另存的名字，不会出现「林晚（原创2）」
    buildStudioCard(p, s, st);
    assert.ok(!p.characters['林晚（原创2）'] && p.characters['林晚（原创）']);
    assert.deepEqual(studioSavePlan(p, s, st).collisions, [], '以前另存过的不再算撞名');
    // 另一个项目里选覆盖
    const p2 = createProject({ name: '原著2' });
    mergeCharacter(p2, { name: '林晚', identity: '原著里的林晚', importance: 'main' }, 0);
    const { st: st2 } = await fullStudio(s, p2);
    buildStudioCard(p2, s, st2, { collision: 'overwrite' });
    assert.equal(p2.characters['林晚'].age, '22 岁');
    assert.ok(!p2.characters['林晚（原创）']);
});

test('角色卡页沿用：单字段重roll 走原创卡的提示词（已定下的人物和世界设定）；整卡重新生成仍是这份构思的卡，本卡条目跟着带过去', async () => {
    const { s, p, st } = await fullStudio();
    const card = buildStudioCard(p, s, st).card;
    const opt = cardPromptOpt(card);
    assert.equal(opt.source, 'original');
    assert.equal(opt.studioId, st.id);
    assert.equal(opt.studio, card.studio);
    const { prompt } = buildCardPrompt(p, s, { ...opt, askNotes: false });
    assert.ok(prompt.includes('卡名：荒岛七日（已经定下，不要改）'));
    assert.ok(prompt.includes('已定下的主要角色') && prompt.includes('姓名: 林晚'));
    assert.ok(prompt.includes('淡水只有岛中央的一处泉眼'));
    // 卡片名字改了时项目里的角色改名，卡上记的跟着改
    renameCharacter(p, '林晚', '林晚晚');
    assert.equal(card.original.characters[0].savedAs, '林晚晚');
});

test('卡的导向 / 用户画像 / {{user}} 的身份：卡上记快照（导向的本卡落点来自大纲）；写入时卡自己的世界书里有剧情导向、用户偏好、{{user}} 的身份', async () => {
    const s = settings();
    const prof = addUserProfile(s, { name: '足控党', likes: ['黑丝'], chatEntry: true }).id;
    const p = createEmptyProject({ name: '荒岛' });
    const st = addStudio(p, s, { premise: PREMISE, options: { profileId: prof, orientationId: 'orient_pure', userRole: { kind: 'custom', text: '{{user}} 是同机的退伍军医' } } });
    installTavern(studioAI({ outline: outlineReply({ extra: { orientation_notes: '- 林晚 会最先对 {{user}} 动心' } }) }));
    try {
        await generateOutline(p, s, st);
        await generateStudioContent(p, s, st);
    } finally {
        delete globalThis.SillyTavern;
    }
    const card = buildStudioCard(p, s, st).card;
    assert.equal(card.orientation.name, '纯爱');
    assert.equal(card.orientation.notes, '- 林晚 会最先对 {{user}} 动心');
    assert.equal(card.userProfile.name, '足控党');
    assert.deepEqual(card.userRole, { kind: 'custom', charKey: '', text: '{{user}} 是同机的退伍军医' });
    assert.ok(card.data.tags.includes('纯爱'));
    const comments = prepareCard(p, s, card).entries.map((e) => e.comment || `${e.category} - ${e.name}`);
    for (const t of ['剧情导向：纯爱', '用户偏好', '{{user}} 的身份', '剧情 - 故事阶段', '角色 - 林晚']) assert.ok(comments.includes(t), t);
    const sum = studioCardSummary(p, s, st);
    assert.equal(sum.problem, '');
    assert.deepEqual(sum.entries, { characters: 7, locations: 2, stages: 1, total: 10 });
    // 写入时另加的常驻条目（第 4 步的条数把它们也算上）
    assert.deepEqual(sum.extras, ['剧情导向「纯爱」', '用户偏好「足控党」', '{{user}} 的身份']);
    assert.equal(sum.greetings, 3);
    assert.deepEqual(sum.missingOpeners, []);
    assert.equal(sum.orientation, '纯爱');
    assert.equal(sum.profile, '足控党');
    assert.equal(sum.userRole, '自定义：{{user}} 是同机的退伍军医');
    assert.equal(sum.card, card);
    assert.equal(sum.statusBar, true);
    assert.equal(sum.examples, true);
});

test('publishCard：写入卡自己的世界书，有 7 个角色条目、故事阶段、地点；开场白 = 阶段', async () => {
    const { s, p, st } = await fullStudio();
    const card = buildStudioCard(p, s, st).card;
    const saved = { worlds: {}, files: [] };
    const ctx = {
        name1: 'User', characters: [], getRequestHeaders: () => ({}), async saveWorldInfo(n, d) { saved.worlds[n] = structuredClone(d); }, async updateWorldInfoList() {},
        async getCharacters() {}, extensionSettings: {}, saveSettingsDebounced() {},
    };
    globalThis.SillyTavern = { getContext: () => ctx };
    const origFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
        if (url === '/api/characters/import') {
            saved.files.push(init.body.get('avatar'));
            return new Response(JSON.stringify({ file_name: 'huangdao' }), { status: 200 });
        }
        return new Response('{}', { status: 404 });
    };
    try {
        const r = await publishCard(p, s, card);
        assert.equal(r.ownWorld, true);
        const comments = Object.values(saved.worlds[r.worldName].entries).map((e) => e.comment);
        assert.equal(comments.filter((c) => c.startsWith('角色 - ')).length, 7);
        assert.ok(comments.includes('剧情 - 故事阶段') && comments.includes('地点 - 淡水潭'));
        const json = JSON.parse(await saved.files[0].text());
        assert.equal(json.data.alternate_greetings.length, st.outline.stages.length - 1);
        assert.equal(json.data.extensions.world, r.worldName);
        assert.equal(card.ownWorldName, r.worldName);
    } finally {
        globalThis.fetch = origFetch;
        delete globalThis.SillyTavern;
    }
});

test('状态栏：默认套用「多人群像」；沿用结构时把大纲里的角色预先填进「主要角色」；AI 只填初始值和规则', async () => {
    const { s, p, st } = await fullStudio();
    const card = buildStudioCard(p, s, st).card;
    assert.equal(studioStatusBarTemplateId(s), 'builtin_ensemble');
    assert.equal(studioStatusBarTemplateId({ ...s, studio: { ...s.studio, statusBarTemplateId: '' } }), '');
    assert.equal(studioStatusBarTemplateId({ ...s, studio: { ...s.studio, statusBarTemplateId: 'gone' } }), '');
    // 不调用 AI 的那一步：套用模板就预填了主要角色
    const probe = structuredClone(card);
    const res = applyStatusBarTemplate(probe, getStatusBarTemplate(s, 'builtin_ensemble'), 'structure', { settings: s, project: p });
    const cast = probe.statusBar.spec.variables.find((v) => v.path === '主要角色');
    assert.deepEqual(Object.keys(cast.init).slice(0, 7), NAMES);
    assert.deepEqual(res.ai, { parts: ['init', 'rules'], templateMode: 'structure' });
    // 整个流程：AI 照着变量表回填
    const seen = installTavern((text) => {
        const vars = JSON.parse(text.match(/<变量表>\n([\s\S]*?)\n<\/变量表>/)[1]);
        return `\`\`\`json\n${JSON.stringify({ variables: vars.map((v) => ({ path: v.path, init: v.init, check: ['按剧情更新'] })) })}\n\`\`\``;
    });
    try {
        const r = await generateStudioStatusBar(p, s, card);
        assert.equal(seen.length, 1);
        assert.equal(r.statusBar.templateId, 'builtin_ensemble');
        assert.equal(r.statusBar.enabled, true);
        assert.deepEqual(Object.keys(r.statusBar.spec.variables.find((v) => v.path === '主要角色').init).slice(0, 7), NAMES);
    } finally {
        delete globalThis.SillyTavern;
    }
});

test('状态栏预填：12 个人的阵容全部填进「主要角色」（项目里的角色仍默认最多 8 个）', async () => {
    const names = ['林晚', '苏晴', '许若', '陈曦', '周岚', '叶棠', '顾青', '沈墨', '白露', '唐恬', '温妤', '江遥'];
    const s = settings();
    const p = createEmptyProject({ name: '十二人' });
    const st = addStudio(p, s, { premise: '十二个人困在雪山旅馆' });
    installTavern(studioAI({ outline: outlineReply({ names }) }));
    try {
        await generateOutline(p, s, st);
        await generateStudioContent(p, s, st);
    } finally {
        delete globalThis.SillyTavern;
    }
    assert.equal(st.outline.cast.length, 12);
    const card = buildStudioCard(p, s, st).card;
    assert.deepEqual(worldCastNames(p, card), names);
    assert.deepEqual(worldCastNames(p, card, { limit: 3 }), names.slice(0, 3), '明确给了上限时照办');
    const probe = structuredClone(card);
    applyStatusBarTemplate(probe, getStatusBarTemplate(s, 'builtin_ensemble'), 'structure', { settings: s, project: p });
    assert.deepEqual(Object.keys(probe.statusBar.spec.variables.find((v) => v.path === '主要角色').init).filter((n) => names.includes(n)), names);
});

test('设置：创意工坊的默认选项（开场白长度、状态栏、示例对话、状态栏模板）；新构思用它；导入配置合并；立绘提示词一键复制', async () => {
    const s = settings();
    assert.deepEqual(s.studio, { openerLen: '400-800 字', statusBar: true, examples: true, statusBarTemplateId: 'builtin_ensemble' });
    s.studio.openerLen = '200-400 字';
    s.studio.examples = false;
    const st = createStudio(s, { premise: 'x' });
    assert.equal(st.options.openerLen, '200-400 字');
    assert.equal(st.options.examples, false);
    applyConfig(s, { type: 'novel_loom_config', settings: { studio: { statusBar: false } } });
    assert.equal(s.studio.statusBar, false);
    assert.equal(s.studio.openerLen, '200-400 字');
    const { st: full } = await fullStudio();
    const text = studioPortraitPromptsText(full);
    assert.ok(text.startsWith('【林晚】\nadult, woman, short hair, scar\n\n【苏晴】'));
    assert.equal(text.split('\n\n').length, 7);
});

test('rerollOpener：只重写这一个阶段，别的阶段不动；出错时记下原因', async () => {
    const { s, p, st } = await fullStudio();
    const [a, b] = st.outline.stages;
    const keep = st.openers[a.id];
    installTavern('火光里，苏晴把最后一瓶水举起来：“谁先喝？”');
    try {
        const t = await rerollOpener(p, s, st, b.id, { instruction: '更紧张' });
        assert.equal(t, '火光里，苏晴把最后一瓶水举起来：“谁先喝？”');
        assert.equal(st.openers[a.id], keep);
        installTavern('好');
        await assert.rejects(rerollOpener(p, s, st, b.id), /没有返回开场白/);
        assert.match(st.errors[b.id], /没有返回开场白/);
        assert.equal(st.openers[b.id], '火光里，苏晴把最后一瓶水举起来：“谁先喝？”', '失败时保留原来的');
    } finally {
        delete globalThis.SillyTavern;
    }
});

test('app.createStudioProject：新建原创项目（名字用创意里的短标题，重名时加序号）并把构思放进去；运行中的创意工坊任务算作忙', async () => {
    const { app } = await import('../src/app.js');
    app.settings = settings();
    const a = await app.createStudioProject({ premise: PREMISE, options: { count: 7 } });
    assert.equal(a.project.name, '飞机失事');
    assert.equal(a.project.original, true);
    assert.equal(a.studio.premise, PREMISE);
    assert.equal(a.studio.options.count, 7);
    assert.equal(a.studio.title, '', '没给标题：草稿列表跟着大纲里的卡名走');
    assert.equal(getStudio(app.project, a.studio.id), a.studio);
    const t = await app.createStudioProject({ title: '荒岛', premise: PREMISE });
    assert.equal(t.project.name, '荒岛');
    assert.equal(t.studio.title, '荒岛');
    const b = await app.createStudioProject({ premise: PREMISE });
    assert.equal(b.project.name, '飞机失事 2');
    let busyInside = false;
    const out = await app.runStudioJob({ studioId: b.studio.id, label: '全部生成' }, async (signal) => {
        busyInside = app.isBusy() && !signal.aborted;
        await assert.rejects(app.runStudioJob({}, async () => {}), /已有任务在运行/);
        app.stopStudioJob();
        return signal.aborted;
    });
    assert.equal(busyInside, true);
    assert.equal(out, true);
    assert.equal(app.isBusy(), false);
    assert.equal(app.studioJob, null);
});

test('prompts 的 getPrompt：用户改过的创意工坊提示词生效；角色提示词缺 {JSON_TEMPLATE} 时追加', () => {
    const s = settings();
    s.prompts.studioCharacter = '展开角色细节：{NAME}';
    const p = createEmptyProject({ name: '荒岛' });
    const st = addStudio(p, s, { premise: PREMISE });
    st.outline = parseStudioOutline(outlineReply()).outline;
    assert.equal(getPrompt(s, 'studioCharacter'), '展开角色细节：{NAME}');
    const { prompt } = buildCharacterPrompt(p, s, st, st.outline.cast[0].id);
    assert.ok(prompt.startsWith('展开角色细节：林晚'));
    assert.ok(prompt.includes('# 输出 JSON 模板\n{\n  "appearance"'));
});

// ---------------- 审查后的修正（v0.18） ----------------

test('只填了一部分的角色：算「部分填写」；「全部生成」补全它（写了的几项原样保留，提示词写明是补全）；只重写一项不算整个展开；全部重写时整个重写', async () => {
    const s = settings();
    const p = createEmptyProject({ name: '荒岛' });
    const st = addStudio(p, s, { premise: PREMISE });
    st.outline = parseStudioOutline(outlineReply()).outline;
    const [a, b, c] = st.outline.cast;
    updateStudio(p, st.id, { details: { [a.id]: { appearance: '我写的外貌', secret: { content: '我写的秘密' } } } });
    assert.equal(studioCastStatus(st, a.id), 'partial');
    const seen = installTavern(studioAI());
    try {
        const r = await generateCharacterDetails(p, s, st, { ids: [a.id] });
        assert.deepEqual(r.done, [a.id]);
        assert.ok(seen[0].includes('# 这次是补全') && seen[0].includes('外貌: 我写的外貌') && seen[0].includes('原样保留'), seen[0].slice(-800));
        const d = st.details[a.id];
        assert.equal(d.appearance, '我写的外貌', '写了的保留');
        assert.equal(d.secret.content, '我写的秘密');
        assert.equal(d.secret.hints, '常独自去海边\n口袋鼓着', '秘密里没写的小项用 AI 的');
        assert.equal(d.personality, characterReply('林晚').personality, '没写的补上');
        assert.ok(d.generatedAt > 0);
        assert.equal(studioCastStatus(st, a.id), 'done');
        // 只重写一项（还没展开过的角色）：只算部分填写，不会被「全部生成」跳过
        installTavern(JSON.stringify({ personality: '底色: 暴躁' }));
        await rerollCharacterField(p, s, st, b.id, 'personality');
        assert.equal(st.details[b.id].generatedAt, 0);
        assert.equal(studioCastStatus(st, b.id), 'partial');
        assert.ok(studioCardSummary(p, s, st).missingDetails.includes('苏晴'), '第 4 步算还没展开完');
        // 全部重写：部分填写的也整个重写（不保留）
        updateStudio(p, st.id, { details: { [c.id]: { appearance: '手写的' } } });
        installTavern(studioAI());
        await generateCharacterDetails(p, s, st, { ids: [c.id], overwrite: true });
        assert.equal(st.details[c.id].appearance, characterReply('许若').appearance);
    } finally {
        delete globalThis.SillyTavern;
    }
});

test('在「角色」页给创意工坊存进项目的角色改了名：更新卡片时不当成去掉的角色删掉，备注和关系都保留（改回卡里的名字）', async () => {
    const { s, p, st } = await fullStudio();
    const card = buildStudioCard(p, s, st).card;
    const lin = st.outline.cast[0];
    p.characters['林晚'].notes = '用户写的备注';
    p.relationships = [{ id: 'r1', from: '苏晴', to: '林晚', type: 'friend', label: '', mutual: true }];
    renameCharacter(p, '林晚', '林晚晚');
    assert.equal(card.studio.keys[lin.id], '林晚晚', '卡上记的项目名字跟着改');
    assert.equal(card.original.characters[0].savedAs, '林晚晚');
    const r = buildStudioCard(p, s, st);
    assert.deepEqual(r.saved.removed.characters, []);
    assert.ok(p.characters['林晚'] && !p.characters['林晚晚']);
    assert.equal(p.characters['林晚'].notes, '用户写的备注');
    assert.equal(p.relationships.length, 1);
    assert.deepEqual([p.relationships[0].from, p.relationships[0].to], ['苏晴', '林晚']);
    assert.equal(r.card.studio.keys[lin.id], '林晚');
});

test('更新卡片：状态栏里按角色记的初始条目跟着阵容改名 / 删人（按角色 id 对上，值和位置不变），手动加的条目不动；[initvar] 里没有旧名字；标记为可能过时', async () => {
    const { s, p, st } = await fullStudio();
    const first = buildStudioCard(p, s, st).card;
    applyStatusBarTemplate(first, getStatusBarTemplate(s, 'builtin_ensemble'), 'structure', { settings: s, project: p });
    first.statusBar.enabled = true;
    const castVar = (c) => c.statusBar.spec.variables.find((v) => v.path === '主要角色');
    castVar(first).init['路人甲'] = structuredClone(castVar(first).init['林晚']);
    castVar(first).init['苏晴'] = { ...castVar(first).init['苏晴'], 好感: 42 };
    const suqing = structuredClone(castVar(first).init['苏晴']);
    const prevSpec = structuredClone(first.statusBar.spec);
    st.outline.cast[1].name = '苏晴晴';
    studioRemoveCast(st, st.outline.cast[6].id); // 顾青
    const r = buildStudioCard(p, s, st);
    const init = castVar(r.card).init;
    assert.deepEqual(init['苏晴晴'], suqing, '改名的角色带着原来的值');
    assert.ok(!('苏晴' in init) && !('顾青' in init), Object.keys(init).join('、'));
    assert.ok('路人甲' in init, '不是阵容里的条目不动');
    assert.deepEqual(Object.keys(init).slice(0, 2), ['林晚', '苏晴晴'], '位置不变');
    assert.equal(r.card.statusBar.stale, true);
    assert.deepEqual(first.statusBar.spec, prevSpec, '上一张卡的状态栏没被改');
    assert.ok(r.warnings.some((w) => w.includes('苏晴 → 苏晴晴') && w.includes('已删掉 顾青')), r.warnings.join('\n'));
    const initvar = prepareCard(p, s, r.card).entries.find((e) => String(e.comment || e.name || '').includes('[initvar]'));
    assert.ok(initvar, '有 [initvar] 条目');
    assert.ok(initvar.content.includes('苏晴晴') && !/苏晴(?!晴)/.test(initvar.content.replace(/苏晴晴/g, '')) && !initvar.content.includes('顾青'), initvar.content.slice(0, 400));
    // 阵容没变时再更新：不改、不标记
    r.card.statusBar.stale = false;
    const again = buildStudioCard(p, s, st);
    assert.equal(again.card.statusBar.stale, false);
    assert.ok(!again.warnings.some((w) => w.includes('角色阵容变了')));
});

test('流程清单：原创项目里有构思时下一步是「创意工坊」（写明在第几步）；做成卡后没有必做的步骤；小说项目不加这一步', async () => {
    const { pipelineState } = await import('../src/ui/pipeline.js');
    const s = settings();
    const p = createEmptyProject({ name: '原创' });
    addStudio(p, s, { premise: PREMISE });
    const ps = pipelineState(p);
    assert.equal(ps.next.tab, 'studio');
    assert.deepEqual(ps.steps.map((x) => x.tab), ['studio', 'cards', 'characters', 'worldbook', 'relations', 'style']);
    assert.equal(ps.steps[0].note, '第 1 步');
    const { s: s2, p: p2, st } = await fullStudio();
    assert.equal(pipelineState(p2).next.tab, 'studio');
    buildStudioCard(p2, s2, st);
    assert.equal(pipelineState(p2).next, null);
    assert.ok(pipelineState(p2).steps[0].ok);
    const novel = createProject({ name: '小说', text: '第一章\n正文', chunks: [{ index: 0, title: '第一章', text: '正文', start: 0, end: 2, origin: 'source' }] });
    novel.studios = [createStudio(s, { premise: PREMISE })];
    assert.ok(pipelineState(novel).steps.some((x) => x.tab === 'chunks'), '是小说项目');
    assert.ok(!pipelineState(novel).steps.some((x) => x.tab === 'studio'));
});

test('提示词：导向落点给写角色、开场白的 AI 看（每个角色的位置以落点为准）；没有原著不说「优先从原著选取」；第二人称时旁白用“你”、其他叙事偏好用 {{user}}；性别没写时立绘模板只写 adult', () => {
    const s = settings();
    const second = addUserProfile(s, { name: '第二人称', style: '第二人称“你”' }).id;
    const p = createEmptyProject({ name: '荒岛' });
    const st = addStudio(p, s, { premise: PREMISE, options: { orientationId: 'orient_harem', profileId: second } });
    st.outline = parseStudioOutline(outlineReply({ extra: { orientation_notes: '- 林晚和苏晴都会倾心于 {{user}}\n- 叶棠是竞争的导火索' } })).outline;
    const gu = st.outline.cast[6];
    const cp = buildCharacterPrompt(p, s, st, gu.id).prompt;
    assert.ok(cp.includes('## 剧情导向的落点\n- 林晚和苏晴都会倾心于 {{user}}\n- 叶棠是竞争的导火索'), cp.slice(0, 1200));
    assert.ok(cp.includes('每个角色在导向里的位置以大纲里的「剧情导向的落点」为准（不是每个角色都要倾心于 {{user}}）'));
    assert.ok(!cp.includes('优先从原著选取') && cp.includes('（从大纲里的角色中选）'));
    const op = buildOpenerPrompt(p, s, st, st.outline.stages[1].id).prompt;
    assert.ok(op.includes('## 剧情导向的落点') && op.includes('以大纲里的「剧情导向的落点」为准'));
    assert.ok(op.includes('旁白里用“你”指代 {{user}}，全篇统一') && !op.includes('用 {{user}} 指代用户'));
    assert.ok(op.includes('不描写 {{user}} 的心理活动和情绪'));
    // 大纲提示词本身要 AI 写落点：不加「以落点为准」那一句
    assert.ok(!buildOutlinePrompt(p, s, st).prompt.includes('以大纲里的「剧情导向的落点」为准'));
    // 别的叙事偏好：提到用户时写 {{user}}
    st.options.profileId = addUserProfile(s, { name: '第三人称', style: '第三人称全知' }).id;
    assert.ok(buildOpenerPrompt(p, s, st, st.outline.stages[1].id).prompt.includes('叙事偏好：第三人称全知（按这个写）；提到用户时写 {{user}}。'));
    // 立绘模板的性别：没写时只写 adult；英文也认
    gu.gender = '';
    assert.ok(buildCharacterPrompt(p, s, st, gu.id).prompt.includes('"portrait_prompt": "adult, ……"'));
    gu.gender = 'female';
    assert.ok(buildCharacterPrompt(p, s, st, gu.id).prompt.includes('"portrait_prompt": "adult woman, ……"'));
    gu.gender = 'male';
    assert.ok(buildCharacterPrompt(p, s, st, gu.id).prompt.includes('"portrait_prompt": "adult man, ……"'));
});

test('换掉一个角色 / 阶段删光：导向落点或阶段里还写着被换掉的人时提醒；阶段删光了也能只重新生成阶段', async () => {
    const cur = parseStudioOutline(outlineReply({ extra: { orientation_notes: '- 许若 会最先对 {{user}} 动心' } })).outline;
    cur.stages[0].summary = '许若 带头找水。';
    const m = parseStudioOutline({ member: { name: '韩露', age: '31', identity: '机长' } }, { mode: 'member', current: cur, memberId: cur.cast[2].id });
    assert.ok(m.warnings.some((w) => w.includes('导向落点、第 1 阶段里还提到「许若」')), m.warnings.join('\n'));
    assert.equal(m.outline.orientationNotes, cur.orientationNotes, '不自动替换');
    const s = settings();
    const p = createEmptyProject({ name: '荒岛' });
    const st = addStudio(p, s, { premise: PREMISE });
    st.outline = parseStudioOutline(outlineReply()).outline;
    for (const x of [...st.outline.stages]) studioRemoveStage(st, x.id);
    installTavern(JSON.stringify({ stages: outlineReply().stages }));
    try {
        await generateOutline(p, s, st, { mode: 'stages' });
        assert.equal(st.outline.stages.length, 3);
    } finally {
        delete globalThis.SillyTavern;
    }
});

test('草稿改过、卡还没更新：按草稿组装出来的内容和卡上记的指纹不同才算；改步骤、在角色卡页改卡不算；更新卡片后恢复', async () => {
    const { s, p, st } = await fullStudio();
    assert.equal(studioCardStale(p, s, st), false, '还没有卡');
    const card = buildStudioCard(p, s, st).card;
    assert.ok(card.studio.contentKey);
    assert.equal(studioCardStale(p, s, st), false);
    updateStudio(p, st.id, { step: 2 });
    renameStudio(p, st.id, '别的名字');
    assert.equal(studioCardStale(p, s, st), false, '改步骤、给构思改名不算');
    card.data.description = '在角色卡页改过';
    assert.equal(studioCardStale(p, s, st), false, '在角色卡页直接改卡不算');
    updateStudio(p, st.id, { openers: { [st.outline.stages[0].id]: '改过的开场白，海风吹过残骸。' } });
    assert.equal(studioCardStale(p, s, st), true);
    assert.equal(studioCardSummary(p, s, st).stale, true);
    buildStudioCard(p, s, st);
    assert.equal(studioCardStale(p, s, st), false);
    // 改了会进卡的选项（不带示例对话）也算
    updateStudio(p, st.id, { options: { examples: false } });
    assert.equal(studioCardStale(p, s, st), true);
    assert.equal(studioCardContentKey(p, s, createStudio(s, { premise: 'x' })), '', '还不能做成卡');
});

test('大纲表格里给角色改名（同一个人）：导向落点、阶段的处境和冲突里的旧名字跟着改；一个字的旧名字不替换', () => {
    const s = settings();
    const p = createEmptyProject({ name: '荒岛' });
    const st = addStudio(p, s, { premise: PREMISE });
    st.outline = parseStudioOutline(outlineReply({ extra: { orientation_notes: '- 许若 会最先对 {{user}} 动心' } })).outline;
    st.outline.stages[1].conflict = '许若 和 苏晴 争水';
    const xu = st.outline.cast[2];
    const { patch, where } = studioRenameCastPatch(st, xu.id, ' 许若若 ');
    assert.deepEqual(where, ['导向落点', '故事阶段']);
    updateStudio(p, st.id, { outline: patch });
    assert.equal(st.outline.cast[2].name, '许若若');
    assert.equal(st.outline.cast[2].id, xu.id);
    assert.equal(st.outline.orientationNotes, '- 许若若 会最先对 {{user}} 动心');
    assert.equal(st.outline.stages[1].conflict, '许若若 和 苏晴 争水');
    assert.equal(st.outline.stages[0].summary, '残骸起火，众人四散。');
    st.outline.cast[3].name = '甲';
    st.outline.orientationNotes = '- 甲板上的人';
    assert.deepEqual(studioRenameCastPatch(st, st.outline.cast[3].id, '乙丙').where, []);
});
