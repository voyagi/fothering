import { describe, expect, it } from 'vitest';
import * as z from 'zod';
import { Agent, Message, TextBlock, type ModelStreamEvent, type ToolSpec } from '@strands-agents/sdk';
import { RECORD_BYTE_CEILING, canonicalJson } from '@fothering/core/evidence-record';
import { MODEL_VALUES } from '@fothering/core/model-values';
import { ModelCallCeilingError, ModelInputCeilingError, PortBackedModel } from './port-backed-model.js';
import { STRUCTURED_OUTPUT_TOOL_NAME, createFixtureModel, plainTextTurn, structuredAnswerTurn } from './fixtures/fixture-model.js';
import type { BedrockModelPort } from './port-types.js';

const USAGE = { inputTokens: 1_200, outputTokens: 80, totalTokens: 1_280 };
const PINNED_CONFIG = { modelId: MODEL_VALUES.inferenceProfileId, maxTokens: MODEL_VALUES.maxTokens };
const PLANTED_SENTENCE = 'Jane wrote that the mailbox at her house is full';

function userMessage(text: string): Message {
  return new Message({ role: 'user', content: [new TextBlock(text)] });
}

async function drain(iterable: AsyncIterable<ModelStreamEvent>): Promise<ModelStreamEvent[]> {
  const events: ModelStreamEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

function wrap(port: BedrockModelPort, ceiling: number = MODEL_VALUES.modelCallCeiling): PortBackedModel {
  return new PortBackedModel({ port, config: PINNED_CONFIG, ceiling, inputByteCeiling: MODEL_VALUES.inputTokenCeiling });
}

async function failureOf(work: Promise<unknown>): Promise<unknown> {
  return work.then(
    () => 'resolved',
    (error: unknown) => error,
  );
}

// A canonical record of exactly `bytes` UTF-8 bytes, quote-heavy the way a real evidence record is,
// so its JSON-in-JSON form is far larger than the bytes themselves.
function recordJsonOfBytes(bytes: number): string {
  const rows = Array.from({ length: 600 }, (_unused, index) => ({ value: `batch-${String(index).padStart(4, '0')}` }));
  const unpadded = Buffer.byteLength(canonicalJson({ pad: '', rows }));
  return canonicalJson({ pad: 'x'.repeat(bytes - unpadded), rows });
}

// A tool spec whose JSON array form is exactly `bytes` long.
function toolSpecsOfBytes(bytes: number): ToolSpec[] {
  const spec = { name: STRUCTURED_OUTPUT_TOOL_NAME, description: '', inputSchema: { type: 'object' as const } };
  const unpadded = Buffer.byteLength(JSON.stringify([spec]));
  return [{ ...spec, description: 'd'.repeat(bytes - unpadded) }];
}

describe('PortBackedModel counts every model call of one invocation (D-71)', () => {
  it('refuses call 4 with ModelCallCeilingError before the port when the ceiling is 3 (AC-E34, wrapper half)', async () => {
    const fixture = createFixtureModel([1, 2, 3, 4].map((call) => plainTextTurn(`answer ${call}`, USAGE)));
    const model = wrap(fixture, 3);

    for (const call of [1, 2, 3]) {
      expect(await drain(model.stream([userMessage('p')]))).toEqual(plainTextTurn(`answer ${call}`, USAGE).events);
    }
    const refusal = await failureOf(drain(model.stream([userMessage('p')])));
    expect((refusal as Error).name).toBe('ModelCallCeilingError');
    expect(refusal).toBeInstanceOf(ModelCallCeilingError);
    expect(model.ceilingReached).toBe(true);
    expect(model.calls).toBe(3);
    expect(fixture.calls.length).toBe(3);
  });

  it('sums inputTokens, outputTokens and totalTokens across calls as integers, readable after a refusal (AC-E35, usage half)', async () => {
    const second = { inputTokens: 1_500, outputTokens: 95, totalTokens: 1_595 };
    const fixture = createFixtureModel([plainTextTurn('one', USAGE), structuredAnswerTurn({ verdict: 'unknown' }, second)]);
    const model = wrap(fixture, 2);

    await drain(model.stream([userMessage('p')]));
    await drain(model.stream([userMessage('p')]));
    await failureOf(drain(model.stream([userMessage('p')])));

    expect(model.usage).toEqual({ inputTokens: 2_700, outputTokens: 175, totalTokens: 2_875 });
    for (const count of Object.values(model.usage)) expect(Number.isInteger(count)).toBe(true);
  });

  it('keeps separate counts for two invocations in flight on one runtime (R9 concurrency backstop)', async () => {
    const fixture = createFixtureModel([1, 2, 3, 4].map((call) => plainTextTurn(`answer ${call}`, USAGE)));
    const first = wrap(fixture, 2);
    const second = wrap(fixture, 2);

    const twice = async (model: PortBackedModel): Promise<void> => {
      await drain(model.stream([userMessage('p')]));
      await drain(model.stream([userMessage('p')]));
    };
    await Promise.all([twice(first), twice(second)]);

    expect([first.calls, second.calls]).toEqual([2, 2]);
    expect([first.ceilingReached, second.ceilingReached]).toEqual([false, false]);
    expect(fixture.calls).toHaveLength(4);
  });
});

describe('PortBackedModel bounds each call input (AI-SPEC section 4 byte guard)', () => {
  it('refuses a call past the input byte ceiling before the port, without counting it as a model call', async () => {
    const fixture = createFixtureModel([plainTextTurn('one', USAGE)]);
    const model = wrap(fixture);
    const oversize = userMessage('y'.repeat(MODEL_VALUES.inputTokenCeiling + 1));

    const refusal = await failureOf(drain(model.stream([oversize])));
    expect(refusal).toBeInstanceOf(ModelInputCeilingError);
    expect(model.inputCeilingReached).toBe(true);
    expect(model.calls).toBe(0);
    expect(fixture.calls).toHaveLength(0);

    await drain(model.stream([userMessage('p')]));
    expect(model.calls).toBe(1);
  });

  it('passes a call of exactly the ceiling in content bytes and refuses one byte more', async () => {
    const atCeiling = createFixtureModel([plainTextTurn('one', USAGE)]);
    await drain(wrap(atCeiling).stream([userMessage('z'.repeat(MODEL_VALUES.inputTokenCeiling - 2))], { systemPrompt: 'ab' }));
    expect(atCeiling.calls).toHaveLength(1);

    const pastCeiling = wrap(createFixtureModel([plainTextTurn('one', USAGE)]));
    const refusal = await failureOf(drain(pastCeiling.stream([userMessage('z'.repeat(MODEL_VALUES.inputTokenCeiling - 1))], { systemPrompt: 'ab' })));
    expect(refusal).toBeInstanceOf(ModelInputCeilingError);
  });

  // Steelman S3: the record text is measured as itself, never inside an outer JSON string, whose
  // escaping of every quote would refuse a record under RECORD_BYTE_CEILING on its very first call.
  it('passes a full-size record with the full prompt and tool spec budget, which the JSON-of-everything measure would refuse', async () => {
    const recordText = recordJsonOfBytes(RECORD_BYTE_CEILING);
    const systemPrompt = 's'.repeat(MODEL_VALUES.systemPromptByteBudget);
    const toolSpecs = toolSpecsOfBytes(1_024);
    const messages = [userMessage(recordText)];

    expect(Buffer.byteLength(recordText)).toBe(16_384);
    expect(Buffer.byteLength(JSON.stringify(toolSpecs))).toBe(1_024);
    expect(Buffer.byteLength(recordText) + Buffer.byteLength(systemPrompt) + Buffer.byteLength(JSON.stringify(toolSpecs))).toBe(19_456);
    expect(Buffer.byteLength(JSON.stringify({ messages, systemPrompt, toolSpecs }))).toBeGreaterThan(20_480);

    const fixture = createFixtureModel([plainTextTurn('one', USAGE)]);
    const model = wrap(fixture);
    await drain(model.stream(messages, { systemPrompt, toolSpecs }));
    expect(model.inputCeilingReached).toBe(false);
    expect(fixture.calls).toHaveLength(1);
  });

  it('counts a non-text content block by its JSON, so a corrective call re-sending a tool result is bounded too', async () => {
    const fixture = createFixtureModel([plainTextTurn('one', USAGE)]);
    const model = wrap(fixture);
    const toolResult = Message.fromMessageData({
      role: 'user',
      content: [{ toolResult: { toolUseId: 'fixture-use-1', status: 'error', content: [{ text: 'q'.repeat(MODEL_VALUES.inputTokenCeiling) }] } }],
    });

    const refusal = await failureOf(drain(model.stream([toolResult])));
    expect(refusal).toBeInstanceOf(ModelInputCeilingError);
    expect(fixture.calls).toHaveLength(0);
  });
});

describe('PortBackedModel keeps the reported values true', () => {
  it('returns the pinned config, accepts an equal update and refuses a different one naming only the key', () => {
    const model = wrap(createFixtureModel([]));
    expect(model.getConfig()).toEqual({ modelId: 'eu.anthropic.claude-sonnet-5', maxTokens: 1_024 });

    expect(() => model.updateConfig({ maxTokens: 1_024 })).not.toThrow();
    const refusal = (() => {
      try {
        model.updateConfig({ maxTokens: 4_096 });
        return undefined;
      } catch (error) {
        return error;
      }
    })();
    expect(refusal).toBeInstanceOf(TypeError);
    expect((refusal as Error).message).toBe('model config is pinned: maxTokens');
    expect(model.getConfig().maxTokens).toBe(1_024);
  });

  it('never puts a byte of a planted message into an error it throws', async () => {
    const oversize = wrap(createFixtureModel([]));
    const inputRefusal = await failureOf(drain(oversize.stream([userMessage(`${PLANTED_SENTENCE} ${'y'.repeat(MODEL_VALUES.inputTokenCeiling)}`)])));

    const capped = wrap(createFixtureModel([plainTextTurn('one', USAGE)]), 1);
    await drain(capped.stream([userMessage(PLANTED_SENTENCE)]));
    const ceilingRefusal = await failureOf(drain(capped.stream([userMessage(PLANTED_SENTENCE)])));

    for (const refusal of [inputRefusal, ceilingRefusal]) {
      expect(refusal).toBeInstanceOf(Error);
      for (const word of ['Jane', 'mailbox', 'house']) expect((refusal as Error).message).not.toContain(word);
    }
  });
});

describe('an Agent over PortBackedModel (D-72, first proof)', () => {
  it('returns structuredOutput from one structured answer turn, with the SDK tool as the only tool spec', async () => {
    const answerSchema = z.strictObject({ verdict: z.enum(['approved', 'unknown']), note: z.string() });
    const answer = { verdict: 'unknown', note: 'no single cause' };
    const fixture = createFixtureModel([structuredAnswerTurn(answer, USAGE)]);
    const model = wrap(fixture);
    const agent = new Agent({ model, tools: [], printer: false, structuredOutputSchema: answerSchema });

    const result = await agent.invoke('the evidence record');

    expect(result.structuredOutput).toEqual(answer);
    expect(model.calls).toBe(1);
    expect(fixture.calls).toHaveLength(1);
    expect(fixture.calls[0]?.toolSpecs?.map((spec) => spec.name)).toEqual(['strands_structured_output']);
  });
});
