import { ACTION_FUNCTION_TIMEOUT_MS, EMAIL_SEND_ATTEMPTS } from './close-values.js';
import type { ActionRefusal, Closure, ClosureOutcome, EMAIL_KINDS, LANE_STATES, StoredDecision } from './closure.js';
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
  found: 'What code found',
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

export type ReasonCode = ActionRefusal | 'cap-reached' | ConfigurationRefusal;

// D-112: one plain sentence per refusal and decision code. The incident lifecycle's own status is
// never named here (Pitfall 10), and no sentence says closed.
export const REASON_SENTENCES: Readonly<Record<ReasonCode, string>> = {
  'no-close': 'The agent did not settle on one cause it could act on, so Fothering paused nothing.',
  'cap-reached': 'The limit on agent calls was reached before the agent answered, so code alone decided and Fothering paused nothing.',
  'record-missing': 'The evidence record for this incident could not be found, so Fothering paused nothing.',
  'record-invalid': 'The evidence record for this incident did not pass its schema check, so Fothering paused nothing.',
  'incident-mismatch': 'The evidence record names a different incident, so Fothering paused nothing.',
  'hash-mismatch': 'The evidence record no longer matches its hash, so Fothering paused nothing.',
  'option-set-tampered': 'The approved options on the evidence record do not match what code computed, so Fothering paused nothing.',
  'option-not-approved': 'The agent chose an option the evidence record does not approve, so Fothering paused nothing.',
  'decision-differs': 'The agent decided differently from what code computed from the evidence, so Fothering paused nothing.',
  'lane-not-in-map': 'The lane the agent named is not in the lane map, so Fothering paused nothing.',
  'ses-facts-unavailable': 'The SES configuration could not be read before acting, so Fothering paused nothing.',
  'ses-facts-bound': 'The account holds more sending identities than Fothering reads before acting, so Fothering paused nothing.',
  'incident-not-open': 'The incident was no longer the open one on its lane when the action ran, so its evidence no longer described the lane and Fothering paused nothing.',
  'newer-incident-elsewhere': 'Another lane opened a newer incident after this evidence was gathered, so the evidence no longer described the account and Fothering paused nothing.',
  'record-too-old': 'The evidence was more than one spike window old when the action ran, so Fothering paused nothing.',
  'record-not-closeable': 'The evidence record says this lane cannot be paused safely, so Fothering paused nothing.',
  'configuration-not-closeable': 'The lane map or the SES configuration rules out pausing this lane, so Fothering paused nothing.',
  'lane-already-paused': 'Fothering already holds a pause on this lane from an earlier incident, so it paused nothing new.',
  'lane-cap-reached': 'This lane used up its pause and reopen attempts for the hour, so Fothering paused nothing.',
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

// D-102 and AC-E25: the lanes as the act stored them, never a fresh read. After a pause the incident's
// own set is told in what happened and left out here; when nothing was paused it stays open too.
function openLines(closure: Closure, withOwnLane: boolean): string[] {
  const listed = closure.lanes.filter((lane) => withOwnLane || lane.configurationSet !== closure.configurationSet);
  const lines = listed.map((lane) => {
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

const UNCONFIRMED_READ_BACK: Readonly<Record<'threw' | 'missing', string>> = {
  threw: 'did not complete',
  missing: 'answered without a sending state',
};

function pauseUnknownLines(closure: Closure): string[] {
  const { readBack } = closure;
  if (readBack === 'threw' || readBack === 'missing') {
    return [`The read-back at ${timeOf(closure.readBackAtMs)} ${UNCONFIRMED_READ_BACK[readBack]}, so Fothering cannot confirm the pause took.`];
  }
  return ['The run that requested it stopped before reading the set back, so Fothering cannot confirm the pause took.'];
}

function pauseFailedLines(closure: Closure): string[] {
  const set = closure.configurationSet;
  if (closure.readBack === true) {
    return [`Read back at ${timeOf(closure.readBackAtMs)}: SES answered SendingEnabled true for ${set}, so the pause did not take and ${set} is still sending.`];
  }
  return [`SES did not accept the pause request, so the pause did not take and ${set} may still be sending.`];
}

function notHoldingLines(closure: Closure): string[] {
  const set = closure.configurationSet;
  const lines = [
    `Fothering paused sending on the configuration set ${set}.`,
    `Pause requested at ${timeOf(closure.pauseRequestedAtMs)}.`,
    `Read back at ${timeOf(closure.readBackAtMs)}: SES answered SendingEnabled false for ${set}.`,
    `Hold check at ${timeOf(closure.holdCheckedAtMs)}, Send records seen accepted on ${set} from ${timeOf(closure.holdEndMs)} through ${timeOf(closure.holdCheckedThroughMs)}: ${closure.sendsAfterHold ?? NOT_RECORDED}.`,
    'Fothering cannot confirm the pause is holding.',
  ];
  if (closure.holdCheckedThroughMs !== closure.holdCheckedAtMs) lines.push('The check read the stored events only up to that time, since the run that checked came late.');
  return lines;
}

function notConfirmedHappened(closure: Closure): string[] {
  if (closure.outcome === 'not-holding') return notHoldingLines(closure);
  const requested = `Fothering requested a pause of ${closure.configurationSet} at ${timeOf(closure.pauseRequestedAtMs)}.`;
  return [requested, ...(closure.outcome === 'pause-failed' ? pauseFailedLines(closure) : pauseUnknownLines(closure))];
}

// A pause that did not take leaves the set sending, so there is nothing to reopen (D-111).
function pausedSections(input: RenderInput, happened: readonly string[]): EmailSection[] {
  const set = input.closure.configurationSet;
  const reopen = input.closure.outcome === 'pause-failed' ? [] : [section(SECTION_HEADINGS.reopen, reopenLines(set))];
  return [
    section(SECTION_HEADINGS.happened, happened),
    section(SECTION_HEADINGS.saw, sawLines(input.record)),
    section(SECTION_HEADINGS.open, openLines(input.closure, false)),
    section(SECTION_HEADINGS.app, [PAUSED_APP_SENTENCE]),
    ...reopen,
    section(SECTION_HEADINGS.limits, [ACCOUNT_PAUSE_LIMIT_SENTENCE]),
    section(SECTION_HEADINGS.reference, referenceLines(input)),
  ];
}

// D-92: phase 2 stores an agent unknown and a cap-reached DECISION alike, and only the DECISION's own
// reason tells them apart.
function reasonCodeOf(input: RenderInput): ReasonCode {
  const { reason } = input.closure;
  if (reason === 'no-close' && input.decision?.reason === 'cap-reached') return 'cap-reached';
  return reason !== null && Object.hasOwn(REASON_SENTENCES, reason) ? (reason as ReasonCode) : 'no-close';
}

// AC-E30: a record with neither a question nor a fix, or no record at all, still names the lane and the code.
function foundLines(record: EvidenceRecord | undefined, configurationSet: string, code: ReasonCode): string[] {
  const lines: string[] = [];
  if (record !== undefined && record.question !== null) lines.push(record.question);
  if (record !== undefined && record.fix !== null) lines.push(`Suggested fix: ${record.fix.text}`);
  return lines.length > 0 ? lines : [`Lane: ${configurationSet}. Reason code: ${code}.`];
}

function unknownSections(input: RenderInput): EmailSection[] {
  const set = input.closure.configurationSet;
  const code = reasonCodeOf(input);
  return [
    section(SECTION_HEADINGS.happened, [`Fothering saw a spike on ${set}.`, 'Nothing was paused.', REASON_SENTENCES[code]]),
    section(SECTION_HEADINGS.saw, sawLines(input.record)),
    section(SECTION_HEADINGS.found, foundLines(input.record, set, code)),
    section(SECTION_HEADINGS.open, openLines(input.closure, true)),
    section(SECTION_HEADINGS.limits, [ACCOUNT_PAUSE_LIMIT_SENTENCE]),
    section(SECTION_HEADINGS.reference, referenceLines(input)),
  ];
}

function textOf(sections: readonly EmailSection[]): string {
  const body = sections.map((part) => [part.heading, ...part.lines].join('\n')).join('\n\n');
  return `${body}\n\n${AUTOMATED_SENDER_FOOTER}\n`;
}

function sectionsOf(kind: EmailKind, input: RenderInput): EmailSection[] {
  if (kind === 'unknown') return unknownSections(input);
  return pausedSections(input, kind === 'closed' ? closedHappened(input.closure) : notConfirmedHappened(input.closure));
}

function subjectTemplateOf(kind: EmailKind, outcome: ClosureOutcome): keyof typeof SUBJECTS {
  if (kind === 'closed' || kind === 'unknown') return kind;
  return outcome === 'not-holding' || outcome === 'pause-unknown' ? outcome : 'pause-failed';
}

/** D-109: undefined for an outcome that sends nothing. */
export function renderOperatorEmail(input: RenderInput): RenderedEmail | undefined {
  const { outcome } = input.closure;
  const kind = emailKindOf(outcome);
  if (kind === undefined || outcome === null) return undefined;
  const sections = sectionsOf(kind, input);
  return { kind, subject: subjectFor(subjectTemplateOf(kind, outcome), input.closure.configurationSet), text: textOf(sections), sections };
}
