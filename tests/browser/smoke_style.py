# 浏览器冒烟测试（v0.3 文风）：文风页、AI 提炼、范文、禁用词、预设、按任务选择、续写检查与修正
import json, os, subprocess, sys, time
from playwright.sync_api import sync_playwright

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
SHOTS = sys.argv[1] if len(sys.argv) > 1 else '/tmp/nl-style'
os.makedirs(SHOTS, exist_ok=True)
PORT = 8769
server = subprocess.Popen([sys.executable, '-m', 'http.server', str(PORT), '--bind', '127.0.0.1'], cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1)

NOVEL = '\n'.join([
    '第一章 魔女小姐', '江酒走进酒吧。莉莉丝坐在角落，黑色长裙拖到地上。', '“没错，今晚我是来跟你提分手的。”江酒说。', '莉莉丝把一瓶紫色魔药推到他面前。\n' * 8,
    '第二章 女仆', '江酒穿上了女仆装。', '“挺合身。”莉莉丝说，“明天开始打扫阁楼。”', '他叹了口气，拎起扫帚上楼。楼梯吱呀作响。\n' * 8,
    '第三章 下城区', '姜小白在雨中迷路，走进了那家店。', '“请问……这里是下城区吗？”', '江酒给她倒了一杯热水，指了指窗外的霓虹灯。\n' * 8,
])
errors = []

def shot(page, name):
    page.screenshot(path=os.path.join(SHOTS, name + '.png'))

def wait_log(page, text, timeout=30000):
    page.wait_for_function('(t) => [...document.querySelectorAll(".nl-log-line")].some(l => l.textContent.includes(t))', arg=text, timeout=timeout)

def ev(page, js):
    return page.evaluate(js)

def ok_dialog(page, label='确定'):
    page.click(f'.nl-dialog-foot button:has-text("{label}")')

try:
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={'width': 1360, 'height': 900})
        page.on('pageerror', lambda e: errors.append('pageerror: ' + str(e)))
        page.on('console', lambda m: errors.append('console: ' + m.text) if m.type == 'error' else None)
        page.goto(f'http://127.0.0.1:{PORT}/tests/browser/harness.html')
        page.wait_for_selector('#nl-wand-button')
        page.evaluate("NovelLoom.open('project')")
        page.wait_for_selector('.nl-window')

        # 导入并提取（提取会填好“本书原著文风”）
        page.click('[data-act="paste"]')
        page.fill('.nl-dialog textarea', NOVEL)
        ok_dialog(page)
        page.fill('#nl-bookname', '魔女')
        page.click('[data-act="create"]')
        page.wait_for_selector('.nl-nav-btn[data-tab="chunks"].active')
        page.click('.nl-nav-btn[data-tab="extract"]')
        page.click('[data-act="start"]')
        wait_log(page, '提取结束', timeout=60000)

        # 文风页：提取出的原著文风已经显示
        page.click('.nl-nav-btn[data-tab="style"]')
        page.wait_for_selector('[data-sf="perspective"]')
        assert page.input_value('[data-sf="perspective"]') == '第三人称'
        page.fill('[data-sf="notes"]', '主角吐槽用括号括起来')
        assert ev(page, 'NovelLoom.app.project.style.notes') == '主角吐槽用括号括起来'
        shot(page, '01-style-tab')

        # AI 提炼
        page.click('[data-act="analyze"]')
        page.wait_for_selector('.nl-dialog [data-r="rules"]', timeout=20000)
        shot(page, '02-analyze-result')
        ok_dialog(page, '应用')
        page.wait_for_function('document.querySelector("[data-sf=perspective]").value.includes("跟随江酒")')
        st = ev(page, 'NovelLoom.app.project.style')
        print('analyzed:', st['perspective'], '|', st['rules'].replace('\n', ' / '), '|', st['banned'])
        assert st['rules'] == '- 对话推进剧情\n- 心理活动一句带过' and '宛如' in st['banned']
        assert st['notes'] == '主角吐槽用括号括起来', '提炼不覆盖备注'

        # 范文：自动挑选 / 从原文选取 / 粘贴
        page.click('[data-act="sample-auto"]')
        page.wait_for_selector('.nl-sample')
        n_auto = page.locator('.nl-sample').count()
        print('auto samples:', n_auto)
        assert n_auto >= 1
        page.click('[data-act="sample-pick"]')
        page.wait_for_selector('.nl-dialog [data-pick-text]')
        page.evaluate("""() => { const ta = document.querySelector('.nl-dialog [data-pick-text]'); ta.focus(); ta.setSelectionRange(0, 40); ta.dispatchEvent(new Event('select')); }""")
        page.click('.nl-dialog [data-pick-add]')
        page.wait_for_function('document.querySelector("[data-pick-info]").textContent.includes("已添加")')
        shot(page, '03-pick-sample')
        ok_dialog(page, '完成')
        page.wait_for_function('(n) => document.querySelectorAll(".nl-sample").length === n + 1', arg=n_auto)
        page.click('[data-act="sample-paste"]')
        page.fill('.nl-dialog textarea', '“你又迟到了。”她把钥匙丢过来，“下不为例。”\n我接住钥匙，没敢说路上的事。')
        ok_dialog(page)
        page.fill('.nl-dialog input', '别的书')
        ok_dialog(page)
        page.wait_for_function('(n) => document.querySelectorAll(".nl-sample").length === n + 2', arg=n_auto)
        srcs = ev(page, 'NovelLoom.app.project.style.samples.map(s => s.source)')
        print('sample sources:', srcs)
        assert srcs[-1] == '别的书' and srcs[-2].startswith('原文·')
        # 上移最后一段
        page.click(f'[data-act="sample-up"][data-i="{n_auto + 1}"]')
        after = ev(page, 'NovelLoom.app.project.style.samples.map(s => s.source)')
        print('after up:', after)
        assert after[-2] == '别的书', after

        # 禁用词
        page.fill('[data-sf="banned"]', '仿佛\n嘴角上扬=>笑了\n莉莉丝')
        page.click('[data-act="banned-common"]')
        page.wait_for_function('document.querySelector("[data-sf=banned]").value.includes("常见 AI 腔")')
        page.click('[data-act="banned-count"]')
        page.wait_for_selector('.nl-dialog .nl-table')
        dlg = page.inner_text('.nl-dialog')
        assert '原文常用，建议移除' in dlg, dlg[:400]
        shot(page, '04-banned-count')
        page.click('.nl-dialog [data-close]')
        page.fill('[data-sf="banned"]', '仿佛\n嘴角上扬=>笑了')

        # 预设：新建 → 给角色卡用
        page.click('[data-act="new"]')
        page.fill('.nl-dialog input', '测试文风')
        ok_dialog(page)
        page.wait_for_function('document.querySelector("[data-edit-id]").selectedOptions[0].textContent.includes("测试文风")')
        page.fill('[data-sf="perspective"]', '第二人称')
        pid = ev(page, "NovelLoom.app.settings.stylePresets.find(p => p.name === '测试文风').id")
        assert ev(page, "NovelLoom.app.settings.stylePresets.find(p => p.name === '测试文风').perspective") == '第二人称'
        page.select_option('[data-use="card"]', pid)
        assert ev(page, 'NovelLoom.app.project.styleUse.card') == pid
        # 内置预设：修改 → 已修改 → 恢复默认
        page.select_option('[data-edit-id]', 'b_light')
        page.wait_for_selector('[data-act="reset"]')
        assert page.is_hidden('[data-modified]')
        page.fill('[data-sf="tone"]', '改过的语言')
        assert page.is_visible('[data-modified]')
        page.click('[data-act="reset"]')
        ok_dialog(page, '恢复默认')
        page.wait_for_function('!document.querySelector("[data-sf=tone]").value.includes("改过")')

        # 预览各任务文风
        page.click('[data-act="preview"]')
        page.wait_for_selector('.nl-dialog h4')
        heads = page.locator('.nl-dialog h4').all_inner_texts()
        pres = page.locator('.nl-dialog .nl-pre').all_inner_texts()
        print('preview heads:', heads)
        assert '第二人称' in pres[0] and '<sample>' not in pres[1] and '<sample>' in pres[2] and '主角吐槽' in pres[2]
        shot(page, '05-preview')
        page.click('.nl-dialog [data-close]')

        # 全局选项：续写命中后 AI 改写
        page.click('details summary:has-text("全局选项")')
        page.select_option('[data-opt="fixMode"]', 'ai')
        assert ev(page, 'NovelLoom.app.settings.styleOptions.fixMode') == 'ai'
        page.select_option('[data-edit-id]', '__project')
        shot(page, '06-style-full')

        # 续写：范文进入提示词 → mock 返回带“仿佛”的正文 → 自动 AI 改写
        page.click('.nl-nav-btn[data-tab="continue"]')
        page.wait_for_selector('[data-act="api-start"]')
        assert '文风：本书原著文风' in page.inner_text('#nl-tab')
        page.fill('[data-setting="continuation.chapters"]', '1')
        page.dispatch_event('[data-setting="continuation.chapters"]', 'input')
        page.uncheck('[data-setting="continuation.feedback"]')
        page.evaluate('window.__prompts = []')
        page.click('[data-act="api-start"]')
        wait_log(page, '续写结束', timeout=30000)
        wait_log(page, '禁用词已清除')
        prompts = ev(page, 'window.__prompts')
        cont = [x for x in prompts if '续写任务' in x][0]
        assert '主角吐槽用括号括起来' in cont and '<sample>' in cont and '禁用词（正文中不要出现）：仿佛' in cont
        c1 = ev(page, 'NovelLoom.app.project.continuation.chapters[0].content')
        assert '仿佛' not in c1
        # 只提示模式：列表显示命中，手动修正
        ev(page, "NovelLoom.app.settings.styleOptions.fixMode = 'none'")
        page.click('[data-act="api-start"]')
        page.wait_for_selector('[data-ban-hits]', timeout=30000)
        shot(page, '07-continue-hits')
        page.click('[data-act="ban-replace"]')
        wait_log(page, '都没有替换建议')
        page.click('[data-act="ban-fix"]')
        wait_log(page, '禁用词已清除')
        page.wait_for_function('!document.querySelector("[data-ban-hits]")')
        # 查看/编辑 对话框
        page.click('.nl-list-item >> nth=0 >> button:has-text("查看/编辑")')
        page.wait_for_selector('.nl-dialog textarea')
        page.click('.nl-dialog [data-close]')

        # 大纲页文风概览 → 跳转
        page.click('.nl-nav-btn[data-tab="outline"]')
        page.wait_for_selector('[data-act="goto-style"]')
        summ = page.inner_text('#nl-tab')
        assert '范文' in summ and '角色卡用「测试文风」' in summ, summ[:600]
        page.click('[data-act="goto-style"]')
        page.wait_for_selector('[data-sf="perspective"]')

        # 角色卡页显示文风；审稿包含禁用词
        page.click('.nl-nav-btn[data-tab="cards"]')
        assert '测试文风' in page.inner_text('#nl-tab')
        # 写大纲页显示文风
        page.click('.nl-nav-btn[data-tab="plan"]')
        assert '文风：' in page.inner_text('#nl-tab')

        page.click('.nl-nav-btn[data-tab="style"]')
        page.wait_for_selector('[data-sf="perspective"]')
        # 窄屏
        page.set_viewport_size({'width': 390, 'height': 844})
        shot(page, '08-mobile-style')
        browser.close()
finally:
    server.terminate()

real = [e for e in errors if 'favicon' not in e]
print('ERRORS:', json.dumps(real, ensure_ascii=False))
sys.exit(1 if real else 0)
