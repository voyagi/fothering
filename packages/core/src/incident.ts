import { BUCKET_MS, bucketStartMs } from './buckets.js';
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

export function windowsNeedingFinalVerdict(state: IncidentState, nowMs: number): BucketWindow[] {
  const candidates = [...(state.openingFinalized ? [] : [state.openingWindow]), ...(state.pendingRecovery === null ? [] : [state.pendingRecovery])];
  return candidates.filter((window) => nowMs >= window.toBucketMs + BUCKET_MS);
}

export function stepIncident(state: IncidentState, cycle: IncidentCycle): IncidentStep {
  return { state, transitions: [cycle.currentVerdict === 'spike' ? 'spiking' : 'watching'] };
}
