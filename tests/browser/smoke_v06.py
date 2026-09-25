# 浏览器冒烟测试（v0.6 新功能）：人格颗粒度/台词库、写卡前试聊、群聊场景卡、场次拆分、多视角管理、伏笔看板、连续性检查
import json, os, subprocess, sys, time
from playwright.sync_api import sync_playwright

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
OUT = sys.argv[1] if len(sys.argv) > 1 else '/tmp/nl-v06'
os.makedirs(OUT, exist_ok=True)
PORT = 8774
server = subprocess.Popen([sys.executable, '-m', 'http.server', str(PORT), '--bind', '127.0.0.1'], cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1)

NOVEL = '\n'.join([
    '第一章 魔女小姐', '江酒走进酒吧。莉莉丝坐在角落，黑色长裙拖到地上。', '“没错，今晚我是来跟你提分手的。”江酒说。', '莉莉丝把一瓶紫色魔药推到他面前。\n' * 8,
    '第二章 女仆', '江酒穿上了女仆装。', '“挺合身。”莉莉丝说，“明天开始打扫阁楼。”', '他叹了口气，拎起扫帚上楼。楼梯吱呀作响。\n' * 8,
    '第三章 下城区', '姜小白在雨中迷路，走进了那家店。', '“请问……这里是下城区吗？”', '江酒给她倒了一杯热水，指了指窗外的霓虹灯。\n' * 8,
])
errors = []

def shot(page, name):
    page.screenshot(path=os.path.join(OUT, name + '.png'))

def wait_log(page, text, timeout=30000):
    page.wait_for_function('(t) => [...document.querySelectorAll(".nl-log-line")].some(l => l.textContent.includes(t))', arg=text, timeout=timeout)

def ev(page, js):
    return page.evaluate(js)

def ok_dialog(page, label='确定'):
    page.click(f'.nl-dialog-foot button:has-text("{label}")')

def wait_true(page, fn, timeout=10000, interval=100, msg=''):
    start = time.time()
    while (time.time() - start) * 1000 < timeout:
        if fn():
            return
        page.wait_for_timeout(interval)
    raise TimeoutError(msg or 'condition not met in time')

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

        # 导入 + 提取
        page.click('[data-act="paste"]')
        page.fill('.nl-dialog textarea', NOVEL)
        ok_dialog(page)
        page.fill('#nl-bookname', '魔女')
        page.click('[data-act="create"]')
        page.wait_for_selector('.nl-chunk')
        page.click('.nl-nav-btn[data-tab="extract"]')
        page.click('[data-act="start"]')
        wait_log(page, '提取结束', timeout=60000)
        assert ev(page, "Object.keys(NovelLoom.app.project.characters)").__len__() >= 3

        # ---------------- 人格颗粒度 + 台词库 ----------------
        page.click('.nl-nav-btn[data-tab="characters"]')
        page.click('.nl-char-item[data-name="江酒"]')
        page.wait_for_selector('[data-f="hardLimits"]')
        page.fill('[data-f="hardLimits"]', '不会伤害莉莉丝\n不会主动撒谎')
        page.fill('[data-f="tabooTopics"]', '过去欠的债')
        page.fill('[data-f="verbalTics"]', '开口先叹气')
        page.click('.nl-char-detail [data-act="save"]')
        wait_log(page, '已保存角色')
        limits = ev(page, "NovelLoom.app.project.characters['江酒'].hardLimits")
        print('hardLimits:', limits)
        assert limits == ['不会伤害莉莉丝', '不会主动撒谎']
        assert ev(page, "NovelLoom.app.project.characters['江酒'].tabooTopics") == ['过去欠的债']
        assert ev(page, "NovelLoom.app.project.characters['江酒'].verbalTics") == ['开口先叹气']
        shot(page, '01-persona-fields')

        # 台词库：原文对话样本区域（提取本身不产出 dialogues，这里手动注入验证渲染与删除）
        assert page.locator('.nl-field:has-text("原文对话样本") .nl-quote').count() == 0
        ev(page, "NovelLoom.app.project.characters['江酒'].dialogues.push({text: '“没错，今晚我是来跟你提分手的。”', chunk: 0, verified: true})")
        page.click('.nl-char-item[data-name="江酒"]')
        wait_true(page, lambda: page.locator('.nl-field:has-text("原文对话样本") .nl-quote').count() == 1, msg='dialogue not rendered')
        page.click('.nl-field:has-text("原文对话样本") [data-act="del-dialogue"]')
        wait_true(page, lambda: page.locator('.nl-field:has-text("原文对话样本") .nl-quote').count() == 0, msg='dialogue not removed')
        assert ev(page, "NovelLoom.app.project.characters['江酒'].dialogues.length") == 0

        # ---------------- 写卡前试聊 + 群聊场景卡 ----------------
        page.click('.nl-nav-btn[data-tab="cards"]')
        page.wait_for_selector('[data-form="charName"]')
        page.click('[data-act="generate"]')
        page.wait_for_selector('.nl-dialog [data-card="description"]', timeout=20000)
        page.click('.nl-dialog [data-close]')
        shot(page, '02-card-generated')

        page.click('.nl-cardbox >> nth=0 >> [data-act="testchat"]')
        page.wait_for_selector('[data-tc-input]')
        page.fill('[data-tc-input]', '你好')
        page.click('[data-tc-send]')
        page.wait_for_function('document.querySelector("[data-tc-msgs]").innerText.includes("坐吧")', timeout=15000)
        shot(page, '03-testchat')
        page.click('.nl-dialog-foot button:has-text("关闭")')

        page.check('[data-group-member][value="江酒"]')
        page.check('[data-group-member][value="莉莉丝"]')
        page.fill('[data-group-form="requirement"]', '打烊后两人单独收拾酒吧')
        page.click('[data-act="group-generate"]')
        page.wait_for_selector('.nl-dialog [data-g="scenario"]', timeout=20000)
        scenario_val = page.input_value('.nl-dialog [data-g="scenario"]')
        print('group scenario:', scenario_val)
        assert '酒吧打烊后' in scenario_val
        shot(page, '04-group-card')
        page.click('.nl-dialog-foot button:has-text("保存")')
        assert '酒吧打烊后' in ev(page, 'NovelLoom.app.project.groupCards[0].data.scenario')

        # ---------------- 场次/节拍拆分（写大纲） ----------------
        page.click('.nl-nav-btn[data-tab="plan"]')
        page.fill('[data-setting="planner.count"]', '2')
        page.dispatch_event('[data-setting="planner.count"]', 'input')
        page.check('[data-setting="planner.useScenes"]')
        page.click('[data-act="generate"]')
        page.wait_for_selector('.nl-plan', timeout=20000)
        assert page.locator('.nl-plan').count() == 2
        scenes_n = ev(page, 'NovelLoom.app.project.plan.chapters[0].scenes.length')
        print('scenes on chapter 1:', scenes_n)
        assert scenes_n >= 1
        assert '🎬' in page.locator('.nl-plan').first.inner_text()
        shot(page, '05-plan-scenes')

        # ---------------- 多视角管理 ----------------
        page.click('.nl-nav-btn[data-tab="style"]')
        page.wait_for_selector('details:has-text("多视角管理")')
        page.click('details summary:has-text("多视角管理")')
        page.wait_for_selector('[data-pov-char="莉莉丝"]', state='visible')
        page.select_option('[data-pov-char="莉莉丝"]', 'b_second')
        assert ev(page, "NovelLoom.app.project.povStyles['莉莉丝']") == 'b_second'
        shot(page, '06-pov-mapping')

        page.click('.nl-nav-btn[data-tab="plan"]')
        page.click('.nl-plan >> nth=0 >> [data-act="edit"]')
        page.wait_for_selector('.nl-dialog [data-f="pov"]')
        page.select_option('.nl-dialog [data-f="pov"]', '莉莉丝')
        page.click('.nl-dialog-foot button:has-text("保存")')
        page.wait_for_function('document.querySelector(".nl-plan").textContent.includes("视角：莉莉丝")')
        assert ev(page, 'NovelLoom.app.project.plan.chapters[0].pov') == '莉莉丝'
        shot(page, '07-chapter-pov')

        page.click('.nl-nav-btn[data-tab="continue"]')
        page.wait_for_selector('[data-act="api-start"]')
        page.click('[data-act="api-preview"]')
        page.wait_for_selector('.nl-dialog')
        preview_text = page.inner_text('.nl-dialog')
        print('continue preview includes pov style:', '视角：第二人称' in preview_text)
        assert '视角：第二人称' in preview_text, preview_text[:800]
        page.click('.nl-dialog [data-close]')

        # ---------------- 连续性检查 ----------------
        page.fill('[data-setting="continuation.chapters"]', '1')
        page.dispatch_event('[data-setting="continuation.chapters"]', 'input')
        page.uncheck('[data-setting="continuation.feedback"]')
        page.click('[data-act="api-start"]')
        wait_log(page, '续写结束', timeout=30000)
        assert ev(page, 'NovelLoom.app.project.continuation.chapters.length') == 1
        page.click('.nl-list-item >> nth=0 >> button:has-text("查看/编辑")')
        page.wait_for_selector('[data-act="check-continuity"]')
        page.click('[data-act="check-continuity"]')
        page.wait_for_function('document.querySelector(".nl-dialog").textContent.includes("未发现明显矛盾")', timeout=15000)
        shot(page, '08-continuity-check')
        page.click('.nl-dialog [data-close]')
        issues_n = ev(page, 'NovelLoom.app.project.continuation.chapters[0].continuityCheck.issues.length')
        assert issues_n == 0

        # ---------------- 伏笔看板 ----------------
        page.click('.nl-nav-btn[data-tab="foreshadow"]')
        page.wait_for_selector('[data-act="add"]')
        assert '还没有伏笔数据' in page.inner_text('#nl-tab')
        page.click('[data-act="analyze"]')
        page.wait_for_selector('.nl-table tbody tr', timeout=20000)
        wait_log(page, 'AI 整理伏笔看板')
        rows_text = page.inner_text('.nl-table')
        print('foreshadow after analyze:', rows_text.replace('\n', ' | '))
        assert '莉莉丝的过去' in rows_text and '未回收' in rows_text
        shot(page, '09-foreshadow-analyze')

        # 切到“全部”筛选，这样回收/重新打开后这一行不会因为不匹配筛选条件而消失
        page.select_option('[data-act-input="filter"]', 'all')
        page.wait_for_selector('.nl-table')
        page.click('.nl-table [data-act="resolve"]')
        page.wait_for_function('document.querySelector(".nl-table").textContent.includes("已回收")')
        page.click('.nl-table [data-act="reopen"]')
        page.wait_for_function('document.querySelector(".nl-table").textContent.includes("未回收")')

        before_rows = page.locator('.nl-table tbody tr').count()
        page.click('[data-act="add"]')
        page.wait_for_selector('.nl-dialog [data-f="text"]')
        page.fill('.nl-dialog [data-f="text"]', '测试伏笔：江酒的旧疤')
        page.fill('.nl-dialog [data-f="plantedNo"]', '1')
        ok_dialog(page, '保存')
        wait_log(page, '已添加伏笔')
        page.wait_for_function('(n) => document.querySelectorAll(".nl-table tbody tr").length === n', arg=before_rows + 1)
        shot(page, '10-foreshadow-manual-add')

        page.click('.nl-table tbody tr:has-text("测试伏笔") [data-act="del"]')
        page.click('.nl-dialog-foot button:has-text("删除")')
        page.wait_for_function('(n) => document.querySelectorAll(".nl-table tbody tr").length === n', arg=before_rows)

        # 窄屏
        page.set_viewport_size({'width': 390, 'height': 844})
        shot(page, '11-mobile')
        browser.close()
finally:
    server.terminate()

real = [e for e in errors if 'favicon' not in e]
print('ERRORS:', json.dumps(real, ensure_ascii=False))
sys.exit(1 if real else 0)
