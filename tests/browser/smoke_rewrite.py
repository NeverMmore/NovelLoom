# 浏览器冒烟测试（局部重写）：续写页「查看/编辑」与分段页里的“AI 重写选中部分”
import json, os, subprocess, sys, time
from playwright.sync_api import sync_playwright

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
OUT = sys.argv[1] if len(sys.argv) > 1 else '/tmp/nl-rewrite'
os.makedirs(OUT, exist_ok=True)
PORT = 8773
server = subprocess.Popen([sys.executable, '-m', 'http.server', str(PORT), '--bind', '127.0.0.1'], cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1)

NOVEL = '\n'.join([
    '第一章 魔女小姐', '江酒走进酒吧。莉莉丝坐在角落，黑色长裙拖到地上。', '“没错，今晚我是来跟你提分手的。”江酒说。', '莉莉丝把一瓶紫色魔药推到他面前，仿佛什么都没发生。\n' * 8,
    '第二章 女仆', '江酒穿上了女仆装。', '“挺合身。”莉莉丝说，“明天开始打扫阁楼。”', '他叹了口气，拎起扫帚上楼。楼梯吱呀作响。\n' * 8,
])
errors = []

def shot(page, name):
    page.screenshot(path=os.path.join(OUT, name + '.png'))

def wait_log(page, text, timeout=30000):
    page.wait_for_function('(t) => [...document.querySelectorAll(".nl-log-line")].some(l => l.textContent.includes(t))', arg=text, timeout=timeout)

def count_log(page, text):
    return page.evaluate('(t) => [...document.querySelectorAll(".nl-log-line")].filter((l) => l.textContent.includes(t)).length', text)

def wait_log_new(page, text, timeout=30000):
    """等一条“新出现”的日志（用于可能重复出现的同一条消息，避免命中之前留下的旧日志）"""
    before = count_log(page, text)
    page.wait_for_function(
        '(a) => [...document.querySelectorAll(".nl-log-line")].filter((l) => l.textContent.includes(a[0])).length > a[1]',
        arg=[text, before],
        timeout=timeout,
    )

def ev(page, js):
    return page.evaluate(js)

def ok_dialog(page, label='确定'):
    page.click(f'.nl-dialog-foot button:has-text("{label}")')

def select_in_textarea(page, selector, needle):
    """把某个 textarea 里第一次出现 needle 的位置设为选区，返回 (start, end)"""
    return page.evaluate(
        '''([sel, needle]) => {
            const ta = document.querySelector(sel);
            const i = ta.value.indexOf(needle);
            if (i < 0) throw new Error('未找到: ' + needle);
            ta.focus();
            ta.setSelectionRange(i, i + needle.length);
            return [i, i + needle.length];
        }''',
        [selector, needle],
    )

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

        page.click('[data-act="paste"]')
        page.fill('.nl-dialog textarea', NOVEL)
        ok_dialog(page)
        page.fill('#nl-bookname', '魔女')
        page.click('[data-act="create"]')
        page.wait_for_selector('.nl-chunk')
        page.click('.nl-nav-btn[data-tab="extract"]')
        page.click('[data-act="start"]')
        wait_log(page, '提取结束', timeout=60000)

        # ---- 分段页：AI 重写选中部分 ----
        page.click('.nl-nav-btn[data-tab="chunks"]')
        page.click('[data-act="view"] >> nth=0')
        page.wait_for_selector('#nl-chunk-content')
        before_val = page.input_value('#nl-chunk-content')

        # 未选中文字时点击应该只提示，不弹出重写对话框
        page.click('[data-act="rewrite-sel"]')
        wait_log(page, '请先在正文里选中要重写的一段')
        assert page.locator('.nl-dialog').count() == 1, '不应该弹出第二个对话框'

        start, end = select_in_textarea(page, '#nl-chunk-content', '仿佛什么都没发生')
        page.click('[data-act="rewrite-sel"]')
        page.wait_for_function('document.querySelectorAll(".nl-dialog-overlay").length === 2')
        page.fill('.nl-dialog-overlay >> nth=-1 >> textarea', '删掉“仿佛”这类词，换成更肯定的写法')
        page.click('.nl-dialog-overlay >> nth=-1 >> .nl-dialog-foot button:has-text("确定")')
        wait_log_new(page, '已重写选中部分')
        after_val = page.input_value('#nl-chunk-content')
        print('chunk rewrite before len/after len:', len(before_val), len(after_val))
        assert '【改写】' in after_val and '删掉“仿佛”这类词' in after_val
        assert after_val[:start] == before_val[:start], '选区之前的文字不应改变'
        shot(page, '01-chunk-rewrite')
        ok_dialog(page, '保存修改')
        assert '【改写】' in ev(page, 'NovelLoom.app.project.chunks[0].content')

        # ---- 续写页：生成一章，再 AI 重写选中部分 ----
        page.click('.nl-nav-btn[data-tab="continue"]')
        page.wait_for_selector('[data-act="api-start"]')
        page.fill('[data-setting="continuation.chapters"]', '1')
        page.dispatch_event('[data-setting="continuation.chapters"]', 'input')
        page.uncheck('[data-setting="continuation.feedback"]')
        page.click('[data-act="api-start"]')
        wait_log(page, '续写结束', timeout=30000)

        page.click('.nl-list-item >> nth=0 >> [data-act="view-gen"] >> nth=0')
        page.wait_for_selector('.nl-dialog textarea')
        gen_before = page.input_value('.nl-dialog textarea')
        select_in_textarea(page, '.nl-dialog textarea', '江酒')
        page.click('.nl-dialog [data-act="rewrite-sel"]')
        page.wait_for_function('document.querySelectorAll(".nl-dialog-overlay").length === 2')
        page.fill('.nl-dialog-overlay >> nth=-1 >> textarea', '把这里改成描写他的侧脸')
        page.click('.nl-dialog-overlay >> nth=-1 >> .nl-dialog-foot button:has-text("确定")')
        wait_log_new(page, '已重写选中部分')
        gen_after = page.input_value('.nl-dialog textarea')
        print('continue rewrite changed:', gen_before != gen_after)
        assert '【改写】' in gen_after and '把这里改成描写他的侧脸' in gen_after
        shot(page, '02-continue-rewrite')
        ok_dialog(page, '保存')
        assert '【改写】' in ev(page, 'NovelLoom.app.project.continuation.chapters[0].content')

        # 取消重写要求对话框：不应有任何改动
        page.click('.nl-list-item >> nth=0 >> [data-act="view-gen"] >> nth=0')
        page.wait_for_selector('.nl-dialog textarea')
        before_cancel = page.input_value('.nl-dialog textarea')
        select_in_textarea(page, '.nl-dialog textarea', '莉莉丝') if '莉莉丝' in before_cancel else select_in_textarea(page, '.nl-dialog textarea', before_cancel[:2])
        page.click('.nl-dialog [data-act="rewrite-sel"]')
        page.wait_for_function('document.querySelectorAll(".nl-dialog-overlay").length === 2')
        page.click('.nl-dialog-overlay >> nth=-1 >> .nl-dialog-foot button:has-text("取消")')
        page.wait_for_function('document.querySelectorAll(".nl-dialog-overlay").length === 1')
        after_cancel = page.input_value('.nl-dialog textarea')
        assert before_cancel == after_cancel, '取消重写要求后正文不应改变'
        page.click('.nl-dialog [data-close]')

        page.set_viewport_size({'width': 390, 'height': 844})
        shot(page, '03-mobile')
        browser.close()
finally:
    server.terminate()

real = [e for e in errors if 'favicon' not in e]
print('ERRORS:', json.dumps(real, ensure_ascii=False))
sys.exit(1 if real else 0)
