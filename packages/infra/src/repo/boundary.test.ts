import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import { afterAll, describe, expect, it } from 'vitest';

// This file lives at packages/infra/src/repo/, four levels below the repo root.
const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const DEPCRUISE_CLI = join(REPO_ROOT, 'node_modules', 'dependency-cruiser', 'bin', 'dependency-cruise.mjs');
const DEPCRUISE_CONFIG = join(REPO_ROOT, '.dependency-cruiser.cjs');

// One entry per banned family. The key doubles as a safe file-name fragment and a marker string,
// so a violation can be traced back to the family that caused it without parsing the specifier.
const BANNED_IMPORTS: ReadonlyArray<{ key: string; specifier: string }> = [
  { key: 'aws-sdk', specifier: '@aws-sdk/client-sqs' },
  { key: 'smithy', specifier: '@smithy/types' },
  { key: 'aws-crypto', specifier: '@aws-crypto/sha256-js' },
  { key: 'bedrock-agentcore', specifier: 'bedrock-agentcore' },
  { key: 'bedrock-agentcore-runtime', specifier: 'bedrock-agentcore/runtime' },
  { key: 'aws4fetch', specifier: 'aws4fetch' },
];

// packages/providers-old and packages/brand-new are synthetic siblings: providers-old proves the
// exemption is path-exact (AC-E8), brand-new proves the rule covers a workspace it has never seen
// without editing it (AC-E9).
function plantedWorkspaces(): string[] {
  const real = readdirSync(join(REPO_ROOT, 'packages'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  return [...real, 'providers-old', 'brand-new'];
}

interface DepcruiseViolation {
  from: string;
  to: string;
  rule: { name: string };
}
interface DepcruiseResult {
  summary: { violations: DepcruiseViolation[] };
}

function runDepcruise(root: string): DepcruiseResult {
  const stdout = execFileSync(
    process.execPath,
    [DEPCRUISE_CLI, 'packages', '--config', DEPCRUISE_CONFIG, '--output-type', 'json'],
    { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  return JSON.parse(stdout) as DepcruiseResult;
}

function violatedFrom(result: DepcruiseResult, from: string): boolean {
  return result.summary.violations.some((v) => v.from === from);
}

describe('the AWS client boundary catches a planted import anywhere outside providers/src', () => {
  const roots: string[] = [];
  afterAll(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  function buildTree(): string {
    const root = mkdtempSync(join(tmpdir(), 'boundary-st-'));
    roots.push(root);
    for (const ws of plantedWorkspaces()) {
      const srcDir = join(root, 'packages', ws, 'src');
      mkdirSync(srcDir, { recursive: true });
      for (const { key, specifier } of BANNED_IMPORTS) {
        writeFileSync(join(srcDir, `planted-${key}.ts`), `import '${specifier}';\nexport const marker = '${key}';\n`);
      }
    }
    mkdirSync(join(root, 'packages', 'functions', 'src'), { recursive: true });
    writeFileSync(
      join(root, 'packages', 'functions', 'src', 'planted-dynamic.ts'),
      "export function loadDynamically(): Promise<unknown> {\n  return import('bedrock-agentcore');\n}\n",
    );
    writeFileSync(
      join(root, 'packages', 'functions', 'src', 'planted-require.cjs'),
      "module.exports = require('@aws-sdk/client-sqs');\n",
    );
    return root;
  }

  it('flags every planted family outside providers/src, and none of them inside it', () => {
    const result = runDepcruise(buildTree());
    for (const ws of plantedWorkspaces()) {
      for (const { key } of BANNED_IMPORTS) {
        const from = `packages/${ws}/src/planted-${key}.ts`;
        const flagged = violatedFrom(result, from);
        if (ws === 'providers') {
          expect(flagged, `${from} should NOT be a violation`).toBe(false);
        } else {
          expect(flagged, `${from} should be a violation`).toBe(true);
        }
      }
    }
  });

  it('flags a dynamic import() and a require() outside providers like a static import (backstop)', () => {
    const result = runDepcruise(buildTree());
    expect(violatedFrom(result, 'packages/functions/src/planted-dynamic.ts')).toBe(true);
    expect(violatedFrom(result, 'packages/functions/src/planted-require.cjs')).toBe(true);
  });
});

describe('lint catches a stray BedrockModel import and an argument-less agent', () => {
  // warnIgnored surfaces a config mismatch as a message instead of a silent empty result, and the
  // ignored-marker check below turns that message into a hard failure: a path this helper is told
  // to lint must actually be evaluated by a rule, never quietly skipped by a glob that missed it.
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

  const BEDROCK_MODEL_IMPORT = "import { BedrockModel } from '@strands-agents/sdk';\nexport const m = BedrockModel;\n";

  it('flags a BedrockModel import outside the live providers', async () => {
    expect(ruleIds(await lintMessages(BEDROCK_MODEL_IMPORT, 'packages/core/src/planted.ts'))).toContain(
      'no-restricted-imports',
    );
    expect(ruleIds(await lintMessages(BEDROCK_MODEL_IMPORT, 'packages/providers/src/planted.ts'))).toContain(
      'no-restricted-imports',
    );
  });

  it('passes a BedrockModel import inside the live providers', async () => {
    expect(ruleIds(await lintMessages(BEDROCK_MODEL_IMPORT, 'packages/providers/src/live/planted.ts'))).not.toContain(
      'no-restricted-imports',
    );
  });

  it('flags an argument-less new Agent(), by name and by namespace access, and passes one built with a model', async () => {
    const zeroArg = 'class Agent {}\nexport const a = new Agent();\n';
    const namespaceZeroArg = "import * as sdk from 'x';\nexport const a = new sdk.Agent();\n";
    const withModel = 'class Agent {}\nexport const a = new Agent({ model: 1 });\n';
    expect(ruleIds(await lintMessages(zeroArg, 'packages/agent/src/planted.ts'))).toContain('no-restricted-syntax');
    expect(ruleIds(await lintMessages(namespaceZeroArg, 'packages/agent/src/planted2.ts'))).toContain(
      'no-restricted-syntax',
    );
    expect(ruleIds(await lintMessages(withModel, 'packages/agent/src/planted3.ts'))).not.toContain(
      'no-restricted-syntax',
    );
  });

  // The lint rule and the dependency rule keep two lists of the same families, so the lint half is
  // held to the list the dependency test above plants: a family either config drops fails here.
  it.each(BANNED_IMPORTS)('flags $specifier outside providers and passes it inside, like the dependency rule', async ({ specifier }) => {
    const code = `import * as banned from '${specifier}';\nexport const b = banned;\n`;
    expect(ruleIds(await lintMessages(code, 'packages/functions/src/planted.ts'))).toContain('no-restricted-imports');
    expect(ruleIds(await lintMessages(code, 'packages/providers/src/planted.ts'))).not.toContain('no-restricted-imports');
  });
});
