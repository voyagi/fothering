import type { LaneEntry, LaneMap } from './lanes.js';
import type { EventRecord } from './records.js';

export const REQUIRED_EVENT_TYPES = ['SEND', 'REJECT', 'BOUNCE', 'COMPLAINT', 'DELIVERY', 'DELIVERY_DELAY'] as const;

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

declare const closeableBrand: unique symbol;
export type CloseableLane = LaneEntry & { readonly [closeableBrand]: true };

export interface SesConfigurationFacts {
  defaultConfigurationSets: ReadonlySet<string>;
  eventDestinations: ReadonlyMap<
    string,
    readonly { enabled: boolean; eventBridge: boolean; matchingEventTypes: readonly string[] }[]
  >;
}

export interface ObservedLaneFacts {
  recordCount: number;
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

export function observeLanes(
  _records: readonly EventRecord[],
  _options: ObserveLanesOptions,
): ReadonlyMap<string, ObservedLaneFacts> {
  return new Map();
}

export interface CheckCloseabilityOptions {
  laneMap: LaneMap;
  observed: ReadonlyMap<string, ObservedLaneFacts>;
  ses: SesConfigurationFacts;
}

export function checkCloseability(_configurationSet: string, _options: CheckCloseabilityOptions): CloseabilityResult {
  return { state: 'no-data' };
}
