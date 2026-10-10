import { describe, expect, it } from 'vitest';
import type { KindTable } from '@fothering/providers/port-types';
import { EXPECTED_KINDS, SWITCH_VALUES, assertRootMatrix } from '@fothering/providers/test/root-matrix';
import { buildIngestRoot } from '../ingest/root.js';
import { buildForgetRoot } from './root.js';

// The columns of the literal oracle: a test context, then a deployed one with any switch value but live.
function kindsInColumn(column: 0 | 1): KindTable {
  return Object.fromEntries(
    Object.entries(EXPECTED_KINDS).map(([port, row]) => [
      port,
      Object.fromEntries(Object.entries(row).map(([operation, columns]) => [operation, columns[column]])),
    ]),
  );
}

function countingClient(counter: { constructions: number; sent: number }): () => { send: () => Promise<never> } {
  return () => {
    counter.constructions += 1;
    return {
      send: () => {
        counter.sent += 1;
        return Promise.reject(new Error('not stubbed for this test'));
      },
    };
  };
}

describe('buildForgetRoot against the expected-kind table', () => {
  it('resolves every operation of every row to its expected kind over 2 contexts and 7 switch values', () => {
    expect(() => assertRootMatrix(buildForgetRoot)).not.toThrow();
  });

  it('builds no AWS client while resolving in deployed, whatever the switch', () => {
    const counter = { constructions: 0, sent: 0 };
    for (const switchValue of SWITCH_VALUES) {
      buildForgetRoot({
        runtimeContext: 'deployed',
        switchValue,
        liveConfig: { tableName: 'events', addressKeySecretId: 'address-key' },
        liveClients: { dynamoDb: countingClient(counter), secretsManager: countingClient(counter) },
        dryRunSink: () => {},
      });
    }
    expect(counter.constructions).toBe(0);
  });
});

// Two roots built in one process, as a test harness or a warm container running both handlers would:
// neither may take its resolution from the other.
describe('two composition roots built together', () => {
  const builders = [
    ['ingest deployed first, forget in test second', 'ingest-first'],
    ['forget in test first, ingest deployed second', 'forget-first'],
  ] as const;

  it.each(builders)('keep their own resolutions and their own ports: %s', async (_label, order) => {
    const counter = { constructions: 0, sent: 0 };
    const buildIngest = (): ReturnType<typeof buildIngestRoot> =>
      buildIngestRoot({
        runtimeContext: 'deployed',
        switchValue: undefined,
        liveConfig: { tableName: 'events', addressKeySecretId: 'address-key', deadLetterQueueUrl: 'https://sqs.eu-central-1.amazonaws.com/000000000000/dlq' },
        liveClients: { dynamoDb: countingClient(counter), secretsManager: countingClient(counter), sqs: countingClient(counter) },
        dryRunSink: () => {},
      });
    const buildForget = (): ReturnType<typeof buildForgetRoot> => buildForgetRoot({ runtimeContext: 'test', switchValue: undefined });

    let ingest: ReturnType<typeof buildIngestRoot>;
    let forget: ReturnType<typeof buildForgetRoot>;
    if (order === 'ingest-first') {
      ingest = buildIngest();
      forget = buildForget();
    } else {
      forget = buildForget();
      ingest = buildIngest();
    }

    expect(ingest.kinds).toEqual(kindsInColumn(1));
    expect(forget.kinds).toEqual(kindsInColumn(0));
    expect(ingest.ports).not.toBe(forget.ports);
    expect(ingest.ports.eventStore).not.toBe(forget.ports.eventStore);
    expect(ingest.ports.addressKey).not.toBe(forget.ports.addressKey);

    // The forget root's fixture store answers without touching the ingest root's live clients.
    await expect(forget.ports.eventStore.queryByRecipient('a-recipient-hash')).resolves.toEqual([]);
    expect(counter).toEqual({ constructions: 0, sent: 0 });
  });
});
