import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { LATENESS_HORIZON_MS } from './buckets.js';
import { REOPEN_FUNCTION_TIMEOUT_MS } from './close-values.js';
import { CLOSURE_OUTCOMES, REOPEN_REFUSALS, REOPEN_RESULTS, closureClaimItem, type Closure } from './closure.js';
import {
  FIND_REOPEN_FUNCTION_COMMAND,
  REOPEN_COMMAND_TEMPLATE,
  REOPEN_FUNCTION_NAME_SLOT,
  REOPEN_USAGE,
  incidentLimitSentence,
  reopenAcceptance,
  reopenCommandFor,
  reputationResetSentence,
} from './reopen.js';

const REOPEN_DOC_URL = new URL('../../../docs/reopen-a-lane.md', import.meta.url);

// Read with LF line ends whatever the checkout wrote, so the comparison is about the text alone. A
// missing document reads empty, so each case below fails on its own assertion rather than at load.
const REOPEN_DOC = existsSync(REOPEN_DOC_URL) ? readFileSync(REOPEN_DOC_URL, 'utf8').replace(/\r\n/g, '\n') : '';

function fencedBlocks(text: string, language: string): string[] {
  return [...text.matchAll(new RegExp('```' + language + '\\n([\\s\\S]*?)\\n```', 'g'))].map((match) => match[1] ?? '');
}

function sectionOf(text: string, heading: string): string {
  const start = text.indexOf(`\n${heading}\n`);
  if (start === -1) throw new Error(`the document has no ${heading} heading`);
  const rest = text.slice(start + heading.length + 2);
  const next = rest.search(/^## /m);
  return next === -1 ? rest : rest.slice(0, next);
}

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

describe('docs/reopen-a-lane.md prints the command text the code holds (AC-17)', () => {
  it('holds the invoke command for fothering-bulk exactly as reopenCommandFor writes it', () => {
    const invoke = fencedBlocks(REOPEN_DOC, 'sh').find((block) => block.includes('aws lambda invoke'));

    expect(invoke).toBe(reopenCommandFor(BULK));
  });

  it('holds the stack output lookup exactly as FIND_REOPEN_FUNCTION_COMMAND writes it', () => {
    const lookup = fencedBlocks(REOPEN_DOC, 'sh').find((block) => block.includes('describe-stacks'));

    expect(lookup).toBe(FIND_REOPEN_FUNCTION_COMMAND);
    expect(REOPEN_DOC).toContain('ReopenFunctionName');
    expect(REOPEN_DOC).toContain('--cli-read-timeout 60');
  });

  it('prints the usage message in a text block', () => {
    expect(fencedBlocks(REOPEN_DOC, 'text')).toContain(REOPEN_USAGE);
  });

  it('names every result and every refusal code', () => {
    for (const code of [...REOPEN_RESULTS, ...REOPEN_REFUSALS]) expect(REOPEN_DOC).toContain(`\`${code}\``);
  });

  it('states the incident limit for fothering-bulk on one unwrapped line under What this does not cover', () => {
    const lines = sectionOf(REOPEN_DOC, '## What this does not cover').split('\n');

    expect(lines).toContain(incidentLimitSentence(BULK));
  });

  it('holds no example.com address', () => {
    expect(REOPEN_DOC).not.toContain('example.com');
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
