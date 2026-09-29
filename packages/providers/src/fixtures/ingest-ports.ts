import { bucketSortKeyPrefix, type EventRecord, type RecordKey } from '@fothering/core/records';
import type { AddressKeySet } from '@fothering/core/address';
import type { AddressKeyPort, DeadLetterPort, EventStorePort, FixtureOptions } from '../port-types.js';
import { brandPort } from '../port-types.js';
import { DEAD_LETTER_QUEUE_TARGET, type DryRunLog } from '../dry-run.js';

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
// own object can never change what is stored. A write leaves one dry-run line when the caller
// passes a log, and the line comes first, so the intent is on record even for a write that fails.
export function createFixtureEventStore(options: FixtureOptions = {}, dryRun?: DryRunLog): EventStorePort {
  const records = new Map<string, EventRecord>();

  return brandPort({
    async putIfAbsent(record) {
      await dryRun?.would('eventStore.putIfAbsent', record.pk, record);
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
      // them into sort-key strings with bucketSortKeyPrefix, which refuses a bound no key could
      // hold, so the fixture passes them through the same function before comparing numbers.
      bucketSortKeyPrefix(fromBucketMs);
      bucketSortKeyPrefix(toBucketMs);
      rejectUnmarshallable(nowMs);
      // DynamoDB rejects an inverted BETWEEN key condition with a ValidationException instead of
      // returning an empty page, so a window computed backwards fails here as it would live.
      if (fromBucketMs > toBucketMs) {
        throw new Error(
          'Invalid KeyConditionExpression: The BETWEEN operator requires upper bound to be greater than or equal to lower bound',
        );
      }
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
      await dryRun?.would('eventStore.deleteRecord', key.pk, key);
      return records.delete(keyOf(key));
    },
    async getRecord(key) {
      const record = records.get(keyOf(key));
      return record === undefined ? undefined : structuredClone(record);
    },
  }, 'fixture');
}

// D-13: keyVersion is the map key. The generated secret in the real table is a 64-character
// alphanumeric string; the fixture value only needs to be stable and never resolve outside
// runtimeContext 'test' (AC-P2, enforced by plan 01-10's composition root, not by this factory).
export const TEST_ADDRESS_KEY_SET: AddressKeySet = {
  versions: [{ id: 'k1', secret: 'fixture-test-address-key-k1-not-for-deployed-use', activeFromMs: 0 }],
};

export function createFixtureAddressKey(): AddressKeyPort {
  return brandPort({
    async getKeySet() {
      return TEST_ADDRESS_KEY_SET;
    },
  }, 'fixture');
}

export interface FixtureDeadLetterPort extends DeadLetterPort {
  readonly sent: readonly (readonly EventRecord[])[];
}

export function createFixtureDeadLetter(options: FixtureOptions = {}, dryRun?: DryRunLog): FixtureDeadLetterPort {
  const sent: EventRecord[][] = [];
  return brandPort({
    sent,
    async send(records) {
      await dryRun?.would('deadLetter.send', DEAD_LETTER_QUEUE_TARGET, records);
      if (options.deadLetterFailure === 'send') {
        throw new FixtureWriteError('fixture dead letter is configured to fail on send');
      }
      // A queue message is a serialized copy: the live body is the JSON of the records (plan
      // 01-03), so NaN and the infinities arrive as null and an undefined key is dropped.
      sent.push(JSON.parse(JSON.stringify(records)) as EventRecord[]);
    },
  }, 'fixture');
}
