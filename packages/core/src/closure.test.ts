import { describe, expect, it } from 'vitest';
import {
  ACTION_FUNCTION_TIMEOUT_MS,
  EMAIL_SEND_ATTEMPTS,
  HOLD_CHECK_DELAY_MS,
  HOLD_MS,
  LANE_HOUR_ATTEMPT_CAP,
  RECORD_MAX_AGE_MS,
  REOPEN_FUNCTION_TIMEOUT_MS,
} from './close-values.js';
import {
  CLOSURE_LOG_OUTCOMES,
  CLOSURE_LOG_REASONS,
  PAUSE_MAY_HOLD_OUTCOMES,
  actionCloseabilityRefusal,
  claimStateOf,
  closureClaimItem,
  closureItemSchema,
  freshnessRefusal,
  holdCheckDue,
  holdCheckWindow,
  holdFold,
  parseClosure,
  pauseMayHold,
  pauseOutcomeOf,
  type Closure,
  type FreshnessInput,
  type OtherLaneReading,
} from './closure.js';
import { BUCKET_MS } from './buckets.js';
import { openIncident, type IncidentMarker, type IncidentState } from './incident.js';
import { createLogger } from './log.js';
import type { EventRecord } from './records.js';
import { MAX_WINDOW_BUCKETS, spikeWindowFor } from './window-fold.js';

const INCIDENT_ID = '0123456789abcdef0123456789abcdef';
const CLAIMED_AT_MS = Date.UTC(2026, 9, 11, 12, 3, 0);

function claim(): Closure {
  return closureClaimItem({ incidentId: INCIDENT_ID, configurationSet: 'fothering-bulk', decisionOutcome: 'close', nowMs: CLAIMED_AT_MS });
}

const EMAIL = { kind: 'closed', attempts: 1, claimedAtMs: CLAIMED_AT_MS, sentAtMs: CLAIMED_AT_MS, messageId: 'fixture-message-1', failed: false } as const;

// The spec's own numbers (R2, R3, D-98, AC-E29) and the two timeouts the stacks read: a change to any of
// them is a decision, so it has to change this pin too.
describe('the close values hold the numbers D-97 declares', () => {
  it('pins every value once', () => {
    expect({
      HOLD_MS,
      HOLD_CHECK_DELAY_MS,
      RECORD_MAX_AGE_MS,
      LANE_HOUR_ATTEMPT_CAP,
      EMAIL_SEND_ATTEMPTS,
      ACTION_FUNCTION_TIMEOUT_MS,
      REOPEN_FUNCTION_TIMEOUT_MS,
    }).toEqual({
      HOLD_MS: 60_000,
      HOLD_CHECK_DELAY_MS: 300_000,
      RECORD_MAX_AGE_MS: 3_600_000,
      LANE_HOUR_ATTEMPT_CAP: 4,
      EMAIL_SEND_ATTEMPTS: 3,
      ACTION_FUNCTION_TIMEOUT_MS: 300_000,
      REOPEN_FUNCTION_TIMEOUT_MS: 30_000,
    });
  });
});

describe('closureItemSchema holds codes, set names, integer times and counts only (D-90)', () => {
  it('parses the claim item closureClaimItem builds', () => {
    expect(closureItemSchema.safeParse(claim()).success).toBe(true);
    expect(parseClosure(claim())).toEqual(claim());
  });

  it('rejects an extra key', () => {
    expect(parseClosure({ ...claim(), explanation: 'free text from the model' })).toBeUndefined();
  });

  it.each(['claimedAtMs', 'pauseRequestedAtMs', 'readBackAtMs', 'holdEndMs', 'sendsAfterHold'] as const)('rejects a non-integer %s', (field) => {
    expect(parseClosure({ ...claim(), [field]: CLAIMED_AT_MS + 0.5 })).toBeUndefined();
  });

  it.each([
    ['pk', { pk: 'INCIDENT#ops@example.com' }],
    ['incidentId', { incidentId: 'ops@example.com' }],
    ['configurationSet', { configurationSet: 'ops@example.com' }],
    ['email.messageId', { email: { ...EMAIL, messageId: 'ops@example.com' } }],
    ['lanes.configurationSet', { lanes: [{ configurationSet: 'ops@example.com', state: 'incident-open', configurationRefusals: [] }] }],
  ])('rejects an address in %s', (_field, override) => {
    expect(parseClosure({ ...claim(), ...override })).toBeUndefined();
  });

  it('rejects a partition key that names another incident', () => {
    expect(parseClosure({ ...claim(), pk: `INCIDENT#${'f'.repeat(32)}` })).toBeUndefined();
  });

  it('accepts an email sub-record holding an SES message id', () => {
    expect(parseClosure({ ...claim(), email: EMAIL })?.email?.messageId).toBe('fixture-message-1');
  });
});

describe('pauseOutcomeOf calls a pause paused only from a false read-back (R1)', () => {
  it.each([
    [false, 'paused'],
    [true, 'pause-failed'],
    ['missing', 'pause-unknown'],
    ['threw', 'pause-unknown'],
  ] as const)('maps %s to %s', (readBack, outcome) => {
    expect(pauseOutcomeOf(readBack)).toBe(outcome);
  });
});

describe('claimStateOf follows the action timeout exactly (D-91)', () => {
  const lastInFlightMs = CLAIMED_AT_MS + ACTION_FUNCTION_TIMEOUT_MS - 1;
  const firstStaleMs = CLAIMED_AT_MS + ACTION_FUNCTION_TIMEOUT_MS;

  it('reads a claim in flight up to one millisecond before the timeout and stale at it', () => {
    expect(claimStateOf(claim(), lastInFlightMs)).toBe('in-flight');
    expect(claimStateOf(claim(), firstStaleMs)).toBe('reclaimable');
  });

  it('reads a stale claim with a pause requested as one whose put may have taken', () => {
    const requested = { ...claim(), pauseRequestedAtMs: CLAIMED_AT_MS + 2_000 };
    expect(claimStateOf(requested, lastInFlightMs)).toBe('in-flight');
    expect(claimStateOf(requested, firstStaleMs)).toBe('put-may-have-taken');
  });

  it('reads any closure holding an outcome as finished, however old', () => {
    expect(claimStateOf({ ...claim(), outcome: 'pause-unknown' }, CLAIMED_AT_MS)).toBe('finished');
    expect(claimStateOf({ ...claim(), outcome: 'refused' }, firstStaleMs * 2)).toBe('finished');
  });
});

describe('the logger knows every closure reason and outcome (Pitfall 13)', () => {
  function logged(entry: { reason?: string; outcome?: string }): Record<string, unknown> {
    const lines: string[] = [];
    createLogger((line) => lines.push(line)).info({ event: 'closure-refused', ...entry });
    return JSON.parse(lines[0] ?? '{}') as Record<string, unknown>;
  }

  it('logs every closure log reason as itself', () => {
    const misread = CLOSURE_LOG_REASONS.filter((reason) => logged({ reason }).reason !== reason);
    expect(misread.join(',')).toBe('');
  });

  it('logs every closure log outcome as itself', () => {
    const misread = CLOSURE_LOG_OUTCOMES.filter((outcome) => logged({ outcome }).outcome !== outcome);
    expect(misread.join(',')).toBe('');
  });

  it('logs an outcome outside the vocabulary as unclassified', () => {
    expect(logged({ outcome: 'reopened-by-hand' }).outcome).toBe('unclassified');
  });
});

const RECORD_TO_BUCKET_MS = Date.UTC(2026, 9, 11, 12, 0, 0);
const OPEN_MARKER: IncidentMarker = { incidentId: INCIDENT_ID, status: 'open', version: 1 };
const OPEN_STATE: IncidentState = { ...openIncident('fothering-bulk', RECORD_TO_BUCKET_MS, spikeWindowFor(RECORD_TO_BUCKET_MS)), incidentId: INCIDENT_ID };

function fresh(overrides: Partial<FreshnessInput> = {}): FreshnessInput {
  return { incidentId: INCIDENT_ID, marker: OPEN_MARKER, state: OPEN_STATE, others: [], recordToBucketMs: RECORD_TO_BUCKET_MS, nowMs: RECORD_TO_BUCKET_MS, ...overrides };
}

function openElsewhere(openingToBucketMs: unknown): OtherLaneReading {
  return { kind: 'open', openingToBucketMs };
}

describe('freshnessRefusal passes a record only while it still describes the account (R3, AC-7)', () => {
  it('passes an open marker naming the incident, an open STATE, no newer incident elsewhere and age 0', () => {
    expect(freshnessRefusal(fresh())).toBeUndefined();
    expect(freshnessRefusal(fresh({ others: [{ kind: 'no-open-incident' }, openElsewhere(RECORD_TO_BUCKET_MS - BUCKET_MS)] }))).toBeUndefined();
  });

  it.each([
    ['a closed marker', { marker: { ...OPEN_MARKER, status: 'closed' } }, 'incident-not-open'],
    ['a marker naming another incident', { marker: { ...OPEN_MARKER, incidentId: 'f'.repeat(32) } }, 'incident-not-open'],
    ['a closed STATE', { state: { ...OPEN_STATE, status: 'closed' } }, 'incident-not-open'],
    ['an incident on another lane opened after the record window', { others: [openElsewhere(RECORD_TO_BUCKET_MS + BUCKET_MS)] }, 'newer-incident-elsewhere'],
    ['an age past one spike window', { nowMs: RECORD_TO_BUCKET_MS + RECORD_MAX_AGE_MS + 1 }, 'record-too-old'],
  ] as const)('refuses %s as %s', (_case, override, refusal) => {
    expect(freshnessRefusal(fresh(override))).toBe(refusal);
  });

  it('checks in the rule order: the incident first, then other lanes, then the age', () => {
    const newer = [openElsewhere(RECORD_TO_BUCKET_MS + BUCKET_MS)];
    const old = RECORD_TO_BUCKET_MS + RECORD_MAX_AGE_MS + 1;
    expect(freshnessRefusal(fresh({ marker: undefined, others: newer, nowMs: old }))).toBe('incident-not-open');
    expect(freshnessRefusal(fresh({ others: newer, nowMs: old }))).toBe('newer-incident-elsewhere');
  });

  it('passes an age of exactly one spike window and refuses one millisecond more (AC-E7)', () => {
    expect(freshnessRefusal(fresh({ nowMs: RECORD_TO_BUCKET_MS + 3_600_000 }))).toBeUndefined();
    expect(freshnessRefusal(fresh({ nowMs: RECORD_TO_BUCKET_MS + 3_600_001 }))).toBe('record-too-old');
  });

  it('refuses a missing marker or a missing STATE and passes a lane map with no other lane (AC-E8)', () => {
    expect(freshnessRefusal(fresh({ marker: undefined }))).toBe('incident-not-open');
    expect(freshnessRefusal(fresh({ state: undefined }))).toBe('incident-not-open');
    expect(freshnessRefusal(fresh({ others: [] }))).toBeUndefined();
  });

  it.each([
    ['upper-cased', INCIDENT_ID.toUpperCase()],
    ['with a trailing space', `${INCIDENT_ID} `],
  ])('compares the marker incident id byte for byte, refusing one %s (AC-E9)', (_case, incidentId) => {
    expect(freshnessRefusal(fresh({ marker: { ...OPEN_MARKER, incidentId } }))).toBe('incident-not-open');
  });

  it.each([
    ['missing', undefined],
    ['a fraction', 1.5],
    ['a string', '1700000000000'],
    ['NaN', Number.NaN],
  ])('refuses another open lane whose opening window end is %s (AC-E10)', (_case, openingToBucketMs) => {
    expect(freshnessRefusal(fresh({ others: [openElsewhere(openingToBucketMs)] }))).toBe('newer-incident-elsewhere');
  });

  it('refuses when another lane could not be read (AC-E10)', () => {
    expect(freshnessRefusal(fresh({ others: [{ kind: 'unreadable' }] }))).toBe('newer-incident-elsewhere');
  });

  it('passes another lane opened in the same cycle and refuses one opened a millisecond later (AC-E11)', () => {
    expect(freshnessRefusal(fresh({ others: [openElsewhere(RECORD_TO_BUCKET_MS)] }))).toBeUndefined();
    expect(freshnessRefusal(fresh({ others: [openElsewhere(RECORD_TO_BUCKET_MS + 1)] }))).toBe('newer-incident-elsewhere');
  });
});

// actionGate already refuses a record whose closeability is not closeable (decision-differs), so the
// record half is pinned here, where it can be reached.
describe('actionCloseabilityRefusal checks the record before the configuration read in this act (D-102)', () => {
  it.each(['refused', 'no-data'] as const)('refuses a record whose closeability is %s as record-not-closeable, whatever the configuration says', (state) => {
    expect(actionCloseabilityRefusal(state, { configurationRefusals: [] })).toBe('record-not-closeable');
    expect(actionCloseabilityRefusal(state, { configurationRefusals: ['transactional'] })).toBe('record-not-closeable');
  });

  it('refuses a closeable record whose target lane holds any configuration code', () => {
    expect(actionCloseabilityRefusal('closeable', { configurationRefusals: ['default-configuration-set'] })).toBe('configuration-not-closeable');
  });

  it('refuses a closeable record whose target lane has no entry, failing closed', () => {
    expect(actionCloseabilityRefusal('closeable', undefined)).toBe('configuration-not-closeable');
  });

  it('passes a closeable record whose target lane holds no code', () => {
    expect(actionCloseabilityRefusal('closeable', { configurationRefusals: [] })).toBeUndefined();
  });
});

const HOLD_END_MS = CLAIMED_AT_MS + 2_000 + HOLD_MS;

function pausedClosure(overrides: Partial<Closure> = {}): Closure {
  return { ...claim(), outcome: 'paused', pauseRequestedAtMs: HOLD_END_MS - HOLD_MS, readBack: false, readBackAtMs: CLAIMED_AT_MS + 4_000, holdEndMs: HOLD_END_MS, ...overrides };
}

const REOPENED = { attempts: 1, claimedAtMs: HOLD_END_MS, requestedAtMs: HOLD_END_MS + 1_000, readBackAtMs: HOLD_END_MS + 2_000, outcome: 'reopened' } as const;

describe('holdCheckDue waits HOLD_CHECK_DELAY_MS past the hold end and skips a reopened pause (R2, D-94)', () => {
  it('is false one millisecond before the delay has passed and true at it (AC-5)', () => {
    expect(holdCheckDue(pausedClosure(), HOLD_END_MS + HOLD_CHECK_DELAY_MS - 1)).toBe(false);
    expect(holdCheckDue(pausedClosure(), HOLD_END_MS + HOLD_CHECK_DELAY_MS)).toBe(true);
  });

  it.each(['closed', 'not-holding', 'pause-unknown', 'pause-failed', 'refused', 'dry-run'] as const)('is false for a closure whose outcome is %s', (outcome) => {
    expect(holdCheckDue(pausedClosure({ outcome }), HOLD_END_MS + HOLD_CHECK_DELAY_MS)).toBe(false);
  });

  it('is false for a paused closure the operator reopened', () => {
    expect(holdCheckDue(pausedClosure({ reopen: REOPENED }), HOLD_END_MS + HOLD_CHECK_DELAY_MS)).toBe(false);
  });
});

describe('holdCheckWindow reads from the hold end to now, at most MAX_WINDOW_BUCKETS buckets (D-100)', () => {
  const fromBucketMs = Math.floor(HOLD_END_MS / BUCKET_MS) * BUCKET_MS;

  it('reads every bucket of a gap of MAX_WINDOW_BUCKETS buckets, checked through now', () => {
    const nowMs = fromBucketMs + (MAX_WINDOW_BUCKETS - 1) * BUCKET_MS + 7;
    expect(holdCheckWindow(HOLD_END_MS, nowMs)).toEqual({ fromBucketMs, toBucketMs: nowMs - 7, checkedThroughMs: nowMs });
  });

  it('clamps a gap one bucket longer and is checked through the last millisecond of the last bucket read', () => {
    const lastReadMs = fromBucketMs + (MAX_WINDOW_BUCKETS - 1) * BUCKET_MS;
    const window = holdCheckWindow(HOLD_END_MS, lastReadMs + BUCKET_MS + 7);
    expect(window).toEqual({ fromBucketMs, toBucketMs: lastReadMs, checkedThroughMs: lastReadMs + BUCKET_MS - 1 });
    expect((window.toBucketMs - window.fromBucketMs) / BUCKET_MS + 1).toBe(MAX_WINDOW_BUCKETS);
  });
});

function eventAt(eventType: 'Send' | 'Delivery', mailTimestampMs: number): EventRecord {
  const bucketStartMs = Math.floor(mailTimestampMs / BUCKET_MS) * BUCKET_MS;
  return {
    pk: 'LANE#fothering-bulk',
    sk: `B#${String(bucketStartMs).padStart(13, '0')}#${eventType}#m-${mailTimestampMs}`,
    kind: eventType === 'Send' ? 'send' : 'outcome',
    eventType,
    configurationSet: 'fothering-bulk',
    bucketStartMs,
    mailTimestampMs,
    envelopeTimeMs: mailTimestampMs,
    arrivalTimeMs: mailTimestampMs,
    messageId: `m-${mailTimestampMs}`,
    provenance: 'generated',
    expiresAt: 0,
    fields: {},
  };
}

function folded(records: readonly EventRecord[], pages = 1): number {
  const fold = holdFold(HOLD_END_MS);
  let state = fold.initial;
  const size = Math.ceil(records.length / pages);
  for (let start = 0; start < records.length; start += size) state = fold.step(state, records.slice(start, start + size));
  return state;
}

describe('holdFold counts Send records accepted at or after the hold end (R2, Pitfall 5)', () => {
  it('counts a Send record at the hold end exactly (AC-E3) and not one a millisecond before', () => {
    expect(folded([eventAt('Send', HOLD_END_MS)])).toBe(1);
    expect(folded([eventAt('Send', HOLD_END_MS - 1)])).toBe(0);
  });

  it('never counts a Delivery record, whatever its time', () => {
    expect(folded([eventAt('Delivery', HOLD_END_MS), eventAt('Delivery', HOLD_END_MS + 60_000)])).toBe(0);
  });

  it('adds across pages', () => {
    const records = [eventAt('Send', HOLD_END_MS + 1), eventAt('Send', HOLD_END_MS - 5), eventAt('Send', HOLD_END_MS + 9), eventAt('Send', HOLD_END_MS + 30)];
    expect(folded(records, 2)).toBe(3);
  });
});

describe('pauseMayHold says whether a closure a pause pointer names may still hold its lane (D-95)', () => {
  const nowMs = CLAIMED_AT_MS + 1_000;
  const staleMs = CLAIMED_AT_MS + ACTION_FUNCTION_TIMEOUT_MS;

  it.each([
    ['paused', true],
    ['closed', true],
    ['not-holding', true],
    ['pause-unknown', true],
    ['pause-failed', false],
    ['refused', false],
    ['dry-run', false],
  ] as const)('reads %s as %s', (outcome, holds) => {
    expect(pauseMayHold(pausedClosure({ outcome }), nowMs)).toBe(holds);
  });

  it.each(['paused', 'closed', 'not-holding', 'pause-unknown'] as const)('reads a reopened %s closure as not holding', (outcome) => {
    expect(pauseMayHold(pausedClosure({ outcome, reopen: REOPENED }), nowMs)).toBe(false);
  });

  it('keeps holding when the reopen did not end reopened', () => {
    expect(pauseMayHold(pausedClosure({ reopen: { ...REOPENED, outcome: 'reopen-failed' } }), nowMs)).toBe(true);
  });

  it('reads a claim in flight, and a stale claim whose pause was requested, as holding', () => {
    expect(pauseMayHold(claim(), nowMs)).toBe(true);
    expect(pauseMayHold({ ...claim(), pauseRequestedAtMs: CLAIMED_AT_MS + 2_000 }, staleMs)).toBe(true);
  });

  it('reads a stale claim with no pause requested as not holding', () => {
    expect(pauseMayHold(claim(), staleMs)).toBe(false);
  });

  it('reads a missing or unreadable closure as holding, failing closed', () => {
    expect(pauseMayHold(undefined, nowMs)).toBe(true);
  });

  it('lists exactly the outcomes whose pause may hold', () => {
    expect([...PAUSE_MAY_HOLD_OUTCOMES]).toEqual(['paused', 'closed', 'not-holding', 'pause-unknown']);
  });
});
