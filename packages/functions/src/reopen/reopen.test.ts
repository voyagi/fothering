import { describe, expect, it } from 'vitest';
import { closureKey, parseClosure, type Closure } from '@fothering/core/closure';
import { reserveLaneAttempt } from '@fothering/core/counters';
import { counterLaneHourKey } from '@fothering/core/evidence-record';
import { REOPEN_USAGE, ReopenUsageError, incidentLimitSentence, reputationResetSentence } from '@fothering/core/reopen';
import { createFixtureTableState } from '@fothering/providers/fixtures/ingest-ports';
import { createFixtureSesState } from '@fothering/providers/fixtures/later-ports';
import type { DecisionStoreItem, DecisionStorePort, FixtureSesState, FixtureTableState } from '@fothering/providers/port-types';
import { SES_READ_SPACING_MS } from '@fothering/providers/ses-facts';
import { runActionCycle } from '../action/action.js';
import {
  BULK,
  HOLD_CHECKED_AT_MS,
  buildTestActionRoot,
  buildTestReopenRoot,
  closedWordViolations,
  seedClosedLane,
  storedClosure,
  type TestReopenRoot,
} from '../test/close-scenario.js';
import { reopenFromPayload } from './handler.js';
import { buildReopenRoot, type ReopenDeps } from './root.js';
import type { ReopenReport } from './reopen.js';

const BULK_PAYLOAD = { configurationSet: BULK };
const ALERTS = 'fothering-alerts';

function putsOf(state: FixtureSesState): string[] {
  return state.calls.filter((call) => call.startsWith('put-issued'));
}

// Each wait the command asks for lands in the fixture SES's own call log, so one list shows the
// spacing, the put and the read-back in the order they were issued.
function waitsRecorded(deps: ReopenDeps, calls: string[]): ReopenDeps {
  return {
    ...deps,
    wait: async (ms) => {
      calls.push(`wait:${ms}`);
      await deps.wait(ms);
    },
  };
}

interface ClosedLane {
  store: FixtureTableState;
  incidentId: string;
  pausedAtMs: number;
  reopenAtMs: number;
  sesState: FixtureSesState;
  /** Every line the reopen roots built here logged. */
  lines: string[];
  reopenRoot: (nowMs?: number) => TestReopenRoot;
}

async function closedLane(through: 'paused' | 'closed' = 'closed'): Promise<ClosedLane> {
  const store = createFixtureTableState();
  const sesState = createFixtureSesState();
  const lines: string[] = [];
  const { incidentId, pausedAtMs } = await seedClosedLane({ store, sesState, through });
  const reopenAtMs = pausedAtMs + 400_000;
  const reopenRoot = (nowMs = reopenAtMs): TestReopenRoot => buildTestReopenRoot({ store, sesState, now: () => nowMs, logSink: (line) => lines.push(line) });
  return { store, incidentId, pausedAtMs, reopenAtMs, sesState, lines, reopenRoot };
}

// Rewrites the seeded closure through the decision store port, so a planted outcome passes the same
// key and value checks a real write does.
async function rewriteClosure(deps: ReopenDeps, incidentId: string, attributes: Readonly<Record<string, unknown>>, nowMs: number): Promise<void> {
  const closure = await storedClosure(deps, incidentId, nowMs);
  if (closure === undefined) throw new Error('no closure is stored to rewrite');
  if ((await deps.ports.decisionStore.updateIfVersion(closureKey(incidentId), closure.version, attributes, nowMs)) !== 'updated') {
    throw new Error('the closure moved while the test rewrote it');
  }
}

function loggedEvents(lines: readonly string[], event: string): Record<string, unknown>[] {
  return lines.map((line) => JSON.parse(line) as Record<string, unknown>).filter((entry) => entry.event === event);
}

function laneHourItem(deps: ReopenDeps, nowMs: number): Promise<DecisionStoreItem | undefined> {
  return deps.ports.decisionStore.getItem(counterLaneHourKey(BULK, new Date(nowMs).toISOString().slice(0, 13)), nowMs);
}

describe('the reopen command re-enables a lane Fothering paused, after a read-back (R7)', () => {
  it('reopens a closed fothering-bulk once, writes reopened only after the read-back reads true and prints the two sentences (tracer)', async () => {
    const { incidentId, reopenAtMs, sesState, reopenRoot } = await closedLane();
    const { deps } = reopenRoot();
    const callsBefore = sesState.calls.length;

    const report = await reopenFromPayload(BULK_PAYLOAD, waitsRecorded(deps, sesState.calls));

    expect(report.result).toBe('reopened');
    expect(report).toEqual({
      result: 'reopened',
      configurationSet: BULK,
      requestedAtMs: reopenAtMs,
      readBackAtMs: reopenAtMs,
      note: reputationResetSentence(BULK),
      limit: incidentLimitSentence(BULK),
    });
    const closure = await storedClosure(deps, incidentId, reopenAtMs);
    expect(closure?.outcome).toBe('closed');
    expect(closure?.reopen).toEqual({ attempts: 1, claimedAtMs: reopenAtMs, requestedAtMs: reopenAtMs, readBackAtMs: reopenAtMs, outcome: 'reopened' });
    for (const time of [closure?.reopen?.claimedAtMs, closure?.reopen?.requestedAtMs, closure?.reopen?.readBackAtMs]) expect(Number.isInteger(time)).toBe(true);
    expect(sesState.calls.slice(callsBefore)).toEqual([
      `wait:${SES_READ_SPACING_MS}`,
      'put-issued:fothering-bulk:true',
      'put-resolved:fothering-bulk:true',
      `wait:${SES_READ_SPACING_MS}`,
      'get-issued:fothering-bulk',
      'get-resolved:fothering-bulk',
    ]);
    const counter = await deps.ports.decisionStore.getItem(counterLaneHourKey(BULK, new Date(reopenAtMs).toISOString().slice(0, 13)), reopenAtMs);
    expect(counter).toMatchObject({ attempts: 2 });
  });

  it('makes no reopen call across the detection, action and hold-check runs (AC-P4, reopen half)', async () => {
    const { sesState } = await closedLane();

    expect(putsOf(sesState)).toEqual(['put-issued:fothering-bulk:false']);
  });

  it('records reopen-failed when the read-back reads false, and does not report a reopen (AC-14)', async () => {
    const { incidentId, reopenAtMs, sesState, reopenRoot } = await closedLane();
    sesState.getAnswers.set(BULK, false);
    const { deps } = reopenRoot();

    const report = await reopenFromPayload(BULK_PAYLOAD, deps);

    expect(report.result).toBe('reopen-failed');
    expect((await storedClosure(deps, incidentId, reopenAtMs))?.reopen?.outcome).toBe('reopen-failed');
  });

  it('records reopen-unknown when the read-back throws, and does not report a reopen (AC-14)', async () => {
    const { incidentId, reopenAtMs, sesState, reopenRoot } = await closedLane();
    sesState.getAnswers.set(BULK, 'throw');
    const { deps } = reopenRoot();

    const report = await reopenFromPayload(BULK_PAYLOAD, deps);

    expect(report.result).toBe('reopen-unknown');
    expect((await storedClosure(deps, incidentId, reopenAtMs))?.reopen?.outcome).toBe('reopen-unknown');
  });

  it('records reopen-unknown when the read-back answers without the sending field (AC-14)', async () => {
    const { incidentId, reopenAtMs, sesState, reopenRoot } = await closedLane();
    sesState.getAnswers.set(BULK, 'missing');
    const { deps } = reopenRoot();

    expect((await reopenFromPayload(BULK_PAYLOAD, deps)).result).toBe('reopen-unknown');
    expect((await storedClosure(deps, incidentId, reopenAtMs))?.reopen?.outcome).toBe('reopen-unknown');
  });

  it('records reopen-failed with no read-back when the put throws (AC-14)', async () => {
    const { incidentId, reopenAtMs, sesState, reopenRoot } = await closedLane();
    sesState.putFaults.set(BULK, 'throw');
    const { deps } = reopenRoot();
    const callsBefore = sesState.calls.length;

    const report = await reopenFromPayload(BULK_PAYLOAD, deps);

    expect(report.result).toBe('reopen-failed');
    expect(sesState.calls.slice(callsBefore)).toEqual(['put-issued:fothering-bulk:true']);
    expect((await storedClosure(deps, incidentId, reopenAtMs))?.reopen).toMatchObject({ outcome: 'reopen-failed', readBackAtMs: null });
  });

  it('reaches SES through exactly the reopen and the read-back', () => {
    const { deps } = buildTestReopenRoot({ store: createFixtureTableState(), now: () => 0 });

    expect(Object.keys(deps.ports.ses).sort()).toEqual(['getConfigurationSetSending', 'reopenConfigurationSet']);
  });
});

async function refusedWithNoSesCall(lane: ClosedLane, payload: unknown): Promise<ReopenReport> {
  const { deps } = lane.reopenRoot();
  const callsBefore = lane.sesState.calls.length;
  const report = await reopenFromPayload(payload, deps);
  expect(lane.sesState.calls.slice(callsBefore)).toEqual([]);
  expect(report.result).toBe('refused');
  return report;
}

describe('the reopen command refuses every set Fothering did not pause, with no SES call (AC-15)', () => {
  it('refuses a set with no pause pointer as no-fothering-pause', async () => {
    const store = createFixtureTableState();
    const sesState = createFixtureSesState();
    const lines: string[] = [];
    const { deps } = buildTestReopenRoot({ store, sesState, now: () => 0, logSink: (line) => lines.push(line) });

    const report = await reopenFromPayload(BULK_PAYLOAD, deps);

    expect(report).toMatchObject({ result: 'refused', reason: 'no-fothering-pause', configurationSet: BULK });
    expect(sesState.calls).toEqual([]);
    expect(loggedEvents(lines, 'reopen-refused')).toEqual([{ event: 'reopen-refused', level: 'info', configurationSet: BULK, reason: 'no-fothering-pause' }]);
  });

  it('refuses a set paused outside Fothering, which has no pointer, as no-fothering-pause', async () => {
    const sesState = createFixtureSesState();
    sesState.sendingEnabled.set(BULK, false);
    const { deps } = buildTestReopenRoot({ store: createFixtureTableState(), sesState, now: () => 0 });

    expect(await reopenFromPayload(BULK_PAYLOAD, deps)).toMatchObject({ result: 'refused', reason: 'no-fothering-pause' });
    expect(sesState.calls).toEqual([]);
    expect(sesState.sendingEnabled.get(BULK)).toBe(false);
  });

  it.each(['refused', 'dry-run', 'pause-failed'] as const)('refuses a closure whose pause outcome is %s as not-reopenable', async (outcome) => {
    const lane = await closedLane();
    await rewriteClosure(lane.reopenRoot().deps, lane.incidentId, { outcome }, lane.reopenAtMs);

    expect((await refusedWithNoSesCall(lane, BULK_PAYLOAD)).reason).toBe('not-reopenable');
  });

  it('refuses the operator-alert set as operator-alert, and a set outside the lane map as not-in-lane-map', async () => {
    const lane = await closedLane();

    expect((await refusedWithNoSesCall(lane, { configurationSet: ALERTS })).reason).toBe('operator-alert');
    expect((await refusedWithNoSesCall(lane, { configurationSet: 'fothering-unlisted' })).reason).toBe('not-in-lane-map');
  });

  it('refuses a second reopen of a reopened closure as already-reopened (AC-E21)', async () => {
    const lane = await closedLane();
    expect((await reopenFromPayload(BULK_PAYLOAD, lane.reopenRoot().deps)).result).toBe('reopened');

    const report = await refusedWithNoSesCall(lane, BULK_PAYLOAD);

    expect(report.reason).toBe('already-reopened');
    expect((await storedClosure(lane.reopenRoot().deps, lane.incidentId, lane.reopenAtMs))?.reopen?.attempts).toBe(1);
  });

  it.each([
    ['an empty payload', {}],
    ['an extra field', { configurationSet: BULK, extra: 1 }],
    ['a non-string value', { configurationSet: 7 }],
    ['two set names in one string', { configurationSet: `${BULK} ${ALERTS}` }],
    ['two set names in a list', { configurationSet: [BULK, ALERTS] }],
  ])('throws the usage error for %s and logs payload-invalid', async (_name, payload) => {
    const lane = await closedLane();
    const { deps } = lane.reopenRoot();
    const callsBefore = lane.sesState.calls.length;

    const thrown = await reopenFromPayload(payload, deps).catch((error: unknown) => error);

    expect(thrown).toBeInstanceOf(ReopenUsageError);
    expect((thrown as Error).message).toBe(REOPEN_USAGE);
    expect(lane.sesState.calls.slice(callsBefore)).toEqual([]);
    expect(loggedEvents(lane.lines, 'reopen-refused')).toEqual([{ event: 'reopen-refused', level: 'info', reason: 'payload-invalid' }]);
  });
});

describe('the reopen counts against the pause lane-hour cap (D-98)', () => {
  it('refuses a fifth attempt in the hour as lane-cap-reached, naming the hour end, with no SES call and the reopen record unchanged (AC-E19)', async () => {
    const lane = await closedLane();
    const { deps } = lane.reopenRoot();
    // The pause at T took the hour's first attempt; three more fill it.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect((await reserveLaneAttempt(deps.ports.decisionStore, { configurationSet: BULK, nowMs: lane.reopenAtMs })).outcome).toBe('reserved');
    }
    expect(await laneHourItem(deps, lane.reopenAtMs)).toMatchObject({ attempts: 4 });

    const report = await refusedWithNoSesCall(lane, BULK_PAYLOAD);

    expect(report).toMatchObject({ reason: 'lane-cap-reached', capHourEndsAt: '2026-10-11T13:00:00.000Z' });
    expect(Date.parse(report.capHourEndsAt ?? '')).toBe(Date.parse(new Date(lane.reopenAtMs).toISOString().slice(0, 13) + ':00:00.000Z') + 3_600_000);
    expect((await storedClosure(deps, lane.incidentId, lane.reopenAtMs))?.reopen).toBeNull();
    expect(await laneHourItem(deps, lane.reopenAtMs)).toMatchObject({ attempts: 4 });
  });

  it('accepts a rerun after reopen-failed, makes one more put and records attempts 2 (D-93)', async () => {
    const lane = await closedLane();
    lane.sesState.getAnswers.set(BULK, false);
    expect((await reopenFromPayload(BULK_PAYLOAD, lane.reopenRoot().deps)).result).toBe('reopen-failed');
    lane.sesState.getAnswers.delete(BULK);
    const rerunAtMs = lane.reopenAtMs + 60_000;

    const report = await reopenFromPayload(BULK_PAYLOAD, lane.reopenRoot(rerunAtMs).deps);

    expect(report.result).toBe('reopened');
    expect(putsOf(lane.sesState)).toEqual(['put-issued:fothering-bulk:false', 'put-issued:fothering-bulk:true', 'put-issued:fothering-bulk:true']);
    const closure = await storedClosure(lane.reopenRoot().deps, lane.incidentId, rerunAtMs);
    expect(closure).toMatchObject({ outcome: 'closed', reopen: { attempts: 2, outcome: 'reopened', claimedAtMs: rerunAtMs } });
    expect(await laneHourItem(lane.reopenRoot().deps, rerunAtMs)).toMatchObject({ attempts: 3 });
  });
});

const tableKeyOf = (key: { pk: string; sk: string }): string => `${key.pk}${String.fromCharCode(0)}${key.sk}`;
const nextTurn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

// Each planted write yields first, as the fixture's own writes do with the option set, then writes
// whatever version it was given was stored.
function withUnconditionalUpdates(deps: ReopenDeps, store: FixtureTableState): ReopenDeps {
  const real = deps.ports.decisionStore;
  const decisionStore: DecisionStorePort = {
    putIfAbsent: (item, nowMs) => real.putIfAbsent(item, nowMs),
    getItem: (key, nowMs) => real.getItem(key, nowMs),
    updateIfVersion: async (key, expectedVersion, attributes) => {
      await nextTurn();
      const stored = store.items.get(tableKeyOf(key)) as DecisionStoreItem;
      store.items.set(tableKeyOf(key), { ...stored, ...structuredClone(attributes), version: expectedVersion + 1 });
      return 'updated';
    },
    reserveInvocation: (request) => real.reserveInvocation(request),
    recordUsage: (usage) => real.recordUsage(usage),
    reserveLaneAttempt: (request) => real.reserveLaneAttempt(request),
  };
  return { ...deps, ports: { ...deps.ports, decisionStore } };
}

async function twoReopensTogether(lane: ClosedLane, wrap: (deps: ReopenDeps) => ReopenDeps): Promise<ReopenReport[]> {
  const roots = [0, 1].map(() => wrap(buildTestReopenRoot({ store: lane.store, sesState: lane.sesState, now: () => lane.reopenAtMs, yieldBetweenOperations: true }).deps));
  return Promise.all(roots.map((deps) => reopenFromPayload(BULK_PAYLOAD, deps)));
}

describe('two reopen commands run together make one reopen (AC-E22)', () => {
  it('makes one put and records one reopen; the other command reads reopen-in-progress', async () => {
    const lane = await closedLane();

    const reports = await twoReopensTogether(lane, (deps) => deps);

    expect(reports.map((report) => report.result).sort()).toEqual(['refused', 'reopened']);
    expect(reports.find((report) => report.result === 'refused')?.reason).toBe('reopen-in-progress');
    expect(putsOf(lane.sesState)).toEqual(['put-issued:fothering-bulk:false', 'put-issued:fothering-bulk:true']);
    expect((await storedClosure(lane.reopenRoot().deps, lane.incidentId, lane.reopenAtMs))?.reopen).toMatchObject({ attempts: 1, outcome: 'reopened' });
  });

  // Control for the case above: the two roots do interleave, so a store whose versioned updates skip
  // their condition lets both claim and both reach the put.
  it('is shown red by a planted store whose versioned updates skip their condition', async () => {
    const lane = await closedLane();

    await twoReopensTogether(lane, (deps) => withUnconditionalUpdates(deps, lane.store));

    expect(putsOf(lane.sesState).filter((call) => call.endsWith(':true'))).toHaveLength(2);
  });
});

describe('a reopen before the hold check, and the switch unset', () => {
  it('keeps a paused closure paused after a reopen, and the next run past the hold check logs hold-check-skipped (D-94)', async () => {
    const lane = await closedLane('paused');
    const reopenAtMs = lane.pausedAtMs + 100_000;

    expect((await reopenFromPayload(BULK_PAYLOAD, lane.reopenRoot(reopenAtMs).deps)).result).toBe('reopened');
    const actionLines: string[] = [];
    await runActionCycle(buildTestActionRoot({ store: lane.store, sesState: lane.sesState, now: () => HOLD_CHECKED_AT_MS, logSink: (line) => actionLines.push(line) }).deps);

    const closure = await storedClosure(lane.reopenRoot().deps, lane.incidentId, HOLD_CHECKED_AT_MS);
    expect(closure).toMatchObject({ outcome: 'paused', holdCheckedAtMs: null, reopen: { outcome: 'reopened' } });
    expect(loggedEvents(actionLines, 'hold-check-skipped')).toEqual([{ event: 'hold-check-skipped', level: 'info', incidentId: lane.incidentId }]);
    expect(loggedEvents(actionLines, 'hold-check')).toEqual([]);
  });

  it('resolves to the dry-run recorder when deployed with the switch unset: one would-reopen line, no claim, no reservation, no read-back (D-117)', async () => {
    const lane = await closedLane();
    const { deps } = lane.reopenRoot();
    const dryRunLines: string[] = [];
    const deployed = buildReopenRoot({ runtimeContext: 'deployed', switchValue: undefined, dryRunSink: (line) => dryRunLines.push(line) });
    expect(deployed.kinds.ses?.reopenConfigurationSet).toBe('dry-run');
    const dryRun: ReopenDeps = {
      ...deps,
      ports: { ...deps.ports, ses: { ...deps.ports.ses, reopenConfigurationSet: deployed.ports.ses.reopenConfigurationSet } },
      kinds: { ...deps.kinds, ses: deployed.kinds.ses ?? {} },
    };
    const callsBefore = lane.sesState.calls.length;

    const report = await reopenFromPayload(BULK_PAYLOAD, dryRun);

    expect(report).toEqual({ result: 'dry-run', configurationSet: BULK, note: reputationResetSentence(BULK), limit: incidentLimitSentence(BULK) });
    expect(dryRunLines).toEqual(['(dry-run) WOULD ses.reopenConfigurationSet fothering-bulk {"configurationSet":"fothering-bulk"}']);
    expect(lane.sesState.calls.slice(callsBefore)).toEqual([]);
    expect((await storedClosure(deps, lane.incidentId, lane.reopenAtMs))?.reopen).toBeNull();
    expect(await laneHourItem(deps, lane.reopenAtMs)).toMatchObject({ attempts: 1 });
  });
});

const RECIPIENT_HMAC = /"recipientHmac":"([^"]+)"/g;

interface Observed {
  outputs: string[];
  closures: Closure[];
  lines: string[];
  hmacs: Set<string>;
}

async function observe(lane: ClosedLane, observed: Observed, run: () => Promise<unknown>): Promise<void> {
  for (const item of lane.store.items.values()) {
    for (const match of JSON.stringify(item).matchAll(RECIPIENT_HMAC)) if (match[1] !== undefined) observed.hmacs.add(match[1]);
  }
  const output = await run().catch((error: unknown) => (error instanceof Error ? error.message : String(error)));
  observed.outputs.push(JSON.stringify(output));
  for (const item of lane.store.items.values()) {
    const closure = parseClosure(item);
    if (closure !== undefined) observed.closures.push(closure);
  }
  observed.lines.push(...lane.lines);
}

describe('no reopen output, closure or log line says closed outside a hold-checked outcome or names a recipient', () => {
  it('holds no closed word, no @ and no recipient hash across every kind of reopen run (AC-6 and AC-P9, reopen half)', async () => {
    const observed: Observed = { outputs: [], closures: [], lines: [], hmacs: new Set() };
    const runs: Array<(lane: ClosedLane) => Promise<unknown>> = [
      (lane) => reopenFromPayload(BULK_PAYLOAD, lane.reopenRoot().deps),
      (lane) => {
        lane.sesState.getAnswers.set(BULK, false);
        return reopenFromPayload(BULK_PAYLOAD, lane.reopenRoot().deps);
      },
      (lane) => {
        lane.sesState.putFaults.set(BULK, 'throw');
        return reopenFromPayload(BULK_PAYLOAD, lane.reopenRoot().deps);
      },
      (lane) => reopenFromPayload({ configurationSet: ALERTS }, lane.reopenRoot().deps),
      (lane) => reopenFromPayload({ configurationSet: BULK, extra: 'someone@example.org' }, lane.reopenRoot().deps),
    ];
    for (const run of runs) {
      const lane = await closedLane();
      await observe(lane, observed, () => run(lane));
    }

    expect(observed.hmacs.size).toBeGreaterThan(0);
    expect(observed.lines.length).toBeGreaterThanOrEqual(runs.length);
    expect(closedWordViolations({ closures: observed.closures, logLines: [...observed.lines, ...observed.outputs] })).toEqual([]);
    for (const text of [...observed.outputs, ...observed.lines, ...observed.closures.map((closure) => JSON.stringify(closure))]) {
      expect(text).not.toContain('@');
      for (const hmac of observed.hmacs) expect(text).not.toContain(hmac);
    }
  });
});
