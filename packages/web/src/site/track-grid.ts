import type { ReplayArtifact, ReplayEvent } from '@fothering/core/replay-artifact';
import { orderedEvents } from './replay-view.js';

// The SES account drawn as a step pattern: each lane a track, each recorded event a step key, the
// keys banked by the replay step the event belongs to. The grid draws only what the artifact
// records, one column per event in the replay's order, never traffic between them (WR-13).

export type Lamp = 'off' | 'event' | 'bounce';

export interface TrackColumn {
  readonly step: number;
  readonly kind: ReplayEvent['kind'];
  // UTC, HH:MM:SS.
  readonly time: string;
}

export interface TrackKey {
  readonly lamp: Lamp;
  readonly muted: boolean;
}

export interface Track {
  readonly lane: string;
  // Muted at the last column shown, which is what the track's mute key reports.
  readonly muted: boolean;
  readonly keys: readonly TrackKey[];
}

export interface TrackBank {
  readonly step: number;
  readonly first: number;
  readonly columns: number;
}

export interface TrackGrid {
  readonly columns: readonly TrackColumn[];
  readonly tracks: readonly Track[];
  readonly banks: readonly TrackBank[];
  // The column the pause lands on, or -1 when the pattern stops before it.
  readonly muteColumn: number;
}

type GridSource = Pick<ReplayArtifact, 'lanes' | 'closedLane' | 'events' | 'pause' | 'reopen'>;

const at = (utc: string): number => Date.parse(utc);

// The pause belongs to step 3 and the reopen to step 4, the steps the replay names after them.
const PAUSED_STEP = 3;
const REOPEN_STEP = 4;

// The first column of one step at or after a moment, or -1 when that step shows no such column. Only
// that step's columns count, so an earlier step's event at the same moment never moves the mute.
function columnFrom(events: readonly ReplayEvent[], step: number, utc: string): number {
  return events.findIndex((event) => event.step === step && at(event.atUtc) >= at(utc));
}

function banksOf(columns: readonly TrackColumn[]): TrackBank[] {
  const banks: TrackBank[] = [];
  columns.forEach((column, index) => {
    const last = banks.at(-1);
    if (last?.step === column.step) banks[banks.length - 1] = { ...last, columns: last.columns + 1 };
    else banks.push({ step: column.step, first: index, columns: 1 });
  });
  return banks;
}

// The closed lane is muted from the column the pause lands on in the paused step up to the column the
// reopen lands on in the reopen step, so a pattern that stops before the reopen step leaves it muted,
// and one that stops before the paused step leaves every track open. The replay refuses an artifact
// whose paused step or reopen step has no event from that moment on (replay-view.ts).
export function buildTrackGrid(artifact: GridSource, throughStep: number): TrackGrid {
  if (!Number.isInteger(throughStep) || throughStep < 1 || throughStep > 4) {
    throw new Error(`track grid: throughStep is ${String(throughStep)}, and the replay has steps 1 to 4. Pass a step from 1 to 4.`);
  }
  const events = orderedEvents(artifact.events).filter((event) => event.step <= throughStep);
  const stray = events.find((event) => !artifact.lanes.includes(event.lane));
  if (stray !== undefined) {
    throw new Error(`track grid: an event at ${stray.atUtc} sits on ${stray.lane}, which is not one of the artifact's lanes (${artifact.lanes.join(', ')}). Add the lane to lanes or correct the event.`);
  }
  const muteColumn = columnFrom(events, PAUSED_STEP, artifact.pause.atUtc);
  const reopenColumn = muteColumn < 0 ? -1 : columnFrom(events, REOPEN_STEP, artifact.reopen.atUtc);
  const mutedAt = (index: number): boolean => muteColumn >= 0 && index >= muteColumn && (reopenColumn < 0 || index < reopenColumn);
  const columns = events.map((event) => ({ step: event.step, kind: event.kind, time: event.atUtc.slice(11, 19) }));
  const tracks = artifact.lanes.map((lane) => {
    const closed = lane === artifact.closedLane;
    const keys = events.map((event, index): TrackKey => {
      const lamp: Lamp = event.lane !== lane ? 'off' : event.kind === 'bounce' ? 'bounce' : 'event';
      return { lamp, muted: closed && mutedAt(index) };
    });
    return { lane, muted: closed && events.length > 0 && mutedAt(events.length - 1), keys };
  });
  return { columns, tracks, banks: banksOf(columns), muteColumn };
}
