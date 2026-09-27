import { DeleteCommand, GetCommand, PutCommand, QueryCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import {
  PARTITION_KEY,
  RECIPIENT_INDEX_NAME,
  RECIPIENT_KEY,
  SORT_KEY,
  TTL_ATTRIBUTE,
  bucketSortKeyPrefix,
  type EventRecord,
  type RecordKey,
} from '@fothering/core/records';
import { requireLiveConfig, type EventStorePort } from '../port-types.js';

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
  now: () => number;
}

function requireTableName(tableName: string | undefined): string {
  return requireLiveConfig(tableName, 'FOTHERING_TABLE_NAME');
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
        if (error instanceof Error && error.name === CONDITIONAL_CHECK_FAILED) return 'duplicate';
        throw error;
      }
    },

    // :from and :to are built with the same bucketSortKeyPrefix that recordKey uses to write, so a
    // range this rejects is a range no write could ever land in either.
    async queryLane(configurationSet, fromBucketMs, toBucketMs, nowMs) {
      const tableName = requireTableName(options.tableName);
      const from = bucketSortKeyPrefix(fromBucketMs);
      const to = `${bucketSortKeyPrefix(toBucketMs)}${SORT_KEY_UPPER_SENTINEL}`;
      const nowSeconds = Math.floor(nowMs / 1000);

      const records: EventRecord[] = [];
      let exclusiveStartKey: Record<string, unknown> | undefined;
      do {
        const page = await options.client().send(
          new QueryCommand({
            TableName: tableName,
            KeyConditionExpression: `${PARTITION_KEY} = :pk AND ${SORT_KEY} BETWEEN :from AND :to`,
            FilterExpression: `${TTL_ATTRIBUTE} > :now`,
            ExpressionAttributeValues: { ':pk': `LANE#${configurationSet}`, ':from': from, ':to': to, ':now': nowSeconds },
            ...(exclusiveStartKey === undefined ? {} : { ExclusiveStartKey: exclusiveStartKey }),
          }),
        );
        for (const item of page.Items ?? []) records.push(item as EventRecord);
        // A page whose filter emptied it can still carry LastEvaluatedKey: DynamoDB filters after
        // paging, so an empty page is never the end by itself.
        exclusiveStartKey = page.LastEvaluatedKey;
      } while (exclusiveStartKey !== undefined);
      return records;
    },

    async queryByRecipient(recipientHmac) {
      const tableName = requireTableName(options.tableName);
      const keys: RecordKey[] = [];
      let exclusiveStartKey: Record<string, unknown> | undefined;
      do {
        const page = await options.client().send(
          new QueryCommand({
            TableName: tableName,
            IndexName: RECIPIENT_INDEX_NAME,
            KeyConditionExpression: `${RECIPIENT_KEY} = :hmac`,
            ExpressionAttributeValues: { ':hmac': recipientHmac },
            ...(exclusiveStartKey === undefined ? {} : { ExclusiveStartKey: exclusiveStartKey }),
          }),
        );
        for (const item of page.Items ?? []) keys.push(item as RecordKey);
        exclusiveStartKey = page.LastEvaluatedKey;
      } while (exclusiveStartKey !== undefined);
      return keys;
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
        if (error instanceof Error && error.name === CONDITIONAL_CHECK_FAILED) return false;
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
  };
}
