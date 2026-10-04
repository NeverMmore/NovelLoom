---
version: 1
slug: "style-css"
primary_target: "style.css"
related_targets: ["src/ui/main.js"]
---

# Surface brief: NovelLoom main window

- Scope: the whole extension UI — main window shell, all 13 pages, shared dialogs, floating button. Visitor mode: Operate.
- Audience and job: see PRODUCT.md. The daily author (dense, fast) and newcomers from GitHub (where am I, what next). Desktop primary, mobile must keep working.
- Constraints: colors fully follow the SillyTavern theme variables (light and dark themes); plain ES modules, one stylesheet, no external hosts; keep every `data-act` / `data-tab` / `data-setting` hook and existing `.nl-*` class working.
- Chosen direction: the category standard (the user took the standing exit over the rolled 稿纸 direction), craft bar Linear + Notion.
- Memorable moment: the sidebar is the pipeline — grouped stages with live counts and a running-task indicator.
- Unresolved: none.

## Direction contract

THESIS: A tool UI that disappears into the task: the standard grouped sidebar + page header + work area, executed at Linear/Notion finish. It refuses the current default of a flat emoji rail, boxes inside boxes, and one-weight text.

OWN-WORLD: Every color derived from the SillyTavern theme (text, accent, tint, border) through color-mix; restrained neutrals, accent only for primary action, selection, focus and progress. One system sans stack, 13/14/16/20 role scale, 4px spacing grid, 6–10px radii, hairline borders at ~10% ink, 16px line icons in one stroke.

STORY: The user always sees which stage they are in, what is done and what is next, and keeps long AI jobs in view without hunting for them.

FIRST VIEWPORT: Left sidebar (232px): project switcher on top; groups 概览 / 准备 / 整理 / 生成 / 续写 with icon, label and right-aligned count; 设置 at the bottom. Main: page header (title, one-line purpose, page actions right), then content sections. Bottom: log strip with the latest line and running-task status.

FORM: Category standard (canon), not on the ordered list; seed key 2b37996f.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
