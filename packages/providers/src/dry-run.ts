import { normalizeAddress } from '@fothering/core/address';
import type {
  AddressKeyPort,
  AgentCorePort,
  BedrockModelPort,
  DryRunSink,
  SendEmailRequest,
  SesPort,
} from './port-types.js';

export interface DryRunLog {
  would(operation: string, target: string, request: unknown): Promise<void>;
}

export interface CreateDryRunLogOptions {
  sink: DryRunSink;
  addressKey: AddressKeyPort;
  now: () => number;
}

export const DEAD_LETTER_QUEUE_TARGET = 'dead-letter-queue';
export const DRY_RUN_MESSAGE_ID = 'dry-run-not-sent';

export function createDryRunLog(_options: CreateDryRunLogOptions): DryRunLog {
  return {
    async would() {},
  };
}

export function sendEmailTarget(request: SendEmailRequest): string {
  return request.configurationSetName ?? normalizeAddress(request.from)?.domain ?? 'unparseable';
}

export function createSesDryRun(log: DryRunLog): Pick<SesPort, 'pauseConfigurationSet' | 'reopenConfigurationSet' | 'sendEmail'> {
  return {
    async pauseConfigurationSet(configurationSet) {
      await log.would('ses.pauseConfigurationSet', configurationSet, configurationSet);
    },
    async reopenConfigurationSet(configurationSet) {
      await log.would('ses.reopenConfigurationSet', configurationSet, configurationSet);
    },
    async sendEmail(request) {
      await log.would('ses.sendEmail', sendEmailTarget(request), request);
      return { messageId: DRY_RUN_MESSAGE_ID };
    },
  };
}

// A dry-run model call answers with no text: nothing was asked of the model, so nothing came back.
export function createBedrockModelDryRun(log: DryRunLog): BedrockModelPort {
  return {
    async converse(request) {
      await log.would('bedrockModel.converse', request.modelId, request);
      return { text: '' };
    },
  };
}

export function createAgentCoreDryRun(log: DryRunLog): AgentCorePort {
  return {
    async invokeAgentRuntime(request) {
      await log.would('agentCore.invokeAgentRuntime', request.runtimeArn, request);
      return undefined;
    },
  };
}
