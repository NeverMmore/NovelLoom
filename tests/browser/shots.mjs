// 设计回归截图：用无头 Chrome/Edge 打开 harness.html?shot=<页面>，等示例项目准备好后，在桌面与手机宽度各截一张。
// 用法：node tests/browser/shots.mjs <输出目录> [页面[:参数]...]
//   例：node tests/browser/shots.mjs .impeccable/review/shots characters "characters:select=.nl-char-item" "plan:log=1"
// 需要先在仓库根目录起静态服务器：python -m http.server 8768 --bind 127.0.0.1
// 无依赖（Node 22+ 自带 WebSocket），通过 DevTools 协议驱动浏览器。
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const [outDir = '.impeccable/review/shots', ...args] = process.argv.slice(2);
const TABS = args.length ? args : ['project', 'chunks', 'extract', 'characters', 'relations', 'worldbook', 'outline', 'style', 'cards', 'plan', 'foreshadow', 'continue', 'settings'];
const PORT = process.env.SHOT_PORT || 8768;
const SIZES = (process.env.SHOT_SIZES || 'desktop:1440x900,mobile:390x844').split(',').map((s) => {
    const [name, wh] = s.split(':');
    const [w, h] = wh.split('x').map(Number);
    return { name, w, h };
});
const BROWSERS = [
    process.env.SHOT_BROWSER,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);
const browserPath = BROWSERS.find((b) => existsSync(b));
if (!browserPath) throw new Error('找不到 Chrome / Edge，可用 SHOT_BROWSER 指定');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const debugPort = 9300 + Math.floor(Math.random() * 500);
const profile = mkdtempSync(join(tmpdir(), 'nl-shots-'));
const proc = spawn(browserPath, ['--headless=new', '--disable-gpu', '--hide-scrollbars', `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });

async function cdpConnect() {
    for (let i = 0; i < 100; i++) {
        try {
            const list = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
            const page = list.find((t) => t.type === 'page');
            if (page) return page.webSocketDebuggerUrl;
        } catch { /* 浏览器还没起来 */ }
        await sleep(100);
    }
    throw new Error('连接浏览器调试端口超时');
}

const ws = new WebSocket(await cdpConnect());
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let seq = 0;
const pending = new Map();
ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
        const { resolve, reject } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
    }
});
const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
});
const evaluate = async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true })).result.value;

mkdirSync(outDir, { recursive: true });
try {
    for (const spec of TABS) {
        const [tab, query = ''] = spec.split(':');
        for (const size of SIZES) {
            await send('Emulation.setDeviceMetricsOverride', { width: size.w, height: size.h, deviceScaleFactor: 1, mobile: size.w < 768 });
            // 每张图用全新的数据：清掉上一轮存下的项目
            await send('Storage.clearDataForOrigin', { origin: `http://127.0.0.1:${PORT}`, storageTypes: 'all' });
            const extra = query ? `&${query.split(',').map((kv) => kv.split('=').map(encodeURIComponent).join('=')).join('&')}` : '';
            await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/tests/browser/harness.html?shot=${tab}${extra}` });
            let state = '';
            for (let i = 0; i < 300; i++) {
                await sleep(100);
                state = await evaluate('document.documentElement.dataset.shot || ""').catch(() => '');
                if (state === 'ready' || state.startsWith('error')) break;
            }
            if (state !== 'ready') console.warn(`⚠️ ${spec} @${size.name}: ${state || '超时'}`);
            const shot = await send('Page.captureScreenshot', { format: 'png' });
            const file = join(outDir, `${tab}${query ? `-${query.replace(/[^\w]+/g, '_')}` : ''}-${size.name}.png`);
            writeFileSync(file, Buffer.from(shot.data, 'base64'));
            console.log(file);
        }
    }
} finally {
    ws.close();
    proc.kill();
    await sleep(300);
    try {
        rmSync(profile, { recursive: true, force: true });
    } catch { /* Windows 上浏览器可能还占着文件 */ }
}
