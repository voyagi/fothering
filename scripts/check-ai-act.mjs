#!/usr/bin/env node
// check-ai-act.mjs - the EU AI Act Article 50 marking gate.
//
// Article 50's transparency obligations have applied since 2 August 2026. For a product they
// bind, "we decided" is not a mechanism: the determination must be written down per paragraph,
// and where a paragraph APPLIES, the thing that satisfies it must be code this gate can point
// at - a named constant, a marking step - plus the test that pins it. The reference shape is a
// real one (a shipped docs/ai-act.md: 50(1) applies, the disclosure is a constant carried in
// every call, its test asserts presence, position, and survival on an empty payload).
//
// WHAT IT CHECKS in docs/ai-act.md:
//   - one section heading per paragraph, all four of 50(1) 50(2) 50(3) 50(4)
//   - each section carries a verdict: APPLIES, DOES NOT APPLY, or FALLS ON <third party>
//   - every APPLIES section names at least one backticked repo path that EXISTS (the mechanism)
//     and at least one backticked path that is a TEST file and exists (what pins it)
//
// An ABSENT file prints SKIPPED and exits 0: whether a product is AI-facing is the sign-off
// rubric's question (an AI-facing product without this file is refused THERE, and the
// gdpr-check D11 row plus the Determinations table both demand the verdict). This gate makes a
// WRITTEN determination mechanically honest; it cannot detect an unwritten one.
//
// Exit codes: 0 determined (or absent, SKIPPED), 1 missing/undetermined/unbacked sections,
// 2 could not run.
//
// Usage: node scripts/check-ai-act.mjs [path] [--selftest]
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const PARAGRAPHS = ['1', '2', '3', '4'];
const TEST_PATH_RE = /\.(test|spec)\.[\w.]+$|(^|\/)tests?\//i;

function run(cwd, explicitPath) {
  const file = explicitPath || join(cwd, 'docs', 'ai-act.md');
  if (!existsSync(file)) {
    console.log(`[ai-act] SKIPPED: no ${explicitPath || 'docs/ai-act.md'}. An AI-facing product without a written Article 50 determination is refused at sign-off, not here.`);
    return 0;
  }
  let body;
  try {
    body = readFileSync(file, 'utf8');
  } catch (e) {
    console.error(`[ai-act] UNKNOWN: ${file} could not be read (${(e && e.code) || 'read error'}).`);
    return 2;
  }
  const problems = [];
  for (const p of PARAGRAPHS) {
    const headRe = new RegExp(`^##[^\\n]*Article\\s*50\\s*\\(${p}\\)[^\\n]*$`, 'im');
    const head = headRe.exec(body);
    if (!head) {
      problems.push(`no section heading for Article 50(${p}) - every paragraph gets a written verdict, including the ones that do not apply`);
      continue;
    }
    const rest = body.slice(head.index);
    const end = rest.slice(head[0].length).search(/^##\s/m);
    const section = end === -1 ? rest : rest.slice(0, head[0].length + end);
    const applies = /\bAPPLIES\b/i.test(section.split('\n', 1)[0]) || /^\*\*?Verdict\*\*?:?\s*APPLIES/im.test(section);
    const notApply = /\b(DOES NOT APPLY|NOT APPLICABLE)\b/i.test(section) || /falls on\b/i.test(section.split('\n', 1)[0]) || /:\s*falls on/i.test(section);
    if (!applies && !notApply) {
      problems.push(`Article 50(${p}): no verdict found - the heading or a Verdict line must say APPLIES, DOES NOT APPLY, or falls on <the third party>`);
      continue;
    }
    if (applies) {
      const ticked = [...section.matchAll(/`([^`\n]+)`/g)].map((m) => m[1])
        .filter((t) => /[\\/.]/.test(t) && !/\s/.test(t));
      const existing = ticked.filter((t) => existsSync(join(cwd, t)));
      const tests = existing.filter((t) => TEST_PATH_RE.test(t));
      const mechanisms = existing.filter((t) => !TEST_PATH_RE.test(t));
      if (mechanisms.length === 0) {
        problems.push(`Article 50(${p}) APPLIES but names no existing mechanism path in backticks - the obligation needs code, not intent`);
      }
      if (tests.length === 0) {
        problems.push(`Article 50(${p}) APPLIES but names no existing test file in backticks - an unpinned marking disappears in the next refactor`);
      }
    }
  }
  if (problems.length) {
    console.error(`[ai-act] ${problems.length} problem(s) in ${file}:`);
    for (const p of problems) console.error(`  ${p}`);
    console.error('[ai-act] The reference shape is scaffold-gates/legal/ai-act.template.md.');
    return 1;
  }
  console.log('[ai-act] determined: all four Article 50 paragraphs carry verdicts, and every APPLIES names its mechanism and its test.');
  return 0;
}

// --- selftest ---------------------------------------------------------------
function selftest() {
  const self = fileURLToPath(import.meta.url);
  let failures = 0;
  const roots = [];
  const fixture = (bodyOrNull, extraFiles = {}) => {
    const root = mkdtempSync(join(tmpdir(), 'ai-act-st-'));
    roots.push(root);
    if (bodyOrNull !== null) {
      mkdirSync(join(root, 'docs'), { recursive: true });
      writeFileSync(join(root, 'docs', 'ai-act.md'), bodyOrNull);
    }
    for (const [rel, b] of Object.entries(extraFiles)) {
      mkdirSync(dirname(join(root, rel)), { recursive: true });
      writeFileSync(join(root, rel), b);
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
  const OTHERS =
    '## Article 50(2), marking synthetic output: falls on the speech vendor, not here\n\ntext\n\n' +
    '## Article 50(3), emotion recognition: DOES NOT APPLY\n\ntext\n\n' +
    '## Article 50(4), deepfakes and public-interest text: DOES NOT APPLY\n\ntext\n';
  const MECH = { 'src/domain/brief.ts': 'export const D = "x";\n', 'src/domain/brief.test.ts': 'test\n' };
  try {
    check('an absent file is a loud SKIPPED, exit 0', runCli(fixture(null)), 0, /SKIPPED/);
    check('a full determination with mechanism and test passes', runCli(fixture(
      '# AI Act\n\n## Article 50(1), interaction: APPLIES\n\nThe disclosure is `src/domain/brief.ts` and `src/domain/brief.test.ts` asserts it.\n\n' + OTHERS,
      MECH)), 0, /determined: all four/);
    check('a missing paragraph section fails', runCli(fixture(
      '# AI Act\n\n## Article 50(1), interaction: DOES NOT APPLY\n\ntext\n')), 1, /no section heading for Article 50\(2\)/);
    check('a section with no verdict fails', runCli(fixture(
      '# AI Act\n\n## Article 50(1), interaction\n\nwe thought about it\n\n' + OTHERS)), 1, /Article 50\(1\): no verdict/);
    check('APPLIES with no mechanism path fails', runCli(fixture(
      '# AI Act\n\n## Article 50(1), interaction: APPLIES\n\nWe say so in every call.\n\n' + OTHERS)), 1, /names no existing mechanism path/);
    check('APPLIES with a mechanism but no test fails', runCli(fixture(
      '# AI Act\n\n## Article 50(1), interaction: APPLIES\n\nThe constant is `src/domain/brief.ts`.\n\n' + OTHERS,
      { 'src/domain/brief.ts': 'x\n' })), 1, /names no existing test file/);
    check('APPLIES naming a path that does not exist fails', runCli(fixture(
      '# AI Act\n\n## Article 50(1), interaction: APPLIES\n\nSee `src/gone.ts` and `src/gone.test.ts`.\n\n' + OTHERS)), 1, /names no existing mechanism path/);
    check('a falls-on verdict needs no mechanism here', runCli(fixture(
      '# AI Act\n\n## Article 50(1), interaction: DOES NOT APPLY\n\ntext\n\n' + OTHERS)), 0, /determined/);
  } finally {
    for (const r of roots) { try { rmSync(r, { recursive: true, force: true }); } catch {} }
  }
  if (failures) {
    console.error(`\n[ai-act] SELFTEST FAILED (${failures}). Do not trust this gate.`);
    return 1;
  }
  console.log('\n[ai-act] selftest passed: unwritten, unverdicted and unbacked determinations all fail.');
  return 0;
}

if (process.argv.includes('--selftest')) process.exit(selftest());
const pathArg = process.argv.slice(2).find((a) => !a.startsWith('-'));
process.exit(run(process.cwd(), pathArg));
