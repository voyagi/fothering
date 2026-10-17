import {
  GetConfigurationSetCommand,
  PutConfigurationSetSendingOptionsCommand,
  SendEmailCommand,
  type SESv2Client,
} from '@aws-sdk/client-sesv2';
import type { ConfigurationSetSending, SesPort } from '../port-types.js';

/** SES accepted the send and named no message: nothing can be stored or traced, so it counts as not sent. */
export class MissingMessageIdError extends Error {
  constructor() {
    super('SES answered the send with no message id');
    this.name = 'MissingMessageIdError';
  }
}

export interface CreateSesWritesOptions {
  client: () => SESv2Client;
}

export type SesWritePort = Pick<SesPort, 'getConfigurationSetSending' | 'pauseConfigurationSet' | 'reopenConfigurationSet' | 'sendEmail'>;

// SES API v2 only: the per-set sending switch and one simple text send. No error is mapped here: a
// put that throws is the caller's pause-failed, a read-back that throws its pause-unknown, a send that
// throws a spent attempt (03-RESEARCH Finding 2).
export function createSesWrites(options: CreateSesWritesOptions): SesWritePort {
  // SendingEnabled is optional on the wire, so both directions always send it rather than lean on a default.
  const putSending = async (configurationSet: string, sendingEnabled: boolean): Promise<void> => {
    await options.client().send(new PutConfigurationSetSendingOptionsCommand({ ConfigurationSetName: configurationSet, SendingEnabled: sendingEnabled }));
  };
  return {
    // exactOptionalPropertyTypes: an answer without the field stays an absent key, which the caller reads as missing.
    async getConfigurationSetSending(configurationSet): Promise<ConfigurationSetSending> {
      const response = await options.client().send(new GetConfigurationSetCommand({ ConfigurationSetName: configurationSet }));
      const sendingEnabled = response.SendingOptions?.SendingEnabled;
      return sendingEnabled === undefined ? {} : { sendingEnabled };
    },
    pauseConfigurationSet: (configurationSet) => putSending(configurationSet, false),
    reopenConfigurationSet: (configurationSet) => putSending(configurationSet, true),
    // A plain text body and nothing else: no reply-to, headers, attachments, tenant or list options (D-114).
    async sendEmail(request) {
      const response = await options.client().send(
        new SendEmailCommand({
          FromEmailAddress: request.from,
          Destination: { ToAddresses: request.to },
          Content: { Simple: { Subject: { Data: request.subject }, Body: { Text: { Data: request.text, Charset: 'UTF-8' } } } },
          ...(request.configurationSetName === undefined ? {} : { ConfigurationSetName: request.configurationSetName }),
        }),
      );
      if (response.MessageId === undefined || response.MessageId === '') throw new MissingMessageIdError();
      return { messageId: response.MessageId };
    },
  };
}
