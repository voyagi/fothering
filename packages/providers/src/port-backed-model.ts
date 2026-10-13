import { Model } from '@strands-agents/sdk';
import type { BaseModelConfig, ContentBlock, Message, ModelStreamEvent, StreamOptions, SystemContentBlock, Usage } from '@strands-agents/sdk';
import type { BedrockModelPort } from './port-types.js';

export interface PortBackedModelOptions {
  /** The resolved bedrockModel row: fixture, dry-run recorder or live adapter. */
  port: BedrockModelPort;
  /** Pinned: the profile id and maxTokens the result reports. */
  config: BaseModelConfig;
  /** MODEL_CALL_CEILING. */
  ceiling: number;
  /** INPUT_TOKEN_CEILING read as bytes, under the one-byte-per-token assumption it was set with. */
  inputByteCeiling: number;
}

// Both messages name only the ceiling: a model error can reach a log, and nothing of a prompt or an
// answer may go with it (T-02-10).
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

function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

// A text block counts as its own text. Any other block counts as its JSON, which is close to what
// the provider sends for a tool use or a tool result.
function blockBytes(block: ContentBlock | SystemContentBlock): number {
  return block.type === 'textBlock' ? utf8Bytes(block.text) : utf8Bytes(JSON.stringify(block));
}

// Content bytes, summed piece by piece (steelman S3). Never JSON.stringify of the messages array: it
// escapes every quote of the record text again, which measured 14 percent over a real record and
// would refuse a record under RECORD_BYTE_CEILING on its first call.
function inputBytes(messages: Message[], options: StreamOptions | undefined): number {
  const system = options?.systemPrompt;
  let total = typeof system === 'string' ? utf8Bytes(system) : (system ?? []).reduce((sum, block) => sum + blockBytes(block), 0);
  for (const message of messages) {
    for (const block of message.content) total += blockBytes(block);
  }
  if (options?.toolSpecs !== undefined) total += utf8Bytes(JSON.stringify(options.toolSpecs));
  return total;
}

/**
 * The Model the Agent is given, one per invocation (D-71). It counts every call the SDK makes,
 * corrective and retried calls included, and refuses the one past the ceiling before the port is
 * reached, so a refused call never leaves the process (AC-E34). Usage is summed from the model's own
 * metadata events, so it is known even when the loop throws.
 */
export class PortBackedModel extends Model<BaseModelConfig> {
  readonly #port: BedrockModelPort;
  readonly #config: Readonly<BaseModelConfig>;
  readonly #ceiling: number;
  readonly #inputByteCeiling: number;
  #calls = 0;
  #ceilingReached = false;
  #inputCeilingReached = false;
  #usage: Usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

  constructor(options: PortBackedModelOptions) {
    super();
    this.#port = options.port;
    this.#config = Object.freeze({ ...options.config });
    this.#ceiling = options.ceiling;
    this.#inputByteCeiling = options.inputByteCeiling;
  }

  override getConfig(): BaseModelConfig {
    return { ...this.#config };
  }

  // Every result reports the pinned values, so a change is refused rather than merged.
  override updateConfig(next: BaseModelConfig): void {
    for (const [key, value] of Object.entries(next)) {
      if ((this.#config as Record<string, unknown>)[key] !== value) throw new TypeError(`model config is pinned: ${key}`);
    }
  }

  get calls(): number {
    return this.#calls;
  }

  get ceilingReached(): boolean {
    return this.#ceilingReached;
  }

  get inputCeilingReached(): boolean {
    return this.#inputCeilingReached;
  }

  get usage(): Usage {
    return { ...this.#usage };
  }

  // The byte guard runs before the count: an oversize call never reaches the port, so it is not a
  // model call and spends nothing of the ceiling.
  override async *stream(messages: Message[], options?: StreamOptions): AsyncGenerator<ModelStreamEvent> {
    if (inputBytes(messages, options) > this.#inputByteCeiling) {
      this.#inputCeilingReached = true;
      throw new ModelInputCeilingError(this.#inputByteCeiling);
    }
    if (this.#calls >= this.#ceiling) {
      this.#ceilingReached = true;
      throw new ModelCallCeilingError(this.#ceiling);
    }
    this.#calls += 1;
    for await (const event of this.#port.stream(messages, options)) {
      if (event.type === 'modelMetadataEvent' && event.usage !== undefined) {
        this.#usage = {
          inputTokens: this.#usage.inputTokens + event.usage.inputTokens,
          outputTokens: this.#usage.outputTokens + event.usage.outputTokens,
          totalTokens: this.#usage.totalTokens + event.usage.totalTokens,
        };
      }
      yield event;
    }
  }
}
