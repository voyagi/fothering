import { describe, expect, it } from 'vitest';
import {
  BUCKET_MS,
  LATENESS_HORIZON_MS,
  SUPPRESSION_BOUNCE_SUBTYPES,
  SUPPRESSION_COMPLAINT_SUBTYPES,
  bucketStartMs,
  countLaneBuckets,
  countRecords,
  hardBounceRatio,
  isBucketComplete,
} from './buckets.js';
import { UNCLASSIFIED, type EventRecord } from './records.js';

function baseRecord(overrides: Partial<EventRecord> & Pick<EventRecord, 'kind' | 'eventType' | 'bucketStartMs'>): EventRecord {
  return {
    pk: 'LANE#x',
    sk: 'sk',
    configurationSet: 'x',
    mailTimestampMs: overrides.bucketStartMs,
    envelopeTimeMs: 0,
    arrivalTimeMs: 0,
    messageId: 'm',
    provenance: 'generated',
    expiresAt: 0,
    fields: {},
    ...overrides,
  };
}

describe('isBucketComplete (AC-E18)', () => {
  it('is true exactly when now reaches the bucket end plus the horizon, and false one millisecond earlier', () => {
    const bucketStart = 1_000_000;
    const completeAt = bucketStart + BUCKET_MS + LATENESS_HORIZON_MS;
    expect(isBucketComplete(bucketStart, completeAt)).toBe(true);
    expect(isBucketComplete(bucketStart, completeAt - 1)).toBe(false);
  });

  it('treats an event at exactly the bucket end as belonging to the next bucket', () => {
    const start = 300_000;
    expect(bucketStartMs(start + BUCKET_MS)).toBe(start + BUCKET_MS);
    expect(bucketStartMs(start + BUCKET_MS - 1)).toBe(start);
  });

  // The JS remainder keeps the sign of the dividend, so ms - (ms % width) moved a time just before
  // 1970 FORWARD into the bucket at 0, the next bucket, instead of down to its own start.
  it('puts a time before 1970 in its own bucket, never the next one', () => {
    expect(bucketStartMs(-1)).toBe(-BUCKET_MS);
    expect(bucketStartMs(-BUCKET_MS)).toBe(-BUCKET_MS);
    expect(bucketStartMs(-BUCKET_MS - 1)).toBe(-2 * BUCKET_MS);
  });
});

describe('countLaneBuckets (AC-E20)', () => {
  it('returns one entry per bucket in the range with every count 0 when there are no records, and never throws', () => {
    const nowMs = 10_000_000;
    const buckets = countLaneBuckets([], { fromBucketMs: 0, toBucketMs: BUCKET_MS * 2, nowMs });
    expect(buckets).toHaveLength(3);
    for (const bucket of buckets) {
      expect(bucket.send).toBe(0);
      expect(bucket.delivery).toBe(0);
      expect(bucket.permanentBounce).toBe(0);
      expect(bucket.transientBounce).toBe(0);
      expect(bucket.undeterminedBounce).toBe(0);
      expect(bucket.complaint).toBe(0);
      expect(bucket.reject).toBe(0);
      expect(bucket.deliveryDelay).toBe(0);
      expect(bucket.suppressedBounce).toBe(0);
      expect(bucket.suppressedComplaint).toBe(0);
      expect(bucket.notSpamComplaint).toBe(0);
    }
  });

  it('classifies each record by eventType, bounceType and suppression subtype, and never counts a complaintRecipient item', () => {
    const bucketStart = 0;
    const nowMs = 10_000_000;
    const records: EventRecord[] = [
      baseRecord({ kind: 'send', eventType: 'Send', bucketStartMs: bucketStart }),
      baseRecord({ kind: 'outcome', eventType: 'Delivery', bucketStartMs: bucketStart }),
      baseRecord({ kind: 'outcome', eventType: 'Reject', bucketStartMs: bucketStart }),
      baseRecord({ kind: 'outcome', eventType: 'DeliveryDelay', bucketStartMs: bucketStart }),
      baseRecord({
        kind: 'outcome',
        eventType: 'Bounce',
        bucketStartMs: bucketStart,
        fields: { bounceType: 'Permanent', bounceSubType: 'General' },
      }),
      baseRecord({
        kind: 'outcome',
        eventType: 'Bounce',
        bucketStartMs: bucketStart,
        fields: { bounceType: 'Transient', bounceSubType: 'General' },
      }),
      baseRecord({
        kind: 'outcome',
        eventType: 'Bounce',
        bucketStartMs: bucketStart,
        fields: { bounceType: 'unclassified', bounceSubType: 'General' },
      }),
      baseRecord({
        kind: 'outcome',
        eventType: 'Bounce',
        bucketStartMs: bucketStart,
        fields: { bounceType: 'Permanent', bounceSubType: 'OnAccountSuppressionList' },
      }),
      baseRecord({ kind: 'complaint', eventType: 'Complaint', bucketStartMs: bucketStart, fields: {} }),
      baseRecord({
        kind: 'complaint',
        eventType: 'Complaint',
        bucketStartMs: bucketStart,
        fields: { complaintSubType: 'OnTenantSuppressionList' },
      }),
      baseRecord({ kind: 'complaintRecipient', eventType: 'Complaint', bucketStartMs: bucketStart }),
      // A not-spam feedback report corrects a message wrongly marked as spam, so it counts apart.
      baseRecord({
        kind: 'complaint',
        eventType: 'Complaint',
        bucketStartMs: bucketStart,
        fields: { complaintFeedbackType: 'not-spam' },
      }),
    ];
    const [bucket] = countLaneBuckets(records, { fromBucketMs: bucketStart, toBucketMs: bucketStart, nowMs });
    if (bucket === undefined) throw new Error('expected a bucket');
    expect(bucket.notSpamComplaint).toBe(1);
    expect(bucket.send).toBe(1);
    expect(bucket.delivery).toBe(1);
    expect(bucket.reject).toBe(1);
    expect(bucket.deliveryDelay).toBe(1);
    expect(bucket.permanentBounce).toBe(1);
    expect(bucket.transientBounce).toBe(1);
    expect(bucket.undeterminedBounce).toBe(1);
    expect(bucket.suppressedBounce).toBe(1);
    expect(bucket.complaint).toBe(1);
    expect(bucket.suppressedComplaint).toBe(1);
  });

  // Every complaintSubType AWS documents marks a message SES accepted but never sent (the account and
  // tenant suppression lists), so a subtype the parser did not recognise counts with them, outside
  // the complaint numerator, rather than pushing a lane toward closing.
  it('counts a complaint whose subtype is unclassified as suppressed, never in the complaint numerator', () => {
    const records: EventRecord[] = [
      baseRecord({ kind: 'complaint', eventType: 'Complaint', bucketStartMs: 0, fields: { complaintSubType: UNCLASSIFIED } }),
    ];
    const [bucket] = countLaneBuckets(records, { fromBucketMs: 0, toBucketMs: 0, nowMs: 10_000_000 });
    expect(bucket?.complaint).toBe(0);
    expect(bucket?.suppressedComplaint).toBe(1);
  });

  it('ignores a record outside the requested bucket range', () => {
    const records: EventRecord[] = [baseRecord({ kind: 'send', eventType: 'Send', bucketStartMs: BUCKET_MS * 5 })];
    const buckets = countLaneBuckets(records, { fromBucketMs: 0, toBucketMs: 0, nowMs: 10_000_000 });
    expect(buckets).toHaveLength(1);
    expect(buckets[0]?.send).toBe(0);
  });

  // A bound off a bucket edge builds keys no record carries, so a lane full of sends would read as
  // silent; a backwards range returns no bucket at all. Both are refused rather than counted as 0.
  it.each([
    ['a start inside a bucket', { fromBucketMs: 1_000, toBucketMs: BUCKET_MS }],
    ['an end inside a bucket', { fromBucketMs: 0, toBucketMs: BUCKET_MS + 1 }],
    ['a backwards range', { fromBucketMs: BUCKET_MS, toBucketMs: 0 }],
    ['a start that is not a number', { fromBucketMs: Number.NaN, toBucketMs: 0 }],
  ])('throws a RangeError for %s instead of reading zero', (_label, bounds) => {
    const records: EventRecord[] = [baseRecord({ kind: 'send', eventType: 'Send', bucketStartMs: 0 })];
    expect(() => countLaneBuckets(records, { ...bounds, nowMs: 10_000_000 })).toThrow(RangeError);
  });
});

// countRecords shares only the kind filter with countLaneBuckets: it is a flat per-type tally, so a
// suppressed bounce or complaint and a not-spam report still count under their event type there.
describe('countRecords', () => {
  it('tallies every counted record by event type, with no suppression or not-spam split', () => {
    const records: EventRecord[] = [
      baseRecord({ kind: 'outcome', eventType: 'Bounce', bucketStartMs: 0, fields: { bounceType: 'Permanent', bounceSubType: 'General' } }),
      baseRecord({
        kind: 'outcome',
        eventType: 'Bounce',
        bucketStartMs: 0,
        fields: { bounceType: 'Permanent', bounceSubType: 'OnAccountSuppressionList' },
      }),
      baseRecord({ kind: 'complaint', eventType: 'Complaint', bucketStartMs: 0, fields: { complaintSubType: 'OnAccountSuppressionList' } }),
      baseRecord({ kind: 'complaint', eventType: 'Complaint', bucketStartMs: 0, fields: { complaintFeedbackType: 'not-spam' } }),
      baseRecord({ kind: 'complaintRecipient', eventType: 'Complaint', bucketStartMs: 0 }),
    ];
    expect(countRecords(records)).toEqual({ Bounce: 2, Complaint: 2 });
  });
});

describe('sub-second timestamps truncate consistently (AC-E21)', () => {
  it('lands a sub-second mail.timestamp in the same bucket as its whole-second truncation', () => {
    const ms = 1_700_000_000_123;
    const truncatedMs = Math.floor(ms / 1000) * 1000;
    expect(bucketStartMs(ms)).toBe(bucketStartMs(truncatedMs));
  });
});

describe('hardBounceRatio', () => {
  it('is null when send is 0, and permanentBounce divided by send otherwise (a three-recipient message with one hard bounce gives 1/3)', () => {
    expect(hardBounceRatio({ send: 0, permanentBounce: 0 })).toBeNull();
    expect(hardBounceRatio({ send: 3, permanentBounce: 1 })).toBeCloseTo(1 / 3);
    expect(hardBounceRatio({ send: 3, permanentBounce: 0 })).toBe(0);
  });
});

describe('LATENESS_HORIZON_MS', () => {
  it('is 14 hours (50,400,000 ms), the top of SES’s own delivery retry window', () => {
    expect(LATENESS_HORIZON_MS).toBe(14 * 60 * 60 * 1000);
    expect(LATENESS_HORIZON_MS).toBe(50_400_000);
  });
});

describe('suppression subtype lists', () => {
  it('names the three bounce suppression subtypes and the two complaint suppression subtypes', () => {
    expect([...SUPPRESSION_BOUNCE_SUBTYPES].sort()).toEqual(
      ['EmailValidationSuppressed', 'OnAccountSuppressionList', 'OnTenantSuppressionList'].sort(),
    );
    expect([...SUPPRESSION_COMPLAINT_SUBTYPES].sort()).toEqual(['OnAccountSuppressionList', 'OnTenantSuppressionList'].sort());
  });
});
