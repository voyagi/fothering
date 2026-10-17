import * as z from 'zod';
import { AGENT_DECISIONS, GATE_REFUSALS, type AgentAnswer } from './agent-answer.js';
import { ACTION_FUNCTION_TIMEOUT_MS } from './close-values.js';
import { REFUSAL_REASONS } from './closeability.js';
import { incidentItemKey } from './evidence-record.js';
import { CONFIGURATION_SET_PATTERN } from './lanes.js';
import { SES_ID_PATTERN, expiresAtFor, type RecordKey } from './records.js';

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
export type ClosureLogReason = (typeof CLOSURE_LOG_REASONS)[number];

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
