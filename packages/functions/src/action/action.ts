import { actionGate } from '@fothering/core/agent-answer';
import { HOLD_MS } from '@fothering/core/close-values';
import {
  closureClaimItem,
  closureKey,
  decisionOf,
  parseClosure,
  pauseOutcomeOf,
  type ClosureOutcome,
  type ReadBack,
  type StoredDecision,
} from '@fothering/core/closure';
import { incidentItemKey, incidentLaneKey, type EvidenceRecord } from '@fothering/core/evidence-record';
import { markerOf } from '@fothering/core/incident';
import { SES_READ_SPACING_MS, readSesFacts, type SesFactsResult } from '@fothering/providers/ses-facts';
import type { ActionDeps } from './root.js';

export interface ActionRunSummary {
  acted: { incidentId: string; outcome: ClosureOutcome }[];
}

/** One run's view of one incident it may act on; version follows this act's own closure writes. */
interface Act {
  incidentId: string;
  configurationSet: string;
  decision: StoredDecision;
  version: number;
}

interface Run {
  deps: ActionDeps;
  /** D-89 step 2: read at most once per run, by the first act whose claim succeeds, and shared. */
  facts: () => Promise<SesFactsResult>;
}

function newRun(deps: ActionDeps): Run {
  let read: Promise<SesFactsResult> | undefined;
  return {
    deps,
    facts: () => {
      read ??= readSesFacts(deps.ports.ses, deps.laneMap, { wait: deps.wait });
      return read;
    },
  };
}

async function updateClosure(run: Run, act: Act, attributes: Readonly<Record<string, unknown>>): Promise<boolean> {
  const { deps } = run;
  const result = await deps.ports.decisionStore.updateIfVersion(closureKey(act.incidentId), act.version, attributes, deps.now());
  if (result === 'updated') {
    act.version += 1;
    return true;
  }
  deps.log.info({ event: 'closure-claim-lost', incidentId: act.incidentId });
  return false;
}

// The raw stored record: actionGate parses and re-hashes it itself, so nothing is trusted here.
async function loadRecord(deps: ActionDeps, incidentId: string): Promise<EvidenceRecord | undefined> {
  const item = await deps.ports.decisionStore.getItem(incidentItemKey(incidentId, 'EVIDENCE'), deps.now());
  return item?.record as EvidenceRecord | undefined;
}

async function readBackOf(deps: ActionDeps, configurationSet: string): Promise<ReadBack> {
  const sending = await deps.ports.ses.getConfigurationSetSending(configurationSet);
  return sending.sendingEnabled ?? 'missing';
}

// D-89 steps 9 to 12. SES throttles every action but sending at one request a second per account, so
// the put and the read-back each wait out the spacing after the fact reads (Pitfall 3).
async function pause(run: Run, act: Act, configurationSet: string): Promise<ClosureOutcome | undefined> {
  const { deps } = run;
  const pauseRequestedAtMs = deps.now();
  if (!(await updateClosure(run, act, { pauseRequestedAtMs, configurationSet }))) return undefined;
  deps.log.info({ event: 'pause-requested', incidentId: act.incidentId });
  await deps.wait(SES_READ_SPACING_MS);
  await deps.ports.ses.pauseConfigurationSet(configurationSet);
  await deps.wait(SES_READ_SPACING_MS);
  const readBack = await readBackOf(deps, configurationSet);
  const outcome = pauseOutcomeOf(readBack);
  const written = await updateClosure(run, act, {
    outcome,
    readBack,
    readBackAtMs: deps.now(),
    ...(outcome === 'paused' ? { holdEndMs: pauseRequestedAtMs + HOLD_MS } : {}),
  });
  if (!written) return undefined;
  deps.log.info({ event: 'closure-outcome', incidentId: act.incidentId });
  return outcome;
}

// D-89, each step only if the one before it passed. Steps 4 to 8 (freshness, closeability at action
// time, the pause pointer, the lane-hour reservation and the pointer write) sit between the gate and
// the pause stage, and step 13 (the email) after the outcome.
async function actOn(run: Run, act: Act): Promise<ClosureOutcome | undefined> {
  const { deps } = run;
  await run.facts();
  const gate = await actionGate({
    decision: { decision: act.decision.outcome, optionId: act.decision.optionId },
    incidentId: act.incidentId,
    loadRecord: (incidentId) => loadRecord(deps, incidentId),
    laneMap: deps.laneMap,
  });
  if (!gate.ok) return undefined;
  return pause(run, act, gate.intent.configurationSet);
}

async function claim(run: Run, incidentId: string, configurationSet: string, decision: StoredDecision): Promise<Act | undefined> {
  const { deps } = run;
  const item = closureClaimItem({ incidentId, configurationSet, decisionOutcome: decision.outcome, nowMs: deps.now() });
  if ((await deps.ports.decisionStore.putIfAbsent(item, deps.now())) !== 'written') return undefined;
  deps.log.info({ event: 'closure-claimed', incidentId });
  return { incidentId, configurationSet, decision, version: item.version };
}

// D-88 source (a): the incident a lane's marker names, whatever the marker's status, once it has a
// DECISION item and no closure another run holds or finished. Known limit: an incident whose marker
// moved on to a newer incident before any action run reached it gets no closure and no email; with a
// five-minute schedule that takes an action outage of many hours.
async function workItem(run: Run, configurationSet: string): Promise<Act | undefined> {
  const { deps } = run;
  const store = deps.ports.decisionStore;
  const marker = markerOf(await store.getItem(incidentLaneKey(configurationSet), deps.now()));
  if (marker === undefined) return undefined;
  const { incidentId } = marker;
  const decision = decisionOf(await store.getItem(incidentItemKey(incidentId, 'DECISION'), deps.now()));
  if (decision === undefined) return undefined;
  const stored = await store.getItem(closureKey(incidentId), deps.now());
  if (stored === undefined) return claim(run, incidentId, configurationSet, decision);
  if (parseClosure(stored) === undefined) deps.log.error({ event: 'closure-unreadable', incidentId });
  return undefined;
}

/** One scheduled run over every lane-map lane. */
export async function runActionCycle(deps: ActionDeps): Promise<ActionRunSummary> {
  const run = newRun(deps);
  const acted: ActionRunSummary['acted'] = [];
  for (const lane of deps.laneMap.lanes) {
    const act = await workItem(run, lane.configurationSet);
    if (act === undefined) continue;
    const outcome = await actOn(run, act);
    if (outcome !== undefined) acted.push({ incidentId: act.incidentId, outcome });
  }
  return { acted };
}
