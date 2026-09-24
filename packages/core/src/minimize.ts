import { expiresAtFor, recordKey, type EventFields, type EventRecord, type Provenance } from './records.js';
import { bucketStartMs } from './buckets.js';
import { pseudonymizeRecipient, type AddressKeySet } from './address.js';
import type { LaneEntry, LaneMap } from './lanes.js';
import type { SesEnvelope } from './ses-events.js';

export interface MinimizeContext {
  lane: LaneEntry;
  // Unused by the Bounce path below: reserved for plan 01-12, which populates the full field
  // schedule per event type and needs the whole map, not just the one already-matched lane.
  laneMap: LaneMap;
  keySet: AddressKeySet;
  provenance: Provenance;
  envelopeTimeMs: number;
  arrivalTimeMs: number;
}

export function minimizeEvent(event: SesEnvelope, context: MinimizeContext): EventRecord[] {
  const { detail } = event;
  if (detail.eventType !== 'Bounce') return [];

  const mailTimestampMs = Date.parse(detail.mail.timestamp);
  const bounceTimestampMs = Date.parse(detail.bounce.timestamp);
  const bucketStart = bucketStartMs(mailTimestampMs);

  const records: EventRecord[] = [];
  for (const recipient of detail.bounce.bouncedRecipients) {
    const pseudonym = pseudonymizeRecipient(recipient.emailAddress, context.keySet, mailTimestampMs);
    const identity = `${detail.bounce.feedbackId}#${pseudonym.recipientHmac}`;
    const { pk, sk } = recordKey({
      configurationSet: context.lane.configurationSet,
      bucketStartMs: bucketStart,
      eventType: 'Bounce',
      identity,
    });

    // exactOptionalPropertyTypes forbids assigning `undefined` to an optional field, so the
    // per-recipient fields the AWS example may omit are spread in only when present.
    const fields: EventFields = {
      bounceType: detail.bounce.bounceType,
      bounceSubType: detail.bounce.bounceSubType,
      ...(recipient.status !== undefined ? { recipientStatus: recipient.status } : {}),
      ...(recipient.action !== undefined ? { recipientAction: recipient.action } : {}),
    };

    records.push({
      pk,
      sk,
      kind: 'outcome',
      eventType: 'Bounce',
      configurationSet: context.lane.configurationSet,
      bucketStartMs: bucketStart,
      mailTimestampMs,
      eventTimestampMs: bounceTimestampMs,
      envelopeTimeMs: context.envelopeTimeMs,
      arrivalTimeMs: context.arrivalTimeMs,
      messageId: detail.mail.messageId,
      feedbackId: detail.bounce.feedbackId,
      provenance: context.provenance,
      expiresAt: expiresAtFor(mailTimestampMs),
      recipientHmac: pseudonym.recipientHmac,
      receivingDomain: pseudonym.receivingDomain,
      keyVersion: pseudonym.keyVersion,
      fields,
    });
  }
  return records;
}
