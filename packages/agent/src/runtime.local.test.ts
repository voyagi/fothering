import { build } from 'esbuild';
import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { copyFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

// This file lives at packages/agent/src/, two levels below the repo root every path here is
// read relative to.
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const BUILD_SCRIPT = join(REPO_ROOT, 'scripts', 'build.mjs');
const AGENTCORE_APP_JS = join(REPO_ROOT, 'node_modules', 'bedrock-agentcore', 'dist', 'src', 'runtime', 'app.js');
const CREATE_REQUIRE_LINE = 'const require = createRequire(import.meta.url);';
const CHILD_TIMEOUT_MS = 60000;
const SESSION_HEADER = 'x-amzn-bedrock-agentcore-runtime-session-id';

interface CommandResult {
  status: number;
  combined: string;
}

function runBuild(args: string[]): CommandResult {
  try {
    const stdout = execFileSync(process.execPath, [BUILD_SCRIPT, ...args], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      timeout: CHILD_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { status: 0, combined: stdout };
  } catch (error) {
    const failure = error as { status?: number | null; stdout?: string; stderr?: string };
    return { status: failure.status ?? 1, combined: `${failure.stdout ?? ''}${failure.stderr ?? ''}` };
  }
}

function findFreePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as AddressInfo | null;
      if (address === null) {
        reject(new Error('expected an AddressInfo from an ephemeral listen'));
        return;
      }
      const { port } = address;
      server.close(() => resolvePort(port));
    });
  });
}

async function waitForOk(url: string, deadlineMs: number): Promise<Response> {
  const start = Date.now();
  for (;;) {
    try {
      return await fetch(url);
    } catch (error) {
      if (Date.now() - start > deadlineMs) throw error;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 200));
    }
  }
}

describe('the agent bundle answers the AgentCore contract with no model and no AWS client', () => {
  const outDir = mkdtempSync(join(tmpdir(), 'fothering-agent-bundle-'));
  const workDir = mkdtempSync(join(tmpdir(), 'fothering-agent-work-'));
  let child: ChildProcess | undefined;

  afterAll(() => {
    child?.kill();
    rmSync(outDir, { recursive: true, force: true });
    rmSync(workDir, { recursive: true, force: true });
  });

  it(
    'node scripts/build.mjs --only agent --outdir writes exactly one main.js, valid as CommonJS, no native module',
    () => {
      const { status, combined } = runBuild(['--only', 'agent', '--outdir', outDir]);
      expect(status, combined).toBe(0);
      expect(readdirSync(outDir)).toEqual(['main.js']);
      expect(readdirSync(outDir).some((name) => name.endsWith('.node'))).toBe(false);

      // The .cjs extension forces CommonJS parsing regardless of any package.json above it, while
      // a .js file can still be read as ESM by Node's own module-syntax detection (D-32).
      const asCjs = join(workDir, 'main.cjs');
      copyFileSync(join(outDir, 'main.js'), asCjs);
      execFileSync(process.execPath, ['--check', asCjs]);
    },
    CHILD_TIMEOUT_MS,
  );

  it(
    'a planted app.js without the createRequire line makes the plugin throw its named error',
    async () => {
      const original = await readFile(AGENTCORE_APP_JS, 'utf8');
      expect(original).toContain(CREATE_REQUIRE_LINE);
      const plantedDir = mkdtempSync(join(tmpdir(), 'fothering-agent-planted-'));
      try {
        await writeFile(AGENTCORE_APP_JS, original.replace(CREATE_REQUIRE_LINE, ''));
        const { status, combined } = runBuild(['--only', 'agent', '--outdir', plantedDir]);
        expect(status).not.toBe(0);
        expect(combined).toContain('no longer holds');
        expect(readdirSync(plantedDir)).toEqual([]);
      } finally {
        await writeFile(AGENTCORE_APP_JS, original);
        rmSync(plantedDir, { recursive: true, force: true });
      }
    },
    CHILD_TIMEOUT_MS,
  );

  it(
    'a planted child under the same guard preload exits with NetworkGuardError on a non-loopback connect',
    async () => {
      const preloadOut = join(workDir, 'guard-preload.mjs');
      await build({
        entryPoints: [join(REPO_ROOT, 'packages', 'providers', 'src', 'test', 'guards.setup.ts')],
        bundle: true,
        platform: 'node',
        target: 'node22',
        format: 'esm',
        outfile: preloadOut,
      });

      const probeScript = join(workDir, 'guard-probe.mjs');
      await writeFile(probeScript, "import net from 'node:net';\nnet.connect({ host: '192.0.2.1', port: 80 });\n");

      const result = spawnSync(process.execPath, ['--import', pathToFileURL(preloadOut).href, probeScript], {
        encoding: 'utf8',
        timeout: 10000,
      });
      expect(result.stderr).toContain('NetworkGuardError');
    },
    CHILD_TIMEOUT_MS,
  );

  it(
    'answers /ping and /invocations locally with no model and no AWS client (AC-21, AC-E38)',
    async () => {
      const preloadOut = join(workDir, 'guard-preload.mjs');
      const port = await findFreePort();
      const host = '127.0.0.1';

      child = spawn(
        process.execPath,
        ['--import', pathToFileURL(preloadOut).href, 'main.js', '--port', String(port), '--host', host],
        { cwd: outDir, env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] },
      );
      let stderr = '';
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      const pingUrl = `http://${host}:${port}/ping`;
      const first = await waitForOk(pingUrl, 15000);
      expect(first.status, stderr).toBe(200);
      const firstBody = (await first.json()) as { status: string; time_of_last_update: number };
      expect(firstBody.status).toBe('Healthy');
      expect(typeof firstBody.time_of_last_update).toBe('number');

      const second = await fetch(pingUrl);
      expect(second.status).toBe(200);
      const secondBody = (await second.json()) as { time_of_last_update: number };
      expect(secondBody.time_of_last_update).toBe(firstBody.time_of_last_update);

      const invokeUrl = `http://${host}:${port}/invocations`;
      const headers = { 'content-type': 'application/json', [SESSION_HEADER]: 'session-1' };
      const [a, b] = await Promise.all([
        fetch(invokeUrl, { method: 'POST', headers, body: '{}' }),
        fetch(invokeUrl, { method: 'POST', headers, body: '{}' }),
      ]);
      expect(a.status).toBe(200);
      expect(b.status).toBe(200);
      expect(await a.json()).toEqual({ status: 'no-model', model: 'none' });
      expect(await b.json()).toEqual({ status: 'no-model', model: 'none' });

      const noSession = await fetch(invokeUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      expect(noSession.status).toBe(400);
    },
    CHILD_TIMEOUT_MS,
  );
});
