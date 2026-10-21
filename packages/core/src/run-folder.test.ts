import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { bucketSortKeyPrefix } from './records.js';
import {
  checkSavedFolder,
  expectedRunFolderFiles,
  RUN_FOLDER_FILES,
  type CheckSavedInput,
  type CheckSavedScenario,
  type SavedFileContent,
} from './run-folder.js';

type Image = Record<string, unknown>;

const IMAGE: Image = JSON.parse(readFileSync(new URL('./fixtures/run-folder-image.json', import.meta.url), 'utf8')) as Image;
const RUN_ID = 'live-20261021-s1-1';
// Built at run time so no twelve-digit literal sits in the file.
const ACCOUNT = '0'.repeat(12);
const SETS = ['fothering-transactional', 'fothering-bulk', 'fothering-alerts'];
const CLOSE_RUN: CheckSavedScenario = { lane: 'fothering-bulk', outcome: 'close', steps: ['spike', 'after-pause'] };
const UNKNOWN_RUN: CheckSavedScenario = { lane: 'fothering-transactional', outcome: 'unknown', steps: ['spike'] };

interface DynamoValue {
  S?: string;
  N?: string;
  BOOL?: boolean;
  M?: Record<string, DynamoValue>;
  L?: DynamoValue[];
}

// Core never imports the providers reader, so these pure cases unwrap the image's DynamoDB JSON
// themselves; the reader's own cases live in packages/providers/src/saved-items.test.ts.
function plainValue(value: DynamoValue): unknown {
  if (value.S !== undefined) return value.S;
  if (value.N !== undefined) return Number(value.N);
  if (value.BOOL !== undefined) return value.BOOL;
  if (value.M !== undefined) return plainItem(value.M);
  return (value.L ?? []).map(plainValue);
}

function plainItem(item: Record<string, DynamoValue>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(item).map(([name, value]) => [name, plainValue(value)]));
}

function fileText(path: string, content: unknown, runId: string): string {
  const raw = path.endsWith('.jsonl')
    ? (content as unknown[]).map((line) => `${JSON.stringify(line)}\n`).join('')
    : `${JSON.stringify(content, null, 2)}\n`;
  return raw
    .replaceAll('<ACCOUNT_ID>', ACCOUNT)
    .replaceAll('<RUN_ID>', runId)
    .replaceAll('<BUCKET>', bucketSortKeyPrefix(Date.UTC(2026, 9, 21, 9, 0)));
}

function contentOf(path: string, content: unknown, runId: string): SavedFileContent {
  const text = fileText(path, content, runId);
  if (!path.startsWith('aws/items-')) return { kind: 'text', text };
  const saved = JSON.parse(text) as { Items: Record<string, DynamoValue>[] };
  return { kind: 'items', items: saved.Items.map(plainItem) };
}

interface Plant {
  image?: (image: Image) => void;
  files?: (files: Map<string, SavedFileContent>) => void;
  scenario?: CheckSavedScenario;
  afterRemoval?: boolean;
}

function inputOf(plant: Plant = {}): CheckSavedInput {
  const image = structuredClone(IMAGE);
  plant.image?.(image);
  const files = new Map(Object.entries(image).map(([path, content]) => [path, contentOf(path, content, RUN_ID)]));
  plant.files?.(files);
  return { runId: RUN_ID, scenario: plant.scenario ?? CLOSE_RUN, sets: SETS, afterRemoval: plant.afterRemoval ?? false, files };
}

function findingsOf(plant: Plant = {}): string {
  return checkSavedFolder(inputOf(plant)).findings.join('; ');
}

function savedLog(image: Image): Record<string, unknown>[] {
  return image['aws/saved.jsonl'] as Record<string, unknown>[];
}

function moveSave(image: Image, file: string, before: string): void {
  const lines = savedLog(image);
  const from = lines.findIndex((line) => line.file === file);
  const [moved] = lines.splice(from, 1);
  const to = lines.findIndex((line) => line.file === before || line.event === before);
  if (moved !== undefined) lines.splice(to, 0, moved);
}

function itemsOf(image: Image, path: string): Record<string, DynamoValue>[] {
  return (image[path] as { Items: Record<string, DynamoValue>[] }).Items;
}

function setText(path: string, text: string): (files: Map<string, SavedFileContent>) => void {
  return (files) => files.set(path, { kind: 'text', text });
}

describe('checkSavedFolder over the committed image', () => {
  it('passes the image of a close run with no finding', () => {
    expect(findingsOf()).toBe('');
  });

  it('checks 22 files for run 1 before removal, the three run files of each step included', () => {
    const result = checkSavedFolder(inputOf());
    expect(result.checked).toBe(22);
    expect(result.ok).toBe(true);
  });

  it('reads zero files as one finding per expected file, never as clean', () => {
    const result = checkSavedFolder({ ...inputOf(), files: new Map() });
    expect(result.ok).toBe(false);
    expect(result.findings).toHaveLength(result.checked);
    expect(result.findings.every((finding) => finding.endsWith(': is missing'))).toBe(true);
  });
});

describe('a missing, empty, errored or reshaped file is named and fails (AC-E49)', () => {
  it.each<[string, Plant, string]>([
    ['a deleted stacks read', { files: (files) => files.delete('aws/stacks.json') }, 'aws/stacks.json: is missing'],
    ['an emptied template', { files: setText('aws/templates/FotheringAction.json', '') }, 'aws/templates/FotheringAction.json: is empty'],
    ['an emptied items file', { files: setText('aws/items-pointers.json', '') }, 'aws/items-pointers.json: is empty'],
    ['an emptied attempts file', { files: setText('run/spike.attempts.jsonl', '') }, 'run/spike.attempts.jsonl: is empty'],
    [
      'an AWS CLI error saved in place of JSON',
      { files: setText('aws/reopen-function.json', '\nAn error occurred (AccessDeniedException) when calling the GetFunctionConfiguration operation\n') },
      'aws/reopen-function.json: is not JSON',
    ],
    [
      'a renamed envelope key',
      {
        image: (image) => {
          const set = image['aws/sets-before-removal/fothering-bulk.json'] as Record<string, unknown>;
          set.Sending = set.SendingOptions;
          delete set.SendingOptions;
        },
      },
      'aws/sets-before-removal/fothering-bulk.json: holds no SendingOptions',
    ],
    ['an unreadable callers file', { files: (files) => files.set('run/spike.callers.json', { kind: 'unreadable' }) }, 'run/spike.callers.json: could not be read'],
    [
      'an items file the reader refused',
      { files: (files) => files.set('aws/items-incident.json', { kind: 'items-refused', errorName: 'SavedItemsError' }) },
      'aws/items-incident.json: the items reader refused it (SavedItemsError)',
    ],
    ['an empty Stacks list', { image: (image) => (image['aws/stacks.json'] = { Stacks: [] }) }, 'aws/stacks.json: its Stacks list is empty'],
    [
      'a stacks read without the action stack',
      {
        image: (image) => {
          const stacks = image['aws/stacks.json'] as { Stacks: { StackName: string }[] };
          stacks.Stacks = stacks.Stacks.filter((stack) => stack.StackName !== 'FotheringAction');
        },
      },
      'aws/stacks.json: names no stack FotheringAction',
    ],
  ])('fails %s by its name', (_label, plant, expected) => {
    expect(findingsOf(plant)).toBe(expected);
  });
});

describe('the items hold the run, the incident and its parts', () => {
  const LANE_FILE = 'aws/items-lane-fothering-bulk.json';

  it('fails a scenario lane whose items are all of another run, naming the lane file', () => {
    const plant: Plant = { image: (image) => itemsOf(image, LANE_FILE).forEach((item) => (item.runId = { S: 'live-20261021-s1-2' })) };
    expect(findingsOf(plant)).toBe(`${LANE_FILE}: holds no record of the run`);
  });

  it('fails a scenario lane read that found no item at all', () => {
    const plant: Plant = { image: (image) => itemsOf(image, LANE_FILE).splice(0) };
    expect(findingsOf(plant)).toBe(`${LANE_FILE}: holds no record of the run`);
  });

  it('fails a lane read holding an item of another partition', () => {
    const plant: Plant = { image: (image) => itemsOf(image, LANE_FILE).forEach((item) => (item.pk = { S: 'LANE#fothering-transactional' })) };
    expect(findingsOf(plant)).toBe(`${LANE_FILE}: holds an item outside its partition; ${LANE_FILE}: holds no record of the run`);
  });

  it('passes a lane other than the scenario lane that found no item', () => {
    expect(findingsOf({ image: (image) => itemsOf(image, 'aws/items-lane-fothering-alerts.json').splice(0) })).toBe('');
  });

  it.each(['EVIDENCE', 'DECISION', 'CLOSURE'])('fails an incident read with no %s item, naming the part', (part) => {
    const plant: Plant = {
      image: (image) => {
        const items = itemsOf(image, 'aws/items-incident.json');
        items.splice(items.findIndex((item) => item.sk?.S === part), 1);
      },
    };
    expect(findingsOf(plant)).toBe(`aws/items-incident.json: has no ${part} item`);
  });

  it('fails an incident read of another incident than the marker names', () => {
    const plant: Plant = { image: (image) => itemsOf(image, 'aws/items-incident.json').forEach((item) => (item.pk = { S: 'INCIDENT#incident-fixture-two' })) };
    expect(findingsOf(plant)).toBe(
      'aws/items-incident.json: holds an item outside its partition; aws/items-incident.json: has no EVIDENCE item; aws/items-incident.json: has no DECISION item; aws/items-incident.json: has no CLOSURE item',
    );
  });

  it.each(['MARKER', 'PAUSE'])('fails a close run whose pointers read has no %s item', (sortKey) => {
    const plant: Plant = {
      image: (image) => {
        const items = itemsOf(image, 'aws/items-pointers.json');
        items.splice(items.findIndex((item) => item.sk?.S === sortKey), 1);
      },
    };
    expect(findingsOf(plant)).toBe(`aws/items-pointers.json: has no ${sortKey} item`);
  });
});

describe('saved.jsonl shows every read saved in order (Pitfall 9)', () => {
  it('fails a read saved before deploy-finished', () => {
    expect(findingsOf({ image: (image) => moveSave(image, 'aws/stacks.json', 'deploy-finished') })).toBe(
      'aws/saved.jsonl: aws/stacks.json was saved before deploy-finished',
    );
  });

  it('fails a save log with no deploy-finished line', () => {
    const plant: Plant = { image: (image) => savedLog(image).splice(0, 1) };
    expect(findingsOf(plant)).toBe('aws/saved.jsonl: has no deploy-finished line');
  });

  it.each([
    ['upper case', '3F9A1C7E5B2D8A6F0C4E9B1D7A3F5C8E2B6D0A4F'],
    ['39 characters', '3f9a1c7e5b2d8a6f0c4e9b1d7a3f5c8e2b6d0a4'],
    ['a short sha', '3f9a1c7'],
  ])('fails a deploy commit written in %s', (_label, deployCommit) => {
    const plant: Plant = { image: (image) => (savedLog(image)[0] = { event: 'deploy-finished', deployCommit, savedAtUtc: '2026-10-21T08:30:00.000Z' }) };
    expect(findingsOf(plant)).toBe('aws/saved.jsonl line 1: the deploy commit is not 40 lowercase hex');
  });

  it('fails a close run whose incident items were saved before the reopen result', () => {
    expect(findingsOf({ image: (image) => moveSave(image, 'aws/items-incident.json', 'aws/reopen-result.json') })).toBe(
      'aws/saved.jsonl: aws/items-incident.json was saved before aws/reopen-result.json',
    );
  });

  it('fails a close run whose set read was saved before the reopen result', () => {
    expect(findingsOf({ image: (image) => moveSave(image, 'aws/sets-before-removal/fothering-bulk.json', 'aws/reopen-result.json') })).toBe(
      'aws/saved.jsonl: aws/sets-before-removal/fothering-bulk.json was saved before aws/reopen-result.json',
    );
  });

  it('fails a read with no line in the save log', () => {
    const plant: Plant = { image: (image) => savedLog(image).splice(savedLog(image).findIndex((line) => line.file === 'aws/reopen-function.json'), 1) };
    expect(findingsOf(plant)).toBe('aws/saved.jsonl: has no line for aws/reopen-function.json');
  });

  it('reads a torn last line, written without its newline, as unreadable and never skips it', () => {
    const text = fileText('aws/saved.jsonl', IMAGE['aws/saved.jsonl'], RUN_ID).replace(/\n$/, '');
    expect(findingsOf({ files: setText('aws/saved.jsonl', text) })).toBe('aws/saved.jsonl: the last line has no newline');
  });

  it('reads a torn attempts file the same way', () => {
    const text = fileText('run/spike.attempts.jsonl', IMAGE['run/spike.attempts.jsonl'], RUN_ID).replace(/\n$/, '');
    expect(findingsOf({ files: setText('run/spike.attempts.jsonl', text) })).toBe('run/spike.attempts.jsonl: the last line has no newline');
  });

  it('fails a line that is not a save log line, by its number', () => {
    const plant: Plant = { image: (image) => (savedLog(image)[2] = { file: 'aws/templates/FotheringIngest.json' }) };
    expect(findingsOf(plant)).toBe('aws/saved.jsonl line 3: is not a save log line');
  });

  it('fails an empty save log and one holding only a newline', () => {
    expect(findingsOf({ files: setText('aws/saved.jsonl', '') })).toBe('aws/saved.jsonl: is empty');
    expect(findingsOf({ files: setText('aws/saved.jsonl', '\n') })).toBe('aws/saved.jsonl: is empty');
  });
});

describe('an unknown-decision run', () => {
  const UNKNOWN_IMAGE = (image: Image): void => {
    for (const path of ['aws/reopen-function.json', 'aws/reopen-result.json', 'run/after-pause.account.json', 'run/after-pause.callers.json', 'run/after-pause.attempts.jsonl']) {
      Reflect.deleteProperty(image, path);
    }
    const lines = savedLog(image);
    lines.splice(0, lines.length, ...lines.filter((line) => line.file !== 'aws/reopen-function.json' && line.file !== 'aws/reopen-result.json'));
    image['aws/items-pointers.json'] = {
      Items: [{ pk: { S: 'INCIDENT_LANE#fothering-transactional' }, sk: { S: 'MARKER' }, incidentId: { S: 'incident-fixture-two' }, status: { S: 'open' } }],
    };
    image['aws/items-incident.json'] = {
      Items: ['STATE', 'EVIDENCE', 'DECISION'].map((part) => ({ pk: { S: 'INCIDENT#incident-fixture-two' }, sk: { S: part } })),
    };
  };

  it('needs no reopen-function.json, reopen-result.json, PAUSE or CLOSURE item, and passes without them', () => {
    const result = checkSavedFolder(inputOf({ scenario: UNKNOWN_RUN, image: UNKNOWN_IMAGE }));
    expect(result.findings.join('; ')).toBe('');
    expect(result.checked).toBe(17);
  });

  it('still needs the EVIDENCE and DECISION items', () => {
    const plant: Plant = {
      scenario: UNKNOWN_RUN,
      image: (image) => {
        UNKNOWN_IMAGE(image);
        itemsOf(image, 'aws/items-incident.json').splice(1, 2);
      },
    };
    expect(findingsOf(plant)).toBe('aws/items-incident.json: has no EVIDENCE item; aws/items-incident.json: has no DECISION item');
  });
});

describe('findings name files and parts, never a value read from a file', () => {
  it('holds no address, account id, incident id, function name or run id in any finding', () => {
    const plants: Plant[] = [
      { files: (files) => files.delete('aws/stacks.json') },
      { image: (image) => itemsOf(image, 'aws/items-lane-fothering-bulk.json').forEach((item) => (item.runId = { S: 'live-20261021-s1-2' })) },
      { image: (image) => itemsOf(image, 'aws/items-incident.json').forEach((item) => (item.pk = { S: 'INCIDENT#incident-fixture-two' })) },
      { image: (image) => moveSave(image, 'aws/stacks.json', 'deploy-finished') },
      { image: (image) => (savedLog(image)[0] = { event: 'deploy-finished', deployCommit: 'ABC', savedAtUtc: 'later' }) },
    ];
    const findings = plants.flatMap((plant) => checkSavedFolder(inputOf(plant)).findings);
    expect(findings.length).toBeGreaterThanOrEqual(plants.length);
    const leaks = findings.filter((finding) => ['@', ACCOUNT, 'incident-fixture', 'ReopenFunction-', RUN_ID, 'ABC'].some((value) => finding.includes(value)));
    expect(leaks).toEqual([]);
  });
});

describe('the contract itself', () => {
  it('gives every aws/ read but the save log an AWS CLI command asking for JSON', () => {
    const reads = RUN_FOLDER_FILES.filter((file) => file.path.startsWith('aws/') && file.path !== 'aws/saved.jsonl');
    expect(reads.filter((file) => file.command === undefined).map((file) => file.path)).toEqual([]);
    expect(reads.filter((file) => !(file.command ?? '').startsWith('aws ')).map((file) => file.path)).toEqual([]);
    expect(reads.filter((file) => !(file.command ?? '').includes('--output json') && file.path !== 'aws/reopen-result.json').map((file) => file.path)).toEqual([]);
  });

  it('names a source for every slot of every path and command', () => {
    const unknown = RUN_FOLDER_FILES.flatMap((file) => Object.entries(file.slots).filter(([, source]) => source === 'unknown').map(([slot]) => `${file.path} ${slot}`));
    expect(unknown).toEqual([]);
  });

  it('builds the DynamoDB partition keys from the record key builders', () => {
    const commandOf = (path: string): string => RUN_FOLDER_FILES.find((file) => file.path === path)?.command ?? '';
    expect(commandOf('aws/items-pointers.json')).toContain('"S":"INCIDENT_LANE#<lane>"');
    expect(commandOf('aws/items-incident.json')).toContain('"S":"INCIDENT#<IncidentId>"');
    expect(commandOf('aws/items-lane-<set>.json')).toContain('"S":"LANE#<set>"');
    expect(commandOf('aws/reopen-result.json')).toContain('--function-name <ReopenFunctionName>');
    expect(commandOf('aws/reopen-result.json')).toContain('{"configurationSet":"<lane>"}');
    expect(commandOf('aws/reopen-result.json').endsWith(' aws/reopen-result.json')).toBe(true);
  });

  it('expands each step, stack and set once, and leaves the close-only files out of an unknown run', () => {
    const paths = expectedRunFolderFiles({ scenario: UNKNOWN_RUN, sets: SETS, afterRemoval: false }).map((entry) => entry.path);
    expect(paths.filter((path) => path.startsWith('aws/templates/'))).toEqual([
      'aws/templates/FotheringIngest.json',
      'aws/templates/FotheringRuntime.json',
      'aws/templates/FotheringDetection.json',
      'aws/templates/FotheringAction.json',
    ]);
    expect(paths.filter((path) => path.startsWith('run/'))).toEqual(['run/spike.account.json', 'run/spike.callers.json', 'run/spike.attempts.jsonl']);
    expect(paths).not.toContain('aws/reopen-function.json');
    expect(paths).not.toContain('aws/reopen-result.json');
  });
});
