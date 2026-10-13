import type { BedrockAgentCoreClient } from '@aws-sdk/client-bedrock-agentcore';
import type { BedrockModelOptions } from '@strands-agents/sdk';
import type { AgentCorePort, BedrockModelPort } from '../port-types.js';

export function createLiveBedrockModel(_construct?: (options: BedrockModelOptions) => BedrockModelPort): BedrockModelPort {
  throw new Error('createLiveBedrockModel is not built yet');
}

export interface CreateLiveAgentCoreOptions {
  client: () => BedrockAgentCoreClient;
}

export function createLiveAgentCore(_options: CreateLiveAgentCoreOptions): AgentCorePort {
  throw new Error('createLiveAgentCore is not built yet');
}
