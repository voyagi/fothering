#!/usr/bin/env node
// check-hookspath.mjs - a repo-local core.hooksPath must not sever the global hook chain.
//
// The machine-wide git hooks (secret scan, the AI-tell gate, the lane guard) run because
// core.hooksPath is set GLOBALLY. Adopting husky - or any tool that writes a LOCAL
// core.hooksPath - silently replaces that chain wholesale for this one repo: every global
// gate stops running, nothing prints a word, and the first sign is a leaked commit. This gate
// makes that severing loud: the repo's EFFECTIVE hooksPath must equal the global one.
//
// On a machine with NO global hooksPath (CI runners, a cloner's laptop) there is no chain to
// sever, so the gate prints SKIPPED and exits 0 - it guards the developer machine, and on any
// other machine it must not fail the build for a config that machine never had.
//
// Exit codes: 0 intact or SKIPPED, 1 severed (local override differs), 2 could not run.
//
// Usage: node scripts/check-hookspath.mjs [--selftest]
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

function gitConfig(args, cwd) {
  // `git config --get` exits 1 for "key not set", which is data here, not an error.
  try {
    return execFileSync('git', ['config', ...args], { cwd, encoding: 'utf8', windowsHide: true }).trim();
  } catch (e) {
    if (e.status === 1) return null;
    throw e;
  }
}

// Path equality, not string equality: the same directory can be written C:/x, C:\x, or with a
// trailing slash, and a false SEVERED on spelling would teach people to delete the gate.
function normalize(p) {
  if (p == null) return null;
  return p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

function run(cwd) {
  let global, effective;
  try {
    global = gitConfig(['--global', '--get', 'core.hooksPath'], cwd);
    effective = gitConfig(['--get', 'core.hooksPath'], cwd);
  } catch (e) {
    console.error(`[hookspath] UNKNOWN: git config could not be read: ${(e.message || '').split('\n')[0]}`);
    return 2;
  }
  if (global == null) {
    console.log('[hookspath] SKIPPED: no global core.hooksPath on this machine, so there is no global hook chain to sever. Nothing verified.');
    return 0;
  }
  if (normalize(effective) === normalize(global)) {
    console.log(`[hookspath] intact: the effective core.hooksPath is the global chain (${global}).`);
    return 0;
  }
  console.error(`[hookspath] SEVERED: this repo's effective core.hooksPath is "${effective}" while the global chain is "${global}".`);
  console.error('[hookspath] A local core.hooksPath (husky sets one by default) replaces the global hooks');
  console.error('[hookspath] WHOLESALE: the secret scan and every other machine-wide gate stop running for');
  console.error('[hookspath] this repo. Remove the local override (git config --unset core.hooksPath) and');
  console.error('[hookspath] chain any repo-local hooks from .git/hooks/, which the global chain calls.');
  return 1;
}

// --- selftest ---------------------------------------------------------------
// Hermetic via GIT_CONFIG_GLOBAL: git reads its "global" config from that file when set, so the
// selftest never touches the machine's real global config.
function selftest() {
  const self = fileURLToPath(import.meta.url);
  let failures = 0;
  const roots = [];
  const repo = () => {
    const root = mkdtempSync(join(tmpdir(), 'check-hookspath-st-'));
    roots.push(root);
    execFileSync('git', ['init'], { cwd: root, windowsHide: true, stdio: 'pipe' });
    return root;
  };
  const globalFile = (hooksPath) => {
    const dir = mkdtempSync(join(tmpdir(), 'check-hookspath-st-g-'));
    roots.push(dir);
    const file = join(dir, 'gitconfig');
    writeFileSync(file, hooksPath == null ? '' : `[core]\n\thooksPath = ${hooksPath.replace(/\\/g, '/')}\n`);
    return file;
  };
  const runCli = (cwd, gcfg) => {
    try {
      const out = execFileSync(process.execPath, [self], {
        cwd, encoding: 'utf8', windowsHide: true, stdio: 'pipe',
        env: { ...process.env, GIT_CONFIG_GLOBAL: gcfg },
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
  try {
    const chain = mkdtempSync(join(tmpdir(), 'check-hookspath-st-chain-'));
    roots.push(chain);

    check('no global hooksPath is a loud SKIPPED, exit 0',
      runCli(repo(), globalFile(null)), 0, /SKIPPED: no global core\.hooksPath/);

    check('global set, no local override: intact',
      runCli(repo(), globalFile(chain)), 0, /intact/);

    {
      const r = repo();
      execFileSync('git', ['config', 'core.hooksPath', '.husky/_'], { cwd: r, windowsHide: true, stdio: 'pipe' });
      check('a local husky-style override is SEVERED, exit 1',
        runCli(r, globalFile(chain)), 1, /SEVERED/);
    }
    {
      // Same directory, different spelling: backslashes and a trailing slash must not read as
      // severed, or the gate cries wolf on Windows and gets deleted.
      const r = repo();
      execFileSync('git', ['config', 'core.hooksPath', chain.replace(/\//g, '\\') + '\\'], { cwd: r, windowsHide: true, stdio: 'pipe' });
      check('the same path in a different spelling is intact',
        runCli(r, globalFile(chain)), 0, /intact/);
    }
    {
      const notRepo = mkdtempSync(join(tmpdir(), 'check-hookspath-st-nr-'));
      roots.push(notRepo);
      // Outside a repo the effective read equals the global read, so the gate still answers.
      check('outside a repo the gate still reads the global chain as intact',
        runCli(notRepo, globalFile(chain)), 0, /intact/);
    }
  } finally {
    for (const r of roots) { try { rmSync(r, { recursive: true, force: true }); } catch {} }
  }
  if (failures) {
    console.error(`\n[hookspath] SELFTEST FAILED (${failures}). Do not trust this gate.`);
    return 1;
  }
  console.log('\n[hookspath] selftest passed: severing is loud, spelling differences are not.');
  return 0;
}

if (process.argv.includes('--selftest')) {
  // Strip repo-pinning GIT_* vars EXCEPT the one the selftest sets itself.
  process.env.GIT_STRIP_CANARY = 'planted';
  for (const key of Object.keys(process.env)) {
    if (key.toUpperCase().startsWith('GIT_')) delete process.env[key];
  }
  if (process.env.GIT_STRIP_CANARY !== undefined) {
    console.error('[hookspath] the GIT_* environment strip did not run; refusing to build fixtures.');
    process.exit(2);
  }
  process.exit(selftest());
}
process.exit(run(process.cwd()));
