// 剧情推演测试：根据角色卡当前内容 + 背景资料生成并列走向，选定后推演分阶段发展
import test from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_SETTINGS } from '../src/constants.js';
import { mergeDefaults, uid } from '../src/utils.js';
import { createProject, normalizeCharacter, normalizeProject } from '../src/project.js';
import {
    addBranch, addBranchTemplate, addStage, branchTemplates, deductionMarkdown, ensureProjection, generateBranches,
    generateStages, removeBranch, removeBranchTemplate, removeStage, setSelectedBranches, updateBranch,
    updateBranchTemplate, updateStage,
} from '../src/deduce.js';

function settings() {
    const s = mergeDefaults({}, DEFAULT_SETTINGS);
    s.api.retryBaseMs = 200;
    s.api.retries = 0;
    return s;
}

function project() {
    const p = createProject({ name: '测试' });
    p.chunks = [0, 1, 2].map((i) => ({ id: `c${i}`, title: `第${i + 1}章`, content: '', charCount: 100, end: 100, status: 'done' }));
    p.characters['江酒'] = normalizeCharacter({ name: '江酒', importance: 'main', firstChunk: 0, lastChunk: 2, chunksSeen: [0, 1, 2] });
    return normalizeProject(p);
}

function card(charName, data = {}) {
    return {
        id: uid('card_'),
        charName,
        kind: 'character',
        timepoint: Infinity,
        requirement: '',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        data: {
            name: charName, description: '基本信息', personality: '油嘴滑舌', scenario: '酒吧',
            first_mes: '夜色降临，他推门而入，一眼就看到了你。', alternate_greetings: [], mes_example: '',
            system_prompt: '', post_history_instructions: '', creator_notes: '', tags: [],
            ...data,
        },
        lint: [],
        stAvatar: '',
        worldName: '',
    };
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

test('ensureProjection：首次访问自动补齐结构，重复调用不覆盖已有数据', () => {
    const c = card('江酒');
    const pp = ensureProjection(c);
    assert.deepEqual(pp.branches, []);
    assert.deepEqual(pp.selectedBranchIds, []);
    assert.deepEqual(pp.stages, []);
    addBranch(c, { title: '走向一', summary: '概要一' });
    assert.equal(ensureProjection(c).branches.length, 1, '不应该重置已有数据');
});

test('generateBranches：基于角色卡当前实际内容（而不是原始提取档案）生成并列走向，捎带额外要求，清空旧的选中状态', async () => {
    const p = project();
    const c = card('江酒');
    c.plotProjection = { branches: [], selectedBranchIds: ['stale-id'], stages: [], branchesUpdatedAt: 0, stagesUpdatedAt: 0 };

    installST((text) => {
        if (text.includes('方向要求')) {
            assert.match(text, /夜色降临，他推门而入，一眼就看到了你/, '应该把卡片当前的 first_mes 带给 AI');
            assert.match(text, /整体额外要求（对每条走向都适用）：多一点悬疑感/, '应该把用户的额外要求带上');
            return JSON.stringify([
                { title: '走向一：旧情复燃', summary: '两人重逢，过去的纠葛浮出水面。' },
                { title: '走向二：身份暴露', summary: '{{user}} 的真实身份被发现，关系骤变。' },
                { title: '走向三：外敌入侵', summary: '酒吧遭遇意外事件，两人被迫联手。' },
            ]);
        }
        return '（不应该走到这里）';
    });

    const branches = await generateBranches(p, settings(), c, { instruction: '多一点悬疑感' });
    assert.equal(branches.length, 3);
    assert.equal(new Set(branches.map((b) => b.id)).size, 3, 'id 应该互不相同');
    assert.equal(branches[0].title, '走向一：旧情复燃');
    assert.equal(c.plotProjection.selectedBranchIds.length, 0, '重新生成走向后，旧的选中状态应该被清空');
    assert.ok(c.plotProjection.branchesUpdatedAt > 0);
});

test('generateBranches：干预走向——每条走向可以单独写方向提示，留空的槽位不限方向，数量由 directions 决定', async () => {
    const p = project();
    const c = card('江酒');

    installST((text) => {
        if (text.includes('方向要求')) {
            assert.match(text, /1\. 两人旧情复燃/, '应该把第一条的方向提示带上');
            assert.match(text, /2\. （不限方向，由你自由发挥，但要和其他几条有明显区别）/, '空槽位应该渲染成“不限方向”的提示');
            return JSON.stringify([
                { title: '走向一：旧情复燃', summary: '两人重逢。' },
                { title: '走向二：随机发挥', summary: '随便怎样都行。' },
            ]);
        }
        return '（不应该走到这里）';
    });

    const branches = await generateBranches(p, settings(), c, { directions: ['两人旧情复燃', ''] });
    assert.equal(branches.length, 2, '走向数量应该等于 directions 的长度，而不是默认的 DEFAULT_BRANCH_COUNT');
});

test('branchTemplates：增删改与校验——保存的是方向提示，不是生成好的走向', () => {
    const s = settings();
    assert.deepEqual(branchTemplates(s), []);

    assert.throws(() => addBranchTemplate(s, { label: '' }), /请输入模板名称/);

    const t1 = addBranchTemplate(s, { label: '反目成仇', hint: '两人因为一个误会彻底决裂' });
    assert.equal(t1.label, '反目成仇');
    assert.equal(t1.hint, '两人因为一个误会彻底决裂');
    assert.ok(t1.id);

    assert.throws(() => addBranchTemplate(s, { label: '反目成仇', hint: '随便什么' }), /已存在同名的模板/);

    const t2 = addBranchTemplate(s, { label: '身份暴露' }); // 不传 hint 时退化为用 label 当提示
    assert.equal(t2.hint, '身份暴露');

    assert.equal(branchTemplates(s).length, 2);

    updateBranchTemplate(s, t1.id, { hint: '误会升级，两人当众决裂' });
    assert.equal(branchTemplates(s).find((t) => t.id === t1.id).hint, '误会升级，两人当众决裂');

    assert.equal(updateBranchTemplate(s, 'no-such-id', { hint: 'x' }), null);

    assert.ok(removeBranchTemplate(s, t1.id));
    assert.equal(branchTemplates(s).length, 1);
    assert.equal(removeBranchTemplate(s, 'no-such-id'), false);
});

test('走向的增删改；setSelectedBranches 过滤掉不存在的 id', () => {
    const c = card('江酒');
    const b1 = addBranch(c, { title: 'A', summary: 'a' });
    const b2 = addBranch(c, { title: 'B', summary: 'b' });
    assert.equal(c.plotProjection.branches.length, 2);

    updateBranch(c, b1.id, { title: 'A2' });
    assert.equal(c.plotProjection.branches.find((x) => x.id === b1.id).title, 'A2');

    setSelectedBranches(c, [b1.id, b2.id, 'no-such-id']);
    assert.deepEqual(c.plotProjection.selectedBranchIds.sort(), [b1.id, b2.id].sort(), '不存在的 id 应该被过滤掉');

    removeBranch(c, b1.id);
    assert.equal(c.plotProjection.branches.length, 1);
    assert.ok(!c.plotProjection.selectedBranchIds.includes(b1.id), '删除走向后应该同步从选中列表里移除');
});

test('generateStages：至少选中一个走向才能推演；基于选中的走向生成分阶段推演，整体替换旧结果', async () => {
    const p = project();
    const c = card('江酒');
    const b1 = addBranch(c, { title: '走向一：旧情复燃', summary: '两人重逢，过去的纠葛浮出水面。' });
    addBranch(c, { title: '走向二：身份暴露', summary: '{{user}} 的真实身份被发现。' });

    await assert.rejects(() => generateStages(p, settings(), c), /请先至少选择一个剧情走向/);

    setSelectedBranches(c, [b1.id]);
    installST((text) => {
        if (text.includes('分阶段剧情')) {
            assert.match(text, /走向一：旧情复燃/, '应该把选中的走向带给 AI');
            assert.doesNotMatch(text, /走向二：身份暴露/, '不应该带上没被选中的走向');
            assert.match(text, /夜色降临，他推门而入，一眼就看到了你/, '应该把卡片当前内容也带上');
            return JSON.stringify([
                { title: '阶段一：重逢', content: '两人在酒吧偶遇，气氛微妙。' },
                { title: '阶段二：试探', content: '双方旁敲侧击，试图摸清对方近况。' },
                { title: '阶段三：摊牌', content: '积压的情绪爆发，关系迎来转折。' },
            ]);
        }
        return '（不应该走到这里）';
    });
    const stages = await generateStages(p, settings(), c, { instruction: '节奏慢一点' });
    assert.equal(stages.length, 3);
    assert.equal(stages[1].title, '阶段二：试探');
    assert.ok(c.plotProjection.stagesUpdatedAt > 0);

    // 手动增删改
    const s = addStage(c, { title: '手动补充', content: '补充内容' });
    assert.equal(c.plotProjection.stages.length, 4);
    updateStage(c, s.id, { content: '改过的内容' });
    assert.equal(c.plotProjection.stages.find((x) => x.id === s.id).content, '改过的内容');
    removeStage(c, s.id);
    assert.equal(c.plotProjection.stages.length, 3);
});

test('deductionMarkdown：走向标注是否选中，阶段按顺序编号', () => {
    const c = card('江酒');
    const b1 = addBranch(c, { title: '走向一', summary: '概要一' });
    addBranch(c, { title: '走向二', summary: '概要二' });
    setSelectedBranches(c, [b1.id]);
    addStage(c, { title: '阶段一', content: '内容一' });
    addStage(c, { title: '阶段二', content: '内容二' });

    const md = deductionMarkdown(c);
    assert.match(md, /# 江酒 · 剧情推演/);
    assert.match(md, /- ✅ \*\*走向一\*\*：概要一/);
    assert.match(md, /- \*\*走向二\*\*：概要二/);
    assert.doesNotMatch(md, /✅ \*\*走向二\*\*/);
    assert.match(md, /### 1\. 阶段一/);
    assert.match(md, /### 2\. 阶段二/);
});
