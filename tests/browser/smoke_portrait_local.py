# 浏览器冒烟测试（立绘：选择本地图片，v0.13）：「立绘」分页的存法切换（酒馆服务器 / 嵌进卡片，记在扩展设置里）→
# 酒馆服务器：原样上传小图、超过 2048 的大图重新编码成 webp，文件名是内容哈希、文件夹是卡片名，存根相对地址 /user/images/…（逐段编码）→
# 嵌进卡片：压缩到 512px 的 webp，不超过单张上限 → 两种存法互相转换（说明、解锁条件、顺序不变）→ 图池的取值 / 兜底选择本地图片、拖放、批量转换 →
# 文件类型错误、上传失败（500 / 连不上）时就地提示并可以改成嵌进卡片 → 预览里酒馆图片换成父页面取来的 data:image，换一张记的仍是原路径 / 内嵌图片的短 id，
# 重新载入后还在 → 「导出」「立绘」分页的分享提示、存模板时的提醒 → 导出的正则里是原路径，没有预览用的 data:image →
# 处理完焦点回到按钮上、读屏播报结果 → 拖到对话框边上不漏给酒馆 → 图池缩略图逐行删除（文本框改过还没重绘时按内容找那一行）→
# 处理期间的锁（转换时不能再选图 / 转换，文本框里新加的行不被旧副本冲掉）→ 处理期间删掉前面的角色，结果和重试仍在原来那个角色下 →
# 处理期间关掉对话框不再写回 → 手填的图库路径（中文、带 @）规范化、预览不替它去读 → GIF 太大转成静态图时提示 → 「全部改成内嵌」
# 用法：PYTHONIOENCODING=utf-8 python tests/browser/smoke_portrait_local.py <截图目录>
import base64, json, os, re, struct, subprocess, sys, time, urllib.parse, zlib
from playwright.sync_api import sync_playwright

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
SHOTS = sys.argv[1] if len(sys.argv) > 1 else '/tmp/nl-portrait-local'
os.makedirs(SHOTS, exist_ok=True)
PORT = 8780
server = subprocess.Popen([sys.executable, '-m', 'http.server', str(PORT), '--bind', '127.0.0.1'], cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1)

NOVEL = '\n'.join([
    '第一章 魔女小姐', '江酒走进酒吧。莉莉丝坐在角落，黑色长裙拖到地上。', '“没错，今晚我是来跟你提分手的。”江酒说。', '莉莉丝把一瓶紫色魔药推到他面前。\n' * 8,
    '第二章 女仆', '江酒穿上了女仆装。', '“挺合身。”莉莉丝说，“明天开始打扫阁楼。”', '他叹了口气，拎起扫帚上楼。楼梯吱呀作响。\n' * 8,
])
CARD_NAME = '魔女旁白'
FOLDER = '/user/images/' + urllib.parse.quote(CARD_NAME, safe='') + '/'
SERVER_RE = re.compile(r'^' + re.escape(FOLDER) + r'nl_[0-9a-f]{16}\.(png|webp|jpg)$')
DATA_LIMIT = 131072


def png(w, h, seed):
    """生成一张 w×h 的 RGB PNG（横向渐变 + 16 条色带，压缩后很小）"""
    def chunk(t, d):
        return struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)
    bands = []
    for b in range(16):
        row = bytearray([0])
        for x in range(w):
            row += bytes(((x * 255 // max(1, w - 1) + seed * 40) % 256, (b * 16 + seed * 30) % 256, (seed * 90 + 60) % 256))
        bands.append(bytes(row))
    raw = b''.join(bands[min(15, y * 16 // h)] for y in range(h))
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(raw, 6)) + chunk(b'IEND', b'')


def gif(w, h):
    """w×h 的单色 GIF：不压缩的 LZW（每两个像素插一个清空码，码长一直是 3 位）"""
    codes = []
    for i in range(w * h):
        if i % 2 == 0:
            codes.append(4)  # 清空码
        codes.append(1)      # 调色板第 1 色
    codes.append(5)          # 结束码
    out, bits, nbits = bytearray(), 0, 0
    for c in codes:
        bits |= c << nbits
        nbits += 3
        while nbits >= 8:
            out.append(bits & 0xff)
            bits >>= 8
            nbits -= 8
    if nbits:
        out.append(bits & 0xff)
    blocks = b''.join(bytes([len(out[i:i + 255])]) + bytes(out[i:i + 255]) for i in range(0, len(out), 255))
    head = b'GIF89a' + struct.pack('<HHBBB', w, h, 0xF1, 0, 0) + bytes([0, 0, 0, 200, 80, 120, 255, 255, 255, 0, 0, 255])
    return head + b'\x2c' + struct.pack('<HHHHB', 0, 0, w, h, 0) + bytes([2]) + blocks + b'\x00\x3b'


SMALL = png(64, 64, 1)       # 原样上传（png）
WIDE = png(2600, 1400, 2)    # 最长边超过 2048：重新编码成 webp（最长边 1600）
TALL = png(1200, 1600, 3)    # 嵌进卡片：缩到 384×512
OTHER = png(80, 120, 4)      # 上传失败 / 改成嵌进卡片用
DROP = png(90, 60, 5)        # 拖放
BIG_GIF = gif(2100, 2)       # 最长边超过 2048 的 GIF：存到酒馆时重新编码成静态 webp（要提示）

errors = []
served = {}      # 上传到「酒馆」的文件：未编码的路径 → 字节（GET /user/images/** 从这里取）
image_hits = []  # GET /user/images/** 的请求（解码后的路径）
fetch_hits = []  # 其中由脚本 fetch 发起的（父页面读图：预览替换、改成内嵌），不含缩略图 <img>
expect_404 = []  # 预期会 404 的文件名（控制台的「Failed to load resource」不算错误）


def f(name, data, mime='image/png'):
    return {'name': name, 'mimeType': mime, 'buffer': data}


def shot(page, name):
    page.wait_for_timeout(300)
    page.screenshot(path=os.path.join(SHOTS, name + '.png'))


def wait_log(page, text, timeout=30000):
    page.wait_for_function('(t) => [...document.querySelectorAll(".nl-log-line")].some(l => l.textContent.includes(t))', arg=text, timeout=timeout)


def ev(page, js, arg=None):
    return page.evaluate(js, arg) if arg is not None else page.evaluate(js)


def top(page):
    return page.locator('.nl-dialog-overlay').last


def step(msg):
    print('==', msg, flush=True)


def sbar(page):
    return ev(page, 'NovelLoom.app.project.cards[0].statusBar')


def pts(page):
    return sbar(page)['portraits']


def urls_of(page, name):
    return [i['url'] for i in pts(page)['characters'].get(name, [])]


def frame(page):
    return page.frame_locator('iframe[data-sb-frame]')


def poll(fn, expect, what, timeout=10000):
    deadline = time.time() + timeout / 1000
    last = None
    while time.time() < deadline:
        try:
            last = fn()
            if (expect(last) if callable(expect) else last == expect):
                return last
        except Exception as e:
            last = 'ERR ' + str(e).split('\n')[0]
        time.sleep(0.15)
    raise AssertionError(f'{what}：实际 {str(last)[:200]!r}')


def tab(page, name):
    page.click(f'[data-act="sb-tab"][data-tab="{name}"]')
    page.wait_for_selector(f'[data-act="sb-tab"][data-tab="{name}"].active')


def open_sb_dialog(page):
    page.click('.nl-cardbox [data-act="statusbar"]')
    page.wait_for_selector('.nl-sb-tabs')


def close_dialog(page):
    top(page).locator('.nl-dialog-foot button:has-text("关闭")').click()
    page.wait_for_selector('.nl-dialog-overlay', state='detached')


def pick(page, target, files):
    with page.expect_file_chooser() as fc:
        page.click(f'[data-act="sb-pt-pick"][data-sb-pt-target="{target}"]')
    assert fc.value.is_multiple(), '可以多选'
    fc.value.set_files(files)


def local_msg(page, target):
    return page.locator(f'[data-sb-pt-local="{target}"]').inner_text(timeout=2000)


def wait_local(page, target, text, timeout=20000):
    page.wait_for_function('([t, x]) => { const el = document.querySelector(`[data-sb-pt-local="${t}"]`); return !!el && el.textContent.includes(x); }', arg=[target, text], timeout=timeout)


def set_store(page, mode):
    page.click(f'[data-act="sb-pt-store"][data-sb-val="{mode}"]')
    page.wait_for_selector(f'[data-sb-pt-store="{mode}"]')
    assert ev(page, 'NovelLoom.app.settings.statusBar.portraitStore') == mode


def img_info(page, url):
    """在页面里解码一张图（data: 地址或上传的 base64）：[宽, 高, 类型]"""
    return ev(page, 'async (u) => { const b = await (await fetch(u)).blob(); const bm = await createImageBitmap(b); return [bm.width, bm.height, b.type]; }', url)


def on_upload(path, b64):
    served[path] = base64.b64decode(b64)


def user_images(route):
    path = urllib.parse.unquote(urllib.parse.urlparse(route.request.url).path)
    image_hits.append(path)
    if route.request.resource_type in ('fetch', 'xhr'):
        fetch_hits.append(path)
    body = served.get(path)
    if body is None:
        route.fulfill(status=404, content_type='text/plain', body='missing')
        return
    ext = path.rsplit('.', 1)[-1].lower()
    route.fulfill(status=200, content_type={'png': 'image/png', 'webp': 'image/webp', 'jpg': 'image/jpeg'}.get(ext, 'application/octet-stream'), body=body)


def img_host(route):
    """手填的图床地址（https://img.example.com/…）：给一张小图，缩略图和预览里不会报错"""
    route.fulfill(status=200, content_type='image/png', body=SMALL)


def on_console(m):
    if m.type != 'error':
        return
    url = (m.location or {}).get('url', '')
    if 'status of 404' in m.text and any(x in urllib.parse.unquote(url) for x in expect_404):
        return
    errors.append('console: ' + m.text)


def active_matches(page, sel):
    return ev(page, '(s) => !!document.activeElement && document.activeElement.matches(s)', sel)


def live_text(page):
    return ev(page, "() => document.querySelector('.nl-dialog-overlay .nl-sr-only[role=status]')?.textContent || ''")


def hold(page, what):
    """让上传（upload）或读酒馆图片（image）卡住，直到 release"""
    ev(page, f"() => {{ window.__{what}Gate = new Promise((r) => {{ window.__{what}Release = r; }}); }}")


def release(page, what):
    ev(page, f"() => {{ const r = window.__{what}Release; window.__{what}Gate = null; window.__{what}Release = null; r && r(); }}")


def cdn(route):
    url = route.request.url
    route.fulfill(status=200, content_type='text/css' if url.endswith('.css') else 'application/javascript', body='')


try:
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={'width': 1360, 'height': 900})
        page.on('pageerror', lambda e: errors.append('pageerror: ' + str(e)))
        page.on('console', on_console)
        page.route('**/testingcf.jsdelivr.net/**', cdn)
        page.route('**/user/images/**', user_images)
        page.route('https://img.example.com/**', img_host)
        page.expose_function('__onUpload', on_upload)
        page.goto(f'http://127.0.0.1:{PORT}/tests/browser/harness.html')
        page.wait_for_selector('#nl-wand-button')
        page.evaluate("NovelLoom.open('project')")
        page.wait_for_selector('.nl-window')

        step('准备：导入 + 提取 + 写世界卡（带状态栏）')
        page.click('[data-act="paste"]')
        page.fill('.nl-dialog textarea', NOVEL)
        page.click('.nl-dialog-foot button:has-text("确定")')
        page.fill('#nl-bookname', '魔女')
        page.click('[data-act="create"]')
        page.wait_for_selector('.nl-chunk')
        page.click('.nl-nav-btn[data-tab="extract"]')
        page.click('[data-act="start"]')
        wait_log(page, '提取结束', timeout=60000)
        page.click('.nl-nav-btn[data-tab="cards"]')
        page.wait_for_selector('[data-act="generate"]')
        page.select_option('[data-form="kind"]', 'world')
        # 世界卡的卡名不用 AI 写的 name：在「卡名」里填（留空时是书名「魔女」）
        page.fill('[data-form="cardName"]', CARD_NAME)
        page.click('details:has(> summary:has-text("写卡选项")) > summary')
        page.check('[data-setting="cards.statusBar"]')
        page.click('[data-act="generate"]')
        page.wait_for_selector('.nl-dialog-overlay .nl-dialog-head:has-text("编辑角色卡")', timeout=30000)
        top(page).locator('.nl-dialog-foot button:has-text("取消")').click()
        page.wait_for_selector('.nl-dialog-overlay', state='detached')
        card_id = ev(page, 'NovelLoom.app.project.cards[0].id')
        assert ev(page, 'NovelLoom.app.project.cards[0].data.name') == CARD_NAME
        assert [v['path'] for v in sbar(page)['spec']['variables']] == ['世界.时间', '世界.地点', '主角.身份', '主要角色', 'NPC']

        step('存法切换：默认酒馆服务器，改成嵌进卡片后记在扩展设置里（关掉对话框再打开还在）')
        assert ev(page, 'NovelLoom.app.settings.statusBar.portraitStore') == 'server'
        open_sb_dialog(page)
        tab(page, 'portraits')
        page.wait_for_selector('[data-sb-pt-store="server"]')
        assert page.get_attribute('[data-act="sb-pt-store"][data-sb-val="server"]', 'aria-pressed') == 'true'
        store_text = page.locator('[data-sb-pt-store]').inner_text()
        print('store bar:', store_text.replace('\n', ' | '))
        assert '本地图片存到' in store_text and '酒馆服务器' in store_text and '嵌进卡片' in store_text
        assert '分享给别人时图片不会跟着走' in store_text and '512px' in store_text and '不会从酒馆服务器上删除' in store_text
        assert '内嵌图片 已用 0K / 上限 768K' in store_text
        saved_before = ev(page, 'window.__settingsSaved || 0')
        set_store(page, 'embed')
        assert ev(page, 'window.__settingsSaved || 0') > saved_before, '切换时保存扩展设置'
        assert page.get_attribute('[data-act="sb-pt-store"][data-sb-val="embed"]', 'aria-pressed') == 'true'
        close_dialog(page)
        open_sb_dialog(page)
        tab(page, 'portraits')
        page.wait_for_selector('[data-sb-pt-store="embed"]')
        shot(page, '01-store-toggle')
        set_store(page, 'server')

        step('酒馆服务器：选两张 PNG（小图原样上传，宽 2600 的重新编码成 webp），先填空着的那一行')
        page.click('[data-act="sb-pt-add-name"][data-sb-name="莉莉丝"]')
        page.wait_for_selector('[data-sb-pt="url"][data-sb-pt-c="0"][data-sb-pt-i="0"]')
        pick(page, 'c:0', [f('small.png', SMALL), f('wide <b>"x".png', WIDE)])
        wait_local(page, 'c:0', '已添加 2 张')
        lili = urls_of(page, '莉莉丝')
        print('莉莉丝:', lili)
        assert len(lili) == 2, '空着的那一行被填上，没有多出一行'
        assert SERVER_RE.match(lili[0]) and lili[0].endswith('.png'), lili[0]
        assert SERVER_RE.match(lili[1]) and lili[1].endswith('.webp'), lili[1]
        ups = ev(page, 'window.__uploads.map(u => ({ ch: u.ch_name, format: u.format, filename: u.filename, image: u.image, csrf: u.headers["X-CSRF-Token"], path: u.path }))')
        assert [u['ch'] for u in ups] == [CARD_NAME, CARD_NAME] and [u['format'] for u in ups] == ['png', 'webp']
        assert all(re.fullmatch(r'nl_[0-9a-f]{16}', u['filename']) for u in ups), [u['filename'] for u in ups]
        assert all(u['csrf'] == 't' for u in ups), '带酒馆的 CSRF 请求头'
        assert base64.b64decode(ups[0]['image']) == SMALL, '小图原样上传（字节不变）'
        assert lili[0] == FOLDER + ups[0]['filename'] + '.png' and urllib.parse.unquote(lili[1]) == ups[1]['path']
        wide = img_info(page, 'data:image/webp;base64,' + ups[1]['image'])
        print('wide re-encoded:', wide)
        assert wide[0] == 1600 and wide[1] == 862 and wide[2] == 'image/webp', wide
        for ii in range(2):
            page.wait_for_selector(f'[data-sb-pt-row="0.{ii}"] [data-sb-thumb-wrap][data-state="ok"]', timeout=5000)
            assert page.locator(f'[data-sb-pt-row="0.{ii}"] .nl-sb-kind').inner_text() == '酒馆'
        assert page.locator('[data-sb-pt-row="0.0"] [data-act="sb-pt-convert"][data-sb-to="embed"]').count() == 1
        assert page.locator('[data-sb-pt-local="c:0"] b').count() == 0, '文件名不会变成 HTML'
        # 处理期间按钮被禁用、焦点掉到 <body>：处理完放回「选择本地图片」，读屏播报结果
        assert active_matches(page, '[data-act="sb-pt-pick"][data-sb-pt-target="c:0"]'), ev(page, '() => document.activeElement.outerHTML.slice(0, 120)')
        poll(lambda: live_text(page), lambda t: '已添加 2 张' in t, '读屏播报选图结果')
        assert page.locator('[data-sb-pt-share-hint]').is_visible()
        assert '2 张立绘存在酒馆服务器上' in page.locator('[data-sb-pt-share-hint]').inner_text()
        fill = '[data-sb-pt="label"][data-sb-pt-c="0"][data-sb-pt-i="0"]'
        page.fill(fill, '初见')
        page.press(fill, 'Tab')
        page.wait_for_function("() => NovelLoom.app.project.cards[0].statusBar.portraits.characters['莉莉丝'][0].label === '初见'")
        shot(page, '02-server-picked')

        step('嵌进卡片：1200×1600 的 PNG 压缩成 384×512 的 webp，不超过单张上限；用量条更新')
        set_store(page, 'embed')
        page.click('[data-act="sb-pt-add-name"][data-sb-name="江酒"]')
        page.wait_for_selector('[data-sb-pt="url"][data-sb-pt-c="1"][data-sb-pt-i="0"]')
        pick(page, 'c:1', [f('tall.png', TALL)])
        wait_local(page, 'c:1', '已添加 1 张（嵌进卡片）')
        jiang = urls_of(page, '江酒')
        assert len(jiang) == 1 and jiang[0].startswith('data:image/webp;base64,') and len(jiang[0]) <= DATA_LIMIT, (jiang[0][:40], len(jiang[0]))
        tall = img_info(page, jiang[0])
        print('embedded:', tall, len(jiang[0]), 'chars')
        assert tall[:2] == [384, 512], tall
        badge = page.locator('[data-sb-pt-row="1.0"] .nl-sb-kind').inner_text()
        assert badge.startswith('内嵌 ') and badge.endswith('K'), badge
        clip = ev(page, "() => { const b = document.querySelector('[data-sb-pt-row=\"1.0\"] .nl-sb-kind'); return [b.scrollWidth, b.clientWidth, b.title]; }")
        assert clip[0] <= clip[1], f'内嵌标签被截掉了：{clip}'
        assert clip[2].startswith('嵌在卡片里（') and '字）' in clip[2], clip[2]
        meter = page.locator('[data-sb-pt-meter]').inner_text()
        print('meter:', meter)
        assert '已用 0K' not in meter and '上限 768K' in meter
        assert len(ev(page, 'window.__uploads')) == 2, '嵌进卡片不上传'
        shot(page, '03-embed-picked')

        step('转换：莉莉丝第一张 酒馆 → 内嵌（说明不变），江酒那张 内嵌 → 酒馆（原样上传 webp）')
        page.click('[data-act="sb-pt-convert"][data-sb-pt-c="0"][data-sb-pt-i="0"]')
        poll(lambda: urls_of(page, '莉莉丝')[0][:22], 'data:image/webp;base64', '莉莉丝第一张改成内嵌')
        pl = pts(page)['characters']['莉莉丝']
        assert pl[0]['label'] == '初见' and pl[1]['url'] == lili[1], '说明和顺序不变'
        assert img_info(page, pl[0]['url'])[:2] == [64, 64]
        # 按钮换了方向（改成内嵌 → 存到酒馆），焦点仍在这一行的转换按钮上
        assert active_matches(page, '[data-act="sb-pt-convert"][data-sb-pt-c="0"][data-sb-pt-i="0"][data-sb-to="server"]')
        page.click('[data-act="sb-pt-convert"][data-sb-pt-c="1"][data-sb-pt-i="0"]')
        poll(lambda: urls_of(page, '江酒')[0], lambda u: bool(SERVER_RE.match(u)) and u.endswith('.webp'), '江酒那张存到酒馆')
        last = ev(page, 'window.__uploads.at(-1)')
        assert last['format'] == 'webp' and last['ch_name'] == CARD_NAME
        assert 'data:image/webp;base64,' + last['image'] == jiang[0], '内嵌的 webp 原样上传'
        # 江酒再加一张存在酒馆上的小图（默认显示最后一张）：预览里换一张后记的是原路径
        set_store(page, 'server')
        pick(page, 'c:1', [f('small-again.png', SMALL)])
        wait_local(page, 'c:1', '已添加 1 张（存到酒馆服务器）')
        jiang = urls_of(page, '江酒')
        assert len(jiang) == 2 and jiang[1] == lili[0], '同一张图（内容哈希相同）存成同一个文件'
        page.wait_for_selector('[data-sb-pt-row="1.1"] [data-sb-thumb-wrap][data-state="ok"]', timeout=5000)
        shot(page, '04-converted')

        step('图池：取值选择本地图片、兜底拖放一张；兜底嵌进卡片后「全部存到酒馆」')
        page.click('[data-act="sb-pool-add"]')
        page.wait_for_selector('[data-sb-pool="record"][data-sb-pool-p="0"]')
        page.select_option('[data-sb-pool="record"][data-sb-pool-p="0"]', 'NPC')
        page.wait_for_timeout(150)
        page.select_option('[data-sb-pool="field"][data-sb-pool-p="0"]', '阵营')
        page.wait_for_timeout(150)
        page.fill('[data-sb-pool="value"][data-sb-pool-p="0"][data-sb-pool-v="0"]', '敌对')
        page.press('[data-sb-pool="value"][data-sb-pool-p="0"][data-sb-pool-v="0"]', 'Tab')
        page.wait_for_timeout(150)
        pick(page, 'v:0:0', [f('hostile.png', OTHER)])
        wait_local(page, 'v:0:0', '已添加 1 张')
        ta = page.input_value('[data-sb-pool="urls"][data-sb-pool-p="0"][data-sb-pool-v="0"]')
        assert SERVER_RE.match(ta.strip()), ta
        assert '酒馆 1' in page.locator('[data-sb-pool-row="0.0"] [data-sb-pt-kinds]').inner_text()
        set_store(page, 'embed')
        ev(page, """async ({ sel, b64 }) => {
            const bin = atob(b64); const u8 = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
            const dt = new DataTransfer(); dt.items.add(new File([u8], 'drop.png', { type: 'image/png' }));
            // 酒馆在 <body> 上接拖进来的文件当作导入角色卡：立绘分页处理过的拖放不能传到那里
            window.__bodyDrops = 0;
            document.body.addEventListener('drop', () => { window.__bodyDrops++; });
            document.body.addEventListener('dragover', () => { window.__bodyDrops++; });
            const el = document.querySelector(sel);
            el.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
            if (!el.closest('[data-sb-pt-drop]').classList.contains('is-drop')) throw new Error('拖到上面时没有标出可以放下');
            el.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
            // 差一点没放到目标上：落在底栏、遮罩上也不漏给酒馆（也不当成要加的图）
            for (const miss of [document.querySelector('.nl-dialog-overlay .nl-dialog-foot'), document.querySelector('.nl-dialog-overlay')]) {
                const over = new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt });
                miss.dispatchEvent(over);
                if (!over.defaultPrevented) throw new Error('对话框边上的 dragover 没有拦下');
                const drop = new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt });
                miss.dispatchEvent(drop);
                if (!drop.defaultPrevented) throw new Error('对话框边上的 drop 没有拦下');
            }
        }""", {'sel': '[data-sb-pt-drop="f:0"] textarea', 'b64': base64.b64encode(DROP).decode()})
        wait_local(page, 'f:0', '已添加 1 张（嵌进卡片）')
        assert ev(page, 'window.__bodyDrops') == 0, '拖放（包括落在对话框边上的）没有传到酒馆的 <body>（不会被当成角色卡导入）'
        assert page.locator('[data-sb-pt-local*=":"]:not(:empty)').count() == len([t for t in ['c:0', 'c:1', 'v:0:0', 'f:0'] if page.locator(f'[data-sb-pt-local="{t}"]:not(:empty)').count()]), '落在边上的那次没有加到别处'
        fb = page.input_value('[data-sb-pool="fallback"][data-sb-pool-p="0"]').strip()
        assert fb.startswith('data:image/webp;base64,'), fb[:40]
        assert '内嵌 1' in page.locator('[data-sb-pt-drop="f:0"] [data-sb-pt-kinds]').inner_text()
        page.locator('[data-sb-pool-box="0"]').scroll_into_view_if_needed()
        shot(page, '05-pools')
        page.click('[data-act="sb-pt-convert-list"][data-sb-pt-target="f:0"][data-sb-to="server"]')
        wait_local(page, 'f:0', '已转换 1 张')
        assert active_matches(page, '[data-act="sb-pt-convert-list"][data-sb-pt-target="f:0"], [data-act="sb-pt-pick"][data-sb-pt-target="f:0"]'), '批量转换后焦点不掉'
        pool = pts(page)['pools'][0]
        print('pool:', json.dumps({k: (v if k != 'pools' else {kk: vv for kk, vv in v.items()}) for k, v in pool.items()}, ensure_ascii=False)[:300])
        assert pool['record'] == 'NPC' and pool['field'] == '阵营'
        assert SERVER_RE.match(pool['pools']['敌对'][0]) and SERVER_RE.match(pool['fallback'][0]) and pool['fallback'][0].endswith('.webp')

        step('出错：不是图片 / SVG 就地提示；上传失败（500、连不上）提示并可以改成嵌进卡片')
        set_store(page, 'server')
        page.click('[data-act="sb-pt-add-name"][data-sb-name="主角"]')
        page.wait_for_selector('[data-sb-pt="url"][data-sb-pt-c="2"][data-sb-pt-i="0"]')
        n_up = len(ev(page, 'window.__uploads'))
        pick(page, 'c:2', [f('notes.txt', b'hello', 'text/plain'), f('logo.svg', b'<svg xmlns="http://www.w3.org/2000/svg"></svg>', 'image/svg+xml'),
                           f('broken.png', b'\x89PNG not really', 'image/png'), f('<b>x</b>.png', b'<svg onload="alert(1)"></svg>', 'image/png')])
        wait_local(page, 'c:2', '不是图片')
        msg = local_msg(page, 'c:2')
        print('type errors:', msg.replace('\n', ' | '))
        assert '「notes.txt」：不是图片' in msg and '「logo.svg」：不支持 SVG 图片' in msg
        assert '「broken.png」：图片解码失败' in msg, '类型对但内容坏了：解码失败'
        assert '「<b>x</b>.png」：不支持 SVG 图片' in msg, '按字节认出伪装成 png 的 SVG；文件名原样显示成文字'
        assert page.locator('[data-sb-pt-local="c:2"] b').count() == 0
        assert page.locator('[data-sb-pt-local="c:2"].nl-err').count() == 1
        assert len(ev(page, 'window.__uploads')) == n_up and '主角' not in pts(page)['characters']
        ev(page, "window.__uploadFail = 'network'")
        pick(page, 'c:2', [f('other.png', OTHER)])
        wait_local(page, 'c:2', '连不上酒馆服务器')
        ev(page, 'window.__uploadFail = 500')
        pick(page, 'c:2', [f('other.png', OTHER)])
        wait_local(page, 'c:2', 'HTTP 500')
        msg = local_msg(page, 'c:2')
        print('upload failed:', msg.replace('\n', ' | '))
        assert '「other.png」：酒馆保存图片失败（HTTP 500' in msg
        assert page.locator('[data-sb-pt-local="c:2"] [data-act="sb-pt-embed-fallback"]').is_visible()
        assert '主角' not in pts(page)['characters']
        shot(page, '06-upload-failed')
        page.click('[data-sb-pt-local="c:2"] [data-act="sb-pt-embed-fallback"]')
        wait_local(page, 'c:2', '已添加 1 张（嵌进卡片）')
        me = urls_of(page, '主角')
        assert len(me) == 1 and me[0].startswith('data:image/webp;base64,') and img_info(page, me[0])[:2] == [80, 120]
        ev(page, 'window.__uploadFail = null')
        assert page.locator('[data-sb-pt-local="c:2"] [data-act="sb-pt-embed-fallback"]').count() == 0
        assert active_matches(page, '[data-act="sb-pt-pick"][data-sb-pt-target="c:2"]'), '「改成嵌进卡片」按钮没了：焦点放到同一组的「选择本地图片」'
        shot(page, '07-fallback-embedded')

        step('预览：酒馆图片换成父页面取来的 data:image；换一张记原路径 / 内嵌图片的短 id；重新载入后还在')
        cfg = pts(page)
        tab(page, 'preview')
        page.wait_for_selector('iframe[data-sb-frame]')
        poll(lambda: frame(page).locator('.wb-card').count(), 2, '主要角色卡片数')
        card_img = lambda i: frame(page).locator('.wb-card').nth(i).locator('[data-nl-portrait]').first
        src = lambda i: card_img(i).get_attribute('src', timeout=1000)
        state = lambda i: card_img(i).get_attribute('data-nl-portrait-state', timeout=1000)
        names = frame(page).locator('.wb-card .wb-name').all_inner_texts()
        assert names == ['莉莉丝', '江酒'], names
        psrc = frame(page).locator('body').evaluate('() => Object.keys(window.NL_PREVIEW_SRC || {})')
        print('preview src keys:', psrc)
        assert sorted(psrc) == sorted({cfg['characters']['莉莉丝'][1]['url'], *[i['url'] for i in cfg['characters']['江酒']], cfg['pools'][0]['pools']['敌对'][0], cfg['pools'][0]['fallback'][0]})
        doc_urls = frame(page).locator('body').evaluate("() => window.NL_PORTRAITS.characters['莉莉丝'].map(i => i.url)")
        assert doc_urls == [i['url'] for i in cfg['characters']['莉莉丝']], '文档里的配置仍是原路径'
        poll(lambda: src(0)[:22], 'data:image/webp;base64', '莉莉丝默认那张（酒馆上的 webp）换成 data:image')
        poll(lambda: state(0), 'ok', '莉莉丝的立绘载入')
        poll(lambda: src(1)[:21], 'data:image/png;base64', '江酒默认那张（酒馆上的 png）换成 data:image')
        assert base64.b64decode(src(1).split(',', 1)[1]) == SMALL
        hits = [h for h in image_hits if h in served]
        assert hits, '父页面从酒馆读了图片'
        swap = lambda i: frame(page).locator('.wb-card').nth(i).locator('.wb-swap').click()
        k_j, k_l = f'nl-sb:{card_id}:江酒', f'nl-sb:{card_id}:莉莉丝'
        swap(1)
        poll(lambda: ev(page, '(k) => localStorage.getItem(k)', k_j), cfg['characters']['江酒'][0]['url'], '江酒记的是原路径（不是 data:image）')
        poll(lambda: src(1)[:22], 'data:image/webp;base64', '江酒换成第一张')
        swap(0)
        poll(lambda: ev(page, '(k) => localStorage.getItem(k)', k_l), lambda v: bool(v) and v.startswith('nl#'), '莉莉丝换成内嵌那张：记短 id')
        assert src(0) == cfg['characters']['莉莉丝'][0]['url']
        assert page.locator('[data-sb-preview-errs] .nl-sb-note-err').count() == 0
        shot(page, '08-preview')
        frame(page).locator('body').evaluate("b => b.setAttribute('data-old-load', '1')")
        page.click('[data-act="sb-preview-reload"]')
        poll(lambda: frame(page).locator('body[data-old-load]').count(), 0, '预览重新载入')
        poll(lambda: src(1)[:22], 'data:image/webp;base64', '重新载入后江酒仍是选的那张')
        assert src(0) == cfg['characters']['莉莉丝'][0]['url'], '重新载入后莉莉丝仍是内嵌那张'
        assert pts(page) == cfg, '预览不会把 data:image 写进卡片'

        step('导出：分享提示；导出的正则里是原路径、没有预览用的 data:image')
        tab(page, 'export')
        hint = page.locator('[data-sb-export-pt-hint]')
        assert hint.is_visible()
        n_server = len({u for u in [*[i['url'] for c in cfg['characters'].values() for i in c], *cfg['pools'][0]['pools']['敌对'], *cfg['pools'][0]['fallback']] if u.startswith('/user/images/')})
        print('export hint:', hint.inner_text())
        assert f'{n_server} 张立绘存在酒馆服务器上，把卡分享给别人时不会跟着走' in hint.inner_text()
        shot(page, '09-export-hint')
        rep = ev(page, "async () => (await import('/src/statusbar.js')).buildStatusRegexScripts(NovelLoom.app.project.cards[0])[0].replaceString")
        for u in [cfg['characters']['莉莉丝'][1]['url'], cfg['characters']['江酒'][0]['url'], cfg['pools'][0]['fallback'][0]]:
            assert u in rep, u
        n_data = len([u for c in cfg['characters'].values() for u in [i['url'] for i in c] if u.startswith('data:')])
        assert rep.count('data:image/') == n_data, (rep.count('data:image/'), n_data)
        page.click('[data-sb-export-pt-hint] [data-act="sb-tab"][data-tab="portraits"]')
        page.wait_for_selector('[data-sb-pt-share-hint]')

        step('窄屏：「立绘」分页的存法切换、标签和按钮换行后不挤')
        page.set_viewport_size({'width': 390, 'height': 844})
        page.wait_for_timeout(300)
        page.locator('[data-sb-pt-row="0.0"]').scroll_into_view_if_needed()
        overflow = ev(page, "() => { const b = document.querySelector('.nl-dialog-body'); return b.scrollWidth - b.clientWidth; }")
        assert overflow <= 1, f'窄屏下对话框横向溢出 {overflow}px'
        shot(page, '10-mobile')
        # 上传失败的提示里有一长串不带空格的文件名：折行，不压到「改成嵌进卡片」上
        ev(page, 'window.__uploadFail = 500')
        pick(page, 'c:1', [f('Screenshot_20241005_181212_Chrome.png', OTHER)])
        wait_local(page, 'c:1', 'HTTP 500')
        geo = ev(page, """() => {
            const el = document.querySelector('[data-sb-pt-local="c:1"]');
            el.scrollIntoView({ block: 'center' });
            const g = el.querySelector('.nl-grow'), b = el.querySelector('[data-act="sb-pt-embed-fallback"]');
            const gr = g.getBoundingClientRect(), br = b.getBoundingClientRect();
            return { over: g.scrollWidth - g.clientWidth, overlap: gr.right > br.left + 0.5 && gr.left < br.right && gr.bottom > br.top + 0.5 && gr.top < br.bottom, grow: [gr.left, gr.right, gr.top, gr.bottom], btn: [br.left, br.right, br.top, br.bottom] };
        }""")
        print('mobile error layout:', geo)
        assert geo['over'] <= 1 and not geo['overlap'], geo
        ev(page, 'window.__uploadFail = null')
        assert len(urls_of(page, '江酒')) == 2
        shot(page, '10b-mobile-long-name')
        page.set_viewport_size({'width': 1360, 'height': 900})
        page.wait_for_timeout(200)

        step('存为模板：带立绘时提醒酒馆上的图分享不出去')
        page.click('.nl-sb-toolbar [data-act="sb-save-tpl"]')
        page.wait_for_selector('.nl-dialog-head:has-text("存为状态栏模板")')
        assert top(page).locator('[data-sb-tpl-pt-notes]').is_hidden(), '不勾「连同立绘设置」时不显示立绘的提醒'
        top(page).locator('[data-f="portraits"]').check()
        top(page).locator('[data-sb-tpl-pt-notes]').wait_for(state='visible')
        notes = top(page).locator('[data-sb-tpl-pt-notes]').inner_text()
        print('template notes:', notes)
        assert '存在酒馆服务器上，把模板导出分享给别人时不会跟着走' in notes and '改用图床' in notes
        assert '改成嵌进卡片' not in notes and '改成内嵌' not in notes, '模板的提醒不指向内嵌（模板里的内嵌上限小得多）'
        top(page).locator('[data-f="portraits"]').uncheck()
        assert top(page).locator('[data-sb-tpl-pt-notes]').is_hidden()
        top(page).locator('[data-f="portraits"]').check()
        top(page).locator('[data-f="name"]').fill('本地立绘')
        top(page).locator('.nl-dialog-foot button:has-text("保存")').click()
        wait_log(page, '已保存状态栏模板「本地立绘」')
        tpl = ev(page, "NovelLoom.app.settings.statusBarTemplates.find(t => t.name === '本地立绘')")
        assert tpl['portraits']['characters']['江酒'][0]['url'] == cfg['characters']['江酒'][0]['url']
        assert all(len(i['url']) <= 32768 for c in tpl['portraits']['characters'].values() for i in c), '模板里的内嵌图片不超过模板的上限'
        close_dialog(page)

        step('导出 JSON：日志里提醒酒馆上的立绘不随卡分享')
        page.click('.nl-cardbox [data-act="json"]')
        wait_log(page, f'「{CARD_NAME}」：{n_server} 张立绘存在酒馆服务器上，把卡分享给别人时不会跟着走')
        shot(page, '11-card-export')

        step('数量上限：一个角色最多 12 张，多选的超出部分跳过并列出')
        open_sb_dialog(page)
        tab(page, 'portraits')
        set_store(page, 'server')
        assert urls_of(page, '主角') == me
        many = [f(f'p{i:02d}.png', png(8, 8, 10 + i)) for i in range(12)]
        pick(page, 'c:2', many)
        wait_local(page, 'c:2', '最多 12 张：跳过了 1 张（p11.png）')
        assert len(urls_of(page, '主角')) == 12
        assert page.locator('[data-act="sb-pt-pick"][data-sb-pt-target="c:2"]').is_disabled(), '满了以后不能再选'
        assert page.get_attribute('[data-act="sb-pt-pick"][data-sb-pt-target="c:2"]', 'title') == '每个角色最多 12 张', '禁用时说明为什么'
        shot(page, '12-cap')

        step('图池缩略图：逐行删除；文本框改过、还没重绘时按内容找到那一行')
        set_store(page, 'embed')
        pick(page, 'f:0', [f('fb2.png', DROP)])
        wait_local(page, 'f:0', '已添加 1 张（嵌进卡片）')
        fb_lines = page.input_value('[data-sb-pool="fallback"][data-sb-pool-p="0"]').split('\n')
        assert len(fb_lines) == 2 and SERVER_RE.match(fb_lines[0]) and fb_lines[1].startswith('data:image/webp;base64,'), [x[:40] for x in fb_lines]
        assert ev(page, "() => getComputedStyle(document.querySelector('[data-sb-pool=\"fallback\"]')).whiteSpace") == 'pre', '一张图一行，不折行'
        chips = page.locator('[data-sb-pt-drop="f:0"] .nl-sb-pool-thumb')
        assert chips.count() == 2 and chips.nth(1).locator('.nl-sb-kind').inner_text().startswith('内嵌 ')
        shot(page, '13-pool-chips')
        # 在最前面插一行（只有 input，没有 change：缩略图上的行号还是旧的），再点第 2 张（内嵌那张）的删除
        page.fill('[data-sb-pool="fallback"][data-sb-pool-p="0"]', 'https://img.example.com/typed.png\n' + '\n'.join(fb_lines))
        page.click('[data-act="sb-pool-img-del"][data-sb-pt-target="f:0"][data-sb-line="2"]')
        poll(lambda: pts(page)['pools'][0]['fallback'], ['https://img.example.com/typed.png', fb_lines[0]], '删掉的是内嵌那张（按内容找），不是现在的第 2 行')
        assert page.input_value('[data-sb-pool="fallback"][data-sb-pool-p="0"]') == 'https://img.example.com/typed.png\n' + fb_lines[0]
        assert active_matches(page, '[data-act="sb-pool-img-del"][data-sb-pt-target="f:0"]'), '焦点放到旁边一张的删除按钮'

        step('处理期间的锁：转换卡住时不能再选图 / 转换 / 拖放；文本框里新加的行不被旧副本冲掉；放开后「稍等」的提示收起')
        hostile = pts(page)['pools'][0]['pools']['敌对']
        assert len(hostile) == 1 and SERVER_RE.match(hostile[0]), hostile
        hold(page, 'image')
        page.click('[data-act="sb-pt-convert-list"][data-sb-pt-target="v:0:0"][data-sb-to="embed"]')
        page.wait_for_selector('[data-act="sb-pt-convert-list"][data-sb-pt-target="v:0:0"]:disabled')
        page.fill('[data-sb-pool="urls"][data-sb-pool-p="0"][data-sb-pool-v="0"]', hostile[0] + '\nhttps://img.example.com/typed2.png')
        page.press('[data-sb-pool="urls"][data-sb-pool-p="0"][data-sb-pool-v="0"]', 'Tab')
        poll(lambda: pts(page)['pools'][0]['pools']['敌对'], [hostile[0], 'https://img.example.com/typed2.png'], '处理期间新加的一行先保存了')
        n_up = len(ev(page, 'window.__uploads'))
        page.click('[data-act="sb-pt-pick"][data-sb-pt-target="c:0"]')  # 不弹出选文件
        wait_local(page, 'c:0', '上一批图片还在处理，稍等再试')
        page.click('[data-act="sb-pt-convert"][data-sb-pt-c="1"][data-sb-pt-i="0"]')
        wait_local(page, 'c:1:0', '上一批图片还在处理，稍等再试')
        ev(page, """async (b64) => {
            const bin = atob(b64); const u8 = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
            const dt = new DataTransfer(); dt.items.add(new File([u8], 'late.png', { type: 'image/png' }));
            document.querySelector('[data-sb-pt-drop="c:1"]').dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
        }""", base64.b64encode(DROP).decode())
        wait_local(page, 'c:1', '上一批图片还在处理，稍等再试')
        shot(page, '14-locked')
        assert len(urls_of(page, '江酒')) == 2 and len(ev(page, 'window.__uploads')) == n_up, '被拒绝的操作什么都没做'
        release(page, 'image')
        wait_local(page, 'v:0:0', '已转换 1 张（嵌进卡片）')
        hostile2 = pts(page)['pools'][0]['pools']['敌对']
        assert hostile2[0].startswith('data:image/webp;base64,') and hostile2[1] == 'https://img.example.com/typed2.png', [x[:40] for x in hostile2]
        assert page.locator('[data-sb-pt-local="c:0"]:not(:empty)').count() == 0 and page.locator('[data-sb-pt-local="c:1:0"]').count() == 0, '「稍等再试」的提示收起了'

        step('手填的图库路径：中文文件夹、生成图扩展带 @ 的文件名规范成逐段编码；预览不替它去读；找不到这张图时说明地址没改')
        page.fill('[data-sb-pt-new]', '路人甲')
        page.click('[data-act="sb-pt-add-char"]')
        page.wait_for_selector('[data-sb-pt="url"][data-sb-pt-c="3"][data-sb-pt-i="0"]')
        page.fill('[data-sb-pt-new]', '路人乙')
        page.click('[data-act="sb-pt-add-char"]')
        page.wait_for_selector('[data-sb-pt="url"][data-sb-pt-c="4"][data-sb-pt-i="0"]')
        raw = '/user/images/' + CARD_NAME + '/Seraphina_2026-10-05@12h00m00s000ms.png'
        canon = FOLDER + 'Seraphina_2026-10-05%4012h00m00s000ms.png'
        expect_404.append('Seraphina_2026-10-05@12h00m00s000ms.png')
        page.fill('[data-sb-pt="url"][data-sb-pt-c="3"][data-sb-pt-i="0"]', raw)
        page.press('[data-sb-pt="url"][data-sb-pt-c="3"][data-sb-pt-i="0"]', 'Tab')
        poll(lambda: urls_of(page, '路人甲'), [canon], '手填的路径存成规范写法')
        poll(lambda: page.input_value('[data-sb-pt="url"][data-sb-pt-c="3"][data-sb-pt-i="0"]'), canon, '输入框里也换成规范写法')
        assert page.locator('[data-sb-pt-row="3.0"] .nl-sb-kind').inner_text() == '酒馆'
        tab(page, 'preview')
        poll(lambda: frame(page).locator('.wb-card').count(), 2, '预览载入')
        assert '1 张手填的酒馆图片' in page.locator('[data-sb-preview-pt-foreign]').inner_text()
        page.wait_for_timeout(300)
        assert not [h for h in fetch_hits if 'Seraphina' in h], f'预览替它去读了：{fetch_hits}'
        tab(page, 'portraits')
        page.click('[data-act="sb-pt-convert"][data-sb-pt-c="3"][data-sb-pt-i="0"]')
        wait_local(page, 'c:3:0', '找不到这张图')
        assert '酒馆服务器上找不到这张图（可能已经被删掉了）（这张的地址没有改动）' in local_msg(page, 'c:3:0')
        assert urls_of(page, '路人甲') == [canon]

        step('处理期间删掉前面的角色：上传失败的提示和「改成嵌进卡片」仍在原来那个角色（序号变了）下；GIF 太大转成静态图时提示')
        set_store(page, 'server')
        ev(page, 'window.__uploadFail = 500')
        hold(page, 'upload')
        pick(page, 'c:4', [f('passerby.png', OTHER)])
        page.wait_for_selector('[data-act="sb-pt-pick"][data-sb-pt-target="c:4"]:disabled')
        page.click('[data-act="sb-pt-del-char"][data-sb-pt-c="3"]')
        top(page).locator('.nl-dialog-foot button:has-text("删除")').click()
        page.wait_for_function("() => document.querySelectorAll('.nl-dialog-overlay').length === 1")
        poll(lambda: page.input_value('[data-sb-pt="name"][data-sb-pt-c="3"]'), '路人乙', '路人甲删掉后路人乙挪到第 4 个')
        release(page, 'upload')
        wait_local(page, 'c:3', 'HTTP 500')
        assert page.locator('[data-sb-pt-local="c:4"]').count() == 0 and page.locator('[data-sb-pt-char="4"]').count() == 0
        assert page.locator('[data-sb-pt-char="3"] [data-sb-pt-local="c:3"] [data-act="sb-pt-embed-fallback"]').is_visible()
        ev(page, 'window.__uploadFail = null')
        page.click('[data-sb-pt-local="c:3"] [data-act="sb-pt-embed-fallback"]')
        wait_local(page, 'c:3', '已添加 1 张（嵌进卡片）')
        assert '路人甲' not in pts(page)['characters']
        lu = urls_of(page, '路人乙')
        assert len(lu) == 1 and lu[0].startswith('data:image/webp;base64,') and img_info(page, lu[0])[:2] == [80, 120], '重试的图加到了路人乙，没有加到别人'
        assert len(urls_of(page, '江酒')) == 2 and len(urls_of(page, '主角')) == 12
        pick(page, 'c:3', [f('big.gif', BIG_GIF, 'image/gif')])
        wait_local(page, 'c:3', '已添加 1 张（存到酒馆服务器）')
        assert 'GIF 动图超过 4MB 或最长边超过 2048，存到酒馆服务器时转成了静态图（只保留第一帧）' in local_msg(page, 'c:3')
        lu = urls_of(page, '路人乙')
        assert len(lu) == 2 and SERVER_RE.match(lu[1]) and lu[1].endswith('.webp'), lu[1]
        assert ev(page, 'window.__uploads.at(-1).format') == 'webp'
        shot(page, '15-shifted-retry')

        step('处理期间关掉对话框：上传完也不再写回卡片，日志里说明')
        hold(page, 'upload')
        pick(page, 'c:3', [f('late.png', DROP)])
        page.wait_for_selector('[data-act="sb-pt-pick"][data-sb-pt-target="c:3"]:disabled')
        close_dialog(page)
        before = pts(page)
        release(page, 'upload')
        wait_log(page, '对话框已关闭，选的 1 张图片没有加进立绘（已上传的仍在酒馆服务器上，可以重新打开后再选）')
        page.wait_for_timeout(900)  # 原来的 saveSoon（600ms）不会再被安排
        assert pts(page) == before and len(urls_of(page, '路人乙')) == 2, '关掉之后不再写回'
        open_sb_dialog(page)
        tab(page, 'portraits')
        assert len(urls_of(page, '路人乙')) == 2 and page.locator('[data-sb-pt-row="3.1"]').count() == 1 and page.locator('[data-sb-pt-row="3.2"]').count() == 0

        step('「导出」的分享提示 → 去「立绘」：焦点在「全部改成内嵌」上，回车全部改成内嵌（说明、顺序不变，合计不超上限）')
        cfg = pts(page)
        all_urls = [i['url'] for c in cfg['characters'].values() for i in c] + [u for pl in cfg['pools'] for lst in pl['pools'].values() for u in lst] + [u for pl in cfg['pools'] for u in pl['fallback']]
        n_srv = len([u for u in all_urls if u.startswith('/user/images/')])
        n_uniq = len({u for u in all_urls if u.startswith('/user/images/')})
        assert n_srv >= 10, n_srv
        tab(page, 'export')
        page.click('[data-sb-export-pt-hint] [data-act="sb-tab"][data-tab="portraits"]')
        page.wait_for_selector('[data-act="sb-tab"][data-tab="portraits"].active')
        assert active_matches(page, '[data-act="sb-pt-convert-all"]'), '焦点在「全部改成内嵌」上'
        assert f'全部改成内嵌（{n_uniq} 张）' in page.locator('[data-act="sb-pt-convert-all"]').inner_text()
        page.keyboard.press('Enter')
        wait_local(page, 'all', f'已转换 {n_srv} 张（嵌进卡片）', timeout=60000)
        after = pts(page)
        left = [u for c in after['characters'].values() for u in [i['url'] for i in c]] + [u for pl in after['pools'] for lst in pl['pools'].values() for u in lst] + [u for pl in after['pools'] for u in pl['fallback']]
        assert not [u for u in left if u.startswith('/user/images/')], '没有存在酒馆服务器上的了'
        assert after['characters']['莉莉丝'][0]['label'] == '初见' and len(after['characters']['主角']) == 12 and after['pools'][0]['fallback'][0] == 'https://img.example.com/typed.png'
        assert sum(len(u) for u in left if u.startswith('data:')) <= 786432
        assert page.locator('[data-sb-pt-share-hint]').count() == 0 and page.locator('[data-act="sb-pt-convert-all"]').count() == 0
        assert active_matches(page, '[data-act="sb-pt-store"].active'), '按钮没了：焦点放到存法切换上'
        poll(lambda: live_text(page), lambda t: f'已转换 {n_srv} 张' in t, '读屏播报转换结果')
        shot(page, '16-converted-all')
        tab(page, 'export')
        assert page.locator('[data-sb-export-pt-hint]').count() == 0, '导出页的分享提示也没了'
        close_dialog(page)
        browser.close()
finally:
    server.terminate()

print('ERRORS:', json.dumps(errors, ensure_ascii=False, indent=1))
sys.exit(1 if errors else 0)
