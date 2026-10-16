// 应用控制器：当前项目、设置、任务运行器、日志与事件

import { ChatGenRunner } from './chatgen.js';
import { ContinuationRunner } from './continue.js';
import { decodeText, normalizeNovelText } from './encoding.js';
import { ExtractionRunner } from './extract.js';
import { createEmptyProject, createProject, detectVolumesFromChunks, freeOriginalProjectName, normalizeProject } from './project.js';
import { splitNovel } from './splitter.js';
import { addStudio, getStudio, studioProjectName, studioTitleFromPremise } from './studio-base.js';
import { CHAPTER_REGEX_PRESETS } from './constants.js';
import * as store from './store.js';
import { collectChatText } from './chatgen.js';
import { Emitter, debounce, downloadFile, readFileAsArrayBuffer, safeFileName, uid } from './utils.js';

export const app = {
    settings: null,
    project: null,
    events: new Emitter(),
    logs: [],
    extraction: null,
    continuation: null,
    chatgen: null,
    /** 正在进行的「AI 推断名称」（大纲页发起，见 ui/tab-outline.js）：{projectId, items, full, progress, ctl, origin}；回退快照前要等它结束 */
    nameJob: null,
    /**
     * 正在进行的创意工坊长任务（生成大纲、全部生成、逐个展开角色 / 写开场白…，见 runStudioJob）：{projectId, studioId, label, ctl}；
     * 运行中算作忙（isBusy）：不能切换项目，关窗口时最小化；停止用 stopStudioJob
     */
    studioJob: null,
    initialized: false,

    async init() {
        if (this.initialized) return;
        this.settings = store.getSettings();
        const common = {
            getProject: () => this.project,
            settings: this.settings,
            save: () => this.saveNow(),
            onLog: (m, l) => this.log(m, l),
        };
        this.extraction = new ExtractionRunner({
            ...common,
            onVolume: (v) => this.events.emit('volume', v),
            onProgress: (p) => this.events.emit('extract:progress', p),
            onChunk: (c) => this.events.emit('chunk', c),
        });
        this.continuation = new ContinuationRunner({
            ...common,
            onProgress: (p) => this.events.emit('continue:progress', p),
            onChapter: (c) => this.events.emit('continue:chapter', c),
        });
        this.chatgen = new ChatGenRunner({
            settings: this.settings,
            saveSettings: () => store.saveSettings(),
            onLog: (m, l) => this.log(m, l),
            onProgress: (p) => this.events.emit('chatgen:progress', p),
            onChapter: (c) => this.events.emit('chatgen:chapter', c),
            onAutoSave: () => this.events.emit('chatgen:autosave'),
        });
        // 挂机续写的全局处理（与窗口是否打开无关）
        this.events.on('chatgen:chapter', async (c) => {
            if (this.settings.chatgen.feedbackToProject && this.project) {
                this.addChatChunk(c.text, `挂机第 ${c.no} 章`);
                await this.saveNow();
            }
        });
        this.events.on('chatgen:autosave', () => {
            const { text, count } = collectChatText(this.settings.chatgen);
            if (!count) return;
            const name = safeFileName(globalThis.SillyTavern?.getContext?.()?.name2 || 'chat');
            downloadFile(text, `${name}-自动备份-第${this.settings.chatgen.currentChapter}章.txt`, 'text/plain');
            this.log(`💾 已自动导出备份（第 ${this.settings.chatgen.currentChapter} 章）`, 'success');
        });
        // 页面刷新后，挂机状态不应保持“运行中”
        this.settings.chatgen.isRunning = false;
        if (this.settings.activeProjectId) {
            try {
                await this.openProject(this.settings.activeProjectId);
            } catch (e) {
                console.warn('[NovelLoom] 打开上次项目失败', e);
            }
        }
        this.initialized = true;
    },

    log(message, level = 'info') {
        const item = { t: Date.now(), message: String(message), level };
        this.logs.push(item);
        if (this.logs.length > 800) this.logs.splice(0, this.logs.length - 800);
        this.events.emit('log', item);
        if (level === 'error') console.warn('[NovelLoom]', message);
    },

    saveSettings() {
        store.saveSettings();
    },

    async saveNow() {
        if (!this.project) return;
        try {
            await store.saveProject(this.project);
            this.events.emit('saved', this.project);
        } catch (e) {
            this.log(`保存项目失败：${e.message}`, 'error');
        }
    },

    saveSoon: null,

    setProject(p) {
        this.project = p ? normalizeProject(p) : null;
        this.settings.activeProjectId = this.project?.id || '';
        store.saveSettings();
        this.events.emit('project', this.project);
    },

    async openProject(id) {
        const p = await store.loadProject(id);
        if (!p) throw new Error('项目不存在');
        this.setProject(p);
        return this.project;
    },

    async closeProject() {
        await this.saveNow();
        this.setProject(null);
    },

    getChapterPattern() {
        const ch = this.settings.chunking;
        if (ch.regexPreset === 'custom') return ch.customRegex || '';
        return CHAPTER_REGEX_PRESETS.find((p) => p.id === ch.regexPreset)?.pattern ?? CHAPTER_REGEX_PRESETS[0].pattern;
    },

    /** 读取文件（自动识别编码） */
    async readNovelFile(file) {
        const buf = await readFileAsArrayBuffer(file);
        const { text, encoding } = decodeText(buf);
        return { text: normalizeNovelText(text), encoding };
    },

    splitText(text) {
        const ch = this.settings.chunking;
        return splitNovel(text, { pattern: this.getChapterPattern(), chunkSize: ch.chunkSize, mergeSmall: ch.mergeSmall });
    },

    async createProjectFromText({ text, fileName, encoding, name }) {
        const { chunks } = this.splitText(text);
        const p = createProject({ name, fileName, encoding, text, chunks });
        const vols = detectVolumesFromChunks(p);
        await store.saveProject(p);
        this.setProject(p);
        this.log(`📚 新建项目「${p.name}」：${text.length} 字，分为 ${chunks.length} 段（编码 ${encoding}）${vols ? `，识别到 ${vols} 卷` : ''}`, 'success');
        return p;
    },

    /** 原创项目：不导入 TXT，没有分段，直接去「角色卡」原创写卡（见 original.js） */
    async createEmptyProject({ name } = {}) {
        // 没填名字：避开已有项目的名字（「原创项目 2」…），免得两个项目共用一个世界书名、写入酒馆时互相覆盖
        let n = String(name ?? '').trim();
        if (!n) n = freeOriginalProjectName((await store.listProjects()).map((x) => x.name));
        const p = createEmptyProject({ name: n });
        await store.saveProject(p);
        this.setProject(p);
        this.log(`📚 新建原创项目「${p.name}」：不导入原文，可以直接在「角色卡」页按你的设定原创写卡`, 'success');
        return p;
    },

    /**
     * 创意工坊：没有打开的项目（或用户想为这份构思另开一个）时新建原创项目并把构思放进去。
     * 项目名用构思的标题（没写时从创意里取一个短标题，见 studioTitleFromPremise），与已有项目重名时加「 2」「 3」…
     * （项目名也是世界书名的一部分，重名的两个项目写入酒馆时会互相覆盖世界书）。
     * 构思本身只在调用方给了标题时才记下标题：没给时草稿列表跟着大纲里的卡名走（和在已有项目里新建的构思一样）。
     * @param {{title?: string, premise?: string, options?: object}} init 构思的初始内容
     * @returns {Promise<{project: object, studio: object}>} studio 是打开后项目里的那一份（setProject 会重新规整项目）
     */
    async createStudioProject(init = {}) {
        const title = String(init.title ?? '').trim();
        const name = studioProjectName(title || studioTitleFromPremise(init.premise), (await store.listProjects()).map((x) => x.name));
        const p = createEmptyProject({ name });
        const s = addStudio(p, this.settings, { ...init, title });
        await store.saveProject(p);
        this.setProject(p);
        this.log(`📚 新建原创项目「${p.name}」，在「创意工坊」里继续构思`, 'success');
        return { project: this.project, studio: getStudio(this.project, s.id) };
    },

    /**
     * 运行创意工坊的长任务：记在 studioJob（运行中 isBusy 为真），fn(signal) 结束后清掉。已经有一个在运行时抛错。
     * @param {{studioId?: string, label?: string}} meta
     * @param {(signal: AbortSignal) => Promise<any>} fn
     */
    async runStudioJob({ studioId = '', label = '' } = {}, fn) {
        if (this.studioJob) throw new Error('创意工坊已有任务在运行');
        const ctl = new AbortController();
        this.studioJob = { projectId: this.project?.id || '', studioId, label, ctl };
        this.events.emit('studio:job', this.studioJob);
        try {
            return await fn(ctl.signal);
        } finally {
            this.studioJob = null;
            this.events.emit('studio:job', null);
        }
    },

    /** 停止正在进行的创意工坊任务（正在等的那一次请求会被中止，已经写好的保留） */
    stopStudioJob() {
        this.studioJob?.ctl?.abort();
    },

    /** 在已有项目上重新分块（会清空提取结果，调用方需确认） */
    async rechunk(text) {
        if (!this.project) return;
        const { chunks } = this.splitText(text);
        const p = this.project;
        p.chunks = [...chunks, ...p.chunks.filter((c) => c.origin === 'generated')];
        p.chunks.forEach((c, i) => (c.index = i));
        p.characters = {};
        p.worldbook = {};
        p.missingNames = [];
        p.outline = { summary: '', summaryUpTo: -1 };
        p.volumes = [];
        detectVolumesFromChunks(p);
        for (const c of p.chunks) {
            c.status = 'pending';
            c.outline = [];
            c.important = [];
        }
        await this.saveNow();
        this.events.emit('project', p);
    },

    getSourceText() {
        if (!this.project) return '';
        return this.project.chunks.filter((c) => c.origin === 'source').map((c) => c.content).join('');
    },

    addChatChunk(text, title) {
        const p = this.project;
        if (!p) return;
        p.chunks.push({
            id: uid('c_'), index: p.chunks.length, title, chapterTitles: [title], content: text, charCount: text.length, start: 0, end: text.length,
            origin: 'chat', status: 'pending', error: '', attempts: 0, outline: [], important: [], processedAt: 0,
        });
    },

    isBusy() {
        return !!(this.extraction?.running || this.continuation?.running || this.chatgen?.running || this.studioJob);
    },
};

app.saveSoon = debounce(() => app.saveNow(), 800);
