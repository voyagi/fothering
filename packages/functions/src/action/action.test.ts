import { afterEach, describe, expect, it, vi } from 'vitest';
import fc from 'fast-check';
import { BUCKET_MS, bucketStartMs } from '@fothering/core/buckets';
import { ACTION_FUNCTION_TIMEOUT_MS, HOLD_CHECK_DELAY_MS, HOLD_MS, LANE_HOUR_ATTEMPT_CAP } from '@fothering/core/close-values';
import type { ConfigurationRefusal } from '@fothering/core/closeability';
import { closureClaimItem, closureKey, decisionOf, parseClosure, type Closure, type FreshnessRefusal } from '@fothering/core/closure';
import { AUTOMATED_SENDER_FOOTER, MODEL_PARAGRAPH_LABEL, MODEL_TEXT_MARKER_HEADER } from '@fothering/core/disclosure';
import { reserveLaneAttempt } from '@fothering/core/counters';
import {
  buildEvidenceRecord,
  counterLaneHourKey,
  incidentItemKey,
  incidentLaneKey,
  incidentPauseKey,
  type EvidenceRecord,
  type EvidenceRecordInput,
} from '@fothering/core/evidence-record';
import type { LaneMap } from '@fothering/core/lanes';
import {
  ACCOUNT_PAUSE_LIMIT_SENTENCE,
  LANE_STATE_WORDS,
  PAUSED_APP_SENTENCE,
  REASON_SENTENCES,
  SECTION_HEADINGS,
  isoOf,
  renderOperatorEmail,
  type RenderedEmail,
} from '@fothering/core/operator-email';
import { RETENTION_SECONDS } from '@fothering/core/records';
import { incidentLimitSentence, reopenCommandFor, reputationResetSentence } from '@fothering/core/reopen';
import { propertySeed } from '@fothering/core/test/property-seed';
import { spikeWindowFor, type BucketWindow, type LaneFold } from '@fothering/core/window-fold';
import { DRY_RUN_MESSAGE_ID } from '@fothering/providers/dry-run';
import { createFixtureTableState } from '@fothering/providers/fixtures/ingest-ports';
import { createFixtureSesState } from '@fothering/providers/fixtures/later-ports';
import type {
  DecisionStoreItem,
  DecisionStorePort,
  EventStorePort,
  FixtureSesState,
  FixtureTableState,
  Recording,
  SendEmailRequest,
} from '@fothering/providers/port-types';
import { MAX_IDENTITY_READS, SES_READ_SPACING_MS } from '@fothering/providers/ses-facts';
import { assertRootMatrix } from '@fothering/providers/test/root-matrix';
import {
  BAD_BATCH,
  BULK,
  COMPLETE_SES_RECORDINGS,
  HOLD_CHECKED_AT_MS,
  LANES,
  NOW_MS,
  OPERATOR,
  PAUSED_AT_MS,
  RECEIPT_BATCH,
  TRANSACTIONAL,
  buildTestActionRoot,
  capturingSends,
  closeRuntime,
  closeState,
  closedWordViolations,
  decidingRuntime,
  incidentIdOf,
  moveMarker,
  plantClosure,
  plantDecision,
  plantIncident,
  seedClosedLane,
  seedIncidents,
  sendRecordAt,
  storedClosure,
  storedRecord,
  type EmailOfClosure,
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
    reserveLaneAttempt: (request) => store.reserveLaneAttempt(request),
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
    reserveLaneAttempt: (request) => store.reserveLaneAttempt(request),
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

// A later bulk incident detection opened after the seeded one: the marker moves to it and its record is
// the seeded one with only its id and window changed, so the gate passes it and a refusal comes from
// the step under test.
async function plantBulkIncidentAt(deps: ActionDeps, openedAtMs: number): Promise<string> {
  const seededRecord = await storedRecord(deps, INCIDENT_ID, NOW_MS);
  const incidentId = incidentIdOf(BULK, openedAtMs);
  const window = spikeWindowFor(openedAtMs);
  const record = buildEvidenceRecord({ ...recordInputOf(seededRecord), incidentId, window });
  const optionId = record.approvedOptions[0]?.optionId;
  await moveMarker(deps, BULK, incidentId, NOW_MS);
  await plantIncident(deps, { configurationSet: BULK, incidentId, openingWindow: window, record, decision: { outcome: 'close', optionId, explanation: 'planted' }, nowMs: NOW_MS, omit: ['marker'] });
  return incidentId;
}

async function plantNextBulkIncident(deps: ActionDeps): Promise<void> {
  await plantBulkIncidentAt(deps, LATER_MS);
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

function laneHourItem(deps: ActionDeps, nowMs: number): Promise<DecisionStoreItem | undefined> {
  return deps.ports.decisionStore.getItem(counterLaneHourKey(BULK, new Date(nowMs).toISOString().slice(0, 13)), nowMs);
}

async function prefillLaneAttempts(deps: ActionDeps, count: number, nowMs: number): Promise<void> {
  for (let attempt = 0; attempt < count; attempt += 1) {
    expect((await reserveLaneAttempt(deps.ports.decisionStore, { configurationSet: BULK, nowMs })).outcome).toBe('reserved');
  }
}

function recordingReservations(deps: ActionDeps, calls: string[]): ActionDeps {
  const store = deps.ports.decisionStore;
  return withStore(deps, {
    reserveLaneAttempt: (request) => {
      calls.push('reserve');
      return store.reserveLaneAttempt(request);
    },
  });
}

// One counter per action root, held in this process and never in the table: what a second process
// could not see. The two-roots case must exceed the cap with it (AC-10, red).
const PLANTED_LANE_COUNTERS = new Map<string, number>();

function withPlantedLaneCounter(deps: ActionDeps, root: string): ActionDeps {
  return withStore(deps, {
    reserveLaneAttempt: async (request) => {
      const attempts = PLANTED_LANE_COUNTERS.get(root) ?? 0;
      if (attempts >= request.cap) return 'cap';
      PLANTED_LANE_COUNTERS.set(root, attempts + 1);
      return 'reserved';
    },
  });
}

// Ten bulk incidents, one opened per bucket after the seeded one, each acted on in turn by one of two
// roots built over one store and one SES whose puts all throw, so every closure ends pause-failed, the
// pointer never holds the lane, and only the lane-hour counter can stop the next put.
async function tenAttemptsThroughTwoRoots(wrap: (deps: ActionDeps, root: string) => ActionDeps): Promise<number> {
  const { store } = await seeded();
  const sesState = createFixtureSesState();
  sesState.putFaults.set(BULK, 'throw');
  const runMs = Date.UTC(2026, 9, 11, 12, 55);
  const roots = ['root-a', 'root-b'].map((root) => wrap(buildTestActionRoot({ store, sesState, now: () => runMs }).deps, root));
  for (let index = 1; index <= 10; index += 1) {
    const root = roots[index % 2];
    if (root === undefined) throw new Error('no root to act with');
    await plantBulkIncidentAt(root, NOW_MS + index * BUCKET_MS);
    await runActionCycle(root);
  }
  return putsOf(sesState).length;
}

describe('pause attempts on one lane stop at 4 per UTC hour in the shared table (R5, D-99)', () => {
  it('creates the lane-hour counter at 1 with its expiry on the first pause of the hour (AC-E13)', async () => {
    const { deps } = await pausedAtT();
    expect(await laneHourItem(deps, T)).toMatchObject({ attempts: 1, expiresAt: Math.floor(T / 1000) + RETENTION_SECONDS });
  });

  it('pauses on the fourth attempt of the hour and refuses a fifth incident lane-cap-reached with no SES call (AC-10)', async () => {
    const { root } = await seeded();
    const { deps, sesState } = root();
    await prefillLaneAttempts(deps, 3, T);

    await runActionCycle(deps);
    expect((await storedClosure(deps, INCIDENT_ID, T))?.outcome).toBe('paused');
    await plantReopened(deps, INCIDENT_ID);
    await plantNextBulkIncident(deps);
    const callsBefore = sesState.calls.length;
    await runActionCycle(at(deps, T + 120_000));

    expect(await storedClosure(deps, NEXT_BULK_INCIDENT_ID, T + 120_000)).toMatchObject({ outcome: 'refused', reason: 'lane-cap-reached' });
    expect(sesState.calls.slice(callsBefore)).toEqual([]);
    expect(await laneHourItem(deps, T + 120_000)).toMatchObject({ attempts: 4 });
  });

  it('lets at most 4 of 10 attempts through two roots sharing one store reach SES (AC-10)', async () => {
    expect(await tenAttemptsThroughTwoRoots((deps) => deps)).toBe(LANE_HOUR_ATTEMPT_CAP);
  });

  it('is shown red by a planted counter each root keeps in its own process (AC-10)', async () => {
    PLANTED_LANE_COUNTERS.clear();
    expect(await tenAttemptsThroughTwoRoots(withPlantedLaneCounter)).toBeGreaterThan(LANE_HOUR_ATTEMPT_CAP);
  });

  it('reserves before the put, and a refused reservation makes no put (AC-E14)', async () => {
    const paused = (await seeded()).root();
    await runActionCycle(recordingReservations(paused.deps, paused.sesState.calls));
    const reserveAt = paused.sesState.calls.indexOf('reserve');
    expect(reserveAt).toBeGreaterThanOrEqual(0);
    expect(reserveAt).toBeLessThan(paused.sesState.calls.indexOf('put-issued:fothering-bulk:false'));

    const capped = (await seeded()).root();
    await prefillLaneAttempts(capped.deps, LANE_HOUR_ATTEMPT_CAP, T);
    await runActionCycle(recordingReservations(capped.deps, capped.sesState.calls));
    expect(capped.sesState.calls).toEqual(['reserve']);
    expect(await storedClosure(capped.deps, INCIDENT_ID, T)).toMatchObject({ outcome: 'refused', reason: 'lane-cap-reached' });
  });

  it('counts a reserved attempt whose put throws (AC-E15)', async () => {
    const { deps } = await pausedAtT((state) => state.putFaults.set(BULK, 'throw'));
    expect((await storedClosure(deps, INCIDENT_ID, T))?.outcome).toBe('pause-failed');
    expect(await laneHourItem(deps, T)).toMatchObject({ attempts: 1 });
  });
});

// AC-E18 and the cap halves of AC-8 and AC-11: every refusal before step 7 leaves the counter untouched.
describe('no refusal and no dry run takes a lane-hour attempt (AC-E18)', () => {
  it('takes none for a gate refusal (hash-mismatch)', async () => {
    const { store, root } = await seeded();
    const { deps } = root();
    tamperEvidenceHash(store, INCIDENT_ID);
    await runActionCycle(deps);
    expect((await storedClosure(deps, INCIDENT_ID, T))?.reason).toBe('hash-mismatch');
    expect(await laneHourItem(deps, T)).toBeUndefined();
  });

  it('takes none for a freshness refusal (newer-incident-elsewhere)', async () => {
    const { root } = await seeded();
    const { deps } = root();
    await plantReceiptIncident(deps, spikeWindowFor(LATER_MS));
    await runActionCycle(deps);
    expect((await storedClosure(deps, INCIDENT_ID, T))?.reason).toBe('newer-incident-elsewhere');
    expect(await laneHourItem(deps, T)).toBeUndefined();
  });

  it('takes none for a freshness refusal (record-too-old)', async () => {
    const { root } = await seeded();
    const { deps } = root();
    const oldMs = (await storedRecord(deps, INCIDENT_ID, NOW_MS)).window.toBucketMs + 3_600_001;
    await runActionCycle(at(deps, oldMs));
    expect((await storedClosure(deps, INCIDENT_ID, oldMs))?.reason).toBe('record-too-old');
    expect(await laneHourItem(deps, oldMs)).toBeUndefined();
  });

  it('takes none for a closeability refusal (configuration-not-closeable)', async () => {
    const { root } = await seeded();
    const { deps } = root({ recordings: bulkDestinationWithout('DELIVERY_DELAY') });
    await runActionCycle(deps);
    expect((await storedClosure(deps, INCIDENT_ID, T))?.reason).toBe('configuration-not-closeable');
    expect(await laneHourItem(deps, T)).toBeUndefined();
  });

  it('takes none for lane-already-paused, acted on in the next UTC hour', async () => {
    const { deps } = await pausedAtT();
    await plantNextBulkIncident(deps);
    const nextHourMs = Date.UTC(2026, 9, 11, 13, 4);
    await runActionCycle(at(deps, nextHourMs));
    expect((await storedClosure(deps, NEXT_BULK_INCIDENT_ID, nextHourMs))?.reason).toBe('lane-already-paused');
    expect(await laneHourItem(deps, nextHourMs)).toBeUndefined();
  });

  it('takes none for a pause that resolved dry-run (D-120)', async () => {
    const { root } = await seeded();
    const { deps } = root();
    await runActionCycle(withDryRunWrites(deps, []));
    expect((await storedClosure(deps, INCIDENT_ID, T))?.outcome).toBe('dry-run');
    expect(await laneHourItem(deps, T)).toBeUndefined();
  });
});

describe('concurrent runs leave one closure, at most one pause and one hold-check outcome (R4)', () => {
  it('leaves one CLOSURE item and at most one put across 8 roots run together, and a ninth run makes no SES call (AC-9)', async () => {
    const { store } = await seeded();
    const sesState = createFixtureSesState();
    const roots = Array.from({ length: 8 }, () => buildTestActionRoot({ store, sesState, now: () => T, yieldBetweenOperations: true }).deps);

    await Promise.all(roots.map((deps) => runActionCycle(deps)));

    const closures = [...store.items.values()].filter((item) => {
      const { pk, sk } = item as DecisionStoreItem;
      return pk === `INCIDENT#${INCIDENT_ID}` && sk === 'CLOSURE';
    });
    expect(closures).toHaveLength(1);
    expect(putsOf(sesState).length).toBeLessThanOrEqual(1);
    expect((await storedClosure(buildTestActionRoot({ store, now: () => T }).deps, INCIDENT_ID, T))?.outcome).toBe('paused');
    const callsBefore = sesState.calls.length;
    await runActionCycle(buildTestActionRoot({ store, sesState, now: () => T + 60_000 }).deps);
    expect(sesState.calls.slice(callsBefore)).toEqual([]);
  });

  // Control for the case above: the 8 roots do interleave, so a store whose writes skip their
  // conditions lets more than one of them reach the put.
  it('is shown red by a planted store whose puts and versioned updates skip their conditions', async () => {
    const { store } = await seeded();
    const sesState = createFixtureSesState();
    const tableKeyOf = (key: { pk: string; sk: string }): string => `${key.pk}${String.fromCharCode(0)}${key.sk}`;
    // Each planted write yields first, as the fixture's own writes do with the option set.
    const nextTurn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
    const unconditional = (deps: ActionDeps): ActionDeps =>
      withStore(deps, {
        putIfAbsent: async (item) => {
          await nextTurn();
          store.items.set(tableKeyOf(item), structuredClone(item));
          return 'written';
        },
        updateIfVersion: async (key, expectedVersion, attributes) => {
          await nextTurn();
          const stored = store.items.get(tableKeyOf(key)) as DecisionStoreItem;
          store.items.set(tableKeyOf(key), { ...stored, ...structuredClone(attributes), version: expectedVersion + 1 });
          return 'updated';
        },
      });
    const roots = Array.from({ length: 8 }, () => unconditional(buildTestActionRoot({ store, sesState, now: () => T, yieldBetweenOperations: true }).deps));

    await Promise.all(roots.map((deps) => runActionCycle(deps)));

    expect(putsOf(sesState).length).toBeGreaterThan(1);
  });

  it('makes one versioned update to closed when two hold checks race on one paused closure (AC-E6)', async () => {
    const { store } = await pausedAtT();
    const closedWrites: string[] = [];
    const counted = (deps: ActionDeps): ActionDeps => {
      const inner = deps.ports.decisionStore;
      return withStore(deps, {
        updateIfVersion: async (key, expectedVersion, attributes, nowMs, expected) => {
          const result = await inner.updateIfVersion(key, expectedVersion, attributes, nowMs, expected);
          if (attributes.outcome === 'closed') closedWrites.push(result);
          return result;
        },
      });
    };
    const roots = [0, 1].map(() => counted(buildTestActionRoot({ store, now: () => HOLD_CHECK_MS, yieldBetweenOperations: true }).deps));

    await Promise.all(roots.map((deps) => runActionCycle(deps)));

    expect(closedWrites.filter((result) => result === 'updated')).toEqual(['updated']);
    expect((await storedClosure(buildTestActionRoot({ store, now: () => HOLD_CHECK_MS }).deps, INCIDENT_ID, HOLD_CHECK_MS))?.outcome).toBe('closed');
  });

  // R2 precision backstop: the timestamp travels as an ISO string, as SES writes mail.timestamp, and is
  // compared only as the integer Date.parse gives back.
  it('gives not-holding exactly when the one Send record is at or after the hold end, over ISO timestamps near it', async () => {
    const { store } = await pausedAtT();
    const paused = structuredClone(store.items);
    await fc.assert(
      fc.asyncProperty(fc.oneof(fc.constantFrom(-1, 0, 1), fc.integer({ min: -3_000, max: 3_000 })), async (offsetMs) => {
        const { deps } = buildTestActionRoot({ store: { items: structuredClone(paused) }, now: () => HOLD_CHECK_MS });
        const mailTimestampMs = Date.parse(new Date(HOLD_END_MS + offsetMs).toISOString());
        await deps.ports.eventStore.putIfAbsent(sendRecordAt(BULK, mailTimestampMs, 'boundary-send'));
        await runActionCycle(deps);
        expect((await storedClosure(deps, INCIDENT_ID, HOLD_CHECK_MS))?.outcome).toBe(offsetMs >= 0 ? 'not-holding' : 'closed');
      }),
      { seed: propertySeed(), numRuns: 60 },
    );
  });
});

const FRESHNESS_CASES = ['fresh', 'newer-incident-elsewhere', 'marker-moved', 'state-closed', 'too-old'] as const;
const CLOSEABILITY_CASES = ['complete', 'default-set', 'missing-event-type'] as const;

function recordingsFor(closeability: (typeof CLOSEABILITY_CASES)[number]): readonly Recording[] {
  if (closeability === 'default-set') {
    return withRecording('ses.getEmailIdentity', 'example.org', { defaultConfigurationSet: BULK, dkimStatus: 'SUCCESS', dkimSigningEnabled: true, identityType: 'DOMAIN' });
  }
  return closeability === 'missing-event-type' ? bulkDestinationWithout('DELIVERY_DELAY') : COMPLETE_SES_RECORDINGS;
}

describe('no combination of failed preconditions pauses (AC-P1)', () => {
  it('puts exactly once when the decision, the gate, freshness, closeability and the cap all pass, and never otherwise', async () => {
    const { root } = await seeded();
    const record = await storedRecord(root().deps, INCIDENT_ID, NOW_MS);
    const optionId = record.approvedOptions[0]?.optionId;
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom('close' as const, 'unknown' as const),
        fc.constantFrom('honest' as const, 'option-not-approved' as const),
        fc.constantFrom(...FRESHNESS_CASES),
        fc.constantFrom(...CLOSEABILITY_CASES),
        fc.integer({ min: 0, max: LANE_HOUR_ATTEMPT_CAP }),
        async (decision, gate, freshness, closeability, reserved) => {
          const nowMs = freshness === 'too-old' ? record.window.toBucketMs + 3_600_001 : T;
          const { deps, sesState } = buildTestActionRoot({ store: createFixtureTableState(), now: () => nowMs, recordings: recordingsFor(closeability) });
          const decided = decision === 'close' ? { outcome: 'close', optionId: gate === 'honest' ? optionId : 'option-planted' } : { outcome: 'unknown' };
          const stateStatus = freshness === 'state-closed' ? 'closed' : 'open';
          await plantIncident(deps, { configurationSet: BULK, incidentId: INCIDENT_ID, openingWindow: record.window, stateStatus, record, decision: { ...decided, explanation: 'planted' }, nowMs: NOW_MS });
          if (freshness === 'newer-incident-elsewhere') await plantReceiptIncident(deps, spikeWindowFor(LATER_MS));
          await prefillLaneAttempts(deps, reserved, nowMs);

          await runActionCycle(freshness === 'marker-moved' ? afterClaim(deps, () => moveMarker(deps, BULK, NEXT_BULK_INCIDENT_ID, nowMs)) : deps);

          const allPass = decision === 'close' && gate === 'honest' && freshness === 'fresh' && closeability === 'complete' && reserved < LANE_HOUR_ATTEMPT_CAP;
          expect(putsOf(sesState)).toHaveLength(allPass ? 1 : 0);
        },
      ),
      { seed: propertySeed(), numRuns: 40 },
    );
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

const SEND_LINE_PREFIX = '(dry-run) WOULD ses.sendEmail fothering-alerts ';

interface EmailRun {
  deps: ActionDeps;
  sesState: FixtureSesState;
  requests: SendEmailRequest[];
  dryRunLines: string[];
  logLines: string[];
}

function sendLinesOf(lines: readonly string[]): string[] {
  return lines.filter((line) => line.startsWith(SEND_LINE_PREFIX));
}

/** A test root with the operator configured, its sends, dry-run lines and log lines captured. */
function emailRoot(input: TestActionRootInput): EmailRun {
  const dryRunLines: string[] = [];
  const logLines: string[] = [];
  const root = buildTestActionRoot({ operator: OPERATOR, dryRunSink: (line) => dryRunLines.push(line), logSink: (line) => logLines.push(line), ...input });
  const captured = capturingSends(root.deps);
  return { deps: captured.deps, sesState: root.sesState, requests: captured.requests, dryRunLines, logLines };
}

// 03-04's seeded close paused at T, then the hold-check run at T + 360,000 with the operator configured.
async function closedEmailRun(): Promise<EmailRun> {
  const store = createFixtureTableState();
  const sesState = createFixtureSesState();
  await seedClosedLane({ store, sesState, through: 'paused', operator: OPERATOR });
  const run = emailRoot({ store, sesState, now: () => HOLD_CHECKED_AT_MS });
  await runActionCycle(run.deps);
  return run;
}

async function renderedFromStore(deps: ActionDeps, incidentId: string, nowMs: number): Promise<{ closure: Closure | undefined; record: EvidenceRecord; email: RenderedEmail | undefined }> {
  const closure = await storedClosure(deps, incidentId, nowMs);
  const record = await storedRecord(deps, incidentId, nowMs);
  const decision = decisionOf(await deps.ports.decisionStore.getItem(incidentItemKey(incidentId, 'DECISION'), nowMs));
  const email = closure === undefined ? undefined : renderOperatorEmail({ closure, record, decision, laneMap: LANES });
  return { closure, record, email };
}

function sectionOf(email: RenderedEmail | undefined, heading: string): string {
  return email?.sections.find((section) => section.heading === heading)?.lines.join('\n') ?? '';
}

function laneMapWithAlerts(alertSets: readonly string[]): LaneMap {
  return { ...LANES, lanes: LANES.lanes.map((lane) => ({ ...lane, operatorAlert: alertSets.includes(lane.configurationSet) })) };
}

describe('a closed lane becomes one closed-path email sent once through fothering-alerts (R9)', () => {
  it('claims, renders and sends the closed-path email once from the configured identity, and a later run sends nothing (tracer)', async () => {
    const run = await closedEmailRun();

    const sendLines = sendLinesOf(run.dryRunLines);
    expect(sendLines).toHaveLength(1);
    expect(sendLines[0]).not.toContain('@');
    expect(sendLines[0]).toContain('"recipients":[{"receivingDomain":"example.com","recipientHmac":"');
    expect(run.requests).toHaveLength(1);
    expect(run.requests[0]).toMatchObject({
      from: 'Fothering <alerts@example.com>',
      to: ['ops@example.com'],
      subject: '[Fothering] fothering-bulk closed: sending paused and holding',
      configurationSetName: ALERTS,
    });
    expect(Object.keys(run.requests[0] ?? {}).sort()).toEqual(['configurationSetName', 'from', 'headers', 'subject', 'text', 'to']);
    expect(run.requests[0]?.headers).toEqual([MODEL_TEXT_MARKER_HEADER]);
    expect(typeof run.requests[0]?.text).toBe('string');
    expect((await storedClosure(run.deps, INCIDENT_ID, HOLD_CHECKED_AT_MS))?.email).toEqual({
      kind: 'closed',
      attempts: 1,
      claimedAtMs: HOLD_CHECKED_AT_MS,
      sentAtMs: HOLD_CHECKED_AT_MS,
      messageId: 'fixture-message-1',
      failed: false,
    });

    const later = capturingSends(at(run.deps, HOLD_CHECKED_AT_MS + 300_000));
    await runActionCycle(later.deps);
    expect(later.requests).toEqual([]);
    expect(sendLinesOf(run.dryRunLines)).toHaveLength(1);
  });

  it('holds every element AC-19 lists, each matched to the stored record and closure (AC-19)', async () => {
    const run = await closedEmailRun();
    const { closure, record, email } = await renderedFromStore(run.deps, INCIDENT_ID, HOLD_CHECKED_AT_MS);
    const text = run.requests[0]?.text ?? '';
    const { laneTotals } = record;
    const causeRows = record.rows.filter((row) => row.verdict === 'cause');

    expect(email?.text).toBe(text);
    expect(causeRows.length).toBeGreaterThan(0);
    const expected = [
      `${laneTotals.permanentBounces} of ${laneTotals.recipientSends} recipient-sends`,
      `${laneTotals.complaints} of ${laneTotals.recipientSends} recipient-sends`,
      `${laneTotals.label.hardBounceRatio}: ${laneTotals.hardBounceRatio ?? 'not computed'}`,
      `${laneTotals.label.complaintRatio}: ${laneTotals.complaintRatio ?? 'not computed'}`,
      ...causeRows.map((row) => `${row.dimension} ${row.value ?? 'with no value'}: ${row.permanentBounces} permanent bounces and ${row.complaints} complaints of ${row.sends} recipient-sends`),
      `Isolation verdict: ${record.isolation}`,
      `${isoOf(closure?.pauseRequestedAtMs ?? 0)}`,
      `${isoOf(closure?.readBackAtMs ?? 0)}`,
      `no send was seen accepted on ${BULK} from ${isoOf(closure?.holdEndMs ?? 0)} through ${isoOf(closure?.holdCheckedThroughMs ?? 0)}`,
      reopenCommandFor(BULK),
      PAUSED_APP_SENTENCE,
      reputationResetSentence(BULK),
      ACCOUNT_PAUSE_LIMIT_SENTENCE,
    ];
    expect(expected.filter((part) => !text.includes(part))).toEqual([]);
    const open = sectionOf(email, SECTION_HEADINGS.open);
    for (const lane of closure?.lanes.filter((entry) => entry.configurationSet !== BULK) ?? []) {
      expect(open).toContain(`${lane.configurationSet}: ${LANE_STATE_WORDS[lane.state]}.`);
      for (const refusal of lane.configurationRefusals) expect(open).toContain(REASON_SENTENCES[refusal as ConfigurationRefusal]);
    }
    expect(text).toContain('SendingPausedException');
    expect(text).not.toMatch(/<\/?(html|body|p|br|div)\b/i);
  });

  it('holds the incident limit once in the reopen section, after the reputation sentence', async () => {
    const run = await closedEmailRun();
    const reopen = sectionOf((await renderedFromStore(run.deps, INCIDENT_ID, HOLD_CHECKED_AT_MS)).email, SECTION_HEADINGS.reopen);

    expect(reopen.split(incidentLimitSentence(BULK))).toHaveLength(2);
    expect(reopen.indexOf(incidentLimitSentence(BULK))).toBeGreaterThan(reopen.indexOf(reputationResetSentence(BULK)));
  });

  it('names fothering-bulk in what happened only, and each other lane once in what stays open (AC-E25)', async () => {
    const run = await closedEmailRun();
    const { email } = await renderedFromStore(run.deps, INCIDENT_ID, HOLD_CHECKED_AT_MS);
    const open = sectionOf(email, SECTION_HEADINGS.open);

    expect(sectionOf(email, SECTION_HEADINGS.happened)).toContain(BULK);
    expect(open).not.toContain(BULK);
    expect(open.split(TRANSACTIONAL)).toHaveLength(2);
    expect(open.split(ALERTS)).toHaveLength(2);
  });

  it.each([
    { label: 'no', alertSets: [] },
    { label: 'two', alertSets: [BULK, ALERTS] },
  ])('sends nothing and logs operator-alert-lane-count with $label operator-alert lanes (AC-21)', async ({ alertSets }) => {
    const { root } = await seeded(decidingRuntime, [RECEIPT_BATCH]);
    const logLines: string[] = [];
    const dryRunLines: string[] = [];
    const { deps } = root({ laneMap: laneMapWithAlerts(alertSets), operator: OPERATOR, logSink: (line) => logLines.push(line), dryRunSink: (line) => dryRunLines.push(line) });

    await runActionCycle(deps);

    expect(dryRunLines.filter((line) => line.includes('ses.sendEmail'))).toEqual([]);
    expect(loggedEvents(logLines, 'email-refused')).toEqual([{ event: 'email-refused', level: 'error', incidentId: RECEIPT_INCIDENT_ID, reason: 'operator-alert-lane-count' }]);
  });

  it('sends nothing and logs operator-config-missing, naming no address, when the operator address is unset', async () => {
    const { root } = await seeded(decidingRuntime, [RECEIPT_BATCH]);
    const logLines: string[] = [];
    const dryRunLines: string[] = [];
    const { deps } = root({ operator: { from: 'alerts@example.com' }, logSink: (line) => logLines.push(line), dryRunSink: (line) => dryRunLines.push(line) });

    await runActionCycle(deps);

    expect(dryRunLines.filter((line) => line.includes('ses.sendEmail'))).toEqual([]);
    expect(loggedEvents(logLines, 'email-refused')).toEqual([{ event: 'email-refused', level: 'error', incidentId: RECEIPT_INCIDENT_ID, reason: 'operator-config-missing' }]);
    expect(logLines.filter((line) => line.includes('@'))).toEqual([]);
  });
});

const UNKNOWN_BULK_SUBJECT = `[Fothering] Spike on ${BULK}: nothing was paused`;

const FRESHNESS_EMAIL_CASES: readonly { label: string; reason: FreshnessRefusal; change: (deps: ActionDeps) => Promise<ActionDeps> }[] = [
  {
    label: 'a later incident on another lane',
    reason: 'newer-incident-elsewhere',
    change: async (deps) => {
      await plantReceiptIncident(deps, spikeWindowFor(LATER_MS));
      return deps;
    },
  },
  { label: 'a marker moved after the claim', reason: 'incident-not-open', change: async (deps) => afterClaim(deps, () => moveMarker(deps, BULK, incidentIdOf(BULK, LATER_MS), ACT_MS)) },
  {
    label: 'a STATE no longer open',
    reason: 'incident-not-open',
    change: async (deps) => {
      await closeState(deps, INCIDENT_ID, NOW_MS);
      return deps;
    },
  },
  { label: 'a record one spike window old', reason: 'record-too-old', change: async (deps) => at(deps, (await storedRecord(deps, INCIDENT_ID, NOW_MS)).window.toBucketMs + 3_600_001) },
];

describe('an incident where nothing was paused gets one unknown-path email (R10)', () => {
  it.each(FRESHNESS_EMAIL_CASES)('ends $label with one unknown-path email naming $reason in plain words (AC-8, email half)', async ({ reason, change }) => {
    const { store } = await seeded();
    const run = emailRoot({ store, now: () => ACT_MS });

    await runActionCycle(await change(run.deps));

    expect(sendLinesOf(run.dryRunLines)).toHaveLength(1);
    expect(run.requests.map((request) => request.subject)).toEqual([UNKNOWN_BULK_SUBJECT]);
    expect(run.requests[0]?.text).toContain(REASON_SENTENCES[reason]);
    expect(putsOf(run.sesState)).toEqual([]);
  });

  it('renders a complete template-only email for a cap-reached DECISION (AC-E26)', async () => {
    const { store } = await seeded(failingRuntime);
    const run = emailRoot({ store, now: () => ACT_MS });
    await plantDecision(run.deps, INCIDENT_ID, { outcome: 'unknown', reason: 'cap-reached', items: ['incident'] }, NOW_MS);

    await runActionCycle(run.deps);

    const { email } = await renderedFromStore(run.deps, INCIDENT_ID, ACT_MS);
    expect(run.requests.map((request) => request.text)).toEqual([email?.text]);
    expect(email?.sections.map((part) => part.heading)).toEqual([
      SECTION_HEADINGS.happened,
      SECTION_HEADINGS.saw,
      SECTION_HEADINGS.found,
      SECTION_HEADINGS.open,
      SECTION_HEADINGS.limits,
      SECTION_HEADINGS.reference,
    ]);
    expect(email?.text).toContain(REASON_SENTENCES['cap-reached']);
    expect(email?.text.trimEnd().split('\n').at(-1)).toBe(AUTOMATED_SENDER_FOOTER);
  });

  it('sends no email for a pause the operator reopened before its hold check (D-94)', async () => {
    const { store, deps, sesState } = await pausedAtT();
    await plantReopened(deps, INCIDENT_ID);
    const run = emailRoot({ store, sesState, now: () => HOLD_CHECK_MS });

    await runActionCycle(run.deps);

    expect(run.requests).toEqual([]);
    expect(sendLinesOf(run.dryRunLines)).toEqual([]);
  });
});

function sendsIssued(state: FixtureSesState): number {
  return state.calls.filter((call) => call === 'send-issued').length;
}

async function closedLaneScripted(answers: readonly ('accept' | 'throw')[]): Promise<{ store: FixtureTableState; sesState: FixtureSesState }> {
  const store = createFixtureTableState();
  const sesState = createFixtureSesState();
  await seedClosedLane({ store, sesState, through: 'paused', operator: OPERATOR });
  sesState.sendAnswers.push(...answers);
  return { store, sesState };
}

async function runsOneMinuteApart(store: FixtureTableState, sesState: FixtureSesState, count: number, logLines: string[]): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    const { deps } = buildTestActionRoot({ store, sesState, now: () => HOLD_CHECKED_AT_MS + index * 60_000, operator: OPERATOR, logSink: (line) => logLines.push(line) });
    await runActionCycle(deps);
  }
}

describe('each email attempt is claimed before the send and retried at most 3 times (AC-E29, D-96)', () => {
  it('retries a send that throws on later runs and stops at the first success', async () => {
    const { store, sesState } = await closedLaneScripted(['throw', 'throw', 'accept']);

    await runsOneMinuteApart(store, sesState, 4, []);

    const closure = await storedClosure(buildTestActionRoot({ store, now: () => HOLD_CHECKED_AT_MS }).deps, INCIDENT_ID, HOLD_CHECKED_AT_MS);
    expect(closure?.email).toMatchObject({ kind: 'closed', attempts: 3, failed: false, messageId: 'fixture-message-1', sentAtMs: HOLD_CHECKED_AT_MS + 120_000 });
    expect(sendsIssued(sesState)).toBe(3);
    expect(sesState.calls.filter((call) => call === 'send-resolved')).toHaveLength(1);
  });

  it('marks the email failed after the third throw, logs one email-failed line and tries no fourth time', async () => {
    const { store, sesState } = await closedLaneScripted(['throw', 'throw', 'throw', 'accept']);
    const logLines: string[] = [];

    await runsOneMinuteApart(store, sesState, 5, logLines);

    const closure = await storedClosure(buildTestActionRoot({ store, now: () => HOLD_CHECKED_AT_MS }).deps, INCIDENT_ID, HOLD_CHECKED_AT_MS);
    expect(closure?.email).toMatchObject({ attempts: 3, failed: true, sentAtMs: null, messageId: null });
    expect(sendsIssued(sesState)).toBe(3);
    expect(loggedEvents(logLines, 'email-failed')).toEqual([{ event: 'email-failed', level: 'error', incidentId: INCIDENT_ID, errorName: 'FixtureSesFault' }]);
    expect(loggedEvents(logLines, 'email-attempt-failed')).toHaveLength(2);
  });

  it('counts a claim left with no send past the timeout as a spent attempt, and leaves a younger one alone', async () => {
    const { store, sesState } = await closedLaneScripted([]);
    const { deps } = buildTestActionRoot({ store, sesState, now: () => HOLD_CHECKED_AT_MS });
    await runActionCycle(deps);
    const closure = await storedClosure(deps, INCIDENT_ID, HOLD_CHECKED_AT_MS);
    const stranded = { kind: 'closed', attempts: 1, claimedAtMs: HOLD_CHECKED_AT_MS, sentAtMs: null, messageId: null, failed: false };
    await deps.ports.decisionStore.updateIfVersion(closureKey(INCIDENT_ID), closure?.version ?? -1, { email: stranded }, HOLD_CHECKED_AT_MS);

    await runActionCycle(buildTestActionRoot({ store, sesState, now: () => HOLD_CHECKED_AT_MS + ACTION_FUNCTION_TIMEOUT_MS - 1, operator: OPERATOR }).deps);
    expect(sendsIssued(sesState)).toBe(0);
    await runActionCycle(buildTestActionRoot({ store, sesState, now: () => HOLD_CHECKED_AT_MS + ACTION_FUNCTION_TIMEOUT_MS, operator: OPERATOR }).deps);

    expect(sendsIssued(sesState)).toBe(1);
    expect((await storedClosure(deps, INCIDENT_ID, HOLD_CHECKED_AT_MS))?.email).toMatchObject({ attempts: 2, failed: false, messageId: 'fixture-message-1' });
  });

  it.each([
    { label: 'the first attempt', priorAttempts: 0 },
    { label: 'the last attempt', priorAttempts: 2 },
  ])('keeps the claim when recording $label as sent throws, so no copy goes out before the timeout and nothing is marked failed (WR-01)', async ({ priorAttempts }) => {
    const { store, sesState } = await closedLaneScripted([]);
    const quiet = buildTestActionRoot({ store, sesState, now: () => HOLD_CHECKED_AT_MS });
    await runActionCycle(quiet.deps);
    if (priorAttempts > 0) {
      const closure = await storedClosure(quiet.deps, INCIDENT_ID, HOLD_CHECKED_AT_MS);
      const spent = { kind: 'closed', attempts: priorAttempts, claimedAtMs: null, sentAtMs: null, messageId: null, failed: false };
      await quiet.deps.ports.decisionStore.updateIfVersion(closureKey(INCIDENT_ID), closure?.version ?? -1, { email: spent }, HOLD_CHECKED_AT_MS);
    }
    const logLines: string[] = [];
    const sendAtMs = HOLD_CHECKED_AT_MS + 60_000;
    const { deps } = buildTestActionRoot({ store, sesState, now: () => sendAtMs, operator: OPERATOR, logSink: (line) => logLines.push(line) });
    const decisionStore = deps.ports.decisionStore;
    const failing = withStore(deps, {
      updateIfVersion: async (key, expectedVersion, attributes, nowMs, expected) => {
        const email = attributes.email as { sentAtMs?: unknown } | undefined;
        if (typeof email?.sentAtMs === 'number') throw throttled();
        return decisionStore.updateIfVersion(key, expectedVersion, attributes, nowMs, expected);
      },
    });

    await runActionCycle(failing);
    expect(sendsIssued(sesState)).toBe(1);
    expect((await storedClosure(deps, INCIDENT_ID, sendAtMs))?.email).toMatchObject({ attempts: priorAttempts + 1, claimedAtMs: sendAtMs, sentAtMs: null, failed: false });
    expect(loggedEvents(logLines, 'email-attempt-failed')).toEqual([]);
    expect(loggedEvents(logLines, 'email-failed')).toEqual([]);

    await runActionCycle(at(deps, sendAtMs + ACTION_FUNCTION_TIMEOUT_MS - 1));
    expect(sendsIssued(sesState)).toBe(1);
  });

  it('never sends one attempt twice from two runs reaching the closure together', async () => {
    const { store, sesState } = await closedLaneScripted([]);
    await runActionCycle(buildTestActionRoot({ store, sesState, now: () => HOLD_CHECKED_AT_MS }).deps);
    const roots = [0, 1].map(() => buildTestActionRoot({ store, sesState, now: () => HOLD_CHECKED_AT_MS + 60_000, operator: OPERATOR, yieldBetweenOperations: true }).deps);

    await Promise.all(roots.map((deps) => runActionCycle(deps)));

    expect(sendsIssued(sesState)).toBe(1);
    expect((await storedClosure(buildTestActionRoot({ store, now: () => HOLD_CHECKED_AT_MS }).deps, INCIDENT_ID, HOLD_CHECKED_AT_MS))?.email?.attempts).toBe(1);
  });
});

describe('concurrent runs send one email per incident (R4)', () => {
  it('leaves one would-send line across 8 roots run together for one incident, and a ninth run sends nothing (AC-9, email half)', async () => {
    const { store } = await seeded(decidingRuntime, [RECEIPT_BATCH]);
    const sesState = createFixtureSesState();
    const dryRunLines: string[] = [];
    const rootAt = (nowMs: number, yieldBetweenOperations: boolean): ActionDeps =>
      buildTestActionRoot({ store, sesState, now: () => nowMs, operator: OPERATOR, dryRunSink: (line) => dryRunLines.push(line), yieldBetweenOperations }).deps;

    await Promise.all(Array.from({ length: 8 }, () => runActionCycle(rootAt(ACT_MS, true))));
    expect(sendLinesOf(dryRunLines)).toHaveLength(1);
    await runActionCycle(rootAt(ACT_MS + 60_000, false));

    expect(sendLinesOf(dryRunLines)).toHaveLength(1);
  });

  it('sends one email when two hold checks race on one paused closure (AC-E6, email half)', async () => {
    const { store, sesState } = await pausedAtT();
    const dryRunLines: string[] = [];
    const roots = [0, 1].map(
      () => buildTestActionRoot({ store, sesState, now: () => HOLD_CHECK_MS, operator: OPERATOR, dryRunSink: (line) => dryRunLines.push(line), yieldBetweenOperations: true }).deps,
    );

    await Promise.all(roots.map((deps) => runActionCycle(deps)));

    expect(sendLinesOf(dryRunLines)).toHaveLength(1);
    expect(sendsIssued(sesState)).toBe(1);
  });
});

// The subject goes in with the body: the word rule binds the whole email.
async function storedEmailOf(deps: ActionDeps, incidentId: string, nowMs: number): Promise<EmailOfClosure[]> {
  const { closure, email } = await renderedFromStore(deps, incidentId, nowMs);
  return closure === undefined || email === undefined ? [] : [{ kind: email.kind, text: `${email.subject}\n\n${email.text}`, closure }];
}

describe('closed appears only in a closed-path email a passed hold check backs (AC-6, email half)', () => {
  it('finds no violation over the closed, not-holding and unknown emails, and reports a not-holding closure given the closed template', async () => {
    const closed = await closedEmailRun();
    const notHolding = await pausedAtT();
    await notHolding.deps.ports.eventStore.putIfAbsent(sendRecordAt(BULK, HOLD_END_MS + 1, 'after-hold'));
    const notHoldingRun = emailRoot({ store: notHolding.store, sesState: notHolding.sesState, now: () => HOLD_CHECK_MS });
    await runActionCycle(notHoldingRun.deps);
    const unknown = await seeded(decidingRuntime, [RECEIPT_BATCH]);
    const unknownRun = emailRoot({ store: unknown.store, now: () => ACT_MS });
    await runActionCycle(unknownRun.deps);

    const emails = [
      ...(await storedEmailOf(closed.deps, INCIDENT_ID, HOLD_CHECKED_AT_MS)),
      ...(await storedEmailOf(notHoldingRun.deps, INCIDENT_ID, HOLD_CHECK_MS)),
      ...(await storedEmailOf(unknownRun.deps, RECEIPT_INCIDENT_ID, ACT_MS)),
    ];
    expect(emails.map((email) => email.kind).sort()).toEqual(['closed', 'not-confirmed', 'unknown']);
    const logLines = [...closed.logLines, ...notHoldingRun.logLines, ...unknownRun.logLines];
    expect(closedWordViolations({ closures: emails.map((email) => email.closure), logLines, emails })).toEqual([]);
    const closedText = emails.find((email) => email.kind === 'closed')?.text ?? '';
    const notHoldingClosure = emails.find((email) => email.kind === 'not-confirmed')?.closure;
    if (notHoldingClosure === undefined) throw new Error('no not-holding closure was stored');
    expect(closedWordViolations({ closures: [], logLines: [], emails: [{ kind: 'closed', text: closedText, closure: notHoldingClosure }] })).toHaveLength(1);
  });

  it('keeps every closure and log line of the email runs free of a lane ratio called the account rate (AC-P8)', async () => {
    const closed = await closedEmailRun();
    const closure = await storedClosure(closed.deps, INCIDENT_ID, HOLD_CHECKED_AT_MS);
    for (const text of [JSON.stringify(closure), ...closed.logLines, ...closed.requests.map((request) => request.text)]) {
      expect(text).not.toMatch(/SES bounce rate|SES complaint rate|your bounce rate/i);
      expect(text).not.toMatch(/reply with|reply to this|send us/i);
    }
  });
});

describe('the model paragraph and its machine-readable mark reach the send (D-113, D-114)', () => {
  it('sends the closed email with the stored paragraph under its label and the one marker header', async () => {
    const run = await closedEmailRun();
    const request = run.requests[0];
    const [sendLine] = sendLinesOf(run.dryRunLines);

    expect(request?.headers?.length).toBe(1);
    expect(request?.headers).toEqual([MODEL_TEXT_MARKER_HEADER]);
    expect(request?.text.split(MODEL_PARAGRAPH_LABEL)).toHaveLength(2);
    expect(sendLine).toContain(`"headers":["${MODEL_TEXT_MARKER_HEADER.name}"]`);
    expect(sendLine).not.toContain(MODEL_TEXT_MARKER_HEADER.value);
  });

  it('sends a template-only email with no header at all', async () => {
    const { store } = await seeded(failingRuntime);
    const run = emailRoot({ store, now: () => ACT_MS });
    await plantDecision(run.deps, INCIDENT_ID, { outcome: 'unknown', reason: 'cap-reached', items: ['incident'] }, NOW_MS);

    await runActionCycle(run.deps);

    expect(run.requests).toHaveLength(1);
    expect(Object.hasOwn(run.requests[0] ?? {}, 'headers')).toBe(false);
    expect(run.requests[0]?.text).not.toContain(MODEL_PARAGRAPH_LABEL);
    expect(sendLinesOf(run.dryRunLines)[0]).not.toContain('"headers"');
  });
});

// The send resolved to its dry-run recorder, as in a deployed run with the switch unset; the recorder
// here answers as the real one does and counts the would-send lines.
function withDryRunSend(deps: ActionDeps, wouldSend: SendEmailRequest[]): ActionDeps {
  const sendEmail = async (request: SendEmailRequest): Promise<{ messageId: string }> => {
    wouldSend.push(request);
    return { messageId: DRY_RUN_MESSAGE_ID };
  };
  const ses = deps.kinds.ses ?? {};
  return { ...deps, ports: { ...deps.ports, ses: { ...deps.ports.ses, sendEmail } }, kinds: { ...deps.kinds, ses: { ...ses, sendEmail: 'dry-run' } } };
}

describe('a send that resolved dry-run is never recorded as sent (WR-02)', () => {
  it('writes the would-send line, stores no email on the closure, logs email-dry-run, and mails once the send is live', async () => {
    const { store } = await seeded(decidingRuntime, [RECEIPT_BATCH]);
    const run = emailRoot({ store, now: () => ACT_MS });
    const wouldSend: SendEmailRequest[] = [];

    await runActionCycle(withDryRunSend(run.deps, wouldSend));

    expect(wouldSend).toHaveLength(1);
    expect((await storedClosure(run.deps, RECEIPT_INCIDENT_ID, ACT_MS))?.email).toBeNull();
    expect(loggedEvents(run.logLines, 'email-sent')).toEqual([]);
    expect(loggedEvents(run.logLines, 'email-dry-run')).toEqual([{ event: 'email-dry-run', level: 'info', incidentId: RECEIPT_INCIDENT_ID }]);
    expect(run.logLines.filter((line) => line.includes(DRY_RUN_MESSAGE_ID))).toEqual([]);

    await runActionCycle(at(run.deps, ACT_MS + 60_000));
    expect(run.requests).toHaveLength(1);
    expect((await storedClosure(run.deps, RECEIPT_INCIDENT_ID, ACT_MS))?.email).toMatchObject({ attempts: 1, messageId: 'fixture-message-1' });
  });
});

function everyKindIsFixture(deps: ActionDeps): boolean {
  return Object.values(deps.kinds).every((row) => Object.values(row).every((kind) => kind === 'fixture'));
}

describe('end to end on fixtures, a close and an unknown each end in one email (AC-25)', () => {
  it('pauses on a stored close, writes closed past the boundary and would-sends exactly one closed-path email', async () => {
    const store = createFixtureTableState();
    const sesState = createFixtureSesState();
    const dryRunLines: string[] = [];
    await seedIncidents({ store, runtime: closeRuntime, scenarios: [BAD_BATCH], nowMs: NOW_MS });
    const pausing = emailRoot({ store, sesState, now: () => PAUSED_AT_MS, dryRunSink: (line) => dryRunLines.push(line) });
    await runActionCycle(pausing.deps);
    expect((await storedClosure(pausing.deps, INCIDENT_ID, PAUSED_AT_MS))?.outcome).toBe('paused');

    const checking = emailRoot({ store, sesState, now: () => HOLD_CHECKED_AT_MS, dryRunSink: (line) => dryRunLines.push(line) });
    await runActionCycle(checking.deps);

    expect((await storedClosure(checking.deps, INCIDENT_ID, HOLD_CHECKED_AT_MS))?.outcome).toBe('closed');
    expect(sendLinesOf(dryRunLines)).toHaveLength(1);
    expect([...pausing.requests, ...checking.requests].map((request) => request.subject)).toEqual([`[Fothering] ${BULK} closed: sending paused and holding`]);
    expect(sesState.calls.filter((call) => call.startsWith('put-issued') && call.endsWith(':true'))).toEqual([]);
    expect(everyKindIsFixture(checking.deps)).toBe(true);
  });

  it('ends the paired unknown fixture with one unknown-path email and no pause', async () => {
    const { store } = await seeded(decidingRuntime, [RECEIPT_BATCH]);
    const run = emailRoot({ store, now: () => ACT_MS });

    await runActionCycle(run.deps);

    expect(sendLinesOf(run.dryRunLines)).toHaveLength(1);
    expect(run.requests.map((request) => request.subject)).toEqual([`[Fothering] Spike on ${TRANSACTIONAL}: nothing was paused`]);
    expect(putsOf(run.sesState)).toEqual([]);
    expect(everyKindIsFixture(run.deps)).toBe(true);
  });
});

// A store or event-store fault the live adapters rethrow, named as DynamoDB names a throttled request.
function throttled(): Error {
  return Object.assign(new Error('the fixture was scripted to fail this call'), { name: 'ThrottlingException' });
}

function getItemThrowsOnce(deps: ActionDeps, key: { pk: string; sk: string }, always = false): ActionDeps {
  const store = deps.ports.decisionStore;
  let thrown = false;
  return withStore(deps, {
    getItem: async (read, nowMs) => {
      if ((always || !thrown) && read.pk === key.pk && read.sk === key.sk) {
        thrown = true;
        throw throttled();
      }
      return store.getItem(read, nowMs);
    },
  });
}

describe('one failing unit leaves the rest of the run going (WR-06)', () => {
  it('pauses fothering-bulk when the first read of the fothering-transactional marker throws, and logs act-failed for that lane', async () => {
    const { root } = await seeded();
    const logLines: string[] = [];
    const { deps, sesState } = root({ logSink: (line) => logLines.push(line) });

    await runActionCycle(getItemThrowsOnce(deps, incidentLaneKey(TRANSACTIONAL)));

    expect(putsOf(sesState)).toEqual(['put-issued:fothering-bulk:false']);
    expect((await storedClosure(deps, INCIDENT_ID, ACT_MS))?.outcome).toBe('paused');
    expect(loggedEvents(logLines, 'act-failed')).toEqual([{ event: 'act-failed', level: 'error', configurationSet: TRANSACTIONAL, errorName: 'ThrottlingException' }]);
  });

  it('still hold-checks the incident a marker reached when a pause pointer read throws, and logs pause-pointer-read-failed', async () => {
    const lane = await pausedAtT();
    const logLines: string[] = [];
    const { deps } = lane.root({ sesState: lane.sesState, now: () => HOLD_CHECK_MS, logSink: (line) => logLines.push(line) });

    await runActionCycle(getItemThrowsOnce(deps, incidentPauseKey(BULK), true));

    expect((await storedClosure(deps, INCIDENT_ID, HOLD_CHECK_MS))?.outcome).toBe('closed');
    expect(loggedEvents(logLines, 'pause-pointer-read-failed')).toEqual([
      { event: 'pause-pointer-read-failed', level: 'error', configurationSet: BULK, errorName: 'ThrottlingException' },
    ]);
  });

  it('logs hold-check-failed when the hold-check fold throws, keeps the closure paused and checks it on the next run', async () => {
    const lane = await pausedAtT();
    const logLines: string[] = [];
    const { deps } = lane.root({ sesState: lane.sesState, now: () => HOLD_CHECK_MS, logSink: (line) => logLines.push(line) });
    const failing: ActionDeps = {
      ...deps,
      ports: {
        ...deps.ports,
        eventStore: {
          ...deps.ports.eventStore,
          foldLane: async () => {
            throw throttled();
          },
        },
      },
    };

    await runActionCycle(failing);
    expect(loggedEvents(logLines, 'hold-check-failed')).toEqual([{ event: 'hold-check-failed', level: 'error', incidentId: INCIDENT_ID, errorName: 'ThrottlingException' }]);
    expect((await storedClosure(deps, INCIDENT_ID, HOLD_CHECK_MS))?.outcome).toBe('paused');

    await runActionCycle(at(deps, HOLD_CHECK_MS + 60_000));
    expect((await storedClosure(deps, INCIDENT_ID, HOLD_CHECK_MS))?.outcome).toBe('closed');
  });

  it('logs email-step-failed when the email claim write throws, and the next run sends the email', async () => {
    const { store, sesState } = await closedLaneScripted([]);
    const logLines: string[] = [];
    const { deps } = buildTestActionRoot({ store, sesState, now: () => HOLD_CHECKED_AT_MS, operator: OPERATOR, logSink: (line) => logLines.push(line) });
    const decisionStore = deps.ports.decisionStore;
    let thrown = false;
    const failing = withStore(deps, {
      updateIfVersion: async (key, expectedVersion, attributes, nowMs, expected) => {
        if (!thrown && Object.hasOwn(attributes, 'email')) {
          thrown = true;
          throw throttled();
        }
        return decisionStore.updateIfVersion(key, expectedVersion, attributes, nowMs, expected);
      },
    });

    await runActionCycle(failing);
    expect(sendsIssued(sesState)).toBe(0);
    expect(loggedEvents(logLines, 'email-step-failed')).toEqual([{ event: 'email-step-failed', level: 'error', incidentId: INCIDENT_ID, errorName: 'ThrottlingException' }]);
    expect((await storedClosure(deps, INCIDENT_ID, HOLD_CHECKED_AT_MS))?.outcome).toBe('closed');

    await runActionCycle(at(deps, HOLD_CHECKED_AT_MS + 60_000));
    expect(sendsIssued(sesState)).toBe(1);
  });
});
