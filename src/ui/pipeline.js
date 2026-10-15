// 流程状态：项目页的流程清单和侧栏共用同一套判断，保证两处说的“完成 / 下一步”一致

import { projectHasSource } from '../original.js';
import { projectStats } from '../project.js';

/**
 * 没有原文的项目（原创项目，或分段被全部删掉的项目）：不需要分段和提取，下一步就是「角色卡」原创写卡；
 * 角色、世界书等整理步骤都是可选的（原创写卡时 AI 设计的角色和设定会存进来）。
 * @returns {{steps: {tab:string, name:string, optional?:boolean, ok:boolean, note:string}[], next: object|null}}
 */
export function pipelineState(p) {
    if (!p) return { steps: [], next: null };
    const st = projectStats(p);
    const rels = (p.relationships || []).length;
    const cards = { tab: 'cards', name: '生成角色卡并写入酒馆', ok: !!p.cards.length, note: p.cards.length ? `${p.cards.length} 张` : '' };
    const style = { tab: 'style', name: '调整文风', optional: true, ok: !!(p.style?.samples?.length || p.style?.rules || p.style?.banned), note: '' };
    const relations = { tab: 'relations', name: '梳理关系', optional: true, ok: !!rels, note: rels ? `${rels} 条关系` : '' };
    if (!projectHasSource(p)) {
        const steps = [
            { ...cards, name: '原创写卡并写入酒馆' },
            { tab: 'characters', name: '校对角色', optional: true, ok: !!st.characters, note: st.characters ? `${st.characters} 个角色` : '' },
            { tab: 'worldbook', name: '校对世界书', optional: true, ok: !!st.entries, note: st.entries ? `${st.entries} 个条目` : '' },
            relations,
            style,
        ];
        return { steps, next: steps.find((s) => !s.optional && !s.ok) || null, stats: st };
    }
    const steps = [
        { tab: 'chunks', name: '检查分段', ok: !!st.chunks, note: st.chunks ? `${st.chunks} 段` : '' },
        { tab: 'extract', name: '提取资料', ok: !!st.chunks && st.done === st.chunks, note: st.chunks ? `${st.done}/${st.chunks} 段` : '' },
        { tab: 'characters', name: '校对角色', ok: !!st.characters, note: st.characters ? `${st.characters} 个角色` : '' },
        relations,
        { tab: 'worldbook', name: '校对世界书', ok: !!st.entries, note: st.entries ? `${st.entries} 个条目` : '' },
        style,
        cards,
        { tab: 'plan', name: '写后续大纲', optional: true, ok: !!p.plan?.chapters?.length, note: p.plan?.chapters?.length ? `${p.plan.chapters.length} 章` : '' },
        { tab: 'continue', name: '按大纲续写', optional: true, ok: !!st.generated, note: st.generated ? `${st.generated} 章` : '' },
    ];
    return { steps, next: steps.find((s) => !s.optional && !s.ok) || null, stats: st };
}
