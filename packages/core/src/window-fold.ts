import {
  BUCKET_MS,
  LATENESS_HORIZON_MS,
  applyRecord,
  assertBucketBounds,
  bounceClass,
  bucketStartMs,
  complaintClass,
  emptyBucket,
  isCountedRecord,
  type BucketCount,
} from './buckets.js';
import {
  createObserveTally,
  isUsableValue,
  observeRecord,
  observedFactsOf,
  type ObserveTally,
  type ObservedLaneFacts,
} from './closeability.js';
import type { EventFields, EventRecord } from './records.js';

// D-44: a 5-minute cycle sees a burst of a few minutes, and one hour holds enough of a small team's
// bulk send to reach the minimum volume while older healthy traffic dilutes a fresh spike little.
export const SPIKE_WINDOW_BUCKETS = 12;
// D-44: the coverage window ends with the newest complete bucket, because the spike window is younger
// than BUCKET_MS + LATENESS_HORIZON_MS and so never holds a complete bucket to judge.
export const COVERAGE_WINDOW_BUCKETS = 12;
// D-44: 24 hours, above every window this phase reads, so a computed window that grows by mistake is
// refused by name before any read (AC-E1).
export const MAX_WINDOW_BUCKETS = 288;
// D-46: CH-04's memory bound must hold even when a sender puts a unique value in every tag; past it
// the lane decides unknown (dimension-bound), never on a partial table.
export const MAX_TRACKED_VALUES = 1_000;
// Every complaint takes an entry, not every distinct value, so this cap is ten times the value cap:
// at the 1/1000 complaint threshold, 10,000 complaints is a window of ten million recipient-sends.
export const MAX_TRACKED_COMPLAINTS = 10_000;

export interface BucketWindow {
  fromBucketMs: number;
  toBucketMs: number;
}

export function spikeWindowFor(nowMs: number): BucketWindow {
  const toBucketMs = bucketStartMs(nowMs);
  return { fromBucketMs: toBucketMs - (SPIKE_WINDOW_BUCKETS - 1) * BUCKET_MS, toBucketMs };
}

export class WindowTooLongError extends RangeError {
  constructor(bucketCount: number) {
    super(`a window of ${bucketCount} buckets is longer than the maximum of ${MAX_WINDOW_BUCKETS} buckets a fold reads`);
    this.name = 'WindowTooLongError';
  }
}

export function assertFoldWindow(fromBucketMs: number, toBucketMs: number): void {
  assertBucketBounds(fromBucketMs, toBucketMs);
  const bucketCount = (toBucketMs - fromBucketMs) / BUCKET_MS + 1;
  if (bucketCount > MAX_WINDOW_BUCKETS) throw new WindowTooLongError(bucketCount);
}

/** A reducer over pages; the reader returns only its final state, never the records it read (D-43). */
export interface LaneFold<S> {
  initial: S;
  step(state: S, page: readonly EventRecord[]): S;
}

export const DIMENSIONS = ['batch', 'template', 'campaign', 'receivingDomain', 'fromDomain'] as const;
export type Dimension = (typeof DIMENSIONS)[number];

export interface DimensionTally {
  sends: number;
  permanentBounces: number;
  complaints: number;
}

// RFC 7372 authentication details (rfc-editor.org/rfc/rfc7372.txt, verified 2026-10-12): X.7.20 No
// passing DKIM signature found, X.7.21 No acceptable DKIM signature found, X.7.22 No valid
// author-matched DKIM signature found, X.7.23 SPF validation failed, X.7.24 SPF validation error,
// X.7.26 Multiple authentication checks failed. X.7.25 (reverse DNS) never corroborates: it concerns
// the sending IP, which SES owns, not the sender's records. No other X.7 code does either, because
// class X.7 also carries spam and reputation blocks such as 550 5.7.1 (D-61 as amended 2026-10-12).
export const AUTH_CORROBORATION_CODES = {
  dkim: [20, 21, 22, 26],
  'mail-from': [23, 24, 26],
  dmarc: [22, 26],
  spf: [23, 24, 26],
} as const;
export type ConfigurationRecord = keyof typeof AUTH_CORROBORATION_CODES;
export type AuthDetail = (typeof AUTH_CORROBORATION_CODES)[ConfigurationRecord][number];
export type AuthCodeTally = Record<AuthDetail, number>;

interface ComplaintAttribution {
  counted: boolean;
  domain: string | undefined;
  spansDomains: boolean;
}

interface BucketTally {
  count: BucketCount;
  permanentBouncesByAuthCode: AuthCodeTally;
  dimensions: Record<Dimension, Map<string, DimensionTally>>;
  noValue: Record<Dimension, DimensionTally>;
  complaints: Map<string, ComplaintAttribution>;
  keys: BucketKeyVerdict;
}

interface BucketKeyVerdict {
  pending: boolean;
  coverage: CoverageTally;
}

/** The recipient keys of the one bucket being read: `messageId#recipientHmac` per send and per
 * terminal outcome, and the messageId of each Reject, which names no recipient. */
interface BucketKeys {
  readonly bucketStartMs: number;
  readonly sends: Map<string, string>;
  readonly outcomes: Set<string>;
  readonly rejectedMessages: Set<string>;
}

export interface WindowFoldState {
  readonly lane: string;
  readonly window: BucketWindow;
  readonly nowMs: number;
  pages: number;
  readonly buckets: Map<number, BucketTally>;
  readonly trackedValues: Record<Dimension, Set<string>>;
  trackedComplaints: number;
  readonly observe: ObserveTally;
  dimensionBound: boolean;
  openKeys: BucketKeys | undefined;
  readonly finalizedBuckets: Set<number>;
  orderBroken: boolean;
}

export interface CoverageTally {
  recipientSends: number;
  covered: number;
}

export interface BucketCoverage extends CoverageTally {
  bucketStartMs: number;
  complete: boolean;
}

export function coverageWindowFor(nowMs: number): BucketWindow {
  const toBucketMs = bucketStartMs(nowMs - BUCKET_MS - LATENESS_HORIZON_MS);
  return { fromBucketMs: toBucketMs - (COVERAGE_WINDOW_BUCKETS - 1) * BUCKET_MS, toBucketMs };
}

export function windowCoverage(
  buckets: readonly BucketCoverage[],
  counts: (bucket: BucketCoverage) => boolean = (bucket) => bucket.complete,
): CoverageTally {
  const tally = { recipientSends: 0, covered: 0 };
  for (const bucket of buckets) {
    if (!counts(bucket)) continue;
    tally.recipientSends += bucket.recipientSends;
    tally.covered += bucket.covered;
  }
  return tally;
}

export interface WindowSummary {
  window: BucketWindow;
  pages: number;
  buckets: readonly BucketCount[];
  coverage: CoverageTally;
  bucketCoverage: readonly BucketCoverage[];
  pendingBuckets: readonly number[];
  orderBroken: boolean;
  totals: {
    recipientSends: number;
    permanentBounces: number;
    permanentBouncesByAuthCode: AuthCodeTally;
    complaints: number;
  };
  dimensions: Record<Dimension, ReadonlyMap<string, DimensionTally>>;
  noValue: Record<Dimension, DimensionTally>;
  dimensionBound: boolean;
  observed: ObservedLaneFacts;
}

export interface CreateWindowFoldOptions {
  lane: string;
  window: BucketWindow;
  nowMs: number;
}

const AUTH_DETAILS: readonly AuthDetail[] = [...new Set(Object.values(AUTH_CORROBORATION_CODES).flat())].sort(
  (left, right) => left - right,
);
const AUTH_DETAIL_PATTERN = /^[245]\.7\.(2[0-4]|26)$/;

function emptyAuthCodeTally(): AuthCodeTally {
  return Object.fromEntries(AUTH_DETAILS.map((detail) => [detail, 0])) as AuthCodeTally;
}

function emptyDimensionTally(): DimensionTally {
  return { sends: 0, permanentBounces: 0, complaints: 0 };
}

function addTally(target: DimensionTally, addition: DimensionTally): void {
  target.sends += addition.sends;
  target.permanentBounces += addition.permanentBounces;
  target.complaints += addition.complaints;
}

function perDimension<T>(make: () => T): Record<Dimension, T> {
  return { batch: make(), template: make(), campaign: make(), receivingDomain: make(), fromDomain: make() };
}

function emptyState(options: CreateWindowFoldOptions): WindowFoldState {
  return {
    lane: options.lane,
    window: { ...options.window },
    nowMs: options.nowMs,
    pages: 0,
    buckets: new Map(),
    trackedValues: perDimension(() => new Set<string>()),
    trackedComplaints: 0,
    observe: createObserveTally(),
    dimensionBound: false,
    openKeys: undefined,
    finalizedBuckets: new Set(),
    orderBroken: false,
  };
}

function bucketTallyFor(state: WindowFoldState, bucketStartMsValue: number): BucketTally {
  let bucket = state.buckets.get(bucketStartMsValue);
  if (bucket === undefined) {
    bucket = {
      count: emptyBucket(bucketStartMsValue, state.nowMs),
      permanentBouncesByAuthCode: emptyAuthCodeTally(),
      dimensions: perDimension(() => new Map<string, DimensionTally>()),
      noValue: perDimension(emptyDimensionTally),
      complaints: new Map(),
      keys: { pending: false, coverage: { recipientSends: 0, covered: 0 } },
    };
    state.buckets.set(bucketStartMsValue, bucket);
  }
  return bucket;
}

// The first distinct value past the cap is not kept: the lane then decides unknown
// (dimension-bound) instead of reading a table that silently lost rows (D-46).
function trackValue(state: WindowFoldState, dimension: Dimension, value: string): boolean {
  const tracked = state.trackedValues[dimension];
  if (tracked.has(value)) return true;
  if (tracked.size >= MAX_TRACKED_VALUES) {
    state.dimensionBound = true;
    return false;
  }
  tracked.add(value);
  return true;
}

function addToDimension(
  state: WindowFoldState,
  bucket: BucketTally,
  dimension: Dimension,
  value: string | undefined,
  contribution: DimensionTally,
): void {
  if (!isUsableValue(value)) {
    addTally(bucket.noValue[dimension], contribution);
    return;
  }
  if (!trackValue(state, dimension, value)) return;
  let tally = bucket.dimensions[dimension].get(value);
  if (tally === undefined) {
    tally = emptyDimensionTally();
    bucket.dimensions[dimension].set(value, tally);
  }
  addTally(tally, contribution);
}

const FIELD_BY_DIMENSION = {
  batch: 'batchTagValue',
  template: 'templateTagValue',
  campaign: 'campaignTagValue',
  fromDomain: 'fromDomain',
} as const satisfies Record<Exclude<Dimension, 'receivingDomain'>, keyof EventFields>;

function contributionOf(record: EventRecord): DimensionTally | undefined {
  const contribution = {
    sends: record.kind === 'send' ? 1 : 0,
    permanentBounces: record.eventType === 'Bounce' && bounceClass(record) === 'permanent' ? 1 : 0,
    complaints: record.kind === 'complaint' && complaintClass(record) === 'counted' ? 1 : 0,
  };
  return contribution.sends + contribution.permanentBounces + contribution.complaints === 0 ? undefined : contribution;
}

// A complaint's counting record carries no receiving domain (D-33), so its domain is settled at
// summary time from its complaintRecipient items and never here, which keeps the attribution
// independent of the order the pages arrive in.
function countDimensions(state: WindowFoldState, bucket: BucketTally, record: EventRecord): void {
  const contribution = contributionOf(record);
  if (contribution === undefined) return;
  type TagDimension = keyof typeof FIELD_BY_DIMENSION;
  for (const [dimension, field] of Object.entries(FIELD_BY_DIMENSION) as [TagDimension, (typeof FIELD_BY_DIMENSION)[TagDimension]][]) {
    addToDimension(state, bucket, dimension, record.fields[field], contribution);
  }
  if (contribution.complaints === 0) addToDimension(state, bucket, 'receivingDomain', record.receivingDomain, contribution);
}

function countAuthDetail(bucket: BucketTally, record: EventRecord): void {
  if (record.eventType !== 'Bounce' || bounceClass(record) !== 'permanent') return;
  const detail = AUTH_DETAIL_PATTERN.exec(record.fields.enhancedStatusCode ?? '')?.[1];
  if (detail !== undefined) bucket.permanentBouncesByAuthCode[Number(detail) as AuthDetail] += 1;
}

function complaintEntry(state: WindowFoldState, bucket: BucketTally, feedbackId: string): ComplaintAttribution | undefined {
  const existing = bucket.complaints.get(feedbackId);
  if (existing !== undefined) return existing;
  if (state.trackedComplaints >= MAX_TRACKED_COMPLAINTS) {
    state.dimensionBound = true;
    return undefined;
  }
  const entry: ComplaintAttribution = { counted: false, domain: undefined, spansDomains: false };
  bucket.complaints.set(feedbackId, entry);
  state.trackedComplaints += 1;
  return entry;
}

function noteComplaintRecipient(state: WindowFoldState, bucket: BucketTally, record: EventRecord): void {
  if (record.feedbackId === undefined) return;
  const entry = complaintEntry(state, bucket, record.feedbackId);
  if (entry === undefined || entry.spansDomains) return;
  const domain = record.receivingDomain;
  if (!isUsableValue(domain) || (entry.domain !== undefined && entry.domain !== domain) || !trackValue(state, 'receivingDomain', domain)) {
    entry.spansDomains = true;
    return;
  }
  entry.domain = domain;
}

function noteCountedComplaint(state: WindowFoldState, bucket: BucketTally, record: EventRecord): void {
  if (record.kind !== 'complaint' || record.feedbackId === undefined || complaintClass(record) !== 'counted') return;
  const entry = complaintEntry(state, bucket, record.feedbackId);
  if (entry !== undefined) entry.counted = true;
}

function withinObserveCap(values: ReadonlySet<string>, value: string | undefined): boolean {
  return !isUsableValue(value) || values.has(value) || values.size < MAX_TRACKED_VALUES;
}

function recipientKeyOf(record: EventRecord): string | undefined {
  return record.recipientHmac === undefined ? undefined : `${record.messageId}#${record.recipientHmac}`;
}

// DeliveryDelay is no terminal outcome (a recipient can be delayed many times), and a complaint
// follows a delivery, so neither covers a recipient-send nor marks a bucket pending.
function bufferKeys(keys: BucketKeys, record: EventRecord): void {
  const key = recipientKeyOf(record);
  if (record.kind === 'send') {
    if (key !== undefined) keys.sends.set(key, record.messageId);
  } else if (record.eventType === 'Reject') {
    keys.rejectedMessages.add(record.messageId);
  } else if (record.kind === 'outcome' && (record.eventType === 'Delivery' || record.eventType === 'Bounce') && key !== undefined) {
    keys.outcomes.add(key);
  }
}

// R3's guard by distinct recipient keys rather than record counts: a Delivery and a later Bounce
// for one recipient outnumber its one send, yet the bucket is complete and correct (AC-E14).
function judgeKeys(keys: BucketKeys): BucketKeyVerdict {
  let pending = false;
  for (const key of keys.outcomes) {
    if (!keys.sends.has(key)) {
      pending = true;
      break;
    }
  }
  let covered = 0;
  for (const [key, messageId] of keys.sends) {
    if (keys.outcomes.has(key) || keys.rejectedMessages.has(messageId)) covered += 1;
  }
  return { pending, coverage: { recipientSends: keys.sends.size, covered } };
}

function finalizeOpenBucket(state: WindowFoldState): void {
  const keys = state.openKeys;
  if (keys === undefined) return;
  const bucket = state.buckets.get(keys.bucketStartMs);
  if (bucket !== undefined) bucket.keys = judgeKeys(keys);
  state.finalizedBuckets.add(keys.bucketStartMs);
  state.openKeys = undefined;
}

// The store returns a bucket's records together (D-45), so a record of a finalized bucket means
// the order guarantee failed and that bucket's keys were judged on part of it. Its pending flag is
// dropped rather than trusted, and orderBroken makes coverage read NO DATA, which decides the lane
// unknown before any approval whatever the ratios say.
function keysFor(state: WindowFoldState, bucket: BucketTally): BucketKeys | undefined {
  const start = bucket.count.bucketStartMs;
  if (state.openKeys?.bucketStartMs === start) return state.openKeys;
  finalizeOpenBucket(state);
  if (state.finalizedBuckets.has(start)) {
    state.orderBroken = true;
    bucket.keys.pending = false;
    return undefined;
  }
  state.openKeys = { bucketStartMs: start, sends: new Map(), outcomes: new Set(), rejectedMessages: new Set() };
  return state.openKeys;
}

function foldRecord(state: WindowFoldState, record: EventRecord): void {
  const bucket = bucketTallyFor(state, record.bucketStartMs);
  const keys = keysFor(state, bucket);
  if (keys !== undefined) bufferKeys(keys, record);
  if (record.kind === 'complaintRecipient') {
    noteComplaintRecipient(state, bucket, record);
    return;
  }
  if (!isCountedRecord(record)) return;
  applyRecord(bucket.count, record);
  noteCountedComplaint(state, bucket, record);
  countAuthDetail(bucket, record);
  countDimensions(state, bucket, record);
  const observeFits =
    withinObserveCap(state.observe.streamTagValues, record.fields.streamTagValue) &&
    withinObserveCap(state.observe.callerIdentities, record.fields.callerIdentity);
  if (observeFits) observeRecord(state.observe, record, state.nowMs);
  else state.dimensionBound = true;
}

function belongsInWindow(state: WindowFoldState, record: EventRecord, nowSeconds: number): boolean {
  return (
    record.configurationSet === state.lane &&
    record.expiresAt > nowSeconds &&
    record.bucketStartMs >= state.window.fromBucketMs &&
    record.bucketStartMs <= state.window.toBucketMs
  );
}

/** `lane` is the configuration set the fold reads. The step re-checks expiry and the window, a
 * second line behind the store's own filter, so a record past retention never informs a decision. */
export function createWindowFold(options: CreateWindowFoldOptions): LaneFold<WindowFoldState> {
  assertFoldWindow(options.window.fromBucketMs, options.window.toBucketMs);
  return {
    get initial() {
      return emptyState(options);
    },
    step(state, page) {
      state.pages += 1;
      const nowSeconds = Math.floor(state.nowMs / 1000);
      for (const record of page) {
        if (belongsInWindow(state, record, nowSeconds)) foldRecord(state, record);
      }
      return state;
    },
  };
}

function mergeDimension(target: Map<string, DimensionTally>, source: ReadonlyMap<string, DimensionTally>): void {
  for (const [value, tally] of source) {
    let merged = target.get(value);
    if (merged === undefined) {
      merged = emptyDimensionTally();
      target.set(value, merged);
    }
    addTally(merged, tally);
  }
}

// A complaint names one receiving domain only when every recipient item of its feedbackId shares
// it; otherwise it counts in the no-value tally, so the dimension still sums to the lane total.
function attributeComplaints(bucket: BucketTally, domains: Map<string, DimensionTally>, noValue: DimensionTally): void {
  for (const entry of bucket.complaints.values()) {
    if (!entry.counted) continue;
    if (entry.domain === undefined || entry.spansDomains) {
      noValue.complaints += 1;
      continue;
    }
    let tally = domains.get(entry.domain);
    if (tally === undefined) {
      tally = emptyDimensionTally();
      domains.set(entry.domain, tally);
    }
    tally.complaints += 1;
  }
}

interface RatioParts {
  totals: WindowSummary['totals'];
  dimensions: Record<Dimension, Map<string, DimensionTally>>;
  noValue: Record<Dimension, DimensionTally>;
}

function addToRatios(parts: RatioParts, bucket: BucketTally): void {
  const { totals, dimensions, noValue } = parts;
  totals.recipientSends += bucket.count.send;
  totals.permanentBounces += bucket.count.permanentBounce;
  totals.complaints += bucket.count.complaint;
  for (const detail of AUTH_DETAILS) totals.permanentBouncesByAuthCode[detail] += bucket.permanentBouncesByAuthCode[detail];
  for (const dimension of DIMENSIONS) {
    mergeDimension(dimensions[dimension], bucket.dimensions[dimension]);
    addTally(noValue[dimension], bucket.noValue[dimension]);
  }
  attributeComplaints(bucket, dimensions.receivingDomain, noValue.receivingDomain);
}

/** Read-only: a bucket still open at summary time is judged on its keys here without being
 * finalized, so a fold can keep stepping after a summary. */
export function summarizeWindow(state: WindowFoldState): WindowSummary {
  const buckets: BucketCount[] = [];
  const bucketCoverage: BucketCoverage[] = [];
  const pendingBuckets: number[] = [];
  const parts: RatioParts = {
    totals: { recipientSends: 0, permanentBounces: 0, permanentBouncesByAuthCode: emptyAuthCodeTally(), complaints: 0 },
    dimensions: perDimension(() => new Map<string, DimensionTally>()),
    noValue: perDimension(emptyDimensionTally),
  };
  const open = state.openKeys;
  const openVerdict = open === undefined ? undefined : judgeKeys(open);
  for (let start = state.window.fromBucketMs; start <= state.window.toBucketMs; start += BUCKET_MS) {
    const bucket = state.buckets.get(start);
    if (bucket === undefined) {
      const empty = emptyBucket(start, state.nowMs);
      buckets.push(empty);
      bucketCoverage.push({ bucketStartMs: start, complete: empty.complete, recipientSends: 0, covered: 0 });
      continue;
    }
    const keys = openVerdict !== undefined && open?.bucketStartMs === start ? openVerdict : bucket.keys;
    buckets.push({ ...bucket.count });
    bucketCoverage.push({ bucketStartMs: start, complete: bucket.count.complete, ...keys.coverage });
    if (keys.pending) {
      pendingBuckets.push(start);
      continue;
    }
    addToRatios(parts, bucket);
  }
  return {
    window: { ...state.window },
    pages: state.pages,
    buckets,
    coverage: windowCoverage(bucketCoverage),
    bucketCoverage,
    pendingBuckets,
    orderBroken: state.orderBroken,
    totals: parts.totals,
    dimensions: parts.dimensions,
    noValue: parts.noValue,
    dimensionBound: state.dimensionBound,
    observed: observedFactsOf(state.observe),
  };
}
