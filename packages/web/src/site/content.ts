// The committed copy lists the built-page rules read (D-150). Later plans add their own lists here,
// so every word a page may not say sits in one module.

export const REPUTATION_PAGE_URL = 'https://docs.aws.amazon.com/ses/latest/dg/reputationdashboardmessages.html';

// A lane reopens only by the reopen command; no reply approves, closes, keeps or reopens one.
export const REPLY_PROMISE_PHRASES: readonly string[] = Object.freeze([
  'reply reopen',
  'your reply reopens',
  'reply to approve',
  'reply to reopen',
  'reply to close',
  'reply to keep',
  'approve by replying',
  'reopen by replying',
]);

// Deletion is the documented delete-one-recipient command; no page offers or promises a delete.
export const CONSOLE_DELETE_PHRASES: readonly string[] = Object.freeze([
  'console delete',
  'delete from the console',
  'delete this recipient',
  'delete a recipient here',
  'forget button',
  'delete on this page',
]);

// The comparison and incumbent claims the re-cut removed (AC-1, AC-P15). "polic" covers policy and
// policies.
export const BANNED_NAMES: readonly string[] = Object.freeze([
  'VDM advisor',
  'CloudWatch alarm plus Lambda',
  'Auto Validation',
  'tenant reputation polic',
]);

// The event records and the model requests are processed in different places, so no sentence may
// put all of it in one Region (AC-E14).
export const REGION_CLAIM_PATTERNS: readonly RegExp[] = Object.freeze([
  /\ball\s+(?:of\s+)?(?:the\s+|your\s+)?data\b[^.]{0,80}?\b(?:eu-central-1|Frankfurt)\b/i,
  /\beverything\b[^.]{0,80}?\b(?:eu-central-1|Frankfurt)\b/i,
]);

// DynamoDB deletes an expired item within a few days after its TTL, never at it (AC-P12).
export const EXACT_30_DAY_PATTERNS: readonly RegExp[] = Object.freeze([
  /\bexactly\s+(?:30|thirty)\s+days\b/i,
  /\b(?:deleted|removed|erased)\s+(?:(?:at|on|after)\s+)?(?:30|thirty)\s+days\b/i,
]);

// Until phase 3's files are on the branch, no page states an Article 50 verdict, the pause error
// or the reopen document (AC-31, D-146). The verdict words are upper case only, so "applies" in
// ordinary prose passes.
export const PRE_R6_PATTERNS: readonly RegExp[] = Object.freeze([
  /\bAPPLIES\b/,
  /\bDOES NOT APPLY\b/,
  /\bfalls on\b/i,
  /\bSendingPausedException\b/,
  /reopen-a-lane\.md/,
]);

export const ANALYTICS_PATTERNS: readonly RegExp[] = Object.freeze([
  /googletagmanager\.com/i,
  /google-analytics\.com/i,
  /\bgtag\s*\(/,
  /plausible\.io/i,
  /cdn\.segment\.(?:com|io)/i,
  /hotjar\.com/i,
  /mxpnl\.com|mixpanel\.com/i,
  /cdn\.amplitude\.com/i,
  /clarity\.ms/i,
  /matomo\.(?:js|php)/i,
  /posthog\.com/i,
  /cloudflareinsights\.com/i,
  /umami\.(?:is|js)/i,
]);

// The theme switch is the only input a page holds: three radios, Device, Light and Dark (AC-58).
export const THEME_RADIO_LIMIT = 3;

// The landing lede names each of these as a whole word, case-sensitive (AC-2): what acts, what it
// runs on, what it reads, what it pauses and how the operator hears of it.
export const LEDE_TERMS: readonly string[] = Object.freeze(['agent', 'Amazon Bedrock AgentCore', 'Amazon SES', 'configuration set', 'email']);

export type LandingSectionId = 'moment' | 'procedure' | 'refusals' | 'limits';

export interface LandingSection {
  readonly id: LandingSectionId;
  readonly level: 'h1' | 'h2';
  readonly heading: string;
}

// The four headed sections of the landing (AC-1, UI-SPEC 11.4); the page's h1 carries the moment.
// The page renders these headings from here, so the rule and the page cannot drift apart.
export const LANDING_SECTIONS: readonly LandingSection[] = Object.freeze([
  { id: 'moment', level: 'h1', heading: 'When one import starts bouncing, Fothering closes that lane and nothing else.' },
  { id: 'procedure', level: 'h2', heading: 'How one lane gets closed' },
  { id: 'refusals', level: 'h2', heading: 'What it will not do' },
  { id: 'limits', level: 'h2', heading: 'Limits, and what is real today' },
]);

export const NO_MEASURED_NUMBER_SENTENCE = 'Everything on this site is labelled by where it came from, and this site carries no measured number.';

export interface LimitsRow {
  readonly id: string;
  readonly part: string;
  readonly state: string;
  readonly mark: 'later' | 'open';
  readonly note: string;
}

// The replay row's state, mark and note come from the provenance label map (D-139); these three
// rows are the same whatever the artifact holds.
export const LIMITS_REPLAY_ROW = Object.freeze({ id: 'replay', part: 'Incident replay' });
export const LIMITS_FIXED_ROWS: readonly LimitsRow[] = Object.freeze([
  { id: 'measured-numbers', part: 'Measured numbers', state: 'None yet', mark: 'later', note: 'This site shows no measured number. Numbers come only from recorded live runs.' },
  { id: 'live-run', part: 'Live run', state: 'Not yet', mark: 'later', note: 'One run against the SES mailbox simulator and a verified address is planned before submission.' },
  { id: 'deploy-sheet', part: 'Deploy sheet', state: 'From the template', mark: 'open', note: 'Its permissions and resources are generated from the template on every build.' },
]);
