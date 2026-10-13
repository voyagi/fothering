import type { Message, ModelStreamEvent, StreamOptions } from '@strands-agents/sdk';
import { lanePartitionKey, type EventRecord, type RecordKey } from '@fothering/core/records';
import type { AddressKeySet } from '@fothering/core/address';
import type { LaneFold } from '@fothering/core/window-fold';

export interface EventStorePort {
  putIfAbsent(record: EventRecord): Promise<'written' | 'duplicate'>;
  queryLane(
    configurationSet: string,
    fromBucketMs: number,
    toBucketMs: number,
    nowMs: number,
  ): Promise<EventRecord[]>;
  queryByRecipient(recipientHmac: string): Promise<RecordKey[]>;
  /** Resolves true when a record was removed, false when none was stored under that key. */
  deleteRecord(key: RecordKey): Promise<boolean>;
  getRecord(key: RecordKey): Promise<EventRecord | undefined>;
  /** Reads one lane window page by page into a fold and returns only the fold's final state (D-43). */
  foldLane<S>(configurationSet: string, fromBucketMs: number, toBucketMs: number, nowMs: number, fold: LaneFold<S>): Promise<S>;
}

/** An incident, evidence, decision or counter item: never under a LANE# partition key (D-65). */
export interface DecisionStoreItem {
  pk: string;
  sk: string;
  expiresAt: number;
  [attribute: string]: unknown;
}

/**
 * One invocation's claim on the incident counter and the UTC-day counter (D-67). The caps and the
 * token reservation are computed by the caller; the store enforces exactly what it is given.
 */
export interface ReservationRequest {
  incidentKey: RecordKey;
  dayKey: RecordKey;
  incidentCap: number;
  dayInvocationCap: number;
  dayTokenCap: number;
  tokenReservation: number;
  /** Written on a counter's first reservation and kept after, so a day counter is never extended into a reset. */
  expiresAt: number;
}

export type ReservationItem = 'incident' | 'day';

/** A cap refusal names every counter whose condition failed; a conflict is two writers racing, and retryable. */
export type ReservationResult =
  | { ok: true }
  | { ok: false; reason: 'cap'; items: ReservationItem[] }
  | { ok: false; reason: 'conflict' };

/** Reporting totals added to both counters after an invocation; no cap reads them (D-67, D-68). */
export interface UsageRecord {
  incidentKey: RecordKey;
  dayKey: RecordKey;
  inputTokens: number;
  outputTokens: number;
  modelCalls: number;
}

/** No operation here deletes an item or lowers a counter: the caps hold only if nothing can (AC-P6). */
export interface DecisionStorePort {
  putIfAbsent(item: DecisionStoreItem): Promise<'written' | 'duplicate'>;
  /** Answers undefined for an item whose expiresAt has passed, since GetItem applies no TTL filter. */
  getItem(key: RecordKey, nowMs: number): Promise<DecisionStoreItem | undefined>;
  /** Sets the attributes, version + 1 and a fresh 30-day expiresAt, only while the stored version is expectedVersion. */
  updateIfVersion(
    key: RecordKey,
    expectedVersion: number,
    attributes: Readonly<Record<string, unknown>>,
    nowMs: number,
  ): Promise<'updated' | 'conflict'>;
  /** Adds one invocation to both counters and the token reservation to the day, all or nothing. */
  reserveInvocation(request: ReservationRequest): Promise<ReservationResult>;
  recordUsage(usage: UsageRecord): Promise<void>;
}

const LANE_PARTITION_PREFIX = lanePartitionKey('');
const INCIDENT_PARTITION_PREFIX = 'INCIDENT#';
const COUNTER_DAY_PARTITION_PREFIX = 'COUNTER_DAY#';
const COUNTER_SORT_KEY = 'COUNTER';
/** The attributes updateIfVersion writes itself; a caller naming one would fight the version check or the key. */
const MANAGED_ATTRIBUTES: ReadonlySet<string> = new Set(['pk', 'sk', 'version', 'expiresAt']);

function requireWholeNumber(name: string, value: number, minimum: number): void {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new RangeError(`${name} must be a whole number from ${minimum} up`);
  }
}

// The fixture and the live adapter both run these checks before anything is sent or stored, so the
// two can never disagree about which request reaches the table.

/**
 * A decision item never sits under an event record's LANE# key (D-65), and a counter moves only
 * through reserveInvocation and recordUsage, which only add: a put or a versioned update could
 * otherwise write one back to zero.
 */
export function assertDecisionItemKey(key: RecordKey): void {
  if (key.pk.startsWith(LANE_PARTITION_PREFIX)) {
    throw new RangeError('a decision store item never takes a LANE# partition key, which belongs to event records');
  }
  if (key.sk === COUNTER_SORT_KEY) {
    throw new RangeError('a counter item changes only through reserveInvocation and recordUsage, which only add');
  }
}

export function isDecisionStoreItem(item: unknown): item is DecisionStoreItem {
  if (typeof item !== 'object' || item === null) return false;
  const { pk, sk, expiresAt } = item as { pk?: unknown; sk?: unknown; expiresAt?: unknown };
  return typeof pk === 'string' && !pk.startsWith(LANE_PARTITION_PREFIX) && typeof sk === 'string' && typeof expiresAt === 'number';
}

/** GetItem applies no TTL filter, so an item past its expiresAt but not yet deleted reads as absent (Pitfall 4). */
export function unexpiredDecisionItem(item: unknown, nowMs: number): DecisionStoreItem | undefined {
  return isDecisionStoreItem(item) && item.expiresAt > Math.floor(nowMs / 1000) ? item : undefined;
}

function assertCounterKeys(incidentKey: RecordKey, dayKey: RecordKey): void {
  if (!incidentKey.pk.startsWith(INCIDENT_PARTITION_PREFIX) || incidentKey.sk !== COUNTER_SORT_KEY) {
    throw new RangeError('incidentKey must be an incident COUNTER key');
  }
  if (!dayKey.pk.startsWith(COUNTER_DAY_PARTITION_PREFIX) || dayKey.sk !== COUNTER_SORT_KEY) {
    throw new RangeError('dayKey must be a COUNTER_DAY key');
  }
}

export function assertVersionedUpdate(key: RecordKey, expectedVersion: number, attributes: Readonly<Record<string, unknown>>): void {
  assertDecisionItemKey(key);
  requireWholeNumber('expectedVersion', expectedVersion, 0);
  for (const name of Object.keys(attributes)) {
    if (MANAGED_ATTRIBUTES.has(name)) throw new RangeError(`updateIfVersion writes ${name} itself, so it is not an attribute to pass`);
  }
}

export function assertReservation(request: ReservationRequest): void {
  assertCounterKeys(request.incidentKey, request.dayKey);
  requireWholeNumber('incidentCap', request.incidentCap, 1);
  requireWholeNumber('dayInvocationCap', request.dayInvocationCap, 1);
  requireWholeNumber('dayTokenCap', request.dayTokenCap, 0);
  requireWholeNumber('tokenReservation', request.tokenReservation, 0);
  requireWholeNumber('expiresAt', request.expiresAt, 0);
  // The day condition accepts a missing counter, so a reservation larger than the whole day cap would
  // pass on the first call of a day and leave the counter over its cap.
  if (request.tokenReservation > request.dayTokenCap) throw new RangeError('tokenReservation is larger than dayTokenCap');
}

export function assertUsage(usage: UsageRecord): void {
  assertCounterKeys(usage.incidentKey, usage.dayKey);
  requireWholeNumber('inputTokens', usage.inputTokens, 0);
  requireWholeNumber('outputTokens', usage.outputTokens, 0);
  requireWholeNumber('modelCalls', usage.modelCalls, 0);
}

/** One fixture table that the event store and the decision store share, as the live table is shared. */
export interface FixtureTableState {
  items: Map<string, unknown>;
}

export interface AddressKeyPort {
  getKeySet(): Promise<AddressKeySet>;
}

export interface DeadLetterPort {
  send(records: readonly EventRecord[]): Promise<void>;
}

/** One canned answer: the operation, the exact request it answers and the response it returns. */
export interface Recording {
  readonly operation: string;
  readonly request: unknown;
  readonly response: unknown;
}

/** Fixture-only failure injection and canned answers (D-26); no live adapter reads these options. */
export interface FixtureOptions {
  eventStoreFailure?: 'put';
  deadLetterFailure?: 'send';
  /** A call with no matching recording throws instead of answering, so a test cannot pass on an invented reply. */
  recordings?: Partial<Record<'ses' | 'agentCore' | 'replyBucket', readonly Recording[]>>;
  /** The scripted model the bedrockModel row streams from in 'test'; without one every call misses. */
  model?: BedrockModelPort;
  /** An in-process runtime handler the agentCore row hands each payload to in 'test', in place of a recording (D-80). */
  agentRuntime?: (payload: unknown) => Promise<unknown>;
  /** Records per page a fixture lane fold delivers; DynamoDB's own page is up to 1 MB. */
  pageSize?: number;
  store?: FixtureTableState;
  /** The next N reservations cancel as a transaction conflict and change nothing, so a test can show the retry. */
  transactionConflicts?: number;
}

// The composition-root contracts (D-05, D-06): a runtimeContext picks fixture over live wholesale,
// a switch value picks live over dry-run per mutating operation, and a row with no live adapter yet
// throws a named NotBuiltError instead of silently falling back to something weaker (T-01-03).

export type RuntimeContext = 'test' | 'deployed';

/** `not-built-until-phase-N` is a template literal, not a fixed list: any later phase number fits. */
export type ResolvedKind = 'fixture' | 'live' | 'dry-run' | `not-built-until-phase-${number}`;

/** Port name to operation name to its resolved kind for this one composition-root build. */
export type KindTable = Readonly<Record<string, Readonly<Record<string, ResolvedKind>>>>;

/**
 * Each key holds one of three shapes: an already-built SDK client, a zero-argument factory that
 * returns one, or nothing (the adapter constructs its own client, lazily, on first use). Tests
 * pass a counting factory here to prove a client is built once and only when a port method runs.
 */
export type LiveClients = Partial<Record<'dynamoDb' | 'secretsManager' | 'sqs' | 'sesv2' | 'bedrockAgentCore', unknown>>;

export interface LiveConfig {
  tableName?: string;
  deadLetterQueueUrl?: string;
  addressKeySecretId?: string;
  /** The runtime detection invokes; the detection root reads it and puts it in each invocation request. */
  agentRuntimeArn?: string;
}

/** A dry-run recorder never resolves to a device; it only ever writes one line naming what it would have sent. */
export type DryRunSink = (line: string) => void;

export class NotBuiltError extends Error {
  readonly phase: number;

  constructor(phase: number) {
    super(`not built until phase ${phase}`);
    this.name = 'NotBuiltError';
    this.phase = phase;
  }
}

/** A live adapter throws this from the operation it blocks, never from resolution, naming the
 * exact environment variable a deploy left unset (T-01-03's sibling for configuration, not code). */
export class LiveConfigMissingError extends Error {
  readonly envVar: string;

  constructor(envVar: string) {
    super(`missing required live configuration: ${envVar}`);
    this.name = 'LiveConfigMissingError';
    this.envVar = envVar;
  }
}

/** The one missing-value check every live adapter shares: an empty string, or one of spaces only, is
 * as unset as undefined, since a name of nothing would otherwise reach AWS and fail there without
 * naming the variable. */
export function requireLiveConfig(value: string | undefined, envVar: string): string {
  if (value === undefined || value.trim() === '') throw new LiveConfigMissingError(envVar);
  return value;
}

/** One event destination of a configuration set, reduced to what the closeability check reads. */
export interface EventDestinationFact {
  name: string;
  enabled: boolean;
  eventBridge: boolean;
  matchingEventTypes: readonly string[];
}

/** The four SESv2 reads the closeability check needs. */
export interface SesReadPort {
  /** The default configuration set the identity sends through when none is set on the call itself. */
  getEmailIdentity(emailIdentity: string): Promise<string | undefined>;
  listEmailIdentities(): Promise<string[]>;
  /** Every configuration set SES holds in the Region, so the check can see one lanes.json leaves out. */
  listConfigurationSets(): Promise<string[]>;
  getConfigurationSetEventDestinations(configurationSetName: string): Promise<EventDestinationFact[]>;
}

export interface SendEmailRequest {
  from: string;
  to: string[];
  subject: string;
  text: string;
  configurationSetName?: string;
}

/** The reads above plus the three operations that change what SES does, all gated by the live switch. */
export interface SesPort extends SesReadPort {
  pauseConfigurationSet(configurationSet: string): Promise<void>;
  reopenConfigurationSet(configurationSet: string): Promise<void>;
  sendEmail(request: SendEmailRequest): Promise<{ messageId: string }>;
}

/** The SDK's own Model.stream contract (D-71), so whatever the row resolves to can sit behind a Strands Model. */
export interface BedrockModelPort {
  stream(messages: Message[], options?: StreamOptions): AsyncIterable<ModelStreamEvent>;
}

export interface AgentRuntimeRequest {
  runtimeArn: string;
  sessionId: string;
  payload: unknown;
  abortSignal?: AbortSignal;
}

export interface AgentCorePort {
  invokeAgentRuntime(request: AgentRuntimeRequest): Promise<unknown>;
}

export interface ReplyBucketPort {
  getReplyObject(key: string): Promise<Uint8Array>;
}

const KIND_BRAND = Symbol('fothering.portKind');

/**
 * Stamps what an implementation is (fixture, live, dry-run recorder, not-built stub) on the object
 * itself, out of enumeration so a spread copy in a test double drops the stamp instead of carrying
 * a stale one. resolvePortTable reports each operation's kind from this stamp, never from the
 * table slot the implementation was found in (T-01-10).
 */
export function brandPort<T extends object>(port: T, kind: ResolvedKind): T {
  Object.defineProperty(port, KIND_BRAND, { value: kind, enumerable: false, configurable: true });
  return port;
}

export function kindOf(port: unknown): ResolvedKind | undefined {
  if (typeof port !== 'object' || port === null) return undefined;
  return (port as { [KIND_BRAND]?: ResolvedKind })[KIND_BRAND];
}
