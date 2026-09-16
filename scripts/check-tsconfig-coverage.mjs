#!/usr/bin/env node
// check-tsconfig-coverage.mjs - every tracked TypeScript file must sit inside the program of at
// least one tsconfig, so `tsc --noEmit` actually checks it.
//
// WHY THIS EXISTS. Measured 2026-09-06 across every repo on the machine, the day after one repo
// was found shipping its whole Playwright suite and its three root config files outside
// `include`: twelve live repos had the same gap, from one config file to a 27-file test folder,
// and three more had full coverage of a `tsc` that nothing ever ran. A test that is not
// type-checked hides its own bugs until it fails for the wrong reason, and a config file outside
// the program breaks the build with no compiler in the loop. Nothing mechanical said so anywhere.
//
// THREE RULES AND ONE ADVISORY.
//   1. COVERED. Every tracked .ts, .tsx, .mts and .cts file (not .d.ts, not under node_modules) is
//      in the file set of at least one tracked tsconfig*.json, resolved by the repo's OWN
//      TypeScript exactly as tsc resolves it: include, exclude, files and extends all apply.
//   2. NO TWINS. A .ts and a .tsx with the same name in the same directory. TypeScript keeps the
//      .ts and silently drops the .tsx from the program even when the directory is included (a
//      name listed in `files` is kept, so a same-case twin counts only while it is uncovered).
//      Measured on one repo: three test files vitest ran and tsc never saw. Names differing only
//      by letter case are twins on Windows and macOS and two files on Linux, so the local check and
//      the CI check disagree, which is its own defect.
//   3. A TSCONFIG EXISTS while TypeScript files are tracked. A tracked deno.json with no tsconfig
//      is a Deno project and is exempt, because Deno type-checks without one.
//   note: no package.json script runs tsc. Coverage of a check nobody runs is reported, never
//      failed: which script owns the check is the product's call, and only its absence is noted.
//
// EXEMPTIONS ARE VISIBLE, NEVER SILENT. A file may carry `// tsconfig-coverage: ignore <reason>`
// in its first five lines, or the script line may pass `--ignore <glob>`, repeatable. Both show up
// where a reader looks: in a diff, or in package.json. An ignored path also keeps its tsconfig out
// of the union, so a test fixture's config cannot widen coverage or break the scan.
//
// Stack independent and with no dependencies of its own: it borrows the repo's TypeScript, which
// any repo with a tsconfig already has, and reports UNKNOWN rather than clean when it cannot find
// one. Exit codes: 0 clean, 1 findings, 2 UNKNOWN. Findings outrank incompleteness in report(): a
// verdict carrying both exits 1. The scan itself stops at the first cause of UNKNOWN and carries no
// findings past it, so today only a hand-built verdict has both; the ordering is pinned by a
// control so a future partial scan inherits it rather than deciding it again.
//
// Usage:
//   node scripts/check-tsconfig-coverage.mjs                   check the repo
//   node scripts/check-tsconfig-coverage.mjs --ignore <glob>   exempt paths, repeatable
//   node scripts/check-tsconfig-coverage.mjs --selftest        prove the gate still fires
//
// TSCONFIG_COVERAGE_TS is a test-only override: the directory of a `typescript` package to use
// instead of the repo's own. The selftest resolves one for its fixtures; a production run never
// needs it and never reads a fixture.

import { readFileSync, writeFileSync, appendFileSync, mkdirSync, mkdtempSync, rmSync, openSync, readSync, closeSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { join, dirname, basename } from 'node:path';
import { tmpdir } from 'node:os';

// --- what is looked at -------------------------------------------------------------------------

const TS_FILE_RE = /\.(ts|tsx|mts|cts)$/i;
const DECLARATION_RE = /\.d\.(ts|mts|cts)$/i;
const NODE_MODULES_RE = /(^|\/)node_modules\//i;
const TSCONFIG_RE = /(^|\/)tsconfig[^/]*\.json$/i;
const DENO_CONFIG_RE = /^deno\.jsonc?$/i;
const IGNORE_MARKER_RE = /tsconfig-coverage:\s*ignore/i;
const MARKER_LINES = 5;

// --- git helpers -------------------------------------------------------------------------------

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
}

function repoRoot(cwd) {
  return git(['rev-parse', '--show-toplevel'], cwd).trim();
}

// `-z` so a path holding a space, a quote or a non-ASCII letter arrives as itself. Without it git
// quotes such paths and the quoted form matches nothing the compiler reports.
function trackedFiles(root) {
  return git(['ls-files', '-z'], root).split('\0').filter(Boolean);
}

// --- resolving the compiler --------------------------------------------------------------------

// The repo's OWN TypeScript, resolved from inside the repo so hoisted and workspace layouts both
// work. Borrowing the compiler rather than re-implementing tsconfig semantics is the whole design:
// a home-grown `include` matcher would drift from tsc the first time either changed, and the point
// of this gate is to say what tsc will do.
// THE PACKAGE ROOT, NEVER THE lib/ FOLDER. `require.resolve('typescript')` answers with
// lib/typescript.js, and the first version handed that file's directory back as `from`. The
// selftest then passed it to every fixture as the override, where `createRequire('./')` found no
// package.json and every compiler-backed control read UNKNOWN. Measured 2026-09-08 on
// a website repo by the change that installed this gate: 14 of 45 controls bare, 45 of 45
// with TSCONFIG_COVERAGE_TS naming the package root. It hid from the original author's runs because
// those always set that variable. Walking up to the package.json that names typescript serves
// both callers, and an override pointing at lib/ is forgiven the same way.
//
// WHAT A FAILED WALK LOOKS LIKE, stated because it is not visible from the call site and it is
// the same silence this function was written to end. It returns its INPUT unchanged, so the two
// callers part ways: the override branch then hands a directory with no package.json to
// createRequire, which throws, and the caller reports a clean `error` that the selftest prints as
// a per-line skip. The resolve branch does NOT throw, because the compiler already loaded from
// the entry file, so only `from` is wrong, and `from` is read by the selftest alone. There the
// symptom is a low control count and nothing else: 14 of 45 rather than 45 of 45, which reads
// like a gate defect rather than a resolution one. That is exactly how it hid until 2026-09-08.
// No guard is written for it: the walk needs one level to succeed against a normal npm layout
// (lib/, then the package root) and gets four, and a branch that cannot fire reads as coverage
// while providing none. Verified 2026-09-09 from another repo with no override: 45 of 45.
function typescriptPackageRoot(dir) {
  let here = dir;
  for (let depth = 0; depth < 4; depth++) {
    try {
      if (JSON.parse(readFileSync(join(here, 'package.json'), 'utf8')).name === 'typescript') return here;
    } catch { /* not this level */ }
    const up = dirname(here);
    if (up === here) break;
    here = up;
  }
  return dir;
}

function resolveTypescript(root, override) {
  try {
    if (override) {
      const pkgRoot = typescriptPackageRoot(override);
      return { ts: createRequire(join(pkgRoot, 'package.json'))('./'), from: pkgRoot };
    }
    const req = createRequire(join(root, '__tsconfig_coverage_resolve__.js'));
    const entry = req.resolve('typescript');
    return { ts: req(entry), from: typescriptPackageRoot(dirname(entry)) };
  } catch (e) {
    return { error: `no TypeScript to resolve configs with (${(e && e.message || '').split('\n')[0]})` };
  }
}

// The file set of one tsconfig, as tsc would build it. Paths come back absolute with forward
// slashes; they are made repo-relative and case-folded here so they compare against git's list.
function programFiles(ts, root, configRel) {
  // Forward slashes, because that is the form TypeScript normalises to internally. Handed a
  // backslash path, its config reader asserts on the mismatch the moment it has a diagnostic to
  // attach to the file, so an unreadable tsconfig crashed the scan instead of reporting UNKNOWN.
  // Measured 2026-09-06 in this gate's own selftest, on Windows.
  const abs = join(root, configRel).replace(/\\/g, '/');
  const read = ts.readConfigFile(abs, ts.sys.readFile);
  if (read.error) {
    return { error: `${configRel}: ${ts.flattenDiagnosticMessageText(read.error.messageText, ' ')}` };
  }
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, dirname(abs), undefined, abs);
  // A config tsc REJECTS is not one this gate can reason about, and the rejection that matters most
  // is silent in fileNames: an `extends` whose target is missing leaves the child with no include at
  // all, which TypeScript reads as `**/*`, so the broken config "covered" every file and the gate
  // said clean. Measured 2026-09-07 on a fixture: exit 0 with two files in the program, while tsc
  // itself stops with TS6053. Any error-level diagnostic is therefore UNKNOWN, with one exception,
  // TS18003 "no inputs were found": there the empty program IS what tsc computed, and the per-file
  // findings below name exactly what it misses, which is worth more than a refusal.
  // These error codes leave `fileNames` correct, measured against TypeScript 5.9.3 on 2026-09-07:
  // 18003 "No inputs were found" (the empty program IS what tsc computed, and the per-file findings
  // name exactly what it misses), 5023 "Unknown compiler option" and 6046 "Argument for --<option>
  // must be" (both about compilerOptions, which the file set does not depend on). They become a note
  // rather than a refusal, so a typo in an option no longer hides the coverage answer. Everything
  // else still refuses, because the default has to be fail-safe: an unresolved `extends` (5083)
  // silently drops the parent's include, which is the defect this check was added for. The refusal
  // names the CODE so a new one can be measured with the same probe and added here rather than
  // guessed at.
  const FILE_SET_SAFE = new Set([18003, 5023, 6046]);
  const errors = (parsed.errors || []).filter((d) => d.category === ts.DiagnosticCategory.Error);
  const rejected = errors.filter((d) => !FILE_SET_SAFE.has(d.code));
  if (rejected.length) {
    return { error: `${configRel}: TypeScript rejects this config (TS${rejected[0].code}), ${ts.flattenDiagnosticMessageText(rejected[0].messageText, ' ')}` };
  }
  const tolerated = errors.filter((d) => d.code !== 18003)
    .map((d) => `${configRel}: TS${d.code} ${ts.flattenDiagnosticMessageText(d.messageText, ' ')}`);
  const files = new Set();
  const rootFwd = root.replace(/\\/g, '/').replace(/\/$/, '');
  for (const f of parsed.fileNames) {
    const fwd = f.replace(/\\/g, '/');
    const rel = fwd.toLowerCase().startsWith(rootFwd.toLowerCase() + '/') ? fwd.slice(rootFwd.length + 1) : fwd;
    files.add(rel.toLowerCase());
  }
  return { files, tolerated };
}

// --- exemptions --------------------------------------------------------------------------------

// A deliberately SMALL glob: `**` crosses directories, `*` and `?` do not, everything else is
// literal. It matches the repo-relative forward-slash path, anchored at both ends.
function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') { re += '.*'; i++; if (glob[i + 1] === '/') i++; }
      else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`, 'i');
}

function ignoredByFlag(rel, patterns) {
  return patterns.some((re) => re.test(rel));
}

// An exemption that matches nothing exempts nothing, so the next real gap in the folder it names
// passes unremarked. It has two causes and this check cannot tell them apart: the folder was
// renamed or removed, or it does not exist yet. That is why the note SAYS both and why it is an
// advisory rather than a failure (measured 2026-09-07: a forward-looking glob fires it too, and
// an earlier wording asserted the renamed-or-removed cause it has no way to know).
function unusedIgnores(globs, patterns, paths) {
  return globs.filter((_, i) => !paths.some((p) => patterns[i].test(p)));
}

// Only the first few lines are read, and only of files the gate is about to report, so a large
// repo pays for this once per finding rather than once per file.
function hasIgnoreMarker(abs) {
  let fd;
  try {
    fd = openSync(abs, 'r');
    const buf = Buffer.alloc(2048);
    const n = readSync(fd, buf, 0, buf.length, 0);
    const head = buf.toString('utf8', 0, n).split(/\r?\n/).slice(0, MARKER_LINES).join('\n');
    return IGNORE_MARKER_RE.test(head);
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

// --- the scan ----------------------------------------------------------------------------------

function scan(cwd, opts = {}) {
  const ignoreGlobs = opts.ignore || [];
  const ignorePatterns = ignoreGlobs.map(globToRegExp);
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

  // The index and the disk are two different lists, and tsc reads the disk. A file whose deletion
  // is not staged yet is still in `git ls-files` and gone from every program, so it was reported as
  // "outside every tsconfig", telling the reader to add a deleted file to `include` (measured
  // 2026-09-07). A path git knows and the file system does not is a pending deletion, not a gap.
  const tsFiles = tracked.filter((f) => TS_FILE_RE.test(f) && !DECLARATION_RE.test(f) && !NODE_MODULES_RE.test(f) && existsSync(join(root, f)));
  // An --ignore glob keeps a tsconfig out of the union too. Every tracked tsconfig joins it, so a
  // test fixture's config with a wide include would otherwise "cover" the whole repo (measured
  // 2026-09-07: a `test/fixtures/tsconfig.json` including `../../**/*` hid an uncovered e2e
  // folder), and a deliberately broken fixture would turn every scan UNKNOWN with no way out.
  const allConfigs = tracked.filter((f) => TSCONFIG_RE.test(f) && !NODE_MODULES_RE.test(f));
  const configs = allConfigs.filter((f) => !ignoredByFlag(f, ignorePatterns));
  const denoProject = tracked.some((f) => DENO_CONFIG_RE.test(f));
  const advisories = [];
  const findings = [];

  // Measured against the whole tracked list, not only the TypeScript files, because an --ignore
  // glob may legitimately name a tsconfig rather than a source file.
  const stale = unusedIgnores(ignoreGlobs, ignorePatterns, tracked);
  if (stale.length) {
    advisories.push(`--ignore ${stale.join(', ')} matched no tracked file, so it exempts nothing: either the folder was renamed or removed, or it does not exist yet`);
  }

  if (tsFiles.length === 0) {
    return { ok: true, findings, advisories, tracked: 0, configs: configs.length, covered: 0 };
  }

  // Rule 3: a tsconfig exists at all. Deno is the one runtime that type-checks without one.
  if (configs.length === 0) {
    if (denoProject) {
      advisories.push('a Deno project (deno.json tracked, no tsconfig): Deno type-checks these itself, nothing to resolve');
      return { ok: true, findings, advisories, tracked: tsFiles.length, configs: 0, covered: tsFiles.length };
    }
    const exempt = tsFiles.filter((f) => ignoredByFlag(f, ignorePatterns) || hasIgnoreMarker(join(root, f)));
    if (exempt.length !== tsFiles.length) {
      // "No tsconfig exists" and "every tsconfig you have is behind an --ignore glob" send the
      // reader to opposite fixes, and the second used to print the first: an operator would add a
      // config that is already there rather than narrow the glob (measured 2026-09-07).
      findings.push({
        file: allConfigs.length ? allConfigs[0] : 'tsconfig.json', kind: 'no-tsconfig',
        why: allConfigs.length
          ? `${tsFiles.length - exempt.length} TypeScript file(s) are tracked and every tracked tsconfig (${allConfigs.length}) is behind an --ignore glob, so none of them can type-check anything`
          : `${tsFiles.length - exempt.length} TypeScript file(s) are tracked and no tsconfig exists, so nothing can type-check them`,
      });
    }
    return finish(root, findings, advisories, tsFiles.length, 0, 0, tracked);
  }

  // Rule 1: the union of every tsconfig's program, resolved by the repo's own compiler.
  const resolved = resolveTypescript(root, opts.tsDir || process.env.TSCONFIG_COVERAGE_TS || undefined);
  if (resolved.error) {
    return { unknown: true, reason: resolved.error, findings: [] };
  }
  const covered = new Set();
  for (const c of configs) {
    const p = programFiles(resolved.ts, root, c);
    if (p.error) return { unknown: true, reason: `tsconfig unreadable, ${p.error}`, findings: [] };
    for (const t of p.tolerated || []) advisories.push(`the compiler reports an error in this config that does not change which files it covers: ${t}`);
    for (const f of p.files) covered.add(f);
  }

  // Rule 2: twins. Grouped by directory plus case-folded stem, exactly the key TypeScript's
  // extension-priority rule and a case-insensitive file system both use.
  const twinOf = new Map();
  const groups = new Map();
  for (const f of tsFiles) {
    if (!/\.(ts|tsx)$/i.test(f)) continue;
    const key = f.replace(/\.(ts|tsx)$/i, '').toLowerCase();
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(f);
  }
  for (const group of groups.values()) {
    const tsx = group.filter((f) => /\.tsx$/i.test(f));
    const plain = group.filter((f) => /\.ts$/i.test(f));
    if (!tsx.length || !plain.length) continue;
    for (const dropped of tsx) {
      const keeper = plain[0];
      const sameCase = basename(keeper).replace(/\.ts$/i, '') === basename(dropped).replace(/\.tsx$/i, '');
      twinOf.set(dropped, { keeper, sameCase });
    }
  }

  for (const f of tsFiles) {
    const twin = twinOf.get(f);
    const isCovered = covered.has(f.replace(/\\/g, '/').toLowerCase());
    // The extension-priority rule only thins WILDCARD matches: a name listed in `files` is kept
    // whatever sits beside it (measured 2026-09-07, both twins in the program). So a same-case twin
    // is a finding only while it is outside the program. A case-only twin is reported whatever
    // this host says, because a case-sensitive host says something else, and that disagreement is
    // the finding.
    const twinFinding = Boolean(twin) && (!twin.sameCase || !isCovered);
    if (!twinFinding && isCovered) continue;
    if (ignoredByFlag(f, ignorePatterns) || hasIgnoreMarker(join(root, f))) continue;
    if (twinFinding) {
      findings.push({
        file: f, kind: 'twin',
        why: twin.sameCase
          ? `shares its name with ${twin.keeper}, and tsc keeps the .ts and drops this .tsx from the program`
          : `shares its name with ${twin.keeper} except for letter case: dropped by tsc on Windows and macOS, checked on Linux, so local and CI disagree`,
      });
      continue;
    }
    findings.push({ file: f, kind: 'uncovered', why: 'outside every tsconfig in the repo, so tsc never checks it' });
  }

  return finish(root, findings, advisories, tsFiles.length, configs.length, covered.size, tracked);
}

// The advisory is computed on every complete scan, clean or not, because it is about the repo and
// not about the findings.
function finish(root, findings, advisories, trackedCount, configCount, coveredCount, tracked) {
  // Every tracked package.json outside node_modules, not only the root one: in a workspace the
  // root's scripts often delegate, and the member that really runs tsc would otherwise draw the
  // note on every scan.
  const manifests = tracked.filter((f) => /(^|\/)package\.json$/.test(f) && !NODE_MODULES_RE.test(f));
  if (manifests.length) {
    // One unreadable manifest (a fixture with deliberately broken JSON, say) skips itself rather
    // than silencing the note for the whole repo.
    const scripts = [];
    for (const m of manifests) {
      try { scripts.push(...Object.values(JSON.parse(readFileSync(join(root, m), 'utf8')).scripts || {})); } catch { /* skip it */ }
    }
    // `tsc` is not the only type checker a product runs: svelte-check and vue-tsc read the same
    // tsconfig and check the same files. Matching the literal `tsc` alone told reddit-scanner, whose
    // CI runs `svelte-check --tsconfig ./tsconfig.json`, that nothing type-checks it (measured
    // 2026-09-07 while re-deriving the survey). `\btsc\b` already matches inside `vue-tsc`
    // on a word boundary, so only svelte-check needs naming.
    if (!scripts.some((v) => /\btsc\b|svelte-check/.test(String(v)))) {
      advisories.push('no package.json script runs a type checker (tsc, vue-tsc or svelte-check), so this coverage is of a check nothing executes');
    }
  }
  return { ok: findings.length === 0, findings, advisories, tracked: trackedCount, configs: configCount, covered: coveredCount };
}

// --- reporting ---------------------------------------------------------------------------------

function report(res) {
  if (res.unknown) {
    console.error(`[tsconfig-coverage] INCOMPLETE: ${res.reason}`);
    console.error('[tsconfig-coverage] Refusing to report clean on a scan that did not run.');
    console.error('[tsconfig-coverage] Fix the cause named above and re-run: install the dependencies for a missing compiler, repair a rejected tsconfig, or keep a fixture path out with --ignore <glob>.');
    for (const f of res.findings || []) console.error(`  ${f.file}  <- ${f.why}`);
    return (res.findings || []).length ? 1 : 2;
  }
  for (const a of res.advisories || []) console.log(`[tsconfig-coverage] note: ${a}`);
  if (res.ok) {
    console.log(`[tsconfig-coverage] clean (${res.tracked} TypeScript file(s) tracked, ${res.configs} tsconfig(s), ${res.covered} file(s) in their programs)`);
    return 0;
  }
  console.error(`[tsconfig-coverage] ${res.findings.length} finding(s):`);
  for (const f of res.findings) console.error(`  ${f.file}  <- ${f.why}`);
  if (res.findings.some((f) => f.kind === 'uncovered')) {
    console.error('');
    console.error('OUTSIDE EVERY TSCONFIG: add its folder to `include` (or a `*.config.ts` glob for root');
    console.error('config files), or give it a tsconfig of its own. If it genuinely must stay out, say so');
    console.error('where a reader sees it: `// tsconfig-coverage: ignore <reason>` in its first lines, or');
    console.error('`--ignore <glob>` on the script line in package.json.');
  }
  if (res.findings.some((f) => f.kind === 'twin')) {
    console.error('');
    console.error('A TWIN is a rename, not a config change. Two files whose names differ only in .ts');
    console.error('against .tsx (or only in letter case) are one name to TypeScript, and it keeps the .ts.');
  }
  if (res.findings.some((f) => f.kind === 'no-tsconfig')) {
    console.error('');
    console.error('NO TSCONFIG: add one with an `include` that names every folder holding TypeScript, and');
    console.error('a script that runs `tsc --noEmit`. A Deno project needs a tracked deno.json instead.');
  }
  return 1;
}

// --- selftest ----------------------------------------------------------------------------------
//
// EVERY RULE GETS ITS OWN ISOLATED CONTROL, and each fixture is built so exactly one rule can fire.
// No commits anywhere: everything the gate reads about tracking comes from `git ls-files`, which
// reads the index, so staging alone builds every state these controls need.

function fixture(files, opts = {}) {
  const root = mkdtempSync(join(tmpdir(), 'tsconfig-coverage-st-'));
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
  for (const f of opts.force || []) git(['add', '-f', '--', f], root);
  // Staged first, then removed from the working tree: the state a developer is in between deleting
  // a file and staging that deletion.
  for (const f of opts.deleteAfterStage || []) rmSync(join(root, f));
  // -z here too: without it git quotes a path with a space or a non-ASCII letter, and the check
  // below then reports that path as unstaged. The first breaking test with such a path threw
  // here rather than reaching the gate (2026-09-07).
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

const TSCONFIG_SRC = '{ "compilerOptions": { "strict": true, "noEmit": true, "jsx": "react-jsx" }, "include": ["src"] }\n';
const SRC_FILE = 'export const one: number = 1;\n';

function selftest() {
  // The fixtures have no node_modules, so the compiler comes from wherever this selftest runs,
  // or from the override. A host with neither cannot judge these controls and says so per line.
  const host = resolveTypescript(process.cwd(), process.env.TSCONFIG_COVERAGE_TS || undefined);
  const SEP = '  ::  ';
  let failures = 0;
  const emit = (ok, name, detail) => {
    if (!ok) failures++;
    console.log(`  ${ok ? 'ok     ' : 'FAIL   '} ${name}${SEP}${detail}`);
  };

  const cases = [];
  const base = { 'tsconfig.json': TSCONFIG_SRC, 'src/index.ts': SRC_FILE };

  // NEGATIVE control: a correct repo must pass, or nothing else here means anything.
  cases.push({ name: 'a fully covered repo passes', files: base, expect: 'clean' });
  cases.push({ name: 'a repo with no TypeScript files needs nothing', files: { 'src/main.js': 'export const x = 1;\n' }, expect: 'clean' });

  // Rule 1, in the three shapes measured on real repos.
  cases.push({
    name: 'a test folder outside include is a finding',
    files: { ...base, 'e2e/app.spec.ts': SRC_FILE },
    expect: 'fail', expectWhy: /e2e\/app\.spec\.ts <- outside every tsconfig/,
  });
  cases.push({
    name: 'a root config file outside include is a finding',
    files: { ...base, 'vitest.config.ts': SRC_FILE },
    expect: 'fail', expectWhy: /vitest\.config\.ts <- outside every tsconfig/,
  });
  cases.push({
    name: 'a file the tsconfig EXCLUDES is a finding too',
    files: { ...base, 'tsconfig.json': TSCONFIG_SRC.replace('"include": ["src"]', '"include": ["src"], "exclude": ["**/*.test.ts"]'), 'src/a.test.ts': SRC_FILE },
    expect: 'fail', expectWhy: /src\/a\.test\.ts <- outside every tsconfig/,
  });
  cases.push({
    name: 'a second tsconfig covering the file makes it clean',
    files: { ...base, 'tsconfig.test.json': TSCONFIG_SRC.replace('["src"]', '["tests"]'), 'tests/a.test.ts': SRC_FILE },
    expect: 'clean',
  });
  // The base lives under a name TSCONFIG_RE does not match, so the ONLY route to its include is
  // through `extends`. A first version named it tsconfig.base.json, which the gate parsed on its
  // own, so the control passed whether extends worked or not, and the mutation harness said so.
  // It asserts the negative space on purpose: an `extends` that were silently dropped would leave
  // the child with no include at all, which TypeScript reads as `**/*`, and e2e would be covered.
  cases.push({
    name: 'an include inherited through extends is respected, not widened to everything',
    files: {
      'config/base.json': TSCONFIG_SRC.replace('["src"]', '["../src"]'),
      'tsconfig.json': '{ "extends": "./config/base.json" }\n',
      'src/index.ts': SRC_FILE,
      'e2e/app.spec.ts': SRC_FILE,
    },
    expect: 'fail', expectWhy: /e2e\/app\.spec\.ts <- outside/, forbidWhy: /src\/index\.ts/,
  });
  // The extends control above proves the resolved case. This one proves the UNRESOLVED case, which
  // is the dangerous direction: TypeScript answers a missing parent with an empty include, an empty
  // include is `**/*`, and a gate that reads only fileNames then calls a rejected config complete.
  cases.push({
    name: 'a tsconfig whose extends target is missing is UNKNOWN, not clean',
    files: { 'tsconfig.json': '{ "extends": "./missing.json" }\n', 'src/index.ts': SRC_FILE, 'e2e/app.spec.ts': SRC_FILE },
    expect: 'unknown',
  });
  cases.push({
    name: 'an include that matches nothing still names the files it misses',
    files: { ...base, 'tsconfig.json': TSCONFIG_SRC.replace('["src"]', '["nothing"]') },
    expect: 'fail', expectWhy: /src\/index\.ts <- outside every tsconfig/,
  });
  // Breaking tests from the 2026-09-07 review, the shapes real repos ship that the fixtures above
  // did not: a path git would quote without -z, a config that is not at the root, and the
  // solution-style root Vite scaffolds (files: [] plus references), which must not read as
  // "no inputs" or as rejected.
  cases.push({
    name: 'a path with a space and a non-ASCII letter is matched, not quoted',
    files: { ...base, 'src/my dir/café.ts': SRC_FILE },
    expect: 'clean',
  });
  cases.push({
    name: 'a tsconfig below the root resolves its include from its own directory',
    files: { 'packages/app/tsconfig.json': TSCONFIG_SRC, 'packages/app/src/index.ts': SRC_FILE },
    expect: 'clean',
  });
  cases.push({
    name: 'a solution-style root with files [] and references is clean, not no-inputs',
    files: {
      'tsconfig.json': '{ "files": [], "references": [{ "path": "./tsconfig.app.json" }] }\n',
      'tsconfig.app.json': TSCONFIG_SRC,
      'src/index.ts': SRC_FILE,
    },
    expect: 'clean',
  });
  cases.push({
    name: 'a tracked file deleted on disk is a pending deletion, not a coverage gap',
    files: { ...base, 'e2e/app.spec.ts': SRC_FILE },
    deleteAfterStage: ['e2e/app.spec.ts'],
    expect: 'clean',
  });
  cases.push({
    name: 'a declaration file outside include is not demanded',
    files: { ...base, 'types/globals.d.ts': 'declare const FLAG: boolean;\n' },
    expect: 'clean',
  });
  cases.push({
    name: 'a vendored node_modules file is never counted',
    files: { ...base, 'node_modules/vendored/index.ts': SRC_FILE },
    force: ['node_modules/vendored/index.ts'],
    expect: 'clean',
  });

  // Exemptions, both kinds, each visible.
  cases.push({
    name: 'the in-file ignore marker exempts a file',
    files: { ...base, 'e2e/app.spec.ts': '// tsconfig-coverage: ignore (Playwright runs it under its own config)\n' + SRC_FILE },
    expect: 'clean',
  });
  cases.push({
    name: 'the marker is read through CRLF line endings',
    files: { ...base, 'e2e/app.spec.ts': '\r\n// tsconfig-coverage: ignore (CRLF checkout)\r\n' + SRC_FILE },
    expect: 'clean',
  });
  cases.push({
    name: 'the marker only counts in the first five lines',
    files: { ...base, 'e2e/app.spec.ts': '\n\n\n\n\n// tsconfig-coverage: ignore too late\n' + SRC_FILE },
    expect: 'fail', expectWhy: /e2e\/app\.spec\.ts <- outside/,
  });
  cases.push({
    name: 'an --ignore glob exempts matching paths',
    files: { ...base, 'supabase/functions/hello/index.ts': SRC_FILE },
    ignore: ['supabase/**'],
    expect: 'clean',
  });
  cases.push({
    // Without the exemption the fixture config's `../../**/*` include covers e2e and the scan reads
    // clean, which is the false-clean shape this gate exists to refuse.
    name: 'an --ignore glob keeps a fixture tsconfig out of the union',
    files: { ...base, 'e2e/app.spec.ts': SRC_FILE, 'test/fixtures/tsconfig.json': '{ "include": ["../../**/*"] }\n' },
    ignore: ['test/fixtures/**'],
    expect: 'fail', expectWhy: /e2e\/app\.spec\.ts <- outside/,
  });
  cases.push({
    name: 'an --ignore glob that matches nothing is called out as stale',
    files: { ...base, 'e2e/app.spec.ts': SRC_FILE },
    ignore: ['e2eee/**'],
    expect: 'fail', expectNote: /--ignore e2eee\/\*\* matched no tracked file/, forbidNote: /renamed or removed folder leaves/,
  });
  cases.push({
    name: 'an --ignore glob that does match is not called stale',
    files: { ...base, 'supabase/functions/hello/index.ts': SRC_FILE },
    ignore: ['supabase/**'],
    expect: 'clean', forbidNote: /matched no tracked file/,
  });
  cases.push({
    name: 'ignoring every tsconfig says so rather than claiming none exists',
    files: base,
    ignore: ['tsconfig.json'],
    expect: 'fail', expectWhy: /every tracked tsconfig \(1\) is behind an --ignore glob/,
  });
  cases.push({
    name: 'an --ignore glob does not cross directories with a single star',
    files: { ...base, 'supabase/functions/hello/index.ts': SRC_FILE },
    ignore: ['supabase/*'],
    expect: 'fail', expectWhy: /supabase\/functions\/hello\/index\.ts <- outside/,
  });

  // Rule 2, both twin shapes.
  cases.push({
    name: 'a .tsx twin of a .ts is reported as dropped, not merely uncovered',
    files: { ...base, 'src/Card.test.ts': SRC_FILE, 'src/Card.test.tsx': SRC_FILE },
    expect: 'fail', expectWhy: /src\/Card\.test\.tsx <- shares its name with src\/Card\.test\.ts, and tsc keeps the \.ts/,
  });
  cases.push({
    // `files` entries are literal and skip the extension-priority rule, so both twins are in the
    // program here and there is nothing to rename for tsc's sake.
    name: 'a .tsx twin listed explicitly in files is in the program and not reported',
    files: { 'tsconfig.json': '{ "files": ["src/index.ts", "src/Card.test.ts", "src/Card.test.tsx"] }\n', 'src/index.ts': SRC_FILE, 'src/Card.test.ts': SRC_FILE, 'src/Card.test.tsx': SRC_FILE },
    expect: 'clean',
  });
  cases.push({
    name: 'an unreadable fixture manifest does not silence the no-tsc note',
    files: { ...base, 'package.json': '{ "scripts": { "build": "vite build" } }\n', 'test/fixtures/package.json': '{ not json\n' },
    expect: 'clean', expectNote: /no package\.json script runs a type checker/,
  });
  cases.push({
    name: 'a twin differing only by letter case names the local and CI disagreement',
    files: { ...base, 'src/grid.test.ts': SRC_FILE, 'src/Grid.test.tsx': SRC_FILE },
    expect: 'fail', expectWhy: /src\/Grid\.test\.tsx <- shares its name with src\/grid\.test\.ts except for letter case/,
  });

  // Rule 3.
  cases.push({
    name: 'tracked TypeScript with no tsconfig at all is a finding',
    files: { 'src/index.ts': SRC_FILE },
    expect: 'fail', expectWhy: /no tsconfig exists/,
  });
  cases.push({
    name: 'a Deno project without a tsconfig is clean, with a note saying why',
    files: { 'deno.json': '{}\n', 'src/index.ts': SRC_FILE },
    expect: 'clean', expectNote: /a Deno project/,
  });

  // The advisory, and its absence when a script does run tsc.
  cases.push({
    name: 'a repo whose scripts never run tsc gets a note, not a finding',
    files: { ...base, 'package.json': '{ "scripts": { "build": "vite build" } }\n' },
    expect: 'clean', expectNote: /no package\.json script runs a type checker/,
  });
  cases.push({
    name: 'a repo with a tsc script gets no such note',
    files: { ...base, 'package.json': '{ "scripts": { "typecheck": "tsc --noEmit" } }\n' },
    expect: 'clean', forbidNote: /no package\.json script runs a type checker/,
  });
  cases.push({
    name: 'a svelte-check script counts as a type checker',
    files: { ...base, 'package.json': '{ "scripts": { "check": "svelte-check --tsconfig ./tsconfig.json" } }\n' },
    expect: 'clean', forbidNote: /no package\.json script runs a type checker/,
  });
  cases.push({
    name: 'a workspace member script that runs tsc silences the note',
    files: { ...base, 'package.json': '{ "scripts": { "build": "npm run build -ws" } }\n', 'packages/app/package.json': '{ "scripts": { "typecheck": "tsc --noEmit" } }\n' },
    expect: 'clean', forbidNote: /no package\.json script runs a type checker/,
  });

  // UNKNOWN, never clean.
  cases.push({ name: 'a non-repository is UNKNOWN, not clean', noRepo: true, expect: 'unknown' });
  cases.push({
    name: 'no resolvable TypeScript is UNKNOWN, not clean',
    files: base, noCompiler: true,
    expect: 'unknown',
  });
  cases.push({
    // Measured on TypeScript 5.9.3: an unknown option is TS5023 and a bad option VALUE is TS6046,
    // both Error, both leaving fileNames correct. Refusing on them would hide the coverage answer
    // behind a typo in compilerOptions.
    name: 'a compilerOptions typo is a note, not a refusal, and coverage still answers',
    files: { ...base, 'tsconfig.json': '{ "compilerOptions": { "notAnOption": true }, "include": ["src"] }\n', 'e2e/app.spec.ts': SRC_FILE },
    expect: 'fail', expectWhy: /e2e\/app\.spec\.ts <- outside/, expectNote: /TS5023 Unknown compiler option/,
  });
  cases.push({
    name: 'a bad compilerOptions VALUE is a note too',
    files: { ...base, 'tsconfig.json': '{ "compilerOptions": { "target": "nonsense" }, "include": ["src"] }\n' },
    expect: 'clean', expectNote: /TS6046/,
  });
  cases.push({
    name: 'an unreadable tsconfig is UNKNOWN, not clean',
    files: { 'tsconfig.json': '{ this is not json\n', 'src/index.ts': SRC_FILE },
    expect: 'unknown',
  });

  // Exit-code mapping, asserted on report() with hand-built verdicts.
  cases.push({ name: 'a clean scan exits 0', exitFor: { ok: true, findings: [], advisories: [], tracked: 1, configs: 1, covered: 1 }, expectExit: 0 });
  cases.push({ name: 'a scan with findings exits 1', exitFor: { ok: false, findings: [{ file: 'x.ts', kind: 'uncovered', why: 'x' }], advisories: [] }, expectExit: 1 });
  cases.push({ name: 'an INCOMPLETE scan with no findings exits 2', exitFor: { unknown: true, reason: 'x', findings: [] }, expectExit: 2 });
  cases.push({ name: 'an INCOMPLETE scan WITH findings exits 1, not 2', exitFor: { unknown: true, reason: 'x', findings: [{ file: 'x.ts', kind: 'uncovered', why: 'x' }] }, expectExit: 1 });
  cases.push({ name: 'an unknown flag is refused, not silently ignored', files: base, mainArgv: ['node', 'gate', '--fix'], expectExit: 2 });
  cases.push({ name: '--ignore without a glob is refused', files: base, mainArgv: ['node', 'gate', '--ignore'], expectExit: 2 });

  if (host.error) {
    for (const c of cases) console.log(`  skip    ${c.name}${SEP}no TypeScript on this host to resolve fixtures with`);
    console.log(`[tsconfig-coverage] selftest: 0/${cases.length} controls could run (${host.error})`);
    return 2;
  }

  const roots = [];
  function runCase(c) {
    if (c.exitFor) {
      const code = muted(() => report(c.exitFor));
      emit(code === c.expectExit, c.name, `expected exit ${c.expectExit}, got ${code}`);
      return;
    }
    let root;
    let res;
    if (c.mainArgv) {
      root = fixture(c.files, { force: c.force, deleteAfterStage: c.deleteAfterStage });
      roots.push(root);
      const cwd = process.cwd();
      let code;
      try {
        process.chdir(root);
        code = muted(() => main(c.mainArgv, { tsDir: host.from }));
      } finally {
        process.chdir(cwd);
      }
      emit(code === c.expectExit, c.name, `expected exit ${c.expectExit}, got ${code}`);
      return;
    }
    if (c.noRepo) {
      root = mkdtempSync(join(tmpdir(), 'tsconfig-coverage-norepo-'));
      roots.push(root);
      res = scan(root, { tsDir: host.from });
    } else {
      root = fixture(c.files, { force: c.force, deleteAfterStage: c.deleteAfterStage });
      roots.push(root);
      // The no-compiler control hands the scan a directory that holds no TypeScript package, rather
      // than nothing at all: given nothing, the scan would fall back to the environment override or
      // walk up from the temp directory, and either could find a real compiler and turn UNKNOWN
      // into clean on the one host where that matters least, the developer's own.
      res = scan(root, { ignore: c.ignore, tsDir: c.noCompiler ? join(root, 'no-typescript-here') : host.from });
    }
    const got = res.unknown ? 'unknown' : (res.ok ? 'clean' : 'fail');
    const whys = (res.findings || []).map((f) => `${f.file} <- ${f.why}`).join(' | ');
    const notes = (res.advisories || []).join(' | ');
    let ok = got === c.expect;
    let detail = `expected ${c.expect}, got ${got}${res.unknown ? ` (${res.reason})` : ''}`;
    if (ok && c.expectWhy && !c.expectWhy.test(whys)) { ok = false; detail = `expected a finding matching ${c.expectWhy}, got: ${whys || '(none)'}`; }
    if (ok && c.forbidWhy && c.forbidWhy.test(whys)) { ok = false; detail = `produced a finding matching ${c.forbidWhy}, which this case forbids: ${whys}`; }
    if (ok && c.expectNote && !c.expectNote.test(notes)) { ok = false; detail = `expected a note matching ${c.expectNote}, got: ${notes || '(none)'}`; }
    if (ok && c.forbidNote && c.forbidNote.test(notes)) { ok = false; detail = `produced a note matching ${c.forbidNote}, which this case forbids: ${notes}`; }
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
  console.log(`[tsconfig-coverage] selftest: ${cases.length - failures}/${cases.length} controls passed`);
  return failures === 0 ? 0 : 1;
}

// --- entry point -------------------------------------------------------------------------------

function main(argv, opts = {}) {
  const args = argv.slice(2);
  const ignore = [];
  const unknownFlags = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--selftest') continue;
    if (a === '--ignore') {
      const g = args[i + 1];
      if (!g || g.startsWith('-')) {
        console.error('[tsconfig-coverage] --ignore needs a glob, for example --ignore supabase/**');
        return 2;
      }
      ignore.push(g);
      i++;
      continue;
    }
    if (a.startsWith('-')) unknownFlags.push(a);
  }
  // An unrecognised flag is never silently ignored: `--fix` would otherwise run a plain check and
  // print clean on a repo the operator believes it changed.
  if (unknownFlags.length) {
    console.error(`[tsconfig-coverage] unknown flag(s): ${unknownFlags.join(', ')}`);
    console.error('[tsconfig-coverage] usage: check-tsconfig-coverage.mjs [--ignore <glob>]... | --selftest');
    return 2;
  }
  if (args.includes('--selftest')) return selftest();
  return report(scan(process.cwd(), { ignore, tsDir: opts.tsDir }));
}

// No filename guard around this, on purpose: the mutants harness copies this file to
// `mutant-<n>.mjs` and runs it, and a guard keyed on this file's own name would make every mutant
// exit without running a single control, which the harness would then score as a crash.
process.exit(main(process.argv));
