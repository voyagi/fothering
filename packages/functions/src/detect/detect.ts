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
import { assembleEvidenceRecord, decideCycle, type LaneAnalysis } from '@fothering/core/decision';
import { evidenceRecordSchema, incidentIdFor, incidentItemKey, type EvidenceRecord } from '@fothering/core/evidence-record';
import { buildProviderRows, buildTagRows } from '@fothering/core/evidence-rows';
import type { LaneEntry } from '@fothering/core/lanes';
import type { LogEntry } from '@fothering/core/log';
import { MODEL_VALUES } from '@fothering/core/model-values';
import { RETENTION_SECONDS } from '@fothering/core/records';
import { laneSpikeVerdict, type LaneSpikeVerdict, type LaneVerdict } from '@fothering/core/verdicts';
import { createWindowFold, spikeWindowFor, summarizeWindow, type WindowSummary } from '@fothering/core/window-fold';
import { requireLiveConfig, type SesReadPort } from '@fothering/providers/port-types';
import { readSesFacts } from '@fothering/providers/ses-facts';
import type { DetectDeps } from './root.js';

type CycleResult = AgentAnswer['decision'] | AgentUnavailableReason;

export interface DetectionCycleSummary {
  lanes: { configurationSet: string; verdict: LaneVerdict }[];
  incidentsOpened: number;
  invocations: number;
  sesReads: number;
  dnsLookups: number;
  incidents: { configurationSet: string; incidentId: string }[];
  failures: number;
  outcomes: { incidentId: string; result: CycleResult }[];
}

interface FoldedLane {
  lane: LaneEntry;
  summary: WindowSummary;
  spike: LaneSpikeVerdict;
}

interface SpikingIncident {
  configurationSet: string;
  incidentId: string;
}

interface CycleCounts {
  sesReads: number;
  invocations: number;
}

const FIRST_ATTEMPT = 1;
const RUNTIME_ARN_VARIABLE = 'FOTHERING_AGENT_RUNTIME_ARN';

// Every lane read goes through foldLane, so a window's memory is the fold's state and never the
// window's records (D-43); queryLane is not a detection read.
async function foldLanes(deps: DetectDeps, nowMs: number): Promise<FoldedLane[]> {
  const window = spikeWindowFor(nowMs);
  const folded: FoldedLane[] = [];
  for (const lane of deps.laneMap.lanes) {
    const fold = createWindowFold({ lane: lane.configurationSet, window, nowMs });
    const state = await deps.ports.eventStore.foldLane(lane.configurationSet, window.fromBucketMs, window.toBucketMs, nowMs, fold);
    const summary = summarizeWindow(state);
    folded.push({ lane, summary, spike: laneSpikeVerdict(summary.totals) });
  }
  return folded;
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

async function unopenedOf(deps: DetectDeps, incidents: readonly SpikingIncident[], nowMs: number): Promise<SpikingIncident[]> {
  const unopened: SpikingIncident[] = [];
  for (const incident of incidents) {
    const evidence = await deps.ports.decisionStore.getItem(incidentItemKey(incident.incidentId, 'EVIDENCE'), nowMs);
    if (evidence === undefined) unopened.push(incident);
  }
  return unopened;
}

// D-42 step 4: SES is read only in a cycle that has an incident to open. Past the identity bound
// nothing is opened here rather than opened on partial facts.
async function openIncidents(deps: DetectDeps, folded: readonly FoldedLane[], incidents: readonly SpikingIncident[], nowMs: number, counts: CycleCounts): Promise<number> {
  const unopened = await unopenedOf(deps, incidents, nowMs);
  if (unopened.length === 0) return 0;
  const facts = await readSesFacts(countedSesReads(deps.ports.ses, counts), deps.laneMap, { wait: deps.wait });
  if (!facts.ok) {
    deps.log.info({ event: 'opening-deferred', reason: facts.reason });
    return 0;
  }
  const analyses = analysesOf(folded, deps, facts.facts);
  const bySet = new Map(analyses.map((analysis) => [analysis.lane.configurationSet, analysis]));
  const decisions = decideCycle(analyses, deps.laneMap);
  const expiresAt = Math.floor(nowMs / 1000) + RETENTION_SECONDS;
  let opened = 0;
  for (const { configurationSet, incidentId } of unopened) {
    const analysis = bySet.get(configurationSet);
    const decision = decisions.get(configurationSet);
    if (analysis === undefined || decision === undefined) continue;
    const record = assembleEvidenceRecord({ incidentId, analysis, decision, analyses, expiresAt });
    const written = await deps.ports.decisionStore.putIfAbsent({ ...incidentItemKey(incidentId, 'EVIDENCE'), expiresAt, record });
    if (written === 'written') {
      opened += 1;
      deps.log.info({ event: 'incident-opened', configurationSet, incidentId, reason: record.decision.reason });
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

/** One scheduled cycle over every lane-map lane, in D-42's order. */
export async function runDetectionCycle(deps: DetectDeps): Promise<DetectionCycleSummary> {
  const nowMs = deps.now();
  const counts: CycleCounts = { sesReads: 0, invocations: 0 };
  const folded = await foldLanes(deps, nowMs);
  const incidents = folded
    .filter(({ spike }) => spike.verdict === 'spike')
    .map(({ lane }) => ({ configurationSet: lane.configurationSet, incidentId: incidentIdFor(lane.configurationSet, bucketStartMs(nowMs)) }));

  const incidentsOpened = await openIncidents(deps, folded, incidents, nowMs, counts);

  const outcomes: DetectionCycleSummary['outcomes'] = [];
  for (const { incidentId } of incidents) {
    const record = await storedRecordOf(deps, incidentId, nowMs);
    if (record === undefined) continue;
    if ((await deps.ports.decisionStore.getItem(incidentItemKey(incidentId, 'DECISION'), nowMs)) !== undefined) continue;
    outcomes.push({ incidentId, result: await attemptAgent(deps, record, nowMs, counts) });
  }

  return {
    lanes: folded.map(({ lane, spike }) => ({ configurationSet: lane.configurationSet, verdict: spike.verdict })),
    incidentsOpened,
    invocations: counts.invocations,
    sesReads: counts.sesReads,
    dnsLookups: 0,
    incidents: [],
    failures: 0,
    outcomes,
  };
}
