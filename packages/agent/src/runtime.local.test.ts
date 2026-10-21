import { build, type BuildOptions, type Plugin } from 'esbuild';
import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PINNED_MODEL_VALUES } from '@fothering/core/model-values';
import { fixtureEvidenceRecord } from '@fothering/core/test/decision-cycle';
import { SYSTEM_PROMPT_SHA256 } from './handler.js';

// This file lives at packages/agent/src/, two levels below the repo root every path here is
// read relative to.
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const BUILD_SCRIPT = join(REPO_ROOT, 'scripts', 'build.mjs');
const BUNDLE_OPTIONS = join(REPO_ROOT, 'scripts', 'bundle-options.mjs');
const AGENTCORE_APP_JS = join(REPO_ROOT, 'node_modules', 'bedrock-agentcore', 'dist', 'src', 'runtime', 'app.js');
const CREATE_REQUIRE_LINE = 'const require = createRequire(import.meta.url);';
const CHILD_TIMEOUT_MS = 60000;
// Every test that runs esbuild over planted files writes them here, not under the system temp
// folder: the time of those tiny builds follows the size of the folders above the planted files.
// Under a temp folder holding about a million entries the two in-process builds took about 3 s
// alone and went past 60 s in 3 of 4 cold verify:ship runs; from a small folder they took under
// 50 ms (measured 2026-10-14). The planted handler built by scripts/build.mjs in a child took
// 112,694 ms under the temp folder and 644 ms here, back to back (measured 2026-10-21).
// node_modules/ is git-ignored.
const PLANT_PARENT = join(REPO_ROOT, 'node_modules', '.cache');
const SESSION_HEADER = 'x-amzn-bedrock-agentcore-runtime-session-id';
const LISTEN_REFUSED = 'listen guard refused a non-loopback bind';

// Preloaded into every runtime child: any listen on an address that is not loopback throws before
// a socket is bound, so no test run of the bundle can open a port to the network, and the deployed
// path can be proven by the refusal instead of by binding every interface on this machine.
const LISTEN_GUARD_SOURCE = String.raw`import net from 'node:net';
const listen = net.Server.prototype.listen;
const LOOPBACK = /^(?:127\.\d{1,3}\.\d{1,3}\.\d{1,3}|::1|localhost)$/i;
net.Server.prototype.listen = function guardedListen(...args) {
  const first = args[0];
  const host = typeof first === 'object' && first !== null ? first.host : args[1];
  if (typeof host !== 'string' || !LOOPBACK.test(host)) {
    throw new Error('${LISTEN_REFUSED} to ' + String(host));
  }
  return listen.apply(this, args);
};
`;

interface CommandResult {
  status: number;
  combined: string;
}

function runBuild(args: string[], cwd: string = REPO_ROOT): CommandResult {
  try {
    const stdout = execFileSync(process.execPath, [BUILD_SCRIPT, ...args], {
      cwd,
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

// exitedEarly names why the server can never answer (its process already ended), so a runtime
// that dies at start fails with its own output instead of fifteen seconds of refused connections.
async function waitForOk(url: string, deadlineMs: number, exitedEarly: () => string | undefined): Promise<Response> {
  const start = Date.now();
  for (;;) {
    try {
      return await fetch(url);
    } catch (error) {
      const early = exitedEarly();
      if (early !== undefined) throw new Error(early, { cause: error });
      if (Date.now() - start > deadlineMs) throw error;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 200));
    }
  }
}

describe('the agent bundle answers the AgentCore contract with the real handler and no AWS client', () => {
  const outDir = mkdtempSync(join(tmpdir(), 'fothering-agent-bundle-'));
  const workDir = mkdtempSync(join(tmpdir(), 'fothering-agent-work-'));
  mkdirSync(PLANT_PARENT, { recursive: true });
  const plantDir = mkdtempSync(join(PLANT_PARENT, 'fothering-agent-plant-'));
  const listenGuard = join(workDir, 'listen-guard.mjs');
  writeFileSync(listenGuard, LISTEN_GUARD_SOURCE);
  const preloadOut = join(workDir, 'guard-preload.mjs');
  let bundleBuild: CommandResult = { status: 1, combined: 'the shared bundle build never ran' };
  let child: ChildProcess | undefined;

  // Built once, before any test, so every test below also passes when run alone by name: the
  // bundle the runtime tests start, and the network guard preloaded into every child.
  beforeAll(async () => {
    bundleBuild = runBuild(['--only', 'agent', '--outdir', outDir]);
    await build({
      entryPoints: [join(REPO_ROOT, 'packages', 'providers', 'src', 'test', 'guards.setup.ts')],
      bundle: true,
      platform: 'node',
      target: 'node22',
      format: 'esm',
      outfile: preloadOut,
    });
  }, CHILD_TIMEOUT_MS);

  afterAll(async () => {
    if (child !== undefined && child.exitCode === null) {
      child.kill();
      // Windows keeps the bundle's file handle open for a moment after the process dies, and an
      // rmSync racing that teardown fails EPERM: wait for the real exit event, not just the kill.
      await new Promise<void>((resolveExit) => {
        child?.once('exit', () => resolveExit());
        setTimeout(resolveExit, 5000);
      });
    }
    const retryOptions = { recursive: true, force: true, maxRetries: 5, retryDelay: 200 } as const;
    rmSync(outDir, retryOptions);
    rmSync(workDir, retryOptions);
    rmSync(plantDir, retryOptions);
  });

  it(
    'node scripts/build.mjs --only agent --outdir writes exactly one main.js, valid as CommonJS, no native module',
    () => {
      const { status, combined } = bundleBuild;
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
    'a planted app.js without the createRequire line makes the plugin throw its named error, and one with it builds',
    async () => {
      // The installed file is read, never written: a run killed mid-build must not leave a broken
      // dependency behind for every later build to trip over.
      expect(await readFile(AGENTCORE_APP_JS, 'utf8')).toContain(CREATE_REQUIRE_LINE);

      const { CJS_BUNDLE_BASE, agentcoreInlineRequirePlugin } = (await import(pathToFileURL(BUNDLE_OPTIONS).href)) as {
        CJS_BUNDLE_BASE: BuildOptions;
        agentcoreInlineRequirePlugin: () => Plugin;
      };
      // A private copy of the package path the plugin's filter matches, under this file's plant folder.
      const plantedRoot = join(plantDir, 'planted-agentcore');
      const runtimeDir = join(plantedRoot, 'node_modules', 'bedrock-agentcore', 'dist', 'src', 'runtime');
      mkdirSync(runtimeDir, { recursive: true });
      const plantedApp = join(runtimeDir, 'app.js');
      const entry = join(plantedRoot, 'entry.mjs');
      await writeFile(entry, "import './node_modules/bedrock-agentcore/dist/src/runtime/app.js';\n");
      const bundle = () =>
        build({ ...CJS_BUNDLE_BASE, entryPoints: [entry], plugins: [agentcoreInlineRequirePlugin()], write: false, logLevel: 'silent' });

      await writeFile(plantedApp, "import { createRequire } from 'node:module';\nexport const kind = typeof createRequire;\n");
      const failure = await bundle().then(
        () => undefined,
        (error: unknown) => error as Error,
      );
      expect(failure?.message).toContain('no longer holds');

      // Control: the same file with the line builds, so the failure above is the missing line alone.
      await writeFile(plantedApp, `import { createRequire } from 'node:module';\n${CREATE_REQUIRE_LINE}\nexport const kind = typeof require;\n`);
      const ok = await bundle();
      expect(ok.errors).toEqual([]);
    },
    CHILD_TIMEOUT_MS,
  );

  it(
    'the build script exits non-zero and writes nothing when the one target it is asked for cannot be built',
    () => {
      const emptyOut = join(workDir, 'unknown-target-out');
      const { status, combined } = runBuild(['--only', 'no-such-target', '--outdir', emptyOut]);
      expect(status, combined).toBe(1);
      expect(combined).toContain('is not a known target');
      expect(existsSync(emptyOut) ? readdirSync(emptyOut) : []).toEqual([]);
    },
    CHILD_TIMEOUT_MS,
  );

  it.each([[['--only']], [['--outdir']], [['--only', '--outdir', 'x']], [['--only', 'agent', '--outdir']]])(
    'the build script refuses %j instead of falling through to the full build',
    (args) => {
      // A temp folder as the working directory: were the refusal missing, the full build would find
      // nothing to bundle there and fail on its own, never touching the repo's own dist/.
      const { status, combined } = runBuild(args, workDir);
      expect(status, combined).toBe(1);
      expect(combined).toContain('--only and --outdir each need a value');
    },
    CHILD_TIMEOUT_MS,
  );

  it(
    'names the handler bundle that throws while loading',
    () => {
      const plantedRoot = join(plantDir, 'planted-handler-root');
      const handlerDir = join(plantedRoot, 'packages', 'functions', 'src', 'planted');
      mkdirSync(handlerDir, { recursive: true });
      writeFileSync(
        join(handlerDir, 'handler.ts'),
        "throw new Error('planted load failure');\nexport const handler = (): void => {};\n",
      );
      const out = join(plantDir, 'planted-handler-out');
      const { status, combined } = runBuild(['--only', 'planted', '--outdir', out], plantedRoot);
      expect(status, combined).toBe(1);
      expect(combined).toContain(`${join(out, 'index.js')} failed to load: planted load failure`);
    },
    CHILD_TIMEOUT_MS,
  );

  it(
    'the shared CommonJS settings fail a planted import.meta use instead of bundling it as undefined',
    async () => {
      const { CJS_BUNDLE_BASE } = (await import(pathToFileURL(BUNDLE_OPTIONS).href)) as { CJS_BUNDLE_BASE: BuildOptions };
      const planted = join(plantDir, 'planted-import-meta.mjs');
      await writeFile(planted, 'export const where = import.meta.url;\n');
      const failure = await build({ ...CJS_BUNDLE_BASE, entryPoints: [planted], write: false, logLevel: 'silent' }).then(
        () => undefined,
        (error: unknown) => error as { errors?: Array<{ id?: string }> },
      );
      expect(failure?.errors?.map((e) => e.id)).toContain('empty-import-meta');

      // Control: the same settings bundle a file with no import.meta, so the failure above is the
      // override firing, not settings that fail every build.
      const clean = join(plantDir, 'clean-entry.mjs');
      await writeFile(clean, 'export const where = 1;\n');
      const ok = await build({ ...CJS_BUNDLE_BASE, entryPoints: [clean], write: false, logLevel: 'silent' });
      expect(ok.errors).toEqual([]);
    },
    CHILD_TIMEOUT_MS,
  );

  it(
    'a planted child under the same guard preload exits with NetworkGuardError on a non-loopback connect',
    async () => {
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
    'answers /ping, and /invocations over a fixture evidence record with a dry-run result, with no AWS client (AC-14, AC-21, AC-E38)',
    async () => {
      const port = await findFreePort();
      const host = '127.0.0.1';

      // No deploy variable and the listen guard preloaded: the runtime must choose loopback on its
      // own, or the guard ends it before it answers a single ping. The suite's global setup refuses
      // to start with the live switch set, so the child's model row is the dry-run recorder.
      child = spawn(
        process.execPath,
        ['--import', pathToFileURL(preloadOut).href, '--import', pathToFileURL(listenGuard).href, 'main.js', '--port', String(port)],
        { cwd: outDir, env: { ...process.env, FOTHERING_DEPLOYED_RUNTIME: undefined }, stdio: ['ignore', 'pipe', 'pipe'] },
      );
      let output = '';
      const collect = (chunk: Buffer): void => {
        output += chunk.toString();
      };
      child.stdout?.on('data', collect);
      child.stderr?.on('data', collect);
      const exitedEarly = (): string | undefined => {
        const code = child?.exitCode;
        return code === null || code === undefined ? undefined : `the runtime exited ${code} before answering /ping:\n${output}`;
      };

      const pingUrl = `http://${host}:${port}/ping`;
      const first = await waitForOk(pingUrl, 15000, exitedEarly);
      expect(first.status, output).toBe(200);
      const firstBody = (await first.json()) as { status: string; time_of_last_update: number };
      expect(firstBody.status).toBe('Healthy');
      expect(typeof firstBody.time_of_last_update).toBe('number');

      const second = await fetch(pingUrl);
      expect(second.status).toBe(200);
      const secondBody = (await second.json()) as { time_of_last_update: number };
      expect(secondBody.time_of_last_update).toBe(firstBody.time_of_last_update);

      const invokeUrl = `http://${host}:${port}/invocations`;
      const headers = { 'content-type': 'application/json', [SESSION_HEADER]: 'session-1' };
      const record = JSON.stringify(fixtureEvidenceRecord());
      const [a, b] = await Promise.all([
        fetch(invokeUrl, { method: 'POST', headers, body: record }),
        fetch(invokeUrl, { method: 'POST', headers, body: record }),
      ]);
      expect(a.status, output).toBe(200);
      expect(b.status, output).toBe(200);
      const dryRun = { status: 'dry-run', pinned: PINNED_MODEL_VALUES, promptSha256: SYSTEM_PROMPT_SHA256 };
      expect(await a.json()).toEqual(dryRun);
      expect(await b.json()).toEqual(dryRun);
      // The child writes its line before it answers, but the pipe may deliver it a moment later.
      const dryRunLines = (): number =>
        output.split('\n').filter((line) => line.startsWith('(dry-run) WOULD bedrockModel.stream eu.anthropic.claude-sonnet-4-6 ')).length;
      for (let waitedMs = 0; dryRunLines() < 2 && waitedMs < 5000; waitedMs += 100) {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
      }
      expect(dryRunLines(), output).toBe(2);

      const empty = await fetch(invokeUrl, { method: 'POST', headers, body: '{}' });
      expect(empty.status).toBe(200);
      expect(await empty.json()).toEqual({
        status: 'refused',
        reason: 'payload-invalid',
        pinned: PINNED_MODEL_VALUES,
        promptSha256: SYSTEM_PROMPT_SHA256,
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        modelCalls: 0,
      });

      const noSession = await fetch(invokeUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      expect(noSession.status).toBe(400);
    },
    CHILD_TIMEOUT_MS,
  );

  it(
    'asks for every interface only when the deploying stack sets FOTHERING_DEPLOYED_RUNTIME, refused here by the listen guard',
    async () => {
      const port = await findFreePort();
      const result = spawnSync(
        process.execPath,
        ['--import', pathToFileURL(listenGuard).href, 'main.js', '--port', String(port)],
        { cwd: outDir, env: { ...process.env, FOTHERING_DEPLOYED_RUNTIME: 'agentcore' }, encoding: 'utf8', timeout: 20000 },
      );
      expect(`${result.stdout}${result.stderr}`).toContain(`${LISTEN_REFUSED} to 0.0.0.0`);
      expect(result.status).not.toBe(0);
    },
    CHILD_TIMEOUT_MS,
  );

  // The repo root says "type": "module", so main.js copied under a folder like it is misread as an
  // ES module and dies on its first require(); after the marker the default build writes into dist/,
  // the same file runs as CommonJS up to its listen, where the guard refuses the deployed bind.
  it(
    'runs as CommonJS under a module-typed root once dist/ carries the marker the default build writes',
    async () => {
      const repoLike = join(workDir, 'repo-like');
      const agentDir = join(repoLike, 'dist', 'agent');
      mkdirSync(agentDir, { recursive: true });
      writeFileSync(join(repoLike, 'package.json'), '{ "type": "module" }\n');
      copyFileSync(join(outDir, 'main.js'), join(agentDir, 'main.js'));
      const runDeployed = (): string => {
        const result = spawnSync(process.execPath, ['--import', pathToFileURL(listenGuard).href, 'main.js'], {
          cwd: agentDir,
          env: { ...process.env, FOTHERING_DEPLOYED_RUNTIME: 'agentcore' },
          encoding: 'utf8',
          timeout: 20000,
        });
        return `${result.stdout}${result.stderr}`;
      };

      const misread = runDeployed();
      expect(misread).toContain('ES module');
      expect(misread).not.toContain(LISTEN_REFUSED);

      const { markCommonJsScope } = (await import(pathToFileURL(BUNDLE_OPTIONS).href)) as {
        markCommonJsScope: (dir: string) => void;
      };
      markCommonJsScope(join(repoLike, 'dist'));
      expect(runDeployed()).toContain(LISTEN_REFUSED);
    },
    CHILD_TIMEOUT_MS,
  );
});
