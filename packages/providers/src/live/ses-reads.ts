import {
  GetConfigurationSetEventDestinationsCommand,
  GetEmailIdentityCommand,
  paginateListEmailIdentities,
  type SESv2Client,
} from '@aws-sdk/client-sesv2';
import type { EventDestinationFact, SesReadPort } from '../port-types.js';

const LIST_PAGE_SIZE = 1_000;

export interface CreateSesReadsOptions {
  client: () => SESv2Client;
}

// The closeability check's only three reads (D-06, Item 7): the identity's default configuration
// set, the full identity list, and one set's event destinations. No SES write ever goes through
// this adapter; plan 01-15 builds the full SesPort on top of it.
export function createSesReads(options: CreateSesReadsOptions): SesReadPort {
  return {
    async getEmailIdentity(emailIdentity) {
      const response = await options.client().send(new GetEmailIdentityCommand({ EmailIdentity: emailIdentity }));
      return response.ConfigurationSetName;
    },

    // The pages follow each other with no pause, so every page is the largest SES allows (1,000,
    // API_ListEmailIdentities): an account of up to 1,000 identities lists in one request, inside
    // the one-a-second quota readSesFacts paces its reads for.
    async listEmailIdentities() {
      const names: string[] = [];
      const pages = paginateListEmailIdentities({ client: options.client(), pageSize: LIST_PAGE_SIZE }, {});
      for await (const page of pages) {
        for (const identity of page.EmailIdentities ?? []) {
          if (identity.IdentityName !== undefined) names.push(identity.IdentityName);
        }
      }
      return names;
    },

    async getConfigurationSetEventDestinations(configurationSetName) {
      const response = await options.client().send(
        new GetConfigurationSetEventDestinationsCommand({ ConfigurationSetName: configurationSetName }),
      );
      return (response.EventDestinations ?? []).map(
        (destination): EventDestinationFact => ({
          name: destination.Name ?? '',
          enabled: destination.Enabled ?? false,
          eventBridge: destination.EventBridgeDestination !== undefined,
          matchingEventTypes: destination.MatchingEventTypes ?? [],
        }),
      );
    },
  };
}
