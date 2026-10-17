import * as z from 'zod';
import { CONFIGURATION_SET_PATTERN } from './lanes.js';
import { PROVENANCES } from './records.js';

// One replay artifact per file, written by hand (generated) or by phase 6's capture script (live).
// It holds integers and strings only, the way phase 2's evidence record does, so the canonical
// hash a capture manifest pins never depends on how a float or a boolean was printed.

export const EVIDENCE_DIMENSIONS = ['tag', 'provider', 'configuration'] as const;
export const EVIDENCE_VERDICTS = ['cause', 'clean', 'ruled-out'] as const;
export const EVENT_KINDS = [
  'bounce',
  'delivery',
  'evidence-record',
  'agent',
  'ses-call',
  'read-back',
  'hold-check',
  'email-sent',
  'reopen-command',
] as const;
export const BOUNCE_TYPES = ['Permanent', 'Transient', 'Undetermined'] as const;
export const READ_BACK_VALUES = ['false', 'true'] as const;

const UTC_TIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

const text = z.string().min(1);
const count = z.number().int().min(0);
const utcTime = z
  .string()
  .regex(UTC_TIME_PATTERN, 'must be an ISO 8601 UTC time such as 2026-10-14T14:01:00Z')
  .refine((value) => !Number.isNaN(Date.parse(value)), 'is not a real calendar time');
const configurationSet = z.string().regex(CONFIGURATION_SET_PATTERN, 'must be an SES configuration set name');
const provenance = z.enum(PROVENANCES);

const evidenceRowSchema = z.strictObject({
  dimension: z.enum(EVIDENCE_DIMENSIONS),
  subject: text,
  count,
  denominator: count,
  unit: text,
  verdict: z.enum(EVIDENCE_VERDICTS),
  threshold: text,
  confirmingSourceUrl: z.string().regex(/^https:\/\/\S+$/, 'must be an https URL').optional(),
});

const eventSchema = z.strictObject({
  step: z.number().int().min(1).max(4),
  atUtc: utcTime,
  kind: z.enum(EVENT_KINDS),
  lane: configurationSet,
  detail: text,
  provenance,
  bounceType: z.enum(BOUNCE_TYPES).optional(),
  smtpCode: text.optional(),
  receivingDomain: text.optional(),
});

const readBackSchema = z.strictObject({
  operation: text,
  field: text,
  value: z.enum(READ_BACK_VALUES),
  atUtc: utcTime,
});

export const replayArtifactSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    provenance,
    region: z.literal('eu-central-1'),
    lanes: z.array(configurationSet).min(1),
    closedLane: configurationSet,
    cause: z.strictObject({ dimension: z.enum(EVIDENCE_DIMENSIONS), key: text, value: text }),
    window: z.strictObject({ startUtc: utcTime, endUtc: utcTime, sends: count, receivingProviders: count }),
    evidence: z.array(evidenceRowSchema).min(1),
    events: z.array(eventSchema).min(1),
    pause: z.strictObject({ operation: text, atUtc: utcTime, readBack: readBackSchema }),
    holdCheck: z.strictObject({ atUtc: utcTime, holdFromUtc: utcTime, result: z.enum(['passed', 'failed']) }).optional(),
    agent: z.strictObject({ outcome: z.enum(['close', 'unknown']), optionId: text.optional(), paragraph: text }),
    email: z.strictObject({ subject: text, sentAtUtc: utcTime }),
    reopen: z.strictObject({
      command: text,
      atUtc: utcTime,
      readBack: z.strictObject({ value: z.enum(READ_BACK_VALUES), atUtc: utcTime }),
    }),
  })
  .superRefine((artifact, ctx) => {
    const lanes = new Set<string>();
    artifact.lanes.forEach((lane, index) => {
      if (lanes.has(lane)) ctx.addIssue({ code: 'custom', message: `lane "${lane}" is listed twice`, path: ['lanes', index] });
      lanes.add(lane);
    });
    if (!lanes.has(artifact.closedLane)) {
      ctx.addIssue({ code: 'custom', message: `"${artifact.closedLane}" is not one of the artifact's lanes`, path: ['closedLane'] });
    }
    artifact.events.forEach((event, index) => {
      if (!lanes.has(event.lane)) {
        ctx.addIssue({ code: 'custom', message: `"${event.lane}" is not one of the artifact's lanes`, path: ['events', index, 'lane'] });
      }
      if (event.kind === 'bounce' && event.bounceType === undefined) {
        ctx.addIssue({ code: 'custom', message: 'a bounce needs its bounce type', path: ['events', index, 'bounceType'] });
      }
    });
    artifact.evidence.forEach((row, index) => {
      if (row.count > row.denominator) {
        ctx.addIssue({ code: 'custom', message: `${String(row.count)} is more than its denominator ${String(row.denominator)}`, path: ['evidence', index, 'count'] });
      }
    });
  });

export type ReplayArtifact = z.infer<typeof replayArtifactSchema>;
export type ReplayEvent = ReplayArtifact['events'][number];
export type EvidenceRow = ReplayArtifact['evidence'][number];

export type PublishResult = { ok: true } | { ok: false; errors: string[] };

export function replayArtifactHash(artifact: ReplayArtifact): string {
  return '';
}

export function assertPublishable(artifact: ReplayArtifact, manifest: unknown): PublishResult {
  return { ok: true };
}
