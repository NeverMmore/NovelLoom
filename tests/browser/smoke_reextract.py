# 浏览器冒烟测试（重新提取 / 批量删除角色）：角色页多选删除、提取页「重新提取…」、分段页多选「提取所选」先清后提
import json, os, subprocess, sys, time
from playwright.sync_api import sync_playwright

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
OUT = sys.argv[1] if len(sys.argv) > 1 else '/tmp/nl-reextract'
os.makedirs(OUT, exist_ok=True)
PORT = 8775
server = subprocess.Popen([sys.executable, '-m', 'http.server', str(PORT), '--bind', '127.0.0.1'], cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1)

# 四章，每章约 700 字；每段最大 1000 字 → 每章一段，共 4 段
ch1 = '第一章 魔女小姐\n' + '江酒走进酒吧。莉莉丝坐在角落，黑色长裙拖到地上。\n“没错，今晚我是来跟你提分手的。”江酒说。\n莉莉丝把一瓶紫色魔药推到他面前。\n' * 11
ch2 = '第二章 女仆\n' + '江酒穿上了女仆装。小酒在镜子前转了一圈。莉莉丝去参加魔女茶会。\n' * 22
ch3 = '第三章 下城区\n' + '姜小白在雨中迷路，走进了那家店。江酒给她倒了一杯热水。\n' * 25
ch4 = '第四章 茶会\n' + '莉莉丝从茶会回来，带回一包新的魔药。江酒在吧台后面擦杯子。\n' * 22
NOVEL = ch1 + ch2 + ch3 + ch4
errors = []

def shot(page, name):
    # 对话框有淡入动画：等它完全显示再截图，免得截到透明的半成品
    page.wait_for_function('() => [...document.querySelectorAll(".nl-dialog-overlay, .nl-dialog")].every((d) => getComputedStyle(d).opacity === "1")')
    page.screenshot(path=os.path.join(OUT, name + '.png'))

def wait_log(page, text, timeout=30000):
    page.wait_for_function('(t) => [...document.querySelectorAll(".nl-log-line")].some(l => l.textContent.includes(t))', arg=text, timeout=timeout)

def count_log(page, text):
    return page.evaluate('(t) => [...document.querySelectorAll(".nl-log-line")].filter((l) => l.textContent.includes(t)).length', text)

def wait_log_count(page, text, n, timeout=60000):
    """等到包含 text 的日志行多于 n 条（n 在触发操作之前记下，避免命中旧日志）"""
    page.wait_for_function(
        '(a) => [...document.querySelectorAll(".nl-log-line")].filter((l) => l.textContent.includes(a[0])).length > a[1]',
        arg=[text, n],
        timeout=timeout,
    )

def ev(page, js, arg=None):
    return page.evaluate(js, arg) if arg is not None else page.evaluate(js)

def statuses(page):
    return ev(page, 'NovelLoom.app.project.chunks.map((c) => c.status)')

def char_names(page):
    return sorted(ev(page, 'Object.keys(NovelLoom.app.project.characters)'))

def exp_counts(page):
    """所有角色的经历按出处分段计数：{分段序号: 条数}"""
    return ev(page, '''() => {
        const m = {};
        for (const c of Object.values(NovelLoom.app.project.characters)) for (const e of c.experiences) m[e.chunk] = (m[e.chunk] || 0) + 1;
        return m;
    }''')

def exps_of(page, name):
    return ev(page, '(n) => (NovelLoom.app.project.characters[n]?.experiences || []).map((e) => [e.chunk, e.text])', name)

def snapshot_labels(page):
    return ev(page, 'async () => (await (await import("/src/store.js")).listSnapshots(NovelLoom.app.project.id)).map((s) => s.label)')

def extract_prompts(page):
    return ev(page, '(window.__prompts || []).filter((t) => t.includes("<source>")).length')

def char_rows(page):
    return ev(page, '[...document.querySelectorAll("#nl-tab .nl-char-list .nl-char-item")].map((r) => r.dataset.name)')

try:
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={'width': 1360, 'height': 900})
        page.on('pageerror', lambda e: errors.append('pageerror: ' + str(e)))
        page.on('console', lambda m: errors.append('console: ' + m.text) if m.type == 'error' else None)
        page.goto(f'http://127.0.0.1:{PORT}/tests/browser/harness.html')
        page.wait_for_selector('#nl-wand-button')
        # 模拟 AI 每次措辞不同：给提取结果里的“经历”打上本轮标记。
        # 若重新提取前没有清掉旧资料，同一段就会同时留下旧、新两条经历（真实 AI 的情况），下面的计数会发现
        ev(page, '''() => {
            const ctx = SillyTavern.getContext();
            const orig = ctx.generateRaw;
            ctx.generateRaw = async function (o) {
                const r = await orig.call(this, o);
                return window.__expTag && typeof r === 'string' ? r.split('的经历').join('的经历·' + window.__expTag) : r;
            };
        }''')
        page.evaluate("NovelLoom.open('project')")
        page.wait_for_selector('.nl-window')

        # ---- 导入 + 首次提取 ----
        page.click('[data-act="paste"]')
        page.fill('.nl-dialog textarea', NOVEL)
        page.click('.nl-dialog-foot button:has-text("确定")')
        page.wait_for_selector('.nl-import-preview:not([hidden])')
        page.fill('[data-setting="chunking.chunkSize"]', '1000')
        page.dispatch_event('[data-setting="chunking.chunkSize"]', 'input')
        page.dispatch_event('[data-setting="chunking.chunkSize"]', 'change')
        page.fill('#nl-bookname', '魔女')
        page.click('[data-act="create"]')
        page.wait_for_selector('.nl-chunk')
        n_chunks = ev(page, 'NovelLoom.app.project.chunks.length')
        print('chunks:', n_chunks, ev(page, 'NovelLoom.app.project.chunks.map((c) => c.title + ":" + c.charCount)'))
        assert n_chunks == 4, n_chunks

        page.click('.nl-nav-btn[data-tab="extract"]')
        assert page.is_disabled('#nl-tab [data-act="reextract"]'), '还没提取过时「重新提取…」应不可用'
        page.click('#nl-tab [data-act="start"]')
        wait_log(page, '提取结束', timeout=60000)
        assert all(s == 'done' for s in statuses(page)), statuses(page)
        names0 = char_names(page)
        print('characters after first extraction:', names0)
        assert names0 == sorted(['江酒', '莉莉丝', '姜小白']), names0
        print('江酒 experiences:', exps_of(page, '江酒'))

        # ---- (a) 角色页：多选 → 勾选 2 个 → 删除 ----
        page.click('.nl-nav-btn[data-tab="characters"]')
        page.wait_for_selector('#nl-tab .nl-char-item')
        assert page.is_hidden('#nl-tab .nl-char-selbar'), '未进入多选时选择栏应隐藏'
        tog = '#nl-tab [data-act="toggle-select"]'
        page.click(tog)
        assert page.inner_text(tog).strip() == '退出多选' and page.get_attribute(tog, 'aria-pressed') == 'true'
        page.wait_for_selector('#nl-tab .nl-char-selbar:not([hidden])')
        assert page.locator('#nl-tab .nl-char-item .nl-chk').count() == 3
        assert page.is_disabled('#nl-tab [data-act="delete-selected"]'), '一个都没选时删除按钮应不可用'

        # Esc 只退出多选，不最小化窗口
        page.keyboard.press('Escape')
        page.wait_for_selector('#nl-tab .nl-char-selbar[hidden]', state='attached')
        assert page.inner_text(tog).strip() == '多选'
        assert page.is_visible('.nl-window') and not page.is_visible('#nl-fab'), '多选时按 Esc 不应最小化窗口'

        page.click(tog)
        page.click('#nl-tab .nl-char-item[data-name="莉莉丝"]')
        page.click('#nl-tab .nl-chk[data-name="姜小白"]')
        assert page.locator('#nl-tab [data-f="identity"]').count() == 0, '多选时点击行不应打开角色详情'
        assert ev(page, '[...document.querySelectorAll("#nl-tab .nl-char-item.active")].map((r) => r.dataset.name).sort()') == sorted(['莉莉丝', '姜小白'])
        sel_text = page.inner_text('#nl-tab .nl-char-selcount')
        del_text = page.inner_text('#nl-tab .nl-char-dellabel')
        print('selbar:', sel_text, '|', del_text)
        assert '已选 2 个角色' in sel_text and del_text == '删除所选（2）', (sel_text, del_text)
        shot(page, '01-characters-selected')

        # 取消确认框：什么都不删，仍保持勾选
        page.click('#nl-tab [data-act="delete-selected"]')
        page.wait_for_selector('.nl-dialog[aria-label="删除 2 个角色"]')
        dlg = page.inner_text('.nl-dialog-body')
        assert '莉莉丝' in dlg and '姜小白' in dlg and '快照' in dlg, dlg
        shot(page, '02-characters-delete-confirm')
        page.click('.nl-dialog-foot button:has-text("取消")')
        page.wait_for_selector('.nl-dialog', state='detached')
        assert char_names(page) == names0, '取消后不应删除任何角色'
        assert page.inner_text('#nl-tab .nl-char-dellabel') == '删除所选（2）'

        snaps_before = len(snapshot_labels(page))
        page.click('#nl-tab [data-act="delete-selected"]')
        page.click('.nl-dialog-foot button:has-text("删除 2 个角色")')
        wait_log(page, '已删除 2 个角色')
        assert char_names(page) == ['江酒'], char_names(page)
        page.wait_for_function('document.querySelectorAll("#nl-tab .nl-char-list .nl-char-item").length === 1')
        assert char_rows(page) == ['江酒'], char_rows(page)
        assert page.inner_text('#nl-tab .nl-char-count').strip() == '1 / 1', page.inner_text('#nl-tab .nl-char-count')
        assert page.inner_text(tog).strip() == '多选', '删除后应退出多选'
        assert page.is_hidden('#nl-tab .nl-char-selbar')
        labels = snapshot_labels(page)
        assert len(labels) == snaps_before + 1 and '批量删除 2 个角色前' in labels, labels
        shot(page, '03-characters-deleted')

        # ---- (b) 提取页：重新提取…（从第 2 段起）----
        page.click('.nl-nav-btn[data-tab="extract"]')
        page.wait_for_selector('#nl-tab [data-act="reextract"]')
        assert not page.is_disabled('#nl-tab [data-act="reextract"]')
        page.click('#nl-tab [data-act="reextract"]')
        page.wait_for_selector('.nl-dialog[aria-label="重新提取"]')
        count_sel = '.nl-dialog [data-reex-count]'
        print('reextract default:', page.inner_text(count_sel))
        assert '将重置 4 段' in page.inner_text(count_sel)
        assert page.is_checked('.nl-dialog input[name="nl-reex-scope"][value="all"]')
        page.select_option('.nl-dialog select[data-f="from"]', '1')
        assert page.is_checked('.nl-dialog input[name="nl-reex-scope"][value="from"]'), '选了起始段后应切到「从…起」'
        count_text = page.inner_text(count_sel)
        print('reextract from #2:', count_text)
        assert '将重置 3 段（其中 3 段已提取过）' in count_text, count_text
        shot(page, '04-reextract-dialog')

        ev(page, "window.__expTag = 'v2'")
        n_end = count_log(page, '提取结束')
        prompts_before = extract_prompts(page)
        page.click('.nl-dialog-foot button:has-text("重新提取")')
        wait_log_count(page, '提取结束', n_end)
        wait_log(page, '已清除第 2 段起 3 段的提取结果')
        st = statuses(page)
        print('status after reextract:', st)
        assert all(s == 'done' for s in st), st
        assert extract_prompts(page) - prompts_before == 3, '只应重新提取第 2～4 段'
        names_b = char_names(page)
        print('characters after reextract:', names_b)
        assert names_b == sorted(['江酒', '莉莉丝', '姜小白']), names_b
        assert sorted(ev(page, 'NovelLoom.app.project.characters["莉莉丝"].chunksSeen')) == [1, 3]
        exps = exps_of(page, '江酒')
        print('江酒 experiences after reextract:', exps)
        assert [c for c, _ in exps] == [0, 1, 2, 3], '每段应只有一条经历（旧的已清除）'
        assert '·v2' not in exps[0][1], '第 1 段没有重新提取，经历应保持原样'
        assert all(t.endswith('·v2') for c, t in exps[1:]), exps
        assert '重新提取前' in snapshot_labels(page)
        page.wait_for_selector('#nl-tab [data-act="start"]:has-text("继续提取")')
        shot(page, '05-reextract-done')

        # ---- (c) 分段页：多选 → 选 1 个已完成的段 → 提取所选 ----
        page.click('.nl-nav-btn[data-tab="chunks"]')
        page.wait_for_selector('#nl-tab .nl-chunk')
        page.click('#nl-tab [data-act="toggle-select"]')
        page.wait_for_selector('#nl-tab .nl-chk')
        # 没勾选时只提示
        page.click('#nl-tab [data-act="extract-selected"]')
        wait_log(page, '请先勾选要处理的分段')
        assert page.locator('.nl-dialog').count() == 0

        target = ev(page, 'NovelLoom.app.project.chunks[2].id')
        assert ev(page, 'NovelLoom.app.project.chunks[2].status') == 'done'
        page.check(f'#nl-tab .nl-chk[data-id="{target}"]')
        before = exp_counts(page)
        before_exps = exps_of(page, '江酒')
        print('experiences per chunk before:', before)

        # 取消：什么都不变
        page.click('#nl-tab [data-act="extract-selected"]')
        page.wait_for_selector('.nl-dialog[aria-label="清除已提取的资料"]')
        dlg = page.inner_text('.nl-dialog-body')
        print('chunks confirm:', dlg.split('\n')[0])
        assert '所选 1 段中有 1 段已经提取过资料' in dlg and '世界书 → 修改历史' in dlg, dlg
        shot(page, '06-chunks-confirm')
        page.click('.nl-dialog-foot button:has-text("取消")')
        page.wait_for_selector('.nl-dialog', state='detached')
        assert ev(page, 'NovelLoom.app.project.chunks[2].status') == 'done'
        assert exps_of(page, '江酒') == before_exps, '取消后资料不应改变'

        ev(page, "window.__expTag = 'v3'")
        n_end = count_log(page, '提取结束')
        prompts_before = extract_prompts(page)
        page.click('#nl-tab [data-act="extract-selected"]')
        page.click('.nl-dialog-foot button:has-text("清除并重新提取")')
        wait_log_count(page, '提取结束', n_end)
        page.wait_for_selector('.nl-tab-body[data-tab="extract"]')
        after = exp_counts(page)
        after_exps = exps_of(page, '江酒')
        print('experiences per chunk after: ', after)
        print('江酒 experiences after:', after_exps)
        assert after == before, f'经历条数不应变化（不重复）：{before} → {after}'
        assert extract_prompts(page) - prompts_before == 1, '只应重新提取所选的 1 段'
        assert [t for c, t in after_exps if c == 2] == ['第三章 下城区的经历·v3'], after_exps
        assert [x for x in after_exps if x[0] != 2] == [x for x in before_exps if x[0] != 2], '其他分段的经历不应改变'
        assert all(s == 'done' for s in statuses(page)), statuses(page)
        assert '姜小白' in char_names(page), '只出自这一段的角色应被重新提取出来'
        assert '重新提取所选前' in snapshot_labels(page)
        shot(page, '07-chunks-reextracted')

        page.set_viewport_size({'width': 390, 'height': 844})
        page.click('.nl-nav-btn[data-tab="extract"]')
        page.click('#nl-tab [data-act="reextract"]')
        page.wait_for_selector('.nl-dialog[aria-label="重新提取"]')
        shot(page, '08-mobile-reextract-dialog')
        page.click('.nl-dialog-foot button:has-text("取消")')
        browser.close()
finally:
    server.terminate()

real = [e for e in errors if 'favicon' not in e]
print('ERRORS:', json.dumps(real, ensure_ascii=False))
sys.exit(1 if real else 0)
