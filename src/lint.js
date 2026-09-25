// 本地写作质量扫描（不消耗 token）
// 规则压缩自 ai4rpg/tavern-cards 的 rules-check.md（绝对零度 / 八股化 / 破折号 / 假性主体与远距离叙事 / 占位符）

export const LINT_RULES = [
    { id: 'dash', type: '破折号', level: 'error', re: /——|(?<!-)--(?!-)/g, tip: '删掉破折号及同义补述，或改为逗号/冒号/省略号' },
    { id: 'vague', type: '模糊词', level: 'error', re: /似乎|仿佛|宛如|如同|近似|宛若|恍若/g, tip: '删除虚指，或改为行为呈现' },
    { id: 'micro', type: '八股微表情', level: 'error', re: /嘴角(?:微微)?(?:上扬|勾起|扬起|弯起)|(?:眼|眸|眼底|眼中|眸中|眸底)(?:中|里)?闪过一丝|闪过一丝|一抹(?:笑意|笑容|红晕)/g, tip: '删除，或改为简洁动作' },
    { id: 'cliche', type: '陈旧比喻', level: 'error', re: /心湖|泛起(?:一丝|阵阵)?涟漪|投石入湖|像(?:一只)?(?:受惊的)?小兽/g, tip: '删除比喻，直陈事实' },
    { id: 'voice', type: '语气声线描写', level: 'warn', re: /带着[^，。！？\n]{1,10}的(?:口吻|语气|腔调)|用[^，。！？\n]{1,8}的语气/g, tip: '删除，让对话本身传达语气' },
    { id: 'extreme', type: '极端情绪词', level: 'warn', re: /万念俱灰|极大的(?:恐惧|痛苦|悲伤)|无尽的(?:悲伤|绝望|黑暗)|撕心裂肺/g, tip: '改为具体行为或状态' },
    { id: 'subjective', type: '主观评价', level: 'warn', re: /(?:非常|极其|十分|无比|格外)(?:善良|温柔|美丽|漂亮|可爱|优秀|强大|聪明|冷漠|高冷|迷人|完美)/g, tip: '改为具体行为展现' },
    { id: 'label', type: '标签化', level: 'warn', re: /性格(?:温柔|善良|开朗|活泼|高冷|冷漠)(?:善良|温柔|开朗|活泼)?/g, tip: '用具体行为替代性格标签' },
    { id: 'announce', type: '情绪宣告', level: 'warn', re: /感到一(?:阵|股|丝)|一股[^，。\n]{0,8}(?:涌上|涌了上来|蔓延|袭来)|被一种[^，。\n]{0,10}(?:包裹|笼罩)|内心深处/g, tip: '改为行为或对话' },
    { id: 'god', type: '上帝视角', level: 'warn', re: /并不知道，|殊不知|命运的齿轮|这个决定将改变/g, tip: '删除预告式叙述' },
    { id: 'placeholder', type: '占位符', level: 'error', re: /某(?:城市|座城|地|人|组织|学校|公司|国家|个地方)|XX|xxx|（待补充）|待定/g, tip: '写出具体名称' },
    { id: 'turn', type: '否定转折', level: 'info', re: /不是[^，。！？\n]{1,10}，(?:只是|而是)/g, tip: '考虑改为正面陈述' },
];

const FIELD_LABELS = {
    description: '描述',
    personality: '性格摘要',
    scenario: '场景',
    first_mes: '开场白',
    alternate_greetings: '备选开场白',
    mes_example: '示例对话',
    system_prompt: '系统提示',
    post_history_instructions: '历史后指令',
};

/**
 * 扫描文本
 * extraRules：追加的规则（如自定义禁用词）；onlyExtra：只用追加规则（小说正文不适用写卡规则时）
 * @returns {{rule:string,type:string,level:string,match:string,context:string,index:number,tip:string}[]}
 */
export function lintText(text, { ignore = [], extraRules = [], onlyExtra = false } = {}) {
    const s = String(text || '');
    const out = [];
    const rules = onlyExtra ? extraRules : [...LINT_RULES, ...extraRules];
    for (const rule of rules) {
        if (ignore.includes(rule.id)) continue;
        rule.re.lastIndex = 0;
        let m;
        while ((m = rule.re.exec(s)) !== null) {
            const start = Math.max(0, m.index - 18);
            const end = Math.min(s.length, m.index + m[0].length + 18);
            out.push({
                rule: rule.id,
                type: rule.type,
                level: rule.level,
                match: m[0],
                context: `${start > 0 ? '…' : ''}${s.slice(start, end).replace(/\n/g, ' ')}${end < s.length ? '…' : ''}`,
                index: m.index,
                tip: rule.tip,
            });
            if (m[0].length === 0) rule.re.lastIndex++;
        }
    }
    // 同一位置被多条规则命中（如内置规则与自定义禁用词重复）只保留一条
    const seen = new Set();
    return out
        .sort((a, b) => a.index - b.index)
        .filter((x) => {
            const k = `${x.index}:${x.match}`;
            if (seen.has(k)) return false;
            seen.add(k);
            return true;
        });
}

/** 扫描角色卡数据 */
export function lintCard(data, opts = {}) {
    const issues = [];
    for (const [field, label] of Object.entries(FIELD_LABELS)) {
        const v = data?.[field];
        if (Array.isArray(v)) {
            v.forEach((t, i) => lintText(t, opts).forEach((x) => issues.push({ ...x, field, fieldLabel: `${label} ${i + 1}` })));
        } else if (typeof v === 'string') {
            lintText(v, opts).forEach((x) => issues.push({ ...x, field, fieldLabel: label }));
        }
    }
    return issues;
}

export function formatIssues(issues) {
    return issues
        .filter((i) => i.level !== 'info')
        .map((i) => `- [${i.fieldLabel}] ${i.type}：「${i.context}」 → ${i.tip}`)
        .join('\n');
}
