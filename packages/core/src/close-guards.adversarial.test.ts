import { describe, expect, it } from 'vitest';
import lanesJson from '../../../lanes.json' with { type: 'json' };
import { BUCKET_MS, bucketStartMs } from './buckets.js';
import {
  ACTION_FUNCTION_TIMEOUT_MS,
  EMAIL_SEND_ATTEMPTS,
  HOLD_CHECK_DELAY_MS,
  HOLD_MS,
  LANE_HOUR_ATTEMPT_CAP,
  REOPEN_FUNCTION_TIMEOUT_MS,
} from './close-values.js';
import { REQUIRED_EVENT_TYPES, checkCloseability, type ObservedLaneFacts, type SesConfigurationFacts } from './closeability.js';
import {
  claimStateOf,
  closureClaimItem,
  decisionOf,
  freshnessRefusal,
  holdCheckDue,
  holdCheckWindow,
  holdFold,
  parseClosure,
  pauseMayHold,
  pausePointerOf,
  type Closure,
  type FreshnessInput,
  type OtherLaneReading,
} from './closure.js';
import { recordUsage, reserveLaneAttempt, type LaneAttemptReservation } from './counters.js';
import { openIncident, type IncidentMarker, type IncidentState } from './incident.js';
import { parseLaneMap } from './lanes.js';
import { emailAttemptDue, emailAttemptsSpent } from './operator-email.js';
import { RETENTION_SECONDS, type EventRecord } from './records.js';
import { reopenAcceptance, reopenPayloadSchema } from './reopen.js';
import { MAX_WINDOW_BUCKETS, spikeWindowFor } from './window-fold.js';

// Values a stored item can carry that no Fothering writer produces: the guards that read them must
// refuse or hold, never pass, since the item may be corrupt or written by hand.

const INCIDENT_ID = 'fedcba9876543210fedcba9876543210';
const CLAIMED_AT_MS = Date.UTC(2026, 9, 23, 20, 5, 0);
const RECORD_TO_BUCKET_MS = Date.UTC(2026, 9, 23, 20, 0, 0);
const DAY_MS = 86_400_000;

function claimed(overrides: Partial<Closure> = {}): Closure {
  const base = closureClaimItem({ incidentId: INCIDENT_ID, configurationSet: 'fothering-bulk', decisionOutcome: 'close', nowMs: CLAIMED_AT_MS });
  return { ...base, ...overrides };
}

const PAUSE_REQUESTED_MS = CLAIMED_AT_MS + 2_000;
const HOLD_END_MS = PAUSE_REQUESTED_MS + HOLD_MS;
const HOLD_DUE_MS = HOLD_END_MS + HOLD_CHECK_DELAY_MS;

function pausedAt(overrides: Partial<Closure> = {}): Closure {
  return claimed({ outcome: 'paused', pauseRequestedAtMs: PAUSE_REQUESTED_MS, readBack: false, readBackAtMs: PAUSE_REQUESTED_MS + 2_000, holdEndMs: HOLD_END_MS, ...overrides });
}

const MARKER: IncidentMarker = { incidentId: INCIDENT_ID, status: 'open', version: 2 };
const STATE: IncidentState = { ...openIncident('fothering-bulk', RECORD_TO_BUCKET_MS, spikeWindowFor(RECORD_TO_BUCKET_MS)), incidentId: INCIDENT_ID };

function freshness(overrides: Partial<FreshnessInput> = {}): FreshnessInput {
  return { incidentId: INCIDENT_ID, marker: MARKER, state: STATE, others: [], recordToBucketMs: RECORD_TO_BUCKET_MS, nowMs: RECORD_TO_BUCKET_MS + BUCKET_MS, ...overrides };
}

const openElsewhere = (openingToBucketMs: unknown): OtherLaneReading => ({ kind: 'open', openingToBucketMs });

const HOLD_BUCKET_MS = bucketStartMs(HOLD_END_MS);

// Typed loosely on purpose: the live event store hands the fold raw stored items, never parsed ones.
function storedSend(mailTimestampMs: unknown): EventRecord {
  const record = {
    pk: 'LANE#fothering-bulk',
    sk: `B#${String(HOLD_BUCKET_MS).padStart(13, '0')}#Send#stored`,
    kind: 'send',
    eventType: 'Send',
    configurationSet: 'fothering-bulk',
    bucketStartMs: HOLD_BUCKET_MS,
    mailTimestampMs,
    envelopeTimeMs: HOLD_BUCKET_MS,
    arrivalTimeMs: HOLD_BUCKET_MS,
    messageId: 'stored',
    provenance: 'generated',
    expiresAt: 0,
    fields: {},
  };
  return record as EventRecord;
}

function sendsCounted(records: readonly EventRecord[]): number {
  const fold = holdFold(HOLD_END_MS);
  return fold.step(fold.initial, records);
}

type EmailState = NonNullable<Closure['email']>;

function emailOf(overrides: Partial<EmailState>): EmailState {
  return { kind: 'closed', attempts: 1, claimedAtMs: null, sentAtMs: null, messageId: null, failed: false, ...overrides };
}

describe('freshnessRefusal on times no detection cycle writes', () => {
  it.each([
    ['minus one', -1],
    ['the smallest safe integer', Number.MIN_SAFE_INTEGER],
    ['minus infinity', Number.NEGATIVE_INFINITY],
    ['infinity', Number.POSITIVE_INFINITY],
    ['one past the largest safe integer', Number.MAX_SAFE_INTEGER + 1],
    ['null', null],
    ['true', true],
    ['an object', { toBucketMs: RECORD_TO_BUCKET_MS }],
  ])('refuses another open lane whose opening window end is %s', (_case, openingToBucketMs) => {
    expect(freshnessRefusal(freshness({ others: [openElsewhere(openingToBucketMs)] }))).toBe('newer-incident-elsewhere');
  });

  it('passes another open lane opened at the epoch, a value in range', () => {
    expect(freshnessRefusal(freshness({ others: [openElsewhere(0)] }))).toBeUndefined();
  });

  it('refuses on one unreadable lane among ten thousand quiet ones, and passes the ten thousand alone', () => {
    const quiet: OtherLaneReading[] = Array.from({ length: 10_000 }, () => ({ kind: 'no-open-incident' }));
    expect(freshnessRefusal(freshness({ others: quiet }))).toBeUndefined();
    expect(freshnessRefusal(freshness({ others: [...quiet.slice(0, 5_000), { kind: 'unreadable' }, ...quiet.slice(5_000)] }))).toBe('newer-incident-elsewhere');
  });
});

describe('claimStateOf and pauseMayHold on stored claims', () => {
  it('holds the lane for a claim dated a day ahead of now, failing closed', () => {
    const ahead = claimed({ claimedAtMs: CLAIMED_AT_MS + DAY_MS });
    expect(claimStateOf(ahead, CLAIMED_AT_MS)).toBe('in-flight');
    expect(pauseMayHold(ahead, CLAIMED_AT_MS)).toBe(true);
  });

  it('takes a stale claim back only when no pause was requested on it', () => {
    const staleMs = CLAIMED_AT_MS + ACTION_FUNCTION_TIMEOUT_MS;
    expect(claimStateOf(claimed(), staleMs - 1)).toBe('in-flight');
    expect(claimStateOf(claimed(), staleMs)).toBe('reclaimable');
    expect(pauseMayHold(claimed(), staleMs)).toBe(false);
    expect(claimStateOf(claimed({ pauseRequestedAtMs: PAUSE_REQUESTED_MS }), staleMs)).toBe('put-may-have-taken');
    expect(pauseMayHold(claimed({ pauseRequestedAtMs: PAUSE_REQUESTED_MS }), staleMs)).toBe(true);
  });

  it.each(['reopen-failed', 'reopen-unknown', null] as const)('keeps holding a paused lane whose reopen outcome is %s', (outcome) => {
    const reopen = { attempts: 1, claimedAtMs: HOLD_END_MS, requestedAtMs: HOLD_END_MS + 1, readBackAtMs: null, outcome };
    expect(pauseMayHold(pausedAt({ reopen }), HOLD_DUE_MS)).toBe(true);
  });
});

describe('holdCheckDue around a reopen the command has not finished', () => {
  const underway = { attempts: 1, claimedAtMs: HOLD_DUE_MS, requestedAtMs: HOLD_DUE_MS + 1, readBackAtMs: null, outcome: null };

  it('waits while a sent reopen is younger than the reopen timeout and checks once it is stale', () => {
    expect(holdCheckDue(pausedAt({ reopen: underway }), HOLD_DUE_MS + REOPEN_FUNCTION_TIMEOUT_MS - 1)).toBe(false);
    expect(holdCheckDue(pausedAt({ reopen: underway }), HOLD_DUE_MS + REOPEN_FUNCTION_TIMEOUT_MS)).toBe(true);
  });

  it('checks a pause whose reopen read back reopen-failed, since the pause still stands', () => {
    expect(holdCheckDue(pausedAt({ reopen: { ...underway, readBackAtMs: HOLD_DUE_MS + 2, outcome: 'reopen-failed' } }), HOLD_DUE_MS)).toBe(true);
  });

  it('never becomes due for a hold end dated far ahead, and never reads a window from it', () => {
    expect(holdCheckDue(pausedAt({ holdEndMs: HOLD_END_MS + 365 * DAY_MS }), HOLD_DUE_MS)).toBe(false);
  });
});

describe('holdCheckWindow invariants over every gap a due check can see', () => {
  const holdEnds = [HOLD_BUCKET_MS, HOLD_BUCKET_MS + 1, HOLD_BUCKET_MS + BUCKET_MS - 1];
  const gaps = [HOLD_CHECK_DELAY_MS, BUCKET_MS, 5 * BUCKET_MS, (MAX_WINDOW_BUCKETS - 1) * BUCKET_MS, MAX_WINDOW_BUCKETS * BUCKET_MS, 10 * MAX_WINDOW_BUCKETS * BUCKET_MS];

  it('starts at the hold end bucket, never inverts, never reads past its reach and never claims past now', () => {
    for (const holdEndMs of holdEnds) {
      for (const gap of gaps) {
        const nowMs = holdEndMs + gap;
        const window = holdCheckWindow(holdEndMs, nowMs);
        expect(window.fromBucketMs).toBe(bucketStartMs(holdEndMs));
        expect(window.toBucketMs).toBeGreaterThanOrEqual(window.fromBucketMs);
        expect((window.toBucketMs - window.fromBucketMs) / BUCKET_MS + 1).toBeLessThanOrEqual(MAX_WINDOW_BUCKETS);
        expect(window.checkedThroughMs).toBeGreaterThanOrEqual(window.toBucketMs);
        expect(window.checkedThroughMs).toBeLessThanOrEqual(nowMs);
      }
    }
  });
});

describe('holdFold on stored Send items whose mail time cannot be read', () => {
  it.each([
    ['NaN', Number.NaN],
    ['a fraction', HOLD_END_MS + 0.5],
    ['a numeric string', String(HOLD_END_MS + 1)],
    ['missing', undefined],
    ['null', null],
  ])('counts a Send item whose mail time is %s as one that may follow the hold end', (_case, mailTimestampMs) => {
    expect(sendsCounted([storedSend(mailTimestampMs)])).toBe(1);
  });

  it('still leaves out a readable Send before the hold end', () => {
    expect(sendsCounted([storedSend(HOLD_END_MS - 1)])).toBe(0);
  });

  it('counts exactly over two hundred thousand items', () => {
    const records = Array.from({ length: 200_000 }, (_unused, index) => storedSend(index % 2 === 0 ? HOLD_END_MS + index : HOLD_END_MS - 1 - index));
    expect(sendsCounted(records)).toBe(100_000);
  });
});

describe('the operator email attempt rules leave no email both unsent and unaccounted for', () => {
  const nowMs = HOLD_DUE_MS;

  it('marks spent an email at its attempt limit that holds no claim, so its failure is logged', () => {
    expect(emailAttemptsSpent(claimed({ outcome: 'closed', email: emailOf({ attempts: EMAIL_SEND_ATTEMPTS }) }), nowMs)).toBe(true);
  });

  it('marks spent an email past its attempt limit that holds no claim', () => {
    expect(emailAttemptsSpent(claimed({ outcome: 'closed', email: emailOf({ attempts: EMAIL_SEND_ATTEMPTS + 2 }) }), nowMs)).toBe(true);
  });

  it('is due one attempt exactly at the claim timeout and not a millisecond before', () => {
    const email = emailOf({ attempts: 1, claimedAtMs: nowMs - ACTION_FUNCTION_TIMEOUT_MS });
    expect(emailAttemptDue(claimed({ outcome: 'closed', email }), nowMs)).toBe(true);
    expect(emailAttemptDue(claimed({ outcome: 'closed', email }), nowMs - 1)).toBe(false);
  });

  it('puts every unsent, unfailed email in exactly one of due, spent or waiting on a live claim', () => {
    const claims = [null, nowMs, nowMs - ACTION_FUNCTION_TIMEOUT_MS, nowMs - ACTION_FUNCTION_TIMEOUT_MS + 1, nowMs + DAY_MS];
    const stranded: string[] = [];
    for (let attempts = 0; attempts <= EMAIL_SEND_ATTEMPTS + 2; attempts += 1) {
      for (const claimedAtMs of claims) {
        const closure = claimed({ outcome: 'closed', email: emailOf({ attempts, claimedAtMs }) });
        const due = emailAttemptDue(closure, nowMs);
        const spent = emailAttemptsSpent(closure, nowMs);
        const waiting = claimedAtMs !== null && nowMs < claimedAtMs + ACTION_FUNCTION_TIMEOUT_MS;
        if ([due, spent, waiting].filter(Boolean).length !== 1) stranded.push(`attempts ${attempts}, claim ${String(claimedAtMs)}`);
      }
    }
    expect(stranded).toEqual([]);
  });
});

describe('reserveLaneAttempt counts the UTC hour of the injected clock', () => {
  function laneStore(): { requests: LaneAttemptReservation[]; store: { reserveLaneAttempt(request: LaneAttemptReservation): Promise<'reserved'> } } {
    const requests: LaneAttemptReservation[] = [];
    return {
      requests,
      store: {
        reserveLaneAttempt: async (request) => {
          requests.push(request);
          return 'reserved';
        },
      },
    };
  }

  it('puts the last millisecond of an hour and the first of the next in different hours, across a year end', async () => {
    const { requests, store } = laneStore();
    const lastMs = Date.UTC(2026, 11, 31, 23, 59, 59, 999);
    const first = await reserveLaneAttempt(store, { configurationSet: 'fothering-bulk', nowMs: lastMs });
    const second = await reserveLaneAttempt(store, { configurationSet: 'fothering-bulk', nowMs: lastMs + 1 });
    expect([first.hourEndsAtMs, second.hourEndsAtMs]).toEqual([Date.UTC(2027, 0, 1, 0), Date.UTC(2027, 0, 1, 1)]);
    expect(requests[0]?.key).not.toEqual(requests[1]?.key);
    expect(requests.map((request) => request.cap)).toEqual([LANE_HOUR_ATTEMPT_CAP, LANE_HOUR_ATTEMPT_CAP]);
    expect(requests[0]?.expiresAt).toBe(Math.floor(lastMs / 1000) + RETENTION_SECONDS);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY])('reserves nothing on a clock reading of %s', async (nowMs) => {
    const { requests, store } = laneStore();
    await expect(reserveLaneAttempt(store, { configurationSet: 'fothering-bulk', nowMs })).rejects.toThrow(RangeError);
    expect(requests).toEqual([]);
  });
});

describe('recordUsage refuses amounts that are not counts', () => {
  const bad: [string, unknown][] = [
    ['minus one', -1],
    ['a fraction', 1.5],
    ['NaN', Number.NaN],
    ['infinity', Number.POSITIVE_INFINITY],
    ['two to the 53rd', 2 ** 53],
    ['a numeric string', '5'],
    ['null', null],
  ];

  it.each(bad)('refuses an input token count of %s before the store sees it', async (_case, value) => {
    let calls = 0;
    const store = { recordUsage: async () => (calls += 1) };
    const input = { incidentId: INCIDENT_ID, reservedAtMs: CLAIMED_AT_MS, usage: { inputTokens: value as number, outputTokens: 1 }, modelCalls: 1 };
    await expect(recordUsage(store, input)).rejects.toThrow(RangeError);
    expect(calls).toBe(0);
  });

  it.each(bad)('refuses a model call count of %s before the store sees it', async (_case, value) => {
    let calls = 0;
    const store = { recordUsage: async () => (calls += 1) };
    const input = { incidentId: INCIDENT_ID, reservedAtMs: CLAIMED_AT_MS, usage: { inputTokens: 1, outputTokens: 1 }, modelCalls: value as number };
    await expect(recordUsage(store, input)).rejects.toThrow(RangeError);
    expect(calls).toBe(0);
  });
});

describe('reopenAcceptance boundaries', () => {
  const live = { attempts: 1, claimedAtMs: HOLD_DUE_MS, requestedAtMs: null, readBackAtMs: null, outcome: null };

  it('reads a reopen claim as live until the reopen timeout and accepts again at it', () => {
    expect(reopenAcceptance(pausedAt({ reopen: live }), HOLD_DUE_MS + REOPEN_FUNCTION_TIMEOUT_MS - 1)).toBe('reopen-in-progress');
    expect(reopenAcceptance(pausedAt({ reopen: live }), HOLD_DUE_MS + REOPEN_FUNCTION_TIMEOUT_MS)).toBe('accept');
  });

  it.each(['reopen-failed', 'reopen-unknown'] as const)('accepts the command again after a %s read-back', (outcome) => {
    expect(reopenAcceptance(pausedAt({ reopen: { ...live, requestedAtMs: HOLD_DUE_MS + 1, readBackAtMs: HOLD_DUE_MS + 2, outcome } }), HOLD_DUE_MS)).toBe('accept');
  });

  it.each(['pause-failed', 'refused', 'dry-run', null] as const)('never reopens a closure whose outcome is %s', (outcome) => {
    expect(reopenAcceptance(claimed({ outcome }), HOLD_DUE_MS)).toBe('not-reopenable');
  });
});

describe('the reopen payload accepts one lane-map set name and nothing else', () => {
  const unicodeHyphen = `fothering${String.fromCodePoint(0x2010)}bulk`;
  const fullWidthF = `${String.fromCodePoint(0xff46)}othering-bulk`;

  it('accepts the plain payload', () => {
    expect(reopenPayloadSchema.safeParse(JSON.parse('{"configurationSet":"fothering-bulk"}')).success).toBe(true);
  });

  it.each([
    ['a trailing newline', JSON.stringify({ configurationSet: 'fothering-bulk\n' })],
    ['a Unicode hyphen', JSON.stringify({ configurationSet: unicodeHyphen })],
    ['a full-width letter', JSON.stringify({ configurationSet: fullWidthF })],
    ['a path', JSON.stringify({ configurationSet: '../../etc/passwd' })],
    ['markup', JSON.stringify({ configurationSet: '<script>alert(1)</script>' })],
    ['65 characters', JSON.stringify({ configurationSet: 'a'.repeat(65) })],
    ['an empty name', JSON.stringify({ configurationSet: '' })],
    ['an extra field', '{"configurationSet":"fothering-bulk","force":true}'],
    ['a __proto__ field', '{"__proto__":{"admin":true},"configurationSet":"fothering-bulk"}'],
    ['a list of names', '{"configurationSet":["fothering-bulk"]}'],
    ['a bare string', '"fothering-bulk"'],
    ['null', 'null'],
  ])('refuses %s', (_case, text) => {
    expect(reopenPayloadSchema.safeParse(JSON.parse(text)).success).toBe(false);
  });
});

describe('stored closures, pointers and decisions that no writer produces', () => {
  const roundTrip = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

  it('parses a claim that went through the table, as a control', () => {
    expect(parseClosure(roundTrip(claimed()))).toEqual(claimed());
  });

  it.each([
    ['a negative claim time', { claimedAtMs: -1 }],
    ['a claim time past the safe range', { claimedAtMs: 2 ** 53 }],
    ['a claim time as text', { claimedAtMs: String(CLAIMED_AT_MS) }],
    ['a negative version', { version: -1 }],
    ['a read-back of the text false', { readBack: 'false' }],
    ['a set name with a newline', { configurationSet: 'fothering-bulk\n' }],
    ['a partition key naming another incident', { pk: `INCIDENT#${'a'.repeat(32)}` }],
    ['an upper-cased incident id', { incidentId: INCIDENT_ID.toUpperCase(), pk: `INCIDENT#${INCIDENT_ID.toUpperCase()}` }],
    ['an attribute the schema does not know', { note: 'set by hand' }],
  ])('reads a closure with %s as unreadable', (_case, override) => {
    expect(parseClosure(roundTrip({ ...claimed(), ...override }))).toBeUndefined();
  });

  it.each([
    ['a negative version', { incidentId: INCIDENT_ID, version: -1 }],
    ['a fractional version', { incidentId: INCIDENT_ID, version: 1.5 }],
    ['a version as text', { incidentId: INCIDENT_ID, version: '0' }],
    ['a short incident id', { incidentId: INCIDENT_ID.slice(1), version: 0 }],
  ])('reads a pause pointer with %s as unreadable, which holds the lane', (_case, item) => {
    expect(pausePointerOf(item)).toBeUndefined();
  });

  it.each([
    ['an upper-case outcome', '{"outcome":"CLOSE"}'],
    ['an outcome behind __proto__', '{"__proto__":{"outcome":"close"}}'],
    ['a list', '["close"]'],
    ['an outcome with a space', '{"outcome":" close"}'],
  ])('reads a decision with %s as unreadable', (_case, text) => {
    expect(decisionOf(JSON.parse(text))).toBeUndefined();
  });
});

describe('checkCloseability on lookalike streams and split destinations', () => {
  const laneMap = parseLaneMap(lanesJson);
  const bulk = laneMap.lanes.find((lane) => lane.configurationSet === 'fothering-bulk');
  const declared = bulk?.declaredStreams[0] ?? 'missing-declared-stream';
  const allTypes = [...REQUIRED_EVENT_TYPES];

  function observedWith(streams: readonly string[]): ReadonlyMap<string, ObservedLaneFacts> {
    return new Map([
      [
        'fothering-bulk',
        {
          recordCount: 10,
          streamTagValues: new Set(streams),
          recordsWithoutValidStream: 0,
          callerIdentities: new Set(['arn:aws:iam::111122223333:user/bulk-sender']),
          recordsWithoutCaller: 0,
          completeBucketsHoldSendsWithoutOutcomes: false,
        },
      ],
    ]);
  }

  function sesWith(destinations: SesConfigurationFacts['eventDestinations']): SesConfigurationFacts {
    return { configurationSets: new Set(laneMap.lanes.map((lane) => lane.configurationSet)), defaultConfigurationSets: new Set(), eventDestinations: destinations };
  }

  const fullDestination = new Map([['fothering-bulk', [{ enabled: true, eventBridge: true, matchingEventTypes: allTypes }]]]);

  it('closes the bulk lane with its declared stream and one full destination, as a control', () => {
    expect(checkCloseability('fothering-bulk', { laneMap, observed: observedWith([declared]), ses: sesWith(fullDestination) }).state).toBe('closeable');
  });

  it('refuses a stream value that only looks like the declared one', () => {
    const lookalike = `${declared.normalize('NFD')}${String.fromCodePoint(0x200b)}`;
    const result = checkCloseability('fothering-bulk', { laneMap, observed: observedWith([lookalike]), ses: sesWith(fullDestination) });
    expect(result).toEqual({ state: 'refused', reasons: ['observed-stream-undeclared'] });
  });

  it('accepts two enabled EventBridge destinations that split the six types between them', () => {
    const split = new Map([
      [
        'fothering-bulk',
        [
          { enabled: true, eventBridge: true, matchingEventTypes: allTypes.slice(0, 3) },
          { enabled: true, eventBridge: true, matchingEventTypes: allTypes.slice(3) },
        ],
      ],
    ]);
    expect(checkCloseability('fothering-bulk', { laneMap, observed: observedWith([declared]), ses: sesWith(split) }).state).toBe('closeable');
  });

  it.each([
    ['lower-cased type names', [{ enabled: true, eventBridge: true, matchingEventTypes: allTypes.map((type) => type.toLowerCase()) }]],
    ['type names with a trailing space', [{ enabled: true, eventBridge: true, matchingEventTypes: allTypes.map((type) => `${type} `) }]],
    ['all six on a disabled destination and on a non-EventBridge one', [
      { enabled: false, eventBridge: true, matchingEventTypes: allTypes },
      { enabled: true, eventBridge: false, matchingEventTypes: allTypes },
    ]],
  ])('refuses a set whose destinations publish %s', (_case, destinations) => {
    const result = checkCloseability('fothering-bulk', { laneMap, observed: observedWith([declared]), ses: sesWith(new Map([['fothering-bulk', destinations]])) });
    expect(result).toEqual({ state: 'refused', reasons: ['destination-missing-event-types'] });
  });
});
