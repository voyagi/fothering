import { BUCKET_MS, bucketStartMs } from '../buckets.js';
import { expiresAtFor, recordKey, type EventFields, type EventRecord, type RecordKind, type SesEventType } from '../records.js';

// A fixed bucket edge (January 2027) so every fixture timestamp is a whole number of buckets from
// it and a test reads a bucket edge as a bucket edge.
export const BASE_BUCKET_MS = bucketStartMs(1_800_000_000_000);
export const ONE_HOUR_MS = 3_600_000;

const KIND_BY_EVENT_TYPE: Record<SesEventType, RecordKind> = {
  Send: 'send',
  Delivery: 'outcome',
  Bounce: 'outcome',
  Reject: 'outcome',
  DeliveryDelay: 'outcome',
  Complaint: 'complaint',
};

export interface TestRecordOptions {
  configurationSet: string;
  bucketStartMs: number;
  identity: string;
  eventType?: SesEventType;
  fields?: EventFields;
}

export function testRecord(options: TestRecordOptions): EventRecord {
  const eventType = options.eventType ?? 'Send';
  const { pk, sk } = recordKey({
    configurationSet: options.configurationSet,
    bucketStartMs: options.bucketStartMs,
    eventType,
    identity: options.identity,
  });
  return {
    pk,
    sk,
    kind: KIND_BY_EVENT_TYPE[eventType],
    eventType,
    configurationSet: options.configurationSet,
    bucketStartMs: options.bucketStartMs,
    mailTimestampMs: options.bucketStartMs,
    envelopeTimeMs: options.bucketStartMs,
    arrivalTimeMs: options.bucketStartMs,
    messageId: options.identity,
    provenance: 'generated',
    expiresAt: expiresAtFor(options.bucketStartMs),
    fields: options.fields ?? {},
  };
}

export interface MessageRecordsOptions {
  configurationSet: string;
  bucketStartMs: number;
  identity: string;
  fields?: EventFields;
}

/** A message that was sent and delivered: the pair a healthy lane produces, both carrying the same tags. */
export function deliveredMessage(options: MessageRecordsOptions): EventRecord[] {
  return [
    testRecord({ ...options, eventType: 'Send', identity: `${options.identity}-send` }),
    testRecord({ ...options, eventType: 'Delivery', identity: `${options.identity}-delivery` }),
  ];
}

/** The bucket that starts `buckets` buckets after the base bucket. */
export function bucketAfterBase(buckets: number): number {
  return BASE_BUCKET_MS + buckets * BUCKET_MS;
}
