import { describe, expect, it } from 'vitest';
import { HOLD_CHECK_DELAY_MS, HOLD_MS } from './close-values.js';
import { LANE_MAP_REFUSALS, SES_CONFIGURATION_REFUSALS } from './closeability.js';
import { ACTION_REFUSALS, CLOSURE_OUTCOMES, closureClaimItem, type ActionRefusal, type Closure, type StoredDecision } from './closure.js';
import { AUTOMATED_SENDER_FOOTER, MODEL_PARAGRAPH_LABEL, MODEL_TEXT_MARKER_HEADER } from './disclosure.js';
import { buildEvidenceRecord, type EvidenceRecord } from './evidence-record.js';
import { parseLaneMap } from './lanes.js';
import {
  ACCOUNT_PAUSE_LIMIT_SENTENCE,
  PAUSED_APP_SENTENCE,
  REASON_SENTENCES,
  SECTION_HEADINGS,
  emailKindOf,
  isoOf,
  modelParagraphOf,
  renderOperatorEmail,
  type RenderInput,
  type RenderedEmail,
} from './operator-email.js';
import { FIND_REOPEN_FUNCTION_COMMAND, incidentLimitSentence, reopenCommandFor, reputationResetSentence } from './reopen.js';
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

const AGENT_UNKNOWN: StoredDecision = { outcome: 'unknown', explanation: 'The evidence on this lane does not settle one cause, so the operator is asked what to do.' };
const CAP_REACHED: StoredDecision = { outcome: 'unknown', reason: 'cap-reached' };
const QUESTION = 'Two lanes spiked in the same window, fothering-bulk and fothering-transactional. Which of them should be paused?';
const FIX_TEXT = 'Publish the DKIM records SES gives for news.example.com.';

function recordInputOf(record: EvidenceRecord): Omit<EvidenceRecord, 'schemaVersion' | 'approvedOptions' | 'hash'> {
  const input: Partial<EvidenceRecord> = { ...record };
  delete input.schemaVersion;
  delete input.approvedOptions;
  delete input.hash;
  return input as Omit<EvidenceRecord, 'schemaVersion' | 'approvedOptions' | 'hash'>;
}

const ASKING_RECORD = buildEvidenceRecord({ ...recordInputOf(RECORD), question: QUESTION, fix: { kind: 'missing-dkim', text: FIX_TEXT } });

function closureWith(overrides: Partial<Closure>): Closure {
  return { ...closedClosure(), ...overrides };
}

const NOT_HOLDING = closureWith({ outcome: 'not-holding', sendsAfterHold: 2 });
const PAUSE_UNKNOWN = closureWith({ outcome: 'pause-unknown', readBack: 'threw', holdEndMs: null, holdCheckedAtMs: null, holdCheckedThroughMs: null, sendsAfterHold: null });
const PAUSE_UNKNOWN_STALE = closureWith({ ...PAUSE_UNKNOWN, readBack: null, readBackAtMs: null });
const PAUSE_UNKNOWN_MISSING = closureWith({ ...PAUSE_UNKNOWN, readBack: 'missing' });
const PAUSE_FAILED = closureWith({ ...PAUSE_UNKNOWN, outcome: 'pause-failed', readBack: true });
const PUT_FAILED = closureWith({ ...PAUSE_UNKNOWN, outcome: 'pause-failed', readBack: null, readBackAtMs: null });

function refusedClosure(reason: ActionRefusal): Closure {
  return closureWith({
    outcome: 'refused',
    reason,
    pauseRequestedAtMs: null,
    readBackAtMs: null,
    readBack: null,
    holdEndMs: null,
    holdCheckedAtMs: null,
    holdCheckedThroughMs: null,
    sendsAfterHold: null,
  });
}

function render(closure: Closure, decision: StoredDecision | undefined = CLOSE_DECISION, record: EvidenceRecord | undefined = RECORD): RenderedEmail | undefined {
  return renderOperatorEmail({ closure, record, decision, laneMap: LANE_MAP });
}

interface Rendering {
  name: string;
  input: RenderInput;
}

const CONFIRMING: readonly Rendering[] = [
  { name: 'closed', input: { closure: closedClosure(), record: RECORD, decision: CLOSE_DECISION, laneMap: LANE_MAP } },
  { name: 'not-holding', input: { closure: NOT_HOLDING, record: RECORD, decision: CLOSE_DECISION, laneMap: LANE_MAP } },
  { name: 'pause-unknown (read-back threw)', input: { closure: PAUSE_UNKNOWN, record: RECORD, decision: CLOSE_DECISION, laneMap: LANE_MAP } },
  { name: 'pause-unknown (no sending state)', input: { closure: PAUSE_UNKNOWN_MISSING, record: RECORD, decision: CLOSE_DECISION, laneMap: LANE_MAP } },
  { name: 'pause-unknown (stale claim)', input: { closure: PAUSE_UNKNOWN_STALE, record: RECORD, decision: CLOSE_DECISION, laneMap: LANE_MAP } },
  { name: 'pause-failed (read back true)', input: { closure: PAUSE_FAILED, record: RECORD, decision: CLOSE_DECISION, laneMap: LANE_MAP } },
  { name: 'pause-failed (put threw)', input: { closure: PUT_FAILED, record: RECORD, decision: CLOSE_DECISION, laneMap: LANE_MAP } },
];

const UNKNOWN_PATH: readonly Rendering[] = [
  { name: 'agent unknown', input: { closure: refusedClosure('no-close'), record: ASKING_RECORD, decision: AGENT_UNKNOWN, laneMap: LANE_MAP } },
  { name: 'cap-reached', input: { closure: refusedClosure('no-close'), record: RECORD, decision: CAP_REACHED, laneMap: LANE_MAP } },
  { name: 'record-missing with no record', input: { closure: refusedClosure('record-missing'), record: undefined, decision: CLOSE_DECISION, laneMap: LANE_MAP } },
  ...ACTION_REFUSALS.filter((code) => code !== 'no-close').map((code) => ({
    name: code,
    input: { closure: refusedClosure(code), record: ASKING_RECORD, decision: CLOSE_DECISION, laneMap: LANE_MAP },
  })),
];

const EVERY_RENDERING = [...CONFIRMING, ...UNKNOWN_PATH];

function textOf(rendering: Rendering): string {
  return renderOperatorEmail(rendering.input)?.text ?? '';
}

const CLOSED_WORD = /\bclosed\b/i;
const REOPEN_PARTS = ['aws lambda invoke', FIND_REOPEN_FUNCTION_COMMAND];

describe('REASON_SENTENCES gives every refusal and decision code one plain sentence (D-112)', () => {
  it('holds exactly the action refusals, cap-reached and the configuration refusals', () => {
    const expected = new Set<string>([...ACTION_REFUSALS, 'cap-reached', ...LANE_MAP_REFUSALS, ...SES_CONFIGURATION_REFUSALS]);
    expect(Object.keys(REASON_SENTENCES).sort()).toEqual([...expected].sort());
  });

  it('writes each as one sentence that never says closed or calls a ratio the account rate', () => {
    for (const sentence of Object.values(REASON_SENTENCES)) {
      expect(sentence.match(/[.?!](\s|$)/g)).toHaveLength(1);
      expect(sentence).not.toMatch(CLOSED_WORD);
      expect(sentence).not.toMatch(/bounce rate|complaint rate/i);
    }
  });
});

describe('a pause that is not confirmed renders the not-confirmed path (R9)', () => {
  it.each([
    ['not-holding', NOT_HOLDING, `[Fothering] ${SET} paused, but a send was accepted after the hold`],
    ['pause-unknown', PAUSE_UNKNOWN, `[Fothering] ${SET}: pause requested, result unknown`],
    ['pause-failed', PAUSE_FAILED, `[Fothering] ${SET}: the pause did not take`],
  ] as const)('gives %s its own subject and kind not-confirmed', (_name, closure, subject) => {
    const email = render(closure);
    expect(email?.kind).toBe('not-confirmed');
    expect(email?.subject).toBe(subject);
  });

  it('gives the count of Send records seen after the hold for not-holding', () => {
    const happened = sectionText(render(NOT_HOLDING), SECTION_HEADINGS.happened);
    expect(happened).toContain(`Send records seen accepted on ${SET} from ${isoOf(HOLD_END_MS)} through ${isoOf(HOLD_CHECKED_MS)}: 2.`);
  });

  it('says what was requested and that the read-back could not confirm it for pause-unknown', () => {
    const happened = sectionText(render(PAUSE_UNKNOWN), SECTION_HEADINGS.happened);
    expect(happened).toContain(`Fothering requested a pause of ${SET} at ${isoOf(PAUSE_MS)}.`);
    expect(happened).toContain('cannot confirm the pause took');
  });

  it('says the pause did not take for pause-failed', () => {
    expect(sectionText(render(PAUSE_FAILED), SECTION_HEADINGS.happened)).toContain('the pause did not take');
    expect(sectionText(render(PUT_FAILED), SECTION_HEADINGS.happened)).toContain('the pause did not take');
  });

  it('gives the reopen command and the incident limit once for not-holding and pause-unknown, and neither for pause-failed', () => {
    for (const closure of [NOT_HOLDING, PAUSE_UNKNOWN]) {
      const text = render(closure)?.text ?? '';
      expect(text).toContain(reopenCommandFor(SET));
      expect(text.split(reputationResetSentence(SET))).toHaveLength(2);
      expect(text.split(incidentLimitSentence(SET))).toHaveLength(2);
    }
    for (const closure of [PAUSE_FAILED, PUT_FAILED]) {
      const text = render(closure)?.text ?? '';
      expect(REOPEN_PARTS.filter((part) => text.includes(part))).toEqual([]);
      expect(text).not.toContain(incidentLimitSentence(SET));
      expect(text).not.toContain(reputationResetSentence(SET));
    }
  });

  it('never says closed on any not-confirmed rendering', () => {
    for (const rendering of CONFIRMING.filter((entry) => entry.name !== 'closed')) expect(textOf(rendering)).not.toMatch(CLOSED_WORD);
  });
});

describe('an incident where nothing was paused renders the unknown path (R10)', () => {
  it.each(UNKNOWN_PATH.map((rendering) => [rendering.name, rendering] as const))('%s says nothing was paused, gives no reopen command and never says closed (AC-22)', (_name, rendering) => {
    const email = renderOperatorEmail(rendering.input);
    expect(email?.kind).toBe('unknown');
    expect(email?.subject).toBe(`[Fothering] Spike on ${SET}: nothing was paused`);
    const text = email?.text ?? '';
    expect(text).toContain('Nothing was paused.');
    expect(REOPEN_PARTS.filter((part) => text.includes(part))).toEqual([]);
    expect(text).not.toContain(incidentLimitSentence(SET));
    expect(text).not.toMatch(CLOSED_WORD);
  });

  it('names its reason in plain words, telling a cap-reached DECISION from an agent unknown (D-92)', () => {
    for (const rendering of UNKNOWN_PATH) {
      const code = rendering.input.decision?.reason ?? rendering.input.closure.reason ?? 'no-close';
      expect(sectionText(renderOperatorEmail(rendering.input), SECTION_HEADINGS.happened)).toContain(REASON_SENTENCES[code as keyof typeof REASON_SENTENCES]);
    }
  });

  it('gives the question and the fix the record carries (AC-22)', () => {
    const found = sectionText(render(refusedClosure('no-close'), AGENT_UNKNOWN, ASKING_RECORD), SECTION_HEADINGS.found);
    expect(found).toContain(QUESTION);
    expect(found).toContain(FIX_TEXT);
  });

  it('names the lane and the reason code when the record holds neither question nor fix, or is absent (AC-E30)', () => {
    for (const record of [RECORD, undefined]) {
      const found = sectionText(render(refusedClosure('record-too-old'), CLOSE_DECISION, record), SECTION_HEADINGS.found);
      expect(found).toContain(SET);
      expect(found).toContain('record-too-old');
    }
  });

  it('lists every lane, the incident lane included, in what stays open', () => {
    const open = sectionText(render(refusedClosure('no-close'), AGENT_UNKNOWN), SECTION_HEADINGS.open);
    for (const lane of LANES) expect(open.split(`${lane.configurationSet}:`)).toHaveLength(2);
  });
});

const CONFIRMED_ORDER = [
  SECTION_HEADINGS.happened,
  SECTION_HEADINGS.saw,
  SECTION_HEADINGS.open,
  SECTION_HEADINGS.app,
  SECTION_HEADINGS.reopen,
  SECTION_HEADINGS.limits,
  SECTION_HEADINGS.reference,
];

describe('each kind has a fixed section order (AC-E28)', () => {
  it('pins the headings of each kind in order', () => {
    const headings = (email: RenderedEmail | undefined): string[] => email?.sections.map((part) => part.heading) ?? [];
    expect(headings(render(NOT_HOLDING))).toEqual(CONFIRMED_ORDER);
    expect(headings(render(PAUSE_UNKNOWN))).toEqual(CONFIRMED_ORDER);
    expect(headings(render(PAUSE_FAILED))).toEqual(CONFIRMED_ORDER.filter((heading) => heading !== SECTION_HEADINGS.reopen));
    expect(headings(render(refusedClosure('no-close'), CAP_REACHED))).toEqual([
      SECTION_HEADINGS.happened,
      SECTION_HEADINGS.saw,
      SECTION_HEADINGS.found,
      SECTION_HEADINGS.open,
      SECTION_HEADINGS.limits,
      SECTION_HEADINGS.reference,
    ]);
  });

  it('renders the closed fixture exactly', () => {
    expect(renderedClosed()?.text).toMatchInlineSnapshot(`
      "What happened
      Fothering paused sending on the configuration set fothering-bulk.
      Pause requested at 2026-10-11T12:03:00.000Z.
      Read back at 2026-10-11T12:03:02.000Z: SES answered SendingEnabled false for fothering-bulk.
      Hold check at 2026-10-11T12:09:00.000Z: no send was seen accepted on fothering-bulk from 2026-10-11T12:04:00.000Z through 2026-10-11T12:09:00.000Z.

      What Fothering saw
      Evidence window: 2026-10-11T11:05:00.000Z to 2026-10-11T12:00:00.000Z.
      Permanent bounces: 15 of 200 recipient-sends. Fothering lane hard-bounce ratio (permanent bounces over recipient-sends): 7.50%.
      Complaints: 0 of 200 recipient-sends. Fothering lane complaint ratio (complaints over recipient-sends): 0.00%.
      These ratios count only the events Fothering stores for this lane. They are not the reputation figures SES shows for the account.
      Cause, batch import-0915: 15 permanent bounces and 0 complaints of 40 recipient-sends, hard-bounce ratio 37.50%, complaint ratio 0.00%.
      Isolation verdict: confined.

      What stays open
      fothering-transactional: no incident is open on it. The lane map marks this set transactional, so Fothering never pauses it.
      fothering-alerts: no incident is open on it. This set carries the operator email, so Fothering never pauses it. The lane map marks this set transactional, so Fothering never pauses it.

      What your app sees
      In a test send through a paused configuration set, SES refused the message with SendingPausedException, and the error message named the configuration set.

      How to reopen
      Find the name of the reopen function:
      aws cloudformation describe-stacks \\
        --region eu-central-1 \\
        --stack-name FotheringAction \\
        --query "Stacks[0].Outputs[?OutputKey=='ReopenFunctionName'].OutputValue" \\
        --output text
      Then run this, with that name in place of <ReopenFunctionName stack output>:
      aws lambda invoke \\
        --region eu-central-1 \\
        --function-name <ReopenFunctionName stack output> \\
        --cli-binary-format raw-in-base64-out \\
        --cli-read-timeout 60 \\
        --payload '{"configurationSet":"fothering-bulk"}' \\
        result.json
      Reopening a configuration set resets its SES reputation metrics, so the history SES keeps for fothering-bulk starts again.
      Fothering pauses a lane at most once per incident, and an incident stays open while fothering-bulk keeps spiking and for at least 14 hours after it goes quiet, since SES can still report bounces from deliveries it retried for that long. If you reopen fothering-bulk inside that time and it spikes again, Fothering makes no new evidence record or decision, does not pause it again and sends no new email, so watch fothering-bulk yourself until then.

      Limits
      If AWS pauses sending for the whole account, this email cannot be sent either, so silence from Fothering is not a sign that all is well.

      Reference
      Incident: b438b20ed0d68cfbd10c0469111d7d6a
      Evidence record hash: fac57751391000299915362daaa54d8b0b9621146c8116e53a618cd61d9714b6
      Option: opt-72a061ae5504378bcdac5f73

      Sent by Fothering, an automated agent. Replies to this address are not read by Fothering.
      "
    `);
  });

  it('renders the not-holding fixture exactly', () => {
    expect(render(NOT_HOLDING)?.kind).toBe('not-confirmed');
    expect(render(NOT_HOLDING)?.text).toMatchInlineSnapshot(`
      "What happened
      Fothering paused sending on the configuration set fothering-bulk.
      Pause requested at 2026-10-11T12:03:00.000Z.
      Read back at 2026-10-11T12:03:02.000Z: SES answered SendingEnabled false for fothering-bulk.
      Hold check at 2026-10-11T12:09:00.000Z, Send records seen accepted on fothering-bulk from 2026-10-11T12:04:00.000Z through 2026-10-11T12:09:00.000Z: 2.
      Fothering cannot confirm the pause is holding.

      What Fothering saw
      Evidence window: 2026-10-11T11:05:00.000Z to 2026-10-11T12:00:00.000Z.
      Permanent bounces: 15 of 200 recipient-sends. Fothering lane hard-bounce ratio (permanent bounces over recipient-sends): 7.50%.
      Complaints: 0 of 200 recipient-sends. Fothering lane complaint ratio (complaints over recipient-sends): 0.00%.
      These ratios count only the events Fothering stores for this lane. They are not the reputation figures SES shows for the account.
      Cause, batch import-0915: 15 permanent bounces and 0 complaints of 40 recipient-sends, hard-bounce ratio 37.50%, complaint ratio 0.00%.
      Isolation verdict: confined.

      What stays open
      fothering-transactional: no incident is open on it. The lane map marks this set transactional, so Fothering never pauses it.
      fothering-alerts: no incident is open on it. This set carries the operator email, so Fothering never pauses it. The lane map marks this set transactional, so Fothering never pauses it.

      What your app sees
      In a test send through a paused configuration set, SES refused the message with SendingPausedException, and the error message named the configuration set.

      How to reopen
      Find the name of the reopen function:
      aws cloudformation describe-stacks \\
        --region eu-central-1 \\
        --stack-name FotheringAction \\
        --query "Stacks[0].Outputs[?OutputKey=='ReopenFunctionName'].OutputValue" \\
        --output text
      Then run this, with that name in place of <ReopenFunctionName stack output>:
      aws lambda invoke \\
        --region eu-central-1 \\
        --function-name <ReopenFunctionName stack output> \\
        --cli-binary-format raw-in-base64-out \\
        --cli-read-timeout 60 \\
        --payload '{"configurationSet":"fothering-bulk"}' \\
        result.json
      Reopening a configuration set resets its SES reputation metrics, so the history SES keeps for fothering-bulk starts again.
      Fothering pauses a lane at most once per incident, and an incident stays open while fothering-bulk keeps spiking and for at least 14 hours after it goes quiet, since SES can still report bounces from deliveries it retried for that long. If you reopen fothering-bulk inside that time and it spikes again, Fothering makes no new evidence record or decision, does not pause it again and sends no new email, so watch fothering-bulk yourself until then.

      Limits
      If AWS pauses sending for the whole account, this email cannot be sent either, so silence from Fothering is not a sign that all is well.

      Reference
      Incident: b438b20ed0d68cfbd10c0469111d7d6a
      Evidence record hash: fac57751391000299915362daaa54d8b0b9621146c8116e53a618cd61d9714b6
      Option: opt-72a061ae5504378bcdac5f73

      Sent by Fothering, an automated agent. Replies to this address are not read by Fothering.
      "
    `);
  });

  it('renders the pause-failed fixture exactly', () => {
    expect(render(PAUSE_FAILED)?.kind).toBe('not-confirmed');
    expect(render(PAUSE_FAILED)?.text).toMatchInlineSnapshot(`
      "What happened
      Fothering requested a pause of fothering-bulk at 2026-10-11T12:03:00.000Z.
      Read back at 2026-10-11T12:03:02.000Z: SES answered SendingEnabled true for fothering-bulk, so the pause did not take and fothering-bulk is still sending.

      What Fothering saw
      Evidence window: 2026-10-11T11:05:00.000Z to 2026-10-11T12:00:00.000Z.
      Permanent bounces: 15 of 200 recipient-sends. Fothering lane hard-bounce ratio (permanent bounces over recipient-sends): 7.50%.
      Complaints: 0 of 200 recipient-sends. Fothering lane complaint ratio (complaints over recipient-sends): 0.00%.
      These ratios count only the events Fothering stores for this lane. They are not the reputation figures SES shows for the account.
      Cause, batch import-0915: 15 permanent bounces and 0 complaints of 40 recipient-sends, hard-bounce ratio 37.50%, complaint ratio 0.00%.
      Isolation verdict: confined.

      What stays open
      fothering-transactional: no incident is open on it. The lane map marks this set transactional, so Fothering never pauses it.
      fothering-alerts: no incident is open on it. This set carries the operator email, so Fothering never pauses it. The lane map marks this set transactional, so Fothering never pauses it.

      What your app sees
      In a test send through a paused configuration set, SES refused the message with SendingPausedException, and the error message named the configuration set.

      Limits
      If AWS pauses sending for the whole account, this email cannot be sent either, so silence from Fothering is not a sign that all is well.

      Reference
      Incident: b438b20ed0d68cfbd10c0469111d7d6a
      Evidence record hash: fac57751391000299915362daaa54d8b0b9621146c8116e53a618cd61d9714b6
      Option: opt-72a061ae5504378bcdac5f73

      Sent by Fothering, an automated agent. Replies to this address are not read by Fothering.
      "
    `);
  });

  it('renders the unknown fixture exactly', () => {
    expect(render(refusedClosure('newer-incident-elsewhere'), CLOSE_DECISION, ASKING_RECORD)?.kind).toBe('unknown');
    expect(render(refusedClosure('newer-incident-elsewhere'), CLOSE_DECISION, ASKING_RECORD)?.text).toMatchInlineSnapshot(`
      "What happened
      Fothering saw a spike on fothering-bulk.
      Nothing was paused.
      Another lane opened a newer incident after this evidence was gathered, so the evidence no longer described the account and Fothering paused nothing.

      What Fothering saw
      Evidence window: 2026-10-11T11:05:00.000Z to 2026-10-11T12:00:00.000Z.
      Permanent bounces: 15 of 200 recipient-sends. Fothering lane hard-bounce ratio (permanent bounces over recipient-sends): 7.50%.
      Complaints: 0 of 200 recipient-sends. Fothering lane complaint ratio (complaints over recipient-sends): 0.00%.
      These ratios count only the events Fothering stores for this lane. They are not the reputation figures SES shows for the account.
      Cause, batch import-0915: 15 permanent bounces and 0 complaints of 40 recipient-sends, hard-bounce ratio 37.50%, complaint ratio 0.00%.
      Isolation verdict: confined.

      What code found
      Two lanes spiked in the same window, fothering-bulk and fothering-transactional. Which of them should be paused?
      Suggested fix: Publish the DKIM records SES gives for news.example.com.

      What stays open
      fothering-transactional: no incident is open on it. The lane map marks this set transactional, so Fothering never pauses it.
      fothering-bulk: an incident is open on it. Nothing in its configuration stops Fothering from pausing it.
      fothering-alerts: no incident is open on it. This set carries the operator email, so Fothering never pauses it. The lane map marks this set transactional, so Fothering never pauses it.

      Limits
      If AWS pauses sending for the whole account, this email cannot be sent either, so silence from Fothering is not a sign that all is well.

      Reference
      Incident: b438b20ed0d68cfbd10c0469111d7d6a
      Evidence record hash: 6600e372569dfe0f44e5db024a25f2b6946002f30b0d2f0a6edf4e2d191bb4a3
      Option: opt-72a061ae5504378bcdac5f73

      Sent by Fothering, an automated agent. Replies to this address are not read by Fothering.
      "
    `);
  });
});

describe('subjects and set names survive as plain ASCII (AC-E27)', () => {
  it('gives every rendering a printable 7-bit ASCII subject', () => {
    for (const rendering of EVERY_RENDERING) expect(renderOperatorEmail(rendering.input)?.subject).toMatch(/^[\x20-\x7E]+$/);
  });

  it('renders a set name using every character the lane-map pattern allows unchanged in subject and body', () => {
    const odd = 'Az09_-Az09';
    const lanes = [...LANES, { configurationSet: odd, state: 'no-open-incident' as const, configurationRefusals: [] }];
    for (const closure of [closureWith({ configurationSet: odd, lanes }), closureWith({ ...refusedClosure('no-close'), configurationSet: odd, lanes })]) {
      const email = render(closure, AGENT_UNKNOWN);
      expect(email?.subject).toContain(odd);
      expect(email?.text).toContain(odd);
    }
  });
});

const ISO_TIME = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g;

function storedNumbers(...values: unknown[]): Set<string> {
  const found = new Set<string>();
  const walk = (value: unknown): void => {
    if (typeof value === 'number') found.add(String(value));
    else if (typeof value === 'string' && /^\d{1,3}\.\d{2}%$/.test(value)) found.add(value);
    else if (Array.isArray(value)) value.forEach(walk);
    else if (typeof value === 'object' && value !== null) Object.values(value).forEach(walk);
  };
  values.forEach(walk);
  return found;
}

function storedStrings(input: RenderInput): string[] {
  const { closure, record, decision } = input;
  const set = closure.configurationSet;
  return [
    reopenCommandFor(set),
    FIND_REOPEN_FUNCTION_COMMAND,
    incidentLimitSentence(set),
    reputationResetSentence(set),
    closure.incidentId,
    record?.hash,
    decision?.optionId,
    record?.question,
    record?.fix?.text,
    ...(record?.rows.map((row) => row.value) ?? []),
    ...closure.lanes.map((lane) => lane.configurationSet),
    set,
  ].filter((part): part is string => typeof part === 'string');
}

// AC-E31: what is left after the stored strings and the fixed sentences come out is numbers, and each
// must be a number or percent string the record or the closure stores; each time maps back through isoOf.
function strayNumbers(input: RenderInput, storedIn: RenderInput = input): string[] {
  const numbers = storedNumbers(storedIn.closure, storedIn.record);
  let text = renderOperatorEmail(input)?.text ?? '';
  for (const part of storedStrings(input).sort((a, b) => b.length - a.length)) text = text.split(part).join(' ');
  const strayTimes = (text.match(ISO_TIME) ?? []).filter((time) => !numbers.has(String(Date.parse(time))) || isoOf(Date.parse(time)) !== time);
  const strayTokens = (text.replace(ISO_TIME, ' ').match(/\d+(?:\.\d+)?%?/g) ?? []).filter((token) => !numbers.has(token));
  return [...strayTimes, ...strayTokens];
}

describe('every number is copied from a stored field (AC-E31)', () => {
  it.each(EVERY_RENDERING.map((rendering) => [rendering.name, rendering] as const))('%s holds no number the record or closure does not store', (_name, rendering) => {
    expect(renderOperatorEmail(rendering.input)).toBeDefined();
    expect(strayNumbers(rendering.input)).toEqual([]);
  });

  it('is shown red by a planted rendering whose count is not the stored one', () => {
    const input = { closure: NOT_HOLDING, record: RECORD, decision: CLOSE_DECISION, laneMap: LANE_MAP };
    const planted = { ...input, closure: { ...NOT_HOLDING, sendsAfterHold: 999_983 } };
    expect(strayNumbers(planted, input)).toEqual(['999983']);
  });
});

describe('no rendering asks for a reply, misnames a ratio or carries an address (AC-P7 to AC-P10)', () => {
  it.each(EVERY_RENDERING.map((rendering) => [rendering.name, rendering] as const))('%s holds none of the banned phrases or values', (_name, rendering) => {
    const text = textOf(rendering);
    expect(text).not.toBe('');
    expect(text).not.toMatch(/reply with|reply to this|send us/i);
    expect(text).not.toMatch(/SES bounce rate|SES complaint rate|your bounce rate/i);
    expect(text).not.toContain('@');
    expect(text).not.toMatch(/smtp;|user unknown/i);
    const figures = text.replace(ISO_TIME, ' ').match(/\d[\d,]*(?:\.\d+)?/g) ?? [];
    expect(figures.filter((figure) => ['60,000', '60000', '41.8', '38.5', '4.6', '3.5'].includes(figure))).toEqual([]);
  });
});

const CLOSE_EXPLANATION = 'One import batch holds the permanent bounces on this lane, and pausing this lane stops it.';
const EXPLAINED_CLOSE: StoredDecision = { ...CLOSE_DECISION, explanation: CLOSE_EXPLANATION };
const UNKNOWN_EXPLANATION = AGENT_UNKNOWN.explanation ?? '';
const EM_DASH = String.fromCodePoint(0x2014);
const EN_DASH = String.fromCodePoint(0x2013);

function withoutExplanation(decision: StoredDecision): StoredDecision {
  const bare: StoredDecision = { ...decision };
  delete bare.explanation;
  return bare;
}

function sectionAfter(email: RenderedEmail | undefined, heading: string): string | undefined {
  const headings = email?.sections.map((part) => part.heading) ?? [];
  return headings[headings.indexOf(heading) + 1];
}

describe('the model paragraph shows once, labelled, only when it passes its checks again (D-113, AC-20)', () => {
  it.each([
    { name: 'closed', closure: closedClosure(), decision: EXPLAINED_CLOSE, before: SECTION_HEADINGS.saw },
    { name: 'not-holding', closure: NOT_HOLDING, decision: EXPLAINED_CLOSE, before: SECTION_HEADINGS.saw },
    { name: 'pause-unknown', closure: PAUSE_UNKNOWN, decision: EXPLAINED_CLOSE, before: SECTION_HEADINGS.saw },
    { name: 'agent unknown', closure: refusedClosure('no-close'), decision: AGENT_UNKNOWN, before: SECTION_HEADINGS.found },
  ])('shows the $name paragraph once, right under its label, after $before', ({ closure, decision, before }) => {
    const email = render(closure, decision, ASKING_RECORD);
    const paragraph = decision.explanation ?? '';
    expect(paragraph).not.toBe('');
    expect(sectionAfter(email, before)).toBe(MODEL_PARAGRAPH_LABEL);
    expect(email?.text.split(paragraph)).toHaveLength(2);
    expect(email?.text).toContain(`${MODEL_PARAGRAPH_LABEL}\n${paragraph}\n`);
    expect(email?.text.split(MODEL_PARAGRAPH_LABEL)).toHaveLength(2);
  });

  it.each([
    ['a URL', 'One import batch holds the permanent bounces, see https://example.org/batch for the list.'],
    ['another lane set', 'One import batch holds the permanent bounces, and fothering-transactional is fine.'],
    ['a number the record does not hold', 'One import batch holds 4321 permanent bounces on this lane.'],
  ])('drops a stored paragraph holding %s, leaving every other byte of the email unchanged', (_name, planted) => {
    const plantedDecision = { ...EXPLAINED_CLOSE, explanation: planted };
    const dropped = render(closedClosure(), plantedDecision, ASKING_RECORD);
    expect(modelParagraphOf({ closure: closedClosure(), record: ASKING_RECORD, decision: plantedDecision, laneMap: LANE_MAP })).toBeUndefined();
    expect(dropped?.text).toBe(render(closedClosure(), withoutExplanation(EXPLAINED_CLOSE), ASKING_RECORD)?.text);
    expect(dropped?.headers).toEqual([]);
  });

  it('removes nothing but the paragraph section when one passes', () => {
    const shown = render(closedClosure(), EXPLAINED_CLOSE, ASKING_RECORD);
    const bare = render(closedClosure(), withoutExplanation(EXPLAINED_CLOSE), ASKING_RECORD);
    expect(shown?.text.replace(`${MODEL_PARAGRAPH_LABEL}\n${CLOSE_EXPLANATION}\n\n`, '')).toBe(bare?.text);
  });

  it('prints em and en dashes in a passing paragraph as plain hyphens', () => {
    const dashed = `One import batch holds the permanent bounces ${EM_DASH} pausing this lane stops it ${EN_DASH} on this lane.`;
    const text = render(closedClosure(), { ...EXPLAINED_CLOSE, explanation: dashed }, ASKING_RECORD)?.text ?? '';
    expect(text).toContain('One import batch holds the permanent bounces - pausing this lane stops it - on this lane.');
    expect(text.includes(EM_DASH) || text.includes(EN_DASH)).toBe(false);
  });
});

describe('a close the action refused carries the template alone (AC-P6, R10)', () => {
  it.each(ACTION_REFUSALS.filter((code) => code !== 'no-close'))('shows no model text for a %s refusal even when the paragraph would pass', (code) => {
    const email = render(refusedClosure(code), EXPLAINED_CLOSE, ASKING_RECORD);
    expect(email?.text).not.toContain(MODEL_PARAGRAPH_LABEL);
    expect(email?.text).not.toContain(CLOSE_EXPLANATION);
    expect(email?.headers).toEqual([]);
  });

  it('shows no model text for a cap-reached DECISION', () => {
    const capped: StoredDecision = { ...CAP_REACHED, explanation: UNKNOWN_EXPLANATION };
    expect(render(refusedClosure('no-close'), capped, ASKING_RECORD)?.text).not.toContain(MODEL_PARAGRAPH_LABEL);
  });

  it('shows no model text when the record is absent', () => {
    expect(render(refusedClosure('no-close'), AGENT_UNKNOWN, undefined)?.text).not.toContain(MODEL_PARAGRAPH_LABEL);
  });
});

describe('an email that shows the paragraph carries the machine-readable mark and no other does (Article 50(2))', () => {
  it('gives the one marker header to an email showing the paragraph', () => {
    expect(render(closedClosure(), EXPLAINED_CLOSE, ASKING_RECORD)?.headers).toEqual([MODEL_TEXT_MARKER_HEADER]);
    expect(render(refusedClosure('no-close'), AGENT_UNKNOWN, ASKING_RECORD)?.headers).toEqual([MODEL_TEXT_MARKER_HEADER]);
  });

  it('gives no header to an email without the paragraph', () => {
    for (const rendering of EVERY_RENDERING) {
      const email = renderOperatorEmail(rendering.input);
      expect(email?.headers).toEqual(email?.text.includes(MODEL_PARAGRAPH_LABEL) === true ? [MODEL_TEXT_MARKER_HEADER] : []);
    }
    expect(render(closedClosure(), withoutExplanation(EXPLAINED_CLOSE), ASKING_RECORD)?.headers).toEqual([]);
  });
});
