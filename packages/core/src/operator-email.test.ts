import { describe, expect, it } from 'vitest';
import { HOLD_CHECK_DELAY_MS, HOLD_MS } from './close-values.js';
import { CLOSURE_OUTCOMES, closureClaimItem, type Closure, type StoredDecision } from './closure.js';
import { AUTOMATED_SENDER_FOOTER } from './disclosure.js';
import { parseLaneMap } from './lanes.js';
import {
  ACCOUNT_PAUSE_LIMIT_SENTENCE,
  PAUSED_APP_SENTENCE,
  SECTION_HEADINGS,
  emailKindOf,
  isoOf,
  renderOperatorEmail,
  type RenderedEmail,
} from './operator-email.js';
import { incidentLimitSentence, reopenCommandFor, reputationResetSentence } from './reopen.js';
import { fixtureEvidenceRecord } from './test/decision-cycle.js';
import lanesJson from '../../../lanes.json' with { type: 'json' };

const LANE_MAP = parseLaneMap(lanesJson);
const RECORD = fixtureEvidenceRecord();
const SET = RECORD.lane.configurationSet;
const OPTION_ID = RECORD.approvedOptions[0]?.optionId ?? 'no-option';
const PAUSE_MS = RECORD.window.toBucketMs + 180_000;
const HOLD_END_MS = PAUSE_MS + HOLD_MS;
const HOLD_CHECKED_MS = HOLD_END_MS + HOLD_CHECK_DELAY_MS;

const LANES: Closure['lanes'] = [
  { configurationSet: 'fothering-transactional', state: 'no-open-incident', configurationRefusals: ['transactional'] },
  { configurationSet: SET, state: 'incident-open', configurationRefusals: [] },
  { configurationSet: 'fothering-alerts', state: 'no-open-incident', configurationRefusals: ['operator-alert', 'transactional'] },
];

const CLOSE_DECISION: StoredDecision = { outcome: 'close', optionId: OPTION_ID };

function closedClosure(): Closure {
  return {
    ...closureClaimItem({ incidentId: RECORD.incidentId, configurationSet: SET, decisionOutcome: 'close', nowMs: PAUSE_MS - 1_000 }),
    outcome: 'closed',
    pauseRequestedAtMs: PAUSE_MS,
    readBackAtMs: PAUSE_MS + 2_000,
    readBack: false,
    holdEndMs: HOLD_END_MS,
    holdCheckedAtMs: HOLD_CHECKED_MS,
    holdCheckedThroughMs: HOLD_CHECKED_MS,
    sendsAfterHold: 0,
    sesFacts: 'read',
    lanes: LANES,
    version: 4,
  };
}

function renderedClosed(): RenderedEmail | undefined {
  return renderOperatorEmail({ closure: closedClosure(), record: RECORD, decision: CLOSE_DECISION, laneMap: LANE_MAP });
}

function sectionText(email: RenderedEmail | undefined, heading: string): string {
  return email?.sections.find((section) => section.heading === heading)?.lines.join('\n') ?? '';
}

describe('emailKindOf picks the email by the closure outcome (D-109)', () => {
  it.each([
    ['closed', 'closed'],
    ['not-holding', 'not-confirmed'],
    ['pause-unknown', 'not-confirmed'],
    ['pause-failed', 'not-confirmed'],
    ['refused', 'unknown'],
    ['paused', undefined],
    ['dry-run', undefined],
  ] as const)('maps %s to %s', (outcome, kind) => {
    expect(emailKindOf(outcome)).toBe(kind);
  });

  it('sends nothing for a claim with no outcome yet, and covers every closure outcome', () => {
    expect(emailKindOf(null)).toBeUndefined();
    expect(CLOSURE_OUTCOMES).toHaveLength(7);
  });
});

describe('isoOf is the one time formatter (D-113)', () => {
  it('prints a time an epoch field can be read back from exactly', () => {
    expect(Date.parse(isoOf(PAUSE_MS + 7))).toBe(PAUSE_MS + 7);
  });
});

describe('a closed lane renders the closed-path email (R9)', () => {
  it('fills only the set name into the closed subject', () => {
    expect(renderedClosed()?.subject).toBe(`[Fothering] ${SET} closed: sending paused and holding`);
  });

  it('gives the closed path its sections in order, the footer last', () => {
    const email = renderedClosed();
    expect(email?.kind).toBe('closed');
    expect(email?.sections.map((section) => section.heading)).toEqual([
      SECTION_HEADINGS.happened,
      SECTION_HEADINGS.saw,
      SECTION_HEADINGS.open,
      SECTION_HEADINGS.app,
      SECTION_HEADINGS.reopen,
      SECTION_HEADINGS.limits,
      SECTION_HEADINGS.reference,
    ]);
    expect(email?.text.trimEnd().split('\n').at(-1)).toBe(AUTOMATED_SENDER_FOOTER);
  });

  it('states the hold check as what was seen, never as what is possible (AC-E4)', () => {
    const happened = sectionText(renderedClosed(), SECTION_HEADINGS.happened);
    expect(happened).toContain(`no send was seen accepted on ${SET} from ${isoOf(HOLD_END_MS)} through ${isoOf(HOLD_CHECKED_MS)}`);
    expect(renderedClosed()?.text).not.toMatch(/no send is possible/i);
  });

  it('names the paused set in what happened and lists every other lane once in what stays open (AC-E25)', () => {
    const email = renderedClosed();
    const open = sectionText(email, SECTION_HEADINGS.open);
    expect(sectionText(email, SECTION_HEADINGS.happened)).toContain(SET);
    expect(open).not.toContain(SET);
    expect(open.split('fothering-transactional')).toHaveLength(2);
    expect(open.split('fothering-alerts')).toHaveLength(2);
  });

  it('gives the reopen command, the reputation sentence and then the incident limit once (AC-16, incident limit)', () => {
    const reopen = sectionText(renderedClosed(), SECTION_HEADINGS.reopen);
    expect(reopen).toContain(reopenCommandFor(SET));
    expect(reopen.split(incidentLimitSentence(SET))).toHaveLength(2);
    expect(reopen.indexOf(reputationResetSentence(SET))).toBeGreaterThan(-1);
    expect(reopen.indexOf(incidentLimitSentence(SET))).toBeGreaterThan(reopen.indexOf(reputationResetSentence(SET)));
  });

  it('carries the paused-app and account-limit sentences in their own sections', () => {
    const email = renderedClosed();
    expect(sectionText(email, SECTION_HEADINGS.app)).toBe(PAUSED_APP_SENTENCE);
    expect(sectionText(email, SECTION_HEADINGS.limits)).toBe(ACCOUNT_PAUSE_LIMIT_SENTENCE);
  });

  it('puts the incident id, the record hash and the option id in the reference', () => {
    const reference = sectionText(renderedClosed(), SECTION_HEADINGS.reference);
    for (const id of [RECORD.incidentId, RECORD.hash, OPTION_ID]) expect(reference).toContain(id);
  });
});
