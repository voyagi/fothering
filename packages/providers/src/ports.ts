import { BedrockAgentCoreClient } from '@aws-sdk/client-bedrock-agentcore';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { SESv2Client } from '@aws-sdk/client-sesv2';
import { SQSClient } from '@aws-sdk/client-sqs';
import { resolveProviderMode, type ProviderMode } from '@fothering/core/mode';
import type {
  AddressKeyPort,
  AgentCorePort,
  BedrockModelPort,
  DeadLetterPort,
  DecisionStorePort,
  DnsPort,
  EventStorePort,
  FixtureOptions,
  ReplyBucketPort,
  SesPort,
} from './port-types.js';
import type { DryRunSink, KindTable, LiveClients, LiveConfig, ResolvedKind, RuntimeContext } from './port-types.js';
import { NotBuiltError, brandPort, kindOf } from './port-types.js';
import {
  createAgentCoreDryRun,
  createBedrockModelDryRun,
  createDryRunLog,
  createSesDryRun,
  type DryRunLog,
} from './dry-run.js';
import {
  createFixtureAddressKey,
  createFixtureDeadLetter,
  createFixtureDecisionStore,
  createFixtureEventStore,
} from './fixtures/ingest-ports.js';
import {
  createFixtureAgentCore,
  createFixtureBedrockModel,
  createFixtureDns,
  createFixtureReplyBucket,
  createFixtureSes,
} from './fixtures/later-ports.js';
import { lazyClient } from './live/lazy-client.js';
import { createLiveAgentCore, createLiveBedrockModel } from './live/agent-adapters.js';
import { createLiveDns, type DnsResolverFactory } from './live/dns.js';
import { createDynamoDecisionStore, createDynamoEventStore } from './live/event-store.js';
import { createSecretsManagerAddressKey } from './live/address-key.js';
import { createSqsDeadLetter } from './live/dead-letter.js';
import { createSesReads } from './live/ses-reads.js';

const LIVE_REGION = 'eu-central-1';

// The one place a row decides what to call: an already-built client (a test's stub), a factory
// (a test's construction counter), or nothing (build the real thing). Every row wires this through
// lazyClient so a busy container still builds each client exactly once (SAFE-01).
function resolveLiveClient<T>(provided: unknown, construct: () => T): () => T {
  return lazyClient(() => {
    if (typeof provided === 'function') return (provided as () => T)();
    if (provided !== undefined) return provided as T;
    return construct();
  });
}

export type PortName =
  | 'eventStore'
  | 'decisionStore'
  | 'addressKey'
  | 'deadLetter'
  | 'ses'
  | 'dns'
  | 'bedrockModel'
  | 'agentCore'
  | 'replyBucket';

interface LivePortContext {
  liveConfig: LiveConfig;
  liveClients: LiveClients;
  now: () => number;
}

/**
 * One row per AWS-backed capability: its operation names, which of those mutate, which the live
 * switch gates, its fixture factory, its live side, and the recorder a gated operation uses until
 * the switch is exactly `live`.
 *
 * Mutating and gated are two different facts (D-06 decides live vs dry-run per operation, not per
 * port). A gated operation resolves to the row's dry-run recorder in 'deployed' unless the switch is
 * exactly `live`, whether or not its live side exists yet; with the switch live it resolves to the
 * live adapter, or to its not-built phase when there is none. A write to Fothering's own table or
 * queue mutates but is never gated, so a deploy with the switch unset still stores the events it
 * ingests.
 *
 * The live side is a factory or, for a row no adapter has reached yet, a `notBuiltUntil` phase for
 * the whole row (T-01-03). A row whose adapter covers only part of its operations lists the rest
 * in `notBuiltOperations`, each with the phase that builds it.
 */
export interface PortRow {
  readonly operations: readonly string[];
  /** Operations that change state anywhere. No resolution path reads this list: ports.test.ts holds
   * each one to exactly one dry-run line per call in 'test', and a gated row to gating all of them. */
  readonly mutatingOperations: readonly string[];
  /** Operations the live switch owns: resolvePortTable serves these from the row's dryRun recorder in
   * 'deployed' until the switch is exactly live. */
  readonly gatedOperations: readonly string[];
  readonly fixture: (fixtures: FixtureOptions, dryRun: DryRunLog) => unknown;
  readonly live: ((context: LivePortContext) => unknown) | { readonly notBuiltUntil: number };
  readonly notBuiltOperations?: Readonly<Record<string, number>>;
  readonly dryRun?: (log: DryRunLog) => unknown;
}

export interface ResolvedPorts {
  eventStore: EventStorePort;
  decisionStore: DecisionStorePort;
  addressKey: AddressKeyPort;
  deadLetter: DeadLetterPort;
  ses: SesPort;
  dns: DnsPort;
  bedrockModel: BedrockModelPort;
  agentCore: AgentCorePort;
  replyBucket: ReplyBucketPort;
}

// `satisfies` keeps the literal per-row types (each fixture's real return type) while still
// proving the table covers every PortName; deleting a row is then a type error at this line, not
// a runtime surprise the first time a caller asks for the missing one (D-05).
export const PORT_TABLE = {
  eventStore: {
    operations: ['putIfAbsent', 'queryLane', 'queryByRecipient', 'deleteRecord', 'getRecord', 'foldLane'],
    mutatingOperations: ['putIfAbsent', 'deleteRecord'],
    gatedOperations: [],
    fixture: (fixtures: FixtureOptions, dryRun: DryRunLog) => createFixtureEventStore(fixtures, dryRun),
    live: ({ liveConfig, liveClients }) =>
      brandPort(
        createDynamoEventStore({
          tableName: liveConfig.tableName,
          client: resolveLiveClient(liveClients.dynamoDb, () => DynamoDBDocumentClient.from(new DynamoDBClient({ region: LIVE_REGION }))),
        }),
        'live',
      ),
  },
  // Incident, evidence, decision and counter items in the event table (D-65, D-66). Like the event
  // store, Fothering's own table: its writes mutate but never wait for the switch.
  decisionStore: {
    operations: ['putIfAbsent', 'getItem', 'updateIfVersion', 'reserveInvocation', 'recordUsage'],
    mutatingOperations: ['putIfAbsent', 'updateIfVersion', 'reserveInvocation', 'recordUsage'],
    gatedOperations: [],
    fixture: (fixtures: FixtureOptions, dryRun: DryRunLog) => createFixtureDecisionStore(fixtures, dryRun),
    live: ({ liveConfig, liveClients }) =>
      brandPort(
        createDynamoDecisionStore({
          tableName: liveConfig.tableName,
          client: resolveLiveClient(liveClients.dynamoDb, () => DynamoDBDocumentClient.from(new DynamoDBClient({ region: LIVE_REGION }))),
        }),
        'live',
      ),
  },
  addressKey: {
    operations: ['getKeySet'],
    mutatingOperations: [],
    gatedOperations: [],
    fixture: () => createFixtureAddressKey(),
    live: ({ liveConfig, liveClients, now }) =>
      brandPort(
        createSecretsManagerAddressKey({
          secretId: liveConfig.addressKeySecretId,
          client: resolveLiveClient(liveClients.secretsManager, () => new SecretsManagerClient({ region: LIVE_REGION })),
          now,
        }),
        'live',
      ),
  },
  deadLetter: {
    operations: ['send'],
    mutatingOperations: ['send'],
    gatedOperations: [],
    fixture: (fixtures: FixtureOptions, dryRun: DryRunLog) => createFixtureDeadLetter(fixtures, dryRun),
    live: ({ liveConfig, liveClients }) =>
      brandPort(
        createSqsDeadLetter({
          queueUrl: liveConfig.deadLetterQueueUrl,
          client: resolveLiveClient(liveClients.sqs, () => new SQSClient({ region: LIVE_REGION })),
        }),
        'live',
      ),
  },
  ses: {
    operations: [
      'getEmailIdentity',
      'listEmailIdentities',
      'listConfigurationSets',
      'getConfigurationSetEventDestinations',
      'getConfigurationSetSending',
      'pauseConfigurationSet',
      'reopenConfigurationSet',
      'sendEmail',
    ],
    // The read-back changes nothing, so it is neither mutating nor gated: once its live side exists it
    // stays live in 'deployed' whatever the switch, as the four reads do (SAFE-01).
    mutatingOperations: ['pauseConfigurationSet', 'reopenConfigurationSet', 'sendEmail'],
    gatedOperations: ['pauseConfigurationSet', 'reopenConfigurationSet', 'sendEmail'],
    fixture: (fixtures: FixtureOptions, dryRun: DryRunLog) =>
      createFixtureSes({ recordings: fixtures.recordings?.ses ?? [], dryRun, state: fixtures.sesState }),
    live: ({ liveClients }) =>
      brandPort(createSesReads({ client: resolveLiveClient(liveClients.sesv2, () => new SESv2Client({ region: LIVE_REGION })) }), 'live'),
    notBuiltOperations: { getConfigurationSetSending: 3, pauseConfigurationSet: 3, reopenConfigurationSet: 3, sendEmail: 4 },
    dryRun: (log: DryRunLog) => createSesDryRun(log),
  },
  // R6 reads the ROADMAP's "DNS behind the dry-run gate" as DNS behind this table: recorded answers in
  // 'test', so no test or CI run ever queries DNS, and live in 'deployed' whatever the switch, the
  // treatment SAFE-01 gives the SES reads, since a lookup changes nothing and costs nothing.
  dns: {
    operations: ['resolveMx', 'resolveTxt'],
    mutatingOperations: [],
    gatedOperations: [],
    fixture: (fixtures: FixtureOptions) => createFixtureDns({ recordings: fixtures.recordings?.dns ?? [] }),
    live: ({ liveClients }) =>
      brandPort(createLiveDns({ resolverFactory: liveClients.dnsResolver as DnsResolverFactory | undefined }), 'live'),
  },
  bedrockModel: {
    operations: ['stream'],
    mutatingOperations: ['stream'],
    gatedOperations: ['stream'],
    fixture: (fixtures: FixtureOptions, dryRun: DryRunLog) => createFixtureBedrockModel({ model: fixtures.model, dryRun }),
    live: () => brandPort(createLiveBedrockModel(), 'live'),
    dryRun: (log: DryRunLog) => createBedrockModelDryRun(log),
  },
  agentCore: {
    operations: ['invokeAgentRuntime'],
    mutatingOperations: ['invokeAgentRuntime'],
    gatedOperations: ['invokeAgentRuntime'],
    fixture: (fixtures: FixtureOptions, dryRun: DryRunLog) =>
      createFixtureAgentCore({ recordings: fixtures.recordings?.agentCore ?? [], agentRuntime: fixtures.agentRuntime, dryRun }),
    live: ({ liveClients }) =>
      brandPort(
        createLiveAgentCore({
          // One attempt: an SDK retry re-sends InvokeAgentRuntime, which runs the agent again on the one
          // reservation detection made. The SDK's default is three (standard retry mode).
          client: resolveLiveClient(liveClients.bedrockAgentCore, () => new BedrockAgentCoreClient({ region: LIVE_REGION, maxAttempts: 1 })),
        }),
        'live',
      ),
    dryRun: (log: DryRunLog) => createAgentCoreDryRun(log),
  },
  replyBucket: {
    operations: ['getReplyObject'],
    mutatingOperations: [],
    gatedOperations: [],
    fixture: (fixtures: FixtureOptions) => createFixtureReplyBucket({ recordings: fixtures.recordings?.replyBucket ?? [] }),
    live: { notBuiltUntil: 4 },
  },
} satisfies Record<PortName, PortRow>;

// Each optional field also takes an explicit undefined, so a composition root can hand over its own
// options object as it is, an unset field and all, instead of copying only the fields it holds.
interface ResolvePortTableOptions {
  runtimeContext: RuntimeContext;
  switchValue: string | undefined;
  liveConfig?: LiveConfig | undefined;
  liveClients?: LiveClients | undefined;
  fixtures?: FixtureOptions | undefined;
  dryRunSink?: DryRunSink | undefined;
  now?: (() => number) | undefined;
  /** Planted table for tests exercising a shape PORT_TABLE itself no longer holds (D-05). */
  table?: Record<PortName, PortRow> | undefined;
}

interface ResolvedRow {
  port: unknown;
  kinds: Record<string, ResolvedKind>;
}

// Where a line goes when the caller passes no sink of its own: a deployed process writes it to
// stdout for CloudWatch, a test writes nowhere. The dry-run log and every root's logger use it, and
// a test that wants the lines passes its own sink.
export function defaultLineSink(runtimeContext: RuntimeContext): (line: string) => void {
  return runtimeContext === 'deployed'
    ? (line) => {
        process.stdout.write(`${line}\n`);
      }
    : () => {};
}

// Every named operation rejects, never throws synchronously: a caller awaiting a port method
// (all of them are async in the real interfaces) must see a rejected promise, not an uncaught
// throw before one exists.
function notBuiltPort(operations: readonly string[], phase: number): object {
  const port: Record<string, (...args: unknown[]) => Promise<never>> = {};
  for (const operation of operations) {
    port[operation] = async () => {
      throw new NotBuiltError(phase);
    };
  }
  return brandPort(port, `not-built-until-phase-${phase}`);
}

// A misspelled gated name leaves the real operation ungated, live with no switch at all, so every
// listed name must be one of the row's own operations, checked in every runtime context.
function assertListedOperations(portName: string, row: PortRow): void {
  const listed = [...row.mutatingOperations, ...row.gatedOperations, ...Object.keys(row.notBuiltOperations ?? {})];
  for (const operation of listed) {
    if (!row.operations.includes(operation)) {
      throw new Error(`the ${portName} row lists ${operation}, which is not one of its operations`);
    }
  }
}

function requireOperations(description: string, implementation: unknown, operations: readonly string[]): Record<string, unknown> {
  const source = implementation as Record<string, unknown>;
  for (const operation of operations) {
    if (typeof source[operation] !== 'function') throw new Error(`${description} has no ${operation} operation`);
  }
  return source;
}

// The kind is whatever the implementation says it is, never the slot it was found in: a live
// adapter wired into a row's fixture slot must report live, so a table that does so fails its
// expected-kind comparison instead of passing on its own declaration (T-01-10).
function requireKind(description: string, implementation: unknown): ResolvedKind {
  const kind = kindOf(implementation);
  if (kind === undefined) throw new Error(`${description} carries no kind brand`);
  return kind;
}

// Gated operations need a recorder in every context, not only where one is used: a gate whose
// recorder is missing would otherwise fail on the first deployed call instead of when the root builds.
function gatedRecorders(portName: string, row: PortRow, log: DryRunLog): Record<string, unknown> | undefined {
  if (row.gatedOperations.length === 0) return undefined;
  const recorders = (row.dryRun?.(log) ?? {}) as Record<string, unknown>;
  for (const operation of row.gatedOperations) {
    if (typeof recorders[operation] !== 'function') {
      throw new Error(`the ${portName} row gates ${operation} but its dry-run recorder has no ${operation} operation`);
    }
  }
  return brandPort(recorders, 'dry-run');
}

function resolveFixtureRow(portName: string, row: PortRow, fixtures: FixtureOptions, log: DryRunLog): ResolvedRow {
  const description = `the ${portName} fixture`;
  const implementation = row.fixture(fixtures, log);
  const kind = requireKind(description, implementation);
  requireOperations(description, implementation, row.operations);
  return { port: implementation, kinds: Object.fromEntries(row.operations.map((operation) => [operation, kind])) };
}

interface DeployedRowInput {
  portName: string;
  row: PortRow;
  mode: ProviderMode;
  recorders: Record<string, unknown> | undefined;
  liveContext: LivePortContext;
}

// Which implementation serves one operation in 'deployed' (D-06): the recorder while a gated
// operation waits for the switch, the not-built stub when nothing is built yet for it, else the
// live adapter.
function notBuiltPhase(row: PortRow, operation: string): number | undefined {
  if (typeof row.live !== 'function') return row.live.notBuiltUntil;
  return row.notBuiltOperations?.[operation];
}

function resolveDeployedRow(input: DeployedRowInput): ResolvedRow {
  const { portName, row, mode, recorders, liveContext } = input;
  const stubs = new Map<number, object>();
  let liveInstance: Record<string, unknown> | undefined;

  const sourceFor = (operation: string): { description: string; implementation: unknown } => {
    if (row.gatedOperations.includes(operation) && mode !== 'live') {
      return { description: `the ${portName} row's dry-run recorder`, implementation: recorders };
    }
    const phase = notBuiltPhase(row, operation);
    if (phase !== undefined) {
      const stub = stubs.get(phase) ?? notBuiltPort(row.operations, phase);
      stubs.set(phase, stub);
      return { description: `the not-built ${portName} stub`, implementation: stub };
    }
    // Reaching here means the row's live side is a factory: a whole-row notBuiltUntil returned above.
    liveInstance ??= (row.live as (context: LivePortContext) => Record<string, unknown>)(liveContext);
    return { description: `the live ${portName} adapter`, implementation: liveInstance };
  };

  const port: Record<string, unknown> = {};
  const kinds: Record<string, ResolvedKind> = {};
  // Each operation is read off the instance and bound to it, never copied with a spread: a spread
  // keeps own properties only, so an adapter written as a class would lose every method on its
  // prototype and report 'live' for an operation that is not there. A missing operation fails
  // here, when the composition root is built, not on the first call in a deployed function.
  for (const operation of row.operations) {
    const { description, implementation } = sourceFor(operation);
    const source = requireOperations(description, implementation, [operation]);
    kinds[operation] = requireKind(description, implementation);
    port[operation] = (source[operation] as (...args: unknown[]) => unknown).bind(source);
  }
  return { port, kinds };
}

export function resolvePortTable(options: ResolvePortTableOptions): { ports: ResolvedPorts; kinds: KindTable } {
  const table = options.table ?? PORT_TABLE;
  const mode = resolveProviderMode(options.switchValue);
  const fixtures = options.fixtures ?? {};
  const dryRunSink = options.dryRunSink ?? defaultLineSink(options.runtimeContext);
  const now = options.now ?? Date.now;
  const liveContext: LivePortContext = { liveConfig: options.liveConfig ?? {}, liveClients: options.liveClients ?? {}, now };

  const ports: Record<string, unknown> = {};
  const kinds: Record<string, Record<string, ResolvedKind>> = {};

  // The key set is read through `ports` when a line needs it, not when the table resolves: a table
  // declared in another order resolves its ses row before its addressKey row, and the log must not care.
  const log = createDryRunLog({
    sink: dryRunSink,
    addressKey: { getKeySet: () => (ports.addressKey as AddressKeyPort).getKeySet() },
    now,
  });

  for (const portName of Object.keys(table) as PortName[]) {
    const row = table[portName];
    assertListedOperations(portName, row);
    const recorders = gatedRecorders(portName, row, log);
    const resolved =
      options.runtimeContext === 'test'
        ? resolveFixtureRow(portName, row, fixtures, log)
        : resolveDeployedRow({ portName, row, mode, recorders, liveContext });
    ports[portName] = resolved.port;
    kinds[portName] = resolved.kinds;
  }

  return { ports: ports as unknown as ResolvedPorts, kinds };
}
