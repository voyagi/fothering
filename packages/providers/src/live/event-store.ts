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
import { LiveConfigMissingError, type EventStorePort } from '../port-types.js';

const CONDITIONAL_CHECK_FAILED = 'ConditionalCheckFailedException';
// A sort key range's upper bound must clear every suffix a bucket's own rows can carry
// (`#<eventType>#<identity>[#<recipientHmac>]`); every character those parts can hold sorts below
// U+FFFF, so appending it turns "up to this bucket" into "through the end of this bucket".
const SORT_KEY_UPPER_SENTINEL = '￿';

export interface CreateDynamoEventStoreOptions {
  tableName: string | undefined;
  client: () => DynamoDBDocumentClient;
  now: () => number;
}

function requireTableName(tableName: string | undefined): string {
  if (tableName === undefined) throw new LiveConfigMissingError('FOTHERING_TABLE_NAME');
  return tableName;
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

    async deleteRecord(key) {
      const tableName = requireTableName(options.tableName);
      await options.client().send(
        new DeleteCommand({ TableName: tableName, Key: { [PARTITION_KEY]: key.pk, [SORT_KEY]: key.sk } }),
      );
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
