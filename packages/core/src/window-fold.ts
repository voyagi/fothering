import {
  BUCKET_MS,
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
}

export interface WindowSummary {
  window: BucketWindow;
  pages: number;
  buckets: readonly BucketCount[];
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

function foldRecord(state: WindowFoldState, record: EventRecord): void {
  const bucket = bucketTallyFor(state, record.bucketStartMs);
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

export function summarizeWindow(state: WindowFoldState): WindowSummary {
  const buckets: BucketCount[] = [];
  const totals = { recipientSends: 0, permanentBounces: 0, permanentBouncesByAuthCode: emptyAuthCodeTally(), complaints: 0 };
  const dimensions = perDimension(() => new Map<string, DimensionTally>());
  const noValue = perDimension(emptyDimensionTally);
  for (let start = state.window.fromBucketMs; start <= state.window.toBucketMs; start += BUCKET_MS) {
    const bucket = state.buckets.get(start);
    if (bucket === undefined) {
      buckets.push(emptyBucket(start, state.nowMs));
      continue;
    }
    buckets.push({ ...bucket.count });
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
  return {
    window: { ...state.window },
    pages: state.pages,
    buckets,
    totals,
    dimensions,
    noValue,
    dimensionBound: state.dimensionBound,
    observed: observedFactsOf(state.observe),
  };
}
