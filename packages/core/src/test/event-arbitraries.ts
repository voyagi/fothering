import fc from 'fast-check';
import { BUCKET_MS, bucketStartMs } from '../buckets.js';
import { DETAIL_TYPE_BY_EVENT_TYPE, type SesEnvelope, type SesEvent } from '../ses-events.js';
import { minimizeEvent, type MinimizeContext } from '../minimize.js';
import type { EventRecord } from '../records.js';
import { findLane, type LaneEntry, type LaneMap } from '../lanes.js';
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
  diagnosticCode?: string;
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

type Mail = SesEvent['mail'];

function mailBase(mc: MessageCase, configurationSet: string): Mail {
  const destination = Array.from({ length: mc.recipientCount }, (_, i) => recipientAddress(mc.messageSeed, i));
  return {
    timestamp: new Date(mc.sendTimestampMs).toISOString(),
    messageId: `msg-${mc.messageSeed}`,
    destination,
    tags: { 'ses:configuration-set': [configurationSet] },
  };
}

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

function sendEnvelope(mail: Mail, sendTimestampMs: number): SesEnvelope {
  const detail: SesEvent = { eventType: 'Send', mail, send: {} };
  return envelopeFor(detail, sendTimestampMs);
}

function deliveryEnvelope(mail: Mail, timestampMs: number): SesEnvelope {
  const detail: SesEvent = {
    eventType: 'Delivery',
    mail,
    delivery: {
      timestamp: new Date(timestampMs).toISOString(),
      recipients: mail.destination,
      smtpResponse: '250 2.6.0 OK',
      remoteMtaIp: '192.0.2.1',
    },
  };
  return envelopeFor(detail, timestampMs);
}

// Bounces only the message's first recipient: this is what lets a three-recipient message with
// "one bounce" mean exactly one bounced recipient out of three sends, the shape the 1/3 hard
// bounce ratio property depends on.
function bounceEnvelope(mail: Mail, bounce: BounceCase): SesEnvelope {
  const bouncedAddress = mail.destination[0];
  if (bouncedAddress === undefined) throw new Error('expected at least one recipient to bounce');
  const detail: SesEvent = {
    eventType: 'Bounce',
    mail,
    bounce: {
      bounceType: bounce.bounceType,
      bounceSubType: bounce.bounceSubType,
      bouncedRecipients: [
        { emailAddress: bouncedAddress, ...(bounce.diagnosticCode !== undefined ? { diagnosticCode: bounce.diagnosticCode } : {}) },
      ],
      timestamp: new Date(bounce.timestampMs).toISOString(),
      feedbackId: bounce.feedbackId,
    },
  };
  return envelopeFor(detail, bounce.timestampMs);
}

function complaintEnvelope(mail: Mail, complaint: NonNullable<MessageCase['complaint']>): SesEnvelope {
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

function delayEnvelope(mail: Mail, timestampMs: number): SesEnvelope {
  const detail: SesEvent = {
    eventType: 'DeliveryDelay',
    mail,
    deliveryDelay: {
      delayType: 'TransientCommunicationFailure',
      delayedRecipients: mail.destination.map((emailAddress) => ({ emailAddress })),
      timestamp: new Date(timestampMs).toISOString(),
    },
  };
  return envelopeFor(detail, timestampMs);
}

/** Every SES envelope one generated message produces: a Send, plus its planned outcome events.
 * configurationSet defaults to TEST_CONFIGURATION_SET so single-lane callers need not pass it;
 * the two-lane fixture-store property passes each message's real lane instead. */
export function envelopesFor(mc: MessageCase, configurationSet: string = TEST_CONFIGURATION_SET): SesEnvelope[] {
  const mail = mailBase(mc, configurationSet);
  const events: SesEnvelope[] = [sendEnvelope(mail, mc.sendTimestampMs)];
  if (mc.delivery !== undefined) events.push(deliveryEnvelope(mail, mc.delivery.timestampMs));
  for (const bounce of mc.bounces) events.push(bounceEnvelope(mail, bounce));
  if (mc.complaint !== undefined) events.push(complaintEnvelope(mail, mc.complaint));
  for (const delay of mc.delays) events.push(delayEnvelope(mail, delay.timestampMs));
  return events;
}

/** One group of single-recipient messages sent in one bucket. Of its messages, the first
 * permanentBounces bounce permanently, the next suppressedBounces bounce off the account suppression
 * list, and the next complaints are complained about; every message that did not bounce is
 * delivered unless deliverRest is false. */
export interface ScenarioGroup {
  /** Buckets before the one holding now. */
  bucketOffset: number;
  count: number;
  batch?: string;
  template?: string;
  campaign?: string;
  /** Cycled per message; example.com when absent. */
  receivingDomains?: readonly string[];
  permanentBounces?: number;
  /** Carried by every bounce of the group; "smtp; 550 5.1.1 user unknown" when absent. */
  diagnosticCode?: string;
  suppressedBounces?: number;
  complaints?: number;
  deliverRest?: boolean;
}

export interface LaneScenario {
  configurationSet: string;
  streamTag: string;
  callerIdentity: string;
  fromDomain: string;
  groups: readonly ScenarioGroup[];
}

const DEFAULT_DIAGNOSTIC_CODE = 'smtp; 550 5.1.1 user unknown';
// Sends sit one second into their bucket and one millisecond apart, so a group must stay well
// under BUCKET_MS messages for every send to land in the bucket the group names.
const SEND_OFFSET_MS = 1_000;

function scenarioTags(scenario: LaneScenario, lane: LaneEntry, group: ScenarioGroup): Record<string, string[]> {
  const tags: Record<string, string[]> = {
    'ses:configuration-set': [scenario.configurationSet],
    'ses:from-domain': [scenario.fromDomain],
    'ses:caller-identity': [scenario.callerIdentity],
    [lane.streamTagKey]: [scenario.streamTag],
  };
  if (group.batch !== undefined) tags[lane.batchTagKey] = [group.batch];
  if (group.template !== undefined) tags[lane.templateTagKey] = [group.template];
  if (group.campaign !== undefined) tags[lane.campaignTagKey] = [group.campaign];
  return tags;
}

function scenarioOutcomes(group: ScenarioGroup, index: number, mail: Mail, sendMs: number): SesEnvelope[] {
  const permanent = group.permanentBounces ?? 0;
  const suppressed = group.suppressedBounces ?? 0;
  const bounce = (bounceSubType: string): SesEnvelope =>
    bounceEnvelope(mail, {
      feedbackId: `fb-${mail.messageId}-b`,
      bounceType: 'Permanent',
      bounceSubType,
      timestampMs: sendMs + 1_000,
      diagnosticCode: group.diagnosticCode ?? DEFAULT_DIAGNOSTIC_CODE,
    });
  if (index < permanent) return [bounce('General')];
  if (index < permanent + suppressed) return [bounce('OnAccountSuppressionList')];
  const outcomes: SesEnvelope[] = [];
  if (group.deliverRest !== false) outcomes.push(deliveryEnvelope(mail, sendMs + 500));
  if (index < permanent + suppressed + (group.complaints ?? 0)) {
    outcomes.push(complaintEnvelope(mail, { feedbackId: `fb-${mail.messageId}-c`, timestampMs: sendMs + 3_000 }));
  }
  return outcomes;
}

/** A deterministic lane story for the fold, evidence and decision tests; recipients sit on the
 * documentation and simulator domains only. */
export function scenarioEnvelopes(scenario: LaneScenario, nowMs: number, lane: LaneEntry): SesEnvelope[] {
  const envelopes: SesEnvelope[] = [];
  scenario.groups.forEach((group, groupIndex) => {
    const bucket = bucketStartMs(nowMs) - group.bucketOffset * BUCKET_MS;
    const domains = group.receivingDomains ?? ['example.com'];
    const tags = scenarioTags(scenario, lane, group);
    for (let index = 0; index < group.count; index += 1) {
      const sendMs = bucket + SEND_OFFSET_MS + index;
      const mail: Mail = {
        timestamp: new Date(sendMs).toISOString(),
        messageId: `scenario-${groupIndex}-${index}`,
        destination: [`r${groupIndex}-${index}@${domains[index % domains.length] ?? 'example.com'}`],
        tags,
      };
      envelopes.push(sendEnvelope(mail, sendMs), ...scenarioOutcomes(group, index, mail, sendMs));
    }
  });
  return envelopes;
}

export function scenarioRecords(scenario: LaneScenario, nowMs: number, laneMap: LaneMap, keySet: AddressKeySet): EventRecord[] {
  const lane = findLane(laneMap, scenario.configurationSet);
  if (lane === undefined) throw new Error(`the scenario's configuration set ${scenario.configurationSet} is not in the lane map`);
  return ingestAll(scenarioEnvelopes(scenario, nowMs, lane), {
    lane,
    laneMap,
    keySet,
    provenance: 'generated',
    envelopeTimeMs: nowMs,
    arrivalTimeMs: nowMs,
  });
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
  return { fromBucketMs: bucketStartMs(minMs), toBucketMs: bucketStartMs(maxMs) };
}
