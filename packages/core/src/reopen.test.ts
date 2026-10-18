import { describe, expect, it } from 'vitest';
import { LATENESS_HORIZON_MS } from './buckets.js';
import { REOPEN_FUNCTION_TIMEOUT_MS } from './close-values.js';
import { CLOSURE_OUTCOMES, closureClaimItem, type Closure } from './closure.js';
import {
  REOPEN_COMMAND_TEMPLATE,
  REOPEN_FUNCTION_NAME_SLOT,
  incidentLimitSentence,
  reopenAcceptance,
  reopenCommandFor,
  reputationResetSentence,
} from './reopen.js';

const BULK = 'fothering-bulk';
const INCIDENT_ID = 'a'.repeat(32);
const NOW_MS = Date.UTC(2026, 9, 11, 12, 30, 0);

function closureWith(outcome: Closure['outcome'], reopen: Closure['reopen'] = null): Closure {
  return { ...closureClaimItem({ incidentId: INCIDENT_ID, configurationSet: BULK, decisionOutcome: 'close', nowMs: NOW_MS - 600_000 }), outcome, reopen };
}

function reopenOf(outcome: NonNullable<Closure['reopen']>['outcome'], claimedAtMs: number | null = NOW_MS - 100_000): NonNullable<Closure['reopen']> {
  return { attempts: 1, claimedAtMs, requestedAtMs: null, readBackAtMs: null, outcome };
}

describe('the reopen command text lives once (D-118)', () => {
  it('holds exactly one set slot and fills it with the set name', () => {
    expect(REOPEN_COMMAND_TEMPLATE.split('{set}')).toHaveLength(2);
    expect(reopenCommandFor(BULK)).toContain(`--payload '{"configurationSet":"fothering-bulk"}'`);
    expect(reopenCommandFor(BULK)).not.toContain('{set}');
  });

  it('is seven lines, the first unindented and each one after it indented two spaces under a backslash continuation', () => {
    const lines = reopenCommandFor(BULK).split('\n');

    expect(lines).toEqual([
      'aws lambda invoke \\',
      '  --region eu-central-1 \\',
      `  --function-name ${REOPEN_FUNCTION_NAME_SLOT} \\`,
      '  --cli-binary-format raw-in-base64-out \\',
      '  --cli-read-timeout 60 \\',
      `  --payload '{"configurationSet":"fothering-bulk"}' \\`,
      '  result.json',
    ]);
    expect(REOPEN_FUNCTION_NAME_SLOT).toBe('<ReopenFunctionName stack output>');
  });

  it('waits longer than the function timeout plus a 10 s cold start before the CLI gives up', () => {
    const readTimeoutSeconds = Number(/--cli-read-timeout (\d+)/.exec(REOPEN_COMMAND_TEMPLATE)?.[1]);

    expect(readTimeoutSeconds * 1000).toBeGreaterThan(REOPEN_FUNCTION_TIMEOUT_MS + 10_000);
  });

  it('refuses a set name outside the configuration-set pattern', () => {
    expect(() => reopenCommandFor('bulk lane')).toThrow(RangeError);
    expect(() => reopenCommandFor('a;b')).toThrow(RangeError);
  });
});

describe('every reopen output carries two fixed sentences with the set name their only slot', () => {
  it('says the set reputation history starts again (D-112)', () => {
    expect(reputationResetSentence(BULK)).toBe('Reopening a configuration set resets its SES reputation metrics, so the history SES keeps for fothering-bulk starts again.');
  });

  it('computes the incident limit from LATENESS_HORIZON_MS as 14 whole hours', () => {
    expect(LATENESS_HORIZON_MS / 3_600_000).toBe(14);
    expect(Number.isInteger(LATENESS_HORIZON_MS / 3_600_000)).toBe(true);
  });

  it('states the incident limit in full, with the set at all three slots', () => {
    expect(incidentLimitSentence(BULK)).toBe(
      'Fothering pauses a lane at most once per incident, and an incident stays open while fothering-bulk keeps spiking and for at least 14 hours after it goes quiet, since SES can still report bounces from deliveries it retried for that long. If you reopen fothering-bulk inside that time and it spikes again, Fothering makes no new evidence record or decision, does not pause it again and sends no new email, so watch fothering-bulk yourself until then.',
    );
  });

  it('keeps both sentences printable ASCII and never says closed', () => {
    for (const sentence of [incidentLimitSentence(BULK), reputationResetSentence(BULK)]) {
      expect(sentence).toMatch(/^[\x20-\x7e]+$/);
      expect(sentence).not.toMatch(/\bclosed\b/i);
    }
  });
});

describe('reopenAcceptance takes a pause Fothering may still hold and a reopen that has not taken (D-93)', () => {
  it.each([
    ['paused', 'accept'],
    ['closed', 'accept'],
    ['not-holding', 'accept'],
    ['pause-unknown', 'accept'],
    ['refused', 'not-reopenable'],
    ['dry-run', 'not-reopenable'],
    ['pause-failed', 'not-reopenable'],
  ] as const)('answers %s with %s while nothing reopened it', (outcome, expected) => {
    expect(reopenAcceptance(closureWith(outcome), NOW_MS)).toBe(expected);
  });

  it('covers every closure outcome in the table above', () => {
    expect([...CLOSURE_OUTCOMES].sort()).toEqual(['closed', 'dry-run', 'not-holding', 'pause-failed', 'pause-unknown', 'paused', 'refused']);
  });

  it('refuses a claim with no outcome yet as not-reopenable', () => {
    expect(reopenAcceptance(closureWith(null), NOW_MS)).toBe('not-reopenable');
  });

  it('refuses a closure already reopened, whatever its pause outcome', () => {
    for (const outcome of ['paused', 'closed', 'not-holding', 'pause-unknown'] as const) {
      expect(reopenAcceptance(closureWith(outcome, reopenOf('reopened')), NOW_MS)).toBe('already-reopened');
    }
  });

  it('accepts again after reopen-failed and reopen-unknown, so the operator can rerun the command', () => {
    expect(reopenAcceptance(closureWith('closed', reopenOf('reopen-failed')), NOW_MS)).toBe('accept');
    expect(reopenAcceptance(closureWith('closed', reopenOf('reopen-unknown')), NOW_MS)).toBe('accept');
  });

  it('answers reopen-in-progress for a claim younger than the reopen timeout and accepts it once stale', () => {
    const claimedAtMs = NOW_MS - REOPEN_FUNCTION_TIMEOUT_MS;

    expect(reopenAcceptance(closureWith('closed', reopenOf(null, claimedAtMs + 1)), NOW_MS)).toBe('reopen-in-progress');
    expect(reopenAcceptance(closureWith('closed', reopenOf(null, claimedAtMs)), NOW_MS)).toBe('accept');
  });
});
