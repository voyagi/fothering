// The committed copy lists the built-page rules read (D-150). Later plans add their own lists here,
// so every word a page may not say sits in one module.

import { ROUTES } from './route-list.js';

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

// The deploy sheet (UI-SPEC 11.7). Its commands, permissions, resources and Region come from the
// committed sources through repo-facts.ts and the snapshot views; `{region}` is filled from the
// stack pin, so no text here names a command, a permission or the Region.

export const DEPLOY_COPY = Object.freeze({
  h1: 'Deploy into your own AWS account',
  intro: 'Fothering runs in your account, in `{region}`. Read the template before you deploy it: this sheet lists everything it creates, every permission it holds, and how to take all of it out again, each generated from the template on every build.',
  stepsHeading: 'Five steps, one template',
  stepsHead: 'The deploy is one CDK app. Building it is free and offline, so you can read the CloudFormation it produces before anything is created.',
  resourcesHeading: 'What the template creates',
  resourcesHead: 'Nothing outside this list. Each row comes from the synthesized templates, with what removal does to it.',
  resourcesCaption: 'Resource schedule, `{region}`, generated from packages/infra/resources.json.',
  permissionsHeading: 'Every permission, and why',
  permissionsHead: 'Listed per role, generated from the committed permissions snapshot, which the test suite compares with the synthesized templates both ways. If a role in the template you deploy holds anything not listed here, do not deploy it.',
  permissionsCaption: 'Source: packages/infra/permissions.json.',
  runtimeRoleSentence: 'The runtime role holds no SES, DynamoDB or S3 action.',
  denyHeading: 'Denied on every role',
  removalHeading: 'Taking it out',
  removalHead: 'Removal deletes what the template created. Your configuration sets and their event destinations are yours to remove.',
});

// AC-36: the sentence and its reason, rendered whole so the one-caller rule can find it.
export const ONE_CALLER_SENTENCE = 'Each lane sends through its own IAM caller identity. The closeability check refuses a lane whose caller also sends through another configuration set, because pausing it could not be confined to one stream.';

// UI-SPEC Q16: shown while no role may pause a lane, and gone with no edit once one may.
export const NOT_YET_NOTICE = Object.freeze({
  label: 'NOT YET',
  text: 'This template has no stack that pauses or reopens a lane yet. Every table on this sheet shows the template as it stands.',
});

// Which README command lines a step shows, by what each line does (repo-facts.ts classifies them).
export type DeployCommandUse = 'build' | 'bootstrap' | 'deploy' | 'go-live' | 'destroy';

export interface DeployStepCopy {
  readonly title: string;
  readonly text: string;
  readonly uses: readonly DeployCommandUse[];
}

export const DEPLOY_STEPS: readonly DeployStepCopy[] = Object.freeze([
  { title: 'Check what you have', text: 'An AWS account with SES in `{region}`, Node.js 22, and credentials for that account.', uses: [] },
  {
    title: 'Name the lanes to watch',
    text: 'List every configuration set you send through in `lanes.json`, transactional ones included, each with an EventBridge event destination for all six event types.',
    uses: [],
  },
  { title: 'Build and read the template', text: 'This writes the CloudFormation templates into `cdk.out`. Read their IAM statements against the tables below.', uses: ['build'] },
  { title: 'Deploy with the switch off', text: 'The stacks start in dry run: they read and store events and log what they would do.', uses: ['bootstrap', 'deploy'] },
  { title: 'Turn the switch on', text: 'Only after a dry-run week you are happy with.', uses: ['go-live'] },
]);

// Pre-R6 removal (UI-SPEC 11.7). "The stacks" rather than a count, so the step stays true when a
// later phase adds a stack; plan 05-15 puts the reopen step in front of these.
export const REMOVAL_STEP_TEXTS = Object.freeze({
  destroy: 'Delete the stacks. Everything the schedule above marks as deleted goes with them.',
  destinations: 'Remove the EventBridge event destinations you added to your configuration sets.',
});

// The resource schedule's On removal wording; a deleted row names the README's destroy command.
export const RESOURCE_REMOVAL = Object.freeze({ deleted: 'Deleted by', kept: 'Kept after removal' });

export const PERMISSION_COLUMNS = Object.freeze(['Kind', 'Action', 'Effect', 'Resource or principal', 'Condition', 'Why'] as const);
export const RESOURCE_COLUMNS = Object.freeze(['Resource', 'What it is', 'Stack', 'On removal'] as const);

// The privacy and AI page (UI-SPEC 11.6). Each statement is the exact text the built page must hold,
// with code spans in backticks and `{region}` filled from the stacks' Region pin, so no list here
// names the Region, a model or its id (D-145).

export interface Statement {
  readonly id: string;
  readonly text: string;
  // A page the same element must link to.
  readonly link?: string;
}

export const BEDROCK_GEOGRAPHY_URL = 'https://docs.aws.amazon.com/bedrock/latest/userguide/geographic-cross-region-inference.html';
export const COMPLAINT_AUTHORITY_URL = 'https://autoriteitpersoonsgegevens.nl';
export const FORGET_DOC = 'docs/forget-one-recipient.md';

// What the page shows once the backticks become code elements and the Region is filled in.
export const plainStatement = (text: string, region: string): string => text.replaceAll('{region}', region).replaceAll('`', '');

// AC-19. The event-record sentence and the model-request sentence stay apart (AC-E14), and expiry is
// worded the way DynamoDB TTL works: deletion follows within a few days, never at the day (AC-P12).
export const PRIVACY_REQUIRED: readonly Statement[] = Object.freeze([
  { id: 'event-region', text: "Event records stay in the operator's AWS account, in `{region}`." },
  {
    id: 'model-requests',
    text: "The model is called through Amazon Bedrock's EU inference profile. Requests are processed in EU Regions, and AWS may store prompts and results in the Region that served them for abuse detection.",
    link: BEDROCK_GEOGRAPHY_URL,
  },
  { id: 'keyed-hash', text: 'It is pseudonymised personal data: whoever holds the key can match an address to it.' },
  { id: 'retention', text: 'Each event record expires 30 days after its mail was sent and is deleted within a few days after that.' },
  { id: 'dead-letter', text: 'An event that could not be written waits in a dead-letter queue for up to 4 days.' },
  { id: 'logs', text: 'Log lines are kept for one month.' },
  { id: 'forget', text: `To delete one recipient, the operator runs the command in \`${FORGET_DOC}\`.` },
  { id: 'forget-reach', text: 'It does not reach a message waiting in the dead-letter queue, which SQS drops within 4 days, or log lines, which go after one month.' },
  { id: 'addresses', text: "The operator email's To and From addresses are deploy parameters held in that business's own account, never in this repository." },
  { id: 'deployment-controller', text: "The business that deploys Fothering is the controller of its recipients' data." },
  // RESEARCH A7: the minimizer stores the operator's own tag values, which no map can class.
  { id: 'tag-values', text: 'Tag values are text you choose, so keep personal data out of them.' },
]);

// UI-SPEC section 17 item 1: the role-only default until the owner names a controller (AC-P16).
export const CONTROLLER = Object.freeze({
  name: 'the developer who built this hackathon entry',
  contact: "open an issue on the project's repository",
});

// AC-21. The Cloudflare DPA sentence and the Dutch authority as complaint body are carried from the
// GDPR audit unverified (UI-SPEC section 17 items 4 and 5).
export const WEBSITE_FACTS: readonly Statement[] = Object.freeze([
  { id: 'controller', text: `The controller of this website is ${CONTROLLER.name}.` },
  { id: 'contact', text: `To reach them, ${CONTROLLER.contact}.` },
  { id: 'no-cookie', text: 'They set no cookie' },
  { id: 'no-analytics', text: 'run no analytics' },
  { id: 'legal-basis', text: 'The legal basis is the legitimate interest in serving the pages (GDPR Article 6(1)(f)).' },
  { id: 'cloudflare-dpa', text: 'Cloudflare processes it under its data processing addendum, part of its self-serve subscription agreement.' },
  { id: 'aws-dpa', text: "AWS processes a deployment's data under the deploying business's own AWS agreement." },
  { id: 'complaint', text: 'and the right to complain to the Dutch supervisory authority, the Autoriteit Persoonsgegevens.', link: COMPLAINT_AUTHORITY_URL },
]);

// AC-E16: matched as a set, each once, through the page's data-right marks.
export const SIX_RIGHTS: readonly string[] = Object.freeze(['access', 'rectification', 'erasure', 'restriction of processing', 'data portability', 'objection']);

// D-141: the site's only stored state, and what each key holds, named on the privacy section (AC-22).
export const STORAGE_ENTRIES = Object.freeze([
  { key: 'fothering-theme', holds: '`light` or `dark`, when you pick Light or Dark; Device removes it' },
  { key: 'fothering-flow', holds: '`stopped` or `running`, when you use the Stop flow button' },
]);

export const RUNTIME_ROLE_STATEMENT = 'runtime-role';

// AC-24, as UI-SPEC 11.6 words them. Code and the model stay in separate sentences, and every
// negation names what the agent lacks rather than putting a verb after it (AC-E18).
export const MODEL_REQUIRED: readonly Statement[] = Object.freeze([
  { id: 'evidence-record', text: 'Detection code writes one evidence record and approves at most one lane.' },
  { id: 'receives-only', text: 'An AI agent on Amazon Bedrock AgentCore Runtime receives only that record' },
  { id: 'no-tool', text: 'It holds no tool that changes anything.' },
  { id: 'returns', text: 'Returns close with an opaque option id, or unknown.' },
  { id: 'one-paragraph', text: "Writes one explanation paragraph, which the operator email labels as the agent's." },
  { id: 'reloads', text: 'The action function reloads the evidence record and checks it before any SES call.' },
  { id: RUNTIME_ROLE_STATEMENT, text: DEPLOY_COPY.runtimeRoleSentence },
  { id: 'refusals', text: 'Nothing closes when the cause is unsettled, the spike is not confined to one lane, or the agent is unavailable.' },
]);

// The runtime-role sentence is true only while the snapshot's runtime role holds no data action.
export const modelStatements = (runtimeRoleHoldsNoDataAction: boolean): Statement[] =>
  MODEL_REQUIRED.filter((statement) => runtimeRoleHoldsNoDataAction || statement.id !== RUNTIME_ROLE_STATEMENT);

export interface ForbiddenClaim {
  readonly claim: string;
  readonly pattern: RegExp;
}

// AC-25. Each pattern is anchored on the model or the agent as subject: "the model", "an AI agent",
// a possessive such as "Fothering's agent", or "it". At most one word may sit between subject and
// verb ("the agent then pauses"), and never a negation, so "the model never names the cause" passes
// and "the model names the cause" fails (AC-E18). The curly apostrophe is built from its code point
// so the source stays ASCII.
const APOSTROPHE = `['${String.fromCharCode(0x2019)}]`;
const NOUN = String.raw`(?:AI\s+)?(?:model|agent)`;
const BETWEEN = String.raw`(?:(?!(?:never|not|no|cannot)\b)[a-z]+\s+)?`;
const SUBJECT = String.raw`(?:\b(?:the|an?|this|its)\s+${NOUN}|\b\w+${APOSTROPHE}s\s+${NOUN}|\bit)\s+${BETWEEN}`;
const claim = (name: string, verbs: string): ForbiddenClaim => ({ claim: name, pattern: new RegExp(`${SUBJECT}(?:${verbs})`, 'i') });

export const MODEL_FORBIDDEN: readonly ForbiddenClaim[] = Object.freeze([
  claim('cause', String.raw`(?:works?|worked)\s+out\s+the\s+cause|(?:names?|named|finds?|found|determines?|determined|decides?|decided|picks?|picked)\s+the\s+cause`),
  claim('stored-data', String.raw`(?:reads?|receives?|received|sees?|saw|queries|queried|fetches|fetched)\s+(?:the\s+)?(?:stored\s+events|events|recipient\s+addresses|addresses|subjects|headers)\b`),
  claim('lane-choice', String.raw`(?:picks?|picked|approves?|approved|chooses|chose|selects?|selected|adds?|added)\s+(?:a|the|one|which)\s+lane`),
  claim('lane-change', String.raw`(?:closes?|closed|pauses?|paused|reopens?|reopened|stops?|stopped)\s+(?:a|the|one|that|this)\s+(?:lane|configuration\s+set)`),
  claim('ses-call', String.raw`(?:calls?|called|invokes?|invoked)\s+(?:Amazon\s+)?SES\b`),
  claim('reply', String.raw`(?:reads?|parses?|parsed)\s+(?:a|the|your|an)\s+(?:operator's\s+)?repl(?:y|ies)\b`),
]);

export interface ModelRecordRow {
  readonly label: string;
  readonly text: string;
  // Markers the built checks read: the cell holding only the id, and the row that states the model's role.
  readonly attrs?: Readonly<Record<string, string>>;
}

// UI-SPEC E12: four fixed rows. The profile must be an EU one, or the Bedrock sentence above would be
// false, so the build stops instead of printing it.
export function modelRecordRows(modelId: string, region: string): ModelRecordRow[] {
  if (!modelId.startsWith('eu.')) {
    throw new Error(`model id: ${modelId} is not an EU inference profile, and the privacy section says requests are processed in EU Regions. Pin an eu. profile.`);
  }
  return [
    // The id names the model itself, so no model name is typed beside it and the row follows the pin.
    { label: 'Model', text: `\`${modelId}\``, attrs: { 'data-model-id': '' } },
    { label: 'Region', text: `Called through Amazon Bedrock from \`${region}\`, using the EU inference profile. Requests are processed in EU Regions and may be stored in the Region that served them for abuse detection.` },
    { label: 'Default', text: 'Dry run. With the go-live switch unset, events are read and stored, while model calls, SES changes and emails are skipped and each is logged as what it would have done.' },
    { label: 'Labelled output', text: 'Every operator email says at the top which paragraph the agent wrote.', attrs: { 'data-model-role': '' } },
  ];
}

export type HandCheckResult = 'not-yet-checked' | 'not-applicable' | 'passed' | 'failed';

export const HAND_CHECK_RESULT_LABELS: Readonly<Record<HandCheckResult, string>> = Object.freeze({
  'not-yet-checked': 'Not yet checked',
  'not-applicable': 'Not applicable',
  'passed': 'Passed',
  'failed': 'Failed',
});

export interface HandCheckCriterion {
  readonly number: string;
  readonly name: string;
  readonly result: HandCheckResult;
  // The method a person follows to decide it, never an outcome: until the hand check has run there
  // is no outcome to state.
  readonly how: string;
}

const NO_FORM = 'Check that the site has no form and no text input, only the three theme radios.';

// D-156: the WCAG 2.2 A and AA criteria no axe-core 4.14.0 rule decides, as 05-RESEARCH.md derived
// them from the W3C criteria list and axe's rule table. No person has checked any of them yet, so
// every row is not yet checked, the ones the research expects not to apply included (UI-SPEC E13).
// The real-browser hand check records each result here, not applicable among them, in one commit.
export const HAND_CHECK_CRITERIA: readonly HandCheckCriterion[] = Object.freeze([
  { number: '1.2.3', name: 'Audio Description or Media Alternative (Prerecorded)', result: 'not-yet-checked', how: 'Check that the site has no prerecorded video or audio.' },
  { number: '1.2.4', name: 'Captions (Live)', result: 'not-yet-checked', how: 'Check that the site has no live video or audio.' },
  { number: '1.2.5', name: 'Audio Description (Prerecorded)', result: 'not-yet-checked', how: 'Check that the site has no prerecorded video.' },
  { number: '1.3.2', name: 'Meaningful Sequence', result: 'not-yet-checked', how: 'Check that every page keeps its meaning when read with a screen reader and with styles turned off.' },
  { number: '1.3.3', name: 'Sensory Characteristics', result: 'not-yet-checked', how: 'Check that no instruction relies on shape, colour, size, position or sound alone.' },
  { number: '1.4.5', name: 'Images of Text', result: 'not-yet-checked', how: 'Check that every word is text, the drawing labels included, and none is a picture of text.' },
  { number: '1.4.10', name: 'Reflow', result: 'not-yet-checked', how: 'Check that at 320 pixels wide and at the largest zoom no page scrolls sideways or cuts content off.' },
  { number: '1.4.11', name: 'Non-text Contrast', result: 'not-yet-checked', how: 'Check that the state marks, drawing lines, theme switch and focus rings meet the contrast minimum in Light and Dark.' },
  { number: '1.4.13', name: 'Content on Hover or Focus', result: 'not-yet-checked', how: 'Check that hovering over or focusing any link or control opens no tooltip or pop-up over the page.' },
  { number: '2.1.2', name: 'No Keyboard Trap', result: 'not-yet-checked', how: 'Check that focus can leave every control when tabbing forwards and backwards with the keyboard alone.' },
  { number: '2.1.4', name: 'Character Key Shortcuts', result: 'not-yet-checked', how: 'Check that pressing letter, number and punctuation keys on every page triggers no shortcut.' },
  { number: '2.3.1', name: 'Three Flashes or Below Threshold', result: 'not-yet-checked', how: 'Check that nothing on the site flashes, the moving flow dashes included.' },
  { number: '2.4.3', name: 'Focus Order', result: 'not-yet-checked', how: 'Check that tabbing through every page moves focus in reading order, not only in page source order.' },
  { number: '2.4.5', name: 'Multiple Ways', result: 'not-yet-checked', how: 'Check that the title block on every page links to every other sheet.' },
  { number: '2.4.6', name: 'Headings and Labels', result: 'not-yet-checked', how: 'Check that every heading and control label says what its section or control is for.' },
  { number: '2.4.7', name: 'Focus Visible', result: 'not-yet-checked', how: 'Check that every link, button and radio shows its focus outline or ring in Light, Dark and Device.' },
  { number: '2.4.11', name: 'Focus Not Obscured (Minimum)', result: 'not-yet-checked', how: 'Check that at 320 pixels wide no focused element hides behind the sticky replay controls.' },
  { number: '2.5.1', name: 'Pointer Gestures', result: 'not-yet-checked', how: 'Check that nothing on the site needs a multipoint or path-based gesture.' },
  { number: '2.5.2', name: 'Pointer Cancellation', result: 'not-yet-checked', how: 'Check that pressing a button, link or radio and sliding off before release does nothing.' },
  { number: '2.5.4', name: 'Motion Actuation', result: 'not-yet-checked', how: 'Check that nothing on the site responds to moving or shaking the device.' },
  { number: '2.5.7', name: 'Dragging Movements', result: 'not-yet-checked', how: 'Check that nothing on the site needs dragging.' },
  { number: '3.2.1', name: 'On Focus', result: 'not-yet-checked', how: 'Check that focusing any control never changes the page, opens anything or moves focus.' },
  { number: '3.2.2', name: 'On Input', result: 'not-yet-checked', how: 'Check that choosing a theme by keyboard or pointer changes only the colours, with focus kept on the radio.' },
  { number: '3.2.3', name: 'Consistent Navigation', result: 'not-yet-checked', how: 'Check that the top bar and title block hold the same links in the same order on every page.' },
  { number: '3.2.4', name: 'Consistent Identification', result: 'not-yet-checked', how: 'Check that each control or link keeps one name for one function on every page, theme switch included.' },
  { number: '3.2.6', name: 'Consistent Help', result: 'not-yet-checked', how: 'Check that any help or contact route repeated across pages sits in the same order on each.' },
  { number: '3.3.1', name: 'Error Identification', result: 'not-yet-checked', how: NO_FORM },
  { number: '3.3.3', name: 'Error Suggestion', result: 'not-yet-checked', how: NO_FORM },
  { number: '3.3.4', name: 'Error Prevention (Legal, Financial, Data)', result: 'not-yet-checked', how: 'Check that nothing on the site submits data or commits a transaction.' },
  { number: '3.3.7', name: 'Redundant Entry', result: 'not-yet-checked', how: 'Check that the site asks for no information, so nothing has to be entered twice.' },
  { number: '3.3.8', name: 'Accessible Authentication (Minimum)', result: 'not-yet-checked', how: 'Check that the site has no sign-in or other authentication step.' },
  { number: '4.1.3', name: 'Status Messages', result: 'not-yet-checked', how: "Check that a screen reader announces the replay's step clock while focus stays on the step control." },
]);

export interface AccessibilityRecord {
  readonly target: string;
  readonly lastAutomatedAudit: string;
  readonly axeVersion: string;
  readonly tags: readonly string[];
  readonly enabledRules: readonly string[];
  readonly routes: readonly string[];
  readonly widths: readonly number[];
  readonly themes: readonly string[];
  readonly limitations: readonly Statement[];
  readonly contact: string;
}

// D-156 and UI-SPEC 11.8. A site test holds the tool fields equal to the harness's AXE_CONFIG, so the
// statement cannot claim an audit verify:ship does not run. The audit date is committed, never read
// from the build clock (AC-E12), and names the last automated run that passed.
export const ACCESSIBILITY_RECORD: AccessibilityRecord = Object.freeze({
  target: 'WCAG 2.2, level AA',
  lastAutomatedAudit: '2026-10-18',
  axeVersion: '4.14.0',
  tags: Object.freeze(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']),
  enabledRules: Object.freeze(['target-size', 'label-content-name-mismatch']),
  // The audit visits every route the sitemap lists, plus the page an unknown address shows.
  routes: Object.freeze(ROUTES.filter((route) => route.indexable).map((route) => route.path)),
  widths: Object.freeze([320, 1440]),
  themes: Object.freeze(['light', 'dark', 'device']),
  limitations: Object.freeze([
    { id: 'drawings', text: 'The flow drawings are images with text descriptions; every lane name and state they show is also in the page text.' },
    { id: 'hand-check', text: 'An automated audit cannot decide every criterion. Those listed under Checked by hand need a person in a real browser.' },
  ]),
  contact: `To report an accessibility problem, ${CONTROLLER.contact}.`,
});

// What the statement must say, each as the page renders it (AC-53).
export const accessibilityStatements = (record: AccessibilityRecord = ACCESSIBILITY_RECORD): Statement[] => [
  { id: 'target', text: record.target },
  { id: 'audit-date', text: record.lastAutomatedAudit },
  { id: 'tool', text: `axe-core ${record.axeVersion}` },
  ...record.limitations,
  { id: 'contact', text: record.contact },
];
