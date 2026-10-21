import { bucketStartMs, isBucketComplete } from './buckets.js';
import { incidentIdFor } from './evidence-record.js';
import type { LaneVerdict } from './verdicts.js';
import type { BucketWindow } from './window-fold.js';

export type IncidentStatus = 'open' | 'closed';

export interface IncidentState {
  incidentId: string;
  configurationSet: string;
  status: IncidentStatus;
  openingWindow: BucketWindow;
  openingFinalized: boolean;
  pendingRecovery: BucketWindow | null;
  falseSpikes: number;
  falseRecoveries: number;
  version: number;
}

/** The lane marker `INCIDENT_LANE#<set>` / `MARKER`: which incident the lane holds and whether it is open. */
export interface IncidentMarker {
  incidentId: string;
  status: IncidentStatus;
  version: number;
}

/** The STATE item's `state` attribute: the item's own version is the state's version. */
export type StoredIncidentState = Omit<IncidentState, 'version'>;

// Detection and the action both read markers and STATE through these, so a reader can never drift
// from the shape the writer stores. They take unknown so core needs nothing from the providers' item type.
export function markerOf(item: unknown): IncidentMarker | undefined {
  if (typeof item !== 'object' || item === null) return undefined;
  const { incidentId, status, version } = item as Record<string, unknown>;
  if (typeof incidentId !== 'string' || (status !== 'open' && status !== 'closed') || typeof version !== 'number') return undefined;
  return { incidentId, status, version };
}

// The item's own version is the state's version, so updateIfVersion and stepIncident count alike.
export function storedStateOf(state: IncidentState): StoredIncidentState {
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

export function stateOf(item: unknown): IncidentState | undefined {
  if (typeof item !== 'object' || item === null) return undefined;
  const { version, state } = item as Record<string, unknown>;
  if (typeof version !== 'number') return undefined;
  const stored = state as Partial<StoredIncidentState> | null | undefined;
  if (stored?.status !== 'open' && stored?.status !== 'closed') return undefined;
  return { ...(stored as StoredIncidentState), version };
}

export const INCIDENT_TRANSITIONS = ['opened', 'spiking', 'watching', 'false-recovery', 'false-spike', 'closed'] as const;
export type IncidentTransition = (typeof INCIDENT_TRANSITIONS)[number];

export type LifecycleVerdict = LaneVerdict | 'sends-pending';

export interface FinalVerdict {
  window: BucketWindow;
  verdict: LifecycleVerdict;
}

export interface IncidentCycle {
  currentVerdict: LifecycleVerdict;
  currentWindow: BucketWindow;
  nowMs: number;
  finalVerdicts: readonly FinalVerdict[];
}

export interface IncidentStep {
  state: IncidentState;
  transitions: IncidentTransition[];
}

export function openIncident(configurationSet: string, nowMs: number, spikeWindow: BucketWindow): IncidentState {
  return {
    incidentId: incidentIdFor(configurationSet, bucketStartMs(nowMs)),
    configurationSet,
    status: 'open',
    openingWindow: { ...spikeWindow },
    openingFinalized: false,
    pendingRecovery: null,
    falseSpikes: 0,
    falseRecoveries: 0,
    version: 1,
  };
}

// A window is final only once its last bucket is complete, by the one completeness rule phase 1
// owns: a no-spike verdict over incomplete buckets can still turn into a spike as late bounces and
// complaints land, so closing on it would open a second incident and a second invocation (D-54).
function isWindowComplete(window: BucketWindow, nowMs: number): boolean {
  return isBucketComplete(window.toBucketMs, nowMs);
}

function sameWindow(left: BucketWindow, right: BucketWindow): boolean {
  return left.fromBucketMs === right.fromBucketMs && left.toBucketMs === right.toBucketMs;
}

export function windowsNeedingFinalVerdict(state: IncidentState, nowMs: number): BucketWindow[] {
  if (state.status === 'closed') return [];
  const candidates = [...(state.openingFinalized ? [] : [state.openingWindow]), ...(state.pendingRecovery === null ? [] : [state.pendingRecovery])];
  return candidates.filter((window) => isWindowComplete(window, nowMs));
}

function finalVerdictFor(window: BucketWindow, cycle: IncidentCycle): LifecycleVerdict | undefined {
  if (!isWindowComplete(window, cycle.nowMs)) return undefined;
  return cycle.finalVerdicts.find((final) => sameWindow(final.window, window))?.verdict;
}

function settleOpeningWindow(next: IncidentState, cycle: IncidentCycle, transitions: IncidentTransition[]): void {
  if (next.openingFinalized) return;
  const verdict = finalVerdictFor(next.openingWindow, cycle);
  if (verdict === undefined) return;
  next.openingFinalized = true;
  if (verdict !== 'spike') {
    next.falseSpikes += 1;
    transitions.push('false-spike');
  }
}

function settleRecoveryWindow(next: IncidentState, cycle: IncidentCycle, transitions: IncidentTransition[]): void {
  if (next.pendingRecovery === null) return;
  const verdict = finalVerdictFor(next.pendingRecovery, cycle);
  if (verdict === undefined) return;
  if (verdict === 'spike') {
    next.falseRecoveries += 1;
    next.pendingRecovery = null;
    transitions.push('false-recovery');
    return;
  }
  next.status = 'closed';
  next.pendingRecovery = null;
  transitions.push('closed');
}

function followCurrentVerdict(next: IncidentState, cycle: IncidentCycle, transitions: IncidentTransition[]): void {
  if (cycle.currentVerdict === 'spike') {
    next.pendingRecovery = null;
    transitions.push('spiking');
    return;
  }
  next.pendingRecovery ??= { ...cycle.currentWindow };
  transitions.push('watching');
}

function stateChanged(before: IncidentState, after: IncidentState): boolean {
  return JSON.stringify({ ...before, version: 0 }) !== JSON.stringify({ ...after, version: 0 });
}

/** One detection cycle for an open incident: final verdicts of complete windows first, then the
 * cycle's own verdict. Pure, so the cycle in plan 02-12 owns every read and write of the state. */
export function stepIncident(state: IncidentState, cycle: IncidentCycle): IncidentStep {
  if (state.status === 'closed') return { state, transitions: [] };
  const next: IncidentState = structuredClone(state);
  const transitions: IncidentTransition[] = [];
  settleOpeningWindow(next, cycle, transitions);
  settleRecoveryWindow(next, cycle, transitions);
  if (next.status === 'open') followCurrentVerdict(next, cycle, transitions);
  if (stateChanged(state, next)) next.version = state.version + 1;
  return { state: next, transitions };
}
