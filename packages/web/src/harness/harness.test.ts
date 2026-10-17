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
import {
  A11Y_MESSAGES,
  ACCEPTED_INCOMPLETE,
  AXE_CONFIG,
  E2E_MESSAGES,
  auditReasons,
  axeReasons,
  compareBuilds,
  keyboardVerdict,
  loadCheckContext,
  overflowVerdict,
  routesFromDist,
  runA11yLive,
  runSiteE2e,
  type AuditLine,
  type AxeReport,
  type FocusStop,
  type KeyboardReport,
  type SecondBuildRun,
  type SiteE2eOptions,
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
  if (!existsSync(join(scenario.homeDir, '.dev-browser', 'tmp', job.axeFile))) {
    console.error('staged axe file not found');
    process.exit(3);
  }
  const stop = { domIndex: 5, tag: 'a', radioGroup: null, skipLink: true };
  for (const route of job.routes) {
    const expected = (job.expectedStatus || {})[route] || 200;
    const answered = scenario.unknownStatus !== undefined && expected !== 200 ? scenario.unknownStatus : expected;
    const status = scenario.status === undefined ? answered : scenario.status;
    const line = status !== 200 && status !== expected ? { route, status } : {
      route,
      status,
      axe: { version: '4.14.0', selected: ['html-has-lang', 'target-size', 'label-content-name-mismatch'], ran: ['html-has-lang', 'target-size', 'label-content-name-mismatch'], violations: [], incomplete: [] },
      keyboard: { focusables: [stop], positiveTabindex: [], walk: [{ ...stop, outlineStyle: 'auto', outlineWidth: '1px', boxShadow: 'none' }] },
      overflow: { scrollWidth: job.width, innerWidth: job.width },
    };
    console.log('AUDIT ' + JSON.stringify(line));
  }
  if (scenario.malformed) console.log('AUDIT {not json');
  if (scenario.incomplete) console.log('AUDIT ' + JSON.stringify({ route: job.routes[0], status: 200, axe: { version: '4.14.0', selected: ['target-size', 'label-content-name-mismatch'], ran: ['target-size', 'label-content-name-mismatch'], violations: [], incomplete: [{ id: 'color-contrast', nodes: [{ target: 'p', summary: '' }] }] }, keyboard: { focusables: [stop], positiveTabindex: [], walk: [{ ...stop, outlineStyle: 'auto', outlineWidth: '1px', boxShadow: 'none' }] }, overflow: { scrollWidth: job.width, innerWidth: job.width } }));
  if (!scenario.omitDone) console.log('done');
  process.exit(scenario.exitCode === undefined ? 0 : scenario.exitCode);
}
`;

interface Scenario {
  readonly status?: number;
  readonly unknownStatus?: number;
  readonly omitDone?: boolean;
  readonly exitCode?: number;
  readonly hang?: boolean;
  readonly malformed?: boolean;
  readonly incomplete?: boolean;
}

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
  if (devBrowserVersion !== null) {
    const packageDir = join(globalModules, 'dev-browser');
    write(join(packageDir, 'package.json'), JSON.stringify({ name: 'dev-browser', version: devBrowserVersion, type: 'module' }));
    write(join(packageDir, 'bin', 'dev-browser.js'), STUB_LAUNCHER);
    write(join(packageDir, 'bin', 'scenario.json'), JSON.stringify({ ...options.scenario, homeDir }));
  }
  return { repoRoot, globalModules, homeDir, dist };
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
    expect(lines).toContain(A11Y_MESSAGES.acceptedNone());
    expect(lines.at(-1)).toBe(A11Y_MESSAGES.pass(3, 2, 3, 0));
    expect(lines.filter((line) => line.endsWith('Tab stop(s)'))).toHaveLength(18);
    expect(readdirSync(join(planted.homeDir, '.dev-browser', 'tmp'))).toEqual([]);
    const args = JSON.parse(readFileSync(join(planted.globalModules, 'dev-browser', 'bin', 'args.json'), 'utf8')) as string[];
    expect(args.slice(0, 6)).toEqual(['--headless', '--timeout', '120', '--browser', 'fothering-site', 'run']);
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
    expect(ACCEPTED_INCOMPLETE).toEqual([]);
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
const NO_ACCEPTED = new Map<string, number>();

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
    expect(axeReasons({ ...cleanAxe, incomplete }, new Map([['color-contrast', 0]]))).toEqual([]);
  });

  it('fails a violation', () => {
    const violations = [{ id: 'image-alt', nodes: [{ target: 'img', summary: 'Fix this' }] }];
    expect(axeReasons({ ...cleanAxe, violations }, NO_ACCEPTED)).toEqual([A11Y_MESSAGES.violation('image-alt', 1, 'img')]);
  });

  it('fails axe-core 4.13.0', () => {
    expect(axeReasons({ ...cleanAxe, version: '4.13.0' }, NO_ACCEPTED)).toEqual([A11Y_MESSAGES.axeVersionRan('4.13.0')]);
  });

  it('judges a whole AUDIT record: status, missing results, viewport and overflow', () => {
    const line: AuditLine = { route: '/', status: 200, axe: cleanAxe, keyboard: keyboard([skip, nav, radios[0] ?? skip, button].map(withRing)), overflow: { scrollWidth: 320, innerWidth: 320 } };
    expect(auditReasons(line, 320, NO_ACCEPTED)).toEqual([]);
    expect(auditReasons({ route: '/', status: 500 }, 320, NO_ACCEPTED)).toEqual([A11Y_MESSAGES.status(500, 200)]);
    expect(auditReasons({ ...line, status: 404 }, 320, NO_ACCEPTED, 404)).toEqual([]);
    expect(auditReasons(line, 320, NO_ACCEPTED, 404)).toEqual([A11Y_MESSAGES.status(200, 404)]);
    expect(auditReasons({ route: '/', status: 200 }, 320, NO_ACCEPTED)).toEqual([A11Y_MESSAGES.axeAbsent()]);
    expect(auditReasons({ ...line, overflow: { scrollWidth: 330, innerWidth: 300 } }, 320, NO_ACCEPTED)).toEqual([A11Y_MESSAGES.viewport(300, 320), A11Y_MESSAGES.overflow(330, 320)]);
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
    expect(await runSiteE2e({ repoRoot: dashed.root, globalModules: dashed.root, print: (line) => e2eLines.push(line), clientSecretsScript: SECRETS_SCRIPT })).toBe(1);
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

  const copyBuild = (dist: string, change?: (outDir: string) => void) => (outDir: string): SecondBuildRun => {
    cpSync(dist, outDir, { recursive: true });
    change?.(outDir);
    return { status: 0, output: '' };
  };

  async function e2e(tree: ReturnType<typeof plantDist>, extra: Partial<SiteE2eOptions> = {}): Promise<{ code: number; lines: string[] }> {
    const lines: string[] = [];
    const code = await runSiteE2e({ repoRoot: tree.root, globalModules: tree.root, print: (line) => lines.push(line), clientSecretsScript: SECRETS_SCRIPT, secondBuild: copyBuild(tree.dist), ...extra });
    allOutput.push(...lines);
    return { code, lines };
  }

  function stubScript(name: string, exitCode: number): string {
    const path = join(PLANT, 'stubs', `${name}.mjs`);
    write(path, `console.log('[client-secrets] planted stub');\nprocess.exit(${exitCode});\n`);
    return path;
  }

  it('runSiteE2e runs the client-secret scan, the file budget, the built checks and the second build in order, then passes', async () => {
    const tree = plantSite({ ...completeSite({ 'index.html': '<p>closed - one lane</p>' }), 'tokens.css': ':root {}' });
    const { code, lines } = await e2e(tree);
    expect(code).toBe(0);
    const steps = lines.filter((line) => line.startsWith('[e2e] step '));
    expect(steps).toEqual(['client-secrets', 'file-budget', 'built-checks', 'second-build'].map((name) => E2E_MESSAGES.step(name)));
    expect(lines.at(-1)).toBe(E2E_MESSAGES.pass(1, 4));
    expect(existsSync(join(tree.root, 'dist', 'site-second-build'))).toBe(false);
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
    const differing = copyBuild(tree.dist, (outDir) => writeFileSync(join(outDir, 'replay', 'index.html'), `${page('<p>replay</p>')} `));
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
    };
    const rendered = Object.entries(samples).map(([key, args]) => (E2E_MESSAGES[key as keyof typeof E2E_MESSAGES] as (...a: unknown[]) => string)(...args));
    expect(rendered).toHaveLength(Object.keys(E2E_MESSAGES).length);
    expect(rendered.filter((text) => SKIP_WORD.test(text))).toEqual([]);
  });

  it('prints the uppercase skip word in no line of any run so far', () => {
    expect(allOutput.filter((line) => SKIP_WORD.test(line))).toEqual([]);
  });
});
