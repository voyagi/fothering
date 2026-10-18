import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AXE_VERSION,
  DEV_BROWSER_VERSION,
  locateDevBrowser,
  runDriver,
  stageAxeSource,
  writeDriver,
  type DriverRun,
} from './dev-browser.js';
import { startPreviewServer, type PreviewServer } from './preview-server.js';
import { filesIn, loadBuiltSite, NoBuiltPagesError, routeOf, textOf, walk, type BuiltElement, type BuiltSite } from '../checks/built-site.js';
import { checkFileBudget, isRegisteredRule, runBuiltChecks, type BudgetViolation, type CheckContext, type Finding } from '../checks/rules.js';
import { BANNED_NAMES, CONSOLE_DELETE_PHRASES, REPLY_PROMISE_PHRASES, REPUTATION_PAGE_URL } from '../site/content.js';
import type { Provenance } from '@fothering/core/records';
import { PROVENANCE_LABELS } from '../site/labels.js';
import { buildReplayView, loadReplayArtifact } from '../site/replay-view.js';
import { ROUTES, SITE_ORIGIN, sitemapUrls } from '../site/route-list.js';
import { HEAD_SCRIPT, themedValue, TOKENS } from '../theme/head-script.js';

export interface ThemeSetup {
  readonly name: string;
  readonly stored: 'light' | 'dark' | null;
  readonly os: 'light' | 'dark';
}

// D-129 and D-131. Plan 05-14's accessibility record test compares against this object, so the
// audit and the published statement cannot drift apart.
export const AXE_CONFIG = Object.freeze({
  version: AXE_VERSION,
  tags: Object.freeze(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']),
  // Both are off by default in axe-core 4.14.0 (target-size carries "enabled": false), so the tags
  // alone never run them.
  enabledRules: Object.freeze(['target-size', 'label-content-name-mismatch']),
  widths: Object.freeze([320, 1440]),
  themes: Object.freeze<readonly ThemeSetup[]>([
    { name: 'light', stored: 'light', os: 'dark' },
    { name: 'dark', stored: 'dark', os: 'light' },
    { name: 'device', stored: null, os: 'dark' },
  ]),
});

export interface AcceptedIncomplete {
  readonly ruleId: string;
  // A regular expression over the node's axe target, so an entry covers named elements only.
  readonly targetPattern: string;
  readonly reason: string;
}

// An incomplete result is a check axe could not decide. Each one fails the audit unless it is
// listed here with a written reason; the matched counts print on every run.
export const ACCEPTED_INCOMPLETE: readonly AcceptedIncomplete[] = Object.freeze([
  {
    ruleId: 'color-contrast',
    // An SVG text element (axe names it by tag) or a drawing part (every drawing class starts dwg-).
    targetPattern: '^(?:text(?:$|[[.:#])|[.]dwg-)',
    reason: 'text inside the inline SVG drawings: axe-core cannot compute the background behind SVG text, and the drawings set it only in the ink and label colours on the sheet colour, the pairs the page text uses',
  },
]);

const isAccepted = (ruleId: string, target: string, accepted: readonly AcceptedIncomplete[]): boolean =>
  accepted.some((entry) => entry.ruleId === ruleId && new RegExp(entry.targetPattern).test(target));

export function countAccepted(incomplete: readonly AxeItem[], accepted: readonly AcceptedIncomplete[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of incomplete) {
    const matched = item.nodes.filter((node) => isAccepted(item.id, node.target, accepted)).length;
    if (matched > 0) counts.set(item.id, (counts.get(item.id) ?? 0) + matched);
  }
  return counts;
}

const VIEWPORT_HEIGHT = 900;
const DRIVER_TIMEOUT_SECONDS = 120;
const STDERR_TAIL = 400;

export type Verdict = { readonly ok: true } | { readonly ok: false; readonly reason: string };

export interface FocusStop {
  readonly domIndex: number;
  readonly tag: string;
  readonly radioGroup: string | null;
  readonly skipLink: boolean;
  readonly outlineStyle?: string;
  readonly outlineWidth?: string;
  readonly boxShadow?: string;
}

export interface KeyboardReport {
  readonly focusables: readonly FocusStop[];
  readonly positiveTabindex: readonly { readonly domIndex: number; readonly tag: string; readonly tabindex: string | null }[];
  readonly walk: readonly FocusStop[];
}

interface AxeItem {
  readonly id: string;
  readonly nodes: readonly { readonly target: string; readonly summary: string }[];
}

export interface AxeReport {
  readonly version: string;
  readonly selected: readonly string[];
  readonly ran: readonly string[];
  readonly violations: readonly AxeItem[];
  readonly incomplete: readonly AxeItem[];
}

export interface AuditLine {
  readonly route: string;
  readonly status: number;
  readonly theme?: ThemeReading;
  readonly axe?: AxeReport;
  readonly keyboard?: KeyboardReport;
  readonly overflow?: { readonly scrollWidth: number; readonly innerWidth: number };
}

const describeStop = (stop: FocusStop): string => `<${stop.tag}> at DOM index ${stop.domIndex}`;

// Every line the harness prints, in one place. None may contain the uppercase skip word:
// verify-ship repeats any such line under the step and refuses to let a PASS cover it.
export const A11Y_MESSAGES = Object.freeze({
  usage: () => '[site] usage: site-cli <a11y|e2e|built-checks|preview> --repo-root <dir> [--global-modules <dir>] [--dist <dir>] [--expect <id,id>] [--allow <id,id>]',
  unknownSubcommand: (name: string) => `[site] unknown subcommand "${name}"; expected a11y, e2e, built-checks or preview`,
  missingOption: (name: string) => `[site] ${name} is required`,
  previewListening: (url: string) => `[preview] serving ${url}/ on 127.0.0.1; press Ctrl+C to stop`,
  previewFailed: (message: string) => `[preview] the preview server did not start: ${message}`,
  noThemes: () => 'zero themes to audit, so the audit did not run',
  noWidths: () => 'zero widths to audit, so the audit did not run',
  noDist: (dist: string) => `${dist} does not exist; run npm run build first, so the audit did not run`,
  noRoutes: (dist: string) => `${dist} holds no built route (an .html file other than 404.html), so the audit did not run`,
  noNotFoundPage: (dist: string) => `${dist} holds no 404.html, so the unknown address has no page to show and the audit did not run`,
  noSitemap: (dist: string) => `${dist} holds no sitemap.xml to compare the built routes with, so the audit did not run`,
  sitemapDiffers: (builtOnly: readonly string[], sitemapOnly: readonly string[]) =>
    `the built routes and sitemap.xml differ: built only ${builtOnly.join(', ') || 'none'}; sitemap only ${sitemapOnly.join(', ') || 'none'}`,
  devBrowserMissing: (path: string) => `dev-browser ${DEV_BROWSER_VERSION} is not installed (looked for ${path}); install it with npm install -g dev-browser@${DEV_BROWSER_VERSION}`,
  devBrowserVersion: (found: string) => `dev-browser ${found} is installed, ${DEV_BROWSER_VERSION} expected`,
  axeMissing: (path: string) => `the axe-core source was not found at ${path}; run npm install from the repo root`,
  axeVersion: (found: string) => `axe-core ${found} is installed, ${AXE_VERSION} expected`,
  templateTokens: (path: string, tokens: number) => `${path} holds ${tokens} job token(s), exactly 1 expected`,
  templateMissing: (path: string) => `the driver template ${path} does not exist`,
  serverFailed: (message: string) => `the preview server did not start: ${message}`,
  driverTimedOut: (run: string) => `${run}: the driver run did not finish and was stopped by the outer timeout`,
  driverExit: (run: string, code: number | null, stderr: string) => `${run}: the driver run exited ${String(code)}${stderr === '' ? '' : `: ${stderr}`}`,
  noDone: (run: string) => `${run}: the driver run ended without its final done line`,
  malformedAudit: (run: string, text: string) => `${run}: an AUDIT line is not a valid audit record: ${text.slice(0, 120)}`,
  missingRoute: (run: string, route: string) => `${run}: no AUDIT line for ${route}, so it was not run`,
  status: (status: number, expected: number) => `the route answered ${status}, not ${expected}`,
  axeAbsent: () => 'the record carries no axe, keyboard or overflow result',
  axeVersionRan: (version: string) => `axe-core ${version} ran, ${AXE_VERSION} expected`,
  noSelectedRules: () => 'the five tags selected no axe rule',
  ruleNotSelected: (ruleId: string) => `${ruleId} is not among the rules the five tags select`,
  ruleNotRun: (ruleId: string) => `${ruleId} did not run`,
  violation: (id: string, nodes: number, target: string) => `axe violation ${id} on ${nodes} element(s), first ${target}`,
  incomplete: (id: string, nodes: number, target: string) => `axe incomplete ${id} on ${nodes} element(s), first ${target}, and ${id} is not on the accepted list`,
  overflow: (scrollWidth: number, viewportWidth: number) => `the page is ${scrollWidth} px wide in a ${viewportWidth} px viewport`,
  viewport: (innerWidth: number, width: number) => `the viewport measured ${innerWidth} px, ${width} px expected`,
  positiveTabindex: (count: number, first: string) => `${count} element(s) carry a positive tabindex, first ${first}`,
  noFocus: () => 'the first Tab focused nothing',
  firstNotSkipLink: (stop: string) => `the first Tab focused ${stop}, not the skip link`,
  radioStops: (group: string, stops: number) => `the radio group "${group}" took ${stops} Tab stops, 1 expected`,
  tabOrder: (expected: string, actual: string) => `Tab order ${actual} differs from DOM order ${expected}`,
  noIndicator: (stop: string) => `${stop} shows no visible focus indicator`,
  routePassed: (route: string, run: string, status: number, stops: number) => `[a11y] ${route} ${run}: ok, status ${status}, 0 violations, ${stops} Tab stop(s)`,
  routeFailed: (route: string, run: string, reasons: readonly string[]) => `[a11y] ${route} ${run}: failed: ${reasons.join('; ')}`,
  selectedRules: (ruleIds: readonly string[]) => `[a11y] the five tags select ${ruleIds.length} axe rule(s): ${ruleIds.join(', ')}`,
  acceptedNone: () => '[a11y] accepted incomplete list: empty, 0 matched',
  acceptedCount: (ruleId: string, count: number, reason: string) => `[a11y] accepted incomplete ${ruleId}: ${count} matched (${reason})`,
  pass: (routes: number, widths: number, themes: number, accepted: number) => `[a11y] PASS: ${routes} route(s) x ${widths} widths x ${themes} themes, 0 violations, ${accepted} accepted incomplete`,
  fail: (reason: string) => `[a11y] FAIL: ${reason}`,
  failCount: (failed: number, total: number, first: string) => `${failed} of ${total} audit(s) failed; first: ${first}`,
  tookHold: (run: string, ground: string, routes: number) => `[a11y] ${run}: the theme took hold, --ground ${ground} on ${routes} route(s)`,
  themeAbsent: () => 'the record carries no theme reading, so whether the theme took hold is unknown',
});

export type ThemeName = 'light' | 'dark';

export interface ThemeReading {
  readonly dataTheme: string | null;
  readonly ground: string;
}

// D-131: a theme took hold when the computed --ground is the token source's value for it, so the
// verdict reads the one source the stylesheet is generated from.
const groundFor = (theme: ThemeName): string => themedValue(TOKENS, '--ground', theme);

export function tookHoldVerdict(reading: ThemeReading, expected: ThemeName): Verdict {
  const wanted = groundFor(expected);
  return reading.ground === wanted ? { ok: true } : { ok: false, reason: E2E_MESSAGES.themeNotTaken(expected, reading.ground, wanted) };
}

export function storedThemeVerdict(reading: ThemeReading, stored: ThemeName): Verdict {
  if (reading.dataTheme !== stored) return { ok: false, reason: E2E_MESSAGES.themeAttribute(reading.dataTheme, stored) };
  return tookHoldVerdict(reading, stored);
}

// AC-42: Device is no attribute at all, and the two readings come from one page with the OS
// flipped in between, so only the CSS media block can have moved --ground.
export function deviceVerdict(dark: ThemeReading, light: ThemeReading): Verdict {
  const attribute = dark.dataTheme ?? light.dataTheme;
  if (attribute !== null) return { ok: false, reason: E2E_MESSAGES.deviceAttribute(attribute) };
  if (dark.ground === light.ground) return { ok: false, reason: E2E_MESSAGES.deviceStill(dark.ground) };
  const darkHeld = tookHoldVerdict(dark, 'dark');
  return darkHeld.ok ? tookHoldVerdict(light, 'light') : darkHeld;
}

// AC-E28: a stored Dark that equals the OS must still pin once the OS changes.
export function pinVerdict(before: ThemeReading, after: ThemeReading): Verdict {
  const held = storedThemeVerdict(before, 'dark');
  if (!held.ok) return held;
  return after.dataTheme === 'dark' && after.ground === groundFor('dark') ? { ok: true } : { ok: false, reason: E2E_MESSAGES.pinLost(after.dataTheme, after.ground) };
}

const CSP_REPORT = /Content Security Policy/i;

// C5: Chromium reports a blocked inline script or style only as a console error. Any other console
// error fails too, since nothing on these pages may throw or fail to load.
export function consoleVerdict(errors: readonly string[]): Verdict {
  const first = errors[0];
  if (first === undefined) return { ok: true };
  const csp = errors.find((text) => CSP_REPORT.test(text));
  return { ok: false, reason: csp === undefined ? E2E_MESSAGES.consoleError(first) : E2E_MESSAGES.cspViolation(csp) };
}

export interface ChosenTheme {
  readonly choice: string;
  readonly stored: string | null;
  readonly reloadedTheme: string | null;
  readonly reloadedChecked: string | null;
}

export interface SwitchReading {
  readonly route: string;
  readonly deviceStored: string | null;
  readonly chosen: readonly ChosenTheme[];
  readonly osFlip: { readonly light: string; readonly dark: string };
  readonly invalid: readonly { readonly stored: string; readonly checked: string | null }[];
  readonly domOrder: readonly string[];
  readonly boxOrders: readonly { readonly width: number; readonly order: readonly string[] }[];
  readonly arrow: { readonly before: string | null; readonly after: string | null };
}

export interface FontsReading {
  readonly route: string;
  readonly families: readonly { readonly family: string; readonly loaded: boolean; readonly check: boolean }[];
  readonly control: { readonly family: string; readonly present: boolean };
}

export interface RequestsReading {
  readonly route: string;
  readonly page: string;
  readonly requests: readonly string[];
}

export interface StorageReading {
  readonly local: readonly string[];
  readonly session: readonly string[];
}

export const SITE_FAMILIES = Object.freeze(['Red Hat Display', 'Red Hat Text', 'Red Hat Mono']);

const THEME_ORDER = ['device', 'light', 'dark'];
const PINNED_CHOICES = ['light', 'dark'];
// AC-E29 names these three stored values; each must leave Device checked.
const INVALID_STORED = ['blue', '', 'DARK'];
const STORAGE_KEYS: ReadonlySet<string> = new Set(['fothering-theme', 'fothering-flow']);

const verdictOf = (reasons: readonly string[]): Verdict => (reasons.length === 0 ? { ok: true } : { ok: false, reason: reasons.join('; ') });
const sameOrder = (order: readonly string[]): boolean => order.join(',') === THEME_ORDER.join(',');

function choiceReasons(chosen: readonly ChosenTheme[]): string[] {
  return PINNED_CHOICES.flatMap((choice) => {
    const entry = chosen.find((item) => item.choice === choice);
    if (entry === undefined) return [E2E_MESSAGES.choiceMissing(choice)];
    if (entry.stored !== choice) return [E2E_MESSAGES.choiceNotStored(choice, entry.stored)];
    return entry.reloadedTheme === choice && entry.reloadedChecked === choice ? [] : [E2E_MESSAGES.choiceNotKept(choice, entry.reloadedTheme, entry.reloadedChecked)];
  });
}

function orderReasons(reading: SwitchReading): string[] {
  const reasons = sameOrder(reading.domOrder) ? [] : [E2E_MESSAGES.domOrder(reading.domOrder)];
  if (reading.boxOrders.length === 0) return [...reasons, E2E_MESSAGES.noBoxOrder()];
  return [...reasons, ...reading.boxOrders.filter((box) => !sameOrder(box.order)).map((box) => E2E_MESSAGES.boxOrder(box.width, box.order))];
}

// AC-41, AC-E29, AC-E30: every way the switch can fail on one route is named, so one run shows them all.
export function switchVerdict(reading: SwitchReading): Verdict {
  const reasons: string[] = [];
  if (reading.deviceStored !== null) reasons.push(E2E_MESSAGES.deviceStored(reading.deviceStored));
  reasons.push(...choiceReasons(reading.chosen));
  const { light, dark } = reading.osFlip;
  if (light !== groundFor('light') || dark !== groundFor('dark')) reasons.push(E2E_MESSAGES.osNotFollowed(light, dark, groundFor('light'), groundFor('dark')));
  for (const value of INVALID_STORED) {
    const entry = reading.invalid.find((item) => item.stored === value);
    if (entry === undefined) reasons.push(E2E_MESSAGES.invalidMissing(value));
    else if (entry.checked !== 'device') reasons.push(E2E_MESSAGES.invalidChecked(value, entry.checked));
  }
  reasons.push(...orderReasons(reading));
  if (reading.arrow.before === reading.arrow.after) reasons.push(E2E_MESSAGES.arrowStill(reading.arrow.after));
  return verdictOf(reasons);
}

// D-135: check() can answer true for a family with no face at all, so a loaded face is required
// too, and a family the site never declares must read absent or the check proves nothing.
export function fontsVerdict(reading: FontsReading): Verdict {
  const reasons = SITE_FAMILIES.flatMap((family) => {
    const entry = reading.families.find((item) => item.family === family);
    if (entry === undefined) return [E2E_MESSAGES.fontMissing(family)];
    if (!entry.loaded) return [E2E_MESSAGES.fontNotLoaded(family)];
    return entry.check ? [] : [E2E_MESSAGES.fontCheckFalse(family)];
  });
  if (reading.control.present) reasons.push(E2E_MESSAGES.fontControl(reading.control.family));
  return verdictOf(reasons);
}

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

// AC-57 and AC-E52: origins compare as a sorted set, so the order requests arrive in never
// changes the verdict or its wording.
export function requestsVerdict(reading: RequestsReading): Verdict {
  if (reading.requests.length === 0) return { ok: false, reason: E2E_MESSAGES.noRequests() };
  const page = originOf(reading.page);
  const foreign = [...new Set(reading.requests.map(originOf))].filter((origin) => origin !== page).sort();
  return foreign.length === 0 ? { ok: true } : { ok: false, reason: E2E_MESSAGES.foreignRequest(page, foreign) };
}

// D-141: the two localStorage keys are the site's only stored state; sessionStorage holds none.
export function storageVerdict(reading: StorageReading): Verdict {
  const outside = [...reading.local.filter((key) => !STORAGE_KEYS.has(key)), ...reading.session.map((key) => `session:${key}`)];
  return outside.length === 0 ? { ok: true } : { ok: false, reason: E2E_MESSAGES.storageKeys(outside) };
}

export interface LinesReading {
  readonly route: string;
  readonly blocks: number;
  readonly lines: readonly string[];
}

const MAX_LINE_CHARACTERS = 80;
const GRAPHEMES = new Intl.Segmenter('en', { granularity: 'grapheme' });

// AC-E54: a character is a grapheme cluster, so an emoji or a letter with its combining mark is one.
export function graphemeCount(line: string): number {
  return [...GRAPHEMES.segment(line.trimEnd())].length;
}

// AC-64 and AC-E53: a run that measured no prose block proves nothing, so it fails.
export function lineVerdict(readings: readonly LinesReading[]): Verdict {
  if (readings.reduce((sum, reading) => sum + reading.blocks, 0) === 0) return { ok: false, reason: E2E_MESSAGES.noProseBlocks() };
  const reasons = readings.flatMap((reading) =>
    reading.lines.filter((line) => graphemeCount(line) > MAX_LINE_CHARACTERS).map((line) => E2E_MESSAGES.lineTooLong(reading.route, graphemeCount(line), line.trimEnd())));
  return verdictOf(reasons);
}

export interface IdentifierReading {
  readonly text: string;
  readonly lines: readonly string[];
}

// AC-E55: every line of an identifier but the last must end right after a dot.
export function identifierBreakVerdict(reading: IdentifierReading): Verdict {
  const lines = reading.lines.map((line) => line.trim());
  return lines.slice(0, -1).every((line) => line.endsWith('.')) ? { ok: true } : { ok: false, reason: E2E_MESSAGES.identifierBreak(reading.text, lines) };
}

export interface Box {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

export interface DrawingReading {
  readonly box: Box;
  readonly texts: readonly { readonly text: string; readonly box: Box }[];
}

export interface OverlapReading {
  readonly tag: Box | null;
  readonly drawings: readonly DrawingReading[];
}

// Boxes that only touch do not overlap; a text box may sit half a pixel past its drawing for
// sub-pixel rounding, and a whole pixel past it fails.
const overlaps = (first: Box, second: Box): boolean =>
  first.left < second.right && first.right > second.left && first.top < second.bottom && first.bottom > second.top;
const EDGE_TOLERANCE = 0.5;
const outside = (inner: Box, outer: Box): boolean =>
  inner.left < outer.left - EDGE_TOLERANCE || inner.top < outer.top - EDGE_TOLERANCE || inner.right > outer.right + EDGE_TOLERANCE || inner.bottom > outer.bottom + EDGE_TOLERANCE;

// AC-65: the hung tag covers no drawing text, and no drawing text leaves its drawing.
export function overlapVerdict(reading: OverlapReading): Verdict {
  const reasons = reading.drawings.flatMap((drawing) => drawing.texts.flatMap((text) => [
    ...(reading.tag !== null && overlaps(reading.tag, text.box) ? [E2E_MESSAGES.tagOverlap(text.text)] : []),
    ...(outside(text.box, drawing.box) ? [E2E_MESSAGES.textOutside(text.text)] : []),
  ]));
  return verdictOf(reasons);
}

export interface FlowControlBox {
  readonly label: string;
  readonly width: number;
  readonly height: number;
}

export interface FlowState {
  readonly running: number;
  readonly labels: readonly string[];
}

export interface FlowReading {
  readonly route: string;
  readonly width: number;
  readonly movingOnLoad: boolean;
  readonly controls: readonly FlowControlBox[];
  readonly afterClick: FlowState;
  readonly afterReload: FlowState;
  readonly reduced: number;
  readonly storedRunningReduced: number;
  readonly storedStopped: number;
}

const MIN_CONTROL = 44;
const RUN_FLOW = 'Run flow';

function stopReasons(reading: FlowReading): string[] {
  const { width, afterClick, afterReload } = reading;
  const reasons: string[] = [];
  if (afterClick.running > 0) reasons.push(E2E_MESSAGES.flowStillRunning(width, afterClick.running));
  if (afterClick.labels.length === 0 || afterClick.labels.some((label) => label !== RUN_FLOW)) reasons.push(E2E_MESSAGES.flowLabel(width, afterClick.labels));
  if (afterReload.running > 0) reasons.push(E2E_MESSAGES.flowReloadRuns(width, afterReload.running));
  return reasons;
}

// AC-43, AC-44, AC-E31, AC-E32 and WCAG 2.2.2. Whether a route moves is read from the page's running
// animations, never from a marker, so a moving drawing with no visible Stop flow cannot pass.
export function flowVerdict(reading: FlowReading): Verdict {
  const { width, movingOnLoad, controls } = reading;
  const reasons: string[] = [];
  if (movingOnLoad && controls.length === 0) reasons.push(E2E_MESSAGES.flowNoControl(width));
  if (!movingOnLoad && controls.length > 0) reasons.push(E2E_MESSAGES.flowControlWithoutMotion(width));
  for (const control of controls) {
    if (control.width < MIN_CONTROL || control.height < MIN_CONTROL) reasons.push(E2E_MESSAGES.flowSmallControl(width, control.width, control.height));
  }
  if (movingOnLoad && controls.length > 0) reasons.push(...stopReasons(reading));
  if (reading.reduced > 0) reasons.push(E2E_MESSAGES.flowReduced(width, reading.reduced));
  if (movingOnLoad && reading.storedRunningReduced === 0) reasons.push(E2E_MESSAGES.flowStoredRunning(width));
  if (reading.storedStopped > 0) reasons.push(E2E_MESSAGES.flowStoredStopped(width, reading.storedStopped));
  return verdictOf(reasons);
}

export interface FlowTabReading {
  readonly width: number;
  readonly flows: readonly { readonly flowStep: number | null; readonly nextStep: number | null }[];
}

// AC-E33: a Stop flow control is reached by Tab before the first focusable of the next section.
export function flowTabVerdict(reading: FlowTabReading): Verdict {
  const reasons = reading.flows.flatMap(({ flowStep, nextStep }) => {
    if (flowStep === null) return [E2E_MESSAGES.flowTabUnreached(reading.width)];
    return nextStep !== null && flowStep > nextStep ? [E2E_MESSAGES.flowTabLate(reading.width)] : [];
  });
  return verdictOf(reasons);
}

// The tag's stem is checked across the 5:7 range as well as at the audit widths, since the drawing
// is narrowest just above 960.
export const HANG_WIDTHS = Object.freeze([320, 961, 1280, 1440]);

export interface HangReading {
  readonly route: string;
  readonly width: number;
  readonly hanging: boolean;
  readonly visibleStem: number;
  readonly tagTop: number;
  readonly valveBottom: number;
}

const MIN_STEM = 12;

// UI-SPEC 8.1: the tag hangs from the closed valve's stem, so a clear stretch of stem shows between
// the valve and the card, and no corner of the tilted card reaches the valve.
export function hangVerdict(reading: HangReading): Verdict {
  if (!reading.hanging) return { ok: true };
  const reasons: string[] = [];
  if (reading.visibleStem < MIN_STEM) reasons.push(E2E_MESSAGES.tagStuck(reading.width, reading.visibleStem));
  if (reading.tagTop <= reading.valveBottom) reasons.push(E2E_MESSAGES.tagMeetsValve(reading.width));
  return verdictOf(reasons);
}

// AC-E5: every one of these must show step 1, the empty hash included.
export const REPLAY_INVALID_HASHES = Object.freeze(['#step-0', '#step-5', '#step-01', '#step-1x', '#step-', '']);
export const REPLAY_CONTROLS = Object.freeze(['Previous', 'Next', 'step 1', 'step 2', 'step 3', 'step 4']);

export interface StepMove {
  readonly before: number;
  readonly after: number;
}

// Steps are read as the one step panel shown, 0 when none or several show.
export interface ReplayReading {
  readonly route: string;
  readonly width: number;
  // The six control boxes on steps 1 to 4, in REPLAY_CONTROLS order, read at the top of the page.
  readonly boxes: readonly (readonly Box[])[];
  readonly afterNext: readonly number[];
  readonly afterFourth: number;
  // The step shown after activating each step button, 1 to 4.
  readonly buttons: readonly number[];
  readonly previousDisabledFirst: boolean;
  readonly nextDisabledLast: boolean;
  readonly deepLinks: readonly { readonly hash: string; readonly shown: number }[];
  readonly invalid: readonly { readonly hash: string; readonly shown: number }[];
  readonly sameStepMutations: number;
  readonly historyBefore: number;
  readonly historyAfter: number;
  readonly arrow: StepMove;
  readonly radio: StepMove;
  readonly modifiers: readonly (StepMove & { readonly modifier: string })[];
}

const BOX_TOLERANCE = 1;
const STEP_COUNT = 4;
const boxDelta = (first: Box, second: Box): number =>
  Math.max(Math.abs(first.left - second.left), Math.abs(first.top - second.top), Math.abs(first.right - second.right), Math.abs(first.bottom - second.bottom));

// AC-6: each control's box on steps 2 to 4 against its box on step 1.
function boxReasons(reading: ReplayReading): string[] {
  const { boxes, width } = reading;
  if (boxes.length !== STEP_COUNT || boxes.some((step) => step.length !== REPLAY_CONTROLS.length)) return [E2E_MESSAGES.replayBoxesMissing(width)];
  const [first = []] = boxes;
  return boxes.slice(1).flatMap((step, offset) => step.flatMap((controlBox, index) => {
    const reference = first[index];
    const delta = reference === undefined ? 0 : boxDelta(reference, controlBox);
    return delta > BOX_TOLERANCE ? [E2E_MESSAGES.replayBoxMoved(width, REPLAY_CONTROLS[index] ?? '', offset + 2, delta)] : [];
  }));
}

function loadReasons(width: number, readings: ReplayReading['deepLinks'], expected: readonly (readonly [string, number])[], message: (hash: string, shown: number) => string): string[] {
  const byHash = new Map(readings.map((item) => [item.hash, item.shown]));
  return expected.flatMap(([hash, step]) => {
    const shown = byHash.get(hash);
    if (shown === undefined) return [E2E_MESSAGES.replayDeepLinkMissing(width, hash)];
    return shown === step ? [] : [message(hash, shown)];
  });
}

function keyReasons(reading: ReplayReading): string[] {
  const { width, arrow, radio, modifiers } = reading;
  return [
    ...(arrow.after === arrow.before + 1 ? [] : [E2E_MESSAGES.replayArrow(width, arrow.before, arrow.after)]),
    ...(radio.after === radio.before ? [] : [E2E_MESSAGES.replayArrowRadio(width, radio.before, radio.after)]),
    ...modifiers.filter((item) => item.after !== item.before).map((item) => E2E_MESSAGES.replayArrowModifier(width, item.modifier, item.before, item.after)),
  ];
}

const DEEP_LINKS: readonly (readonly [string, number])[] = [1, 2, 3, 4].map((step) => [`#step-${String(step)}`, step] as const);

// AC-4, AC-6, AC-7, AC-10, AC-E5, AC-E6 and AC-E30, read from one real-browser run at one width.
export function replayVerdict(reading: ReplayReading): Verdict {
  const { width } = reading;
  const reasons: string[] = [];
  if (reading.afterNext.join(',') !== '2,3,4') reasons.push(E2E_MESSAGES.replayNext(width, reading.afterNext));
  if (reading.afterFourth !== STEP_COUNT) reasons.push(E2E_MESSAGES.replayFourth(width, reading.afterFourth));
  if (reading.buttons.join(',') !== '1,2,3,4') reasons.push(E2E_MESSAGES.replayButtons(width, reading.buttons));
  if (!reading.previousDisabledFirst) reasons.push(E2E_MESSAGES.replayPreviousEnabled(width));
  if (!reading.nextDisabledLast) reasons.push(E2E_MESSAGES.replayNextEnabled(width));
  reasons.push(...boxReasons(reading));
  reasons.push(...loadReasons(width, reading.deepLinks, DEEP_LINKS, (hash, shown) => E2E_MESSAGES.replayDeepLink(width, hash, shown)));
  reasons.push(...loadReasons(width, reading.invalid, REPLAY_INVALID_HASHES.map((hash) => [hash, 1] as const), (hash, shown) => E2E_MESSAGES.replayInvalidHash(width, hash, shown)));
  if (reading.sameStepMutations > 0) reasons.push(E2E_MESSAGES.replaySameStep(width, reading.sameStepMutations));
  if (reading.historyAfter !== reading.historyBefore) reasons.push(E2E_MESSAGES.replayHistory(width, reading.historyBefore, reading.historyAfter));
  reasons.push(...keyReasons(reading));
  return verdictOf(reasons);
}

export interface NoScriptReading {
  readonly route: string;
  readonly width: number;
  // The steps of the panels displayed, in DOM order.
  readonly panels: readonly string[];
  readonly controls: number;
  readonly boardParts: readonly { readonly steps: string; readonly displayed: boolean }[];
  readonly tagShown: boolean;
}

const PAUSED_STEP = '3';

// AC-10 and AC-E7: with the js class gone the stylesheet alone shows every panel in order, hides
// every step control, and holds the board at the paused step with its tag.
export function noScriptVerdict(reading: NoScriptReading): Verdict {
  const { width } = reading;
  const reasons: string[] = [];
  if (reading.panels.join(',') !== '1,2,3,4') reasons.push(E2E_MESSAGES.noScriptPanels(width, reading.panels));
  if (reading.controls > 0) reasons.push(E2E_MESSAGES.noScriptControls(width, reading.controls));
  if (reading.boardParts.length === 0) reasons.push(E2E_MESSAGES.noScriptNoBoard(width));
  for (const part of reading.boardParts) {
    if (part.displayed !== part.steps.split(' ').includes(PAUSED_STEP)) reasons.push(E2E_MESSAGES.noScriptBoard(width, part.steps, part.displayed));
  }
  if (!reading.tagShown) reasons.push(E2E_MESSAGES.noScriptTag(width));
  return verdictOf(reasons);
}

// The replay's layout where its two arrangements meet: the board stacks above the story at 960 px and
// below, sits beside it from 961 px up (where the story column is narrowest), and the log stacks at
// 620 px and below.
export const REPLAY_LAYOUT_WIDTHS = Object.freeze([320, 960, 961, 1024, 1280, 1440]);

export interface ReplayLayoutStep {
  readonly step: number;
  readonly boardHeight: number;
  // The tag's drawn place is rendered and visible on this step.
  readonly phantom: boolean;
}

export interface ReplayLayoutReading {
  readonly route: string;
  readonly width: number;
  readonly steps: readonly ReplayLayoutStep[];
  // Drawn tag places outside an aria-hidden subtree, so in the accessibility tree.
  readonly phantomExposed: number;
  // On step 2, the right edges of the evidence schedule and of the panel holding it.
  readonly evidence: { readonly tableRight: number; readonly panelRight: number } | null;
  // On step 4, with every row shown, the first baseline of each cell of each log row.
  readonly logRows: readonly { readonly header: string; readonly baselines: readonly number[] }[];
  // The computed weight of every identifier in step 2's schedule and in the log's mono cells.
  readonly identifiers: readonly { readonly text: string; readonly weight: string }[];
}

const STACKED_BOARD_WIDTH = 960;
const STACKED_LOG_WIDTH = 620;
const IDENTIFIER_WEIGHT = '500';
const spread = (values: readonly number[]): number => Math.max(...values) - Math.min(...values);

// UI-SPEC 10.3 and AC-6: stacked, the board keeps one height and the reserved slot draws where the
// tag will hang on every step but the paused one; beside the story the tag comes off and nothing
// marks its place.
function boardReasons(reading: ReplayLayoutReading): string[] {
  const { width, steps } = reading;
  if (steps.map((item) => item.step).join(',') !== '1,2,3,4') return [E2E_MESSAGES.layoutStepsMissing(width)];
  const stacked = width <= STACKED_BOARD_WIDTH;
  const heights = steps.map((item) => item.boardHeight);
  const reasons = stacked && spread(heights) > BOX_TOLERANCE ? [E2E_MESSAGES.layoutBoardHeight(width, heights)] : [];
  for (const { step, phantom } of steps) {
    const expected = stacked && String(step) !== PAUSED_STEP;
    if (expected && !phantom) reasons.push(E2E_MESSAGES.layoutPhantomMissing(width, step));
    if (!expected && phantom) reasons.push(E2E_MESSAGES.layoutPhantomShown(width, step));
  }
  if (reading.phantomExposed > 0) reasons.push(E2E_MESSAGES.layoutPhantomExposed(width, reading.phantomExposed));
  return reasons;
}

// UI-SPEC 6: the log's cells share their first baseline wherever the log is a table, and every
// identifier is set at weight 500, the tinted rows included.
function typeReasons(reading: ReplayLayoutReading): string[] {
  const { width, logRows, identifiers } = reading;
  const reasons: string[] = [];
  if (width > STACKED_LOG_WIDTH) {
    if (logRows.length === 0) reasons.push(E2E_MESSAGES.layoutLogMissing(width));
    for (const row of logRows) {
      if (row.baselines.length > 0 && spread(row.baselines) > BOX_TOLERANCE) reasons.push(E2E_MESSAGES.layoutBaseline(width, row.header, row.baselines));
    }
  }
  if (identifiers.length === 0) reasons.push(E2E_MESSAGES.layoutIdentifiersMissing(width));
  for (const { text, weight } of identifiers) {
    if (weight !== IDENTIFIER_WEIGHT) reasons.push(E2E_MESSAGES.layoutIdentifierWeight(width, text, weight));
  }
  return reasons;
}

export function replayLayoutVerdict(reading: ReplayLayoutReading): Verdict {
  const { width, evidence } = reading;
  const reasons = boardReasons(reading);
  if (evidence === null) reasons.push(E2E_MESSAGES.layoutEvidenceMissing(width));
  else if (evidence.tableRight > evidence.panelRight + EDGE_TOLERANCE) reasons.push(E2E_MESSAGES.layoutEvidenceSpill(width, evidence.tableRight, evidence.panelRight));
  reasons.push(...typeReasons(reading));
  return verdictOf(reasons);
}

const LANDING = '/';
const REPLAY = '/replay/';
const hasClass = (element: BuiltElement, name: string): boolean => (element.attrs.class ?? '').split(/\s+/).includes(name);

function elementsWhere(root: BuiltElement, test: (element: BuiltElement) => boolean): BuiltElement[] {
  const found: BuiltElement[] = [];
  walk(root, (element) => {
    if (test(element)) found.push(element);
  });
  return found;
}

// AC-14: the stamp on the landing tag and on the replay both follow the copy's provenance.
export function provenanceCopyVerdict(site: BuiltSite, stamp: string): Verdict {
  const reasons = [LANDING, REPLAY].flatMap((route) => {
    const built = site.pages.find((candidate) => candidate.route === route);
    const stamps = built === undefined ? [] : elementsWhere(built.root, (element) => hasClass(element, 'stamp')).map((element) => textOf(element));
    if (stamps.length === 0) return [E2E_MESSAGES.copyStampMissing(route)];
    return stamps.filter((text) => text !== stamp).map((text) => E2E_MESSAGES.copyStamp(route, text, stamp));
  });
  return verdictOf(reasons);
}

// AC-17: the copy's cause shows on the landing tag and in step 2, and the old value on no page.
export function causeCopyVerdict(site: BuiltSite, cause: { readonly oldValue: string; readonly newCause: string }): Verdict {
  const landing = site.pages.find((candidate) => candidate.route === LANDING);
  const replay = site.pages.find((candidate) => candidate.route === REPLAY);
  const tags = landing === undefined ? [] : elementsWhere(landing.root, (element) => element.attrs['data-tag'] !== undefined);
  const stepTwo = replay === undefined ? [] : elementsWhere(replay.root, (element) => element.attrs['data-wordcount'] === 'step' && element.attrs['data-steps'] === '2');
  const reasons: string[] = [];
  if (!tags.some((tag) => textOf(tag).includes(cause.newCause))) reasons.push(E2E_MESSAGES.copyCauseMissing('the landing tag', cause.newCause));
  if (!stepTwo.some((panel) => textOf(panel).includes(cause.newCause))) reasons.push(E2E_MESSAGES.copyCauseMissing(`${REPLAY} step 2`, cause.newCause));
  for (const built of site.pages) {
    if (built.text.includes(cause.oldValue)) reasons.push(E2E_MESSAGES.copyOldCause(built.route, cause.oldValue));
  }
  return verdictOf(reasons);
}

const NOT_FOUND_LOAD = /^Failed to load resource: the server responded with a status of 404\b/;

// Chromium logs the unknown address's own 404 as a console error; that answer is the 404 page
// working (AC-52), while a 404 for any other resource is a broken page.
export function isExpectedNotFound(record: { readonly text: string; readonly url: string }): boolean {
  if (!NOT_FOUND_LOAD.test(record.text)) return false;
  try {
    return new URL(record.url).pathname === UNKNOWN_PATH;
  } catch {
    return false;
  }
}

export function overflowVerdict(scrollWidth: number, viewportWidth: number): Verdict {
  return scrollWidth <= viewportWidth ? { ok: true } : { ok: false, reason: A11Y_MESSAGES.overflow(scrollWidth, viewportWidth) };
}

const stopKey = (stop: FocusStop): string => (stop.radioGroup === null ? `${stop.tag}#${stop.domIndex}` : `radio:${stop.radioGroup}`);

// A radio group is one Tab stop whichever radio holds it, so stops compare by group name.
function expectedStops(focusables: readonly FocusStop[]): string[] {
  const keys: string[] = [];
  for (const stop of focusables) {
    const key = stopKey(stop);
    if (stop.radioGroup !== null && keys.includes(key)) continue;
    keys.push(key);
  }
  return keys;
}

function hasVisibleIndicator(stop: FocusStop): boolean {
  const outline = stop.outlineStyle !== undefined && stop.outlineStyle !== 'none' && Number.parseFloat(stop.outlineWidth ?? '0') > 0;
  const shadow = stop.boxShadow !== undefined && stop.boxShadow !== 'none' && stop.boxShadow !== '';
  return outline || shadow;
}

export function keyboardVerdict(report: KeyboardReport): Verdict {
  const fail = (reason: string): Verdict => ({ ok: false, reason });
  const firstPositive = report.positiveTabindex[0];
  if (firstPositive !== undefined) return fail(A11Y_MESSAGES.positiveTabindex(report.positiveTabindex.length, `<${firstPositive.tag}> tabindex=${String(firstPositive.tabindex)}`));
  const first = report.walk[0];
  if (first === undefined) return fail(A11Y_MESSAGES.noFocus());
  if (!first.skipLink) return fail(A11Y_MESSAGES.firstNotSkipLink(describeStop(first)));
  const radioCounts = new Map<string, number>();
  for (const stop of report.walk) {
    if (stop.radioGroup !== null) radioCounts.set(stop.radioGroup, (radioCounts.get(stop.radioGroup) ?? 0) + 1);
  }
  for (const [group, stops] of radioCounts) {
    if (stops > 1) return fail(A11Y_MESSAGES.radioStops(group, stops));
  }
  const expected = expectedStops(report.focusables).join(' > ');
  const actual = report.walk.map(stopKey).join(' > ');
  if (expected !== actual) return fail(A11Y_MESSAGES.tabOrder(expected, actual));
  const bare = report.walk.find((stop) => !hasVisibleIndicator(stop));
  if (bare !== undefined) return fail(A11Y_MESSAGES.noIndicator(describeStop(bare)));
  return { ok: true };
}

export function axeReasons(axe: AxeReport, accepted: readonly AcceptedIncomplete[]): string[] {
  const reasons: string[] = [];
  if (axe.version !== AXE_VERSION) reasons.push(A11Y_MESSAGES.axeVersionRan(axe.version));
  if (axe.selected.length === 0) reasons.push(A11Y_MESSAGES.noSelectedRules());
  for (const ruleId of AXE_CONFIG.enabledRules) {
    if (axe.selected.length > 0 && !axe.selected.includes(ruleId)) reasons.push(A11Y_MESSAGES.ruleNotSelected(ruleId));
    if (!axe.ran.includes(ruleId)) reasons.push(A11Y_MESSAGES.ruleNotRun(ruleId));
  }
  for (const item of axe.violations) reasons.push(A11Y_MESSAGES.violation(item.id, item.nodes.length, item.nodes[0]?.target ?? 'no target'));
  for (const item of axe.incomplete) {
    const open = item.nodes.filter((node) => !isAccepted(item.id, node.target, accepted));
    if (open.length > 0) reasons.push(A11Y_MESSAGES.incomplete(item.id, open.length, open[0]?.target ?? 'no target'));
  }
  return reasons;
}

export function auditReasons(line: AuditLine, width: number, accepted: readonly AcceptedIncomplete[], expectedStatus = 200, expectedTheme: ThemeName = 'light'): string[] {
  if (line.status !== expectedStatus) return [A11Y_MESSAGES.status(line.status, expectedStatus)];
  if (line.axe === undefined || line.keyboard === undefined || line.overflow === undefined) return [A11Y_MESSAGES.axeAbsent()];
  const reasons: string[] = [];
  const held: Verdict = line.theme === undefined ? { ok: false, reason: A11Y_MESSAGES.themeAbsent() } : tookHoldVerdict(line.theme, expectedTheme);
  if (!held.ok) reasons.push(held.reason);
  reasons.push(...axeReasons(line.axe, accepted));
  if (line.overflow.innerWidth !== width) reasons.push(A11Y_MESSAGES.viewport(line.overflow.innerWidth, width));
  const overflow = overflowVerdict(line.overflow.scrollWidth, width);
  if (!overflow.ok) reasons.push(overflow.reason);
  const keyboard = keyboardVerdict(line.keyboard);
  if (!keyboard.ok) reasons.push(keyboard.reason);
  return reasons;
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;
const isStringList = (value: unknown): boolean => Array.isArray(value) && value.every((item) => typeof item === 'string');
const isItemList = (value: unknown): boolean => Array.isArray(value) && value.every((item) => isObject(item) && typeof item.id === 'string' && Array.isArray(item.nodes));
const isStopList = (value: unknown): boolean => Array.isArray(value) && value.every((item) => isObject(item) && typeof item.domIndex === 'number' && typeof item.tag === 'string');
const isReading = (value: unknown): value is ThemeReading =>
  isObject(value) && typeof value.ground === 'string' && (value.dataTheme === null || typeof value.dataTheme === 'string');

function isAxeReport(value: unknown): boolean {
  return isObject(value) && typeof value.version === 'string' && isStringList(value.selected) && isStringList(value.ran)
    && isItemList(value.violations) && isItemList(value.incomplete);
}

// The driver prints a bare route and status when a page answers other than expected, and the
// full record when it audited the page, whatever its status: the 404 page is audited at 404.
function isAuditLine(value: unknown): value is AuditLine {
  if (!isObject(value) || typeof value.route !== 'string' || typeof value.status !== 'number') return false;
  const { keyboard, overflow } = value;
  if (value.axe === undefined && keyboard === undefined && overflow === undefined) return true;
  return isAxeReport(value.axe) && (value.theme === undefined || isReading(value.theme))
    && isObject(keyboard) && isStopList(keyboard.focusables) && isStopList(keyboard.walk) && isStopList(keyboard.positiveTabindex)
    && isObject(overflow) && typeof overflow.scrollWidth === 'number' && typeof overflow.innerWidth === 'number';
}

// Every *.html under dist except 404.html is a route; Workers serves folder/index.html at /folder/
// and page.html at /page. Sorted, so the audit order and its output never depend on the disk.
export function routesFromDist(dist: string): string[] {
  const pages = filesIn(dist).filter((file) => file.endsWith('.html') && file !== '404.html' && !file.endsWith('/404.html'));
  // Sorted as routes, not file paths, so / leads and the driver pins the theme on the landing page.
  return pages.map(routeOf).sort();
}

interface RunResult {
  readonly failures: string[];
  readonly lines: Map<string, AuditLine>;
}

const printedLines = (run: DriverRun): string[] => run.stdoutLines.map((line) => line.trim()).filter((line) => line !== '');

// Both driver templates end with `done`, so a run that stopped early never reads as a pass.
function driverRunFailures(run: DriverRun, label: string, printed: readonly string[]): string[] {
  const failures: string[] = [];
  if (run.timedOut) failures.push(A11Y_MESSAGES.driverTimedOut(label));
  else if (run.exitCode !== 0) failures.push(A11Y_MESSAGES.driverExit(label, run.exitCode, run.stderr.trim().slice(-STDERR_TAIL)));
  if (printed.at(-1) !== 'done') failures.push(A11Y_MESSAGES.noDone(label));
  return failures;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function readRun(run: DriverRun, label: string): RunResult {
  const printed = printedLines(run);
  const failures = driverRunFailures(run, label, printed);
  const lines = new Map<string, AuditLine>();
  for (const text of printed) {
    if (!text.startsWith('AUDIT ')) continue;
    const parsed = parseJson(text.slice('AUDIT '.length));
    if (isAuditLine(parsed)) lines.set(parsed.route, parsed);
    else failures.push(A11Y_MESSAGES.malformedAudit(label, text));
  }
  return { failures, lines };
}

export interface A11yLiveOptions {
  readonly repoRoot: string;
  readonly globalModules: string;
  readonly homeDir: string;
  readonly print?: (line: string) => void;
  readonly themes?: readonly ThemeSetup[];
  readonly widths?: readonly number[];
  readonly templatePath?: string;
  readonly outerTimeoutMs?: number;
}

// D-131: the 404 page is audited where a visitor meets it, at an address no sheet has, because
// /404.html itself redirects under auto-trailing-slash.
export const UNKNOWN_PATH = '/no-such-sheet/';
const EXPECTED_STATUS: Readonly<Record<string, number>> = Object.freeze({ [UNKNOWN_PATH]: 404 });

interface Prepared {
  // The built routes, then the unknown path; the landing page leads so the driver pins the theme there.
  readonly audited: readonly string[];
  readonly launcher: string;
  readonly templatePath: string;
}

// Compared as sets (D-131), so a page built without its sitemap entry, or an entry with no page,
// stops the audit before any browser starts.
function sitemapDifference(dist: string, routes: readonly string[]): string | null {
  const sitemapPath = join(dist, 'sitemap.xml');
  if (!existsSync(sitemapPath)) return A11Y_MESSAGES.noSitemap(dist);
  const listed = new Set(sitemapUrls(readFileSync(sitemapPath, 'utf8')).map((url) => (url.startsWith(`${SITE_ORIGIN}/`) ? url.slice(SITE_ORIGIN.length) : url)));
  const built = new Set(routes);
  const builtOnly = routes.filter((route) => !listed.has(route));
  const sitemapOnly = [...listed].filter((route) => !built.has(route));
  return builtOnly.length === 0 && sitemapOnly.length === 0 ? null : A11Y_MESSAGES.sitemapDiffers(builtOnly, sitemapOnly);
}

function prepare(options: A11yLiveOptions, themes: readonly ThemeSetup[], widths: readonly number[]): Prepared | string {
  if (themes.length === 0) return A11Y_MESSAGES.noThemes();
  if (widths.length === 0) return A11Y_MESSAGES.noWidths();
  const dist = join(options.repoRoot, 'packages', 'web', 'dist');
  if (!existsSync(dist) || !statSync(dist).isDirectory()) return A11Y_MESSAGES.noDist(dist);
  const routes = routesFromDist(dist);
  if (routes.length === 0) return A11Y_MESSAGES.noRoutes(dist);
  if (!existsSync(join(dist, '404.html'))) return A11Y_MESSAGES.noNotFoundPage(dist);
  const difference = sitemapDifference(dist, routes);
  if (difference !== null) return difference;
  const driver = locateDriver(options.globalModules, options.templatePath ?? join(options.repoRoot, 'scripts', 'a11y.devbrowser.js'));
  if (typeof driver === 'string') return driver;
  return { audited: [...routes, UNKNOWN_PATH], ...driver };
}

// The launcher and the template both rendered checks need, each refused by name when absent.
function locateDriver(globalModules: string, templatePath: string): { readonly launcher: string; readonly templatePath: string } | string {
  const located = locateDevBrowser(globalModules);
  if (!located.ok) return located.reason === 'missing' ? A11Y_MESSAGES.devBrowserMissing(located.path) : A11Y_MESSAGES.devBrowserVersion(located.found);
  if (!existsSync(templatePath)) return A11Y_MESSAGES.templateMissing(templatePath);
  return { launcher: located.launcher, templatePath };
}

type Served<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly reason: string };

// One preview server over the repo's dist under its _headers, so every rendered check runs under
// the production CSP, and one scratch folder for the written drivers; both are gone afterwards.
async function withPreview<T>(repoRoot: string, prefix: string, body: (server: PreviewServer, workDir: string) => Promise<T>): Promise<Served<T>> {
  const workDir = mkdtempSync(join(tmpdir(), prefix));
  let server: PreviewServer | undefined;
  try {
    try {
      server = await startPreviewServer({
        distDir: join(repoRoot, 'packages', 'web', 'dist'),
        wranglerConfigPath: join(repoRoot, 'packages', 'web', 'wrangler.jsonc'),
      });
    } catch (error) {
      return { ok: false, reason: A11Y_MESSAGES.serverFailed((error as Error).message) };
    }
    return { ok: true, value: await body(server, workDir) };
  } finally {
    await server?.close();
    rmSync(workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

interface AuditContext {
  readonly prepared: Prepared;
  readonly server: PreviewServer;
  readonly axeFile: string;
  readonly workDir: string;
  readonly print: (line: string) => void;
  readonly accepted: Map<string, number>;
  readonly selected: Set<string>;
  readonly outerTimeoutMs: number | undefined;
}

async function auditOne(context: AuditContext, theme: ThemeSetup, width: number): Promise<{ failures: string[]; audits: number }> {
  const label = `${theme.name} ${width}px`;
  const job = {
    base: context.server.url,
    routes: context.prepared.audited,
    expectedStatus: EXPECTED_STATUS,
    width,
    height: VIEWPORT_HEIGHT,
    theme: theme.name,
    storedTheme: theme.stored,
    osScheme: theme.os,
    axeFile: context.axeFile,
    tags: AXE_CONFIG.tags,
    rules: AXE_CONFIG.enabledRules,
  };
  const written = writeDriver(context.prepared.templatePath, job, join(context.workDir, `a11y-${theme.name}-${width}.js`));
  if (!written.ok) {
    const failure = A11Y_MESSAGES.templateTokens(context.prepared.templatePath, written.tokens);
    context.print(`[a11y] ${failure}`);
    return { failures: [failure], audits: 0 };
  }
  const run = await runDriver({
    launcher: context.prepared.launcher,
    driverPath: written.path,
    timeoutSeconds: DRIVER_TIMEOUT_SECONDS,
    ...(context.outerTimeoutMs === undefined ? {} : { outerTimeoutMs: context.outerTimeoutMs }),
  });
  const { failures, lines } = readRun(run, label);
  for (const route of context.prepared.audited) {
    if (!lines.has(route)) failures.push(A11Y_MESSAGES.missingRoute(label, route));
  }
  for (const failure of failures) context.print(`[a11y] ${failure}`);
  // D-131's three runs: light and dark are pinned by storage against the other OS scheme, and
  // device stores nothing, so it expects whatever scheme the OS reports.
  const expectedTheme: ThemeName = theme.stored ?? theme.os;
  let held = 0;
  for (const [route, line] of lines) {
    for (const ruleId of line.axe?.selected ?? []) context.selected.add(ruleId);
    for (const [ruleId, count] of countAccepted(line.axe?.incomplete ?? [], ACCEPTED_INCOMPLETE)) {
      context.accepted.set(ruleId, (context.accepted.get(ruleId) ?? 0) + count);
    }
    if (line.theme !== undefined && tookHoldVerdict(line.theme, expectedTheme).ok) held += 1;
    const reasons = auditReasons(line, width, ACCEPTED_INCOMPLETE, EXPECTED_STATUS[route] ?? 200, expectedTheme);
    if (reasons.length === 0) {
      context.print(A11Y_MESSAGES.routePassed(route, label, line.status, line.keyboard?.walk.length ?? 0));
    } else {
      context.print(A11Y_MESSAGES.routeFailed(route, label, reasons));
      failures.push(`${route} ${label}: ${reasons.join('; ')}`);
    }
  }
  if (held === context.prepared.audited.length) context.print(A11Y_MESSAGES.tookHold(label, groundFor(expectedTheme), held));
  return { failures, audits: context.prepared.audited.length };
}

async function auditAll(context: AuditContext, themes: readonly ThemeSetup[], widths: readonly number[]): Promise<number> {
  const failures: string[] = [];
  let audits = 0;
  for (const theme of themes) {
    for (const width of widths) {
      const result = await auditOne(context, theme, width);
      failures.push(...result.failures);
      audits += result.audits;
    }
  }
  const { print, accepted, selected } = context;
  print(A11Y_MESSAGES.selectedRules([...selected].sort()));
  if (ACCEPTED_INCOMPLETE.length === 0) print(A11Y_MESSAGES.acceptedNone());
  for (const entry of ACCEPTED_INCOMPLETE) print(A11Y_MESSAGES.acceptedCount(entry.ruleId, accepted.get(entry.ruleId) ?? 0, entry.reason));
  const first = failures[0];
  if (first !== undefined) {
    print(A11Y_MESSAGES.fail(A11Y_MESSAGES.failCount(failures.length, audits, first)));
    return 1;
  }
  const matched = [...accepted.values()].reduce((sum, count) => sum + count, 0);
  print(A11Y_MESSAGES.pass(context.prepared.audited.length, widths.length, themes.length, matched));
  return 0;
}

export async function runA11yLive(options: A11yLiveOptions): Promise<number> {
  const print = options.print ?? ((line: string) => console.log(line));
  const themes = options.themes ?? AXE_CONFIG.themes;
  const widths = options.widths ?? AXE_CONFIG.widths;
  const prepared = prepare(options, themes, widths);
  if (typeof prepared === 'string') {
    print(A11Y_MESSAGES.fail(prepared));
    return 1;
  }
  const staged = stageAxeSource(options.repoRoot, options.homeDir);
  if (!staged.ok) {
    print(A11Y_MESSAGES.fail(staged.reason === 'missing' ? A11Y_MESSAGES.axeMissing(staged.path) : A11Y_MESSAGES.axeVersion(staged.found)));
    return 1;
  }
  try {
    const served = await withPreview(options.repoRoot, 'fothering-a11y-', (server, workDir) => {
      const accepted = new Map(ACCEPTED_INCOMPLETE.map((entry) => [entry.ruleId, 0]));
      const context: AuditContext = { prepared, server, axeFile: staged.name, workDir, print, accepted, selected: new Set<string>(), outerTimeoutMs: options.outerTimeoutMs };
      return auditAll(context, themes, widths);
    });
    if (served.ok) return served.value;
    print(A11Y_MESSAGES.fail(served.reason));
    return 1;
  } finally {
    staged.remove();
  }
}

export const E2E_MESSAGES = Object.freeze({
  step: (name: string) => `[e2e] step ${name}: ok`,
  fail: (reason: string) => `[e2e] FAIL: ${reason}`,
  pass: (pages: number, steps: number) => `[e2e] PASS: ${steps} step(s) ok over ${pages} built page(s)`,
  noDist: (dist: string) => `${dist} does not exist; run npm run build first, so the e2e step did not run`,
  noPages: (dist: string) => `${dist} holds no built HTML page, so the built checks did not run`,
  finding: (rule: string, route: string, text: string) => `[built-checks] ${rule} ${route}: ${text}`,
  findings: (count: number, first: string) => `the built checks reported ${count} finding(s); first: ${first}`,
  checksPass: (pages: number) => `[built-checks] PASS: ${pages} built page(s), 0 findings`,
  expectPass: (pages: number) => `[built-checks] PASS: ${pages} built page(s), every finding expected or allowed and every expected rule found`,
  checksFail: (reason: string) => `[built-checks] FAIL: ${reason}`,
  unregistered: (id: string) => `${id} is not a registered rule`,
  unexpected: (id: string, count: number) => `${count} finding(s) of rule ${id}, which is neither expected nor allowed`,
  expectedMissing: (id: string) => `rule ${id} is expected and has no finding`,
  clientSecrets: (code: number | null) => `the client-secret scan exited ${String(code)}, 0 expected`,
  tooManyFiles: (count: number, limit: number) => `the built output holds ${count} files, fewer than ${limit} allowed`,
  fileTooLarge: (path: string, bytes: number, limit: number) => `${path} is ${bytes} bytes, under ${limit} allowed`,
  secondBuildFailed: (code: number | null, tail: string) => `the second build exited ${String(code)}${tail === '' ? '' : `: ${tail}`}`,
  buildDiffers: (file: string) => `${file} differs between the two builds of one commit`,
  buildMissing: (file: string, folder: string) => `${file} is missing from ${folder}`,
  themeNotTaken: (expected: string, found: string, wanted: string) => `the ${expected} theme did not take hold: --ground read ${found === '' ? 'empty' : found}, ${wanted} expected`,
  themeAttribute: (found: string | null, wanted: string) => `data-theme read ${found ?? 'absent'}, ${wanted} expected`,
  deviceAttribute: (found: string) => `Device left data-theme ${found} on the root, and Device sets none`,
  deviceStill: (ground: string) => `--ground stayed ${ground} when the OS turned from dark to light`,
  pinLost: (dataTheme: string | null, ground: string) => `the stored Dark did not hold after the OS turned light: data-theme ${dataTheme ?? 'absent'}, --ground ${ground}`,
  cspViolation: (text: string) => `the page reported a Content Security Policy violation: ${text.slice(0, 200)}`,
  consoleError: (text: string) => `the page logged a console error: ${text.slice(0, 200)}`,
  renderedOk: (check: string, detail: string) => `[e2e] rendered ${check}: ok, ${detail}`,
  renderedFailed: (check: string, reason: string) => `[e2e] rendered ${check}: failed: ${reason}`,
  renderedMissing: (check: string) => `the driver printed no ${check} line, so the check did not run`,
  renderedMalformed: (text: string) => `the line is not a valid record: ${text.slice(0, 120)}`,
  renderedFailures: (count: number, first: string) => `${count} rendered check(s) failed; first: ${first}`,
  renderedMissingRoute: (check: string, route: string) => `the driver printed no ${check} line for ${route}, so the check did not run there`,
  deviceStored: (stored: string) => `choosing Device left fothering-theme ${stored} stored, and Device stores nothing`,
  choiceMissing: (choice: string) => `the switch run never chose ${choice}`,
  choiceNotStored: (choice: string, stored: string | null) => `choosing ${choice} stored ${stored ?? 'nothing'}, ${choice} expected`,
  choiceNotKept: (choice: string, theme: string | null, checked: string | null) =>
    `the ${choice} choice did not survive a reload: data-theme ${theme ?? 'absent'}, ${checked ?? 'no'} radio checked`,
  osNotFollowed: (light: string, dark: string, wantedLight: string, wantedDark: string) =>
    `with Device chosen, --ground read ${light} on a light OS and ${dark} on a dark OS, ${wantedLight} and ${wantedDark} expected`,
  invalidMissing: (value: string) => `the switch run never tried the stored value ${JSON.stringify(value)}`,
  invalidChecked: (value: string, checked: string | null) => `a stored ${JSON.stringify(value)} left the ${checked ?? 'no'} radio checked, device expected`,
  domOrder: (order: readonly string[]) => `the theme radios sit ${order.join(', ') || 'nowhere'} in DOM order; device, light, dark expected`,
  boxOrder: (width: number, order: readonly string[]) => `at ${width} px the theme radios sit ${order.join(', ') || 'nowhere'} left to right; device, light, dark expected`,
  noBoxOrder: () => 'the switch run measured no box order, so the visual order is unknown',
  arrowStill: (theme: string | null) => `ArrowRight inside the theme group left data-theme ${theme ?? 'absent'}`,
  fontMissing: (family: string) => `document.fonts holds no ${family} face`,
  fontNotLoaded: (family: string) => `no ${family} face has loaded`,
  fontCheckFalse: (family: string) => `document.fonts.check is false for ${family}`,
  fontControl: (family: string) => `the undeclared control family ${family} reads present, so the font check proves nothing`,
  noRequests: () => 'the page recorded no request, so where its requests went is unknown',
  foreignRequest: (page: string, origins: readonly string[]) => `request(s) left the page's origin ${page}: ${origins.join(', ')}`,
  storageKeys: (keys: readonly string[]) => `storage holds ${keys.join(', ')}; only fothering-theme and fothering-flow in localStorage are allowed`,
  sizeLimit: (status: number | null) => `size-limit exited ${String(status)}, 0 expected; the client scripts are over the budget in packages/web/package.json or were not measured`,
  noProseBlocks: () => 'the line test measured zero prose blocks across the site, so no line was checked',
  lineTooLong: (route: string, characters: number, line: string) => `${route}: a rendered line holds ${characters} characters, at most 80 allowed: "${line.slice(0, 60)}"`,
  identifierBreak: (text: string, lines: readonly string[]) => `the identifier ${text} breaks as ${lines.map((line) => JSON.stringify(line)).join(' / ')}, and may break only right after a dot`,
  tagOverlap: (text: string) => `the lockout tag covers the drawing text "${text}"`,
  textOutside: (text: string) => `the drawing text "${text}" extends past its drawing's box`,
  noDrawingText: () => 'no route measured a drawing text at 320, so the tag and label check proved nothing',
  flowNoControl: (width: number) => `at ${width} px a flow animation runs on load and no Stop flow control is visible`,
  flowControlWithoutMotion: (width: number) => `at ${width} px a Stop flow control is visible and no flow animation runs on load`,
  flowSmallControl: (width: number, controlWidth: number, controlHeight: number) => `at ${width} px a Stop flow control measures ${controlWidth} by ${controlHeight} px, 44 by 44 at least`,
  flowStillRunning: (width: number, running: number) => `at ${width} px ${running} flow animation(s) still run after every Stop flow control was used`,
  flowLabel: (width: number, labels: readonly string[]) => `at ${width} px the flow controls read ${labels.join(', ') || 'nothing'} after the stop, Run flow expected`,
  flowReloadRuns: (width: number, running: number) => `at ${width} px the stopped flow runs again after a reload (${running} running animation(s))`,
  flowReduced: (width: number, running: number) => `at ${width} px ${running} flow animation(s) run under reduced motion with no stored choice`,
  flowStoredRunning: (width: number) => `at ${width} px a stored running choice runs no flow under reduced motion`,
  flowStoredStopped: (width: number, running: number) => `at ${width} px a stored stopped choice leaves ${running} flow animation(s) running`,
  flowTabUnreached: (width: number) => `at ${width} px Tab never reaches a visible Stop flow control`,
  flowTabLate: (width: number) => `at ${width} px Tab reaches a Stop flow control after the next section's first focusable element`,
  copyBuildPassed: () => 'the project copy with an artifact whose provenance is measured built, and a broken artifact must fail the build',
  copyBuildUnnamed: (tail: string) => `the project copy with a broken artifact failed without naming the artifact file and its events or provenance field: ${tail}`,
  copyBuildLeft: (folder: string) => `the project copy folder ${folder} is still on disk after the build`,
  tagStuck: (width: number, stem: number) => `at ${width} px the lockout tag shows ${stem} px of stem below the closed valve, 12 at least, so it reads as stuck, not hung`,
  tagMeetsValve: (width: number) => `at ${width} px the lockout tag's tilted top edge reaches the closed valve`,
  noHungTag: () => 'no route hung a lockout tag from a closed valve, so the stem check measured nothing',
  replayNext: (width: number, shown: readonly number[]) => `at ${width} px three Next activations from step 1 showed ${shown.join(', ') || 'nothing'}; 2, 3, 4 expected`,
  replayFourth: (width: number, shown: number) => `at ${width} px a fourth Next activation from step 1 showed step ${shown}, 4 expected`,
  replayButtons: (width: number, shown: readonly number[]) => `at ${width} px the four step buttons showed ${shown.join(', ') || 'nothing'}; 1, 2, 3, 4 expected`,
  replayPreviousEnabled: (width: number) => `at ${width} px Previous is enabled on step 1`,
  replayNextEnabled: (width: number) => `at ${width} px Next is enabled on step 4`,
  replayBoxesMissing: (width: number) => `at ${width} px the run did not measure all six control boxes on all four steps`,
  replayBoxMoved: (width: number, control: string, step: number, delta: number) => `at ${width} px the ${control} box moves ${delta} px on step ${step}, 1 at most`,
  replayDeepLink: (width: number, hash: string, shown: number) => `at ${width} px loading ${hash} showed step ${shown}`,
  replayDeepLinkMissing: (width: number, hash: string) => `at ${width} px the run never loaded ${JSON.stringify(hash)}`,
  replayInvalidHash: (width: number, hash: string, shown: number) => `at ${width} px loading ${JSON.stringify(hash)} showed step ${shown}, 1 expected`,
  replaySameStep: (width: number, count: number) => `at ${width} px a hashchange to the shown step changed ${count} node(s)`,
  replayHistory: (width: number, before: number, after: number) => `at ${width} px stepping changed history.length from ${before} to ${after}`,
  replayArrow: (width: number, before: number, after: number) => `at ${width} px ArrowRight on a step button went from step ${before} to ${after}, one step on expected`,
  replayArrowRadio: (width: number, before: number, after: number) => `at ${width} px ArrowRight in the theme radios moved the replay from step ${before} to ${after}`,
  replayArrowModifier: (width: number, modifier: string, before: number, after: number) => `at ${width} px ${modifier}+ArrowRight moved the replay from step ${before} to ${after}`,
  noScriptPanels: (width: number, panels: readonly string[]) => `at ${width} px with the js class removed the panels shown read ${panels.join(', ') || 'none'}; 1, 2, 3, 4 expected`,
  noScriptControls: (width: number, count: number) => `at ${width} px with the js class removed ${count} step control(s) still show`,
  noScriptBoard: (width: number, steps: string, displayed: boolean) => `at ${width} px with the js class removed the board part for steps ${steps} is ${displayed ? 'shown' : 'hidden'}, against the paused step`,
  noScriptNoBoard: (width: number) => `at ${width} px with the js class removed the run measured no board part`,
  noScriptTag: (width: number) => `at ${width} px with the js class removed the lockout tag does not show`,
  layoutStepsMissing: (width: number) => `at ${width} px the layout run did not measure the board on all four steps`,
  layoutBoardHeight: (width: number, heights: readonly number[]) => `at ${width} px the board measures ${heights.join(', ')} px tall on steps 1 to 4, one height within 1 px expected`,
  layoutPhantomMissing: (width: number, step: number) => `at ${width} px the reserved tag slot shows no drawn place for the tag on step ${step}`,
  layoutPhantomShown: (width: number, step: number) => `at ${width} px the tag's drawn place shows on step ${step}, where the board ${step === 3 ? 'hangs the tag itself' : 'reserves no slot'}`,
  layoutPhantomExposed: (width: number, count: number) => `at ${width} px ${count} drawn tag place(s) sit outside aria-hidden, in the accessibility tree`,
  layoutEvidenceMissing: (width: number) => `at ${width} px the run measured no evidence schedule on step 2`,
  layoutEvidenceSpill: (width: number, tableRight: number, panelRight: number) => `at ${width} px the step 2 evidence schedule ends at x ${tableRight}, past its panel's edge at x ${panelRight}`,
  layoutLogMissing: (width: number) => `at ${width} px the run measured no event log row`,
  layoutBaseline: (width: number, header: string, baselines: readonly number[]) => `at ${width} px the log row ${header} sets its cells on baselines ${baselines.join(', ')}, one baseline within 1 px expected`,
  layoutIdentifiersMissing: (width: number) => `at ${width} px the run measured no identifier in the evidence schedule or the log`,
  layoutIdentifierWeight: (width: number, text: string, weight: string) => `at ${width} px the identifier ${text} computes weight ${weight}, 500 expected`,
  copyStampMissing: (route: string) => `${route} carries no provenance stamp in the project copy`,
  copyStamp: (route: string, found: string, expected: string) => `the stamp on ${route} reads ${found}, ${expected} expected for the copy's provenance`,
  copyCauseMissing: (where: string, cause: string) => `${where} does not show the copy's cause ${cause}`,
  copyOldCause: (route: string, value: string) => `${route} still shows the old cause value ${value}`,
  copyVariantFailed: (id: string, status: number | null, tail: string) => `the ${id} project copy build exited ${String(status)}${tail === '' ? '' : `: ${tail}`}`,
  copyVariantUnjudged: (id: string) => `the ${id} project copy built and nothing judged it`,
});

export interface SecondBuildRun {
  readonly status: number | null;
  readonly output: string;
}

const OUTPUT_TAIL = 400;
// sitemap.xml and robots.txt arrive with a later plan and are compared once they exist.
const COMPARED_FILES = new Set(['sitemap.xml', 'robots.txt']);

function comparedFiles(folder: string): Set<string> {
  if (!existsSync(folder)) return new Set();
  return new Set(filesIn(folder).filter((file) => file.endsWith('.html') || COMPARED_FILES.has(file)));
}

export function compareBuilds(first: string, second: string): string[] {
  const firstFiles = comparedFiles(first);
  const secondFiles = comparedFiles(second);
  const reasons: string[] = [];
  for (const file of firstFiles) {
    if (!secondFiles.has(file)) reasons.push(E2E_MESSAGES.buildMissing(file, second));
  }
  for (const file of secondFiles) {
    if (!firstFiles.has(file)) reasons.push(E2E_MESSAGES.buildMissing(file, first));
  }
  for (const file of firstFiles) {
    if (secondFiles.has(file) && !readFileSync(join(first, file)).equals(readFileSync(join(second, file)))) reasons.push(E2E_MESSAGES.buildDiffers(file));
  }
  return reasons;
}

// The one place the rules' context is built, so the e2e step and the built-checks subcommand can
// never judge the same build differently.
export function loadCheckContext(repoRoot: string): CheckContext {
  const artifact = loadReplayArtifact(join(repoRoot, 'packages', 'web'));
  return Object.freeze({
    repoRoot,
    reputationPageUrl: REPUTATION_PAGE_URL,
    replyPromisePhrases: REPLY_PROMISE_PHRASES,
    consoleDeletePhrases: CONSOLE_DELETE_PHRASES,
    bannedNames: BANNED_NAMES,
    siteOrigin: SITE_ORIGIN,
    routes: ROUTES,
    headScript: HEAD_SCRIPT,
    provenance: artifact.provenance,
    replay: buildReplayView(artifact),
  });
}

type Judged = { readonly ok: true; readonly pages: number; readonly findings: readonly Finding[] } | { readonly ok: false; readonly reason: string };

function judgeBuiltSite(dist: string, repoRoot: string): Judged {
  if (!existsSync(dist) || !statSync(dist).isDirectory()) return { ok: false, reason: E2E_MESSAGES.noDist(dist) };
  let site: BuiltSite;
  try {
    site = loadBuiltSite(dist);
  } catch (error) {
    if (error instanceof NoBuiltPagesError) return { ok: false, reason: E2E_MESSAGES.noPages(dist) };
    throw error;
  }
  return { ok: true, pages: site.pages.length, findings: runBuiltChecks(site, loadCheckContext(repoRoot)) };
}

const findingLine = (finding: Finding): string => E2E_MESSAGES.finding(finding.rule, finding.route, finding.text);

export function judgeExpectation(findings: readonly Finding[], expect: readonly string[] | undefined, allow: readonly string[] | undefined): string[] {
  const named = [...(expect ?? []), ...(allow ?? [])];
  const unregistered = named.filter((id) => !isRegisteredRule(id));
  if (unregistered.length > 0) return unregistered.map((id) => E2E_MESSAGES.unregistered(id));
  if (expect === undefined && allow === undefined) {
    const first = findings[0];
    return first === undefined ? [] : [E2E_MESSAGES.findings(findings.length, findingLine(first))];
  }
  const counts = new Map<string, number>();
  for (const finding of findings) counts.set(finding.rule, (counts.get(finding.rule) ?? 0) + 1);
  const accepted = new Set(named);
  const reasons: string[] = [];
  for (const [id, count] of counts) {
    if (!accepted.has(id)) reasons.push(E2E_MESSAGES.unexpected(id, count));
  }
  for (const id of expect ?? []) {
    if (!counts.has(id)) reasons.push(E2E_MESSAGES.expectedMissing(id));
  }
  return reasons;
}

export interface BuiltChecksOptions {
  readonly repoRoot: string;
  readonly dist: string;
  readonly expect?: readonly string[] | undefined;
  readonly allow?: readonly string[] | undefined;
  readonly print?: (line: string) => void;
}

export function runBuiltChecksCommand(options: BuiltChecksOptions): number {
  const print = options.print ?? ((line: string) => console.log(line));
  const failWith = (reasons: readonly string[]): number => {
    for (const reason of reasons) print(E2E_MESSAGES.checksFail(reason));
    return 1;
  };
  // Ids are checked before the build is read, so a typo in a later plan's tracer never reads as a
  // missing finding.
  const unregistered = [...(options.expect ?? []), ...(options.allow ?? [])].filter((id) => !isRegisteredRule(id));
  if (unregistered.length > 0) return failWith(unregistered.map((id) => E2E_MESSAGES.unregistered(id)));
  const judged = judgeBuiltSite(options.dist, options.repoRoot);
  if (!judged.ok) return failWith([judged.reason]);
  for (const finding of judged.findings) print(findingLine(finding));
  const reasons = judgeExpectation(judged.findings, options.expect, options.allow);
  if (reasons.length > 0) return failWith(reasons);
  print(options.expect === undefined && options.allow === undefined ? E2E_MESSAGES.checksPass(judged.pages) : E2E_MESSAGES.expectPass(judged.pages));
  return 0;
}

export interface SiteE2eOptions {
  readonly repoRoot: string;
  // The rendered step drives dev-browser from the global npm folder.
  readonly globalModules: string;
  readonly print?: (line: string) => void;
  readonly clientSecretsScript?: string;
  readonly fileBudget?: (files: readonly { readonly path: string; readonly bytes: number }[]) => BudgetViolation[];
  readonly secondBuild?: (outDir: string) => SecondBuildRun;
  readonly sizeLimit?: () => SizeRun;
  readonly brokenArtifactBuild?: () => CopyBuildRun;
  readonly provenanceCopyBuild?: () => CopyBuildRun;
  readonly causeCopyBuild?: () => CopyBuildRun;
}

export interface SizeRun {
  readonly status: number | null;
  readonly output: string;
}

const printOutput = (print: (line: string) => void, output: string): void => {
  for (const line of output.split(/\r?\n/)) {
    if (line.trim() !== '') print(line);
  }
};

// Any exit other than 0 fails the step, exit 2 included: that is the scan saying it could not run,
// and a scan that did not run never passes a build (AC-60, AC-E50).
function clientSecretsStep(script: string, dist: string, print: (line: string) => void): string | null {
  const run = spawnSync(process.execPath, [script, dist], { encoding: 'utf8', shell: false });
  printOutput(print, `${run.stdout ?? ''}${run.stderr ?? ''}`);
  return run.status === 0 ? null : E2E_MESSAGES.clientSecrets(run.status);
}

function fileBudgetStep(dist: string, budget: NonNullable<SiteE2eOptions['fileBudget']>): string | null {
  const files = filesIn(dist).map((path) => ({ path, bytes: statSync(join(dist, path)).size }));
  const reasons = budget(files).map((violation) =>
    violation.kind === 'count' ? E2E_MESSAGES.tooManyFiles(violation.count, violation.limit) : E2E_MESSAGES.fileTooLarge(violation.path, violation.bytes, violation.limit));
  return reasons.length === 0 ? null : reasons.join('; ');
}

// The same commit built a second time with Astro's --outDir, into the git-ignored root dist folder.
function astroSecondBuild(repoRoot: string): (outDir: string) => SecondBuildRun {
  return (outDir) => {
    const run = spawnSync(process.execPath, [join(repoRoot, 'scripts', 'astro.mjs'), 'build', '--outDir', outDir], {
      cwd: join(repoRoot, 'packages', 'web'),
      encoding: 'utf8',
      shell: false,
      maxBuffer: 64 * 1024 * 1024,
    });
    return { status: run.status, output: `${run.stdout ?? ''}${run.stderr ?? ''}${run.error === undefined ? '' : run.error.message}` };
  };
}

function secondBuildStep(options: SiteE2eOptions, dist: string): string | null {
  const outDir = join(options.repoRoot, 'dist', 'site-second-build');
  const remove = (): void => rmSync(outDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  remove();
  try {
    const run = (options.secondBuild ?? astroSecondBuild(options.repoRoot))(outDir);
    if (run.status !== 0) return E2E_MESSAGES.secondBuildFailed(run.status, run.output.trim().slice(-OUTPUT_TAIL));
    const reasons = compareBuilds(dist, outDir);
    return reasons.length === 0 ? null : reasons.join('; ');
  } finally {
    remove();
  }
}

export interface CopyBuildOptions {
  readonly repoRoot: string;
  // A file inside the web project, by its path from packages/web, and the text it is replaced with.
  readonly swap: { readonly path: string; readonly text: string };
  readonly id?: string;
  // Judges the copy's built site before the folder is removed.
  readonly inspect?: (site: BuiltSite) => Verdict;
}

export interface CopyBuildRun {
  readonly status: number | null;
  readonly output: string;
  readonly folder: string;
  readonly verdict?: Verdict;
}

// What a project copy needs to build. The copy sits in the git-ignored root dist folder, at the
// depth of packages/web, so relative paths and the walk up to node_modules resolve as they do there.
const PROJECT_FILES = ['astro.config.mjs', 'package.json', 'tsconfig.json', 'public', 'src'];

export function copyBuild(options: CopyBuildOptions): CopyBuildRun {
  const folder = join(options.repoRoot, 'dist', `site-copy-${options.id ?? String(process.pid)}`);
  const remove = (): void => rmSync(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  remove();
  try {
    for (const item of PROJECT_FILES) cpSync(join(options.repoRoot, 'packages', 'web', item), join(folder, item), { recursive: true });
    writeFileSync(join(folder, options.swap.path), options.swap.text);
    const run = spawnSync(process.execPath, [join(options.repoRoot, 'scripts', 'astro.mjs'), 'build'], {
      cwd: folder,
      encoding: 'utf8',
      shell: false,
      maxBuffer: 64 * 1024 * 1024,
    });
    const output = `${run.stdout ?? ''}${run.stderr ?? ''}${run.error === undefined ? '' : run.error.message}`;
    const judged = run.status === 0 && options.inspect !== undefined ? { verdict: options.inspect(loadBuiltSite(join(folder, 'dist'))) } : {};
    return { status: run.status, output, folder, ...judged };
  } finally {
    remove();
  }
}

const BROKEN_ARTIFACT = 'src/fixtures/replay-incident.json';
const NAMES_ARTIFACT = /replay-incident\.json: events\[\d+\]|replay-incident\.json:[^\n]*\bprovenance\b/;

// AC-12 and AC-E10: the committed artifact with its first event's provenance set to a value the
// schema lacks must stop the site build, and the build must say which file and field.
function realBrokenArtifactBuild(repoRoot: string): () => CopyBuildRun {
  return () => {
    const artifact = JSON.parse(readFileSync(join(repoRoot, 'packages', 'web', BROKEN_ARTIFACT), 'utf8')) as { events: { provenance: string }[] };
    const [first] = artifact.events;
    if (first !== undefined) first.provenance = 'measured';
    return copyBuild({ repoRoot, swap: { path: BROKEN_ARTIFACT, text: `${JSON.stringify(artifact, null, 2)}\n` }, id: 'broken-artifact' });
  };
}

interface ArtifactJson {
  provenance: string;
  events: { provenance: string }[];
  cause: { key: string; value: string };
}

const readArtifactText = (repoRoot: string): string => readFileSync(join(repoRoot, 'packages', 'web', BROKEN_ARTIFACT), 'utf8');
const SIMULATOR: Provenance = 'simulator-captured';
// A cause value no fixture holds, so the old value can be looked for on every built page.
const COPY_CAUSE_VALUE = 'import-2031-01-01-z';

// AC-14: the artifact and every event relabelled simulator-captured.
function realProvenanceCopy(repoRoot: string): () => CopyBuildRun {
  return () => {
    const artifact = JSON.parse(readArtifactText(repoRoot)) as ArtifactJson;
    artifact.provenance = SIMULATOR;
    for (const event of artifact.events) event.provenance = SIMULATOR;
    const { stamp } = PROVENANCE_LABELS[SIMULATOR];
    return copyBuild({ repoRoot, swap: { path: BROKEN_ARTIFACT, text: `${JSON.stringify(artifact, null, 2)}\n` }, id: 'provenance', inspect: (site) => provenanceCopyVerdict(site, stamp) });
  };
}

// AC-17: every occurrence of the cause value replaced, so the cause, the evidence subject, the event
// details and the agent paragraph stay one consistent incident.
function realCauseCopy(repoRoot: string): () => CopyBuildRun {
  return () => {
    const text = readArtifactText(repoRoot);
    const { cause } = JSON.parse(text) as ArtifactJson;
    const swapped = text.split(cause.value).join(COPY_CAUSE_VALUE);
    const newCause = `${cause.key}=${COPY_CAUSE_VALUE}`;
    return copyBuild({ repoRoot, swap: { path: BROKEN_ARTIFACT, text: swapped }, id: 'cause', inspect: (site) => causeCopyVerdict(site, { oldValue: cause.value, newCause }) });
  };
}

function copyVariantStep(id: string, build: () => CopyBuildRun): string | null {
  const run = build();
  if (existsSync(run.folder)) return E2E_MESSAGES.copyBuildLeft(run.folder);
  if (run.status !== 0) return E2E_MESSAGES.copyVariantFailed(id, run.status, run.output.trim().slice(-OUTPUT_TAIL));
  if (run.verdict === undefined) return E2E_MESSAGES.copyVariantUnjudged(id);
  return run.verdict.ok ? null : run.verdict.reason;
}

function copyBuildStep(options: SiteE2eOptions, print: (line: string) => void): string | null {
  const run = (options.brokenArtifactBuild ?? realBrokenArtifactBuild(options.repoRoot))();
  const named = run.output.split(/\r?\n/).filter((line) => NAMES_ARTIFACT.test(line));
  for (const line of named) print(line);
  if (existsSync(run.folder)) return E2E_MESSAGES.copyBuildLeft(run.folder);
  if (run.status === 0) return E2E_MESSAGES.copyBuildPassed();
  return named.length > 0 ? null : E2E_MESSAGES.copyBuildUnnamed(run.output.trim().slice(-OUTPUT_TAIL));
}

const RENDERED_LABEL = 'rendered';
const RENDERED_CHECKS = ['THEME', 'DEVICE', 'PIN'] as const;
type RenderedCheck = (typeof RENDERED_CHECKS)[number];
type CheckJudgement = { readonly verdict: Verdict; readonly detail: string } | null;

// Each check line's record, judged once its shape is known; null means the line is not a record.
const RENDERED_JUDGES: Readonly<Record<RenderedCheck, (value: unknown) => CheckJudgement>> = {
  THEME: (value) => (isReading(value) ? { verdict: storedThemeVerdict(value, 'dark'), detail: `Dark stored on a light OS painted --ground ${value.ground}` } : null),
  DEVICE: (value) => (isObject(value) && isReading(value.dark) && isReading(value.light)
    ? { verdict: deviceVerdict(value.dark, value.light), detail: `--ground followed the OS from ${value.dark.ground} to ${value.light.ground} with no reload` }
    : null),
  PIN: (value) => (isObject(value) && isReading(value.before) && isReading(value.after)
    ? { verdict: pinVerdict(value.before, value.after), detail: `Dark stored on a dark OS kept --ground ${value.after.ground} after the OS turned light` }
    : null),
};

function judgeCheck(check: RenderedCheck, text: string | undefined): { verdict: Verdict; detail: string } {
  if (text === undefined) return { verdict: { ok: false, reason: E2E_MESSAGES.renderedMissing(check) }, detail: '' };
  const judged = RENDERED_JUDGES[check](parseJson(text.slice(check.length + 1)));
  return judged ?? { verdict: { ok: false, reason: E2E_MESSAGES.renderedMalformed(text) }, detail: '' };
}

const isNullableString = (value: unknown): boolean => value === null || typeof value === 'string';
const isOrder = (value: unknown): boolean => isObject(value) && typeof value.width === 'number' && isStringList(value.order);

function isSwitchReading(value: unknown): value is SwitchReading {
  if (!isObject(value) || !isNullableString(value.deviceStored) || !isObject(value.osFlip) || !isObject(value.arrow)) return false;
  const { chosen, invalid, osFlip, arrow } = value;
  return Array.isArray(chosen) && chosen.every((item) => isObject(item) && typeof item.choice === 'string' && isNullableString(item.stored) && isNullableString(item.reloadedTheme) && isNullableString(item.reloadedChecked))
    && typeof osFlip.light === 'string' && typeof osFlip.dark === 'string'
    && Array.isArray(invalid) && invalid.every((item) => isObject(item) && typeof item.stored === 'string' && isNullableString(item.checked))
    && isStringList(value.domOrder) && Array.isArray(value.boxOrders) && value.boxOrders.every(isOrder)
    && isNullableString(arrow.before) && isNullableString(arrow.after);
}

const isFontsReading = (value: unknown): value is FontsReading => isObject(value) && Array.isArray(value.families)
  && value.families.every((item) => isObject(item) && typeof item.family === 'string' && typeof item.loaded === 'boolean' && typeof item.check === 'boolean')
  && isObject(value.control) && typeof value.control.family === 'string' && typeof value.control.present === 'boolean';
const isRequestsReading = (value: unknown): value is RequestsReading => isObject(value) && typeof value.page === 'string' && isStringList(value.requests);
const isStorageReading = (value: unknown): value is StorageReading => isObject(value) && isStringList(value.local) && isStringList(value.session);

const ROUTE_CHECKS = ['SWITCH', 'FONTS', 'REQUESTS'] as const;
// Measured over every route: the flow and Tab walk at both widths, prose lines at 1440, the tag and
// drawing labels at 320.
const MEASURE_CHECKS = ['FLOW', 'TABFLOW', 'LINES', 'NARROW', 'HANG'] as const;
const REPLAY_CHECKS = ['REPLAY', 'NOSCRIPT', 'LAYOUT'] as const;
type ReplayCheck = (typeof REPLAY_CHECKS)[number];
// dev-browser 0.2.9's newPage takes no context options, so JavaScript cannot be turned off for one
// page; the CSS reads only the root's js class, so removing it is the same reading (05-11 context).
const NO_SCRIPT_METHOD = 'js class removed, the page API has no JavaScript switch';
type RouteCheck = (typeof ROUTE_CHECKS)[number];

const ROUTE_JUDGES: Readonly<Record<RouteCheck, (value: unknown) => Verdict | null>> = {
  SWITCH: (value) => (isSwitchReading(value) ? switchVerdict(value) : null),
  FONTS: (value) => (isFontsReading(value) ? fontsVerdict(value) : null),
  REQUESTS: (value) => (isRequestsReading(value) ? requestsVerdict(value) : null),
};

function routeDetail(check: RouteCheck, routes: readonly string[], requests: number): string {
  const where = routes.join(', ');
  if (check === 'SWITCH') return `Device removes the key, Light and Dark persist, invalid values leave Device, order and ArrowRight hold on ${where}`;
  if (check === 'FONTS') return `${SITE_FAMILIES.join(', ')} loaded from the site and the control family absent on ${where}`;
  return `${requests} request(s), every one from the page's own origin, on ${where}`;
}

// One verdict per route-wide check: each expected route needs its own line, and every failing
// route is named in the one failure line.
function judgeRouteCheck(check: RouteCheck, lines: readonly string[], routes: readonly string[]): { verdict: Verdict; detail: string } {
  const byRoute = new Map<string, unknown>();
  const reasons: string[] = [];
  let requests = 0;
  for (const text of lines) {
    const value = parseJson(text.slice(check.length + 1));
    if (isObject(value) && typeof value.route === 'string') byRoute.set(value.route, value);
    else reasons.push(E2E_MESSAGES.renderedMalformed(text));
  }
  for (const route of routes) {
    const value = byRoute.get(route);
    if (value === undefined) {
      reasons.push(E2E_MESSAGES.renderedMissingRoute(check, route));
      continue;
    }
    const verdict = ROUTE_JUDGES[check](value);
    if (verdict === null) reasons.push(E2E_MESSAGES.renderedMalformed(`${check} ${JSON.stringify(value)}`));
    else if (!verdict.ok) reasons.push(`${route}: ${verdict.reason}`);
    if (check === 'REQUESTS' && isRequestsReading(value)) requests += value.requests.length;
  }
  return { verdict: verdictOf(reasons), detail: routeDetail(check, routes, requests) };
}

function judgeStorage(text: string | undefined): { verdict: Verdict; detail: string } {
  if (text === undefined) return { verdict: { ok: false, reason: E2E_MESSAGES.renderedMissing('STORAGE') }, detail: '' };
  const value = parseJson(text.slice('STORAGE '.length));
  if (!isStorageReading(value)) return { verdict: { ok: false, reason: E2E_MESSAGES.renderedMalformed(text) }, detail: '' };
  const keys = [...value.local, ...value.session.map((key) => `session:${key}`)];
  return { verdict: storageVerdict(value), detail: `keys after using the switch: ${keys.join(', ') || 'none'}` };
}

const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const isBox = (value: unknown): value is Box => isObject(value) && isNumber(value.left) && isNumber(value.top) && isNumber(value.right) && isNumber(value.bottom);
const isFlowState = (value: unknown): value is FlowState => isObject(value) && isNumber(value.running) && isStringList(value.labels);
const isLinesReading = (value: unknown): value is LinesReading => isObject(value) && typeof value.route === 'string' && isNumber(value.blocks) && isStringList(value.lines);
const isDrawing = (value: unknown): value is DrawingReading => isObject(value) && isBox(value.box)
  && Array.isArray(value.texts) && value.texts.every((text) => isObject(text) && typeof text.text === 'string' && isBox(text.box));
const isIdentifier = (value: unknown): value is IdentifierReading => isObject(value) && typeof value.text === 'string' && isStringList(value.lines);

interface NarrowReading extends OverlapReading {
  readonly route: string;
  readonly identifiers: readonly IdentifierReading[];
}

const isNarrowReading = (value: unknown): value is NarrowReading => isObject(value) && typeof value.route === 'string' && (value.tag === null || isBox(value.tag))
  && Array.isArray(value.drawings) && value.drawings.every(isDrawing) && Array.isArray(value.identifiers) && value.identifiers.every(isIdentifier);
const isFlowReading = (value: unknown): value is FlowReading => isObject(value) && typeof value.route === 'string' && isNumber(value.width)
  && typeof value.movingOnLoad === 'boolean' && Array.isArray(value.controls)
  && value.controls.every((control) => isObject(control) && typeof control.label === 'string' && isNumber(control.width) && isNumber(control.height))
  && isFlowState(value.afterClick) && isFlowState(value.afterReload) && isNumber(value.reduced) && isNumber(value.storedRunningReduced) && isNumber(value.storedStopped);
const isFlowTabReading = (value: unknown): value is FlowTabReading & { readonly route: string } => isObject(value) && typeof value.route === 'string' && isNumber(value.width)
  && Array.isArray(value.flows) && value.flows.every((flow) => isObject(flow) && (flow.flowStep === null || isNumber(flow.flowStep)) && (flow.nextStep === null || isNumber(flow.nextStep)));

type CheckResult = { verdict: Verdict; detail: string };

// Parses a check's lines into a map by key, naming every malformed line.
function readKeyed<T>(check: string, lines: readonly string[], accept: (value: unknown) => value is T, keyOf: (value: T) => string): { byKey: Map<string, T>; reasons: string[] } {
  const byKey = new Map<string, T>();
  const reasons: string[] = [];
  for (const text of lines) {
    const value = parseJson(text.slice(check.length + 1));
    if (accept(value)) byKey.set(keyOf(value), value);
    else reasons.push(E2E_MESSAGES.renderedMalformed(text));
  }
  return { byKey, reasons };
}

const widthKey = (route: string, width: number): string => `${route} at ${String(width)} px`;

function judgeLines(lines: readonly string[], routes: readonly string[]): CheckResult {
  const { byKey, reasons } = readKeyed('LINES', lines, isLinesReading, (value) => value.route);
  const readings: LinesReading[] = [];
  for (const route of routes) {
    const reading = byKey.get(route);
    if (reading === undefined) reasons.push(E2E_MESSAGES.renderedMissingRoute('LINES', route));
    else readings.push(reading);
  }
  const verdict = lineVerdict(readings);
  if (!verdict.ok) reasons.push(verdict.reason);
  const blocks = readings.reduce((sum, reading) => sum + reading.blocks, 0);
  const longest = Math.max(0, ...readings.flatMap((reading) => reading.lines.map(graphemeCount)));
  return { verdict: verdictOf(reasons), detail: `${blocks} prose block(s) measured at 1440 px, the longest line ${longest} characters` };
}

function judgeNarrow(lines: readonly string[], routes: readonly string[]): CheckResult {
  const { byKey, reasons } = readKeyed('NARROW', lines, isNarrowReading, (value) => value.route);
  let texts = 0;
  let identifiers = 0;
  for (const route of routes) {
    const reading = byKey.get(route);
    if (reading === undefined) {
      reasons.push(E2E_MESSAGES.renderedMissingRoute('NARROW', route));
      continue;
    }
    texts += reading.drawings.reduce((sum, drawing) => sum + drawing.texts.length, 0);
    identifiers += reading.identifiers.length;
    for (const verdict of [overlapVerdict(reading), ...reading.identifiers.map(identifierBreakVerdict)]) {
      if (!verdict.ok) reasons.push(`${route}: ${verdict.reason}`);
    }
  }
  if (texts === 0 && byKey.size > 0) reasons.push(E2E_MESSAGES.noDrawingText());
  return { verdict: verdictOf(reasons), detail: `${texts} drawing text(s) and ${identifiers} identifier(s) measured at 320 px, the tag clear of every drawing text` };
}

function judgeByWidth<T extends { readonly route: string; readonly width: number }>(
  check: 'FLOW' | 'TABFLOW' | 'HANG' | ReplayCheck, lines: readonly string[], routes: readonly string[], accept: (value: unknown) => value is T, verdictFor: (value: T) => Verdict,
  widths: readonly number[] = AXE_CONFIG.widths,
): { verdict: Verdict; readings: T[] } {
  const { byKey, reasons } = readKeyed(check, lines, accept, (value) => widthKey(value.route, value.width));
  const readings: T[] = [];
  for (const route of routes) {
    for (const width of widths) {
      const reading = byKey.get(widthKey(route, width));
      if (reading === undefined) {
        reasons.push(E2E_MESSAGES.renderedMissingRoute(check, widthKey(route, width)));
        continue;
      }
      readings.push(reading);
      const verdict = verdictFor(reading);
      if (!verdict.ok) reasons.push(`${route}: ${verdict.reason}`);
    }
  }
  return { verdict: verdictOf(reasons), readings };
}

function judgeFlow(lines: readonly string[], routes: readonly string[]): CheckResult {
  const { verdict, readings } = judgeByWidth('FLOW', lines, routes, isFlowReading, flowVerdict);
  return { verdict, detail: readings.map((reading) => `${widthKey(reading.route, reading.width)} movingOnLoad ${String(reading.movingOnLoad)}`).join(', ') };
}

const isHangReading = (value: unknown): value is HangReading => isObject(value) && typeof value.route === 'string' && isNumber(value.width)
  && typeof value.hanging === 'boolean' && isNumber(value.visibleStem) && isNumber(value.tagTop) && isNumber(value.valveBottom);

function judgeHang(lines: readonly string[], routes: readonly string[]): CheckResult {
  const { verdict, readings } = judgeByWidth('HANG', lines, routes, isHangReading, hangVerdict, HANG_WIDTHS);
  const hung = readings.filter((reading) => reading.hanging).map((reading) => `${widthKey(reading.route, reading.width)} ${String(reading.visibleStem)} px of stem`);
  // A run in which no route hung a tag measured nothing, so it fails rather than passing empty.
  if (hung.length === 0 && readings.length > 0) return { verdict: { ok: false, reason: E2E_MESSAGES.noHungTag() }, detail: '' };
  return { verdict, detail: hung.join(', ') };
}

const isMove = (value: unknown): value is StepMove => isObject(value) && isNumber(value.before) && isNumber(value.after);
const isShownList = (value: unknown): boolean => Array.isArray(value) && value.every((item) => isObject(item) && typeof item.hash === 'string' && isNumber(item.shown));
const isReplayReading = (value: unknown): value is ReplayReading => isObject(value) && typeof value.route === 'string' && isNumber(value.width)
  && Array.isArray(value.boxes) && value.boxes.every((step) => Array.isArray(step) && step.every(isBox))
  && Array.isArray(value.afterNext) && value.afterNext.every(isNumber) && isNumber(value.afterFourth)
  && Array.isArray(value.buttons) && value.buttons.every(isNumber)
  && typeof value.previousDisabledFirst === 'boolean' && typeof value.nextDisabledLast === 'boolean'
  && isShownList(value.deepLinks) && isShownList(value.invalid) && isNumber(value.sameStepMutations)
  && isNumber(value.historyBefore) && isNumber(value.historyAfter) && isMove(value.arrow) && isMove(value.radio)
  && Array.isArray(value.modifiers) && value.modifiers.every((item) => isMove(item) && isObject(item) && typeof item.modifier === 'string');
const isNoScriptReading = (value: unknown): value is NoScriptReading => isObject(value) && typeof value.route === 'string' && isNumber(value.width)
  && isStringList(value.panels) && isNumber(value.controls) && typeof value.tagShown === 'boolean'
  && Array.isArray(value.boardParts) && value.boardParts.every((part) => isObject(part) && typeof part.steps === 'string' && typeof part.displayed === 'boolean');
const isReplayLayoutReading = (value: unknown): value is ReplayLayoutReading => isObject(value) && typeof value.route === 'string' && isNumber(value.width)
  && Array.isArray(value.steps) && value.steps.every((item) => isObject(item) && isNumber(item.step) && isNumber(item.boardHeight) && typeof item.phantom === 'boolean')
  && isNumber(value.phantomExposed)
  && (value.evidence === null || (isObject(value.evidence) && isNumber(value.evidence.tableRight) && isNumber(value.evidence.panelRight)))
  && Array.isArray(value.logRows) && value.logRows.every((row) => isObject(row) && typeof row.header === 'string' && Array.isArray(row.baselines) && row.baselines.every(isNumber))
  && Array.isArray(value.identifiers) && value.identifiers.every((item) => isObject(item) && typeof item.text === 'string' && typeof item.weight === 'string');

// The replay checks run only where the build holds the replay; a replay route that printed no line
// fails as missing, like every other check.
function judgeReplayCheck<T extends { readonly route: string; readonly width: number }>(
  check: ReplayCheck, lines: readonly string[], routes: readonly string[], accept: (value: unknown) => value is T, verdictFor: (value: T) => Verdict, detail: string,
  widths: readonly number[] = AXE_CONFIG.widths,
): CheckResult {
  const replayRoutes = routes.filter((route) => route === REPLAY);
  if (replayRoutes.length === 0) return { verdict: { ok: true }, detail: 'the build holds no replay page' };
  const { verdict } = judgeByWidth(check, lines, replayRoutes, accept, verdictFor, widths);
  return { verdict, detail };
}

function judgeTabFlow(lines: readonly string[], routes: readonly string[]): CheckResult {
  const { verdict } = judgeByWidth('TABFLOW', lines, routes, isFlowTabReading, flowTabVerdict);
  return { verdict, detail: `every visible Stop flow control is reached by Tab before the next section on ${routes.join(', ')}` };
}

const consoleRecord = (text: string): { readonly text: string; readonly url: string } => {
  const parsed = parseJson(text.slice('CONSOLE '.length));
  if (!isObject(parsed) || typeof parsed.text !== 'string') return { text, url: '' };
  return { text: parsed.text, url: typeof parsed.url === 'string' ? parsed.url : '' };
};

function judgeRendered(run: DriverRun, routes: readonly string[], print: (line: string) => void): string | null {
  const printed = printedLines(run);
  const [stopped] = driverRunFailures(run, RENDERED_LABEL, printed);
  if (stopped !== undefined) return stopped;
  const records = new Map<string, string>();
  const routeLines = new Map<string, string[]>([...ROUTE_CHECKS, ...MEASURE_CHECKS, ...REPLAY_CHECKS].map((check) => [check, []]));
  const consoleErrors: string[] = [];
  for (const text of printed) {
    const kind = text.split(' ', 1)[0] ?? '';
    if (kind === 'CONSOLE') {
      const record = consoleRecord(text);
      if (!isExpectedNotFound(record)) consoleErrors.push(record.text);
    }
    else if ((RENDERED_CHECKS as readonly string[]).includes(kind) || kind === 'STORAGE') records.set(kind, text);
    else routeLines.get(kind)?.push(text);
  }
  const measured = (check: (typeof MEASURE_CHECKS)[number]): readonly string[] => routeLines.get(check) ?? [];
  const results: (readonly [string, { verdict: Verdict; detail: string }])[] = [
    ...RENDERED_CHECKS.map((check) => [check, judgeCheck(check, records.get(check))] as const),
    ...ROUTE_CHECKS.map((check) => [check, judgeRouteCheck(check, routeLines.get(check) ?? [], routes)] as const),
    ['FLOW', judgeFlow(measured('FLOW'), routes)],
    ['TABFLOW', judgeTabFlow(measured('TABFLOW'), routes)],
    ['LINES', judgeLines(measured('LINES'), routes)],
    ['NARROW', judgeNarrow(measured('NARROW'), routes)],
    ['HANG', judgeHang(measured('HANG'), routes)],
    ['REPLAY', judgeReplayCheck('REPLAY', routeLines.get('REPLAY') ?? [], routes, isReplayReading, replayVerdict,
      `Next, Previous, the step buttons, deep links, invalid hashes, keys and history held on ${REPLAY} at 320 and 1440 px`)],
    ['NOSCRIPT', judgeReplayCheck('NOSCRIPT', routeLines.get('NOSCRIPT') ?? [], routes, isNoScriptReading, noScriptVerdict,
      `with the js class removed every panel showed in order, no control showed and the board held the paused step at 320 and 1440 px (${NO_SCRIPT_METHOD})`)],
    ['LAYOUT', judgeReplayCheck('LAYOUT', routeLines.get('LAYOUT') ?? [], routes, isReplayLayoutReading, replayLayoutVerdict,
      `the stacked board held one height with the tag's place drawn, the step 2 schedule stayed inside its panel, log cells shared a baseline and identifiers computed 500 on ${REPLAY} at ${REPLAY_LAYOUT_WIDTHS.join(', ')} px`,
      REPLAY_LAYOUT_WIDTHS)],
    ['STORAGE', judgeStorage(records.get('STORAGE'))],
    ['CONSOLE', { verdict: consoleVerdict(consoleErrors), detail: 'no console error, no Content Security Policy violation' }],
  ];
  const failed: string[] = [];
  for (const [check, { verdict, detail }] of results) {
    if (verdict.ok) {
      print(E2E_MESSAGES.renderedOk(check, detail));
    } else {
      print(E2E_MESSAGES.renderedFailed(check, verdict.reason));
      failed.push(`${check}: ${verdict.reason}`);
    }
  }
  const first = failed[0];
  return first === undefined ? null : E2E_MESSAGES.renderedFailures(failed.length, first);
}

// D-132's rendered layer under the built _headers (C5, C6): on the landing page a stored Dark
// before first paint, Device following the OS live and the Dark pin (AC-E28); on every built route
// and the 404 page the switch, the faces and the request origins; then the storage keys and every
// console error.
async function renderedStep(options: SiteE2eOptions, dist: string, print: (line: string) => void): Promise<string | null> {
  const driver = locateDriver(options.globalModules, join(options.repoRoot, 'scripts', 'site.devbrowser.js'));
  if (typeof driver === 'string') return driver;
  const routes = [...routesFromDist(dist), UNKNOWN_PATH];
  const served = await withPreview(options.repoRoot, 'fothering-e2e-', async (server, workDir) => {
    const written = writeDriver(driver.templatePath, { base: server.url, route: '/', routes, widths: AXE_CONFIG.widths, hangWidths: HANG_WIDTHS, families: SITE_FAMILIES, replayRoute: REPLAY, invalidHashes: REPLAY_INVALID_HASHES, layoutWidths: REPLAY_LAYOUT_WIDTHS }, join(workDir, 'site.js'));
    if (!written.ok) return A11Y_MESSAGES.templateTokens(driver.templatePath, written.tokens);
    const run = await runDriver({ launcher: driver.launcher, driverPath: written.path, timeoutSeconds: DRIVER_TIMEOUT_SECONDS });
    return judgeRendered(run, routes, print);
  });
  return served.ok ? served.value : served.reason;
}

// size-limit reads the size-limit field of packages/web/package.json from its working folder and
// finds its file plugin in the root package (RESEARCH A6).
function sizeLimitRun(repoRoot: string): () => SizeRun {
  return () => {
    const run = spawnSync(process.execPath, [join(repoRoot, 'node_modules', 'size-limit', 'bin.js')], {
      cwd: join(repoRoot, 'packages', 'web'),
      encoding: 'utf8',
      shell: false,
    });
    return { status: run.status, output: `${run.stdout ?? ''}${run.stderr ?? ''}${run.error === undefined ? '' : run.error.message}` };
  };
}

function sizeStep(options: SiteE2eOptions, print: (line: string) => void): string | null {
  const run = (options.sizeLimit ?? sizeLimitRun(options.repoRoot))();
  printOutput(print, run.output);
  return run.status === 0 ? null : E2E_MESSAGES.sizeLimit(run.status);
}

// D-151's order; a failing step stops the run with its reason, and the last line is PASS or FAIL.
export async function runSiteE2e(options: SiteE2eOptions): Promise<number> {
  const print = options.print ?? ((line: string) => console.log(line));
  const dist = join(options.repoRoot, 'packages', 'web', 'dist');
  if (!existsSync(dist) || !statSync(dist).isDirectory()) {
    print(E2E_MESSAGES.fail(E2E_MESSAGES.noDist(dist)));
    return 1;
  }
  let pages = 0;
  const builtChecks = (): string | null => {
    const judged = judgeBuiltSite(dist, options.repoRoot);
    if (!judged.ok) return judged.reason;
    pages = judged.pages;
    for (const finding of judged.findings) print(findingLine(finding));
    const first = judged.findings[0];
    return first === undefined ? null : E2E_MESSAGES.findings(judged.findings.length, findingLine(first));
  };
  const steps: readonly (readonly [string, () => string | null | Promise<string | null>])[] = [
    ['client-secrets', () => clientSecretsStep(options.clientSecretsScript ?? join(options.repoRoot, 'scripts', 'check-client-secrets.mjs'), dist, print)],
    ['file-budget', () => fileBudgetStep(dist, options.fileBudget ?? checkFileBudget)],
    ['size', () => sizeStep(options, print)],
    ['built-checks', builtChecks],
    ['second-build', () => secondBuildStep(options, dist)],
    ['copy-build', () => copyBuildStep(options, print)],
    ['copy-provenance', () => copyVariantStep('provenance', options.provenanceCopyBuild ?? realProvenanceCopy(options.repoRoot))],
    ['copy-cause', () => copyVariantStep('cause', options.causeCopyBuild ?? realCauseCopy(options.repoRoot))],
    ['rendered', () => renderedStep(options, dist, print)],
  ];
  for (const [name, run] of steps) {
    const reason = await run();
    if (reason !== null) {
      print(E2E_MESSAGES.fail(reason));
      return 1;
    }
    print(E2E_MESSAGES.step(name));
  }
  print(E2E_MESSAGES.pass(pages, steps.length));
  return 0;
}
