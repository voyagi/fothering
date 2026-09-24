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
