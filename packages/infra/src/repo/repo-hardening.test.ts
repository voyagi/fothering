import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

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
}

interface StrykerConfig {
  mutate: string[];
  vitest?: { configFile?: string };
}

interface LockFile {
  packages?: Record<string, { hasInstallScript?: boolean }>;
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

  it('the mutation config aims at exactly the decision modules and composition roots', () => {
    const stryker = readJson<StrykerConfig>('stryker.config.json');
    expect(stryker.mutate).toEqual([
      'packages/core/src/**/*.ts',
      'packages/providers/src/ports.ts',
      'packages/providers/src/dry-run.ts',
      'packages/functions/src/*/root.ts',
      'packages/agent/src/root.ts',
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
    expect(ci).toContain('-le 1');
    expect(ci).toContain('packages/*/package.json');
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

  it('every path a verified ship run writes is ignored', () => {
    const gitignore = readText('.gitignore');
    for (const entry of ['dist/', 'cdk.out/', 'reports/', '.stryker-tmp/', '.knip-report.json', 'trivy-*.json']) {
      expect(gitignore, `expected ${entry} in .gitignore`).toContain(entry);
    }
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
