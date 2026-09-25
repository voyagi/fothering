import { resolveProviderMode } from '@fothering/core/mode';
import { UNCLASSIFIED } from '@fothering/core/records';
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
 * One row per AWS-backed capability: its operation names, which of those mutate, which the live
 * switch gates, its fixture factory, and its live side, either a factory or a `notBuiltUntil`
 * phase for a row no adapter has reached yet (T-01-03).
 *
 * Mutating and gated are two different facts (D-06 decides live vs dry-run per operation, not per
 * port). A gated operation resolves to the dry-run recorder in 'deployed' unless the switch is
 * exactly `live`: SPEC requirement 1 names those as SES pause, reopen and send, the model call and
 * InvokeAgentRuntime. A write to Fothering's own table or queue mutates but is never gated, so a
 * deploy with the switch unset still stores the events it ingests.
 */
export interface PortRow {
  readonly operations: readonly string[];
  readonly mutatingOperations: readonly string[];
  readonly gatedOperations: readonly string[];
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
    gatedOperations: [],
    fixture: (fixtures: FixtureOptions) => createFixtureEventStore(fixtures),
    live: { notBuiltUntil: 1 },
  },
  addressKey: {
    operations: ['getKeySet'],
    mutatingOperations: [],
    gatedOperations: [],
    fixture: () => createFixtureAddressKey(),
    live: { notBuiltUntil: 1 },
  },
  deadLetter: {
    operations: ['send'],
    mutatingOperations: ['send'],
    gatedOperations: [],
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

// AC-P9: a live adapter reduces its request to a receiving domain or a lane name before this
// fires. The recorder does not rely on that: a string first argument is printed only when it
// matches a shape that cannot hold an address or a sentence, anything else prints as
// unclassified, and a non-string argument (a whole command or record) prints the port name.
const DRY_RUN_TARGET_PATTERN = /^[A-Za-z0-9._:-]{1,256}$/;

function dryRunTarget(portName: string, first: unknown): string {
  if (typeof first !== 'string') return portName;
  return DRY_RUN_TARGET_PATTERN.test(first) ? first : UNCLASSIFIED;
}

// A misspelled gated name leaves the real operation ungated, live with no switch at all, so every
// listed name must be one of the row's own operations, checked in every runtime context.
function assertListedOperations(portName: string, row: PortRow): void {
  for (const listed of [...row.mutatingOperations, ...row.gatedOperations]) {
    if (!row.operations.includes(listed)) {
      throw new Error(`the ${portName} row lists ${listed}, which is not one of its operations`);
    }
  }
}

function dryRunOperation(portName: string, operation: string, sink: DryRunSink): (...args: unknown[]) => Promise<void> {
  return async (...args: unknown[]) => {
    sink(`(dry-run) WOULD ${portName}.${operation} ${dryRunTarget(portName, args[0])}`);
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
    assertListedOperations(name, row);
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

    // Each operation is read off the instance and bound to it, never copied with a spread: a spread
    // keeps own properties only, so an adapter written as a class would lose every method on its
    // prototype and report 'live' for an operation that is not there. A missing operation fails
    // here, when the composition root is built, not on the first call in a deployed function.
    const liveInstance = row.live({ liveConfig, liveClients, dryRunSink, now }) as Record<string, unknown>;
    const wrapped: Record<string, unknown> = {};
    for (const operation of row.operations) {
      const method = liveInstance[operation];
      if (typeof method !== 'function') {
        throw new Error(`the live ${name} adapter has no ${operation} operation`);
      }
      if (row.gatedOperations.includes(operation) && mode !== 'live') {
        rowKinds[operation] = 'dry-run';
        wrapped[operation] = dryRunOperation(name, operation, dryRunSink);
      } else {
        rowKinds[operation] = 'live';
        wrapped[operation] = (method as (...args: unknown[]) => unknown).bind(liveInstance);
      }
    }
    ports[name] = wrapped;
    kinds[name] = rowKinds;
  }

  return { ports: ports as unknown as ResolvedPorts, kinds };
}
