import { describe, expect, it } from 'vitest';
import { createFixtureEventStore } from '@fothering/providers/fixtures/ingest-ports';
import type { EventStorePort } from '@fothering/providers/port-types';
import { hmacUnderEveryVersion, pseudonymizeRecipient, type AddressKeySet } from './address.js';
import { expiresAtFor, recordKey, type EventRecord, type RecordKey, type SesEventType } from './records.js';
import { forgetRecipient } from './forget.js';

const T_ROTATION = 1_700_000_000_000;
const KEY_SET: AddressKeySet = {
  versions: [
    { id: 'k1', secret: 'secret-one', activeFromMs: 0 },
    { id: 'k2', secret: 'secret-two', activeFromMs: T_ROTATION },
  ],
};

const LANES = ['fothering-bulk', 'fothering-transactional'] as const;
const OUTCOME_EVENT_TYPES: SesEventType[] = ['Send', 'Delivery', 'Bounce', 'DeliveryDelay'];

let identityCounter = 0;
function nextIdentity(): string {
  identityCounter += 1;
  return `id-${String(identityCounter)}`;
}

function buildRecord(input: {
  configurationSet: string;
  eventType: SesEventType;
  bucketStartMs: number;
  kind: 'outcome' | 'complaint' | 'complaintRecipient';
  pseudonym?: { receivingDomain: string; recipientHmac: string; keyVersion: string };
  recipientCount?: number;
}): EventRecord {
  const identity = nextIdentity();
  const { pk, sk } = recordKey({
    configurationSet: input.configurationSet,
    bucketStartMs: input.bucketStartMs,
    eventType: input.eventType,
    identity,
  });
  return {
    pk,
    sk,
    kind: input.kind,
    eventType: input.eventType,
    configurationSet: input.configurationSet,
    bucketStartMs: input.bucketStartMs,
    mailTimestampMs: input.bucketStartMs,
    envelopeTimeMs: input.bucketStartMs,
    arrivalTimeMs: input.bucketStartMs,
    messageId: `msg-${identity}`,
    provenance: 'generated',
    expiresAt: expiresAtFor(input.bucketStartMs),
    fields: {},
    ...(input.pseudonym !== undefined
      ? { recipientHmac: input.pseudonym.recipientHmac, receivingDomain: input.pseudonym.receivingDomain, keyVersion: input.pseudonym.keyVersion }
      : {}),
    ...(input.recipientCount !== undefined ? { recipientCount: input.recipientCount } : {}),
  };
}

// Every lane, every outcome event type, both retained key versions for the target, plus its two
// complaint recipient items and one complaint counting record with no recipient at all. Three
// other addresses each get one record, to prove the delete stays exact.
async function seedTarget(store: EventStorePort, targetAddress: string): Promise<{ nonTargets: string[] }> {
  for (const lane of LANES) {
    for (const eventType of OUTCOME_EVENT_TYPES) {
      for (const sendTimeMs of [0, T_ROTATION]) {
        const pseudonym = pseudonymizeRecipient(targetAddress, KEY_SET, sendTimeMs);
        await store.putIfAbsent(buildRecord({ configurationSet: lane, eventType, bucketStartMs: sendTimeMs, kind: 'outcome', pseudonym }));
      }
    }
  }

  for (const sendTimeMs of [0, T_ROTATION]) {
    const pseudonym = pseudonymizeRecipient(targetAddress, KEY_SET, sendTimeMs);
    await store.putIfAbsent(
      buildRecord({ configurationSet: 'fothering-bulk', eventType: 'Complaint', bucketStartMs: sendTimeMs, kind: 'complaintRecipient', pseudonym }),
    );
  }
  await store.putIfAbsent(
    buildRecord({ configurationSet: 'fothering-bulk', eventType: 'Complaint', bucketStartMs: 0, kind: 'complaint', recipientCount: 0 }),
  );

  const nonTargets = ['jane2@example.com', 'jane@example.co', 'jane+x@example.com'];
  for (const address of nonTargets) {
    const pseudonym = pseudonymizeRecipient(address, KEY_SET, 0);
    await store.putIfAbsent(buildRecord({ configurationSet: 'fothering-bulk', eventType: 'Bounce', bucketStartMs: 0, kind: 'outcome', pseudonym }));
  }

  return { nonTargets };
}

function fakeSleep(): { sleep: (ms: number) => Promise<void>; calls: number[] } {
  const calls: number[] = [];
  return {
    calls,
    sleep: async (ms) => {
      calls.push(ms);
    },
  };
}

describe('forgetRecipient (AC-15)', () => {
  it('removes every record of the target across two lanes, four event types and every retained key version, leaving every other recipient in place (AC-15, AC-E27)', async () => {
    const store = createFixtureEventStore();
    const target = 'jane@example.com';
    const { nonTargets } = await seedTarget(store, target);
    const { sleep } = fakeSleep();

    const report = await forgetRecipient({ address: target, keySet: KEY_SET, store, sleep });

    expect(report.deleted).toBe(18);
    expect(report.remaining).toBe(0);
    expect(report.perKeyVersion.map((entry) => entry.keyVersion)).toEqual(['k2', 'k1']);
    expect(report.perKeyVersion.reduce((sum, entry) => sum + entry.deleted, 0)).toBe(18);

    for (const { recipientHmac } of hmacUnderEveryVersion(target, KEY_SET)) {
      await expect(store.queryByRecipient(recipientHmac)).resolves.toHaveLength(0);
    }
    for (const address of nonTargets) {
      const hmac = pseudonymizeRecipient(address, KEY_SET, 0).recipientHmac;
      await expect(store.queryByRecipient(hmac)).resolves.toHaveLength(1);
    }
  });

  it('resolves 0 deleted and 0 remaining for an address with no records (AC-E28)', async () => {
    const store = createFixtureEventStore();
    const { sleep } = fakeSleep();

    const report = await forgetRecipient({ address: 'nobody@example.com', keySet: KEY_SET, store, sleep });

    expect(report).toEqual({
      perKeyVersion: [
        { keyVersion: 'k2', deleted: 0 },
        { keyVersion: 'k1', deleted: 0 },
      ],
      deleted: 0,
      remaining: 0,
    });
  });

  it('deletes 0 on a second run for the same address that was already forgotten (AC-E29)', async () => {
    const store = createFixtureEventStore();
    const target = 'jane@example.com';
    await seedTarget(store, target);
    const { sleep } = fakeSleep();

    await forgetRecipient({ address: target, keySet: KEY_SET, store, sleep });
    const second = await forgetRecipient({ address: target, keySet: KEY_SET, store, sleep });

    expect(second.deleted).toBe(0);
    expect(second.remaining).toBe(0);
  });

  it('leaves the final deleted count and remaining unchanged when the index returns keys in reverse order (AC-E30 backstop)', async () => {
    const store = createFixtureEventStore();
    const target = 'jane@example.com';
    await seedTarget(store, target);
    const reversedStore: EventStorePort = {
      ...store,
      queryByRecipient: async (hmac) => [...(await store.queryByRecipient(hmac))].reverse(),
    };
    const { sleep } = fakeSleep();

    const report = await forgetRecipient({ address: target, keySet: KEY_SET, store: reversedStore, sleep });

    expect(report.deleted).toBe(18);
    expect(report.remaining).toBe(0);
  });

  // Pitfall 10: the byRecipient index is eventually consistent, so the first pass over one hmac
  // can miss a record that genuinely exists. The bounded re-query must still find and delete it.
  it('deletes and counts a record the index hides on the first query and reveals on the first re-query (Pitfall 10)', async () => {
    const store = createFixtureEventStore();
    const target = 'jane@example.com';
    await seedTarget(store, target);
    const targetHashes = hmacUnderEveryVersion(target, KEY_SET);
    const hiddenHmac = targetHashes[0]?.recipientHmac;
    if (hiddenHmac === undefined) throw new Error('expected at least one target hash');
    let hiddenQueries = 0;
    const flakyStore: EventStorePort = {
      ...store,
      queryByRecipient: async (hmac) => {
        if (hmac === hiddenHmac) {
          hiddenQueries += 1;
          if (hiddenQueries === 1) return [];
        }
        return store.queryByRecipient(hmac);
      },
    };
    const { sleep } = fakeSleep();

    const report = await forgetRecipient({ address: target, keySet: KEY_SET, store: flakyStore, sleep });

    expect(report.deleted).toBe(18);
    expect(report.remaining).toBe(0);
    expect(hiddenQueries).toBeGreaterThanOrEqual(2);
    await expect(store.queryByRecipient(hiddenHmac)).resolves.toHaveLength(0);
  });

  // The same lag runs the other way too: right after a delete, the index can still name the record
  // for a moment. A re-query that meets that stale key must not count the record a second time.
  it('counts each record once when the index still lists a record the first pass already deleted (Pitfall 10, reverse lag)', async () => {
    const store = createFixtureEventStore();
    const target = 'jane@example.com';
    await seedTarget(store, target);
    const keyText = (key: RecordKey): string => `${key.pk}|${key.sk}`;
    const hmacByKey = new Map<string, string>();
    const staleByHmac = new Map<string, RecordKey[]>();
    const deletedOnce = new Set<string>();
    const laggingStore: EventStorePort = {
      ...store,
      queryByRecipient: async (hmac) => {
        const live = await store.queryByRecipient(hmac);
        for (const key of live) hmacByKey.set(keyText(key), hmac);
        const stale = staleByHmac.get(hmac) ?? [];
        staleByHmac.delete(hmac);
        return [...live, ...stale];
      },
      deleteRecord: async (key) => {
        const result = await store.deleteRecord(key);
        const hmac = hmacByKey.get(keyText(key));
        if (hmac !== undefined && !deletedOnce.has(keyText(key))) {
          deletedOnce.add(keyText(key));
          staleByHmac.set(hmac, [...(staleByHmac.get(hmac) ?? []), key]);
        }
        return result;
      },
    };
    const { sleep } = fakeSleep();

    const report = await forgetRecipient({ address: target, keySet: KEY_SET, store: laggingStore, sleep });

    expect(report.deleted).toBe(18);
    expect(report.remaining).toBe(0);
    expect(report.perKeyVersion.reduce((sum, entry) => sum + entry.deleted, 0)).toBe(18);
  });

  // A re-query issued the instant the first pass ends gives the index no time to catch up, so the
  // wait comes before every re-query, the first one included.
  it('waits before its first re-query, after the first pass has queried every retained hash', async () => {
    const store = createFixtureEventStore();
    await seedTarget(store, 'jane@example.com');
    let queries = 0;
    const countingStore: EventStorePort = {
      ...store,
      queryByRecipient: async (hmac) => {
        queries += 1;
        return store.queryByRecipient(hmac);
      },
    };
    const queriesAtEachSleep: number[] = [];
    const sleep = async (): Promise<void> => {
      queriesAtEachSleep.push(queries);
    };

    await forgetRecipient({ address: 'jane@example.com', keySet: KEY_SET, store: countingStore, sleep });

    expect(queriesAtEachSleep[0]).toBe(KEY_SET.versions.length);
  });
});

describe('forgetRecipient key handling', () => {
  // With no version there is nothing to hash under, so no record is searched at all: a report of
  // 0 deleted would read as "nothing stored for this person" when nothing was looked at.
  it('refuses a key set with no versions instead of reporting 0 deleted', async () => {
    const store = createFixtureEventStore();
    await seedTarget(store, 'jane@example.com');
    const { sleep } = fakeSleep();

    await expect(forgetRecipient({ address: 'jane@example.com', keySet: { versions: [] }, store, sleep })).rejects.toThrow(
      /no key version/,
    );
  });

  it('accepts an injected maxRequeries and still converges to remaining 0 once the store settles', async () => {
    const store = createFixtureEventStore();
    const target = 'jane@example.com';
    await seedTarget(store, target);
    const { sleep, calls } = fakeSleep();

    const report = await forgetRecipient({ address: target, keySet: KEY_SET, store, sleep, maxRequeries: 1 });

    expect(report.remaining).toBe(0);
    expect(calls.length).toBeLessThanOrEqual(1);
  });
});
