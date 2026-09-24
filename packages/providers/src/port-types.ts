import type { EventRecord, RecordKey } from '@fothering/core/records';
import type { AddressKeySet } from '@fothering/core/address';

export interface EventStorePort {
  putIfAbsent(record: EventRecord): Promise<'written' | 'duplicate'>;
  queryLane(
    configurationSet: string,
    fromBucketMs: number,
    toBucketMs: number,
    nowMs: number,
  ): Promise<EventRecord[]>;
  queryByRecipient(recipientHmac: string): Promise<RecordKey[]>;
  deleteRecord(key: RecordKey): Promise<void>;
  getRecord(key: RecordKey): Promise<EventRecord | undefined>;
}

export interface AddressKeyPort {
  getKeySet(): Promise<AddressKeySet>;
}

export interface DeadLetterPort {
  send(records: readonly EventRecord[]): Promise<void>;
}

/** Fixture-only failure injection (D-26); no live adapter reads these options. */
export interface FixtureOptions {
  eventStoreFailure?: 'put';
  deadLetterFailure?: 'send';
}
