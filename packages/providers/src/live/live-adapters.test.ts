import { describe, expect, it } from 'vitest';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { SQSClient } from '@aws-sdk/client-sqs';
import { SESv2Client } from '@aws-sdk/client-sesv2';
import { bucketSortKeyPrefix, type EventRecord, type RecordKey } from '@fothering/core/records';
import { selectKeyVersion } from '@fothering/core/address';
import { resolvePortTable } from '../ports.js';
import { lazyClient } from './lazy-client.js';
import { createDynamoEventStore } from './event-store.js';
import { AddressKeySecretError, createSecretsManagerAddressKey } from './address-key.js';
import { createSqsDeadLetter } from './dead-letter.js';
import { createSesReads } from './ses-reads.js';

// Region is fixed for every live adapter (SPEC constraint); the static credentials keep client
// construction from touching the real default provider chain (env, files, IMDS), which this
// worker's guards already strip and block, so a leak here would fail loud rather than quiet.
const REGION = 'eu-central-1';
const FAKE_CREDENTIALS = { accessKeyId: 'fake-access-key-id', secretAccessKey: 'fake-secret-access-key' };

interface RecordedCommand {
  name: string;
  input: unknown;
}

// Replaces a real client's own send with a recorder plus a canned response, exactly as the plan
// specifies: nothing built here ever reaches the network, because send never runs the client's own
// middleware stack once it is reassigned.
function stubSend(client: { send: unknown }, handler: (command: RecordedCommand) => unknown): RecordedCommand[] {
  const calls: RecordedCommand[] = [];
  const send = async (command: { constructor: { name: string }; input: unknown }): Promise<unknown> => {
    const recorded: RecordedCommand = { name: command.constructor.name, input: command.input };
    calls.push(recorded);
    return handler(recorded);
  };
  (client as { send: unknown }).send = send;
  return calls;
}

function dynamoClient(): DynamoDBDocumentClient {
  return DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION, credentials: FAKE_CREDENTIALS }));
}

describe('lazyClient', () => {
  it('calls create once on first use and memoizes the result', () => {
    let calls = 0;
    const getClient = lazyClient(() => {
      calls += 1;
      return { id: calls };
    });
    expect(calls).toBe(0);
    const first = getClient();
    const second = getClient();
    expect(calls).toBe(1);
    expect(first).toBe(second);
  });
});

describe('createDynamoEventStore', () => {
  it('writes with a conditional put and maps ConditionalCheckFailedException to duplicate', async () => {
    const client = dynamoClient();
    const record = { pk: 'LANE#x', sk: 'B#0000000000000#Send#m1' } as unknown as EventRecord;
    let putCount = 0;
    const calls = stubSend(client, (command) => {
      if (command.name !== 'PutCommand') throw new Error(`unexpected command ${command.name}`);
      putCount += 1;
      if (putCount === 2) {
        const error = new Error('conditional failed');
        error.name = 'ConditionalCheckFailedException';
        throw error;
      }
      return {};
    });
    const store = createDynamoEventStore({ tableName: 'events', client: () => client, now: () => 0 });

    await expect(store.putIfAbsent(record)).resolves.toBe('written');
    await expect(store.putIfAbsent(record)).resolves.toBe('duplicate');
    expect(calls).toHaveLength(2);
    expect(calls[0]?.input).toMatchObject({ TableName: 'events', Item: record, ConditionExpression: 'attribute_not_exists(pk)' });
  });

  it('propagates any rejection that is not a conditional check failure', async () => {
    const client = dynamoClient();
    stubSend(client, () => {
      throw new Error('network blip');
    });
    const store = createDynamoEventStore({ tableName: 'events', client: () => client, now: () => 0 });
    await expect(store.putIfAbsent({ pk: 'x', sk: 'y' } as unknown as EventRecord)).rejects.toThrow('network blip');
  });

  it('queries a lane with the padded sort-key range and the now filter, following an emptied page', async () => {
    const client = dynamoClient();
    const fromBucketMs = 0;
    const toBucketMs = 300_000;
    const nowMs = 3_600_000;
    const record = { pk: 'LANE#x', sk: `${bucketSortKeyPrefix(toBucketMs)}#Send#m2` } as unknown as EventRecord;

    const calls = stubSend(client, (command) => {
      if (command.name !== 'QueryCommand') throw new Error(`unexpected command ${command.name}`);
      const input = command.input as { ExclusiveStartKey?: unknown };
      // The first page's filter empties it, but LastEvaluatedKey still names more pages: a store
      // that reads an empty Items array as the end would drop the record on the second page.
      if (input.ExclusiveStartKey === undefined) {
        return { Items: [], LastEvaluatedKey: { pk: 'LANE#x', sk: 'B#0000000000000#Send#m1' } };
      }
      return { Items: [record] };
    });

    const store = createDynamoEventStore({ tableName: 'events', client: () => client, now: () => nowMs });
    const results = await store.queryLane('x', fromBucketMs, toBucketMs, nowMs);

    expect(calls).toHaveLength(2);
    expect(results).toEqual([record]);
    expect(calls[0]?.input).toMatchObject({
      TableName: 'events',
      KeyConditionExpression: 'pk = :pk AND sk BETWEEN :from AND :to',
      FilterExpression: 'expiresAt > :now',
      ExpressionAttributeValues: {
        ':pk': 'LANE#x',
        ':from': bucketSortKeyPrefix(fromBucketMs),
        ':to': `${bucketSortKeyPrefix(toBucketMs)}￿`,
        ':now': Math.floor(nowMs / 1000),
      },
    });
    expect(calls[1]?.input).toMatchObject({ ExclusiveStartKey: { pk: 'LANE#x', sk: 'B#0000000000000#Send#m1' } });
  });

  it('rejects a bucket bound that is NaN, negative, fractional or 14 digits long, sending no QueryCommand', async () => {
    const client = dynamoClient();
    const calls = stubSend(client, () => {
      throw new Error('must not be called');
    });
    const store = createDynamoEventStore({ tableName: 'events', client: () => client, now: () => 0 });

    for (const bad of [Number.NaN, -1, 0.5, 1e13]) {
      await expect(store.queryLane('x', bad, 300_000, 0)).rejects.toThrow(RangeError);
      await expect(store.queryLane('x', 0, bad, 0)).rejects.toThrow(RangeError);
    }
    expect(calls).toHaveLength(0);
  });

  it('queries the recipient index on recipientHmac and returns every key across pages', async () => {
    const client = dynamoClient();
    const calls = stubSend(client, (command) => {
      if (command.name !== 'QueryCommand') throw new Error(`unexpected command ${command.name}`);
      const input = command.input as { ExclusiveStartKey?: unknown };
      if (input.ExclusiveStartKey === undefined) {
        return { Items: [{ pk: 'LANE#a', sk: 'B#0000000000001#Send#m1' }], LastEvaluatedKey: { pk: 'LANE#a', sk: 'B#0000000000001#Send#m1' } };
      }
      return { Items: [{ pk: 'LANE#b', sk: 'B#0000000000002#Send#m2' }] };
    });
    const store = createDynamoEventStore({ tableName: 'events', client: () => client, now: () => 0 });

    const keys: RecordKey[] = await store.queryByRecipient('recipient-hash');
    expect(keys).toEqual([
      { pk: 'LANE#a', sk: 'B#0000000000001#Send#m1' },
      { pk: 'LANE#b', sk: 'B#0000000000002#Send#m2' },
    ]);
    expect(calls[0]?.input).toMatchObject({
      TableName: 'events',
      IndexName: 'byRecipient',
      KeyConditionExpression: 'recipientHmac = :hmac',
      ExpressionAttributeValues: { ':hmac': 'recipient-hash' },
    });
  });

  it('deletes a record with DeleteCommand', async () => {
    const client = dynamoClient();
    const calls = stubSend(client, () => ({}));
    const store = createDynamoEventStore({ tableName: 'events', client: () => client, now: () => 0 });

    await store.deleteRecord({ pk: 'LANE#x', sk: 'B#0000000000001#Send#m1' });
    expect(calls[0]?.name).toBe('DeleteCommand');
    expect(calls[0]?.input).toMatchObject({ TableName: 'events', Key: { pk: 'LANE#x', sk: 'B#0000000000001#Send#m1' } });
  });

  it('reads a record with ConsistentRead true', async () => {
    const client = dynamoClient();
    const record = { pk: 'LANE#x', sk: 'B#0000000000001#Send#m1' } as unknown as EventRecord;
    const calls = stubSend(client, () => ({ Item: record }));
    const store = createDynamoEventStore({ tableName: 'events', client: () => client, now: () => 0 });

    await expect(store.getRecord({ pk: 'LANE#x', sk: 'B#0000000000001#Send#m1' })).resolves.toEqual(record);
    expect(calls[0]?.name).toBe('GetCommand');
    expect(calls[0]?.input).toMatchObject({
      TableName: 'events',
      Key: { pk: 'LANE#x', sk: 'B#0000000000001#Send#m1' },
      ConsistentRead: true,
    });
  });

  it('throws LiveConfigMissingError naming FOTHERING_TABLE_NAME on the first call, never at resolution', async () => {
    let constructed = 0;
    const store = createDynamoEventStore({
      tableName: undefined,
      client: () => {
        constructed += 1;
        return dynamoClient();
      },
      now: () => 0,
    });
    expect(constructed).toBe(0);
    await expect(store.putIfAbsent({} as EventRecord)).rejects.toMatchObject({
      name: 'LiveConfigMissingError',
      envVar: 'FOTHERING_TABLE_NAME',
    });
    expect(constructed).toBe(0);
  });
});

function secretsManagerClient(): SecretsManagerClient {
  return new SecretsManagerClient({ region: REGION, credentials: FAKE_CREDENTIALS });
}

const K1_SECRET = 'k1-secret-material-at-least-32-characters';
const K2_SECRET = 'k2-secret-material-at-least-32-characters';

describe('createSecretsManagerAddressKey', () => {
  it('parses every retained version with its activeFromMs', async () => {
    const client = secretsManagerClient();
    stubSend(client, () => ({
      SecretString: JSON.stringify({ current: 'k2', activeFrom: { k1: 0, k2: 500 }, k1: K1_SECRET, k2: K2_SECRET }),
    }));
    const adapter = createSecretsManagerAddressKey({ secretId: 'address-key', client: () => client, now: () => 0 });

    await expect(adapter.getKeySet()).resolves.toEqual({
      versions: [
        { id: 'k1', secret: K1_SECRET, activeFromMs: 0 },
        { id: 'k2', secret: K2_SECRET, activeFromMs: 500 },
      ],
    });
  });

  it('serves a second call within 5 minutes from cache, and re-reads once 5 minutes have passed', async () => {
    let currentTimeMs = 0;
    let fetches = 0;
    const client = secretsManagerClient();
    stubSend(client, () => {
      fetches += 1;
      return { SecretString: JSON.stringify({ current: 'k1', activeFrom: { k1: 0 }, k1: K1_SECRET }) };
    });
    const adapter = createSecretsManagerAddressKey({ secretId: 'address-key', client: () => client, now: () => currentTimeMs });

    await adapter.getKeySet();
    expect(fetches).toBe(1);
    currentTimeMs = 4 * 60 * 1000;
    await adapter.getKeySet();
    expect(fetches).toBe(1);
    currentTimeMs = 5 * 60 * 1000 + 1;
    await adapter.getKeySet();
    expect(fetches).toBe(2);
  });

  // D-34's rotation rule: a new version's activeFrom sits at least 10 minutes after it is written,
  // covering the worst-case 5-minute per-container cache twice over. Two containers that read the
  // secret on opposite sides of the write must still agree on which key a send at that moment uses.
  describe('two containers agree only when the rotation honors the 10-minute margin', () => {
    const WRITE_MS = 1_700_000_000_000;

    function newSecretJson(k2ActiveFromMs: number): string {
      return JSON.stringify({ current: 'k2', activeFrom: { k1: 0, k2: k2ActiveFromMs }, k1: K1_SECRET, k2: K2_SECRET });
    }
    function oldSecretJson(): string {
      return JSON.stringify({ current: 'k1', activeFrom: { k1: 0 }, k1: K1_SECRET });
    }

    function scenario(k2ActiveFromMs: number) {
      let currentTimeMs = 0;
      const client = secretsManagerClient();
      stubSend(client, () => ({ SecretString: currentTimeMs < WRITE_MS ? oldSecretJson() : newSecretJson(k2ActiveFromMs) }));
      const now = (): number => currentTimeMs;
      const containerA = createSecretsManagerAddressKey({ secretId: 'address-key', client: () => client, now });
      const containerB = createSecretsManagerAddressKey({ secretId: 'address-key', client: () => client, now });
      return {
        async prime(container: typeof containerA, atMs: number): Promise<void> {
          currentTimeMs = atMs;
          await container.getKeySet();
        },
        async selectedAt(sendMs: number): Promise<{ a: string; b: string }> {
          currentTimeMs = sendMs;
          const [keySetA, keySetB] = await Promise.all([containerA.getKeySet(), containerB.getKeySet()]);
          return { a: selectKeyVersion(keySetA, sendMs).id, b: selectKeyVersion(keySetB, sendMs).id };
        },
        containerA,
        containerB,
      };
    }

    it('choose the same version when the new activeFrom sits 10 minutes after the write', async () => {
      const k2ActiveFromMs = WRITE_MS + 10 * 60 * 1000;
      const s = scenario(k2ActiveFromMs);
      await s.prime(s.containerA, WRITE_MS - 60_000);
      await s.prime(s.containerB, WRITE_MS + 60_000);

      const { a, b } = await s.selectedAt(k2ActiveFromMs);
      expect(a).toBe('k2');
      expect(b).toBe('k2');
    });

    it('disagree when the new activeFrom sits inside the cache window instead', async () => {
      const k2ActiveFromMs = WRITE_MS + 60_000;
      const s = scenario(k2ActiveFromMs);
      await s.prime(s.containerA, WRITE_MS - 60_000);
      await s.prime(s.containerB, WRITE_MS + 60_000);

      const { a, b } = await s.selectedAt(k2ActiveFromMs);
      expect(a).toBe('k1');
      expect(b).toBe('k2');
      expect(a).not.toBe(b);
    });
  });

  it('refuses a secret whose current does not name the newest activeFrom, without echoing any secret value', async () => {
    const client = secretsManagerClient();
    stubSend(client, () => ({
      SecretString: JSON.stringify({ current: 'k1', activeFrom: { k1: 0, k2: 1000 }, k1: K1_SECRET, k2: K2_SECRET }),
    }));
    const adapter = createSecretsManagerAddressKey({ secretId: 'address-key', client: () => client, now: () => 0 });

    await expect(adapter.getKeySet()).rejects.toBeInstanceOf(AddressKeySecretError);
    try {
      await adapter.getKeySet();
      throw new Error('expected getKeySet to reject');
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      expect(message).not.toContain(K1_SECRET);
      expect(message).not.toContain(K2_SECRET);
    }
  });

  it('refuses a secret that fails its schema, without echoing any secret value', async () => {
    const client = secretsManagerClient();
    stubSend(client, () => ({ SecretString: JSON.stringify({ current: 'k1', activeFrom: { k1: 0 }, k1: 'too-short' }) }));
    const adapter = createSecretsManagerAddressKey({ secretId: 'address-key', client: () => client, now: () => 0 });

    await expect(adapter.getKeySet()).rejects.toBeInstanceOf(AddressKeySecretError);
  });

  it('throws LiveConfigMissingError naming FOTHERING_ADDRESS_KEY_SECRET_ID on the first call, never at resolution', async () => {
    let constructed = 0;
    const adapter = createSecretsManagerAddressKey({
      secretId: undefined,
      client: () => {
        constructed += 1;
        return secretsManagerClient();
      },
      now: () => 0,
    });
    expect(constructed).toBe(0);
    await expect(adapter.getKeySet()).rejects.toMatchObject({ name: 'LiveConfigMissingError', envVar: 'FOTHERING_ADDRESS_KEY_SECRET_ID' });
    expect(constructed).toBe(0);
  });
});

describe('createSqsDeadLetter', () => {
  const QUEUE_URL = 'https://sqs.eu-central-1.amazonaws.com/000000000000/fothering-dlq';

  it('sends one SendMessageCommand whose body is the JSON of the records', async () => {
    const client = new SQSClient({ region: REGION, credentials: FAKE_CREDENTIALS });
    const calls = stubSend(client, () => ({ MessageId: 'm1' }));
    const deadLetter = createSqsDeadLetter({ queueUrl: QUEUE_URL, client: () => client });
    const records = [{ messageId: 'a' } as unknown as EventRecord];

    await deadLetter.send(records);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.name).toBe('SendMessageCommand');
    expect(calls[0]?.input).toMatchObject({ QueueUrl: QUEUE_URL, MessageBody: JSON.stringify({ records }) });
  });

  it('throws LiveConfigMissingError naming FOTHERING_DLQ_URL on the first call, never at resolution', async () => {
    let constructed = 0;
    const deadLetter = createSqsDeadLetter({
      queueUrl: undefined,
      client: () => {
        constructed += 1;
        return new SQSClient({ region: REGION, credentials: FAKE_CREDENTIALS });
      },
    });
    expect(constructed).toBe(0);
    await expect(deadLetter.send([])).rejects.toMatchObject({ name: 'LiveConfigMissingError', envVar: 'FOTHERING_DLQ_URL' });
    expect(constructed).toBe(0);
  });
});

describe('createSesReads', () => {
  function sesClient(): SESv2Client {
    return new SESv2Client({ region: REGION, credentials: FAKE_CREDENTIALS });
  }

  it("getEmailIdentity returns the identity's ConfigurationSetName", async () => {
    const client = sesClient();
    stubSend(client, () => ({ ConfigurationSetName: 'fothering-transactional' }));
    const reads = createSesReads({ client: () => client });

    await expect(reads.getEmailIdentity('sender@example.com')).resolves.toBe('fothering-transactional');
  });

  it('listEmailIdentities collects IdentityName across two stubbed pages', async () => {
    const client = sesClient();
    stubSend(client, (command) => {
      const input = command.input as { NextToken?: string };
      if (input.NextToken === 'page-2') return { EmailIdentities: [{ IdentityName: 'b.example.com' }] };
      return { EmailIdentities: [{ IdentityName: 'a.example.com' }], NextToken: 'page-2' };
    });
    const reads = createSesReads({ client: () => client });

    await expect(reads.listEmailIdentities()).resolves.toEqual(['a.example.com', 'b.example.com']);
  });

  it('getConfigurationSetEventDestinations maps Name, Enabled, MatchingEventTypes and eventBridge true only with an EventBridgeDestination', async () => {
    const client = sesClient();
    stubSend(client, () => ({
      EventDestinations: [
        {
          Name: 'eb',
          Enabled: true,
          MatchingEventTypes: ['SEND', 'BOUNCE'],
          EventBridgeDestination: { EventBusArn: 'arn:aws:events:eu-central-1:000000000000:event-bus/default' },
        },
        { Name: 'sns', Enabled: false, MatchingEventTypes: ['COMPLAINT'] },
      ],
    }));
    const reads = createSesReads({ client: () => client });

    await expect(reads.getConfigurationSetEventDestinations('fothering-transactional')).resolves.toEqual([
      { name: 'eb', enabled: true, eventBridge: true, matchingEventTypes: ['SEND', 'BOUNCE'] },
      { name: 'sns', enabled: false, eventBridge: false, matchingEventTypes: ['COMPLAINT'] },
    ]);
  });
});

describe('resolving the real port table with counting client factories', () => {
  function countingFactory<T>(client: T): { factory: () => T; count: () => number } {
    let count = 0;
    return {
      factory: () => {
        count += 1;
        return client;
      },
      count: () => count,
    };
  }

  it('constructs 0 clients at resolution, and exactly 1 per row on its first port call', async () => {
    const stubbedDynamo = dynamoClient();
    stubSend(stubbedDynamo, (command) => {
      if (command.name === 'PutCommand') return {};
      if (command.name === 'GetCommand') return {};
      throw new Error(`unexpected command ${command.name}`);
    });
    const dynamo = countingFactory(stubbedDynamo);

    const stubbedSecretsManager = secretsManagerClient();
    stubSend(stubbedSecretsManager, () => ({
      SecretString: JSON.stringify({ current: 'k1', activeFrom: { k1: 0 }, k1: K1_SECRET }),
    }));
    const secretsManager = countingFactory(stubbedSecretsManager);

    const stubbedSqs = new SQSClient({ region: REGION, credentials: FAKE_CREDENTIALS });
    stubSend(stubbedSqs, () => ({ MessageId: 'm1' }));
    const sqs = countingFactory(stubbedSqs);

    const { ports } = resolvePortTable({
      runtimeContext: 'deployed',
      switchValue: undefined,
      liveConfig: {
        tableName: 'events',
        addressKeySecretId: 'address-key',
        deadLetterQueueUrl: 'https://sqs.eu-central-1.amazonaws.com/000000000000/fothering-dlq',
      },
      liveClients: { dynamoDb: dynamo.factory, secretsManager: secretsManager.factory, sqs: sqs.factory },
      dryRunSink: () => {},
    });

    expect(dynamo.count()).toBe(0);
    expect(secretsManager.count()).toBe(0);
    expect(sqs.count()).toBe(0);

    await ports.eventStore.putIfAbsent({ pk: 'LANE#x', sk: 'B#0000000000000#Send#m1' } as EventRecord);
    expect(dynamo.count()).toBe(1);
    expect(secretsManager.count()).toBe(0);
    expect(sqs.count()).toBe(0);

    await ports.addressKey.getKeySet();
    expect(secretsManager.count()).toBe(1);
    expect(dynamo.count()).toBe(1);

    await ports.deadLetter.send([]);
    expect(sqs.count()).toBe(1);

    // A second operation on an already-resolved port never rebuilds its client.
    await ports.eventStore.getRecord({ pk: 'LANE#x', sk: 'B#0000000000000#Send#m1' });
    expect(dynamo.count()).toBe(1);
  });
});
