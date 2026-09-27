import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// This file lives at packages/providers/src/, two levels below the repo root package-lock.json
// it reads.
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

function readJson<T>(rel: string): T {
  return JSON.parse(readFileSync(join(REPO_ROOT, rel), 'utf8')) as T;
}

interface LockfilePackages {
  packages?: Record<string, { version?: string }>;
}

interface DuplicateReport {
  name: string;
  versions: string[];
}

interface LockfileCheckResult {
  unexpected: DuplicateReport[];
  staleExceptions: string[];
}

// D-35: one @aws-sdk version per package, except @aws-sdk/types, whose second copy arrives
// through bedrock-agentcore's deprecated @aws-sdk/protocol-http and @aws-sdk/signature-v4
// (RESEARCH.md line 268). @smithy/* and fastify-plugin carry the same kind of nested duplicate
// from the same dependency but sit outside the @aws-sdk scope this check enforces.
const EXPECTED_DUPLICATES = new Set(['@aws-sdk/types']);

// Matches a lockfile packages-map key ending in an @aws-sdk leaf, nested or not: the capture
// group is always the real package name, regardless of how many node_modules levels precede it.
const AWS_SDK_PACKAGE_PATH = /(?:^|\/)node_modules\/(@aws-sdk\/[^/]+)$/;

function findAwsSdkDuplicates(lockfile: LockfilePackages): DuplicateReport[] {
  const versionsByName = new Map<string, Set<string>>();
  for (const [path, entry] of Object.entries(lockfile.packages ?? {})) {
    const match = AWS_SDK_PACKAGE_PATH.exec(path);
    if (match === null || entry.version === undefined) continue;
    const name = match[1] as string;
    const versions = versionsByName.get(name) ?? new Set<string>();
    versions.add(entry.version);
    versionsByName.set(name, versions);
  }
  const duplicates: DuplicateReport[] = [];
  for (const [name, versions] of versionsByName) {
    if (versions.size > 1) duplicates.push({ name, versions: [...versions].sort() });
  }
  return duplicates.sort((a, b) => a.name.localeCompare(b.name));
}

function checkAwsSdkVersions(lockfile: LockfilePackages, exceptions: ReadonlySet<string> = EXPECTED_DUPLICATES): LockfileCheckResult {
  const duplicates = findAwsSdkDuplicates(lockfile);
  const duplicateNames = new Set(duplicates.map((d) => d.name));
  const unexpected = duplicates.filter((d) => !exceptions.has(d.name));
  const staleExceptions = [...exceptions].filter((name) => !duplicateNames.has(name)).sort();
  return { unexpected, staleExceptions };
}

describe('checkAwsSdkVersions', () => {
  it('reports a planted duplicate AWS SDK client version', () => {
    const synthetic: LockfilePackages = {
      packages: {
        'node_modules/@aws-sdk/client-dynamodb': { version: '3.1136.0' },
        'node_modules/some-transitive-dep/node_modules/@aws-sdk/client-dynamodb': { version: '3.999.0' },
        'node_modules/@aws-sdk/client-sqs': { version: '3.1136.0' },
      },
    };
    const result = checkAwsSdkVersions(synthetic);
    expect(result.unexpected).toEqual([{ name: '@aws-sdk/client-dynamodb', versions: ['3.1136.0', '3.999.0'] }]);
  });

  it('reports an exception entry as stale once it no longer has a duplicate', () => {
    const synthetic: LockfilePackages = {
      packages: {
        'node_modules/@aws-sdk/types': { version: '3.974.6' },
      },
    };
    const result = checkAwsSdkVersions(synthetic);
    expect(result.staleExceptions).toEqual(['@aws-sdk/types']);
  });

  it('the real lockfile carries no unexpected @aws-sdk duplicate, and the named exception is not stale', () => {
    const real = readJson<LockfilePackages>('package-lock.json');
    const result = checkAwsSdkVersions(real);
    expect(result.unexpected).toEqual([]);
    expect(result.staleExceptions).toEqual([]);
  });
});
