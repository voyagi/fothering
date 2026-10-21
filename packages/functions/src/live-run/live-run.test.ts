import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { parseLaneMap, type LaneEntry } from '@fothering/core/lanes';
import { attemptRecordSchema, MIN_SEND_GAP_MS, refusalMessage, spacingViolations, type AttemptRecord } from '@fothering/core/live-run';
import { bucketSortKeyPrefix } from '@fothering/core/records';
import { parseScenarioSource, stepPlan, type ScenarioSource, type ScenarioTagKind } from '@fothering/core/scenarios';
import { propertySeed } from '@fothering/core/test/property-seed';
import {
  createFixtureLiveRunPorts,
  createFixtureLiveRunState,
  type FixtureLiveRunCall,
  type FixtureLiveRunState,
} from '@fothering/providers/fixtures/live-run-ports';
import { createLiveRunPortFactory } from '@fothering/providers/live/live-run-ports';
import type { LiveRunPortFactory, LiveRunSendRequest } from '@fothering/providers/live-run-port-types';
import { sleep } from '@fothering/providers/ses-facts';
import { LIVE_RUN_MESSAGES, main } from './cli.js';
import { buildLiveRunRoot, type BuildLiveRunRootOptions, type LiveRunDeps } from './root.js';
import { appendAttempt } from './send.js';
import lanesJson from '../../../../lanes.json' with { type: 'json' };
import scenariosJson from '../../../../docs/measurement-scenarios.json' with { type: 'json' };

// This file lives at packages/functions/src/live-run/, four levels below the repo root. Planted repo
// roots sit under the git-ignored node_modules/.cache, so git check-ignore succeeds through the real
// repository's node_modules/ rule and nothing is ever written under the real reports/ folder.
const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const PLANT_PARENT = join(REPO_ROOT, 'node_modules', '.cache', 'fothering-live-run-test');
const plantRoots: string[] = [];

afterAll(() => {
  for (const root of plantRoots) rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
});

const LANES = parseLaneMap(lanesJson);
const SOURCE = parseScenarioSource(scenariosJson);
// Built at run time so no twelve-digit literal sits in the file.
const ACCOUNT = '0'.repeat(12);
const FROM = 'sender@example.com';
const RUN_ID = 'live-20261022-s1-1';
// Profile names no message text could contain by accident, so a leak of one is visible.
const PROFILES = { account: 'acct-main', bulk: 'creds-bulk', transactional: 'creds-tx' } as const;

function plantRoot(): string {
  const root = join(PLANT_PARENT, `root-${process.pid}-${plantRoots.length}`);
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  plantRoots.push(root);
  return root;
}

function roleArn(role: string, session = 'session-1', account = ACCOUNT): string {
  return `arn:aws:sts::${account}:assumed-role/${role}/${session}`;
}

function fixtureState(): FixtureLiveRunState {
  const state = createFixtureLiveRunState();
  state.callers.set(PROFILES.account, { arn: roleArn('live-run-account'), account: ACCOUNT });
  state.callers.set(PROFILES.bulk, { arn: roleArn('live-run-bulk'), account: ACCOUNT });
  state.callers.set(PROFILES.transactional, { arn: roleArn('live-run-transactional'), account: ACCOUNT });
  state.account = { vdmEnabled: 'ENABLED', productionAccessEnabled: true, maxSendRate: 1, requestId: 'fixture-request-account' };
  return state;
}

interface FakeClock {
  monotonicMs: () => number;
  nowUtc: () => number;
  sleep: (ms: number) => Promise<void>;
  advance: (ms: number) => void;
}

function fakeClock(): FakeClock {
  let elapsed = 0;
  const epoch = Date.UTC(2026, 9, 22, 9, 0, 0);
  return {
    monotonicMs: () => elapsed,
    nowUtc: () => epoch + elapsed,
    sleep: async (ms) => {
      elapsed += ms;
    },
    advance: (ms) => {
      elapsed += ms;
    },
  };
}

interface Harness {
  deps: LiveRunDeps;
  out: string[];
  err: string[];
  clock: FakeClock;
}

function harness(
  root: string,
  state: FixtureLiveRunState,
  switchValue: string | undefined,
  overrides: Partial<BuildLiveRunRootOptions> = {},
): Harness {
  const out: string[] = [];
  const err: string[] = [];
  const clock = fakeClock();
  const deps = buildLiveRunRoot({
    runtimeContext: 'test',
    switchValue,
    repoRoot: root,
    liveRunFixtures: state,
    io: { out: (line) => out.push(line), err: (line) => err.push(line) },
    monotonicMs: clock.monotonicMs,
    nowUtc: clock.nowUtc,
    sleep: clock.sleep,
    ...overrides,
  });
  return { deps, out, err, clock };
}

function sendArgs(runId: string, scenario: string, step: string, extra: readonly string[] = []): string[] {
  return [
    'send',
    runId,
    scenario,
    step,
    '--from',
    FROM,
    '--account-profile',
    PROFILES.account,
    '--lane-profile',
    `fothering-bulk=${PROFILES.bulk}`,
    '--lane-profile',
    `fothering-transactional=${PROFILES.transactional}`,
    ...extra,
  ];
}

function sendsOf(state: FixtureLiveRunState): { profile: string; request: LiveRunSendRequest }[] {
  return state.calls.flatMap((call: FixtureLiveRunCall) => (call.operation === 'sendEmail' ? [{ profile: call.profile, request: call.request }] : []));
}

function laneOf(set: string): LaneEntry {
  const lane = LANES.lanes.find((entry) => entry.configurationSet === set);
  if (lane === undefined) throw new Error(`lanes.json has no ${set}`);
  return lane;
}

function tagKeyOf(lane: LaneEntry, kind: ScenarioTagKind): string {
  return { batch: lane.batchTagKey, campaign: lane.campaignTagKey, template: lane.templateTagKey }[kind];
}

function runFolder(root: string, runId = RUN_ID): string {
  return join(root, 'reports', 'live-runs', runId, 'run');
}

describe('live-run send on fixtures, end to end', () => {
  it('sends run 1 spike as 132 tagged messages in plan order and writes its account, callers and attempts files', async () => {
    const root = plantRoot();
    const state = fixtureState();
    const { deps, out, err } = harness(root, state, 'live');

    const code = await main(sendArgs(RUN_ID, 'bulk-stale-import', 'spike'), deps);

    const sends = sendsOf(state);
    expect(sends).toHaveLength(132);
    expect(code).toBe(0);

    const plan = stepPlan(SOURCE, 'bulk-stale-import', 'spike', RUN_ID);
    expect(plan.map((entry) => entry.recipient)).toEqual(sends.map((send) => send.request.to));
    sends.forEach((send, index) => {
      const entry = plan[index];
      if (entry === undefined) throw new Error(`no plan entry ${index}`);
      const lane = laneOf(entry.lane);
      expect(send.profile).toBe(entry.lane === 'fothering-bulk' ? PROFILES.bulk : PROFILES.transactional);
      expect(send.request.from).toBe(FROM);
      expect(send.request.configurationSetName).toBe(entry.lane);
      expect(send.request.tags).toEqual([
        { name: lane.streamTagKey, value: lane.declaredStreams[0] },
        { name: tagKeyOf(lane, entry.tagKind), value: entry.tagValue },
        { name: LANES.runIdTagKey, value: RUN_ID },
      ]);
    });

    // Field by field against the committed source, not through the plan: each group's lane, tag,
    // recipient kind and count must be what the requests carried.
    const step = SOURCE.scenarios[0]?.steps[0];
    expect(step?.name).toBe('spike');
    const tally = new Map<string, number>();
    for (const send of sends) {
      const lane = laneOf(send.request.configurationSetName);
      const kindTag = send.request.tags[1];
      const kind = (['batch', 'campaign', 'template'] as const).find((candidate) => tagKeyOf(lane, candidate) === kindTag?.name);
      const recipientKind = send.request.to.split('+')[0];
      const key = `${lane.configurationSet}|${String(kind)}|${String(kindTag?.value)}|${String(recipientKind)}`;
      tally.set(key, (tally.get(key) ?? 0) + 1);
    }
    const expected = new Map((step?.groups ?? []).map((group) => [`${group.lane}|${group.tag.kind}|${group.tag.value}|${group.recipient}`, group.count]));
    expect(tally).toEqual(expected);

    // Four clean, one stale, repeated, with one receipt after every ten bulk messages.
    expect(sends.slice(0, 11).map((send) => send.request.tags[1]?.value)).toEqual([
      'clean-import', 'clean-import', 'clean-import', 'clean-import', 'stale-import',
      'clean-import', 'clean-import', 'clean-import', 'clean-import', 'stale-import',
      'order-receipt',
    ]);
    expect(sends.every((send) => send.request.to.endsWith('@simulator.amazonses.com'))).toBe(true);

    const folder = runFolder(root);
    const accountText = readFileSync(join(folder, 'spike.account.json'), 'utf8');
    expect(JSON.parse(accountText)).toEqual({ vdmEnabled: 'ENABLED', productionAccessEnabled: true, maxSendRate: 1, requestId: 'fixture-request-account' });
    const callersText = readFileSync(join(folder, 'spike.callers.json'), 'utf8');
    expect(JSON.parse(callersText)).toEqual({
      lanes: [
        { lane: 'fothering-bulk', roleName: 'live-run-bulk', account: ACCOUNT, arn: roleArn('live-run-bulk') },
        { lane: 'fothering-transactional', roleName: 'live-run-transactional', account: ACCOUNT, arn: roleArn('live-run-transactional') },
      ],
      account: { account: ACCOUNT, arn: roleArn('live-run-account') },
    });
    const attemptsText = readFileSync(join(folder, 'spike.attempts.jsonl'), 'utf8');
    const lines = attemptsText.split('\n');
    expect(lines.pop()).toBe('');
    expect(lines).toHaveLength(132);
    lines.forEach((line, index) => {
      const record = attemptRecordSchema.parse(JSON.parse(line));
      expect(record.recipient).toBe(plan[index]?.recipient);
      expect(record).toMatchObject({ lane: plan[index]?.lane, messageId: `fixture-message-${index + 1}`, requestId: `fixture-request-${index + 1}` });
    });

    for (const text of [accountText, callersText, attemptsText, ...out, ...err]) expect(text).not.toContain(FROM);
  });
});

const IMAGE_FILE = join(REPO_ROOT, 'packages', 'core', 'src', 'fixtures', 'run-folder-image.json');
const IMAGE_RUN_ID = 'live-20261021-s1-1';

type RunFolderImage = Record<string, unknown>;

function readImage(): RunFolderImage {
  return JSON.parse(readFileSync(IMAGE_FILE, 'utf8')) as RunFolderImage;
}

// The image holds placeholders where a run-time value goes, so no account id and no thirteen-digit
// bucket start sits in the committed file, and one image serves any run id.
function imageFileText(path: string, content: unknown, runId: string): string {
  const raw = path.endsWith('.jsonl')
    ? (content as unknown[]).map((line) => `${JSON.stringify(line)}\n`).join('')
    : `${JSON.stringify(content, null, 2)}\n`;
  return raw
    .replaceAll('<ACCOUNT_ID>', ACCOUNT)
    .replaceAll('<RUN_ID>', runId)
    .replaceAll('<BUCKET>', bucketSortKeyPrefix(Date.UTC(2026, 9, 21, 9, 0)));
}

function materializeImage(root: string, runId = IMAGE_RUN_ID, image: RunFolderImage = readImage()): string {
  const folder = join(root, 'reports', 'live-runs', runId);
  for (const [path, content] of Object.entries(image)) {
    const target = join(folder, ...path.split('/'));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, imageFileText(path, content, runId));
  }
  return folder;
}

interface CheckSavedOutcome {
  code: number;
  out: string[];
  err: string[];
  /** Exit code, ports built and every printed line, so one comparison covers all three. */
  line: string;
}

async function checkSaved(root: string, args: readonly string[]): Promise<CheckSavedOutcome> {
  const state = createFixtureLiveRunState();
  const { deps, out, err } = harness(root, state, undefined);
  const code = await main(['check-saved', ...args], deps);
  return { code, out, err, line: `exit ${code}, ports ${state.constructions}, ${[...out, ...err].join(' | ')}` };
}

describe('check-saved over a run folder, end to end', () => {
  it('reads every pre-removal file of the fixture image through the contract and exits 0', async () => {
    const root = plantRoot();
    materializeImage(root);

    const outcome = await checkSaved(root, [IMAGE_RUN_ID]);

    expect(outcome.line).toBe('exit 0, ports 0, check-saved: 22 files checked, no findings');
  });

  it.each<[string, (folder: string) => void, string]>([
    ['a deleted read', (folder) => rmSync(join(folder, 'aws', 'stacks.json')), 'aws/stacks.json: is missing'],
    [
      'an AWS CLI error saved in place of a read',
      (folder) => writeFileSync(join(folder, 'aws', 'templates', 'FotheringIngest.json'), '\nAn error occurred (ValidationError) when calling the GetTemplate operation\n'),
      'aws/templates/FotheringIngest.json: is not JSON',
    ],
    ['an emptied read', (folder) => writeFileSync(join(folder, 'aws', 'sets-before-removal', 'fothering-bulk.json'), ''), 'aws/sets-before-removal/fothering-bulk.json: is empty'],
    [
      'an items file the reader refuses',
      (folder) => writeFileSync(join(folder, 'aws', 'items-lane-fothering-transactional.json'), '{"Items":[{"pk":"LANE#fothering-transactional"}]}\n'),
      'aws/items-lane-fothering-transactional.json: the items reader refused it (SavedItemsError)',
    ],
    [
      'a save log whose last line lost its newline',
      (folder) => {
        const path = join(folder, 'aws', 'saved.jsonl');
        writeFileSync(path, readFileSync(path, 'utf8').replace(/\n$/, ''));
      },
      'aws/saved.jsonl: the last line has no newline',
    ],
  ])('exits 1 on %s, naming the file', async (_label, plant, finding) => {
    const root = plantRoot();
    plant(materializeImage(root));

    const outcome = await checkSaved(root, [IMAGE_RUN_ID]);

    expect(outcome.line).toBe(`exit 1, ports 0, check-saved: ${finding} | check-saved: 22 files checked, 1 finding`);
  });

  it.each<[string, (image: RunFolderImage) => void, string]>([
    [
      'lane items holding only another run',
      (image) => {
        const lane = image['aws/items-lane-fothering-bulk.json'] as { Items: { runId: { S: string } }[] };
        for (const item of lane.Items) item.runId = { S: 'live-20261021-s1-2' };
      },
      'aws/items-lane-fothering-bulk.json: holds no record of the run',
    ],
    [
      'incident items saved before the reopen result',
      (image) => {
        const lines = image['aws/saved.jsonl'] as { file?: string }[];
        const [incident] = lines.splice(lines.findIndex((line) => line.file === 'aws/items-incident.json'), 1);
        if (incident !== undefined) lines.splice(lines.findIndex((line) => line.file === 'aws/reopen-result.json'), 0, incident);
      },
      'aws/saved.jsonl: aws/items-incident.json was saved before aws/reopen-result.json',
    ],
  ])('exits 1 on %s, naming the file', async (_label, edit, finding) => {
    const root = plantRoot();
    const image = readImage();
    edit(image);
    materializeImage(root, IMAGE_RUN_ID, image);

    const outcome = await checkSaved(root, [IMAGE_RUN_ID]);

    expect(outcome.line).toBe(`exit 1, ports 0, check-saved: ${finding} | check-saved: 22 files checked, 1 finding`);
  });

  it('passes run 2, an unknown decision, without the reopen files, the pause pointer or a closure', async () => {
    const root = plantRoot();
    const image = readImage();
    for (const path of ['aws/reopen-function.json', 'aws/reopen-result.json', 'run/after-pause.account.json', 'run/after-pause.callers.json', 'run/after-pause.attempts.jsonl']) {
      Reflect.deleteProperty(image, path);
    }
    image['aws/saved.jsonl'] = (image['aws/saved.jsonl'] as { file?: string }[]).filter((line) => line.file !== 'aws/reopen-function.json' && line.file !== 'aws/reopen-result.json');
    image['aws/items-pointers.json'] = { Items: [{ pk: { S: 'INCIDENT_LANE#fothering-transactional' }, sk: { S: 'MARKER' }, incidentId: { S: 'incident-fixture-two' } }] };
    image['aws/items-incident.json'] = { Items: ['STATE', 'EVIDENCE', 'DECISION'].map((part) => ({ pk: { S: 'INCIDENT#incident-fixture-two' }, sk: { S: part } })) };
    materializeImage(root, 'live-20261021-s2-1', image);

    const outcome = await checkSaved(root, ['live-20261021-s2-1']);

    expect(outcome.line).toBe('exit 0, ports 0, check-saved: 17 files checked, no findings');
  });

  it('exits 1 naming a run folder that does not exist, and creates nothing', async () => {
    const root = plantRoot();

    const outcome = await checkSaved(root, [RUN_ID]);

    expect(outcome.line).toBe(`exit 1, ports 0, check-saved: reports/live-runs/${RUN_ID}: the run folder is missing | check-saved: 0 files checked, 1 finding`);
    expect(existsSync(join(root, 'reports'))).toBe(false);
  });

  it('refuses a run id of no known shape before reading anything', async () => {
    const outcome = await checkSaved(plantRoot(), ['run-one']);
    expect(outcome.line).toBe(`exit 1, ports 0, ${refusalMessage('run-id-invalid')}`);
  });

  it.each([[[]], [['--after-removal']], [[RUN_ID, '--after']], [[RUN_ID, '--after-removal', 'extra']], [[RUN_ID, 'extra']]])(
    'refuses the arguments %j as a usage error',
    async (args) => {
      const outcome = await checkSaved(plantRoot(), args);
      expect(outcome.line).toBe(`exit 1, ports 0, ${refusalMessage('usage')} | ${LIVE_RUN_MESSAGES.usage}`);
    },
  );
});

interface Outcome {
  code: number;
  out: string[];
  err: string[];
  state: FixtureLiveRunState;
  root: string;
}

interface RunOptions {
  switchValue?: string | undefined;
  root?: string;
  state?: FixtureLiveRunState;
  overrides?: Partial<BuildLiveRunRootOptions>;
}

async function run(argv: readonly string[], options: RunOptions = {}): Promise<Outcome> {
  const root = options.root ?? plantRoot();
  const state = options.state ?? fixtureState();
  const switchValue = 'switchValue' in options ? options.switchValue : 'live';
  const { deps, out, err } = harness(root, state, switchValue, options.overrides);
  const code = await main(argv, deps);
  return { code, out, err, state, root };
}

// Everything a refusal must hold, as one line a test compares with the expected refusal message:
// the first error line when the run exited 1 having built no port, sent nothing and printed no
// address or profile name, and otherwise a line saying which of those failed.
function refusalLine(outcome: Outcome): string {
  const leaks = [...outcome.out, ...outcome.err].filter((line) => line.includes('@') || Object.values(PROFILES).some((profile) => line.includes(profile)));
  const sends = sendsOf(outcome.state).length;
  if (outcome.code !== 1 || outcome.state.constructions !== 0 || sends !== 0 || leaks.length > 0) {
    return `exit ${outcome.code}, ${outcome.state.constructions} ports built, ${sends} sends, ${leaks.length} lines with an address or profile`;
  }
  return outcome.err[0] ?? 'no error line';
}

function sourceCopy(): ScenarioSource {
  return structuredClone(SOURCE);
}

function attemptStartsMs(root: string, step = 'spike', runId = RUN_ID): number[] {
  const text = readFileSync(join(runFolder(root, runId), `${step}.attempts.jsonl`), 'utf8');
  return text
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => Date.parse(attemptRecordSchema.parse(JSON.parse(line)).startUtc));
}

describe('send refuses every unsafe or unnamed request before any port exists', () => {
  it.each([
    ['unset', undefined],
    ['LIVE', 'LIVE'],
    ['true', 'true'],
    ['live with a leading space', ' live'],
    ['empty', ''],
  ])('refuses with the switch %s', async (_label, switchValue) => {
    expect(refusalLine(await run(sendArgs(RUN_ID, 'bulk-stale-import', 'spike'), { switchValue }))).toBe(refusalMessage('switch-not-live'));
  });

  it('refuses a scenario the source does not name, and names it', async () => {
    expect(refusalLine(await run(sendArgs(RUN_ID, 'no-such-scenario', 'spike')))).toBe(refusalMessage('unknown-scenario', 'no-such-scenario'));
  });

  it('refuses a step the scenario does not name, and names it', async () => {
    expect(refusalLine(await run(sendArgs(RUN_ID, 'bulk-stale-import', 'no-such-step')))).toBe(refusalMessage('unknown-step', 'no-such-step'));
  });

  it('refuses a step with zero messages', async () => {
    const scenarios = sourceCopy();
    for (const group of scenarios.scenarios[0]?.steps[0]?.groups ?? []) group.count = 0;
    expect(refusalLine(await run(sendArgs(RUN_ID, 'bulk-stale-import', 'spike'), { overrides: { scenarios } }))).toBe(refusalMessage('empty-step'));
  });

  it.each([
    ['empty', ''],
    ['of another run number', 'live-20261022-s2-1'],
    ['of no known shape', 'run-one'],
  ])('refuses a run id that is %s', async (_label, runId) => {
    expect(refusalLine(await run(sendArgs(runId, 'bulk-stale-import', 'spike')))).toBe(refusalMessage('run-id-invalid'));
  });

  it('refuses a missing run id as a usage error', async () => {
    const argv = sendArgs(RUN_ID, 'bulk-stale-import', 'spike').filter((arg) => arg !== RUN_ID);
    expect(refusalLine(await run(argv))).toBe(refusalMessage('usage'));
  });

  it.each([
    ['example.com', 'example.com'],
    ['a longer host that begins with the simulator domain', 'simulator.amazonses.com.example.com'],
  ])('refuses a recipient domain of %s', async (_label, recipientDomain) => {
    const scenarios = sourceCopy();
    scenarios.recipientDomain = recipientDomain;
    expect(refusalLine(await run(sendArgs(RUN_ID, 'bulk-stale-import', 'spike'), { overrides: { scenarios } }))).toBe(refusalMessage('recipient-not-simulator', 'fothering-bulk'));
  });

  it('accepts the simulator domain written in upper case', async () => {
    const scenarios = sourceCopy();
    scenarios.recipientDomain = 'SIMULATOR.AMAZONSES.COM';
    const outcome = await run(sendArgs(RUN_ID, 'bulk-stale-import', 'spike'), { overrides: { scenarios } });
    expect(outcome.code).toBe(0);
    expect(sendsOf(outcome.state)).toHaveLength(132);
  });

  it('refuses a tag value outside the SES tag rule, naming its lane', async () => {
    const scenarios = sourceCopy();
    const receipts = scenarios.scenarios[0]?.steps[0]?.groups[2];
    if (receipts === undefined) throw new Error('the committed spike has no third group');
    receipts.tag.value = 'order receipt';
    expect(refusalLine(await run(sendArgs(RUN_ID, 'bulk-stale-import', 'spike'), { overrides: { scenarios } }))).toBe(refusalMessage('tag-invalid', 'fothering-transactional'));
  });

  it.each(['0.81', '1'])('refuses a requested rate of %s per second', async (rate) => {
    expect(refusalLine(await run(sendArgs(RUN_ID, 'bulk-stale-import', 'spike', ['--rate', rate])))).toBe(refusalMessage('rate-too-high'));
  });

  it('refuses a malformed rate as a usage error', async () => {
    expect(refusalLine(await run(sendArgs(RUN_ID, 'bulk-stale-import', 'spike', ['--rate', 'fast'])))).toBe(refusalMessage('usage'));
  });

  it('accepts 0.8 per second and starts every send at least 1,250 ms after the one before, across lanes', async () => {
    const outcome = await run(sendArgs(RUN_ID, 'bulk-stale-import', 'spike', ['--rate', '0.8']));
    expect(outcome.code).toBe(0);
    const starts = attemptStartsMs(outcome.root);
    expect(starts).toHaveLength(132);
    expect(spacingViolations(starts, MIN_SEND_GAP_MS)).toEqual([]);
    expect(Math.min(...starts.slice(1).map((start, index) => start - (starts[index] ?? 0)))).toBe(MIN_SEND_GAP_MS);
  });

  it('spaces sends 2,000 ms apart at 0.5 per second', async () => {
    const outcome = await run(sendArgs(RUN_ID, 'bulk-stale-import', 'after-pause', ['--rate', '0.5']));
    expect(outcome.code).toBe(0);
    expect(spacingViolations(attemptStartsMs(outcome.root, 'after-pause'), 2000)).toEqual([]);
  });

  it('refuses a run folder git does not read as ignored, and creates nothing there', async () => {
    // A tracked source folder: /reports/ is ignored only at the repository root, so this run folder
    // is not, and git check-ignore needs no existing path to say so.
    const root = join(REPO_ROOT, 'packages', 'functions', 'src', 'live-run');
    try {
      const outcome = await run(sendArgs(RUN_ID, 'bulk-stale-import', 'spike'), { root });
      expect(refusalLine(outcome)).toBe(refusalMessage('output-not-ignored', `reports/live-runs/${RUN_ID}/run`));
      expect(existsSync(join(root, 'reports'))).toBe(false);
    } finally {
      rmSync(join(root, 'reports'), { recursive: true, force: true });
    }
  });

  it('refuses when the ignore check itself fails', async () => {
    const gitCheckIgnore = (): void => {
      throw new Error('git is not on the PATH');
    };
    expect(refusalLine(await run(sendArgs(RUN_ID, 'bulk-stale-import', 'spike'), { overrides: { gitCheckIgnore } }))).toBe(refusalMessage('output-not-ignored', `reports/live-runs/${RUN_ID}/run`));
  });

  it('refuses a run folder that resolves outside <root>/reports/live-runs/', async () => {
    const root = plantRoot();
    const elsewhere = plantRoot();
    symlinkSync(elsewhere, join(root, 'reports'), 'junction');
    expect(refusalLine(await run(sendArgs(RUN_ID, 'bulk-stale-import', 'spike'), { root }))).toBe(refusalMessage('output-outside-root', `reports/live-runs/${RUN_ID}/run`));
    expect(existsSync(join(elsewhere, 'live-runs'))).toBe(false);
  });

  it('refuses a step whose attempts file already exists', async () => {
    const root = plantRoot();
    mkdirSync(runFolder(root), { recursive: true });
    writeFileSync(join(runFolder(root), 'spike.attempts.jsonl'), '');
    expect(refusalLine(await run(sendArgs(RUN_ID, 'bulk-stale-import', 'spike'), { root }))).toBe(refusalMessage('step-already-run', `reports/live-runs/${RUN_ID}/run/spike.attempts.jsonl`));
  });

  it('refuses while another run holds the lock, and leaves that lock in place', async () => {
    const root = plantRoot();
    const lock = join(root, 'reports', 'live-runs', '.lock');
    mkdirSync(join(root, 'reports', 'live-runs'), { recursive: true });
    writeFileSync(lock, '');
    expect(refusalLine(await run(sendArgs(RUN_ID, 'bulk-stale-import', 'spike'), { root }))).toBe(refusalMessage('lock-held', 'reports/live-runs/.lock'));
    expect(existsSync(lock)).toBe(true);
  });

  it('releases its own lock when the step ends', async () => {
    const outcome = await run(sendArgs(RUN_ID, 'bulk-stale-import', 'after-pause'));
    expect(outcome.code).toBe(0);
    expect(existsSync(join(outcome.root, 'reports', 'live-runs', '.lock'))).toBe(false);
  });

  it('refuses a lane the scenario sends on that has no profile, naming the lane', async () => {
    const argv = sendArgs(RUN_ID, 'bulk-stale-import', 'spike').filter((arg, index, all) => arg !== `fothering-transactional=${PROFILES.transactional}` && all[index + 1] !== `fothering-transactional=${PROFILES.transactional}`);
    expect(refusalLine(await run(argv))).toBe(refusalMessage('lane-profile-missing', 'fothering-transactional'));
  });

  it.each([
    [['bogus']],
    [[]],
    [['send', RUN_ID, 'bulk-stale-import', 'spike', 'extra', '--from', FROM, '--account-profile', PROFILES.account]],
    [sendArgs(RUN_ID, 'bulk-stale-import', 'spike').map((arg) => (arg === FROM ? 'not-an-address' : arg))],
    [sendArgs(RUN_ID, 'bulk-stale-import', 'spike', ['--from', FROM])],
    [sendArgs(RUN_ID, 'bulk-stale-import', 'spike', ['--unknown', 'value'])],
    [sendArgs(RUN_ID, 'bulk-stale-import', 'spike', ['--rate'])],
    [sendArgs(RUN_ID, 'bulk-stale-import', 'spike', ['--lane-profile', 'fothering-bulk'])],
    [sendArgs(RUN_ID, 'bulk-stale-import', 'spike', ['--lane-profile', `fothering-bulk=${PROFILES.bulk}`])],
    [sendArgs(RUN_ID, 'bulk-stale-import', 'spike', ['--lane-profile', '=nameless'])],
    [sendArgs(RUN_ID, 'bulk-stale-import', 'spike', ['--lane-profile', 'fothering-alerts='])],
    [['send', RUN_ID, 'bulk-stale-import', 'spike', '--from', FROM, '--lane-profile', `fothering-bulk=${PROFILES.bulk}`]],
  ])('refuses the command line %j as a usage error', async (argv) => {
    const outcome = await run(argv);
    expect(refusalLine(outcome)).toBe(refusalMessage('usage'));
    expect(outcome.err[1]).toBe(LIVE_RUN_MESSAGES.usage);
  });
});

// After the port factory: exit 1, the named refusal first, nothing sent and no line with an
// address or a profile name. Caller and account ports exist by then, so constructions may not be 0.
function portRefusalLine(outcome: Outcome): string {
  const leaks = [...outcome.out, ...outcome.err].filter((line) => line.includes('@') || Object.values(PROFILES).some((profile) => line.includes(profile)));
  const sends = sendsOf(outcome.state).length;
  if (outcome.code !== 1 || sends !== 0 || leaks.length > 0) {
    return `exit ${outcome.code}, ${sends} sends, ${leaks.length} lines with an address or profile`;
  }
  return outcome.err[0] ?? 'no error line';
}

function readAttempts(root: string, step: string): AttemptRecord[] {
  return readFileSync(join(runFolder(root), `${step}.attempts.jsonl`), 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => attemptRecordSchema.parse(JSON.parse(line)));
}

describe('callers and the account are read and judged before the first send', () => {
  it('refuses two sessions of one role behind two lanes', async () => {
    const state = fixtureState();
    state.callers.set(PROFILES.bulk, { arn: roleArn('live-run-shared', 'session-1'), account: ACCOUNT });
    state.callers.set(PROFILES.transactional, { arn: roleArn('live-run-shared', 'session-2'), account: ACCOUNT });
    expect(portRefusalLine(await run(sendArgs(RUN_ID, 'bulk-stale-import', 'spike'), { state }))).toBe(refusalMessage('caller-shared', 'fothering-transactional'));
  });

  it('passes role names that differ only in case as two callers', async () => {
    const state = fixtureState();
    state.callers.set(PROFILES.bulk, { arn: roleArn('Live-Run-Lane'), account: ACCOUNT });
    state.callers.set(PROFILES.transactional, { arn: roleArn('live-run-lane'), account: ACCOUNT });
    const outcome = await run(sendArgs(RUN_ID, 'bulk-stale-import', 'spike'), { state });
    expect(outcome.code).toBe(0);
    expect(sendsOf(state)).toHaveLength(132);
  });

  it.each([
    ['an IAM user', `arn:aws:iam::${ACCOUNT}:user/operator`],
    ['a federated user', `arn:aws:sts::${ACCOUNT}:federated-user/operator`],
    ['the root user', `arn:aws:iam::${ACCOUNT}:root`],
  ])('refuses %s as a lane caller, naming the lane', async (_label, arn) => {
    const state = fixtureState();
    state.callers.set(PROFILES.bulk, { arn, account: ACCOUNT });
    expect(portRefusalLine(await run(sendArgs(RUN_ID, 'bulk-stale-import', 'spike'), { state }))).toBe(refusalMessage('caller-not-role', 'fothering-bulk'));
  });

  it('refuses a lane caller in another account', async () => {
    const state = fixtureState();
    const other = '1'.repeat(12);
    state.callers.set(PROFILES.transactional, { arn: roleArn('live-run-transactional', 'session-1', other), account: other });
    expect(portRefusalLine(await run(sendArgs(RUN_ID, 'bulk-stale-import', 'spike'), { state }))).toBe(refusalMessage('account-mismatch', 'fothering-transactional'));
  });

  it('refuses an account profile in another account than the lanes', async () => {
    const state = fixtureState();
    const other = '1'.repeat(12);
    state.callers.set(PROFILES.account, { arn: roleArn('live-run-account', 'session-1', other), account: other });
    expect(portRefusalLine(await run(sendArgs(RUN_ID, 'bulk-stale-import', 'spike'), { state }))).toBe(refusalMessage('account-mismatch', 'fothering-bulk'));
  });

  it('refuses a lane profile that does not resolve, naming the lane', async () => {
    const state = fixtureState();
    state.callers.delete(PROFILES.bulk);
    expect(portRefusalLine(await run(sendArgs(RUN_ID, 'bulk-stale-import', 'spike'), { state }))).toBe(refusalMessage('caller-unresolved', 'fothering-bulk'));
  });

  it('refuses an account profile that does not resolve', async () => {
    const state = fixtureState();
    state.callers.delete(PROFILES.account);
    expect(portRefusalLine(await run(sendArgs(RUN_ID, 'bulk-stale-import', 'spike'), { state }))).toBe(refusalMessage('caller-unresolved'));
  });

  it('reads each caller once and the account once, all before the first send', async () => {
    const state = fixtureState();
    expect((await run(sendArgs(RUN_ID, 'bulk-stale-import', 'spike'), { state })).code).toBe(0);
    const firstSend = state.calls.findIndex((call) => call.operation === 'sendEmail');
    const before = state.calls.slice(0, firstSend);
    expect(before.map((call) => `${call.operation}:${call.profile}`).sort()).toEqual(
      [`getAccount:${PROFILES.account}`, ...Object.values(PROFILES).map((profile) => `getCallerIdentity:${profile}`)].sort(),
    );
    expect(state.calls.filter((call) => call.operation !== 'sendEmail')).toHaveLength(before.length);
  });

  it.each([
    ['0.5 per second', 0.5],
    ['absent', 'absent' as const],
  ])('refuses an account whose MaxSendRate is %s', async (_label, maxSendRate) => {
    const state = fixtureState();
    state.account = { vdmEnabled: 'ENABLED', productionAccessEnabled: true, maxSendRate, requestId: 'fixture-request-account' };
    expect(portRefusalLine(await run(sendArgs(RUN_ID, 'bulk-stale-import', 'spike'), { state }))).toBe(refusalMessage('send-rate-low'));
  });

  it('refuses when GetAccount does not answer', async () => {
    const state = fixtureState();
    state.account = { errorName: 'AccessDeniedException' };
    expect(portRefusalLine(await run(sendArgs(RUN_ID, 'bulk-stale-import', 'spike'), { state }))).toBe(refusalMessage('account-unreadable'));
  });
});

function withLatency(factory: LiveRunPortFactory, clock: FakeClock, latencies: readonly number[], starts: number[]): LiveRunPortFactory {
  return {
    callerIdentity: (profile) => factory.callerIdentity(profile),
    ses: (profile) => {
      const port = factory.ses(profile);
      return {
        getAccount: () => port.getAccount(),
        sendEmail: async (request) => {
          starts.push(clock.monotonicMs());
          clock.advance(latencies[starts.length % latencies.length] ?? 0);
          return port.sendEmail(request);
        },
      };
    },
  };
}

describe('the attempt log holds under faults', () => {
  it('records a paused lane and a throttle by error name only, keeps the pace and never retries', async () => {
    const state = fixtureState();
    state.sendAnswers = ['accept', { errorName: 'SendingPausedException' }, 'accept', { errorName: 'TooManyRequestsException' }, 'accept', 'accept'];
    const outcome = await run(sendArgs(RUN_ID, 'bulk-stale-import', 'after-pause'), { state });
    expect(outcome.code).toBe(0);
    expect(sendsOf(state)).toHaveLength(6);
    const records = readAttempts(outcome.root, 'after-pause');
    expect(records.map((record) => ('errorName' in record ? record.errorName : record.messageId))).toEqual([
      'fixture-message-1', 'SendingPausedException', 'fixture-message-3', 'TooManyRequestsException', 'fixture-message-5', 'fixture-message-6',
    ]);
    expect(Object.keys(records[1] ?? {}).sort()).toEqual(['endUtc', 'errorName', 'lane', 'recipient', 'startUtc', 'tags']);
    expect(spacingViolations(attemptStartsMs(outcome.root, 'after-pause'), MIN_SEND_GAP_MS)).toEqual([]);
  });

  it('records a thrown value that is not an Error under a fixed name', async () => {
    const root = plantRoot();
    const state = fixtureState();
    const { deps } = harness(root, state, 'live');
    const fixture = deps.portFactory;
    const throwing = (): LiveRunPortFactory => {
      const factory = fixture();
      return {
        callerIdentity: (profile) => factory.callerIdentity(profile),
        ses: (profile) => {
          const port = factory.ses(profile);
          return {
            getAccount: () => port.getAccount(),
            sendEmail: () => Promise.reject(new Map([['reason', 'not an error']])),
          };
        },
      };
    };
    expect(await main(sendArgs(RUN_ID, 'bulk-stale-import', 'after-pause'), { ...deps, portFactory: throwing })).toBe(0);
    expect(readAttempts(root, 'after-pause').map((record) => ('errorName' in record ? record.errorName : 'accepted'))).toEqual(Array(6).fill('non-error-throw'));
  });

  it('keeps every finished attempt, in send order, when the step stops part way', async () => {
    const root = plantRoot();
    const state = fixtureState();
    const { deps, clock } = harness(root, state, 'live');
    let sleeps = 0;
    const stopping = async (ms: number): Promise<void> => {
      sleeps += 1;
      if (sleeps === 3) throw new Error('the operator stopped the step');
      await clock.sleep(ms);
    };
    await expect(main(sendArgs(RUN_ID, 'bulk-stale-import', 'spike'), { ...deps, sleep: stopping })).rejects.toThrow('the operator stopped the step');
    const records = readAttempts(root, 'spike');
    expect(records.map((record) => record.recipient)).toEqual(stepPlan(SOURCE, 'bulk-stale-import', 'spike', RUN_ID).slice(0, 3).map((entry) => entry.recipient));
    const starts = records.map((record) => Date.parse(record.startUtc));
    expect(starts).toEqual([...starts].sort((a, b) => a - b));
    expect(existsSync(join(root, 'reports', 'live-runs', '.lock'))).toBe(false);
  });

  it('writes a newline first when the attempts file does not end in one', () => {
    const root = plantRoot();
    const file = join(root, 'torn.jsonl');
    const record: AttemptRecord = {
      lane: 'fothering-bulk',
      tags: [{ name: 'stream', value: 'newsletter' }],
      recipient: `success+${RUN_ID}-spike-001@simulator.amazonses.com`,
      startUtc: '2026-10-22T09:00:00.000Z',
      endUtc: '2026-10-22T09:00:00.250Z',
      messageId: 'fixture-message-1',
      requestId: 'fixture-request-1',
    };
    // What a write cut off mid-record leaves behind: a partial line with no newline after it.
    const torn = JSON.stringify(record).slice(0, 40);
    writeFileSync(file, torn);
    appendAttempt(file, record);
    appendAttempt(file, record);
    expect(readFileSync(file, 'utf8')).toBe(`${torn}\n${JSON.stringify(record)}\n${JSON.stringify(record)}\n`);
  });

  it('starts a new attempts file with the record itself', () => {
    const file = join(plantRoot(), 'fresh.jsonl');
    const record: AttemptRecord = {
      lane: 'fothering-bulk',
      tags: [{ name: 'stream', value: 'newsletter' }],
      recipient: `success+${RUN_ID}-spike-001@simulator.amazonses.com`,
      startUtc: '2026-10-22T09:00:00.000Z',
      endUtc: '2026-10-22T09:00:00.250Z',
      errorName: 'SendingPausedException',
    };
    appendAttempt(file, record);
    expect(readFileSync(file, 'utf8')).toBe(`${JSON.stringify(record)}\n`);
  });

  it('keeps the gap across lanes for any plan and any send latency', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 6 }),
        fc.integer({ min: 1, max: 6 }),
        fc.integer({ min: 1, max: 3 }),
        fc.integer({ min: 1, max: 3 }),
        fc.array(fc.integer({ min: 0, max: 4000 }), { minLength: 1, maxLength: 12 }),
        async (bulk, transactional, bulkTake, transactionalTake, latencies) => {
          const scenarios = sourceCopy();
          const step = scenarios.scenarios[0]?.steps[1];
          const [bulkGroup, transactionalGroup] = step?.groups ?? [];
          if (step === undefined || bulkGroup === undefined || transactionalGroup === undefined) throw new Error('run 1 has no after-pause groups');
          bulkGroup.count = bulk;
          transactionalGroup.count = transactional;
          step.cycle = [
            { group: bulkGroup.name, take: bulkTake },
            { group: transactionalGroup.name, take: transactionalTake },
          ];
          const { deps, clock } = harness(plantRoot(), fixtureState(), 'live', { scenarios });
          const starts: number[] = [];
          const fixture = deps.portFactory;
          const code = await main(sendArgs(RUN_ID, 'bulk-stale-import', 'after-pause'), {
            ...deps,
            portFactory: () => withLatency(fixture(), clock, latencies, starts),
          });
          expect(code).toBe(0);
          expect(starts).toHaveLength(bulk + transactional);
          expect(spacingViolations(starts, MIN_SEND_GAP_MS)).toEqual([]);
        },
      ),
      { seed: propertySeed(), numRuns: 30 },
    );
  });
});

describe('plan prints a step without the switch or any port', () => {
  it('prints run 1 spike as a header and 132 lines', async () => {
    const outcome = await run(['plan', 'bulk-stale-import', 'spike', RUN_ID], { switchValue: undefined });
    expect(outcome.code).toBe(0);
    expect(outcome.out[0]).toBe(LIVE_RUN_MESSAGES.planHeader('bulk-stale-import', 'spike', 132));
    expect(outcome.out).toHaveLength(133);
    expect(outcome.out[1]).toBe('001 fothering-bulk batch=clean-import success');
    expect(outcome.out[11]).toBe('011 fothering-transactional template=order-receipt success');
    expect(outcome.state.constructions).toBe(0);
    expect(outcome.out.some((line) => line.includes('@'))).toBe(false);
  });

  it('refuses an unknown scenario and a run id of another run', async () => {
    expect(refusalLine(await run(['plan', 'no-such-scenario', 'spike', RUN_ID]))).toBe(refusalMessage('unknown-scenario', 'no-such-scenario'));
    expect(refusalLine(await run(['plan', 'bulk-stale-import', 'spike', 'live-20261022-s3-1']))).toBe(refusalMessage('run-id-invalid'));
  });

  it('refuses a missing argument as a usage error', async () => {
    expect(refusalLine(await run(['plan', 'bulk-stale-import', 'spike']))).toBe(refusalMessage('usage'));
  });
});

describe('buildLiveRunRoot', () => {
  const OVERRIDES: (keyof BuildLiveRunRootOptions)[] = ['scenarios', 'laneMap', 'monotonicMs', 'nowUtc', 'sleep', 'gitCheckIgnore'];

  it.each(OVERRIDES)('refuses a %s override outside runtimeContext test', (name) => {
    const options = { runtimeContext: 'deployed', switchValue: 'live', repoRoot: REPO_ROOT, [name]: () => 0 } as BuildLiveRunRootOptions;
    expect(() => buildLiveRunRoot(options)).toThrow(`a ${name} override is accepted only in runtimeContext test`);
    expect(() => buildLiveRunRoot({ ...options, runtimeContext: 'test' })).not.toThrow();
  });

  it('builds no live port factory in deployed while the switch is not exactly live', () => {
    let built = 0;
    const liveFactory = (): LiveRunPortFactory => {
      built += 1;
      throw new Error('never built in this test');
    };
    for (const switchValue of [undefined, '', 'LIVE', ' live', 'true']) {
      const deps = buildLiveRunRoot({ runtimeContext: 'deployed', switchValue, repoRoot: REPO_ROOT, liveFactory });
      expect(() => deps.portFactory()).toThrow('reads live');
    }
    expect(built).toBe(0);
  });

  it('hands over the live factory in deployed only once the switch reads live, and refuses with none given', () => {
    const live: LiveRunPortFactory = {
      ses: () => {
        throw new Error('a live port is never built in this test');
      },
      callerIdentity: () => {
        throw new Error('a live port is never built in this test');
      },
    };
    const deps = buildLiveRunRoot({ runtimeContext: 'deployed', switchValue: 'live', repoRoot: REPO_ROOT, liveFactory: () => live });
    expect(deps.portFactory()).toBe(live);
    const without = buildLiveRunRoot({ runtimeContext: 'deployed', switchValue: 'live', repoRoot: REPO_ROOT });
    expect(() => without.portFactory()).toThrow('no live port factory was given');
  });

  it('defaults to the committed source and lane map, the real clocks and the shared sleep', async () => {
    const deps = buildLiveRunRoot({ runtimeContext: 'test', switchValue: undefined, repoRoot: REPO_ROOT });
    expect(deps.scenarios).toEqual(SOURCE);
    expect(deps.laneMap).toEqual(LANES);
    expect(deps.sleep).toBe(sleep);
    expect(typeof deps.monotonicMs()).toBe('number');
    expect(Math.abs(deps.nowUtc() - Date.now())).toBeLessThan(60_000);
    await expect(deps.portFactory().callerIdentity('unscripted').getCallerIdentity()).rejects.toThrow('the fixture holds no caller for that profile');
    expect(() => deps.gitCheckIgnore(join(REPO_ROOT, 'packages', 'functions', 'src', 'live-run', 'cli.ts'))).toThrow();
    expect(() => deps.gitCheckIgnore(join(REPO_ROOT, 'node_modules'))).not.toThrow();
  });
});

interface ImportFact {
  specifier: string;
  /** Value names only; a name written `type X` is erased at build time and never loads anything. */
  names: string[];
  typeOnly: boolean;
}

// One expression per import form: a statement with a clause (import or re-export), a bare import,
// and a dynamic import. The clause class stops at `=` and `;`, so `export const x = ...` never matches.
const IMPORT_FORMS = {
  clause: /^[ \t]*(?:import|export)\s+(type\s+)?([\w$*{}\s,]*?)\s*from\s*['"]([^'"]+)['"]/gm,
  bare: /^[ \t]*import\s*['"]([^'"]+)['"]/gm,
  dynamic: /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
};

function clauseNames(clause: string): string[] {
  const braced = /\{([\s\S]*)\}/.exec(clause);
  const outside = clause.replace(/\{[\s\S]*\}/, '').split(',').map((part) => part.trim()).filter((part) => part !== '');
  const inside = (braced?.[1] ?? '').split(',').map((part) => part.trim()).filter((part) => part !== '' && !part.startsWith('type '));
  return [...outside.map((part) => (part.startsWith('*') ? '*' : 'default')), ...inside.map((part) => part.split(/\s+as\s+/)[0] ?? part)];
}

function importsOf(text: string): ImportFact[] {
  const facts: ImportFact[] = [];
  for (const match of text.matchAll(IMPORT_FORMS.clause)) {
    const names = clauseNames(match[2] ?? '');
    facts.push({ specifier: match[3] ?? '', names, typeOnly: match[1] !== undefined || names.length === 0 });
  }
  for (const match of text.matchAll(IMPORT_FORMS.bare)) facts.push({ specifier: match[1] ?? '', names: [], typeOnly: false });
  for (const match of text.matchAll(IMPORT_FORMS.dynamic)) facts.push({ specifier: match[1] ?? '', names: ['*'], typeOnly: false });
  return facts;
}

const AWS_FAMILIES = /^(?:@aws-sdk\/|@smithy\/|@aws-crypto\/|bedrock-agentcore|aws4fetch)/;

// What the command may load from providers, by module and, where it narrows anything, by name.
// ses-facts holds only type imports of its own, and the command takes its sleep and nothing else.
const PROVIDER_IMPORTS = new Map<string, readonly string[] | 'any'>([
  ['@fothering/providers/live-run-port-types', 'any'],
  ['@fothering/providers/fixtures/live-run-ports', 'any'],
  ['@fothering/providers/live/live-run-ports', ['createLiveRunPortFactory']],
  ['@fothering/providers/live-switch', ['readLiveSwitch']],
  ['@fothering/providers/ses-facts', ['sleep']],
  ['@fothering/providers/saved-items', ['readSavedItems']],
]);

function commandImportViolations(file: string, text: string): string[] {
  const violations: string[] = [];
  for (const fact of importsOf(text)) {
    if (AWS_FAMILIES.test(fact.specifier)) {
      violations.push(`${file}: ${fact.specifier}`);
    } else if (fact.specifier.startsWith('@fothering/providers/')) {
      const allowed = PROVIDER_IMPORTS.get(fact.specifier);
      if (allowed === undefined) violations.push(`${file}: ${fact.specifier}`);
      else if (allowed !== 'any') violations.push(...fact.names.filter((name) => !allowed.includes(name)).map((name) => `${file}: ${name} from ${fact.specifier}`));
    } else if (fact.specifier.startsWith('../') && !fact.specifier.endsWith('.json') && !fact.typeOnly) {
      // A value import out of this folder could carry a deployed root, and with it PORT_TABLE.
      violations.push(`${file}: ${fact.specifier}`);
    }
  }
  return violations;
}

const ADAPTER_SDK_NAMES = new Map<string, readonly string[]>([
  ['@aws-sdk/client-sesv2', ['GetAccountCommand', 'SendEmailCommand', 'SESv2Client']],
  ['@aws-sdk/client-sts', ['GetCallerIdentityCommand', 'STSClient']],
]);
const ADAPTER_RELATIVE_IMPORTS = new Set(['../live-run-port-types.js', '../port-types.js', './lazy-client.js']);

function adapterImportViolations(text: string): string[] {
  const violations: string[] = [];
  for (const fact of importsOf(text)) {
    const sdkNames = ADAPTER_SDK_NAMES.get(fact.specifier);
    if (sdkNames !== undefined) violations.push(...fact.names.filter((name) => !sdkNames.includes(name)).map((name) => `${name} from ${fact.specifier}`));
    else if (!ADAPTER_RELATIVE_IMPORTS.has(fact.specifier)) violations.push(fact.specifier);
  }
  return violations;
}

function commandClassesOf(text: string): string[] {
  return importsOf(text)
    .filter((fact) => fact.specifier.startsWith('@aws-sdk/'))
    .flatMap((fact) => fact.names.filter((name) => name.endsWith('Command')))
    .sort();
}

const LIVE_RUN_DIR = join(REPO_ROOT, 'packages', 'functions', 'src', 'live-run');
const ADAPTER_FILE = join(REPO_ROOT, 'packages', 'providers', 'src', 'live', 'live-run-ports.ts');
// The files the scan reads, named so a new source file in the folder fails the list check below
// until it is added here and scanned.
const COMMAND_FILES = ['check-saved.ts', 'cli.ts', 'root.ts', 'send.ts'];

describe('the command can reach SendEmail, GetAccount and GetCallerIdentity and nothing else', () => {
  it('names every non-test source file in the command folder', () => {
    const sources = readdirSync(LIVE_RUN_DIR).filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'));
    expect(sources.sort()).toEqual([...COMMAND_FILES].sort());
  });

  it('imports from providers only the live-run ports, the switch reader, sleep and the saved-items reader, and no AWS package', () => {
    const violations = COMMAND_FILES.flatMap((file) => commandImportViolations(file, readFileSync(join(LIVE_RUN_DIR, file), 'utf8')));
    expect(violations).toEqual([]);
  });

  it('the live adapter imports exactly the three command classes and their two clients', () => {
    const text = readFileSync(ADAPTER_FILE, 'utf8');
    expect(commandClassesOf(text)).toEqual(['GetAccountCommand', 'GetCallerIdentityCommand', 'SendEmailCommand']);
    expect(adapterImportViolations(text)).toEqual([]);
  });

  it('reports a planted pause command, the product port table and an IAM client (control)', () => {
    const planted = [
      "import { PutConfigurationSetSendingOptionsCommand } from '@aws-sdk/client-sesv2';",
      "import { PORT_TABLE } from '@fothering/providers/ports';",
      "import { createSesWrites } from '@fothering/providers/live/ses-writes';",
      "import { readSesFacts } from '@fothering/providers/ses-facts';",
      "import { buildIngestRoot } from '../ingest/root.js';",
      "const iam = await import('@aws-sdk/client-iam');",
    ].join('\n');
    expect(commandImportViolations('planted.ts', planted)).toEqual([
      'planted.ts: @aws-sdk/client-sesv2',
      'planted.ts: @fothering/providers/ports',
      'planted.ts: @fothering/providers/live/ses-writes',
      'planted.ts: readSesFacts from @fothering/providers/ses-facts',
      'planted.ts: ../ingest/root.js',
      'planted.ts: @aws-sdk/client-iam',
    ]);

    const adapter = readFileSync(ADAPTER_FILE, 'utf8');
    const plantedAdapter = `import {\n  PutConfigurationSetSendingOptionsCommand,\n} from '@aws-sdk/client-sesv2';\nimport { IAMClient } from '@aws-sdk/client-iam';\nimport { PORT_TABLE } from '../ports.js';\n${adapter}`;
    expect(adapterImportViolations(plantedAdapter)).toEqual([
      'PutConfigurationSetSendingOptionsCommand from @aws-sdk/client-sesv2',
      '@aws-sdk/client-iam',
      '../ports.js',
    ]);
    expect(commandClassesOf(plantedAdapter)).toContain('PutConfigurationSetSendingOptionsCommand');
  });

  it('hands out ports whose only methods are the narrow ones, from the fixture and the live factory alike', () => {
    for (const factory of [createFixtureLiveRunPorts(createFixtureLiveRunState()), createLiveRunPortFactory()]) {
      expect(Object.keys(factory.ses('planted-profile')).sort()).toEqual(['getAccount', 'sendEmail']);
      expect(Object.keys(factory.callerIdentity('planted-profile'))).toEqual(['getCallerIdentity']);
    }
  });
});

interface DeployedOutcome {
  line: string;
  factoryCalls: number;
  constructions: number;
  sends: number;
}

// A deployed root, as the process entry builds it, with a liveFactory that counts its calls and
// hands back fixture ports holding no callers, so a run that gets past every local check stops at
// the callers phase and never sends.
async function runDeployed(argv: readonly string[], switchValue: string | undefined): Promise<DeployedOutcome> {
  const state = createFixtureLiveRunState();
  const err: string[] = [];
  let factoryCalls = 0;
  const deps = buildLiveRunRoot({
    runtimeContext: 'deployed',
    switchValue,
    repoRoot: plantRoot(),
    io: { out: () => undefined, err: (line) => err.push(line) },
    liveFactory: () => {
      factoryCalls += 1;
      return createFixtureLiveRunPorts(state);
    },
  });
  const code = await main(argv, deps);
  const sends = sendsOf(state).length;
  const line = `exit ${code}, factory ${factoryCalls}, ports ${state.constructions}, sends ${sends}, ${err[0] ?? 'no error line'}`;
  return { line, factoryCalls, constructions: state.constructions, sends };
}

describe('only an exact switch builds a port, and only once the local checks have passed', () => {
  it.each([
    ['unset', undefined],
    ['LIVE', 'LIVE'],
  ])('a deployed root with the switch %s calls no live factory and builds no port', async (_label, switchValue) => {
    const outcome = await runDeployed(sendArgs(RUN_ID, 'bulk-stale-import', 'spike'), switchValue);
    expect(outcome.line).toBe(`exit 1, factory 0, ports 0, sends 0, ${refusalMessage('switch-not-live')}`);
  });

  it('a deployed root with exactly live and a refused run id calls no live factory', async () => {
    const outcome = await runDeployed(sendArgs('run-one', 'bulk-stale-import', 'spike'), 'live');
    expect(outcome.line).toBe(`exit 1, factory 0, ports 0, sends 0, ${refusalMessage('run-id-invalid')}`);
  });

  it('a deployed root with exactly live builds ports only at the callers phase, and sends nothing there', async () => {
    const outcome = await runDeployed(sendArgs(RUN_ID, 'bulk-stale-import', 'spike'), 'live');
    expect(outcome.line.startsWith('exit 1, factory 1, ')).toBe(true);
    expect(outcome.constructions).toBeGreaterThan(0);
    expect(outcome.sends).toBe(0);
    expect(outcome.line.endsWith(refusalMessage('caller-unresolved', 'fothering-bulk'))).toBe(true);
  });
});

describe('send takes profile names only and refuses any flag it does not know', () => {
  const PLANTED_KEY = 'planted-key-value';

  it.each([
    ['an unknown flag with a value', ['--access-key', PLANTED_KEY]],
    ['an unknown flag written with an equals sign', [`--secret-access-key=${PLANTED_KEY}`]],
    ['an unknown flag with no value', ['--debug']],
  ])('refuses %s as a usage error, building nothing and echoing nothing', async (_label, extra) => {
    const outcome = await run(sendArgs(RUN_ID, 'bulk-stale-import', 'spike', extra));
    expect(refusalLine(outcome)).toBe(refusalMessage('usage'));
    expect([...outcome.out, ...outcome.err].some((line) => line.includes(PLANTED_KEY))).toBe(false);
  });

  const LANES_ARGS = ['--lane-profile', `fothering-bulk=${PROFILES.bulk}`, '--lane-profile', `fothering-transactional=${PROFILES.transactional}`];

  it.each([
    ['the account profile', ['--from', FROM, '--account-profile', '--debug', ...LANES_ARGS]],
    ['the from address', ['--account-profile', PROFILES.account, ...LANES_ARGS, '--from', '--debug']],
    ['the rate', ['--from', FROM, '--account-profile', PROFILES.account, ...LANES_ARGS, '--rate', '--debug']],
    ['a lane profile', ['--from', FROM, '--account-profile', PROFILES.account, '--lane-profile', `--access-key=${PLANTED_KEY}`, ...LANES_ARGS]],
  ])('refuses an unknown flag standing where %s belongs, instead of reading it as the value', async (_label, flags) => {
    const outcome = await run(['send', RUN_ID, 'bulk-stale-import', 'spike', ...flags]);
    expect(refusalLine(outcome)).toBe(refusalMessage('usage'));
    expect([...outcome.out, ...outcome.err].some((line) => line.includes(PLANTED_KEY))).toBe(false);
  });
});
