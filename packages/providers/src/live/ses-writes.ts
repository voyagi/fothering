import {
  GetConfigurationSetCommand,
  PutConfigurationSetSendingOptionsCommand,
  SendEmailCommand,
  type SESv2Client,
} from '@aws-sdk/client-sesv2';
import type { ConfigurationSetSending, SesPort } from '../port-types.js';

export interface CreateSesWritesOptions {
  client: () => SESv2Client;
}

export type SesWritePort = Pick<SesPort, 'getConfigurationSetSending' | 'pauseConfigurationSet' | 'reopenConfigurationSet' | 'sendEmail'>;

// SES API v2 only: the per-set sending switch and one simple text send. No error is mapped here: a
// put that throws decides nothing, since the caller reads the set back after it (WR-05), a read-back
// that throws is the caller's pause-unknown or reopen-unknown, a send that throws a spent attempt
// (03-RESEARCH Finding 2).
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
    // A plain text body, plus the request's headers when it carries any, which is only ever the Article
    // 50(2) marker: no reply-to, attachments, tenant or list options (D-114).
    async sendEmail(request) {
      const headers = request.headers?.map(({ name, value }) => ({ Name: name, Value: value }));
      const response = await options.client().send(
        new SendEmailCommand({
          FromEmailAddress: request.from,
          Destination: { ToAddresses: request.to },
          Content: {
            Simple: {
              Subject: { Data: request.subject },
              Body: { Text: { Data: request.text, Charset: 'UTF-8' } },
              ...(headers === undefined ? {} : { Headers: headers }),
            },
          },
          ...(request.configurationSetName === undefined ? {} : { ConfigurationSetName: request.configurationSetName }),
        }),
      );
      // A success answer with no message id is still a message SES accepted: retrying it would mail the
      // operator again. The empty id fails SES_ID_PATTERN, so the caller records the send with no id.
      return { messageId: response.MessageId ?? '' };
    },
  };
}
