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
  parseClosure,
  pauseOutcomeOf,
  type Closure,
} from './closure.js';
import { createLogger } from './log.js';

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
