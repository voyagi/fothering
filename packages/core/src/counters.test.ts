import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { createFixtureDecisionStore, createFixtureTableState } from '@fothering/providers/fixtures/ingest-ports';
import type { FixtureTableState, UsageRecord } from '@fothering/providers/port-types';
import { LANE_HOUR_ATTEMPT_CAP } from './close-values.js';
import * as counters from './counters.js';
import { recordUsage, reserveInvocation, reserveLaneAttempt, type CounterReservation, type LaneAttemptReservation } from './counters.js';
import { counterDayKey, counterLaneHourKey, incidentItemKey } from './evidence-record.js';
import { MODEL_VALUES, TOKEN_RESERVATION_PER_INVOCATION } from './model-values.js';
import { RETENTION_SECONDS } from './records.js';
import { propertySeed } from './test/property-seed.js';

const SEED = propertySeed();
const NOW_MS = Date.UTC(2026, 9, 11, 12, 2, 0);
const LAST_MS_OF_DAY = Date.UTC(2026, 9, 11, 23, 59, 59, 999);
const FIRST_MS_OF_NEXT_DAY = Date.UTC(2026, 9, 12, 0, 0, 0, 0);
const DAY = counterDayKey('2026-10-11');
const NEXT_DAY = counterDayKey('2026-10-12');
const USAGE = { inputTokens: 1_850, outputTokens: 96 };

function incidentIdOf(index: number): string {
  return index.toString(16).padStart(32, '0');
}

function counterOf(table: FixtureTableState, key: { pk: string; sk: string }): Record<string, unknown> | undefined {
  return table.items.get(`${key.pk}\u0000${key.sk}`) as Record<string, unknown> | undefined;
}

function storeOver(table: FixtureTableState = createFixtureTableState()) {
  return { table, store: createFixtureDecisionStore({ store: table }) };
}

async function reserveTimes(store: ReturnType<typeof createFixtureDecisionStore>, incidentId: string, times: number, nowMs = NOW_MS): Promise<void> {
  for (let index = 0; index < times; index += 1) {
    expect(await reserveInvocation(store, { incidentId, nowMs })).toEqual({ ok: true });
  }
}

describe('the counter module only reserves and records (AC-22)', () => {
  // Widened by one in phase 3: reserveLaneAttempt is the only way a lane-hour counter moves (D-99).
  it('exports exactly reserveInvocation, recordUsage and reserveLaneAttempt as its functions', () => {
    const functions = Object.entries(counters)
      .filter(([, value]) => typeof value === 'function')
      .map(([name]) => name)
      .sort();
    expect(functions.join(',')).toBe('recordUsage,reserveInvocation,reserveLaneAttempt');
  });

  it('never lowers, resets or deletes a counter attribute over any sequence of reserve, record and lane attempt calls', async () => {
    const step = fc.oneof(
      fc.record({ kind: fc.constant('reserve' as const), incident: fc.integer({ min: 0, max: 2 }), dayOffsetMs: fc.constantFrom(0, 86_400_000) }),
      // D-99: a lane-hour counter is a counter too, so it joins the sequences.
      fc.record({
        kind: fc.constant('lane' as const),
        configurationSet: fc.constantFrom('fothering-bulk', 'fothering-transactional'),
        hourOffsetMs: fc.constantFrom(0, 3_600_000),
      }),
      fc.record({
        kind: fc.constant('record' as const),
        incident: fc.integer({ min: 0, max: 2 }),
        dayOffsetMs: fc.constantFrom(0, 86_400_000),
        inputTokens: fc.integer({ min: -2, max: 5_000 }),
        outputTokens: fc.integer({ min: 0, max: 1_024 }),
        modelCalls: fc.oneof(fc.integer({ min: 0, max: 3 }), fc.constant(0.5)),
      }),
    );
    await fc.assert(
      fc.asyncProperty(fc.array(step, { minLength: 1, maxLength: 25 }), async (steps) => {
        const { table, store } = storeOver();
        let previous = new Map<string, Record<string, number>>();
        for (const action of steps) {
          if (action.kind === 'lane') {
            await reserveLaneAttempt(store, { configurationSet: action.configurationSet, nowMs: NOW_MS + action.hourOffsetMs });
          } else if (action.kind === 'reserve') {
            await reserveInvocation(store, { incidentId: incidentIdOf(action.incident), nowMs: NOW_MS + action.dayOffsetMs });
          } else {
            const usage = { inputTokens: action.inputTokens, outputTokens: action.outputTokens };
            const input = { incidentId: incidentIdOf(action.incident), reservedAtMs: NOW_MS + action.dayOffsetMs, usage, modelCalls: action.modelCalls };
            await recordUsage(store, input).catch((error: unknown) => {
              if (!(error instanceof RangeError)) throw error;
            });
          }
          const current = new Map<string, Record<string, number>>();
          for (const [key, item] of table.items) {
            const numbers = Object.fromEntries(Object.entries(item as Record<string, unknown>).filter(([, value]) => typeof value === 'number')) as Record<string, number>;
            current.set(key, numbers);
          }
          for (const [key, before] of previous) {
            const after = current.get(key);
            if (after === undefined) return false;
            for (const [attribute, value] of Object.entries(before)) {
              if ((after[attribute] ?? Number.NEGATIVE_INFINITY) < value) return false;
            }
          }
          previous = current;
        }
        return true;
      }),
      { seed: SEED },
    );
  });
});

describe('recordUsage adds actual usage to the counters its reservation made (D-67, AC-E35)', () => {
  it('adds inputTokens, outputTokens and modelCalls to the incident and the day counter', async () => {
    const { table, store } = storeOver();
    const incidentId = incidentIdOf(1);
    await reserveTimes(store, incidentId, 1);
    const result = await recordUsage(store, { incidentId, reservedAtMs: NOW_MS, usage: USAGE, modelCalls: 2 });
    await recordUsage(store, { incidentId, reservedAtMs: NOW_MS, usage: USAGE, modelCalls: 1 });

    expect(result).toBe('recorded');
    for (const key of [incidentItemKey(incidentId, 'COUNTER'), DAY]) {
      expect(counterOf(table, key)).toMatchObject({ invocations: 1, inputTokens: 3_700, outputTokens: 192, modelCalls: 3 });
    }
  });

  it('refuses a negative or non-integer value with a RangeError before calling the store', async () => {
    const calls: UsageRecord[] = [];
    const store = {
      recordUsage: async (usage: UsageRecord) => {
        calls.push(usage);
        return 'recorded' as const;
      },
    };
    const incidentId = incidentIdOf(1);
    const bad = [
      { usage: { inputTokens: -1, outputTokens: 0 }, modelCalls: 1 },
      { usage: { inputTokens: 1.5, outputTokens: 0 }, modelCalls: 1 },
      { usage: { inputTokens: 1, outputTokens: Number.NaN }, modelCalls: 1 },
      { usage: { inputTokens: 1, outputTokens: 1 }, modelCalls: -1 },
      { usage: { inputTokens: 1, outputTokens: 1 }, modelCalls: 0.5 },
    ];
    for (const values of bad) {
      await expect(recordUsage(store, { incidentId, reservedAtMs: NOW_MS, ...values })).rejects.toThrow(RangeError);
    }
    expect(calls.length).toBe(0);
  });

  it('names the refused field in the RangeError, so a log line says which count was wrong', async () => {
    const store = { recordUsage: async () => 'recorded' as const };
    const incidentId = incidentIdOf(1);
    const cases = [
      ['inputTokens', { usage: { inputTokens: -1, outputTokens: 0 }, modelCalls: 1 }],
      ['outputTokens', { usage: { inputTokens: 0, outputTokens: -1 }, modelCalls: 1 }],
      ['modelCalls', { usage: { inputTokens: 0, outputTokens: 0 }, modelCalls: -1 }],
    ] as const;
    for (const [name, values] of cases) {
      await expect(recordUsage(store, { incidentId, reservedAtMs: NOW_MS, ...values })).rejects.toThrow(`${name} must be a whole number from 0 up`);
    }
  });

  it('records on the day counter its reservation used when the call ends after midnight UTC (orchestrator extra 2)', async () => {
    const { table, store } = storeOver();
    const incidentId = incidentIdOf(2);
    await reserveTimes(store, incidentId, 1, LAST_MS_OF_DAY);
    const result = await recordUsage(store, { incidentId, reservedAtMs: LAST_MS_OF_DAY, usage: USAGE, modelCalls: 1 });

    expect(result).toBe('recorded');
    expect(counterOf(table, DAY)).toMatchObject({ invocations: 1, inputTokens: 1_850, outputTokens: 96, modelCalls: 1 });
    expect(counterOf(table, NEXT_DAY)).toBeUndefined();
    // The clock at recording time names a day no reservation created, which the store refuses.
    expect(await recordUsage(store, { incidentId, reservedAtMs: FIRST_MS_OF_NEXT_DAY, usage: USAGE, modelCalls: 1 })).toBe('not-reserved');
  });
});

describe('reserveInvocation holds both caps at the day boundaries (D-67, D-76)', () => {
  it('refuses an incident at its cap on a day at its cap once, naming both (AC-E45)', async () => {
    const { store } = storeOver();
    await reserveTimes(store, incidentIdOf(1), MODEL_VALUES.perIncidentInvocations);
    await reserveTimes(store, incidentIdOf(2), MODEL_VALUES.perDayInvocations - MODEL_VALUES.perIncidentInvocations);
    expect(await reserveInvocation(store, { incidentId: incidentIdOf(1), nowMs: NOW_MS })).toEqual({ ok: false, reason: 'cap', items: ['incident', 'day'] });
  });

  it('asks the store to expire both counters RETENTION_SECONDS after the reservation, in epoch seconds', async () => {
    const requests: CounterReservation[] = [];
    const store = {
      reserveInvocation: async (request: CounterReservation) => {
        requests.push(request);
        return { ok: true } as const;
      },
    };
    await reserveInvocation(store, { incidentId: incidentIdOf(1), nowMs: NOW_MS });
    expect(requests.map((request) => request.expiresAt)).toEqual([Math.floor(NOW_MS / 1000) + RETENTION_SECONDS]);
  });

  it('creates the day counter at one invocation and 64,512 token reservations on the first call of a UTC day (AC-E46)', async () => {
    const { table, store } = storeOver();
    await reserveTimes(store, incidentIdOf(1), 1);
    expect(TOKEN_RESERVATION_PER_INVOCATION).toBe(64_512);
    expect(counterOf(table, DAY)).toMatchObject({ invocations: 1, tokenReservations: 64_512 });
  });

  it('counts 23:59:59.999 UTC on its day and 00:00:00.000 UTC on the next, from the injected clock (AC-E47)', async () => {
    const { table, store } = storeOver();
    await reserveTimes(store, incidentIdOf(1), 1, LAST_MS_OF_DAY);
    await reserveTimes(store, incidentIdOf(1), 1, FIRST_MS_OF_NEXT_DAY);
    expect([counterOf(table, DAY)?.invocations, counterOf(table, NEXT_DAY)?.invocations]).toEqual([1, 1]);
  });

  it('lets a counter one below its cap pass once and refuses it at the cap (AC-E48)', async () => {
    const { store } = storeOver();
    await reserveTimes(store, incidentIdOf(1), MODEL_VALUES.perIncidentInvocations - 1);
    expect(await reserveInvocation(store, { incidentId: incidentIdOf(1), nowMs: NOW_MS })).toEqual({ ok: true });
    expect(await reserveInvocation(store, { incidentId: incidentIdOf(1), nowMs: NOW_MS })).toEqual({ ok: false, reason: 'cap', items: ['incident'] });

    const fresh = storeOver().store;
    for (let index = 0; index < MODEL_VALUES.perDayInvocations - 1; index += 1) await reserveTimes(fresh, incidentIdOf(10 + index), 1);
    expect(await reserveInvocation(fresh, { incidentId: incidentIdOf(30), nowMs: NOW_MS })).toEqual({ ok: true });
    expect(await reserveInvocation(fresh, { incidentId: incidentIdOf(31), nowMs: NOW_MS })).toEqual({ ok: false, reason: 'cap', items: ['day'] });
  });

  it('lets exactly one of ten callers racing at one below a cap through (AC-E49)', async () => {
    const { store } = storeOver();
    await reserveTimes(store, incidentIdOf(1), MODEL_VALUES.perIncidentInvocations - 1);
    const incidentRace = await Promise.all(Array.from({ length: 10 }, () => reserveInvocation(store, { incidentId: incidentIdOf(1), nowMs: NOW_MS })));
    expect(incidentRace.filter((result) => result.ok).length).toBe(1);

    const day = storeOver().store;
    for (let index = 0; index < MODEL_VALUES.perDayInvocations - 1; index += 1) await reserveTimes(day, incidentIdOf(10 + index), 1);
    const dayRace = await Promise.all(Array.from({ length: 10 }, (_, index) => reserveInvocation(day, { incidentId: incidentIdOf(40 + index), nowMs: NOW_MS })));
    expect(dayRace.filter((result) => result.ok).length).toBe(1);
  });

  it('passes six reservations of one day and refuses the seventh, which both the invocation and the token cap refuse alone', async () => {
    expect(6 * TOKEN_RESERVATION_PER_INVOCATION <= MODEL_VALUES.perDayTokenReservations).toBe(true);
    expect(7 * TOKEN_RESERVATION_PER_INVOCATION > MODEL_VALUES.perDayTokenReservations).toBe(true);
    const { store } = storeOver();
    for (let index = 0; index < 6; index += 1) await reserveTimes(store, incidentIdOf(index), 1);
    expect(await reserveInvocation(store, { incidentId: incidentIdOf(6), nowMs: NOW_MS })).toEqual({ ok: false, reason: 'cap', items: ['day'] });

    const dayKey = `${DAY.pk}\u0000${DAY.sk}`;
    const tokensOnly = createFixtureTableState();
    tokensOnly.items.set(dayKey, { ...DAY, invocations: 0, tokenReservations: 6 * TOKEN_RESERVATION_PER_INVOCATION, expiresAt: 1 });
    expect(await reserveInvocation(storeOver(tokensOnly).store, { incidentId: incidentIdOf(7), nowMs: NOW_MS })).toEqual({ ok: false, reason: 'cap', items: ['day'] });

    const invocationsOnly = createFixtureTableState();
    invocationsOnly.items.set(dayKey, { ...DAY, invocations: 6, tokenReservations: 0, expiresAt: 1 });
    expect(await reserveInvocation(storeOver(invocationsOnly).store, { incidentId: incidentIdOf(7), nowMs: NOW_MS })).toEqual({ ok: false, reason: 'cap', items: ['day'] });
  });
});

const BULK = 'fothering-bulk';
const LAST_MS_OF_HOUR = Date.UTC(2026, 9, 11, 12, 59, 59, 999);
const FIRST_MS_OF_NEXT_HOUR = Date.UTC(2026, 9, 11, 13, 0, 0, 0);

function recordingLaneStore(answer: 'reserved' | 'cap' = 'reserved') {
  const requests: LaneAttemptReservation[] = [];
  return {
    requests,
    store: {
      reserveLaneAttempt: async (request: LaneAttemptReservation) => {
        requests.push(request);
        return answer;
      },
    },
  };
}

function registerLaneHourCases(): void {
  it('counts 12:59:59.999 UTC in hour T12 and 13:00:00.000 UTC in hour T13, from the injected clock (AC-E12)', async () => {
    const { requests, store } = recordingLaneStore();
    const before = await reserveLaneAttempt(store, { configurationSet: BULK, nowMs: LAST_MS_OF_HOUR });
    const after = await reserveLaneAttempt(store, { configurationSet: BULK, nowMs: FIRST_MS_OF_NEXT_HOUR });

    expect(requests.map((request) => request.key)).toEqual([counterLaneHourKey(BULK, '2026-10-11T12'), counterLaneHourKey(BULK, '2026-10-11T13')]);
    expect(requests[0]?.key.pk).toBe('COUNTER_LANE_HOUR#fothering-bulk#2026-10-11T12');
    expect([before.hourEndsAtMs, after.hourEndsAtMs]).toEqual([FIRST_MS_OF_NEXT_HOUR, Date.UTC(2026, 9, 11, 14)]);
  });

  it('answers the hour end of NOW_MS as 13:00 UTC', async () => {
    const { store } = recordingLaneStore();
    expect((await reserveLaneAttempt(store, { configurationSet: BULK, nowMs: NOW_MS })).hourEndsAtMs).toBe(FIRST_MS_OF_NEXT_HOUR);
  });
}

describe('reserveLaneAttempt computes every number of a lane-hour reservation itself (D-99)', () => {
  it('asks for the lane-hour key, the cap and a 30-day expiry, and answers the store outcome with the hour end', async () => {
    const { requests, store } = recordingLaneStore();
    const answer = await reserveLaneAttempt(store, { configurationSet: BULK, nowMs: NOW_MS });

    expect(requests).toEqual([
      { key: { pk: 'COUNTER_LANE_HOUR#fothering-bulk#2026-10-11T12', sk: 'COUNTER' }, cap: LANE_HOUR_ATTEMPT_CAP, expiresAt: Math.floor(NOW_MS / 1000) + RETENTION_SECONDS },
    ]);
    expect(answer).toEqual({ outcome: 'reserved', hourEndsAtMs: FIRST_MS_OF_NEXT_HOUR });
  });

  it('passes a cap answer through unchanged', async () => {
    const { store } = recordingLaneStore('cap');
    expect((await reserveLaneAttempt(store, { configurationSet: BULK, nowMs: NOW_MS })).outcome).toBe('cap');
  });

  it.each(['2026-10-11T1', '2026-10-11 12'])('refuses the hour %j with a RangeError', (hour) => {
    expect(() => counterLaneHourKey(BULK, hour)).toThrow(RangeError);
  });

  registerLaneHourCases();
});

// The same cases with the host clock moved off UTC (T-03-13): the hour comes from the epoch
// milliseconds through toISOString, so the keys are identical. Stryker's worker threads cannot move
// the timezone (buckets.property.test.ts), so this runs only outside the mutation run.
describe.skipIf(process.env.STRYKER_MUTATOR_WORKER !== undefined)('the lane-hour keys under Asia/Kolkata (R5 backstop)', () => {
  let originalTz: string | undefined;

  beforeAll(() => {
    originalTz = process.env.TZ;
    process.env.TZ = 'Asia/Kolkata';
    // Positive control: the worker really moved before any case below is trusted (UTC+5:30, no DST).
    expect(new Date(0).getTimezoneOffset()).toBe(-330);
  });

  afterAll(() => {
    if (originalTz === undefined) delete process.env.TZ;
    else process.env.TZ = originalTz;
  });

  registerLaneHourCases();
});
