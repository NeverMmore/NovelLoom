# 浏览器冒烟测试（导入导出与工具）：任务导出/导入、世界书导出/合并导入、PNG 导出、快照回退、查找替换、头像上传
import json, os, subprocess, sys, time, base64
from playwright.sync_api import sync_playwright

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
OUT = sys.argv[1] if len(sys.argv) > 1 else '/tmp/nl-io'
os.makedirs(OUT, exist_ok=True)
PORT = 8767
server = subprocess.Popen([sys.executable, '-m', 'http.server', str(PORT), '--bind', '127.0.0.1'], cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1)
NOVEL = '第一章 魔女小姐\n' + '江酒走进酒吧。莉莉丝把一瓶紫色魔药推到他面前。\n' * 30 + '第二章 下城区\n' + '姜小白在雨中迷路，走进了下城区的酒吧。\n' * 30
errors = []

def wait_log(page, text, timeout=30000):
    page.wait_for_function('(t) => [...document.querySelectorAll(".nl-log-line")].some(l => l.textContent.includes(t))', arg=text, timeout=timeout)

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
        page.click('.nl-dialog-foot button:has-text("确定")')
        page.fill('#nl-bookname', '魔女')
        page.click('[data-act="create"]')
        page.wait_for_selector('.nl-chunk')
        page.click('.nl-nav-btn[data-tab="extract"]')
        page.click('[data-act="start"]')
        wait_log(page, '提取结束')

        # 世界书：导出 → 查找替换 → 快照回退 → 合并导入
        page.click('.nl-nav-btn[data-tab="worldbook"]')
        wb_path = download(page, '[data-act="export"]')
        wb = json.load(open(wb_path, encoding='utf-8'))
        print('exported worldbook entries:', len(wb['entries']))
        page.click('[data-act="replace"]')
        page.fill('.nl-dialog [data-f="find"]', '酒吧')
        page.fill('.nl-dialog [data-f="replace"]', '茶馆')
        page.click('.nl-dialog-foot button:has-text("统计匹配")')
        print('count:', page.inner_text('.nl-dialog [data-count]'))
        page.click('.nl-dialog-foot button:has-text("全部替换")')
        wait_log(page, '已替换')
        assert page.evaluate("JSON.stringify(NovelLoom.app.project.worldbook).includes('茶馆')")
        page.click('[data-act="snapshots"]')
        page.wait_for_selector('[data-snap-restore]')
        page.click('[data-snap-restore] >> nth=0')  # 最新快照 = 替换前
        page.click('.nl-dialog-overlay >> nth=-1 >> .nl-dialog-foot button:has-text("确定")')
        wait_log(page, '已回退到快照')
        page.keyboard.press('Escape')
        assert not page.evaluate("JSON.stringify(NovelLoom.app.project.worldbook).includes('茶馆')"), '回退后应恢复'
        page.wait_for_selector('[data-act="export-diff"]')
        page.click('[data-act="export-diff"]')
        wait_log(page, '变更')
        with page.expect_file_chooser() as fc:
            page.click('[data-act="import"]')
        wb['entries']['999'] = {'uid': 999, 'key': ['外部条目'], 'comment': '势力 - 外部组织', 'content': '一个外部导入的组织', 'constant': False, 'position': 0, 'order': 1}
        ext = os.path.join(OUT, 'ext.json'); json.dump(wb, open(ext, 'w', encoding='utf-8'), ensure_ascii=False)
        fc.value.set_files(ext)
        wait_log(page, '已合并导入')
        assert page.evaluate("!!NovelLoom.app.project.worldbook['势力']['外部组织']")

        # 角色卡：生成 → 上传头像 → 导出 PNG / JSON
        page.click('.nl-nav-btn[data-tab="cards"]')
        page.select_option('[data-form="charName"]', '莉莉丝')
        page.click('[data-act="generate"]')
        page.wait_for_selector('.nl-dialog [data-card="description"]', timeout=20000)
        png1 = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==')
        av = os.path.join(OUT, 'avatar.png'); open(av, 'wb').write(png1)
        with page.expect_file_chooser() as fc:
            page.click('.nl-dialog [data-card-act="avatar"]')
        fc.value.set_files(av)
        page.wait_for_selector('.nl-dialog img[data-avatar-img]')
        page.click('.nl-dialog-foot button:has-text("保存")  >> nth=0')
        page.wait_for_selector('.nl-cardbox img.nl-avatar')
        png_path = download(page, '[data-act="png"]')
        data = open(png_path, 'rb').read()
        assert data[:8] == b'\x89PNG\r\n\x1a\n' and b'ccv3' in data and b'chara' in data, 'PNG 应内嵌卡片数据'
        json_path = download(page, '[data-act="json"]')
        card = json.load(open(json_path, encoding='utf-8'))
        assert card['spec'] == 'chara_card_v3' and card['data']['character_book']['entries']
        # 写入酒馆（带头像 → PNG 导入）
        page.click('[data-act="publish"]')
        page.wait_for_function('window.__saved.imports.length === 1')
        assert page.evaluate('window.__saved.lastImport.type') == 'png'

        # 任务导出 → 导入
        page.click('.nl-nav-btn[data-tab="project"]')
        page.wait_for_selector('[data-act="export"]')
        task_path = download(page, '[data-act="export"] >> nth=0')
        with page.expect_file_chooser() as fc:
            page.click('[data-act="import-task"]')
        fc.value.set_files(task_path)
        wait_log(page, '已导入任务')
        names = page.evaluate("NovelLoom.app.project.name")
        print('imported project:', names)
        assert names.endswith('（导入）')
        assert page.evaluate("Object.keys(NovelLoom.app.project.characters).length") >= 2
        browser.close()
finally:
    server.terminate()

real = [e for e in errors if 'favicon' not in e]
print('ERRORS:', json.dumps(real, ensure_ascii=False))
sys.exit(1 if real else 0)
