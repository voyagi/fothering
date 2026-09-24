import { z } from 'zod';

// D-12: zod objects strip unknown keys by default, so a new SES field an event carries but this
// schema does not name is dropped silently rather than rejected. Plan 01-04 adds the other five
// event types; this plan carries only the Bounce shape the tracer needs.

const bouncedRecipientSchema = z.object({
  emailAddress: z.string(),
  action: z.string().optional(),
  status: z.string().optional(),
  diagnosticCode: z.string().optional(),
});

const bounceDetailSchema = z.object({
  eventType: z.literal('Bounce'),
  mail: z.object({
    timestamp: z.string(),
    messageId: z.string(),
    destination: z.array(z.string()),
    tags: z.record(z.string(), z.array(z.string())),
  }),
  bounce: z.object({
    bounceType: z.string(),
    bounceSubType: z.string(),
    bouncedRecipients: z.array(bouncedRecipientSchema),
    timestamp: z.string(),
    feedbackId: z.string(),
    reportingMTA: z.string().optional(),
  }),
});

const eventBridgeEnvelopeSchema = z.object({
  version: z.string(),
  id: z.string(),
  'detail-type': z.string(),
  source: z.string(),
  account: z.string(),
  time: z.string(),
  region: z.string(),
  resources: z.array(z.string()),
  detail: bounceDetailSchema,
});

export type SesEnvelope = z.infer<typeof eventBridgeEnvelopeSchema>;

export type ParseSesEventResult = { ok: true; event: SesEnvelope } | { ok: false; messageId?: string };

export function parseSesEvent(raw: unknown): ParseSesEventResult {
  const result = eventBridgeEnvelopeSchema.safeParse(raw);
  if (result.success) return { ok: true, event: result.data };
  const messageId = extractMessageId(raw);
  return messageId === undefined ? { ok: false } : { ok: false, messageId };
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
