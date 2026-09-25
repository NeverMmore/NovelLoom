// AI 响应清洗与 JSON 容错解析

export function parseTagList(input) {
    return String(input || '')
        .split(/[\s,，;；]+/)
        .map((t) => t.trim().replace(/^<|\/?>$/g, ''))
        .filter(Boolean);
}

function escapeRe(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 移除思考类标签及其内容。
 * 对于只有闭合标签（如开头缺失 <think>）的情况，移除从开头到闭合标签的内容。
 */
export function removeTags(text, tags) {
    let out = String(text ?? '');
    for (const tag of parseTagList(tags)) {
        const t = escapeRe(tag);
        out = out.replace(new RegExp(`<${t}(?:\\s[^>]*)?>[\\s\\S]*?<\\/${t}>`, 'gi'), '');
        const orphanClose = new RegExp(`^[\\s\\S]*?<\\/${t}>`, 'i');
        if (!new RegExp(`<${t}(?:\\s[^>]*)?>`, 'i').test(out) && orphanClose.test(out)) {
            out = out.replace(orphanClose, '');
        }
        // 未闭合的开标签（被截断）：移除到结尾
        out = out.replace(new RegExp(`<${t}(?:\\s[^>]*)?>[\\s\\S]*$`, 'i'), '');
    }
    return out.trim();
}

/** 只保留指定标签内的内容（多个用分隔符连接），找不到时返回原文 */
export function extractTagContents(text, tags, separator = '\n\n') {
    const list = parseTagList(tags);
    if (!list.length) return String(text ?? '');
    const parts = [];
    for (const tag of list) {
        const t = escapeRe(tag);
        const re = new RegExp(`<${t}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${t}>`, 'gi');
        let m;
        while ((m = re.exec(text)) !== null) parts.push(m[1].trim());
    }
    return parts.length ? parts.join(separator) : '';
}

/** 状态机修复：字符串中的裸换行、未转义引号、尾逗号、截断 */
export function repairJson(src) {
    let s = String(src || '').trim();
    let out = '';
    let inStr = false;
    let esc = false;
    const stack = [];
    for (let i = 0; i < s.length; i++) {
        const ch = s[i];
        if (inStr) {
            if (esc) {
                out += ch;
                esc = false;
                continue;
            }
            if (ch === '\\') {
                out += ch;
                esc = true;
                continue;
            }
            if (ch === '"') {
                // 判断是否为真正的字符串结束：后面（跳过空白）应为 , : } ] 或结尾
                let j = i + 1;
                while (j < s.length && /\s/.test(s[j])) j++;
                const next = s[j];
                if (next === undefined || next === ',' || next === ':' || next === '}' || next === ']') {
                    inStr = false;
                    out += ch;
                } else {
                    out += '\\"';
                }
                continue;
            }
            if (ch === '\n') {
                out += '\\n';
                continue;
            }
            if (ch === '\r') continue;
            if (ch === '\t') {
                out += '\\t';
                continue;
            }
            out += ch;
            continue;
        }
        if (ch === '"') {
            inStr = true;
            out += ch;
            continue;
        }
        if (ch === '{' || ch === '[') stack.push(ch);
        if (ch === '}' || ch === ']') stack.pop();
        out += ch;
    }
    if (inStr) out += '"';
    // 去掉尾逗号
    out = out.replace(/,\s*([}\]])/g, '$1');
    // 截断补全
    out = out.replace(/,\s*$/, '');
    out = out.replace(/:\s*$/, ': null');
    while (stack.length) {
        const open = stack.pop();
        out = out.replace(/,\s*$/, '');
        out += open === '{' ? '}' : ']';
    }
    return out;
}

function sliceOutermost(text) {
    const s = String(text);
    const first = s.search(/[{[]/);
    if (first < 0) return null;
    const open = s[first];
    const close = open === '{' ? '}' : ']';
    const last = s.lastIndexOf(close);
    if (last > first) return s.slice(first, last + 1);
    return s.slice(first); // 可能被截断
}

/**
 * 从 AI 响应中提取 JSON 对象
 * @returns {any} 解析结果；失败抛错
 */
export function extractJson(text) {
    const raw = String(text ?? '').trim();
    const attempts = [];
    attempts.push(raw);
    const fence = [...raw.matchAll(/```(?:json|JSON)?\s*([\s\S]*?)```/g)].map((m) => m[1]);
    attempts.push(...fence.sort((a, b) => b.length - a.length));
    const outer = sliceOutermost(raw);
    if (outer) attempts.push(outer);
    // 未闭合的代码块（被截断）
    const openFence = raw.match(/```(?:json|JSON)?\s*([\s\S]*)$/);
    if (openFence) attempts.push(openFence[1]);

    for (const a of attempts) {
        try {
            return JSON.parse(a);
        } catch { /* next */ }
    }
    for (const a of attempts) {
        const first = String(a).search(/[{[]/);
        const cands = [];
        if (first >= 0) cands.push(String(a).slice(first)); // 从第一个括号到结尾（适合被截断的输出）
        const outer = sliceOutermost(a);
        if (outer) cands.push(outer); // 到最后一个闭括号（适合 JSON 后面还有闲聊）
        for (const cand of cands) {
            try {
                return JSON.parse(repairJson(cand));
            } catch { /* next */ }
        }
    }
    const err = new Error('无法从 AI 响应中解析 JSON');
    err.code = 'JSON_PARSE';
    err.raw = raw.slice(0, 2000);
    throw err;
}
