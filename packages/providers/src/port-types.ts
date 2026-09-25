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

// The composition-root contracts (D-05, D-06): a runtimeContext picks fixture over live wholesale,
// a switch value picks live over dry-run per mutating operation, and a row with no live adapter yet
// throws a named NotBuiltError instead of silently falling back to something weaker (T-01-03).

export type RuntimeContext = 'test' | 'deployed';

/** `not-built-until-phase-N` is a template literal, not a fixed list: any later phase number fits. */
export type ResolvedKind = 'fixture' | 'live' | 'dry-run' | `not-built-until-phase-${number}`;

/** Port name to operation name to its resolved kind for this one composition-root build. */
export type KindTable = Readonly<Record<string, Readonly<Record<string, ResolvedKind>>>>;

/** The shape every AWS SDK v3 client shares; a live adapter wraps one of these, never the raw client type. */
export interface SendClient {
  send(command: unknown): Promise<unknown>;
}

export type LiveClients = Partial<Record<'dynamoDb' | 'secretsManager' | 'sqs' | 'sesv2', unknown>>;

export interface LiveConfig {
  tableName?: string;
  deadLetterQueueUrl?: string;
  addressKeySecretId?: string;
}

/** A dry-run recorder never resolves to a device; it only ever writes one line naming what it would have sent. */
export type DryRunSink = (line: string) => void;

export class NotBuiltError extends Error {
  readonly phase: number;

  constructor(phase: number) {
    super(`not built until phase ${phase}`);
    this.name = 'NotBuiltError';
    this.phase = phase;
  }
}
