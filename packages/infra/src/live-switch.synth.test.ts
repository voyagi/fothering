import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { App, Stack } from 'aws-cdk-lib';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { LIVE_SWITCH } from '@fothering/core/mode';
import { liveSwitchEnvironment } from './live-switch.js';
import { resourcesOfType, synthStacks, type SynthesizedStacks } from './test/synth.js';

const DEPLOYED_RUNTIME = 'FOTHERING_DEPLOYED_RUNTIME';

function environments(stacks: SynthesizedStacks): { functions: Array<Record<string, unknown>>; runtime: Record<string, unknown> } {
  const functions = Object.values(resourcesOfType(stacks.ingest, 'AWS::Lambda::Function')).map(
    (resource) => (resource.Properties as { Environment: { Variables: Record<string, unknown> } }).Environment.Variables,
  );
  const [runtime] = Object.values(resourcesOfType(stacks.runtime, 'AWS::BedrockAgentCore::Runtime'));
  return { functions, runtime: (runtime?.Properties?.EnvironmentVariables ?? {}) as Record<string, unknown> };
}

function synthEnvironments(context: Record<string, unknown>): ReturnType<typeof environments> {
  const stacks = synthStacks(context);
  try {
    return environments(stacks);
  } finally {
    stacks.dispose();
  }
}

describe('liveSwitchEnvironment reads only the fothering:live context key, and only the exact value live', () => {
  // An App built with no outdir makes a temp folder of its own on construction, synth or not, and
  // nothing removes it; every probe App here shares one folder this block deletes.
  let outdir = '';
  beforeAll(() => {
    outdir = mkdtempSync(join(tmpdir(), 'fothering-switch-probe-'));
  });
  afterAll(() => rmSync(outdir, { recursive: true, force: true }));

  function forContext(context: Record<string, unknown>): Record<string, string> {
    return liveSwitchEnvironment(new Stack(new App({ context, outdir }), 'Probe'));
  }

  it('forwards the switch for the exact value live', () => {
    expect(forContext({ 'fothering:live': 'live' })).toEqual({ [LIVE_SWITCH]: 'live' });
  });

  it.each(['LIVE', 'true', '1', ' live', 'live ', 'live\n', '', 'lIve', true, 1, null])('forwards nothing for %j', (value) => {
    expect(forContext({ 'fothering:live': value })).toEqual({});
  });

  it('forwards nothing without the key, and ignores a key spelled like the switch itself', () => {
    expect(forContext({})).toEqual({});
    expect(forContext({ [LIVE_SWITCH]: 'live' })).toEqual({});
  });
});

describe('the deployed stacks carry the switch only from the context key', () => {
  const saved = process.env[LIVE_SWITCH];
  afterEach(() => {
    if (saved === undefined) delete process.env[LIVE_SWITCH];
    else process.env[LIVE_SWITCH] = saved;
  });

  it('holds no live value on any function or on the runtime in a default synth', { timeout: 60_000 }, () => {
    const { functions, runtime } = synthEnvironments({});
    expect(functions).toHaveLength(2);
    for (const variables of functions) expect(variables[LIVE_SWITCH]).toBeUndefined();
    expect(runtime).toEqual({ [DEPLOYED_RUNTIME]: 'agentcore' });
  });

  it('carries live on every function and the runtime when the context key is live, the runtime keeping its marker', { timeout: 60_000 }, () => {
    const { functions, runtime } = synthEnvironments({ 'fothering:live': 'live' });
    expect(functions).toHaveLength(2);
    for (const variables of functions) expect(variables[LIVE_SWITCH]).toBe('live');
    expect(runtime).toEqual({ [DEPLOYED_RUNTIME]: 'agentcore', [LIVE_SWITCH]: 'live' });
  });

  it.each(['LIVE', 'true'])('carries nothing when the context key is %s', { timeout: 60_000 }, (value) => {
    const { functions, runtime } = synthEnvironments({ 'fothering:live': value });
    for (const variables of functions) expect(variables[LIVE_SWITCH]).toBeUndefined();
    expect(runtime).toEqual({ [DEPLOYED_RUNTIME]: 'agentcore' });
  });

  it('carries nothing when the switch is live in the shell of the process and the context key is absent', { timeout: 60_000 }, () => {
    process.env[LIVE_SWITCH] = 'live';
    const { functions, runtime } = synthEnvironments({});
    for (const variables of functions) expect(variables[LIVE_SWITCH]).toBeUndefined();
    expect(runtime).toEqual({ [DEPLOYED_RUNTIME]: 'agentcore' });
  });
});
