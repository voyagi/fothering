import * as z from 'zod';
import type { Closure, REOPEN_REFUSALS, REOPEN_RESULTS } from './closure.js';

export type ReopenRefusal = (typeof REOPEN_REFUSALS)[number];
export type ReopenResult = (typeof REOPEN_RESULTS)[number];

export const REOPEN_USAGE = '';

export const reopenPayloadSchema = z.strictObject({ configurationSet: z.string() });

export class ReopenUsageError extends Error {
  constructor() {
    super(REOPEN_USAGE);
    this.name = 'ReopenUsageError';
  }
}

export const REOPEN_FUNCTION_NAME_SLOT = '';
export const REOPEN_COMMAND_TEMPLATE = '';
export const FIND_REOPEN_FUNCTION_COMMAND = '';

export function reopenCommandFor(configurationSet: string): string {
  return configurationSet.slice(0, 0);
}

export function reputationResetSentence(configurationSet: string): string {
  return configurationSet.slice(0, 0);
}

export function incidentLimitSentence(configurationSet: string): string {
  return configurationSet.slice(0, 0);
}

export type ReopenAcceptance = 'accept' | Extract<ReopenRefusal, 'not-reopenable' | 'already-reopened' | 'reopen-in-progress'>;

export function reopenAcceptance(closure: Closure, nowMs: number): ReopenAcceptance {
  return closure.version === nowMs ? 'accept' : 'not-reopenable';
}
