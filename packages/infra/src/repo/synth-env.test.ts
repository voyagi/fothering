import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

// This file lives at packages/infra/src/repo/, four levels below the repo root.
const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const SYNTH_ENV = join(REPO_ROOT, 'scripts', 'synth-env.mjs');

type Env = Record<string, string | undefined>;

interface SynthEnvModule {
  AWS_CREDENTIAL_VARS: readonly string[];
  sanitizedSynthEnv: (sourceEnv?: Env) => Env;
}

async function loadSynthEnv(): Promise<SynthEnvModule> {
  return (await import(pathToFileURL(SYNTH_ENV).href)) as SynthEnvModule;
}

// Every key naming `name` in any case: on Windows a child process reads any one of them as `name`.
function spellingsOf(env: Env, name: string): string[] {
  return Object.keys(env).filter((key) => key.toUpperCase() === name);
}

describe('the environment cdk synth runs in keeps every AWS credential source out of reach', () => {
  it('drops every listed credential variable in any spelling, keeps the rest, and leaves its source alone', async () => {
    const { AWS_CREDENTIAL_VARS, sanitizedSynthEnv } = await loadSynthEnv();
    const source: Env = { UNRELATED_SETTING: 'kept' };
    for (const name of AWS_CREDENTIAL_VARS) {
      source[name] = 'upper';
      source[name.toLowerCase()] = 'lower';
      source[`${name.charAt(0)}${name.slice(1).toLowerCase()}`] = 'mixed';
    }
    const env = sanitizedSynthEnv(source);
    for (const name of AWS_CREDENTIAL_VARS) {
      expect(spellingsOf(env, name), `${name} survived`).toEqual([]);
    }
    expect(env.UNRELATED_SETTING).toBe('kept');
    expect(source.AWS_PROFILE).toBe('upper');
  });

  it('sets each redirect under exactly one spelling, replacing one the source held in another case', async () => {
    const { sanitizedSynthEnv } = await loadSynthEnv();
    const env = sanitizedSynthEnv({ aws_config_file: 'planted-config-path', Aws_Ec2_Metadata_Disabled: 'false' });
    expect(spellingsOf(env, 'AWS_CONFIG_FILE')).toEqual(['AWS_CONFIG_FILE']);
    expect(env.AWS_CONFIG_FILE).toContain('fothering-no-aws-credentials');
    expect(spellingsOf(env, 'AWS_SHARED_CREDENTIALS_FILE')).toEqual(['AWS_SHARED_CREDENTIALS_FILE']);
    expect(spellingsOf(env, 'AWS_EC2_METADATA_DISABLED')).toEqual(['AWS_EC2_METADATA_DISABLED']);
    expect(env.AWS_EC2_METADATA_DISABLED).toBe('true');
    expect(env.CDK_DISABLE_CLI_TELEMETRY).toBe('true');
    expect(env.CDK_DISABLE_VERSION_CHECK).toBe('true');
  });

  it('a child process started with it reads no planted credential through the canonical names', async () => {
    const { sanitizedSynthEnv } = await loadSynthEnv();
    const env = sanitizedSynthEnv({ ...process.env, aws_profile: 'planted', aws_access_key_id: 'planted' });
    const probe = 'console.log(JSON.stringify([process.env.AWS_PROFILE ?? null, process.env.AWS_ACCESS_KEY_ID ?? null]))';
    const result = spawnSync(process.execPath, ['-e', probe], { env, encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([null, null]);
  });
});
