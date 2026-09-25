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

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'Error';
}

// Ordering per D-16: parse, drop without a configuration-set tag, drop an unmapped set, drop a
// Send with no destination, minimize, conditional puts. A write failure sends the already-
// minimized records to the dead-letter port and reports dead-lettered; a failed dead-letter send
// is left to propagate so Lambda's asynchronous retry reruns the whole event, and the conditional
// puts absorb whatever the first attempt already wrote.
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

  const { detail } = parsed.event;
  const messageId = detail.mail.messageId;

  const configurationSet = detail.mail.tags['ses:configuration-set']?.[0];
  if (configurationSet === undefined) {
    deps.log.info({ event: 'dropped-no-configuration-set', messageId });
    return { outcome: 'dropped', stored: 0, duplicates: 0 };
  }

  const lane = findLane(deps.laneMap, configurationSet);
  if (lane === undefined) {
    deps.log.info({ event: 'dropped-unmapped', messageId });
    return { outcome: 'dropped', stored: 0, duplicates: 0 };
  }

  if (detail.eventType === 'Send' && detail.mail.destination.length === 0) {
    deps.log.info({ event: 'dropped-empty-destination', messageId });
    return { outcome: 'dropped', stored: 0, duplicates: 0 };
  }

  const keySet = await deps.ports.addressKey.getKeySet();

  let records;
  try {
    records = minimizeEvent(parsed.event, {
      lane,
      laneMap: deps.laneMap,
      keySet,
      provenance: options.provenance,
      envelopeTimeMs: Date.parse(parsed.event.time),
      arrivalTimeMs: deps.now(),
    });
  } catch (error) {
    deps.log.error({ event: 'dropped-unminimizable', errorName: errorName(error) });
    return { outcome: 'dropped', stored: 0, duplicates: 0 };
  }

  let stored = 0;
  let duplicates = 0;
  try {
    for (const record of records) {
      const outcome = await deps.ports.eventStore.putIfAbsent(record);
      if (outcome === 'written') stored += 1;
      else duplicates += 1;
    }
  } catch {
    await deps.ports.deadLetter.send(records);
    deps.log.error({ event: 'dead-lettered', messageId });
    return { outcome: 'dead-lettered', stored, duplicates };
  }

  return { outcome: 'stored', stored, duplicates };
}
