# 浏览器冒烟测试（用户画像的常用库：每一项都可以添加自定义的并保存）：
# 内置分组里「添加」常用标签（全角逗号、回车、Esc 收起、失去焦点时存下；平时同时选进画像，编辑常用标签时只存常用库；
# 存不进去的留在输入框里、旁边写明原因；雷点里有的不挪到喜欢）、「编辑常用标签」隐藏 / 恢复内置标签（隐藏画像正在用的不提示
# 「存进常用标签」；往别的分组里加隐藏的内置标签是在原分组恢复）、删掉自定义标签（键盘）、新建自定义分组（喜欢 / 雷点）、改名、删除；
# 画像里输入的标签「存进常用标签」（选分组）；叙事偏好的标签编辑与常用写法、旧版自由文字不丢（末尾带句号的认得出、退格不删整句长文字）；
# 自定义尺度（新建、校验、修改、删除后用它的画像回到默认）；从画像页「新建导向」（没改就关掉不留下）；
# 常用文字（存为常用、重复的直接提示、插入、替换要确认、删除）；写卡表单里的摘要跟着变、「管理用户画像」对话框里 Esc 只收起输入框、
# 在对话框里新建 / 删除导向模板后「卡的导向」下拉框跟着变；生成的写卡提示词里有自定义尺度的说明和叙事偏好；
# 导出（连同常用库）→ 刷新后都还在 → 在干净的设置里导入画像文件和配置；窄屏截图
import json, os, subprocess, sys, time
from playwright.sync_api import sync_playwright

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
OUT = sys.argv[1] if len(sys.argv) > 1 else '/tmp/nl-profiles-lib'
os.makedirs(OUT, exist_ok=True)
PORT = 8786
server = subprocess.Popen([sys.executable, '-m', 'http.server', str(PORT), '--bind', '127.0.0.1'], cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1)

ch1 = '第一章 魔女小姐\n' + '江酒走进酒吧。莉莉丝坐在角落，黑色长裙拖到地上。\n“没错，今晚我是来跟你提分手的。”江酒说。\n' * 18
ch2 = '第二章 女仆\n' + '江酒穿上了女仆装。小酒在镜子前转了一圈。莉莉丝去参加魔女茶会。\n' * 22
NOVEL = ch1 + ch2
ADULT = '所有涉及恋爱或亲密内容的人物（包括 {{user}}）都是成年人'
DESC1 = '感情慢慢升温，亲吻点到为止，不写性内容。'
DESC2 = '感情慢慢升温，可以有心动和暧昧的小动作，亲吻点到为止，不写性内容。'
errors = []
TOP = '.nl-dialog-overlay >> nth=-1'

def shot(page, name):
    page.wait_for_function('() => [...document.querySelectorAll(".nl-dialog-overlay, .nl-dialog")].every((d) => getComputedStyle(d).opacity === "1")')
    page.screenshot(path=os.path.join(OUT, name + '.png'))

def wait_log(page, text, timeout=30000):
    page.wait_for_function('(t) => [...document.querySelectorAll(".nl-log-line")].some(l => l.textContent.includes(t))', arg=text, timeout=timeout)

def ev(page, js, arg=None):
    return page.evaluate(js, arg) if arg is not None else page.evaluate(js)

def lib(page):
    return ev(page, 'NovelLoom.app.settings.profileLibrary')

def grp(page, gid):
    return next((g for g in lib(page)['groups'] if g['id'] == gid), {'tags': [], 'hidden': []})

def gid_by_name(page, name):
    return ev(page, '(n) => NovelLoom.app.settings.profileLibrary.groups.find((g) => g.name === n)?.id', name)

def prof(page, name='库测试'):
    return ev(page, '(n) => NovelLoom.app.settings.userProfiles.find((p) => p.name === n)', name)

def active(page, key):
    return ev(page, f'() => document.activeElement?.dataset?.{key} ?? null')

def wait_true(page, js, arg=None, timeout=10000):
    if arg is None:
        page.wait_for_function(js, timeout=timeout)
    else:
        page.wait_for_function(js, arg=arg, timeout=timeout)

def add_tag(page, kind, text, root='#nl-tab'):
    sel = f'{root} [data-up-tag-input="{kind}"]'
    page.fill(sel, text)
    page.press(sel, 'Enter')

def no_hscroll(page):
    return ev(page, 'document.documentElement.scrollWidth <= window.innerWidth + 1')

def overflowing(page, root):
    # 编辑区里超出容器右边的元素（窄屏不能撑破）
    return ev(page, '''(sel) => { const box = document.querySelector(sel); if (!box) return ['no box']; const r = box.getBoundingClientRect();
        return [...box.querySelectorAll('*')].filter((n) => { const b = n.getBoundingClientRect(); return b.width > 0 && b.right > r.right + 1 && !n.closest('.nl-sr-only'); }).slice(0, 5).map((n) => n.className + ':' + (n.textContent || '').slice(0, 20)); }''', root)

def download_profiles(page, selector, with_library=True):
    page.click(selector)
    page.wait_for_selector('.nl-dialog [data-exp-lib]')
    if not with_library:
        page.uncheck('.nl-dialog [data-exp-lib]')
    with page.expect_download() as d:
        page.click('.nl-dialog-foot .nl-primary')
    path = os.path.join(OUT, d.value.suggested_filename)
    d.value.save_as(path)
    return path

def open_app(page):
    page.wait_for_selector('#nl-wand-button')
    page.evaluate("NovelLoom.open('project')")
    page.wait_for_selector('.nl-window')

try:
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={'width': 1360, 'height': 900}, accept_downloads=True)
        page.on('pageerror', lambda e: errors.append('pageerror: ' + str(e)))
        page.on('console', lambda m: errors.append('console: ' + m.text) if m.type == 'error' else None)
        page.goto(f'http://127.0.0.1:{PORT}/tests/browser/harness.html')
        page.wait_for_selector('#nl-wand-button')
        # 扩展设置存进 sessionStorage：刷新后读回来（验证「保存」）
        ev(page, "() => { sessionStorage.setItem('__nl_persist', '1'); sessionStorage.removeItem('__nl_ext'); }")
        open_app(page)
        page.click('.nl-nav-btn[data-tab="profiles"]')
        page.click('#nl-tab [data-act="up-new"]')
        page.wait_for_selector('#nl-tab [data-up-f="name"]')
        page.fill('#nl-tab [data-up-f="name"]', '库测试')
        assert lib(page) == {'groups': [], 'intensities': [], 'style': {'tags': [], 'hidden': []}, 'snippets': []}, lib(page)

        # ---- 内置分组里「添加」常用标签：全角逗号一次加两个、回车接着加、已经有的跳过、Esc 收起（焦点回到「添加」） ----
        page.click('#nl-tab [data-act="up-lib-add"][data-kind="likes"][data-group="traits"]')
        inp = '#nl-tab [data-up-lib-input="traits"][data-kind="likes"]'
        page.wait_for_selector(inp)
        assert active(page, 'upLibInput') == 'traits', '点「添加」后焦点在输入框里'
        page.fill(inp, '猫娘，狐娘')
        wait_true(page, '() => JSON.stringify(NovelLoom.app.settings.profileLibrary.groups.find((g) => g.id === "traits")?.tags) === JSON.stringify(["猫娘", "狐娘"])')
        assert active(page, 'upLibInput') == 'traits', '加完焦点还在输入框里'
        # 平时（不在「编辑常用标签」）的「添加」：存进分组，同时选进这个画像
        assert prof(page)['likes'] == ['猫娘', '狐娘'], prof(page)['likes']
        page.fill(inp, '兔娘')
        page.press(inp, 'Enter')
        wait_true(page, '() => NovelLoom.app.settings.profileLibrary.groups.find((g) => g.id === "traits").tags.includes("兔娘")')
        assert prof(page)['likes'] == ['猫娘', '狐娘', '兔娘'], prof(page)['likes']
        assert page.get_attribute('#nl-tab [data-act="up-tag-toggle"][data-kind="likes"][data-tag="兔娘"]', 'aria-pressed') == 'true'
        # 存不进去的（已经在别的分组里）：留在输入框里，旁边写明原因（日志条在对话框里看不到）
        page.fill(inp, '傲娇')
        page.press(inp, 'Enter')
        wait_log(page, '「傲娇」已经在「角色属性」里')
        page.wait_for_selector('#nl-tab [data-up-group="traits"] [data-up-lib-note]')
        assert '「傲娇」已经在「角色属性」里' in page.inner_text('#nl-tab [data-up-lib-note]')
        assert page.input_value(inp) == '傲娇', '没存进去的留在输入框里'
        assert active(page, 'upLibInput') == 'traits'
        assert page.get_attribute(inp, 'aria-describedby') == page.get_attribute('#nl-tab [data-up-lib-note]', 'id')
        assert prof(page)['likes'] == ['猫娘', '狐娘', '兔娘'], '跳过的不加进画像'
        shot(page, '01a-lib-add-note')
        page.press(inp, 'Escape')
        page.wait_for_selector(inp, state='detached')
        assert page.locator('#nl-tab [data-up-lib-note]').count() == 0, 'Esc 收起时提示也收起'
        assert active(page, 'act') == 'up-lib-add' and active(page, 'group') == 'traits', 'Esc 收起后焦点回到「添加」'
        assert grp(page, 'traits')['tags'] == ['猫娘', '狐娘', '兔娘'], grp(page, 'traits')
        # 自定义的标签在建议里带小圆点，和内置的区分开；点一下从画像里去掉
        assert page.locator('#nl-tab [data-act="up-tag-toggle"][data-kind="likes"][data-tag="猫娘"] .nl-up-dot').count() == 1
        assert page.locator('#nl-tab [data-act="up-tag-toggle"][data-kind="likes"][data-tag="傲娇"] .nl-up-dot').count() == 0
        page.click('#nl-tab [data-act="up-tag-toggle"][data-kind="likes"][data-tag="狐娘"]')
        page.click('#nl-tab [data-act="up-tag-toggle"][data-kind="likes"][data-tag="兔娘"]')
        assert prof(page)['likes'] == ['猫娘'], prof(page)['likes']
        # 输入了没按回车、直接去点尺度：文字存进分组（也选进画像）、输入框收起，尺度这一下点击也没有丢
        page.click('#nl-tab [data-act="up-lib-add"][data-kind="likes"][data-group="looks"]')
        page.fill('#nl-tab [data-up-lib-input="looks"]', '短发')
        page.click('#nl-tab [data-act="up-intensity"][data-val="sfw"]')
        wait_true(page, '() => NovelLoom.app.settings.userProfiles[0].intensity === "sfw"')
        wait_true(page, '() => (NovelLoom.app.settings.profileLibrary.groups.find((g) => g.id === "looks")?.tags || []).includes("短发")')
        page.wait_for_selector('#nl-tab [data-up-lib-input]', state='detached')
        assert prof(page)['likes'] == ['猫娘', '短发'], prof(page)['likes']
        shot(page, '01-lib-added')
        page.click('#nl-tab [data-act="up-tag-toggle"][data-kind="likes"][data-tag="短发"]')
        assert prof(page)['likes'] == ['猫娘'], prof(page)['likes']
        # 雷点里有的标签：存进喜欢的分组，但不悄悄从雷点挪到喜欢（旁边说明）
        add_tag(page, 'dislikes', '眼罩')
        page.click('#nl-tab [data-act="up-lib-add"][data-kind="likes"][data-group="looks"]')
        page.fill('#nl-tab [data-up-lib-input="looks"]', '眼罩')
        page.press('#nl-tab [data-up-lib-input="looks"]', 'Enter')
        page.wait_for_selector('#nl-tab [data-up-group="looks"] [data-up-lib-note]')
        assert '在这个画像的雷点里' in page.inner_text('#nl-tab [data-up-lib-note]')
        assert '眼罩' in grp(page, 'looks')['tags'] and prof(page)['dislikes'] == ['眼罩'] and prof(page)['likes'] == ['猫娘'], prof(page)
        page.keyboard.type('x')
        page.wait_for_selector('#nl-tab [data-up-lib-note]', state='detached')
        page.press('#nl-tab [data-up-lib-input="looks"]', 'Escape')
        page.click('#nl-tab [data-up-tagbox="dislikes"] [data-act="up-tag-remove"][data-tag="眼罩"]')
        assert prof(page)['dislikes'] == [], prof(page)['dislikes']

        # ---- 编辑常用标签：隐藏内置（焦点到下一个）、恢复默认、用键盘删掉自定义的 ----
        page.click('#nl-tab [data-act="up-tag-toggle"][data-kind="likes"][data-tag="傲娇"]')
        assert prof(page)['likes'] == ['猫娘', '傲娇']
        page.click('#nl-tab [data-act="up-lib-edit"][data-kind="likes"]')
        page.wait_for_selector('#nl-tab [data-up-sugg="likes"].nl-up-editing')
        assert page.inner_text('#nl-tab [data-act="up-lib-edit"][data-kind="likes"]') == '完成编辑'
        assert page.get_attribute('#nl-tab [data-act="up-lib-edit"][data-kind="likes"]', 'aria-label') == '完成编辑喜欢的元素的常用标签'
        assert page.get_attribute('#nl-tab [data-act="up-lib-edit"][data-kind="dislikes"]', 'aria-label') == '编辑雷点的常用标签', '两个「编辑常用标签」读屏念得出是哪一类'
        # 隐藏画像正在用的内置标签：不会马上又提示「存进常用标签」
        page.click('#nl-tab [data-act="up-lib-tag-remove"][data-kind="likes"][data-group="traits"][data-tag="傲娇"]')
        assert grp(page, 'traits')['hidden'] == ['傲娇']
        assert page.locator('#nl-tab [data-up-unsaved="likes"]').count() == 0, '隐藏的内置标签不算「不在常用标签里」'
        # 往别的分组里加一个隐藏的内置标签：在它原来的分组里恢复显示，不多存一份（编辑常用标签时只存常用库，不选进画像）
        assert page.inner_text('#nl-tab [data-act="up-lib-add"][data-kind="likes"][data-group="looks"]').strip() == '添加常用'
        page.click('#nl-tab [data-act="up-lib-add"][data-kind="likes"][data-group="looks"]')
        page.fill('#nl-tab [data-up-lib-input="looks"]', '傲娇')
        page.press('#nl-tab [data-up-lib-input="looks"]', 'Enter')
        page.wait_for_selector('#nl-tab [data-up-group="looks"] [data-up-lib-note]')
        assert '「傲娇」是「角色属性」里隐藏的内置标签，已经在那里恢复显示' in page.inner_text('#nl-tab [data-up-lib-note]')
        assert grp(page, 'traits')['hidden'] == [] and '傲娇' not in grp(page, 'looks')['tags'], (grp(page, 'traits'), grp(page, 'looks'))
        assert page.locator('#nl-tab [data-up-sugg="likes"] [data-tag="傲娇"]').count() == 1, '傲娇 只出现一次'
        page.press('#nl-tab [data-up-lib-input="looks"]', 'Escape')
        assert prof(page)['likes'] == ['猫娘', '傲娇'], prof(page)['likes']
        page.click('#nl-tab [data-up-tagbox="likes"] [data-act="up-tag-remove"][data-tag="傲娇"]')
        assert prof(page)['likes'] == ['猫娘'], prof(page)['likes']
        page.click('#nl-tab [data-act="up-lib-tag-remove"][data-kind="likes"][data-group="traits"][data-tag="人妻"]')
        assert grp(page, 'traits')['hidden'] == ['人妻']
        assert active(page, 'tag') == '青梅竹马', '隐藏后焦点在下一个标签的 × 上'
        page.wait_for_selector('#nl-tab [data-act="up-lib-restore"][data-group="traits"]')
        assert '角色属性' in page.get_attribute('#nl-tab [data-act="up-lib-restore"][data-group="traits"]', 'aria-label')
        assert '恢复默认（1）' in page.inner_text('#nl-tab [data-act="up-lib-restore"][data-group="traits"]')
        page.click('#nl-tab [data-act="up-lib-restore"][data-group="traits"]')
        assert grp(page, 'traits')['hidden'] == []
        assert active(page, 'act') == 'up-lib-add'
        page.click('#nl-tab [data-act="up-lib-tag-remove"][data-kind="likes"][data-group="traits"][data-tag="人妻"]')
        page.focus('#nl-tab [data-act="up-lib-tag-remove"][data-group="traits"][data-tag="狐娘"]')
        page.keyboard.press('Enter')
        wait_true(page, '() => !NovelLoom.app.settings.profileLibrary.groups.find((g) => g.id === "traits").tags.includes("狐娘")')
        assert active(page, 'tag') == '兔娘', '删掉后焦点在下一个'
        assert prof(page)['likes'] == ['猫娘'], '画像里的标签不受影响'

        # ---- 自定义分组：喜欢（回车提交）、雷点（从「喜欢」这里新建，选「用在 雷点」）、重名提示、改名、删除 ----
        page.click('#nl-tab [data-act="up-lib-group-new"][data-kind="likes"]')
        page.wait_for_selector('.nl-dialog [data-g-name]')
        page.fill('.nl-dialog [data-g-name]', '兽人')
        page.press('.nl-dialog [data-g-name]', 'Enter')
        page.wait_for_selector('.nl-dialog', state='detached')
        g_beast = gid_by_name(page, '兽人')
        assert g_beast and grp(page, g_beast)['target'] == 'likes'
        page.wait_for_function('(id) => document.activeElement?.dataset?.upLibInput === id', arg=g_beast)
        page.keyboard.type('狼人')
        page.keyboard.press('Enter')
        wait_true(page, '(id) => NovelLoom.app.settings.profileLibrary.groups.find((g) => g.id === id).tags.includes("狼人")', g_beast)
        page.keyboard.press('Escape')
        page.click('#nl-tab [data-act="up-lib-group-new"][data-kind="likes"]')
        page.wait_for_selector('.nl-dialog [data-g-name]')
        page.fill('.nl-dialog [data-g-name]', '角色属性')
        page.click('.nl-dialog-foot .nl-primary')
        page.wait_for_selector('.nl-dialog [data-form-err]:not([hidden])')
        assert '已经有同名的分组' in page.inner_text('.nl-dialog [data-form-err]')
        page.fill('.nl-dialog [data-g-name]', '我的雷点')
        page.check('.nl-dialog input[name="nl-up-g-target"][value="dislikes"]')
        shot(page, '02-new-group-dialog')
        page.click('.nl-dialog-foot .nl-primary')
        page.wait_for_selector('.nl-dialog', state='detached')
        g_mine = gid_by_name(page, '我的雷点')
        assert grp(page, g_mine)['target'] == 'dislikes'
        page.wait_for_function('(id) => document.activeElement?.dataset?.upLibInput === id && document.activeElement.dataset.kind === "dislikes"', arg=g_mine)
        # 新建的分组在「雷点」：雷点那一类也进入编辑常用标签（接着输入的只存进分组，不选进画像）
        page.wait_for_selector('#nl-tab [data-up-sugg="dislikes"].nl-up-editing')
        page.keyboard.type('黑暗结局')
        page.keyboard.press('Enter')
        wait_true(page, '(id) => NovelLoom.app.settings.profileLibrary.groups.find((g) => g.id === id).tags.includes("黑暗结局")', g_mine)
        assert prof(page)['dislikes'] == [], prof(page)['dislikes']
        page.keyboard.press('Escape')
        assert page.locator(f'#nl-tab [data-up-tags="dislikes"] [data-up-group="{g_mine}"]').count() == 1, '雷点的分组出现在「雷点」下面'
        page.click('#nl-tab [data-act="up-lib-edit"][data-kind="dislikes"]')
        page.wait_for_selector('#nl-tab [data-up-sugg="dislikes"]:not(.nl-up-editing)')
        page.click(f'#nl-tab [data-act="up-lib-group-rename"][data-group="{g_beast}"]')
        page.wait_for_selector('.nl-dialog [data-g-name]')
        page.fill('.nl-dialog [data-g-name]', '兽人控')
        page.press('.nl-dialog [data-g-name]', 'Enter')
        page.wait_for_selector('.nl-dialog', state='detached')
        assert grp(page, g_beast)['name'] == '兽人控'
        assert active(page, 'act') == 'up-lib-group-rename'
        page.click('#nl-tab [data-act="up-lib-group-new"][data-kind="likes"]')
        page.fill('.nl-dialog [data-g-name]', '临时组')
        page.click('.nl-dialog-foot .nl-primary')
        page.wait_for_selector('.nl-dialog', state='detached')
        g_tmp = gid_by_name(page, '临时组')
        page.keyboard.press('Escape')
        page.click(f'#nl-tab [data-act="up-lib-group-delete"][data-group="{g_tmp}"]')
        page.wait_for_selector('.nl-dialog')
        assert '已经加到画像里的标签不受影响' in page.inner_text('.nl-dialog-body')
        page.click('.nl-dialog-foot button:has-text("删除")')
        wait_true(page, '() => !NovelLoom.app.settings.profileLibrary.groups.some((g) => g.name === "临时组")')
        page.locator('#nl-tab [data-up-sugg="likes"]').scroll_into_view_if_needed()
        shot(page, '03-lib-editing')
        page.click('#nl-tab [data-act="up-lib-edit"][data-kind="likes"]')
        page.wait_for_selector('#nl-tab [data-up-sugg="likes"]:not(.nl-up-editing)')
        assert page.locator(f'#nl-tab [data-up-group="{g_beast}"] .nl-up-sugg-name .nl-up-dot').count() == 1, '自定义分组名带小圆点'

        # ---- 画像里输入的标签存进常用标签（选分组 / 自定义分组） ----
        add_tag(page, 'likes', '眼镜娘')
        page.wait_for_selector('#nl-tab [data-up-unsaved="likes"]')
        assert '「眼镜娘」不在常用标签里' in page.inner_text('#nl-tab [data-up-unsaved="likes"]')
        page.click('#nl-tab [data-act="up-lib-save-typed"][data-kind="likes"]')
        page.wait_for_selector('.nl-dialog [data-s-group]')
        page.select_option('.nl-dialog [data-s-group]', 'looks')
        shot(page, '04-save-typed-dialog')
        page.click('.nl-dialog-foot .nl-primary')
        page.wait_for_selector('.nl-dialog', state='detached')
        assert '眼镜娘' in grp(page, 'looks')['tags'], grp(page, 'looks')
        page.wait_for_selector('#nl-tab [data-up-unsaved="likes"]', state='detached')
        assert active(page, 'upTagInput') == 'likes'
        add_tag(page, 'dislikes', '鬼畜')
        page.click('#nl-tab [data-act="up-lib-save-typed"][data-kind="dislikes"]')
        page.wait_for_selector('.nl-dialog [data-s-group]')
        page.select_option('.nl-dialog [data-s-group]', g_mine)
        page.click('.nl-dialog-foot .nl-primary')
        page.wait_for_selector('.nl-dialog', state='detached')
        assert grp(page, g_mine)['tags'] == ['黑暗结局', '鬼畜'], grp(page, g_mine)
        # 存好的自定义雷点：点选加进画像
        page.click(f'#nl-tab [data-act="up-tag-toggle"][data-kind="dislikes"][data-tag="黑暗结局"]')
        assert prof(page)['dislikes'] == ['鬼畜', '黑暗结局'], prof(page)['dislikes']

        # ---- 叙事偏好：点选建议、粘贴一串、存进常用写法、「添加」、隐藏内置 ----
        page.click('#nl-tab [data-act="up-tag-toggle"][data-kind="style"][data-tag="第二人称"]')
        assert prof(page)['style'] == '第二人称'
        page.fill('#nl-tab [data-up-tag-input="style"]', '多写环境和感官细节、短句')
        wait_true(page, '() => NovelLoom.app.settings.userProfiles[0].style === "第二人称、多写环境和感官细节、短句"')
        page.wait_for_selector('#nl-tab [data-up-unsaved="style"]')
        page.click('#nl-tab [data-act="up-lib-save-typed"][data-kind="style"]')
        wait_true(page, '() => JSON.stringify(NovelLoom.app.settings.profileLibrary.style.tags) === JSON.stringify(["多写环境和感官细节", "短句"])')
        page.wait_for_selector('#nl-tab [data-up-unsaved="style"]', state='detached')
        page.click('#nl-tab [data-act="up-lib-add"][data-kind="style"][data-group="style"]')
        page.fill('#nl-tab [data-up-lib-input="style"]', '慢节奏')
        page.press('#nl-tab [data-up-lib-input="style"]', 'Enter')
        wait_true(page, '() => NovelLoom.app.settings.profileLibrary.style.tags.includes("慢节奏")')
        assert prof(page)['style'] == '第二人称、多写环境和感官细节、短句、慢节奏', prof(page)['style']
        page.press('#nl-tab [data-up-lib-input="style"]', 'Escape')
        page.click('#nl-tab [data-act="up-tag-toggle"][data-kind="style"][data-tag="慢节奏"]')
        assert prof(page)['style'] == '第二人称、多写环境和感官细节、短句', prof(page)['style']
        page.click('#nl-tab [data-act="up-lib-edit"][data-kind="style"]')
        page.click('#nl-tab [data-act="up-lib-tag-remove"][data-kind="style"][data-tag="文艺"]')
        assert lib(page)['style']['hidden'] == ['文艺']
        page.click('#nl-tab [data-act="up-lib-edit"][data-kind="style"]')
        assert page.locator('#nl-tab [data-act="up-tag-toggle"][data-kind="style"][data-tag="文艺"]').count() == 0
        assert page.locator('#nl-tab [data-act="up-tag-toggle"][data-kind="style"][data-tag="慢节奏"] .nl-up-dot').count() == 1
        page.locator('#nl-tab [data-up-tags="style"]').scroll_into_view_if_needed()
        shot(page, '05-style-tags')

        # 旧版自由填写的叙事偏好：拆成一项一项显示，不丢字；改动后用「、」连起来
        page.click('#nl-page-actions [data-act="up-new"]')
        wait_true(page, '() => NovelLoom.app.settings.userProfiles.length === 2')
        page.fill('#nl-tab [data-up-f="name"]', '旧版')
        legacy = '用第二人称写，多写心理活动和环境描写，不要写太多对话。'
        ev(page, '(t) => { NovelLoom.app.settings.userProfiles[1].style = t; }', legacy)
        page.click('#nl-tab [data-up-list] [data-up-id] >> text=库测试')
        page.click('#nl-tab [data-up-list] [data-up-id] >> text=旧版')
        chips = ev(page, '() => [...document.querySelectorAll("#nl-tab [data-up-tagbox=style] .nl-up-chip-t")].map((c) => c.textContent)')
        print('legacy style chips:', chips)
        assert chips == ['用第二人称写', '多写心理活动和环境描写', '不要写太多对话。'], chips
        assert prof(page, '旧版')['style'] == legacy, '没动过时原样保留'
        page.click('#nl-tab [data-act="up-tag-toggle"][data-kind="style"][data-tag="节奏快"]')
        assert prof(page, '旧版')['style'] == '用第二人称写、多写心理活动和环境描写、不要写太多对话、节奏快', prof(page, '旧版')['style']

        def reload_old(style):
            ev(page, '(t) => { NovelLoom.app.settings.userProfiles.find((p) => p.name === "旧版").style = t; }', style)
            page.click('#nl-tab [data-up-list] [data-up-id] >> text=库测试')
            page.click('#nl-tab [data-up-list] [data-up-id] >> text=旧版')
            page.wait_for_function('() => document.querySelector("#nl-tab [data-up-f=name]").value === "旧版"')

        # 叙事偏好末尾带标点的旧文字：认得出是内置写法（按下的、不提示存进常用写法），点一下就去掉
        reload_old('第二人称，细腻心理。')
        assert page.get_attribute('#nl-tab [data-act="up-tag-toggle"][data-kind="style"][data-tag="细腻心理"]', 'aria-pressed') == 'true'
        assert page.locator('#nl-tab [data-up-unsaved="style"]').count() == 0
        page.click('#nl-tab [data-act="up-tag-toggle"][data-kind="style"][data-tag="细腻心理"]')
        assert prof(page, '旧版')['style'] == '第二人称', prof(page, '旧版')['style']
        # 「添加」带句号的写法：存进去的没有句号，和画像里的是同一项，点一下就能去掉（不会越点越多）
        page.click('#nl-tab [data-act="up-lib-add"][data-kind="style"][data-group="style"]')
        page.fill('#nl-tab [data-up-lib-input="style"]', '多写对话。')
        page.press('#nl-tab [data-up-lib-input="style"]', 'Enter')
        wait_true(page, '() => NovelLoom.app.settings.profileLibrary.style.tags.includes("多写对话")')
        assert '多写对话。' not in lib(page)['style']['tags']
        assert prof(page, '旧版')['style'] == '第二人称、多写对话', prof(page, '旧版')['style']
        page.press('#nl-tab [data-up-lib-input="style"]', 'Escape')
        sugg = '#nl-tab [data-act="up-tag-toggle"][data-kind="style"][data-tag="多写对话"]'
        assert page.get_attribute(sugg, 'aria-pressed') == 'true'
        page.click(sugg)
        assert prof(page, '旧版')['style'] == '第二人称', prof(page, '旧版')['style']
        assert page.get_attribute(sugg, 'aria-pressed') == 'false'
        # 退格不会一下删掉旧版留下的整句长文字（只能点它的 ×）；短的一项照样能退格删
        LONG = '一整句很长很长的旧版叙事偏好没有任何逗号也照样保留不截短'
        reload_old('第二人称，' + LONG)
        page.focus('#nl-tab [data-up-tag-input="style"]')
        page.keyboard.press('Backspace')
        time.sleep(0.2)
        assert prof(page, '旧版')['style'] == '第二人称，' + LONG, prof(page, '旧版')['style']
        page.click(f'#nl-tab [data-up-tagbox="style"] [data-act="up-tag-remove"][data-tag="{LONG}"]')
        assert prof(page, '旧版')['style'] == '第二人称', prof(page, '旧版')['style']
        page.focus('#nl-tab [data-up-tag-input="style"]')
        page.keyboard.press('Backspace')
        wait_true(page, '() => NovelLoom.app.settings.userProfiles.find((p) => p.name === "旧版").style === ""')
        page.click('#nl-tab [data-up-list] [data-up-id] >> text=库测试')
        page.wait_for_function('() => document.querySelector("#nl-tab [data-up-f=name]").value === "库测试"')

        # ---- 自定义尺度：校验、新建（用在这个画像上）、修改说明、删掉正在用的尺度（回到默认） ----
        page.click('#nl-tab [data-act="up-int-new"]')
        page.wait_for_selector('.nl-dialog [data-i-name]')
        page.fill('.nl-dialog [data-i-name]', '清水')
        page.click('.nl-dialog-foot .nl-primary')
        page.wait_for_selector('.nl-dialog [data-form-err]:not([hidden])')
        assert '和内置的尺度重名' in page.inner_text('.nl-dialog [data-form-err]')
        page.fill('.nl-dialog [data-i-name]', '纯情慢热')
        page.click('.nl-dialog-foot .nl-primary')
        page.wait_for_function('() => document.querySelector(".nl-dialog [data-form-err]").textContent.includes("说明不能为空")')
        page.fill('.nl-dialog [data-i-desc]', DESC1)
        shot(page, '06-intensity-dialog')
        page.click('.nl-dialog-foot .nl-primary')
        page.wait_for_selector('.nl-dialog', state='detached')
        iid = lib(page)['intensities'][0]['id']
        assert prof(page)['intensity'] == iid
        assert active(page, 'val') == iid, '焦点在新建的尺度上'
        assert '感情慢慢升温' in page.inner_text('#nl-tab [data-up-int-hint]') and '成年人' in page.inner_text('#nl-tab [data-up-int-hint]')
        page.click('#nl-tab [data-act="up-int-manage"]')
        page.click(f'#nl-tab [data-act="up-int-edit"][data-val="{iid}"]')
        page.wait_for_selector('.nl-dialog [data-i-desc]')
        assert page.input_value('.nl-dialog [data-i-name]') == '纯情慢热'
        page.fill('.nl-dialog [data-i-desc]', DESC2)
        page.click('.nl-dialog-foot .nl-primary')
        page.wait_for_selector('.nl-dialog', state='detached')
        assert lib(page)['intensities'][0]['desc'] == DESC2
        page.click('#nl-tab [data-act="up-int-new"]')
        page.fill('.nl-dialog [data-i-name]', '临时')
        page.fill('.nl-dialog [data-i-desc]', '临时的说明')
        page.click('.nl-dialog-foot .nl-primary')
        page.wait_for_selector('.nl-dialog', state='detached')
        tid = next(x['id'] for x in lib(page)['intensities'] if x['name'] == '临时')
        assert prof(page)['intensity'] == tid
        page.locator('#nl-tab [data-up-int-list]').scroll_into_view_if_needed()
        shot(page, '07-intensity-manage')
        page.click(f'#nl-tab [data-act="up-int-delete"][data-val="{tid}"]')
        page.wait_for_selector('.nl-dialog')
        assert '有 1 个画像正在用它，删除后改回默认的「暧昧擦边」' in page.inner_text('.nl-dialog-body')
        page.click('.nl-dialog-foot button:has-text("删除")')
        wait_true(page, '() => NovelLoom.app.settings.profileLibrary.intensities.length === 1')
        assert prof(page)['intensity'] == 'suggestive'
        wait_log(page, '1 个画像改回了默认的「暧昧擦边」')
        page.click(f'#nl-tab [data-act="up-intensity"][data-val="{iid}"]')
        assert prof(page)['intensity'] == iid
        assert '纯情慢热' in page.inner_text('#nl-tab [data-up-list]'), '左边列表的摘要用自定义尺度的名字'

        # ---- 偏好的导向：点了「新建导向」又什么都没改就关掉（Esc / 关闭）：当作取消，不留下空模板、不加进画像 ----
        n_tpl = ev(page, '() => (NovelLoom.app.settings.orientationTemplates || []).length')
        orients_before = prof(page)['orientations']
        page.click('#nl-tab [data-act="up-orient-new"]')
        page.wait_for_selector('.nl-dialog [data-ot-f="name"]')
        assert ev(page, '() => NovelLoom.app.settings.orientationTemplates.length') == n_tpl + 1
        page.keyboard.press('Escape')
        page.wait_for_selector('.nl-dialog', state='detached')
        assert ev(page, '() => NovelLoom.app.settings.orientationTemplates.length') == n_tpl, '没改过的新模板关掉后丢掉'
        assert prof(page)['orientations'] == orients_before
        assert active(page, 'act') == 'up-orient-new'
        page.click('#nl-tab [data-act="up-orient-new"]')
        page.wait_for_selector('.nl-dialog [data-ot-f="name"]')
        page.click('.nl-dialog-foot button:has-text("关闭")')
        page.wait_for_selector('.nl-dialog', state='detached')
        assert ev(page, '() => NovelLoom.app.settings.orientationTemplates.length') == n_tpl
        assert prof(page)['orientations'] == orients_before
        # ---- 偏好的导向：从画像页新建导向，改过后关掉，马上出现并选上 ----
        page.click('#nl-tab [data-act="up-orient-new"]')
        page.wait_for_selector('.nl-dialog [data-ot-f="name"]')
        assert active(page, 'otF') == 'name', '新建的导向模板：焦点在名称上'
        page.fill('.nl-dialog [data-ot-f="name"]', '师徒')
        page.fill('.nl-dialog [data-ot-f="brief"]', '师父与徒弟之间慢慢越界的感情')
        page.click('.nl-dialog-foot button:has-text("关闭")')
        page.wait_for_selector('.nl-dialog', state='detached')
        oid = ev(page, '() => NovelLoom.app.settings.orientationTemplates.find((t) => t.name === "师徒")?.id')
        assert oid and oid in prof(page)['orientations'], prof(page)['orientations']
        orient_btn = f'#nl-tab [data-act="up-orient"][data-orient-id="{oid}"]'
        assert page.get_attribute(orient_btn, 'aria-pressed') == 'true'
        assert page.locator(orient_btn + ' .nl-up-dot').count() == 1, '我的导向模板带小圆点'
        assert active(page, 'orientId') == oid

        # ---- 常用文字：存为常用（默认名称、回车确认）、插入、接在后面插入、替换、删除 ----
        P1 = '二十五岁的男性上班族，个子高、话不多'
        P2 = '三十岁的女性医生'
        page.fill('#nl-tab [data-up-f="persona"]', P1)
        assert page.get_attribute('#nl-tab [data-act="up-snip-save"][data-field="persona"]', 'aria-label') == '把「{{user}} 的默认形象」的文字存为常用'
        assert page.get_attribute('#nl-tab [data-act="up-snip-save"][data-field="notes"]', 'aria-label') == '把「其他」的文字存为常用'
        page.click('#nl-tab [data-act="up-snip-save"][data-field="persona"]')
        page.wait_for_selector('.nl-dialog input')
        assert page.input_value('.nl-dialog input') == '二十五岁的男性上班族，个…', page.input_value('.nl-dialog input')
        # 名称输入框和问题关联（读屏念得出问的是什么），限 20 字
        assert page.get_attribute('.nl-dialog label', 'for') == page.get_attribute('.nl-dialog input', 'id')
        assert page.get_attribute('.nl-dialog input', 'maxlength') == '20'
        page.fill('.nl-dialog input', '上班族')
        page.press('.nl-dialog input', 'Enter')
        page.wait_for_selector('.nl-dialog', state='detached')
        # 一样的文字再存一次：不先让你起名字，按钮旁边直接说明已经存过了；改了文字提示就收起
        page.click('#nl-tab [data-act="up-snip-save"][data-field="persona"]')
        page.wait_for_selector('#nl-tab [data-up-snip-note]')
        assert page.locator('.nl-dialog').count() == 0, '没有弹出起名字的对话框'
        assert '一样的内容已经存过了（「上班族」）' in page.inner_text('#nl-tab [data-up-snip-note]')
        page.focus('#nl-tab [data-up-f="persona"]')
        page.keyboard.type('。')
        page.wait_for_selector('#nl-tab [data-up-snip-note]', state='detached')
        page.fill('#nl-tab [data-up-f="persona"]', P2)
        page.click('#nl-tab [data-act="up-snip-save"][data-field="persona"]')
        page.wait_for_selector('.nl-dialog input')
        page.fill('.nl-dialog input', '医生')
        page.press('.nl-dialog input', 'Enter')
        page.wait_for_selector('.nl-dialog', state='detached')
        assert [s['name'] for s in lib(page)['snippets']] == ['上班族', '医生']
        assert '插入常用…（2）' in page.inner_text('#nl-tab [data-act="up-snip-insert"][data-field="persona"]')
        page.fill('#nl-tab [data-up-f="persona"]', '')
        page.click('#nl-tab [data-act="up-snip-insert"][data-field="persona"]')
        page.wait_for_selector('.nl-dialog [data-snip-act="insert"]')
        page.wait_for_function('() => document.activeElement?.dataset?.snipAct === "insert"')
        shot(page, '08-snippets-dialog')
        page.click('.nl-dialog [data-snip-act="insert"] >> nth=0')
        page.wait_for_selector('.nl-dialog', state='detached')
        assert prof(page)['persona'] == P1
        assert active(page, 'upF') == 'persona'
        page.click('#nl-tab [data-act="up-snip-insert"][data-field="persona"]')
        page.click('.nl-dialog [data-snip-act="insert"] >> nth=1')
        page.wait_for_selector('.nl-dialog', state='detached')
        assert prof(page)['persona'] == P1 + '\n' + P2, prof(page)['persona']
        # 替换会扔掉现有的文字：先确认；取消就不动
        assert page.get_attribute('#nl-tab [data-act="up-snip-insert"][data-field="persona"]', 'aria-label') == '插入「{{user}} 的默认形象」的常用文字（2 条）'
        page.click('#nl-tab [data-act="up-snip-insert"][data-field="persona"]')
        page.click('.nl-dialog [data-snip-act="replace"] >> nth=0')
        page.wait_for_function('() => document.querySelector(".nl-dialog-body")?.textContent.includes("替换现有的")')
        assert '用「上班族」替换现有的' in page.inner_text('.nl-dialog-body')
        page.click('.nl-dialog-foot button:has-text("取消")')
        page.wait_for_selector('.nl-dialog', state='detached')
        assert prof(page)['persona'] == P1 + '\n' + P2, '取消替换：文字不动'
        assert active(page, 'act') == 'up-snip-insert'
        page.click('#nl-tab [data-act="up-snip-insert"][data-field="persona"]')
        page.click('.nl-dialog [data-snip-act="replace"] >> nth=0')
        page.wait_for_function('() => document.querySelector(".nl-dialog-body")?.textContent.includes("替换现有的")')
        page.click('.nl-dialog-foot button:has-text("替换")')
        page.wait_for_selector('.nl-dialog', state='detached')
        assert prof(page)['persona'] == P1
        page.click('#nl-tab [data-act="up-snip-insert"][data-field="persona"]')
        page.click('.nl-dialog [data-snip-act="delete"] >> nth=1')
        page.click(TOP + ' >> .nl-dialog-foot button:has-text("删除")')
        page.wait_for_function('() => document.querySelectorAll(".nl-dialog [data-snip-act=insert]").length === 1')
        page.click('.nl-dialog-foot button:has-text("关闭")')
        page.wait_for_selector('.nl-dialog', state='detached')
        assert [s['name'] for s in lib(page)['snippets']] == ['上班族']
        assert '插入常用…（1）' in page.inner_text('#nl-tab [data-act="up-snip-insert"][data-field="persona"]')
        page.fill('#nl-tab [data-up-f="notes"]', '喜欢有来有回的斗嘴')
        page.click('#nl-tab [data-act="up-snip-save"][data-field="notes"]')
        page.wait_for_selector('.nl-dialog input')
        page.press('.nl-dialog input', 'Enter')
        page.wait_for_selector('.nl-dialog', state='detached')
        assert [(s['field'], s['name']) for s in lib(page)['snippets']] == [('persona', '上班族'), ('notes', '喜欢有来有回的斗嘴')]
        prof_id = prof(page)['id']

        # ---- 写卡：表单摘要用自定义尺度；在「管理用户画像」对话框里改尺度的名字，关掉后摘要马上变；Esc 只收起「添加」输入框 ----
        page.click('.nl-nav-btn[data-tab="project"]')
        page.click('[data-act="paste"]')
        page.fill('.nl-dialog textarea', NOVEL)
        page.click('.nl-dialog-foot button:has-text("确定")')
        page.wait_for_selector('.nl-import-preview:not([hidden])')
        page.fill('[data-setting="chunking.chunkSize"]', '1000')
        page.dispatch_event('[data-setting="chunking.chunkSize"]', 'input')
        page.dispatch_event('[data-setting="chunking.chunkSize"]', 'change')
        page.fill('#nl-bookname', '魔女')
        page.click('[data-act="create"]')
        page.wait_for_selector('.nl-chunk')
        page.click('.nl-nav-btn[data-tab="extract"]')
        page.click('#nl-tab [data-act="start"]')
        wait_log(page, '提取结束', timeout=60000)
        page.click('.nl-nav-btn[data-tab="cards"]')
        page.select_option('[data-form="charName"]', '莉莉丝')
        page.select_option('[data-form="userProfileId"]', prof_id)
        summary = page.inner_text('[data-up-summary]')
        print('form summary:', summary)
        assert '尺度 纯情慢热' in summary and '猫娘' in summary, summary
        page.click('[data-act="profile-manage"]')
        page.wait_for_selector('.nl-dialog .nl-up-dialog [data-up-f="name"]')
        # 「已选 n / 40 · 也可以输入……」一行放不下时，「编辑常用标签」整个换到下一行，说明文字不会只剩一两个字落在第二行
        lines = ev(page, '''() => ['likes', 'dislikes'].map((k) => { const el = document.querySelector(`.nl-dialog #nl-up-${k}-count`); const r = document.createRange(); r.selectNodeContents(el);
            return new Set([...r.getClientRects()].map((x) => Math.round(x.top))).size; })''')
        print('count text lines in dialog:', lines)
        assert lines == [1, 1], lines
        page.click('.nl-dialog [data-act="up-lib-add"][data-kind="likes"][data-group="kinks"]')
        page.fill('.nl-dialog [data-up-lib-input="kinks"]', '恋手')
        page.press('.nl-dialog [data-up-lib-input="kinks"]', 'Escape')
        page.wait_for_selector('.nl-dialog [data-up-lib-input="kinks"]', state='detached')
        assert page.is_visible('.nl-dialog .nl-up-dialog'), 'Esc 只收起输入框，对话框还在'
        assert '恋手' not in grp(page, 'kinks')['tags'], 'Esc 不存'
        page.click('.nl-dialog [data-act="up-int-manage"]')
        page.click(f'.nl-dialog [data-act="up-int-edit"][data-val="{iid}"]')
        page.wait_for_selector(TOP + ' >> [data-i-name]')
        page.fill(TOP + ' >> [data-i-name]', '纯情')
        page.click(TOP + ' >> .nl-dialog-foot .nl-primary')
        page.wait_for_function('() => document.querySelectorAll(".nl-dialog-overlay").length === 1')
        page.click('.nl-dialog-foot button:has-text("完成")')
        page.wait_for_selector('.nl-dialog', state='detached')
        summary = page.inner_text('[data-up-summary]')
        assert '尺度 纯情 ' in summary + ' ' and '纯情慢热' not in summary, summary

        # ---- 「管理用户画像」里「新建导向」：关掉后「卡的导向」下拉框里马上有它，「按画像选导向」选得上（下拉框不会变空白） ----
        osel = '[data-form="orientationId"]'
        page.select_option(osel, '')
        page.click('[data-act="profile-manage"]')
        page.wait_for_selector('.nl-dialog .nl-up-dialog [data-act="up-orient-new"]')
        page.click('.nl-dialog [data-act="up-orient-new"]')
        page.wait_for_selector(TOP + ' >> [data-ot-f="name"]')
        page.fill(TOP + ' >> [data-ot-f="name"]', '甜宠测试')
        page.click(TOP + ' >> .nl-dialog-foot button:has-text("关闭")')
        page.wait_for_function('() => document.querySelectorAll(".nl-dialog-overlay").length === 1')
        page.click('.nl-dialog-foot button:has-text("完成")')
        page.wait_for_selector('.nl-dialog', state='detached')
        sweet = ev(page, '() => NovelLoom.app.settings.orientationTemplates.find((t) => t.name === "甜宠测试")?.id')
        assert sweet and sweet in prof(page)['orientations'], prof(page)['orientations']
        assert page.locator(f'{osel} option[value="{sweet}"]').count() == 1, '新建的导向马上出现在「卡的导向」里'
        page.click(f'[data-act="up-orient-pick"][data-orient-id="{sweet}"]')
        st = ev(page, '(s) => { const el = document.querySelector(s); return [el.value, el.selectedIndex]; }', osel)
        assert st[0] == sweet and st[1] >= 0, st
        assert ev(page, '() => document.querySelector("[data-orient-brief]").textContent') == ''
        # 选着的模板在「管理用户画像」里被删掉：下拉框回到「不限」，不会还显示一个已经不存在的模板
        page.click('[data-act="profile-manage"]')
        page.wait_for_selector('.nl-dialog .nl-up-dialog [data-act="up-orient-new"]')
        page.click('.nl-dialog [data-act="up-orient-new"]')
        page.wait_for_selector(TOP + f' >> [data-ot-id="{sweet}"]')
        page.click(TOP + f' >> [data-ot-id="{sweet}"]')
        page.click(TOP + ' >> [data-ot-act="delete"]')
        page.click(TOP + ' >> .nl-dialog-foot button:has-text("删除")')
        page.wait_for_function('() => document.querySelectorAll(".nl-dialog-overlay").length === 2')
        page.click(TOP + ' >> .nl-dialog-foot button:has-text("关闭")')
        page.wait_for_function('() => document.querySelectorAll(".nl-dialog-overlay").length === 1')
        page.click('.nl-dialog-foot button:has-text("完成")')
        page.wait_for_selector('.nl-dialog', state='detached')
        assert page.locator(f'{osel} option[value="{sweet}"]').count() == 0
        st = ev(page, '(s) => { const el = document.querySelector(s); return [el.value, el.selectedIndex]; }', osel)
        assert st == ['', 0], st
        assert '不加导向' in ev(page, '() => document.querySelector("[data-orient-brief]").textContent')
        assert not ev(page, '() => NovelLoom.app.settings.orientationTemplates.some((t) => t.name.startsWith("我的导向"))'), '第二次「新建导向」没改过：关掉后丢掉'
        page.select_option('[data-form="orientationId"]', '')
        page.click('[data-act="generate"]')
        page.wait_for_selector('.nl-dialog [data-card="description"]', timeout=20000)
        sent = ev(page, 'window.__prompts.filter((t) => t.includes("字段写法")).at(-1)')
        block = sent.split('# 为这位用户量身定制')[1].split('# 字段写法')[0]
        print('profile block in prompt:\n' + block.strip()[:700])
        assert '- 尺度：纯情——感情慢慢升温，可以有心动和暧昧的小动作，亲吻点到为止，不写性内容。\n' in block, block
        assert '- 叙事偏好：第二人称、多写环境和感官细节、短句。' in block
        assert '- 喜欢的元素：猫娘、眼镜娘。' in block
        assert '- 雷点（一律避免）：鬼畜、黑暗结局。' in block
        assert '师徒' in block
        assert ADULT in block and block.strip().endswith('或者不让 {{user}} 进入恋爱和亲密内容。'), '成年人是最后一条'
        card = ev(page, 'NovelLoom.app.project.cards.at(-1).userProfile')
        assert card['intensity'] == iid and card['intensityName'] == '纯情' and card['intensityDesc'].startswith('感情慢慢升温'), card
        page.click('.nl-dialog .nl-dialog-foot button:has-text("保存") >> nth=0')
        page.wait_for_selector('.nl-dialog', state='detached')

        # ---- 导出：画像（连同常用库）、配置 ----
        page.click('.nl-nav-btn[data-tab="profiles"]')
        page.click('#nl-tab [data-up-list] [data-up-id] >> text=库测试')
        page.wait_for_function('() => document.querySelector("#nl-tab [data-up-f=name]").value === "库测试"')
        # 再隐藏一个内置标签：画像文件里不带，配置里带
        page.click('#nl-tab [data-act="up-lib-edit"][data-kind="likes"]')
        page.click('#nl-tab [data-act="up-lib-tag-remove"][data-kind="likes"][data-group="traits"][data-tag="温柔"]')
        page.click('#nl-tab [data-act="up-lib-edit"][data-kind="likes"]')
        assert grp(page, 'traits')['hidden'] == ['温柔', '人妻']
        prof_path = download_profiles(page, '#nl-tab [data-act="up-export"]')
        exp = json.load(open(prof_path, encoding='utf-8'))
        print('exported library:', json.dumps(exp['library'], ensure_ascii=False)[:400])
        el = exp['library']
        assert exp['profiles'][0]['intensity'] == iid and exp['profiles'][0]['style'] == '第二人称、多写环境和感官细节、短句'
        assert {'id': 'traits', 'tags': ['猫娘', '兔娘']} in el['groups'], el['groups']
        assert any(g.get('name') == '我的雷点' and g['tags'] == ['黑暗结局', '鬼畜'] for g in el['groups'])
        assert all(not g.get('hidden') for g in el['groups']) and el['style']['hidden'] == [], '画像文件不带隐藏的内置标签'
        assert el['intensities'] == [{'id': iid, 'name': '纯情', 'desc': DESC2}]
        assert len(el['snippets']) == 2
        no_lib_path = download_profiles(page, '#nl-page-actions [data-act="up-export-all"]', with_library=False)
        nl = json.load(open(no_lib_path, encoding='utf-8'))
        assert nl['library'] == {'intensities': [{'id': iid, 'name': '纯情', 'desc': DESC2}]}, '没勾选时只带用到的自定义尺度'
        page.click('.nl-nav-btn[data-tab="settings"]')
        with page.expect_download() as d:
            page.click('#nl-page-actions [data-act="cfg-export"]')
        cfg_path = os.path.join(OUT, d.value.suggested_filename)
        d.value.save_as(cfg_path)
        cfg = json.load(open(cfg_path, encoding='utf-8'))
        assert cfg['settings']['profileLibrary']['style']['hidden'] == ['文艺'] and len(cfg['settings']['profileLibrary']['intensities']) == 1

        # ---- 刷新页面：常用库和画像都还在 ----
        saved_lib = lib(page)
        page.reload()
        open_app(page)
        assert lib(page) == saved_lib, '刷新后常用库原样读回来'
        page.click('.nl-nav-btn[data-tab="profiles"]')
        page.click('#nl-tab [data-up-list] [data-up-id] >> text=库测试')
        page.wait_for_function('() => document.querySelector("#nl-tab [data-up-f=name]").value === "库测试"')
        assert page.get_attribute(f'#nl-tab [data-act="up-intensity"][data-val="{iid}"]', 'aria-pressed') == 'true'
        assert page.locator('#nl-tab [data-act="up-tag-toggle"][data-kind="likes"][data-tag="兔娘"]').count() == 1
        assert page.locator(f'#nl-tab [data-up-group="{g_mine}"]').count() == 1
        assert page.locator('#nl-tab [data-act="up-tag-toggle"][data-kind="likes"][data-tag="人妻"]').count() == 0
        assert '插入常用…（1）' in page.inner_text('#nl-tab [data-act="up-snip-insert"][data-field="persona"]')

        # ---- 干净的设置（另一台电脑）：导入画像文件 → 常用库合并进来（不带隐藏）；再导入配置 → 隐藏的也合并，不重复 ----
        ev(page, "() => { sessionStorage.removeItem('__nl_persist'); sessionStorage.removeItem('__nl_ext'); }")
        page.reload()
        open_app(page)
        assert ev(page, 'NovelLoom.app.settings.userProfiles.length') == 0
        assert lib(page) == {'groups': [], 'intensities': [], 'style': {'tags': [], 'hidden': []}, 'snippets': []}
        page.click('.nl-nav-btn[data-tab="profiles"]')
        page.wait_for_selector('#nl-tab .nl-empty')
        with page.expect_file_chooser() as fc:
            page.click('#nl-tab [data-act="up-import"]')
        fc.value.set_files(prof_path)
        wait_log(page, '已导入 1 个用户画像')
        wait_log(page, '常用库新增 标签 8 个、分组 2 个、尺度 1 个、叙事偏好 4 个、常用文字 2 段')
        L2 = lib(page)
        assert grp(page, 'traits')['tags'] == ['猫娘', '兔娘'] and grp(page, 'traits')['hidden'] == []
        assert grp(page, g_mine)['tags'] == ['黑暗结局', '鬼畜'] and grp(page, g_beast)['name'] == '兽人控'
        assert L2['style'] == {'tags': ['多写环境和感官细节', '短句', '慢节奏', '多写对话'], 'hidden': []}, L2['style']
        imported = prof(page)
        assert imported['intensity'] == iid and imported['orientations'] == [], imported
        assert page.get_attribute(f'#nl-tab [data-act="up-intensity"][data-val="{iid}"]', 'aria-pressed') == 'true'
        assert page.locator('#nl-tab [data-act="up-tag-toggle"][data-kind="likes"][data-tag="人妻"]').count() == 1, '导入画像不替你隐藏内置标签'
        page.click('.nl-nav-btn[data-tab="settings"]')
        with page.expect_file_chooser() as fc:
            page.click('#nl-page-actions [data-act="cfg-import"]')
        fc.value.set_files(cfg_path)
        wait_log(page, '已导入配置')
        L3 = lib(page)
        assert grp(page, 'traits')['hidden'] == ['温柔', '人妻'] and L3['style']['hidden'] == ['文艺'], '导入配置时隐藏的内置标签也合并'
        assert len([g for g in L3['groups'] if g['id'].startswith('ugrp_')]) == 2 and len(L3['intensities']) == 1 and len(L3['snippets']) == 2, '不重复'
        assert ev(page, 'NovelLoom.app.settings.userProfiles.length') == 3, '配置里的两个画像按 id 合并进来（和画像文件导入的那个是不同的画像）'

        # ---- 窄屏 ----
        page.set_viewport_size({'width': 390, 'height': 844})
        page.click('.nl-nav-btn[data-tab="profiles"]')
        page.click('#nl-tab [data-up-list] [data-up-id] >> nth=0')
        page.click('#nl-tab [data-act="up-lib-edit"][data-kind="likes"]')
        page.click('#nl-tab [data-act="up-lib-add"][data-kind="likes"][data-group="traits"]')
        page.click('#nl-tab [data-act="up-int-manage"]')
        assert no_hscroll(page), '窄屏没有横向滚动'
        bad = overflowing(page, '#nl-tab [data-up-detail]')
        assert not bad, bad
        page.locator('#nl-tab [data-up-tags="likes"]').scroll_into_view_if_needed()
        shot(page, '09-mobile-lib-editing')
        page.locator(f'#nl-tab [data-up-group="{g_beast}"]').scroll_into_view_if_needed()
        shot(page, '10-mobile-lib-groups')
        page.locator('#nl-tab [data-up-int]').scroll_into_view_if_needed()
        shot(page, '11-mobile-intensity')
        page.locator('#nl-tab [data-up-tags="style"]').scroll_into_view_if_needed()
        shot(page, '12-mobile-style')
        page.click('#nl-tab [data-act="up-snip-insert"][data-field="persona"]')
        page.wait_for_selector('.nl-dialog [data-snip-act="insert"]')
        assert no_hscroll(page)
        shot(page, '13-mobile-snippets')
        page.click('.nl-dialog-foot button:has-text("关闭")')
        page.click('#nl-tab [data-act="up-lib-group-new"][data-kind="likes"]')
        page.wait_for_selector('.nl-dialog [data-g-name]')
        shot(page, '14-mobile-group-dialog')
        page.click('.nl-dialog-foot button:has-text("取消")')
        browser.close()
finally:
    server.terminate()

real = [e for e in errors if 'favicon' not in e]
print('ERRORS:', json.dumps(real, ensure_ascii=False))
sys.exit(1 if real else 0)
