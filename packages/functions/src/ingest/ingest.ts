import { parseSesEvent } from '@fothering/core/ses-events';
import { NoActiveKeyVersionError } from '@fothering/core/address';
import { findLane } from '@fothering/core/lanes';
import { minimizeEvent, UnstorableEventError } from '@fothering/core/minimize';
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
// Send with no destination, minimize, conditional puts. Minimize drops only an event whose send
// time has no storable bucket, the one failure no retry can fix. A write failure sends the already-
// minimized records to the dead-letter port and reports dead-lettered; a failed dead-letter send,
// an unreadable address key set, a key set with no version active at the send time and any other
// minimize failure are left to propagate so Lambda's asynchronous retry reruns the whole event, and
// the conditional puts absorb whatever the first attempt already wrote.
// Every one of those failures writes a log line first, naming the message and the error by its
// name only, so an operator can tell which message failed and why without any error text.
// A parse failure is an error too, not a routine drop: the rule forwards only the six SES event
// types from mapped sets, so an event that fails the schema is a lost SES event, and an SES format
// change that fails every event must reach a reader filtering on level.
export async function ingestEvent(rawEvent: unknown, deps: IngestDeps, options: IngestOptions): Promise<IngestResult> {
  const parsed = parseSesEvent(rawEvent);
  if (!parsed.ok) {
    deps.log.error({
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

  let keySet;
  try {
    keySet = await deps.ports.addressKey.getKeySet();
  } catch (error) {
    deps.log.error({ event: 'key-set-unavailable', messageId, errorName: errorName(error) });
    throw error;
  }

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
    // Only a fault in the event itself is dropped. A missing key version is fixed in the key set,
    // and unusable key material or a code defect is not the event's doing either, so each is
    // logged under its own event name and propagates like an unreadable key set.
    if (error instanceof UnstorableEventError) {
      deps.log.error({ event: 'dropped-unminimizable', messageId, errorName: errorName(error) });
      return { outcome: 'dropped', stored: 0, duplicates: 0 };
    }
    const event = error instanceof NoActiveKeyVersionError ? 'key-version-missing' : 'minimize-failed';
    deps.log.error({ event, messageId, errorName: errorName(error) });
    throw error;
  }

  let stored = 0;
  let duplicates = 0;
  try {
    for (const record of records) {
      const outcome = await deps.ports.eventStore.putIfAbsent(record);
      if (outcome === 'written') stored += 1;
      else duplicates += 1;
    }
  } catch (writeError) {
    try {
      await deps.ports.deadLetter.send(records);
    } catch (sendError) {
      // The write error gets its own line: the send error propagates, so nothing else would name it.
      deps.log.error({ event: 'put-failed', messageId, errorName: errorName(writeError) });
      deps.log.error({ event: 'dead-letter-failed', messageId, errorName: errorName(sendError) });
      throw sendError;
    }
    deps.log.error({ event: 'dead-lettered', messageId, errorName: errorName(writeError) });
    return { outcome: 'dead-lettered', stored, duplicates };
  }

  return { outcome: 'stored', stored, duplicates };
}
