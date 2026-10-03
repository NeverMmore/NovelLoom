// NovelLoom 常量与默认设置

export const MODULE = 'novel_loom';
export const PREFIX = 'nl';
export const VERSION = '0.7.0';
export const DB_NAME = 'NovelLoomDB';
export const DB_VERSION = 1;

/** 章节正则预设（与 novel-auto-generator 保持兼容，并补充常见格式） */
export const CHAPTER_REGEX_PRESETS = [
    { id: 'zh', name: '中文通用（第X章/回/卷/节）', pattern: '^\\s*第[零〇一二两三四五六七八九十百千万0-9０-９]+[章回卷节部篇集幕][^\\n]{0,40}$' },
    { id: 'zh_num', name: '数字章节（第1章）', pattern: '^\\s*第\\d+章[^\\n]{0,40}$' },
    { id: 'en', name: '英文 Chapter', pattern: '^\\s*(?:Chapter|CHAPTER)\\s*\\d+[^\\n]{0,60}$' },
    { id: 'num_title', name: '纯数字标题（1. / 001）', pattern: '^\\s*\\d{1,4}[\\.、\\s][^\\n]{0,40}$' },
    { id: 'none', name: '不按章节，只按字数切', pattern: '' },
];

/** ST 世界书插入位置 */
export const WI_POSITIONS = [
    { value: 0, label: '角色定义之前' },
    { value: 1, label: '角色定义之后' },
    { value: 2, label: '作者注释顶部' },
    { value: 3, label: '作者注释底部' },
    { value: 4, label: '@深度' },
    { value: 5, label: '示例消息顶部' },
    { value: 6, label: '示例消息底部' },
];

/**
 * 世界书分类。「角色」分类由角色档案自动生成，其余分类由 AI 按 guide 提取。
 * constant=true 为蓝灯（常驻），false 为绿灯（关键词触发）。
 */
export const DEFAULT_CATEGORIES = [
    {
        name: '角色', builtin: true, enabled: true, constant: false, position: 0, depth: 4, order: 100, autoIncrement: true,
        guide: '（由角色档案自动生成，无需单独提取）',
    },
    {
        name: '世界观', builtin: true, enabled: true, constant: true, position: 0, depth: 4, order: 10, autoIncrement: true,
        guide: '世界规则、力量体系、社会结构、历史背景。只写会让 AI 出错的差异信息，不写情节、不写常识、不写纯环境描写。',
    },
    {
        name: '地点', builtin: true, enabled: true, constant: false, position: 0, depth: 4, order: 200, autoIncrement: true,
        guide: '区域与具体场景：名称、所属区域、可辨识特征、常驻人物、在剧情中的作用。只记录原文出现过的地点，粒度以原文为准。',
    },
    {
        name: '势力', builtin: true, enabled: true, constant: false, position: 0, depth: 4, order: 300, autoIncrement: true,
        guide: '组织、门派、家族、机构：性质与目的、主要活动区域、关键成员、与其他势力的关系。',
    },
    {
        name: '物品', builtin: true, enabled: true, constant: false, position: 0, depth: 4, order: 400, autoIncrement: true,
        guide: '对剧情或世界观有意义的物品、道具、功法、能力：外观或形态、作用、持有者、来历。不记录日常物品。',
    },
    {
        name: '事件', builtin: true, enabled: false, constant: false, position: 0, depth: 4, order: 500, autoIncrement: true,
        guide: '关键历史事件或剧情事件：时间、参与者、经过、影响。',
    },
    {
        name: '玩法规则', builtin: true, enabled: false, constant: true, position: 0, depth: 4, order: 20, autoIncrement: true,
        guide: '世界中可被玩家利用或必须遵守的机制：等级、修炼阶段、货币、系统面板、副本规则等。',
    },
];

export const DEFAULT_API = {
    mode: 'tavern', // tavern | profile | openai | gemini | anthropic
    profileId: '',
    endpoint: '',
    apiKey: '',
    model: '',
    temperature: 0.7,
    maxTokens: 8000,
    timeoutSec: 300,
    retries: 2,
    retryBaseMs: 2000,
    includePreset: false,
    geminiSafety: 'BLOCK_NONE', // Gemini 安全阈值：'' = 服务商默认 | BLOCK_NONE | OFF | BLOCK_ONLY_HIGH
};

/** 防截断：回复被截断时自动接续；识别拒绝与服务商过滤 */
export const DEFAULT_ANTI_TRUNCATE = {
    enabled: true,
    maxContinues: 3,
    style: 'auto', // auto | prefill（把已写内容作为 AI 消息让模型直接接着写）| ask（再发一条“从断点继续”）
    prompt: '你的上一条回复在“{TAIL}”处中断了。请从中断的地方直接接着写，不要重复已经写过的内容，不要加任何说明或代码块标记。如果上一条回复其实已经完整，只回复：[END]',
    detectRefusal: true,
};

/** 文风全局选项 */
export const DEFAULT_STYLE_OPTIONS = {
    globalBanned: '', // 对所有文风生效的禁用词（每行一个）
    sampleMaxChars: 1500, // 范文注入提示词的总字数上限
    samplesInCard: true,
    samplesInPlan: false,
    bannedInPrompt: true, // 把禁用词写进提示词，让 AI 事先避开
    checkContinuation: true, // 续写完成后扫描禁用词
    fixMode: 'none', // none | replace（按建议替换）| ai（AI 改写命中的句子）
};

export const DEFAULT_SETTINGS = {
    version: VERSION,
    activeProjectId: '',
    ui: { lastTab: 'import', lang: 'zh' },
    api: { ...DEFAULT_API },
    /** 续写可单独指定 API（为空则沿用主 API） */
    continueApi: { enabled: false, ...DEFAULT_API },
    chunking: {
        regexPreset: 'zh',
        customRegex: '',
        chunkSize: 12000,
        mergeSmall: true,
    },
    extraction: {
        mode: 'serial', // serial | parallel | batch
        concurrency: 3,
        contextBudget: 6000, // 注入“已知资料”的最大字数
        extractOutline: true,
        extractStyle: true,
        extractQuotes: true,
        verifyQuotes: true,
        filterTags: 'thinking,think,analysis',
        suffixPrompt: '',
        autoSnapshotEvery: 10,
        volumeMode: false, // 分卷模式
        volumeAutoSummary: true, // 每卷结束自动生成卷梗概（作为后续卷的前情提要）
        volumeTokenLimit: 0, // 提示词预估超过该 token 数时自动开新卷（0 = 不按阈值）
        volumeOnOverflow: true, // 接口报“上下文超限”时自动开新卷并重试
        maxExperiences: 12,
        maxQuotes: 8,
        maxDialogues: 3,
    },
    worldbook: {
        allowRecursion: false,
        excludeCardCharacter: true,
        includeOutlineEntry: true,
        includeStyleEntry: false,
        namePattern: '《{book}》世界书',
        volumeScope: 'volume', // 分卷世界书：volume = 只含本卷出场的实体；cumulative = 截至卷末的全部
    },
    cards: {
        creator: '',
        defaultRequirement: '',
        embedWorldbook: true,
        linkWorldbook: true,
        greetings: 2,
        lintAfterGenerate: true,
    },
    planner: {
        count: 10,
        detail: 'standard', // brief | standard | detailed
        contextChars: 6000,
        requirement: '',
        useScenes: false, // 拆分场次：把章级大纲细化到 3-5 个场次（地点/在场角色/发生的事），续写时按场次写更可控
    },
    continuation: {
        followPlan: true,
        chapters: 3,
        wordsPerChapter: 3000,
        direction: '',
        tailChars: 3000,
        feedback: true,
        useWorldbook: true,
        stopOnError: true,
    },
    chatgen: {
        totalChapters: 20,
        prompt: '继续',
        currentChapter: 0,
        isRunning: false,
        isPaused: false,
        replyWaitMs: 5000,
        stabilityCheckInterval: 1000,
        stabilityRequiredCount: 3,
        toastDetection: true,
        toastTimeoutMs: 300000,
        postToastWaitMs: 2000,
        maxRetries: 3,
        minChapterLength: 100,
        autoSaveInterval: 50,
        feedbackToProject: false,
        exportAll: true,
        exportStartFloor: 0,
        exportEndFloor: 99999,
        exportIncludeUser: false,
        exportIncludeAI: true,
        useRawContent: true,
        extractTags: '',
        extractMode: 'all', // all | tags
        excludeTags: 'thinking,think',
        tagSeparator: '\n\n',
    },
    prompts: {}, // 用户自定义覆盖：{ extract, card, continue, merge, consolidate, alias, fix }
    /** 自定义消息链：default 作用于所有任务；其他键为空时沿用 default */
    messageChains: {
        default: [
            { role: 'system', content: '{SYSTEM}', enabled: true },
            { role: 'user', content: '{PROMPT}', enabled: true },
        ],
        extract: [],
        card: [],
        outline: [],
        continue: [],
        tools: [],
    },
    chainOptions: { prependPrefill: true },
    antiTruncate: { ...DEFAULT_ANTI_TRUNCATE },
    /** 文风预设：内置模板的修改版（同 id）与自建预设 */
    stylePresets: [],
    styleOptions: { ...DEFAULT_STYLE_OPTIONS },
    categories: null, // null = 使用默认分类
    defaultEntries: [], // [{category, name, keywords, content}]
    /** 自定义关系类型：保存在扩展设置里，跨项目共享，与内置类型合并使用（见 relations.js 的 allRelationTypes） */
    customRelationTypes: [], // [{value, label, color}]
    /** 剧情推演·走向模板：保存在扩展设置里，跨项目共享（见 deduce.js 的 branchTemplates） */
    branchTemplates: [], // [{id, label, hint, createdAt}]
};
