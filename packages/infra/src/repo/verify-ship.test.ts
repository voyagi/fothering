import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

// This file lives at packages/infra/src/repo/, four levels below the repo root that holds the
// script under test.
const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const VERIFY_SHIP = join(REPO_ROOT, 'verify-ship.mjs');
const MUTATE_GATE = join(REPO_ROOT, 'scripts', 'mutate-gate.mjs');

const STEP_ORDER = ['types', 'tests', 'lint', 'gate', 'repo', 'selftest', 'build', 'coverage', 'e2e', 'a11y', 'mutation'];
const SUB_GATE_LINE = 'neutral-subgate: SKIPPED, nothing to check';
const SELFTEST_PASS_LINE = 'selftest ok: an absent file is a loud SKIPPED, exit 0';
const HANG_PID_FILE = 'hang.pid';
const LINGER_EXIT_FILE = 'linger.exit';
const NEXT_START_FILE = 'tests.start';
const STRYKER_RAN_FILE = 'stryker.ran';
const MUTATION_SKIP_CODE = 78;

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
  // A step that finishes at once but leaves hang.mjs running on its inherited output pipes, and
  // records the moment it exits so a test can check that moment against the step timeout.
  writeFileSync(
    join(dir, 'linger.mjs'),
    `import { spawn } from 'node:child_process';\nimport { writeFileSync } from 'node:fs';\nspawn(process.execPath, ['hang.mjs'], { stdio: 'inherit', detached: true }).unref();\nwriteFileSync('${LINGER_EXIT_FILE}', String(Date.now()));\nprocess.exit(0);\n`,
  );
  // A step that records when it starts, run after linger.mjs to show how long the grace held.
  writeFileSync(join(dir, 'stamp.mjs'), `import { writeFileSync } from 'node:fs';\nwriteFileSync('${NEXT_START_FILE}', String(Date.now()));\n`);
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

// The real mutation step: this repo's own scripts/mutate-gate.mjs, copied in, in front of a stand-in
// Stryker that records that it ran and exits with the code it is given.
function makeMutationProject(strykerExitCode = 0): string {
  const dir = makeProject({ 'mutate:gate': 'node scripts/mutate-gate.mjs', mutate: 'node stryker-stand-in.mjs' });
  mkdirSync(join(dir, 'scripts'));
  copyFileSync(MUTATE_GATE, join(dir, 'scripts', 'mutate-gate.mjs'));
  writeFileSync(
    join(dir, 'stryker-stand-in.mjs'),
    `import { writeFileSync } from 'node:fs';\nwriteFileSync('${STRYKER_RAN_FILE}', 'ran');\nprocess.exit(${strykerExitCode});\n`,
  );
  return dir;
}

function strykerRan(dir: string): boolean {
  return existsSync(join(dir, STRYKER_RAN_FILE));
}

interface RunResult {
  stdout: string;
  stderr: string;
  status: number;
  // True when this helper's own watchdog had to kill verify-ship: the script under test hung.
  hung: boolean;
}

// The script's two timer settings come from each test, never from the shell running the suite: a
// grace exported for a slow machine's verify:ship run, whose tests step runs this file, would
// otherwise stretch every wait on a step left draining. GITHUB_ACTIONS decides whether the mutation
// step may skip, and CI runs this suite with it set, so it comes from each test too. Windows reads
// environment names in any letter case, so every spelling is dropped.
const PER_TEST_SETTINGS = new Set(['VERIFY_SHIP_TIMEOUT_MS', 'VERIFY_SHIP_DRAIN_GRACE_MS', 'GITHUB_ACTIONS']);
const INHERITED_ENV = Object.fromEntries(Object.entries(process.env).filter(([name]) => !PER_TEST_SETTINGS.has(name.toUpperCase())));

// Both streams come back whatever the exit code, so a stderr check on a passing run can fail.
function run(dir: string, stepTimeoutMs = 60_000, watchdogMs = 55_000, extraEnv: Record<string, string> = {}): RunResult {
  const result = spawnSync(process.execPath, [VERIFY_SHIP], {
    cwd: dir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...INHERITED_ENV, VERIFY_SHIP_TIMEOUT_MS: String(stepTimeoutMs), ...extraEnv },
    timeout: watchdogMs,
  });
  const hung = (result.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT';
  return { stdout: result.stdout, stderr: result.stderr, status: result.status ?? 1, hung };
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

async function removeFixtures(dirs: string[]): Promise<void> {
  for (const d of dirs.splice(0)) {
    // A run can leave the hung or lingering fixture alive; stop it by the PID it recorded (never
    // by name), then wait until it is really gone, since Windows refuses to remove the folder a
    // process is still running in.
    const pid = hangPid(d);
    if (pid !== undefined && isAlive(pid)) {
      process.kill(pid);
      for (let waited = 0; isAlive(pid) && waited < 5000; waited += 100) {
        await new Promise((resolveWait) => setTimeout(resolveWait, 100));
      }
    }
    try {
      rmSync(d, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
    } catch (error) {
      // Under Node 22 on Windows the folder can stay locked after every process the fixture
      // started is gone (measured 2026-09-28: no fixture process left, EBUSY still). The test's
      // assertions have already run, so a folder left in the OS temp directory is reported by
      // name rather than failing it; any other error still fails.
      if ((error as NodeJS.ErrnoException).code !== 'EBUSY') throw error;
      console.warn(`verify-ship.test: temp folder still locked, left behind: ${d}`);
    }
  }
}

describe('verify:ship selftest step and sub-gate reporting', () => {
  const dirs: string[] = [];
  afterEach(() => removeFixtures(dirs));

  it(
    'runs every step in order with the last five SKIPPED, and repeats the SKIPPED sub-gate line the repo script printed',
    { timeout: 60_000 },
    () => {
      const dir = makeProject();
      dirs.push(dir);
      const { stdout, status } = run(dir);
      expect(status).toBe(0);
      expect(stdout, 'the run was handed a timer setting no test passed').not.toContain('ignored');

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
    'repeats the test runner summary line that counts skipped or todo tests, and only from the tests step',
    { timeout: 60_000 },
    () => {
      // The runner's own shapes, measured 2026-09-28 on vitest 4.1.11: it never prints SKIPPED.
      const skipped = '      Tests  5 passed | 2 skipped | 1 todo (8)';
      const clean = '      Tests  8 passed (8)';
      const dir = makeProject({ test: 'node runner-summary.mjs', lint: 'node lint-says-skipped.mjs' });
      dirs.push(dir);
      writeFileSync(join(dir, 'runner-summary.mjs'), `console.log('${skipped}');\nconsole.log('${clean}');\n`);
      writeFileSync(join(dir, 'lint-says-skipped.mjs'), "console.log(' Test Files  1 skipped (1)');\n");
      const { stdout, status } = run(dir);
      expect(status).toBe(0);
      const summary = stdout.slice(stdout.indexOf('verify:ship summary'));
      expect(summary).toContain(skipped.trim());
      expect(summary).not.toContain(clean.trim());
      expect(summary).not.toContain('Test Files  1 skipped');
      expect(stdout).toContain('2 sub-gate SKIPPED line(s) repeated above');
    },
  );

  it(
    'repeats a SKIPPED line intact when a two-byte character arrives split across two output chunks',
    { timeout: 60_000 },
    () => {
      // The fixture writes the line in two parts, cut inside the two bytes of U+00E9, with a pause
      // between them so the pipe delivers them as separate chunks. Both strings stay ASCII here.
      const expected = `split-gate: SKIPPED, caf${String.fromCodePoint(0xe9)} menu`;
      const dir = makeProject({ 'gate:repo': 'node split.mjs' });
      dirs.push(dir);
      writeFileSync(
        join(dir, 'split.mjs'),
        "const line = Buffer.from('split-gate: SKIPPED, caf\\u00e9 menu\\n', 'utf8');\n" +
          'const cut = line.indexOf(0xc3) + 1;\n' +
          'process.stdout.write(line.subarray(0, cut));\n' +
          'setTimeout(() => process.stdout.write(line.subarray(cut)), 300);\n',
      );
      const { stdout, status } = run(dir);
      expect(status).toBe(0);
      const summary = stdout.slice(stdout.indexOf('verify:ship summary'));
      expect(summary).toContain(expected);
      expect(summary).not.toContain(String.fromCodePoint(0xfffd));
    },
  );

  // The control for every stderr check on a passing run: without it, a helper that dropped stderr
  // on exit 0 would let each such check pass whatever the script printed.
  it('hands back what a passing step wrote to stderr', { timeout: 60_000 }, () => {
    const dir = makeProject({ lint: 'node warn.mjs' });
    dirs.push(dir);
    writeFileSync(join(dir, 'warn.mjs'), "console.error('lint: one warning, not an error');\nprocess.exit(0);\n");
    const { stderr, status } = run(dir);
    expect(status).toBe(0);
    expect(stderr).toContain('lint: one warning, not an error');
  });

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
      // The step timeout must fire after the step's own exit and inside the pipe grace that
      // follows it, so a timer that ignored the exit would wrongly report a finished step as timed
      // out. At 4.5 s against the default 5 s grace, npm's start-up under parallel load outlasted
      // the timeout (2 of 13 loaded runs failed TIMED OUT); 9 s inside a 10 s grace leaves room.
      const stepTimeoutMs = 9_000;
      const drainGraceMs = 10_000;
      const dir = makeProject({ 'gate:types': 'node linger.mjs', test: 'node stamp.mjs' });
      dirs.push(dir);
      // The step after the lingering one records when it starts: no sooner than one grace after
      // the lingering step's exit, unless the grace override was ignored.
      const startedAtMs = Date.now();
      const { stdout, stderr, status, hung } = run(dir, stepTimeoutMs, 50_000, { VERIFY_SHIP_DRAIN_GRACE_MS: String(drainGraceMs) });
      const exitFile = join(dir, LINGER_EXIT_FILE);
      const nextStartFile = join(dir, NEXT_START_FILE);
      expect(existsSync(exitFile), 'the lingering step never ran').toBe(true);
      expect(existsSync(nextStartFile), 'the step after the lingering one never ran').toBe(true);
      const exitedAtMs = Number(readFileSync(exitFile, 'utf8'));
      // verify:ship starts the step timer after startedAtMs, so this bound is conservative.
      expect(exitedAtMs - startedAtMs, 'the step exited after its own timeout, so the timer never fired inside the grace').toBeLessThan(
        stepTimeoutMs,
      );
      expect(Number(readFileSync(nextStartFile, 'utf8')) - exitedAtMs, 'the grace override was ignored').toBeGreaterThanOrEqual(
        drainGraceMs,
      );
      expect(hung, 'verify:ship waited on a pipe the finished step left open').toBe(false);
      expect(stderr).not.toContain('TIMED OUT');
      expect(status).toBe(0);
      expect(stdout).toMatch(/types\s+PASS \(exit 0\)/);
      expect(stdout, 'an override it honoured was reported as ignored').not.toContain('ignored');
      expect(hangPid(dir), 'the lingering process never started').toBeDefined();
    },
  );

  it(
    'falls back to the default step timeout and grace for an override past the timer ceiling, never to 1 ms',
    { timeout: 60_000 },
    () => {
      // Node turns a delay above 2147483647 ms into 1 ms. Taken as given, the step timeout would
      // fail every step as TIMED OUT, and the grace would end the lingering step's wait at once.
      const pastCeilingMs = 3_000_000_000;
      const dir = makeProject({ 'gate:types': 'node linger.mjs', test: 'node stamp.mjs' });
      dirs.push(dir);
      const { stdout, stderr, status, hung } = run(dir, pastCeilingMs, 50_000, { VERIFY_SHIP_DRAIN_GRACE_MS: String(pastCeilingMs) });
      expect(hung, 'verify:ship waited on a pipe the finished step left open').toBe(false);
      expect(stderr).not.toContain('TIMED OUT');
      expect(stderr, 'a delay past the ceiling reached a timer').not.toContain('TimeoutOverflowWarning');
      expect(status).toBe(0);
      // A refused value is said out loud, never taken in silence.
      expect(stdout).toContain(`[verify:ship] VERIFY_SHIP_TIMEOUT_MS=${pastCeilingMs} ignored`);
      expect(stdout).toContain(`[verify:ship] VERIFY_SHIP_DRAIN_GRACE_MS=${pastCeilingMs} ignored`);
      const exitedAtMs = Number(readFileSync(join(dir, LINGER_EXIT_FILE), 'utf8'));
      const nextStartedAtMs = Number(readFileSync(join(dir, NEXT_START_FILE), 'utf8'));
      expect(nextStartedAtMs - exitedAtMs, 'the grace was cut short instead of falling back to 5 s').toBeGreaterThanOrEqual(5_000);
    },
  );

  // On POSIX the stop signal reaches only the step's direct child. When the shell hands the step
  // to npm in its own process, that child is the stand-in npm below, which ignores the signal, so
  // only the second deadline can reach a verdict. Windows ends the whole tree with taskkill /F,
  // which no process can ignore, so there the case does not exist.
  it.skipIf(process.platform === 'win32')(
    'reaches TIMED OUT when the timed-out step ignores the stop signal',
    { timeout: 60_000 },
    () => {
      const dir = makeProject();
      dirs.push(dir);
      const binDir = join(dir, 'bin');
      mkdirSync(binDir);
      // Records its PID for cleanup, ignores the stop signal, and ends by itself after 30 s.
      writeFileSync(join(binDir, 'npm'), `#!/bin/sh\necho $$ > ${HANG_PID_FILE}\ntrap '' TERM\nsleep 30\n`, { mode: 0o755 });
      const { stderr, status, hung } = run(dir, 3_000, 40_000, { PATH: `${binDir}:${process.env.PATH ?? ''}` });
      expect(hung, 'verify:ship never reached a verdict for a step that ignored the stop signal').toBe(false);
      expect(stderr).toContain('types TIMED OUT');
      expect(status).not.toBe(0);
    },
  );
});

// The mutation step's own skip. A full Stryker run no longer fits on a GitHub-hosted runner, so
// scripts/mutate-gate.mjs declares a skip there when Stryker has no incremental file to start from,
// and runs Stryker everywhere else. The tests drive the whole gate, so the exit code the script keeps
// for that skip and the skipCode verify-ship.mjs reads for the step are checked against each other.
describe('verify:ship mutation step on a hosted runner', () => {
  const dirs: string[] = [];
  afterEach(() => removeFixtures(dirs));

  function summaryOf(stdout: string): string {
    return stdout.slice(stdout.indexOf('verify:ship summary'));
  }

  it(
    'skips Stryker loudly on a GitHub Actions runner with no incremental file, and never reads the step as PASS',
    { timeout: 60_000 },
    () => {
      const dir = makeMutationProject();
      dirs.push(dir);
      const { stdout, status } = run(dir, 60_000, 55_000, { GITHUB_ACTIONS: 'true' });
      expect(status).toBe(0);
      expect(strykerRan(dir), 'Stryker started although the step skipped').toBe(false);
      const summary = summaryOf(stdout);
      expect(summary).toMatch(new RegExp(`mutation\\s+SKIPPED \\(exit ${MUTATION_SKIP_CODE}\\)`));
      expect(summary).not.toMatch(/mutation\s+PASS/);
      expect(summary, 'the reason for the skip is not repeated under the step').toContain('[mutate:gate] mutation SKIPPED');
      expect(stdout).toContain('verify:ship: PASS (6/11 steps green, 5 SKIPPED as not applicable: build, coverage, e2e, a11y, mutation');
    },
  );

  it('runs Stryker on a GitHub Actions runner that has an incremental file', { timeout: 60_000 }, () => {
    const dir = makeMutationProject();
    dirs.push(dir);
    mkdirSync(join(dir, 'reports'));
    writeFileSync(join(dir, 'reports', 'stryker-incremental.json'), '{}\n');
    const { stdout, status } = run(dir, 60_000, 55_000, { GITHUB_ACTIONS: 'true' });
    expect(status).toBe(0);
    expect(strykerRan(dir)).toBe(true);
    expect(summaryOf(stdout)).toMatch(/mutation\s+PASS \(exit 0\)/);
  });

  it('runs Stryker through the gate where GITHUB_ACTIONS is not set', { timeout: 60_000 }, () => {
    const dir = makeMutationProject();
    dirs.push(dir);
    const { stdout, status } = run(dir);
    expect(status).toBe(0);
    expect(strykerRan(dir)).toBe(true);
    expect(summaryOf(stdout)).toMatch(/mutation\s+PASS \(exit 0\)/);
  });

  // Only the exact value the runner sets may skip; anything else a local shell might carry runs
  // Stryker. The value that skips goes first, so the loop is known to tell the two apart.
  it('skips for GITHUB_ACTIONS exactly true and runs Stryker for every other value', { timeout: 60_000 }, () => {
    const dir = makeMutationProject();
    dirs.push(dir);
    const runScript = (value: string) =>
      spawnSync(process.execPath, [join('scripts', 'mutate-gate.mjs')], {
        cwd: dir,
        encoding: 'utf8',
        env: { ...INHERITED_ENV, GITHUB_ACTIONS: value },
        timeout: 30_000,
      });
    expect(runScript('true').status).toBe(MUTATION_SKIP_CODE);
    expect(strykerRan(dir), 'Stryker started although the step skipped').toBe(false);
    for (const value of ['', 'false', 'TRUE', '1', ' true']) {
      rmSync(join(dir, STRYKER_RAN_FILE), { force: true });
      expect(runScript(value).status, `GITHUB_ACTIONS=${JSON.stringify(value)}`).toBe(0);
      expect(strykerRan(dir), `Stryker did not run for GITHUB_ACTIONS=${JSON.stringify(value)}`).toBe(true);
    }
  });

  it('fails the gate when Stryker fails', { timeout: 60_000 }, () => {
    const dir = makeMutationProject(1);
    dirs.push(dir);
    const { stdout, status } = run(dir);
    expect(status).toBe(1);
    expect(stdout).toContain('verify:ship: FAIL at step "mutation"');
    expect(summaryOf(stdout)).toMatch(/mutation\s+FAIL \(exit 1\)/);
  });

  it('fails, never skips, when Stryker itself exits with the code the skip keeps', { timeout: 60_000 }, () => {
    const dir = makeMutationProject(MUTATION_SKIP_CODE);
    dirs.push(dir);
    const { stdout, stderr, status } = run(dir);
    expect(status).toBe(1);
    expect(strykerRan(dir)).toBe(true);
    expect(stderr).toContain('[mutate:gate] Stryker exited 78');
    expect(summaryOf(stdout)).toMatch(/mutation\s+FAIL \(exit 1\)/);
    expect(stdout).toContain('verify:ship: FAIL at step "mutation"');
  });

  it('fails any other step that exits with that code: only the mutation step declares it', { timeout: 60_000 }, () => {
    const dir = makeProject({ lint: 'node exit-skip-code.mjs' });
    dirs.push(dir);
    writeFileSync(join(dir, 'exit-skip-code.mjs'), `process.exit(${MUTATION_SKIP_CODE});\n`);
    const { stdout, status } = run(dir);
    expect(status).not.toBe(0);
    expect(stdout).toContain('verify:ship: FAIL at step "lint"');
    expect(summaryOf(stdout)).toMatch(new RegExp(`lint\\s+FAIL \\(exit ${MUTATION_SKIP_CODE}\\)`));
  });

  // On POSIX a path through a file fails with ENOTDIR, an error other than absence. Windows reports
  // that path as absent (ENOENT, measured 2026-10-17), so there this case cannot be built this way.
  it.skipIf(process.platform === 'win32')(
    'fails rather than skips when the incremental file cannot be checked',
    { timeout: 60_000 },
    () => {
      const dir = makeMutationProject();
      dirs.push(dir);
      writeFileSync(join(dir, 'reports'), 'a file where the reports folder belongs\n');
      const { stdout, stderr, status } = run(dir, 60_000, 55_000, { GITHUB_ACTIONS: 'true' });
      expect(status).toBe(1);
      expect(strykerRan(dir)).toBe(false);
      expect(stderr).toContain('[mutate:gate] could not check');
      expect(summaryOf(stdout)).toMatch(/mutation\s+FAIL \(exit 1\)/);
    },
  );
});
