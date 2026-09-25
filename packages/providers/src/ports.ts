import { resolveProviderMode } from '@fothering/core/mode';
import type { AddressKeyPort, DeadLetterPort, EventStorePort, FixtureOptions } from './port-types.js';
import type { DryRunSink, KindTable, LiveClients, LiveConfig, ResolvedKind, RuntimeContext } from './port-types.js';
import { NotBuiltError } from './port-types.js';
import { createFixtureAddressKey, createFixtureDeadLetter, createFixtureEventStore } from './fixtures/ingest-ports.js';

export type PortName = 'eventStore' | 'addressKey' | 'deadLetter';

interface LivePortContext {
  liveConfig: LiveConfig;
  liveClients: LiveClients;
  dryRunSink: DryRunSink;
  now: () => number;
}

/**
 * One row per AWS-backed capability: its operation names, which of those mutate (D-06 decides
 * live vs dry-run per operation, not per port), its fixture factory, and its live side, either a
 * factory or a `notBuiltUntil` phase for a row no adapter has reached yet (T-01-03).
 */
export interface PortRow {
  readonly operations: readonly string[];
  readonly mutatingOperations: readonly string[];
  readonly fixture: (fixtures: FixtureOptions) => unknown;
  readonly live: ((context: LivePortContext) => unknown) | { readonly notBuiltUntil: number };
}

export interface ResolvedPorts {
  eventStore: EventStorePort;
  addressKey: AddressKeyPort;
  deadLetter: DeadLetterPort;
}

// `satisfies` keeps the literal per-row types (each fixture's real return type) while still
// proving the table covers every PortName; deleting a row is then a type error at this line, not
// a runtime surprise the first time a caller asks for the missing one (D-05).
export const PORT_TABLE = {
  eventStore: {
    operations: ['putIfAbsent', 'queryLane', 'queryByRecipient', 'deleteRecord', 'getRecord'],
    mutatingOperations: ['putIfAbsent', 'deleteRecord'],
    fixture: (fixtures: FixtureOptions) => createFixtureEventStore(fixtures),
    live: { notBuiltUntil: 1 },
  },
  addressKey: {
    operations: ['getKeySet'],
    mutatingOperations: [],
    fixture: () => createFixtureAddressKey(),
    live: { notBuiltUntil: 1 },
  },
  deadLetter: {
    operations: ['send'],
    mutatingOperations: ['send'],
    fixture: (fixtures: FixtureOptions) => createFixtureDeadLetter(fixtures),
    live: { notBuiltUntil: 1 },
  },
} satisfies Record<PortName, PortRow>;

interface ResolvePortTableOptions {
  runtimeContext: RuntimeContext;
  switchValue: string | undefined;
  liveConfig?: LiveConfig;
  liveClients?: LiveClients;
  fixtures?: FixtureOptions;
  dryRunSink?: DryRunSink;
  now?: () => number;
  /** Planted table for tests exercising a shape PORT_TABLE itself no longer holds (D-05). */
  table?: Record<PortName, PortRow>;
}

const DEFAULT_DRY_RUN_SINK: DryRunSink = (line) => {
  process.stdout.write(`${line}\n`);
};

// Every named operation rejects, never throws synchronously: a caller awaiting a port method
// (all of them are async in the real interfaces) must see a rejected promise, not an uncaught
// throw before one exists.
function notBuiltPort(operations: readonly string[], phase: number): Record<string, (...args: unknown[]) => Promise<never>> {
  const port: Record<string, (...args: unknown[]) => Promise<never>> = {};
  for (const operation of operations) {
    port[operation] = async () => {
      throw new NotBuiltError(phase);
    };
  }
  return port;
}

// AC-P9: the target is a receiving domain or a lane name by the time this fires (later live
// adapters own that shaping); this recorder only ever prints whatever its caller already reduced
// the request to, never a whole command object that could carry a recipient address.
function dryRunOperation(portName: string, operation: string, sink: DryRunSink): (...args: unknown[]) => Promise<void> {
  return async (...args: unknown[]) => {
    const target = typeof args[0] === 'string' ? args[0] : portName;
    sink(`(dry-run) WOULD ${portName}.${operation} ${target}`);
  };
}

export function resolvePortTable(options: ResolvePortTableOptions): { ports: ResolvedPorts; kinds: KindTable } {
  const table = options.table ?? PORT_TABLE;
  const mode = resolveProviderMode(options.switchValue);
  const fixtures = options.fixtures ?? {};
  const dryRunSink = options.dryRunSink ?? DEFAULT_DRY_RUN_SINK;
  const now = options.now ?? Date.now;
  const liveConfig = options.liveConfig ?? {};
  const liveClients = options.liveClients ?? {};

  const ports: Record<string, unknown> = {};
  const kinds: Record<string, Record<string, ResolvedKind>> = {};

  for (const name of Object.keys(table) as PortName[]) {
    const row = table[name];
    const rowKinds: Record<string, ResolvedKind> = {};

    if (options.runtimeContext === 'test') {
      for (const operation of row.operations) rowKinds[operation] = 'fixture';
      ports[name] = row.fixture(fixtures);
      kinds[name] = rowKinds;
      continue;
    }

    if (typeof row.live !== 'function') {
      const phase = row.live.notBuiltUntil;
      const kind: ResolvedKind = `not-built-until-phase-${phase}`;
      for (const operation of row.operations) rowKinds[operation] = kind;
      ports[name] = notBuiltPort(row.operations, phase);
      kinds[name] = rowKinds;
      continue;
    }

    const liveInstance = row.live({ liveConfig, liveClients, dryRunSink, now }) as Record<string, unknown>;
    const wrapped: Record<string, unknown> = { ...liveInstance };
    for (const operation of row.operations) {
      if (row.mutatingOperations.includes(operation) && mode !== 'live') {
        rowKinds[operation] = 'dry-run';
        wrapped[operation] = dryRunOperation(name, operation, dryRunSink);
      } else {
        rowKinds[operation] = 'live';
      }
    }
    ports[name] = wrapped;
    kinds[name] = rowKinds;
  }

  return { ports: ports as unknown as ResolvedPorts, kinds };
}
