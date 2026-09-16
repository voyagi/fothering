#!/usr/bin/env node
// check-dead.mjs - the dead-code gate: knip, wrapped so its verdict is explicit.
//
// WHY A WRAPPER AND NOT A BARE npm SCRIPT. Three reasons, each a measured failure class across
// real repos:
//   1. `knip || true` (or a swallowed exit code) turns every result into "clean". Forbidden.
//   2. A missing tool exits looking exactly like a clean run in `if command -v` shapes. Here a
//      missing knip prints one loud SKIPPED line instead, so "the checker is gone" never reads
//      as "the checker found nothing".
//   3. knip's own exit code alone cannot be trusted as the verdict: this wrapper PARSES the JSON
//      report and asserts it parsed before believing anything. An empty or unparsable report is
//      exit 2 (could not run), never clean - a zero result maps to UNKNOWN.
//
// It writes the raw report to .knip-report.json (add that name to .git/info/exclude; it is a
// run artifact, not a config). NOT `.knip.json`: knip's own config candidate list includes
// `.knip.json` (verified at knip.dev/overview/configuration 2026-08-29), so a report written
// there becomes the CONFIG of every later run on a product without its own knip.json - the
// first run would poison the second. `knip.json` - the real CONFIG - is per product; see the
// README section.
//
// Verdicts: CLEAN (exit 0), FINDINGS (exit 1, counts + first entries printed),
//           SKIPPED (exit 0, loud: package.json absent, or knip neither declared nor installed),
//           UNKNOWN (exit 2: knip declared but not installed, or no parsable report).
//
// Usage: node scripts/check-dead.mjs [--selftest]
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Resolved from the CWD the gate runs in, which is the product root when invoked as an npm
// script. Direct bin invocation, never npx: npx eats exit codes on Windows (README gotcha).
function resolveKnip(cwd) {
  const pkgPath = join(cwd, 'node_modules', 'knip', 'package.json');
  if (!existsSync(pkgPath)) return null;
  let bin;
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin && pkg.bin.knip;
  } catch {
    return null;
  }
  if (!bin) return null;
  const abs = join(cwd, 'node_modules', 'knip', bin);
  return existsSync(abs) ? abs : null;
}

function declaresKnip(cwd) {
  try {
    const pkg = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8'));
    return Boolean((pkg.devDependencies && pkg.devDependencies.knip) || (pkg.dependencies && pkg.dependencies.knip));
  } catch {
    return false;
  }
}

function run(cwd) {
  if (!existsSync(join(cwd, 'package.json'))) {
    console.log('[dead-code] SKIPPED: no package.json here, so there is no dependency graph for knip to read. Not applicable, not clean.');
    return 0;
  }
  const knipBin = resolveKnip(cwd);
  if (!knipBin) {
    // A product that declares knip has opted into the scan, so a missing install is a broken
    // environment, not an opt-out, and must not let the ship gate pass unscanned.
    if (declaresKnip(cwd)) {
      console.error('[dead-code] UNKNOWN: package.json declares knip but it is not installed (run npm ci). The dead-code surface was NOT checked.');
      return 2;
    }
    console.log('[dead-code] SKIPPED: knip is not installed (npm i -D knip). The dead-code surface was NOT checked.');
    return 0;
  }
  let out = '';
  let exitCode = 0;
  try {
    out = execFileSync(process.execPath, [knipBin, '--reporter', 'json'], {
      cwd, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    // knip exits non-zero when it has findings; that is a REPORT, not a failure to run. Only an
    // empty stdout means it never produced one.
    out = String((e && e.stdout) || '');
    exitCode = e.status == null ? -1 : e.status;
  }
  if (!out.trim()) {
    console.error(`[dead-code] UNKNOWN: knip produced no report (exit ${exitCode}). A scan that did not run is not a clean scan.`);
    return 2;
  }
  let report;
  try {
    report = JSON.parse(out);
  } catch {
    console.error('[dead-code] UNKNOWN: knip output did not parse as JSON. Refusing to invent a verdict from it.');
    return 2;
  }
  try {
    writeFileSync(join(cwd, '.knip-report.json'), out);
  } catch {
    // The written copy is a convenience; the verdict below comes from the parsed report.
  }
  // knip's json reporter emits { files: [...], issues: [{ file, owners?, exports: [...], ... }] }.
  // Count every issue entry across every category so a category rename cannot zero the count
  // silently: anything array-valued inside an issue row is counted, plus unused files.
  const files = Array.isArray(report.files) ? report.files.length : 0;
  let issueCount = 0;
  const samples = [];
  for (const row of Array.isArray(report.issues) ? report.issues : []) {
    for (const [key, val] of Object.entries(row)) {
      if (!Array.isArray(val)) continue;
      issueCount += val.length;
      for (const v of val.slice(0, 2)) {
        if (samples.length < 8) samples.push(`${row.file || '?'}: ${key}: ${typeof v === 'string' ? v : (v && (v.name || v.id)) || JSON.stringify(v)}`);
      }
    }
  }
  if (files === 0 && issueCount === 0) {
    console.log('[dead-code] CLEAN: knip found no unused files, exports, or dependencies (report parsed, .knip-report.json written).');
    return 0;
  }
  console.error(`[dead-code] FINDINGS: ${files} unused file(s), ${issueCount} unused export/dependency entr${issueCount === 1 ? 'y' : 'ies'}. Full report: .knip-report.json`);
  for (const f of (report.files || []).slice(0, 5)) console.error(`  unused file: ${f}`);
  for (const s of samples) console.error(`  ${s}`);
  console.error('[dead-code] Report first, then fix: delete only what is GENUINELY dead. Barrel files and');
  console.error('[dead-code] bench/fixture entry points are the known false-positive shapes - add them to');
  console.error('[dead-code] knip.json (entry/ignore) instead of deleting them. Never wrap this in || true.');
  return 1;
}

// --- selftest ---------------------------------------------------------------
// Hermetic: plants a STUB knip package so no install and no network is needed. What it proves:
// each verdict path (CLEAN / FINDINGS / SKIPPED both ways / UNKNOWN both ways) is reachable and
// mapped to the right exit code - the wrapper's whole job.
function selftest() {
  const self = fileURLToPath(import.meta.url);
  let failures = 0;
  const roots = [];
  const caseDir = (name, { pkg = true, stub = null, pkgBody = '{"name":"fx","private":true}\n' } = {}) => {
    const root = mkdtempSync(join(tmpdir(), 'check-dead-st-'));
    roots.push(root);
    if (pkg) writeFileSync(join(root, 'package.json'), pkgBody);
    if (stub !== null) {
      const dir = join(root, 'node_modules', 'knip', 'bin');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(root, 'node_modules', 'knip', 'package.json'), '{"name":"knip","bin":{"knip":"bin/knip.js"}}\n');
      writeFileSync(join(dir, 'knip.js'), stub);
    }
    return root;
  };
  const runCli = (cwd) => {
    try {
      const out = execFileSync(process.execPath, [self], { cwd, encoding: 'utf8', windowsHide: true, stdio: 'pipe' });
      return { code: 0, out };
    } catch (e) {
      return { code: e.status == null ? -1 : e.status, out: String((e && e.stdout) || '') + String((e && e.stderr) || '') };
    }
  };
  const check = (name, got, wantCode, wantRe) => {
    if (got.code !== wantCode || !wantRe.test(got.out)) {
      failures++;
      console.error(`SELFTEST FAIL: ${name} -> exit ${got.code}, wanted ${wantCode}; output ${wantRe.test(got.out) ? 'matched' : 'did not match ' + wantRe}`);
    } else console.log(`selftest ok: ${name}`);
  };
  try {
    check('a clean report exits 0 as CLEAN, report at .knip-report.json (never .knip.json, a knip CONFIG name)',
      runCli(caseDir('clean', { stub: 'console.log(JSON.stringify({files:[],issues:[]}));' })), 0, /CLEAN:.*\.knip-report\.json written/);
    check('findings exit 1 with counts',
      runCli(caseDir('findings', { stub: 'console.log(JSON.stringify({files:["src/dead.ts"],issues:[{file:"src/a.ts",exports:[{name:"unusedFn"}]}]}));process.exit(1);' })), 1, /FINDINGS: 1 unused file/);
    check('no knip installed is a loud SKIPPED, exit 0',
      runCli(caseDir('noknip')), 0, /SKIPPED: knip is not installed/);
    check('knip declared in devDependencies but not installed is UNKNOWN, exit 2',
      runCli(caseDir('declared', { pkgBody: '{"name":"fx","private":true,"devDependencies":{"knip":"6.35.1"}}\n' })), 2, /UNKNOWN: package\.json declares knip but it is not installed/);
    check('no package.json is a loud SKIPPED, exit 0',
      runCli(caseDir('nopkg', { pkg: false })), 0, /SKIPPED: no package\.json/);
    check('an empty report is UNKNOWN, exit 2',
      runCli(caseDir('empty', { stub: 'process.exit(3);' })), 2, /UNKNOWN: knip produced no report/);
    check('an unparsable report is UNKNOWN, exit 2',
      runCli(caseDir('garbage', { stub: 'console.log("not json at all");' })), 2, /UNKNOWN: knip output did not parse/);
  } finally {
    for (const r of roots) { try { rmSync(r, { recursive: true, force: true }); } catch {} }
  }
  if (failures) {
    console.error(`\n[dead-code] SELFTEST FAILED (${failures}). Do not trust this gate.`);
    return 1;
  }
  console.log('\n[dead-code] selftest passed: every verdict path maps to its exit code.');
  return 0;
}

if (process.argv.includes('--selftest')) process.exit(selftest());
process.exit(run(process.cwd()));
