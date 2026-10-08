import * as z from 'zod';
import { normalizeAddress, pseudonymizeRecipient, type AddressKeySet } from '@fothering/core/address';
import { CONFIGURATION_SET_PATTERN } from '@fothering/core/lanes';
import type {
  AddressKeyPort,
  AgentCorePort,
  BedrockModelPort,
  DryRunSink,
  SendEmailRequest,
  SesPort,
} from './port-types.js';
import { canonicalJson } from './fixtures/recorded.js';

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

// The line carries a target and a summary, never the request. A target is accepted only in a shape
// that cannot hold an address or a sentence; a summary is built from the fields each operation
// names below, so a field nobody listed can never reach a log line (AC-P9).
const RECEIVING_DOMAIN = /^[a-z0-9._-]{1,253}$/;
// A lane's partition key: LANE# and then the configuration-set rule, its leading ^ moved in front.
const RECORD_PARTITION_KEY = new RegExp(`^LANE#${CONFIGURATION_SET_PATTERN.source.replace(/^\^/, '')}`);
// recordKey's sort key: B#, a 13-digit bucket start, then the event type and an identity made of
// SES ids, HMAC hex and a timestamp, joined by #. A key built any other way is refused, not printed.
const RECORD_SORT_KEY = /^B#\d{13}#[A-Za-z0-9._#-]{1,1024}$/;
const MODEL_ID = /^[A-Za-z0-9._:-]{1,256}$/;
const RUNTIME_ARN = /^arn:[A-Za-z0-9:/_.-]{1,512}$/;
const DEAD_LETTER_TARGET = new RegExp(`^${DEAD_LETTER_QUEUE_TARGET}$`);

const recordKeySchema = z.object({ pk: z.string().regex(RECORD_PARTITION_KEY), sk: z.string().regex(RECORD_SORT_KEY) });
const configurationSetSchema = z.string().regex(CONFIGURATION_SET_PATTERN);
const sendEmailSchema = z.object({
  from: z.string(),
  to: z.array(z.string()),
  subject: z.string(),
  text: z.string(),
  configurationSetName: configurationSetSchema.optional(),
});
const converseSchema = z.object({ modelId: z.string(), prompt: z.string() });
const invokeSchema = z.object({ runtimeArn: z.string(), payload: z.unknown() });

type Summary = Record<string, unknown>;

interface SummaryContext {
  keySet: () => Promise<AddressKeySet>;
  nowMs: number;
}

interface DryRunShape {
  readonly targets: readonly RegExp[];
  readonly summarize: (request: unknown, context: SummaryContext) => Summary | Promise<Summary>;
}

async function summarizeSend(request: unknown, context: SummaryContext): Promise<Summary> {
  const email = sendEmailSchema.parse(request);
  const keySet = await context.keySet();
  const pseudonym = (address: string): { receivingDomain: string; recipientHmac: string } => {
    const { receivingDomain, recipientHmac } = pseudonymizeRecipient(address, keySet, context.nowMs);
    return { receivingDomain, recipientHmac };
  };
  return {
    ...(email.configurationSetName !== undefined ? { configurationSet: email.configurationSetName } : {}),
    from: pseudonym(email.from),
    recipients: email.to.map(pseudonym),
    subjectLength: email.subject.length,
    textLength: email.text.length,
  };
}

function summarizeDeadLetter(request: unknown): Summary {
  const keys = z.array(recordKeySchema).parse(request);
  return { recordCount: keys.length, partitionKeys: [...new Set(keys.map((key) => key.pk))].sort() };
}

const RECORD_KEY_SHAPE: DryRunShape = { targets: [RECORD_PARTITION_KEY], summarize: (request) => recordKeySchema.parse(request) };
const CONFIGURATION_SET_SHAPE: DryRunShape = {
  targets: [CONFIGURATION_SET_PATTERN],
  summarize: (request) => ({ configurationSet: configurationSetSchema.parse(request) }),
};

const SHAPES = new Map<string, DryRunShape>([
  ['eventStore.putIfAbsent', RECORD_KEY_SHAPE],
  ['eventStore.deleteRecord', RECORD_KEY_SHAPE],
  ['deadLetter.send', { targets: [DEAD_LETTER_TARGET], summarize: summarizeDeadLetter }],
  ['ses.pauseConfigurationSet', CONFIGURATION_SET_SHAPE],
  ['ses.reopenConfigurationSet', CONFIGURATION_SET_SHAPE],
  ['ses.sendEmail', { targets: [CONFIGURATION_SET_PATTERN, RECEIVING_DOMAIN], summarize: summarizeSend }],
  [
    'bedrockModel.converse',
    {
      targets: [MODEL_ID],
      summarize: (request) => {
        const { modelId, prompt } = converseSchema.parse(request);
        return { modelId, promptLength: prompt.length };
      },
    },
  ],
  [
    'agentCore.invokeAgentRuntime',
    {
      targets: [RUNTIME_ARN],
      summarize: (request) => {
        const { runtimeArn, payload } = invokeSchema.parse(request);
        return { runtimeArn, payloadLength: canonicalJson(payload).length };
      },
    },
  ],
]);

// Refusals name the operation and never the target or the request: what was refused may be the
// very address or sentence this log exists to keep out of a line.
async function summarize(operation: string, shape: DryRunShape, request: unknown, context: SummaryContext): Promise<Summary> {
  try {
    return await shape.summarize(request, context);
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new TypeError(`refusing to record ${operation}: the request does not have the shape its line records`);
    }
    throw error;
  }
}

export function createDryRunLog(options: CreateDryRunLogOptions): DryRunLog {
  return {
    async would(operation, target, request) {
      const shape = SHAPES.get(operation);
      if (shape === undefined) throw new Error(`no dry-run line is defined for ${operation}`);
      if (typeof target !== 'string' || !shape.targets.some((pattern) => pattern.test(target))) {
        throw new TypeError(`refusing to record ${operation}: its target is not a name this operation records`);
      }
      const summary = await summarize(operation, shape, request, {
        keySet: () => options.addressKey.getKeySet(),
        nowMs: options.now(),
      });
      options.sink(`(dry-run) WOULD ${operation} ${target} ${canonicalJson(summary)}`);
    },
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
