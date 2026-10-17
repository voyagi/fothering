import type { ClosureOutcome } from '@fothering/core/closure';
import type { ActionDeps } from './root.js';

export interface ActionRunSummary {
  acted: { incidentId: string; outcome: ClosureOutcome }[];
}

export async function runActionCycle(deps: ActionDeps): Promise<ActionRunSummary> {
  void deps;
  return { acted: [] };
}
