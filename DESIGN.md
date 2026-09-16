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
  headline:
    fontFamily: "Red Hat Display, sans-serif"
    fontSize: "clamp(1.75rem, 1.2rem + 1.6vw, 2.75rem)"
    fontWeight: 700
    lineHeight: 1.08
    letterSpacing: "-0.02em"
  title:
    fontFamily: "Red Hat Display, sans-serif"
    fontSize: "1.375rem"
    fontWeight: 700
    lineHeight: 1.25
  body:
    fontFamily: "Red Hat Text, sans-serif"
    fontSize: "1.0625rem"
    fontWeight: 400
    lineHeight: 1.55
  label:
    fontFamily: "Red Hat Mono, monospace"
    fontSize: "0.75rem"
    fontWeight: 600
    lineHeight: 1.3
    letterSpacing: "0.05em"
    fontFeature: "\"tnum\" 1"
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
  gutter: "clamp(16px, 3vw, 40px)"
  rail: "34px"
  rail-narrow: "22px"
  sheet-block: "clamp(44px, 6vw, 92px)"
  cell: "13px 16px"
components:
  button-primary:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.sheet}"
    typography: "{typography.body}"
    rounded: "{rounded.control}"
    padding: "16px 24px"
    height: "48px"
  button-primary-hover:
    backgroundColor: "{colors.ink-2}"
  button-quiet:
    textColor: "{colors.ink}"
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
    typography: "{typography.label}"
    padding: "11px 10px"
    height: "36px"
    width: "44px"
  tag-band:
    backgroundColor: "{colors.tag-red}"
    textColor: "{colors.tag-card}"
    typography: "{typography.tag-legend}"
    padding: "36px 16px 12px"
---

# Design System: Fothering

## Overview

**Creative North Star: "The Tagged Isolation"**

Every page is one sheet of a process flow drawing. The SES account is the source, each configuration set is a line leaving it, and a closed lane is an isolation valve drawn shut with a lockout tag hung on its stem. The tag states the cause, the evidence, the read-back and what reopens it, while flow keeps moving on every other line. The drawing is a working grammar, not a costume: zone letters and row numbers are real coordinates that copy cites ("the valve at D1"), the footer is the sheet's title block and doubles as site navigation, comparisons are schedules, and a procedure is one process line with a valve per step.

The system is flat, cool and dense in the way infrastructure documentation is dense. A cool white sheet lies on a cool grey ground, drawn in one cool near-black ink at a few line weights, with grey pipework and a single safety red confined to the closed lane. Identifiers an SES operator would copy are always set in mono. There are no shadows, gradients, glass, hero illustrations or charts beside a headline.

Two token sets are designed, not inverted. Device is the default theme and follows the operating system; Light and Dark are explicit choices that only pin `color-scheme`, so every token is written once through `light-dark()`.

**Key Characteristics:**
- A 1.5px ink frame around every page, a zone strip A to F along the top, numbered rows with a left rail.
- Flat surfaces, square 2px corners on controls; the tag is the only rounded, hung object.
- One hue besides the neutrals: red, and only on the closed lane.
- Motion is flow and only flow: dashes moving on live lines.
- Red Hat Display, Text and Mono as one working trio.

## Colors

A cool white sheet on a cool grey table, one near-black ink, grey pipework, and one safety red for the locked-out point. Each neutral token has a light and a dark value; CSS declares them as `light-dark(<light>, <dark>)` on `:root`, and the `-dark` keys in the frontmatter are the second argument.

### Primary
- **Lockout Red** (`tag-red`): the header band of the lockout tag. It sits on the tag's white card in both themes, so it has one value.
- **Lock Mark** (`lock`, `lock-dark`): the filled square beside a closed lane's name wherever lanes are listed (the `shut` state mark). The dark value exists because Lockout Red measures 2.95:1 on the dark sheet, under the 3:1 a state mark needs.

### Neutral
- **Drawing Table** (`ground`, `ground-dark`): the page background, seen only as the margin around the frame; also the tint for a selected row, a newly revealed log row, a quiet button's hover and code blocks.
- **Drawing Sheet** (`sheet`, `sheet-dark`): the frame's fill and every reading surface; also the knock-out fill behind valve symbols and step numerals so they break the process line.
- **Drawing Ink** (`ink`, `ink-dark`): text, the frame, row rules, valves, the SES source box, primary buttons, focus outlines, selection background.
- **Secondary Ink** (`ink-2`, `ink-2-dark`): lede and supporting paragraphs, table header text, primary button hover.
- **Pipework** (`line`, `line-dark`): process lines in drawings, procedures and the replay timeline.
- **Field Label** (`label`, `label-dark`): zone letters, rail numbers, captions, title block field names, form labels, disabled button text.
- **Cell Rule** (`rule`, `rule-dark`): table cell rules, zone dividers, internal grid lines, the dotted outlet of a closed line, disabled button fill.
- **Flow** (`flow`, `flow-dark`): the moving dashes on a live line; equal to ink in both themes.
- **Tag Card** (`tag-card`), **Tag Ink** (`tag-ink`), **Tag Field** (`tag-field`): the tag's paper stock, its outline and text, and its field names. These are literal values, identical in both themes, because the tag is a physical card.

### Named Rules
**The Red Rule.** Red belongs to the closed lane and appears in exactly two places: the band of the tag hung on that lane, and the Lock Mark beside that lane's name. It is never a region fill, a frame, a button, a link, a heading, a logo or decoration, and on any screen it covers less than one tag's area.

**The Unproven Stays Ink Rule.** A closure the read-back did not confirm leaves the lane open, so its state mark is a heavy empty ink outline (2.5px), never red. The permission the product is never granted is likewise framed in heavy ink (2px), not red.

**The Paper Tag Rule.** The tag keeps its white card, near-black ink and red band in both themes. Everything else follows the theme.

**The Device Default Rule.** Every surface offers Device, Light and Dark. Device follows the OS and is the default; a stored choice lives in `localStorage` under `fothering-theme` (`light` or `dark`; Device removes the key) and is applied by a synchronous script in `<head>` before first paint.

## Typography

**Display Font:** Red Hat Display (with sans-serif)
**Body Font:** Red Hat Text (with sans-serif)
**Label/Mono Font:** Red Hat Mono (with monospace), tabular numerals on

**Character:** A neutral, screen-first grotesque trio with a real display cut heavy enough for a tag legend and a mono built to sit beside it. The mono does work: lane names, API fields, message tags, SMTP codes, timestamps and coordinates.

### Hierarchy
- **Display** (`display`): page titles on the working and reading sheets, capped at 22ch, balanced wrapping. The landing headline is its own size (700, `clamp(2.125rem, 1.3rem + 2vw, 3.4rem)`, line-height 1.05, -0.028em).
- **Headline** (`headline`): the title of each numbered row, balanced wrapping. The replay narrative steps it down to `clamp(1.625rem, 1.2rem + 1vw, 2.25rem)`.
- **Title** (`title`): step titles in procedures, sub-sections, specimen titles.
- **Body** (`body`): every sentence. Intro paragraphs 1.125rem, landing lede 1.1875rem; line length 58 to 66ch for prose, narrower in columns.
- **Label** (`label`): table headers and form labels, uppercase; title block field names and tag field names at 0.6875rem with 0.06em tracking. Zone letters and rail numbers are 500 at 0.6875rem, captions 500 at 0.75rem.
- **Wordmark** (`wordmark`): FOTHERING in the top bar, uppercase, 850.
- **Tag Legend** (`tag-legend`): "LANE CLOSED" on the tag, 900 with positive tracking, the heaviest type on any page.
- **Step Numeral**: Red Hat Display 800 at 1.75rem beside each procedure valve; removal steps use 800 at 1.5rem.

### Named Rules
**The Copyable Identifier Rule.** Anything an SES operator would copy (configuration set names, `SendingOptions.SendingEnabled`, `import_batch=...`, `550 5.1.1`, UTC times) is set in Red Hat Mono, spelled exactly as the API spells it.

**The Self-Hosted Faces Rule.** Production serves all three faces from its own origin. Loading them from a third-party font CDN is not allowed in production.

## Layout

The page is a single framed sheet. The frame sits inside a gutter of `clamp(16px, 3vw, 40px)` on the ground. Inside it, a zone strip divides the width into a rail plus six equal columns labelled A to F; below it, each content band is a numbered row: a rail (34px) holding the row number, then the content, with a 1px ink rule between rows.

Content grids use a 5:7 split (`minmax(0, 5fr) minmax(0, 7fr)`) for intro, section heads, the landing first viewport (claim left, flow drawing right), mail, refusals, closures and forms. The replay reverses it to 7:5, drawing first. Rows pad by `clamp(44px, 6vw, 92px)` vertically and the gutter horizontally. Table cells pad 13px 16px.

The first viewport's flow drawing runs to the sheet border and stops there; content never bleeds past the frame.

Breakpoints:
- **960px and below:** 5:7 and 7:5 splits collapse to one column; procedures go to two columns (36px row gap); the title block goes to two columns with the project cell spanning.
- **620px and below:** the rail narrows to 22px; the frame loses its margin and side borders and runs edge to edge; top-bar text links hide (the theme switch stays); procedures become a vertical process line with the valve rotated 90 degrees; schedules marked to stack become one block per row with each cell's column name printed above it; full-width close buttons; on the landing page the drawing follows the headline directly; the replay timeline becomes a horizontal snap-scrolling strip.

## Elevation & Depth

The system is flat. There are no drop shadows, gradients, blur or glass anywhere. Depth is conveyed by line weight and fill: the 1.5px ink outline marks an object (frame, schedule, message, specimen), a 1px rule divides inside it, a 2px to 2.5px ink border marks the exceptional (the never-granted permission, a faulty specimen), a dashed 1.5px ink border marks a notice that something is simulated or not yet built, and the ground tint marks selection.

### Shadow Vocabulary
`box-shadow` is used only to draw rings, never elevation:
- **Focus ring on the theme switch** (`box-shadow: 0 0 0 3px var(--sheet), 0 0 0 5px var(--ink)`): keyboard focus on a segment whose native input is hidden.
- **Current replay step** (`box-shadow: 0 0 0 4px var(--sheet), 0 0 0 6px var(--ink)`): the filled dot of the step on screen.
- **Quiet button outline** (`box-shadow: inset 0 0 0 1.5px var(--ink)`): draws the quiet button's border without changing its box.

### Named Rules
**The Line Weight Rule.** Hierarchy comes from stroke weight (1px rule, 1.5px outline, 2 to 2.5px emphasis) and fill, never from a cast shadow.

## Shapes

Corners are square. Controls (buttons, inputs, the theme switch, the stamp, outlet boxes in drawings) take a 2px radius. The only rounded object is the tag, a punched card: 10px top corners and 4px bottom corners, its red band 8px at the top, a 16px punched hole centred 12px from its top edge, and a dashed 1.5px rule above its footer. It always hangs at a slight fixed angle (between -1.5 and -2.5 degrees, origin 50% 20px), a pose rather than an animation.

Drawn symbols come from process drawings: the bow-tie valve (open is sheet-filled with an ink stroke, closed is ink-filled), direction arrowheads in ink, a round instrument bubble for the read-back, envelope outlets for live lines and a dashed grey outlet for a closed one. State marks are 9px squares with a 1.5px border: filled ink for open, Lock Mark for closed, dashed for not yet, round for watching, heavy empty outline for unproven.

## Components

### Buttons
Plain and firm, one weight of ink.
- **Shape:** square with a 2px radius, minimum 48px tall.
- **Primary:** ink fill, sheet text, Red Hat Text 600 at 1rem, 16px 24px padding, an optional 16px trailing arrow drawn in `currentColor`.
- **Hover / Focus:** hover shifts the fill to Secondary Ink; focus is the global 2px ink outline offset 3px.
- **Quiet:** transparent with a 1.5px inset ink outline and ink text; hover fills with the ground tint.
- **Disabled:** Cell Rule fill, Field Label text, no outline, not-allowed cursor.
- **Text link action:** Red Hat Text 600 with 12px vertical padding for the tap target, underlined.

### Inputs / Fields
- **Style:** sheet fill, ink text, 1.5px ink border, 2px radius, 12px 14px padding, minimum 48px tall, Red Hat Text 400 at 1rem.
- **Label:** the mono label style above the field, uppercase, Field Label colour.
- **Focus:** 2px ink outline offset 2px.

### Navigation
- **Top bar:** the zone strip, then the wordmark on the left and, on the right, a "Sheet index" link and the theme switch.
- **Theme switch:** a fieldset of three segments (Device, Light, Dark) in a 1.5px ink border with a 2px radius; segments are mono 600 at 0.75rem, at least 44px wide and 36px tall, divided by Cell Rules; the selected segment is ink-filled with sheet text.
- **Title block:** the footer, a four-cell grid (project, sheets, reading list, drawing number with sheet n of 6, revision, date and fixture status) divided by Cell Rules. Links are Red Hat Text 600; the current sheet's link carries a 3px underline. Collapses to two columns at 960px and one at 620px.
- **Links:** inherit colour, 1px underline offset 0.22em, 2px on hover.

### Schedules (tables)
A drawing's table: full width, a 1.5px ink outline, 1px Cell Rules, 13px 16px cell padding, uppercase mono column headers over a 1.5px ink rule, row headers in Red Hat Text 600, and a mono caption below that names the source. The product's own column may carry the ground tint and 600 weight; columns that do not act are set in Secondary Ink.

### Lockout Tag
The signature component, the one place colour lives. Up to 320px wide, white card, 1.5px near-black outline, punched hole, red band holding the "LANE CLOSED" legend, the lane name in mono and a boxed "FIXTURE RUN" stamp while data is recorded rather than live. Below the band, a two-column list of Cause, Evidence, Read back and Reopens, then a dashed footer with the tag number and its zone coordinate. It hangs from the closed valve's stem in drawings.

### Message
The operator email shown as a message, not described: a 1.5px ink box up to 68ch wide, a mono header list (From, Subject) over a Cell Rule, a body of Red Hat Text paragraphs with bold run-in heads, and a Field Label disclosure line. A reply is a second message overlapping the first by 1.5px and indented `clamp(20px, 5vw, 64px)` (16px on narrow screens), its text at 600.

### Procedure
An ordered list drawn as one process line in Pipework (2.5px) with a valve and a Display numeral per step; the step that closes is drawn with the filled valve. Four columns by default (set per page), two at 960px, a vertical line at 620px.

### Notice Box
A 1.5px dashed ink border with 12px 16px padding and a bold mono run-in label, used to say a surface is a dry run or not yet built.

## Do's and Don'ts

### Do:
- **Do** set every token through `light-dark()` on `:root` and let Device (no stored choice) follow the OS; explicit Light and Dark only pin `color-scheme`.
- **Do** keep red to the closed lane's tag band and its Lock Mark, using `lock-dark` for any mark drawn on the dark sheet.
- **Do** give every page the frame, the A to F zone strip, numbered rows and the title block, and cite real coordinates in copy when pointing at the drawing.
- **Do** set identifiers in Red Hat Mono with tabular numerals, spelled as the API spells them.
- **Do** label recorded data as fixture on the tag stamp, the caption and the title block status until live runs replace it.
- **Do** stop every flow dash under `prefers-reduced-motion`, so closed and open lines differ by valve fill and the dotted outlet, never by motion alone.
- **Do** keep controls at least 48px tall (theme switch segments at least 44 by 36px) with the 2px ink focus outline.
- **Do** serve Red Hat Display, Text and Mono from the site's own origin in production.

### Don't:
- **Don't** use red for a region, frame, button, link, heading, logo, an unconfirmed closure or any decoration.
- **Don't** add drop shadows, gradients, glass or blur; `box-shadow` is only for focus and current-step rings and the quiet button's inset outline.
- **Don't** put charts beside a headline or show a measured number without its recorded source.
- **Don't** introduce a second hue, a warm paper ground or blueprint blue.
- **Don't** animate anything except flow dashes on live lines (1.6s linear cycle); no scroll reveals, parallax or timed replay advance.
- **Don't** let drawing content bleed past the sheet frame.
- **Don't** nest bordered boxes inside bordered boxes beyond the frame and its objects.
