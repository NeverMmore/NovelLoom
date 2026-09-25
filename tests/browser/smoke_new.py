# 浏览器冒烟测试（v0.2 新功能）：分卷、消息链、写大纲、按大纲续写
import json, os, subprocess, sys, time
from playwright.sync_api import sync_playwright

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
SHOTS = sys.argv[1] if len(sys.argv) > 1 else '/tmp/nl-new'
os.makedirs(SHOTS, exist_ok=True)
PORT = 8768
server = subprocess.Popen([sys.executable, '-m', 'http.server', str(PORT), '--bind', '127.0.0.1'], cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1)

NOVEL = '\n'.join([
    '第一卷 下城区', '第一章 魔女小姐', '江酒走进酒吧。莉莉丝把一瓶紫色魔药推到他面前。\n' * 25,
    '第二章 女仆', '江酒穿上了女仆装。莉莉丝去参加魔女茶会。\n' * 25,
    '第二卷 学院', '第三章 入学', '江酒来到魔女学院，姜小白在门口等他。\n' * 25,
    '第四章 考试', '姜小白在学院考试，江酒在酒吧打工。\n' * 25,
])
errors = []

def shot(page, name):
    page.screenshot(path=os.path.join(SHOTS, name + '.png'))

def wait_log(page, text, timeout=30000):
    page.wait_for_function('(t) => [...document.querySelectorAll(".nl-log-line")].some(l => l.textContent.includes(t))', arg=text, timeout=timeout)

def ev(page, js):
    return page.evaluate(js)

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

        # 导入：按“第X卷”自动分卷
        page.click('[data-act="paste"]')
        page.fill('.nl-dialog textarea', NOVEL)
        page.click('.nl-dialog-foot button:has-text("确定")')
        page.fill('#nl-bookname', '魔女')
        page.fill('[data-setting="chunking.chunkSize"]', '1000')
        page.dispatch_event('[data-setting="chunking.chunkSize"]', 'input')
        page.click('[data-act="create"]')
        page.wait_for_selector('.nl-vol-head')
        heads = page.locator('.nl-vol-head').all_inner_texts()
        print('volume heads:', [h.split('\n')[0] for h in heads])
        assert len(heads) == 2 and '第一卷 下城区' in heads[0] and '第二卷 学院' in heads[1]
        shot(page, '01-chunks-volumes')
        # 手动分卷 → 取消
        page.click('[data-act="split-here"] >> nth=0')
        page.click('.nl-dialog-foot button:has-text("确定")')
        page.wait_for_function('document.querySelectorAll(".nl-vol-head").length === 3')
        page.click('[data-act="vol-remove"] >> nth=0')
        page.click('.nl-dialog-foot button:has-text("确定")')
        page.wait_for_function('document.querySelectorAll(".nl-vol-head").length === 2')

        # 设置：给“分段提取”自定义消息链（加一条系统消息 + AI 预填）
        page.click('.nl-nav-btn[data-tab="settings"]')
        page.select_option('[data-chain-task]', 'extract')
        page.click('[data-act="chain-copy"]')
        page.wait_for_selector('.nl-chain-msg')
        page.click('[data-act="chain-add"][data-role="system"]')
        last_ta = page.locator('.nl-chain-msg textarea').last
        last_ta.fill('你是资深编辑，处理《{BOOK}》')
        page.click('[data-act="chain-up"] >> nth=-1')  # 新系统消息上移到用户消息之前
        page.click('[data-act="chain-add"][data-role="assistant"]')
        page.locator('.nl-chain-msg textarea').last.fill('好的，JSON 如下：')
        page.locator('.nl-chain-msg textarea').last.dispatch_event('input')
        roles = ev(page, "NovelLoom.app.settings.messageChains.extract.map(m => m.role)")
        print('extract chain roles:', roles)
        assert roles == ['system', 'system', 'user', 'assistant'], roles
        page.click('[data-act="chain-preview"]')
        page.wait_for_selector('.nl-dialog .nl-role-assistant')
        prev = page.inner_text('.nl-dialog')
        assert '处理《魔女》' in prev, prev[:300]
        shot(page, '02-chain-preview')
        page.click('.nl-dialog [data-close]')
        shot(page, '03-settings-chain')

        # 提取：开启分卷模式
        page.click('.nl-nav-btn[data-tab="extract"]')
        page.check('[data-setting="extraction.volumeMode"]')
        page.click('[data-act="preview"]')
        page.wait_for_selector('.nl-dialog .nl-role-assistant')
        page.click('.nl-dialog [data-close]')
        page.evaluate('window.__roles = []')
        page.click('[data-act="start"]')
        wait_log(page, '提取结束', timeout=60000)
        roles_seen = ev(page, 'window.__roles')
        extract_roles = [r for r in roles_seen if len(r) == 4]
        print('first call roles:', roles_seen[0])
        assert extract_roles and extract_roles[0] == ['system', 'system', 'user', 'assistant'], roles_seen[:3]
        sums = ev(page, "NovelLoom.app.project.volumes.map(v => v.summary)")
        print('volume summaries:', sums)
        assert all(sums), sums
        page.click('[data-act="log-toggle"]')
        shot(page, '04-extract-volume-mode')
        page.click('[data-act="log-toggle"]')

        # 世界书：按卷查看、分卷写入
        page.click('.nl-nav-btn[data-tab="worldbook"]')
        page.wait_for_selector('[data-vol-filter]')
        vol2 = ev(page, "NovelLoom.app.project.volumes[1].id")
        page.select_option('[data-vol-filter]', vol2)
        page.wait_for_function('document.querySelector("[data-act=preview]").textContent.includes("（")')
        shot(page, '05-worldbook-volume')
        page.click('[data-act="publish-volumes"]')
        page.click('.nl-dialog-foot button:has-text("确定")')
        wait_log(page, '已分卷写入酒馆')
        worlds = ev(page, 'Object.keys(window.__saved.worlds)')
        print('worlds:', worlds)
        assert '《魔女》世界书·第一卷 下城区' in worlds and '《魔女》世界书·第二卷 学院' in worlds
        w1 = ev(page, "Object.values(window.__saved.worlds['《魔女》世界书·第一卷 下城区'].entries).map(e => e.comment)")
        print('vol1 entries:', w1)
        assert not any('姜小白' in c for c in w1), '第一卷世界书不应包含第二卷才出场的角色'

        # 大纲页：分卷梗概
        page.click('.nl-nav-btn[data-tab="outline"]')
        page.wait_for_selector('[data-vol-sum]')
        shot(page, '06-outline-volumes')

        # 写大纲
        page.click('.nl-nav-btn[data-tab="plan"]')
        page.fill('[data-setting="planner.count"]', '4')
        page.dispatch_event('[data-setting="planner.count"]', 'input')
        page.fill('[data-setting="planner.requirement"]', '江酒进入魔女学院，节奏紧凑，第三章让莉莉丝回归')
        page.dispatch_event('[data-setting="planner.requirement"]', 'input')
        page.click('[data-act="preview"]')
        page.wait_for_selector('.nl-dialog')
        assert '莉莉丝回归' in page.inner_text('.nl-dialog')
        page.click('.nl-dialog [data-close]')
        page.click('[data-act="generate"]')
        page.wait_for_selector('.nl-plan', timeout=20000)
        n_plan = page.locator('.nl-plan').count()
        print('planned:', n_plan, page.locator('.nl-plan b').first.inner_text())
        assert n_plan == 4
        assert '第 5 章' in page.locator('.nl-plan b').first.inner_text()
        shot(page, '07-plan')
        # 编辑第一章
        page.click('.nl-plan >> nth=0 >> [data-act="edit"]')
        page.fill('.nl-dialog [data-f="title"]', '初到学院')
        page.click('.nl-dialog-foot button:has-text("保存")')
        page.wait_for_function('document.querySelector(".nl-plan b").textContent.includes("初到学院")')
        # AI 重写第二章
        page.click('.nl-plan >> nth=1 >> [data-act="revise"]')
        page.fill('.nl-dialog textarea', '让莉莉丝提前登场')
        page.click('.nl-dialog-foot button:has-text("确定")')
        wait_log(page, '已重写第 6 章大纲')
        # 从第 7 章起重新规划
        page.click('.nl-plan >> nth=2 >> [data-act="from-here"]')
        page.wait_for_selector('[data-act="clear-from"]')
        page.fill('[data-setting="planner.count"]', '3')
        page.dispatch_event('[data-setting="planner.count"]', 'input')
        page.click('[data-act="generate"]')
        page.click('.nl-dialog-foot button:has-text("确定")')
        page.wait_for_function('!document.querySelector("[data-act=clear-from]")', timeout=20000)
        nos = ev(page, "NovelLoom.app.project.plan.chapters.map(c => c.no)")
        print('plan numbers:', nos)
        assert nos == [5, 6, 7, 8, 9], nos

        # 按大纲续写 2 章
        page.click('[data-act="write"]')
        page.fill('.nl-dialog input', '2')
        page.click('.nl-dialog-foot button:has-text("确定")')
        wait_log(page, '续写结束', timeout=30000)
        titles = ev(page, "NovelLoom.app.project.continuation.chapters.map(c => c.title)")
        print('written:', titles)
        assert titles[0].startswith('第5章') and len(titles) == 2
        status = ev(page, "NovelLoom.app.project.plan.chapters.map(c => c.status)")
        assert status[:2] == ['written', 'written'], status
        assert '按大纲' in page.inner_text('#nl-tab'), '续写页应显示下一章大纲'
        shot(page, '08-continue-plan')
        page.click('.nl-nav-btn[data-tab="plan"]')
        page.wait_for_selector('.nl-plan.written')
        shot(page, '09-plan-written')

        # 角色卡：卷末时间点
        page.click('.nl-nav-btn[data-tab="cards"]')
        opts = page.locator('[data-form="timepoint"] option').all_inner_texts()
        assert any('卷末' in o for o in opts), opts[:5]

        # 窄屏
        page.set_viewport_size({'width': 390, 'height': 844})
        page.click('.nl-nav-btn[data-tab="plan"]')
        shot(page, '10-mobile-plan')
        browser.close()
finally:
    server.terminate()

real = [e for e in errors if 'favicon' not in e]
print('ERRORS:', json.dumps(real, ensure_ascii=False))
sys.exit(1 if real else 0)
