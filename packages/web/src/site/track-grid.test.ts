import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { replayArtifactSchema, type ReplayArtifact } from '@fothering/core/replay-artifact';
import { describe, expect, it } from 'vitest';
import { buildTrackGrid } from './track-grid.js';

const FIXTURE = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'replay-incident.json');

function shippedArtifact(): ReplayArtifact {
  return replayArtifactSchema.parse(JSON.parse(readFileSync(FIXTURE, 'utf8')));
}

const lampsOf = (grid: ReturnType<typeof buildTrackGrid>, lane: string): string[] => grid.tracks.find((track) => track.lane === lane)?.keys.map((key) => key.lamp) ?? [];
const mutedOf = (grid: ReturnType<typeof buildTrackGrid>, lane: string): boolean[] => grid.tracks.find((track) => track.lane === lane)?.keys.map((key) => key.muted) ?? [];
// The closed lane through the paused step: its last key, and what its mute key reports.
const grid3Muted = (artifact: ReplayArtifact): { last: boolean; track: boolean } => {
  const grid = buildTrackGrid(artifact, 3);
  return { last: mutedOf(grid, 'fothering-bulk').at(-1) ?? false, track: grid.tracks.find((track) => track.lane === 'fothering-bulk')?.muted ?? false };
};

describe('buildTrackGrid', () => {
  it('draws one column per recorded event through step 3, in the replay order, banked by step', () => {
    const grid = buildTrackGrid(shippedArtifact(), 3);
    expect(grid.columns.map((column) => column.kind)).toEqual(['bounce', 'bounce', 'delivery', 'delivery', 'evidence-record', 'agent', 'ses-call', 'read-back', 'hold-check']);
    expect(grid.columns.map((column) => column.time)).toEqual(['14:01:07', '14:01:09', '14:01:12', '14:01:20', '14:02:00', '14:02:04', '14:03:00', '14:03:02', '14:04:00']);
    expect(grid.banks).toEqual([{ step: 1, first: 0, columns: 4 }, { step: 2, first: 4, columns: 2 }, { step: 3, first: 6, columns: 3 }]);
    expect(grid.tracks.map((track) => track.lane)).toEqual(['fothering-transactional', 'fothering-bulk', 'fothering-alerts']);
  });

  it('lights a key only where its lane has that event, a bounce with its own lamp', () => {
    const grid = buildTrackGrid(shippedArtifact(), 3);
    expect(lampsOf(grid, 'fothering-bulk')).toEqual(['bounce', 'bounce', 'off', 'off', 'event', 'event', 'event', 'event', 'event']);
    expect(lampsOf(grid, 'fothering-transactional')).toEqual(['off', 'off', 'event', 'off', 'off', 'off', 'off', 'off', 'off']);
    expect(lampsOf(grid, 'fothering-alerts')).toEqual(['off', 'off', 'off', 'event', 'off', 'off', 'off', 'off', 'off']);
  });

  it('mutes the closed lane from the column the pause lands on, and no other track', () => {
    const grid = buildTrackGrid(shippedArtifact(), 3);
    expect(grid.muteColumn).toBe(6);
    expect(mutedOf(grid, 'fothering-bulk')).toEqual([false, false, false, false, false, false, true, true, true]);
    expect(mutedOf(grid, 'fothering-transactional').some(Boolean)).toBe(false);
    expect(mutedOf(grid, 'fothering-alerts').some(Boolean)).toBe(false);
    expect(grid.tracks.map((track) => track.muted)).toEqual([false, true, false]);
  });

  it('unmutes the closed lane from the column the reopen lands on when the pattern runs through step 4', () => {
    const grid = buildTrackGrid(shippedArtifact(), 4);
    expect(grid.columns).toHaveLength(12);
    expect(grid.banks.at(-1)).toEqual({ step: 4, first: 9, columns: 3 });
    expect(mutedOf(grid, 'fothering-bulk')).toEqual([false, false, false, false, false, false, true, true, true, true, false, false]);
    expect(grid.tracks.find((track) => track.lane === 'fothering-bulk')?.muted).toBe(false);
  });

  it('leaves every track open when the pattern stops before the pause', () => {
    const grid = buildTrackGrid(shippedArtifact(), 2);
    expect(grid.muteColumn).toBe(-1);
    expect(grid.tracks.flatMap((track) => track.keys).some((key) => key.muted)).toBe(false);
    expect(grid.tracks.some((track) => track.muted)).toBe(false);
  });

  it('starts the mute in the paused step even when an earlier step has an event at the pause time', () => {
    const artifact = shippedArtifact();
    const lastStepTwo = artifact.events.findLastIndex((event) => event.step === 2);
    const shared = { ...artifact, events: artifact.events.map((event, index) => (index === lastStepTwo ? { ...event, atUtc: artifact.pause.atUtc } : event)) };
    expect(buildTrackGrid(shared, 2).muteColumn).toBe(-1);
    expect(mutedOf(buildTrackGrid(shared, 2), 'fothering-bulk').some(Boolean)).toBe(false);
    expect(buildTrackGrid(shared, 3).muteColumn).toBe(6);
    expect(mutedOf(buildTrackGrid(shared, 3), 'fothering-bulk')).toEqual([false, false, false, false, false, false, true, true, true]);
  });

  it('keeps the closed lane muted through the paused step even when a step 3 event shares the reopen time', () => {
    const artifact = shippedArtifact();
    const lastStepThree = artifact.events.findLastIndex((event) => event.step === 3);
    const firstStepFour = artifact.events.findIndex((event) => event.step === 4);
    const reopenAt = artifact.reopen.atUtc;
    const shared = { ...artifact, events: artifact.events.map((event, index) => (index === lastStepThree || index === firstStepFour ? { ...event, atUtc: reopenAt } : event)) };
    expect(grid3Muted(shared)).toEqual({ last: true, track: true });
    expect(mutedOf(buildTrackGrid(shared, 4), 'fothering-bulk')).toEqual([false, false, false, false, false, false, true, true, true, false, false, false]);
  });

  it('refuses an event on a lane the artifact does not list, naming the lane and the event time', () => {
    const artifact = shippedArtifact();
    const strayed = { ...artifact, events: artifact.events.map((event, index) => (index === 2 ? { ...event, lane: 'fothering-other' } : event)) };
    expect(() => buildTrackGrid(strayed, 3)).toThrow('track grid: an event at 2026-10-14T14:01:12Z sits on fothering-other, which is not one of the artifact\'s lanes');
  });

  it('refuses a step outside 1 to 4', () => {
    for (const step of [0, 5, 2.5]) expect(() => buildTrackGrid(shippedArtifact(), step), String(step)).toThrow(`track grid: throughStep is ${String(step)}`);
  });
});
