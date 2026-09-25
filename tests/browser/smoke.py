# 浏览器冒烟测试：模拟酒馆环境，走完 导入→分段→提取→角色→世界书写入→角色卡写入→续写→设置
import json, os, subprocess, sys, time
from playwright.sync_api import sync_playwright

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
SHOTS = sys.argv[1] if len(sys.argv) > 1 else '/tmp/nl-shots'
os.makedirs(SHOTS, exist_ok=True)
PORT = 8765

server = subprocess.Popen([sys.executable, '-m', 'http.server', str(PORT), '--bind', '127.0.0.1'], cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1)

ch1 = '第一章 魔女小姐\n' + '江酒走进酒吧。莉莉丝坐在角落，黑色长裙拖到地上。\n“没错，今晚我是来跟你提分手的。”江酒说。\n莉莉丝把一瓶紫色魔药推到他面前。\n' * 18
ch2 = '第二章 女仆\n' + '江酒穿上了女仆装。小酒在镜子前转了一圈。莉莉丝去参加魔女茶会。\n' * 22
ch3 = '第三章 下城区\n' + '姜小白在雨中迷路，走进了那家店。江酒给她倒了一杯热水。\n' * 25
NOVEL = ch1 + ch2 + ch3

errors = []
def shot(page, name):
    page.screenshot(path=os.path.join(SHOTS, name + '.png'))

def wait_log(page, text, timeout=30000):
    page.wait_for_function('(t) => [...document.querySelectorAll(".nl-log-line")].some(l => l.textContent.includes(t))', arg=text, timeout=timeout)

try:
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={'width': 1360, 'height': 900})
        page.on('pageerror', lambda e: errors.append('pageerror: ' + str(e)))
        page.on('console', lambda m: errors.append('console: ' + m.text) if m.type == 'error' else None)
        page.goto(f'http://127.0.0.1:{PORT}/tests/browser/harness.html')
        page.wait_for_selector('#nl-wand-button', timeout=10000)
        assert page.evaluate('!!window.__slash && window.__slash.name === "novelloom"'), 'slash command not registered'
        page.click('#nl-wand-button')
        page.wait_for_selector('.nl-window')
        shot(page, '01-project-empty')

        # 导入
        page.click('[data-act="paste"]')
        page.fill('.nl-dialog textarea', NOVEL)
        page.click('.nl-dialog-foot button:has-text("确定")')
        page.wait_for_selector('.nl-import-preview:not([hidden])')
        page.fill('[data-setting="chunking.chunkSize"]', '1000')
        page.dispatch_event('[data-setting="chunking.chunkSize"]', 'input')
        page.dispatch_event('[data-setting="chunking.chunkSize"]', 'change')
        page.fill('#nl-bookname', '魔女')
        page.click('[data-act="detect"]')
        page.wait_for_selector('.nl-detect .nl-ok')
        detect_text = page.inner_text('.nl-detect')
        print('detect:', detect_text.replace('\n', ' '))
        shot(page, '02-import-preview')
        page.click('[data-act="create"]')
        page.wait_for_selector('.nl-chunk')
        n_chunks = page.locator('.nl-chunk').count()
        print('chunks:', n_chunks)
        assert n_chunks >= 3, n_chunks
        shot(page, '03-chunks')

        # 提取
        page.click('.nl-nav-btn[data-tab="extract"]')
        page.click('[data-act="preview"]')
        page.wait_for_selector('.nl-dialog')
        shot(page, '04-extract-preview')
        page.click('.nl-dialog [data-close]')
        page.click('[data-act="start"]')
        wait_log(page, '提取结束')
        page.click('[data-act="log-toggle"]')
        shot(page, '05-extract-done')
        stats = page.evaluate('NovelLoom.app.project.chunks.map(c => c.status)')
        print('status:', stats)
        assert all(s == 'done' for s in stats), stats

        # 角色
        page.click('.nl-nav-btn[data-tab="characters"]')
        page.wait_for_selector('.nl-char-item')
        page.click('.nl-char-item >> nth=0')
        page.wait_for_selector('[data-f="identity"]')
        shot(page, '06-characters')
        page.fill('[data-f="notes"]', '测试备注')
        page.click('[data-act="save"]')
        assert page.evaluate('Object.values(NovelLoom.app.project.characters).some(c => c.notes === "测试备注")')

        # 世界书
        page.click('.nl-nav-btn[data-tab="worldbook"]')
        page.wait_for_selector('.nl-entry')
        shot(page, '07-worldbook')
        page.click('.nl-entry >> nth=0')
        page.wait_for_selector('.nl-dialog [data-f="content"]')
        shot(page, '08-entry-edit')
        page.click('.nl-dialog-foot button:has-text("保存")')
        page.click('[data-act="publish"]')
        page.click('.nl-dialog-foot button:has-text("确定")')
        wait_log(page, '已写入酒馆世界书')
        worlds = page.evaluate('Object.keys(window.__saved.worlds)')
        print('worlds:', worlds)
        assert '《魔女》世界书' in worlds

        # 大纲
        page.click('.nl-nav-btn[data-tab="outline"]')
        page.click('[data-act="summary"]')
        wait_log(page, '已生成故事梗概')
        page.fill('[data-mn="0"]', '莉莉丝酒吧')
        page.dispatch_event('[data-mn="0"]', 'change')
        shot(page, '09-outline')

        # 角色卡
        page.click('.nl-nav-btn[data-tab="cards"]')
        page.select_option('[data-form="charName"]', '莉莉丝')
        page.click('[data-act="generate"]')
        page.wait_for_selector('.nl-dialog [data-card="description"]', timeout=20000)
        shot(page, '10-card-editor')
        lint_text = page.inner_text('.nl-dialog [data-lint]')
        print('lint:', lint_text.replace('\n', ' | ')[:200])
        assert '破折号' in lint_text
        page.click('.nl-dialog [data-card-act="fix"]')
        page.wait_for_function('!document.querySelector(".nl-dialog [data-lint]").textContent.includes("破折号")', timeout=10000)
        page.click('.nl-dialog-foot button:has-text("保存并写入酒馆")')
        wait_log(page, '已写入酒馆：角色')
        last = page.evaluate('window.__saved.lastImport')
        card = json.loads(last['text'])
        print('imported card:', card['data']['name'], 'world=', card['data']['extensions']['world'], 'book entries=', len(card['data']['character_book']['entries']))
        assert card['data']['extensions']['world'] == '《魔女》世界书'
        assert '——' not in card['data']['first_mes']
        shot(page, '11-cards')
        # 再次写入应覆盖同一角色
        page.click('[data-act="publish"] >> nth=0')
        page.wait_for_function('window.__saved.imports.length === 2')
        assert page.evaluate('window.__saved.lastImport.preserved') == 'card_1', '再次写入应覆盖同一角色'

        # 续写
        page.click('.nl-nav-btn[data-tab="continue"]')
        page.fill('[data-setting="continuation.chapters"]', '1')
        page.dispatch_event('[data-setting="continuation.chapters"]', 'input')
        page.click('[data-act="api-start"]')
        wait_log(page, '续写结束')
        gen = page.evaluate('NovelLoom.app.project.continuation.chapters.map(c => c.title)')
        print('generated:', gen)
        assert len(gen) == 1
        shot(page, '12-continue')

        # 聊天挂机续写
        page.evaluate('''() => {
            const cg = NovelLoom.app.settings.chatgen;
            Object.assign(cg, { totalChapters: 2, currentChapter: 0, replyWaitMs: 100, stabilityCheckInterval: 100, stabilityRequiredCount: 2, minChapterLength: 50, feedbackToProject: true, autoSaveInterval: 0 });
            SillyTavern.getContext().characterId = 0;
            SillyTavern.getContext().chat.push({ is_user: false, name: '莉莉丝', mes: '开场白：欢迎光临。' });
        }''')
        page.click('.nl-nav-btn[data-tab="project"]')
        page.click('.nl-nav-btn[data-tab="continue"]')
        page.click('[data-act="cg-start"]')
        wait_log(page, '挂机续写全部完成', timeout=30000)
        chat_chunks = page.evaluate('NovelLoom.app.project.chunks.filter(c => c.origin === "chat").map(c => c.content.slice(0, 12))')
        print('chat chunks:', chat_chunks)
        assert len(chat_chunks) == 2 and all('构思' not in c for c in chat_chunks), chat_chunks
        assert chat_chunks[0] != chat_chunks[1], '两章应是不同的回复'
        assert page.evaluate('NovelLoom.app.settings.chatgen.currentChapter') == 2
        shot(page, '12b-chatgen')

        # 设置
        page.click('.nl-nav-btn[data-tab="settings"]')
        page.select_option('[data-setting="api.mode"]', 'profile')
        page.select_option('[data-setting="api.profileId"]', 'p1')
        page.click('[data-act="test"][data-key="api"]')
        page.wait_for_selector('[data-test-result="api"] .nl-ok', timeout=10000)
        shot(page, '13-settings')

        # 项目页概览
        page.click('.nl-nav-btn[data-tab="project"]')
        page.wait_for_selector('.nl-stats')
        shot(page, '14-project')

        # 窄屏
        page.set_viewport_size({'width': 390, 'height': 844})
        page.click('.nl-nav-btn[data-tab="cards"]')
        shot(page, '15-mobile-cards')
        page.click('.nl-nav-btn[data-tab="characters"]')
        shot(page, '16-mobile-characters')

        # 最小化 / 关闭
        page.click('[data-act="minimize"]')
        assert page.is_visible('#nl-fab')
        page.click('#nl-fab')
        page.click('[data-act="close"]')
        assert page.locator('#nl-root').count() == 0
        browser.close()
finally:
    server.terminate()

real_errors = [e for e in errors if 'favicon' not in e]
print('ERRORS:', json.dumps(real_errors, ensure_ascii=False, indent=1))
sys.exit(1 if real_errors else 0)
