import { brandPort } from '../port-types.js';
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

function namedError(name: string, message: string): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

// Every port built counts as a construction, so a test can prove a refusal came before any port
// existed. A scripted send error carries the SDK exception type as its name, which is all the
// command may record of it.
export function createFixtureLiveRunPorts(state: FixtureLiveRunState): LiveRunPortFactory {
  return {
    ses(profile) {
      state.constructions += 1;
      return brandPort(
        {
          async getAccount() {
            state.calls.push({ operation: 'getAccount', profile });
            return { ...state.account };
          },
          async sendEmail(request: LiveRunSendRequest) {
            state.calls.push({ operation: 'sendEmail', profile, request: { ...request, tags: request.tags.map((tag) => ({ ...tag })) } });
            const attempt = state.calls.filter((call) => call.operation === 'sendEmail').length;
            const answer = state.sendAnswers.shift() ?? 'accept';
            if (answer !== 'accept') throw namedError(answer.errorName, `the fixture SES was scripted to answer attempt ${attempt} with an error`);
            return { messageId: `fixture-message-${attempt}`, requestId: `fixture-request-${attempt}` };
          },
        },
        'fixture',
      );
    },
    callerIdentity(profile) {
      state.constructions += 1;
      return brandPort(
        {
          async getCallerIdentity() {
            state.calls.push({ operation: 'getCallerIdentity', profile });
            const caller = state.callers.get(profile);
            if (caller === undefined) throw namedError('FixtureCallerMissing', 'the fixture holds no caller for that profile');
            return { ...caller };
          },
        },
        'fixture',
      );
    },
  };
}
