---
name: NovelLoom 小说织卡
description: A SillyTavern extension window that turns a TXT novel into character cards and world books; a quiet, theme-borrowing tool UI built around a visible pipeline.
colors:
  ink: "var(--SmartThemeBodyColor, #dcdcd2)"
  accent: "var(--SmartThemeQuoteColor, #e18a24)"
  tint: "var(--SmartThemeBlurTintColor, rgba(23, 23, 28, 0.96))"
  text-2: "color-mix(in srgb, var(--nl-ink) 72%, transparent)"
  text-3: "color-mix(in srgb, var(--nl-ink) 58%, transparent)"
  surface-1: "color-mix(in srgb, var(--nl-ink) 3%, transparent)"
  surface-2: "color-mix(in srgb, var(--nl-ink) 6%, transparent)"
  field: "color-mix(in srgb, var(--nl-ink) 4%, transparent)"
  hover: "color-mix(in srgb, var(--nl-ink) 7%, transparent)"
  pressed: "color-mix(in srgb, var(--nl-ink) 11%, transparent)"
  line: "color-mix(in srgb, var(--nl-ink) 11%, transparent)"
  line-strong: "color-mix(in srgb, var(--nl-ink) 20%, transparent)"
  accent-soft: "color-mix(in srgb, var(--nl-accent) 15%, transparent)"
  accent-line: "color-mix(in srgb, var(--nl-accent) 45%, transparent)"
  accent-ink: "color-mix(in oklab, var(--nl-accent) 78%, var(--nl-ink))"
  accent-solid: "color-mix(in oklab, var(--nl-accent) 62%, #000)"
  on-accent: "#ffffff"
  ok: "color-mix(in oklab, #3fb27f 82%, var(--nl-ink))"
  warn: "color-mix(in oklab, #d99a2b 82%, var(--nl-ink))"
  err: "color-mix(in oklab, #e5534b 82%, var(--nl-ink))"
  info: "color-mix(in oklab, #4a8fe0 82%, var(--nl-ink))"
  scrim: "rgba(0, 0, 0, 0.42)"
  # 基础色相：只作为上面 color-mix 的原料（状态色向文字色靠拢 18%），以及酒馆默认主题下强调色的回退值
  ok-base: "#3fb27f"
  warn-base: "#d99a2b"
  err-base: "#e5534b"
  info-base: "#4a8fe0"
  accent-default: "#e18a24"
typography:
  headline:
    fontFamily: 'var(--mainFontFamily, system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif)'
    fontSize: "calc(20px * var(--fontScale, 1))"
    fontWeight: 600
    lineHeight: 1.3
    letterSpacing: "0"
  title:
    fontFamily: 'var(--mainFontFamily, system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif)'
    fontSize: "calc(16px * var(--fontScale, 1))"
    fontWeight: 600
    lineHeight: 1.4
  body:
    fontFamily: 'var(--mainFontFamily, system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif)'
    fontSize: "calc(14px * var(--fontScale, 1))"
    fontWeight: 400
    lineHeight: 1.5
  prose:
    fontFamily: 'var(--mainFontFamily, system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif)'
    fontSize: "calc(14px * var(--fontScale, 1))"
    fontWeight: 400
    lineHeight: 1.65
  label:
    fontFamily: 'var(--mainFontFamily, system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif)'
    fontSize: "calc(13px * var(--fontScale, 1))"
    fontWeight: 500
    lineHeight: 1.5
  caption:
    fontFamily: 'var(--mainFontFamily, system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif)'
    fontSize: "calc(12px * var(--fontScale, 1))"
    fontWeight: 500
    lineHeight: 1.5
  mono:
    fontFamily: 'ui-monospace, "Cascadia Code", Consolas, "Microsoft YaHei Mono", monospace'
    fontSize: "calc(12px * var(--fontScale, 1))"
    fontWeight: 400
    lineHeight: 1.6
rounded:
  xs: "4px"
  sm: "6px"
  md: "8px"
  card: "10px"
  lg: "12px"
  pill: "999px"
spacing:
  s1: "4px"
  s2: "8px"
  s3: "12px"
  s4: "16px"
  s5: "20px"
  s6: "24px"
  s8: "32px"
components:
  button:
    backgroundColor: "{colors.surface-2}"
    textColor: "{colors.ink}"
    typography: "{typography.label}"
    rounded: "{rounded.sm}"
    padding: "0 12px"
    height: "32px"
  button-hover:
    backgroundColor: "{colors.pressed}"
    textColor: "{colors.ink}"
  button-primary:
    backgroundColor: "{colors.accent-solid}"
    textColor: "{colors.on-accent}"
    typography: "{typography.label}"
    rounded: "{rounded.sm}"
    padding: "0 12px"
    height: "32px"
  button-danger:
    backgroundColor: "transparent"
    textColor: "{colors.err}"
    typography: "{typography.label}"
    rounded: "{rounded.sm}"
    padding: "0 12px"
    height: "32px"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.text-2}"
    rounded: "{rounded.sm}"
  button-ghost-hover:
    backgroundColor: "{colors.hover}"
    textColor: "{colors.ink}"
  button-sm:
    typography: "{typography.caption}"
    padding: "0 8px"
    height: "26px"
  icon-button:
    backgroundColor: "transparent"
    textColor: "{colors.text-2}"
    rounded: "{rounded.sm}"
    padding: "0 6px"
    height: "28px"
    width: "28px"
  icon-button-hover:
    backgroundColor: "{colors.hover}"
    textColor: "{colors.ink}"
  input:
    backgroundColor: "{colors.field}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.sm}"
    padding: "5px 10px"
    height: "32px"
  input-disabled:
    backgroundColor: "{colors.surface-1}"
    textColor: "{colors.text-2}"
  nav-item:
    backgroundColor: "transparent"
    textColor: "{colors.text-2}"
    typography: "{typography.body}"
    rounded: "{rounded.sm}"
    padding: "0 8px"
    height: "32px"
  nav-item-hover:
    backgroundColor: "{colors.hover}"
    textColor: "{colors.ink}"
  nav-item-active:
    backgroundColor: "{colors.pressed}"
    textColor: "{colors.ink}"
  nav-next-badge:
    backgroundColor: "{colors.accent-soft}"
    textColor: "{colors.accent-ink}"
    rounded: "{rounded.pill}"
    padding: "1px 6px"
  card:
    backgroundColor: "{colors.surface-1}"
    textColor: "{colors.ink}"
    rounded: "{rounded.card}"
    padding: "16px 20px"
  tag:
    backgroundColor: "{colors.surface-2}"
    textColor: "{colors.text-2}"
    typography: "{typography.caption}"
    rounded: "{rounded.pill}"
    padding: "0 7px"
    height: "20px"
  segment:
    backgroundColor: "transparent"
    textColor: "{colors.text-2}"
    typography: "{typography.label}"
    rounded: "{rounded.pill}"
    padding: "0 12px"
    height: "28px"
  segment-active:
    backgroundColor: "{colors.accent-soft}"
    textColor: "{colors.ink}"
  list-row:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    rounded: "{rounded.sm}"
    padding: "10px 8px"
  list-row-active:
    backgroundColor: "{colors.accent-soft}"
  pipeline-row:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.sm}"
    padding: "8px"
  pipeline-row-next:
    backgroundColor: "{colors.accent-soft}"
  dialog:
    backgroundColor: "{colors.tint}"
    textColor: "{colors.ink}"
    rounded: "{rounded.lg}"
    width: "min(560px, 94vw)"
  log-strip:
    backgroundColor: "{colors.surface-1}"
    textColor: "{colors.text-2}"
    typography: "{typography.caption}"
    height: "36px"
  floating-button:
    backgroundColor: "{colors.tint}"
    textColor: "{colors.accent-ink}"
    rounded: "50%"
    size: "44px"
---

# Design System: NovelLoom 小说织卡

## Overview

**Creative North Star: "The Quiet Workbench"**

NovelLoom is a workbench that lives inside someone else's room. It opens as a full-window overlay on top of SillyTavern and borrows everything visual from the user's theme: the body text color becomes its ink, the quote color becomes its single accent, the blur tint becomes its glass. Nothing in the window carries a hue of its own except the four status signals, and even those are pulled toward the theme's ink so they sit in the same light. The result is the category standard for a tool UI (grouped sidebar, page header, work area, log strip) finished to the bar of Linear's restraint and Notion's comfortable hierarchy, and it changes with the user's theme, light or dark, without a single override.

The workbench is quiet so the pipeline can speak. The sidebar is the pipeline: thirteen pages grouped by stage (概览 / 准备 / 整理 / 生成 / 续写), each with a right-aligned count, a check once the step is done, a "下一步" pill on the next required step, and a spinner while a long AI job runs there. The project page repeats the same state as a numbered checklist. Density serves the daily author (32px rows, 13–14px text, hairline-separated lists); guidance serves the newcomer (a one-line purpose under every page title, empty states that name the next action). Long AI jobs never disappear: the log strip and its running status stay pinned to the bottom of every page.

Depth comes from layering the theme's ink at small percentages, not from shadows. Only the things that float above SillyTavern (the window, dialogs, the floating button) cast a shadow and blur what is behind them.

**Key Characteristics:**
- Every color derived from SillyTavern theme variables through `color-mix`; no fixed brand hex.
- One accent, used as a signal: primary action, current selection, focus, progress, and the next step.
- One system sans stack inherited from SillyTavern, five sizes (12/13/14/16/20 × the theme's font scale), hierarchy by weight 600 and ink level.
- 4px spacing grid; one 32px control height per row; 6/8/10/12px radii plus pills.
- Flat inside the window: ink-tint veils and 11% hairlines; shadow only on floating layers.
- 16px line icons on a 24 grid with a 1.75 stroke in `currentColor`; no emoji inside the window.

## Colors

A borrowed palette: three theme roots, everything else mixed from them at fixed percentages, so the same rules hold on any light or dark SillyTavern theme. Hex values below are the default dark theme's approximations, given as context only; the frontmatter expressions are normative. The three roots are declared as `--nl-ink`, `--nl-accent` and `--nl-tint` on the window, dialog overlay and floating button, and every derived token reads from them.

### Primary
- **Theme Accent** (SillyTavern quote color; default ≈ #e18a24): the root of every accent token. Used raw only for the focus outline, the "next" ring on pipeline marks, the hover stroke on relation-graph nodes, and the busy pulse; at 40% it fills progress bars (on a Second Veil track) and at 32% it tints text selection.
- **Accent Solid** (accent mixed 62% toward black in OKLab; default ≈ #75460d): the fill of primary buttons and checked checkboxes/radios. Deepening keeps white text legible on bright theme accents (default ≈ 8:1).
- **Accent Ink** (accent mixed 78% toward ink in OKLab; default ≈ #e29d57): accent as readable text or icon: the brand spool, the active nav icon, running counts, the "下一步" pill text, inline action links, the reroll dice icon, important-chapter markers, the running status in the log strip.
- **Accent Wash** (accent at 15%; default over glass ≈ #35281d): the selected/current background: active segmented filter, active list row, selected character, the next pipeline row, a chunk being processed, the user's bubble in test chat.
- **Accent Edge** (accent at 45%): the border of a focused field and an active segmented filter; the underline color of inline action links.

### Neutral
- **Theme Glass** (SillyTavern blur tint; default ≈ rgba(23, 23, 28, 0.96)): the window and dialog background, always with the theme's blur strength behind it. Native `<option>` lists use it too.
- **Theme Ink** (SillyTavern body text color; default ≈ #dcdcd2): primary text, headings, values, and the root of every neutral below.
- **Quiet Ink** (ink at 72%; default ≈ #a5a59f): secondary text: page and card descriptions, field labels, inactive nav items, list metadata, table headers, log lines.
- **Faint Ink** (ink at 58%; default ≈ #898986, ≈ 5:1 on glass): tertiary text: nav group labels, counts, placeholders, timestamps, "可选" annotations, disabled nav items, empty-state icons.
- **First Veil** (ink at 3%): sidebar, cards, log strip, read-only fields.
- **Field Veil** (ink at 4%): input and checkbox wells.
- **Second Veil** (ink at 6%): default buttons, tags, code, pre blocks, quotes, volume headers, avatar placeholders.
- **Hover Veil** (ink at 7%): hover on rows, nav items, icon buttons, ghost buttons and segmented filters.
- **Pressed Veil** (ink at 11%): the active nav item, default-button hover, and the 主要 importance tag.
- **Hairline** (ink at 11%): every divider: card borders, list-row separators, header and sidebar edges, table rows.
- **Strong Hairline** (ink at 20%): control borders (buttons, inputs, checkboxes), the window and dialog edge, table header rule, blockquote and outline left rules.
- **Scrim** (black at 42%; dialogs stack at 45%): behind the window and behind each dialog.

### Status
- **Leaf Green** (`ok`; default ≈ #64ba8e): done: pipeline checks, nav done checks, done chunk dots, success log lines, ok tags, keyword-triggered world-book entries.
- **Amber** (`warn`; default ≈ #daa754): warnings in the log, lint warnings, warn tags.
- **Brick Red** (`err`; default ≈ #e77064): errors, failed chunks (9% wash), danger buttons (35% border, 12% hover wash).
- **Cornflower Blue** (`info`; default ≈ #669edf): constant (常驻) world-book entries.
- **White on Accent** (#ffffff): text and check glyphs on Accent Solid and on completed pipeline marks.

Status tags tint their own color at 14% behind the text. In prompt and message-chain previews the three roles borrow the status hues as labels: system blue, user green, assistant amber. Relation-type colors in the relations page are user data (each type carries a user-chosen color), not system tokens.

### Named Rules
**The Borrowed Palette Rule.** Every UI color is a `color-mix` of the theme's ink, accent or glass. The only fixed values are the four status hues (always pulled 18% toward ink), white on accent, and the black scrim. Borders derive from ink, not from SillyTavern's border color variable.

**The Accent Is a Signal Rule.** The accent marks what you can act on or where you are: the primary action, the current selection, focus, progress and running work, and the next step. It never colors headings, card chrome, or decoration beyond the brand spool.

**The Importance-by-Lightness Rule.** Character importance (主要 / 重要 / 次要) is ink level (Theme Ink / Quiet Ink / Faint Ink), never accent or a status hue.

## Typography

**Body Font:** SillyTavern's `--mainFontFamily` (falling back to system-ui, Segoe UI, PingFang SC, Microsoft YaHei, Noto Sans CJK SC)
**Mono Font:** ui-monospace (Cascadia Code, Consolas, Microsoft YaHei Mono)

**Character:** One inherited system sans does everything, scaled by SillyTavern's `--fontScale`. It reads as the user's own app, not a skin on top of it; hierarchy comes from weight and ink level, never from a second face.

### Hierarchy
- **Headline** (600, 20px × scale, 1.3, no tracking): the page title in the header, one per page, ellipsized on one line. 16px on narrow screens.
- **Title** (600, 16px × scale, 1.4): card titles, dialog titles, empty-state titles.
- **Body** (400, 14px × scale, 1.5): the base: nav items, list rows, pipeline rows, inputs. Tables drop to 13px.
- **Prose** (400, 14px × scale, 1.65): long generated and source text: textareas, outline chunks, style samples, quotes, empty-state copy (1.7).
- **Label** (500, 13px × scale): field labels, button text, `<summary>` toggles, card descriptions and page descriptions (400), card sub-headings (600, Quiet Ink).
- **Caption** (500, 12px × scale): nav group labels, counts, tags, the log strip, small buttons, table headers (600). The "下一步" pill is 11px 600.
- **Mono** (400, 12px × scale, 1.6): the expanded log; inline code at 0.92em on Second Veil.

### Named Rules
**The Theme Font Rule.** Text uses SillyTavern's font family and font scale. No web fonts and no external font hosts; sizes come from the five scaled steps, with only the 11px badge numerals (下一步 pill, pipeline marks, relation-graph labels) sitting outside them.

**The Tabular Count Rule.** Every count, progress figure, timestamp and table cell uses tabular numerals so columns and the sidebar counts never jitter while a job runs.

## Layout

The window is a centered panel, `min(1320px, 96vw)` wide and `min(92vh, 960px)` tall, over the scrim. It is a two-column grid: a 232px sidebar and a fluid body. The sidebar stacks the brand line and project switcher (12px padding), the grouped nav (groups 12px apart, items 1px apart), and settings pinned to the foot behind a hairline. The body stacks a header (min 60px; padding 12px 16px 12px 24px; title block, page actions, then window actions behind a hairline divider), a scrolling work area, and the log strip.

The work area is a single column capped at 1120px with 20px top, 24px side and 32px bottom padding; sections stack 16px apart. Inside a card, the head row keeps at least 240px for the title block and wraps its actions to the next line rather than squeezing the title; fields put 6px between label and control and 8px around each field; two- and three-column field grids use 4px row and 16px column gaps; master–detail pages use a 220–280px list beside a fluid detail.

Spacing is a 4px grid (4, 8, 12, 16, 20, 24, 32). Rows hold one control height: 32px for inputs, selects and buttons; small 26px buttons are promoted to 32px when they share a row, toolbar or header with a full-size control.

At 800px and below the window fills the viewport with no radius or border. The sidebar becomes a top bar: brand and project switcher on one line, then a horizontally scrolling strip of icon-over-label tabs (group labels and counts hidden) with settings pinned at the right behind a hairline. The page title drops to 16px and its description hides; page actions move to a second header row, where two or more actions split the row equally and a single action keeps its natural width; small toolbar buttons settle at 30px. Grids and master–detail splits collapse to one column, chunk and card actions wrap below their content, the expanded log caps at 22vh, and dialogs become bottom sheets (full width, up to 92dvh, 12px top corners).

On hover-capable devices, per-row actions in long editable lists (the chapter plan) rest at 55% opacity and come to full strength on row hover or focus-within.

### Named Rules
**The One Height Rule.** A row, card head or header toolbar holds one control height. Small buttons exist only for rows of small buttons; beside an input, a select or a full-size button they grow to 32px.

## Elevation & Depth

Flat inside, floating outside. Every surface inside the window is flat; depth is tonal, built from ink veils (3% sidebar and cards, 6% buttons and tags, 7–11% hover and press) and 11% hairlines. Only the layers that sit above SillyTavern float: the window and dialogs carry the pop shadow, a Strong Hairline edge and a backdrop blur at the theme's blur strength; the floating button carries its own lighter shadow and the same blur.

### Shadow Vocabulary
- **Pop** (`box-shadow: 0 16px 40px -12px rgba(0, 0, 0, 0.5), 0 2px 8px rgba(0, 0, 0, 0.18)`): the main window and every dialog. Nothing else.
- **Floating button** (`box-shadow: 0 6px 18px rgba(0, 0, 0, 0.35)`): the minimized-window button over SillyTavern's page.
- **Field focus halo** (`box-shadow: 0 0 0 3px color-mix(in srgb, var(--nl-accent) 28%, transparent)`): text inputs, selects and textareas on focus, with an Accent Edge border.
- **Busy pulse** (`0 0 0 8px` accent at 30%, 1.6s ease-in-out loop): the floating button while a job runs minimized.

### Named Rules
**The Flat Inside Rule.** No shadow on any card, row, button or panel inside the window. If something needs to stand out, give it a veil or an accent wash; if it truly floats, it is a dialog.

## Shapes

Gently rounded, tighter as things get smaller. Controls, rows, nav items, progress tracks and quote blocks use 6px; outlined groups inside cards (category settings, message-chain items) use 8px; cards and test-chat bubbles use 10px; the window, dialogs and mobile bottom sheets use 12px. Pills (999px) are reserved for tags, segmented filters and the "下一步" badge. Circles mark state: 20px pipeline marks with a 1.5px ring, 7px status dots, round radios and the floating button. Checkboxes are 16px squares with 4px corners and a 1.5px border; inline code uses 4px.

Lines are 1px solid hairlines; the only heavier rule is a 2px Strong Hairline on the left of blockquotes and outline chunks.

Icons are drawn, not typed: a 24-unit grid, 1.75 stroke, round caps and joins, `currentColor`, in the Lucide style. Sizes are 16px by default, 14px in small buttons and filters, 12px in counts, log lines and pipeline checks, 18–20px for the brand spool, and 28px in empty states.

## Components

### Buttons
Compact, neutral and quiet until one of them matters.
- **Shape:** gently rounded (6px), 32px tall, 12px side padding, 13px 500 text, icon 16px with a 6px gap.
- **Default:** Second Veil fill, Strong Hairline border, Theme Ink text. Hover lifts to Pressed Veil with the border at 28% ink; press goes to 15% ink.
- **Primary:** Accent Solid fill, no border, white text; hover brightens to 112%. At most one per region, placed last in a header or dialog foot: the action that advances the pipeline (生成, 继续提取, 写入酒馆世界书, 创建项目).
- **Danger:** transparent, Brick Red text and a 35% red border; hover adds a 12% red wash. Used for delete and stop.
- **Ghost:** transparent and borderless in Quiet Ink; hover Hover Veil. Used for low-stakes chrome (log strip 清空 / 展开).
- **Small:** 26px tall, 8px padding, 12px text, 14px icon, for in-row actions; promoted to full height when sharing a row with full-size controls.
- **Icon button:** 28px square, transparent, Quiet Ink; hover Hover Veil and Theme Ink (danger icon buttons hover red). Always carries `title` and `aria-label`.
- **Reroll:** any control that regenerates AI content in place carries the dice icon in Accent Ink, as an icon button or a small labelled button.
- **Disabled:** 50% opacity, not-allowed cursor; while a button's job runs it shows a spinner and a "处理中…" label, and its twins elsewhere on the page disable with it.
- **Focus:** a 2px Theme Accent outline, 1px offset, on keyboard focus only.

### Chips
- **Tags:** 20px pills, 7px padding, 12px 500 text on Second Veil in Quiet Ink. Status tags use the status color as text over a 14% wash. Importance tags use ink level only (主要 on Pressed Veil in Theme Ink).
- **Segmented filters:** 28px pills with a Hairline border, transparent, Quiet Ink; hover Hover Veil. The active one gets Accent Wash, Accent Edge border, Theme Ink and 500 weight. Category filters may lead with a status dot (常驻 blue, 关键词 green) and an item count.
- **Status dots:** 7px circles in Faint Ink (pending), Leaf Green (done), Brick Red (error), Cornflower Blue or accent; a processing item shows a spinner in Accent Ink instead.
- **Candidate chips** (AI name candidates on the outline page's 待确认名称 rows): 26px pill buttons with a Strong Hairline border, the name in Theme Ink and a 20px source badge inside (原文 on a Leaf Green wash, 已有 on Second Veil, AI 起名 on an Amber wash). The chosen one (`aria-pressed`) takes Accent Wash and Accent Edge like an active segmented filter; a low-confidence guess gets a dashed border and Faint Ink. They share the row with the small dice 换一批 button, and the chosen candidate's reason and source quote sit below the chips in Quiet Ink, not only in the tooltip. A value the AI filled in that the user has not confirmed adds one Amber line above the reason saying how to confirm it (tap the highlighted chip).

### Cards / Containers
- **Corner Style:** 10px.
- **Background:** First Veil.
- **Shadow Strategy:** none (see The Flat Inside Rule).
- **Border:** 1px Hairline.
- **Internal Padding:** 16px vertical, 20px horizontal (12px × 14px on narrow screens).
- **Head:** a title (16px 600) with an optional one-line description in Quiet Ink 13px below it; actions sit to the right and wrap below when the title block would drop under 240px.
- **Lists inside cards:** rows separated by hairlines with 10px × 8px padding and a 6px-radius hover veil; the active row gets Accent Wash and hides the hairline below it.
- **Grouped boxes:** editable config groups (category settings, message-chain items) are outlined 8px boxes with no fill; a volume header is a 6px Second Veil strip.

**The Rows Not Boxes Rule.** Inside a card, collections are rows (hairline-separated for projects, world-book entries, plan chapters, style samples and character cards; 2px-gapped hover rows for chunks), never a grid of filled, bordered mini-cards.

### Inputs / Fields
- **Style:** Field Veil well, 1px Strong Hairline border, 6px radius, min 32px tall, 5px × 10px padding, 14px text; placeholders in Faint Ink. Textareas use 1.65 line height and resize vertically. Selects draw their own two-stroke chevron in Quiet Ink.
- **Hover:** border to 30% ink.
- **Focus:** Accent Edge border plus the 3px field focus halo; no browser outline.
- **Disabled / read-only:** First Veil fill and Quiet Ink text.
- **Labels:** 13px 500 Quiet Ink above the control, 6px gap; an inline 400-weight Quiet Ink note may follow the label.
- **Checkboxes and radios:** custom 16px controls, Field Veil with a 1.5px Strong Hairline border; checked fills with Accent Solid and a white drawn check (radio: an Accent Solid dot inside an Accent Solid ring); indeterminate shows a white bar.

### Navigation
- **Sidebar:** 232px on First Veil with a Hairline right edge. Items are 32px rows, 8px padding, 6px radius, icon and label 10px apart, label 14px Quiet Ink with a right-aligned 12px Faint Ink count in tabular numerals.
- **States:** hover Hover Veil and Theme Ink; active Pressed Veil, Theme Ink, 600 weight and the icon in Accent Ink; unavailable (no project open) Faint Ink with the icon at 50%.
- **Pipeline markers:** a Leaf Green 12px check after the count once a step is done; a "下一步" pill (Accent Wash, Accent Ink, 11px 600) on the next required step; a spinner in place of the count while extraction or continuation runs.
- **Groups:** 12px 500 Faint Ink labels (准备 / 整理 / 生成 / 续写) above each group; the overview item stands alone at the top and settings is pinned to the foot.
- **Mobile:** a horizontally scrolling tab strip with the icon over a 12px label, groups flattened, labels and counts hidden.

### Pipeline List (signature)
The project page's numbered checklist, driven by the same state as the sidebar so both always agree. Each row is a full-width button: a 20px circular mark, the step name (500) with optional "可选" / "下一步" annotations in 12px Faint Ink, a right-aligned note in Quiet Ink 13px tabular numerals (e.g. "4/4 段"), and a Faint Ink chevron. Pending marks are a 1.5px Strong Hairline ring holding the step number; done marks fill Leaf Green with a white check; the next row gets an Accent Wash background and an accent ring with Accent Ink number. Rows are hairline-separated, 8px padded, and hover with Hover Veil; clicking goes to that page.

### Log Strip (signature)
Pinned to the bottom of the body on First Veil behind a Hairline. The 36px head shows a 14px log icon and "日志" in Quiet Ink 600, the running status (spinner plus "提取中 · 续写中" in Accent Ink), the latest line ellipsized in its level color, and ghost 清空 / 展开 buttons. Expanded, it shows up to 200px (22vh on mobile) of monospace lines with Faint Ink timestamps. Leading emoji in log messages are stripped at render time; success, warn and error lines get a drawn 12px check or alert icon and their status color.

### Dialogs
Confirm, prompt, alert and the larger tool dialogs (推演当前对话, 试聊, snapshots) share one shell: Theme Glass with blur, Strong Hairline border, 12px radius, pop shadow, `min(560px, 94vw)` wide (980px for wide dialogs), up to 90vh. The head is a 16px 600 title with a close icon button; the body scrolls with 4px top, 20px side and 16px bottom padding; the foot right-aligns its buttons behind a Hairline, with the primary (or danger) choice last. They fade in over 140ms and pop up 6px from 98.5% scale over 160ms. Escape and the scrim both dismiss.

### Empty States
Centered in the card with 56px vertical padding: a 28px line icon in Faint Ink, a 16px 600 title, one or two lines of Quiet Ink explanation at 1.7 line height, and, when there is one, the action that fills the page (often a primary button such as 去项目页).

### Floating Button
When the window is minimized, a 44px circle at the lower right of SillyTavern's page: Theme Glass with blur, Strong Hairline border, the brand spool in Accent Ink, its own shadow. It pulses with an accent ring while a job runs.

### Motion
State changes (hover, press, border, opacity) transition in 120ms on `cubic-bezier(0.2, 0.8, 0.2, 1)`. Spinners turn every 0.8s. Under reduced motion every transition and animation collapses to near zero, except the spinner, which slows to 1.6s so running work still reads as running.

## Do's and Don'ts

### Do:
- **Do** derive every new color from `--nl-ink`, `--nl-accent` or `--nl-tint` with `color-mix`, reusing the established steps (ink 3/4/6/7/11/20/58/72%, accent 15/28/32/40/45%, status 14% washes).
- **Do** check every new surface in both a dark and a light SillyTavern theme; nothing may depend on the default orange accent or dark glass.
- **Do** keep spacing on the 4px scale (4, 8, 12, 16, 20, 24, 32) and give each row a single control height (32px; 30px for narrow-screen toolbar buttons).
- **Do** put page-level actions in the header actions slot, with at most one primary action per page header and per card.
- **Do** give every page a one-line purpose under its title and every empty list an icon, a title, an explanation and the next action.
- **Do** show where the user is in the pipeline with the shared done check, "下一步" pill and running spinner, in both the sidebar and the project checklist.
- **Do** use the line icon set (24 grid, 1.75 stroke, `currentColor`) at 16px, 14px in small controls and 12px in counts and logs, and mark every in-place AI regenerate with the dice icon in Accent Ink.
- **Do** use tabular numerals for counts, progress and timestamps.
- **Do** keep keyboard focus visible with the 2px accent outline and the 3px field halo.

### Don't:
- **Don't** hard-code a hex for UI chrome or introduce a brand color; the theme supplies the palette.
- **Don't** use the accent for headings, card chrome, category coding or decoration.
- **Don't** render list items as filled, bordered cards inside a card; lists are hairline-separated rows, and the only boxes inside cards are outlined config groups.
- **Don't** add shadows to anything inside the window; only the window, dialogs and the floating button float.
- **Don't** mix control heights in one row or leave a small button beside a full-size input.
- **Don't** use emoji or typed glyphs as icons inside the window or dialogs; the 🧵 mark belongs only to SillyTavern-owned entry points (the extensions drawer and the wand menu), and the window draws the spool icon instead.
- **Don't** load web fonts or any external asset; text follows SillyTavern's font family and font scale.
- **Don't** express importance with color; use ink level.
