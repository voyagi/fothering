import {
  classifyRuntimeOutcome,
  runtimeResultSchema,
  type AgentAnswer,
  type AgentUnavailableReason,
  type RuntimeOutcome,
  type RuntimeResult,
} from '@fothering/core/agent-answer';
import { bucketStartMs } from '@fothering/core/buckets';
import { checkCloseability, type SesConfigurationFacts } from '@fothering/core/closeability';
import { reserveInvocation } from '@fothering/core/counters';
import { assembleEvidenceRecord, decideCycle, type CycleDecision, type LaneAnalysis } from '@fothering/core/decision';
import {
  evidenceRecordSchema,
  incidentIdFor,
  incidentItemKey,
  incidentLaneKey,
  type EvidenceRecord,
} from '@fothering/core/evidence-record';
import { buildProviderRows, buildTagRows } from '@fothering/core/evidence-rows';
import { openIncident, stepIncident, windowsNeedingFinalVerdict, type FinalVerdict, type IncidentState } from '@fothering/core/incident';
import type { LaneEntry } from '@fothering/core/lanes';
import type { LogEntry } from '@fothering/core/log';
import { MODEL_VALUES } from '@fothering/core/model-values';
import { RETENTION_SECONDS } from '@fothering/core/records';
import { laneSpikeVerdict, type LaneSpikeVerdict, type LaneVerdict } from '@fothering/core/verdicts';
import {
  createWindowFold,
  spikeWindowFor,
  summarizeWindow,
  type BucketWindow,
  type WindowFoldState,
  type WindowSummary,
} from '@fothering/core/window-fold';
import { requireLiveConfig, type DecisionStoreItem, type SesReadPort } from '@fothering/providers/port-types';
import { readSesFacts } from '@fothering/providers/ses-facts';
import type { DetectDeps } from './root.js';

type CycleResult = AgentAnswer['decision'] | AgentUnavailableReason;

interface IncidentRef {
  configurationSet: string;
  incidentId: string;
}

export interface DetectionCycleSummary {
  lanes: { configurationSet: string; verdict: LaneVerdict }[];
  incidentsOpened: number;
  invocations: number;
  sesReads: number;
  dnsLookups: number;
  /** Every incident whose lane marker reads open at the end of the cycle, in lane-map order. */
  incidents: IncidentRef[];
  /** Steps that threw and were contained, one per failure line logged. */
  failures: number;
  outcomes: { incidentId: string; result: CycleResult }[];
}

interface FoldedLane {
  lane: LaneEntry;
  summary: WindowSummary;
  spike: LaneSpikeVerdict;
}

interface Marker {
  incidentId: string;
  status: 'open' | 'closed';
  version: number;
}

/** What one cycle knows and has done for one lane; each step reads and moves only its own lane. */
interface LaneView {
  folded: FoldedLane;
  marker: Marker | undefined;
  stateMissing: boolean;
  evidenceAtStart: boolean;
  evidenceWritten: boolean;
  claim: 'won' | 'lost' | undefined;
  /** A step for this lane threw, so the rest of the cycle leaves the lane alone. */
  failed: boolean;
}

interface CycleCounts {
  sesReads: number;
  dnsLookups: number;
  invocations: number;
  failures: number;
}

type StoredState = Omit<IncidentState, 'version'>;

type FailureEvent = 'lifecycle-failed' | 'opening-failed' | 'agent-attempt-failed';

const FIRST_ATTEMPT = 1;
const RUNTIME_ARN_VARIABLE = 'FOTHERING_AGENT_RUNTIME_ARN';

function expiresAtFor(nowMs: number): number {
  return Math.floor(nowMs / 1000) + RETENTION_SECONDS;
}

// Only the error's name reaches the log: a message can carry a request, an address or model text.
function logFailure(
  deps: DetectDeps,
  counts: CycleCounts,
  event: FailureEvent,
  incident: { configurationSet: string; incidentId: string | undefined },
  error: unknown,
): void {
  counts.failures += 1;
  deps.log.error({
    event,
    configurationSet: incident.configurationSet,
    ...(incident.incidentId === undefined ? {} : { incidentId: incident.incidentId }),
    errorName: error instanceof Error ? error.name : 'UnknownError',
  });
}

function foldWindow(deps: DetectDeps, configurationSet: string, window: BucketWindow, nowMs: number): Promise<WindowFoldState> {
  const fold = createWindowFold({ lane: configurationSet, window, nowMs });
  return deps.ports.eventStore.foldLane(configurationSet, window.fromBucketMs, window.toBucketMs, nowMs, fold);
}

// Every lane read goes through foldLane, so a window's memory is the fold's state and never the
// window's records (D-43); queryLane is not a detection read.
async function foldLanes(deps: DetectDeps, nowMs: number): Promise<FoldedLane[]> {
  const window = spikeWindowFor(nowMs);
  const folded: FoldedLane[] = [];
  for (const lane of deps.laneMap.lanes) {
    const summary = summarizeWindow(await foldWindow(deps, lane.configurationSet, window, nowMs));
    folded.push({ lane, summary, spike: laneSpikeVerdict(summary.totals) });
  }
  return folded;
}

function markerOf(item: DecisionStoreItem | undefined): Marker | undefined {
  if (item === undefined) return undefined;
  const { incidentId, status, version } = item;
  if (typeof incidentId !== 'string' || (status !== 'open' && status !== 'closed') || typeof version !== 'number') return undefined;
  return { incidentId, status, version };
}

// The item's own version is the state's version, so updateIfVersion and stepIncident count alike.
function storedStateOf(state: IncidentState): StoredState {
  return {
    incidentId: state.incidentId,
    configurationSet: state.configurationSet,
    status: state.status,
    openingWindow: state.openingWindow,
    openingFinalized: state.openingFinalized,
    pendingRecovery: state.pendingRecovery,
    falseSpikes: state.falseSpikes,
    falseRecoveries: state.falseRecoveries,
  };
}

function stateOf(item: DecisionStoreItem | undefined): IncidentState | undefined {
  if (item === undefined || typeof item.version !== 'number') return undefined;
  const stored = item.state as Partial<StoredState> | undefined;
  if (stored?.status !== 'open' && stored?.status !== 'closed') return undefined;
  return { ...(stored as StoredState), version: item.version };
}

async function readMarker(deps: DetectDeps, configurationSet: string, nowMs: number): Promise<Marker | undefined> {
  return markerOf(await deps.ports.decisionStore.getItem(incidentLaneKey(configurationSet), nowMs));
}

async function finalVerdictsOf(deps: DetectDeps, state: IncidentState, nowMs: number): Promise<FinalVerdict[]> {
  const verdicts: FinalVerdict[] = [];
  for (const window of windowsNeedingFinalVerdict(state, nowMs)) {
    const summary = summarizeWindow(await foldWindow(deps, state.configurationSet, window, nowMs));
    verdicts.push({ window, verdict: laneSpikeVerdict(summary.totals).verdict });
  }
  return verdicts;
}

// A lost update reads the marker back rather than writing over whatever the other cycle set.
async function closeMarker(deps: DetectDeps, marker: Marker, configurationSet: string, nowMs: number): Promise<Marker | undefined> {
  const attributes = { incidentId: marker.incidentId, status: 'closed' };
  const result = await deps.ports.decisionStore.updateIfVersion(incidentLaneKey(configurationSet), marker.version, attributes, nowMs);
  if (result === 'updated') return { ...marker, status: 'closed', version: marker.version + 1 };
  return readMarker(deps, configurationSet, nowMs);
}

// A state that reads closed with its marker still open is a cycle that died between the two
// updates, so the marker is closed here whether or not this cycle moved the state.
async function stepState(deps: DetectDeps, view: LaneView, marker: Marker, state: IncidentState, nowMs: number): Promise<void> {
  const { lane, summary, spike } = view.folded;
  const finalVerdicts = await finalVerdictsOf(deps, state, nowMs);
  const step = stepIncident(state, { currentVerdict: spike.verdict, currentWindow: summary.window, nowMs, finalVerdicts });
  if (step.state.version !== state.version) {
    const key = incidentItemKey(marker.incidentId, 'STATE');
    const result = await deps.ports.decisionStore.updateIfVersion(key, state.version, { state: storedStateOf(step.state) }, nowMs);
    if (result === 'conflict') return;
    for (const transition of step.transitions) {
      deps.log.info({ event: 'incident-step', configurationSet: lane.configurationSet, incidentId: marker.incidentId, reason: transition });
    }
  }
  if (step.state.status === 'closed') view.marker = await closeMarker(deps, marker, lane.configurationSet, nowMs);
}

/** D-42 step 3, for one lane: read its marker and, while it is open, move the incident's lifecycle. */
async function stepLane(deps: DetectDeps, folded: FoldedLane, nowMs: number, counts: CycleCounts): Promise<LaneView> {
  const view: LaneView = { folded, marker: undefined, stateMissing: false, evidenceAtStart: false, evidenceWritten: false, claim: undefined, failed: false };
  const configurationSet = folded.lane.configurationSet;
  try {
    view.marker = await readMarker(deps, configurationSet, nowMs);
    const marker = view.marker;
    if (marker?.status !== 'open') return view;
    const store = deps.ports.decisionStore;
    view.evidenceAtStart = (await store.getItem(incidentItemKey(marker.incidentId, 'EVIDENCE'), nowMs)) !== undefined;
    const state = stateOf(await store.getItem(incidentItemKey(marker.incidentId, 'STATE'), nowMs));
    if (state === undefined) {
      view.stateMissing = true;
      return view;
    }
    await stepState(deps, view, marker, state, nowMs);
  } catch (error) {
    view.failed = true;
    logFailure(deps, counts, 'lifecycle-failed', { configurationSet, incidentId: view.marker?.incidentId }, error);
  }
  return view;
}

async function claimMarker(deps: DetectDeps, configurationSet: string, previous: Marker | undefined, incidentId: string, nowMs: number): Promise<boolean> {
  const store = deps.ports.decisionStore;
  if (previous === undefined) {
    const item = { ...incidentLaneKey(configurationSet), incidentId, status: 'open', version: 1, expiresAt: expiresAtFor(nowMs) };
    return (await store.putIfAbsent(item)) === 'written';
  }
  return (await store.updateIfVersion(incidentLaneKey(configurationSet), previous.version, { incidentId, status: 'open' }, nowMs)) === 'updated';
}

/**
 * D-53: a spiking lane with no open incident claims its marker before any SES or DNS read, so a cycle
 * that loses the race spends none and writes nothing else for the lane; it takes the winner's id.
 */
async function claimLane(deps: DetectDeps, view: LaneView, nowMs: number, counts: CycleCounts): Promise<void> {
  if (view.failed || view.folded.spike.verdict !== 'spike' || view.marker?.status === 'open') return;
  const configurationSet = view.folded.lane.configurationSet;
  const incidentId = incidentIdFor(configurationSet, bucketStartMs(nowMs));
  try {
    const previous = view.marker;
    if (await claimMarker(deps, configurationSet, previous, incidentId, nowMs)) {
      view.marker = { incidentId, status: 'open', version: (previous?.version ?? 0) + 1 };
      view.claim = 'won';
      view.stateMissing = true;
      return;
    }
    view.claim = 'lost';
    view.marker = await readMarker(deps, configurationSet, nowMs);
  } catch (error) {
    view.failed = true;
    logFailure(deps, counts, 'opening-failed', { configurationSet, incidentId }, error);
  }
}

// Recovery builds the state under the marker's id, never one derived from now (steelman S3).
async function putState(deps: DetectDeps, view: LaneView, nowMs: number, counts: CycleCounts): Promise<void> {
  const marker = view.marker;
  if (view.failed || view.claim === 'lost' || marker?.status !== 'open' || !view.stateMissing) return;
  const { lane, summary } = view.folded;
  try {
    const state: IncidentState = { ...openIncident(lane.configurationSet, nowMs, summary.window), incidentId: marker.incidentId };
    await deps.ports.decisionStore.putIfAbsent({
      ...incidentItemKey(marker.incidentId, 'STATE'),
      expiresAt: expiresAtFor(nowMs),
      version: state.version,
      state: storedStateOf(state),
    });
    view.stateMissing = false;
  } catch (error) {
    view.failed = true;
    logFailure(deps, counts, 'opening-failed', { configurationSet: lane.configurationSet, incidentId: marker.incidentId }, error);
  }
}

// A lane that no longer spikes has no decision to record, so a recovered record waits for a spike.
function needsEvidence(view: LaneView): boolean {
  return (
    !view.failed &&
    view.claim !== 'lost' &&
    view.marker?.status === 'open' &&
    !view.stateMissing &&
    !view.evidenceAtStart &&
    view.folded.spike.verdict === 'spike'
  );
}

function refOf(view: LaneView): IncidentRef {
  return { configurationSet: view.folded.lane.configurationSet, incidentId: view.marker?.incidentId ?? '' };
}

// Only the four reads reach readSesFacts, so the cycle that opens incidents can never pause,
// reopen or send; the count is the summary's proof that a quiet cycle read nothing.
function countedSesReads(ses: SesReadPort, counts: CycleCounts): SesReadPort {
  const counted = <Args extends unknown[], Result>(read: (...args: Args) => Promise<Result>) =>
    (...args: Args): Promise<Result> => {
      counts.sesReads += 1;
      return read(...args);
    };
  return {
    getEmailIdentity: counted((identity: string) => ses.getEmailIdentity(identity)),
    listEmailIdentities: counted(() => ses.listEmailIdentities()),
    listConfigurationSets: counted(() => ses.listConfigurationSets()),
    getConfigurationSetEventDestinations: counted((set: string) => ses.getConfigurationSetEventDestinations(set)),
  };
}

function analysesOf(folded: readonly FoldedLane[], deps: DetectDeps, ses: SesConfigurationFacts): LaneAnalysis[] {
  const observed = new Map(folded.map(({ lane, summary }) => [lane.configurationSet, summary.observed]));
  return folded.map(({ lane, summary, spike }): LaneAnalysis => ({
    lane,
    summary,
    spike,
    rows: [
      ...buildTagRows('batch', summary, spike),
      ...buildTagRows('template', summary, spike),
      ...buildTagRows('campaign', summary, spike),
      ...buildProviderRows(summary, spike, new Map()),
    ],
    configurationRows: [],
    closeability: checkCloseability(lane.configurationSet, { laneMap: deps.laneMap, observed, ses }),
    coverage: 'not-judged',
    bound: summary.dimensionBound ? 'dimension-bound' : null,
  }));
}

/** D-42 step 4's reads: SES once, in a cycle with an incident to open; undefined defers the opening. */
async function openingAnalyses(deps: DetectDeps, folded: readonly FoldedLane[], counts: CycleCounts): Promise<LaneAnalysis[] | undefined> {
  const facts = await readSesFacts(countedSesReads(deps.ports.ses, counts), deps.laneMap, { wait: deps.wait });
  if (!facts.ok) {
    deps.log.info({ event: 'opening-deferred', reason: facts.reason });
    return undefined;
  }
  return analysesOf(folded, deps, facts.facts);
}

interface OpeningDecisions {
  analyses: readonly LaneAnalysis[];
  decisions: ReadonlyMap<string, CycleDecision>;
}

// D-55: the record is written once, conditionally; a racing cycle's earlier write stands.
async function writeLaneEvidence(deps: DetectDeps, view: LaneView, opening: OpeningDecisions, nowMs: number): Promise<boolean> {
  const { configurationSet, incidentId } = refOf(view);
  const analysis = opening.analyses.find((candidate) => candidate.lane.configurationSet === configurationSet);
  const decision = opening.decisions.get(configurationSet);
  if (analysis === undefined || decision === undefined) return false;
  const expiresAt = expiresAtFor(nowMs);
  const record = assembleEvidenceRecord({ incidentId, analysis, decision, analyses: opening.analyses, expiresAt });
  const written = await deps.ports.decisionStore.putIfAbsent({ ...incidentItemKey(incidentId, 'EVIDENCE'), expiresAt, record });
  if (written !== 'written') return false;
  view.evidenceWritten = true;
  deps.log.info({ event: 'incident-opened', configurationSet, incidentId, reason: record.decision.reason });
  return true;
}

async function writeEvidence(deps: DetectDeps, views: readonly LaneView[], nowMs: number, counts: CycleCounts): Promise<number> {
  const needing = views.filter(needsEvidence);
  if (needing.length === 0) return 0;
  let opening: OpeningDecisions;
  try {
    const analyses = await openingAnalyses(deps, views.map((view) => view.folded), counts);
    if (analyses === undefined) return 0;
    opening = { analyses, decisions: decideCycle(analyses, deps.laneMap) };
  } catch (error) {
    for (const view of needing) logFailure(deps, counts, 'opening-failed', refOf(view), error);
    return 0;
  }
  let opened = 0;
  for (const view of needing) {
    try {
      if (await writeLaneEvidence(deps, view, opening, nowMs)) opened += 1;
    } catch (error) {
      logFailure(deps, counts, 'opening-failed', refOf(view), error);
    }
  }
  return opened;
}

// A racing cycle may have written the evidence first, so the agent always explains the stored record.
async function storedRecordOf(deps: DetectDeps, incidentId: string, nowMs: number): Promise<EvidenceRecord | undefined> {
  const item = await deps.ports.decisionStore.getItem(incidentItemKey(incidentId, 'EVIDENCE'), nowMs);
  if (item === undefined) return undefined;
  const parsed = evidenceRecordSchema.safeParse(item.record);
  return parsed.success ? parsed.data : undefined;
}

function runtimeArnOf(deps: DetectDeps): string | undefined {
  try {
    return requireLiveConfig(deps.agentRuntimeArn, RUNTIME_ARN_VARIABLE);
  } catch {
    return undefined;
  }
}

// The thrown error is never read: only whether the cycle's own deadline fired (D-77).
async function invokeRuntime(deps: DetectDeps, runtimeArn: string, record: EvidenceRecord): Promise<RuntimeOutcome> {
  const abortSignal = deps.agentTimeoutSignal(MODEL_VALUES.agentInvocationTimeoutMs);
  try {
    const response = await deps.ports.agentCore.invokeAgentRuntime({
      runtimeArn,
      sessionId: `fothering-${record.incidentId}-a${FIRST_ATTEMPT}`,
      payload: record,
      abortSignal,
    });
    return { kind: 'returned', response };
  } catch {
    return { kind: 'threw', callerAborted: abortSignal.aborted };
  }
}

function parsedResult(outcome: RuntimeOutcome): RuntimeResult | undefined {
  if (outcome.kind !== 'returned') return undefined;
  const parsed = runtimeResultSchema.safeParse(outcome.response);
  return parsed.success ? parsed.data : undefined;
}

// Codes and integers from the parsed result only: a response that failed the schema logs none of them.
function resultFields(result: RuntimeResult | undefined): Pick<LogEntry, 'status' | 'modelCalls' | 'inputTokens' | 'outputTokens'> {
  if (result === undefined) return {};
  if (result.status === 'dry-run') return { status: result.status };
  return { status: result.status, modelCalls: result.modelCalls, inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens };
}

type AnsweredResult = Extract<RuntimeResult, { status: 'answered' }>;

async function storeDecision(deps: DetectDeps, record: EvidenceRecord, answer: AgentAnswer, result: AnsweredResult): Promise<void> {
  const decidedAtMs = deps.now();
  await deps.ports.decisionStore.putIfAbsent({
    ...incidentItemKey(record.incidentId, 'DECISION'),
    outcome: answer.decision,
    ...(answer.decision === 'close' ? { optionId: answer.optionId } : {}),
    explanation: answer.explanation,
    pinned: result.pinned,
    promptSha256: result.promptSha256,
    usage: result.usage,
    modelCalls: result.modelCalls,
    attempt: FIRST_ATTEMPT,
    decidedAtMs,
    expiresAt: Math.floor(decidedAtMs / 1000) + RETENTION_SECONDS,
  });
}

// D-42 step 5. The ARN is checked before the reservation, and the reservation must succeed before
// the call, so a deployment missing its ARN or past a cap spends nothing (T-02-41).
async function attemptAgent(deps: DetectDeps, record: EvidenceRecord, nowMs: number, counts: CycleCounts): Promise<CycleResult> {
  const incident = { configurationSet: record.lane.configurationSet, incidentId: record.incidentId, attempt: FIRST_ATTEMPT };
  const runtimeArn = runtimeArnOf(deps);
  if (runtimeArn === undefined) {
    deps.log.error({ event: 'agent-unavailable', ...incident, reason: 'agent-error', errorName: 'LiveConfigMissingError' });
    return 'agent-error';
  }
  const reservation = await reserveInvocation(deps.ports.decisionStore, { incidentId: record.incidentId, nowMs });
  if (!reservation.ok) {
    const reason = reservation.reason === 'cap' ? 'cap-reached' : 'agent-error';
    deps.log.info({ event: 'agent-unavailable', ...incident, reason });
    return reason;
  }
  counts.invocations += 1;
  const outcome = await invokeRuntime(deps, runtimeArn, record);
  const result = parsedResult(outcome);
  const classified = classifyRuntimeOutcome(outcome, { record, laneMapSets: deps.laneMap.lanes.map((lane) => lane.configurationSet) });
  if (classified.kind === 'unavailable' || result?.status !== 'answered') {
    const reason = classified.kind === 'unavailable' ? classified.reason : 'response-invalid';
    const check = classified.kind === 'unavailable' ? classified.check : undefined;
    deps.log.info({ event: 'agent-unavailable', ...incident, reason, ...(check === undefined ? {} : { check }), ...resultFields(result) });
    return reason;
  }
  await storeDecision(deps, record, classified.answer, result);
  deps.log.info({ event: 'agent-decided', ...incident, ...resultFields(result) });
  return classified.answer.decision;
}

async function agentStep(deps: DetectDeps, incidentId: string, nowMs: number, counts: CycleCounts): Promise<CycleResult | undefined> {
  const record = await storedRecordOf(deps, incidentId, nowMs);
  if (record === undefined) return undefined;
  if ((await deps.ports.decisionStore.getItem(incidentItemKey(incidentId, 'DECISION'), nowMs)) !== undefined) return undefined;
  return attemptAgent(deps, record, nowMs, counts);
}

// An incident is attempted only by a cycle that found its record already stored or wrote it itself:
// a cycle that lost the marker, or the record, to a racing cycle leaves the attempt to that cycle,
// so two overlapping cycles over one new spike invoke once (AC-E11).
function mayAttempt(view: LaneView): boolean {
  return !view.failed && view.claim !== 'lost' && view.marker?.status === 'open' && (view.evidenceAtStart || view.evidenceWritten);
}

async function attemptAgents(deps: DetectDeps, views: readonly LaneView[], nowMs: number, counts: CycleCounts): Promise<DetectionCycleSummary['outcomes']> {
  const outcomes: DetectionCycleSummary['outcomes'] = [];
  for (const view of views.filter(mayAttempt)) {
    const incident = refOf(view);
    try {
      const result = await agentStep(deps, incident.incidentId, nowMs, counts);
      if (result !== undefined) outcomes.push({ incidentId: incident.incidentId, result });
    } catch (error) {
      logFailure(deps, counts, 'agent-attempt-failed', incident, error);
    }
  }
  return outcomes;
}

/** One scheduled cycle over every lane-map lane, in D-42's order. */
export async function runDetectionCycle(deps: DetectDeps): Promise<DetectionCycleSummary> {
  const nowMs = deps.now();
  const counts: CycleCounts = { sesReads: 0, dnsLookups: 0, invocations: 0, failures: 0 };
  const folded = await foldLanes(deps, nowMs);

  const views: LaneView[] = [];
  for (const lane of folded) views.push(await stepLane(deps, lane, nowMs, counts));
  for (const view of views) await claimLane(deps, view, nowMs, counts);
  for (const view of views) await putState(deps, view, nowMs, counts);
  const incidentsOpened = await writeEvidence(deps, views, nowMs, counts);
  const outcomes = await attemptAgents(deps, views, nowMs, counts);

  return {
    lanes: folded.map(({ lane, spike }) => ({ configurationSet: lane.configurationSet, verdict: spike.verdict })),
    incidentsOpened,
    invocations: counts.invocations,
    sesReads: counts.sesReads,
    dnsLookups: counts.dnsLookups,
    incidents: views.filter((view) => view.marker?.status === 'open').map(refOf),
    failures: counts.failures,
    outcomes,
  };
}
