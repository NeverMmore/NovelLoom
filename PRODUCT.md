# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Two audiences, both confirmed:

- **The author (daily user).** Knows the whole pipeline and runs it often, on desktop: import a novel, extract, proofread, write character cards, plan and continue chapters. Values speed and information density.
- **Other SillyTavern users** who install the extension from GitHub. Roleplayers who want character cards and world books from a novel they like. They meet the 13-step pipeline for the first time and need to see where they are and what comes next.

Primary device: desktop (inside the SillyTavern web UI). Mobile must keep working, but is secondary.

## Product Purpose

NovelLoom (小说织卡) is a SillyTavern UI extension that turns a TXT novel into roleplay material: it splits the book into chunks, has an LLM extract chapter outlines, character profiles, world-book entries, relationships, and writing style, then writes SillyTavern character cards (including group-chat scene cards) and world books straight into SillyTavern. It can also plan follow-up chapter outlines, continue the novel chapter by chapter (feeding results back into the knowledge base), track foreshadowing, check continuity, and project plot developments for a live chat.

Success: a user goes from a raw TXT to a usable, well-grounded character card in SillyTavern, and can keep the story going, without losing track of where they are in a long, multi-step, LLM-heavy process.

## Positioning

The source novel stays the ground truth for everything generated: extraction is cumulative (each chunk builds on what was already known), quotes are verified against the original text, and continued chapters are fed back into the same knowledge base. A one-shot "write me a card" prompt cannot do this.

## Operating Context

- Runs inside SillyTavern's page as a full-window overlay opened from the extensions panel, the wand menu, or `/novelloom`; it can be minimized to a floating button while long tasks keep running.
- Long-running LLM jobs (extraction of hundreds of chunks, continuation) run for minutes to hours; the log and busy state must stay visible.
- Works with whatever API the user set up in SillyTavern (current connection, connection profiles) or direct OpenAI-compatible / DeepSeek / Gemini / Anthropic endpoints.
- UI language: Simplified Chinese.

## Capabilities and Constraints

- Pipeline (current pages): 项目 · 分段 · 提取 · 角色 · 关系 · 世界书 · 大纲 · 文风 · 角色卡 · 写大纲 · 伏笔看板 · 续写 · 设置, plus dialogs (推演当前对话, 试聊, etc.). Every function must survive a redesign; navigation may be reorganized (e.g. grouped by pipeline stage).
- **Theme: fully follow the user's SillyTavern theme.** Colors come from SillyTavern's theme variables (`--SmartThemeBodyColor`, `--SmartThemeQuoteColor`, `--SmartThemeBlurTintColor`, `--SmartThemeBorderColor`, `--SmartThemeBlurStrength`, …), so the extension changes with the user's theme, light or dark.
- Plain ES modules, no build step, no framework; one stylesheet (`style.css`) shipped with the extension. No external font or asset hosts.
- Tests and browser smoke tests drive the UI through `data-act`, `data-tab`, `data-setting` attributes and `.nl-*` classes; keep those hooks stable.

## Brand Commitments

- Name: NovelLoom, Chinese name 小说织卡. The 🧵 thread emoji is the current mark (wand menu, floating button).
- **Convention is the commitment** (chosen 2026-10-04 over themed directions): the category standard for a tool UI — grouped sidebar, work area, panels, forms, lists — executed at full craft, with no themed concept or smuggled quirk. Craft bar: **Linear** (quiet grouped sidebar, precise lists and status, restraint) and **Notion** (comfortable whitespace, clear hierarchy, friendly to newcomers).

## Evidence on Hand

- README.md documents every feature and the step table.
- Test fixture novel text in tests/browser/harness.html (mock SillyTavern page) for demos and screenshots.
- No user testimonials, usage numbers, or screenshots of real users' projects; do not invent them.

## Product Principles

1. The pipeline is the product: always show where the user is, what is done, and what to do next.
2. Long AI jobs must stay legible: progress, logs, and errors (with their real causes) are never hidden.
3. Density for the daily user, guidance for the newcomer, both on the same screen.
4. Belong inside SillyTavern: follow its theme and its conventions rather than fighting them.
