#!/usr/bin/env node
// build.mjs - bundles every Lambda handler, the agent runtime and the CDK app with esbuild, then
// synthesizes the CDK app with no AWS credentials in reach (D-19, D-23, Pitfall 11).
//
// WHY A SANITIZED ENVIRONMENT FOR cdk synth. This machine has real AWS profiles, and the CDK CLI
// resolves account and region from ambient credentials by default, plus fetches notices and
// telemetry over the network, and when its output is a terminal it asks the npm registry for a
// newer CLI version once a day. A local build must never touch either: the credential and profile
// variables are stripped from a COPY of process.env (never deleted from process.env itself, so a
// caller running this in-process keeps its own environment), the credential FILES are pointed at
// a path that does not exist, IMDS is disabled, and CLI telemetry, notices and the version check
// are off. synth-env.mjs builds that environment, every spelling of each name included.
//
// WHY A package.json BESIDE EACH HANDLER BUNDLE. esbuild writes CommonJS into index.js, and the
// repo root's package.json says "type": "module", so any Node that finds that file (a local load,
// a smoke test) reads the bundle as an ES module and it dies on `module is not defined`. Lambda
// sees only the asset folder and so falls back to CommonJS for a .js file; a package.json naming
// the type inside the folder makes every loader read the bundle the same way, and the load check
// after it proves each bundle exports its handler before synth packages it. The agent bundle gets
// neither inside its own folder, because that folder is the code zip and holds main.js alone, and
// requiring main.js starts the AgentCore HTTP server as a side effect of loading it, so its load
// proof is the local runtime test, which runs it as its own process. The default build marks dist/
// itself as CommonJS instead, so a local run of dist/agent/main.js inside the repo loads it the way
// the zip does.
//
// The CommonJS settings both bundle kinds share, and the agent's createRequire plugin, live in
// bundle-options.mjs with the reasons for each.
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { CJS_BUNDLE_BASE, agentcoreInlineRequirePlugin, markCommonJsScope } from './bundle-options.mjs';
import { sanitizedSynthEnv } from './synth-env.mjs';

const require = createRequire(import.meta.url);

function findHandlers(root) {
  const functionsSrc = join(root, 'packages', 'functions', 'src');
  if (!existsSync(functionsSrc)) return [];
  return readdirSync(functionsSrc, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => existsSync(join(functionsSrc, name, 'handler.ts')))
    .sort();
}

// Loads a bundle the way the Lambda runtime does (require, then read the named export), so a
// bundle that fails to load or lost its handler stops the build instead of reaching a deploy.
function exportsHandler(outfileAbs) {
  const loaded = require(outfileAbs);
  return typeof loaded.handler === 'function';
}

async function buildHandlerBundle(root, name, outfileAbs) {
  await build({
    ...CJS_BUNDLE_BASE,
    entryPoints: [join('packages', 'functions', 'src', name, 'handler.ts')],
    outfile: outfileAbs,
    absWorkingDir: root,
  });
  markCommonJsScope(dirname(outfileAbs));
  // A bundle that throws while loading names only what it threw, so the path is added here.
  let exported;
  try {
    exported = exportsHandler(outfileAbs);
  } catch (error) {
    throw new Error(`${outfileAbs} failed to load: ${(error && error.message) || error}`, { cause: error });
  }
  if (!exported) {
    throw new Error(`${outfileAbs} loads but exports no handler function`);
  }
}

async function buildAgentBundle(root, outfileAbs) {
  await build({
    ...CJS_BUNDLE_BASE,
    entryPoints: [join('packages', 'agent', 'src', 'main.ts')],
    outfile: outfileAbs,
    absWorkingDir: root,
    plugins: [agentcoreInlineRequirePlugin()],
  });
}

async function buildInfraBundle(root, outfileAbs) {
  await build({
    entryPoints: [join('packages', 'infra', 'src', 'app.ts')],
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'esm',
    external: ['aws-cdk-lib', 'aws-cdk-lib/*', 'constructs'],
    outfile: outfileAbs,
    absWorkingDir: root,
  });
}

// A flag's value is the argument after it; a flag that is last, or followed by another flag, was
// given with no value, which is not the same as not given at all.
function flagArg(argv, flag) {
  const index = argv.indexOf(flag);
  if (index === -1) return { given: false, value: undefined };
  const value = argv[index + 1];
  return { given: true, value: value === undefined || value.startsWith('--') ? undefined : value };
}

function parseArgs(argv) {
  return { only: flagArg(argv, '--only'), outdir: flagArg(argv, '--outdir') };
}

// Builds exactly one target into its own directory and skips cdk synth entirely, so a caller
// proving one bundle in isolation (the agent runtime's local contract test) never runs the full
// handler-plus-infra-plus-synth pipeline, and never touches the repo's own dist/.
async function runOnly(root, only, outdir) {
  const outDirAbs = resolve(outdir);
  const handlerNames = findHandlers(root);
  if (handlerNames.includes(only)) {
    await buildHandlerBundle(root, only, join(outDirAbs, 'index.js'));
  } else if (only === 'agent') {
    await buildAgentBundle(root, join(outDirAbs, 'main.js'));
  } else if (only === 'app') {
    await buildInfraBundle(root, join(outDirAbs, 'app.mjs'));
  } else {
    throw new Error(`--only ${only} is not a known target (expected one of ${[...handlerNames, 'agent', 'app'].join(', ')})`);
  }
  console.log(`[build] --only ${only} written to ${outDirAbs}`);
}

async function runDefault(root) {
  rmSync(join(root, 'dist'), { recursive: true, force: true });

  const bundled = [];
  for (const name of findHandlers(root)) {
    const outfileAbs = join(root, 'dist', name, 'index.js');
    await buildHandlerBundle(root, name, outfileAbs);
    bundled.push(`dist/${name}/index.js`);
  }

  await buildAgentBundle(root, join(root, 'dist', 'agent', 'main.js'));
  markCommonJsScope(join(root, 'dist'));
  bundled.push('dist/agent/main.js');

  await buildInfraBundle(root, join(root, 'dist', 'infra', 'app.mjs'));
  bundled.push('dist/infra/app.mjs');

  console.log(`[build] bundled: ${bundled.join(', ')}`);

  const cdkBin = join(root, 'node_modules', 'aws-cdk', 'bin', 'cdk');
  execFileSync(process.execPath, [cdkBin, 'synth', '--no-notices', '--quiet'], {
    cwd: root,
    env: sanitizedSynthEnv(),
    stdio: 'inherit',
  });
}

async function run(root, argv) {
  const args = parseArgs(argv);
  if (args.only.given || args.outdir.given) {
    const only = args.only.value;
    const outdir = args.outdir.value;
    if (only === undefined || outdir === undefined) {
      console.error('[build] --only and --outdir each need a value, and are given together');
      return 1;
    }
    try {
      await runOnly(root, only, outdir);
    } catch (error) {
      console.error(`[build] --only ${only} failed: ${(error && error.message) || error}`);
      return 1;
    }
    return 0;
  }

  try {
    await runDefault(root);
  } catch (error) {
    console.error(`[build] ${(error && error.message) || error}`);
    return 1;
  }
  return 0;
}

process.exit(await run(process.cwd(), process.argv.slice(2)));
