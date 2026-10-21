import type { CallerIdentity, LiveRunAccount, LiveRunPortFactory, LiveRunSendRequest } from '../live-run-port-types.js';

export type FixtureSendAnswer = 'accept' | { errorName: string };

export type FixtureLiveRunCall =
  | { operation: 'getCallerIdentity'; profile: string }
  | { operation: 'getAccount'; profile: string }
  | { operation: 'sendEmail'; profile: string; request: LiveRunSendRequest };

export interface FixtureLiveRunState {
  callers: Map<string, CallerIdentity>;
  account: LiveRunAccount;
  sendAnswers: FixtureSendAnswer[];
  calls: FixtureLiveRunCall[];
  constructions: number;
}

export function createFixtureLiveRunState(): FixtureLiveRunState {
  return {
    callers: new Map(),
    account: { vdmEnabled: 'absent', productionAccessEnabled: 'absent', maxSendRate: 'absent', requestId: 'absent' },
    sendAnswers: [],
    calls: [],
    constructions: 0,
  };
}

export function createFixtureLiveRunPorts(_state: FixtureLiveRunState): LiveRunPortFactory {
  throw new Error('not implemented');
}
