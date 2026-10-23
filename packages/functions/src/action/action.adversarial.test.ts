import { describe, expect, it } from 'vitest';
import { BUCKET_MS } from '@fothering/core/buckets';
import { EMAIL_SEND_ATTEMPTS, HOLD_MS } from '@fothering/core/close-values';
import { closureKey } from '@fothering/core/closure';
import { createFixtureTableState } from '@fothering/providers/fixtures/ingest-ports';
import { createFixtureSesState } from '@fothering/providers/fixtures/later-ports';
import type { FixtureSesState } from '@fothering/providers/port-types';
import {
  BAD_BATCH,
  BULK,
  HOLD_CHECKED_AT_MS,
  NOW_MS,
  OPERATOR,
  PAUSED_AT_MS,
  TRANSACTIONAL,
  buildTestActionRoot,
  closeRuntime,
  incidentIdOf,
  plantIncident,
  seedClosedLane,
  seedIncidents,
  sendRecordAt,
  storedClosure,
} from '../test/close-scenario.js';
import { runActionCycle } from './action.js';

// Stored items no Fothering writer produces, driven through the scheduled run itself: each case pins
// what the run writes, so a guard that holds in its unit but not on the real path still fails here.

const INCIDENT_ID = incidentIdOf(BULK, NOW_MS);
const OTHER_INCIDENT_ID = incidentIdOf(TRANSACTIONAL, NOW_MS);
const AFTER_HOLD_MS = PAUSED_AT_MS + HOLD_MS + 1_000;

function mutationsOf(state: FixtureSesState): string[] {
  return state.calls.filter((call) => call.startsWith('put-') || call.startsWith('send-'));
}

async function pausedLane(): Promise<ReturnType<typeof buildTestActionRoot>> {
  const store = createFixtureTableState();
  const sesState = createFixtureSesState();
  await seedClosedLane({ store, sesState, through: 'paused' });
  return buildTestActionRoot({ store, sesState, now: () => HOLD_CHECKED_AT_MS });
}

describe('the hold check over a stored Send item whose mail time cannot be read', () => {
  it('writes not-holding, never closed, for such an item after the hold end', async () => {
    const { deps } = await pausedLane();
    const send = { ...sendRecordAt(BULK, AFTER_HOLD_MS, 'bulk-sender-after-hold'), mailTimestampMs: AFTER_HOLD_MS + 0.5 };
    expect(await deps.ports.eventStore.putIfAbsent(send)).toBe('written');

    await runActionCycle(deps);

    expect(await storedClosure(deps, INCIDENT_ID, HOLD_CHECKED_AT_MS)).toMatchObject({ outcome: 'not-holding', sendsAfterHold: 1 });
  });

  it('writes closed when no Send item follows the hold end, as a control', async () => {
    const { deps } = await pausedLane();

    await runActionCycle(deps);

    expect(await storedClosure(deps, INCIDENT_ID, HOLD_CHECKED_AT_MS)).toMatchObject({ outcome: 'closed', sendsAfterHold: 0 });
  });
});

describe('an operator email at its attempt limit that holds no claim', () => {
  it('is marked failed with the error line the alarm reads, and nothing is sent', async () => {
    const store = createFixtureTableState();
    const sesState = createFixtureSesState();
    await seedClosedLane({ store, sesState, through: 'closed' });
    const lines: string[] = [];
    const { deps } = buildTestActionRoot({ store, sesState, now: () => HOLD_CHECKED_AT_MS + 60_000, operator: OPERATOR, logSink: (line) => lines.push(line) });
    const closure = await storedClosure(deps, INCIDENT_ID, HOLD_CHECKED_AT_MS);
    expect(closure).toMatchObject({ outcome: 'closed', email: null });
    const stranded = { kind: 'closed', attempts: EMAIL_SEND_ATTEMPTS, claimedAtMs: null, sentAtMs: null, messageId: null, failed: false };
    const version = closure?.version ?? -1;
    expect(await deps.ports.decisionStore.updateIfVersion(closureKey(INCIDENT_ID), version, { email: stranded }, HOLD_CHECKED_AT_MS)).toBe('updated');
    const sendsBefore = mutationsOf(sesState).length;

    await runActionCycle(deps);

    expect((await storedClosure(deps, INCIDENT_ID, HOLD_CHECKED_AT_MS + 60_000))?.email).toMatchObject({ failed: true, sentAtMs: null });
    expect(lines.filter((line) => line.includes('"event":"email-failed"') && line.includes('"errorName":"AttemptsSpent"'))).toHaveLength(1);
    expect(mutationsOf(sesState).length).toBe(sendsBefore);
  });
});

describe('another open lane whose STATE stores an opening window end out of range', () => {
  async function actOverOtherLane(openingToBucketMs: number): Promise<{ outcome: unknown; reason: unknown; mutations: string[] }> {
    const store = createFixtureTableState();
    await seedIncidents({ store, runtime: closeRuntime, scenarios: [BAD_BATCH], nowMs: NOW_MS });
    const { deps, sesState } = buildTestActionRoot({ store, now: () => PAUSED_AT_MS });
    const openingWindow = { fromBucketMs: openingToBucketMs - BUCKET_MS, toBucketMs: openingToBucketMs };
    await plantIncident(deps, { configurationSet: TRANSACTIONAL, incidentId: OTHER_INCIDENT_ID, openingWindow, nowMs: NOW_MS });

    await runActionCycle(deps);

    const closure = await storedClosure(deps, INCIDENT_ID, PAUSED_AT_MS);
    return { outcome: closure?.outcome, reason: closure?.reason, mutations: mutationsOf(sesState) };
  }

  it('refuses the close as newer-incident-elsewhere for a negative end, with no SES mutation', async () => {
    const result = await actOverOtherLane(-BUCKET_MS);
    expect(result).toMatchObject({ outcome: 'refused', reason: 'newer-incident-elsewhere' });
    expect(result.mutations).toEqual([]);
  });

  it('pauses over an older end in range, as a control', async () => {
    const result = await actOverOtherLane(BUCKET_MS);
    expect(result.outcome).toBe('paused');
  });
});
