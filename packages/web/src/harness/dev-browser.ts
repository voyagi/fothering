import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const DEV_BROWSER_VERSION = '0.2.9';
export const AXE_VERSION = '4.14.0';
// A valid expression on its own, so the committed template lints and parses before any job is in it.
export const DRIVER_JOB_TOKEN = '/* fothering-job */ null';
const BROWSER_INSTANCE = 'fothering-site';
// The launcher's own --timeout ends the script first; this outer bound is for a launcher that hangs.
const OUTER_TIMEOUT_GRACE_MS = 30_000;

export type LocateResult =
  | { readonly ok: true; readonly launcher: string }
  | { readonly ok: false; readonly reason: 'missing'; readonly path: string }
  | { readonly ok: false; readonly reason: 'version'; readonly found: string };

export type StageResult =
  | { readonly ok: true; readonly name: string; readonly path: string; readonly remove: () => void }
  | { readonly ok: false; readonly reason: 'missing'; readonly path: string }
  | { readonly ok: false; readonly reason: 'version'; readonly found: string };

export type WriteResult =
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly tokens: number };

export interface DriverRun {
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly stdoutLines: readonly string[];
  readonly stderr: string;
}

function versionAt(manifest: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(manifest, 'utf8'));
    return typeof parsed === 'object' && parsed !== null && 'version' in parsed ? String(parsed.version) : 'unreadable';
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? undefined : 'unreadable';
  }
}

// The Node launcher is spawned rather than a shim: it execs the native binary with inherited stdio
// and forwards its exit code, so Windows and Linux run the same way with no shell in between.
export function locateDevBrowser(globalModules: string): LocateResult {
  const packageDir = join(globalModules, 'dev-browser');
  const found = versionAt(join(packageDir, 'package.json'));
  if (found === undefined) return { ok: false, reason: 'missing', path: packageDir };
  if (found !== DEV_BROWSER_VERSION) return { ok: false, reason: 'version', found };
  const launcher = join(packageDir, 'bin', 'dev-browser.js');
  if (!existsSync(launcher)) return { ok: false, reason: 'missing', path: launcher };
  return { ok: true, launcher };
}

// The sandbox can read files only from ~/.dev-browser/tmp/, a folder every session shares, so the
// copy gets a name no other run can collide with and the caller removes it in a finally block.
// axe-core is read from the repo's own node_modules, never resolved upwards, so a planted repo in
// a test cannot pick up the real installation by accident.
export function stageAxeSource(repoRoot: string, homeDir: string): StageResult {
  const packageDir = join(repoRoot, 'node_modules', 'axe-core');
  const found = versionAt(join(packageDir, 'package.json'));
  const source = join(packageDir, 'axe.min.js');
  if (found === undefined || !existsSync(source)) return { ok: false, reason: 'missing', path: source };
  if (found !== AXE_VERSION) return { ok: false, reason: 'version', found };
  const tmp = join(homeDir, '.dev-browser', 'tmp');
  mkdirSync(tmp, { recursive: true });
  const name = `fothering-axe-${process.pid}-${randomUUID()}.js`;
  const path = join(tmp, name);
  copyFileSync(source, path);
  return { ok: true, name, path, remove: () => rmSync(path, { force: true }) };
}

// The job enters the driver as one JSON literal in place of the one token, so job data can never
// become driver code. split/join rather than replace(), whose replacement string expands `$&`.
export function writeDriver(templatePath: string, job: unknown, outPath: string): WriteResult {
  const parts = readFileSync(templatePath, 'utf8').split(DRIVER_JOB_TOKEN);
  if (parts.length !== 2) return { ok: false, tokens: parts.length - 1 };
  writeFileSync(outPath, parts.join(JSON.stringify(job)));
  return { ok: true, path: outPath };
}

function killTree(pid: number | undefined): void {
  if (pid === undefined) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    // Already gone.
  }
}

export interface RunDriverOptions {
  readonly launcher: string;
  readonly driverPath: string;
  readonly timeoutSeconds: number;
  readonly outerTimeoutMs?: number;
}

export function runDriver(options: RunDriverOptions): Promise<DriverRun> {
  const args = [options.launcher, '--headless', '--timeout', String(options.timeoutSeconds), '--browser', BROWSER_INSTANCE, 'run', options.driverPath];
  // detached on POSIX puts the launcher and the native binary in one process group, so the timeout
  // kill below reaches both by the launcher's PID; on Windows taskkill /T does the same.
  const child = spawn(process.execPath, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false,
    windowsHide: true,
    detached: process.platform !== 'win32',
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
  return new Promise((resolveRun) => {
    let timedOut = false;
    let settled = false;
    const settle = (exitCode: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveRun({ exitCode, timedOut, stdoutLines: stdout.split(/\r?\n/), stderr });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
      child.stdout.destroy();
      child.stderr.destroy();
      settle(null);
    }, options.outerTimeoutMs ?? options.timeoutSeconds * 1000 + OUTER_TIMEOUT_GRACE_MS);
    child.on('error', (error) => {
      stderr += `${error.message}\n`;
      settle(null);
    });
    child.on('close', (code) => settle(code));
  });
}
