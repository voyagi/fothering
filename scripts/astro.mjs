// Runs the repo's own Astro CLI with telemetry off, so no build, check or dev run reaches the
// network. The web workspace's scripts call this; npm -w runs it with packages/web as the working
// folder, which Astro takes as its project root, so the folder is left unchanged.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(repoRoot, 'package.json'));

function astroEntry() {
  let manifestPath;
  try {
    manifestPath = require.resolve('astro/package.json');
  } catch {
    return undefined;
  }
  // Read from the installed package's bin field: the entry file has moved between Astro releases.
  const bin = require('astro/package.json').bin;
  const relative = typeof bin === 'string' ? bin : bin?.astro;
  if (typeof relative !== 'string') return undefined;
  const entry = join(dirname(manifestPath), relative);
  return existsSync(entry) ? entry : undefined;
}

const entry = astroEntry();
if (entry === undefined) {
  console.error('[astro] the Astro CLI entry was not found under node_modules/astro; run npm install from the repo root first.');
  process.exit(1);
}

const child = spawn(process.execPath, [entry, ...process.argv.slice(2)], {
  stdio: 'inherit',
  shell: false,
  env: { ...process.env, ASTRO_TELEMETRY_DISABLED: '1' },
});
child.on('error', (error) => {
  console.error(`[astro] could not start the Astro CLI: ${error.message}`);
  process.exit(1);
});
child.on('exit', (code, signal) => {
  if (signal !== null) {
    console.error(`[astro] the Astro CLI ended on signal ${signal}`);
    process.exit(1);
  }
  process.exit(code ?? 1);
});
