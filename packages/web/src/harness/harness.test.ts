import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { main, PROCESS_IO, waitForSignal, type CliIo } from './cli.js';
import { DRIVER_JOB_TOKEN, runDriver, stageAxeSource, writeDriver } from './dev-browser.js';
import { completeSite, page, plantDist } from '../test/planted-dist.js';
import { renderSitemap, SITE_ORIGIN } from '../site/route-list.js';
import { themedValue, TOKENS } from '../theme/head-script.js';
import {
  A11Y_MESSAGES,
  ACCEPTED_INCOMPLETE,
  AXE_CONFIG,
  E2E_MESSAGES,
  auditReasons,
  axeReasons,
  compareBuilds,
  consoleVerdict,
  copyBuild,
  countAccepted,
  flowTabVerdict,
  flowVerdict,
  identifierBreakVerdict,
  lineVerdict,
  overlapVerdict,
  deviceVerdict,
  fontsVerdict,
  isExpectedNotFound,
  keyboardVerdict,
  loadCheckContext,
  overflowVerdict,
  pinVerdict,
  requestsVerdict,
  routesFromDist,
  runA11yLive,
  runSiteE2e,
  SITE_FAMILIES,
  storageVerdict,
  storedThemeVerdict,
  switchVerdict,
  tookHoldVerdict,
  UNKNOWN_PATH,
  type AcceptedIncomplete,
  type AuditLine,
  type AxeReport,
  type Box,
  type CopyBuildRun,
  type DrawingReading,
  type FlowReading,
  type FlowState,
  type FocusStop,
  type LinesReading,
  type FontsReading,
  type KeyboardReport,
  type RequestsReading,
  type SecondBuildRun,
  type SiteE2eOptions,
  type SizeRun,
  type SwitchReading,
  type ThemeReading,
} from './gates.js';

// This file sits four folders below the repo root, like packages/infra/src/repo's tests.
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const TEMPLATE = join(REPO_ROOT, 'scripts', 'a11y.devbrowser.js');
const SECRETS_SCRIPT = join(REPO_ROOT, 'scripts', 'check-client-secrets.mjs');
const SKIP_WORD = /\bSKIPPED\b/;

// Planted trees live under the repo's git-ignored node_modules/.cache, never the system temp
// folder, so a planted repo can never be mistaken for another checkout.
const CACHE = join(REPO_ROOT, 'node_modules', '.cache');
mkdirSync(CACHE, { recursive: true });
const PLANT = mkdtempSync(join(CACHE, 'fothering-harness-'));

afterAll(() => {
  rmSync(PLANT, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

// The stand-in for bin/dev-browser.js: it reads the job out of the driver it was handed and prints
// what scenario.json beside it asks for, so each case plants an outcome without any environment
// variable. It also records its arguments and fails when the staged axe file is absent.
const STUB_LAUNCHER = `import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const here = dirname(fileURLToPath(import.meta.url));
const scenario = JSON.parse(readFileSync(join(here, 'scenario.json'), 'utf8'));
writeFileSync(join(here, 'args.json'), JSON.stringify(process.argv.slice(2)));
if (scenario.hang) setInterval(() => {}, 1000);
else {
  const driver = readFileSync(process.argv[process.argv.length - 1], 'utf8');
  const job = JSON.parse(/^const JOB = (.*);$/m.exec(driver)[1]);
  writeFileSync(join(here, 'job.json'), JSON.stringify(job));
  if (job.route !== undefined) {
    const site = scenario.site || {};
    for (const line of site.lines || []) console.log(line);
    if (!site.omitDone) console.log('done');
    process.exit(site.exitCode === undefined ? 0 : site.exitCode);
  }
  if (!existsSync(join(scenario.homeDir, '.dev-browser', 'tmp', job.axeFile))) {
    console.error('staged axe file not found');
    process.exit(3);
  }
  const stop = { domIndex: 5, tag: 'a', radioGroup: null, skipLink: true };
  const theme = { dataTheme: job.storedTheme, ground: scenario.grounds[job.storedTheme || job.osScheme] };
  for (const route of job.routes) {
    const expected = (job.expectedStatus || {})[route] || 200;
    const answered = scenario.unknownStatus !== undefined && expected !== 200 ? scenario.unknownStatus : expected;
    const status = scenario.status === undefined ? answered : scenario.status;
    const line = status !== 200 && status !== expected ? { route, status } : {
      route,
      status,
      theme,
      axe: { version: '4.14.0', selected: ['html-has-lang', 'target-size', 'label-content-name-mismatch'], ran: ['html-has-lang', 'target-size', 'label-content-name-mismatch'], violations: [], incomplete: [] },
      keyboard: { focusables: [stop], positiveTabindex: [], walk: [{ ...stop, outlineStyle: 'auto', outlineWidth: '1px', boxShadow: 'none' }] },
      overflow: { scrollWidth: job.width, innerWidth: job.width },
    };
    console.log('AUDIT ' + JSON.stringify(line));
  }
  if (scenario.malformed) console.log('AUDIT {not json');
  if (scenario.incomplete) console.log('AUDIT ' + JSON.stringify({ route: job.routes[0], status: 200, theme, axe: { version: '4.14.0', selected: ['target-size', 'label-content-name-mismatch'], ran: ['target-size', 'label-content-name-mismatch'], violations: [], incomplete: [{ id: 'color-contrast', nodes: [{ target: 'p', summary: '' }] }] }, keyboard: { focusables: [stop], positiveTabindex: [], walk: [{ ...stop, outlineStyle: 'auto', outlineWidth: '1px', boxShadow: 'none' }] }, overflow: { scrollWidth: job.width, innerWidth: job.width } }));
  if (!scenario.omitDone) console.log('done');
  process.exit(scenario.exitCode === undefined ? 0 : scenario.exitCode);
}
`;

interface SiteScenario {
  readonly lines?: readonly string[];
  readonly omitDone?: boolean;
  readonly exitCode?: number;
}

interface Scenario {
  readonly status?: number;
  readonly unknownStatus?: number;
  readonly omitDone?: boolean;
  readonly exitCode?: number;
  readonly hang?: boolean;
  readonly malformed?: boolean;
  readonly incomplete?: boolean;
  // What --ground the stand-in reports per expected theme; tokens.json's values unless a case plants others.
  readonly grounds?: Readonly<Record<'light' | 'dark', string>>;
  readonly site?: SiteScenario;
}

const LIGHT_GROUND = themedValue(TOKENS, '--ground', 'light');
const DARK_GROUND = themedValue(TOKENS, '--ground', 'dark');

interface Planted {
  readonly repoRoot: string;
  readonly globalModules: string;
  readonly homeDir: string;
  readonly dist: string;
}

let plantCount = 0;

function write(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
}

function plantRepo(options: { pages?: Record<string, string>; devBrowserVersion?: string | null; axe?: 'ok' | 'missing' | '4.13.0'; scenario?: Scenario } = {}): Planted {
  plantCount += 1;
  const base = join(PLANT, `case-${plantCount}`);
  const repoRoot = join(base, 'repo');
  const globalModules = join(base, 'global');
  const homeDir = join(base, 'home');
  const dist = join(repoRoot, 'packages', 'web', 'dist');
  mkdirSync(homeDir, { recursive: true });
  const pages = options.pages ?? {
    'index.html': '<!doctype html><title>home</title>',
    'about/index.html': '<!doctype html><title>about</title>',
    '404.html': '<!doctype html><title>not found</title>',
    'sitemap.xml': renderSitemap([{ path: '/', indexable: true }, { path: '/about/', indexable: true }]),
  };
  for (const [file, text] of Object.entries(pages)) write(join(dist, file), text);
  copyFileSync(join(REPO_ROOT, 'packages', 'web', 'wrangler.jsonc'), join(repoRoot, 'packages', 'web', 'wrangler.jsonc'));
  write(join(repoRoot, 'scripts', 'a11y.devbrowser.js'), readFileSync(TEMPLATE, 'utf8'));
  const axe = options.axe ?? 'ok';
  if (axe !== 'missing') {
    write(join(repoRoot, 'node_modules', 'axe-core', 'package.json'), JSON.stringify({ name: 'axe-core', version: axe === 'ok' ? '4.14.0' : axe }));
    write(join(repoRoot, 'node_modules', 'axe-core', 'axe.min.js'), '/* planted axe */\n');
  }
  const devBrowserVersion = options.devBrowserVersion === undefined ? '0.2.9' : options.devBrowserVersion;
  if (devBrowserVersion !== null) plantLauncher(globalModules, devBrowserVersion, options.scenario ?? {}, homeDir);
  return { repoRoot, globalModules, homeDir, dist };
}

function plantLauncher(globalModules: string, version: string, scenario: Scenario, homeDir: string): void {
  const packageDir = join(globalModules, 'dev-browser');
  write(join(packageDir, 'package.json'), JSON.stringify({ name: 'dev-browser', version, type: 'module' }));
  write(join(packageDir, 'bin', 'dev-browser.js'), STUB_LAUNCHER);
  write(join(packageDir, 'bin', 'scenario.json'), JSON.stringify({ grounds: { light: LIGHT_GROUND, dark: DARK_GROUND }, ...scenario, homeDir }));
}

const allOutput: string[] = [];

async function audit(planted: Planted, extra: { themes?: []; outerTimeoutMs?: number } = {}): Promise<{ code: number; lines: string[] }> {
  const lines: string[] = [];
  const code = await runA11yLive({
    repoRoot: planted.repoRoot,
    globalModules: planted.globalModules,
    homeDir: planted.homeDir,
    print: (line) => lines.push(line),
    ...extra,
  });
  allOutput.push(...lines);
  return { code, lines };
}

describe('runA11yLive refuses every empty or broken run by name', () => {
  it('fails on a missing dist', async () => {
    const planted = plantRepo();
    rmSync(planted.dist, { recursive: true, force: true });
    const { code, lines } = await audit(planted);
    expect(code).toBe(1);
    expect(lines).toEqual([A11Y_MESSAGES.fail(A11Y_MESSAGES.noDist(planted.dist))]);
  });

  it('fails on an empty dist (zero routes)', async () => {
    const planted = plantRepo({ pages: { '404.html': '<!doctype html><title>not found</title>' } });
    const { code, lines } = await audit(planted);
    expect(code).toBe(1);
    expect(lines).toEqual([A11Y_MESSAGES.fail(A11Y_MESSAGES.noRoutes(planted.dist))]);
  });

  it('fails on an empty theme list', async () => {
    const { code, lines } = await audit(plantRepo(), { themes: [] });
    expect(code).toBe(1);
    expect(lines).toEqual([A11Y_MESSAGES.fail(A11Y_MESSAGES.noThemes())]);
  });

  it('fails when a route answers 404', async () => {
    const { code, lines } = await audit(plantRepo({ scenario: { status: 404 } }));
    expect(code).toBe(1);
    expect(lines).toContain(A11Y_MESSAGES.routeFailed('/', 'light 320px', [A11Y_MESSAGES.status(404, 200)]));
    expect(lines.at(-1)).toMatch(/^\[a11y\] FAIL: 12 of 18 audit\(s\) failed/);
  });

  it('fails a planted dist with no 404.html by name', async () => {
    const planted = plantRepo();
    rmSync(join(planted.dist, '404.html'));
    const { code, lines } = await audit(planted);
    expect(code).toBe(1);
    expect(lines).toEqual([A11Y_MESSAGES.fail(A11Y_MESSAGES.noNotFoundPage(planted.dist))]);
  });

  it('fails a planted dist with no sitemap.xml by name', async () => {
    const planted = plantRepo();
    rmSync(join(planted.dist, 'sitemap.xml'));
    const { code, lines } = await audit(planted);
    expect(code).toBe(1);
    expect(lines).toEqual([A11Y_MESSAGES.fail(A11Y_MESSAGES.noSitemap(planted.dist))]);
  });

  it('fails a planted dist whose sitemap and HTML routes differ, naming both sides', async () => {
    const planted = plantRepo();
    write(join(planted.dist, 'sitemap.xml'), renderSitemap([{ path: '/', indexable: true }, { path: '/ghost/', indexable: true }]));
    const { code, lines } = await audit(planted);
    expect(code).toBe(1);
    expect(lines).toEqual([A11Y_MESSAGES.fail(A11Y_MESSAGES.sitemapDiffers(['/about/'], ['/ghost/']))]);
  });

  it('strips only the site origin from sitemap URLs, so a URL on another origin differs', async () => {
    const planted = plantRepo();
    write(join(planted.dist, 'sitemap.xml'), `<urlset><url><loc>${SITE_ORIGIN}/</loc></url><url><loc>https://elsewhere.example/about/</loc></url></urlset>`);
    const { code, lines } = await audit(planted);
    expect(code).toBe(1);
    expect(lines).toEqual([A11Y_MESSAGES.fail(A11Y_MESSAGES.sitemapDiffers(['/about/'], ['https://elsewhere.example/about/']))]);
  });

  it('puts the unknown path /no-such-sheet/ in every job, expecting status 404', async () => {
    const planted = plantRepo();
    expect((await audit(planted)).code).toBe(0);
    const job = JSON.parse(readFileSync(join(planted.globalModules, 'dev-browser', 'bin', 'job.json'), 'utf8')) as { routes: string[]; expectedStatus: Record<string, number> };
    expect(job.routes).toEqual(['/', '/about/', '/no-such-sheet/']);
    expect(job.expectedStatus).toEqual({ '/no-such-sheet/': 404 });
  });

  it('fails an AUDIT line for the unknown path that answered 200', async () => {
    const { code, lines } = await audit(plantRepo({ scenario: { unknownStatus: 200 } }));
    expect(code).toBe(1);
    expect(lines).toContain(A11Y_MESSAGES.routeFailed('/no-such-sheet/', 'light 320px', [A11Y_MESSAGES.status(200, 404)]));
  });

  it('fails when the installed dev-browser reads 0.2.8', async () => {
    const { code, lines } = await audit(plantRepo({ devBrowserVersion: '0.2.8' }));
    expect(code).toBe(1);
    expect(lines).toEqual([A11Y_MESSAGES.fail(A11Y_MESSAGES.devBrowserVersion('0.2.8'))]);
  });

  it('fails when no dev-browser folder exists', async () => {
    const planted = plantRepo({ devBrowserVersion: null });
    const { code, lines } = await audit(planted);
    expect(code).toBe(1);
    expect(lines).toEqual([A11Y_MESSAGES.fail(A11Y_MESSAGES.devBrowserMissing(join(planted.globalModules, 'dev-browser')))]);
  });

  it('fails when the axe-core source is missing', async () => {
    const planted = plantRepo({ axe: 'missing' });
    const { code, lines } = await audit(planted);
    expect(code).toBe(1);
    expect(lines).toEqual([A11Y_MESSAGES.fail(A11Y_MESSAGES.axeMissing(join(planted.repoRoot, 'node_modules', 'axe-core', 'axe.min.js')))]);
  });

  it('fails when the installed axe-core is not 4.14.0', async () => {
    const { code, lines } = await audit(plantRepo({ axe: '4.13.0' }));
    expect(code).toBe(1);
    expect(lines).toEqual([A11Y_MESSAGES.fail(A11Y_MESSAGES.axeVersion('4.13.0'))]);
  });

  it('fails when a driver run ends without its final done line', async () => {
    const { code, lines } = await audit(plantRepo({ scenario: { omitDone: true } }));
    expect(code).toBe(1);
    expect(lines).toContain(`[a11y] ${A11Y_MESSAGES.noDone('light 320px')}`);
  });

  it('fails when a driver run exits non-zero, and when it prints a malformed AUDIT line', async () => {
    const exited = await audit(plantRepo({ scenario: { exitCode: 2 } }));
    expect(exited.code).toBe(1);
    expect(exited.lines).toContain(`[a11y] ${A11Y_MESSAGES.driverExit('light 320px', 2, '')}`);
    const malformed = await audit(plantRepo({ scenario: { malformed: true } }));
    expect(malformed.code).toBe(1);
    expect(malformed.lines).toContain(`[a11y] ${A11Y_MESSAGES.malformedAudit('light 320px', 'AUDIT {not json')}`);
  });

  it('fails an incomplete axe result that is not on the accepted list', async () => {
    const { code, lines } = await audit(plantRepo({ scenario: { incomplete: true } }));
    expect(code).toBe(1);
    expect(lines).toContain(A11Y_MESSAGES.routeFailed('/', 'light 320px', [A11Y_MESSAGES.incomplete('color-contrast', 1, 'p')]));
  });

  it('fails a route the driver printed no AUDIT line for', async () => {
    const planted = plantRepo();
    const stub = join(planted.globalModules, 'dev-browser', 'bin', 'dev-browser.js');
    write(stub, STUB_LAUNCHER.replace('for (const route of job.routes)', 'for (const route of job.routes.slice(0, 1))'));
    const { code, lines } = await audit(planted);
    expect(code).toBe(1);
    expect(lines).toContain(`[a11y] ${A11Y_MESSAGES.missingRoute('light 320px', '/about/')}`);
  });

  it('fails a template that does not hold exactly one job token', async () => {
    const planted = plantRepo();
    const templatePath = join(planted.repoRoot, 'scripts', 'a11y.devbrowser.js');
    write(templatePath, 'console.log("done");\n');
    const { code, lines } = await audit(planted);
    expect(code).toBe(1);
    expect(lines).toContain(`[a11y] ${A11Y_MESSAGES.templateTokens(templatePath, 0)}`);
    rmSync(templatePath);
    const missing = await audit(planted);
    expect(missing.lines).toEqual([A11Y_MESSAGES.fail(A11Y_MESSAGES.templateMissing(templatePath))]);
  });

  it('fails when the preview server refuses its config', async () => {
    const planted = plantRepo();
    write(join(planted.repoRoot, 'packages', 'web', 'wrangler.jsonc'), '{ "assets": { "html_handling": "none", "not_found_handling": "404-page" } }');
    const { code, lines } = await audit(planted);
    expect(code).toBe(1);
    expect(lines.at(-1)).toMatch(/^\[a11y\] FAIL: the preview server did not start: .*assets\.html_handling is "none"/);
  });

  it('passes a clean planted run and prints the PASS line, with the staged axe file removed after', async () => {
    const planted = plantRepo();
    const { code, lines } = await audit(planted);
    expect(code).toBe(0);
    expect(lines).toContain(A11Y_MESSAGES.routePassed('/about/', 'device 1440px', 200, 1));
    expect(lines).toContain(A11Y_MESSAGES.routePassed('/no-such-sheet/', 'device 1440px', 404, 1));
    for (const entry of ACCEPTED_INCOMPLETE) expect(lines).toContain(A11Y_MESSAGES.acceptedCount(entry.ruleId, 0, entry.reason));
    expect(lines.at(-1)).toBe(A11Y_MESSAGES.pass(3, 2, 3, 0));
    expect(lines.filter((line) => line.endsWith('Tab stop(s)'))).toHaveLength(18);
    expect(readdirSync(join(planted.homeDir, '.dev-browser', 'tmp'))).toEqual([]);
    const args = JSON.parse(readFileSync(join(planted.globalModules, 'dev-browser', 'bin', 'args.json'), 'utf8')) as string[];
    expect(args.slice(0, 6)).toEqual(['--headless', '--timeout', '120', '--browser', 'fothering-site', 'run']);
  });

  it('prints one took-hold line per run, naming the --ground of the theme each run expects (D-131)', async () => {
    const { code, lines } = await audit(plantRepo());
    expect(code).toBe(0);
    const tookHold = lines.filter((line) => line.includes('the theme took hold'));
    expect(tookHold).toEqual([
      A11Y_MESSAGES.tookHold('light 320px', LIGHT_GROUND, 3),
      A11Y_MESSAGES.tookHold('light 1440px', LIGHT_GROUND, 3),
      A11Y_MESSAGES.tookHold('dark 320px', DARK_GROUND, 3),
      A11Y_MESSAGES.tookHold('dark 1440px', DARK_GROUND, 3),
      A11Y_MESSAGES.tookHold('device 320px', DARK_GROUND, 3),
      A11Y_MESSAGES.tookHold('device 1440px', DARK_GROUND, 3),
    ]);
  });

  it('fails every route whose --ground is not the token value of the theme its run expects', async () => {
    const { code, lines } = await audit(plantRepo({ scenario: { grounds: { light: DARK_GROUND, dark: LIGHT_GROUND } } }));
    expect(code).toBe(1);
    expect(lines).toContain(A11Y_MESSAGES.routeFailed('/', 'light 320px', [E2E_MESSAGES.themeNotTaken('light', DARK_GROUND, LIGHT_GROUND)]));
    expect(lines).toContain(A11Y_MESSAGES.routeFailed('/no-such-sheet/', 'device 1440px', [E2E_MESSAGES.themeNotTaken('dark', LIGHT_GROUND, DARK_GROUND)]));
    expect(lines.filter((line) => line.includes('the theme took hold'))).toEqual([]);
    expect(lines.at(-1)).toMatch(/^\[a11y\] FAIL: 18 of 18 audit\(s\) failed/);
  });

  it('reports a driver run that hangs as stopped by the outer timeout', async () => {
    const { code, lines } = await audit(plantRepo({ scenario: { hang: true } }), { outerTimeoutMs: 1500 });
    expect(code).toBe(1);
    expect(lines).toContain(`[a11y] ${A11Y_MESSAGES.driverTimedOut('light 320px')}`);
  });

  it('prints the uppercase skip word in no planted run', () => {
    expect(allOutput.length).toBeGreaterThan(20);
    expect(allOutput.filter((line) => SKIP_WORD.test(line))).toEqual([]);
  });
});

type CatalogueSamples = { readonly [K in keyof typeof A11Y_MESSAGES]: Parameters<(typeof A11Y_MESSAGES)[K]> };

const CATALOGUE_SAMPLES: CatalogueSamples = {
  usage: [],
  unknownSubcommand: ['x'],
  missingOption: ['--x'],
  previewListening: ['http://127.0.0.1:1'],
  previewFailed: ['x'],
  noThemes: [],
  noWidths: [],
  noDist: ['d'],
  noRoutes: ['d'],
  noNotFoundPage: ['d'],
  noSitemap: ['d'],
  sitemapDiffers: [['/a/'], []],
  devBrowserMissing: ['p'],
  devBrowserVersion: ['0.2.8'],
  axeMissing: ['p'],
  axeVersion: ['4.13.0'],
  templateTokens: ['p', 2],
  templateMissing: ['p'],
  serverFailed: ['x'],
  driverTimedOut: ['r'],
  driverExit: ['r', 1, 'e'],
  noDone: ['r'],
  malformedAudit: ['r', 'AUDIT x'],
  missingRoute: ['r', '/'],
  status: [404, 200],
  axeAbsent: [],
  axeVersionRan: ['4.13.0'],
  noSelectedRules: [],
  ruleNotSelected: ['target-size'],
  ruleNotRun: ['target-size'],
  violation: ['image-alt', 1, 'img'],
  incomplete: ['color-contrast', 1, 'p'],
  overflow: [321, 320],
  viewport: [300, 320],
  positiveTabindex: [1, '<a>'],
  noFocus: [],
  firstNotSkipLink: ['<a>'],
  radioStops: ['theme', 3],
  tabOrder: ['a', 'b'],
  noIndicator: ['<a>'],
  routePassed: ['/', 'r', 200, 1],
  routeFailed: ['/', 'r', ['x']],
  selectedRules: [['target-size']],
  acceptedNone: [],
  acceptedCount: ['color-contrast', 1, 'reason'],
  pass: [1, 2, 3, 0],
  fail: ['x'],
  failCount: [1, 2, 'x'],
  tookHold: ['r', '#000000', 3],
  themeAbsent: [],
};

describe('the message catalogue', () => {
  it('holds no message with the uppercase skip word', () => {
    const rendered = Object.entries(CATALOGUE_SAMPLES).map(([key, args]) => (A11Y_MESSAGES[key as keyof typeof A11Y_MESSAGES] as (...a: unknown[]) => string)(...args));
    expect(rendered).toHaveLength(Object.keys(A11Y_MESSAGES).length);
    expect(rendered.filter((text) => SKIP_WORD.test(text))).toEqual([]);
  });

  it('exports the audit configuration the accessibility record compares against', () => {
    expect(AXE_CONFIG.version).toBe('4.14.0');
    expect(AXE_CONFIG.tags).toEqual(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']);
    expect(AXE_CONFIG.enabledRules).toEqual(['target-size', 'label-content-name-mismatch']);
    expect(AXE_CONFIG.widths).toEqual([320, 1440]);
    expect(AXE_CONFIG.themes.map((theme) => [theme.name, theme.stored, theme.os])).toEqual([['light', 'light', 'dark'], ['dark', 'dark', 'light'], ['device', null, 'dark']]);
    expect(ACCEPTED_INCOMPLETE.map((entry) => [entry.ruleId, entry.targetPattern])).toEqual([['color-contrast', '^(?:text(?:$|[[.:#])|[.]dwg-)']]);
  });
});

describe('overflowVerdict (AC-E34)', () => {
  it('passes a page exactly as wide as the viewport', () => {
    expect(overflowVerdict(320, 320)).toEqual({ ok: true });
  });

  it('fails a page one CSS pixel wider than the viewport', () => {
    expect(overflowVerdict(321, 320)).toEqual({ ok: false, reason: A11Y_MESSAGES.overflow(321, 320) });
  });
});

const ring = { outlineStyle: 'auto', outlineWidth: '1px', boxShadow: 'none' };
const skip: FocusStop = { domIndex: 3, tag: 'a', radioGroup: null, skipLink: true };
const nav: FocusStop = { domIndex: 6, tag: 'a', radioGroup: null, skipLink: false };
const radios: FocusStop[] = [10, 12, 14].map((domIndex) => ({ domIndex, tag: 'input', radioGroup: 'theme', skipLink: false }));
const button: FocusStop = { domIndex: 20, tag: 'button', radioGroup: null, skipLink: false };
const focusables = [skip, nav, ...radios, button];
const withRing = (stop: FocusStop): FocusStop => ({ ...stop, ...ring });

function keyboard(walk: readonly FocusStop[], positiveTabindex: KeyboardReport['positiveTabindex'] = []): KeyboardReport {
  return { focusables, positiveTabindex, walk };
}

describe('keyboardVerdict (AC-47, AC-E36)', () => {
  it('passes a walk in DOM order, skip link first, one stop for a three-radio group', () => {
    // Chromium stops on the checked radio, here the second, which still counts as the group's stop.
    const radio = radios[1];
    if (radio === undefined) throw new Error('planted radios missing');
    expect(keyboardVerdict(keyboard([skip, nav, radio, button].map(withRing)))).toEqual({ ok: true });
  });

  it('fails a walk out of DOM order', () => {
    const verdict = keyboardVerdict(keyboard([skip, button, nav].map(withRing)));
    expect(verdict.ok).toBe(false);
    expect(verdict).toMatchObject({ reason: expect.stringMatching(/^Tab order /) });
  });

  it('fails a walk whose first stop is not the skip link', () => {
    expect(keyboardVerdict(keyboard([nav, skip].map(withRing)))).toEqual({ ok: false, reason: A11Y_MESSAGES.firstNotSkipLink('<a> at DOM index 6') });
  });

  it('fails a positive tabindex', () => {
    const verdict = keyboardVerdict(keyboard([skip, nav].map(withRing), [{ domIndex: 6, tag: 'a', tabindex: '2' }]));
    expect(verdict).toEqual({ ok: false, reason: A11Y_MESSAGES.positiveTabindex(1, '<a> tabindex=2') });
  });

  it('fails a stop with no visible focus indicator', () => {
    const bare = { ...nav, outlineStyle: 'none', outlineWidth: '0px', boxShadow: 'none' };
    const radio = radios[0];
    if (radio === undefined) throw new Error('planted radios missing');
    expect(keyboardVerdict(keyboard([withRing(skip), bare, withRing(radio), withRing(button)]))).toEqual({ ok: false, reason: A11Y_MESSAGES.noIndicator('<a> at DOM index 6') });
  });

  it('passes a box-shadow indicator and fails an empty walk', () => {
    const shadow = (stop: FocusStop): FocusStop => ({ ...stop, outlineStyle: 'none', outlineWidth: '0px', boxShadow: 'rgb(0, 0, 0) 0px 0px 0px 3px' });
    const radio = radios[2];
    if (radio === undefined) throw new Error('planted radios missing');
    expect(keyboardVerdict(keyboard([skip, nav, radio, button].map(shadow)))).toEqual({ ok: true });
    expect(keyboardVerdict(keyboard([]))).toEqual({ ok: false, reason: A11Y_MESSAGES.noFocus() });
  });

  it('fails a walk that stops on each radio of a group', () => {
    expect(keyboardVerdict(keyboard([skip, nav, ...radios, button].map(withRing)))).toEqual({ ok: false, reason: A11Y_MESSAGES.radioStops('theme', 3) });
  });
});

const cleanAxe: AxeReport = {
  version: '4.14.0',
  selected: ['html-has-lang', 'target-size', 'label-content-name-mismatch'],
  ran: ['html-has-lang', 'target-size', 'label-content-name-mismatch'],
  violations: [],
  incomplete: [],
};
const NO_ACCEPTED: readonly AcceptedIncomplete[] = [];
const svgNode = (target: string): { target: string; summary: string } => ({ target, summary: '' });

describe('axe verdicts (D-129)', () => {
  it('passes a clean record', () => {
    expect(axeReasons(cleanAxe, NO_ACCEPTED)).toEqual([]);
  });

  it('fails an empty selected-rule list', () => {
    expect(axeReasons({ ...cleanAxe, selected: [] }, NO_ACCEPTED)).toContain(A11Y_MESSAGES.noSelectedRules());
  });

  it('fails a selected-rule list that lacks target-size, and a run where it did not run', () => {
    const without = cleanAxe.selected.filter((id) => id !== 'target-size');
    expect(axeReasons({ ...cleanAxe, selected: without }, NO_ACCEPTED)).toEqual([A11Y_MESSAGES.ruleNotSelected('target-size')]);
    expect(axeReasons({ ...cleanAxe, ran: without }, NO_ACCEPTED)).toEqual([A11Y_MESSAGES.ruleNotRun('target-size')]);
  });

  it('fails an incomplete result that is not on the accepted list, and passes one that is', () => {
    const incomplete = [{ id: 'color-contrast', nodes: [{ target: 'p', summary: '' }] }];
    expect(axeReasons({ ...cleanAxe, incomplete }, NO_ACCEPTED)).toEqual([A11Y_MESSAGES.incomplete('color-contrast', 1, 'p')]);
    expect(axeReasons({ ...cleanAxe, incomplete }, [{ ruleId: 'color-contrast', targetPattern: '^p$', reason: 'planted' }])).toEqual([]);
  });

  it('accepts a color-contrast incomplete only on drawing text, never on page text', () => {
    const incomplete = [{ id: 'color-contrast', nodes: ['text[y="126"]', '.dwg-bubble-text', 'text', 'p', '.textlink', 'textarea', '.dwgx'].map(svgNode) }];
    expect(axeReasons({ ...cleanAxe, incomplete }, ACCEPTED_INCOMPLETE)).toEqual([A11Y_MESSAGES.incomplete('color-contrast', 4, 'p')]);
  });

  it('never accepts another rule on drawing text', () => {
    const incomplete = [{ id: 'link-in-text-block', nodes: [svgNode('text[y="126"]')] }];
    expect(axeReasons({ ...cleanAxe, incomplete }, ACCEPTED_INCOMPLETE)).toEqual([A11Y_MESSAGES.incomplete('link-in-text-block', 1, 'text[y="126"]')]);
  });

  it('counts the accepted nodes per rule, leaving the others out', () => {
    const incomplete = [{ id: 'color-contrast', nodes: ['text[y="126"]', '.dwg-lane', 'p'].map(svgNode) }];
    expect(countAccepted(incomplete, ACCEPTED_INCOMPLETE)).toEqual(new Map([['color-contrast', 2]]));
  });

  it('fails a violation', () => {
    const violations = [{ id: 'image-alt', nodes: [{ target: 'img', summary: 'Fix this' }] }];
    expect(axeReasons({ ...cleanAxe, violations }, NO_ACCEPTED)).toEqual([A11Y_MESSAGES.violation('image-alt', 1, 'img')]);
  });

  it('fails axe-core 4.13.0', () => {
    expect(axeReasons({ ...cleanAxe, version: '4.13.0' }, NO_ACCEPTED)).toEqual([A11Y_MESSAGES.axeVersionRan('4.13.0')]);
  });

  it('judges a whole AUDIT record: status, missing results, viewport and overflow', () => {
    const line: AuditLine = { route: '/', status: 200, theme: { dataTheme: null, ground: LIGHT_GROUND }, axe: cleanAxe, keyboard: keyboard([skip, nav, radios[0] ?? skip, button].map(withRing)), overflow: { scrollWidth: 320, innerWidth: 320 } };
    expect(auditReasons(line, 320, NO_ACCEPTED)).toEqual([]);
    expect(auditReasons(line, 320, NO_ACCEPTED, 200, 'dark')).toEqual([E2E_MESSAGES.themeNotTaken('dark', LIGHT_GROUND, DARK_GROUND)]);
    const { theme: _unread, ...withoutTheme } = line;
    expect(auditReasons(withoutTheme, 320, NO_ACCEPTED)).toEqual([A11Y_MESSAGES.themeAbsent()]);
    expect(auditReasons({ route: '/', status: 500 }, 320, NO_ACCEPTED)).toEqual([A11Y_MESSAGES.status(500, 200)]);
    expect(auditReasons({ ...line, status: 404 }, 320, NO_ACCEPTED, 404)).toEqual([]);
    expect(auditReasons(line, 320, NO_ACCEPTED, 404)).toEqual([A11Y_MESSAGES.status(200, 404)]);
    expect(auditReasons({ route: '/', status: 200 }, 320, NO_ACCEPTED)).toEqual([A11Y_MESSAGES.axeAbsent()]);
    expect(auditReasons({ ...line, overflow: { scrollWidth: 330, innerWidth: 300 } }, 320, NO_ACCEPTED)).toEqual([A11Y_MESSAGES.viewport(300, 320), A11Y_MESSAGES.overflow(330, 320)]);
  });
});

const reading = (dataTheme: string | null, ground: string): ThemeReading => ({ dataTheme, ground });
const DARK_PINNED = reading('dark', DARK_GROUND);

describe('the rendered theme verdicts (D-131, AC-42, AC-E28, C5)', () => {
  it('took hold when the read --ground equals the token value of the expected theme, and not otherwise', () => {
    expect(tookHoldVerdict(reading(null, LIGHT_GROUND), 'light')).toEqual({ ok: true });
    expect(tookHoldVerdict(reading('dark', DARK_GROUND), 'dark')).toEqual({ ok: true });
    expect(tookHoldVerdict(reading(null, DARK_GROUND), 'light')).toEqual({ ok: false, reason: E2E_MESSAGES.themeNotTaken('light', DARK_GROUND, LIGHT_GROUND) });
    expect(tookHoldVerdict(reading(null, ''), 'dark')).toEqual({ ok: false, reason: E2E_MESSAGES.themeNotTaken('dark', '', DARK_GROUND) });
  });

  it('a stored Dark needs data-theme dark as well as the dark --ground', () => {
    expect(storedThemeVerdict(DARK_PINNED, 'dark')).toEqual({ ok: true });
    expect(storedThemeVerdict(reading(null, DARK_GROUND), 'dark')).toEqual({ ok: false, reason: E2E_MESSAGES.themeAttribute(null, 'dark') });
    expect(storedThemeVerdict(reading('dark', LIGHT_GROUND), 'dark')).toEqual({ ok: false, reason: E2E_MESSAGES.themeNotTaken('dark', LIGHT_GROUND, DARK_GROUND) });
  });

  it('Device passes when the dark-OS and light-OS readings follow their token values with no data-theme', () => {
    expect(deviceVerdict(reading(null, DARK_GROUND), reading(null, LIGHT_GROUND))).toEqual({ ok: true });
  });

  it('Device fails when the dark-OS and light-OS readings are equal', () => {
    expect(deviceVerdict(reading(null, DARK_GROUND), reading(null, DARK_GROUND))).toEqual({ ok: false, reason: E2E_MESSAGES.deviceStill(DARK_GROUND) });
  });

  it('Device fails when either reading differs from its token value, and when data-theme is set', () => {
    expect(deviceVerdict(reading(null, '#123456'), reading(null, LIGHT_GROUND))).toEqual({ ok: false, reason: E2E_MESSAGES.themeNotTaken('dark', '#123456', DARK_GROUND) });
    expect(deviceVerdict(reading(null, DARK_GROUND), reading(null, '#123456'))).toEqual({ ok: false, reason: E2E_MESSAGES.themeNotTaken('light', '#123456', LIGHT_GROUND) });
    expect(deviceVerdict(reading('dark', DARK_GROUND), reading(null, LIGHT_GROUND))).toEqual({ ok: false, reason: E2E_MESSAGES.deviceAttribute('dark') });
  });

  it('the pin fails when Dark stored on a dark OS reads light after the OS turns light (AC-E28)', () => {
    expect(pinVerdict(DARK_PINNED, DARK_PINNED)).toEqual({ ok: true });
    expect(pinVerdict(DARK_PINNED, reading(null, LIGHT_GROUND))).toEqual({ ok: false, reason: E2E_MESSAGES.pinLost(null, LIGHT_GROUND) });
    expect(pinVerdict(reading('dark', LIGHT_GROUND), DARK_PINNED)).toEqual({ ok: false, reason: E2E_MESSAGES.themeNotTaken('dark', LIGHT_GROUND, DARK_GROUND) });
  });

  it('a Content Security Policy console line fails the rendered run, any other console error too', () => {
    const csp = "Executing inline script violates the following Content Security Policy directive 'script-src 'self''.";
    expect(consoleVerdict([])).toEqual({ ok: true });
    expect(consoleVerdict([csp])).toEqual({ ok: false, reason: E2E_MESSAGES.cspViolation(csp) });
    expect(consoleVerdict(['Uncaught TypeError: x is not a function'])).toEqual({ ok: false, reason: E2E_MESSAGES.consoleError('Uncaught TypeError: x is not a function') });
  });

  it('only the 404 page answering the unknown address is an expected 404 console line', () => {
    const notFound = 'Failed to load resource: the server responded with a status of 404 (Not Found)';
    expect(isExpectedNotFound({ text: notFound, url: `http://127.0.0.1:4000${UNKNOWN_PATH}` })).toBe(true);
    expect(isExpectedNotFound({ text: notFound, url: 'http://127.0.0.1:4000/_astro/missing.css' })).toBe(false);
    expect(isExpectedNotFound({ text: notFound, url: '' })).toBe(false);
    expect(isExpectedNotFound({ text: 'Uncaught TypeError: x is not a function', url: `http://127.0.0.1:4000${UNKNOWN_PATH}` })).toBe(false);
  });
});

const THEME_ORDER = ['device', 'light', 'dark'];
const BASE = 'http://127.0.0.1:4000';

function healthySwitch(route: string): SwitchReading {
  return {
    route,
    deviceStored: null,
    chosen: ['light', 'dark'].map((choice) => ({ choice, stored: choice, reloadedTheme: choice, reloadedChecked: choice })),
    osFlip: { light: LIGHT_GROUND, dark: DARK_GROUND },
    invalid: ['blue', '', 'DARK'].map((stored) => ({ stored, checked: 'device' })),
    domOrder: THEME_ORDER,
    boxOrders: [320, 1440].map((width) => ({ width, order: THEME_ORDER })),
    arrow: { before: null, after: 'light' },
  };
}

const healthyFonts = (route: string): FontsReading => ({
  route,
  families: SITE_FAMILIES.map((family) => ({ family, loaded: true, check: true })),
  control: { family: 'Fothering Undeclared Face', present: false },
});

const healthyRequests = (route: string): RequestsReading => ({
  route,
  page: `${BASE}${route}`,
  requests: [`${BASE}${route}`, `${BASE}/tokens.css`, `${BASE}/_astro/Sheet.css`, `${BASE}/_astro/Sheet.js`, `${BASE}/_astro/red-hat-text-latin-wght-normal.woff2`],
});

const failed = (reason: string): { ok: false; reason: string } => ({ ok: false, reason });

describe('switchVerdict (AC-41, AC-E29, AC-E30)', () => {
  it('passes a switch that stores, keeps, orders and follows as R8 locks it', () => {
    expect(switchVerdict(healthySwitch('/'))).toEqual({ ok: true });
  });

  it('fails when choosing Device leaves the stored key', () => {
    expect(switchVerdict({ ...healthySwitch('/'), deviceStored: 'dark' })).toEqual(failed(E2E_MESSAGES.deviceStored('dark')));
  });

  it('fails when Light or Dark is not stored, or was never chosen', () => {
    const chosen = healthySwitch('/').chosen.map((entry) => (entry.choice === 'light' ? { ...entry, stored: null } : entry));
    expect(switchVerdict({ ...healthySwitch('/'), chosen })).toEqual(failed(E2E_MESSAGES.choiceNotStored('light', null)));
    const onlyLight = healthySwitch('/').chosen.filter((entry) => entry.choice === 'light');
    expect(switchVerdict({ ...healthySwitch('/'), chosen: onlyLight })).toEqual(failed(E2E_MESSAGES.choiceMissing('dark')));
  });

  it('fails when a Light or Dark choice is not kept after a reload', () => {
    const chosen = healthySwitch('/').chosen.map((entry) => (entry.choice === 'dark' ? { ...entry, reloadedTheme: null, reloadedChecked: 'device' } : entry));
    expect(switchVerdict({ ...healthySwitch('/'), chosen })).toEqual(failed(E2E_MESSAGES.choiceNotKept('dark', null, 'device')));
  });

  it('fails when, with Device chosen, an OS change does not change --ground', () => {
    expect(switchVerdict({ ...healthySwitch('/'), osFlip: { light: LIGHT_GROUND, dark: LIGHT_GROUND } }))
      .toEqual(failed(E2E_MESSAGES.osNotFollowed(LIGHT_GROUND, LIGHT_GROUND, LIGHT_GROUND, DARK_GROUND)));
  });

  it.each(['blue', '', 'DARK'])('fails when a stored %j leaves a radio other than Device checked', (value) => {
    const invalid = healthySwitch('/').invalid.map((entry) => (entry.stored === value ? { ...entry, checked: 'dark' } : entry));
    expect(switchVerdict({ ...healthySwitch('/'), invalid })).toEqual(failed(E2E_MESSAGES.invalidChecked(value, 'dark')));
  });

  it('fails when an invalid stored value was never tried', () => {
    const invalid = healthySwitch('/').invalid.filter((entry) => entry.stored !== 'DARK');
    expect(switchVerdict({ ...healthySwitch('/'), invalid })).toEqual(failed(E2E_MESSAGES.invalidMissing('DARK')));
  });

  it('fails when the DOM order differs from Device, Light, Dark', () => {
    expect(switchVerdict({ ...healthySwitch('/'), domOrder: ['light', 'device', 'dark'] })).toEqual(failed(E2E_MESSAGES.domOrder(['light', 'device', 'dark'])));
  });

  it('fails when the left-to-right box order at a width differs, and when no box order was measured', () => {
    const boxOrders = [{ width: 320, order: THEME_ORDER }, { width: 1440, order: ['dark', 'light', 'device'] }];
    expect(switchVerdict({ ...healthySwitch('/'), boxOrders })).toEqual(failed(E2E_MESSAGES.boxOrder(1440, ['dark', 'light', 'device'])));
    expect(switchVerdict({ ...healthySwitch('/'), boxOrders: [] })).toEqual(failed(E2E_MESSAGES.noBoxOrder()));
  });

  it('fails when ArrowRight inside the group does not change data-theme', () => {
    expect(switchVerdict({ ...healthySwitch('/'), arrow: { before: null, after: null } })).toEqual(failed(E2E_MESSAGES.arrowStill(null)));
  });

  it('names every failure of one reading, not only the first', () => {
    const verdict = switchVerdict({ ...healthySwitch('/'), deviceStored: 'light', arrow: { before: 'dark', after: 'dark' } });
    expect(verdict).toEqual(failed(`${E2E_MESSAGES.deviceStored('light')}; ${E2E_MESSAGES.arrowStill('dark')}`));
  });
});

describe('fontsVerdict (D-135, AC-59 rendered half)', () => {
  it('passes when each of the three families has a loaded face and a true check, and the control reads absent', () => {
    expect(fontsVerdict(healthyFonts('/'))).toEqual({ ok: true });
  });

  it('fails a family with no face in document.fonts', () => {
    const families = healthyFonts('/').families.filter((entry) => entry.family !== 'Red Hat Mono');
    expect(fontsVerdict({ ...healthyFonts('/'), families })).toEqual(failed(E2E_MESSAGES.fontMissing('Red Hat Mono')));
  });

  it('fails a family whose faces have not loaded, and one whose check is false', () => {
    const notLoaded = healthyFonts('/').families.map((entry) => (entry.family === 'Red Hat Display' ? { ...entry, loaded: false } : entry));
    expect(fontsVerdict({ ...healthyFonts('/'), families: notLoaded })).toEqual(failed(E2E_MESSAGES.fontNotLoaded('Red Hat Display')));
    const unchecked = healthyFonts('/').families.map((entry) => (entry.family === 'Red Hat Text' ? { ...entry, check: false } : entry));
    expect(fontsVerdict({ ...healthyFonts('/'), families: unchecked })).toEqual(failed(E2E_MESSAGES.fontCheckFalse('Red Hat Text')));
  });

  it('fails when the undeclared control family reads present', () => {
    expect(fontsVerdict({ ...healthyFonts('/'), control: { family: 'Fothering Undeclared Face', present: true } })).toEqual(failed(E2E_MESSAGES.fontControl('Fothering Undeclared Face')));
  });
});

describe('requestsVerdict (AC-57, AC-E52)', () => {
  it('passes when every request comes from the page origin', () => {
    expect(requestsVerdict(healthyRequests('/'))).toEqual({ ok: true });
  });

  it('fails a request to another origin, protocol-relative ones resolved included', () => {
    const reading = { ...healthyRequests('/'), requests: [...healthyRequests('/').requests, 'https://fonts.gstatic.com/s/x.woff2', 'http://127.0.0.1:4001/x.js'] };
    expect(requestsVerdict(reading)).toEqual(failed(E2E_MESSAGES.foreignRequest(BASE, ['http://127.0.0.1:4001', 'https://fonts.gstatic.com'])));
  });

  it('gives the same verdict for the same requests in another order', () => {
    const requests = [...healthyRequests('/').requests, 'https://fonts.gstatic.com/s/x.woff2', 'http://127.0.0.1:4001/x.js'];
    const forward = requestsVerdict({ ...healthyRequests('/'), requests });
    expect(forward.ok).toBe(false);
    expect(requestsVerdict({ ...healthyRequests('/'), requests: [...requests].reverse() })).toEqual(forward);
    expect(requestsVerdict({ ...healthyRequests('/'), requests: [...healthyRequests('/').requests].reverse() })).toEqual({ ok: true });
  });

  it('fails a page that recorded no request at all', () => {
    expect(requestsVerdict({ ...healthyRequests('/'), requests: [] })).toEqual(failed(E2E_MESSAGES.noRequests()));
  });
});

describe('storageVerdict (AC-22, D-141)', () => {
  it('passes fothering-theme and fothering-flow in localStorage', () => {
    expect(storageVerdict({ local: ['fothering-theme', 'fothering-flow'], session: [] })).toEqual({ ok: true });
  });

  it('fails a localStorage key outside the two, and any sessionStorage key', () => {
    expect(storageVerdict({ local: ['fothering-theme', 'tracking-id'], session: [] })).toEqual(failed(E2E_MESSAGES.storageKeys(['tracking-id'])));
    expect(storageVerdict({ local: [], session: ['fothering-theme'] })).toEqual(failed(E2E_MESSAGES.storageKeys(['session:fothering-theme'])));
  });
});

describe('routesFromDist', () => {
  it('maps every built page except 404.html to its Workers route, sorted', () => {
    const planted = plantRepo({ pages: { 'index.html': 'a', 'replay/index.html': 'b', 'privacy.html': 'c', '404.html': 'd', 'replay/404.html': 'e', 'tokens.css': 'f' } });
    expect(routesFromDist(planted.dist)).toEqual(['/', '/privacy', '/replay/']);
  });
});

describe('the driver template and its writer (C2, T-05-04)', () => {
  it('refuses a template with no job token and one with two', () => {
    const folder = join(PLANT, 'templates');
    write(join(folder, 'none.js'), 'console.log(1);\n');
    write(join(folder, 'two.js'), `const a = ${DRIVER_JOB_TOKEN};\nconst b = ${DRIVER_JOB_TOKEN};\n`);
    expect(writeDriver(join(folder, 'none.js'), {}, join(folder, 'out-none.js'))).toEqual({ ok: false, tokens: 0 });
    expect(writeDriver(join(folder, 'two.js'), {}, join(folder, 'out-two.js'))).toEqual({ ok: false, tokens: 2 });
    expect(existsSync(join(folder, 'out-none.js')) || existsSync(join(folder, 'out-two.js'))).toBe(false);
  });

  it('writes the job only as one JSON literal, even when its strings look like code or replacement patterns', () => {
    const job = { base: 'http://127.0.0.1:1', routes: ['/'], note: "$& $' */ console.log('x'); /*" };
    const out = join(PLANT, 'templates', 'driver.js');
    expect(writeDriver(TEMPLATE, job, out)).toEqual({ ok: true, path: out });
    const written = readFileSync(out, 'utf8');
    const literal = JSON.stringify(job);
    expect(written).toBe(readFileSync(TEMPLATE, 'utf8').replace(DRIVER_JOB_TOKEN, () => literal));
    expect(written.split(literal)).toHaveLength(2);
    const match = /^const JOB = (.*);$/m.exec(written);
    expect(JSON.parse(match?.[1] ?? 'null')).toEqual(job);
  });

  it('no committed driver template calls the page init-script API', () => {
    const templates = readdirSync(join(REPO_ROOT, 'scripts')).filter((name) => name.endsWith('.devbrowser.js'));
    expect(templates).toContain('a11y.devbrowser.js');
    for (const name of templates) {
      expect(readFileSync(join(REPO_ROOT, 'scripts', name), 'utf8'), name).not.toMatch(/addInitScript/);
    }
  });
});

describe('stageAxeSource (T-05-05)', () => {
  it('copies axe into the planted home folder under a run-unique name and its remover deletes it', () => {
    const planted = plantRepo();
    const first = stageAxeSource(planted.repoRoot, planted.homeDir);
    const second = stageAxeSource(planted.repoRoot, planted.homeDir);
    if (!first.ok || !second.ok) throw new Error('staging failed');
    expect(first.name).not.toBe(second.name);
    expect(readFileSync(join(planted.homeDir, '.dev-browser', 'tmp', first.name), 'utf8')).toBe('/* planted axe */\n');
    first.remove();
    second.remove();
    expect(readdirSync(join(planted.homeDir, '.dev-browser', 'tmp'))).toEqual([]);
  });
});

describe('runDriver', () => {
  it('kills a launcher that never exits at its outer timeout and reports it', async () => {
    const planted = plantRepo({ scenario: { hang: true } });
    const started = Date.now();
    const run = await runDriver({
      launcher: join(planted.globalModules, 'dev-browser', 'bin', 'dev-browser.js'),
      driverPath: join(planted.repoRoot, 'scripts', 'a11y.devbrowser.js'),
      timeoutSeconds: 1,
      outerTimeoutMs: 1000,
    });
    expect(run.timedOut).toBe(true);
    expect(run.exitCode).toBeNull();
    expect(Date.now() - started).toBeLessThan(15_000);
  });

  it('reports a launcher that cannot start', async () => {
    const run = await runDriver({ launcher: join(PLANT, 'no-such-launcher.js'), driverPath: TEMPLATE, timeoutSeconds: 1, outerTimeoutMs: 10_000 });
    expect(run.timedOut).toBe(false);
    expect(run.exitCode).not.toBe(0);
  });
});

function cliIo(onStop: CliIo['waitForStop'] = () => Promise.resolve()): { io: CliIo; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (line) => out.push(line), err: (line) => err.push(line), homeDir: join(PLANT, 'cli-home'), waitForStop: onStop }, out, err };
}

describe('cli main', () => {
  it('preview serves a planted dist until stopped, then closes', async () => {
    const planted = plantRepo();
    let status = 0;
    const { io, out } = cliIo(async (server) => {
      status = (await fetch(`${server.url}/`)).status;
    });
    expect(await main(['preview', '--repo-root', planted.repoRoot, '--dist', planted.dist], io)).toBe(0);
    expect(status).toBe(200);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatch(/^\[preview\] serving http:\/\/127\.0\.0\.1:\d+\/ on 127\.0\.0\.1/);
  });

  it('preview reports a server that cannot start', async () => {
    const planted = plantRepo();
    const { io, err } = cliIo();
    expect(await main(['preview', '--repo-root', planted.repoRoot, '--dist', join(planted.repoRoot, 'no-dist')], io)).toBe(1);
    expect(err[0]).toMatch(/^\[preview\] the preview server did not start: /);
  });

  it('a11y runs the audit with the given folders', async () => {
    const planted = plantRepo();
    const out: string[] = [];
    const io: CliIo = { out: (line) => out.push(line), err: () => undefined, homeDir: planted.homeDir, waitForStop: () => Promise.resolve() };
    expect(await main(['a11y', '--repo-root', planted.repoRoot, '--global-modules', planted.globalModules], io)).toBe(0);
    expect(out.at(-1)).toBe(A11Y_MESSAGES.pass(3, 2, 3, 0));
  });

  it('the process io writes to the console and the preview stops on SIGINT or SIGTERM', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    PROCESS_IO.out('to stdout');
    PROCESS_IO.err('to stderr');
    expect([log.mock.calls, error.mock.calls]).toEqual([[['to stdout']], [['to stderr']]]);
    log.mockRestore();
    error.mockRestore();
    for (const signal of ['SIGINT', 'SIGTERM']) {
      const source = new EventEmitter();
      const stopped = waitForSignal(source);
      source.emit(signal);
      await expect(stopped, signal).resolves.toBeUndefined();
    }
  });

  it('refuses a missing repo root, a missing global folder, an unknown subcommand and a stray option', async () => {
    const cases: [readonly string[], string][] = [
      [['a11y'], A11Y_MESSAGES.missingOption('--repo-root')],
      [['a11y', '--repo-root', PLANT], A11Y_MESSAGES.missingOption('--global-modules')],
      [['deploy', '--repo-root', PLANT], A11Y_MESSAGES.unknownSubcommand('deploy')],
      [[], A11Y_MESSAGES.missingOption('--repo-root')],
      [['a11y', '--verbose'], A11Y_MESSAGES.usage()],
    ];
    for (const [argv, message] of cases) {
      const { io, err } = cliIo();
      expect(await main(argv, io), argv.join(' ')).toBe(1);
      expect(err, argv.join(' ')).toEqual([message]);
    }
  });
});

const prose = (lines: readonly string[], blocks = 1): LinesReading[] => [{ route: '/', blocks, lines }];

describe('lineVerdict (AC-64, AC-E53, AC-E54)', () => {
  it('passes a line of 80 grapheme clusters', () => {
    expect(lineVerdict(prose(['a'.repeat(80)]))).toEqual({ ok: true });
  });

  it('fails a line of 81 grapheme clusters, naming the route and the count', () => {
    expect(lineVerdict(prose(['a'.repeat(81)]))).toEqual({ ok: false, reason: E2E_MESSAGES.lineTooLong('/', 81, 'a'.repeat(81)) });
  });

  it('does not count trailing spaces', () => {
    expect(lineVerdict(prose([`${'a'.repeat(80)}   `]))).toEqual({ ok: true });
  });

  it('counts an emoji and a letter with a combining mark as one cluster each', () => {
    const emoji = String.fromCodePoint(0x1f44d);
    const accented = `e${String.fromCharCode(0x301)}`;
    const line = `${'a'.repeat(78)}${emoji}${accented}`;
    expect(line.length).toBe(82);
    expect(lineVerdict(prose([line]))).toEqual({ ok: true });
    expect(lineVerdict(prose([`${line}a`])).ok).toBe(false);
  });

  it('fails, never passes, when it measured zero prose blocks', () => {
    expect(lineVerdict(prose([], 0))).toEqual({ ok: false, reason: E2E_MESSAGES.noProseBlocks() });
    expect(lineVerdict([])).toEqual({ ok: false, reason: E2E_MESSAGES.noProseBlocks() });
  });
});

describe('identifierBreakVerdict (AC-E55)', () => {
  const verdict = (lines: readonly string[]) => identifierBreakVerdict({ text: lines.join(''), lines });

  it('passes SendingOptions.SendingEnabled broken right after the dot', () => {
    expect(verdict(['SendingOptions.', 'SendingEnabled'])).toEqual({ ok: true });
  });

  it('fails SendingOptions.SendingEnabled broken inside a name', () => {
    expect(verdict(['SendingOpt', 'ions.SendingEnabled'])).toEqual({ ok: false, reason: E2E_MESSAGES.identifierBreak('SendingOptions.SendingEnabled', ['SendingOpt', 'ions.SendingEnabled']) });
  });

  it('passes an identifier without a dot on one line', () => {
    expect(verdict(['batch=2026-10-14-b'])).toEqual({ ok: true });
  });

  it('fails an identifier without a dot broken anywhere', () => {
    expect(verdict(['batch=2026-', '10-14-b']).ok).toBe(false);
  });
});

const box = (left: number, top: number, right: number, bottom: number): Box => ({ left, top, right, bottom });
const drawing = (texts: readonly [string, Box][]): DrawingReading => ({ box: box(0, 0, 300, 200), texts: texts.map(([text, at]) => ({ text, box: at })) });

describe('overlapVerdict (AC-65)', () => {
  it('passes a tag clear of every drawing text', () => {
    expect(overlapVerdict({ tag: box(0, 150, 200, 400), drawings: [drawing([['fothering-bulk', box(10, 100, 120, 115)]])] })).toEqual({ ok: true });
  });

  it('fails a tag overlapping one SVG text box', () => {
    expect(overlapVerdict({ tag: box(0, 150, 200, 400), drawings: [drawing([['SendingEnabled: false', box(150, 140, 290, 155)]])] })).toEqual({ ok: false, reason: E2E_MESSAGES.tagOverlap('SendingEnabled: false') });
  });

  it('passes a tag whose edge touches a text box', () => {
    expect(overlapVerdict({ tag: box(0, 150, 200, 400), drawings: [drawing([['label', box(150, 135, 290, 150)]])] })).toEqual({ ok: true });
  });

  it('fails an SVG text box one pixel past its SVG box', () => {
    expect(overlapVerdict({ tag: null, drawings: [drawing([['SendingEnabled: false', box(150, 140, 301, 155)]])] })).toEqual({ ok: false, reason: E2E_MESSAGES.textOutside('SendingEnabled: false') });
  });
});

const flowState = (running: number, labels: readonly string[] = ['Run flow']): FlowState => ({ running, labels });
const healthyFlow: FlowReading = {
  route: '/',
  width: 320,
  movingOnLoad: true,
  controls: [{ label: 'Stop flow', width: 88, height: 44 }],
  afterClick: flowState(0),
  afterReload: flowState(0),
  reduced: 0,
  storedRunningReduced: 3,
  storedStopped: 0,
};
const stillRoute: FlowReading = { ...healthyFlow, movingOnLoad: false, controls: [], afterClick: flowState(0, []), afterReload: flowState(0, []), storedRunningReduced: 0 };

describe('flowVerdict (AC-43, AC-44, AC-E31, AC-E32, UI-SPEC E3)', () => {
  it('passes a moving route whose visible Stop flow stops it for good, and a still route with no control', () => {
    expect(flowVerdict(healthyFlow)).toEqual({ ok: true });
    expect(flowVerdict(stillRoute)).toEqual({ ok: true });
  });

  it('fails a route moving on load with no visible flow control', () => {
    expect(flowVerdict({ ...healthyFlow, controls: [] })).toEqual({ ok: false, reason: E2E_MESSAGES.flowNoControl(320) });
  });

  it('fails running animations left after clicking every visible control', () => {
    expect(flowVerdict({ ...healthyFlow, afterClick: flowState(2) })).toEqual({ ok: false, reason: E2E_MESSAGES.flowStillRunning(320, 2) });
  });

  it('fails a control that does not read Run flow after the click', () => {
    expect(flowVerdict({ ...healthyFlow, afterClick: flowState(0, ['Stop flow']) })).toEqual({ ok: false, reason: E2E_MESSAGES.flowLabel(320, ['Stop flow']) });
  });

  it('fails a reload that runs the flow again after a stop', () => {
    expect(flowVerdict({ ...healthyFlow, afterReload: flowState(3) })).toEqual({ ok: false, reason: E2E_MESSAGES.flowReloadRuns(320, 3) });
  });

  it('fails a visible control on a route with no motion on load', () => {
    expect(flowVerdict({ ...stillRoute, controls: healthyFlow.controls })).toEqual({ ok: false, reason: E2E_MESSAGES.flowControlWithoutMotion(320) });
  });

  it('fails a reduced-motion run with no stored choice and a running animation', () => {
    expect(flowVerdict({ ...healthyFlow, reduced: 1 })).toEqual({ ok: false, reason: E2E_MESSAGES.flowReduced(320, 1) });
  });

  it('fails a stored running choice under reduced motion with no running animation', () => {
    expect(flowVerdict({ ...healthyFlow, storedRunningReduced: 0 })).toEqual({ ok: false, reason: E2E_MESSAGES.flowStoredRunning(320) });
  });

  it('fails a stored stopped choice that leaves the flow running', () => {
    expect(flowVerdict({ ...healthyFlow, storedStopped: 2 })).toEqual({ ok: false, reason: E2E_MESSAGES.flowStoredStopped(320, 2) });
  });

  it('fails a control smaller than 44 by 44 pixels', () => {
    expect(flowVerdict({ ...healthyFlow, controls: [{ label: 'Stop flow', width: 88, height: 43 }] })).toEqual({ ok: false, reason: E2E_MESSAGES.flowSmallControl(320, 88, 43) });
  });
});

describe('flowTabVerdict (AC-E33, held-out)', () => {
  it('passes a Stop flow button reached before the first focusable of the next section', () => {
    expect(flowTabVerdict({ width: 1440, flows: [{ flowStep: 6, nextStep: 7 }] })).toEqual({ ok: true });
    expect(flowTabVerdict({ width: 1440, flows: [{ flowStep: 6, nextStep: null }] })).toEqual({ ok: true });
  });

  it('fails a Stop flow button reached after the first focusable of the next section', () => {
    expect(flowTabVerdict({ width: 1440, flows: [{ flowStep: 9, nextStep: 7 }] })).toEqual({ ok: false, reason: E2E_MESSAGES.flowTabLate(1440) });
  });

  it('fails a Stop flow button Tab never reaches', () => {
    expect(flowTabVerdict({ width: 320, flows: [{ flowStep: null, nextStep: 7 }] })).toEqual({ ok: false, reason: E2E_MESSAGES.flowTabUnreached(320) });
  });
});

describe('copyBuild (AC-12, AC-E10 build half)', () => {
  it('builds a project copy with an artifact whose provenance is measured and fails naming the field and the file, leaving no folder', () => {
    const artifact = JSON.parse(readFileSync(join(REPO_ROOT, 'packages', 'web', 'src', 'fixtures', 'replay-incident.json'), 'utf8')) as { events: { provenance: string }[] };
    const [first] = artifact.events;
    if (first === undefined) throw new Error('the committed artifact holds no event');
    first.provenance = 'measured';
    const run = copyBuild({ repoRoot: REPO_ROOT, swap: { path: 'src/fixtures/replay-incident.json', text: JSON.stringify(artifact) }, id: 'harness-test' });
    expect(run.status).not.toBe(0);
    expect(run.output).toContain('packages/web/src/fixtures/replay-incident.json: events[0].provenance:');
    expect(existsSync(run.folder)).toBe(false);
  }, 240_000);
});

describe('the built checks through the CLI and the e2e step (D-150, D-151)', () => {
  const trees: ReturnType<typeof plantDist>[] = [];
  const plantSite = (files: Record<string, string>): ReturnType<typeof plantDist> => {
    const tree = plantDist(files);
    trees.push(tree);
    return tree;
  };
  afterAll(() => {
    for (const tree of trees) tree.remove();
  });

  const dashed = plantSite(completeSite({ 'index.html': '<p>closed \u2014 one lane</p>', 'replay/index.html': '<p>clean - text</p>' }));
  const clean = plantSite(completeSite({ 'index.html': '<p>closed - one lane</p>' }));

  async function builtChecks(dist: string, ...flags: string[]): Promise<{ code: number; out: string[] }> {
    const { io, out } = cliIo();
    const code = await main(['built-checks', '--repo-root', dashed.root, '--dist', dist, ...flags], io);
    allOutput.push(...out);
    return { code, out };
  }

  it('built-checks over a dist holding an em dash returns 1 and prints the route and the text', async () => {
    const { code, out } = await builtChecks(dashed.dist);
    expect(code).toBe(1);
    expect(out.some((line) => line.startsWith('[built-checks] dash /: ') && line.includes('closed \u2014 one lane'))).toBe(true);
  });

  it('built-checks through the real entry, scripts/site-tool.mjs, exits 1 over the em-dash dist naming the route and the text', () => {
    const run = spawnSync(process.execPath, [join(REPO_ROOT, 'scripts', 'site-tool.mjs'), 'built-checks', '--dist', dashed.dist], { cwd: REPO_ROOT, encoding: 'utf8' });
    expect(run.status, run.stderr).toBe(1);
    expect(run.stdout).toMatch(/^\[built-checks\] dash \/: .*closed \u2014 one lane/m);
    expect(run.stdout).toContain(E2E_MESSAGES.checksFail(''));
  });

  it('built-checks over a clean dist returns 0', async () => {
    const { code, out } = await builtChecks(clean.dist);
    expect(code).toBe(0);
    expect(out.at(-1)).toBe(E2E_MESSAGES.checksPass(1));
  });

  it('runSiteE2e over a missing dist returns 1 with its catalogue message', async () => {
    const lines: string[] = [];
    const missing = join(clean.root, 'no-such-repo');
    expect(await runSiteE2e({ repoRoot: missing, globalModules: missing, print: (line) => lines.push(line) })).toBe(1);
    expect(lines).toEqual([E2E_MESSAGES.fail(E2E_MESSAGES.noDist(join(missing, 'packages', 'web', 'dist')))]);
  });

  it('--expect dash over the em-dash dist returns 0', async () => {
    expect((await builtChecks(dashed.dist, '--expect', 'dash')).code).toBe(0);
  });

  it('--expect dash over the clean dist returns 1 naming dash as expected with no finding', async () => {
    const { code, out } = await builtChecks(clean.dist, '--expect', 'dash');
    expect(code).toBe(1);
    expect(out).toContain(E2E_MESSAGES.checksFail(E2E_MESSAGES.expectedMissing('dash')));
  });

  it('--expect no-such-rule returns 1 naming the unregistered id', async () => {
    const { code, out } = await builtChecks(dashed.dist, '--expect', 'no-such-rule');
    expect(code).toBe(1);
    expect(out).toContain(E2E_MESSAGES.checksFail(E2E_MESSAGES.unregistered('no-such-rule')));
  });

  it('the e2e step and the built-checks subcommand judge one build with equal contexts', async () => {
    expect(loadCheckContext(dashed.root)).toEqual(loadCheckContext(dashed.root));
    const e2eLines: string[] = [];
    expect(await runSiteE2e({ repoRoot: dashed.root, globalModules: dashed.root, print: (line) => e2eLines.push(line), clientSecretsScript: SECRETS_SCRIPT, sizeLimit: passingSize })).toBe(1);
    const { out } = await builtChecks(dashed.dist);
    const findingLines = (lines: readonly string[]): string[] => lines.filter((line) => line.startsWith('[built-checks] dash '));
    expect(findingLines(e2eLines)).toEqual(findingLines(out));
    expect(findingLines(out)).toHaveLength(1);
    allOutput.push(...e2eLines);
  });

  it('--expect dash over a dist with an em dash and a reply promise names reply-promise as unexpected, and --allow reply-promise passes it', async () => {
    const both = plantSite(completeSite({ 'index.html': '<p>closed &mdash; one lane</p><p>Reply to approve the pause.</p>' }));
    const strict = await builtChecks(both.dist, '--expect', 'dash');
    expect(strict.code).toBe(1);
    expect(strict.out).toContain(E2E_MESSAGES.checksFail(E2E_MESSAGES.unexpected('reply-promise', 1)));
    expect((await builtChecks(both.dist, '--expect', 'dash', '--allow', 'reply-promise')).code).toBe(0);
  });

  const copyDist = (dist: string, change?: (outDir: string) => void) => (outDir: string): SecondBuildRun => {
    cpSync(dist, outDir, { recursive: true });
    change?.(outDir);
    return { status: 0, output: '' };
  };

  type SiteLines = Partial<Record<'THEME' | 'DEVICE' | 'PIN' | 'STORAGE', unknown>>;
  type RouteLines = Partial<Record<'SWITCH' | 'FONTS' | 'REQUESTS' | 'LINES' | 'NARROW', (route: string) => unknown>>;
  type WidthLines = Partial<Record<'FLOW' | 'TABFLOW', (route: string, width: number) => unknown>>;
  // The planted tree's one page, then the unknown address that answers with the 404 page.
  const SITE_ROUTES = ['/', UNKNOWN_PATH];
  const healthyLines = (route: string): LinesReading => ({ route, blocks: 1, lines: ['closed - one lane'] });
  // The landing carries the one drawing; its tag hangs clear of the drawing text.
  const healthyNarrow = (route: string): unknown => ({
    route,
    tag: route === '/' ? box(0, 200, 266, 500) : null,
    drawings: route === '/' ? [drawing([['fothering-bulk', box(10, 100, 120, 115)]])] : [],
    identifiers: route === '/' ? [{ text: 'SendingOptions.SendingEnabled', lines: ['SendingOptions.', 'SendingEnabled'] }] : [],
  });
  const healthyFlowLine = (route: string, width: number): FlowReading => (route === '/' ? { ...healthyFlow, route, width } : { ...stillRoute, route, width });
  const healthyTab = (route: string, width: number): unknown => ({ route, width, flows: route === '/' ? [{ flowStep: 6, nextStep: null }] : [] });

  // What a healthy site driver prints: a Dark stored on a light OS, Device following the OS with no
  // reload, Dark stored on a dark OS kept when the OS turns light, then the switch, fonts and
  // requests of every route and the storage keys left after using the switch.
  function siteLines(overrides: SiteLines = {}, consoleErrors: readonly string[] = [], routeOverrides: RouteLines = {}, widthOverrides: WidthLines = {}): string[] {
    const checks: SiteLines = {
      THEME: DARK_PINNED,
      DEVICE: { dark: reading(null, DARK_GROUND), light: reading(null, LIGHT_GROUND) },
      PIN: { before: DARK_PINNED, after: DARK_PINNED },
      STORAGE: { local: ['fothering-theme'], session: [] },
      ...overrides,
    };
    const perRoute = { SWITCH: healthySwitch, FONTS: healthyFonts, REQUESTS: healthyRequests, LINES: healthyLines, NARROW: healthyNarrow, ...routeOverrides } as Required<RouteLines>;
    const perWidth = { FLOW: healthyFlowLine, TABFLOW: healthyTab, ...widthOverrides } as Required<WidthLines>;
    const printed = (check: string, value: unknown): string[] => (value === undefined ? [] : [`${check} ${JSON.stringify(value)}`]);
    return [
      ...Object.entries(checks).flatMap(([check, value]) => printed(check, value)),
      ...Object.entries(perRoute).flatMap(([check, make]) => SITE_ROUTES.flatMap((route) => printed(check, make(route)))),
      ...Object.entries(perWidth).flatMap(([check, make]) => SITE_ROUTES.flatMap((route) => [320, 1440].flatMap((width) => printed(check, make(route, width))))),
      ...consoleErrors.map((text) => `CONSOLE ${JSON.stringify({ type: 'error', text })}`),
    ];
  }

  const passingSize = (): SizeRun => ({ status: 0, output: '  Size limit: 2 kB\n  Size:       688 B brotlied' });
  const REFUSED_ARTIFACT = "packages/web/src/fixtures/replay-incident.json: events[0].provenance: 'measured' is not one of doc-derived, simulator-captured, live, generated. Use one of those values.";
  const refusedCopy = (): CopyBuildRun => ({ status: 1, output: REFUSED_ARTIFACT, folder: join(PLANT, 'gone') });

  // The rendered step needs a launcher, the Workers config and the driver template under the planted
  // root; the stand-in launcher only reads the job out of the written driver and prints the lines.
  function plantBrowser(tree: ReturnType<typeof plantDist>, site: SiteScenario = { lines: siteLines() }): string {
    const globalModules = join(tree.root, 'global');
    write(join(tree.root, 'packages', 'web', 'wrangler.jsonc'), readFileSync(join(REPO_ROOT, 'packages', 'web', 'wrangler.jsonc'), 'utf8'));
    write(join(tree.root, 'scripts', 'site.devbrowser.js'), `const JOB = ${DRIVER_JOB_TOKEN};\nconsole.log('done');\n`);
    plantLauncher(globalModules, '0.2.9', { site }, join(tree.root, 'home'));
    return globalModules;
  }

  async function e2e(tree: ReturnType<typeof plantDist>, extra: Partial<SiteE2eOptions> = {}, site?: SiteScenario): Promise<{ code: number; lines: string[] }> {
    const lines: string[] = [];
    const globalModules = plantBrowser(tree, site);
    const code = await runSiteE2e({ repoRoot: tree.root, globalModules, print: (line) => lines.push(line), clientSecretsScript: SECRETS_SCRIPT, secondBuild: copyDist(tree.dist), sizeLimit: passingSize, brokenArtifactBuild: refusedCopy, ...extra });
    allOutput.push(...lines);
    return { code, lines };
  }

  const renderedTree = (): ReturnType<typeof plantDist> => plantSite(completeSite({ 'index.html': '<p>closed - one lane</p>' }));

  function stubScript(name: string, exitCode: number): string {
    const path = join(PLANT, 'stubs', `${name}.mjs`);
    write(path, `console.log('[client-secrets] planted stub');\nprocess.exit(${exitCode});\n`);
    return path;
  }

  it('runSiteE2e runs the client-secret scan, the file budget, the size budget, the built checks, the second build and the rendered checks in order, then passes', async () => {
    const tree = renderedTree();
    const { code, lines } = await e2e(tree);
    expect(code).toBe(0);
    const steps = lines.filter((line) => line.startsWith('[e2e] step '));
    expect(steps).toEqual(['client-secrets', 'file-budget', 'size', 'built-checks', 'second-build', 'copy-build', 'rendered'].map((name) => E2E_MESSAGES.step(name)));
    expect(lines.at(-1)).toBe(E2E_MESSAGES.pass(1, 7));
    expect(existsSync(join(tree.root, 'dist', 'site-second-build'))).toBe(false);
  });

  it('the size step passes on a size-limit exit of 0 and prints what it measured', async () => {
    const { code, lines } = await e2e(renderedTree());
    expect(code).toBe(0);
    expect(lines.filter((line) => line.trim() === 'Size:       688 B brotlied')).toHaveLength(1);
    expect(lines).toContain(E2E_MESSAGES.step('size'));
  });

  it('the size step fails when size-limit exits non-zero, before the built checks run', async () => {
    const { code, lines } = await e2e(renderedTree(), { sizeLimit: () => ({ status: 1, output: 'Package size limit has exceeded by 188 B' }) });
    expect(code).toBe(1);
    expect(lines).toContain('Package size limit has exceeded by 188 B');
    expect(lines.at(-1)).toBe(E2E_MESSAGES.fail(E2E_MESSAGES.sizeLimit(1)));
    expect(lines).not.toContain(E2E_MESSAGES.step('built-checks'));
  });

  it('the rendered step prints one ok line per check, the switch, fonts and requests lines naming every route', async () => {
    const { code, lines } = await e2e(renderedTree());
    expect(code).toBe(0);
    const rendered = lines.filter((line) => line.startsWith('[e2e] rendered '));
    expect(rendered.slice(0, 3)).toEqual([
      E2E_MESSAGES.renderedOk('THEME', `Dark stored on a light OS painted --ground ${DARK_GROUND}`),
      E2E_MESSAGES.renderedOk('DEVICE', `--ground followed the OS from ${DARK_GROUND} to ${LIGHT_GROUND} with no reload`),
      E2E_MESSAGES.renderedOk('PIN', `Dark stored on a dark OS kept --ground ${DARK_GROUND} after the OS turned light`),
    ]);
    for (const check of ['SWITCH', 'FONTS', 'REQUESTS']) {
      const line = rendered.find((text) => text.startsWith(`[e2e] rendered ${check}: ok, `));
      expect(line, check).toBeDefined();
      for (const route of SITE_ROUTES) expect(line, `${check} ${route}`).toContain(route);
    }
    expect(rendered.find((text) => text.startsWith('[e2e] rendered STORAGE: ok, '))).toContain('fothering-theme');
    expect(rendered.at(-1)).toBe(E2E_MESSAGES.renderedOk('CONSOLE', 'no console error, no Content Security Policy violation'));
  });

  it('the copy-build step fails when the broken artifact builds, and when the build failure names neither the file nor the field', async () => {
    const built = await e2e(renderedTree(), { brokenArtifactBuild: () => ({ status: 0, output: '', folder: join(PLANT, 'gone') }) });
    expect(built.code).toBe(1);
    expect(built.lines.at(-1)).toBe(E2E_MESSAGES.fail(E2E_MESSAGES.copyBuildPassed()));
    const unnamed = await e2e(renderedTree(), { brokenArtifactBuild: () => ({ status: 1, output: 'vite exploded', folder: join(PLANT, 'gone') }) });
    expect(unnamed.lines.at(-1)).toBe(E2E_MESSAGES.fail(E2E_MESSAGES.copyBuildUnnamed('vite exploded')));
    expect(unnamed.lines).not.toContain(E2E_MESSAGES.step('rendered'));
  });

  it('the copy-build step fails when the project copy folder is left behind', async () => {
    const left = join(PLANT, 'left-copy');
    mkdirSync(left, { recursive: true });
    const { code, lines } = await e2e(renderedTree(), { brokenArtifactBuild: () => ({ status: 1, output: REFUSED_ARTIFACT, folder: left }) });
    expect(code).toBe(1);
    expect(lines.at(-1)).toBe(E2E_MESSAGES.fail(E2E_MESSAGES.copyBuildLeft(left)));
  });

  it('the rendered step prints the flow lines naming movingOnLoad for every route at 320 and 1440, and the measured prose blocks', async () => {
    const { code, lines } = await e2e(renderedTree());
    expect(code).toBe(0);
    const flow = lines.find((line) => line.startsWith('[e2e] rendered FLOW: ok, '));
    for (const route of SITE_ROUTES) {
      for (const width of [320, 1440]) expect(flow, `${route} ${width}`).toContain(`${route} at ${width} px movingOnLoad ${String(route === '/')}`);
    }
    expect(lines).toContain(E2E_MESSAGES.renderedOk('LINES', '2 prose block(s) measured at 1440 px, the longest line 17 characters'));
    expect(lines.find((line) => line.startsWith('[e2e] rendered NARROW: ok, '))).toContain('1 drawing text(s)');
    expect(lines.find((line) => line.startsWith('[e2e] rendered TABFLOW: ok, '))).toBeDefined();
  });

  it('the rendered step fails a moving route with no visible flow control, a long line, a covered label and a late Tab stop, naming the route', async () => {
    const widthOverrides: WidthLines = {
      FLOW: (route, width) => ({ ...healthyFlowLine(route, width), ...(route === '/' && width === 320 ? { controls: [] } : {}) }),
      TABFLOW: (route, width) => (route === '/' ? { route, width, flows: [{ flowStep: 9, nextStep: 7 }] } : healthyTab(route, width)),
    };
    const routeOverrides: RouteLines = {
      LINES: (route) => ({ ...healthyLines(route), lines: [route === '/' ? 'a'.repeat(81) : 'short'] }),
      NARROW: (route) => (route === '/' ? { route, tag: box(0, 100, 266, 500), drawings: [drawing([['fothering-bulk', box(10, 100, 120, 115)]])], identifiers: [] } : healthyNarrow(route)),
    };
    const { code, lines } = await e2e(renderedTree(), {}, { lines: siteLines({}, [], routeOverrides, widthOverrides) });
    expect(code).toBe(1);
    expect(lines).toContain(E2E_MESSAGES.renderedFailed('FLOW', `/: ${E2E_MESSAGES.flowNoControl(320)}`));
    expect(lines).toContain(E2E_MESSAGES.renderedFailed('LINES', E2E_MESSAGES.lineTooLong('/', 81, 'a'.repeat(81))));
    expect(lines).toContain(E2E_MESSAGES.renderedFailed('NARROW', `/: ${E2E_MESSAGES.tagOverlap('fothering-bulk')}`));
    expect(lines).toContain(E2E_MESSAGES.renderedFailed('TABFLOW', `/: ${E2E_MESSAGES.flowTabLate(320)}; /: ${E2E_MESSAGES.flowTabLate(1440)}`));
  });

  it('the rendered step fails a run that measured zero prose blocks, no drawing text, or no flow line for a width', async () => {
    const routeOverrides: RouteLines = { LINES: (route) => ({ route, blocks: 0, lines: [] }), NARROW: (route) => ({ route, tag: null, drawings: [], identifiers: [] }) };
    const widthOverrides: WidthLines = { FLOW: (route, width) => (width === 320 ? undefined : healthyFlowLine(route, width)) };
    const { code, lines } = await e2e(renderedTree(), {}, { lines: siteLines({}, [], routeOverrides, widthOverrides) });
    expect(code).toBe(1);
    expect(lines).toContain(E2E_MESSAGES.renderedFailed('LINES', E2E_MESSAGES.noProseBlocks()));
    expect(lines).toContain(E2E_MESSAGES.renderedFailed('NARROW', E2E_MESSAGES.noDrawingText()));
    expect(lines.find((line) => line.startsWith('[e2e] rendered FLOW: failed: '))).toContain(E2E_MESSAGES.renderedMissingRoute('FLOW', '/ at 320 px'));
  });

  it('the rendered step fails a route whose switch, fonts or requests verdict fails, naming the route', async () => {
    const switchFails = await e2e(renderedTree(), {}, { lines: siteLines({}, [], { SWITCH: (route) => ({ ...healthySwitch(route), deviceStored: route === UNKNOWN_PATH ? 'dark' : null }) }) });
    expect(switchFails.code).toBe(1);
    expect(switchFails.lines).toContain(E2E_MESSAGES.renderedFailed('SWITCH', `${UNKNOWN_PATH}: ${E2E_MESSAGES.deviceStored('dark')}`));
    const fontsFail = await e2e(renderedTree(), {}, { lines: siteLines({}, [], { FONTS: (route) => ({ ...healthyFonts(route), control: { family: 'x', present: true } }) }) });
    expect(fontsFail.lines).toContain(E2E_MESSAGES.renderedFailed('FONTS', `/: ${E2E_MESSAGES.fontControl('x')}; ${UNKNOWN_PATH}: ${E2E_MESSAGES.fontControl('x')}`));
    const foreign = (route: string): RequestsReading => ({ ...healthyRequests(route), requests: [...healthyRequests(route).requests, 'https://fonts.gstatic.com/s/x.woff2'] });
    const requestsFail = await e2e(renderedTree(), {}, { lines: siteLines({}, [], { REQUESTS: foreign }) });
    expect(requestsFail.lines).toContain(E2E_MESSAGES.renderedFailed('REQUESTS', `/: ${E2E_MESSAGES.foreignRequest(BASE, ['https://fonts.gstatic.com'])}; ${UNKNOWN_PATH}: ${E2E_MESSAGES.foreignRequest(BASE, ['https://fonts.gstatic.com'])}`));
  });

  it('the rendered step passes the 404 console line of the unknown address and fails a 404 of any other resource', async () => {
    const notFound = 'Failed to load resource: the server responded with a status of 404 (Not Found)';
    const line = (url: string): string => `CONSOLE ${JSON.stringify({ type: 'error', text: notFound, url })}`;
    const expected = await e2e(renderedTree(), {}, { lines: [...siteLines(), line(`http://127.0.0.1:4000${UNKNOWN_PATH}`)] });
    expect(expected.code).toBe(0);
    const missing = await e2e(renderedTree(), {}, { lines: [...siteLines(), line('http://127.0.0.1:4000/_astro/missing.css')] });
    expect(missing.code).toBe(1);
    expect(missing.lines).toContain(E2E_MESSAGES.renderedFailed('CONSOLE', E2E_MESSAGES.consoleError(notFound)));
  });

  it('the rendered step fails a route with no switch, fonts or requests line, and a storage key outside the two', async () => {
    const missing = await e2e(renderedTree(), {}, { lines: siteLines({}, [], { FONTS: (route) => (route === '/' ? healthyFonts(route) : undefined) }) });
    expect(missing.code).toBe(1);
    expect(missing.lines).toContain(E2E_MESSAGES.renderedFailed('FONTS', E2E_MESSAGES.renderedMissingRoute('FONTS', UNKNOWN_PATH)));
    const storage = await e2e(renderedTree(), {}, { lines: siteLines({ STORAGE: { local: ['fothering-theme', 'other'], session: [] } }) });
    expect(storage.lines).toContain(E2E_MESSAGES.renderedFailed('STORAGE', E2E_MESSAGES.storageKeys(['other'])));
  });

  it('the rendered step serves the planted dist on 127.0.0.1 and hands the driver its base URL, the landing route and every route', async () => {
    const tree = renderedTree();
    expect((await e2e(tree)).code).toBe(0);
    const job = JSON.parse(readFileSync(join(tree.root, 'global', 'dev-browser', 'bin', 'job.json'), 'utf8')) as { base: string; route: string; routes: string[] };
    expect(job.base).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(job.route).toBe('/');
    expect(job.routes).toEqual(SITE_ROUTES);
    const args = JSON.parse(readFileSync(join(tree.root, 'global', 'dev-browser', 'bin', 'args.json'), 'utf8')) as string[];
    expect(args.slice(0, 6)).toEqual(['--headless', '--timeout', '120', '--browser', 'fothering-site', 'run']);
  });

  it('the rendered step fails when Dark stored on a dark OS reads light after the OS turns light (AC-E28)', async () => {
    const { code, lines } = await e2e(renderedTree(), {}, { lines: siteLines({ PIN: { before: DARK_PINNED, after: reading(null, LIGHT_GROUND) } }) });
    expect(code).toBe(1);
    expect(lines).toContain(E2E_MESSAGES.renderedFailed('PIN', E2E_MESSAGES.pinLost(null, LIGHT_GROUND)));
    expect(lines.at(-1)).toBe(E2E_MESSAGES.fail(E2E_MESSAGES.renderedFailures(1, `PIN: ${E2E_MESSAGES.pinLost(null, LIGHT_GROUND)}`)));
  });

  it('the rendered step fails when Device does not follow the OS (AC-42)', async () => {
    const { code, lines } = await e2e(renderedTree(), {}, { lines: siteLines({ DEVICE: { dark: reading(null, DARK_GROUND), light: reading(null, DARK_GROUND) } }) });
    expect(code).toBe(1);
    expect(lines).toContain(E2E_MESSAGES.renderedFailed('DEVICE', E2E_MESSAGES.deviceStill(DARK_GROUND)));
  });

  it('the rendered step fails a Content Security Policy console error (C5)', async () => {
    const csp = "Applying inline style violates the following Content Security Policy directive 'default-src 'self''.";
    const { code, lines } = await e2e(renderedTree(), {}, { lines: siteLines({}, [csp]) });
    expect(code).toBe(1);
    expect(lines).toContain(E2E_MESSAGES.renderedFailed('CONSOLE', E2E_MESSAGES.cspViolation(csp)));
  });

  it('the rendered step fails a missing check line and a malformed one by name', async () => {
    const missing = await e2e(renderedTree(), {}, { lines: siteLines({ DEVICE: undefined }) });
    expect(missing.code).toBe(1);
    expect(missing.lines).toContain(E2E_MESSAGES.renderedFailed('DEVICE', E2E_MESSAGES.renderedMissing('DEVICE')));
    const malformed = await e2e(renderedTree(), {}, { lines: [...siteLines({ THEME: undefined }), 'THEME {not json'] });
    expect(malformed.code).toBe(1);
    expect(malformed.lines).toContain(E2E_MESSAGES.renderedFailed('THEME', E2E_MESSAGES.renderedMalformed('THEME {not json')));
    const wrongShape = await e2e(renderedTree(), {}, { lines: siteLines({ PIN: { before: DARK_PINNED } }) });
    expect(wrongShape.lines).toContain(E2E_MESSAGES.renderedFailed('PIN', E2E_MESSAGES.renderedMalformed(`PIN ${JSON.stringify({ before: DARK_PINNED })}`)));
  });

  it('the rendered step fails a driver run without its done line and one that exits non-zero', async () => {
    const noDone = await e2e(renderedTree(), {}, { lines: siteLines(), omitDone: true });
    expect(noDone.code).toBe(1);
    expect(noDone.lines.at(-1)).toBe(E2E_MESSAGES.fail(A11Y_MESSAGES.noDone('rendered')));
    const exited = await e2e(renderedTree(), {}, { lines: siteLines(), exitCode: 2 });
    expect(exited.code).toBe(1);
    expect(exited.lines.at(-1)).toBe(E2E_MESSAGES.fail(A11Y_MESSAGES.driverExit('rendered', 2, '')));
  });

  it('the rendered step refuses a missing dev-browser, a missing template and a broken Workers config by name', async () => {
    const tree = renderedTree();
    const lines: string[] = [];
    const absent = join(tree.root, 'no-global');
    expect(await runSiteE2e({ repoRoot: tree.root, globalModules: absent, print: (line) => lines.push(line), clientSecretsScript: SECRETS_SCRIPT, secondBuild: copyDist(tree.dist), sizeLimit: passingSize, brokenArtifactBuild: refusedCopy })).toBe(1);
    expect(lines.at(-1)).toBe(E2E_MESSAGES.fail(A11Y_MESSAGES.devBrowserMissing(join(absent, 'dev-browser'))));
    const globalModules = plantBrowser(tree);
    rmSync(join(tree.root, 'scripts', 'site.devbrowser.js'));
    lines.length = 0;
    expect(await runSiteE2e({ repoRoot: tree.root, globalModules, print: (line) => lines.push(line), clientSecretsScript: SECRETS_SCRIPT, secondBuild: copyDist(tree.dist), sizeLimit: passingSize, brokenArtifactBuild: refusedCopy })).toBe(1);
    expect(lines.at(-1)).toBe(E2E_MESSAGES.fail(A11Y_MESSAGES.templateMissing(join(tree.root, 'scripts', 'site.devbrowser.js'))));
    write(join(tree.root, 'scripts', 'site.devbrowser.js'), 'console.log("done");\n');
    lines.length = 0;
    expect(await runSiteE2e({ repoRoot: tree.root, globalModules, print: (line) => lines.push(line), clientSecretsScript: SECRETS_SCRIPT, secondBuild: copyDist(tree.dist), sizeLimit: passingSize, brokenArtifactBuild: refusedCopy })).toBe(1);
    expect(lines.at(-1)).toBe(E2E_MESSAGES.fail(A11Y_MESSAGES.templateTokens(join(tree.root, 'scripts', 'site.devbrowser.js'), 0)));
    plantBrowser(tree);
    write(join(tree.root, 'packages', 'web', 'wrangler.jsonc'), '{ "assets": { "html_handling": "none", "not_found_handling": "404-page" } }');
    lines.length = 0;
    expect(await runSiteE2e({ repoRoot: tree.root, globalModules, print: (line) => lines.push(line), clientSecretsScript: SECRETS_SCRIPT, secondBuild: copyDist(tree.dist), sizeLimit: passingSize, brokenArtifactBuild: refusedCopy })).toBe(1);
    expect(lines.at(-1)).toMatch(/^\[e2e\] FAIL: the preview server did not start: .*assets\.html_handling is "none"/);
    allOutput.push(...lines);
  });

  it('runSiteE2e fails by name when the client-secret scan exits 2 or 1', async () => {
    const tree = plantSite({ 'index.html': page('<p>clean</p>') });
    for (const exitCode of [2, 1]) {
      const { code, lines } = await e2e(tree, { clientSecretsScript: stubScript(`exit-${exitCode}`, exitCode) });
      expect(code).toBe(1);
      expect(lines.at(-1)).toBe(E2E_MESSAGES.fail(E2E_MESSAGES.clientSecrets(exitCode)));
    }
  });

  it('runSiteE2e fails when the second build differs from the first in one byte, naming the file', async () => {
    const tree = plantSite(completeSite({ 'index.html': '<p>clean</p>', 'replay/index.html': '<p>replay</p>' }));
    const differing = copyDist(tree.dist, (outDir) => writeFileSync(join(outDir, 'replay', 'index.html'), `${page('<p>replay</p>')} `));
    const { code, lines } = await e2e(tree, { secondBuild: differing });
    expect(code).toBe(1);
    expect(lines.at(-1)).toBe(E2E_MESSAGES.fail(E2E_MESSAGES.buildDiffers('replay/index.html')));
    expect(existsSync(join(tree.root, 'dist', 'site-second-build'))).toBe(false);
  });

  it('runSiteE2e fails when the second build does not finish', async () => {
    const tree = plantSite(completeSite({ 'index.html': '<p>clean</p>' }));
    const { code, lines } = await e2e(tree, { secondBuild: () => ({ status: 3, output: 'astro said no' }) });
    expect(code).toBe(1);
    expect(lines.at(-1)).toBe(E2E_MESSAGES.fail(E2E_MESSAGES.secondBuildFailed(3, 'astro said no')));
  });

  it('compareBuilds names a page missing from either build and a sitemap that differs', () => {
    const first = plantSite({ 'index.html': 'a', 'only-first.html': 'b', 'sitemap.xml': '<urlset/>' });
    const second = plantSite({ 'index.html': 'a', 'only-second/index.html': 'c', 'sitemap.xml': '<urlset />' });
    expect(compareBuilds(first.dist, second.dist)).toEqual([
      E2E_MESSAGES.buildMissing('only-first.html', second.dist),
      E2E_MESSAGES.buildMissing('only-second/index.html', first.dist),
      E2E_MESSAGES.buildDiffers('sitemap.xml'),
    ]);
  });

  it('runSiteE2e fails a dist over the file budget by name', async () => {
    const tree = plantSite({ 'index.html': page('<p>clean</p>') });
    const { code, lines } = await e2e(tree, { fileBudget: () => [{ kind: 'size', path: 'index.html', bytes: 26_214_400, limit: 26_214_400 }] });
    expect(code).toBe(1);
    expect(lines.at(-1)).toBe(E2E_MESSAGES.fail(E2E_MESSAGES.fileTooLarge('index.html', 26_214_400, 26_214_400)));
  });

  it('runSiteE2e fails a dist of 20,000 files or more by name', async () => {
    const tree = plantSite({ 'index.html': page('<p>clean</p>') });
    const { code, lines } = await e2e(tree, { fileBudget: () => [{ kind: 'count', count: 20_000, limit: 20_000 }] });
    expect(code).toBe(1);
    expect(lines.at(-1)).toBe(E2E_MESSAGES.fail(E2E_MESSAGES.tooManyFiles(20_000, 20_000)));
  });

  it('built-checks refuses a missing dist and a dist with no HTML page by name', async () => {
    const missing = join(clean.root, 'no-dist');
    expect((await builtChecks(missing)).out).toEqual([E2E_MESSAGES.checksFail(E2E_MESSAGES.noDist(missing))]);
    const empty = plantSite({ 'tokens.css': ':root {}' });
    const result = await builtChecks(empty.dist);
    expect(result.code).toBe(1);
    expect(result.out).toEqual([E2E_MESSAGES.checksFail(E2E_MESSAGES.noPages(empty.dist))]);
  });

  it('built-checks with --allow alone passes the allowed findings and prints the expected-red verdict', async () => {
    const { code, out } = await builtChecks(dashed.dist, '--allow', 'dash, ses-rate-wording');
    expect(code).toBe(0);
    expect(out.at(-1)).toBe(E2E_MESSAGES.expectPass(2));
  });

  it('the CLI runs e2e only with the global npm folder, and reports its missing dist', async () => {
    const refused = cliIo();
    expect(await main(['e2e', '--repo-root', clean.root], refused.io)).toBe(1);
    expect(refused.err).toEqual([A11Y_MESSAGES.missingOption('--global-modules')]);
    const missing = join(clean.root, 'no-such-repo');
    const run = cliIo();
    expect(await main(['e2e', '--repo-root', missing, '--global-modules', missing], run.io)).toBe(1);
    expect(run.out).toEqual([E2E_MESSAGES.fail(E2E_MESSAGES.noDist(join(missing, 'packages', 'web', 'dist')))]);
  });

  it('holds no catalogue message with the uppercase skip word', () => {
    const samples: { readonly [K in keyof typeof E2E_MESSAGES]: Parameters<(typeof E2E_MESSAGES)[K]> } = {
      step: ['x'], fail: ['x'], pass: [1, 4], noDist: ['d'], noPages: ['d'], finding: ['dash', '/', 't'], findings: [1, 'x'],
      checksPass: [1], expectPass: [1], checksFail: ['x'], unregistered: ['x'], unexpected: ['x', 1], expectedMissing: ['x'],
      clientSecrets: [2], tooManyFiles: [20_000, 20_000], fileTooLarge: ['f', 1, 1], secondBuildFailed: [1, 'x'],
      buildDiffers: ['f'], buildMissing: ['f', 'd'],
      themeNotTaken: ['dark', '#000000', '#0F1316'], themeAttribute: [null, 'dark'], deviceAttribute: ['dark'], deviceStill: ['#000000'],
      pinLost: [null, '#000000'], cspViolation: ['x'], consoleError: ['x'], renderedOk: ['THEME', 'x'], renderedFailed: ['THEME', 'x'],
      renderedMissing: ['THEME'], renderedMalformed: ['THEME x'], renderedFailures: [1, 'x'],
      renderedMissingRoute: ['FONTS', '/'], deviceStored: ['dark'], choiceMissing: ['dark'], choiceNotStored: ['light', null],
      choiceNotKept: ['dark', null, null], osNotFollowed: ['#F5F7F8', '#F5F7F8', '#F5F7F8', '#0F1316'], invalidMissing: ['DARK'],
      invalidChecked: ['blue', null], domOrder: [['light']], boxOrder: [320, []], noBoxOrder: [], arrowStill: [null],
      fontMissing: ['Red Hat Mono'], fontNotLoaded: ['Red Hat Mono'], fontCheckFalse: ['Red Hat Mono'], fontControl: ['x'],
      noRequests: [], foreignRequest: ['http://127.0.0.1:1', ['https://x.test']], storageKeys: [['x']], sizeLimit: [1],
      noProseBlocks: [], lineTooLong: ['/', 81, 'x'], identifierBreak: ['a.b', ['a', '.b']], tagOverlap: ['x'], textOutside: ['x'], noDrawingText: [],
      flowNoControl: [320], flowControlWithoutMotion: [320], flowSmallControl: [320, 40, 40], flowStillRunning: [320, 1], flowLabel: [320, ['Stop flow']],
      flowReloadRuns: [320, 1], flowReduced: [320, 1], flowStoredRunning: [320], flowStoredStopped: [320, 1], flowTabUnreached: [320], flowTabLate: [320],
      copyBuildPassed: [], copyBuildUnnamed: ['x'], copyBuildLeft: ['d'],
    };
    const rendered = Object.entries(samples).map(([key, args]) => (E2E_MESSAGES[key as keyof typeof E2E_MESSAGES] as (...a: unknown[]) => string)(...args));
    expect(rendered).toHaveLength(Object.keys(E2E_MESSAGES).length);
    expect(rendered.filter((text) => SKIP_WORD.test(text))).toEqual([]);
  });

  it('prints the uppercase skip word in no line of any run so far', () => {
    expect(allOutput.filter((line) => SKIP_WORD.test(line))).toEqual([]);
  });
});
