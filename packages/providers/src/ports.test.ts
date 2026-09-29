import { describe, expect, it, vi } from 'vitest';
import { pseudonymizeRecipient } from '@fothering/core/address';
import type { EventRecord, RecordKey } from '@fothering/core/records';
import { PORT_TABLE, resolvePortTable, type PortName, type PortRow, type ResolvedPorts } from './ports.js';
import { NotBuiltError, brandPort, kindOf, type ResolvedKind, type SendEmailRequest } from './port-types.js';
import { createDryRunLog, type DryRunLog } from './dry-run.js';
import {
  TEST_ADDRESS_KEY_SET,
  createFixtureAddressKey,
  createFixtureDeadLetter,
  createFixtureEventStore,
} from './fixtures/ingest-ports.js';
import { createFixtureAgentCore, createFixtureBedrockModel, createFixtureReplyBucket, createFixtureSes } from './fixtures/later-ports.js';
import { FixtureMissError, canonicalJson, recordedPort } from './fixtures/recorded.js';
import { assertRootMatrix, type RootMatrixOptions } from './test/root-matrix.js';

const SWITCH_VALUES = [undefined, '', '   ', 'true', 'LIVE', ' live', 'live'];
const RECORD_KEY = { pk: 'LANE#fothering-bulk', sk: 'B#0000000000000#Send#m1' };
const NO_LINES = (): void => {};

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
    ['bedrockModel', 'converse', 'dry-run', 'not-built-until-phase-2'],
    ['agentCore', 'invokeAgentRuntime', 'dry-run', 'not-built-until-phase-2'],
    ['replyBucket', 'getReplyObject', 'not-built-until-phase-4', 'not-built-until-phase-4'],
  ])('resolves %s.%s to %s without the switch and %s with it', (portName, operation, withoutSwitch, withSwitch) => {
    const unset = resolvePortTable({ runtimeContext: 'deployed', switchValue: undefined, dryRunSink: NO_LINES });
    const live = resolvePortTable({ runtimeContext: 'deployed', switchValue: 'live', dryRunSink: NO_LINES });
    expect(unset.kinds[portName]?.[operation]).toBe(withoutSwitch);
    expect(live.kinds[portName]?.[operation]).toBe(withSwitch);
  });

  it('never reports phase 1 for any operation, in either context, for any switch value', () => {
    for (const runtimeContext of ['test', 'deployed'] as const) {
      for (const switchValue of SWITCH_VALUES) {
        const { kinds } = resolvePortTable({ runtimeContext, switchValue, dryRunSink: NO_LINES });
        for (const row of Object.values(kinds)) {
          for (const kind of Object.values(row)) expect(kind).not.toBe('not-built-until-phase-1');
        }
      }
    }
  });

  it.each<[keyof ResolvedPorts, string, string, unknown[]]>([
    ['ses', 'pauseConfigurationSet', 'phase 3', ['fothering-bulk']],
    ['ses', 'reopenConfigurationSet', 'phase 3', ['fothering-bulk']],
    ['ses', 'sendEmail', 'phase 4', [{ from: 'ops@example.org', to: [], subject: 's', text: 't' }]],
    ['bedrockModel', 'converse', 'phase 2', [{ modelId: 'model-1', prompt: 'p' }]],
    ['agentCore', 'invokeAgentRuntime', 'phase 2', [{ runtimeArn: 'arn:aws:x', sessionId: 's', payload: {} }]],
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
        fixture: () => PORT_TABLE.eventStore.live({ liveConfig: {}, liveClients: {}, dryRunSink: NO_LINES, now: Date.now }),
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

  it('records model and runtime calls as the model id, the runtime ARN and prompt and payload lengths', async () => {
    const lines: string[] = [];
    const log = createDryRunLog({ sink: (line) => lines.push(line), addressKey: createFixtureAddressKey(), now: () => 1 });
    await log.would('bedrockModel.converse', 'eu.anthropic.claude-sonnet-5', { modelId: 'eu.anthropic.claude-sonnet-5', prompt: 'Jane said hello' });
    await log.would('agentCore.invokeAgentRuntime', 'arn:aws:bedrock-agentcore:eu-central-1:000000000000:runtime/fothering', {
      runtimeArn: 'arn:aws:bedrock-agentcore:eu-central-1:000000000000:runtime/fothering',
      sessionId: 'session-1',
      payload: { note: 'Jane said hello' },
    });
    expect(lines).toEqual([
      '(dry-run) WOULD bedrockModel.converse eu.anthropic.claude-sonnet-5 {"modelId":"eu.anthropic.claude-sonnet-5","promptLength":15}',
      '(dry-run) WOULD agentCore.invokeAgentRuntime arn:aws:bedrock-agentcore:eu-central-1:000000000000:runtime/fothering {"payloadLength":26,"runtimeArn":"arn:aws:bedrock-agentcore:eu-central-1:000000000000:runtime/fothering"}',
    ]);
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
  'bedrockModel.converse': (ports) => ports.bedrockModel.converse({ modelId: 'model-1', prompt: 'p' }),
  'agentCore.invokeAgentRuntime': (ports) =>
    ports.agentCore.invokeAgentRuntime({ runtimeArn: 'arn:aws:bedrock-agentcore:eu-central-1:000000000000:runtime/x', sessionId: 's', payload: {} }),
};

const MUTATION_RECORDINGS = {
  bedrockModel: [{ operation: 'bedrockModel.converse', request: { modelId: 'model-1', prompt: 'p' }, response: { text: 'ok' } }],
  agentCore: [
    {
      operation: 'agentCore.invokeAgentRuntime',
      request: { runtimeArn: 'arn:aws:bedrock-agentcore:eu-central-1:000000000000:runtime/x', sessionId: 's', payload: {} },
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
      fixtures: { recordings: MUTATION_RECORDINGS },
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

  it('records the model call and the runtime call before answering from a recording, and misses without one', async () => {
    const lines: string[] = [];
    const dryRun = createDryRunLog({ sink: (line) => lines.push(line), addressKey: createFixtureAddressKey(), now: () => 1 });
    const model = createFixtureBedrockModel({ recordings: [], dryRun });
    const runtime = createFixtureAgentCore({ recordings: [], dryRun });
    await expect(model.converse({ modelId: 'model-1', prompt: 'p' })).rejects.toThrow('bedrockModel.converse');
    await expect(
      runtime.invokeAgentRuntime({ runtimeArn: 'arn:aws:bedrock-agentcore:eu-central-1:000000000000:runtime/x', sessionId: 's', payload: 1 }),
    ).rejects.toThrow('agentCore.invokeAgentRuntime');
    expect(lines).toHaveLength(2);
  });

  it('canonicalJson sorts keys at every depth, keeps array order and writes undefined as null', () => {
    expect(canonicalJson({ b: [{ z: 1, y: 2 }, 3], a: undefined, c: new Date(0) })).toBe('{"b":[{"y":2,"z":1},3],"c":"1970-01-01T00:00:00.000Z"}');
    expect(canonicalJson(undefined)).toBe('null');
  });
});
