// 章节识别与分块

import { chineseNumToInt, uid } from './utils.js';

const VOL_NUM = '零〇一二两三四五六七八九十百千万0-9０-９';
const VOLUME_RE = new RegExp(`第\\s*([${VOL_NUM}]+)\\s*[卷部]`);
const VOLUME_LINE_RE = new RegExp(`^[ \\t\\u3000]*第\\s*[${VOL_NUM}]+\\s*[卷部][^\\n]{0,40}$`, 'gm');

/**
 * 从标题中识别卷：「第一卷 初入江湖」「第二部」「第三卷 风起 第十二章 夜雨」
 * @returns {{key:string, name:string}|null}
 */
export function volumeKeyOf(title) {
    const t = String(title || '').trim();
    const m = t.match(VOLUME_RE);
    if (!m || m.index > 6) return null;
    let name = t.slice(m.index);
    const chap = name.slice(m[0].length).search(/第\s*[零〇一二两三四五六七八九十百千万0-9０-９]+\s*[章回节]/);
    if (chap >= 0) name = name.slice(0, m[0].length + chap);
    const raw = m[1].replace(/\s/g, '');
    const n = chineseNumToInt(raw);
    return { key: Number.isNaN(n) ? raw : String(n), name: name.trim().slice(0, 30) };
}

/**
 * 按章节正则切分全文
 * @param {string} text
 * @param {string} pattern 正则源码（按行匹配，自动加 m 标志）
 * @returns {{title:string, content:string, start:number, end:number, volumeKey?:string, volumeName?:string}[]}
 */
export function detectChapters(text, pattern) {
    const src = String(text || '');
    if (!pattern) return [{ title: '全文', content: src, start: 0, end: src.length }];
    let re;
    try {
        re = new RegExp(pattern, 'gm');
    } catch (e) {
        throw new Error(`章节正则无效：${e.message}`);
    }
    const byIndex = new Map();
    let m;
    while ((m = re.exec(src)) !== null) {
        if (m[0].length === 0) {
            re.lastIndex++;
            continue;
        }
        byIndex.set(m.index, m[0].trim());
    }
    // 卷标题行无论章节正则是否覆盖都作为分界
    VOLUME_LINE_RE.lastIndex = 0;
    while ((m = VOLUME_LINE_RE.exec(src)) !== null) {
        const idx = m.index + (m[0].length - m[0].trimStart().length);
        if (![...byIndex.keys()].some((k) => Math.abs(k - idx) <= 3)) byIndex.set(idx, m[0].trim());
    }
    const marks = [...byIndex.entries()].sort((a, b) => a[0] - b[0]).map(([index, title]) => ({ index, title }));
    if (!marks.length) return [{ title: '全文', content: src, start: 0, end: src.length }];

    const raw = [];
    for (let i = 0; i < marks.length; i++) {
        const start = marks[i].index;
        const end = i + 1 < marks.length ? marks[i + 1].index : src.length;
        raw.push({ title: marks[i].title, content: src.slice(start, end), start, end });
    }
    // 只有标题、没有正文的行：卷标题并入下一章（保留卷信息），其他（常见于目录）并入前一章，保证不丢字
    const cleaned = [];
    const preface = { title: '序', content: src.slice(0, marks[0].index), start: 0, end: marks[0].index };
    let carry = null;
    for (const ch of raw) {
        const body = ch.content.slice(ch.content.indexOf(ch.title) + ch.title.length).trim();
        const vol = volumeKeyOf(ch.title);
        if (body.length <= 2) {
            if (vol) {
                carry = carry ? { ...carry, content: carry.content + ch.content, end: ch.end, vol } : { content: ch.content, start: ch.start, end: ch.end, vol };
            } else if (carry) {
                carry.content += ch.content;
                carry.end = ch.end;
            } else {
                const prev = cleaned[cleaned.length - 1] || preface;
                prev.content += ch.content;
                prev.end = ch.end;
            }
            continue;
        }
        const item = { ...ch };
        if (carry) {
            item.content = carry.content + item.content;
            item.start = carry.start;
            item.volume = carry.vol;
            carry = null;
        }
        if (vol) item.volume = vol;
        cleaned.push(item);
    }
    if (carry) {
        const prev = cleaned[cleaned.length - 1] || preface;
        prev.content += carry.content;
        prev.end = carry.end;
    }
    if (preface.content.trim()) {
        if (preface.content.trim().length > 50 || !cleaned.length) {
            cleaned.unshift(preface);
        } else {
            // 很短的序言（书名、作者行）并入第一章
            cleaned[0] = { ...cleaned[0], content: preface.content + cleaned[0].content, start: 0 };
        }
    } else if (preface.content && cleaned.length) {
        cleaned[0] = { ...cleaned[0], content: preface.content + cleaned[0].content, start: 0 };
    }
    // 卷信息向后继承
    let cur = null;
    for (const ch of cleaned) {
        if (ch.volume) cur = ch.volume;
        delete ch.volume;
        if (cur) {
            ch.volumeKey = cur.key;
            ch.volumeName = cur.name;
        }
    }
    return cleaned.length ? cleaned : [{ title: '全文', content: src, start: 0, end: src.length }];
}

/** 在 maxLen 附近寻找合适断点（段落 > 句末 > 硬切） */
export function findBreak(text, maxLen) {
    if (text.length <= maxLen) return text.length;
    const floor = Math.floor(maxLen * 0.5);
    const para = text.lastIndexOf('\n', maxLen);
    if (para > floor) return para + 1;
    const window = text.slice(floor, maxLen);
    const m = [...window.matchAll(/[。！？!?…」』”]/g)].pop();
    if (m) return floor + m.index + 1;
    return maxLen;
}

export function splitBySize(text, size) {
    const parts = [];
    let rest = String(text || '');
    let offset = 0;
    while (rest.length > 0) {
        const cut = findBreak(rest, size);
        parts.push({ content: rest.slice(0, cut), start: offset, end: offset + cut });
        offset += cut;
        rest = rest.slice(cut);
    }
    return parts;
}

function makeChunk({ content, titles, start, end, volumeKey = null, volumeName = '' }) {
    const title = titles.length <= 1 ? titles[0] || '片段' : `${titles[0]} ～ ${titles[titles.length - 1]}`;
    return {
        id: uid('c_'),
        index: 0,
        title,
        chapterTitles: titles,
        content,
        charCount: content.length,
        start,
        end,
        origin: 'source',
        status: 'pending',
        error: '',
        attempts: 0,
        outline: [],
        processedAt: 0,
        volumeKey,
        volumeName,
    };
}

/**
 * 将章节打包为分块
 * @param {{title:string, content:string, start:number, end:number}[]} chapters
 * @param {number} chunkSize
 * @param {boolean} mergeSmall 最后一块过小时并入前一块
 */
export function buildChunks(chapters, chunkSize = 12000, mergeSmall = true) {
    const size = Math.max(1000, chunkSize | 0);
    const chunks = [];
    let buf = null;

    const flush = () => {
        if (buf && buf.content.trim()) chunks.push(makeChunk(buf));
        buf = null;
    };

    for (const ch of chapters) {
        const vk = ch.volumeKey ?? null;
        // 不同卷的章节不放进同一段
        if (buf && vk !== buf.volumeKey) flush();
        if (ch.content.length > size) {
            flush();
            const parts = splitBySize(ch.content, size);
            parts.forEach((p, i) => {
                chunks.push(makeChunk({
                    content: p.content,
                    titles: [parts.length > 1 ? `${ch.title}（${i + 1}/${parts.length}）` : ch.title],
                    start: ch.start + p.start,
                    end: ch.start + p.end,
                    volumeKey: vk,
                    volumeName: ch.volumeName || '',
                }));
            });
            continue;
        }
        if (buf && buf.content.length + ch.content.length > size) flush();
        if (!buf) buf = { content: '', titles: [], start: ch.start, end: ch.end, volumeKey: vk, volumeName: ch.volumeName || '' };
        buf.content += ch.content;
        buf.titles.push(ch.title);
        buf.end = ch.end;
    }
    flush();

    if (mergeSmall && chunks.length >= 2) {
        const last = chunks[chunks.length - 1];
        const prev = chunks[chunks.length - 2];
        if (last.charCount < size * 0.25 && prev.charCount + last.charCount <= size * 1.3 && last.volumeKey === prev.volumeKey) {
            const merged = makeChunk({
                content: prev.content + last.content,
                titles: [...prev.chapterTitles, ...last.chapterTitles],
                start: prev.start,
                end: last.end,
                volumeKey: prev.volumeKey,
                volumeName: prev.volumeName,
            });
            chunks.splice(chunks.length - 2, 2, merged);
        }
    }
    chunks.forEach((c, i) => (c.index = i));
    return chunks;
}

export function splitNovel(text, { pattern, chunkSize, mergeSmall }) {
    const chapters = detectChapters(text, pattern);
    return { chapters, chunks: buildChunks(chapters, chunkSize, mergeSmall) };
}

/** 合并相邻两块（用于手动调整） */
export function mergeTwoChunks(a, b) {
    const m = makeChunk({
        content: a.content + b.content,
        titles: [...(a.chapterTitles || [a.title]), ...(b.chapterTitles || [b.title])],
        start: a.start,
        end: b.end,
    });
    m.origin = a.origin === b.origin ? a.origin : 'mixed';
    return m;
}

export function reindexChunks(chunks) {
    chunks.forEach((c, i) => (c.index = i));
    return chunks;
}
