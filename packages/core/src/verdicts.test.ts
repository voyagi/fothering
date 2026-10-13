import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { bucketStartMs } from './buckets.js';
import type { EventRecord } from './records.js';
import {
  TEST_CONFIGURATION_SET,
  TEST_KEY_SET,
  TEST_LANE_MAP,
  contextFor,
  envelopesFor,
  ingestAll,
  scenarioRecords,
} from './test/event-arbitraries.js';
import { propertySeed } from './test/property-seed.js';
import {
  COMPLAINT_THRESHOLD,
  HARD_BOUNCE_THRESHOLD,
  LANE_MIN_RECIPIENT_SENDS,
  LANE_RATIO_LABELS,
  LANE_RULES,
  LANE_SHARE_LABEL,
  MIN_RATIO_EVENTS,
  laneSpikeVerdict,
  type LaneTotals,
} from './verdicts.js';
import { createWindowFold, spikeWindowFor, summarizeWindow, type BucketWindow } from './window-fold.js';

const NOW_MS = Date.UTC(2026, 9, 11, 12, 2, 0);

function totals(recipientSends: number, permanentBounces: number, complaints: number): LaneTotals {
  return { recipientSends, permanentBounces, complaints };
}

function foldTotals(records: readonly EventRecord[], window: BucketWindow, nowMs: number): LaneTotals {
  const fold = createWindowFold({ lane: TEST_CONFIGURATION_SET, window, nowMs });
  return summarizeWindow(fold.step(fold.initial, records)).totals;
}

describe('the hard-bounce ratio at its threshold (AC-3, AC-E4)', () => {
  it('reads 5 permanent bounces in 100 recipient-sends as a spike', () => {
    expect(laneSpikeVerdict(totals(100, 5, 0))).toEqual({ verdict: 'spike', triggers: ['hard-bounce'], hardBounceRatio: '5.00%', complaintRatio: '0.00%' });
  });

  it('reads one permanent bounce fewer as no spike and one more as a spike', () => {
    expect(laneSpikeVerdict(totals(100, 4, 0)).verdict).toBe('no-spike');
    expect(laneSpikeVerdict(totals(100, 6, 0)).verdict).toBe('spike');
  });
});

describe('the complaint ratio at its threshold, with D-49 event floor (AC-3, AC-E4)', () => {
  it('reads 3 complaints in 3000 recipient-sends as a spike on the complaint ratio', () => {
    const verdict = laneSpikeVerdict(totals(3000, 0, 3));
    expect(verdict.verdict).toBe('spike');
    expect(verdict.triggers).toEqual(['complaint']);
    expect(verdict.complaintRatio).toBe('0.10%');
  });

  it('reads one complaint fewer as no spike and one more as a spike', () => {
    expect(laneSpikeVerdict(totals(3000, 0, 2)).verdict).toBe('no-spike');
    expect(laneSpikeVerdict(totals(3000, 0, 4)).verdict).toBe('spike');
  });
});

describe('the lane minimum volume (AC-3, AC-E4, AC-E6)', () => {
  it('judges a lane at exactly 100 recipient-sends and reads 99 as not enough volume whatever its ratio', () => {
    expect(LANE_MIN_RECIPIENT_SENDS).toBe(100);
    expect(laneSpikeVerdict(totals(100, 5, 0)).verdict).toBe('spike');
    expect(laneSpikeVerdict(totals(99, 99, 99))).toEqual({ verdict: 'not-enough-volume', triggers: [], hardBounceRatio: '100.00%', complaintRatio: '100.00%' });
  });

  it('reads zero recipient-sends as not enough volume with null ratios, never NaN or 0', () => {
    expect(laneSpikeVerdict(totals(0, 0, 0))).toEqual({ verdict: 'not-enough-volume', triggers: [], hardBounceRatio: null, complaintRatio: null });
  });
});

describe('both ratios at once (AC-E5)', () => {
  it('names both triggers, hard-bounce first, when a lane meets both thresholds', () => {
    const verdict = laneSpikeVerdict(totals(100, 5, 3));
    expect(verdict.verdict).toBe('spike');
    expect(verdict.triggers).toEqual(['hard-bounce', 'complaint']);
  });
});

describe('the verdict over the records the fold reads', () => {
  const recordSetArb = fc
    .record({
      firstCount: fc.integer({ min: 40, max: 90 }),
      secondCount: fc.integer({ min: 40, max: 90 }),
      permanentBounces: fc.integer({ min: 0, max: 12 }),
      complaints: fc.integer({ min: 0, max: 6 }),
    })
    .chain((spec) => {
      const records = scenarioRecords(
        {
          configurationSet: TEST_CONFIGURATION_SET,
          streamTag: 'stream-a',
          callerIdentity: 'prop-caller',
          fromDomain: 'news.example.com',
          groups: [
            { bucketOffset: 1, count: spec.firstCount, permanentBounces: Math.min(spec.permanentBounces, spec.firstCount), complaints: spec.complaints },
            { bucketOffset: 0, count: spec.secondCount, batch: 'b2' },
          ],
        },
        NOW_MS,
        TEST_LANE_MAP,
        TEST_KEY_SET,
      );
      return fc.shuffledSubarray(records, { minLength: records.length }).map((permuted) => ({ records, permuted }));
    });

  it('is invariant under any permutation of the lane records (AC-E7)', () =>
    fc.assert(
      fc.property(recordSetArb, ({ records, permuted }) => {
        const window = spikeWindowFor(NOW_MS);
        expect(laneSpikeVerdict(foldTotals(permuted, window, NOW_MS))).toEqual(laneSpikeVerdict(foldTotals(records, window, NOW_MS)));
      }),
      { seed: propertySeed(), numRuns: 40 },
    ));

  it('counts a Permanent bounce of subtype Suppressed (the global suppression list) and none of the account, tenant or validation suppressions', () => {
    const sendTimestampMs = bucketStartMs(NOW_MS) + 1_000;
    const window: BucketWindow = { fromBucketMs: bucketStartMs(NOW_MS), toBucketMs: bucketStartMs(NOW_MS) };
    const counted = (bounceSubType: string, messageSeed: number): number =>
      foldTotals(
        ingestAll(
          envelopesFor({
            messageSeed,
            recipientCount: 1,
            sendTimestampMs,
            bounces: [{ feedbackId: `fb-${messageSeed}`, bounceType: 'Permanent', bounceSubType, timestampMs: sendTimestampMs + 1_000 }],
            delivery: undefined,
            complaint: undefined,
            delays: [],
          }),
          contextFor(NOW_MS),
        ),
        window,
        NOW_MS,
      ).permanentBounces;
    expect(counted('Suppressed', 1)).toBe(1);
    expect(['OnAccountSuppressionList', 'OnTenantSuppressionList', 'EmailValidationSuppressed'].map((subtype, index) => counted(subtype, 2 + index))).toEqual([0, 0, 0]);
  });
});

describe('integer compares at every exact threshold pair (AC-E8)', () => {
  it('reads count = k x numerator over sends = k x denominator as a spike for both thresholds, k from 1 to 2000', () =>
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 2_000 }), (k) => {
        const bounces = k * HARD_BOUNCE_THRESHOLD.numerator;
        expect(laneSpikeVerdict(totals(k * HARD_BOUNCE_THRESHOLD.denominator, bounces, 0)).triggers).toEqual(['hard-bounce']);
        const complaints = k * COMPLAINT_THRESHOLD.numerator;
        if (complaints >= MIN_RATIO_EVENTS) {
          expect(laneSpikeVerdict(totals(k * COMPLAINT_THRESHOLD.denominator, 0, complaints)).triggers).toEqual(['complaint']);
        }
      }),
      { seed: propertySeed(), numRuns: 500 },
    ));
});

describe('planted failures: each floor is load-bearing (AC-5, D-49, steelman S3)', () => {
  it('3 permanent bounces in 6 recipient-sends read not enough volume, and spike once the volume minimum is removed', () => {
    expect(laneSpikeVerdict(totals(6, 3, 0)).verdict).toBe('not-enough-volume');
    expect(laneSpikeVerdict(totals(6, 3, 0), { ...LANE_RULES, minRecipientSends: 0 }).verdict).toBe('spike');
  });

  it('2 complaints in 1000 recipient-sends read no spike, and spike once the event floor is removed', () => {
    expect(laneSpikeVerdict(totals(1000, 0, 2)).verdict).toBe('no-spike');
    expect(laneSpikeVerdict(totals(1000, 0, 2), { ...LANE_RULES, minRatioEvents: 1 }).verdict).toBe('spike');
  });

  it('one permanent bounce in two sends (the SPEC example) spikes only with both floors removed', () => {
    const oneInTwo = totals(2, 1, 0);
    expect(laneSpikeVerdict(oneInTwo, { ...LANE_RULES, minRecipientSends: 0 }).verdict).toBe('no-spike');
    expect(laneSpikeVerdict(oneInTwo, { ...LANE_RULES, minRatioEvents: 1 }).verdict).toBe('not-enough-volume');
    expect(laneSpikeVerdict(oneInTwo, { ...LANE_RULES, minRecipientSends: 0, minRatioEvents: 1 }).verdict).toBe('spike');
  });

  it('keeps LANE_RULES equal to the declared constants', () => {
    expect(LANE_RULES).toEqual({ hardBounce: HARD_BOUNCE_THRESHOLD, complaint: COMPLAINT_THRESHOLD, minRatioEvents: 3, minRecipientSends: 100 });
  });
});

describe('verdict labels never claim to be SES figures (AC-4)', () => {
  it('names no SES rate and no "your bounce rate" in any lane label', () => {
    const labels = [...Object.values(LANE_RATIO_LABELS), LANE_SHARE_LABEL].map((label) => label.toLowerCase());
    for (const banned of ['ses bounce rate', 'ses complaint rate', 'your bounce rate']) {
      expect(labels.filter((label) => label.includes(banned))).toEqual([]);
    }
    expect(LANE_RATIO_LABELS.hardBounce.startsWith('Fothering lane')).toBe(true);
  });
});
