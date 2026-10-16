# 浏览器冒烟测试（创意工坊）：没打开项目时侧栏「创意工坊」也能用，写下创意（飞机失事、荒岛、7 位女性幸存者）→ 生成大纲时新建原创项目 →
# 大纲 7 个角色 + 5 个阶段（年龄都是成年人，提示词写明成年人规则）→ 改名字、年龄写成未满 18 岁时改成 18 岁、锁定一个角色、重新生成阵容时锁定的保留 →
# 「全部生成」角色细节 + 各阶段开场白 + 示例对话（进度）→ 角色标签（键盘切换）、只重写一项、复制立绘提示词 → 「全部重写」中途停止 →
# 生成卡（7 个角色条目 + 故事阶段 + 地点、开场白 = 阶段数、状态栏「主要角色」预填）→ 写入酒馆（卡自己的世界书里都有）→ 改开场白后「更新卡片」（同一张卡）→
# 角色卡页的指引、「创意工坊」标签、「在创意工坊打开」、「去角色卡页编辑」→ 刷新后草稿还在 → 窄屏截图（没有横向滚动，标签横向滚动）
# 审查后的修正：重新生成世界观时那几栏只读；开场白生成期间焦点停在它上面也不会被旧文字盖掉；标题栏「停止」重绘后焦点还在；
# 「全部重写」的进度按这一轮走；阶段的两段文字有小标题；生成卡时可以停止状态栏这一步；草稿改过之后提示卡还没更新；阶段删光了还能回到大纲
import json, os, subprocess, sys, time
from playwright.sync_api import sync_playwright

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
OUT = sys.argv[1] if len(sys.argv) > 1 else '/tmp/nl-studio'
os.makedirs(OUT, exist_ok=True)
PORT = 8787
server = subprocess.Popen([sys.executable, '-m', 'http.server', str(PORT), '--bind', '127.0.0.1'], cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1)

PREMISE = '我想做一张飞机失事，在荒岛上和 7 位女性幸存者共同求生的故事'
ADULT = '所有涉及恋爱或亲密内容的人物（包括 {{user}}）都是成年人'
SET_A = ['林夏', '苏晴', '顾言', '唐恬', '沈墨', '白露', '叶知秋']
SET_B = ['周芷', '江遥', '秦岚', '宋雨', '许静', '陆宁', '程安']
NOVEL = '第一章 魔女小姐\n' + '江酒走进酒吧。莉莉丝坐在角落，黑色长裙拖到地上。\n' * 18 + '第二章 女仆\n' + '江酒穿上了女仆装。莉莉丝去参加魔女茶会。\n' * 22
errors = []
shots = [0]

def shot(page, name):
    # 对话框有淡入动画：等它完全显示再截图
    page.wait_for_function('() => [...document.querySelectorAll(".nl-dialog-overlay, .nl-dialog")].every((d) => getComputedStyle(d).opacity === "1")')
    shots[0] += 1
    page.screenshot(path=os.path.join(OUT, f'{shots[0]:02d}-{name}.png'))

def wait_log(page, text, timeout=30000):
    page.wait_for_function('(t) => [...document.querySelectorAll(".nl-log-line")].some(l => l.textContent.includes(t))', arg=text, timeout=timeout)

def ev(page, js, arg=None):
    return page.evaluate(js, arg) if arg is not None else page.evaluate(js)

def prompts(page, needle):
    return ev(page, '(n) => (window.__prompts || []).filter((t) => t.includes(n))', needle)

def close_dialog(page):
    page.click('.nl-dialog-overlay:last-child .nl-dialog [data-close]')
    page.wait_for_timeout(150)

def dialog_ok(page, label):
    page.click(f'.nl-dialog-overlay:last-child .nl-dialog-foot button:has-text("{label}")')

def no_hscroll(page):
    return ev(page, 'document.documentElement.scrollWidth <= window.innerWidth + 1')

def studio(page):
    return ev(page, '(() => { const p = NovelLoom.app.project; return p && JSON.parse(JSON.stringify(p.studios[0])); })()')

def wait_idle(page, timeout=60000):
    page.wait_for_function('() => !NovelLoom.app.studioJob', timeout=timeout)

def open_app(page, tab='project'):
    page.wait_for_selector('#nl-wand-button')
    page.evaluate(f"NovelLoom.open('{tab}')")
    page.wait_for_selector('.nl-window')

try:
    with sync_playwright() as p:
        browser = p.chromium.launch()
        ctx = browser.new_context(viewport={'width': 1360, 'height': 900}, accept_downloads=True)
        ctx.grant_permissions(['clipboard-read', 'clipboard-write'], origin=f'http://127.0.0.1:{PORT}')
        page = ctx.new_page()
        page.on('pageerror', lambda e: errors.append('pageerror: ' + str(e)))
        page.on('console', lambda m: errors.append('console: ' + m.text) if m.type == 'error' else None)
        page.goto(f'http://127.0.0.1:{PORT}/tests/browser/harness.html')
        page.wait_for_selector('#nl-wand-button')
        # 扩展设置存进 sessionStorage：刷新后读回来（验证草稿「刷新后还在」）
        ev(page, "() => { sessionStorage.setItem('__nl_persist', '1'); sessionStorage.removeItem('__nl_ext'); }")
        open_app(page)
        assert ev(page, 'NovelLoom.app.project') is None

        # ---- 侧栏：「创意工坊」在「生成」组里、用户画像和角色卡之间；没打开项目也能用 ----
        order = ev(page, '[...document.querySelectorAll(".nl-nav .nl-nav-btn")].map((b) => b.dataset.tab)')
        print('nav order:', order)
        assert order.index('profiles') + 1 == order.index('studio') == order.index('cards') - 1, order
        assert 'nl-disabled' not in page.get_attribute('.nl-nav-btn[data-tab="studio"]', 'class')
        page.click('.nl-nav-btn[data-tab="studio"]')
        page.wait_for_selector('#nl-tab [data-sf="premise"]')
        assert page.inner_text('#nl-page-title') == '创意工坊'
        txt = page.inner_text('#nl-tab')
        assert '还没有打开项目' in txt and '新建一个原创项目' in txt, txt[:300]
        assert page.locator('#nl-tab [data-st-drafts]').count() == 0, '没有项目时没有草稿列表'
        steps = ev(page, '[...document.querySelectorAll("#nl-tab .nl-st-step")].map((b) => [b.textContent.trim(), b.disabled, b.getAttribute("aria-current")])')
        print('steps:', steps)
        assert [s[1] for s in steps] == [False, True, True, True] and steps[0][2] == 'step', steps
        assert '飞机失事' in page.get_attribute('#nl-tab [data-sf="premise"]', 'placeholder')

        # ---- 第 1 步：写创意（人数从创意里读出来）、预览提示词 ----
        page.fill('#nl-tab [data-sf="premise"]', PREMISE)
        page.wait_for_function('() => document.querySelector("[data-st-premise-note]").textContent.includes("7 个人")')
        assert page.get_attribute('#nl-tab [data-sf="options.count"]', 'placeholder') == '按创意：7 人'
        page.fill('#nl-tab [data-sf="options.extra"]', '基调偏轻松，有一点悬疑')
        shot(page, 'premise')
        page.click('#nl-tab [data-act="preview"][data-what="outline"]')
        page.wait_for_selector('.nl-dialog')
        pv = page.inner_text('.nl-dialog-body')
        assert '设计群像故事大纲' in pv and '正好 7 人' in pv and ADULT in pv and '18 岁以上' in pv and '基调偏轻松' in pv, pv[:400]
        close_dialog(page)

        # ---- 生成大纲：新建原创项目（用创意的标题命名），大纲 7 人 + 5 个阶段 ----
        page.click('#nl-tab [data-act="outline"]')
        page.wait_for_function('() => NovelLoom.app.project && NovelLoom.app.project.studios.length === 1')
        wait_log(page, '新建原创项目「飞机失事」')
        wait_idle(page)
        wait_log(page, '生成大纲完成')
        page.wait_for_selector('#nl-tab .nl-st-member')
        proj = ev(page, '({ name: NovelLoom.app.project.name, original: NovelLoom.app.project.original })')
        assert proj == {'name': '飞机失事', 'original': True}, proj
        s = studio(page)
        print('outline:', s['outline']['title'], [c['name'] for c in s['outline']['cast']], [c['age'] for c in s['outline']['cast']], [x['name'] for x in s['outline']['stages']])
        assert [c['name'] for c in s['outline']['cast']] == SET_A and len(s['outline']['stages']) == 5 and s['step'] == 2
        assert all(int(c['age'].split()[0]) >= 18 for c in s['outline']['cast'])
        assert s['options']['extra'] == '基调偏轻松，有一点悬疑' and s['premise'] == PREMISE
        op = prompts(page, '设计群像故事大纲')[-1]
        assert '正好 7 人（不含 {{user}}，创意里写明的）' in op and ADULT in op and '飞机失事' in op
        assert ev(page, 'document.querySelector(".nl-nav-btn[data-tab=studio] .nl-nav-count").textContent').endswith('1')
        # 侧栏的「下一步」指向创意工坊（不是单人写卡的「角色卡」）
        assert 'nl-next' in page.get_attribute('.nl-nav-btn[data-tab="studio"]', 'class') and 'nl-next' not in page.get_attribute('.nl-nav-btn[data-tab="cards"]', 'class')
        assert page.locator('#nl-tab .nl-st-step[aria-current="step"]').inner_text().strip().endswith('大纲')
        # 只有一份构思：不显示草稿列表，标题、重命名、删除在步骤条上面
        assert page.locator('#nl-tab [data-st-drafts]').count() == 0
        # 构思没起名时跟着大纲里的卡名走（项目名用创意里的短标题）
        assert page.inner_text('#nl-tab .nl-st-head h3') == '孤岛七日' and page.locator('#nl-tab .nl-st-head [data-act="rename"]').count() == 1
        # 阶段的两段文字都有小标题（处境和走向 / 核心冲突）
        caps = ev(page, '[...document.querySelectorAll("#nl-tab .nl-st-stage .nl-st-mini-cap")].map((c) => c.textContent)')
        assert caps == ['处境和走向', '核心冲突'] * 5, caps
        shot(page, 'outline')

        # ---- 重新生成世界观期间：世界观几栏只读（结果回来时不会盖掉刚改的），角色和阶段照常能改 ----
        ev(page, '() => { window.__studioHoldOutline = true; }')
        page.click('#nl-tab [data-act="reroll-outline"][data-mode="world"]')
        page.wait_for_selector('.nl-dialog-head:has-text("重新生成世界观")')
        dialog_ok(page, '重新生成')
        page.wait_for_selector('#nl-tab [data-st-outline-busy]')
        page.wait_for_function('() => typeof window.__studioRelease === "function"')
        ro = ev(page, '''() => ['#nl-st-title', '#nl-st-setting', '#nl-st-rules', '#nl-st-userrole', '[data-loc="0"][data-lf="name"]', '[data-cast][data-cf="name"]', '[data-stage][data-gf="summary"]']
            .map((q) => document.querySelector('#nl-tab ' + q).readOnly)''')
        assert ro == [True, True, True, True, True, False, False], ro
        ev(page, '() => { window.__studioHoldOutline = false; window.__studioRelease(); delete window.__studioRelease; }')
        wait_idle(page)
        wait_log(page, '重新生成世界观完成')
        assert page.locator('#nl-tab [data-st-outline-busy]').count() == 0 and not ev(page, 'document.querySelector("#nl-tab #nl-st-title").readOnly')

        # ---- 大纲：改名字、年龄（未满 18 岁改成 18 岁）、锁定一个角色、重新生成阵容时锁定的保留 ----
        first, second = s['outline']['cast'][0]['id'], s['outline']['cast'][1]['id']
        page.fill(f'[data-cast="{first}"][data-cf="name"]', '林小夏')
        page.press(f'[data-cast="{first}"][data-cf="name"]', 'Tab')
        page.wait_for_function('(id) => NovelLoom.app.project.studios[0].outline.cast.find((c) => c.id === id).name === "林小夏"', arg=first)
        # Tab 之后焦点在下一栏（性别），没有被重绘拉回名字
        page.wait_for_timeout(100)
        assert ev(page, 'document.activeElement.dataset.cf') == 'gender', ev(page, 'document.activeElement.outerHTML')
        page.fill(f'[data-cast="{second}"][data-cf="age"]', '16')
        page.press(f'[data-cast="{second}"][data-cf="age"]', 'Tab')
        page.wait_for_function('(id) => NovelLoom.app.project.studios[0].outline.cast.find((c) => c.id === id).age === "18 岁"', arg=second)
        assert page.input_value(f'[data-cast="{second}"][data-cf="age"]') == '18 岁'
        wait_log(page, '已改成 18 岁')
        page.fill(f'[data-cast="{second}"][data-cf="age"]', '29')
        page.press(f'[data-cast="{second}"][data-cf="age"]', 'Tab')
        page.wait_for_function('(id) => NovelLoom.app.project.studios[0].outline.cast.find((c) => c.id === id).age === "29 岁"', arg=second)
        page.click(f'[data-act="cast-lock"][data-id="{second}"]')
        page.wait_for_function('(id) => NovelLoom.app.project.studios[0].outline.cast.find((c) => c.id === id).locked', arg=second)
        assert page.get_attribute(f'[data-act="cast-lock"][data-id="{second}"]', 'aria-pressed') == 'true'
        assert page.is_disabled(f'[data-act="reroll-member"][data-id="{second}"]'), '锁定的角色不能「换掉」'
        page.click('#nl-tab [data-act="reroll-outline"][data-mode="cast"]')
        page.wait_for_selector('.nl-dialog-head:has-text("重新生成角色阵容")')
        assert '锁定的 1 个保留' in page.inner_text('.nl-dialog-body')
        page.fill('.nl-dialog #nl-st-ins', '职业更分散')
        dialog_ok(page, '重新生成')
        wait_idle(page)
        wait_log(page, '重新生成角色阵容完成')
        s2 = studio(page)
        names = [c['name'] for c in s2['outline']['cast']]
        print('after cast reroll:', names)
        assert len(names) == 7 and names[1] == '苏晴' and s2['outline']['cast'][1]['id'] == second and s2['outline']['cast'][1]['locked'] and s2['outline']['cast'][1]['age'] == '29 岁', names
        assert names[0] == SET_B[0] and '林小夏' not in names, names
        cp = prompts(page, '只重新设计角色阵容')[-1]
        assert '# 用户锁定的角色' in cp and '苏晴（29 岁' in cp and '职业更分散' in cp, cp[:300]
        # 换掉一个角色
        third = s2['outline']['cast'][2]['id']
        page.click(f'[data-act="reroll-member"][data-id="{third}"]')
        page.wait_for_selector('.nl-dialog-head:has-text("换掉")')
        dialog_ok(page, '换掉')
        wait_idle(page)
        page.wait_for_function('() => NovelLoom.app.project.studios[0].outline.cast[2].name === "温妤"')
        assert '只换掉一位角色' in prompts(page, '设计群像故事大纲')[-1]
        shot(page, 'outline-locked')

        # ---- 第 3 步：每个角色一个标签 + 开场白 + 示例对话；全部生成（进度） ----
        page.click('#nl-tab [data-act="goto-step"][data-step="3"]')
        page.wait_for_selector('#nl-tab [role="tablist"]')
        tabs = ev(page, '[...document.querySelectorAll("#nl-tab [role=tab] .nl-st-tab-label")].map((t) => t.textContent.trim())')
        print('tabs:', tabs)
        assert len(tabs) == 9 and tabs[7].startswith('开场白') and tabs[8] == '示例对话', tabs
        # 读屏念的是「名字（状态）」：状态写在隐藏的文字里，圆点本身对读屏隐藏
        assert ev(page, 'document.querySelector("#nl-tab [role=tab] .nl-sr-only").textContent') == '（未生成）'
        assert ev(page, '[...document.querySelectorAll("#nl-tab [role=tab]")].filter((t) => t.tabIndex === 0).length') == 1
        # 还没生成的角色不能「只重写一项」（免得只写了一项就算完成）
        dice = ev(page, '[...document.querySelectorAll("#nl-tab [data-act=field]")].map((b) => [b.disabled, b.title])')
        assert dice and all(d[0] and d[1] == '先生成这个角色' for d in dice), dice
        n_char = ev(page, 'window.__studioCharCalls || 0')
        page.click('#nl-tab [data-act="gen-all"]')
        page.wait_for_selector('.nl-page-actions [data-act="stop"]')
        page.wait_for_function('() => /展开角色 \\d\\/7|写开场白|示例对话/.test(document.querySelector(".nl-page-actions").textContent)')
        shot(page, 'generating')
        wait_idle(page, 90000)
        wait_log(page, '全部生成完成')
        s3 = studio(page)
        prog = ev(page, '(() => { const s = NovelLoom.app.project.studios[0]; return [Object.keys(s.details).length, Object.keys(s.openers).length, !!s.example]; })()')
        print('generated:', prog)
        assert prog == [7, 5, True], prog
        assert ev(page, 'window.__studioCharCalls') - n_char == 7
        chars = prompts(page, '展开角色细节')
        assert ADULT in chars[-1] and '# 其他角色' in chars[-1] and '外貌：' in chars[-1], '后面的角色能看到前面写好的'
        ops = prompts(page, '写这一阶段的开场白')
        assert any('默认前面的阶段都已经发生' in t for t in ops) and any('这是故事的第一个阶段' in t for t in ops)
        assert not page.locator('#nl-tab .nl-st-tab .nl-spin').count(), '没有还在转圈的标签'
        assert ev(page, '[...document.querySelectorAll("#nl-tab [role=tab] .nl-dot.nl-ok")].length') == 9
        assert page.is_disabled('#nl-tab [data-act="gen-all"]')
        # 第 3 步这张卡片里只有一个主要按钮（「全部生成」）
        assert ev(page, 'document.querySelector("#nl-tab [data-st-tabs]").closest(".nl-card").querySelectorAll(".nl-primary").length') == 1
        shot(page, 'character')

        # ---- 标签：键盘切换（方向键 / Home / End，选中的那个 tabindex=0） ----
        page.focus('#nl-tab [role="tab"][aria-selected="true"]')
        page.keyboard.press('ArrowRight')
        page.wait_for_function('() => document.activeElement?.getAttribute("role") === "tab" && document.activeElement.getAttribute("aria-selected") === "true" && document.activeElement.id === "nl-st-tab-1"')
        assert page.inner_text('#nl-tab .nl-st-panel-title b') == '苏晴'
        # 焦点框画在标签里面（标签条横向滚动会裁掉画在外面的框）
        assert ev(page, 'getComputedStyle(document.activeElement).outlineOffset') == '-3px'
        page.keyboard.press('End')
        page.wait_for_function('() => document.activeElement?.id === "nl-st-tab-8"')
        assert page.locator('#nl-tab [data-sf="example"]').count() == 1
        page.keyboard.press('ArrowRight')
        page.wait_for_function('() => document.activeElement?.id === "nl-st-tab-0"')
        page.keyboard.press('ArrowLeft')
        page.wait_for_function('() => document.activeElement?.id === "nl-st-tab-8"')
        page.keyboard.press('Home')
        page.wait_for_function('() => document.activeElement?.id === "nl-st-tab-0"')
        assert page.get_attribute('#nl-st-panel', 'aria-labelledby') == 'nl-st-tab-0'
        assert ev(page, '[...document.querySelectorAll("#nl-tab [role=tab]")].map((t) => t.tabIndex).join("")') == '0' + '-1' * 8

        # ---- 只重写一项：性格（其余不变，额外要求进提示词） ----
        c0 = s3['outline']['cast'][0]
        before = s3['details'][c0['id']]
        page.click(f'#nl-tab [data-act="field"][data-id="{c0["id"]}"][data-field="personality"]')
        page.wait_for_selector('.nl-dialog-head:has-text("的性格")')
        page.fill('.nl-dialog #nl-st-ins', '更冷淡一点')
        dialog_ok(page, '重新生成')
        wait_idle(page)
        page.wait_for_function('() => document.querySelector("#nl-tab [data-df=personality]").value.startsWith("【重写】")')
        after = studio(page)['details'][c0['id']]
        assert after['appearance'] == before['appearance'] and after['secret'] == before['secret'] and after['personality'].startswith('【重写】')
        fp = prompts(page, '只重写这一项')[-1]
        assert '只重写「性格」这一项' in fp and '更冷淡一点' in fp and '<当前内容>' in fp
        # 编辑一项（自动保存）
        page.fill('#nl-tab [data-df="speech"]', '说话很慢，喜欢反问')
        page.wait_for_function('(id) => NovelLoom.app.project.studios[0].details[id].speech === "说话很慢，喜欢反问"', arg=c0['id'], timeout=5000)
        # 好感等级、秘密、立绘提示词都在
        assert page.locator('#nl-tab [data-af="label"]').count() == 4
        assert page.input_value('#nl-tab [data-df="secret.reveal"]').startswith('好感到「信任」')
        pp = page.input_value('#nl-tab [data-df="portraitPrompt"]')
        assert pp.startswith('adult woman') and c0['name'] not in pp, pp

        # ---- 复制立绘提示词 ----
        page.click('#nl-tab [data-act="copy-portraits"]')
        wait_log(page, '已复制全部立绘提示词')
        clip = ev(page, 'navigator.clipboard.readText()')
        assert clip.count('【') == 7 and 'adult woman' in clip, clip[:200]
        page.click(f'#nl-tab [data-act="copy-portrait"][data-id="{c0["id"]}"]')
        wait_log(page, f'已复制「{c0["name"]}」的立绘提示词')

        # ---- 开场白标签：哪一段是开场白、哪些是备选开场白 ----
        page.click('#nl-tab [data-act="tab"][data-tab-key="openers"]')
        page.wait_for_selector('#nl-tab [data-opener]')
        assert page.locator('#nl-tab [data-opener]').count() == 5
        heads = ev(page, '[...document.querySelectorAll("#nl-tab .nl-st-opener-head .nl-tag")].map((t) => t.textContent)')
        assert heads == ['卡里的开场白', '备选开场白 1', '备选开场白 2', '备选开场白 3', '备选开场白 4'], heads
        shot(page, 'openers')

        # ---- 全部重写：中途停止，已经写好的保留 ----
        page.click('#nl-tab [data-act="tab"][data-tab-key="' + c0['id'] + '"]')
        keep = studio(page)['details'][c0['id']]['personality']
        ev(page, '() => { window.__studioHold = true; }')
        page.click('#nl-tab [data-act="regen-all"]')
        page.wait_for_selector('.nl-dialog-head:has-text("全部重写")')
        dialog_ok(page, '全部重写')
        page.wait_for_function('() => typeof window.__studioRelease === "function"', timeout=20000)
        # 正在生成的角色：标签转圈、这一页只读
        page.wait_for_selector('#nl-tab .nl-st-tab .nl-spin')
        assert page.get_attribute('#nl-tab [data-df="personality"]', 'readonly') is not None
        # 全部重写：进度条按这一轮走（内容本来是满的，不是一开始就 13/13）
        bar = ev(page, '(() => { const b = document.querySelector("#nl-tab [data-st-progress] [role=progressbar]"); return [b.getAttribute("aria-valuenow"), b.getAttribute("aria-valuemax"), b.querySelector(".nl-progress-bar").style.width]; })()')
        assert bar == ['0', '13', '0%'], bar
        # 键盘焦点放在标题栏的「停止」上：页面因为进度重绘后焦点还在，按回车就能停
        page.focus('.nl-page-actions [data-act="stop"]')
        ev(page, '() => NovelLoom.app.events.emit("studio:progress", NovelLoom.app.studioJob)')
        assert ev(page, 'document.activeElement?.dataset.act') == 'stop'
        page.keyboard.press('Enter')
        wait_log(page, '已停止「全部重写」')
        wait_idle(page)
        ev(page, '() => { window.__studioHold = false; window.__studioRelease(); delete window.__studioRelease; }')
        page.wait_for_timeout(200)
        s4 = studio(page)
        assert s4['details'][c0['id']]['personality'] == keep, '停止后原来的保留'
        assert not s4['errors'], s4['errors']
        assert page.get_attribute('#nl-tab [data-df="personality"]', 'readonly') is None

        # ---- 开场白生成期间光标停在它的输入框里：写完后新内容留着（不会被焦点里的旧文字盖掉） ----
        page.click('#nl-tab [data-act="tab"][data-tab-key="openers"]')
        st3 = s4['outline']['stages'][2]['id']
        sel3 = f'#nl-tab [data-opener="{st3}"]'
        page.fill(sel3, '')
        page.press(sel3, 'Tab')
        page.wait_for_function('(id) => !NovelLoom.app.project.studios[0].openers[id]', arg=st3)
        ev(page, '() => { window.__studioHoldOpener = true; }')
        page.click(f'#nl-tab [data-act="opener"][data-id="{st3}"]')
        page.wait_for_function('() => typeof window.__studioRelease === "function"')
        page.focus(sel3)
        assert ev(page, '(q) => document.activeElement === document.querySelector(q) && document.activeElement.readOnly', sel3)
        ev(page, '() => { window.__studioHoldOpener = false; window.__studioRelease(); delete window.__studioRelease; }')
        wait_idle(page)
        ev(page, '() => NovelLoom.app.events.emit("studio:progress", null)')
        page.click('#nl-tab [data-act="tab"][data-tab-key="openers"]')
        page.wait_for_timeout(300)
        new3 = ev(page, '(id) => NovelLoom.app.project.studios[0].openers[id] || ""', st3)
        assert new3.startswith('【第 3 阶段「异变」】') and page.input_value(sel3) == new3, new3[:40]

        # ---- 第 4 步：生成卡 ----
        page.click('#nl-tab [data-act="goto-step"][data-step="4"]')
        page.wait_for_selector('#nl-tab [data-act="build"]')
        sumtxt = page.inner_text('#nl-tab .nl-st-sum')
        print('summary:', sumtxt.replace('\n', ' | '))
        assert '12 条' in sumtxt and '角色 7 · 地点 4 · 故事阶段总览 1（常驻）' in sumtxt and '5 段' in sumtxt, sumtxt
        assert page.is_checked('#nl-tab [data-sf="options.statusBar"]') and page.is_checked('#nl-tab [data-sf="options.examples"]')
        shot(page, 'build')
        page.click('#nl-tab [data-act="card-preview"]')
        page.wait_for_selector('.nl-dialog-head:has-text("卡片内容")')
        assert '本卡世界书（12 条）' in page.inner_text('.nl-dialog-body')
        close_dialog(page)
        # 生成卡时停在状态栏这一步：卡留着，状态栏回到没生成的样子（还能勾选后重试）
        ev(page, '() => { window.__sbHold = true; }')
        page.click('#nl-tab [data-act="build"]')
        page.wait_for_function('() => typeof window.__sbRelease === "function"', timeout=30000)
        assert '生成状态栏' in page.inner_text('.nl-page-actions')
        page.click('.nl-page-actions [data-act="stop"]')
        wait_log(page, '已停止：生成角色卡')
        wait_idle(page)
        ev(page, '() => { window.__sbHold = false; window.__sbRelease(); delete window.__sbRelease; }')
        held = ev(page, '(() => { const c = NovelLoom.app.project.cards.at(-1); return c && [c.source, !!(c.statusBar && c.statusBar.spec && c.statusBar.spec.variables.length)]; })()')
        assert held == ['studio', False], held
        assert page.is_checked('#nl-tab [data-sf="options.statusBar"]') and page.inner_text('#nl-tab [data-act="build"]') == '更新卡片'
        page.click('#nl-tab [data-act="build"]')
        wait_idle(page, 60000)
        wait_log(page, '已更新世界卡「孤岛七日」')
        card = ev(page, 'NovelLoom.app.project.cards.at(-1)')
        st = studio(page)
        stages = st['outline']['stages']
        print('card:', card['data']['name'], card['kind'], card['source'], len(card['data']['alternate_greetings']), [e['name'] for e in card['studio']['entries']])
        assert card['kind'] == 'world' and card['source'] == 'studio' and card['studioId'] == st['id'] and st['cardId'] == card['id']
        assert card['data']['first_mes'] == st['openers'][stages[0]['id']] and card['data']['alternate_greetings'] == [st['openers'][x['id']] for x in stages[1:]]
        assert '第 2 阶段「求生」' in card['data']['creator_notes'] and '<START>' in card['data']['mes_example']
        ents = card['studio']['entries']
        assert len([e for e in ents if e['kind'] == 'character']) == 7 and any(e['name'] == '故事阶段' for e in ents) and len([e for e in ents if e['kind'] == 'location']) == 4
        ce = next(e for e in ents if e['name'] == c0['name'])
        assert '揭露条件满足之前' in ce['content'] and '是成年人' in ce['content'] and '好感变化' in ce['content'], ce['content'][-300:]
        assert '旁白规则' in card['data']['description'] and '不替 {{user}} 说话' in card['data']['description']
        pchars = ev(page, '(id) => Object.values(NovelLoom.app.project.characters).filter((c) => c.originalCardId === id).map((c) => c.name)', card['id'])
        assert sorted(pchars) == sorted(c['name'] for c in st['outline']['cast']), pchars
        assert sorted(ev(page, 'Object.keys(NovelLoom.app.project.worldbook["地点"] || {})')) == sorted(['坠机海滩', '椰林营地', '山顶瞭望台', '废弃气象站'])
        cast_var = next(v for v in card['statusBar']['spec']['variables'] if v['path'] == '主要角色')
        print('status bar cast:', list(cast_var['init'].keys()))
        assert all(c['name'] in cast_var['init'] for c in st['outline']['cast']), '状态栏主要角色预填了全部角色'
        assert page.locator('#nl-tab [data-st-card]').count() == 1
        assert page.locator('#nl-tab [data-st-stale]').count() == 0
        # 做成卡之后侧栏不再把创意工坊标成「下一步」
        assert 'nl-next' not in page.get_attribute('.nl-nav-btn[data-tab="studio"]', 'class')
        shot(page, 'card-built')

        # ---- 写入酒馆：卡自己的世界书里有 7 个角色、故事阶段、地点 ----
        page.click('#nl-tab [data-act="publish"]')
        page.wait_for_selector('.nl-dialog-head:has-text("状态栏卡")', timeout=30000)
        dialog_ok(page, '知道了')
        wait_log(page, '已写入酒馆：角色「孤岛七日」')
        wname = ev(page, 'NovelLoom.app.project.cards.at(-1).statusBar.worldName')
        comments = ev(page, '(n) => Object.values(window.__saved.worlds[n].entries).map((e) => e.comment)', wname)
        print('world:', wname, comments)
        role_entries = [c for c in comments if c.startswith('角色 - ')]
        assert len(role_entries) == 7 and any('故事阶段' in c for c in comments) and sum(1 for c in comments if c.startswith('地点 - ')) == 4, comments
        imp = json.loads(ev(page, 'window.__saved.lastImport.text'))
        assert len(imp['data']['alternate_greetings']) == 4 and imp['data']['extensions']['world'] == wname
        assert page.locator('#nl-tab [data-act="publish"]:has-text("更新到酒馆")').count() == 1
        pub_avatar = ev(page, 'NovelLoom.app.project.cards.at(-1).stAvatar')
        card_sb_world = wname
        assert pub_avatar

        # ---- 改一段开场白后「更新卡片」：同一张卡 ----
        n_cards = ev(page, 'NovelLoom.app.project.cards.length')
        page.click('#nl-tab [data-act="goto-step"][data-step="3"]')
        page.click('#nl-tab [data-act="tab"][data-tab-key="openers"]')
        sel = f'#nl-tab [data-opener="{stages[0]["id"]}"]'
        page.fill(sel, '改过的第一段开场白：篝火边，林夏递给你一块烤鱼。')
        page.press(sel, 'Tab')
        page.click('#nl-tab [data-act="goto-step"][data-step="4"]')
        assert page.inner_text('#nl-tab [data-act="build"]') == '更新卡片'
        # 草稿改过、卡还没更新：提醒（标题旁的标签换成琥珀色、第 4 步不打勾）
        assert page.locator('#nl-tab [data-st-stale]').count() == 1
        assert '草稿改过，卡还没更新' in page.inner_text('#nl-tab .nl-st-head')
        assert 'is-done' not in page.get_attribute('#nl-tab .nl-st-step[data-step="4"]', 'class')
        n_upd = ev(page, '[...document.querySelectorAll(".nl-log-line")].filter((l) => l.textContent.includes("已更新世界卡「孤岛七日」")).length')
        page.click('#nl-tab [data-act="build"]')
        wait_idle(page)
        page.wait_for_function('(n) => [...document.querySelectorAll(".nl-log-line")].filter((l) => l.textContent.includes("已更新世界卡「孤岛七日」")).length > n', arg=n_upd)
        assert page.locator('#nl-tab [data-st-stale]').count() == 0 and '已生成卡' in page.inner_text('#nl-tab .nl-st-head')
        c2 = ev(page, '(id) => NovelLoom.app.project.cards.find((c) => c.id === id)', card['id'])
        assert ev(page, 'NovelLoom.app.project.cards.length') == n_cards and c2['data']['first_mes'].startswith('改过的第一段开场白'), c2['data']['first_mes'][:40]
        assert c2['stAvatar'] == pub_avatar and c2['statusBar']['worldName'] == card_sb_world, '写入酒馆的绑定和状态栏不变'

        # ---- 角色卡页：指引、「创意工坊」标签、「在创意工坊打开」；「去角色卡页编辑」 ----
        page.click('#nl-tab [data-act="edit-card"]')
        page.wait_for_selector('.nl-dialog [data-card="description"]', timeout=10000)
        assert page.inner_text('#nl-page-title') == '角色卡'
        close_dialog(page)
        assert '想从一句创意开始做群像卡？去「创意工坊」' in page.inner_text('#nl-tab')
        shot(page, 'cards-page')
        row = page.inner_text('#nl-tab .nl-cardbox')
        assert '创意工坊' in row and page.locator('#nl-tab .nl-cardbox [data-act="regen"]').count() == 0, row
        page.click('#nl-tab .nl-cardbox [data-act="open-studio"]')
        page.wait_for_selector('#nl-tab [data-act="build"]')
        assert page.inner_text('#nl-page-title') == '创意工坊'
        page.click('.nl-nav-btn[data-tab="cards"]')
        page.click('#nl-tab [data-act="goto-studio"]')
        page.wait_for_selector('#nl-tab .nl-st-stepper')

        # ---- 新建第二份构思（原创项目里直接放进当前项目）、重命名、删除 ----
        page.click('.nl-page-actions [data-act="new"]')
        page.wait_for_selector('#nl-tab [data-sf="premise"]')
        assert page.input_value('#nl-tab [data-sf="premise"]') == ''
        assert page.locator('#nl-tab [data-st-place]').count() == 0, '原创项目里不问放在哪里'
        page.fill('#nl-tab [data-sf="premise"]', '雪山上的旅馆被暴风雪困住，五位房客各怀秘密')
        page.click('#nl-tab [data-act="outline"]')
        page.wait_for_function('() => NovelLoom.app.project.studios.length === 2 && NovelLoom.app.project.studios.every((s) => s.outline.cast.length) && !NovelLoom.app.studioJob')
        assert ev(page, 'NovelLoom.app.project.name') == '飞机失事', '没有新建项目'
        assert ev(page, 'NovelLoom.app.project.studios[0].outline.cast.length') == 5, '「五位房客」：正好 5 人'
        assert page.locator('#nl-tab [data-st-drafts] .nl-st-draft').count() == 2
        ev(page, '() => document.querySelector(".nl-main").scrollTo(0, 0)')
        shot(page, 'two-drafts')
        assert ev(page, 'document.querySelector(".nl-nav-btn[data-tab=studio] .nl-nav-count").textContent').startswith('2')
        new_id = ev(page, 'NovelLoom.app.project.studios[0].id')
        # 阶段删光了：还在第 2 步（可以手动加阶段），「下一步」不能点，步骤条标的是「大纲」
        for _ in range(5):
            page.click('#nl-tab [data-act="stage-remove"]')
            dialog_ok(page, '删除')
            page.wait_for_timeout(150)
        page.wait_for_function('() => NovelLoom.app.project.studios[0].outline.stages.length === 0')
        assert page.locator('#nl-tab .nl-st-member').count() == 5 and '还没有阶段' in page.inner_text('#nl-tab')
        assert page.locator('#nl-tab .nl-st-step[aria-current="step"]').inner_text().strip().endswith('大纲')
        assert page.is_disabled('#nl-tab .nl-st-foot [data-act="goto-step"][data-step="3"]')
        page.click('#nl-tab [data-act="stage-add"]')
        page.wait_for_function('() => NovelLoom.app.project.studios[0].outline.stages.length === 1')
        assert ev(page, 'document.activeElement.dataset.gf') == 'name'
        page.click(f'#nl-tab [data-act="rename"][data-id="{new_id}"]')
        assert page.input_value('.nl-dialog input') == '雪夜旅馆'
        page.fill('.nl-dialog input', '暴风雪山庄')
        dialog_ok(page, '确定')
        page.wait_for_function('() => NovelLoom.app.project.studios[0].title === "暴风雪山庄"')
        page.wait_for_function('() => [...document.querySelectorAll("#nl-tab .nl-st-draft-title")].map((t) => t.textContent).join("|") === "暴风雪山庄|孤岛七日"')
        page.click(f'#nl-tab [data-act="delete"][data-id="{new_id}"]')
        page.wait_for_selector('.nl-dialog-head:has-text("删除构思")')
        dialog_ok(page, '删除')
        page.wait_for_function('() => NovelLoom.app.project.studios.length === 1')
        page.wait_for_function('() => document.querySelector("#nl-tab .nl-st-head h3")?.textContent === "孤岛七日"')
        assert page.locator('#nl-tab [data-st-drafts]').count() == 0, '只剩一份时不显示列表'

        # ---- 小说项目里写新构思：可以选放进当前项目还是新建原创项目（默认新建） ----
        page.click('.nl-nav-btn[data-tab="project"]')
        page.click('[data-act="paste"]')
        page.fill('.nl-dialog textarea', NOVEL)
        page.click('.nl-dialog-foot button:has-text("确定")')
        page.wait_for_selector('.nl-import-preview:not([hidden])')
        page.fill('#nl-bookname', '魔女')
        page.click('[data-act="create"]')
        page.wait_for_selector('.nl-chunk')
        page.click('.nl-nav-btn[data-tab="studio"]')
        page.wait_for_selector('#nl-tab [data-st-place]')
        assert page.get_attribute('#nl-tab [data-act="target"][data-val="new"]', 'aria-pressed') == 'true'
        assert '当前项目「魔女」' in page.inner_text('#nl-tab [data-st-place]')
        page.click('#nl-tab [data-act="target"][data-val="current"]')
        page.wait_for_selector('#nl-tab [data-act="target"][data-val="current"][aria-pressed="true"]')
        assert ev(page, 'NovelLoom.app.project.studios.length') == 0
        page.select_option('.nl-project-select', label='飞机失事')
        page.wait_for_function('() => NovelLoom.app.project?.name === "飞机失事"')
        page.wait_for_selector('#nl-tab .nl-st-stepper [aria-current="step"]')

        # ---- 刷新页面：草稿还在（步骤、角色、开场白、卡片关联） ----
        page.wait_for_timeout(1200)  # 等防抖保存
        saved = studio(page)
        page.reload()
        open_app(page, 'studio')
        page.wait_for_selector('#nl-tab .nl-st-stepper')
        r = studio(page)
        assert r['id'] == saved['id'] and r['step'] == 4 and len(r['outline']['cast']) == 7 and len(r['openers']) == 5 and r['cardId'] == card['id'], r['step']
        assert r['details'][c0['id']]['speech'] == '说话很慢，喜欢反问'
        assert page.locator('#nl-tab [data-act="build"]:has-text("更新卡片")').count() == 1
        shot(page, 'reloaded')

        # ---- 亮色主题（模拟一套亮色酒馆主题）：第 3 步 ----
        ev(page, '''() => { const s = document.documentElement.style; s.setProperty('--SmartThemeBodyColor', '#2b2b2e'); s.setProperty('--SmartThemeQuoteColor', '#c0632a');
            s.setProperty('--SmartThemeBlurTintColor', 'rgba(246, 245, 241, 0.97)'); document.body.style.background = '#e9e7e1'; }''')
        page.click('#nl-tab [data-act="goto-step"][data-step="3"]')
        page.wait_for_selector('#nl-tab [role="tablist"]')
        shot(page, 'light-character')
        ev(page, '''() => { const s = document.documentElement.style; ['--SmartThemeBodyColor', '--SmartThemeQuoteColor', '--SmartThemeBlurTintColor'].forEach((k) => s.removeProperty(k)); document.body.style.background = ''; }''')
        page.click('#nl-tab [data-act="goto-step"][data-step="4"]')
        page.wait_for_selector('#nl-tab [data-act="build"]')

        # ---- 窄屏：没有横向滚动，标签横向滚动 ----
        page.set_viewport_size({'width': 390, 'height': 844})
        page.wait_for_timeout(200)
        assert no_hscroll(page), '第 4 步窄屏没有横向滚动'
        shot(page, 'mobile-build')
        page.click('#nl-tab [data-act="goto-step"][data-step="3"]')
        page.wait_for_selector('#nl-tab [role="tablist"]')
        assert no_hscroll(page), '第 3 步窄屏没有横向滚动'
        tl = ev(page, '(() => { const t = document.querySelector("#nl-tab [role=tablist]"); return [t.scrollWidth, t.clientWidth]; })()')
        assert tl[0] > tl[1], f'标签在窄屏横向滚动：{tl}'
        page.click('#nl-tab [data-act="tab"][data-tab-key="openers"]')
        page.wait_for_timeout(150)
        assert ev(page, '(() => { const t = document.querySelector("#nl-tab [role=tablist]"); return t.scrollLeft > 0; })()'), '选中的标签滚进可见范围'
        ev(page, '() => document.querySelector("#nl-tab .nl-st-stepper").scrollIntoView({ block: "start" })')
        shot(page, 'mobile-openers')
        page.click(f'#nl-tab [data-act="tab"][data-tab-key="{c0["id"]}"]')
        ev(page, '() => document.querySelector("#nl-tab [role=tablist]").scrollIntoView({ block: "start" })')
        assert no_hscroll(page)
        shot(page, 'mobile-character')
        ev(page, '() => document.querySelector("#nl-tab .nl-st-group").scrollIntoView({ block: "start" })')
        shot(page, 'mobile-affection')
        page.click('#nl-tab [data-act="goto-step"][data-step="2"]')
        page.wait_for_selector('#nl-tab .nl-st-member')
        assert no_hscroll(page), '第 2 步窄屏没有横向滚动'
        ev(page, '() => document.querySelector("#nl-tab .nl-st-cast").scrollIntoView({ block: "start" })')
        # 窄屏表头放不下：每一栏自己带小标题
        caps = ev(page, '[...document.querySelectorAll("#nl-tab .nl-st-member:first-child .nl-st-cap")].map((c) => getComputedStyle(c).display !== "none" && c.textContent)')
        assert caps == ['名字', '性别', '年龄', '身份', '一句话人设', '标签'], caps
        shot(page, 'mobile-cast')
        ev(page, '() => document.querySelector("#nl-tab .nl-st-stages").scrollIntoView({ block: "start" })')
        shot(page, 'mobile-stages')
        page.click('#nl-tab [data-act="goto-step"][data-step="1"]')
        page.wait_for_selector('#nl-tab [data-sf="premise"]')
        assert no_hscroll(page), '第 1 步窄屏没有横向滚动'
        shot(page, 'mobile-premise')
        ev(page, "() => { sessionStorage.removeItem('__nl_persist'); sessionStorage.removeItem('__nl_ext'); }")
        browser.close()
finally:
    server.terminate()

real = [e for e in errors if 'favicon' not in e]
print('ERRORS:', json.dumps(real, ensure_ascii=False))
sys.exit(1 if real else 0)
