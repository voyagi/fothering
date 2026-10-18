import type { RuntimeResult } from '@fothering/core/agent-answer';
import { bucketStartMs } from '@fothering/core/buckets';
import { closureKey, parseClosure, type Closure } from '@fothering/core/closure';
import { evidenceRecordSchema, incidentIdFor, incidentItemKey, incidentLaneKey, type EvidenceRecord } from '@fothering/core/evidence-record';
import { markerOf, openIncident, stateOf, storedStateOf, type IncidentStatus } from '@fothering/core/incident';
import { parseLaneMap, type LaneMap } from '@fothering/core/lanes';
import type { LogSink } from '@fothering/core/log';
import { PINNED_MODEL_VALUES } from '@fothering/core/model-values';
import { expiresAtFor } from '@fothering/core/records';
import { scenarioRecords, type LaneScenario } from '@fothering/core/test/event-arbitraries';
import type { BucketWindow } from '@fothering/core/window-fold';
import { TEST_ADDRESS_KEY_SET } from '@fothering/providers/fixtures/ingest-ports';
import { createFixtureSesState } from '@fothering/providers/fixtures/later-ports';
import type { DecisionStoreItem, DryRunSink, FixtureSesState, FixtureTableState, Recording } from '@fothering/providers/port-types';
import { buildActionRoot, type ActionDeps } from '../action/root.js';
import { runDetectionCycle, type DetectionCycleSummary } from '../detect/detect.js';
import { buildDetectRoot, type DetectDeps } from '../detect/root.js';
import lanesJson from '../../../../lanes.json' with { type: 'json' };
import completeSesConfig from '../../../providers/src/fixtures/ses-config/complete.json' with { type: 'json' };

// Incidents for the action, reopen and email tests come from the real detection cycle over a shared
// fixture table, so the items they read are the items detection writes and no hand-built item can drift.

export const LANES: LaneMap = parseLaneMap(lanesJson);
export const BULK = 'fothering-bulk';
export const TRANSACTIONAL = 'fothering-transactional';
export const NOW_MS = Date.UTC(2026, 9, 11, 12, 2, 0);
export const COMPLETE_SES_RECORDINGS = completeSesConfig.recordings as readonly Recording[];

const RUNTIME_ARN = 'arn:aws:bedrock-agentcore:eu-central-1:000000000000:runtime/fixture-runtime';
const USAGE = { inputTokens: 1_850, outputTokens: 96, totalTokens: 1_946 };
const CLOSE_EXPLANATION = 'One import batch holds the permanent bounces on this lane, and pausing this lane stops it.';
const UNKNOWN_EXPLANATION = 'The evidence on this lane does not settle one cause, so the operator is asked what to do.';

export const BAD_BATCH: LaneScenario = {
  configurationSet: BULK,
  streamTag: 'newsletter',
  callerIdentity: 'bulk-sender',
  fromDomain: 'news.example.com',
  groups: [
    { bucketOffset: 0, count: 40, batch: 'import-0915', permanentBounces: 15 },
    { bucketOffset: 1, count: 160, batch: 'import-0901' },
  ],
};

export const RECEIPT_BATCH: LaneScenario = {
  configurationSet: TRANSACTIONAL,
  streamTag: 'receipts',
  callerIdentity: 'receipt-sender',
  fromDomain: 'news.example.com',
  groups: [
    { bucketOffset: 0, count: 40, batch: 'order-0915', permanentBounces: 15 },
    { bucketOffset: 1, count: 160, batch: 'order-0901' },
  ],
};

// The lookups a news.example.com lane plans with the complete SES identities: its DMARC record and the
// organizational one, the SPF record on the custom MAIL FROM domain, and the MX of the receiving domain.
export const NEWS_DNS_RECORDINGS: readonly Recording[] = [
  { operation: 'dns.resolveTxt', request: '_dmarc.news.example.com', response: { kind: 'missing' } },
  { operation: 'dns.resolveTxt', request: '_dmarc.example.com', response: { kind: 'records', records: ['v=DMARC1; p=none'] } },
  { operation: 'dns.resolveTxt', request: 'bounce.example.com', response: { kind: 'records', records: ['v=spf1 include:amazonses.com ~all'] } },
  { operation: 'dns.resolveMx', request: 'example.com', response: { kind: 'missing' } },
];

function answered(answer: unknown): RuntimeResult {
  return { status: 'answered', answer, pinned: PINNED_MODEL_VALUES, promptSha256: 'a'.repeat(64), usage: USAGE, modelCalls: 1 };
}

function approvedIdOf(payload: unknown): string | undefined {
  return (payload as EvidenceRecord).approvedOptions[0]?.optionId;
}

/** Closes on the record's one approved option. */
export const closeRuntime = async (payload: unknown): Promise<unknown> =>
  answered({ decision: 'close', optionId: approvedIdOf(payload), explanation: CLOSE_EXPLANATION });

/** Closes where the record approves an option and answers unknown where it approves none. */
export const decidingRuntime = async (payload: unknown): Promise<unknown> =>
  approvedIdOf(payload) === undefined ? answered({ decision: 'unknown', explanation: UNKNOWN_EXPLANATION }) : closeRuntime(payload);

export interface SeedInput {
  store: FixtureTableState;
  runtime: (payload: unknown) => Promise<unknown>;
  scenarios: readonly LaneScenario[];
  nowMs: number;
  laneMap?: LaneMap;
  /** The agentCore row of a deployed root with the switch unset, so detection stores no DECISION (agent-dry-run). */
  agentDryRun?: boolean;
}

// A deployed root builds no live client until a port method runs, and the dry-run recorder runs none.
function withDryRunAgent(deps: DetectDeps): DetectDeps {
  const deployed = buildDetectRoot({ runtimeContext: 'deployed', switchValue: undefined, dryRunSink: () => {} });
  const agentCore = deployed.kinds.agentCore;
  const kinds = agentCore === undefined ? deps.kinds : { ...deps.kinds, agentCore };
  return { ...deps, ports: { ...deps.ports, agentCore: deployed.ports.agentCore }, kinds };
}

/** Inserts each scenario's records and runs one detection cycle over the shared table. */
export async function seedIncidents(input: SeedInput): Promise<DetectionCycleSummary> {
  const laneMap = input.laneMap ?? LANES;
  const deps = buildDetectRoot({
    runtimeContext: 'test',
    switchValue: undefined,
    fixtures: { store: input.store, recordings: { ses: COMPLETE_SES_RECORDINGS, dns: NEWS_DNS_RECORDINGS }, agentRuntime: input.runtime },
    liveConfig: { agentRuntimeArn: RUNTIME_ARN },
    now: () => input.nowMs,
    wait: async () => {},
    laneMap,
  });
  for (const scenario of input.scenarios) {
    for (const record of scenarioRecords(scenario, input.nowMs, laneMap, TEST_ADDRESS_KEY_SET)) await deps.ports.eventStore.putIfAbsent(record);
  }
  return runDetectionCycle(input.agentDryRun === true ? withDryRunAgent(deps) : deps);
}

export interface TestActionRootInput {
  store: FixtureTableState;
  sesState?: FixtureSesState;
  now: () => number;
  logSink?: LogSink;
  dryRunSink?: DryRunSink;
  laneMap?: LaneMap;
  recordings?: readonly Recording[];
}

export interface TestActionRoot {
  deps: ActionDeps;
  sesState: FixtureSesState;
  /** Every wait the run asked for, in order, in milliseconds. */
  waits: number[];
}

export function buildTestActionRoot(input: TestActionRootInput): TestActionRoot {
  const sesState = input.sesState ?? createFixtureSesState();
  const waits: number[] = [];
  const deps = buildActionRoot({
    runtimeContext: 'test',
    switchValue: undefined,
    fixtures: { store: input.store, sesState, recordings: { ses: input.recordings ?? COMPLETE_SES_RECORDINGS } },
    now: input.now,
    wait: async (ms) => {
      waits.push(ms);
    },
    ...(input.logSink === undefined ? {} : { logSink: input.logSink }),
    ...(input.dryRunSink === undefined ? {} : { dryRunSink: input.dryRunSink }),
    ...(input.laneMap === undefined ? {} : { laneMap: input.laneMap }),
  });
  return { deps, sesState, waits };
}

export async function storedClosure(deps: ActionDeps, incidentId: string, nowMs: number): Promise<Closure | undefined> {
  return parseClosure(await deps.ports.decisionStore.getItem(closureKey(incidentId), nowMs));
}

export function incidentIdOf(configurationSet: string, nowMs: number): string {
  return incidentIdFor(configurationSet, bucketStartMs(nowMs));
}

// Planted variants go in through the decision store port, so they pass the same key and value checks
// a real write does.
export async function plantClosure(deps: ActionDeps, item: Closure, nowMs: number): Promise<void> {
  if ((await deps.ports.decisionStore.putIfAbsent(item, nowMs)) !== 'written') throw new Error('a closure is already stored for that incident');
}

export async function plantDecision(deps: ActionDeps, incidentId: string, attributes: Readonly<Record<string, unknown>>, nowMs: number): Promise<void> {
  const item = { ...incidentItemKey(incidentId, 'DECISION'), attempt: 1, decidedAtMs: nowMs, expiresAt: expiresAtFor(nowMs), ...attributes };
  if ((await deps.ports.decisionStore.putIfAbsent(item, nowMs)) !== 'written') throw new Error('a DECISION is already stored for that incident');
}

async function plantItem(deps: ActionDeps, item: DecisionStoreItem, nowMs: number): Promise<void> {
  if ((await deps.ports.decisionStore.putIfAbsent(item, nowMs)) !== 'written') throw new Error(`an item is already stored at ${item.pk} / ${item.sk}`);
}

export interface PlantIncidentInput {
  configurationSet: string;
  incidentId: string;
  /** Typed loosely on purpose, so a test can plant the malformed windows AC-E10 names. */
  openingWindow: BucketWindow;
  markerStatus?: IncidentStatus;
  stateStatus?: IncidentStatus;
  record?: EvidenceRecord;
  decision?: Readonly<Record<string, unknown>>;
  nowMs: number;
  omit?: readonly ('marker' | 'STATE')[];
}

/** An incident on a lane in the shapes detection writes: marker, STATE and, when given, EVIDENCE and DECISION. */
export async function plantIncident(deps: ActionDeps, input: PlantIncidentInput): Promise<void> {
  const { configurationSet, incidentId, nowMs } = input;
  const expiresAt = expiresAtFor(nowMs);
  const omitted = new Set(input.omit ?? []);
  if (!omitted.has('marker')) {
    await plantItem(deps, { ...incidentLaneKey(configurationSet), incidentId, status: input.markerStatus ?? 'open', version: 1, expiresAt }, nowMs);
  }
  if (!omitted.has('STATE')) {
    const opened = { ...openIncident(configurationSet, nowMs, input.openingWindow), incidentId, status: input.stateStatus ?? 'open' };
    await plantItem(deps, { ...incidentItemKey(incidentId, 'STATE'), version: opened.version, expiresAt, state: storedStateOf(opened) }, nowMs);
  }
  if (input.record !== undefined) await plantItem(deps, { ...incidentItemKey(incidentId, 'EVIDENCE'), expiresAt, record: input.record }, nowMs);
  if (input.decision !== undefined) await plantDecision(deps, incidentId, input.decision, nowMs);
}

/** Detection opening a newer incident on the lane: the marker names it from now on. */
export async function moveMarker(deps: ActionDeps, configurationSet: string, toIncidentId: string, nowMs: number): Promise<void> {
  const store = deps.ports.decisionStore;
  const marker = markerOf(await store.getItem(incidentLaneKey(configurationSet), nowMs));
  if (marker === undefined) throw new Error(`no marker is stored for ${configurationSet}`);
  const result = await store.updateIfVersion(incidentLaneKey(configurationSet), marker.version, { incidentId: toIncidentId, status: 'open' }, nowMs);
  if (result !== 'updated') throw new Error(`the marker of ${configurationSet} moved while the test moved it`);
}

/** Detection ending the incident's lifecycle. */
export async function closeState(deps: ActionDeps, incidentId: string, nowMs: number): Promise<void> {
  const store = deps.ports.decisionStore;
  const key = incidentItemKey(incidentId, 'STATE');
  const state = stateOf(await store.getItem(key, nowMs));
  if (state === undefined) throw new Error(`no STATE is stored for incident ${incidentId}`);
  const result = await store.updateIfVersion(key, state.version, { state: storedStateOf({ ...state, status: 'closed' }) }, nowMs);
  if (result !== 'updated') throw new Error(`the STATE of ${incidentId} moved while the test closed it`);
}

export async function storedRecord(deps: ActionDeps, incidentId: string, nowMs: number): Promise<EvidenceRecord> {
  const item = await deps.ports.decisionStore.getItem(incidentItemKey(incidentId, 'EVIDENCE'), nowMs);
  return evidenceRecordSchema.parse(item?.record);
}
