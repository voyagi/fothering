import { describe, expect, it } from 'vitest';
import { BUCKET_MS, LATENESS_HORIZON_MS, bucketStartMs } from './buckets.js';
import { incidentIdFor } from './evidence-record.js';
import {
  openIncident,
  stepIncident,
  windowsNeedingFinalVerdict,
  type IncidentCycle,
  type IncidentState,
  type IncidentStep,
  type LifecycleVerdict,
} from './incident.js';
import { spikeWindowFor, type BucketWindow } from './window-fold.js';

const LANE = 'fothering-bulk';
const NOW_MS = Date.UTC(2026, 9, 11, 12, 2, 0);
const OPENING_WINDOW = spikeWindowFor(NOW_MS);

/** The instant a window's last bucket ends; the window is complete LATENESS_HORIZON_MS later. */
function lastBucketEnd(window: BucketWindow): number {
  return window.toBucketMs + BUCKET_MS;
}

function cycleAt(nowMs: number, currentVerdict: LifecycleVerdict, finalVerdicts: IncidentCycle['finalVerdicts'] = []): IncidentCycle {
  return { currentVerdict, currentWindow: spikeWindowFor(nowMs), nowMs, finalVerdicts };
}

type Step = (state: IncidentState, cycle: IncidentCycle) => IncidentStep;

// One cycle per bucket from NOW_MS: a spike with no open incident opens one, every other cycle moves
// the open incident through the step under test, so the real step and a plant run the same story.
function runCycles(step: Step, verdicts: readonly LifecycleVerdict[]): { ids: string[]; state: IncidentState | undefined } {
  let state: IncidentState | undefined;
  const ids: string[] = [];
  verdicts.forEach((verdict, index) => {
    const nowMs = NOW_MS + index * BUCKET_MS;
    if (state === undefined || state.status === 'closed') {
      if (verdict === 'spike') {
        state = openIncident(LANE, nowMs, spikeWindowFor(nowMs));
        ids.push(state.incidentId);
      }
      return;
    }
    state = step(state, cycleAt(nowMs, verdict)).state;
  });
  return { ids, state };
}

function watchingFrom(state: IncidentState, recoveryNowMs: number): IncidentState {
  return stepIncident(state, cycleAt(recoveryNowMs, 'no-spike')).state;
}

describe('opening an incident (D-53)', () => {
  it('derives the id from the lane and the bucket holding now, at version 1 with nothing counted', () => {
    expect(openIncident(LANE, NOW_MS, OPENING_WINDOW)).toEqual({
      incidentId: incidentIdFor(LANE, bucketStartMs(NOW_MS)),
      configurationSet: LANE,
      status: 'open',
      openingWindow: OPENING_WINDOW,
      openingFinalized: false,
      pendingRecovery: null,
      falseSpikes: 0,
      falseRecoveries: 0,
      version: 1,
    });
  });
});

describe('which windows need a final verdict', () => {
  const opened = openIncident(LANE, NOW_MS, OPENING_WINDOW);
  const completeAt = lastBucketEnd(OPENING_WINDOW) + LATENESS_HORIZON_MS;

  it('lists the opening window only once its last bucket is complete', () => {
    expect(windowsNeedingFinalVerdict(opened, completeAt - 1)).toEqual([]);
    expect(windowsNeedingFinalVerdict(opened, completeAt)).toEqual([OPENING_WINDOW]);
    expect(windowsNeedingFinalVerdict({ ...opened, openingFinalized: true }, completeAt)).toEqual([]);
  });

  it('lists a pending recovery window once complete, after the opening window', () => {
    const recovery = spikeWindowFor(NOW_MS + BUCKET_MS);
    const watching = { ...opened, pendingRecovery: recovery };
    const recoveryCompleteAt = lastBucketEnd(recovery) + LATENESS_HORIZON_MS;
    expect(windowsNeedingFinalVerdict(watching, recoveryCompleteAt - 1)).toEqual([OPENING_WINDOW]);
    expect(windowsNeedingFinalVerdict(watching, recoveryCompleteAt)).toEqual([OPENING_WINDOW, recovery]);
  });
});

describe('closing on a complete window only (AC-E9)', () => {
  const recoveryNowMs = NOW_MS + BUCKET_MS;
  const recovery = spikeWindowFor(recoveryNowMs);
  const closeAt = lastBucketEnd(recovery) + LATENESS_HORIZON_MS;
  const watching = { ...watchingFrom(openIncident(LANE, NOW_MS, OPENING_WINDOW), recoveryNowMs), openingFinalized: true };
  const finals = [{ window: recovery, verdict: 'no-spike' as const }];

  it('closes at exactly T + LATENESS_HORIZON_MS on a no-spike final verdict and stays open one millisecond earlier', () => {
    const closed = stepIncident(watching, cycleAt(closeAt, 'no-spike', finals));
    expect(closed.state.status).toBe('closed');
    expect(closed.transitions).toContain('closed');
    const early = stepIncident(watching, cycleAt(closeAt - 1, 'no-spike', finals));
    expect(early.state.status).toBe('open');
    expect(early.state.pendingRecovery).toEqual(recovery);
  });

  it('never closes on a no-spike verdict over incomplete buckets, however many cycles read it', () => {
    const verdicts: LifecycleVerdict[] = ['spike', ...Array.from({ length: 20 }, () => 'no-spike' as const)];
    const { ids, state } = runCycles(stepIncident, verdicts);
    expect(ids).toHaveLength(1);
    expect(state?.status).toBe('open');
  });
});

describe('one incident per spike (AC-5, AC-E10)', () => {
  const threeCycles: LifecycleVerdict[] = ['spike', 'no-spike', 'spike'];
  const oneIncidentStaysOpen = (step: Step): boolean => {
    const { ids, state } = runCycles(step, threeCycles);
    return ids.length === 1 && state?.status === 'open';
  };

  it('keeps one id, open, over a spike, a no-spike over incomplete buckets and a spike again', () => {
    const { ids, state } = runCycles(stepIncident, threeCycles);
    expect(ids).toEqual([incidentIdFor(LANE, bucketStartMs(NOW_MS))]);
    expect(state?.incidentId).toBe(ids[0]);
    expect(state?.pendingRecovery).toBeNull();
    expect(oneIncidentStaysOpen(stepIncident)).toBe(true);
  });

  it('turns red under a planted step that closes on any no-spike verdict: the third cycle opens a second id', () => {
    const closesOnAnyNoSpike: Step = (state, cycle) =>
      cycle.currentVerdict === 'spike' ? stepIncident(state, cycle) : { state: { ...state, status: 'closed', version: state.version + 1 }, transitions: ['closed'] };
    expect(oneIncidentStaysOpen(closesOnAnyNoSpike)).toBe(false);
    expect(runCycles(closesOnAnyNoSpike, threeCycles).ids).toHaveLength(2);
  });
});

describe('the lifecycle steps (D-54)', () => {
  const opened = openIncident(LANE, NOW_MS, OPENING_WINDOW);

  it('reads no spike, sends pending and not enough volume as watching and records the window as pending recovery', () => {
    for (const verdict of ['no-spike', 'sends-pending', 'not-enough-volume'] as const) {
      const step = stepIncident(opened, cycleAt(NOW_MS + BUCKET_MS, verdict));
      expect(step.transitions).toEqual(['watching']);
      expect(step.state.pendingRecovery).toEqual(spikeWindowFor(NOW_MS + BUCKET_MS));
      expect(step.state.version).toBe(2);
    }
  });

  it('keeps the first pending recovery window while later cycles still read no spike', () => {
    const watching = watchingFrom(opened, NOW_MS + BUCKET_MS);
    const later = stepIncident(watching, cycleAt(NOW_MS + 2 * BUCKET_MS, 'no-spike'));
    expect(later.state.pendingRecovery).toEqual(spikeWindowFor(NOW_MS + BUCKET_MS));
    expect(later.state.version).toBe(watching.version);
  });

  it('clears a pending recovery window on a spike, and a spike with nothing pending changes no state', () => {
    const watching = watchingFrom(opened, NOW_MS + BUCKET_MS);
    const spiking = stepIncident(watching, cycleAt(NOW_MS + 2 * BUCKET_MS, 'spike'));
    expect(spiking.transitions).toEqual(['spiking']);
    expect(spiking.state.pendingRecovery).toBeNull();
    expect(spiking.state.version).toBe(watching.version + 1);
    const again = stepIncident(spiking.state, cycleAt(NOW_MS + 3 * BUCKET_MS, 'spike'));
    expect(again.state).toEqual(spiking.state);
  });

  it('counts a false spike when the opening window final verdict is not a spike, then closes only through recovery', () => {
    const watching = watchingFrom(opened, NOW_MS + BUCKET_MS);
    const openingCompleteAt = lastBucketEnd(OPENING_WINDOW) + LATENESS_HORIZON_MS;
    const falseSpike = stepIncident(watching, cycleAt(openingCompleteAt, 'no-spike', [{ window: OPENING_WINDOW, verdict: 'no-spike' }]));
    expect(falseSpike.transitions).toContain('false-spike');
    expect(falseSpike.state).toMatchObject({ status: 'open', openingFinalized: true, falseSpikes: 1 });

    const recovery = watching.pendingRecovery;
    if (recovery === null) throw new Error('expected a pending recovery window');
    const recoveryCompleteAt = lastBucketEnd(recovery) + LATENESS_HORIZON_MS;
    const closed = stepIncident(falseSpike.state, cycleAt(recoveryCompleteAt, 'no-spike', [{ window: recovery, verdict: 'no-spike' }]));
    expect(closed.state).toMatchObject({ status: 'closed', falseSpikes: 1, version: falseSpike.state.version + 1 });
  });

  it('counts a false recovery when the pending window final verdict is a spike, and watches the current window next', () => {
    const watching = { ...watchingFrom(opened, NOW_MS + BUCKET_MS), openingFinalized: true };
    const recovery = spikeWindowFor(NOW_MS + BUCKET_MS);
    const recoveryCompleteAt = lastBucketEnd(recovery) + LATENESS_HORIZON_MS;
    const step = stepIncident(watching, cycleAt(recoveryCompleteAt, 'no-spike', [{ window: recovery, verdict: 'spike' }]));
    expect(step.transitions).toEqual(['false-recovery', 'watching']);
    expect(step.state).toMatchObject({ status: 'open', falseRecoveries: 1, pendingRecovery: spikeWindowFor(recoveryCompleteAt) });
  });

  it('changes nothing on a closed incident and never mutates the state it was given', () => {
    const closed = { ...opened, status: 'closed' as const };
    expect(stepIncident(closed, cycleAt(NOW_MS + BUCKET_MS, 'spike'))).toEqual({ state: closed, transitions: [] });
    const before = structuredClone(opened);
    stepIncident(opened, cycleAt(NOW_MS + BUCKET_MS, 'no-spike'));
    expect(opened).toEqual(before);
  });
});
