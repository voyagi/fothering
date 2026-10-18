import type { Closure, ClosureOutcome, EMAIL_KINDS, LANE_STATES, StoredDecision } from './closure.js';
import type { ConfigurationRefusal } from './closeability.js';
import type { EvidenceRecord } from './evidence-record.js';
import type { LaneMap } from './lanes.js';

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

export const ACCOUNT_PAUSE_LIMIT_SENTENCE =
  'If AWS pauses sending for the whole account, this email cannot be sent either, so silence from Fothering is not a sign that all is well.';

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

export function emailKindOf(outcome: ClosureOutcome | null): EmailKind | undefined {
  void outcome;
  return undefined;
}

export function isoOf(ms: number): string {
  return new Date(ms).toISOString();
}

export function renderOperatorEmail(input: RenderInput): RenderedEmail | undefined {
  void input;
  return undefined;
}
