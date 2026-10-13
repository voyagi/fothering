import type { AgentAnswer, AgentUnavailableReason } from '@fothering/core/agent-answer';
import type { LaneVerdict } from '@fothering/core/verdicts';
import type { DetectDeps } from './root.js';

export interface DetectionCycleSummary {
  lanes: { configurationSet: string; verdict: LaneVerdict }[];
  incidentsOpened: number;
  invocations: number;
  sesReads: number;
  dnsLookups: number;
  outcomes: { incidentId: string; result: AgentAnswer['decision'] | AgentUnavailableReason }[];
}

export async function runDetectionCycle(deps: DetectDeps): Promise<DetectionCycleSummary> {
  void deps;
  return { lanes: [], incidentsOpened: 0, invocations: 0, sesReads: 0, dnsLookups: 0, outcomes: [] };
}
