import { GetAccountCommand, SendEmailCommand, SESv2Client, type SendEmailCommandInput } from '@aws-sdk/client-sesv2';
import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts';
import type {
  CallerIdentityPort,
  LiveRunAccount,
  LiveRunPortFactory,
  LiveRunSendRequest,
  LiveRunSendResult,
  LiveRunSesPort,
} from '../live-run-port-types.js';
import { brandPort } from '../port-types.js';
import { lazyClient } from './lazy-client.js';

// Its own constant rather than ports.ts's: ports.ts feeds the deployed bundles and stays as audited.
const LIVE_RUN_REGION = 'eu-central-1';

// The command spaces its own sends 1,250 ms apart and records every attempt. An SDK retry would be
// a second request inside that gap that no attempt record shows, so each client makes one attempt.
const ONE_ATTEMPT = 1;

// The attempt log records a fault by its error name alone, so each missing field gets its own name.
class MissingMessageIdError extends Error {
  override name = 'MissingMessageIdError';
}

class MissingCallerIdentityError extends Error {
  override name = 'MissingCallerIdentityError';
}

function sendInput(request: LiveRunSendRequest): SendEmailCommandInput {
  const subject = { Data: request.subject };
  const body = { Text: { Data: request.text, Charset: 'UTF-8' } };
  return {
    FromEmailAddress: request.from,
    Destination: { ToAddresses: [request.to] },
    Content: { Simple: { Subject: subject, Body: body } },
    ConfigurationSetName: request.configurationSetName,
    EmailTags: request.tags.map(({ name, value }) => ({ Name: name, Value: value })),
  };
}

function sesPort(profile: string): LiveRunSesPort {
  const client = lazyClient(() => new SESv2Client({ region: LIVE_RUN_REGION, profile, maxAttempts: ONE_ATTEMPT }));
  return brandPort(
    {
      async getAccount(): Promise<LiveRunAccount> {
        const response = await client().send(new GetAccountCommand({}));
        return {
          vdmEnabled: response.VdmAttributes?.VdmEnabled ?? 'absent',
          productionAccessEnabled: response.ProductionAccessEnabled ?? 'absent',
          maxSendRate: response.SendQuota?.MaxSendRate ?? 'absent',
          requestId: response.$metadata.requestId ?? 'absent',
        };
      },
      async sendEmail(request: LiveRunSendRequest): Promise<LiveRunSendResult> {
        const response = await client().send(new SendEmailCommand(sendInput(request)));
        const messageId = response.MessageId;
        const requestId = response.$metadata.requestId;
        if (messageId === undefined || requestId === undefined) {
          throw new MissingMessageIdError('SES answered SendEmail without a message id or request id');
        }
        return { messageId, requestId };
      },
    },
    'live',
  );
}

function callerIdentityPort(profile: string): CallerIdentityPort {
  const client = lazyClient(() => new STSClient({ region: LIVE_RUN_REGION, profile, maxAttempts: ONE_ATTEMPT }));
  return brandPort(
    {
      async getCallerIdentity() {
        const { Arn, Account } = await client().send(new GetCallerIdentityCommand({}));
        if (Arn === undefined || Account === undefined) {
          throw new MissingCallerIdentityError('STS answered GetCallerIdentity without an ARN or account');
        }
        return { arn: Arn, account: Account };
      },
    },
    'live',
  );
}

/** One client per profile, built on the first port call, so each lane signs as its own caller. */
export function createLiveRunPortFactory(): LiveRunPortFactory {
  return { ses: sesPort, callerIdentity: callerIdentityPort };
}
