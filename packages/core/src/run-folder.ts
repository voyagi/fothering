import * as z from 'zod';
import { INCIDENT_PARTS, incidentItemKey, incidentLaneKey } from './evidence-record.js';
import { lanePartitionKey, PARTITION_KEY } from './records.js';
import { REOPEN_COMMAND_TEMPLATE, REOPEN_FUNCTION_NAME_SLOT } from './reopen.js';

// The raw-file contract of a live run (D-178). Removal deletes the log groups, the table and the
// decision items, so a file this list does not name can never be read after the first destroy.

export const RUN_FOLDER_ROOT = 'reports/live-runs';

export const FOTHERING_STACK_NAMES = ['FotheringIngest', 'FotheringRuntime', 'FotheringDetection', 'FotheringAction'] as const;

const REGION = 'eu-central-1';
const LIVE_RUN_ROLE_PATH = '/fothering-live-run/';

export type RunFolderExpansion = 'step' | 'stack' | 'set';

export interface RunFolderFile {
  /** Relative to the run folder; a file with `expands` names one path per step, stack or set. */
  path: string;
  expands?: RunFolderExpansion;
  producer: 'command' | 'runbook';
  phase: 'pre-removal' | 'after-removal';
  appliesTo: 'all' | 'close';
  /** items: the saved output of a DynamoDB query, read only through the providers items reader. */
  format: 'json' | 'jsonl' | 'items';
  /** The top-level key (on every line, for jsonl) that shows the file holds the read it names. */
  envelope: string;
  /** Whether the read can rightly find nothing, so an empty envelope list is not a finding. */
  emptyAllowed: boolean;
  command?: string;
  /** Each slot in the path or the command, and where its value comes from. */
  slots: Readonly<Record<string, string>>;
}

const EXPANSION_SLOT: Readonly<Record<RunFolderExpansion, string>> = { step: '<step>', stack: '<StackName>', set: '<set>' };

const SLOT_SOURCES: Readonly<Record<string, string>> = {
  '<step>': "each step of the run's scenario in docs/measurement-scenarios.json",
  '<StackName>': 'each name in FOTHERING_STACK_NAMES',
  '<set>': 'each configuration set in lanes.json',
  '<lane>': "the scenario's lane in docs/measurement-scenarios.json",
  '<TableName>': 'Environment.Variables.FOTHERING_TABLE_NAME in aws/reopen-function.json',
  '<ReopenFunctionName>': 'the FotheringAction output ReopenFunctionName in aws/stacks.json',
  '<IncidentId>': `the incidentId of the ${incidentLaneKey('<lane>').sk} item in aws/items-pointers.json`,
  '<StackId>': 'the StackId of <StackName> in aws/stacks.json',
};

function slotsOf(...texts: readonly string[]): Record<string, string> {
  const names = texts.flatMap((text) => text.match(/<[A-Za-z]+>/g) ?? []);
  return Object.fromEntries(names.map((name) => [name, SLOT_SOURCES[name] ?? 'unknown']));
}

type FileFields = Omit<RunFolderFile, 'slots'>;

function entry(fields: FileFields): RunFolderFile {
  return { ...fields, slots: slotsOf(fields.path, fields.command ?? '') };
}

function written(suffix: string, format: 'json' | 'jsonl', envelope: string): RunFolderFile {
  return entry({ path: `run/<step>.${suffix}`, expands: 'step', producer: 'command', phase: 'pre-removal', appliesTo: 'all', format, envelope, emptyAllowed: false });
}

function read(path: string, envelope: string, command: string, fields: Partial<FileFields> = {}): RunFolderFile {
  return entry({ path, producer: 'runbook', phase: 'pre-removal', appliesTo: 'all', format: 'json', envelope, emptyAllowed: false, command, ...fields });
}

// Every read asks for JSON itself, so a profile whose default output is text or a table still
// saves a file the checker and the capture can parse.
function cli(...parts: readonly string[]): string {
  return [...parts, '--output json'].join(' ');
}

function queryCommand(partitionKey: string): string {
  return cli(
    'aws dynamodb query',
    `--region ${REGION}`,
    '--table-name <TableName>',
    "--key-condition-expression '#pk = :pk'",
    `--expression-attribute-names '{"#pk":"${PARTITION_KEY}"}'`,
    `--expression-attribute-values '{":pk":{"S":"${partitionKey}"}}'`,
  );
}

const REOPEN_SAVE_COMMAND = REOPEN_COMMAND_TEMPLATE.replace(REOPEN_FUNCTION_NAME_SLOT, '<ReopenFunctionName>')
  .replace('{set}', '<lane>')
  .replace(/result\.json$/, 'aws/reopen-result.json');

export const RUN_FOLDER_FILES: readonly RunFolderFile[] = [
  written('account.json', 'json', 'requestId'),
  written('callers.json', 'json', 'lanes'),
  written('attempts.jsonl', 'jsonl', 'lane'),
  entry({ path: 'aws/saved.jsonl', producer: 'runbook', phase: 'pre-removal', appliesTo: 'all', format: 'jsonl', envelope: 'savedAtUtc', emptyAllowed: false }),
  read('aws/stacks.json', 'Stacks', cli('aws cloudformation describe-stacks', `--region ${REGION}`)),
  read('aws/templates/<StackName>.json', 'TemplateBody', cli('aws cloudformation get-template', `--region ${REGION}`, '--template-stage Original', '--stack-name <StackName>'), {
    expands: 'stack',
  }),
  read('aws/reopen-function.json', 'FunctionArn', cli('aws lambda get-function-configuration', `--region ${REGION}`, '--function-name <ReopenFunctionName>'), {
    appliesTo: 'close',
  }),
  read('aws/items-pointers.json', 'Items', queryCommand(incidentLaneKey('<lane>').pk), { format: 'items' }),
  read('aws/items-incident.json', 'Items', queryCommand(incidentItemKey('<IncidentId>', INCIDENT_PARTS[0]).pk), { format: 'items' }),
  read('aws/items-lane-<set>.json', 'Items', queryCommand(lanePartitionKey('<set>')), { format: 'items', expands: 'set', emptyAllowed: true }),
  read('aws/reopen-result.json', 'result', REOPEN_SAVE_COMMAND, { appliesTo: 'close' }),
  read('aws/sets-before-removal/<set>.json', 'SendingOptions', cli('aws sesv2 get-configuration-set', `--region ${REGION}`, '--configuration-set-name <set>'), {
    expands: 'set',
  }),
  read('aws/after-removal/stack-<StackName>.json', 'Stacks', cli('aws cloudformation describe-stacks', `--region ${REGION}`, '--stack-name <StackId>'), {
    expands: 'stack',
    phase: 'after-removal',
  }),
  read('aws/after-removal/resources-<StackName>.json', 'StackResourceSummaries', cli('aws cloudformation list-stack-resources', `--region ${REGION}`, '--stack-name <StackId>'), {
    expands: 'stack',
    phase: 'after-removal',
  }),
  read('aws/after-removal/log-groups.json', 'logGroups', cli('aws logs describe-log-groups', `--region ${REGION}`), { phase: 'after-removal', emptyAllowed: true }),
  read('aws/after-removal/roles.json', 'Roles', cli('aws iam list-roles', `--path-prefix ${LIVE_RUN_ROLE_PATH}`), { phase: 'after-removal', emptyAllowed: true }),
];

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;
const savedAtUtc = z.string().regex(ISO_UTC);

export const savedLogLineSchema = z.union([
  z.strictObject({ file: z.string().regex(/^aws\/[A-Za-z0-9._/-]+$/), savedAtUtc }),
  z.strictObject({ event: z.literal('deploy-finished'), deployCommit: z.string().regex(/^[0-9a-f]{40}$/), savedAtUtc }),
  z.strictObject({ event: z.literal('destroy-started'), savedAtUtc }),
]);

export interface CheckSavedScenario {
  lane: string;
  outcome: 'close' | 'unknown';
  steps: readonly string[];
}

export interface RunFolderContext {
  scenario: CheckSavedScenario;
  /** Every configuration set in the lane map. */
  sets: readonly string[];
  afterRemoval: boolean;
}

export interface ExpectedRunFolderFile {
  path: string;
  file: RunFolderFile;
}

function applies(file: RunFolderFile, context: RunFolderContext): boolean {
  if (file.phase === 'after-removal' && !context.afterRemoval) return false;
  return file.appliesTo === 'all' || context.scenario.outcome === 'close';
}

/** The concrete paths a run folder must hold, in contract order. */
export function expectedRunFolderFiles(context: RunFolderContext): ExpectedRunFolderFile[] {
  const values: Readonly<Record<RunFolderExpansion, readonly string[]>> = { step: context.scenario.steps, stack: FOTHERING_STACK_NAMES, set: context.sets };
  return RUN_FOLDER_FILES.filter((file) => applies(file, context)).flatMap((file) => {
    const { expands } = file;
    if (expands === undefined) return [{ path: file.path, file }];
    return values[expands].map((value) => ({ path: file.path.replace(EXPANSION_SLOT[expands], value), file }));
  });
}

export type SavedFileContent =
  | { kind: 'missing' }
  | { kind: 'unreadable' }
  | { kind: 'text'; text: string }
  | { kind: 'items'; items: readonly Record<string, unknown>[] }
  | { kind: 'items-refused'; errorName: string };

export interface CheckSavedInput extends RunFolderContext {
  runId: string;
  /** Keyed by the path relative to the run folder. */
  files: ReadonlyMap<string, SavedFileContent>;
}

export interface CheckSavedResult {
  ok: boolean;
  /** One line per problem, naming the file or the part, never a value read from a file. */
  findings: string[];
  checked: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parsedValues(text: string, format: 'json' | 'jsonl'): unknown[] | undefined {
  try {
    return format === 'json' ? [JSON.parse(text)] : text.split('\n').filter((line) => line !== '').map((line) => JSON.parse(line) as unknown);
  } catch {
    return undefined;
  }
}

function textFindings(path: string, file: RunFolderFile, text: string): string[] {
  if (file.format === 'items') return [`${path}: was not read as DynamoDB items`];
  const values = parsedValues(text, file.format);
  if (values === undefined) return [`${path}: is not JSON`];
  return values.some((value) => !isRecord(value) || value[file.envelope] === undefined) ? [`${path}: holds no ${file.envelope}`] : [];
}

const SAVED_LOG_PATH = 'aws/saved.jsonl';

function savedLogFindings(text: string): string[] {
  const lines = parsedValues(text, 'jsonl');
  if (lines === undefined) return [`${SAVED_LOG_PATH}: is not JSON`];
  return lines.some((line) => !savedLogLineSchema.safeParse(line).success) ? [`${SAVED_LOG_PATH}: holds a line that is not a save log line`] : [];
}

function fileFindings(path: string, file: RunFolderFile, content: SavedFileContent = { kind: 'missing' }): string[] {
  if (content.kind === 'missing') return [`${path}: is missing`];
  if (content.kind === 'unreadable') return [`${path}: could not be read`];
  if (content.kind === 'items-refused') return [`${path}: the items reader refused it (${content.errorName})`];
  if (content.kind === 'items') return [];
  return path === SAVED_LOG_PATH ? savedLogFindings(content.text) : textFindings(path, file, content.text);
}

export function checkSavedFolder(input: CheckSavedInput): CheckSavedResult {
  const expected = expectedRunFolderFiles(input);
  const findings = expected.flatMap(({ path, file }) => fileFindings(path, file, input.files.get(path)));
  return { ok: findings.length === 0, findings, checked: expected.length };
}
