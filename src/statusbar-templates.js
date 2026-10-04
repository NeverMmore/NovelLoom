// 状态栏模板：四个内置模板（通用 / RPG / 校园恋爱 / 赛博朋克）、用户模板的增删改查、套用到角色卡，以及单个模板的 JSON 导入导出。
// 用户模板保存在扩展设置 settings.statusBarTemplates（跨项目共享，配置导入时按 id 合并，见 io.js）。
// 内置模板只读：不能删除、改名或修改，可以「复制」成自己的模板后再改。
// 内置模板的界面是绑定模式片段（<style> + data-nl-* 绑定 + 可选的 window.nlRender），由 NovelLoom 运行时填值；
// 它们必须通过 lintStatusHtml（无错误、无警告）并能原样经过酒馆的正则替换与「自动修复 Markdown」——tests/statusbar-templates.test.js 逐个检查。
// 所以界面代码里每行的 * 与 " 个数都是偶数，* 旁边也不留空格（例如写 .gn :where(*) 而不是 .gn *）。

import { DEFAULT_STATUS_BAR } from './constants.js';
import {
    STATUS_MODE_LABELS, ensureStatusBar, isFrontendText, lintStatusHtml, normalizeStatusSpec, unwrapStatusFence,
} from './statusbar.js';
import { STATUSBAR_THEMES, cleanFragment, renderDefaultFragment } from './statusbar-runtime.js';
import { safeFileName, uid } from './utils.js';

/** 模板的界面模式：bind = 绑定模式片段（AI 设计），raw = 完整 HTML 文档（不注入运行时），auto = 内置排版（不需要界面代码） */
export const STATUS_TEMPLATE_MODES = ['bind', 'raw', 'auto'];
/** 与状态栏编辑器共用同一份显示名（statusbar.js 的 STATUS_MODE_LABELS） */
export const STATUS_TEMPLATE_MODE_LABELS = STATUS_MODE_LABELS;
/** 套用方式：structure = 沿用结构（变量表 + 界面），look = 只借外观（保留本卡变量表，AI 按模板重写界面）；'style' 视为 look 的别名 */
export const STATUS_TEMPLATE_APPLY_MODES = ['structure', 'look'];
export const STATUS_TEMPLATE_FILE_TYPE = 'novelloom-statusbar-template';
export const STATUS_TEMPLATE_NAME_MAX = 30;
export const STATUS_TEMPLATE_DESC_MAX = 200;
export const STATUS_TEMPLATE_HTML_MAX = 200000;
/** 存进模板的变量表不按用户的 maxVars 截断（套用时才按卡片所在设置截断） */
const STORE_MAX_VARS = 64;

const THEMES = STATUSBAR_THEMES.map((t) => t.value);

function isObj(v) {
    return !!v && typeof v === 'object' && !Array.isArray(v);
}

function clone(v) {
    return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
}

function deepFreeze(o) {
    if (o && typeof o === 'object' && !Object.isFrozen(o)) {
        Object.freeze(o);
        for (const v of Object.values(o)) deepFreeze(v);
    }
    return o;
}

// ---------------- 内置模板 ----------------

const SVG = 'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"';
const ICON_PIN = `<svg ${SVG}><path d="M12 21s-7-6-7-11a7 7 0 0 1 14 0c0 5-7 11-7 11z"/><circle cx="12" cy="10" r="2.5"/></svg>`;

// ---- 通用：白底简洁卡片 ----

const GENERAL_SPEC = {
    title: '当前状态',
    variables: [
        { path: '世界.时间', type: 'string', label: '时间', init: '', desc: '故事里的当前时间，写法跟随世界观（如“周一 08:30”“永和三年 春 黄昏”）', check: ['每轮按剧情推进；没有明确的时间跳跃时只小幅前进', '保持同一种写法，不要在不同格式之间来回切换'] },
        { path: '世界.地点', type: 'string', label: '地点', init: '', desc: '当前所在的具体场所', check: ['场景转换时更新，具体到房间、街道或建筑'] },
        { path: '世界.天气', type: 'string', label: '天气', init: '', check: ['天气变化或进入室外场景时更新，2~4 字'] },
        {
            path: '角色.好感度', type: 'number', label: '好感度', init: 30, min: 0, max: 100, integer: true, widget: 'bar',
            stages: [{ min: 0, label: '戒备' }, { min: 20, label: '普通' }, { min: 40, label: '友好' }, { min: 60, label: '亲近' }, { min: 80, label: '信赖' }],
            desc: '{{char}}对{{user}}的好感', check: ['根据{{char}}对{{user}}言行的感受调整', '单次变化 ±1~5，重大事件最多 ±10'],
        },
        { path: '角色.心情', type: 'string', label: '心情', init: '', desc: '{{char}}此刻的情绪', check: ['用 2~6 字概括，随对话变化'] },
        { path: '角色.着装', type: 'string', label: '着装', init: '', desc: '{{char}}现在的穿着', check: ['换装或衣着状态改变时更新，写清款式与颜色'] },
        { path: '角色.动作', type: 'string', label: '动作', init: '', desc: '{{char}}此刻正在做的事', check: ['每轮按{{char}}的最新动作更新，15 字以内'] },
        { path: '角色.想法', type: 'string', label: '想法', init: '', desc: '{{char}}没有说出口的内心想法', check: ['一句话，20 字以内，要符合{{char}}的性格与处境'] },
    ],
};

const GENERAL_SAMPLE = {
    世界: { 时间: '周六 15:20', 地点: '车站前的咖啡馆', 天气: '小雨' },
    角色: { 好感度: 46, 心情: '有点紧张', 着装: '米色针织开衫、深灰长裙', 动作: '双手捧着热可可', 想法: '……要不要先开口呢。' },
};

const GENERAL_HTML = `<style>
.gn{--gn-bg:#ffffff;--gn-soft:#f5f6fa;--gn-line:#e6e8ef;--gn-fg:#1e2330;--gn-muted:#687083;--gn-accent:#5b6cf0;--gn-rose:#e2527c;--gn-rose-soft:#fdecf1;max-width:760px;margin:4px auto;background:var(--gn-bg);color:var(--gn-fg);border:1px solid var(--gn-line);border-radius:12px;box-shadow:0 1px 3px rgba(20,28,45,.08);font:13px/1.55 system-ui,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;overflow:hidden}
.gn>summary{list-style:none;cursor:pointer;display:flex;flex-wrap:wrap;align-items:center;gap:6px 10px;padding:9px 14px;user-select:none}
.gn>summary::-webkit-details-marker{display:none}
.gn>summary:focus-visible{outline:2px solid var(--gn-accent);outline-offset:-2px;border-radius:12px}
.gn-chev{flex:none;width:14px;height:14px;color:var(--gn-muted);transition:transform .2s}
.gn[open] .gn-chev{transform:rotate(90deg)}
.gn-title{font-weight:600;letter-spacing:.02em}
.gn-meta{display:flex;flex-wrap:wrap;gap:6px;margin-left:auto;min-width:0}
.gn-chip{display:inline-flex;align-items:center;gap:4px;max-width:100%;padding:1px 9px;border-radius:999px;background:var(--gn-soft);color:var(--gn-muted);font-size:12px;line-height:20px}
.gn-chip svg{flex:none;width:12px;height:12px}
.gn-chip span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.gn-body{padding:0 14px 14px;border-top:1px solid var(--gn-line)}
.gn-who{display:flex;align-items:center;gap:10px;padding:12px 0 10px}
.gn-avatar{flex:none;display:grid;place-items:center;width:34px;height:34px;border-radius:50%;background:linear-gradient(135deg,#f59ab4,var(--gn-accent));color:#fff}
.gn-avatar svg{width:16px;height:16px}
.gn-name{min-width:0;font-size:15px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.gn-mood{flex:none;max-width:50%;margin-left:auto;padding:1px 10px;border-radius:999px;background:#eef0ff;color:#3f47c4;font-size:12px;line-height:20px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.gn-aff{display:grid;grid-template-columns:auto minmax(60px,1fr) auto auto;align-items:center;gap:8px;margin-bottom:12px}
.gn-k{color:var(--gn-muted);font-size:12px}
.gn-bar{height:8px;border-radius:999px;background:#eef0f5;overflow:hidden}
.gn-bar>i{display:block;width:var(--nl-pct,0%);height:100%;border-radius:inherit;background:linear-gradient(90deg,#f7a3bb,var(--gn-rose));transition:width .5s ease}
.gn-num{min-width:2ch;font-weight:600;font-variant-numeric:tabular-nums;text-align:right}
.gn-stage{padding:0 8px;border-radius:999px;background:var(--gn-rose-soft);color:var(--gn-rose);font-size:12px;line-height:20px}
.gn-stage:empty{display:none}
.gn-rows{display:grid;grid-template-columns:auto minmax(0,1fr);gap:6px 14px;margin:0}
.gn-rows dt{color:var(--gn-muted);font-size:12px;line-height:20px}
.gn-rows dd{margin:0;overflow-wrap:anywhere}
.gn-thought{margin:12px 0 0;padding:8px 12px;border-left:3px solid var(--gn-accent);border-radius:0 8px 8px 0;background:var(--gn-soft);color:#454c5e;font-style:italic}
.gn-thought::before{content:"“"}
.gn-thought::after{content:"”"}
@media (max-width:440px){.gn-meta{width:100%;margin-left:0}}
@media (prefers-reduced-motion:reduce){.gn :where(*),.gn :where(*)::before{transition:none!important}}
</style>
<details class="gn" open>
<summary>
<svg class="gn-chev" ${SVG}><path d="m9 6 6 6-6 6"/></svg>
<span class="gn-title">当前状态</span>
<span class="gn-meta">
<span class="gn-chip" title="时间"><svg ${SVG}><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg><span data-nl-text="世界.时间"></span></span>
<span class="gn-chip" title="地点">${ICON_PIN}<span data-nl-text="世界.地点"></span></span>
<span class="gn-chip" title="天气"><svg ${SVG}><path d="M7 18h10a4 4 0 0 0 .6-7.95A6 6 0 0 0 6.2 9.4 4.3 4.3 0 0 0 7 18z"/></svg><span data-nl-text="世界.天气"></span></span>
</span>
</summary>
<div class="gn-body">
<div class="gn-who">
<span class="gn-avatar" aria-hidden="true"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 20.5s-7.5-4.6-7.5-10.4A4.3 4.3 0 0 1 12 7.4a4.3 4.3 0 0 1 7.5 2.7c0 5.8-7.5 10.4-7.5 10.4z"/></svg></span>
<span class="gn-name">{{char}}</span>
<span class="gn-mood" title="心情" data-nl-text="角色.心情"></span>
</div>
<div class="gn-aff">
<span class="gn-k">好感</span>
<span class="gn-bar" data-nl-bar="角色.好感度"><i></i></span>
<span class="gn-num" data-nl-text="角色.好感度"></span>
<span class="gn-stage" data-nl-stage="角色.好感度"></span>
</div>
<dl class="gn-rows">
<dt>着装</dt><dd data-nl-text="角色.着装"></dd>
<dt>动作</dt><dd data-nl-text="角色.动作"></dd>
</dl>
<p class="gn-thought" data-nl-text="角色.想法" data-nl-empty="……"></p>
</div>
</details>`;

// ---- RPG：深色奇幻冒险者面板 ----

const RPG_SPEC = {
    title: '冒险者面板',
    variables: [
        { path: '世界.地点', type: 'string', label: '地点', init: '', check: ['进入新区域或场景时更新，写成「区域 · 具体地点」'] },
        { path: '主角.等级', type: 'number', label: '等级', init: 1, min: 1, max: 99, integer: true, widget: 'text', desc: '{{user}}的等级', check: ['经验达到 100 时等级 +1，同时经验归零'] },
        { path: '主角.经验', type: 'number', label: '经验', init: 0, min: 0, max: 100, integer: true, widget: 'bar', desc: '距离下一级的进度（百分比）', check: ['击败敌人、完成任务或有所领悟时增加，单次 +5~30'] },
        { path: '主角.生命', type: 'number', label: '生命', init: 100, min: 0, max: 100, integer: true, widget: 'bar', desc: '{{user}}的生命值', check: ['受伤时减少、休息或治疗时恢复，按伤势轻重 ±5~40', '降到 0 表示倒下'] },
        { path: '主角.法力', type: 'number', label: '法力', init: 100, min: 0, max: 100, integer: true, widget: 'bar', desc: '{{user}}的法力值', check: ['施法或使用技能时消耗，休息或冥想时恢复'] },
        { path: '主角.金币', type: 'number', label: '金币', init: 0, min: 0, integer: true, widget: 'text', check: ['交易、奖励、拾取时用 delta 增减，不能为负'] },
        {
            path: '主角.属性', type: 'record', label: '属性', keyDesc: '属性名', widget: 'list',
            value: { type: 'number', min: 0, max: 999, integer: true, init: 10 },
            init: { 力量: 10, 敏捷: 10, 智力: 10, 体质: 10 },
            check: ['只在升级、训练或特殊事件后提升，每次 +1~3', '不要新增或删除属性项'],
        },
        { path: '主角.状态', type: 'list', label: '状态', init: [], maxItems: 6, widget: 'tags', desc: '{{user}}身上的增益或异常状态', check: ['获得状态用 insert 追加到 /主角/状态/-，状态消失时用 remove 删除'] },
        {
            path: '主角.物品', type: 'record', label: '背包', keyDesc: '物品名', widget: 'list',
            value: { type: 'object', fields: [{ key: '数量', type: 'number', min: 0, integer: true, init: 1 }, { key: '描述', type: 'string', init: '' }] },
            init: {},
            check: ['获得物品用 insert 新增键，用完或丢失时用 remove 删除', '数量变化用 delta 修改 /主角/物品/物品名/数量'],
        },
        {
            path: '主角.任务', type: 'record', label: '任务', keyDesc: '任务名', widget: 'list',
            value: { type: 'object', fields: [{ key: '状态', type: 'enum', options: ['进行中', '已完成', '已失败'], init: '进行中' }, { key: '目标', type: 'string', init: '' }] },
            init: {},
            check: ['接到任务时 insert，目标写当前要做的事与进度', '完成或失败时改状态，不要直接删除'],
        },
    ],
};

const RPG_SAMPLE = {
    世界: { 地点: '灰岩镇 · 冒险者公会' },
    主角: {
        等级: 7, 经验: 64, 生命: 82, 法力: 45, 金币: 236,
        属性: { 力量: 14, 敏捷: 11, 智力: 9, 体质: 13 },
        状态: ['祝福', '轻微中毒'],
        物品: { 治疗药水: { 数量: 3, 描述: '恢复少量生命' }, 生锈的钥匙: { 数量: 1, 描述: '不知道能打开哪扇门' }, 火把: { 数量: 2, 描述: '' } },
        任务: { 清理地下水道: { 状态: '进行中', 目标: '击退巨鼠群（3/5）' }, 送信给铁匠: { 状态: '已完成', 目标: '把信交给镇东的铁匠' } },
    },
};

const RPG_HTML = `<style>
.rp{--rp-fg:#ece6d6;--rp-muted:#a39c8b;--rp-gold:#e6b85a;--rp-line:rgba(230,184,90,.26);--rp-panel:rgba(255,255,255,.04);max-width:760px;margin:4px auto;color:var(--rp-fg);background:linear-gradient(160deg,#232634,#17181f);border:1px solid rgba(230,184,90,.5);border-radius:10px;box-shadow:inset 0 0 0 3px #17181f,inset 0 0 0 4px rgba(230,184,90,.16);font:13px/1.5 "Segoe UI",system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;overflow:hidden}
.rp>summary{list-style:none;cursor:pointer;display:flex;align-items:center;gap:10px;padding:9px 14px;background:linear-gradient(90deg,rgba(230,184,90,.16),transparent 70%);user-select:none}
.rp>summary::-webkit-details-marker{display:none}
.rp>summary:focus-visible{outline:2px solid var(--rp-gold);outline-offset:-3px;border-radius:8px}
.rp-crest{flex:none;display:grid;place-items:center;width:26px;height:26px;border-radius:6px;background:linear-gradient(135deg,#f2c45a,#a87523);color:#1b1c24}
.rp-crest svg{width:15px;height:15px}
.rp-title{min-width:0;font-weight:700;letter-spacing:.04em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rp-lv{flex:none;padding:0 8px;border:1px solid rgba(230,184,90,.55);border-radius:4px;color:var(--rp-gold);font-size:12px;line-height:20px;letter-spacing:.06em}
.rp-lv b{font-size:13px}
.rp-loc{display:inline-flex;align-items:center;gap:4px;min-width:0;margin-left:auto;color:var(--rp-muted);font-size:12px}
.rp-loc svg{flex:none;width:12px;height:12px}
.rp-loc span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rp-chev{flex:none;width:14px;height:14px;color:var(--rp-muted);transition:transform .2s}
.rp[open] .rp-chev{transform:rotate(90deg)}
.rp-body{display:grid;grid-template-columns:minmax(0,1.15fr) minmax(0,1fr);gap:14px;padding:12px 14px 14px;border-top:1px solid var(--rp-line)}
.rp-meter{display:grid;grid-template-columns:34px minmax(0,1fr) 60px;align-items:center;gap:8px;margin-bottom:7px}
.rp-k{font-size:11px;font-weight:700;letter-spacing:.1em;color:var(--rp-muted)}
.rp-bar{position:relative;height:10px;border-radius:3px;background:#0f1016;box-shadow:inset 0 0 0 1px rgba(255,255,255,.07);overflow:hidden}
.rp-bar>i{display:block;width:var(--nl-pct,0%);height:100%;background:linear-gradient(180deg,rgba(255,255,255,.28),transparent 55%),linear-gradient(90deg,var(--c1),var(--c2));transition:width .5s ease}
.rp-bar::after{content:"";position:absolute;inset:0;background:repeating-linear-gradient(90deg,transparent 0 calc(10% - 1px),rgba(0,0,0,.35) calc(10% - 1px) 10%)}
.rp-hp{--c1:#c23b34;--c2:#ff7a5c}
.rp-mp{--c1:#2f6fc4;--c2:#6cc0ff}
.rp-xp{--c1:#a87523;--c2:#f2c45a}
.rp-xp .rp-bar{height:6px}
.rp-xp .rp-bar::after{display:none}
.rp-v{font-variant-numeric:tabular-nums;text-align:right;white-space:nowrap}
.rp-v b{font-weight:700}
.rp-v small{margin-left:1px;color:var(--rp-muted);font-size:11px}
.rp-attrs{display:grid;grid-template-columns:repeat(auto-fill,minmax(64px,1fr));gap:6px;margin:10px 0}
.rp-attr{display:flex;flex-direction:column;align-items:center;padding:5px 4px;border:1px solid var(--rp-line);border-radius:6px;background:var(--rp-panel)}
.rp-attr span{font-size:11px;letter-spacing:.06em;color:var(--rp-muted)}
.rp-attr b{font-size:16px;color:var(--rp-gold);font-variant-numeric:tabular-nums}
.rp-foot{display:flex;flex-wrap:wrap;align-items:center;gap:8px}
.rp-gold{display:inline-flex;align-items:center;gap:5px;color:var(--rp-gold);font-weight:700;font-variant-numeric:tabular-nums}
.rp-gold svg{width:15px;height:15px}
.rp-buffs{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:4px;margin-left:auto}
.rp-buff{padding:0 7px;border:1px solid rgba(230,184,90,.28);border-radius:4px;background:rgba(230,184,90,.12);color:#ead39a;font-size:11px;line-height:18px}
.rp-side{position:relative;min-width:0}
.rp-radio{position:absolute;opacity:0;pointer-events:none}
.rp-tabs{display:flex;gap:2px;margin-bottom:6px;border-bottom:1px solid var(--rp-line)}
.rp-tabs label{margin-bottom:-1px;padding:3px 12px 5px;border-bottom:2px solid transparent;color:var(--rp-muted);font-weight:600;letter-spacing:.08em;cursor:pointer}
.rp-tabs label:hover{color:var(--rp-fg)}
#rp-tab-bag:checked~.rp-tabs label[for="rp-tab-bag"],#rp-tab-quest:checked~.rp-tabs label[for="rp-tab-quest"]{color:var(--rp-gold);border-bottom-color:var(--rp-gold)}
#rp-tab-bag:focus-visible~.rp-tabs label[for="rp-tab-bag"],#rp-tab-quest:focus-visible~.rp-tabs label[for="rp-tab-quest"]{outline:2px solid var(--rp-gold);outline-offset:-2px;border-radius:4px}
#rp-tab-bag:checked~.rp-quest,#rp-tab-quest:checked~.rp-bag{display:none}
.rp-pane{display:flex;flex-direction:column;gap:3px;max-height:172px;overflow:auto;scrollbar-width:thin;scrollbar-color:rgba(230,184,90,.35) transparent}
.rp-item,.rp-q{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:0 8px;padding:5px 8px;border-radius:6px;background:var(--rp-panel)}
.rp-q{grid-template-columns:auto minmax(0,1fr)}
.rp-iname{min-width:0;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rp-qty{color:var(--rp-gold);font-variant-numeric:tabular-nums}
.rp-desc{grid-column:1/-1;color:var(--rp-muted);font-size:12px}
.rp-desc[data-nl-value=""],.rp-desc:not([data-nl-value]){display:none}
.rp-qst{align-self:center;padding:0 6px;border-radius:4px;background:rgba(74,143,224,.2);color:#9cc8ff;font-size:11px;line-height:18px}
.rp-qst[data-nl-value="已完成"]{background:rgba(63,178,127,.2);color:#86dcae}
.rp-qst[data-nl-value="已失败"]{background:rgba(229,83,75,.2);color:#ff9d95}
.rp .nl-each-empty{color:var(--rp-muted);font-size:12px}
.rp-pane .nl-each-empty{padding:14px 8px;text-align:center}
@media (max-width:540px){.rp-body{grid-template-columns:minmax(0,1fr)}}
@media (prefers-reduced-motion:reduce){.rp :where(*),.rp :where(*)::before{transition:none!important}}
</style>
<details class="rp" open>
<summary>
<span class="rp-crest" aria-hidden="true"><svg ${SVG}><path d="M12 3l7 3v5c0 4.5-3 8.3-7 10-4-1.7-7-5.5-7-10V6z"/><path d="m9 12 2 2 4-4"/></svg></span>
<span class="rp-title">{{user}}</span>
<span class="rp-lv">Lv <b data-nl-text="主角.等级"></b></span>
<span class="rp-loc">${ICON_PIN}<span data-nl-text="世界.地点"></span></span>
<svg class="rp-chev" ${SVG}><path d="m9 6 6 6-6 6"/></svg>
</summary>
<div class="rp-body">
<section>
<div class="rp-meter rp-hp"><span class="rp-k">HP</span><span class="rp-bar" data-nl-bar="主角.生命"><i></i></span><span class="rp-v"><b data-nl-text="主角.生命"></b><small>/100</small></span></div>
<div class="rp-meter rp-mp"><span class="rp-k">MP</span><span class="rp-bar" data-nl-bar="主角.法力"><i></i></span><span class="rp-v"><b data-nl-text="主角.法力"></b><small>/100</small></span></div>
<div class="rp-meter rp-xp"><span class="rp-k">EXP</span><span class="rp-bar" data-nl-bar="主角.经验"><i></i></span><span class="rp-v"><b data-nl-text="主角.经验"></b><small>%</small></span></div>
<div class="rp-attrs" data-nl-each="主角.属性" data-nl-empty="暂无属性"><template><div class="rp-attr"><span data-nl-key></span><b data-nl-item=""></b></div></template></div>
<div class="rp-foot">
<span class="rp-gold" title="金币"><svg ${SVG}><ellipse cx="12" cy="6.5" rx="7" ry="3"/><path d="M5 6.5v5c0 1.7 3.1 3 7 3s7-1.3 7-3v-5M5 11.5v5c0 1.7 3.1 3 7 3s7-1.3 7-3v-5"/></svg><b data-nl-text="主角.金币"></b></span>
<span class="rp-buffs" data-nl-each="主角.状态" data-nl-empty="状态良好"><template><span class="rp-buff" data-nl-item=""></span></template></span>
</div>
</section>
<section class="rp-side">
<input class="rp-radio" type="radio" name="rp-tab" id="rp-tab-bag" checked>
<input class="rp-radio" type="radio" name="rp-tab" id="rp-tab-quest">
<div class="rp-tabs"><label for="rp-tab-bag">背包</label><label for="rp-tab-quest">任务</label></div>
<div class="rp-pane rp-bag" data-nl-each="主角.物品" data-nl-empty="背包空空如也"><template><div class="rp-item"><span class="rp-iname" data-nl-key></span><span class="rp-qty">×<b data-nl-item="数量"></b></span><span class="rp-desc" data-nl-item="描述"></span></div></template></div>
<div class="rp-pane rp-quest" data-nl-each="主角.任务" data-nl-empty="暂无任务"><template><div class="rp-q"><span class="rp-qst" data-nl-item="状态"></span><span class="rp-iname" data-nl-key></span><span class="rp-desc" data-nl-item="目标"></span></div></template></div>
</section>
</div>
</details>`;

// ---- 校园恋爱：粉色手账风 ----

const CAMPUS_SPEC = {
    title: '校园日常',
    variables: [
        { path: '世界.日期', type: 'string', label: '日期', init: '', desc: '故事里的日期（如“4月8日 周一”）', check: ['跨天时更新，注意星期要对应'] },
        { path: '世界.时段', type: 'enum', label: '时段', options: ['清晨', '上午', '午休', '下午', '放学后', '傍晚', '夜晚', '深夜'], init: '上午', check: ['随剧情推进按顺序变化，跨天后从清晨开始'] },
        { path: '世界.地点', type: 'string', label: '地点', init: '', check: ['场景转换时更新，如“教室”“天台”“车站前”'] },
        { path: '角色.关系', type: 'enum', label: '关系', options: ['陌生', '同学', '朋友', '好友', '暧昧', '恋人'], init: '同学', desc: '{{char}}与{{user}}目前的关系', check: ['只在出现明确的关系转折事件时推进一级，不要跳级', '告白成功才能变成“恋人”'] },
        {
            path: '角色.好感度', type: 'number', label: '好感', init: 30, min: 0, max: 100, integer: true, widget: 'bar',
            stages: [{ min: 0, label: '无感' }, { min: 20, label: '在意' }, { min: 40, label: '有好感' }, { min: 60, label: '心动' }, { min: 80, label: '喜欢' }],
            desc: '{{char}}对{{user}}的好感', check: ['根据{{user}}的言行与两人的互动调整，单次 ±1~5', '约会、表白、争吵等重要事件可到 ±10'],
        },
        { path: '角色.心情', type: 'string', label: '心情', init: '', desc: '{{char}}此刻的心情', check: ['2~6 字，随对话变化'] },
        { path: '角色.心声', type: 'string', label: '心声', init: '', desc: '{{char}}此刻没有说出口的心里话', check: ['一句话，20 字以内，符合{{char}}的性格'] },
        { path: '主角.日程', type: 'list', label: '日程', init: [], maxItems: 5, widget: 'tags', desc: '{{user}}接下来的约定或安排', check: ['新约定用 insert 追加到 /主角/日程/-，写成「时间 事情」', '事情结束或取消后用 remove 删除'] },
        { path: '角色.回忆', type: 'list', label: '回忆', init: [], maxItems: 6, widget: 'tags', desc: '{{char}}和{{user}}之间值得纪念的事', check: ['有重要的共同经历时追加一条，10 字左右', '超过上限时最早的一条会被自动挤掉'] },
    ],
};

const CAMPUS_SAMPLE = {
    世界: { 日期: '4月12日 周五', 时段: '放学后', 地点: '教学楼天台' },
    角色: { 关系: '朋友', 好感度: 57, 心情: '有点害羞', 心声: '明天……他会来吗？', 回忆: ['开学典礼上捡到她的发卡', '雨天共撑一把伞', '一起留下来值日'] },
    主角: { 日程: ['周六 10:00 车站前集合', '周一 交数学作业'] },
};

const CAMPUS_HTML = `<style>
.lv{--lv-fg:#4b3a45;--lv-muted:#9c8293;--lv-pink:#e2588a;--lv-pink-2:#f4a3c0;--lv-line:#f2d3de;--lv-lav:#9a80e6;max-width:760px;margin:4px auto;color:var(--lv-fg);background:radial-gradient(circle at 94% 6%,rgba(255,196,214,.6),transparent 30%),radial-gradient(circle at 3% 97%,rgba(205,188,255,.45),transparent 34%),linear-gradient(165deg,#fffafb,#fff1f5 55%,#f8f2ff);border:1px solid var(--lv-line);border-radius:16px;box-shadow:0 2px 10px rgba(226,88,138,.12);font:13px/1.6 system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;overflow:hidden}
.lv>summary{list-style:none;cursor:pointer;display:flex;flex-wrap:wrap;align-items:center;gap:6px 10px;padding:10px 16px;user-select:none}
.lv>summary::-webkit-details-marker{display:none}
.lv>summary:focus-visible{outline:2px solid var(--lv-pink);outline-offset:-3px;border-radius:14px}
.lv-heart{flex:none;width:18px;height:18px;color:var(--lv-pink);animation:lv-beat 2.4s ease-in-out infinite}
@keyframes lv-beat{0%,40%,100%{transform:scale(1)}10%{transform:scale(1.18)}20%{transform:scale(1)}30%{transform:scale(1.1)}}
.lv-name{font-size:15px;font-weight:700;letter-spacing:.04em}
.lv-rel{padding:0 10px;border-radius:999px;background:var(--lv-pink);color:#fff;font-size:12px;line-height:20px}
.lv-when{margin-left:auto;color:var(--lv-muted);font-size:12px}
.lv-chev{flex:none;width:14px;height:14px;color:var(--lv-muted);transition:transform .2s}
.lv[open] .lv-chev{transform:rotate(90deg)}
.lv-body{padding:0 16px 16px}
.lv-place{display:inline-flex;align-items:center;gap:4px;color:var(--lv-muted);font-size:12px}
.lv-place svg{width:12px;height:12px}
.lv-steps{display:flex;margin:10px 0 2px}
.lv-step{position:relative;flex:1 1 0;min-width:0;padding-top:17px;color:var(--lv-muted);font-size:11px;text-align:center;white-space:nowrap}
.lv-step::after{content:"";position:absolute;top:7px;left:-50%;width:100%;height:2px;background:#f4d2de}
.lv-step:first-child::after{display:none}
.lv-step::before{content:"";position:absolute;top:3px;left:50%;z-index:1;width:10px;height:10px;margin-left:-5px;border:2px solid #f0c0d1;border-radius:50%;background:#fff}
.lv-step.done::before{border-color:var(--lv-pink-2);background:var(--lv-pink-2)}
.lv-step.done::after,.lv-step.now::after{background:linear-gradient(90deg,var(--lv-pink-2),var(--lv-pink))}
.lv-step.now{color:var(--lv-pink);font-weight:700}
.lv-step.now::before{top:1px;width:14px;height:14px;margin-left:-7px;border-color:#fff;background:var(--lv-pink);box-shadow:0 0 0 3px rgba(226,88,138,.25)}
.lv-aff{display:grid;grid-template-columns:auto minmax(60px,1fr) auto auto;align-items:center;gap:8px;margin:12px 0 10px}
.lv-k{color:var(--lv-muted);font-size:12px}
.lv-meter{height:10px;border-radius:999px;background:#fbe3ea;overflow:hidden}
.lv-meter>i{display:block;width:var(--nl-pct,0%);height:100%;border-radius:inherit;background:linear-gradient(90deg,#ffc2d4,var(--lv-pink));box-shadow:0 0 8px rgba(226,88,138,.45);transition:width .6s ease}
.lv-num{color:var(--lv-pink);font-variant-numeric:tabular-nums}
.lv-stage{padding:0 8px;border:1px solid var(--lv-pink-2);border-radius:999px;color:var(--lv-pink);font-size:12px;line-height:18px}
.lv-stage:empty{display:none}
.lv-feel{display:flex;align-items:flex-start;gap:10px}
.lv-mood{flex:none;padding:0 10px;border-radius:999px;background:#efe9ff;color:#6650c2;font-size:12px;line-height:24px}
.lv-voice{flex:1;min-width:0;margin:0;padding:5px 12px;border:1px solid var(--lv-line);border-radius:4px 14px 14px 14px;background:#fff;color:#6a5662;font-style:italic}
.lv-voice::before{content:"心声　";color:var(--lv-pink);font-size:11px;font-style:normal;letter-spacing:.06em}
.lv-cols{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:12px;margin-top:12px}
.lv-box{padding:8px 12px 10px;border:1px solid var(--lv-line);border-radius:12px;background:rgba(255,255,255,.72)}
.lv-box h5{display:flex;align-items:center;gap:5px;margin:0 0 4px;color:var(--lv-pink);font-size:12px;font-weight:700;letter-spacing:.08em}
.lv-box h5 svg{width:13px;height:13px}
.lv-list,.lv-mem{margin:0;padding:0;list-style:none}
.lv-list li{position:relative;padding:3px 0 3px 18px;border-bottom:1px dashed #f1d3de}
.lv-list li:last-child{border-bottom:0}
.lv-list li::before{content:"";position:absolute;top:9px;left:2px;width:8px;height:8px;border:1.5px solid var(--lv-pink-2);border-radius:2px}
.lv-mem li{position:relative;padding:2px 0 6px 16px}
.lv-mem li::before{content:"";position:absolute;top:8px;left:3px;width:7px;height:7px;border-radius:50%;background:var(--lv-lav)}
.lv-mem li::after{content:"";position:absolute;top:16px;bottom:-1px;left:6px;width:1px;background:#d9cdf7}
.lv-mem li:last-of-type::after{display:none}
.lv .nl-each-empty{color:var(--lv-muted);font-size:12px}
@media (max-width:480px){.lv-cols{grid-template-columns:minmax(0,1fr)}.lv-chev{order:1;margin-left:auto}.lv-when{order:2;width:100%;margin-left:0}}
@media (prefers-reduced-motion:reduce){.lv :where(*),.lv :where(*)::before{animation:none!important;transition:none!important}}
</style>
<details class="lv" open>
<summary>
<svg class="lv-heart" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 20.5s-7.5-4.6-7.5-10.4A4.3 4.3 0 0 1 12 7.4a4.3 4.3 0 0 1 7.5 2.7c0 5.8-7.5 10.4-7.5 10.4z"/></svg>
<span class="lv-name">{{char}}</span>
<span class="lv-rel" title="关系" data-nl-text="角色.关系"></span>
<span class="lv-when"><span data-nl-text="世界.日期"></span> · <span data-nl-text="世界.时段"></span></span>
<svg class="lv-chev" ${SVG}><path d="m9 6 6 6-6 6"/></svg>
</summary>
<div class="lv-body">
<div class="lv-place">${ICON_PIN}<span data-nl-text="世界.地点"></span></div>
<div class="lv-steps" data-lv-steps aria-label="关系进展"></div>
<div class="lv-aff">
<span class="lv-k">好感</span>
<span class="lv-meter" data-nl-bar="角色.好感度"><i></i></span>
<b class="lv-num" data-nl-text="角色.好感度"></b>
<span class="lv-stage" data-nl-stage="角色.好感度"></span>
</div>
<div class="lv-feel">
<span class="lv-mood" title="心情" data-nl-text="角色.心情"></span>
<p class="lv-voice" data-nl-text="角色.心声" data-nl-empty="……"></p>
</div>
<div class="lv-cols">
<section class="lv-box"><h5><svg ${SVG}><rect x="4" y="5" width="16" height="15" rx="2"/><path d="M8 3v4M16 3v4M4 10h16"/></svg>日程</h5><ul class="lv-list" data-nl-each="主角.日程" data-nl-empty="暂时没有约定"><template><li data-nl-item=""></li></template></ul></section>
<section class="lv-box"><h5><svg ${SVG}><path d="M12 8v4l2.5 2.5"/><circle cx="12" cy="12" r="8.5"/></svg>回忆</h5><ol class="lv-mem" data-nl-each="角色.回忆" data-nl-empty="还没有共同的回忆"><template><li data-nl-item=""></li></template></ol></section>
</div>
</div>
</details>
<script>
(function () {
    function relationOptions(spec) {
        var vars = (spec && spec.variables) || [];
        for (var i = 0; i < vars.length; i++) if (vars[i].path === '角色.关系') return vars[i].options || [];
        return [];
    }
    window.nlRender = function (stat, ctx) {
        var box = document.querySelector('[data-lv-steps]');
        if (!box) return;
        var opts = relationOptions(ctx.spec);
        var cur = opts.indexOf(String(ctx.get('角色.关系', '')));
        box.textContent = '';
        box.hidden = !opts.length;
        opts.forEach(function (name, i) {
            var step = document.createElement('span');
            step.className = 'lv-step' + (i < cur ? ' done' : '') + (i === cur ? ' now' : '');
            step.textContent = name;
            box.appendChild(step);
        });
    };
})();
</script>`;

// ---- 赛博朋克：霓虹 HUD + 多角色卡片网格 + 详情弹层 ----

const CYBER_SPEC = {
    title: '神经链接',
    variables: [
        { path: '世界.时间', type: 'string', label: '时间', init: '', desc: '当前时间（如“2189-03-14 23:47”）', check: ['每轮按剧情推进'] },
        { path: '世界.地点', type: 'string', label: '地点', init: '', check: ['场景转换时更新，写成「城区 · 具体地点」'] },
        { path: '主角.信用点', type: 'number', label: '信用点', init: 0, min: 0, integer: true, widget: 'text', desc: '{{user}}持有的信用点', check: ['交易、报酬、贿赂时用 delta 增减，不能为负'] },
        {
            path: '主角.通缉', type: 'number', label: '通缉等级', init: 0, min: 0, max: 5, integer: true, widget: 'bar',
            stages: [{ min: 0, label: '安全' }, { min: 1, label: '留意' }, { min: 3, label: '追查' }, { min: 5, label: '通缉' }],
            desc: '{{user}}被警方或企业追查的程度', check: ['引发骚乱、被监控拍到时上升，藏匿或打点后下降，单次 ±1'],
        },
        { path: '主角.义体负荷', type: 'number', label: '义体负荷', init: 20, min: 0, max: 100, integer: true, widget: 'bar', desc: '义体给{{user}}神经系统带来的负担', check: ['加装义体或超频使用时上升，休息或维护后下降', '超过 80 时会出现排异反应'] },
        {
            path: '角色', type: 'record', label: '在场角色', keyDesc: '角色名', widget: 'list',
            value: {
                type: 'object',
                fields: [
                    { key: '身份', type: 'string', init: '' },
                    { key: '阵营', type: 'string', init: '' },
                    { key: '好感', type: 'number', min: 0, max: 100, integer: true, init: 30 },
                    { key: '心情', type: 'string', init: '' },
                    { key: '状态', type: 'string', init: '' },
                    { key: '想法', type: 'string', init: '' },
                ],
            },
            init: {},
            desc: '当前场景中与{{user}}互动的角色',
            check: ['角色登场时用 insert 新增，键为角色名', '角色离开当前场景后用 remove 删除', '好感单次变化 ±1~5；想法写一句没说出口的话'],
        },
    ],
};

const CYBER_SAMPLE = {
    世界: { 时间: '2189-03-14 23:47', 地点: '第七区 · 霓虹夜市' },
    主角: { 信用点: 12480, 通缉: 2, 义体负荷: 38 },
    角色: {
        夜鸦: { 身份: '情报掮客', 阵营: '自由人', 好感: 62, 心情: '戒备', 状态: '左臂义体过热', 想法: '这单报酬高得不正常。' },
        白鹭: { 身份: '企业安保主管', 阵营: '企业', 好感: 18, 心情: '冷淡', 状态: '执勤中', 想法: '又是这群街头老鼠。' },
        零号: { 身份: '地下义体医生', 阵营: '街头诊所', 好感: 81, 心情: '愉快', 状态: '刚做完一台手术', 想法: '今晚的咖啡是真豆子。' },
    },
};

const CYBER_HTML = `<style>
.cy{--cy-bg1:#05060d;--cy-bg2:#0b1022;--cy-bg3:#121733;--cy-card:rgba(14,19,40,.8);--cy-cyan:#00f0ff;--cy-mag:#ff2d8a;--cy-vio:#b967ff;--cy-lime:#a6ff00;--cy-amber:#ffb400;--cy-red:#ff2b4a;--cy-fg:#d8eaff;--cy-sub:#7f8fb8;--cy-line:rgba(0,240,255,.32);--cy-mono:"JetBrains Mono","Cascadia Code",Consolas,"SF Mono",ui-monospace,monospace;position:relative;isolation:isolate;max-width:760px;margin:6px auto;color:var(--cy-fg);background:linear-gradient(135deg,var(--cy-bg1),var(--cy-bg2) 60%,var(--cy-bg3));border:1px solid var(--cy-line);border-radius:6px;box-shadow:0 0 0 1px rgba(0,240,255,.08),0 0 14px rgba(0,240,255,.28);font:13px/1.5 "Rajdhani","Bahnschrift","Segoe UI",system-ui,"PingFang SC","Microsoft YaHei",sans-serif;overflow:hidden}
.cy::before{content:"";position:absolute;inset:0;z-index:-1;pointer-events:none;background:repeating-linear-gradient(0deg,rgba(0,240,255,.035) 0 1px,transparent 1px 3px),radial-gradient(circle at 16% 20%,rgba(255,45,138,.13),transparent 42%),radial-gradient(circle at 86% 80%,rgba(0,240,255,.1),transparent 45%)}
.cy>summary{list-style:none;cursor:pointer;display:flex;align-items:center;gap:10px;padding:10px 14px;background:linear-gradient(90deg,rgba(0,240,255,.16),rgba(255,45,138,.1) 55%,transparent);border-bottom:1px solid transparent;user-select:none}
.cy[open]>summary{border-bottom-color:var(--cy-line)}
.cy>summary::-webkit-details-marker{display:none}
.cy>summary:focus-visible{outline:1px solid var(--cy-cyan);outline-offset:-3px}
.cy-logo{flex:none;width:20px;height:20px;color:var(--cy-cyan);filter:drop-shadow(0 0 4px var(--cy-cyan))}
.cy-title{flex:1;min-width:0;color:var(--cy-cyan);font-weight:700;letter-spacing:.18em;text-shadow:0 0 6px rgba(0,240,255,.8),0 0 14px rgba(0,240,255,.4);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cy-title em{margin-left:.6em;color:var(--cy-mag);font-style:normal;letter-spacing:.08em;text-shadow:0 0 6px rgba(255,45,138,.8)}
.cy-live{display:inline-flex;align-items:center;gap:6px;color:var(--cy-lime);font:600 11px/1 var(--cy-mono);letter-spacing:.12em}
.cy-live i{width:7px;height:7px;border-radius:50%;background:var(--cy-lime);box-shadow:0 0 6px var(--cy-lime);animation:cy-blink 1.6s ease-in-out infinite}
@keyframes cy-blink{50%{opacity:.25}}
.cy-chev{flex:none;width:14px;height:14px;color:var(--cy-cyan);transition:transform .25s}
.cy[open] .cy-chev{transform:rotate(180deg)}
.cy-body{padding:12px 14px 14px}
.cy-hud{position:relative;display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:10px 16px;padding:10px 12px;overflow:hidden;background:linear-gradient(var(--cy-cyan),var(--cy-cyan)) top left/12px 1px no-repeat,linear-gradient(var(--cy-cyan),var(--cy-cyan)) top left/1px 12px no-repeat,linear-gradient(var(--cy-cyan),var(--cy-cyan)) bottom right/12px 1px no-repeat,linear-gradient(var(--cy-cyan),var(--cy-cyan)) bottom right/1px 12px no-repeat,rgba(0,240,255,.045);border:1px solid rgba(0,240,255,.16)}
.cy-hud::before{content:"";position:absolute;top:0;left:-60%;width:60%;height:1px;background:linear-gradient(90deg,transparent,var(--cy-cyan),transparent);animation:cy-scan 4.5s linear infinite}
@keyframes cy-scan{to{left:100%}}
.cy-hi{display:flex;flex-direction:column;gap:4px;min-width:0}
.cy-hk{color:var(--cy-sub);font:600 10px/1 var(--cy-mono);letter-spacing:.16em;white-space:nowrap}
.cy-hk b{color:var(--cy-fg);font-weight:600;letter-spacing:.04em}
.cy-hv{color:var(--cy-cyan);font:600 13px/1.3 var(--cy-mono);text-shadow:0 0 6px rgba(0,240,255,.6);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cy-hv.cy-cr{color:var(--cy-mag);text-shadow:0 0 6px rgba(255,45,138,.6)}
.cy-segw{display:block;filter:drop-shadow(0 0 3px var(--sc,var(--cy-cyan)))}
.cy-seg{--seg:20%;position:relative;display:block;height:7px;transform:skewX(-18deg);background:rgba(255,255,255,.1);-webkit-mask:repeating-linear-gradient(90deg,#000 0 calc(var(--seg) - 3px),transparent calc(var(--seg) - 3px) var(--seg));mask:repeating-linear-gradient(90deg,#000 0 calc(var(--seg) - 3px),transparent calc(var(--seg) - 3px) var(--seg))}
.cy-seg>i{position:absolute;inset:0;background:var(--sc,var(--cy-cyan));clip-path:inset(0 calc(100% - var(--nl-pct,0%)) 0 0);transition:clip-path .5s ease}
.cy-heat[data-nl-value="3"],.cy-heat[data-nl-value="4"]{--sc:var(--cy-amber)}
.cy-heat[data-nl-value="5"]{--sc:var(--cy-red)}
.cy-load{--seg:10%}
.cy-load>i{background:linear-gradient(90deg,var(--cy-lime),var(--cy-amber) 65%,var(--cy-red))}
.cy-sec{display:flex;align-items:center;gap:10px;margin:14px 0 8px;color:var(--cy-mag);font:700 11px/1 var(--cy-mono);letter-spacing:.2em;text-shadow:0 0 6px rgba(255,45,138,.7)}
.cy-sec::after{content:"";flex:1;height:1px;background:linear-gradient(90deg,rgba(255,45,138,.6),transparent)}
.cy-sec b{color:var(--cy-sub);font-weight:600;text-shadow:none}
.cy-wrap{display:grid}
.cy-wrap>.cy-grid,.cy-wrap>.cy-detail{grid-area:1/1;min-width:0}
.cy-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));align-content:start;gap:10px;transition:filter .25s,opacity .25s}
.cy-wrap.is-open .cy-grid{opacity:.55;filter:blur(2px) brightness(.5);pointer-events:none}
.cy-grid .nl-each-empty{grid-column:1/-1;padding:18px;border:1px dashed rgba(0,240,255,.25);border-radius:4px;color:var(--cy-sub);font:600 12px/1.4 var(--cy-mono);letter-spacing:.14em;text-align:center}
.cy-card{--sc:var(--cy-cyan);position:relative;display:flex;flex-direction:column;gap:4px;width:100%;min-width:0;margin:0;padding:10px 10px 9px;color:inherit;font:inherit;text-align:left;cursor:pointer;-webkit-appearance:none;appearance:none;background:linear-gradient(160deg,rgba(255,255,255,.05),transparent 40%),var(--cy-card);border:1px solid var(--sc);border-radius:4px;box-shadow:0 0 6px color-mix(in srgb,var(--sc) 60%,transparent),inset 0 0 18px rgba(0,0,0,.55);transition:transform .2s,box-shadow .2s}
.cy-card::before{content:"";position:absolute;top:-1px;right:-1px;width:14px;height:14px;background:linear-gradient(225deg,var(--sc) 50%,transparent 50%)}
.cy-card:hover,.cy-card:focus-visible{outline:none;transform:translateY(-2px);box-shadow:0 0 14px var(--sc),inset 0 0 18px rgba(0,0,0,.55)}
.cy-card.s1,.cy-detail.s1{--sc:var(--cy-amber)}
.cy-card.s2,.cy-detail.s2{--sc:var(--cy-mag)}
.cy-card.s3,.cy-detail.s3{--sc:var(--cy-vio)}
.cy-ct{display:flex;align-items:center;justify-content:space-between;gap:6px;color:var(--cy-sub);font:600 10px/1.2 var(--cy-mono);letter-spacing:.12em}
.cy-fac{min-width:0;color:var(--sc);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cy-op{flex:none;opacity:.75}
.cy-nm{color:#fff;font-size:17px;font-weight:700;letter-spacing:.06em;text-shadow:0 0 8px var(--sc);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cy-rl{color:var(--cy-sub);font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cy-card .cy-segw{margin:4px 0 2px}
.cy-meter{--seg:25%;height:8px}
.cy-ln{display:flex;justify-content:space-between;gap:8px;color:var(--cy-sub);font-size:12px}
.cy-ln b{min-width:0;color:var(--cy-fg);font:600 12px/1.4 var(--cy-mono);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cy-detail{--sc:var(--cy-cyan);position:relative;z-index:2;display:flex;align-self:start;gap:16px;padding:16px;background:linear-gradient(135deg,rgba(11,16,34,.97),rgba(18,23,51,.97));border:1px solid var(--sc);border-radius:6px;box-shadow:0 0 24px color-mix(in srgb,var(--sc) 55%,transparent),inset 0 0 30px rgba(0,0,0,.5);animation:cy-pop .22s ease-out}
@keyframes cy-pop{from{opacity:0;transform:translateY(6px) scale(.98)}}
.cy-x{position:absolute;top:8px;right:8px;display:grid;place-items:center;width:28px;height:28px;padding:0;border:1px solid var(--cy-line);border-radius:4px;background:rgba(0,0,0,.35);color:var(--cy-cyan);cursor:pointer}
.cy-x:hover,.cy-x:focus-visible{outline:none;background:rgba(0,240,255,.12);box-shadow:0 0 8px rgba(0,240,255,.5)}
.cy-x svg{width:14px;height:14px}
.cy-port{position:relative;flex:none;align-self:flex-start;display:grid;place-items:center;width:112px;aspect-ratio:13/19;border:1px solid var(--sc);background:repeating-linear-gradient(0deg,rgba(255,255,255,.04) 0 1px,transparent 1px 4px),radial-gradient(circle at 50% 36%,color-mix(in srgb,var(--sc) 35%,transparent),transparent 70%),#070a16;box-shadow:inset 0 0 20px rgba(0,0,0,.7)}
.cy-port::before,.cy-port::after{content:"";position:absolute;width:14px;height:14px;border:2px solid var(--sc)}
.cy-port::before{top:-4px;left:-4px;border-right:0;border-bottom:0}
.cy-port::after{right:-4px;bottom:-4px;border-top:0;border-left:0}
.cy-glyph{color:#fff;font-size:44px;font-weight:700;text-shadow:0 0 12px var(--sc),0 0 24px var(--sc)}
.cy-port small{position:absolute;right:0;bottom:7px;left:0;color:var(--sc);font:600 9px/1 var(--cy-mono);letter-spacing:.2em;text-align:center}
.cy-info{flex:1;min-width:0;padding-right:30px}
.cy-dn{color:#fff;font-size:22px;font-weight:700;letter-spacing:.08em;text-shadow:0 0 10px var(--sc)}
.cy-dr{color:var(--cy-sub);font-size:12px}
.cy-grp{margin:12px 0 6px;padding-left:8px;border-left:3px solid var(--cy-mag);color:var(--cy-mag);font:700 11px/1.2 var(--cy-mono);letter-spacing:.18em;text-shadow:0 0 6px rgba(255,45,138,.6)}
.cy-f{display:flex;align-items:center;gap:10px;padding:5px 0;border-bottom:1px dashed rgba(0,240,255,.16)}
.cy-f>span{flex:none;width:3em;color:var(--cy-sub);font-size:12px}
.cy-f>b{min-width:0;font-weight:600;overflow-wrap:anywhere}
.cy-f>b.cy-badge{padding:0 8px;border:1px solid var(--sc);border-radius:3px;background:rgba(0,0,0,.45);color:var(--sc);font:700 12px/1.6 var(--cy-mono);text-shadow:0 0 4px currentColor}
.cy-gauge{display:flex;align-items:center;gap:14px}
.cy-ring{flex:none;width:76px;height:76px;transform:rotate(-90deg)}
.cy-ring circle{fill:none;stroke-width:6}
.cy-ring .bg{stroke:rgba(255,255,255,.08)}
.cy-ring .fg{stroke:var(--sc);stroke-linecap:round;filter:drop-shadow(0 0 5px var(--sc));transition:stroke-dasharray .5s ease}
.cy-gv{color:#fff;font:700 26px/1 var(--cy-mono);text-shadow:0 0 10px var(--sc)}
.cy-gv small{display:block;margin-top:5px;color:var(--cy-sub);font:600 10px/1 var(--cy-mono);letter-spacing:.16em;text-shadow:none}
.cy-think{margin:12px 0 0;padding:9px 12px;border-left:3px solid var(--cy-vio);background:rgba(185,103,255,.09);color:#e6dcff;font-size:13px;font-style:italic;line-height:1.55}
.cy-think:empty{display:none}
@media (max-width:520px){.cy-detail{flex-direction:column;align-items:stretch}.cy-port{width:84px}.cy-info{padding-right:0}.cy-title em{display:none}}
@media (prefers-reduced-motion:reduce){.cy :where(*),.cy :where(*)::before{animation:none!important;transition:none!important}}
</style>
<details class="cy" open>
<summary>
<svg class="cy-logo" ${SVG}><path d="M12 2.5 20.5 7.3v9.4L12 21.5l-8.5-4.8V7.3z"/><path d="M12 8v8M8.5 10l7 4M15.5 10l-7 4"/></svg>
<span class="cy-title">NEURAL LINK<em>// 状态</em></span>
<span class="cy-live"><i></i>ONLINE</span>
<svg class="cy-chev" ${SVG}><path d="m6 9 6 6 6-6"/></svg>
</summary>
<div class="cy-body">
<div class="cy-hud">
<div class="cy-hi"><span class="cy-hk">TIME // 时间</span><span class="cy-hv" data-nl-text="世界.时间"></span></div>
<div class="cy-hi"><span class="cy-hk">LOC // 地点</span><span class="cy-hv" data-nl-text="世界.地点"></span></div>
<div class="cy-hi"><span class="cy-hk">CREDITS // 信用点</span><span class="cy-hv cy-cr">¤ <span data-nl-text="主角.信用点"></span></span></div>
<div class="cy-hi"><span class="cy-hk">HEAT // <b data-nl-stage="主角.通缉"></b></span><span class="cy-segw"><span class="cy-seg cy-heat" data-nl-bar="主角.通缉"><i></i></span></span></div>
<div class="cy-hi"><span class="cy-hk">CYBER LOAD // <b><span data-nl-text="主角.义体负荷"></span>%</b></span><span class="cy-segw"><span class="cy-seg cy-load" data-nl-bar="主角.义体负荷"><i></i></span></span></div>
</div>
<div class="cy-sec">// 在场单位 <b class="cy-count">0</b></div>
<div class="cy-wrap">
<div class="cy-grid" data-nl-each="角色" data-nl-empty="NO SIGNAL · 暂无在场角色"><template><button type="button" class="cy-card"><span class="cy-ct"><span class="cy-fac" data-nl-item="阵营"></span><span class="cy-op">OPEN ▸</span></span><span class="cy-nm" data-nl-key></span><span class="cy-rl" data-nl-item="身份"></span><span class="cy-segw"><span class="cy-seg cy-meter" data-nl-item-bar="好感"><i></i></span></span><span class="cy-ln"><span>好感</span><b data-nl-item="好感"></b></span><span class="cy-ln"><span>心情</span><b data-nl-item="心情"></b></span></button></template></div>
<section class="cy-detail" role="dialog" aria-label="角色详情" hidden>
<button type="button" class="cy-x" aria-label="关闭详情"><svg ${SVG}><path d="M18 6 6 18M6 6l12 12"/></svg></button>
<div class="cy-port" aria-hidden="true"><span class="cy-glyph"></span><small>ID // SCAN</small></div>
<div class="cy-info">
<div class="cy-dn"></div>
<div class="cy-dr"></div>
<div class="cy-grp">// 基础档案</div>
<div class="cy-f"><span>阵营</span><b class="cy-badge cy-d-fac"></b></div>
<div class="cy-f"><span>心情</span><b class="cy-d-mood"></b></div>
<div class="cy-f"><span>状态</span><b class="cy-d-state"></b></div>
<div class="cy-grp">// 链接强度</div>
<div class="cy-gauge"><svg class="cy-ring" viewBox="0 0 80 80" aria-hidden="true"><circle class="bg" cx="40" cy="40" r="32"/><circle class="fg" cx="40" cy="40" r="32" pathLength="100" stroke-dasharray="0 100"/></svg><div class="cy-gv"><span class="cy-d-aff">0</span><small>好感 / 100</small></div></div>
<p class="cy-think"></p>
</div>
</section>
</div>
</div>
</details>
<script>
(function () {
    var last = {};
    var openKey = null;
    var lastKey = null;
    function people() {
        var r = last && last['角色'];
        return r && typeof r === 'object' && !Array.isArray(r) ? r : {};
    }
    function stage(v) {
        var n = Number(v);
        if (!isFinite(n)) n = 0;
        return n >= 75 ? 's3' : n >= 50 ? 's2' : n >= 25 ? 's1' : 's0';
    }
    function setStage(el, v) {
        el.classList.remove('s0', 's1', 's2', 's3');
        el.classList.add(stage(v));
    }
    function put(root, sel, v) {
        var el = root.querySelector(sel);
        if (el) el.textContent = v === undefined || v === null || v === '' ? '—' : String(v);
    }
    function keyOf(card) {
        var k = card.querySelector('[data-nl-key]');
        return k ? k.textContent : '';
    }
    function paint() {
        var list = people();
        document.querySelectorAll('.cy-grid > .cy-card').forEach(function (card) {
            var key = keyOf(card);
            setStage(card, (list[key] || {})['好感']);
            card.setAttribute('aria-label', key + '：查看详情');
        });
        var count = document.querySelector('.cy-count');
        if (count) count.textContent = String(Object.keys(list).length);
    }
    function close() {
        var box = document.querySelector('.cy-detail');
        var wrap = document.querySelector('.cy-wrap');
        var wasOpen = openKey !== null;
        openKey = null;
        if (box) box.hidden = true;
        if (wrap) wrap.classList.remove('is-open');
        if (!wasOpen) return;
        // 卡片在每次刷新时会重新生成，按名字找回刚才点开的那张，把焦点还给它
        var cards = document.querySelectorAll('.cy-grid > .cy-card');
        for (var i = 0; i < cards.length; i++) {
            if (keyOf(cards[i]) === lastKey) {
                cards[i].focus();
                break;
            }
        }
    }
    function show(key) {
        var p = people()[key];
        var box = document.querySelector('.cy-detail');
        var wrap = document.querySelector('.cy-wrap');
        if (!box || !wrap || !p || typeof p !== 'object') return close();
        openKey = key;
        setStage(box, p['好感']);
        put(box, '.cy-dn', key);
        put(box, '.cy-glyph', Array.from(key)[0] || '?');
        put(box, '.cy-dr', p['身份']);
        put(box, '.cy-d-fac', p['阵营']);
        put(box, '.cy-d-mood', p['心情']);
        put(box, '.cy-d-state', p['状态']);
        var aff = Math.max(0, Math.min(100, Number(p['好感']) || 0));
        put(box, '.cy-d-aff', Math.round(aff));
        var ring = box.querySelector('.cy-ring .fg');
        if (ring) ring.setAttribute('stroke-dasharray', aff + ' 100');
        var think = box.querySelector('.cy-think');
        if (think) think.textContent = p['想法'] ? String(p['想法']) : '';
        box.hidden = false;
        wrap.classList.add('is-open');
    }
    window.nlRender = function (stat) {
        last = stat && typeof stat === 'object' ? stat : {};
        paint();
        if (openKey !== null) show(openKey);
    };
    document.addEventListener('click', function (e) {
        var t = e.target && e.target.closest ? e.target : null;
        if (!t) return;
        if (t.closest('.cy-x')) {
            close();
            return;
        }
        var card = t.closest('.cy-card');
        if (!card) return;
        lastKey = keyOf(card);
        show(lastKey);
        var x = document.querySelector('.cy-x');
        if (x && openKey !== null) x.focus();
    });
    document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape' && openKey !== null) close();
    });
})();
</script>`;

function makeBuiltin({ id, name, desc, theme, spec, html, sample }) {
    const warnings = [];
    const normalized = normalizeStatusSpec(spec, { maxVars: DEFAULT_STATUS_BAR.maxVars, warnings });
    if (warnings.length) console.warn(`[NovelLoom] 内置状态栏模板「${name}」的变量表有问题：`, warnings);
    return deepFreeze({ id, builtin: true, name, desc, mode: 'bind', spec: normalized, html, theme, sample, createdAt: 0, updatedAt: 0 });
}

/** 内置状态栏模板（只读，已冻结；要改就先复制成自己的模板） */
export const BUILTIN_STATUSBAR_TEMPLATES = Object.freeze([
    makeBuiltin({
        id: 'builtin_general', name: '通用', theme: 'clean', spec: GENERAL_SPEC, html: GENERAL_HTML, sample: GENERAL_SAMPLE,
        desc: '时间、地点、天气，加上角色的好感、心情、着装、动作与内心想法；白底简洁卡片，适合大多数故事。',
    }),
    makeBuiltin({
        id: 'builtin_rpg', name: 'RPG', theme: 'night', spec: RPG_SPEC, html: RPG_HTML, sample: RPG_SAMPLE,
        desc: '冒险者面板：等级经验、生命法力、金币与属性，背包和任务分页显示；深色奇幻风。',
    }),
    makeBuiltin({
        id: 'builtin_campus', name: '校园恋爱', theme: 'paper', spec: CAMPUS_SPEC, html: CAMPUS_HTML, sample: CAMPUS_SAMPLE,
        desc: '好感阶段与关系进展、心情与心声、日程和共同回忆；粉色手账风。',
    }),
    makeBuiltin({
        id: 'builtin_cyberpunk', name: '赛博朋克', theme: 'night', spec: CYBER_SPEC, html: CYBER_HTML, sample: CYBER_SAMPLE,
        desc: '霓虹 HUD 顶栏（时间、地点、信用点、通缉、义体负荷）加多角色卡片网格，点开卡片看详情；深色霓虹风。',
    }),
]);

export function isBuiltinStatusBarTemplate(id) {
    return BUILTIN_STATUSBAR_TEMPLATES.some((t) => t.id === id);
}

// ---------------- 规整与校验 ----------------

function cleanName(v) {
    return String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, STATUS_TEMPLATE_NAME_MAX);
}

function nameKey(name) {
    return cleanName(name).toLowerCase();
}

function normalizeTemplateSpec(spec) {
    if (!isObj(spec) && !Array.isArray(spec)) return null;
    const s = normalizeStatusSpec(spec, { maxVars: STORE_MAX_VARS });
    return s.variables.length ? s : null;
}

/**
 * 把任意来源的模板数据规整成存储形状（不含 id/时间）；strict 时缺名称、没内容、界面过大会抛错。
 * @returns {{name:string, desc:string, mode:string, spec:object|null, html:string, theme:string, sample:object|null}}
 */
function cleanTemplateData(data, { strict = true } = {}) {
    const src = isObj(data) ? data : {};
    const name = cleanName(src.name);
    const html = typeof src.html === 'string' ? src.html : '';
    let mode = STATUS_TEMPLATE_MODES.includes(src.mode) ? src.mode : html.trim() ? 'bind' : 'auto';
    if (mode === 'bind' && !html.trim()) mode = 'auto';
    const out = {
        name,
        desc: String(src.desc ?? '').trim().slice(0, STATUS_TEMPLATE_DESC_MAX),
        mode,
        spec: normalizeTemplateSpec(src.spec),
        html: mode === 'auto' ? '' : html,
        theme: THEMES.includes(src.theme) ? src.theme : 'clean',
        sample: isObj(src.sample) ? clone(src.sample) : null,
    };
    if (strict) {
        if (!out.name) throw new Error('请输入模板名称');
        if (out.html.length > STATUS_TEMPLATE_HTML_MAX) throw new Error(`模板的界面代码太大（${Math.round(out.html.length / 1000)}K 字符，上限 ${STATUS_TEMPLATE_HTML_MAX / 1000}K）`);
        if (mode === 'raw' && !out.html.trim()) throw new Error('自定义 HTML 模板的界面代码不能为空');
        if (!out.spec && !out.html.trim()) throw new Error('模板里既没有变量也没有界面代码');
    }
    return out;
}

function storedList(settings) {
    if (!Array.isArray(settings.statusBarTemplates)) settings.statusBarTemplates = [];
    return settings.statusBarTemplates;
}

function toListItem(raw) {
    const t = cleanTemplateData(raw, { strict: false });
    return {
        id: String(raw.id),
        builtin: false,
        ...t,
        name: t.name || '未命名模板',
        createdAt: Number(raw.createdAt) || 0,
        updatedAt: Number(raw.updatedAt) || Number(raw.createdAt) || 0,
    };
}

function assertUniqueName(settings, name, exceptId = null) {
    const key = nameKey(name);
    if (listStatusBarTemplates(settings).some((t) => t.id !== exceptId && nameKey(t.name) === key)) {
        throw new Error(`已有同名的状态栏模板「${cleanName(name)}」`);
    }
}

/** 在现有模板名里找一个不重复的名字（「名字」「名字 2」「名字 3」…） */
export function uniqueStatusBarTemplateName(settings, base) {
    const b = cleanName(base) || '状态栏模板';
    const taken = new Set(listStatusBarTemplates(settings).map((t) => nameKey(t.name)));
    if (!taken.has(nameKey(b))) return b;
    for (let i = 2; i < 1000; i++) {
        const suffix = ` ${i}`;
        const n = `${b.slice(0, STATUS_TEMPLATE_NAME_MAX - suffix.length)}${suffix}`;
        if (!taken.has(nameKey(n))) return n;
    }
    return `${b.slice(0, STATUS_TEMPLATE_NAME_MAX - 7)} ${Date.now() % 100000}`;
}

// ---------------- 增删改查 ----------------

/**
 * 全部模板：内置在前（只读，返回副本），然后是 settings.statusBarTemplates 里的用户模板。
 * 用户列表里与内置同 id 的项被忽略（内置模板不能被覆盖），没有 id 的项被跳过。
 * @returns {object[]} [{id, builtin, name, desc, mode, spec|null, html, theme, sample|null, createdAt, updatedAt}]
 */
export function listStatusBarTemplates(settings) {
    const user = Array.isArray(settings?.statusBarTemplates) ? settings.statusBarTemplates : [];
    const seen = new Set(BUILTIN_STATUSBAR_TEMPLATES.map((t) => t.id));
    const own = [];
    for (const raw of user) {
        if (!isObj(raw) || !raw.id || seen.has(String(raw.id))) continue;
        seen.add(String(raw.id));
        own.push(toListItem(raw));
    }
    return [...BUILTIN_STATUSBAR_TEMPLATES.map((t) => clone(t)), ...own];
}

export function getStatusBarTemplate(settings, id) {
    if (!id) return null;
    return listStatusBarTemplates(settings).find((t) => t.id === id) || null;
}

/**
 * 新建用户模板（名称必填、去首尾空白、不能与已有模板重名，不分大小写）。
 * @param {{name:string, desc?:string, mode?:string, spec?:object|null, html?:string, theme?:string, sample?:object|null}} data
 * @returns {object} 存进 settings.statusBarTemplates 的对象（id 为 sbtpl_…）
 */
export function addStatusBarTemplate(settings, data) {
    const t = cleanTemplateData(data);
    assertUniqueName(settings, t.name);
    const now = Date.now();
    const item = { id: uid('sbtpl_'), ...t, createdAt: now, updatedAt: now };
    storedList(settings).push(item);
    return item;
}

/**
 * 修改用户模板（patch 里出现的字段才改）。内置模板会抛错；找不到返回 null；改名同样要求不重名。
 */
export function updateStatusBarTemplate(settings, id, patch = {}) {
    if (isBuiltinStatusBarTemplate(id)) throw new Error('内置模板不能修改，可以先「复制」成自己的模板再改');
    const list = storedList(settings);
    const i = list.findIndex((x) => isObj(x) && x.id === id);
    if (i < 0) return null;
    const cur = list[i];
    const fields = ['name', 'desc', 'mode', 'spec', 'html', 'theme', 'sample'];
    const merged = cleanTemplateData({ ...Object.fromEntries(fields.map((k) => [k, cur[k]])), ...Object.fromEntries(fields.filter((k) => patch[k] !== undefined).map((k) => [k, patch[k]])) });
    if (nameKey(merged.name) !== nameKey(cur.name)) assertUniqueName(settings, merged.name, id);
    const next = { ...cur, ...merged, id, createdAt: cur.createdAt || Date.now(), updatedAt: Date.now() };
    list[i] = next;
    return next;
}

/** 删除用户模板；内置模板或不存在时返回 false */
export function removeStatusBarTemplate(settings, id) {
    if (isBuiltinStatusBarTemplate(id) || !Array.isArray(settings?.statusBarTemplates)) return false;
    const n = settings.statusBarTemplates.length;
    settings.statusBarTemplates = settings.statusBarTemplates.filter((t) => t?.id !== id);
    return settings.statusBarTemplates.length !== n;
}

/** 复制任一模板（含内置）成新的用户模板；name 留空时用「原名 副本」（自动避开重名） */
export function duplicateStatusBarTemplate(settings, id, name = '') {
    const src = getStatusBarTemplate(settings, id);
    if (!src) return null;
    const n = cleanName(name) || uniqueStatusBarTemplateName(settings, `${src.name} 副本`);
    return addStatusBarTemplate(settings, { ...src, name: n });
}

/** 把卡片当前的状态栏做成模板数据（还没保存；保存用 addStatusBarTemplate） */
export function templateFromStatusBar(card, { name = '', desc = '' } = {}) {
    const sb = card?.statusBar || {};
    const html = typeof sb.html === 'string' ? sb.html : '';
    let mode = STATUS_TEMPLATE_MODES.includes(sb.mode) ? sb.mode : 'bind';
    if (mode === 'bind' && !html.trim()) mode = 'auto';
    return {
        name: cleanName(name) || cleanName(`${card?.data?.name || '角色'}的状态栏`),
        desc: String(desc ?? '').trim().slice(0, STATUS_TEMPLATE_DESC_MAX),
        mode,
        spec: sb.spec?.variables?.length ? clone(sb.spec) : null,
        html: mode === 'auto' ? '' : html,
        theme: THEMES.includes(sb.theme) ? sb.theme : 'clean',
        sample: isObj(sb.sample) ? clone(sb.sample) : null,
    };
}

// ---------------- 套用 ----------------

/**
 * 把模板套用到角色卡的状态栏（会先 ensureStatusBar）。
 * - structure（沿用结构）：复制变量表（按 maxVars 截断）、界面、模式、主题、示例数据，清掉手写覆盖；
 *   之后可让 AI 按这个结构填初始值与规则：ai = {parts:['init','rules'], templateMode:'structure'}
 * - look（只借外观；'style' 是别名）：保留本卡变量表与示例数据，只换主题并记下 templateId；
 *   模板是内置排版时直接切到内置排版（ai = null），否则界面要 AI 按模板重写：ai = {parts:['html'], templateMode:'style'}
 * 两种方式都会把套用前的 {spec, html, mode, theme, sample, templateId, overrides} 存进 statusBar.prev（一步撤销）。
 * @param {object} card
 * @param {object} template listStatusBarTemplates / getStatusBarTemplate 返回的模板
 * @param {'structure'|'look'|'style'} mode
 * @param {{settings?: object, maxVars?: number}} opt settings 用于新建状态栏的默认值与 statusBar.maxVars
 * @returns {{statusBar: object, warnings: string[], ai: {parts: string[], templateMode: string}|null}}
 */
export function applyStatusBarTemplate(card, template, mode = 'structure', { settings = null, maxVars = null } = {}) {
    const how = mode === 'style' ? 'look' : mode;
    if (!STATUS_TEMPLATE_APPLY_MODES.includes(how)) throw new Error(`未知的套用方式：${mode}`);
    if (!isObj(template)) throw new Error('没有找到这个状态栏模板');
    const t = cleanTemplateData(template, { strict: false });
    if (how === 'structure' && !t.spec) throw new Error('这个模板没有变量表，只能「只借外观」');
    const sb = ensureStatusBar(card, settings);
    const warnings = [];
    sb.prev = {
        spec: clone(sb.spec), html: sb.html, mode: sb.mode, theme: sb.theme,
        sample: clone(sb.sample ?? null), templateId: sb.templateId ?? null, overrides: clone(sb.overrides),
    };
    let ai = null;
    if (how === 'structure') {
        const cap = maxVars ?? settings?.statusBar?.maxVars ?? DEFAULT_STATUS_BAR.maxVars;
        sb.spec = normalizeStatusSpec(t.spec, { charName: card?.data?.name || '', maxVars: cap, warnings });
        sb.mode = t.mode;
        sb.html = t.html;
        sb.theme = t.theme;
        sb.sample = t.sample;
        const ov = sb.overrides || {};
        if (['schemaScript', 'updateRules', 'initvar'].some((k) => typeof ov[k] === 'string' && ov[k].trim())) {
            warnings.push('已清除手写的变量结构 / 更新规则 / 初始值覆盖（它们对应的是原来的变量表）');
        }
        sb.overrides = { schemaScript: null, updateRules: null, initvar: null };
        sb.lint = lintStatusHtml(sb.html, { mode: sb.mode, spec: sb.spec });
        ai = { parts: ['init', 'rules'], templateMode: 'structure' };
    } else {
        sb.theme = t.theme;
        if (t.mode === 'auto') {
            sb.mode = 'auto';
            sb.lint = { errors: [], warnings: [] };
        } else {
            ai = { parts: ['html'], templateMode: 'style' };
        }
    }
    sb.templateId = template.id ?? null;
    sb.updatedAt = Date.now();
    return { statusBar: sb, warnings, ai };
}

/** 给 AI 重写界面时当作参考（{STYLE_REF}）的模板界面代码：绑定片段 / 完整文档 / 内置排版生成的片段 */
export function templateStyleRef(template) {
    const t = cleanTemplateData(template, { strict: false });
    if (t.mode === 'raw') return unwrapStatusFence(t.html.trim());
    if (t.mode === 'bind' && cleanFragment(t.html)) return cleanFragment(t.html);
    return renderDefaultFragment(t.spec || { variables: [] }, t.theme);
}

/** 给 buildPreviewSrcdoc 用的“假卡片”：模板预览不需要真正的角色卡 */
export function templatePreviewCard(template, { charName = '' } = {}) {
    const t = cleanTemplateData(template, { strict: false });
    return {
        data: { name: charName || '角色' },
        statusBar: { mode: t.mode, html: t.html, theme: t.theme, spec: t.spec || { title: '状态栏', variables: [] }, sample: t.sample },
    };
}

// ---------------- 单个模板的导入导出 ----------------

/** 导出用的 JSON 对象（不含 id、内置标记与时间） */
export function exportStatusBarTemplate(template) {
    const t = cleanTemplateData(template, { strict: false });
    return {
        type: STATUS_TEMPLATE_FILE_TYPE,
        version: 1,
        name: t.name || '状态栏模板',
        desc: t.desc,
        mode: t.mode,
        theme: t.theme,
        spec: t.spec,
        html: t.html,
        sample: t.sample,
    };
}

export function statusBarTemplateFileName(template) {
    return `${safeFileName(cleanName(template?.name) || '状态栏模板')}.状态栏模板.json`;
}

/**
 * 状态栏正则替换串里的文档（去掉代码块）。不模拟酒馆显示时那一层实体解码：导入的是作者写的源码，
 * NovelLoom 导出时会先把 & 写成 &amp;（encodeFenceText），iframe 收到的就是这份源码——
 * 原卡里被酒馆误解码的写法（例如脚本里的 '&amp;' 被变成 '&'）导出后反而按作者的本意工作。
 */
function regexDocument(script) {
    return unwrapStatusFence(String(script?.replaceString ?? '').trim());
}

/**
 * 在角色卡的局部正则里找显示状态栏的那一条：匹配 <StatusPlaceHolderImpl/>、启用、只作用于显示（markdownOnly 不是 false）、
 * 不是只作用于提示词，且替换出来的是一个前端页面（酒馆助手会渲染成界面，见 isFrontendText）；有多条时取替换串最长的。
 * 「无状态栏时开这个」之类的修复正则、只放占位文字的正则都会被跳过。
 * @param {object[]} scripts data.extensions.regex_scripts
 * @returns {object|null}
 */
export function findStatusBarRegex(scripts) {
    let best = null;
    for (const s of Array.isArray(scripts) ? scripts : []) {
        if (!isObj(s) || s.disabled || s.markdownOnly === false || s.promptOnly) continue;
        if (!/StatusPlaceHolderImpl/i.test(String(s.findRegex || ''))) continue;
        if (!isFrontendText(regexDocument(s))) continue;
        if (!best || String(s.replaceString).length > String(best.replaceString).length) best = s;
    }
    return best;
}

/** 从角色卡 JSON（V2/V3）里取状态栏：优先 NovelLoom 写的 extensions.novel_loom.statusBar，其次是显示 <StatusPlaceHolderImpl/> 的正则 */
export function templateFromCardJson(json) {
    const data = isObj(json.data) ? json.data : json;
    const charName = cleanName(data.name || json.name || '');
    const name = charName ? `${charName}的状态栏` : '导入的状态栏';
    const meta = data.extensions?.novel_loom?.statusBar;
    if (isObj(meta) && (meta.spec || meta.html)) {
        return { name, desc: '', mode: meta.mode, spec: meta.spec, html: meta.html, theme: meta.theme, sample: null };
    }
    const bar = findStatusBarRegex(data.extensions?.regex_scripts);
    if (bar) {
        return { name, desc: '从角色卡的状态栏正则导入（自定义 HTML，没有变量表）', mode: 'raw', spec: null, html: regexDocument(bar), theme: 'clean', sample: null };
    }
    throw new Error('这张角色卡里没有找到状态栏（没有 NovelLoom 状态栏数据，也没有显示 <StatusPlaceHolderImpl/> 的正则）');
}

/**
 * 解析导入的 JSON：NovelLoom 状态栏模板文件、带 name 与 spec/html 的模板对象、或角色卡 JSON（也可以直接传 JSON 文本）。
 * @returns {object} 模板数据（没有 id；保存用 addStatusBarTemplate，或直接用 importStatusBarTemplate）
 * @throws {Error} 认不出格式或内容不完整时
 */
export function parseStatusBarTemplate(input) {
    let json = input;
    if (typeof json === 'string') {
        try {
            json = JSON.parse(json.trim()); // trim 也会去掉文件开头的 BOM
        } catch {
            throw new Error('文件不是有效的 JSON');
        }
    }
    if (!isObj(json)) throw new Error('不是 NovelLoom 状态栏模板文件');
    let data;
    if (json.type === STATUS_TEMPLATE_FILE_TYPE) data = json;
    else if (/^chara_card_v[23]$/.test(String(json.spec || '')) || (isObj(json.data) && (json.data.extensions || json.data.first_mes !== undefined))) data = templateFromCardJson(json);
    else if (('spec' in json || 'html' in json) && ('name' in json || 'mode' in json)) data = json;
    else throw new Error('不是 NovelLoom 状态栏模板文件');
    return cleanTemplateData({ ...data, name: cleanName(data.name) || '导入的状态栏模板' });
}

/** 导入并保存一个模板；与已有模板重名时自动改名（「名字 2」…） */
export function importStatusBarTemplate(settings, json) {
    const data = parseStatusBarTemplate(json);
    data.name = uniqueStatusBarTemplateName(settings, data.name);
    return addStatusBarTemplate(settings, data);
}
