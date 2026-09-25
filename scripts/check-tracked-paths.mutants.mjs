#!/usr/bin/env node
// check-tracked-paths.mutants.mjs - prove the gate's --selftest controls are NON-VACUOUS.
//
// Each mutation disables exactly ONE rule of check-tracked-paths.mjs; the gate's own --selftest
// must then go RED, and specifically the control the mutation NAMES must go red. A mutation that
// leaves --selftest green is an ESCAPE: the control named after that rule asserts nothing. The
// reverse direction is checked too: a control no mutation can redden is never examined at all and
// is reported as a gap.
//
// The runner is deliberately the same shape as check-test-discovery.mutants.mjs and
// check-env-example.mutants.mjs. These files are copied into product repos ONE AT A TIME, so a
// shared helper module would be a third file and a coupling that breaks whenever only two of the
// three are copied. The duplication is the cost of each gate being independently portable, and it
// is the existing convention.
//
// Usage:  node scripts/check-tracked-paths.mutants.mjs [--only <substring>] [--jobs <n>]
// Exit codes: 0 all mutations caught, 1 an escape or an unproven control, 2 the baseline is not green.

import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir, cpus } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);

const here = dirname(fileURLToPath(import.meta.url));
const SRC = join(here, 'check-tracked-paths.mjs');
// Line endings normalised, because a checkout with core.autocrlf=true (the Windows default) hands
// the source back as CRLF, and none of the anchors below would match a source that carries `\r\n`
// where they expect a bare `\n`.
const src = readFileSync(SRC, 'utf8').replace(/\r\n/g, '\n');

// `find` must be a UNIQUE substring of the gate source; `repl` disables that one rule. `expect`
// NAMES the control this mutation must turn red. A mutation can also redden OTHER controls as a
// side effect; reverse coverage credits every control that goes red in a run, not only the one
// named here.
const MUTATIONS = [
  // --- the exact-entry rule, both directions ---
  { name: 'the exact-entry rule fires at all', expect: 'a clean tree matching the allowlist passes', find: 'if (allow.exact.has(f)) continue;', repl: 'if (false) continue;' },
  { name: 'the exact-entry rule does not swallow every path', expect: 'a path next to the allowlist is a finding', find: 'if (allow.exact.has(f)) continue;', repl: 'if (true) continue;' },

  // --- the prefix rule ---
  { name: 'the prefix rule fires at all', expect: 'a clean tree matching the allowlist passes', find: 'if (allow.prefixes.some((p) => f.startsWith(p))) continue;', repl: 'if (false) continue;' },
  // Dropping the prefix's own trailing slash before the comparison is the exact boundary bug this
  // control exists for: "docs/adr" (no slash) is a prefix of "docs/adrx/y.md" where "docs/adr/" is
  // not.
  { name: 'a prefix keeps its own trailing slash in the comparison', expect: 'a prefix matches only whole path segments (docs/adr/ does not match docs/adrx/)', find: 'f.startsWith(p)', repl: 'f.startsWith(p.slice(0, -1))' },

  // --- a prefix that breaks the whole-segment rule is refused, never matched ---
  { name: 'a prefix without its trailing slash is refused', expect: 'a prefix without its trailing slash is UNKNOWN, not clean', find: "const badPrefix = parsed.prefixes.findIndex((p) => typeof p !== 'string' || !p.endsWith('/'));", repl: 'const badPrefix = -1;' },

  // --- a broken allowlist is UNKNOWN, never silently treated as empty-but-valid ---
  { name: 'a missing allowlist file is reported, not swallowed', expect: 'a missing allowlist is UNKNOWN, not clean', find: "return { error: `tracked-paths.json is missing or unreadable: ${(e.message || '').split('\\n')[0]}` };", repl: 'return { exact: new Set(), prefixes: [] };' },
  { name: 'unparsable JSON is reported, not swallowed', expect: 'an unparsable allowlist is UNKNOWN, not clean', find: "return { error: `tracked-paths.json is not valid JSON: ${(e.message || '').split('\\n')[0]}` };", repl: 'return { exact: new Set(), prefixes: [] };' },

  // --- an empty tracked-file list is UNKNOWN, never clean ---
  { name: 'the empty-index rule fires', expect: 'zero tracked files is UNKNOWN, not clean', find: 'if (tracked.length === 0) {', repl: 'if (false) {' },

  // --- a non-repository is UNKNOWN, never clean ---
  { name: 'a non-repository is reported as UNKNOWN', expect: 'a non-repository is UNKNOWN, not clean', find: 'return { unknown: true, reason: `not a git repository at ${cwd}`, findings: [] };', repl: 'return { unknown: false, ok: true, findings: [], tracked: 0 };' },

  // --- AC-E41: git ls-files -z, so a space or a non-ASCII letter compares exactly ---
  { name: 'the tracked-file listing reads git ls-files WITH -z, not a newline split', expect: 'an exact entry with a space and a non-ASCII letter matches exactly', find: "return git(['ls-files', '-z'], root).split('\\0').filter(Boolean);", repl: "return git(['ls-files'], root).split('\\n').filter(Boolean);" },

  // --- exit codes ---
  { name: 'findings outrank incompleteness in the exit code', expect: 'an INCOMPLETE scan WITH findings exits 1, not 2', find: '    return (res.findings || []).length ? 1 : 2;', repl: '    return 2;' },
  { name: 'an INCOMPLETE scan does not exit 0', expect: 'an INCOMPLETE scan with no findings exits 2', find: '    return (res.findings || []).length ? 1 : 2;', repl: '    return (res.findings || []).length ? 1 : 0;' },
  { name: 'a clean scan exits 0', expect: 'a clean scan exits 0', find: 'inside the allowlist)`);\n    return 0;', repl: 'inside the allowlist)`);\n    return 2;' },
  { name: 'a scan with findings exits 1', expect: 'a scan with findings exits 1', find: '  return 1;\n}\n\n// --- selftest', repl: '  return 0;\n}\n\n// --- selftest' },
];

function parseError(file) {
  try { execFileSync(process.execPath, ['--check', file], { windowsHide: true, stdio: 'pipe' }); return null; }
  catch (e) {
    const line = String((e && e.stderr) || '').split('\n').find((l) => /Error/.test(l));
    return (line || 'parse failed').trim();
  }
}

// Returns the exit code AND the output, plus whether the run produced a verdict at all. A KILLED
// run never answered: treating that as non-zero would score "we never found out" as "caught".
async function selftestRun(file) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [file, '--selftest'], {
      encoding: 'utf8', windowsHide: true, timeout: 1800000, maxBuffer: 32 * 1024 * 1024,
    });
    return { code: 0, out: stdout + stderr, noVerdict: null };
  } catch (e) {
    const noVerdict = (e.killed || e.signal) ? (e.signal ? `killed by ${e.signal}` : 'timed out') : null;
    return {
      code: typeof e.code === 'number' ? e.code : -1,
      out: (e.stdout || '') + (e.stderr || ''),
      noVerdict,
    };
  }
}

// Bounded concurrency. Results are collected BY INDEX and printed in list order afterwards, so the
// report stays deterministic however the runs interleave.
async function pool(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

// A control line is `  ok  <name>  ::  <measured>`. The name is everything before the FIRST
// `  ::  ` and nothing else is interpreted (findings quote paths that can hold parentheses, so no
// parenthetical stripping happens here).
const CONTROL_SEP = '  ::  ';
const CONTROL_LINE = /^ {2}(ok|FAIL|skip)\s+(.*)$/;
function controlsIn(out) {
  const map = new Map();
  for (const line of out.split('\n')) {
    const m = CONTROL_LINE.exec(line.replace(/\s+$/, ''));
    if (!m) continue;
    const idx = m[2].indexOf(CONTROL_SEP);
    map.set((idx === -1 ? m[2] : m[2].slice(0, idx)).trim(), m[1]);
  }
  return map;
}

async function main() {
  const argv = process.argv.slice(2);
  const onlyAt = argv.indexOf('--only');
  const only = onlyAt !== -1 ? argv[onlyAt + 1] : null;
  const jobsAt = argv.indexOf('--jobs');
  const jobs = jobsAt !== -1 ? Number(argv[jobsAt + 1]) : Math.max(2, Math.min(6, cpus().length - 2));
  if (jobsAt !== -1 && !(Number.isInteger(jobs) && jobs > 0)) {
    console.error('[mutants] --jobs needs a positive whole number.');
    return 2;
  }
  if (onlyAt !== -1 && !only) {
    console.error('[mutants] --only needs a substring to match mutation names against.');
    return 2;
  }

  const base = await selftestRun(SRC);
  if (base.code !== 0) {
    console.error(`[mutants] baseline gate selftest is NOT green (exit ${base.code}); fix the gate first.`);
    console.error(base.out.split('\n').filter((l) => /FAIL/.test(l)).join('\n'));
    return 2;
  }
  const baseControls = controlsIn(base.out);
  const skipped = [...baseControls].filter(([, v]) => v === 'skip').map(([k]) => k);

  const seenNames = new Map();
  for (const line of base.out.split('\n')) {
    const m = CONTROL_LINE.exec(line.replace(/\s+$/, ''));
    if (!m) continue;
    const idx = m[2].indexOf(CONTROL_SEP);
    const name = (idx === -1 ? m[2] : m[2].slice(0, idx)).trim();
    seenNames.set(name, (seenNames.get(name) || 0) + 1);
  }
  const dupes = [...seenNames].filter(([, n]) => n > 1).map(([k]) => k);
  if (dupes.length) {
    console.error('[mutants] DUPLICATE control name(s); every control must be uniquely named:');
    for (const d of dupes) console.error(`  - ${d}`);
    return 2;
  }
  const unnamed = MUTATIONS.filter((m) => !m.expect);
  if (unnamed.length) {
    console.error(`[mutants] ${unnamed.length} mutation(s) have no 'expect' control named:`);
    for (const m of unnamed) console.error(`  - ${m.name}`);
    return 2;
  }
  const unknownExpect = MUTATIONS.filter((m) => !baseControls.has(m.expect));
  if (unknownExpect.length) {
    console.error('[mutants] mutation(s) name an expect control that no selftest control matches:');
    for (const m of unknownExpect) console.error(`  - ${m.name}  ->  ${m.expect}`);
    return 2;
  }

  const selected = only ? MUTATIONS.filter((m) => m.name.includes(only) || m.expect.includes(only)) : MUTATIONS;
  if (!selected.length) {
    console.error(`[mutants] --only ${only} matched no mutation.`);
    return 2;
  }

  const dir = mkdtempSync(join(tmpdir(), 'tracked-paths-mut-'));
  const escapes = [];
  const hostLimited = [];
  const malformed = [];
  const unjudged = [];
  const reddened = new Set();
  console.log(`[mutants] ${selected.length} mutation(s), ${jobs} at a time, ${baseControls.size} controls per run.`);
  try {
    const outcomes = await pool(selected, jobs, async (m, i) => {
      const hits = src.split(m.find).length - 1;
      if (hits !== 1) {
        return { m, kind: 'stale', line: `  FAIL     ${m.name}: mutation target found ${hits} time(s), need exactly 1 (harness is stale)` };
      }
      const f = join(dir, `mutant-${i}.mjs`);
      writeFileSync(f, src.replace(m.find, m.repl));
      const bad = parseError(f);
      if (bad) {
        return { m, kind: 'malformed', line: `  UNPARSEABLE  ${m.name}: the mutated source is not valid JS (${bad}) - rewrite the mutation, the rule is not implicated` };
      }
      const { code, out, noVerdict } = await selftestRun(f);
      if (noVerdict) {
        return { m, kind: 'unjudged', line: `  NO VERDICT   ${m.name}: the run never finished (${noVerdict}), so it proves nothing either way` };
      }
      const controls = controlsIn(out);
      const reds = [...controls].filter(([, v]) => v === 'FAIL').map(([k]) => k);
      const ran = controls.size;
      const crashed = ran < baseControls.size;
      const named = reds.includes(m.expect);
      const caught = code !== 0 && !crashed && named;
      const why = crashed ? `CRASHED, only ${ran}/${baseControls.size} controls ran`
        : reds.length === 0 ? `exit ${code} but NO control went red`
          : named ? `exit ${code}, red: ${m.expect}${reds.length > 1 ? ` +${reds.length - 1} more` : ''}`
            : `exit ${code} but its OWN control stayed GREEN; red instead: ${reds.join(' | ')}`;
      return { m, kind: caught ? 'caught' : 'escaped', reds, line: `  ${caught ? 'ok     ' : 'ESCAPED'}  ${m.name}  (${why})` };
    });
    for (const o of outcomes) {
      if (o.kind === 'caught') console.log(o.line); else console.error(o.line);
      if (o.kind === 'stale') escapes.push(o.m.name);
      if (o.kind === 'malformed') malformed.push(o.m.name);
      if (o.kind === 'unjudged') unjudged.push(o.m.name);
      if (o.kind === 'escaped') (skipped.includes(o.m.expect) ? hostLimited : escapes).push(o.m.name);
      for (const r of o.reds || []) reddened.add(r);
    }
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* temp cleanup */ }
  }

  const gaps = only ? [] : [...baseControls]
    .filter(([name, verdict]) => verdict !== 'skip' && !reddened.has(name))
    .map(([name]) => name);
  if (only) {
    console.error(`[mutants] --only ${only}: reverse-coverage NOT checked. Run the full sweep for that.`);
  }
  if (gaps.length) {
    console.error(`[mutants] ${gaps.length} control(s) NOT PROVEN - no mutation makes them fail:`);
    for (const name of gaps) console.error(`  - ${name}`);
  }
  if (skipped.length) {
    console.error(`[mutants] ${skipped.length} control(s) SKIPPED on this host, so unproven HERE (not a defect):`);
    for (const name of skipped) console.error(`  - ${name}`);
  }
  if (hostLimited.length) {
    console.error(`[mutants] ${hostLimited.length} mutation(s) unjudged here: the control they name skipped:`);
    for (const name of hostLimited) console.error(`  - ${name}`);
  }

  if (malformed.length || unjudged.length) {
    console.error(`[mutants] ${malformed.length} malformed and ${unjudged.length} unjudged mutation(s):`);
    for (const n of malformed) console.error(`  - ${n} (mutation does not parse)`);
    for (const n of unjudged) console.error(`  - ${n} (run never finished)`);
    console.error('[mutants] These asked no question, so the coverage claim below would be a lie.');
    return 1;
  }
  if (escapes.length) {
    console.error(`[mutants] ${escapes.length} mutation(s) ESCAPED - the named control(s) assert nothing.`);
    return 1;
  }
  if (gaps.length) return 1;
  if (skipped.length || hostLimited.length) {
    console.error('[mutants] UNKNOWN: everything this host could judge passed, but the controls above');
    console.error('[mutants] could not run here. Exit 2, not 0 - an unrun control is never a proven one.');
    return 2;
  }
  console.log(`[mutants] all ${selected.length} mutation(s) caught, each reddening the control it NAMES.`);
  if (!only) {
    console.log(`[mutants] all ${baseControls.size} controls proven: every one is reddened by at least one mutation.`);
  }
  return 0;
}

main().then((code) => process.exit(code), (e) => { console.error(e && e.stack || e); process.exit(2); });
