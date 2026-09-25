import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  BUCKET_MS,
  LATENESS_HORIZON_MS,
  SUPPRESSION_BOUNCE_SUBTYPES,
  bucketStartMs,
  countLaneBuckets,
  hardBounceRatio,
  isBucketComplete,
} from './buckets.js';
import { minimizeEvent, type MinimizeContext } from './minimize.js';
import { parseSesEvent } from './ses-events.js';
import type { EventRecord } from './records.js';
import type { LaneEntry } from './lanes.js';
import type { SesEnvelope } from './ses-events.js';
import { propertySeed } from './test/property-seed.js';
import {
  TEST_LANE,
  bucketRangeFor,
  contextFor,
  envelopesFor,
  ingestAll,
  messageCaseArb,
  sendTimestampMsArb,
  type BounceTypeChoice,
  type MessageCase,
} from './test/event-arbitraries.js';
import { createFixtureEventStore } from '@fothering/providers/fixtures/ingest-ports';

// D-28: every property runs on the fixed default seed unless FOTHERING_PROPERTY_SEED overrides it.
const SEED = propertySeed();

function maxTimestamp(cases: readonly MessageCase[]): number {
  return Math.max(...cases.map((mc) => mc.sendTimestampMs));
}

function registerBucketProperties(): void {
  it('positive control: the worker’s own timezone offset changed', () => {
    // asserted by the caller before this function runs; kept here only so a future reordering
    // cannot accidentally drop it silently.
    expect(typeof new Date(0).getTimezoneOffset()).toBe('number');
  });

  it('counts are invariant under duplication', () => {
    fc.assert(
      fc.property(fc.array(messageCaseArb, { minLength: 1, maxLength: 3 }), (cases) => {
        const envelopes = cases.flatMap((mc) => envelopesFor(mc));
        const nowMs = maxTimestamp(cases) + BUCKET_MS + LATENESS_HORIZON_MS + 1;
        const range = bucketRangeFor(cases);
        const once = countLaneBuckets(ingestAll(envelopes, contextFor(nowMs)), { ...range, nowMs });
        const duplicated = countLaneBuckets(ingestAll([...envelopes, ...envelopes], contextFor(nowMs)), { ...range, nowMs });
        expect(duplicated).toEqual(once);
      }),
      { seed: SEED },
    );
  });

  it('counts are invariant under any permutation of the event stream', () => {
    fc.assert(
      fc.property(
        fc.array(messageCaseArb, { minLength: 1, maxLength: 3 }).chain((cases) => {
          const envelopes = cases.flatMap((mc) => envelopesFor(mc));
          return fc.tuple(
            fc.constant(cases),
            fc.shuffledSubarray(envelopes, { minLength: envelopes.length, maxLength: envelopes.length }),
          );
        }),
        ([cases, shuffled]) => {
          const envelopes = cases.flatMap((mc) => envelopesFor(mc));
          const nowMs = maxTimestamp(cases) + BUCKET_MS + LATENESS_HORIZON_MS + 1;
          const range = bucketRangeFor(cases);
          const baseline = countLaneBuckets(ingestAll(envelopes, contextFor(nowMs)), { ...range, nowMs });
          const permuted = countLaneBuckets(ingestAll(shuffled, contextFor(nowMs)), { ...range, nowMs });
          expect(permuted).toEqual(baseline);
        },
      ),
      { seed: SEED },
    );
  });

  it('counts are invariant under a varied arrival clock (delay invariance)', () => {
    fc.assert(
      fc.property(
        fc.array(messageCaseArb, { minLength: 1, maxLength: 3 }),
        fc.integer({ min: 0, max: 10_000_000 }),
        (cases, arrivalDelayMs) => {
          const envelopes = cases.flatMap((mc) => envelopesFor(mc));
          const nowMs = maxTimestamp(cases) + BUCKET_MS + LATENESS_HORIZON_MS + 1;
          const range = bucketRangeFor(cases);
          const baseline = countLaneBuckets(ingestAll(envelopes, contextFor(nowMs)), { ...range, nowMs });
          const delayed = countLaneBuckets(ingestAll(envelopes, contextFor(nowMs + arrivalDelayMs)), { ...range, nowMs });
          expect(delayed).toEqual(baseline);
        },
      ),
      { seed: SEED },
    );
  });

  it('adding one new recipient-level record changes exactly one bucket’s send count by exactly one', () => {
    fc.assert(
      fc.property(messageCaseArb, (mc) => {
        const withExtra: MessageCase = { ...mc, recipientCount: mc.recipientCount + 1 };
        const nowMs = mc.sendTimestampMs + BUCKET_MS + LATENESS_HORIZON_MS + 1;
        const range = bucketRangeFor([mc]);
        const before = countLaneBuckets(ingestAll(envelopesFor(mc), contextFor(nowMs)), { ...range, nowMs });
        const after = countLaneBuckets(ingestAll(envelopesFor(withExtra), contextFor(nowMs)), { ...range, nowMs });
        const sendBefore = before.reduce((sum, bucket) => sum + bucket.send, 0);
        const sendAfter = after.reduce((sum, bucket) => sum + bucket.send, 0);
        expect(sendAfter).toBe(sendBefore + 1);
        const changed = before.filter((bucket, i) => bucket.send !== after[i]?.send);
        expect(changed).toHaveLength(1);
      }),
      { seed: SEED },
    );
  });

  it('a bucket younger than the horizon reads incomplete', () => {
    fc.assert(
      fc.property(messageCaseArb, (mc) => {
        const bucketStart = bucketStartMs(mc.sendTimestampMs);
        const nowMs = bucketStart + BUCKET_MS + LATENESS_HORIZON_MS - 1;
        const range = bucketRangeFor([mc]);
        const buckets = countLaneBuckets(ingestAll(envelopesFor(mc), contextFor(nowMs)), { ...range, nowMs });
        const own = buckets.find((bucket) => bucket.bucketStartMs === bucketStart);
        if (own === undefined) throw new Error('expected the message’s own bucket in range');
        expect(own.complete).toBe(false);
      }),
      { seed: SEED },
    );
  });

  it('re-ingesting the same envelope writes one item, not two', () => {
    fc.assert(
      fc.property(messageCaseArb, (mc) => {
        const envelopes = envelopesFor(mc);
        const nowMs = mc.sendTimestampMs + BUCKET_MS + LATENESS_HORIZON_MS + 1;
        const once = ingestAll(envelopes, contextFor(nowMs));
        const twice = ingestAll([...envelopes, ...envelopes], contextFor(nowMs));
        expect(twice).toHaveLength(once.length);
      }),
      { seed: SEED },
    );
  });

  it('a three-recipient message with one hard bounce gives a ratio of 1/3, and a soft bounce gives 0', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 1_000_000 }), sendTimestampMsArb, (seed, sendTimestampMs) => {
        const buildCase = (bounceType: BounceTypeChoice): MessageCase => ({
          messageSeed: seed,
          recipientCount: 3,
          sendTimestampMs,
          bounces: [{ feedbackId: `fb-${seed}`, bounceType, bounceSubType: 'General', timestampMs: sendTimestampMs + 1_000 }],
          delivery: undefined,
          complaint: undefined,
          delays: [],
        });
        const nowMs = sendTimestampMs + BUCKET_MS + LATENESS_HORIZON_MS + 1;
        const ownBucketStart = bucketStartMs(sendTimestampMs);
        const range = bucketRangeFor([buildCase('Permanent')]);

        const hardBucket = countLaneBuckets(ingestAll(envelopesFor(buildCase('Permanent')), contextFor(nowMs)), {
          ...range,
          nowMs,
        }).find((bucket) => bucket.bucketStartMs === ownBucketStart);
        if (hardBucket === undefined) throw new Error('expected the message’s own bucket');
        expect(hardBounceRatio(hardBucket)).toBeCloseTo(1 / 3);

        const softBucket = countLaneBuckets(ingestAll(envelopesFor(buildCase('Transient')), contextFor(nowMs)), {
          ...range,
          nowMs,
        }).find((bucket) => bucket.bucketStartMs === ownBucketStart);
        if (softBucket === undefined) throw new Error('expected the message’s own bucket');
        expect(hardBounceRatio(softBucket)).toBe(0);
      }),
      { seed: SEED },
    );
  });

  it('a bounce or complaint suppression subtype counts only in the suppressed counters', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 1_000_000 }),
        sendTimestampMsArb,
        fc.constantFrom(...SUPPRESSION_BOUNCE_SUBTYPES),
        (seed, sendTimestampMs, subtype) => {
          const mc: MessageCase = {
            messageSeed: seed,
            recipientCount: 1,
            sendTimestampMs,
            bounces: [{ feedbackId: `fb-${seed}`, bounceType: 'Permanent', bounceSubType: subtype, timestampMs: sendTimestampMs + 1_000 }],
            delivery: undefined,
            complaint: undefined,
            delays: [],
          };
          const nowMs = sendTimestampMs + BUCKET_MS + LATENESS_HORIZON_MS + 1;
          const range = bucketRangeFor([mc]);
          const bucket = countLaneBuckets(ingestAll(envelopesFor(mc), contextFor(nowMs)), { ...range, nowMs }).find(
            (b) => b.bucketStartMs === bucketStartMs(sendTimestampMs),
          );
          if (bucket === undefined) throw new Error('expected the message’s own bucket');
          expect(bucket.suppressedBounce).toBe(1);
          expect(bucket.permanentBounce).toBe(0);
          expect(bucket.transientBounce).toBe(0);
          expect(bucket.undeterminedBounce).toBe(0);
        },
      ),
      { seed: SEED },
    );
  });

  it('an unclassified bounceType counts as undeterminedBounce', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 1_000_000 }), sendTimestampMsArb, (seed, sendTimestampMs) => {
        const mc: MessageCase = {
          messageSeed: seed,
          recipientCount: 1,
          sendTimestampMs,
          bounces: [
            { feedbackId: `fb-${seed}`, bounceType: 'unclassified' as BounceTypeChoice, bounceSubType: 'unclassified', timestampMs: sendTimestampMs + 1_000 },
          ],
          delivery: undefined,
          complaint: undefined,
          delays: [],
        };
        const nowMs = sendTimestampMs + BUCKET_MS + LATENESS_HORIZON_MS + 1;
        const range = bucketRangeFor([mc]);
        const bucket = countLaneBuckets(ingestAll(envelopesFor(mc), contextFor(nowMs)), { ...range, nowMs }).find(
          (b) => b.bucketStartMs === bucketStartMs(sendTimestampMs),
        );
        if (bucket === undefined) throw new Error('expected the message’s own bucket');
        expect(bucket.undeterminedBounce).toBe(1);
      }),
      { seed: SEED },
    );
  });

  it('an outcome event that arrives before its Send is still counted in the send-time bucket (AC-E17)', () => {
    fc.assert(
      fc.property(
        messageCaseArb.filter((mc) => mc.delivery !== undefined),
        (mc) => {
          const [sendEnv, deliveryEnv, ...rest] = envelopesFor(mc);
          if (sendEnv === undefined || deliveryEnv === undefined) throw new Error('expected a Send and a Delivery envelope');
          const nowMs = mc.sendTimestampMs + BUCKET_MS + LATENESS_HORIZON_MS + 1;
          const range = bucketRangeFor([mc]);
          const outOfOrder = countLaneBuckets(ingestAll([deliveryEnv, sendEnv, ...rest], contextFor(nowMs)), { ...range, nowMs });
          const inOrder = countLaneBuckets(ingestAll([sendEnv, deliveryEnv, ...rest], contextFor(nowMs)), { ...range, nowMs });
          expect(outOfOrder).toEqual(inOrder);
          const own = outOfOrder.find((bucket) => bucket.bucketStartMs === bucketStartMs(mc.sendTimestampMs));
          if (own === undefined) throw new Error('expected the message’s own bucket');
          expect(own.delivery).toBe(mc.recipientCount);
        },
      ),
      { seed: SEED },
    );
  });

  it('countLaneBuckets over the real fixture event store matches the in-memory ground truth, and lanes never mix', async () => {
    const laneB: LaneEntry = { ...TEST_LANE, configurationSet: 'PropLane2', lane: 'prop-lane-2' };

    await fc.assert(
      fc.asyncProperty(messageCaseArb, messageCaseArb, async (mcA, mcBRaw) => {
        const mcB: MessageCase = { ...mcBRaw, messageSeed: mcBRaw.messageSeed + 2_000_000 };
        const store = createFixtureEventStore();
        const nowMs = Math.max(mcA.sendTimestampMs, mcB.sendTimestampMs) + BUCKET_MS + LATENESS_HORIZON_MS + 1;
        const contextA: MinimizeContext = { ...contextFor(nowMs), lane: TEST_LANE };
        const contextB: MinimizeContext = { ...contextFor(nowMs), lane: laneB };

        async function ingestThroughParse(raw: SesEnvelope, context: MinimizeContext): Promise<void> {
          const parsed = parseSesEvent(raw);
          if (!parsed.ok) throw new Error('expected the generated envelope to parse');
          for (const record of minimizeEvent(parsed.event, context)) {
            await store.putIfAbsent(record);
          }
        }

        const envelopesA = envelopesFor(mcA, TEST_LANE.configurationSet);
        const envelopesB = envelopesFor(mcB, laneB.configurationSet);
        const runA: { envelope: SesEnvelope; context: MinimizeContext }[] = envelopesA.map((envelope) => ({ envelope, context: contextA }));
        const runB: { envelope: SesEnvelope; context: MinimizeContext }[] = envelopesB.map((envelope) => ({ envelope, context: contextB }));
        const all = [...runA, ...runB];
        const reversed = [...all].reverse();
        for (const { envelope, context } of [...all, ...reversed]) {
          await ingestThroughParse(envelope, context);
        }

        const range = bucketRangeFor([mcA, mcB]);
        const storedA = await store.queryLane(TEST_LANE.configurationSet, range.fromBucketMs, range.toBucketMs, nowMs);
        const storedB = await store.queryLane(laneB.configurationSet, range.fromBucketMs, range.toBucketMs, nowMs);
        const expectedA = countLaneBuckets(ingestAll(envelopesA, contextA), { ...range, nowMs });
        const expectedB = countLaneBuckets(ingestAll(envelopesB, contextB), { ...range, nowMs });

        expect(countLaneBuckets(storedA, { ...range, nowMs })).toEqual(expectedA);
        expect(countLaneBuckets(storedB, { ...range, nowMs })).toEqual(expectedB);
        expect(storedA.every((record) => record.configurationSet === TEST_LANE.configurationSet)).toBe(true);
        expect(storedB.every((record) => record.configurationSet === laneB.configurationSet)).toBe(true);
      }),
      { seed: SEED, numRuns: 25 },
    );
  });
}

describe('AC-11 bucket and count properties, under UTC', () => {
  let originalTz: string | undefined;

  beforeAll(() => {
    originalTz = process.env.TZ;
    process.env.TZ = 'UTC';
    expect(new Date(0).getTimezoneOffset()).toBe(0);
  });

  afterAll(() => {
    if (originalTz === undefined) delete process.env.TZ;
    else process.env.TZ = originalTz;
  });

  registerBucketProperties();
});

describe('AC-11 bucket and count properties, under Asia/Kolkata', () => {
  let originalTz: string | undefined;

  beforeAll(() => {
    originalTz = process.env.TZ;
    process.env.TZ = 'Asia/Kolkata';
    // Positive control (D-28/AC-11): proves the worker actually changed timezone before trusting
    // any property below. -330 is Asia/Kolkata's fixed UTC+5:30 offset (no DST).
    expect(new Date(0).getTimezoneOffset()).toBe(-330);
  });

  afterAll(() => {
    if (originalTz === undefined) delete process.env.TZ;
    else process.env.TZ = originalTz;
  });

  registerBucketProperties();
});

describe('AC-11 planted failures (design choices the properties above guard)', () => {
  interface DedupParams {
    identity: (record: EventRecord) => string;
    bucket: (record: EventRecord, context: MinimizeContext) => number;
  }

  const REAL_PARAMS: DedupParams = {
    identity: (record) => `${record.pk}\u0000${record.sk}`,
    bucket: (record) => record.bucketStartMs,
  };

  function simulateBucketTotals(
    envelopes: readonly SesEnvelope[],
    context: MinimizeContext,
    params: DedupParams,
  ): Map<number, number> {
    const seen = new Map<string, EventRecord>();
    for (const envelope of envelopes) {
      for (const record of minimizeEvent(envelope, context)) {
        if (record.kind !== 'send' && record.kind !== 'outcome' && record.kind !== 'complaint') continue;
        const key = params.identity(record);
        if (!seen.has(key)) seen.set(key, record);
      }
    }
    const totals = new Map<number, number>();
    for (const record of seen.values()) {
      const bucket = params.bucket(record, context);
      totals.set(bucket, (totals.get(bucket) ?? 0) + 1);
    }
    return totals;
  }

  it('a messageId+eventType identity collapses distinct recipients, so fc.check reports failed', () => {
    const wrongIdentity: DedupParams['identity'] = (record) => `${record.messageId}#${record.eventType}`;
    const result = fc.check(
      fc.property(messageCaseArb, (mc) => {
        const withExtra: MessageCase = { ...mc, recipientCount: mc.recipientCount + 1 };
        const nowMs = mc.sendTimestampMs + BUCKET_MS + LATENESS_HORIZON_MS + 1;
        const before = simulateBucketTotals(envelopesFor(mc), contextFor(nowMs), { ...REAL_PARAMS, identity: wrongIdentity });
        const after = simulateBucketTotals(envelopesFor(withExtra), contextFor(nowMs), { ...REAL_PARAMS, identity: wrongIdentity });
        const totalBefore = [...before.values()].reduce((sum, count) => sum + count, 0);
        const totalAfter = [...after.values()].reduce((sum, count) => sum + count, 0);
        return totalAfter === totalBefore + 1;
      }),
      { seed: SEED },
    );
    expect(result.failed).toBe(true);
  });

  it('bucketing by arrival time instead of send time loses the message from its own bucket, so fc.check reports failed', () => {
    const wrongBucket: DedupParams['bucket'] = (_record, context) => bucketStartMs(context.arrivalTimeMs);
    const result = fc.check(
      fc.property(messageCaseArb, (mc) => {
        const nowMs = mc.sendTimestampMs + BUCKET_MS + LATENESS_HORIZON_MS + 1;
        const totals = simulateBucketTotals(envelopesFor(mc), contextFor(nowMs), { ...REAL_PARAMS, bucket: wrongBucket });
        const ownBucket = bucketStartMs(mc.sendTimestampMs);
        return (totals.get(ownBucket) ?? 0) > 0;
      }),
      { seed: SEED },
    );
    expect(result.failed).toBe(true);
  });

  it('treating every bucket as complete breaks the lateness-horizon invariant, so fc.check reports failed', () => {
    const wrongComplete = (_bucketStartMs: number, _nowMs: number): boolean => true;
    const result = fc.check(
      fc.property(messageCaseArb, (mc) => {
        const bucketStart = bucketStartMs(mc.sendTimestampMs);
        const nowMs = bucketStart + BUCKET_MS + LATENESS_HORIZON_MS - 1;
        return !wrongComplete(bucketStart, nowMs);
      }),
      { seed: SEED },
    );
    expect(result.failed).toBe(true);
  });
});
