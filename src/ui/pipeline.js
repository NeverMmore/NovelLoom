// 流程状态：项目页的流程清单和侧栏共用同一套判断，保证两处说的“完成 / 下一步”一致

import { projectStats } from '../project.js';

/**
 * @returns {{steps: {tab:string, name:string, optional?:boolean, ok:boolean, note:string}[], next: object|null}}
 */
export function pipelineState(p) {
    if (!p) return { steps: [], next: null };
    const st = projectStats(p);
    const rels = (p.relationships || []).length;
    const steps = [
        { tab: 'chunks', name: '检查分段', ok: !!st.chunks, note: st.chunks ? `${st.chunks} 段` : '' },
        { tab: 'extract', name: '提取资料', ok: !!st.chunks && st.done === st.chunks, note: st.chunks ? `${st.done}/${st.chunks} 段` : '' },
        { tab: 'characters', name: '校对角色', ok: !!st.characters, note: st.characters ? `${st.characters} 个角色` : '' },
        { tab: 'relations', name: '梳理关系', optional: true, ok: !!rels, note: rels ? `${rels} 条关系` : '' },
        { tab: 'worldbook', name: '校对世界书', ok: !!st.entries, note: st.entries ? `${st.entries} 个条目` : '' },
        { tab: 'style', name: '调整文风', optional: true, ok: !!(p.style?.samples?.length || p.style?.rules || p.style?.banned), note: '' },
        { tab: 'cards', name: '生成角色卡并写入酒馆', ok: !!p.cards.length, note: p.cards.length ? `${p.cards.length} 张` : '' },
        { tab: 'plan', name: '写后续大纲', optional: true, ok: !!p.plan?.chapters?.length, note: p.plan?.chapters?.length ? `${p.plan.chapters.length} 章` : '' },
        { tab: 'continue', name: '按大纲续写', optional: true, ok: !!st.generated, note: st.generated ? `${st.generated} 章` : '' },
    ];
    return { steps, next: steps.find((s) => !s.optional && !s.ok) || null, stats: st };
}
