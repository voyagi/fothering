import type { Provenance } from '@fothering/core/records';

export type LimitsMark = 'later' | 'open';

export interface ProvenanceLabel {
  readonly stamp: string;
  readonly caption: string;
  readonly captionLinkHref?: string;
  readonly titleBlockStatus: string;
  readonly limitsState: string;
  readonly limitsMark: LimitsMark;
  readonly limitsNote: string;
  readonly timeWording: string;
}

// The simulator caption's second sentence rests on this page, so the link travels with the caption
// rather than living in a page that might render the sentence without it.
const SES_REPUTATION_PAGE = 'https://docs.aws.amazon.com/ses/latest/dg/reputationdashboardmessages.html';

export const PROVENANCE_LABELS = {
  'doc-derived': {
    stamp: 'FIXTURE RUN',
    caption: "Fixture built from AWS's documented event examples. Times are illustrative. Not a live account.",
    titleBlockStatus: 'fixture',
    limitsState: 'Fixture',
    limitsMark: 'later',
    limitsNote: "Built from AWS's documented event examples. A live run replaces it.",
    timeWording: 'Times are illustrative.',
  },
  generated: {
    stamp: 'FIXTURE RUN',
    caption: 'Generated fixture. Times are illustrative. Not a live account.',
    titleBlockStatus: 'fixture',
    limitsState: 'Fixture',
    limitsMark: 'later',
    limitsNote: "Generated for this site in the shape of AWS's documented SES events. A live run replaces it.",
    timeWording: 'Times are illustrative.',
  },
  'simulator-captured': {
    stamp: 'SIMULATOR RUN',
    caption:
      'Captured from the SES mailbox simulator in eu-central-1. Simulator mail does not count toward SES reputation metrics.',
    captionLinkHref: SES_REPUTATION_PAGE,
    titleBlockStatus: 'simulator',
    limitsState: 'Simulator',
    limitsMark: 'later',
    limitsNote: 'Captured from the SES mailbox simulator, not from real recipients.',
    timeWording: 'Times are as captured, in UTC.',
  },
  live: {
    stamp: 'LIVE RUN',
    caption: 'Recorded from a live run in eu-central-1.',
    titleBlockStatus: 'live',
    limitsState: 'Live',
    limitsMark: 'open',
    limitsNote: 'Recorded from a live run whose capture manifest the build checked.',
    timeWording: 'Times are as recorded, in UTC.',
  },
} as const satisfies Record<Provenance, ProvenanceLabel>;
