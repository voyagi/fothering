import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NOT_FOUND_ROUTE, routeOf } from '../checks/built-site.js';
import type { DeployFacts, PrivacyFacts } from '../checks/rules.js';
import { loadPrivacyFacts } from '../harness/gates.js';
import {
  accessibilityStatements,
  FORGET_DOC,
  HAND_CHECK_CRITERIA,
  HAND_CHECK_RESULT_LABELS,
  LANDING_SECTIONS,
  LIMITS_FIXED_ROWS,
  LIMITS_REPLAY_ROW,
  NO_MEASURED_NUMBER_SENTENCE,
  NOT_YET_NOTICE,
  ONE_CALLER_SENTENCE,
  PERMISSION_COLUMNS,
  RESOURCE_COLUMNS,
  RESOURCE_REMOVAL,
  STORAGE_ENTRIES,
  type HandCheckCriterion,
  type LandingSectionId,
  type Statement,
} from '../site/content.js';
import { PROVENANCE_LABELS } from '../site/labels.js';
import { denyRows, hasPauseGrant, loadPermissionSnapshot, PERMISSION_REASONS, permissionKey, permissionSchedules } from '../site/permissions-view.js';
import { buildReplayView, loadReplayArtifact, type ReplayView } from '../site/replay-view.js';
import { loadRepoFacts, removedByText } from '../site/repo-facts.js';
import { loadResourceSnapshot, resourceRows } from '../site/resources-view.js';
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

// The deploy and privacy rules read the snapshots, the README, the package scripts, the stacks' Region
// pin, the forget doc and the model pin from the root they judge.
const DEPLOY_SOURCES = [
  'README.md', 'package.json', join('docs', 'adr', '0001-stack.md'), FORGET_DOC, join('packages', 'infra', 'permissions.json'), join('packages', 'infra', 'resources.json'),
  join('packages', 'infra', 'src', 'create-app.ts'),
];
// The model pin wins over the ADR row once the branch carries it, so a planted root copies it too.
const OPTIONAL_SOURCES = [join('packages', 'core', 'src', 'model-values.ts')];

export function plantDist(files: Readonly<Record<string, string | Buffer>>): PlantedDist {
  mkdirSync(CACHE, { recursive: true });
  const root = mkdtempSync(join(CACHE, 'fothering-built-'));
  const dist = join(root, 'packages', 'web', 'dist');
  mkdirSync(dist, { recursive: true });
  for (const source of [ARTIFACT_FILE, ...DEPLOY_SOURCES, ...OPTIONAL_SOURCES.filter((file) => existsSync(join(REPO_ROOT, file)))]) {
    mkdirSync(dirname(join(root, source)), { recursive: true });
    copyFileSync(join(REPO_ROOT, source), join(root, source));
  }
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
  readonly clock?: string;
  readonly extra?: string;
}

// The step clock as replay.astro renders it, its step text left out: the rule reads only the
// marker and the role.
export const REPLAY_CLOCK = '<p class="clock" role="status" data-replay-clock></p>';

// The replay every replay rule passes, with any one part replaced.
export function replayBody(parts: ReplayParts = {}, view: ReplayView = REPLAY_VIEW): string {
  const caption = parts.caption ?? `<p data-wordcount="caption">${view.caption}</p>`;
  return `<main data-replay><h1>${view.h1}</h1>${parts.intro ?? `<p>${view.intro}</p>`}${parts.summary ?? replaySummary(view)}`
    + `<div>${parts.tag ?? replayTag(view)}${caption}</div>${parts.clock ?? REPLAY_CLOCK}${(parts.panels ?? replayPanels(view)).join('')}${parts.extra ?? ''}</main>`;
}

// The six R14 type steps, each used once through var(), the way the shared sheet uses them.
export const TYPE_TOKEN_CSS = ['--text-lede', '--text-intro', '--text-narrative-headline', '--text-small', '--text-mono-value', '--text-schedule-compact']
  .map((name, index) => `.t${String(index)} { font-size: var(${name}); }`).join('\n');

// The deploy sources as the check context reads them from the repo root.
const REPO_FACTS = loadRepoFacts(REPO_ROOT);
export const DEPLOY_FACTS: DeployFacts = Object.freeze({
  permissions: loadPermissionSnapshot(REPO_ROOT),
  resources: loadResourceSnapshot(REPO_ROOT),
  reasons: PERMISSION_REASONS,
  commands: REPO_FACTS.deployCommands,
  scripts: REPO_FACTS.scripts,
});

// The committed snapshot without phase 3's account-level Denies and its pause grant, the state the
// site was built against before phase 3, so the no-Deny and NOT YET branches stay tested on purpose.
type SnapshotKeyFields = Parameters<typeof permissionKey>[0];
const BARE_PERMISSIONS = (DEPLOY_FACTS.permissions as SnapshotKeyFields[]).filter(
  (entry) => entry.effect !== 'Deny' && entry.action !== 'ses:PutConfigurationSetSendingOptions',
);
const BARE_KEYS = new Set(BARE_PERMISSIONS.map(permissionKey));
export const BARE_DEPLOY_FACTS: DeployFacts = Object.freeze({
  ...DEPLOY_FACTS,
  permissions: BARE_PERMISSIONS,
  reasons: Object.fromEntries(Object.entries(PERMISSION_REASONS).filter(([key]) => BARE_KEYS.has(key))),
});

const escapeHtml = (text: string): string => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const cell = (tag: 'th' | 'td', column: string, text: string): string => `<${tag} data-col="${column}">${escapeHtml(text)}</${tag}>`;

type PermissionRow = ReturnType<typeof permissionSchedules>[number]['rows'][number];

export function permissionRow(row: PermissionRow): string {
  const [kind = '', action = '', effect = '', resource = '', condition = '', why = ''] = PERMISSION_COLUMNS;
  return `<tr data-permission="${escapeHtml(permissionKey(row))}">${cell('th', kind, row.kind)}${cell('td', action, row.action)}${cell('td', effect, row.effect)}`
    + `${cell('td', resource, row.resourceOrPrincipal)}${cell('td', condition, row.condition)}${cell('td', why, row.reason)}</tr>`;
}

const roleNameOf = (row: PermissionRow): string => permissionKey(row).split('/')[1] ?? '';

// One section per role holding its Allow rows; Deny rows sit in the Deny box only, so each entry
// renders once (AC-33).
export function roleSections(facts: DeployFacts = DEPLOY_FACTS): string {
  return permissionSchedules(facts.permissions, facts.reasons).map((schedule) => {
    const allowed = schedule.rows.filter((row) => row.effect === 'Allow');
    const [first] = allowed;
    if (first === undefined) return '';
    const name = roleNameOf(first);
    return `<section data-permission-role="${schedule.stack}/${name}"><h3>${name}</h3><p>${schedule.stack}</p><table>${allowed.map(permissionRow).join('')}</table></section>`;
  }).join('');
}

export function denyBox(facts: DeployFacts = DEPLOY_FACTS): string {
  const rows = denyRows(facts.permissions, facts.reasons);
  return rows.length === 0 ? '' : `<div data-deny><h3>Denied</h3><table>${rows.map(permissionRow).join('')}</table></div>`;
}

export function resourceRow(row: ReturnType<typeof resourceRows>[number], removal: string): string {
  const [resource = '', what = '', stack = '', onRemoval = ''] = RESOURCE_COLUMNS;
  return `<tr data-resource="${row.stack}/${row.logicalId}">${cell('th', resource, row.logicalId)}${cell('td', what, row.noun)}${cell('td', stack, row.stack)}`
    + `${cell('td', onRemoval, row.deletedOnRemoval ? `${RESOURCE_REMOVAL.deleted} ${removal}` : RESOURCE_REMOVAL.kept)}</tr>`;
}

export function resourceTable(facts: DeployFacts = DEPLOY_FACTS): string {
  const removal = removedByText(facts.commands);
  return `<table>${resourceRows(facts.resources).map((row) => resourceRow(row, removal)).join('')}</table>`;
}

export const commandBlock = (lines: readonly string[]): string => `<pre><code>${lines.map(escapeHtml).join('\n')}</code></pre>`;

export interface DeployParts {
  readonly notice?: string;
  readonly commands?: string;
  readonly roles?: string;
  readonly deny?: string;
  readonly resources?: string;
  readonly oneCaller?: string;
  readonly extra?: string;
}

// The deploy page every deploy rule passes for the given sources, with any one part replaced.
export function deployBody(parts: DeployParts = {}, facts: DeployFacts = DEPLOY_FACTS): string {
  const notice = parts.notice ?? (hasPauseGrant(facts.permissions) ? '' : `<p data-notice><b>${NOT_YET_NOTICE.label}</b> ${NOT_YET_NOTICE.text}</p>`);
  const commands = parts.commands ?? commandBlock(facts.commands.map(({ command }) => command));
  return `<main><h1>Deploy</h1>${notice}${commands}${parts.resources ?? resourceTable(facts)}${parts.roles ?? roleSections(facts)}`
    + `<p>${parts.oneCaller ?? ONE_CALLER_SENTENCE}</p>${parts.deny ?? denyBox(facts)}${parts.extra ?? ''}</main>`;
}

// The privacy facts as the check context reads them from the repo root.
export const PRIVACY_FACTS: PrivacyFacts = loadPrivacyFacts(REPO_ROOT);

export function statementParagraph(statement: Statement): string {
  const link = statement.link === undefined ? '' : ` <a href="${statement.link}">Source</a>`;
  return `<p>${escapeHtml(statement.text)}${link}</p>`;
}

export function storedFieldRow(field: PrivacyFacts['storedFields'][number]): string {
  return `<tr data-stored-field="${field.path}"><th data-col="Field">${field.path}</th><td data-col="Identifies">${field.identifies}</td><td data-col="What is stored">${escapeHtml(field.row)}</td></tr>`;
}

export const rightsSentence = (rights: readonly string[]): string => `<p>You have the right of ${rights.map((right) => `<span data-right>${right}</span>`).join(', ')}.</p>`;

export function forgetSentence(forget: PrivacyFacts['forget']): string {
  return `<p>Run <code>${forget.command}</code> on the function the <code>${forget.output}</code> stack output names, as <code>${FORGET_DOC}</code> shows.</p>`;
}

export const modelRoleList = (statements: readonly Statement[]): string => `<ul data-model-role>${statements.map((statement) => `<li>${escapeHtml(statement.text)}</li>`).join('')}</ul>`;

export interface PrivacyParts {
  readonly statements?: string;
  readonly fields?: string;
  readonly forget?: string;
  readonly website?: string;
  readonly rights?: string;
  readonly storage?: string;
  readonly model?: string;
  readonly modelId?: string;
  readonly ai?: string;
  readonly extra?: string;
}

// The privacy and AI page every privacy and model-role rule passes, with any one part replaced.
export function privacyBody(parts: PrivacyParts = {}, facts: PrivacyFacts = PRIVACY_FACTS): string {
  const statements = parts.statements ?? facts.required.map(statementParagraph).join('');
  const fields = parts.fields ?? `<table>${facts.storedFields.map(storedFieldRow).join('')}</table>`;
  const website = parts.website ?? facts.website.map(statementParagraph).join('');
  const storage = parts.storage ?? `<p>${STORAGE_ENTRIES.map((entry) => `<code>${entry.key}</code>`).join(' and ')}</p>`;
  const ai = parts.ai ?? '<h2 id="ai">AI</h2>';
  const model = parts.model ?? modelRoleList(facts.modelRequired);
  const modelId = parts.modelId ?? `<p>Inference profile <code data-model-id>${facts.modelId}</code></p>`;
  return `<main><h1>Privacy and AI</h1><h2 id="privacy">Privacy</h2>${statements}${fields}${parts.forget ?? forgetSentence(facts.forget)}`
    + `<h3>This website</h3>${website}${parts.rights ?? rightsSentence(facts.rights)}${storage}${ai}${model}${modelId}${parts.extra ?? ''}</main>`;
}

export function handCheckRow(criterion: HandCheckCriterion): string {
  return `<tr data-criterion="${criterion.number}"><th>${criterion.number} ${escapeHtml(criterion.name)}</th>`
    + `<td>${HAND_CHECK_RESULT_LABELS[criterion.result]}</td><td>${escapeHtml(criterion.how)}</td></tr>`;
}

export interface AccessibilityParts {
  readonly statements?: string;
  readonly criteria?: string;
}

// The accessibility statement every statement rule passes, with either part replaced.
export function accessibilityBody(parts: AccessibilityParts = {}): string {
  const statements = parts.statements ?? accessibilityStatements().map(statementParagraph).join('');
  const criteria = parts.criteria ?? `<table>${HAND_CHECK_CRITERIA.map(handCheckRow).join('')}</table>`;
  return `<main><h1>Accessibility statement</h1>${statements}${criteria}</main>`;
}

const REPLAY_FILE = 'replay/index.html';
const DEPLOY_FILE = 'deploy/index.html';
export const PRIVACY_FILE = 'privacy-and-ai/index.html';
export const ACCESSIBILITY_FILE = 'accessibility/index.html';

function leadOf(file: string): string {
  if (routeOf(file) === '/') return landingBody();
  if (file === REPLAY_FILE) return replayBody();
  if (file === PRIVACY_FILE) return privacyBody();
  if (file === ACCESSIBILITY_FILE) return accessibilityBody();
  return file === DEPLOY_FILE ? deployBody() : '';
}

// A planted build every head, file, landing, replay, privacy, deploy and accessibility rule passes,
// so a case can plant one fault and see only the rule it aims at fire. It always holds the replay,
// privacy, deploy and accessibility pages, as the real build does.
export function completeSite(bodies: Readonly<Record<string, string>>, heads: Readonly<Record<string, SheetHead>> = {}): Record<string, string> {
  const files: Record<string, string> = {};
  const paths: string[] = [];
  const withSheets: Record<string, string> = { ...bodies };
  for (const sheet of [REPLAY_FILE, PRIVACY_FILE, DEPLOY_FILE, ACCESSIBILITY_FILE]) {
    if (!(sheet in withSheets)) withSheets[sheet] = '';
  }
  for (const [file, body] of Object.entries(withSheets)) {
    const route = routeOf(file);
    const lead = leadOf(file);
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
