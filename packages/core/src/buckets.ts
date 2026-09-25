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

// D-11: SES's own delivery retry window, not transport lag after SES emits an event (the evidence
// phase in a later plan owns that case). Sourced from two AWS pages: the SES v2 API's
// PutConfigurationSetDeliveryOptions MaxDeliverySeconds field ranges 300 to 50400
// (https://docs.aws.amazon.com/ses/latest/APIReference-V2/API_DeliveryOptions.html), and creating
// a configuration set documents 50400 seconds (14 hours) as the default
// (https://docs.aws.amazon.com/ses/latest/dg/creating-configuration-sets.html). 50400 seconds is
// 50,400,000 milliseconds, the top of that range and the shipped default alike.
export const LATENESS_HORIZON_MS = 14 * 60 * 60 * 1000;

// D-37/AWS SES bounce and complaint subtype lists: AWS excludes OnAccountSuppressionList and
// OnTenantSuppressionList from bounce and complaint rates; EmailValidationSuppressed is a
// Fothering choice to also keep out of the numerators (SPEC requirement 6).
export const SUPPRESSION_BOUNCE_SUBTYPES: readonly string[] = [
  'OnAccountSuppressionList',
  'OnTenantSuppressionList',
  'EmailValidationSuppressed',
];
export const SUPPRESSION_COMPLAINT_SUBTYPES: readonly string[] = ['OnAccountSuppressionList', 'OnTenantSuppressionList'];

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

/** AC-E18: half-open like bucketStartMs itself; a bucket is complete once the clock reaches its
 * own end (bucketStartMs + BUCKET_MS) plus the lateness horizon, never a millisecond earlier. */
export function isBucketComplete(bucketStartMsValue: number, nowMs: number): boolean {
  return nowMs >= bucketStartMsValue + BUCKET_MS + LATENESS_HORIZON_MS;
}

export interface CountLaneBucketsOptions {
  fromBucketMs: number;
  toBucketMs: number;
  nowMs: number;
}

function emptyBucket(bucketStartMsValue: number, nowMs: number): BucketCount {
  return {
    bucketStartMs: bucketStartMsValue,
    complete: isBucketComplete(bucketStartMsValue, nowMs),
    send: 0,
    delivery: 0,
    permanentBounce: 0,
    transientBounce: 0,
    undeterminedBounce: 0,
    complaint: 0,
    reject: 0,
    deliveryDelay: 0,
    suppressedBounce: 0,
    suppressedComplaint: 0,
  };
}

function applyBounce(bucket: BucketCount, record: EventRecord): void {
  const subtype = record.fields.bounceSubType;
  if (subtype !== undefined && SUPPRESSION_BOUNCE_SUBTYPES.includes(subtype)) {
    bucket.suppressedBounce += 1;
    return;
  }
  const bounceType = record.fields.bounceType;
  if (bounceType === 'Permanent') bucket.permanentBounce += 1;
  else if (bounceType === 'Transient') bucket.transientBounce += 1;
  else bucket.undeterminedBounce += 1;
}

function applyComplaint(bucket: BucketCount, record: EventRecord): void {
  const subtype = record.fields.complaintSubType;
  if (subtype !== undefined && SUPPRESSION_COMPLAINT_SUBTYPES.includes(subtype)) {
    bucket.suppressedComplaint += 1;
  } else {
    bucket.complaint += 1;
  }
}

function applyRecord(bucket: BucketCount, record: EventRecord): void {
  switch (record.eventType) {
    case 'Send':
      bucket.send += 1;
      break;
    case 'Delivery':
      bucket.delivery += 1;
      break;
    case 'Reject':
      bucket.reject += 1;
      break;
    case 'DeliveryDelay':
      bucket.deliveryDelay += 1;
      break;
    case 'Bounce':
      applyBounce(bucket, record);
      break;
    case 'Complaint':
      applyComplaint(bucket, record);
      break;
  }
}

// A bound off a bucket edge would build bucket keys no record carries, so every count would read 0
// without an error, and a backwards range would return no bucket at all: both would make a lane
// full of events look silent to the detector reading it. Either is refused instead.
function assertBucketBounds(fromBucketMs: number, toBucketMs: number): void {
  for (const bound of [fromBucketMs, toBucketMs]) {
    if (!Number.isInteger(bound) || bucketStartMs(bound) !== bound) {
      throw new RangeError(`bucket bound ${String(bound)} is not a whole number on a ${BUCKET_MS} ms bucket edge`);
    }
  }
  if (fromBucketMs > toBucketMs) {
    throw new RangeError(`bucket range ${fromBucketMs} to ${toBucketMs} runs backwards`);
  }
}

// SPEC requirement 6: counts are derived from the same countRecords-style per-type check
// (kind send, outcome or complaint only; a complaintRecipient item is never counted), so the
// counting rule stays written in one place regardless of which shape the caller reads it through.
export function countLaneBuckets(records: readonly EventRecord[], options: CountLaneBucketsOptions): BucketCount[] {
  assertBucketBounds(options.fromBucketMs, options.toBucketMs);
  const byBucket = new Map<number, BucketCount>();
  for (let start = options.fromBucketMs; start <= options.toBucketMs; start += BUCKET_MS) {
    byBucket.set(start, emptyBucket(start, options.nowMs));
  }
  for (const record of records) {
    if (record.kind !== 'send' && record.kind !== 'outcome' && record.kind !== 'complaint') continue;
    const bucket = byBucket.get(record.bucketStartMs);
    if (bucket === undefined) continue;
    applyRecord(bucket, record);
  }
  return [...byBucket.values()].sort((a, b) => a.bucketStartMs - b.bucketStartMs);
}

// SES counts only hard (permanent) bounces toward the account bounce rate: "Your bounce rate
// includes only hard bounces to domains you haven't verified. Hard bounces are permanent delivery
// failures such as 'address does not exist.' Temporary and intermittent failures such as 'mailbox
// full,' or bounces due to blocked IP addresses, don't count toward your bounce rate."
// (https://docs.aws.amazon.com/ses/latest/dg/faqs-enforcement.html, Bounce FAQ Q3).
export function hardBounceRatio(counts: Pick<BucketCount, 'send' | 'permanentBounce'>): number | null {
  return counts.send === 0 ? null : counts.permanentBounce / counts.send;
}
