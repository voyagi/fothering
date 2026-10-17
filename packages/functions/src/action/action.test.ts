import { describe, expect, it } from 'vitest';
import { HOLD_MS } from '@fothering/core/close-values';
import { createFixtureTableState } from '@fothering/providers/fixtures/ingest-ports';
import type { DecisionStorePort } from '@fothering/providers/port-types';
import { SES_READ_SPACING_MS } from '@fothering/providers/ses-facts';
import { BAD_BATCH, BULK, NOW_MS, buildTestActionRoot, closeRuntime, incidentIdOf, seedIncidents, storedClosure } from '../test/close-scenario.js';
import { runActionCycle } from './action.js';
import type { ActionDeps } from './root.js';

const ACT_MS = NOW_MS + 60_000;
const INCIDENT_ID = incidentIdOf(BULK, NOW_MS);

// A deps copy that writes each wait and each outcome write into the fixture SES's own call log, so one
// list shows the order of the spacing, the put, the read-back and the write. The write is logged when
// it is issued, so a write issued before the read-back resolved shows up before it.
function orderRecorded(deps: ActionDeps, calls: string[]): ActionDeps {
  const store = deps.ports.decisionStore;
  const decisionStore: DecisionStorePort = {
    putIfAbsent: (item, nowMs) => store.putIfAbsent(item, nowMs),
    getItem: (key, nowMs) => store.getItem(key, nowMs),
    updateIfVersion: (key, expectedVersion, attributes, nowMs, expected) => {
      if (typeof attributes.outcome === 'string') calls.push(`write:${attributes.outcome}`);
      return store.updateIfVersion(key, expectedVersion, attributes, nowMs, expected);
    },
    reserveInvocation: (request) => store.reserveInvocation(request),
    recordUsage: (usage) => store.recordUsage(usage),
  };
  const wait = async (ms: number): Promise<void> => {
    calls.push(`wait:${ms}`);
    await deps.wait(ms);
  };
  return { ...deps, wait, ports: { ...deps.ports, decisionStore } };
}

describe('a stored close becomes one pause, reported only after the read-back (R1)', () => {
  it('pauses fothering-bulk once and writes paused only after the read-back reads false (AC-1)', async () => {
    const store = createFixtureTableState();
    await seedIncidents({ store, runtime: closeRuntime, scenarios: [BAD_BATCH], nowMs: NOW_MS });
    const { deps, sesState } = buildTestActionRoot({ store, now: () => ACT_MS });

    await runActionCycle(orderRecorded(deps, sesState.calls));

    const closure = await storedClosure(deps, INCIDENT_ID, ACT_MS);
    expect(closure?.outcome).toBe('paused');
    expect(closure).toMatchObject({ readBack: false, decisionOutcome: 'close', configurationSet: BULK, pauseRequestedAtMs: ACT_MS });
    expect(closure?.holdEndMs).toBe(ACT_MS + HOLD_MS);
    expect(sesState.calls.filter((call) => call.startsWith('put-issued'))).toEqual(['put-issued:fothering-bulk:false']);
    const fromPut = sesState.calls.indexOf('put-issued:fothering-bulk:false');
    expect(sesState.calls.slice(fromPut - 1)).toEqual([
      `wait:${SES_READ_SPACING_MS}`,
      'put-issued:fothering-bulk:false',
      'put-resolved:fothering-bulk:false',
      `wait:${SES_READ_SPACING_MS}`,
      'get-issued:fothering-bulk',
      'get-resolved:fothering-bulk',
      'write:paused',
    ]);
  });
});
