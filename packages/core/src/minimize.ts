import type { EventRecord, Provenance } from './records.js';
import type { AddressKeySet } from './address.js';
import type { LaneEntry, LaneMap } from './lanes.js';
import type { SesEnvelope } from './ses-events.js';

export interface MinimizeContext {
  lane: LaneEntry;
  laneMap: LaneMap;
  keySet: AddressKeySet;
  provenance: Provenance;
  envelopeTimeMs: number;
  arrivalTimeMs: number;
}

// RED stub: no minimized records yet. GREEN implements the Bounce path.
export function minimizeEvent(_event: SesEnvelope, _context: MinimizeContext): EventRecord[] {
  return [];
}
