// 核心模块单元测试：node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';

import { detectChapters, buildChunks, splitNovel, findBreak } from '../src/splitter.js';
import { extractJson, removeTags, extractTagContents, repairJson } from '../src/json.js';
import { decodeText, normalizeNovelText } from '../src/encoding.js';
import { chineseNumToInt, naturalCompare, estimateTokens, normalizeForMatch, Semaphore, mergeDefaults } from '../src/utils.js';
import {
    createProject, normalizeExtraction, applyExtraction, mergeCharacter, characterAt, verifyQuote,
    buildKnownContext, deleteChunkAt, mergeChunkWithNext, mergeCharactersInto, renameCharacter, normalizeProject,
    scanCensorArtifacts,
} from '../src/project.js';
import { removeChunkContributions } from '../src/extract.js';
import { buildWorldbookEntries, toSTWorld, toCharacterBook, parseExternalWorld } from '../src/worldbook.js';
import { lintText, lintCard } from '../src/lint.js';
import { render, buildExtractionTemplate, DEFAULT_PROMPTS } from '../src/prompts.js';
import { buildCardJson, embedCardInPng } from '../src/cards.js';
import { DEFAULT_CATEGORIES, DEFAULT_SETTINGS } from '../src/constants.js';
import { findReplace } from '../src/tools.js';

const NOVEL = `作品相关：本书简介
这是一本关于魔女的书，讲述江酒与莉莉丝的故事，作者在此感谢大家的支持，也感谢编辑老师一直以来的帮助与鼓励。
第一章 魔女小姐
江酒走进酒吧。莉莉丝坐在角落。
“没错，今晚我是来跟你提分手的。”江酒说。
莉莉丝笑了：“你不该叫我莉莉丝的，你应该叫我什么？”
第二章 天下无敌
江酒穿上了女仆装。莉莉丝离开去参加魔女茶会。
第三章 下城区
姜小白在雨中迷路，走进了下城区的酒吧。
`;

function settings() {
    const s = mergeDefaults({}, DEFAULT_SETTINGS);
    s.categories = structuredClone(DEFAULT_CATEGORIES);
    return s;
}

// ---------------- splitter ----------------

test('detectChapters 识别中文章节与序言', () => {
    const ch = detectChapters(NOVEL, '^\\s*第[零〇一二两三四五六七八九十百千万0-9]+[章回卷节部篇][^\\n]{0,40}$');
    assert.equal(ch.length, 4);
    assert.equal(ch[0].title, '序');
    assert.equal(ch[1].title, '第一章 魔女小姐');
    assert.ok(ch[3].content.includes('姜小白'));
    assert.equal(ch.map((c) => c.content).join(''), NOVEL);
    // 短序言并入第一章、目录行并入前一章，不丢字
    const toc = `书名\n第一章 甲\n第二章 乙\n第一章 甲\n正文正文正文\n第二章 乙\n正文二正文二\n`;
    const c2 = detectChapters(toc, '^第.+章.*$');
    assert.equal(c2.map((c) => c.content).join(''), toc);
    assert.equal(c2.length, 2);
});

test('buildChunks 按字数打包并切分超长章节', () => {
    const long = `第一章 长\n${'啊。'.repeat(3000)}\n第二章 短\n短内容短内容短内容短内容短内容\n`;
    const { chunks } = splitNovel(long, { pattern: '^第.+章.*$', chunkSize: 2000, mergeSmall: false });
    assert.ok(chunks.length >= 3);
    assert.ok(chunks.every((c) => c.content.length <= 2000 + 1));
    assert.ok(chunks[0].title.includes('（1/'));
    assert.equal(chunks.map((c) => c.content).join(''), long);
    chunks.forEach((c, i) => assert.equal(c.index, i));
});

test('buildChunks 合并小末段', () => {
    const chapters = [
        { title: 'A', content: 'x'.repeat(1800), start: 0, end: 1800 },
        { title: 'B', content: 'y'.repeat(100), start: 1800, end: 1900 },
    ];
    const chunks = buildChunks(chapters, 1000, true);
    // A 被拆成两块，最后一块很小会并入
    assert.equal(chunks.map((c) => c.content).join(''), 'x'.repeat(1800) + 'y'.repeat(100));
});

test('findBreak 优先段落，其次句末', () => {
    const t = `${'甲'.repeat(60)}\n${'乙'.repeat(60)}`;
    assert.equal(findBreak(t, 100), 61);
    const t2 = `${'甲'.repeat(70)}。${'乙'.repeat(60)}`;
    assert.equal(findBreak(t2, 100), 71);
});

// ---------------- json ----------------

test('extractJson 处理代码块、尾逗号、未转义引号、截断', () => {
    assert.deepEqual(extractJson('```json\n{"a": 1,}\n```'), { a: 1 });
    assert.deepEqual(extractJson('好的，结果如下：{"a": [1, 2,], "b": "x"} 以上'), { a: [1, 2], b: 'x' });
    assert.equal(extractJson('{"t": "他说"你好"然后走了"}').t, '他说"你好"然后走了');
    assert.deepEqual(extractJson('{"list": [{"n": "a"}, {"n": "b"'), { list: [{ n: 'a' }, { n: 'b' }] });
    assert.equal(extractJson('{"t": "第一行\n第二行"}').t, '第一行\n第二行');
    assert.throws(() => extractJson('完全没有 JSON'), /无法/);
});

test('repairJson 不破坏合法 JSON', () => {
    const ok = '{"a": "b, c", "d": [1, {"e": "f"}]}';
    assert.deepEqual(JSON.parse(repairJson(ok)), JSON.parse(ok));
});

test('removeTags 移除思考标签（含孤立闭合与未闭合）', () => {
    assert.equal(removeTags('<thinking>xx</thinking>{"a":1}', 'thinking'), '{"a":1}');
    assert.equal(removeTags('思考过程……</think>\n正文', 'think'), '正文');
    assert.equal(removeTags('正文<think>没写完', 'think'), '正文');
    assert.equal(extractTagContents('<content>A</content>x<content>B</content>', 'content', '|'), 'A|B');
});

// ---------------- encoding ----------------

test('decodeText 识别 UTF-8 / BOM / GBK', () => {
    const utf8 = new TextEncoder().encode('你好世界，第一章');
    assert.equal(decodeText(utf8.buffer).encoding, 'UTF-8');
    const bom = new Uint8Array([0xef, 0xbb, 0xbf, ...utf8]);
    const r = decodeText(bom.buffer);
    assert.equal(r.text, '你好世界，第一章');
    // "你好的一是了" GBK
    const gbk = new Uint8Array([0xc4, 0xe3, 0xba, 0xc3, 0xb5, 0xc4, 0xd2, 0xbb, 0xca, 0xc7, 0xc1, 0xcb]);
    const g = decodeText(gbk.buffer);
    assert.equal(g.text, '你好的一是了');
    assert.match(g.encoding, /GB/);
    assert.equal(normalizeNovelText('a\r\nb  \n\n\n\n\nc'), 'a\nb\n\n\nc');
});

// ---------------- utils ----------------

test('中文数字与自然排序', () => {
    assert.equal(chineseNumToInt('一百二十三'), 123);
    assert.equal(chineseNumToInt('十'), 10);
    assert.equal(chineseNumToInt('两千零五'), 2005);
    assert.equal(chineseNumToInt('１２'), 12);
    assert.ok(naturalCompare('第二章', '第十章') < 0);
    assert.ok(estimateTokens('你好abc') >= 2);
    assert.equal(normalizeForMatch('“你 好”'), '"你好"');
});

test('Semaphore 限制并发', async () => {
    const sem = new Semaphore(2);
    let active = 0;
    let peak = 0;
    await Promise.all(Array.from({ length: 6 }, () => sem.run(async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 5));
        active--;
    })));
    assert.equal(peak, 2);
});

// ---------------- project ----------------

function makeProject() {
    // 每章一块，便于断言分块序号：0=序 1=第一章 2=第二章 3=第三章
    const chapters = detectChapters(NOVEL, '^第.+章.*$');
    const chunks = chapters.map((ch) => buildChunks([ch], 1000, false)[0]);
    chunks.forEach((c, i) => (c.index = i));
    return createProject({ name: '魔女', text: NOVEL, chunks });
}

test('normalizeExtraction 兼容中文键与多种结构', () => {
    const r = normalizeExtraction({
        章节: [{ 章节: '第一章', 概要: '江酒提分手' }],
        角色: [{ 姓名: '江酒', 别名: '小江、酒酒', 身份: '渣男', importance: '主角', 台词: ['没错'] }],
        entries: { 地点: { 下城区: { 关键词: ['下城'], 内容: '混乱地带' } }, 角色: [{ name: '莉莉丝', identity: '大魔女' }] },
        style_hints: { perspective: '第三人称' },
    }, ['地点']);
    assert.equal(r.chapters[0].notes, '江酒提分手');
    assert.equal(r.characters.length, 2);
    assert.deepEqual(r.characters[0].aliases, ['小江', '酒酒']);
    assert.equal(r.characters[0].importance, 'main');
    assert.equal(r.characters[0].quotes[0].text, '没错');
    assert.equal(r.entries['地点'][0].name, '下城区');
    assert.equal(r.style.perspective, '第三人称');
});

test('applyExtraction 合并角色、条目、引用校验与阶段记录', () => {
    const p = makeProject();
    const c0 = p.chunks[1];
    const res = normalizeExtraction({
        chapters: [{ name: '第一章 魔女小姐', notes: '江酒来酒吧提分手' }],
        characters: [
            { name: '江酒', identity: '渣男', personality: '脸皮厚', quotes: [{ text: '没错，今晚我是来跟你提分手的。' }, { text: '这句原文里没有' }], importance: 'main' },
            { name: '莉莉丝', identity: '大魔女' },
        ],
        entries: { 地点: [{ name: '酒吧', keywords: ['酒吧'], content: '莉莉丝的酒吧' }] },
        important: [{ chapter: '第一章', reason: '分手', quotes: [{ text: '你不该叫我莉莉丝的' }] }],
    });
    const sum = applyExtraction(p, c0, res, { verifyQuotes: true });
    assert.deepEqual(sum.newCharacters.sort(), ['江酒', '莉莉丝'].sort());
    assert.equal(p.characters['江酒'].quotes.length, 1, '未通过校验的引用应被丢弃');
    assert.equal(p.chunks[1].important[0].quotes[0].verified, true);
    assert.equal(p.worldbook['地点']['酒吧'].content, '莉莉丝的酒吧');

    // 后续段：别名命中、身份变化、追加条目内容
    const c1 = p.chunks[2];
    applyExtraction(p, c1, normalizeExtraction({
        characters: [{ name: '酒酒', aliases: ['江酒'], identity: '魔女女仆', appearance: ['女仆装'] }],
        entries: { 地点: [{ name: '酒吧', content: '位于下城区' }] },
    }));
    const j = p.characters['江酒'];
    assert.equal(j.identity, '魔女女仆');
    assert.ok(j.aliases.includes('酒酒'));
    assert.deepEqual(j.appearance, ['女仆装']);
    assert.equal(j.stages.length, 2); // 第1段一条（身份+性格），第2段一条（身份变化）
    assert.ok(p.worldbook['地点']['酒吧'].content.includes('位于下城区'));

    // 时间点视图
    const early = characterAt(j, 1);
    assert.equal(early.identity, '渣男');
    assert.equal(characterAt(j, 2).identity, '魔女女仆');
});

test('replace 模式下用 AI 输出替换条目内容', () => {
    const p = makeProject();
    applyExtraction(p, p.chunks[1], normalizeExtraction({ entries: { 地点: [{ name: '酒吧', content: '旧内容' }] } }));
    applyExtraction(p, p.chunks[2], normalizeExtraction({ entries: { 地点: [{ name: '酒吧', content: '融合后的新内容' }] } }), { fullContext: new Set(['地点:酒吧']) });
    assert.equal(p.worldbook['地点']['酒吧'].content, '融合后的新内容');
});

test('buildKnownContext 只给本段提到的实体完整档案', () => {
    const p = makeProject();
    mergeCharacter(p, { name: '江酒', aliases: [], identity: '渣男', experiences: [], quotes: [], appearance: [], abilities: [], importance: 'main' }, 1);
    mergeCharacter(p, { name: '姜小白', aliases: [], identity: '邻居', experiences: [], quotes: [], appearance: [], abilities: [], importance: 'minor' }, 3);
    const k = buildKnownContext(p, '江酒走进酒吧', 5000);
    assert.ok(k.full.has('char:江酒'));
    assert.ok(!k.full.has('char:姜小白'));
    assert.ok(k.text.includes('已知角色：姜小白'));
});

test('verifyQuote 忽略空白与引号差异', () => {
    assert.ok(verifyQuote('你不该叫我莉莉丝的，你应该叫我什么？', NOVEL));
    assert.ok(verifyQuote('“没错，今晚我是来跟你提分手的。”', NOVEL));
    assert.ok(!verifyQuote('完全不存在的句子', NOVEL));
});

test('删除/合并分块时重映射引用', () => {
    const p = makeProject();
    const n = p.chunks.length;
    mergeCharacter(p, { name: 'A', aliases: [], experiences: ['e1'], quotes: [], appearance: [], abilities: [], importance: 'minor' }, 1);
    mergeCharacter(p, { name: 'A', aliases: [], experiences: ['e3'], quotes: [], appearance: [], abilities: [], importance: 'minor' }, 3);
    mergeCharacter(p, { name: 'B', aliases: [], experiences: ['only2'], quotes: [], appearance: [], abilities: [], importance: 'minor' }, 2);
    deleteChunkAt(p, 2);
    assert.equal(p.chunks.length, n - 1);
    assert.ok(!p.characters.B, '只出现在被删分块的角色应被删除');
    assert.deepEqual(p.characters.A.chunksSeen, [1, 2]);
    assert.deepEqual(p.characters.A.experiences.map((e) => e.chunk), [1, 2]);
    mergeChunkWithNext(p, 1);
    assert.deepEqual(p.characters.A.chunksSeen, [1]);
    p.chunks.forEach((c, i) => assert.equal(c.index, i));
});

test('scanCensorArtifacts 扫描注音符号并去重', () => {
    const p = makeProject();
    const c1 = p.chunks[1];
    const res1 = normalizeExtraction({
        chapters: [{ name: '第一章', notes: '捡到了无法行动的可怜ㄒㄧㄠˇ丧尸' }],
        characters: [{ name: '江酒', identity: '渣ㄋㄢˊ', appearance: ['正常描述'], quotes: [{ text: '正常台词' }] }],
        entries: { 地点: [{ name: '酒吧', keywords: ['正常关键词'], content: '正常内容' }] },
    });
    const added1 = scanCensorArtifacts(p, c1, res1);
    assert.equal(added1, 2, '章节概要与角色身份各命中一次');
    assert.equal(p.censorFlags.length, 2);
    assert.ok(p.censorFlags.some((f) => f.field.includes('章节概要') && f.text.includes('ㄒㄧㄠˇ')));
    assert.ok(p.censorFlags.some((f) => f.field.includes('江酒') && f.field.includes('identity')));
    assert.equal(p.censorFlags[0].chunk, c1.index);

    // 重复调用同一段、同样命中：不应重复添加
    const added2 = scanCensorArtifacts(p, c1, res1);
    assert.equal(added2, 0, '相同 chunk+field+text 不应重复记录');
    assert.equal(p.censorFlags.length, 2);

    // 干净文本：不产生命中
    const clean = normalizeExtraction({ chapters: [{ name: '第二章', notes: '一切正常，没有任何问题。' }] });
    const added3 = scanCensorArtifacts(p, p.chunks[2], clean);
    assert.equal(added3, 0);
    assert.equal(p.censorFlags.length, 2);
});

test('censorFlags 随分块删除/合并正确重映射或清除，removeChunkContributions 按段清空', () => {
    const p = makeProject();
    const c1 = p.chunks[1];
    const c2 = p.chunks[2];
    const c3 = p.chunks[3];
    scanCensorArtifacts(p, c1, normalizeExtraction({ chapters: [{ name: 'x', notes: 'ㄒㄧㄠˇ' }] }));
    scanCensorArtifacts(p, c2, normalizeExtraction({ chapters: [{ name: 'y', notes: 'ㄋㄢˊ' }] }));
    scanCensorArtifacts(p, c3, normalizeExtraction({ chapters: [{ name: 'z', notes: 'ㄍㄨㄞ' }] }));
    assert.equal(p.censorFlags.length, 3);

    // 只出现在被删分块（2）的记录应被清除，其余重映射
    deleteChunkAt(p, 2);
    assert.equal(p.censorFlags.length, 2);
    assert.ok(!p.censorFlags.some((f) => f.text === 'ㄋㄢˊ'));
    assert.deepEqual(p.censorFlags.map((f) => f.chunk).sort(), [1, 2]);

    // removeChunkContributions 按段清空该段自己的记录
    removeChunkContributions(p, 1);
    assert.equal(p.censorFlags.length, 1);
    assert.ok(!p.censorFlags.some((f) => f.chunk === 1));
});

test('合并与重命名角色', () => {
    const p = makeProject();
    for (const [name, i] of [['江酒', 1], ['小江', 2]]) mergeCharacter(p, { name, aliases: [], experiences: [`${name}经历`], quotes: [], appearance: [], abilities: [], importance: 'minor' }, i);
    mergeCharactersInto(p, '江酒', ['小江']);
    assert.ok(!p.characters['小江']);
    assert.ok(p.characters['江酒'].aliases.includes('小江'));
    assert.equal(p.characters['江酒'].experiences.length, 2);
    renameCharacter(p, '江酒', '江大酒');
    assert.ok(p.characters['江大酒'].aliases.includes('江酒'));
    const again = normalizeProject(JSON.parse(JSON.stringify(p)));
    assert.equal(again.characters['江大酒'].name, '江大酒');
});

// ---------------- worldbook ----------------

test('世界书构建、ST 格式与 character_book、反向解析', () => {
    const p = makeProject();
    applyExtraction(p, p.chunks[1], normalizeExtraction({
        characters: [{ name: '江酒', identity: '渣男' }, { name: '莉莉丝', identity: '大魔女' }],
        entries: { 世界观: [{ name: '魔女学派', content: '塑能、变化' }], 地点: [{ name: '酒吧', content: '下城区' }] },
    }));
    const s = settings();
    s.worldbook.includeOutlineEntry = false;
    s.defaultEntries = [{ name: '扮演准则', content: '不替用户说话', constant: true }];
    const entries = buildWorldbookEntries(p, s, { excludeCharacters: ['江酒'] });
    const names = entries.map((e) => e.name);
    assert.ok(!names.includes('江酒'));
    assert.ok(names.includes('莉莉丝') && names.includes('魔女学派') && names.includes('酒吧') && names.includes('扮演准则'));
    const wb = entries.find((e) => e.name === '魔女学派');
    assert.equal(wb.constant, true);
    const st = toSTWorld(entries);
    assert.equal(Object.keys(st.entries).length, entries.length);
    assert.equal(st.entries[0].uid, 0);
    assert.ok(Array.isArray(st.entries[0].key));
    const book = toCharacterBook(entries, 'test');
    assert.equal(book.entries.length, entries.length);
    const back = parseExternalWorld(st);
    assert.equal(back.length, entries.length);
    assert.equal(back.find((e) => e.name === '酒吧').category, '地点');
    const back2 = parseExternalWorld({ data: { character_book: book } });
    assert.equal(back2.length, entries.length);
});

test('时间点过滤世界书（防剧透）', () => {
    const p = makeProject();
    applyExtraction(p, p.chunks[1], normalizeExtraction({ characters: [{ name: '江酒' }], entries: { 地点: [{ name: '酒吧', content: 'x' }] } }));
    applyExtraction(p, p.chunks[3], normalizeExtraction({ characters: [{ name: '姜小白' }], entries: { 地点: [{ name: '下城区', content: 'y' }] } }));
    const s = settings();
    s.worldbook.includeOutlineEntry = false;
    const names = buildWorldbookEntries(p, s, { uptoChunk: 1 }).map((e) => e.name);
    assert.ok(names.includes('江酒') && names.includes('酒吧'));
    assert.ok(!names.includes('姜小白') && !names.includes('下城区'));
});

// ---------------- lint ----------------

test('lint 识别禁词且不误报 markdown 分隔线', () => {
    const issues = lintText('她嘴角微微上扬——仿佛什么都知道。某城市的夜很长。');
    const types = issues.map((i) => i.type);
    assert.ok(types.includes('八股微表情'));
    assert.ok(types.includes('破折号'));
    assert.ok(types.includes('模糊词'));
    assert.ok(types.includes('占位符'));
    assert.equal(lintText('---\n正常文本，她笑了。').length, 0);
    const cardIssues = lintCard({ description: '她非常温柔', alternate_greetings: ['似乎下雨了'] });
    assert.equal(cardIssues.length, 2);
    assert.equal(cardIssues[1].fieldLabel, '备选开场白 1');
});

// ---------------- prompts ----------------

test('render 不影响 ST 宏，模板可解析', () => {
    const out = render('{BOOK} 与 {{user}} {{char}} {UNKNOWN}', { BOOK: '魔女' });
    assert.equal(out, '魔女 与 {{user}} {{char}} {UNKNOWN}');
    const tpl = JSON.parse(buildExtractionTemplate(DEFAULT_CATEGORIES));
    assert.ok(tpl.entries['世界观']);
    assert.ok(!tpl.entries['角色']);
    assert.ok(!tpl.entries['事件'], '默认未启用的分类不应出现');
    assert.ok(DEFAULT_PROMPTS.card.includes('{{user}}'));
});

// ---------------- cards ----------------

function pngChunks(bytes) {
    const out = [];
    let pos = 8;
    const dec = new TextDecoder();
    while (pos < bytes.length) {
        const len = new DataView(bytes.buffer, bytes.byteOffset + pos).getUint32(0);
        const type = dec.decode(bytes.slice(pos + 4, pos + 8));
        const data = bytes.slice(pos + 8, pos + 8 + len);
        out.push({ type, data });
        pos += 12 + len;
    }
    return out;
}

// 1x1 透明 PNG
const TINY_PNG = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64'));

test('角色卡 JSON 与 PNG 内嵌', () => {
    const card = { kind: 'character', timepoint: null, data: { name: '莉莉丝', description: 'd', personality: 'p', scenario: 's', first_mes: 'hi', alternate_greetings: ['a2'], mes_example: '<START>', system_prompt: '', post_history_instructions: '', creator_notes: 'n', tags: ['魔女'] } };
    const json = buildCardJson(card, { worldName: '《魔女》世界书', characterBook: toCharacterBook([], 'x'), creator: 'me' });
    assert.equal(json.spec, 'chara_card_v3');
    assert.equal(json.data.extensions.world, '《魔女》世界书');
    assert.equal(json.data.alternate_greetings[0], 'a2');
    assert.ok(json.data.character_book);
    const png = embedCardInPng(TINY_PNG, json);
    const chunks = pngChunks(png);
    assert.equal(chunks[chunks.length - 1].type, 'IEND');
    const texts = chunks.filter((c) => c.type === 'tEXt').map((c) => {
        const z = c.data.indexOf(0);
        return { key: new TextDecoder().decode(c.data.slice(0, z)), val: new TextDecoder().decode(c.data.slice(z + 1)) };
    });
    const ccv3 = texts.find((t) => t.key === 'ccv3');
    const decoded = JSON.parse(Buffer.from(ccv3.val, 'base64').toString('utf8'));
    assert.equal(decoded.data.name, '莉莉丝');
    assert.ok(texts.find((t) => t.key === 'chara'));
    // 再次嵌入应替换而非叠加
    const png2 = embedCardInPng(png, json);
    assert.equal(pngChunks(png2).filter((c) => c.type === 'tEXt').length, 2);
});

// ---------------- tools ----------------

test('findReplace 支持普通与正则替换', () => {
    const p = makeProject();
    applyExtraction(p, p.chunks[1], normalizeExtraction({ characters: [{ name: '江酒', identity: '某城市的渣男' }], entries: { 地点: [{ name: '酒吧', content: '某城市的酒吧，某城市' }] } }));
    assert.equal(findReplace(p, { find: '某城市', replace: '新海市' }), 3);
    assert.equal(p.characters['江酒'].identity, '新海市的渣男');
    assert.equal(findReplace(p, { find: '新(海)市', replace: '旧$1市', regex: true }), 3);
    assert.equal(p.worldbook['地点']['酒吧'].content, '旧海市的酒吧，旧海市');
});
