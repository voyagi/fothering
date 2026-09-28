import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
const SELFTEST_PASS_LINE = 'selftest ok: an absent file is a loud SKIPPED, exit 0';
const HANG_PID_FILE = 'hang.pid';

function makeProject(overrides: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'verify-ship-st-'));
  writeFileSync(join(dir, 'ok.mjs'), 'process.exit(0);\n');
  writeFileSync(join(dir, 'skip.mjs'), `console.log('${SUB_GATE_LINE}');\nprocess.exit(0);\n`);
  writeFileSync(join(dir, 'fail.mjs'), 'process.exit(1);\n');
  // The shape every gate script's --selftest prints for a PASSING control that names the word.
  writeFileSync(join(dir, 'selftest-pass.mjs'), `console.log('${SELFTEST_PASS_LINE}');\nprocess.exit(0);\n`);
  // A step that never ends, run the way a real one is (npm, then a shell, then node), which
  // records its own PID so the test can tell whether the timeout reached it.
  writeFileSync(
    join(dir, 'hang.mjs'),
    `import { writeFileSync } from 'node:fs';\nwriteFileSync('${HANG_PID_FILE}', String(process.pid));\nconsole.log('hang: started');\nsetInterval(() => {}, 1000);\n`,
  );
  // A step that finishes at once but leaves hang.mjs running on its inherited output pipes.
  writeFileSync(
    join(dir, 'linger.mjs'),
    "import { spawn } from 'node:child_process';\nspawn(process.execPath, ['hang.mjs'], { stdio: 'inherit', detached: true }).unref();\nprocess.exit(0);\n",
  );
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

interface RunResult {
  stdout: string;
  stderr: string;
  status: number;
  // True when this helper's own watchdog had to kill verify-ship: the script under test hung.
  hung: boolean;
}

function run(dir: string, stepTimeoutMs = 60_000, watchdogMs = 55_000): RunResult {
  try {
    const stdout = execFileSync(process.execPath, [VERIFY_SHIP], {
      cwd: dir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, VERIFY_SHIP_TIMEOUT_MS: String(stepTimeoutMs) },
      timeout: watchdogMs,
    });
    return { stdout, stderr: '', status: 0, hung: false };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; status?: number | null; code?: string };
    return { stdout: err.stdout ?? '', stderr: err.stderr ?? '', status: err.status ?? 1, hung: err.code === 'ETIMEDOUT' };
  }
}

// process.kill with signal 0 sends nothing: it only asks whether the PID still exists.
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function hangPid(dir: string): number | undefined {
  const file = join(dir, HANG_PID_FILE);
  return existsSync(file) ? Number(readFileSync(file, 'utf8')) : undefined;
}

describe('verify:ship selftest step and sub-gate reporting', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) {
      // A failed run can leave the hung fixture alive; stop it by the PID it recorded (never by
      // name), or Windows refuses to remove the folder it is running in.
      const pid = hangPid(d);
      if (pid !== undefined && isAlive(pid)) process.kill(pid);
      rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
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
    'counts only sub-gates that audited nothing: a passing selftest control is not one, and one skip printed by two steps counts once',
    { timeout: 60_000 },
    () => {
      // gate and repo both print the same skip, the way the real gate chain runs gate:repo inside
      // itself, and the selftest step prints a passing control that names the word.
      const dir = makeProject({ gate: 'node skip.mjs', 'gate:selftest': 'node selftest-pass.mjs' });
      dirs.push(dir);
      const { stdout, status } = run(dir);
      expect(status).toBe(0);

      const summary = stdout.slice(stdout.indexOf('verify:ship summary'));
      expect(summary.split(SUB_GATE_LINE).length - 1, 'the skip is still listed under each step that printed it').toBe(2);
      expect(summary).not.toContain(SELFTEST_PASS_LINE);
      expect(stdout).toContain('1 sub-gate SKIPPED line(s) repeated above');
    },
  );

  it(
    'still repeats a skip line that only mentions selftest further in, since only the exact passing-control prefix is set aside',
    { timeout: 60_000 },
    () => {
      const lookalike = '[selftest-runner] SKIPPED: selftest ok: prefix not at the start';
      const dir = makeProject({ 'gate:selftest': 'node lookalike.mjs' });
      dirs.push(dir);
      writeFileSync(join(dir, 'lookalike.mjs'), `console.log('${lookalike}');\nprocess.exit(0);\n`);
      const { stdout, status } = run(dir);
      expect(status).toBe(0);
      const summary = stdout.slice(stdout.indexOf('verify:ship summary'));
      expect(summary).toContain(lookalike);
      expect(stdout).toContain('2 sub-gate SKIPPED line(s) repeated above');
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

  it(
    'ends a hung step at its timeout with a TIMED OUT failure, even while the hung process holds the output pipes',
    { timeout: 60_000 },
    () => {
      const dir = makeProject({ 'gate:types': 'node hang.mjs' });
      dirs.push(dir);
      const { stdout, stderr, status, hung } = run(dir, 3_000, 40_000);
      expect(hung, 'verify:ship itself never ended: the step timeout did not reach a verdict').toBe(false);
      expect(status).toBe(1);
      expect(stderr).toContain('types TIMED OUT after 3 s');
      expect(stdout).toContain('verify:ship: FAIL at step "types"');

      // On Windows the shell dies alone unless the whole tree is ended, so the hung process itself
      // must be gone too. On POSIX the direct child takes the signal and npm passes it on.
      const pid = hangPid(dir);
      expect(pid, 'the hung fixture never started').toBeDefined();
      if (process.platform === 'win32' && pid !== undefined) {
        expect(isAlive(pid), `the hung process ${pid} outlived the timeout`).toBe(false);
      }
    },
  );

  it(
    'passes a step that exited while something it started still holds the output pipes, and never calls it TIMED OUT',
    { timeout: 60_000 },
    () => {
      // The step timeout (4.5 s) falls inside the pipe grace that follows the step's own exit,
      // so a timer that ignored the exit would wrongly report a finished step as timed out.
      const dir = makeProject({ 'gate:types': 'node linger.mjs' });
      dirs.push(dir);
      const { stdout, stderr, status, hung } = run(dir, 4_500, 40_000);
      expect(hung, 'verify:ship waited on a pipe the finished step left open').toBe(false);
      expect(stderr).not.toContain('TIMED OUT');
      expect(status).toBe(0);
      expect(stdout).toMatch(/types\s+PASS \(exit 0\)/);
      expect(hangPid(dir), 'the lingering process never started').toBeDefined();
    },
  );
});
