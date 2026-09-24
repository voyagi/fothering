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

export const PARTITION_KEY = 'pk';
export const SORT_KEY = 'sk';
export const RECIPIENT_KEY = 'recipientHmac';
export const RECIPIENT_INDEX_NAME = 'byRecipient';
export const TTL_ATTRIBUTE = 'expiresAt';
export const RETENTION_SECONDS = 2_592_000;

// D-08's sort key zero-pads the bucket start so a lexicographic range query on the sort key
// is also a numeric range query; 13 digits covers epoch milliseconds through the year 2286.
const BUCKET_DIGITS = 13;

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

export function recordKey(input: RecordKeyInput): RecordKey {
  const bucket = String(input.bucketStartMs).padStart(BUCKET_DIGITS, '0');
  return {
    pk: `LANE#${input.configurationSet}`,
    sk: `B#${bucket}#${input.eventType}#${input.identity}`,
  };
}

export function expiresAtFor(mailTimestampMs: number): number {
  return Math.floor(mailTimestampMs / 1000) + RETENTION_SECONDS;
}
