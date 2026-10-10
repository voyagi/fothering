import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { LIVE_SWITCH } from '@fothering/core/mode';

const VITEST_BIN = join(process.cwd(), 'node_modules', 'vitest', 'vitest.mjs');
const PROBE_FILE = 'packages/providers/src/test/switch-probe.test.ts';
const CHILD_TIMEOUT_MS = 120000;

interface ProbeResult {
  status: number;
  combined: string;
}

// Runs the probe file as its own vitest process rather than importing global-setup.ts directly:
// a globalSetup abort only happens once, at the top of a run, so the only way to observe it is
// to spawn the run it would abort.
function runProbe(switchValue: string): ProbeResult {
  try {
    const stdout = execFileSync(
      process.execPath,
      [VITEST_BIN, 'run', PROBE_FILE],
      {
        cwd: process.cwd(),
        // This worker's own setup already set the metadata flag to true, and a spread would hand
        // that to the child, so the probe's check of it would pass whether or not the child's
        // setup ran. Planting false makes the child's setup the only thing that can set it.
        env: {
          ...process.env,
          AWS_ACCESS_KEY_ID: 'planted-not-a-key',
          AWS_EC2_METADATA_DISABLED: 'false',
          [LIVE_SWITCH]: switchValue,
        },
        encoding: 'utf8',
        timeout: CHILD_TIMEOUT_MS,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    return { status: 0, combined: stdout };
  } catch (error) {
    const failure = error as { status?: number | null; stdout?: string; stderr?: string };
    return { status: failure.status ?? 1, combined: `${failure.stdout ?? ''}${failure.stderr ?? ''}` };
  }
}

describe('the switch aborts the whole run before any test executes', () => {
  it(
    'exits non-zero and names the switch when the value is exactly live (AC-3)',
    () => {
      const { status, combined } = runProbe('live');
      expect(status).not.toBe(0);
      expect(combined).toContain(LIVE_SWITCH);
      expect(combined).not.toMatch(/Tests\s+\d+\s+passed/);
    },
    CHILD_TIMEOUT_MS,
  );

  it.each([' live', 'LIVE', 'live\n'])(
    'runs the probe on fixtures for the lookalike value %j (AC-E4)',
    (value) => {
      const { status, combined } = runProbe(value);
      expect(status).toBe(0);
      expect(combined).toMatch(/1 passed/);
    },
    CHILD_TIMEOUT_MS,
  );
});
