import { createHash } from 'node:crypto';
import * as z from 'zod';
import { CONFIGURATION_SET_PATTERN } from './lanes.js';
import { PROVENANCES, SES_ID_PATTERN } from './records.js';

// One replay artifact per file, written by hand (generated) or by phase 6's capture script (live).
// It holds integers and strings only, the way phase 2's evidence record does, so the canonical
// hash a capture manifest pins never depends on how a float or a boolean was printed.

const EVIDENCE_DIMENSIONS = ['tag', 'provider', 'configuration'] as const;
const EVIDENCE_VERDICTS = ['cause', 'clean', 'ruled-out'] as const;
const EVENT_KINDS = [
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
const BOUNCE_TYPES = ['Permanent', 'Transient', 'Undetermined'] as const;
const READ_BACK_VALUES = ['false', 'true'] as const;

const UTC_TIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

// Date.parse rolls an impossible day over (2026-02-30 reads as 2026-03-02) instead of failing, so a
// time is real only when the parsed date prints back as the same text, milliseconds padded to three.
function isCalendarTime(value: string): boolean {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return false;
  const [whole = '', fraction = ''] = value.slice(0, -1).split('.');
  return parsed.toISOString() === `${whole}.${fraction.padEnd(3, '0')}Z`;
}

const text = z.string().min(1);
const count = z.number().int().min(0);
const utcTime = z
  .string()
  .regex(UTC_TIME_PATTERN, 'must be an ISO 8601 UTC time such as 2026-10-14T14:01:00Z')
  // zod runs this refine even after the regex fails, so it judges only well-formed text and a
  // malformed time gets the one format message.
  .refine((value) => !UTC_TIME_PATTERN.test(value) || isCalendarTime(value), 'is not a real calendar time');
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

const EU_ARN_PATTERN = /^arn:aws:[a-z0-9-]+:eu-central-1:(\d{12}):\S+$/;

export const captureManifestSchema = z.strictObject({
  artifact: text,
  artifactSha256: z.string().regex(/^[0-9a-f]{64}$/, 'is not a 64-character lowercase hex SHA-256'),
  region: z.literal('eu-central-1'),
  accountId: z.string().regex(/^\d{12}$/, 'is not a 12-digit account id'),
  arns: z.array(z.string().regex(EU_ARN_PATTERN, 'is not an eu-central-1 ARN')).min(1, 'lists no ARN'),
  sesMessageIds: z.array(z.string().regex(SES_ID_PATTERN, 'is not an SES message id')).min(1, 'lists no SES message id'),
  requestIds: z.array(text).min(1, 'lists no request id'),
});

export interface IssueReport {
  path: string;
  problem: string;
  fix: string;
}

export function issuePath(path: readonly PropertyKey[]): string {
  return path.reduce<string>((joined, key) => {
    if (typeof key === 'number') return `${joined}[${String(key)}]`;
    return joined === '' ? String(key) : `${joined}.${String(key)}`;
  }, '');
}

function withArticle(noun: string): string {
  return /^[aeiou]/.test(noun) ? `an ${noun}` : `a ${noun}`;
}

function kindOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  return withArticle(typeof value);
}

function quoted(value: unknown): string {
  return typeof value === 'string' ? `'${value}'` : JSON.stringify(value);
}

// Turns a zod issue into the build message parts of UI-SPEC section 11.1: what is wrong at which
// path and what to do. Parse with reportInput so a missing field reads "is missing", not a type.
export function reportIssue(issue: z.core.$ZodIssue): IssueReport {
  const path = issuePath(issue.path);
  if ((issue.code === 'invalid_type' || issue.code === 'invalid_value') && issue.input === undefined) {
    return { path, problem: 'is missing', fix: 'Add the field' };
  }
  switch (issue.code) {
    case 'invalid_type':
      return { path, problem: `expected ${withArticle(issue.expected === 'int' ? 'integer' : issue.expected)}, found ${kindOf(issue.input)}`, fix: 'Write it as that type' };
    case 'invalid_value':
      return issue.values.length === 1
        ? { path, problem: `${quoted(issue.input)} is not ${String(issue.values[0])}`, fix: 'Use that value' }
        : { path, problem: `${quoted(issue.input)} is not one of ${issue.values.map(String).join(', ')}`, fix: 'Use one of those values' };
    case 'too_small':
      return issue.origin === 'array' ? { path, problem: 'is empty', fix: 'Add at least one entry' } : { path, problem: issue.message, fix: 'Correct the value' };
    case 'unrecognized_keys':
      return { path, problem: `holds the unknown key ${issue.keys.join(', ')}`, fix: 'Remove it' };
    default:
      return { path, problem: issue.message, fix: 'Correct the value' };
  }
}

// Canonical JSON for the capture manifest's hash: keys sorted by UTF-16 code unit at every depth,
// arrays kept in order, integers only. Plan 05-15 swaps this for phase 2's canonicalJson once that
// is on the branch, so one implementation remains.
function canonicalText(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalText).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalText(record[key])}`).join(',')}}`;
  }
  if (typeof value === 'number' && !Number.isSafeInteger(value)) {
    throw new RangeError(`canonical JSON holds integers only, found ${String(value)}`);
  }
  return JSON.stringify(value);
}

export function replayArtifactHash(artifact: ReplayArtifact): string {
  return createHash('sha256').update(canonicalText(artifact), 'utf8').digest('hex');
}

export type PublishResult = { ok: true } | { ok: false; errors: string[] };

const LIVE = 'provenance is live but';
const MANIFEST = 'capture-manifest.json';
const ADD_FROM_CAPTURE = 'Add the ids from the capture run, or label the artifact simulator-captured.';
const CORRECT_FROM_CAPTURE = 'Correct it from the capture run, or label the artifact simulator-captured.';

function manifestIssueText(issue: z.core.$ZodIssue): string {
  if (issue.code === 'too_small' && issue.origin === 'array' && issue.path.length === 1) {
    return `${LIVE} ${MANIFEST} ${issue.message}. ${ADD_FROM_CAPTURE}`;
  }
  const report = reportIssue(issue);
  const where = report.path === '' ? MANIFEST : `${MANIFEST} ${report.path}:`;
  return `${LIVE} ${where} ${report.problem}. ${CORRECT_FROM_CAPTURE}`;
}

function manifestErrors(artifact: ReplayArtifact, manifest: unknown): string[] {
  const parsed = captureManifestSchema.safeParse(manifest, { reportInput: true });
  if (!parsed.success) return parsed.error.issues.map(manifestIssueText);
  const { accountId, arns, artifactSha256 } = parsed.data;
  const errors: string[] = [];
  arns.forEach((arn, index) => {
    const account = EU_ARN_PATTERN.exec(arn)?.[1];
    if (account !== accountId) {
      errors.push(`${LIVE} ${MANIFEST} arns[${String(index)}]: names account ${String(account)}, not accountId ${accountId}. ${CORRECT_FROM_CAPTURE}`);
    }
  });
  const hash = replayArtifactHash(artifact);
  if (artifactSha256 !== hash) {
    errors.push(`${LIVE} ${MANIFEST} artifactSha256: does not equal the artifact's canonical hash ${hash}. ${CORRECT_FROM_CAPTURE}`);
  }
  return errors;
}

// The page labels come from the artifact's provenance alone, so a non-live label must match every
// event too: a simulator stamp over generated events would claim a capture nobody ran.
function eventProvenanceError(artifact: ReplayArtifact): string | undefined {
  const index = artifact.events.findIndex((event) => event.provenance !== artifact.provenance);
  const event = artifact.events[index];
  if (event === undefined) return undefined;
  return `provenance is ${artifact.provenance} but events[${String(index)}].provenance is ${event.provenance}. Record every event as ${artifact.provenance}, or label the artifact by what its events are.`;
}

// The only way to the live label: every event live and a manifest whose every item checks out.
// A refusal is an error list for the build to print, never a quieter label for the page to show.
export function assertPublishable(artifact: ReplayArtifact, manifest: unknown): PublishResult {
  if (artifact.provenance !== 'live') {
    const errors: string[] = [];
    const mismatch = eventProvenanceError(artifact);
    if (mismatch !== undefined) errors.push(mismatch);
    if (manifest !== undefined) {
      errors.push(`${MANIFEST} is present but the artifact's provenance is ${artifact.provenance}. Remove the manifest, or label the artifact live from a capture run.`);
    }
    return errors.length === 0 ? { ok: true } : { ok: false, errors };
  }
  const errors: string[] = [];
  artifact.events.forEach((event, index) => {
    if (event.provenance !== 'live') {
      errors.push(`${LIVE} events[${String(index)}].provenance is ${event.provenance}. Capture every event live, or label the artifact simulator-captured.`);
    }
  });
  if (manifest === undefined) {
    errors.push(`${LIVE} there is no ${MANIFEST}. Add the manifest from the capture run, or label the artifact simulator-captured.`);
  } else {
    errors.push(...manifestErrors(artifact, manifest));
  }
  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}
