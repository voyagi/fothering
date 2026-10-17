import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { GET as robotsGet } from '../pages/robots.txt.js';
import { GET as sitemapGet } from '../pages/sitemap.xml.js';
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

describe('the route list (D-153)', () => {
  it('holds an RFC 2606 reserved origin with no trailing slash until the deployed host is known', () => {
    expect(SITE_ORIGIN).toMatch(/^https:\/\/[a-z-]+\.example$/);
  });

  it('holds / as sheet FTH-001 with the UI-SPEC 11.2 title and description, indexable', () => {
    expect(ROUTES.map((route) => route.path)).toEqual(['/', '/replay/']);
    expect(ROUTES[0]).toEqual({ path: '/', sheet: 'FTH-001', label: 'Landing', title: LANDING_TITLE, description: LANDING_DESCRIPTION, indexable: true });
  });

  it('holds /replay/ as sheet FTH-002 with the UI-SPEC 11.2 title and description, indexable', () => {
    expect(ROUTES[1]).toEqual({ path: '/replay/', sheet: 'FTH-002', label: 'Replay', title: REPLAY_TITLE, description: REPLAY_DESCRIPTION, indexable: true });
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
    expect(() => routeFor('/deploy/', planted)).toThrow('/deploy/: not in the route list; add its entry to ROUTES in packages/web/src/site/route-list.ts');
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
