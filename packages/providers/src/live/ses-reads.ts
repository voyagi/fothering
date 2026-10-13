import {
  GetConfigurationSetEventDestinationsCommand,
  GetEmailIdentityCommand,
  paginateListConfigurationSets,
  paginateListEmailIdentities,
  type GetEmailIdentityResponse,
  type SESv2Client,
} from '@aws-sdk/client-sesv2';
import type { EmailIdentityFacts, EventDestinationFact, SesReadPort } from '../port-types.js';
import { SES_READ_SPACING_MS, sleep } from '../ses-facts.js';
import { hasErrorName } from './error-name.js';

const LIST_PAGE_SIZE = 1_000;

type Wait = (ms: number) => Promise<void>;

// SES allows one request a second for every action but sending, the quota readSesFacts spaces its
// reads for. The paginator asks for the next page only when this loop comes back for it, and only
// when the last page carried a token, so waiting after a page with a token keeps every request of
// a list a second apart and adds no wait after the last page.
async function collectPages<Page extends { NextToken?: string | undefined }>(
  pages: AsyncIterable<Page>,
  wait: Wait,
  namesOf: (page: Page) => readonly (string | undefined)[],
): Promise<string[]> {
  const names: string[] = [];
  for await (const page of pages) {
    for (const name of namesOf(page)) {
      if (name !== undefined) names.push(name);
    }
    if (page.NextToken !== undefined && page.NextToken !== '') await wait(SES_READ_SPACING_MS);
  }
  return names;
}

// The error both per-item reads throw when the identity or the configuration set does not exist
// (the command pages for GetEmailIdentity and GetConfigurationSetEventDestinations).
const NOT_FOUND = 'NotFoundException';

function isNotFound(error: unknown): boolean {
  return hasErrorName(error, NOT_FOUND);
}

// exactOptionalPropertyTypes: a fact SES left out stays an absent key, so a reader never sees a key
// holding undefined that it would have to tell apart from a value.
function emailIdentityFacts(response: GetEmailIdentityResponse): EmailIdentityFacts {
  const facts = {
    defaultConfigurationSet: response.ConfigurationSetName,
    dkimStatus: response.DkimAttributes?.Status,
    dkimSigningEnabled: response.DkimAttributes?.SigningEnabled,
    mailFromDomain: response.MailFromAttributes?.MailFromDomain,
    mailFromStatus: response.MailFromAttributes?.MailFromDomainStatus,
    identityType: response.IdentityType,
  };
  return Object.fromEntries(Object.entries(facts).filter(([, value]) => value !== undefined)) as EmailIdentityFacts;
}

export interface CreateSesReadsOptions {
  client: () => SESv2Client;
  /** The pause between the pages of a list; a real one-second timer when left out. */
  wait?: Wait;
}

// The closeability check's only four reads (D-06, Item 7): the identity's default configuration
// set with its DKIM and MAIL FROM facts (D-59), the full identity list, the full configuration set
// list, and one set's event destinations.
// No SES write ever goes through this adapter; plan 01-15 builds the full SesPort on top of it.
export function createSesReads(options: CreateSesReadsOptions): SesReadPort {
  const wait = options.wait ?? sleep;
  return {
    // An identity deleted after the list read (readSesFacts reads them a second apart) can no longer
    // send, so it defaults no send to any set: the same answer as an identity with no default set.
    async getEmailIdentity(emailIdentity) {
      try {
        const response = await options.client().send(new GetEmailIdentityCommand({ EmailIdentity: emailIdentity }));
        return emailIdentityFacts(response);
      } catch (error) {
        if (isNotFound(error)) return undefined;
        throw error;
      }
    },

    // Every page is the largest SES allows (1,000, API_ListEmailIdentities), so an account of up to
    // 1,000 identities lists in one request and a larger one waits a second per extra page.
    async listEmailIdentities() {
      const pages = paginateListEmailIdentities({ client: options.client(), pageSize: LIST_PAGE_SIZE }, {});
      return collectPages(pages, wait, (page) => (page.EmailIdentities ?? []).map((identity) => identity.IdentityName));
    },

    // API_ListConfigurationSets documents no page-size range, so the pages keep SES's own default
    // size and are spaced a second apart like the identity list's.
    async listConfigurationSets() {
      const pages = paginateListConfigurationSets({ client: options.client() }, {});
      return collectPages(pages, wait, (page) => page.ConfigurationSets ?? []);
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
