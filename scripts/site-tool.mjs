#!/usr/bin/env node
// site-tool.mjs - one entry for the site's Node-side tools: `a11y` (npm run a11y:live) and
// `preview` (npm run preview -w @fothering/web). The harness is TypeScript under
// packages/web/src/harness, bundled into the git-ignored root dist/tools/ the way
// permissions-snapshot.mjs bundles its CLI, then run with this same Node.
//
// The browser subcommands need the global npm folder, where dev-browser is installed. It is asked
// of npm's own CLI (npm_execpath, which npm sets for every script it runs) through this Node, so no
// shell and no .cmd shim is involved on Windows.
import { build } from 'esbuild';
import { execFileSync, spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SITE_TOOL_BUNDLE_BASE } from './bundle-options.mjs';

const BROWSER_SUBCOMMANDS = new Set(['a11y', 'e2e']);
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const [subcommand, ...rest] = process.argv.slice(2);

if (subcommand === undefined) {
  console.error('[site-tool] usage: node scripts/site-tool.mjs <a11y|preview> [options]');
  process.exit(1);
}

let globalModules;
if (BROWSER_SUBCOMMANDS.has(subcommand)) {
  const npmCli = process.env.npm_execpath;
  if (npmCli === undefined || npmCli === '') {
    console.error(`[site-tool] ${subcommand} needs the global npm folder and npm_execpath is not set: run it through npm (npm run a11y:live).`);
    process.exit(1);
  }
  try {
    globalModules = execFileSync(process.execPath, [npmCli, 'root', '-g'], { encoding: 'utf8' }).trim();
  } catch (error) {
    console.error(`[site-tool] npm root -g failed: ${error.message}`);
    process.exit(1);
  }
}

const outfile = join(repoRoot, 'dist', 'tools', 'site-cli.mjs');
await build({
  ...SITE_TOOL_BUNDLE_BASE,
  entryPoints: [join('packages', 'web', 'src', 'harness', 'cli.ts')],
  outfile,
  absWorkingDir: repoRoot,
});

const args = [outfile, subcommand, '--repo-root', repoRoot];
if (globalModules !== undefined) args.push('--global-modules', globalModules);
args.push(...rest);

const child = spawn(process.execPath, args, { stdio: 'inherit', shell: false, cwd: repoRoot });
child.on('error', (error) => {
  console.error(`[site-tool] could not start the site CLI: ${error.message}`);
  process.exit(1);
});
child.on('exit', (code, signal) => {
  if (signal !== null) {
    console.error(`[site-tool] the site CLI ended on signal ${signal}`);
    process.exit(1);
  }
  process.exit(code ?? 1);
});
