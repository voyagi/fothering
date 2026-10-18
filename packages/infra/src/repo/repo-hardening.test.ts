import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { ACTION_STACK_ID, DETECTION_STACK_ID, INGEST_STACK_ID, RUNTIME_STACK_ID } from '../create-app.js';

// This file lives at packages/infra/src/repo/, four levels below the repo root every path here
// is read relative to.
const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

function readText(rel: string): string {
  return readFileSync(join(REPO_ROOT, rel), 'utf8');
}

function readJson<T>(rel: string): T {
  return JSON.parse(readText(rel)) as T;
}

interface PackageJson {
  scripts: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

interface StrykerConfig {
  mutate: string[];
  vitest?: { configFile?: string };
}

interface LockFile {
  packages?: Record<string, { hasInstallScript?: boolean }>;
}

// The words after `cdk deploy` or `cdk destroy` up to the first option, and whether the line selects
// with --all instead.
function stackSelection(line: string): { names: string[]; all: boolean } {
  const words = (/\bcdk (?:deploy|destroy)((?:[ \t]+[^\s`]+)*)/.exec(line)?.[1] ?? '').trim().split(/\s+/).filter((word) => word !== '');
  const firstOption = words.findIndex((word) => word.startsWith('-'));
  const names = firstOption === -1 ? words : words.slice(0, firstOption);
  return { names, all: names.length === 0 && words[0] === '--all' };
}

// None means the line must select with --all, and each one given must be a stack the app builds.
function namesOnlyBuiltStacks(line: string, builtStacks: ReadonlySet<string>): boolean {
  const { names, all } = stackSelection(line);
  return names.length === 0 ? all : names.every((name) => builtStacks.has(name));
}

// Every stack the lines of one verb select between them, sorted.
function stacksCovered(lines: readonly string[], verb: 'deploy' | 'destroy', builtStacks: ReadonlySet<string>): string[] {
  const covered = new Set<string>();
  for (const line of lines.filter((candidate) => new RegExp(`\\bcdk ${verb}\\b`).test(candidate))) {
    const { names, all } = stackSelection(line);
    for (const name of all ? builtStacks : names) covered.add(name);
  }
  return [...covered].sort();
}

// Every spelling the CDK CLI takes a context pair in: -c k=v, --context k=v, the = forms, quoted.
function contextKeysPassed(text: string): string[] {
  return [...text.matchAll(/(?:^|\s)(?:-c|--context)(?:=|\s+)["']?([\w:.-]+)=/g)].map((m) => m[1] as string);
}

// Every way a construct reads one: tryGetContext or getContext, with any quote style.
function contextKeysRead(sources: readonly string[]): Set<string> {
  const keys = new Set<string>();
  for (const source of sources) {
    for (const m of source.matchAll(/\b(?:tryGetContext|getContext)\(\s*['"`]([^'"`]+)['"`]\s*\)/g)) keys.add(m[1] as string);
  }
  return keys;
}

interface SourceFile {
  path: string;
  text: string;
}

// Every non-test TypeScript source of the CDK app, its path relative to packages/infra/src.
function infraSources(): SourceFile[] {
  const infraSrc = join(REPO_ROOT, 'packages', 'infra', 'src');
  return readdirSync(infraSrc, { recursive: true, encoding: 'utf8' })
    .filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts'))
    .map((file) => ({ path: file, text: readFileSync(join(infraSrc, file), 'utf8') }));
}

// main.ts listens on every interface only when FOTHERING_DEPLOYED_RUNTIME reads the agent's
// AGENTCORE_RUNTIME value, and only the stack that deploys the runtime sets it. A runtime deployed
// without it listens on loopback inside the microVM and fails its first health check, so a source
// importing an AgentCore construct module must name the variable and that value. A type-only
// import builds nothing, so it is the one import left out (group 1 holds its `type` keyword).
const AGENTCORE_CONSTRUCT_IMPORT_RE =
  /\bimport\s+(type\s+)?(?:(?!\bimport\b)[^;])*?\bfrom\s+['"][^'"]*bedrock-?agentcore[^'"]*['"]|\brequire\(\s*['"][^'"]*bedrock-?agentcore[^'"]*['"]\s*\)/gi;
const AGENTCORE_VALUE_RE = /\bAGENTCORE_RUNTIME\b|['"`]agentcore['"`]/;

function importsAgentCoreConstructs(text: string): boolean {
  return [...text.matchAll(AGENTCORE_CONSTRUCT_IMPORT_RE)].some((m) => m[1] === undefined);
}

function runtimeBuildersMissingListenVar(files: readonly SourceFile[]): string[] {
  return files
    .filter((f) => importsAgentCoreConstructs(f.text))
    .filter((f) => !f.text.includes('FOTHERING_DEPLOYED_RUNTIME') || !AGENTCORE_VALUE_RE.test(f.text))
    .map((f) => f.path);
}

describe('repo hardening: every gate, config and document ships what it claims', () => {
  const pkg = readJson<PackageJson>('package.json');

  it('no two package.json scripts run the same command', () => {
    const values = Object.values(pkg.scripts);
    expect(new Set(values).size).toBe(values.length);
  });

  it('the complexity gate runs its own config, and that config carries only the complexity rules', async () => {
    expect(pkg.scripts['gate:complexity']).toContain('eslint.complexity.config.mjs');
    const mod = (await import(pathToFileURL(join(REPO_ROOT, 'eslint.complexity.config.mjs')).href)) as {
      default: Array<{ rules?: Record<string, unknown> }>;
    };
    const withRules = mod.default.find((entry) => entry.rules !== undefined);
    expect(withRules, 'expected one config entry to declare rules').toBeDefined();
    expect(Object.keys(withRules?.rules ?? {}).sort()).toEqual(['complexity', 'sonarjs/cognitive-complexity']);
  });

  it('the gate chain runs the test-discovery and tracked-path gates', () => {
    expect(pkg.scripts.gate).toContain('gate:tracked-paths');
    expect(pkg.scripts.gate).toContain('gate:test-discovery');
  });

  it('every gate script documenting a --selftest control is wired into gate:selftest', () => {
    const scriptsDir = join(REPO_ROOT, 'scripts');
    const gateScripts = readdirSync(scriptsDir).filter((f) => /^check-.*\.mjs$/.test(f) && !f.endsWith('.mutants.mjs'));
    expect(gateScripts.length).toBeGreaterThan(0);
    for (const file of gateScripts) {
      const text = readFileSync(join(scriptsDir, file), 'utf8');
      if (/--selftest/.test(text)) {
        expect(pkg.scripts['gate:selftest'], `${file} documents --selftest`).toContain(`node scripts/${file} --selftest`);
      }
    }
  });

  it('every CommonJS bundle in the build takes the shared settings, so none escapes the import.meta error', () => {
    const buildScript = readText('scripts/build.mjs');
    expect(buildScript, 'a CommonJS format set here bypasses bundle-options.mjs').not.toMatch(/format:\s*'cjs'/);
    expect(buildScript.match(/\.\.\.CJS_BUNDLE_BASE/g) ?? []).toHaveLength(2);
  });

  it('the ship-verification runner declares a selftest step', () => {
    const verifyShip = readText('verify-ship.mjs');
    expect(verifyShip).toMatch(/name:\s*'selftest'/);
  });

  it('the mutation config aims at exactly the decision modules, the composition roots and the agent boundary', () => {
    const stryker = readJson<StrykerConfig>('stryker.config.json');
    expect(stryker.mutate).toEqual([
      'packages/core/src/**/*.ts',
      'packages/providers/src/ports.ts',
      'packages/providers/src/dry-run.ts',
      'packages/providers/src/port-backed-model.ts',
      'packages/functions/src/*/root.ts',
      'packages/functions/src/detect/detect.ts',
      'packages/agent/src/root.ts',
      'packages/agent/src/listen-host.ts',
      'packages/agent/src/handler.ts',
      'packages/agent/src/eval/report.ts',
      '!packages/**/*.test.ts',
      '!packages/**/test/**',
      '!packages/**/fixtures/**',
      '!packages/**/*.d.ts',
    ]);
    expect(stryker.vitest?.configFile).toBe('vitest.stryker.config.ts');
  });

  it('the mutation vitest config excludes exactly the tests that cannot run inside the mutation sandbox', () => {
    const text = readText('vitest.stryker.config.ts');
    const match = /exclude:\s*\[([^\]]*)]/.exec(text);
    expect(match, 'expected an exclude array literal').not.toBeNull();
    const entries = (match?.[1] ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => s.replace(/^['"]|['"]$/g, ''));
    expect(entries).toEqual(['packages/infra/src/**', '**/abort-on-live.test.ts', '**/runtime.local.test.ts']);
  });

  it('CI installs without scripts, checks out without a pushable token, and scans dev dependencies before building', () => {
    const ci = readText('.github/workflows/ci-gates.yml');
    expect(ci).toContain('persist-credentials: false');
    expect(ci).toContain('npm ci --ignore-scripts');
    expect(ci).toContain('npm rebuild esbuild');
    expect(ci).toMatch(/TRIVY_INCLUDE_DEV_DEPS:\s*'true'/);
    expect(ci).toContain('list-all-pkgs');
    // The dev-dependency proof is a named devDependency in the lockfile's package list, never a
    // count: the production tree alone already reports well over one package.
    expect(ci).toContain('select(.Name=="vitest")');
    expect(ci).toMatch(/if \[ "\$dev_marker" -lt 1 \]; then/);
    expect(ci).not.toContain('-le 1');
    // The marker holds only while vitest stays a devDependency: listed as a production dependency
    // anywhere, a scan without dev dependencies would list it too and pass.
    expect(pkg.devDependencies, 'vitest must stay a root devDependency').toHaveProperty('vitest');
    const packagesDir = join(REPO_ROOT, 'packages');
    for (const ws of readdirSync(packagesDir)) {
      const manifest = readJson<PackageJson>(join('packages', ws, 'package.json'));
      expect(manifest.dependencies ?? {}, `packages/${ws} lists vitest as a production dependency`).not.toHaveProperty('vitest');
    }
    expect(ci).toContain('packages/*/package.json');
    // The site is planned under apps/, so the client scan must read those manifests too.
    expect(ci).toContain('packages/*/package.json apps/*/package.json');
    expect(ci).toContain('check-client-secrets.mjs');

    const lines = ci.split('\n');
    const stepStarts = lines.reduce<number[]>((acc, line, i) => {
      if (/^ {6}- /.test(line)) acc.push(i);
      return acc;
    }, []);
    const blockAt = (i: number): string => {
      const start = stepStarts[i] ?? 0;
      const end = stepStarts[i + 1] ?? lines.length;
      return lines.slice(start, end).join('\n');
    };
    const vulnBlockIndex = stepStarts.findIndex((_, i) => blockAt(i).includes('scanners: vuln'));
    expect(vulnBlockIndex).toBeGreaterThan(-1);
    expect(blockAt(vulnBlockIndex)).not.toMatch(/if:\s*github\.event_name/);

    const verifyShipLine = lines.findIndex((l) => l.includes('npm run verify:ship'));
    const trivyLines = lines.reduce<number[]>((acc, l, i) => {
      if (l.includes('aquasecurity/trivy-action')) acc.push(i);
      return acc;
    }, []);
    expect(trivyLines.length).toBe(2);
    expect(verifyShipLine).toBeGreaterThan(-1);
    for (const idx of trivyLines) expect(idx).toBeLessThan(verifyShipLine);

    // The vulnerability verdict can stay red until an upstream fix ships. Under the default
    // success() every step after it would then be skipped, so the ship gate runs once the install
    // succeeded, and the bundle scan once the ship gate did, whatever that verdict says.
    const stepWith = (text: string): string => blockAt(stepStarts.findIndex((_, i) => blockAt(i).includes(text)));
    expect(stepWith('npm rebuild esbuild')).toContain('id: rebuild');
    expect(stepWith('npm run verify:ship')).toContain('id: ship');
    expect(stepWith('npm run verify:ship')).toContain("if: ${{ !cancelled() && steps.rebuild.outcome == 'success' }}");
    expect(stepWith('check-client-secrets.mjs')).toContain("if: ${{ !cancelled() && steps.ship.outcome == 'success' }}");
  });

  it('only the platform-native installers carry an install script in the lockfile', () => {
    const lock = readJson<LockFile>('package-lock.json');
    const allowed = new Set(['node_modules/esbuild', 'node_modules/fsevents']);
    const withInstallScript = Object.entries(lock.packages ?? {})
      .filter(([, entry]) => entry.hasInstallScript === true)
      .map(([name]) => name);
    for (const name of withInstallScript) {
      expect(allowed.has(name), `${name} declares an install script and is not on the allowlist`).toBe(true);
    }
  });

  it('the test-discovery gate exempts the same file suffix the test runner itself excludes', () => {
    const discoveryGate = readText('scripts/check-test-discovery.mjs');
    const vitestConfig = readText('vitest.config.ts');
    expect(discoveryGate).toMatch(/FAULT_TEST_RE\s*=\s*\/\\\.fault\\\.test\\\.ts\$\/i/);
    expect(vitestConfig).toContain("'**/*.fault.test.ts'");
  });

  // Git itself is the judge, in a throwaway repo holding only this .gitignore, so neither this
  // clone's .git/info/exclude nor a global excludes file can hide a rule that stopped matching.
  describe('the ignore rules', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gitignore-st-'));
    afterAll(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
    execFileSync('git', ['init', '-q'], { cwd: dir });
    copyFileSync(join(REPO_ROOT, '.gitignore'), join(dir, '.gitignore'));

    function isIgnored(path: string): boolean {
      const r = spawnSync(
        'git',
        ['-c', `core.excludesFile=${join(dir, 'no-global-excludes')}`, 'check-ignore', '--no-index', '-q', path],
        { cwd: dir, encoding: 'utf8' },
      );
      // Exit 0 means ignored and 1 means not; anything else is git failing, never an answer.
      if (r.status !== 0 && r.status !== 1) throw new Error(`git check-ignore ${path} exited ${String(r.status)}: ${r.stderr}`);
      return r.status === 0;
    }

    it.each([
      'dist/agent/main.js',
      'packages/web/dist/index.html',
      'cdk.out/manifest.json',
      'reports/mutation/mutation.html',
      'reports/stryker-incremental.json',
      'coverage/index.html',
      'packages/web/coverage/index.html',
      'apps/web/coverage/index.html',
      '.stryker-tmp/sandbox/x.ts',
      '.knip-report.json',
      'trivy-vulns.json',
      'trivy-licenses.json',
    ])('ignores %s, which a verified ship run or a build writes', (path) => {
      expect(isIgnored(path)).toBe(true);
    });

    // A rule written for a root output folder must not swallow a source folder of the same name:
    // an incident-report page or a coverage module would then never reach a clone or a deploy.
    it.each([
      'packages/web/src/pages/reports/index.astro',
      'packages/core/src/reports/digest.ts',
      'packages/functions/src/reports/handler.ts',
      'packages/core/src/coverage/lanes.ts',
      'packages/providers/src/fixtures/trivy-sample.json',
      'packages/providers/src/fixtures/.knip-report.json',
    ])('tracks %s, a source path sharing a name with a root output', (path) => {
      expect(isIgnored(path)).toBe(false);
    });
  });

  // The CDK CLI fails a stack list only when NO name matches (aws-cdk 2.1142.0: deploy's selector
  // goes through mustMatch, which throws only below one match), so a README naming one real stack
  // and one the app lacks deploys the real one, skips the other and exits 0. Every name a line gives
  // must be a stack the app builds, and the deploy lines and the destroy lines must between them
  // cover every stack, so a stack the app gains cannot be left out of the README unnoticed. The
  // README names stacks rather than using --all because FotheringAction deploys last and is
  // destroyed first, which --all does not order.
  it('the README deploys and destroys every stack the app builds, and names no other', () => {
    const builtStacks = new Set([INGEST_STACK_ID, RUNTIME_STACK_ID, DETECTION_STACK_ID, ACTION_STACK_ID]);
    const cdkLines = readText('README.md')
      .split('\n')
      .filter((line) => /\bcdk (deploy|destroy)\b/.test(line));
    expect(stacksCovered(cdkLines, 'deploy', builtStacks)).toEqual([...builtStacks].sort());
    expect(stacksCovered(cdkLines, 'destroy', builtStacks)).toEqual([...builtStacks].sort());
    for (const line of cdkLines) expect(namesOnlyBuiltStacks(line, builtStacks), line.trim()).toBe(true);

    // Controls: a missing name beside a real one, a prefix of a real name and a bare deploy are refused,
    // and deploy lines that leave a built stack out do not cover the app.
    expect(namesOnlyBuiltStacks('npx cdk deploy FotheringRuntime FotheringMissing', builtStacks)).toBe(false);
    expect(namesOnlyBuiltStacks('npx cdk deploy Fothering -c fothering:live=live', builtStacks)).toBe(false);
    expect(namesOnlyBuiltStacks('npx cdk deploy', builtStacks)).toBe(false);
    expect(namesOnlyBuiltStacks('`npx cdk destroy FotheringRuntime`', builtStacks)).toBe(true);
    expect(stacksCovered(['npx cdk deploy FotheringIngest FotheringRuntime FotheringDetection'], 'deploy', builtStacks)).not.toContain(ACTION_STACK_ID);
    expect(stacksCovered(['npx cdk deploy --all -c fothering:live=live'], 'deploy', builtStacks)).toEqual([...builtStacks].sort());
    expect(stacksCovered(['npx cdk deploy --all'], 'destroy', builtStacks)).toEqual([]);
  });

  it('every CDK context key the README passes is read by the CDK app', () => {
    const read = contextKeysRead(infraSources().map((f) => f.text));
    for (const key of contextKeysPassed(readText('README.md'))) {
      expect(read.has(key), `the README passes -c ${key}, which no stack reads, so it changes nothing`).toBe(true);
    }

    // Controls: both extractors find what they exist to find, in every spelling the CLI takes a
    // context pair in and every way a construct reads one.
    expect(contextKeysPassed('npx cdk deploy --all -c fothering:live=live')).toEqual(['fothering:live']);
    expect(contextKeysPassed('npx cdk deploy --all --context a.b=1')).toEqual(['a.b']);
    expect(contextKeysPassed('npx cdk deploy --all --context=a.b=1')).toEqual(['a.b']);
    expect(contextKeysPassed('npx cdk deploy --all -c=a.b=1')).toEqual(['a.b']);
    expect(contextKeysPassed('npx cdk deploy --all -c "a:b=1" --context \'c=2\'')).toEqual(['a:b', 'c']);
    expect(contextKeysPassed('npx cdk deploy --all --ci')).toEqual([]);
    expect(contextKeysRead(["const v = this.node.tryGetContext('fothering:live');"]).has('fothering:live')).toBe(true);
    expect(contextKeysRead(['const v = app.node.getContext("a.b");']).has('a.b')).toBe(true);
    expect(contextKeysRead(['const v = this.node.tryGetContext(`c`);']).has('c')).toBe(true);
    expect(contextKeysRead(['const v = 1;']).size).toBe(0);
  });

  it('a CDK source that builds the agent runtime sets the variable that opens its listener', () => {
    expect(readText('packages/agent/src/main.ts')).toContain('process.env.FOTHERING_DEPLOYED_RUNTIME');
    expect(runtimeBuildersMissingListenVar(infraSources())).toEqual([]);

    // Controls: a construct import with neither, or with the name alone, is caught in the stable and
    // the alpha module spelling, and so is a value import listed after a type-only one; the name set
    // to the agent's constant passes, and so do a type-only import and a source that builds no runtime.
    const stable = "import { Runtime } from 'aws-cdk-lib/aws-bedrockagentcore';\n";
    const alpha = "import * as agentcore from '@aws-cdk/aws-bedrock-agentcore-alpha';\n";
    const setsIt = "import { AGENTCORE_RUNTIME } from '@fothering/agent/listen-host';\nconst env = { FOTHERING_DEPLOYED_RUNTIME: AGENTCORE_RUNTIME };\n";
    expect(runtimeBuildersMissingListenVar([
      { path: 'bare.ts', text: stable },
      { path: 'alpha.ts', text: alpha },
      { path: 'name-only.ts', text: `${stable}const env = { FOTHERING_DEPLOYED_RUNTIME: 'x' };\n` },
      { path: 'sets-it.ts', text: `${stable}${setsIt}` },
      { path: 'no-runtime.ts', text: "import { Stack } from 'aws-cdk-lib';\n" },
      { path: 'types-only.ts', text: "import type { RuntimeProps } from 'aws-cdk-lib/aws-bedrockagentcore';\n" },
      { path: 'types-then-value.ts', text: `import type { RuntimeProps } from 'aws-cdk-lib/aws-bedrockagentcore';\n${stable}` },
    ])).toEqual(['bare.ts', 'alpha.ts', 'name-only.ts', 'types-then-value.ts']);
  });

  it('the stack record names the CommonJS bundle, the site workspace, and orders the fallback CLI deploy before the container', () => {
    const adr = readText('docs/adr/0001-stack.md');
    const adrLines = adr.split('\n');
    const bundleLine = adrLines.findIndex((l) => l.includes('CommonJS') && l.includes('main.js'));
    expect(bundleLine, 'expected one line naming both CommonJS and main.js').toBeGreaterThan(-1);
    expect(adr).toContain('packages/web');

    const cliLine = adrLines.findIndex((l) => l.includes('AgentCore CLI'));
    const containerLine = adrLines.findIndex((l) => l.includes('linux/arm64'));
    expect(cliLine, 'expected a line naming the AgentCore CLI fallback').toBeGreaterThan(-1);
    expect(containerLine, 'expected a line naming the linux/arm64 container fallback').toBeGreaterThan(-1);
    expect(cliLine).toBeLessThan(containerLine);
  });
});
