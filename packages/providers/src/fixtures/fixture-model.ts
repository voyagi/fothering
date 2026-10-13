import type { MessageData, ModelStreamEvent, ToolChoice, ToolSpec, Usage } from '@strands-agents/sdk';
import type { BedrockModelPort } from '../port-types.js';

export const STRUCTURED_OUTPUT_TOOL_NAME = 'strands_structured_output';

export interface FixtureTurn {
  readonly events: readonly ModelStreamEvent[];
  readonly error?: () => Error;
}

export interface FixtureModelCall {
  readonly messages: MessageData[];
  readonly systemPrompt: unknown;
  readonly toolSpecs: ToolSpec[] | undefined;
  readonly toolChoice: ToolChoice | undefined;
}

export interface FixtureModel extends BedrockModelPort {
  readonly calls: readonly FixtureModelCall[];
}

export function createFixtureModel(_turns: readonly FixtureTurn[]): FixtureModel {
  throw new Error('createFixtureModel is not built yet');
}

export function structuredAnswerTurn(_answer: unknown, _usage: Usage): FixtureTurn {
  throw new Error('structuredAnswerTurn is not built yet');
}

export function plainTextTurn(_text: string, _usage: Usage): FixtureTurn {
  throw new Error('plainTextTurn is not built yet');
}

export function throttledTurn(): FixtureTurn {
  throw new Error('throttledTurn is not built yet');
}
