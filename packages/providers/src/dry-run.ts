import * as z from 'zod';
import { normalizeAddress, pseudonymizeRecipient, type AddressKeySet } from '@fothering/core/address';
import { CONFIGURATION_SET_PATTERN } from '@fothering/core/lanes';
import { MODEL_VALUES } from '@fothering/core/model-values';
import type {
  AddressKeyPort,
  AgentCorePort,
  BedrockModelPort,
  DryRunSink,
  SendEmailRequest,
  SesPort,
} from './port-types.js';
import { INCIDENT_PARTS, canonicalJson } from '@fothering/core/evidence-record';

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
// The decision store's four partition key shapes (D-65, D-99): the incident marker and pause pointer
// under a configuration set, an incident by its 32-hex id, a UTC day counter and a lane-hour counter.
// Its sort keys are a closed set of words.
const INCIDENT_LANE_PARTITION_KEY = new RegExp(`^INCIDENT_LANE#${CONFIGURATION_SET_PATTERN.source.replace(/^\^/, '')}`);
const INCIDENT_PARTITION_KEY = /^INCIDENT#[0-9a-f]{32}$/;
const COUNTER_DAY_PARTITION_KEY = /^COUNTER_DAY#\d{4}-\d{2}-\d{2}$/;
// Pitfall 8: the set rule goes in the middle of this key, so both its anchors come off; a $ left in
// place would match nothing and refuse every lane-hour line.
const CONFIGURATION_SET_BODY = CONFIGURATION_SET_PATTERN.source.replace(/^\^/, '').replace(/\$$/, '');
const COUNTER_LANE_HOUR_PARTITION_KEY = new RegExp(`^COUNTER_LANE_HOUR#${CONFIGURATION_SET_BODY}#\\d{4}-\\d{2}-\\d{2}T\\d{2}$`);
const DECISION_PARTITION_KEYS = [INCIDENT_LANE_PARTITION_KEY, INCIDENT_PARTITION_KEY, COUNTER_DAY_PARTITION_KEY, COUNTER_LANE_HOUR_PARTITION_KEY];
// MARKER and PAUSE sit under INCIDENT_LANE#, the incident parts under INCIDENT#.
const DECISION_SORT_KEY = new RegExp(`^(?:MARKER|PAUSE|${INCIDENT_PARTS.join('|')})$`);
const MODEL_ID = /^[A-Za-z0-9._:-]{1,256}$/;
const RUNTIME_ARN = /^arn:[A-Za-z0-9:/_.-]{1,512}$/;
const DEAD_LETTER_TARGET = new RegExp(`^${DEAD_LETTER_QUEUE_TARGET}$`);

const recordKeySchema = z.object({ pk: z.string().regex(RECORD_PARTITION_KEY), sk: z.string().regex(RECORD_SORT_KEY) });
const configurationSetSchema = z.string().regex(CONFIGURATION_SET_PATTERN);
// A header name is held to the field-name letters RFC 5322 mail uses here, so no address or sentence can
// ride along in one; a header value never reaches the line.
const HEADER_NAME = /^[A-Za-z0-9-]{1,126}$/;
const sendEmailSchema = z.object({
  from: z.string(),
  to: z.array(z.string()),
  subject: z.string(),
  text: z.string(),
  configurationSetName: configurationSetSchema.optional(),
  headers: z.array(z.object({ name: z.string().regex(HEADER_NAME), value: z.string() })).optional(),
});
// Two integers and the model id, never a message: the request a model line records is built field by
// field from counts, so no prompt or answer text can reach the line (T-02-10).
const streamSchema = z.object({
  modelId: z.string().regex(MODEL_ID),
  messageCount: z.int().nonnegative(),
  promptBytes: z.int().nonnegative(),
});
const invokeSchema = z.object({ runtimeArn: z.string(), payload: z.unknown() });
const decisionKeySchema = z.object({
  pk: z.string().refine((pk) => DECISION_PARTITION_KEYS.some((pattern) => pattern.test(pk))),
  sk: z.string().regex(DECISION_SORT_KEY),
});
const counterKeysSchema = { incidentKey: decisionKeySchema, dayKey: decisionKeySchema };
const reservationSchema = z.object({
  ...counterKeysSchema,
  incidentCap: z.int().nonnegative(),
  dayInvocationCap: z.int().nonnegative(),
  dayTokenCap: z.int().nonnegative(),
  tokenReservation: z.int().nonnegative(),
  expiresAt: z.int().nonnegative(),
});
const usageSchema = z.object({
  ...counterKeysSchema,
  inputTokens: z.int().nonnegative(),
  outputTokens: z.int().nonnegative(),
  modelCalls: z.int().nonnegative(),
});
const laneAttemptSchema = z.object({
  key: z.object({ pk: z.string().regex(COUNTER_LANE_HOUR_PARTITION_KEY), sk: z.literal('COUNTER') }),
  cap: z.int().positive(),
  expiresAt: z.int().nonnegative(),
});

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
    ...(email.headers !== undefined ? { headers: email.headers.map((header) => header.name) } : {}),
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

// A reservation or a usage line holds its integers alone: the keys are checked, never printed, since
// the target already names the incident.
function summarizeReservation(request: unknown): Summary {
  const { incidentCap, dayInvocationCap, dayTokenCap, tokenReservation, expiresAt } = reservationSchema.parse(request);
  return { incidentCap, dayInvocationCap, dayTokenCap, tokenReservation, expiresAt };
}

function summarizeUsage(request: unknown): Summary {
  const { inputTokens, outputTokens, modelCalls } = usageSchema.parse(request);
  return { inputTokens, outputTokens, modelCalls };
}

function summarizeLaneAttempt(request: unknown): Summary {
  const { cap, expiresAt } = laneAttemptSchema.parse(request);
  return { cap, expiresAt };
}

const SHAPES = new Map<string, DryRunShape>([
  ['eventStore.putIfAbsent', RECORD_KEY_SHAPE],
  ['eventStore.deleteRecord', RECORD_KEY_SHAPE],
  ['decisionStore.putIfAbsent', { targets: DECISION_PARTITION_KEYS, summarize: (request) => decisionKeySchema.parse(request) }],
  [
    'decisionStore.updateIfVersion',
    {
      targets: DECISION_PARTITION_KEYS,
      summarize: (request) => decisionKeySchema.extend({ expectedVersion: z.int().nonnegative() }).parse(request),
    },
  ],
  ['decisionStore.reserveInvocation', { targets: [INCIDENT_PARTITION_KEY], summarize: summarizeReservation }],
  ['decisionStore.recordUsage', { targets: [INCIDENT_PARTITION_KEY], summarize: summarizeUsage }],
  ['decisionStore.reserveLaneAttempt', { targets: [COUNTER_LANE_HOUR_PARTITION_KEY], summarize: summarizeLaneAttempt }],
  ['deadLetter.send', { targets: [DEAD_LETTER_TARGET], summarize: summarizeDeadLetter }],
  ['ses.pauseConfigurationSet', CONFIGURATION_SET_SHAPE],
  ['ses.reopenConfigurationSet', CONFIGURATION_SET_SHAPE],
  ['ses.sendEmail', { targets: [CONFIGURATION_SET_PATTERN, RECEIVING_DOMAIN], summarize: summarizeSend }],
  [
    'bedrockModel.stream',
    {
      targets: [MODEL_ID],
      summarize: (request) => {
        const { modelId, messageCount, promptBytes } = streamSchema.parse(request);
        return { modelId, messageCount, promptBytes };
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

// A dry-run model call yields no event: nothing was asked of the model, so nothing came back. The
// line is written when the stream is first iterated, as a real call would only start then.
export function createBedrockModelDryRun(log: DryRunLog): BedrockModelPort {
  return {
    async *stream(messages, options) {
      await log.would('bedrockModel.stream', MODEL_VALUES.inferenceProfileId, {
        modelId: MODEL_VALUES.inferenceProfileId,
        messageCount: messages.length,
        promptBytes: Buffer.byteLength(JSON.stringify({ messages, systemPrompt: options?.systemPrompt })),
      });
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
