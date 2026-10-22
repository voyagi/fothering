import { readRepoJson } from './repo-facts.js';

const SOURCE = 'packages/infra/permissions.json';

interface KeyFields {
  stack: string;
  role: string;
  kind: string;
  effect: string;
  action: string;
}

interface PermissionEntry extends KeyFields {
  resource: string | null;
  principal: string | null;
  condition: string | null;
}

interface PermissionRow extends KeyFields {
  /** The resource of a permission row, the principal of a trust row. */
  resourceOrPrincipal: string;
  /** Empty when the statement has no Condition. */
  condition: string;
  reason: string;
}

interface PermissionSchedule {
  stack: string;
  role: string;
  rows: PermissionRow[];
}

type Reasons = Readonly<Record<string, string>>;

const LAMBDA_TRUST = 'Only the Lambda service may take on this role, to run the function the stack attaches it to.';

// The account-level Deny every role carries (packages/infra/src/account-deny.ts), one reason per action.
const DENY_ACCOUNT_SENDING =
  'Turns sending off or on for the whole account, which Fothering never does. A Deny outranks every Allow, so no later grant or wildcard on the role can reach it.';
const DENY_V1_ACCOUNT_SENDING = 'The SES v1 call that turns sending off or on for the whole account in the Region. A Deny outranks every Allow.';
const DENY_V1_SET_SENDING =
  'The SES v1 call that turns sending off or on for a configuration set, so the only pause left is the API v2 call granted on the closeable sets.';

function accountDenyReasons(stackAndRole: string): Record<string, string> {
  return {
    [`${stackAndRole}/permission/Deny/ses:PutAccountSendingAttributes`]: DENY_ACCOUNT_SENDING,
    [`${stackAndRole}/permission/Deny/ses:UpdateAccountSendingEnabled`]: DENY_V1_ACCOUNT_SENDING,
    [`${stackAndRole}/permission/Deny/ses:UpdateConfigurationSetSendingEnabled`]: DENY_V1_SET_SENDING,
  };
}

// One reason per `<stack>/<role without its 8-hex CDK suffix>/<kind>/<effect>/<action>`, so a
// logical id that changes its hash keeps its reason, and a new grant fails the tests until it has one.
export const PERMISSION_REASONS: Reasons = {
  'FotheringAction/ActionRole/permission/Allow/dynamodb:GetItem':
    "Reads an incident's evidence record, state, decision and closure, and a lane's incident marker and pause pointer, each by its key.",
  'FotheringAction/ActionRole/permission/Allow/dynamodb:PutItem':
    "Writes an incident's closure claim and a lane's pause pointer, each only where none is held yet, so two overlapping runs cannot both claim one closure or one lane.",
  'FotheringAction/ActionRole/permission/Allow/dynamodb:Query':
    "Reads the paused lane's stored events for the hold check, which counts any send the set still recorded after the pause had time to hold.",
  'FotheringAction/ActionRole/permission/Allow/dynamodb:UpdateItem':
    "Moves a closure on by versioned update (its pause, read-back and hold check results, and the operator email's state), moves a lane's pause pointer, and counts pause attempts per lane and hour against the cap.",
  'FotheringAction/ActionRole/permission/Allow/logs:CreateLogStream': "Opens a log stream in the action function's own log group.",
  'FotheringAction/ActionRole/permission/Allow/logs:PutLogEvents': "Writes the action function's log lines to its own log group.",
  'FotheringAction/ActionRole/permission/Allow/secretsmanager:GetSecretValue':
    'Reads the address key only so a dry-run send line shows the From and To addresses as pseudonyms.',
  'FotheringAction/ActionRole/permission/Allow/ses:GetConfigurationSet':
    "Reads a configuration set's sending switch back after the pause, to prove it took; granted only on the sets the lane map lets Fothering close.",
  'FotheringAction/ActionRole/permission/Allow/ses:GetConfigurationSetEventDestinations':
    'Reads where a configuration set publishes its events, for the closeability check the action repeats before it pauses; granted only on the sets the lane map names.',
  'FotheringAction/ActionRole/permission/Allow/ses:GetEmailIdentity':
    "Reads a sending identity's verification, DKIM and MAIL FROM settings, for the closeability check the action repeats before it pauses.",
  'FotheringAction/ActionRole/permission/Allow/ses:ListConfigurationSets':
    "Lists the account's configuration sets, for the closeability check the action repeats before it pauses. The action has no resource type, so it can only be granted on every resource.",
  'FotheringAction/ActionRole/permission/Allow/ses:ListEmailIdentities':
    "Lists the account's sending identities, for the closeability check the action repeats before it pauses. The action has no resource type, so it can only be granted on every resource.",
  'FotheringAction/ActionRole/permission/Allow/ses:PutConfigurationSetSendingOptions':
    "Turns sending off for the one configuration set an incident's evidence names; granted only on the sets the lane map lets Fothering close, so no other set can be paused.",
  'FotheringAction/ActionRole/permission/Allow/ses:SendEmail':
    'Sends the operator email, only from the From address or its domain. The operator-alert configuration set is the only one a send can go through, and the action function names it on every send.',
  'FotheringAction/ActionRole/trust/Allow/sts:AssumeRole': LAMBDA_TRUST,
  ...accountDenyReasons('FotheringAction/ActionRole'),
  'FotheringAction/ReopenRole/permission/Allow/dynamodb:GetItem': "Reads a lane's pause pointer and the closure it points at, by their keys.",
  'FotheringAction/ReopenRole/permission/Allow/dynamodb:UpdateItem':
    "Moves the closure's reopen record on by versioned update, and counts the attempt against the same lane-hour cap the pause counts against.",
  'FotheringAction/ReopenRole/permission/Allow/logs:CreateLogStream': "Opens a log stream in the reopen function's own log group.",
  'FotheringAction/ReopenRole/permission/Allow/logs:PutLogEvents': "Writes the reopen function's log lines to its own log group.",
  'FotheringAction/ReopenRole/permission/Allow/ses:GetConfigurationSet':
    "Reads the set's sending switch back after the reopen, to prove sending is on again; granted only on the sets the lane map lets Fothering close.",
  'FotheringAction/ReopenRole/permission/Allow/ses:PutConfigurationSetSendingOptions':
    'Turns sending back on for a set Fothering paused, when the operator runs the reopen command; granted only on the sets the lane map lets Fothering close.',
  'FotheringAction/ReopenRole/trust/Allow/sts:AssumeRole': LAMBDA_TRUST,
  ...accountDenyReasons('FotheringAction/ReopenRole'),
  ...accountDenyReasons('FotheringDetection/DetectRole'),
  ...accountDenyReasons('FotheringIngest/ForgetRole'),
  ...accountDenyReasons('FotheringIngest/IngestRole'),
  ...accountDenyReasons('FotheringRuntime/RuntimeRole'),
  'FotheringDetection/DetectRole/permission/Allow/bedrock-agentcore:InvokeAgentRuntime':
    'Invokes the agent runtime for an incident the stored events opened, within the per-incident and per-day caps; it may invoke this runtime and its endpoints only.',
  'FotheringDetection/DetectRole/permission/Allow/dynamodb:GetItem':
    "Reads a lane's incident marker, or an incident's evidence, state or decision item, by its key.",
  'FotheringDetection/DetectRole/permission/Allow/dynamodb:PutItem': 'Writes a new incident, evidence or decision item to the table.',
  'FotheringDetection/DetectRole/permission/Allow/dynamodb:Query': "Reads a lane's stored events to fold the detection window.",
  'FotheringDetection/DetectRole/permission/Allow/dynamodb:UpdateItem':
    "Moves a lane's incident marker and an incident's state on, and reserves the per-incident and per-day invocation counters before the runtime is invoked.",
  'FotheringDetection/DetectRole/permission/Allow/logs:CreateLogStream': "Opens a log stream in the detection function's own log group.",
  'FotheringDetection/DetectRole/permission/Allow/logs:PutLogEvents': "Writes the detection function's log lines to its own log group.",
  'FotheringDetection/DetectRole/permission/Allow/ses:GetConfigurationSetEventDestinations':
    'Reads where a configuration set publishes its events, for the closeability check; granted only on the sets the lane map names.',
  'FotheringDetection/DetectRole/permission/Allow/ses:GetEmailIdentity':
    "Reads a sending identity's verification, DKIM and MAIL FROM settings, for the closeability check.",
  'FotheringDetection/DetectRole/permission/Allow/ses:ListConfigurationSets':
    "Lists the account's configuration sets, for the closeability check. The action has no resource type, so it can only be granted on every resource.",
  'FotheringDetection/DetectRole/permission/Allow/ses:ListEmailIdentities':
    "Lists the account's sending identities, for the closeability check. The action has no resource type, so it can only be granted on every resource.",
  'FotheringDetection/DetectRole/trust/Allow/sts:AssumeRole': LAMBDA_TRUST,
  'FotheringIngest/ForgetRole/permission/Allow/dynamodb:DeleteItem': 'Deletes the stored events that the recipient index query found for the recipient being forgotten.',
  'FotheringIngest/ForgetRole/permission/Allow/dynamodb:Query':
    'Finds the events of the recipient being forgotten through the recipient index; it may query that index only, never the table itself.',
  'FotheringIngest/ForgetRole/permission/Allow/logs:CreateLogStream': "Opens a log stream in the forget function's own log group.",
  'FotheringIngest/ForgetRole/permission/Allow/logs:PutLogEvents': "Writes the forget function's log lines to its own log group.",
  'FotheringIngest/ForgetRole/permission/Allow/secretsmanager:GetSecretValue':
    'Reads the address key, so the address to forget is hashed the same way ingest hashed it when storing.',
  'FotheringIngest/ForgetRole/trust/Allow/sts:AssumeRole': LAMBDA_TRUST,
  'FotheringIngest/IngestRole/permission/Allow/dynamodb:PutItem': 'Stores each SES event after the minimizer has cut it down to the kept fields.',
  'FotheringIngest/IngestRole/permission/Allow/logs:CreateLogStream': "Opens a log stream in the ingest function's own log group.",
  'FotheringIngest/IngestRole/permission/Allow/logs:PutLogEvents': "Writes the ingest function's log lines to its own log group.",
  'FotheringIngest/IngestRole/permission/Allow/secretsmanager:GetSecretValue':
    'Reads the address key that turns each recipient address into a keyed hash before anything is stored.',
  'FotheringIngest/IngestRole/permission/Allow/sqs:SendMessage': 'Puts an event it could not write to the table on the dead-letter queue, so it is not lost.',
  'FotheringIngest/IngestRole/trust/Allow/sts:AssumeRole': LAMBDA_TRUST,
  'FotheringRuntime/RuntimeRole/permission/Allow/bedrock:InvokeModel':
    'Calls the pinned model through its EU inference profile. The model grants in the EU Regions the profile routes to hold only for a call made through that profile.',
  'FotheringRuntime/RuntimeRole/permission/Allow/logs:CreateLogStream': "Opens a log stream in the agent runtime's own log group.",
  'FotheringRuntime/RuntimeRole/permission/Allow/logs:DescribeLogGroups':
    "Lets AgentCore find the runtime's log group among the account's log groups; it returns names and settings, never log lines.",
  'FotheringRuntime/RuntimeRole/permission/Allow/logs:DescribeLogStreams': "Lets AgentCore list the streams of the runtime's own log group.",
  'FotheringRuntime/RuntimeRole/permission/Allow/logs:PutLogEvents': "Writes the agent runtime's log lines to its own log group.",
  'FotheringRuntime/RuntimeRole/trust/Allow/sts:AssumeRole':
    'Only AgentCore may take on this role, and only for a runtime in this account and Region.',
};

const KINDS = new Set(['permission', 'trust']);
const EFFECTS = new Set(['Allow', 'Deny']);
const SORT_FIELDS = ['stack', 'role', 'kind', 'action', 'resource', 'principal', 'condition', 'effect'] as const;

function malformed(index: number, field: string, problem: string): Error {
  return new Error(`${SOURCE}: [${index}].${field}: ${problem}. Run npm run permissions:snapshot.`);
}

// The site carries no schema library of its own, so the guard is written out and names the first
// field that does not hold what the snapshot writer produces.
function permissionEntry(value: unknown, index: number): PermissionEntry {
  const entry = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>;
  for (const field of ['stack', 'role', 'kind', 'effect', 'action']) {
    if (typeof entry[field] !== 'string' || entry[field] === '') throw malformed(index, field, 'missing or not text');
  }
  for (const field of ['resource', 'principal', 'condition']) {
    if (entry[field] !== null && typeof entry[field] !== 'string') throw malformed(index, field, 'neither text nor null');
  }
  if (!KINDS.has(entry.kind as string)) throw malformed(index, 'kind', `'${String(entry.kind)}' is not one of permission, trust`);
  if (!EFFECTS.has(entry.effect as string)) throw malformed(index, 'effect', `'${String(entry.effect)}' is not one of Allow, Deny`);
  return entry as unknown as PermissionEntry;
}

function permissionEntries(values: readonly unknown[]): PermissionEntry[] {
  if (values.length === 0) throw new Error(`${SOURCE}: no entries. Run npm run permissions:snapshot.`);
  return values.map(permissionEntry);
}

// The snapshot writer's own order (code-unit text order, field by field), applied again here so a
// file whose entries were shuffled renders the same table.
function compareEntries(a: PermissionEntry, b: PermissionEntry): number {
  for (const field of SORT_FIELDS) {
    const left = a[field] ?? '';
    const right = b[field] ?? '';
    if (left !== right) return left < right ? -1 : 1;
  }
  return 0;
}

function roleName(role: string): string {
  return role.replace(/[0-9A-F]{8}$/, '');
}

export function permissionKey(entry: KeyFields): string {
  return `${entry.stack}/${roleName(entry.role)}/${entry.kind}/${entry.effect}/${entry.action}`;
}

export function loadPermissionSnapshot(root: string): unknown[] {
  const parsed = readRepoJson(SOURCE, root, 'Run npm run permissions:snapshot.');
  if (!Array.isArray(parsed)) throw new Error(`${SOURCE}: not a list. Run npm run permissions:snapshot.`);
  return parsed;
}

function checkReasons(entries: readonly PermissionEntry[], reasons: Reasons): void {
  const keys = new Set(entries.map(permissionKey));
  for (const key of keys) {
    if (!Object.hasOwn(reasons, key) || reasons[key]?.trim() === '') {
      throw new Error(`permission reasons: no reason for ${key}. Add one to the reasons map.`);
    }
  }
  for (const key of Object.keys(reasons)) {
    if (!keys.has(key)) throw new Error(`permission reasons: ${key} matches no entry in ${SOURCE}. Remove it from the reasons map.`);
  }
}

function rowOf(entry: PermissionEntry, reasons: Reasons): PermissionRow {
  return {
    stack: entry.stack,
    role: entry.role,
    kind: entry.kind,
    effect: entry.effect,
    action: entry.action,
    resourceOrPrincipal: entry.resource ?? entry.principal ?? '',
    condition: entry.condition ?? '',
    reason: reasons[permissionKey(entry)] ?? '',
  };
}

export function permissionSchedules(values: readonly unknown[], reasons: Reasons = PERMISSION_REASONS): PermissionSchedule[] {
  const entries = permissionEntries(values).sort(compareEntries);
  checkReasons(entries, reasons);
  const schedules = new Map<string, PermissionSchedule>();
  for (const entry of entries) {
    const id = JSON.stringify([entry.stack, entry.role]);
    const schedule = schedules.get(id) ?? { stack: entry.stack, role: entry.role, rows: [] };
    schedule.rows.push(rowOf(entry, reasons));
    schedules.set(id, schedule);
  }
  // The deploy page ids each role's section by the role name alone, so one name on two roles would
  // give two sections one id and break the label that points at it.
  const stackOfName = new Map<string, string>();
  for (const schedule of schedules.values()) {
    const name = roleName(schedule.role);
    const other = stackOfName.get(name);
    if (other !== undefined) throw new Error(`${SOURCE}: two roles are named ${name}, in ${other} and ${schedule.stack}, and the deploy page ids each role section by its name. Rename one of them.`);
    stackOfName.set(name, schedule.stack);
  }
  return [...schedules.values()];
}

export function denyRows(values: readonly unknown[], reasons: Reasons = PERMISSION_REASONS): PermissionRow[] {
  const schedules = permissionSchedules(values, reasons);
  const rows = schedules.flatMap((schedule) => schedule.rows).filter((row) => row.effect === 'Deny');
  // The deploy page heads the Deny box "Denied on every role", so a Deny that some role lacks is
  // refused rather than printed under that heading.
  for (const action of new Set(rows.map((row) => row.action))) {
    const lacking = schedules.filter((schedule) => !schedule.rows.some((row) => row.effect === 'Deny' && row.action === action));
    if (lacking.length > 0) {
      const names = lacking.map((schedule) => `${schedule.stack}/${roleName(schedule.role)}`).join(', ');
      throw new Error(`${SOURCE}: ${action} is denied on some roles but not on ${names}, and the deploy page heads the Deny box "Denied on every role". Deny it on every role, or retitle the box.`);
    }
  }
  return rows;
}

function grants(entry: PermissionEntry, pattern: RegExp): boolean {
  return entry.kind === 'permission' && entry.effect === 'Allow' && pattern.test(entry.action);
}

const PAUSE_ACTION = 'ses:PutConfigurationSetSendingOptions';

// A granted IAM action is a pattern: names are case-insensitive, * matches any run of characters and
// ? any one character, so ses:*, ses:Put* and a bare * all cover the pause action.
function actionPattern(granted: string): RegExp {
  const source = Array.from(granted, (character) => {
    if (character === '*') return '.*';
    if (character === '?') return '.';
    return character.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }).join('');
  return new RegExp(`^${source}$`, 'i');
}

// The deploy page's NOT YET notice stays until some role is allowed to pause a lane, by name or by a
// wildcard; a Deny of the action alone grants nothing.
export function hasPauseGrant(values: readonly unknown[]): boolean {
  return permissionEntries(values).some((entry) => entry.kind === 'permission' && entry.effect === 'Allow' && actionPattern(entry.action).test(PAUSE_ACTION));
}

// IAM action names are case-insensitive, and a bare * covers every service.
const DATA_ACTION = /^(?:(?:ses|dynamodb|s3):.+|\*)$/i;

export function runtimeRoleHoldsNoDataAction(values: readonly unknown[]): boolean {
  const runtime = permissionEntries(values).filter((entry) => entry.stack === 'FotheringRuntime' && roleName(entry.role) === 'RuntimeRole');
  // An absent role would make the sentence true of nothing, so it is refused rather than printed.
  if (runtime.length === 0) throw new Error(`${SOURCE}: no entry for the runtime role FotheringRuntime/RuntimeRole. Run npm run permissions:snapshot.`);
  return !runtime.some((entry) => grants(entry, DATA_ACTION));
}
