import { actionGate } from '@fothering/core/agent-answer';
import { EMAIL_SEND_ATTEMPTS, HOLD_MS } from '@fothering/core/close-values';
import { configurationRefusals, type SesConfigurationFacts } from '@fothering/core/closeability';
import {
  actionCloseabilityRefusal,
  claimStateOf,
  closureClaimItem,
  closureKey,
  decisionOf,
  freshnessRefusal,
  holdCheckDue,
  holdCheckSkipped,
  holdCheckWindow,
  holdFold,
  parseClosure,
  pauseMayHold,
  pauseOutcomeOf,
  pausePointerOf,
  type ActionRefusal,
  type Closure,
  type ClosureOutcome,
  type EMAIL_REFUSALS,
  type FreshnessRefusal,
  type OtherLaneReading,
  type PausePointer,
  type ReadBack,
  type StoredDecision,
} from '@fothering/core/closure';
import { reserveLaneAttempt } from '@fothering/core/counters';
import { FROM_DISPLAY_NAME } from '@fothering/core/disclosure';
import { evidenceRecordSchema, incidentItemKey, incidentLaneKey, incidentPauseKey, recordHash, type EvidenceRecord } from '@fothering/core/evidence-record';
import { markerOf, stateOf, type IncidentMarker, type IncidentState } from '@fothering/core/incident';
import { emailAttemptDue, emailKindOf, renderOperatorEmail, type RenderedEmail } from '@fothering/core/operator-email';
import { SES_ID_PATTERN, expiresAtFor } from '@fothering/core/records';
import { LiveConfigMissingError, requireLiveConfig, type SendEmailRequest } from '@fothering/providers/port-types';
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

interface RunFacts {
  state: SesFactsState;
  /** Present only when state is read. */
  facts: SesConfigurationFacts | undefined;
}

interface Run {
  deps: ActionDeps;
  /** D-89 step 2: read at most once per run, by the first act whose claim succeeds, and shared. */
  facts: () => Promise<RunFacts>;
}

/** What one act read before the gate (D-89), written with every outcome so the email renders it, never a fresh read. */
interface Readings {
  sesFacts: SesFactsState;
  lanes: Closure['lanes'];
}

// A fact read that throws (throttling, a fault) is recorded as failed and never retried in the run:
// readSesFacts throws rather than return partial facts, and no act may pause on facts it did not read.
function newRun(deps: ActionDeps): Run {
  let read: Promise<RunFacts> | undefined;
  const readOnce = async (): Promise<RunFacts> => {
    try {
      const result = await readSesFacts(deps.ports.ses, deps.laneMap, { wait: deps.wait });
      return result.ok ? { state: 'read', facts: result.facts } : { state: 'bound', facts: undefined };
    } catch {
      return { state: 'failed', facts: undefined };
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

async function updateClosure(run: Run, act: Pick<Act, 'incidentId' | 'version'>, attributes: Readonly<Record<string, unknown>>): Promise<boolean> {
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

async function refuse(run: Run, act: Act, reason: ActionRefusal, readings: Readings): Promise<ClosureOutcome | undefined> {
  if (!(await updateClosure(run, act, { outcome: 'refused', reason, sesFacts: readings.sesFacts, lanes: readings.lanes }))) return undefined;
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
async function pause(run: Run, act: Act, configurationSet: string, readings: Readings): Promise<ClosureOutcome | undefined> {
  const { deps } = run;
  const pauseRequestedAtMs = deps.now();
  if (!(await updateClosure(run, act, { pauseRequestedAtMs, configurationSet, sesFacts: 'read', lanes: readings.lanes }))) return undefined;
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
async function dryRunPause(run: Run, act: Act, configurationSet: string, readings: Readings): Promise<ClosureOutcome | undefined> {
  await run.deps.ports.ses.pauseConfigurationSet(configurationSet);
  return finish(run, act, 'dry-run', { configurationSet, sesFacts: 'read', lanes: readings.lanes });
}

type MarkerReading = { kind: 'absent' } | { kind: 'read'; marker: IncidentMarker } | { kind: 'unreadable' };

// A read that throws and an item markerOf cannot parse are both unreadable, so freshness fails closed.
async function readMarker(deps: ActionDeps, configurationSet: string): Promise<MarkerReading> {
  try {
    const item = await deps.ports.decisionStore.getItem(incidentLaneKey(configurationSet), deps.now());
    if (item === undefined) return { kind: 'absent' };
    const marker = markerOf(item);
    return marker === undefined ? { kind: 'unreadable' } : { kind: 'read', marker };
  } catch {
    return { kind: 'unreadable' };
  }
}

// D-102: every lane-map marker is read once per act, before the gate, so the lane states the closure
// stores and the freshness rule both come from the same reads.
async function readMarkers(deps: ActionDeps): Promise<ReadonlyMap<string, MarkerReading>> {
  const markers = new Map<string, MarkerReading>();
  for (const lane of deps.laneMap.lanes) markers.set(lane.configurationSet, await readMarker(deps, lane.configurationSet));
  return markers;
}

async function readState(deps: ActionDeps, incidentId: string): Promise<IncidentState | undefined> {
  try {
    return stateOf(await deps.ports.decisionStore.getItem(incidentItemKey(incidentId, 'STATE'), deps.now()));
  } catch {
    return undefined;
  }
}

// The window is read as stored, not as typed: a missing or non-integer end must reach the rule as it is.
function openingEndOf(state: IncidentState): unknown {
  const window: unknown = state.openingWindow;
  return typeof window === 'object' && window !== null ? (window as Record<string, unknown>).toBucketMs : undefined;
}

async function otherLaneReading(deps: ActionDeps, reading: MarkerReading | undefined): Promise<OtherLaneReading> {
  if (reading === undefined || reading.kind === 'unreadable') return { kind: 'unreadable' };
  if (reading.kind === 'absent' || reading.marker.status !== 'open') return { kind: 'no-open-incident' };
  const state = await readState(deps, reading.marker.incidentId);
  return state === undefined ? { kind: 'unreadable' } : { kind: 'open', openingToBucketMs: openingEndOf(state) };
}

interface FreshnessContext {
  incidentId: string;
  configurationSet: string;
  record: EvidenceRecord;
  markers: ReadonlyMap<string, MarkerReading>;
}

// D-89 step 4, over the decision store alone (R3): no SES read and no event fold.
async function freshnessOf(deps: ActionDeps, context: FreshnessContext): Promise<FreshnessRefusal | undefined> {
  const own = context.markers.get(context.configurationSet);
  const others: OtherLaneReading[] = [];
  for (const [configurationSet, reading] of context.markers) {
    if (configurationSet !== context.configurationSet) others.push(await otherLaneReading(deps, reading));
  }
  return freshnessRefusal({
    incidentId: context.incidentId,
    marker: own?.kind === 'read' ? own.marker : undefined,
    state: await readState(deps, context.incidentId),
    others,
    recordToBucketMs: context.record.window.toBucketMs,
    nowMs: deps.now(),
  });
}

type PointerReading = { kind: 'absent' } | { kind: 'read'; pointer: PausePointer; holds: boolean } | { kind: 'unreadable' };

// D-95: a pointer that throws or does not parse, or names a closure that cannot be read, holds the lane,
// so a lane is never paused twice on a guess.
async function readPointer(deps: ActionDeps, configurationSet: string): Promise<PointerReading> {
  const store = deps.ports.decisionStore;
  try {
    const item = await store.getItem(incidentPauseKey(configurationSet), deps.now());
    if (item === undefined) return { kind: 'absent' };
    const pointer = pausePointerOf(item);
    if (pointer === undefined) return { kind: 'unreadable' };
    const closure = parseClosure(await store.getItem(closureKey(pointer.incidentId), deps.now()));
    return { kind: 'read', pointer, holds: pauseMayHold(closure, deps.now()) };
  } catch {
    return { kind: 'unreadable' };
  }
}

async function readPointers(deps: ActionDeps): Promise<ReadonlyMap<string, PointerReading>> {
  const pointers = new Map<string, PointerReading>();
  for (const lane of deps.laneMap.lanes) pointers.set(lane.configurationSet, await readPointer(deps, lane.configurationSet));
  return pointers;
}

function holdsLane(reading: PointerReading | undefined): boolean {
  return reading?.kind === 'unreadable' || (reading?.kind === 'read' && reading.holds);
}

// A pointer naming this incident is this act's own, left by an earlier run of it that stopped (D-91).
function heldByAnother(reading: PointerReading, incidentId: string): boolean {
  return holdsLane(reading) && !(reading.kind === 'read' && reading.pointer.incidentId === incidentId);
}

// D-89 step 8: the pointer moves only here, right before the pause stage, so a refused or dry-run act
// never moves it. Losing the conditional create or the versioned update means another act won the lane.
async function movePointer(deps: ActionDeps, configurationSet: string, incidentId: string, reading: PointerReading): Promise<boolean> {
  const store = deps.ports.decisionStore;
  const key = incidentPauseKey(configurationSet);
  if (reading.kind === 'absent') {
    return (await store.putIfAbsent({ ...key, incidentId, version: 0, expiresAt: expiresAtFor(deps.now()) }, deps.now())) === 'written';
  }
  if (reading.kind !== 'read') return false;
  if (reading.pointer.incidentId === incidentId) return true;
  return (await store.updateIfVersion(key, reading.pointer.version, { incidentId }, deps.now())) === 'updated';
}

// D-102: lane states come from the markers and pause pointers this act read and the refusals from this
// run's facts; an unreadable marker shows as no open incident. Unread facts leave the lane-map refusals alone.
function laneBlock(
  deps: ActionDeps,
  markers: ReadonlyMap<string, MarkerReading>,
  pointers: ReadonlyMap<string, PointerReading>,
  facts: SesConfigurationFacts | undefined,
): Closure['lanes'] {
  return deps.laneMap.lanes.map(({ configurationSet }) => ({
    configurationSet,
    state: laneState(markers.get(configurationSet), pointers.get(configurationSet)),
    configurationRefusals: configurationRefusals(configurationSet, { laneMap: deps.laneMap, ses: facts }),
  }));
}

function laneState(marker: MarkerReading | undefined, pointer: PointerReading | undefined): Closure['lanes'][number]['state'] {
  if (holdsLane(pointer)) return 'paused-by-fothering';
  return marker?.kind === 'read' && marker.marker.status === 'open' ? 'incident-open' : 'no-open-incident';
}

// D-89, each step only if the one before it passed. Step 7 (the lane-hour reservation) goes between
// the dry-run branch and the pointer write, and step 13 (the email) after the outcome. Every refusal
// before step 7 takes no cap (AC-E18).
async function actOn(run: Run, act: Act): Promise<ClosureOutcome | undefined> {
  const { deps } = run;
  const facts = await run.facts();
  const markers = await readMarkers(deps);
  const readings: Readings = { sesFacts: facts.state, lanes: laneBlock(deps, markers, await readPointers(deps), facts.facts) };
  let accepted: EvidenceRecord | undefined;
  const gate = await actionGate({
    decision: { decision: act.decision.outcome, optionId: act.decision.optionId },
    incidentId: act.incidentId,
    loadRecord: async (incidentId) => (accepted = await loadRecord(deps, incidentId)),
    laneMap: deps.laneMap,
  });
  if (!gate.ok) return refuse(run, act, gate.refusal, readings);
  if (facts.state !== 'read') return refuse(run, act, facts.state === 'bound' ? 'ses-facts-bound' : 'ses-facts-unavailable', readings);
  const { configurationSet } = gate.intent;
  const record = evidenceRecordSchema.parse(accepted);
  const refusal =
    (await freshnessOf(deps, { incidentId: act.incidentId, configurationSet, record, markers })) ??
    actionCloseabilityRefusal(record.decision.closeability.state, readings.lanes.find((lane) => lane.configurationSet === configurationSet));
  if (refusal !== undefined) return refuse(run, act, refusal, readings);
  const pointer = await readPointer(deps, configurationSet);
  if (heldByAnother(pointer, act.incidentId)) return refuse(run, act, 'lane-already-paused', readings);
  if (deps.kinds.ses?.pauseConfigurationSet === 'dry-run') return dryRunPause(run, act, configurationSet, readings);
  // D-99 and AC-E15: the attempt counts from here whether the put then succeeds or throws.
  const attempt = await reserveLaneAttempt(deps.ports.decisionStore, { configurationSet, nowMs: deps.now() });
  if (attempt.outcome === 'cap') return refuse(run, act, 'lane-cap-reached', readings);
  if (!(await movePointer(deps, configurationSet, act.incidentId, pointer))) return refuse(run, act, 'lane-already-paused', readings);
  return pause(run, act, configurationSet, readings);
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
async function workItem(run: Run, configurationSet: string, reached: Set<string>): Promise<WorkItem | undefined> {
  const { deps } = run;
  const store = deps.ports.decisionStore;
  const marker = markerOf(await store.getItem(incidentLaneKey(configurationSet), deps.now()));
  if (marker === undefined) return undefined;
  const { incidentId } = marker;
  reached.add(incidentId);
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

// D-100: one versioned update moves paused to closed or not-holding, so of two runs checking together
// one writes and the other loses the version and writes nothing. closed reaches a log line only as
// this outcome value (D-112).
async function holdCheck(run: Run, closure: Closure & { holdEndMs: number }): Promise<ClosureOutcome | undefined> {
  const { deps } = run;
  const nowMs = deps.now();
  const window = holdCheckWindow(closure.holdEndMs, nowMs);
  const count = await deps.ports.eventStore.foldLane(closure.configurationSet, window.fromBucketMs, window.toBucketMs, nowMs, holdFold(closure.holdEndMs));
  const outcome: ClosureOutcome = count === 0 ? 'closed' : 'not-holding';
  const attributes = { outcome, sendsAfterHold: count, holdCheckedAtMs: nowMs, holdCheckedThroughMs: window.checkedThroughMs };
  if (!(await updateClosure(run, { incidentId: closure.incidentId, version: closure.version }, attributes))) return undefined;
  deps.log.info({ event: 'hold-check', incidentId: closure.incidentId, outcome, count });
  return outcome;
}

// D-88 source (b): the closure each lane's pause pointer names, together with every incident source (a)
// reached, each once per run.
async function incidentsReached(run: Run, reached: ReadonlySet<string>): Promise<ReadonlySet<string>> {
  const { deps } = run;
  const incidentIds = new Set(reached);
  for (const lane of deps.laneMap.lanes) {
    const pointer = pausePointerOf(await deps.ports.decisionStore.getItem(incidentPauseKey(lane.configurationSet), deps.now()));
    if (pointer !== undefined) incidentIds.add(pointer.incidentId);
  }
  return incidentIds;
}

async function holdChecks(run: Run, incidentIds: ReadonlySet<string>): Promise<ActionRunSummary['acted']> {
  const { deps } = run;
  const store = deps.ports.decisionStore;
  const acted: ActionRunSummary['acted'] = [];
  for (const incidentId of incidentIds) {
    const closure = parseClosure(await store.getItem(closureKey(incidentId), deps.now()));
    if (closure === undefined) continue;
    if (holdCheckDue(closure, deps.now())) {
      const outcome = await holdCheck(run, closure);
      if (outcome !== undefined) acted.push({ incidentId, outcome });
    } else if (holdCheckSkipped(closure, deps.now())) {
      deps.log.info({ event: 'hold-check-skipped', incidentId });
    }
  }
  return acted;
}

type EmailRefusal = (typeof EMAIL_REFUSALS)[number];

interface Addresses {
  from: string;
  to: string;
  configurationSet: string;
}

function refuseEmail(deps: ActionDeps, incidentId: string, reason: EmailRefusal): undefined {
  deps.log.error({ event: 'email-refused', incidentId, reason });
  return undefined;
}

// D-109 and D-107: exactly one operator-alert lane carries the email, and both addresses must be set;
// the refusal names neither address.
function addressesOf(deps: ActionDeps, incidentId: string): Addresses | undefined {
  const alertLanes = deps.laneMap.lanes.filter((lane) => lane.operatorAlert);
  const [alertLane] = alertLanes;
  if (alertLanes.length !== 1 || alertLane === undefined) return refuseEmail(deps, incidentId, 'operator-alert-lane-count');
  try {
    return {
      from: requireLiveConfig(deps.operator.from, 'FOTHERING_FROM_ADDRESS'),
      to: requireLiveConfig(deps.operator.to, 'FOTHERING_OPERATOR_ADDRESS'),
      configurationSet: alertLane.configurationSet,
    };
  } catch (error) {
    if (error instanceof LiveConfigMissingError) return refuseEmail(deps, incidentId, 'operator-config-missing');
    throw error;
  }
}

// The email renders only a record that parses, belongs to the incident and still matches its hash, so
// a tampered record a gate refusal stopped never has its numbers printed.
async function trustedRecord(deps: ActionDeps, incidentId: string): Promise<EvidenceRecord | undefined> {
  const parsed = evidenceRecordSchema.safeParse(await loadRecord(deps, incidentId));
  if (!parsed.success || parsed.data.incidentId !== incidentId || recordHash(parsed.data) !== parsed.data.hash) return undefined;
  return parsed.data;
}

async function renderFor(deps: ActionDeps, closure: Closure): Promise<RenderedEmail | undefined> {
  const decisionItem = await deps.ports.decisionStore.getItem(incidentItemKey(closure.incidentId, 'DECISION'), deps.now());
  return renderOperatorEmail({ closure, record: await trustedRecord(deps, closure.incidentId), decision: decisionOf(decisionItem), laneMap: deps.laneMap });
}

type EmailState = NonNullable<Closure['email']>;

async function sendClaimed(run: Run, act: Pick<Act, 'incidentId' | 'version'>, claimed: EmailState, request: SendEmailRequest): Promise<void> {
  const { deps } = run;
  const { incidentId } = act;
  try {
    // SES may accept a message and still answer with a timeout or a server error, so a retried attempt
    // can deliver a second copy; one extra email is the accepted limit (03-RESEARCH Pitfall 15).
    const { messageId } = await deps.ports.ses.sendEmail(request);
    const storedId = SES_ID_PATTERN.test(messageId) ? messageId : null;
    if (await updateClosure(run, act, { email: { ...claimed, sentAtMs: deps.now(), messageId: storedId } })) {
      deps.log.info({ event: 'email-sent', incidentId, ...(storedId === null ? {} : { messageId: storedId }) });
    }
  } catch (error) {
    const errorName = error instanceof Error ? error.name : 'UnknownError';
    if (claimed.attempts >= EMAIL_SEND_ATTEMPTS) {
      if (await updateClosure(run, act, { email: { ...claimed, failed: true } })) deps.log.error({ event: 'email-failed', incidentId, errorName });
      return;
    }
    await updateClosure(run, act, { email: { ...claimed, claimedAtMs: null } });
    deps.log.info({ event: 'email-attempt-failed', incidentId, attempt: claimed.attempts, errorName });
  }
}

// D-89 step 13: each attempt is claimed by a versioned update before the send, so two runs reaching one
// closure never send one attempt twice (AC-E29).
async function sendOperatorEmail(run: Run, closure: Closure): Promise<void> {
  const { deps } = run;
  const addresses = addressesOf(deps, closure.incidentId);
  if (addresses === undefined) return;
  const rendered = await renderFor(deps, closure);
  if (rendered === undefined) return;
  const act = { incidentId: closure.incidentId, version: closure.version };
  const claimed: EmailState = {
    kind: rendered.kind,
    attempts: (closure.email?.attempts ?? 0) + 1,
    claimedAtMs: deps.now(),
    sentAtMs: null,
    messageId: null,
    failed: false,
  };
  if (!(await updateClosure(run, act, { email: claimed }))) return;
  await sendClaimed(run, act, claimed, {
    from: `${FROM_DISPLAY_NAME} <${addresses.from}>`,
    to: [addresses.to],
    subject: rendered.subject,
    text: rendered.text,
    configurationSetName: addresses.configurationSet,
  });
}

// D-88 source (c): every closure sources (a) and (b) reached that ended in a state that sends (D-109),
// read again after the hold checks so a closed outcome written in this run is mailed in this run.
async function operatorEmails(run: Run, incidentIds: ReadonlySet<string>): Promise<void> {
  const { deps } = run;
  for (const incidentId of incidentIds) {
    const closure = parseClosure(await deps.ports.decisionStore.getItem(closureKey(incidentId), deps.now()));
    if (closure !== undefined && emailKindOf(closure.outcome) !== undefined && emailAttemptDue(closure, deps.now())) await sendOperatorEmail(run, closure);
  }
}

/** One scheduled run over every lane-map lane. */
export async function runActionCycle(deps: ActionDeps): Promise<ActionRunSummary> {
  const run = newRun(deps);
  const acted: ActionRunSummary['acted'] = [];
  const reached = new Set<string>();
  for (const lane of deps.laneMap.lanes) {
    const item = await workItem(run, lane.configurationSet, reached);
    if (item === undefined) continue;
    const outcome = await outcomeOf(run, item);
    const incidentId = item.kind === 'act' ? item.act.incidentId : item.incidentId;
    if (outcome !== undefined) acted.push({ incidentId, outcome });
  }
  const incidentIds = await incidentsReached(run, reached);
  acted.push(...(await holdChecks(run, incidentIds)));
  await operatorEmails(run, incidentIds);
  return { acted };
}
