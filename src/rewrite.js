// 局部重写：只重写正文中选中的一段，前后文用于保持衔接；复用文风、禁用词与消息链设置

import { callLLM, chainFor } from './llm.js';
import { removeTags } from './json.js';
import { getPrompt, render } from './prompts.js';
import { bannedListFor, checkBanned, replaceBanned, styleTextFor } from './style.js';

function cleanRewrite(text, filterTags) {
    let t = removeTags(text, filterTags).replace(/^```[a-z]*\n?|```\s*$/g, '').trim();
    t = t.replace(/^<(?:selected|text)>\n?/i, '').replace(/\n?<\/(?:selected|text)>$/i, '').trim();
    return t;
}

/** 构建局部重写的 system / prompt（也用于设置页的提示词预览） */
export function buildRewritePrompt(project, settings, { selected, before = '', after = '', instruction, task = 'continue', povChar }) {
    const vars = {
        BOOK: project.bookName || project.name || '',
        STYLE: styleTextFor(project, settings, task, povChar),
        BEFORE: before || '（无，这是开头）',
        SELECTED: selected,
        AFTER: after || '（无，这是结尾）',
        INSTRUCTION: String(instruction || '').trim(),
    };
    return {
        system: render(getPrompt(settings, 'rewriteSystem'), vars),
        prompt: render(getPrompt(settings, 'rewrite'), vars),
    };
}

/**
 * 局部重写：把 text[start:end) 按 instruction 重写，前后各取 contextChars 字作为衔接上下文（不会被重写，只用来保证衔接）
 * @param {{text:string, start:number, end:number, instruction:string, api:object, task?:string, contextChars?:number, signal?:AbortSignal, onNotice?:Function}} opt
 * @returns {Promise<{text:string, rewritten:string, start:number, end:number, bannedHits:number}>} text 是替换后的完整正文；start/end 是重写结果在新正文中的范围
 */
export async function rewriteSelection(project, settings, opt = {}) {
    const { start, end, instruction, api, task = 'continue', contextChars = 400, signal, onNotice, povChar } = opt;
    const full = String(opt.text || '');
    const s = Math.max(0, Math.min(full.length, Number(start) || 0));
    const e = Math.max(s, Math.min(full.length, Number(end) || 0));
    const selected = full.slice(s, e);
    if (!selected.trim()) throw new Error('请先在正文中选中要重写的部分');
    if (!String(instruction || '').trim()) throw new Error('请说明重写要求');
    const before = full.slice(Math.max(0, s - contextChars), s);
    const after = full.slice(e, Math.min(full.length, e + contextChars));
    const { system, prompt } = buildRewritePrompt(project, settings, { selected, before, after, instruction, task, povChar });
    const res = await callLLM({
        api: api || settings.api,
        system,
        prompt,
        ...chainFor(settings, 'rewrite', project),
        expect: 'prose',
        signal,
        onNotice,
    });
    let rewritten = cleanRewrite(res.text, settings.extraction?.filterTags);
    if (!rewritten) throw new Error('AI 没有返回有效内容');
    // 本地禁用词清理：能按建议替换的直接替换，替换不了的留给调用方提示
    let bannedHits = checkBanned(rewritten, project, settings, task, povChar).length;
    if (bannedHits) {
        const r = replaceBanned(rewritten, bannedListFor(project, settings, task, povChar));
        if (r.count) {
            rewritten = r.text;
            bannedHits = checkBanned(rewritten, project, settings, task, povChar).length;
        }
    }
    const newFullText = full.slice(0, s) + rewritten + full.slice(e);
    return { text: newFullText, rewritten, start: s, end: s + rewritten.length, bannedHits };
}
