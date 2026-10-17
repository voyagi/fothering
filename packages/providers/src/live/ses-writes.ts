import type { SESv2Client } from '@aws-sdk/client-sesv2';
import type { SesPort } from '../port-types.js';

export interface CreateSesWritesOptions {
  client: () => SESv2Client;
}

export function createSesWrites(options: CreateSesWritesOptions): Pick<
  SesPort,
  'getConfigurationSetSending' | 'pauseConfigurationSet' | 'reopenConfigurationSet' | 'sendEmail'
> {
  void options;
  return {
    async getConfigurationSetSending() {
      return {};
    },
    async pauseConfigurationSet() {},
    async reopenConfigurationSet() {},
    async sendEmail() {
      return { messageId: '' };
    },
  };
}
