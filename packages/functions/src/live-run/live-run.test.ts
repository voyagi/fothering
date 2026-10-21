import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { parseLaneMap, type LaneEntry } from '@fothering/core/lanes';
import { attemptRecordSchema, MIN_SEND_GAP_MS, refusalMessage, spacingViolations } from '@fothering/core/live-run';
import { parseScenarioSource, stepPlan, type ScenarioSource, type ScenarioTagKind } from '@fothering/core/scenarios';
import {
  createFixtureLiveRunState,
  type FixtureLiveRunCall,
  type FixtureLiveRunState,
} from '@fothering/providers/fixtures/live-run-ports';
import type { LiveRunSendRequest } from '@fothering/providers/live-run-port-types';
import { main } from './cli.js';
import { buildLiveRunRoot, type BuildLiveRunRootOptions, type LiveRunDeps } from './root.js';
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
});
