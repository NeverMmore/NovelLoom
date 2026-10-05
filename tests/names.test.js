// 待确认名称 · AI 推断名称：原文片段收集、候选资料、提示词、宽松解析与核对、写回（不覆盖手动值）、分批与单批失败、设置
import test from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_NAME_RESOLVE, DEFAULT_SETTINGS } from '../src/constants.js';
import { applyConfig } from '../src/io.js';
import { CHAIN_TASKS, getChain } from '../src/llm.js';
import {
    applyResolveResults,
    buildNameCandidates,
    buildResolveNamesPrompt,
    existingNameMap,
    fillTopCandidates,
    gatherNameContext,
    missingNameMarkdown,
    nameResolveOptions,
    namesToResolve,
    normalizeNameResolve,
    parseResolveNamesResult,
    pickCandidate,
    prepareNameItems,
    resolveMissingNames,
    resolvedByOf,
    riskyResolved,
    sanitizeCandidateName,
    selectedCandidateIndex,
    typeResolved,
} from '../src/names.js';
import { createProject, normalizeCharacter, normalizeProject } from '../src/project.js';
import { DEFAULT_PROMPTS, PROMPT_LABELS, PROMPT_PLACEHOLDERS } from '../src/prompts.js';
import { getSettings } from '../src/store.js';
import { mergeDefaults } from '../src/utils.js';

function settings() {
    const s = mergeDefaults({}, DEFAULT_SETTINGS);
    s.api.retries = 0;
    s.api.retryBaseMs = 200;
    return s;
}

const FILL = '这里是一些无关的叙述，用来把片段撑开。';

/** 四段：第 1 段三次提到“那家店”，第 3 段揭晓店名；第 4 段（续写生成的）也提到 */
function project() {
    const p = createProject({ name: '魔女' });
    p.chunks = [
        { id: 'c0', title: '第一章 雨夜', content: `${FILL.repeat(5)}姜小白走进那家店。${FILL}她又回到那家店门口。${FILL.repeat(40)}那家店的灯还亮着。${FILL.repeat(40)}最后一次提到那家店。${FILL}` },
        { id: 'c1', title: '第二章 茶会', content: `${FILL.repeat(3)}莉莉丝去参加茶会，那位大人也在。${FILL.repeat(3)}` },
        { id: 'c2', title: '第三章 招牌', content: `${FILL.repeat(3)}很久以后，那家店挂出了招牌：月下酒馆。${FILL.repeat(3)}` },
        { id: 'c3', title: '续写 第四章', origin: 'generated', content: `那家店改名叫星光小筑。${FILL}` },
    ];
    const n = normalizeProject(p);
    n.characters['江酒'] = normalizeCharacter({ name: '江酒', aliases: ['小酒', '女仆'], identity: '被变成女仆的前男友，现在在酒吧打工，每天擦杯子', importance: 'main', firstChunk: 0 });
    n.characters['莉莉丝'] = normalizeCharacter({ name: '莉莉丝', identity: '大魔女', importance: 'main', firstChunk: 0 });
    n.characters['路人甲'] = normalizeCharacter({ name: '路人甲', importance: 'minor', firstChunk: 2 });
    n.worldbook = { 地点: { 下城区: { name: '下城区', keywords: ['下城区', '下城'], content: '贫民区' } }, 势力: { 魔女会: { name: '魔女会', keywords: [], content: '魔女的组织' } } };
    n.outline.summary = '江酒被莉莉丝变成女仆。';
    n.missingNames = [
        { type: '地名类', vague: '那家店', context: '她又回到那家店门口', suggest: '莉莉丝酒吧', chunk: 0, resolved: '' },
        { type: '角色名类', vague: '那位大人', context: '那位大人也在', suggest: '', chunk: 1, resolved: '' },
        { type: '专有名词类', vague: '那件东西', context: '她藏起了那件东西', suggest: '', chunk: 1, resolved: '' },
    ];
    return n;
}

function installST(mockFn) {
    const prompts = [];
    globalThis.SillyTavern = {
        getContext: () => ({
            async generateRaw({ prompt }) {
                const text = Array.isArray(prompt) ? prompt.map((m) => m.content).join('\n') : prompt;
                prompts.push(text);
                return mockFn(text, prompts.length);
            },
            stopGeneration() {},
        }),
    };
    return prompts;
}

/** 从提示词里取出这一批的原文说法（## 1. 「那家店」…） */
const vaguesIn = (prompt) => [...prompt.matchAll(/^## \d+\. 「([^」]+)」/gm)].map((m) => m[1]);

// ---------------- 原文片段 ----------------

test('gatherNameContext：所在分段取出现处前后的窗口（相邻的合并），优先提取时记下的那句；最多 3 处', () => {
    const p = project();
    const { passages } = gatherNameContext(p, p.missingNames[0], { radius: 40, maxExtra: 0 });
    const src = passages.filter((x) => x.kind === 'source');
    // 选中：上下文那一处（第 2 处）+ 最前面的两处（第 1、3 处）；第 1、2 处离得近，窗口合并成一段；第 4 处不在 3 处之内
    assert.equal(src.length, 2, JSON.stringify(src));
    assert.ok(src[0].text.includes('姜小白走进那家店') && src[0].text.includes('又回到那家店门口'), src[0].text);
    assert.ok(src[1].text.includes('那家店的灯还亮着'));
    assert.ok(!src.some((x) => x.text.includes('最后一次提到')), '第 4 处在 3 处之外');
    assert.ok(src.every((x) => x.text.startsWith('…') && x.text.endsWith('…') && x.text.length < 200), '窗口两侧带省略号，长度受 radius 控制');
    assert.equal(src[0].chunk, 0);
    assert.equal(src[0].title, '第一章 雨夜');
    // 上下文在分段里找不到时，从第一处开始取
    const other = gatherNameContext(p, { ...p.missingNames[0], context: '原文里没有的一句' }, { radius: 40, maxExtra: 0, maxHits: 1 }).passages;
    assert.equal(other.length, 1);
    assert.ok(other[0].text.includes('姜小白走进那家店'));
});

test('gatherNameContext：其他分段优先取后文，再取前文；续写生成的分段不算原文', () => {
    const p = project();
    p.missingNames[0].chunk = 1; // 假装是第 2 段提到的
    p.chunks[1].content += '那家店';
    const { passages } = gatherNameContext(p, p.missingNames[0], { radius: 20, extraRadius: 20 });
    const extra = passages.filter((x) => x.kind !== 'source');
    assert.deepEqual(extra.map((x) => [x.chunk, x.kind]), [[2, 'later'], [0, 'earlier']]);
    assert.ok(extra[0].text.includes('月下酒馆'));
    assert.ok(!passages.some((x) => x.text.includes('星光小筑')), '第 4 段是续写生成的，不当作原文');
    const later = gatherNameContext(p, p.missingNames[0], { radius: 20, extraRadius: 20, maxExtra: 1 }).passages.filter((x) => x.kind !== 'source');
    assert.deepEqual(later.map((x) => x.kind), ['later'], '名额不够时先给后文');
});

test('gatherNameContext：总字数受预算限制；分段缺失或找不到说法时退回上下文；确定性', () => {
    const p = project();
    p.chunks[0].content = `${'那家店。'.repeat(3)}${FILL.repeat(400)}${'那家店。'.repeat(3)}`;
    for (let i = 0; i < 10; i++) p.chunks.push({ id: `x${i}`, index: 4 + i, title: `第${5 + i}章`, content: `${FILL.repeat(30)}那家店${FILL.repeat(30)}` });
    const a = gatherNameContext(p, p.missingNames[0], { budget: 1200 });
    assert.ok(a.chars <= 1200 + 20, `总字数 ${a.chars}`);
    assert.ok(a.passages.length >= 2 && a.passages.length <= 1 + 3 + 4);
    assert.deepEqual(gatherNameContext(p, p.missingNames[0], { budget: 1200 }), a, '同样的输入同样的输出');

    const gone = { ...p.missingNames[1], chunk: 99 };
    const b = gatherNameContext(p, gone);
    assert.equal(b.passages[0].kind, 'context');
    assert.equal(b.passages[0].text, '那位大人也在');

    const notFound = { ...p.missingNames[2] }; // 第 2 段里没有“那件东西”
    const c = gatherNameContext(p, notFound);
    assert.deepEqual(c.passages.map((x) => x.kind), ['context']);
    assert.deepEqual(gatherNameContext(p, { vague: '', context: '', chunk: 0 }).passages, []);
});

// ---------------- 候选资料与提示词 ----------------

test('buildNameCandidates / existingNameMap：角色按重要度排序、简介截到 40 字；条目按分类；别名只收够具体的', () => {
    const p = project();
    const { characters, entries } = buildNameCandidates(p);
    assert.deepEqual(characters.map((c) => c.name), ['江酒', '莉莉丝', '路人甲']);
    assert.ok(characters[0].desc.length <= 40);
    assert.deepEqual(characters[0].aliases, ['小酒', '女仆']);
    assert.deepEqual(entries.map((e) => `${e.category}/${e.name}`), ['地点/下城区', '势力/魔女会']);
    assert.deepEqual(entries[0].keywords, ['下城']);
    assert.equal(buildNameCandidates(p, { maxCharacters: 1 }).characters.length, 1);
    const map = existingNameMap(p);
    assert.equal(map.get('小酒').ref, '角色「江酒」的别名');
    assert.ok(!map.has('女仆'), '泛称别名不算已有名称');
    assert.equal(map.get('魔女会').ref, '势力「魔女会」');
});

test('buildResolveNamesPrompt：带上梗概、已有角色/条目、原文片段、候选数、起名开关、不要再给的名称与额外要求', () => {
    const p = project();
    const s = settings();
    const batch = prepareNameItems(p, [0, 1], { avoid: { 0: ['莉莉丝酒吧', '夜色'] }, summary: p.outline.summary });
    const on = buildResolveNamesPrompt(p, s, batch, { count: 5, invent: true, extra: '地名用两个字' });
    assert.match(on.system, /《魔女》/);
    for (const t of ['推断具体名称', '最多给 5 个', '江酒被莉莉丝变成女仆', '- 江酒（别名：小酒、女仆）：', '- 地点：下城区（又称 下城）', '- 势力：魔女会',
        '## 1. 「那家店」（类型：地名类）', '提取时给的建议名称（不一定出自原文）：莉莉丝酒吧', '不要再给：莉莉丝酒吧、夜色', '·后文', '月下酒馆',
        '## 2. 「那位大人」', '- invented：', '补足到 5 个', '# 额外要求\n地名用两个字']) {
        assert.ok(on.prompt.includes(t), `提示词缺少：${t}`);
    }
    assert.ok(!on.prompt.includes('{'.concat('ITEMS}')), '占位符都被替换');
    const off = buildResolveNamesPrompt(p, s, batch, { count: 3, invent: false });
    assert.ok(off.prompt.includes('这次不要自己起名字') && off.prompt.includes('不要给 invented 候选'));
    assert.ok(!off.prompt.includes('- invented：') && !off.prompt.includes('# 额外要求'));
    // 设置里改过的模板会被采用
    s.prompts.resolveNames = '自定义：{BOOK} {COUNT} 推断具体名称\n{ITEMS}';
    assert.match(buildResolveNamesPrompt(p, s, batch, { count: 2 }).prompt, /^自定义：魔女 2 推断具体名称/);
});

test('提示词与消息链注册：标签、占位符都在模板里；消息链任务 names 没有自己的链时用默认链', () => {
    for (const k of ['resolveNamesSystem', 'resolveNames']) {
        assert.ok(DEFAULT_PROMPTS[k] && PROMPT_LABELS[k] && PROMPT_PLACEHOLDERS[k]?.length, k);
        for (const ph of PROMPT_PLACEHOLDERS[k]) assert.ok(DEFAULT_PROMPTS[k].includes(ph), `${k} 缺少 ${ph}`);
    }
    assert.ok(CHAIN_TASKS.some((t) => t.value === 'names' && t.label === '推断待确认名称'));
    const s = settings();
    assert.equal(getChain(s, 'names'), s.messageChains.default);
    s.messageChains.names = [{ role: 'user', content: '{PROMPT}', enabled: true }];
    assert.equal(getChain(s, 'names'), s.messageChains.names);
});

// ---------------- 解析 ----------------

test('sanitizeCandidateName：去引号/书名号/括号注释，拒绝空、多行、过长、模糊说法本身和泛称', () => {
    assert.equal(sanitizeCandidateName('  《月下 酒馆》 '), '月下 酒馆');
    assert.equal(sanitizeCandidateName('「江酒」（又名小酒）'), '江酒');
    assert.equal(sanitizeCandidateName('"Lily\'s Bar"'), "Lily's Bar");
    assert.equal(sanitizeCandidateName('月下\n酒馆'), '');
    assert.equal(sanitizeCandidateName('长'.repeat(31)), '');
    assert.equal(sanitizeCandidateName('那家店。', '那家店'), '');
    assert.equal(sanitizeCandidateName('老板'), '');
    assert.equal(sanitizeCandidateName('某地'), '');
    assert.equal(sanitizeCandidateName('Unknown'), '');
    assert.equal(sanitizeCandidateName('林'), '', '一个字不像具体名称');
    assert.equal(sanitizeCandidateName({ name: 'x' }), '');
});

test('parseResolveNamesResult：代码块 + 前后闲聊、按原文说法对回、候选核对（原文/已有/起名）、去重、排序、截断到 N 个', () => {
    const p = project();
    const items = prepareNameItems(p, [0, 1], { summary: p.outline.summary });
    const raw = `好的，结果如下：\n\`\`\`json\n${JSON.stringify([
        { vague: ' 那位大人 ', reason: '原文没写名字', candidates: [] },
        { vague: '那家店', reason: '', candidates: [
            { name: '星辉亭', source: 'invented', confidence: 'high', reason: '按本书风格起名' },
            { name: '《月下酒馆》', source: 'text', confidence: '高', reason: '后文招牌', evidence: '那家店挂出了招牌：月下酒馆' },
            { name: '下城区', source: 'existing', confidence: 'medium', reason: '在下城区' },
            { name: '夜莺之家', source: 'existing', confidence: 'high', reason: '编的“已有”' },
            { name: '月下酒馆', source: 'text', reason: '重复' },
            { name: '那家店', source: 'text', reason: '就是说法本身' },
            { name: '小酒', source: 'text', confidence: 'low', reason: '别名' },
            { name: '编造证据', source: 'text', confidence: 'high', evidence: '原文里根本没有这句' },
        ] },
    ])}\n\`\`\`\n希望有帮助！`;
    const res = parseResolveNamesResult(raw, items, { count: 4, invent: true, existing: existingNameMap(p) });
    assert.equal(res.length, 2);
    const [shop, lord] = res;
    assert.equal(shop.index, 0);
    assert.deepEqual(shop.candidates.map((c) => [c.name, c.source, c.confidence]), [
        ['月下酒馆', 'text', 'high'],
        ['下城区', 'existing', 'medium'],
        ['小酒', 'existing', 'low'],
        ['星辉亭', 'invented', 'medium'],
    ], '原文/已有在前；AI 起名的把握最多 medium；截到 4 个');
    assert.equal(shop.candidates[0].evidence, '那家店挂出了招牌：月下酒馆');
    assert.equal(shop.candidates[1].ref, '地点「下城区」');
    assert.equal(shop.candidates[2].ref, '角色「江酒」的别名');
    assert.equal(lord.index, 1);
    assert.deepEqual(lord.candidates, []);
    assert.equal(lord.reason, '原文没写名字');

    const all = parseResolveNamesResult(raw, items, { count: 6, invent: true, existing: existingNameMap(p) })[0].candidates;
    const fake = all.find((c) => c.name === '夜莺之家');
    assert.equal(fake.source, 'invented', '说是已有但并不存在、原文里也没有：允许起名时降为 AI 起名');
    assert.equal(fake.confidence, 'low');
    const ev = all.find((c) => c.name === '编造证据');
    assert.equal(ev.source, 'invented', '说是原文但片段里找不到：如实标成 AI 起名');
    assert.equal(ev.evidence, '');

    const noInvent = parseResolveNamesResult(raw, items, { count: 6, invent: false, existing: existingNameMap(p) })[0].candidates;
    assert.deepEqual(noInvent.map((c) => c.name), ['月下酒馆', '下城区', '小酒'], '不允许起名时只留原文/已有');
});

test('parseResolveNamesResult：包在对象里、按位置补、每条只给一个名字、对象按说法做键、AI 漏掉的为 null、不要再给的被过滤', () => {
    const p = project();
    const items = prepareNameItems(p, [0, 1, 2], { avoid: { 0: ['月下酒馆'] } });
    const opts = { count: 4, invent: true, existing: existingNameMap(p) };
    // {results:[...]}，第二条的说法写错了：按位置补到第 2 条
    const a = parseResolveNamesResult({ results: [
        { vague: '那家店', candidates: ['月下酒馆', '星辉亭'] },
        { vague: '那个大人物', candidates: [{ name: '莉莉丝', source: 'existing', confidence: 'high' }] },
    ] }, items, opts);
    assert.deepEqual(a[0].candidates.map((c) => c.name), ['星辉亭'], '月下酒馆在「不要再给」里');
    assert.deepEqual(a[0].avoid, ['月下酒馆']);
    assert.deepEqual(a[1].candidates.map((c) => [c.name, c.source]), [['莉莉丝', 'existing']]);
    assert.equal(a[2], null, 'AI 没返回第 3 条');
    // 每条只有一个名字的扁平写法
    const b = parseResolveNamesResult('[{"vague":"那位大人","name":"魔女会","source":"existing","reason":"组织"}]', items, opts);
    assert.equal(b[0], null);
    assert.deepEqual(b[1].candidates.map((c) => [c.name, c.reason]), [['魔女会', '组织']]);
    assert.equal(b[1].reason, '');
    // 按说法做键 / 按序号做键
    const c = parseResolveNamesResult({ 那件东西: [{ name: '紫色魔药', source: 'invented', confidence: 'abc' }], 1: { candidates: [{ name: '星辉亭', source: '新起的' }] } }, items, opts);
    assert.deepEqual(c[2].candidates.map((x) => [x.name, x.source, x.confidence]), [['紫色魔药', 'invented', 'medium']]);
    assert.deepEqual(c[0].candidates.map((x) => x.name), ['星辉亭']);
    // 截断的 JSON 也能修复
    const d = parseResolveNamesResult('[{"vague":"那家店","candidates":[{"name":"星辉亭","source":"invented"', items, opts);
    assert.deepEqual(d[0].candidates.map((x) => x.name), ['星辉亭']);
    assert.throws(() => parseResolveNamesResult('抱歉，我找不到任何名称', items, opts), /无法从 AI 响应中解析 JSON/);
});

// ---------------- 写回与行状态 ----------------

function cand(name, source = 'text', confidence = 'high') {
    return { name, source, confidence, reason: '', evidence: '' };
}

test('applyResolveResults：默认只把把握大的原文/已有候选填进空行；不动手动填写或点选的；记录来源', () => {
    const p = project();
    p.missingNames[1].resolved = '手写的名字'; // 旧数据：没有 resolvedBy，当作手动
    p.missingNames.push({ type: '', vague: '那条河', context: '', chunk: 0, resolved: '' });
    const results = [
        { index: 0, vague: '那家店', reason: '', candidates: [cand('月下酒馆'), cand('星辉亭', 'invented', 'medium')] },
        { index: 1, vague: '那位大人', reason: '', candidates: [cand('魔女会', 'existing')] },
        { index: 2, vague: '那件东西', reason: '找不到', candidates: [] },
        { index: 3, vague: '那条河', reason: '', candidates: [cand('银河', 'text', 'medium')] },
        null,
    ];
    const n = applyResolveResults(p, results);
    assert.deepEqual(n, { filled: 1, offered: 3, none: 1, missed: 1, kept: 0 });
    assert.equal(p.missingNames[0].resolved, '月下酒馆');
    assert.equal(resolvedByOf(p.missingNames[0]), 'ai');
    assert.equal(p.missingNames[1].resolved, '手写的名字', '手动填写的不覆盖');
    assert.equal(resolvedByOf(p.missingNames[1]), 'user');
    assert.deepEqual(p.missingNames[1].ai.candidates.map((c) => c.name), ['魔女会'], '候选照样给');
    assert.equal(p.missingNames[2].ai.reason, '找不到');
    assert.equal(p.missingNames[3].resolved, '', '把握不大的不自动填');
    assert.ok(p.missingNames[0].ai.at > 0);

    const q = project();
    applyResolveResults(q, [{ index: 0, vague: '那家店', candidates: [cand('星辉亭', 'invented', 'medium')] }, { index: 1, vague: '那位大人', candidates: [cand('莉莉丝', 'existing', 'low')] }], { autoFill: 'top' });
    assert.deepEqual(q.missingNames.slice(0, 2).map((m) => [m.resolved, m.resolvedBy]), [['星辉亭', 'ai'], ['莉莉丝', 'ai']], 'top：空行都填第一个');
    const r = project();
    applyResolveResults(r, [{ index: 0, vague: '那家店', candidates: [cand('月下酒馆')] }], { autoFill: 'none' });
    assert.equal(r.missingNames[0].resolved, '');
    assert.equal(r.missingNames[0].ai.candidates.length, 1);
});

test('applyResolveResults：overwrite 只重填 AI 填入的；行被删/重排时按原文说法找回；keepIfEmpty 保留原候选', () => {
    const p = project();
    p.missingNames[0].resolved = '旧的AI名';
    p.missingNames[0].resolvedBy = 'ai';
    p.missingNames[1].resolved = '点选的';
    p.missingNames[1].resolvedBy = 'pick';
    const res = [
        { index: 0, vague: '那家店', candidates: [cand('月下酒馆')] },
        { index: 1, vague: '那位大人', candidates: [cand('魔女会', 'existing')] },
    ];
    applyResolveResults(p, res, { overwrite: false });
    assert.equal(p.missingNames[0].resolved, '旧的AI名', '不覆盖时 AI 填入的也保留');
    applyResolveResults(p, res, { overwrite: true });
    assert.equal(p.missingNames[0].resolved, '月下酒馆');
    assert.equal(p.missingNames[1].resolved, '点选的', '点选的永远不动');
    applyResolveResults(p, [{ index: 0, vague: '那家店', candidates: [cand('猜的', 'invented', 'medium')] }], { overwrite: true });
    assert.equal(p.missingNames[0].resolved, '', '重新推断后没有把握大的候选：清掉之前 AI 填入的值');

    // 推断途中第 1 行被删掉：按原文说法找到原来那一行
    const q = project();
    q.missingNames.splice(0, 1);
    applyResolveResults(q, [{ index: 1, vague: '那位大人', candidates: [cand('魔女会', 'existing')] }, { index: 0, vague: '那家店', candidates: [cand('月下酒馆')] }]);
    assert.equal(q.missingNames[0].resolved, '魔女会');
    assert.equal(q.missingNames.length, 2);

    const k = project();
    k.missingNames[0].ai = { candidates: [cand('甲乙')], reason: '', at: 1 };
    const kept = applyResolveResults(k, [{ index: 0, vague: '那家店', reason: '没有更多了', candidates: [], avoid: ['甲乙'] }], { keepIfEmpty: true });
    assert.equal(kept.kept, 1);
    assert.deepEqual(k.missingNames[0].ai.candidates.map((c) => c.name), ['甲乙']);
    applyResolveResults(k, [{ index: 0, vague: '那家店', candidates: [cand('丙丁')], avoid: ['甲乙'] }], { keepIfEmpty: true });
    assert.deepEqual(k.missingNames[0].ai.seen, ['甲乙'], '记下之前给过的，下次换一批也不再给');
});

test('行状态：点选 / 再点取消 / 确认 AI 填入、手动输入、空行填第一个、需要再确认的名称、推断范围', () => {
    const m = { vague: '那家店', resolved: '', ai: { candidates: [cand('月下酒馆'), cand('星辉亭', 'invented', 'medium')] } };
    assert.equal(pickCandidate(m, 1), 'pick');
    assert.deepEqual([m.resolved, m.resolvedBy, selectedCandidateIndex(m)], ['星辉亭', 'pick', 1]);
    assert.equal(pickCandidate(m, 1), 'clear');
    assert.deepEqual([m.resolved, resolvedByOf(m), selectedCandidateIndex(m)], ['', '', -1]);
    m.resolved = '月下酒馆';
    m.resolvedBy = 'ai';
    assert.equal(pickCandidate(m, 0), 'confirm', '点 AI 填入的那个候选 = 确认');
    assert.equal(m.resolvedBy, 'pick');
    assert.equal(pickCandidate(m, 9), '');
    typeResolved(m, ' 我自己的 ');
    assert.deepEqual([m.resolved, m.resolvedBy], ['我自己的', 'user']);
    typeResolved(m, '星辉亭');
    assert.equal(selectedCandidateIndex(m), 1, '输入的正好是某个候选：它显示为选中');
    typeResolved(m, '');
    assert.equal(m.resolvedBy, undefined);

    const p = project();
    p.missingNames[0].ai = { candidates: [cand('月下酒馆')] };
    p.missingNames[1].ai = { candidates: [cand('魔女会', 'existing')] };
    p.missingNames[1].resolved = '已填';
    p.missingNames[2].ai = { candidates: [], reason: '' };
    assert.deepEqual(namesToResolve(p), [], '都推断过了');
    assert.deepEqual(namesToResolve(p, { overwrite: true }), [0, 2], '全部重新推断：不含手动填写的');
    assert.equal(fillTopCandidates(p), 1);
    assert.deepEqual([p.missingNames[0].resolved, p.missingNames[0].resolvedBy], ['月下酒馆', 'ai']);
    assert.deepEqual(namesToResolve(p, { overwrite: true }), [0, 2], 'AI 填入的可以重新推断');

    p.missingNames[2].ai = { candidates: [cand('星辉亭', 'invented', 'medium')] };
    pickCandidate(p.missingNames[2], 0);
    const risky = riskyResolved(p.missingNames);
    assert.deepEqual(risky.map((x) => [x.m.vague, x.reasons]), [
        ['那家店', ['AI 自动填入，你还没确认']],
        ['那件东西', ['AI 起的名字，原文里没有']],
    ]);
    assert.match(missingNameMarkdown(p.missingNames[0]), /那家店 → 月下酒馆〔AI 候选·原文，AI 自动填入，未确认〕/);
    assert.match(missingNameMarkdown({ type: '地名类', vague: '那条河', context: 'x', ai: { candidates: [cand('银河'), cand('星河', 'invented')] } }), /那条河 → \?（x；AI 候选：银河（原文） \/ 星河（AI 起名））/);
    assert.equal(missingNameMarkdown({ type: 'a', vague: 'b', context: 'c', resolved: 'd' }), '- [a] b → d（c）');
});

// ---------------- 调用 AI ----------------

test('resolveMissingNames：分批请求，一批失败只记日志，其他批的结果保留；进度回调', async () => {
    const p = project();
    const s = settings();
    const prompts = installST((text) => {
        const vs = vaguesIn(text);
        if (vs.includes('那件东西')) return '服务器开小差了，不是 JSON';
        return JSON.stringify(vs.map((v) => ({ vague: v, candidates: v === '那家店' ? [{ name: '月下酒馆', source: 'text', confidence: 'high', evidence: '挂出了招牌：月下酒馆' }, { name: '星辉亭', source: 'invented' }] : [{ name: '莉莉丝', source: 'existing', confidence: 'medium' }] })));
    });
    const logs = [];
    const progress = [];
    const res = await resolveMissingNames(p, s, { batchSize: 2, onLog: (m) => logs.push(m), onProgress: (x) => progress.push([x.batch, x.batches, x.done, x.indices, x.failed]) });
    assert.equal(prompts.length, 3, '第 1 批 1 次；第 2 批不是 JSON，要求重输 1 次');
    assert.ok(prompts[2].includes('不是合法 JSON'), '第二次带上了修复提示');
    assert.deepEqual(vaguesIn(prompts[0]), ['那家店', '那位大人']);
    assert.deepEqual(progress, [[1, 2, 2, [0, 1], false], [2, 2, 3, [2], true]]);
    assert.equal(res.failed, 1);
    assert.equal(res.total, 3);
    assert.equal(res.offered, 2);
    assert.equal(res.filled, 1);
    assert.ok(logs.some((l) => l.includes('推断名称失败（第 2/2 批）「那件东西」')), logs.join('\n'));
    assert.equal(p.missingNames[0].resolved, '月下酒馆');
    assert.deepEqual(p.missingNames[0].ai.candidates.map((c) => [c.name, c.source]), [['月下酒馆', 'text'], ['星辉亭', 'invented']]);
    assert.equal(p.missingNames[1].resolved, '', 'medium 不自动填');
    assert.equal(p.missingNames[2].ai, undefined, '失败的那批不写回，下次「只推断还没推断过的」还会选中它');
    assert.deepEqual(namesToResolve(p), [2]);

    // 全部失败：抛出错误
    installST(() => '不是 JSON');
    const q = project();
    await assert.rejects(resolveMissingNames(q, s, { indices: [0] }), /无法从 AI 响应中解析 JSON/);
    assert.equal(q.missingNames[0].ai, undefined);
});

test('resolveMissingNames：换一批带上不要再给的名称、已填写的保留；选项来自设置；没有可推断的直接返回；可中止', async () => {
    const p = project();
    const s = settings();
    s.nameResolve = { ...s.nameResolve, count: 2, invent: false, autoFill: 'top' };
    p.missingNames[0].resolved = '月下酒馆';
    p.missingNames[0].resolvedBy = 'pick';
    p.missingNames[0].ai = { candidates: [cand('月下酒馆')], reason: '', at: 1 };
    const prompts = installST(() => JSON.stringify([{ vague: '那家店', candidates: [{ name: '月下酒馆', source: 'text' }, { name: '下城区', source: 'existing', confidence: 'high' }, { name: '星辉亭', source: 'invented' }, { name: '魔女会', source: 'existing' }] }]));
    const res = await resolveMissingNames(p, s, { indices: [0], avoid: { 0: ['月下酒馆'] }, overwrite: false });
    assert.ok(prompts[0].includes('不要再给：月下酒馆'));
    assert.ok(prompts[0].includes('最多给 2 个') && prompts[0].includes('这次不要自己起名字'), '用设置里的候选数和起名开关');
    assert.deepEqual(p.missingNames[0].ai.candidates.map((c) => c.name), ['月下酒馆', '下城区', '魔女会'], '过滤掉不要再给的、不允许的起名，截到 2 个；已选的那个旧候选仍放在最前面');
    assert.equal(p.missingNames[0].resolved, '月下酒馆', '已选的值保留');
    assert.equal(selectedCandidateIndex(p.missingNames[0]), 0);
    assert.equal(res.filled, 0);

    const none = await resolveMissingNames(project(), s, { indices: [] });
    assert.equal(none.total, 0);

    const ctl = new AbortController();
    ctl.abort();
    await assert.rejects(resolveMissingNames(project(), s, { signal: ctl.signal }), (e) => e.name === 'AbortError');
});

// ---------------- 核对与对回（复核修正） ----------------

/** 一个只有一段原文的小项目：说法 vague 出现在 text 里 */
function tiny(text, rows, extra = {}) {
    const p = createProject({ name: '小镇' });
    p.chunks = [{ id: 't0', title: '第一章', content: text }, ...(extra.chunks || [])];
    const n = normalizeProject(p);
    n.missingNames = rows.map((r) => ({ type: '', context: '', suggest: '', chunk: 0, resolved: '', ...r }));
    return n;
}

test('来源核对：原文里出现的名字正好是已有角色 → existing 且不降把握，默认能自动填入', () => {
    const p = project();
    p.chunks[2].content += '原来那位大人就是莉莉丝。';
    const items = prepareNameItems(p, [1], { summary: '' });
    const res = parseResolveNamesResult(JSON.stringify([{ vague: '那位大人', candidates: [{ name: '莉莉丝', source: 'text', confidence: 'high', evidence: '原来那位大人就是莉莉丝' }] }]), items, { existing: existingNameMap(p) });
    assert.deepEqual(res[0].candidates.map((c) => [c.name, c.source, c.confidence, c.evidence]), [['莉莉丝', 'existing', 'high', '原来那位大人就是莉莉丝']]);
    assert.equal(applyResolveResults(p, res).filled, 1);
    assert.equal(p.missingNames[1].resolved, '莉莉丝');
    // 说是原文、其实原文里没有的已有角色：仍是 existing，但把握降为 low
    const q = project();
    const r2 = parseResolveNamesResult([{ vague: '那位大人', candidates: [{ name: '江酒', source: 'text', confidence: 'high' }] }], prepareNameItems(q, [1]), { existing: existingNameMap(q) });
    assert.deepEqual(r2[0].candidates.map((c) => [c.source, c.confidence]), [['existing', 'low']]);
});

test('来源核对：模糊说法本身的一小截不算原文证据；泛称（含“掌柜的”）和说法的片段直接去掉', () => {
    const p = tiny('他走进那家酒楼，掌柜的迎了上来。城东那家卖烧饼的老铺子也开着。', [{ vague: '那家酒楼' }, { vague: '城东那家卖烧饼的老铺子' }]);
    const items = prepareNameItems(p, [0, 1]);
    const raw = [
        { vague: '那家酒楼', candidates: [{ name: '酒楼', source: 'text', confidence: 'high' }, { name: '家酒楼', source: 'text', confidence: 'high' }, { name: '掌柜的', source: 'text', confidence: 'high' }, { name: '醉仙楼', source: 'invented' }] },
        { vague: '城东那家卖烧饼的老铺子', candidates: [{ name: '老铺子', source: 'text', confidence: 'high' }] },
    ];
    const res = parseResolveNamesResult(raw, items, { existing: existingNameMap(p) });
    assert.deepEqual(res[0].candidates.map((c) => c.name), ['醉仙楼'], '酒楼/家酒楼是说法的片段，掌柜的是泛称');
    assert.deepEqual(res[1].candidates.map((c) => [c.name, c.source, c.confidence]), [['老铺子', 'invented', 'low']], '只在说法里出现：不算原文');
    assert.equal(applyResolveResults(p, res).filled, 0, '不会被当成把握大的原文名称自动填入');
    assert.equal(sanitizeCandidateName('掌柜的'), '');
    assert.equal(sanitizeCandidateName('酒楼', '那家酒楼'), '');
    assert.equal(parseResolveNamesResult(raw, items, { invent: false, existing: existingNameMap(p) })[1].candidates.length, 0);
});

test('世界书条目的关键词（提示词里的“又称”）也算已有名称，不会被丢掉或标成 AI 起名', () => {
    const p = project();
    const map = existingNameMap(p);
    assert.equal(map.get('下城').ref, '地点「下城区」的关键词');
    assert.equal(map.get('下城区').ref, '地点「下城区」', '关键词不会盖掉条目名');
    const res = parseResolveNamesResult([{ vague: '那家店', candidates: [{ name: '下城', source: 'existing', confidence: 'high' }] }], prepareNameItems(p, [0]), { invent: false, existing: map });
    assert.deepEqual(res[0].candidates.map((c) => [c.name, c.source, c.confidence, c.ref]), [['下城', 'existing', 'high', '地点「下城区」的关键词']]);
});

test('对回各条：规整后相同的说法各拿各的；说法带序号/括号注释也认；漏了一条时不按位置硬对', () => {
    // 两行规整后都是“那位大人”
    const p = tiny('茶会上那位大人是张三。后来那位大人。换成了李四。', [{ vague: '那位大人' }, { vague: '那位大人。' }]);
    const items = prepareNameItems(p, [0, 1]);
    const r = parseResolveNamesResult({ 那位大人: [{ name: '张三', source: 'text', confidence: 'high' }], '那位大人。': [{ name: '李四', source: 'text', confidence: 'high' }] }, items, {});
    assert.deepEqual(r.map((x) => x.candidates.map((c) => c.name)), [['张三'], ['李四']]);
    const r2 = parseResolveNamesResult([{ vague: '那位大人', candidates: ['张三'] }, { vague: '那位大人', candidates: ['李四'] }], items, {});
    assert.deepEqual(r2.map((x) => x.candidates.map((c) => c.name)), [['张三'], ['李四']], '说法都写成一样的：按顺序各给一条');

    const q = tiny('那位大人和那家店。悦来客栈就是那家店。', [{ vague: '那位大人' }, { vague: '那家店' }]);
    const qi = prepareNameItems(q, [0, 1]);
    const one = parseResolveNamesResult([{ vague: '那家店（地点）', candidates: [{ name: '悦来客栈', source: 'text', confidence: 'high' }] }], qi, {});
    assert.equal(one[0], null, 'AI 漏掉的第 1 条不会被塞进第 2 条的地名');
    assert.deepEqual(one[1].candidates.map((c) => c.name), ['悦来客栈']);
    assert.deepEqual(parseResolveNamesResult([{ vague: '2. 那家店', candidates: ['悦来客栈'] }], qi, {})[1].candidates.map((c) => c.name), ['悦来客栈'], '带序号');
    // 调换了顺序、其中一条说法写错：对上的那条在别的位置 → 不按位置对，剩下一条和一个空位配对
    const swapped = parseResolveNamesResult([{ vague: '那个店铺', candidates: ['悦来客栈'] }, { vague: '那位大人', candidates: ['张三'] }], qi, {});
    assert.deepEqual(swapped.map((x) => x.candidates.map((c) => c.name)), [['张三'], ['悦来客栈']]);
    // 只回了一条、说法也对不上：不知道是哪一条 → 当作格式不对，要求重输
    assert.throws(() => parseResolveNamesResult([{ vague: '那个店铺', candidates: ['悦来客栈'] }], qi, {}), (e) => e.code === 'JSON_PARSE' && /对不上/.test(e.feedback));
});

test('宽松解析：只有一条时候选对象直接排成数组全都保留；不认识的包装键能拆开；什么都对不上时要求重输', () => {
    const p = project();
    const one = prepareNameItems(p, [1]);
    const flat = [{ name: '莉莉丝', source: 'existing', confidence: 'high' }, { name: '夜之女王', source: 'invented' }, { name: '暗月', source: 'invented' }, { name: '白公爵', source: 'invented' }, { name: '多余的', source: 'invented' }];
    assert.deepEqual(parseResolveNamesResult(JSON.stringify(flat), one, { count: 4, existing: existingNameMap(p) })[0].candidates.map((c) => c.name), ['莉莉丝', '夜之女王', '暗月', '白公爵']);
    assert.deepEqual(parseResolveNamesResult({ answer: flat.slice(0, 2) }, one, { existing: existingNameMap(p) })[0].candidates.map((c) => c.name), ['莉莉丝', '夜之女王'], '只有一条：唯一的数组就是它的候选');

    const two = prepareNameItems(p, [0, 1]);
    const wrapped = { foo: 1, result: [{ vague: '那位大人', candidates: ['莉莉丝'] }, { vague: '那家店', candidates: ['月下酒馆'] }] };
    assert.deepEqual(parseResolveNamesResult(wrapped, two, {}).map((x) => x.candidates.map((c) => c.name)), [['月下酒馆'], ['莉莉丝']]);
    assert.deepEqual(parseResolveNamesResult({ 输出: [{ vague: '那家店', candidates: ['月下酒馆'] }] }, two, {})[0].candidates.map((c) => c.name), ['月下酒馆'], '包装键不在常见列表里也认');
    assert.throws(() => parseResolveNamesResult({ foo: [{ x: 1 }, { y: 2 }] }, two, {}), (e) => e.code === 'JSON_PARSE');
    // 空数组：AI 什么都没给，不当作格式错误（记为没返回）
    assert.deepEqual(parseResolveNamesResult('[]', two, {}), [null, null]);
});

test('写回：换一批后已选的旧候选仍在最前面（AI 起名的提醒、导出注明都还在）；行在推断途中被删掉时结果不落到别的行', () => {
    const p = project();
    const m = p.missingNames[2];
    m.ai = { candidates: [cand('夜王', 'invented', 'medium'), cand('白公爵', 'invented', 'medium')], reason: '', at: 1 };
    pickCandidate(m, 0);
    applyResolveResults(p, [{ index: 2, vague: '那件东西', candidates: [cand('影侯', 'invented', 'medium')], avoid: ['夜王', '白公爵'] }], { keepIfEmpty: true });
    assert.deepEqual(m.ai.candidates.map((c) => c.name), ['夜王', '影侯']);
    assert.equal(selectedCandidateIndex(m), 0);
    assert.deepEqual(m.ai.seen, ['夜王', '白公爵']);
    assert.deepEqual(riskyResolved(p.missingNames).map((x) => x.reasons), [['AI 起的名字，原文里没有']]);
    assert.match(missingNameMarkdown(m), /那件东西 → 夜王〔AI 候选·AI 起名〕/);
    // AI 填入的（还没确认）同样保留在最前面，点它就能确认
    m.resolved = '影侯';
    m.resolvedBy = 'ai';
    applyResolveResults(p, [{ index: 2, vague: '那件东西', candidates: [cand('黑伯爵', 'invented', 'medium')], avoid: ['影侯'] }], { keepIfEmpty: true });
    assert.deepEqual(m.ai.candidates.map((c) => c.name), ['影侯', '黑伯爵']);
    assert.equal(pickCandidate(m, 0), 'confirm');

    // 带着行对象的结果：这一行已经被忽略掉了 → 不写回（也不落到同名的别的行上）
    const q = project();
    const items = prepareNameItems(q, [0]);
    const res = parseResolveNamesResult([{ vague: '那家店', candidates: [{ name: '月下酒馆', source: 'text', confidence: 'high' }] }], items, {});
    q.missingNames.splice(0, 1);
    q.missingNames.push({ type: '', vague: '那家店', context: '', chunk: 2, resolved: '' });
    assert.equal(applyResolveResults(q, res).missed, 1);
    assert.equal(q.missingNames[2].ai, undefined);
});

test('resolveMissingNames：换一批 AI 回了空数组 → 记为没返回、原来的候选不动；对不上时要求按模板重输；停止后回来的那批不写回', async () => {
    const p = project();
    const s = settings();
    p.missingNames[0].ai = { candidates: [cand('月下酒馆')], reason: '', at: 1 };
    installST(() => '[]');
    const res = await resolveMissingNames(p, s, { indices: [0], avoid: { 0: ['月下酒馆'] } });
    assert.equal(res.missed, 1);
    assert.equal(res.kept, 0);
    assert.deepEqual(p.missingNames[0].ai.candidates.map((c) => c.name), ['月下酒馆']);

    const prompts = installST((text, n) => (n === 1 ? JSON.stringify({ foo: [{ x: 1 }] }) : JSON.stringify([{ vague: '那位大人', candidates: [{ name: '莉莉丝', source: 'existing', confidence: 'high' }] }])));
    const logs = [];
    await resolveMissingNames(p, s, { indices: [1], onLog: (m) => logs.push(m) });
    assert.equal(prompts.length, 2);
    assert.ok(prompts[1].includes('对不上要推断的条目'), '带上了“按模板重输”的提示');
    assert.ok(logs.some((l) => l.includes('对不上要推断的条目')), logs.join('\n'));
    assert.deepEqual(p.missingNames[1].ai.candidates.map((c) => c.name), ['莉莉丝']);

    const q = project();
    const ctl = new AbortController();
    installST(() => {
        ctl.abort(); // 请求还没回来就停止了
        return JSON.stringify([{ vague: '那家店', candidates: [{ name: '月下酒馆', source: 'text', confidence: 'high' }] }]);
    });
    await assert.rejects(resolveMissingNames(q, s, { indices: [0], signal: ctl.signal }), (e) => e.name === 'AbortError');
    assert.equal(q.missingNames[0].ai, undefined);
    assert.equal(q.missingNames[0].resolved, '');
});

// ---------------- 设置 ----------------

test('设置：默认值、规整（候选数 2-6、每批 1-12、模式白名单）、导入配置时规整、getSettings 补齐', () => {
    assert.deepEqual(DEFAULT_SETTINGS.nameResolve, DEFAULT_NAME_RESOLVE);
    assert.deepEqual(DEFAULT_NAME_RESOLVE, { invent: true, count: 4, autoFill: 'confident', overwrite: false, batchSize: 6, extra: '' });
    assert.deepEqual(normalizeNameResolve({ count: 99, batchSize: 0, autoFill: 'all', invent: 0, overwrite: 'yes', extra: 5 }), { invent: false, count: 6, autoFill: 'confident', overwrite: true, batchSize: 1, extra: '' });
    assert.equal(normalizeNameResolve({ count: '3' }).count, 3);
    assert.equal(normalizeNameResolve({ count: 'abc' }).count, 4);
    assert.deepEqual(normalizeNameResolve(null), DEFAULT_NAME_RESOLVE);
    const s = settings();
    assert.deepEqual(nameResolveOptions(s, { count: 2, invent: undefined }), { ...DEFAULT_NAME_RESOLVE, count: 2 });
    applyConfig(s, { type: 'novel_loom_config', settings: { nameResolve: { count: 1, autoFill: 'top' } } });
    assert.deepEqual(s.nameResolve, { ...DEFAULT_NAME_RESOLVE, count: 2, autoFill: 'top' });
    applyConfig(s, { api: { temperature: 0.5 } });
    assert.equal(s.nameResolve.autoFill, 'top', '配置里没有这一项时不动');
    const old = { nameResolve: { count: 5 } };
    mergeDefaults(old, DEFAULT_SETTINGS);
    assert.deepEqual(old.nameResolve, { ...DEFAULT_NAME_RESOLVE, count: 5 }, '旧设置补上缺的选项');
    const g = getSettings();
    g.nameResolve.count = 42;
    assert.equal(getSettings().nameResolve.count, 6);
});
