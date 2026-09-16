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
// then a build, then the OPTIONAL surfaces (coverage floors, e2e, the live
// a11y audit, mutation) - each optional step runs when its script exists and
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
//   - On Windows a timed-out step's grandchildren (the shell dies, npm/node may
//     not) can linger and keep printing after the FAIL verdict. The verdict is
//     still correct; kill the leftover node process manually if one hangs on.

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

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
const timeoutOverride = Number(process.env.VERIFY_SHIP_TIMEOUT_MS);
const STEP_TIMEOUT_MS =
  Number.isFinite(timeoutOverride) && timeoutOverride > 0 ? timeoutOverride : 30 * 60 * 1000;

// The CORE four are unconditional: a missing script exits non-zero, which is the correct
// fail-closed behavior for surfaces every product has.
//
// The OPTIONAL steps below them exist because "not applicable" and "silently absent" must not
// read the same: a step whose `script` is not in package.json prints one loud SKIPPED line
// (with what would make it applicable) and does not fail the run; the moment the product gains
// the script, the step runs and enforces. That is the difference between a backend product
// honestly having no a11y surface and a web product quietly never auditing one.
//   - build precedes a11y/e2e because both audit BUILT output (`--if-present` keeps it a no-op
//     on products with no build script).
//   - a11y  = the live axe gate (a11y-live.mjs), AFTER the build, per its own section in the
//     README. A static a11y pass is a lint, not this step.
//   - coverage / e2e run whatever the product wired under those names, floors included.
//   - mutation runs LAST (slowest) with its own longer timeout. Its score is a measurement
//     (break stays null in stryker.config.json); the step exists so the run and the recorded
//     score cannot be skipped silently at ship time.
//
// There are TWO ways a step can be skipped, and both must read as SKIPPED rather than PASS:
//   1. `script` names a package.json script that does not exist - the step never runs.
//   2. `skipCode` names an exit code with which the step DECLARES, at run time, that it
//      audited nothing: a product's e2e runner on a CI host that carries no browser, say,
//      exiting a code it reserves for exactly that. Without the declaration such a runner has
//      two dishonest choices, exit 0 and print PASS over nothing, or exit non-zero and fail a
//      run that broke nothing.
// No harness in this directory declares one today, so no step below carries a skipCode: the
// mechanism is dormant until a product's harness earns it. a11y-live.mjs is NOT a candidate.
// Its exit 2 means a broken config (zero routes or themes, a selector matching nothing) or a
// page that never finished loading, and every one of those must FAIL, never skip.
// Only a step that declares a skipCode may claim the second kind. A blanket "exit 3 means
// skipped" would be a new hole of exactly the shape this script exists to close: tsc exits 3
// for an invalid project (ExitStatus.InvalidProject_OutputsSkipped), so a broken tsconfig
// under the `types` step would be recorded SKIPPED and the run would print PASS over it.
const STEPS = [
  { name: 'types', cmd: 'npm run gate:types' }, // tsc --noEmit
  { name: 'tests', cmd: 'npm test' },           // FULL suite, one-shot
  { name: 'lint',  cmd: 'npm run lint' },       // WHOLE-repo lint
  { name: 'gate',  cmd: 'npm run gate' },       // committed gate chain (floors)
  { name: 'repo', cmd: 'npm run gate:repo', script: 'gate:repo', appliesWhen: 'the repo-hygiene gates (goals, gitignore, hookspath, license, identity, artifact metadata, compliance, icon decision, human-todo classification) are installed with their gate:repo script' },
  { name: 'build', cmd: 'npm run build --if-present' },
  { name: 'coverage', cmd: 'npm run test:coverage', script: 'test:coverage', appliesWhen: 'a test:coverage script with floors exists' },
  { name: 'e2e', cmd: 'npm run test:e2e', script: 'test:e2e', appliesWhen: 'a test:e2e script exists' },
  { name: 'a11y', cmd: 'npm run a11y:live', script: 'a11y:live', appliesWhen: 'the product renders HTML and a11y-live.mjs is installed' },
  { name: 'mutation', cmd: 'npm run mutate', script: 'mutate', appliesWhen: 'stryker is configured', timeoutMs: 4 * 60 * 60 * 1000 },
];

// Read once; an unreadable or unparsable package.json means the optional steps cannot be told
// apart from missing, so they RUN (and fail closed on the missing script) rather than skip.
let pkgScripts = null;
try { pkgScripts = JSON.parse(readFileSync('package.json', 'utf8')).scripts || {}; } catch { pkgScripts = null; }

const results = [];
let failed = null;

for (const step of STEPS) {
  if (failed) {
    results.push({ ...step, status: 'NOT RUN', code: null });
    continue;
  }
  if (step.script && pkgScripts && !Object.prototype.hasOwnProperty.call(pkgScripts, step.script)) {
    console.log(`\n[verify:ship] SKIPPED "${step.name}": no "${step.script}" script in package.json. ` +
      `Not applicable until ${step.appliesWhen}; add the script and this step enforces itself.`);
    results.push({ ...step, status: 'SKIPPED', code: null });
    continue;
  }
  console.log(`\n[verify:ship] running "${step.name}": ${step.cmd}`);
  const stepTimeout = step.timeoutMs || STEP_TIMEOUT_MS;
  const r = spawnSync(step.cmd, { shell: true, stdio: 'inherit', timeout: stepTimeout });
  let code;
  // Order matters: a timeout kill sets BOTH r.error (ETIMEDOUT) and r.signal,
  // so diagnose it first or the message misreports it as "could not run".
  if (r.error && r.error.code === 'ETIMEDOUT') {
    console.error(`[verify:ship] ${step.name} TIMED OUT after ${stepTimeout / 60000} min (hung step?) - killed`);
    code = 1;
  } else if (r.error) {
    console.error(`[verify:ship] ${step.name} could not run: ${r.error.message}`);
    code = 1;
  } else if (r.status === null) {
    console.error(`[verify:ship] ${step.name} killed by signal ${r.signal}`);
    code = 1;
  } else {
    code = r.status;
  }
  console.log(`[verify:ship] ${step.name} exited ${code}`);
  // A declared skip (see the skipCode note above the STEPS table) is neither a pass nor a
  // failure: it is recorded SKIPPED, it counts in the verdict line's skip list, and it does
  // not stop the run. Only the step that declares the code may use it.
  const declaredSkip = step.skipCode !== undefined && code === step.skipCode;
  const status = code === 0 ? 'PASS' : declaredSkip ? 'SKIPPED' : 'FAIL';
  results.push({ ...step, status, code });
  if (status === 'FAIL') failed = { name: step.name, code };
}

const pad = Math.max(...STEPS.map((s) => s.name.length));
console.log('\n============ verify:ship summary ============');
for (const r of results) {
  const codeStr = r.code === null ? '' : ` (exit ${r.code})`;
  console.log(`  ${r.name.padEnd(pad)}  ${r.status}${codeStr}`);
}
console.log('=============================================');

if (failed) {
  console.log(`verify:ship: FAIL at step "${failed.name}" (exit ${failed.code})`);
  process.exit(failed.code || 1);
}
// The skip count prints IN the verdict line, never only in the scroll above it: a PASS that
// silently absorbed skips is the scoped-pass-as-full-pass claim this script exists to kill.
// `green` counts PASS only, so a skipped step is missing from the ratio as well as named in
// the list, and the trailing clause says what the reader is entitled to conclude.
const green = results.filter((r) => r.status === 'PASS').length;
const skippedSteps = results.filter((r) => r.status === 'SKIPPED');
console.log(`verify:ship: PASS (${green}/${STEPS.length} steps green` +
  (skippedSteps.length
    ? `, ${skippedSteps.length} SKIPPED as not applicable: ${skippedSteps.map((s) => s.name).join(', ')}` +
      ' - a SKIPPED step audited nothing, so this PASS does not cover it'
    : '') + ')');
process.exit(0);
