#!/usr/bin/env node
// check-privacy-accountability.mjs - no compliance determination may stay OPEN at ship time.
//
// docs/privacy-accountability.md is the per-product determination file: alongside its prose
// register (processing activities, rights, vendors) it carries a Determinations table where
// every row is one decision a project keeps deferring until a gate refuses to let it defer -
// DPIA trigger, AI Act Article 50, the EAA accessibility statement, SCC/TIA for transfers,
// the consent component, the sub-processor page. Three states per row:
//
//   | <determination> | OPEN | | |                                   <- blocks (this gate)
//   | <determination> | APPLIES - <what ships> | <date> | <evidence> |
//   | <determination> | N-A - <reason> | <date> | <evidence> |
//
// An ABSENT file prints SKIPPED and exits 0: the pass prompts and the sign-off rubric decide
// WHICH products must carry the file; this gate only refuses to call a carried file settled
// while a row is OPEN. A file WITHOUT the table fails: it predates the standard shape, and the
// fix is pasting the Determinations section from legal/privacy-accountability.template.md.
//
// Exit codes: 0 settled or absent (SKIPPED), 1 OPEN or malformed rows, 2 could not run.
//
// Usage: node scripts/check-privacy-accountability.mjs [path] [--selftest]
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const VERDICT_RE = /^(OPEN\b|APPLIES\s*-\s*\S|N-A\s*-\s*\S)/i;

function run(cwd, explicitPath) {
  const file = explicitPath || join(cwd, 'docs', 'privacy-accountability.md');
  if (!existsSync(file)) {
    console.log(`[privacy-accountability] SKIPPED: no ${explicitPath || 'docs/privacy-accountability.md'}. Whether this product needs one is the sign-off rubric's question, not this gate's.`);
    return 0;
  }
  let body;
  try {
    body = readFileSync(file, 'utf8');
  } catch (e) {
    console.error(`[privacy-accountability] UNKNOWN: ${file} could not be read (${(e && e.code) || 'read error'}).`);
    return 2;
  }
  const section = /^##\s+Determinations\s*$([\s\S]*?)(?=^##\s|(?![\s\S]))/im.exec(body);
  if (!section) {
    console.error('[privacy-accountability] FAIL: the file has no "## Determinations" section. It predates the standard shape; paste the table from scaffold-gates/legal/privacy-accountability.template.md and decide each row.');
    return 1;
  }
  const rows = section[1].split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.startsWith('|') && !/^\|\s*-|^\|\s*Determination/i.test(l))
    .map((l) => l.split('|').map((c) => c.trim()).filter((c, i, arr) => i > 0 && i < arr.length - 1));
  if (rows.length === 0) {
    console.error('[privacy-accountability] FAIL: the Determinations section holds no table rows. Every deferred decision needs a row, even if its verdict is OPEN.');
    return 1;
  }
  const problems = [];
  for (const cells of rows) {
    const [name, verdict] = cells;
    if (!name) continue;
    if (!verdict || !VERDICT_RE.test(verdict)) {
      problems.push(`"${name}": verdict "${verdict || ''}" is not OPEN, "APPLIES - <what ships>", or "N-A - <reason>"`);
    } else if (/^OPEN\b/i.test(verdict)) {
      problems.push(`"${name}" is still OPEN - decide it, date it, and point at the evidence`);
    }
  }
  if (problems.length) {
    console.error(`[privacy-accountability] ${problems.length} undetermined row(s) in ${file}:`);
    for (const p of problems) console.error(`  ${p}`);
    return 1;
  }
  console.log(`[privacy-accountability] settled: ${rows.length} determination(s), none OPEN.`);
  return 0;
}

// --- selftest ---------------------------------------------------------------
function selftest() {
  const self = fileURLToPath(import.meta.url);
  let failures = 0;
  const roots = [];
  const fixture = (bodyOrNull) => {
    const root = mkdtempSync(join(tmpdir(), 'privacy-acct-st-'));
    roots.push(root);
    if (bodyOrNull !== null) {
      mkdirSync(join(root, 'docs'), { recursive: true });
      writeFileSync(join(root, 'docs', 'privacy-accountability.md'), bodyOrNull);
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
      console.error(`SELFTEST FAIL: ${name} -> exit ${got.code} wanted ${wantCode}; ${wantRe.test(got.out) ? 'output matched' : 'output missed ' + wantRe}`);
    } else console.log(`selftest ok: ${name}`);
  };
  const HEAD = '# Privacy Accountability\n\nprose register here\n\n## Determinations\n\n| Determination | Verdict | Date | Evidence |\n| --- | --- | --- | --- |\n';
  try {
    check('an absent file is a loud SKIPPED, exit 0', runCli(fixture(null)), 0, /SKIPPED/);
    check('a settled table passes', runCli(fixture(HEAD +
      '| DPIA required (Art. 35) | N-A - no large-scale or vulnerable-subject processing | 2026-08-29 | docs/privacy-accountability.md register |\n' +
      '| AI Act Article 50 | APPLIES - 50(1) disclosure ships in the first reply | 2026-08-29 | docs/ai-act.md |\n')), 0, /settled: 2 determination/);
    check('an OPEN row fails naming the row', runCli(fixture(HEAD +
      '| AI Act Article 50 | OPEN | | |\n')), 1, /"AI Act Article 50" is still OPEN/);
    check('a verdict outside the three states fails', runCli(fixture(HEAD +
      '| DPIA required (Art. 35) | probably fine | | |\n')), 1, /is not OPEN, "APPLIES - <what ships>", or "N-A - <reason>"/);
    check('a bare APPLIES with no what-ships fails', runCli(fixture(HEAD +
      '| AI Act Article 50 | APPLIES - | | |\n')), 1, /is not OPEN/);
    check('a file without the section fails with the paste remedy', runCli(fixture('# Privacy Accountability\n\nold shape only\n')), 1, /no "## Determinations" section/);
    check('an empty section fails', runCli(fixture('# x\n\n## Determinations\n\nnothing here\n')), 1, /holds no table rows/);
    check('a section followed by another heading is bounded correctly', runCli(fixture(HEAD +
      '| DPIA required | N-A - static site, no personal data stored | 2026-08-29 | register |\n\n## Retention\n\n| not | a determination |\n')), 0, /settled: 1 determination/);
  } finally {
    for (const r of roots) { try { rmSync(r, { recursive: true, force: true }); } catch {} }
  }
  if (failures) {
    console.error(`\n[privacy-accountability] SELFTEST FAILED (${failures}). Do not trust this gate.`);
    return 1;
  }
  console.log('\n[privacy-accountability] selftest passed: OPEN blocks, settled and absent stay green.');
  return 0;
}

if (process.argv.includes('--selftest')) process.exit(selftest());
const pathArg = process.argv.slice(2).find((a) => !a.startsWith('-'));
process.exit(run(process.cwd(), pathArg));
