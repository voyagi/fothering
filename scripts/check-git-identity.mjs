#!/usr/bin/env node
// check-git-identity.mjs - every commit identity in this repo's history is inside an allowlist.
//
// A public repo exposes every author and committer email it ever recorded, and repos have
// paid three delete-and-recreate cycles for personal addresses discovered AFTER a push. This
// gate makes the check mechanical and pre-push: the author AND committer emails across every
// local branch and tag (everything a push can publish, not just HEAD's ancestry), plus the
// identity the NEXT commit would use, must all match the allowlist.
//
// The default allowlist is the GitHub privacy convention: any *@users.noreply.github.com
// address. Extend it - a bot identity, a second contributor - via GIT_IDENTITY_ALLOW, a
// comma-separated list where each entry is either a full email or an @suffix
// (e.g. "GIT_IDENTITY_ALLOW=ci@invalid,@users.noreply.github.com").
//
// Exit codes: 0 clean, 1 an identity outside the allowlist, 2 could not run.
// A repo with no commits yet: the history half is stated as empty and only the config half is
// judged (a wrong user.email should fail BEFORE it mints the first bad commit).
//
// Usage: node scripts/check-git-identity.mjs [--selftest]
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// noreply@github.com is GitHub's own committer on every pull request merged in the web UI, so
// without it the first merged PR reddens this gate for every branch after it. Exact match only.
const DEFAULT_ALLOW = ['@users.noreply.github.com', 'noreply@github.com'];

function allowlist() {
  const extra = String(process.env.GIT_IDENTITY_ALLOW || '')
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  return [...DEFAULT_ALLOW, ...extra];
}

function allowed(email, allow) {
  const e = email.toLowerCase();
  return allow.some((a) => (a.startsWith('@') ? e.endsWith(a) : e === a));
}

function run(cwd) {
  let emails = [];
  let historyRead = true;
  let shallow = false;
  try {
    shallow = execFileSync('git', ['rev-parse', '--is-shallow-repository'], { cwd, encoding: 'utf8', windowsHide: true }).trim() === 'true';
  } catch {
    // Not a repo, or git missing: the git log below fails the same way and reports it as UNKNOWN.
  }
  if (shallow) {
    // A shallow clone (CI's default fetch-depth: 1) holds only the newest commits, so a clean
    // result would say nothing about the rest of the history.
    console.error('[git-identity] UNKNOWN: shallow clone, older commits are missing and cannot be judged.');
    console.error('[git-identity] In CI, check out with fetch-depth: 0.');
    return 2;
  }
  try {
    // --branches --tags plus HEAD: a push can publish ANY local branch or tag, and the one
    // recreate was owed to identities that sat on branches beside main. HEAD covers a detached
    // checkout with no local branch at all, which is how CI checks out a pull request; without
    // it that run walked nothing and reported "no commits yet". Deliberately not --all: that
    // would also read refs/stash (never pushed, so a long-dead stash would redden the gate
    // forever) and remote-tracking refs (the server's already-public state).
    const out = execFileSync('git', ['log', '--branches', '--tags', 'HEAD', '--format=%ae%n%ce'], {
      cwd, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024,
    });
    emails = [...new Set(out.split('\n').map((l) => l.trim()).filter(Boolean))];
    // Zero refs to walk: --branches --tags on a commitless repo exits 0 with EMPTY output
    // (measured; bare `git log` errors instead, which the catch below still covers).
    if (emails.length === 0) historyRead = false;
  } catch (e) {
    const msg = String((e && e.stderr) || e.message || '');
    if (/does not have any commits|bad default revision|unknown revision/i.test(msg)) {
      historyRead = false; // an empty repo has no history to leak - stated, not silently skipped
    } else {
      console.error(`[git-identity] UNKNOWN: git log failed: ${msg.split('\n')[0] || 'unreadable error'}`);
      return 2;
    }
  }
  let configured = null;
  try {
    configured = execFileSync('git', ['config', '--get', 'user.email'], { cwd, encoding: 'utf8', windowsHide: true }).trim();
  } catch (e) {
    if (e.status !== 1) {
      console.error(`[git-identity] UNKNOWN: git config could not be read: ${(e.message || '').split('\n')[0]}`);
      return 2;
    }
    // Unset user.email: git would refuse to commit, so there is nothing to judge here.
  }
  const allow = allowlist();
  const bad = emails.filter((e) => !allowed(e, allow));
  const configuredBad = configured != null && !allowed(configured, allow);
  if (bad.length === 0 && !configuredBad) {
    console.log(`[git-identity] clean: ${historyRead ? `${emails.length} distinct identit${emails.length === 1 ? 'y' : 'ies'} in history` : 'no commits yet'}` +
      `${configured ? `, and the configured user.email (${configured}) is allowed` : ''}.`);
    return 0;
  }
  if (bad.length) {
    console.error(`[git-identity] ${bad.length} identit${bad.length === 1 ? 'y' : 'ies'} in HISTORY outside the allowlist:`);
    for (const e of bad) console.error(`  ${e}`);
    console.error('[git-identity] History cannot be cleaned by a new commit: fixing this on a repo that was');
    console.error('[git-identity] ever pushed means the SHIP-SAFE section 3 history remedy, not an amend.');
  }
  if (configuredBad) {
    console.error(`[git-identity] the configured user.email (${configured}) is outside the allowlist: the NEXT commit would leak it.`);
    console.error('[git-identity] Set the privacy identity first: git config user.email "<id>+<login>@users.noreply.github.com"');
  }
  return 1;
}

// --- selftest ---------------------------------------------------------------
function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();
}
function repo(email) {
  const root = mkdtempSync(join(tmpdir(), 'git-identity-st-'));
  git(['init'], root);
  const noHooks = join(root, '.no-hooks');
  mkdirSync(noHooks);
  git(['config', 'core.hooksPath', noHooks], root);
  git(['config', 'commit.gpgsign', 'false'], root);
  git(['config', 'user.name', 'selftest'], root);
  if (email) {
    git(['config', 'user.email', email], root);
    writeFileSync(join(root, 'a.txt'), 'x\n');
    git(['add', '-A'], root);
    git(['commit', '-m', 'fixture'], root);
  }
  return root;
}
function selftest() {
  const self = fileURLToPath(import.meta.url);
  let failures = 0;
  const roots = [];
  const runCli = (cwd, env = {}) => {
    try {
      const out = execFileSync(process.execPath, [self], {
        cwd, encoding: 'utf8', windowsHide: true, stdio: 'pipe',
        env: { ...process.env, GIT_IDENTITY_ALLOW: '', ...env },
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
    let r = repo('12345+someone@users.noreply.github.com');
    roots.push(r);
    check('a no-reply history is clean', runCli(r), 0, /clean: 1 distinct identity/);
    r = repo('person@gmail.example');
    roots.push(r);
    check('a personal address in history fails', runCli(r), 1, /in HISTORY outside the allowlist/);
    {
      // The side-branch shape: main is clean, the leak sits on a side branch a push would publish.
      const r2 = repo('12345+someone@users.noreply.github.com');
      roots.push(r2);
      git(['checkout', '-q', '-b', 'feature'], r2);
      git(['config', 'user.email', 'person@gmail.example'], r2);
      writeFileSync(join(r2, 'b.txt'), 'y\n');
      git(['add', '-A'], r2);
      git(['commit', '-m', 'side'], r2);
      git(['config', 'user.email', '12345+someone@users.noreply.github.com'], r2);
      git(['checkout', '-q', '-'], r2);
      check('a leaked identity on a SIDE branch fails', runCli(r2), 1, /in HISTORY outside the allowlist/);
    }
    {
      // A web-UI merge: the author is the owner's no-reply address, the committer is GitHub itself.
      const r3 = repo('12345+someone@users.noreply.github.com');
      roots.push(r3);
      writeFileSync(join(r3, 'c.txt'), 'z\n');
      git(['add', '-A'], r3);
      execFileSync('git', ['commit', '-q', '-m', 'merge'], {
        cwd: r3, windowsHide: true, env: { ...process.env, GIT_COMMITTER_NAME: 'GitHub', GIT_COMMITTER_EMAIL: 'noreply@github.com' },
      });
      check('a GitHub web-merge committer is clean', runCli(r3), 0, /clean: 2 distinct identities/);
      const r4 = repo('prefix.noreply@github.com');
      roots.push(r4);
      check('a lookalike of the GitHub committer still fails', runCli(r4), 1, /in HISTORY outside the allowlist/);
    }
    r = repo('12345+someone@users.noreply.github.com');
    roots.push(r);
    git(['config', 'user.email', 'person@gmail.example'], r);
    check('a bad CONFIGURED email fails before it mints a commit', runCli(r), 1, /the NEXT commit would leak it/);
    r = repo('bot@ci.example');
    roots.push(r);
    check('GIT_IDENTITY_ALLOW extends the allowlist with a full email',
      runCli(r, { GIT_IDENTITY_ALLOW: 'bot@ci.example' }), 0, /clean/);
    r = repo('someone@company.example');
    roots.push(r);
    check('GIT_IDENTITY_ALLOW extends the allowlist with an @suffix',
      runCli(r, { GIT_IDENTITY_ALLOW: '@company.example' }), 0, /clean/);
    r = repo(null);
    roots.push(r);
    git(['config', 'user.email', '12345+someone@users.noreply.github.com'], r);
    check('an empty repo with a good config is clean and says no commits yet', runCli(r), 0, /no commits yet/);
    r = repo(null);
    roots.push(r);
    git(['config', 'user.email', 'person@gmail.example'], r);
    check('an empty repo with a bad config still fails', runCli(r), 1, /NEXT commit would leak/);
    const notRepo = mkdtempSync(join(tmpdir(), 'git-identity-st-nr-'));
    roots.push(notRepo);
    check('a non-repo is UNKNOWN, exit 2', runCli(notRepo), 2, /UNKNOWN/);
    {
      // The CI pull request shape: HEAD detached on a commit and no local branch left pointing at it.
      const r5 = repo('person@gmail.example');
      roots.push(r5);
      const branch = git(['symbolic-ref', '--short', 'HEAD'], r5);
      git(['checkout', '-q', '--detach'], r5);
      git(['update-ref', '-d', `refs/heads/${branch}`], r5);
      git(['config', 'user.email', '12345+someone@users.noreply.github.com'], r5);
      check('a leak on a detached HEAD with no branch still fails', runCli(r5), 1, /in HISTORY outside the allowlist/);
    }
    {
      // A shallow clone hides older commits, so it must not read as clean.
      const src = repo('12345+someone@users.noreply.github.com');
      roots.push(src);
      writeFileSync(join(src, 'd.txt'), 'w\n');
      git(['add', '-A'], src);
      git(['commit', '-q', '-m', 'second'], src);
      const dest = mkdtempSync(join(tmpdir(), 'git-identity-st-shallow-'));
      roots.push(dest);
      // --no-local, not a file:// URL: Git for Windows misreads file:///C:/..., and a plain local
      // path clone ignores --depth.
      git(['-c', `core.hooksPath=${join(src, '.no-hooks')}`, 'clone', '-q', '--no-local', '--depth', '1', src, dest], src);
      check('a shallow clone is UNKNOWN, exit 2', runCli(dest), 2, /UNKNOWN: shallow clone/);
    }
  } finally {
    for (const r of roots) { try { rmSync(r, { recursive: true, force: true }); } catch {} }
  }
  if (failures) {
    console.error(`\n[git-identity] SELFTEST FAILED (${failures}). Do not trust this gate.`);
    return 1;
  }
  console.log('\n[git-identity] selftest passed: leaks fail in history and in config, allowed identities pass.');
  return 0;
}

if (process.argv.includes('--selftest')) {
  process.env.GIT_STRIP_CANARY = 'planted';
  for (const key of Object.keys(process.env)) {
    if (key.toUpperCase().startsWith('GIT_')) delete process.env[key];
  }
  if (process.env.GIT_STRIP_CANARY !== undefined) {
    console.error('[git-identity] the GIT_* environment strip did not run; refusing to build fixtures.');
    process.exit(2);
  }
  process.exit(selftest());
}
process.exit(run(process.cwd()));
