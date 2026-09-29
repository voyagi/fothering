import {
  GetConfigurationSetEventDestinationsCommand,
  GetEmailIdentityCommand,
  paginateListEmailIdentities,
  type SESv2Client,
} from '@aws-sdk/client-sesv2';
import type { EventDestinationFact, SesReadPort } from '../port-types.js';

const LIST_PAGE_SIZE = 1_000;

// The error both per-item reads throw when the identity or the configuration set does not exist
// (the command pages for GetEmailIdentity and GetConfigurationSetEventDestinations).
const NOT_FOUND = 'NotFoundException';

function isNotFound(error: unknown): boolean {
  return error instanceof Error && error.name === NOT_FOUND;
}

export interface CreateSesReadsOptions {
  client: () => SESv2Client;
}

// The closeability check's only three reads (D-06, Item 7): the identity's default configuration
// set, the full identity list, and one set's event destinations. No SES write ever goes through
// this adapter; plan 01-15 builds the full SesPort on top of it.
export function createSesReads(options: CreateSesReadsOptions): SesReadPort {
  return {
    // An identity deleted after the list read (readSesFacts reads them a second apart) can no longer
    // send, so it defaults no send to any set: the same answer as an identity with no default set.
    async getEmailIdentity(emailIdentity) {
      try {
        const response = await options.client().send(new GetEmailIdentityCommand({ EmailIdentity: emailIdentity }));
        return response.ConfigurationSetName;
      } catch (error) {
        if (isNotFound(error)) return undefined;
        throw error;
      }
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

    // A lane-map set SES does not hold publishes nothing, so it answers no destinations and the
    // closeability check refuses that one set, instead of the error failing the read for every set.
    async getConfigurationSetEventDestinations(configurationSetName) {
      try {
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
      } catch (error) {
        if (isNotFound(error)) return [];
        throw error;
      }
    },
  };
}
