import * as z from 'zod';
import { SES_ID_PATTERN, UNCLASSIFIED } from './records.js';
import { SUPPRESSION_COMPLAINT_SUBTYPES } from './buckets.js';

// D-12: zod objects strip unknown keys by default, so a new SES field or subtype this schema does
// not name is dropped or mapped to unclassified rather than dropping the whole event. The schemas
// name only fields a record reads, so four documented fields are left out on purpose (mail.source,
// delivery.processingTimeMillis, reject.reason, deliveryDelay.expirationTime): required, each would
// drop a whole event whenever SES left it out, and mail.source would carry the sender address along.

// An id outside SES_ID_PATTERN fails the parse rather than carrying free text into a record key.
const sesId = z.string().regex(SES_ID_PATTERN);

// SES and EventBridge write every timestamp as ISO 8601 with an explicit offset (Z). Date.parse
// alone would also accept a date-time with no offset, which it reads as LOCAL time, so one event
// would land in send-time buckets hours apart on hosts in different timezones; it also reads a
// bare "1" as a date in 2001 and rolls 31 February into March. The offset is therefore required,
// and the calendar date must exist.
const isoTimestamp = z.iso.datetime({ offset: true });

// A value outside the AWS-documented list never fails the parse: it is a new SES subtype the
// schema has not caught up with yet, so it is stored as unclassified instead of dropping the event.
function unclassifiedEnum(values: readonly string[]) {
  const allowed = new Set(values);
  return z.string().transform((value) => (allowed.has(value) ? value : UNCLASSIFIED));
}

const BOUNCE_TYPES = ['Undetermined', 'Permanent', 'Transient'] as const;
const BOUNCE_SUBTYPES = [
  'Undetermined',
  'General',
  'NoEmail',
  'Suppressed',
  'OnAccountSuppressionList',
  'EmailValidationSuppressed',
  'OnTenantSuppressionList',
  'MailboxFull',
  'MessageTooLarge',
  'CustomTimeoutExceeded',
  'ContentRejected',
  'AttachmentRejected',
] as const;
const COMPLAINT_FEEDBACK_TYPES = ['abuse', 'auth-failure', 'fraud', 'not-spam', 'other', 'virus'] as const;
const DELAY_TYPES = [
  'InternalFailure',
  'General',
  'MailboxFull',
  'SpamDetected',
  'RecipientServerError',
  'IPFailure',
  'TransientCommunicationFailure',
  'BYOIPHostNameLookupUnavailable',
  'Undetermined',
  'SendingDeferral',
] as const;

// complaintSubType is the one enum field the docs say may be null: that means no subtype, never
// unclassified. The two suppression values are kept as themselves; anything else maps to unclassified.
const complaintSubTypeSchema = unclassifiedEnum(SUPPRESSION_COMPLAINT_SUBTYPES).nullish();

const mailSchema = z.object({
  timestamp: isoTimestamp,
  messageId: sesId,
  destination: z.array(z.string()),
  tags: z.record(z.string(), z.array(z.string())),
});

const bouncedRecipientSchema = z.object({
  emailAddress: z.string(),
  action: z.string().optional(),
  status: z.string().optional(),
  diagnosticCode: z.string().optional(),
});

const delayedRecipientSchema = z.object({
  emailAddress: z.string(),
  status: z.string().optional(),
  diagnosticCode: z.string().optional(),
});

const sendDetailSchema = z.object({
  eventType: z.literal('Send'),
  mail: mailSchema,
  send: z.object({}),
});

const deliveryDetailSchema = z.object({
  eventType: z.literal('Delivery'),
  mail: mailSchema,
  delivery: z.object({
    timestamp: isoTimestamp,
    recipients: z.array(z.string()).min(1),
    smtpResponse: z.string(),
    reportingMTA: z.string().optional(),
    remoteMtaIp: z.string(),
  }),
});

const bounceDetailSchema = z.object({
  eventType: z.literal('Bounce'),
  mail: mailSchema,
  bounce: z.object({
    bounceType: unclassifiedEnum(BOUNCE_TYPES),
    bounceSubType: unclassifiedEnum(BOUNCE_SUBTYPES),
    bouncedRecipients: z.array(bouncedRecipientSchema).min(1),
    timestamp: isoTimestamp,
    feedbackId: sesId,
    reportingMTA: z.string().optional(),
  }),
});

const complaintDetailSchema = z.object({
  eventType: z.literal('Complaint'),
  mail: mailSchema,
  complaint: z.object({
    complainedRecipients: z.array(z.object({ emailAddress: z.string() })),
    timestamp: isoTimestamp,
    feedbackId: sesId,
    complaintSubType: complaintSubTypeSchema,
    complaintFeedbackType: unclassifiedEnum(COMPLAINT_FEEDBACK_TYPES).optional(),
  }),
});

const rejectDetailSchema = z.object({
  eventType: z.literal('Reject'),
  mail: mailSchema,
  reject: z.object({}),
});

const deliveryDelayDetailSchema = z.object({
  eventType: z.literal('DeliveryDelay'),
  mail: mailSchema,
  deliveryDelay: z.object({
    delayType: unclassifiedEnum(DELAY_TYPES),
    delayedRecipients: z.array(delayedRecipientSchema).min(1),
    reportingMTA: z.string().optional(),
    timestamp: isoTimestamp,
  }),
});

const detailSchema = z.discriminatedUnion('eventType', [
  sendDetailSchema,
  deliveryDetailSchema,
  bounceDetailSchema,
  complaintDetailSchema,
  rejectDetailSchema,
  deliveryDelayDetailSchema,
]);

export type SesEvent = z.infer<typeof detailSchema>;

// The EventBridge detail-type and the SES-assigned eventType describe the same event through two
// independent fields; a mismatch is not a shape problem any single field schema can catch on its
// own, so it is checked here, after the rest of the envelope has already parsed successfully.
export const DETAIL_TYPE_BY_EVENT_TYPE: Record<SesEvent['eventType'], string> = {
  Send: 'Email Sent',
  Delivery: 'Email Delivered',
  Bounce: 'Email Bounced',
  Complaint: 'Email Complaint Received',
  Reject: 'Email Rejected',
  DeliveryDelay: 'Email Delivery Delayed',
};

const eventBridgeEnvelopeSchema = z
  .object({
    version: z.string(),
    id: z.string(),
    'detail-type': z.string(),
    source: z.literal('aws.ses'),
    account: z.string(),
    time: isoTimestamp,
    region: z.string(),
    resources: z.array(z.string()),
    detail: detailSchema,
  })
  .refine((value) => value['detail-type'] === DETAIL_TYPE_BY_EVENT_TYPE[value.detail.eventType], {
    message: 'detail-type does not match the parsed eventType',
  });

export type SesEnvelope = z.infer<typeof eventBridgeEnvelopeSchema>;

export type ParseSesEventResult =
  | { ok: true; event: SesEnvelope }
  | { ok: false; messageId?: string; field?: string };

export function parseSesEvent(raw: unknown): ParseSesEventResult {
  const result = eventBridgeEnvelopeSchema.safeParse(raw);
  if (result.success) return { ok: true, event: result.data };
  const messageId = extractMessageId(raw);
  const field = fieldFromIssue(raw, result.error.issues[0]);
  return {
    ok: false,
    ...(messageId !== undefined ? { messageId } : {}),
    ...(field !== undefined ? { field } : {}),
  };
}

// A parse failure still logs a message id where one is readable, so a dropped event leaves a
// trace without ever storing the event's free-text or address fields (SPEC requirement 5).
function extractMessageId(raw: unknown): string | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const detail = (raw as Record<string, unknown>).detail;
  if (typeof detail !== 'object' || detail === null) return undefined;
  const mail = (detail as Record<string, unknown>).mail;
  if (typeof mail !== 'object' || mail === null) return undefined;
  const messageId = (mail as Record<string, unknown>).messageId;
  return typeof messageId === 'string' ? messageId : undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// field is a closed vocabulary read from the FIRST zod issue's path, never from the input itself.
// Two restrictions keep it that way: a garbage or near-empty input (raw is not a plain object, or
// its first issue is a missing top-level envelope field such as "version") never gets one, because
// that shape carries no reliable content to name; only a detail-rooted issue, or the eventType and
// detail-type cross-check's empty-path issue, is specific enough to surface. A tag key is sender-
// controlled, so the path is cut the instant it reaches "tags", before any key past it is joined in.
function fieldFromIssue(raw: unknown, issue: { path: readonly PropertyKey[] } | undefined): string | undefined {
  if (!isPlainObject(raw) || issue === undefined) return undefined;
  if (issue.path.length === 0) return 'envelope';
  if (issue.path[0] !== 'detail') return undefined;
  // path[0] is 'detail' here, so segments always holds at least that one entry.
  const segments: string[] = [];
  for (const segment of issue.path) {
    if (typeof segment !== 'string') continue;
    segments.push(segment);
    if (segment === 'tags') break;
  }
  return segments.join('.');
}
