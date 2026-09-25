#!/usr/bin/env node
// check-tracked-paths.mjs - every tracked file must sit inside the product's own declared paths,
// or a stray file goes public with the rest of the repo the day it ships.
//
// WHY THIS EXISTS. This repo goes public at submission with no second pass to catch what should
// never have been tracked (BUILD-SPEC decision 8). An allowlist that only gets read by a human
// before that day is exactly the kind of check nobody runs under deadline pressure; a gate that
// runs on every commit does not have that failure mode.
//
// ONE RULE. Every path from `git ls-files` must equal an EXACT entry in tracked-paths.json, or sit
// under one of its PREFIX entries. The loader refuses any prefix that does not end in `/`, so a
// prefix matches only whole path segments by construction: "docs/adr/" cannot match
// "docs/adrx/y.md", because the character right after the shared "docs/adr" differs ('/' against
// 'x'). A tracked path matching neither is a finding.
//
// A MISSING OR BROKEN ALLOWLIST IS NEVER CLEAN. So is an empty tracked-file list or a git failure:
// each is UNKNOWN (exit 2), because a check that cannot read its own rules has proven nothing.
//
// Usage:
//   node scripts/check-tracked-paths.mjs             check the repo
//   node scripts/check-tracked-paths.mjs --selftest   prove the gate still fires
//
// Exit codes: 0 clean, 1 findings, 2 the scan could not run (UNKNOWN). Findings outrank UNKNOWN.

import { execFileSync } from 'node:child_process';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
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
// quotes such a path and the quoted form matches nothing the allowlist declares.
function trackedFiles(root) {
  return git(['ls-files', '-z'], root).split('\0').filter(Boolean);
}

// --- the allowlist -------------------------------------------------------------------------------

function loadAllowlist(root) {
  let raw;
  try {
    raw = readFileSync(join(root, 'tracked-paths.json'), 'utf8');
  } catch (e) {
    return { error: `tracked-paths.json is missing or unreadable: ${(e.message || '').split('\n')[0]}` };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { error: `tracked-paths.json is not valid JSON: ${(e.message || '').split('\n')[0]}` };
  }
  if (!parsed || !Array.isArray(parsed.exact) || !Array.isArray(parsed.prefixes)) {
    return { error: 'tracked-paths.json must hold an "exact" array and a "prefixes" array' };
  }
  // The whole-segment rule holds only while every prefix ends in "/": an empty prefix matches
  // every path and "widgets" matches "widgets-old/", so either would pass files silently.
  const badPrefix = parsed.prefixes.findIndex((p) => typeof p !== 'string' || !p.endsWith('/'));
  if (badPrefix !== -1) {
    return { error: `tracked-paths.json prefix ${JSON.stringify(parsed.prefixes[badPrefix])} must be a folder path ending in "/"` };
  }
  return { exact: new Set(parsed.exact), prefixes: parsed.prefixes };
}

// --- the scan ----------------------------------------------------------------------------------

function scan(cwd, opts = {}) {
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
  if (tracked.length === 0) {
    return { unknown: true, reason: 'git ls-files returned no tracked files (empty index)', findings: [] };
  }

  const allow = opts.allowlist || loadAllowlist(root);
  if (allow.error) {
    return { unknown: true, reason: allow.error, findings: [] };
  }

  const findings = [];
  for (const f of tracked) {
    if (allow.exact.has(f)) continue;
    if (allow.prefixes.some((p) => f.startsWith(p))) continue;
    findings.push({ file: f, why: 'not on the tracked-path allowlist (no exact entry, no covering prefix)' });
  }

  return { ok: findings.length === 0, findings, tracked: tracked.length };
}

// --- reporting ---------------------------------------------------------------------------------

function report(res) {
  if (res.unknown) {
    console.error(`[tracked-paths] INCOMPLETE: ${res.reason}`);
    console.error('[tracked-paths] Refusing to report clean on a scan that did not run.');
    for (const f of res.findings || []) console.error(`  ${f.file}  <- ${f.why}`);
    return (res.findings || []).length ? 1 : 2;
  }
  if (res.ok) {
    console.log(`[tracked-paths] clean (${res.tracked} tracked file(s) inside the allowlist)`);
    return 0;
  }
  console.error(`[tracked-paths] ${res.findings.length} finding(s):`);
  for (const f of res.findings) console.error(`  ${f.file}  <- ${f.why}`);
  console.error('');
  console.error('OUTSIDE THE ALLOWLIST: add the exact path or a covering prefix to tracked-paths.json');
  console.error('if it belongs in the repo, or untrack it if it does not.');
  return 1;
}

// --- selftest ----------------------------------------------------------------------------------
//
// EVERY RULE GETS ITS OWN ISOLATED CONTROL, built on an isolated git fixture under os.tmpdir().

function fixture(files, untracked = {}) {
  const root = mkdtempSync(join(tmpdir(), 'tracked-paths-st-'));
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
  // Written to disk but never staged: distinguishes "zero tracked files" from "no tracked-paths.json
  // to read", since loadAllowlist() reads the disk directly while trackedFiles() reads the index.
  for (const [rel, body] of Object.entries(untracked)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body);
  }
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

const BODY = 'text\n';
// tracked-paths.json names itself, exactly like the real repo's allowlist does: the fixture
// tracks the file it is written into, and it must cover itself or every case here would report a
// spurious finding for its own presence.
const BASE_ALLOW_JSON = JSON.stringify({ exact: ['README.md', 'package.json', 'tracked-paths.json'], prefixes: ['widgets/', 'docs/adr/'] });

function selftest() {
  const SEP = '  ::  ';
  let failures = 0;
  const emit = (ok, name, detail) => {
    if (!ok) failures++;
    console.log(`  ${ok ? 'ok     ' : 'FAIL   '} ${name}${SEP}${detail}`);
  };

  const cases = [];

  // Every case below writes a REAL tracked-paths.json into its fixture and lets scan() call the
  // real loadAllowlist() (no injected allowlist object), so a bug in reading or parsing that file
  // is exercised the same way it would be on the real repo.

  // NEGATIVE control: a tree that matches the allowlist exactly must pass.
  cases.push({
    name: 'a clean tree matching the allowlist passes',
    files: { 'tracked-paths.json': BASE_ALLOW_JSON, 'README.md': BODY, 'widgets/src/index.ts': BODY, 'docs/adr/0001.md': BODY },
    expect: 'clean',
  });

  // AC-E39: a neutral path next to the allowlist.
  cases.push({
    name: 'a path next to the allowlist is a finding',
    files: { 'tracked-paths.json': BASE_ALLOW_JSON, 'README.md': BODY, '.cache-old/x.md': BODY },
    expect: 'fail', expectWhy: /\.cache-old\/x\.md <- not on the tracked-path allowlist/,
  });
  cases.push({
    name: 'a new top-level folder not on the allowlist is a finding',
    files: { 'tracked-paths.json': BASE_ALLOW_JSON, 'README.md': BODY, 'newdir/file.txt': BODY },
    expect: 'fail', expectWhy: /newdir\/file\.txt <- not on the tracked-path allowlist/,
  });

  // The prefix segment boundary.
  cases.push({
    name: 'a prefix matches only whole path segments (docs/adr/ does not match docs/adrx/)',
    files: { 'tracked-paths.json': BASE_ALLOW_JSON, 'README.md': BODY, 'docs/adrx/y.md': BODY },
    expect: 'fail', expectWhy: /docs\/adrx\/y\.md <- not on the tracked-path allowlist/,
  });

  // A prefix that breaks the whole-segment rule: an empty prefix matches every path, and one
  // without its slash matches a sibling folder, so either would pass files silently.
  cases.push({
    name: 'an empty prefix is UNKNOWN, not clean',
    files: { 'tracked-paths.json': JSON.stringify({ exact: ['tracked-paths.json'], prefixes: [''] }), 'newdir/file.txt': BODY },
    expect: 'unknown',
  });
  cases.push({
    name: 'a prefix without its trailing slash is UNKNOWN, not clean',
    files: { 'tracked-paths.json': JSON.stringify({ exact: ['tracked-paths.json'], prefixes: ['widgets'] }), 'widgets-old/x.md': BODY },
    expect: 'unknown',
  });

  // A missing or unparsable allowlist, both read from a REAL fixture so the disk-reading and
  // JSON-parsing paths themselves are what gets exercised.
  cases.push({
    name: 'a missing allowlist is UNKNOWN, not clean',
    files: { 'README.md': BODY },
    expect: 'unknown',
  });
  cases.push({
    name: 'an unparsable allowlist is UNKNOWN, not clean',
    files: { 'tracked-paths.json': '{ not json', 'README.md': BODY },
    expect: 'unknown',
  });

  // AC-E41: an exact entry with a space and a non-ASCII letter matches exactly.
  cases.push({
    name: 'an exact entry with a space and a non-ASCII letter matches exactly',
    files: { 'tracked-paths.json': JSON.stringify({ exact: ['my café notes.md', 'tracked-paths.json'], prefixes: [] }), 'my café notes.md': BODY },
    expect: 'clean',
  });

  // A non-repository, and an empty index.
  cases.push({ name: 'a non-repository is UNKNOWN, not clean', noRepo: true, expect: 'unknown' });
  cases.push({
    // tracked-paths.json sits on DISK but is never staged, so loadAllowlist() (reads disk) would
    // succeed while trackedFiles() (reads the index) reports zero - the one case where skipping the
    // explicit empty-index check would reach "clean" instead of "UNKNOWN".
    name: 'zero tracked files is UNKNOWN, not clean',
    files: {},
    untrackedFiles: { 'tracked-paths.json': BASE_ALLOW_JSON },
    expect: 'unknown',
  });

  // Exit-code mapping, asserted directly on report() with hand-built verdicts.
  cases.push({ name: 'a clean scan exits 0', exitFor: { ok: true, findings: [], tracked: 1 }, expectExit: 0 });
  cases.push({ name: 'a scan with findings exits 1', exitFor: { ok: false, findings: [{ file: 'x.md', why: 'x' }] }, expectExit: 1 });
  cases.push({ name: 'an INCOMPLETE scan with no findings exits 2', exitFor: { unknown: true, reason: 'x', findings: [] }, expectExit: 2 });
  cases.push({ name: 'an INCOMPLETE scan WITH findings exits 1, not 2', exitFor: { unknown: true, reason: 'x', findings: [{ file: 'x.md', why: 'x' }] }, expectExit: 1 });

  const roots = [];
  function runCase(c) {
    if (c.exitFor) {
      const code = muted(() => report(c.exitFor));
      emit(code === c.expectExit, c.name, `expected exit ${c.expectExit}, got ${code}`);
      return;
    }
    let root;
    let res;
    if (c.noRepo) {
      root = mkdtempSync(join(tmpdir(), 'tracked-paths-norepo-'));
      roots.push(root);
      res = scan(root);
    } else {
      root = fixture(c.files, c.untrackedFiles || {});
      roots.push(root);
      res = scan(root);
    }
    const got = res.unknown ? 'unknown' : (res.ok ? 'clean' : 'fail');
    const whys = (res.findings || []).map((f) => `${f.file} <- ${f.why}`).join(' | ');
    let ok = got === c.expect;
    let detail = `expected ${c.expect}, got ${got}${res.unknown ? ` (${res.reason})` : ''}`;
    if (ok && c.expectWhy && !c.expectWhy.test(whys)) { ok = false; detail = `expected a finding matching ${c.expectWhy}, got: ${whys || '(none)'}`; }
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
  console.log(`[tracked-paths] selftest: ${cases.length - failures}/${cases.length} controls passed`);
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
