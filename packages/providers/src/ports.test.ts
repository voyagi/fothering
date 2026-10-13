import { describe, expect, it, vi } from 'vitest';
import { Message, ModelThrottledError, TextBlock, type ContentBlock, type ModelStreamEvent } from '@strands-agents/sdk';
import { pseudonymizeRecipient } from '@fothering/core/address';
import { RECORD_BYTE_CEILING } from '@fothering/core/evidence-record';
import { MODEL_VALUES, PINNED_MODEL_VALUES, TOKEN_RESERVATION_PER_INVOCATION } from '@fothering/core/model-values';
import type { EventRecord, RecordKey } from '@fothering/core/records';
import { PORT_TABLE, resolvePortTable, type PortName, type PortRow, type ResolvedPorts } from './ports.js';
import { NotBuiltError, brandPort, kindOf, type ResolvedKind, type SendEmailRequest } from './port-types.js';
import { createBedrockModelDryRun, createDryRunLog, type DryRunLog } from './dry-run.js';
import {
  TEST_ADDRESS_KEY_SET,
  createFixtureAddressKey,
  createFixtureDeadLetter,
  createFixtureEventStore,
} from './fixtures/ingest-ports.js';
import { createFixtureAgentCore, createFixtureBedrockModel, createFixtureReplyBucket, createFixtureSes } from './fixtures/later-ports.js';
import {
  STRUCTURED_OUTPUT_TOOL_NAME,
  createFixtureModel,
  plainTextTurn,
  structuredAnswerTurn,
  throttledTurn,
} from './fixtures/fixture-model.js';
import { FixtureMissError, canonicalJson, recordedPort } from './fixtures/recorded.js';
import { assertRootMatrix, type RootMatrixOptions } from './test/root-matrix.js';

const SWITCH_VALUES = [undefined, '', '   ', 'true', 'LIVE', ' live', 'live'];
const RECORD_KEY = { pk: 'LANE#fothering-bulk', sk: 'B#0000000000000#Send#m1' };
const NO_LINES = (): void => {};
const RUNTIME_ARN = 'arn:aws:bedrock-agentcore:eu-central-1:000000000000:runtime/x';
const USAGE = { inputTokens: 10, outputTokens: 2, totalTokens: 12 };
const PLANTED_SENTENCE = 'Jane said the mailbox at her house is full';

function userMessage(text: string): Message {
  return new Message({ role: 'user', content: [new TextBlock(text)] });
}

async function drain<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of iterable) items.push(item);
  return items;
}

// Classes on purpose: a class keeps its methods on the prototype, which is the shape a
// copied-object port table loses.
class PlantedEventStore {
  readonly calls: string[] = [];
  async putIfAbsent(): Promise<'written'> {
    this.calls.push('putIfAbsent');
    return 'written';
  }
  async queryLane(): Promise<EventRecord[]> {
    this.calls.push('queryLane');
    return [];
  }
  async queryByRecipient(): Promise<[]> {
    this.calls.push('queryByRecipient');
    return [];
  }
  async deleteRecord(): Promise<void> {
    this.calls.push('deleteRecord');
  }
  async getRecord(): Promise<undefined> {
    this.calls.push('getRecord');
    return undefined;
  }
}

class PlantedAddressKey {
  async getKeySet() {
    return { versions: [] };
  }
}

class PlantedDeadLetter {
  readonly calls: string[] = [];
  async send(): Promise<void> {
    this.calls.push('send');
  }
}

interface PlantedAdapters {
  eventStore: PlantedEventStore;
  addressKey: object;
  deadLetter: PlantedDeadLetter;
}

function freshAdapters(): PlantedAdapters {
  return {
    eventStore: brandPort(new PlantedEventStore(), 'live'),
    addressKey: brandPort(new PlantedAddressKey(), 'live'),
    deadLetter: brandPort(new PlantedDeadLetter(), 'live'),
  };
}

// The real table gates none of the product's own three rows (its table, key and queue stay live
// without the switch), so this planted table gates them itself: it is the only way to reach the
// dry-run branch for a row whose live side is a real adapter written as a class.
function plantedLiveTable(adapters: PlantedAdapters): Record<PortName, PortRow> {
  return {
    ...PORT_TABLE,
    eventStore: {
      operations: ['putIfAbsent', 'queryLane', 'queryByRecipient', 'deleteRecord', 'getRecord'],
      mutatingOperations: ['putIfAbsent', 'deleteRecord'],
      gatedOperations: ['putIfAbsent', 'deleteRecord'],
      fixture: () => createFixtureEventStore(),
      live: () => adapters.eventStore,
      dryRun: (log: DryRunLog) => ({
        putIfAbsent: (record: EventRecord) => log.would('eventStore.putIfAbsent', record.pk, record),
        deleteRecord: (key: RecordKey) => log.would('eventStore.deleteRecord', key.pk, key),
      }),
    },
    addressKey: {
      operations: ['getKeySet'],
      mutatingOperations: [],
      gatedOperations: [],
      fixture: () => createFixtureAddressKey(),
      live: () => adapters.addressKey,
    },
    deadLetter: {
      operations: ['send'],
      mutatingOperations: ['send'],
      gatedOperations: ['send'],
      fixture: () => createFixtureDeadLetter(),
      live: () => adapters.deadLetter,
      dryRun: (log: DryRunLog) => ({
        send: (records: EventRecord[]) => log.would('deadLetter.send', 'dead-letter-queue', records),
      }),
    },
  };
}

// The real PORT_TABLE's declarations with only the live side swapped for a planted adapter, so what
// is under test is the table's own operation, mutating and gated lists, not a copy of them.
function realTableWithPlantedLive(adapters: PlantedAdapters): Record<PortName, PortRow> {
  return {
    ...PORT_TABLE,
    eventStore: { ...PORT_TABLE.eventStore, live: () => adapters.eventStore },
    addressKey: { ...PORT_TABLE.addressKey, live: () => adapters.addressKey },
    deadLetter: { ...PORT_TABLE.deadLetter, live: () => adapters.deadLetter },
  };
}

describe('resolvePortTable with live adapters written as classes', () => {
  it('serves a read through the adapter itself, with its own this, when the switch is unset', async () => {
    const adapters = freshAdapters();
    const { ports, kinds } = resolvePortTable({
      runtimeContext: 'deployed',
      switchValue: undefined,
      table: plantedLiveTable(adapters),
      dryRunSink: NO_LINES,
    });

    expect(kinds.eventStore?.queryLane).toBe('live');
    await expect(ports.eventStore.queryLane('lane', 0, 0, 0)).resolves.toEqual([]);
    await expect(ports.addressKey.getKeySet()).resolves.toEqual({ versions: [] });
    expect(adapters.eventStore.calls).toEqual(['queryLane']);
  });

  it('records a gated operation as one dry-run line and never calls the adapter when the switch is not live', async () => {
    const adapters = freshAdapters();
    const lines: string[] = [];
    const { ports, kinds } = resolvePortTable({
      runtimeContext: 'deployed',
      switchValue: 'LIVE',
      table: plantedLiveTable(adapters),
      dryRunSink: (line) => lines.push(line),
    });

    expect(kinds.eventStore?.putIfAbsent).toBe('dry-run');
    await ports.eventStore.putIfAbsent(RECORD_KEY as EventRecord);
    expect(lines).toEqual([`(dry-run) WOULD eventStore.putIfAbsent LANE#fothering-bulk ${canonicalJson(RECORD_KEY)}`]);
    expect(adapters.eventStore.calls).toEqual([]);
  });

  it('calls the adapter for a gated operation when the switch is exactly live', async () => {
    const adapters = freshAdapters();
    const lines: string[] = [];
    const { ports, kinds } = resolvePortTable({
      runtimeContext: 'deployed',
      switchValue: 'live',
      table: plantedLiveTable(adapters),
      dryRunSink: (line) => lines.push(line),
    });

    expect(kinds.eventStore?.putIfAbsent).toBe('live');
    await expect(ports.eventStore.putIfAbsent({} as EventRecord)).resolves.toBe('written');
    await ports.deadLetter.send([]);
    expect(adapters.eventStore.calls).toEqual(['putIfAbsent']);
    expect(adapters.deadLetter.calls).toEqual(['send']);
    expect(lines).toEqual([]);
  });

  it('refuses to build when a live adapter lacks an operation the table names', () => {
    const adapters = { ...freshAdapters(), addressKey: brandPort({}, 'live') };
    expect(() =>
      resolvePortTable({ runtimeContext: 'deployed', switchValue: undefined, table: plantedLiveTable(adapters), dryRunSink: NO_LINES }),
    ).toThrow('the live addressKey adapter has no getKeySet operation');
  });

  it('refuses an implementation that carries no kind brand, so the kind is never guessed from the slot', () => {
    const unbranded = { ...freshAdapters(), addressKey: { getKeySet: async () => ({ versions: [] }) } };
    expect(() =>
      resolvePortTable({ runtimeContext: 'deployed', switchValue: undefined, table: plantedLiveTable(unbranded), dryRunSink: NO_LINES }),
    ).toThrow('the live addressKey adapter carries no kind brand');

    const table = plantedLiveTable(freshAdapters());
    const unbrandedFixture = { ...table, addressKey: { ...table.addressKey, fixture: () => ({ getKeySet: async () => ({ versions: [] }) }) } };
    expect(() => resolvePortTable({ runtimeContext: 'test', switchValue: undefined, table: unbrandedFixture, dryRunSink: NO_LINES })).toThrow(
      'the addressKey fixture carries no kind brand',
    );
  });

  // A misspelled gated name would leave the real operation ungated, live with no switch at all,
  // which is the one failure the switch exists to prevent; so is a misspelled mutating name.
  it.each([
    ['gatedOperations', { gatedOperations: ['sned'] }],
    ['mutatingOperations', { mutatingOperations: ['sned'] }],
    ['notBuiltOperations', { notBuiltOperations: { sned: 3 } }],
  ])('refuses a %s entry that is not one of the row operations, in every runtime context', (_label, override) => {
    for (const runtimeContext of ['test', 'deployed'] as const) {
      const table = plantedLiveTable(freshAdapters());
      const misspelled = { ...table, deadLetter: { ...table.deadLetter, ...override } };
      expect(() => resolvePortTable({ runtimeContext, switchValue: undefined, table: misspelled, dryRunSink: NO_LINES })).toThrow(
        'the deadLetter row lists sned, which is not one of its operations',
      );
    }
  });

  it('refuses a gated operation the row has no dry-run recorder for, in every runtime context', () => {
    for (const runtimeContext of ['test', 'deployed'] as const) {
      const table = plantedLiveTable(freshAdapters());
      const { dryRun: _dropped, ...withoutRecorder } = table.deadLetter;
      expect(() =>
        resolvePortTable({ runtimeContext, switchValue: undefined, table: { ...table, deadLetter: withoutRecorder }, dryRunSink: NO_LINES }),
      ).toThrow('the deadLetter row gates send but its dry-run recorder has no send operation');
    }
  });
});

describe('the real port table', () => {
  it('names the seven rows', () => {
    expect(Object.keys(PORT_TABLE).sort()).toEqual([
      'addressKey',
      'agentCore',
      'bedrockModel',
      'deadLetter',
      'eventStore',
      'replyBucket',
      'ses',
    ]);
  });

  // The type contract (D-05): a table missing a row is an error at gate:types, not a runtime surprise.
  it('is exactly Record<PortName, PortRow>, so a table missing the replyBucket row is a type error', () => {
    // @ts-expect-error a table missing the replyBucket row must fail gate:types
    const missingRow: Record<PortName, PortRow> = {
      eventStore: PORT_TABLE.eventStore,
      addressKey: PORT_TABLE.addressKey,
      deadLetter: PORT_TABLE.deadLetter,
      ses: PORT_TABLE.ses,
      bedrockModel: PORT_TABLE.bedrockModel,
      agentCore: PORT_TABLE.agentCore,
    };
    expect(Object.keys(missingRow)).toHaveLength(6);
  });

  it('lists every mutating operation of a gated row as gated too, so the switch owns what changes SES or spends', () => {
    for (const portName of ['ses', 'bedrockModel', 'agentCore'] as const) {
      const row = PORT_TABLE[portName];
      expect([...row.gatedOperations].sort()).toEqual([...row.mutatingOperations].sort());
    }
  });

  // In 'deployed' the event store, the address key and the dead-letter queue resolve live for EVERY
  // switch value: Fothering's own table, key and queue never wait for the switch.
  it.each(SWITCH_VALUES)('resolves every event store, address key and dead-letter operation live in deployed for switch %j', (switchValue) => {
    const { kinds } = resolvePortTable({
      runtimeContext: 'deployed',
      switchValue,
      table: realTableWithPlantedLive(freshAdapters()),
      dryRunSink: NO_LINES,
    });
    for (const portName of ['eventStore', 'addressKey', 'deadLetter'] as const) {
      for (const [operation, kind] of Object.entries(kinds[portName] ?? {})) {
        expect(`${portName}.${operation} ${kind}`).toBe(`${portName}.${operation} live`);
      }
    }
  });

  it('writes a record through the live adapter, never a dry-run line, when the switch is unset', async () => {
    const adapters = freshAdapters();
    const lines: string[] = [];
    const { ports } = resolvePortTable({
      runtimeContext: 'deployed',
      switchValue: undefined,
      table: realTableWithPlantedLive(adapters),
      dryRunSink: (line) => lines.push(line),
    });

    await expect(ports.eventStore.putIfAbsent({} as EventRecord)).resolves.toBe('written');
    await ports.deadLetter.send([]);
    expect(adapters.eventStore.calls).toEqual(['putIfAbsent']);
    expect(adapters.deadLetter.calls).toEqual(['send']);
    expect(lines).toEqual([]);
  });

  it.each(SWITCH_VALUES)('resolves all seven rows to fixture in test for switch %j', (switchValue) => {
    const { kinds } = resolvePortTable({ runtimeContext: 'test', switchValue });
    expect(Object.keys(kinds)).toHaveLength(7);
    for (const row of Object.values(kinds)) {
      for (const kind of Object.values(row)) expect(kind).toBe('fixture');
    }
  });

  // The rows whose live side is missing or partial: a gated operation is dry-run until the switch
  // is exactly live, and only then is it the not-built phase; an ungated one is live or not built.
  it.each<[string, string, ResolvedKind, ResolvedKind]>([
    ['ses', 'getEmailIdentity', 'live', 'live'],
    ['ses', 'pauseConfigurationSet', 'dry-run', 'not-built-until-phase-3'],
    ['ses', 'reopenConfigurationSet', 'dry-run', 'not-built-until-phase-3'],
    ['ses', 'sendEmail', 'dry-run', 'not-built-until-phase-4'],
    ['bedrockModel', 'stream', 'dry-run', 'live'],
    ['agentCore', 'invokeAgentRuntime', 'dry-run', 'live'],
    ['replyBucket', 'getReplyObject', 'not-built-until-phase-4', 'not-built-until-phase-4'],
  ])('resolves %s.%s to %s without the switch and %s with it', (portName, operation, withoutSwitch, withSwitch) => {
    const unset = resolvePortTable({ runtimeContext: 'deployed', switchValue: undefined, dryRunSink: NO_LINES });
    const live = resolvePortTable({ runtimeContext: 'deployed', switchValue: 'live', dryRunSink: NO_LINES });
    expect(unset.kinds[portName]?.[operation]).toBe(withoutSwitch);
    expect(live.kinds[portName]?.[operation]).toBe(withSwitch);
  });

  it.each(['not-built-until-phase-1', 'not-built-until-phase-2'])('never reports %s for any operation, in either context, for any switch value', (phase) => {
    for (const runtimeContext of ['test', 'deployed'] as const) {
      for (const switchValue of SWITCH_VALUES) {
        const { kinds } = resolvePortTable({ runtimeContext, switchValue, dryRunSink: NO_LINES });
        for (const [portName, row] of Object.entries(kinds)) {
          for (const [operation, kind] of Object.entries(row)) expect(`${portName}.${operation} ${kind}`).not.toBe(`${portName}.${operation} ${phase}`);
        }
      }
    }
  });

  it.each<[keyof ResolvedPorts, string, string, unknown[]]>([
    ['ses', 'pauseConfigurationSet', 'phase 3', ['fothering-bulk']],
    ['ses', 'reopenConfigurationSet', 'phase 3', ['fothering-bulk']],
    ['ses', 'sendEmail', 'phase 4', [{ from: 'ops@example.org', to: [], subject: 's', text: 't' }]],
    ['replyBucket', 'getReplyObject', 'phase 4', ['key']],
  ])('rejects %s.%s with a NotBuiltError naming %s once the switch is live', async (portName, operation, phase, args) => {
    const { ports } = resolvePortTable({ runtimeContext: 'deployed', switchValue: 'live', dryRunSink: NO_LINES });
    const call = (ports[portName] as unknown as Record<string, (...callArgs: unknown[]) => Promise<unknown>>)[operation];
    await expect(call?.(...args)).rejects.toThrow(NotBuiltError);
    await expect(call?.(...args)).rejects.toThrow(phase);
  });

  it('writes nothing by default in test and one stdout line per gated call in deployed', async () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      const inTest = resolvePortTable({ runtimeContext: 'test', switchValue: undefined });
      await inTest.ports.ses.pauseConfigurationSet('fothering-bulk');
      expect(write).not.toHaveBeenCalled();

      const deployed = resolvePortTable({ runtimeContext: 'deployed', switchValue: undefined });
      await deployed.ports.ses.pauseConfigurationSet('fothering-bulk');
      expect(write).toHaveBeenCalledTimes(1);
      expect(String(write.mock.calls[0]?.[0])).toBe('(dry-run) WOULD ses.pauseConfigurationSet fothering-bulk {"configurationSet":"fothering-bulk"}\n');
    } finally {
      write.mockRestore();
    }
  });
});

// Each resolved kind is read from the implementation's own brand, so a live adapter wired in as a
// row's test default reports live and the expected-kind comparison turns red (AC-2, T-01-10).
describe('the expected-kind comparison against resolvePortTable directly', () => {
  const compare = (table: Record<PortName, PortRow>) => (): void =>
    assertRootMatrix(({ runtimeContext, switchValue }: RootMatrixOptions) =>
      resolvePortTable({ runtimeContext, switchValue, table, dryRunSink: NO_LINES }),
    );

  it('passes for the real table, which is the positive control for the planted case below', () => {
    expect(compare(PORT_TABLE)).not.toThrow();
  });

  it('turns red when a row puts its live factory in the fixture slot, and reports live for that row in test', () => {
    const planted: Record<PortName, PortRow> = {
      ...PORT_TABLE,
      eventStore: {
        ...PORT_TABLE.eventStore,
        fixture: () => PORT_TABLE.eventStore.live({ liveConfig: {}, liveClients: {}, now: Date.now }),
      },
    };

    expect(resolvePortTable({ runtimeContext: 'test', switchValue: undefined, table: planted }).kinds.eventStore?.queryLane).toBe('live');
    expect(compare(planted)).toThrow();
  });
});

describe('kind brands', () => {
  it('stamps a kind outside enumeration, so a spread copy never carries a stale stamp', () => {
    const port = brandPort({ read: async () => 1 }, 'live');
    expect(kindOf(port)).toBe('live');
    expect(Object.keys(port)).toEqual(['read']);
    expect(kindOf({ ...port })).toBeUndefined();
    expect(kindOf('live')).toBeUndefined();
    expect(kindOf(null)).toBeUndefined();
  });
});

describe('createDryRunLog targets (AC-P9)', () => {
  function logWithLines(): { log: DryRunLog; lines: string[] } {
    const lines: string[] = [];
    const log = createDryRunLog({ sink: (line) => lines.push(line), addressKey: createFixtureAddressKey(), now: () => 1_000 });
    return { log, lines };
  }

  it('prints a configuration set, a record partition key and the queue name as given', async () => {
    const { log, lines } = logWithLines();
    await log.would('ses.pauseConfigurationSet', 'fothering-bulk', 'fothering-bulk');
    await log.would('eventStore.putIfAbsent', 'LANE#fothering-bulk', RECORD_KEY);
    await log.would('deadLetter.send', 'dead-letter-queue', [RECORD_KEY, { ...RECORD_KEY, sk: 'B#0000000000000#Send#m2' }]);
    expect(lines).toEqual([
      '(dry-run) WOULD ses.pauseConfigurationSet fothering-bulk {"configurationSet":"fothering-bulk"}',
      `(dry-run) WOULD eventStore.putIfAbsent LANE#fothering-bulk ${canonicalJson(RECORD_KEY)}`,
      '(dry-run) WOULD deadLetter.send dead-letter-queue {"partitionKeys":["LANE#fothering-bulk"],"recordCount":2}',
    ]);
  });

  it.each([
    ['an address', 'jane@example.com'],
    ['an empty string', ''],
    ['a sentence', 'the mailbox is full'],
    ['a domain, which is no configuration set', 'example.org'],
  ])('refuses %s as a target, writes no line and never echoes it', async (_label, target) => {
    const { log, lines } = logWithLines();
    const refusal = await log.would('ses.pauseConfigurationSet', target, 'fothering-bulk').catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(Error);
    expect((refusal as Error).message).toContain('refusing to record ses.pauseConfigurationSet');
    expect((refusal as Error).message).not.toContain('mailbox');
    expect((refusal as Error).message).not.toContain('jane');
    expect(lines).toEqual([]);
  });

  it('refuses a request object as a target, and a target that belongs to another operation', async () => {
    const { log, lines } = logWithLines();
    await expect(log.would('deadLetter.send', { recipient: 'jane@example.com' } as unknown as string, [])).rejects.toThrow(
      'refusing to record deadLetter.send',
    );
    await expect(log.would('deadLetter.send', 'fothering-bulk', [])).rejects.toThrow('refusing to record deadLetter.send');
    expect(lines).toEqual([]);
  });

  // A record key reaches the line as it stands, so its shape is all that keeps a key built by hand
  // from printing an address: both halves must look like the keys recordKey builds.
  it.each([
    ['an address in the sort key', { pk: 'LANE#fothering-bulk', sk: 'B#0000000000000#Send#jane@example.com' }],
    ['a sentence as the sort key', { pk: 'LANE#fothering-bulk', sk: 'the mailbox is full' }],
    ['an address as the partition key', { pk: 'jane@example.com', sk: 'B#0000000000000#Send#m1' }],
  ])('refuses a record key with %s in a store line and a dead-letter line, and never echoes it', async (_label, key) => {
    const { log, lines } = logWithLines();
    const refusals = [
      await log.would('eventStore.deleteRecord', 'LANE#fothering-bulk', key).catch((error: unknown) => error),
      await log.would('deadLetter.send', 'dead-letter-queue', [key]).catch((error: unknown) => error),
    ];
    for (const refusal of refusals) {
      expect(refusal).toBeInstanceOf(TypeError);
      expect((refusal as Error).message).not.toContain('jane');
      expect((refusal as Error).message).not.toContain('mailbox');
    }
    expect(lines).toEqual([]);
  });

  it('refuses an operation it has no line shape for, and a request that lacks the shape its line records', async () => {
    const { log, lines } = logWithLines();
    await expect(log.would('ses.deleteIdentity', 'fothering-bulk', 'fothering-bulk')).rejects.toThrow('no dry-run line is defined for ses.deleteIdentity');
    await expect(log.would('ses.pauseConfigurationSet', 'fothering-bulk', { jane: 'jane@example.com' })).rejects.toThrow(
      'refusing to record ses.pauseConfigurationSet',
    );
    expect(lines).toEqual([]);
  });
});

describe('a sendEmail dry-run line (AC-P9)', () => {
  const REQUEST: SendEmailRequest = {
    from: 'ops@example.org',
    to: ['Jane.Doe+x@Example.COM', 'bob@localhost', 'no-at-sign'],
    subject: 'Your invoice is ready, Jane',
    text: 'Dear Jane, the mailbox is full and here is your invoice.',
    configurationSetName: 'fothering-transactional',
  };

  async function sendLine(request: SendEmailRequest): Promise<string> {
    const lines: string[] = [];
    const log = createDryRunLog({ sink: (line) => lines.push(line), addressKey: createFixtureAddressKey(), now: () => 5_000 });
    await log.would('ses.sendEmail', request.configurationSetName ?? 'example.org', request);
    expect(lines).toHaveLength(1);
    return lines[0] ?? '';
  }

  it('holds no @ character, the receiving domains and one 64-character HMAC per address', async () => {
    const line = await sendLine(REQUEST);
    expect(line).not.toContain('@');
    expect(line.startsWith('(dry-run) WOULD ses.sendEmail fothering-transactional ')).toBe(true);
    for (const domain of ['example.org', 'example.com', 'localhost', 'unparseable']) expect(line).toContain(`"receivingDomain":"${domain}"`);
    expect(line.match(/[0-9a-f]{64}/g)).toHaveLength(4);
    for (const address of ['Jane.Doe+x@Example.COM', 'bob@localhost', 'no-at-sign', 'ops@example.org']) {
      expect(line).toContain(pseudonymizeRecipient(address, TEST_ADDRESS_KEY_SET, 5_000).recipientHmac);
    }
  });

  it('holds the subject and body only as lengths, and no sentence at all', async () => {
    const line = await sendLine(REQUEST);
    expect(line).toContain(`"subjectLength":${REQUEST.subject.length}`);
    expect(line).toContain(`"textLength":${REQUEST.text.length}`);
    for (const sentence of ['invoice', 'mailbox is full', 'Dear Jane']) expect(line).not.toContain(sentence);
  });

  it('refuses a configuration set name that is not one, rather than copying it', async () => {
    const log = createDryRunLog({ sink: NO_LINES, addressKey: createFixtureAddressKey(), now: () => 5_000 });
    await expect(log.would('ses.sendEmail', 'example.org', { ...REQUEST, configurationSetName: 'jane@example.com' })).rejects.toThrow(
      'refusing to record ses.sendEmail',
    );
  });

  it('records model and runtime calls as the model id with two counts, and the runtime ARN with a payload length', async () => {
    const lines: string[] = [];
    const log = createDryRunLog({ sink: (line) => lines.push(line), addressKey: createFixtureAddressKey(), now: () => 1 });
    await log.would('bedrockModel.stream', 'eu.anthropic.claude-sonnet-5', {
      modelId: 'eu.anthropic.claude-sonnet-5',
      messageCount: 1,
      promptBytes: 42,
      prompt: 'Jane said hello',
    });
    await log.would('agentCore.invokeAgentRuntime', 'arn:aws:bedrock-agentcore:eu-central-1:000000000000:runtime/fothering', {
      runtimeArn: 'arn:aws:bedrock-agentcore:eu-central-1:000000000000:runtime/fothering',
      sessionId: 'session-1',
      payload: { note: 'Jane said hello' },
    });
    expect(lines).toEqual([
      '(dry-run) WOULD bedrockModel.stream eu.anthropic.claude-sonnet-5 {"messageCount":1,"modelId":"eu.anthropic.claude-sonnet-5","promptBytes":42}',
      '(dry-run) WOULD agentCore.invokeAgentRuntime arn:aws:bedrock-agentcore:eu-central-1:000000000000:runtime/fothering {"payloadLength":26,"runtimeArn":"arn:aws:bedrock-agentcore:eu-central-1:000000000000:runtime/fothering"}',
    ]);
  });

  it('refuses a model line whose counts are not integers, and names no request text', async () => {
    const lines: string[] = [];
    const log = createDryRunLog({ sink: (line) => lines.push(line), addressKey: createFixtureAddressKey(), now: () => 1 });
    for (const request of [
      { modelId: 'eu.anthropic.claude-sonnet-5', messageCount: 1.5, promptBytes: 42 },
      { modelId: 'eu.anthropic.claude-sonnet-5', messageCount: 1, promptBytes: PLANTED_SENTENCE },
    ]) {
      const refusal = await log.would('bedrockModel.stream', 'eu.anthropic.claude-sonnet-5', request).catch((error: unknown) => error);
      expect((refusal as Error).message).toBe('refusing to record bedrockModel.stream: the request does not have the shape its line records');
    }
    expect(lines).toEqual([]);
  });
});

describe('the fixtures leave one dry-run line per mutating call (AC-4 dry-run half)', () => {
  function sesWithLines(): { ses: ReturnType<typeof createFixtureSes>; lines: string[] } {
    const lines: string[] = [];
    const dryRun = createDryRunLog({ sink: (line) => lines.push(line), addressKey: createFixtureAddressKey(), now: () => 1_000 });
    return { ses: createFixtureSes({ recordings: [], dryRun }), lines };
  }

  it('turns one pauseConfigurationSet call into exactly one line naming fothering-bulk', async () => {
    const { ses, lines } = sesWithLines();
    await expect(ses.pauseConfigurationSet('fothering-bulk')).resolves.toBeUndefined();
    expect(lines).toEqual(['(dry-run) WOULD ses.pauseConfigurationSet fothering-bulk {"configurationSet":"fothering-bulk"}']);
  });

  it('turns reopen and send into one line each, with a fixed result for send', async () => {
    const { ses, lines } = sesWithLines();
    await ses.reopenConfigurationSet('fothering-bulk');
    const sent = await ses.sendEmail({ from: 'ops@example.org', to: ['jane@example.com'], subject: 's', text: 't' });
    expect(sent).toEqual({ messageId: 'dry-run-not-sent' });
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe('(dry-run) WOULD ses.reopenConfigurationSet fothering-bulk {"configurationSet":"fothering-bulk"}');
    expect(lines[1]?.startsWith('(dry-run) WOULD ses.sendEmail example.org ')).toBe(true);
  });

  // With no configuration set the line names the From domain, read the way every address is read,
  // so a From carrying a comment names its domain rather than "unparseable".
  it.each(['ops@example.org (alerts)', 'Ops (alerts) <ops(x)@example.org>'])('names the From domain of %s', async (from) => {
    const { ses, lines } = sesWithLines();
    await ses.sendEmail({ from, to: ['jane@example.com'], subject: 's', text: 't' });
    expect(lines[0]?.startsWith('(dry-run) WOULD ses.sendEmail example.org ')).toBe(true);
  });

  it('writes a line for an event store write and a dead-letter send, with a record partition key target', async () => {
    const lines: string[] = [];
    const dryRun = createDryRunLog({ sink: (line) => lines.push(line), addressKey: createFixtureAddressKey(), now: () => 1_000 });
    const store = createFixtureEventStore({}, dryRun);
    const deadLetter = createFixtureDeadLetter({}, dryRun);
    const record = { ...RECORD_KEY, fields: {} } as unknown as EventRecord;
    await store.putIfAbsent(record);
    await store.deleteRecord(RECORD_KEY);
    await deadLetter.send([record]);
    expect(lines).toEqual([
      `(dry-run) WOULD eventStore.putIfAbsent LANE#fothering-bulk ${canonicalJson(RECORD_KEY)}`,
      `(dry-run) WOULD eventStore.deleteRecord LANE#fothering-bulk ${canonicalJson(RECORD_KEY)}`,
      '(dry-run) WOULD deadLetter.send dead-letter-queue {"partitionKeys":["LANE#fothering-bulk"],"recordCount":1}',
    ]);
  });

  it('writes no line when the fixture is built without a log, as before', async () => {
    const store = createFixtureEventStore();
    await expect(store.putIfAbsent({ ...RECORD_KEY, fields: {} } as unknown as EventRecord)).resolves.toBe('written');
  });
});

// Every operation PORT_TABLE declares mutating, called once with a valid request. Kept beside the
// table's own lists: the first case fails if a mutating operation is added without a sample call.
const MUTATION_CALLS: Record<string, (ports: ResolvedPorts) => Promise<unknown>> = {
  'eventStore.putIfAbsent': (ports) => ports.eventStore.putIfAbsent({ ...RECORD_KEY, fields: {} } as unknown as EventRecord),
  'eventStore.deleteRecord': (ports) => ports.eventStore.deleteRecord(RECORD_KEY),
  'deadLetter.send': (ports) => ports.deadLetter.send([]),
  'ses.pauseConfigurationSet': (ports) => ports.ses.pauseConfigurationSet('fothering-bulk'),
  'ses.reopenConfigurationSet': (ports) => ports.ses.reopenConfigurationSet('fothering-bulk'),
  'ses.sendEmail': (ports) => ports.ses.sendEmail({ from: 'ops@example.org', to: ['jane@example.com'], subject: 's', text: 't' }),
  // Iterated to the end: a stream that is only created, never iterated, runs none of its body (Pitfall 10).
  'bedrockModel.stream': (ports) => drain(ports.bedrockModel.stream([userMessage('p')], { systemPrompt: 's' })),
  'agentCore.invokeAgentRuntime': (ports) => ports.agentCore.invokeAgentRuntime({ runtimeArn: RUNTIME_ARN, sessionId: 's', payload: {} }),
};

const MUTATION_RECORDINGS = {
  agentCore: [
    {
      operation: 'agentCore.invokeAgentRuntime',
      request: { runtimeArn: RUNTIME_ARN, sessionId: 's', payload: {} },
      response: { ok: true },
    },
  ],
};

function declaredMutations(table: Record<PortName, PortRow>): string[] {
  return Object.entries(table).flatMap(([portName, row]) => row.mutatingOperations.map((operation) => `${portName}.${operation}`));
}

async function assertOneLinePerMutation(table: Record<PortName, PortRow>): Promise<void> {
  for (const key of declaredMutations(table)) {
    const lines: string[] = [];
    const { ports } = resolvePortTable({
      runtimeContext: 'test',
      switchValue: undefined,
      table,
      fixtures: { recordings: MUTATION_RECORDINGS, model: createFixtureModel([plainTextTurn('ok', USAGE)]) },
      dryRunSink: (line) => lines.push(line),
    });
    await MUTATION_CALLS[key]?.(ports);
    expect(lines, `${key} must leave exactly one line`).toHaveLength(1);
    const [, operation, target] = /^\(dry-run\) WOULD (\S+) (\S+) /.exec(lines[0] ?? '') ?? [];
    expect(operation).toBe(key);
    expect(target?.length ?? 0).toBeGreaterThan(0);
  }
}

describe('every operation the table declares mutating writes exactly one line per call', () => {
  it('has a sample call for every declared mutating operation and no other', () => {
    expect(Object.keys(MUTATION_CALLS).sort()).toEqual(declaredMutations(PORT_TABLE).sort());
  });

  it('holds for the real table in test', async () => {
    await expect(assertOneLinePerMutation(PORT_TABLE)).resolves.toBeUndefined();
  });

  it.each([
    ['writes zero lines', 0],
    ['writes two lines', 2],
  ])('is caught when a planted recorder %s', async (_label, count) => {
    const planted: Record<PortName, PortRow> = {
      ...PORT_TABLE,
      ses: {
        ...PORT_TABLE.ses,
        fixture: (fixtures, dryRun) => {
          const real = createFixtureSes({ recordings: fixtures.recordings?.ses ?? [], dryRun });
          return brandPort(
            {
              ...real,
              async pauseConfigurationSet(configurationSet: string) {
                for (let written = 0; written < count; written += 1) await dryRun.would('ses.pauseConfigurationSet', configurationSet, configurationSet);
              },
            },
            'fixture',
          );
        },
      },
    };
    await expect(assertOneLinePerMutation(planted)).rejects.toThrow('ses.pauseConfigurationSet must leave exactly one line');
  });
});

describe('recorded fixtures (AC-E5)', () => {
  it('throws FixtureMissError naming the operation, and only the operation, on the first call with no recordings', async () => {
    const dryRun = createDryRunLog({ sink: NO_LINES, addressKey: createFixtureAddressKey(), now: () => 1 });
    const ses = createFixtureSes({ recordings: [], dryRun });
    const refusal = await ses.getEmailIdentity('jane@example.com').catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(FixtureMissError);
    expect((refusal as FixtureMissError).message).toContain('ses.getEmailIdentity');
    expect((refusal as FixtureMissError).message).not.toContain('jane');
    await expect(ses.listEmailIdentities()).rejects.toThrow(FixtureMissError);
    await expect(ses.listConfigurationSets()).rejects.toThrow('ses.listConfigurationSets');
    await expect(ses.getConfigurationSetEventDestinations('fothering-bulk')).rejects.toThrow('ses.getConfigurationSetEventDestinations');
    await expect(createFixtureReplyBucket({ recordings: [] }).getReplyObject('key')).rejects.toThrow('replyBucket.getReplyObject');
  });

  it('answers a recorded request with its recorded response, matched on the operation and the canonical request', async () => {
    const dryRun = createDryRunLog({ sink: NO_LINES, addressKey: createFixtureAddressKey(), now: () => 1 });
    const ses = createFixtureSes({
      recordings: [
        { operation: 'ses.getEmailIdentity', request: 'example.org', response: 'fothering-default' },
        { operation: 'ses.getEmailIdentity', request: 'example.net', response: undefined },
      ],
      dryRun,
    });
    await expect(ses.getEmailIdentity('example.org')).resolves.toBe('fothering-default');
    await expect(ses.getEmailIdentity('example.net')).resolves.toBeUndefined();
    await expect(ses.getEmailIdentity('example.com')).rejects.toThrow(FixtureMissError);
  });

  it('matches a request whatever order its properties were written in, and hands out copies', () => {
    const port = recordedPort([{ operation: 'op', request: { b: 1, a: { d: 2, c: 3 } }, response: { items: [1] } }]);
    const first = port.respond<{ items: number[] }>('op', { a: { c: 3, d: 2 }, b: 1 });
    first.items.push(2);
    expect(port.respond('op', { a: { c: 3, d: 2 }, b: 1 })).toEqual({ items: [1] });
  });

  it('refuses two recordings for the same request', () => {
    const recording = { operation: 'op', request: { a: 1 }, response: 1 };
    expect(() => recordedPort([recording, { ...recording, response: 2 }])).toThrow('two recordings answer the same op request');
  });

  it('records the model call and the runtime call before answering, and misses with no fixture model or recording', async () => {
    const lines: string[] = [];
    const dryRun = createDryRunLog({ sink: (line) => lines.push(line), addressKey: createFixtureAddressKey(), now: () => 1 });
    const model = createFixtureBedrockModel({ model: undefined, dryRun });
    const runtime = createFixtureAgentCore({ recordings: [], agentRuntime: undefined, dryRun });
    await expect(drain(model.stream([userMessage('p')]))).rejects.toThrow('bedrockModel.stream');
    await expect(runtime.invokeAgentRuntime({ runtimeArn: RUNTIME_ARN, sessionId: 's', payload: 1 })).rejects.toThrow('agentCore.invokeAgentRuntime');
    expect(lines).toHaveLength(2);
  });

  it('canonicalJson sorts keys at every depth, keeps array order and writes undefined as null', () => {
    expect(canonicalJson({ b: [{ z: 1, y: 2 }, 3], a: undefined, c: new Date(0) })).toBe('{"b":[{"y":2,"z":1},3],"c":"1970-01-01T00:00:00.000Z"}');
    expect(canonicalJson(undefined)).toBe('null');
  });
});

describe('the pinned model values (D-68, D-75, D-76)', () => {
  it('reserves 64,512 tokens per invocation, so six reservations fit the day cap and a seventh does not', () => {
    expect(TOKEN_RESERVATION_PER_INVOCATION).toBe(64_512);
    expect(6 * TOKEN_RESERVATION_PER_INVOCATION).toBeLessThanOrEqual(MODEL_VALUES.perDayTokenReservations);
    expect(7 * TOKEN_RESERVATION_PER_INVOCATION).toBeGreaterThan(MODEL_VALUES.perDayTokenReservations);
  });

  it('ends the runtime loop 10 seconds before detection stops waiting', () => {
    expect(MODEL_VALUES.runtimeDeadlineMs).toBe(MODEL_VALUES.agentInvocationTimeoutMs - 10_000);
  });

  it('bounds one call by the record ceiling, the prompt and tool spec budget and 1,024 bytes of framing', () => {
    expect(RECORD_BYTE_CEILING + MODEL_VALUES.promptAndToolSpecByteBudget + 1_024).toBe(MODEL_VALUES.inputTokenCeiling);
    expect(MODEL_VALUES.systemPromptByteBudget).toBeLessThan(MODEL_VALUES.promptAndToolSpecByteBudget);
  });

  it('reports the model id, the profile id, the max tokens and the thinking setting as the pinned four', () => {
    expect(PINNED_MODEL_VALUES).toEqual({
      modelId: 'anthropic.claude-sonnet-5',
      profileId: 'eu.anthropic.claude-sonnet-5',
      maxTokens: 1_024,
      thinking: 'disabled',
    });
  });
});

describe('the bedrockModel row streams Strands events (D-71)', () => {
  it('declares stream as the row operation, mutating and gated, in place of converse', () => {
    expect(PORT_TABLE.bedrockModel.operations.join(' ')).toBe('stream');
    expect(PORT_TABLE.bedrockModel.mutatingOperations.join(' ')).toBe('stream');
    expect(PORT_TABLE.bedrockModel.gatedOperations.join(' ')).toBe('stream');
  });

  it('writes one dry-run line before the first event in test, then yields the scripted turn', async () => {
    const order: string[] = [];
    const lines: string[] = [];
    const { ports } = resolvePortTable({
      runtimeContext: 'test',
      switchValue: undefined,
      fixtures: { model: createFixtureModel([plainTextTurn('the answer', USAGE)]) },
      dryRunSink: (line) => {
        lines.push(line);
        order.push('line');
      },
    });

    const events: ModelStreamEvent[] = [];
    for await (const event of ports.bedrockModel.stream([userMessage('p')], { systemPrompt: 's' })) {
      order.push(event.type);
      events.push(event);
    }
    expect(lines).toHaveLength(1);
    expect(lines[0]?.startsWith('(dry-run) WOULD bedrockModel.stream eu.anthropic.claude-sonnet-5 {')).toBe(true);
    expect(order[0]).toBe('line');
    expect(events).toEqual(plainTextTurn('the answer', USAGE).events);
  });

  it('rejects with FixtureMissError naming bedrockModel.stream on first iteration when no fixture model is set', async () => {
    const { ports } = resolvePortTable({ runtimeContext: 'test', switchValue: undefined, dryRunSink: NO_LINES });
    const stream = ports.bedrockModel.stream([userMessage('p')]);
    const refusal = await drain(stream).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(FixtureMissError);
    expect((refusal as Error).message).toBe('no recording answers bedrockModel.stream');
  });

  it('writes a line holding exactly the model id, the message count and the prompt bytes, and no message text', async () => {
    const lines: string[] = [];
    const log = createDryRunLog({ sink: (line) => lines.push(line), addressKey: createFixtureAddressKey(), now: () => 1 });
    const messages = [userMessage(PLANTED_SENTENCE), new Message({ role: 'assistant', content: [new TextBlock('a reply about the mailbox')] })];
    const stream = createBedrockModelDryRun(log).stream(messages, { systemPrompt: 'system words' });
    expect(lines).toEqual([]);

    expect(await drain(stream)).toEqual([]);
    expect(lines).toHaveLength(1);
    const [, summaryJson] = /^\(dry-run\) WOULD bedrockModel\.stream eu\.anthropic\.claude-sonnet-5 (\{.*\})$/.exec(lines[0] ?? '') ?? [];
    const summary = JSON.parse(summaryJson ?? '{}') as Record<string, unknown>;
    expect(Object.keys(summary).sort()).toEqual(['messageCount', 'modelId', 'promptBytes']);
    expect(summary).toEqual({
      modelId: MODEL_VALUES.inferenceProfileId,
      messageCount: 2,
      promptBytes: Buffer.byteLength(JSON.stringify({ messages, systemPrompt: 'system words' })),
    });
    for (const text of ['mailbox', 'Jane', 'system words', 'reply']) expect(lines[0]).not.toContain(text);
  });
});

describe('createFixtureModel', () => {
  it('replays one turn per call and records a JSON copy of each call input', async () => {
    const model = createFixtureModel([plainTextTurn('one', USAGE), structuredAnswerTurn({ ok: true }, USAGE)]);
    const message = userMessage('first');
    const spec = { name: STRUCTURED_OUTPUT_TOOL_NAME, description: 'answer', inputSchema: { type: 'object' as const } };

    expect(await drain(model.stream([message], { systemPrompt: 's', toolSpecs: [spec], toolChoice: { any: {} } }))).toEqual(
      plainTextTurn('one', USAGE).events,
    );
    expect(await drain(model.stream([message]))).toEqual(structuredAnswerTurn({ ok: true }, USAGE).events);
    (message.content as ContentBlock[]).push(new TextBlock('added after the call'));

    expect(model.calls).toHaveLength(2);
    expect(model.calls[0]).toEqual({
      messages: [expect.objectContaining({ role: 'user', content: [{ text: 'first' }] })],
      systemPrompt: 's',
      toolSpecs: [spec],
      toolChoice: { any: {} },
    });
    expect(model.calls[1]).toMatchObject({ systemPrompt: undefined, toolSpecs: undefined, toolChoice: undefined });
  });

  it('throws FixtureMissError on a call past the script', async () => {
    const model = createFixtureModel([plainTextTurn('one', USAGE)]);
    await drain(model.stream([userMessage('p')]));
    await expect(drain(model.stream([userMessage('p')]))).rejects.toBeInstanceOf(FixtureMissError);
  });

  it('builds a structured answer as one strands_structured_output tool use, stopped on toolUse, with its usage', () => {
    expect(structuredAnswerTurn({ verdict: 'unknown' }, USAGE).events).toEqual([
      { type: 'modelMessageStartEvent', role: 'assistant' },
      { type: 'modelContentBlockStartEvent', start: { type: 'toolUseStart', name: 'strands_structured_output', toolUseId: 'fixture-use-1' } },
      { type: 'modelContentBlockDeltaEvent', delta: { type: 'toolUseInputDelta', input: '{"verdict":"unknown"}' } },
      { type: 'modelContentBlockStopEvent' },
      { type: 'modelMessageStopEvent', stopReason: 'toolUse' },
      { type: 'modelMetadataEvent', usage: USAGE },
    ]);
  });

  it('throws the SDK own throttling error for a throttled turn', async () => {
    const model = createFixtureModel([throttledTurn()]);
    await expect(drain(model.stream([userMessage('p')]))).rejects.toBeInstanceOf(ModelThrottledError);
  });
});

describe('the agentCore fixture routes to an in-process handler (D-80)', () => {
  it('hands the handler a JSON copy of the payload after its line, and returns a JSON copy of the answer', async () => {
    const order: string[] = [];
    const received: unknown[] = [];
    const answer = { status: 'answered', nested: { calls: 1 } };
    const payload = { record: { rows: [1, 2] } };
    const { ports } = resolvePortTable({
      runtimeContext: 'test',
      switchValue: undefined,
      fixtures: {
        agentRuntime: async (handed) => {
          order.push('handler');
          received.push(handed);
          return answer;
        },
      },
      dryRunSink: (line) => order.push(line),
    });

    const result = await ports.agentCore.invokeAgentRuntime({ runtimeArn: RUNTIME_ARN, sessionId: 's', payload });
    expect(received).toEqual([payload]);
    expect(received[0]).not.toBe(payload);
    expect(result).toEqual(answer);
    expect(result).not.toBe(answer);
    expect(order).toHaveLength(2);
    expect(order[0]?.startsWith(`(dry-run) WOULD agentCore.invokeAgentRuntime ${RUNTIME_ARN} `)).toBe(true);
    expect(order[1]).toBe('handler');
  });

  it('rejects with an AbortError and never runs the handler when the signal is already aborted', async () => {
    let handled = 0;
    const { ports } = resolvePortTable({
      runtimeContext: 'test',
      switchValue: undefined,
      fixtures: {
        agentRuntime: async () => {
          handled += 1;
          return {};
        },
      },
      dryRunSink: NO_LINES,
    });
    const controller = new AbortController();
    controller.abort();
    await expect(
      ports.agentCore.invokeAgentRuntime({ runtimeArn: RUNTIME_ARN, sessionId: 's', payload: {}, abortSignal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(handled).toBe(0);
  });

  it('rejects with an AbortError when the signal aborts while the handler runs', async () => {
    let started: () => void = () => {};
    const handlerStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const { ports } = resolvePortTable({
      runtimeContext: 'test',
      switchValue: undefined,
      fixtures: {
        agentRuntime: async () => {
          started();
          return new Promise<never>(() => {});
        },
      },
      dryRunSink: NO_LINES,
    });
    const controller = new AbortController();
    const pending = ports.agentCore.invokeAgentRuntime({ runtimeArn: RUNTIME_ARN, sessionId: 's', payload: {}, abortSignal: controller.signal });
    await handlerStarted;
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });
});
