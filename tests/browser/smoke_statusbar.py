# 浏览器冒烟测试（状态栏 / MVU 变量）：写卡时同时生成状态栏 → 状态栏对话框（变量表、预览、模拟更新、内置排版、
# 套用四个内置模板、自定义 HTML 的错误阻止导出、显示层数）→ 写入酒馆后检查导出的卡片 JSON 与世界书
import json, os, subprocess, sys, time
from playwright.sync_api import sync_playwright

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
SHOTS = sys.argv[1] if len(sys.argv) > 1 else '/tmp/nl-statusbar'
os.makedirs(SHOTS, exist_ok=True)
PORT = 8776
server = subprocess.Popen([sys.executable, '-m', 'http.server', str(PORT), '--bind', '127.0.0.1'], cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1)

NOVEL = '\n'.join([
    '第一章 魔女小姐', '江酒走进酒吧。莉莉丝坐在角落，黑色长裙拖到地上。', '“没错，今晚我是来跟你提分手的。”江酒说。', '莉莉丝把一瓶紫色魔药推到他面前。\n' * 8,
    '第二章 女仆', '江酒穿上了女仆装。', '“挺合身。”莉莉丝说，“明天开始打扫阁楼。”', '他叹了口气，拎起扫帚上楼。楼梯吱呀作响。\n' * 8,
])
# harness.html 里 mock 的变量表（SB_SPEC）的路径
SPEC_PATHS = ['世界.时间', '世界.地点', '莉莉丝.好感度', '莉莉丝.心情', '莉莉丝.在场', '莉莉丝.状态', '主角.物品']
BUILTINS = [('builtin_general', '通用'), ('builtin_rpg', 'RPG'), ('builtin_campus', '校园恋爱'), ('builtin_cyberpunk', '赛博朋克')]
# 第五个内置模板「多人群像」为世界卡设计（15 个变量，自带上限 15）：这里只检查它在列表里，套用见 smoke_statusbar_multi.py
ALL_BUILTINS = BUILTINS + [('builtin_ensemble', '多人群像')]
REGEX_NAMES = ['[NL界面]状态栏', '[NL不发送]状态栏占位符', '[NL不发送]去除变量更新', '[NL折叠]变量更新中', '[NL折叠]完整变量更新']
ENTRY_COMMENTS = ['[initvar]变量初始化勿开', '变量列表', '[mvu_update]变量更新规则', '[mvu_update]变量输出格式']
TAG = '<StatusPlaceHolderImpl/>'
REPLY = '\n'.join([
    '莉莉丝笑着把钥匙推了过来。',
    '<UpdateVariable>',
    '<Analysis>Lilith warms up to the user and hands over a key.</Analysis>',
    '<JSONPatch>',
    json.dumps([
        {'op': 'delta', 'path': '/莉莉丝/好感度', 'value': 15},
        {'op': 'replace', 'path': '/莉莉丝/心情', 'value': '开心'},
        {'op': 'insert', 'path': '/莉莉丝/状态/-', 'value': '脸红'},
        {'op': 'insert', 'path': '/主角/物品/银钥匙', 'value': {'数量': 2, '描述': '阁楼的钥匙'}},
    ], ensure_ascii=False),
    '</JSONPatch>',
    '</UpdateVariable>',
])
RAW_BAD = '<!doctype html><html><body><div id="raw">价格 $1</div><script>var s = getAllVariables().stat_data;</script></body></html>'
errors = []
expected_errors = []


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


def wait_frame_text(page, selector, expect, timeout=10000):
    """等预览 iframe（沙箱、不同源）里的元素文字变成 expect"""
    deadline = time.time() + timeout / 1000
    last = None
    while time.time() < deadline:
        try:
            last = frame(page).locator(selector).first.inner_text(timeout=1000).strip()
            if last == expect:
                return last
        except Exception as e:  # iframe 正在重新载入
            last = 'ERR ' + str(e).split('\n')[0]
        page.wait_for_timeout(150)
    raise AssertionError(f'预览里 {selector} 应为 {expect!r}，实际 {last!r}')


def close_dialog(page):
    top(page).locator('.nl-dialog-foot button:has-text("关闭")').click()
    page.wait_for_selector('.nl-dialog-overlay', state='detached')


def open_sb_dialog(page):
    page.click('.nl-cardbox [data-act="statusbar"]')
    page.wait_for_selector('.nl-sb-tabs')


def tab(page, name):
    page.click(f'[data-act="sb-tab"][data-tab="{name}"]')
    page.wait_for_selector(f'[data-act="sb-tab"][data-tab="{name}"].active')


def last_card_json(page):
    return json.loads(ev(page, 'window.__saved.lastImport.text'))


def publish_and_hint(page):
    n = ev(page, 'window.__saved.imports.length')
    page.click('.nl-cardbox [data-act="publish"]')
    page.wait_for_function('(n) => window.__saved.imports.length === n + 1', arg=n, timeout=15000)
    page.wait_for_selector('.nl-dialog-head:has-text("状态栏卡")', timeout=15000)


def cdn(route):
    # 预览页从 testingcf 取 Font Awesome / jQuery / lodash：测试里一律返回空内容（预览自带 $ 与 _.get 的兜底），不依赖外网
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

        step('写卡：勾选「同时生成状态栏」')
        page.click('.nl-nav-btn[data-tab="cards"]')
        page.wait_for_selector('[data-act="generate"]')
        page.select_option('[data-form="charName"]', '莉莉丝')
        page.click('details:has(> summary:has-text("写卡选项")) > summary')
        assert page.locator('[data-sb-form-opts]').is_hidden()
        page.check('[data-setting="cards.statusBar"]')
        assert page.locator('[data-sb-form-opts]').is_visible() and page.locator('[data-sb-gen-hint]').is_visible()
        assert ev(page, 'NovelLoom.app.settings.cards.statusBar') is True
        tpl_opts = ev(page, "[...document.querySelectorAll('[data-setting=\"cards.statusBarTemplateId\"] option')].map(o => o.value)")
        print('template options:', tpl_opts)
        assert tpl_opts[0] == '' and all(t in tpl_opts for t, _ in ALL_BUILTINS), tpl_opts
        page.fill('[data-form="statusBarRequirement"]', '重点记录好感和随身物品')
        shot(page, '01-form')
        page.click('[data-act="generate"]')
        page.wait_for_selector('.nl-dialog-overlay .nl-dialog-head:has-text("编辑角色卡")', timeout=30000)
        sb = sbar(page)
        calls = ev(page, '[window.__sbSpecCalls, window.__sbHtmlCalls]')
        print('status calls (spec, html):', calls, 'vars:', len(sb['spec']['variables']), 'mode:', sb['mode'], 'error:', repr(sb['error']))
        assert calls == [1, 1], calls
        assert [v['path'] for v in sb['spec']['variables']] == SPEC_PATHS
        assert sb['mode'] == 'bind' and 'sb-box' in sb['html'] and sb['error'] == ''
        assert sb['requirement'] == '重点记录好感和随身物品'
        assert sb['lint']['errors'] == [], sb['lint']
        spec_prompt = ev(page, "window.__prompts.find(t => t.includes('设计状态栏变量表'))")
        assert '<角色卡内容>' in spec_prompt and '姓名：莉莉丝' in spec_prompt and '重点记录好感和随身物品' in spec_prompt
        html_prompt = ev(page, "window.__prompts.find(t => t.includes('设计状态栏界面'))")
        assert 'data-nl-bar' in html_prompt and '莉莉丝.好感度' in html_prompt
        world_field = top(page).locator('[data-card-world]').input_value()
        print('world field:', world_field)
        assert world_field.endswith('·莉莉丝'), world_field
        top(page).locator('.nl-dialog-foot button:has-text("取消")').click()
        page.wait_for_selector('.nl-dialog-overlay', state='detached')
        assert page.locator('.nl-cardbox .nl-tag:has-text("状态栏")').count() == 1
        shot(page, '02-card-list')

        step('状态栏对话框：变量表')
        open_sb_dialog(page)
        page.wait_for_selector('.nl-sb-table')
        rows = page.locator('.nl-sb-table tr[data-sb-tr]').count()
        paths = ev(page, "[...document.querySelectorAll('.nl-sb-table [data-sb-k=\"path\"]')].map(i => i.value)")
        print('table rows:', rows, paths)
        assert rows == 7 and paths == SPEC_PATHS
        assert page.locator('.nl-sb-table tr.nl-sb-bad').count() == 0
        assert page.locator('[data-sb-row="2"][data-sb-k="init"]').input_value() == '30'
        assert page.locator('[data-sb-row="3"][data-sb-k="init"]').input_value() == '平静'
        assert '每轮常驻约' in page.locator('.nl-sb-panel').inner_text()
        shot(page, '03-vars')

        step('预览：iframe 显示示例值')
        tab(page, 'preview')
        page.wait_for_selector('iframe[data-sb-frame]')
        assert page.get_attribute('iframe[data-sb-frame]', 'sandbox') == 'allow-scripts'
        wait_frame_text(page, '.sb-fav', '30')
        wait_frame_text(page, '.sb-stage', '戒备')
        wait_frame_text(page, '.sb-mood', '平静')
        wait_frame_text(page, '.sb-here', '在')
        wait_frame_text(page, '.sb-time', '夜晚 23:00')
        wait_frame_text(page, '.sb-name', '莉莉丝')  # {{char}} 换成了角色名
        tags = frame(page).locator('.sb-tag').all_inner_texts()
        items = [t.strip() for t in frame(page).locator('.sb-item').all_inner_texts()]
        pct = frame(page).locator('.sb-bar').evaluate("e => e.style.getPropertyValue('--nl-pct')")
        renders0 = frame(page).locator('.sb-render').inner_text()
        print('preview tags:', tags, 'items:', items, 'pct:', pct, renders0)
        assert tags == ['微醺'] and items == ['紫色魔药 x 1'] and float(pct.strip().rstrip('%')) == 30, (tags, items, pct)
        assert frame(page).locator('.nl-empty-hint').is_hidden()
        assert page.locator('[data-sb-preview-errs] .nl-sb-note-err').count() == 0
        shot(page, '04-preview')

        step('模拟一轮更新：粘贴带 <UpdateVariable><JSONPatch> 的回复')
        page.fill('[data-sb-f="reply"]', REPLY)
        page.click('[data-act="sb-sim"]')
        sim_msg = page.locator('[data-sb-sim-msg]').inner_text()
        print('sim msg:', sim_msg)
        assert '应用了 4 / 4 条更新' in sim_msg, sim_msg
        wait_frame_text(page, '.sb-fav', '45')
        wait_frame_text(page, '.sb-stage', '信任')
        wait_frame_text(page, '.sb-mood', '开心')
        tags = frame(page).locator('.sb-tag').all_inner_texts()
        items = [t.strip() for t in frame(page).locator('.sb-item').all_inner_texts()]
        renders1 = frame(page).locator('.sb-render').inner_text()
        print('after sim tags:', tags, 'items:', items, renders0, '->', renders1)
        assert tags == ['微醺', '脸红'] and items == ['紫色魔药 x 1', '银钥匙 x 2'], (tags, items)
        assert renders1 != renders0, 'nlRender 应在更新后再次调用'
        sample = json.loads(page.locator('[data-sb-f="sample"]').input_value())
        assert sample['莉莉丝']['好感度'] == 45 and sample['主角']['物品']['银钥匙']['数量'] == 2
        # 不合法的更新（枚举外的值）被丢弃并报错
        page.fill('[data-sb-f="reply"]', '<UpdateVariable><JSONPatch>[{"op":"replace","path":"/莉莉丝/心情","value":"暴怒"}]</JSONPatch></UpdateVariable>')
        page.click('[data-act="sb-sim"]')
        page.wait_for_timeout(300)
        bad_msg = page.locator('[data-sb-sim-msg]').inner_text()
        print('invalid sim msg:', bad_msg.replace('\n', ' | '))
        assert '应用了 0 / 1 条更新' in bad_msg
        wait_frame_text(page, '.sb-mood', '开心')
        shot(page, '05-simulated')
        # 内容变少时预览框跟着变矮（不只会变高）
        frame_h = lambda: float(ev(page, "parseFloat(document.querySelector('iframe[data-sb-frame]').style.height)"))
        h_big = frame_h()
        shrink = json.dumps([{'op': 'remove', 'path': '/主角/物品/银钥匙'}, {'op': 'remove', 'path': '/主角/物品/紫色魔药'}, {'op': 'replace', 'path': '/莉莉丝/状态', 'value': []}], ensure_ascii=False)
        page.fill('[data-sb-f="reply"]', f'<UpdateVariable><JSONPatch>{shrink}</JSONPatch></UpdateVariable>')
        page.click('[data-act="sb-sim"]')
        page.wait_for_function("(h) => parseFloat(document.querySelector('iframe[data-sb-frame]').style.height) < h", arg=h_big, timeout=5000)
        print('preview height:', h_big, '->', frame_h())
        assert frame(page).locator('.sb-item').count() == 0 and frame(page).locator('.sb-tag').count() == 0

        step('自定义 HTML 里的 $1：错误阻止导出')
        tab(page, 'ui')
        page.click('[data-act="sb-mode"][data-mode="raw"]')
        page.wait_for_selector('[data-act="sb-mode"][data-mode="raw"].active')
        page.fill('[data-sb-f="html"]', RAW_BAD)
        page.wait_for_selector('.nl-sb-lint .nl-lint-error', timeout=5000)
        lint_text = page.locator('.nl-sb-lint').inner_text()
        print('lint:', lint_text.replace('\n', ' | ')[:160])
        assert '$1' in lint_text
        assert sbar(page)['mode'] == 'raw' and len(sbar(page)['lint']['errors']) >= 1
        assert page.locator('.nl-sb-toolbar .nl-tag.nl-err').count() == 1
        shot(page, '06-lint-error')
        tab(page, 'export')
        page.wait_for_selector('.nl-sb-note-err:has-text("导出会被阻止")')
        assert page.locator('.nl-sb-export .nl-err').first.inner_text().startswith('状态栏界面有')
        close_dialog(page)
        page.wait_for_selector('.nl-cardbox .nl-tag.nl-warn:has-text("状态栏")', timeout=5000)  # 关闭对话框后列表重绘
        # 导出 JSON 被拒绝
        page.click('.nl-cardbox [data-act="json"]')
        page.wait_for_selector('.nl-dialog-head:has-text("导出失败")')
        assert '已阻止导出' in top(page).locator('.nl-dialog-body').inner_text()
        top(page).locator('.nl-dialog-foot button').click()
        page.wait_for_selector('.nl-dialog-overlay', state='detached')
        # 写入酒馆也被拒绝（什么都不写）
        n_err = len(errors)
        page.click('.nl-cardbox [data-act="publish"]')
        page.wait_for_selector('.nl-dialog-head:has-text("出错了")')
        assert '已阻止导出' in top(page).locator('.nl-dialog-body').inner_text()
        top(page).locator('.nl-dialog-foot button').click()
        page.wait_for_selector('.nl-dialog-overlay', state='detached')
        assert ev(page, 'window.__saved.imports.length') == 0 and ev(page, 'Object.keys(window.__saved.worlds).length') == 0
        new_errs = errors[n_err:]
        assert all('[NovelLoom]' in e for e in new_errs), new_errs  # busy() 把被拒绝的原因打到控制台
        expected_errors += new_errs
        del errors[n_err:]

        step('切到内置排版')
        open_sb_dialog(page)
        tab(page, 'ui')
        page.click('[data-act="sb-mode"][data-mode="auto"]')
        page.wait_for_selector('.nl-sb-lint .nl-ok:has-text("内置排版")')
        page.select_option('[data-sb-f="theme"]', 'night')
        page.wait_for_timeout(100)
        sb = sbar(page)
        assert sb['mode'] == 'auto' and sb['theme'] == 'night' and sb['lint']['errors'] == [], sb['lint']
        assert page.locator('.nl-sb-toolbar .nl-tag.nl-err').count() == 0
        tab(page, 'preview')
        wait_frame_text(page, '.nlb-num[data-nl-text="莉莉丝.好感度"]', '30')
        wait_frame_text(page, '.nlb-badge[data-nl-text="莉莉丝.心情"]', '平静')
        assert frame(page).locator('.nlb.nlb-theme-night').count() == 1
        assert frame(page).locator('.sb-box').count() == 0
        shot(page, '07-builtin-layout')

        step('套用四个内置模板（沿用结构 + AI 按本卡填初始值与规则）')
        for tid, name in BUILTINS:
            spec_calls = ev(page, 'window.__sbSpecCalls')
            page.click('.nl-sb-toolbar [data-act="sb-templates"]')
            page.wait_for_selector(f'.nl-dialog-overlay [data-tpl-id="{tid}"]')
            top(page).locator(f'[data-tpl-id="{tid}"] [data-act="tpl-apply"]').click()
            page.wait_for_selector('.nl-dialog-head:has-text("套用模板")')
            assert top(page).locator('input[name="nl-sb-tpl-mode"][value="structure"]').is_checked()
            assert top(page).locator('[data-f="ai"]').is_checked()
            top(page).locator('.nl-dialog-foot button:has-text("套用")').click()
            wait_log(page, f'已套用状态栏模板「{name}」', timeout=20000)
            # 同一个 URL 的模块与扩展共用一份实例，可以直接读内置模板
            tpl = ev(page, "async (id) => (await import('/src/statusbar-templates.js')).BUILTIN_STATUSBAR_TEMPLATES.find(t => t.id === id)", tid)
            sb = sbar(page)
            print(f'{name}: templateId={sb["templateId"]} mode={sb["mode"]} vars={len(sb["spec"]["variables"])} lint={sb["lint"]} error={sb["error"]!r}')
            assert sb['templateId'] == tid
            assert [v['path'] for v in sb['spec']['variables']] == [v['path'] for v in tpl['spec']['variables']], '沿用结构应照搬模板的变量路径'
            assert sb['mode'] == 'bind' and sb['html'] == tpl['html'] and sb['theme'] == tpl['theme'], '沿用结构应带上模板的界面'
            assert sb['lint']['errors'] == [] and sb['error'] == ''
            assert ev(page, 'window.__sbSpecCalls') == spec_calls + 1
            kept_prompt = ev(page, "window.__prompts.filter(t => t.includes('设计状态栏变量表')).pop()")
            assert '<变量表>' in kept_prompt and sb['spec']['variables'][0]['path'] in kept_prompt
            assert all(v.get('desc', '').endswith('（mock）') and v.get('check') == ['按剧情更新（mock）'] for v in sb['spec']['variables']), 'AI 的规则应合并进来'
            tab(page, 'preview')
            page.wait_for_timeout(800)
            body = frame(page).locator('body').inner_text(timeout=5000)
            assert body.strip(), f'{name} 预览为空'
            assert frame(page).locator('.nl-empty-hint').is_hidden()
            errs = page.locator('[data-sb-preview-errs]').inner_text()
            assert not errs.strip(), f'{name} 预览报错：{errs}'
            shot(page, f'08-template-{tid}')
            tab(page, 'vars')
        cyber_paths = [v['path'] for v in sbar(page)['spec']['variables']]
        # 撤销回到上一个模板，再点一次恢复
        page.click('[data-act="sb-undo"]')
        page.wait_for_timeout(150)
        assert sbar(page)['templateId'] == 'builtin_campus'
        page.click('[data-act="sb-undo"]')
        page.wait_for_timeout(150)
        assert sbar(page)['templateId'] == 'builtin_cyberpunk' and [v['path'] for v in sbar(page)['spec']['variables']] == cyber_paths

        step('显示层数：最新 4 层')
        tab(page, 'ui')
        page.select_option('[data-sb-opt="showDepthMode"]', 'n')
        page.wait_for_selector('[data-sb-opt="showDepthN"]')
        assert sbar(page)['options']['showDepth'] == 3
        page.fill('[data-sb-opt="showDepthN"]', '4')
        page.press('[data-sb-opt="showDepthN"]', 'Tab')
        page.wait_for_timeout(150)
        assert sbar(page)['options']['showDepth'] == 4
        assert sbar(page)['options']['foldUpdate'] is True
        shot(page, '09-ui-options')
        close_dialog(page)

        step('写入酒馆：检查导出的卡片与世界书')
        # 写入后自动授权（设置 cards.autoAllow，默认开）在 smoke_misc_v15.py 里测；这里关掉，测提示框里的「允许本卡正则」
        page.evaluate('NovelLoom.app.settings.cards.autoAllow = false')
        publish_and_hint(page)
        shot(page, '10-publish-hint')
        card = last_card_json(page)
        d = card['data']
        ext = d['extensions']
        world = ext['world']
        rx = ext['regex_scripts']
        th = ext['tavern_helper']
        print('world:', world, 'regex:', [r['scriptName'] for r in rx], 'maxDepth:', rx[0]['maxDepth'], 'scripts:', [s['name'] for s in th['scripts']])
        assert world.endswith('·莉莉丝') and d['character_book']['name'] == world
        assert [r['scriptName'] for r in rx] == REGEX_NAMES
        assert rx[0]['findRegex'] == TAG and rx[0]['replaceString'].startswith('\n```html\n') and '<body' in rx[0]['replaceString']
        assert rx[0]['maxDepth'] == 7, rx[0]['maxDepth']  # 最新 4 层 AI 回复 → maxDepth 2×4−1
        assert rx[0]['markdownOnly'] is True and rx[1]['promptOnly'] is True and rx[2]['promptOnly'] is True
        assert all(r['disabled'] is False and r['id'] for r in rx)
        cyber_html = sbar(page)['html'].strip()
        assert 'window.NL_SPEC' in rx[0]['replaceString'] and cyber_html[:200] in rx[0]['replaceString'], '状态栏正则应是模板界面 + NL 运行时'
        assert [s['name'] for s in th['scripts']] == ['MVU', '变量结构'] and len(th['scripts']) == 2
        assert all(s['enabled'] is True and s['type'] == 'script' and s['button']['buttons'] == [] for s in th['scripts'])
        assert 'MagVarUpdate' in th['scripts'][0]['content'] and 'registerMvuSchema' in th['scripts'][1]['content']
        assert '</script' not in th['scripts'][1]['content']
        assert d['first_mes'].endswith(TAG) and card['first_mes'].endswith(TAG)
        assert d['alternate_greetings'] and all(g.endswith(TAG) for g in d['alternate_greetings'])
        assert '【状态栏使用说明】' in d['creator_notes']
        assert ext['novel_loom']['statusBar']['templateId'] == 'builtin_cyberpunk'
        assert [v['path'] for v in ext['novel_loom']['statusBar']['spec']['variables']] == cyber_paths
        book = {e['comment']: e for e in d['character_book']['entries']}
        assert all(c in book for c in ENTRY_COMMENTS), list(book)
        assert book['[initvar]变量初始化勿开']['enabled'] is False
        saved = ev(page, '(w) => window.__saved.worlds[w]', world)
        assert saved, f'世界书「{world}」没有写入酒馆'
        wentries = {e['comment']: e for e in saved['entries'].values()}
        print('world entries:', list(wentries))
        assert all(c in wentries for c in ENTRY_COMMENTS)
        assert wentries['[initvar]变量初始化勿开']['disable'] is True and wentries['[mvu_update]变量更新规则']['disable'] is False
        assert wentries['[mvu_update]变量更新规则']['ignoreBudget'] is True and wentries['[mvu_update]变量更新规则']['position'] == 4
        assert '变量更新规则:' in wentries['[mvu_update]变量更新规则']['content'] and '<UpdateVariable>' in wentries['[mvu_update]变量输出格式']['content']
        assert any(not c.startswith(('[initvar]', '[mvu_update]', '变量列表')) for c in wentries), '绑定世界书开着时应带上资料条目'
        avatar = ev(page, 'NovelLoom.app.project.cards[0].stAvatar')
        assert sbar(page)['worldName'] == world
        # 提示框里一键允许本卡正则（需确认）
        top(page).locator('[data-act="sb-allow-regex"]').click()
        page.wait_for_selector('.nl-dialog-head:has-text("允许本卡正则")')
        top(page).locator('.nl-dialog-foot button:has-text("允许")').click()
        page.wait_for_timeout(150)
        allowed = ev(page, 'SillyTavern.getContext().extensionSettings.character_allowed_regex')
        print('allowed regex:', allowed)
        assert allowed == [avatar + '.png'], allowed
        assert top(page).locator('.nl-ok:has-text("已允许")').count() == 1
        top(page).locator('.nl-dialog-foot button:has-text("知道了")').click()
        page.wait_for_selector('.nl-dialog-overlay', state='detached')
        page.wait_for_selector('.nl-cardbox .nl-tag:has-text("状态栏")')
        assert page.locator('.nl-cardbox .nl-tag.nl-warn:has-text("状态栏")').count() == 0

        step('关闭折叠、显示在每一层，再次写入')
        open_sb_dialog(page)
        tab(page, 'ui')
        page.uncheck('[data-sb-opt="foldUpdate"]')
        page.wait_for_timeout(100)
        page.select_option('[data-sb-opt="showDepthMode"]', 'all')
        page.wait_for_timeout(150)
        assert sbar(page)['options']['foldUpdate'] is False and sbar(page)['options']['showDepth'] is None
        tab(page, 'export')
        assert '局部正则 regex_scripts（3 条）' in page.locator('.nl-sb-panel').inner_text()
        close_dialog(page)
        publish_and_hint(page)
        assert ev(page, 'window.__saved.lastImport.preserved') == avatar, '再次写入应覆盖同一角色'
        card = last_card_json(page)
        rx = card['data']['extensions']['regex_scripts']
        print('regex after:', [r['scriptName'] for r in rx], 'maxDepth:', rx[0]['maxDepth'])
        assert [r['scriptName'] for r in rx] == REGEX_NAMES[:3] and rx[0]['maxDepth'] is None
        assert len(card['data']['extensions']['tavern_helper']['scripts']) == 2
        assert card['data']['creator_notes'].count('【状态栏使用说明】') == 1
        top(page).locator('[data-sb-hide-hint]').check()
        top(page).locator('.nl-dialog-foot button:has-text("知道了")').click()
        page.wait_for_selector('.nl-dialog-overlay', state='detached')
        assert sbar(page)['hideHint'] is True

        step('整卡重新生成：沿用状态栏并标记过时')
        page.click('.nl-cardbox [data-act="regen"]')
        page.wait_for_selector('.nl-dialog-overlay .nl-dialog-head:has-text("编辑角色卡")', timeout=30000)
        top(page).locator('.nl-dialog-foot button:has-text("取消")').click()
        page.wait_for_selector('.nl-dialog-overlay', state='detached')
        sb = sbar(page)
        assert sb['stale'] is True and sb['templateId'] == 'builtin_cyberpunk' and sb['worldName'] == world
        assert page.locator('.nl-cardbox .nl-tag.nl-warn:has-text("状态栏")').count() == 1
        open_sb_dialog(page)
        page.wait_for_selector('.nl-sb-note-warn:has-text("整卡重新生成")')
        shot(page, '11-stale')
        page.click('[data-act="sb-ai-init"]')
        wait_log(page, '已更新「莉莉丝」的状态栏', timeout=20000)
        assert sbar(page)['stale'] is False
        close_dialog(page)

        step('设置页：状态栏默认选项 + 模板库；写卡时套用模板')
        page.click('.nl-nav-btn[data-tab="settings"]')
        page.wait_for_selector('[data-statusbar-settings]')
        page.select_option('[data-statusbar-settings] [data-sb="showMode"]', 'all')
        page.wait_for_timeout(100)
        assert ev(page, 'NovelLoom.app.settings.statusBar.showDepth') is None
        page.click('[data-statusbar-settings] [data-act="sb-templates"]')
        page.wait_for_selector('.nl-dialog-overlay [data-tpl-id="builtin_cyberpunk"]')
        listed = ev(page, "[...document.querySelectorAll('.nl-dialog-overlay [data-tpl-id]')].map(e => e.dataset.tplId)")
        print('library:', listed)
        assert all(t in listed for t, _ in ALL_BUILTINS)
        shot(page, '12-settings-library')
        page.keyboard.press('Escape')
        page.wait_for_selector('.nl-dialog-overlay', state='detached')
        page.click('.nl-nav-btn[data-tab="cards"]')
        page.wait_for_selector('[data-act="generate"]')
        page.select_option('[data-form="charName"]', '江酒')
        page.click('details:has(> summary:has-text("写卡选项")) > summary')
        assert page.locator('[data-setting="cards.statusBar"]').is_checked()
        page.select_option('[data-setting="cards.statusBarTemplateId"]', 'builtin_rpg')
        page.click('[data-act="generate"]')
        page.wait_for_selector('.nl-dialog-overlay .nl-dialog-head:has-text("编辑角色卡")', timeout=30000)
        top(page).locator('.nl-dialog-foot button:has-text("取消")').click()
        page.wait_for_selector('.nl-dialog-overlay', state='detached')
        sb2 = ev(page, "NovelLoom.app.project.cards.find(c => c.charName === '江酒').statusBar")
        rpg = ev(page, "async () => (await import('/src/statusbar-templates.js')).BUILTIN_STATUSBAR_TEMPLATES.find(t => t.id === 'builtin_rpg')")
        print('江酒 status bar:', sb2['templateId'], sb2['mode'], len(sb2['spec']['variables']), 'showDepth', sb2['options']['showDepth'], 'error', repr(sb2['error']))
        assert sb2['templateId'] == 'builtin_rpg' and sb2['mode'] == 'bind' and sb2['html'] == rpg['html'] and sb2['error'] == ''
        assert [v['path'] for v in sb2['spec']['variables']] == [v['path'] for v in rpg['spec']['variables']]
        assert sb2['options']['showDepth'] is None, '新状态栏的选项应来自设置页的默认值'
        assert page.locator('.nl-cardbox .nl-tag:has-text("状态栏")').count() == 2
        browser.close()
finally:
    server.terminate()

real_errors = [e for e in errors if 'favicon' not in e]
print('expected (blocked export):', len(expected_errors))
print('ERRORS:', json.dumps(real_errors, ensure_ascii=False, indent=1))
sys.exit(1 if real_errors else 0)
