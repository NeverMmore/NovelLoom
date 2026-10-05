# 浏览器冒烟测试（v0.15 杂项）：关系类型自由填写（AI 分析给出 师兄妹 / 主仆 等自由类型 → 列表、图谱、图例的名字和颜色；
# 编辑时直接输入类型、输入已知类型的名字存成它的 value；按自由类型筛选、点图例筛选；关系模板里的自由类型）→
# 设置页的变量上限（3~100，默认 20，旁边有一句说明）与「写入后自动允许」开关 →
# 写入带状态栏的卡：自动把头像加进酒馆的正则允许名单、推进假的酒馆助手 pinia store（启用 + 不再弹窗）；
# 没有 store 时改 extension_settings.tavern_helper 并提示刷新；关掉开关后不再自动授权 → 窄屏
import json, os, subprocess, sys, time
from playwright.sync_api import sync_playwright

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
OUT = sys.argv[1] if len(sys.argv) > 1 else '/tmp/nl-misc-v15'
os.makedirs(OUT, exist_ok=True)
PORT = 8783
server = subprocess.Popen([sys.executable, '-m', 'http.server', str(PORT), '--bind', '127.0.0.1'], cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1)

NOVEL = '\n'.join([
    '第一章 魔女小姐', '江酒走进酒吧。莉莉丝坐在角落，黑色长裙拖到地上。', '“没错，今晚我是来跟你提分手的。”江酒说。', '莉莉丝把一瓶紫色魔药推到他面前。\n' * 8,
    '第二章 女仆', '江酒穿上了女仆装。', '“挺合身。”莉莉丝说，“明天开始打扫阁楼。”', '他叹了口气，拎起扫帚上楼。楼梯吱呀作响。\n' * 8,
    '第三章 下城区', '姜小白在雨中迷路，走进了那家店。', '“请问……这里是下城区吗？”', '江酒给她倒了一杯热水，指了指窗外的霓虹灯。\n' * 8,
])
# AI 分析关系的模拟回复：三种自由类型（主仆 → 师徒/上下级的颜色，师兄妹 → 同伴/盟友的颜色，契约者 → 按文字算的颜色）
REL_MOCK = """(prompt) => JSON.stringify({ relationships: [
  { from: '莉莉丝', to: '江酒', type: '主仆', mutual: false, label: '她让他穿上女仆装打扫阁楼' },
  { from: '江酒', to: '姜小白', type: '师兄妹', mutual: true, label: '都跟着莉莉丝学魔药' },
  { from: '莉莉丝', to: '姜小白', type: '契约者', mutual: false, label: '雨夜里立下了契约' },
] })"""
# 假的酒馆助手（JS-Slash-Runner 4.x）：#tavern_helper 上挂 Vue 应用，$pinia._s 里的 'global_settings' store
FAKE_JSR = """() => {
  document.getElementById('tavern_helper')?.remove();
  const el = document.createElement('div');
  el.id = 'tavern_helper';
  const store = { settings: { script: { enabled: { global: true, presets: [], characters: ['someone.png'] }, popuped: { presets: [], characters: ['someone.png'] }, scripts: [] } } };
  el.__vue_app__ = { config: { globalProperties: { $pinia: { _s: new Map([['global_settings', store]]) } } } };
  document.body.appendChild(el);
  window.__jsrStore = store;
}"""
MENTOR = 'rgb(155, 127, 212)'  # #9b7fd4
ALLY = 'rgb(89, 179, 179)'  # #59b3b3
FRIEND = 'rgb(76, 175, 125)'  # #4caf7d
errors = []


def shot(page, name):
    page.wait_for_timeout(250)
    page.screenshot(path=os.path.join(OUT, name + '.png'))


def settle(page):
    page.wait_for_function('document.getAnimations().every((a) => a.playState !== "running" || a.effect?.getComputedTiming().endTime === Infinity)')


def wait_log(page, text, timeout=30000):
    page.wait_for_function('(t) => [...document.querySelectorAll(".nl-log-line")].some(l => l.textContent.includes(t))', arg=text, timeout=timeout)


def log_lines(page):
    return page.evaluate('NovelLoom.app.logs.map((l) => [l.message, l.level])')


def ev(page, js, arg=None):
    return page.evaluate(js, arg) if arg is not None else page.evaluate(js)


def top(page):
    return page.locator('.nl-dialog-overlay').last


def step(msg):
    print('==', msg, flush=True)


def rels(page):
    return ev(page, 'NovelLoom.app.project.relationships.map((r) => [r.from, r.to, r.type])')


def tag_color(page, type_value):
    return ev(page, '(t) => getComputedStyle([...document.querySelectorAll(".nl-table .nl-rel-type")].find((e) => e.dataset.type === t)).color', type_value)


def row_count(page):
    return page.locator('.nl-table tbody tr').count()


def publish(page):
    n = ev(page, 'window.__saved.imports.length')
    page.click('.nl-cardbox [data-act="publish"]')
    page.wait_for_function('(n) => window.__saved.imports.length === n + 1', arg=n, timeout=15000)
    page.wait_for_selector('.nl-dialog-head:has-text("状态栏卡")', timeout=15000)
    return ev(page, 'NovelLoom.app.project.cards[0].stAvatar')


def close_hint(page):
    top(page).locator('.nl-dialog-foot button:has-text("知道了")').click()
    page.wait_for_selector('.nl-dialog-overlay', state='detached')


def cdn(route):
    url = route.request.url
    route.fulfill(status=200, content_type='text/css' if url.endswith('.css') else 'application/javascript', body='')


try:
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={'width': 1360, 'height': 900})
        page.on('pageerror', lambda e: errors.append('pageerror: ' + str(e)))
        page.on('console', lambda m: errors.append('console: ' + m.text) if m.type == 'error' else None)
        page.route('**/testingcf.jsdelivr.net/**', cdn)
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
        assert len(ev(page, 'Object.keys(NovelLoom.app.project.characters)')) >= 3

        step('AI 分析关系：自由类型原样保存，列表 / 图谱 / 图例用它的名字和颜色')
        page.click('.nl-nav-btn[data-tab="relations"]')
        page.wait_for_selector('[data-act="add"]')
        page.evaluate(f'window.__relMock = {REL_MOCK}')
        page.evaluate('window.__prompts = []')
        page.click('[data-act="analyze"]')
        page.wait_for_function('document.querySelectorAll(".nl-table tbody tr").length === 3', timeout=20000)
        wait_log(page, 'AI 分析关系：新增 3 条')
        prompt = ev(page, 'window.__prompts.filter((p) => p.includes("梳理角色之间已经明确建立的关系")).pop()')
        assert '只是参考' in prompt and '师兄妹、青梅竹马、主仆' in prompt, prompt[-1200:]
        print('relationships:', rels(page))
        assert sorted(r[2] for r in rels(page)) == sorted(['主仆', '师兄妹', '契约者'])
        tags = ev(page, '[...document.querySelectorAll(".nl-table .nl-rel-type")].map((e) => e.textContent)')
        assert sorted(tags) == sorted(['主仆', '师兄妹', '契约者']), tags
        hashed = ev(page, "async () => (await import('/src/relations.js')).hashedTypeColor('契约者')")
        hashed_rgb = ev(page, '(h) => { const d = document.createElement("i"); d.style.color = h; document.body.appendChild(d); const c = getComputedStyle(d).color; d.remove(); return c; }', hashed)
        colors = {t: tag_color(page, t) for t in ['主仆', '师兄妹', '契约者']}
        print('tag colors:', colors, 'hashed:', hashed, hashed_rgb)
        assert colors['主仆'] == MENTOR and colors['师兄妹'] == ALLY and colors['契约者'] == hashed_rgb, colors
        # 图谱：边按类型着色；箭头 id 用编号（自由类型可能带空格、括号），引用的 marker 都存在
        edges = ev(page, '[...document.querySelectorAll(".nl-rel-edge")].map((l) => [l.dataset.type, l.getAttribute("stroke"), l.getAttribute("marker-end")])')
        print('edges:', edges)
        assert len(edges) == 3
        by_type = {e[0]: e for e in edges}
        assert by_type['师兄妹'][1] == '#59b3b3' and by_type['师兄妹'][2] is None, '双向的边没有箭头'
        assert by_type['契约者'][1] == hashed
        for t in ['主仆', '契约者']:
            mid = by_type[t][2][len('url(#'):-1]
            assert mid.startswith('nl-arrow-') and ev(page, '(id) => !!document.getElementById(id)', mid), by_type[t]
        legend = ev(page, '[...document.querySelectorAll(".nl-rel-legend [data-act=legend-type]")].map((b) => [b.dataset.type, b.textContent.trim(), getComputedStyle(b.querySelector(".nl-dot")).backgroundColor])')
        print('legend:', legend)
        assert sorted(x[0] for x in legend) == sorted(['主仆', '师兄妹', '契约者'])
        assert all(x[2] in (MENTOR, ALLY, hashed_rgb) for x in legend)
        shot(page, '01-free-types')

        step('类型筛选：只列项目里用到的类型（含自由类型）；点图例也能筛')
        opts = ev(page, '[...document.querySelectorAll("[data-act-input=type] option")].map((o) => [o.value, o.textContent])')
        print('filter options:', opts)
        assert [o[0] for o in opts][0] == 'all' and sorted(o[0] for o in opts[1:]) == sorted(['主仆', '师兄妹', '契约者']), opts
        assert '主仆（1）' in [o[1] for o in opts]
        page.select_option('[data-act-input="type"]', '师兄妹')
        page.wait_for_function('document.querySelectorAll(".nl-table tbody tr").length === 1')
        assert '姜小白' in page.inner_text('.nl-table') and '主仆' not in page.inner_text('.nl-table')
        assert ev(page, 'document.querySelectorAll(".nl-rel-edge").length') == 1
        page.select_option('[data-act-input="type"]', 'all')
        page.wait_for_function('document.querySelectorAll(".nl-table tbody tr").length === 3')
        page.click('.nl-rel-legend [data-type="主仆"]')
        page.wait_for_function('document.querySelectorAll(".nl-table tbody tr").length === 1')
        assert page.get_attribute('.nl-rel-legend [data-type="主仆"]', 'aria-pressed') == 'true'
        assert page.input_value('[data-act-input="type"]') == '主仆'
        shot(page, '02-legend-filter')
        page.click('.nl-rel-legend [data-type="主仆"]')
        page.wait_for_function('document.querySelectorAll(".nl-table tbody tr").length === 3')
        assert page.input_value('[data-act-input="type"]') == 'all'

        step('编辑：直接输入类型；输入已知类型的名字存成它的 value')
        rid = ev(page, "NovelLoom.app.project.relationships.find((r) => r.type === '契约者').id")
        page.click(f'.nl-table [data-act="edit"][data-id="{rid}"]')
        page.wait_for_selector('.nl-dialog input[data-f="type"]')
        assert page.input_value('.nl-dialog input[data-f="type"]') == '契约者'
        dl = ev(page, '[...document.querySelectorAll("#" + document.querySelector(".nl-dialog input[data-f=type]").getAttribute("list") + " option")].map((o) => o.value)')
        print('datalist:', dl)
        assert '朋友' in dl and '爱慕/恋人' in dl and '师兄妹' in dl and '主仆' in dl, dl
        assert page.get_attribute('.nl-dialog input[data-f="type"]', 'maxlength') is None, '不限制长度：超过 8 个字的自定义类型名也能完整写出来'
        # 平时也画出下拉箭头，看得出能选
        assert 'linear-gradient' in ev(page, 'getComputedStyle(document.querySelector(".nl-dialog input[data-f=type]")).backgroundImage')
        # 聚焦时清空（浏览器只列出与已填文字匹配的候选，清空后才看得到完整列表），原来的文字放进占位文字；离开时没填就放回
        page.focus('.nl-dialog input[data-f="type"]')
        assert page.input_value('.nl-dialog input[data-f="type"]') == ''
        assert page.get_attribute('.nl-dialog input[data-f="type"]', 'placeholder') == '契约者'
        settle(page)
        shot(page, '03a-type-focused')
        page.focus('.nl-dialog [data-f="label"]')
        assert page.input_value('.nl-dialog input[data-f="type"]') == '契约者'
        assert page.get_attribute('.nl-dialog input[data-f="type"]', 'placeholder') == '例如：朋友、师兄妹'
        page.fill('.nl-dialog input[data-f="type"]', '青梅竹马')
        settle(page)
        shot(page, '03-edit-type')
        page.click('.nl-dialog-foot button:has-text("保存")')
        wait_log(page, '已修改关系')
        r = ev(page, '(id) => NovelLoom.app.project.relationships.find((x) => x.id === id)', rid)
        assert r['type'] == '青梅竹马', r
        assert tag_color(page, '青梅竹马') == FRIEND, '青梅竹马归到朋友的颜色'
        rid2 = ev(page, "NovelLoom.app.project.relationships.find((r) => r.type === '主仆').id")
        page.click(f'.nl-table [data-act="edit"][data-id="{rid2}"]')
        page.wait_for_selector('.nl-dialog input[data-f="type"]')
        page.fill('.nl-dialog input[data-f="type"]', '敌对')
        page.click('.nl-dialog-foot button:has-text("保存")')
        page.wait_for_function("(id) => NovelLoom.app.project.relationships.find((x) => x.id === id).type === 'enemy'", arg=rid2)
        assert '敌对' in page.inner_text('.nl-table')
        # 手动添加：类型框里写自由类型
        page.click('[data-act="add"]')
        page.wait_for_selector('.nl-dialog input[data-f="type"]')
        assert page.input_value('.nl-dialog input[data-f="type"]') == '朋友', '新关系默认「朋友」'
        page.select_option('.nl-dialog select[data-f="from"]', '姜小白')
        page.select_option('.nl-dialog select[data-f="to"]', '莉莉丝')
        page.fill('.nl-dialog input[data-f="type"]', '  债主 ')
        page.click('.nl-dialog-foot button:has-text("保存")')
        wait_log(page, '已添加关系：姜小白')
        assert ev(page, "NovelLoom.app.project.relationships.some((r) => r.from === '姜小白' && r.type === '债主')")

        step('关系模板：类型自由填写，改类型后关闭对话框也保存')
        page.click('[data-act="manage-templates"]')
        page.wait_for_selector('.nl-dialog [data-rt-new-name]')
        assert page.get_attribute('.nl-dialog [data-rt-new-type]', 'list') == 'nl-rtpl-type-options'
        page.fill('.nl-dialog [data-rt-new-name]', '同门')
        page.fill('.nl-dialog [data-rt-new-type]', '师兄妹')
        page.fill('.nl-dialog [data-rt-new-label]', '{A}和{B}拜在同一位师父门下')
        page.click('.nl-dialog [data-rt-add]')
        page.wait_for_selector('.nl-dialog tr[data-rtpl]')
        tpl = ev(page, 'NovelLoom.app.settings.relationTemplates[0]')
        print('template:', tpl)
        assert tpl['type'] == '师兄妹' and tpl['name'] == '同门', tpl
        assert page.input_value(f'.nl-dialog tr[data-rtpl="{tpl["id"]}"] [data-rt-type]') == '师兄妹'
        page.fill(f'.nl-dialog tr[data-rtpl="{tpl["id"]}"] [data-rt-type]', '同伴/盟友')
        settle(page)
        shot(page, '04-template-free-type')
        top(page).locator('.nl-dialog-foot button:has-text("关闭")').click()
        page.wait_for_selector('.nl-dialog-overlay', state='detached')
        assert ev(page, 'NovelLoom.app.settings.relationTemplates[0].type') == 'ally', '填已知类型的名字存成 value'
        page.click('[data-act="manage-templates"]')
        page.wait_for_selector('.nl-dialog tr[data-rtpl]')
        page.fill(f'.nl-dialog tr[data-rtpl="{tpl["id"]}"] [data-rt-type]', '师兄妹')
        top(page).locator('.nl-dialog-foot button:has-text("关闭")').click()
        page.wait_for_selector('.nl-dialog-overlay', state='detached')
        assert ev(page, 'NovelLoom.app.settings.relationTemplates[0].type') == '师兄妹'
        # 套用模板：类型框填上模板的自由类型
        page.click('[data-act="add"]')
        page.wait_for_selector('.nl-dialog select[data-f="template"]')
        page.select_option('.nl-dialog select[data-f="from"]', '莉莉丝')
        page.select_option('.nl-dialog select[data-f="to"]', '姜小白')
        page.select_option('.nl-dialog select[data-f="template"]', label='同门')
        assert page.input_value('.nl-dialog input[data-f="type"]') == '师兄妹'
        assert page.input_value('.nl-dialog [data-f="label"]') == '莉莉丝和姜小白拜在同一位师父门下'
        top(page).locator('.nl-dialog-foot button:has-text("取消")').click()
        page.wait_for_selector('.nl-dialog-overlay', state='detached')
        page.evaluate('window.__prompts = []')
        page.click('[data-act="analyze"]')
        page.wait_for_function('() => (window.__prompts || []).some((p) => p.includes("梳理角色之间已经明确建立的关系"))', timeout=20000)
        wait_log(page, 'AI 分析关系：新增 0 条')
        prompt = ev(page, 'window.__prompts.filter((p) => p.includes("梳理角色之间已经明确建立的关系")).pop()')
        assert '- 同门：type=师兄妹，双向' in prompt, prompt[-800:]

        step('自由类型「师兄妹」与之后新建的同名自定义类型：筛选和图例里只有一个「师兄妹」，两条都算进去')
        page.click('[data-act="manage-types"]')
        page.wait_for_selector('.nl-dialog [data-ct-new-label]')
        page.fill('.nl-dialog [data-ct-new-label]', '师兄妹')
        page.click('.nl-dialog [data-ct-add]')
        page.wait_for_selector('.nl-dialog tr[data-ctype]')
        top(page).locator('.nl-dialog-foot button:has-text("关闭")').click()
        page.wait_for_selector('.nl-dialog-overlay', state='detached')
        ct = ev(page, "NovelLoom.app.settings.customRelationTypes.find((t) => t.label === '师兄妹').value")
        page.click('[data-act="add"]')
        page.wait_for_selector('.nl-dialog input[data-f="type"]')
        page.select_option('.nl-dialog select[data-f="from"]', '莉莉丝')
        page.select_option('.nl-dialog select[data-f="to"]', '江酒')
        page.fill('.nl-dialog input[data-f="type"]', '师兄妹')
        top(page).locator('.nl-dialog-foot button:has-text("保存")').click()
        wait_log(page, '已添加关系：莉莉丝')
        types = [r[2] for r in rels(page)]
        print('types with same-named custom type:', types, ct)
        assert '师兄妹' in types and ct in types, '旧关系保留文字，新关系存成自定义类型'
        opts = ev(page, '[...document.querySelectorAll("[data-act-input=type] option")].map((o) => [o.value, o.textContent])')
        print('filter options:', opts)
        assert [o[1] for o in opts].count('师兄妹（2）') == 1 and not any(o[1] == '师兄妹（1）' for o in opts), opts
        legend = ev(page, '[...document.querySelectorAll(".nl-rel-legend [data-act=legend-type]")].map((b) => b.dataset.type)')
        assert legend.count(ct) == 1 and '师兄妹' not in legend, legend
        page.select_option('[data-act-input="type"]', ct)
        page.wait_for_function('document.querySelectorAll(".nl-table tbody tr").length === 2')
        settle(page)
        shot(page, '04b-merged-filter')
        page.select_option('[data-act-input="type"]', 'all')

        step('设置页：变量上限 3~100（默认 20）、说明；写入后自动允许的开关')
        page.click('.nl-nav-btn[data-tab="settings"]')
        page.wait_for_selector('#nl-sb-maxVars')
        assert page.get_attribute('#nl-sb-maxVars', 'max') == '100' and page.get_attribute('#nl-sb-maxVars', 'min') == '3'
        assert page.input_value('#nl-sb-maxVars') == '20'
        assert '变量越多，每轮发送的规则和 AI 输出的更新就越长' in page.inner_text('[data-statusbar-settings]')
        assert '（3–100，记录的每个字段各算一个）' in page.inner_text('[data-statusbar-settings]')
        page.fill('#nl-sb-maxVars', '100')
        page.press('#nl-sb-maxVars', 'Tab')
        page.wait_for_function('NovelLoom.app.settings.statusBar.maxVars === 100')
        page.fill('#nl-sb-maxVars', '150')
        page.press('#nl-sb-maxVars', 'Tab')
        page.wait_for_function('NovelLoom.app.settings.statusBar.maxVars === 100')
        assert page.input_value('#nl-sb-maxVars') == '100', '超过 100 的夹到 100'
        assert page.is_checked('[data-setting="cards.autoAllow"]')
        assert ev(page, 'NovelLoom.app.settings.cards.autoAllow') is True
        page.locator('[data-statusbar-settings]').scroll_into_view_if_needed()
        shot(page, '05-settings')
        page.fill('#nl-sb-maxVars', '20')
        page.press('#nl-sb-maxVars', 'Tab')
        page.wait_for_function('NovelLoom.app.settings.statusBar.maxVars === 20')

        step('写卡（同时生成状态栏）→ 写入酒馆：自动允许局部正则、在酒馆助手的 store 里启用角色脚本')
        page.evaluate(FAKE_JSR)
        page.click('.nl-nav-btn[data-tab="cards"]')
        page.wait_for_selector('[data-act="generate"]')
        page.select_option('[data-form="charName"]', '莉莉丝')
        page.click('details:has(> summary:has-text("写卡选项")) > summary')
        page.check('[data-setting="cards.statusBar"]')
        page.click('[data-act="generate"]')
        page.wait_for_selector('.nl-dialog-overlay .nl-dialog-head:has-text("编辑角色卡")', timeout=30000)
        top(page).locator('.nl-dialog-foot button:has-text("取消")').click()
        page.wait_for_selector('.nl-dialog-overlay', state='detached')
        assert page.locator('.nl-cardbox .nl-tag:has-text("状态栏")').count() == 1
        avatar = publish(page)
        card = json.loads(ev(page, 'window.__saved.lastImport.text'))
        assert len(card['data']['extensions']['regex_scripts']) >= 3 and len(card['data']['extensions']['tavern_helper']['scripts']) == 2
        allowed = ev(page, 'SillyTavern.getContext().extensionSettings.character_allowed_regex')
        store = ev(page, 'window.__jsrStore.settings.script')
        print('avatar:', avatar, 'allowed regex:', allowed, 'jsr store:', store['enabled']['characters'], store['popuped']['characters'])
        assert allowed == [avatar + '.png'], allowed
        assert store['enabled']['characters'] == ['someone.png', avatar + '.png'], '只加这张卡，其他角色不动'
        assert store['popuped']['characters'] == ['someone.png', avatar + '.png']
        assert 'tavern_helper' not in ev(page, 'Object.keys(SillyTavern.getContext().extensionSettings)'), 'store 路径不直接改 extension_settings'
        logs = log_lines(page)
        allow_log = [l for l in logs if l[0].startswith('自动授权')]
        print('allow log:', allow_log)
        assert allow_log == [['自动授权「莉莉丝」：已允许局部正则；已启用角色脚本', 'success']], allow_log
        assert [l[0] for l in logs].index(allow_log[0][0]) > max(i for i, l in enumerate(logs) if '已写入酒馆' in l[0]), '授权结果排在写入结果后面'
        hint = top(page).inner_text()
        assert top(page).locator('[data-act="sb-allow-regex"]').count() == 0, '已经允许，不再显示「允许本卡正则」按钮'
        assert top(page).locator('.nl-ok:has-text("已允许")').count() == 1 and top(page).locator('.nl-ok:has-text("已启用")').count() == 1, hint
        settle(page)
        shot(page, '06-publish-auto-allowed')
        close_hint(page)

        step('没有酒馆助手的 store：改 extension_settings.tavern_helper，提示刷新后生效')
        page.evaluate("document.getElementById('tavern_helper').remove()")
        page.evaluate("SillyTavern.getContext().extensionSettings.tavern_helper = { script: { enabled: { global: true, presets: [], characters: ['other.png'] }, popuped: { presets: [], characters: [] } } }")
        avatar2 = publish(page)
        assert avatar2 != avatar, 'harness 每次导入给一个新的头像文件名'
        th = ev(page, 'SillyTavern.getContext().extensionSettings.tavern_helper.script')
        allowed = ev(page, 'SillyTavern.getContext().extensionSettings.character_allowed_regex')
        print('fallback:', th, allowed)
        assert th['enabled']['characters'] == ['other.png', avatar2 + '.png'] and th['popuped']['characters'] == [avatar2 + '.png']
        assert allowed == [avatar + '.png', avatar2 + '.png']
        last = [l for l in log_lines(page) if l[0].startswith('自动授权')][-1]
        print('fallback log:', last)
        assert last[1] == 'warn' and '需要刷新酒馆页面后生效' in last[0], last
        assert top(page).locator('.nl-ok:has-text("已启用")').count() == 1
        close_hint(page)

        step('关掉「写入后自动允许」：不再授权，提示框里仍可手动允许')
        page.click('.nl-nav-btn[data-tab="settings"]')
        page.wait_for_selector('[data-setting="cards.autoAllow"]')
        page.uncheck('[data-setting="cards.autoAllow"]')
        page.wait_for_function('NovelLoom.app.settings.cards.autoAllow === false')
        page.click('.nl-nav-btn[data-tab="cards"]')
        page.wait_for_selector('.nl-cardbox [data-act="publish"]')
        n_allow = len([l for l in log_lines(page) if l[0].startswith('自动授权')])
        avatar3 = publish(page)
        assert ev(page, 'SillyTavern.getContext().extensionSettings.character_allowed_regex').count(avatar3 + '.png') == 0
        assert avatar3 + '.png' not in ev(page, 'SillyTavern.getContext().extensionSettings.tavern_helper.script.enabled.characters')
        assert len([l for l in log_lines(page) if l[0].startswith('自动授权')]) == n_allow
        assert top(page).locator('[data-act="sb-allow-regex"]').count() == 1
        close_hint(page)

        step('窄屏：关系页的图例与筛选')
        page.click('.nl-nav-btn[data-tab="relations"]')
        page.wait_for_selector('.nl-rel-legend')
        page.set_viewport_size({'width': 390, 'height': 844})
        page.wait_for_timeout(300)
        widths = ev(page, '({ doc: document.documentElement.scrollWidth, win: window.innerWidth, legend: document.querySelector(".nl-rel-legend").getBoundingClientRect().right })')
        print('mobile widths:', widths)
        assert widths['doc'] <= widths['win'] and widths['legend'] <= widths['win'], widths
        page.locator('.nl-rel-legend').scroll_into_view_if_needed()
        shot(page, '07-mobile-legend')
        browser.close()
finally:
    server.terminate()

real = [e for e in errors if 'favicon' not in e]
print('ERRORS:', json.dumps(real, ensure_ascii=False))
sys.exit(1 if real else 0)
