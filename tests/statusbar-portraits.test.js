// v0.12：立绘（card.statusBar.portraits）：地址校验、规范化、编译进文档的 NL_PORTRAITS、运行时的解锁/图池/换一张/本地存储/占位块
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';

import {
    PORTRAIT_DATA_TOTAL_MAX, PORTRAIT_DATA_URL_MAX, PORTRAIT_LIMITS, buildStatusRegexReplace, createStatusBar, emptyPortraits,
    ensureStatusBar, lintStatusHtml, normalizePortraits, normalizeStatusSpec, portraitCandidates, portraitHash, portraitInitial,
    portraitNameProblem, portraitSampleCandidates, portraitUrlProblem, portraitsActive, resolvePortrait, statusBarMeta,
} from '../src/statusbar.js';
import { PORTRAIT_WHEN_TEXT_MAX } from '../src/statusbar-portraits.js';
import {
    STORE_CHARS_MAX, STORE_ENTRIES_MAX, buildNlRuntime, buildPreviewSrcdoc, compileStatusDocument, portraitChoiceNames, portraitChoiceProblem, portraitChoiceUrls,
    portraitStorePrefix, readPortraitChoices, renderDefaultFragment, statusBarStoreId, writePortraitChoice,
} from '../src/statusbar-runtime.js';
import { memoryStorage, openStatusDocument } from './minidom.js';
import { PROSES, scriptsOf, stFixMarkdown, stIframeText } from './stsim.js';

const PNG = `data:image/png;base64,${'iVBORw0KGgo'.repeat(4)}AAAA==`;

const SPEC_RAW = {
    title: '群像',
    variables: [
        { path: '世界.时间', type: 'string', init: '清晨' },
        { path: '主角.身份', type: 'string', init: '旅人' },
        { path: '主角.声望', type: 'number', min: 0, max: 100, init: 10 },
        { path: '主要角色', type: 'record', keyDesc: '角色名', value: { type: 'object', fields: [{ key: '身份', type: 'string' }, { key: '好感', type: 'number', min: 0, max: 100, init: 0 }, { key: '阵营', type: 'string' }] }, init: { 莉艾丽: { 好感: 30 }, 卡尔: {} } },
        { path: 'NPC', type: 'record', keyDesc: '名字', value: { type: 'object', fields: [{ key: '阵营', type: 'string' }, { key: '好感', type: 'number', min: 0, max: 100 }] }, init: {} },
    ],
};

const PORTRAITS = {
    characters: {
        莉艾丽: [
            { url: 'https://img.example.com/lia-0.png', label: '初见' },
            { url: 'https://img.example.com/lia-1.png', label: '亲近', when: { path: '好感', op: '>=', value: 40 } },
            { url: 'https://img.example.com/lia-2.png', label: '心动', when: '好感 >= 80' },
        ],
        主角: [{ url: 'https://img.example.com/me.png' }, { url: 'https://img.example.com/me-famous.png', when: { path: '主角.声望', op: '>=', value: 50 } }],
    },
    pools: [
        { record: 'NPC', field: '阵营', pools: { 公司: ['https://img.example.com/corp-a.png', 'https://img.example.com/corp-b.png', 'https://img.example.com/corp-c.png'], 帮派: ['https://img.example.com/gang.png'] }, fallback: ['https://img.example.com/npc.png'] },
    ],
};

function spec() {
    return normalizeStatusSpec(SPEC_RAW, { maxVars: 30 });
}

function card(extra = {}) {
    const c = { id: 'card_abc123', kind: 'world', charName: '', data: { name: '旁白' } };
    ensureStatusBar(c, {});
    c.statusBar.spec = spec();
    c.statusBar.mode = 'auto';
    c.statusBar.portraits = structuredClone(PORTRAITS);
    Object.assign(c.statusBar, extra);
    return c;
}

const STAT = {
    世界: { 时间: '夜' },
    主角: { 身份: '旅人', 声望: 10 },
    主要角色: { 莉艾丽: { 身份: '学生', 好感: 45, 阵营: '学院' }, 卡尔: { 身份: '骑士', 好感: 5, 阵营: '王国' } },
    NPC: { 保安甲: { 阵营: '公司', 好感: 0 }, 小混混: { 阵营: '帮派', 好感: 0 }, 路人: { 阵营: '无', 好感: 0 } },
};

// ---------------- 地址与规范化 ----------------

test('portraitUrlProblem：只允许 http(s) 与较小的 base64 data:image', () => {
    for (const ok of ['https://a.example.com/x.png', 'http://127.0.0.1:8000/a.webp?x=1&y=2', 'https://cdn.example.com/a(1).jpg#frag', PNG, 'data:image/jpeg;base64,/9j/4AAQ']) {
        assert.equal(portraitUrlProblem(ok), '', ok);
    }
    for (const bad of ['', '   ', 'javascript:alert(1)', 'data:text/html;base64,PGI+', 'data:image/svg+xml;base64,PHN2Zz4=', 'data:image/png,rawbytes', '/img/a.png', 'ftp://x/a.png',
        'https://a.example.com/a b.png', 'https://a.example.com/"x".png', 'https://a.example.com/<x>.png', 'https://a.example.com/a\\b.png', 'https://a.example.com/{x}.png',
        `https://a.example.com/${'a'.repeat(2100)}`, `data:image/png;base64,${'A'.repeat(PORTRAIT_DATA_URL_MAX)}`]) {
        assert.notEqual(portraitUrlProblem(bad), '', bad.slice(0, 60));
    }
    assert.match(portraitUrlProblem(`data:image/png;base64,${'A'.repeat(PORTRAIT_DATA_URL_MAX)}`), /内嵌图片太大/);
    assert.equal(portraitNameProblem('莉艾丽'), '');
    for (const bad of ['', 'a.b', 'constructor', '__proto__', 'x'.repeat(33), 'a"b', 'a<b']) assert.notEqual(portraitNameProblem(bad), '', bad);
});

test('normalizePortraits：图片可以只写地址，解锁条件可以写成文字，无效的地址/名字/条件被丢弃并提示，结果幂等', () => {
    const warnings = [];
    const p = normalizePortraits({
        characters: {
            莉艾丽: ['https://a.example.com/1.png', { url: 'https://a.example.com/2.png', label: '  {{user}}的 亲近  ', when: '好感≥40' }, { src: 'javascript:alert(1)' }],
            卡尔: [{ url: 'https://a.example.com/k.png', when: { path: '/状态/好感', op: '=', value: 3 } }, { url: 'https://a.example.com/k2.png', when: 'nonsense' }, { url: 'https://a.example.com/k3.png', when: { path: '好感', op: '>', value: 1 } }, { url: 'https://a.example.com/k4.png', when: { path: '好感', op: '>=', value: 'abc' } }],
            'a.b': ['https://a.example.com/x.png'],
            constructor: ['https://a.example.com/x.png'],
            空的: [],
        },
        pools: [
            { record: '/NPC', field: '阵营', pools: { 公司: ['https://a.example.com/c.png', 'https://a.example.com/c.png', 'bad'], 空: [] }, fallback: 'https://a.example.com/f.png' },
            { record: 'NPC', field: '阵营', pools: { 重复: ['https://a.example.com/d.png'] } },
            { record: '不存在', field: '阵营', fallback: ['https://a.example.com/f.png'] },
            { record: '', field: 'x', fallback: ['https://a.example.com/f.png'] },
            { record: 'NPC', field: '好感', pools: {} },
        ],
    }, { warnings, spec: spec() });
    assert.deepEqual(Object.keys(p.characters), ['莉艾丽', '卡尔']);
    assert.deepEqual(p.characters.莉艾丽, [
        { url: 'https://a.example.com/1.png' },
        { url: 'https://a.example.com/2.png', label: '的 亲近', when: { path: '好感', op: '>=', value: 40 } },
    ]);
    assert.deepEqual(p.characters.卡尔, [
        { url: 'https://a.example.com/k.png', when: { path: '状态.好感', op: '==', value: '3' } },
        { url: 'https://a.example.com/k2.png' },
        { url: 'https://a.example.com/k3.png' },
        { url: 'https://a.example.com/k4.png' },
    ]);
    assert.deepEqual(p.pools, [
        { record: 'NPC', field: '阵营', pools: { 公司: ['https://a.example.com/c.png'] }, fallback: ['https://a.example.com/f.png'] },
        { record: '不存在', field: '阵营', pools: {}, fallback: ['https://a.example.com/f.png'] },
    ]);
    const text = warnings.join('\n');
    for (const re of [/「莉艾丽」的图片已丢弃：只支持 http/, /「卡尔」的解锁条件「nonsense」看不懂/, /不支持的比较「>」/, /需要数字/, /立绘的角色名无效：「a\.b」含有不允许的字符/, /「constructor」是保留名/,
        /图池「NPC · 阵营」重复/, /变量表里没有记录变量「不存在」/, /图池已丢弃：路径为空/]) {
        assert.match(text, re);
    }
    const again = [];
    assert.deepEqual(normalizePortraits(p, { warnings: again }), p, '幂等');
    assert.deepEqual(again, []);
    // 也接受 [{name, images}] 与缺省值
    assert.deepEqual(normalizePortraits({ characters: [{ name: '甲', images: ['https://a.example.com/a.png'] }] }).characters, { 甲: [{ url: 'https://a.example.com/a.png' }] });
    assert.deepEqual(normalizePortraits(null), emptyPortraits());
    assert.equal(portraitsActive(emptyPortraits()), false);
    assert.equal(portraitsActive(p), true);
    assert.equal(portraitsActive({ characters: {}, pools: [{ record: 'NPC', field: 'x', pools: {}, fallback: ['https://a.example.com/a.png'] }] }), true);
});

test('normalizePortraits：文字写的解锁条件——各种比较符；超长的（例如 20 万个空格）立即当作看不懂丢掉，不会卡住', () => {
    const when = (w) => {
        const warnings = [];
        const p = normalizePortraits({ characters: { 甲: [{ url: 'https://a.example.com/a.png', when: w }] } }, { warnings });
        return { when: p.characters.甲[0].when ?? null, warnings };
    };
    assert.deepEqual(when('好感 >= 60').when, { path: '好感', op: '>=', value: 60 });
    assert.deepEqual(when('  好感≤ 20 ').when, { path: '好感', op: '<=', value: 20 });
    assert.deepEqual(when('好感=<20').when, { path: '好感', op: '<=', value: 20 });
    assert.deepEqual(when('好感 => 5').when, { path: '好感', op: '>=', value: 5 });
    assert.deepEqual(when('状态.心情 = 害羞').when, { path: '状态.心情', op: '==', value: '害羞' });
    assert.deepEqual(when('心情 == 害羞').when, { path: '心情', op: '==', value: '害羞' });
    assert.deepEqual(when('心情 === 害羞').when, { path: '心情', op: '==', value: '害羞' }, '=== 不会被读成 == 加上「= 害羞」');
    assert.deepEqual(when('主角.声望>=50').when, { path: '主角.声望', op: '>=', value: 50 });
    for (const bad of ['好感', '>= 60', '好感 >=', '   ']) {
        const r = when(bad);
        assert.equal(r.when, null, bad);
    }
    assert.match(when('好感').warnings.join(), /看不懂/);
    // 合法写法远短于 PORTRAIT_WHEN_TEXT_MAX；更长的直接当作看不懂
    assert.deepEqual(when(`好感${' '.repeat(PORTRAIT_WHEN_TEXT_MAX - 6)}>= 1`).when, { path: '好感', op: '>=', value: 1 });
    assert.equal(when(`好感${' '.repeat(PORTRAIT_WHEN_TEXT_MAX)}>= 1`).when, null);

    // 审查里的复现：'a' + 大量空白（+ 'b'），旧的正则要回溯成平方级（4 万个空格约 0.7 秒，20 万个要十几秒）
    for (const w of [`a${' '.repeat(200000)}`, `a${' '.repeat(200000)}b`, `a${'　'.repeat(200000)}`, `${' '.repeat(100000)}好感 >= 1${' '.repeat(100000)}`, '='.repeat(200000)]) {
        const t = Date.now();
        const r = when(w);
        assert.ok(Date.now() - t < 200, `${Date.now() - t}ms`);
        assert.equal(r.when, null);
        assert.equal(r.warnings.length, 1);
        assert.match(r.warnings[0], /^「甲」的解锁条件「.{0,30}」看不懂，已去掉/);
    }
    // 导入带这种条件的卡片（templateFromCardJson → normalizePortraits）也一样快
    const t = Date.now();
    normalizePortraits({ characters: Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`角色${i}`, Array.from({ length: 12 }, () => ({ url: 'https://a.example.com/a.png', when: `a${' '.repeat(20000)}` }))])) });
    assert.ok(Date.now() - t < 500, `${Date.now() - t}ms`);
});

test('normalizePortraits：数量上限与内嵌图片的总量上限', () => {
    const many = Object.fromEntries(Array.from({ length: PORTRAIT_LIMITS.characters + 3 }, (_, i) => [`角色${i}`, [`https://a.example.com/${i}.png`]]));
    const w = [];
    const p = normalizePortraits({ characters: many }, { warnings: w });
    assert.equal(Object.keys(p.characters).length, PORTRAIT_LIMITS.characters);
    assert.match(w.join('\n'), /最多配置/);
    const imgs = Array.from({ length: PORTRAIT_LIMITS.images + 2 }, (_, i) => `https://a.example.com/${i}.png`);
    const w2 = [];
    assert.equal(normalizePortraits({ characters: { 甲: imgs } }, { warnings: w2 }).characters.甲.length, PORTRAIT_LIMITS.images);
    assert.match(w2.join('\n'), new RegExp(`最多 ${PORTRAIT_LIMITS.images} 张图片`));
    const big = `data:image/png;base64,${'A'.repeat(PORTRAIT_DATA_URL_MAX - 30)}`;
    const n = Math.floor(PORTRAIT_DATA_TOTAL_MAX / big.length) + 1;
    const w3 = [];
    const p3 = normalizePortraits({ characters: Object.fromEntries(Array.from({ length: n }, (_, i) => [`人${i}`, [big]])) }, { warnings: w3 });
    assert.equal(Object.keys(p3.characters).length, n - 1);
    assert.match(w3.join('\n'), /内嵌图片合计超过/);
});

test('ensureStatusBar / createStatusBar / statusBarMeta：立绘配置的结构与导出', () => {
    assert.deepEqual(createStatusBar({}).portraits, emptyPortraits());
    const c = { data: { name: 'x' } };
    const sb = ensureStatusBar(c, {});
    assert.deepEqual(sb.portraits, { characters: {}, pools: [] });
    sb.portraits = { characters: { 甲: ['https://a.example.com/a.png'] } };
    ensureStatusBar(c, {});
    assert.deepEqual(sb.portraits.pools, [], '补齐缺失的 pools');
    assert.deepEqual(sb.portraits.characters.甲, ['https://a.example.com/a.png'], '已有配置不被改动');
    sb.portraits = 'oops';
    ensureStatusBar(c, {});
    assert.deepEqual(sb.portraits, emptyPortraits());
    const meta = statusBarMeta(card());
    assert.deepEqual(meta.portraits, normalizePortraits(PORTRAITS));
});

test('portraitCandidates：角色记录的初始条目 + 固定分组名；示例数据里才有的名字单独给出（标「示例数据」）', () => {
    const sample = { NPC: { 保安甲: {} }, 主要角色: { 莉艾丽: {}, 新人: {} } };
    const list = portraitCandidates(spec(), sample);
    assert.deepEqual(list, [
        { name: '莉艾丽', record: '主要角色' }, { name: '卡尔', record: '主要角色' }, { name: '世界', record: null }, { name: '主角', record: null },
    ], '示例数据里的名字不当作这个故事的角色');
    assert.deepEqual(portraitCandidates(spec()), list);
    assert.deepEqual(portraitSampleCandidates(spec(), sample), [
        { name: '新人', record: '主要角色', sample: true }, { name: '保安甲', record: 'NPC', sample: true },
    ]);
    assert.deepEqual(portraitSampleCandidates(spec(), null), []);

    // 物品、任务、属性这类记录的条目不是角色：不进候选（RPG 模板的 背包 / 任务 / 属性）
    const rpg = normalizeStatusSpec({
        variables: [
            { path: '主角.物品', type: 'record', label: '背包', keyDesc: '物品名', value: { type: 'number', min: 0 }, init: { 治疗药水: 2 } },
            { path: '主角.任务', type: 'record', label: '任务', keyDesc: '任务名', value: { type: 'string' }, init: { 寻找失落之剑: '进行中' } },
            { path: '主角.属性', type: 'record', label: '属性', keyDesc: '属性名', value: { type: 'number' }, init: { 力量: 5 } },
            { path: '队友', type: 'record', keyDesc: '队友名', value: { type: 'object', fields: [{ key: '好感', type: 'number' }] }, init: { 阿岚: {} } },
            { path: '在场', type: 'record', label: '在场角色', keyDesc: '名字', value: { type: 'string' }, init: { 店主: '在柜台' } },
        ],
    }, { maxVars: 30 });
    assert.deepEqual(portraitCandidates(rpg, { 主角: { 物品: { 绳子: 1 } }, 队友: { 示例甲: {} } }), [
        { name: '阿岚', record: '队友' }, { name: '店主', record: '在场' }, { name: '主角', record: null },
    ]);
    assert.deepEqual(portraitSampleCandidates(rpg, { 主角: { 物品: { 绳子: 1 } }, 队友: { 示例甲: {}, 阿岚: {} } }), [{ name: '示例甲', record: '队友', sample: true }]);
    // 叫「主要角色」的记录即使 keyDesc 不像角色名也算（castRecordPath）
    const main = normalizeStatusSpec({ variables: [{ path: '主要角色', type: 'record', keyDesc: '键', value: { type: 'string' }, init: { 甲: 'x' } }] });
    assert.deepEqual(portraitCandidates(main), [{ name: '甲', record: '主要角色' }]);
});

// ---------------- 取图逻辑 ----------------

test('resolvePortrait：默认是最高的已解锁图片，手动选择优先；没有自己的图片时从图池按名字稳定挑一张', () => {
    const p = normalizePortraits(PORTRAITS);
    const lia = (好感, saved = null) => resolvePortrait(p, '莉艾丽', { record: '主要角色', stat: { 主要角色: { 莉艾丽: { 好感 } } }, saved });
    assert.deepEqual(lia(10).urls, ['https://img.example.com/lia-0.png']);
    assert.equal(lia(45).url, 'https://img.example.com/lia-1.png');
    assert.equal(lia(90).url, 'https://img.example.com/lia-2.png');
    assert.equal(lia(90, 'https://img.example.com/lia-0.png').index, 0, '手动选过的仍在已解锁列表里时优先');
    assert.equal(lia(10, 'https://img.example.com/lia-2.png').url, 'https://img.example.com/lia-0.png', '手动选的被锁住时回到默认');
    // 名字不分大小写、两端空白也能对上
    assert.equal(resolvePortrait({ characters: { Alice: [{ url: 'https://a.example.com/a.png' }] }, pools: [] }, ' alice ').url, 'https://a.example.com/a.png');
    // 固定分组：条件里的路径从第一层写起
    assert.equal(resolvePortrait(p, '主角', { stat: { 主角: { 声望: 60 } } }).url, 'https://img.example.com/me-famous.png');
    assert.equal(resolvePortrait(p, '主角', { stat: { 主角: { 声望: 20 } } }).url, 'https://img.example.com/me.png');
    // 图池
    const npc = (name) => resolvePortrait(p, name, { record: 'NPC', stat: STAT });
    const guard = npc('保安甲');
    assert.equal(guard.pooled, true);
    assert.equal(guard.urls.length, 3);
    assert.equal(guard.index, portraitHash('保安甲') % 3);
    assert.deepEqual(npc('保安甲'), guard, '同一个名字每次都挑同一张');
    assert.equal(npc('小混混').url, 'https://img.example.com/gang.png');
    assert.equal(npc('路人').url, 'https://img.example.com/npc.png', '取值没有对应的图池时用兜底');
    assert.equal(npc('不在记录里').url, 'https://img.example.com/npc.png');
    assert.equal(resolvePortrait(p, '路人', { stat: STAT }).url, '', '不在记录里（没有 record）时不用图池');
    assert.equal(portraitInitial(' élan'), 'É');
    assert.equal(portraitInitial(''), '?');
    assert.equal(portraitHash('abc'), 96354);
});

// ---------------- 编译进文档 ----------------

test('compileStatusDocument：配置了立绘时写入 NL_CARD_ID 与 NL_PORTRAITS（编译时重新校验），没配置时文档里没有', () => {
    const c = card();
    c.statusBar.portraits.characters.坏人 = [{ url: 'javascript:alert(1)' }];
    const doc = compileStatusDocument(c);
    const line = doc.split('\n').find((l) => l.includes('window.NL_PORTRAITS'));
    const m = line.match(/^<script>window\.NL_CARD_ID = "([^"]*)";window\.NL_PORTRAITS = (.*);<\/script>$/);
    assert.ok(m, line.slice(0, 80));
    assert.equal(m[1], 'card_abc123');
    assert.deepEqual(JSON.parse(m[2]), normalizePortraits(PORTRAITS), '坏地址在编译时被丢弃');
    assert.ok(!doc.includes('javascript:'));
    assert.ok(doc.indexOf('window.NL_PORTRAITS') < doc.indexOf('class="nlb'), '配置在界面与运行时之前');
    // 没有任何图片：不写配置，内置排版也不加头像
    const plain = card({ portraits: emptyPortraits() });
    const plainDoc = compileStatusDocument(plain);
    assert.ok(!plainDoc.includes('window.NL_PORTRAITS = '));
    assert.ok(!plainDoc.includes('window.NL_CARD_ID = '));
    assert.ok(!plainDoc.includes('class="nlb-av"'));
    // 预览可以覆盖未保存的立绘
    assert.ok(compileStatusDocument(plain, { portraits: PORTRAITS }).includes('window.NL_PORTRAITS = '));
    assert.ok(buildPreviewSrcdoc(plain, null, { override: { portraits: PORTRAITS } }).includes('lia-2.png'));
    // raw 模式不注入运行时，也就没有立绘配置
    assert.ok(!compileStatusDocument(card({ mode: 'raw', html: '<body>x</body>' })).includes('NL_PORTRAITS'));
    // 存储命名空间只保留安全字符
    assert.equal(statusBarStoreId({ id: 'card_a:b/c"d' }), 'card_abcd');
    assert.equal(statusBarStoreId({ statusBar: { ids: { regexBar: '1234-abcd' } } }), '1234-abcd');
    assert.equal(statusBarStoreId({}), 'card');
});

test('内置排版：配置了立绘时记录条目带头像，有立绘的固定分组标题带头像；检查不报外部资源', () => {
    const s = spec();
    const p = normalizePortraits(PORTRAITS);
    const f = renderDefaultFragment(s, 'night', { portraits: p });
    assert.ok(f.includes('<div class="nlb-li"><img class="nlb-av" data-nl-portrait="" alt=""><span class="nlb-lk" data-nl-key></span>'));
    assert.ok(f.includes('<h4><img class="nlb-av" data-nl-portrait="主角" alt="">主角</h4>'));
    assert.ok(f.includes('<h4>世界</h4>'), '没有立绘的分组不加头像');
    assert.deepEqual(lintStatusHtml(f, { mode: 'bind', spec: s }), { errors: [], warnings: [] });
    const doc = compileStatusDocument(card());
    assert.deepEqual(lintStatusHtml(doc, { mode: 'raw' }).warnings.filter((w) => /外部图片/.test(w)), [], '立绘地址是配置，不算界面引用的外部资源');
    assert.deepEqual(lintStatusHtml('<img data-nl-portrait="主角"><button type="button" data-nl-portrait-next="主角">换</button>', { mode: 'bind', spec: s }), { errors: [], warnings: [] });
    // 界面代码自己写本地存储仍是错误（只有运行时可以用）
    assert.match(lintStatusHtml('<script>localStorage.setItem("a", 1)</script>', { mode: 'bind' }).errors.join('\n'), /本地存储/);
});

test('带立绘的状态栏文档：替换串往返、经过「自动修复 Markdown」与一层实体解码后 iframe 收到的仍是原文', () => {
    const tricky = {
        characters: {
            'a*b': [{ url: 'https://img.example.com/a*b.png?x=$1&y=2', label: '星*号"引 _号' }, { url: 'https://img.example.com/{{user}}.png' }],
            莉艾丽: PORTRAITS.characters.莉艾丽,
            小图: [PNG],
        },
        pools: PORTRAITS.pools,
    };
    const p = normalizePortraits(tricky);
    assert.deepEqual(p.characters['a*b'], [{ url: 'https://img.example.com/a*b.png?x=$1&y=2', label: '星*号"引 _号' }], '带花括号（宏）的地址被丢弃');
    const c = card({ portraits: tricky, mode: 'bind', html: '<div data-nl-each="主要角色"><template><img class="pt" data-nl-portrait=""><button type="button" data-nl-portrait-next="">换</button></template></div>' });
    const docs = [compileStatusDocument(c), compileStatusDocument(card({ portraits: tricky }))];
    for (const doc of docs) {
        assert.ok(!doc.includes('{{user}}'));
        assert.ok(!/\$1/.test(doc), '地址里的 $1 被转义');
        const replace = buildStatusRegexReplace(doc);
        for (const prose of PROSES) {
            const shown = stIframeText(stFixMarkdown(`${prose}\n\n${replace}`, true));
            assert.equal(shown, doc, `正文：${prose}`);
            for (const code of scriptsOf(shown)) assert.doesNotThrow(() => new vm.Script(code));
        }
        // iframe 里读到的配置与规范化结果一致
        const env = openStatusDocument(doc, { stat: STAT });
        assert.deepEqual(JSON.parse(JSON.stringify(env.window.NL_PORTRAITS)), p);
    }
    const rt = buildNlRuntime();
    assert.ok(rt.includes("'nl-sb:' + CARD + ':' + name"), '本地存储的键带卡片命名空间');
});

// ---------------- 运行时 ----------------

const CAST_HTML = [
    '<div class="cast" data-nl-each="主要角色"><template><article class="card"><img class="pt" data-nl-portrait=""><button type="button" class="swap" data-nl-portrait-next="">换</button><b data-nl-key></b></article></template></div>',
    '<div class="npcs" data-nl-each="NPC"><template><div class="npc"><span class="frame" data-nl-portrait=""></span><b data-nl-key></b></div></template></div>',
    '<img class="me" data-nl-portrait="主角"><button type="button" class="me-swap" data-nl-portrait-next="主角">换</button>',
    '<ul class="names" data-nl-each="名单"><template><li><img class="li-pt" data-nl-portrait=""></li></template></ul>',
].join('');

function open(opts = {}) {
    const c = card({ mode: 'bind', html: opts.html || CAST_HTML, ...(opts.extra || {}) });
    if (opts.listSpec) c.statusBar.spec = normalizeStatusSpec({ variables: [...SPEC_RAW.variables, { path: '名单', type: 'list', init: [] }] }, { maxVars: 30 });
    return openStatusDocument(compileStatusDocument(c), { stat: opts.stat || STAT, storage: opts.storage });
}

test('NL 运行时：记录模板里的立绘按条目取图，加载前后与失败时切换占位块（首字），没有图片时显示占位块', () => {
    const env = open();
    const d = env.document;
    assert.deepEqual(env.errors, []);
    const [liaCard, karlCard] = d.querySelectorAll('article.card');
    const img = liaCard.querySelector('img.pt');
    assert.equal(img.getAttribute('src'), 'https://img.example.com/lia-1.png', '好感 45：最高的已解锁是第二张');
    assert.equal(img.getAttribute('referrerpolicy'), 'no-referrer');
    assert.equal(img.getAttribute('data-nl-portrait-name'), '莉艾丽');
    assert.equal(img.getAttribute('data-nl-portrait-record'), '主要角色');
    assert.equal(img.getAttribute('data-nl-portrait-state'), 'loading');
    const ph = img.nextElementSibling;
    assert.ok(ph.hasAttribute('data-nl-ph'));
    assert.equal(ph.className, 'pt nl-portrait-ph', '占位块带上图片的 class，尺寸跟着界面走');
    assert.equal(ph.textContent, '莉');
    assert.equal(ph.style.getPropertyValue('--nl-ph-hue'), String(portraitHash('莉艾丽') % 360));
    assert.equal(img.hidden, true);
    assert.equal(ph.hidden, false);
    img.complete = true;
    img.naturalWidth = 300;
    img.fire('load');
    assert.equal(img.getAttribute('data-nl-portrait-state'), 'ok');
    assert.equal(img.hidden, false);
    assert.equal(ph.hidden, true);
    img.fire('error');
    assert.equal(img.getAttribute('data-nl-portrait-state'), 'error');
    assert.equal(ph.hidden, false, '加载失败显示占位块');
    // 卡尔没有配置图片、主要角色没有图池 → 占位块
    const karl = karlCard.querySelector('img.pt');
    assert.equal(karl.getAttribute('data-nl-portrait-state'), 'empty');
    assert.equal(karl.hasAttribute('src'), false);
    assert.equal(karl.nextElementSibling.textContent, '卡');
    assert.equal(karlCard.querySelector('.swap').hidden, true, '不足两张时隐藏换一张');
    assert.equal(liaCard.querySelector('.swap').hidden, false);
    assert.equal(liaCard.querySelector('.swap').getAttribute('data-nl-portrait-count'), '2');
    // 再渲染一轮：占位块不叠加
    env.update(STAT);
    const again = d.querySelectorAll('article.card')[0];
    assert.equal(again.querySelectorAll('[data-nl-ph]').length, 1);
    assert.equal(d.querySelectorAll('.cast [data-nl-ph]').length, 2);
});

test('NL 运行时：图池按字段取值稳定挑图，容器元素里自动放图片与占位块，列表按文字取名字', () => {
    const env = open({ listSpec: true, stat: { ...STAT, 名单: ['莉艾丽', '无名氏'] } });
    const d = env.document;
    const frames = d.querySelectorAll('.npc .frame');
    assert.equal(frames.length, 3);
    const p = normalizePortraits(PORTRAITS);
    for (const [i, name] of ['保安甲', '小混混', '路人'].entries()) {
        const inner = frames[i].querySelector('img.nl-portrait-img');
        assert.ok(inner, '容器里生成了 <img class="nl-portrait-img">');
        assert.equal(inner.getAttribute('src'), resolvePortrait(p, name, { record: 'NPC', stat: STAT }).url, name);
        assert.equal(inner.nextElementSibling.className, 'nl-portrait-ph');
        assert.equal(frames[i].getAttribute('data-nl-portrait-state'), 'loading');
    }
    env.update({ ...STAT, 名单: ['莉艾丽', '无名氏'] });
    assert.equal(d.querySelectorAll('.npc .frame')[0].querySelector('img').getAttribute('src'), resolvePortrait(p, '保安甲', { record: 'NPC', stat: STAT }).url, '重新渲染后仍是同一张（不闪）');
    const li = d.querySelectorAll('.names img.li-pt');
    assert.equal(li[0].getAttribute('src'), 'https://img.example.com/lia-0.png', '列表没有记录上下文：条件里的相对路径取不到，只剩无条件的图');
    assert.equal(li[1].getAttribute('data-nl-portrait-state'), 'empty');
    assert.equal(li[1].nextElementSibling.textContent, '无');
});

test('NL 运行时：换一张在已解锁的图片间循环，选择记在 nl-sb:<卡片>:<名字>，回到默认时删除；变量更新后默认跟着解锁变化', () => {
    const storage = memoryStorage();
    const env = open({ storage });
    const d = env.document;
    const swap = () => d.querySelectorAll('article.card')[0].querySelector('.swap');
    const src = () => d.querySelectorAll('article.card')[0].querySelector('img.pt').getAttribute('src');
    let cardClicks = 0;
    d.querySelectorAll('.cast')[0].addEventListener('click', () => { cardClicks++; });
    assert.equal(src(), 'https://img.example.com/lia-1.png');
    const ev = d.click(swap());
    assert.equal(ev.defaultPrevented, true);
    assert.equal(cardClicks, 0, '换一张不会冒泡到外层（例如点开详情的卡片）');
    assert.equal(src(), 'https://img.example.com/lia-0.png');
    assert.equal(storage.map.get('nl-sb:card_abc123:莉艾丽'), 'https://img.example.com/lia-0.png');
    d.click(swap());
    assert.equal(src(), 'https://img.example.com/lia-1.png');
    assert.equal(storage.map.has('nl-sb:card_abc123:莉艾丽'), false, '回到默认的那张时不再记着');
    d.click(swap());
    assert.equal(src(), 'https://img.example.com/lia-0.png');
    // 好感升到 90：第三张解锁，手动选的第一张仍然有效
    const up = structuredClone(STAT);
    up.主要角色.莉艾丽.好感 = 90;
    env.update(up);
    assert.equal(src(), 'https://img.example.com/lia-0.png');
    assert.equal(swap().getAttribute('data-nl-portrait-count'), '3');
    d.click(swap());
    assert.equal(src(), 'https://img.example.com/lia-1.png');
    d.click(swap());
    assert.equal(src(), 'https://img.example.com/lia-2.png', '回到默认（最高解锁）');
    assert.equal(storage.map.has('nl-sb:card_abc123:莉艾丽'), false);
    // 同一份存储重新打开：记住的选择生效
    storage.map.set('nl-sb:card_abc123:莉艾丽', 'https://img.example.com/lia-0.png');
    const env2 = open({ storage, stat: up });
    assert.equal(env2.document.querySelectorAll('article.card')[0].querySelector('img.pt').getAttribute('src'), 'https://img.example.com/lia-0.png');
    // 固定分组的换一张
    const me = () => env2.document.querySelector('img.me').getAttribute('src');
    assert.equal(env2.document.querySelector('.me-swap').hidden, true, '声望 10：只有一张');
    const famous = structuredClone(up);
    famous.主角.声望 = 70;
    env2.update(famous);
    assert.equal(me(), 'https://img.example.com/me-famous.png');
    env2.document.click(env2.document.querySelector('.me-swap'));
    assert.equal(me(), 'https://img.example.com/me.png');
    assert.equal(storage.map.get('nl-sb:card_abc123:主角'), 'https://img.example.com/me.png');
});

test('NL 运行时：本地存储不可用（沙箱预览）或不存在时，换一张仍在内存里循环，不报错', () => {
    for (const storage of ['throw', null]) {
        const env = open({ storage });
        const d = env.document;
        const src = () => d.querySelectorAll('article.card')[0].querySelector('img.pt').getAttribute('src');
        const swap = () => d.querySelectorAll('article.card')[0].querySelector('.swap');
        assert.equal(src(), 'https://img.example.com/lia-1.png');
        d.click(swap());
        assert.equal(src(), 'https://img.example.com/lia-0.png');
        env.update(STAT);
        assert.equal(src(), 'https://img.example.com/lia-0.png', '本次打开期间记得');
        d.click(swap());
        assert.equal(src(), 'https://img.example.com/lia-1.png');
        assert.deepEqual(env.errors, []);
    }
});

test('NL 运行时：nlRender 里的 ctx.portrait / ctx.portraits（脚本新建的立绘元素）', () => {
    const html = [
        '<div id="detail"></div>',
        '<script>window.nlRender = function (stat, ctx) {',
        "  var d = document.querySelector('[id]');",
        "  var info = ctx.portrait('莉艾丽', '主要角色');",
        "  d.setAttribute('data-url', info.url + '|' + info.urls.length + '|' + info.index);",
        "  var img = document.createElement('img');",
        "  img.setAttribute('data-nl-portrait', '莉艾丽');",
        "  img.setAttribute('data-nl-portrait-record', '主要角色');",
        '  d.textContent = "";',
        '  d.appendChild(img);',
        '  ctx.portraits(d);',
        '};</script>',
    ].join('\n');
    const env = open({ html });
    const d = env.document.querySelector('[id]');
    assert.deepEqual(env.errors, []);
    assert.equal(d.getAttribute('data-url'), 'https://img.example.com/lia-1.png|2|1');
    assert.equal(d.querySelector('img').getAttribute('src'), 'https://img.example.com/lia-1.png');
    assert.equal(d.querySelectorAll('[data-nl-ph]').length, 1);
});

test('预览页面：立绘配置与运行时一起进入 srcdoc，沙箱里访问本地存储抛错也不影响', () => {
    const src = buildPreviewSrcdoc(card(), STAT, { user: '我', char: '旁白' });
    assert.ok(src.includes('window.NL_PORTRAITS'));
    assert.ok(src.includes('window.NL_CARD_ID = "card_abc123"'));
    assert.ok(!src.includes('allow-same-origin'));
});

// ---------------- 预览里换的立绘：记进酒馆页面的本地存储（与聊天共用），重新载入后还在 ----------------

/** 预览页面 <head> 里模拟酒馆助手的那段脚本（previewMocks），与 iframe 实际收到的状态栏文档 */
function previewParts(src) {
    const mocks = src.match(/<script>(\(function previewMocks[\s\S]*?)<\/script>\n<\/head>/);
    assert.ok(mocks, '预览页面里有 previewMocks');
    const body = src.slice(src.indexOf('<body>\n') + '<body>\n'.length, src.lastIndexOf('\n</body>\n</html>'));
    return { mocks: mocks[1], body };
}

/** 像沙箱 iframe 一样打开预览：访问 localStorage 会抛错；父页面收到的消息记在 posted 里 */
function openPreview(c, opts = {}) {
    const posted = [];
    const { mocks, body } = previewParts(buildPreviewSrcdoc(c, STAT, { user: '我', char: '旁白', ...opts }));
    const env = openStatusDocument(body, {
        stat: STAT,
        storage: 'throw',
        prelude: [mocks],
        globals: { parent: { postMessage: (m) => posted.push(JSON.parse(JSON.stringify(m))) }, addEventListener() {}, setTimeout: (fn) => fn() },
    });
    return { env, posted };
}

test('readPortraitChoices / writePortraitChoice：只认本卡前缀的键与字符串地址；null 删除；存储不可用时记在内存里', () => {
    const c = card({ mode: 'bind', html: CAST_HTML });
    assert.equal(portraitStorePrefix(c), 'nl-sb:card_abc123:');
    const storage = memoryStorage();
    storage.map.set('nl-sb:card_abc123:莉艾丽', 'https://img.example.com/lia-0.png');
    storage.map.set('nl-sb:card_other:莉艾丽', 'https://img.example.com/x.png');
    storage.map.set('别的扩展的键', 'x');
    assert.deepEqual(readPortraitChoices(c, storage), { 'nl-sb:card_abc123:莉艾丽': 'https://img.example.com/lia-0.png' });

    assert.equal(writePortraitChoice(c, 'nl-sb:card_abc123:主角', 'https://img.example.com/me.png', storage), true);
    assert.equal(storage.map.get('nl-sb:card_abc123:主角'), 'https://img.example.com/me.png');
    assert.equal(writePortraitChoice(c, 'nl-sb:card_abc123:主角', null, storage), true);
    assert.equal(storage.map.has('nl-sb:card_abc123:主角'), false, 'null = 回到默认，删掉');
    for (const [k, v] of [
        ['nl-sb:card_other:主角', 'https://img.example.com/me.png'], // 别的卡
        ['nl-sb:card_abc123:', 'https://img.example.com/me.png'], // 没有名字
        ['theme', 'dark'], // 不是立绘的键
        ['nl-sb:card_abc123:a\nb', 'https://img.example.com/me.png'],
        ['nl-sb:card_abc123:主角', ''],
        ['nl-sb:card_abc123:主角', 42],
        ['nl-sb:card_abc123:主角', 'x'.repeat(40000)],
        [null, 'https://img.example.com/me.png'],
    ]) {
        assert.equal(writePortraitChoice(c, k, v, storage), false, String(k));
    }
    assert.equal(storage.map.size, 3, '拒绝的写入什么都不改');

    // 页面的本地存储不可用：记在内存里，照样读得回来
    const blocked = memoryStorage({ throws: true });
    assert.equal(writePortraitChoice(c, 'nl-sb:card_abc123:卡尔', 'https://img.example.com/npc.png', blocked), true);
    assert.deepEqual(readPortraitChoices(c, blocked), { 'nl-sb:card_abc123:卡尔': 'https://img.example.com/npc.png' });
    assert.equal(readPortraitChoices(c, null)['nl-sb:card_abc123:卡尔'], 'https://img.example.com/npc.png');
    assert.equal(writePortraitChoice(c, 'nl-sb:card_abc123:卡尔', null, blocked), true);
    assert.deepEqual(readPortraitChoices(c, blocked), {});
});

test('nl-store 把关（portraitChoiceProblem）：值只能是本卡配置的立绘地址；本卡最多记 STORE_ENTRIES_MAX 条（存储 + 内存），合计字数有上限', () => {
    const c = card({ mode: 'bind', html: CAST_HTML });
    c.id = 'card_store_gate';
    const pre = portraitStorePrefix(c);
    const urls = portraitChoiceUrls(c);
    assert.deepEqual([...urls].sort(), [
        'https://img.example.com/corp-a.png', 'https://img.example.com/corp-b.png', 'https://img.example.com/corp-c.png', 'https://img.example.com/gang.png',
        'https://img.example.com/lia-0.png', 'https://img.example.com/lia-1.png', 'https://img.example.com/lia-2.png', 'https://img.example.com/me-famous.png',
        'https://img.example.com/me.png', 'https://img.example.com/npc.png',
    ], '角色图片 + 图池各取值 + 兜底');
    assert.equal(portraitChoiceUrls({ statusBar: { portraits: { characters: { a: ['javascript:alert(1)'] } } } }).size, 0, '不合法的地址不算（与编译进文档的一样重新校验）');
    assert.equal(portraitChoiceUrls({}).size, 0);

    const storage = memoryStorage();
    assert.equal(portraitChoiceProblem(c, `${pre}莉艾丽`, 'https://img.example.com/lia-0.png', storage), '');
    assert.equal(portraitChoiceProblem(c, `${pre}莉艾丽`, null, storage), '', 'null（回到默认）总是可以');
    for (const v of ['https://evil.example.com/x.png', 'x'.repeat(32768), `data:image/png;base64,${'A'.repeat(100)}`, 'https://img.example.com/lia-0.png ']) {
        assert.match(portraitChoiceProblem(c, `${pre}莉艾丽`, v, storage), /不是这张卡配置的立绘地址/, v.slice(0, 40));
        assert.equal(writePortraitChoice(c, `${pre}莉艾丽`, v, storage), false);
    }
    assert.equal(storage.map.size, 0, '拒绝的写入什么都不改');
    assert.equal(writePortraitChoice(c, `${pre}${'名'.repeat(201)}`, 'https://img.example.com/npc.png', storage), false, '名字仍然最多 200 字');
    assert.equal(writePortraitChoice(c, `${pre}${'名'.repeat(200)}`, 'https://img.example.com/npc.png', storage), true);
    storage.map.clear();

    // 复现审查里的 PoC：AI 写的界面造 2000 个指向图池的换图按钮并逐个点击——父页面最多记 STORE_ENTRIES_MAX 条
    const N = 2000;
    const html = `<div class="zz"></div><script>window.nlRender = function (stat, ctx) { var z = document.querySelector('.zz'); if (z.children.length) return; for (var i = 0; i < ${N}; i++) { var b = document.createElement('button'); b.setAttribute('data-nl-portrait-next', 'n' + i); b.setAttribute('data-nl-portrait-record', 'NPC'); z.appendChild(b); } };</script>`;
    assert.deepEqual(lintStatusHtml(html, { mode: 'bind', spec: c.statusBar.spec }).errors, [], 'PoC 的界面代码本身检查不出错误');
    c.statusBar.html = html;
    c.statusBar.portraits.pools[0].fallback.push('https://img.example.com/npc-b.png'); // 兜底有两张，换图按钮才会轮换
    const { env, posted } = openPreview(c, { store: {} });
    assert.deepEqual(env.errors, []);
    for (const b of env.document.querySelectorAll('[data-nl-portrait-next]')) env.document.click(b);
    const msgs = posted.filter((m) => m.type === 'nl-store');
    assert.equal(msgs.length, N);
    storage.map.set('别的扩展的键', 'x');
    storage.map.set('nl-sb:card_other:甲', 'https://img.example.com/npc.png');
    const accepted = msgs.filter((m) => writePortraitChoice(c, m.key, m.value, storage)).length;
    assert.equal(accepted, STORE_ENTRIES_MAX);
    assert.equal([...storage.map.keys()].filter((k) => k.startsWith(pre)).length, STORE_ENTRIES_MAX);
    assert.equal(storage.map.size, STORE_ENTRIES_MAX + 2, '别的键不受影响');
    // 满了以后：已有的键仍可改、可删；删掉一条后又能记新的
    const k0 = msgs[0].key;
    const other = [...urls].find((u) => u !== storage.map.get(k0) && /corp|gang|npc/.test(u));
    assert.equal(writePortraitChoice(c, k0, other, storage), true, '已有的键可以改');
    assert.equal(writePortraitChoice(c, `${pre}新来的`, 'https://img.example.com/npc.png', storage), false);
    assert.match(portraitChoiceProblem(c, `${pre}新来的`, 'https://img.example.com/npc.png', storage), new RegExp(`已经记着 ${STORE_ENTRIES_MAX} 条`));
    assert.equal(writePortraitChoice(c, k0, null, storage), true);
    assert.equal(writePortraitChoice(c, `${pre}新来的`, 'https://img.example.com/npc.png', storage), true);
    // 本卡前缀下不合法的键也占名额（算的是存储里实际有多少）
    storage.map.set(`${pre}坏\n键`, 'x');
    assert.equal(writePortraitChoice(c, `${pre}又一个`, 'https://img.example.com/npc.png', storage), false);

    // 页面的本地存储不可用：内存里的也按同样的条数上限
    const blocked = memoryStorage({ throws: true });
    const c2 = card({ mode: 'bind', html: CAST_HTML });
    c2.id = 'card_store_mem';
    const pre2 = portraitStorePrefix(c2);
    let n = 0;
    for (let i = 0; i < STORE_ENTRIES_MAX + 50; i++) if (writePortraitChoice(c2, `${pre2}n${i}`, 'https://img.example.com/npc.png', blocked)) n++;
    assert.equal(n, STORE_ENTRIES_MAX);
    assert.equal(Object.keys(readPortraitChoices(c2, blocked)).length, STORE_ENTRIES_MAX);
    for (let i = 0; i < STORE_ENTRIES_MAX + 50; i++) writePortraitChoice(c2, `${pre2}n${i}`, null, blocked);
    assert.deepEqual(readPortraitChoices(c2, blocked), {}, '删干净（内存是模块级的，别影响其他测试）');

    // 合计字数：同一张内嵌图片记在很多名字下也不会超过 STORE_CHARS_MAX
    const big = `data:image/png;base64,${'A'.repeat(PORTRAIT_DATA_URL_MAX - 30)}`;
    const c3 = card({ mode: 'bind', html: CAST_HTML, portraits: { characters: {}, pools: [{ record: 'NPC', field: '阵营', pools: {}, fallback: [big] }] } });
    c3.id = 'card_store_chars';
    const s3 = memoryStorage();
    let ok = 0;
    for (let i = 0; i < 100; i++) if (writePortraitChoice(c3, `${portraitStorePrefix(c3)}n${i}`, big, s3)) ok++;
    const chars = [...s3.map].reduce((sum, [k, v]) => sum + k.length + v.length, 0);
    assert.ok(ok > 0 && ok < 100, String(ok));
    assert.ok(chars <= STORE_CHARS_MAX, String(chars));
    assert.ok(chars + big.length + `${portraitStorePrefix(c3)}n${ok}`.length > STORE_CHARS_MAX, '再记一条就会超出');
    assert.equal(writePortraitChoice(c3, `${portraitStorePrefix(c3)}n0`, null, s3), true, '删除不受字数限制');
});

test('nl-store 把关给了预览的数据（opt.data）时：只认预览里能换图的名字（配置了立绘的角色 + 图池记录在数据里的条目），造出来的名字不占条数上限', () => {
    const c = card({ mode: 'bind', html: CAST_HTML });
    c.id = 'card_store_names';
    const pre = portraitStorePrefix(c);
    // 角色名（与运行时一样不分大小写、去首尾空白）+ 图池记录 NPC 在数据里的条目；主要角色里没配图的卡尔、别的记录都不算
    assert.deepEqual([...portraitChoiceNames(c, STAT)].sort(), ['主角', '保安甲', '小混混', '莉艾丽', '路人'].sort());
    assert.deepEqual([...portraitChoiceNames(c, null)].sort(), ['主角', '莉艾丽'].sort(), '没有数据时只有配置了立绘的角色');
    assert.deepEqual([...portraitChoiceNames(c, { NPC: ['甲'] })].sort(), ['主角', '莉艾丽'].sort());
    assert.equal(portraitChoiceNames({ statusBar: {} }, STAT).size, 0);
    const lia = card({ mode: 'bind', html: CAST_HTML, portraits: { characters: { Lia: ['https://img.example.com/lia-0.png'] }, pools: [] } });
    assert.ok(portraitChoiceNames(lia, STAT).has('lia'));

    const storage = memoryStorage();
    const corp = 'https://img.example.com/corp-b.png';
    assert.equal(portraitChoiceProblem(c, `${pre}保安甲`, corp, storage, { data: STAT }), '');
    assert.equal(portraitChoiceProblem(c, `${pre} 莉艾丽 `, 'https://img.example.com/lia-0.png', storage, { data: STAT }), '');
    assert.match(portraitChoiceProblem(c, `${pre}卡尔`, corp, storage, { data: STAT }), /预览里没有这个角色的立绘/);
    assert.match(portraitChoiceProblem(c, `${pre}n0`, corp, storage, { data: STAT }), /预览里没有这个角色的立绘/);
    assert.match(portraitChoiceProblem(c, `${pre}聊天里的NPC`, null, storage, { data: STAT }), /预览里没有这个角色的立绘/, '也删不掉预览里没有的角色的选择');
    assert.equal(portraitChoiceProblem(c, `${pre}n0`, corp, storage), '', '不给数据时照旧只看前缀、地址与上限');

    // 审查 PoC 的变体：界面代码造 2000 个名字——给了数据就一个都不记，之后正常的换图仍然能记
    for (let i = 0; i < 2000; i++) assert.notEqual(portraitChoiceProblem(c, `${pre}n${i}`, corp, storage, { data: STAT }), '');
    assert.equal(storage.map.size, 0);
    for (let i = 0; i < STORE_ENTRIES_MAX; i++) storage.map.set(`${pre}chat${i}`, corp);
    assert.match(portraitChoiceProblem(c, `${pre}保安甲`, corp, storage, { data: STAT }), new RegExp(`已经记着 ${STORE_ENTRIES_MAX} 条`), '名字合格时条数上限照样生效');
});

test('预览页面：沙箱里换一张通过代用的 localStorage 告诉父页面（nl-store），父页面记下后重新载入仍显示选的那张', () => {
    const c = card({ mode: 'bind', html: CAST_HTML });
    const storage = memoryStorage();
    // 第一次打开：默认是最高的已解锁（好感 45 → 第二张）
    const first = openPreview(c, { store: readPortraitChoices(c, storage) });
    const d = first.env.document;
    const src = (doc) => doc.querySelectorAll('article.card')[0].querySelector('img.pt').getAttribute('src');
    assert.deepEqual(first.env.errors, []);
    assert.equal(src(d), 'https://img.example.com/lia-1.png');
    d.click(d.querySelectorAll('article.card')[0].querySelector('.swap'));
    assert.equal(src(d), 'https://img.example.com/lia-0.png');
    const msgs = first.posted.filter((m) => m.type === 'nl-store');
    assert.deepEqual(msgs, [{ type: 'nl-store', key: 'nl-sb:card_abc123:莉艾丽', value: 'https://img.example.com/lia-0.png', source: 'nl-preview' }]);
    // 父页面（对话框的消息处理）记下
    for (const m of msgs) assert.equal(writePortraitChoice(c, m.key, m.value, storage), true);
    assert.equal(storage.map.get('nl-sb:card_abc123:莉艾丽'), 'https://img.example.com/lia-0.png', '与聊天里的状态栏同一个键');

    // 重新载入预览：从父页面传进来的记录里读到选择
    const second = openPreview(c, { store: readPortraitChoices(c, storage) });
    assert.equal(src(second.env.document), 'https://img.example.com/lia-0.png', '重新载入后仍是选的那张');
    // 换回默认那张：发 null，父页面删掉这条记录
    second.env.document.click(second.env.document.querySelectorAll('article.card')[0].querySelector('.swap'));
    assert.equal(src(second.env.document), 'https://img.example.com/lia-1.png');
    const back = second.posted.filter((m) => m.type === 'nl-store');
    assert.deepEqual(back.map((m) => [m.key, m.value]), [['nl-sb:card_abc123:莉艾丽', null]]);
    for (const m of back) writePortraitChoice(c, m.key, m.value, storage);
    assert.equal(storage.map.has('nl-sb:card_abc123:莉艾丽'), false);
    assert.equal(src(openPreview(c, { store: readPortraitChoices(c, storage) }).env.document), 'https://img.example.com/lia-1.png');

    // 传进来的记录只留本卡前缀的键；不在已解锁列表里的地址不生效（运行时只认列表里的）
    const odd = openPreview(c, { store: { 'nl-sb:card_other:莉艾丽': 'https://img.example.com/lia-0.png', 'nl-sb:card_abc123:莉艾丽': 'https://img.example.com/lia-2.png' } });
    assert.equal(src(odd.env.document), 'https://img.example.com/lia-1.png', '第三张还没解锁，记着它也不显示');
    const page = buildPreviewSrcdoc(c, STAT, { store: { 'nl-sb:card_other:x': 'https://img.example.com/a.png', bad: 1 } });
    assert.ok(!page.includes('card_other'), '别的卡的记录不进预览页面');
    // 本地存储可以访问的环境（不是沙箱）不装代用品，运行时直接用真正的本地存储
    const real = memoryStorage();
    const { mocks, body } = previewParts(buildPreviewSrcdoc(c, STAT, {}));
    const env = openStatusDocument(body, { stat: STAT, storage: real, prelude: [mocks], globals: { parent: { postMessage() {} }, addEventListener() {}, setTimeout: (fn) => fn() } });
    env.document.click(env.document.querySelectorAll('article.card')[0].querySelector('.swap'));
    assert.equal(real.map.get('nl-sb:card_abc123:莉艾丽'), 'https://img.example.com/lia-0.png');
});
