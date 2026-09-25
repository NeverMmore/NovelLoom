// 局部重写测试：选区拼接、前后文边界、文风/禁用词接入、消息链、参数校验
import test from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_SETTINGS } from '../src/constants.js';
import { mergeDefaults } from '../src/utils.js';
import { createProject, normalizeProject } from '../src/project.js';
import { buildRewritePrompt, rewriteSelection } from '../src/rewrite.js';

function settings() {
    const s = mergeDefaults({}, DEFAULT_SETTINGS);
    s.api.retryBaseMs = 200;
    s.api.retries = 0;
    return s;
}

function project() {
    return normalizeProject(createProject({ name: '魔女' }));
}

function installST(mockFn) {
    globalThis.SillyTavern = {
        getContext: () => ({
            async generateRaw({ prompt }) {
                const text = Array.isArray(prompt) ? prompt.map((m) => m.content).join('\n') : prompt;
                return mockFn(text);
            },
            stopGeneration() {},
        }),
    };
}

test('buildRewritePrompt：占位符替换，开头/结尾没有前后文时给出提示语', () => {
    const p = project();
    p.style.rules = '- 对话推进剧情';
    const { system, prompt } = buildRewritePrompt(p, settings(), {
        selected: '他仿佛什么都没说。',
        before: '',
        after: '她转身离开了。',
        instruction: '去掉“仿佛”，换成更肯定的写法',
        task: 'continue',
    });
    assert.match(system, /只重写「待重写」部分/);
    assert.match(prompt, /<selected>\n他仿佛什么都没说。\n<\/selected>/);
    assert.match(prompt, /<before>\n（无，这是开头）\n<\/before>/);
    assert.match(prompt, /<after>\n她转身离开了。\n<\/after>/);
    assert.match(prompt, /对话推进剧情/, '应该带上文风规则');
    assert.match(prompt, /去掉“仿佛”，换成更肯定的写法/);
});

test('rewriteSelection：只替换选中范围，前后文原样保留，返回的 start/end 对应新文本里的重写结果', async () => {
    const p = project();
    let seenPrompt = '';
    installST((text) => {
        seenPrompt = text;
        return '他冷冷地扫了一眼。';
    });
    const full = '江酒推门进来。他仿佛什么都没说。她转身离开了。';
    const start = full.indexOf('他仿佛什么都没说。');
    const end = start + '他仿佛什么都没说。'.length;
    const res = await rewriteSelection(p, settings(), {
        text: full,
        start,
        end,
        instruction: '换一种写法',
        api: settings().api,
    });
    assert.equal(res.rewritten, '他冷冷地扫了一眼。');
    assert.equal(res.text, '江酒推门进来。他冷冷地扫了一眼。她转身离开了。');
    assert.equal(full.slice(0, start), res.text.slice(0, start), '选区之前的文字不变');
    assert.equal(res.text.slice(res.start, res.end), res.rewritten);
    assert.match(seenPrompt, /<selected>\n他仿佛什么都没说。\n<\/selected>/);
    assert.match(seenPrompt, /<before>\n江酒推门进来。\n<\/before>/);
    assert.match(seenPrompt, /<after>\n她转身离开了。\n<\/after>/);
});

test('rewriteSelection：contextChars 控制前后文取多少字，靠近全文边界时自动收窄不会越界', async () => {
    const p = project();
    let seenBefore = '';
    let seenAfter = '';
    installST((text) => {
        seenBefore = (text.match(/<before>\n([\s\S]*?)\n<\/before>/) || [])[1];
        seenAfter = (text.match(/<after>\n([\s\S]*?)\n<\/after>/) || [])[1];
        return '重写结果';
    });
    const full = 'AAAAABBBBBCCCCC';
    await rewriteSelection(p, settings(), { text: full, start: 5, end: 10, instruction: 'x', api: settings().api, contextChars: 2 });
    assert.equal(seenBefore, 'AA', '前文只取最近 contextChars 个字');
    assert.equal(seenAfter, 'CC', '后文只取最近 contextChars 个字');

    // 选区紧贴开头：前文不足 contextChars 个字时不应越界报错，而是取到开头为止
    const res = await rewriteSelection(p, settings(), { text: full, start: 0, end: 5, instruction: 'x', api: settings().api, contextChars: 400 });
    assert.equal(seenBefore, '（无，这是开头）');
    assert.equal(seenAfter, full.slice(5));
    assert.equal(res.text, `重写结果${full.slice(5)}`);
});

test('rewriteSelection：本地禁用词清理（能按建议替换的自动替换，替换不了的通过 bannedHits 报告）', async () => {
    const p = project();
    p.style.banned = '仿佛=>确实\n宛如';
    installST(() => '他仿佛宛如一阵风。');
    const full = '开头。选中部分。结尾。';
    const res = await rewriteSelection(p, settings(), {
        text: full,
        start: full.indexOf('选中部分'),
        end: full.indexOf('选中部分') + 4,
        instruction: 'x',
        api: settings().api,
    });
    assert.equal(res.rewritten, '他确实宛如一阵风。', '“仿佛=>确实”应该被本地替换');
    assert.equal(res.bannedHits, 1, '“宛如”没有替换建议，应该保留并报告');
});

test('rewriteSelection：参数校验（未选中文字 / 没写重写要求 / AI 空返回）', async () => {
    const p = project();
    installST(() => '正常返回');
    await assert.rejects(
        () => rewriteSelection(p, settings(), { text: '一些正文', start: 3, end: 3, instruction: 'x', api: settings().api }),
        /请先在正文中选中/,
    );
    await assert.rejects(
        () => rewriteSelection(p, settings(), { text: '一些正文', start: 0, end: 2, instruction: '  ', api: settings().api }),
        /请说明重写要求/,
    );
    installST(() => '   ');
    await assert.rejects(
        () => rewriteSelection(p, settings(), { text: '一些正文', start: 0, end: 2, instruction: 'x', api: settings().api }),
        /空内容|AI 没有返回/,
    );
});

test('rewriteSelection：清理代码块包裹与 <selected> 标签', async () => {
    const p = project();
    installST(() => '```\n<selected>\n干净的重写结果\n</selected>\n```');
    const full = '开头。选中。结尾。';
    const res = await rewriteSelection(p, settings(), {
        text: full,
        start: full.indexOf('选中'),
        end: full.indexOf('选中') + 2,
        instruction: 'x',
        api: settings().api,
    });
    assert.equal(res.rewritten, '干净的重写结果');
});
