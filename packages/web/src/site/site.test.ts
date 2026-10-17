import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { readRepoText, repoRoot } from './repo-facts.js';

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

  it('returns the folder itself when it holds the fothering package.json', () => {
    expect(repoRoot(join(PLANT, 'tree'))).toBe(join(PLANT, 'tree'));
  });

  it('walks up past a package.json with another name to the fothering one', () => {
    expect(repoRoot(join(PLANT, 'tree/packages/web/src/pages'))).toBe(join(PLANT, 'tree'));
    expect(repoRoot(join(PLANT, 'tree/packages/web'))).toBe(join(PLANT, 'tree'));
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
  });

  it('passes on a read failure other than a missing file', () => {
    expect(() => readRepoText('folder', root)).toThrow(/EISDIR/);
  });
});
