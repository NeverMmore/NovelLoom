// 界面细节：叠放对话框时 Esc 只关最上面那个；编辑框里切换状态栏后“绑定世界书名称”写回正确的字段；删除模板后选中哪一个
import test from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_CATEGORIES, DEFAULT_SETTINGS } from '../src/constants.js';
import { mergeDefaults } from '../src/utils.js';
import { createProject } from '../src/project.js';
import { buildChunks, detectChapters } from '../src/splitter.js';
import { defaultWorldName, statusBarWorldName } from '../src/publish.js';
import { ensureStatusBar, normalizeStatusSpec } from '../src/statusbar.js';
import { openDialog } from '../src/ui/common.js';
import { applyCardWorldInput, cardWorldField, cardWorldLabelHtml } from '../src/ui/tab-cards.js';
import { BUILTIN_STATUSBAR_TEMPLATES, addStatusBarTemplate, updateStatusBarTemplate } from '../src/statusbar-templates.js';
import { templateNameProblem } from '../src/ui/statusbar-dialog.js';
import { templateIdAfterDelete, templateVarTagsHtml } from '../src/ui/tab-settings.js';

// ---------------- 极简的假 DOM：只够 openDialog 用 ----------------

class FakeEl {
    constructor(doc, cls = '') {
        this.doc = doc;
        this.className = cls;
        this.style = {};
        this.innerHTML = '';
        this.parent = null;
        this.listeners = {};
        this.kids = new Map(); // 选择器 → 假元素（openDialog 只按固定的选择器取子元素）
    }

    querySelector(sel) {
        if (!this.kids.has(sel)) this.kids.set(sel, new FakeEl(this.doc));
        return this.kids.get(sel);
    }

    appendChild(el) {
        el.parent = this;
        if (this === this.doc.body) this.doc.children.push(el);
        return el;
    }

    remove() {
        const i = this.doc.children.indexOf(this);
        if (i >= 0) this.doc.children.splice(i, 1);
        this.parent = null;
    }

    get isConnected() {
        return this.doc.children.includes(this);
    }

    addEventListener(type, fn) {
        (this.listeners[type] ||= []).push(fn);
    }

    focus() {}
}

class FakeDocument {
    constructor() {
        this.children = []; // body 下的元素，按追加顺序
        this.body = new FakeEl(this);
        this.activeElement = null;
        this.keydown = [];
    }

    createElement() {
        return new FakeEl(this);
    }

    querySelectorAll(sel) {
        assert.equal(sel, '.nl-dialog-overlay');
        return this.children.filter((c) => c.className.split(/\s+/).includes('nl-dialog-overlay'));
    }

    addEventListener(type, fn, capture) {
        if (type === 'keydown' && capture) this.keydown.push(fn);
    }

    removeEventListener(type, fn, capture) {
        if (type === 'keydown' && capture) this.keydown = this.keydown.filter((f) => f !== fn);
    }

    /** 按注册顺序依次调用 document 上的捕获监听（与浏览器一致：派发途中被移除的不再调用；stopPropagation 拦不住同一节点上的其他监听） */
    pressKey(key) {
        const ev = { key, stopped: 0, stopPropagation() { this.stopped++; } };
        for (const fn of [...this.keydown]) {
            if (this.keydown.includes(fn)) fn(ev);
        }
        return ev;
    }
}

const tick = () => new Promise((r) => setTimeout(r, 0));

test('openDialog：叠放两个对话框时 Esc 只关最上面那个，再按一次才关下面的', async () => {
    const doc = new FakeDocument();
    const saved = globalThis.document;
    globalThis.document = doc;
    try {
        const settled = [];
        const a = openDialog({ title: '编辑角色卡', body: '<input>', dismissValue: 'a-dismiss' }).then((r) => settled.push(['a', r.value]));
        const b = openDialog({ title: '状态栏设置', body: '<input>', dismissValue: 'b-dismiss' }).then((r) => settled.push(['b', r.value]));
        assert.equal(doc.querySelectorAll('.nl-dialog-overlay').length, 2);
        const [ovA, ovB] = doc.children;

        const ev1 = doc.pressKey('Escape');
        await tick();
        assert.deepEqual(settled, [['b', 'b-dismiss']], '只关上面的状态栏对话框');
        assert.ok(ovA.isConnected && !ovB.isConnected, '下面的编辑框还在');
        assert.equal(ev1.stopped, 1);
        assert.equal(doc.keydown.length, 1, '关掉的对话框摘掉了自己的监听');

        // 其他键不关
        doc.pressKey('Enter');
        await tick();
        assert.equal(settled.length, 1);

        doc.pressKey('Escape');
        await Promise.all([a, b]);
        assert.deepEqual(settled, [['b', 'b-dismiss'], ['a', 'a-dismiss']]);
        assert.equal(doc.children.length, 0);
        assert.equal(doc.keydown.length, 0);
    } finally {
        globalThis.document = saved;
    }
});

test('openDialog：最上面的不是 openDialog 打开的遮罩时，下面的对话框也不响应 Esc', async () => {
    const doc = new FakeDocument();
    const saved = globalThis.document;
    globalThis.document = doc;
    try {
        let done = false;
        const p = openDialog({ title: 'x', body: '' }).then(() => { done = true; });
        const foreign = new FakeEl(doc, 'nl-dialog-overlay');
        doc.body.appendChild(foreign); // 例如别处直接插进来的遮罩
        doc.pressKey('Escape');
        await tick();
        assert.equal(done, false);
        foreign.remove();
        doc.pressKey('Escape');
        await p;
        assert.equal(done, true);
    } finally {
        globalThis.document = saved;
    }
});

// ---------------- 编辑角色卡：绑定世界书名称写回哪个字段 ----------------

const NOVEL = ['第一章 魔女小姐', '江酒走进酒吧。莉莉丝坐在角落。', '第二章 女仆', '江酒穿上了女仆装。'].join('\n');

function settings() {
    const s = mergeDefaults({}, DEFAULT_SETTINGS);
    s.categories = structuredClone(DEFAULT_CATEGORIES);
    return s;
}

function project() {
    const chunks = detectChapters(NOVEL, '^第.+章.*$').map((ch) => buildChunks([ch], 1000, false)[0]);
    chunks.forEach((c, i) => (c.index = i));
    return createProject({ name: '魔女', text: NOVEL, chunks });
}

function sbCard(s) {
    const c = { id: 'c1', kind: 'character', charName: '莉莉丝', timepoint: null, worldName: '', data: { name: '莉莉丝' } };
    ensureStatusBar(c, s);
    c.statusBar.spec = normalizeStatusSpec({ title: '莉莉丝', variables: [{ path: '莉莉丝.好感度', type: 'number', init: 20, min: 0, max: 100 }] });
    return c;
}

test('cardWorldField：带状态栏的卡显示专用世界书名，其他卡显示 card.worldName 或默认名', () => {
    const s = settings();
    const p = project();
    const c = sbCard(s);
    const f = cardWorldField(p, s, c);
    assert.equal(f.sb, true);
    assert.equal(f.shown, statusBarWorldName(p, s, c));
    assert.match(f.shown, /·莉莉丝$/);
    c.statusBar.enabled = false;
    assert.deepEqual(cardWorldField(p, s, c), { sb: false, shown: defaultWorldName(p, s, null) });
    c.worldName = '自定义';
    assert.deepEqual(cardWorldField(p, s, c), { sb: false, shown: '自定义' });
    assert.match(cardWorldLabelHtml(true), /状态栏卡专用/);
    assert.equal(cardWorldLabelHtml(false), '绑定世界书名称');
});

test('applyCardWorldInput：在编辑框里关掉状态栏后原样保存，不会把状态栏专用世界书名写进 card.worldName', () => {
    const s = settings();
    const p = project();
    const c = sbCard(s);
    const field = cardWorldField(p, s, c); // 打开编辑框时：状态栏开着
    c.statusBar.enabled = false; // 在叠上来的状态栏设置里关掉
    applyCardWorldInput(c, field, field.shown); // 没动这一栏，直接保存
    assert.equal(c.worldName, '', '不能被钉到状态栏专用世界书上');
    assert.equal(c.statusBar.worldName, '', '没改动就不写死');
    assert.equal(cardWorldField(p, s, c).shown, defaultWorldName(p, s, null), '关掉状态栏后照常绑定默认世界书');
});

test('applyCardWorldInput：按显示时的模式写回改过的名字；清空状态栏世界书名 = 回到默认命名', () => {
    const s = settings();
    const p = project();
    const c = sbCard(s);
    let field = cardWorldField(p, s, c);
    applyCardWorldInput(c, field, '  莉莉丝专用  ');
    assert.equal(c.statusBar.worldName, '莉莉丝专用');
    assert.equal(c.worldName, '');
    // 显示的是状态栏专用名、保存前状态栏被关掉：改过的名字仍记在状态栏上（重新打开状态栏时沿用），不碰 card.worldName
    field = cardWorldField(p, s, c);
    c.statusBar.enabled = false;
    applyCardWorldInput(c, field, '另一个名字');
    assert.equal(c.statusBar.worldName, '另一个名字');
    assert.equal(c.worldName, '');
    // 清空 = 回到默认命名
    c.statusBar.enabled = true;
    field = cardWorldField(p, s, c);
    applyCardWorldInput(c, field, '');
    assert.equal(c.statusBar.worldName, '');
    assert.match(cardWorldField(p, s, c).shown, /·莉莉丝$/);
});

test('applyCardWorldInput：显示普通世界书名时写 card.worldName（中途打开了状态栏也一样），不碰状态栏的名字', () => {
    const s = settings();
    const p = project();
    const c = sbCard(s);
    c.statusBar.enabled = false;
    const field = cardWorldField(p, s, c);
    assert.equal(field.sb, false);
    c.statusBar.enabled = true; // 在叠上来的状态栏设置里打开
    applyCardWorldInput(c, field, '魔女·完整');
    assert.equal(c.worldName, '魔女·完整');
    assert.equal(c.statusBar.worldName, '');
    // 没有状态栏的卡
    const plain = { id: 'c2', kind: 'character', charName: '江酒', timepoint: null, worldName: '', data: { name: '江酒' } };
    const f2 = cardWorldField(p, s, plain);
    applyCardWorldInput(plain, f2, f2.shown);
    assert.equal(plain.worldName, defaultWorldName(p, s, null));
    assert.equal(plain.statusBar, undefined);
});

// ---------------- 状态栏模板库：删除后选中哪一个 ----------------

test('templateIdAfterDelete：选中原位置上的下一个，删的是最后一个就选上一个，空了返回空', () => {
    const ids = ['builtin_general', 'builtin_rpg', 'u1', 'u2', 'u3'];
    const after = (del) => ids.filter((x) => x !== del);
    assert.equal(templateIdAfterDelete(ids, 'u1', after('u1')), 'u2');
    assert.equal(templateIdAfterDelete(ids, 'u2', after('u2')), 'u3');
    assert.equal(templateIdAfterDelete(ids, 'u3', after('u3')), 'u2');
    assert.equal(templateIdAfterDelete(['u1'], 'u1', []), '');
    assert.equal(templateIdAfterDelete(ids, 'gone', ids), 'builtin_general');
    // 删除后列表顺序变了也不出错
    assert.equal(templateIdAfterDelete(['a', 'b', 'c'], 'b', ['c', 'a']), 'a');
});

// ---------------- 状态栏模板库：与状态栏对话框同一口径 ----------------

test('templateVarTagsHtml：变量数与对话框同一口径（记录的每个字段各算一个），超过上限时加警告标签；没有变量表时说明只有界面', () => {
    const spec = normalizeStatusSpec({
        variables: [
            { path: '世界.地点', type: 'string', init: '' },
            { path: '主角.物品', type: 'record', value: { type: 'object', fields: [{ key: '数量', type: 'number' }, { key: '描述', type: 'string' }] }, init: {} },
        ],
    });
    const html = templateVarTagsHtml({ spec }, 12);
    assert.match(html, /3 个变量（记录的每个字段各算一个）/);
    assert.doesNotMatch(html, /超过上限/);
    assert.match(templateVarTagsHtml({ spec }, 2), /nl-warn[^>]*>超过上限 2</);
    assert.match(templateVarTagsHtml({ spec: null }, 12), /只有界面，没有变量表/);
    // 模板自带更大的上限（「多人群像」15 个变量、自带上限 15）：不标「超过上限 12」，改标「自带上限 15」；设置上限够用时什么都不加
    const ens = BUILTIN_STATUSBAR_TEMPLATES.find((t) => t.id === 'builtin_ensemble');
    const tags = templateVarTagsHtml(ens, 12);
    assert.match(tags, /15 个变量/);
    assert.doesNotMatch(tags, /超过上限/);
    assert.match(tags, /<span class="nl-tag" title="[^"]*">自带上限 15</);
    assert.doesNotMatch(templateVarTagsHtml(ens, 20), /上限/);
    assert.match(templateVarTagsHtml({ ...ens, maxVars: 13 }, 12), /nl-warn[^>]*>超过上限 13</, '自带上限也不够时仍提示会丢弃');
});

test('设置页改模板名用 templateNameProblem：空白不同、大小写不同的重名也拦下（与 updateStatusBarTemplate 的检查一致）', () => {
    const s = mergeDefaults({}, DEFAULT_SETTINGS);
    const a = addStatusBarTemplate(s, { name: '雨夜 Mode', mode: 'auto', spec: { variables: [{ path: 'a.b', type: 'string' }] } });
    const b = addStatusBarTemplate(s, { name: '另一个', mode: 'auto', spec: { variables: [{ path: 'a.b', type: 'string' }] } });
    const typed = '  雨夜   mode ';
    assert.match(templateNameProblem(s, typed, b.id), /已有同名的模板「雨夜 Mode」/);
    assert.throws(() => updateStatusBarTemplate(s, b.id, { name: typed }), /同名/, '保存时同样会被拒绝，所以必须在对话框里先拦下');
    assert.equal(templateNameProblem(s, typed, a.id), '', '改自己的名字（只改了空白和大小写）可以');
});
