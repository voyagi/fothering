import { describe, expect, it } from 'vitest';
import type { EventRecord } from '@fothering/core/records';
import { resolvePortTable, type PortName, type PortRow } from './ports.js';
import { createFixtureAddressKey, createFixtureDeadLetter, createFixtureEventStore } from './fixtures/ingest-ports.js';

// No row has a live adapter yet (each is notBuiltUntil a later plan), so this planted table is the
// only place the live side of resolvePortTable runs. Its adapters are classes on purpose: a class
// keeps its methods on the prototype, which is the shape a copied-object port table loses.
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

function plantedLiveTable(adapters: PlantedAdapters): Record<PortName, PortRow> {
  return {
    eventStore: {
      operations: ['putIfAbsent', 'queryLane', 'queryByRecipient', 'deleteRecord', 'getRecord'],
      mutatingOperations: ['putIfAbsent', 'deleteRecord'],
      fixture: () => createFixtureEventStore(),
      live: () => adapters.eventStore,
    },
    addressKey: {
      operations: ['getKeySet'],
      mutatingOperations: [],
      fixture: () => createFixtureAddressKey(),
      live: () => adapters.addressKey,
    },
    deadLetter: {
      operations: ['send'],
      mutatingOperations: ['send'],
      fixture: () => createFixtureDeadLetter(),
      live: () => adapters.deadLetter,
    },
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

  it('records a mutating operation as one dry-run line and never calls the adapter when the switch is not live', async () => {
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

  it('calls the adapter for a mutating operation when the switch is exactly live', async () => {
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
