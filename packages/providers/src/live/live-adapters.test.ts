import * as dnsPromises from 'node:dns/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import fc from 'fast-check';
import { BedrockAgentCoreClient } from '@aws-sdk/client-bedrock-agentcore';
import {
  Agent,
  BedrockModel,
  ConstantBackoff,
  DefaultModelRetryStrategy,
  Message,
  ModelThrottledError,
  TextBlock,
  type BedrockModelOptions,
  type ModelStreamEvent,
} from '@strands-agents/sdk';
import { MODEL_VALUES } from '@fothering/core/model-values';
import { DynamoDBClient, TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { SQSClient } from '@aws-sdk/client-sqs';
import { NotFoundException, SESv2Client, TooManyRequestsException } from '@aws-sdk/client-sesv2';
import {
  RETENTION_SECONDS,
  SES_EVENT_TYPES,
  bucketSortKeyPrefix,
  isStorableBucketStart,
  recordKey,
  type EventRecord,
  type RecordKey,
} from '@fothering/core/records';
import { selectKeyVersion } from '@fothering/core/address';
import { BUCKET_MS, bucketStartMs } from '@fothering/core/buckets';
import { propertySeed } from '@fothering/core/test/property-seed';
import { scenarioRecords } from '@fothering/core/test/event-arbitraries';
import {
  MAX_WINDOW_BUCKETS,
  WindowTooLongError,
  createWindowFold,
  spikeWindowFor,
  summarizeWindow,
  type LaneFold,
  type WindowFoldState,
} from '@fothering/core/window-fold';
import { findLane, parseLaneMap } from '@fothering/core/lanes';
import lanesJson from '../../../../lanes.json' with { type: 'json' };
import type { LaneAttemptRequest, ReservationRequest, UsageRecord } from '../port-types.js';
import { minimizeEvent } from '@fothering/core/minimize';
import { parseSesEvent } from '@fothering/core/ses-events';
import { resolvePortTable } from '../ports.js';
import { SES_READ_SPACING_MS } from '../ses-facts.js';
import { TEST_ADDRESS_KEY_SET } from '../fixtures/ingest-ports.js';
import { DOC_EXAMPLE_LANE_MAP, SES_EVENT_FIXTURE_NAMES, loadSesEventFixture } from '../fixtures/ses-events/index.js';
import { lazyClient } from './lazy-client.js';
import { createDynamoDecisionStore, createDynamoEventStore } from './event-store.js';
import { AddressKeySecretError, createSecretsManagerAddressKey } from './address-key.js';
import { createSqsDeadLetter } from './dead-letter.js';
import { createSesReads } from './ses-reads.js';
import { createSesWrites } from './ses-writes.js';
import { createLiveAgentCore, createLiveBedrockModel } from './agent-adapters.js';
import { PortBackedModel } from '../port-backed-model.js';
import { NetworkGuardError } from '../test/guards.js';
import {
  DNS_LOOKUP_TIMEOUT_MS,
  DNS_LOOKUP_TRIES,
  createLiveDns,
  type DnsMxAnswer,
  type DnsResolver,
  type DnsResolverFactory,
  type DnsResolverOptions,
} from './dns.js';

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
    const store = createDynamoEventStore({ tableName: 'events', client: () => client });

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
    const store = createDynamoEventStore({ tableName: 'events', client: () => client });
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

    const store = createDynamoEventStore({ tableName: 'events', client: () => client });
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
        ':to': `${bucketSortKeyPrefix(toBucketMs)}\uFFFF`,
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
    const store = createDynamoEventStore({ tableName: 'events', client: () => client });

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
    const store = createDynamoEventStore({ tableName: 'events', client: () => client });

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

  it('deletes a record with a conditional DeleteCommand and resolves true', async () => {
    const client = dynamoClient();
    const calls = stubSend(client, () => ({}));
    const store = createDynamoEventStore({ tableName: 'events', client: () => client });

    await expect(store.deleteRecord({ pk: 'LANE#x', sk: 'B#0000000000001#Send#m1' })).resolves.toBe(true);
    expect(calls[0]?.name).toBe('DeleteCommand');
    expect(calls[0]?.input).toMatchObject({
      TableName: 'events',
      Key: { pk: 'LANE#x', sk: 'B#0000000000001#Send#m1' },
      ConditionExpression: 'attribute_exists(pk)',
    });
  });

  it('resolves false when the key names no stored record, and propagates any other rejection', async () => {
    const client = dynamoClient();
    let deletes = 0;
    stubSend(client, () => {
      deletes += 1;
      const error = new Error(deletes === 1 ? 'conditional failed' : 'network blip');
      if (deletes === 1) error.name = 'ConditionalCheckFailedException';
      throw error;
    });
    const store = createDynamoEventStore({ tableName: 'events', client: () => client });

    await expect(store.deleteRecord({ pk: 'LANE#x', sk: 'gone' })).resolves.toBe(false);
    await expect(store.deleteRecord({ pk: 'LANE#x', sk: 'gone' })).rejects.toThrow('network blip');
  });

  it('reads a record with ConsistentRead true', async () => {
    const client = dynamoClient();
    const record = { pk: 'LANE#x', sk: 'B#0000000000001#Send#m1' } as unknown as EventRecord;
    const calls = stubSend(client, () => ({ Item: record }));
    const store = createDynamoEventStore({ tableName: 'events', client: () => client });

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
    });
    expect(constructed).toBe(0);
    await expect(store.putIfAbsent({} as EventRecord)).rejects.toMatchObject({
      name: 'LiveConfigMissingError',
      envVar: 'FOTHERING_TABLE_NAME',
    });
    expect(constructed).toBe(0);
  });

  // DynamoDB "collates and compares strings using the bytes of the underlying UTF-8 string
  // encoding" (developer guide, Supported data types and naming rules), so the lane range is
  // checked in that order, never in JavaScript's string order, which compares UTF-16 code units
  // and disagrees with it above U+FFFF.
  describe('the lane range in UTF-8 byte order', () => {
    const LAST_STORABLE_BUCKET_MS = 9_999_999_999_999;
    const utf8 = (text: string): Buffer => Buffer.from(text, 'utf8');

    // The range queryLane really sends for one bucket, read off its recorded QueryCommand, so the
    // checks run against the store's own sentinel rather than a copy of it.
    function laneRangeReader(): (bucketMs: number) => Promise<{ from: string; to: string }> {
      const client = dynamoClient();
      const calls = stubSend(client, () => ({ Items: [] }));
      const store = createDynamoEventStore({ tableName: 'events', client: () => client });
      return async (bucketMs) => {
        await store.queryLane('x', bucketMs, bucketMs, 0);
        const input = calls.at(-1)?.input as { ExpressionAttributeValues?: Record<string, unknown> } | undefined;
        const from = input?.ExpressionAttributeValues?.[':from'];
        const to = input?.ExpressionAttributeValues?.[':to'];
        if (typeof from !== 'string' || typeof to !== 'string') throw new Error('queryLane sent no string :from and :to');
        return { from, to };
      };
    }

    // Any identity at all, the full Unicode range included: the '#' recordKey writes right after the
    // bucket prefix is the byte the bound is compared on, so nothing the identity holds can move a
    // key out of its bucket's range.
    it('keeps every key recordKey can build for a bucket inside its range and below the next bucket (fixed seed)', async () => {
      const readRange = laneRangeReader();
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 0, max: LAST_STORABLE_BUCKET_MS }),
          fc.constantFrom(...SES_EVENT_TYPES),
          fc.string({ unit: 'binary' }),
          async (bucketMs, eventType, identity) => {
            const { from, to } = await readRange(bucketMs);
            const key = utf8(recordKey({ configurationSet: 'x', bucketStartMs: bucketMs, eventType, identity }).sk);
            expect(Buffer.compare(utf8(from), key)).toBeLessThan(0);
            expect(Buffer.compare(key, utf8(to))).toBeLessThan(0);
            if (isStorableBucketStart(bucketMs + 1)) {
              const next = utf8(bucketSortKeyPrefix(bucketMs + 1));
              expect(Buffer.compare(key, next)).toBeLessThan(0);
              expect(Buffer.compare(utf8(to), next)).toBeLessThan(0);
            }
          },
        ),
        { seed: propertySeed() },
      );
    });

    // A shape recordKey never writes, since it always follows the prefix with '#': a character above
    // U+FFFF right after the prefix, where the two orders disagree about the bound.
    it('puts a character above U+FFFF right after the prefix past the upper bound in UTF-8 byte order, though JavaScript string order keeps it inside', async () => {
      const { to } = await laneRangeReader()(0);
      const astralAfterPrefix = `${bucketSortKeyPrefix(0)}${String.fromCodePoint(0x1f600)}`;
      expect(astralAfterPrefix < to).toBe(true);
      expect(Buffer.compare(utf8(astralAfterPrefix), utf8(to))).toBeGreaterThan(0);
    });
  });
});

// The store tests above replace send, so the document client's own marshalling never runs there.
// This keeps the real send and cuts the request off at the build step: the item has been
// marshalled by then, and nothing has been signed or sent.
function captureMarshalledItems(client: DynamoDBDocumentClient): Record<string, unknown>[] {
  const items: Record<string, unknown>[] = [];
  const capture = () => async (args: { input: { Item?: Record<string, unknown> } }) => {
    if (args.input.Item !== undefined) items.push(args.input.Item);
    return { output: {}, response: {} };
  };
  const stack = client.middlewareStack as unknown as { add: (middleware: unknown, options: { step: string; name: string }) => void };
  stack.add(capture, { step: 'build', name: 'captureMarshalledItem' });
  return items;
}

describe('the real document client marshals every record minimize writes', () => {
  it.each(SES_EVENT_FIXTURE_NAMES)('writes every record the %s fixture minimizes into', async (name) => {
    const parsed = parseSesEvent(loadSesEventFixture(name).event);
    if (!parsed.ok) throw new Error(`the ${name} fixture failed to parse`);
    const lane = findLane(DOC_EXAMPLE_LANE_MAP, parsed.event.detail.mail.tags['ses:configuration-set']?.[0] ?? '');
    if (lane === undefined) throw new Error(`the ${name} fixture names no lane in DOC_EXAMPLE_LANE_MAP`);
    const timeMs = Date.parse(parsed.event.time);
    const records = minimizeEvent(parsed.event, {
      lane,
      laneMap: DOC_EXAMPLE_LANE_MAP,
      keySet: TEST_ADDRESS_KEY_SET,
      provenance: 'doc-derived',
      envelopeTimeMs: timeMs,
      arrivalTimeMs: timeMs,
    });
    expect(records.length).toBeGreaterThan(0);

    const client = dynamoClient();
    const items = captureMarshalledItems(client);
    const store = createDynamoEventStore({ tableName: 'events', client: () => client });
    for (const record of records) await expect(store.putIfAbsent(record)).resolves.toBe('written');

    expect(items).toHaveLength(records.length);
    expect(items[0]).toMatchObject({ pk: { S: records[0]?.pk }, expiresAt: { N: String(records[0]?.expiresAt) } });
  });

  it('refuses a record holding an undefined field, so the capture above is the real marshaller', async () => {
    const client = dynamoClient();
    captureMarshalledItems(client);
    const store = createDynamoEventStore({ tableName: 'events', client: () => client });
    const record = { pk: 'LANE#x', sk: 'B#0000000000000#Send#m1', fields: { bounceType: undefined } } as unknown as EventRecord;

    await expect(store.putIfAbsent(record)).rejects.toThrow('removeUndefinedValues');
  });
});

function secretsManagerClient(): SecretsManagerClient {
  return new SecretsManagerClient({ region: REGION, credentials: FAKE_CREDENTIALS });
}

const K1_SECRET = 'k1-secret-material-at-least-32-characters';
const K2_SECRET = 'k2-secret-material-at-least-32-characters';
// A second version's activeFrom as a real rotation writes it, in epoch milliseconds: the key read
// refuses any activeFrom that is not 0 or a whole millisecond count from 2020 on.
const LATER_MS = 1_700_000_000_000;

describe('createSecretsManagerAddressKey', () => {
  it('parses every retained version with its activeFromMs', async () => {
    const client = secretsManagerClient();
    stubSend(client, () => ({
      SecretString: JSON.stringify({ current: 'k2', activeFrom: { k1: 0, k2: LATER_MS }, k1: K1_SECRET, k2: K2_SECRET }),
    }));
    const adapter = createSecretsManagerAddressKey({ secretId: 'address-key', client: () => client, now: () => 0 });

    await expect(adapter.getKeySet()).resolves.toEqual({
      versions: [
        { id: 'k1', secret: K1_SECRET, activeFromMs: 0 },
        { id: 'k2', secret: K2_SECRET, activeFromMs: LATER_MS },
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
      SecretString: JSON.stringify({ current: 'k1', activeFrom: { k1: 0, k2: LATER_MS }, k1: K1_SECRET, k2: K2_SECRET }),
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

  // A version id is also a field name in the same JSON object, so an id that collides with one of
  // the two reserved fields would read that field as its key material: named "current", the secret
  // becomes the short word the current field holds, walking past the 32-character minimum.
  it.each([
    ['a version named current', { current: 'current', activeFrom: { current: 0 } }],
    ['a version named activeFrom', { current: 'activeFrom', activeFrom: { activeFrom: 0 } }],
    ['an empty version id', { current: 'k2', activeFrom: { '': 0, k2: LATER_MS }, '': K1_SECRET, k2: K2_SECRET }],
    // A tie leaves the version a send uses to the JSON key order, so it is refused whatever current names.
    [
      'two versions sharing an activeFrom',
      { current: 'k1', activeFrom: { k1: LATER_MS, k2: LATER_MS }, k1: K1_SECRET, k2: K2_SECRET },
    ],
  ])('refuses %s', async (_label, secret) => {
    const client = secretsManagerClient();
    stubSend(client, () => ({ SecretString: JSON.stringify(secret) }));
    const adapter = createSecretsManagerAddressKey({ secretId: 'address-key', client: () => client, now: () => 0 });

    await expect(adapter.getKeySet()).rejects.toBeInstanceOf(AddressKeySecretError);
  });

  // The rule a secret broke is what an operator needs to repair a rotation; a value never is. A
  // version id is a field name, so key material pasted where an id belongs would be an id, and a
  // message naming ids would carry it into the function's log.
  const PASTED_KEY_MATERIAL = 'pasted-key-material-in-place-of-a-version-id-0123456789';
  it.each([
    [
      'current naming an older version',
      { current: 'k1', activeFrom: { k1: 0, k2: LATER_MS }, k1: K1_SECRET, k2: K2_SECRET },
      'current does not name the version with the newest activeFrom',
    ],
    ['a secret that is too short', { current: 'k1', activeFrom: { k1: 0 }, k1: 'too-short' }, 'at least 32 characters'],
    [
      'two versions sharing an activeFrom',
      { current: 'k1', activeFrom: { k1: LATER_MS, k2: LATER_MS }, k1: K1_SECRET, k2: K2_SECRET },
      'two versions the same moment',
    ],
    [
      'an activeFrom version with no secret field',
      { current: 'k1', activeFrom: { k1: 0, [PASTED_KEY_MATERIAL]: LATER_MS }, k1: K1_SECRET },
      'no matching secret field',
    ],
  ])('names the rule broken by %s, never a value or a version id', async (_label, secret, rule) => {
    const client = secretsManagerClient();
    stubSend(client, () => ({ SecretString: JSON.stringify(secret) }));
    const adapter = createSecretsManagerAddressKey({ secretId: 'address-key', client: () => client, now: () => 0 });

    const message = await adapter.getKeySet().then(
      () => 'resolved, expected a rejection',
      (error: unknown) => (error instanceof AddressKeySecretError ? error.message : `not an AddressKeySecretError: ${String(error)}`),
    );
    expect(message).toContain(rule);
    for (const value of [K1_SECRET, K2_SECRET, 'too-short', PASTED_KEY_MATERIAL]) expect(message).not.toContain(value);
  });

  // activeFrom is epoch milliseconds. A version written in seconds, the unit the table's own expiry
  // uses, would be active at once and skip the rotation margin; one written in microseconds would
  // never become active. Both pass every other rule, so the unit is refused on its own.
  it.each([
    ['epoch seconds', 1_700_000_000],
    ['epoch microseconds', 1_700_000_000_000_000],
    ['a fraction of a millisecond', LATER_MS + 0.5],
    ['a moment before 2020', 1_500_000_000_000],
  ])('refuses a version whose activeFrom is in %s', async (_label, activeFromMs) => {
    const client = secretsManagerClient();
    stubSend(client, () => ({
      SecretString: JSON.stringify({ current: 'k2', activeFrom: { k1: 0, k2: activeFromMs }, k1: K1_SECRET, k2: K2_SECRET }),
    }));
    const adapter = createSecretsManagerAddressKey({ secretId: 'address-key', client: () => client, now: () => 0 });

    await expect(adapter.getKeySet()).rejects.toThrow('epoch milliseconds');
  });

  it('refuses a secret that fails its schema, without echoing any secret value', async () => {
    const client = secretsManagerClient();
    stubSend(client, () => ({ SecretString: JSON.stringify({ current: 'k1', activeFrom: { k1: 0 }, k1: 'too-short' }) }));
    const adapter = createSecretsManagerAddressKey({ secretId: 'address-key', client: () => client, now: () => 0 });

    await expect(adapter.getKeySet()).rejects.toBeInstanceOf(AddressKeySecretError);
  });

  // A binary secret, a SecretString that is not JSON and a secret naming no version leave nothing to
  // hash under. Each is refused by its own rule; the JSON parser's own message can quote the text it
  // read, so it never reaches the error the function logs.
  it.each([
    ['a secret with no SecretString', {}, 'has no SecretString'],
    ['a SecretString that is not JSON', { SecretString: `{"current":"k1","k1":"${K1_SECRET}"` }, 'is not valid JSON'],
    [
      'an activeFrom naming no version',
      { SecretString: JSON.stringify({ current: 'k1', activeFrom: {}, k1: K1_SECRET }) },
      'activeFrom names no key version',
    ],
  ])('refuses %s with the rule it broke and no secret value', async (_label, response, rule) => {
    const client = secretsManagerClient();
    stubSend(client, () => response);
    const adapter = createSecretsManagerAddressKey({ secretId: 'address-key', client: () => client, now: () => 0 });

    const message = await adapter.getKeySet().then(
      () => 'resolved, expected a rejection',
      (error: unknown) => (error instanceof AddressKeySecretError ? error.message : `not an AddressKeySecretError: ${String(error)}`),
    );
    expect(message).toContain(rule);
    expect(message).not.toContain(K1_SECRET);
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

// A variable a deploy sets to the empty string is as missing as one it never sets: read as a name,
// it would reach AWS and come back as a validation error that names no variable.
describe('an empty configuration value counts as missing', () => {
  it('names the variable and builds no client, for all three adapters', async () => {
    let constructed = 0;
    const count = <T>(build: () => T) => (): T => {
      constructed += 1;
      return build();
    };
    const store = createDynamoEventStore({ tableName: '', client: count(dynamoClient) });
    const addressKey = createSecretsManagerAddressKey({ secretId: '', client: count(secretsManagerClient), now: () => 0 });
    const deadLetter = createSqsDeadLetter({
      queueUrl: '',
      client: count(() => new SQSClient({ region: REGION, credentials: FAKE_CREDENTIALS })),
    });

    await expect(store.getRecord({ pk: 'LANE#x', sk: 'y' })).rejects.toMatchObject({ envVar: 'FOTHERING_TABLE_NAME' });
    await expect(addressKey.getKeySet()).rejects.toMatchObject({ envVar: 'FOTHERING_ADDRESS_KEY_SECRET_ID' });
    await expect(deadLetter.send([])).rejects.toMatchObject({ envVar: 'FOTHERING_DLQ_URL' });
    expect(constructed).toBe(0);
  });

  // No table name, queue URL or secret id can hold a space, so a value of spaces is a
  // misconfiguration exactly like an empty one.
  it('treats a value of spaces as missing too', async () => {
    const store = createDynamoEventStore({ tableName: '   ', client: dynamoClient });
    await expect(store.getRecord({ pk: 'LANE#x', sk: 'y' })).rejects.toMatchObject({ envVar: 'FOTHERING_TABLE_NAME' });
  });
});

const LANES = parseLaneMap(lanesJson);
const BULK = 'fothering-bulk';
const FOLD_NOW_MS = Date.UTC(2026, 9, 11, 12, 2, 0);

function bulkSends(count: number): EventRecord[] {
  const scenario = { configurationSet: BULK, streamTag: 'newsletter', callerIdentity: 'bulk-sender', fromDomain: 'news.example.com' };
  return scenarioRecords({ ...scenario, groups: [{ bucketOffset: 0, count, deliverRest: false }] }, FOLD_NOW_MS, LANES, TEST_ADDRESS_KEY_SET);
}

function nthRecord(records: readonly EventRecord[], index: number): EventRecord {
  const record = records[index];
  if (record === undefined) throw new Error(`expected a record at ${index}`);
  return record;
}

describe('createDynamoEventStore foldLane (R1 live half)', () => {
  const window = spikeWindowFor(FOLD_NOW_MS);

  it('sends one query per page and folds each page before asking for the next, across three pages (AC-1)', async () => {
    const client = dynamoClient();
    const records = bulkSends(3);
    const pages = [
      { Items: [nthRecord(records, 0)], LastEvaluatedKey: { pk: 'LANE#fothering-bulk', sk: 'page-1' } },
      { Items: [], LastEvaluatedKey: { pk: 'LANE#fothering-bulk', sk: 'page-2' } },
      { Items: [nthRecord(records, 1), nthRecord(records, 2)] },
    ];
    const order: string[] = [];
    let queries = 0;
    const calls = stubSend(client, (command) => {
      if (command.name !== 'QueryCommand') throw new Error(`unexpected command ${command.name}`);
      queries += 1;
      order.push(`query ${queries}`);
      return pages[queries - 1];
    });
    const base = createWindowFold({ lane: BULK, window, nowMs: FOLD_NOW_MS });
    const fold: LaneFold<WindowFoldState> = {
      initial: base.initial,
      step: (state, page) => {
        order.push(`step ${page.length}`);
        return base.step(state, page);
      },
    };
    const store = createDynamoEventStore({ tableName: 'events', client: () => client });

    const state = await store.foldLane(BULK, window.fromBucketMs, window.toBucketMs, FOLD_NOW_MS, fold);

    expect(order.join(', ')).toBe('query 1, step 1, query 2, step 0, query 3, step 2');
    expect(summarizeWindow(state).totals.recipientSends).toBe(3);
    expect(calls).toHaveLength(3);
    for (const call of calls) {
      expect(call.input).toMatchObject({
        TableName: 'events',
        KeyConditionExpression: 'pk = :pk AND sk BETWEEN :from AND :to',
        FilterExpression: 'expiresAt > :now',
        ExpressionAttributeValues: {
          ':pk': 'LANE#fothering-bulk',
          ':from': bucketSortKeyPrefix(window.fromBucketMs),
          ':to': `${bucketSortKeyPrefix(window.toBucketMs)}￿`,
          ':now': Math.floor(FOLD_NOW_MS / 1000),
        },
      });
    }
    const startKeys = calls.map((call) => (call.input as { ExclusiveStartKey?: { sk: string } }).ExclusiveStartKey?.sk ?? 'none');
    expect(startKeys.join(' ')).toBe('none page-1 page-2');
  });

  it('counts nowhere an expired item a misbehaving client still returns, by the fold own check (AC-2)', async () => {
    const client = dynamoClient();
    const records = bulkSends(2);
    const expired = { ...nthRecord(records, 1), expiresAt: Math.floor(FOLD_NOW_MS / 1000) };
    stubSend(client, () => ({ Items: [nthRecord(records, 0), expired] }));
    const store = createDynamoEventStore({ tableName: 'events', client: () => client });

    const state = await store.foldLane(BULK, window.fromBucketMs, window.toBucketMs, FOLD_NOW_MS, createWindowFold({ lane: BULK, window, nowMs: FOLD_NOW_MS }));
    expect(summarizeWindow(state).totals.recipientSends).toBe(1);
  });

  it('refuses a window one bucket past MAX_WINDOW_BUCKETS with WindowTooLongError before any QueryCommand (AC-E1)', async () => {
    const client = dynamoClient();
    const calls = stubSend(client, () => ({ Items: [] }));
    const store = createDynamoEventStore({ tableName: 'events', client: () => client });
    const toBucketMs = bucketStartMs(FOLD_NOW_MS);
    const counting: LaneFold<number> = { initial: 0, step: (steps) => steps + 1 };

    const refusal = await store.foldLane(BULK, toBucketMs - MAX_WINDOW_BUCKETS * BUCKET_MS, toBucketMs, FOLD_NOW_MS, counting).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(WindowTooLongError);
    expect(calls).toHaveLength(0);
    await expect(store.foldLane(BULK, toBucketMs - (MAX_WINDOW_BUCKETS - 1) * BUCKET_MS, toBucketMs, FOLD_NOW_MS, counting)).resolves.toBe(1);
  });
});

const INCIDENT_PK = `INCIDENT#${'b'.repeat(32)}`;
const STATE_ITEM_KEY = { pk: INCIDENT_PK, sk: 'STATE' };
const DECISION_NOW_MS = 1_760_000_000_000;
const LIVE_RESERVATION: ReservationRequest = {
  incidentKey: { pk: INCIDENT_PK, sk: 'COUNTER' },
  dayKey: { pk: 'COUNTER_DAY#2026-10-11', sk: 'COUNTER' },
  incidentCap: 3,
  dayInvocationCap: 10,
  dayTokenCap: 1_000,
  tokenReservation: 100,
  expiresAt: 1_800_000_000,
};
const LIVE_USAGE: UsageRecord = {
  incidentKey: LIVE_RESERVATION.incidentKey,
  dayKey: LIVE_RESERVATION.dayKey,
  inputTokens: 1_200,
  outputTokens: 80,
  modelCalls: 2,
};
const LIVE_LANE_ATTEMPT: LaneAttemptRequest = {
  key: { pk: 'COUNTER_LANE_HOUR#fothering-bulk#2026-10-11T12', sk: 'COUNTER' },
  cap: 4,
  expiresAt: 1_800_000_000,
};

function conditionalCheckFailed(): Error {
  const error = new Error('The conditional request failed');
  error.name = 'ConditionalCheckFailedException';
  return error;
}

function cancelled(...codes: string[]): TransactionCanceledException {
  return new TransactionCanceledException({
    message: 'Transaction cancelled',
    $metadata: {},
    CancellationReasons: codes.map((Code) => ({ Code })),
  });
}

function decisionStoreAnswering(handler: (command: RecordedCommand) => unknown): { store: ReturnType<typeof createDynamoDecisionStore>; calls: RecordedCommand[] } {
  const client = dynamoClient();
  const calls = stubSend(client, handler);
  return { store: createDynamoDecisionStore({ tableName: 'events', client: () => client }), calls };
}

describe('createDynamoDecisionStore', () => {
  it('puts only where no item is stored or the stored one has expired, and maps ConditionalCheckFailedException to duplicate (AC-E33)', async () => {
    let puts = 0;
    const item = { ...STATE_ITEM_KEY, expiresAt: 1_800_000_000, version: 1 };
    const { store, calls } = decisionStoreAnswering((command) => {
      puts += 1;
      if (command.name !== 'PutCommand') throw new Error(`unexpected command ${command.name}`);
      if (puts === 2) throw conditionalCheckFailed();
      if (puts === 3) throw new Error('network blip');
      return {};
    });

    await expect(store.putIfAbsent(item, DECISION_NOW_MS)).resolves.toBe('written');
    await expect(store.putIfAbsent(item, DECISION_NOW_MS)).resolves.toBe('duplicate');
    await expect(store.putIfAbsent(item, DECISION_NOW_MS + 1_999)).rejects.toThrow('network blip');
    // The exact inverse of the read's unexpired test (expiresAt > floor(now / 1000)), so an item the
    // read hides as expired never blocks the put, and one with no expiresAt always does.
    expect(calls[0]?.input).toEqual({
      TableName: 'events',
      Item: item,
      ConditionExpression: 'attribute_not_exists(pk) OR expiresAt <= :now',
      ExpressionAttributeValues: { ':now': Math.floor(DECISION_NOW_MS / 1000) },
    });
    expect(calls[2]?.input).toMatchObject({ ExpressionAttributeValues: { ':now': Math.floor(DECISION_NOW_MS / 1000) + 1 } });
  });

  it('refuses an item under a LANE# key or a counter item before sending anything', async () => {
    const { store, calls } = decisionStoreAnswering(() => ({}));
    await expect(store.putIfAbsent({ pk: 'LANE#fothering-bulk', sk: 'STATE', expiresAt: 1 }, DECISION_NOW_MS)).rejects.toThrow(RangeError);
    await expect(store.putIfAbsent({ ...LIVE_RESERVATION.dayKey, expiresAt: 1, invocations: -5 }, DECISION_NOW_MS)).rejects.toThrow(RangeError);
    expect(calls).toHaveLength(0);
  });

  it('reads consistently and answers nothing for an item whose expiresAt is at or before now in seconds (Pitfall 4)', async () => {
    const nowSeconds = Math.floor(DECISION_NOW_MS / 1000);
    const answers = [{ Item: { ...STATE_ITEM_KEY, expiresAt: nowSeconds + 1 } }, { Item: { ...STATE_ITEM_KEY, expiresAt: nowSeconds } }, {}];
    const { store, calls } = decisionStoreAnswering(() => answers.shift());

    await expect(store.getItem(STATE_ITEM_KEY, DECISION_NOW_MS)).resolves.toEqual({ ...STATE_ITEM_KEY, expiresAt: nowSeconds + 1 });
    await expect(store.getItem(STATE_ITEM_KEY, DECISION_NOW_MS)).resolves.toBeUndefined();
    await expect(store.getItem(STATE_ITEM_KEY, DECISION_NOW_MS)).resolves.toBeUndefined();
    expect(calls[0]?.name).toBe('GetCommand');
    expect(calls[0]?.input).toEqual({ TableName: 'events', Key: STATE_ITEM_KEY, ConsistentRead: true });
  });

  it('updates under a version condition, naming each attribute by placeholder, with the next version and a fresh expiresAt', async () => {
    const { store, calls } = decisionStoreAnswering(() => ({}));
    await expect(store.updateIfVersion(STATE_ITEM_KEY, 1, { state: 'closed', closedAtMs: 5 }, DECISION_NOW_MS)).resolves.toBe('updated');
    expect(calls[0]?.name).toBe('UpdateCommand');
    expect(calls[0]?.input).toEqual({
      TableName: 'events',
      Key: STATE_ITEM_KEY,
      UpdateExpression: 'SET #a0 = :a0, #a1 = :a1, version = :next, expiresAt = :expiresAt',
      ConditionExpression: 'version = :expected',
      ExpressionAttributeNames: { '#a0': 'state', '#a1': 'closedAtMs' },
      ExpressionAttributeValues: {
        ':a0': 'closed',
        ':a1': 5,
        ':expected': 1,
        ':next': 2,
        ':expiresAt': Math.floor(DECISION_NOW_MS / 1000) + RETENTION_SECONDS,
      },
    });
  });

  it('adds each expected attribute to the version condition by its own placeholder, with no attribute to set as well', async () => {
    const { store, calls } = decisionStoreAnswering(() => ({}));
    await expect(store.updateIfVersion(STATE_ITEM_KEY, 3, { status: 'closed' }, DECISION_NOW_MS, { incidentId: 'first' })).resolves.toBe('updated');
    await expect(store.updateIfVersion(STATE_ITEM_KEY, 3, {}, DECISION_NOW_MS, { incidentId: 'first' })).resolves.toBe('updated');
    expect(calls.map((call) => call.input)).toMatchObject([
      {
        UpdateExpression: 'SET #a0 = :a0, version = :next, expiresAt = :expiresAt',
        ConditionExpression: 'version = :expected AND #e0 = :e0',
        ExpressionAttributeNames: { '#a0': 'status', '#e0': 'incidentId' },
        ExpressionAttributeValues: { ':a0': 'closed', ':e0': 'first', ':expected': 3, ':next': 4 },
      },
      {
        UpdateExpression: 'SET version = :next, expiresAt = :expiresAt',
        ConditionExpression: 'version = :expected AND #e0 = :e0',
        ExpressionAttributeNames: { '#e0': 'incidentId' },
        ExpressionAttributeValues: { ':e0': 'first', ':expected': 3, ':next': 4 },
      },
    ]);
  });

  it('maps a failed version condition to conflict, passes any other error on, and refuses a managed attribute unsent', async () => {
    let updates = 0;
    const { store, calls } = decisionStoreAnswering(() => {
      updates += 1;
      throw updates === 1 ? conditionalCheckFailed() : new Error('network blip');
    });
    await expect(store.updateIfVersion(STATE_ITEM_KEY, 1, { state: 'closed' }, DECISION_NOW_MS)).resolves.toBe('conflict');
    await expect(store.updateIfVersion(STATE_ITEM_KEY, 1, { state: 'closed' }, DECISION_NOW_MS)).rejects.toThrow('network blip');
    await expect(store.updateIfVersion(STATE_ITEM_KEY, 1, { version: 9 }, DECISION_NOW_MS)).rejects.toThrow(RangeError);
    expect(calls).toHaveLength(2);
  });

  it('reserves through one TransactWriteCommand of two conditional updates (D-67)', async () => {
    const { store, calls } = decisionStoreAnswering(() => ({}));
    await expect(store.reserveInvocation(LIVE_RESERVATION)).resolves.toEqual({ ok: true });
    expect(calls.map((call) => call.name).join(' ')).toBe('TransactWriteCommand');
    expect(calls[0]?.input).toEqual({
      TransactItems: [
        {
          Update: {
            TableName: 'events',
            Key: LIVE_RESERVATION.incidentKey,
            UpdateExpression: 'ADD invocations :one SET expiresAt = if_not_exists(expiresAt, :exp)',
            ConditionExpression: 'attribute_not_exists(invocations) OR invocations < :incidentCap',
            ExpressionAttributeValues: { ':one': 1, ':incidentCap': 3, ':exp': 1_800_000_000 },
          },
        },
        {
          Update: {
            TableName: 'events',
            Key: LIVE_RESERVATION.dayKey,
            UpdateExpression: 'ADD invocations :one, tokenReservations :tokens SET expiresAt = if_not_exists(expiresAt, :exp)',
            ConditionExpression:
              '(attribute_not_exists(invocations) OR invocations < :dayCap) AND (attribute_not_exists(tokenReservations) OR tokenReservations <= :tokenRoom)',
            ExpressionAttributeValues: { ':one': 1, ':tokens': 100, ':dayCap': 10, ':tokenRoom': 900, ':exp': 1_800_000_000 },
          },
        },
      ],
    });
  });

  // Reasons arrive in the order of the requested items, and only a failed condition is a cap: a
  // TransactionConflict is two writers racing, which a retry settles (AC-E45, Pitfall 6).
  it.each<[string[], string]>([
    [['ConditionalCheckFailed', 'None'], 'cap incident'],
    [['None', 'ConditionalCheckFailed'], 'cap day'],
    [['ConditionalCheckFailed', 'ConditionalCheckFailed'], 'cap incident day'],
    [['ConditionalCheckFailed', 'TransactionConflict'], 'cap incident'],
    [['TransactionConflict', 'None'], 'conflict'],
    [['None', 'TransactionConflict'], 'conflict'],
  ])('maps the cancellation reasons %j to %s', async (codes, outcome) => {
    const { store } = decisionStoreAnswering(() => {
      throw cancelled(...codes);
    });
    const result = await store.reserveInvocation(LIVE_RESERVATION);
    expect(result.ok ? 'ok' : [result.reason, ...(result.reason === 'cap' ? result.items : [])].join(' ')).toBe(outcome);
  });

  it('passes on a cancellation holding neither a failed condition nor a conflict, and any other error', async () => {
    const errors: unknown[] = [cancelled('ThrottlingError', 'None'), new Error('network blip')];
    const { store } = decisionStoreAnswering(() => {
      throw errors.shift();
    });
    await expect(store.reserveInvocation(LIVE_RESERVATION)).rejects.toBeInstanceOf(TransactionCanceledException);
    await expect(store.reserveInvocation(LIVE_RESERVATION)).rejects.toThrow('network blip');
  });

  // A counter item without its reservation would carry no expiresAt and outlive the 30-day retention,
  // so usage is added only to items that already exist, both or neither.
  it('records usage with one TransactWriteCommand of two ADD-only updates on existing counters, after refusing a negative amount unsent', async () => {
    const { store, calls } = decisionStoreAnswering(() => ({}));
    await expect(store.recordUsage({ ...LIVE_USAGE, outputTokens: -1 })).rejects.toThrow(RangeError);
    expect(calls).toHaveLength(0);

    await expect(store.recordUsage(LIVE_USAGE)).resolves.toBe('recorded');
    expect(calls.map((call) => call.name).join(' ')).toBe('TransactWriteCommand');
    const items = (calls[0]?.input as { TransactItems: { Update: { Key: { pk: string } } }[] }).TransactItems;
    expect(items.map((item) => item.Update.Key.pk).join(' ')).toBe(`${INCIDENT_PK} COUNTER_DAY#2026-10-11`);
    for (const item of items) {
      expect(item.Update).toEqual({
        TableName: 'events',
        Key: item.Update.Key,
        UpdateExpression: 'ADD inputTokens :inputTokens, outputTokens :outputTokens, modelCalls :modelCalls',
        ConditionExpression: 'attribute_exists(pk)',
        ExpressionAttributeValues: { ':inputTokens': 1_200, ':outputTokens': 80, ':modelCalls': 2 },
      });
    }
  });

  it.each([
    ['ConditionalCheckFailed', 'None'],
    ['None', 'ConditionalCheckFailed'],
    ['ConditionalCheckFailed', 'ConditionalCheckFailed'],
  ])('answers not-reserved for usage on a counter no reservation created, cancellation reasons %s %s', async (...codes) => {
    const { store } = decisionStoreAnswering(() => {
      throw cancelled(...codes);
    });
    await expect(store.recordUsage(LIVE_USAGE)).resolves.toBe('not-reserved');
  });

  it('passes on a usage cancellation holding no failed condition, and any other error', async () => {
    const errors: unknown[] = [cancelled('TransactionConflict', 'None'), new Error('network blip')];
    const { store } = decisionStoreAnswering(() => {
      throw errors.shift();
    });
    await expect(store.recordUsage(LIVE_USAGE)).rejects.toBeInstanceOf(TransactionCanceledException);
    await expect(store.recordUsage(LIVE_USAGE)).rejects.toThrow('network blip');
  });

  // D-99, 03-RESEARCH Pattern 4: one conditional UpdateItem sent alone, ADD only, so a counter can rise
  // to its cap and never come down.
  it('reserves a lane-hour attempt with one conditional UpdateCommand that only adds', async () => {
    const { store, calls } = decisionStoreAnswering(() => ({}));
    await expect(store.reserveLaneAttempt(LIVE_LANE_ATTEMPT)).resolves.toBe('reserved');
    expect(calls.map((call) => call.name).join(' ')).toBe('UpdateCommand');
    expect(calls[0]?.input).toEqual({
      TableName: 'events',
      Key: LIVE_LANE_ATTEMPT.key,
      UpdateExpression: 'ADD attempts :one SET expiresAt = if_not_exists(expiresAt, :exp)',
      ConditionExpression: 'attribute_not_exists(attempts) OR attempts < :cap',
      ExpressionAttributeValues: { ':one': 1, ':cap': 4, ':exp': 1_800_000_000 },
    });
  });

  it('maps ConditionalCheckFailedException alone to cap and passes any other error on', async () => {
    const errors: unknown[] = [conditionalCheckFailed(), new Error('network blip')];
    const { store } = decisionStoreAnswering(() => {
      throw errors.shift();
    });
    await expect(store.reserveLaneAttempt(LIVE_LANE_ATTEMPT)).resolves.toBe('cap');
    await expect(store.reserveLaneAttempt(LIVE_LANE_ATTEMPT)).rejects.toThrow('network blip');
  });

  it.each<[string, LaneAttemptRequest]>([
    ['a day counter key', { ...LIVE_LANE_ATTEMPT, key: LIVE_RESERVATION.dayKey }],
    ['a lane-hour key under another sort key', { ...LIVE_LANE_ATTEMPT, key: { ...LIVE_LANE_ATTEMPT.key, sk: 'MARKER' } }],
    ['a cap of zero', { ...LIVE_LANE_ATTEMPT, cap: 0 }],
    ['a fractional expiresAt', { ...LIVE_LANE_ATTEMPT, expiresAt: 1.5 }],
  ])('refuses %s with a RangeError before anything is sent', async (_label, request) => {
    const { store, calls } = decisionStoreAnswering(() => ({}));
    await expect(store.reserveLaneAttempt(request)).rejects.toThrow(RangeError);
    expect(calls).toHaveLength(0);
  });

  it('still refuses a put or a versioned update of a lane-hour counter unsent', async () => {
    const { store, calls } = decisionStoreAnswering(() => ({}));
    await expect(store.putIfAbsent({ ...LIVE_LANE_ATTEMPT.key, attempts: 0, expiresAt: 1 }, DECISION_NOW_MS)).rejects.toThrow(RangeError);
    await expect(store.updateIfVersion(LIVE_LANE_ATTEMPT.key, 0, { attempts: 0 }, DECISION_NOW_MS)).rejects.toThrow(RangeError);
    expect(calls).toHaveLength(0);
  });

  it('builds no client and names FOTHERING_TABLE_NAME from every operation when the table name is unset', async () => {
    let constructed = 0;
    const store = createDynamoDecisionStore({
      tableName: undefined,
      client: () => {
        constructed += 1;
        return dynamoClient();
      },
    });
    const operations = [
      store.putIfAbsent({ ...STATE_ITEM_KEY, expiresAt: 1 }, DECISION_NOW_MS),
      store.getItem(STATE_ITEM_KEY, DECISION_NOW_MS),
      store.updateIfVersion(STATE_ITEM_KEY, 1, {}, DECISION_NOW_MS),
      store.reserveInvocation(LIVE_RESERVATION),
      store.recordUsage(LIVE_USAGE),
      store.reserveLaneAttempt(LIVE_LANE_ATTEMPT),
    ];
    for (const operation of operations) {
      await expect(operation).rejects.toMatchObject({ name: 'LiveConfigMissingError', envVar: 'FOTHERING_TABLE_NAME' });
    }
    expect(constructed).toBe(0);
  });

  it('builds one client on the first decisionStore call through the port table, and none at resolution', async () => {
    const client = dynamoClient();
    stubSend(client, () => ({}));
    let built = 0;
    const { ports, kinds } = resolvePortTable({
      runtimeContext: 'deployed',
      switchValue: undefined,
      liveConfig: { tableName: 'events' },
      liveClients: {
        dynamoDb: () => {
          built += 1;
          return client;
        },
      },
      dryRunSink: () => {},
    });

    expect(Object.values(kinds.decisionStore ?? {}).join(' ')).toBe('live live live live live live');
    expect(built).toBe(0);
    await ports.decisionStore.getItem(STATE_ITEM_KEY, DECISION_NOW_MS);
    await ports.decisionStore.reserveInvocation(LIVE_RESERVATION);
    expect(built).toBe(1);
  });
});

describe('createSesReads', () => {
  function sesClient(): SESv2Client {
    return new SESv2Client({ region: REGION, credentials: FAKE_CREDENTIALS });
  }

  function recordWait(events: string[]): (ms: number) => Promise<void> {
    return async (ms) => {
      events.push(`wait ${ms}`);
    };
  }

  afterEach(() => {
    vi.useRealTimers();
  });

  // D-59: one GetEmailIdentity read answers both the closeability check and the configuration rows.
  it('getEmailIdentity returns the default set, the DKIM and MAIL FROM facts and the identity type from one read', async () => {
    const client = sesClient();
    const calls = stubSend(client, () => ({
      ConfigurationSetName: 'fothering-transactional',
      IdentityType: 'DOMAIN',
      VerifiedForSendingStatus: true,
      DkimAttributes: { Status: 'SUCCESS', SigningEnabled: true, Tokens: ['token1'] },
      MailFromAttributes: { MailFromDomain: 'bounce.example.com', MailFromDomainStatus: 'PENDING', BehaviorOnMxFailure: 'USE_DEFAULT_VALUE' },
      Tags: [{ Key: 'team', Value: 'ops' }],
    }));
    const reads = createSesReads({ client: () => client });

    const facts = await reads.getEmailIdentity('example.com');
    expect(JSON.stringify(facts)).toBe(
      '{"defaultConfigurationSet":"fothering-transactional","dkimStatus":"SUCCESS","dkimSigningEnabled":true,"mailFromDomain":"bounce.example.com","mailFromStatus":"PENDING","identityType":"DOMAIN"}',
    );
    expect(calls.map((call) => call.name).join(' ')).toBe('GetEmailIdentityCommand');
  });

  // exactOptionalPropertyTypes: a fact SES did not return is an absent key, never a key holding undefined.
  it('getEmailIdentity leaves out every key SES did not return', async () => {
    const client = sesClient();
    stubSend(client, (command) =>
      (command.input as { EmailIdentity: string }).EmailIdentity === 'bare.example.com' ? {} : { DkimAttributes: { SigningEnabled: false } },
    );
    const reads = createSesReads({ client: () => client });

    expect(JSON.stringify(await reads.getEmailIdentity('bare.example.com'))).toBe('{}');
    expect(JSON.stringify(await reads.getEmailIdentity('partial.example.com'))).toBe('{"dkimSigningEnabled":false}');
  });

  // SES allows one request a second for every action but sending, so a second page waits a second
  // after the first, and nothing waits after the last page.
  it('listEmailIdentities collects IdentityName across two stubbed pages, waiting a second before the second page only', async () => {
    const client = sesClient();
    const events: string[] = [];
    stubSend(client, (command) => {
      const input = command.input as { NextToken?: string };
      events.push(`page ${input.NextToken ?? 'first'}`);
      if (input.NextToken === 'page-2') return { EmailIdentities: [{ IdentityName: 'b.example.com' }] };
      return { EmailIdentities: [{ IdentityName: 'a.example.com' }], NextToken: 'page-2' };
    });
    const reads = createSesReads({ client: () => client, wait: recordWait(events) });

    await expect(reads.listEmailIdentities()).resolves.toEqual(['a.example.com', 'b.example.com']);
    expect(events).toEqual(['page first', 'wait 1000', 'page page-2']);
  });

  it('uses a real one second timer between identity pages when no wait is given', async () => {
    vi.useFakeTimers();
    const client = sesClient();
    const tokens: (string | undefined)[] = [];
    stubSend(client, (command) => {
      const input = command.input as { NextToken?: string };
      tokens.push(input.NextToken);
      return input.NextToken === 'page-2' ? { EmailIdentities: [] } : { EmailIdentities: [], NextToken: 'page-2' };
    });

    const pending = createSesReads({ client: () => client }).listEmailIdentities();
    await vi.advanceTimersByTimeAsync(SES_READ_SPACING_MS - 1);
    expect(tokens).toEqual([undefined]);
    await vi.advanceTimersByTimeAsync(1);
    expect(tokens).toEqual([undefined, 'page-2']);
    await pending;
  });

  // The largest page SES allows keeps an account of up to 1,000 identities at one request.
  it('asks for the largest page SES allows on every page', async () => {
    const client = sesClient();
    const pageSizes: unknown[] = [];
    stubSend(client, (command) => {
      const input = command.input as { NextToken?: string; PageSize?: number };
      pageSizes.push(input.PageSize);
      return input.NextToken === 'page-2' ? { EmailIdentities: [] } : { EmailIdentities: [], NextToken: 'page-2' };
    });

    await createSesReads({ client: () => client, wait: recordWait([]) }).listEmailIdentities();
    expect(pageSizes).toEqual([1000, 1000]);
  });

  // The API page documents no page-size range for this list, so the read leaves SES's own default.
  it('listConfigurationSets collects every set name across two stubbed pages, a second apart, sending no page size', async () => {
    const client = sesClient();
    const events: string[] = [];
    stubSend(client, (command) => {
      const input = command.input as { NextToken?: string; PageSize?: number };
      events.push(`${command.name} ${input.NextToken ?? 'first'} size ${String(input.PageSize)}`);
      if (input.NextToken === 'page-2') return { ConfigurationSets: ['fothering-alerts'] };
      return { ConfigurationSets: ['fothering-transactional', 'fothering-bulk'], NextToken: 'page-2' };
    });
    const reads = createSesReads({ client: () => client, wait: recordWait(events) });

    await expect(reads.listConfigurationSets()).resolves.toEqual(['fothering-transactional', 'fothering-bulk', 'fothering-alerts']);
    expect(events).toEqual([
      'ListConfigurationSetsCommand first size undefined',
      'wait 1000',
      'ListConfigurationSetsCommand page-2 size undefined',
    ]);
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

  // The SDK's types let every field of an SES event destination come back undefined: Enabled is
  // optional, and even Name and MatchingEventTypes, which the API requires, are typed as possibly
  // undefined. One SES does not say is enabled reads as disabled and one with no event types matches
  // none, so the closeability check refuses the set rather than trusting a destination nobody saw
  // publish.
  it('reads a destination with its fields left out as disabled and matching nothing, and a reply with no destinations as none', async () => {
    const client = sesClient();
    stubSend(client, (command) =>
      (command.input as { ConfigurationSetName: string }).ConfigurationSetName === 'bare'
        ? { EventDestinations: [{ EventBridgeDestination: { EventBusArn: 'arn:aws:events:eu-central-1:000000000000:event-bus/default' } }] }
        : {},
    );
    const reads = createSesReads({ client: () => client });

    await expect(reads.getConfigurationSetEventDestinations('bare')).resolves.toEqual([
      { name: '', enabled: false, eventBridge: true, matchingEventTypes: [] },
    ]);
    await expect(reads.getConfigurationSetEventDestinations('empty')).resolves.toEqual([]);
  });

  // readSesFacts reads one lane-map set after another, a second apart: a set deleted from SES, or
  // an identity deleted after the list read, must cost only its own answer, never the whole read.
  it('answers no destinations for a configuration set SES does not hold, and passes any other error on', async () => {
    const client = sesClient();
    stubSend(client, (command) => {
      const name = (command.input as { ConfigurationSetName: string }).ConfigurationSetName;
      if (name === 'gone') throw new NotFoundException({ message: 'Configuration set gone does not exist.', $metadata: {} });
      throw new TooManyRequestsException({ message: 'Too many requests.', $metadata: {} });
    });
    const reads = createSesReads({ client: () => client });

    await expect(reads.getConfigurationSetEventDestinations('gone')).resolves.toEqual([]);
    await expect(reads.getConfigurationSetEventDestinations('busy')).rejects.toBeInstanceOf(TooManyRequestsException);
  });

  it('answers no default set for an identity SES no longer holds, and passes any other error on', async () => {
    const client = sesClient();
    stubSend(client, (command) => {
      const identity = (command.input as { EmailIdentity: string }).EmailIdentity;
      if (identity === 'gone.example.com') throw new NotFoundException({ message: 'Identity does not exist.', $metadata: {} });
      throw new TooManyRequestsException({ message: 'Too many requests.', $metadata: {} });
    });
    const reads = createSesReads({ client: () => client });

    await expect(reads.getEmailIdentity('gone.example.com')).resolves.toBeUndefined();
    await expect(reads.getEmailIdentity('busy.example.com')).rejects.toBeInstanceOf(TooManyRequestsException);
  });
});

describe('createSesWrites', () => {
  function sesClient(): SESv2Client {
    return new SESv2Client({ region: REGION, credentials: FAKE_CREDENTIALS });
  }

  const REQUEST = { from: 'Fothering <ops@example.org>', to: ['operator@example.org'], subject: 'A subject', text: 'A body.', configurationSetName: 'fothering-alerts' };

  // SendingEnabled is optional on the wire, so both directions always send it explicitly (R11).
  it('pauses with PutConfigurationSetSendingOptions and SendingEnabled false, and reopens with true', async () => {
    const client = sesClient();
    const calls = stubSend(client, () => ({}));
    const writes = createSesWrites({ client: () => client });

    await expect(writes.pauseConfigurationSet('fothering-bulk')).resolves.toBeUndefined();
    await expect(writes.reopenConfigurationSet('fothering-bulk')).resolves.toBeUndefined();

    expect(calls).toEqual([
      { name: 'PutConfigurationSetSendingOptionsCommand', input: { ConfigurationSetName: 'fothering-bulk', SendingEnabled: false } },
      { name: 'PutConfigurationSetSendingOptionsCommand', input: { ConfigurationSetName: 'fothering-bulk', SendingEnabled: true } },
    ]);
  });

  it.each([
    ['SendingEnabled false', '{"sendingEnabled":false}', { SendingOptions: { SendingEnabled: false } }],
    ['SendingEnabled true', '{"sendingEnabled":true}', { SendingOptions: { SendingEnabled: true } }],
    ['no SendingOptions', '{}', { ConfigurationSetName: 'fothering-bulk' }],
    ['SendingOptions holding no SendingEnabled', '{}', { SendingOptions: {} }],
  ])('reads a configuration set answering %s back as %s (AC-E1)', async (_case, expected, response) => {
    const client = sesClient();
    const calls = stubSend(client, () => response);
    const writes = createSesWrites({ client: () => client });

    expect(JSON.stringify(await writes.getConfigurationSetSending('fothering-bulk'))).toBe(expected);
    expect(calls).toEqual([{ name: 'GetConfigurationSetCommand', input: { ConfigurationSetName: 'fothering-bulk' } }]);
  });

  it('passes a read-back error on for the caller to map to pause-unknown', async () => {
    const client = sesClient();
    stubSend(client, () => {
      throw new TooManyRequestsException({ message: 'Too many requests.', $metadata: {} });
    });
    await expect(createSesWrites({ client: () => client }).getConfigurationSetSending('fothering-bulk')).rejects.toBeInstanceOf(TooManyRequestsException);
  });

  it('sends simple text content through the given set with no reply-to, header, attachment, tenant or list option', async () => {
    const client = sesClient();
    const calls = stubSend(client, () => ({ MessageId: 'ses-message-1' }));

    await expect(createSesWrites({ client: () => client }).sendEmail(REQUEST)).resolves.toEqual({ messageId: 'ses-message-1' });

    expect(calls).toEqual([
      {
        name: 'SendEmailCommand',
        input: {
          FromEmailAddress: REQUEST.from,
          Destination: { ToAddresses: REQUEST.to },
          Content: { Simple: { Subject: { Data: REQUEST.subject }, Body: { Text: { Data: REQUEST.text, Charset: 'UTF-8' } } } },
          ConfigurationSetName: 'fothering-alerts',
        },
      },
    ]);
  });

  it('carries the request headers as Content.Simple.Headers and nothing else new', async () => {
    const client = sesClient();
    const calls = stubSend(client, () => ({ MessageId: 'ses-message-2' }));
    const headers = [{ name: 'X-Fothering-AI-Generated', value: 'model-explanation-paragraph' }];

    await createSesWrites({ client: () => client }).sendEmail({ ...REQUEST, headers });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.input).toEqual({
      FromEmailAddress: REQUEST.from,
      Destination: { ToAddresses: REQUEST.to },
      Content: {
        Simple: {
          Subject: { Data: REQUEST.subject },
          Body: { Text: { Data: REQUEST.text, Charset: 'UTF-8' } },
          Headers: [{ Name: 'X-Fothering-AI-Generated', Value: 'model-explanation-paragraph' }],
        },
      },
      ConfigurationSetName: 'fothering-alerts',
    });
  });

  it.each([
    ['no MessageId', {}],
    ['an empty MessageId', { MessageId: '' }],
  ])('throws MissingMessageIdError when SES answers %s', async (_case, response) => {
    const client = sesClient();
    stubSend(client, () => response);
    const sent = createSesWrites({ client: () => client }).sendEmail(REQUEST);
    await expect(sent).rejects.toMatchObject({ name: 'MissingMessageIdError' });
  });
});

interface StubDnsAnswers {
  txt?: (name: string) => Promise<string[][]>;
  mx?: (name: string) => Promise<DnsMxAnswer[]>;
}

interface StubDnsResolvers {
  factory: DnsResolverFactory;
  built: DnsResolverOptions[];
  cancels: () => number;
}

function dnsError(code: unknown): Error {
  return Object.assign(new Error('the lookup failed'), code === undefined ? {} : { code });
}

// Each resolver the factory builds behaves like node's own: cancel rejects only that resolver's
// outstanding queries, with the ECANCELLED code. Every classification case runs through these stubs,
// because the test guard refuses any real resolve call (research Pitfall 11).
function stubDnsResolvers(answers: StubDnsAnswers): StubDnsResolvers {
  const built: DnsResolverOptions[] = [];
  let cancels = 0;
  const factory = (options: DnsResolverOptions): DnsResolver => {
    built.push(options);
    const outstanding: ((error: Error) => void)[] = [];
    function tracked<T>(answer: ((name: string) => Promise<T>) | undefined, name: string): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        outstanding.push(reject);
        (answer?.(name) ?? Promise.reject(new Error('no answer stubbed for this lookup'))).then(resolve, reject);
      });
    }
    return {
      resolveTxt: (name) => tracked(answers.txt, name),
      resolveMx: (name) => tracked(answers.mx, name),
      cancel: () => {
        cancels += 1;
        for (const reject of outstanding) reject(dnsError(dnsPromises.CANCELLED));
      },
    };
  };
  return { factory, built, cancels: () => cancels };
}

const NEVER_SETTLES = (): Promise<never> => new Promise<never>(() => {});

describe('createLiveDns (D-58, AC-E26 adapter half)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('builds no resolver before the first lookup, then one per lookup with timeout 2,000 and tries 1', async () => {
    const stub = stubDnsResolvers({ txt: async () => [], mx: async () => [] });
    const dns = createLiveDns({ resolverFactory: stub.factory });
    expect(stub.built.length).toBe(0);

    await dns.resolveTxt('example.com');
    await dns.resolveMx('example.com');

    expect(`${DNS_LOOKUP_TIMEOUT_MS} ${DNS_LOOKUP_TRIES}`).toBe('2000 1');
    expect(JSON.stringify(stub.built)).toBe('[{"timeout":2000,"tries":1},{"timeout":2000,"tries":1}]');
  });

  it("joins each TXT record's chunks into one string per record", async () => {
    const stub = stubDnsResolvers({ txt: async () => [['v=spf1 include:', '_spf.example.com ~all'], ['site-verification=abc']] });
    const outcome = await createLiveDns({ resolverFactory: stub.factory }).resolveTxt('example.com');
    expect(JSON.stringify(outcome)).toBe('{"kind":"records","records":["v=spf1 include:_spf.example.com ~all","site-verification=abc"]}');
  });

  it('returns each MX exchange lowercased with its trailing dot removed', async () => {
    const stub = stubDnsResolvers({
      mx: async () => [
        { exchange: 'MX01.Mail.Example.COM.', priority: 10 },
        { exchange: 'mx02.mail.example.com', priority: 20 },
      ],
    });
    const outcome = await createLiveDns({ resolverFactory: stub.factory }).resolveMx('example.com');
    expect(JSON.stringify(outcome)).toBe('{"kind":"records","exchanges":["mx01.mail.example.com","mx02.mail.example.com"]}');
  });

  it.each([
    ['NODATA', dnsPromises.NODATA],
    ['NOTFOUND', dnsPromises.NOTFOUND],
  ])('reads missing for a %s error on TXT and on MX', async (_label, code) => {
    const stub = stubDnsResolvers({ txt: async () => Promise.reject(dnsError(code)), mx: async () => Promise.reject(dnsError(code)) });
    const dns = createLiveDns({ resolverFactory: stub.factory });
    const txt = await dns.resolveTxt('_dmarc.example.com');
    const mx = await dns.resolveMx('example.com');
    expect(`${txt.kind} ${mx.kind}`).toBe('missing missing');
  });

  // AC-P11: a failed lookup is not a missing record, so everything but a definite no-record answer reads unknown.
  it.each<[string, () => unknown]>([
    ['TIMEOUT', () => dnsError(dnsPromises.TIMEOUT)],
    ['SERVFAIL', () => dnsError(dnsPromises.SERVFAIL)],
    ['REFUSED', () => dnsError(dnsPromises.REFUSED)],
    ['CONNREFUSED', () => dnsError(dnsPromises.CONNREFUSED)],
    ['BADRESP', () => dnsError(dnsPromises.BADRESP)],
    ['FORMERR', () => dnsError(dnsPromises.FORMERR)],
    ['CANCELLED', () => dnsError(dnsPromises.CANCELLED)],
    ['a code node does not list', () => dnsError('EUNLISTED')],
    ['a code that is not a string', () => dnsError(404)],
    ['an error with no code', () => dnsError(undefined)],
    ['a thrown value that is not an object', () => 'lookup failed'],
  ])('reads unknown, never missing, for %s on TXT and on MX', async (_label, thrown) => {
    const stub = stubDnsResolvers({ txt: async () => Promise.reject(thrown()), mx: async () => Promise.reject(thrown()) });
    const dns = createLiveDns({ resolverFactory: stub.factory });
    const txt = await dns.resolveTxt('_dmarc.example.com');
    const mx = await dns.resolveMx('example.com');
    expect(`${txt.kind} ${mx.kind}`).toBe('unknown unknown');
  });

  it('classifies a resolver that throws before it returns a promise the same as one that rejects', async () => {
    const throwing: DnsResolverFactory = () => ({
      resolveTxt: () => {
        throw dnsError(dnsPromises.NOTFOUND);
      },
      resolveMx: () => {
        throw dnsError(dnsPromises.NODATA);
      },
      cancel: () => {},
    });
    const dns = createLiveDns({ resolverFactory: throwing });
    const txt = await dns.resolveTxt('example.com');
    const mx = await dns.resolveMx('example.com');
    expect(`${txt.kind} ${mx.kind}`).toBe('missing missing');
  });

  it.each(['resolveTxt', 'resolveMx'] as const)(
    'gives unknown for a %s that outlives the 2,000 ms bound, and cancels its resolver at the bound',
    async (operation) => {
      vi.useFakeTimers();
      const stub = stubDnsResolvers({ txt: NEVER_SETTLES, mx: NEVER_SETTLES });
      const dns = createLiveDns({ resolverFactory: stub.factory });
      let kind = 'pending';
      const pending = dns[operation]('example.com').then((outcome) => {
        kind = outcome.kind;
      });

      await vi.advanceTimersByTimeAsync(DNS_LOOKUP_TIMEOUT_MS - 1);
      expect(`${kind} cancels ${stub.cancels()}`).toBe('pending cancels 0');
      await vi.advanceTimersByTimeAsync(1);
      await pending;
      expect(`${kind} cancels ${stub.cancels()}`).toBe('unknown cancels 1');
    },
  );

  it('leaves no timer behind once a lookup settles inside the bound', async () => {
    vi.useFakeTimers();
    const stub = stubDnsResolvers({ txt: async () => [['v=spf1 -all']] });
    await createLiveDns({ resolverFactory: stub.factory }).resolveTxt('example.com');
    expect(`timers ${vi.getTimerCount()} cancels ${stub.cancels()}`).toBe('timers 0 cancels 0');
  });

  // cancel() ends every outstanding query of a resolver, so a resolver shared by concurrent lookups
  // would turn a slow neighbour's timeout into an unknown for an answer still on its way.
  it('gives each lookup its own resolver, so a timed-out lookup never cancels a concurrent one', async () => {
    vi.useFakeTimers();
    const stub = stubDnsResolvers({
      txt: (name) =>
        name === 'slow.example.com'
          ? NEVER_SETTLES()
          : new Promise((resolve) => {
              setTimeout(() => resolve([['v=spf1 -all']]), 1_500);
            }),
    });
    const dns = createLiveDns({ resolverFactory: stub.factory });
    const slow = dns.resolveTxt('slow.example.com');
    await vi.advanceTimersByTimeAsync(1_000);
    const fast = dns.resolveTxt('fast.example.com');
    await vi.advanceTimersByTimeAsync(1_500);

    const outcomes = await Promise.all([slow, fast]);
    expect(`${outcomes.map((outcome) => outcome.kind).join(' ')} cancels ${stub.cancels()}`).toBe('unknown records cancels 1');
  });

  // The control for every case above: without an injected resolver the guard is what answers, and
  // the adapter must read that refusal as unknown for the guard's own reason, not by accident.
  it('reads unknown on a real Resolver under the test guard, and the error it caught is the guard refusal', async () => {
    const caught: unknown[] = [];
    const watched = async <T>(lookup: () => Promise<T>): Promise<T> => {
      try {
        return await lookup();
      } catch (error) {
        caught.push(error);
        throw error;
      }
    };
    const realResolvers: DnsResolverFactory = (options) => {
      const real = new dnsPromises.Resolver(options);
      return {
        resolveTxt: (name) => watched(() => real.resolveTxt(name)),
        resolveMx: (name) => watched(() => real.resolveMx(name)),
        cancel: () => real.cancel(),
      };
    };
    const dns = createLiveDns({ resolverFactory: realResolvers });

    const txt = await dns.resolveTxt('example.com');
    const mx = await dns.resolveMx('example.com');
    expect(`${txt.kind} ${mx.kind}`).toBe('unknown unknown');
    expect(caught.map((error) => (error as Error).name).join(' ')).toBe('NetworkGuardError NetworkGuardError');
    expect(caught[0]).toBeInstanceOf(NetworkGuardError);
    expect((await createLiveDns().resolveTxt('example.com')).kind).toBe('unknown');
  });

  it('resolves the dns row live in deployed whatever the switch, looking up through liveClients.dnsResolver', async () => {
    for (const switchValue of [undefined, 'live']) {
      const stub = stubDnsResolvers({ mx: async () => [{ exchange: 'MX.Example.com.', priority: 10 }] });
      const { ports, kinds } = resolvePortTable({
        runtimeContext: 'deployed',
        switchValue,
        liveClients: { dnsResolver: stub.factory },
        dryRunSink: () => {},
      });
      expect(`${kinds.dns?.resolveMx} ${kinds.dns?.resolveTxt} built ${stub.built.length}`).toBe('live live built 0');
      expect(JSON.stringify(await ports.dns.resolveMx('example.com'))).toBe('{"kind":"records","exchanges":["mx.example.com"]}');
      expect(stub.built.length).toBe(1);
    }
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

const RUNTIME_ARN = 'arn:aws:bedrock-agentcore:eu-central-1:000000000000:runtime/fothering';
const FORCED_TOOL = { name: 'strands_structured_output', description: 'answer', inputSchema: { type: 'object' as const } };
// A Converse answer in the shape the API documents (API_runtime_Converse): one assistant text block,
// the stop reason and the token usage.
const CONVERSE_RESPONSE = {
  output: { message: { role: 'assistant', content: [{ text: 'the explanation' }] } },
  stopReason: 'end_turn',
  usage: { inputTokens: 1_200, outputTokens: 80, totalTokens: 1_280 },
};

function userMessage(text: string): Message {
  return new Message({ role: 'user', content: [new TextBlock(text)] });
}

async function drainEvents(iterable: AsyncIterable<ModelStreamEvent>): Promise<ModelStreamEvent[]> {
  const events: ModelStreamEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

interface CapturedBedrockSend {
  name: string;
  input: Record<string, unknown>;
  client: { config: { region: () => Promise<string>; maxAttempts: () => Promise<number> } };
}

// BedrockModel builds its own runtime client and takes no prebuilt one (bedrock.d.ts 1.20.0), so the
// capture replaces send on that client class's prototype, reached through a probe model's client
// rather than an import of a package providers does not list. Nothing is signed or sent: the
// replacement answers before any middleware runs. Each failure given is thrown by one send, in order,
// before the sends that answer.
function captureBedrockRuntimeSends(failures: readonly Error[] = []): { sends: CapturedBedrockSend[]; restore: () => void } {
  const probe = new BedrockModel({ region: REGION, modelId: MODEL_VALUES.inferenceProfileId, clientConfig: { credentials: FAKE_CREDENTIALS } });
  const prototype = Object.getPrototypeOf((probe as unknown as { _client: object })._client) as Record<string, unknown>;
  const ownSend = Object.getOwnPropertyDescriptor(prototype, 'send');
  const sends: CapturedBedrockSend[] = [];
  const pending = [...failures];
  prototype.send = async function send(
    this: CapturedBedrockSend['client'],
    command: { constructor: { name: string }; input: Record<string, unknown> },
  ): Promise<unknown> {
    sends.push({ name: command.constructor.name, input: command.input, client: this });
    const failure = pending.shift();
    if (failure !== undefined) throw failure;
    return structuredClone(CONVERSE_RESPONSE);
  };
  return {
    sends,
    restore: () => {
      if (ownSend === undefined) delete prototype.send;
      else Object.defineProperty(prototype, 'send', ownSend);
    },
  };
}

describe('createLiveBedrockModel', () => {
  let restoreSend: (() => void) | undefined;
  afterEach(() => {
    restoreSend?.();
    restoreSend = undefined;
  });

  function capture(failures: readonly Error[] = []): CapturedBedrockSend[] {
    const { sends, restore } = captureBedrockRuntimeSends(failures);
    restoreSend = restore;
    return sends;
  }

  // The shape the runtime client rejects with: an AWS service error carries its exception type as its name.
  function awsServiceError(name: string): Error {
    return Object.assign(new Error('the service refused the request'), { name, $fault: 'client' });
  }

  // Strands maps a throttle to its retry class only on a streamed response (bedrock.js 1.20.0 line
  // 1401), so with stream off the adapter maps the client's ThrottlingException itself.
  it('turns a throttled Converse into the SDK retry class, and passes every other error on unchanged', async () => {
    const throttle = awsServiceError('ThrottlingException');
    const unavailable = awsServiceError('ServiceUnavailableException');
    capture([throttle, unavailable]);
    const port = createLiveBedrockModel();

    const throttled: unknown = await drainEvents(port.stream([userMessage('p')])).catch((error: unknown) => error);
    expect(throttled).toBeInstanceOf(ModelThrottledError);
    expect((throttled as Error).cause).toBe(throttle);
    await expect(drainEvents(port.stream([userMessage('p')]))).rejects.toBe(unavailable);
  });

  // The same retry strategy the runtime handler builds, with no wait, over the live adapter: the
  // throttled call is sent once more and the loop answers from the second.
  it('lets the agent loop retry one throttled call through the live adapter', async () => {
    const sends = capture([awsServiceError('ThrottlingException')]);
    const model = new PortBackedModel({
      port: createLiveBedrockModel(),
      config: { modelId: MODEL_VALUES.inferenceProfileId, maxTokens: MODEL_VALUES.maxTokens },
      ceiling: MODEL_VALUES.modelCallCeiling,
      inputByteCeiling: MODEL_VALUES.inputTokenCeiling,
    });
    const agent = new Agent({
      model,
      tools: [],
      printer: false,
      retryStrategy: new DefaultModelRetryStrategy({ maxAttempts: MODEL_VALUES.throttleAttempts, backoff: new ConstantBackoff({ delayMs: 0 }) }),
    });

    await agent.invoke('p');
    expect(sends.map((send) => send.name)).toEqual(['ConverseCommand', 'ConverseCommand']);
    expect(model.calls).toBe(2);
  });

  it('builds one BedrockModel on the first stream call, every option read from MODEL_VALUES', async () => {
    const sends = capture();
    const built: BedrockModelOptions[] = [];
    const port = createLiveBedrockModel((options) => {
      built.push(options);
      return new BedrockModel(options);
    });
    expect(built).toHaveLength(0);

    await drainEvents(port.stream([userMessage('first')]));
    await drainEvents(port.stream([userMessage('second')]));

    expect(built).toHaveLength(1);
    expect(built[0]).toEqual({
      region: 'eu-central-1',
      modelId: 'eu.anthropic.claude-sonnet-4-6',
      maxTokens: 1_024,
      stream: false,
      additionalArgs: { additionalModelRequestFields: { thinking: { type: 'disabled' } } },
      clientConfig: { maxAttempts: 1 },
      requestTimeout: 60_000,
    });
    expect(sends).toHaveLength(2);
    expect(sends[1]?.client).toBe(sends[0]?.client);
    await expect(sends[0]?.client.config.region()).resolves.toBe('eu-central-1');
    await expect(sends[0]?.client.config.maxAttempts()).resolves.toBe(1);
  });

  it('sends Converse with maxTokens alone in inferenceConfig and thinking disabled, on a forced tool call too', async () => {
    const sends = capture();
    const port = createLiveBedrockModel();

    const events = await drainEvents(port.stream([userMessage('p')], { systemPrompt: 's' }));
    await drainEvents(port.stream([userMessage('p')], { systemPrompt: 's', toolSpecs: [FORCED_TOOL], toolChoice: { tool: { name: FORCED_TOOL.name } } }));

    expect(sends.map((send) => send.name)).toEqual(['ConverseCommand', 'ConverseCommand']);
    for (const send of sends) {
      expect(send.input.modelId).toBe('eu.anthropic.claude-sonnet-4-6');
      expect(send.input.inferenceConfig).toEqual({ maxTokens: 1_024 });
      expect(send.input.additionalModelRequestFields).toEqual({ thinking: { type: 'disabled' } });
      expect(JSON.stringify(send.input)).not.toMatch(/temperature|topP|topK|top_p|top_k/);
    }
    expect(sends[1]?.input.toolConfig).toMatchObject({ toolChoice: { tool: { name: FORCED_TOOL.name } } });
    expect(events.at(-1)).toMatchObject({ type: 'modelMetadataEvent', usage: { inputTokens: 1_200, outputTokens: 80, totalTokens: 1_280 } });
  });

  // The control for the case above: the SDK's own request-fields route loses thinking on a forced
  // tool call (Pitfall 1), so the capture can see the drop the additionalArgs route prevents.
  it('drops thinking on a forced tool call when it is sent through additionalRequestFields instead', async () => {
    const sends = capture();
    const model = new BedrockModel({
      region: REGION,
      modelId: MODEL_VALUES.inferenceProfileId,
      stream: false,
      additionalRequestFields: { thinking: { type: 'disabled' } },
      clientConfig: { credentials: FAKE_CREDENTIALS },
    });

    await drainEvents(model.stream([userMessage('p')], { toolSpecs: [FORCED_TOOL], toolChoice: { tool: { name: FORCED_TOOL.name } } }));
    expect(sends[0]?.input.additionalModelRequestFields).toBeUndefined();
  });
});

interface CapturedAgentCoreSend {
  name: string;
  input: { payload?: unknown } & Record<string, unknown>;
  options: unknown;
}

function stubAgentCoreSend(client: BedrockAgentCoreClient, body: string | undefined): CapturedAgentCoreSend[] {
  const calls: CapturedAgentCoreSend[] = [];
  (client as unknown as { send: unknown }).send = async (
    command: { constructor: { name: string }; input: CapturedAgentCoreSend['input'] },
    options?: unknown,
  ): Promise<unknown> => {
    calls.push({ name: command.constructor.name, input: command.input, options });
    return {
      contentType: 'application/json',
      response: body === undefined ? undefined : { transformToString: async () => body },
    };
  };
  return calls;
}

function agentCoreClient(): BedrockAgentCoreClient {
  return new BedrockAgentCoreClient({ region: REGION, credentials: FAKE_CREDENTIALS });
}

describe('createLiveAgentCore', () => {
  it('sends InvokeAgentRuntimeCommand with the ARN, the session, JSON content types and payload bytes, and parses the body', async () => {
    const client = agentCoreClient();
    const calls = stubAgentCoreSend(client, '{"status":"answered","modelCalls":1}');
    const controller = new AbortController();
    const payload = { record: { rows: [1, 2] }, note: 'café' };

    const answer = await createLiveAgentCore({ client: () => client }).invokeAgentRuntime({
      runtimeArn: RUNTIME_ARN,
      sessionId: 'fothering-incident-a1',
      payload,
      abortSignal: controller.signal,
    });

    expect(answer).toEqual({ status: 'answered', modelCalls: 1 });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.name).toBe('InvokeAgentRuntimeCommand');
    expect(calls[0]?.input).toMatchObject({
      agentRuntimeArn: RUNTIME_ARN,
      runtimeSessionId: 'fothering-incident-a1',
      contentType: 'application/json',
      accept: 'application/json',
    });
    expect(calls[0]?.input.payload).toBeInstanceOf(Uint8Array);
    expect(Buffer.from(calls[0]?.input.payload as Uint8Array).toString('utf8')).toBe(JSON.stringify(payload));
    expect((calls[0]?.options as { abortSignal?: unknown } | undefined)?.abortSignal).toBe(controller.signal);
  });

  it('refuses a response with no body, naming nothing of the payload', async () => {
    const client = agentCoreClient();
    stubAgentCoreSend(client, undefined);
    const refusal = await createLiveAgentCore({ client: () => client })
      .invokeAgentRuntime({ runtimeArn: RUNTIME_ARN, sessionId: 's', payload: { note: 'Jane' } })
      .catch((error: unknown) => error);
    expect((refusal as Error).message).toBe('the agent runtime returned no response body');
  });

  it('builds no client before the first call through the port table, and one after two calls', async () => {
    const client = agentCoreClient();
    stubAgentCoreSend(client, '{}');
    let built = 0;
    const { ports, kinds } = resolvePortTable({
      runtimeContext: 'deployed',
      switchValue: 'live',
      liveClients: {
        bedrockAgentCore: () => {
          built += 1;
          return client;
        },
      },
      dryRunSink: () => {},
    });

    expect(kinds.agentCore?.invokeAgentRuntime).toBe('live');
    expect(built).toBe(0);
    await ports.agentCore.invokeAgentRuntime({ runtimeArn: RUNTIME_ARN, sessionId: 's', payload: {} });
    await ports.agentCore.invokeAgentRuntime({ runtimeArn: RUNTIME_ARN, sessionId: 's', payload: {} });
    expect(built).toBe(1);
  });
});
