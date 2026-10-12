// Every value below is Fothering's own, declared once with its reason (D-48 to D-52). Phase 6's
// measurement protocol may change any of them before the first live run, in a reviewed commit and
// in this module only.

/** A threshold as a fraction of integers, so a compare is a cross-multiplication and never a float. */
export interface Rational {
  readonly numerator: number;
  readonly denominator: number;
}

// D-48: equal to the levels the SES reputation metrics page names for placing an account under
// review ("If your bounce rate is 5% or greater, we automatically place your account under review",
// "If your complaint rate is 0.1% or greater, we automatically place your account under review",
// https://docs.aws.amazon.com/ses/latest/dg/reputationdashboardmessages.html), so one lane at this
// ratio would alone bring a one-lane account to review. They are Fothering lane thresholds, not
// SES's figure: SES computes its rates over a "representative volume" and leaves out mailbox
// simulator mail and bounces to verified addresses, both of which a lane ratio counts.
export const HARD_BOUNCE_THRESHOLD: Rational = { numerator: 5, denominator: 100 };
export const COMPLAINT_THRESHOLD: Rational = { numerator: 1, denominator: 1000 };

// D-49: at the lane minimum of 100 sends one complaint already reads 1 percent, ten times the
// complaint threshold, and one report is not evidence that a stream went wrong.
export const MIN_RATIO_EVENTS = 3;

// D-50: at 100 sends the hard-bounce ratio moves in 1-point steps, so five permanent bounces are
// needed to reach 5 percent. A row under 20 sends cannot carry a cause, while one import batch of a
// small team can be a few dozen addresses.
export const LANE_MIN_RECIPIENT_SENDS = 100;
export const ROW_MIN_RECIPIENT_SENDS = 20;

// D-51: SES delivers events to EventBridge best effort, so a working destination covers nearly
// every recipient-send once the lateness horizon has passed, while a destination missing an event
// type (Delivery off) covers only its bounces, far below 90 percent.
export const COVERAGE_THRESHOLD: Rational = { numerator: 9, denominator: 10 };

export const LANE_TRIGGERS = ['hard-bounce', 'complaint'] as const;
export type LaneTrigger = (typeof LANE_TRIGGERS)[number];

export const THRESHOLD_BY_TRIGGER: Readonly<Record<LaneTrigger, Rational>> = {
  'hard-bounce': HARD_BOUNCE_THRESHOLD,
  complaint: COMPLAINT_THRESHOLD,
};

export const LANE_RATIO_LABELS = {
  hardBounce: 'Fothering lane hard-bounce ratio (permanent bounces over recipient-sends)',
  complaint: 'Fothering lane complaint ratio (complaints over recipient-sends)',
} as const;

export const LANE_SHARE_LABEL = 'share of the countable events Fothering stores for its lane-map sets';

export function ratioAtOrAbove(count: number, sends: number, threshold: Rational): boolean {
  return sends > 0 && count >= MIN_RATIO_EVENTS && count * threshold.denominator >= threshold.numerator * sends;
}

/** Hundredths of a percent, rounded half up from integers (D-56): 15 of 200 is "7.50%". */
export function renderPercent(count: number, sends: number): string | null {
  if (sends === 0) return null;
  const hundredths = Math.floor((count * 20_000 + sends) / (2 * sends));
  return `${Math.floor(hundredths / 100)}.${String(hundredths % 100).padStart(2, '0')}%`;
}

export const LANE_VERDICTS = ['spike', 'no-spike', 'not-enough-volume'] as const;
export type LaneVerdict = (typeof LANE_VERDICTS)[number];

export interface LaneTotals {
  recipientSends: number;
  permanentBounces: number;
  complaints: number;
}

export interface LaneSpikeVerdict {
  verdict: LaneVerdict;
  triggers: readonly LaneTrigger[];
  hardBounceRatio: string | null;
  complaintRatio: string | null;
}

export function laneSpikeVerdict(totals: LaneTotals): LaneSpikeVerdict {
  const ratios = {
    hardBounceRatio: renderPercent(totals.permanentBounces, totals.recipientSends),
    complaintRatio: renderPercent(totals.complaints, totals.recipientSends),
  };
  if (totals.recipientSends < LANE_MIN_RECIPIENT_SENDS) return { verdict: 'not-enough-volume', triggers: [], ...ratios };
  const triggers: LaneTrigger[] = [];
  if (ratioAtOrAbove(totals.permanentBounces, totals.recipientSends, HARD_BOUNCE_THRESHOLD)) triggers.push('hard-bounce');
  return { verdict: triggers.length > 0 ? 'spike' : 'no-spike', triggers, ...ratios };
}
