import { InvokeAgentRuntimeCommand, type BedrockAgentCoreClient } from '@aws-sdk/client-bedrock-agentcore';
import { BedrockModel, ModelThrottledError, type BedrockModelOptions, type ModelStreamEvent } from '@strands-agents/sdk';
import { MODEL_VALUES } from '@fothering/core/model-values';
import type { AgentCorePort, AgentRuntimeRequest, BedrockModelPort } from '../port-types.js';
import { hasErrorName } from './error-name.js';
import { lazyClient } from './lazy-client.js';

// The only BedrockModel construction in the tree. Every option is pinned from MODEL_VALUES, because
// the SDK's defaults would change routing or billing: no modelId falls back to the SDK's own model,
// no region to its default Region, and stream left on calls ConverseStream, a different IAM action.
function liveBedrockModelOptions(): BedrockModelOptions {
  return {
    region: MODEL_VALUES.sourceRegion,
    modelId: MODEL_VALUES.inferenceProfileId,
    maxTokens: MODEL_VALUES.maxTokens,
    stream: false,
    // Spread onto the request after the SDK drops thinking from additionalRequestFields on a forced
    // tool call (bedrock.js 1.20.0 lines 535 and 560 to 571), so the structured-output retry keeps it.
    additionalArgs: { additionalModelRequestFields: { thinking: { type: MODEL_VALUES.thinking } } },
    // A client-level retry never passes through PortBackedModel, so it would be an uncounted request.
    clientConfig: { maxAttempts: MODEL_VALUES.clientMaxAttempts },
    requestTimeout: MODEL_VALUES.requestTimeoutMs,
  };
}

const THROTTLING_EXCEPTION = 'ThrottlingException';

// Strands 1.20.0 turns a throttle into ModelThrottledError, the only error its retry strategy
// retries, just when the throttle arrives as an event of a streamed response (bedrock.js lines 1401
// to 1404). With stream off, Converse rejects with the client's ThrottlingException and the SDK
// rethrows it unchanged (bedrock.js lines 437 to 444), so without this the one throttling retry
// MODEL_VALUES.throttleAttempts allows would never happen on the deployed path.
async function* throttleAsModelError(events: AsyncIterable<ModelStreamEvent>): AsyncGenerator<ModelStreamEvent> {
  try {
    yield* events;
  } catch (error) {
    if (hasErrorName(error, THROTTLING_EXCEPTION)) throw new ModelThrottledError('the model provider throttled the request', { cause: error });
    throw error;
  }
}

/** `construct` exists for tests that count builds; the deployed path always builds the real model. */
export function createLiveBedrockModel(
  construct: (options: BedrockModelOptions) => BedrockModelPort = (options) => new BedrockModel(options),
): BedrockModelPort {
  const model = lazyClient(() => construct(liveBedrockModelOptions()));
  return {
    stream: (messages, options) => throttleAsModelError(model().stream(messages, options)),
  };
}

export interface CreateLiveAgentCoreOptions {
  client: () => BedrockAgentCoreClient;
}

const JSON_CONTENT_TYPE = 'application/json';

// Detection's side of the runtime call (D-72). The signal goes to send, so detection's own deadline
// ends the request instead of waiting for the runtime; the body is the runtime's JSON result, which
// detection validates before anything is stored (D-74).
export function createLiveAgentCore(options: CreateLiveAgentCoreOptions): AgentCorePort {
  return {
    async invokeAgentRuntime(request: AgentRuntimeRequest) {
      const command = new InvokeAgentRuntimeCommand({
        agentRuntimeArn: request.runtimeArn,
        runtimeSessionId: request.sessionId,
        contentType: JSON_CONTENT_TYPE,
        accept: JSON_CONTENT_TYPE,
        payload: new TextEncoder().encode(JSON.stringify(request.payload)),
      });
      const response = await options.client().send(command, request.abortSignal === undefined ? {} : { abortSignal: request.abortSignal });
      if (response.response === undefined) throw new Error('the agent runtime returned no response body');
      return JSON.parse(await response.response.transformToString()) as unknown;
    },
  };
}
