# 浏览器冒烟测试（原创写卡，不导入 TXT）：新建原创项目 → 每一页在没有分段时都能打开（没有控制台错误，分段 / 提取页说明去哪里写卡）；
# 写卡依据默认「原创设定」（原著资料不可用）；原创单人卡（AI 设计的角色和条目存进项目、卡片生成、编辑框里单字段重roll 按原创设定）；
# 同名时问「另存为新的 / 覆盖」；不存进项目的卡写入酒馆时条目进卡自己的世界书；原创世界卡 + 状态栏 + 卡的导向 + 用户画像
# （变量表提示词里有原创设定和主要角色、写入后卡自己的世界书里有主要角色、条目、导向、偏好、状态栏条目）；小说项目仍默认「原著资料」；
# 没打开项目时角色卡页提示可以新建原创项目；「大纲」页在原创项目里不给「AI 生成梗概」；写卡期间换了项目时卡和设定存回原来的项目；
# 存进项目的原创卡写入时用自己的一本世界书；窄屏截图
import json, os, subprocess, sys, time
from playwright.sync_api import sync_playwright

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
OUT = sys.argv[1] if len(sys.argv) > 1 else '/tmp/nl-original'
os.makedirs(OUT, exist_ok=True)
PORT = 8785
server = subprocess.Popen([sys.executable, '-m', 'http.server', str(PORT), '--bind', '127.0.0.1'], cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1)

ch1 = '第一章 魔女小姐\n' + '江酒走进酒吧。莉莉丝坐在角落，黑色长裙拖到地上。\n' * 18
ch2 = '第二章 女仆\n' + '江酒穿上了女仆装。莉莉丝去参加魔女茶会。\n' * 22
NOVEL = ch1 + ch2
ADULT = '所有涉及恋爱或亲密内容的人物（包括 {{user}}）都是成年人'
TABS = ['project', 'chunks', 'extract', 'characters', 'relations', 'worldbook', 'outline', 'style', 'profiles', 'studio', 'cards', 'plan', 'foreshadow', 'continue', 'settings']
errors = []

def shot(page, name):
    # 对话框有淡入动画：等它完全显示再截图
    page.wait_for_function('() => [...document.querySelectorAll(".nl-dialog-overlay, .nl-dialog")].every((d) => getComputedStyle(d).opacity === "1")')
    page.screenshot(path=os.path.join(OUT, name + '.png'))

def wait_log(page, text, timeout=30000):
    page.wait_for_function('(t) => [...document.querySelectorAll(".nl-log-line")].some(l => l.textContent.includes(t))', arg=text, timeout=timeout)

def ev(page, js, arg=None):
    return page.evaluate(js, arg) if arg is not None else page.evaluate(js)

def last_prompt(page, needle):
    return ev(page, '(n) => (window.__prompts || []).filter((t) => t.includes(n)).at(-1) || ""', needle)

def close_dialog(page):
    page.click('.nl-dialog-overlay:last-child .nl-dialog [data-close]')
    page.wait_for_timeout(150)

def no_hscroll(page):
    return ev(page, 'document.documentElement.scrollWidth <= window.innerWidth + 1')

def visit_all_tabs(page, label):
    for t in TABS:
        page.click(f'.nl-nav-btn[data-tab="{t}"]')
        page.wait_for_selector(f'#nl-tab .nl-tab-body[data-tab="{t}"]')
        page.wait_for_timeout(120)
        assert page.locator('#nl-tab .nl-empty-title:has-text("还没有打开项目")').count() == 0, f'{label}：{t}'
    print(label, 'visited:', len(TABS), 'tabs')

def cards_count(page):
    return ev(page, 'NovelLoom.app.project.cards.length')

def generate_and_wait_editor(page, n_before):
    page.click('#nl-tab [data-act="generate"]')
    page.wait_for_function('(n) => NovelLoom.app.project.cards.length === n + 1', arg=n_before, timeout=30000)
    page.wait_for_selector('.nl-dialog [data-card="description"]', timeout=30000)

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
        assert ev(page, 'NovelLoom.app.project') is None

        # ---- 没打开项目时点「角色卡」：提示可以新建原创项目（不导入 TXT），不再说要先导入小说 ----
        page.click('.nl-nav-btn[data-tab="cards"]')
        page.wait_for_selector('#nl-tab .nl-empty-title:has-text("还没有打开项目")')
        need = page.inner_text('#nl-tab .nl-empty')
        assert '新建原创项目（不导入 TXT）' in need and '已导入的小说' not in need, need
        page.click('#nl-tab [data-goto="project"]')
        page.wait_for_selector('#nl-tab .nl-tab-body[data-tab="project"]')

        # ---- 项目页：新建原创项目（不导入 TXT） ----
        assert page.locator('#nl-tab h3:has-text("新建原创项目（不导入 TXT）")').count() == 1
        shot(page, '01-project-original-entry')
        page.fill('#nl-tab [data-orig-project-name]', '雾港原创')
        page.press('#nl-tab [data-orig-project-name]', 'Enter')
        page.wait_for_function('() => NovelLoom.app.project && NovelLoom.app.project.name === "雾港原创"')
        page.wait_for_selector('#nl-tab .nl-tab-body[data-tab="cards"]')
        assert page.inner_text('#nl-page-title') == '角色卡', '新建后去「角色卡」'
        proj = ev(page, '({ original: NovelLoom.app.project.original, chunks: NovelLoom.app.project.chunks.length, file: NovelLoom.app.project.source.fileName })')
        print('project:', proj)
        assert proj == {'original': True, 'chunks': 0, 'file': ''}
        wait_log(page, '新建原创项目「雾港原创」')
        nxt = ev(page, '[...document.querySelectorAll(".nl-nav-btn.nl-next")].map((b) => b.dataset.tab)')
        assert nxt == ['cards'], f'侧栏的「下一步」在角色卡：{nxt}'

        # ---- 每一页在没有分段时都能打开 ----
        visit_all_tabs(page, 'original project')
        page.click('.nl-nav-btn[data-tab="chunks"]')
        txt = page.inner_text('#nl-tab')
        assert '原创项目没有原文' in txt and '原创写卡' in txt, txt[:200]
        shot(page, '02-chunks-empty')
        page.click('.nl-nav-btn[data-tab="extract"]')
        assert '原创项目没有原文' in page.inner_text('#nl-tab')
        page.click('.nl-nav-btn[data-tab="characters"]')
        assert '去原创写卡' in page.inner_text('#nl-tab')
        # 「大纲」：没有原文就没有章节概要，不给「AI 生成梗概」（点了也只会报错），引导手写梗概或去原创写卡
        page.click('.nl-nav-btn[data-tab="outline"]')
        page.wait_for_selector('#nl-tab [data-f="summary"]')
        assert page.locator('#nl-tab [data-act="summary"]').count() == 0, '原创项目没有「AI 生成梗概」'
        outline = page.inner_text('#nl-tab')
        assert '没有原文，所以没有章节概要' in outline and '原著文风尚未提取' not in outline and '提取后每段' not in outline, outline[:300]
        assert '手写故事梗概' in page.get_attribute('#nl-tab [data-f="summary"]', 'placeholder')
        shot(page, '02b-outline-empty')
        page.click('#nl-tab [data-act="goto-cards"]')
        page.wait_for_selector('#nl-tab .nl-tab-body[data-tab="cards"]')
        page.click('.nl-nav-btn[data-tab="project"]')
        pipe = page.inner_text('#nl-tab .nl-pipeline')
        assert '原创写卡并写入酒馆' in pipe and '检查分段' not in pipe, pipe
        assert '原创项目' in page.inner_text('#nl-tab .nl-current .nl-card-desc')
        shot(page, '03-project-original')
        page.click('.nl-nav-btn[data-tab="chunks"]')
        page.click('#nl-tab [data-goto="cards"]')
        page.wait_for_selector('#nl-tab .nl-tab-body[data-tab="cards"]')

        # ---- 写卡表单：默认原创设定，原著资料不可用；单人卡的角色一定存进项目 ----
        assert page.get_attribute('[data-act="card-source"][data-val="original"]', 'aria-pressed') == 'true'
        assert page.is_disabled('[data-act="card-source"][data-val="novel"]')
        assert '没有原文和角色资料' in page.inner_text('[data-src-note]')
        assert page.locator('[data-form="timepoint"]').count() == 0, '原创写卡没有故事时间点'
        assert page.is_checked('[data-form="origSave"]') and page.is_disabled('[data-form="origSave"]')
        assert '一定会存进项目' in page.inner_text('[data-orig-save-note]')
        ur = ev(page, '[...document.querySelectorAll("[data-form=userRoleKind] option")].map((o) => o.value)')
        assert ur == ['new', 'custom'], f'没有角色时不给「项目里的角色」：{ur}'
        assert page.inner_text('#nl-tab [data-act="generate"]') == '原创写卡'
        # 没写角色设定时拦下
        page.click('#nl-tab [data-act="generate"]')
        wait_log(page, '请填写角色设定')
        page.fill('[data-form="origConcept"]', '雾港旧书店的店主，二十四岁，只在下雨天开门；对 {{user}} 有点好奇')
        page.fill('[data-form="origWorld"]', '常年起雾的港城，雾钟响三下就宵禁')
        page.fill('[data-form="origRef"]', '九十年代港片')
        # 原创项目没有原文：「文风」一行不说“本书原著文风”
        assert '文风：未设置（按设定把握）' in page.inner_text('#nl-tab'), '原创项目的文风'
        shot(page, '04-original-form')
        # 预览提示词
        page.click('#nl-tab [data-act="preview"]')
        page.wait_for_selector('.nl-dialog')
        pv = page.inner_text('.nl-dialog-body')
        assert '# 用户的原创设定' in pv and '"character": {' in pv and ADULT in pv, pv[:300]
        close_dialog(page)

        # ---- 原创单人卡：生成、存进项目 ----
        generate_and_wait_editor(page, 0)
        sent = last_prompt(page, '按用户的原创设定写一张')
        assert '按用户的原创设定写一张单人角色卡（名字由你来起）' in sent and '雾港旧书店的店主' in sent and '九十年代港片' in sent
        card = ev(page, 'NovelLoom.app.project.cards.at(-1)')
        print('card:', card['data']['name'], card['charName'], card['source'], [c['name'] for c in card['original']['characters']], [e['name'] for e in card['original']['lore']])
        assert card['source'] == 'original' and card['charName'] == '林晚' and card['data']['name'] == '林晚' and card['original']['saved'] is True
        chars = ev(page, 'Object.values(NovelLoom.app.project.characters).map((c) => [c.name, c.manual, c.locked, c.identity])')
        assert chars == [['林晚', True, True, '雾港旧书店的店主']], chars
        wb = ev(page, 'Object.fromEntries(Object.entries(NovelLoom.app.project.worldbook).map(([k, v]) => [k, Object.keys(v)]))')
        print('worldbook:', wb)
        assert wb.get('地点') == ['雾港旧书店'] and wb.get('势力') == ['港务署'] and wb.get('物品') == ['铜质书签']
        wait_log(page, '已把「林晚」的设定存进项目')
        # 编辑框：原创设定一节；单字段重roll 按原创设定
        sec = page.inner_text('.nl-dialog [data-orig-edit]')
        assert '已存进项目' in sec and page.locator('.nl-dialog [data-card-act="orig-save"]').count() == 0, sec
        page.locator('.nl-dialog [data-orig-edit]').scroll_into_view_if_needed()
        shot(page, '05-editor-original')
        page.click('.nl-dialog [data-act="reroll-field"][data-field="first_mes"]')
        page.wait_for_selector('.nl-dialog-head:has-text("重新生成这个字段")')
        page.click('.nl-dialog-overlay:last-child .nl-dialog-foot button:has-text("确定")')
        page.wait_for_function('() => document.querySelector(".nl-dialog [data-card=first_mes]").value.startsWith("【重写的开场白】")', timeout=20000)
        rp = last_prompt(page, '请重新生成「开场白」')
        assert '## 已定下的人物（{{char}} 本人，以此为准）' in rp and '雾港旧书店' in rp and '"character": {' not in rp, rp[:400]
        page.click('.nl-dialog-foot button:has-text("保存")')
        page.wait_for_selector('.nl-dialog', state='detached')
        assert ev(page, 'NovelLoom.app.project.cards.at(-1).data.first_mes').startswith('【重写的开场白】')
        row = page.inner_text('#nl-tab .nl-cardbox')
        assert '原创' in row and '原创设定' in row, row
        # 整卡重新生成：沿用设计，名字和关联不变
        n_prompts = ev(page, 'window.__prompts.length')
        page.click('#nl-tab .nl-cardbox [data-act="regen"]')
        page.wait_for_selector('.nl-dialog [data-card="description"]', timeout=30000)
        regen = ev(page, '(n) => window.__prompts.slice(n).find((t) => t.includes("按用户的原创设定写一张"))', n_prompts)
        assert '人物和世界设定已经定下' in regen and '"character": {' not in regen
        c2 = ev(page, 'NovelLoom.app.project.cards.at(-1)')
        assert c2['charName'] == '林晚' and c2['source'] == 'original' and c2['original']['saved'] is True and cards_count(page) == 1
        close_dialog(page)

        # ---- 同名：问另存为新的 / 覆盖 ----
        assert not page.is_disabled('[data-form="origSave"]'), '项目里有角色了，可以不存'
        page.fill('[data-form="origName"]', '林晚')
        page.click('#nl-tab [data-act="generate"]')
        page.wait_for_selector('.nl-dialog-head:has-text("项目里已有同名的资料")', timeout=30000)
        body = page.inner_text('.nl-dialog-overlay:last-child .nl-dialog-body')
        assert '角色「林晚」' in body and '地点「雾港旧书店」' in body and '林晚（原创）' in body, body
        shot(page, '06-collision')
        page.click('.nl-dialog-overlay:last-child .nl-dialog-foot button:has-text("另存为新的")')
        page.wait_for_selector('.nl-dialog [data-card="description"]', timeout=30000)
        c3 = ev(page, 'NovelLoom.app.project.cards.at(-1)')
        assert c3['charName'] == '林晚（原创）' and c3['data']['name'] == '林晚', (c3['charName'], c3['data']['name'])
        assert ev(page, 'NovelLoom.app.project.characters["林晚"].identity') == '雾港旧书店的店主'
        # 卡里的名字留作别名（世界书能触发）；「阿晚」已经是原来那个林晚的别名，不重复收
        assert ev(page, 'NovelLoom.app.project.characters["林晚（原创）"].aliases') == ['林晚']
        assert ev(page, '!!NovelLoom.app.project.worldbook["地点"]["雾港旧书店（原创）"]')
        close_dialog(page)

        # ---- 不存进项目：写入酒馆时条目进卡自己的世界书 ----
        page.fill('[data-form="origName"]', '苏晚')
        page.uncheck('[data-form="origSave"]')
        assert '只放在这张卡上' in page.inner_text('[data-orig-save-note]')
        n_chars = ev(page, 'Object.keys(NovelLoom.app.project.characters).length')
        generate_and_wait_editor(page, cards_count(page))
        c4 = ev(page, 'NovelLoom.app.project.cards.at(-1)')
        assert c4['original']['saved'] is False and c4['charName'] == '苏晚'
        assert ev(page, 'Object.keys(NovelLoom.app.project.characters).length') == n_chars, '没有存进项目'
        assert '没有存进项目' in page.inner_text('.nl-dialog [data-orig-edit]')
        page.click('.nl-dialog-foot button:has-text("保存并写入酒馆")')
        wait_log(page, '已写入酒馆：角色「苏晚」')
        w = ev(page, 'Object.values(window.__saved.worlds["《雾港原创》世界书·苏晚"].entries).map((e) => e.comment)')
        print('unsaved card world:', w)
        assert '地点 - 雾港旧书店' in w and '物品 - 铜质书签' in w and '角色 - 苏晚' not in w, w
        assert w.count('地点 - 雾港旧书店') == 1, '只有这张卡自己的'
        assert not any(t.startswith('角色 - 林晚') or '（原创）' in t for t in w), '别的原创卡存进项目的角色和条目不带'
        own = ev(page, 'Object.values(window.__saved.worlds["《雾港原创》世界书·苏晚"].entries).find((e) => e.comment === "地点 - 雾港旧书店").content')
        assert own == '位置: 雾港老城区\n特点: 只在下雨天开门', own
        imp = json.loads(ev(page, 'window.__saved.lastImport.text'))
        assert imp['data']['extensions']['world'] == '《雾港原创》世界书·苏晚'

        # ---- 用户画像（原创世界卡用） ----
        page.click('.nl-nav-btn[data-tab="profiles"]')
        page.click('#nl-tab [data-act="up-new"]')
        page.wait_for_selector('#nl-tab [data-up-f="name"]')
        page.fill('#nl-tab [data-up-f="name"]', '丝袜党')
        page.click('#nl-tab [data-act="up-tag-toggle"][data-kind="likes"][data-tag="丝袜"]')
        page.click('#nl-tab [data-act="up-tag-toggle"][data-kind="dislikes"][data-tag="NTR"]')
        page.wait_for_function('() => NovelLoom.app.settings.userProfiles.some((p) => p.name === "丝袜党" && p.isDefault && p.likes.includes("丝袜"))')

        # ---- 原创世界卡 + 状态栏 + 卡的导向 + 用户画像 ----
        page.click('.nl-nav-btn[data-tab="cards"]')
        page.select_option('[data-form="kind"]', 'world')
        page.wait_for_selector('[data-form="origWorld"]')
        assert page.input_value('[data-form="origWorld"]').startswith('常年起雾的港城'), '世界观两种卡共用'
        page.fill('[data-form="origCast"]', '沈砚：雾港警署的探长，嘴硬心软\n阿绫：码头茶楼的老板娘')
        assert not page.is_checked('[data-form="origSave"]'), '「存进项目」的勾选记住了'
        page.check('[data-form="origSave"]')
        page.select_option('[data-form="orientationId"]', 'orient_ntl')
        assert '丝袜' in page.inner_text('[data-up-summary]')
        page.click('details:has(> summary:has-text("写卡选项")) > summary')
        page.check('[data-setting="cards.statusBar"]')
        shot(page, '07-original-world-form')
        n_prompts = ev(page, 'window.__prompts.length')
        generate_and_wait_editor(page, cards_count(page))
        wcard = ev(page, 'NovelLoom.app.project.cards.at(-1)')
        print('world card:', wcard['data']['name'], wcard['cardName'], [c['name'] for c in wcard['original']['characters']], [c['savedAs'] for c in wcard['original']['characters']])
        assert wcard['kind'] == 'world' and wcard['cardName'] == '雾港旧事' and wcard['data']['name'] == '雾港旧事'
        assert [c['name'] for c in wcard['original']['characters']] == ['沈砚', '阿绫', '老周']
        assert ev(page, '["沈砚", "阿绫", "老周"].every((n) => NovelLoom.app.project.characters[n]?.manual)')
        assert not any(e['name'] == '不该出现' for e in wcard['original']['lore']), '人物类的 lore 丢掉'
        cp = ev(page, '(n) => window.__prompts.slice(n).find((t) => t.includes("按用户的原创设定写一张世界"))', n_prompts)
        assert '【卡的导向：NTL】' in cp and '结合这张卡的人物与设定' in cp and '# 为这位用户量身定制' in cp and '雷点（一律避免）：NTR' in cp and '"cast": [' in cp
        sp = ev(page, '(n) => window.__prompts.slice(n).find((t) => t.includes("设计状态栏变量表"))', n_prompts)
        assert '## 用户的原创设定' in sp and '沈砚、阿绫、老周' in sp and '# 用户偏好' in sp and '莉莉丝' not in sp, sp[:300]
        sb = wcard['statusBar']
        cast_var = next(v for v in sb['spec']['variables'] if v['path'] == '主要角色')
        print('cast init:', list(cast_var['init'].keys()))
        assert all(n in cast_var['init'] for n in ['沈砚', '阿绫', '老周']), '主要角色预填了设计的人物'
        page.click('.nl-dialog-foot button:has-text("保存并写入酒馆")')
        page.wait_for_selector('.nl-dialog-head:has-text("状态栏卡")', timeout=30000)
        page.click('.nl-dialog-overlay:last-child .nl-dialog-foot button:has-text("知道了")')
        wait_log(page, '已写入酒馆：角色「雾港旧事」')
        wname = ev(page, 'NovelLoom.app.project.cards.at(-1).statusBar.worldName')
        comments = ev(page, '(n) => Object.values(window.__saved.worlds[n].entries).map((e) => e.comment)', wname)
        print('world card world:', wname, comments)
        for t in ['角色 - 沈砚', '角色 - 阿绫', '世界观 - 雾港', '地点 - 码头茶楼', '剧情导向：NTL', '用户偏好']:
            assert t in comments, t
        assert any('[initvar]' in c for c in comments)
        assert not any(t.startswith('角色 - 林晚') or t.startswith('地点 - 雾港旧书店') for t in comments), '不带单人原创卡的设定'
        shot(page, '08-cards-list')

        # ---- 小说项目仍默认「原著资料」 ----
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
        assert page.get_attribute('[data-act="card-source"][data-val="novel"]', 'aria-pressed') == 'true'
        assert not page.is_disabled('[data-act="card-source"][data-val="novel"]')
        assert page.inner_text('[data-act="card-source"][data-val="novel"]') == '原著资料'
        assert page.locator('[data-form="timepoint"]').count() == 1 and page.locator('[data-orig-form]').count() == 0
        assert page.inner_text('#nl-tab [data-act="generate"]') == '生成'
        assert '文风：本书原著文风' in page.inner_text('#nl-tab'), '小说项目的文风照旧'
        # 换成原创：原创的几栏出现；项目里的角色可以给 {{user}} 扮演
        page.click('[data-act="card-source"][data-val="original"]')
        page.wait_for_selector('[data-orig-form]')
        assert page.locator('[data-form="timepoint"]').count() == 0
        assert '项目里的角色' in page.inner_text('[data-form="userRoleKind"]')
        page.click('[data-act="card-source"][data-val="novel"]')
        page.wait_for_selector('[data-form="timepoint"]')
        visit_all_tabs(page, 'novel project')

        # ---- 写卡期间换了项目：卡和 AI 设计的设定存回写卡时的项目，不碰新打开的项目 ----
        page.select_option('.nl-project-select', label='雾港原创')
        page.wait_for_function('() => NovelLoom.app.project?.name === "雾港原创"')
        page.click('.nl-nav-btn[data-tab="cards"]')
        page.wait_for_selector('[data-orig-form]')
        page.select_option('[data-form="kind"]', 'character')
        page.wait_for_selector('[data-form="origConcept"]')
        page.fill('[data-form="origName"]', '顾青')
        page.fill('[data-form="origConcept"]', '青石巷的刻章师傅，话少')
        page.check('[data-form="origSave"]')
        page.select_option('[data-form="orientationId"]', '')
        page.select_option('[data-form="userProfileId"]', '')
        if page.is_checked('[data-setting="cards.statusBar"]'):
            page.click('details:has(> summary:has-text("写卡选项")) > summary')
            page.uncheck('[data-setting="cards.statusBar"]')
        ev(page, r'''() => {
            window.__originalMock = () => new Promise((res) => {
                window.__releaseOriginal = () => res(JSON.stringify({
                    name: '顾青', description: '基本信息:\n  姓名: 顾青', personality: '话少', scenario: '巷口', first_mes: '“来了。”', alternate_greetings: [],
                    mes_example: '<START>\n{{user}}: 刻个章。\n{{char}}: 嗯。', creator_notes: '原创', tags: ['原创'],
                    character: { name: '顾青', identity: '青石巷的刻章师傅', personality: '话少', importance: 'main' },
                    lore: [{ category: '地点', name: '青石巷', keys: ['青石巷'], content: '位置: 老城区\n特点: 刻章铺林立' }],
                }));
            });
        }''')
        n_wg = cards_count(page)
        page.click('#nl-tab [data-act="generate"]')
        page.wait_for_function('() => typeof window.__releaseOriginal === "function"', timeout=20000)
        page.select_option('.nl-project-select', label='魔女')
        page.wait_for_function('() => NovelLoom.app.project?.name === "魔女"')
        ev(page, '() => { window.__releaseOriginal(); delete window.__releaseOriginal; delete window.__originalMock; }')
        wait_log(page, '写好时已经换了项目，卡片存进了项目「雾港原创」')
        assert ev(page, '!NovelLoom.app.project.characters["顾青"] && !NovelLoom.app.project.cards.some((c) => c.data.name === "顾青") && !NovelLoom.app.project.worldbook["地点"]?.["青石巷"]'), '新打开的项目没被写进去'
        assert page.locator('.nl-dialog').count() == 0, '没有在别的项目里打开编辑框'
        page.select_option('.nl-project-select', label='雾港原创')
        page.wait_for_function('() => NovelLoom.app.project?.name === "雾港原创"')
        gq = ev(page, '(() => { const p = NovelLoom.app.project; const c = p.cards.find((x) => x.data.name === "顾青"); return c && { n: p.cards.length, saved: c.original.saved, owner: p.characters["顾青"]?.originalCardId === c.id, lore: !!p.worldbook["地点"]?.["青石巷"] }; })()')
        print('switched-project card:', gq)
        assert gq == {'n': n_wg + 1, 'saved': True, 'owner': True, 'lore': True}, gq
        # 存进项目的原创卡写入酒馆：用自己的一本世界书（不和别的原创卡共用《雾港原创》世界书），里面没有别的原创卡的设定
        page.click('.nl-nav-btn[data-tab="cards"]')
        page.click('#nl-tab .nl-cardbox [data-act="publish"] >> nth=0')
        wait_log(page, '已写入酒馆：角色「顾青」')
        gw = ev(page, 'Object.values(window.__saved.worlds["《雾港原创》世界书·顾青"].entries).map((e) => e.comment)')
        print('saved original card world:', gw)
        assert '地点 - 青石巷' in gw and not any('雾港旧书店' in t or t.startswith('角色 - 林晚') for t in gw), gw
        assert '《雾港原创》世界书' not in ev(page, 'Object.keys(window.__saved.worlds)'), '共用的那本没有被写'
        assert json.loads(ev(page, 'window.__saved.lastImport.text'))['data']['extensions']['world'] == '《雾港原创》世界书·顾青'
        # 原创项目里改用「项目资料」写卡：说明里不说“原著”“本书”
        page.click('[data-act="card-source"][data-val="novel"]')
        page.wait_for_selector('[data-form="timepoint"]')
        assert page.inner_text('[data-act="card-source"][data-val="novel"]') == '项目资料'
        ur_opts = ev(page, '[...document.querySelectorAll("[data-form=userRoleKind] option")].map((o) => o.textContent)')
        assert '项目里的角色' in ur_opts and '原著角色' not in ur_opts, ur_opts
        assert ev(page, '[...document.querySelectorAll("[data-form=timepoint] option")].map((o) => o.textContent)') == ['全部资料']
        page.select_option('[data-form="orientationId"]', '')
        assert '按项目资料和你的要求写' in page.inner_text('[data-orient-brief]')
        assert '原著' not in page.inner_text('[data-ur-note]') and '原著' not in page.inner_text('[data-up-summary]')
        page.select_option('[data-form="orientationId"]', 'orient_ntl')
        assert '结合这个项目的资料' in page.inner_text('[data-orient-refine]')
        page.select_option('[data-form="orientationId"]', '')
        page.click('[data-act="card-source"][data-val="original"]')
        page.wait_for_selector('[data-orig-form]')

        # ---- 窄屏 ----
        page.set_viewport_size({'width': 390, 'height': 844})
        page.select_option('.nl-project-select', label='雾港原创')
        page.wait_for_function('() => NovelLoom.app.project?.name === "雾港原创"')
        page.click('.nl-nav-btn[data-tab="cards"]')
        page.wait_for_selector('[data-orig-form]')
        assert no_hscroll(page), '窄屏没有横向滚动'
        ev(page, '() => document.querySelector("#nl-tab .nl-src-field").scrollIntoView({ block: "start" })')
        shot(page, '09-mobile-original-form')
        lab = ev(page, '() => { const l = document.querySelector("[data-form=origSave]").closest("label"); return [l.children.length, Math.round(l.querySelector(":scope > span").getBoundingClientRect().width), Math.round(l.getBoundingClientRect().width)]; }')
        assert lab[0] == 2 and lab[1] >= lab[2] - 30, lab
        page.click('#nl-tab [data-act="edit"] >> nth=0')
        page.wait_for_selector('.nl-dialog [data-orig-edit]')
        page.locator('.nl-dialog [data-orig-edit]').scroll_into_view_if_needed()
        shot(page, '10-mobile-editor-original')
        close_dialog(page)
        page.click('.nl-nav-btn[data-tab="chunks"]')
        assert no_hscroll(page)
        shot(page, '11-mobile-chunks-empty')
        page.click('.nl-nav-btn[data-tab="project"]')
        page.locator('#nl-tab [data-orig-project-name]').scroll_into_view_if_needed()
        assert no_hscroll(page)
        # 窄屏：按钮换到下一行，项目名输入框占满一行（提示文字看得全）
        w_in, w_row = ev(page, '() => [document.querySelector("#nl-tab [data-orig-project-name]").getBoundingClientRect().width, document.querySelector("#nl-tab .nl-orig-new").getBoundingClientRect().width]')
        print('mobile project name input:', round(w_in), '/', round(w_row))
        assert w_in >= w_row - 4, (w_in, w_row)
        assert page.get_attribute('#nl-tab [data-orig-project-name]', 'placeholder').startswith('项目名（可留空）')
        shot(page, '12-mobile-project')
        # 不填名字新建：自动避开已有的项目名（「原创项目」「原创项目 2」…），世界书名不撞
        page.fill('#nl-tab [data-orig-project-name]', '')
        page.click('#nl-tab [data-act="create-original"]')
        page.wait_for_function('() => NovelLoom.app.project?.name === "原创项目"')
        page.click('.nl-nav-btn[data-tab="project"]')
        page.click('#nl-tab [data-act="create-original"]')
        page.wait_for_function('() => NovelLoom.app.project?.name === "原创项目 2"')
        assert ev(page, 'NovelLoom.app.project.bookName') == '原创项目 2'
        browser.close()
finally:
    server.terminate()

real = [e for e in errors if 'favicon' not in e]
print('ERRORS:', json.dumps(real, ensure_ascii=False))
sys.exit(1 if real else 0)
