import { readRepoText } from './repo-facts.js';

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

// One reason per `<stack>/<role without its 8-hex CDK suffix>/<kind>/<effect>/<action>`, so a
// logical id that changes its hash keeps its reason, and a new grant fails the tests until it has one.
export const PERMISSION_REASONS: Reasons = {
  'FotheringDetection/DetectRole/permission/Allow/bedrock-agentcore:InvokeAgentRuntime':
    'Invokes the agent runtime for an incident the stored events opened, within the per-incident and per-day caps; it may invoke this runtime and its endpoints only.',
  'FotheringDetection/DetectRole/permission/Allow/dynamodb:GetItem': 'Reads one incident, evidence, decision or counter item by its key.',
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
  const parsed: unknown = JSON.parse(readRepoText(SOURCE, root));
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
  return [...schedules.values()];
}

export function denyRows(values: readonly unknown[], reasons: Reasons = PERMISSION_REASONS): PermissionRow[] {
  return permissionSchedules(values, reasons)
    .flatMap((schedule) => schedule.rows)
    .filter((row) => row.effect === 'Deny');
}

function grants(entry: PermissionEntry, pattern: RegExp): boolean {
  return entry.kind === 'permission' && entry.effect === 'Allow' && pattern.test(entry.action);
}

// The deploy page's NOT YET notice stays until some role is allowed to pause a lane; a Deny of the
// action alone grants nothing.
export function hasPauseGrant(values: readonly unknown[]): boolean {
  return permissionEntries(values).some((entry) => grants(entry, /^ses:PutConfigurationSetSendingOptions$/i));
}

// IAM action names are case-insensitive, and a bare * covers every service.
const DATA_ACTION = /^(?:(?:ses|dynamodb|s3):.+|\*)$/i;

export function runtimeRoleHoldsNoDataAction(values: readonly unknown[]): boolean {
  const runtime = permissionEntries(values).filter((entry) => entry.stack === 'FotheringRuntime' && roleName(entry.role) === 'RuntimeRole');
  // An absent role would make the sentence true of nothing, so it is refused rather than printed.
  if (runtime.length === 0) throw new Error(`${SOURCE}: no entry for the runtime role FotheringRuntime/RuntimeRole. Run npm run permissions:snapshot.`);
  return !runtime.some((entry) => grants(entry, DATA_ACTION));
}
