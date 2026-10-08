import { afterEach, describe, expect, it, vi } from 'vitest';
import fc from 'fast-check';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { SQSClient } from '@aws-sdk/client-sqs';
import { NotFoundException, SESv2Client, TooManyRequestsException } from '@aws-sdk/client-sesv2';
import {
  SES_EVENT_TYPES,
  bucketSortKeyPrefix,
  isStorableBucketStart,
  recordKey,
  type EventRecord,
  type RecordKey,
} from '@fothering/core/records';
import { selectKeyVersion } from '@fothering/core/address';
import { propertySeed } from '@fothering/core/test/property-seed';
import { findLane } from '@fothering/core/lanes';
import { minimizeEvent } from '@fothering/core/minimize';
import { parseSesEvent } from '@fothering/core/ses-events';
import { resolvePortTable } from '../ports.js';
import { SES_READ_SPACING_MS } from '../ses-facts.js';
import { TEST_ADDRESS_KEY_SET } from '../fixtures/ingest-ports.js';
import { DOC_EXAMPLE_LANE_MAP, SES_EVENT_FIXTURE_NAMES, loadSesEventFixture } from '../fixtures/ses-events/index.js';
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

  it('deletes a record with a conditional DeleteCommand and resolves true', async () => {
    const client = dynamoClient();
    const calls = stubSend(client, () => ({}));
    const store = createDynamoEventStore({ tableName: 'events', client: () => client, now: () => 0 });

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
    const store = createDynamoEventStore({ tableName: 'events', client: () => client, now: () => 0 });

    await expect(store.deleteRecord({ pk: 'LANE#x', sk: 'gone' })).resolves.toBe(false);
    await expect(store.deleteRecord({ pk: 'LANE#x', sk: 'gone' })).rejects.toThrow('network blip');
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
      const store = createDynamoEventStore({ tableName: 'events', client: () => client, now: () => 0 });
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
    const store = createDynamoEventStore({ tableName: 'events', client: () => client, now: () => 0 });
    for (const record of records) await expect(store.putIfAbsent(record)).resolves.toBe('written');

    expect(items).toHaveLength(records.length);
    expect(items[0]).toMatchObject({ pk: { S: records[0]?.pk }, expiresAt: { N: String(records[0]?.expiresAt) } });
  });

  it('refuses a record holding an undefined field, so the capture above is the real marshaller', async () => {
    const client = dynamoClient();
    captureMarshalledItems(client);
    const store = createDynamoEventStore({ tableName: 'events', client: () => client, now: () => 0 });
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
    const store = createDynamoEventStore({ tableName: '', client: count(dynamoClient), now: () => 0 });
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
    const store = createDynamoEventStore({ tableName: '   ', client: dynamoClient, now: () => 0 });
    await expect(store.getRecord({ pk: 'LANE#x', sk: 'y' })).rejects.toMatchObject({ envVar: 'FOTHERING_TABLE_NAME' });
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

  it("getEmailIdentity returns the identity's ConfigurationSetName", async () => {
    const client = sesClient();
    stubSend(client, () => ({ ConfigurationSetName: 'fothering-transactional' }));
    const reads = createSesReads({ client: () => client });

    await expect(reads.getEmailIdentity('sender@example.com')).resolves.toBe('fothering-transactional');
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
