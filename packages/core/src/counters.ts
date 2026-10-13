import { counterDayKey, incidentItemKey } from './evidence-record.js';
import { MODEL_VALUES, TOKEN_RESERVATION_PER_INVOCATION } from './model-values.js';
import { RETENTION_SECONDS, type RecordKey } from './records.js';

/** The claim one invocation makes on its incident counter and its UTC-day counter (D-67). */
export interface CounterReservation {
  incidentKey: RecordKey;
  dayKey: RecordKey;
  incidentCap: number;
  dayInvocationCap: number;
  dayTokenCap: number;
  tokenReservation: number;
  expiresAt: number;
}

/** Structural, so core imports nothing from providers; the decision store port satisfies it as it is. */
export interface CounterStore<Result> {
  reserveInvocation(request: CounterReservation): Promise<Result>;
}

export interface ReserveInput {
  incidentId: string;
  nowMs: number;
}

// The day is the UTC date of the injected clock, never the host's local date (AC-E47).
function utcDateOf(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

/** Every number the reservation carries is computed here, so no caller can pass a cap of its own. */
export function reserveInvocation<Result>(store: CounterStore<Result>, input: ReserveInput): Promise<Result> {
  return store.reserveInvocation({
    incidentKey: incidentItemKey(input.incidentId, 'COUNTER'),
    dayKey: counterDayKey(utcDateOf(input.nowMs)),
    incidentCap: MODEL_VALUES.perIncidentInvocations,
    dayInvocationCap: MODEL_VALUES.perDayInvocations,
    dayTokenCap: MODEL_VALUES.perDayTokenReservations,
    tokenReservation: TOKEN_RESERVATION_PER_INVOCATION,
    expiresAt: Math.floor(input.nowMs / 1000) + RETENTION_SECONDS,
  });
}
