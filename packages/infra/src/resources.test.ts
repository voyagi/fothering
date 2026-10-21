import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { synthesizePermissionTemplates, type CfnTemplate, type StackTemplates } from './permissions.js';
import { collectResources, diffResources, serializeResources, type ResourceEntry } from './resources.js';

const SNAPSHOT_URL = new URL('../resources.json', import.meta.url);

function committedSnapshot(): ResourceEntry[] {
  return JSON.parse(readFileSync(SNAPSHOT_URL, 'utf8')) as ResourceEntry[];
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

describe('the resource snapshot', () => {
  let templates: StackTemplates;
  let synthesized: ResourceEntry[];
  beforeAll(() => {
    templates = synthesizePermissionTemplates();
    synthesized = collectResources(templates);
  }, 60_000);

  it('equals the resources the two stacks synthesize, in both directions', () => {
    const committed = committedSnapshot();
    expect(committed.length).toBeGreaterThan(0);
    expect(diffResources(committed, synthesized)).toEqual({ missing: [], extra: [] });
  });

  it('holds exactly the keys stack, logicalId, type and deletionPolicy on every entry', () => {
    for (const entry of committedSnapshot()) expect(Object.keys(entry).sort()).toEqual(['deletionPolicy', 'logicalId', 'stack', 'type']);
  });

  it('shows one planted added resource as exactly that extra entry', () => {
    const planted = clone(templates);
    const ingest = planted.FotheringIngest as CfnTemplate;
    ingest.Resources = { ...ingest.Resources, PlantedQueue: { Type: 'AWS::SQS::Queue', Properties: {} } };
    const diff = diffResources(committedSnapshot(), collectResources(planted));
    expect(diff.missing).toEqual([]);
    expect(diff.extra).toEqual([{ stack: 'FotheringIngest', logicalId: 'PlantedQueue', type: 'AWS::SQS::Queue', deletionPolicy: 'Delete' }]);
  });

  it('shows a resource whose DeletionPolicy turned Retain as that entry changed', () => {
    const planted = clone(templates);
    const ingest = planted.FotheringIngest as CfnTemplate;
    const [logicalId, table] = Object.entries(ingest.Resources ?? {}).find(([, resource]) => resource.Type === 'AWS::DynamoDB::Table') ?? [];
    if (logicalId === undefined || table === undefined) throw new Error('no table in FotheringIngest');
    table.DeletionPolicy = 'Retain';
    const diff = diffResources(committedSnapshot(), collectResources(planted));
    expect(diff.missing.map((entry) => [entry.logicalId, entry.deletionPolicy])).toEqual([[logicalId, 'Delete']]);
    expect(diff.extra.map((entry) => [entry.logicalId, entry.deletionPolicy])).toEqual([[logicalId, 'Retain']]);
  });

  it('reads an absent DeletionPolicy as Delete', () => {
    const entries = collectResources({ Stack: { Resources: { Fn: { Type: 'AWS::Lambda::Function' } } } });
    expect(entries).toEqual([{ stack: 'Stack', logicalId: 'Fn', type: 'AWS::Lambda::Function', deletionPolicy: 'Delete' }]);
  });

  it('sorts entries by stack, then logical id', () => {
    const order = synthesized.map((entry) => [entry.stack, entry.logicalId]);
    const byText = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);
    const sorted = [...order].sort(([stackA = '', idA = ''], [stackB = '', idB = '']) => byText(stackA, stackB) || byText(idA, idB));
    expect(order).toEqual(sorted);
    expect(new Set(order.map((pair) => pair.join('/'))).size).toBe(order.length);
  });

  it('serializes as two-space JSON with one trailing newline, byte for byte the committed file', () => {
    const text = serializeResources(synthesized);
    expect(text.endsWith('}\n]\n')).toBe(true);
    expect(text).toBe(readFileSync(SNAPSHOT_URL, 'utf8'));
  });
});
