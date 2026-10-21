import * as z from 'zod';
import { INCIDENT_PARTS, incidentItemKey, incidentLaneKey, incidentPauseKey, type IncidentPart } from './evidence-record.js';
import { lanePartitionKey, PARTITION_KEY, SORT_KEY, type EventRecord, type RecordKey } from './records.js';
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

const POINTERS_PATH = 'aws/items-pointers.json';
const INCIDENT_PATH = 'aws/items-incident.json';
const LANE_ITEMS_PATH = 'aws/items-lane-<set>.json';
const REOPEN_RESULT_PATH = 'aws/reopen-result.json';
const SETS_BEFORE_REMOVAL_PREFIX = 'aws/sets-before-removal/';

function laneItemsPath(set: string): string {
  return LANE_ITEMS_PATH.replace(EXPANSION_SLOT.set, set);
}

function incidentPartitionKey(incidentId: string): string {
  return incidentItemKey(incidentId, INCIDENT_PARTS[0]).pk;
}

const REOPEN_SAVE_COMMAND = REOPEN_COMMAND_TEMPLATE.replace(REOPEN_FUNCTION_NAME_SLOT, '<ReopenFunctionName>')
  .replace('{set}', '<lane>')
  .replace(/result\.json$/, REOPEN_RESULT_PATH);

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
  read(POINTERS_PATH, 'Items', queryCommand(incidentLaneKey('<lane>').pk), { format: 'items' }),
  read(INCIDENT_PATH, 'Items', queryCommand(incidentPartitionKey('<IncidentId>')), { format: 'items' }),
  read(LANE_ITEMS_PATH, 'Items', queryCommand(lanePartitionKey('<set>')), { format: 'items', expands: 'set', emptyAllowed: true }),
  read(REOPEN_RESULT_PATH, 'result', REOPEN_SAVE_COMMAND, { appliesTo: 'close' }),
  read(`${SETS_BEFORE_REMOVAL_PREFIX}<set>.json`, 'SendingOptions', cli('aws sesv2 get-configuration-set', `--region ${REGION}`, '--configuration-set-name <set>'), {
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

type Items = readonly Record<string, unknown>[];

/** A file's own findings and, only when it read cleanly, what it held, for the checks across files. */
interface FileRead {
  findings: string[];
  values?: unknown[];
  items?: Items;
}

// A JSONL file always ends in a newline, so a last line without one is a torn write: the whole
// file reads as a finding rather than the torn line being dropped and the rest passing.
function parseText(path: string, file: RunFolderFile, text: string): { values: unknown[] } | { finding: string } {
  if (text.trim() === '') return { finding: `${path}: is empty` };
  if (file.format === 'items') return { finding: `${path}: was not read as DynamoDB items` };
  if (file.format === 'jsonl' && !text.endsWith('\n')) return { finding: `${path}: the last line has no newline` };
  try {
    const values = file.format === 'json' ? [JSON.parse(text) as unknown] : text.slice(0, -1).split('\n').map((line) => JSON.parse(line) as unknown);
    return { values };
  } catch {
    return { finding: `${path}: is not JSON` };
  }
}

function envelopeFindings(path: string, file: RunFolderFile, values: readonly unknown[]): string[] {
  if (values.some((value) => !isRecord(value) || value[file.envelope] === undefined)) return [`${path}: holds no ${file.envelope}`];
  const first = values[0];
  const list = isRecord(first) ? first[file.envelope] : undefined;
  return !file.emptyAllowed && Array.isArray(list) && list.length === 0 ? [`${path}: its ${file.envelope} list is empty`] : [];
}

const SAVED_LOG_PATH = 'aws/saved.jsonl';
const DEPLOY_COMMIT = /^[0-9a-f]{40}$/;

type SavedLogLine = z.infer<typeof savedLogLineSchema>;

function savedLineFinding(line: unknown, index: number): string[] {
  if (savedLogLineSchema.safeParse(line).success) return [];
  const at = `${SAVED_LOG_PATH} line ${index + 1}`;
  const badCommit = isRecord(line) && line.event === 'deploy-finished' && !(typeof line.deployCommit === 'string' && DEPLOY_COMMIT.test(line.deployCommit));
  return [badCommit ? `${at}: the deploy commit is not 40 lowercase hex` : `${at}: is not a save log line`];
}

function readFile(path: string, file: RunFolderFile, content: SavedFileContent = { kind: 'missing' }): FileRead {
  if (content.kind === 'missing') return { findings: [`${path}: is missing`] };
  if (content.kind === 'unreadable') return { findings: [`${path}: could not be read`] };
  if (content.kind === 'items-refused') return { findings: [`${path}: the items reader refused it (${content.errorName})`] };
  if (content.kind === 'items') return { findings: [], items: content.items };
  const parsed = parseText(path, file, content.text);
  if ('finding' in parsed) return { findings: [parsed.finding] };
  const findings = path === SAVED_LOG_PATH ? parsed.values.flatMap(savedLineFinding) : envelopeFindings(path, file, parsed.values);
  return findings.length === 0 ? { findings, values: parsed.values } : { findings };
}

const STACKS_PATH = 'aws/stacks.json';

function stacksFindings(values: readonly unknown[] | undefined): string[] {
  const first = values?.[0];
  const stacks = isRecord(first) ? first.Stacks : undefined;
  if (!Array.isArray(stacks)) return [];
  const names = new Set(stacks.filter(isRecord).map((stack) => stack.StackName));
  return FOTHERING_STACK_NAMES.filter((name) => !names.has(name)).map((name) => `${STACKS_PATH}: names no stack ${name}`);
}

const RUN_ID_FIELD = 'runId' satisfies keyof EventRecord;
const DECIDED_PARTS: readonly IncidentPart[] = INCIDENT_PARTS.filter((part) => part === 'EVIDENCE' || part === 'DECISION');
const CLOSED_PARTS: readonly IncidentPart[] = INCIDENT_PARTS.filter((part) => part === 'EVIDENCE' || part === 'DECISION' || part === 'CLOSURE');

function hasKey(items: Items, key: RecordKey): boolean {
  return items.some((item) => item[PARTITION_KEY] === key.pk && item[SORT_KEY] === key.sk);
}

function outsidePartition(path: string, items: Items, partition: string): string[] {
  return items.some((item) => item[PARTITION_KEY] !== partition) ? [`${path}: holds an item outside its partition`] : [];
}

function markerIncidentId(items: Items, lane: string): string | undefined {
  const key = incidentLaneKey(lane);
  const marker = items.find((item) => item[PARTITION_KEY] === key.pk && item[SORT_KEY] === key.sk);
  return typeof marker?.incidentId === 'string' ? marker.incidentId : undefined;
}

function pointerFindings(items: Items, scenario: CheckSavedScenario): string[] {
  const marker = incidentLaneKey(scenario.lane);
  const pause = incidentPauseKey(scenario.lane);
  const findings = outsidePartition(POINTERS_PATH, items, marker.pk);
  if (!hasKey(items, marker)) findings.push(`${POINTERS_PATH}: has no ${marker.sk} item`);
  else if (markerIncidentId(items, scenario.lane) === undefined) findings.push(`${POINTERS_PATH}: its ${marker.sk} item names no incident`);
  if (scenario.outcome === 'close' && !hasKey(items, pause)) findings.push(`${POINTERS_PATH}: has no ${pause.sk} item`);
  return findings;
}

// Without a marker naming the incident the partition cannot be checked, but the parts still can.
function incidentFindings(items: Items, incidentId: string | undefined, outcome: CheckSavedScenario['outcome']): string[] {
  const partition = incidentId === undefined ? undefined : incidentPartitionKey(incidentId);
  const inside = partition === undefined ? items : items.filter((item) => item[PARTITION_KEY] === partition);
  const findings = partition === undefined ? [] : outsidePartition(INCIDENT_PATH, items, partition);
  for (const part of outcome === 'close' ? CLOSED_PARTS : DECIDED_PARTS) {
    if (!inside.some((item) => item[SORT_KEY] === part)) findings.push(`${INCIDENT_PATH}: has no ${part} item`);
  }
  return findings;
}

function laneFindings(set: string, items: Items, input: CheckSavedInput): string[] {
  const path = laneItemsPath(set);
  const partition = lanePartitionKey(set);
  const findings = outsidePartition(path, items, partition);
  const ofRun = items.some((item) => item[PARTITION_KEY] === partition && item[RUN_ID_FIELD] === input.runId);
  if (set === input.scenario.lane && !ofRun) findings.push(`${path}: holds no record of the run`);
  return findings;
}

function itemsFindings(input: CheckSavedInput, reads: ReadonlyMap<string, FileRead>): string[] {
  const pointers = reads.get(POINTERS_PATH)?.items;
  const incident = reads.get(INCIDENT_PATH)?.items;
  const incidentId = pointers === undefined ? undefined : markerIncidentId(pointers, input.scenario.lane);
  return [
    ...(pointers === undefined ? [] : pointerFindings(pointers, input.scenario)),
    ...(incident === undefined ? [] : incidentFindings(incident, incidentId, input.scenario.outcome)),
    ...input.sets.flatMap((set) => {
      const items = reads.get(laneItemsPath(set))?.items;
      return items === undefined ? [] : laneFindings(set, items, input);
    }),
  ];
}

interface SaveOrder {
  lines: readonly SavedLogLine[];
  /** The index of the last save line of each file: a file saved again is judged by its last save. */
  lastSave: ReadonlyMap<string, number>;
}

function saveOrderOf(values: readonly unknown[]): SaveOrder {
  const lines = values.map((value) => savedLogLineSchema.parse(value));
  const lastSave = new Map<string, number>();
  lines.forEach((line, index) => {
    if ('file' in line) lastSave.set(line.file, index);
  });
  return { lines, lastSave };
}

function eventIndex(lines: readonly SavedLogLine[], event: 'deploy-finished' | 'destroy-started', which: 'first' | 'last'): number {
  const isEvent = (line: SavedLogLine): boolean => 'event' in line && line.event === event;
  return which === 'first' ? lines.findIndex(isEvent) : lines.findLastIndex(isEvent);
}

function unsavedFindings(order: SaveOrder, paths: readonly string[]): string[] {
  return paths.filter((path) => !order.lastSave.has(path)).map((path) => `${SAVED_LOG_PATH}: has no line for ${path}`);
}

function savedBefore(order: SaveOrder, paths: readonly string[], index: number, mark: string): string[] {
  return paths.filter((path) => (order.lastSave.get(path) ?? index) < index).map((path) => `${SAVED_LOG_PATH}: ${path} was saved before ${mark}`);
}

function savedAfter(order: SaveOrder, paths: readonly string[], index: number, mark: string): string[] {
  return paths.filter((path) => (order.lastSave.get(path) ?? index) > index).map((path) => `${SAVED_LOG_PATH}: ${path} was saved after ${mark}`);
}

// The last deploy-finished counts: a read taken before a redeploy describes stacks that changed.
function deployOrderFindings(order: SaveOrder, reads: readonly string[]): string[] {
  const deploy = eventIndex(order.lines, 'deploy-finished', 'last');
  if (deploy < 0) return [`${SAVED_LOG_PATH}: has no deploy-finished line`, ...unsavedFindings(order, reads)];
  return [...unsavedFindings(order, reads), ...savedBefore(order, reads, deploy, 'deploy-finished')];
}

// RESEARCH Pitfall 9: incident items or a set read taken before the reopen hold the pre-reopen
// state, which the capture cannot use, so each must be saved after the reopen result.
function reopenOrderFindings(order: SaveOrder, reads: readonly string[]): string[] {
  const reopen = order.lastSave.get(REOPEN_RESULT_PATH);
  if (reopen === undefined) return [];
  const afterReopen = reads.filter((path) => path === INCIDENT_PATH || path.startsWith(SETS_BEFORE_REMOVAL_PREFIX));
  return savedBefore(order, afterReopen, reopen, REOPEN_RESULT_PATH);
}

// The first destroy-started counts: from it on the table and the log groups start to go, so every
// pre-removal read must come before it and every after-removal read after it (AC-E47, AC-E51).
function destroyOrderFindings(order: SaveOrder, preRemoval: readonly string[], afterRemoval: readonly string[]): string[] {
  const destroy = eventIndex(order.lines, 'destroy-started', 'first');
  if (destroy < 0) return [`${SAVED_LOG_PATH}: has no destroy-started line`, ...unsavedFindings(order, afterRemoval)];
  return [
    ...savedAfter(order, preRemoval, destroy, 'destroy-started'),
    ...unsavedFindings(order, afterRemoval),
    ...savedBefore(order, afterRemoval, destroy, 'destroy-started'),
  ];
}

function awsReads(expected: readonly ExpectedRunFolderFile[], phase: RunFolderFile['phase']): string[] {
  return expected.filter(({ path, file }) => file.phase === phase && path.startsWith('aws/') && path !== SAVED_LOG_PATH).map(({ path }) => path);
}

function saveLogFindings(input: CheckSavedInput, expected: readonly ExpectedRunFolderFile[], values: readonly unknown[] | undefined): string[] {
  if (values === undefined) return [];
  const order = saveOrderOf(values);
  const preRemoval = awsReads(expected, 'pre-removal');
  return [
    ...deployOrderFindings(order, preRemoval),
    ...(input.scenario.outcome === 'close' ? reopenOrderFindings(order, preRemoval) : []),
    ...(input.afterRemoval ? destroyOrderFindings(order, preRemoval, awsReads(expected, 'after-removal')) : []),
  ];
}

export function checkSavedFolder(input: CheckSavedInput): CheckSavedResult {
  const expected = expectedRunFolderFiles(input);
  const reads = new Map(expected.map(({ path, file }) => [path, readFile(path, file, input.files.get(path))]));
  const findings = [
    ...[...reads.values()].flatMap((read) => read.findings),
    ...stacksFindings(reads.get(STACKS_PATH)?.values),
    ...itemsFindings(input, reads),
    ...saveLogFindings(input, expected, reads.get(SAVED_LOG_PATH)?.values),
  ];
  return { ok: findings.length === 0, findings, checked: expected.length };
}
