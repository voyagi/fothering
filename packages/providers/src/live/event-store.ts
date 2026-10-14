import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
  type DynamoDBDocumentClient,
  type QueryCommandInput,
  type TransactWriteCommandInput,
  type UpdateCommandInput,
} from '@aws-sdk/lib-dynamodb';
import {
  PARTITION_KEY,
  RECIPIENT_INDEX_NAME,
  RECIPIENT_KEY,
  RETENTION_SECONDS,
  SORT_KEY,
  TTL_ATTRIBUTE,
  bucketSortKeyPrefix,
  lanePartitionKey,
  type EventRecord,
  type RecordKey,
} from '@fothering/core/records';
import { assertFoldWindow } from '@fothering/core/window-fold';
import {
  assertDecisionItemKey,
  assertReservation,
  assertUsage,
  assertVersionedUpdate,
  expiryClockSeconds,
  requireLiveConfig,
  unexpiredDecisionItem,
  type DecisionStorePort,
  type EventStorePort,
  type ReservationItem,
  type ReservationRequest,
  type ReservationResult,
} from '../port-types.js';
import { hasErrorName } from './error-name.js';

const CONDITIONAL_CHECK_FAILED = 'ConditionalCheckFailedException';
// A sort key range's upper bound must clear every key a bucket's own rows carry. recordKey always
// follows the bucket prefix with '#' (byte 0x23), and DynamoDB compares string keys by the bytes
// of their UTF-8 encoding, where U+FFFF is EF BF BF. So every key of the bucket sorts below its
// prefix followed by U+FFFF, whatever comes after that '#', and the next bucket's prefix, whose
// zero-padded digits differ, sorts above it: appending U+FFFF turns "up to this bucket" into
// "through the end of this bucket". The escape keeps the noncharacter visible in the source.
const SORT_KEY_UPPER_SENTINEL = '\uFFFF';

export interface CreateDynamoEventStoreOptions {
  tableName: string | undefined;
  client: () => DynamoDBDocumentClient;
}

function requireTableName(tableName: string | undefined): string {
  return requireLiveConfig(tableName, 'FOTHERING_TABLE_NAME');
}

function tableKey(key: RecordKey): Record<string, string> {
  return { [PARTITION_KEY]: key.pk, [SORT_KEY]: key.sk };
}

// Runs one query to its last page, handing each page over before the next is asked for. Each page
// sends the same input plus the key the page before it stopped at. A page whose filter emptied it
// can still carry LastEvaluatedKey: DynamoDB filters after paging, so an empty page is never the end
// by itself.
async function forEachPage<Item>(
  client: () => DynamoDBDocumentClient,
  input: QueryCommandInput,
  onPage: (items: readonly Item[]) => void,
): Promise<void> {
  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const page = await client().send(
      new QueryCommand({ ...input, ...(exclusiveStartKey === undefined ? {} : { ExclusiveStartKey: exclusiveStartKey }) }),
    );
    onPage((page.Items ?? []) as Item[]);
    exclusiveStartKey = page.LastEvaluatedKey;
  } while (exclusiveStartKey !== undefined);
}

async function queryAllPages<Item>(client: () => DynamoDBDocumentClient, input: QueryCommandInput): Promise<Item[]> {
  const items: Item[] = [];
  await forEachPage<Item>(client, input, (page) => {
    items.push(...page);
  });
  return items;
}

// :from and :to are built with the same bucketSortKeyPrefix that recordKey uses to write, so a range
// this rejects is a range no write could ever land in either.
function laneQueryInput(tableName: string, configurationSet: string, fromBucketMs: number, toBucketMs: number, nowMs: number): QueryCommandInput {
  const from = bucketSortKeyPrefix(fromBucketMs);
  const to = `${bucketSortKeyPrefix(toBucketMs)}${SORT_KEY_UPPER_SENTINEL}`;
  return {
    TableName: tableName,
    KeyConditionExpression: `${PARTITION_KEY} = :pk AND ${SORT_KEY} BETWEEN :from AND :to`,
    FilterExpression: `${TTL_ATTRIBUTE} > :now`,
    ExpressionAttributeValues: { ':pk': lanePartitionKey(configurationSet), ':from': from, ':to': to, ':now': Math.floor(nowMs / 1000) },
  };
}

export function createDynamoEventStore(options: CreateDynamoEventStoreOptions): EventStorePort {
  return {
    async putIfAbsent(record) {
      const tableName = requireTableName(options.tableName);
      try {
        await options.client().send(
          new PutCommand({
            TableName: tableName,
            Item: record,
            ConditionExpression: `attribute_not_exists(${PARTITION_KEY})`,
          }),
        );
        return 'written';
      } catch (error) {
        if (hasErrorName(error, CONDITIONAL_CHECK_FAILED)) return 'duplicate';
        throw error;
      }
    },

    async queryLane(configurationSet, fromBucketMs, toBucketMs, nowMs) {
      const tableName = requireTableName(options.tableName);
      return queryAllPages<EventRecord>(options.client, laneQueryInput(tableName, configurationSet, fromBucketMs, toBucketMs, nowMs));
    },

    async queryByRecipient(recipientHmac) {
      const tableName = requireTableName(options.tableName);
      return queryAllPages<RecordKey>(options.client, {
        TableName: tableName,
        IndexName: RECIPIENT_INDEX_NAME,
        KeyConditionExpression: `${RECIPIENT_KEY} = :hmac`,
        ExpressionAttributeValues: { ':hmac': recipientHmac },
      });
    },

    // The recipient index can still name a record for a moment after it is deleted, so the forget
    // path must tell a removal from a no-op. The condition answers that without reading the item
    // back: a key with no stored record fails the check instead of succeeding silently.
    async deleteRecord(key) {
      const tableName = requireTableName(options.tableName);
      try {
        await options.client().send(
          new DeleteCommand({
            TableName: tableName,
            Key: { [PARTITION_KEY]: key.pk, [SORT_KEY]: key.sk },
            ConditionExpression: `attribute_exists(${PARTITION_KEY})`,
          }),
        );
        return true;
      } catch (error) {
        if (hasErrorName(error, CONDITIONAL_CHECK_FAILED)) return false;
        throw error;
      }
    },

    async getRecord(key) {
      const tableName = requireTableName(options.tableName);
      const result = await options.client().send(
        new GetCommand({ TableName: tableName, Key: { [PARTITION_KEY]: key.pk, [SORT_KEY]: key.sk }, ConsistentRead: true }),
      );
      return result.Item as EventRecord | undefined;
    },

    // The fold sees one page at a time and keeps only its own state, so a window's memory is bounded
    // by the fold, never by the window's record count (D-43). The window bound is checked before any
    // query, and the TTL filter stays on the query beside the fold's own expiry check.
    async foldLane(configurationSet, fromBucketMs, toBucketMs, nowMs, fold) {
      assertFoldWindow(fromBucketMs, toBucketMs);
      const tableName = requireTableName(options.tableName);
      let state = fold.initial;
      await forEachPage<EventRecord>(options.client, laneQueryInput(tableName, configurationSet, fromBucketMs, toBucketMs, nowMs), (page) => {
        state = fold.step(state, page);
      });
      return state;
    },
  };
}

const TRANSACTION_CANCELED = 'TransactionCanceledException';
const RESERVATION_ITEMS: readonly ReservationItem[] = ['incident', 'day'];
const VERSION_ATTRIBUTE = 'version';

// Cancellation reasons come in the order of the requested items. Only a failed condition is a cap; a
// TransactionConflict is two cycles racing, which a retry settles, so it must never read as the cap
// that ends an incident (research Pitfall 6). Anything else is not this adapter's to answer.
function cancellationCodes(error: unknown): (string | undefined)[] {
  if (!hasErrorName(error, TRANSACTION_CANCELED)) return [];
  return ((error as { CancellationReasons?: readonly { Code?: string }[] }).CancellationReasons ?? []).map((reason) => reason.Code);
}

function failedCondition(error: unknown): boolean {
  return cancellationCodes(error).includes('ConditionalCheckFailed');
}

function reservationRefusal(error: unknown): ReservationResult {
  if (!hasErrorName(error, TRANSACTION_CANCELED)) throw error;
  const codes = cancellationCodes(error);
  const capped = RESERVATION_ITEMS.filter((_item, index) => codes[index] === 'ConditionalCheckFailed');
  if (capped.length > 0) return { ok: false, reason: 'cap', items: capped };
  if (codes.includes('TransactionConflict')) return { ok: false, reason: 'conflict' };
  throw error;
}

// The two counter updates D-67 names. Each condition also accepts a missing attribute, so the first
// reservation of a day creates its counter at one; expiresAt is set only where absent, so a counter
// keeps the expiry of its first write and can never be extended into a reset.
function reservationItems(tableName: string, request: ReservationRequest): TransactWriteCommandInput['TransactItems'] {
  return [
    {
      Update: {
        TableName: tableName,
        Key: tableKey(request.incidentKey),
        UpdateExpression: 'ADD invocations :one SET expiresAt = if_not_exists(expiresAt, :exp)',
        ConditionExpression: 'attribute_not_exists(invocations) OR invocations < :incidentCap',
        ExpressionAttributeValues: { ':one': 1, ':incidentCap': request.incidentCap, ':exp': request.expiresAt },
      },
    },
    {
      Update: {
        TableName: tableName,
        Key: tableKey(request.dayKey),
        UpdateExpression: 'ADD invocations :one, tokenReservations :tokens SET expiresAt = if_not_exists(expiresAt, :exp)',
        ConditionExpression:
          '(attribute_not_exists(invocations) OR invocations < :dayCap) AND (attribute_not_exists(tokenReservations) OR tokenReservations <= :tokenRoom)',
        ExpressionAttributeValues: {
          ':one': 1,
          ':tokens': request.tokenReservation,
          ':dayCap': request.dayInvocationCap,
          ':tokenRoom': request.dayTokenCap - request.tokenReservation,
          ':exp': request.expiresAt,
        },
      },
    },
  ];
}

// Caller attributes go through placeholders: STATE and STATUS are DynamoDB reserved words, and an
// attribute name is whatever the incident lifecycle chooses.
function versionedUpdateInput(
  tableName: string,
  key: RecordKey,
  expectedVersion: number,
  attributes: Readonly<Record<string, unknown>>,
  nowMs: number,
): UpdateCommandInput {
  const names: Record<string, string> = {};
  const values: Record<string, unknown> = {};
  const assignments = Object.entries(attributes).map(([name, value], index) => {
    names[`#a${index}`] = name;
    values[`:a${index}`] = value;
    return `#a${index} = :a${index}`;
  });
  return {
    TableName: tableName,
    Key: tableKey(key),
    UpdateExpression: `SET ${[...assignments, `${VERSION_ATTRIBUTE} = :next`, `${TTL_ATTRIBUTE} = :expiresAt`].join(', ')}`,
    ConditionExpression: `${VERSION_ATTRIBUTE} = :expected`,
    ...(assignments.length === 0 ? {} : { ExpressionAttributeNames: names }),
    ExpressionAttributeValues: {
      ...values,
      ':expected': expectedVersion,
      ':next': expectedVersion + 1,
      ':expiresAt': Math.floor(nowMs / 1000) + RETENTION_SECONDS,
    },
  };
}

// The decision store shares the event table and its client (D-66). Every request is checked by the
// same functions the fixture runs, before anything is sent.
export function createDynamoDecisionStore(options: CreateDynamoEventStoreOptions): DecisionStorePort {
  return {
    // An item holding no expiresAt is meant to block the put, as the fixture's does; that a comparison on
    // a missing attribute is false is UNVERIFIED in the condition docs read, and every item put here
    // carries expiresAt (isDecisionStoreItem), so the case only arises from a hand-written item.
    async putIfAbsent(item, nowMs) {
      assertDecisionItemKey(item);
      const tableName = requireTableName(options.tableName);
      try {
        await options.client().send(
          new PutCommand({
            TableName: tableName,
            Item: item,
            ConditionExpression: `attribute_not_exists(${PARTITION_KEY}) OR ${TTL_ATTRIBUTE} <= :now`,
            ExpressionAttributeValues: { ':now': expiryClockSeconds(nowMs) },
          }),
        );
        return 'written';
      } catch (error) {
        if (hasErrorName(error, CONDITIONAL_CHECK_FAILED)) return 'duplicate';
        throw error;
      }
    },

    async getItem(key, nowMs) {
      const tableName = requireTableName(options.tableName);
      const result = await options.client().send(new GetCommand({ TableName: tableName, Key: tableKey(key), ConsistentRead: true }));
      return unexpiredDecisionItem(result.Item, nowMs);
    },

    async updateIfVersion(key, expectedVersion, attributes, nowMs) {
      assertVersionedUpdate(key, expectedVersion, attributes);
      const tableName = requireTableName(options.tableName);
      try {
        await options.client().send(new UpdateCommand(versionedUpdateInput(tableName, key, expectedVersion, attributes, nowMs)));
        return 'updated';
      } catch (error) {
        if (hasErrorName(error, CONDITIONAL_CHECK_FAILED)) return 'conflict';
        throw error;
      }
    },

    async reserveInvocation(request) {
      assertReservation(request);
      const tableName = requireTableName(options.tableName);
      try {
        await options.client().send(new TransactWriteCommand({ TransactItems: reservationItems(tableName, request) }));
        return { ok: true };
      } catch (error) {
        return reservationRefusal(error);
      }
    },

    // ADD only, so nothing here can take a counter down. ADD on a missing item would create it with no
    // expiresAt, outliving the retention period, so both updates require the item a reservation made,
    // and one transaction keeps a refusal from leaving usage on one counter but not the other.
    async recordUsage(usage) {
      assertUsage(usage);
      const tableName = requireTableName(options.tableName);
      const update = (key: RecordKey) => ({
        Update: {
          TableName: tableName,
          Key: tableKey(key),
          UpdateExpression: 'ADD inputTokens :inputTokens, outputTokens :outputTokens, modelCalls :modelCalls',
          ConditionExpression: `attribute_exists(${PARTITION_KEY})`,
          ExpressionAttributeValues: { ':inputTokens': usage.inputTokens, ':outputTokens': usage.outputTokens, ':modelCalls': usage.modelCalls },
        },
      });
      try {
        await options.client().send(new TransactWriteCommand({ TransactItems: [update(usage.incidentKey), update(usage.dayKey)] }));
        return 'recorded';
      } catch (error) {
        if (failedCondition(error)) return 'not-reserved';
        throw error;
      }
    },
  };
}
