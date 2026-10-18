import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { AXE_CONFIG } from '../harness/gates.js';
import { GET as robotsGet } from '../pages/robots.txt.js';
import { GET as sitemapGet } from '../pages/sitemap.xml.js';
import { ACCESSIBILITY_RECORD, accessibilityStatements, CONTROLLER, HAND_CHECK_CRITERIA, HAND_CHECK_RESULT_LABELS, type HandCheckResult } from './content.js';
import { readRepoText, repoRoot } from './repo-facts.js';
import { headMeta, NOT_FOUND_ROUTE, renderRobots, renderSitemap, routeFor, ROUTES, SITE_ORIGIN, sitemapUrls, type SiteRoute } from './route-list.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

// Planted trees sit under the repo's git-ignored node_modules/.cache, so the walk from inside one
// would reach the real repo root if the planted root were ever skipped; that is what the
// "nearest wins" cases rely on to fail loudly.
const CACHE = join(REPO_ROOT, 'node_modules', '.cache');
mkdirSync(CACHE, { recursive: true });
const PLANT = mkdtempSync(join(CACHE, 'site-repo-facts-'));
// Nothing above the system temp folder is a package named fothering, so a walk from here has no
// root to find; under the repo it would always find the real one.
const OUTSIDE = mkdtempSync(join(tmpdir(), 'site-repo-facts-outside-'));

afterAll(() => {
  rmSync(PLANT, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  rmSync(OUTSIDE, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

function plant(relative: string, text: string): string {
  const file = join(PLANT, relative);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
  return file;
}

describe('repoRoot', () => {
  plant('tree/package.json', JSON.stringify({ name: 'fothering', private: true }));
  plant('tree/packages/web/package.json', JSON.stringify({ name: '@fothering/web' }));
  mkdirSync(join(PLANT, 'tree/packages/web/src/pages'), { recursive: true });
  plant('bad/package.json', '{ not json');
  mkdirSync(join(PLANT, 'bad/inner'), { recursive: true });
  plant('tree/nameless/package.json', JSON.stringify({ private: true }));
  plant('tree/listed/package.json', JSON.stringify(['fothering']));
  mkdirSync(join(PLANT, 'folder-manifest/package.json'), { recursive: true });

  it('returns the folder itself when it holds the fothering package.json', () => {
    expect(repoRoot(join(PLANT, 'tree'))).toBe(join(PLANT, 'tree'));
  });

  it('walks up past a package.json with another name to the fothering one', () => {
    expect(repoRoot(join(PLANT, 'tree/packages/web/src/pages'))).toBe(join(PLANT, 'tree'));
    expect(repoRoot(join(PLANT, 'tree/packages/web'))).toBe(join(PLANT, 'tree'));
  });

  it('walks past a package.json with no name and one that is not an object', () => {
    expect(repoRoot(join(PLANT, 'tree/nameless'))).toBe(join(PLANT, 'tree'));
    expect(repoRoot(join(PLANT, 'tree/listed'))).toBe(join(PLANT, 'tree'));
  });

  it('passes on a manifest read failure other than a missing file', () => {
    expect(() => repoRoot(join(PLANT, 'folder-manifest'))).toThrow(/EISDIR/);
  });

  it('finds the real repository from this test file', () => {
    expect(repoRoot(dirname(fileURLToPath(import.meta.url)))).toBe(REPO_ROOT);
  });

  it('throws a named error when no folder above holds the fothering package.json', () => {
    expect(() => repoRoot(OUTSIDE)).toThrow(`no package.json named fothering at or above ${OUTSIDE}`);
  });

  it('names an unreadable package.json on the way up instead of skipping it', () => {
    expect(() => repoRoot(join(PLANT, 'bad/inner'))).toThrow(`${join(PLANT, 'bad', 'package.json')}: not valid JSON`);
  });
});

describe('readRepoText', () => {
  const root = join(PLANT, 'texts');
  plant('texts/package.json', JSON.stringify({ name: 'fothering' }));
  plant('texts/lanes.json', '{"lanes":[]}\n');
  plant('texts/blank.txt', ' \n\t\n');
  plant('texts/zero.txt', '');
  plant('texts/..notes.txt', 'kept\n');
  mkdirSync(join(root, 'folder'), { recursive: true });

  it('reads a committed file as UTF-8 text', () => {
    expect(readRepoText('lanes.json', root)).toBe('{"lanes":[]}\n');
  });

  it('reads the real lanes.json through the real root', () => {
    expect(JSON.parse(readRepoText('lanes.json', repoRoot(REPO_ROOT)))).toHaveProperty('lanes');
  });

  it('throws "<path>: not found" for a missing file', () => {
    expect(() => readRepoText('missing.json', root)).toThrow(/^missing\.json: not found$/);
  });

  it('throws "<path>: empty" for a zero-length file and for a whitespace-only one', () => {
    expect(() => readRepoText('zero.txt', root)).toThrow(/^zero\.txt: empty$/);
    expect(() => readRepoText('blank.txt', root)).toThrow(/^blank\.txt: empty$/);
  });

  it('refuses a path that leaves the repository root', () => {
    expect(() => readRepoText('../tree/package.json', root)).toThrow(/^\.\.\/tree\/package\.json: outside the repository root$/);
    expect(() => readRepoText(join(PLANT, 'tree/package.json'), root)).toThrow(/: outside the repository root$/);
    expect(() => readRepoText('..', root)).toThrow(/^\.\.: outside the repository root$/);
  });

  it('reads a file whose name only starts with two dots', () => {
    expect(readRepoText('..notes.txt', root)).toBe('kept\n');
  });

  it('passes on a read failure other than a missing file', () => {
    expect(() => readRepoText('folder', root)).toThrow(/EISDIR/);
  });
});

const LANDING_TITLE = 'Fothering: close the one SES lane that is going wrong';
const LANDING_DESCRIPTION = 'Fothering reads Amazon SES events, pauses only the configuration set that is damaging the shared reputation, reads the setting back, and tells the operator by email.';

const REPLAY_TITLE = 'Incident replay: one SES lane paused and reopened';
const REPLAY_DESCRIPTION = 'One SES incident in four steps: bounces arrive on one configuration set, code names the cause with counts, the lane is paused and read back, and the operator reopens it by command.';

const DEPLOY_TITLE = 'Deploy Fothering into your own AWS account';
const DEPLOY_DESCRIPTION = 'The steps to deploy and remove Fothering, everything the template creates, and every IAM permission it holds with the reason, generated from the template.';

const PRIVACY_TITLE = 'Privacy and AI: what Fothering keeps and what the model decides';
const PRIVACY_DESCRIPTION = 'Which SES event fields a Fothering deployment stores, where and for how long, how to delete them, what this site keeps, and what the AI model may and may not do.';

const ACCESSIBILITY_TITLE = 'Accessibility statement: Fothering';
const ACCESSIBILITY_DESCRIPTION = 'The WCAG 2.2 AA target for this site, the last automated audit, what was checked by hand, known limitations and how to report a problem.';

describe('the route list (D-153)', () => {
  it('holds an RFC 2606 reserved origin with no trailing slash until the deployed host is known', () => {
    expect(SITE_ORIGIN).toMatch(/^https:\/\/[a-z-]+\.example$/);
  });

  it('holds / as sheet FTH-001 with the UI-SPEC 11.2 title and description, indexable', () => {
    expect(ROUTES.map((route) => route.path)).toEqual(['/', '/replay/', '/deploy/', '/privacy-and-ai/', '/accessibility/']);
    expect(ROUTES[0]).toEqual({ path: '/', sheet: 'FTH-001', label: 'Landing', title: LANDING_TITLE, description: LANDING_DESCRIPTION, indexable: true });
  });

  it('holds /replay/ as sheet FTH-002 with the UI-SPEC 11.2 title and description, indexable', () => {
    expect(ROUTES[1]).toEqual({ path: '/replay/', sheet: 'FTH-002', label: 'Replay', title: REPLAY_TITLE, description: REPLAY_DESCRIPTION, indexable: true });
  });

  it('holds /deploy/ as sheet FTH-003 with the UI-SPEC 11.2 title and description, indexable', () => {
    expect(ROUTES[2]).toEqual({ path: '/deploy/', sheet: 'FTH-003', label: 'Deploy', title: DEPLOY_TITLE, description: DEPLOY_DESCRIPTION, indexable: true });
  });

  it('holds /privacy-and-ai/ as sheet FTH-004 with the UI-SPEC 11.2 title and description, indexable', () => {
    expect(ROUTES[3]).toEqual({ path: '/privacy-and-ai/', sheet: 'FTH-004', label: 'Privacy and AI', title: PRIVACY_TITLE, description: PRIVACY_DESCRIPTION, indexable: true });
  });

  it('holds /accessibility/ as sheet FTH-005 with the UI-SPEC 11.2 title and description, indexable', () => {
    expect(ROUTES[4]).toEqual({ path: '/accessibility/', sheet: 'FTH-005', label: 'Accessibility', title: ACCESSIBILITY_TITLE, description: ACCESSIBILITY_DESCRIPTION, indexable: true });
  });

  it('holds the 404 title, description and Drawing cell text, with no path and not indexable', () => {
    expect(NOT_FOUND_ROUTE).toEqual({
      path: null,
      title: 'No sheet at this address: Fothering',
      description: 'This address is not one of the sheets of the Fothering site.',
      drawing: 'Not in the sheet set',
      indexable: false,
    });
  });

  it('gives no two routes, the 404 page included, the same title or description', () => {
    const all = [...ROUTES, NOT_FOUND_ROUTE];
    expect(new Set(all.map((route) => route.title)).size).toBe(all.length);
    expect(new Set(all.map((route) => route.description)).size).toBe(all.length);
  });
});

describe('routeFor', () => {
  const planted: readonly SiteRoute[] = [
    ...ROUTES,
    { path: '/replay/', sheet: 'FTH-002', label: 'Replay', title: 't', description: 'd', indexable: true },
  ];

  it('finds a route by its path with or without the trailing slash', () => {
    expect(routeFor('/replay/', planted).sheet).toBe('FTH-002');
    expect(routeFor('/replay', planted).sheet).toBe('FTH-002');
  });

  it('finds the landing page at / and at the empty path', () => {
    expect(routeFor('/')).toBe(ROUTES[0]);
    expect(routeFor('')).toBe(ROUTES[0]);
  });

  it('throws by name for a path the route list does not hold', () => {
    expect(() => routeFor('/no-such-sheet/', planted)).toThrow('/no-such-sheet/: not in the route list; add its entry to ROUTES in packages/web/src/site/route-list.ts');
  });
});

describe('headMeta', () => {
  it('gives the title, description, og:title, og:description, og:type website and twitter:card summary', () => {
    const landing = headMeta(routeFor('/'));
    expect(landing.title).toBe(LANDING_TITLE);
    expect(landing.metas).toEqual(expect.arrayContaining([
      { name: 'description', content: LANDING_DESCRIPTION },
      { property: 'og:title', content: LANDING_TITLE },
      { property: 'og:description', content: LANDING_DESCRIPTION },
      { property: 'og:type', content: 'website' },
      { name: 'twitter:card', content: 'summary' },
    ]));
  });

  it('gives canonical and og:url as SITE_ORIGIN plus the path', () => {
    const landing = headMeta(routeFor('/'));
    expect(landing.links).toEqual([{ rel: 'canonical', href: `${SITE_ORIGIN}/` }]);
    expect(landing.metas).toContainEqual({ property: 'og:url', content: `${SITE_ORIGIN}/` });
  });

  it('gives the 404 page every item except canonical and og:url, since it answers at any unknown address', () => {
    const notFound = headMeta(NOT_FOUND_ROUTE);
    expect(notFound.title).toBe(NOT_FOUND_ROUTE.title);
    expect(notFound.links).toEqual([]);
    expect(notFound.metas.map((meta) => meta.name ?? meta.property)).toEqual(['description', 'og:title', 'og:description', 'og:type', 'twitter:card']);
  });
});

// 05-RESEARCH.md, "Derived list for the accessibility statement (D-156)": the WCAG 2.2 A and AA
// criteria that no axe-core 4.14.0 rule maps to, read from the W3C criteria JSON and axe's rule table.
const RESEARCH_CRITERIA = [
  '1.2.3', '1.2.4', '1.2.5', '1.3.2', '1.3.3', '1.4.5', '1.4.10', '1.4.11', '1.4.13', '2.1.2', '2.1.4', '2.3.1', '2.4.3', '2.4.5', '2.4.6', '2.4.7',
  '2.4.11', '2.5.1', '2.5.2', '2.5.4', '2.5.7', '3.2.1', '3.2.2', '3.2.3', '3.2.4', '3.2.6', '3.3.1', '3.3.3', '3.3.4', '3.3.7', '3.3.8', '4.1.3',
];
// The record keeps room for every result the hand check can give, so S5 records not applicable,
// passed or failed without a type change.
const RESULTS: readonly HandCheckResult[] = ['not-yet-checked', 'not-applicable', 'passed', 'failed'];

describe('the accessibility record (D-156, AC-53)', () => {
  it('names axe-core 4.14.0 with the tags, enabled rules, widths and themes of the audit configuration', () => {
    expect(ACCESSIBILITY_RECORD.axeVersion).toBe('4.14.0');
    expect(ACCESSIBILITY_RECORD.axeVersion).toBe(AXE_CONFIG.version);
    expect(ACCESSIBILITY_RECORD.tags).toEqual(AXE_CONFIG.tags);
    expect(ACCESSIBILITY_RECORD.enabledRules).toEqual(AXE_CONFIG.enabledRules);
    expect(ACCESSIBILITY_RECORD.widths).toEqual(AXE_CONFIG.widths);
    expect(ACCESSIBILITY_RECORD.themes).toEqual(AXE_CONFIG.themes.map((theme) => theme.name));
  });

  it('covers every route the sitemap lists, the routes the audit visits', () => {
    expect(ACCESSIBILITY_RECORD.routes).toEqual(ROUTES.filter((route) => route.indexable).map((route) => route.path));
  });

  it('targets WCAG 2.2 at level AA', () => {
    expect(ACCESSIBILITY_RECORD.target).toBe('WCAG 2.2, level AA');
  });

  it('dates the last automated audit as a committed calendar date, never the build clock', () => {
    expect(ACCESSIBILITY_RECORD.lastAutomatedAudit).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('gives the role-only contact route of the controller and names no person or address', () => {
    expect(ACCESSIBILITY_RECORD.contact).toContain(CONTROLLER.contact);
    expect(ACCESSIBILITY_RECORD.contact).not.toMatch(/@/);
  });

  it('lists the known limitations, the drawings among them in the words of UI-SPEC 11.8', () => {
    expect(ACCESSIBILITY_RECORD.limitations.find((limitation) => limitation.id === 'drawings')?.text).toBe(
      'The flow drawings are images with text descriptions; every lane name and state they show is also in the page text.',
    );
    // axe-core 4.14.0's color-contrast rule does not skip SVG text, so the statement claims no such gap.
    expect(ACCESSIBILITY_RECORD.limitations.map((limitation) => limitation.id)).not.toContain('drawing-contrast');
    for (const limitation of ACCESSIBILITY_RECORD.limitations) expect(limitation.text.length).toBeGreaterThan(0);
  });

  it('states the target, the audit date, the tool version, each limitation and the contact route', () => {
    expect(accessibilityStatements().map((statement) => statement.text)).toEqual([
      ACCESSIBILITY_RECORD.target,
      ACCESSIBILITY_RECORD.lastAutomatedAudit,
      `axe-core ${ACCESSIBILITY_RECORD.axeVersion}`,
      ...ACCESSIBILITY_RECORD.limitations.map((limitation) => limitation.text),
      ACCESSIBILITY_RECORD.contact,
    ]);
  });

  it('holds, as a set, the 32 criteria of the research list, each once', () => {
    const numbers = HAND_CHECK_CRITERIA.map((criterion) => criterion.number);
    expect(numbers).toHaveLength(32);
    expect(new Set(numbers).size).toBe(32);
    expect([...numbers].sort()).toEqual([...RESEARCH_CRITERIA].sort());
  });

  it('gives each criterion a name, a known result with its label, and a how-checked note', () => {
    for (const criterion of HAND_CHECK_CRITERIA) {
      expect(criterion.name.length).toBeGreaterThan(0);
      expect(RESULTS).toContain(criterion.result);
      expect(HAND_CHECK_RESULT_LABELS[criterion.result].length).toBeGreaterThan(0);
      expect(criterion.how.length).toBeGreaterThan(0);
    }
  });

  // UI-SPEC E13 empty state: no person has checked any criterion before the S5 real-browser session,
  // so no row may show a result. S5 records every result, and replaces this case, in one commit.
  it('shows every criterion as not yet checked before the hand check in a real browser', () => {
    const recorded = HAND_CHECK_CRITERIA.filter((criterion) => criterion.result !== 'not-yet-checked').map((criterion) => `${criterion.number} ${criterion.result}`);
    expect(recorded).toEqual([]);
  });

  // A how-checked note is the method a person follows, never an outcome nobody has seen yet.
  it('writes every how-checked note as a method a person follows, in plain short words', () => {
    const emDash = String.fromCharCode(0x2014);
    for (const criterion of HAND_CHECK_CRITERIA) {
      expect(criterion.how, criterion.number).toMatch(/^Check that /);
      expect(criterion.how, criterion.number).not.toContain(';');
      expect(criterion.how, criterion.number).not.toContain(emDash);
      expect(criterion.how.split(/\s+/).length, criterion.number).toBeLessThanOrEqual(20);
    }
  });

  it('labels the four results as the statement prints them', () => {
    expect(HAND_CHECK_RESULT_LABELS).toEqual({ 'not-yet-checked': 'Not yet checked', 'not-applicable': 'Not applicable', 'passed': 'Passed', 'failed': 'Failed' });
  });
});

describe('the sitemap and robots endpoints (AC-50, AC-51)', () => {
  it('sitemap GET returns XML listing each indexable route once as an absolute URL from SITE_ORIGIN, never the 404', async () => {
    const response = sitemapGet();
    expect(response.headers.get('Content-Type')).toBe('application/xml; charset=utf-8');
    const body = await response.text();
    expect(body.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(sitemapUrls(body)).toEqual(ROUTES.filter((route) => route.indexable).map((route) => `${SITE_ORIGIN}${route.path}`));
    expect(body).not.toMatch(/404/);
  });

  it('renderSitemap leaves out a route that is not indexable and escapes XML characters', () => {
    const xml = renderSitemap([{ path: '/a/', indexable: true }, { path: '/hidden/', indexable: false }, { path: '/b&c/', indexable: true }]);
    expect(sitemapUrls(xml)).toEqual([`${SITE_ORIGIN}/a/`, `${SITE_ORIGIN}/b&c/`]);
    expect(xml).toContain('/b&amp;c/');
  });

  it('sitemapUrls reads no URL from a sitemap with no loc element', () => {
    expect(sitemapUrls('<urlset></urlset>')).toEqual([]);
  });

  it('robots GET returns User-agent *, Allow / and the sitemap URL', async () => {
    const response = robotsGet();
    expect(response.headers.get('Content-Type')).toBe('text/plain; charset=utf-8');
    const lines = (await response.text()).split('\n');
    expect(lines).toEqual(expect.arrayContaining(['User-agent: *', 'Allow: /', `Sitemap: ${SITE_ORIGIN}/sitemap.xml`]));
    expect(renderRobots()).toBe(await robotsGet().text());
  });
});
