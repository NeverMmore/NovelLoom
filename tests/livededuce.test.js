// 剧情推演（当前酒馆对话版）测试：直接基于酒馆里正在进行的单人对话——角色卡当前字段 + 实际聊天记录 + 当前生效的世界书
// ——推演接下来可能的发展，结果存在这个对话自己的 chat_metadata 里，和角色卡页（deduce.js）的推演完全独立。
import test from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_SETTINGS } from '../src/constants.js';
import { mergeDefaults } from '../src/utils.js';
import {
    activeCharacterName, addChatBranch, addChatStage, CHAT_META_KEY, chatDeductionMarkdown, ensureChatProjection,
    generateChatBranches, generateChatStages, hasActiveChat, removeChatBranch, removeChatStage, setSelectedChatBranches,
    updateChatBranch, updateChatStage,
} from '../src/livededuce.js';

function settings() {
    const s = mergeDefaults({}, DEFAULT_SETTINGS);
    s.api.retryBaseMs = 200;
    s.api.retries = 0;
    return s;
}

function cardFields(overrides = {}) {
    return {
        description: '基本信息',
        personality: '油嘴滑舌',
        scenario: '酒吧',
        firstMessage: '夜色降临，他推门而入，一眼就看到了你。',
        alternateGreetings: [],
        mesExamples: '',
        system: '',
        persona: '',
        jailbreak: '',
        version: '',
        charDepthPrompt: '',
        creatorNotes: '',
        ...overrides,
    };
}

/** 搭一个最小可用的酒馆上下文 mock（类型照真实酒馆来：characterId 是字符串 "0"，mesExamples 是字符串）：chatMetadata 用闭包里的同一个对象，模拟真实酒馆里“跨次 getContext() 调用但是同一个对话”的效果 */
function installLiveST({ mockFn, chat = [], groupId = null, characterId = '0', characters = [{ name: '江酒' }], worldInfo = '', fields } = {}) {
    const chatMetadata = {};
    const wiCalls = [];
    globalThis.SillyTavern = {
        getContext: () => ({
            chat,
            characters,
            characterId,
            groupId,
            name1: '你',
            name2: characters[characterId]?.name || '',
            chatMetadata,
            updateChatMetadata(vals) {
                Object.assign(chatMetadata, vals);
            },
            async saveMetadata() {},
            getCharacterCardFields: () => fields || cardFields(),
            // 照真实酒馆的要求校验入参：必须是"名字: 内容"字符串数组，且最新的在最前面（对象数组会让真实的世界书扫描出错）
            getWorldInfoPrompt: async (wiChat) => {
                assert.ok(Array.isArray(wiChat) && wiChat.every((x) => typeof x === 'string'), '传给世界书扫描的必须是字符串数组');
                wiCalls.push(wiChat);
                return { worldInfoString: worldInfo };
            },
            maxContext: 8192,
            async generateRaw({ prompt }) {
                const text = Array.isArray(prompt) ? prompt.map((m) => m.content).join('\n') : prompt;
                return mockFn(text);
            },
            stopGeneration() {},
        }),
    };
    return { wiCalls };
}

test.afterEach(() => {
    delete globalThis.SillyTavern;
});

test('hasActiveChat / activeCharacterName：群聊、没选角色时不支持；单人对话正常识别', () => {
    assert.equal(hasActiveChat(), false, '没有酒馆上下文时应为 false');

    installLiveST({ mockFn: () => '', groupId: 'group1' });
    assert.equal(hasActiveChat(), false, '群聊不支持');

    installLiveST({ mockFn: () => '', characterId: null });
    assert.equal(hasActiveChat(), false, '没有选中角色（null）时不支持——不能把 Number(null)=0 当成第 0 号角色');
    installLiveST({ mockFn: () => '', characterId: '' });
    assert.equal(hasActiveChat(), false, '没有选中角色（空串）时不支持');
    installLiveST({ mockFn: () => '', characterId: '5' });
    assert.equal(hasActiveChat(), false, '角色编号指向不存在的角色时不支持');

    installLiveST({ mockFn: () => '' });
    assert.equal(hasActiveChat(), true, '真实酒馆里 characterId 是字符串 "0"，必须能识别（这是之前一直提示没打开对话的 bug）');
    assert.equal(activeCharacterName(), '江酒');

    installLiveST({ mockFn: () => '', characterId: 0 });
    assert.equal(hasActiveChat(), true, '数字形式的编号也应该能识别');

    installLiveST({ mockFn: () => '', characterId: '1', characters: [{ name: '甲' }, { name: '乙' }] });
    assert.equal(hasActiveChat(), true);
    assert.equal(activeCharacterName(), '乙', '字符串编号应按下标取到对应角色');
});

test('示例对话：真实酒馆里是字符串（不是数组），应原样带进提示词，不能因为类型不对而抛错', async () => {
    installLiveST({
        mockFn: (text) => {
            if (text.includes('方向要求')) {
                assert.match(text, /示例对话：/);
                assert.match(text, /\{\{user\}\}: 你好/, '字符串形式的示例对话应该完整出现');
                return JSON.stringify([{ title: 'A', summary: 'a' }, { title: 'B', summary: 'b' }]);
            }
            return '（不应该走到这里）';
        },
        fields: cardFields({ mesExamples: '<START>\n{{user}}: 你好\n{{char}}: 哟，来了。' }),
    });
    const branches = await generateChatBranches(settings(), { directions: ['', ''] });
    assert.equal(branches.length, 2);

    installLiveST({
        mockFn: (text) => {
            assert.match(text, /示例对话：/);
            return JSON.stringify([{ title: 'A', summary: 'a' }, { title: 'B', summary: 'b' }]);
        },
        fields: cardFields({ mesExamples: ['<START>\n示例一', '<START>\n示例二'] }),
    });
    assert.equal((await generateChatBranches(settings(), { directions: ['', ''] })).length, 2, '数组形式也要兼容');
});

test('ensureChatProjection：首次访问自动补齐结构，且挂在 chat_metadata 的固定键名下，重复调用不覆盖已有数据', async () => {
    installLiveST({ mockFn: () => '' });
    const pp = ensureChatProjection();
    assert.deepEqual(pp.branches, []);
    assert.deepEqual(pp.selectedBranchIds, []);
    assert.deepEqual(pp.stages, []);

    await addChatBranch({ title: '走向一', summary: '概要一' });
    assert.equal(ensureChatProjection().branches.length, 1, '不应该重置已有数据');

    const c = globalThis.SillyTavern.getContext();
    assert.ok(c.chatMetadata[CHAT_META_KEY], '应该落在 chat_metadata 的固定键名下');
    assert.equal(c.chatMetadata[CHAT_META_KEY].branches.length, 1);
});

test('generateChatBranches：结合角色卡当前字段、实际聊天记录、世界书生成并列走向，清空旧的选中状态', async () => {
    installLiveST({
        mockFn: (text) => {
            if (text.includes('方向要求')) {
                assert.match(text, /夜色降临，他推门而入，一眼就看到了你/, '应该带上角色卡当前的开场白');
                assert.match(text, /你：最近过得怎么样/, '应该带上实际聊天记录');
                assert.match(text, /江酒：还行，你呢/, '应该带上实际聊天记录');
                assert.match(text, /当前生效的世界书资料/, '应该带上世界书资料');
                assert.match(text, /密室酒馆位于老城区/, '世界书的具体内容应该出现在提示词里');
                assert.match(text, /整体额外要求（对每条走向都适用）：多一点悬疑感/, '应该带上用户的额外要求');
                return JSON.stringify([
                    { title: '走向一：旧情复燃', summary: '两人重逢，过去的纠葛浮出水面。' },
                    { title: '走向二：身份暴露', summary: '{{user}} 的真实身份被发现，关系骤变。' },
                ]);
            }
            return '（不应该走到这里）';
        },
        chat: [
            { name: '你', is_user: true, mes: '最近过得怎么样' },
            { name: '江酒', is_user: false, mes: '还行，你呢' },
            { name: '系统', is_system: true, mes: '（这条不该出现在提示词里）' },
        ],
        worldInfo: '密室酒馆位于老城区，常有神秘来客出没。',
    });

    const pp = ensureChatProjection();
    pp.selectedBranchIds = ['stale-id'];

    const branches = await generateChatBranches(settings(), { instruction: '多一点悬疑感' });
    assert.equal(branches.length, 2);
    assert.equal(new Set(branches.map((b) => b.id)).size, 2, 'id 应该互不相同');
    assert.equal(branches[0].title, '走向一：旧情复燃');
    assert.equal(ensureChatProjection().selectedBranchIds.length, 0, '重新生成走向后旧的选中状态应该被清空');
    assert.ok(ensureChatProjection().branchesUpdatedAt > 0);
});

test('generateChatBranches：还没有聊天记录时，提示词说明“从开场白往后推演”；干预走向——directions 决定数量与方向', async () => {
    installLiveST({
        mockFn: (text) => {
            if (text.includes('方向要求')) {
                assert.match(text, /还没有聊天记录，这是对话刚开始，就从开场白往后推演/);
                assert.match(text, /1\. 两人旧情复燃/);
                assert.match(text, /2\. （不限方向，由你自由发挥，但要和其他几条有明显区别）/);
                return JSON.stringify([
                    { title: '走向一', summary: '概要一' },
                    { title: '走向二', summary: '概要二' },
                ]);
            }
            return '（不应该走到这里）';
        },
        chat: [],
    });

    const branches = await generateChatBranches(settings(), { directions: ['两人旧情复燃', ''] });
    assert.equal(branches.length, 2, '走向数量应该等于 directions 的长度');
});

test('走向的增删改；setSelectedChatBranches 过滤掉不存在的 id，且落盘到 chat_metadata', async () => {
    installLiveST({ mockFn: () => '' });
    const b1 = await addChatBranch({ title: 'A', summary: 'a' });
    const b2 = await addChatBranch({ title: 'B', summary: 'b' });
    assert.equal(ensureChatProjection().branches.length, 2);

    await updateChatBranch(b1.id, { title: 'A2' });
    assert.equal(ensureChatProjection().branches.find((x) => x.id === b1.id).title, 'A2');
    assert.equal(await updateChatBranch('no-such-id', { title: 'x' }), null);

    const sel = await setSelectedChatBranches([b1.id, b2.id, 'no-such-id']);
    assert.deepEqual(sel.sort(), [b1.id, b2.id].sort(), '不存在的 id 应该被过滤掉');

    await removeChatBranch(b1.id);
    assert.equal(ensureChatProjection().branches.length, 1);
    assert.ok(!ensureChatProjection().selectedBranchIds.includes(b1.id), '删除走向后应该同步从选中列表里移除');
});

test('generateChatStages：至少选中一个走向才能推演；只带选中的走向，整体替换旧结果，并落盘', async () => {
    installLiveST({
        mockFn: (text) => {
            if (text.includes('分阶段剧情')) {
                assert.match(text, /走向一：旧情复燃/, '应该带上选中的走向');
                assert.doesNotMatch(text, /走向二：身份暴露/, '不应该带上没被选中的走向');
                assert.match(text, /夜色降临，他推门而入，一眼就看到了你/, '应该带上角色卡当前内容');
                return JSON.stringify([
                    { title: '阶段一：重逢', content: '两人在酒吧偶遇，气氛微妙。' },
                    { title: '阶段二：试探', content: '双方旁敲侧击，试图摸清对方近况。' },
                ]);
            }
            return '（不应该走到这里）';
        },
    });

    const b1 = await addChatBranch({ title: '走向一：旧情复燃', summary: '两人重逢，过去的纠葛浮出水面。' });
    await addChatBranch({ title: '走向二：身份暴露', summary: '{{user}} 的真实身份被发现。' });

    await assert.rejects(() => generateChatStages(settings()), /请先至少选择一个剧情走向/);

    await setSelectedChatBranches([b1.id]);
    const stages = await generateChatStages(settings(), { instruction: '节奏慢一点' });
    assert.equal(stages.length, 2);
    assert.equal(stages[1].title, '阶段二：试探');
    assert.ok(ensureChatProjection().stagesUpdatedAt > 0);

    const s = await addChatStage({ title: '手动补充', content: '补充内容' });
    assert.equal(ensureChatProjection().stages.length, 3);
    await updateChatStage(s.id, { content: '改过的内容' });
    assert.equal(ensureChatProjection().stages.find((x) => x.id === s.id).content, '改过的内容');
    await removeChatStage(s.id);
    assert.equal(ensureChatProjection().stages.length, 2);
});

test('chatDeductionMarkdown：标题带角色名，走向标注是否选中，阶段按顺序编号', async () => {
    installLiveST({ mockFn: () => '' });
    const b1 = await addChatBranch({ title: '走向一', summary: '概要一' });
    await addChatBranch({ title: '走向二', summary: '概要二' });
    await setSelectedChatBranches([b1.id]);
    await addChatStage({ title: '阶段一', content: '内容一' });
    await addChatStage({ title: '阶段二', content: '内容二' });

    const md = chatDeductionMarkdown();
    assert.match(md, /# 江酒 · 当前对话剧情推演/);
    assert.match(md, /- ✅ \*\*走向一\*\*：概要一/);
    assert.match(md, /- \*\*走向二\*\*：概要二/);
    assert.doesNotMatch(md, /✅ \*\*走向二\*\*/);
    assert.match(md, /### 1\. 阶段一/);
    assert.match(md, /### 2\. 阶段二/);
});

test('世界书扫描的入参：传"名字: 内容"字符串数组、最新的在最前面、不含系统消息（和酒馆自己调用时一致）', async () => {
    const { wiCalls } = installLiveST({
        mockFn: () => JSON.stringify([{ title: 'A', summary: 'a' }, { title: 'B', summary: 'b' }]),
        chat: [
            { name: '江酒', mes: '第一句' },
            { name: '系统', is_system: true, mes: '不该传' },
            { name: '你', mes: '第二句' },
        ],
        worldInfo: '某条世界书',
    });
    await generateChatBranches(settings(), { directions: ['', ''] });
    assert.equal(wiCalls.length, 1);
    assert.deepEqual(wiCalls[0], ['你: 第二句', '江酒: 第一句']);
});
