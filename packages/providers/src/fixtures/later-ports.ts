import type {
  AgentCorePort,
  AgentRuntimeRequest,
  BedrockModelPort,
  EventDestinationFact,
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

// Reads answer from recordings and throw on an unrecorded request; the three mutations are
// recorders that answer every call with a fixed result and leave one dry-run line.
export function createFixtureSes(options: FixtureMutatingOptions): SesPort {
  const recorded = recordedPort(options.recordings);
  return brandPort(
    {
      async getEmailIdentity(emailIdentity: string) {
        return recorded.respond<string | undefined>('ses.getEmailIdentity', emailIdentity);
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
      ...createSesDryRun(options.dryRun),
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
