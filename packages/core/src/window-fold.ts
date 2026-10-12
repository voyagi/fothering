import { BUCKET_MS, assertBucketBounds, bucketStartMs, emptyBucket, type BucketCount } from './buckets.js';
import { createObserveTally, observedFactsOf, type ObserveTally, type ObservedLaneFacts } from './closeability.js';
import type { EventRecord } from './records.js';

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

function emptyAuthCodeTally(): AuthCodeTally {
  return { 20: 0, 21: 0, 22: 0, 23: 0, 24: 0, 26: 0 };
}

function emptyDimensionTally(): DimensionTally {
  return { sends: 0, permanentBounces: 0, complaints: 0 };
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

export function createWindowFold(options: CreateWindowFoldOptions): LaneFold<WindowFoldState> {
  assertFoldWindow(options.window.fromBucketMs, options.window.toBucketMs);
  return {
    get initial() {
      return emptyState(options);
    },
    step(state) {
      return state;
    },
  };
}

export function summarizeWindow(state: WindowFoldState): WindowSummary {
  const buckets: BucketCount[] = [];
  for (let start = state.window.fromBucketMs; start <= state.window.toBucketMs; start += BUCKET_MS) {
    buckets.push(emptyBucket(start, state.nowMs));
  }
  return {
    window: { ...state.window },
    pages: state.pages,
    buckets,
    totals: { recipientSends: 0, permanentBounces: 0, permanentBouncesByAuthCode: emptyAuthCodeTally(), complaints: 0 },
    dimensions: perDimension(() => new Map<string, DimensionTally>()),
    noValue: perDimension(emptyDimensionTally),
    dimensionBound: state.dimensionBound,
    observed: observedFactsOf(state.observe),
  };
}
