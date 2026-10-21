import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  GetAccountCommand,
  SendEmailCommand,
  SendingPausedException,
  SESv2Client,
  TooManyRequestsException,
} from '@aws-sdk/client-sesv2';
import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts';
import { kindOf } from '../port-types.js';
import type { LiveRunSendRequest } from '../live-run-port-types.js';
import { createLiveRunPortFactory } from './live-run-ports.js';

// Every client the adapter builds is a real SDK client, constructed through a subclass that records
// it and answers send from the scripted handler, so the resolved config is the SDK's own and no
// request ever leaves the process.
const harness = vi.hoisted(() => ({
  built: [] as Array<{ kind: 'ses' | 'sts'; client: { config: unknown } }>,
  sent: [] as Array<{ kind: 'ses' | 'sts'; client: unknown; command: unknown }>,
  answer: (_command: unknown): Promise<unknown> => Promise.reject(new Error('no answer scripted for this test')),
}));

vi.mock('@aws-sdk/client-sesv2', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-sesv2')>();
  class RecordingSESv2Client extends actual.SESv2Client {
    constructor(...args: ConstructorParameters<typeof actual.SESv2Client>) {
      super(...args);
      harness.built.push({ kind: 'ses', client: this });
      Object.defineProperty(this, 'send', {
        value: (command: unknown) => {
          harness.sent.push({ kind: 'ses', client: this, command });
          return harness.answer(command);
        },
      });
    }
  }
  return { ...actual, SESv2Client: RecordingSESv2Client };
});

vi.mock('@aws-sdk/client-sts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-sts')>();
  class RecordingSTSClient extends actual.STSClient {
    constructor(...args: ConstructorParameters<typeof actual.STSClient>) {
      super(...args);
      harness.built.push({ kind: 'sts', client: this });
      Object.defineProperty(this, 'send', {
        value: (command: unknown) => {
          harness.sent.push({ kind: 'sts', client: this, command });
          return harness.answer(command);
        },
      });
    }
  }
  return { ...actual, STSClient: RecordingSTSClient };
});

const PLANTED_ACCOUNT = '0'.repeat(12);
const PLANTED_ARN = `arn:aws:sts::${PLANTED_ACCOUNT}:assumed-role/planted-bulk-role/planted-session`;

const REQUEST: LiveRunSendRequest = {
  from: 'planted-sender@example.com',
  to: 'bounce+planted-1@simulator.amazonses.com',
  subject: 'planted subject',
  text: 'planted body',
  configurationSetName: 'fothering-bulk',
  tags: [
    { name: 'stream', value: 'newsletter' },
    { name: 'batch', value: 'planted-batch' },
    { name: 'fothering_run', value: 'live-20261021-s1-1' },
  ],
};

function answerWith(answer: (command: unknown) => unknown): void {
  harness.answer = async (command) => answer(command);
}

function namedRejection(promise: Promise<unknown>): Promise<string> {
  return promise.then(
    () => 'resolved',
    (error: unknown) => (error instanceof Error ? error.name : 'not an error'),
  );
}

afterEach(() => {
  harness.built.length = 0;
  harness.sent.length = 0;
  harness.answer = () => Promise.reject(new Error('no answer scripted for this test'));
});

describe('createLiveRunPortFactory builds its clients lazily, one per profile', () => {
  it('builds no client while making the factory and its ports', () => {
    const factory = createLiveRunPortFactory();
    factory.ses('planted-account');
    factory.ses('planted-bulk');
    factory.callerIdentity('planted-bulk');
    expect(harness.built).toHaveLength(0);
  });

  it('builds one SESv2Client per profile on first use, each on its own profile, eu-central-1 and one attempt', async () => {
    answerWith(() => ({ $metadata: { requestId: 'planted-request' } }));
    const factory = createLiveRunPortFactory();
    const first = factory.ses('planted-a');
    const second = factory.ses('planted-b');
    await first.getAccount();
    await first.getAccount();
    await second.getAccount();

    expect(harness.built.map((entry) => entry.kind)).toEqual(['ses', 'ses']);
    const configs = harness.built.map((entry) => (entry.client as SESv2Client).config);
    expect(configs.map((config) => config.profile)).toEqual(['planted-a', 'planted-b']);
    for (const config of configs) {
      await expect(config.region()).resolves.toBe('eu-central-1');
      await expect(config.maxAttempts()).resolves.toBe(1);
    }
    expect(harness.sent.map((entry) => entry.client)).toEqual([harness.built[0]?.client, harness.built[0]?.client, harness.built[1]?.client]);
  });

  it('builds one STSClient per profile on first use, each on its own profile, eu-central-1 and one attempt', async () => {
    answerWith(() => ({ Arn: PLANTED_ARN, Account: PLANTED_ACCOUNT, $metadata: {} }));
    const factory = createLiveRunPortFactory();
    await factory.callerIdentity('planted-a').getCallerIdentity();
    await factory.callerIdentity('planted-b').getCallerIdentity();

    expect(harness.built.map((entry) => entry.kind)).toEqual(['sts', 'sts']);
    const configs = harness.built.map((entry) => (entry.client as STSClient).config);
    expect(configs.map((config) => config.profile)).toEqual(['planted-a', 'planted-b']);
    for (const config of configs) {
      await expect(config.region()).resolves.toBe('eu-central-1');
      await expect(config.maxAttempts()).resolves.toBe(1);
    }
    expect(harness.sent.every((entry) => entry.command instanceof GetCallerIdentityCommand)).toBe(true);
  });

  it('stamps every port it returns as live', () => {
    const factory = createLiveRunPortFactory();
    expect([kindOf(factory.ses('planted-a')), kindOf(factory.callerIdentity('planted-a'))]).toEqual(['live', 'live']);
  });
});

describe('sendEmail sends one request holding only what the command decided', () => {
  it('sends exactly the sender, one recipient, a plain subject and UTF-8 body, the set and the tags in order', async () => {
    answerWith(() => ({ MessageId: 'planted-message', $metadata: { requestId: 'planted-request' } }));
    await createLiveRunPortFactory().ses('planted-bulk').sendEmail(REQUEST);

    expect(harness.sent).toHaveLength(1);
    const command = harness.sent[0]?.command;
    expect(command).toBeInstanceOf(SendEmailCommand);
    expect((command as SendEmailCommand).input).toStrictEqual({
      FromEmailAddress: 'planted-sender@example.com',
      Destination: { ToAddresses: ['bounce+planted-1@simulator.amazonses.com'] },
      Content: { Simple: { Subject: { Data: 'planted subject' }, Body: { Text: { Data: 'planted body', Charset: 'UTF-8' } } } },
      ConfigurationSetName: 'fothering-bulk',
      EmailTags: [
        { Name: 'stream', Value: 'newsletter' },
        { Name: 'batch', Value: 'planted-batch' },
        { Name: 'fothering_run', Value: 'live-20261021-s1-1' },
      ],
    });
  });

  it('returns the message id and the request id SES answered with', async () => {
    answerWith(() => ({ MessageId: 'planted-message', $metadata: { requestId: 'planted-request' } }));
    await expect(createLiveRunPortFactory().ses('planted-bulk').sendEmail(REQUEST)).resolves.toStrictEqual({
      messageId: 'planted-message',
      requestId: 'planted-request',
    });
  });

  it('rejects with MissingMessageIdError when SES answers without a message id', async () => {
    answerWith(() => ({ $metadata: { requestId: 'planted-request' } }));
    expect(await namedRejection(createLiveRunPortFactory().ses('planted-bulk').sendEmail(REQUEST))).toBe('MissingMessageIdError');
  });

  it('rejects with MissingMessageIdError when SES answers without a request id', async () => {
    answerWith(() => ({ MessageId: 'planted-message', $metadata: {} }));
    expect(await namedRejection(createLiveRunPortFactory().ses('planted-bulk').sendEmail(REQUEST))).toBe('MissingMessageIdError');
  });

  it.each([
    ['SendingPausedException', () => new SendingPausedException({ message: 'Sending is paused for this configuration set.', $metadata: {} })],
    ['TooManyRequestsException', () => new TooManyRequestsException({ message: 'Too many requests.', $metadata: {} })],
  ])('surfaces a thrown %s by its name, after one request', async (name, makeError) => {
    harness.answer = () => Promise.reject(makeError());
    expect(await namedRejection(createLiveRunPortFactory().ses('planted-bulk').sendEmail(REQUEST))).toBe(name);
    expect(harness.sent).toHaveLength(1);
  });
});

describe('getAccount returns the four recorded fields and nothing else', () => {
  it('maps a full answer to its four fields, leaving the account details behind', async () => {
    answerWith((command) => {
      expect(command).toBeInstanceOf(GetAccountCommand);
      return {
        ProductionAccessEnabled: true,
        SendQuota: { Max24HourSend: 50_000, MaxSendRate: 14, SentLast24Hours: 3 },
        VdmAttributes: { VdmEnabled: 'ENABLED' },
        Details: { WebsiteURL: 'https://planted.example.com', AdditionalContactEmailAddresses: ['planted-contact@example.com'] },
        $metadata: { requestId: 'planted-request' },
      };
    });
    await expect(createLiveRunPortFactory().ses('planted-account').getAccount()).resolves.toStrictEqual({
      vdmEnabled: 'ENABLED',
      productionAccessEnabled: true,
      maxSendRate: 14,
      requestId: 'planted-request',
    });
  });

  it('reads every field SES left out as the string absent', async () => {
    answerWith(() => ({ $metadata: {} }));
    await expect(createLiveRunPortFactory().ses('planted-account').getAccount()).resolves.toStrictEqual({
      vdmEnabled: 'absent',
      productionAccessEnabled: 'absent',
      maxSendRate: 'absent',
      requestId: 'absent',
    });
  });

  it('reads a quota with no MaxSendRate as absent', async () => {
    answerWith(() => ({ ProductionAccessEnabled: false, SendQuota: { Max24HourSend: 200 }, $metadata: { requestId: 'planted-request' } }));
    const account = await createLiveRunPortFactory().ses('planted-account').getAccount();
    expect([account.productionAccessEnabled, account.maxSendRate]).toEqual([false, 'absent']);
  });
});

describe('getCallerIdentity returns the role ARN and account only', () => {
  it('keeps the ARN and account and leaves the user id behind', async () => {
    answerWith(() => ({ Arn: PLANTED_ARN, Account: PLANTED_ACCOUNT, UserId: 'PLANTEDUSERID:planted-session', $metadata: {} }));
    await expect(createLiveRunPortFactory().callerIdentity('planted-bulk').getCallerIdentity()).resolves.toStrictEqual({
      arn: PLANTED_ARN,
      account: PLANTED_ACCOUNT,
    });
  });

  it.each([
    ['no ARN', { Account: PLANTED_ACCOUNT }],
    ['no account', { Arn: PLANTED_ARN }],
  ])('rejects with MissingCallerIdentityError when STS answers with %s', async (_label, answer) => {
    answerWith(() => ({ ...answer, $metadata: {} }));
    expect(await namedRejection(createLiveRunPortFactory().callerIdentity('planted-bulk').getCallerIdentity())).toBe(
      'MissingCallerIdentityError',
    );
  });
});
