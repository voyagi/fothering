#!/usr/bin/env node
// check-env-example.mutants.mjs - prove the gate's --selftest controls are NON-VACUOUS.
//
// Each mutation disables exactly ONE rule of check-env-example.mjs; the gate's own --selftest must
// then go RED, and specifically the control the mutation NAMES must go red. A mutation that leaves
// --selftest green is an ESCAPE: it means the control named after that rule asserts nothing, which
// is the "a passing suite proved nothing" failure the scaffold-gates carry mutant harnesses to
// catch. It also checks the REVERSE direction: a control no mutation can redden is never examined
// at all and is reported as a gap.
//
// The runner below is deliberately the same shape as check-client-secrets.mutants.mjs. These files
// are copied into product repos ONE AT A TIME, so a shared helper module would be a third file and
// a coupling that breaks whenever only two of the three are copied. The duplication is the cost of
// each gate being independently portable, and it is the existing convention.
//
// RUNTIME. The gate's selftest builds a real git repository per control, so one run is tens of
// seconds and the full sweep is minutes, not seconds. Mutations therefore run CONCURRENTLY, and
// `--only <substring>` re-proves a single rule after editing it. Run the full sweep once at
// install; use --only while working on a rule.
//
// Usage:  node scripts/check-env-example.mutants.mjs [--only <substring>] [--jobs <n>]
// Exit codes: 0 all mutations caught, 1 an escape or an unproven control, 2 the baseline is not green.

import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir, cpus } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);

const here = dirname(fileURLToPath(import.meta.url));
const SRC = join(here, 'check-env-example.mjs');
// LINE ENDINGS ARE NORMALISED, and the omission of this one call is why. Several anchors below
// span two lines, so their `find` strings carry a `\n`. On any checkout with core.autocrlf=true,
// which is the Windows default and therefore what most product repos these files are copied into
// will have, the source arrives with CRLF and not one of those anchors can match. The harness then
// reports them as stale and their controls as unproven, which reads as anchor drift and sends the
// reader hunting through the gate for a change nobody made. Measured 2026-09-05: the same commit
// scored 74 of 74 caught in an LF checkout and 3 escaped with 2 controls unproven in a CRLF one.
// The three sibling harnesses in this folder all already did this; this file was the only one that
// did not, despite being written to their shape.
const src = readFileSync(SRC, 'utf8').replace(/\r\n/g, '\n');

// REWORD A MESSAGE, RE-RUN THE FULL SWEEP. Controls assert on message TEXT, which is the point,
// since a rule that fires with the wrong explanation is half broken. The cost is that rewording a
// message silently frees every control whose regex quoted the old words: they then pass whatever
// the gate does, and a vacuous control still prints ok in the selftest. Only reverse coverage says
// so. Measured 2026-09-07 on the sibling tsconfig gate, where one reworded advisory freed three.
//
// `find` must be a UNIQUE substring of the gate source; `repl` disables that one rule.
//
// `expect` NAMES the control this mutation must turn red, and it is the point rather than
// documentation. Without it the check would be "did SOME control go red", which is far weaker than
// it reads: these fixtures share a shape heavily (most of them read DATABASE_URL through
// process.env), so a rule whose own control had been deleted would still score as caught off a
// neighbour's control, and the harness would print full coverage for a rule nothing tests.
const MUTATIONS = [
  // --- one per read idiom. Each fixture uses its idiom alone, so these bind one to one. ---
  { name: 'read: node process.env.NAME', expect: 'read idiom detected: node process.env.NAME', find: '/\\bprocess\\.env\\.([A-Z][A-Z0-9_]*)\\b/g', repl: '/\\bZZNEVERprocess\\.env\\.([A-Z][A-Z0-9_]*)\\b/g' },
  { name: 'read: node process.env["NAME"]', expect: 'read idiom detected: node process.env["NAME"]', find: '/\\bprocess\\.env\\[\\s*[\'"`]([A-Z][A-Z0-9_]*)[\'"`]\\s*\\]/g', repl: '/\\bZZNEVERprocess\\.env\\[\\s*[\'"`]([A-Z][A-Z0-9_]*)[\'"`]\\s*\\]/g' },
  { name: 'read: js destructured env', expect: 'read idiom detected: js destructured env', find: 'many: true', repl: 'many: false' },
  { name: 'read: vite import.meta.env.NAME', expect: 'read idiom detected: vite import.meta.env.NAME', find: '/\\bimport\\.meta\\.env\\.([A-Z][A-Z0-9_]*)\\b/g', repl: '/\\bZZNEVERimport\\.meta\\.env\\.([A-Z][A-Z0-9_]*)\\b/g' },
  { name: 'read: deno Deno.env.get', expect: 'read idiom detected: deno Deno.env.get', find: '/\\bDeno\\.env\\.(?:get|has)\\(', repl: '/\\bZZNEVERDeno\\.env\\.(?:get|has)\\(' },
  // The Workers rule was REMOVED from the gate, so its mutation is gone too and an ADD-mutation
  // takes its place below: putting the pattern back must redden the control that says a Workers
  // binding is not a dotenv key. A removed rule still needs a control, or nothing stops it
  // being reintroduced by someone who reads the miss and not the reason.
  // ONE mutation for the shared getenv pattern. It reddens all three of the language controls that
  // exercise it, and it NAMES one of them; the other two are marked proven by the reverse-coverage
  // pass, which is honest, where three near-identical mutations were not (two of them could be
  // deleted with the suite staying green, because this one pattern was doing the work).
  { name: 'read: getenv(NAME), any language', expect: 'read idiom detected: php getenv (shared getenv pattern)', find: '/\\bgetenv\\(\\s*', repl: '/\\bZZNEVERgetenv\\(\\s*' },
  { name: 'read: php $_ENV[NAME]', expect: 'read idiom detected: php $_ENV', find: '/\\$_ENV\\[\\s*', repl: '/\\$ZZNEVER_ENV\\[\\s*' },
  { name: 'read: python os.environ', expect: 'read idiom detected: python os.environ', find: '/\\bos\\.environ(?:\\.get)?\\(?\\[?', repl: '/\\bZZNEVERos\\.environ(?:\\.get)?\\(?\\[?' },
  { name: 'read: go os.Getenv', expect: 'read idiom detected: go os.Getenv', find: '/\\bos\\.(?:Getenv|LookupEnv)\\(', repl: '/\\bZZNEVERos\\.(?:Getenv|LookupEnv)\\(' },
  { name: 'read: ruby ENV', expect: 'read idiom detected: ruby ENV', find: '/\\bENV(?:\\.fetch)?\\(?\\[?', repl: '/\\bZZNEVERENV(?:\\.fetch)?\\(?\\[?' },
  { name: 'read: rust env::var', expect: 'read idiom detected: rust env::var', find: '/\\benv::var(?:_os)?\\(', repl: '/\\bZZNEVERenv::var(?:_os)?\\(' },
  { name: 'read: rust env! macro', expect: 'read idiom detected: rust env! macro', find: '/\\b(?:option_env|env)!\\(', repl: '/\\bZZNEVER(?:option_env|env)!\\(' },
  { name: 'read: dotnet Environment.GetEnvironmentVariable', expect: 'read idiom detected: dotnet Environment.GetEnvironmentVariable', find: '/\\bEnvironment\\.GetEnvironmentVariable\\(', repl: '/\\bZZNEVEREnvironment\\.GetEnvironmentVariable\\(' },
  { name: 'read: dart Platform.environment', expect: 'read idiom detected: dart Platform.environment', find: '/\\bPlatform\\.environment\\[', repl: '/\\bZZNEVERPlatform\\.environment\\[' },
  { name: 'read: dart String.fromEnvironment', expect: 'read idiom detected: dart String.fromEnvironment', find: '/\\bString\\.fromEnvironment\\(', repl: '/\\bZZNEVERString\\.fromEnvironment\\(' },
  { name: 'read: t3 createEnv schema keys', expect: 'read idiom detected: t3 createEnv schema key', find: 'if (CREATE_ENV_RE.test(text)) {', repl: 'if (false) {' },

  // --- rule 1: completeness ---
  { name: 'a commented line does not declare a key', expect: 'a COMMENTED key does not declare anything', find: '  if (/^\\s*#/.test(line)) return null;', repl: '  line = line.replace(/^\\s*#\\s*/, \'\');' },
  { name: 'the gate-ignore directive is honoured', expect: 'the gate-ignore directive exempts a key', find: '/^\\s*#\\s*gate-ignore:\\s*(.+)$/i', repl: '/^\\s*#\\s*ZZNEVER-gate-ignore:\\s*(.+)$/i' },
  { name: 'runtime-supplied vars are not demanded', expect: 'a runtime-supplied system var needs no declaration', find: '.filter((n) => !SYSTEM_VARS.has(n))', repl: '.filter(() => true)' },
  { name: 'a missing example file is reported as one finding, naming the file', expect: 'no example file at all, while the code reads env, is a finding', find: 'if (missing.length && exampleFiles.length === 0) {', repl: 'if (false) {' },
  { name: 'the missing-key rule fires at all', expect: 'read idiom detected: node process.env.NAME', find: '  const missing = required.filter((n) => !declared.has(n));', repl: '  const missing = [];' },
  // WHOLE STATEMENTS, not prefixes. The first version of these two mutated only the opening of the
  // call, which left the original tail (`)`) closing a call that now needed a `}` too, so both
  // mutants failed to PARSE and the harness correctly refused to score them either way. A mutation
  // must produce running code or it asks no question.
  { name: 'an orphan key stays an advisory, never a finding', expect: 'a declared key nothing reads is an advisory, never a failure', find: 'advisories.push(`${key} is declared but no scanned source reads it (fine if infra or a platform reads it)`);', repl: 'findings.push({ kind: \'orphan\', file: \'x\', why: `${key} is declared but nothing reads it` });' },
  { name: 'a non-canonical example name stays an advisory', expect: 'a non-canonical example name works and only raises an advisory', find: 'advisories.push(`${f} works, but ${CANONICAL_EXAMPLE} is the name the rest of the estate uses`);', repl: 'findings.push({ kind: \'naming\', file: f, why: `${f} is not ${CANONICAL_EXAMPLE}` });' },

  // --- rule 2: a real env file must never be tracked ---
  { name: 'the tracked-env rule fires', expect: 'a tracked .env is a finding', find: '  const trackedEnv = files.filter(isRealEnvFile);', repl: '  const trackedEnv = [];' },
  { name: 'the env-file shape covers suffixed names (.env.local, .env.production)', expect: 'a tracked .env.local is a finding too', find: '/^\\.env(\\.[A-Za-z0-9_-]+)*$/i', repl: '/^\\.env$/i' },
  { name: 'an example file is EXCLUDED from the real-env-file test', expect: 'a tracked .env.example is NOT mistaken for a real env file', find: 'return ENV_BASENAME_RE.test(b) && !EXAMPLE_BASENAME_RE.test(b);', repl: 'return ENV_BASENAME_RE.test(b);' },

  // --- rule 3: .env must be ignored ---
  { name: 'the not-ignored rule fires', expect: 'an unignored .env is a finding', find: '    if (!res.ignored) {', repl: '    if (false) {' },
  { name: 'the ignore check runs PER example directory, not only at the root', expect: 'a subdirectory example file requires its OWN .env to be ignored', find: '  for (const dir of [...exampleDirs].sort()) {', repl: '  for (const dir of [\'.\']) {' },
  { name: 'check-ignore uses --no-index (else a tracked .env reads as unignored too)', expect: 'a tracked .env is not ALSO reported as unignored', find: "git(['check-ignore', '--no-index', '-q', '--', relPath], root);", repl: "git(['check-ignore', '-q', '--', relPath], root);" },

  // --- the untracked-example rule ---
  { name: 'an untracked example file is a finding', expect: 'an example file present on disk but untracked is a finding', find: '    if (!trackedSet.has(f)) {', repl: '    if (false) {' },
  { name: 'example files are discovered on DISK, not only in the index', expect: 'an example file present on disk but untracked is a finding', find: '      if (existsSync(join(root, rel))) diskExamples.push(rel);', repl: '      if (false) diskExamples.push(rel);' },

  // --- rule 4: no real credentials in an example file. One mutation per credential class. ---
  { name: 'value rule: Stripe', expect: 'example value rejected: Stripe secret or restricted key', find: '/\\b[sr]k_(?:live|test)_[0-9A-Za-z]{16,}/', repl: '/\\bZZNEVER[sr]k_(?:live|test)_[0-9A-Za-z]{16,}/' },
  { name: 'value rule: OpenAI or Anthropic', expect: 'example value rejected: OpenAI or Anthropic key', find: '/\\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}/', repl: '/\\bZZNEVERsk-(?:ant-)?[A-Za-z0-9_-]{20,}/' },
  { name: 'value rule: GitHub classic token', expect: 'example value rejected: GitHub classic token', find: '/\\bgh[pousr]_[A-Za-z0-9]{36,}/', repl: '/\\bZZNEVERgh[pousr]_[A-Za-z0-9]{36,}/' },
  { name: 'value rule: GitHub fine-grained PAT', expect: 'example value rejected: GitHub fine-grained PAT', find: '/\\bgithub_pat_[A-Za-z0-9_]{22,}/', repl: '/\\bZZNEVERgithub_pat_[A-Za-z0-9_]{22,}/' },
  { name: 'value rule: AWS access key id', expect: 'example value rejected: AWS access key id', find: '/\\b(?:AKIA|ASIA)[0-9A-Z]{16}\\b/', repl: '/\\bZZNEVER(?:AKIA|ASIA)[0-9A-Z]{16}\\b/' },
  { name: 'value rule: Slack token', expect: 'example value rejected: Slack token', find: '/\\bxox[baprs]-[0-9A-Za-z-]{10,}/', repl: '/\\bZZNEVERxox[baprs]-[0-9A-Za-z-]{10,}/' },
  { name: 'value rule: SendGrid', expect: 'example value rejected: SendGrid API key', find: '/\\bSG\\.[A-Za-z0-9_-]{16,}\\.[A-Za-z0-9_-]{16,}/', repl: '/\\bZZNEVERSG\\.[A-Za-z0-9_-]{16,}\\.[A-Za-z0-9_-]{16,}/' },
  { name: 'value rule: Supabase secret key', expect: 'example value rejected: Supabase secret key', find: '/\\bsb_secret_[A-Za-z0-9_-]{16,}/', repl: '/\\bZZNEVERsb_secret_[A-Za-z0-9_-]{16,}/' },
  { name: 'value rule: GitLab PAT', expect: 'example value rejected: GitLab personal access token', find: '/\\bglpat-[A-Za-z0-9_-]{16,}/', repl: '/\\bZZNEVERglpat-[A-Za-z0-9_-]{16,}/' },
  { name: 'value rule: PEM private key', expect: 'example value rejected: PEM private key', find: '/-----BEGIN (?:RSA |DSA |EC |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY-----/', repl: '/-----ZZNEVERBEGIN PRIVATE KEY-----/' },
  { name: 'value rule: credentials in a URL', expect: 'example value rejected: credentials in a URL', find: '  const u = urlCredentialFinding(value);', repl: '  const u = null;' },
  // The mirror. A URL rule with no placeholder exemption flags the single most common legitimate
  // example value in real repos, a local Postgres string, and the gate would be switched off.
  { name: 'the URL rule exempts a placeholder password', expect: 'a local dev connection string is not a credential leak', find: '  if (PLACEHOLDER_RE.test(m[1])) return null;', repl: '  if (false) return null;' },
  { name: 'value rule: a real JWT', expect: 'example value rejected: a service_role JWT', find: '  const j = jwtFinding(value);', repl: '  const j = null;' },
  { name: 'the JWT rule DECODES the role (else a public anon key is flagged)', expect: 'a public anon JWT is not flagged', find: "  if (jwtRole(m[1]) === 'anon') return null;", repl: '  if (false) return null;' },
  { name: 'value rule: a secret-named key with a filled-in value', expect: 'example value rejected: a secret-named key with a filled-in value', find: '  const s = secretNamedFinding(key, value);', repl: '  const s = null;' },
  { name: 'the secret-named rule exempts a placeholder', expect: 'a secret-named key with a placeholder is fine', find: '  if (PLACEHOLDER_RE.test(value)) return null;', repl: '  if (false) return null;' },
  { name: 'the secret-named rule is restricted to secret-named keys', expect: 'a long value under a NON-secret key name is not flagged', find: '  if (!SECRET_KEY_NAME_RE.test(key)) return null;', repl: '  if (false) return null;' },
  // Reverts the placeholder vocabulary to the bare-substring test it shipped with, which is the
  // exact defect measured on 2026-09-05. Anchored on the whole bounded group rather than on one
  // lookaround: dropping only the trailing boundary still catches "Ku7ThereIsNoKey99", so a
  // one-sided mutation would pass while proving nothing about the rule it names.
  { name: 'the placeholder vocabulary matches whole tokens, not substrings', expect: 'a placeholder word buried inside a credential does not excuse it', find: '(?<![A-Za-z0-9])(?:change[_-]?me|your|yourkey|replace|example|placeholder|todo|dummy|fake|sample|here|localhost|127\\.0\\.0\\.1|x{3,})(?![A-Za-z0-9])', repl: '(?:change[_-]?me|your|yourkey|replace|example|placeholder|todo|dummy|fake|sample|here|localhost|127\\.0\\.0\\.1|x{3,})' },

  { name: 'a credential-shaped run is not excused by a placeholder token inside it', expect: 'a placeholder word between base64 characters does not excuse a credential either', find: '  if (credentialShaped(value)) return FILLED_IN;', repl: '  ;' },
  { name: 'credential-shaped needs a mixed letter-and-digit segment, not any digit', expect: 'a title-case placeholder with a year in it is still a placeholder', find: '      if (seg.length >= 4 && /\\d/.test(seg) && letters.size >= 2) return true;', repl: '      if (/\\d/.test(seg)) return true;' },
  { name: 'a mixed segment needs two distinct letters, a mask repeats one', expect: 'a UUID mask placeholder is still a placeholder', find: '      if (seg.length >= 4 && /\\d/.test(seg) && letters.size >= 2) return true;', repl: '      if (seg.length >= 4 && /\\d/.test(seg) && letters.size >= 1) return true;' },

  // --- scanning scope, both directions ---
  // Anchored on the ONE clause it disables rather than on the whole line. The whole-line version
  // went stale the moment two more exclusions joined that condition, and a stale anchor is
  // reported as a failure rather than quietly skipped, which is how this was caught.
  { name: 'dependency and build trees are skipped', expect: 'dependency and build trees are not scanned for reads', find: 'SKIP_PATH_RE.test(f) || ', repl: '' },
  { name: 'only source extensions are scanned (docs are not)', expect: 'documentation is not scanned for reads', find: '    if (!SOURCE_EXT_RE.test(f)) continue;', repl: '    if (false) continue;' },
  // Both of these guard against a measured false positive on a real product repo, so both get a
  // mutation: a false positive is the failure mode that gets a gate switched off.
  { name: 'test files do not drive requirements', expect: 'a var read only in a test file is not demanded', find: ' || TEST_PATH_RE.test(f)', repl: '' },
  { name: 'OS-supplied Windows vars are exempt', expect: 'an OS-supplied Windows variable is not demanded', find: "  'PATHEXT', 'COMSPEC'", repl: "  'ZZNEVER_PATHEXT', 'COMSPEC'" },
  { name: "Vite's built-in import.meta.env fields are exempt", expect: "Vite's built-in import.meta.env fields are not demanded", find: "  'DEV', 'PROD', 'MODE', 'BASE_URL', 'SSR',", repl: "  'ZZNEVER_DEV', 'PROD', 'MODE', 'BASE_URL', 'SSR'," },
  { name: "the scaffold's own tooling is not scanned", expect: "the scaffold's own tooling does not drive the product's example file", find: ' || SCAFFOLD_TOOL_RE.test(f)', repl: '' },
  // An ADD-mutation, and the only one here. Putting the Cloudflare rule back must redden the
  // control that says a binding is not a dotenv key, or nothing defends the removal.
  { name: 'the removed Cloudflare c.env rule stays removed', expect: 'a Cloudflare Workers binding is not demanded (c.env is not .env)', find: "  { name: 'deno Deno.env.get',", repl: "  { name: 'workers c.env.NAME', re: /\\bc\\.env\\.([A-Z][A-Z0-9_]*)\\b/g },\n  { name: 'deno Deno.env.get'," },
  { name: 'a fallback marks a var optional', expect: 'a var read with a fallback is optional, not demanded', find: 'const FALLBACK_AHEAD_RE = /^[\\s)]{0,4}(\\|\\||\\?\\?)/;', repl: 'const FALLBACK_AHEAD_RE = /^ZZNEVER/;' },
  // Names the SAME-FILE control. It used to name the across-file one, which the scan-level merge
  // reddens on its own, so this mutation was scored an ESCAPE while the rule it disables was real.
  { name: 'one unguarded read outranks a guarded one, within a file', expect: 'one unguarded read outranks a guarded one in the SAME file', find: '  if (prev.optional && !optional) map.set(name, { via: why, file, optional: false });', repl: '  void optional;' },
  { name: 'the unguarded-read upgrade survives across FILES too', expect: 'one unguarded read makes a var required despite a guarded one elsewhere', find: '      else if (prev.optional && !meta.optional) reads.set(name, meta);', repl: '      else void prev;' },
  { name: '--write refuses on an in-progress merge marker', expect: '--write refuses while a merge is in progress', find: "    if (existsSync(join(gitDir, marker))) return { blocked: `${what} is in progress (${marker})` };", repl: '    void marker; void what;' },
  { name: '--write refuses on an unmerged index', expect: '--write refuses while the index has unmerged paths', find: '  if (unmerged) {', repl: '  if (false) {' },
  { name: 'the mid-operation refusal does not fire when git is idle', expect: '--write writes normally when git is not mid-operation', find: '  const busy = gitOperationInProgress(root);', repl: "  const busy = { blocked: 'always' };" },

  // --- --write ---
  { name: '--write writes the missing keys', expect: '--write creates the example file with every missing key', find: '  if (missingKeys.length) {', repl: '  if (false) {' },
  { name: '--write leaves values blank', expect: '--write leaves every value BLANK', find: "const block = missingKeys.map((k) => `${k}=`).join('\\n') + '\\n';", repl: "const block = missingKeys.map((k) => `${k}=changeme`).join('\\n') + '\\n';" },
  { name: '--write APPENDS to an existing file rather than replacing it', expect: '--write tops up an existing file without touching its comments', find: '      appendFileSync(abs, `${sep}${block}`);', repl: '      writeFileSync(abs, `${sep}${block}`);' },
  { name: '--write adds the missing ignore rules', expect: '--write adds the ignore rules for .env', find: '    const add = IGNORE_RULES.filter((r) => !have.has(r));', repl: '    const add = [];' },
  { name: '--write stages what it wrote (else its own file is left untracked)', expect: '--write creates the example file with every missing key', find: "      git(['add', '--', ...touched], root);", repl: "      if (false) git(['add', '--', ...touched], root);" },
  // The ignore rules and the example family come from ONE list. Breaking that link is how the
  // first version shipped rules that ignored `.env.sample`, and the fixture that could not stage
  // its own example file is what caught it.
  { name: 'the ignore rules negate EVERY example name, not just the canonical one', expect: 'a non-canonical example name works and only raises an advisory', find: "const IGNORE_RULES = ['.env', '.env.*', ...EXAMPLE_BASENAMES.map((n) => `!${n}`)];", repl: "const IGNORE_RULES = ['.env', '.env.*', `!${EXAMPLE_BASENAMES[0]}`];" },

  // --- exit codes and argument handling ---
  { name: 'an INCOMPLETE scan does not exit 0', expect: 'an INCOMPLETE scan with no findings exits 2', find: '    return (res.findings || []).length ? 1 : 2;', repl: '    return 0;' },
  { name: 'findings outrank incompleteness in the exit code', expect: 'an INCOMPLETE scan WITH findings exits 1, not 2', find: '    return (res.findings || []).length ? 1 : 2;\n  }', repl: '    return 2;\n  }' },
  { name: 'a clean scan exits 0', expect: 'a clean scan exits 0', find: 'source file(s) scanned)`);\n    return 0;', repl: 'source file(s) scanned)`);\n    return 2;' },
  { name: 'a scan with findings exits 1', expect: 'a scan with findings exits 1', find: '  return 1;\n}\n\n// --- selftest', repl: '  return 0;\n}\n\n// --- selftest' },
  { name: 'an unknown flag is refused', expect: 'an unknown flag is refused, not silently ignored', find: '  if (unknownFlags.length) {', repl: '  if (false) {' },

  // THE TWO CONTROLS THE FIRST SWEEP COULD NOT REDDEN. Both existed and both asserted something
  // real, but no mutation could break them, so nothing was checking whether they still asserted
  // anything at all. That is the reverse-coverage gap this harness reports, and closing it is the
  // point of reporting it: a control with no mutation is invisible to a mutation harness forever.
  { name: 'an example file is not demanded from a product that reads nothing', expect: 'a project that reads no env vars needs no example file', find: 'if (missing.length && exampleFiles.length === 0) {', repl: 'if (exampleFiles.length === 0) {' },
  { name: 'a non-repository is UNKNOWN, never clean', expect: 'a non-repository is UNKNOWN, not clean', find: 'return { unknown: true, reason: `not a git repository at ${cwd}', repl: 'return { unknown: false, ok: true, required: [], declared: [], reason: `not a git repository at ${cwd}' },
];

function parseError(file) {
  try { execFileSync(process.execPath, ['--check', file], { windowsHide: true, stdio: 'pipe' }); return null; }
  catch (e) {
    const line = String((e && e.stderr) || '').split('\n').find((l) => /Error/.test(l));
    return (line || 'parse failed').trim();
  }
}

// Returns the exit code AND the output, plus whether the run produced a verdict at all. A KILLED
// run never answered: `e.status` is null for a signal kill, and treating that as non-zero would
// score "we never found out" as "caught", which is the absence of an answer read as an answer.
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
// report stays deterministic however the runs interleave: a harness whose output reorders between
// runs cannot be diffed, and diffing it is how anyone notices a rule losing its control.
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

// A control line is `  ok  <name>  ::  <measured>`. The name is everything before the FIRST `  ::  `
// and nothing else is interpreted.
//
// THIS USED TO STRIP A TRAILING PARENTHETICAL, and that was a real defect rather than a style
// choice. Control names legitimately end in a parenthetical ("(shared getenv pattern)"), so the
// stripper was written to remove only a parenthetical containing no parentheses of its own. But
// the measured DETAIL quotes findings back, and findings contain parentheses constantly ("env
// var(s)", "(node process.env.NAME)"). On those lines the strip silently did nothing, the control
// got keyed by the whole line including its detail, and no mutation's `expect` could ever match
// it. Measured 2026-08-21: three sound mutations were reported as ESCAPES on that basis, each one
// naming a control that HAD gone red. A parser that fails this way accuses the code under test.
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
  // A non-numeric --jobs became NaN, which built a pool of zero workers and crashed the report
  // with a stack trace instead of a sentence. Same guard as the tsconfig harness.
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

  // Controls are keyed by NAME, so two controls sharing a name collapse into one and the harness
  // then blames the wrong thing. Refuse the ambiguity rather than reason about which one won.
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

  const dir = mkdtempSync(join(tmpdir(), 'env-example-mut-'));
  const escapes = [];
  const hostLimited = [];
  // A malformed mutation and a run that never finished are both "this harness did not ask the
  // question", which is a different fact from "the rule has no control". Both still fail the run,
  // because a mutation that cannot be evaluated is not coverage.
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
      // A DISTINCT FILE PER MUTATION. One shared `mutant.mjs` was correct only while this loop was
      // sequential; concurrently it would let one worker overwrite the file another is executing,
      // and the resulting verdict would belong to neither mutation.
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
      // A non-zero exit is NOT proof a control fired: a mutant that throws also exits non-zero
      // having run nothing. And SOME control going red is not proof either, because these fixtures
      // share a shape. The NAMED control must be the one that fails.
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
    // Printed and tallied IN LIST ORDER, after every run has finished.
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

  // REVERSE COVERAGE. Everything above proves mutation -> control. It says nothing about a control
  // that NO mutation can redden, and such a control is never examined at all: it can quietly stop
  // asserting anything while every run stays green. Add a control, add the mutation that reddens
  // it, in the same change.
  //
  // A FILTERED RUN CANNOT MAKE THIS CLAIM. With --only, most controls were never given a chance to
  // redden, so listing them as gaps would report dozens of false defects and train the reader to
  // ignore the section that matters. The check is skipped and SAID to be skipped, never quietly
  // dropped: a filtered run is not a coverage verdict.
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

process.exit(await main());
