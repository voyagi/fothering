import * as z from 'zod';
import { AGENT_DECISIONS, GATE_REFUSALS, type AgentAnswer } from './agent-answer.js';
import { BUCKET_MS, bucketStartMs } from './buckets.js';
import { ACTION_FUNCTION_TIMEOUT_MS, HOLD_CHECK_DELAY_MS, RECORD_MAX_AGE_MS } from './close-values.js';
import { REFUSAL_REASONS, type RefusalReason } from './closeability.js';
import { incidentItemKey, type EvidenceRecord } from './evidence-record.js';
import type { IncidentMarker, IncidentState } from './incident.js';
import { CONFIGURATION_SET_PATTERN } from './lanes.js';
import { SES_ID_PATTERN, expiresAtFor, type EventRecord, type RecordKey } from './records.js';
import { MAX_WINDOW_BUCKETS, type BucketWindow, type LaneFold } from './window-fold.js';

// The closed vocabularies of phase 3, written complete here so later plans fill them in and the
// logger's sets change once. This module imports nothing from log.ts: the logger reads these.

export const CLOSURE_OUTCOMES = ['refused', 'dry-run', 'pause-failed', 'pause-unknown', 'paused', 'closed', 'not-holding'] as const;
export type ClosureOutcome = (typeof CLOSURE_OUTCOMES)[number];

export const REOPEN_OUTCOMES = ['reopened', 'reopen-failed', 'reopen-unknown'] as const;
export const REOPEN_RESULTS = [...REOPEN_OUTCOMES, 'refused', 'dry-run'] as const;

export const READ_BACK_FAULTS = ['missing', 'threw'] as const;
export type ReadBackFault = (typeof READ_BACK_FAULTS)[number];
export type ReadBack = boolean | ReadBackFault;

export const SES_FACTS_STATES = ['read', 'failed', 'bound'] as const;
export const LANE_STATES = ['incident-open', 'no-open-incident', 'paused-by-fothering'] as const;
export const EMAIL_KINDS = ['closed', 'not-confirmed', 'unknown'] as const;

export const FRESHNESS_REFUSALS = ['incident-not-open', 'newer-incident-elsewhere', 'record-too-old'] as const;
export type FreshnessRefusal = (typeof FRESHNESS_REFUSALS)[number];

export const ACTION_REFUSALS = [
  ...GATE_REFUSALS,
  'ses-facts-unavailable',
  'ses-facts-bound',
  ...FRESHNESS_REFUSALS,
  'record-not-closeable',
  'configuration-not-closeable',
  'lane-already-paused',
  'lane-cap-reached',
] as const;
export type ActionRefusal = (typeof ACTION_REFUSALS)[number];

export const REOPEN_REFUSALS = [
  'payload-invalid',
  'not-in-lane-map',
  'operator-alert',
  'no-fothering-pause',
  'not-reopenable',
  'already-reopened',
  'reopen-in-progress',
  'lane-cap-reached',
] as const;

export const EMAIL_REFUSALS = ['operator-config-missing', 'operator-alert-lane-count'] as const;

function distinct<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

// cap-reached is the DECISION item's own reason for a cap-ended agent (D-92); it reaches a closure
// as no-close but stays loggable as itself.
export const CLOSURE_LOG_REASONS = distinct([...ACTION_REFUSALS, ...REOPEN_REFUSALS, ...EMAIL_REFUSALS, ...REFUSAL_REASONS, 'cap-reached'] as const);

export const CLOSURE_LOG_OUTCOMES = distinct([...CLOSURE_OUTCOMES, ...REOPEN_RESULTS] as const);

const INCIDENT_ID_PATTERN = /^[0-9a-f]{32}$/;
const CLOSURE_PARTITION_KEY = /^INCIDENT#[0-9a-f]{32}$/;

const epochMs = z.int().nonnegative();
const count = z.int().nonnegative();
const configurationSet = z.string().regex(CONFIGURATION_SET_PATTERN);

const laneSchema = z.strictObject({
  configurationSet,
  state: z.enum(LANE_STATES),
  configurationRefusals: z.array(z.enum(REFUSAL_REASONS)),
});

const reopenSchema = z.strictObject({
  attempts: count,
  claimedAtMs: epochMs.nullable(),
  requestedAtMs: epochMs.nullable(),
  readBackAtMs: epochMs.nullable(),
  outcome: z.enum(REOPEN_OUTCOMES).nullable(),
});

const emailSchema = z.strictObject({
  kind: z.enum(EMAIL_KINDS),
  attempts: count,
  claimedAtMs: epochMs.nullable(),
  sentAtMs: epochMs.nullable(),
  messageId: z.string().regex(SES_ID_PATTERN).nullable(),
  failed: z.boolean(),
});

/**
 * D-90: one item per incident, codes, set names, integer epoch milliseconds and counts only, so no
 * address, keyed hash or model text can be stored on it. Every absent value is null, never undefined:
 * the table refuses an undefined attribute.
 */
export const closureItemSchema = z
  .strictObject({
    pk: z.string().regex(CLOSURE_PARTITION_KEY),
    sk: z.literal('CLOSURE'),
    incidentId: z.string().regex(INCIDENT_ID_PATTERN),
    configurationSet,
    decisionOutcome: z.enum(AGENT_DECISIONS),
    outcome: z.enum(CLOSURE_OUTCOMES).nullable(),
    reason: z.enum(CLOSURE_LOG_REASONS).nullable(),
    claimedAtMs: epochMs,
    pauseRequestedAtMs: epochMs.nullable(),
    readBackAtMs: epochMs.nullable(),
    readBack: z.union([z.boolean(), z.enum(READ_BACK_FAULTS)]).nullable(),
    holdEndMs: epochMs.nullable(),
    holdCheckedAtMs: epochMs.nullable(),
    holdCheckedThroughMs: epochMs.nullable(),
    sendsAfterHold: count.nullable(),
    sesFacts: z.enum(SES_FACTS_STATES).nullable(),
    lanes: z.array(laneSchema),
    reopen: reopenSchema.nullable(),
    email: emailSchema.nullable(),
    version: count,
    expiresAt: count,
  })
  .refine((closure) => closure.pk === `INCIDENT#${closure.incidentId}`, { path: ['pk'], message: 'the partition key names another incident' });

export type Closure = z.infer<typeof closureItemSchema>;

export function closureKey(incidentId: string): RecordKey {
  return incidentItemKey(incidentId, 'CLOSURE');
}

export interface ClosureClaimInput {
  incidentId: string;
  configurationSet: string;
  decisionOutcome: AgentAnswer['decision'];
  nowMs: number;
}

/** D-91: the claim every act writes with putIfAbsent before any SES call; outcome null means none yet. */
export function closureClaimItem(input: ClosureClaimInput): Closure {
  return {
    ...closureKey(input.incidentId),
    sk: 'CLOSURE',
    incidentId: input.incidentId,
    configurationSet: input.configurationSet,
    decisionOutcome: input.decisionOutcome,
    outcome: null,
    reason: null,
    claimedAtMs: input.nowMs,
    pauseRequestedAtMs: null,
    readBackAtMs: null,
    readBack: null,
    holdEndMs: null,
    holdCheckedAtMs: null,
    holdCheckedThroughMs: null,
    sendsAfterHold: null,
    sesFacts: null,
    lanes: [],
    reopen: null,
    email: null,
    version: 0,
    expiresAt: expiresAtFor(input.nowMs),
  };
}

export function parseClosure(item: unknown): Closure | undefined {
  const parsed = closureItemSchema.safeParse(item);
  return parsed.success ? parsed.data : undefined;
}

export type PauseOutcome = Extract<ClosureOutcome, 'paused' | 'pause-failed' | 'pause-unknown'>;

/** R1: only a read-back of SendingEnabled false is a pause; a true one is a pause that did not take. */
export function pauseOutcomeOf(readBack: ReadBack): PauseOutcome {
  if (readBack === false) return 'paused';
  if (readBack === true) return 'pause-failed';
  return 'pause-unknown';
}

export type ClaimState = 'finished' | 'in-flight' | 'reclaimable' | 'put-may-have-taken';

/**
 * D-91: a claim younger than the action's timeout belongs to a run still acting. An older one with no
 * pause requested ran no SES mutation, so it may be claimed again; one with a pause requested may have
 * paused, so it is never put again.
 */
export function claimStateOf(closure: Closure, nowMs: number): ClaimState {
  if (closure.outcome !== null) return 'finished';
  if (nowMs < closure.claimedAtMs + ACTION_FUNCTION_TIMEOUT_MS) return 'in-flight';
  return closure.pauseRequestedAtMs === null ? 'reclaimable' : 'put-may-have-taken';
}

/** D-93 and D-95: outcomes after which the set may still be paused by Fothering, until a reopen reads reopened. */
export const PAUSE_MAY_HOLD_OUTCOMES = ['paused', 'closed', 'not-holding', 'pause-unknown'] as const satisfies readonly ClosureOutcome[];

const PAUSE_MAY_HOLD: ReadonlySet<ClosureOutcome> = new Set(PAUSE_MAY_HOLD_OUTCOMES);

function reopened(closure: Closure): boolean {
  return closure.reopen?.outcome === 'reopened';
}

/**
 * D-95: whether the closure a lane's pause pointer names may still hold that lane. A closure that cannot
 * be read fails closed, and so does a claim still acting or one whose put may have taken.
 */
export function pauseMayHold(closure: Closure | undefined, nowMs: number): boolean {
  if (closure === undefined) return true;
  if (closure.outcome === null) {
    const state = claimStateOf(closure, nowMs);
    return state === 'in-flight' || state === 'put-may-have-taken';
  }
  return PAUSE_MAY_HOLD.has(closure.outcome) && !reopened(closure);
}

/** D-100: the first run at or after the hold end plus HOLD_CHECK_DELAY_MS, on a pause the operator has not reopened (D-94). */
export function holdCheckDue(closure: Closure, nowMs: number): closure is Closure & { holdEndMs: number } {
  return closure.outcome === 'paused' && !reopened(closure) && closure.holdEndMs !== null && nowMs >= closure.holdEndMs + HOLD_CHECK_DELAY_MS;
}

/** D-94: a reopened pause whose hold check would otherwise be due; it is skipped and keeps outcome paused. */
export function holdCheckSkipped(closure: Closure, nowMs: number): boolean {
  return closure.outcome === 'paused' && reopened(closure) && closure.holdEndMs !== null && nowMs >= closure.holdEndMs + HOLD_CHECK_DELAY_MS;
}

export interface HoldCheckWindow extends BucketWindow {
  /** The last millisecond the fold covered, which the email states when an outage clamped it. */
  checkedThroughMs: number;
}

/**
 * D-100: Send records sit in the bucket of their mail timestamp (D-08), so no bucket before the one
 * holding the hold end can hold a later Send. An action outage longer than a fold's reach reads the
 * first MAX_WINDOW_BUCKETS buckets and says how far it got.
 */
export function holdCheckWindow(holdEndMs: number, nowMs: number): HoldCheckWindow {
  const fromBucketMs = bucketStartMs(holdEndMs);
  const lastReadableMs = fromBucketMs + (MAX_WINDOW_BUCKETS - 1) * BUCKET_MS;
  const nowBucketMs = bucketStartMs(nowMs);
  if (nowBucketMs <= lastReadableMs) return { fromBucketMs, toBucketMs: nowBucketMs, checkedThroughMs: nowMs };
  return { fromBucketMs, toBucketMs: lastReadableMs, checkedThroughMs: lastReadableMs + BUCKET_MS - 1 };
}

/**
 * R2 and Pitfall 5: counts Send records accepted at or after the hold end, compared as integer epoch
 * milliseconds. A Delivery record says nothing about acceptance, and the fold keeps a count, never a record.
 */
export function holdFold(holdEndMs: number): LaneFold<number> {
  const acceptedAfterHold = (record: EventRecord): boolean =>
    record.kind === 'send' && record.eventType === 'Send' && Number.isInteger(record.mailTimestampMs) && record.mailTimestampMs >= holdEndMs;
  return { initial: 0, step: (count, page) => count + page.filter(acceptedAfterHold).length };
}

/** D-95: the lane's pause pointer as stored; a pointer that does not parse is treated as one holding the lane. */
export interface PausePointer {
  incidentId: string;
  version: number;
}

const pausePointerSchema = z.object({ incidentId: z.string().regex(INCIDENT_ID_PATTERN), version: count });

export function pausePointerOf(item: unknown): PausePointer | undefined {
  const parsed = pausePointerSchema.safeParse(item);
  return parsed.success ? parsed.data : undefined;
}

/** Another lane-map lane as the act read it: its marker not open, open with its STATE's opening window end, or unreadable. */
export type OtherLaneReading = { kind: 'no-open-incident' } | { kind: 'open'; openingToBucketMs: unknown } | { kind: 'unreadable' };

export interface FreshnessInput {
  incidentId: string;
  marker: IncidentMarker | undefined;
  state: IncidentState | undefined;
  others: readonly OtherLaneReading[];
  recordToBucketMs: number;
  nowMs: number;
}

// AC-E10: an opening window end that is not a safe integer, or a lane that could not be read, fails
// closed, since the lane it hides may hold the newer incident.
function isNewerElsewhere(other: OtherLaneReading, recordToBucketMs: number): boolean {
  if (other.kind === 'no-open-incident') return false;
  if (other.kind === 'unreadable') return true;
  const { openingToBucketMs } = other;
  return typeof openingToBucketMs !== 'number' || !Number.isSafeInteger(openingToBucketMs) || openingToBucketMs > recordToBucketMs;
}

/**
 * R3 and D-101: the record still describes the account only while its incident is open on its lane,
 * no other lane opened an incident after the record's window, and the window ended at most one spike
 * window ago. Ids compare with === (AC-E9). The lifecycle's closed status is read here and never
 * logged or rendered (D-112).
 */
export function freshnessRefusal(input: FreshnessInput): FreshnessRefusal | undefined {
  const { marker, state } = input;
  if (marker?.status !== 'open' || marker.incidentId !== input.incidentId || state?.status !== 'open') return 'incident-not-open';
  if (input.others.some((other) => isNewerElsewhere(other, input.recordToBucketMs))) return 'newer-incident-elsewhere';
  if (input.nowMs - input.recordToBucketMs > RECORD_MAX_AGE_MS) return 'record-too-old';
  return undefined;
}

export type CloseabilityRefusal = Extract<ActionRefusal, 'record-not-closeable' | 'configuration-not-closeable'>;

/**
 * D-89 step 5 and D-102: observed-event refusals come from the record, which R3 bounds to one spike
 * window, and configuration refusals from the facts read in this act. A target lane with no entry
 * fails closed.
 */
export function actionCloseabilityRefusal(
  recordCloseability: EvidenceRecord['decision']['closeability']['state'],
  target: { configurationRefusals: readonly RefusalReason[] } | undefined,
): CloseabilityRefusal | undefined {
  if (recordCloseability !== 'closeable') return 'record-not-closeable';
  if (target === undefined || target.configurationRefusals.length > 0) return 'configuration-not-closeable';
  return undefined;
}

/** The fields the action reads from a DECISION item; phase 2 stores an agent unknown and cap-reached alike as unknown (D-92). */
export interface StoredDecision {
  outcome: AgentAnswer['decision'];
  optionId?: string;
  explanation?: string;
  reason?: 'cap-reached';
}

export function decisionOf(item: unknown): StoredDecision | undefined {
  if (typeof item !== 'object' || item === null) return undefined;
  const { outcome, optionId, explanation, reason } = item as Record<string, unknown>;
  const known = AGENT_DECISIONS.find((decision) => decision === outcome);
  if (known === undefined) return undefined;
  return {
    outcome: known,
    ...(typeof optionId === 'string' ? { optionId } : {}),
    ...(typeof explanation === 'string' ? { explanation } : {}),
    ...(reason === 'cap-reached' ? { reason } : {}),
  };
}
