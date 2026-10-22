import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { refusalMessage } from '@fothering/core/live-run';
import { LIVE_SWITCH } from '@fothering/core/mode';

// This file lives at packages/infra/src/repo/, four levels below the repo root.
const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const RUNNER = join(REPO_ROOT, 'scripts', 'live-run.mjs');
const RUN_ID = 'live-20261021-s1-1';
const SPAWN_TIMEOUT_MS = 120_000;
const LOAD_FAILURE = /Dynamic require|Cannot find module|ERR_MODULE_NOT_FOUND/;

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

// Windows reads environment names without regard to case, so every spelling of the switch goes,
// not only the exact one: a child that inherits any of them could read the switch as live.
function envWithoutSwitch(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.toUpperCase() === LIVE_SWITCH.toUpperCase()) delete env[key];
  }
  return env;
}

function runRunner(args: readonly string[]): RunResult {
  const result = spawnSync(process.execPath, [RUNNER, ...args], {
    cwd: REPO_ROOT,
    env: envWithoutSwitch(),
    encoding: 'utf8',
    timeout: SPAWN_TIMEOUT_MS,
    windowsHide: true,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function linesOf(text: string): string[] {
  return text.split(/\r?\n/).filter((line) => line !== '');
}

describe('the live-run runner bundles the CLI and runs it with the same Node', () => {
  it('prints run 1 spike as a header and 132 plan lines, and exits 0', () => {
    const result = runRunner(['plan', 'bulk-stale-import', 'spike', RUN_ID]);
    const [header, ...planLines] = linesOf(result.stdout);
    expect(`exit ${result.status}, ${planLines.filter((line) => /^\d+ /.test(line)).length} plan lines`).toBe('exit 0, 132 plan lines');
    expect(header?.startsWith('bulk-stale-import spike: 132 sends')).toBe(true);
    expect(LOAD_FAILURE.test(result.stderr)).toBe(false);
  }, SPAWN_TIMEOUT_MS);

  it('refuses a send while the switch is absent from its environment', () => {
    const result = runRunner([
      'send',
      RUN_ID,
      'bulk-stale-import',
      'spike',
      '--from',
      'planted-sender@example.com',
      '--account-profile',
      'planted-account',
      '--lane-profile',
      'fothering-bulk=planted-bulk',
      '--lane-profile',
      'fothering-transactional=planted-transactional',
    ]);
    const refused = linesOf(result.stderr).includes(refusalMessage('switch-not-live'));
    expect(`exit ${result.status}, ${refused ? 'switch refused' : 'no switch refusal'}`).toBe('exit 1, switch refused');
    expect(result.stdout).toBe('');
    expect(LOAD_FAILURE.test(result.stderr)).toBe(false);
  }, SPAWN_TIMEOUT_MS);
});
