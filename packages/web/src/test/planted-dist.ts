import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NOT_FOUND_ROUTE, routeOf } from '../checks/built-site.js';
import { LANDING_SECTIONS, LIMITS_FIXED_ROWS, LIMITS_REPLAY_ROW, NO_MEASURED_NUMBER_SENTENCE, type LandingSectionId } from '../site/content.js';
import { PROVENANCE_LABELS } from '../site/labels.js';
import { buildReplayView, loadReplayArtifact, type ReplayView } from '../site/replay-view.js';
import { renderRobots, renderSitemap } from '../site/route-list.js';
import { HEAD_SCRIPT, renderTokensCss } from '../theme/head-script.js';

// This file sits four folders below the repo root, like the harness tests.
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

// Planted trees live under the repo's git-ignored node_modules/.cache, never the system temp
// folder, so a planted site can never be mistaken for another checkout's build.
const CACHE = join(REPO_ROOT, 'node_modules', '.cache');

export interface PlantedDist {
  // A planted repo root: its built site sits at packages/web/dist, where the e2e step looks.
  readonly root: string;
  readonly dist: string;
  readonly remove: () => void;
}

// The check context reads the replay artifact's provenance from the root it judges, so every planted
// root carries the committed artifact.
const ARTIFACT_FILE = join('packages', 'web', 'src', 'fixtures', 'replay-incident.json');

export function plantDist(files: Readonly<Record<string, string | Buffer>>): PlantedDist {
  mkdirSync(CACHE, { recursive: true });
  const root = mkdtempSync(join(CACHE, 'fothering-built-'));
  const dist = join(root, 'packages', 'web', 'dist');
  mkdirSync(dist, { recursive: true });
  mkdirSync(dirname(join(root, ARTIFACT_FILE)), { recursive: true });
  copyFileSync(join(REPO_ROOT, ARTIFACT_FILE), join(root, ARTIFACT_FILE));
  for (const [path, body] of Object.entries(files)) {
    const file = join(dist, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, body);
  }
  return { root, dist, remove: () => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) };
}

export function page(body: string, head = '<title>planted</title>'): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">${head}</head><body>${body}</body></html>`;
}

export const SHEET_HEAD_ITEMS = ['title', 'description', 'og:title', 'og:description', 'og:type', 'twitter:card'] as const;
export type SheetHeadItem = (typeof SHEET_HEAD_ITEMS)[number];

export interface SheetHead {
  readonly title?: string;
  readonly description?: string;
  readonly omit?: readonly SheetHeadItem[];
  // What stands where the layout puts the head script and the tokens.css link.
  readonly theme?: string;
}

// The head the layout writes before any metadata: the hashed theme script, then the tokens link.
export const THEME_HEAD = `<script>${HEAD_SCRIPT}</script><link rel="stylesheet" href="/tokens.css">`;
export const HEADERS_TEXT = readFileSync(join(REPO_ROOT, 'packages', 'web', 'public', '_headers'), 'utf8');

// The header every sheet carries: the theme fieldset with Device checked (AC-38).
export const THEME_SWITCH = '<header><fieldset><legend>Colour theme</legend>'
  + '<label><input type="radio" name="theme" value="device" checked> Device</label>'
  + '<label><input type="radio" name="theme" value="light"> Light</label>'
  + '<label><input type="radio" name="theme" value="dark"> Dark</label>'
  + '</fieldset></header>';

export const PLANTED_LEDE = '<p data-lede>Fothering reads the events your Amazon SES configuration sets publish and pauses one configuration set. '
  + 'An agent on Amazon Bedrock AgentCore explains the evidence, and you hear of it by email.</p>';

// The committed artifact's own replay state, the one the check context expects.
export const REPLAY_LIMITS_STATE = PROVENANCE_LABELS[loadReplayArtifact(join(REPO_ROOT, 'packages', 'web')).provenance].limitsState;

export function limitsRow(id: string, part: string, state: string | null): string {
  const stateCell = state === null ? '' : `<td data-limits-state>${state}</td>`;
  return `<tr data-limits-row="${id}"><th scope="row">${part}</th>${stateCell}</tr>`;
}

export const LIMITS_ROWS: readonly string[] = [
  limitsRow(LIMITS_REPLAY_ROW.id, LIMITS_REPLAY_ROW.part, REPLAY_LIMITS_STATE),
  ...LIMITS_FIXED_ROWS.map((row) => limitsRow(row.id, row.part, row.state)),
];

const headingOf = (id: LandingSectionId): string => {
  const section = LANDING_SECTIONS.find((item) => item.id === id);
  return section === undefined ? '' : `<${section.level}>${section.heading}</${section.level}>`;
};

export function limitsSection(rows: readonly string[] = LIMITS_ROWS, sentence: string = NO_MEASURED_NUMBER_SENTENCE): string {
  return `<section data-limits>${headingOf('limits')}<p>${sentence}</p><table>${rows.join('')}</table></section>`;
}

export interface LandingParts {
  readonly lede?: string;
  readonly omit?: LandingSectionId;
  readonly limits?: string;
  readonly extra?: string;
}

// The landing the lede, sections and limits rules pass, with any one part replaced or left out.
export function landingBody(parts: LandingParts = {}): string {
  const heading = (id: LandingSectionId): string => (parts.omit === id ? '' : headingOf(id));
  const limits = parts.omit === 'limits' ? limitsSection().replace(headingOf('limits'), '') : (parts.limits ?? limitsSection());
  return `${heading('moment')}${parts.lede ?? PLANTED_LEDE}${heading('procedure')}${heading('refusals')}${limits}${parts.extra ?? ''}`;
}

export function sheetHead(route: string, options: SheetHead = {}): string {
  const title = options.title ?? `Planted sheet ${route}`;
  const description = options.description ?? `What the planted sheet at ${route} holds.`;
  const items: Readonly<Record<SheetHeadItem, string>> = {
    'title': `<title>${title}</title>`,
    'description': `<meta name="description" content="${description}">`,
    'og:title': `<meta property="og:title" content="${title}">`,
    'og:description': `<meta property="og:description" content="${description}">`,
    'og:type': '<meta property="og:type" content="website">',
    'twitter:card': '<meta name="twitter:card" content="summary">',
  };
  const omitted = new Set(options.omit ?? []);
  return (options.theme ?? THEME_HEAD) + SHEET_HEAD_ITEMS.filter((item) => !omitted.has(item)).map((item) => items[item]).join('');
}

export const REPLAY_VIEW: ReplayView = buildReplayView(loadReplayArtifact(join(REPO_ROOT, 'packages', 'web')));

// The view marks code spans with backticks; the page renders each as code.
export const codeSpans = (text: string): string => text.replace(/`([^`]+)`/g, '<code>$1</code>');

export function replaySummary(view: ReplayView = REPLAY_VIEW): string {
  return `<ol data-wordcount="summary">${view.summary.map((item) => `<li><time>${item.time}</time> ${codeSpans(item.text)}</li>`).join('')}</ol>`;
}

function providerCell(row: ReplayView['schedule']['rows'][number]): string {
  if (row.sourceUrl !== undefined) return `<a href="${row.sourceUrl}">${codeSpans(row.label)}</a>`;
  return `${codeSpans(row.label)}${row.unconfirmed ? ' <span>unconfirmed</span>' : ''}`;
}

function scheduleRows(view: ReplayView): string {
  return view.schedule.rows.map((row) => {
    const marker = row.dimension === 'Provider' ? ' data-provider-row' : '';
    return `<tr${marker}><th scope="row">${providerCell(row)}</th><td>${row.countText}</td><td>${row.verdict}</td><td>${row.threshold}</td></tr>`;
  }).join('');
}

const paragraphs = (texts: readonly string[]): string => texts.map((text) => `<p>${codeSpans(text)}</p>`).join('');

// The four panels as the replay rules read them: one counted container per step, marked by its
// number, in step order.
export function replayPanels(view: ReplayView = REPLAY_VIEW): string[] {
  const [one, two, three, four] = view.steps;
  const panel = (step: ReplayView['steps'][number] | undefined, inner: string): string =>
    `<section data-wordcount="step" data-steps="${String(step?.number ?? '')}"><h2>${step?.heading ?? ''}</h2>${inner}</section>`;
  const schedule = `<table><caption>${view.schedule.caption}</caption><tr><th scope="col">Dimension</th><th scope="col">Count</th><th scope="col">Verdict</th><th scope="col">Threshold</th></tr>${scheduleRows(view)}</table>`;
  const email = `<div><p>Subject: ${view.email.subject}</p><p data-model-role>${view.email.disclosure}</p><p><b>Why.</b> ${view.email.why}</p><p><b>Reopen.</b> ${view.email.reopen}</p></div>`;
  return [
    panel(one, paragraphs(one?.paragraphs ?? [])),
    panel(two, `${schedule}<p data-model-role>${view.schedule.modelRole}</p>`),
    panel(three, `${paragraphs(three?.paragraphs ?? [])}<p>${view.lanesLines.paused}</p>`),
    panel(four, `${email}<pre><code>${view.reopenCommand}</code></pre>${paragraphs(four?.paragraphs ?? [])}<p>${view.lanesLines.reopened}</p>`),
  ];
}

export function replayTag(view: ReplayView = REPLAY_VIEW): string {
  const { tag } = view;
  return `<div data-wordcount="tag"><p>${tag.legend}</p><p>${tag.lane}</p><p>${tag.stamp}</p><dl><dt>Cause</dt><dd>${tag.cause}</dd><dt>Read back</dt><dd>${tag.replayReadBack}</dd><dt>Reopens</dt><dd>${tag.reopens}</dd></dl><p>${tag.number}</p></div>`;
}

export interface ReplayParts {
  readonly summary?: string;
  readonly panels?: readonly string[];
  readonly tag?: string;
  readonly caption?: string;
  readonly intro?: string;
  readonly extra?: string;
}

// The replay every replay rule passes, with any one part replaced.
export function replayBody(parts: ReplayParts = {}, view: ReplayView = REPLAY_VIEW): string {
  const caption = parts.caption ?? `<p data-wordcount="caption">${view.caption}</p>`;
  return `<main data-replay><h1>${view.h1}</h1>${parts.intro ?? `<p>${view.intro}</p>`}${parts.summary ?? replaySummary(view)}`
    + `<div>${parts.tag ?? replayTag(view)}${caption}</div>${(parts.panels ?? replayPanels(view)).join('')}${parts.extra ?? ''}</main>`;
}

// The six R14 type steps, each used once through var(), the way the shared sheet uses them.
export const TYPE_TOKEN_CSS = ['--text-lede', '--text-intro', '--text-narrative-headline', '--text-small', '--text-mono-value', '--text-schedule-compact']
  .map((name, index) => `.t${String(index)} { font-size: var(${name}); }`).join('\n');

const REPLAY_FILE = 'replay/index.html';

// A planted build every head, file, landing and replay rule passes, so a case can plant one fault
// and see only the rule it aims at fire. It always holds the replay page, as the real build does.
export function completeSite(bodies: Readonly<Record<string, string>>, heads: Readonly<Record<string, SheetHead>> = {}): Record<string, string> {
  const files: Record<string, string> = {};
  const paths: string[] = [];
  const withReplay = REPLAY_FILE in bodies ? bodies : { ...bodies, [REPLAY_FILE]: '' };
  for (const [file, body] of Object.entries(withReplay)) {
    const route = routeOf(file);
    const lead = route === '/' ? landingBody() : file === REPLAY_FILE ? replayBody() : '';
    files[file] = page(`${THEME_SWITCH}${lead}${body}`, sheetHead(route, heads[file]));
    if (route !== NOT_FOUND_ROUTE) paths.push(route);
  }
  return {
    ...files,
    'sitemap.xml': renderSitemap(paths.map((path) => ({ path, indexable: true }))),
    'robots.txt': renderRobots(),
    'tokens.css': renderTokensCss(),
    '_astro/site.css': TYPE_TOKEN_CSS,
    '_headers': HEADERS_TEXT,
  };
}
