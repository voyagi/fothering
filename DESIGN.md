---
name: Fothering
description: One SES account as a pattern playing, each lane a track of step keys, the closed lane muted while the rest play on.
colors:
  ground: "#D8D9D5"
  ground-dark: "#1C1C1B"
  ink: "#141413"
  ink-dark: "#ECEAE4"
  ink-2: "#3B3B38"
  ink-2-dark: "#B9B8B2"
  label: "#55554F"
  label-dark: "#9C9B95"
  rule: "#A6A7A1"
  rule-dark: "#3D3D3A"
  well: "#C9CAC5"
  well-dark: "#262625"
  key-edge: "#6F706B"
  key-edge-dark: "#0E0E0D"
  key-muted: "#A3A29C"
  key-muted-dark: "#4E4D49"
  key-muted-ink: "#121211"
  key-muted-ink-dark: "#DAD8D2"
  led: "#FF2B17"
  led-dark: "#FF3B26"
  led-off: "#4D4D49"
  led-off-dark: "#45453F"
  window: "#0E0E0D"
  window-dark: "#0A0A09"
  window-ink: "#D9D7D0"
  segment-off: "#3A0F0A"
  key-red: "#E8492F"
  key-orange: "#EF8519"
  key-yellow: "#F1BF1B"
  key-white: "#F6F5F0"
  key-ink: "#121211"
typography:
  display:
    fontFamily: "Saira, sans-serif"
    fontSize: "clamp(2.5rem, 1.6rem + 2.6vw, 3.75rem)"
    fontWeight: 800
    lineHeight: 0.98
    letterSpacing: "0.005em"
    fontVariation: "'wdth' 75"
  landing-headline:
    fontFamily: "Saira, sans-serif"
    fontSize: "clamp(2.25rem, 1.5rem + 2.2vw, 3.5rem)"
    fontWeight: 800
    lineHeight: 0.98
    letterSpacing: "0.005em"
    fontVariation: "'wdth' 75"
  headline:
    fontFamily: "Saira, sans-serif"
    fontSize: "clamp(1.75rem, 1.35rem + 1.2vw, 2.375rem)"
    fontWeight: 800
    lineHeight: 1
    letterSpacing: "0.01em"
    fontVariation: "'wdth' 75"
  narrative-headline:
    fontFamily: "Saira, sans-serif"
    fontSize: "clamp(1.5rem, 1.25rem + 0.8vw, 2rem)"
    fontWeight: 800
    lineHeight: 1
    letterSpacing: "0.01em"
    fontVariation: "'wdth' 75"
  title:
    fontFamily: "Saira, sans-serif"
    fontSize: "1.0625rem"
    fontWeight: 700
    lineHeight: 1.25
    letterSpacing: "0.06em"
    fontVariation: "'wdth' 85"
  wordmark:
    fontFamily: "Saira, sans-serif"
    fontSize: "2rem"
    fontWeight: 800
    lineHeight: 1
    letterSpacing: "0.02em"
    fontVariation: "'wdth' 70"
  numeral:
    fontFamily: "Saira, sans-serif"
    fontSize: "2rem"
    fontWeight: 800
    lineHeight: 1
    fontVariation: "'wdth' 75"
  silk:
    fontFamily: "Saira, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 600
    lineHeight: 1.3
    letterSpacing: "0.14em"
    fontVariation: "'wdth' 85"
  silk-small:
    fontFamily: "Saira, sans-serif"
    fontSize: "0.6875rem"
    fontWeight: 600
    lineHeight: 1.25
    letterSpacing: "0.14em"
    fontVariation: "'wdth' 85"
  key-legend:
    fontFamily: "Saira, sans-serif"
    fontSize: "0.9375rem"
    fontWeight: 700
    lineHeight: 1.2
    letterSpacing: "0.12em"
    fontVariation: "'wdth' 85"
  lede:
    fontFamily: "Public Sans, sans-serif"
    fontSize: "1.125rem"
    fontWeight: 400
    lineHeight: 1.55
  intro:
    fontFamily: "Public Sans, sans-serif"
    fontSize: "1.0625rem"
    fontWeight: 400
    lineHeight: 1.55
  body:
    fontFamily: "Public Sans, sans-serif"
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.55
  small:
    fontFamily: "Public Sans, sans-serif"
    fontSize: "0.9375rem"
    fontWeight: 400
    lineHeight: 1.5
  caption:
    fontFamily: "Public Sans, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 400
    lineHeight: 1.4
  mono-value:
    fontFamily: "Source Code Pro, monospace"
    fontSize: "0.8125rem"
    fontWeight: 500
    lineHeight: 1.5
    fontFeature: "\"tnum\" 1"
rounded:
  slot: "2px"
  stamp: "3px"
  key: "4px"
  module: "6px"
  lamp: "50%"
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
    backgroundColor: "{colors.key-red}"
    textColor: "{colors.key-ink}"
    typography: "{typography.key-legend}"
    rounded: "{rounded.key}"
    padding: "12px 24px"
    height: "48px"
  button-outline:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    typography: "{typography.key-legend}"
    rounded: "{rounded.key}"
    padding: "12px 24px"
    height: "48px"
  button-outline-hover:
    backgroundColor: "{colors.well}"
  button-disabled:
    backgroundColor: "{colors.rule}"
    textColor: "{colors.label}"
  keycap-head:
    backgroundColor: "{colors.key-red}"
    textColor: "{colors.key-ink}"
    typography: "{typography.headline}"
    rounded: "{rounded.module}"
    padding: "12px 40px 12px 16px"
  step-key:
    backgroundColor: "{colors.key-red}"
    textColor: "{colors.key-ink}"
    typography: "{typography.numeral}"
    rounded: "{rounded.module}"
    padding: "8px 12px"
    height: "72px"
  pad:
    backgroundColor: "{colors.key-red}"
    rounded: "{rounded.key}"
    height: "44px"
  pad-muted:
    backgroundColor: "{colors.key-muted}"
  mute-unlit:
    backgroundColor: "{colors.well}"
    textColor: "{colors.ink-2}"
    typography: "{typography.silk-small}"
    rounded: "{rounded.key}"
    height: "44px"
  mute-lit:
    backgroundColor: "{colors.key-red}"
    textColor: "{colors.key-ink}"
    typography: "{typography.silk-small}"
    rounded: "{rounded.key}"
    height: "44px"
  readout:
    backgroundColor: "{colors.ground}"
    textColor: "{colors.ink-2}"
    rounded: "{rounded.module}"
    padding: "16px"
  readout-window:
    backgroundColor: "{colors.window}"
    textColor: "{colors.window-ink}"
    rounded: "{rounded.key}"
    padding: "12px 16px"
  theme-module:
    backgroundColor: "{colors.well}"
    textColor: "{colors.ink-2}"
    typography: "{typography.silk-small}"
    rounded: "{rounded.module}"
    padding: "4px 8px 4px 12px"
  notice:
    backgroundColor: "{colors.ground}"
    textColor: "{colors.ink}"
    rounded: "{rounded.key}"
    padding: "12px 16px"
  command:
    backgroundColor: "{colors.well}"
    textColor: "{colors.ink}"
    typography: "{typography.mono-value}"
    rounded: "{rounded.key}"
    padding: "8px 12px"
  stamp:
    textColor: "{colors.ink}"
    typography: "{typography.silk-small}"
    rounded: "{rounded.stamp}"
    padding: "4px 8px"
  schedule-head:
    backgroundColor: "{colors.well}"
    textColor: "{colors.ink}"
    typography: "{typography.silk}"
    padding: "12px 16px"
---

# Design System: Fothering

## Overview

**Creative North Star: "The Muted Track"**

The site is the front panel of an early-80s rhythm machine. One SES account is one pattern playing: each configuration set is a track, each recorded event is a lit step, and the lane Fothering closed is a muted track. Muting is the whole idea of the system. A muted track keeps every one of its keys; they drop to grey from the step the pause took and its MUTED key lights red, while the open tracks keep their colour. Closing a lane is muting a track, never stopping the machine.

The material is a grey chassis panel printed in silkscreen ink, light (ground) or charcoal (ground-dark). Every keyed row on every page takes its colour from four step-key banks that hold in both themes: red, orange, yellow and key white. One LED red lights only what is on. A black readout window carries red seven-segment digits. Saira, condensed and heavy in capitals, is the silkscreen and headline voice; Public Sans sets working text and table cells; Source Code Pro sets identifiers. Density is that of a hardware panel: tight labels in spaced caps, generous key sizes, rules of ink between modules.

The panel refuses the category's usual arrangement. There is no product screenshot hero over feature rows and no wall of charts; the evidence is the pattern itself, the readout beside it and the schedules below.

**Key Characteristics:**
- A grey chassis printed in silkscreen ink, light and charcoal, with step keys in four bank colours fixed across themes.
- One LED red, and only what is on is lit by it.
- Keys are the only raised objects: buttons, section heads, procedure steps, pattern pads and the lit mute.
- Saira condensed caps for silkscreen and headlines, Public Sans for text, Source Code Pro for identifiers.
- Motion runs once: the playhead crosses the pattern, the lamps light in turn, the mute lands, and nothing moves after.
- Device, Light and Dark themes, Device the default.

## Colors

A neutral grey chassis and its ink, four saturated key banks that never change with the theme, and one LED red reserved for state.

### Primary
- **Bank Red Key** (key-red): the first bank and the acting key. The primary button, the lit MUTED key, the first bank of the step pattern and the first keycap head on a page.
- **LED Red** (led, led-dark in the dark theme): the lamp that is on. The lit lamp in the MUTED key, the active theme key's lamp, the current page's lamp in the top strip, the bounce lamps on pads, the current replay step's lamp and the lit segments in the readout window.

### Secondary
- **Bank Orange Key** (key-orange): the second bank of pads, the second keycap head and the second procedure key.
- **Bank Yellow Key** (key-yellow): the third bank, the third keycap head and procedure key. Also the text selection colour.

### Tertiary
- **Key White** (key-white): the fourth bank, the lit pad lamp's face and the bezel around a bounce lamp or the current step's lamp.
- **Key Ink** (key-ink): the legend printed on every coloured key, in both themes.

### Neutral
- **Chassis Grey** (ground / ground-dark): the panel itself.
- **Silkscreen Ink** (ink / ink-dark): headlines, rules of 2px between modules, outlined keys and focus outlines.
- **Second Ink** (ink-2 / ink-2-dark): working text, ledes, schedule cells, silkscreen labels.
- **Label Grey** (label / label-dark): captions, times in the pattern heads, column labels on stacked cells, disabled legends.
- **Rule Grey** (rule / rule-dark): 1px row dividers in schedules and lists, the disabled key fill, the lamps of an unplayed pad.
- **Recessed Well** (well / well-dark): anything set into the panel rather than standing on it: the theme module, the unlit mute, schedule heads, command wells, the highlighted log row, the outlined key's hover.
- **Key Edge** (key-edge / key-edge-dark): the 1px edge around every coloured key.
- **Muted Key Grey** (key-muted / key-muted-dark) with its ink (key-muted-ink): a pad after the pause took its track.
- **Unlit Lamp** (led-off / led-off-dark): a lamp on the chassis that is off.
- **Readout Glass** (window / window-dark), its ink (window-ink) and the unlit segment (segment-off): the black readout window and the close band at the foot of the landing.

### Named Rules
**The One LED Rule.** LED red marks only what is on: the lit MUTED key's lamp, the active theme, the current page, a bounce, the current replay step and the readout's lit segments. Nothing decorative is ever lit.

**The Fixed Banks Rule.** The four bank colours and key ink are the same hex in light and dark. A key is a physical object and does not change colour with the room; only the chassis, its ink, the well and the lamps change.

**The Bank Order Rule.** Keyed rows take banks in order: red, orange, yellow, white. Keycap section heads follow page order, procedure keys follow step order (past four, every step stays white), and pattern pads take the bank of the replay step they belong to.

## Typography

**Display Font:** Saira (with sans-serif), its width carried on font-stretch from 70% to 85%
**Body Font:** Public Sans (with sans-serif)
**Label/Mono Font:** Source Code Pro (with monospace), tabular figures on

**Character:** Saira in heavy condensed capitals reads as panel silkscreen and gives the headlines their hardware voice; Public Sans keeps the working text plain and readable; Source Code Pro keeps every AWS name exactly as AWS spells it. All three are self-hosted, latin and latin-ext only.

### Hierarchy
- **Display** (800, clamp 40px to 60px, 0.98, Saira at 75% width, caps): the h1 of every page but the landing.
- **Landing Headline** (800, clamp 36px to 56px, 0.98, Saira at 75% width, caps): the landing h1, three lines beside the readout at 1280.
- **Headline** (800, clamp 28px to 38px, 1, Saira at 75% width, caps): h2, set on a keycap after the first band.
- **Narrative Headline** (800, clamp 24px to 32px): the replay panel's step title on its keycap.
- **Title** (700, 17px, 1.25, Saira at 85% width, 0.06em, caps): h3, role headings, fact headings.
- **Wordmark** (800, 32px, Saira at 70% width): FOTHERING in the top strip.
- **Numeral** (800, 32px, Saira at 75% width): the step number printed on a procedure key; the replay step keys print it at title size.
- **Lede** (400, 18px, 1.55, max 58ch): the landing claim's paragraph.
- **Intro** (400, 17px, 1.55): the first paragraph of every other page.
- **Body** (400, 16px, 1.55, max 54ch): running text.
- **Small** (400, 15px): schedule cells, readout values, procedure text, message body.
- **Caption** (400, 12px, 1.4, Public Sans): figure and schedule captions, command notes.
- **Silkscreen** (600, 12px, 0.14em, caps, Saira at 85% width): readout labels, nav labels, findings labels, schedule heads at 700 and 0.12em.
- **Silkscreen Small** (600 or 700, 11px, 0.14em, caps): the theme module, the mute legend, the stamp, pattern column heads.
- **Mono Value** (500, 13px, tabular): identifiers, commands, times.

### Named Rules
**The Measure Rule.** Prose stops at 54ch (the measure token) for paragraphs, list items and definitions; the landing lede alone runs to 58ch. Notices allow the measure plus 64px for their lamp.

**The Exact Spelling Rule.** An identifier keeps the case AWS gives it everywhere it appears. Inside silkscreen caps an identifier in the mono face resets to no text transform and zero tracking (eu-central-1 in a readout head, never EU-CENTRAL-1), and a name set in the face around it (the replay h1's lane name, fothering-bulk in Saira) also keeps its own case. A deploy role heading sets the role name as a mono identifier at the heading's size.

**The Dot Break Rule.** An identifier ends a line only right after one of its dots; each dotted part is an unbreakable run. Only API operation names in the replay log's Detail cells and IAM actions in the permission schedules may also break between capitalised words or after the colon.

**The Saira Width Rule.** The font shorthand resets font-stretch, so any rule that sets Saira writes font-stretch after the shorthand.

## Layout

The page is a stack of full-width bands on the chassis, each opened by a 2px ink rule, with a fluid gutter (clamp 16px to 48px) and band padding of clamp 48px to 88px. The top strip is at least 72px tall, closed by a 2px ink rule, and holds the wordmark left, the three working pages with their lamps, and the theme module in its own recessed box at the far right.

The first band is a grid of the claim and a readout module of 320px to 400px. From 961px of viewport it pads 24px top and bottom (40px and 32px below that), so at 1280 x 800 the landing's whole pattern and its caption sit in the first viewport. Later bands use a 5 to 7 split: the keycap head left, its paragraph right. Spacing follows the scale of 4, 8, 12, 16, 24, 32, 40, 48 and 64px.

At 960px of viewport and below, every split goes to one column, procedures to two columns and the replay summary to two. At 620px and below the top strip's nav takes its own row, procedures and the summary go to one column, the replay controls stick to the top with 120px scroll padding, and wide drawings swap for their narrow versions. Below 1.5 device pixels per CSS pixel the outline weight steps from 1.5px to 2px and the emphasis weight from 2.5px to 3px, so the three line weights stay distinct.

### Named Rules
**The Own Width Rule.** A pattern or a schedule changes form by the width of its own container, never by the viewport alone, and each threshold is the measured need plus a few pixels. The containers in the build:
- **pattern** (the landing figure and the replay board): column heads give way below 1067px; the board's twelve columns need 1063px.
- **log** (the replay log): stacks below 595px; measured need 591px.
- **resources** (deploy resource table): stacks below 760px; measured need 756px. Below 286px its code steps down to 12px.
- **permissions** (deploy role tables): stack below 911px; widest measured need 907px.
- **fields** (privacy stored-field table): stacks below 512px (measured need 508px) or at 620px of viewport.
- **model** (privacy model record): stacks below 370px; measured need 366px.
- **record** (accessibility record): stacks below 385px (measured need 381px) or at 620px of viewport.
- **checks** (accessibility hand checks): stacks below 638px (measured need 634px) or at 620px of viewport.
- **limits** (landing limits table, Note column kept): stacks below 503px (measured need 499px) or at 620px of viewport.
- **steps** (replay step keys): each key sits beside its time and label from 820px of row.
- The compact evidence schedule in a replay panel turns each dimension into a heading over its readings below 460px of panel body.

A stacked schedule prints each cell under its column name in silkscreen small, rows parted by the outline weight, and leaves empty cells out.

## Elevation & Depth

The system is flat. There are no shadows anywhere. Depth is physical and binary: a key stands on the panel, shown by its bank fill and a 1px key edge; a recessed part is set into the panel, shown by the well fill. Modules are boxed by a 2px ink outline (the readout, notices, the message) and the readout window is black glass. Lamps are the only light source.

### Named Rules
**The Raised Or Recessed Rule.** Every part is either a key (bank fill, key edge) or set into the panel (well fill, no edge). Nothing floats, and nothing casts a shadow.

## Shapes

Corners are small and hardware-like. Modules (the readout, the theme box, keycap heads, procedure keys) round at 6px. Keys, pads, the mute, the readout window, notices, commands and messages round at 4px. The FIXTURE RUN stamp and the theme key caps round at 3px. Lamp slots and the slot at a pad's foot round at 2px. Lamps are circles.

Line weights come in three: 1px for rules and key edges, 1.5px outline (2px on low density screens) for stacked row dividers and state marks, 2.5px emphasis (3px) for the Deny block. Module and band rules are 2px ink. Committed choices are a filled square and alternatives the same square in outline. A pad not yet played is a dashed outline with its lamps out.

## Components

### Buttons
Keycap buttons: firm, square-shouldered, legend in silkscreen caps.
- **Shape:** gently squared key (4px), at least 48px tall.
- **Primary:** red key with key ink legend (key-legend type, 12px by 24px padding), a 16px arrow drawn as SVG.
- **Hover / Focus:** the arrow moves 4px right over 200ms; pressed keys drop 1px; focus is a 2px ink outline offset 3px. Reduced motion removes the arrow travel and the press.
- **Outline:** transparent with a 2px ink border and ink legend; hover fills with the well.
- **Disabled:** rule fill, label legend, no arrow travel.
- **Quiet:** the replay's step button, a silkscreen legend underlined at 1px, 2px on hover.

### Theme Switch
A recessed hardware module of three keys, Device, Light and Dark, each with a lamp over a 32 by 14px cap and its word. The native radios sit over their keys, so the group keeps one Tab stop and its arrow keys. The pressed key fills its cap with ink, lights its lamp and sets its word in full ink. Device is the default and stores nothing; Light or Dark is kept in localStorage under `fothering-theme`. Without JavaScript the module is hidden, since Device already follows the OS through CSS.

### Navigation
The top strip names the three working pages in silkscreen, each with a lamp, at least 44px tall. The current page lights its lamp in LED red and carries a 2px underline, so the mark is not colour alone. The index at the foot of every page names all five pages, the project line in condensed caps and the replay data's provenance.

### Readout
The landing and replay module: a 2px ink box (6px) with the window's times in silkscreen, the black window with red seven-segment digits 56px tall and the unit beside them, then Cause, Muted and Read back rows under 1px ink rules on an 88px label column, and the FIXTURE RUN stamp. The Muted row carries a lit lamp. The 404 page uses the same module with the head Response, the identifier 404 Not Found and the unit Status code.

### Step Pattern (signature)
Tracks of pads, one per lane: the lane name and state left (13rem), the pads, a mute at the right (5.5rem). Pads are 44px keys in their step's bank, a lamp slot at the top and a slot at the foot. An event pad lights its lamp key white; a bounce pad lights a red LED core inside a 3px key-white bezel so it holds on the red bank. From the pause column the muted track's pads drop to muted grey. Column heads carry the event kind in silkscreen and its time in mono; bank labels sit under a 2px rule that spans each bank.

- **Mute, unlit:** a recessed printed label, well fill, transparent border, default cursor. It is a state, never a control.
- **Mute, lit:** the one key lit at full strength: red fill and border, key ink legend MUTED, its lamp LED red ringed in key ink.
- **Motion:** on first view the playhead runs once: each lit lamp comes on over 160ms at 400ms plus 90ms per column, muted pads drop over 240ms, the mute lights over 200ms, all on cubic-bezier(0.16, 1, 0.3, 1). The replay plays only the shown step's bank, from 120ms. Nothing loops. Reduced motion places the final state.

### Replay Step Keys
Under the board, each step is a 44px key in its bank under a rule spanning its bank, the number top left and a lamp top right, its time in mono and its label in silkscreen. The current step's lamp is a 12px LED with a 2px key-white bezel, and its label takes a 2px underline whose weight never changes, so the row never rewraps.

### Keycap Section Heads
After the first band each section's h2 sits on a keycap: bank fill, key edge, 6px corners, 12px by 16px padding with 40px on the right for a lamp slot in the top right corner.

### Procedure
A row of keys read left to right, each step's number printed on a 72px key (64px for the removal steps and on phones) in bank order, with a title and short text under it.

### Schedules
Full-width tables collapsed onto the chassis. The head sits in silkscreen caps on a recessed strip under a 2px ink rule; rows are parted by 1px rules; cells meet on their first baseline. Captions sit below in caption type. Row heads are 600 weight ink; the highlighted row fills with the well.

### Notice
A 2px ink box (4px) led by an unlit lamp and a run-in silkscreen label: something that is not on yet.

### Command
A command as a reader would paste it: mono on a recessed well (4px), each flag with its value kept as one unit that wraps whole.

### Message
The operator email shown as a message: a 2px ink box with a mono header block on the well, the disclosure line above a rule, then the body. Up to 44ch plus 48px wide.

## Do's and Don'ts

### Do:
- **Do** take key colours from the four banks in order (red, orange, yellow, white) and keep them identical in both themes.
- **Do** keep LED red for what is on, per The One LED Rule.
- **Do** mute a lane by greying its pads from the pause step and lighting its MUTED key; keep every pad in place.
- **Do** set the unlit mute as a recessed printed label (well fill, transparent border, default cursor).
- **Do** switch a pattern or schedule by its own container at its measured need plus a few pixels.
- **Do** cap prose at 54ch and the landing lede at 58ch.
- **Do** keep an identifier's AWS spelling inside caps, and break it only after a dot.
- **Do** offer Device, Light and Dark with Device the default, storing only `fothering-theme`.
- **Do** place every lamp lit and every key in its final state under reduced motion.

### Don't:
- **Don't** add shadows or floating surfaces; a part is raised as a key or recessed as a well.
- **Don't** make the unlit mute look pressable, or light more than one mute.
- **Don't** let any animation loop or move after the first run settles.
- **Don't** switch the pattern's column heads or a schedule's form by viewport width alone.
- **Don't** delete or hide a muted track; muting is never removal.
- **Don't** uppercase an identifier, or let it break at a hyphen.
- **Don't** use a product screenshot hero over feature rows or a wall of charts.
