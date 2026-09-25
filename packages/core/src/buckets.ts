import type { EventRecord, SesEventType } from './records.js';

// D-10: 5 minutes is a product choice, not a value sourced from an AWS document. A small
// team's traffic still yields a non-zero count per bucket, and a spike shows within one bucket.
export const BUCKET_MS = 300_000;

/** Half-open buckets: an event at exactly a bucket boundary belongs to the next bucket. */
export function bucketStartMs(ms: number): number {
  return ms - (ms % BUCKET_MS);
}

export function countRecords(records: readonly EventRecord[]): Partial<Record<SesEventType, number>> {
  const counts: Partial<Record<SesEventType, number>> = {};
  for (const record of records) {
    if (record.kind !== 'send' && record.kind !== 'outcome' && record.kind !== 'complaint') continue;
    counts[record.eventType] = (counts[record.eventType] ?? 0) + 1;
  }
  return counts;
}

// RED stub: task 2 has not implemented these yet. Every call throws so buckets.test.ts and
// buckets.property.test.ts fail on real assertions instead of a module-resolution crash.
export const LATENESS_HORIZON_MS = -1;
export const SUPPRESSION_BOUNCE_SUBTYPES: readonly string[] = [];
export const SUPPRESSION_COMPLAINT_SUBTYPES: readonly string[] = [];

export interface BucketCount {
  bucketStartMs: number;
  complete: boolean;
  send: number;
  delivery: number;
  permanentBounce: number;
  transientBounce: number;
  undeterminedBounce: number;
  complaint: number;
  reject: number;
  deliveryDelay: number;
  suppressedBounce: number;
  suppressedComplaint: number;
}

export function isBucketComplete(_bucketStartMs: number, _nowMs: number): boolean {
  throw new Error('isBucketComplete not implemented');
}

export interface CountLaneBucketsOptions {
  fromBucketMs: number;
  toBucketMs: number;
  nowMs: number;
}

export function countLaneBuckets(_records: readonly EventRecord[], _options: CountLaneBucketsOptions): BucketCount[] {
  throw new Error('countLaneBuckets not implemented');
}

export function hardBounceRatio(_counts: Pick<BucketCount, 'send' | 'permanentBounce'>): number | null {
  throw new Error('hardBounceRatio not implemented');
}
