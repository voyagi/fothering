# Art direction: The Muted Track

Locked 2026-10-20. It replaces The Tagged Isolation, locked 2026-09-16. Every page of the site derives from
this file, and `DESIGN.md` at the repository root records the tokens and rules as built. The mockups in
`design/mockups/` belong to the retired direction and are kept only as its record.

The idea in one sentence: the SES account is drawn as one pattern playing on a step sequencer, each
configuration set a track and each recorded event a lit step, and when Fothering closes a lane it mutes that
one track from the step the pause took while every other track keeps its state.

## 1. Audience evidence

### Who adopts it

Developers and founders at software and online shop teams of about 2 to 50 people who send through Amazon
SES, AWS partners who run SES for clients, and, first, the hackathon judges from AWS Communication Developer
Services. Products they open every week: the AWS console and its documentation, the AWS Health dashboard, a
transactional email service they compared SES against, and the status pages of the services they depend on.

### What those products look like

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

1. **Grounds are neutral, never warm paper.** White, `#f2f3f3`, `#eaeded`, `#f5f5f5`.
2. **Ink is a near-black**, not pure black and not brown.
3. **Red means something stopped.** AWS Health and both status pages spend saturated colour almost only on
   "is this working".
4. **The AWS surfaces are flat.** The email sending products are the decorated ones, and they sell to a
   different buyer.
5. **Mono carries identifiers.** Every product names a mono or falls back to one for ids, versions and
   timestamps.

### Where to differ, and where to stay familiar

- Differ from the category's chart wall and from the neutral kit the category's sites share: a white panel,
  one accent colour, square black buttons and hairline tables with small mono heads. Fothering acts on one
  lane and explains, so the page shows the lanes and the one that went quiet.
- Stay familiar on density, flat surfaces, a neutral grey ground, mono for identifiers and red meaning
  stopped: the one status colour on the site is the LED red that lights the muted track's key.

## 2. Anchor

**An early-80s rhythm machine's step row**, in the step-sequencer grammar that current drum machines and the
step sequencers in music software still use. Tracks run in rows and steps in columns, the keys are printed in
colour banks so a player can count the bar at a glance, every track has a mute key, small lamps show what is
on, and a seven-segment readout shows a number.

Why this fits Fothering and nothing else: an SES account sends several streams at once, exactly as a pattern
plays several tracks at once. Closing a lane silences one stream while the others keep sending, which is what
muting a track does while the machine keeps playing, and the silence is drawn at the step it took. Reopening
is unmuting. The name agrees: fothering stops one leak without stopping the ship.

It is a working grammar, not a costume. Each key is one of the run artifact's recorded events in time order,
never an even slice of invented traffic, and each bank is one step of the replay.

## 3. Palette

Shape: a mid-grey chassis carries all reading, light first, with a charcoal chassis in dark. Four bank hues,
fixed in both themes, own every keyed row on every page. One LED red lights only what is on. A black readout
window carries red seven-segment digits. There is no white panel and no reading card: text sits on the
chassis itself.

| Token | Role | Light | Dark |
| --- | --- | --- | --- |
| `--ground` | the chassis, every reading surface | `#D8D9D5` | `#1C1C1B` |
| `--ink` | silkscreen ink: text, 2px rules, focus | `#141413` | `#ECEAE4` |
| `--ink-2` | secondary text, the unlit mute label | `#3B3B38` | `#B9B8B2` |
| `--label` | captions and field names | `#55554F` | `#9C9B95` |
| `--rule` | cell rules, never a line that carries state | `#A6A7A1` | `#3D3D3A` |
| `--well` | recessed strips: table heads, the theme module, command blocks, the unlit mute | `#C9CAC5` | `#262625` |
| `--key-edge` | the 1px edge of a key or pad | `#6F706B` | `#0E0E0D` |
| `--key-muted`, `--key-muted-ink` | a muted track's keys and their legend | `#A3A29C`, `#121211` | `#4E4D49`, `#DAD8D2` |
| `--led`, `--led-off` | a lit lamp and an unlit one | `#FF2B17`, `#4D4D49` | `#FF3B26`, `#45453F` |
| `--window`, `--window-ink`, `--segment-off` | the readout window, its text, an unlit segment | `#0E0E0D`, `#D9D7D0`, `#3A0F0A` | `#0A0A09`, `#D9D7D0`, `#3A0F0A` |
| `--key-red`, `--key-orange`, `--key-yellow`, `--key-white` | the four banks, the same in both themes | `#E8492F`, `#EF8519`, `#F1BF1B`, `#F6F5F0` | same |
| `--key-ink` | every legend printed on a key | `#121211` | `#121211` |

Contrast, computed on 2026-10-21 from `packages/web/src/theme/tokens.json` with the WCAG sRGB luminance
formula:

| Pair | Light | Dark |
| --- | --- | --- |
| ink on ground | 13.00 | 14.18 |
| ink-2 on ground | 7.92 | 8.58 |
| label on ground | 5.29 | 6.12 |
| ink on well | 11.18 | 12.59 |
| label on well | 4.55 | 5.44 |
| key ink on the red, orange, yellow and white keys | 4.84, 7.18, 10.90, 17.17 | the same |
| muted key ink on a muted key | 7.32 | 5.94 |
| LED on the readout window | 5.16 | 5.57 |
| window ink on the window | 13.41 | 13.75 |
| LED on ground (a graphic, needs 3.0) | 2.64 | 4.80 |

**The bank rule.** The four hues mark order, never status. On the step pattern and the replay's step keys
they are the replay's four steps in time order, red, orange, yellow, white. Elsewhere they number the order of
sections and steps on the page.

**The LED rule.** LED red lights only what is on: the muted track's MUTED key, the current replay step, a
bounce, the current page's lamp and the chosen theme's lamp. It is never a fill for a region, a heading or a
button. Because LED red on the light chassis measures 2.64:1, a lamp never carries a state alone: the current
page is also underlined, the chosen theme key's cap fills with ink, and the lamps on the MUTED key, the
current step and a bounce sit inside a key-ink outline.

## 4. Type

All three faces are SIL Open Font License and self-hosted from the `@fontsource-variable` packages (Saira
5.3.0, Public Sans 5.3.0, Source Code Pro 5.3.1).

| Face | Weights used | Job |
| --- | --- | --- |
| Saira | 600, 700, 800, with the width axis condensing heads and labels | headlines in heavy condensed caps, the wordmark, key legends, labels, table heads, buttons, navigation |
| Public Sans | 400, 600 | every sentence and table cell |
| Source Code Pro | 500, 600, tabular numerals | lane names, API fields, message tags, SMTP codes, UTC times |

Saira is the silkscreen voice printed on the chassis, the one place the type is expressive. Working text stays
in a plain screen face at reading sizes. Labels are silkscreen caps, never mono, and mono is kept for what an
SES operator would copy. An identifier keeps its own case inside a silkscreen head, so a lane name reads
`fothering-bulk` and never in capitals.

## 5. Structure

**The site is one chassis.** No frame, no white panel, no card grid.

- **Top strip.** Under a 2px ink rule: FOTHERING in heavy condensed caps on the left, the three page links each
  with a lamp (the current page's lit), and at the far right a separate recessed module holding the Device,
  Light and Dark keys, each with a lamp, Device lit by default. The theme module is never part of the
  navigation.
- **First band.** On the landing page: the claim on the left, the black readout module on the right (the
  window's sends in red segments, the cause, the muted lane, the read-back time and the fixture stamp), and the
  full-width step pattern below. The replay, privacy, accessibility and 404 pages open the same way, with a
  readout that answers that page's first question. The deploy page opens on its steps as a row of keys.
- **The step pattern.** Lane labels on the left, one column per recorded event headed by its kind and time,
  banked by replay step, the bounce lamps red. The muted track drops to grey from the pause column and its
  MUTED key lights. The pattern keeps every column at every width: below its own measured width the column
  heads move off the keys and the bank labels carry each step's name and time.
- **Bands after the first.** Each is headed by a keycap in its bank colour, in page order red, orange,
  yellow, white.
- **Procedures** are rows of keys with printed numerals. **Tables** keep their heads in silkscreen caps on a
  recessed strip under a 2px ink rule, and each stacks into one block per row at its own measured width.
  **Notices** are a 2px ink box marked by an unlit lamp. **Buttons** are keycaps: a red key with a dark legend
  for the primary action, an outlined key for the secondary.
- **The close.** The landing page ends on a black window band, and the footer index sits under a 2px ink rule.
- **The replay** is the same pattern advancing one replay step at a time, beside its readout, with the four step
  keys under it and one panel per step.
- **Corners and depth.** The readout module, keycap heads, procedure keys and the theme module take 6px
  corners. Buttons, pads, the replay's step keys, the window, theme keys, notices and command blocks take 4px. The
  theme key caps and the fixture stamp take 3px, the lamp slots printed on keys 2px, and lamps are round. No
  shadows, no gradients, no glass, no cards inside cards.

## 6. Motion

- On first view the playhead runs once across the pattern, each event's lamp lighting in turn, then the mute
  lands: the MUTED key lights and the muted keys drop to grey. Measured on 2026-10-21: 13 animations on the
  landing page, all ended by 1360 ms.
- The replay plays a step's bank when that step shows (5 animations, ended by 550 ms). The visitor moves each
  step with a key, a button or the arrow keys, never on a timer.
- Nothing loops and nothing moves after the run settles. Under `prefers-reduced-motion` every lamp is placed
  lit and every key in its final state, with no animation on any page.

## 7. Real media

The media is the product's own run: the step pattern built at build time from the committed run artifact, one
column per recorded event, and the readout's digits drawn as SVG segments from the artifact's send count.
Beside them sit the product's own artifacts set as text: the closure email, event rows, the evidence and the
CloudFormation tables. Every one is labelled as a fixture run until three live runs replace it. No
photography, no illustration of people, no chart without a recorded source.

## 8. References and what was taken from each

| Reference | Mechanic taken |
| --- | --- |
| Early-80s rhythm machine step rows | tracks in rows and steps in columns, keys in colour banks, a mute key per track, lamps for what is on, a seven-segment readout |
| Step sequencers in current drum machines and music software | the grammar visitors already read: a lit step is an event, a muted track keeps its steps and goes quiet |
| Sewing pattern envelopes | the committed choice solid and the alternatives in outline: the cause acted on is a filled square, each cause ruled out the same square in outline |
| Bioluminescent forest floors | one signal at full strength per screen: only the muted track's key is lit at full strength |
| Personal home page rooms of the early social web | the pattern stays whole at every width and restacks its labels around the keys rather than cropping one |
| Fashion flagship stores | one object at its real scale: the step pattern owns the full width of the first viewport |
| Character reference sheets | whole keys only: a row drops a whole key rather than cropping one |

## 9. Refused

A product screenshot hero over feature rows, a chart wall, the neutral kit described in section 1, colour
confined to one signature object, glowing LEDs with halos, shadows, gradients, glass, looping motion, an even
sixteen-step pattern of traffic the artifact never recorded, warm paper or cream grounds, and red on anything
that is not on.
