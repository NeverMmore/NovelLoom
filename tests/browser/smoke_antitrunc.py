# 浏览器冒烟测试（v0.4 防截断）：设置页、续写截断自动接续、拒绝提示
import json, os, subprocess, sys, time
from playwright.sync_api import sync_playwright

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
SHOTS = sys.argv[1] if len(sys.argv) > 1 else '/tmp/nl-antitrunc'
os.makedirs(SHOTS, exist_ok=True)
PORT = 8771
server = subprocess.Popen([sys.executable, '-m', 'http.server', str(PORT), '--bind', '127.0.0.1'], cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1)

NOVEL = '\n'.join(['第一章 魔女小姐', '江酒走进酒吧。“你来了。”莉莉丝说。\n' * 10, '第二章 女仆', '江酒穿上了女仆装。\n' * 10])
errors = []

def wait_log(page, text, timeout=30000):
    page.wait_for_function('(t) => [...document.querySelectorAll(".nl-log-line")].some(l => l.textContent.includes(t))', arg=text, timeout=timeout)

try:
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={'width': 1360, 'height': 900})
        page.on('pageerror', lambda e: errors.append('pageerror: ' + str(e)))
        page.on('console', lambda m: errors.append('console: ' + m.text) if m.type == 'error' else None)
        page.goto(f'http://127.0.0.1:{PORT}/tests/browser/harness.html')
        page.wait_for_selector('#nl-wand-button')
        page.evaluate("NovelLoom.open('settings')")
        page.wait_for_selector('[data-anti-truncate]')

        # 设置页：防截断
        assert page.is_checked('[data-setting="antiTruncate.enabled"]')
        page.fill('[data-setting="antiTruncate.maxContinues"]', '2')
        page.dispatch_event('[data-setting="antiTruncate.maxContinues"]', 'input')
        assert page.evaluate('NovelLoom.app.settings.antiTruncate.maxContinues') == 2
        page.select_option('[data-setting="antiTruncate.style"]', 'ask')
        # Gemini 安全阈值只在 Gemini 模式显示
        sec = '[data-api="api"]'
        assert page.is_hidden(f'{sec} [data-gemini-only]')
        page.select_option(f'{sec} [data-setting="api.mode"]', 'gemini')
        assert page.is_visible(f'{sec} [data-gemini-only]')
        page.select_option(f'{sec} [data-setting="api.geminiSafety"]', 'OFF')
        assert page.evaluate('NovelLoom.app.settings.api.geminiSafety') == 'OFF'
        page.locator('[data-anti-truncate]').scroll_into_view_if_needed()
        page.screenshot(path=os.path.join(SHOTS, '01-settings.png'))
        page.select_option(f'{sec} [data-setting="api.mode"]', 'tavern')
        assert page.is_hidden(f'{sec} [data-gemini-only]')
        page.click('[data-act="anti-reset"]')
        page.wait_for_selector('[data-anti-truncate]')
        assert page.evaluate('NovelLoom.app.settings.antiTruncate.maxContinues') == 3

        # 导入小说
        page.click('.nl-nav-btn[data-tab="project"]')
        page.click('[data-act="paste"]')
        page.fill('.nl-dialog textarea', NOVEL)
        page.click('.nl-dialog-foot button:has-text("确定")')
        page.fill('#nl-bookname', '魔女')
        page.click('[data-act="create"]')
        page.wait_for_selector('.nl-nav-btn[data-tab="chunks"].active')

        # 续写：第一次回复停在半句 → 自动接续
        page.click('.nl-nav-btn[data-tab="continue"]')
        page.fill('[data-setting="continuation.chapters"]', '1')
        page.dispatch_event('[data-setting="continuation.chapters"]', 'input')
        page.uncheck('[data-setting="continuation.feedback"]')
        page.evaluate('window.__truncateOnce = true')
        page.click('[data-act="api-start"]')
        wait_log(page, '续写结束')
        wait_log(page, '自动接续')
        content = page.evaluate('NovelLoom.app.project.continuation.chapters[0].content')
        print('tail:', content[-30:])
        assert content.endswith('江酒刚想开口，莉莉丝放下书，看了他一眼。'), content[-60:]

        # 模型拒绝：明确提示
        page.evaluate('window.__refuseOnce = true')
        page.click('[data-act="api-start"]')
        wait_log(page, 'AI 拒绝了这次请求')
        wait_log(page, '续写结束：完成 0 章')
        page.click('[data-act="log-toggle"]')
        page.screenshot(path=os.path.join(SHOTS, '02-continue-log.png'))
        browser.close()
finally:
    server.terminate()

real = [e for e in errors if 'favicon' not in e]
print('ERRORS:', json.dumps(real, ensure_ascii=False))
sys.exit(1 if real else 0)
