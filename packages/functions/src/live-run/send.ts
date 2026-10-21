import type { LiveRunDeps } from './root.js';

export interface SendStepRequest {
  runId: string;
  scenarioName: string;
  stepName: string;
  from: string;
  accountProfile: string;
  laneProfiles: ReadonlyMap<string, string>;
}

export async function runSendStep(_deps: LiveRunDeps, _request: SendStepRequest): Promise<number> {
  return 1;
}
