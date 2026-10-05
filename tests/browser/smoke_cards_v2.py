# 浏览器冒烟测试（写卡 v2）：酒馆当前连接模式下 {{char}}/{{user}} 不被酒馆替换成当前打开的角色名（模拟 createRawPrompt 的 substituteParams）、
# 卡片名不采用 AI 写的名字（单人卡 = 角色名，世界卡默认 = 书名）、「{{user}} 扮演」原著角色（示例对话说话人规整）、
# 卡的导向（NTL + 让 AI 细化 → orientation_notes）、管理导向模板（复制内置、编辑、保存、导出）、
# 编辑框的「剧情导向」一节（换导向、重新生成本书落点）、写入酒馆时卡自己的世界书里有「剧情导向」「{{user}} 的身份」条目、设置页的模板库、窄屏
import json, os, subprocess, sys, time
from playwright.sync_api import sync_playwright

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
OUT = sys.argv[1] if len(sys.argv) > 1 else '/tmp/nl-cards-v2'
os.makedirs(OUT, exist_ok=True)
PORT = 8782
server = subprocess.Popen([sys.executable, '-m', 'http.server', str(PORT), '--bind', '127.0.0.1'], cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1)

ch1 = '第一章 魔女小姐\n' + '江酒走进酒吧。莉莉丝坐在角落，黑色长裙拖到地上。\n“没错，今晚我是来跟你提分手的。”江酒说。\n' * 18
ch2 = '第二章 女仆\n' + '江酒穿上了女仆装。小酒在镜子前转了一圈。莉莉丝去参加魔女茶会。\n' * 22
ch3 = '第三章 下城区\n' + '姜小白在雨中迷路，走进了那家店。江酒给她倒了一杯热水。\n' * 25
NOVEL = ch1 + ch2 + ch3
errors = []

def shot(page, name):
    # 对话框有淡入动画：等它完全显示再截图
    page.wait_for_function('() => [...document.querySelectorAll(".nl-dialog-overlay, .nl-dialog")].every((d) => getComputedStyle(d).opacity === "1")')
    page.screenshot(path=os.path.join(OUT, name + '.png'))

def wait_log(page, text, timeout=30000):
    page.wait_for_function('(t) => [...document.querySelectorAll(".nl-log-line")].some(l => l.textContent.includes(t))', arg=text, timeout=timeout)

def ev(page, js, arg=None):
    return page.evaluate(js, arg) if arg is not None else page.evaluate(js)

def download(page, selector):
    with page.expect_download() as d:
        page.click(selector)
    path = os.path.join(OUT, d.value.suggested_filename)
    d.value.save_as(path)
    return path

# 模拟酒馆当前连接：generateRaw 先像酒馆 createRawPrompt 那样对每条消息跑 substituteParams（{{user}}/{{char}}/<USER> 等换成
# 酒馆当前的用户名 / 打开的角色名，就地改写），再交给模拟的 AI。写卡 v2 的回复：AI 写了错误的名字、示例对话里用了角色的本名，
# 开场白里照抄了带零宽空格的宏（应被还原），并输出 orientation_notes
ST_TAVERN = r'''() => {
    const ctx = SillyTavern.getContext();
    ctx.name1 = 'Persona小明';
    ctx.name2 = 'Seraphina';
    const sub = (t) => String(t ?? '')
        .replace(/<USER>/gi, ctx.name1).replace(/<(?:BOT|CHAR)>/gi, ctx.name2)
        .replace(/\{\{user\}\}/gi, ctx.name1).replace(/\{\{char\}\}/gi, ctx.name2).replace(/\{\{persona\}\}/gi, '人设');
    const orig = ctx.generateRaw;
    window.__stSeen = [];
    ctx.generateRaw = async function (o) {
        for (const m of o.prompt) m.content = sub(m.content);
        const raw = o.prompt.map((m) => m.content).join('\n');
        window.__stSeen.push(raw);
        const text = raw.replace(/​/g, '');
        if (text.includes('写世界书「剧情导向」词条里的【本书落点】部分')) {
            window.__notesPrompts = (window.__notesPrompts || []).concat([text]);
            // __notesHold：先不回复，等测试调用 __releaseNotes（模拟生成期间用户换了导向）
            if (window.__notesHold) await new Promise((resolve) => { window.__releaseNotes = resolve; });
            if (text.includes('【卡的导向：纯爱】')) return JSON.stringify({ orientation_notes: ['心动的契机：江酒（纯爱）', '阻碍：魔女契约'] });
            return '```json\n' + JSON.stringify({ orientation_notes: ['原伴侣：江酒（重新生成）', '第三者：姜小白'] }) + '\n```';
        }
        if (text.includes('字段写法') && !text.includes('这是一张“世界/旁白卡”')) {
            return JSON.stringify({
                name: 'Seraphina',
                description: '基本信息:\n  姓名: {{char}}\n  与{{user}}的关系: 旧识',
                personality: '慢条斯理', scenario: '酒吧打烊后，{{user}} 推门进来',
                first_mes: '{​{char}​}把最后一只杯子倒扣在吧台上。\n“坐，{{user}}。”',
                alternate_greetings: ['雨夜，门铃响了。'],
                mes_example: '<START>\n江酒: 好久不见\n莉莉丝：坐。\n<START>\n{{user}}: 还在生气？\n莉莉丝 : 哼',
                creator_notes: '来自《魔女》', tags: ['魔女'],
                orientation_notes: '- 原伴侣：江酒\n- 关键阻碍：魔女契约',
            });
        }
        return orig.call(this, o);
    };
}'''

try:
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={'width': 1360, 'height': 900}, accept_downloads=True)
        page.on('pageerror', lambda e: errors.append('pageerror: ' + str(e)))
        page.on('console', lambda m: errors.append('console: ' + m.text) if m.type == 'error' else None)
        page.goto(f'http://127.0.0.1:{PORT}/tests/browser/harness.html')
        page.wait_for_selector('#nl-wand-button')
        ev(page, ST_TAVERN)
        page.evaluate("NovelLoom.open('project')")
        page.wait_for_selector('.nl-window')
        assert ev(page, 'NovelLoom.app.settings.api.mode') == 'tavern'

        # ---- 导入（书名 = 粘贴时填的「魔女」）+ 提取 ----
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
        page.click('.nl-nav-btn[data-tab="extract"]')
        page.click('#nl-tab [data-act="start"]')
        wait_log(page, '提取结束', timeout=60000)
        names = sorted(ev(page, 'Object.keys(NovelLoom.app.project.characters)'))
        print('characters:', names)
        assert names == sorted(['江酒', '莉莉丝', '姜小白']), names

        # ---- 写卡表单：{{user}} 扮演 = 江酒，卡的导向 = NTL + 细化 ----
        page.click('.nl-nav-btn[data-tab="cards"]')
        page.select_option('[data-form="charName"]', '莉莉丝')
        assert page.is_hidden('[data-ur-char]') and page.is_hidden('[data-orient-refine]')
        page.select_option('[data-form="userRoleKind"]', 'character')
        page.wait_for_selector('[data-ur-char]:not([hidden])')
        opts = ev(page, '[...document.querySelectorAll("[data-ur-char] option")].map((o) => o.value)')
        print('user role choices:', opts)
        assert '莉莉丝' not in opts and '江酒' in opts, '单人卡不能让 {{user}} 扮演卡片本人'
        page.select_option('[data-ur-char]', '江酒')
        assert '「江酒」写成 {{user}}' in page.inner_text('[data-ur-note]')
        page.select_option('[data-form="orientationId"]', 'orient_ntl')
        page.wait_for_selector('[data-orient-refine]:not([hidden])')
        assert page.is_checked('[data-form="orientationRefine"]'), '「让 AI 结合本书细化导向词条」默认勾选'
        assert '寝取り' in page.inner_text('[data-orient-brief]')
        groups = ev(page, '[...document.querySelectorAll("[data-form=orientationId] optgroup")].map((g) => g.label)')
        assert groups == ['内置'], groups
        shot(page, '01-card-form-orientation')

        # 预览提示词：带 {{user}} 的身份与导向段（宏原样）
        page.click('[data-act="preview"]')
        page.wait_for_selector('.nl-dialog')
        pv = page.inner_text('.nl-dialog-body')
        assert '扮演原著角色「江酒」' in pv and '【卡的导向：NTL】' in pv and 'orientation_notes' in pv, pv[:300]
        page.click('.nl-dialog [data-close]')
        page.wait_for_selector('.nl-dialog', state='detached')

        page.click('[data-act="generate"]')
        page.wait_for_selector('.nl-dialog [data-card="description"]', timeout=20000)
        card = ev(page, 'NovelLoom.app.project.cards.at(-1)')
        print('card name:', card['data']['name'], '| userRole:', card['userRole'], '| orientation:', card['orientation']['name'], card['orientation']['notes'])
        assert card['data']['name'] == '莉莉丝', 'AI 写的名字（Seraphina）不采用'
        assert card['userRole'] == {'kind': 'character', 'charKey': '江酒', 'text': ''}, card['userRole']
        assert card['orientation']['templateId'] == 'orient_ntl' and card['orientation']['notes'] == '- 原伴侣：江酒\n- 关键阻碍：魔女契约'
        assert card['data']['mes_example'] == '<START>\n{{user}}: 好久不见\n{{char}}: 坐。\n<START>\n{{user}}: 还在生气？\n{{char}}: 哼', card['data']['mes_example']
        assert card['data']['first_mes'].startswith('{{char}}把最后一只杯子') and '​' not in card['data']['first_mes'], '回复里带零宽空格的宏被还原'
        # 酒馆替换之后 AI 实际看到的写卡提示词：宏原样，没有酒馆当前的名字
        seen = ev(page, 'window.__stSeen.filter((t) => t.includes("字段写法")).at(-1)')
        plain = seen.replace('​', '')
        assert '{{char}}' in plain and '{{user}}' in plain, '{{char}}/{{user}} 原样到达 AI'
        assert 'Seraphina' not in seen and 'Persona小明' not in seen, '酒馆当前的角色名 / 用户名没有混进提示词'
        assert '{{' not in seen, '发给酒馆的内容里没有连续的 {{'
        # 编辑框：剧情导向一节
        assert ev(page, 'document.querySelector(".nl-dialog [data-orient-pick]").value') == 'orient_ntl'
        assert page.input_value('.nl-dialog [data-orient-notes]') == '- 原伴侣：江酒\n- 关键阻碍：魔女契约'
        assert page.input_value('.nl-dialog [data-orient-entry]').startswith('【剧情导向：NTL】')
        assert '原著角色「江酒」' in page.inner_text('.nl-dialog [data-orient-edit]')
        assert '本卡专用' in page.inner_text('.nl-dialog [data-card-world-label]')
        assert page.input_value('.nl-dialog [data-card-world]') == '《魔女》世界书·莉莉丝'
        page.locator('.nl-dialog [data-orient-edit]').scroll_into_view_if_needed()
        shot(page, '02-editor-orientation')

        # 重新生成本书落点（只问 orientation_notes）
        page.click('.nl-dialog [data-act="reroll-orient-notes"]')
        page.wait_for_selector('.nl-dialog[aria-label="重新生成本书落点"]')
        page.fill('.nl-dialog[aria-label="重新生成本书落点"] textarea', '第三者用姜小白')
        page.click('.nl-dialog[aria-label="重新生成本书落点"] .nl-dialog-foot button:has-text("确定")')
        page.wait_for_function('document.querySelector(".nl-dialog [data-orient-notes]").value.includes("重新生成")', timeout=15000)
        notes = page.input_value('.nl-dialog [data-orient-notes]')
        print('rerolled notes:', notes)
        assert notes == '- 原伴侣：江酒（重新生成）\n- 第三者：姜小白', notes
        np = ev(page, 'window.__notesPrompts.at(-1)')
        assert '【卡的导向：NTL】' in np and '第三者用姜小白' in np and '字段写法' not in np, '小提示词，只要本书落点'
        # 换导向：正文换成模板的、落点清空；换回来恢复卡上原来的
        page.select_option('.nl-dialog [data-orient-pick]', 'orient_pure')
        assert page.input_value('.nl-dialog [data-orient-entry]').startswith('【剧情导向：纯爱】')
        assert page.input_value('.nl-dialog [data-orient-notes]') == ''
        page.select_option('.nl-dialog [data-orient-pick]', '')
        assert page.is_hidden('.nl-dialog [data-orient-edit-body]')
        page.select_option('.nl-dialog [data-orient-pick]', 'orient_ntl')
        assert page.input_value('.nl-dialog [data-orient-entry]').startswith('【剧情导向：NTL】')
        page.fill('.nl-dialog [data-orient-notes]', notes)
        shot(page, '03-editor-orientation-rerolled')

        # ---- 保存并写入酒馆：卡自己的世界书里有剧情导向与 {{user}} 的身份 ----
        page.click('.nl-dialog-foot button:has-text("保存并写入酒馆")')
        wait_log(page, '已写入酒馆：角色「莉莉丝」')
        log = ev(page, '[...document.querySelectorAll(".nl-log-line")].map((l) => l.textContent).filter((t) => t.includes("已写入酒馆：角色「莉莉丝」")).at(-1)')
        print('log:', log)
        assert '剧情导向「NTL」' in log and '《魔女》世界书·莉莉丝' in log
        worlds = ev(page, 'Object.keys(window.__saved.worlds)')
        print('worlds:', worlds)
        w = ev(page, 'Object.values(window.__saved.worlds["《魔女》世界书·莉莉丝"].entries)')
        by = {e['comment']: e for e in w}
        assert '剧情导向：NTL' in by and '{{user}} 的身份' in by, list(by)
        oe = by['剧情导向：NTL']
        assert oe['constant'] and oe['position'] == 4 and oe['depth'] == 4 and oe['role'] == 0
        assert oe['content'].endswith('【本书落点】\n- 原伴侣：江酒（重新生成）\n- 第三者：姜小白'), oe['content'][-80:]
        assert '扮演原著中的「江酒」' in by['{{user}} 的身份']['content']
        assert '角色 - 江酒' not in by and '角色 - 莉莉丝' not in by, '卡片本人与 {{user}} 扮演的角色不重复写资料'
        imp = json.loads(ev(page, 'window.__saved.lastImport.text'))
        assert imp['data']['name'] == '莉莉丝'
        assert imp['data']['extensions']['world'] == '《魔女》世界书·莉莉丝'
        book = [e['comment'] for e in imp['data']['character_book']['entries']]
        assert '剧情导向：NTL' in book and '{{user}} 的身份' in book, book
        stored = ev(page, 'NovelLoom.app.project.cards.at(-1)')
        assert stored['ownWorldName'] == '《魔女》世界书·莉莉丝' and stored['orientation']['notes'].startswith('- 原伴侣：江酒（重新生成）')
        shot(page, '04-cards-published')

        # ---- 管理导向模板：复制内置 → 编辑 → 保存 → 导出 ----
        page.click('[data-act="orientation-manage"]')
        page.wait_for_selector('.nl-dialog[aria-label="卡的导向模板"]')
        dlg = '.nl-dialog[aria-label="卡的导向模板"]'
        assert ev(page, f'document.querySelector(\'{dlg} [data-ot-id].active\').dataset.otId') == 'orient_ntl', '打开时选中表单里的导向'
        assert page.locator(f'{dlg} [data-ot-act="duplicate"]').is_visible() and page.locator(f'{dlg} [data-ot-f]').count() == 0, '内置模板只读'
        shot(page, '05-manage-builtin')
        page.click(f'{dlg} [data-ot-act="duplicate"]')
        page.wait_for_selector(f'{dlg} [data-ot-f="name"]')
        assert page.input_value(f'{dlg} [data-ot-f="name"]') == 'NTL 2'
        page.fill(f'{dlg} [data-ot-f="name"]', '纯爱')
        page.click(f'{dlg} [data-ot-act="save"]')
        page.wait_for_selector(f'{dlg} [data-ot-err]:not([hidden])')
        assert '同名' in page.inner_text(f'{dlg} [data-ot-err]')
        page.fill(f'{dlg} [data-ot-f="name"]', '我的NTL')
        page.fill(f'{dlg} [data-ot-f="brief"]', '我改过的 NTL')
        page.fill(f'{dlg} [data-ot-f="entry"]', '【剧情导向：我的NTL】\n- 原伴侣会在关键时刻出现')
        page.fill(f'{dlg} [data-ot-f="depth"]', '3')
        page.fill(f'{dlg} [data-ot-f="order"]', '9')
        page.select_option(f'{dlg} [data-ot-f="role"]', '1')
        page.click(f'{dlg} [data-ot-act="save"]')
        page.wait_for_selector(f'{dlg} [data-ot-saved]:not([hidden])')
        mine = ev(page, 'NovelLoom.app.settings.orientationTemplates')
        print('my templates:', [(t['name'], t['depth'], t['role'], t['order']) for t in mine])
        assert len(mine) == 1 and mine[0]['name'] == '我的NTL' and mine[0]['depth'] == 3 and mine[0]['role'] == 1 and mine[0]['order'] == 9
        assert mine[0]['id'].startswith('otpl_')
        shot(page, '06-manage-mine')
        path = download(page, f'{dlg} [data-ot-act="export"]')
        exported = json.load(open(path, encoding='utf-8'))
        print('exported:', os.path.basename(path), exported['type'], [t['name'] for t in exported['templates']])
        assert exported['type'] == 'novel_loom_orientation_templates' and exported['templates'][0]['entry'].startswith('【剧情导向：我的NTL】')
        page.click(f'{dlg} .nl-dialog-foot button:has-text("关闭")')
        page.wait_for_selector(dlg, state='detached')
        groups = ev(page, '[...document.querySelectorAll("[data-form=orientationId] optgroup")].map((g) => g.label)')
        assert groups == ['内置', '我的模板'], groups
        mine_id = mine[0]['id']
        page.select_option('[data-form="orientationId"]', mine_id)
        assert '我改过的 NTL' in page.inner_text('[data-orient-brief]')

        # ---- 世界/旁白卡：卡名留空 = 书名（AI 写的「魔女旁白」不采用）；{{user}} 扮演江酒，主要角色资料里去掉江酒 ----
        page.select_option('[data-form="kind"]', 'world')
        page.wait_for_selector('#nl-card-name:visible')
        assert page.get_attribute('#nl-card-name', 'placeholder') == '魔女'
        assert ev(page, 'document.querySelector("[data-form=userRoleKind]").value') == 'character', '换卡片类型后保留 {{user}} 扮演的选择'
        page.select_option('[data-form="orientationId"]', '')
        page.click('[data-act="generate"]')
        page.wait_for_selector('.nl-dialog [data-card="description"]', timeout=20000)
        wc = ev(page, 'NovelLoom.app.project.cards.at(-1)')
        print('world card:', wc['data']['name'], wc['kind'], wc['orientation'])
        assert wc['kind'] == 'world' and wc['data']['name'] == '魔女' and wc['cardName'] == ''
        assert wc['orientation'] is None
        wp = ev(page, 'window.__stSeen.filter((t) => t.includes("这是一张“世界/旁白卡”")).at(-1)').replace('​', '')
        profiles = wp.split('# 角色资料（从原著提取）')[1].split('# 相关角色')[0]
        assert '姓名: 江酒' not in profiles and '姓名: 莉莉丝' in profiles
        assert ev(page, 'document.querySelector(".nl-dialog [data-orient-pick]").value') == ''
        page.click('.nl-dialog-foot button:has-text("取消")')
        page.wait_for_selector('.nl-dialog', state='detached')
        # 填了卡名就用卡名
        page.fill('#nl-card-name', '下城区旁白')
        page.dispatch_event('#nl-card-name', 'input')
        page.click('[data-act="generate"]')
        page.wait_for_selector('.nl-dialog [data-card="description"]', timeout=20000)
        assert ev(page, 'NovelLoom.app.project.cards.at(-1).data.name') == '下城区旁白'
        page.click('.nl-dialog-foot button:has-text("取消")')
        page.wait_for_selector('.nl-dialog', state='detached')
        shot(page, '07-cards-world')

        # ---- 设置页：卡的导向模板一节 ----
        page.click('.nl-nav-btn[data-tab="settings"]')
        page.wait_for_selector('[data-orient-settings]')
        sec = page.inner_text('[data-orient-settings]')
        assert '我的NTL' in sec and 'NTL' in sec and '模板库' in sec, sec
        page.locator('[data-orient-settings]').scroll_into_view_if_needed()
        shot(page, '08-settings-orientation')
        page.click('[data-act="orientation-templates"]')
        page.wait_for_selector('.nl-dialog[aria-label="卡的导向模板"]')
        page.click('.nl-dialog[aria-label="卡的导向模板"] .nl-dialog-foot button:has-text("关闭")')
        page.wait_for_selector('.nl-dialog', state='detached')
        # 整节重绘后焦点放回新的「模板库」按钮（不掉到 <body>）
        assert ev(page, '(document.activeElement && document.activeElement.dataset.act) || ""') == 'orientation-templates', ev(page, 'document.activeElement.outerHTML.slice(0, 80)')

        # 模板库：名称有问题时点「关闭」留在对话框并提示；按 Esc 关闭时名称不改、其他修改照样保存
        dlg = '.nl-dialog[aria-label="卡的导向模板"]'
        page.click('[data-act="orientation-templates"]')
        page.wait_for_selector(dlg)
        page.click(f'{dlg} [data-ot-id="{mine_id}"]')
        page.wait_for_selector(f'{dlg} [data-ot-f="name"]')
        detail = page.inner_text(f'{dlg} [data-ot-detail]')
        assert '消息角色' in detail and '\n角色\n' not in detail, '词条的消息角色不叫「角色」'
        assert page.get_attribute(f'{dlg} [data-ot-f="role"]', 'title') == '词条以哪种消息插入聊天：系统 / 用户 / AI'
        page.fill(f'{dlg} [data-ot-f="name"]', '')
        page.fill(f'{dlg} [data-ot-f="brief"]', '关闭前改的说明')
        page.click(f'{dlg} .nl-dialog-foot button:has-text("关闭")')
        page.wait_for_selector(f'{dlg} [data-ot-err]:not([hidden])')
        assert '名称不能为空' in page.inner_text(f'{dlg} [data-ot-err]')
        assert page.is_visible(dlg), '名称有问题时点「关闭」留在对话框里'
        shot(page, '08b-manage-close-blocked')
        page.keyboard.press('Escape')
        page.wait_for_selector(dlg, state='detached')
        t = ev(page, '(id) => NovelLoom.app.settings.orientationTemplates.find((x) => x.id === id)', mine_id)
        print('after Esc with empty name:', t['name'], '|', t['brief'])
        assert t['name'] == '我的NTL' and t['brief'] == '关闭前改的说明', t
        wait_log(page, '名称没有改')
        # 内置模板的标签：说明插入方式，不再只写「系统」
        page.click('[data-act="orientation-templates"]')
        page.wait_for_selector(dlg)
        page.click(f'{dlg} [data-ot-id="orient_ntl"]')
        assert '深度 4 · 以系统消息插入 · 顺序 100' in page.inner_text(f'{dlg} [data-ot-detail]')
        page.keyboard.press('Escape')
        page.wait_for_selector(dlg, state='detached')

        # ---- 同一角色的第二张卡（纯爱）：专用世界书不和第一张（NTL）重名，写入后两本互不覆盖；
        #      生成本书落点期间换了导向，落点不会填进新导向；误换导向再换回来，刚才的编辑还在 ----
        page.click('.nl-nav-btn[data-tab="cards"]')
        page.select_option('[data-form="kind"]', 'character')
        page.select_option('[data-form="charName"]', '莉莉丝')
        # 记住的 {{user}} 角色（江酒）正好是新选的卡片角色时：不悄悄换成别人，显示「请选择」；换回去后原来的选择还在
        page.select_option('[data-form="charName"]', '江酒')
        assert page.input_value('[data-ur-char]') == '', page.input_value('[data-ur-char]')
        assert '「江酒」' not in page.inner_text('[data-ur-note]')
        page.select_option('[data-form="charName"]', '莉莉丝')
        assert page.input_value('[data-ur-char]') == '江酒', page.input_value('[data-ur-char]')
        page.select_option('[data-form="orientationId"]', 'orient_pure')
        assert '与角色的关系' in page.inner_text('label:has(+ [data-form="requirement"])') and '{{user}} 的身份' not in page.inner_text('label:has(+ [data-form="requirement"])'), '「你的要求」不再让用户写 {{user}} 的身份'
        assert '上面的要求里不用再写 {{user}} 的身份' in page.inner_text('[data-ur-note]')
        page.click('[data-act="generate"]')
        page.wait_for_selector('.nl-dialog [data-card="description"]', timeout=20000)
        c2 = ev(page, 'NovelLoom.app.project.cards.at(-1)')
        assert c2['data']['name'] == '莉莉丝' and c2['orientation']['templateId'] == 'orient_pure', c2['orientation']
        world2 = page.input_value('.nl-dialog [data-card-world]')
        print('second card world:', world2)
        assert world2 == '《魔女》世界书·莉莉丝·纯爱', world2
        pick = '.nl-dialog [data-orient-pick]'
        page.evaluate('window.__notesHold = true; window.__releaseNotes = null')
        page.click('.nl-dialog [data-act="reroll-orient-notes"]')
        page.wait_for_selector('.nl-dialog[aria-label="重新生成本书落点"]')
        page.click('.nl-dialog[aria-label="重新生成本书落点"] .nl-dialog-foot button:has-text("确定")')
        page.wait_for_function('() => typeof window.__releaseNotes === "function"')
        page.select_option(pick, 'orient_ntl')
        assert page.input_value('.nl-dialog [data-orient-entry]').startswith('【剧情导向：NTL】')
        page.evaluate('window.__notesHold = false; window.__releaseNotes()')
        wait_log(page, '本书落点已按「纯爱」生成')
        page.wait_for_function('() => !document.querySelector(".nl-dialog [data-act=reroll-orient-notes]").disabled')
        assert page.input_value('.nl-dialog [data-orient-notes]') == '', '按纯爱写的落点没有填进 NTL'
        page.select_option(pick, 'orient_pure')
        notes2 = page.input_value('.nl-dialog [data-orient-notes]')
        print('pure notes after switching back:', notes2)
        assert notes2 == '- 心动的契机：江酒（纯爱）\n- 阻碍：魔女契约', notes2
        # 改了词条正文，误换成 NTR 再换回来：改的还在
        page.fill('.nl-dialog [data-orient-entry]', page.input_value('.nl-dialog [data-orient-entry]') + '\n- 改过的一行')
        page.select_option(pick, 'orient_ntr')
        assert page.input_value('.nl-dialog [data-orient-entry]').startswith('【剧情导向：NTR】')
        page.select_option(pick, 'orient_pure')
        assert page.input_value('.nl-dialog [data-orient-entry]').endswith('\n- 改过的一行')
        # 生成期间换成「不限」：结束后按钮保持禁用
        page.evaluate('window.__notesHold = true; window.__releaseNotes = null')
        page.click('.nl-dialog [data-act="reroll-orient-notes"]')
        page.wait_for_selector('.nl-dialog[aria-label="重新生成本书落点"]')
        page.click('.nl-dialog[aria-label="重新生成本书落点"] .nl-dialog-foot button:has-text("确定")')
        page.wait_for_function('() => typeof window.__releaseNotes === "function"')
        page.select_option(pick, '')
        page.evaluate('window.__notesHold = false; window.__releaseNotes()')
        page.wait_for_function('() => [...document.querySelectorAll(".nl-log-line")].filter((l) => l.textContent.includes("本书落点已按「纯爱」生成")).length >= 2')
        page.wait_for_function('() => !document.querySelector(".nl-dialog [data-act=reroll-orient-notes] .nl-spin")')
        assert page.is_disabled('.nl-dialog [data-act="reroll-orient-notes"]'), '选了「不限」后按钮保持禁用'
        page.select_option(pick, 'orient_pure')
        assert page.input_value('.nl-dialog [data-orient-notes]') == notes2 and page.input_value('.nl-dialog [data-orient-entry]').endswith('\n- 改过的一行')
        page.locator('.nl-dialog [data-orient-edit]').scroll_into_view_if_needed()
        shot(page, '13-second-card-orientation')
        page.click('.nl-dialog-foot button:has-text("保存并写入酒馆")')
        page.wait_for_function('() => [...document.querySelectorAll(".nl-log-line")].filter((l) => l.textContent.includes("已写入酒馆：角色「莉莉丝」")).length >= 2', timeout=30000)
        worlds = ev(page, 'Object.keys(window.__saved.worlds)')
        print('worlds after second card:', worlds)
        by1 = {e['comment']: e for e in ev(page, 'Object.values(window.__saved.worlds["《魔女》世界书·莉莉丝"].entries)')}
        by2 = {e['comment']: e for e in ev(page, 'Object.values(window.__saved.worlds["《魔女》世界书·莉莉丝·纯爱"].entries)')}
        assert '剧情导向：NTL' in by1 and '剧情导向：纯爱' not in by1, '第一张卡的世界书没被第二张覆盖'
        assert '剧情导向：纯爱' in by2 and '剧情导向：NTL' not in by2, list(by2)
        assert by2['剧情导向：纯爱']['content'].endswith('【本书落点】\n- 心动的契机：江酒（纯爱）\n- 阻碍：魔女契约') and '- 改过的一行' in by2['剧情导向：纯爱']['content']
        # 有导向时「{{user}} 的身份」说明以剧情导向为准
        assert '与「剧情导向」词条冲突时以剧情导向为准' in by2['{{user}} 的身份']['content']
        imp2 = json.loads(ev(page, 'window.__saved.lastImport.text'))
        assert imp2['data']['extensions']['world'] == '《魔女》世界书·莉莉丝·纯爱'
        assert ev(page, 'NovelLoom.app.project.cards.at(-1).ownWorldName') == '《魔女》世界书·莉莉丝·纯爱'

        # ---- 换了项目：{{user}} 扮演不沿用（不会默默选中新项目的第一个角色当 {{user}}）；回到原项目照旧 ----
        assert page.input_value('[data-form="userRoleKind"]') == 'character'
        real_id = ev(page, 'NovelLoom.app.project.id')
        page.click('.nl-nav-btn[data-tab="settings"]')
        ev(page, "() => { NovelLoom.app.project.id = 'smoke-other-project'; }")
        page.click('.nl-nav-btn[data-tab="cards"]')
        page.wait_for_selector('[data-form="userRoleKind"]')
        assert page.input_value('[data-form="userRoleKind"]') == 'new', '别的项目不沿用「原著角色」'
        assert page.is_hidden('[data-ur-char]')
        page.click('.nl-nav-btn[data-tab="settings"]')
        ev(page, '(id) => { NovelLoom.app.project.id = id; }', real_id)
        page.click('.nl-nav-btn[data-tab="cards"]')
        page.wait_for_selector('[data-form="userRoleKind"]')
        assert page.input_value('[data-form="userRoleKind"]') == 'character', '同一个项目里照旧沿用'
        assert page.is_visible('[data-ur-char]')

        # ---- 窄屏 ----
        page.set_viewport_size({'width': 390, 'height': 844})
        page.click('.nl-nav-btn[data-tab="cards"]')
        page.select_option('[data-form="kind"]', 'character')
        page.select_option('[data-form="orientationId"]', '__custom__')
        page.wait_for_selector('[data-orient-custom]:not([hidden])')
        page.locator('[data-form="orientationId"]').scroll_into_view_if_needed()
        assert ev(page, 'document.documentElement.scrollWidth <= window.innerWidth + 1'), '窄屏没有横向滚动'
        shot(page, '09-mobile-card-form')
        page.click('#nl-tab [data-act="edit"] >> nth=-1')
        page.wait_for_selector('.nl-dialog [data-orient-edit]')
        # 编辑框顶部：名称与「绑定世界书名称（本卡专用）」在窄屏换行，不挤成一两个字宽
        widths = ev(page, '[...document.querySelectorAll(".nl-dialog .nl-card-edit-head > .nl-field")].map((f) => Math.round(f.getBoundingClientRect().width))')
        print('mobile editor head field widths:', widths)
        assert all(w >= 150 for w in widths), widths
        shot(page, '10-mobile-editor-head')
        page.locator('.nl-dialog [data-orient-edit]').scroll_into_view_if_needed()
        shot(page, '11-mobile-editor-orientation')
        page.click('.nl-dialog-foot button:has-text("取消")')
        page.click('[data-act="orientation-manage"]')
        page.wait_for_selector('.nl-dialog[aria-label="卡的导向模板"]')
        page.click(f'.nl-dialog[aria-label="卡的导向模板"] [data-ot-id="{mine_id}"]')
        page.wait_for_selector('.nl-dialog [data-ot-f="entry"]')
        shot(page, '12-mobile-manage')
        browser.close()
finally:
    server.terminate()

real = [e for e in errors if 'favicon' not in e]
print('ERRORS:', json.dumps(real, ensure_ascii=False))
sys.exit(1 if real else 0)
