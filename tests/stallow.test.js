// v0.15：写入酒馆后自动允许本卡的局部正则（酒馆 character_allowed_regex）与酒馆助手角色脚本（JS-Slash-Runner 的 pinia store，退而改 extension_settings）
import test from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_CATEGORIES, DEFAULT_SETTINGS } from '../src/constants.js';
import { mergeDefaults } from '../src/utils.js';
import { createProject, mergeCharacter } from '../src/project.js';
import { buildChunks, detectChapters } from '../src/splitter.js';
import { publishCard } from '../src/publish.js';
import { ensureStatusBar, normalizeStatusSpec } from '../src/statusbar.js';
import {
    allowCardRegex, autoAllowCard, avatarFileName, cardHasHelperScripts, cardHasScopedRegex, cardScriptsEnabled, enableCardScripts, jsrSettingsStore,
} from '../src/stallow.js';

function settings() {
    const s = mergeDefaults({}, DEFAULT_SETTINGS);
    s.categories = structuredClone(DEFAULT_CATEGORIES);
    return s;
}

/** 酒馆上下文：extensionSettings + 记录 saveSettingsDebounced 调用次数 */
function stCtx(extensionSettings = {}) {
    const ctx = { extensionSettings, saves: 0 };
    ctx.saveSettingsDebounced = () => {
        ctx.saves++;
    };
    return ctx;
}

/**
 * 假的酒馆助手：#tavern_helper 元素上挂 Vue 应用（__vue_app__.config.globalProperties.$pinia._s 是 store 的 Map），
 * store 'global_settings' 的 settings 与酒馆助手 4.x 的 GlobalSettings 同形（script.enabled / popuped 的 characters、presets）。
 */
function jsrDoc({ enabled = ['other.png'], popuped = ['other.png'] } = {}) {
    const store = { settings: { script: { enabled: { global: true, presets: [], characters: [...enabled] }, popuped: { presets: [], characters: [...popuped] }, scripts: [] } } };
    const el = { __vue_app__: { config: { globalProperties: { $pinia: { _s: new Map([['global_settings', store], ['character_setttings', {}]]) } } } } };
    return { store, doc: { getElementById: (id) => (id === 'tavern_helper' ? el : null) } };
}

const CARD_JSON = {
    spec: 'chara_card_v3',
    name: '莉莉丝',
    data: {
        name: '莉莉丝',
        extensions: {
            regex_scripts: [{ id: 'r1', scriptName: '状态栏', findRegex: '<StatusPlaceHolderImpl/>' }],
            tavern_helper: { scripts: [{ type: 'script', enabled: true, name: 'MVU', id: 's1', content: "import 'x';" }], variables: {} },
        },
    },
};

test('avatarFileName / cardHasScopedRegex / cardHasHelperScripts', () => {
    assert.equal(avatarFileName('card_1'), 'card_1.png');
    assert.equal(avatarFileName('card_1.png'), 'card_1.png');
    assert.equal(avatarFileName(''), '');
    assert.equal(cardHasScopedRegex(CARD_JSON), true);
    assert.equal(cardHasHelperScripts(CARD_JSON), true);
    assert.equal(cardHasScopedRegex({ data: { extensions: { regex_scripts: [] } } }), false);
    assert.equal(cardHasHelperScripts({ data: { extensions: { tavern_helper: { scripts: [], variables: {} } } } }), false);
    assert.equal(cardHasHelperScripts({ data: { extensions: { tavern_helper: [['scripts', [{ id: 'a' }]], ['variables', {}]] } } }), true, '旧的 [[键, 值]] 写法');
    assert.equal(cardHasScopedRegex(null), false);
    assert.equal(cardHasHelperScripts({}), false);
});

test('allowCardRegex：没有名单时新建，加上本卡（带 .png）并保存；已在名单里不重复；不动其他角色', () => {
    const ctx = stCtx({});
    assert.deepEqual(allowCardRegex('card_1', ctx), { status: 'added' });
    assert.deepEqual(ctx.extensionSettings.character_allowed_regex, ['card_1.png']);
    assert.equal(ctx.saves, 1);
    assert.deepEqual(allowCardRegex('card_1.png', ctx), { status: 'already' });
    assert.equal(ctx.saves, 1, '已允许时不再保存');
    const ctx2 = stCtx({ character_allowed_regex: ['a.png', 'b.png'] });
    allowCardRegex('c', ctx2);
    assert.deepEqual(ctx2.extensionSettings.character_allowed_regex, ['a.png', 'b.png', 'c.png']);
    assert.equal(allowCardRegex('', ctx2).status, 'failed');
    const bad = allowCardRegex('x', {});
    assert.equal(bad.status, 'failed');
    assert.match(bad.error, /扩展设置/);
});

test('enableCardScripts：优先改酒馆助手的 store（启用 + 不再弹窗），由它自己保存；extension_settings 不动', () => {
    const { store, doc } = jsrDoc();
    const ctx = stCtx({ tavern_helper: { script: { enabled: { characters: ['other.png'] }, popuped: { characters: [] } } } });
    assert.equal(jsrSettingsStore(doc), store);
    assert.deepEqual(enableCardScripts('card_1', { ctx, doc }), { status: 'store' });
    assert.deepEqual(store.settings.script.enabled.characters, ['other.png', 'card_1.png']);
    assert.deepEqual(store.settings.script.popuped.characters, ['other.png', 'card_1.png']);
    assert.equal(ctx.saves, 0, '酒馆助手的 watch 会保存，这里不调用');
    assert.deepEqual(ctx.extensionSettings.tavern_helper.script.enabled.characters, ['other.png'], '没有直接改 extension_settings');
    assert.deepEqual(enableCardScripts('card_1.png', { ctx, doc }), { status: 'already' });
    assert.equal(store.settings.script.enabled.characters.length, 2);
    assert.equal(cardScriptsEnabled('card_1', { ctx, doc }), true);
    assert.equal(cardScriptsEnabled('card_2', { ctx, doc }), false);
});

test('enableCardScripts：找不到 store 时改 extension_settings.tavern_helper 并保存（刷新后生效）；两样都没有时 missing', () => {
    const ctx = stCtx({ tavern_helper: { script: { enabled: { characters: ['other.png'] }, popuped: { characters: [] } } } });
    const noJsr = { getElementById: () => null };
    assert.equal(jsrSettingsStore(noJsr), null);
    assert.deepEqual(enableCardScripts('card_1', { ctx, doc: noJsr }), { status: 'fallback' });
    assert.deepEqual(ctx.extensionSettings.tavern_helper.script.enabled.characters, ['other.png', 'card_1.png']);
    assert.deepEqual(ctx.extensionSettings.tavern_helper.script.popuped.characters, ['card_1.png']);
    assert.equal(ctx.saves, 1);
    assert.deepEqual(enableCardScripts('card_1', { ctx, doc: noJsr }), { status: 'already' });
    assert.equal(cardScriptsEnabled('card_1', { ctx, doc: noJsr }), true);
    // 形状不对的 store（别的版本）当作没有
    const weird = { getElementById: () => ({ __vue_app__: { config: { globalProperties: { $pinia: { _s: new Map([['global_settings', { settings: {} }]]) } } } } }) };
    assert.equal(jsrSettingsStore(weird), null);
    // 读属性就抛错的元素也不会让写入失败
    const throwing = { getElementById: () => ({ get __vue_app__() { throw new Error('boom'); } }) };
    assert.equal(jsrSettingsStore(throwing), null);
    const none = stCtx({});
    assert.deepEqual(enableCardScripts('card_1', { ctx: none, doc: noJsr }), { status: 'missing' });
    assert.equal(cardScriptsEnabled('card_1', { ctx: none, doc: noJsr }), null);
    assert.equal(enableCardScripts('', { ctx, doc: noJsr }).status, 'failed');
});

test('autoAllowCard：设置关掉或卡片没有正则 / 脚本时什么都不做；否则两样都授权并记一行中文日志', () => {
    const s = settings();
    assert.equal(s.cards.autoAllow, true, '默认开');
    const logs = [];
    const onLog = (m, l) => logs.push([m, l]);
    const { store, doc } = jsrDoc();
    const ctx = stCtx({});

    s.cards.autoAllow = false;
    assert.equal(autoAllowCard(s, CARD_JSON, 'card_1', { onLog, ctx, doc }), null);
    assert.equal(ctx.extensionSettings.character_allowed_regex, undefined);
    s.cards.autoAllow = true;
    assert.equal(autoAllowCard(s, { data: { name: '普通卡', extensions: {} } }, 'card_1', { onLog, ctx, doc }), null);
    assert.equal(logs.length, 0);

    const r = autoAllowCard(s, CARD_JSON, 'card_1', { onLog, ctx, doc });
    assert.equal(r.regex.status, 'added');
    assert.equal(r.scripts.status, 'store');
    assert.equal(r.level, 'success');
    assert.deepEqual(ctx.extensionSettings.character_allowed_regex, ['card_1.png']);
    assert.ok(store.settings.script.enabled.characters.includes('card_1.png'));
    assert.deepEqual(logs.at(-1), ['自动授权「莉莉丝」：已允许局部正则；已启用角色脚本', 'success']);

    // 再写一次：都已授权
    autoAllowCard(s, CARD_JSON, 'card_1', { onLog, ctx, doc });
    assert.deepEqual(logs.at(-1), ['自动授权「莉莉丝」：局部正则早已允许；角色脚本早已启用', 'success']);

    // 找不到酒馆助手的 store：改 extension_settings，提示刷新（warn）
    const ctx2 = stCtx({ tavern_helper: { script: { enabled: { characters: [] }, popuped: { characters: [] } } } });
    const r2 = autoAllowCard(s, CARD_JSON, 'card_2', { onLog, ctx: ctx2, doc: { getElementById: () => null } });
    assert.equal(r2.scripts.status, 'fallback');
    assert.equal(r2.level, 'warn');
    assert.match(logs.at(-1)[0], /已允许局部正则；已启用角色脚本（写进了酒馆助手的设置，需要刷新酒馆页面后生效）/);

    // 没装酒馆助手：正则照样允许，脚本提示手动启用
    const r3 = autoAllowCard(s, CARD_JSON, 'card_3', { onLog, ctx: stCtx({}), doc: { getElementById: () => null } });
    assert.equal(r3.scripts.status, 'missing');
    assert.match(r3.message, /没有找到酒馆助手/);
    assert.equal(r3.level, 'warn');

    // 拿不到酒馆设置：失败原因写进日志，不抛错
    const r4 = autoAllowCard(s, { data: { name: '只有正则', extensions: { regex_scripts: [{ id: 'x' }] } } }, 'card_4', { onLog, ctx: null, doc: null });
    assert.equal(r4.scripts, null);
    assert.equal(r4.regex.status, 'failed');
    assert.match(r4.message, /^自动授权「只有正则」：允许局部正则失败（无法访问酒馆的扩展设置）/);
    assert.equal(r4.level, 'warn');
});

// ---------------- publishCard 集成 ----------------

const NOVEL = ['第一章 魔女小姐', '江酒走进酒吧。莉莉丝坐在角落。', '第二章 女仆', '江酒穿上了女仆装。'].join('\n');

function project() {
    const chunks = detectChapters(NOVEL, '^第.+章.*$').map((ch) => buildChunks([ch], 1000, false)[0]);
    chunks.forEach((c, i) => (c.index = i));
    const p = createProject({ name: '魔女', text: NOVEL, chunks });
    mergeCharacter(p, { name: '莉莉丝', identity: '大魔女', importance: 'main' }, 0);
    return p;
}

function card({ statusBar = true } = {}) {
    const c = {
        id: 'c1', kind: 'character', charName: '莉莉丝', timepoint: null, stAvatar: '', worldName: '',
        data: { name: '莉莉丝', description: 'd', personality: 'p', scenario: 's', first_mes: '雨夜。', alternate_greetings: [], mes_example: '<START>', system_prompt: '', post_history_instructions: '', creator_notes: '', tags: [] },
    };
    if (statusBar) {
        ensureStatusBar(c, settings());
        c.statusBar.spec = normalizeStatusSpec({ variables: [{ path: '莉莉丝.好感度', type: 'number', init: 20, min: 0, max: 100 }] });
        c.statusBar.mode = 'auto';
    }
    return c;
}

function installST(extensionSettings) {
    const ctx = { name1: 'User', characters: [], extensionSettings, saves: 0, getRequestHeaders: () => ({ 'Content-Type': 'application/json' }), async saveWorldInfo() {}, async updateWorldInfoList() {}, async getCharacters() {} };
    ctx.saveSettingsDebounced = () => {
        ctx.saves++;
    };
    globalThis.SillyTavern = { getContext: () => ctx };
    const origFetch = globalThis.fetch;
    let n = 0;
    globalThis.fetch = async (url) => {
        if (url === '/api/characters/import') {
            n++;
            ctx.characters.push({ avatar: `card_${n}.png` });
            return new Response(JSON.stringify({ file_name: `card_${n}` }), { status: 200 });
        }
        return new Response('{}', { status: 404 });
    };
    return { ctx, restore: () => { globalThis.fetch = origFetch; delete globalThis.SillyTavern; delete globalThis.document; } };
}

test('publishCard：写入成功后自动授权（store 路径），结果随返回值给出并写进 onLog；普通卡与关掉设置时不动', async () => {
    const { ctx, restore } = installST({ character_allowed_regex: ['old.png'] });
    const { store, doc } = jsrDoc({ enabled: [], popuped: [] });
    globalThis.document = doc;
    try {
        const s = settings();
        const logs = [];
        const c = card();
        const r = await publishCard(project(), s, c, { onLog: (m, l) => logs.push([m, l]) });
        assert.equal(c.stAvatar, 'card_1');
        assert.equal(r.allow.regex.status, 'added');
        assert.equal(r.allow.scripts.status, 'store');
        assert.deepEqual(ctx.extensionSettings.character_allowed_regex, ['old.png', 'card_1.png'], '其他角色的授权不变');
        assert.deepEqual(store.settings.script.enabled.characters, ['card_1.png']);
        assert.deepEqual(store.settings.script.popuped.characters, ['card_1.png']);
        assert.deepEqual(logs, [['自动授权「莉莉丝」：已允许局部正则；已启用角色脚本', 'success']]);

        // 普通卡（没有状态栏 = 没有正则和脚本）：不授权
        const plain = card({ statusBar: false });
        const r2 = await publishCard(project(), s, plain, { onLog: (m, l) => logs.push([m, l]) });
        assert.equal(r2.allow, null);
        assert.equal(ctx.extensionSettings.character_allowed_regex.includes('card_2.png'), false);

        // 关掉设置：不授权
        s.cards.autoAllow = false;
        const c3 = card();
        const r3 = await publishCard(project(), s, c3, { onLog: (m, l) => logs.push([m, l]) });
        assert.equal(r3.allow, null);
        assert.equal(ctx.extensionSettings.character_allowed_regex.includes('card_3.png'), false);
        assert.equal(store.settings.script.enabled.characters.includes('card_3.png'), false);
        assert.equal(logs.length, 1);
    } finally {
        restore();
    }
});

test('publishCard：没有酒馆助手的 store 时改 extension_settings.tavern_helper，日志提示刷新后生效', async () => {
    const { ctx, restore } = installST({ tavern_helper: { script: { enabled: { global: true, presets: [], characters: ['x.png'] }, popuped: { presets: [], characters: [] } } } });
    try {
        const logs = [];
        const r = await publishCard(project(), settings(), card(), { onLog: (m, l) => logs.push([m, l]) });
        assert.equal(r.allow.scripts.status, 'fallback');
        assert.deepEqual(ctx.extensionSettings.tavern_helper.script.enabled.characters, ['x.png', 'card_1.png']);
        assert.deepEqual(ctx.extensionSettings.character_allowed_regex, ['card_1.png']);
        assert.ok(ctx.saves >= 1);
        assert.equal(logs[0][1], 'warn');
        assert.match(logs[0][0], /需要刷新酒馆页面后生效/);
    } finally {
        restore();
    }
});

test('写入后的提示框：自动授权过的卡，「允许局部正则」「允许角色脚本」两步都标出已完成', async () => {
    const { statusBarPublishHintHtml } = await import('../src/ui/statusbar-dialog.js');
    const c = card();
    c.stAvatar = 'card_1';
    const es = { tavern_helper: { script: { enabled: { characters: [] }, popuped: { characters: [] } } } };
    globalThis.SillyTavern = { getContext: () => ({ extensionSettings: es, characters: [], saveSettingsDebounced() {} }) };
    try {
        const before = statusBarPublishHintHtml(c, 'w');
        assert.match(before, /data-act="sb-allow-regex"/);
        assert.doesNotMatch(before, /已启用/);
        autoAllowCard(settings(), CARD_JSON, c.stAvatar, { onLog: () => {} });
        const after = statusBarPublishHintHtml(c, 'w');
        assert.doesNotMatch(after, /data-act="sb-allow-regex"/);
        assert.match(after, /已允许/);
        assert.match(after, /已启用/);
    } finally {
        delete globalThis.SillyTavern;
    }
});
