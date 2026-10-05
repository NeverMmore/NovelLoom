# 浏览器冒烟测试（人物关系图谱）：手动增删改、AI 分析、类型/时间点筛选、图谱节点聚焦、导出导入、关系模板（管理、套用、AI 分析参考）
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

def settle(page):
    # 对话框有淡入动画：截图前等动画播完
    page.wait_for_function('document.getAnimations().every((a) => a.playState !== "running" || a.effect?.getComputedTiming().endTime === Infinity)')

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
        # 关系类型是带候选的文本框：填已知类型的名字时存成它的 value
        page.fill('.nl-dialog input[data-f="type"]', '爱慕/恋人')
        page.uncheck('.nl-dialog [data-f="mutual"]')
        page.fill('.nl-dialog [data-f="label"]', '曾经的恋人')
        ok_dialog(page, '保存')
        wait_log(page, '已添加关系')
        page.wait_for_selector('.nl-rel-svg circle')
        assert page.locator('.nl-table tbody tr').count() == 1
        assert '曾经的恋人' in page.inner_text('.nl-table')
        assert ev(page, 'NovelLoom.app.project.relationships[0].type') == 'romantic'
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

        # 关系模板：新增模板（扩展设置里保存）
        assert ev(page, 'NovelLoom.app.settings.relationTemplates.length') == 0
        assert '关系模板' not in (page.get_attribute('[data-act="analyze"]', 'title') or '')
        saved_before = ev(page, 'window.__settingsSaved || 0')
        page.click('[data-act="manage-templates"]')
        page.wait_for_selector('.nl-dialog [data-rt-new-name]')
        assert '还没有关系模板' in page.inner_text('.nl-dialog')
        page.fill('.nl-dialog [data-rt-new-name]', '青梅竹马')
        page.fill('.nl-dialog [data-rt-new-type]', '朋友')
        page.check('.nl-dialog [data-rt-new-mutual]')
        page.fill('.nl-dialog [data-rt-new-label]', '{A}和{B}从小一起长大')
        page.click('.nl-dialog [data-rt-add]')
        page.wait_for_selector('.nl-dialog tr[data-rtpl]')
        tpls = ev(page, 'NovelLoom.app.settings.relationTemplates')
        print('relation templates:', json.dumps(tpls, ensure_ascii=False))
        assert len(tpls) == 1, tpls
        tpl = tpls[0]
        assert tpl['name'] == '青梅竹马' and tpl['type'] == 'friend' and tpl['mutual'] is True and tpl['label'] == '{A}和{B}从小一起长大', tpl
        assert ev(page, 'window.__settingsSaved || 0') > saved_before, '新增模板后应保存扩展设置'
        assert page.input_value(f'.nl-dialog tr[data-rtpl="{tpl["id"]}"] [data-rt-name]') == '青梅竹马'
        assert page.input_value(f'.nl-dialog tr[data-rtpl="{tpl["id"]}"] [data-rt-label]') == '{A}和{B}从小一起长大'
        settle(page)
        shot(page, '06-templates-dialog')
        ok_dialog(page, '关闭')
        page.wait_for_function('!document.querySelector(".nl-dialog")')
        analyze_title = page.get_attribute('[data-act="analyze"]', 'title') or ''
        assert '会参考你的 1 个关系模板' in analyze_title, analyze_title

        # 添加关系时套用模板：类型/方向/说明被填好，{A}/{B} 换成所选角色；改角色 B 时说明跟着更新
        page.click('[data-act="add"]')
        page.wait_for_selector('.nl-dialog select[data-f="template"]')
        page.wait_for_selector('.nl-dialog input[data-f="type"]')
        page.select_option('.nl-dialog select[data-f="from"]', '莉莉丝')
        page.select_option('.nl-dialog select[data-f="to"]', '江酒')
        page.fill('.nl-dialog input[data-f="type"]', '敌对')
        page.uncheck('.nl-dialog [data-f="mutual"]')
        page.select_option('.nl-dialog select[data-f="template"]', label='青梅竹马')
        assert page.input_value('.nl-dialog input[data-f="type"]') == '朋友'
        assert page.is_checked('.nl-dialog [data-f="mutual"]')
        assert page.input_value('.nl-dialog [data-f="label"]') == '莉莉丝和江酒从小一起长大', page.input_value('.nl-dialog [data-f="label"]')
        page.select_option('.nl-dialog select[data-f="to"]', '姜小白')
        assert page.input_value('.nl-dialog [data-f="label"]') == '莉莉丝和姜小白从小一起长大', page.input_value('.nl-dialog [data-f="label"]')
        shot(page, '07-apply-template')
        ok_dialog(page, '保存')
        wait_log(page, '已添加关系：莉莉丝 ↔ 姜小白')
        stored = ev(page, "NovelLoom.app.project.relationships.filter((r) => r.from === '莉莉丝' && r.to === '姜小白')")
        print('relationship from template:', json.dumps(stored, ensure_ascii=False))
        assert len(stored) == 1, stored
        assert stored[0]['type'] == 'friend' and stored[0]['mutual'] is True and stored[0]['label'] == '莉莉丝和姜小白从小一起长大' and not stored[0]['auto'], stored
        assert '莉莉丝和姜小白从小一起长大' in page.inner_text('.nl-table')

        # AI 分析关系：提示词里带上用户的关系模板
        n_logs = ev(page, '[...document.querySelectorAll(".nl-log-line")].filter((l) => l.textContent.includes("AI 分析关系：")).length')
        page.evaluate('window.__prompts = []')
        page.click('[data-act="analyze"]')
        page.wait_for_function('(n) => [...document.querySelectorAll(".nl-log-line")].filter((l) => l.textContent.includes("AI 分析关系：")).length > n', arg=n_logs, timeout=20000)
        rel_prompts = ev(page, 'window.__prompts.filter((p) => p.includes("梳理角色之间已经明确建立的关系"))')
        assert rel_prompts, '没有发出 AI 分析关系的请求'
        rel_prompt = rel_prompts[-1]
        assert '青梅竹马' in rel_prompt and '从小一起长大' in rel_prompt, rel_prompt[-1500:]
        print('analyze prompt includes relation template')
        assert ev(page, "NovelLoom.app.project.relationships.some((r) => r.from === '莉莉丝' && r.to === '姜小白' && r.label === '莉莉丝和姜小白从小一起长大')"), '分析后手动套用模板的关系应保留'

        # 窄屏下的模板对话框：表格在对话框里横向滚动，页面本身不横向滚动；随后删除模板
        page.set_viewport_size({'width': 390, 'height': 844})
        page.click('[data-act="manage-templates"]')
        page.wait_for_selector('.nl-dialog tr[data-rtpl]')
        overflow = ev(page, '({ doc: document.documentElement.scrollWidth, win: window.innerWidth, dlg: document.querySelector(".nl-dialog").getBoundingClientRect().right })')
        print('mobile template dialog widths:', overflow)
        assert overflow['doc'] <= overflow['win'] and overflow['dlg'] <= overflow['win'] + 1, overflow
        settle(page)
        shot(page, '08-templates-mobile')
        page.click(f'.nl-dialog tr[data-rtpl="{tpl["id"]}"] [data-rt-del]')
        page.click('.nl-dialog-foot button:has-text("删除")')
        page.wait_for_function('[...document.querySelectorAll(".nl-dialog")].some((d) => d.textContent.includes("还没有关系模板"))')
        assert ev(page, 'NovelLoom.app.settings.relationTemplates.length') == 0
        ok_dialog(page, '关闭')
        page.wait_for_function('!document.querySelector(".nl-dialog")')
        assert '关系模板' not in (page.get_attribute('[data-act="analyze"]', 'title') or '')
        page.click('[data-act="add"]')
        page.wait_for_selector('.nl-dialog select[data-f="from"]')
        assert page.locator('.nl-dialog [data-f="template"]').count() == 0, '没有模板时不应显示「套用模板」'
        ok_dialog(page, '取消')
        page.wait_for_function('!document.querySelector(".nl-dialog")')

        # 窄屏
        page.set_viewport_size({'width': 390, 'height': 844})
        shot(page, '05-mobile')
        browser.close()
finally:
    server.terminate()

real = [e for e in errors if 'favicon' not in e]
print('ERRORS:', json.dumps(real, ensure_ascii=False))
sys.exit(1 if real else 0)
