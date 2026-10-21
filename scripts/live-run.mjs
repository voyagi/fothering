#!/usr/bin/env node
// live-run.mjs - builds the live-run command and runs it with the same Node, passing every argument
// through and exiting with the command's own exit code. `plan` prints a step's sends; `send` refuses
// unless the live switch reads exactly live.
//
// The command is bundled into dist/, inside the repo, so Node resolves the external AWS SDK from the
// repo's own node_modules. It keeps the caller's environment: a send signs with the operator's named
// AWS profiles, which a credential-free environment would hide from it.
import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { LIVE_RUN_BUNDLE_BASE } from './bundle-options.mjs';

const root = process.cwd();
const outfile = join(root, 'dist', 'tools', 'live-run-cli.mjs');

await build({
  ...LIVE_RUN_BUNDLE_BASE,
  entryPoints: [join('packages', 'functions', 'src', 'live-run', 'cli.ts')],
  outfile,
  absWorkingDir: root,
});

const result = spawnSync(process.execPath, [outfile, ...process.argv.slice(2)], { cwd: root, stdio: 'inherit' });
process.exit(result.status ?? 1);
