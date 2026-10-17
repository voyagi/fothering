#!/usr/bin/env node
// mutate-gate.mjs - the ship gate's mutation step: runs Stryker, except where a full run cannot fit.
//
// WHY THIS EXISTS. Measured 2026-10-17 on the gate job's GitHub-hosted runner: with no incremental
// file, Stryker tested 3855 of this repo's 5848 mutants in the step's 4 hours and estimated 4h15m
// more, and GitHub ends a hosted job at 6 hours whatever the step allows, so no timeout setting makes
// that run fit. Stryker re-tests only what changed when it starts from its incremental file
// (reports/stryker-incremental.json, gitignored), which a local run keeps and a fresh runner lacks.
//
// THE RULE. On GitHub Actions (GITHUB_ACTIONS exactly `true`, the value the runner sets) with no
// incremental file, the step declares that it audited nothing: it prints a SKIPPED line and exits
// SKIP_CODE, which verify-ship.mjs records for this step as SKIPPED, never PASS, and names in its
// verdict line. Everywhere else, and on a runner that does have the file, Stryker runs as before, so
// a local `npm run verify:ship` still runs the whole configured mutate list.
//
// SKIP_CODE means that decision and nothing else. A Stryker run that itself exits with it fails the
// step, and so does any error checking for the file other than its absence.
//
// Exit codes: Stryker's own, SKIP_CODE (78) for the declared skip, 1 when Stryker could not run.

import { spawnSync } from 'node:child_process';
import { statSync } from 'node:fs';

// verify-ship.mjs reads the same number as this step's skipCode; verify-ship.test.ts runs this file
// through the real gate, so the two cannot drift apart unnoticed.
const SKIP_CODE = 78;
const INCREMENTAL_FILE = 'reports/stryker-incremental.json';

function hasIncrementalFile() {
  try {
    statSync(INCREMENTAL_FILE);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

function runStryker() {
  const run = spawnSync('npm run mutate', { stdio: 'inherit', shell: true });
  if (run.error) {
    console.error(`[mutate:gate] could not start Stryker: ${run.error.message}`);
    return 1;
  }
  if (run.status === null) {
    console.error(`[mutate:gate] Stryker was ended by ${run.signal}`);
    return 1;
  }
  if (run.status === SKIP_CODE) {
    console.error(`[mutate:gate] Stryker exited ${SKIP_CODE}, the code this step keeps for its skip, so it is reported as a failure.`);
    return 1;
  }
  return run.status;
}

function main() {
  let incremental;
  try {
    incremental = hasIncrementalFile();
  } catch (error) {
    console.error(`[mutate:gate] could not check ${INCREMENTAL_FILE}: ${error.message}. Failing rather than skipping.`);
    return 1;
  }
  if (process.env.GITHUB_ACTIONS === 'true' && !incremental) {
    console.log(
      `[mutate:gate] mutation SKIPPED on this GitHub Actions runner: there is no ${INCREMENTAL_FILE}, so Stryker ` +
        'would test every mutant, which outlasts a hosted job. The full run is the local `npm run verify:ship`.',
    );
    return SKIP_CODE;
  }
  return runStryker();
}

process.exit(main());
