import { parseSesEvent } from '@fothering/core/ses-events';
import { findLane } from '@fothering/core/lanes';
import { minimizeEvent } from '@fothering/core/minimize';
import type { Provenance } from '@fothering/core/records';
import type { IngestDeps } from './root.js';

export interface IngestResult {
  outcome: 'stored' | 'dropped' | 'dead-lettered';
  stored: number;
  duplicates: number;
}

export interface IngestOptions {
  provenance: Provenance;
}

// Ordering per D-16: parse, drop an unmapped set, minimize, conditional puts. Plan 01-12 adds the
// dead-letter path behind this same signature; a write failure here is left to that plan.
export async function ingestEvent(rawEvent: unknown, deps: IngestDeps, options: IngestOptions): Promise<IngestResult> {
  const parsed = parseSesEvent(rawEvent);
  if (!parsed.ok) {
    deps.log.info({
      event: 'dropped-unparseable',
      ...(parsed.messageId !== undefined ? { messageId: parsed.messageId } : {}),
      ...(parsed.field !== undefined ? { field: parsed.field } : {}),
    });
    return { outcome: 'dropped', stored: 0, duplicates: 0 };
  }

  const configurationSet = parsed.event.detail.mail.tags['ses:configuration-set']?.[0];
  const lane = configurationSet === undefined ? undefined : findLane(deps.laneMap, configurationSet);
  if (lane === undefined) {
    deps.log.info({ event: 'dropped-unmapped', messageId: parsed.event.detail.mail.messageId });
    return { outcome: 'dropped', stored: 0, duplicates: 0 };
  }

  const keySet = await deps.ports.addressKey.getKeySet();
  const records = minimizeEvent(parsed.event, {
    lane,
    laneMap: deps.laneMap,
    keySet,
    provenance: options.provenance,
    envelopeTimeMs: Date.parse(parsed.event.time),
    arrivalTimeMs: deps.now(),
  });

  let stored = 0;
  let duplicates = 0;
  for (const record of records) {
    const outcome = await deps.ports.eventStore.putIfAbsent(record);
    if (outcome === 'written') stored += 1;
    else duplicates += 1;
  }

  return { outcome: 'stored', stored, duplicates };
}
