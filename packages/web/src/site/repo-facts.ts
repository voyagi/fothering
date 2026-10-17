import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

const REPO_PACKAGE_NAME = 'fothering';

function packageNameAt(folder: string): string | undefined {
  const file = join(folder, 'package.json');
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null && 'name' in parsed ? String(parsed.name) : undefined;
  } catch {
    throw new Error(`${file}: not valid JSON`);
  }
}

// Callers pass process.cwd(): during an Astro build that is packages/web, whose own package.json
// is the workspace's, so the walk has to look past the nearest manifest to the named root.
export function repoRoot(start: string): string {
  let folder = resolve(start);
  for (;;) {
    if (packageNameAt(folder) === REPO_PACKAGE_NAME) return folder;
    const parent = dirname(folder);
    if (parent === folder) throw new Error(`no package.json named ${REPO_PACKAGE_NAME} at or above ${resolve(start)}`);
    folder = parent;
  }
}

// Pages read committed files through this instead of new URL(..., import.meta.url), which Vite
// would rewrite into a bundled asset reference.
export function readRepoText(relativePath: string, root: string): string {
  const file = resolve(root, relativePath);
  const fromRoot = relative(root, file);
  const escapes = fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot);
  if (isAbsolute(relativePath) || escapes) {
    throw new Error(`${relativePath}: outside the repository root`);
  }
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`${relativePath}: not found`);
    throw error;
  }
  if (text.trim() === '') throw new Error(`${relativePath}: empty`);
  return text;
}
