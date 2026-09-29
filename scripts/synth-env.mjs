// synth-env.mjs - the environment cdk synth runs in: no AWS credential, profile or instance
// metadata source in reach, and no CLI telemetry, notices or version check. build.mjs says why a
// local build must never reach either; it lives here so a test can check it without a build.
//
// WHY NAMED DELETION, NOT A LITERAL DOT-ACCESS READ of a credential variable. A literal read of
// one of those names anywhere in tracked source makes gate:env demand that key in .env.example,
// which is wrong: synth never WANTS any of them, it wants them GONE. Filtering a copy of the
// environment against a list reads none of them literally and asks nothing of the example file.
//
// WHY EVERY SPELLING. On Windows a variable's name ignores case: a child process started with
// only aws_profile set still reads it as AWS_PROFILE (measured 2026-09-28 on Node 24, win32). So a
// key is dropped when it matches a listed name in any case, and the names this sets are dropped
// first in any case too, so the one spelling the child sees is the value set here.
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const AWS_CREDENTIAL_VARS = Object.freeze([
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
  // Both named in the CDK CLI's bundled code (checked 2026-09-29): the token's file form, and the
  // older spelling beside AWS_SESSION_TOKEN.
  'AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE',
  'AWS_SECURITY_TOKEN',
]);

// Returns a new object; the source environment is never changed, so a caller running a build
// in-process keeps its own.
export function sanitizedSynthEnv(sourceEnv = process.env) {
  const missingCredentialsDir = join(tmpdir(), 'fothering-no-aws-credentials');
  const overrides = {
    AWS_CONFIG_FILE: join(missingCredentialsDir, 'config'),
    AWS_SHARED_CREDENTIALS_FILE: join(missingCredentialsDir, 'credentials'),
    AWS_EC2_METADATA_DISABLED: 'true',
    CDK_DISABLE_CLI_TELEMETRY: 'true',
    CDK_DISABLE_VERSION_CHECK: 'true',
  };
  const dropped = new Set([...AWS_CREDENTIAL_VARS, ...Object.keys(overrides)].map((name) => name.toUpperCase()));
  const kept = Object.entries(sourceEnv).filter(([name]) => !dropped.has(name.toUpperCase()));
  return { ...Object.fromEntries(kept), ...overrides };
}
