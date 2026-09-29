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
  'default-configuration-set',
  'destination-missing-event-types',
  'operator-alert',
  'transactional',
] as const;
export type RefusalReason = (typeof REFUSAL_REASONS)[number];

// Not exported: a value typed with this key can only come from a cast written in this module, so
// checkCloseability is the one place a lane becomes closeable.
declare const closeableBrand: unique symbol;
export type CloseableLane = LaneEntry & { readonly [closeableBrand]: true };

/** Declared structurally so the providers package's destination facts fit without core importing from it. */
export interface SesConfigurationFacts {
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

interface Tally {
  recordCount: number;
  streamTagValues: Set<string>;
  recordsWithoutValidStream: number;
  callerIdentities: Set<string>;
  recordsWithoutCaller: number;
  completeSends: number;
  completeOutcomes: number;
}

function emptyTally(): Tally {
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
function usable(value: string | undefined): value is string {
  return value !== undefined && value !== '' && value !== UNCLASSIFIED;
}

function addRecord(tally: Tally, record: EventRecord, nowMs: number): void {
  tally.recordCount += 1;

  const stream = record.fields.streamTagValue;
  if (usable(stream)) tally.streamTagValues.add(stream);
  else tally.recordsWithoutValidStream += 1;

  const caller = record.fields.callerIdentity;
  if (usable(caller)) tally.callerIdentities.add(caller);
  else tally.recordsWithoutCaller += 1;

  if (!isBucketComplete(record.bucketStartMs, nowMs)) return;
  if (record.kind === 'send') tally.completeSends += 1;
  else if (record.kind === 'outcome') tally.completeOutcomes += 1;
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
 * shares with a listed set is never seen here.
 */
export function observeLanes(
  records: readonly EventRecord[],
  options: ObserveLanesOptions,
): ReadonlyMap<string, ObservedLaneFacts> {
  assertFiniteTimes(options);
  const firstBucketMs = bucketStartMs(options.windowStartMs);
  const tallies = new Map<string, Tally>(options.laneMap.lanes.map((lane) => [lane.configurationSet, emptyTally()]));

  for (const record of records) {
    if (!isCountedRecord(record) || record.bucketStartMs < firstBucketMs) continue;
    let tally = tallies.get(record.configurationSet);
    if (tally === undefined) {
      tally = emptyTally();
      tallies.set(record.configurationSet, tally);
    }
    addRecord(tally, record, options.nowMs);
  }

  return new Map(
    [...tallies].map(([configurationSet, tally]) => [
      configurationSet,
      {
        recordCount: tally.recordCount,
        streamTagValues: tally.streamTagValues,
        recordsWithoutValidStream: tally.recordsWithoutValidStream,
        callerIdentities: tally.callerIdentities,
        recordsWithoutCaller: tally.recordsWithoutCaller,
        completeBucketsHoldSendsWithoutOutcomes: tally.completeSends > 0 && tally.completeOutcomes === 0,
      },
    ]),
  );
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

function refusalReasons(lane: LaneEntry, own: ObservedLaneFacts, options: CheckCloseabilityOptions): RefusalReason[] {
  const applies: Record<RefusalReason, boolean> = {
    'multiple-declared-streams': lane.declaredStreams.length > 1,
    'observed-second-stream': own.streamTagValues.size > 1,
    'observed-stream-undeclared': [...own.streamTagValues].some((stream) => !lane.declaredStreams.includes(stream)),
    'stream-tag-missing': own.recordsWithoutValidStream > 0,
    'caller-unknown': own.recordsWithoutCaller > 0,
    'caller-on-another-set': sharesCallerWithAnotherSet(lane.configurationSet, options.observed, own),
    'default-configuration-set': options.ses.defaultConfigurationSets.has(lane.configurationSet),
    'destination-missing-event-types': !eventBridgePublishesEveryType(lane.configurationSet, options.ses),
    'operator-alert': lane.operatorAlert,
    transactional: lane.criticality === 'transactional',
  };
  return REFUSAL_REASONS.filter((reason) => applies[reason]);
}

/**
 * The only producer of CloseableLane. A set is closeable when the lane map, the observed events and
 * the SES configuration all agree it is one isolated bulk stream with data; what the events show
 * overrides what the lane map declares, never the other way round.
 */
export function checkCloseability(configurationSet: string, options: CheckCloseabilityOptions): CloseabilityResult {
  const lane = findLane(options.laneMap, configurationSet);
  if (lane === undefined) {
    throw new RangeError(
      `configuration set ${configurationSet} is not in the lane map, so its closeability cannot be judged; add it to lanes.json or ask about a listed set`,
    );
  }

  const own = options.observed.get(configurationSet);
  if (own === undefined || own.recordCount === 0 || own.completeBucketsHoldSendsWithoutOutcomes) {
    return { state: 'no-data' };
  }

  const reasons = refusalReasons(lane, own, options);
  if (reasons.length > 0) return { state: 'refused', reasons };
  return { state: 'closeable', lane: { ...lane } as CloseableLane };
}
