// 状态栏 / MVU 变量系统：导出与写入酒馆（世界书条目覆盖、buildCardJson、prepareCard、publishCard、配置合并）
import test from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_CATEGORIES, DEFAULT_SETTINGS } from '../src/constants.js';
import { mergeDefaults } from '../src/utils.js';
import { createProject, mergeCharacter, mergeEntry } from '../src/project.js';
import { buildChunks, detectChapters } from '../src/splitter.js';
import { buildCardJson, embedCardInPng } from '../src/cards.js';
import { prepareCard, publishCard, statusBarWorldName } from '../src/publish.js';
import { toCharacterBook, toSTWorld } from '../src/worldbook.js';
import { applyConfig } from '../src/io.js';
import { STATUS_TAG, StatusBarExportError, ensureStatusBar, normalizeStatusSpec, statusBarEntries } from '../src/statusbar.js';

const NOVEL = ['第一章 魔女小姐', '江酒走进酒吧。莉莉丝坐在角落。', '第二章 女仆', '江酒穿上了女仆装。莉莉丝去参加魔女茶会。'].join('\n');

function settings() {
    const s = mergeDefaults({}, DEFAULT_SETTINGS);
    s.categories = structuredClone(DEFAULT_CATEGORIES);
    return s;
}

function project() {
    const chunks = detectChapters(NOVEL, '^第.+章.*$').map((ch) => buildChunks([ch], 1000, false)[0]);
    chunks.forEach((c, i) => (c.index = i));
    const p = createProject({ name: '魔女', text: NOVEL, chunks });
    mergeCharacter(p, { name: '江酒', identity: '莉莉丝的前男友', importance: 'main' }, 0);
    mergeCharacter(p, { name: '莉莉丝', identity: '大魔女', importance: 'main' }, 0);
    mergeEntry(p, '地点', { name: '酒吧', keywords: ['酒吧'], content: '莉莉丝经营的酒吧' }, 0);
    return p;
}

const SPEC = {
    title: '莉莉丝',
    variables: [
        { path: '莉莉丝.好感度', type: 'number', init: 20, min: 0, max: 100 },
        { path: '莉莉丝.心情', type: 'enum', options: ['平静', '愠怒'], init: '平静' },
    ],
};

function card({ statusBar = true, ...extra } = {}) {
    const c = {
        id: 'c1', kind: 'character', charName: '莉莉丝', timepoint: null, stAvatar: '', worldName: '',
        data: {
            name: '莉莉丝', description: 'd', personality: 'p', scenario: 's', first_mes: '雨夜，门铃响了。\n', alternate_greetings: ['酒吧打烊后。', '茶会上。'],
            mes_example: '<START>', system_prompt: '', post_history_instructions: '', creator_notes: '原作者备注', tags: ['魔女'],
        },
        ...extra,
    };
    if (statusBar) {
        ensureStatusBar(c, settings());
        c.statusBar.spec = normalizeStatusSpec(SPEC);
        c.statusBar.mode = 'auto';
    }
    return c;
}

test('toSTWorld / toCharacterBook：单条覆盖 comment / ignoreBudget / 递归 / role，普通条目不变', () => {
    const plain = { category: '地点', name: '酒吧', keywords: ['酒吧'], content: 'x', constant: false, position: 0, depth: 4, order: 100, disable: false };
    const special = { ...plain, comment: '[mvu_update]规则', ignoreBudget: true, excludeRecursion: true, preventRecursion: false, role: 1, position: 4, depth: 0 };
    const w = toSTWorld([plain, special], { allowRecursion: true });
    assert.equal(w.entries[0].comment, '地点 - 酒吧');
    assert.equal(w.entries[0].ignoreBudget, false);
    assert.equal(w.entries[0].excludeRecursion, false);
    assert.equal(w.entries[0].role, 0);
    assert.equal(w.entries[1].comment, '[mvu_update]规则');
    assert.equal(w.entries[1].ignoreBudget, true);
    assert.equal(w.entries[1].excludeRecursion, true);
    assert.equal(w.entries[1].preventRecursion, false);
    assert.equal(w.entries[1].role, 1);
    const b = toCharacterBook([plain, special], 'book', { allowRecursion: false });
    assert.equal(b.entries[0].comment, '地点 - 酒吧');
    assert.equal(b.entries[0].extensions.ignore_budget, false);
    assert.equal(b.entries[0].extensions.prevent_recursion, true);
    assert.equal(b.entries[1].comment, '[mvu_update]规则');
    assert.equal(b.entries[1].extensions.ignore_budget, true);
    assert.equal(b.entries[1].extensions.prevent_recursion, false);
    assert.equal(b.entries[1].extensions.role, 1);
    assert.equal(b.entries[1].extensions.position, 4);
    assert.equal(b.entries[1].position, 'after_char');
});

test('buildCardJson：没有状态栏（或未启用/没有变量）时输出与以前一致', () => {
    for (const c of [card({ statusBar: false }), (() => {
        const x = card();
        x.statusBar.enabled = false;
        return x;
    })(), (() => {
        const x = card();
        x.statusBar.spec.variables = [];
        return x;
    })()]) {
        const json = buildCardJson(c, { worldName: 'W', characterBook: null, creator: 'me' });
        assert.equal(json.data.extensions.world, 'W');
        assert.equal(json.data.extensions.regex_scripts, undefined);
        assert.equal(json.data.extensions.tavern_helper, undefined);
        assert.equal(json.data.extensions.novel_loom.statusBar, undefined);
        assert.equal(json.data.first_mes, '雨夜，门铃响了。\n');
        assert.equal(json.data.creator_notes, '原作者备注');
        assert.equal(json.data.character_book, undefined);
    }
});

test('buildCardJson：状态栏卡的正则、角色脚本、开场白标签、作者备注、元数据、世界书', () => {
    const c = card();
    const json = buildCardJson(c, { worldName: '', characterBook: null, statusBar: { mvuUrl: 'https://example.com/mvu.js' } });
    const d = json.data;
    assert.equal(d.first_mes, `雨夜，门铃响了。\n\n${STATUS_TAG}`);
    assert.equal(json.first_mes, d.first_mes, 'V1 顶层字段同步');
    assert.deepEqual(d.alternate_greetings, [`酒吧打烊后。\n\n${STATUS_TAG}`, `茶会上。\n\n${STATUS_TAG}`]);
    assert.equal(c.data.first_mes, '雨夜，门铃响了。\n', '卡片本身不变（只在导出时加）');
    assert.ok(d.creator_notes.startsWith('原作者备注\n\n【状态栏使用说明】'));
    assert.equal(json.creatorcomment, d.creator_notes);
    assert.equal(d.extensions.regex_scripts.length, 5);
    assert.equal(d.extensions.tavern_helper.scripts.length, 2);
    assert.equal(d.extensions.tavern_helper.scripts[0].content, "import 'https://example.com/mvu.js';");
    assert.equal(d.extensions.novel_loom.statusBar.version, 1);
    assert.equal(d.extensions.novel_loom.statusBar.mode, 'auto');
    assert.deepEqual(d.extensions.novel_loom.statusBar.spec, c.statusBar.spec);
    // 世界书：没给名字时用 “角色名·状态栏”，world 与 character_book.name 相同
    assert.ok(d.extensions.world);
    assert.equal(d.extensions.world, d.character_book.name);
    const es = d.character_book.entries;
    assert.deepEqual(es.map((e) => e.comment), ['[initvar]变量初始化勿开', '变量列表', '[mvu_update]变量更新规则', '[mvu_update]变量输出格式']);
    assert.equal(es[0].enabled, false, '[initvar] 条目禁用');
    assert.equal(es[0].extensions.ignore_budget, false);
    for (const e of es.slice(1)) {
        assert.equal(e.enabled, true);
        assert.equal(e.constant, true);
        assert.equal(e.extensions.ignore_budget, true);
        assert.equal(e.extensions.position, 4);
        assert.equal(e.extensions.depth, 0);
    }
    for (const e of es) {
        assert.deepEqual(e.keys, []);
        assert.equal(e.extensions.exclude_recursion, true);
        assert.equal(e.extensions.prevent_recursion, true);
        assert.equal(e.insertion_order, 14720);
    }
    // 给了世界书名与内嵌书：书名被统一成 world
    const json2 = buildCardJson(c, { worldName: '《魔女》世界书·莉莉丝', characterBook: toCharacterBook(statusBarEntries(c), '别的名字') });
    assert.equal(json2.data.extensions.world, '《魔女》世界书·莉莉丝');
    assert.equal(json2.data.character_book.name, '《魔女》世界书·莉莉丝');
    // 再导出一次：备注不重复追加；标签不重复
    c.data.creator_notes = json.data.creator_notes;
    c.data.first_mes = json.data.first_mes;
    const json3 = buildCardJson(c, {});
    assert.equal(json3.data.creator_notes.split('【状态栏使用说明】').length, 2);
    assert.equal(json3.data.first_mes.split(STATUS_TAG).length, 2);
    // 关闭开场白标签与说明；statusBar:false 整体不输出
    c.statusBar.options.greetingTag = false;
    c.statusBar.options.usageNote = false;
    c.data.creator_notes = '原作者备注';
    c.data.first_mes = '雨夜。';
    const json4 = buildCardJson(c, {});
    assert.equal(json4.data.first_mes, '雨夜。');
    assert.equal(json4.data.creator_notes, '原作者备注');
    assert.equal(buildCardJson(c, { statusBar: false }).data.extensions.regex_scripts, undefined);
    // 写进 PNG 的 ccv3 也带着
    const TINY_PNG = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64'));
    const png = embedCardInPng(TINY_PNG, json);
    const text = Buffer.from(png).toString('latin1');
    const b64 = text.slice(text.indexOf('ccv3') + 5).split('\0')[0].match(/^[A-Za-z0-9+/=]+/)[0];
    assert.equal(JSON.parse(Buffer.from(b64, 'base64').toString('utf8')).data.extensions.tavern_helper.scripts.length, 2);
});

test('buildCardJson：状态栏界面有错误时拒绝导出', () => {
    const c = card();
    c.statusBar.mode = 'bind';
    c.statusBar.html = '<b data-nl-text="莉莉丝.心情">$1</b>';
    assert.throws(() => buildCardJson(c, {}), StatusBarExportError);
    c.statusBar.html = '<b data-nl-text="莉莉丝.心情"></b><script>fetch("/api/x")</script>';
    assert.throws(() => buildCardJson(c, {}), /已阻止导出/);
    c.statusBar.mode = 'raw';
    c.statusBar.html = '<body><script>fetch("x"); getAllVariables()</script></body>';
    assert.doesNotThrow(() => buildCardJson(c, {}), '自定义 HTML 的危险代码只警告');
});

test('prepareCard：状态栏卡用自己的世界书（资料条目 + 状态栏条目），普通卡不变', () => {
    const p = project();
    const s = settings();
    const plain = prepareCard(p, s, card({ statusBar: false }));
    assert.equal(plain.statusBar, false);
    assert.equal(plain.worldName, '《魔女》世界书');
    assert.equal(plain.json.data.character_book.entries.length, plain.entries.length);
    assert.ok(!plain.entries.some((e) => e.comment));

    const c = card();
    const r = prepareCard(p, s, c);
    assert.equal(r.statusBar, true);
    assert.equal(r.worldName, '《魔女》世界书·莉莉丝');
    assert.equal(statusBarWorldName(p, s, c), '《魔女》世界书·莉莉丝');
    assert.equal(r.json.data.extensions.world, r.worldName);
    assert.equal(r.json.data.character_book.name, r.worldName);
    assert.ok(r.entries.some((e) => e.name === '江酒'), '含资料条目');
    assert.ok(!r.entries.some((e) => e.category === '角色' && e.name === '莉莉丝'), '仍排除卡片本人');
    assert.deepEqual(r.entries.slice(-4).map((e) => e.comment), ['[initvar]变量初始化勿开', '变量列表', '[mvu_update]变量更新规则', '[mvu_update]变量输出格式']);
    assert.equal(r.json.data.character_book.entries.length, r.entries.length);
    // 已记下的世界书名优先；早期时间点的卡片也带后缀
    c.statusBar.worldName = '自定义世界书';
    assert.equal(prepareCard(p, s, c).worldName, '自定义世界书');
    const early = card({ timepoint: 0 });
    assert.equal(prepareCard(p, s, early).worldName, '《魔女》世界书（至第1段）·莉莉丝');
    // 名字里的非法文件名字符被替换
    const odd = card();
    odd.data.name = 'A/B:C';
    assert.equal(statusBarWorldName(p, s, odd), '《魔女》世界书·A_B_C');

    // 关闭“绑定”“内嵌”：仍绑定一本只有状态栏条目的世界书
    const s2 = settings();
    s2.cards.linkWorldbook = false;
    s2.cards.embedWorldbook = false;
    const r2 = prepareCard(p, s2, card());
    assert.equal(r2.entries.length, 4);
    assert.equal(r2.json.data.extensions.world, '《魔女》世界书·莉莉丝');
    assert.equal(r2.json.data.character_book.entries.length, 4);
    // 只开“绑定”：写入的世界书有资料，内嵌的只有状态栏条目
    const s3 = settings();
    s3.cards.embedWorldbook = false;
    const r3 = prepareCard(p, s3, card());
    assert.ok(r3.entries.length > 4);
    assert.equal(r3.json.data.character_book.entries.length, 4);
    // CDN 地址取自 settings.statusBar
    s3.statusBar.mvuUrl = 'https://mirror.example.com/bundle.js';
    assert.equal(prepareCard(p, s3, card()).json.data.extensions.tavern_helper.scripts[0].content, "import 'https://mirror.example.com/bundle.js';");
});

function installST() {
    const saved = { worlds: {}, imports: [] };
    const ctx = {
        name1: 'User',
        characters: [],
        getRequestHeaders: () => ({ 'Content-Type': 'application/json' }),
        async saveWorldInfo(name, data) {
            saved.worlds[name] = data;
        },
        async updateWorldInfoList() {},
        async getCharacters() {},
    };
    globalThis.SillyTavern = { getContext: () => ctx };
    const origFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
        if (url === '/api/characters/import') {
            const file = init.body.get('avatar');
            saved.imports.push({ name: file.name, json: JSON.parse(await file.text()), preserved: init.body.get('preserved_name') });
            ctx.characters.push({ avatar: 'lilith.png' });
            return new Response(JSON.stringify({ file_name: 'lilith' }), { status: 200 });
        }
        return new Response('{}', { status: 404 });
    };
    return { saved, restore: () => { globalThis.fetch = origFetch; delete globalThis.SillyTavern; } };
}

test('publishCard：状态栏卡即使没开“绑定世界书”也写入并绑定自己的世界书，名字记在卡上', async () => {
    const p = project();
    const s = settings();
    s.cards.linkWorldbook = false;
    const { saved, restore } = installST();
    try {
        const c = card();
        const r = await publishCard(p, s, c);
        assert.equal(r.statusBar, true);
        assert.equal(r.worldName, '《魔女》世界书·莉莉丝');
        const w = saved.worlds['《魔女》世界书·莉莉丝'];
        assert.ok(w, '世界书已写入');
        const comments = Object.values(w.entries).map((e) => e.comment);
        assert.ok(comments.includes('[initvar]变量初始化勿开'));
        const init = Object.values(w.entries).find((e) => e.comment === '[initvar]变量初始化勿开');
        assert.equal(init.disable, true);
        assert.equal(Object.values(w.entries).find((e) => e.comment === '变量列表').ignoreBudget, true);
        assert.equal(saved.imports.length, 1);
        assert.equal(saved.imports[0].json.data.extensions.world, '《魔女》世界书·莉莉丝');
        assert.equal(saved.imports[0].json.data.extensions.regex_scripts.length, 5);
        assert.equal(c.statusBar.worldName, '《魔女》世界书·莉莉丝');
        assert.equal(c.worldName, '', '普通写入用的“绑定世界书名称”不被状态栏专用世界书覆盖');
        assert.equal(c.stAvatar, 'lilith');
        // 再写一次：沿用同一本世界书、覆盖同一个角色文件
        s.worldbook.namePattern = '《{book}》新名字';
        await publishCard(p, s, c);
        assert.ok(!saved.worlds['《魔女》新名字·莉莉丝']);
        assert.equal(saved.imports[1].preserved, 'lilith');
        assert.equal(saved.imports[1].json.data.extensions.world, '《魔女》世界书·莉莉丝');
        // 普通卡 + 没开绑定：不写世界书
        const before = Object.keys(saved.worlds).length;
        const plain = card({ statusBar: false });
        const r2 = await publishCard(p, s, plain);
        assert.equal(r2.statusBar, false);
        assert.equal(Object.keys(saved.worlds).length, before);
        assert.equal(plain.worldName, '《魔女》新名字', '普通卡照旧记下绑定世界书名称');
        // 关掉状态栏后再写入：回到普通的那本世界书，而不是状态栏专用的那本
        c.statusBar.enabled = false;
        const r3 = await publishCard(p, s, c);
        assert.equal(r3.statusBar, false);
        assert.equal(r3.worldName, '《魔女》新名字');
    } finally {
        restore();
    }
});

test('applyConfig：statusBar 选项合并，statusBarTemplates 按 id 合并', () => {
    const s = settings();
    s.statusBarTemplates = [{ id: 'sbtpl_a', name: '本机 A' }, { id: 'sbtpl_b', name: '本机 B' }];
    applyConfig(s, {
        type: 'novel_loom_config',
        settings: { statusBar: { maxVars: 8 }, statusBarTemplates: [{ id: 'sbtpl_b', name: '导入 B' }, { id: 'sbtpl_c', name: '导入 C' }, { name: '没有 id' }] },
    });
    assert.equal(s.statusBar.maxVars, 8);
    assert.equal(s.statusBar.mvuUrl, DEFAULT_SETTINGS.statusBar.mvuUrl, '其他选项保留');
    assert.deepEqual(s.statusBarTemplates.map((t) => `${t.id}:${t.name}`), ['sbtpl_a:本机 A', 'sbtpl_b:导入 B', 'sbtpl_c:导入 C']);
});
