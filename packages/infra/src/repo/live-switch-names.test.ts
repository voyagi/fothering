import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import { afterAll, describe, expect, it } from 'vitest';
import { LIVE_SWITCH } from '@fothering/core/mode';

// This file lives at packages/infra/src/repo/, four levels below the repo root.
const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const CHECK_ENV_SCRIPT = join(REPO_ROOT, 'scripts', 'check-env-example.mjs');

// The only files the switch's literal name is allowed to appear in. packages/infra/src/live-switch.ts
// does not exist yet (a later plan writes the CDK construct that reads it as a context key), so its
// absence from the tracked-file scan is expected, not a gap.
const ALLOWED_FILES = new Set([
  'packages/core/src/mode.ts',
  'packages/core/src/mode.test.ts',
  'packages/providers/src/live-switch.ts',
  'packages/infra/src/live-switch.ts',
  'README.md',
  '.env.example',
]);

const BINARY_EXT_RE = /\.(png|jpe?g|gif|ico|pdf|woff2?|ttf|eot|zip)$/i;

function trackedFiles(): string[] {
  const raw = execFileSync('git', ['ls-files', '-z'], { cwd: REPO_ROOT, encoding: 'utf8' });
  return raw.split('\0').filter(Boolean).filter((f) => !BINARY_EXT_RE.test(f));
}

interface FileText {
  path: string;
  text: string;
}

// Exported in shape only for the test below: this is the local helper the plan asks for, kept
// beside the one test that exercises it rather than a separate module nothing else imports.
function findLiteralOutsideAllowlist(files: ReadonlyArray<FileText>, allowlist: ReadonlySet<string>): string[] {
  return files.filter((f) => f.text.includes(LIVE_SWITCH) && !allowlist.has(f.path)).map((f) => f.path);
}

describe('the switch name lives only in the named files', () => {
  const files: FileText[] = trackedFiles().map((path) => ({ path, text: readFileSync(join(REPO_ROOT, path), 'utf8') }));
  const holders = files.filter((f) => f.text.includes(LIVE_SWITCH)).map((f) => f.path);

  it('is a subset of the named list, and covers every file that must carry it', () => {
    for (const holder of holders) {
      expect(ALLOWED_FILES.has(holder), `${holder} holds the literal but is not in the named list`).toBe(true);
    }
    for (const required of ['packages/core/src/mode.ts', 'packages/providers/src/live-switch.ts', 'README.md', '.env.example']) {
      expect(holders, `expected ${required} to hold the literal`).toContain(required);
    }
  });

  it('the planted-map control finds a literal in a file outside the allowlist, and finds none without it', () => {
    const clean: FileText[] = [{ path: 'packages/core/src/mode.ts', text: `export const LIVE_SWITCH = '${LIVE_SWITCH}';\n` }];
    const planted: FileText[] = [...clean, { path: 'packages/functions/src/planted.ts', text: `const x = '${LIVE_SWITCH}';\n` }];
    expect(findLiteralOutsideAllowlist(clean, ALLOWED_FILES)).toEqual([]);
    expect(findLiteralOutsideAllowlist(planted, ALLOWED_FILES)).toEqual(['packages/functions/src/planted.ts']);
  });

  it('the literal process.env read of the switch appears exactly once, in packages/providers/src/live-switch.ts', () => {
    const readRe = new RegExp(`process\\.env(?:\\.${LIVE_SWITCH}\\b|\\[\\s*['"\`]${LIVE_SWITCH}['"\`]\\s*\\])`, 'g');
    const hits: Array<{ file: string; count: number }> = [];
    for (const f of files) {
      if (!f.path.endsWith('.ts')) continue;
      const count = (f.text.match(readRe) ?? []).length;
      if (count > 0) hits.push({ file: f.path, count });
    }
    expect(hits).toEqual([{ file: 'packages/providers/src/live-switch.ts', count: 1 }]);
  });

  it('.env.example declares the switch on a line that is exactly the name, an equals sign, and nothing else', () => {
    const text = readFileSync(join(REPO_ROOT, '.env.example'), 'utf8');
    expect(text.split(/\r?\n/)).toContain(`${LIVE_SWITCH}=`);
  });
});

describe('lint rejects an environment comparison to live outside mode.ts', () => {
  async function lintMessages(code: string, relPath: string): Promise<Array<{ ruleId: string | null; message: string }>> {
    const eslint = new ESLint({ cwd: REPO_ROOT });
    const results = await eslint.lintText(code, { filePath: join(REPO_ROOT, relPath), warnIgnored: true });
    expect(results.length).toBe(1);
    const ignored = results[0]?.messages.find((m) => m.ruleId === null && /ignored/i.test(m.message));
    expect(ignored, `expected ${relPath} to be linted, not ignored: ${ignored?.message ?? ''}`).toBeUndefined();
    return results[0]?.messages ?? [];
  }
  function ruleIds(messages: Array<{ ruleId: string | null }>): Array<string | null> {
    return messages.map((m) => m.ruleId);
  }

  const FORMS: Array<[string, string]> = [
    ["process.env.X === 'live'", "if (process.env.X === 'live') { }\n"],
    ["'live' === process.env.X", "if ('live' === process.env.X) { }\n"],
    ["process.env['X'] !== 'live'", "if (process.env['X'] !== 'live') { }\n"],
    ["env.X == 'live'", "const env = {};\nif (env.X == 'live') { }\n"],
  ];

  it.each(FORMS)('flags %s outside mode.ts, and passes the same text inside it', async (_label, code) => {
    expect(ruleIds(await lintMessages(code, 'packages/functions/src/planted-env.ts'))).toContain('no-restricted-syntax');
    expect(ruleIds(await lintMessages(code, 'packages/core/src/mode.ts'))).not.toContain('no-restricted-syntax');
  });
});

describe('removing the switch line from .env.example fails the env gate', () => {
  const dirs: string[] = [];
  afterAll(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  function buildFixture(envExampleBody: string): string {
    const dir = mkdtempSync(join(tmpdir(), 'live-switch-gate-st-'));
    dirs.push(dir);
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'fixture', private: true }, null, 2));
    writeFileSync(join(dir, '.gitignore'), '.env\n.env.*\n!.env.example\n');
    writeFileSync(join(dir, '.env.example'), envExampleBody);
    mkdirSync(join(dir, 'packages', 'providers', 'src'), { recursive: true });
    writeFileSync(join(dir, 'packages', 'providers', 'src', 'live-switch.ts'), readFileSync(join(REPO_ROOT, 'packages', 'providers', 'src', 'live-switch.ts')));
    execFileSync('git', ['init', '-q'], { cwd: dir });
    execFileSync('git', ['add', '-A'], { cwd: dir });
    return dir;
  }

  function runGateEnv(dir: string): { status: number; output: string } {
    try {
      const stdout = execFileSync(process.execPath, [CHECK_ENV_SCRIPT], { cwd: dir, encoding: 'utf8' });
      return { status: 0, output: stdout };
    } catch (e) {
      const failure = e as { status?: number | null; stdout?: string; stderr?: string };
      return { status: failure.status ?? 1, output: `${failure.stdout ?? ''}${failure.stderr ?? ''}` };
    }
  }

  it('exits 0 with the switch declared, and non-zero naming it once the line is gone', () => {
    const withSwitch = buildFixture(`${LIVE_SWITCH}=\n`);
    expect(runGateEnv(withSwitch).status).toBe(0);

    const withoutSwitch = buildFixture('\n');
    const result = runGateEnv(withoutSwitch);
    expect(result.status).not.toBe(0);
    expect(result.output).toContain(LIVE_SWITCH);
  });
});
