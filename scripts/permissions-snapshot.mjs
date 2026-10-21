#!/usr/bin/env node
// permissions-snapshot.mjs - regenerates packages/infra/permissions.json and resources.json from
// the synthesized stacks. Run it after a change to any role or resource, and commit both files with
// the change: the permissions and resources tests fail until they agree.
//
// The tool is bundled into dist/, inside the repo, so Node resolves aws-cdk-lib from the repo's own
// node_modules (a bundle in a temp folder would find none). It runs in the same credential-free
// environment as the build: a synth needs no AWS access and must never reach for any.
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { CDK_TOOL_BUNDLE_BASE } from './bundle-options.mjs';
import { sanitizedSynthEnv } from './synth-env.mjs';

const root = process.cwd();
const outfile = join(root, 'dist', 'tools', 'permissions-cli.mjs');

await build({
  ...CDK_TOOL_BUNDLE_BASE,
  entryPoints: [join('packages', 'infra', 'src', 'permissions-cli.ts')],
  outfile,
  absWorkingDir: root,
});

execFileSync(process.execPath, [outfile], { cwd: root, env: sanitizedSynthEnv(), stdio: 'inherit' });
