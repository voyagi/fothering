import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { BUCKET_MS, LATENESS_HORIZON_MS, bucketStartMs, isBucketComplete } from './buckets.js';
import {
  REFUSAL_REASONS,
  REQUIRED_EVENT_TYPES,
  checkCloseability,
  observeLanes,
  type CloseabilityResult,
  type CloseableLane,
  type RefusalReason,
  type SesConfigurationFacts,
} from './closeability.js';
import { parseLaneMap, type LaneEntry, type LaneMap } from './lanes.js';
import { UNCLASSIFIED, type EventFields, type EventRecord, type SesEventType } from './records.js';
import { BASE_BUCKET_MS, ONE_HOUR_MS, bucketAfterBase, deliveredMessage, testRecord } from './test/closeability-records.js';
import { propertySeed } from './test/property-seed.js';
import lanesJson from '../../../lanes.json' with { type: 'json' };

const LANE_MAP = parseLaneMap(lanesJson);
const BULK = 'fothering-bulk';
const TRANSACTIONAL = 'fothering-transactional';
const ALERTS = 'fothering-alerts';

// The base bucket is still open at NOW_MS, so its sends need no outcome record yet.
const NOW_MS = BASE_BUCKET_MS + ONE_HOUR_MS;
const WINDOW_START_MS = BASE_BUCKET_MS - ONE_HOUR_MS;

const FULL_DESTINATION = { enabled: true, eventBridge: true, matchingEventTypes: [...REQUIRED_EVENT_TYPES] };

function sesFacts(overrides: Partial<SesConfigurationFacts> = {}): SesConfigurationFacts {
  return {
    defaultConfigurationSets: new Set(['fothering-default']),
    eventDestinations: new Map(LANE_MAP.lanes.map((lane) => [lane.configurationSet, [FULL_DESTINATION]])),
    ...overrides,
  };
}

function destinationsFor(configurationSet: string, destinations: SesConfigurationFacts['eventDestinations'] extends ReadonlyMap<string, infer V> ? V : never): SesConfigurationFacts {
  const base = sesFacts();
  return sesFacts({ eventDestinations: new Map([...base.eventDestinations, [configurationSet, destinations]]) });
}

function fieldsOf(stream: string | undefined, caller: string | undefined): EventFields {
  return {
    ...(stream === undefined ? {} : { streamTagValue: stream }),
    ...(caller === undefined ? {} : { callerIdentity: caller }),
  };
}

function healthyLane(configurationSet: string, stream: string, caller: string, identity = 'm'): EventRecord[] {
  return deliveredMessage({
    configurationSet,
    bucketStartMs: BASE_BUCKET_MS,
    identity: `${configurationSet}-${identity}`,
    fields: fieldsOf(stream, caller),
  });
}

function withBulkLane(overrides: Partial<LaneEntry>): LaneMap {
  return { ...LANE_MAP, lanes: LANE_MAP.lanes.map((lane) => (lane.configurationSet === BULK ? { ...lane, ...overrides } : lane)) };
}

interface Scenario {
  laneMap?: LaneMap;
  records: EventRecord[];
  ses?: SesConfigurationFacts;
  set?: string;
}

function evaluate(scenario: Scenario, nowMs = NOW_MS): CloseabilityResult {
  const laneMap = scenario.laneMap ?? LANE_MAP;
  const observed = observeLanes(scenario.records, { laneMap, windowStartMs: WINDOW_START_MS, nowMs });
  return checkCloseability(scenario.set ?? BULK, { laneMap, observed, ses: scenario.ses ?? sesFacts() });
}

function baseline(): Scenario {
  return { records: healthyLane(BULK, 'newsletter', 'bulk-sender') };
}

function reasonsOf(result: CloseabilityResult): readonly RefusalReason[] | string {
  return result.state === 'refused' ? result.reasons : result.state;
}

interface RulePair {
  rule: RefusalReason;
  expected: readonly RefusalReason[];
  refusing: Scenario;
  twin: Scenario;
}

const PARTIAL_DESTINATION = { ...FULL_DESTINATION, matchingEventTypes: REQUIRED_EVENT_TYPES.filter((type) => type !== 'DELIVERY_DELAY') };

const RULE_PAIRS: RulePair[] = [
  {
    rule: 'multiple-declared-streams',
    expected: ['multiple-declared-streams'],
    refusing: { ...baseline(), laneMap: withBulkLane({ declaredStreams: ['newsletter', 'digest'] }) },
    twin: baseline(),
  },
  {
    rule: 'observed-second-stream',
    expected: ['observed-second-stream', 'observed-stream-undeclared'],
    refusing: { records: [...baseline().records, ...healthyLane(BULK, 'digest', 'bulk-sender', 'second')] },
    twin: baseline(),
  },
  {
    rule: 'observed-stream-undeclared',
    expected: ['observed-stream-undeclared'],
    refusing: { records: healthyLane(BULK, 'digest', 'bulk-sender') },
    twin: baseline(),
  },
  {
    rule: 'stream-tag-missing',
    expected: ['stream-tag-missing'],
    refusing: { records: [...baseline().records, ...healthyLane(BULK, '', 'bulk-sender', 'untagged').map((record) => ({ ...record, fields: fieldsOf(undefined, 'bulk-sender') }))] },
    twin: { records: [...baseline().records, ...healthyLane(BULK, 'newsletter', 'bulk-sender', 'tagged')] },
  },
  {
    rule: 'caller-unknown',
    expected: ['caller-unknown'],
    refusing: { records: [...baseline().records, ...healthyLane(BULK, 'newsletter', UNCLASSIFIED, 'unknown-caller')] },
    twin: { records: [...baseline().records, ...healthyLane(BULK, 'newsletter', 'bulk-sender', 'known-caller')] },
  },
  {
    rule: 'caller-on-another-set',
    expected: ['caller-on-another-set'],
    refusing: { records: [...baseline().records, ...healthyLane(TRANSACTIONAL, 'receipts', 'bulk-sender')] },
    twin: { records: [...baseline().records, ...healthyLane(TRANSACTIONAL, 'receipts', 'tx-sender')] },
  },
  {
    rule: 'default-configuration-set',
    expected: ['default-configuration-set'],
    refusing: { ...baseline(), ses: sesFacts({ defaultConfigurationSets: new Set([BULK]) }) },
    twin: { ...baseline(), ses: sesFacts({ defaultConfigurationSets: new Set(['fothering-default']) }) },
  },
  {
    rule: 'destination-missing-event-types',
    expected: ['destination-missing-event-types'],
    refusing: { ...baseline(), ses: destinationsFor(BULK, [PARTIAL_DESTINATION]) },
    twin: { ...baseline(), ses: destinationsFor(BULK, [FULL_DESTINATION]) },
  },
  {
    rule: 'operator-alert',
    expected: ['operator-alert'],
    refusing: { ...baseline(), laneMap: withBulkLane({ operatorAlert: true }) },
    twin: { ...baseline(), laneMap: withBulkLane({ operatorAlert: false }) },
  },
  {
    rule: 'transactional',
    expected: ['transactional'],
    refusing: { ...baseline(), laneMap: withBulkLane({ criticality: 'transactional' }) },
    twin: { ...baseline(), laneMap: withBulkLane({ criticality: 'bulk' }) },
  },
];

describe('every refusal rule refuses its fixture and passes its twin (AC-16)', () => {
  it('has one pair for each refusal reason the check can return', () => {
    expect(RULE_PAIRS.map((pair) => pair.rule)).toEqual([...REFUSAL_REASONS]);
  });

  it.each(RULE_PAIRS)('$rule refuses its fixture with exactly the reasons that apply', ({ refusing, expected }) => {
    expect(reasonsOf(evaluate(refusing))).toEqual(expected);
  });

  it.each(RULE_PAIRS)('$rule twin, differing only in that rule input, comes out closeable', ({ twin }) => {
    expect(evaluate(twin).state).toBe('closeable');
  });

  it.each([
    ['a disabled destination', [{ ...FULL_DESTINATION, enabled: false }]],
    ['a destination that is not an EventBridge destination', [{ ...FULL_DESTINATION, eventBridge: false }]],
    ['a destination with no matching event types', [{ ...FULL_DESTINATION, matchingEventTypes: [] }]],
    ['no destination at all', []],
    [
      'coverage split across two destinations, none covering all six',
      [
        { ...FULL_DESTINATION, matchingEventTypes: ['SEND', 'REJECT', 'BOUNCE'] },
        { ...FULL_DESTINATION, matchingEventTypes: ['COMPLAINT', 'DELIVERY', 'DELIVERY_DELAY'] },
      ],
    ],
  ])('refuses %s', (_label, destinations) => {
    expect(reasonsOf(evaluate({ ...baseline(), ses: destinationsFor(BULK, destinations) }))).toEqual(['destination-missing-event-types']);
  });

  it('refuses a set the SES facts hold no destination list for', () => {
    const ses = sesFacts({ eventDestinations: new Map() });
    expect(reasonsOf(evaluate({ ...baseline(), ses }))).toEqual(['destination-missing-event-types']);
  });

  it('accepts one covering destination even when another destination covers less', () => {
    const ses = destinationsFor(BULK, [PARTIAL_DESTINATION, FULL_DESTINATION]);
    expect(evaluate({ ...baseline(), ses }).state).toBe('closeable');
  });

  it.each([undefined, UNCLASSIFIED])('refuses a record whose stream tag is %s', (stream) => {
    const untagged = healthyLane(BULK, 'newsletter', 'bulk-sender', 'untagged').map((record) => ({ ...record, fields: fieldsOf(stream, 'bulk-sender') }));
    expect(reasonsOf(evaluate({ records: [...baseline().records, ...untagged] }))).toEqual(['stream-tag-missing']);
  });

  it('refuses a record with no caller identity at all', () => {
    const anonymous = healthyLane(BULK, 'newsletter', 'bulk-sender', 'anonymous').map((record) => ({ ...record, fields: fieldsOf('newsletter', undefined) }));
    expect(reasonsOf(evaluate({ records: [...baseline().records, ...anonymous] }))).toEqual(['caller-unknown']);
  });

  it('sees a caller shared with a set the lane map does not list', () => {
    const stray = healthyLane('a-set-nobody-declared', 'newsletter', 'bulk-sender');
    expect(reasonsOf(evaluate({ records: [...baseline().records, ...stray] }))).toEqual(['caller-on-another-set']);
  });
});

describe('the observed events override the lane map (RED-12, AC-E31)', () => {
  it('refuses a set whose map declares one stream while its events show two, and would fail if it came out closeable', () => {
    expect(LANE_MAP.lanes.find((lane) => lane.configurationSet === BULK)?.declaredStreams).toEqual(['newsletter']);
    const result = evaluate({ records: [...baseline().records, ...healthyLane(BULK, 'digest', 'bulk-sender', 'second')] });
    expect(result.state).not.toBe('closeable');
    expect(reasonsOf(result)).toContain('observed-second-stream');
  });

  it('refuses on one single record carrying a second stream-tag value among many carrying the declared one', () => {
    const many = Array.from({ length: 200 }, (_unused, index) => healthyLane(BULK, 'newsletter', 'bulk-sender', `n${index}`)).flat();
    const one = testRecord({ configurationSet: BULK, bucketStartMs: BASE_BUCKET_MS, identity: 'lone-second', fields: fieldsOf('digest', 'bulk-sender') });
    expect(evaluate({ records: many }).state).toBe('closeable');
    expect(reasonsOf(evaluate({ records: [...many, one] }))).toContain('observed-second-stream');
  });
});

describe('the committed lanes.json (D-24, D-38)', () => {
  const records = [
    ...healthyLane(TRANSACTIONAL, 'receipts', 'tx-sender'),
    ...healthyLane(BULK, 'newsletter', 'bulk-sender'),
    ...healthyLane(ALERTS, 'operator', 'alert-sender'),
  ];

  it('refuses the transactional set and the operator-alert set and finds the bulk set closeable, the only candidate', () => {
    const results = Object.fromEntries(
      LANE_MAP.lanes.map((lane) => [lane.configurationSet, reasonsOf(evaluate({ records, set: lane.configurationSet }))]),
    );
    expect(results).toEqual({
      [TRANSACTIONAL]: ['transactional'],
      [BULK]: 'closeable',
      [ALERTS]: ['operator-alert', 'transactional'],
    });
  });

  it('throws for a set the lane map does not list instead of answering', () => {
    expect(() => evaluate({ records, set: 'a-set-nobody-declared' })).toThrow('a-set-nobody-declared');
  });
});

describe('NO DATA (VER-09)', () => {
  it('reads NO DATA for a set with no records at all', () => {
    expect(evaluate({ records: [] }).state).toBe('no-data');
  });

  it('reads NO DATA when every record belongs to another set', () => {
    expect(evaluate({ records: healthyLane(TRANSACTIONAL, 'receipts', 'tx-sender') }).state).toBe('no-data');
  });

  it('counts a record in the bucket the window starts in and none from the bucket before it', () => {
    const windowStartMs = BASE_BUCKET_MS - 6 * BUCKET_MS + 1_000;
    const inFirstBucket = healthyLane(BULK, 'newsletter', 'bulk-sender').map((record) => ({ ...record, bucketStartMs: bucketStartMs(windowStartMs) }));
    const beforeWindow = inFirstBucket.map((record) => ({ ...record, bucketStartMs: bucketStartMs(windowStartMs) - BUCKET_MS }));
    const observe = (records: EventRecord[]) => observeLanes(records, { laneMap: LANE_MAP, windowStartMs, nowMs: NOW_MS }).get(BULK)?.recordCount;
    expect(observe(inFirstBucket)).toBe(2);
    expect(observe(beforeWindow)).toBe(0);
  });

  it('reads NO DATA when the complete buckets hold sends and no outcome, at the first millisecond a bucket is complete', () => {
    const sendsOnly = healthyLane(BULK, 'newsletter', 'bulk-sender').filter((record) => record.kind === 'send');
    const completeAt = BASE_BUCKET_MS + BUCKET_MS + LATENESS_HORIZON_MS;
    expect(isBucketComplete(BASE_BUCKET_MS, completeAt)).toBe(true);
    expect(evaluate({ records: sendsOnly }, completeAt).state).toBe('no-data');
    expect(isBucketComplete(BASE_BUCKET_MS, completeAt - 1)).toBe(false);
    expect(evaluate({ records: sendsOnly }, completeAt - 1).state).toBe('closeable');
  });

  it('is closeable when the complete buckets hold sends and their outcomes', () => {
    expect(evaluate(baseline(), BASE_BUCKET_MS + BUCKET_MS + LATENESS_HORIZON_MS).state).toBe('closeable');
  });

  it('describes what was observed per set, seeding every lane-map set even with no records', () => {
    const observed = observeLanes(
      [...baseline().records, ...healthyLane(TRANSACTIONAL, 'receipts', 'tx-sender')],
      { laneMap: LANE_MAP, windowStartMs: WINDOW_START_MS, nowMs: NOW_MS },
    );
    expect(observed.get(BULK)).toEqual({
      recordCount: 2,
      streamTagValues: new Set(['newsletter']),
      recordsWithoutValidStream: 0,
      callerIdentities: new Set(['bulk-sender']),
      recordsWithoutCaller: 0,
      completeBucketsHoldSendsWithoutOutcomes: false,
    });
    expect(observed.get(ALERTS)?.recordCount).toBe(0);
  });

  // A NaN now makes every bucket read as still open, so sends with no outcome would pass as data;
  // a NaN window start drops the window's lower edge. Either is refused, never read as a time.
  it.each([
    ['nowMs', { nowMs: Number.NaN }],
    ['nowMs', { nowMs: Number.POSITIVE_INFINITY }],
    ['windowStartMs', { windowStartMs: Number.NaN }],
    ['windowStartMs', { windowStartMs: Number.NEGATIVE_INFINITY }],
  ])('refuses a %s that is not a finite number', (name, override) => {
    const sendsOnly = healthyLane(BULK, 'newsletter', 'bulk-sender').filter((record) => record.kind === 'send');
    const observe = (): unknown => observeLanes(sendsOnly, { laneMap: LANE_MAP, windowStartMs: WINDOW_START_MS, nowMs: NOW_MS, ...override });
    expect(observe).toThrow(RangeError);
    expect(observe).toThrow(name);
  });
});

describe('the closeable type (AC-17)', () => {
  it('is produced by the check and cannot be built from an object literal', () => {
    const result = evaluate(baseline());
    if (result.state !== 'closeable') throw new Error(`expected closeable, got ${result.state}`);
    const fromCheck: CloseableLane = result.lane;

    const [lane] = LANE_MAP.lanes;
    if (lane === undefined) throw new Error('lanes.json holds no lane');
    // @ts-expect-error a lane entry copied into an object literal lacks the brand only the check can add
    const forged: CloseableLane = { ...lane };

    expect(fromCheck.configurationSet).toBe(BULK);
    expect(forged.configurationSet).toBe(lane.configurationSet);
  });
});

describe('a snapshot of stored events (R9 backstop)', () => {
  it('gives the same answer after events are stored past the snapshot, and a new read sees them', () => {
    const store = [...baseline().records];
    const snapshot = [...store];
    const before = evaluate({ records: snapshot });

    store.push(...healthyLane(BULK, 'digest', 'bulk-sender', 'late'));

    expect(evaluate({ records: snapshot })).toEqual(before);
    expect(before.state).toBe('closeable');
    expect(evaluate({ records: [...store] }).state).toBe('refused');
  });
});

const SET_COUNT = 4;

interface GeneratedLane {
  criticality: 'transactional' | 'bulk';
  operatorAlert: boolean;
  declared: string[];
}

interface GeneratedRecord {
  lane: number;
  streamPick: 'declared' | 'other' | 'missing' | 'unclassified';
  callerPick: 'own' | 'shared' | 'missing' | 'unclassified';
  eventType: SesEventType;
  bucketOffset: number;
}

interface Generated {
  lanes: GeneratedLane[];
  records: GeneratedRecord[];
  clean: boolean;
  defaults: string[];
  destinations: ('none' | 'full' | 'partial')[];
  nowBuckets: number;
}

const generatedArbitrary: fc.Arbitrary<Generated> = fc.record({
  lanes: fc.array(
    fc.record({
      criticality: fc.constantFrom('transactional', 'bulk'),
      operatorAlert: fc.boolean(),
      declared: fc.subarray(['s1', 's2', 's3'], { minLength: 1 }),
    }),
    { minLength: 1, maxLength: SET_COUNT },
  ),
  records: fc.array(
    fc.record({
      lane: fc.nat(SET_COUNT - 1),
      streamPick: fc.constantFrom('declared', 'declared', 'other', 'missing', 'unclassified'),
      callerPick: fc.constantFrom('own', 'own', 'shared', 'missing', 'unclassified'),
      eventType: fc.constantFrom('Send', 'Delivery', 'Bounce', 'Complaint'),
      bucketOffset: fc.integer({ min: -1, max: 1 }),
    }),
    { maxLength: 12 },
  ),
  clean: fc.boolean(),
  defaults: fc.subarray(Array.from({ length: SET_COUNT }, (_unused, index) => `set-${index}`)),
  destinations: fc.array(fc.constantFrom('none', 'full', 'full', 'full', 'partial'), { minLength: SET_COUNT, maxLength: SET_COUNT }),
  nowBuckets: fc.constantFrom(1, 400),
});

function pick<T>(items: readonly T[], index: number): T {
  const item = items[index % items.length];
  if (item === undefined) throw new Error('cannot pick from an empty list');
  return item;
}

function build(generated: Generated): { laneMap: LaneMap; records: EventRecord[]; ses: SesConfigurationFacts; nowMs: number } {
  const laneMap = parseLaneMap({
    runIdTagKey: 'fothering_run',
    lanes: generated.lanes.map((lane, index) => ({
      configurationSet: `set-${index}`,
      lane: `lane-${index}`,
      criticality: lane.criticality,
      declaredStreams: lane.declared,
      streamTagKey: 'stream',
      batchTagKey: 'batch',
      templateTagKey: 'template',
      campaignTagKey: 'campaign',
      operatorAlert: lane.operatorAlert,
    })),
  });

  const records = generated.records.map((entry, position) => {
    const index = entry.lane % generated.lanes.length;
    const lane = pick(generated.lanes, index);
    const stream = { declared: pick(lane.declared, 0), other: 'other-stream', missing: undefined, unclassified: UNCLASSIFIED }[generated.clean ? 'declared' : entry.streamPick];
    const caller = { own: `caller-${index}`, shared: 'shared-caller', missing: undefined, unclassified: UNCLASSIFIED }[generated.clean ? 'own' : entry.callerPick];
    return testRecord({
      configurationSet: `set-${index}`,
      bucketStartMs: bucketAfterBase(entry.bucketOffset),
      identity: `r${position}`,
      eventType: entry.eventType,
      fields: fieldsOf(stream, caller),
    });
  });

  const destinations = { none: undefined, full: [FULL_DESTINATION], partial: [PARTIAL_DESTINATION] };
  const eventDestinations = new Map(
    laneMap.lanes.flatMap((lane, index) => {
      const chosen = destinations[pick(generated.destinations, index)];
      return chosen === undefined ? [] : [[lane.configurationSet, chosen] as const];
    }),
  );

  return {
    laneMap,
    records,
    ses: { defaultConfigurationSets: new Set(generated.defaults), eventDestinations },
    nowMs: BASE_BUCKET_MS + generated.nowBuckets * BUCKET_MS,
  };
}

function resultsBySet(laneMap: LaneMap, built: ReturnType<typeof build>): Record<string, CloseabilityResult> {
  const observed = observeLanes(built.records, { laneMap, windowStartMs: WINDOW_START_MS, nowMs: built.nowMs });
  return Object.fromEntries(
    laneMap.lanes.map((lane) => [lane.configurationSet, checkCloseability(lane.configurationSet, { laneMap, observed, ses: built.ses })]),
  );
}

describe('properties over generated lane maps and observations', () => {
  it('never marks a transactional, operator-alert or NO DATA lane closeable (AC-P7), and does mark some lane closeable', () => {
    let closeableSeen = 0;
    fc.assert(
      fc.property(generatedArbitrary, (generated) => {
        const built = build(generated);
        const results = resultsBySet(built.laneMap, built);
        for (const lane of built.laneMap.lanes) {
          if (results[lane.configurationSet]?.state !== 'closeable') continue;
          closeableSeen += 1;
          const own = built.records.filter((record) => record.configurationSet === lane.configurationSet);
          const complete = own.filter((record) => isBucketComplete(record.bucketStartMs, built.nowMs));
          expect(lane.criticality).toBe('bulk');
          expect(lane.operatorAlert).toBe(false);
          expect(own.length).toBeGreaterThan(0);
          expect(complete.some((record) => record.kind === 'send') && !complete.some((record) => record.kind === 'outcome')).toBe(false);
        }
      }),
      { seed: propertySeed() },
    );
    expect(closeableSeen).toBeGreaterThan(0);
  });

  it('gives every set the same result whatever order the lanes sit in the file (AC-E34)', () => {
    fc.assert(
      fc.property(generatedArbitrary, fc.array(fc.integer(), { minLength: SET_COUNT, maxLength: SET_COUNT }), (generated, keys) => {
        const built = build(generated);
        const shuffled: LaneMap = {
          ...built.laneMap,
          lanes: built.laneMap.lanes
            .map((lane, index) => ({ lane, key: pick(keys, index) }))
            .sort((left, right) => left.key - right.key)
            .map((entry) => entry.lane),
        };
        expect(resultsBySet(shuffled, built)).toEqual(resultsBySet(built.laneMap, built));
      }),
      { seed: propertySeed() },
    );
  });
});
