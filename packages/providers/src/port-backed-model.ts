import { Model } from '@strands-agents/sdk';
import type { BaseModelConfig, Message, ModelStreamEvent, StreamOptions, Usage } from '@strands-agents/sdk';
import type { BedrockModelPort } from './port-types.js';

export interface PortBackedModelOptions {
  port: BedrockModelPort;
  config: BaseModelConfig;
  ceiling: number;
  inputByteCeiling: number;
}

export class ModelCallCeilingError extends Error {
  constructor(ceiling: number) {
    super(`model call ceiling of ${ceiling} reached`);
    this.name = 'ModelCallCeilingError';
  }
}

export class ModelInputCeilingError extends Error {
  constructor(ceiling: number) {
    super(`model input byte ceiling of ${ceiling} passed`);
    this.name = 'ModelInputCeilingError';
  }
}

export class PortBackedModel extends Model<BaseModelConfig> {
  readonly #port: BedrockModelPort;
  readonly #config: BaseModelConfig;

  constructor(options: PortBackedModelOptions) {
    super();
    this.#port = options.port;
    this.#config = options.config;
  }

  override getConfig(): BaseModelConfig {
    return this.#config;
  }

  override updateConfig(_next: BaseModelConfig): void {}

  get calls(): number {
    return 0;
  }

  get ceilingReached(): boolean {
    return false;
  }

  get inputCeilingReached(): boolean {
    return false;
  }

  get usage(): Usage {
    return { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  }

  override stream(messages: Message[], options?: StreamOptions): AsyncIterable<ModelStreamEvent> {
    return this.#port.stream(messages, options);
  }
}
