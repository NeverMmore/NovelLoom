# 浏览器冒烟测试（用户画像）：没打开项目时在「用户画像」页新建两个画像（点选建议标签 + 输入自定义标签、偏好的导向、雷点、尺度、
# 默认形象、叙事偏好），默认画像只有一个、重名提示、导出 / 导入 / 删除；写卡表单默认选默认画像、「按画像选导向」快捷按钮、
# 生成时提示词里有「为这位用户量身定制」（含雷点与成年人一条）、卡上存画像快照；写入酒馆后卡自己的世界书里有「用户偏好」条目；
# 编辑框的「用户画像」一节（条目预览、关掉条目后重新写入条目被去掉、画像改过后「改用最新版本」）；
# 没确认的标签在点别处 / 切走时照样存下、粘贴一串标签、点标签框空白处聚焦输入框、删掉最后一个画像后焦点在「新建画像」、
# 偏好的导向又是雷点时标出来、写卡表单里选的导向是雷点时提醒；「管理用户画像」是对话框（表单里填的内容不丢）；窄屏截图
import json, os, subprocess, sys, time
from playwright.sync_api import sync_playwright

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
OUT = sys.argv[1] if len(sys.argv) > 1 else '/tmp/nl-profiles'
os.makedirs(OUT, exist_ok=True)
PORT = 8784
server = subprocess.Popen([sys.executable, '-m', 'http.server', str(PORT), '--bind', '127.0.0.1'], cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1)

ch1 = '第一章 魔女小姐\n' + '江酒走进酒吧。莉莉丝坐在角落，黑色长裙拖到地上。\n“没错，今晚我是来跟你提分手的。”江酒说。\n' * 18
ch2 = '第二章 女仆\n' + '江酒穿上了女仆装。小酒在镜子前转了一圈。莉莉丝去参加魔女茶会。\n' * 22
NOVEL = ch1 + ch2
ADULT = '所有涉及恋爱或亲密内容的人物（包括 {{user}}）都是成年人'
errors = []

def shot(page, name):
    # 对话框有淡入动画：等它完全显示再截图
    page.wait_for_function('() => [...document.querySelectorAll(".nl-dialog-overlay, .nl-dialog")].every((d) => getComputedStyle(d).opacity === "1")')
    page.screenshot(path=os.path.join(OUT, name + '.png'))

def wait_log(page, text, timeout=30000):
    page.wait_for_function('(t) => [...document.querySelectorAll(".nl-log-line")].some(l => l.textContent.includes(t))', arg=text, timeout=timeout)

def ev(page, js, arg=None):
    return page.evaluate(js, arg) if arg is not None else page.evaluate(js)

def download(page, selector):
    with page.expect_download() as d:
        page.click(selector)
    path = os.path.join(OUT, d.value.suggested_filename)
    d.value.save_as(path)
    return path

def profiles(page):
    return ev(page, 'NovelLoom.app.settings.userProfiles')

def by_name(page, name):
    return next((p for p in profiles(page) if p['name'] == name), None)

def nav_count(page):
    return page.inner_text('.nl-nav-btn[data-tab="profiles"] .nl-nav-count').strip()

def add_tag(page, kind, text):
    sel = f'#nl-tab [data-up-tag-input="{kind}"]'
    page.fill(sel, text)
    page.press(sel, 'Enter')

def no_hscroll(page):
    return ev(page, 'document.documentElement.scrollWidth <= window.innerWidth + 1')

try:
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={'width': 1360, 'height': 900}, accept_downloads=True)
        page.on('pageerror', lambda e: errors.append('pageerror: ' + str(e)))
        page.on('console', lambda m: errors.append('console: ' + m.text) if m.type == 'error' else None)
        page.goto(f'http://127.0.0.1:{PORT}/tests/browser/harness.html')
        page.wait_for_selector('#nl-wand-button')
        page.evaluate("NovelLoom.open('project')")
        page.wait_for_selector('.nl-window')
        assert ev(page, 'NovelLoom.app.project') is None, '还没有打开项目'

        # ---- 侧栏：「用户画像」在「生成」组里、角色卡前面；没打开项目也能用 ----
        order = ev(page, '[...document.querySelectorAll(".nl-nav .nl-nav-btn")].map((b) => b.dataset.tab)')
        print('nav order:', order)
        assert order.index('profiles') == order.index('cards') - 1, order
        assert 'nl-disabled' not in page.get_attribute('.nl-nav-btn[data-tab="profiles"]', 'class')
        assert 'nl-disabled' in page.get_attribute('.nl-nav-btn[data-tab="cards"]', 'class')
        page.click('.nl-nav-btn[data-tab="profiles"]')
        page.wait_for_selector('#nl-tab .nl-empty')
        assert '还没有用户画像' in page.inner_text('#nl-tab') and '还没有打开项目' not in page.inner_text('#nl-tab')
        assert page.inner_text('#nl-page-title') == '用户画像'
        shot(page, '01-profiles-empty')

        # ---- 删掉唯一的画像：焦点落在空状态的「新建画像」上，不掉到页面最外层 ----
        page.click('#nl-tab [data-act="up-new"]')
        page.wait_for_selector('#nl-tab [data-up-f="name"]')
        page.click('#nl-tab [data-act="up-delete"]')
        page.click('.nl-dialog-foot button:has-text("删除")')
        page.wait_for_selector('#nl-tab .nl-empty')
        page.wait_for_function('() => document.activeElement?.dataset?.act === "up-new" && document.querySelector("#nl-tab").contains(document.activeElement)')
        assert ev(page, 'NovelLoom.app.settings.userProfiles.length') == 0

        # ---- 第一个画像：自动设为默认 ----
        page.click('#nl-tab [data-act="up-new"]')
        page.wait_for_selector('#nl-tab [data-up-f="name"]')
        assert ev(page, 'document.activeElement.dataset.upF') == 'name', '新建后焦点在名称上'
        page.fill('#nl-tab [data-up-f="name"]', '足控党')
        page.wait_for_function('() => document.querySelector("#nl-tab [data-up-list]").textContent.includes("足控党")')
        assert nav_count(page) == '1', nav_count(page)
        # 偏好的导向（多选）
        page.click('#nl-tab [data-act="up-orient"][data-orient-id="orient_ntl"]')
        page.click('#nl-tab [data-act="up-orient"][data-orient-id="orient_pure"]')
        assert page.get_attribute('#nl-tab [data-act="up-orient"][data-orient-id="orient_ntl"]', 'aria-pressed') == 'true'
        # 喜欢：点建议 + 输入（回车、全角逗号）；退格去掉最后一个
        page.click('#nl-tab [data-act="up-tag-toggle"][data-kind="likes"][data-tag="黑丝"]')
        page.click('#nl-tab [data-act="up-tag-toggle"][data-kind="likes"][data-tag="足控"]')
        add_tag(page, 'likes', '傲娇')
        assert ev(page, 'document.activeElement.dataset.upTagInput') == 'likes', '加完标签焦点还在输入框里'
        page.fill('#nl-tab [data-up-tag-input="likes"]', '长腿，')
        page.wait_for_function('() => [...document.querySelectorAll("#nl-tab [data-up-tagbox=likes] .nl-up-chip")].some((c) => c.textContent.includes("长腿"))')
        page.press('#nl-tab [data-up-tag-input="likes"]', 'Backspace')
        page.wait_for_function('() => ![...document.querySelectorAll("#nl-tab [data-up-tagbox=likes] .nl-up-chip")].some((c) => c.textContent.includes("长腿"))')
        page.click('#nl-tab [data-act="up-tag-toggle"][data-kind="likes"][data-tag="御姐"]')
        # 雷点：点建议 + 输入；把「御姐」加到雷点时从喜欢里拿掉
        page.click('#nl-tab [data-act="up-tag-toggle"][data-kind="dislikes"][data-tag="NTR"]')
        add_tag(page, 'dislikes', '血腥')
        add_tag(page, 'dislikes', '御姐')
        prof = by_name(page, '足控党')
        print('likes:', prof['likes'], '| dislikes:', prof['dislikes'])
        assert prof['likes'] == ['黑丝', '足控', '傲娇'], prof['likes']
        assert prof['dislikes'] == ['NTR', '血腥', '御姐'], prof['dislikes']
        assert page.get_attribute('#nl-tab [data-act="up-tag-toggle"][data-kind="likes"][data-tag="御姐"]', 'class').find('nl-up-in-other') >= 0, '在雷点里的建议标出来'
        page.click('#nl-tab [data-up-tagbox="dislikes"] [data-act="up-tag-remove"][data-tag="御姐"]')
        assert by_name(page, '足控党')['dislikes'] == ['NTR', '血腥']
        # 尺度
        page.click('#nl-tab [data-act="up-intensity"][data-val="explicit"]')
        assert by_name(page, '足控党')['intensity'] == 'explicit'
        assert '成年人' in page.inner_text('#nl-tab [data-up-int-hint]')
        page.click('#nl-tab [data-act="up-intensity"][data-val="suggestive"]')
        page.fill('#nl-tab [data-up-f="persona"]', '二十五岁的男性上班族，个子高、话不多')
        # 叙事偏好：标签编辑（粘贴一串，用顿号隔开）
        page.fill('#nl-tab [data-up-tag-input="style"]', '第二人称、细腻心理')
        page.wait_for_function('() => NovelLoom.app.settings.userProfiles.find((p) => p.name === "足控党").style === "第二人称、细腻心理"')
        page.fill('#nl-tab [data-up-f="notes"]', '喜欢斗嘴')
        prof = by_name(page, '足控党')
        assert prof['isDefault'] is True, '第一个画像自动设为默认'
        assert prof['orientations'] == ['orient_ntl', 'orient_pure'] and prof['intensity'] == 'suggestive' and prof['style'] == '第二人称、细腻心理' and prof['chatEntry'] is True, prof
        assert '默认' in page.inner_text('#nl-tab [data-up-list]')
        assert '已自动保存' in page.inner_text('#nl-tab [data-up-saved]')
        # 读屏：播报在单独的区域里、停手后才播一次；看得见的那行本身不是 live 区域（不会每打一个字念一遍）
        assert page.get_attribute('#nl-tab [data-up-saved]', 'aria-live') is None
        assert page.get_attribute('#nl-tab [data-up-live]', 'aria-live') == 'polite'
        page.wait_for_function('() => document.querySelector("#nl-tab [data-up-live]").textContent === "已自动保存"', timeout=5000)
        # 偏好的导向又是雷点（NTR）：标出来并说明，写卡时不推荐它
        page.click('#nl-tab [data-act="up-orient"][data-orient-id="orient_ntr"]')
        page.wait_for_selector('#nl-tab [data-up-orient-conflict]')
        assert '「NTR」同时在雷点里' in page.inner_text('#nl-tab [data-up-orient-conflict]')
        assert 'nl-up-in-other' in page.get_attribute('#nl-tab [data-act="up-orient"][data-orient-id="orient_ntr"]', 'class')
        page.click('#nl-tab [data-act="up-orient"][data-orient-id="orient_ntr"]')
        page.wait_for_selector('#nl-tab [data-up-orient-conflict]', state='detached')
        assert by_name(page, '足控党')['orientations'] == ['orient_ntl', 'orient_pure']
        # 点标签框的空白处：聚焦框里的输入框
        page.click('#nl-tab [data-up-tagbox="dislikes"]', position={'x': 2, 'y': 2})
        assert ev(page, 'document.activeElement.dataset.upTagInput') == 'dislikes', '点标签框空白处聚焦输入框'
        shot(page, '02-profile-editor')
        page.locator('#nl-tab [data-up-tags="dislikes"]').scroll_into_view_if_needed()
        shot(page, '03-profile-editor-dislikes')

        # ---- 第二个画像：设为默认后第一个不再是默认；重名提示 ----
        page.click('#nl-page-actions [data-act="up-new"]')
        page.wait_for_function('() => NovelLoom.app.settings.userProfiles.length === 2')
        page.fill('#nl-tab [data-up-f="name"]', '足控党')
        page.wait_for_selector('#nl-tab [data-up-err]:not([hidden])')
        assert '同名' in page.inner_text('#nl-tab [data-up-err]')
        page.fill('#nl-tab [data-up-f="name"]', '纯爱党')
        page.wait_for_selector('#nl-tab [data-up-err]', state='hidden')
        page.click('#nl-tab [data-act="up-orient"][data-orient-id="orient_pure"]')
        page.click('#nl-tab [data-act="up-tag-toggle"][data-kind="likes"][data-tag="温柔"]')
        page.check('#nl-tab [data-up-f="isDefault"]')
        page.wait_for_function('() => NovelLoom.app.settings.userProfiles.filter((p) => p.isDefault).length === 1 && NovelLoom.app.settings.userProfiles.find((p) => p.isDefault).name === "纯爱党"')
        assert nav_count(page) == '2'
        # 改回来：足控党是默认
        page.click('#nl-tab [data-up-list] [data-up-id] >> text=足控党')
        page.wait_for_function('() => document.querySelector("#nl-tab [data-up-f=name]").value === "足控党"')
        page.check('#nl-tab [data-up-f="isDefault"]')
        page.wait_for_function('() => NovelLoom.app.settings.userProfiles.find((p) => p.isDefault)?.name === "足控党"')
        assert len([x for x in profiles(page) if x['isDefault']]) == 1
        zk_id = by_name(page, '足控党')['id']
        cl_id = by_name(page, '纯爱党')['id']

        # ---- 导出 / 导入 / 删除 ----
        path = download(page, '#nl-tab [data-act="up-export"]')
        exp = json.load(open(path, encoding='utf-8'))
        print('exported:', os.path.basename(path), exp['type'], [x['name'] for x in exp['profiles']], exp['profiles'][0]['orientationNames'])
        assert exp['type'] == 'novel_loom_user_profiles' and exp['profiles'][0]['likes'] == ['黑丝', '足控', '傲娇'] and exp['profiles'][0]['orientationNames'] == ['NTL', '纯爱']
        assert 'isDefault' not in exp['profiles'][0]
        all_path = download(page, '#nl-page-actions [data-act="up-export-all"]')
        assert [x['name'] for x in json.load(open(all_path, encoding='utf-8'))['profiles']] == ['足控党', '纯爱党']
        with page.expect_file_chooser() as fc:
            page.click('#nl-page-actions [data-act="up-import"]')
        fc.value.set_files(path)
        wait_log(page, '已导入 1 个用户画像')
        imported = by_name(page, '足控党 2')
        assert imported and imported['isDefault'] is False and imported['dislikes'] == ['NTR', '血腥'], imported
        assert nav_count(page) == '3'
        assert page.input_value('#nl-tab [data-up-f="name"]') == '足控党 2', '导入后选中导入的画像'
        page.click('#nl-tab [data-act="up-delete"]')
        page.wait_for_selector('.nl-dialog')
        assert '足控党 2' in page.inner_text('.nl-dialog-body')
        page.click('.nl-dialog-foot button:has-text("删除")')
        page.wait_for_function('() => NovelLoom.app.settings.userProfiles.length === 2')
        assert nav_count(page) == '2'
        page.click('#nl-tab [data-up-list] [data-up-id] >> text=足控党')
        shot(page, '04-profiles-list')

        # ---- 导入小说 + 提取（写卡需要项目） ----
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

        # ---- 写卡表单：默认选默认画像；「按画像选导向」只给按钮，点了才改 ----
        page.click('.nl-nav-btn[data-tab="cards"]')
        page.select_option('[data-form="charName"]', '莉莉丝')
        assert page.input_value('[data-form="userProfileId"]') == zk_id, '默认选默认画像'
        summary = page.inner_text('[data-up-summary]')
        print('form summary:', summary)
        assert '黑丝' in summary and 'NTR' in summary and '暧昧擦边' in summary
        assert page.is_visible('[data-up-chat]') and page.is_checked('[data-form="userProfileChat"]')
        assert page.input_value('[data-form="orientationId"]') == '', '没有悄悄改导向'
        picks = ev(page, '[...document.querySelectorAll("[data-up-picks] [data-act=up-orient-pick]")].map((b) => b.textContent)')
        print('quick picks:', picks)
        assert picks == ['按画像选导向：NTL', '按画像选导向：纯爱'], picks
        shot(page, '05-card-form-profile')
        # 换成纯爱党：摘要和按钮跟着换；换回来
        page.select_option('[data-form="userProfileId"]', cl_id)
        assert '温柔' in page.inner_text('[data-up-summary]')
        assert ev(page, '[...document.querySelectorAll("[data-up-picks] [data-act=up-orient-pick]")].map((b) => b.textContent)') == ['按画像选导向：纯爱']
        page.select_option('[data-form="userProfileId"]', '')
        assert page.is_hidden('[data-up-chat]') and page.is_hidden('[data-up-picks]')
        assert '不使用画像' in page.inner_text('[data-up-summary]')
        page.select_option('[data-form="userProfileId"]', zk_id)
        # 选的导向正好是画像的雷点（NTR）：提醒以卡的导向为准，不替用户改
        assert page.is_hidden('[data-up-orient-clash]')
        page.select_option('[data-form="orientationId"]', 'orient_ntr')
        page.wait_for_selector('[data-up-orient-clash]:not([hidden])')
        assert '把「NTR」列为雷点：这张卡以卡的导向为准' in page.inner_text('[data-up-orient-clash]')
        page.select_option('[data-form="orientationId"]', '')
        page.wait_for_selector('[data-up-orient-clash]', state='hidden')
        page.click('[data-act="up-orient-pick"][data-orient-id="orient_ntl"]')
        assert page.input_value('[data-form="orientationId"]') == 'orient_ntl'
        assert page.is_hidden('[data-up-picks]'), '选了导向后不再给按钮'
        assert '寝取り' in page.inner_text('[data-orient-brief]')

        # 预览提示词
        page.click('[data-act="preview"]')
        page.wait_for_selector('.nl-dialog')
        pv = page.inner_text('.nl-dialog-body')
        assert '# 为这位用户量身定制' in pv and ADULT in pv, pv[:200]
        page.click('.nl-dialog [data-close]')
        page.wait_for_selector('.nl-dialog', state='detached')

        # ---- 生成：提示词里有画像一节（雷点、成年人、以卡的导向为准）；卡上存快照 ----
        page.click('[data-act="generate"]')
        page.wait_for_selector('.nl-dialog [data-card="description"]', timeout=20000)
        sent = ev(page, 'window.__prompts.filter((t) => t.includes("字段写法")).at(-1)')
        block = sent.split('# 为这位用户量身定制')[1].split('# 字段写法')[0]
        print('profile block in prompt:\n' + block.strip()[:600])
        assert '- 喜欢的元素：黑丝、足控、傲娇。' in block
        assert '- 雷点（一律避免）：NTR、血腥。' in block
        assert ADULT in block and block.strip().endswith('或者不让 {{user}} 进入恋爱和亲密内容。'), '成年人是最后一条'
        assert '以卡的导向为准' in block and '二十五岁的男性上班族' in block
        assert sent.index('【卡的导向：NTL】') < sent.index('# 为这位用户量身定制')
        card = ev(page, 'NovelLoom.app.project.cards.at(-1)')
        print('card profile:', card['userProfile'])
        assert card['userProfile']['id'] == zk_id and card['userProfile']['name'] == '足控党' and card['userProfile']['chatEntry'] is True
        assert card['userProfile']['orientations'] == [{'id': 'orient_ntl', 'name': 'NTL'}, {'id': 'orient_pure', 'name': '纯爱'}]
        # 编辑框的「用户画像」一节
        assert page.input_value('.nl-dialog [data-up-edit-pick]') == zk_id
        assert '黑丝' in page.inner_text('.nl-dialog [data-up-edit-note]')
        assert page.is_checked('.nl-dialog [data-up-edit-chat]')
        page.click('.nl-dialog [data-up-edit-entry] summary')
        preview = page.inner_text('.nl-dialog [data-up-edit-preview]')
        assert preview.startswith('【用户偏好】') and '聊天时照顾 {{user}} 的偏好：黑丝、足控、傲娇' in preview and '绝对避免：NTR、血腥' in preview, preview
        assert page.is_hidden('.nl-dialog [data-up-edit-outdated]')
        page.locator('.nl-dialog [data-up-edit]').scroll_into_view_if_needed()
        shot(page, '06-editor-profile')

        # ---- 写入酒馆：卡自己的世界书里有「用户偏好」，排在剧情导向之后 ----
        page.click('.nl-dialog-foot button:has-text("保存并写入酒馆")')
        wait_log(page, '已写入酒馆：角色「莉莉丝」')
        log = ev(page, '[...document.querySelectorAll(".nl-log-line")].map((l) => l.textContent).filter((t) => t.includes("已写入酒馆：角色「莉莉丝」")).at(-1)')
        print('log:', log)
        assert '用户偏好「足控党」' in log
        w = ev(page, 'Object.values(window.__saved.worlds["《魔女》世界书·莉莉丝"].entries)')
        by = {e['comment']: e for e in w}
        assert '用户偏好' in by and '剧情导向：NTL' in by, list(by)
        ue = by['用户偏好']
        assert ue['constant'] and ue['position'] == 4 and ue['depth'] == 4 and ue['role'] == 0 and ue['order'] == by['剧情导向：NTL']['order'] - 1
        assert ue['content'].startswith('【用户偏好】\n聊天时照顾 {{user}} 的偏好：黑丝、足控、傲娇') and ue['content'].endswith(ADULT + '。'), ue['content']
        imp = json.loads(ev(page, 'window.__saved.lastImport.text'))
        book = [e['comment'] for e in imp['data']['character_book']['entries']]
        assert book.index('剧情导向：NTL') + 1 == book.index('用户偏好'), book
        assert '画像：足控党' in page.inner_text('#nl-tab .nl-cards')
        shot(page, '07-cards-published')

        # ---- 编辑框：关掉条目后重新写入，条目被去掉 ----
        page.click('#nl-tab [data-act="edit"] >> nth=0')
        page.wait_for_selector('.nl-dialog [data-up-edit]')
        page.uncheck('.nl-dialog [data-up-edit-chat]')
        page.click('.nl-dialog [data-up-edit-entry] summary')
        assert '不加「用户偏好」条目' in page.inner_text('.nl-dialog [data-up-edit-preview]')
        page.click('.nl-dialog-foot button:has-text("保存并写入酒馆")')
        page.wait_for_function('() => [...document.querySelectorAll(".nl-log-line")].filter((l) => l.textContent.includes("已写入酒馆：角色「莉莉丝」")).length >= 2', timeout=30000)
        w2 = [e['comment'] for e in ev(page, 'Object.values(window.__saved.worlds["《魔女》世界书·莉莉丝"].entries)')]
        assert '用户偏好' not in w2 and '剧情导向：NTL' in w2, w2
        assert ev(page, 'NovelLoom.app.project.cards.at(-1).userProfile.chatEntry') is False

        # ---- 画像页改了画像：编辑框提示「改用最新版本」，点了才换 ----
        page.click('.nl-nav-btn[data-tab="profiles"]')
        page.wait_for_selector('#nl-tab [data-up-f="name"]')
        assert page.input_value('#nl-tab [data-up-f="name"]') == '足控党'
        page.click('#nl-tab [data-act="up-tag-toggle"][data-kind="likes"][data-tag="白丝"]')
        assert '白丝' in by_name(page, '足控党')['likes']
        page.click('.nl-nav-btn[data-tab="cards"]')
        page.click('#nl-tab [data-act="edit"] >> nth=0')
        page.wait_for_selector('.nl-dialog [data-up-edit-outdated]:not([hidden])')
        assert '白丝' not in page.inner_text('.nl-dialog [data-up-edit-note]')
        page.click('.nl-dialog [data-card-act="up-refresh"]')
        assert page.is_hidden('.nl-dialog [data-up-edit-outdated]')
        assert '白丝' in page.inner_text('.nl-dialog [data-up-edit-note]')
        page.check('.nl-dialog [data-up-edit-chat]')
        page.click('.nl-dialog [data-up-edit-entry] summary')
        assert '白丝' in page.inner_text('.nl-dialog [data-up-edit-preview]')
        page.click('.nl-dialog-foot button:has-text("保存")')
        page.wait_for_selector('.nl-dialog', state='detached')
        stored = ev(page, 'NovelLoom.app.project.cards.at(-1).userProfile')
        assert '白丝' in stored['likes'] and stored['chatEntry'] is True, stored

        # ---- 「管理用户画像」：对话框（不离开角色卡页，表单里填的内容都在），选中表单里的画像 ----
        page.select_option('[data-form="userProfileId"]', cl_id)
        page.select_option('[data-form="kind"]', 'world')
        page.fill('[data-form="requirement"]', '开场在雾夜的码头')
        page.click('[data-act="profile-manage"]')
        page.wait_for_selector('.nl-dialog .nl-up-dialog [data-up-f="name"]')
        assert page.inner_text('#nl-page-title') == '角色卡', '还在角色卡页'
        assert page.input_value('.nl-dialog [data-up-f="name"]') == '纯爱党'
        shot(page, '12-profiles-dialog')
        # 输入了标签但没按回车，直接去点尺度：标签照样存下，尺度这一下点击也没有丢
        page.fill('.nl-dialog [data-up-tag-input="likes"]', '猫耳')
        page.click('.nl-dialog [data-act="up-intensity"][data-val="explicit"]')
        page.wait_for_function('() => NovelLoom.app.settings.userProfiles.find((p) => p.name === "纯爱党").intensity === "explicit"')
        page.wait_for_function('() => [...document.querySelectorAll(".nl-dialog [data-up-tagbox=likes] .nl-up-chip")].some((c) => c.textContent.includes("猫耳"))')
        assert '猫耳' in by_name(page, '纯爱党')['likes'], by_name(page, '纯爱党')['likes']
        assert page.input_value('.nl-dialog [data-up-tag-input="likes"]') == ''
        # 输入了标签没确认、又去点了别的标签建议：两下都算
        page.fill('.nl-dialog [data-up-tag-input="likes"]', '狐狸')
        page.click('.nl-dialog [data-act="up-tag-toggle"][data-kind="likes"][data-tag="眼镜"]')
        page.wait_for_function('() => { const l = NovelLoom.app.settings.userProfiles.find((p) => p.name === "纯爱党").likes; return l.includes("狐狸") && l.includes("眼镜"); }')
        # 输入了标签没确认、直接点左边另一个画像：标签存进原来的画像，也真的换到了另一个画像（这一下点击没有丢）
        page.fill('.nl-dialog [data-up-tag-input="likes"]', '狼耳')
        page.click('.nl-dialog [data-up-list] [data-up-id] >> text=足控党')
        page.wait_for_function('() => document.querySelector(".nl-dialog [data-up-f=name]").value === "足控党"')
        assert '狼耳' in by_name(page, '纯爱党')['likes'] and '狼耳' not in by_name(page, '足控党')['likes']
        page.click('.nl-dialog [data-up-list] [data-up-id] >> text=纯爱党')
        page.wait_for_function('() => document.querySelector(".nl-dialog [data-up-f=name]").value === "纯爱党"')
        # 粘贴一串标签（超过 12 字也收得下，每个标签各自最多 12 字）
        page.fill('.nl-dialog [data-up-tag-input="dislikes"]', '黑暗结局，背叛，多角关系的修罗场哪怕只有一点点，死亡')
        page.wait_for_function('() => NovelLoom.app.settings.userProfiles.find((p) => p.name === "纯爱党").dislikes.includes("死亡")')
        dl = by_name(page, '纯爱党')['dislikes']
        print('pasted dislikes:', dl)
        assert dl[:2] == ['黑暗结局', '背叛'] and '死亡' in dl and all(len(t) <= 12 for t in dl), dl
        wait_log(page, '每个标签最多 12 字，超出的部分已截掉')
        # 新建一个画像；没确认的标签在关掉对话框时也存下
        page.click('.nl-dialog [data-act="up-new"]')
        page.wait_for_function('() => NovelLoom.app.settings.userProfiles.length === 3')
        page.fill('.nl-dialog [data-up-f="name"]', '新画像')
        page.fill('.nl-dialog [data-up-tag-input="likes"]', '旗袍')
        page.click('.nl-dialog-foot button:has-text("完成")')
        page.wait_for_selector('.nl-dialog', state='detached')
        assert by_name(page, '新画像')['likes'] == ['旗袍'], by_name(page, '新画像')
        # 回到写卡表单：填的内容都在，下拉框里有新画像，选的还是纯爱党
        assert page.input_value('[data-form="requirement"]') == '开场在雾夜的码头'
        assert page.input_value('[data-form="kind"]') == 'world'
        assert page.input_value('[data-form="userProfileId"]') == cl_id
        assert '新画像' in page.inner_text('[data-form="userProfileId"]')
        assert '猫耳' in page.inner_text('[data-up-summary]')
        page.select_option('[data-form="kind"]', 'character')
        # 「用户画像」页本身照常可用，打开时选中上次的画像
        page.click('.nl-nav-btn[data-tab="profiles"]')
        page.wait_for_selector('#nl-tab [data-up-f="name"]')
        assert page.inner_text('#nl-page-title') == '用户画像'
        # 在页面里输入标签没确认就切走：照样存下
        page.click('#nl-tab [data-up-list] [data-up-id] >> text=纯爱党')
        page.wait_for_function('() => document.querySelector("#nl-tab [data-up-f=name]").value === "纯爱党"')
        page.fill('#nl-tab [data-up-tag-input="likes"]', '兔耳')
        page.click('.nl-nav-btn[data-tab="cards"]')
        page.wait_for_function('() => NovelLoom.app.settings.userProfiles.find((p) => p.name === "纯爱党").likes.includes("兔耳")')

        # ---- 窄屏 ----
        page.set_viewport_size({'width': 390, 'height': 844})
        page.click('.nl-nav-btn[data-tab="profiles"]')
        page.click('#nl-tab [data-up-list] [data-up-id] >> text=足控党')
        page.wait_for_function('() => document.querySelector("#nl-tab [data-up-f=name]").value === "足控党"')
        assert no_hscroll(page), '窄屏没有横向滚动'
        shot(page, '08-mobile-profiles')
        page.locator('#nl-tab [data-up-tags="likes"]').scroll_into_view_if_needed()
        shot(page, '09-mobile-profile-tags')
        page.click('.nl-nav-btn[data-tab="cards"]')
        page.select_option('[data-form="userProfileId"]', zk_id)
        page.select_option('[data-form="orientationId"]', '')
        page.wait_for_selector('[data-up-picks]:not([hidden])')
        ev(page, '() => document.querySelector("#nl-tab .nl-up-form").scrollIntoView({ block: "start" })')
        assert no_hscroll(page)
        # 窄屏：勾选框的说明换行时和文字排在一起，不挤成两列
        lab = ev(page, '() => { const l = document.querySelector("[data-up-chat]"); const s = l.querySelector(":scope > span"); return [l.children.length, Math.round(s.getBoundingClientRect().width), Math.round(l.getBoundingClientRect().width)]; }')
        print('mobile chat label:', lab)
        assert lab[0] == 2 and lab[1] >= lab[2] - 30, lab
        shot(page, '10-mobile-card-form')
        page.click('#nl-tab [data-act="edit"] >> nth=0')
        page.wait_for_selector('.nl-dialog [data-up-edit]')
        page.locator('.nl-dialog [data-up-edit]').scroll_into_view_if_needed()
        shot(page, '11-mobile-editor-profile')
        page.click('.nl-dialog-foot button:has-text("取消")')
        browser.close()
finally:
    server.terminate()

real = [e for e in errors if 'favicon' not in e]
print('ERRORS:', json.dumps(real, ensure_ascii=False))
sys.exit(1 if real else 0)
