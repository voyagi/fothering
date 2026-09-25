import fc from 'fast-check';
import { BUCKET_MS } from '../buckets.js';
import type { SesEnvelope, SesEvent } from '../ses-events.js';
import { minimizeEvent, type MinimizeContext } from '../minimize.js';
import type { EventRecord } from '../records.js';
import type { LaneEntry, LaneMap } from '../lanes.js';
import type { AddressKeySet } from '../address.js';

// D-25: arbitraries shaped on the doc examples, provenance 'generated'. Every generated event
// shares one lane and one address key set, since the property suite is proving the counting and
// bucketing invariants, not lane resolution or key rotation (those have their own suites).
export const TEST_CONFIGURATION_SET = 'PropLane';

export const TEST_LANE: LaneEntry = {
  configurationSet: TEST_CONFIGURATION_SET,
  lane: 'prop-lane',
  criticality: 'bulk',
  declaredStreams: ['stream-a'],
  streamTagKey: 'stream',
  batchTagKey: 'batch',
  templateTagKey: 'template',
  campaignTagKey: 'campaign',
  operatorAlert: false,
};

export const TEST_LANE_MAP: LaneMap = { runIdTagKey: 'runId', lanes: [TEST_LANE] };

export const TEST_KEY_SET: AddressKeySet = {
  versions: [{ id: 'k1', secret: 'property-test-key-not-for-deployed-use', activeFromMs: 0 }],
};

const BASE_EPOCH_MS = Date.UTC(2024, 0, 1, 0, 0, 0);

function bucketStartFor(index: number): number {
  return BASE_EPOCH_MS + index * BUCKET_MS;
}

const bucketIndexArb = fc.integer({ min: 0, max: 30 });
const edgeOffsetArb = fc.constantFrom(0, Math.floor(BUCKET_MS / 2), BUCKET_MS - 1);

/** Mail timestamps drawn on and around bucket edges, never exactly at the next bucket's start
 * here (a Send always opens its own bucket; AC-E18's exact-boundary case is a dedicated unit test). */
export const sendTimestampMsArb: fc.Arbitrary<number> = fc
  .tuple(bucketIndexArb, edgeOffsetArb)
  .map(([index, offset]) => bucketStartFor(index) + offset);

export function contextFor(nowMs: number): MinimizeContext {
  return {
    lane: TEST_LANE,
    laneMap: TEST_LANE_MAP,
    keySet: TEST_KEY_SET,
    provenance: 'generated',
    envelopeTimeMs: nowMs,
    arrivalTimeMs: nowMs,
  };
}

export type BounceTypeChoice = 'Permanent' | 'Transient' | 'Undetermined';

export interface BounceCase {
  feedbackId: string;
  bounceType: BounceTypeChoice;
  bounceSubType: string;
  timestampMs: number;
}

export interface MessageCase {
  messageSeed: number;
  recipientCount: number;
  sendTimestampMs: number;
  bounces: BounceCase[];
  delivery: { timestampMs: number } | undefined;
  complaint: { feedbackId: string; timestampMs: number } | undefined;
  delays: { timestampMs: number }[];
}

const bounceTypesArb = fc.array(
  fc.record({
    bounceType: fc.constantFrom<BounceTypeChoice>('Permanent', 'Transient', 'Undetermined'),
    bounceSubType: fc.constantFrom('General', 'MailboxFull'),
  }),
  { minLength: 0, maxLength: 2 },
);

export const messageCaseArb: fc.Arbitrary<MessageCase> = fc
  .record({
    messageSeed: fc.integer({ min: 0, max: 1_000_000 }),
    recipientCount: fc.integer({ min: 1, max: 3 }),
    sendTimestampMs: sendTimestampMsArb,
    bounceSpecs: bounceTypesArb,
    hasDelivery: fc.boolean(),
    hasComplaint: fc.boolean(),
    delayCount: fc.integer({ min: 0, max: 2 }),
  })
  .map((base) => ({
    messageSeed: base.messageSeed,
    recipientCount: base.recipientCount,
    sendTimestampMs: base.sendTimestampMs,
    bounces: base.bounceSpecs.map((spec, i) => ({
      feedbackId: `fb-${base.messageSeed}-b${i}`,
      bounceType: spec.bounceType,
      bounceSubType: spec.bounceSubType,
      timestampMs: base.sendTimestampMs + 1_000 + i * 500,
    })),
    delivery: base.hasDelivery ? { timestampMs: base.sendTimestampMs + 500 } : undefined,
    complaint: base.hasComplaint ? { feedbackId: `fb-${base.messageSeed}-c`, timestampMs: base.sendTimestampMs + 3_000 } : undefined,
    delays: Array.from({ length: base.delayCount }, (_, i) => ({ timestampMs: base.sendTimestampMs + 2_000 + i * 1_000 })),
  }));

function recipientAddress(messageSeed: number, index: number): string {
  return `r${messageSeed}-${index}@example.com`;
}

function mailBase(mc: MessageCase) {
  const destination = Array.from({ length: mc.recipientCount }, (_, i) => recipientAddress(mc.messageSeed, i));
  return {
    timestamp: new Date(mc.sendTimestampMs).toISOString(),
    messageId: `msg-${mc.messageSeed}`,
    source: 'sender@example.com',
    destination,
    tags: { 'ses:configuration-set': [TEST_CONFIGURATION_SET] },
  };
}

const DETAIL_TYPE_BY_EVENT_TYPE: Record<SesEvent['eventType'], string> = {
  Send: 'Email Sent',
  Delivery: 'Email Delivered',
  Bounce: 'Email Bounced',
  Complaint: 'Email Complaint Received',
  Reject: 'Email Rejected',
  DeliveryDelay: 'Email Delivery Delayed',
};

// The EventBridge envelope id is never read by minimizeEvent (it never appears in an identity),
// so a stable counter here is enough; nothing measured by the property suite depends on its value.
let envelopeSequence = 0;

function envelopeFor(detail: SesEvent, timeMs: number): SesEnvelope {
  envelopeSequence += 1;
  return {
    version: '0',
    id: `evt-${envelopeSequence}`,
    'detail-type': DETAIL_TYPE_BY_EVENT_TYPE[detail.eventType],
    source: 'aws.ses',
    account: '123456789012',
    time: new Date(timeMs).toISOString(),
    region: 'eu-central-1',
    resources: [],
    detail,
  } as SesEnvelope;
}

function sendEnvelope(mc: MessageCase): SesEnvelope {
  const mail = mailBase(mc);
  const detail: SesEvent = { eventType: 'Send', mail, send: {} };
  return envelopeFor(detail, mc.sendTimestampMs);
}

function deliveryEnvelope(mc: MessageCase, timestampMs: number): SesEnvelope {
  const mail = mailBase(mc);
  const detail: SesEvent = {
    eventType: 'Delivery',
    mail,
    delivery: {
      timestamp: new Date(timestampMs).toISOString(),
      processingTimeMillis: 100,
      recipients: mail.destination,
      smtpResponse: '250 2.6.0 OK',
      remoteMtaIp: '192.0.2.1',
    },
  };
  return envelopeFor(detail, timestampMs);
}

function bounceEnvelope(mc: MessageCase, bounce: BounceCase): SesEnvelope {
  const mail = mailBase(mc);
  const detail: SesEvent = {
    eventType: 'Bounce',
    mail,
    bounce: {
      bounceType: bounce.bounceType,
      bounceSubType: bounce.bounceSubType,
      bouncedRecipients: mail.destination.map((emailAddress) => ({ emailAddress })),
      timestamp: new Date(bounce.timestampMs).toISOString(),
      feedbackId: bounce.feedbackId,
    },
  };
  return envelopeFor(detail, bounce.timestampMs);
}

function complaintEnvelope(mc: MessageCase, complaint: NonNullable<MessageCase['complaint']>): SesEnvelope {
  const mail = mailBase(mc);
  const detail: SesEvent = {
    eventType: 'Complaint',
    mail,
    complaint: {
      complainedRecipients: mail.destination.map((emailAddress) => ({ emailAddress })),
      timestamp: new Date(complaint.timestampMs).toISOString(),
      feedbackId: complaint.feedbackId,
      complaintSubType: null,
    },
  };
  return envelopeFor(detail, complaint.timestampMs);
}

function delayEnvelope(mc: MessageCase, timestampMs: number): SesEnvelope {
  const mail = mailBase(mc);
  const detail: SesEvent = {
    eventType: 'DeliveryDelay',
    mail,
    deliveryDelay: {
      delayType: 'TransientCommunicationFailure',
      delayedRecipients: mail.destination.map((emailAddress) => ({ emailAddress })),
      expirationTime: new Date(timestampMs + 3_600_000).toISOString(),
      timestamp: new Date(timestampMs).toISOString(),
    },
  };
  return envelopeFor(detail, timestampMs);
}

/** Every SES envelope one generated message produces: a Send, plus its planned outcome events. */
export function envelopesFor(mc: MessageCase): SesEnvelope[] {
  const events: SesEnvelope[] = [sendEnvelope(mc)];
  if (mc.delivery !== undefined) events.push(deliveryEnvelope(mc, mc.delivery.timestampMs));
  for (const bounce of mc.bounces) events.push(bounceEnvelope(mc, bounce));
  if (mc.complaint !== undefined) events.push(complaintEnvelope(mc, mc.complaint));
  for (const delay of mc.delays) events.push(delayEnvelope(mc, delay.timestampMs));
  return events;
}

/** First-write-wins over pk+sk, the same semantics the conditional put gives the real table. */
export function ingestAll(envelopes: readonly SesEnvelope[], context: MinimizeContext): EventRecord[] {
  const seen = new Map<string, EventRecord>();
  for (const envelope of envelopes) {
    for (const record of minimizeEvent(envelope, context)) {
      const key = `${record.pk}\u0000${record.sk}`;
      if (!seen.has(key)) seen.set(key, record);
    }
  }
  return [...seen.values()];
}

/** The bucket range spanning every timestamp a set of messages could write into. */
export function bucketRangeFor(cases: readonly MessageCase[]): { fromBucketMs: number; toBucketMs: number } {
  let minMs = Number.POSITIVE_INFINITY;
  let maxMs = Number.NEGATIVE_INFINITY;
  for (const mc of cases) {
    const timestamps = [mc.sendTimestampMs, mc.delivery?.timestampMs, mc.complaint?.timestampMs]
      .concat(mc.bounces.map((b) => b.timestampMs))
      .concat(mc.delays.map((d) => d.timestampMs))
      .filter((value): value is number => value !== undefined);
    for (const ms of timestamps) {
      // every event's mail.timestamp is the send time, per mailBase, so the relevant bucket
      // range only ever needs to span sendTimestampMs values; this loop stays defensive.
      minMs = Math.min(minMs, ms);
      maxMs = Math.max(maxMs, ms);
    }
  }
  const fromBucketMs = minMs - (minMs % BUCKET_MS);
  const toBucketMs = maxMs - (maxMs % BUCKET_MS);
  return { fromBucketMs, toBucketMs };
}
