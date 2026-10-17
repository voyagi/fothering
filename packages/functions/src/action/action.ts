import { actionGate } from '@fothering/core/agent-answer';
import { HOLD_MS } from '@fothering/core/close-values';
import {
  claimStateOf,
  closureClaimItem,
  closureKey,
  decisionOf,
  parseClosure,
  pauseOutcomeOf,
  type ActionRefusal,
  type Closure,
  type ClosureOutcome,
  type ReadBack,
  type StoredDecision,
} from '@fothering/core/closure';
import { incidentItemKey, incidentLaneKey, type EvidenceRecord } from '@fothering/core/evidence-record';
import { markerOf } from '@fothering/core/incident';
import { SES_READ_SPACING_MS, readSesFacts } from '@fothering/providers/ses-facts';
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

type SesFactsState = NonNullable<Closure['sesFacts']>;

interface Run {
  deps: ActionDeps;
  /** D-89 step 2: read at most once per run, by the first act whose claim succeeds, and shared. */
  facts: () => Promise<SesFactsState>;
}

// A fact read that throws (throttling, a fault) is recorded as failed and never retried in the run:
// readSesFacts throws rather than return partial facts, and no act may pause on facts it did not read.
function newRun(deps: ActionDeps): Run {
  let read: Promise<SesFactsState> | undefined;
  const readOnce = async (): Promise<SesFactsState> => {
    try {
      return (await readSesFacts(deps.ports.ses, deps.laneMap, { wait: deps.wait })).ok ? 'read' : 'bound';
    } catch {
      return 'failed';
    }
  };
  return {
    deps,
    facts: () => {
      read ??= readOnce();
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

/** The one write that gives a closure its outcome; a lost race leaves the other run's outcome standing. */
async function finish(run: Run, act: Act, outcome: ClosureOutcome, attributes: Readonly<Record<string, unknown>>): Promise<ClosureOutcome | undefined> {
  if (!(await updateClosure(run, act, { outcome, ...attributes }))) return undefined;
  run.deps.log.info({ event: 'closure-outcome', incidentId: act.incidentId, outcome });
  return outcome;
}

async function refuse(run: Run, act: Act, reason: ActionRefusal, sesFacts: SesFactsState): Promise<ClosureOutcome | undefined> {
  if (!(await updateClosure(run, act, { outcome: 'refused', reason, sesFacts }))) return undefined;
  run.deps.log.info({ event: 'closure-refused', incidentId: act.incidentId, reason });
  return 'refused';
}

// The raw stored record: actionGate parses and re-hashes it itself, so nothing is trusted here.
async function loadRecord(deps: ActionDeps, incidentId: string): Promise<EvidenceRecord | undefined> {
  const item = await deps.ports.decisionStore.getItem(incidentItemKey(incidentId, 'EVIDENCE'), deps.now());
  return item?.record as EvidenceRecord | undefined;
}

// Every way the read-back can end maps to a value pauseOutcomeOf reads: an answer without the field is
// missing and a throw is threw, both unknown, never a pause.
async function readBackOf(deps: ActionDeps, configurationSet: string): Promise<ReadBack> {
  try {
    const sending = await deps.ports.ses.getConfigurationSetSending(configurationSet);
    return sending.sendingEnabled ?? 'missing';
  } catch {
    return 'threw';
  }
}

async function putPause(deps: ActionDeps, configurationSet: string): Promise<boolean> {
  try {
    await deps.ports.ses.pauseConfigurationSet(configurationSet);
    return true;
  } catch {
    return false;
  }
}

// D-89 steps 9 to 12. SES throttles every action but sending at one request a second per account, so
// the put and the read-back each wait out the spacing after the fact reads (Pitfall 3). Whether SES can
// read back a stale true right after an accepted put is UNVERIFIED; it maps to pause-failed either way.
async function pause(run: Run, act: Act, configurationSet: string): Promise<ClosureOutcome | undefined> {
  const { deps } = run;
  const pauseRequestedAtMs = deps.now();
  if (!(await updateClosure(run, act, { pauseRequestedAtMs, configurationSet, sesFacts: 'read' }))) return undefined;
  deps.log.info({ event: 'pause-requested', incidentId: act.incidentId });
  await deps.wait(SES_READ_SPACING_MS);
  if (!(await putPause(deps, configurationSet))) return finish(run, act, 'pause-failed', { readBack: null, readBackAtMs: null });
  await deps.wait(SES_READ_SPACING_MS);
  const readBack = await readBackOf(deps, configurationSet);
  const outcome = pauseOutcomeOf(readBack);
  return finish(run, act, outcome, {
    readBack,
    readBackAtMs: deps.now(),
    ...(outcome === 'paused' ? { holdEndMs: pauseRequestedAtMs + HOLD_MS } : {}),
  });
}

// D-120: nothing reached SES, so no pause is requested and no read-back is claimed. This sits right
// before the lane-hour reservation (step 7), so a dry run reserves nothing and moves no pause pointer.
async function dryRunPause(run: Run, act: Act, configurationSet: string): Promise<ClosureOutcome | undefined> {
  await run.deps.ports.ses.pauseConfigurationSet(configurationSet);
  return finish(run, act, 'dry-run', { configurationSet, sesFacts: 'read' });
}

// D-89, each step only if the one before it passed. Steps 4 to 6 (freshness, closeability at action
// time and the pause pointer check) go between the fact check and the dry-run branch, steps 7 and 8
// (the lane-hour reservation and the pointer write) between the dry-run branch and the pause stage, and
// step 13 (the email) after the outcome.
async function actOn(run: Run, act: Act): Promise<ClosureOutcome | undefined> {
  const { deps } = run;
  const sesFacts = await run.facts();
  const gate = await actionGate({
    decision: { decision: act.decision.outcome, optionId: act.decision.optionId },
    incidentId: act.incidentId,
    loadRecord: (incidentId) => loadRecord(deps, incidentId),
    laneMap: deps.laneMap,
  });
  if (!gate.ok) return refuse(run, act, gate.refusal, sesFacts);
  if (sesFacts !== 'read') return refuse(run, act, sesFacts === 'bound' ? 'ses-facts-bound' : 'ses-facts-unavailable', sesFacts);
  const { configurationSet } = gate.intent;
  if (deps.kinds.ses?.pauseConfigurationSet === 'dry-run') return dryRunPause(run, act, configurationSet);
  return pause(run, act, configurationSet);
}

type WorkItem = { kind: 'act'; act: Act } | { kind: 'settled'; incidentId: string; outcome: ClosureOutcome };

async function claim(run: Run, incidentId: string, configurationSet: string, decision: StoredDecision): Promise<WorkItem | undefined> {
  const { deps } = run;
  const item = closureClaimItem({ incidentId, configurationSet, decisionOutcome: decision.outcome, nowMs: deps.now() });
  if ((await deps.ports.decisionStore.putIfAbsent(item, deps.now())) !== 'written') return undefined;
  deps.log.info({ event: 'closure-claimed', incidentId });
  return { kind: 'act', act: { incidentId, configurationSet, decision, version: item.version } };
}

// D-91: a stale claim with no pause requested ran no SES mutation, so it is claimed again and acted on
// from the fact read; one with a pause requested may have paused, so it ends unknown and is never put again.
async function takeOver(run: Run, closure: Closure, decision: StoredDecision): Promise<WorkItem | undefined> {
  const { deps } = run;
  const act: Act = { incidentId: closure.incidentId, configurationSet: closure.configurationSet, decision, version: closure.version };
  const state = claimStateOf(closure, deps.now());
  if (state === 'reclaimable') {
    if (!(await updateClosure(run, act, { claimedAtMs: deps.now() }))) return undefined;
    deps.log.info({ event: 'closure-claimed', incidentId: act.incidentId });
    return { kind: 'act', act };
  }
  if (state !== 'put-may-have-taken') return undefined;
  const outcome = await finish(run, act, 'pause-unknown', { readBack: null });
  return outcome === undefined ? undefined : { kind: 'settled', incidentId: act.incidentId, outcome };
}

// D-88 source (a): the incident a lane's marker names, whatever the marker's status, once it has a
// DECISION item and no closure another run holds or finished. Known limit: an incident whose marker
// moved on to a newer incident before any action run reached it gets no closure and no email; with a
// five-minute schedule that takes an action outage of many hours.
async function workItem(run: Run, configurationSet: string): Promise<WorkItem | undefined> {
  const { deps } = run;
  const store = deps.ports.decisionStore;
  const marker = markerOf(await store.getItem(incidentLaneKey(configurationSet), deps.now()));
  if (marker === undefined) return undefined;
  const { incidentId } = marker;
  const decision = decisionOf(await store.getItem(incidentItemKey(incidentId, 'DECISION'), deps.now()));
  if (decision === undefined) return undefined;
  const stored = await store.getItem(closureKey(incidentId), deps.now());
  if (stored === undefined) return claim(run, incidentId, configurationSet, decision);
  const closure = parseClosure(stored);
  if (closure !== undefined) return takeOver(run, closure, decision);
  deps.log.error({ event: 'closure-unreadable', incidentId });
  return undefined;
}

async function outcomeOf(run: Run, item: WorkItem): Promise<ClosureOutcome | undefined> {
  return item.kind === 'settled' ? item.outcome : actOn(run, item.act);
}

/** One scheduled run over every lane-map lane. */
export async function runActionCycle(deps: ActionDeps): Promise<ActionRunSummary> {
  const run = newRun(deps);
  const acted: ActionRunSummary['acted'] = [];
  for (const lane of deps.laneMap.lanes) {
    const item = await workItem(run, lane.configurationSet);
    if (item === undefined) continue;
    const outcome = await outcomeOf(run, item);
    const incidentId = item.kind === 'act' ? item.act.incidentId : item.incidentId;
    if (outcome !== undefined) acted.push({ incidentId, outcome });
  }
  return { acted };
}
