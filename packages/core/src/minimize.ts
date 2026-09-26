import { expiresAtFor, recordKey, type EventFields, type EventRecord, type Provenance, type RecordKind, type SesEventType } from './records.js';
import { bucketStartMs } from './buckets.js';
import { pseudonymizeRecipient, type AddressKeySet } from './address.js';
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

// Every record shares this shape (SPEC requirement 5's common timestamps, provenance, runId,
// expiresAt); only the per-type fields and the presence of a recipient identity differ, so the
// per-type functions below build a BuildRecordInput and hand it to this one place (jscpd: this
// factoring is what keeps six near-identical object literals from becoming a duplication finding).
interface BuildRecordInput {
  pk: string;
  sk: string;
  kind: RecordKind;
  eventType: SesEventType;
  bucket: number;
  mailTimestampMs: number;
  eventTimestampMs?: number;
  messageId: string;
  feedbackId?: string;
  recipientHmac?: string;
  receivingDomain?: string;
  keyVersion?: string;
  recipientCount?: number;
  fields: EventFields;
  context: MinimizeContext;
  runId: string | undefined;
}

function buildRecord(input: BuildRecordInput): EventRecord {
  return {
    pk: input.pk,
    sk: input.sk,
    kind: input.kind,
    eventType: input.eventType,
    configurationSet: input.context.lane.configurationSet,
    bucketStartMs: input.bucket,
    mailTimestampMs: input.mailTimestampMs,
    ...(input.eventTimestampMs !== undefined ? { eventTimestampMs: input.eventTimestampMs } : {}),
    envelopeTimeMs: input.context.envelopeTimeMs,
    arrivalTimeMs: input.context.arrivalTimeMs,
    messageId: input.messageId,
    ...(input.feedbackId !== undefined ? { feedbackId: input.feedbackId } : {}),
    provenance: input.context.provenance,
    ...(input.runId !== undefined ? { runId: input.runId } : {}),
    expiresAt: expiresAtFor(input.mailTimestampMs),
    ...(input.recipientHmac !== undefined ? { recipientHmac: input.recipientHmac } : {}),
    ...(input.receivingDomain !== undefined ? { receivingDomain: input.receivingDomain } : {}),
    ...(input.keyVersion !== undefined ? { keyVersion: input.keyVersion } : {}),
    ...(input.recipientCount !== undefined ? { recipientCount: input.recipientCount } : {}),
    fields: input.fields,
  };
}

function minimizeSend(detail: Extract<SesEvent, { eventType: 'Send' }>, context: MinimizeContext): EventRecord[] {
  const mailTimestampMs = Date.parse(detail.mail.timestamp);
  const bucket = bucketStartMs(mailTimestampMs);
  const fields = commonFields(detail.mail.tags, context.lane);
  const runId = runIdFor(detail.mail.tags, context.laneMap);

  const records: EventRecord[] = [];
  for (const destination of detail.mail.destination) {
    const pseudonym = pseudonymizeRecipient(destination, context.keySet, mailTimestampMs);
    const identity = identityFor({ kind: 'Send', messageId: detail.mail.messageId, recipientHmac: pseudonym.recipientHmac });
    const { pk, sk } = recordKey({ configurationSet: context.lane.configurationSet, bucketStartMs: bucket, eventType: 'Send', identity });
    records.push(
      buildRecord({
        pk,
        sk,
        kind: 'send',
        eventType: 'Send',
        bucket,
        mailTimestampMs,
        messageId: detail.mail.messageId,
        recipientHmac: pseudonym.recipientHmac,
        receivingDomain: pseudonym.receivingDomain,
        keyVersion: pseudonym.keyVersion,
        fields,
        context,
        runId,
      }),
    );
  }
  return records;
}

function minimizeReject(detail: Extract<SesEvent, { eventType: 'Reject' }>, context: MinimizeContext): EventRecord[] {
  const mailTimestampMs = Date.parse(detail.mail.timestamp);
  const bucket = bucketStartMs(mailTimestampMs);
  const fields = commonFields(detail.mail.tags, context.lane);
  const runId = runIdFor(detail.mail.tags, context.laneMap);
  const identity = identityFor({ kind: 'Reject', messageId: detail.mail.messageId });
  const { pk, sk } = recordKey({ configurationSet: context.lane.configurationSet, bucketStartMs: bucket, eventType: 'Reject', identity });

  return [
    buildRecord({
      pk,
      sk,
      kind: 'outcome',
      eventType: 'Reject',
      bucket,
      mailTimestampMs,
      messageId: detail.mail.messageId,
      fields,
      context,
      runId,
    }),
  ];
}

function minimizeDelivery(detail: Extract<SesEvent, { eventType: 'Delivery' }>, context: MinimizeContext): EventRecord[] {
  const mailTimestampMs = Date.parse(detail.mail.timestamp);
  const deliveryTimestampMs = Date.parse(detail.delivery.timestamp);
  const bucket = bucketStartMs(mailTimestampMs);
  const runId = runIdFor(detail.mail.tags, context.laneMap);
  const outgoingIp = firstTagValue(detail.mail.tags, 'ses:outgoing-ip');

  const fields: EventFields = {
    ...commonFields(detail.mail.tags, context.lane),
    remoteMtaIp: validIp(detail.delivery.remoteMtaIp),
    ...diagnosticCodeFields(detail.delivery.smtpResponse),
    ...(outgoingIp !== undefined ? { outgoingIp: validIp(outgoingIp) } : {}),
    ...(detail.delivery.reportingMTA !== undefined ? { reportingMta: reportingMta(detail.delivery.reportingMTA) } : {}),
  };

  const records: EventRecord[] = [];
  for (const recipient of detail.delivery.recipients) {
    const pseudonym = pseudonymizeRecipient(recipient, context.keySet, mailTimestampMs);
    const identity = identityFor({ kind: 'Delivery', messageId: detail.mail.messageId, recipientHmac: pseudonym.recipientHmac });
    const { pk, sk } = recordKey({ configurationSet: context.lane.configurationSet, bucketStartMs: bucket, eventType: 'Delivery', identity });
    records.push(
      buildRecord({
        pk,
        sk,
        kind: 'outcome',
        eventType: 'Delivery',
        bucket,
        mailTimestampMs,
        eventTimestampMs: deliveryTimestampMs,
        messageId: detail.mail.messageId,
        recipientHmac: pseudonym.recipientHmac,
        receivingDomain: pseudonym.receivingDomain,
        keyVersion: pseudonym.keyVersion,
        fields,
        context,
        runId,
      }),
    );
  }
  return records;
}

function minimizeBounce(detail: Extract<SesEvent, { eventType: 'Bounce' }>, context: MinimizeContext): EventRecord[] {
  const mailTimestampMs = Date.parse(detail.mail.timestamp);
  const bounceTimestampMs = Date.parse(detail.bounce.timestamp);
  const bucket = bucketStartMs(mailTimestampMs);
  const baseFields = commonFields(detail.mail.tags, context.lane);
  const runId = runIdFor(detail.mail.tags, context.laneMap);

  const records: EventRecord[] = [];
  for (const recipient of detail.bounce.bouncedRecipients) {
    const pseudonym = pseudonymizeRecipient(recipient.emailAddress, context.keySet, mailTimestampMs);
    const identity = identityFor({ kind: 'Bounce', feedbackId: detail.bounce.feedbackId, recipientHmac: pseudonym.recipientHmac });
    const { pk, sk } = recordKey({ configurationSet: context.lane.configurationSet, bucketStartMs: bucket, eventType: 'Bounce', identity });

    const fields: EventFields = {
      ...baseFields,
      bounceType: detail.bounce.bounceType,
      bounceSubType: detail.bounce.bounceSubType,
      ...(recipient.status !== undefined ? { recipientStatus: recipientStatus(recipient.status) } : {}),
      ...(recipient.action !== undefined ? { recipientAction: recipientAction(recipient.action) } : {}),
      ...diagnosticCodeFields(recipient.diagnosticCode),
      ...(detail.bounce.reportingMTA !== undefined ? { reportingMta: reportingMta(detail.bounce.reportingMTA) } : {}),
    };

    records.push(
      buildRecord({
        pk,
        sk,
        kind: 'outcome',
        eventType: 'Bounce',
        bucket,
        mailTimestampMs,
        eventTimestampMs: bounceTimestampMs,
        messageId: detail.mail.messageId,
        feedbackId: detail.bounce.feedbackId,
        recipientHmac: pseudonym.recipientHmac,
        receivingDomain: pseudonym.receivingDomain,
        keyVersion: pseudonym.keyVersion,
        fields,
        context,
        runId,
      }),
    );
  }
  return records;
}

// D-33: a Complaint writes one counting record (no recipient field, so byRecipient never sees it)
// plus one complaintRecipient item per complained recipient, all under the same feedbackId. The
// counting record's identity is always a strict prefix of every recipient item's identity, so the
// two shapes can never collide in the sort key.
function minimizeComplaint(detail: Extract<SesEvent, { eventType: 'Complaint' }>, context: MinimizeContext): EventRecord[] {
  const mailTimestampMs = Date.parse(detail.mail.timestamp);
  const complaintTimestampMs = Date.parse(detail.complaint.timestamp);
  const bucket = bucketStartMs(mailTimestampMs);
  const baseFields = commonFields(detail.mail.tags, context.lane);
  const runId = runIdFor(detail.mail.tags, context.laneMap);

  const countingFields: EventFields = {
    ...baseFields,
    ...(detail.complaint.complaintFeedbackType !== undefined
      ? { complaintFeedbackType: detail.complaint.complaintFeedbackType }
      : {}),
    ...(detail.complaint.complaintSubType !== null && detail.complaint.complaintSubType !== undefined
      ? { complaintSubType: detail.complaint.complaintSubType }
      : {}),
  };

  const countingIdentity = identityFor({ kind: 'Complaint', feedbackId: detail.complaint.feedbackId });
  const { pk: countingPk, sk: countingSk } = recordKey({
    configurationSet: context.lane.configurationSet,
    bucketStartMs: bucket,
    eventType: 'Complaint',
    identity: countingIdentity,
  });

  const records: EventRecord[] = [
    buildRecord({
      pk: countingPk,
      sk: countingSk,
      kind: 'complaint',
      eventType: 'Complaint',
      bucket,
      mailTimestampMs,
      eventTimestampMs: complaintTimestampMs,
      messageId: detail.mail.messageId,
      feedbackId: detail.complaint.feedbackId,
      recipientCount: detail.complaint.complainedRecipients.length,
      fields: countingFields,
      context,
      runId,
    }),
  ];

  for (const recipient of detail.complaint.complainedRecipients) {
    const pseudonym = pseudonymizeRecipient(recipient.emailAddress, context.keySet, mailTimestampMs);
    const identity = identityFor({
      kind: 'ComplaintRecipient',
      feedbackId: detail.complaint.feedbackId,
      recipientHmac: pseudonym.recipientHmac,
    });
    const { pk, sk } = recordKey({ configurationSet: context.lane.configurationSet, bucketStartMs: bucket, eventType: 'Complaint', identity });
    records.push(
      buildRecord({
        pk,
        sk,
        kind: 'complaintRecipient',
        eventType: 'Complaint',
        bucket,
        mailTimestampMs,
        eventTimestampMs: complaintTimestampMs,
        messageId: detail.mail.messageId,
        feedbackId: detail.complaint.feedbackId,
        recipientHmac: pseudonym.recipientHmac,
        receivingDomain: pseudonym.receivingDomain,
        keyVersion: pseudonym.keyVersion,
        fields: baseFields,
        context,
        runId,
      }),
    );
  }
  return records;
}

function minimizeDeliveryDelay(detail: Extract<SesEvent, { eventType: 'DeliveryDelay' }>, context: MinimizeContext): EventRecord[] {
  const mailTimestampMs = Date.parse(detail.mail.timestamp);
  const delayTimestampMs = Date.parse(detail.deliveryDelay.timestamp);
  const bucket = bucketStartMs(mailTimestampMs);
  const baseFields = commonFields(detail.mail.tags, context.lane);
  const runId = runIdFor(detail.mail.tags, context.laneMap);

  const records: EventRecord[] = [];
  for (const recipient of detail.deliveryDelay.delayedRecipients) {
    const pseudonym = pseudonymizeRecipient(recipient.emailAddress, context.keySet, mailTimestampMs);
    const identity = identityFor({
      kind: 'DeliveryDelay',
      messageId: detail.mail.messageId,
      recipientHmac: pseudonym.recipientHmac,
      delayTimestampMs,
    });
    const { pk, sk } = recordKey({
      configurationSet: context.lane.configurationSet,
      bucketStartMs: bucket,
      eventType: 'DeliveryDelay',
      identity,
    });

    const fields: EventFields = {
      ...baseFields,
      delayType: detail.deliveryDelay.delayType,
      delayTimestampMs,
      ...(recipient.status !== undefined ? { recipientStatus: recipientStatus(recipient.status) } : {}),
      ...diagnosticCodeFields(recipient.diagnosticCode),
      ...(detail.deliveryDelay.reportingMTA !== undefined
        ? { reportingMta: reportingMta(detail.deliveryDelay.reportingMTA) }
        : {}),
    };

    records.push(
      buildRecord({
        pk,
        sk,
        kind: 'outcome',
        eventType: 'DeliveryDelay',
        bucket,
        mailTimestampMs,
        eventTimestampMs: delayTimestampMs,
        messageId: detail.mail.messageId,
        recipientHmac: pseudonym.recipientHmac,
        receivingDomain: pseudonym.receivingDomain,
        keyVersion: pseudonym.keyVersion,
        fields,
        context,
        runId,
      }),
    );
  }
  return records;
}

export function minimizeEvent(event: SesEnvelope, context: MinimizeContext): EventRecord[] {
  const { detail } = event;
  // Every record is filed under the lane's partition, and a lane's counts decide whether that
  // lane is closed, so a caller's lane that is not this event's own configuration set is refused.
  if (detail.mail.tags['ses:configuration-set']?.[0] !== context.lane.configurationSet) {
    throw new Error(`the event's configuration set does not match the lane ${context.lane.configurationSet}`);
  }

  switch (detail.eventType) {
    case 'Send':
      return minimizeSend(detail, context);
    case 'Reject':
      return minimizeReject(detail, context);
    case 'Delivery':
      return minimizeDelivery(detail, context);
    case 'Bounce':
      return minimizeBounce(detail, context);
    case 'Complaint':
      return minimizeComplaint(detail, context);
    case 'DeliveryDelay':
      return minimizeDeliveryDelay(detail, context);
  }
}
