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
  claimStateOf,
  closureClaimItem,
  closureItemSchema,
  freshnessRefusal,
  parseClosure,
  pauseOutcomeOf,
  type Closure,
  type FreshnessInput,
  type OtherLaneReading,
} from './closure.js';
import { BUCKET_MS } from './buckets.js';
import { openIncident, type IncidentMarker, type IncidentState } from './incident.js';
import { createLogger } from './log.js';
import { spikeWindowFor } from './window-fold.js';

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
