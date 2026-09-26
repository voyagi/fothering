import { SendMessageCommand, type SQSClient } from '@aws-sdk/client-sqs';
import { LiveConfigMissingError, type DeadLetterPort } from '../port-types.js';

export interface CreateSqsDeadLetterOptions {
  queueUrl: string | undefined;
  client: () => SQSClient;
}

export function createSqsDeadLetter(options: CreateSqsDeadLetterOptions): DeadLetterPort {
  return {
    async send(records) {
      if (options.queueUrl === undefined) throw new LiveConfigMissingError('FOTHERING_DLQ_URL');
      await options.client().send(
        new SendMessageCommand({ QueueUrl: options.queueUrl, MessageBody: JSON.stringify({ records }) }),
      );
    },
  };
}
