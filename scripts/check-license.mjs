#!/usr/bin/env node
// check-license.mjs - LICENSE exists, and its holder is the product's, not a template's.
//
// Two real failure shapes drove this gate: repos still crediting the SCAFFOLDER that generated
// them (three apps shipped "Copyright Expo" style holders), and an Apache 2.0 file whose
// copyright notice still read "[yyyy] [name of copyright owner]" on a product headed public.
//
// WHAT IT DELIBERATELY DOES NOT DO: assert "no unfilled placeholder anywhere". Apache 2.0's own
// APPENDIX legitimately carries the literal "[yyyy] [name of copyright owner]" as instructions
// for downstream users, so a whole-file placeholder ban would fail every correctly filled
// Apache LICENSE. Only the file's OWN copyright notice lines are judged.
//
// The expected holder comes from, in order: the LICENSE_HOLDER environment variable, then
// package.json's author (string or object .name). With neither declared, the holder-match
// check SKIPs loudly and the template checks still run.
//
// Exit codes: 0 ok, 1 findings, 2 could not run.
//
// Usage: node scripts/check-license.mjs [--selftest]
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const LICENSE_NAMES = ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'LICENCE', 'LICENCE.md'];
// Scaffolders and template authors whose name in a copyright line means "never filled in".
const TEMPLATE_HOLDERS_RE = /\b(Expo|Vercel|Facebook|Meta Platforms|Google LLC|Create React App|Next\.js)\b/i;
// A copyright NOTICE line (not the appendix instructions): "Copyright <something>".
const COPYRIGHT_LINE_RE = /^\s*Copyright\b.*$/gim;
// The unfilled Apache appendix values, judged ONLY on a notice line.
const UNFILLED_RE = /\[yyyy\]|\[name of copyright owner\]/i;

function expectedHolder(cwd) {
  if (process.env.LICENSE_HOLDER && process.env.LICENSE_HOLDER.trim()) return process.env.LICENSE_HOLDER.trim();
  try {
    const pkg = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8'));
    if (typeof pkg.author === 'string' && pkg.author.trim()) return pkg.author.replace(/<[^>]*>|\([^)]*\)/g, '').trim();
    if (pkg.author && typeof pkg.author.name === 'string' && pkg.author.name.trim()) return pkg.author.name.trim();
  } catch { /* no declared holder is a stated skip below, not an error */ }
  return null;
}

function run(cwd) {
  const file = LICENSE_NAMES.map((n) => join(cwd, n)).find((p) => existsSync(p));
  if (!file) {
    console.error(`[license] MISSING: no LICENSE file at the repo root (looked for ${LICENSE_NAMES.join(', ')}).`);
    console.error('[license] A public repo without one defaults to all-rights-reserved, which is rarely the intent. Add one and fill the holder.');
    return 1;
  }
  let body;
  try {
    body = readFileSync(file, 'utf8');
  } catch (e) {
    console.error(`[license] UNKNOWN: ${file} could not be read (${(e && e.code) || 'read error'}).`);
    return 2;
  }
  const findings = [];
  const noticeLines = body.match(COPYRIGHT_LINE_RE) || [];
  for (const line of noticeLines) {
    const t = TEMPLATE_HOLDERS_RE.exec(line);
    if (t) findings.push(`the copyright line "${line.trim()}" credits ${t[1]}, a template holder, not this product's owner`);
  }
  const filled = noticeLines.filter((l) => !UNFILLED_RE.test(l));
  const unfilled = noticeLines.filter((l) => UNFILLED_RE.test(l));
  if (noticeLines.length === 0) {
    findings.push('the file carries no "Copyright ..." notice line at all; add one naming the holder');
  } else if (filled.length === 0 && unfilled.length > 0) {
    // Every notice line is still the template. One unfilled line ALONGSIDE a filled one is the
    // Apache appendix and legal; unfilled-only means nobody ever filled it.
    findings.push(`every copyright line is still the template (${unfilled[0].trim()}); fill the year and holder`);
  }
  const holder = expectedHolder(cwd);
  if (holder == null) {
    console.log('[license] holder-match SKIPPED: no LICENSE_HOLDER env and no package.json author declared. The template checks above still ran.');
  } else if (filled.length > 0 && !filled.some((l) => l.toLowerCase().includes(holder.toLowerCase()))) {
    findings.push(`no copyright line names the declared holder "${holder}" (declared via ${process.env.LICENSE_HOLDER ? 'LICENSE_HOLDER' : 'package.json author'})`);
  }
  if (findings.length) {
    console.error(`[license] ${findings.length} finding(s) in ${file}:`);
    for (const f of findings) console.error(`  ${f}`);
    return 1;
  }
  console.log(`[license] ok: ${file}${holder ? ` names the declared holder "${holder}"` : ''} and credits no template author.`);
  return 0;
}

// --- selftest ---------------------------------------------------------------
function selftest() {
  const self = fileURLToPath(import.meta.url);
  let failures = 0;
  const roots = [];
  const fixture = (files) => {
    const root = mkdtempSync(join(tmpdir(), 'check-license-st-'));
    roots.push(root);
    for (const [rel, bodyText] of Object.entries(files)) writeFileSync(join(root, rel), bodyText);
    return root;
  };
  const runCli = (cwd, env = {}) => {
    try {
      const out = execFileSync(process.execPath, [self], {
        cwd, encoding: 'utf8', windowsHide: true, stdio: 'pipe',
        env: { ...process.env, LICENSE_HOLDER: '', ...env },
      });
      return { code: 0, out };
    } catch (e) {
      return { code: e.status == null ? -1 : e.status, out: String((e && e.stdout) || '') + String((e && e.stderr) || '') };
    }
  };
  const check = (name, got, wantCode, wantRe) => {
    if (got.code !== wantCode || !wantRe.test(got.out)) {
      failures++;
      console.error(`SELFTEST FAIL: ${name} -> exit ${got.code} wanted ${wantCode}; ${wantRe.test(got.out) ? 'output matched' : 'output missed ' + wantRe}`);
    } else console.log(`selftest ok: ${name}`);
  };
  const MIT_OK = 'MIT License\n\nCopyright (c) 2026 Brightlabs\n\nPermission is hereby granted...\n';
  const APACHE_FILLED = 'Apache License\nVersion 2.0\n\nCopyright 2026 Brightlabs\n\nAPPENDIX: How to apply...\n\nCopyright [yyyy] [name of copyright owner]\n\nLicensed under the Apache License...\n';
  const APACHE_UNFILLED = 'Apache License\nVersion 2.0\n\nAPPENDIX: How to apply...\n\nCopyright [yyyy] [name of copyright owner]\n\nLicensed under the Apache License...\n';
  try {
    check('a filled MIT license passes', runCli(fixture({ LICENSE: MIT_OK })), 0, /\[license\] ok/);
    check('a missing LICENSE fails', runCli(fixture({ 'README.md': '# x\n' })), 1, /MISSING: no LICENSE file/);
    check('a template holder (Expo) fails', runCli(fixture({ LICENSE: 'MIT License\n\nCopyright (c) 2024 Expo\n' })), 1, /credits Expo, a template holder/);
    check('a filled Apache 2.0 KEEPING its appendix passes', runCli(fixture({ LICENSE: APACHE_FILLED })), 0, /\[license\] ok/);
    check('an Apache 2.0 whose only notice is the template fails', runCli(fixture({ LICENSE: APACHE_UNFILLED })), 1, /still the template/);
    check('a declared holder that no notice names fails',
      runCli(fixture({ LICENSE: MIT_OK }), { LICENSE_HOLDER: 'Someone Else' }), 1, /no copyright line names the declared holder "Someone Else"/);
    check('a declared holder that a notice names passes',
      runCli(fixture({ LICENSE: MIT_OK }), { LICENSE_HOLDER: 'Brightlabs' }), 0, /names the declared holder/);
    check('package.json author is used when no env is set',
      runCli(fixture({ LICENSE: MIT_OK, 'package.json': '{"name":"fx","author":"Someone Else <a@b.invalid>"}' })), 1, /package\.json author/);
    check('no declared holder skips the match loudly and still passes template checks',
      runCli(fixture({ LICENSE: MIT_OK })), 0, /holder-match SKIPPED/);
    check('no copyright line at all fails', runCli(fixture({ LICENSE: 'MIT License\n\nPermission is hereby granted...\n' })), 1, /no "Copyright \.\.\." notice line/);
  } finally {
    for (const r of roots) { try { rmSync(r, { recursive: true, force: true }); } catch {} }
  }
  if (failures) {
    console.error(`\n[license] SELFTEST FAILED (${failures}). Do not trust this gate.`);
    return 1;
  }
  console.log('\n[license] selftest passed: templates fail, filled licenses (appendix included) pass.');
  return 0;
}

if (process.argv.includes('--selftest')) process.exit(selftest());
process.exit(run(process.cwd()));
