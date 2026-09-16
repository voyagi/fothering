# Art direction: The Tagged Isolation

Locked 2026-09-16. Every page of the site, and the mockups in `design/mockups/`, derive from this file.

The idea in one sentence: the SES account is drawn as one flow drawing, and when Fothering closes a lane it
shuts that lane's isolation valve and hangs a tag on it that states the cause, the evidence and the read-back,
while flow keeps moving on every other line.

## 1. Audience evidence

### Who adopts it

Developers and founders at software and online shop teams of about 2 to 50 people who send through Amazon
SES, AWS partners who run SES for clients, and, first, the hackathon judges from AWS Communication Developer
Services. Products they open every week: the AWS console and its documentation, the AWS Health dashboard, a
transactional email service they compared SES against, and the status pages of the services they depend on.

### What those products look like today

Read from the live HTML and stylesheets on 2026-09-16 with a script that fetches each page, follows its linked
CSS and counts declarations. Counts are occurrences in the shipped CSS.

| Product | Faces served | Most used colours | Radius | Notes |
| --- | --- | --- | --- | --- |
| cloudscape.design (the AWS console design system) | Open Sans, Amazon Ember | `#000716`, `#0f141a`, `#1b232d`, `#ffffff`, blue `#295eff`, `#03c` | 16px and 20px on marketing cards only | 2 shadows, 2 gradients in 731 kB of CSS |
| health.aws.amazon.com/health/status | Amazon Ember | ink `#16191f` x178, ground `#eaeded` x156 and `#f2f3f3` x36, grey `#545b64`, blue `#0073bb` x187, red `#d13212` x22 | tokenised | a status table first, colour only on state |
| postmarkapp.com | Elizeth, Rund Text, Bitstream Vera Sans Mono | `#fff` x74, ink `#272727` x44, green `#4fc47e`, blue `#007bc8`, red `#d14642`, yellow `#ffde00` | 6px and 4px | 31 shadows |
| resend.com | Favorit, Domaine, Commit Mono, Inter | `#fff` x241, `#000` x202, mint `#62ffb3` | pills and 0 | 148 shadows, 378 gradients, dark first |
| githubstatus.com (Atlassian Statuspage) | system stacks, Menlo for mono | `#fff`, blue `#3498db`, green `#2ecc71`, red `#e74c3c` | 4px x113 | colour means state, nothing else |
| cloudflarestatus.com | system stacks | `#fff`, `#f5f5f5`, ink `#171717` and `#262626`, orange `#f6821f` | 0 to 6px | grey neutrals, one brand colour |

What the table says:

1. **Grounds are neutral or cool, never warm.** White, `#f2f3f3`, `#eaeded`, `#f5f5f5`. Not one reads as paper
   or cream.
2. **Ink is a cool near-black** (`#0f141a`, `#16191f`, `#171717`), not pure black and not brown.
3. **Colour is state.** AWS Health and both status pages spend saturated colour almost only on "is this
   working". Red is the one reserved for something being down.
4. **The AWS surfaces are flat.** Cloudscape ships two shadows and two gradients in 731 kB. The email sending
   products are the decorated ones (Resend's 378 gradients), and they sell to a different buyer.
5. **Mono carries identifiers.** Every product names a mono or falls back to one for ids, versions and
   timestamps.

### Quality signals and warning signs

- Reads as quality: exact API names spelled as the API spells them (`SendingOptions.SendingEnabled`), numbers
  with their source, a limits section, a visible "this is demo data" label, dense tables that stay readable.
- Reads as a warning: a chart wall beside a headline, invented metrics, glossy gradients, a shield or
  "AI-powered" badge, anything that pauses more than it says it pauses.

### Where to differ, and where to stay familiar

- Differ from the category's dashboard of charts. The product acts on one lane and explains, so the page shows
  the lane and the explanation.
- Stay familiar on density, flat surfaces, cool neutrals, mono for identifiers and red meaning stopped. An SES
  expert should feel at home in the tables and trust the wording.

## 2. Anchor

**A process flow drawing with one isolation locked out and tagged.** Two living engineering practices, read
as a grammar rather than worn as a costume:

- **The flow drawing.** A process and instrumentation drawing (the ISO 10628 family) shows every line from a
  source to its outlets, with a valve symbol where a line can be isolated. The sheet sits in a border whose
  zone letters and row numbers give every item a coordinate, and a title block in the corner indexes the sheet.
- **Lockout and tagout.** Before work on a machine, its energy source is isolated at a valve or breaker, and
  a tag is hung on that exact point. United States rules require the tag to say who applied it and to warn
  with a legend such as "Do Not Start" or "Do Not Operate" (29 CFR 1910.147(c)(5)(ii)(D) and (c)(5)(iii), read
  2026-09-16 on law.cornell.edu). The tag is the one piece of colour on an otherwise grey installation.

Why this fits Fothering and nothing else: a configuration set is literally a line that carries mail from one
account to its recipients, closing it is isolating one line while the others stay live, and the product's
promise (cause, evidence, read-back, who reopens it) is what a lockout tag exists to state. The name agrees:
fothering stops one leak without stopping the ship.

It is contemporary. These drawings and tags are in daily use in every plant today. Nothing here is a period
piece: no aged paper, no blueprint cyan, no stencil lettering.

## 3. Palette

Two designed token sets. Device mode follows the operating system, and both sets are written once through
`light-dark()`, so the dark set is chosen, not inverted.

| Token | Role | Light | Dark |
| --- | --- | --- | --- |
| `--ground` | the table the sheet lies on, visible only as the margin | `#F5F7F8` | `#0F1316` |
| `--sheet` | the drawing sheet, every reading surface | `#FFFFFF` | `#161B1F` |
| `--ink` | text, the frame, valves, the SES source | `#0E1113` | `#E8ECEE` |
| `--ink-2` | secondary text | `#3B444A` | `#AEB7BD` |
| `--label` | zone letters, captions, field names | `#566067` | `#9DA7AE` |
| `--line` | process lines, the pipework | `#8A949B` | `#6F7A82` |
| `--rule` | cell rules and grid lines | `#C9D0D4` | `#2A3238` |
| `--flow` | the moving dashes on a live line | `#0E1113` | `#E8ECEE` |
| `--tag-red` | the tag's header band, on its white card in both themes | `#C8102E` | `#C8102E` |
| `--lock` | a locked-out mark drawn on the sheet itself | `#C8102E` | `#E0304A` |

The tag is a physical card, so it keeps white stock, `#0E1113` ink and its `#C8102E` band in both themes.
Everything else changes with the theme.

Measured contrast (WCAG ratio, computed 2026-09-16):

| Pair | Light | Dark |
| --- | --- | --- |
| ink on sheet | 18.95 | 14.59 |
| ink on ground | 17.63 | 15.70 |
| ink-2 on sheet | 9.94 | 8.51 |
| label on sheet | 6.43 | 7.08 |
| line on sheet (a graphic, needs 3.0) | 3.09 | 3.95 |
| white text on the tag band | 5.88 | 5.88 |
| lock mark on sheet (a graphic, needs 3.0) | 5.88 | 3.87 |

`--lock` exists because `#C8102E` on the dark sheet measures 2.95, under the 3.0 a state mark needs.

**The red rule.** Red belongs to the closed lane, and appears in exactly two places: the tag hung on that
lane, and the square beside that lane's name wherever lanes are listed. A closure the read-back did not
confirm leaves the lane open, so it is drawn in heavy ink, and so is the permission Fothering is never
granted. Red is never a region fill, a frame, a button, a link, a heading, a logo or decoration. On any
screen it covers less than a tag's area.

Shape of the palette: a cool white sheet on a cool grey table, a cool near-black ink at a few line weights,
grey pipework, and one safety red confined to the locked-out point. No second hue anywhere.

## 4. Type

All three are SIL Open Font License, and resolve on the Google Fonts css2 endpoint (checked 2026-09-16: six
`@font-face` blocks for Red Hat Display, Red Hat Text and Red Hat Mono). The site self-hosts them. The mockups
load them from Google Fonts only for convenience.

| Face | Weights used | Job |
| --- | --- | --- |
| Red Hat Display | 700, 800, 850, 900 | page titles, section titles, step numerals, the wordmark, the tag's legend |
| Red Hat Text | 400, 500, 600 | every sentence, table cells, buttons |
| Red Hat Mono | 400 to 600, tabular numerals | lane names, API fields, tags like `import_batch=...`, timestamps, zone letters |

Why this family: a neutral, screen-first grotesque that an infrastructure audience already reads (Depot ships
exactly this trio), with a real display cut for the legend on a tag and a mono built to sit beside it. The
mono does work: every identifier an SES expert would copy is set in it.

Ramp as built: page title 36 to 60px at 700 with -0.026em tracking, section title 28 to 44px at 700, step
title 22px, body 17px at 1.55, labels 11 to 13px mono. The tag legend is the heaviest type on the page, 900 at
28px with positive tracking, because a legend is read from across a room.

## 5. Structure

**The site is one drawing sheet.** Not a stack of marketing sections.

- **Frame and zones.** Every page sits in a 1.5px ink border. A zone strip of columns A to F runs along the
  top, and each band of content is a numbered row with its number in a left rail. The coordinates are real:
  copy cites them ("like the valve at D1 above"), so the border is an index, not ornament.
- **Title block as navigation.** The footer is the drawing's title block: project, sheet list (replay,
  console, deploy), reading list (privacy, AI disclosure) and source status. The current sheet carries a
  heavier underline.
- **The first viewport is the drawing.** Five columns of claim on the left, seven columns of flow drawing on
  the right: the SES source, four named lanes, flow moving on three, the fourth stopped at a filled valve with
  the tag at the largest scale on the page. Arrows give each line its direction, and a read-back instrument
  bubble sits on the closed valve. On a phone the drawing comes straight after the headline. The drawing
  runs to the sheet border and stops there rather than bleeding past it: a drawing's content lives inside
  its frame (ISO 5457), and crossing the frame would make the border decoration instead of the sheet edge.
- **Title block fields.** Drawing number `FTH-001` to `FTH-006`, sheet n of 6, revision and date, status
  "fixture", so the fixture label is part of the sheet itself on every page.
- **Drawing conventions below the fold.** A procedure is one process line with a valve per step, the closing
  step drawn shut. A comparison is a schedule, a ruled table with an ink outline and a caption naming its
  source. The operator email is shown as a real message with the reply indented under it, because the inbox
  is the product's working surface.
- **Other sheets.** The replay is the same drawing advancing one event at a time. The console is a lane
  schedule with the selected closure's tag and evidence beside it. Deploy is a permissions schedule with the
  never-granted call in a heavy ink frame. Privacy and AI disclosure are plain reading sheets inside the same frame.
- **Corners and depth.** Square corners at 2px on controls. The tag alone has a rounded top, since it is a
  punched card. No shadows, no gradients, no glass, no cards inside cards.

## 6. Motion

Motion is flow, and only flow.

- Live lines carry dashes that move from source to outlet at a constant 1.6 second cycle. A closed line has no
  dashes. The difference between moving and still is the whole story of the first viewport.
- The replay advances by event, as a change of state rather than an animation: bounce marks appear on the
  line, then its dashes stop, the valve fills and the tag hangs on the stem. The visitor moves each step with
  a button or the arrow keys, never on a timer.
- The tag hangs at a slight angle from its hole, a fixed pose, not an animation.
- `prefers-reduced-motion` stops every dash. Closed and open lines then differ by the valve fill and the
  dotted outlet, never by motion alone.
- No scroll-triggered reveals, no parallax, no bounce.

## 7. Real media

The media is the product's own material at full fidelity: the flow drawing of a real configuration set
layout, the tag filled with a real SES diagnostic code and the real API field it read back, the closure email
exactly as sent, the operator's reply, and event tables built from recorded runs. Every one is labelled
"fixture run" until three live runs replace them. No stock photography, no illustration of people, no charts
without a recorded source.

## 8. References and what was taken from each

| Reference | Mechanic taken |
| --- | --- |
| ISO 10628 flow diagrams and P&ID practice | lines from one source to many outlets, the bow-tie valve symbol, drawn filled for a closed valve as P&ID sheets commonly do |
| ISO 5457 sheet layout and ISO 7200 title blocks | zone letters and numbers as coordinates, the title block as the sheet's index |
| 29 CFR 1910.147 lockout and tagout | the tag hangs on the isolation point and states who, why and a legend, it is the only colour |
| AWS Health dashboard | a status table first, saturated colour spent only on state, cool grey ground |
| Cloudscape | flat surfaces, cool near-black ink, mono for identifiers |
| Depot | Red Hat Display, Text and Mono as a working trio for an infrastructure product |

## 9. Refused

Charts beside a headline, gradients, glass, shadows, a hero illustration, a shield or lock icon, a
dark-first page nobody chose, warm paper grounds, blueprint blue, a stencil or typewriter face, and red on
anything that is not locked out.
