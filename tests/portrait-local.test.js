// v0.13：立绘「选择本地图片」——酒馆图片路径的校验与编码、卡片与模板的内嵌图片上限、压缩计划（纯函数）、
// 存法设置、分享提示、预览里把酒馆图片换成 data:image（记住的选择仍是原路径 / 内嵌图片的短 id）、上传接口
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';

import { DEFAULT_SETTINGS, DEFAULT_STATUS_BAR } from '../src/constants.js';
import { applyConfig } from '../src/io.js';
import {
    EMBED_MAX_SIDE, EMBED_MIN_SIDE, EMBED_QUALITIES, SERVER_RAW_MAX_BYTES, SERVER_REENCODE_QUALITY, SERVER_REENCODE_SIDE, bytesToBase64, dataUrlBytes,
    fitSize, fmtK, hashBytes, imageFileTypeProblem, imageFolderName, imageMimeOf, nextEmbedAttempt, planServerImage, serverImageName, sniffImageType,
} from '../src/portrait-image.js';
import {
    PORTRAIT_DATA_TOTAL_MAX, PORTRAIT_DATA_URL_MAX, TEMPLATE_PORTRAIT_DATA_TOTAL_MAX, TEMPLATE_PORTRAIT_DATA_URL_MAX, TEMPLATE_PORTRAIT_LIMITS,
    buildStatusRegexReplace, ensureStatusBar, isOwnServerImage, lintStatusHtml, normalizePortraits, normalizeServerPortraitInput, normalizeStatusSpec,
    portraitChoiceId, portraitStorageStats, portraitStoreOf, portraitUrlKind, portraitUrlList, portraitUrlProblem, resolvePortrait, serverPathProblem,
    serverPortraitHint, serverPortraitUrl,
} from '../src/statusbar.js';
import {
    buildNlRuntime, buildPreviewSrcdoc, compileStatusDocument, portraitChoiceProblem, readPortraitChoices, writePortraitChoice,
} from '../src/statusbar-runtime.js';
import {
    addStatusBarTemplate, applyStatusBarTemplate, exportStatusBarTemplate, importStatusBarTemplate, listStatusBarTemplates, parseStatusBarTemplate,
    templateFromStatusBar, templatePortraits,
} from '../src/statusbar-templates.js';
import { ImageUploadError, uploadErrorText, uploadImageToST } from '../src/stio.js';
import {
    poolLineId, poolThumbsHtml, portraitKindBadgeHtml, portraitLocalMsgHtml, portraitStoreBarHtml, portraitsPanelHtml, portraitDraftFrom, templatePortraitNotes,
} from '../src/ui/statusbar-dialog.js';
import { previewSrcMap } from '../src/ui/portrait-files.js';
import { mergeDefaults } from '../src/utils.js';
import { memoryStorage, openStatusDocument } from './minidom.js';
import { PROSES, scriptsOf, stFixMarkdown, stIframeText } from './stsim.js';

const enc = (s) => encodeURIComponent(s);
const FOLDER = `/user/images/${enc('魔女旁白')}`;
const SRV_A = `${FOLDER}/nl_0123456789abcdef.png`;
const SRV_B = `${FOLDER}/nl_fedcba9876543210.webp`;
const SRV_C = `${FOLDER}/nl_00000000000000aa.png`;
const HTTP = 'https://img.example.com/a.png';
const dataUrl = (n, type = 'webp') => `data:image/${type};base64,${'A'.repeat(n - `data:image/${type};base64,`.length)}`;
const EMB = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGM4ERAAAANMAWmFQTGjAAAAAElFTkSuQmCC';
const PREVIEW_A = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAIAAAB7QOjdAAAAD0lEQVR4nGMICDgREHACAAjvAtGOlatMAAAAAElFTkSuQmCC';

const SPEC = {
    title: '群像',
    variables: [
        { path: '世界.时间', type: 'string', init: '清晨' },
        { path: '主要角色', type: 'record', keyDesc: '角色名', value: { type: 'object', fields: [{ key: '好感', type: 'number', min: 0, max: 100, init: 0 }] }, init: { 莉莉丝: { 好感: 30 }, 江酒: {} } },
        { path: 'NPC', type: 'record', keyDesc: '名字', value: { type: 'object', fields: [{ key: '阵营', type: 'string' }] }, init: {} },
    ],
};
const STAT = { 世界: { 时间: '夜' }, 主要角色: { 莉莉丝: { 好感: 30 }, 江酒: { 好感: 5 } }, NPC: { 路人: { 阵营: '无' } } };
const CAST_HTML = '<div class="cast" data-nl-each="主要角色"><template><article class="card"><img class="pt" data-nl-portrait=""><button type="button" class="swap" data-nl-portrait-next="">换</button><b data-nl-key></b></article></template></div>'
    + '<div class="npcs" data-nl-each="NPC"><template><div class="npc"><img class="pt" data-nl-portrait=""></div></template></div>';
const PORTRAITS = {
    characters: { 莉莉丝: [{ url: SRV_A, label: '初见' }, { url: SRV_B }], 江酒: [{ url: EMB }, { url: SRV_C }] },
    pools: [{ record: 'NPC', field: '阵营', pools: {}, fallback: [SRV_A, HTTP] }],
};

function card(extra = {}) {
    const c = { id: 'card_local', kind: 'world', charName: '', data: { name: '魔女旁白' } };
    ensureStatusBar(c, {});
    c.statusBar.spec = normalizeStatusSpec(SPEC, { maxVars: 30 });
    c.statusBar.mode = 'bind';
    c.statusBar.html = CAST_HTML;
    c.statusBar.portraits = structuredClone(PORTRAITS);
    Object.assign(c.statusBar, extra);
    return c;
}

function settings() {
    const s = structuredClone(DEFAULT_SETTINGS);
    s.statusBarTemplates = [];
    return s;
}

// ---------------- 酒馆图片路径 ----------------

test('serverPathProblem / portraitUrlProblem：接受 /user/images/ 下逐段编码的图片路径，拒绝路径穿越、编码过的斜杠 / 点、怪字符与非图片扩展名', () => {
    for (const ok of [
        SRV_A, SRV_B, '/user/images/x.webp', '/user/images/a/b/c.jpeg', '/user/images/a/x.JFIF', '/user/images/a/x.GIF', '/user/images/a/x.bmp',
        '/user/images/a%20b/c.jpg', '/user/images/~x/y.Png', '/user/images/a.b_c-d/e.png', `/user/images/${enc("Bob's (1)")}/x.png`.replace(/'/g, '%27').replace(/\(/g, '%28').replace(/\)/g, '%29'),
        `/user/images/${enc('🙂表情')}/x.webp`,
    ]) {
        assert.equal(serverPathProblem(ok), '', ok);
        assert.equal(portraitUrlProblem(ok), '', ok);
        assert.equal(portraitUrlKind(ok), 'server', ok);
    }
    for (const bad of [
        '/user/images/', '/user/images/a/', '/user/images//a.png', '/user/images/a//b.png',
        '/user/images/../x.png', '/user/images/./x.png', '/user/images/a/../../x.png', '/user/images/%2E%2E/x.png', '/user/images/.%2E/x.png', '/user/images/%2e/x.png',
        '/user/images/a%2Fb.png', '/user/images/a%2fb.png', '/user/images/a%5Cb.png', '/user/images/%252F/x.png', '/user/images/%252E%252E/x.png', '/user/images/a%25/x.png',
        '/user/images/a%00/x.png', '/user/images/a%0A/x.png', '/user/images/a%7F/x.png', '/user/images/%E9%AD/x.png', '/user/images/%G1/x.png', '/user/images/a%2/x.png',
        '/user/images/a b/x.png', '/user/images/a"b/x.png', "/user/images/a'b/x.png", '/user/images/<x>/y.png', '/user/images/a\\b.png', '/user/images/a{b}/x.png',
        '/user/images/a$1/x.png', '/user/images/a*b/x.png', '/user/images/a(b)/x.png', '/user/images/a/x.png?x=1', '/user/images/a/x.png#f', '/user/images/魔女/x.png',
        '/user/images/a/x.svg', '/user/images/a/x', '/user/images/a/x.png.txt', '/user/images/a/x%2Epng', `/user/images/a/${'x'.repeat(2100)}.png`,
    ]) {
        assert.notEqual(serverPathProblem(bad), '', bad.slice(0, 60));
        assert.notEqual(portraitUrlProblem(bad), '', bad.slice(0, 60));
        assert.equal(portraitUrlKind(bad), '', bad.slice(0, 60));
    }
    // 只有 /user/images/ 下的根相对路径；别的根相对 / 相对 / 协议相对地址一律不行（大小写也要一致）
    for (const bad of ['/USER/images/a/x.png', '/user/Images/a/x.png', '//evil.example.com/user/images/x.png', 'user/images/x.png', '/user/files/x.png', '/img/a.png', '/user/images']) {
        assert.notEqual(portraitUrlProblem(bad), '', bad);
    }
    assert.match(portraitUrlProblem('/user/images/../x.png'), /\. 或 \.\./);
    assert.match(portraitUrlProblem('/user/images/a%2Fb.png'), /编码过的斜杠/);
    assert.match(portraitUrlProblem('/user/images/a/x.svg'), /结尾/);
    assert.match(portraitUrlProblem('/img/a.png'), /^只支持 http\(s\) 图床地址、酒馆服务器上的图片/);
    assert.match(portraitUrlProblem('ftp://x/a.png'), /^只支持 http/);
    assert.equal(portraitUrlKind(HTTP), 'http');
    assert.equal(portraitUrlKind(EMB), 'embed');
});

test('serverPortraitUrl：酒馆返回的路径（未编码，可能没有开头的 / 或用反斜杠）→ 逐段编码的根相对地址；文件夹名里有 % 或不在 user/images 下时为空', () => {
    assert.equal(serverPortraitUrl('/user/images/魔女旁白/nl_0123456789abcdef.png'), SRV_A);
    assert.equal(serverPortraitUrl('user/images/魔女旁白/nl_0123456789abcdef.png'), SRV_A, '没有开头的 /');
    assert.equal(serverPortraitUrl('\\user\\images\\魔女旁白\\nl_0123456789abcdef.png'), SRV_A, 'Windows 的反斜杠');
    assert.equal(serverPortraitUrl('/user/images/a b/c.png'), '/user/images/a%20b/c.png');
    const odd = serverPortraitUrl("/user/images/Bob's (1)! #2 *x/nl_1.webp");
    assert.equal(odd, '/user/images/Bob%27s%20%281%29%21%20%232%20%2Ax/nl_1.webp', '引号、括号、!、#、* 也编码');
    assert.equal(serverPathProblem(odd), '');
    assert.equal(decodeURIComponent(odd.split('/')[3]), "Bob's (1)! #2 *x", '每段解码后就是酒馆上的文件夹名');
    assert.equal(serverPortraitUrl('/user/images/nl_x.png'), '/user/images/nl_x.png', '没有文件夹（角色名被 sanitize 成空）');
    for (const bad of ['/user/images/100%/x.png', '/user/files/a/x.png', '/user/images/../x.png', '/user/images/a/x.txt', '/user/images/a//x.png', '', null, 'images/a/x.png']) {
        assert.equal(serverPortraitUrl(bad), '', String(bad));
    }
    // 上传时的文件夹名：卡片在酒馆里的角色名，% 换成 _（酒馆读文件时会解码两次），去掉控制字符
    assert.equal(imageFolderName('100% 魔女\n'), '100_ 魔女');
    assert.equal(serverPortraitUrl(`/user/images/${imageFolderName('100% 魔女')}/nl_x.png`), `/user/images/100_%20${enc('魔女')}/nl_x.png`);
});

// ---------------- 卡片与模板的内嵌图片上限 ----------------

test('内嵌图片上限：卡片单张 128K、合计 768K；模板单张 32K、合计 192K（超出的丢掉，提示改存到酒馆服务器）', () => {
    assert.equal(PORTRAIT_DATA_URL_MAX, 131072);
    assert.equal(PORTRAIT_DATA_TOTAL_MAX, 786432);
    assert.equal(TEMPLATE_PORTRAIT_DATA_URL_MAX, 32768);
    assert.equal(TEMPLATE_PORTRAIT_DATA_TOTAL_MAX, 196608);
    const big = dataUrl(100000);
    assert.equal(portraitUrlProblem(big), '', '卡片里可以放 100K 字的内嵌图片');
    assert.match(portraitUrlProblem(dataUrl(PORTRAIT_DATA_URL_MAX + 1)), /内嵌图片太大.*最多 128K.*存到酒馆服务器/);
    assert.match(portraitUrlProblem(big, TEMPLATE_PORTRAIT_LIMITS), /模板里每张最多 32K.*「立绘」页.*酒馆服务器/);
    // 卡片：合计 768K
    const w = [];
    const many = Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`人${i}`, [dataUrl(100000 - i)]]));
    const p = normalizePortraits({ characters: many }, { warnings: w });
    assert.equal(Object.keys(p.characters).length, 7);
    assert.match(w.join('\n'), /内嵌图片合计超过 768K 字，请改用图床地址，或存到酒馆服务器/);
    // 模板：单张与合计都更小；酒馆路径、图床地址不受影响
    const tw = [];
    const t = normalizePortraits({ characters: { 甲: [big, SRV_A, HTTP], 乙: Array.from({ length: 8 }, (_, i) => dataUrl(30000 - i)) } }, { warnings: tw, ...TEMPLATE_PORTRAIT_LIMITS });
    assert.deepEqual(t.characters.甲.map((x) => x.url), [SRV_A, HTTP]);
    assert.equal(t.characters.乙.length, 6, '合计 192K：6 张 30K 的放得下');
    assert.match(tw.join('\n'), /「甲」的图片已丢弃：内嵌图片太大（98K 字，模板里每张最多 32K）/);
    assert.match(tw.join('\n'), /模板里的内嵌图片合计超过 192K 字，要分享请改用图床地址；只在本机用可以在「立绘」页改存到酒馆服务器/);
    // 默认（不传上限）就是卡片的：模板之外的地方行为不变
    assert.deepEqual(normalizePortraits({ characters: { 甲: [big] } }).characters.甲, [{ url: big }]);
});

test('模板：存模板 / 导入模板 / 角色卡 JSON / 配置导入都按模板的上限丢掉过大的内嵌图片并给出提示；套用模板时并进卡片按卡片的上限', () => {
    const c = card();
    const big = dataUrl(60000);
    c.statusBar.portraits.characters.莉莉丝.push({ url: big, label: '大图' });
    // templateFromStatusBar
    const warnings = [];
    const data = templateFromStatusBar(c, { name: '带图', portraits: true, warnings });
    assert.deepEqual(data.portraits.characters.莉莉丝.map((x) => x.url), [SRV_A, SRV_B], '酒馆路径照样带上，过大的内嵌图片去掉');
    assert.equal(data.portraits.characters.江酒[0].url, EMB, '小的内嵌图片照样带上');
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /^模板的立绘：「莉莉丝」的图片已丢弃：内嵌图片太大（59K 字，模板里每张最多 32K）：要分享请改用图床地址；只在本机用可以在「立绘」页改存到酒馆服务器/);
    assert.deepEqual(templatePortraits({ characters: { 甲: [big] } }), null, '一张都不剩时为 null');
    // addStatusBarTemplate 的 warnings；不带 warnings 时照样丢（只是没有提示）
    const s = settings();
    const w2 = [];
    const saved = addStatusBarTemplate(s, { ...data, name: '直接存', portraits: c.statusBar.portraits }, { warnings: w2 });
    assert.equal(saved.portraits.characters.莉莉丝.length, 2);
    assert.equal(w2.length, 1);
    // 导入模板文件 / 角色卡 JSON
    const file = { ...exportStatusBarTemplate(saved), portraits: c.statusBar.portraits };
    const w3 = [];
    const imported = importStatusBarTemplate(s, JSON.stringify(file), { warnings: w3 });
    assert.equal(imported.portraits.characters.莉莉丝.length, 2);
    assert.match(w3.join('\n'), /模板里每张最多 32K/);
    const cardJson = { spec: 'chara_card_v3', data: { name: '魔女旁白', first_mes: '', extensions: { novel_loom: { statusBar: { mode: 'bind', spec: c.statusBar.spec, html: CAST_HTML, portraits: c.statusBar.portraits } } } } };
    const w4 = [];
    const fromCard = parseStatusBarTemplate(cardJson, { warnings: w4 });
    assert.equal(fromCard.portraits.characters.莉莉丝.length, 2);
    assert.equal(w4.length, 1, '同一张图只提示一次');
    // 配置导入：statusBarTemplates 里的过大内嵌图片丢掉，返回提示
    const s2 = settings();
    const r = applyConfig(s2, { type: 'novel_loom_config', settings: { statusBarTemplates: [{ id: 'sbtpl_x', name: '配置里的', mode: 'auto', spec: c.statusBar.spec, portraits: c.statusBar.portraits }, { id: 'sbtpl_y', name: '没图的', mode: 'auto', spec: c.statusBar.spec }] } });
    assert.equal(s2.statusBarTemplates[0].portraits.characters.莉莉丝.length, 2);
    assert.equal(s2.statusBarTemplates[1].portraits, undefined, '没有立绘的模板不加字段');
    assert.equal(r.warnings.length, 1);
    assert.match(r.warnings[0], /^状态栏模板「配置里的」：模板的立绘：「莉莉丝」的图片已丢弃/);
    assert.equal(listStatusBarTemplates(s2).find((x) => x.id === 'sbtpl_x').portraits.characters.莉莉丝.length, 2);
    // 套用：模板的立绘（不超过模板上限）并进卡片，卡片自己的大图不受模板上限影响
    const target = card({ portraits: { characters: { 江酒: [{ url: dataUrl(90000) }] }, pools: [] } });
    const res = applyStatusBarTemplate(target, { ...saved, id: saved.id }, 'structure', { settings: s });
    assert.equal(target.statusBar.portraits.characters.江酒[0].url.length, 90000, '卡片自己的 90K 内嵌图片保留');
    assert.deepEqual(target.statusBar.portraits.characters.莉莉丝.map((x) => x.url), [SRV_A, SRV_B]);
    assert.ok(res.warnings.some((x) => x.includes('已带上模板里的立绘设置')));
});

// ---------------- 压缩计划与格式识别（纯函数） ----------------

test('planServerImage：酒馆认的格式、不超过 4MB、最长边不超过 2048 → 原样上传（jpeg 写成 jpg）；否则 webp 重新编码到最长边 1600', () => {
    assert.deepEqual(planServerImage({ format: 'png', bytes: 1000, width: 64, height: 64 }), { mode: 'raw', format: 'png' });
    assert.deepEqual(planServerImage({ format: 'jpg', bytes: 1000, width: 2048, height: 100 }), { mode: 'raw', format: 'jpg' });
    assert.deepEqual(planServerImage({ format: 'jpeg', bytes: 1000, width: 10, height: 10 }), { mode: 'raw', format: 'jpg' });
    assert.deepEqual(planServerImage({ format: 'gif', bytes: SERVER_RAW_MAX_BYTES, width: 500, height: 500 }), { mode: 'raw', format: 'gif' }, 'GIF 原样上传，动图还会动');
    assert.deepEqual(planServerImage({ format: 'png', bytes: SERVER_RAW_MAX_BYTES + 1, width: 500, height: 500 }), { mode: 'encode', width: 500, height: 500, quality: SERVER_REENCODE_QUALITY });
    assert.deepEqual(planServerImage({ format: 'png', bytes: 1000, width: 2600, height: 1400 }), { mode: 'encode', width: SERVER_REENCODE_SIDE, height: 862, quality: 0.88 });
    assert.deepEqual(planServerImage({ format: 'avif', bytes: 1000, width: 300, height: 200 }), { mode: 'encode', width: 300, height: 200, quality: 0.88 }, '酒馆不收 avif');
    assert.equal(planServerImage({ format: 'heic', bytes: 1000, width: 4000, height: 3000 }).width, 1600);
    assert.equal(planServerImage({ format: '', bytes: 1000, width: 10, height: 10 }).mode, 'encode');
    assert.deepEqual(fitSize(1200, 1600, EMBED_MAX_SIDE), { width: 384, height: 512 });
    assert.deepEqual(fitSize(100, 50, 512), { width: 100, height: 50 }, '不放大');
    assert.deepEqual(fitSize(4000, 1, 512), { width: 512, height: 1 }, '至少 1');
});

test('nextEmbedAttempt：最长边 512、质量 0.85 → 0.75 → 0.65 → 0.55，再缩尺寸（至少 ×0.8，超出很多时一步缩到位），直到不超过上限', () => {
    const limit = 131072;
    let a = nextEmbedAttempt({ width: 3000, height: 2000 }, null, { limit });
    assert.deepEqual(a, { width: 512, height: 341, quality: 0.85 });
    assert.equal(nextEmbedAttempt({ width: 3000, height: 2000 }, { ...a, chars: limit }, { limit }), null, '不超过上限就停');
    const seen = [];
    for (const q of EMBED_QUALITIES.slice(1)) {
        a = nextEmbedAttempt({ width: 3000, height: 2000 }, { ...a, chars: limit + 1 }, { limit });
        seen.push(a.quality);
        assert.equal(a.width, 512);
        assert.equal(a.quality, q);
    }
    assert.deepEqual(seen, [0.75, 0.65, 0.55]);
    const shrink = nextEmbedAttempt({ width: 3000, height: 2000 }, { ...a, chars: limit + 1 }, { limit });
    assert.equal(shrink.quality, 0.55, '尺寸缩小时质量保持最低一档');
    assert.equal(shrink.width, Math.floor(512 * 0.8), '只超出一点：×0.8');
    const far = nextEmbedAttempt({ width: 3000, height: 2000 }, { ...a, chars: limit * 4 }, { limit });
    assert.ok(far.width < 512 * 0.5 && far.width >= 512 * 0.25, `超出 4 倍：一步缩到约一半以下（${far.width}）`);
    assert.equal(nextEmbedAttempt({ width: 60, height: 60 }, { width: EMBED_MIN_SIDE, height: EMBED_MIN_SIDE, quality: 0.55, chars: limit * 2 }, { limit }), null, '缩到最小也放不下：放弃');
    // 模拟一个「字数与面积 × 质量成正比」的编码器：整个计划在有限步内收敛到上限以内
    for (const [w, h, perPixel] of [[4000, 3000, 2], [512, 512, 1.2], [800, 600, 8], [2000, 2000, 30]]) {
        let at = nextEmbedAttempt({ width: w, height: h }, null, { limit });
        let steps = 0;
        let last = null;
        while (at && steps < 30) {
            last = { ...at, chars: Math.round(at.width * at.height * at.quality * perPixel) };
            at = nextEmbedAttempt({ width: w, height: h }, last, { limit });
            steps++;
        }
        assert.ok(last.chars <= limit || Math.max(last.width, last.height) < EMBED_MIN_SIDE / 0.8, `${w}×${h}×${perPixel}：${JSON.stringify(last)}`);
        assert.ok(steps <= 12, `${w}×${h}×${perPixel} 用了 ${steps} 步`);
    }
});

test('sniffImageType / imageFileTypeProblem / hashBytes / base64：按字节认格式（SVG 认出来好拒绝），只收 image/* 且不收 SVG，哈希稳定', () => {
    const b = (...xs) => Uint8Array.from(xs.flatMap((x) => (typeof x === 'string' ? [...x].map((c) => c.charCodeAt(0)) : [x])));
    assert.equal(sniffImageType(b(0x89, 'PNG', 0x0d, 0x0a, 0x1a, 0x0a, 0, 0)), 'png');
    assert.equal(sniffImageType(b(0xff, 0xd8, 0xff, 0xe0)), 'jpg');
    assert.equal(sniffImageType(b('GIF89a', 1, 0)), 'gif');
    assert.equal(sniffImageType(b('RIFF', 1, 2, 3, 4, 'WEBPVP8 ')), 'webp');
    assert.equal(sniffImageType(b('BM', 0, 0)), 'bmp');
    assert.equal(sniffImageType(b(0, 0, 0, 0x1c, 'ftypavif')), 'avif');
    assert.equal(sniffImageType(b(0, 0, 0, 0x18, 'ftypheic')), 'heic');
    assert.equal(sniffImageType(b('<svg xmlns="x">')), 'svg');
    assert.equal(sniffImageType(b(0xef, 0xbb, 0xbf, '  \n<?xml version="1.0"?><svg/>')), 'svg');
    assert.equal(sniffImageType(b('hello')), '');
    assert.equal(sniffImageType(null), '');
    assert.equal(imageMimeOf('jpg'), 'image/jpeg');
    assert.equal(imageFileTypeProblem('image/png'), '');
    assert.equal(imageFileTypeProblem(''), '', '没有类型时读出字节再判断');
    assert.equal(imageFileTypeProblem('text/plain'), '不是图片');
    assert.equal(imageFileTypeProblem('image/svg+xml'), '不支持 SVG 图片');
    const x = b('abcdef');
    assert.match(hashBytes(x), /^[0-9a-f]{16}$/);
    assert.equal(hashBytes(x), hashBytes(b('abcdef')), '同样的内容同样的哈希');
    assert.notEqual(hashBytes(x), hashBytes(b('abcdeg')));
    assert.notEqual(hashBytes(b()), hashBytes(b(0)));
    assert.match(serverImageName(x), /^nl_[0-9a-f]{16}$/);
    const bytes = Uint8Array.from({ length: 70000 }, (_, i) => (i * 7) % 256);
    const round = dataUrlBytes(`data:image/png;base64,${bytesToBase64(bytes)}`);
    assert.equal(round.mime, 'image/png');
    assert.deepEqual([...round.bytes], [...bytes]);
    assert.equal(dataUrlBytes('data:image/png,raw'), null);
    // 前缀大小写不限（与 DATA_IMAGE_RE 一致）：校验认它是内嵌图片，「存到酒馆」时也得能还原
    const upper = EMB.replace('data:image/png;base64,', 'DATA:IMAGE/PNG;BASE64,');
    assert.equal(portraitUrlKind(upper), 'embed');
    assert.equal(dataUrlBytes(upper).mime, 'image/png');
    assert.deepEqual([...dataUrlBytes(upper).bytes], [...dataUrlBytes(EMB).bytes]);
    assert.equal(fmtK(0), '0K');
    assert.equal(fmtK(3791), '3.7K');
    assert.equal(fmtK(786432), '768K');
});

// ---------------- 设置、统计与提示 ----------------

test('存法设置：默认酒馆服务器；旧设置补上默认值；导入配置时只认 server / embed', () => {
    assert.equal(DEFAULT_STATUS_BAR.portraitStore, 'server');
    assert.equal(DEFAULT_SETTINGS.statusBar.portraitStore, 'server');
    const old = { statusBar: { maxVars: 8 } };
    mergeDefaults(old, DEFAULT_SETTINGS);
    assert.equal(old.statusBar.portraitStore, 'server', '没有这一项的旧设置补上默认值');
    assert.equal(portraitStoreOf(old), 'server');
    assert.equal(portraitStoreOf({ statusBar: { portraitStore: 'embed' } }), 'embed');
    assert.equal(portraitStoreOf({ statusBar: { portraitStore: 'cloud' } }), 'server');
    assert.equal(portraitStoreOf(null), 'server');
    const s = settings();
    assert.deepEqual(applyConfig(s, { statusBar: { portraitStore: 'embed' } }), { warnings: [] });
    assert.equal(s.statusBar.portraitStore, 'embed');
    applyConfig(s, { statusBar: { portraitStore: '<script>' } });
    assert.equal(s.statusBar.portraitStore, 'server', '不认识的值回到默认');
    s.statusBar.portraitStore = 'embed';
    applyConfig(s, { statusBar: { maxVars: 9 } });
    assert.equal(s.statusBar.portraitStore, 'embed', '配置里没有这一项时不动');
});

test('portraitStorageStats / serverPortraitHint：按存放位置数不重复的张数，内嵌字数按出现次数算；有酒馆图片时给出分享提示', () => {
    const c = card();
    c.statusBar.portraits.pools[0].pools.敌对 = [EMB, 'javascript:alert(1)'];
    const st = portraitStorageStats(c.statusBar.portraits);
    assert.deepEqual(st, { server: 3, embed: 1, http: 1, embedChars: EMB.length * 2 });
    assert.deepEqual(portraitUrlList({ characters: [{ name: '甲', images: [{ url: SRV_A }, SRV_B] }], pools: [{ fallback: SRV_C }] }), [SRV_A, SRV_B, SRV_C], '草稿形状（[{name, images}]）也认');
    // 卡片：指明真正能改的按钮（存法切换只管之后选的图）
    assert.equal(serverPortraitHint(c.statusBar.portraits), '3 张立绘存在酒馆服务器上，把卡分享给别人时不会跟着走，对方会看到首字占位；要分享请在「立绘」页点「全部改成内嵌」（或每张图旁边的「改成内嵌」）');
    // 模板：内嵌的上限小得多，建议图床地址，不再指向「改成嵌进卡片」（那样多半又超过模板的上限）
    const tplHint = serverPortraitHint(c.statusBar.portraits, 'template');
    assert.equal(tplHint, '3 张立绘存在酒馆服务器上，把模板导出分享给别人时不会跟着走，对方会看到首字占位；要分享请改用图床（http）地址，模板里只能内嵌 32K 字以内的小图');
    assert.ok(!/嵌进卡片|改成内嵌/.test(tplHint));
    assert.equal(serverPortraitHint({ characters: { 甲: [{ url: HTTP }, { url: EMB }] } }), '');
    assert.equal(serverPortraitHint(null), '');
    // 存模板时的提醒：酒馆图片 + 超过模板上限的内嵌图片
    c.statusBar.portraits.characters.江酒.push({ url: dataUrl(40000) });
    const notes = templatePortraitNotes(c.statusBar.portraits);
    assert.equal(notes.length, 2);
    assert.match(notes[0], /把模板导出分享给别人时不会跟着走/);
    assert.match(notes[1], /^有 1 张内嵌图片超过模板的上限（每张 32K、合计 192K 字，卡片里可以更大），存模板时会去掉；要分享请改用图床地址，只在本机用可以在「立绘」页改存到酒馆服务器$/);
    assert.ok(!/改成嵌进卡片|改成内嵌/.test(notes.join('\n')), '两条提醒都不让人在酒馆服务器和内嵌之间来回改');
    assert.deepEqual(templatePortraitNotes({ characters: { 甲: [HTTP] } }), []);
});

test('「立绘」分页：存法切换、内嵌用量、分享提示、每张图的存放位置标签与转换按钮、各处的「选择本地图片」与拖放目标；文件名等都转义', () => {
    const bar = portraitStoreBarHtml({ store: 'embed', portraits: { characters: { 甲: [{ url: dataUrl(78643) }, { url: SRV_A }] } } });
    assert.match(bar, /data-sb-pt-store="embed"/);
    assert.match(bar, /<button class="nl-seg-btn " aria-pressed="false" data-act="sb-pt-store" data-sb-val="server">酒馆服务器<\/button><button class="nl-seg-btn active" aria-pressed="true" data-act="sb-pt-store" data-sb-val="embed">嵌进卡片<\/button>/);
    assert.match(bar, /内嵌图片 已用 76.8K \/ 上限 768K/);
    assert.match(bar, /role="meter"[^>]*aria-valuenow="78643"><i style="width:10%"><\/i>/);
    assert.match(bar, /删掉的图片不会从酒馆服务器上删除，仍在这个角色的图库里/);
    assert.match(bar, /data-sb-pt-share-hint>.*1 张立绘存在酒馆服务器上/);
    assert.ok(!portraitStoreBarHtml({}).includes('data-sb-pt-share-hint'));
    assert.match(portraitStoreBarHtml({ portraits: { characters: { 甲: Array.from({ length: 7 }, (_, i) => dataUrl(100000 - i)) } } }), /data-level="warn"/);

    assert.match(portraitKindBadgeHtml(SRV_A), /data-kind="server"[^>]*>酒馆</);
    assert.match(portraitKindBadgeHtml(HTTP), />图床</);
    assert.match(portraitKindBadgeHtml(dataUrl(38912)), />内嵌 38K</);
    assert.equal(portraitKindBadgeHtml('javascript:alert(1)'), '');

    const msg = portraitLocalMsgHtml('c:0', { level: 'err', lines: ['「<img src=x onerror=alert(1)>.png」：不是图片'], fallback: true });
    assert.ok(!msg.includes('<img'), '文件名不会变成 HTML');
    assert.match(msg, /&lt;img src=x onerror=alert\(1\)&gt;\.png/);
    assert.match(msg, /data-act="sb-pt-embed-fallback" data-sb-pt-target="c:0"/);
    assert.match(portraitLocalMsgHtml('v:0:1', null), /^<div class="nl-sb-pt-local" data-sb-pt-local="v:0:1" role="status"><\/div>$/);

    const spec = normalizeStatusSpec(SPEC, { maxVars: 30 });
    const p = normalizePortraits(PORTRAITS, { spec });
    const d = portraitDraftFrom(p);
    d.pools[0].values = [{ value: '敌对', urls: `${SRV_B}\n${EMB}` }];
    const html = portraitsPanelHtml({ draft: d, spec, portraits: p, sb: { mode: 'auto' }, store: 'server', local: { 'c:1': { level: 'ok', lines: ['已添加 1 张（存到酒馆服务器）'] }, 'c:0:1': { level: 'err', lines: ['读取失败'] } } });
    for (const t of ['c:0', 'c:1', 'v:0:0', 'f:0']) {
        assert.match(html, new RegExp(`data-act="sb-pt-pick" data-sb-pt-target="${t}"`), t);
        assert.match(html, new RegExp(`data-sb-pt-drop="${t}"`), t);
    }
    const row = (ci, ii) => html.split(`data-sb-pt-row="${ci}.${ii}"`)[1].split('data-sb-pt-row=')[0];
    assert.match(row(0, 0), /data-kind="server"/);
    assert.match(row(0, 0), /data-act="sb-pt-convert" data-sb-pt-c="0" data-sb-pt-i="0" data-sb-to="embed"[^>]*>改成内嵌</);
    assert.match(row(1, 0), /data-act="sb-pt-convert" data-sb-pt-c="1" data-sb-pt-i="0" data-sb-to="server"[^>]*>存到酒馆</);
    assert.match(row(0, 1), /data-sb-pt-local="c:0:1"[^>]*>.*读取失败/, '转换失败的提示在那一行下面');
    assert.match(html, /data-sb-pt-local="c:1" role="status">.*已添加 1 张/);
    assert.match(html, /data-sb-pt-kinds>酒馆 1 · 内嵌 1（[\d.]+K）</);
    assert.match(html, /data-act="sb-pt-convert-list" data-sb-pt-target="v:0:0" data-sb-to="embed"/);
    assert.match(html, /data-act="sb-pt-convert-list" data-sb-pt-target="v:0:0" data-sb-to="server"/);
    assert.match(html, /data-act="sb-pt-convert-list" data-sb-pt-target="f:0" data-sb-to="embed"/, '兜底里有酒馆图片：可以改成内嵌');
    assert.ok(!/data-act="sb-pt-convert-list" data-sb-pt-target="f:0" data-sb-to="server"/.test(html));
    const ids = [...html.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]);
    assert.equal(new Set(ids).size, ids.length, ids.join(','));
    // 一个角色满 12 张时不能再选
    const full = portraitDraftFrom({ characters: { 甲: Array.from({ length: 12 }, (_, i) => `https://a.example.com/${i}.png`) } });
    assert.match(portraitsPanelHtml({ draft: full, spec, sb: { mode: 'auto' } }), /data-act="sb-pt-pick" data-sb-pt-target="c:0" disabled/);
});

// ---------------- 编译进文档与运行时 ----------------

test('带酒馆图片的状态栏文档：替换串往返、经过「自动修复 Markdown」与一层实体解码后原样到达；界面检查不报错；导出里就是原路径', () => {
    const c = card();
    const doc = compileStatusDocument(c);
    for (const u of [SRV_A, SRV_B, SRV_C]) assert.ok(doc.includes(`"${u}"`), u);
    const replace = buildStatusRegexReplace(doc);
    for (const prose of PROSES) {
        const shown = stIframeText(stFixMarkdown(`${prose}\n\n${replace}`, true));
        assert.equal(shown, doc, `正文：${prose}`);
        for (const code of scriptsOf(shown)) assert.doesNotThrow(() => new vm.Script(code));
    }
    const lint = lintStatusHtml(doc, { mode: 'raw' });
    assert.deepEqual(lint.errors, []);
    assert.deepEqual(lint.warnings.filter((w) => /外部图片/.test(w)), [], '立绘地址是配置，不算界面引用的外部资源');
    assert.deepEqual(lintStatusHtml(c.statusBar.html, { mode: 'bind', spec: c.statusBar.spec }), { errors: [], warnings: [] });
    // 运行时的源码仍然满足写进酒馆正则的约束
    const rt = buildNlRuntime();
    assert.ok(!/[*"`]|\{\{|\$\d|\$<|<\/script/i.test(rt), '运行时没有 * " ` {{ $1 $< </script');
});

test('NL 运行时：酒馆图片按原路径加载；预览给了 NL_PREVIEW_SRC 时换成 data:image（只认酒馆路径和位图），换一张记的仍是原路径；内嵌图片记短 id', () => {
    const c = card();
    const doc = compileStatusDocument(c);
    // 聊天里：直接加载原路径（同源，带登录信息）
    const storage = memoryStorage();
    const env = openStatusDocument(doc, { stat: STAT, storage });
    const imgs = () => env.document.querySelectorAll('article.card img.pt');
    assert.deepEqual(env.errors, []);
    assert.deepEqual(imgs().map((i) => i.getAttribute('src')), [SRV_B, SRV_C]);
    assert.equal(env.document.querySelector('.npc img.pt').getAttribute('src') !== null, true);
    // 预览：酒馆路径换成 data:image；svg、非酒馆路径的条目不认
    const pv = openStatusDocument(doc, {
        stat: STAT,
        storage: memoryStorage(),
        globals: { NL_PREVIEW_SRC: { [SRV_B]: PREVIEW_A, [SRV_C]: 'data:image/svg+xml;base64,PHN2Zz4=', [HTTP]: PREVIEW_A } },
    });
    const pimgs = () => pv.document.querySelectorAll('article.card img.pt');
    assert.deepEqual(pimgs().map((i) => i.getAttribute('src')), [PREVIEW_A, SRV_C]);
    // 换一张：莉莉丝 SRV_B → SRV_A（预览里也没有 data:image 时加载原路径），记的是原路径
    const ps = pv.window.localStorage;
    pv.document.click(pv.document.querySelectorAll('article.card')[0].querySelector('.swap'));
    assert.equal(pimgs()[0].getAttribute('src'), SRV_A);
    assert.equal(ps.map.get('nl-sb:card_local:莉莉丝'), SRV_A);
    // 江酒 SRV_C → 内嵌那张：记短 id，不记整个 data: 地址
    pv.document.click(pv.document.querySelectorAll('article.card')[1].querySelector('.swap'));
    assert.equal(pimgs()[1].getAttribute('src'), EMB);
    assert.equal(ps.map.get('nl-sb:card_local:江酒'), portraitChoiceId(EMB));
    assert.match(portraitChoiceId(EMB), /^nl#[0-9a-z]+\.[0-9a-z]+$/);
    assert.equal(portraitChoiceId(SRV_A), SRV_A);
    // 同一份记录在聊天里（没有 NL_PREVIEW_SRC）照样生效
    const chat = openStatusDocument(doc, { stat: STAT, storage: ps });
    assert.deepEqual(chat.document.querySelectorAll('article.card img.pt').map((i) => i.getAttribute('src')), [SRV_A, EMB]);
    // 旧版本记的完整 data: 地址也认；resolvePortrait 也认短 id
    const legacy = memoryStorage();
    legacy.map.set('nl-sb:card_local:江酒', EMB);
    assert.equal(openStatusDocument(doc, { stat: STAT, storage: legacy }).document.querySelectorAll('article.card img.pt')[1].getAttribute('src'), EMB);
    const p = normalizePortraits(PORTRAITS);
    assert.equal(resolvePortrait(p, '江酒', { record: '主要角色', stat: STAT, saved: portraitChoiceId(EMB) }).url, EMB);
    assert.equal(resolvePortrait(p, '江酒', { record: '主要角色', stat: STAT, saved: EMB }).url, EMB);
    // ctx.portrait 给的也是实际加载的地址
    const html = `${CAST_HTML}<i id="x"></i><script>window.nlRender = function (stat, ctx) { document.querySelector('[id]').setAttribute('data-u', ctx.portrait('莉莉丝', '主要角色').url); };</script>`;
    const withRender = openStatusDocument(compileStatusDocument(card({ html })), { stat: STAT, storage: memoryStorage(), globals: { NL_PREVIEW_SRC: { [SRV_B]: PREVIEW_A } } });
    assert.equal(withRender.document.querySelector('[id]').getAttribute('data-u'), PREVIEW_A);
});

test('nl-store 把关：接受原路径与内嵌图片的短 id；预览用的 data:image、别的 id 不接受', () => {
    const c = card();
    const pre = 'nl-sb:card_local:';
    const storage = memoryStorage();
    assert.equal(portraitChoiceProblem(c, `${pre}莉莉丝`, SRV_A, storage), '');
    assert.equal(portraitChoiceProblem(c, `${pre}江酒`, portraitChoiceId(EMB), storage), '');
    assert.equal(portraitChoiceProblem(c, `${pre}江酒`, EMB, storage), '', '旧版本的完整 data: 地址');
    assert.match(portraitChoiceProblem(c, `${pre}莉莉丝`, PREVIEW_A, storage), /不是这张卡配置的立绘地址/, '预览里换上的 data:image 不是配置的地址');
    assert.match(portraitChoiceProblem(c, `${pre}江酒`, portraitChoiceId(PREVIEW_A), storage), /不是这张卡配置的立绘地址/);
    assert.match(portraitChoiceProblem(c, `${pre}莉莉丝`, `${SRV_A}?x`, storage), /不是这张卡配置的立绘地址/);
    assert.equal(writePortraitChoice(c, `${pre}江酒`, portraitChoiceId(EMB), storage), true);
    assert.deepEqual(readPortraitChoices(c, storage), { [`${pre}江酒`]: portraitChoiceId(EMB) });
    assert.equal(writePortraitChoice(c, `${pre}江酒`, null, storage), true);
});

/** 预览页面 <head> 里模拟酒馆助手的那段脚本与 iframe 收到的文档 */
function previewParts(src) {
    const mocks = src.match(/<script>(\(function previewMocks[\s\S]*?)<\/script>\n<\/head>/);
    assert.ok(mocks);
    return { mocks: mocks[1], body: src.slice(src.indexOf('<body>\n') + '<body>\n'.length, src.lastIndexOf('\n</body>\n</html>')) };
}

test('buildPreviewSrcdoc 的 srcMap：只留这张卡配置的酒馆路径与合法的位图 data:image；预览里加载换过的图，记住的选择、文档里的配置、卡片和导出都还是原路径', () => {
    const c = card();
    const before = structuredClone(c.statusBar.portraits);
    const srcMap = { [SRV_B]: PREVIEW_A, [SRV_A]: 'data:image/svg+xml;base64,PHN2Zz4=', [`${FOLDER}/nl_unknown0000000.png`]: PREVIEW_A, [HTTP]: PREVIEW_A, [SRV_C]: 'not a data url' };
    const page = buildPreviewSrcdoc(c, STAT, { user: '我', char: '旁白', srcMap });
    const { mocks, body } = previewParts(page);
    const boot = JSON.parse(mocks.slice(mocks.lastIndexOf(')(') + 2, mocks.lastIndexOf(');')));
    assert.deepEqual(boot.src, { [SRV_B]: PREVIEW_A }, '其他条目都被过滤掉');
    assert.ok(body.includes(`"${SRV_B}"`), 'iframe 收到的文档里的配置仍是原路径');
    assert.equal(body.split(PREVIEW_A).length - 1, 0, '换上的 data:image 不进文档');
    assert.deepEqual(c.statusBar.portraits, before, '卡片不变');
    assert.ok(!compileStatusDocument(c).includes(PREVIEW_A), '导出不受影响');
    assert.ok(!buildStatusRegexReplace(compileStatusDocument(c)).includes(PREVIEW_A));
    assert.ok(!buildPreviewSrcdoc(c, STAT, {}).includes('"src":'), '没有 srcMap 时不带');
    assert.ok(!buildPreviewSrcdoc(card({ mode: 'raw', html: '<body>x</body>' }), STAT, { srcMap }).includes(PREVIEW_A), '自定义 HTML 不注入运行时，也不带');
    // 像沙箱 iframe 一样打开：NL_PREVIEW_SRC 只读，界面代码改不掉；换一张发给父页面的是原路径
    const posted = [];
    const env = openStatusDocument(body, {
        stat: STAT,
        storage: 'throw',
        prelude: [mocks, "try { window.NL_PREVIEW_SRC = {}; } catch (e) {} try { window.NL_PREVIEW_SRC['x'] = 1; } catch (e) {}"],
        globals: { parent: { postMessage: (m) => posted.push(JSON.parse(JSON.stringify(m))) }, addEventListener() {}, setTimeout: (fn) => fn() },
    });
    assert.deepEqual(env.errors, []);
    const imgs = () => env.document.querySelectorAll('article.card img.pt');
    assert.equal(imgs()[0].getAttribute('src'), PREVIEW_A, '莉莉丝默认那张（SRV_B）换成父页面取来的 data:image');
    env.document.click(env.document.querySelectorAll('article.card')[0].querySelector('.swap'));
    const store = posted.filter((m) => m.type === 'nl-store');
    assert.deepEqual(store.map((m) => [m.key, m.value]), [['nl-sb:card_local:莉莉丝', SRV_A]]);
    assert.equal(portraitChoiceProblem(c, store[0].key, store[0].value, memoryStorage(), { data: STAT }), '', '父页面照常接受');
});

// ---------------- 上传接口 ----------------

test('uploadImageToST：与酒馆的 saveBase64AsFile 同样的请求体与 CSRF 请求头；失败时给出中文原因（403 / 500 / 连不上）', async () => {
    const calls = [];
    const restore = { fetch: globalThis.fetch, st: globalThis.SillyTavern };
    globalThis.SillyTavern = { getContext: () => ({ getRequestHeaders: () => ({ 'Content-Type': 'application/json', 'X-CSRF-Token': 'tok' }) }) };
    let reply = () => new Response(JSON.stringify({ path: '/user/images/魔女旁白/nl_1.png' }), { status: 200 });
    globalThis.fetch = async (url, init) => {
        calls.push({ url, init });
        return reply();
    };
    try {
        const path = await uploadImageToST({ base64: 'AAAA', format: 'png', folder: '魔女旁白', filename: 'nl_1' });
        assert.equal(path, '/user/images/魔女旁白/nl_1.png');
        assert.equal(calls[0].url, '/api/images/upload');
        assert.equal(calls[0].init.method, 'POST');
        assert.equal(calls[0].init.headers['X-CSRF-Token'], 'tok');
        assert.deepEqual(JSON.parse(calls[0].init.body), { image: 'AAAA', format: 'png', ch_name: '魔女旁白', filename: 'nl_1' });
        await uploadImageToST({ base64: 'AAAA', format: 'webp' });
        assert.deepEqual(JSON.parse(calls[1].init.body), { image: 'AAAA', format: 'webp' }, '没有文件夹 / 文件名时不带');
        for (const [status, re] of [[403, /登录可能已过期/], [500, /酒馆保存图片失败（HTTP 500：Failed to save the image）/], [413, /太大/], [400, /不接受/]]) {
            reply = () => new Response(JSON.stringify({ error: 'Failed to save the image' }), { status });
            await assert.rejects(uploadImageToST({ base64: 'A', format: 'png' }), (e) => e instanceof ImageUploadError && e.status === status && re.test(e.message));
        }
        reply = () => {
            throw new TypeError('Failed to fetch');
        };
        await assert.rejects(uploadImageToST({ base64: 'A', format: 'png' }), (e) => e.status === 0 && /连不上酒馆服务器/.test(e.message));
        reply = () => new Response('{}', { status: 200 });
        await assert.rejects(uploadImageToST({ base64: 'A', format: 'png' }), /没有返回图片的保存路径/);
        delete globalThis.SillyTavern;
        await assert.rejects(uploadImageToST({ base64: 'A', format: 'png' }), /连不上酒馆服务器/, '取不到酒馆上下文');
        assert.match(uploadErrorText(404), /没有图片上传接口/);
    } finally {
        globalThis.fetch = restore.fetch;
        if (restore.st) globalThis.SillyTavern = restore.st;
        else delete globalThis.SillyTavern;
    }
});

// ---------------- 手填路径的规范化、预览只读自己上传的图 ----------------

test('normalizeServerPortraitInput：从图库抄来的路径（中文文件夹、空格、生成图扩展带 @ 的文件名、没有开头的 /）换成逐段编码的写法；已经规范的不变，不合法的原样留给校验报错', () => {
    const gen = '/user/images/Seraphina/Seraphina_2026-10-05@12h00m00s000ms.png';
    assert.notEqual(portraitUrlProblem(gen), '', '原样的 @ 不是规范写法');
    const n = normalizeServerPortraitInput(gen);
    assert.equal(n, '/user/images/Seraphina/Seraphina_2026-10-05%4012h00m00s000ms.png');
    assert.equal(portraitUrlProblem(n), '');
    assert.equal(decodeURIComponent(n), gen, '解码后就是酒馆上的文件');
    assert.equal(normalizeServerPortraitInput('/user/images/魔女/x.png'), `/user/images/${enc('魔女')}/x.png`);
    assert.equal(normalizeServerPortraitInput('user/images/a b/x.png'), '/user/images/a%20b/x.png');
    assert.equal(normalizeServerPortraitInput("/user/images/Bob's (1)/x.png"), '/user/images/Bob%27s%20%281%29/x.png');
    assert.equal(normalizeServerPortraitInput(`  ${SRV_A}  `), SRV_A, '已经规范的不变（只去掉首尾空白）');
    assert.equal(normalizeServerPortraitInput(n), n, '编码过的不会再编码一次');
    assert.equal(normalizeServerPortraitInput('/user/images/a%2db/x.png'), '/user/images/a-b/x.png');
    for (const keep of [
        '/user/images/a%2Fb.png', '/user/images/a%5Cb.png', '/user/images/%252F/x.png', '/user/images/../x.png', '/user/images/%2E%2E/x.png', '/user/images/a/x.png?x=1',
        '/user/images/a/x.png#f', '/user/images/a%/x.png', '/user/images/a/x.svg', '/user/images/', '/user/images/a//b.png', '/USER/images/a/x.png',
        HTTP, EMB, '/user/files/x.png', 'javascript:alert(1)',
    ]) {
        assert.equal(normalizeServerPortraitInput(keep), keep, keep.slice(0, 40));
        if (keep.startsWith('/user/images/')) assert.notEqual(portraitUrlProblem(normalizeServerPortraitInput(keep)), '', `${keep} 仍然不通过`);
    }
    assert.equal(normalizeServerPortraitInput(null), '');
});

test('isOwnServerImage / 预览替换：只替 NovelLoom 上传的 nl_<哈希> 文件去读，图库里别的文件（手填的、生成图扩展的）不交给沙箱', async () => {
    assert.equal(isOwnServerImage(SRV_A), true);
    assert.equal(isOwnServerImage(`${FOLDER}/nl_0123456789ABCDEF.WEBP`), true, '大小写不限');
    for (const no of [
        '/user/images/Alice/smile.png', '/user/images/Alice/Alice_2024-10-05%4012h30m45s123ms.png', `${FOLDER}/nl_0123.png`, `${FOLDER}/nl_0123456789abcdef0.png`,
        `${FOLDER}/xnl_0123456789abcdef.png`, `${FOLDER}/nl_0123456789abcdef.svg`, 'https://x.example.com/user/images/a/nl_0123456789abcdef.png',
        `${FOLDER}/nl_0123456789abcdef.png?x`, '/user/images/nl_0123456789abcdef.png/../x.png', EMB, null,
    ]) {
        assert.equal(isOwnServerImage(no), false, String(no));
    }
    // buildPreviewSrcdoc：卡片里配置了也不行（导入的模板 / 卡片可以列出别的角色图库里的文件）
    const A = '/user/images/Alice/smile.png';
    const B = '/user/images/Alice/Alice_2024-10-05%4012h30m45s123ms.png';
    const c = card({ portraits: { characters: { 莉莉丝: [{ url: A }, { url: SRV_B }], 江酒: [{ url: B }] }, pools: [] } });
    const page = buildPreviewSrcdoc(c, STAT, { srcMap: { [A]: PREVIEW_A, [B]: PREVIEW_A, [SRV_B]: PREVIEW_A } });
    const { mocks } = previewParts(page);
    const boot = JSON.parse(mocks.slice(mocks.lastIndexOf(')(') + 2, mocks.lastIndexOf(');')));
    assert.deepEqual(boot.src, { [SRV_B]: PREVIEW_A });
    // previewSrcMap：父页面只去读自己上传的那张
    const calls = [];
    const restore = globalThis.fetch;
    globalThis.fetch = async (u) => {
        calls.push(String(u));
        return new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), { status: 200, headers: { 'Content-Type': 'image/png' } });
    };
    try {
        await previewSrcMap([A, B, SRV_C, HTTP, SRV_C, EMB]);
        assert.deepEqual(calls, [SRV_C]);
    } finally {
        globalThis.fetch = restore;
    }
});

test('「立绘」分页：「全部改成内嵌」在分享提示里、存法只管之后选的图、图池缩略图逐行删除、按钮的读屏名字含可见文字、满了说明为什么不能选', () => {
    const p = { characters: { 甲: [{ url: SRV_A }, { url: SRV_B }] }, pools: [{ record: 'NPC', field: '阵营', pools: { 敌对: [SRV_A] }, fallback: [] }] };
    const bar = portraitStoreBarHtml({ store: 'embed', portraits: p, local: { level: 'ok', lines: ['已转换 2 张（嵌进卡片）'] } });
    assert.match(bar, /这里只决定之后「选择本地图片」存到哪儿，已经加进来的图片不会变/);
    assert.match(bar, /data-sb-pt-share-hint>.*点「全部改成内嵌」.*<button class="nl-btn nl-sm" data-act="sb-pt-convert-all"[^>]*>.*全部改成内嵌（2 张）<\/button><\/div>/s);
    assert.match(bar, /data-sb-pt-local="all" role="status"><span[^>]*>.*<\/span><div class="nl-grow"><div>已转换 2 张（嵌进卡片）<\/div>/);
    assert.match(bar, /GIF 动图因此只留第一帧/);
    const noServer = portraitStoreBarHtml({ portraits: { characters: { 甲: [{ url: EMB }] } } });
    assert.ok(!noServer.includes('sb-pt-convert-all'), '没有酒馆图片时没有这个按钮');
    assert.match(noServer, /<div class="nl-sb-pt-local" data-sb-pt-local="all" role="status"><\/div>/, '结果提示的位置一直在（就地更新用）');
    assert.match(portraitKindBadgeHtml(dataUrl(38912)), /title="嵌在卡片里（38K 字）：随卡分享，占卡片大小">内嵌 38K</);

    // 图池缩略图：每张对应文本框里的一行（空行不算），带存放位置和删除；地址转义
    const text = `${SRV_A}\n\n  ${EMB}  \nhttps://x.example.com/"<b>.png`;
    const th = poolThumbsHtml('v:0:1', text, { name: '敌', who: '取值「敌对」' });
    const chips = th.split('data-sb-pool-thumb=').slice(1);
    assert.deepEqual(chips.map((x) => x.slice(1, 2)), ['1', '3', '4'], '行号');
    assert.match(chips[0], /data-kind="server"/);
    assert.match(chips[1], /data-kind="embed"/);
    assert.ok(!chips[2].includes('data-kind'), '不合法的地址没有存放位置标签，但可以删');
    assert.ok(chips[1].includes(`data-act="sb-pool-img-del" data-sb-pt-target="v:0:1" data-sb-line="3" data-sb-line-id="${poolLineId(EMB)}"`));
    assert.match(chips[1], /aria-label="取值「敌对」：删除第 3 行的图片"/);
    assert.ok(!th.includes('<b>'), '地址转义');
    assert.equal(poolLineId(`  ${EMB} `), poolLineId(EMB));
    assert.notEqual(poolLineId(SRV_A), poolLineId(SRV_B));
    assert.equal(poolThumbsHtml('f:0', ''), '<div class="nl-sb-thumbs"></div>');

    // 面板里：图池的文本框不折行、缩略图带删除；角色 / 取值 / 兜底的「选择本地图片」各有自己的读屏名字
    const spec = normalizeStatusSpec(SPEC, { maxVars: 30 });
    const norm = normalizePortraits(PORTRAITS, { spec });
    const d = portraitDraftFrom(norm);
    d.pools[0].values = [{ value: '敌对', urls: `${SRV_B}\n${EMB}` }];
    const html = portraitsPanelHtml({ draft: d, spec, portraits: norm, sb: { mode: 'auto' } });
    assert.match(html, /<textarea class="nl-input nl-textarea nl-mono nl-sb-pool-ta" rows="2" wrap="off" data-sb-pool="urls" data-sb-pool-p="0" data-sb-pool-v="0"/);
    assert.match(html, /data-act="sb-pool-img-del" data-sb-pt-target="v:0:0" data-sb-line="2"/);
    assert.match(html, /data-act="sb-pool-img-del" data-sb-pt-target="f:0" data-sb-line="1"/);
    assert.match(html, /data-act="sb-pt-pick" data-sb-pt-target="c:0" title="从电脑里选图片[^"]*" aria-label="「莉莉丝」：选择本地图片"/);
    assert.match(html, /data-act="sb-pt-pick" data-sb-pt-target="v:0:0" [^>]*aria-label="取值「敌对」：选择本地图片"/);
    assert.match(html, /data-act="sb-pt-pick" data-sb-pt-target="f:0" [^>]*aria-label="「NPC · 阵营」的兜底：选择本地图片"/);
    const row = (ci, ii) => html.split(`data-sb-pt-row="${ci}.${ii}"`)[1].split('data-sb-pt-row=')[0];
    assert.match(row(0, 0), /aria-label="第 1 张：改成内嵌（嵌进卡片）">改成内嵌<\/button>/, '读屏名字里有可见的文字');
    assert.match(row(1, 0), /aria-label="第 1 张：存到酒馆（上传到酒馆服务器）">存到酒馆<\/button>/);
    // 满了：按钮禁用，title 说明为什么（不再是「从电脑里选图片」）
    const full = portraitDraftFrom({ characters: { 甲: Array.from({ length: 12 }, (_, i) => `https://a.example.com/${i}.png`) } });
    assert.match(portraitsPanelHtml({ draft: full, spec, sb: { mode: 'auto' } }), /data-sb-pt-target="c:0" disabled title="每个角色最多 12 张" aria-label="「甲」：选择本地图片"/);
    const fullPool = portraitDraftFrom({ characters: {}, pools: [{ record: 'NPC', field: '阵营', pools: { 敌对: Array.from({ length: 12 }, (_, i) => `https://a.example.com/${i}.png`) }, fallback: Array.from({ length: 12 }, (_, i) => `https://b.example.com/${i}.png`) }] });
    const fp = portraitsPanelHtml({ draft: fullPool, spec, sb: { mode: 'auto' } });
    assert.match(fp, /data-sb-pt-target="v:0:0" disabled title="每个取值最多 12 张"/);
    assert.match(fp, /data-sb-pt-target="f:0" disabled title="兜底最多 12 张"/);
});
