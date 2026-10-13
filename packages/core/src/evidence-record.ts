import { createHash } from 'node:crypto';
import * as z from 'zod';
import { REFUSAL_REASONS } from './closeability.js';
import { DECISION_OUTCOMES, DECISION_REASONS, READ_BOUNDS } from './decision.js';
import {
  CONFIGURATION_STATES,
  CONFIGURATION_VERDICTS,
  ROW_DIMENSIONS,
  ROW_KINDS,
  ROW_VERDICTS,
  type ConfigurationRow,
  type EvidenceRow,
} from './evidence-rows.js';
import { CONFIGURATION_SET_PATTERN, SES_TAG_PATTERN } from './lanes.js';
import type { RecordKey } from './records.js';
import { LANE_RATIO_LABELS, LANE_SHARE_LABEL, LANE_TRIGGERS, LANE_VERDICTS } from './verdicts.js';
import { AUTH_CORROBORATION_CODES, type ConfigurationRecord } from './window-fold.js';

function canonicalize(value: unknown, path: string): unknown {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) {
      throw new TypeError(`canonical JSON holds safe integers only, and ${path} is not one`);
    }
    return value;
  }
  if (Array.isArray(value)) return value.map((item, index) => canonicalize(item, `${path}[${index}]`));
  if (typeof value !== 'object' || value === null) return value;
  const withToJson = value as { toJSON?: () => unknown };
  if (typeof withToJson.toJSON === 'function') return canonicalize(withToJson.toJSON(), path);
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, nested]) => [key, canonicalize(nested, `${path}.${key}`)]),
  );
}

/**
 * Keys sorted by UTF-16 code unit at every depth (the order `<` compares strings in), no whitespace,
 * and integers only (D-69): a float would serialize differently across runtimes and a hash over it
 * would stop recomputing, so one is refused by name instead.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value, '$')) ?? 'null';
}

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export const EVIDENCE_RECORD_SCHEMA_VERSION = 1;

// D-70: ten rows per dimension across four dimensions plus the configuration rows fit in a few
// kilobytes, so this ceiling only trips on a bug, and past it nothing is sent to the agent.
export const RECORD_BYTE_CEILING = 16_384;

export const FIX_KINDS = [
  'shared-tag-value',
  'shared-provider',
  'missing-dkim',
  'failed-mail-from',
  'missing-dmarc',
  'missing-spf',
] as const;

export const ISOLATION_VERDICTS = ['confined', 'spread-domain', 'spread-provider', 'spread-account'] as const;

export const SHARED_CAUSE_KINDS = ['batch', 'template', 'campaign', 'provider', 'from-domain'] as const;

const HEX_32 = /^[0-9a-f]{32}$/;
const HEX_64 = /^[0-9a-f]{64}$/;
const OPTION_ID = /^opt-[0-9a-f]{24}$/;
const PERCENT = /^\d{1,3}\.\d{2}%$/;
const HOSTNAME = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
// A DMARC lookup reads _dmarc.<domain> (RFC 7489 section 6.6.3), so the first label of a looked-up
// name may start with an underscore, which no hostname carries.
const DNS_NAME = /^(?=.{1,253}$)_?[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
// The lane-map name is operator text; the record crosses to a model provider, so only printable
// ASCII may ride along, and the question and fix are held to the same alphabet.
const PRINTABLE_ASCII = (max: number) => new RegExp(`^[\\x20-\\x7E]{1,${max}}$`);

const count = z.int().nonnegative();
const percent = z.string().regex(PERCENT).nullable();
const configurationSet = z.string().regex(CONFIGURATION_SET_PATTERN);
const hostname = z.string().regex(HOSTNAME);
const CONFIGURATION_RECORDS = Object.keys(AUTH_CORROBORATION_CODES) as [ConfigurationRecord, ...ConfigurationRecord[]];

const thresholdSchema = z.strictObject({
  ratio: z.enum(LANE_TRIGGERS),
  numerator: z.int().positive(),
  denominator: z.int().positive(),
  minEvents: count,
  minSends: count,
});

// A row value is a tag value or a provider mapping name, both held to the SES tag alphabet, which has
// no dot: a receiving domain or an MX host can never pass as a row value (AC-P3).
const rowSchema = z
  .strictObject({
    dimension: z.enum(ROW_DIMENSIONS),
    kind: z.enum(ROW_KINDS),
    value: z.string().regex(SES_TAG_PATTERN).nullable(),
    sends: count,
    permanentBounces: count,
    complaints: count,
    hardBounceRatio: percent,
    complaintRatio: percent,
    sharePercent: percent,
    verdict: z.enum(ROW_VERDICTS),
    thresholds: z.array(thresholdSchema),
    fromBucketMs: count,
    toBucketMs: count,
  })
  .refine((row) => (row.kind === 'value') === (row.value !== null), {
    message: 'a value row names its value, and a no-value or other row names none',
  });

const lookupSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('ses'), operation: z.literal('GetEmailIdentity'), identity: hostname.nullable() }),
  z.strictObject({
    kind: z.literal('dns'),
    name: z.string().regex(DNS_NAME),
    recordType: z.enum(['TXT', 'MX']),
    outcome: z.enum(['records', 'missing', 'unknown']),
  }),
]);

const configurationRowSchema = z.strictObject({
  fromDomain: hostname,
  record: z.enum(CONFIGURATION_RECORDS),
  state: z.enum(CONFIGURATION_STATES),
  verdict: z.enum(CONFIGURATION_VERDICTS),
  lookups: z.array(lookupSchema),
  corroboration: z.strictObject({ corroboratingBounces: count, permanentBounces: count }),
});

const decisionSchema = z.strictObject({
  outcome: z.enum(DECISION_OUTCOMES),
  reason: z.enum(DECISION_REASONS),
  closeability: z.strictObject({
    state: z.enum(['closeable', 'refused', 'no-data']),
    reasons: z.array(z.enum(REFUSAL_REASONS)),
  }),
  noData: z.boolean(),
  bound: z.enum(READ_BOUNDS).nullable(),
  otherSpikingLanes: z.array(configurationSet),
  sharedCause: z
    .strictObject({
      kind: z.enum(SHARED_CAUSE_KINDS),
      value: z.union([z.string().regex(SES_TAG_PATTERN), hostname]),
      lanes: z.array(configurationSet),
    })
    .nullable(),
});

export const evidenceRecordSchema = z
  .strictObject({
    schemaVersion: z.literal(EVIDENCE_RECORD_SCHEMA_VERSION),
    incidentId: z.string().regex(HEX_32),
    lane: z.strictObject({ configurationSet, lane: z.string().regex(PRINTABLE_ASCII(256)) }),
    window: z.strictObject({ fromBucketMs: count, toBucketMs: count }),
    laneTotals: z.strictObject({
      recipientSends: count,
      permanentBounces: count,
      complaints: count,
      hardBounceRatio: percent,
      complaintRatio: percent,
      verdict: z.enum(LANE_VERDICTS),
      triggers: z.array(z.enum(LANE_TRIGGERS)),
      label: z.strictObject({
        hardBounceRatio: z.literal(LANE_RATIO_LABELS.hardBounce),
        complaintRatio: z.literal(LANE_RATIO_LABELS.complaint),
      }),
    }),
    share: z.strictObject({
      laneCountableEvents: count,
      storedCountableEvents: count,
      percent,
      label: z.literal(LANE_SHARE_LABEL),
    }),
    rows: z.array(rowSchema),
    configurationRows: z.array(configurationRowSchema),
    isolation: z.enum(ISOLATION_VERDICTS),
    decision: decisionSchema,
    question: z.string().regex(PRINTABLE_ASCII(1000)).nullable(),
    fix: z.strictObject({ kind: z.enum(FIX_KINDS), text: z.string().regex(PRINTABLE_ASCII(1000)) }).nullable(),
    approvedOptions: z.array(z.strictObject({ optionId: z.string().regex(OPTION_ID) })).max(1),
    expiresAt: z.int().positive(),
    hash: z.string().regex(HEX_64),
  })
  .refine((record) => record.approvedOptions.length === (record.decision.outcome === 'approved' ? 1 : 0), {
    message: 'an approved decision carries exactly one option and any other decision carries none',
  });

export type EvidenceRecord = z.infer<typeof evidenceRecordSchema>;
export type EvidenceRecordInput = Omit<EvidenceRecord, 'schemaVersion' | 'approvedOptions' | 'hash'>;

// The record's rows are typed by evidence-rows.ts; these assignments fail the type gate if the
// schema and those types ever drift apart.
const rowTypesAgree: z.infer<typeof rowSchema> extends EvidenceRow ? (EvidenceRow extends z.infer<typeof rowSchema> ? true : never) : never = true;
const configurationRowTypesAgree: z.infer<typeof configurationRowSchema> extends ConfigurationRow
  ? ConfigurationRow extends z.infer<typeof configurationRowSchema>
    ? true
    : never
  : never = true;
void rowTypesAgree;
void configurationRowTypesAgree;

export function serializedRecordBytes(record: EvidenceRecord): number {
  return Buffer.byteLength(canonicalJson(record), 'utf8');
}

/** D-53: the lane and the start of the bucket holding now at the opening cycle. */
export function incidentIdFor(configurationSet: string, openingBucketStartMs: number): string {
  return sha256Hex(`${configurationSet}#${openingBucketStartMs}`).slice(0, 32);
}

/** D-69: unrelated to the set name (AC-12) and different per incident (AC-E30). */
export function optionIdFor(incidentId: string, index: number): string {
  return `opt-${sha256Hex(`${incidentId}#option#${index}`).slice(0, 24)}`;
}

export function recordHash(record: Omit<EvidenceRecord, 'hash'> | EvidenceRecord): string {
  const withoutHash = Object.fromEntries(Object.entries(record).filter(([key]) => key !== 'hash'));
  return sha256Hex(canonicalJson(withoutHash));
}

export function buildEvidenceRecord(input: EvidenceRecordInput): EvidenceRecord {
  const draft: Omit<EvidenceRecord, 'hash'> = {
    ...input,
    schemaVersion: EVIDENCE_RECORD_SCHEMA_VERSION,
    approvedOptions: input.decision.outcome === 'approved' ? [{ optionId: optionIdFor(input.incidentId, 0) }] : [],
  };
  return evidenceRecordSchema.parse({ ...draft, hash: recordHash(draft) });
}

// D-65: the decision store shares the event table, under partition keys that never start with LANE#,
// so a lane query or the recipient index can never reach one of these items.
export const INCIDENT_PARTS = ['STATE', 'EVIDENCE', 'DECISION', 'COUNTER'] as const;
export type IncidentPart = (typeof INCIDENT_PARTS)[number];

const UTC_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function incidentLaneKey(configurationSet: string): RecordKey {
  return { pk: `INCIDENT_LANE#${configurationSet}`, sk: 'MARKER' };
}

export function incidentItemKey(incidentId: string, part: IncidentPart): RecordKey {
  return { pk: `INCIDENT#${incidentId}`, sk: part };
}

export function counterDayKey(utcDate: string): RecordKey {
  if (!UTC_DATE.test(utcDate)) throw new RangeError('a counter day is a UTC date written YYYY-MM-DD');
  return { pk: `COUNTER_DAY#${utcDate}`, sk: 'COUNTER' };
}
