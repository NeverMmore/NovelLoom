# 浏览器冒烟测试（人物关系图谱）：手动增删改、AI 分析、类型/时间点筛选、图谱节点聚焦、导出导入
import json, os, subprocess, sys, time
from playwright.sync_api import sync_playwright

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
OUT = sys.argv[1] if len(sys.argv) > 1 else '/tmp/nl-relations'
os.makedirs(OUT, exist_ok=True)
PORT = 8772
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

def download(page, click_selector):
    with page.expect_download() as d:
        page.click(click_selector)
    path = os.path.join(OUT, d.value.suggested_filename)
    d.value.save_as(path)
    return path

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

        page.click('[data-act="paste"]')
        page.fill('.nl-dialog textarea', NOVEL)
        ok_dialog(page)
        page.fill('#nl-bookname', '魔女')
        page.click('[data-act="create"]')
        page.wait_for_selector('.nl-chunk')
        page.click('.nl-nav-btn[data-tab="extract"]')
        page.click('[data-act="start"]')
        wait_log(page, '提取结束', timeout=60000)
        n_chunks = ev(page, 'NovelLoom.app.project.chunks.length')
        print('chunks:', n_chunks)
        assert ev(page, "Object.keys(NovelLoom.app.project.characters)").__len__() >= 3

        # 关系页：初始为空
        page.click('.nl-nav-btn[data-tab="relations"]')
        page.wait_for_selector('[data-act="add"]')
        assert '还没有任何关系数据' in page.inner_text('#nl-tab') or '还没有可展示的关系' in page.inner_text('#nl-tab')
        shot(page, '01-empty')

        # 手动添加一条关系
        page.click('[data-act="add"]')
        page.wait_for_selector('.nl-dialog select[data-f="from"]')
        page.select_option('.nl-dialog select[data-f="from"]', '江酒')
        page.select_option('.nl-dialog select[data-f="to"]', '莉莉丝')
        page.select_option('.nl-dialog select[data-f="type"]', 'romantic')
        page.uncheck('.nl-dialog [data-f="mutual"]')
        page.fill('.nl-dialog [data-f="label"]', '曾经的恋人')
        ok_dialog(page, '保存')
        wait_log(page, '已添加关系')
        page.wait_for_selector('.nl-rel-svg circle')
        assert page.locator('.nl-table tbody tr').count() == 1
        assert '曾经的恋人' in page.inner_text('.nl-table')
        shot(page, '02-manual-add')

        # 编辑该关系
        page.click('.nl-table [data-act="edit"]')
        page.wait_for_selector('.nl-dialog select[data-f="from"]')
        page.fill('.nl-dialog [data-f="label"]', '曾经的恋人，如今是雇佣关系')
        ok_dialog(page, '保存')
        wait_log(page, '已修改关系')
        assert '如今是雇佣关系' in page.inner_text('.nl-table')

        # 图谱节点聚焦：点击“莉莉丝”名字链接
        page.click('.nl-table a[data-name="莉莉丝"]')
        page.wait_for_selector('[data-act="clear-focus"]')
        assert '只看「莉莉丝」的关系' in page.inner_text('#nl-tab')
        page.click('[data-act="clear-focus"]')
        page.wait_for_function('!document.querySelector("[data-act=clear-focus]")')

        # 角色卡「相关角色」应优先使用关系图谱里的明确关系，而不是启发式猜测
        page.click('.nl-nav-btn[data-tab="cards"]')
        page.wait_for_selector('[data-form="charName"]')
        page.select_option('[data-form="charName"]', '江酒')
        page.evaluate('window.__prompts = []')
        page.click('[data-act="generate"]')
        page.wait_for_selector('.nl-dialog [data-card="description"]', timeout=20000)
        card_prompt = ev(page, 'window.__prompts[window.__prompts.length - 1]')
        assert '# 相关角色' in card_prompt and '如今是雇佣关系' in card_prompt, card_prompt[:1000]
        print('card prompt correctly used explicit relationship data')
        page.click('.nl-dialog [data-close]')
        page.click('.nl-nav-btn[data-tab="relations"]')
        page.wait_for_selector('[data-act="add"]')

        # AI 分析关系（mock 返回江酒→莉莉丝、江酒↔姜小白）
        page.click('[data-act="analyze"]')
        page.wait_for_function('document.querySelectorAll(".nl-table tbody tr").length >= 2', timeout=20000)
        wait_log(page, 'AI 分析关系')
        rows_text = page.inner_text('.nl-table')
        print('after analyze:', rows_text.replace('\n', ' | '))
        assert '姜小白' in rows_text and 'AI 自动分析得出' in page.inner_html('.nl-table')
        shot(page, '03-ai-analyze')

        # 类型筛选：只看 romantic
        page.select_option('[data-act-input="type"]', 'romantic')
        page.wait_for_function('document.querySelectorAll(".nl-table tbody tr").length === 1')
        assert '莉莉丝' in page.inner_text('.nl-table') and '姜小白' not in page.inner_text('.nl-table')
        page.select_option('[data-act-input="type"]', 'all')
        page.wait_for_function('document.querySelectorAll(".nl-table tbody tr").length >= 2')

        # 时间点筛选：关系都记在最后一段（默认时间点），选更早的时间点应该把它们过滤掉
        rel_chunk = ev(page, 'Math.max(...NovelLoom.app.project.relationships.map((r) => r.chunk))')
        print('relationships recorded at chunk index:', rel_chunk, 'of', n_chunks, 'chunks')
        if rel_chunk > 0:
            page.select_option('[data-act-input="upto"]', str(rel_chunk - 1))
            page.wait_for_selector('.nl-empty')
        else:
            print('skip timepoint-filter subtest: relationships recorded at chunk 0')
        page.select_option('[data-act-input="upto"]', '')
        page.wait_for_function('document.querySelectorAll(".nl-table tbody tr").length >= 2')
        shot(page, '04-filters-reset')

        # 导出 → 导入（合并去重：导入同样的数据不应重复增加行数）
        before_rows = page.locator('.nl-table tbody tr').count()
        rel_path = download(page, '[data-act="export"]')
        data = json.load(open(rel_path, encoding='utf-8'))
        print('exported relationships:', len(data['relationships']))
        assert data['type'] == 'novelloom-relationships' and len(data['relationships']) == before_rows
        with page.expect_file_chooser() as fc:
            page.click('[data-act="import"]')
        fc.value.set_files(rel_path)
        wait_log(page, '已导入关系')
        after_rows = page.locator('.nl-table tbody tr').count()
        print('rows before/after re-import:', before_rows, after_rows)
        assert after_rows == before_rows, '重复导入同样数据不应新增行'

        # 删除一条关系
        page.click('.nl-table [data-act="del"] >> nth=0')
        page.click('.nl-dialog-foot button:has-text("删除")')
        page.wait_for_function('(n) => document.querySelectorAll(".nl-table tbody tr").length === n', arg=after_rows - 1)

        # 窄屏
        page.set_viewport_size({'width': 390, 'height': 844})
        shot(page, '05-mobile')
        browser.close()
finally:
    server.terminate()

real = [e for e in errors if 'favicon' not in e]
print('ERRORS:', json.dumps(real, ensure_ascii=False))
sys.exit(1 if real else 0)
