// 截图夹具：harness.html?shot=<tab>[&wide=1][&log=1][&dialog=preview]
// 自动导入一本示例小说、提取、规划大纲，然后打开指定页面，供无头浏览器截图（设计回归用）。
// 不带 ?shot 参数时什么也不做，普通冒烟测试不受影响。

const params = new URLSearchParams(location.search);
const tab = params.get('shot');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 20000) {
    const t0 = Date.now();
    while (!fn()) {
        if (Date.now() - t0 > ms) throw new Error('shot-driver timeout');
        await wait(50);
    }
}
const $ = (s) => document.querySelector(s);
const click = (s) => $(s)?.click();
function fill(el, value) {
    el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
}

const NOVEL = [
    '第一卷 下城区',
    '第一章 魔女小姐', '江酒走进酒吧。莉莉丝把一瓶紫色魔药推到他面前。\n'.repeat(25),
    '第二章 女仆', '江酒穿上了女仆装。莉莉丝去参加魔女茶会。\n'.repeat(25),
    '第二卷 学院',
    '第三章 入学', '江酒来到魔女学院，姜小白在门口等他。\n'.repeat(25),
    '第四章 考试', '姜小白在学院考试，江酒在酒吧打工。雨中他走进了那家店。分手的事他没提。\n'.repeat(25),
].join('\n');

/** theme=light：模拟一套亮色酒馆主题，检查界面在亮色主题下是否成立 */
function applyTheme() {
    if (params.get('theme') !== 'light') return;
    const s = document.documentElement.style;
    s.setProperty('--SmartThemeBodyColor', '#2b2b2e');
    s.setProperty('--SmartThemeQuoteColor', '#c0632a');
    s.setProperty('--SmartThemeBlurTintColor', 'rgba(246, 245, 241, 0.97)');
    s.setProperty('--SmartThemeBorderColor', 'rgba(0, 0, 0, 0.14)');
    document.body.style.background = '#e9e7e1';
    document.body.style.color = '#2b2b2e';
}

async function run() {
    applyTheme();
    await until(() => globalThis.NovelLoom && $('#nl-wand-button'));
    document.documentElement.dataset.shot = 'loading';
    await globalThis.NovelLoom.open('project');
    await until(() => $('.nl-window [data-act="paste"]'));
    if (tab !== 'empty') {
        click('[data-act="paste"]');
        await until(() => $('.nl-dialog textarea'));
        fill($('.nl-dialog textarea'), NOVEL);
        [...document.querySelectorAll('.nl-dialog-foot button')].find((b) => b.textContent.includes('确定')).click();
        await until(() => $('#nl-bookname')?.value && $('[data-act="create"]'));
        await wait(300);
        fill($('#nl-bookname'), '魔女');
        fill($('[data-setting="chunking.chunkSize"]'), '1000');
        click('[data-act="create"]');
        await until(() => $('.nl-vol-head'));
        click('.nl-nav-btn[data-tab="extract"]');
        await until(() => $('#nl-tab [data-act="start"]'));
        click('#nl-tab [data-act="start"]');
        await until(() => [...document.querySelectorAll('.nl-log-line')].some((l) => l.textContent.includes('提取结束')), 60000);
        click('.nl-nav-btn[data-tab="plan"]');
        await until(() => $('#nl-tab [data-act="generate"]'));
        fill($('[data-setting="planner.count"]'), '4');
        click('#nl-tab [data-act="generate"]');
        await until(() => document.querySelectorAll('.nl-plan').length >= 4);
    }
    const target = tab === 'empty' ? 'project' : tab;
    click(`.nl-nav-btn[data-tab="${target}"]`);
    await wait(300);
    if (params.get('select')) click(params.get('select'));
    if (params.get('log')) click('[data-act="log-toggle"]');
    if (params.get('dialog')) click(`#nl-tab [data-act="${params.get('dialog')}"]`);
    await wait(400);
    document.documentElement.dataset.shot = 'ready';
}

if (tab) run().catch((e) => {
    document.documentElement.dataset.shot = `error: ${e.message}`;
    console.error('[shot-driver]', e);
});
