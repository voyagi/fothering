#!/usr/bin/env node
// verify-ship.mjs - the ONE ship-verification command.
//
// A clean claim is this script's output, not a sentence. Every step prints its
// own exit code, the run stops at the first non-zero, and the summary block is
// the only acceptable evidence of "clean at ship".
//
// Why it exists: a pass covers only what it ran on. "vitest green" type-checks
// nothing, changed-files lint is not whole-repo lint, and a scoped check quoted
// as a full pass is how false ship-claims happen. This script runs the FULL
// surface, in order, cheapest-first:
//
//   1. types - tsc --noEmit           (a green test run never proves this)
//   2. tests - the FULL suite         (no --changed, no filters, one-shot run)
//   3. lint  - the WHOLE repo         (never a changed-files subset)
//   4. gate  - the committed floors   (complexity, duplication, boundaries, ...)
//
// `gate` re-runs the type-check inside its own chain; the duplication is
// deliberate - step 1 fails fast on the cheapest honest signal.
//
// After the core four: the repo-hygiene chain (gate:repo, needs no build),
// then a selftest of every gate script's own --selftest controls, then a
// build, then the OPTIONAL surfaces (coverage floors, e2e, the live a11y
// audit, mutation) - each optional step runs when its script exists and
// prints one loud SKIPPED line when it does not, so "not applicable" is a
// visible statement rather than a silent absence. See the STEPS comment.
//
// Wiring: copy this file to the product repo root and add
//   "verify:ship": "node verify-ship.mjs"
// to package.json scripts. Adapt the STEPS commands to the product's real
// scripts (they must exist - a missing script exits non-zero, which is the
// correct fail-closed behavior). A watch-mode test script will hang this gate:
// `npm test` must be a one-shot run (e.g. `vitest run`, not `vitest`) - and as
// a backstop each step is killed (and FAILS) after STEP_TIMEOUT_MS.
//
// Residual limitations (not fixable here):
//   - On POSIX the kernel truncates a child's exit status to 8 bits, so a tool
//     exiting with an exact multiple of 256 reads as 0 everywhere (any shell,
//     not just this script). No mainstream tool does that.
//   - On POSIX a timed-out step is signalled through its direct child only (npm
//     passes the signal on), so a grandchild that ignores it can linger and keep
//     printing after the FAIL verdict. The verdict is still reached on time: see
//     DRAIN_GRACE_MS, and runStep's second deadline for a direct child that ignores
//     the signal as well. On Windows the whole step tree is ended (killStepTree).

import { spawn, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';

// Generous by design: it must never fail a legitimately slow FULL suite; it
// only backstops a genuine hang (watch mode, a stuck prompt). Raise per
// product if a real run needs more.
// Overridable via VERIFY_SHIP_TIMEOUT_MS so the backstop is PROVABLE: with a
// hardcoded 30 min the only way to exercise this branch was to edit the file,
// which means nobody ever proved it fires (a gate never seen failing is
// not proven). `npx cross-env VERIFY_SHIP_TIMEOUT_MS=4000 npm run
// verify:ship` against a deliberately hung script shows it working in seconds.
// A non-numeric or non-positive value falls back to the default rather than
// disabling the guard - an env typo must not silently remove the backstop.
// So does a value past setTimeout's ceiling: Node turns any delay above
// 2147483647 ms (about 24.8 days) into 1 ms, so an over-large override would
// fire at once instead of never. A refused value is named in one line, so a
// typo (`4s`, or `4_000`, which Number() does not read) is never a silent
// wait for the full default.
const MAX_TIMER_MS = 2_147_483_647;
function msOverride(name, fallbackMs) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallbackMs;
  const value = Number(raw);
  if (Number.isFinite(value) && value > 0 && value <= MAX_TIMER_MS) return value;
  console.log(`[verify:ship] ${name}=${raw} ignored: not a number of ms above 0 and at most ${MAX_TIMER_MS}; using the default ${fallbackMs} ms.`);
  return fallbackMs;
}
const STEP_TIMEOUT_MS = msOverride('VERIFY_SHIP_TIMEOUT_MS', 30 * 60 * 1000);

// The CORE four are unconditional: a missing script exits non-zero, which is the correct
// fail-closed behavior for surfaces every product has.
//
// The OPTIONAL steps below them exist because "not applicable" and "silently absent" must not
// read the same: a step whose `script` is not in package.json prints one loud SKIPPED line
// (with what would make it applicable) and does not fail the run; the moment the product gains
// the script, the step runs and enforces. That is the difference between a backend product
// honestly having no a11y surface and a web product quietly never auditing one.
//   - selftest runs every gate script's own --selftest controls once, after the repo-hygiene
//     chain and before the build: a gate whose --selftest itself regressed is caught here, not
//     discovered the day a real mutation slips past it silently.
//   - build precedes a11y/e2e because both audit BUILT output (`--if-present` keeps it a no-op
//     on products with no build script).
//   - a11y  = the live axe gate (a11y-live.mjs), AFTER the build, per its own section in the
//     README. A static a11y pass is a lint, not this step.
//   - coverage / e2e run whatever the product wired under those names, floors included.
//   - mutation runs LAST (slowest) with its own longer timeout. Its score is a measurement
//     (break stays null in stryker.config.json); the step exists so the run and the recorded
//     score cannot be skipped silently at ship time. On a hosted CI runner it can skip LOUDLY
//     (its skipCode, below), never silently.
//
// There are TWO ways a step can be skipped, and both must read as SKIPPED rather than PASS:
//   1. `script` names a package.json script that does not exist - the step never runs.
//   2. `skipCode` names an exit code with which the step DECLARES, at run time, that it
//      audited nothing: a product's e2e runner on a CI host that carries no browser, say,
//      exiting a code it reserves for exactly that. Without the declaration such a runner has
//      two dishonest choices, exit 0 and print PASS over nothing, or exit non-zero and fail a
//      run that broke nothing.
// One step declares one: mutation exits 78 through scripts/mutate-gate.mjs on a GitHub-hosted runner
// that has no Stryker incremental file, where a full run outlasts the job (that script says why).
// a11y-live.mjs is NOT a candidate.
// Its exit 2 means a broken config (zero routes or themes, a selector matching nothing) or a
// page that never finished loading, and every one of those must FAIL, never skip.
// Only a step that declares a skipCode may claim the second kind. A blanket "exit 3 means
// skipped" would be a new hole of exactly the shape this script exists to close: tsc exits 3
// for an invalid project (ExitStatus.InvalidProject_OutputsSkipped), so a broken tsconfig
// under the `types` step would be recorded SKIPPED and the run would print PASS over it.
//
// The test runner never prints SKIPPED: a skipped or todo test shows only as a lower-case count on
// its summary lines ("Tests  5 passed | 2 skipped | 1 todo (8)", vitest 4.1). The tests step names
// that shape as its skipLine, so the line is repeated like a sub-gate's and a PASS never absorbs a
// test that did not run. Only that step: another tool's lower-case word means nothing here.
const RUNNER_SKIP_RE = /^\s*Test(?:s| Files)\s.*\b\d+ (?:skipped|todo)\b/;
const STEPS = [
  { name: 'types', cmd: 'npm run gate:types' }, // tsc --noEmit
  { name: 'tests', cmd: 'npm test', skipLine: RUNNER_SKIP_RE }, // FULL suite, one-shot
  { name: 'lint',  cmd: 'npm run lint' },       // WHOLE-repo lint
  { name: 'gate',  cmd: 'npm run gate' },       // committed gate chain (floors)
  { name: 'repo', cmd: 'npm run gate:repo', script: 'gate:repo', appliesWhen: 'the repo-hygiene gates (goals, gitignore, hookspath, license, identity, artifact metadata, compliance, icon decision, human-todo classification) are installed with their gate:repo script' },
  { name: 'selftest', cmd: 'npm run gate:selftest', script: 'gate:selftest', appliesWhen: 'the gate scripts carry --selftest controls and a gate:selftest script runs them' },
  { name: 'build', cmd: 'npm run build', script: 'build', appliesWhen: 'a package in the workspace has something to build' },
  { name: 'coverage', cmd: 'npm run test:coverage', script: 'test:coverage', appliesWhen: 'a test:coverage script with floors exists' },
  { name: 'e2e', cmd: 'npm run test:e2e', script: 'test:e2e', appliesWhen: 'a test:e2e script exists' },
  { name: 'a11y', cmd: 'npm run a11y:live', script: 'a11y:live', appliesWhen: 'the product renders HTML and a11y-live.mjs is installed' },
  { name: 'mutation', cmd: 'npm run mutate:gate', script: 'mutate:gate', appliesWhen: 'stryker is configured and scripts/mutate-gate.mjs runs it', timeoutMs: 4 * 60 * 60 * 1000, skipCode: 78 },
];

// Read once; an unreadable or unparsable package.json means the optional steps cannot be told
// apart from missing, so they RUN (and fail closed on the missing script) rather than skip.
let pkgScripts = null;
try { pkgScripts = JSON.parse(readFileSync('package.json', 'utf8')).scripts || {}; } catch { pkgScripts = null; }

// How long a step's output pipes may stay open after the step's own process exited. Anything
// the step left running (a timed-out step's surviving grandchild, a daemon a script started)
// inherits those pipes, and `close` waits for every holder: without this bound the run would
// hang with no verdict, the exact failure the step timeout exists to prevent.
// Overridable via VERIFY_SHIP_DRAIN_GRACE_MS for the same reason as the step timeout: proving that
// a step timer firing inside the grace never blames a finished step needs a timer set after the
// step's own exit and before the grace ends, and npm and node together have taken over 4.5 s to
// start a step on a loaded machine. A value msOverride refuses falls back to the default.
const DRAIN_GRACE_MS = msOverride('VERIFY_SHIP_DRAIN_GRACE_MS', 5000);

// A gate script's --selftest prints `selftest ok: <control>` for each control that PASSED, and some
// of those controls are about skipping (`selftest ok: an absent file is a loud SKIPPED, exit 0`).
// Such a line proves a gate skips loudly; it is never itself a sub-gate that audited nothing, so it
// is set aside. Only that exact prefix at the start of the line is: a failing control exits non-zero
// and fails its step, and any other line naming the word is still repeated.
const SELFTEST_PASS_RE = /^selftest ok: /;

// Colour codes are dropped before any match, and from the line the summary repeats, so a tool run
// with colour forced on matches exactly as it does in a plain pipe.
const COLOUR_CODE_RE = /\u001b\[[0-9;]*m/g;

// Ends a timed-out step. On Windows a signalled shell dies alone while npm, node and the tool
// under them live on holding the output pipes, so the whole tree is ended from this one PID with
// taskkill /T (by PID, never by name). Everywhere else, and whenever taskkill fails, the direct
// child is signalled.
function killStepTree(child) {
  if (process.platform === 'win32' && child.pid !== undefined) {
    const r = spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    if (r.status === 0) return;
  }
  child.kill();
}

// Runs one step asynchronously: stdin inherited, stdout and stderr piped and written straight
// through to the parent streams AS THEY ARRIVE (a slow step's output must never be held back
// until it exits), while every line crossing either stream is also scanned for the uppercase
// word SKIPPED. A sub-gate that declares itself SKIPPED inside a step that itself exits 0 is
// otherwise invisible to anything reading only that step's own exit code - exactly the
// scoped-pass-as-full-pass failure this script exists to catch one level up. The timeout is a
// manual kill rather than spawnSync's built-in option, because streaming needs the async spawn
// API; killStepTree and DRAIN_GRACE_MS are what keep a hung step from hanging the run.
function runStep(step, stepTimeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(step.cmd, { shell: true, stdio: ['inherit', 'pipe', 'pipe'] });
    const subGates = [];
    let timedOut = false;
    let settled = false;
    let drainTimer;
    let forceTimer;

    const timer = setTimeout(() => {
      // A step that already exited is only draining its pipes: that is DRAIN_GRACE_MS's job, and
      // reporting it as TIMED OUT would blame a step that finished.
      if (child.exitCode !== null || child.signalCode !== null) return;
      timedOut = true;
      killStepTree(child);
      // A direct child that ignores the stop signal never fires `exit`, so the drain timer never
      // starts and nothing would reach a verdict. One grace period after the kill it is killed
      // outright, and the verdict is given either way.
      forceTimer = setTimeout(() => {
        child.kill('SIGKILL');
        finish(outcome(null));
      }, DRAIN_GRACE_MS);
    }, stepTimeoutMs);

    function scanLine(line) {
      const plain = line.replace(COLOUR_CODE_RE, '');
      const gateSkip = /\bSKIPPED\b/.test(plain) && !SELFTEST_PASS_RE.test(plain);
      const runnerSkip = step.skipLine !== undefined && step.skipLine.test(plain);
      if (gateSkip || runnerSkip) subGates.push(plain);
    }

    // A multi-byte character can straddle two chunks. Decoded chunk by chunk, both halves become
    // replacement characters in the line the summary repeats; one decoder per stream holds the
    // partial bytes back until the rest arrives.
    function relay(source, sink) {
      const decoder = new StringDecoder('utf8');
      let buf = '';
      source.on('data', (chunk) => {
        sink.write(chunk);
        buf += decoder.write(chunk);
        let newline;
        while ((newline = buf.indexOf('\n')) !== -1) {
          scanLine(buf.slice(0, newline));
          buf = buf.slice(newline + 1);
        }
      });
      source.on('end', () => {
        buf += decoder.end();
        if (buf) scanLine(buf);
      });
    }
    relay(child.stdout, process.stdout);
    relay(child.stderr, process.stderr);

    function finish(result) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(drainTimer);
      clearTimeout(forceTimer);
      // Whatever the step left running must not interleave its output with the summary.
      child.stdout.destroy();
      child.stderr.destroy();
      resolve({ ...result, subGates });
    }

    // Order matters: a kill from the timeout above can still deliver `code: null` or a signal,
    // so the timedOut flag is checked first, or the message would misreport a genuine hang as
    // "killed by signal" with no mention of the timeout that caused it.
    function outcome(code) {
      if (timedOut) return { kind: 'timeout' };
      if (code === null) return { kind: 'signal' };
      return { kind: 'exit', code };
    }

    child.on('error', (err) => finish({ kind: 'error', message: err.message }));
    // `close` normally follows `exit` within milliseconds, once the pipes drain; the grace timer
    // reaches the verdict anyway when something the step left behind keeps them open.
    child.on('exit', (code) => {
      drainTimer = setTimeout(() => finish(outcome(code)), DRAIN_GRACE_MS);
    });
    child.on('close', (code) => finish(outcome(code)));
  });
}

const results = [];
let failed = null;

for (const step of STEPS) {
  if (failed) {
    results.push({ ...step, status: 'NOT RUN', code: null, subGates: [] });
    continue;
  }
  if (step.script && pkgScripts && !Object.prototype.hasOwnProperty.call(pkgScripts, step.script)) {
    console.log(`\n[verify:ship] SKIPPED "${step.name}": no "${step.script}" script in package.json. ` +
      `Not applicable until ${step.appliesWhen}; add the script and this step enforces itself.`);
    results.push({ ...step, status: 'SKIPPED', code: null, subGates: [] });
    continue;
  }
  console.log(`\n[verify:ship] running "${step.name}": ${step.cmd}`);
  const stepTimeout = step.timeoutMs || STEP_TIMEOUT_MS;
  const r = await runStep(step, stepTimeout);
  let code;
  if (r.kind === 'timeout') {
    const limit = stepTimeout >= 60000 ? `${stepTimeout / 60000} min` : `${stepTimeout / 1000} s`;
    console.error(`[verify:ship] ${step.name} TIMED OUT after ${limit} (hung step?) - killed`);
    code = 1;
  } else if (r.kind === 'error') {
    console.error(`[verify:ship] ${step.name} could not run: ${r.message}`);
    code = 1;
  } else if (r.kind === 'signal') {
    console.error(`[verify:ship] ${step.name} killed by signal`);
    code = 1;
  } else {
    code = r.code;
  }
  console.log(`[verify:ship] ${step.name} exited ${code}`);
  // A declared skip (see the skipCode note above the STEPS table) is neither a pass nor a
  // failure: it is recorded SKIPPED, it counts in the verdict line's skip list, and it does
  // not stop the run. Only the step that declares the code may use it.
  const declaredSkip = step.skipCode !== undefined && code === step.skipCode;
  const status = code === 0 ? 'PASS' : declaredSkip ? 'SKIPPED' : 'FAIL';
  results.push({ ...step, status, code, subGates: r.subGates });
  if (status === 'FAIL') failed = { name: step.name, code };
}

const pad = Math.max(...STEPS.map((s) => s.name.length));
// Counted by text: the gate chain runs gate:repo inside itself and the repo step runs it again, so
// one sub-gate's skip is printed twice and would otherwise read as two sub-gates that audited nothing.
const distinctSubGates = new Set();
console.log('\n============ verify:ship summary ============');
for (const r of results) {
  const codeStr = r.code === null ? '' : ` (exit ${r.code})`;
  console.log(`  ${r.name.padEnd(pad)}  ${r.status}${codeStr}`);
  // Every SKIPPED sub-gate line the step's own output printed is repeated here, indented under
  // its step, in run order - a PASS above must never be the only trace of a sub-gate that
  // audited nothing.
  for (const line of r.subGates) {
    console.log(`      ${line}`);
    distinctSubGates.add(line.trim());
  }
}
const subGateCount = distinctSubGates.size;
console.log('=============================================');

if (failed) {
  console.log(`verify:ship: FAIL at step "${failed.name}" (exit ${failed.code})`);
  process.exit(failed.code || 1);
}
// The skip counts print IN the verdict line, never only in the scroll above it: a PASS that
// silently absorbed a skipped step or sub-gate is the scoped-pass-as-full-pass claim this script
// exists to kill. `green` counts PASS only, so a skipped step is missing from the ratio as well
// as named in the list, and the trailing clause says what the reader is entitled to conclude.
const green = results.filter((r) => r.status === 'PASS').length;
const skippedSteps = results.filter((r) => r.status === 'SKIPPED');
const skipNotes = [];
if (skippedSteps.length) {
  skipNotes.push(`${skippedSteps.length} SKIPPED as not applicable: ${skippedSteps.map((s) => s.name).join(', ')}`);
}
if (subGateCount) {
  skipNotes.push(`${subGateCount} sub-gate SKIPPED line(s) repeated above`);
}
console.log(`verify:ship: PASS (${green}/${STEPS.length} steps green` +
  (skipNotes.length
    ? `, ${skipNotes.join(', ')} - a SKIPPED step or sub-gate audited nothing, so this PASS does not cover it`
    : '') + ')');
process.exit(0);
