import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NOT_FOUND_ROUTE, routeOf } from '../checks/built-site.js';
import { renderRobots, renderSitemap } from '../site/route-list.js';

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

export function plantDist(files: Readonly<Record<string, string | Buffer>>): PlantedDist {
  mkdirSync(CACHE, { recursive: true });
  const root = mkdtempSync(join(CACHE, 'fothering-built-'));
  const dist = join(root, 'packages', 'web', 'dist');
  mkdirSync(dist, { recursive: true });
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
  return SHEET_HEAD_ITEMS.filter((item) => !omitted.has(item)).map((item) => items[item]).join('');
}

// A planted build the metadata, sitemap and robots rules pass, so a case can plant one fault and
// see only the rule it aims at fire.
export function completeSite(bodies: Readonly<Record<string, string>>, heads: Readonly<Record<string, SheetHead>> = {}): Record<string, string> {
  const files: Record<string, string> = {};
  const paths: string[] = [];
  for (const [file, body] of Object.entries(bodies)) {
    const route = routeOf(file);
    files[file] = page(body, sheetHead(route, heads[file]));
    if (route !== NOT_FOUND_ROUTE) paths.push(route);
  }
  return { ...files, 'sitemap.xml': renderSitemap(paths.map((path) => ({ path, indexable: true }))), 'robots.txt': renderRobots() };
}
