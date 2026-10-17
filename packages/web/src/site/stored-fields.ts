import type { EventFields, EventRecord } from '@fothering/core/records';

export type StoredFieldPath = Exclude<keyof EventRecord, 'fields'> | `fields.${keyof EventFields & string}`;

type Identifies = 'Recipient' | 'Sender';

export type StoredField = { class: 'neither' } | { class: 'recipient' | 'sender'; identifies: Identifies; row: string };

const NEITHER = { class: 'neither' } as const;

// Typed against the record itself, so tsc rejects a record field with no entry and an entry for a
// field the record lacks: the privacy page cannot fall behind the type. SES ids, mail provider and
// SES infrastructure addresses and closed-vocabulary codes are neither, and so are the operator's
// own tag values: the minimizer keeps one only when it is letters, digits, underscores and dashes,
// so it can never hold an address.
// The identifying entries come first, recipient before sender, because the privacy rows follow map order.
export const STORED_FIELDS = {
  recipientHmac: {
    class: 'recipient',
    identifies: 'Recipient',
    row: "An HMAC-SHA-256 of the lowercased address under a key kept in the operator's account. It is pseudonymised personal data: whoever holds the key can match an address to it.",
  },
  receivingDomain: { class: 'recipient', identifies: 'Recipient', row: 'The domain part of the recipient address.' },
  sk: {
    class: 'recipient',
    identifies: 'Recipient',
    row: "The record's key within its lane. On a record about one recipient it ends in that recipient's HMAC, so it is pseudonymised personal data in the same way.",
  },
  'fields.sourceIp': { class: 'sender', identifies: 'Sender', row: 'The IP address the sending application called SES from.' },
  'fields.fromDomain': { class: 'sender', identifies: 'Sender', row: 'The domain of the From address.' },
  'fields.callerIdentity': {
    class: 'sender',
    identifies: 'Sender',
    row: 'The IAM identity that called SES to send. It can name a person when a user, not a role, sends.',
  },
  pk: NEITHER,
  kind: NEITHER,
  eventType: NEITHER,
  configurationSet: NEITHER,
  bucketStartMs: NEITHER,
  mailTimestampMs: NEITHER,
  eventTimestampMs: NEITHER,
  envelopeTimeMs: NEITHER,
  arrivalTimeMs: NEITHER,
  messageId: NEITHER,
  feedbackId: NEITHER,
  provenance: NEITHER,
  runId: NEITHER,
  expiresAt: NEITHER,
  keyVersion: NEITHER,
  recipientCount: NEITHER,
  'fields.bounceType': NEITHER,
  'fields.bounceSubType': NEITHER,
  'fields.complaintFeedbackType': NEITHER,
  'fields.complaintSubType': NEITHER,
  'fields.delayType': NEITHER,
  'fields.recipientStatus': NEITHER,
  'fields.recipientAction': NEITHER,
  'fields.enhancedStatusCode': NEITHER,
  'fields.basicReplyCode': NEITHER,
  'fields.remoteMtaIp': NEITHER,
  'fields.reportingMta': NEITHER,
  'fields.outgoingIp': NEITHER,
  'fields.streamTagValue': NEITHER,
  'fields.batchTagValue': NEITHER,
  'fields.templateTagValue': NEITHER,
  'fields.campaignTagValue': NEITHER,
  'fields.delayTimestampMs': NEITHER,
} as const satisfies Record<StoredFieldPath, StoredField>;

export function identifyingFields(): Array<{ path: StoredFieldPath; identifies: Identifies; row: string }> {
  return (Object.entries(STORED_FIELDS) as Array<[StoredFieldPath, StoredField]>).flatMap(([path, field]) =>
    field.class === 'neither' ? [] : [{ path, identifies: field.identifies, row: field.row }],
  );
}
