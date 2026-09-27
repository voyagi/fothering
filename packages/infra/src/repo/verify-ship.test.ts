import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

// This file lives at packages/infra/src/repo/, four levels below the repo root that holds the
// script under test.
const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const VERIFY_SHIP = join(REPO_ROOT, 'verify-ship.mjs');

const STEP_ORDER = ['types', 'tests', 'lint', 'gate', 'repo', 'selftest', 'build', 'coverage', 'e2e', 'a11y', 'mutation'];
const SUB_GATE_LINE = 'neutral-subgate: SKIPPED, nothing to check';

function makeProject(overrides: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'verify-ship-st-'));
  writeFileSync(join(dir, 'ok.mjs'), 'process.exit(0);\n');
  writeFileSync(join(dir, 'skip.mjs'), `console.log('${SUB_GATE_LINE}');\nprocess.exit(0);\n`);
  writeFileSync(join(dir, 'fail.mjs'), 'process.exit(1);\n');
  const scripts = {
    'gate:types': 'node ok.mjs',
    test: 'node ok.mjs',
    lint: 'node ok.mjs',
    gate: 'node ok.mjs',
    'gate:repo': 'node skip.mjs',
    'gate:selftest': 'node ok.mjs',
    ...overrides,
  };
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'fixture', private: true, scripts }, null, 2));
  return dir;
}

function run(dir: string): { stdout: string; status: number } {
  try {
    const stdout = execFileSync(process.execPath, [VERIFY_SHIP], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, VERIFY_SHIP_TIMEOUT_MS: '60000' },
    });
    return { stdout, status: 0 };
  } catch (e) {
    const err = e as { stdout?: string; status?: number | null };
    return { stdout: err.stdout ?? '', status: err.status ?? 1 };
  }
}

describe('verify:ship selftest step and sub-gate reporting', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it(
    'runs every step in order with the last five SKIPPED, and repeats the SKIPPED sub-gate line the repo script printed',
    { timeout: 60_000 },
    () => {
      const dir = makeProject();
      dirs.push(dir);
      const { stdout, status } = run(dir);
      expect(status).toBe(0);

      const summaryStart = stdout.indexOf('verify:ship summary');
      expect(summaryStart).toBeGreaterThan(-1);
      const summary = stdout.slice(summaryStart);

      let cursor = 0;
      for (const [i, name] of STEP_ORDER.entries()) {
        const at = summary.indexOf(name, cursor);
        expect(at, `expected "${name}" in the summary after position ${cursor}`).toBeGreaterThan(-1);
        const line = summary.slice(at, summary.indexOf('\n', at));
        const expectedStatus = i >= STEP_ORDER.length - 5 ? 'SKIPPED' : 'PASS';
        expect(line, `step "${name}" should read ${expectedStatus}`).toContain(expectedStatus);
        cursor = at + name.length;
      }

      expect(summary).toContain(SUB_GATE_LINE);
      expect(stdout).toContain('verify:ship: PASS');
    },
  );

  it(
    'fails at gate and reads every later step as NOT RUN',
    { timeout: 60_000 },
    () => {
      const dir = makeProject({ gate: 'node fail.mjs' });
      dirs.push(dir);
      const { stdout, status } = run(dir);
      expect(status).toBe(1);
      expect(stdout).toContain('verify:ship: FAIL at step "gate"');

      const summaryStart = stdout.indexOf('verify:ship summary');
      const summary = stdout.slice(summaryStart);
      expect(summary).toMatch(/gate\s+FAIL \(exit 1\)/);
      for (const name of ['repo', 'selftest', 'build', 'coverage', 'e2e', 'a11y', 'mutation']) {
        expect(summary, `step "${name}" should read NOT RUN`).toMatch(new RegExp(`${name}\\s+NOT RUN`));
      }
    },
  );
});
