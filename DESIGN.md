---
name: Fothering
description: One SES account as lanes of light on a bright day, every lane moving except the one closed under a drawn sail.
colors:
  ground: "#FFFFFF"
  ground-dark: "#121B33"
  sky: "#D9E6FF"
  sky-dark: "#1C2D5E"
  tint: "#F2F6FF"
  tint-dark: "#18233F"
  ink: "#0A1024"
  ink-dark: "#EEF2FF"
  ink-2: "#363F57"
  ink-2-dark: "#BAC3DB"
  label: "#535D76"
  label-dark: "#909BB8"
  rule: "#D3DAE8"
  rule-dark: "#2E3A5C"
  well: "#EDF1F8"
  well-dark: "#1A2542"
  accent: "#1C46F5"
  accent-dark: "#7E97FF"
  accent-fill: "#1C46F5"
  accent-fill-dark: "#3557FF"
  accent-hover: "#1235C9"
  accent-hover-dark: "#2442D6"
  on-accent: "#FFFFFF"
  board: "#070B16"
  board-edge: "#070B16"
  board-edge-dark: "#2E3A5C"
  board-ink: "#E8EDF8"
  board-label: "#97A3C2"
  board-rule: "#1D2740"
  board-slot: "#141C30"
  lane-1: "#4C8DFF"
  lane-2: "#FF8A2A"
  lane-3: "#2FD39A"
  stop: "#FF4A26"
  note: "#FFEE9C"
  note-ink: "#231E0B"
  note-tape: "#C9DAFF"
  d-blue: "#1C46F5"
  d-sky: "#9DBCFF"
  d-coral: "#FF6A3D"
  d-sun: "#FFC93C"
  d-pink: "#FF8CC6"
  d-mint: "#2FCB8E"
  d-cloth: "#F6ECD6"
  d-ink: "#0A1024"
  d-paper: "#FFFFFF"
  d-mist: "#F2F6FF"
typography:
  landing-headline:
    fontFamily: "Mona Sans, sans-serif"
    fontSize: "clamp(2.5rem, 1.35rem + 4.1vw, 5rem)"
    fontWeight: 900
    lineHeight: 1.02
    letterSpacing: "-0.03em"
    fontVariation: "'wdth' 108"
  display:
    fontFamily: "Mona Sans, sans-serif"
    fontSize: "clamp(2.25rem, 1.45rem + 2.6vw, 3.5rem)"
    fontWeight: 850
    lineHeight: 1.04
    letterSpacing: "-0.02em"
    fontVariation: "'wdth' 105"
  headline:
    fontFamily: "Mona Sans, sans-serif"
    fontSize: "clamp(1.75rem, 1.3rem + 1.4vw, 2.5rem)"
    fontWeight: 800
    lineHeight: 1.1
    letterSpacing: "-0.015em"
    fontVariation: "'wdth' 105"
  narrative-headline:
    fontFamily: "Mona Sans, sans-serif"
    fontSize: "clamp(1.5rem, 1.2rem + 0.9vw, 2rem)"
    fontWeight: 800
    lineHeight: 1.1
    letterSpacing: "-0.015em"
    fontVariation: "'wdth' 105"
  title:
    fontFamily: "Mona Sans, sans-serif"
    fontSize: "1.125rem"
    fontWeight: 700
    lineHeight: 1.3
    letterSpacing: "-0.005em"
    fontVariation: "'wdth' 100"
  figure:
    fontFamily: "Mona Sans, sans-serif"
    fontSize: "clamp(2.75rem, 2rem + 2.4vw, 4rem)"
    fontWeight: 900
    lineHeight: 0.95
    letterSpacing: "-0.03em"
    fontFeature: "\"tnum\" 1"
    fontVariation: "'wdth' 112"
  wordmark:
    fontFamily: "Mona Sans, sans-serif"
    fontSize: "1.5rem"
    fontWeight: 850
    lineHeight: 1
    letterSpacing: "-0.02em"
    fontVariation: "'wdth' 112"
  numeral:
    fontFamily: "Mona Sans, sans-serif"
    fontSize: "1.25rem"
    fontWeight: 850
    lineHeight: 1
    fontFeature: "\"tnum\" 1"
    fontVariation: "'wdth' 108"
  lede:
    fontFamily: "Mona Sans, sans-serif"
    fontSize: "1.25rem"
    fontWeight: 400
    lineHeight: 1.55
  intro:
    fontFamily: "Mona Sans, sans-serif"
    fontSize: "1.125rem"
    fontWeight: 400
    lineHeight: 1.6
  body:
    fontFamily: "Mona Sans, sans-serif"
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.6
    fontVariation: "'wdth' 100"
  button:
    fontFamily: "Mona Sans, sans-serif"
    fontSize: "1rem"
    fontWeight: 650
    lineHeight: 1.2
    fontVariation: "'wdth' 104"
  small:
    fontFamily: "Mona Sans, sans-serif"
    fontSize: "0.9375rem"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "Mona Sans, sans-serif"
    fontSize: "0.8125rem"
    fontWeight: 600
    lineHeight: 1.35
    letterSpacing: "0.01em"
    fontVariation: "'wdth' 108"
  tag:
    fontFamily: "Mona Sans, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 700
    lineHeight: 1.3
    letterSpacing: "0.06em"
    fontVariation: "'wdth' 112"
  mono-value:
    fontFamily: "Source Code Pro, monospace"
    fontSize: "0.8125rem"
    fontWeight: 500
    lineHeight: 1.55
    fontFeature: "\"tnum\" 1"
rounded:
  note: "4px"
  box: "10px"
  card: "16px"
  pill: "999px"
  disc: "50%"
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
components:
  button-primary:
    backgroundColor: "{colors.accent-fill}"
    textColor: "{colors.on-accent}"
    typography: "{typography.button}"
    rounded: "{rounded.pill}"
    padding: "0 24px"
    height: "52px"
  button-primary-hover:
    backgroundColor: "{colors.accent-hover}"
  button-outline:
    backgroundColor: "{colors.ground}"
    textColor: "{colors.ink}"
    typography: "{typography.button}"
    rounded: "{rounded.pill}"
    padding: "0 24px"
    height: "52px"
  button-outline-hover:
    backgroundColor: "{colors.well}"
  button-disabled:
    backgroundColor: "{colors.rule}"
    textColor: "{colors.label}"
  button-on-blue:
    backgroundColor: "{colors.d-paper}"
    textColor: "{colors.d-blue}"
    typography: "{typography.button}"
    rounded: "{rounded.pill}"
    height: "52px"
  button-on-blue-hover:
    backgroundColor: "{colors.d-mist}"
  theme-switch:
    backgroundColor: "{colors.well}"
    textColor: "{colors.ink-2}"
    typography: "{typography.label}"
    rounded: "{rounded.pill}"
    padding: "4px"
  theme-switch-chosen:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.ground}"
    rounded: "{rounded.pill}"
    height: "40px"
  screen:
    backgroundColor: "{colors.board}"
    textColor: "{colors.board-ink}"
    rounded: "{rounded.card}"
    padding: "clamp(16px, 2.4vw, 32px)"
  slot:
    backgroundColor: "{colors.board-slot}"
    rounded: "{rounded.pill}"
    height: "24px"
  slot-lit:
    backgroundColor: "{colors.lane-1}"
  state-closed:
    backgroundColor: "{colors.stop}"
    textColor: "{colors.d-ink}"
    typography: "{typography.label}"
    rounded: "{rounded.pill}"
    padding: "0 12px"
    height: "32px"
  stamp:
    textColor: "{colors.d-sun}"
    typography: "{typography.tag}"
    rounded: "{rounded.pill}"
    padding: "4px 12px"
  note:
    backgroundColor: "{colors.note}"
    textColor: "{colors.note-ink}"
    rounded: "{rounded.note}"
    padding: "24px"
  step-disc:
    backgroundColor: "{colors.d-blue}"
    textColor: "{colors.d-paper}"
    typography: "{typography.numeral}"
    rounded: "{rounded.disc}"
    size: "44px"
  command:
    backgroundColor: "{colors.board}"
    textColor: "{colors.board-ink}"
    typography: "{typography.mono-value}"
    rounded: "{rounded.box}"
    padding: "12px 16px"
  notice:
    backgroundColor: "{colors.tint}"
    textColor: "{colors.ink-2}"
    rounded: "{rounded.box}"
    padding: "16px 24px"
  schedule-head:
    backgroundColor: "{colors.well}"
    textColor: "{colors.ink}"
    typography: "{typography.label}"
    padding: "12px 16px"
  card:
    backgroundColor: "{colors.ground}"
    textColor: "{colors.ink-2}"
    rounded: "{rounded.card}"
    padding: "24px"
  close-band:
    backgroundColor: "{colors.accent-fill}"
    textColor: "{colors.on-accent}"
---

# Design System: Fothering

## Overview

**Creative North Star: "Lanes and Sail"**

One account's email drawn as lanes of light on a bright day. The page is white under a pale sea-blue sky that fades into it at the top of every page, set in navy-black ink with one sea-blue accent for what acts. The product at work sits on the night board: a dark screen where each SES configuration set is a lane of glowing pills, one slot per event in the replay artifact. Every lane keeps moving except the one Fothering closed, and over that lane, at the slot the pause took, a sail is drawn, the way a crew fothers a hull to stop one leak without stopping the ship.

This world replaces The Muted Track, the grey hardware panel with condensed silkscreen capitals, step keys and seven-segment digits. Nothing of that panel remains in the look: no grey chassis, no keycaps, no LED lamps as decoration, no condensed caps.

Around the board the page is open and friendly. Mona Sans, wide and heavy, carries the headlines, and Source Code Pro carries every AWS name exactly as AWS spells it. Actions are pills. Evidence goes on paper-yellow notes held by a strip of tape, and only real things go on a note. Flat cut-paper drawings show objects from the story (envelopes, the hull, the sail), with depth only by overlap. The site refuses a chart wall and a product-screenshot hero: the board is drawn from the committed replay artifact, not a picture of a dashboard.

**Key Characteristics:**
- A white page (a lifted navy in Dark) under a sea-blue sky fade, navy ink, one sea-blue accent.
- The night board is dark in both themes. Its lane colours are the same in both themes.
- One red marks what is closed: the sail's edge, the closed lane's tag and a bounce's core.
- Mona Sans throughout, Source Code Pro for identifiers, both self-hosted.
- Pill buttons, pill slots, 16px cards, paper-yellow notes.
- Flat cut-paper drawings of story objects, never people, never a gradient or shadow inside a drawing.
- Motion runs once on first view: the lanes fill, the closed lane's later slots turn to outlines, the sail settles. Nothing loops.
- Device, Light and Dark themes, Device the default.

## Colors

A white and navy page with a single sea-blue accent, a fixed night board carrying three lane colours, one stop red, and a small set of fixed drawing colours.

### Primary
- **Sea Blue** (accent, accent-fill, accent-hover): links, the primary pill, the headline's one marked phrase and its drawn stroke, the current page's underline, focus outlines and the close band's whole ground. In Dark the text accent lifts to accent-dark and the fill to accent-fill-dark so both keep AA on the navy ground.
- **Stop Red** (stop): what is closed and nothing else. The sail's edge on the board, the closed lane's state tag and the "lane closed" legend in the facts, and the red core of a bounce slot.

### Secondary
- **Lane Blue, Lane Orange, Lane Green** (lane-1, lane-2, lane-3): the three configuration sets on the board in lane order. On the landing these read as transactional, bulk and alerts. A lit slot takes its lane's colour.
- **Paper Yellow** (note) with **Note Ink** (note-ink) and **Tape Blue** (note-tape): the evidence notes under the board and the highlighted "us" row in a schedule.

### Tertiary
- **Order colours** (d-blue, d-coral, d-mint, d-sun): procedure step discs, replay step rules and the step keys take these in page order, blue, coral, mint, then sun for the fourth step and every one after it. Text on d-blue is d-paper, on the others d-ink.
- **Drawing colours** (d-sky, d-pink, d-cloth, d-paper, d-ink): the cut-paper drawings only. d-cloth is the sail's cloth. d-sun is also the selection colour and the stamp colour on the board.
- **Mist** (d-mist): the close band's white pill on hover, Light's tint held in both themes so the pill's d-blue text keeps 5.98:1 in Dark too.

### Neutral
- **Ground** (ground / ground-dark): the page. Dark is a lifted navy rather than black, so the board reads as a screen on it.
- **Sky** (sky / sky-dark): the top of the first band of every page, faded into the ground by 92% of the band.
- **Tint** (tint / tint-dark): the footer index, notices, figure panels and the replay log's current row.
- **Ink, Second Ink, Label** (ink, ink-2, label and their dark pairs): headings, running text, captions and small labels.
- **Rule** (rule / rule-dark): 1px dividers, card borders, the disabled pill.
- **Well** (well / well-dark): the theme switch box, schedule heads, the outline pill's hover, the message header strip.
- **Board set** (board, board-edge, board-ink, board-label, board-rule, board-slot): the night board and the command boxes. board-edge matches the board on the white page and becomes rule-dark on the navy page, so the board keeps an edge there.

Contrast, computed with the WCAG 2.x relative luminance formula from the hex values above: ink on ground 18.88:1 (Light) and 15.26:1 (Dark), label on ground 6.57:1 and 6.15:1, accent on ground 6.47:1 and 6.31:1, white on accent-fill 6.47:1 and 5.30:1, board-label on board 7.80:1, lane-1 on board 6.14:1, d-ink on stop 5.63:1, note-ink on note 14.23:1.

### Named Rules
**The One Red Rule.** Stop red marks only what is closed: the sail's edge, the closed lane's tag, the "lane closed" legend and a bounce's core. Nothing decorative is red.

**The One Accent Rule.** Sea blue is the only accent on the page. Every link, the primary action and the one marked phrase use it, and nothing else does.

**The Screen Is A Screen Rule.** The night board, its lane colours, its slot colour and its labels are the same hex in Light and Dark. Only the page around it changes.

**The Page Order Rule.** Order colours follow page order: blue, coral, mint, then sun from the fourth on.

## Typography

**Display Font:** Mona Sans (with sans-serif), width carried on font-stretch from 100% to 112%
**Body Font:** Mona Sans (with sans-serif)
**Label/Mono Font:** Source Code Pro (with monospace), tabular figures on

**Character:** Mona Sans set wide and very heavy gives the headlines a confident, friendly weight, and the same family at normal width keeps running text plain. Source Code Pro keeps every AWS name exact. Both faces are self-hosted under their own family names, latin and latin-ext only, and the two latin files are preloaded.

### Hierarchy
- **Landing Headline** (900, clamp 40px to 80px, 1.02, 108% wide, -0.03em): the landing h1, centred over three lines at desktop width. At a 1280px viewport the clamp resolves to about 74px.
- **Display** (850, clamp 36px to 56px, 1.04, 105% wide, -0.02em): the h1 of every other page.
- **Headline** (800, clamp 28px to 40px, 1.1, 105% wide, -0.015em): section h2.
- **Narrative Headline** (800, clamp 24px to 32px): the replay panel's step title.
- **Title** (700, 18px, 1.3): h3, refusals, fact card heads, the footer project line at 800.
- **Figure** (900, clamp 44px to 64px, 0.95, 112% wide, tabular): the sends count on the board.
- **Wordmark** (850, 24px, 112% wide): "Fothering" in the top bar, 20px on phones.
- **Numeral** (850, 20px, tabular): the number on a step disc.
- **Lede** (400, 20px, 1.55, up to 58ch): the landing claim paragraph.
- **Intro** (400, 18px, 1.6): the first paragraph of the other pages.
- **Body** (400, 16px, 1.6, up to 54ch): running text.
- **Small** (400, 15px): schedule cells, board facts, procedure text, message body.
- **Label** (600, 13px, 1.35, 108% wide, 0.01em): small heads of facts, columns and lanes. Sentence case.
- **Tag** (12px): column and step labels on the board at 600, the stamp at 700 in capitals with 0.06em tracking, the "lane closed" legend at 750.
- **Mono Value** (500, 13px, tabular): identifiers, commands, times.

### Named Rules
**The Measure Rule.** Paragraphs, list items and definitions stop at 54ch. The landing lede alone runs to 58ch. A notice allows the measure plus 64px.

**The Sentence Case Rule.** Labels are sentence case. The provenance stamp on the board is the only text set in capitals, because it is a tag.

**The Marked Phrase Rule.** The landing headline marks one phrase, "that lane", in sea blue over a drawn stroke. It never wraps inside itself and never shrinks below the headline size. The build stops if the heading no longer holds the phrase.

**The Exact Spelling Rule.** An identifier keeps the case AWS gives it everywhere and ends a line only at a break after a dot.

**The Width Rule.** The font shorthand resets font-stretch, so a rule that sets the face writes font-stretch after the shorthand.

## Layout

The page is a column: a top bar at least 72px tall with a 1px rule under it, the first band under the sky fade, then full-width bands up to 1240px plus gutters, the close band on the landing, and the index at the foot. The gutter is clamp(16px, 4vw, 56px) and a band's block padding is clamp(56px, 8vw, 104px). Bands after the first are parted by a 1px rule.

The top bar holds the wordmark with its small blue mark (a fothering sail on its two ropes) at the left, the three working pages (Replay, Deploy, Privacy and AI), and the theme switch in a pill box of its own at the far right. On phones (620px and below) the wordmark takes the first row, the pages the second and the switch the third, the order keyboard focus takes.

The landing's hero is a three-column grid: the headline spans all three, then the lede and both pills sit in a 640px centre column between the envelopes drawing on the left and the hull drawing on the right. At 1100px and below the left drawing goes and the hull moves under the actions. At 620px the hero aligns left.

The night board sits under the hero with the gutter on each side. On the landing its lanes come first, so the first lane enters the first viewport, the facts follow under a board rule (window and sends left, cause, closed or paused, and read back right), and the provenance line closes the board. The notes follow under the board in an auto-fit grid of at least 17rem.

Later bands open with a head row split 5 to 7: the h2 left, its paragraph right. Section headings carry no bar or mark above them. Other pages' first band is the claim on the left with an optional drawing column up to 300px (the deploy page carries the hull there). At 960px and below every split goes to one column, procedures to two columns and the replay summary to two. At 620px procedures and the summary go to one column and the replay controls stick to the top with 120px scroll padding.

Spacing follows 4, 8, 12, 16, 24, 32, 40, 48 and 64px.

### Named Rules
**The Own Width Rule.** The board and every schedule change form by the width of their own container, never by the viewport alone, at the measured need plus a few pixels:
- **screen**: the facts stack under the figure below 760px.
- **pattern** (the lanes): below 1067px the column heads give way, each lane's name and state sit above its slots, slots drop from 24px to 20px and the sail from 56px to 34px wide.
- **steps** (replay step keys): each key sits beside its time and label from 820px.
- **log**: stacks below 595px. **resources**: below 760px. **permissions**: below 911px. **fields**: below 512px or at 620px of viewport. **model**: below 370px. **record**: below 385px or at 620px. **checks**: below 638px or at 620px. **limits**: below 503px or at 620px.
- The compact evidence schedule in a replay panel turns each dimension into a heading over its readings below 460px.

## Elevation & Depth

The page is flat. Depth is tonal and by overlap: the sky fade at the top of the first band, the night board as a dark screen on the light or navy page, notes set on the page with a strip of tape over their top edge, and in drawings, paper layers cut over one another. The only shadow-like effects are light, not lift: a lit slot on the board glows in its lane colour, and rings mark state (the white ring around a bounce core, edged in board colour, the double ring around the current replay step). Nothing casts a drop shadow.

### Shadow Vocabulary
- **Lane glow** (`box-shadow: 0 0 14px color-mix(in srgb, var(--lane) 45%, transparent)`): a lit or bounce slot on the board only.
- **State ring** (`box-shadow: 0 0 0 3px var(--board), 0 0 0 5px var(--board-ink)`): the current replay step's disc. Hover rings it at 2px.

### Named Rules
**The Light Not Lift Rule.** Only a lit slot glows. Cards, notes, buttons and the board itself never cast a shadow.

**The Flat Drawing Rule.** Drawings are flat colour layers with depth only by overlap. No gradient and no shadow inside a drawing. The sky fade is the page's only gradient.

## Shapes

Round and friendly. Buttons, slots, the theme switch, tags, the stamp and the skip link are pills (999px). The board, cards, figure panels and the message are 16px. Notices, commands, schedule head corners and replay summary items are 10px. Notes are 4px, like a sheet of paper. Step discs and lamps are circles. Focus outlines are 3px sea blue, offset 3px, on a 4px radius.

Line weights come in three: 1px rules, a 1.5px outline (2px below 1.5 device pixels per CSS pixel) for state marks and stacked row dividers, and a 3px emphasis for the Deny block's coral rule. Schedule heads and the "does and never does" lists sit under a 2px ink rule. Committed is a filled square, alternatives the same square in outline. A replay slot not reached yet is a dashed outline.

## Components

### Buttons
Pills, confident and plain.
- **Shape:** full pill (999px), at least 52px tall, 24px side padding, a 2px border.
- **Primary:** sea-blue fill with white text in button type, an 18px arrow drawn as SVG.
- **Hover / Focus:** fill darkens to accent-hover, the arrow moves 4px right over 200ms on cubic-bezier(0.16, 1, 0.3, 1), pressed drops 1px. Focus is the 3px sea-blue outline. Reduced motion removes the travel and the press.
- **Outline:** ink border and ink text on the ground, hover fills with the well.
- **On blue:** in the close band the pill turns white with sea-blue text, and hover fills it with d-mist in both themes.
- **Disabled:** rule fill, label text, no arrow travel.
- **Quiet:** the replay's step button, an ink text button underlined at 1.5px, 2.5px on hover.

### Theme Switch
A pill box of three segments, Device, Light and Dark, on the well with a 1px rule border, in its own box at the far right of the top bar and never part of the navigation. The native radios sit over their segments, so the group keeps one Tab stop and its arrow keys. The chosen segment fills with ink and sets its word bold, so the choice reads without colour. Device is the default and stores nothing. Light or Dark is kept in localStorage under `fothering-theme`. Without JavaScript the switch is hidden, since Device already follows the OS through CSS.

### Navigation
Top bar links are 600 small text in second ink, at least 44px tall, hover to ink with an underline. The current page is ink with a 3px sea-blue underline offset 8px, so the mark is not colour alone. The index at the foot of every page, on tint, names the project line, all five pages and where the replay data comes from.

### Night Board (signature)
The product at work: a 16px dark screen in both themes. Each lane is a row of the lane's name in mono in its lane colour with its state under it, a run of pill slots (24px tall, 10px apart), and a state cell at the end. A slot with no event is a dim groove (board-slot). An event lights the slot in its lane colour with the lane glow. A bounce adds a 12px red core inside a 2px white ring, edged by 2px of board colour so the mark meets every lane colour at 3:1 or more. Each slot is one event in the artifact, never invented traffic.

On the closed lane, from the slot the pause took, every slot keeps its place as an outline in the lane colour, and an event there keeps a 6px dot inside. The sail (56 by 99px) stands on the boundary between the last lit slot and the first outlined one. The lane's state cell is a red pill with a small sail mark and the word Closed, set only after a hold check passed. Before that the lane reads Paused. The state cell is a state, never a control.

Under the lanes, each replay step spans its slots under a 2px rule in its order colour with its label and time. The facts row reads in one fixed sweep: the window, the sends as one large figure, then cause (a filled square), closed or paused (the sail mark and a red "lane closed" legend), and read back. The provenance stamp is a sun-yellow outlined pill in capitals.

- **Motion:** on first view each lit slot grows in over 220ms at 300ms plus 70ms per slot, the closed lane's later slots turn to outlines over 260ms, the sail drops into place over 520ms and the state tag fills over 220ms, all on cubic-bezier(0.16, 1, 0.3, 1). Past fifteen slots the rest fill together. The replay plays only the shown step's slots, from 120ms. Nothing loops. Reduced motion places the final state.

### Notes
Paper-yellow sheets (4px corners, 24px padding) in note ink, each with a 72 by 20px strip of tape across its top edge, the first two turned a few degrees in opposite directions. The landing holds three: Evidence, Ruled out (each a square in outline) and Reopens. Only real things from the artifact go on a note.

### Procedure
A row of steps read left to right. On the landing each step has a small drawing (88 by 72px) over a 44px disc in its order colour with the number on it, then an h3 and short text. The list carries the number for assistive technology, the printed number is hidden from it.

### Refusals
A ruled list: one row per refusal between 1px rules, the refusal set bold at title size, the reason in running text under it, and a coral cross drawn from two rounded 22 by 4px bars before it.

### Schedules
Full-width tables. The head is label type on the well under a 2px ink rule with 10px top corners. Rows are parted by 1px rules and cells meet on their first baseline. Captions sit below in label type. A highlighted row is paper yellow.

### Command
A command as a reader would paste it: mono on the board colour with board ink, 10px corners, each flag kept with its value as one unit that wraps whole.

### Notice
A tinted 10px box with a 1px rule border, a hollow dot and a bold run-in label: something that is not built yet.

### Close Band
The landing's last band: sea blue owns the band, a drawing of envelope lanes with one sail, the h2 in white at 900 weight (clamp 32px to 52px), and the white pill.

### Drawings
Flat cut-paper SVG layers painted from the tokens: envelopes flying along a dashed lane line under a sun, the hull with a sail drawn over its leak on a blue sea, envelope lanes with one stopped under a sail, and four small step drawings. Outlines are 3px and 2px ink with round caps, and follow the theme's ink so a drawing keeps its edges on the navy ground. Every drawing is decorative and the text beside it says what it shows.

## Do's and Don'ts

### Do:
- **Do** draw one slot per event in the artifact, and keep every slot of a closed lane in place as an outline.
- **Do** call a lane Closed only after a passing hold check. Otherwise it is Paused.
- **Do** keep stop red for what is closed, per The One Red Rule.
- **Do** keep the night board's colours identical in Light and Dark, and keep the Dark page a lifted navy (ground-dark) so the board reads as a screen.
- **Do** draw only objects from the story (envelopes, the hull, the sail) as flat layers with depth by overlap.
- **Do** offer Device, Light and Dark with Device the default, storing only `fothering-theme`.
- **Do** meet WCAG 2.2 AA in both themes and give every state a mark that is not colour alone.
- **Do** self-host Mona Sans and Source Code Pro and keep client script within 2 kB.
- **Do** switch a board or schedule by its own container at its measured need plus a few pixels.
- **Do** place every slot, outline and sail in its final state under reduced motion.

### Don't:
- **Don't** invent traffic, numbers or customers: no slot without an event, no measured number before three live runs, no customer quotes.
- **Don't** draw people, and don't put a gradient or shadow inside a drawing.
- **Don't** use anything that reads as a national flag.
- **Don't** add drop shadows to cards, notes, buttons or the board.
- **Don't** put a bar, pill or kicker above a section heading.
- **Don't** let any animation loop or move after the first run settles.
- **Don't** make a lane's state cell look pressable.
- **Don't** uppercase an identifier or let it break at a hyphen.
- **Don't** bring back The Muted Track's grey chassis, keycaps, decorative lamps or condensed capitals.
- **Don't** use a chart wall or a product-screenshot hero.
