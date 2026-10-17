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
