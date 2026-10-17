import { describe, expect, it } from 'vitest';
import { readRepoText, repoRoot } from './repo-facts.js';
import { NOT_LISTED, RESOURCE_NOUNS, resourceRows } from './resources-view.js';

const ROOT = repoRoot(process.cwd());

interface SnapshotResource {
  stack: string;
  logicalId: string;
  type: string;
  deletionPolicy: string;
}

function committedResources(): SnapshotResource[] {
  return JSON.parse(readRepoText('packages/infra/resources.json', ROOT)) as SnapshotResource[];
}

function resource(overrides: Partial<SnapshotResource>): SnapshotResource {
  return { stack: 'FotheringIngest', logicalId: 'EventStore165FCE28', type: 'AWS::DynamoDB::Table', deletionPolicy: 'Delete', ...overrides };
}

describe('the resource schedule', () => {
  it('classes every type in the committed snapshot in exactly one of the noun map and the not-listed map', () => {
    for (const { type } of committedResources()) {
      expect([Object.hasOwn(RESOURCE_NOUNS, type), Object.hasOwn(NOT_LISTED, type)].filter(Boolean), type).toHaveLength(1);
    }
  });

  it('holds no class for a type the committed snapshot lacks', () => {
    const present = new Set(committedResources().map((entry) => entry.type));
    for (const type of [...Object.keys(RESOURCE_NOUNS), ...Object.keys(NOT_LISTED)]) expect(present.has(type), type).toBe(true);
  });

  it('gives every not-listed type a reason', () => {
    for (const reason of Object.values(NOT_LISTED)) expect(reason.trim()).not.toBe('');
  });

  it('returns one row per listed resource of the committed snapshot, in snapshot order', () => {
    const committed = committedResources();
    const listed = committed.filter((entry) => Object.hasOwn(RESOURCE_NOUNS, entry.type));
    const rows = resourceRows(committed);
    expect(rows.map((row) => `${row.stack}/${row.logicalId}`)).toEqual(listed.map((entry) => `${entry.stack}/${entry.logicalId}`));
    expect(rows.length).toBeGreaterThan(0);
  });

  it('throws naming stack, logical id and type for a planted unclassified type', () => {
    const planted = [...committedResources(), resource({ logicalId: 'PlantedTopic', type: 'AWS::SNS::Topic' })];
    expect(() => resourceRows(planted)).toThrow(/FotheringIngest\/PlantedTopic.*AWS::SNS::Topic/);
  });

  it('throws on an empty resource list', () => {
    expect(() => resourceRows([])).toThrow('packages/infra/resources.json: no entries. Run npm run permissions:snapshot.');
  });

  it('reads a Delete policy (the snapshot form of an absent one) as deleted on removal and Retain as kept', () => {
    const [deleted, kept] = resourceRows([resource({ deletionPolicy: 'Delete' }), resource({ logicalId: 'Kept', deletionPolicy: 'Retain' })]);
    expect(deleted?.deletedOnRemoval).toBe(true);
    expect(kept?.deletedOnRemoval).toBe(false);
  });

  it('throws on a removal policy it has no wording for, and names a malformed entry', () => {
    expect(() => resourceRows([resource({ deletionPolicy: 'Snapshot' })])).toThrow(/\[0\]\.deletionPolicy.*Snapshot/);
    expect(() => resourceRows([{ stack: 'FotheringIngest', logicalId: 'X' }])).toThrow(/\[0\]\.type/);
  });

  it('names each listed type with its page noun', () => {
    const table = resourceRows([resource({})])[0];
    expect(table?.noun).toBe('table');
  });
});
