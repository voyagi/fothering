import { incidentLimitSentence, reputationResetSentence, type ReopenRefusal, type ReopenResult } from '@fothering/core/reopen';
import type { ReopenDeps } from './root.js';

export interface ReopenReport {
  result: ReopenResult;
  reason?: ReopenRefusal;
  configurationSet: string;
  requestedAtMs?: number;
  readBackAtMs?: number;
  capHourEndsAt?: string;
  note: string;
  limit: string;
}

export async function reopenLane(deps: ReopenDeps, configurationSet: string): Promise<ReopenReport> {
  await deps.wait(0);
  return {
    result: 'refused',
    reason: 'no-fothering-pause',
    configurationSet,
    note: reputationResetSentence(configurationSet),
    limit: incidentLimitSentence(configurationSet),
  };
}
