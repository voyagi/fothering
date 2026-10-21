import type { DnsMxOutcome, DnsTxtOutcome } from '@fothering/core/evidence-rows';
import type {
  AgentCorePort,
  AgentRuntimeRequest,
  BedrockModelPort,
  DnsPort,
  EmailIdentityFacts,
  EventDestinationFact,
  FixtureSesState,
  Recording,
  ReplyBucketPort,
  SesPort,
} from '../port-types.js';
import { brandPort } from '../port-types.js';
import { createAgentCoreDryRun, createBedrockModelDryRun, createSesDryRun, type DryRunLog } from '../dry-run.js';
import { FixtureMissError, recordedPort } from './recorded.js';

export interface FixtureRecordingOptions {
  recordings: readonly Recording[];
}

export interface FixtureMutatingOptions extends FixtureRecordingOptions {
  dryRun: DryRunLog;
}

export interface FixtureSesOptions extends FixtureMutatingOptions {
  state?: FixtureSesState | undefined;
}

export class FixtureSesFault extends Error {
  constructor(operation: string) {
    super(`the fixture SES was scripted to fail ${operation}`);
    this.name = 'FixtureSesFault';
  }
}

export function createFixtureSesState(): FixtureSesState {
  return { sendingEnabled: new Map(), putFaults: new Map(), getAnswers: new Map(), sendAnswers: [], calls: [] };
}

// The put and the read-back keep separate state: the put moves sendingEnabled, and the read-back
// answers a scripted override when one is set for the set, so a test can make SES accept a put and
// still read the set as sending (AC-3). Unscripted, the read-back follows the put.
function fixtureSesWrites(state: FixtureSesState, dryRun: DryRunLog): Pick<
  SesPort,
  'getConfigurationSetSending' | 'pauseConfigurationSet' | 'reopenConfigurationSet' | 'sendEmail'
> {
  const recorder = createSesDryRun(dryRun);
  const put = (configurationSet: string, sendingEnabled: boolean): void => {
    state.calls.push(`put-issued:${configurationSet}:${String(sendingEnabled)}`);
    if (state.putFaults.has(configurationSet)) throw new FixtureSesFault('PutConfigurationSetSendingOptions');
    state.sendingEnabled.set(configurationSet, sendingEnabled);
    state.calls.push(`put-resolved:${configurationSet}:${String(sendingEnabled)}`);
  };
  return {
    async getConfigurationSetSending(configurationSet) {
      state.calls.push(`get-issued:${configurationSet}`);
      const scripted = state.getAnswers.get(configurationSet);
      if (scripted === 'throw') throw new FixtureSesFault('GetConfigurationSet');
      // A set Fothering never paused is sending, as every configuration set is when created.
      const answer = scripted === 'missing' ? {} : { sendingEnabled: scripted ?? state.sendingEnabled.get(configurationSet) ?? true };
      state.calls.push(`get-resolved:${configurationSet}`);
      return answer;
    },
    async pauseConfigurationSet(configurationSet) {
      await recorder.pauseConfigurationSet(configurationSet);
      put(configurationSet, false);
    },
    async reopenConfigurationSet(configurationSet) {
      await recorder.reopenConfigurationSet(configurationSet);
      put(configurationSet, true);
    },
    async sendEmail(request) {
      await recorder.sendEmail(request);
      state.calls.push('send-issued');
      if ((state.sendAnswers.shift() ?? 'accept') === 'throw') throw new FixtureSesFault('SendEmail');
      state.calls.push('send-resolved');
      const sent = state.calls.filter((call) => call === 'send-resolved').length;
      return { messageId: `fixture-message-${sent}` };
    },
  };
}

// Reads answer from recordings and throw on an unrecorded request; every write leaves its one dry-run
// line before it touches the fixture state.
export function createFixtureSes(options: FixtureSesOptions): SesPort {
  const recorded = recordedPort(options.recordings);
  return brandPort(
    {
      async getEmailIdentity(emailIdentity: string) {
        return recorded.respond<EmailIdentityFacts | undefined>('ses.getEmailIdentity', emailIdentity);
      },
      async listEmailIdentities() {
        return recorded.respond<string[]>('ses.listEmailIdentities', undefined);
      },
      async listConfigurationSets() {
        return recorded.respond<string[]>('ses.listConfigurationSets', undefined);
      },
      async getConfigurationSetEventDestinations(configurationSetName: string) {
        return recorded.respond<EventDestinationFact[]>('ses.getConfigurationSetEventDestinations', configurationSetName);
      },
      ...fixtureSesWrites(options.state ?? createFixtureSesState(), options.dryRun),
    },
    'fixture',
  );
}

// Recorded answers only (D-26): in 'test' no lookup ever reaches a DNS server (R6).
export function createFixtureDns(options: FixtureRecordingOptions): DnsPort {
  const recorded = recordedPort(options.recordings);
  return brandPort(
    {
      async resolveMx(name: string) {
        return recorded.respond<DnsMxOutcome>('dns.resolveMx', name);
      },
      async resolveTxt(name: string) {
        return recorded.respond<DnsTxtOutcome>('dns.resolveTxt', name);
      },
    },
    'fixture',
  );
}

export interface FixtureBedrockModelOptions {
  model: BedrockModelPort | undefined;
  dryRun: DryRunLog;
}

// The model call and the runtime invocation leave their line first and then answer from the script,
// the handler or a recording, so a test that forgot to supply one fails on the miss, not on a made-up
// answer.
export function createFixtureBedrockModel(options: FixtureBedrockModelOptions): BedrockModelPort {
  const recorder = createBedrockModelDryRun(options.dryRun);
  return brandPort(
    {
      async *stream(messages, streamOptions) {
        yield* recorder.stream(messages, streamOptions);
        if (options.model === undefined) throw new FixtureMissError('bedrockModel.stream');
        yield* options.model.stream(messages, streamOptions);
      },
    },
    'fixture',
  );
}

export interface FixtureAgentCoreOptions extends FixtureMutatingOptions {
  agentRuntime: ((payload: unknown) => Promise<unknown>) | undefined;
}

function abortError(): Error {
  const error = new Error('the agent runtime invocation was aborted');
  error.name = 'AbortError';
  return error;
}

function jsonCopy(value: unknown): unknown {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

// The handler's promise is raced against the signal, so a caller whose deadline passes is let go even
// by a handler that never settles, which is what forwarding the signal to the live send is for.
function untilAborted(work: Promise<unknown>, signal: AbortSignal | undefined): Promise<unknown> {
  if (signal === undefined) return work;
  return new Promise((resolve, reject) => {
    const onAbort = (): void => reject(abortError());
    signal.addEventListener('abort', onAbort, { once: true });
    void (async () => {
      try {
        resolve(await work);
      } catch (error) {
        reject(error);
      } finally {
        signal.removeEventListener('abort', onAbort);
      }
    })();
  });
}

// The handler receives and answers JSON copies, as the wire between detection and the runtime would
// carry them: neither side can hold a reference into the other's objects.
export function createFixtureAgentCore(options: FixtureAgentCoreOptions): AgentCorePort {
  const recorded = recordedPort(options.recordings);
  const recorder = createAgentCoreDryRun(options.dryRun);
  return brandPort(
    {
      async invokeAgentRuntime(request: AgentRuntimeRequest) {
        await recorder.invokeAgentRuntime(request);
        const { runtimeArn, sessionId, payload, abortSignal } = request;
        if (options.agentRuntime === undefined) {
          return recorded.respond<unknown>('agentCore.invokeAgentRuntime', { runtimeArn, sessionId, payload });
        }
        if (abortSignal?.aborted === true) throw abortError();
        return jsonCopy(await untilAborted(options.agentRuntime(jsonCopy(payload)), abortSignal));
      },
    },
    'fixture',
  );
}

export function createFixtureReplyBucket(options: FixtureRecordingOptions): ReplyBucketPort {
  const recorded = recordedPort(options.recordings);
  return brandPort(
    {
      async getReplyObject(key: string) {
        return recorded.respond<Uint8Array>('replyBucket.getReplyObject', key);
      },
    },
    'fixture',
  );
}
