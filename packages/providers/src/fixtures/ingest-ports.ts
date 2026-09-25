import type { EventRecord, RecordKey } from '@fothering/core/records';
import type { AddressKeySet } from '@fothering/core/address';
import type { AddressKeyPort, DeadLetterPort, EventStorePort, FixtureOptions } from '../port-types.js';

export class FixtureWriteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FixtureWriteError';
  }
}

function keyOf(key: RecordKey): string {
  return `${key.pk}\u0000${key.sk}`;
}

// The DynamoDB document client, with the default marshall options plan 01-03's adapter uses,
// refuses an undefined value at any depth, NaN and the infinities, and a number outside the safe
// integer range, with these messages (util-dynamodb convertToAttr and convertToNumberAttr), so
// an item holding one never reaches the table. The fixture refuses the same values the same way.
function rejectUnmarshallable(value: unknown): void {
  if (value === undefined) {
    throw new Error('Pass options.removeUndefinedValues=true to remove undefined values from map/array/set.');
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`Special numeric value ${String(value)} is not allowed`);
    if (value > Number.MAX_SAFE_INTEGER) {
      throw new Error(`Number ${String(value)} is greater than Number.MAX_SAFE_INTEGER. Use NumberValue from @aws-sdk/lib-dynamodb.`);
    }
    if (value < Number.MIN_SAFE_INTEGER) {
      throw new Error(`Number ${String(value)} is lesser than Number.MIN_SAFE_INTEGER. Use NumberValue from @aws-sdk/lib-dynamodb.`);
    }
    return;
  }
  if (typeof value !== 'object' || value === null) return;
  for (const nested of Object.values(value)) rejectUnmarshallable(nested);
}

// Models the table's conditional put (attribute_not_exists(pk), D-08): the check and the set
// happen with no await between them, so two calls issued together under Promise.all resolve
// exactly like DynamoDB's conditional write, one written and one duplicate. Records go in and
// come out as copies, as they do through the real table, so a caller's later mutation of its
// own object can never change what is stored.
export function createFixtureEventStore(options: FixtureOptions = {}): EventStorePort {
  const records = new Map<string, EventRecord>();

  return {
    async putIfAbsent(record) {
      if (options.eventStoreFailure === 'put') {
        throw new FixtureWriteError('fixture event store is configured to fail on put');
      }
      rejectUnmarshallable(record);
      const key = keyOf(record);
      if (records.has(key)) return 'duplicate';
      records.set(key, structuredClone(record));
      return 'written';
    },
    async queryLane(configurationSet, fromBucketMs, toBucketMs, nowMs) {
      // The clock reaches the marshaller as :now. The bucket bounds do not: the live adapter pads
      // them into sort-key strings, where a NaN bound would silently select no records, so plan
      // 01-03 refuses a bound that is not a finite safe integer the same way this fixture does.
      rejectUnmarshallable([fromBucketMs, toBucketMs, nowMs]);
      const pk = `LANE#${configurationSet}`;
      const nowSeconds = Math.floor(nowMs / 1000);
      const result: EventRecord[] = [];
      for (const record of records.values()) {
        if (record.pk !== pk) continue;
        if (record.bucketStartMs < fromBucketMs || record.bucketStartMs > toBucketMs) continue;
        if (record.expiresAt <= nowSeconds) continue;
        result.push(structuredClone(record));
      }
      return result;
    },
    async queryByRecipient(recipientHmac) {
      const result: RecordKey[] = [];
      for (const record of records.values()) {
        if (record.recipientHmac === recipientHmac) result.push({ pk: record.pk, sk: record.sk });
      }
      return result;
    },
    async deleteRecord(key) {
      records.delete(keyOf(key));
    },
    async getRecord(key) {
      const record = records.get(keyOf(key));
      return record === undefined ? undefined : structuredClone(record);
    },
  };
}

// D-13: keyVersion is the map key. The generated secret in the real table is a 64-character
// alphanumeric string; the fixture value only needs to be stable and never resolve outside
// runtimeContext 'test' (AC-P2, enforced by plan 01-10's composition root, not by this factory).
export const TEST_ADDRESS_KEY_SET: AddressKeySet = {
  versions: [{ id: 'k1', secret: 'fixture-test-address-key-k1-not-for-deployed-use', activeFromMs: 0 }],
};

export function createFixtureAddressKey(): AddressKeyPort {
  return {
    async getKeySet() {
      return TEST_ADDRESS_KEY_SET;
    },
  };
}

export interface FixtureDeadLetterPort extends DeadLetterPort {
  readonly sent: readonly (readonly EventRecord[])[];
}

export function createFixtureDeadLetter(options: FixtureOptions = {}): FixtureDeadLetterPort {
  const sent: EventRecord[][] = [];
  return {
    sent,
    async send(records) {
      if (options.deadLetterFailure === 'send') {
        throw new FixtureWriteError('fixture dead letter is configured to fail on send');
      }
      sent.push(structuredClone([...records])); // a queue message is a serialized copy
    },
  };
}
