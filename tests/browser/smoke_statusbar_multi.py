# 浏览器冒烟测试（多人状态栏，v0.12）：写世界/旁白卡时同时生成状态栏（群像变量表：主要角色 / NPC 两个记录 + 一层分组，
# 主要角色按项目补齐）→ 变量表里的分组字段编辑 → 「立绘」分页（解锁条件、图池、缩略图、地址检查）→ 预览（立绘、换一张只在已解锁的图之间轮换、
# 选择记在酒馆页面的本地存储里，预览重新载入后还在；分组子模板与点路径；模拟更新后解锁与图池）→ 套用「多人群像」（模板自带上限 15，
# AI 调整后 NPC 不被截掉、主要角色补齐）→ 写入酒馆后检查卡片 JSON（正则、脚本、立绘配置）与世界书（[initvar] 的嵌套 YAML 能被 zod 结构解析、更新规则里的分组路径）
import json, os, subprocess, sys, time
from playwright.sync_api import sync_playwright

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
SHOTS = sys.argv[1] if len(sys.argv) > 1 else '/tmp/nl-statusbar-multi'
os.makedirs(SHOTS, exist_ok=True)
PORT = 8777
server = subprocess.Popen([sys.executable, '-m', 'http.server', str(PORT), '--bind', '127.0.0.1'], cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1)

NOVEL = '\n'.join([
    '第一章 魔女小姐', '江酒走进酒吧。莉莉丝坐在角落，黑色长裙拖到地上。', '“没错，今晚我是来跟你提分手的。”江酒说。', '莉莉丝把一瓶紫色魔药推到他面前。\n' * 8,
    '第二章 女仆', '江酒穿上了女仆装。', '“挺合身。”莉莉丝说，“明天开始打扫阁楼。”', '他叹了口气，拎起扫帚上楼。楼梯吱呀作响。\n' * 8,
    '第三章 雨中', '雨夜，姜小白推开了那家店的门。江酒把毛巾递给她，莉莉丝在楼上翻书。', '她说自己迷路了。\n' * 8,
])
# harness.html 里 mock 的世界卡变量表（SB_WORLD_SPEC）
WORLD_PATHS = ['世界.时间', '世界.地点', '主角.身份', '主要角色', 'NPC']
ENSEMBLE_PATHS = ['世界.时间', '世界.地点', '主角.身份', '主要角色', 'NPC']
REGEX_NAMES = ['[NL界面]状态栏', '[NL不发送]状态栏占位符', '[NL不发送]去除变量更新', '[NL折叠]变量更新中', '[NL折叠]完整变量更新']
ENTRY_COMMENTS = ['[initvar]变量初始化勿开', '变量列表', '[mvu_update]变量更新规则', '[mvu_update]变量输出格式']
TAG = '<StatusPlaceHolderImpl/>'
IMG = 'https://img.example.com/'
IMG1, IMG2, IMG3 = IMG + 'lilith-1.png', IMG + 'lilith-2.png', IMG + 'lilith-3.png'
IMG_HOSTILE, IMG_NPC, IMG_BROKEN = IMG + 'npc-hostile.png', IMG + 'npc-any.png', IMG + 'broken.png'
# 1×1 PNG
PNG = bytes.fromhex('89504e470d0a1a0a0000000d4948445200000001000000010802000000907753de0000000c4944415478da63f8cfc0000003010100c9fe92ef0000000049454e44ae426082')
SIM = '\n'.join([
    '江酒换上了女仆装，莉莉丝看得很满意。门口来了两个陌生人。',
    '<UpdateVariable>',
    '<JSONPatch>',
    json.dumps([
        {'op': 'replace', 'path': '/主要角色/莉莉丝/服饰/上衣', 'value': '女仆装'},
        {'op': 'delta', 'path': '/主要角色/莉莉丝/好感', 'value': 55},
        {'op': 'insert', 'path': '/NPC/黑衣人', 'value': {'身份': '刺客', '阵营': '敌对'}},
        {'op': 'insert', 'path': '/NPC/卖花女', 'value': {'身份': '路人'}},
    ], ensure_ascii=False),
    '</JSONPatch>',
    '</UpdateVariable>',
])
errors = []


def shot(page, name):
    page.wait_for_timeout(300)
    page.screenshot(path=os.path.join(SHOTS, name + '.png'))


def wait_log(page, text, timeout=30000):
    page.wait_for_function('(t) => [...document.querySelectorAll(".nl-log-line")].some(l => l.textContent.includes(t))', arg=text, timeout=timeout)


def ev(page, js, arg=None):
    return page.evaluate(js, arg) if arg is not None else page.evaluate(js)


def top(page):
    return page.locator('.nl-dialog-overlay').last


def step(msg):
    print('==', msg, flush=True)


def sbar(page):
    return ev(page, 'NovelLoom.app.project.cards[0].statusBar')


def frame(page):
    return page.frame_locator('iframe[data-sb-frame]')


def poll(fn, expect, what, timeout=10000):
    """反复取值直到等于 expect（预览 iframe 正在载入时取值会出错，重试）"""
    deadline = time.time() + timeout / 1000
    last = None
    while time.time() < deadline:
        try:
            last = fn()
            if last == expect:
                return last
        except Exception as e:
            last = 'ERR ' + str(e).split('\n')[0]
        time.sleep(0.15)
    raise AssertionError(f'{what} 应为 {expect!r}，实际 {last!r}')


def card_pt(page, i=0, cls='.wb-card'):
    return frame(page).locator(cls).nth(i).locator('[data-nl-portrait]').first


def pt_src(page, i=0, cls='.wb-card'):
    return card_pt(page, i, cls).get_attribute('src', timeout=1000)


def pt_state(page, i=0, cls='.wb-card'):
    return card_pt(page, i, cls).get_attribute('data-nl-portrait-state', timeout=1000)


def close_dialog(page):
    top(page).locator('.nl-dialog-foot button:has-text("关闭")').click()
    page.wait_for_selector('.nl-dialog-overlay', state='detached')


def open_sb_dialog(page):
    page.click('.nl-cardbox [data-act="statusbar"]')
    page.wait_for_selector('.nl-sb-tabs')


def tab(page, name):
    page.click(f'[data-act="sb-tab"][data-tab="{name}"]')
    page.wait_for_selector(f'[data-act="sb-tab"][data-tab="{name}"].active')


def fill_tab(page, sel, value):
    """填好后按 Tab 离开输入框（触发 change：立绘 / 字段编辑器在 change 时保存并重绘）"""
    page.fill(sel, value)
    page.press(sel, 'Tab')
    page.wait_for_timeout(120)


def stored(page, key):
    return ev(page, '(k) => localStorage.getItem(k)', key)


def images(route):
    url = route.request.url
    if 'broken' in url:
        route.fulfill(status=404, content_type='text/plain', body='missing')
    else:
        route.fulfill(status=200, content_type='image/png', body=PNG)


def cdn(route):
    url = route.request.url
    route.fulfill(status=200, content_type='text/css' if url.endswith('.css') else 'application/javascript', body='')


try:
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={'width': 1360, 'height': 900})
        page.on('pageerror', lambda e: errors.append('pageerror: ' + str(e)))
        # broken.png 故意 404（检查缩略图的加载失败提示），这条不算错误
        page.on('console', lambda m: errors.append('console: ' + m.text) if m.type == 'error' and '404' not in m.text else None)
        page.route('**/testingcf.jsdelivr.net/**', cdn)
        page.route('https://img.example.com/**', images)
        page.goto(f'http://127.0.0.1:{PORT}/tests/browser/harness.html')
        page.wait_for_selector('#nl-wand-button')
        page.evaluate("NovelLoom.open('project')")
        page.wait_for_selector('.nl-window')

        step('导入 + 提取')
        page.click('[data-act="paste"]')
        page.fill('.nl-dialog textarea', NOVEL)
        page.click('.nl-dialog-foot button:has-text("确定")')
        page.fill('#nl-bookname', '魔女')
        page.click('[data-act="create"]')
        page.wait_for_selector('.nl-chunk')
        page.click('.nl-nav-btn[data-tab="extract"]')
        page.click('[data-act="start"]')
        wait_log(page, '提取结束', timeout=60000)
        imp = ev(page, 'Object.fromEntries(Object.values(NovelLoom.app.project.characters).map(c => [c.name, c.importance]))')
        print('characters:', imp)
        assert imp.get('江酒') == 'main' and imp.get('莉莉丝') == 'main' and imp.get('姜小白') == 'support', imp

        step('写世界/旁白卡：勾选「同时生成状态栏」')
        page.click('.nl-nav-btn[data-tab="cards"]')
        page.wait_for_selector('[data-act="generate"]')
        page.select_option('[data-form="kind"]', 'world')
        page.wait_for_selector('[data-form="charName"]', state='hidden')
        page.click('details:has(> summary:has-text("写卡选项")) > summary')
        page.check('[data-setting="cards.statusBar"]')
        assert page.locator('[data-sb-form-opts]').is_visible()
        note = page.locator('[data-sb-form-note]').inner_text()
        print('form note:', note[:60])
        assert '整个群像' in note and '旁白' in note, note
        page.fill('[data-form="statusBarRequirement"]', '主要角色记录好感、心情和服饰；NPC 记身份和阵营')
        shot(page, '01-world-form')
        page.click('[data-act="generate"]')
        page.wait_for_selector('.nl-dialog-overlay .nl-dialog-head:has-text("编辑角色卡")', timeout=30000)
        card_id = ev(page, 'NovelLoom.app.project.cards[0].id')
        assert ev(page, 'NovelLoom.app.project.cards[0].kind') == 'world' and ev(page, 'NovelLoom.app.project.cards[0].data.name') == '魔女旁白'
        sb = sbar(page)
        calls = ev(page, '[window.__sbSpecCalls, window.__sbHtmlCalls]')
        cast = sb['spec']['variables'][3]
        print('status calls:', calls, 'paths:', [v['path'] for v in sb['spec']['variables']], 'cast:', list(cast['init']), 'mode:', sb['mode'], 'error:', repr(sb['error']))
        assert calls == [1, 1], calls
        assert [v['path'] for v in sb['spec']['variables']] == WORLD_PATHS
        assert sb['mode'] == 'bind' and 'wb-card' in sb['html'] and sb['error'] == '' and sb['lint']['errors'] == [], sb['lint']
        assert list(cast['init']) == ['莉莉丝', '江酒'], '世界卡：AI 漏掉的主要角色江酒由 NovelLoom 补上（配角姜小白不补）'
        assert cast['init']['江酒'] == {'好感': 20, '心情': '平静', '服饰': {'上衣': '', '下装': ''}}, cast['init']['江酒']
        assert sb['spec']['variables'][4]['init'] == {}
        wait_log(page, '已把 1 个主要角色预先填进「主要角色」')
        spec_prompt = ev(page, "window.__prompts.find(t => t.includes('设计状态栏变量表'))")
        assert '世界/旁白卡的变量设计' in spec_prompt and '江酒' in spec_prompt and '莉莉丝' in spec_prompt
        html_prompt = ev(page, "window.__prompts.find(t => t.includes('设计状态栏界面'))")
        assert '世界/旁白卡的界面' in html_prompt and 'data-nl-portrait' in html_prompt and 'data-nl-group' in html_prompt
        assert 'img.example.com' not in html_prompt
        world_field = top(page).locator('[data-card-world]').input_value()
        assert world_field.endswith('·魔女旁白'), world_field
        top(page).locator('.nl-dialog-foot button:has-text("取消")').click()
        page.wait_for_selector('.nl-dialog-overlay', state='detached')
        assert page.locator('.nl-cardbox .nl-tag:has-text("世界卡")').count() == 1
        assert page.locator('.nl-cardbox .nl-tag:has-text("状态栏")').count() == 1
        shot(page, '02-card-list')

        step('状态栏对话框：世界卡说明、分组字段')
        open_sb_dialog(page)
        assert '（世界卡）' in top(page).locator('.nl-dialog-head').inner_text()
        assert page.locator('[data-sb-world-hint]').is_visible()
        rows = page.locator('.nl-sb-table tr[data-sb-tr]').count()
        assert rows == 5 and page.locator('.nl-sb-table tr.nl-sb-bad').count() == 0
        fr = page.locator('tr.nl-sb-fields-row[data-sb-fields-row="3"]')
        assert fr.count() == 1 and page.locator('tr.nl-sb-fields-row[data-sb-fields-row="4"]').count() == 1
        count_text = fr.locator('[data-sb-fields-count]').inner_text()
        print('fields count:', count_text)
        assert '3 / 8 项' in count_text and '算 4 个变量' in count_text, count_text
        assert fr.locator('.nl-sb-grp').count() == 1 and '2 / 6 个字段' in fr.locator('[data-sb-grp-count]').inner_text()
        assert fr.locator('[data-sb-k="fields"]').count() == 1, '原来的 JSON 编辑框还在'
        # 在「服饰」分组里加一个字段，改名为配饰
        page.click('[data-act="sb-fld-add"][data-sb-i="3"][data-sb-fld="2"]')
        page.wait_for_selector('[data-sb-row="3"][data-sb-fld="2.2"][data-sb-fp="key"]')
        fill_tab(page, '[data-sb-row="3"][data-sb-fld="2.2"][data-sb-fp="key"]', '配饰')
        page.wait_for_function("() => NovelLoom.app.project.cards[0].statusBar.spec.variables[3].value.fields[2].fields.map(f => f.key).join() === '上衣,下装,配饰'")
        sb = sbar(page)
        assert sb['spec']['variables'][3]['init']['莉莉丝']['服饰'] == {'上衣': '黑色长裙', '下装': '', '配饰': ''}, '已有条目补上新字段的初始值'
        assert '算 5 个变量' in page.locator('tr.nl-sb-fields-row[data-sb-fields-row="3"] [data-sb-fields-count]').inner_text()
        assert '10 / 12 个变量' in page.locator('[data-sb-count]').inner_text()
        # 填入主要角色：都已经在了
        page.click('[data-act="sb-seed-cast"][data-sb-i="3"]')
        page.wait_for_selector('[data-sb-flash]')
        flash = page.locator('[data-sb-flash]').inner_text()
        print('seed flash:', flash)
        assert '已经有这些角色了' in flash
        shot(page, '03-grouped-fields')

        step('立绘分页：角色、解锁条件、地址检查、图池')
        tab(page, 'portraits')
        chips = ev(page, "[...document.querySelectorAll('[data-act=\"sb-pt-add-name\"]')].map(b => b.dataset.sbName)")
        print('candidates:', chips)
        assert chips[:2] == ['莉莉丝', '江酒'] and '世界' in chips and '主角' in chips, chips
        page.click('[data-act="sb-pt-add-name"][data-sb-name="莉莉丝"]')
        page.wait_for_selector('[data-sb-pt="url"][data-sb-pt-c="0"][data-sb-pt-i="0"]')
        fill_tab(page, '[data-sb-pt="url"][data-sb-pt-c="0"][data-sb-pt-i="0"]', IMG1)
        for ii, (url, at) in enumerate([(IMG2, '20'), (IMG3, '80')], start=1):
            page.click('[data-act="sb-pt-add-img"][data-sb-pt-c="0"]')
            page.wait_for_selector(f'[data-sb-pt="url"][data-sb-pt-c="0"][data-sb-pt-i="{ii}"]')
            fill_tab(page, f'[data-sb-pt="url"][data-sb-pt-c="0"][data-sb-pt-i="{ii}"]', url)
            fill_tab(page, f'[data-sb-pt="whenPath"][data-sb-pt-c="0"][data-sb-pt-i="{ii}"]', '好感')
            page.select_option(f'[data-sb-pt="whenOp"][data-sb-pt-c="0"][data-sb-pt-i="{ii}"]', '>=')
            fill_tab(page, f'[data-sb-pt="whenValue"][data-sb-pt-c="0"][data-sb-pt-i="{ii}"]', at)
        # 不合法的地址：就地标红，不保存；改成打不开的地址：缩略图显示加载失败；然后删掉这一张
        page.click('[data-act="sb-pt-add-img"][data-sb-pt-c="0"]')
        bad_sel = '[data-sb-pt="url"][data-sb-pt-c="0"][data-sb-pt-i="3"]'
        page.wait_for_selector(bad_sel)
        page.fill(bad_sel, 'ftp://img.example.com/x.png')
        page.wait_for_selector('[data-sb-pt-msg="0.3"] .nl-err', timeout=3000)
        assert page.get_attribute(bad_sel, 'aria-invalid') == 'true'
        page.press(bad_sel, 'Tab')
        page.wait_for_selector('[data-sb-pt-bad]')
        assert len(sbar(page)['portraits']['characters']['莉莉丝']) == 3, '标红的那张不保存'
        fill_tab(page, bad_sel, IMG_BROKEN)
        page.wait_for_selector('[data-sb-pt-row="0.3"] [data-sb-thumb-wrap][data-state="error"]', timeout=5000)
        page.click('[data-act="sb-pt-img-del"][data-sb-pt-c="0"][data-sb-pt-i="3"]')
        page.wait_for_selector('[data-sb-pt-row="0.3"]', state='detached')
        # 缩略图载入；按示例数据（好感 30）第二张是默认显示，第三张未解锁
        for ii in range(3):
            page.wait_for_selector(f'[data-sb-pt-row="0.{ii}"] [data-sb-thumb-wrap][data-state="ok"]', timeout=5000)
        assert '默认显示' in page.locator('[data-sb-pt-row="0.1"]').inner_text()
        assert '未解锁' in page.locator('[data-sb-pt-row="0.2"]').inner_text() and '未解锁' not in page.locator('[data-sb-pt-row="0.0"]').inner_text()
        # 图池：NPC 按阵营取图，没有对应的值时用兜底
        page.click('[data-act="sb-pool-add"]')
        page.wait_for_selector('[data-sb-pool="record"][data-sb-pool-p="0"]')
        page.select_option('[data-sb-pool="record"][data-sb-pool-p="0"]', 'NPC')
        page.wait_for_timeout(150)
        page.select_option('[data-sb-pool="field"][data-sb-pool-p="0"]', '阵营')
        page.wait_for_timeout(150)
        fill_tab(page, '[data-sb-pool="value"][data-sb-pool-p="0"][data-sb-pool-v="0"]', '敌对')
        fill_tab(page, '[data-sb-pool="urls"][data-sb-pool-p="0"][data-sb-pool-v="0"]', IMG_HOSTILE)
        fill_tab(page, '[data-sb-pool="fallback"][data-sb-pool-p="0"]', IMG_NPC)
        page.wait_for_timeout(200)
        pt = sbar(page)['portraits']
        print('portraits:', json.dumps(pt, ensure_ascii=False))
        assert [i['url'] for i in pt['characters']['莉莉丝']] == [IMG1, IMG2, IMG3]
        assert 'when' not in pt['characters']['莉莉丝'][0]
        assert pt['characters']['莉莉丝'][1]['when'] == {'path': '好感', 'op': '>=', 'value': 20}
        assert pt['characters']['莉莉丝'][2]['when'] == {'path': '好感', 'op': '>=', 'value': 80}
        assert pt['pools'] == [{'record': 'NPC', 'field': '阵营', 'pools': {'敌对': [IMG_HOSTILE]}, 'fallback': [IMG_NPC]}]
        assert page.locator('[data-sb-pt-bad]').count() == 0
        assert 'nl-ok' in page.get_attribute('[data-sb-pt-display]', 'class'), '当前界面有 data-nl-portrait，会显示立绘'
        assert page.locator('[data-act="sb-tab"][data-tab="portraits"] .nl-num').inner_text().strip() == '2', '1 个角色 + 1 个图池'
        shot(page, '04-portraits')

        step('预览：立绘、换一张只在已解锁的图之间轮换，选择记住（预览重新载入后还在）')
        tab(page, 'preview')
        page.wait_for_selector('iframe[data-sb-frame]')
        assert '换过的图会记住' in page.locator('[data-sb-preview-pt]').inner_text()
        poll(lambda: frame(page).locator('.wb-card').count(), 2, '主要角色卡片数')
        poll(lambda: pt_src(page, 0), IMG2, '莉莉丝的立绘（最高的已解锁）')
        poll(lambda: pt_state(page, 0), 'ok', '莉莉丝的立绘状态')
        assert frame(page).locator('.wb-card').nth(0).locator('.wb-name').inner_text() == '莉莉丝'
        assert pt_state(page, 1) == 'empty' and frame(page).locator('.wb-card').nth(1).locator('[data-nl-ph]').inner_text() == '江', '江酒没有立绘：首字占位'
        assert frame(page).locator('.wb-card').nth(1).locator('.wb-swap').is_hidden()
        assert frame(page).locator('.wb-card').nth(0).locator('.wb-top').inner_text() == '黑色长裙'
        dress = frame(page).locator('.wb-card').nth(0).locator('.wb-dress li').all_inner_texts()
        print('dress:', dress)
        assert len(dress) == 3 and dress[0] == '上衣=黑色长裙' and dress[2].startswith('配饰='), dress
        assert frame(page).locator('.wb-npcs .nl-each-empty').inner_text() == '还没有 NPC'
        key = f'nl-sb:{card_id}:莉莉丝'
        assert stored(page, key) is None
        swap = lambda: frame(page).locator('.wb-card').nth(0).locator('.wb-swap').click()
        seen = []
        for _ in range(4):
            swap()
            page.wait_for_timeout(120)
            seen.append(pt_src(page, 0))
        print('swap cycle:', [s.rsplit('/', 1)[-1] for s in seen])
        assert seen == [IMG1, IMG2, IMG1, IMG2], '只在已解锁的两张之间轮换（第三张好感 80 才解锁）'
        assert stored(page, key) is None, '回到默认那张时不再记着'
        swap()
        poll(lambda: stored(page, key), IMG1, '酒馆页面本地存储里记着的选择（与聊天共用的键）')
        assert pt_src(page, 0) == IMG1
        assert page.locator('[data-sb-preview-errs] .nl-sb-note-err').count() == 0
        shot(page, '05-preview-swapped')
        # 重新载入预览：仍是选的那张
        frame(page).locator('body').evaluate("b => b.setAttribute('data-old-load', '1')")
        page.click('[data-act="sb-preview-reload"]')
        poll(lambda: frame(page).locator('body[data-old-load]').count(), 0, '预览重新载入')
        poll(lambda: pt_src(page, 0), IMG1, '重新载入后莉莉丝的立绘')
        poll(lambda: pt_state(page, 0), 'ok', '重新载入后立绘状态')
        # 切到别的分页再回来（预览重建）：还是选的那张
        tab(page, 'vars')
        tab(page, 'preview')
        poll(lambda: pt_src(page, 0), IMG1, '切换分页后莉莉丝的立绘')

        step('模拟一轮更新：分组字段、解锁第三张（记着的选择仍有效）、NPC 按阵营从图池取图')
        page.fill('[data-sb-f="reply"]', SIM)
        page.click('[data-act="sb-sim"]')
        sim_msg = page.locator('[data-sb-sim-msg]').inner_text()
        print('sim msg:', sim_msg)
        assert '应用了 4 / 4 条更新' in sim_msg, sim_msg
        poll(lambda: frame(page).locator('.wb-card').nth(0).locator('.wb-top').inner_text(timeout=1000), '女仆装', '分组字段 服饰.上衣')
        poll(lambda: frame(page).locator('.wb-card').nth(0).locator('.wb-stage').inner_text(timeout=1000), '依恋', '好感 85 的阶段')
        poll(lambda: frame(page).locator('.wb-card').nth(0).locator('.wb-swap').get_attribute('data-nl-portrait-count', timeout=1000), '3', '好感 85：三张都解锁')
        assert pt_src(page, 0) == IMG1, '记着的选择仍在已解锁列表里，继续显示'
        poll(lambda: frame(page).locator('.wb-npc').count(), 2, 'NPC 卡片数')
        assert frame(page).locator('.wb-npc').nth(0).locator('.wb-npc-name').inner_text() == '黑衣人'
        poll(lambda: pt_src(page, 0, '.wb-npc'), IMG_HOSTILE, '敌对 NPC 的图池立绘')
        poll(lambda: pt_src(page, 1, '.wb-npc'), IMG_NPC, '中立 NPC 用兜底')
        assert frame(page).locator('.wb-npc').nth(1).locator('.wb-faction').inner_text() == '中立'
        assert frame(page).locator('.wb-npc').nth(0).locator('[data-nl-portrait-next]').count() == 0
        shot(page, '06-preview-updated')

        step('套用「多人群像」（沿用结构 + AI 调整）：模板自带上限 15，不截掉 NPC')
        tab(page, 'vars')
        page.click('.nl-sb-toolbar [data-act="sb-templates"]')
        page.wait_for_selector('.nl-dialog-overlay [data-tpl-id="builtin_ensemble"]')
        item = top(page).locator('[data-tpl-id="builtin_ensemble"]')
        item_text = item.inner_text()
        print('library item:', item_text.replace('\n', ' | '))
        assert '15 个变量' in item_text and '自带上限 15' in item_text and '超过上限' not in item_text
        item.locator('[data-act="tpl-apply"]').click()
        page.wait_for_selector('.nl-dialog-head:has-text("套用模板")')
        assert top(page).locator('input[name="nl-sb-tpl-mode"][value="structure"]').is_checked()
        assert top(page).locator('[data-f="ai"]').is_checked()
        cap_note = top(page).locator('[data-sb-tpl-cap]').inner_text()
        print('cap note:', cap_note)
        assert '自带上限 15' in cap_note and '会保留全部变量' in cap_note
        spec_calls = ev(page, 'window.__sbSpecCalls')
        top(page).locator('.nl-dialog-foot button:has-text("套用")').click()
        wait_log(page, '已套用状态栏模板「多人群像」', timeout=20000)
        sb = sbar(page)
        leaves = ev(page, "async () => (await import('/src/statusbar.js')).countSpecLeaves(NovelLoom.app.project.cards[0].statusBar.spec)")
        print('ensemble:', sb['templateId'], [v['path'] for v in sb['spec']['variables']], 'leaves', leaves, 'lint', sb['lint'], 'error', repr(sb['error']))
        assert ev(page, 'window.__sbSpecCalls') == spec_calls + 1
        assert sb['templateId'] == 'builtin_ensemble' and [v['path'] for v in sb['spec']['variables']] == ENSEMBLE_PATHS and leaves == 15
        assert sb['lint'] == {'errors': [], 'warnings': []} and sb['error'] == ''
        print('ensemble cast:', list(sb['spec']['variables'][3]['init']))
        assert sorted(sb['spec']['variables'][3]['init']) == sorted(['莉莉丝', '江酒']), '世界卡：主要角色补齐（模板的主要角色记录本来是空的）'
        assert sb['spec']['variables'][3]['init']['江酒']['服饰'] == {'上衣': '', '下装': '', '配饰': ''}
        assert sb['spec']['variables'][4]['init'] == {}
        assert [i['url'] for i in sb['portraits']['characters']['莉莉丝']] == [IMG1, IMG2, IMG3], '卡片自己的立绘保留'
        notes = page.locator('[data-sb-run-notes]').inner_text()
        assert '按模板自带的上限 15 保留全部变量' in notes, notes
        assert '15 / 15 个变量' in page.locator('[data-sb-count]').inner_text()
        assert page.locator('.nl-sb-table tr.nl-sb-bad').count() == 0
        # 编辑任意一行：变量表按这张卡的上限（15）校验，NPC 不会被当作超出上限丢掉
        fill_tab(page, '[data-sb-row="0"][data-sb-k="init"]', '第一日 黄昏')
        page.wait_for_timeout(200)
        sb = sbar(page)
        assert [v['path'] for v in sb['spec']['variables']] == ENSEMBLE_PATHS and sb['spec']['variables'][0]['init'] == '第一日 黄昏'
        assert page.locator('.nl-sb-table tr.nl-sb-bad').count() == 0
        shot(page, '07-ensemble-vars')
        tab(page, 'preview')
        poll(lambda: frame(page).locator('.qx-card').count(), 2, '多人群像：主要角色卡片数（详情层另算）')
        lili = frame(page).locator('.qx-card').filter(has=frame(page).locator('.qx-nm', has_text='莉莉丝'))
        assert lili.count() == 1
        poll(lambda: lili.locator('img.qx-img').get_attribute('src', timeout=1000), IMG1, '多人群像里莉莉丝的立绘（沿用记住的选择）')
        poll(lambda: lili.locator('img.qx-img').get_attribute('data-nl-portrait-state', timeout=1000), 'ok', '多人群像里莉莉丝的立绘状态')
        jiang = frame(page).locator('.qx-card').filter(has=frame(page).locator('.qx-nm', has_text='江酒'))
        assert jiang.locator('.nl-portrait-ph').inner_text() == '江' and jiang.locator('img.qx-img').get_attribute('data-nl-portrait-state') == 'empty'
        assert page.locator('[data-sb-preview-errs] .nl-sb-note-err').count() == 0
        shot(page, '08-ensemble-preview')
        # 撤销回到世界卡自己的变量表，再撤销一次恢复
        page.click('[data-act="sb-undo"]')
        page.wait_for_timeout(200)
        assert sbar(page)['templateId'] is None and sbar(page)['spec']['variables'][3]['value']['fields'][2]['key'] == '服饰'
        page.click('[data-act="sb-undo"]')
        page.wait_for_timeout(200)
        assert sbar(page)['templateId'] == 'builtin_ensemble' and [v['path'] for v in sbar(page)['spec']['variables']] == ENSEMBLE_PATHS
        # 存为模板：卡上有立绘时可以连同立绘设置一起存（默认不勾）；变量多于 12 个时模板记下自带上限
        page.click('.nl-sb-toolbar [data-act="sb-save-tpl"]')
        page.wait_for_selector('.nl-dialog-head:has-text("存为状态栏模板")')
        cb = top(page).locator('[data-f="portraits"]')
        assert cb.count() == 1 and not cb.is_checked()
        assert '连同立绘设置（1 个角色、1 个图池' in top(page).locator('.nl-dialog-body').inner_text()
        cb.check()
        top(page).locator('[data-f="name"]').fill('魔女群像')
        top(page).locator('.nl-dialog-foot button:has-text("保存")').click()
        wait_log(page, '已保存状态栏模板「魔女群像」')
        saved_tpl = ev(page, "NovelLoom.app.settings.statusBarTemplates.find(t => t.name === '魔女群像')")
        assert saved_tpl['maxVars'] == 15 and [i['url'] for i in saved_tpl['portraits']['characters']['莉莉丝']] == [IMG1, IMG2, IMG3]
        assert saved_tpl['portraits']['pools'][0]['field'] == '阵营'
        close_dialog(page)

        step('写入酒馆：卡片 JSON（正则、脚本、立绘配置）与世界书（嵌套 YAML、分组路径）')
        n = ev(page, 'window.__saved.imports.length')
        page.click('.nl-cardbox [data-act="publish"]')
        page.wait_for_function('(n) => window.__saved.imports.length === n + 1', arg=n, timeout=15000)
        page.wait_for_selector('.nl-dialog-head:has-text("状态栏卡")', timeout=15000)
        shot(page, '09-publish-hint')
        card = json.loads(ev(page, 'window.__saved.lastImport.text'))
        d = card['data']
        ext = d['extensions']
        world = ext['world']
        rx = ext['regex_scripts']
        th = ext['tavern_helper']
        nl = ext['novel_loom']
        print('card:', d['name'], 'world:', world, 'regex:', [r['scriptName'] for r in rx], 'scripts:', [s['name'] for s in th['scripts']])
        assert d['name'] == '魔女旁白' and nl['kind'] == 'world'
        assert world.endswith('·魔女旁白') and d['character_book']['name'] == world
        assert [r['scriptName'] for r in rx] == REGEX_NAMES
        rep = rx[0]['replaceString']
        assert rx[0]['findRegex'] == TAG and rep.startswith('\n```html\n') and 'qx-card' in rep
        assert f'window.NL_CARD_ID = "{card_id}"' in rep and 'window.NL_PORTRAITS' in rep
        assert all(u in rep for u in [IMG1, IMG2, IMG3, IMG_HOSTILE, IMG_NPC])
        assert [s['name'] for s in th['scripts']] == ['MVU', '变量结构']
        schema = th['scripts'][1]['content']
        assert '"服饰": z.object({' in schema and '}).prefault({})' in schema and '</script' not in schema
        assert d['first_mes'].endswith(TAG) and card['first_mes'].endswith(TAG)
        assert d['alternate_greetings'] and all(g.endswith(TAG) for g in d['alternate_greetings'])
        assert nl['statusBar']['templateId'] == 'builtin_ensemble'
        assert [v['path'] for v in nl['statusBar']['spec']['variables']] == ENSEMBLE_PATHS
        assert [i['url'] for i in nl['statusBar']['portraits']['characters']['莉莉丝']] == [IMG1, IMG2, IMG3]
        assert nl['statusBar']['portraits']['pools'][0]['record'] == 'NPC'
        book = {e['comment']: e for e in d['character_book']['entries']}
        assert all(c in book for c in ENTRY_COMMENTS), list(book)
        saved = ev(page, '(w) => window.__saved.worlds[w]', world)
        assert saved, f'世界书「{world}」没有写入酒馆'
        wentries = {e['comment']: e for e in saved['entries'].values()}
        print('world entries:', list(wentries))
        assert all(c in wentries for c in ENTRY_COMMENTS)
        initvar = wentries['[initvar]变量初始化勿开']
        rules = wentries['[mvu_update]变量更新规则']
        assert initvar['disable'] is True and rules['disable'] is False
        # 用真正的 yaml 与 zod（node_modules 里的浏览器版）检查：[initvar] 的嵌套 YAML 解析出的初始变量能原样通过导出的「变量结构」脚本
        check = ev(page, """async ({ initText, rulesText, schemaCode }) => {
            const YAML = (await import('/node_modules/yaml/browser/index.js')).default;
            const z = (await import('/node_modules/zod/index.js')).z;
            const init = YAML.parse(initText);
            const rules = YAML.parse(rulesText);
            const body = schemaCode.split('\\n').filter((l) => !/^import\\s/.test(l) && !/^\\$\\(/.test(l)).join('\\n').replace('export const Schema', 'const Schema');
            const Schema = new Function('z', body + '\\nreturn Schema;')(z);
            const parsed = Schema.safeParse(init);
            const partial = Schema.safeParse({ 主要角色: { 新人: { 好感: 120, 服饰: { 上衣: '风衣' } } } });
            return { init, rules, ok: parsed.success, same: parsed.success && JSON.stringify(parsed.data) === JSON.stringify(init),
                     partial: partial.success ? partial.data.主要角色.新人 : String(partial.error) };
        }""", {'initText': initvar['content'], 'rulesText': rules['content'], 'schemaCode': schema})
        init = check['init']
        print('initvar 主要角色:', json.dumps(init['主要角色'], ensure_ascii=False))
        assert sorted(init['主要角色']) == sorted(['莉莉丝', '江酒']) and init['主要角色']['莉莉丝']['服饰'] == {'上衣': '', '下装': '', '配饰': ''}
        assert init['世界']['时间'] == '第一日 黄昏' and init['NPC'] == {}
        assert check['ok'] and check['same'], check
        assert check['partial']['好感'] == 100 and check['partial']['服饰'] == {'上衣': '风衣', '下装': '', '配饰': ''}, check['partial']
        cast_rules = check['rules']['变量更新规则']['主要角色']
        print('rules paths:', cast_rules.get('paths'))
        assert '/主要角色/<角色名>/服饰/上衣' in cast_rules['paths'] and '服饰: {' in cast_rules['type']
        assert rules['ignoreBudget'] is True and rules['position'] == 4
        assert '<UpdateVariable>' in wentries['[mvu_update]变量输出格式']['content']
        top(page).locator('.nl-dialog-foot button:has-text("知道了")').click()
        page.wait_for_selector('.nl-dialog-overlay', state='detached')
        browser.close()
finally:
    server.terminate()

print('ERRORS:', json.dumps(errors, ensure_ascii=False, indent=1))
sys.exit(1 if errors else 0)
