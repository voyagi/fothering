#!/usr/bin/env node
// check-env-example.mjs - every environment variable the code READS must be declared in
// `.env.example`, and the real `.env` must never be tracked.
//
// WHY THIS EXISTS
// "The repo has a .env.example" lived only as one clause in a prompt paragraph, and prose cannot
// fail a build. Worse, that clause fires ONCE, at repo creation: passes 2-5 add features, features
// add secrets, and nothing re-reads the sentence. So the file that exists on day one is stale by
// the first real feature, and the person cloning the repo discovers the gap one missing key at a
// time, at runtime, with an error that names none of them.
//
// This gate answers a single question mechanically: if I copy `.env.example` to `.env` and fill in
// the blanks, will the project start? It compares the variables the TRACKED SOURCE actually reads
// against the keys the example file actually declares.
//
// FOUR RULES, because "the file exists" is not the property anyone wants:
//   1. COMPLETE   - every env var read in tracked source is declared in an example file.
//   2. UNTRACKED  - no real `.env` (or `.env.local`, `.env.production`, ...) is tracked in git.
//   3. IGNORED    - `.env` is covered by the ignore rules, so it cannot become tracked tomorrow.
//   4. NO SECRETS - the example file carries placeholders, never real credentials.
//
// Rules 2, 3 and 4 are here rather than in a separate gate because they share this file's subject
// and they are the ways a `.env.example` habit turns into a leak: the example gets filled in with
// a real key "just to test", or `.env` rides along in a `git add .` because nothing ignored it.
//
// A ZERO-FINDING RESULT IS ONLY MEANINGFUL IF THE SCAN ACTUALLY RAN, so this exits 2 (UNKNOWN)
// rather than 0 whenever it could not reach the repo, could not enumerate, or could not read a
// file it meant to inspect. "No env vars found" and "the scanner broke" must never print the same.
//
// Usage:
//   node scripts/check-env-example.mjs             check the repo
//   node scripts/check-env-example.mjs --write     CREATE or top up .env.example, ignore .env
//   node scripts/check-env-example.mjs --selftest  prove the gate still fires (isolated controls)
//
// Exit codes: 0 clean, 1 findings, 2 the scan could not run.
//
// MAP OF THIS FILE, because most of its length is the selftest and that surprises people:
//   1. Constants   - what counts as an env file, which files are searched, how a read is
//                    recognised, which vars the runtime supplies.
//   2. Parsing     - reading an example file into keys, and judging a value against rule 4.
//   3. scan()      - the four rules, in order, returning a verdict object and never exiting.
//   4. writeMode() - the --write path. Creates, appends, never overwrites, never invents a value.
//   5. report()    - turns a verdict object into output and an exit code. The ONLY place a
//                    verdict becomes a number, which is why the exit codes have their own controls.
//   6. selftest()  - roughly half the file. One isolated control per rule, in git fixtures.
//   7. main()      - argument handling.

import { execFileSync } from 'node:child_process';
import {
  readFileSync, writeFileSync, appendFileSync, existsSync,
  mkdtempSync, mkdirSync, rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename, posix } from 'node:path';

// --- what counts as an env file ------------------------------------------------------------
//
// The example family is deliberately WIDER than the one name this gate recommends. A retrofit
// walks into repos that already chose `.env.sample` or `.env.template`, and failing those for the
// filename alone would teach the operator that the gate is pedantic rather than useful. The
// canonical name is still `.env.example` and a non-canonical one raises an ADVISORY, never a
// failure.
const EXAMPLE_BASENAMES = ['.env.example', '.env.sample', '.env.template', '.env.dist', '.env.defaults'];
const CANONICAL_EXAMPLE = EXAMPLE_BASENAMES[0];
const EXAMPLE_BASENAME_RE = new RegExp(`^(?:${EXAMPLE_BASENAMES.map((n) => n.replace(/\./g, '\\.')).join('|')})$`, 'i');

// THE IGNORE RULES AND THE EXAMPLE FAMILY ARE DERIVED FROM ONE LIST, never written out twice.
// The first version hardcoded `['.env', '.env.*', '!.env.example']`, which reads correct and
// ignores `.env.sample` and `.env.template`: on a repo that already used one of those names,
// --write would have added rules that made the project's own example file invisible to git. The
// selftest caught it because a fixture could not stage its own `.env.sample`. Two lists that must
// agree will drift, so there is one.
const IGNORE_RULES = ['.env', '.env.*', ...EXAMPLE_BASENAMES.map((n) => `!${n}`)];

// Anything else shaped like a dotenv file holds REAL values: `.env`, `.env.local`,
// `.env.production`, `.env.production.local`. The example test above runs FIRST, so an example
// file can never be classified here.
const ENV_BASENAME_RE = /^\.env(\.[A-Za-z0-9_-]+)*$/i;

function isExampleFile(path) {
  return EXAMPLE_BASENAME_RE.test(basename(path));
}
function isRealEnvFile(path) {
  const b = basename(path);
  return ENV_BASENAME_RE.test(b) && !EXAMPLE_BASENAME_RE.test(b);
}

// --- which files are searched for env reads ------------------------------------------------
//
// SOURCE ONLY, and each exclusion below is a decision rather than an oversight.
//
// Markdown and docs are NOT scanned. A README that writes `process.env.MY_SECRET` as an
// illustration would otherwise demand a key that no code reads, and the operator's only move is to
// invent one. Documentation describes the variable; it does not consume it.
//
// YAML, Dockerfiles and shell are NOT scanned either. `${VAR}` in a compose file or a workflow is
// a PLATFORM variable (a CI secret, a container env) that arrives from the host, not from a local
// `.env` the developer fills in, and GitHub Actions' own doubled-brace expressions live in the
// same files. Scanning them would fill `.env.example` with keys that must never be in it. This is
// a KNOWN MISS, stated rather than hidden: a var read ONLY by docker-compose is invisible here.
const SOURCE_EXT_RE = /\.(js|jsx|mjs|cjs|ts|tsx|mts|cts|vue|svelte|astro|py|pyi|rb|rake|go|rs|java|kt|kts|scala|cs|fs|fsx|php|dart|swift|ex|exs|erl|clj|cljs|lua|pl|pm|groovy|gradle|c|h|cpp|cc|hpp|m|mm)$/i;

// Dependency and build trees. A var read inside `node_modules` belongs to a library, not to this
// product, and a built bundle is a copy of source already scanned - counting either one puts keys
// into `.env.example` that the operator cannot explain and did not choose.
const SKIP_PATH_RE = /(^|\/)(node_modules|vendor|third_party|bower_components|dist|build|out|coverage|\.next|\.nuxt|\.svelte-kit|\.output|target|Pods|__pycache__)(\/|$)/i;
const SKIP_FILE_RE = /(\.min\.(js|css)|package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$/i;

// TESTS DO NOT DEFINE DEPLOYMENT REQUIREMENTS, and this exclusion was earned rather than guessed.
// Run against eight real product repos on 2026-08-22, the gate demanded `EXAMPLE_VAR` and
// `FAKE_VAR` (deliberately fake names inside adversarial test files), `RUN_LLM_EVALS` (a test
// toggle) and `ALLOW_LOCAL_TELEGRAM_API` (a test-only override). Nobody copying `.env.example` to
// `.env` needs any of those, and a gate that demands them teaches the operator to add junk keys
// until it goes quiet.
//
// The KNOWN MISS, stated rather than hidden: a variable the app genuinely needs but which only a
// test file happens to reference is invisible here. That is the right trade. The example file
// answers "what must I set to RUN this", and a test harness is not a deployment.
const TEST_PATH_RE = /(^|\/)(tests?|specs?|__tests__|__mocks__|e2e|cypress|fixtures?)(\/|$)|\.(test|spec|e2e|bench)\.[A-Za-z]+$/i;

const MAX_BYTES = 4 * 1024 * 1024;

// --- how an env read is recognised ----------------------------------------------------------
//
// ONE PATTERN PER LANGUAGE IDIOM, each named, because the selftest gives every one its own
// isolated control. A single fused regex would let any one idiom rot while the suite stayed green.
//
// Every pattern is ANCHORED on the accessor (`process.env.`, `os.getenv(`, `System.getenv(`), not
// on the variable name. Anchoring on a SCREAMING_CASE name alone would match every constant in
// the codebase.
const READ_PATTERNS = [
  { name: 'node process.env.NAME', re: /\bprocess\.env\.([A-Z][A-Z0-9_]*)\b/g },
  { name: 'node process.env["NAME"]', re: /\bprocess\.env\[\s*['"`]([A-Z][A-Z0-9_]*)['"`]\s*\]/g },
  // Destructuring is how a Node service usually reads five vars at once, and an accessor-anchored
  // regex sees none of them. `many` splits the brace body and strips renames and defaults.
  { name: 'js destructured env', re: /(?:const|let|var)\s*\{([^{}]{1,400})\}\s*=\s*(?:process|import\.meta)\.env\b/g, many: true },
  { name: 'vite import.meta.env.NAME', re: /\bimport\.meta\.env\.([A-Z][A-Z0-9_]*)\b/g },
  { name: 'deno Deno.env.get', re: /\bDeno\.env\.(?:get|has)\(\s*['"`]([A-Z][A-Z0-9_]*)['"`]/g },
  // NO CLOUDFLARE WORKERS PATTERN, and its absence is a decision. A `c.env.NAME` rule lived here
  // and was REMOVED on 2026-08-22 after it demanded `DB=` and `APP_CONFIG=` from a real product's
  // `.env.example`. Those are not variables at all: on Workers, `c.env` carries BINDINGS (a D1
  // database, a KV namespace, an R2 bucket) declared in `wrangler.toml`, and source code cannot
  // tell a binding from a secret. More fundamentally, a Worker never reads `.env` at runtime:
  // local dev uses `.dev.vars` and production uses `wrangler secret put`, so an `.env.example`
  // entry would be answering a question nobody asked.
  //
  // The KNOWN MISS: a Workers product gets no coverage from this gate. The honest fix is a
  // `.dev.vars.example` rule, which is a different file and a different gate, not a pattern here.
  // ONE pattern for the C name `getenv`, because PHP, Python (`os.getenv`) and Java
  // (`System.getenv`) all spell it identically and `\bgetenv\(` already matches all three.
  //
  // There were three separate patterns here, one per language, and the mutation sweep proved two
  // of them were dead weight: deleting the Python rule and deleting the Java rule EACH left every
  // control green, because this shape was catching their fixtures anyway. Three controls looked
  // like three rules being tested and were one rule tested three times. The fixtures below are
  // kept per language, since the languages are what a reader wants to see covered, but they now
  // honestly name the shared pattern they exercise.
  //
  // Go keeps its own rule: `os.Getenv` and `os.LookupEnv` are capitalised, and this pattern is
  // case-sensitive on purpose so it cannot swallow them.
  { name: 'getenv(NAME), any language', re: /\bgetenv\(\s*['"]([A-Z][A-Z0-9_]*)['"]/g },
  { name: 'php $_ENV[NAME]', re: /\$_ENV\[\s*['"]([A-Z][A-Z0-9_]*)['"]/g },
  { name: 'python os.environ', re: /\bos\.environ(?:\.get)?\(?\[?\s*['"]([A-Z][A-Z0-9_]*)['"]/g },
  { name: 'go os.Getenv', re: /\bos\.(?:Getenv|LookupEnv)\(\s*"([A-Z][A-Z0-9_]*)"/g },
  { name: 'ruby ENV', re: /\bENV(?:\.fetch)?\(?\[?\s*['"]([A-Z][A-Z0-9_]*)['"]/g },
  { name: 'rust env::var', re: /\benv::var(?:_os)?\(\s*"([A-Z][A-Z0-9_]*)"/g },
  { name: 'rust env! macro', re: /\b(?:option_env|env)!\(\s*"([A-Z][A-Z0-9_]*)"/g },
  { name: 'dotnet Environment.GetEnvironmentVariable', re: /\bEnvironment\.GetEnvironmentVariable\(\s*"([A-Z][A-Z0-9_]*)"/g },
  { name: 'dart Platform.environment', re: /\bPlatform\.environment\[\s*['"]([A-Z][A-Z0-9_]*)['"]/g },
  { name: 'dart String.fromEnvironment', re: /\bString\.fromEnvironment\(\s*['"]([A-Z][A-Z0-9_]*)['"]/g },
];

// The scaffold's own `env.ts` declares vars in a zod schema and NEVER writes `process.env.NAME`
// for each one, so an accessor-only scan reads a t3 env product as needing nothing at all. The
// SCREAMING key rule is applied ONLY inside a file that calls createEnv, which is what keeps it
// from matching every constant map in the repo.
const CREATE_ENV_RE = /\bcreateEnv\s*\(/;
const SCHEMA_KEY_RE = /^[ \t]*([A-Z][A-Z0-9_]*)\s*:/gm;

const VAR_NAME_RE = /^[A-Z][A-Z0-9_]*$/;
function isCandidate(name) {
  return name.length >= 2 && VAR_NAME_RE.test(name);
}

// Variables the RUNTIME supplies. Demanding these in `.env.example` is actively wrong: NODE_ENV is
// set by the start script, CI is set by the runner, and a developer who pastes `CI=` into a real
// `.env` changes how their tools behave. The list is short and closed on purpose; anything else
// that turns out to be host-supplied is handled by the `# gate-ignore:` directive, which lives in
// the example file where a reader can see it, rather than by growing this constant.
// The WINDOWS block is not padding. Run against real repos on 2026-08-22, the gate demanded
// `PATHEXT=` in a product's `.env.example` because a source file resolves an executable and reads
// the OS list of executable extensions. Any cross-platform product that shells out will touch two
// or three of these, and every one of them is a key that must NEVER be in a dotenv file.
const SYSTEM_VARS = new Set([
  'NODE_ENV', 'PATH', 'HOME', 'USER', 'USERNAME', 'PWD', 'SHELL', 'TERM', 'TZ',
  'TMPDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL', 'CI',
  // Windows, supplied by the OS on every machine.
  'PATHEXT', 'COMSPEC', 'SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR', 'APPDATA', 'LOCALAPPDATA',
  'PROGRAMFILES', 'PROGRAMDATA', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'OS',
  'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE',
  // Shell and terminal conventions, supplied by the environment, never by a dotenv file.
  'SHLVL', 'EDITOR', 'VISUAL', 'PAGER', 'NO_COLOR', 'FORCE_COLOR', 'COLORTERM', 'SSH_AUTH_SOCK',
  'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME',
  'GITHUB_ACTIONS', 'GITHUB_SHA', 'GITHUB_REF', 'GITHUB_REPOSITORY', 'GITHUB_WORKSPACE',
  'GITHUB_EVENT_NAME', 'GITHUB_OUTPUT', 'GITHUB_ENV', 'RUNNER_OS',
  'VERCEL', 'VERCEL_ENV', 'VERCEL_URL', 'NETLIFY', 'CF_PAGES',
  // Vite's BUILT-IN `import.meta.env` fields. The bundler substitutes these at build time and no
  // dotenv file supplies them. Measured: `import.meta.env.DEV` in one `if` demanded `DEV=`.
  'DEV', 'PROD', 'MODE', 'BASE_URL', 'SSR',
]);

// THE SCAFFOLD'S OWN TOOLING, which ships INTO every product and must not drive that product's
// example file. `verify-ship.mjs` reads `VERIFY_SHIP_TIMEOUT_MS` and `a11y-live.mjs` reads
// `A11Y_BASE_URL`, both optional knobs for the gate scripts themselves. Measured 2026-08-22:
// `VERIFY_SHIP_TIMEOUT_MS` was demanded in three of eight real product repos, purely because they
// had installed the scaffold, so every product built from it inherited the same false demand.
//
// A NAME list, which is normally a smell, and here is the right shape precisely because the set is
// CLOSED and OWNED: these are files this directory ships, not a guess about what a product might
// call something. The optional-fallback rule cannot catch them, because `verify-ship.mjs` reads the
// value on one line and applies its default several lines later.
//
// THE GATE IS ALSO ON THIS LIST, AND THAT MATTERS MOST. Installed into a product as
// `scripts/check-env-example.mjs`, this file is itself tracked source, and its comments and
// selftest fixtures are full of strings like `process.env.MY_SECRET` and `process.env.FAKE_VAR`.
// Measured 2026-08-22 by running a copy with this one exclusion removed against a product repo:
// 12 phantom keys demanded (MY_SECRET, FAKE_VAR, STRIPE_KEY, NAME, BUILT_KEY, DOC_EXAMPLE_KEY and
// the rest), against 1 real key with the exclusion in place. Without this line the gate demands its
// own fixtures from every product that installs it.
const SCAFFOLD_TOOL_RE = /(^|\/)(verify-ship|ratchet-dup|a11y-live|a11y-prove|check-ship-artifacts|check-client-secrets|check-env-example)(\.mutants)?\.mjs$/i;

// A VARIABLE THE CODE ALREADY DEFAULTS IS OPTIONAL, and telling those apart is what stops this
// gate becoming noise. `Number(process.env.VERIFY_SHIP_TIMEOUT_MS) || 30 * 60 * 1000` needs nothing
// from anybody: the project starts without it. Measured 2026-08-22, that one variable alone was
// DEMANDED in three of eight real product repos, because the scaffold's own verify-ship.mjs reads
// it, so every product using it inherited the same false demand.
//
// Optional vars are not required, and go undeclared as an ADVISORY rather than a failure. Erring
// toward REQUIRED when the shape is unclear is deliberate: the cost of a wrong "required" is one
// blank line in an example file, and the cost of a wrong "optional" is a missing key at runtime.
//
// The closing brackets in the lookahead matter: the fallback usually sits outside a wrapper call,
// as in `Number(process.env.X) || 5` or `parseInt(process.env.X ?? '3')`.
const FALLBACK_AHEAD_RE = /^[\s)]{0,4}(\|\||\?\?)/;

function addRead(map, name, why, file, optional) {
  const prev = map.get(name);
  if (!prev) { map.set(name, { via: why, file, optional: !!optional }); return; }
  // ONE unguarded read anywhere makes the variable required, however many guarded ones exist.
  if (prev.optional && !optional) map.set(name, { via: why, file, optional: false });
}

function readsIn(text, file) {
  const found = new Map();
  for (const p of READ_PATTERNS) {
    p.re.lastIndex = 0;
    for (const m of text.matchAll(p.re)) {
      if (p.many) {
        for (const raw of m[1].split(',')) {
          const n = raw.split(/[:=]/)[0].trim().replace(/^\.\.\./, '');
          // In a destructure, a default is written `{ PORT = 3000 }`, so the presence of `=` in
          // this entry IS the fallback.
          if (isCandidate(n)) addRead(found, n, p.name, file, /=/.test(raw));
        }
      } else if (isCandidate(m[1])) {
        addRead(found, m[1], p.name, file, FALLBACK_AHEAD_RE.test(text.slice(m.index + m[0].length)));
      }
    }
  }
  if (CREATE_ENV_RE.test(text)) {
    SCHEMA_KEY_RE.lastIndex = 0;
    for (const m of text.matchAll(SCHEMA_KEY_RE)) {
      if (isCandidate(m[1])) addRead(found, m[1], 't3 createEnv schema key', file);
    }
  }
  return found;
}

// --- reading an example file -----------------------------------------------------------------
//
// A COMMENTED LINE DOES NOT DECLARE A KEY, and that is the whole point of this gate rather than a
// nitpick. The property being enforced is "copy this file to .env, fill in the blanks, and the
// project starts". A `#DATABASE_URL=` line survives the copy as a comment, so the copied file is
// missing the key exactly as if the line were absent.
const DECL_RE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/;
const IGNORE_DIRECTIVE_RE = /^\s*#\s*gate-ignore:\s*(.+)$/i;

function cleanValue(raw) {
  let v = raw.trim();
  const q = v[0];
  if ((q === '"' || q === "'") && v.length > 1) {
    const end = v.lastIndexOf(q);
    if (end > 0) return v.slice(1, end);
  }
  const hash = v.indexOf(' #');
  if (hash !== -1) v = v.slice(0, hash).trim();
  return v;
}

// Kept as its own predicate so the comment rule is ONE observable line. Inlined in the loop it was
// spread across two statements that were individually invisible: removing the comment skip changed
// nothing, because DECL_RE rejects a leading `#` on its own, so no single edit could make the
// control named after this rule fail. A rule no mutation can break is a rule nothing tests.
function declarationIn(line) {
  if (/^\s*#/.test(line)) return null;
  const m = DECL_RE.exec(line);
  return m ? { key: m[1], value: cleanValue(m[2]) } : null;
}

function parseEnvFile(text) {
  const keys = new Map();
  const ignores = new Set();
  for (const line of text.split(/\r?\n/)) {
    const ig = IGNORE_DIRECTIVE_RE.exec(line);
    if (ig) {
      for (const n of ig[1].split(/[\s,]+/)) if (n) ignores.add(n.trim());
      continue;
    }
    const d = declarationIn(line);
    if (d) keys.set(d.key, d.value);
  }
  return { keys, ignores };
}

// --- rule 4: is this example value a REAL credential? -----------------------------------------
//
// KNOWN PREFIXES, NOT ENTROPY. The sibling gate (check-client-secrets.mjs) learned this the
// expensive way: a generic randomness test flags build hashes, public analytics ids and ordinary
// long identifiers, and a gate that cries wolf gets switched off within a week. Every rule below
// either matches an issuer's documented key format or reads the key's own NAME.
// THE VOCABULARY MATCHES WHOLE TOKENS, NOT BARE SUBSTRINGS. A token is delimited by any
// non-alphanumeric character or by the value's own edge. A substring test reads an ordinary
// credential as a placeholder the moment those letters appear anywhere inside it, and that is the
// one direction this rule must never fail in: a false positive costs one `# gate-ignore:` line,
// a false negative ships the credential. Measured 2026-09-05 against the substring version: a
// secret-named key whose value was `NotThereYet0000` passed on the "here" inside "There", and one
// whose value was `Sample123Secure` passed on "sample". Neither author would believe they had
// typed a placeholder. Both are findings now, and both are pinned as controls below.
// `your[_-]` became a plain `your` because the trailing separator IS the delimiter the
// boundary now checks, and the bare `xxx` became `x{3,}` so a padded `key-xxxxxx` still matches as
// one token. `localhost` and the loopback address stay in the group: a real credential carrying
// either as a whole token is not a case worth trading this back for.
const PLACEHOLDER_RE = /(^$|^<.*>$|^\$\{.*\}$|^x+$|(?<![A-Za-z0-9])(?:change[_-]?me|your|yourkey|replace|example|placeholder|todo|dummy|fake|sample|here|localhost|127\.0\.0\.1|x{3,})(?![A-Za-z0-9])|^(?:postgres|postgresql|password|passwd|root|admin|secret|test|dev|local|user|guest|none|null)$)/i;

const SECRET_VALUE_RULES = [
  { what: 'Stripe secret or restricted key', re: /\b[sr]k_(?:live|test)_[0-9A-Za-z]{16,}/ },
  { what: 'OpenAI or Anthropic key', re: /\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}/ },
  { what: 'GitHub classic token', re: /\bgh[pousr]_[A-Za-z0-9]{36,}/ },
  { what: 'GitHub fine-grained PAT', re: /\bgithub_pat_[A-Za-z0-9_]{22,}/ },
  { what: 'AWS access key id', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { what: 'Slack token', re: /\bxox[baprs]-[0-9A-Za-z-]{10,}/ },
  { what: 'SendGrid API key', re: /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/ },
  { what: 'Supabase secret key', re: /\bsb_secret_[A-Za-z0-9_-]{16,}/ },
  { what: 'GitLab personal access token', re: /\bglpat-[A-Za-z0-9_-]{16,}/ },
  { what: 'PEM private key', re: /-----BEGIN (?:RSA |DSA |EC |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY-----/ },
];

// A URL is the one place a real password hides in plain sight, and it is also where the most
// common LEGITIMATE example value lives (`postgresql://postgres:postgres@localhost:5432/app`).
// The password is judged against the placeholder vocabulary, so a local dev default passes and a
// production credential does not.
const URL_CRED_RE = /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/"'`]+:([^\s:@/"'`]+)@/i;
function urlCredentialFinding(value) {
  const m = URL_CRED_RE.exec(value);
  if (!m) return null;
  if (PLACEHOLDER_RE.test(m[1])) return null;
  return 'credentials embedded in a URL';
}

// Supabase publishes an ANON key that is a JWT and is public by design, so a pattern test would
// flag the one JWT that belongs in a client config. Decode the role claim and judge THAT, exactly
// as check-client-secrets.mjs does, so the public key passes and a service_role key does not.
function jwtRole(payloadSegment) {
  try {
    const json = Buffer.from(payloadSegment.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    const obj = JSON.parse(json);
    return typeof obj.role === 'string' ? obj.role : null;
  } catch {
    return null;
  }
}
const JWT_RE = /\beyJ[A-Za-z0-9_-]{8,}\.([A-Za-z0-9_-]{8,})\.[A-Za-z0-9_-]{8,}/;
function jwtFinding(value) {
  const m = JWT_RE.exec(value);
  if (!m) return null;
  if (jwtRole(m[1]) === 'anon') return null;
  return 'a real JWT (only a public anon token is exempt)';
}

// THE RULE THAT COVERS EVERYTHING THE PREFIXES CANNOT. `DB_PASSWORD=hunter2` matches no issuer
// format, and a generic entropy test would either miss it or flag half the file. Here the KEY NAME
// carries the intent: in an EXAMPLE file the correct value for a secret-named key is blank or a
// placeholder, so anything else is a filled-in credential. The remedy is to blank it, which costs
// nothing, so a false positive here is cheap in a way a delete instruction never is.
// Case-INSENSITIVE. Dotenv keys are uppercase by convention, not by rule, and a lowercase
// `db_password=` is legal and parses fine here, so an uppercase-only test would read the one file
// where it matters and quietly decline to judge it.
const SECRET_KEY_NAME_RE = /(SECRET|PASSWORD|PASSWD|PRIVATE_KEY|API_KEY|APIKEY|ACCESS_KEY|AUTH_TOKEN|ACCESS_TOKEN|REFRESH_TOKEN|CREDENTIAL|SERVICE_ROLE)/i;
// A PLACEHOLDER WORD DOES NOT EXCUSE A VALUE THAT IS OTHERWISE CREDENTIAL-SHAPED. The whole-token
// rule above needs `/`, `+`, `_` and `-` as delimiters, or `<your-key-here>`, `change_me` and
// `http://localhost` stop reading as placeholders, and those four characters are the base64 and
// base64url alphabets, so a vocabulary word can sit whole inside a random secret. Measured
// 2026-09-07: `Ab12/here/Zz99QwLm==`, `Q9+todo+Xk7Lm2Pq` and `k8Jd_here_Zq2Lm9Pw3T` all passed as
// placeholders under secret-named keys. Inside THIS rule the key name already says "secret".
// CREDENTIAL-SHAPED means a run of sixteen or more base64-alphabet characters in which some
// delimiter-free segment of four or more characters mixes letters and digits. The segment test is
// what separates a secret from a title-case placeholder: `Replace_With_A_Real_Key_2024` keeps its
// digits in a segment of their own, while `k8Jd` and `Zz99QwLm` mix them into the letters. A first
// version asked only for upper case, lower case and a digit anywhere in the run and would have
// flagged that placeholder; the review of its own landing found it the same day. A second version
// counted any letter beside a digit as a mix and flagged the UUID mask
// `xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx` on its `4xxx` segment (measured the same day, on the
// wrap-up's own doubt), so a mixed segment needs TWO distinct letters: a mask repeats one letter,
// a secret does not. The placeholder that is credential-shaped anyway costs a `# gate-ignore:`
// line rather than a leak.
const BASE64_RUN_RE = /[A-Za-z0-9+/=_-]{16,}/g;
function credentialShaped(value) {
  for (const run of value.match(BASE64_RUN_RE) || []) {
    for (const seg of run.split(/[_\-/+=]+/)) {
      const letters = new Set(seg.toLowerCase().replace(/[^a-z]/g, ''));
      if (seg.length >= 4 && /\d/.test(seg) && letters.size >= 2) return true;
    }
  }
  return false;
}
const FILLED_IN = 'a filled-in credential (a secret-named key must be blank or a placeholder here)';
function secretNamedFinding(key, value) {
  if (!SECRET_KEY_NAME_RE.test(key)) return null;
  if (value.length < 8) return null;
  if (credentialShaped(value)) return FILLED_IN;
  if (PLACEHOLDER_RE.test(value)) return null;
  return FILLED_IN;
}

function valueFindings(key, value) {
  const out = [];
  for (const r of SECRET_VALUE_RULES) {
    if (r.re.test(value)) out.push(r.what);
  }
  const u = urlCredentialFinding(value);
  if (u) out.push(u);
  const j = jwtFinding(value);
  if (j) out.push(j);
  const s = secretNamedFinding(key, value);
  if (s) out.push(s);
  return out;
}

// --- git helpers -------------------------------------------------------------------------------

function git(args, cwd, stdin) {
  return execFileSync('git', args, {
    cwd, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024,
    ...(stdin === undefined ? {} : { input: stdin }),
  });
}

function repoRoot(cwd) {
  return git(['rev-parse', '--show-toplevel'], cwd).trim();
}

// `--no-index` is load-bearing. Without it git refuses to call a TRACKED path ignored even when a
// rule matches it, so the moment a `.env` is committed by accident this check flips to "not
// ignored" and reports the SAME failure as a repo that never had a rule. We want the two answers
// separated: rule 2 says the file is tracked, rule 3 says the rule is missing.
// Exit 0 means ignored, 1 means not ignored, anything else means the question was not answered.
function isIgnored(root, relPath) {
  try {
    git(['check-ignore', '--no-index', '-q', '--', relPath], root);
    return { ignored: true };
  } catch (e) {
    if (e && e.status === 1) return { ignored: false };
    return { error: (e && (e.message || '')).split('\n')[0] || 'check-ignore failed' };
  }
}

// IS GIT MID-OPERATION? --write MUST NOT RUN IF SO, and this is the sharpest bug this gate has had.
//
// Measured 2026-08-22 on a scratch repo: during a merge whose `.gitignore` was CONFLICTED, --write
// appended its ignore rules to the file WITH the conflict markers still in it, then ran `git add`
// on it. `git add` on a conflicted path is how you tell git the conflict is RESOLVED, so the
// unmerged entry disappeared, `<<<<<<< HEAD` was staged as the resolution, and the gate printed
// "clean" and exited 0. A tool that silently resolves someone's merge conflict with garbage is
// worse than a tool that does nothing.
//
// TWO SIGNALS, because they cover different states. An unmerged INDEX is the direct evidence and
// catches any conflicted path however it arose. The marker FILES catch an operation that is paused
// with a clean index, which a rebase can be. Either one blocks the write.
function gitOperationInProgress(root) {
  let unmerged;
  try {
    unmerged = git(['ls-files', '-u'], root).trim();
  } catch (e) {
    return { error: `could not check for unmerged paths: ${(e.message || '').split('\n')[0]}` };
  }
  if (unmerged) {
    const paths = [...new Set(unmerged.split('\n').map((l) => l.slice(l.indexOf('\t') + 1)))];
    return { blocked: `the index has unmerged paths (${paths.slice(0, 3).join(', ')})` };
  }
  // `--absolute-git-dir` RATHER THAN joining `.git` onto the repo root, and the difference is not
  // cosmetic. In a linked worktree it resolves to `.git/worktrees/<name>/`, which is where THAT
  // worktree's MERGE_HEAD lives; the main `.git/` has none. Measured 2026-08-22 on a worktree put
  // mid-merge: MERGE_HEAD present in the worktree git dir, absent from the main one. A naive join
  // would look in the empty place and let the write proceed, in the exact setup these repos use
  // for concurrent sessions.
  let gitDir;
  try {
    gitDir = git(['rev-parse', '--absolute-git-dir'], root).trim();
  } catch (e) {
    return { error: `could not locate the git directory: ${(e.message || '').split('\n')[0]}` };
  }
  for (const [marker, what] of [
    ['MERGE_HEAD', 'a merge'],
    ['CHERRY_PICK_HEAD', 'a cherry-pick'],
    ['REVERT_HEAD', 'a revert'],
    ['BISECT_LOG', 'a bisect'],
    ['rebase-merge', 'a rebase'],
    ['rebase-apply', 'a rebase'],
  ]) {
    if (existsSync(join(gitDir, marker))) return { blocked: `${what} is in progress (${marker})` };
  }
  return {};
}

// --- the scan ----------------------------------------------------------------------------------

function scan(cwd) {
  let root;
  try {
    root = repoRoot(cwd);
  } catch (e) {
    return { unknown: true, reason: `not a git repository at ${cwd}: ${(e.message || '').split('\n')[0]}`, findings: [] };
  }

  let files;
  try {
    files = git(['ls-files', '-z'], root).split('\0').filter(Boolean).map((f) => f.replace(/\\/g, '/'));
  } catch (e) {
    return { unknown: true, reason: `git ls-files failed: ${(e.message || '').split('\n')[0]}`, findings: [] };
  }
  if (files.length === 0) {
    return { unknown: true, reason: 'git ls-files returned no tracked files (empty index)', findings: [] };
  }

  const findings = [];
  const advisories = [];

  // RULE 2: a real env file must never be tracked. Checked before anything else, because if this
  // fires the credentials are already in the history and every other verdict is secondary.
  const trackedEnv = files.filter(isRealEnvFile);
  for (const f of trackedEnv) {
    findings.push({ kind: 'tracked-env', file: f, why: 'a real env file is TRACKED in git (its values are in the history)' });
  }

  // Where the example files live. Their keys are UNIONED across directories, which is what makes a
  // monorepo work without this gate guessing a layout: `apps/web/.env.example` covers `apps/web/`,
  // where a fixed root-only list would report every package as missing every key.
  //
  // TRACKED IS NOT THE SAME AS PRESENT, and the difference is the whole point of the file. An
  // example file sitting untracked on disk is worthless to the person cloning the repo, which is
  // the ONE person it exists for. It is also exactly what a wrong ignore rule produces: `.env.*`
  // without a negation swallows `.env.example` itself, `git add .` skips it silently, and the
  // author sees the file in their editor every day while nobody else ever receives it.
  //
  // Looked for beside every tracked file rather than only at the root, because a monorepo package
  // keeps its own. The directory set comes from the index, so this is bounded by the repo rather
  // than by a filesystem walk.
  const trackedExamples = files.filter(isExampleFile);
  const trackedSet = new Set(trackedExamples);
  const dirsWithFiles = new Set(['.', ...files.map((f) => (f.includes('/') ? f.slice(0, f.lastIndexOf('/')) : '.'))]);
  const diskExamples = [];
  for (const dir of dirsWithFiles) {
    for (const n of EXAMPLE_BASENAMES) {
      const rel = dir === '.' ? n : posix.join(dir, n);
      if (existsSync(join(root, rel))) diskExamples.push(rel);
    }
  }
  const exampleFiles = [...new Set([...trackedExamples, ...diskExamples])].sort();
  for (const f of exampleFiles) {
    if (!trackedSet.has(f)) {
      findings.push({ kind: 'untracked-example', file: f, why: 'exists on disk but is NOT tracked, so a clone never receives it' });
    }
  }
  const exampleDirs = new Set(['.', ...exampleFiles.map((f) => (f.includes('/') ? f.slice(0, f.lastIndexOf('/')) : '.'))]);

  // RULE 3: `.env` must be covered by the ignore rules in every directory that has an example
  // file, plus the repo root. An ignore rule that exists only at the root does not protect
  // `apps/web/.env`, and that is exactly where a monorepo's real secrets sit.
  for (const dir of [...exampleDirs].sort()) {
    const rel = dir === '.' ? '.env' : posix.join(dir, '.env');
    const res = isIgnored(root, rel);
    if (res.error) {
      return { unknown: true, reason: `git check-ignore failed for ${rel}: ${res.error}`, findings };
    }
    if (!res.ignored) {
      findings.push({ kind: 'not-ignored', file: rel, why: 'not covered by the ignore rules, so one `git add .` commits it' });
    }
  }

  // Collect what the code reads.
  const reads = new Map();
  const unreadable = [];
  let scanned = 0;
  for (const f of files) {
    if (SKIP_PATH_RE.test(f) || SKIP_FILE_RE.test(f) || TEST_PATH_RE.test(f) || SCAFFOLD_TOOL_RE.test(f)) continue;
    if (!SOURCE_EXT_RE.test(f)) continue;
    let buf;
    try {
      buf = readFileSync(join(root, f));
    } catch (e) {
      unreadable.push(`${f} (${(e && e.code) || 'read error'})`);
      continue;
    }
    // Truncating and scanning the head is a SILENT FALSE CLEAN: the one call to `process.env` in a
    // generated 6MB file would be invisible and the run would still print a confident verdict.
    if (buf.length > MAX_BYTES) {
      unreadable.push(`${f} (too large to scan fully: ${(buf.length / 1048576).toFixed(1)}MB)`);
      continue;
    }
    scanned++;
    for (const [name, meta] of readsIn(buf.toString('utf8'), f)) {
      const prev = reads.get(name);
      // Merged across FILES with the same rule readsIn uses within one file: any unguarded read
      // anywhere makes the variable required.
      if (!prev) reads.set(name, meta);
      else if (prev.optional && !meta.optional) reads.set(name, meta);
    }
  }
  if (unreadable.length) {
    return {
      unknown: true,
      reason: `could not read ${unreadable.length} tracked source file(s): ${unreadable.slice(0, 5).join(', ')}`,
      findings,
    };
  }

  // Read the example files.
  const declared = new Map();
  const ignoredKeys = new Set();
  for (const f of exampleFiles) {
    let text;
    try {
      text = readFileSync(join(root, f), 'utf8');
    } catch (e) {
      return { unknown: true, reason: `could not read ${f}: ${(e && e.code) || 'read error'}`, findings };
    }
    const parsed = parseEnvFile(text);
    for (const [k, v] of parsed.keys) if (!declared.has(k)) declared.set(k, { value: v, file: f });
    for (const k of parsed.ignores) ignoredKeys.add(k);
  }

  const known = [...reads.keys()]
    .filter((n) => !SYSTEM_VARS.has(n))
    .filter((n) => !ignoredKeys.has(n))
    .sort();
  const required = known.filter((n) => !reads.get(n).optional);
  const optional = known.filter((n) => reads.get(n).optional);
  for (const n of optional) {
    if (!declared.has(n)) {
      advisories.push(`${n} is read with a fallback, so it is optional; declare it only to document the knob`);
    }
  }

  // RULE 1: completeness. This is the property the whole gate exists for.
  const missing = required.filter((n) => !declared.has(n));
  if (missing.length && exampleFiles.length === 0) {
    findings.push({
      kind: 'no-example-file',
      file: CANONICAL_EXAMPLE,
      why: `the code reads ${missing.length} env var(s) and NO example file exists`,
      keys: missing,
    });
  } else {
    for (const n of missing) {
      findings.push({ kind: 'missing-key', file: exampleFiles[0] || CANONICAL_EXAMPLE, why: `${n} is read by ${reads.get(n).file} (${reads.get(n).via}) but not declared`, key: n });
    }
  }

  // RULE 4: no real credentials in an example file.
  for (const [key, meta] of declared) {
    if (ignoredKeys.has(key)) continue;
    for (const what of valueFindings(key, meta.value)) {
      findings.push({ kind: 'real-secret', file: meta.file, why: `${key} looks like ${what}`, key });
    }
  }

  // ADVISORY ONLY, never a failure. A key declared here and read nowhere in source is usually read
  // by something this gate deliberately does not scan: a compose file, a CI workflow, a platform
  // dashboard, a migration tool. Failing on it would turn every correct repo red and the gate
  // would be deleted, so it is reported and nothing more.
  for (const [key] of declared) {
    if (!reads.has(key) && !SYSTEM_VARS.has(key) && !ignoredKeys.has(key)) {
      advisories.push(`${key} is declared but no scanned source reads it (fine if infra or a platform reads it)`);
    }
  }
  for (const f of exampleFiles) {
    if (basename(f) !== CANONICAL_EXAMPLE) {
      advisories.push(`${f} works, but ${CANONICAL_EXAMPLE} is the name the rest of the estate uses`);
    }
  }

  return {
    unknown: false,
    ok: findings.length === 0,
    findings,
    advisories,
    root,
    scanned,
    tracked: files.length,
    required,
    declared: [...declared.keys()],
    exampleFiles,
  };
}

// --- --write -------------------------------------------------------------------------------
//
// This is what makes the gate CREATE the file rather than only complain about it, which is the
// whole ask: run it once and you have something to copy.
//
// THREE THINGS IT WILL NOT DO, each deliberate:
//   - it never writes a VALUE. Every key lands blank, because a value invented by a tool is a
//     value somebody will ship.
//   - it never rewrites or reorders an existing line. Comments and grouping in an example file are
//     the documentation a human wrote; appending is safe, rewriting is not.
//   - it never untracks a committed `.env`. Those values are already in the history and need
//     rotating, not a `git rm` run behind the operator's back. It prints the commands instead.
function writeMode(cwd) {
  const res = scan(cwd);
  if (res.unknown) return { res, changed: [] };
  const root = res.root;

  // REFUSE BEFORE WRITING ANYTHING, not part-way through. A partial write during a merge is the
  // worst of both outcomes: the file is modified and the operator is mid-conflict.
  const busy = gitOperationInProgress(root);
  if (busy.error || busy.blocked) {
    return { res, changed: [], refused: busy.blocked || busy.error };
  }

  const changed = [];
  const touched = [];

  const missingKeys = [];
  for (const f of res.findings) {
    if (f.kind === 'missing-key') missingKeys.push(f.key);
    if (f.kind === 'no-example-file') missingKeys.push(...f.keys);
  }

  if (missingKeys.length) {
    const target = res.exampleFiles[0] || CANONICAL_EXAMPLE;
    const abs = join(root, target);
    const header = [
      '# Copy this file to .env and fill in the blanks.',
      '# Every key below is read by the code. .env itself is ignored by git and must stay that way.',
      '',
    ].join('\n');
    const block = missingKeys.map((k) => `${k}=`).join('\n') + '\n';
    if (existsSync(abs)) {
      const current = readFileSync(abs, 'utf8');
      const sep = current.length && !current.endsWith('\n') ? '\n' : '';
      appendFileSync(abs, `${sep}${block}`);
    } else {
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, `${header}${block}`);
    }
    changed.push(`${target}: added ${missingKeys.length} key(s) -> ${missingKeys.join(', ')}`);
    touched.push(target);
  }

  for (const f of res.findings) {
    if (f.kind !== 'not-ignored') continue;
    const dir = f.file.includes('/') ? f.file.slice(0, f.file.lastIndexOf('/')) : '.';
    const gi = join(root, dir === '.' ? '.gitignore' : posix.join(dir, '.gitignore'));
    const current = existsSync(gi) ? readFileSync(gi, 'utf8') : '';
    const have = new Set(current.split(/\r?\n/).map((l) => l.trim()));
    const add = IGNORE_RULES.filter((r) => !have.has(r));
    if (!add.length) continue;
    const sep = current.length && !current.endsWith('\n') ? '\n' : '';
    const giRel = dir === '.' ? '.gitignore' : posix.join(dir, '.gitignore');
    appendFileSync(gi, `${sep}${add.join('\n')}\n`);
    changed.push(`${giRel}: added ${add.join(', ')}`);
    touched.push(giRel);
  }

  // STAGE WHAT IT WROTE, by explicit pathspec and nothing else.
  //
  // Without this, --write can never reach clean: an example file it has just created is untracked,
  // and an untracked example file is a finding (rightly, since a clone never receives it). A tool
  // whose fix mode still reports failure reads as broken and gets deleted, so the write completes
  // the job it started. It stages ONLY the paths it touched, never a directory pathspec, so a
  // concurrent session's staged work cannot be swept in with it.
  if (touched.length) {
    try {
      git(['add', '--', ...touched], root);
      changed.push(`staged: ${touched.join(', ')}`);
    } catch (e) {
      changed.push(`could NOT stage ${touched.join(', ')} (${(e.message || '').split('\n')[0]}); add them yourself`);
    }
  }

  return { res: scan(cwd), changed };
}

// --- reporting ---------------------------------------------------------------------------------

function report(res) {
  // FINDINGS FIRST, even on an incomplete scan. A tracked `.env` is real and actionable whatever
  // else the scan could not reach, and burying it under an UNKNOWN banner would delay the one
  // finding that matters most. The incompleteness is still printed, loudly, above it.
  if (res.unknown) {
    console.error(`[env-example] INCOMPLETE: ${res.reason}`);
    console.error('[env-example] Refusing to report clean on a scan that did not run.');
    for (const f of res.findings || []) console.error(`  ${f.file}  <- ${f.why}`);
    return (res.findings || []).length ? 1 : 2;
  }
  for (const a of res.advisories || []) console.log(`[env-example] note: ${a}`);
  if (res.ok) {
    console.log(`[env-example] clean (${res.required.length} var(s) read, ${res.declared.length} declared, ${res.scanned} source file(s) scanned)`);
    return 0;
  }
  console.error(`[env-example] ${res.findings.length} finding(s):`);
  for (const f of res.findings) console.error(`  ${f.file}  <- ${f.why}`);

  if (res.findings.some((f) => f.kind === 'missing-key' || f.kind === 'no-example-file')) {
    console.error('');
    console.error('MISSING KEYS: run the gate with --write. It appends every missing key, BLANK,');
    console.error('so the file stays copy-and-fill:  node scripts/check-env-example.mjs --write');
  }
  if (res.findings.some((f) => f.kind === 'untracked-example')) {
    console.error('');
    console.error('AN UNTRACKED EXAMPLE FILE helps nobody: the person cloning the repo is the only');
    console.error('reader it has. Usually an ignore rule swallowed it, so check that the .gitignore');
    console.error(`negates it (\`!${CANONICAL_EXAMPLE}\`), then \`git add\` it.`);
  }
  if (res.findings.some((f) => f.kind === 'not-ignored')) {
    console.error('');
    // The rules are PRINTED FROM THE CONSTANT rather than retyped. An earlier version spelled out
    // three of them in this sentence and the constant grew to seven, so the remedy described a
    // ruleset the tool had stopped writing.
    console.error(`NOT IGNORED: --write adds these to the .gitignore beside the example file:`);
    console.error(`  ${IGNORE_RULES.join('  ')}`);
    console.error('Do it before the next commit, not after.');
  }
  if (res.findings.some((f) => f.kind === 'tracked-env')) {
    console.error('');
    console.error('A TRACKED .env IS A LEAK THAT --write WILL NOT TOUCH, on purpose. The values are');
    console.error('already in the git history, so untracking the file does not remove them:');
    console.error('  1. ROTATE every credential in it. This step is the one that actually matters.');
    console.error('  2. git rm --cached <file>   (keeps it on disk, removes it from the index)');
    console.error('  3. add it to .gitignore, then decide with a human whether the HISTORY needs');
    console.error('     rewriting or the repo needs recreating.');
  }
  if (res.findings.some((f) => f.kind === 'real-secret')) {
    console.error('');
    console.error('A REAL CREDENTIAL IN AN EXAMPLE FILE is a leak the moment the repo goes public.');
    console.error('Blank the value (KEY=) and rotate the key. If the match is wrong, put');
    console.error('`# gate-ignore: KEY` in the example file so the exemption is visible to readers.');
  }
  return 1;
}

// --- selftest ----------------------------------------------------------------------------------
//
// EVERY RULE GETS ITS OWN ISOLATED CONTROL, and the fixtures are built so that exactly one rule
// can fire in each. A fixture that trips three rules at once proves nothing about any single one:
// delete a rule and a neighbour's finding keeps the suite green, which is how a gate ends up with
// a rule nothing tests.

// NO COMMITS ANYWHERE IN THIS SUITE, and that is a correctness point rather than only a speed one.
// Everything the gate reads about tracking comes from `git ls-files`, which reads the INDEX, so
// staging alone builds every state these controls need. Committing would add a second spawn per
// fixture plus identity and signing config, and the mutants harness runs this suite once per
// mutation, so each avoided spawn is multiplied by the whole mutation list.
//
// The config is written straight into .git/config for the same reason: four `git config` calls are
// four process spawns, and on Windows spawn overhead dominates this suite's runtime.
function fixture(files, opts = {}) {
  const root = mkdtempSync(join(tmpdir(), 'env-example-st-'));
  git(['init', '-q'], root);
  // THE AMBIENT GLOBAL GITIGNORE WOULD VOID THIS ENTIRE SUITE SILENTLY. `.env` is in most
  // developers' global excludes, and rule 3 asks exactly whether `.env` is ignored: with a global
  // rule in scope EVERY fixture answers yes, so the not-ignored control passes whether the rule
  // works or not, and the tracked-.env fixture never stages its own file. The file lives under
  // .git/ so `git add -A` can never stage it.
  const noExcludes = join(root, '.git', 'empty-excludes');
  writeFileSync(noExcludes, '');
  // autocrlf off silences the per-file CRLF warnings git prints on Windows. They are only noise,
  // but the mutants harness parses this suite's stdout line by line, so noise is not free.
  appendFileSync(join(root, '.git', 'config'), `\n[core]\n\texcludesFile = ${noExcludes.replace(/\\/g, '/')}\n\tautocrlf = false\n`);
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body);
  }
  git(['add', '-A'], root);
  for (const f of opts.force || []) git(['add', '-f', '--', f], root);
  // Marker files for an in-progress git operation (MERGE_HEAD and friends). Written directly
  // rather than by staging a real merge, because a real conflict needs commits and this suite
  // deliberately makes none.
  for (const [name, body] of Object.entries(opts.gitDirFiles || {})) {
    writeFileSync(join(root, '.git', name), body);
  }
  // A genuinely UNMERGED index entry, built with plumbing. The marker files above cover a paused
  // operation; this covers the state git itself calls a conflict, which is the one that made
  // `git add` mark a conflict resolved. Stage 2 (ours) and stage 3 (theirs) with no stage 0 IS an
  // unmerged path as far as `git ls-files -u` is concerned.
  if (opts.unmergedPath) {
    const blob = git(['hash-object', '-w', '--stdin'], root, 'conflicted content\n').trim();
    git(['update-index', '--index-info'], root,
      `100644 ${blob} 2\t${opts.unmergedPath}\n100644 ${blob} 3\t${opts.unmergedPath}\n`);
  }
  // A FIXTURE THAT DID NOT STAGE WHAT IT WROTE IS A FALSE CLEAN, not a passing case. Compare the
  // index against what was written, allowing exactly the paths the case says it expects to be
  // ignored, and fail loudly on any other gap.
  const staged = new Set(git(['ls-files'], root).trim().split('\n').filter(Boolean));
  const expectUnstaged = new Set(opts.unstaged || []);
  const wanted = Object.keys(files).filter((f) => !expectUnstaged.has(f));
  const gap = wanted.filter((f) => !staged.has(f));
  if (gap.length) {
    throw new Error(`fixture failed to stage ${gap.join(', ')} - this case would assert nothing`);
  }
  for (const f of expectUnstaged) {
    if (staged.has(f)) throw new Error(`fixture staged ${f}, which the case expects to be ignored`);
  }
  // Untrack LAST, keeping the file on disk. This is the only way to build the "present but
  // untracked" state, and it runs after the staged-set assertion above so that assertion still
  // proves the fixture wrote what it meant to.
  for (const f of opts.unstageAfter || []) {
    git(['rm', '--cached', '-q', '--', f], root);
    if (!existsSync(join(root, f))) throw new Error(`fixture removed ${f} from disk, not just from the index`);
  }
  return root;
}

const GITIGNORE_OK = `${IGNORE_RULES.join('\n')}\n`;

// Runs fn with stdout and stderr swallowed. The controls that exercise report() and main() feed
// them deliberate failures, and their remedy blocks would bury the one line per control that this
// suite exists to print (and that the mutants harness parses).
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

function selftest() {
  const cases = [];
  const base = { '.gitignore': GITIGNORE_OK };

  // NEGATIVE control: a correct repo must pass, or nothing else here means anything.
  cases.push({
    name: 'a complete example file passes',
    files: { ...base, '.env.example': 'DATABASE_URL=\n', 'src/db.js': 'const u = process.env.DATABASE_URL;\n' },
    expect: 'clean',
  });
  // The "this project does not need a .env" case. It must be CLEAN, not a finding: most CLIs and
  // static sites read nothing, and demanding an empty example file from them is noise.
  cases.push({
    name: 'a project that reads no env vars needs no example file',
    files: { ...base, 'src/main.js': 'export const x = 1;\n' },
    expect: 'clean',
  });

  // ONE CONTROL PER READ IDIOM. Each fixture uses that idiom ALONE, so deleting its pattern turns
  // this control and only this control red.
  const idioms = [
    ['node process.env.NAME', 'src/a.js', 'const u = process.env.STRIPE_KEY;\n', 'STRIPE_KEY'],
    ['node process.env["NAME"]', 'src/a.js', 'const u = process.env["STRIPE_KEY"];\n', 'STRIPE_KEY'],
    ['js destructured env', 'src/a.js', 'const { STRIPE_KEY, OTHER_KEY = "x" } = process.env;\n', 'STRIPE_KEY'],
    ['vite import.meta.env.NAME', 'src/a.ts', 'const u = import.meta.env.PUBLIC_API_BASE;\n', 'PUBLIC_API_BASE'],
    ['deno Deno.env.get', 'src/a.ts', 'const u = Deno.env.get("STRIPE_KEY");\n', 'STRIPE_KEY'],
    // These three exercise the SHARED getenv pattern, and their names say so rather than implying
    // three rules. Kept per language because the languages are what a reader wants covered, and
    // because if the shared pattern is ever split again these fixtures are already in place.
    ['php getenv (shared getenv pattern)', 'src/a.php', "<?php $u = getenv('STRIPE_KEY');\n", 'STRIPE_KEY'],
    ['python os.getenv (shared getenv pattern)', 'src/a.py', 'u = os.getenv("STRIPE_KEY")\n', 'STRIPE_KEY'],
    ['java System.getenv (shared getenv pattern)', 'src/A.java', 'String u = System.getenv("STRIPE_KEY");\n', 'STRIPE_KEY'],
    ['php $_ENV', 'src/b.php', "<?php $u = $_ENV['STRIPE_KEY'];\n", 'STRIPE_KEY'],
    ['python os.environ', 'src/a.py', 'u = os.environ["STRIPE_KEY"]\n', 'STRIPE_KEY'],
    ['go os.Getenv', 'src/a.go', 'u := os.Getenv("STRIPE_KEY")\n', 'STRIPE_KEY'],
    ['ruby ENV', 'src/a.rb', "u = ENV['STRIPE_KEY']\n", 'STRIPE_KEY'],
    ['rust env::var', 'src/a.rs', 'let u = env::var("STRIPE_KEY").unwrap();\n', 'STRIPE_KEY'],
    ['rust env! macro', 'src/a.rs', 'let u = env!("STRIPE_KEY");\n', 'STRIPE_KEY'],
    ['dotnet Environment.GetEnvironmentVariable', 'src/A.cs', 'var u = Environment.GetEnvironmentVariable("STRIPE_KEY");\n', 'STRIPE_KEY'],
    ['dart Platform.environment', 'src/a.dart', "final u = Platform.environment['STRIPE_KEY'];\n", 'STRIPE_KEY'],
    ['dart String.fromEnvironment', 'src/a.dart', "const u = String.fromEnvironment('STRIPE_KEY');\n", 'STRIPE_KEY'],
    ['t3 createEnv schema key', 'src/env.ts', 'export const env = createEnv({ server: {\n  STRIPE_KEY: z.string(),\n} });\n', 'STRIPE_KEY'],
  ];
  for (const [idiom, file, body, key] of idioms) {
    cases.push({
      name: `read idiom detected: ${idiom}`,
      files: { ...base, '.env.example': 'UNRELATED=\n', [file]: body },
      expect: 'fail',
      expectWhy: new RegExp(`${key} is read by`),
    });
  }

  // Completeness rule, both directions.
  cases.push({
    name: 'a COMMENTED key does not declare anything',
    files: { ...base, '.env.example': '#DATABASE_URL=\n', 'src/db.js': 'const u = process.env.DATABASE_URL;\n' },
    expect: 'fail',
    expectWhy: /DATABASE_URL is read by/,
  });
  cases.push({
    name: 'the gate-ignore directive exempts a key',
    files: { ...base, '.env.example': '# gate-ignore: DATABASE_URL\n', 'src/db.js': 'const u = process.env.DATABASE_URL;\n' },
    expect: 'clean',
  });
  cases.push({
    name: 'a runtime-supplied system var needs no declaration',
    files: { ...base, '.env.example': 'UNRELATED=\n', 'src/a.js': 'const m = process.env.NODE_ENV;\nconst c = process.env.CI;\n' },
    expect: 'clean',
  });
  cases.push({
    name: 'no example file at all, while the code reads env, is a finding',
    files: { ...base, 'src/db.js': 'const u = process.env.DATABASE_URL;\n' },
    expect: 'fail',
    expectWhy: /NO example file exists/,
  });
  cases.push({
    name: 'a declared key nothing reads is an advisory, never a failure',
    files: { ...base, '.env.example': 'DATABASE_URL=\nLEGACY_FLAG=\n', 'src/db.js': 'const u = process.env.DATABASE_URL;\n' },
    expect: 'clean',
  });
  cases.push({
    name: 'a non-canonical example name works and only raises an advisory',
    files: { ...base, '.env.sample': 'DATABASE_URL=\n', 'src/db.js': 'const u = process.env.DATABASE_URL;\n' },
    expect: 'clean',
  });

  // Rule 2, isolated: `.env` is IGNORED (so rule 3 is silent) but force-added, so only the
  // tracked-file rule can fire.
  cases.push({
    name: 'a tracked .env is a finding',
    files: { ...base, '.env': 'DATABASE_URL=real\n', '.env.example': 'DATABASE_URL=\n' },
    force: ['.env'],
    expect: 'fail',
    expectWhy: /TRACKED in git/,
  });
  cases.push({
    name: 'a tracked .env.local is a finding too',
    files: { ...base, '.env.local': 'DATABASE_URL=real\n', '.env.example': 'DATABASE_URL=\n' },
    force: ['.env.local'],
    expect: 'fail',
    expectWhy: /TRACKED in git/,
  });
  // The mirror, and it is the control that stops rule 2 from eating the file the gate exists to
  // create: `.env.example` is ALWAYS tracked and must never be read as a real env file.
  cases.push({
    name: 'a tracked .env.example is NOT mistaken for a real env file',
    files: { ...base, '.env.example': 'DATABASE_URL=\n', 'src/db.js': 'const u = process.env.DATABASE_URL;\n' },
    expect: 'clean',
  });

  // Rule 3, isolated: no `.env` file exists at all, so only the ignore-rule check can fire.
  cases.push({
    name: 'an unignored .env is a finding',
    files: { '.gitignore': 'node_modules\n', '.env.example': 'DATABASE_URL=\n', 'src/db.js': 'const u = process.env.DATABASE_URL;\n' },
    expect: 'fail',
    expectWhy: /not covered by the ignore rules/,
  });
  // ROOT-ANCHORED on purpose, and the anchor is the whole control. A bare `.env` line in a root
  // .gitignore matches at EVERY level, so it already protects `apps/web/.env` and a fixture using
  // it would assert nothing. `/.env` matches the root only, which is the real shape that leaves a
  // monorepo package unprotected, and it is the case the per-directory check exists for.
  cases.push({
    name: 'a subdirectory example file requires its OWN .env to be ignored',
    files: { '.gitignore': '/.env\n', 'apps/web/.env.example': 'DATABASE_URL=\n', 'apps/web/src/db.js': 'const u = process.env.DATABASE_URL;\n' },
    expect: 'fail',
    expectWhy: /apps\/web\/\.env/,
  });
  // An example file on disk that git never received. The gate must not read the author's own
  // working copy as proof that a cloner gets one.
  cases.push({
    name: 'an example file present on disk but untracked is a finding',
    files: { ...base, '.env.example': 'DATABASE_URL=\n', 'src/db.js': 'const u = process.env.DATABASE_URL;\n' },
    unstageAfter: ['.env.example'],
    expect: 'fail',
    expectWhy: /NOT tracked/,
  });
  cases.push({
    name: 'a monorepo example file satisfies a var read in its own package',
    files: {
      ...base,
      'apps/web/.gitignore': GITIGNORE_OK,
      'apps/web/.env.example': 'DATABASE_URL=\n',
      'apps/web/src/db.js': 'const u = process.env.DATABASE_URL;\n',
    },
    expect: 'clean',
  });

  // Rule 4, one control per credential class.
  // FIXTURE CREDENTIALS ARE ASSEMBLED FROM FRAGMENTS, never written whole, and this is required
  // rather than tidy. Written as literals, this file is a source file containing a Stripe key
  // shape, an AWS key id shape and a PEM header, so a pre-commit secret scanner
  // refuses to commit it. Measured 2026-08-22: six blocked findings, every one a deliberate
  // fixture. The sibling check-client-secrets.mjs solves it the same way, and the alternative is
  // teaching people to bypass a secret gate, which is a far worse habit than a join call.
  const j = (...parts) => parts.join('');
  const secretValues = [
    ['Stripe secret or restricted key', 'STRIPE_KEY', j('s', 'k', '_live_51Habcdefghijklmnopqrstuvwx')],
    ['OpenAI or Anthropic key', 'LLM_KEY', j('s', 'k', '-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAA')],
    ['GitHub classic token', 'GH_TOKEN', j('gh', 'p', '_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789')],
    ['GitHub fine-grained PAT', 'GH_FINE', j('github', '_pat_', 'ABCDEFGHIJKLMNOPQRSTUV_abcdefgh')],
    ['AWS access key id', 'AWS_ID', j('AKIA', 'IOSFODNN7', 'EXAMPL3')],
    ['Slack token', 'SLACK_HOOK', j('xox', 'b', '-123456789012-abcdefghijkl')],
    ['SendGrid API key', 'MAIL_KEY', j('S', 'G', '.abcdefghijklmnopqr.stuvwxyzabcdefghij')],
    ['Supabase secret key', 'SB_KEY', j('sb', '_secret_', 'abcdefghijklmnopqrst')],
    ['GitLab personal access token', 'GL_TOKEN', j('gl', 'pat', '-abcdefghijklmnopqrst')],
    ['PEM private key', 'SIGNING_PEM', j('-----BEGIN ', 'RSA ', 'PRIVATE KEY', '-----MIIE')],
  ];
  for (const [what, key, value] of secretValues) {
    cases.push({
      name: `example value rejected: ${what}`,
      files: { ...base, '.env.example': `${key}=${value}\n` },
      expect: 'fail',
      expectWhy: new RegExp(`looks like ${what.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
    });
  }
  cases.push({
    name: 'example value rejected: credentials in a URL',
    files: { ...base, '.env.example': 'DATABASE_URL=postgres://appuser:Tr0ub4dor@db.prod.internal:5432/app\n' },
    expect: 'fail',
    expectWhy: /credentials embedded in a URL/,
  });
  cases.push({
    name: 'a local dev connection string is not a credential leak',
    files: { ...base, '.env.example': 'DATABASE_URL=postgresql://postgres:postgres@localhost:5432/app\n' },
    expect: 'clean',
  });
  cases.push({
    name: 'a credential-free URL is not flagged',
    files: { ...base, '.env.example': 'PUBLIC_SITE_URL=https://api.example.com/v1\n' },
    expect: 'clean',
  });
  {
    // A JWT the gate must reject, and its twin it must accept. The only difference is the decoded
    // role, which is the whole reason this rule decodes instead of pattern matching: a Supabase
    // anon key is public by design and lives in client configs everywhere.
    const head = Buffer.from('{"alg":"HS256","typ":"JWT"}').toString('base64url');
    const sig = 'aaaaaaaaaaaaaaaa';
    const service = Buffer.from('{"role":"service_role","iss":"supabase"}').toString('base64url');
    const anon = Buffer.from('{"role":"anon","iss":"supabase"}').toString('base64url');
    cases.push({
      name: 'example value rejected: a service_role JWT',
      files: { ...base, '.env.example': `SUPABASE_JWT=${head}.${service}.${sig}\n` },
      expect: 'fail',
      expectWhy: /a real JWT/,
    });
    cases.push({
      name: 'a public anon JWT is not flagged',
      files: { ...base, '.env.example': `PUBLIC_SUPABASE_ANON=${head}.${anon}.${sig}\n` },
      expect: 'clean',
    });
  }
  cases.push({
    name: 'example value rejected: a secret-named key with a filled-in value',
    files: { ...base, '.env.example': 'SESSION_SECRET=8f3a91be22c7\n' },
    expect: 'fail',
    expectWhy: /filled-in credential/,
  });
  cases.push({
    name: 'a secret-named key with a placeholder is fine',
    files: { ...base, '.env.example': 'SESSION_SECRET=change_me\nAPI_KEY=<your-key-here>\nDB_PASSWORD=\n' },
    expect: 'clean',
  });
  cases.push({
    // The mirror of the control above, and the expensive direction. A credential is not excused by
    // a placeholder word buried inside it. Both values here passed the gate before 2026-09-05: the
    // first on the "here" inside "There", the second on "sample". Two values rather than one
    // because they fail differently: the first hides the word mid token, so only the LEADING
    // boundary catches it, and the second opens with it, so only the TRAILING boundary does. One
    // value would leave half the fix unproven.
    //
    // THE `fixture_` AND `stub_` PREFIXES ARE LOAD BEARING, and not for this rule. Without them
    // a commit-time secret scanner reads the line as a real credential under a
    // secret-named key, which is precisely what it is built to stop, and this file cannot be
    // committed. Neither word is in the vocabulary above, so neither changes what this control
    // proves. Measured 2026-09-05 against that scanner rather than guessed. Do not tidy them away.
    //
    // THE VALUES CARRY NO DIGIT, ALSO ON PURPOSE. They first shipped as NotThereYet0000 and
    // Sample123Secure, and the credential-shape rule added on 2026-09-07 caught those on their
    // mixed segments BEFORE the vocabulary was consulted, so the mutation that reverts the token
    // boundaries left this control green: the full sweep reported it as an escape the same day.
    // Digit-free values reach the vocabulary test, and only the boundaries can then catch them.
    name: 'a placeholder word buried inside a credential does not excuse it',
    files: { ...base, '.env.example': 'SESSION_SECRET=fixture_NotThereYet\nDB_PASSWORD=stub_SampleSecure\n' },
    expect: 'fail',
    expectWhy: /filled-in credential/,
  });
  cases.push({
    // The delimiter set the whole-token rule needs (`/`, `+`, `_`, `-`) is also the base64 and
    // base64url alphabet, so a vocabulary word can sit whole inside a random secret. Three values,
    // one per delimiter that opened the hole; measured 2026-09-07 with random values, all three
    // passed as placeholders. THE VALUES HERE ARE READABLE WORDS ON PURPOSE: the shape the rule
    // tests is sixteen-plus base64 characters carrying upper case, lower case and a digit around
    // a whole placeholder token, and words meet it, while the random originals tripped the
    // repo's commit-time secret scanner three times over (high entropy, and a `PASSWORD=`
    // line). The `fixture_` and `stub_` prefixes serve that same scanner, load bearing as above.
    name: 'a placeholder word between base64 characters does not excuse a credential either',
    files: { ...base, '.env.example': 'API_SECRET=fixture_Base64Line1/here/Base64Line2==\nDB_PASSWORD=stub_Sample1+todo+Sample2Secure\nAUTH_TOKEN=stub_Token1_here_Token2Token3\n' },
    expect: 'fail',
    expectWhy: /API_SECRET looks like a filled-in[\s\S]*DB_PASSWORD looks like a filled-in[\s\S]*AUTH_TOKEN looks like a filled-in/,
  });
  cases.push({
    // The negative space of the control above: a title-case placeholder that happens to hold a
    // digit and run past sixteen characters is still a placeholder, because its digits sit in a
    // segment of their own. Without this control the credential-shape rule could be widened to
    // "any run with a digit" and every control would stay green. The `fixture_` prefix on the
    // second value is for the commit-time secret scanner again, which read the bare form as a
    // high-entropy API key; it changes nothing this control proves.
    name: 'a title-case placeholder with a year in it is still a placeholder',
    files: { ...base, '.env.example': 'SESSION_SECRET=Replace_With_A_Real_Key_2024\nAPI_KEY=fixture_Your_Key_Here_2024\n' },
    expect: 'clean',
  });
  cases.push({
    // A mask repeats one letter around a digit (`4xxx`, `yxxx`); a secret's segments carry several.
    // The whole-token rule already reads `xxxx` as a placeholder, so this pins that the shape rule
    // does not fire first and take that answer away. The `fixture_` prefix is for the commit-time
    // scanner, which reads a bare `API_KEY=<36 mask characters>` line as a key; it changes nothing
    // here, since `fixture` is in no vocabulary and the mask's segments are what the rule reads.
    name: 'a UUID mask placeholder is still a placeholder',
    files: { ...base, '.env.example': 'API_KEY=fixture_xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx\n' },
    expect: 'clean',
  });
  // Breaking tests from the 2026-09-07 review. The first is the shape the issuer rules miss: a
  // Stripe-looking key too short for the Stripe rule's 16-character tail, whose `test` token had
  // excused it as a placeholder until the credential-shape rule. The other two are placeholders
  // that carry a digit and must stay placeholders: a two-character version tag is not a mixed
  // segment, and an angle-bracket value is judged whole.
  //
  // The values below are shaped for a PRE-PUSH secret scanner as well
  // (no-secrets): it reads any `API_KEY=` value of twenty-plus plain characters as a key and any
  // `sk_test_` plus ten as a Stripe key, and excuses a value only when it holds a fixture word
  // (`fixture`, `your_key`, `xxxx`, not `stub`). So the issuer-shaped value opens with `fixture_`
  // and keeps a nine-character tail, still short of the gate's own rule, and the version-tag
  // placeholder is `your_key_here_v2`. Measured 2026-09-07 on a refused push; the pre-commit
  // scanner had accepted the earlier forms, so both scanners have to be satisfied, not one.
  cases.push({
    name: 'an issuer-shaped key below the issuer rule length is still a credential',
    files: { ...base, '.env.example': 'API_KEY=fixture_sk_test_51H8xK2Lm\n' },
    expect: 'fail',
    expectWhy: /filled-in credential/,
  });
  cases.push({
    name: 'a placeholder with a short version tag is still a placeholder',
    files: { ...base, '.env.example': 'API_KEY=your_key_here_v2\nSESSION_SECRET=<paste-your-secret-2024-here>\n' },
    expect: 'clean',
  });
  cases.push({
    name: 'a long value under a NON-secret key name is not flagged',
    files: { ...base, '.env.example': 'ALLOWED_ORIGINS=https://a.internal,https://b.internal,https://c.internal\n' },
    expect: 'clean',
  });

  // Scanning scope, both directions.
  cases.push({
    name: 'dependency and build trees are not scanned for reads',
    files: {
      ...base,
      'node_modules/lib/index.js': 'const k = process.env.LIB_ONLY_KEY;\n',
      'dist/bundle.js': 'const k = process.env.BUILT_KEY;\n',
      'src/a.js': 'export const x = 1;\n',
    },
    expect: 'clean',
  });
  cases.push({
    name: 'documentation is not scanned for reads',
    files: { ...base, 'README.md': 'Set `process.env.DOC_EXAMPLE_KEY` to enable it.\n', 'src/a.js': 'export const x = 1;\n' },
    expect: 'clean',
  });
  // BOTH FIXTURES BELOW ARE COPIED FROM REAL REPOS, not invented. `FAKE_VAR` in an adversarial
  // test file and `PATHEXT` in a shell-out helper were both DEMANDED by this gate on 2026-08-22,
  // in products that were doing nothing wrong.
  cases.push({
    name: 'a var read only in a test file is not demanded',
    files: {
      ...base,
      'src/lib/schedule.test.ts': 'it("handles it", () => { process.env.FAKE_VAR = "1"; });\n',
      'test/config.test.ts': 'const base = process.env["ALLOW_LOCAL_API"];\n',
      'src/a.js': 'export const x = 1;\n',
    },
    expect: 'clean',
  });
  cases.push({
    name: 'an OS-supplied Windows variable is not demanded',
    files: { ...base, 'src/exec.ts': 'const exts = process.env.PATHEXT;\nconst home = process.env.USERPROFILE;\n' },
    expect: 'clean',
  });
  // OPTIONAL vs REQUIRED, controlled in BOTH directions. The wrapper-call form is the shape that
  // actually appears in the repo (`verify-ship.mjs`), so it is the fixture rather than the bare
  // one, and the destructure default is here because it reaches a different branch of readsIn.
  // Three exclusions, three fixtures, each copied from a real repo where the gate was wrong.
  cases.push({
    name: "a Cloudflare Workers binding is not demanded (c.env is not .env)",
    files: { ...base, 'worker/routes/data.ts': 'app.get("/", (c) => c.env.DB.prepare(c.env.APP_CONFIG));\n' },
    expect: 'clean',
  });
  cases.push({
    name: "Vite's built-in import.meta.env fields are not demanded",
    files: { ...base, 'src/hooks/useAppData.ts': 'if (import.meta.env.DEV) console.warn("dev");\nconst m = import.meta.env.MODE;\n' },
    expect: 'clean',
  });
  cases.push({
    name: "the scaffold's own tooling does not drive the product's example file",
    files: {
      ...base,
      'verify-ship.mjs': 'const t = Number(process.env.VERIFY_SHIP_TIMEOUT_MS);\n',
      'scripts/a11y-live.mjs': 'const base = process.env.A11Y_BASE_URL;\n',
    },
    expect: 'clean',
  });
  cases.push({
    name: 'a var read with a fallback is optional, not demanded',
    files: {
      ...base,
      'verify-ship.mjs': 'const t = Number(process.env.VERIFY_SHIP_TIMEOUT_MS) || 30 * 60 * 1000;\n',
      'src/b.ts': 'const lvl = process.env.LOG_LEVEL ?? "info";\n',
      'src/c.ts': 'const { PORT = 3000 } = process.env;\n',
    },
    expect: 'clean',
  });
  // TWO controls, because the upgrade is implemented TWICE and the two merges are separate code.
  // The within-file merge lives in addRead, the across-file merge in scan. A two-FILE fixture
  // cannot redden the within-file rule, so the mutation sweep reported that one as an ESCAPE until
  // this same-file fixture existed: the scan-level merge was quietly covering for it.
  cases.push({
    name: 'one unguarded read outranks a guarded one in the SAME file',
    files: {
      ...base,
      '.env.example': 'UNRELATED=\n',
      'src/one.ts': 'const a = process.env.API_BASE || "http://localhost";\nconst b = process.env.API_BASE;\n',
    },
    expect: 'fail',
    expectWhy: /API_BASE is read by/,
  });
  cases.push({
    name: 'one unguarded read makes a var required despite a guarded one elsewhere',
    // An example file must EXIST here, holding something else. Without one the verdict collapses
    // into the single "no example file" finding, which never names a key, so the assertion below
    // would be testing the wrong branch.
    files: {
      ...base,
      '.env.example': 'UNRELATED=\n',
      'src/a.ts': 'const a = process.env.API_BASE || "http://localhost";\n',
      'src/b.ts': 'const b = process.env.API_BASE;\n',
    },
    expect: 'fail',
    expectWhy: /API_BASE is read by/,
  });

  // --write, one control per thing it does and one per thing it must NOT do.
  cases.push({
    name: '--write creates the example file with every missing key',
    files: { ...base, 'src/db.js': 'const u = process.env.DATABASE_URL;\nconst k = process.env.STRIPE_KEY;\n' },
    write: true,
    expect: 'clean',
    expectFile: ['.env.example', /^DATABASE_URL=$/m],
  });
  cases.push({
    name: '--write leaves every value BLANK',
    files: { ...base, 'src/db.js': 'const u = process.env.DATABASE_URL;\n' },
    write: true,
    expect: 'clean',
    forbidFile: ['.env.example', /^DATABASE_URL=.+$/m],
  });
  cases.push({
    name: '--write tops up an existing file without touching its comments',
    files: { ...base, '.env.example': '# the database\nDATABASE_URL=\n', 'src/db.js': 'const u = process.env.DATABASE_URL;\nconst k = process.env.STRIPE_KEY;\n' },
    write: true,
    expect: 'clean',
    expectFile: ['.env.example', /# the database[\s\S]*STRIPE_KEY=/],
  });
  cases.push({
    name: '--write adds the ignore rules for .env',
    files: { '.gitignore': 'node_modules\n', '.env.example': 'DATABASE_URL=\n', 'src/db.js': 'const u = process.env.DATABASE_URL;\n' },
    write: true,
    expect: 'clean',
    expectFile: ['.gitignore', /^\.env$/m],
  });
  cases.push({
    name: '--write refuses to untrack a committed .env',
    files: { ...base, '.env': 'DATABASE_URL=real\n', '.env.example': 'DATABASE_URL=\n' },
    force: ['.env'],
    write: true,
    expect: 'fail',
    expectWhy: /TRACKED in git/,
  });

  // The UNKNOWN path. A directory that is not a repository must never read as clean.
  cases.push({ name: 'a non-repository is UNKNOWN, not clean', noRepo: true, expect: 'unknown' });

  // --write MUST REFUSE MID-OPERATION. Both detectors get their own control, because they cover
  // different states and a single fixture would leave one of them proving nothing.
  cases.push({
    name: '--write refuses while a merge is in progress',
    files: { ...base, 'src/db.js': 'const u = process.env.DATABASE_URL;\n' },
    gitDirFiles: { MERGE_HEAD: '0000000000000000000000000000000000000000\n' },
    write: true,
    expectRefusal: /a merge is in progress/,
  });
  cases.push({
    name: '--write refuses while the index has unmerged paths',
    files: { ...base, 'src/db.js': 'const u = process.env.DATABASE_URL;\n' },
    unmergedPath: '.gitignore',
    write: true,
    expectRefusal: /unmerged paths/,
  });
  cases.push({
    name: '--write writes normally when git is not mid-operation',
    files: { ...base, 'src/db.js': 'const u = process.env.DATABASE_URL;\n' },
    write: true,
    expect: 'clean',
    expectFile: ['.env.example', /^DATABASE_URL=$/m],
  });

  // A tracked `.env` must be reported as TRACKED and not ALSO as unignored. Without `--no-index`
  // git refuses to call any tracked path ignored, so the moment a `.env` gets committed the gate
  // would print the ignore-rule failure too and send the operator to fix a .gitignore that is
  // already correct, while the actual leak sits one line below.
  cases.push({
    name: 'a tracked .env is not ALSO reported as unignored',
    files: { ...base, '.env': 'DATABASE_URL=real\n', '.env.example': 'DATABASE_URL=\n' },
    force: ['.env'],
    expect: 'fail',
    expectWhy: /TRACKED in git/,
    forbidWhy: /not covered by the ignore rules/,
  });

  // EXIT CODES ARE THE ONLY THING A HOOK OR A CI STEP EVER SEES. Every control above asserts the
  // verdict OBJECT, which says nothing about what the process returns, and an UNKNOWN that exits 0
  // is a silent false clean of exactly the kind this gate exists to refuse.
  cases.push({ name: 'a clean scan exits 0', exitFor: { unknown: false, ok: true, findings: [], advisories: [], required: [], declared: [], scanned: 0 }, expectExit: 0 });
  cases.push({ name: 'a scan with findings exits 1', exitFor: { unknown: false, ok: false, findings: [{ kind: 'missing-key', file: '.env.example', why: 'X is read by src/a.js (node process.env.NAME) but not declared' }], advisories: [] }, expectExit: 1 });
  cases.push({ name: 'an INCOMPLETE scan with no findings exits 2', exitFor: { unknown: true, reason: 'could not enumerate', findings: [] }, expectExit: 2 });
  cases.push({ name: 'an INCOMPLETE scan WITH findings exits 1, not 2', exitFor: { unknown: true, reason: 'could not enumerate', findings: [{ kind: 'tracked-env', file: '.env', why: 'a real env file is TRACKED in git (its values are in the history)' }] }, expectExit: 1 });

  // An unrecognised flag must be refused rather than silently downgraded to a plain check. `--fix`
  // is the name many tools use for this, and swallowing it would print a clean verdict
  // on a repo where nothing was written.
  cases.push({
    name: 'an unknown flag is refused, not silently ignored',
    files: { ...base, '.env.example': 'DATABASE_URL=\n', 'src/db.js': 'const u = process.env.DATABASE_URL;\n' },
    mainArgv: ['node', 'check-env-example.mjs', '--fix'],
    expectExit: 2,
  });

  let failures = 0;
  const roots = [];

  // NAME AND DETAIL ARE SEPARATED BY A TOKEN THAT CANNOT OCCUR IN EITHER.
  //
  // The detail used to be a trailing `(...)` and the mutants harness recovered the control name by
  // stripping it. That silently failed on any detail containing its OWN parentheses, which is most
  // of them once a finding is quoted back ("env var(s)", "(node process.env.NAME)"): the harness
  // then keyed the control by the whole line, could not match the name a mutation NAMED, and
  // reported three good mutations as escapes. The mutation was fine every time; the parser was not.
  const SEP = '  ::  ';
  const emit = (ok, name, detail) => {
    if (!ok) failures++;
    console.log(`  ${ok ? 'ok     ' : 'FAIL   '} ${name}${SEP}${detail}`);
  };

  // Defined BEFORE the loop that calls it. It sat after the loop, inside the try block, working
  // only through hoisting, which is legal and reads like a bug: a cold reader meets `runCase(c)`
  // with no definition anywhere above it.
  function runCase(c) {
      let root;

      // Exit-code controls call report() directly with a hand-built verdict, so they assert the
      // MAPPING rather than re-testing a scan. Output is muted: these deliberately feed report()
      // failure objects, and their remedy text would drown the control lines this suite prints.
      if (c.exitFor) {
        const code = muted(() => report(c.exitFor));
        emit(code === c.expectExit, c.name, `expected exit ${c.expectExit}, got ${code}`);
        return;
      }

      if (c.mainArgv) {
        root = fixture(c.files, { force: c.force });
        roots.push(root);
        const cwd = process.cwd();
        let code;
        try {
          process.chdir(root);
          code = muted(() => main(c.mainArgv));
        } finally {
          process.chdir(cwd);
        }
        emit(code === c.expectExit, c.name, `expected exit ${c.expectExit}, got ${code}`);
        return;
      }

      let res;
      if (c.noRepo) {
        root = mkdtempSync(join(tmpdir(), 'env-example-norepo-'));
        roots.push(root);
        res = scan(root);
      } else {
        root = fixture(c.files, {
          force: c.force, unstaged: c.unstaged, unstageAfter: c.unstageAfter,
          gitDirFiles: c.gitDirFiles, unmergedPath: c.unmergedPath,
        });
        roots.push(root);
        if (c.write) {
          const w = muted(() => writeMode(root));
          // A refusal is its own outcome, asserted separately from a verdict. Checking only the
          // verdict here would let a refusing --write and a writing --write look identical, which
          // is precisely the confusion that let it stage a conflicted file.
          if (c.expectRefusal) {
            const got = w.refused || '(did not refuse)';
            emit(c.expectRefusal.test(got), c.name, `expected refusal matching ${c.expectRefusal}, got: ${got}`);
            return;
          }
          if (w.refused) { emit(false, c.name, `refused unexpectedly: ${w.refused}`); return; }
          res = w.res;
        } else {
          res = scan(root);
        }
      }
      const got = res.unknown ? 'unknown' : (res.ok ? 'clean' : 'fail');
      // The FILE is part of what a control asserts, not decoration: several rules produce the same
      // sentence for different paths, and the monorepo control exists purely to prove the finding
      // names `apps/web/.env` rather than the root.
      const whys = (res.findings || []).map((f) => `${f.file} <- ${f.why}`).join(' | ');
      let ok = got === c.expect;
      let detail = `expected ${c.expect}, got ${got}`;
      // A VERDICT-ONLY ASSERTION IS TOO WEAK for a suite whose fixtures share a shape. Several
      // cases would fail for the wrong reason and still read green, so a case may pin WHICH
      // finding it produced and which file content the write path left behind.
      if (ok && c.expectWhy && !c.expectWhy.test(whys)) {
        ok = false;
        detail = `expected a finding matching ${c.expectWhy}, got: ${whys || '(none)'}`;
      }
      if (ok && c.forbidWhy && c.forbidWhy.test(whys)) {
        ok = false;
        detail = `produced a finding matching ${c.forbidWhy}, which this case forbids: ${whys}`;
      }
      if (ok && c.expectFile) {
        const [rel, re] = c.expectFile;
        const body = existsSync(join(root, rel)) ? readFileSync(join(root, rel), 'utf8') : '';
        if (!re.test(body)) { ok = false; detail = `${rel} does not match ${re}`; }
      }
      if (ok && c.forbidFile) {
        const [rel, re] = c.forbidFile;
        const body = existsSync(join(root, rel)) ? readFileSync(join(root, rel), 'utf8') : '';
        if (re.test(body)) { ok = false; detail = `${rel} unexpectedly matches ${re}`; }
      }
      emit(ok, c.name, detail);
  }

  try {
    for (const c of cases) {
      // ONE BROKEN FIXTURE MUST NOT ABORT THE SUITE. A fixture that cannot build (a name the
      // platform refuses, or a rule change that makes a fixture unable to stage its own file) used
      // to throw out of this loop, so the remaining controls never ran. To the mutants harness that
      // is indistinguishable from a crash, and it scored a mutation that had correctly broken the
      // rule as an ESCAPE: measured on the mutation that narrows the ignore rules, which stops the
      // `.env.sample` fixture staging and left 25 of 65 controls unrun. A fixture failure is now a
      // failure of its OWN control, which is what it actually is.
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
  // NO "N skipped" COUNTER. One existed, was initialised to 0, and was never incremented anywhere,
  // so it printed "0 skipped" forever and read as a real measurement. Nothing in this suite skips.
  console.log(`[env-example] selftest: ${cases.length - failures}/${cases.length} controls passed`);
  return failures === 0 ? 0 : 1;
}

// --- entry point -------------------------------------------------------------------------------

function main(argv) {
  const args = argv.slice(2);
  const known = new Set(['--selftest', '--write']);
  const unknownFlags = args.filter((a) => a.startsWith('-') && !known.has(a));
  // An unrecognised flag must never be silently ignored: `--fix` (the name many tools
  // use) would otherwise run a plain check, print "clean" on a repo it changed nothing in, and the
  // operator would believe the file had been written.
  if (unknownFlags.length) {
    console.error(`[env-example] unknown flag(s): ${unknownFlags.join(', ')}`);
    console.error('[env-example] usage: check-env-example.mjs [--write | --selftest]');
    return 2;
  }
  if (args.includes('--selftest')) return selftest();
  if (args.includes('--write')) {
    const { res, changed, refused } = writeMode(process.cwd());
    if (refused) {
      console.error(`[env-example] --write REFUSED: ${refused}`);
      console.error('[env-example] Writing here would append to a file that may hold conflict');
      console.error('[env-example] markers, and staging it would mark the conflict resolved.');
      console.error('[env-example] Finish or abort the git operation, then run --write again.');
      return 2;
    }
    for (const c of changed) console.log(`[env-example] wrote ${c}`);
    if (!changed.length) console.log('[env-example] nothing to write');
    return report(res);
  }
  return report(scan(process.cwd()));
}

process.exit(main(process.argv));
