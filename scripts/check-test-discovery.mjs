#!/usr/bin/env node
// check-test-discovery.mjs - every tracked test file must be a file the test runner actually
// collects, or it reads as coverage while running nothing.
//
// WHY THIS EXISTS. Verified 2026-09-23: a vitest `list` run with a filter that matches nothing
// prints nothing and exits 0. That means a test tracked in git but sitting outside the runner's
// own include glob never fails anywhere in the pipeline, because there is nothing to fail: `npm
// test` reports a clean run over a suite that quietly does not contain it. A gate that only checks
// "does the suite pass" cannot catch this; it has to compare the tracked list against the runner's
// own list.
//
// TWO RULES.
//   1. TRACKED BUT UNLISTED. Every tracked `*.test.ts` file, except the exclusion suffix
//      `*.fault.test.ts` (the same suffix vitest.config.ts excludes, so the two lists cannot drift
//      silently; plan 01-13's repo-hardening test pins that they match), must appear in the
//      runner's own file list. A tracked test the runner never lists is a finding, since nothing
//      downstream ever exercises it. This reaches a test placed anywhere in the tracked tree, not
//      only inside the runner's usual include path, which is exactly the case a narrower "is it
//      inside packages/*/src" check would miss.
//   2. LISTED BUT UNTRACKED is an advisory only. A generated or gitignored file the runner happens
//      to pick up is not a coverage gap.
//
// AN EMPTY LISTING IS NEVER CLEAN. Zero files back from the runner is indistinguishable from a
// filter matching nothing, which is the exact silent failure this gate exists to catch, so it is
// UNKNOWN (exit 2), never a pass with nothing left to check.
//
// Usage:
//   node scripts/check-test-discovery.mjs             check the repo
//   node scripts/check-test-discovery.mjs --selftest   prove the gate still fires
//
// Exit codes: 0 clean, 1 findings, 2 the scan could not run (UNKNOWN). Findings outrank UNKNOWN.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';

// --- git helpers, identical in shape to check-tsconfig-coverage.mjs ----------------------------

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
}

function repoRoot(cwd) {
  return git(['rev-parse', '--show-toplevel'], cwd).trim();
}

// `-z` so a path holding a space or a non-ASCII letter arrives as itself (AC-E41). Without it git
// quotes such a path and the quoted form matches nothing the runner reports.
function trackedFiles(root) {
  return git(['ls-files', '-z'], root).split('\0').filter(Boolean);
}

// --- what counts as a test ----------------------------------------------------------------------

const TEST_FILE_RE = /\.test\.ts$/i;
const FAULT_TEST_RE = /\.fault\.test\.ts$/i;

// --- the real lister -----------------------------------------------------------------------------

// `vitest list --filesOnly`, run from the repo root so its own include/exclude decide the answer.
// Plain text output, one repo-relative path per line - never `--json`, which vitest 4.1 writes to
// a report FILE named after its argument in the current working directory rather than to stdout.
function realLister(root) {
  const bin = join(root, 'node_modules', 'vitest', 'vitest.mjs');
  const out = execFileSync(process.execPath, [bin, 'list', '--filesOnly'], {
    cwd: root, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024,
  });
  return out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => l.replace(/\\/g, '/'));
}

// --- the scan ----------------------------------------------------------------------------------

function scan(cwd, opts = {}) {
  const lister = opts.lister || realLister;
  let root;
  try {
    root = repoRoot(cwd);
  } catch {
    return { unknown: true, reason: `not a git repository at ${cwd}`, findings: [] };
  }
  let tracked;
  try {
    tracked = trackedFiles(root);
  } catch (e) {
    return { unknown: true, reason: `git ls-files failed: ${(e.message || '').split('\n')[0]}`, findings: [] };
  }

  let listed;
  try {
    listed = lister(root);
  } catch (e) {
    return { unknown: true, reason: `the test runner could not list its files: ${(e.message || '').split('\n')[0]}`, findings: [] };
  }

  // Zero listed files is the silent failure this gate exists to catch, turned all the way up:
  // never read that as "nothing to check" (AC-E40).
  if (listed.length === 0) {
    return { unknown: true, reason: 'the test runner listed zero files, which is indistinguishable from a filter matching nothing', findings: [] };
  }

  const listedSet = new Set(listed);
  const trackedSet = new Set(tracked);
  const trackedTests = tracked.filter((f) => TEST_FILE_RE.test(f) && !FAULT_TEST_RE.test(f));

  const findings = [];
  for (const f of trackedTests) {
    if (!listedSet.has(f)) {
      findings.push({ file: f, kind: 'unlisted', why: 'tracked as a test file but the test runner never lists it, so it never fails on its own' });
    }
  }

  const advisories = [];
  for (const f of listed) {
    if (!trackedSet.has(f)) {
      advisories.push(`${f} is listed by the test runner but is not tracked (fine if generated or gitignored)`);
    }
  }

  return { ok: findings.length === 0, findings, advisories, tracked: trackedTests.length, listed: listed.length };
}

// --- reporting ---------------------------------------------------------------------------------

function report(res) {
  if (res.unknown) {
    console.error(`[test-discovery] INCOMPLETE: ${res.reason}`);
    console.error('[test-discovery] Refusing to report clean on a scan that did not run.');
    for (const f of res.findings || []) console.error(`  ${f.file}  <- ${f.why}`);
    return (res.findings || []).length ? 1 : 2;
  }
  for (const a of res.advisories || []) console.log(`[test-discovery] note: ${a}`);
  if (res.ok) {
    console.log(`[test-discovery] clean (${res.tracked} tracked test file(s), ${res.listed} listed by the runner)`);
    return 0;
  }
  console.error(`[test-discovery] ${res.findings.length} finding(s):`);
  for (const f of res.findings) console.error(`  ${f.file}  <- ${f.why}`);
  console.error('');
  console.error('TRACKED BUT NEVER RUN: widen the test runner include glob to reach it, or remove it');
  console.error('if it should not exist. A tracked test outside every include glob never fails on its');
  console.error('own, which is worse than deleting it.');
  return 1;
}

// --- selftest ----------------------------------------------------------------------------------
//
// EVERY RULE GETS ITS OWN ISOLATED CONTROL. The real lister is never spawned inside the selftest:
// every case injects its own `lister` function, so proving this gate can fail never depends on
// vitest actually running anywhere.

function fixture(files) {
  const root = mkdtempSync(join(tmpdir(), 'test-discovery-st-'));
  git(['init', '-q'], root);
  const noExcludes = join(root, '.git', 'empty-excludes');
  writeFileSync(noExcludes, '');
  appendFileSync(join(root, '.git', 'config'), `\n[core]\n\texcludesFile = ${noExcludes.replace(/\\/g, '/')}\n\tautocrlf = false\n`);
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body);
  }
  git(['add', '-A'], root);
  const staged = new Set(git(['ls-files', '-z'], root).split('\0').filter(Boolean));
  const gap = Object.keys(files).filter((f) => !staged.has(f.replace(/\\/g, '/')));
  if (gap.length) throw new Error(`fixture failed to stage ${gap.join(', ')} - this case would assert nothing`);
  return root;
}

function muted(fn) {
  const log = console.log;
  const err = console.error;
  console.log = () => {};
  console.error = () => {};
  try {
    return fn();
  } finally {
    console.log = log;
    console.error = err;
  }
}

const BODY = 'export {};\n';

function selftest() {
  const SEP = '  ::  ';
  let failures = 0;
  const emit = (ok, name, detail) => {
    if (!ok) failures++;
    console.log(`  ${ok ? 'ok     ' : 'FAIL   '} ${name}${SEP}${detail}`);
  };

  const cases = [];

  // NEGATIVE control: a repo the runner fully lists must pass, or nothing else here means anything.
  cases.push({
    name: 'a tracked test the runner lists is clean',
    files: { 'widgets/src/example.test.ts': BODY },
    lister: () => ['widgets/src/example.test.ts'],
    expect: 'clean',
  });

  // Rule 1, the shape that matters: a test outside the runner's usual include path.
  cases.push({
    name: 'a tracked test the runner never lists is a finding',
    files: { 'widgets/src/example.test.ts': BODY, 'widgets/src/decoy.test.ts': BODY },
    lister: () => ['widgets/src/decoy.test.ts'],
    expect: 'fail', expectWhy: /widgets\/src\/example\.test\.ts <- tracked as a test file but the test runner never lists it/,
  });
  cases.push({
    name: 'a tracked test outside the usual src layout is caught the same way',
    files: { 'tools/example.test.ts': BODY, 'widgets/src/decoy.test.ts': BODY },
    lister: () => ['widgets/src/decoy.test.ts'],
    expect: 'fail', expectWhy: /tools\/example\.test\.ts <- tracked as a test file/,
  });

  // Rule 2.
  cases.push({
    name: 'a listed file that is not tracked is an advisory only, never a finding',
    files: { 'widgets/src/example.test.ts': BODY },
    lister: () => ['widgets/src/example.test.ts', 'widgets/src/generated.test.ts'],
    expect: 'clean', expectNote: /widgets\/src\/generated\.test\.ts is listed by the test runner but is not tracked/,
  });

  // The exclusion suffix.
  cases.push({
    name: 'a fault-test file is exempt even when the runner never lists it',
    files: { 'widgets/src/example.fault.test.ts': BODY, 'widgets/src/decoy.test.ts': BODY },
    lister: () => ['widgets/src/decoy.test.ts'],
    expect: 'clean',
  });

  // AC-E40: never clean on zero.
  cases.push({
    name: 'an empty listing is UNKNOWN, never clean',
    files: { 'widgets/src/example.test.ts': BODY },
    lister: () => [],
    expect: 'unknown',
  });

  // A lister that cannot run at all.
  cases.push({
    name: 'a lister that cannot run is UNKNOWN, not clean',
    files: { 'widgets/src/example.test.ts': BODY },
    lister: () => { throw new Error('the runner is not installed'); },
    expect: 'unknown',
  });

  // AC-E41: exact comparison on an awkward path. Asserted directly against trackedFiles() rather
  // than through scan(), because a quoted, octal-escaped path (what git prints without -z) no
  // longer ends in ".test.ts" and would simply be filtered out of consideration - a silent hole
  // that a clean/fail verdict on the whole scan cannot tell apart from correct behavior.
  cases.push({
    name: 'a path with a space and a non-ASCII letter compares exactly',
    files: { 'widgets/src/my dir/café.test.ts': BODY },
    directCall: (root) => trackedFiles(root),
    expectDirect: ['widgets/src/my dir/café.test.ts'],
  });

  // A non-repository.
  cases.push({ name: 'a non-repository is UNKNOWN, not clean', noRepo: true, expect: 'unknown' });

  // Exit-code mapping, asserted directly on report() with hand-built verdicts (the real scan never
  // produces UNKNOWN together with findings, so this is the only way to pin the precedence).
  cases.push({ name: 'a clean scan exits 0', exitFor: { ok: true, findings: [], advisories: [], tracked: 1, listed: 1 }, expectExit: 0 });
  cases.push({ name: 'a scan with findings exits 1', exitFor: { ok: false, findings: [{ file: 'x.test.ts', kind: 'unlisted', why: 'x' }], advisories: [] }, expectExit: 1 });
  cases.push({ name: 'an INCOMPLETE scan with no findings exits 2', exitFor: { unknown: true, reason: 'x', findings: [] }, expectExit: 2 });
  cases.push({ name: 'an INCOMPLETE scan WITH findings exits 1, not 2', exitFor: { unknown: true, reason: 'x', findings: [{ file: 'x.test.ts', kind: 'unlisted', why: 'x' }] }, expectExit: 1 });

  const roots = [];
  function runCase(c) {
    if (c.exitFor) {
      const code = muted(() => report(c.exitFor));
      emit(code === c.expectExit, c.name, `expected exit ${c.expectExit}, got ${code}`);
      return;
    }
    if (c.directCall) {
      const root = fixture(c.files);
      roots.push(root);
      const got = c.directCall(root);
      const ok = JSON.stringify(got) === JSON.stringify(c.expectDirect);
      emit(ok, c.name, `expected ${JSON.stringify(c.expectDirect)}, got ${JSON.stringify(got)}`);
      return;
    }
    let root;
    let res;
    if (c.noRepo) {
      root = mkdtempSync(join(tmpdir(), 'test-discovery-norepo-'));
      roots.push(root);
      res = scan(root, { lister: () => ['unreachable.test.ts'] });
    } else {
      root = fixture(c.files);
      roots.push(root);
      res = scan(root, { lister: c.lister });
    }
    const got = res.unknown ? 'unknown' : (res.ok ? 'clean' : 'fail');
    const whys = (res.findings || []).map((f) => `${f.file} <- ${f.why}`).join(' | ');
    const notes = (res.advisories || []).join(' | ');
    let ok = got === c.expect;
    let detail = `expected ${c.expect}, got ${got}${res.unknown ? ` (${res.reason})` : ''}`;
    if (ok && c.expectWhy && !c.expectWhy.test(whys)) { ok = false; detail = `expected a finding matching ${c.expectWhy}, got: ${whys || '(none)'}`; }
    if (ok && c.expectNote && !c.expectNote.test(notes)) { ok = false; detail = `expected a note matching ${c.expectNote}, got: ${notes || '(none)'}`; }
    emit(ok, c.name, detail);
  }

  try {
    for (const c of cases) {
      try {
        runCase(c);
      } catch (e) {
        emit(false, c.name, `fixture or run threw: ${(e && e.message) || e}`);
      }
    }
  } finally {
    for (const r of roots) {
      try { rmSync(r, { recursive: true, force: true }); } catch { /* temp cleanup */ }
    }
  }
  console.log(`[test-discovery] selftest: ${cases.length - failures}/${cases.length} controls passed`);
  return failures === 0 ? 0 : 1;
}

// --- entry point -------------------------------------------------------------------------------

function main(argv) {
  const args = argv.slice(2);
  if (args.includes('--selftest')) return selftest();
  return report(scan(process.cwd()));
}

// No filename guard around this, on purpose: a mutants harness that copies this file to a
// differently-named mutant and runs it must still exercise every control, not exit early.
process.exit(main(process.argv));
