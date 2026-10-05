# 浏览器冒烟测试（AI 推断名称）：大纲页「待确认名称」→ 选项对话框 → 每条几个候选（原文 / 已有 / AI 起名）、
# 把握大的自动填入、手动填写的不动；点选/再点取消、空行都填第一个、换一批（带上不要再给的名称、保留已填写的）、
# 编辑输入框变成手动；替换前确认 AI 起名/自动填入的名称，替换进世界书与角色档案并快照；中等宽度与窄屏布局；
# 推断进行中：焦点移到「停止」、结束后回到发起的按钮、不能替换、输入法拼写和末尾空格不被打断、忽略行后进度不串行；
# 推断途中切换项目（已完成的存进原项目、之后不再写）、删除项目（不会被写回来）
import json, os, subprocess, sys, time
from playwright.sync_api import sync_playwright

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
OUT = sys.argv[1] if len(sys.argv) > 1 else '/tmp/nl-names'
os.makedirs(OUT, exist_ok=True)
PORT = 8781
server = subprocess.Popen([sys.executable, '-m', 'http.server', str(PORT), '--bind', '127.0.0.1'], cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1)

errors = []

def shot(page, name):
    # 对话框有淡入动画：等它完全显示再截图
    page.wait_for_function('() => [...document.querySelectorAll(".nl-dialog-overlay, .nl-dialog")].every((d) => getComputedStyle(d).opacity === "1")')
    page.screenshot(path=os.path.join(OUT, name + '.png'))

def wait_log(page, text, timeout=30000):
    page.wait_for_function('(t) => [...document.querySelectorAll(".nl-log-line")].some(l => l.textContent.includes(t))', arg=text, timeout=timeout)

def ev(page, js, arg=None):
    return page.evaluate(js, arg) if arg is not None else page.evaluate(js)

def mn(page, i):
    return ev(page, '(i) => { const m = NovelLoom.app.project.missingNames[i]; return m && { resolved: m.resolved || "", by: m.resolvedBy || "", cands: (m.ai?.candidates || []).map((c) => [c.name, c.source, c.confidence]), reason: m.ai?.reason || "", seen: m.ai?.seen || [] }; }', i)

def chips(page, i):
    """某一行的候选按钮：[名称, 徽标, 是否选中, class]"""
    return ev(page, '''(i) => [...document.querySelectorAll(`[data-mn-row="${i}"] [data-act="mn-pick"]`)].map((b) => [
        b.querySelector(".nl-mn-cand-name").textContent, b.querySelector(".nl-mn-src").textContent, b.getAttribute("aria-pressed"), b.className])''', i)

def row_text(page, i):
    return page.inner_text(f'[data-mn-row="{i}"]')

def by_tag(page, i):
    return page.inner_text(f'[data-mn-by="{i}"]').strip()

def names_prompts(page):
    return ev(page, '(window.__prompts || []).filter((t) => t.includes("推断具体名称"))')

# 模拟 AI：按条目给不同的候选；同一条第二次被问到（换一批）时给新的一批
MOCK = r'''() => {
    window.__namesCalls = {};
    const table = (v, n) => {
        if (v === '那家店' && n === 1) return { vague: v, candidates: [
            { name: '月下酒馆', source: 'text', confidence: 'high', reason: '第三章的招牌上写着店名', evidence: '挂出了招牌：月下酒馆' },
            { name: '下城区', source: 'existing', confidence: 'medium', reason: '店开在下城区' },
            { name: '星辉亭', source: 'invented', confidence: 'medium', reason: '按本书地名的风格起的' } ] };
        if (v === '那家店') return { vague: v, candidates: [
            { name: '月影酒馆', source: 'invented', confidence: 'medium', reason: '换一批：和店的气氛相符' },
            { name: '夜灯小馆', source: 'invented', confidence: 'low', reason: '换一批：只是猜测' } ] };
        if (v === '那位大人') return { vague: v, candidates: [
            { name: '莉莉丝', source: 'existing', confidence: 'medium', reason: '茶会的主人是莉莉丝' },
            { name: '夜之女王', source: 'invented', confidence: 'medium', reason: '符合“大人”的称呼' },
            { name: '暗月', source: 'invented', confidence: 'low', reason: '只是猜测' } ] };
        if (v === '那件东西') return { vague: v, reason: '原文片段里没有任何关于它的描述', candidates: [] };
        if (v === '那座城') return { vague: v, candidates: [
            { name: '白塔城', source: 'invented', confidence: 'medium', reason: '按本书的命名风格' },
            { name: '灰烬城', source: 'invented', confidence: 'low', reason: '只是猜测' } ] };
        return { vague: v, candidates: [{ name: '忘川', source: 'text', confidence: 'high', reason: '不该被问到' }] };
    };
    window.__namesMock = (prompt) => {
        const out = [];
        for (const b of prompt.split(/^## \d+\. /m).slice(1)) {
            const v = (b.match(/^「([^」]+)」/) || [])[1];
            if (!v) continue;
            const n = (window.__namesCalls[v] = (window.__namesCalls[v] || 0) + 1);
            out.push(table(v, n));
        }
        const text = '好的，推断结果如下：\n```json\n' + JSON.stringify(out, null, 1) + '\n```';
        // __namesGate：回复先挂起，测试里调用 __releaseNames() 才放出最早的一个（测试进度、停止、推断途中输入、切换项目）
        if (window.__namesGate) return new Promise((r) => window.__namesWaiters.push(() => r(text)));
        return text;
    };
    window.__namesWaiters = [];
    window.__releaseNames = () => { const w = window.__namesWaiters.shift(); if (w) w(); return !!w; };
}'''

def focused(page):
    """当前焦点：[data-act, data-i, data-mn]"""
    return ev(page, '() => { const a = document.activeElement; return a && [a.dataset?.act || "", a.dataset?.i || "", a.dataset?.mn ?? ""]; }')

def overflow(page):
    return ev(page, '''() => {
        const sec = document.querySelector('section[data-sec="names"]');
        const main = sec.closest('.nl-main') || document.scrollingElement;
        const right = sec.getBoundingClientRect().right;
        const bad = [...sec.querySelectorAll('*')].filter((e) => e.getBoundingClientRect().right > right + 1).map((e) => e.className || e.tagName);
        return { secOverflow: sec.scrollWidth - sec.clientWidth, mainOverflow: main.scrollWidth - main.clientWidth, bad: bad.slice(0, 5) };
    }''')

def push_rows(page, vagues):
    ev(page, '''(vs) => { const p = NovelLoom.app.project;
        for (const v of vs) p.missingNames.push({ type: '地名类', vague: v, context: v, suggest: '', chunk: 0, resolved: '' });
        NovelLoom.app.events.emit('names:progress'); }''', vagues)

def release(page):
    """放出最早挂起的一次 AI 回复（先等请求真的发出来）"""
    page.wait_for_function('() => window.__namesWaiters.length > 0')
    return ev(page, 'window.__releaseNames()')

def store(page, js, arg):
    return ev(page, 'async (a) => { const s = await import("/src/store.js"); return (' + js + ')(s, a); }', arg)

SETUP = r'''async () => {
    const { createProject, normalizeCharacter } = await import('/src/project.js');
    const mk = (title, line, n) => ({ id: 'c' + title, title, content: (line + '\n').repeat(n), origin: 'source', status: 'done', outline: [], important: [] });
    const p = createProject({ name: '魔女', chunks: [
        mk('第一章 雨夜', '姜小白在雨中迷路，走进了那家店。江酒在那家店里擦杯子。', 3),
        mk('第二章 茶会', '莉莉丝去参加魔女茶会，那位大人也在。听说那件东西被藏在那座城里。', 3),
        mk('第三章 招牌', '很久以后，那家店挂出了招牌：月下酒馆。江酒沿着那条河走回家。', 3),
    ] });
    p.characters['江酒'] = normalizeCharacter({ name: '江酒', aliases: ['小酒'], identity: '在那家店打工的女仆', importance: 'main', chunksSeen: [0, 1, 2], firstChunk: 0, lastChunk: 2 });
    p.characters['莉莉丝'] = normalizeCharacter({ name: '莉莉丝', identity: '大魔女', relationship: '在茶会上见到那位大人', importance: 'main', chunksSeen: [1], firstChunk: 1, lastChunk: 1 });
    p.worldbook = {
        地点: { 下城区: { name: '下城区', keywords: ['下城区'], content: '那家店就开在下城区。', revisions: [], sourceChunks: [0] } },
        势力: { 魔女会: { name: '魔女会', keywords: ['魔女会'], content: '魔女会的据点在那座城。', revisions: [], sourceChunks: [1] } },
    };
    p.outline.summary = '江酒被莉莉丝变成女仆，在下城区的一家店里打工。';
    p.missingNames = [
        { type: '地名类', vague: '那家店', context: '走进了那家店', suggest: '莉莉丝酒吧', chunk: 0, resolved: '' },
        { type: '角色名类', vague: '那位大人', context: '那位大人也在', suggest: '', chunk: 1, resolved: '' },
        { type: '专有名词类', vague: '那件东西', context: '那件东西被藏在那座城里', suggest: '', chunk: 1, resolved: '' },
        { type: '地名类', vague: '那条河', context: '沿着那条河走回家', suggest: '', chunk: 2, resolved: '' },
        { type: '地名类', vague: '那座城', context: '藏在那座城里', suggest: '', chunk: 1, resolved: '' },
    ];
    NovelLoom.app.setProject(p);
    await NovelLoom.app.saveNow();
}'''

try:
    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        page = browser.new_page(viewport={'width': 1360, 'height': 900})
        page.on('pageerror', lambda e: errors.append('pageerror: ' + str(e)))
        page.on('console', lambda m: errors.append('console: ' + m.text) if m.type == 'error' else None)
        page.goto(f'http://127.0.0.1:{PORT}/tests/browser/harness.html')
        page.wait_for_selector('#nl-wand-button')
        ev(page, MOCK)
        ev(page, SETUP)
        page.evaluate("NovelLoom.open('outline')")
        page.wait_for_selector('section[data-sec="names"]')
        assert page.locator('[data-mn-row]').count() == 5
        assert page.is_hidden('[data-act="mn-fill-top"]'), '还没有候选时不显示「空行都填第一个候选」'
        assert page.locator('[data-act="mn-ai"]').count() == 1 and 'nl-reroll' in page.get_attribute('[data-act="mn-ai"]', 'class')

        # ---- 先手动填一行：之后 AI 推断不会动它 ----
        page.fill('[data-mn="3"]', '银河')
        assert mn(page, 3)['by'] == 'user' and by_tag(page, 3) == '手动', (mn(page, 3), by_tag(page, 3))
        shot(page, '01-before')

        # ---- 选项对话框 ----
        page.click('[data-act="mn-ai"]')
        page.wait_for_selector('.nl-dialog[aria-label="AI 推断名称"]')
        dlg = page.inner_text('.nl-dialog-body')
        print('dialog:', dlg.replace('\n', ' | '))
        assert '只推断还没推断过、也还没填写的（4 条）' in dlg and '全部重新推断（4 条，不动你手动填写或点选的）' in dlg, dlg
        assert page.is_checked('input[name="nl-mn-scope"][value="new"]')
        assert page.input_value('[data-f="count"]') == '4'
        assert page.is_checked('input[name="nl-mn-fill"][value="confident"]')
        assert page.is_checked('[data-f="invent"]')
        assert '将推断 4 条，分 1 次请求' in dlg
        shot(page, '02-options-dialog')
        # 提示词预览：叠在选项对话框上，关掉后选项对话框还在
        page.click('[data-mn-preview]')
        page.wait_for_selector('.nl-dialog[aria-label="推断名称提示词预览"]')
        pv = page.inner_text('.nl-dialog[aria-label="推断名称提示词预览"]')
        assert '推断具体名称' in pv and '「那家店」' in pv and '月下酒馆' in pv and '「那条河」' not in pv, pv[:400]
        assert '- 江酒（别名：小酒）' in pv and '下城区' in pv
        shot(page, '03-prompt-preview')
        page.keyboard.press('Escape')
        page.wait_for_selector('.nl-dialog[aria-label="推断名称提示词预览"]', state='detached')
        assert page.locator('.nl-dialog[aria-label="AI 推断名称"]').count() == 1, 'Esc 只关掉最上面的预览'
        page.click('.nl-dialog-foot button:has-text("开始推断")')
        wait_log(page, 'AI 推断名称：')
        page.wait_for_selector('[data-act="mn-ai"]:not([disabled])')
        log = ev(page, '[...document.querySelectorAll(".nl-log-line")].map((l) => l.textContent).filter((t) => t.includes("AI 推断名称：")).pop()')
        print('log:', log)
        assert '4 条中 3 条有候选' in log and '自动填入 1 条' in log and '1 条没找到' in log, log
        prompts = names_prompts(page)
        assert len(prompts) == 1, len(prompts)
        assert '「那条河」' not in prompts[0], '手动填写的行不发给 AI'
        assert ev(page, 'NovelLoom.app.settings.nameResolve.count') == 4

        # ---- 结果：候选按钮与徽标、自动填入、没找到、手动的不动 ----
        c0 = chips(page, 0)
        print('row0 chips:', [c[:3] for c in c0])
        assert [c[:3] for c in c0] == [['月下酒馆', '原文', 'true'], ['下城区', '已有', 'false'], ['星辉亭', 'AI 起名', 'false']], c0
        assert page.input_value('[data-mn="0"]') == '月下酒馆' and mn(page, 0)['by'] == 'ai' and by_tag(page, 0) == 'AI 填入'
        assert '挂出了招牌：月下酒馆' in page.inner_text('[data-mn-why="0"]'), '选中候选的理由与原文证据直接显示（触屏也能看到）'
        assert '挂出了招牌' in page.get_attribute('[data-mn-row="0"] [data-c="0"]', 'title')
        c1 = chips(page, 1)
        assert [c[:3] for c in c1] == [['莉莉丝', '已有', 'false'], ['夜之女王', 'AI 起名', 'false'], ['暗月', 'AI 起名', 'false']], c1
        assert 'nl-conf-low' in c1[2][3] and 'nl-conf-low' not in c1[0][3]
        assert page.input_value('[data-mn="1"]') == '' and mn(page, 1)['by'] == '', '把握不大的不自动填'
        assert chips(page, 2) == [] and '没找到合适的名称：原文片段里没有任何关于它的描述' in row_text(page, 2)
        assert page.input_value('[data-mn="3"]') == '银河' and mn(page, 3) == {'resolved': '银河', 'by': 'user', 'cands': [], 'reason': '', 'seen': []}
        assert '换一批' in row_text(page, 0) and 'AI 推断' in row_text(page, 3)
        assert page.is_visible('[data-act="mn-fill-top"]')
        # AI 填入还没确认：不用悬停也能看到怎么确认；输入框关联来源标记（读屏能听到）
        assert 'AI 自动填入，点高亮的候选确认' in page.inner_text('[data-mn-why="0"]')
        assert page.get_attribute('[data-mn="0"]', 'aria-describedby') == 'nl-mn-by-0' and page.inner_text('#nl-mn-by-0').strip() == 'AI 填入'
        assert focused(page)[0] == 'mn-ai', ('推断结束后焦点回到发起的按钮', focused(page))
        shot(page, '04-candidates')

        # ---- 点选 / 再点取消 ----
        page.click('[data-mn-row="1"] [data-c="1"]')
        assert page.input_value('[data-mn="1"]') == '夜之女王' and mn(page, 1)['by'] == 'pick' and by_tag(page, 1) == '已选'
        assert [c[2] for c in chips(page, 1)] == ['false', 'true', 'false']
        assert '符合“大人”的称呼' in page.inner_text('[data-mn-why="1"]')
        assert ev(page, 'document.activeElement?.dataset.c') == '1', '点选后焦点留在候选上'
        shot(page, '05-picked')
        page.click('[data-mn-row="1"] [data-c="1"]')
        assert page.input_value('[data-mn="1"]') == '' and mn(page, 1)['by'] == '' and by_tag(page, 1) == ''
        assert [c[2] for c in chips(page, 1)] == ['false', 'false', 'false']
        # 键盘也能选：Tab 到候选上按空格
        page.focus('[data-mn-row="1"] [data-c="0"]')
        page.keyboard.press('Space')
        assert page.input_value('[data-mn="1"]') == '莉莉丝'
        page.keyboard.press('Space')
        assert page.input_value('[data-mn="1"]') == ''
        # 输入的正好是某个候选：它显示为选中，但算手动
        page.fill('[data-mn="1"]', '暗月')
        assert [c[2] for c in chips(page, 1)] == ['false', 'false', 'true'] and by_tag(page, 1) == '手动'
        page.fill('[data-mn="1"]', '')

        # ---- 空行都填第一个候选 ----
        page.click('[data-act="mn-fill-top"]')
        wait_log(page, '个空行填上第一个候选')
        assert mn(page, 1)['resolved'] == '莉莉丝' and mn(page, 1)['by'] == 'ai'
        assert mn(page, 4)['resolved'] == '白塔城' and mn(page, 4)['by'] == 'ai'
        assert mn(page, 2)['resolved'] == '', '没有候选的行不填'
        assert page.is_hidden('[data-act="mn-fill-top"]')
        # 编辑输入框：变成手动
        page.fill('[data-mn="1"]', '莉莉丝大人')
        assert mn(page, 1)['by'] == 'user' and by_tag(page, 1) == '手动' and [c[2] for c in chips(page, 1)] == ['false', 'false', 'false']
        # 点 AI 填入的那个候选 = 确认（变成已选）；选中状态不变，所以给读屏播报一句
        page.click('[data-mn-row="4"] [data-c="0"]')
        assert mn(page, 4)['by'] == 'pick' and by_tag(page, 4) == '已选' and page.input_value('[data-mn="4"]') == '白塔城'
        page.wait_for_function('() => document.querySelector("[data-mn-live]")?.textContent === "已确认「白塔城」"')
        assert page.get_attribute('[data-mn-live]', 'role') == 'status'

        # ---- 换一批（键盘发起）：带上之前的候选，换掉候选、保留已填写的值，它对应的旧候选仍在最前面 ----
        page.focus('[data-act="mn-reroll"][data-i="0"]')
        page.keyboard.press('Enter')
        wait_log(page, '「那家店」的候选：')
        page.wait_for_selector('[data-act="mn-reroll"][data-i="0"]:not([disabled])')
        assert focused(page)[:2] == ['mn-reroll', '0'], ('换一批结束后焦点回到这一行的换一批', focused(page))
        prompts = names_prompts(page)
        assert len(prompts) == 2, len(prompts)
        assert '不要再给：月下酒馆、下城区、星辉亭' in prompts[1], prompts[1][prompts[1].find('## 1.'):][:200]
        assert prompts[1].count('## ') == 1 + prompts[1].count('## 1. ') - 1 and '「那位大人」' not in prompts[1], '只问这一条'
        r0 = mn(page, 0)
        print('row0 after reroll:', r0)
        assert [c[0] for c in r0['cands']] == ['月下酒馆', '月影酒馆', '夜灯小馆'] and r0['seen'] == ['月下酒馆', '下城区', '星辉亭']
        assert r0['resolved'] == '月下酒馆' and r0['by'] == 'ai', '已填写的值保留'
        assert [c[:3] for c in chips(page, 0)] == [['月下酒馆', '原文', 'true'], ['月影酒馆', 'AI 起名', 'false'], ['夜灯小馆', 'AI 起名', 'false']]
        assert by_tag(page, 0) == 'AI 填入'
        why0 = page.inner_text('[data-mn-why="0"]')
        assert '挂出了招牌：月下酒馆' in why0 and 'AI 自动填入，点高亮的候选确认' in why0, why0
        shot(page, '06-rerolled')
        # 亮色主题下看一眼（颜色都从酒馆主题变量混出来）
        ev(page, '''() => { const s = document.documentElement.style; s.setProperty('--SmartThemeBodyColor', '#2b2b2e'); s.setProperty('--SmartThemeQuoteColor', '#c0632a');
            s.setProperty('--SmartThemeBlurTintColor', 'rgba(246, 245, 241, 0.97)'); document.body.style.background = '#e9e7e1'; }''')
        page.locator('[data-mn-row="4"]').scroll_into_view_if_needed()
        shot(page, '07-light-theme')
        ev(page, '''() => { const s = document.documentElement.style; ['--SmartThemeBodyColor', '--SmartThemeQuoteColor', '--SmartThemeBlurTintColor'].forEach((k) => s.removeProperty(k)); document.body.style.background = ''; }''')

        # ---- 中等宽度（侧栏还在、表格还没改成一条一块）：加一条很长的说法，表格不超出卡片 ----
        push_rows(page, ['城东那家卖烧饼的老铺子'])
        page.wait_for_selector('[data-mn-row="5"]')
        for w in [1024, 900, 834, 820, 801]:
            page.set_viewport_size({'width': w, 'height': 900})
            page.wait_for_timeout(150)
            over = overflow(page)
            print(f'overflow @{w}:', over)
            assert over['secOverflow'] <= 1 and over['mainOverflow'] <= 1 and not over['bad'], (w, over)
            if w == 834:
                page.locator('[data-mn-row="0"]').scroll_into_view_if_needed()
                shot(page, '07b-834')
        ev(page, '() => { NovelLoom.app.project.missingNames.pop(); NovelLoom.app.events.emit("names:progress"); }')
        page.wait_for_selector('[data-mn-row="5"]', state='detached')

        # ---- 窄屏布局 ----
        page.set_viewport_size({'width': 390, 'height': 844})
        page.wait_for_timeout(200)
        page.locator('section[data-sec="names"]').scroll_into_view_if_needed()
        over = overflow(page)
        print('narrow overflow:', over)
        assert over['secOverflow'] <= 1 and over['mainOverflow'] <= 1 and not over['bad'], over
        shot(page, '08-narrow')
        page.locator('[data-mn-row="4"]').scroll_into_view_if_needed()
        shot(page, '09-narrow-rows')
        page.click('[data-act="mn-ai"]')
        page.wait_for_selector('.nl-dialog[aria-label="AI 推断名称"]')
        dlg = page.inner_text('.nl-dialog-body')
        assert '只推断还没推断过、也还没填写的（0 条）' in dlg and '这个范围里没有需要推断的名称' in dlg, dlg
        shot(page, '10-narrow-dialog')
        page.click('.nl-dialog-foot button:has-text("取消")')
        page.wait_for_selector('.nl-dialog', state='detached')
        page.set_viewport_size({'width': 1360, 'height': 900})

        # ---- 替换进资料：先列出 AI 自动填入 / AI 起名的名称确认 ----
        page.click('[data-act="apply-names"]')
        page.wait_for_selector('.nl-dialog[aria-label="确认替换"]')
        dlg = page.inner_text('.nl-dialog-body')
        print('confirm:', dlg.replace('\n', ' | '))
        assert '下面 2 个名称' in dlg and '「那家店」→「月下酒馆」：AI 自动填入，你还没确认' in dlg and '「那座城」→「白塔城」：AI 起的名字，原文里没有' in dlg, dlg
        assert '在那一行点一下高亮的候选就算确认' in dlg
        assert '莉莉丝大人' not in dlg and '银河' not in dlg
        shot(page, '11-apply-confirm')
        page.click('.nl-dialog-foot button:has-text("取消")')
        page.wait_for_selector('.nl-dialog', state='detached')
        assert ev(page, 'NovelLoom.app.project.missingNames.length') == 5, '取消后什么都不变'
        assert ev(page, 'NovelLoom.app.project.worldbook["地点"]["下城区"].content') == '那家店就开在下城区。'

        page.click('[data-act="apply-names"]')
        page.click('.nl-dialog-foot button:has-text("仍然替换")')
        wait_log(page, '已替换')
        wb = ev(page, '[NovelLoom.app.project.worldbook["地点"]["下城区"].content, NovelLoom.app.project.worldbook["势力"]["魔女会"].content]')
        ch = ev(page, '[NovelLoom.app.project.characters["江酒"].identity, NovelLoom.app.project.characters["莉莉丝"].relationship]')
        print('after apply:', wb, ch)
        assert wb == ['月下酒馆就开在下城区。', '魔女会的据点在白塔城。'], wb
        assert ch == ['在月下酒馆打工的女仆', '在茶会上见到莉莉丝大人'], ch
        assert ev(page, 'NovelLoom.app.project.missingNames.map((m) => m.vague)') == ['那件东西'], '替换过的行移除，没填的留下'
        snaps = ev(page, 'async () => (await (await import("/src/store.js")).listSnapshots(NovelLoom.app.project.id)).map((s) => s.label)')
        assert '替换待确认名称前' in snaps, snaps
        assert page.locator('[data-mn-row]').count() == 1
        shot(page, '12-applied')

        # 导出 Markdown 里注明 AI 来源（没填的列出候选）
        md = ev(page, 'async () => { const { missingNameMarkdown } = await import("/src/names.js"); return NovelLoom.app.project.missingNames.map(missingNameMarkdown); }')
        assert md == ['- [专有名词类] 那件东西 → ?（那件东西被藏在那座城里）'], md

        # ---- 进行中（键盘发起，每批 1 条）：标题栏显示进度和「停止」，焦点移到「停止」，不能替换进资料 ----
        ev(page, 'window.__namesGate = true')
        push_rows(page, ['那条街', '那座山', '那片湖'])
        page.wait_for_selector('[data-mn-row="3"]')
        n_before = len(names_prompts(page))
        page.focus('[data-act="mn-ai"]')
        page.keyboard.press('Enter')
        page.wait_for_selector('.nl-dialog[aria-label="AI 推断名称"]')
        page.check('input[name="nl-mn-scope"][value="new"]')
        page.fill('[data-f="batchSize"]', '1')
        assert '将推断 3 条，分 3 次请求' in page.inner_text('.nl-dialog-body'), page.inner_text('.nl-dialog-body')
        page.focus('.nl-dialog-foot button:has-text("开始推断")')
        page.keyboard.press('Enter')
        page.wait_for_selector('[data-act="mn-stop"]')
        page.wait_for_function('() => document.activeElement?.dataset?.act === "mn-stop"')
        head = page.inner_text('section[data-sec="names"] .nl-card-head')
        assert 'AI 推断中' in head and '0/3 批' in head, head
        assert page.is_disabled('[data-act="apply-names"]'), '推断进行中不能替换进资料'
        assert page.locator('.nl-mn-table .nl-reroll[disabled]:not([data-act])').count() == 3, '正在推断的行显示进度'
        assert page.is_disabled('[data-act="mn-reroll"][data-i="0"]')
        shot(page, '13-running')

        # 输入法拼写途中有一批结果回来：不重绘这一行、拼音不会被记成名称；拼完后记录，并补上推迟的重绘
        cdp = page.context.new_cdp_session(page)
        page.focus('[data-mn="0"]')
        cdp.send('Input.imeSetComposition', {'text': "yue'xia", 'selectionStart': 7, 'selectionEnd': 7})
        assert page.input_value('[data-mn="0"]') == "yue'xia"
        release(page)
        page.wait_for_function('() => NovelLoom.app.project.missingNames[1].ai')
        page.wait_for_timeout(150)
        assert page.input_value('[data-mn="0"]') == "yue'xia" and focused(page)[2] == '0', '拼写没被打断'
        assert mn(page, 0)['resolved'] == '' and mn(page, 0)['by'] == '', ('拼音不会被记成名称', mn(page, 0))
        assert page.locator('[data-mn-row="1"] [data-act="mn-pick"]').count() == 0, '重绘推迟到拼完'
        cdp.send('Input.insertText', {'text': '月牙'})
        page.wait_for_function('() => document.querySelectorAll(\'[data-mn-row="1"] [data-act="mn-pick"]\').length > 0')
        assert page.input_value('[data-mn="0"]') == '月牙' and focused(page)[2] == '0'
        assert mn(page, 0)['resolved'] == '月牙' and mn(page, 0)['by'] == 'user', mn(page, 0)
        assert '1/3 批' in page.inner_text('section[data-sec="names"] .nl-card-head')

        # 末尾的空格：一批结果回来重绘后仍在，接着打的字不会粘在一起
        page.fill('[data-mn="0"]', '')
        page.keyboard.type('Anna ')
        assert mn(page, 0)['resolved'] == 'Anna'
        release(page)
        page.wait_for_function('() => NovelLoom.app.project.missingNames[2].ai')
        page.wait_for_timeout(150)
        assert page.input_value('[data-mn="0"]') == 'Anna ' and focused(page)[2] == '0', page.input_value('[data-mn="0"]')
        page.keyboard.type('Smith')
        assert page.input_value('[data-mn="0"]') == 'Anna Smith' and mn(page, 0)['resolved'] == 'Anna Smith'

        # 停止（键盘）：已完成的批次保留，焦点回到「AI 推断名称」；停止后才回来的那一批不写回
        page.focus('[data-act="mn-stop"]')
        page.keyboard.press('Enter')
        wait_log(page, '已停止推断名称')
        page.wait_for_selector('[data-act="mn-ai"]:not([disabled])')
        page.wait_for_function('() => document.activeElement?.dataset?.act === "mn-ai"')
        assert page.locator('[data-act="mn-stop"]').count() == 0 and not page.is_disabled('[data-act="apply-names"]')
        assert len(names_prompts(page)) == n_before + 3
        release(page)
        page.wait_for_timeout(200)
        assert ev(page, '!!NovelLoom.app.project.missingNames[3].ai') is False, '停止后回来的那一批不写回'
        assert ev(page, '[!!NovelLoom.app.project.missingNames[1].ai, !!NovelLoom.app.project.missingNames[2].ai]') == [True, True]
        assert ev(page, 'NovelLoom.app.settings.nameResolve.batchSize') == 1, '对话框里的选项记住了'
        assert page.locator('.nl-dialog').count() == 0, '停止不弹出错误'

        # ---- 推断途中切换项目：停止推断，切走前完成的批次存进原项目，之后不再拿旧对象写数据库 ----
        a_id = ev(page, 'NovelLoom.app.project.id')
        b_id = ev(page, '''async () => {
            const { createProject } = await import('/src/project.js');
            const { saveProject } = await import('/src/store.js');
            const b = createProject({ name: '另一本', chunks: [{ id: 'b1', title: '第一章', content: '另一个故事。', origin: 'source', status: 'done', outline: [], important: [] }] });
            await saveProject(b);
            return b.id;
        }''')
        push_rows(page, ['那口井'])
        page.click('[data-act="mn-ai"]')
        page.wait_for_selector('.nl-dialog[aria-label="AI 推断名称"]')
        assert '将推断 2 条，分 2 次请求' in page.inner_text('.nl-dialog-body'), page.inner_text('.nl-dialog-body')
        page.click('.nl-dialog-foot button:has-text("开始推断")')
        page.wait_for_selector('[data-act="mn-stop"]')
        # 推断途中忽略上面的一行（下标错位）：「推断中…」仍跟着原来的行走
        page.click('[data-act="del-mn"][data-i="1"]')
        page.wait_for_function('() => !NovelLoom.app.project.missingNames.some((m) => m.vague === "那条街")')
        release(page)
        page.wait_for_function('() => NovelLoom.app.project.missingNames.find((m) => m.vague === "那片湖").ai')
        spin = ev(page, '() => [...document.querySelectorAll("[data-mn-row]")].map((r) => [r.querySelector(".nl-mn-c-vague").textContent, !!r.querySelector(".nl-reroll[disabled]:not([data-act])")])')
        assert spin == [['那件东西', False], ['那座山', False], ['那片湖', False], ['那口井', True]], spin
        page.wait_for_function('() => window.__namesWaiters.length > 0')  # 第 2 批已经发出、还没回来
        ev(page, 'async (id) => { await NovelLoom.app.openProject(id); }', b_id)
        wait_log(page, '已切换项目')
        assert ev(page, 'NovelLoom.app.nameJob') is None and ev(page, 'NovelLoom.app.project.id') == b_id
        saved_js = '(s, id) => s.loadProject(id).then((p) => p && p.missingNames.map((m) => [m.vague, !!m.ai, m.resolved || ""]))'
        saved = store(page, saved_js, a_id)
        print('A after switch:', saved)
        assert ['那片湖', True, ''] in saved and ['那口井', False, ''] in saved and ['那件东西', True, 'Anna Smith'] in saved, saved
        assert release(page), '切走时还在等的那一批，现在才回来'
        page.wait_for_timeout(300)
        assert store(page, saved_js, a_id) == saved, '切走后回来的结果不写进数据库'
        assert ev(page, 'NovelLoom.app.project.missingNames.length') == 0, '不会写进切换到的项目'
        # 切回原项目：重新读出来的对象带着切走前完成的那一批
        ev(page, 'async (id) => { await NovelLoom.app.openProject(id); }', a_id)
        page.evaluate("NovelLoom.open('outline')")
        page.wait_for_selector('section[data-sec="names"]')
        row = ev(page, '() => NovelLoom.app.project.missingNames.findIndex((m) => m.vague === "那片湖")')
        assert page.locator(f'[data-mn-row="{row}"] [data-act="mn-pick"]').count() > 0

        # ---- 推断途中删除了这个项目（项目页的删除：先关闭再删）：删掉的项目不会被写回来 ----
        page.click('[data-act="mn-ai"]')
        page.wait_for_selector('.nl-dialog[aria-label="AI 推断名称"]')
        assert '将推断 1 条' in page.inner_text('.nl-dialog-body')
        page.click('.nl-dialog-foot button:has-text("开始推断")')
        page.wait_for_selector('[data-act="mn-stop"]')
        page.wait_for_function('() => window.__namesWaiters.length > 0')
        ev(page, 'async (id) => { NovelLoom.app.setProject(null); await (await import("/src/store.js")).deleteProject(id); }', a_id)
        wait_log(page, '已关闭，AI 推断名称已停止')
        assert release(page), '删除时还在等的那一批，现在才回来'
        page.wait_for_timeout(400)
        assert store(page, '(s, id) => s.loadProject(id).then((p) => !p)', a_id) is True, '删掉的项目不会被写回来'
        assert a_id not in store(page, '(s) => s.listProjects().then((l) => l.map((x) => x.id))', 0)
        assert ev(page, 'NovelLoom.app.nameJob') is None
        assert page.locator('.nl-dialog').count() == 0, '不弹出错误'
        browser.close()
finally:
    server.terminate()

real = [e for e in errors if 'favicon' not in e]
print('ERRORS:', json.dumps(real, ensure_ascii=False))
sys.exit(1 if real else 0)
