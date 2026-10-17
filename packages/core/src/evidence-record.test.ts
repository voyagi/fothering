import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import lanesJson from '../../../lanes.json' with { type: 'json' };
import { pseudonymizeRecipient } from './address.js';
import { BUCKET_MS, bucketStartMs } from './buckets.js';
import { assembleEvidenceRecord, decideCycle } from './decision.js';
import { canonicalJson, incidentIdFor, optionIdFor, recordHash, type EvidenceRecord } from './evidence-record.js';
import { parseLaneMap, type LaneMap } from './lanes.js';
import { CYCLE_EXPIRES_AT, CYCLE_NOW_MS, cycleOf, recordFor, type CycleStory } from './test/decision-cycle.js';
import { TEST_KEY_SET, type ScenarioGroup } from './test/event-arbitraries.js';
import { propertySeed } from './test/property-seed.js';

const LANES = parseLaneMap(lanesJson);
const BULK = 'fothering-bulk';
const NEWS = 'news.example.com';
const RECEIVING = ['example.org', 'gmail.com', 'outlook.com'] as const;
const OPTION_ID = /^opt-[0-9a-f]{24}$/;

const QUIET_TRANSACTIONAL = { configurationSet: 'fothering-transactional', fromDomain: 'receipts.example.com', groups: [{ bucketOffset: 1, count: 150 }] };

function bulkStory(groups: readonly ScenarioGroup[]): CycleStory {
  return { lanes: [{ configurationSet: BULK, fromDomain: NEWS, groups }, QUIET_TRANSACTIONAL] };
}

// Recipients at three receiving domains, one bad batch, approved; and the same mail with complaints
// on the clean batch, which makes two batch causes and an unknown record.
const APPROVED_SCAN = bulkStory([
  { bucketOffset: 0, count: 40, batch: 'import-0915', receivingDomains: RECEIVING, permanentBounces: 15 },
  { bucketOffset: 1, count: 160, batch: 'import-0901', receivingDomains: RECEIVING },
]);
const COMPLAINED_SCAN = bulkStory([
  { bucketOffset: 0, count: 40, batch: 'import-0915', receivingDomains: RECEIVING, permanentBounces: 15 },
  { bucketOffset: 1, count: 160, batch: 'import-0901', receivingDomains: RECEIVING, complaints: 3 },
]);
const TWO_BAD_BATCHES = bulkStory([
  { bucketOffset: 0, count: 40, batch: 'import-0915', permanentBounces: 15 },
  { bucketOffset: 0, count: 40, batch: 'import-0916', permanentBounces: 15 },
  { bucketOffset: 1, count: 160, batch: 'import-0901' },
]);

const RECORDS: readonly EvidenceRecord[] = [APPROVED_SCAN, COMPLAINED_SCAN, TWO_BAD_BATCHES].map((story) => recordFor(LANES, story, BULK));

type Path = (string | number)[];
type Container = Record<string | number, unknown>;

function leafPaths(value: unknown, path: Path = []): Path[] {
  if (Array.isArray(value)) return value.flatMap((item, index) => leafPaths(item, [...path, index]));
  if (value !== null && typeof value === 'object') return Object.entries(value).flatMap(([key, nested]) => leafPaths(nested, [...path, key]));
  return [path];
}

function changedLeaf(old: unknown): unknown {
  if (typeof old === 'number') return old + 1;
  if (typeof old === 'boolean') return !old;
  return old === null ? 'changed' : `${String(old)}x`;
}

function withLeafChanged(record: EvidenceRecord, path: Path): EvidenceRecord {
  const copy = structuredClone(record);
  let parent = copy as unknown as Container;
  for (const key of path.slice(0, -1)) parent = parent[key] as Container;
  const last = path.at(-1);
  if (last === undefined) throw new Error('a leaf path names at least one key');
  parent[last] = changedLeaf(parent[last]);
  return copy;
}

describe('the record hash (AC-12)', () => {
  it('recomputes from every assembled record', () => {
    for (const record of RECORDS) expect(recordHash(record)).toBe(record.hash);
  });

  it('changes when any single leaf field changes', () => {
    for (const record of RECORDS) {
      const paths = leafPaths(record).filter((path) => path[0] !== 'hash');
      const named = new Set(paths.map((path) => path.join('.')));
      for (const field of ['laneTotals.recipientSends', 'decision.outcome', 'lane.configurationSet', 'rows.0.permanentBounces']) expect(named.has(field)).toBe(true);
      fc.assert(
        fc.property(fc.constantFrom(...paths), (path) => {
          expect(recordHash(withLeafChanged(record, path))).not.toBe(record.hash);
        }),
        { seed: propertySeed(), numRuns: 200 },
      );
    }
  });

  it('changes when the approved option id changes', () => {
    const [approved] = RECORDS;
    if (approved === undefined || approved.approvedOptions.length !== 1) throw new Error('the first record is approved with one option');
    expect(recordHash(withLeafChanged(approved, ['approvedOptions', 0, 'optionId']))).not.toBe(approved.hash);
  });
});

describe('option ids (AC-12, AC-E30)', () => {
  const incidentId = incidentIdFor(BULK, bucketStartMs(CYCLE_NOW_MS));

  it('is opt- and 24 hex characters, holding neither the set name nor the incident id', () => {
    const optionId = optionIdFor(incidentId, 0);
    expect(optionId).toMatch(OPTION_ID);
    expect(optionId).not.toContain(BULK);
    expect(optionId).not.toContain(incidentId);
  });

  it('is the same for two lanes with different set names under one incident id, so the set name never feeds it', () => {
    const renamed: LaneMap = parseLaneMap({ ...LANES, lanes: LANES.lanes.map((lane) => (lane.configurationSet === BULK ? { ...lane, configurationSet: 'fothering-news' } : lane)) });
    const records = [
      { laneMap: LANES, set: BULK },
      { laneMap: renamed, set: 'fothering-news' },
    ].map(({ laneMap, set }) => {
      const story: CycleStory = { ...APPROVED_SCAN, lanes: APPROVED_SCAN.lanes.map((lane) => (lane.configurationSet === BULK ? { ...lane, configurationSet: set } : lane)) };
      const { analyses } = cycleOf(laneMap, story);
      const decision = decideCycle(analyses, laneMap).get(set);
      const analysis = analyses.find((candidate) => candidate.lane.configurationSet === set);
      if (decision === undefined || analysis === undefined) throw new Error(`the cycle decides ${set}`);
      return assembleEvidenceRecord({ incidentId, analysis, decision, analyses, expiresAt: CYCLE_EXPIRES_AT });
    });
    const [bulk, news] = records;
    expect(bulk?.approvedOptions).toHaveLength(1);
    expect(news?.approvedOptions).toEqual(bulk?.approvedOptions);
  });

  it('gives two incidents with equal evidence different option ids and hashes', () => {
    const { analyses } = cycleOf(LANES, APPROVED_SCAN);
    const decision = decideCycle(analyses, LANES).get(BULK);
    const analysis = analyses.find((candidate) => candidate.lane.configurationSet === BULK);
    if (decision === undefined || analysis === undefined) throw new Error('the cycle decides the bulk lane');
    const later = incidentIdFor(BULK, bucketStartMs(CYCLE_NOW_MS) + BUCKET_MS);
    const [first, second] = [incidentId, later].map((id) => assembleEvidenceRecord({ incidentId: id, analysis, decision, analyses, expiresAt: CYCLE_EXPIRES_AT }));
    if (first === undefined || second === undefined) throw new Error('two records were assembled');
    expect(second.hash).not.toBe(first.hash);
    expect(second.approvedOptions[0]?.optionId).not.toBe(first.approvedOptions[0]?.optionId);
    const content = ({ incidentId: _id, approvedOptions: _options, hash: _hash, ...rest }: EvidenceRecord) => rest;
    expect(content(second)).toEqual(content(first));
  });
});

describe('an unknown record (AC-E31)', () => {
  it('is hashed with its empty approved-option set in the canonical text', () => {
    const record = RECORDS[2];
    if (record === undefined) throw new Error('the third record is the unknown one');
    expect(record.decision.outcome).toBe('unknown');
    const { hash: _hash, ...withoutHash } = record;
    expect(canonicalJson(withoutHash)).toContain('"approvedOptions":[]');
    expect(recordHash(record)).toBe(record.hash);
  });
});

function keysReversed(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(keysReversed);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).reverse().map(([key, nested]) => [key, keysReversed(nested)]));
}

describe('canonical JSON (AC-E32, D-69)', () => {
  it('is byte-equal for an object and the same object with its keys in another order, at every depth', () => {
    fc.assert(
      fc.property(fc.object({ values: [fc.integer(), fc.string(), fc.boolean(), fc.constant(null)], maxDepth: 4 }), (value) => {
        expect(canonicalJson(keysReversed(value))).toBe(canonicalJson(value));
      }),
      { seed: propertySeed() },
    );
    for (const record of RECORDS) expect(canonicalJson(keysReversed(record))).toBe(canonicalJson(record));
  });

  it('hashes a record the same whatever the key order of the record object', () => {
    for (const record of RECORDS) expect(recordHash(keysReversed(record) as EvidenceRecord)).toBe(record.hash);
  });

  // A JavaScript object always lists integer-like keys first, in numeric order, whatever order they
  // were added in, so a sort that hands its result back to JSON.stringify as an object loses it.
  it('orders integer-like keys by code unit like every other key, at every depth', () => {
    expect(canonicalJson({ b: 1, 10: 2, 2: 3, a: { 1: 0, '0a': 1 } })).toBe('{"10":2,"2":3,"a":{"0a":1,"1":0},"b":1}');
    const byCodeUnit = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);
    fc.assert(
      fc.property(fc.dictionary(fc.oneof(fc.nat({ max: 5000 }).map(String), fc.string({ maxLength: 4 })), fc.integer()), (value) => {
        const expected = `{${Object.keys(value)
          .sort(byCodeUnit)
          .map((key) => `${JSON.stringify(key)}:${String(value[key])}`)
          .join(',')}}`;
        expect(canonicalJson(value)).toBe(expected);
      }),
      { seed: propertySeed() },
    );
  });

  it('refuses a non-integer number anywhere, naming its path', () => {
    expect(() => canonicalJson({ a: { b: [1, 1.5] } })).toThrow('$.a.b[1]');
    expect(() => canonicalJson({ ratio: Number.NaN })).toThrow('$.ratio');
  });
});

function recipientHmacs(story: CycleStory): string[] {
  return story.lanes
    .filter((lane) => lane.configurationSet === BULK)
    .flatMap((lane) =>
      lane.groups.flatMap((group, groupIndex) =>
        Array.from({ length: group.count }, (_, index) => {
          const domains = group.receivingDomains ?? ['example.com'];
          const address = `r${groupIndex}-${index}@${domains[index % domains.length] ?? 'example.com'}`;
          return pseudonymizeRecipient(address, TEST_KEY_SET, CYCLE_NOW_MS).recipientHmac;
        }),
      ),
    );
}

describe('the serialized record holds no recipient data (AC-12, AC-P3)', () => {
  it.each([
    ['an approved record', APPROVED_SCAN],
    ['a record over complaints', COMPLAINED_SCAN],
  ] as const)('%s holds no address, recipient HMAC or receiving domain', (_name, story) => {
    const hmacs = recipientHmacs(story);
    // The HMACs computed here are the ones the stored records carry, so their absence below is real.
    const stored = new Set(cycleOf(LANES, story).records.map((record) => record.recipientHmac));
    expect(hmacs.filter((hmac) => stored.has(hmac))).toHaveLength(hmacs.length);
    const serialized = canonicalJson(recordFor(LANES, story, BULK));
    expect(serialized).not.toContain('@');
    for (const hmac of hmacs) expect(serialized.includes(hmac)).toBe(false);
    for (const domain of RECEIVING) expect(serialized).not.toContain(`"${domain}"`);
  });

  it('names the approved option without the set name', () => {
    const [option] = recordFor(LANES, APPROVED_SCAN, BULK).approvedOptions;
    expect(option?.optionId).toMatch(OPTION_ID);
    expect(option?.optionId).not.toContain(BULK);
  });
});
