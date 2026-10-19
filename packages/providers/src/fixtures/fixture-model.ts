import { ModelThrottledError } from '@strands-agents/sdk';
import type { Message, MessageData, ModelStreamEvent, StreamOptions, ToolChoice, ToolSpec, Usage } from '@strands-agents/sdk';
import type { BedrockModelPort } from '../port-types.js';
import { FixtureMissError } from './recorded.js';

// The SDK's own name for the tool it registers when an Agent has a structured output schema
// (tools/structured-output-tool.js); a test asserts the spec the fixture receives carries it.
export const STRUCTURED_OUTPUT_TOOL_NAME = 'strands_structured_output';

/** One scripted model call: the events it streams, then the error it throws, if any. */
export interface FixtureTurn {
  readonly events: readonly ModelStreamEvent[];
  readonly error?: () => Error;
}

/** What one call handed the model, copied through JSON so a later change to the caller's objects cannot rewrite it. */
export interface FixtureModelCall {
  readonly messages: MessageData[];
  readonly systemPrompt: unknown;
  readonly toolSpecs: ToolSpec[] | undefined;
  readonly toolChoice: ToolChoice | undefined;
}

export interface FixtureModel extends BedrockModelPort {
  readonly calls: readonly FixtureModelCall[];
}

function jsonCopy<T>(value: T): T {
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
}

// One turn per call, in order. A call past the script throws instead of inventing an answer (D-26),
// so a loop that asks for more calls than a test planned fails on the miss.
export function createFixtureModel(turns: readonly FixtureTurn[]): FixtureModel {
  const calls: FixtureModelCall[] = [];
  return {
    calls,
    async *stream(messages: Message[], options?: StreamOptions): AsyncGenerator<ModelStreamEvent> {
      calls.push({
        messages: jsonCopy(messages) as unknown as MessageData[],
        systemPrompt: jsonCopy(options?.systemPrompt),
        toolSpecs: jsonCopy(options?.toolSpecs),
        toolChoice: jsonCopy(options?.toolChoice),
      });
      const turn = turns[calls.length - 1];
      if (turn === undefined) throw new FixtureMissError('bedrockModel.stream');
      yield* turn.events;
      if (turn.error !== undefined) throw turn.error();
    },
  };
}

export function structuredAnswerTurn(answer: unknown, usage: Usage): FixtureTurn {
  return {
    events: [
      { type: 'modelMessageStartEvent', role: 'assistant' },
      { type: 'modelContentBlockStartEvent', start: { type: 'toolUseStart', name: STRUCTURED_OUTPUT_TOOL_NAME, toolUseId: 'fixture-use-1' } },
      { type: 'modelContentBlockDeltaEvent', delta: { type: 'toolUseInputDelta', input: JSON.stringify(answer) } },
      { type: 'modelContentBlockStopEvent' },
      { type: 'modelMessageStopEvent', stopReason: 'toolUse' },
      { type: 'modelMetadataEvent', usage },
    ],
  };
}

export function plainTextTurn(text: string, usage: Usage): FixtureTurn {
  return {
    events: [
      { type: 'modelMessageStartEvent', role: 'assistant' },
      { type: 'modelContentBlockStartEvent' },
      { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text } },
      { type: 'modelContentBlockStopEvent' },
      { type: 'modelMessageStopEvent', stopReason: 'endTurn' },
      { type: 'modelMetadataEvent', usage },
    ],
  };
}

// The SDK's own throttling class, the only error its retry strategy retries, so a test of the retry
// path exercises the real classification rather than a look-alike. The live adapter throws the same
// class for a throttled Converse (agent-adapters.ts), which the SDK leaves unmapped with stream off.
export function throttledTurn(): FixtureTurn {
  return { events: [], error: () => new ModelThrottledError('the fixture model is throttled') };
}
