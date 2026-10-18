import { afterEach, describe, expect, it, vi } from 'vitest';
import { BUCKET_MS, bucketStartMs } from '@fothering/core/buckets';
import { ACTION_FUNCTION_TIMEOUT_MS, HOLD_CHECK_DELAY_MS, HOLD_MS } from '@fothering/core/close-values';
import { closureClaimItem, closureKey, parseClosure, type Closure } from '@fothering/core/closure';
import { buildEvidenceRecord, incidentLaneKey, incidentPauseKey, type EvidenceRecord, type EvidenceRecordInput } from '@fothering/core/evidence-record';
import { spikeWindowFor, type BucketWindow, type LaneFold } from '@fothering/core/window-fold';
import { createFixtureTableState } from '@fothering/providers/fixtures/ingest-ports';
import type { DecisionStoreItem, DecisionStorePort, EventStorePort, FixtureSesState, FixtureTableState, Recording } from '@fothering/providers/port-types';
import { MAX_IDENTITY_READS, SES_READ_SPACING_MS } from '@fothering/providers/ses-facts';
import { assertRootMatrix } from '@fothering/providers/test/root-matrix';
import {
  BAD_BATCH,
  BULK,
  COMPLETE_SES_RECORDINGS,
  LANES,
  NOW_MS,
  RECEIPT_BATCH,
  TRANSACTIONAL,
  buildTestActionRoot,
  closeRuntime,
  closeState,
  closedWordViolations,
  decidingRuntime,
  incidentIdOf,
  moveMarker,
  plantClosure,
  plantDecision,
  plantIncident,
  seedIncidents,
  sendRecordAt,
  storedClosure,
  storedRecord,
  type TestActionRootInput,
} from '../test/close-scenario.js';
import { runActionCycle } from './action.js';
import { buildActionRoot, type ActionDeps } from './root.js';

const ACT_MS = NOW_MS + 60_000;
const INCIDENT_ID = incidentIdOf(BULK, NOW_MS);
const RECEIPT_INCIDENT_ID = incidentIdOf(TRANSACTIONAL, NOW_MS);
const PAUSE_LINE = '(dry-run) WOULD ses.pauseConfigurationSet fothering-bulk {"configurationSet":"fothering-bulk"}';

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

const failingRuntime = async (): Promise<unknown> => {
  throw new Error('the fake runtime fails every invocation');
};

interface Scenario {
  store: FixtureTableState;
  root: (input?: Partial<TestActionRootInput>) => ReturnType<typeof buildTestActionRoot>;
}

async function seeded(runtime = closeRuntime, scenarios = [BAD_BATCH], options: { agentDryRun?: boolean } = {}): Promise<Scenario> {
  const store = createFixtureTableState();
  await seedIncidents({ store, runtime, scenarios, nowMs: NOW_MS, ...options });
  return { store, root: (input = {}) => buildTestActionRoot({ store, now: () => ACT_MS, ...input }) };
}

function putsOf(state: FixtureSesState): string[] {
  return state.calls.filter((call) => call.startsWith('put-issued'));
}

function at(deps: ActionDeps, nowMs: number): ActionDeps {
  return { ...deps, now: () => nowMs };
}

// The order AC-1 requires, pair by pair: a later entry present with its predecessor absent or after it
// is a violation, so a paused write issued before the read-back resolved is always reported.
const PAUSE_ORDER = ['put-issued:fothering-bulk:false', 'put-resolved:fothering-bulk:false', 'get-issued:fothering-bulk', 'get-resolved:fothering-bulk', 'write:paused'];

function orderViolations(calls: readonly string[]): string[] {
  const violations: string[] = [];
  for (let index = 1; index < PAUSE_ORDER.length; index += 1) {
    const before = PAUSE_ORDER[index - 1] ?? '';
    const after = PAUSE_ORDER[index] ?? '';
    const beforeAt = calls.indexOf(before);
    const afterAt = calls.indexOf(after);
    if (afterAt !== -1 && (beforeAt === -1 || beforeAt > afterAt)) violations.push(`${after} without ${before} before it`);
  }
  return violations;
}

describe('every way the put or the read-back can end is failure or unknown, never success (AC-2, AC-E1)', () => {
  it.each([
    ['a read-back answering true after an accepted put', 'pause-failed', true, true],
    ['a read-back that throws', 'pause-unknown', 'throw', 'threw'],
    ['a read-back holding no SendingEnabled', 'pause-unknown', 'missing', 'missing'],
  ] as const)('records %s as %s', async (_case, outcome, answer, readBack) => {
    const { root } = await seeded();
    const { deps, sesState } = root();
    sesState.getAnswers.set(BULK, answer);

    await runActionCycle(orderRecorded(deps, sesState.calls));

    const closure = await storedClosure(deps, INCIDENT_ID, ACT_MS);
    expect(closure?.outcome).toBe(outcome);
    expect(closure).toMatchObject({ readBack, holdEndMs: null });
    expect(putsOf(sesState)).toEqual(['put-issued:fothering-bulk:false']);
    expect(sesState.calls).not.toContain('write:paused');
  });

  it('keeps the put state and the read-back apart, so an accepted put can read back as sending (AC-3)', async () => {
    const { root } = await seeded();
    const { deps, sesState } = root();
    sesState.getAnswers.set(BULK, true);

    await runActionCycle(deps);

    expect(sesState.sendingEnabled.get(BULK)).toBe(false);
    expect((await storedClosure(deps, INCIDENT_ID, ACT_MS))?.readBack).toBe(true);
  });

  it('records a put that throws as pause-failed with no read-back issued', async () => {
    const { root } = await seeded();
    const { deps, sesState } = root();
    sesState.putFaults.set(BULK, 'throw');

    await runActionCycle(orderRecorded(deps, sesState.calls));

    const closure = await storedClosure(deps, INCIDENT_ID, ACT_MS);
    expect(closure?.outcome).toBe('pause-failed');
    expect(closure?.readBack).toBeNull();
    expect(sesState.calls.filter((call) => call.startsWith('get-issued'))).toEqual([]);
    expect(sesState.calls).not.toContain('write:paused');
  });

  it('reports a planted log that writes paused on the put resolving, and nothing over the real run', async () => {
    const { root } = await seeded();
    const { deps, sesState } = root();
    await runActionCycle(orderRecorded(deps, sesState.calls));

    expect(orderViolations(sesState.calls)).toEqual([]);
    const planted = ['put-issued:fothering-bulk:false', 'put-resolved:fothering-bulk:false', 'write:paused', 'get-issued:fothering-bulk'];
    expect(orderViolations(planted)).toEqual(['write:paused without get-resolved:fothering-bulk before it']);
  });

  it.each([
    ['pause-failed', (state: FixtureSesState) => state.putFaults.set(BULK, 'throw')],
    ['pause-unknown', (state: FixtureSesState) => state.getAnswers.set(BULK, 'throw')],
  ] as const)('makes no second put for an incident whose closure ended %s (AC-E2)', async (outcome, script) => {
    const { root } = await seeded();
    const { deps, sesState } = root();
    script(sesState);
    await runActionCycle(deps);
    const laterMs = ACT_MS + ACTION_FUNCTION_TIMEOUT_MS + 60_000;
    await runActionCycle(at(deps, laterMs));

    expect((await storedClosure(deps, INCIDENT_ID, laterMs))?.outcome).toBe(outcome);
    expect(putsOf(sesState)).toHaveLength(1);
  });
});

describe('a claim another run left behind is taken over, finished or left alone by its age (D-91)', () => {
  const staleClaimMs = ACT_MS - ACTION_FUNCTION_TIMEOUT_MS;

  it('claims a stale claim with no pause requested again and pauses once', async () => {
    const { root } = await seeded();
    const { deps, sesState } = root();
    await plantClosure(deps, closureClaimItem({ incidentId: INCIDENT_ID, configurationSet: BULK, decisionOutcome: 'close', nowMs: staleClaimMs }), staleClaimMs);

    await runActionCycle(deps);

    expect(await storedClosure(deps, INCIDENT_ID, ACT_MS)).toMatchObject({ outcome: 'paused', claimedAtMs: ACT_MS });
    expect(putsOf(sesState)).toHaveLength(1);
  });

  it('ends a stale claim whose pause was requested as pause-unknown with no put', async () => {
    const { root } = await seeded();
    const { deps, sesState } = root();
    const claim = closureClaimItem({ incidentId: INCIDENT_ID, configurationSet: BULK, decisionOutcome: 'close', nowMs: staleClaimMs });
    await plantClosure(deps, { ...claim, pauseRequestedAtMs: staleClaimMs + 2_000 }, staleClaimMs);

    await runActionCycle(deps);

    expect(await storedClosure(deps, INCIDENT_ID, ACT_MS)).toMatchObject({ outcome: 'pause-unknown', readBack: null });
    expect(sesState.calls).toEqual([]);
  });

  it('leaves a claim younger than the timeout alone with no SES call at all', async () => {
    const { root } = await seeded();
    const { deps, sesState } = root({ recordings: [] });
    const claim = closureClaimItem({ incidentId: INCIDENT_ID, configurationSet: BULK, decisionOutcome: 'close', nowMs: ACT_MS - 1_000 });
    await plantClosure(deps, claim, ACT_MS - 1_000);

    const summary = await runActionCycle(deps);

    expect(await storedClosure(deps, INCIDENT_ID, ACT_MS)).toEqual(claim);
    expect(sesState.calls).toEqual([]);
    expect(summary.acted).toEqual([]);
  });
});

describe('a decision that is not a close pauses nothing (D-92)', () => {
  it('ends an agent unknown as refused no-close with no put', async () => {
    const { root } = await seeded(decidingRuntime, [RECEIPT_BATCH]);
    const { deps, sesState } = root();

    await runActionCycle(deps);

    expect(await storedClosure(deps, RECEIPT_INCIDENT_ID, ACT_MS)).toMatchObject({
      outcome: 'refused',
      reason: 'no-close',
      decisionOutcome: 'unknown',
      configurationSet: TRANSACTIONAL,
      sesFacts: 'read',
    });
    expect(putsOf(sesState)).toEqual([]);
  });

  it('ends a cap-reached DECISION the same way', async () => {
    const { root } = await seeded(failingRuntime);
    const { deps, sesState } = root();
    await plantDecision(deps, INCIDENT_ID, { outcome: 'unknown', reason: 'cap-reached', items: ['incident'] }, NOW_MS);

    await runActionCycle(deps);

    expect(await storedClosure(deps, INCIDENT_ID, ACT_MS)).toMatchObject({ outcome: 'refused', reason: 'no-close', decisionOutcome: 'unknown' });
    expect(putsOf(sesState)).toEqual([]);
  });

  it('writes no closure for an incident whose agent row resolved dry-run, which stored no DECISION', async () => {
    const { root } = await seeded(closeRuntime, [BAD_BATCH], { agentDryRun: true });
    const { deps, sesState } = root();

    const summary = await runActionCycle(deps);

    expect(await storedClosure(deps, INCIDENT_ID, ACT_MS)).toBeUndefined();
    expect(summary.acted).toEqual([]);
    expect(sesState.calls).toEqual([]);
  });
});

function withoutListIdentities(): Recording[] {
  return COMPLETE_SES_RECORDINGS.filter((recording) => recording.operation !== 'ses.listEmailIdentities');
}

function withIdentityCount(count: number): Recording[] {
  const identities = Array.from({ length: count }, (_, index) => `sender${index}.example.com`);
  return [{ operation: 'ses.listEmailIdentities', request: null, response: identities }, ...withoutListIdentities()];
}

function countingIdentityLists(deps: ActionDeps): { deps: ActionDeps; lists: { count: number } } {
  const lists = { count: 0 };
  const ses = deps.ports.ses;
  const counted = {
    ...ses,
    listEmailIdentities: () => {
      lists.count += 1;
      return ses.listEmailIdentities();
    },
  };
  return { deps: { ...deps, ports: { ...deps.ports, ses: counted } }, lists };
}

describe('the SES facts are read once per run and an unread set refuses the close (D-89 step 2)', () => {
  it('refuses an approved close as ses-facts-unavailable when a fact read throws', async () => {
    const { root } = await seeded();
    const { deps, sesState } = root({ recordings: withoutListIdentities() });

    await runActionCycle(deps);

    expect(await storedClosure(deps, INCIDENT_ID, ACT_MS)).toMatchObject({ outcome: 'refused', reason: 'ses-facts-unavailable', sesFacts: 'failed' });
    expect(putsOf(sesState)).toEqual([]);
  });

  it('refuses an approved close as ses-facts-bound past MAX_IDENTITY_READS identities', async () => {
    const { root } = await seeded();
    const { deps, sesState } = root({ recordings: withIdentityCount(MAX_IDENTITY_READS + 1) });

    await runActionCycle(deps);

    expect(await storedClosure(deps, INCIDENT_ID, ACT_MS)).toMatchObject({ outcome: 'refused', reason: 'ses-facts-bound', sesFacts: 'bound' });
    expect(putsOf(sesState)).toEqual([]);
  });

  it('ends an agent unknown with failing facts as no-close, recording the failed read', async () => {
    const { root } = await seeded(decidingRuntime, [RECEIPT_BATCH]);
    const { deps } = root({ recordings: withoutListIdentities() });

    await runActionCycle(deps);

    expect(await storedClosure(deps, RECEIPT_INCIDENT_ID, ACT_MS)).toMatchObject({ outcome: 'refused', reason: 'no-close', sesFacts: 'failed' });
  });

  it('reads the identity list once for two incidents acted on in one run', async () => {
    const { root } = await seeded(decidingRuntime, [BAD_BATCH, RECEIPT_BATCH]);
    const built = root();
    const { deps, lists } = countingIdentityLists(built.deps);

    const summary = await runActionCycle(deps);

    // Two lanes spiking together is not a spike confined to one lane, so both decide unknown: what
    // matters here is that both incidents were acted on.
    expect(summary.acted.map((acted) => acted.incidentId).sort()).toEqual([INCIDENT_ID, RECEIPT_INCIDENT_ID].sort());
    expect(lists.count).toBe(1);
  });
});

// The fixture table is the only place a stored record can be changed after the fact: an EVIDENCE item
// carries no version, so no port write can reach it, which is the property the gate relies on.
function tamperEvidenceHash(store: FixtureTableState, incidentId: string): void {
  const evidence = [...store.items.values()].find(
    (item): item is DecisionStoreItem => (item as DecisionStoreItem).pk === `INCIDENT#${incidentId}` && (item as DecisionStoreItem).sk === 'EVIDENCE',
  );
  if (evidence === undefined) throw new Error('no EVIDENCE item was seeded');
  (evidence.record as { hash: string }).hash = 'f'.repeat(64);
}

function withStore(deps: ActionDeps, overrides: Partial<DecisionStorePort>): ActionDeps {
  const store = deps.ports.decisionStore;
  const decisionStore: DecisionStorePort = {
    putIfAbsent: (item, nowMs) => store.putIfAbsent(item, nowMs),
    getItem: (key, nowMs) => store.getItem(key, nowMs),
    updateIfVersion: (key, expectedVersion, attributes, nowMs, expected) => store.updateIfVersion(key, expectedVersion, attributes, nowMs, expected),
    reserveInvocation: (request) => store.reserveInvocation(request),
    recordUsage: (usage) => store.recordUsage(usage),
    ...overrides,
  };
  return { ...deps, ports: { ...deps.ports, decisionStore } };
}

// The worklist reads the markers before the claim and the act reads them again after it, so a change
// detection makes in between is planted right after the claim is written.
function afterClaim(deps: ActionDeps, change: () => Promise<void>): ActionDeps {
  const store = deps.ports.decisionStore;
  return withStore(deps, {
    putIfAbsent: async (item, nowMs) => {
      const result = await store.putIfAbsent(item, nowMs);
      if (result === 'written' && item.sk === 'CLOSURE') await change();
      return result;
    },
  });
}

function markerReadThrowsAfterClaim(deps: ActionDeps, configurationSet: string): ActionDeps {
  const store = deps.ports.decisionStore;
  const { pk, sk } = incidentLaneKey(configurationSet);
  let claimed = false;
  return withStore(deps, {
    putIfAbsent: async (item, nowMs) => {
      const result = await store.putIfAbsent(item, nowMs);
      if (item.sk === 'CLOSURE') claimed = true;
      return result;
    },
    getItem: async (key, nowMs) => {
      if (claimed && key.pk === pk && key.sk === sk) throw new Error('the fixture table was scripted to fail this marker read');
      return store.getItem(key, nowMs);
    },
  });
}

function mutationsOf(state: FixtureSesState): string[] {
  return state.calls.filter((call) => call.startsWith('put-') || call.startsWith('send-'));
}

const LATER_MS = NOW_MS + BUCKET_MS;
const LATER_RECEIPT_INCIDENT_ID = incidentIdOf(TRANSACTIONAL, LATER_MS);

async function plantReceiptIncident(deps: ActionDeps, openingWindow: BucketWindow, incidentId = LATER_RECEIPT_INCIDENT_ID): Promise<void> {
  await plantIncident(deps, { configurationSet: TRANSACTIONAL, incidentId, openingWindow, nowMs: NOW_MS });
}

describe('a record that no longer describes the account pauses nothing (R3, AC-8)', () => {
  it('refuses a close made stale by a later incident on another lane, with no SES mutation (tracer)', async () => {
    const { root } = await seeded();
    const { deps, sesState } = root();
    await plantReceiptIncident(deps, spikeWindowFor(LATER_MS));
    expect(spikeWindowFor(LATER_MS).toBucketMs).toBe(bucketStartMs(NOW_MS) + BUCKET_MS);

    await runActionCycle(deps);

    const closure = await storedClosure(deps, INCIDENT_ID, ACT_MS);
    expect(closure?.reason).toBe('newer-incident-elsewhere');
    expect(closure?.outcome).toBe('refused');
    expect(mutationsOf(sesState)).toEqual([]);
  });

  it('refuses incident-not-open when the bulk marker moved to another incident after the claim', async () => {
    const { root } = await seeded();
    const { deps, sesState } = root();

    await runActionCycle(afterClaim(deps, () => moveMarker(deps, BULK, incidentIdOf(BULK, LATER_MS), ACT_MS)));

    expect(await storedClosure(deps, INCIDENT_ID, ACT_MS)).toMatchObject({ outcome: 'refused', reason: 'incident-not-open' });
    expect(mutationsOf(sesState)).toEqual([]);
  });

  it('refuses incident-not-open when the bulk STATE reads closed', async () => {
    const { root } = await seeded();
    const { deps, sesState } = root();
    await closeState(deps, INCIDENT_ID, NOW_MS);

    await runActionCycle(deps);

    expect(await storedClosure(deps, INCIDENT_ID, ACT_MS)).toMatchObject({ outcome: 'refused', reason: 'incident-not-open' });
    expect(mutationsOf(sesState)).toEqual([]);
  });

  it('refuses record-too-old one millisecond past one spike window after the record window', async () => {
    const { root } = await seeded();
    const { deps, sesState } = root();
    const oldMs = (await storedRecord(deps, INCIDENT_ID, NOW_MS)).window.toBucketMs + 3_600_001;

    await runActionCycle(at(deps, oldMs));

    expect(await storedClosure(deps, INCIDENT_ID, oldMs)).toMatchObject({ outcome: 'refused', reason: 'record-too-old' });
    expect(mutationsOf(sesState)).toEqual([]);
  });

  it('refuses newer-incident-elsewhere for another lane whose STATE opening window is not an integer (AC-E10)', async () => {
    const { root } = await seeded();
    const { deps, sesState } = root();
    await plantReceiptIncident(deps, { fromBucketMs: 1.5, toBucketMs: 1.5 });

    await runActionCycle(deps);

    expect(await storedClosure(deps, INCIDENT_ID, ACT_MS)).toMatchObject({ outcome: 'refused', reason: 'newer-incident-elsewhere' });
    expect(mutationsOf(sesState)).toEqual([]);
  });

  it('refuses newer-incident-elsewhere when another lane marker read throws (AC-E10)', async () => {
    const { root } = await seeded();
    const { deps, sesState } = root();

    await runActionCycle(markerReadThrowsAfterClaim(deps, TRANSACTIONAL));

    expect(await storedClosure(deps, INCIDENT_ID, ACT_MS)).toMatchObject({ outcome: 'refused', reason: 'newer-incident-elsewhere' });
    expect(mutationsOf(sesState)).toEqual([]);
  });

  it('pauses when another lane incident opened in the same cycle as the record (AC-E11)', async () => {
    const { root } = await seeded();
    const { deps, sesState } = root();
    const record = await storedRecord(deps, INCIDENT_ID, NOW_MS);
    await plantReceiptIncident(deps, record.window, RECEIPT_INCIDENT_ID);

    await runActionCycle(deps);

    expect((await storedClosure(deps, INCIDENT_ID, ACT_MS))?.outcome).toBe('paused');
    expect(putsOf(sesState)).toEqual(['put-issued:fothering-bulk:false']);
  });
});

const ALERTS = 'fothering-alerts';

// The lane block the committed lanes.json gives over the complete SES facts, in lane-map order.
const LANE_BLOCK = [
  { configurationSet: TRANSACTIONAL, state: 'no-open-incident', configurationRefusals: ['transactional'] },
  { configurationSet: BULK, state: 'incident-open', configurationRefusals: [] },
  { configurationSet: ALERTS, state: 'no-open-incident', configurationRefusals: ['operator-alert', 'transactional'] },
];

function withRecording(operation: string, request: unknown, response: unknown): Recording[] {
  return COMPLETE_SES_RECORDINGS.map((recording) =>
    recording.operation === operation && recording.request === request ? { ...recording, response } : recording,
  );
}

function bulkDestinationWithout(eventType: string): Recording[] {
  const destination = { name: 'to-eventbridge', enabled: true, eventBridge: true, matchingEventTypes: ['SEND', 'REJECT', 'BOUNCE', 'COMPLAINT', 'DELIVERY', 'DELIVERY_DELAY'] };
  return withRecording('ses.getConfigurationSetEventDestinations', BULK, [
    { ...destination, matchingEventTypes: destination.matchingEventTypes.filter((type) => type !== eventType) },
  ]);
}

function laneOf(closure: Closure | undefined, configurationSet: string): Closure['lanes'][number] | undefined {
  return closure?.lanes.find((lane) => lane.configurationSet === configurationSet);
}

function withLiveSesKinds(deps: ActionDeps): ActionDeps {
  const ses = Object.fromEntries(Object.keys(deps.kinds.ses ?? {}).map((operation) => [operation, 'live'] as const));
  return { ...deps, kinds: { ...deps.kinds, ses } };
}

// An honest record for another lane, built from the seeded bulk record with only its lane, incident id
// and window changed, so actionGate passes it and a refusal can only come from the step under test.
async function plantApprovingIncident(deps: ActionDeps, configurationSet: string): Promise<string> {
  const seededRecord = await storedRecord(deps, INCIDENT_ID, NOW_MS);
  const incidentId = incidentIdOf(configurationSet, LATER_MS);
  const window = spikeWindowFor(LATER_MS);
  const record = buildEvidenceRecord({ ...recordInputOf(seededRecord), incidentId, lane: { configurationSet, lane: configurationSet }, window });
  const optionId = record.approvedOptions[0]?.optionId;
  await plantIncident(deps, { configurationSet, incidentId, openingWindow: window, record, decision: { outcome: 'close', optionId, explanation: 'planted' }, nowMs: NOW_MS });
  return incidentId;
}

function recordInputOf(record: EvidenceRecord): EvidenceRecordInput {
  const input: Partial<EvidenceRecord> = { ...record };
  delete input.schemaVersion;
  delete input.approvedOptions;
  delete input.hash;
  return input as EvidenceRecordInput;
}

describe('a set the lane map or the SES configuration refuses at action time is never paused (R6, AC-11)', () => {
  it.each([
    ['an identity defaulting to fothering-bulk', 'default-configuration-set', () => withRecording('ses.getEmailIdentity', 'example.org', { defaultConfigurationSet: BULK, dkimStatus: 'SUCCESS', dkimSigningEnabled: true, identityType: 'DOMAIN' })],
    ['a fothering-bulk destination missing DELIVERY_DELAY', 'destination-missing-event-types', () => bulkDestinationWithout('DELIVERY_DELAY')],
    ['a configuration set outside the lane map', 'unlisted-configuration-set', () => withRecording('ses.listConfigurationSets', null, [TRANSACTIONAL, BULK, ALERTS, 'fothering-legacy'])],
  ] as const)('refuses %s as configuration-not-closeable naming %s', async (_case, code, recordings) => {
    const { root } = await seeded();
    const { deps, sesState } = root({ recordings: recordings() });

    await runActionCycle(deps);

    const closure = await storedClosure(deps, INCIDENT_ID, ACT_MS);
    expect(closure).toMatchObject({ outcome: 'refused', reason: 'configuration-not-closeable', sesFacts: 'read' });
    expect(laneOf(closure, BULK)?.configurationRefusals).toEqual([code]);
    expect(mutationsOf(sesState)).toEqual([]);
  });

  it.each([
    [ALERTS, ['operator-alert', 'transactional'], 'test kinds'],
    [TRANSACTIONAL, ['transactional'], 'test kinds'],
    [ALERTS, ['operator-alert', 'transactional'], 'live SES kinds'],
    [TRANSACTIONAL, ['transactional'], 'live SES kinds'],
  ] as const)('refuses an honest record approving %s with the lane-map codes %j, under %s (AC-P12)', async (configurationSet, codes, kinds) => {
    const { root } = await seeded();
    const { deps, sesState } = root();
    const incidentId = await plantApprovingIncident(deps, configurationSet);

    await runActionCycle(kinds === 'live SES kinds' ? withLiveSesKinds(deps) : deps);

    const closure = await storedClosure(deps, incidentId, ACT_MS);
    expect(closure).toMatchObject({ outcome: 'refused', reason: 'configuration-not-closeable', configurationSet });
    expect(laneOf(closure, configurationSet)).toEqual({ configurationSet, state: 'incident-open', configurationRefusals: [...codes] });
    expect(mutationsOf(sesState)).toEqual([]);
  });

  it('leaves an honest record whose own closeability is refused to the gate, which refuses it first', async () => {
    const { root } = await seeded();
    const { deps, sesState } = root();
    const seededRecord = await storedRecord(deps, INCIDENT_ID, NOW_MS);
    const incidentId = incidentIdOf(ALERTS, LATER_MS);
    const decision = { ...seededRecord.decision, closeability: { state: 'refused' as const, reasons: ['caller-on-another-set' as const] } };
    const record = buildEvidenceRecord({ ...recordInputOf(seededRecord), incidentId, lane: { configurationSet: ALERTS, lane: ALERTS }, window: spikeWindowFor(LATER_MS), decision });
    const optionId = record.approvedOptions[0]?.optionId;
    await plantIncident(deps, { configurationSet: ALERTS, incidentId, openingWindow: record.window, record, decision: { outcome: 'close', optionId, explanation: 'planted' }, nowMs: NOW_MS });

    await runActionCycle(deps);

    expect(await storedClosure(deps, incidentId, ACT_MS)).toMatchObject({ outcome: 'refused', reason: 'decision-differs' });
    expect(mutationsOf(sesState)).toEqual([]);
  });
});

describe('every closure stores each lane state and its configuration-only refusals (D-102, CH-06)', () => {
  it('stores the three lanes in lane-map order on the paused closure', async () => {
    const { root } = await seeded();
    const { deps } = root();

    await runActionCycle(deps);

    const closure = await storedClosure(deps, INCIDENT_ID, ACT_MS);
    expect(closure?.outcome).toBe('paused');
    expect(closure?.lanes).toEqual(LANE_BLOCK);
  });

  it('stores the lane-map refusals alone when the SES facts could not be read', async () => {
    const { root } = await seeded();
    const { deps } = root({ recordings: withoutListIdentities() });

    await runActionCycle(deps);

    const closure = await storedClosure(deps, INCIDENT_ID, ACT_MS);
    expect(closure).toMatchObject({ outcome: 'refused', reason: 'ses-facts-unavailable', sesFacts: 'failed' });
    expect(closure?.lanes).toEqual(LANE_BLOCK);
  });
});

describe('the gate runs through the real act', () => {
  it('refuses a tampered evidence hash as hash-mismatch with no put (T-03-02)', async () => {
    const { store, root } = await seeded();
    const { deps, sesState } = root();
    tamperEvidenceHash(store, INCIDENT_ID);

    await runActionCycle(deps);

    expect(await storedClosure(deps, INCIDENT_ID, ACT_MS)).toMatchObject({ outcome: 'refused', reason: 'hash-mismatch' });
    expect(putsOf(sesState)).toEqual([]);
  });

  it('still stores the lane block on a gate refusal, since the markers and facts are read before the gate (D-89)', async () => {
    const { store, root } = await seeded();
    const { deps } = root();
    tamperEvidenceHash(store, INCIDENT_ID);

    await runActionCycle(deps);

    expect((await storedClosure(deps, INCIDENT_ID, ACT_MS))?.lanes).toEqual(LANE_BLOCK);
  });
});

// The pause and send of a deployed root with the switch unset, on a copy of a test root's deps, so the
// dry-run recorder runs while no live client is ever built.
function withDryRunWrites(deps: ActionDeps, lines: string[]): ActionDeps {
  const deployed = buildActionRoot({ runtimeContext: 'deployed', switchValue: undefined, dryRunSink: (line) => lines.push(line) });
  const ses = { ...deps.ports.ses, pauseConfigurationSet: deployed.ports.ses.pauseConfigurationSet, sendEmail: deployed.ports.ses.sendEmail };
  const deployedSes = deployed.kinds.ses;
  return { ...deps, ports: { ...deps.ports, ses }, kinds: deployedSes === undefined ? deps.kinds : { ...deps.kinds, ses: deployedSes } };
}

describe('a pause that resolves dry-run claims nothing it did not do (D-120, AC-24 dry-run half)', () => {
  it('writes one would-pause line and outcome dry-run, with no read-back and no pause request', async () => {
    const { root } = await seeded();
    const { deps, sesState } = root();
    const lines: string[] = [];

    await runActionCycle(orderRecorded(withDryRunWrites(deps, lines), sesState.calls));

    expect(await storedClosure(deps, INCIDENT_ID, ACT_MS)).toMatchObject({ outcome: 'dry-run', pauseRequestedAtMs: null, readBack: null, holdEndMs: null });
    expect(lines).toEqual([PAUSE_LINE]);
    expect(sesState.calls.filter((call) => call.startsWith('get-issued') || call.startsWith('put-'))).toEqual([]);
    expect(sesState.calls.filter((call) => call === 'write:paused' || call === 'write:closed')).toEqual([]);
  });
});

const T = ACT_MS;
const HOLD_END_MS = T + HOLD_MS;
const HOLD_CHECK_MS = HOLD_END_MS + HOLD_CHECK_DELAY_MS;
const NEXT_BULK_INCIDENT_ID = incidentIdOf(BULK, LATER_MS);

function countingFolds(deps: ActionDeps): { deps: ActionDeps; folds: { count: number } } {
  const folds = { count: 0 };
  const eventStore = deps.ports.eventStore;
  const counted: EventStorePort = {
    ...eventStore,
    foldLane<S>(configurationSet: string, fromBucketMs: number, toBucketMs: number, nowMs: number, fold: LaneFold<S>): Promise<S> {
      folds.count += 1;
      return eventStore.foldLane(configurationSet, fromBucketMs, toBucketMs, nowMs, fold);
    },
  };
  return { deps: { ...deps, ports: { ...deps.ports, eventStore: counted } }, folds };
}

interface PausedLane extends Scenario {
  deps: ActionDeps;
  sesState: FixtureSesState;
}

/** 03-01's tracer: the seeded bulk close paused at T, with the pause pointer naming it. */
async function pausedAtT(script: (state: FixtureSesState) => void = () => {}): Promise<PausedLane> {
  const scenario = await seeded();
  const { deps, sesState } = scenario.root();
  script(sesState);
  await runActionCycle(deps);
  return { ...scenario, deps, sesState };
}

function loggedEvents(lines: readonly string[], event: string): Record<string, unknown>[] {
  return lines.map((line) => JSON.parse(line) as Record<string, unknown>).filter((entry) => entry.event === event);
}

// A second bulk incident detection opened after the first: the marker moves to it and its record is the
// seeded one with only its id and window changed, so the gate passes it and a refusal comes from step 6.
async function plantNextBulkIncident(deps: ActionDeps): Promise<void> {
  const seededRecord = await storedRecord(deps, INCIDENT_ID, NOW_MS);
  const window = spikeWindowFor(LATER_MS);
  const record = buildEvidenceRecord({ ...recordInputOf(seededRecord), incidentId: NEXT_BULK_INCIDENT_ID, window });
  const optionId = record.approvedOptions[0]?.optionId;
  await moveMarker(deps, BULK, NEXT_BULK_INCIDENT_ID, NOW_MS);
  await plantIncident(deps, { configurationSet: BULK, incidentId: NEXT_BULK_INCIDENT_ID, openingWindow: window, record, decision: { outcome: 'close', optionId, explanation: 'planted' }, nowMs: NOW_MS, omit: ['marker'] });
}

async function plantReopened(deps: ActionDeps, incidentId: string): Promise<void> {
  const closure = await storedClosure(deps, incidentId, T);
  if (closure === undefined) throw new Error('no closure is stored to reopen');
  const reopen = { attempts: 1, claimedAtMs: T + 100_000, requestedAtMs: T + 101_000, readBackAtMs: T + 102_000, outcome: 'reopened' };
  if ((await deps.ports.decisionStore.updateIfVersion(closureKey(incidentId), closure.version, { reopen }, T + 102_000)) !== 'updated') {
    throw new Error('the closure moved while the test reopened it');
  }
}

describe('a paused lane is called closed only after the hold check finds no send accepted after the hold (R2)', () => {
  it('folds the stored Send records at the first run due and writes closed with sendsAfterHold 0 (tracer)', async () => {
    const { deps } = await pausedAtT();

    await runActionCycle(at(deps, HOLD_CHECK_MS));

    const closure = await storedClosure(deps, INCIDENT_ID, HOLD_CHECK_MS);
    expect(closure?.outcome).toBe('closed');
    expect(closure).toMatchObject({ sendsAfterHold: 0, holdCheckedAtMs: HOLD_CHECK_MS, holdCheckedThroughMs: HOLD_CHECK_MS, holdEndMs: HOLD_END_MS });
    expect(await deps.ports.decisionStore.getItem(incidentPauseKey(BULK), HOLD_CHECK_MS)).toMatchObject({ incidentId: INCIDENT_ID });
  });

  it('writes nothing one millisecond before the hold check is due and folds nothing (AC-5)', async () => {
    const { deps } = await pausedAtT();
    const counted = countingFolds(at(deps, HOLD_CHECK_MS - 1));

    await runActionCycle(counted.deps);

    expect((await storedClosure(deps, INCIDENT_ID, HOLD_CHECK_MS - 1))?.outcome).toBe('paused');
    expect(counted.folds.count).toBe(0);
  });

  it('writes not-holding with the count when a Send record follows the hold end (AC-4)', async () => {
    const { deps } = await pausedAtT();
    await deps.ports.eventStore.putIfAbsent(sendRecordAt(BULK, HOLD_END_MS + 10_000, 'after-hold-1'));

    await runActionCycle(at(deps, HOLD_CHECK_MS));

    expect(await storedClosure(deps, INCIDENT_ID, HOLD_CHECK_MS)).toMatchObject({ outcome: 'not-holding', sendsAfterHold: 1, holdCheckedAtMs: HOLD_CHECK_MS });
  });

  it('counts a Send record whose mail timestamp is the hold end exactly (AC-E3)', async () => {
    const { deps } = await pausedAtT();
    await deps.ports.eventStore.putIfAbsent(sendRecordAt(BULK, HOLD_END_MS, 'at-hold-end'));

    await runActionCycle(at(deps, HOLD_CHECK_MS));

    expect(await storedClosure(deps, INCIDENT_ID, HOLD_CHECK_MS)).toMatchObject({ outcome: 'not-holding', sendsAfterHold: 1 });
  });

  it('writes closed with one fold when no Send record at all follows the pause (AC-E4, closure half)', async () => {
    const { deps } = await pausedAtT();
    const counted = countingFolds(at(deps, HOLD_CHECK_MS));

    await runActionCycle(counted.deps);

    expect(await storedClosure(deps, INCIDENT_ID, HOLD_CHECK_MS)).toMatchObject({ outcome: 'closed', sendsAfterHold: 0 });
    expect(counted.folds.count).toBe(1);
  });

  it('decides on the mail timestamp alone, whatever order the Send records were stored in (AC-E5)', async () => {
    const { root } = await seeded();
    const { deps } = root();
    for (const offset of [59_999, 50_000, 30_000]) await deps.ports.eventStore.putIfAbsent(sendRecordAt(BULK, T + offset, `before-hold-${offset}`));
    await runActionCycle(deps);
    await deps.ports.eventStore.putIfAbsent(sendRecordAt(BULK, T + 20_000, 'stored-late'));

    await runActionCycle(at(deps, HOLD_CHECK_MS));

    expect(await storedClosure(deps, INCIDENT_ID, HOLD_CHECK_MS)).toMatchObject({ outcome: 'closed', sendsAfterHold: 0 });
  });

  it('never hold-checks a paused closure the operator reopened, logging hold-check-skipped (D-94)', async () => {
    const { deps, root } = await pausedAtT();
    await plantReopened(deps, INCIDENT_ID);
    const lines: string[] = [];
    const counted = countingFolds(root({ now: () => HOLD_CHECK_MS, logSink: (line) => lines.push(line) }).deps);

    await runActionCycle(counted.deps);

    expect((await storedClosure(deps, INCIDENT_ID, HOLD_CHECK_MS))?.outcome).toBe('paused');
    expect(counted.folds.count).toBe(0);
    expect(loggedEvents(lines, 'hold-check-skipped')).toEqual([{ event: 'hold-check-skipped', level: 'info', incidentId: INCIDENT_ID }]);
  });

  it('says closed only as a hold-checked outcome across closures and log lines, and reports a closure written closed on the read-back (AC-6)', async () => {
    const lines: string[] = [];
    const closures: Closure[] = [];
    for (const extraSend of [false, true]) {
      const { store, deps, root } = await pausedAtT();
      if (extraSend) await deps.ports.eventStore.putIfAbsent(sendRecordAt(BULK, HOLD_END_MS + 1, 'after-hold'));
      await runActionCycle(root({ now: () => HOLD_CHECK_MS, logSink: (line) => lines.push(line) }).deps);
      for (const item of store.items.values()) {
        const closure = parseClosure(item);
        if (closure !== undefined) closures.push(closure);
      }
    }

    expect(closures.map((closure) => closure.outcome).sort()).toEqual(['closed', 'not-holding']);
    expect(loggedEvents(lines, 'hold-check').map((entry) => entry.outcome).sort()).toEqual(['closed', 'not-holding']);
    expect(closedWordViolations({ closures, logLines: lines })).toEqual([]);
    const planted = { ...closureClaimItem({ incidentId: INCIDENT_ID, configurationSet: BULK, decisionOutcome: 'close', nowMs: T }), outcome: 'closed' as const, readBack: false, readBackAtMs: T };
    expect(closedWordViolations({ closures: [planted], logLines: [] })).toHaveLength(1);
  });
});

describe('one lane holds at most one pause Fothering may still own (D-95)', () => {
  it('refuses lane-already-paused for a second incident on a lane whose pointer names a paused closure', async () => {
    const { deps, sesState } = await pausedAtT();
    await plantNextBulkIncident(deps);

    await runActionCycle(at(deps, T + 120_000));

    expect(await storedClosure(deps, NEXT_BULK_INCIDENT_ID, T + 120_000)).toMatchObject({ outcome: 'refused', reason: 'lane-already-paused' });
    expect(putsOf(sesState)).toEqual(['put-issued:fothering-bulk:false']);
    expect(await deps.ports.decisionStore.getItem(incidentPauseKey(BULK), T + 120_000)).toMatchObject({ incidentId: INCIDENT_ID });
  });

  it('moves the pointer by a versioned update and pauses once the closure it names failed to pause', async () => {
    const { deps, sesState } = await pausedAtT((state) => state.putFaults.set(BULK, 'throw'));
    expect((await storedClosure(deps, INCIDENT_ID, T))?.outcome).toBe('pause-failed');
    sesState.putFaults.delete(BULK);
    await plantNextBulkIncident(deps);

    await runActionCycle(at(deps, T + 120_000));

    expect((await storedClosure(deps, NEXT_BULK_INCIDENT_ID, T + 120_000))?.outcome).toBe('paused');
    expect(await deps.ports.decisionStore.getItem(incidentPauseKey(BULK), T + 120_000)).toMatchObject({ incidentId: NEXT_BULK_INCIDENT_ID, version: 1 });
  });

  it('writes no pointer for an act whose pause resolved dry-run (D-120)', async () => {
    const { root } = await seeded();
    const { deps } = root();

    await runActionCycle(withDryRunWrites(deps, []));

    expect((await storedClosure(deps, INCIDENT_ID, T))?.outcome).toBe('dry-run');
    expect(await deps.ports.decisionStore.getItem(incidentPauseKey(BULK), T)).toBeUndefined();
  });

  it('stores fothering-bulk as paused-by-fothering in the lane block of a later act on another lane (D-102)', async () => {
    const { deps } = await pausedAtT();
    const incidentId = await plantApprovingIncident(deps, TRANSACTIONAL);

    await runActionCycle(at(deps, T + 120_000));

    const closure = await storedClosure(deps, incidentId, T + 120_000);
    expect(closure?.outcome).toBe('refused');
    expect(laneOf(closure, BULK)?.state).toBe('paused-by-fothering');
  });
});

describe('no closure item and no log line carries an address or a recipient hash (AC-P9)', () => {
  it('stores and logs codes, ids and set names only', async () => {
    const { store, root } = await seeded(decidingRuntime, [BAD_BATCH, RECEIPT_BATCH]);
    const lines: string[] = [];
    const { deps } = root({ logSink: (line) => lines.push(line) });

    await runActionCycle(deps);

    const items = [...store.items.values()] as DecisionStoreItem[];
    const hashes = [...new Set(items.flatMap((item) => (typeof item.recipientHmac === 'string' ? [item.recipientHmac] : [])))];
    const closures = items.filter((item) => item.sk === 'CLOSURE').map((item) => JSON.stringify(item));
    expect(closures).toHaveLength(2);
    expect(hashes.length).toBeGreaterThan(0);
    expect(lines.length).toBeGreaterThan(0);
    for (const text of [...closures, ...lines]) {
      expect(text).not.toContain('@');
      expect(hashes.filter((hash) => text.includes(hash))).toEqual([]);
    }
  });
});

describe('buildActionRoot holds the composition-root rules (AC-24)', () => {
  it('resolves every operation of every row to its expected kind over 2 contexts and 7 switch values', () => {
    expect(() => assertRootMatrix(buildActionRoot)).not.toThrow();
  });

  it.each(['laneMap', 'wait'] as const)('refuses a %s override outside runtimeContext test', (name) => {
    const overrides = { laneMap: LANES, wait: async () => {} };
    const build = () => buildActionRoot({ runtimeContext: 'deployed', switchValue: undefined, dryRunSink: () => {}, [name]: overrides[name] });
    expect(build).toThrow(`a ${name} override is accepted only in runtimeContext test`);
  });

  // AC-P4, type half: the act is typed over ActionDeps, whose SES port has no reopen operation.
  it('hands the act an SES port with no reopen operation', () => {
    const { ports } = buildActionRoot({ runtimeContext: 'test', switchValue: undefined });
    expect(Object.keys(ports.ses).sort()).toEqual([
      'getConfigurationSetEventDestinations',
      'getConfigurationSetSending',
      'getEmailIdentity',
      'listConfigurationSets',
      'listEmailIdentities',
      'pauseConfigurationSet',
      'sendEmail',
    ]);
  });

  it('builds no SES client until a port method runs, and reads back live whatever the switch', async () => {
    let built = 0;
    // A stand-in with the one method the adapter calls: this package builds no AWS client itself.
    const sesv2 = () => {
      built += 1;
      return { send: async () => ({ SendingOptions: { SendingEnabled: false } }) };
    };
    const deps = buildActionRoot({ runtimeContext: 'deployed', switchValue: undefined, liveClients: { sesv2 }, dryRunSink: () => {} });
    expect(built).toBe(0);
    expect(deps.kinds.ses?.getConfigurationSetSending).toBe('live');

    await expect(deps.ports.ses.getConfigurationSetSending(BULK)).resolves.toEqual({ sendingEnabled: false });
    await deps.ports.ses.getConfigurationSetSending(BULK);
    expect(built).toBe(1);
  });
});

describe('the action entry', () => {
  afterEach(() => {
    vi.doUnmock('./root.js');
    vi.resetModules();
  });

  it('builds no root when the module loads, then one deployed root for every invocation of the container', async () => {
    vi.resetModules();
    const built: unknown[] = [];
    vi.doMock('./root.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('./root.js')>();
      return {
        ...actual,
        buildActionRoot: (options: unknown) => {
          built.push(options);
          return actual.buildActionRoot({ runtimeContext: 'test', switchValue: undefined, now: () => ACT_MS });
        },
      };
    });

    const { handler } = await import('./handler.js');
    expect(built).toHaveLength(0);
    const first = await handler();
    await handler();

    expect(built).toHaveLength(1);
    expect(built[0]).toMatchObject({ runtimeContext: 'deployed' });
    expect(first.acted).toEqual([]);
  });
});
