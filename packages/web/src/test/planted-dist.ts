import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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
