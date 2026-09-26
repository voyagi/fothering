#!/usr/bin/env node
// build.mjs - bundles every Lambda handler and the CDK app with esbuild, then synthesizes the
// CDK app with no AWS credentials in reach (D-19, D-23, Pitfall 11).
//
// WHY A SANITIZED ENVIRONMENT FOR cdk synth. This machine has real AWS profiles, and the CDK CLI
// resolves account and region from ambient credentials by default, plus fetches notices and
// telemetry over the network. A local build must never touch either: the credential and profile
// variables are stripped from a COPY of process.env (never deleted from process.env itself, so a
// caller running this in-process keeps its own environment), the credential FILES are pointed at
// a path that does not exist, IMDS is disabled, and CLI telemetry and notices are off.
//
// WHY NAMED DELETION, NOT A LITERAL DOT-ACCESS READ of a credential variable. A literal read of
// one of those names anywhere in tracked source makes gate:env demand that key in .env.example,
// which is wrong: this script never WANTS any of them, it wants them GONE. Deleting by name from
// a list, off a spread copy of the environment, reads none of them literally and asks nothing of
// the example file.
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const AWS_CREDENTIAL_VARS = [
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AWS_PROFILE',
  'AWS_DEFAULT_PROFILE',
  'AWS_ROLE_ARN',
  'AWS_WEB_IDENTITY_TOKEN_FILE',
  'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI',
  'AWS_CONTAINER_CREDENTIALS_FULL_URI',
  'AWS_CONTAINER_AUTHORIZATION_TOKEN',
];

function findHandlers(root) {
  const functionsSrc = join(root, 'packages', 'functions', 'src');
  if (!existsSync(functionsSrc)) return [];
  return readdirSync(functionsSrc, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => existsSync(join(functionsSrc, name, 'handler.ts')))
    .sort();
}

function sanitizedSynthEnv(root) {
  const env = { ...process.env };
  for (const name of AWS_CREDENTIAL_VARS) delete env[name];
  const missingCredentialsDir = join(tmpdir(), 'fothering-no-aws-credentials');
  env.AWS_CONFIG_FILE = join(missingCredentialsDir, 'config');
  env.AWS_SHARED_CREDENTIALS_FILE = join(missingCredentialsDir, 'credentials');
  env.AWS_EC2_METADATA_DISABLED = 'true';
  env.CDK_DISABLE_CLI_TELEMETRY = 'true';
  void root;
  return env;
}

async function run(root) {
  rmSync(join(root, 'dist'), { recursive: true, force: true });

  const bundled = [];

  for (const name of findHandlers(root)) {
    const outfile = join('dist', name, 'index.js');
    try {
      await build({
        entryPoints: [join('packages', 'functions', 'src', name, 'handler.ts')],
        bundle: true,
        platform: 'node',
        target: 'node22',
        format: 'cjs',
        outfile,
        absWorkingDir: root,
      });
    } catch (error) {
      console.error(`[build] bundling ${name}/handler.ts failed: ${(error && error.message) || error}`);
      return 1;
    }
    bundled.push(outfile.replace(/\\/g, '/'));
  }

  const infraOutfile = join('dist', 'infra', 'app.mjs');
  try {
    await build({
      entryPoints: [join('packages', 'infra', 'src', 'app.ts')],
      bundle: true,
      platform: 'node',
      target: 'node22',
      format: 'esm',
      external: ['aws-cdk-lib', 'aws-cdk-lib/*', 'constructs'],
      outfile: infraOutfile,
      absWorkingDir: root,
    });
  } catch (error) {
    console.error(`[build] bundling infra/app.ts failed: ${(error && error.message) || error}`);
    return 1;
  }
  bundled.push(infraOutfile.replace(/\\/g, '/'));

  console.log(`[build] bundled: ${bundled.join(', ')}`);

  const cdkBin = join(root, 'node_modules', 'aws-cdk', 'bin', 'cdk');
  try {
    execFileSync(process.execPath, [cdkBin, 'synth', '--no-notices', '--quiet'], {
      cwd: root,
      env: sanitizedSynthEnv(root),
      stdio: 'inherit',
    });
  } catch (error) {
    console.error(`[build] cdk synth failed: ${(error && error.message) || error}`);
    return 1;
  }

  return 0;
}

process.exit(await run(process.cwd()));
