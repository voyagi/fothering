import type {
  AgentCorePort,
  BedrockModelPort,
  EventDestinationFact,
  Recording,
  ReplyBucketPort,
  SesPort,
} from '../port-types.js';
import { brandPort } from '../port-types.js';
import { createAgentCoreDryRun, createBedrockModelDryRun, createSesDryRun, type DryRunLog } from '../dry-run.js';
import { recordedPort } from './recorded.js';

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

// The model call and the runtime invocation leave their line first and then answer from a
// recording, so a test that forgot to record the reply fails on the miss, not on a made-up answer.
export function createFixtureBedrockModel(options: FixtureMutatingOptions): BedrockModelPort {
  const recorded = recordedPort(options.recordings);
  const recorder = createBedrockModelDryRun(options.dryRun);
  return brandPort(
    {
      async converse(request: { modelId: string; prompt: string }) {
        await recorder.converse(request);
        return recorded.respond<{ text: string }>('bedrockModel.converse', request);
      },
    },
    'fixture',
  );
}

export function createFixtureAgentCore(options: FixtureMutatingOptions): AgentCorePort {
  const recorded = recordedPort(options.recordings);
  const recorder = createAgentCoreDryRun(options.dryRun);
  return brandPort(
    {
      async invokeAgentRuntime(request: { runtimeArn: string; sessionId: string; payload: unknown }) {
        await recorder.invokeAgentRuntime(request);
        return recorded.respond<unknown>('agentCore.invokeAgentRuntime', request);
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
