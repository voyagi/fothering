import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
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
import { filesIn, loadBuiltSite, NoBuiltPagesError, routeOf, type BuiltSite } from '../checks/built-site.js';
import { checkFileBudget, isRegisteredRule, runBuiltChecks, type BudgetViolation, type CheckContext, type Finding } from '../checks/rules.js';
import { BANNED_NAMES, CONSOLE_DELETE_PHRASES, REPLY_PROMISE_PHRASES, REPUTATION_PAGE_URL } from '../site/content.js';
import { ROUTES, SITE_ORIGIN } from '../site/route-list.js';

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
  readonly reason: string;
}

// An incomplete result is a check axe could not decide. Each one fails the audit unless it is
// listed here with a written reason; the matched counts print on every run.
export const ACCEPTED_INCOMPLETE: readonly AcceptedIncomplete[] = Object.freeze([]);

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
  status: (status: number) => `the route answered ${status}, not 200`,
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
  routePassed: (route: string, run: string, stops: number) => `[a11y] ${route} ${run}: ok, 0 violations, ${stops} Tab stop(s)`,
  routeFailed: (route: string, run: string, reasons: readonly string[]) => `[a11y] ${route} ${run}: failed: ${reasons.join('; ')}`,
  selectedRules: (ruleIds: readonly string[]) => `[a11y] the five tags select ${ruleIds.length} axe rule(s): ${ruleIds.join(', ')}`,
  acceptedNone: () => '[a11y] accepted incomplete list: empty, 0 matched',
  acceptedCount: (ruleId: string, count: number, reason: string) => `[a11y] accepted incomplete ${ruleId}: ${count} matched (${reason})`,
  pass: (routes: number, widths: number, themes: number, accepted: number) => `[a11y] PASS: ${routes} route(s) x ${widths} widths x ${themes} themes, 0 violations, ${accepted} accepted incomplete`,
  fail: (reason: string) => `[a11y] FAIL: ${reason}`,
  failCount: (failed: number, total: number, first: string) => `${failed} of ${total} audit(s) failed; first: ${first}`,
});

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

export function axeReasons(axe: AxeReport, accepted: ReadonlyMap<string, number>): string[] {
  const reasons: string[] = [];
  if (axe.version !== AXE_VERSION) reasons.push(A11Y_MESSAGES.axeVersionRan(axe.version));
  if (axe.selected.length === 0) reasons.push(A11Y_MESSAGES.noSelectedRules());
  for (const ruleId of AXE_CONFIG.enabledRules) {
    if (axe.selected.length > 0 && !axe.selected.includes(ruleId)) reasons.push(A11Y_MESSAGES.ruleNotSelected(ruleId));
    if (!axe.ran.includes(ruleId)) reasons.push(A11Y_MESSAGES.ruleNotRun(ruleId));
  }
  for (const item of axe.violations) reasons.push(A11Y_MESSAGES.violation(item.id, item.nodes.length, item.nodes[0]?.target ?? 'no target'));
  for (const item of axe.incomplete) {
    if (accepted.has(item.id)) continue;
    reasons.push(A11Y_MESSAGES.incomplete(item.id, item.nodes.length, item.nodes[0]?.target ?? 'no target'));
  }
  return reasons;
}

export function auditReasons(line: AuditLine, width: number, accepted: ReadonlyMap<string, number>): string[] {
  if (line.status !== 200) return [A11Y_MESSAGES.status(line.status)];
  if (line.axe === undefined || line.keyboard === undefined || line.overflow === undefined) return [A11Y_MESSAGES.axeAbsent()];
  const reasons = axeReasons(line.axe, accepted);
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

function isAxeReport(value: unknown): boolean {
  return isObject(value) && typeof value.version === 'string' && isStringList(value.selected) && isStringList(value.ran)
    && isItemList(value.violations) && isItemList(value.incomplete);
}

function isAuditLine(value: unknown): value is AuditLine {
  if (!isObject(value) || typeof value.route !== 'string' || typeof value.status !== 'number') return false;
  if (value.status !== 200) return true;
  const { keyboard, overflow } = value;
  return isAxeReport(value.axe)
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

function readRun(run: DriverRun, label: string): RunResult {
  const failures: string[] = [];
  const lines = new Map<string, AuditLine>();
  if (run.timedOut) failures.push(A11Y_MESSAGES.driverTimedOut(label));
  else if (run.exitCode !== 0) failures.push(A11Y_MESSAGES.driverExit(label, run.exitCode, run.stderr.trim().slice(-STDERR_TAIL)));
  const printed = run.stdoutLines.map((line) => line.trim()).filter((line) => line !== '');
  if (printed.at(-1) !== 'done') failures.push(A11Y_MESSAGES.noDone(label));
  for (const text of printed) {
    if (!text.startsWith('AUDIT ')) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text.slice('AUDIT '.length));
    } catch {
      parsed = undefined;
    }
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

interface Prepared {
  readonly routes: readonly string[];
  readonly launcher: string;
  readonly templatePath: string;
}

function prepare(options: A11yLiveOptions, themes: readonly ThemeSetup[], widths: readonly number[]): Prepared | string {
  if (themes.length === 0) return A11Y_MESSAGES.noThemes();
  if (widths.length === 0) return A11Y_MESSAGES.noWidths();
  const dist = join(options.repoRoot, 'packages', 'web', 'dist');
  if (!existsSync(dist) || !statSync(dist).isDirectory()) return A11Y_MESSAGES.noDist(dist);
  const routes = routesFromDist(dist);
  if (routes.length === 0) return A11Y_MESSAGES.noRoutes(dist);
  const located = locateDevBrowser(options.globalModules);
  if (!located.ok) return located.reason === 'missing' ? A11Y_MESSAGES.devBrowserMissing(located.path) : A11Y_MESSAGES.devBrowserVersion(located.found);
  const templatePath = options.templatePath ?? join(options.repoRoot, 'scripts', 'a11y.devbrowser.js');
  if (!existsSync(templatePath)) return A11Y_MESSAGES.templateMissing(templatePath);
  return { routes, launcher: located.launcher, templatePath };
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
    routes: context.prepared.routes,
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
  for (const route of context.prepared.routes) {
    if (!lines.has(route)) failures.push(A11Y_MESSAGES.missingRoute(label, route));
  }
  for (const failure of failures) context.print(`[a11y] ${failure}`);
  for (const [route, line] of lines) {
    for (const ruleId of line.axe?.selected ?? []) context.selected.add(ruleId);
    for (const item of line.axe?.incomplete ?? []) {
      if (context.accepted.has(item.id)) context.accepted.set(item.id, (context.accepted.get(item.id) ?? 0) + item.nodes.length);
    }
    const reasons = auditReasons(line, width, context.accepted);
    if (reasons.length === 0) {
      context.print(A11Y_MESSAGES.routePassed(route, label, line.keyboard?.walk.length ?? 0));
    } else {
      context.print(A11Y_MESSAGES.routeFailed(route, label, reasons));
      failures.push(`${route} ${label}: ${reasons.join('; ')}`);
    }
  }
  return { failures, audits: context.prepared.routes.length };
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
  const workDir = mkdtempSync(join(tmpdir(), 'fothering-a11y-'));
  let server: PreviewServer | undefined;
  try {
    try {
      server = await startPreviewServer({
        distDir: join(options.repoRoot, 'packages', 'web', 'dist'),
        wranglerConfigPath: join(options.repoRoot, 'packages', 'web', 'wrangler.jsonc'),
      });
    } catch (error) {
      print(A11Y_MESSAGES.fail(A11Y_MESSAGES.serverFailed((error as Error).message)));
      return 1;
    }
    const accepted = new Map(ACCEPTED_INCOMPLETE.map((entry) => [entry.ruleId, 0]));
    const selected = new Set<string>();
    const context: AuditContext = { prepared, server, axeFile: staged.name, workDir, print, accepted, selected, outerTimeoutMs: options.outerTimeoutMs };
    const failures: string[] = [];
    let audits = 0;
    for (const theme of themes) {
      for (const width of widths) {
        const result = await auditOne(context, theme, width);
        failures.push(...result.failures);
        audits += result.audits;
      }
    }
    print(A11Y_MESSAGES.selectedRules([...selected].sort()));
    if (ACCEPTED_INCOMPLETE.length === 0) print(A11Y_MESSAGES.acceptedNone());
    for (const entry of ACCEPTED_INCOMPLETE) print(A11Y_MESSAGES.acceptedCount(entry.ruleId, accepted.get(entry.ruleId) ?? 0, entry.reason));
    const first = failures[0];
    if (first !== undefined) {
      print(A11Y_MESSAGES.fail(A11Y_MESSAGES.failCount(failures.length, audits, first)));
      return 1;
    }
    const matched = [...accepted.values()].reduce((sum, count) => sum + count, 0);
    print(A11Y_MESSAGES.pass(prepared.routes.length, widths.length, themes.length, matched));
    return 0;
  } finally {
    await server?.close();
    staged.remove();
    rmSync(workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
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
  return Object.freeze({
    repoRoot,
    reputationPageUrl: REPUTATION_PAGE_URL,
    replyPromisePhrases: REPLY_PROMISE_PHRASES,
    consoleDeletePhrases: CONSOLE_DELETE_PHRASES,
    bannedNames: BANNED_NAMES,
    siteOrigin: SITE_ORIGIN,
    routes: ROUTES,
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
  // The rendered checks of a later plan drive dev-browser from the global npm folder.
  readonly globalModules: string;
  readonly print?: (line: string) => void;
  readonly clientSecretsScript?: string;
  readonly fileBudget?: (files: readonly { readonly path: string; readonly bytes: number }[]) => BudgetViolation[];
  readonly secondBuild?: (outDir: string) => SecondBuildRun;
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

// D-151's order. The size budget arrives in 05-09 and the rendered checks in 05-08, each as a step
// here; a failing step stops the run with its reason, and the last line is PASS or FAIL.
export function runSiteE2e(options: SiteE2eOptions): Promise<number> {
  const print = options.print ?? ((line: string) => console.log(line));
  const dist = join(options.repoRoot, 'packages', 'web', 'dist');
  if (!existsSync(dist) || !statSync(dist).isDirectory()) {
    print(E2E_MESSAGES.fail(E2E_MESSAGES.noDist(dist)));
    return Promise.resolve(1);
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
  const steps: readonly (readonly [string, () => string | null])[] = [
    ['client-secrets', () => clientSecretsStep(options.clientSecretsScript ?? join(options.repoRoot, 'scripts', 'check-client-secrets.mjs'), dist, print)],
    ['file-budget', () => fileBudgetStep(dist, options.fileBudget ?? checkFileBudget)],
    ['built-checks', builtChecks],
    ['second-build', () => secondBuildStep(options, dist)],
  ];
  for (const [name, run] of steps) {
    const reason = run();
    if (reason !== null) {
      print(E2E_MESSAGES.fail(reason));
      return Promise.resolve(1);
    }
    print(E2E_MESSAGES.step(name));
  }
  print(E2E_MESSAGES.pass(pages, steps.length));
  return Promise.resolve(0);
}
