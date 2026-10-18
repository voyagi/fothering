import { describe, expect, it } from 'vitest';
import { counterLaneHourKey } from '@fothering/core/evidence-record';
import { incidentLimitSentence, reputationResetSentence } from '@fothering/core/reopen';
import { createFixtureTableState } from '@fothering/providers/fixtures/ingest-ports';
import { createFixtureSesState } from '@fothering/providers/fixtures/later-ports';
import type { FixtureSesState } from '@fothering/providers/port-types';
import { SES_READ_SPACING_MS } from '@fothering/providers/ses-facts';
import { BULK, buildTestReopenRoot, seedClosedLane, storedClosure, type TestReopenRoot } from '../test/close-scenario.js';
import { reopenFromPayload } from './handler.js';
import type { ReopenDeps } from './root.js';

const BULK_PAYLOAD = { configurationSet: BULK };

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
  incidentId: string;
  reopenAtMs: number;
  sesState: FixtureSesState;
  reopenRoot: (nowMs?: number) => TestReopenRoot;
}

async function closedLane(): Promise<ClosedLane> {
  const store = createFixtureTableState();
  const sesState = createFixtureSesState();
  const { incidentId, pausedAtMs } = await seedClosedLane({ store, sesState });
  const reopenAtMs = pausedAtMs + 400_000;
  return { incidentId, reopenAtMs, sesState, reopenRoot: (nowMs = reopenAtMs) => buildTestReopenRoot({ store, sesState, now: () => nowMs }) };
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
