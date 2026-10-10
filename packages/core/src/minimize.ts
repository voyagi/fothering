import {
  expiresAtFor,
  isStorableBucketStart,
  recordKey,
  type EventFields,
  type EventRecord,
  type Provenance,
  type RecordKind,
  type SesEventType,
} from './records.js';
import { bucketStartMs } from './buckets.js';
import { pseudonymizeRecipient, type AddressKeySet, type PseudonymizedRecipient } from './address.js';
import type { LaneEntry, LaneMap } from './lanes.js';
import type { SesEnvelope, SesEvent } from './ses-events.js';
import { identityFor } from './identity.js';
import {
  callerIdentity,
  extractBasicReplyCode,
  extractEnhancedStatusCode,
  recipientAction,
  recipientStatus,
  reportingMta,
  tagValue,
  validHostname,
  validIp,
} from './extract.js';

export interface MinimizeContext {
  lane: LaneEntry;
  laneMap: LaneMap;
  keySet: AddressKeySet;
  provenance: Provenance;
  envelopeTimeMs: number;
  arrivalTimeMs: number;
}

// An event whose send time has no storable bucket can never be written or read back in time order,
// and a retry fails the same way, so it is the one minimize failure a caller drops. Every other
// failure (a key set gap, unusable key material, a code defect) is not the event's own fault.
export class UnstorableEventError extends RangeError {
  constructor(mailTimestampMs: number) {
    super(`the mail timestamp ${String(mailTimestampMs)} has no storable send-time bucket`);
    this.name = 'UnstorableEventError';
  }
}

type MailTags = Record<string, string[]>;

// System tags SES sets itself: read the first value, whatever length the array holds. Custom tags
// (the lane's own four plus the lane map's runIdTagKey) are read only by exact key and only when
// the array holds exactly one value (Pitfall 5); a __proto__ or constructor key that happens to sit
// beside the real one changes nothing, since Object.hasOwn checks the exact key, not the prototype.
function firstTagValue(tags: MailTags, key: string): string | undefined {
  const values = tags[key];
  return values !== undefined && values.length > 0 ? values[0] : undefined;
}

function exactTagValue(tags: MailTags, key: string): string | undefined {
  if (!Object.hasOwn(tags, key)) return undefined;
  const values = tags[key];
  return values !== undefined && values.length === 1 ? values[0] : undefined;
}

function customTagValue(tags: MailTags, key: string): string | undefined {
  const raw = exactTagValue(tags, key);
  return raw === undefined ? undefined : tagValue(raw);
}

// Fields common to every event type: the SES-assigned system tags and the lane's four custom tag
// values. A failed validator stores unclassified (still a value); a failed tag pattern omits the
// field entirely, never unclassified (SPEC requirement 5).
function commonFields(tags: MailTags, lane: LaneEntry): EventFields {
  const fields: EventFields = {};
  const sourceIp = firstTagValue(tags, 'ses:source-ip');
  if (sourceIp !== undefined) fields.sourceIp = validIp(sourceIp);
  const fromDomain = firstTagValue(tags, 'ses:from-domain');
  if (fromDomain !== undefined) fields.fromDomain = validHostname(fromDomain);
  const caller = firstTagValue(tags, 'ses:caller-identity');
  if (caller !== undefined) fields.callerIdentity = callerIdentity(caller);
  const stream = customTagValue(tags, lane.streamTagKey);
  if (stream !== undefined) fields.streamTagValue = stream;
  const batch = customTagValue(tags, lane.batchTagKey);
  if (batch !== undefined) fields.batchTagValue = batch;
  const template = customTagValue(tags, lane.templateTagKey);
  if (template !== undefined) fields.templateTagValue = template;
  const campaign = customTagValue(tags, lane.campaignTagKey);
  if (campaign !== undefined) fields.campaignTagValue = campaign;
  return fields;
}

function runIdFor(tags: MailTags, laneMap: LaneMap): string | undefined {
  return customTagValue(tags, laneMap.runIdTagKey);
}

function diagnosticCodeFields(diagnosticCode: string | undefined): EventFields {
  if (diagnosticCode === undefined) return {};
  return {
    enhancedStatusCode: extractEnhancedStatusCode(diagnosticCode),
    basicReplyCode: extractBasicReplyCode(diagnosticCode),
  };
}

// What every record of one event shares, worked out once in minimizeEvent: the bucket its
// storability guard checks is the very bucket each record is filed under.
interface EventHeader {
  context: MinimizeContext;
  mailTimestampMs: number;
  bucket: number;
  messageId: string;
  baseFields: EventFields;
  runId: string | undefined;
}

// Every record shares this shape (SPEC requirement 5's common timestamps, provenance, runId,
// expiresAt); only the per-type fields and the presence of a recipient identity differ, so the
// per-type functions below build a BuildRecordInput and hand it to this one place (jscpd: this
// factoring is what keeps six near-identical object literals from becoming a duplication finding).
// The key is built here too, so a record's event type is written once.
interface BuildRecordInput {
  kind: RecordKind;
  eventType: SesEventType;
  identity: string;
  eventTimestampMs?: number;
  feedbackId?: string;
  recipientHmac?: string;
  receivingDomain?: string;
  keyVersion?: string;
  recipientCount?: number;
  fields: EventFields;
}

function buildRecord(header: EventHeader, input: BuildRecordInput): EventRecord {
  const { context } = header;
  const { pk, sk } = recordKey({
    configurationSet: context.lane.configurationSet,
    bucketStartMs: header.bucket,
    eventType: input.eventType,
    identity: input.identity,
  });
  return {
    pk,
    sk,
    kind: input.kind,
    eventType: input.eventType,
    configurationSet: context.lane.configurationSet,
    bucketStartMs: header.bucket,
    mailTimestampMs: header.mailTimestampMs,
    ...(input.eventTimestampMs !== undefined ? { eventTimestampMs: input.eventTimestampMs } : {}),
    envelopeTimeMs: context.envelopeTimeMs,
    arrivalTimeMs: context.arrivalTimeMs,
    messageId: header.messageId,
    ...(input.feedbackId !== undefined ? { feedbackId: input.feedbackId } : {}),
    provenance: context.provenance,
    ...(header.runId !== undefined ? { runId: header.runId } : {}),
    expiresAt: expiresAtFor(header.mailTimestampMs),
    ...(input.recipientHmac !== undefined ? { recipientHmac: input.recipientHmac } : {}),
    ...(input.receivingDomain !== undefined ? { receivingDomain: input.receivingDomain } : {}),
    ...(input.keyVersion !== undefined ? { keyVersion: input.keyVersion } : {}),
    ...(input.recipientCount !== undefined ? { recipientCount: input.recipientCount } : {}),
    fields: input.fields,
  };
}

function pseudonymFor(raw: string, header: EventHeader): PseudonymizedRecipient {
  return pseudonymizeRecipient(raw, header.context.keySet, header.mailTimestampMs);
}

function minimizeSend(detail: Extract<SesEvent, { eventType: 'Send' }>, header: EventHeader): EventRecord[] {
  const records: EventRecord[] = [];
  for (const destination of detail.mail.destination) {
    const pseudonym = pseudonymFor(destination, header);
    records.push(
      buildRecord(header, {
        kind: 'send',
        eventType: 'Send',
        identity: identityFor({ kind: 'Send', messageId: header.messageId, recipientHmac: pseudonym.recipientHmac }),
        recipientHmac: pseudonym.recipientHmac,
        receivingDomain: pseudonym.receivingDomain,
        keyVersion: pseudonym.keyVersion,
        fields: header.baseFields,
      }),
    );
  }
  return records;
}

function minimizeReject(header: EventHeader): EventRecord[] {
  return [
    buildRecord(header, {
      kind: 'outcome',
      eventType: 'Reject',
      identity: identityFor({ kind: 'Reject', messageId: header.messageId }),
      fields: header.baseFields,
    }),
  ];
}

function minimizeDelivery(detail: Extract<SesEvent, { eventType: 'Delivery' }>, header: EventHeader): EventRecord[] {
  const deliveryTimestampMs = Date.parse(detail.delivery.timestamp);
  const outgoingIp = firstTagValue(detail.mail.tags, 'ses:outgoing-ip');

  const fields: EventFields = {
    ...header.baseFields,
    remoteMtaIp: validIp(detail.delivery.remoteMtaIp),
    ...diagnosticCodeFields(detail.delivery.smtpResponse),
    ...(outgoingIp !== undefined ? { outgoingIp: validIp(outgoingIp) } : {}),
    ...(detail.delivery.reportingMTA !== undefined ? { reportingMta: reportingMta(detail.delivery.reportingMTA) } : {}),
  };

  const records: EventRecord[] = [];
  for (const recipient of detail.delivery.recipients) {
    const pseudonym = pseudonymFor(recipient, header);
    records.push(
      buildRecord(header, {
        kind: 'outcome',
        eventType: 'Delivery',
        identity: identityFor({ kind: 'Delivery', messageId: header.messageId, recipientHmac: pseudonym.recipientHmac }),
        eventTimestampMs: deliveryTimestampMs,
        recipientHmac: pseudonym.recipientHmac,
        receivingDomain: pseudonym.receivingDomain,
        keyVersion: pseudonym.keyVersion,
        fields,
      }),
    );
  }
  return records;
}

function minimizeBounce(detail: Extract<SesEvent, { eventType: 'Bounce' }>, header: EventHeader): EventRecord[] {
  const bounceTimestampMs = Date.parse(detail.bounce.timestamp);

  const records: EventRecord[] = [];
  for (const recipient of detail.bounce.bouncedRecipients) {
    const pseudonym = pseudonymFor(recipient.emailAddress, header);
    const fields: EventFields = {
      ...header.baseFields,
      bounceType: detail.bounce.bounceType,
      bounceSubType: detail.bounce.bounceSubType,
      ...(recipient.status !== undefined ? { recipientStatus: recipientStatus(recipient.status) } : {}),
      ...(recipient.action !== undefined ? { recipientAction: recipientAction(recipient.action) } : {}),
      ...diagnosticCodeFields(recipient.diagnosticCode),
      ...(detail.bounce.reportingMTA !== undefined ? { reportingMta: reportingMta(detail.bounce.reportingMTA) } : {}),
    };

    records.push(
      buildRecord(header, {
        kind: 'outcome',
        eventType: 'Bounce',
        identity: identityFor({ kind: 'Bounce', feedbackId: detail.bounce.feedbackId, recipientHmac: pseudonym.recipientHmac }),
        eventTimestampMs: bounceTimestampMs,
        feedbackId: detail.bounce.feedbackId,
        recipientHmac: pseudonym.recipientHmac,
        receivingDomain: pseudonym.receivingDomain,
        keyVersion: pseudonym.keyVersion,
        fields,
      }),
    );
  }
  return records;
}

// D-33: a Complaint writes one counting record (no recipient field, so byRecipient never sees it)
// plus one complaintRecipient item per complained recipient, all under the same feedbackId. The
// counting record's identity is always a strict prefix of every recipient item's identity, so the
// two shapes can never collide in the sort key.
function minimizeComplaint(detail: Extract<SesEvent, { eventType: 'Complaint' }>, header: EventHeader): EventRecord[] {
  const complaintTimestampMs = Date.parse(detail.complaint.timestamp);
  const { feedbackId } = detail.complaint;

  const countingFields: EventFields = {
    ...header.baseFields,
    ...(detail.complaint.complaintFeedbackType !== undefined
      ? { complaintFeedbackType: detail.complaint.complaintFeedbackType }
      : {}),
    ...(detail.complaint.complaintSubType !== null && detail.complaint.complaintSubType !== undefined
      ? { complaintSubType: detail.complaint.complaintSubType }
      : {}),
  };

  const records: EventRecord[] = [
    buildRecord(header, {
      kind: 'complaint',
      eventType: 'Complaint',
      identity: identityFor({ kind: 'Complaint', feedbackId }),
      eventTimestampMs: complaintTimestampMs,
      feedbackId,
      recipientCount: detail.complaint.complainedRecipients.length,
      fields: countingFields,
    }),
  ];

  for (const recipient of detail.complaint.complainedRecipients) {
    const pseudonym = pseudonymFor(recipient.emailAddress, header);
    records.push(
      buildRecord(header, {
        kind: 'complaintRecipient',
        eventType: 'Complaint',
        identity: identityFor({ kind: 'ComplaintRecipient', feedbackId, recipientHmac: pseudonym.recipientHmac }),
        eventTimestampMs: complaintTimestampMs,
        feedbackId,
        recipientHmac: pseudonym.recipientHmac,
        receivingDomain: pseudonym.receivingDomain,
        keyVersion: pseudonym.keyVersion,
        fields: header.baseFields,
      }),
    );
  }
  return records;
}

function minimizeDeliveryDelay(detail: Extract<SesEvent, { eventType: 'DeliveryDelay' }>, header: EventHeader): EventRecord[] {
  const delayTimestampMs = Date.parse(detail.deliveryDelay.timestamp);

  const records: EventRecord[] = [];
  for (const recipient of detail.deliveryDelay.delayedRecipients) {
    const pseudonym = pseudonymFor(recipient.emailAddress, header);
    const fields: EventFields = {
      ...header.baseFields,
      delayType: detail.deliveryDelay.delayType,
      delayTimestampMs,
      ...(recipient.status !== undefined ? { recipientStatus: recipientStatus(recipient.status) } : {}),
      ...diagnosticCodeFields(recipient.diagnosticCode),
      ...(detail.deliveryDelay.reportingMTA !== undefined
        ? { reportingMta: reportingMta(detail.deliveryDelay.reportingMTA) }
        : {}),
    };

    records.push(
      buildRecord(header, {
        kind: 'outcome',
        eventType: 'DeliveryDelay',
        identity: identityFor({
          kind: 'DeliveryDelay',
          messageId: header.messageId,
          recipientHmac: pseudonym.recipientHmac,
          delayTimestampMs,
        }),
        eventTimestampMs: delayTimestampMs,
        recipientHmac: pseudonym.recipientHmac,
        receivingDomain: pseudonym.receivingDomain,
        keyVersion: pseudonym.keyVersion,
        fields,
      }),
    );
  }
  return records;
}

export function minimizeEvent(event: SesEnvelope, context: MinimizeContext): EventRecord[] {
  const { detail } = event;
  const { tags } = detail.mail;
  // Every record is filed under the lane's partition, and a lane's counts decide whether that
  // lane is closed, so a caller's lane that is not this event's own configuration set is refused.
  if (firstTagValue(tags, 'ses:configuration-set') !== context.lane.configurationSet) {
    throw new Error(`the event's configuration set does not match the lane ${context.lane.configurationSet}`);
  }
  // Checked before any key is read, so an event that can never be stored is never mistaken for a
  // key set gap, which the caller retries.
  const mailTimestampMs = Date.parse(detail.mail.timestamp);
  const bucket = bucketStartMs(mailTimestampMs);
  if (!isStorableBucketStart(bucket)) {
    throw new UnstorableEventError(mailTimestampMs);
  }

  const header: EventHeader = {
    context,
    mailTimestampMs,
    bucket,
    messageId: detail.mail.messageId,
    baseFields: commonFields(tags, context.lane),
    runId: runIdFor(tags, context.laneMap),
  };

  switch (detail.eventType) {
    case 'Send':
      return minimizeSend(detail, header);
    case 'Reject':
      return minimizeReject(header);
    case 'Delivery':
      return minimizeDelivery(detail, header);
    case 'Bounce':
      return minimizeBounce(detail, header);
    case 'Complaint':
      return minimizeComplaint(detail, header);
    case 'DeliveryDelay':
      return minimizeDeliveryDelay(detail, header);
  }
}
