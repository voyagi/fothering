import fc from 'fast-check';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { BUCKET_MS, LATENESS_HORIZON_MS, bucketStartMs, isBucketComplete } from './buckets.js';
import { createObserveTally, mergeObserveTallies, observeRecord } from './closeability.js';
import {
  RECORD_BYTE_CEILING,
  counterDayKey,
  incidentItemKey,
  incidentLaneKey,
  optionIdFor,
  serializedRecordBytes,
  type EvidenceRecord,
} from './evidence-record.js';
import { recordKey, type EventRecord } from './records.js';
import {
  TEST_CONFIGURATION_SET,
  TEST_KEY_SET,
  TEST_LANE_MAP,
  contextFor,
  envelopesFor,
  ingestAll,
  messageCaseArb,
  scenarioRecords,
  type LaneScenario,
  type MessageCase,
} from './test/event-arbitraries.js';
import { propertySeed } from './test/property-seed.js';
import {
  COVERAGE_THRESHOLD,
  HARD_BOUNCE_THRESHOLD,
  LANE_MIN_RECIPIENT_SENDS,
  ROW_MIN_RECIPIENT_SENDS,
  coverageVerdict,
  laneSpikeVerdict,
} from './verdicts.js';
import {
  AUTH_CORROBORATION_CODES,
  COVERAGE_WINDOW_BUCKETS,
  DIMENSIONS,
  MAX_TRACKED_COMPLAINTS,
  MAX_TRACKED_VALUES,
  MAX_WINDOW_BUCKETS,
  SPIKE_WINDOW_BUCKETS,
  WindowTooLongError,
  assertFoldWindow,
  coverageWindowFor,
  createWindowFold,
  spikeWindowFor,
  summarizeWindow,
  windowCoverage,
  type BucketWindow,
  type WindowFoldState,
  type WindowSummary,
} from './window-fold.js';

const NOW_MS = Date.UTC(2026, 9, 11, 12, 2, 0);
const WINDOW = spikeWindowFor(NOW_MS);

function scenario(groups: LaneScenario['groups']): LaneScenario {
  return {
    configurationSet: TEST_CONFIGURATION_SET,
    streamTag: 'stream-a',
    callerIdentity: 'prop-caller',
    fromDomain: 'news.example.com',
    groups,
  };
}

function foldOnce(records: readonly EventRecord[], window: BucketWindow = WINDOW, nowMs: number = NOW_MS): WindowFoldState {
  const fold = createWindowFold({ lane: TEST_CONFIGURATION_SET, window, nowMs });
  return fold.step(fold.initial, records);
}

function onlySend(): EventRecord {
  const send = scenarioRecords(scenario([{ bucketOffset: 0, count: 1 }]), NOW_MS, TEST_LANE_MAP, TEST_KEY_SET).find(
    (record) => record.kind === 'send',
  );
  if (send === undefined) throw new Error('expected the scenario to store one send');
  return send;
}

function variant(base: EventRecord, index: number, change: (record: EventRecord) => void): EventRecord {
  const record = structuredClone(base);
  record.sk = `${base.sk}#v${index}`;
  change(record);
  return record;
}

// A union of hits over plain objects, arrays, maps and sets: true wherever an EventRecord sits. The
// depth bound only keeps the checker finite; the deepest path in the fold state is six levels.
type RecordHits<T, Depth extends 0[] = []> = Depth['length'] extends 8
  ? never
  : [T] extends [EventRecord]
    ? true
    : T extends ReadonlyMap<infer K, infer V>
      ? RecordHits<K, [...Depth, 0]> | RecordHits<V, [...Depth, 0]>
      : T extends ReadonlySet<infer V>
        ? RecordHits<V, [...Depth, 0]>
        : T extends readonly (infer E)[]
          ? RecordHits<E, [...Depth, 0]>
          : T extends object
            ? { [K in keyof T]-?: RecordHits<T[K], [...Depth, 0]> }[keyof T]
            : never;
type ContainsRecordArray<T> = true extends RecordHits<T> ? true : false;

function holdsRecordShape(value: unknown, seen = new Set<unknown>()): boolean {
  if (typeof value !== 'object' || value === null || seen.has(value)) return false;
  seen.add(value);
  if ('pk' in value && 'sk' in value) return true;
  const children = value instanceof Map ? [...value.keys(), ...value.values()] : value instanceof Set ? [...value] : Object.values(value);
  return children.some((child) => holdsRecordShape(child, seen));
}

describe('the window fold state holds tallies, never records (AC-1)', () => {
  it('types its state and summary with no EventRecord at any depth, and a folded state holds none at runtime', () => {
    expectTypeOf<ContainsRecordArray<WindowFoldState>>().toEqualTypeOf<false>();
    expectTypeOf<ContainsRecordArray<WindowSummary>>().toEqualTypeOf<false>();
    expectTypeOf<ContainsRecordArray<{ tally: number; kept: Map<string, EventRecord[]> }>>().toEqualTypeOf<true>();

    const records = scenarioRecords(scenario([{ bucketOffset: 0, count: 30, batch: 'b1', permanentBounces: 3, complaints: 2 }]), NOW_MS, TEST_LANE_MAP, TEST_KEY_SET);
    const state = foldOnce(records);
    expect(summarizeWindow(state).totals.recipientSends).toBe(30);
    expect(holdsRecordShape(state)).toBe(false);
    expect(holdsRecordShape(summarizeWindow(state))).toBe(false);
    expect(holdsRecordShape({ kept: [records[0]] })).toBe(true);
  });
});

describe('the window bound and the live-record rule', () => {
  it('reads a window of exactly MAX_WINDOW_BUCKETS buckets and refuses one bucket more by name (AC-E1)', () => {
    const toBucketMs = bucketStartMs(NOW_MS);
    expect(() => assertFoldWindow(toBucketMs - (MAX_WINDOW_BUCKETS - 1) * BUCKET_MS, toBucketMs)).not.toThrow();
    expect(() => assertFoldWindow(toBucketMs - MAX_WINDOW_BUCKETS * BUCKET_MS, toBucketMs)).toThrow(WindowTooLongError);
    expect(() => createWindowFold({ lane: TEST_CONFIGURATION_SET, window: { fromBucketMs: toBucketMs - MAX_WINDOW_BUCKETS * BUCKET_MS, toBucketMs }, nowMs: NOW_MS })).toThrow(
      `a window of ${MAX_WINDOW_BUCKETS + 1} buckets is longer than the maximum of ${MAX_WINDOW_BUCKETS} buckets`,
    );
  });

  it('skips a record whose expiresAt equals now in seconds and counts it one second earlier (AC-E2, the step check)', () => {
    const send = onlySend();
    send.expiresAt = Math.floor(NOW_MS / 1000);
    expect(summarizeWindow(foldOnce([send])).totals.recipientSends).toBe(0);
    expect(summarizeWindow(foldOnce([send], WINDOW, NOW_MS - 1000)).totals.recipientSends).toBe(1);
  });

  it('counts nothing for a record whose mail timestamp is 31 days old, and the same record inside its retention counts', () => {
    const oldNowMs = NOW_MS - 31 * 24 * 60 * 60 * 1000;
    const oldWindow = spikeWindowFor(oldNowMs);
    const records = scenarioRecords(scenario([{ bucketOffset: 0, count: 5, batch: 'old' }]), oldNowMs, TEST_LANE_MAP, TEST_KEY_SET);
    const expired = summarizeWindow(foldOnce(records, oldWindow, NOW_MS));
    expect(expired.totals.recipientSends).toBe(0);
    expect(expired.buckets.every((bucket) => bucket.send === 0 && bucket.delivery === 0)).toBe(true);
    expect(expired.dimensions.batch.size).toBe(0);
    expect(expired.observed.recordCount).toBe(0);
    expect(summarizeWindow(foldOnce(records, oldWindow, oldNowMs)).totals.recipientSends).toBe(5);
  });

  it('gives a zero tally for every bucket of an empty window and never throws (AC-E3)', () => {
    const summary = summarizeWindow(foldOnce([]));
    expect(summary.pages).toBe(1);
    expect(summary.buckets).toHaveLength(SPIKE_WINDOW_BUCKETS);
    expect(summary.buckets.map((bucket) => bucket.bucketStartMs)).toEqual(
      Array.from({ length: SPIKE_WINDOW_BUCKETS }, (_, index) => WINDOW.fromBucketMs + index * BUCKET_MS),
    );
    for (const bucket of summary.buckets) {
      const { bucketStartMs: _start, complete, ...counts } = bucket;
      expect(complete).toBe(false);
      expect(Object.values(counts).every((value) => value === 0)).toBe(true);
    }
    expect(summary.totals).toEqual({
      recipientSends: 0,
      permanentBounces: 0,
      complaints: 0,
      permanentBouncesByAuthCode: { 20: 0, 21: 0, 22: 0, 23: 0, 24: 0, 26: 0 },
    });
  });
});

// The property drives the step directly: generated messages plus a tagged scenario, sorted as the
// store sorts them, cut into pages of one to seven records and fed in any order.
const PROPERTY_BASE_MS = Date.UTC(2024, 0, 1, 0, 0, 0);
const PROPERTY_WINDOW: BucketWindow = { fromBucketMs: PROPERTY_BASE_MS, toBucketMs: PROPERTY_BASE_MS + 30 * BUCKET_MS };
const PROPERTY_NOW_MS = PROPERTY_BASE_MS + 24 * 60 * 60 * 1000;
const TAGGED_RECORDS = scenarioRecords(
  scenario([
    { bucketOffset: 2, count: 30, batch: 'b1', permanentBounces: 4, complaints: 2, receivingDomains: ['example.com', 'example.org'] },
    { bucketOffset: 5, count: 25, batch: 'b2', template: 't1', suppressedBounces: 2 },
  ]),
  PROPERTY_BASE_MS + 20 * BUCKET_MS,
  TEST_LANE_MAP,
  TEST_KEY_SET,
);

function sortedStream(cases: readonly MessageCase[]): EventRecord[] {
  const generated = ingestAll(
    cases.flatMap((mc) => envelopesFor(mc)),
    contextFor(PROPERTY_NOW_MS),
  );
  return [...generated, ...TAGGED_RECORDS].sort((left, right) => Buffer.compare(Buffer.from(left.sk), Buffer.from(right.sk)));
}

function pagesOf(records: readonly EventRecord[], pageSize: number): EventRecord[][] {
  const pages: EventRecord[][] = [];
  for (let start = 0; start < records.length; start += pageSize) pages.push(records.slice(start, start + pageSize));
  return pages;
}

function countTallies(summary: WindowSummary) {
  return {
    buckets: summary.buckets,
    totals: summary.totals,
    noValue: summary.noValue,
    dimensions: DIMENSIONS.map((dimension) => [...summary.dimensions[dimension]].sort(([left], [right]) => (left < right ? -1 : 1))),
  };
}

function foldPages(pages: readonly (readonly EventRecord[])[]): WindowSummary {
  const fold = createWindowFold({ lane: TEST_CONFIGURATION_SET, window: PROPERTY_WINDOW, nowMs: PROPERTY_NOW_MS });
  return summarizeWindow(pages.reduce((state, page) => fold.step(state, page), fold.initial));
}

const pagedStreamArb = fc
  .tuple(fc.array(messageCaseArb, { minLength: 0, maxLength: 12 }), fc.integer({ min: 1, max: 7 }))
  .chain(([cases, pageSize]) => {
    const records = sortedStream(cases);
    const pages = pagesOf(records, pageSize);
    return fc.shuffledSubarray(pages, { minLength: pages.length }).map((shuffled) => ({ records, shuffled }));
  });

describe('the fold gives the same count tallies whatever the paging (R1 ordering backstop)', () => {
  it('equals the single-page tallies for every page size from 1 to 7 and every page order', () =>
    fc.assert(
      fc.property(pagedStreamArb, ({ records, shuffled }) => {
        expect(countTallies(foldPages(shuffled))).toEqual(countTallies(foldPages([records])));
      }),
      { seed: propertySeed() },
    ));
});

describe('every collection the fold keeps is capped (D-46, review fold 2026-10-12)', () => {
  it('tracks MAX_TRACKED_VALUES batch values whole and sets dimensionBound on one more', () => {
    const base = onlySend();
    const atCap = Array.from({ length: MAX_TRACKED_VALUES }, (_, index) =>
      variant(base, index, (record) => {
        record.fields.batchTagValue = `batch-${index}`;
      }),
    );
    const full = summarizeWindow(foldOnce(atCap));
    expect(full.dimensions.batch.size).toBe(MAX_TRACKED_VALUES);
    expect(full.dimensionBound).toBe(false);

    const oneMore = variant(base, MAX_TRACKED_VALUES, (record) => {
      record.fields.batchTagValue = 'batch-one-more';
    });
    const past = summarizeWindow(foldOnce([...atCap, oneMore]));
    expect(past.dimensionBound).toBe(true);
    expect(past.dimensions.batch.size).toBe(MAX_TRACKED_VALUES);
    expect(past.dimensions.batch.has('batch-one-more')).toBe(false);
  });

  it('tracks MAX_TRACKED_COMPLAINTS complaint ids whole and sets dimensionBound without keeping one more', () => {
    const complaint = scenarioRecords(scenario([{ bucketOffset: 0, count: 1, complaints: 1 }]), NOW_MS, TEST_LANE_MAP, TEST_KEY_SET).find(
      (record) => record.kind === 'complaint',
    );
    if (complaint === undefined) throw new Error('expected a complaint counting record');
    const atCap = Array.from({ length: MAX_TRACKED_COMPLAINTS }, (_, index) =>
      variant(complaint, index, (record) => {
        record.feedbackId = `fb-cap-${index}`;
      }),
    );
    const full = foldOnce(atCap);
    expect(full.trackedComplaints).toBe(MAX_TRACKED_COMPLAINTS);
    expect(full.dimensionBound).toBe(false);

    const past = foldOnce([
      ...atCap,
      variant(complaint, MAX_TRACKED_COMPLAINTS, (record) => {
        record.feedbackId = 'fb-cap-one-more';
      }),
    ]);
    expect(past.dimensionBound).toBe(true);
    expect(past.trackedComplaints).toBe(MAX_TRACKED_COMPLAINTS);
  });

  it('sets dimensionBound when a lane carries one stream-tag value past MAX_TRACKED_VALUES, and not at the cap', () => {
    const base = onlySend();
    const streams = (count: number) =>
      Array.from({ length: count }, (_, index) =>
        variant(base, index, (record) => {
          record.fields.streamTagValue = `stream-${index}`;
        }),
      );
    const full = foldOnce(streams(MAX_TRACKED_VALUES));
    expect(full.dimensionBound).toBe(false);
    expect(full.observe.streamTagValues.size).toBe(MAX_TRACKED_VALUES);
    const past = foldOnce(streams(MAX_TRACKED_VALUES + 1));
    expect(past.dimensionBound).toBe(true);
    expect(past.observe.streamTagValues.size).toBe(MAX_TRACKED_VALUES);
  });
});

describe('complaint attribution to a receiving domain', () => {
  const twoRecipientComplaint = (): EventRecord[] =>
    ingestAll(
      envelopesFor({
        messageSeed: 7,
        recipientCount: 2,
        sendTimestampMs: bucketStartMs(NOW_MS) + 1_000,
        bounces: [],
        delivery: undefined,
        complaint: { feedbackId: 'fb-two', timestampMs: bucketStartMs(NOW_MS) + 3_000 },
        delays: [],
      }),
      contextFor(NOW_MS),
    );

  it('attributes a complaint whose recipients share one domain to it, and one spanning two domains to no value', () => {
    const shared = summarizeWindow(foldOnce(twoRecipientComplaint()));
    expect(shared.totals.complaints).toBe(1);
    expect(shared.dimensions.receivingDomain.get('example.com')?.complaints).toBe(1);
    expect(shared.noValue.receivingDomain.complaints).toBe(0);

    const spanning = twoRecipientComplaint();
    const recipient = spanning.find((record) => record.kind === 'complaintRecipient');
    if (recipient === undefined) throw new Error('expected complaint recipient items');
    recipient.receivingDomain = 'example.org';
    const spread = summarizeWindow(foldOnce(spanning));
    expect(spread.totals.complaints).toBe(1);
    expect(spread.dimensions.receivingDomain.get('example.com')?.complaints ?? 0).toBe(0);
    expect(spread.noValue.receivingDomain.complaints).toBe(1);
  });

  it('sums each dimension, no-value tally included, to the lane complaint total', () => {
    const records = [
      ...twoRecipientComplaint(),
      ...scenarioRecords(
        scenario([
          { bucketOffset: 1, count: 6, batch: 'b1', complaints: 4, receivingDomains: ['example.com', 'gmail.com'] },
          { bucketOffset: 2, count: 3, complaints: 3 },
        ]),
        NOW_MS,
        TEST_LANE_MAP,
        TEST_KEY_SET,
      ),
    ];
    const summary = summarizeWindow(foldOnce(records));
    expect(summary.totals.complaints).toBe(8);
    for (const dimension of DIMENSIONS) {
      const tracked = [...summary.dimensions[dimension].values()].reduce((sum, tally) => sum + tally.complaints, 0);
      expect(tracked + summary.noValue[dimension].complaints).toBe(summary.totals.complaints);
    }
  });
});

describe('permanent bounces per RFC 7372 authentication detail (D-61 as amended 2026-10-12)', () => {
  it('counts 5.7.20, 5.7.23 and 5.7.26 under their own detail and 5.7.1, 5.7.25, 5.1.1 and a suppressed 5.7.26 under none', () => {
    const union = [...new Set(Object.values(AUTH_CORROBORATION_CODES).flat())].sort((left, right) => left - right);
    expect(union).toEqual([20, 21, 22, 23, 24, 26]);

    const bouncing = (bucketOffset: number, diagnosticCode: string, suppressed = false) => ({
      bucketOffset,
      count: 1,
      diagnosticCode,
      ...(suppressed ? { suppressedBounces: 1 } : { permanentBounces: 1 }),
    });
    const records = scenarioRecords(
      scenario([
        bouncing(0, 'smtp; 550 5.7.20 No passing DKIM signature found'),
        bouncing(1, 'smtp; 550 5.7.23 SPF validation failed'),
        bouncing(2, 'smtp; 550 5.7.26 Multiple authentication checks failed'),
        bouncing(3, 'smtp; 550 5.7.1 Message rejected as spam'),
        bouncing(4, 'smtp; 550 5.7.25 Reverse DNS validation failed'),
        bouncing(5, 'smtp; 550 5.1.1 user unknown'),
        bouncing(6, 'smtp; 550 5.7.26 Multiple authentication checks failed', true),
      ]),
      NOW_MS,
      TEST_LANE_MAP,
      TEST_KEY_SET,
    );
    const summary = summarizeWindow(foldOnce(records));
    expect(summary.totals.permanentBounces).toBe(6);
    const expected = Object.fromEntries(union.map((detail) => [detail, 0]));
    Object.assign(expected, { 20: 1, 23: 1, 26: 1 });
    expect(summary.totals.permanentBouncesByAuthCode).toEqual(expected);
  });
});

describe('declared values, ids and keys the later plans build on', () => {
  it('declares the thresholds, volumes and windows once, with the coverage window equal to the spike window', () => {
    expect(HARD_BOUNCE_THRESHOLD).toEqual({ numerator: 5, denominator: 100 });
    expect(COVERAGE_THRESHOLD).toEqual({ numerator: 9, denominator: 10 });
    expect([LANE_MIN_RECIPIENT_SENDS, ROW_MIN_RECIPIENT_SENDS]).toEqual([100, 20]);
    expect([SPIKE_WINDOW_BUCKETS, COVERAGE_WINDOW_BUCKETS, MAX_WINDOW_BUCKETS]).toEqual([12, 12, 288]);
    expect(spikeWindowFor(NOW_MS)).toEqual({ fromBucketMs: bucketStartMs(NOW_MS) - 11 * BUCKET_MS, toBucketMs: bucketStartMs(NOW_MS) });
  });

  it('builds decision-store keys outside the LANE# partition and refuses a counter day that is not a UTC date', () => {
    const keys = [incidentLaneKey('fothering-bulk'), incidentItemKey('0'.repeat(32), 'EVIDENCE'), counterDayKey('2026-10-11')];
    expect(keys).toEqual([
      { pk: 'INCIDENT_LANE#fothering-bulk', sk: 'MARKER' },
      { pk: `INCIDENT#${'0'.repeat(32)}`, sk: 'EVIDENCE' },
      { pk: 'COUNTER_DAY#2026-10-11', sk: 'COUNTER' },
    ]);
    expect(keys.every((key) => !key.pk.startsWith('LANE#'))).toBe(true);
    expect(() => counterDayKey('2026-10-11T00:00:00Z')).toThrow(RangeError);
  });

  it('derives option ids per incident and measures a serialized record against the byte ceiling', () => {
    expect(optionIdFor('a'.repeat(32), 0)).not.toBe(optionIdFor('b'.repeat(32), 0));
    expect(optionIdFor('a'.repeat(32), 0)).toMatch(/^opt-[0-9a-f]{24}$/);
    expect(RECORD_BYTE_CEILING).toBe(16_384);
    const twoByteCharacter = { note: 'é' } as unknown as EvidenceRecord;
    expect(serializedRecordBytes(twoByteCharacter)).toBe(Buffer.byteLength('{"note":"é"}', 'utf8'));
    expect(serializedRecordBytes(twoByteCharacter)).toBe(13);
  });

  it('merges two observe tallies into the tally one pass over both record lists gives', () => {
    const records = scenarioRecords(scenario([{ bucketOffset: 0, count: 6, permanentBounces: 2 }]), NOW_MS, TEST_LANE_MAP, TEST_KEY_SET);
    const whole = createObserveTally();
    const first = createObserveTally();
    const second = createObserveTally();
    records.forEach((record, index) => {
      observeRecord(whole, record, NOW_MS);
      observeRecord(index % 2 === 0 ? first : second, record, NOW_MS);
    });
    expect(mergeObserveTallies(first, second)).toEqual(whole);
  });
});

// The store hands a lane's records over in UTF-8 byte order of the sort key, so every record of a
// bucket arrives together and its Send records last (they sort after every outcome type).
function storeOrder(records: readonly EventRecord[]): EventRecord[] {
  return [...records].sort((left, right) => Buffer.compare(Buffer.from(left.sk), Buffer.from(right.sk)));
}

function foldPaged(records: readonly EventRecord[], window: BucketWindow, nowMs: number, pageSize: number): WindowSummary {
  const fold = createWindowFold({ lane: TEST_CONFIGURATION_SET, window, nowMs });
  return summarizeWindow(pagesOf(records, pageSize).reduce((state, page) => fold.step(state, page), fold.initial));
}

type LateOutcome = 'Delivery' | 'Bounce' | 'Reject';

// An outcome SES could still send for a recipient-send already stored: same message, recipient
// and send-time bucket, its own sort key.
function lateOutcomeFor(send: EventRecord, eventType: LateOutcome, index: number): EventRecord {
  const record = structuredClone(send);
  const key = recordKey({ configurationSet: send.configurationSet, bucketStartMs: send.bucketStartMs, eventType, identity: `${send.messageId}#late-${index}` });
  record.pk = key.pk;
  record.sk = key.sk;
  record.kind = 'outcome';
  record.eventType = eventType;
  if (eventType === 'Reject') {
    delete record.recipientHmac;
    delete record.receivingDomain;
    delete record.keyVersion;
  }
  if (eventType === 'Bounce') {
    record.feedbackId = `fb-late-${index}`;
    record.fields = { ...record.fields, bounceType: 'Permanent', bounceSubType: 'General' };
  }
  return record;
}

describe('buckets whose outcomes arrived before their sends (R3 sends-pending guard)', () => {
  const healthyAndBouncing = (withBouncingSends: boolean): EventRecord[] => {
    const records = scenarioRecords(
      scenario([
        { bucketOffset: 1, count: 100 },
        { bucketOffset: 0, count: 20, permanentBounces: 10 },
      ]),
      NOW_MS,
      TEST_LANE_MAP,
      TEST_KEY_SET,
    );
    const bouncingBucket = bucketStartMs(NOW_MS);
    return storeOrder(records.filter((record) => withBouncingSends || record.kind !== 'send' || record.bucketStartMs !== bouncingBucket));
  };

  it('reads a bucket holding bounces with no send records as sends pending and leaves it out of the ratios', () => {
    const summary = summarizeWindow(foldOnce(healthyAndBouncing(false)));
    expect(summary.pendingBuckets).toEqual([bucketStartMs(NOW_MS)]);
    expect(summary.totals.permanentBounces).toBe(0);
    expect(summary.totals.recipientSends).toBe(100);
    expect(summary.buckets.find((bucket) => bucket.bucketStartMs === bucketStartMs(NOW_MS))?.permanentBounce).toBe(10);
    expect(laneSpikeVerdict(summary.totals).verdict).toBe('no-spike');
  });

  it('counts the same bucket once its sends are stored, and the lane then spikes', () => {
    const summary = summarizeWindow(foldOnce(healthyAndBouncing(true)));
    expect(summary.pendingBuckets).toEqual([]);
    expect(summary.totals).toMatchObject({ recipientSends: 120, permanentBounces: 10 });
    expect(laneSpikeVerdict(summary.totals).verdict).toBe('spike');
  });

  const spikingLaneArb = fc
    .record({
      count: fc.integer({ min: 100, max: 160 }),
      extraBounces: fc.integer({ min: 0, max: 6 }),
      deliverRest: fc.boolean(),
      late: fc.array(fc.record({ pick: fc.nat(), eventType: fc.constantFrom<LateOutcome>('Delivery', 'Bounce', 'Reject') }), { maxLength: 30 }),
    })
    .map((spec) => {
      const records = scenarioRecords(
        scenario([{ bucketOffset: 0, count: spec.count, permanentBounces: Math.ceil(spec.count / 20) + spec.extraBounces, deliverRest: spec.deliverRest }]),
        NOW_MS,
        TEST_LANE_MAP,
        TEST_KEY_SET,
      );
      const sends = records.filter((record) => record.kind === 'send');
      const late = spec.late.map(({ pick, eventType }, index) => {
        const send = sends[pick % sends.length];
        if (send === undefined) throw new Error('expected a stored send');
        return lateOutcomeFor(send, eventType, index);
      });
      return { records, late };
    });

  it('never turns a spike into no spike when outcomes arrive for sends already stored (AC-5)', () =>
    fc.assert(
      fc.property(spikingLaneArb, ({ records, late }) => {
        expect(laneSpikeVerdict(summarizeWindow(foldOnce(storeOrder(records))).totals).verdict).toBe('spike');
        const withLate = summarizeWindow(foldOnce(storeOrder([...records, ...late])));
        expect(withLate.pendingBuckets).toEqual([]);
        expect(laneSpikeVerdict(withLate.totals).verdict).toBe('spike');
      }),
      { seed: propertySeed(), numRuns: 40 },
    ));
});

describe('outcome coverage over complete buckets (R4, AC-6, AC-E12 to AC-E14)', () => {
  const COMPLETE_NOW_MS = NOW_MS + BUCKET_MS + LATENESS_HORIZON_MS;
  const coverageOf = (records: readonly EventRecord[], nowMs = COMPLETE_NOW_MS): WindowSummary =>
    summarizeWindow(foldOnce(storeOrder(records), coverageWindowFor(nowMs), nowMs));
  const covering = (covered: number, uncovered: number): EventRecord[] =>
    scenarioRecords(
      scenario([
        { bucketOffset: 0, count: covered },
        { bucketOffset: 0, count: uncovered, deliverRest: false },
      ]),
      NOW_MS,
      TEST_LANE_MAP,
      TEST_KEY_SET,
    );

  it('ends the coverage window with the newest complete bucket, 12 buckets long (D-44)', () => {
    const window = coverageWindowFor(COMPLETE_NOW_MS);
    expect(window).toEqual({ fromBucketMs: bucketStartMs(NOW_MS) - (COVERAGE_WINDOW_BUCKETS - 1) * BUCKET_MS, toBucketMs: bucketStartMs(NOW_MS) });
    expect(isBucketComplete(window.toBucketMs, COMPLETE_NOW_MS)).toBe(true);
    expect(isBucketComplete(window.toBucketMs + BUCKET_MS, COMPLETE_NOW_MS)).toBe(false);
  });

  it('reads coverage exactly at 9/10 of recipient-sends as data and one covered fewer as NO DATA', () => {
    const at = coverageOf(covering(90, 10));
    expect(coverageVerdict(at)).toBe('data');
    expect(at.coverage).toEqual({ recipientSends: 100, covered: 90 });
    const below = coverageOf(covering(89, 11));
    expect(below.coverage).toEqual({ recipientSends: 100, covered: 89 });
    expect(coverageVerdict(below)).toBe('no-data');
  });

  it('computes no coverage over complete buckets without recipient-sends, which reads not judged (AC-E13)', () => {
    const empty = coverageOf([]);
    expect(empty.coverage).toEqual({ recipientSends: 0, covered: 0 });
    expect(coverageVerdict(empty)).toBe('not-judged');
  });

  it('covers every recipient of a rejected message, and a recipient with a Delivery and a later Bounce once (AC-E14)', () => {
    const sendTimestampMs = bucketStartMs(NOW_MS) + 1_000;
    const threeRecipients = ingestAll(
      envelopesFor({ messageSeed: 41, recipientCount: 3, sendTimestampMs, bounces: [], delivery: undefined, complaint: undefined, delays: [] }),
      contextFor(NOW_MS),
    );
    const [firstSend] = threeRecipients;
    if (firstSend === undefined) throw new Error('expected three sends');
    const rejected = coverageOf([...threeRecipients, lateOutcomeFor(firstSend, 'Reject', 0)]);
    expect(rejected.coverage).toEqual({ recipientSends: 3, covered: 3 });

    const deliveredThenBounced = ingestAll(
      envelopesFor({
        messageSeed: 42,
        recipientCount: 1,
        sendTimestampMs,
        bounces: [{ feedbackId: 'fb-42', bounceType: 'Permanent', bounceSubType: 'General', timestampMs: sendTimestampMs + 2_000 }],
        delivery: { timestampMs: sendTimestampMs + 500 },
        complaint: undefined,
        delays: [],
      }),
      contextFor(NOW_MS),
    );
    const once = coverageOf(deliveredThenBounced);
    expect(once.coverage).toEqual({ recipientSends: 1, covered: 1 });
    expect(once.pendingBuckets).toEqual([]);
  });

  it('finalizes a bucket split across a page boundary once, with its full key set (D-45)', () => {
    const records = storeOrder(covering(95, 5));
    const whole = foldPaged(records, coverageWindowFor(COMPLETE_NOW_MS), COMPLETE_NOW_MS, records.length);
    expect(whole.coverage).toEqual({ recipientSends: 100, covered: 95 });
    for (const pageSize of [1, 2, 7, 97]) {
      const paged = foldPaged(records, coverageWindowFor(COMPLETE_NOW_MS), COMPLETE_NOW_MS, pageSize);
      expect(paged.pages).toBeGreaterThan(1);
      expect([paged.coverage, paged.pendingBuckets, paged.orderBroken]).toEqual([whole.coverage, whole.pendingBuckets, false]);
    }
  });

  it('marks orderBroken when a record of an already finalized bucket arrives, reads NO DATA, and keeps the raw counts', () => {
    const records = storeOrder(
      scenarioRecords(
        scenario([
          { bucketOffset: 1, count: 30 },
          { bucketOffset: 0, count: 30 },
        ]),
        NOW_MS,
        TEST_LANE_MAP,
        TEST_KEY_SET,
      ),
    );
    const window = coverageWindowFor(COMPLETE_NOW_MS);
    const inOrder = summarizeWindow(foldOnce(records, window, COMPLETE_NOW_MS));
    expect([inOrder.orderBroken, coverageVerdict(inOrder)]).toEqual([false, 'data']);
    const [straggler, ...rest] = records;
    if (straggler === undefined) throw new Error('expected records');
    const broken = summarizeWindow(foldOnce([...rest, straggler], window, COMPLETE_NOW_MS));
    expect(broken.orderBroken).toBe(true);
    expect(coverageVerdict(broken)).toBe('no-data');
    expect(broken.buckets).toEqual(inOrder.buckets);
  });

  it('turns the incomplete-bucket case red under a planted coverage that also counts incomplete buckets (AC-6)', () => {
    const records = storeOrder([
      ...scenarioRecords(scenario([{ bucketOffset: 0, count: 100 }]), NOW_MS, TEST_LANE_MAP, TEST_KEY_SET),
      ...scenarioRecords(scenario([{ bucketOffset: 0, count: 100, deliverRest: false }]), COMPLETE_NOW_MS, TEST_LANE_MAP, TEST_KEY_SET),
    ]);
    const span: BucketWindow = { fromBucketMs: bucketStartMs(NOW_MS), toBucketMs: bucketStartMs(COMPLETE_NOW_MS) };
    const summary = summarizeWindow(foldOnce(records, span, COMPLETE_NOW_MS));
    const incompleteCaseHolds = (counts?: Parameters<typeof windowCoverage>[1]): boolean =>
      coverageVerdict({ coverage: windowCoverage(summary.bucketCoverage, counts), orderBroken: summary.orderBroken }) === 'data';
    expect(summary.coverage).toEqual({ recipientSends: 100, covered: 100 });
    expect(incompleteCaseHolds()).toBe(true);
    expect(incompleteCaseHolds(() => true)).toBe(false);
  });
});
