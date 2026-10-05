# 浏览器检查（状态栏 NL 运行时，v0.12）：在真实 Chromium 里跑编译出的状态栏文档——
# 记录模板里的立绘（解锁、默认最高、加载失败/没有图片时的占位块与首字、占位块跟着 <img> 的 class 取尺寸）、
# 换一张（循环、记在 nl-sb:<卡片>:<名字>、不冒泡到可点击的卡片）、变量更新后解锁变化、分组字段与分组子模板，
# 以及沙箱 iframe（NovelLoom 预览）里本地存储被拦截时换一张仍可用。页面见 tests/browser/sb-runtime.html。
import json, os, subprocess, sys, time
from playwright.sync_api import sync_playwright

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
SHOTS = sys.argv[1] if len(sys.argv) > 1 else '/tmp/nl-sb-runtime'
os.makedirs(SHOTS, exist_ok=True)
PORT = 8779
server = subprocess.Popen([sys.executable, '-m', 'http.server', str(PORT), '--bind', '127.0.0.1'], cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1)
errors = []


def step(msg):
    print('==', msg, flush=True)


try:
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={'width': 1600, 'height': 1000})
        page.on('pageerror', lambda e: errors.append('pageerror: ' + str(e)))
        # 卡尔的立绘地址故意指向不存在的文件（检查加载失败的占位块），这条 404 不算错误
        page.on('console', lambda m: errors.append('console: ' + m.text) if m.type == 'error' and '404' not in m.text else None)
        page.goto(f'http://127.0.0.1:{PORT}/tests/browser/sb-runtime.html')
        page.wait_for_function('window.__ready === true')
        frame = page.frame_locator('#same')
        same = page.frame(url=lambda u: u.startswith('about:srcdoc')) or page.frames[1]
        page.wait_for_function("() => { const d = document.getElementById('same').contentDocument; return d && d.querySelectorAll('.card').length === 2; }")
        page.wait_for_function("() => { const d = document.getElementById('same').contentDocument; const s = [...d.querySelectorAll('[data-nl-portrait-state]')].map(e => e.getAttribute('data-nl-portrait-state')); return s.length === 3 && !s.includes('loading'); }", timeout=10000)
        docs = page.evaluate('window.__docs')

        def q(js):
            return page.evaluate("(js) => { const d = document.getElementById('same').contentDocument; const w = document.getElementById('same').contentWindow; return (new Function('d', 'w', js))(d, w); }", js)

        step('立绘：解锁与默认、加载成功 / 失败 / 没有图片')
        state = q("""
            const cards = [...d.querySelectorAll('.card')];
            const info = (el) => { const img = el.querySelector('img[data-nl-portrait], img.nl-portrait-img'); const ph = img.nextElementSibling; const cs = getComputedStyle(ph);
                return { src: img.getAttribute('src'), state: (img.hasAttribute('data-nl-portrait') ? img : img.parentNode).getAttribute('data-nl-portrait-state'), imgShown: img.offsetWidth > 0,
                         phDisplay: cs.display, phText: ph.textContent, phClass: ph.className, phW: Math.round(ph.getBoundingClientRect().width), phH: Math.round(ph.getBoundingClientRect().height) }; };
            return { lia: info(cards[0]), karl: info(cards[1]), npc: info(d.querySelector('.npc')),
                     swapHidden: cards.map(c => c.querySelector('.swap').hidden), top: cards.map(c => c.querySelector('.top').textContent),
                     stage: cards.map(c => c.querySelector('.stage').textContent + '#' + c.querySelector('.stage').getAttribute('data-nl-stage-index')),
                     dress: [...cards[0].querySelectorAll('.dress li')].map(li => li.textContent) };
        """)
        print(json.dumps(state, ensure_ascii=False, indent=1))
        assert state['lia']['src'] == docs['PNG2'] and state['lia']['state'] == 'ok' and state['lia']['imgShown'], '好感 60：显示第二张（最高的已解锁）'
        assert state['lia']['phDisplay'] == 'none'
        assert state['karl']['state'] == 'error' and not state['karl']['imgShown'], '地址 404：加载失败'
        assert state['karl']['phDisplay'] == 'flex' and state['karl']['phText'] == '卡'
        assert state['karl']['phClass'] == 'pt nl-portrait-ph' and state['karl']['phW'] == 60 and state['karl']['phH'] == 80, '占位块跟着 <img> 的 class 取尺寸'
        assert state['npc']['state'] == 'empty' and state['npc']['phDisplay'] == 'flex' and state['npc']['phText'] == '路'
        assert state['npc']['phW'] == 40 and state['npc']['phH'] == 40, '容器里的占位块铺满容器'
        assert state['swapHidden'] == [False, True]
        assert state['top'] == ['风衣', '盔甲'] and state['stage'] == ['信任#1', '陌生#0']
        assert state['dress'] == ['上衣=风衣', '下装=长裙']
        page.screenshot(path=os.path.join(SHOTS, '01-portraits.png'))

        step('换一张：循环、记进本地存储、不触发卡片的点击')
        frame.locator('.card').first.locator('.swap').click()
        r = q("return { src: d.querySelector('.card .pt').getAttribute('src'), clicked: d.body.getAttribute('data-card-clicked'), stored: w.localStorage.getItem('nl-sb:card_rt:莉艾丽') };")
        print(r)
        # 内嵌图片（data:）记的是短 id（portraitChoiceId），不把整个 data: 地址塞进酒馆页面的本地存储
        png1_id = page.evaluate("async (u) => (await import('/src/statusbar-portraits.js')).portraitChoiceId(u)", docs['PNG1'])
        assert png1_id.startswith('nl#') and len(png1_id) < 30, png1_id
        assert r['src'] == docs['PNG1'] and r['clicked'] is None and r['stored'] == png1_id
        frame.locator('.card').first.locator('.swap').click()
        r = q("return { src: d.querySelector('.card .pt').getAttribute('src'), stored: w.localStorage.getItem('nl-sb:card_rt:莉艾丽') };")
        assert r['src'] == docs['PNG2'] and r['stored'] is None, '回到默认那张时不再记着'
        frame.locator('.card').first.locator('.nm').click()
        assert q("return d.body.getAttribute('data-card-clicked');") == '莉艾丽', '卡片自己的点击仍然正常'

        step('变量更新：好感降到 20 后第二张被锁住，回到第一张；生成的节点不叠加')
        q("w.__update({ 世界: { 时间: '夜' }, 主要角色: { 莉艾丽: { 好感: 20, 服饰: { 上衣: '睡衣', 下装: '' } } }, NPC: {} }); return null;")
        page.wait_for_timeout(200)
        r = q("return { cards: d.querySelectorAll('.card').length, src: d.querySelector('.card .pt').getAttribute('src'), state: d.querySelector('.card .pt').getAttribute('data-nl-portrait-state'), swapHidden: d.querySelector('.card .swap').hidden, top: d.querySelector('.card .top').textContent, ph: d.querySelectorAll('[data-nl-ph]').length, errors: w.__errors || [] };")
        print(r)
        assert r['cards'] == 1 and r['src'] == docs['PNG1'] and r['state'] == 'ok' and r['swapHidden'] and r['top'] == '睡衣' and r['ph'] == 1 and r['errors'] == []
        page.screenshot(path=os.path.join(SHOTS, '02-after-update.png'))

        step('沙箱 iframe（NovelLoom 预览）：本地存储被拦截，换一张仍在内存里循环')
        probe = page.evaluate('window.__probe')
        print(probe)
        assert probe['storage'] == 'blocked'
        assert probe['srcs'] == [docs['PNG2'], docs['PNG1'], docs['PNG2']] and probe['errors'] == []
        step('内置排版：分组显示成子区块，记录条目前有小头像（占位块 28px）；主要角色 2 条 + NPC 1 条')
        page.wait_for_function("() => { const d = document.getElementById('auto').contentDocument; return d && d.querySelectorAll('.nlb-li').length === 3; }")
        a = page.evaluate("""() => { const d = document.getElementById('auto').contentDocument;
            const li = [...d.querySelectorAll('.nlb-li')].slice(0, 2);
            const ph = li[1].querySelector('[data-nl-ph]').getBoundingClientRect();
            return { groups: li.map(x => x.querySelector('.nlb-lg').textContent), stage: li[0].querySelector('[data-nl-item-stage]').textContent,
                     av: li.map(x => x.querySelector('.nlb-av').getAttribute('data-nl-portrait-name')), ph: [Math.round(ph.width), Math.round(ph.height)] }; }""")
        print(a)
        assert a['groups'] == ['服饰上衣风衣下装长裙', '服饰上衣盔甲下装—'] and a['stage'] == '信任'
        assert a['av'] == ['莉艾丽', '卡尔'] and a['ph'] == [28, 28]
        page.locator('#auto').screenshot(path=os.path.join(SHOTS, '03-auto.png'))
        browser.close()
finally:
    server.terminate()

print('ERRORS:', json.dumps(errors, ensure_ascii=False, indent=1))
sys.exit(1 if errors else 0)
