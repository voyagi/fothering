import { UNCLASSIFIED, type EventRecord, type SesEventType } from './records.js';

// D-10: 5 minutes is a product choice, not a value sourced from an AWS document. A small
// team's traffic still yields a non-zero count per bucket, and a spike shows within one bucket.
export const BUCKET_MS = 300_000;

/** Half-open buckets: an event at exactly a bucket boundary belongs to the next bucket. Floor
 * division, not ms - (ms % width): the JS remainder keeps the dividend's sign, so the remainder
 * form moved a time just before 1970 up into the next bucket instead of down to its own. */
export function bucketStartMs(ms: number): number {
  return Math.floor(ms / BUCKET_MS) * BUCKET_MS;
}

/** The one counting rule: a send, an outcome or a Complaint's counting record counts; a
 * complaintRecipient item exists for the recipient index and deletion only. */
export function isCountedRecord(record: EventRecord): boolean {
  return record.kind === 'send' || record.kind === 'outcome' || record.kind === 'complaint';
}

/** An unsplit per-type tally, never a ratio numerator: a suppressed bounce still counts under
 * Bounce here, and a suppressed complaint or a not-spam report under Complaint. The suppression and
 * not-spam split lives only in countLaneBuckets, which is what a detector reads. */
export function countRecords(records: readonly EventRecord[]): Partial<Record<SesEventType, number>> {
  const counts: Partial<Record<SesEventType, number>> = {};
  for (const record of records) {
    if (!isCountedRecord(record)) continue;
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

// The AWS event page describes a not-spam feedback report as one that "does not consider the
// message to be spam", used "to correct a message that was incorrectly tagged or categorized as
// spam", and does not say whether SES counts it. Fothering counts it apart, so a correction never
// pushes a lane toward closing (https://docs.aws.amazon.com/ses/latest/dg/event-publishing-retrieving-sns-contents.html).
const NOT_SPAM_FEEDBACK_TYPE = 'not-spam';

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
  notSpamComplaint: number;
}

/** AC-E18: half-open like bucketStartMs itself; a bucket is complete once the clock reaches its
 * own end (bucketStartMs + BUCKET_MS) plus the lateness horizon, never a millisecond earlier.
 * Complete means SES's retry window for the bucket's sends has closed, not that its counts are
 * final: a complaint or an asynchronous bounce can still arrive later and land in this send-time
 * bucket, so a reader that treats complete as final must allow for that. */
export function isBucketComplete(bucketStartMsValue: number, nowMs: number): boolean {
  return nowMs >= bucketStartMsValue + BUCKET_MS + LATENESS_HORIZON_MS;
}

export interface CountLaneBucketsOptions {
  fromBucketMs: number;
  toBucketMs: number;
  nowMs: number;
}

export function emptyBucket(bucketStartMsValue: number, nowMs: number): BucketCount {
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
    notSpamComplaint: 0,
  };
}

export type BounceClass = 'suppressed' | 'permanent' | 'transient' | 'undetermined';
export type ComplaintClass = 'suppressed' | 'not-spam' | 'counted';

/** The one place a Bounce record is split for the numerators; the window fold reads the same split. */
export function bounceClass(record: EventRecord): BounceClass {
  const subtype = record.fields.bounceSubType;
  if (subtype !== undefined && SUPPRESSION_BOUNCE_SUBTYPES.includes(subtype)) return 'suppressed';
  const bounceType = record.fields.bounceType;
  if (bounceType === 'Permanent') return 'permanent';
  if (bounceType === 'Transient') return 'transient';
  return 'undetermined';
}

function applyBounce(bucket: BucketCount, record: EventRecord): void {
  switch (bounceClass(record)) {
    case 'suppressed':
      bucket.suppressedBounce += 1;
      break;
    case 'permanent':
      bucket.permanentBounce += 1;
      break;
    case 'transient':
      bucket.transientBounce += 1;
      break;
    case 'undetermined':
      bucket.undeterminedBounce += 1;
      break;
  }
}

// Every complaintSubType AWS documents (the two suppression lists) marks a message SES accepted but
// never sent, so a subtype the parser did not recognise counts with them, outside the complaint
// numerator, rather than pushing a lane toward closing on mail that may never have gone out
// (https://docs.aws.amazon.com/ses/latest/dg/event-publishing-retrieving-sns-contents.html).
function isSuppressedComplaint(subtype: string | undefined): boolean {
  return subtype !== undefined && (subtype === UNCLASSIFIED || SUPPRESSION_COMPLAINT_SUBTYPES.includes(subtype));
}

export function complaintClass(record: EventRecord): ComplaintClass {
  if (isSuppressedComplaint(record.fields.complaintSubType)) return 'suppressed';
  if (record.fields.complaintFeedbackType === NOT_SPAM_FEEDBACK_TYPE) return 'not-spam';
  return 'counted';
}

function applyComplaint(bucket: BucketCount, record: EventRecord): void {
  switch (complaintClass(record)) {
    case 'suppressed':
      bucket.suppressedComplaint += 1;
      break;
    case 'not-spam':
      bucket.notSpamComplaint += 1;
      break;
    case 'counted':
      bucket.complaint += 1;
      break;
  }
}

export function applyRecord(bucket: BucketCount, record: EventRecord): void {
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
export function assertBucketBounds(fromBucketMs: number, toBucketMs: number): void {
  for (const bound of [fromBucketMs, toBucketMs]) {
    if (!Number.isInteger(bound) || bucketStartMs(bound) !== bound) {
      throw new RangeError(`bucket bound ${String(bound)} is not a whole number on a ${BUCKET_MS} ms bucket edge`);
    }
  }
  if (fromBucketMs > toBucketMs) {
    throw new RangeError(`bucket range ${fromBucketMs} to ${toBucketMs} runs backwards`);
  }
}

// SPEC requirement 6: countRecords and this function share the kind filter, isCountedRecord, so
// which records count is written in one place. Only this function splits suppressed bounces and
// complaints and not-spam reports out of the numerators; countRecords stays an unsplit tally.
export function countLaneBuckets(records: readonly EventRecord[], options: CountLaneBucketsOptions): BucketCount[] {
  assertBucketBounds(options.fromBucketMs, options.toBucketMs);
  const byBucket = new Map<number, BucketCount>();
  for (let start = options.fromBucketMs; start <= options.toBucketMs; start += BUCKET_MS) {
    byBucket.set(start, emptyBucket(start, options.nowMs));
  }
  for (const record of records) {
    if (!isCountedRecord(record)) continue;
    const bucket = byBucket.get(record.bucketStartMs);
    if (bucket === undefined) continue;
    applyRecord(bucket, record);
  }
  return [...byBucket.values()].sort((a, b) => a.bucketStartMs - b.bucketStartMs);
}

// Fothering's own lane ratio: permanent bounces over sends for one lane, across every receiving
// domain. It is not SES's account bounce rate and is never presented as that. The two share only
// the rule that hard bounces alone count: "Your bounce rate includes only hard bounces to domains
// you haven't verified. Hard bounces are permanent delivery failures such as 'address does not
// exist.' Temporary and intermittent failures such as 'mailbox full,' or bounces due to blocked IP
// addresses, don't count toward your bounce rate."
// (https://docs.aws.amazon.com/ses/latest/dg/faqs-enforcement.html, Bounce FAQ Q3). A lane's
// records carry no verified-domain mark, so this ratio cannot reproduce SES's figure.
export function hardBounceRatio(counts: Pick<BucketCount, 'send' | 'permanentBounce'>): number | null {
  return counts.send === 0 ? null : counts.permanentBounce / counts.send;
}
