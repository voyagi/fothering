import { closureKey, parseClosure, pausePointerOf, type Closure } from '@fothering/core/closure';
import { reserveLaneAttempt } from '@fothering/core/counters';
import { incidentPauseKey } from '@fothering/core/evidence-record';
import { findLane } from '@fothering/core/lanes';
import { incidentLimitSentence, reopenAcceptance, reputationResetSentence, type ReopenRefusal, type ReopenResult } from '@fothering/core/reopen';
import { SES_READ_SPACING_MS } from '@fothering/providers/ses-facts';
import type { ReopenDeps } from './root.js';

/** Codes, the set, integer times and the two fixed sentences only: no payload and no address (T-03-17). */
export interface ReopenReport {
  result: ReopenResult;
  reason?: ReopenRefusal;
  configurationSet: string;
  requestedAtMs?: number;
  readBackAtMs?: number;
  capHourEndsAt?: string;
  note: string;
  limit: string;
}

type ReopenRecord = NonNullable<Closure['reopen']>;
type ReopenOutcome = NonNullable<ReopenRecord['outcome']>;

/** The closure this command reverses, as far as its own versioned writes have moved it. */
interface Target {
  configurationSet: string;
  incidentId: string;
  version: number;
}

function report(configurationSet: string, result: ReopenResult, details: Partial<ReopenReport> = {}): ReopenReport {
  return { result, configurationSet, ...details, note: reputationResetSentence(configurationSet), limit: incidentLimitSentence(configurationSet) };
}

function refuse(deps: ReopenDeps, configurationSet: string, reason: ReopenRefusal, details: Partial<ReopenReport> = {}): ReopenReport {
  deps.log.info({ event: 'reopen-refused', configurationSet, reason });
  return report(configurationSet, 'refused', { reason, ...details });
}

// No pointer, or one naming a closure that is gone, does not parse or belongs to another set: in each
// case Fothering holds no pause it could reverse, which covers a set paused outside Fothering.
async function pausedClosure(deps: ReopenDeps, configurationSet: string): Promise<Closure | undefined> {
  const store = deps.ports.decisionStore;
  const pointer = pausePointerOf(await store.getItem(incidentPauseKey(configurationSet), deps.now()));
  if (pointer === undefined) return undefined;
  const closure = parseClosure(await store.getItem(closureKey(pointer.incidentId), deps.now()));
  return closure?.configurationSet === configurationSet ? closure : undefined;
}

// The reopen sub-record moves only by a versioned update, and the pause outcome beside it is never
// written here (D-93).
async function writeReopen(deps: ReopenDeps, target: Target, reopen: ReopenRecord | null): Promise<boolean> {
  const result = await deps.ports.decisionStore.updateIfVersion(closureKey(target.incidentId), target.version, { reopen }, deps.now());
  if (result !== 'updated') return false;
  target.version += 1;
  return true;
}

function sameReopen(stored: ReopenRecord | null, expected: ReopenRecord | null): boolean {
  if (stored === null || expected === null) return stored === expected;
  return (
    stored.attempts === expected.attempts &&
    stored.claimedAtMs === expected.claimedAtMs &&
    stored.requestedAtMs === expected.requestedAtMs &&
    stored.readBackAtMs === expected.readBackAtMs &&
    stored.outcome === expected.outcome
  );
}

// The action run moves the same closure's version with its hold-check and email writes, but never its
// reopen sub-record, which only this command writes. So a lost version whose reopen is still the one
// this run expects was moved by the action, and the write is tried once more from the fresh version;
// a reopen another command changed is never written over.
async function writeOwnReopen(deps: ReopenDeps, target: Target, expected: ReopenRecord | null, reopen: ReopenRecord | null): Promise<boolean> {
  if (await writeReopen(deps, target, reopen)) return true;
  const fresh = parseClosure(await deps.ports.decisionStore.getItem(closureKey(target.incidentId), deps.now()));
  if (fresh === undefined || !sameReopen(fresh.reopen, expected)) return false;
  target.version = fresh.version;
  return writeReopen(deps, target, reopen);
}

// A put that throws is reopen-failed with no read-back; only a read of true is a reopen (T-03-18).
async function putAndReadBack(deps: ReopenDeps, configurationSet: string): Promise<{ outcome: ReopenOutcome; readBackAtMs: number | null }> {
  await deps.wait(SES_READ_SPACING_MS);
  try {
    await deps.ports.ses.reopenConfigurationSet(configurationSet);
  } catch {
    return { outcome: 'reopen-failed', readBackAtMs: null };
  }
  await deps.wait(SES_READ_SPACING_MS);
  let outcome: ReopenOutcome;
  try {
    outcome = outcomeOfRead((await deps.ports.ses.getConfigurationSetSending(configurationSet)).sendingEnabled);
  } catch {
    outcome = 'reopen-unknown';
  }
  return { outcome, readBackAtMs: deps.now() };
}

function outcomeOfRead(sendingEnabled: boolean | undefined): ReopenOutcome {
  if (sendingEnabled === undefined) return 'reopen-unknown';
  return sendingEnabled ? 'reopened' : 'reopen-failed';
}

// D-117 from the claim on: the claim, the lane-hour reservation (the pause's own cap, D-98), the
// requested stage, the put and the read-back, then the one write that records the outcome.
async function reopenClaimed(deps: ReopenDeps, target: Target, previous: ReopenRecord | null): Promise<ReopenReport> {
  const { configurationSet, incidentId } = target;
  const claimed: ReopenRecord = { attempts: (previous?.attempts ?? 0) + 1, claimedAtMs: deps.now(), requestedAtMs: null, readBackAtMs: null, outcome: null };
  if (!(await writeOwnReopen(deps, target, previous, claimed))) return refuse(deps, configurationSet, 'reopen-in-progress');
  deps.log.info({ event: 'reopen-claimed', configurationSet, incidentId, attempt: claimed.attempts });

  const attempt = await reserveLaneAttempt(deps.ports.decisionStore, { configurationSet, nowMs: deps.now() });
  if (attempt.outcome === 'cap') {
    await writeOwnReopen(deps, target, claimed, previous);
    return refuse(deps, configurationSet, 'lane-cap-reached', { capHourEndsAt: new Date(attempt.hourEndsAtMs).toISOString() });
  }

  const requestedAtMs = deps.now();
  const requested: ReopenRecord = { ...claimed, requestedAtMs };
  if (!(await writeOwnReopen(deps, target, claimed, requested))) return refuse(deps, configurationSet, 'reopen-in-progress');
  deps.log.info({ event: 'reopen-requested', configurationSet, incidentId });

  const { outcome, readBackAtMs } = await putAndReadBack(deps, configurationSet);
  const times = { requestedAtMs, ...(readBackAtMs === null ? {} : { readBackAtMs }) };
  // A reopen the closure does not record leaves the lane held for later incidents, so the operator is
  // told to run the command again rather than shown a result the record contradicts.
  if (!(await writeOwnReopen(deps, target, requested, { ...requested, readBackAtMs, outcome }))) {
    deps.log.error({ event: 'reopen-unrecorded', configurationSet, incidentId, outcome });
    return report(configurationSet, 'reopen-unknown', times);
  }
  deps.log.info({ event: 'reopen-outcome', configurationSet, incidentId, outcome });
  return report(configurationSet, outcome, times);
}

/**
 * D-117: each step only if the one before it passed, and every refusal before the claim makes no SES
 * call. The command reads no SES facts and re-runs no closeability: reopening is the safe direction.
 * Only the operator's command reaches this; Fothering never reopens a lane on its own.
 */
export async function reopenLane(deps: ReopenDeps, configurationSet: string): Promise<ReopenReport> {
  const lane = findLane(deps.laneMap, configurationSet);
  if (lane === undefined) return refuse(deps, configurationSet, 'not-in-lane-map');
  if (lane.operatorAlert) return refuse(deps, configurationSet, 'operator-alert');
  const closure = await pausedClosure(deps, configurationSet);
  if (closure === undefined) return refuse(deps, configurationSet, 'no-fothering-pause');
  const acceptance = reopenAcceptance(closure, deps.now());
  if (acceptance !== 'accept') return refuse(deps, configurationSet, acceptance);
  // D-117 dry run: the recorder writes its one line, and nothing is claimed, reserved or read back.
  if (deps.kinds.ses?.reopenConfigurationSet === 'dry-run') {
    await deps.ports.ses.reopenConfigurationSet(configurationSet);
    return report(configurationSet, 'dry-run');
  }
  return reopenClaimed(deps, { configurationSet, incidentId: closure.incidentId, version: closure.version }, closure.reopen);
}
