import { bucketStartMs, isBucketComplete, isCountedRecord } from './buckets.js';
import { findLane, type LaneEntry, type LaneMap } from './lanes.js';
import { UNCLASSIFIED, type EventRecord } from './records.js';

// SES event types a set's enabled EventBridge destinations must publish, between them, before
// Fothering reads a lane's health from it. A set may hold several event destinations (SES guide,
// "Creating Amazon SES event destinations"), and every EventBridge destination publishes to the
// default bus the ingest rule reads, so two that split the six types between them miss nothing.
export const REQUIRED_EVENT_TYPES = ['SEND', 'REJECT', 'BOUNCE', 'COMPLAINT', 'DELIVERY', 'DELIVERY_DELAY'] as const;

// The order a result lists its reasons in.
export const REFUSAL_REASONS = [
  'multiple-declared-streams',
  'observed-second-stream',
  'observed-stream-undeclared',
  'stream-tag-missing',
  'caller-unknown',
  'caller-on-another-set',
  'unlisted-configuration-set',
  'default-configuration-set',
  'destination-missing-event-types',
  'operator-alert',
  'transactional',
] as const;
export type RefusalReason = (typeof REFUSAL_REASONS)[number];

// D-102: the configuration half of the table, split in two. The lane-map half reads the lane entry
// alone, so IAM at synth and the action at run time judge it the same way (D-104); the SES half reads
// the configuration facts, which an operator can change between detection and action.
export const LANE_MAP_REFUSALS = ['multiple-declared-streams', 'operator-alert', 'transactional'] as const satisfies readonly RefusalReason[];
export const SES_CONFIGURATION_REFUSALS = [
  'unlisted-configuration-set',
  'default-configuration-set',
  'destination-missing-event-types',
] as const satisfies readonly RefusalReason[];
type LaneMapRefusal = (typeof LANE_MAP_REFUSALS)[number];
type SesConfigurationRefusal = (typeof SES_CONFIGURATION_REFUSALS)[number];
export type ConfigurationRefusal = LaneMapRefusal | SesConfigurationRefusal;
type ObservedRefusal = Exclude<RefusalReason, ConfigurationRefusal>;

// Not exported: a value typed with this key can only come from a cast written in this module, so
// checkCloseability is the one place a lane becomes closeable.
declare const closeableBrand: unique symbol;
export type CloseableLane = LaneEntry & { readonly [closeableBrand]: true };

/** Declared structurally so the providers package's destination facts fit without core importing from it. */
export interface SesConfigurationFacts {
  /** Every configuration set SES holds in the Region, listed in lanes.json or not. */
  configurationSets: ReadonlySet<string>;
  defaultConfigurationSets: ReadonlySet<string>;
  eventDestinations: ReadonlyMap<
    string,
    readonly { enabled: boolean; eventBridge: boolean; matchingEventTypes: readonly string[] }[]
  >;
}

export interface ObservedLaneFacts {
  recordCount: number;
  /** Valid stream-tag values only; a record with a missing or unclassified value counts in recordsWithoutValidStream. */
  streamTagValues: ReadonlySet<string>;
  recordsWithoutValidStream: number;
  callerIdentities: ReadonlySet<string>;
  recordsWithoutCaller: number;
  completeBucketsHoldSendsWithoutOutcomes: boolean;
}

export type CloseabilityResult =
  | { state: 'no-data' }
  | { state: 'refused'; reasons: readonly RefusalReason[] }
  | { state: 'closeable'; lane: CloseableLane };

export interface ObserveLanesOptions {
  laneMap: LaneMap;
  windowStartMs: number;
  nowMs: number;
}

/** What one lane's records have shown so far; a fold over pages feeds it one record at a time (D-47). */
export interface ObserveTally {
  recordCount: number;
  streamTagValues: Set<string>;
  recordsWithoutValidStream: number;
  callerIdentities: Set<string>;
  recordsWithoutCaller: number;
  completeSends: number;
  completeOutcomes: number;
}

export function createObserveTally(): ObserveTally {
  return {
    recordCount: 0,
    streamTagValues: new Set(),
    recordsWithoutValidStream: 0,
    callerIdentities: new Set(),
    recordsWithoutCaller: 0,
    completeSends: 0,
    completeOutcomes: 0,
  };
}

// The minimizer writes UNCLASSIFIED for a caller identity it could not validate and leaves a
// stream tag it could not validate out, so either of those, or an empty string, is no evidence. A
// stream tag an operator set to the literal word unclassified counts as missing too, and the lane
// map refuses that word as a declared stream so no lane can depend on it.
export function isUsableValue(value: string | undefined): value is string {
  return value !== undefined && value !== '' && value !== UNCLASSIFIED;
}

/** The caller filters: only a counted record inside the window it reads belongs here. */
export function observeRecord(tally: ObserveTally, record: EventRecord, nowMs: number): void {
  tally.recordCount += 1;

  const stream = record.fields.streamTagValue;
  if (isUsableValue(stream)) tally.streamTagValues.add(stream);
  else tally.recordsWithoutValidStream += 1;

  const caller = record.fields.callerIdentity;
  if (isUsableValue(caller)) tally.callerIdentities.add(caller);
  else tally.recordsWithoutCaller += 1;

  if (!isBucketComplete(record.bucketStartMs, nowMs)) return;
  if (record.kind === 'send') tally.completeSends += 1;
  else if (record.kind === 'outcome') tally.completeOutcomes += 1;
}

export function mergeObserveTallies(a: ObserveTally, b: ObserveTally): ObserveTally {
  return {
    recordCount: a.recordCount + b.recordCount,
    streamTagValues: new Set([...a.streamTagValues, ...b.streamTagValues]),
    recordsWithoutValidStream: a.recordsWithoutValidStream + b.recordsWithoutValidStream,
    callerIdentities: new Set([...a.callerIdentities, ...b.callerIdentities]),
    recordsWithoutCaller: a.recordsWithoutCaller + b.recordsWithoutCaller,
    completeSends: a.completeSends + b.completeSends,
    completeOutcomes: a.completeOutcomes + b.completeOutcomes,
  };
}

export function observedFactsOf(tally: ObserveTally): ObservedLaneFacts {
  return {
    recordCount: tally.recordCount,
    streamTagValues: new Set(tally.streamTagValues),
    recordsWithoutValidStream: tally.recordsWithoutValidStream,
    callerIdentities: new Set(tally.callerIdentities),
    recordsWithoutCaller: tally.recordsWithoutCaller,
    completeBucketsHoldSendsWithoutOutcomes: tally.completeSends > 0 && tally.completeOutcomes === 0,
  };
}

// A NaN now reads every bucket as still open, so a lane of sends with no outcome would pass as
// data instead of NO DATA, and a NaN window start compares false and drops the lower edge.
function assertFiniteTimes(options: ObserveLanesOptions): void {
  for (const [name, value] of [['windowStartMs', options.windowStartMs], ['nowMs', options.nowMs]] as const) {
    if (!Number.isFinite(value)) {
      throw new RangeError(`${name} ${String(value)} is not a finite number of epoch milliseconds, so no window can be read from it`);
    }
  }
}

/**
 * Reads what a snapshot of stored events shows per configuration set. The window has no upper
 * edge: a record in a bucket after nowMs (a sender's clock ahead of ours) still counts, since
 * dropping it could hide a second stream. Every lane-map set gets an entry, records or not, and a
 * set seen only in the records is included too, because its callers matter to the sets that share
 * them. Such a set is one taken out of lanes.json whose stored records have not expired yet: a set
 * never listed stores nothing (the ingest rule and ingestEvent drop its events), so a caller it
 * shares with a listed set is never seen here, and checkCloseability refuses every lane while SES
 * holds such a set.
 */
export function observeLanes(
  records: readonly EventRecord[],
  options: ObserveLanesOptions,
): ReadonlyMap<string, ObservedLaneFacts> {
  assertFiniteTimes(options);
  const firstBucketMs = bucketStartMs(options.windowStartMs);
  const tallies = new Map<string, ObserveTally>(
    options.laneMap.lanes.map((lane) => [lane.configurationSet, createObserveTally()]),
  );

  for (const record of records) {
    if (!isCountedRecord(record) || record.bucketStartMs < firstBucketMs) continue;
    let tally = tallies.get(record.configurationSet);
    if (tally === undefined) {
      tally = createObserveTally();
      tallies.set(record.configurationSet, tally);
    }
    observeRecord(tally, record, options.nowMs);
  }

  return new Map([...tallies].map(([configurationSet, tally]) => [configurationSet, observedFactsOf(tally)]));
}

export interface CheckCloseabilityOptions {
  laneMap: LaneMap;
  observed: ReadonlyMap<string, ObservedLaneFacts>;
  ses: SesConfigurationFacts;
}

function sharesCallerWithAnotherSet(
  configurationSet: string,
  observed: ReadonlyMap<string, ObservedLaneFacts>,
  own: ObservedLaneFacts,
): boolean {
  for (const [otherSet, other] of observed) {
    if (otherSet === configurationSet) continue;
    for (const caller of own.callerIdentities) {
      if (other.callerIdentities.has(caller)) return true;
    }
  }
  return false;
}

// Events from a set lanes.json does not list are dropped before storage, so caller-on-another-set
// cannot see a caller that also sends through it. While SES holds such a set the check cannot tell
// a lane's caller is its own, so it refuses instead of assuming the unlisted set is idle.
function sesHoldsUnlistedSet(ses: SesConfigurationFacts, laneMap: LaneMap): boolean {
  for (const configurationSet of ses.configurationSets) {
    if (findLane(laneMap, configurationSet) === undefined) return true;
  }
  return false;
}

// A disabled destination publishes nothing, and a destination of another kind (SNS, Firehose,
// CloudWatch) never reaches the bus, so only enabled EventBridge destinations add to the union.
function eventBridgePublishesEveryType(configurationSet: string, ses: SesConfigurationFacts): boolean {
  const published = new Set<string>();
  for (const destination of ses.eventDestinations.get(configurationSet) ?? []) {
    if (!destination.enabled || !destination.eventBridge) continue;
    for (const type of destination.matchingEventTypes) published.add(type);
  }
  return REQUIRED_EVENT_TYPES.every((type) => published.has(type));
}

function laneMapRefusals(lane: LaneEntry): Record<LaneMapRefusal, boolean> {
  return {
    'multiple-declared-streams': lane.declaredStreams.length > 1,
    'operator-alert': lane.operatorAlert,
    transactional: lane.criticality === 'transactional',
  };
}

function sesConfigurationRefusals(lane: LaneEntry, ses: SesConfigurationFacts, laneMap: LaneMap): Record<SesConfigurationRefusal, boolean> {
  return {
    'unlisted-configuration-set': sesHoldsUnlistedSet(ses, laneMap),
    'default-configuration-set': ses.defaultConfigurationSets.has(lane.configurationSet),
    'destination-missing-event-types': !eventBridgePublishesEveryType(lane.configurationSet, ses),
  };
}

function observedRefusals(lane: LaneEntry, own: ObservedLaneFacts, observed: ReadonlyMap<string, ObservedLaneFacts>): Record<ObservedRefusal, boolean> {
  return {
    'observed-second-stream': own.streamTagValues.size > 1,
    'observed-stream-undeclared': [...own.streamTagValues].some((stream) => !lane.declaredStreams.includes(stream)),
    'stream-tag-missing': own.recordsWithoutValidStream > 0,
    'caller-unknown': own.recordsWithoutCaller > 0,
    'caller-on-another-set': sharesCallerWithAnotherSet(lane.configurationSet, observed, own),
  };
}

function inRefusalOrder<T extends RefusalReason>(applies: Readonly<Partial<Record<T, boolean>>>): T[] {
  return REFUSAL_REASONS.filter((reason): reason is T => applies[reason as T] === true);
}

function refusalReasons(lane: LaneEntry, own: ObservedLaneFacts, options: CheckCloseabilityOptions): RefusalReason[] {
  return inRefusalOrder<RefusalReason>({
    ...observedRefusals(lane, own, options.observed),
    ...sesConfigurationRefusals(lane, options.ses, options.laneMap),
    ...laneMapRefusals(lane),
  });
}

/** D-104: what IAM may grant the pause on at synth, from the lane map alone (today fothering-bulk). */
export function isStaticallyCloseable(lane: LaneEntry): boolean {
  return inRefusalOrder(laneMapRefusals(lane)).length === 0;
}

function laneOrThrow(laneMap: LaneMap, configurationSet: string): LaneEntry {
  const lane = findLane(laneMap, configurationSet);
  if (lane === undefined) {
    throw new RangeError(
      `configuration set ${configurationSet} is not in the lane map, so its closeability cannot be judged; add it to lanes.json or ask about a listed set`,
    );
  }
  return lane;
}

export interface ConfigurationRefusalsOptions {
  laneMap: LaneMap;
  /** undefined when the facts were not read, which leaves the lane-map refusals alone. */
  ses: SesConfigurationFacts | undefined;
}

/**
 * D-102 and CH-06: the refusals that need no observed event, in REFUSAL_REASONS order. It skips the
 * NO DATA early return on purpose, so a quiet transactional lane still shows transactional; it never
 * makes a lane closeable, which stays checkCloseability's alone.
 */
export function configurationRefusals(configurationSet: string, options: ConfigurationRefusalsOptions): ConfigurationRefusal[] {
  const lane = laneOrThrow(options.laneMap, configurationSet);
  return inRefusalOrder<ConfigurationRefusal>({
    ...(options.ses === undefined ? {} : sesConfigurationRefusals(lane, options.ses, options.laneMap)),
    ...laneMapRefusals(lane),
  });
}

/**
 * The only producer of CloseableLane. A set is closeable when the lane map, the observed events and
 * the SES configuration all agree it is one isolated bulk stream with data; what the events show
 * overrides what the lane map declares, never the other way round.
 */
export function checkCloseability(configurationSet: string, options: CheckCloseabilityOptions): CloseabilityResult {
  const lane = laneOrThrow(options.laneMap, configurationSet);

  // Records in buckets still open count as data. A bucket completes only LATENESS_HORIZON_MS after
  // it ends, so requiring a complete one would keep every lane NO DATA that long after its first
  // send and stop any shorter incident window from ever closing a lane. Outcomes are judged across
  // the complete buckets together, not bucket by bucket, because SES delivers events to
  // EventBridge best effort: one event lost in a quiet bucket must not turn a working lane to NO DATA.
  const own = options.observed.get(configurationSet);
  if (own === undefined || own.recordCount === 0 || own.completeBucketsHoldSendsWithoutOutcomes) {
    return { state: 'no-data' };
  }

  const reasons = refusalReasons(lane, own, options);
  if (reasons.length > 0) return { state: 'refused', reasons };
  return { state: 'closeable', lane: { ...lane } as CloseableLane };
}
