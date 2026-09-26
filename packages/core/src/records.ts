// The closed vocabularies and the table key shape (D-08) are fixed here for every later plan:
// changing them after L1 means replacing a live table, so this file is written complete now
// rather than grown incrementally.

export const PROVENANCES = ['doc-derived', 'simulator-captured', 'live', 'generated'] as const;
export type Provenance = (typeof PROVENANCES)[number];

export const SES_EVENT_TYPES = ['Send', 'Delivery', 'Bounce', 'Complaint', 'Reject', 'DeliveryDelay'] as const;
export type SesEventType = (typeof SES_EVENT_TYPES)[number];

export const RECORD_KINDS = ['send', 'outcome', 'complaint', 'complaintRecipient'] as const;
export type RecordKind = (typeof RECORD_KINDS)[number];

export const UNCLASSIFIED = 'unclassified';

// SES assigns messageId and feedbackId itself, so a value outside this pattern cannot have come
// from SES. One pattern for the event parser and the logger alike, so every id the parser stores
// is an id a log line can name.
export const SES_ID_PATTERN = /^[A-Za-z0-9._-]{1,256}$/;

export const PARTITION_KEY = 'pk';
export const SORT_KEY = 'sk';
export const RECIPIENT_KEY = 'recipientHmac';
export const RECIPIENT_INDEX_NAME = 'byRecipient';
export const TTL_ATTRIBUTE = 'expiresAt';
export const RETENTION_SECONDS = 2_592_000;

// D-08's sort key zero-pads the bucket start so a lexicographic range query on the sort key
// is also a numeric range query; 13 digits covers epoch milliseconds through the year 2286.
const BUCKET_DIGITS = 13;
const BUCKET_LIMIT_MS = 10 ** BUCKET_DIGITS;

/** The full phase 2 field schedule (SPEC requirement 5), carried as closed-vocabulary strings only. */
export interface EventFields {
  bounceType?: string;
  bounceSubType?: string;
  complaintFeedbackType?: string;
  complaintSubType?: string;
  delayType?: string;
  recipientStatus?: string;
  recipientAction?: string;
  enhancedStatusCode?: string;
  basicReplyCode?: string;
  remoteMtaIp?: string;
  reportingMta?: string;
  outgoingIp?: string;
  sourceIp?: string;
  fromDomain?: string;
  callerIdentity?: string;
  streamTagValue?: string;
  batchTagValue?: string;
  templateTagValue?: string;
  campaignTagValue?: string;
  delayTimestampMs?: number;
}

export interface EventRecord {
  pk: string;
  sk: string;
  kind: RecordKind;
  eventType: SesEventType;
  configurationSet: string;
  bucketStartMs: number;
  mailTimestampMs: number;
  eventTimestampMs?: number;
  envelopeTimeMs: number;
  arrivalTimeMs: number;
  messageId: string;
  feedbackId?: string;
  provenance: Provenance;
  runId?: string;
  expiresAt: number;
  recipientHmac?: string;
  receivingDomain?: string;
  keyVersion?: string;
  recipientCount?: number;
  fields: EventFields;
}

export interface RecordKey {
  pk: string;
  sk: string;
}

export interface RecordKeyInput {
  configurationSet: string;
  bucketStartMs: number;
  eventType: SesEventType;
  identity: string;
}

// A bucket start that is negative, fractional, NaN or longer than 13 digits would pad into text
// whose order is not time order. One predicate for the key builder below and for minimize, which
// refuses an event it could never store before reading any key.
export function isStorableBucketStart(bucketStartMs: number): boolean {
  return Number.isInteger(bucketStartMs) && bucketStartMs >= 0 && bucketStartMs < BUCKET_LIMIT_MS;
}

// The one place a bucket start becomes sort-key text: every written key and the live store's
// range bounds are built here, so a write and a read cannot pad differently. A start that is not
// storable is refused rather than written or queried.
export function bucketSortKeyPrefix(bucketStartMs: number): string {
  if (!isStorableBucketStart(bucketStartMs)) {
    throw new RangeError(
      `bucket start ${String(bucketStartMs)} is not a whole number of epoch milliseconds from 0 to ${String(BUCKET_LIMIT_MS - 1)}`,
    );
  }
  return `B#${String(bucketStartMs).padStart(BUCKET_DIGITS, '0')}`;
}

export function recordKey(input: RecordKeyInput): RecordKey {
  return {
    pk: `LANE#${input.configurationSet}`,
    sk: `${bucketSortKeyPrefix(input.bucketStartMs)}#${input.eventType}#${input.identity}`,
  };
}

export function expiresAtFor(mailTimestampMs: number): number {
  return Math.floor(mailTimestampMs / 1000) + RETENTION_SECONDS;
}
