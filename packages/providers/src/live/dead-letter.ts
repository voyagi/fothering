import { SendMessageCommand, type SQSClient } from '@aws-sdk/client-sqs';
import { requireLiveConfig, type DeadLetterPort } from '../port-types.js';

export interface CreateSqsDeadLetterOptions {
  queueUrl: string | undefined;
  client: () => SQSClient;
}

export function createSqsDeadLetter(options: CreateSqsDeadLetterOptions): DeadLetterPort {
  return {
    async send(records) {
      const queueUrl = requireLiveConfig(options.queueUrl, 'FOTHERING_DLQ_URL');
      await options.client().send(new SendMessageCommand({ QueueUrl: queueUrl, MessageBody: JSON.stringify({ records }) }));
    },
  };
}
