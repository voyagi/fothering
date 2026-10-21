---
name: Fothering
description: One SES account drawn as a flow drawing, with the closed lane tagged out.
colors:
  ground: "#F5F7F8"
  ground-dark: "#0F1316"
  sheet: "#FFFFFF"
  sheet-dark: "#161B1F"
  ink: "#0E1113"
  ink-dark: "#E8ECEE"
  ink-2: "#3B444A"
  ink-2-dark: "#AEB7BD"
  line: "#8A949B"
  line-dark: "#6F7A82"
  label: "#566067"
  label-dark: "#9DA7AE"
  rule: "#C9D0D4"
  rule-dark: "#2A3238"
  flow: "#0E1113"
  flow-dark: "#E8ECEE"
  tag-red: "#C8102E"
  lock: "#C8102E"
  lock-dark: "#E0304A"
  tag-card: "#FFFFFF"
  tag-ink: "#0E1113"
  tag-field: "#5A646B"
typography:
  display:
    fontFamily: "Red Hat Display, sans-serif"
    fontSize: "clamp(2.25rem, 1.2rem + 2.6vw, 3.75rem)"
    fontWeight: 700
    lineHeight: 1.04
    letterSpacing: "-0.026em"
  landing-headline:
    fontFamily: "Red Hat Display, sans-serif"
    fontSize: "clamp(2.125rem, 1.3rem + 2vw, 3.4rem)"
    fontWeight: 700
    lineHeight: 1.05
    letterSpacing: "-0.028em"
  headline:
    fontFamily: "Red Hat Display, sans-serif"
    fontSize: "clamp(1.75rem, 1.2rem + 1.6vw, 2.75rem)"
    fontWeight: 700
    lineHeight: 1.08
    letterSpacing: "-0.02em"
  narrative-headline:
    fontFamily: "Red Hat Display, sans-serif"
    fontSize: "clamp(1.625rem, 1.2rem + 1vw, 2.25rem)"
    fontWeight: 700
    lineHeight: 1.08
    letterSpacing: "-0.02em"
  title:
    fontFamily: "Red Hat Display, sans-serif"
    fontSize: "1.375rem"
    fontWeight: 700
    lineHeight: 1.25
  numeral:
    fontFamily: "Red Hat Display, sans-serif"
    fontSize: "1.75rem"
    fontWeight: 800
    lineHeight: 1
  numeral-small:
    fontFamily: "Red Hat Display, sans-serif"
    fontSize: "1.5rem"
    fontWeight: 800
    lineHeight: 1
  lede:
    fontFamily: "Red Hat Text, sans-serif"
    fontSize: "1.1875rem"
    fontWeight: 400
    lineHeight: 1.55
  intro:
    fontFamily: "Red Hat Text, sans-serif"
    fontSize: "1.125rem"
    fontWeight: 400
    lineHeight: 1.55
  body:
    fontFamily: "Red Hat Text, sans-serif"
    fontSize: "1.0625rem"
    fontWeight: 400
    lineHeight: 1.55
  cell:
    fontFamily: "Red Hat Text, sans-serif"
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.5
  small:
    fontFamily: "Red Hat Text, sans-serif"
    fontSize: "0.9375rem"
    fontWeight: 400
    lineHeight: 1.45
  schedule-compact:
    fontFamily: "Red Hat Text, sans-serif"
    fontSize: "0.9375rem"
    fontWeight: 400
    lineHeight: 1.4
  tag-value:
    fontFamily: "Red Hat Text, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.35
  mono-value:
    fontFamily: "Red Hat Mono, monospace"
    fontSize: "0.8125rem"
    fontWeight: 500
    lineHeight: 1.4
    fontFeature: "\"tnum\" 1"
  label:
    fontFamily: "Red Hat Mono, monospace"
    fontSize: "0.75rem"
    fontWeight: 600
    lineHeight: 1.3
    letterSpacing: "0.05em"
  label-small:
    fontFamily: "Red Hat Mono, monospace"
    fontSize: "0.6875rem"
    fontWeight: 600
    lineHeight: 1.5
    letterSpacing: "0.06em"
  button:
    fontFamily: "Red Hat Text, sans-serif"
    fontSize: "1rem"
    fontWeight: 600
    lineHeight: 1
  switch:
    fontFamily: "Red Hat Mono, monospace"
    fontSize: "0.75rem"
    fontWeight: 600
    lineHeight: 1
    letterSpacing: "0.04em"
  wordmark:
    fontFamily: "Red Hat Display, sans-serif"
    fontSize: "1.375rem"
    fontWeight: 850
    lineHeight: 1
    letterSpacing: "0.08em"
  tag-legend:
    fontFamily: "Red Hat Display, sans-serif"
    fontSize: "1.75rem"
    fontWeight: 900
    lineHeight: 0.95
    letterSpacing: "0.02em"
rounded:
  control: "2px"
  tag-top: "10px"
  tag-bottom: "4px"
  tag-band: "8px"
spacing:
  xs: "4px"
  sm: "8px"
  "12": "12px"
  md: "16px"
  lg: "24px"
  xl: "32px"
  "40": "40px"
  2xl: "48px"
  3xl: "64px"
  gutter: "clamp(16px, 3vw, 40px)"
  rail: "34px"
  rail-narrow: "22px"
  sheet-block: "clamp(44px, 6vw, 92px)"
  cell: "13px 16px"
  cell-compact: "8px 12px"
  zone-strip: "6px 0"
  rail-number-top: "14px"
  titleblock-cell: "16px clamp(16px, 3vw, 40px) 18px"
components:
  button-primary:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.sheet}"
    typography: "{typography.button}"
    rounded: "{rounded.control}"
    padding: "16px 24px"
    height: "48px"
  button-primary-hover:
    backgroundColor: "{colors.ink-2}"
  button-quiet:
    textColor: "{colors.ink}"
    typography: "{typography.button}"
    rounded: "{rounded.control}"
    padding: "16px 24px"
    height: "48px"
  button-quiet-hover:
    backgroundColor: "{colors.ground}"
  button-disabled:
    backgroundColor: "{colors.rule}"
    textColor: "{colors.label}"
  input-field:
    backgroundColor: "{colors.sheet}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    padding: "12px 14px"
    height: "48px"
  theme-switch-selected:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.sheet}"
    typography: "{typography.switch}"
    padding: "11px 10px"
    height: "36px"
    width: "44px"
  tag-band:
    backgroundColor: "{colors.tag-red}"
    textColor: "{colors.tag-card}"
    typography: "{typography.tag-legend}"
    padding: "36px 16px 12px"
  schedule-cell:
    textColor: "{colors.ink-2}"
    typography: "{typography.cell}"
    padding: "{spacing.cell}"
  schedule-cell-compact:
    textColor: "{colors.ink-2}"
    typography: "{typography.schedule-compact}"
    padding: "{spacing.cell-compact}"
  message-body:
    backgroundColor: "{colors.sheet}"
    textColor: "{colors.ink}"
    typography: "{typography.cell}"
    padding: "16px 24px 24px"
  command-block:
    backgroundColor: "{colors.ground}"
    textColor: "{colors.ink}"
    typography: "{typography.mono-value}"
    padding: "12px 16px"
  command-block-in-step:
    backgroundColor: "{colors.ground}"
    textColor: "{colors.ink}"
    typography: "{typography.mono-value}"
    padding: "8px"
---

# Design System: Fothering

## Overview

**Creative North Star: "The Tagged Isolation"**

Every page is one sheet of a process flow drawing. The SES account is the source, each configuration set is a line leaving it, and a closed lane is an isolation valve drawn shut with a lockout tag hung on its stem. The tag states the cause, the evidence, the read-back and what reopens it, while flow keeps moving on every other line. The drawing is a working grammar, not a costume: row numbers are real coordinates that copy and tags cite ("the filled valve in row 1"), true at every width, while zone letters index the columns of the widest layout and are never cited, the footer is the sheet's title block and doubles as site navigation, comparisons are schedules, and a procedure is one process line with a valve per step.

The system is flat, cool and dense in the way infrastructure documentation is dense. A cool white sheet lies on a cool grey ground, drawn in one cool near-black ink at a few line weights, with grey pipework and a single safety red confined to the closed lane. Identifiers an SES operator would copy are always set in mono. There are no shadows, gradients, glass, hero illustrations or charts beside a headline.

Two token sets are designed, not inverted. Device is the default theme and follows the operating system; Light and Dark are explicit choices. Every colour token is written once, as a light and a dark value in one token source, and emitted as the light values on `:root` plus one dark list printed twice, identically, under `@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) }` and under `:root[data-theme="dark"]`; each block also sets `color-scheme`. The page itself paints the ground and the ink from those tokens.

**Key Characteristics:**
- An outline-weight ink frame around every page, a zone strip A to F along the top, numbered rows with a left rail.
- Flat surfaces, square 2px corners on controls; the tag is the only rounded, hung object.
- One hue besides the neutrals: red, and only on the closed lane.
- Motion is flow and only flow: dashes moving on live lines, with a Stop flow button beside every moving drawing.
- Red Hat Display, Text and Mono as one working trio.

## Colors

A cool white sheet on a cool grey table, one near-black ink, grey pipework, and one safety red for the locked-out point. Each neutral token has a light and a dark value; the `-dark` keys in the frontmatter are the values the two dark blocks print.

### Primary
- **Lockout Red** (`tag-red`): the header band of the lockout tag. It sits on the tag's white card in both themes, so it has one value.
- **Lock Mark** (`lock`, `lock-dark`): the filled square beside a closed lane's name wherever lanes are listed (the `shut` state mark). The dark value exists because Lockout Red measures 2.95:1 on the dark sheet, under the 3:1 a state mark needs.

### Neutral
- **Drawing Table** (`ground`, `ground-dark`): the page background, seen only as the margin around the frame; also the tint for a selected row, a newly revealed log row, a quiet button's hover and command blocks.
- **Drawing Sheet** (`sheet`, `sheet-dark`): the frame's fill and every reading surface; also the fill of open valves, the punched hole and the sticky replay controls.
- **Drawing Ink** (`ink`, `ink-dark`): text, the frame, row rules, valves, the SES source box, primary buttons, focus outlines, selection background, the lockout tag's outline.
- **Secondary Ink** (`ink-2`, `ink-2-dark`): lede and supporting paragraphs, table header text, schedule cells that do not act, primary button hover.
- **Pipework** (`line`, `line-dark`): process lines in drawings, procedures and the replay step strip, and the dotted outlet of a closed line and the privacy drain line, which carry state and so need the 3:1 Pipework holds (Cell Rule does not).
- **Field Label** (`label`, `label-dark`): zone letters, rail numbers, captions, title block field names and values, stacked column names, the replay clock and step times, disabled button text.
- **Cell Rule** (`rule`, `rule-dark`): table cell rules, zone dividers, internal grid lines, the step strip's bottom rule, the replay tag phantom, disabled button fill. Never a line that carries state.
- **Flow** (`flow`, `flow-dark`): the moving dashes on a live line; equal to ink in both themes.
- **Tag Card** (`tag-card`), **Tag Ink** (`tag-ink`), **Tag Field** (`tag-field`): the tag's paper stock, its text and hole rim, and its field names. These are literal values, identical in both themes, because the tag is a physical card.

### Named Rules
**The Red Rule.** Red belongs to the closed lane and appears in exactly two places: the band of the tag hung on that lane, and the Lock Mark beside that lane's name. It is never a region fill, a frame, a button, a link, a heading, a logo or decoration, and on any screen it covers less than one tag's area.

**The Unproven Stays Ink Rule.** A closure the read-back did not confirm leaves the lane open, so its state mark is an empty ink outline at emphasis weight, never red. The permission the product is never granted is likewise marked in ink at emphasis weight, not red.

**The Paper Tag Rule.** The tag keeps its white card, near-black ink and red band in both themes. Everything else follows the theme, with one exception on the card: its outline is drawn in the theme's Drawing Ink, so on the dark sheet it takes the dark ink, where a near-black outline would vanish and the red band's edge alone measures 2.95:1.

**The Device Default Rule.** Every surface offers Device, Light and Dark. Device follows the OS and is the default; a stored choice lives in `localStorage` under `fothering-theme` (`light` or `dark`; Device removes the key) and is applied as `data-theme` on the root by a synchronous script in `<head>` before first paint.

## Typography

**Display Font:** Red Hat Display (with sans-serif), weights 700, 800, 850 and 900
**Body Font:** Red Hat Text (with sans-serif), weights 400 and 600
**Label/Mono Font:** Red Hat Mono (with monospace), weights 500 and 600, tabular numerals wherever it sets an identifier or a time

**Character:** A neutral, screen-first grotesque trio with a real display cut heavy enough for a tag legend and a mono built to sit beside it. The mono does work: lane names, API fields, message tags, SMTP codes, timestamps and coordinates.

### Hierarchy
Every size is a custom property on `:root` named `--text-<step>`; a size outside this ramp is a defect.
- **Display** (`display`): page titles on every sheet but the landing, capped at 22ch, balanced wrapping.
- **Landing Headline** (`landing-headline`): the landing page's h1 only.
- **Headline** (`headline`): the title of each numbered row, balanced wrapping.
- **Narrative Headline** (`narrative-headline`): the replay's step headings, a step down from Headline.
- **Title** (`title`): step titles in procedures, sub-sections, role headings, specimen titles.
- **Numeral** (`numeral`, 800 at 1.75rem): the step numeral beside each procedure valve. **Numeral Small** (`numeral-small`, 800 at 1.5rem): removal step numerals.
- **Lede** (`lede`, 1.1875rem): the one landing lede, capped at 40ch.
- **Intro** (`intro`, 1.125rem): the intro paragraph in row 1 of each sheet.
- **Body** (`body`, 1.0625rem): every other sentence, refusal items, list items.
- **Cell** (`cell`, 1rem): schedule cells and row headers (600), message paragraphs, procedure step text, replay summary and step labels, buttons (600).
- **Small** (`small`, 0.9375rem): site chrome and metadata only: the title block, the top bar link (600), the message disclosure line.
- **Schedule Compact** (`schedule-compact`): the compact schedule (the replay's evidence), an alias of Small with a 1.4 line height and 8px 12px cells, so there is one 15px value.
- **Tag Value** (`tag-value`, 0.875rem): prose values on the lockout tag only.
- **Mono Value** (`mono-value`, 0.8125rem, 500): every copyable identifier (`code`, mono cells, tag mono values, the message header list, title block values, the replay log's time and lane cells), command blocks, and at 600 the replay clock and summary times.
- **Label** (`label`, 0.75rem): column headers, state names, notice labels, the flow switch and theme segments (0.04em), the replay step strip's times (600, no extra tracking); drawing captions and command notes at 500, no uppercase, 1.4 line height.
- **Label Small** (`label-small`, 0.6875rem): title block and tag field names and the column names printed above stacked cells (600, uppercase); the stamp (600, 0.08em); the tag footer (600); zone letters and rail numbers (500).
- **Wordmark** (`wordmark`): FOTHERING in the top bar, uppercase, 850.
- **Tag Legend** (`tag-legend`): "LANE CLOSED" on the tag, or "LANE PAUSED" when the artifact holds no hold check, 900 with positive tracking, the heaviest type on any page.

Running text in Red Hat Text has five reading sizes, each with one job (Small 15, Cell 16, Body 17, Intro 18, Lede 19px); no two of the 17, 18 and 19px steps sit in the same block, so a 1px difference never carries a hierarchy alone. Body line height is 1.55.

**Drawing text.** SVG text in the flow drawings is set in the drawing's own user units and scales with the drawing, so it sits outside the CSS ramp by construction: the SES source box name is Red Hat Display 800 at 18 units (15 in the narrow and board drawings), lane names are Red Hat Mono 500 at 13 units (12 in the narrow and board drawings), and captions, state labels and the read-back bubble's letters are Red Hat Mono at 12 units (500 for captions, 600 for state and bubble). Every drawing text is mono with tabular numerals except the source box name. No other drawing size exists.

### Named Rules
**The Measure Rule.** `--measure: 46ch` caps every `p`, `li` and `dd`, and every prose table cell through an inner block, at about 70 characters of Red Hat Text a line; no prose line at 1440 runs past 80 characters. Narrow columns keep their own smaller caps (lede 40ch, procedure step text 34ch). The message box caps at `calc(44ch + 48px)`, its 44ch text plus two 24px inline paddings.

**The Copyable Identifier Rule.** Anything an SES operator would copy (`SendingOptions.SendingEnabled`, `import_batch=...`, `550 5.1.1`, configuration set names, UTC times, IAM actions and commands wherever they sit in a tag, schedule, log, register, message header or drawing) is set in Red Hat Mono 500 with tabular numerals at Mono Value, spelled exactly as the API spells it. Running prose may name a lane as a plain word in Red Hat Text; API names and tag values stay in mono even inside prose. An identifier never breaks mid-name: it may end a line only right after a dot, where the identifier component emits a `<wbr>`, and an identifier with no dot never breaks. The one exception is an SES API operation name in the replay log's Detail cell, which may break between its capitalised words and never inside one.

**The Long Value Rule.** A resource expression, an ARN, a principal or a command line is a long value, not an identifier: it is mono at Mono Value and may end a line after a slash, a colon, a comma or a space, breaking inside a part only when that part alone is wider than its cell. In a command block a flag and its value are one unit and keep one line while it fits.

**The Keep Whole Rule.** A value a reader may copy or cite whole, a date or a legal reference, never wraps inside itself; the line may end before or after it.

**The Self-Hosted Faces Rule.** All three faces are served from the site's own origin, from the `@fontsource-variable` 5.3.0 files under the site's own `@font-face` rules that use the plain family names (`Red Hat Display`, `Red Hat Text`, `Red Hat Mono`). Loading them from a third-party font CDN is not allowed.

## Layout

The page is a single framed sheet. The frame sits inside a gutter of `clamp(16px, 3vw, 40px)` on the ground. Inside it, a zone strip divides the width into a rail plus six equal columns labelled A to F; below it, each content band is a numbered row: a rail (34px) holding the row number, then the content, with a 1px ink rule between rows.

Content grids use a 5:7 split (`minmax(0, 5fr) minmax(0, 7fr)`) for intros, section heads, the landing first viewport (claim left, flow drawing right), refusals and forms, with a 40px column gap. The replay reverses it to 7:5, drawing first. Rows pad by `clamp(44px, 6vw, 92px)` vertically and the gutter horizontally. Table cells pad 13px 16px; compact cells 8px 12px.

The first viewport's flow drawing runs to the sheet border and stops there; content never bleeds past the frame.

### Spacing rhythm
Every padding, margin and gap is a multiple of 4: the named steps 4, 8, 12, 16, 24, 32, 40, 48 and 64px, any other multiple of 4, or a `clamp()` whose two ends are multiples of 4. There is no 20px step: message padding is 16px 24px 24px (header list 12px 24px) and the procedure valve sits 16px above its step title. Component geometry (border weights, the punched hole, process-line offsets, rings, focus offsets, radii, rotations) follows Shapes rather than the scale. The closed list of off-grid values:
- **Schedule cell** (13px 16px) and **tag band** (36px 16px 12px, the top clearing the punched hole).
- **Theme segment** (11px 10px, which with its 12px label makes the 36px segment).
- **Rail** (34px, 22px at 620px and below), a drawing border column sized to its two-digit row numbers.
- **Zone strip** (6px block): with the 11px letters it makes a 23px index band, the thinnest that reads as a ruler and not as a content row.
- **Rail number top** (14px): seats the row number just under the row's ink rule, as a drawing's row index sits at the top of its band.
- **Title block cell** (16px top, 18px bottom, gutter inline): the 2px extra at the bottom keeps each field-name and link stack optically centred between the cell rules. The conditional snap to 16px was not taken; the built title block keeps 18px.

Every other off-grid value in the approved comps was snapped to the scale when ported.

### Breakpoints
- **960px and below:** 5:7 and 7:5 splits collapse to one column; procedures go to two columns (36px row gap); the title block goes to two columns with the project cell spanning; the replay board stacks above the story and keeps a slot for the tag.
- **620px and below:** the rail narrows to 22px; the frame loses its margin and side borders and runs edge to edge; the top-bar "Sheet index" link hides (the theme switch stays); procedures become a vertical process line with the valve rotated 90 degrees; the lockout tag's field list becomes one column; full-width close and 404 buttons; on the landing page the drawing follows the headline directly; the replay's four steps become two rows of two and its controls stick to the top while the story scrolls (on wider screens the drawing sticks beside the story instead), with `scroll-padding-top` set so focus lands below them.

### Named Rules
**The Measured Stack Rule.** A schedule keeps its table form while the section holding it is as wide as the table needs, measured on the rendered table, and below that becomes one block per row with each cell's column name printed above it. Each schedule names its own container and queries it a few pixels above its measured need (the replay log at 604px against 600, the deploy resource table at 764 against 761, the role tables at 1032 against 1030, the stored-field table at 540 against 536, the model record at 394 against 391, the accessibility record at 412 against 409, the hand-check schedule at 616 against 612). A schedule whose section grows wider at 620px, because the frame runs edge to edge there, also stacks at `(max-width: 620px)` (the stored-field table, the accessibility record and the hand-check schedule); both conditions set one container name, so the stacked rules are written once. Each schedule changes form exactly once between 320 and 1440, never by the viewport alone. A threshold is a measurement: a content change that widens a table moves its threshold.

## Elevation & Depth

The system is flat. There are no drop shadows, gradients, blur or glass anywhere. Depth is conveyed by line weight and fill, with three weights set as tokens on `:root`:

- **Rule** (`--w-rule`, 1px): divides inside an object.
- **Outline** (`--w-outline`, 1.5px): marks an object (frame, schedule, message, specimen, tag, notice, theme switch, flow switch, state mark).
- **Emphasis** (`--w-emph`, 2.5px): marks the exceptional (the Deny rule over the never-granted permission, a faulty specimen, the unproven state mark).

Browsers round border widths down to whole device pixels, so on a screen under 1.5 device pixels per CSS pixel a 1.5px outline would draw as 1px, the same as a rule. There, a `max-resolution: 1.49dppx` query steps outline to 2px and emphasis to 3px, and the three weights stay distinct. A dashed outline-weight ink border marks a notice that something is simulated or not yet built, and selection is the ground tint plus an outline-weight ink frame, never the tint alone.

### Shadow Vocabulary
`box-shadow` is used only to draw rings, never elevation:
- **Focus ring on the theme switch** (`box-shadow: 0 0 0 3px var(--sheet), 0 0 0 5px var(--ink)`): keyboard focus on a segment whose native input is hidden.
- **Current replay step** (`box-shadow: 0 0 0 4px var(--sheet), 0 0 0 6px var(--ink)`): the filled dot of the step on screen.
- **Quiet button outline** (`box-shadow: inset 0 0 0 var(--w-outline) var(--ink)`): draws the quiet button's border without changing its box.

### Named Rules
**The Line Weight Rule.** Hierarchy comes from the three stroke weights (rule, outline, emphasis) and fill, never from a cast shadow. CSS borders on objects use the weight tokens, never a literal fractional width. Pipework is a line, not an object weight: its CSS borders stay 2.5px (drawn 2px on a 1x screen, the outline's width there, told apart by being Pipework grey where outlines are ink), and SVG strokes in drawings are not rounded by the browser and keep their own values.

**The Exception Is A Rule, Not A Box Rule.** The Deny block on the deploy sheet is marked by an emphasis-weight ink rule over its heading and schedule, not by a frame around a framed schedule.

## Shapes

Corners are square. Controls (buttons, inputs, the theme switch, the flow switch, the stamp, outlet boxes in drawings) take a 2px radius. The only rounded object is the tag, a punched card: 10px top corners and 4px bottom corners, its red band 8px at the top, a 16px punched hole whose top sits 12px below the card's top edge (centre 20px down, the same point the tag rotates about), and a dashed outline-weight rule above its footer. It always hangs at a slight fixed angle (-2.5 degrees on the wide landing drawing, -2 degrees on the narrow one and the replay board, origin 50% 20px), a pose rather than an animation, with 18px of stem always showing above the card.

Drawn symbols come from process drawings: the bow-tie valve (open is sheet-filled with an ink stroke, closed is ink-filled), direction arrowheads in ink, a round instrument bubble for the read-back, envelope outlets for live lines and a dashed grey outlet for a closed one, a dashed box for the model (the one part that writes no state) and an emphasis-weight box for the action check. Each drawing carries one line per lane, with the closed lane drawn last so its stem drops clear to the hung tag; the narrow landing drawing keeps its lowest 48 viewBox units free of text.

A part shown where it will go is drawn as a phantom: Cell Rule at rule weight, dash-dot (`12 4 2 4`), the drafting line convention. The replay uses it for the tag's outline and stem in the reserved tag slot at 960px and below, while the tag is off.

State marks are 12px squares drawn in SVG (a dashed CSS border on a 12px square renders solid) with an outline-weight stroke, and no two differ by colour alone: filled ink for open; Lock Mark with a knocked-out horizontal bar for closed; dashed for not yet, which the landing page's what-is-real table also uses for fixture data; round for watching; an empty outline at emphasis weight for unproven. A schedule cell may also carry the `none` state: the state name printed with no mark, the mark's place kept empty in table form so the state names stay aligned, and the spacer dropped once the schedule stacks, where each block holds one state and there is no column to align.

## Components

### Buttons
Plain and firm, one weight of ink.
- **Shape:** square with a 2px radius, minimum 48px tall.
- **Primary:** ink fill, sheet text, Red Hat Text 600 at 1rem, 16px 24px padding, an optional 16px trailing arrow drawn in `currentColor`.
- **Hover / Focus:** hover shifts the fill to Secondary Ink; focus is the global 2px ink outline offset 3px.
- **Quiet:** transparent with an outline-weight inset ink outline and ink text; hover fills with the ground tint.
- **Disabled:** Cell Rule fill, Field Label text, no outline, not-allowed cursor, the same box as enabled so controls never move.
- **Text link action:** Red Hat Text 600 with 12px vertical padding for the tap target, underlined.

### Inputs / Fields
No shipped sheet carries a form field yet; the incumbent decision stands for the first one.
- **Style:** sheet fill, ink text, outline-weight ink border, 2px radius, 12px 14px padding, minimum 48px tall, Red Hat Text 400 at 1rem.
- **Label:** the mono label style above the field, uppercase, Field Label colour.
- **Focus:** 2px ink outline offset 2px.

### Navigation
- **Skip link:** "Skip to main content", ink fill with sheet text, off screen until focused.
- **Top bar:** the zone strip, then the wordmark on the left and, on the right, a "Sheet index" link (Small, 600) and the theme switch.
- **Theme switch:** a fieldset of three segments (Device, Light, Dark) in an outline-weight ink border with a 2px radius; segments are mono 600 at 0.75rem, at least 44px wide and 36px tall, divided by Cell Rules; the selected segment is ink-filled with sheet text. Native radios sit over their labels, so the group keeps one Tab stop and its arrow keys. Hidden without JavaScript, since Device already follows the OS through CSS alone.
- **Title block:** the footer, a grid of four cells: Project (twice the width of the others), Sheets (the working sheets: Landing, Replay, Deploy), Read (the reading sheets: Privacy and AI, Accessibility), and Drawing. The Drawing cell prints, in mono at Mono Value in Field Label, the drawing number with its position (`FTH-001, sheet 1 of 5` through `FTH-005, sheet 5 of 5`; the 404 page reads `Not in the sheet set`), the revision and date (`Rev A, 2026-10-17`, from a committed site constant, never the build clock, the date kept whole), and the fixture status. Field names are Label Small, links are Red Hat Text 600 with 8px block padding; the current sheet's link carries a 3px underline. Cells are divided by Cell Rules. Two columns with the project cell spanning at 960px, one at 620px.
- **Links:** inherit colour, 1px underline offset 0.22em, 2px on hover.
- **Flow switch:** a mono 600 button at 0.75rem, at least 44px square, sheet fill with an outline-weight ink border and a 2px radius, reading "Stop flow" or "Run flow". It sits in the caption row of every drawing with moving flow (WCAG 2.2.2), stores `stopped` or `running` in `localStorage` under `fothering-flow`, applied in `<head>` like the theme; with nothing stored the flow follows reduced motion. Hidden without JavaScript, and wherever the drawing on screen has no moving flow. In forced colours the selected theme segment is underlined and focus draws an outline, since fills and rings are dropped.

### Schedules (tables)
A drawing's table: full width, an outline-weight ink outline, rule-weight Cell Rules, 13px 16px cell padding at Cell size, cells meeting on their first baseline, uppercase mono column headers over an outline-weight ink rule, row headers in Red Hat Text 600, and a mono caption below the outline that names the source. The product's own row may carry the ground tint and 600 weight; cells that do not act are set in Secondary Ink. A prose cell keeps a readable column in table form through a minimum width on its text (12em for reasons and removals, 16em for model values, the accessibility record and the hand-check method), and that minimum is part of what the table needs.
- **Compact:** the replay's evidence, Schedule Compact type and 8px 12px cells. Where its panel is under 460px each row's dimension spans the row as a heading over its three readings.
- **Stacked:** see the Measured Stack Rule in Layout. Each row becomes a block divided from the next by an outline-weight ink rule; every cell prints its column name above it in Label Small, Field Label colour; an empty cell is left out; the header row is hidden. The caption prints above the rows, in source order, as the approved comp prints it. The stacked reset clears every table-form minimum on a cell's text, so a stacked cell never keeps a width floor meant for a column, and a field path that held one line in table form may again break after its dot.
- **Ruled:** the landing limits table, a schedule without the outline, its rows divided by Cell Rules under an outline-weight ink rule.

### Lockout Tag
The signature component, the one place colour lives. Up to 320px wide, white card, outline-weight outline in Drawing Ink, punched hole, red band holding the legend ("LANE CLOSED", or "LANE PAUSED" when the artifact holds no hold check), the lane name in mono and a boxed stamp whose text comes from the provenance label map (for example "FIXTURE RUN" while the data is a fixture). Below the band, a two-column list of Cause, Read back and Reopens ("Run the reopen command"), with an Evidence line between Cause and Read back where no evidence schedule sits beside the tag (the landing tag carries it; the replay shows the evidence next to the tag instead), then a dashed footer with the tag number and the row it hangs in. The list becomes one column at 620px. It hangs from the closed valve's stem in drawings.

### Message
The operator email shown as a message, not described: an outline-weight ink box up to `calc(44ch + 48px)` wide, a mono header list (From, Subject) at Mono Value with 12px 24px padding over a Cell Rule, a body padded 16px 24px 24px that opens with the AI disclosure line (Small, Secondary Ink, above a Cell Rule, naming the one paragraph the agent wrote), then Cell-size paragraphs with bold run-in heads, ending with the Reopen paragraph that names the reopen command. Inline padding steps to 16px at 620px. The incumbent reply variant (a second message overlapping the first by one outline weight) is not used on any shipped sheet.

### Procedure
An ordered list drawn as one process line in Pipework (2.5px) with a Numeral and a valve per step; the step that closes is drawn with the filled valve. The line runs from each valve to the next step's numeral and never passes under a numeral, so nothing is drawn between a numeral and its own valve (the approved comp's short dash there, made by the line showing between two knock-outs, is not carried). Four columns by default, five where a page has five steps, two at 960px, a vertical line at 620px. Step text is Cell size in Secondary Ink, capped at 34ch; step titles cap at 18ch.

### Command Block
A command as a reader would paste it: ground fill, a rule-weight Cell Rule border, Mono Value at 500 with a 1.5 line height, keeping the source's own line breaks. Padding is 12px 16px, and 8px on all sides inside a procedure step, so a flag and its value (`-c fothering:live=live`) keep one line in a five-column procedure from 1280px. Each argument is an unbreakable unit and a flag with its value is one unit; a unit wraps whole to the next line, and breaks inside itself only when it alone is wider than the block. A note under a command is a 500 Label caption in Field Label.

### Notice Box
A dashed outline-weight ink border with 12px 16px padding and a bold mono run-in label, used to say a surface is a dry run or not yet built. Its sentence keeps the measure; the padding and outline sit outside it.

### Replay Step Strip
The replay's timeline is the procedure's process line: four steps on a Pipework line, each a 22px dot in a 2px ink ring with its UTC time (Label, 600, Field Label) and label, closed off below by a Cell Rule. The current step is told by its filled dot and ring alone; the label's weight and every box stay the same between steps.

## Do's and Don'ts

### Do:
- **Do** write every colour token once, as a light and a dark value, emitted on `:root` and in the two identical dark blocks, and let Device (no stored choice) follow the OS.
- **Do** keep red to the closed lane's tag band and its Lock Mark, using `lock-dark` for any mark drawn on the dark sheet.
- **Do** give every page the frame, the A to F zone strip, numbered rows and the title block, and cite row numbers in copy when pointing at the drawing, since a zone letter shifts with the width.
- **Do** set identifiers in Red Hat Mono 500 with tabular numerals at Mono Value, spelled as the API spells them, breaking only after a dot.
- **Do** take every type size from the `--text-` ramp and every padding, margin and gap from the 4-point scale or its closed list of off-grid values.
- **Do** stack a schedule at its own measured need through a named container query, and also at 620px where its section widens there, so it changes form once.
- **Do** label fixture data as fixture on the tag stamp, the caption and the title block status until live runs replace it, and never call data built from AWS's documented examples "recorded" or "captured".
- **Do** give every moving drawing the Flow switch, and keep the flow still under `prefers-reduced-motion` until the visitor runs it, so closed and open lines differ by valve fill and the dotted outlet, never by motion alone.
- **Do** keep controls at least 48px tall (theme switch segments at least 44 by 36px, the flow switch 44px square) with the 2px ink focus outline.
- **Do** serve Red Hat Display, Text and Mono from the site's own origin.

### Don't:
- **Don't** use red for a region, frame, button, link, heading, logo, the 404 page, an unconfirmed closure or any decoration.
- **Don't** add drop shadows, gradients, glass or blur; `box-shadow` is only for focus and current-step rings and the quiet button's inset outline.
- **Don't** put charts beside a headline or show a measured number without its recorded source.
- **Don't** introduce a second hue, a warm paper ground or blueprint blue.
- **Don't** animate anything except flow dashes on live lines (1.6s linear cycle); no scroll reveals, parallax or timed replay advance.
- **Don't** let drawing content bleed past the sheet frame.
- **Don't** nest bordered boxes inside bordered boxes beyond the frame and its objects.
- **Don't** stack a schedule by viewport width alone, or let a table-form minimum survive into its stacked form.
- **Don't** break an identifier mid-name or wrap a date or citation inside itself.
