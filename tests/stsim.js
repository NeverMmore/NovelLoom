// 测试用：模拟酒馆显示消息时对状态栏代码块的处理（与 tests/statusbar.test.js 里的同名函数一致，供新测试文件复用）
import assert from 'node:assert/strict';

// fixMarkdown 里的空白字符集（源文件里不直接写不可见字符）
const MD_SPACE = ['\t', ' ', ...[0xa0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a, 0x202f, 0x205f, 0x3000, 0xfeff].map((c) => String.fromCharCode(c))].join('');
const MD_SPACE_AROUND = new RegExp(`(\\*|_)([${MD_SPACE}]+)|([${MD_SPACE}]+)(\\*|_)`, 'g');

/** 酒馆 1.19 public/scripts/power-user.js fixMarkdown 的移植（见 tests/statusbar.test.js 的说明） */
export function stFixMarkdown(text, forDisplay) {
    const format = /([*_]{1,2})([\s\S]*?)\1/gm;
    const matches = [];
    let match;
    while ((match = format.exec(text)) !== null) matches.push(match);
    let newText = text;
    for (let i = matches.length - 1; i >= 0; i--) {
        const matchText = matches[i][0];
        const replacementText = matchText.replace(MD_SPACE_AROUND, '$1$4');
        newText = newText.slice(0, matches[i].index) + replacementText + newText.slice(matches[i].index + matchText.length);
    }
    if (!forDisplay) return newText;
    const splitText = newText.split('\n');
    for (let index = 0; index < splitText.length; index++) {
        const line = splitText[index];
        for (const char of ['*', '"']) {
            if (line.includes(char) && (line.split(char).length - 1) % 2 === 1) splitText[index] = line.trimEnd() + char;
        }
    }
    return splitText.join('\n');
}

function htmlTextDecode(html) {
    const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
    return html.replace(/&(?:#(\d+)|#[xX]([0-9a-fA-F]+)|(amp|lt|gt|quot|apos));/g, (m, dec, hex, name) => (name ? named[name] : String.fromCodePoint(dec ? Number(dec) : parseInt(hex, 16))));
}

/** 代码块 → iframe 实际收到的文本（showdown 转义 → messageFormatting 还原 &amp; → 酒馆助手 .text() 解码实体） */
export function stIframeText(message) {
    const m = message.match(/```[^\n]*\n([\s\S]*?)\n```/);
    assert.ok(m, '消息里应有代码块');
    const showdown = m[1].replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const st = showdown.replace(/&amp;/g, '&');
    return htmlTextDecode(st);
}

export function scriptsOf(html) {
    return [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi)].map((m) => m[1]);
}

/** 把编译出的变量结构脚本变成真实的 zod Schema：去掉 import 行和 $(…) 注册行，注入 z */
export function loadSchema(code, z) {
    const body = code.split('\n').filter((l) => !/^import\s/.test(l) && !/^\$\(/.test(l)).join('\n').replace('export const Schema', 'const Schema');
    return new Function('z', `${body}\nreturn Schema;`)(z);
}

/** 固定序列的“随机数”，让随机示例可重复 */
export function seededRng(seed = 1) {
    let s = seed >>> 0 || 1;
    return () => {
        s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
        return s / 4294967296;
    };
}

/** 正文里的 * _ " 会改变 fixMarkdown 的配对，几种都试一遍 */
export const PROSES = ['正文。', '*他笑了', '_斜体', '**粗体', '"没写完的引号', '*a* _b_ "c"'];
