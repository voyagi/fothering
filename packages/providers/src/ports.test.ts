import { describe, expect, it } from 'vitest';
import type { EventRecord } from '@fothering/core/records';
import { PORT_TABLE, resolvePortTable, type PortName, type PortRow } from './ports.js';
import { createFixtureAddressKey, createFixtureDeadLetter, createFixtureEventStore } from './fixtures/ingest-ports.js';

// The real table's three rows are all live now, but none of them gates on the switch (their
// gatedOperations stay empty), so this planted table is the only place resolvePortTable's dry-run
// branch runs. Its adapters are classes on purpose: a class keeps its methods on the prototype,
// which is the shape a copied-object port table loses.
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
  addressKey: unknown;
  deadLetter: PlantedDeadLetter;
}

// The real table gates none of these operations (the product's own table, key and queue stay live
// without the switch), so this planted table gates two of them itself: it is the only way to reach
// the dry-run branch until a gated row lands.
function plantedLiveTable(adapters: PlantedAdapters): Record<PortName, PortRow> {
  return {
    eventStore: {
      operations: ['putIfAbsent', 'queryLane', 'queryByRecipient', 'deleteRecord', 'getRecord'],
      mutatingOperations: ['putIfAbsent', 'deleteRecord'],
      gatedOperations: ['putIfAbsent', 'deleteRecord'],
      fixture: () => createFixtureEventStore(),
      live: () => adapters.eventStore,
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
    },
  };
}

// The real PORT_TABLE's declarations with only the live side swapped for a planted adapter, so what
// is under test is the table's own operation, mutating and gated lists, not a copy of them.
function realTableWithPlantedLive(adapters: PlantedAdapters): Record<PortName, PortRow> {
  return {
    eventStore: { ...PORT_TABLE.eventStore, live: () => adapters.eventStore },
    addressKey: { ...PORT_TABLE.addressKey, live: () => adapters.addressKey },
    deadLetter: { ...PORT_TABLE.deadLetter, live: () => adapters.deadLetter },
  };
}

function freshAdapters(): PlantedAdapters {
  return { eventStore: new PlantedEventStore(), addressKey: new PlantedAddressKey(), deadLetter: new PlantedDeadLetter() };
}

describe('resolvePortTable with live adapters written as classes', () => {
  it('serves a read through the adapter itself, with its own this, when the switch is unset', async () => {
    const adapters = freshAdapters();
    const { ports, kinds } = resolvePortTable({
      runtimeContext: 'deployed',
      switchValue: undefined,
      table: plantedLiveTable(adapters),
      dryRunSink: () => {},
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
    await ports.eventStore.putIfAbsent({} as EventRecord);
    expect(lines).toEqual(['(dry-run) WOULD eventStore.putIfAbsent eventStore']);
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
    const adapters = { ...freshAdapters(), addressKey: {} };
    expect(() =>
      resolvePortTable({ runtimeContext: 'deployed', switchValue: undefined, table: plantedLiveTable(adapters), dryRunSink: () => {} }),
    ).toThrow('the live addressKey adapter has no getKeySet operation');
  });

  // A misspelled gated name would leave the real operation ungated, live with no switch at all,
  // which is the one failure the switch exists to prevent; so is a misspelled mutating name.
  it.each([
    ['gatedOperations', { gatedOperations: ['sned'] }],
    ['mutatingOperations', { mutatingOperations: ['sned'] }],
  ])('refuses a %s entry that is not one of the row operations, in every runtime context', (_label, override) => {
    for (const runtimeContext of ['test', 'deployed'] as const) {
      const table = plantedLiveTable(freshAdapters());
      const misspelled = { ...table, deadLetter: { ...table.deadLetter, ...override } };
      expect(() => resolvePortTable({ runtimeContext, switchValue: undefined, table: misspelled, dryRunSink: () => {} })).toThrow(
        'the deadLetter row lists sned, which is not one of its operations',
      );
    }
  });
});

// In 'deployed' the event store, the address key and the dead-letter queue resolve live for EVERY
// switch value. Only SES pause, reopen and send, the model call and InvokeAgentRuntime wait for the
// switch, and none of those rows exists yet.
describe('the real port table gates nothing the switch does not own', () => {
  it.each([undefined, '', '   ', 'true', 'LIVE', ' live', 'live'])(
    'resolves every event store, address key and dead-letter operation live in deployed for switch %j',
    (switchValue) => {
      const { kinds } = resolvePortTable({
        runtimeContext: 'deployed',
        switchValue,
        table: realTableWithPlantedLive(freshAdapters()),
        dryRunSink: () => {},
      });
      for (const [portName, row] of Object.entries(kinds)) {
        for (const [operation, kind] of Object.entries(row)) {
          expect(`${portName}.${operation} ${kind}`).toBe(`${portName}.${operation} live`);
        }
      }
    },
  );

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
});

describe('the dry-run line target (AC-P9)', () => {
  async function lineFor(first: unknown): Promise<string | undefined> {
    const lines: string[] = [];
    const { ports } = resolvePortTable({
      runtimeContext: 'deployed',
      switchValue: undefined,
      table: plantedLiveTable(freshAdapters()),
      dryRunSink: (line) => lines.push(line),
    });
    await ports.deadLetter.send(first as never);
    return lines[0];
  }

  it('prints a lane name or a receiving domain as given', async () => {
    expect(await lineFor('fothering-bulk')).toBe('(dry-run) WOULD deadLetter.send fothering-bulk');
    expect(await lineFor('example.com')).toBe('(dry-run) WOULD deadLetter.send example.com');
  });

  it.each([['an address', 'jane@example.com'], ['an empty string', ''], ['a sentence', 'the mailbox is full']])(
    'prints unclassified, never the text, for %s',
    async (_label, first) => {
      expect(await lineFor(first)).toBe('(dry-run) WOULD deadLetter.send unclassified');
    },
  );

  it('prints the port name for a request that is not a string', async () => {
    expect(await lineFor([{ recipient: 'jane@example.com' }])).toBe('(dry-run) WOULD deadLetter.send deadLetter');
  });
});
