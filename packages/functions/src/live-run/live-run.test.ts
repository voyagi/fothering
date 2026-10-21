import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { parseLaneMap, type LaneEntry } from '@fothering/core/lanes';
import { attemptRecordSchema } from '@fothering/core/live-run';
import { parseScenarioSource, stepPlan, type ScenarioTagKind } from '@fothering/core/scenarios';
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
const PROFILES = { account: 'account-profile', bulk: 'bulk-profile', transactional: 'transactional-profile' } as const;

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
