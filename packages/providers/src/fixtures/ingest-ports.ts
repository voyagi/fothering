import { RETENTION_SECONDS, bucketSortKeyPrefix, lanePartitionKey, type EventRecord, type RecordKey } from '@fothering/core/records';
import type { AddressKeySet } from '@fothering/core/address';
import { assertFoldWindow } from '@fothering/core/window-fold';
import type {
  AddressKeyPort,
  DeadLetterPort,
  DecisionStoreItem,
  DecisionStorePort,
  EventStorePort,
  FixtureOptions,
  FixtureTableState,
  ReservationItem,
  ReservationRequest,
} from '../port-types.js';
import { assertNotCounterItem, assertReservation, assertUsage, assertVersionedUpdate, brandPort } from '../port-types.js';
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

const LANE_KEY_PREFIX = lanePartitionKey('');
const DEFAULT_PAGE_SIZE = 100;

export function createFixtureTableState(): FixtureTableState {
  return { items: new Map() };
}

// The event store and the decision store share one table, so every event read skips an item that
// is not under a LANE# key, as a lane query and the recipient index never reach one live (D-65).
function isLaneRecord(item: unknown): item is EventRecord {
  if (typeof item !== 'object' || item === null) return false;
  const { pk } = item as { pk?: unknown };
  return typeof pk === 'string' && pk.startsWith(LANE_KEY_PREFIX);
}

function bySortKeyBytes(left: EventRecord, right: EventRecord): number {
  return Buffer.compare(Buffer.from(left.sk, 'utf8'), Buffer.from(right.sk, 'utf8'));
}

function pageSizeOf(options: FixtureOptions): number {
  const pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
  if (!Number.isInteger(pageSize) || pageSize < 1) {
    throw new RangeError(`a fixture page size must be a whole number of records from 1 up, not ${String(pageSize)}`);
  }
  return pageSize;
}

// Copies of the lane's unexpired records in the window, taken in one pass, in the UTF-8 byte order
// of the sort key that DynamoDB guarantees for a query (D-43). Map insertion order would follow the
// order a test wrote its records in and hide an ordering bug.
function laneSnapshot(
  items: ReadonlyMap<string, unknown>,
  configurationSet: string,
  fromBucketMs: number,
  toBucketMs: number,
  nowMs: number,
): EventRecord[] {
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
  const pk = lanePartitionKey(configurationSet);
  const nowSeconds = Math.floor(nowMs / 1000);
  const result: EventRecord[] = [];
  for (const item of items.values()) {
    if (!isLaneRecord(item) || item.pk !== pk) continue;
    if (item.bucketStartMs < fromBucketMs || item.bucketStartMs > toBucketMs) continue;
    if (item.expiresAt <= nowSeconds) continue;
    result.push(structuredClone(item));
  }
  return result.sort(bySortKeyBytes);
}

// Models the table's conditional put (attribute_not_exists(pk), D-08): the check and the set
// happen with no await between them, so two calls issued together under Promise.all resolve
// exactly like DynamoDB's conditional write, one written and one duplicate. Records go in and
// come out as copies, as they do through the real table, so a caller's later mutation of its
// own object can never change what is stored. A write leaves one dry-run line when the caller
// passes a log, and the line comes first, so the intent is on record even for a write that fails.
export function createFixtureEventStore(options: FixtureOptions = {}, dryRun?: DryRunLog): EventStorePort {
  const { items } = options.store ?? createFixtureTableState();
  const pageSize = pageSizeOf(options);

  return brandPort({
    async putIfAbsent(record) {
      await dryRun?.would('eventStore.putIfAbsent', record.pk, record);
      if (options.eventStoreFailure === 'put') {
        throw new FixtureWriteError('fixture event store is configured to fail on put');
      }
      rejectUnmarshallable(record);
      const key = keyOf(record);
      if (items.has(key)) return 'duplicate';
      items.set(key, structuredClone(record));
      return 'written';
    },
    async queryLane(configurationSet, fromBucketMs, toBucketMs, nowMs) {
      return laneSnapshot(items, configurationSet, fromBucketMs, toBucketMs, nowMs);
    },
    // The snapshot is taken before the first page and every page yields to the event loop, so a
    // write landing while the fold runs is never in it: counted at most once (the R1 concurrency
    // backstop). An empty window still delivers one empty page, as a DynamoDB query answers one.
    async foldLane(configurationSet, fromBucketMs, toBucketMs, nowMs, fold) {
      assertFoldWindow(fromBucketMs, toBucketMs);
      const snapshot = laneSnapshot(items, configurationSet, fromBucketMs, toBucketMs, nowMs);
      let state = fold.initial;
      let start = 0;
      do {
        state = fold.step(state, snapshot.slice(start, start + pageSize));
        start += pageSize;
        await Promise.resolve();
      } while (start < snapshot.length);
      return state;
    },
    async queryByRecipient(recipientHmac) {
      const result: RecordKey[] = [];
      for (const item of items.values()) {
        if (isLaneRecord(item) && item.recipientHmac === recipientHmac) result.push({ pk: item.pk, sk: item.sk });
      }
      return result;
    },
    async deleteRecord(key) {
      await dryRun?.would('eventStore.deleteRecord', key.pk, key);
      return items.delete(keyOf(key));
    },
    async getRecord(key) {
      const item = items.get(keyOf(key));
      return isLaneRecord(item) ? structuredClone(item) : undefined;
    },
  }, 'fixture');
}

function isDecisionItem(item: unknown): item is DecisionStoreItem {
  if (typeof item !== 'object' || item === null || isLaneRecord(item)) return false;
  const { pk, expiresAt } = item as { pk?: unknown; expiresAt?: unknown };
  return typeof pk === 'string' && typeof expiresAt === 'number';
}

function numberAttribute(item: unknown, attribute: string): number | undefined {
  if (typeof item !== 'object' || item === null) return undefined;
  const value = (item as Record<string, unknown>)[attribute];
  return typeof value === 'number' ? value : undefined;
}

// The live condition reads "attribute_not_exists(x) OR x < cap": a counter not yet written has room.
function hasRoom(current: number | undefined, cap: number): boolean {
  return current === undefined || current < cap;
}

function refusedItems(items: ReadonlyMap<string, unknown>, request: ReservationRequest): ReservationItem[] {
  const incident = items.get(keyOf(request.incidentKey));
  const day = items.get(keyOf(request.dayKey));
  const dayTokens = numberAttribute(day, 'tokenReservations');
  const refused: ReservationItem[] = [];
  if (!hasRoom(numberAttribute(incident, 'invocations'), request.incidentCap)) refused.push('incident');
  const dayTokensFit = dayTokens === undefined || dayTokens <= request.dayTokenCap - request.tokenReservation;
  if (!hasRoom(numberAttribute(day, 'invocations'), request.dayInvocationCap) || !dayTokensFit) refused.push('day');
  return refused;
}

// DynamoDB's ADD: a missing attribute counts as zero, and a missing item is created. expiresAt is
// written only where absent (if_not_exists), and only when the caller supplies one.
function addToCounter(items: Map<string, unknown>, key: RecordKey, amounts: Readonly<Record<string, number>>, expiresAt?: number): void {
  const mapKey = keyOf(key);
  const stored = items.get(mapKey);
  const next: Record<string, unknown> =
    typeof stored === 'object' && stored !== null ? structuredClone(stored as Record<string, unknown>) : { pk: key.pk, sk: key.sk };
  for (const [attribute, amount] of Object.entries(amounts)) next[attribute] = (numberAttribute(next, attribute) ?? 0) + amount;
  if (expiresAt !== undefined && next.expiresAt === undefined) next.expiresAt = expiresAt;
  items.set(mapKey, next);
}

function transactionConflictsOf(options: FixtureOptions): number {
  const conflicts = options.transactionConflicts ?? 0;
  if (!Number.isInteger(conflicts) || conflicts < 0) {
    throw new RangeError(`a fixture transaction conflict count must be a whole number from 0 up, not ${String(conflicts)}`);
  }
  return conflicts;
}

// The same conditional put as the event store, on the same table. GetItem applies no TTL filter, so
// an expired item DynamoDB has not deleted yet would still come back; the read checks expiresAt in
// code instead (D-65, research Pitfall 4). Every write that checks a condition checks and sets with
// no await between the two, so writes issued together under Promise.all resolve as DynamoDB's
// conditional writes do: one wins, the rest see its result.
export function createFixtureDecisionStore(options: FixtureOptions = {}, dryRun?: DryRunLog): DecisionStorePort {
  const { items } = options.store ?? createFixtureTableState();
  let conflictsLeft = transactionConflictsOf(options);

  return brandPort({
    async putIfAbsent(item) {
      await dryRun?.would('decisionStore.putIfAbsent', item.pk, item);
      rejectUnmarshallable(item);
      if (isLaneRecord(item)) {
        throw new RangeError('a decision store item never takes a LANE# partition key, which belongs to event records');
      }
      assertNotCounterItem(item);
      const key = keyOf(item);
      if (items.has(key)) return 'duplicate';
      items.set(key, structuredClone(item));
      return 'written';
    },
    async getItem(key, nowMs) {
      rejectUnmarshallable(nowMs);
      const item = items.get(keyOf(key));
      if (!isDecisionItem(item) || item.expiresAt <= Math.floor(nowMs / 1000)) return undefined;
      return structuredClone(item);
    },
    async updateIfVersion(key, expectedVersion, attributes, nowMs) {
      assertVersionedUpdate(key, expectedVersion, attributes);
      rejectUnmarshallable(attributes);
      rejectUnmarshallable(nowMs);
      await dryRun?.would('decisionStore.updateIfVersion', key.pk, { pk: key.pk, sk: key.sk, expectedVersion });
      const stored = items.get(keyOf(key));
      if (!isDecisionItem(stored) || stored.version !== expectedVersion) return 'conflict';
      items.set(keyOf(key), {
        ...stored,
        ...structuredClone(attributes),
        version: expectedVersion + 1,
        expiresAt: Math.floor(nowMs / 1000) + RETENTION_SECONDS,
      });
      return 'updated';
    },
    async reserveInvocation(request) {
      assertReservation(request);
      await dryRun?.would('decisionStore.reserveInvocation', request.incidentKey.pk, request);
      if (conflictsLeft > 0) {
        conflictsLeft -= 1;
        return { ok: false, reason: 'conflict' };
      }
      const refused = refusedItems(items, request);
      if (refused.length > 0) return { ok: false, reason: 'cap', items: refused };
      addToCounter(items, request.incidentKey, { invocations: 1 }, request.expiresAt);
      addToCounter(items, request.dayKey, { invocations: 1, tokenReservations: request.tokenReservation }, request.expiresAt);
      return { ok: true };
    },
    async recordUsage(usage) {
      assertUsage(usage);
      await dryRun?.would('decisionStore.recordUsage', usage.incidentKey.pk, usage);
      const amounts = { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, modelCalls: usage.modelCalls };
      addToCounter(items, usage.incidentKey, amounts);
      addToCounter(items, usage.dayKey, amounts);
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
