// v0.12：世界/旁白卡（card.kind === 'world'）也能带状态栏：{{char}} 是旁白，记录预填主要角色，导出与角色卡完全一样
import test from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_CATEGORIES, DEFAULT_SETTINGS } from '../src/constants.js';
import { mergeDefaults } from '../src/utils.js';
import { createProject, mergeCharacter, mergeEntry } from '../src/project.js';
import { buildChunks, detectChapters } from '../src/splitter.js';
import { buildCardJson } from '../src/cards.js';
import { prepareCard, publishCard, statusBarWorldName } from '../src/publish.js';
import {
    STATUS_TAG, buildInitialState, defaultRecordItem, ensureStatusBar, isWorldCard, normalizeStatusSpec, seedRecordEntries, statusBarActive,
    statusBarCharName, worldCastNames,
} from '../src/statusbar.js';
import { compileStatusDocument } from '../src/statusbar-runtime.js';

const NOVEL = ['第一章 雨夜', '江酒走进酒吧。莉莉丝坐在角落。', '第二章 茶会', '江酒穿上了女仆装。莉莉丝去参加魔女茶会，遇见了白夜。'].join('\n');

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
    mergeCharacter(p, { name: '酒保', identity: '酒吧员工', importance: 'minor' }, 0);
    mergeCharacter(p, { name: '白夜', identity: '茶会主人', importance: 'main' }, 1);
    mergeEntry(p, '地点', { name: '酒吧', keywords: ['酒吧'], content: '莉莉丝经营的酒吧' }, 0);
    return p;
}

const SPEC = {
    title: '群像',
    variables: [
        { path: '世界.时间', type: 'string', init: '雨夜' },
        { path: '世界.地点', type: 'string', init: '酒吧' },
        { path: '{{user}}.身份', type: 'string', init: '客人' },
        { path: '{{char}}.旁白语气', type: 'enum', options: ['冷静', '戏谑'], init: '冷静' },
        { path: '主要角色', type: 'record', keyDesc: '角色名', value: { type: 'object', fields: [{ key: '好感', type: 'number', min: 0, max: 100, init: 20 }, { key: '服饰', type: 'object', fields: [{ key: '上衣', type: 'string' }] }] }, init: {} },
        { path: 'NPC', type: 'record', keyDesc: '名字', value: { type: 'object', fields: [{ key: '阵营', type: 'string' }] }, init: {} },
    ],
};

function worldCard({ statusBar = true, ...extra } = {}) {
    const c = {
        id: 'card_world1', kind: 'world', charName: '', timepoint: null, stAvatar: '', worldName: '',
        data: {
            name: '魔女之夜', description: '旁白', personality: '', scenario: '酒吧', first_mes: '雨还在下。', alternate_greetings: ['茶会开始了。'],
            mes_example: '', system_prompt: '', post_history_instructions: '', creator_notes: '', tags: [],
        },
        ...extra,
    };
    if (statusBar) {
        ensureStatusBar(c, settings());
        c.statusBar.spec = normalizeStatusSpec(SPEC, { charName: statusBarCharName(c), maxVars: 30 });
        c.statusBar.mode = 'auto';
    }
    return c;
}

test('世界/旁白卡：{{char}} 是旁白（卡片名），名字缺失时用「旁白」', () => {
    const c = worldCard();
    assert.equal(isWorldCard(c), true);
    assert.equal(isWorldCard({ kind: 'character' }), false);
    assert.equal(statusBarCharName(c), '魔女之夜');
    assert.equal(statusBarCharName({ kind: 'world', data: { name: '' } }), '旁白');
    assert.equal(statusBarCharName({ kind: 'character', charName: '莉莉丝', data: {} }), '莉莉丝');
    assert.equal(statusBarCharName({}), '角色');
    assert.deepEqual(c.statusBar.spec.variables.map((v) => v.path), ['世界.时间', '世界.地点', '主角.身份', '魔女之夜.旁白语气', '主要角色', 'NPC']);
    assert.equal(statusBarActive(c), true);
});

test('worldCastNames：到卡片时间点为止出场的主要角色（有 main 时只取 main），可放宽到全部、限制数量', () => {
    const p = project();
    assert.deepEqual(worldCastNames(p, worldCard()), ['江酒', '莉莉丝', '白夜']);
    assert.deepEqual(worldCastNames(p, worldCard({ timepoint: 0 })), ['江酒', '莉莉丝'], '白夜第二段才出场');
    assert.deepEqual(worldCastNames(p, worldCard(), { all: true }), ['江酒', '莉莉丝', '白夜', '酒保']);
    assert.deepEqual(worldCastNames(p, worldCard(), { limit: 1 }), ['江酒']);
    const onlyMinor = { characters: { 甲: { name: '甲', importance: 'minor', firstChunk: 0 }, 'a.b': { name: 'a.b', importance: 'main', firstChunk: 0 } } };
    assert.deepEqual(worldCastNames(onlyMinor, {}), ['甲'], '没有可用的 main 时取全部；不能当记录键的名字跳过');
    assert.deepEqual(worldCastNames(null, {}), []);
});

test('seedRecordEntries：把主要角色预先填进记录的初始条目（默认值含分组），不改传入的变量表', () => {
    const c = worldCard();
    const before = structuredClone(c.statusBar.spec);
    const warnings = [];
    const { spec, added } = seedRecordEntries(c.statusBar.spec, '主要角色', ['江酒', '莉莉丝', '江酒', 'a/b', '{{user}}'], { warnings });
    assert.deepEqual(c.statusBar.spec, before, '原变量表不变');
    assert.deepEqual(added, ['江酒', '莉莉丝']);
    const v = spec.variables.find((x) => x.path === '主要角色');
    assert.deepEqual(v.init.江酒, { 好感: 20, 服饰: { 上衣: '' } });
    assert.deepEqual(v.init.江酒, defaultRecordItem(v.value));
    assert.match(warnings.join('\n'), /「a\/b」没有加入/);
    assert.match(warnings.join('\n'), /「\{\{user\}\}」没有加入/, '宏不能当记录的键');
    // 规范化后不变（可以直接存回 card.statusBar.spec）
    assert.deepEqual(normalizeStatusSpec(spec, { maxVars: 30 }), spec);
    assert.deepEqual(buildInitialState(spec).主要角色, { 江酒: v.init.江酒, 莉莉丝: v.init.莉莉丝 });
    // 已有的跳过、数量上限、不是记录变量
    const again = seedRecordEntries(spec, '主要角色', ['江酒', '白夜', '酒保'], { max: 3 });
    assert.deepEqual(again.added, ['白夜']);
    const w2 = [];
    assert.deepEqual(seedRecordEntries(spec, '世界.时间', ['x'], { warnings: w2 }).added, []);
    assert.match(w2.join('\n'), /没有记录变量「世界\.时间」/);
});

test('prepareCard / buildCardJson：世界卡的状态栏与角色卡一样导出（专用世界书、正则、脚本、开场白标签）', () => {
    const p = project();
    const s = settings();
    const c = worldCard();
    const r = prepareCard(p, s, c);
    assert.equal(r.statusBar, true);
    assert.equal(r.worldName, '《魔女》世界书·魔女之夜');
    assert.equal(statusBarWorldName(p, s, c), r.worldName);
    assert.equal(statusBarWorldName(p, s, worldCard({ data: { name: '' } })), '《魔女》世界书·旁白');
    const d = r.json.data;
    assert.equal(d.extensions.world, r.worldName);
    assert.equal(d.character_book.name, r.worldName);
    assert.equal(d.extensions.novel_loom.kind, 'world');
    assert.equal(d.extensions.regex_scripts.length, 5);
    assert.equal(d.extensions.tavern_helper.scripts.length, 2);
    assert.deepEqual(d.extensions.novel_loom.statusBar.spec, c.statusBar.spec);
    assert.ok(d.extensions.novel_loom.statusBar.portraits, '立绘配置随卡导出（NovelLoom 重新导入时还原）');
    assert.ok(d.first_mes.endsWith(`\n\n${STATUS_TAG}`), '世界卡的开场白也带占位标签');
    assert.ok(d.alternate_greetings.every((g) => g.endsWith(STATUS_TAG)));
    assert.ok(r.json.first_mes.endsWith(STATUS_TAG), 'V1 顶层字段也一样');
    // 世界卡没有“卡片本人”，资料条目里的角色一个都不排除
    for (const name of ['江酒', '莉莉丝', '白夜']) assert.ok(r.entries.some((e) => e.category === '角色' && e.name === name), name);
    assert.deepEqual(r.entries.slice(-4).map((e) => e.comment), ['[initvar]变量初始化勿开', '变量列表', '[mvu_update]变量更新规则', '[mvu_update]变量输出格式']);
    // 状态栏文档里的 {{char}} 由酒馆换成旁白的名字（与角色卡同一套）
    const doc = compileStatusDocument(c);
    assert.ok(doc.includes('魔女之夜'));
    // 直接 buildCardJson（没有世界书名）：用「卡片名·状态栏」
    const json = buildCardJson(c, {});
    assert.equal(json.data.extensions.world, '魔女之夜·状态栏');
    // 开场白标签可关
    c.statusBar.options.greetingTag = false;
    assert.equal(prepareCard(p, s, c).json.data.first_mes, '雨还在下。');
    // 没启用状态栏的世界卡照旧
    const plain = prepareCard(p, s, worldCard({ statusBar: false }));
    assert.equal(plain.statusBar, false);
    assert.ok(!plain.json.data.extensions.regex_scripts);
});

test('publishCard：世界卡写入并绑定自己的世界书，名字记在 statusBar.worldName', async () => {
    const p = project();
    const s = settings();
    const saved = { worlds: {}, imports: [] };
    const ctx = {
        name1: 'User', characters: [],
        getRequestHeaders: () => ({ 'Content-Type': 'application/json' }),
        async saveWorldInfo(name, data) { saved.worlds[name] = data; },
        async updateWorldInfoList() {},
        async getCharacters() {},
    };
    globalThis.SillyTavern = { getContext: () => ctx };
    const origFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
        if (url === '/api/characters/import') {
            const file = init.body.get('avatar');
            saved.imports.push(JSON.parse(await file.text()));
            ctx.characters.push({ avatar: 'world.png' });
            return new Response(JSON.stringify({ file_name: 'world' }), { status: 200 });
        }
        return new Response('{}', { status: 404 });
    };
    try {
        const c = worldCard();
        const r = await publishCard(p, s, c);
        assert.equal(r.statusBar, true);
        assert.ok(saved.worlds['《魔女》世界书·魔女之夜']);
        assert.equal(c.statusBar.worldName, '《魔女》世界书·魔女之夜');
        assert.equal(saved.imports[0].data.extensions.regex_scripts.length, 5);
        assert.equal(saved.imports[0].data.extensions.novel_loom.kind, 'world');
    } finally {
        globalThis.fetch = origFetch;
        delete globalThis.SillyTavern;
    }
});
