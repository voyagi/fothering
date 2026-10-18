import { ACTION_FUNCTION_TIMEOUT_MS, EMAIL_SEND_ATTEMPTS } from './close-values.js';
import type { Closure, ClosureOutcome, EMAIL_KINDS, LANE_STATES, StoredDecision } from './closure.js';
import type { ConfigurationRefusal } from './closeability.js';
import { AUTOMATED_SENDER_FOOTER } from './disclosure.js';
import type { EvidenceRecord } from './evidence-record.js';
import type { LaneMap } from './lanes.js';
import { FIND_REOPEN_FUNCTION_COMMAND, REOPEN_FUNCTION_NAME_SLOT, incidentLimitSentence, reopenCommandFor, reputationResetSentence } from './reopen.js';

// D-109 to D-113: every line here is a code template over stored fields. Numbers are printed as the
// record or the closure stores them, never recomputed or rounded, so a reader can trace each one back.

export type EmailKind = (typeof EMAIL_KINDS)[number];

export interface EmailSection {
  heading: string;
  lines: readonly string[];
}

export interface RenderedEmail {
  kind: EmailKind;
  subject: string;
  text: string;
  sections: readonly EmailSection[];
}

export interface RenderInput {
  closure: Closure;
  record: EvidenceRecord | undefined;
  decision: StoredDecision | undefined;
  laneMap: LaneMap;
}

export const SECTION_HEADINGS = {
  happened: 'What happened',
  saw: 'What Fothering saw',
  explanation: "The model's explanation",
  open: 'What stays open',
  app: 'What your app sees',
  reopen: 'How to reopen',
  limits: 'Limits',
  reference: 'Reference',
} as const;

const SET_SLOT = '<set>';

/** D-110: fixed ASCII templates with only the set filled in, and no incident id (AC-E31). */
export const SUBJECTS = {
  closed: `[Fothering] ${SET_SLOT} closed: sending paused and holding`,
  'not-holding': `[Fothering] ${SET_SLOT} paused, but a send was accepted after the hold`,
  'pause-unknown': `[Fothering] ${SET_SLOT}: pause requested, result unknown`,
  'pause-failed': `[Fothering] ${SET_SLOT}: the pause did not take`,
  unknown: `[Fothering] Spike on ${SET_SLOT}: nothing was paused`,
} as const;

export const ACCOUNT_PAUSE_LIMIT_SENTENCE =
  'If AWS pauses sending for the whole account, this email cannot be sent either, so silence from Fothering is not a sign that all is well.';

// L2a finding 2 and AC-P11: what a test send showed, never worded as something AWS documents.
export const PAUSED_APP_SENTENCE =
  'In a test send through a paused configuration set, SES refused the message with SendingPausedException, and the error message named the configuration set.';

export const LANE_STATE_WORDS: Readonly<Record<(typeof LANE_STATES)[number], string>> = {
  'incident-open': 'an incident is open on it',
  'no-open-incident': 'no incident is open on it',
  'paused-by-fothering': 'Fothering paused it for an earlier incident',
};

export const REASON_SENTENCES: Readonly<Record<ConfigurationRefusal, string>> = {
  'multiple-declared-streams': 'The lane map declares more than one stream on this set, so Fothering never pauses it.',
  'operator-alert': 'This set carries the operator email, so Fothering never pauses it.',
  transactional: 'The lane map marks this set transactional, so Fothering never pauses it.',
  'unlisted-configuration-set': 'SES holds a configuration set the lane map does not list, so Fothering pauses no set until the lane map lists every one.',
  'default-configuration-set': 'An SES identity sends through this set by default, so pausing it would also stop mail that never named it, and Fothering does not pause it.',
  'destination-missing-event-types':
    'Its EventBridge event destination does not publish every event type Fothering reads, so Fothering cannot watch it and does not pause it.',
};

const RATIO_SCOPE_SENTENCE = 'These ratios count only the events Fothering stores for this lane. They are not the reputation figures SES shows for the account.';
const FACTS_UNREAD_SENTENCE = 'The SES configuration could not be read before acting, so these refusals come from the lane map alone.';
const NOT_COMPUTED = 'not computed';
const NOT_RECORDED = 'not recorded';

const KIND_BY_OUTCOME: Readonly<Partial<Record<ClosureOutcome, EmailKind>>> = {
  closed: 'closed',
  'not-holding': 'not-confirmed',
  'pause-unknown': 'not-confirmed',
  'pause-failed': 'not-confirmed',
  refused: 'unknown',
};

/** D-109: paused waits for its hold check, and dry-run and a claim with no outcome send nothing. */
export function emailKindOf(outcome: ClosureOutcome | null): EmailKind | undefined {
  return outcome === null ? undefined : KIND_BY_OUTCOME[outcome];
}

export function isoOf(ms: number): string {
  return new Date(ms).toISOString();
}

function timeOf(ms: number | null): string {
  return ms === null ? NOT_RECORDED : isoOf(ms);
}

/**
 * D-96 and AC-E29: an attempt is due while the email is unsent, not failed, has attempts left and holds
 * no claim younger than the action's timeout; an older claim with no send counts as a spent attempt.
 */
export function emailAttemptDue(closure: Closure, nowMs: number): boolean {
  const { email } = closure;
  if (email === null) return true;
  if (email.sentAtMs !== null || email.failed || email.attempts >= EMAIL_SEND_ATTEMPTS) return false;
  return email.claimedAtMs === null || nowMs >= email.claimedAtMs + ACTION_FUNCTION_TIMEOUT_MS;
}

function subjectFor(template: keyof typeof SUBJECTS, configurationSet: string): string {
  return SUBJECTS[template].replace(SET_SLOT, configurationSet);
}

function holdCheckLines(closure: Closure): string[] {
  const set = closure.configurationSet;
  const lines = [
    `Hold check at ${timeOf(closure.holdCheckedAtMs)}: no send was seen accepted on ${set} from ${timeOf(closure.holdEndMs)} through ${timeOf(closure.holdCheckedThroughMs)}.`,
  ];
  if (closure.holdCheckedThroughMs !== closure.holdCheckedAtMs) {
    lines.push('The check read the stored events only up to that time, since the run that checked came late.');
  }
  return lines;
}

function closedHappened(closure: Closure): string[] {
  const set = closure.configurationSet;
  return [
    `Fothering paused sending on the configuration set ${set}.`,
    `Pause requested at ${timeOf(closure.pauseRequestedAtMs)}.`,
    `Read back at ${timeOf(closure.readBackAtMs)}: SES answered SendingEnabled false for ${set}.`,
    ...holdCheckLines(closure),
  ];
}

function rowValueWords(row: EvidenceRecord['rows'][number]): string {
  if (row.value !== null) return row.value;
  return row.kind === 'no-value' ? 'with no value' : 'all other values';
}

function causeLine(row: EvidenceRecord['rows'][number]): string {
  return (
    `Cause, ${row.dimension} ${rowValueWords(row)}: ${row.permanentBounces} permanent bounces and ${row.complaints} complaints of ${row.sends} recipient-sends, ` +
    `hard-bounce ratio ${row.hardBounceRatio ?? NOT_COMPUTED}, complaint ratio ${row.complaintRatio ?? NOT_COMPUTED}.`
  );
}

function sawLines(record: EvidenceRecord | undefined): string[] {
  if (record === undefined) return ['The evidence record could not be read or did not match its hash, so no counts are shown.'];
  const { laneTotals, window } = record;
  const causes = record.rows.filter((row) => row.verdict === 'cause');
  return [
    `Evidence window: ${isoOf(window.fromBucketMs)} to ${isoOf(window.toBucketMs)}.`,
    `Permanent bounces: ${laneTotals.permanentBounces} of ${laneTotals.recipientSends} recipient-sends. ${laneTotals.label.hardBounceRatio}: ${laneTotals.hardBounceRatio ?? NOT_COMPUTED}.`,
    `Complaints: ${laneTotals.complaints} of ${laneTotals.recipientSends} recipient-sends. ${laneTotals.label.complaintRatio}: ${laneTotals.complaintRatio ?? NOT_COMPUTED}.`,
    RATIO_SCOPE_SENTENCE,
    ...(causes.length === 0 ? ['No single tag value or provider met its cause threshold.'] : causes.map(causeLine)),
    `Isolation verdict: ${record.isolation}.`,
  ];
}

function refusalWords(code: string): string {
  return Object.hasOwn(REASON_SENTENCES, code) ? REASON_SENTENCES[code as ConfigurationRefusal] : code;
}

// D-102 and AC-E25: the lanes as the act stored them, never a fresh read; the incident's own set is
// told in what happened and never listed here.
function openLines(closure: Closure): string[] {
  const others = closure.lanes.filter((lane) => lane.configurationSet !== closure.configurationSet);
  const lines = others.map((lane) => {
    const refusals = lane.configurationRefusals.map(refusalWords);
    const tail = refusals.length === 0 ? 'Nothing in its configuration stops Fothering from pausing it.' : refusals.join(' ');
    return `${lane.configurationSet}: ${LANE_STATE_WORDS[lane.state]}. ${tail}`;
  });
  if (lines.length === 0) lines.push('The lane map holds no other lane.');
  if (closure.sesFacts !== 'read') lines.push(FACTS_UNREAD_SENTENCE);
  return lines;
}

function reopenLines(configurationSet: string): string[] {
  return [
    'Find the name of the reopen function:',
    FIND_REOPEN_FUNCTION_COMMAND,
    `Then run this, with that name in place of ${REOPEN_FUNCTION_NAME_SLOT}:`,
    reopenCommandFor(configurationSet),
    reputationResetSentence(configurationSet),
    incidentLimitSentence(configurationSet),
  ];
}

function referenceLines(input: RenderInput): string[] {
  return [
    `Incident: ${input.closure.incidentId}`,
    `Evidence record hash: ${input.record?.hash ?? 'not available'}`,
    `Option: ${input.decision?.optionId ?? 'none'}`,
  ];
}

function section(heading: string, lines: readonly string[]): EmailSection {
  return { heading, lines };
}

function closedSections(input: RenderInput): EmailSection[] {
  const set = input.closure.configurationSet;
  return [
    section(SECTION_HEADINGS.happened, closedHappened(input.closure)),
    section(SECTION_HEADINGS.saw, sawLines(input.record)),
    section(SECTION_HEADINGS.open, openLines(input.closure)),
    section(SECTION_HEADINGS.app, [PAUSED_APP_SENTENCE]),
    section(SECTION_HEADINGS.reopen, reopenLines(set)),
    section(SECTION_HEADINGS.limits, [ACCOUNT_PAUSE_LIMIT_SENTENCE]),
    section(SECTION_HEADINGS.reference, referenceLines(input)),
  ];
}

function textOf(sections: readonly EmailSection[]): string {
  const body = sections.map((part) => [part.heading, ...part.lines].join('\n')).join('\n\n');
  return `${body}\n\n${AUTOMATED_SENDER_FOOTER}\n`;
}

/** D-109: undefined for an outcome that sends nothing. */
export function renderOperatorEmail(input: RenderInput): RenderedEmail | undefined {
  const kind = emailKindOf(input.closure.outcome);
  if (kind !== 'closed') return undefined;
  const sections = closedSections(input);
  return { kind, subject: subjectFor('closed', input.closure.configurationSet), text: textOf(sections), sections };
}
