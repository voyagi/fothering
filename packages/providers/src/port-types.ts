import type { EventRecord, RecordKey } from '@fothering/core/records';
import type { AddressKeySet } from '@fothering/core/address';

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
  recordings?: Partial<Record<'ses' | 'bedrockModel' | 'agentCore' | 'replyBucket', readonly Recording[]>>;
}

// The composition-root contracts (D-05, D-06): a runtimeContext picks fixture over live wholesale,
// a switch value picks live over dry-run per mutating operation, and a row with no live adapter yet
// throws a named NotBuiltError instead of silently falling back to something weaker (T-01-03).

export type RuntimeContext = 'test' | 'deployed';

/** `not-built-until-phase-N` is a template literal, not a fixed list: any later phase number fits. */
export type ResolvedKind = 'fixture' | 'live' | 'dry-run' | `not-built-until-phase-${number}`;

/** Port name to operation name to its resolved kind for this one composition-root build. */
export type KindTable = Readonly<Record<string, Readonly<Record<string, ResolvedKind>>>>;

/** The shape every AWS SDK v3 client shares; a live adapter wraps one of these, never the raw client type. */
export interface SendClient {
  send(command: unknown): Promise<unknown>;
}

/**
 * Each key holds one of three shapes: an already-built SDK client, a zero-argument factory that
 * returns one, or nothing (the adapter constructs its own client, lazily, on first use). Tests
 * pass a counting factory here to prove a client is built once and only when a port method runs.
 */
export type LiveClients = Partial<Record<'dynamoDb' | 'secretsManager' | 'sqs' | 'sesv2', unknown>>;

export interface LiveConfig {
  tableName?: string;
  deadLetterQueueUrl?: string;
  addressKeySecretId?: string;
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

/** The three SESv2 reads the closeability check needs. */
export interface SesReadPort {
  /** The default configuration set the identity sends through when none is set on the call itself. */
  getEmailIdentity(emailIdentity: string): Promise<string | undefined>;
  listEmailIdentities(): Promise<string[]>;
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

export interface BedrockModelPort {
  converse(request: { modelId: string; prompt: string }): Promise<{ text: string }>;
}

export interface AgentCorePort {
  invokeAgentRuntime(request: { runtimeArn: string; sessionId: string; payload: unknown }): Promise<unknown>;
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
