// 重roll 相关测试：角色卡单字段重新生成、续写章节整章重新生成
import test from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_SETTINGS } from '../src/constants.js';
import { mergeDefaults, uid } from '../src/utils.js';
import { createProject, normalizeCharacter, normalizeProject } from '../src/project.js';
import { generateCard, regenerateCardField } from '../src/cards.js';
import { regenerateChapter } from '../src/continue.js';

function settings() {
    const s = mergeDefaults({}, DEFAULT_SETTINGS);
    s.api.retryBaseMs = 200;
    s.api.retries = 0;
    return s;
}

function project() {
    const p = createProject({ name: '测试' });
    p.chunks = [0, 1, 2].map((i) => ({ id: `c${i}`, title: `第${i + 1}章`, content: '', charCount: 100, end: 100, status: 'done' }));
    const mk = (name, extra = {}) => normalizeCharacter({ name, importance: 'main', firstChunk: 0, lastChunk: 2, chunksSeen: [0, 1, 2], ...extra });
    p.characters['江酒'] = mk('江酒');
    p.characters['莉莉丝'] = mk('莉莉丝', { identity: '大魔女' });
    return normalizeProject(p);
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

test('regenerateCardField：只替换目标字段，其余字段与 lint 保持一致；能捎带额外指令', async () => {
    const p = project();
    installST((text) => {
        // 单字段重roll 的提示词会把整卡提示词（含“字段写法”）当作背景资料一起带上，
        // 所以更具体的“重新生成「xxx」”标记要先判断，否则会被下面更宽的“字段写法”分支提前捕获。
        if (text.includes('重新生成「开场白」')) {
            assert.match(text, /原始开场白/, '应该把当前内容带给 AI 作参考');
            return '重roll 后的新开场白';
        }
        if (text.includes('重新生成「备选开场白」')) {
            assert.match(text, /条备选开场白/, '应该提示保持条数与分隔格式');
            return '备选甲甲\n=====\n备选乙乙';
        }
        if (text.includes('字段写法')) {
            return JSON.stringify({
                name: '江酒', description: '基本信息', personality: '油嘴滑舌', scenario: '酒吧',
                first_mes: '原始开场白', alternate_greetings: ['备选甲'], mes_example: ['{{user}}: 嗨\n{{char}}: 嗨'], tags: ['渣男'],
            });
        }
        return '（不应该走到这里）';
    });
    const s = settings();
    const card = await generateCard(p, s, { kind: 'character', charName: '江酒', timepoint: Infinity });
    assert.equal(card.data.first_mes, '原始开场白');
    const before = card.updatedAt;

    await new Promise((r) => setTimeout(r, 2));
    await regenerateCardField(p, s, card, 'first_mes', { instruction: '' });
    assert.equal(card.data.first_mes, '重roll 后的新开场白');
    assert.equal(card.data.description, '基本信息', '没有重roll 的字段应该原样保留');
    assert.ok(card.updatedAt > before);

    await regenerateCardField(p, s, card, 'alternate_greetings');
    assert.deepEqual(card.data.alternate_greetings, ['备选甲甲', '备选乙乙']);

    await assert.rejects(() => regenerateCardField(p, s, card, 'tags'), /不支持重新生成/);
});

test('regenerateChapter：整章重roll 沿用原编号/标题，替换正文；已回灌的分段同步标记为待重提', async () => {
    const p = project();
    p.continuation.chapters.push({ id: 'ch1', no: 1, title: '第1章 旧标题', content: '旧正文'.repeat(50), direction: '旧方向', createdAt: Date.now(), chunkId: 'gc1', planId: '' });
    p.chunks.push({ id: 'gc1', index: 3, title: '第1章 旧标题', chapterTitles: ['第1章 旧标题'], content: '旧正文'.repeat(50), charCount: 150, start: 0, end: 150, origin: 'generated', status: 'done', error: '', attempts: 1, outline: [], important: [], processedAt: Date.now() });

    installST((text) => {
        assert.match(text, /第1章 旧标题/, '应该沿用原来的章节标题续写');
        return '第1章 旧标题\n\n' + '全新的正文内容。'.repeat(40);
    });
    const s = settings();
    const ch = await regenerateChapter(p, s, 'ch1', {});
    assert.match(ch.content, /全新的正文内容/);
    assert.equal(ch.direction, '旧方向');
    const chunk = p.chunks.find((c) => c.id === 'gc1');
    assert.equal(chunk.status, 'pending', '已回灌过的分段应该标记为待重新提取，而不是静默重复提取逻辑');
    assert.match(chunk.content, /全新的正文内容/);

    await assert.rejects(() => regenerateChapter(p, s, 'no-such-id', {}), /章节不存在/);
});
