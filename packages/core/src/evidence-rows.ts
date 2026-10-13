import {
  LANE_MIN_RECIPIENT_SENDS,
  LANE_SHARE_LABEL,
  MIN_RATIO_EVENTS,
  ROW_MIN_RECIPIENT_SENDS,
  THRESHOLD_BY_TRIGGER,
  ratioAtOrAbove,
  renderPercent,
  type LaneSpikeVerdict,
  type LaneTotals,
  type LaneTrigger,
} from './verdicts.js';
import type { BucketCount } from './buckets.js';
import { validHostname } from './extract.js';
import { UNCLASSIFIED } from './records.js';
import type { ConfigurationRecord, DimensionTally, WindowSummary } from './window-fold.js';

export const ROW_VERDICTS = ['cause', 'elevated', 'ruled-out', 'not-enough-volume'] as const;
export type RowVerdict = (typeof ROW_VERDICTS)[number];

export const ROW_DIMENSIONS = ['batch', 'template', 'campaign', 'provider'] as const;
export type RowDimension = (typeof ROW_DIMENSIONS)[number];
export type TagDimension = Exclude<RowDimension, 'provider'>;

export const ROW_KINDS = ['value', 'no-value', 'other'] as const;
export type RowKind = (typeof ROW_KINDS)[number];

export interface AppliedThreshold {
  ratio: LaneTrigger;
  numerator: number;
  denominator: number;
  minEvents: number;
  minSends: number;
}

export interface EvidenceRow {
  dimension: RowDimension;
  kind: RowKind;
  value: string | null;
  sends: number;
  permanentBounces: number;
  complaints: number;
  hardBounceRatio: string | null;
  complaintRatio: string | null;
  sharePercent: string | null;
  verdict: RowVerdict;
  thresholds: AppliedThreshold[];
  fromBucketMs: number;
  toBucketMs: number;
}

export const CONFIGURATION_STATES = ['present', 'missing', 'unknown', 'not-applicable'] as const;
export const CONFIGURATION_VERDICTS = ['cause', 'elevated', 'ruled-out', 'unknown', 'not-applicable'] as const;

export type ConfigurationLookup =
  | { kind: 'ses'; operation: 'GetEmailIdentity'; identity: string | null }
  | { kind: 'dns'; name: string; recordType: 'TXT' | 'MX'; outcome: 'records' | 'missing' | 'unknown' };

export interface ConfigurationRow {
  fromDomain: string;
  record: ConfigurationRecord;
  state: (typeof CONFIGURATION_STATES)[number];
  verdict: (typeof CONFIGURATION_VERDICTS)[number];
  lookups: ConfigurationLookup[];
  corroboration: { corroboratingBounces: number; permanentBounces: number };
}

// Strongest first: a row reports the strongest verdict any trigger gives it (D-56).
const VERDICT_STRENGTH: readonly RowVerdict[] = ['cause', 'elevated', 'ruled-out', 'not-enough-volume'];

const COUNT_BY_TRIGGER: Readonly<Record<LaneTrigger, 'permanentBounces' | 'complaints'>> = {
  'hard-bounce': 'permanentBounces',
  complaint: 'complaints',
};

function verdictForTrigger(row: DimensionTally, lane: LaneTotals, trigger: LaneTrigger): RowVerdict {
  const field = COUNT_BY_TRIGGER[trigger];
  const threshold = THRESHOLD_BY_TRIGGER[trigger];
  if (!ratioAtOrAbove(row[field], row.sends, threshold)) return 'ruled-out';
  const remainderSends = lane.recipientSends - row.sends;
  // D-50: a remainder under the lane minimum cannot read a spike on its own, so it counts as below.
  const laneStillAtOrAbove =
    remainderSends >= LANE_MIN_RECIPIENT_SENDS && ratioAtOrAbove(lane[field] - row[field], remainderSends, threshold);
  return laneStillAtOrAbove ? 'elevated' : 'cause';
}

export function rowVerdict(row: DimensionTally, laneTotals: LaneTotals, triggers: readonly LaneTrigger[]): RowVerdict {
  if (row.sends < ROW_MIN_RECIPIENT_SENDS) return 'not-enough-volume';
  let strongest: RowVerdict = 'ruled-out';
  for (const trigger of triggers) {
    const verdict = verdictForTrigger(row, laneTotals, trigger);
    if (VERDICT_STRENGTH.indexOf(verdict) < VERDICT_STRENGTH.indexOf(strongest)) strongest = verdict;
  }
  return strongest;
}

function appliedThresholds(triggers: readonly LaneTrigger[]): AppliedThreshold[] {
  return triggers.map((ratio) => ({
    ratio,
    numerator: THRESHOLD_BY_TRIGGER[ratio].numerator,
    denominator: THRESHOLD_BY_TRIGGER[ratio].denominator,
    minEvents: MIN_RATIO_EVENTS,
    minSends: ROW_MIN_RECIPIENT_SENDS,
  }));
}

function compareValueBytes(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

// D-56: ten rows per dimension keep the evidence record within a few kilobytes (D-70), and one hour of
// a small team's mail rarely carries more batches, templates or campaigns; the rest merge into one
// other row so the dimension still sums to the lane totals.
export const ROW_LIMIT = 10;

interface RowContext {
  dimension: RowDimension;
  summary: WindowSummary;
  spike: LaneSpikeVerdict;
  thresholds: AppliedThreshold[];
}

function rowContext(dimension: RowDimension, summary: WindowSummary, spike: LaneSpikeVerdict): RowContext {
  return { dimension, summary, spike, thresholds: appliedThresholds(spike.triggers) };
}

// A no-value, other or provider other row names nothing the operator could stop on its own, so a
// spike it carries ends unknown and asks rather than settling a cause (D-56).
function atMostElevated(verdict: RowVerdict): RowVerdict {
  return verdict === 'cause' ? 'elevated' : verdict;
}

function rowOf(context: RowContext, kind: RowKind, value: string | null, tally: DimensionTally): EvidenceRow {
  const lane: LaneTotals = context.summary.totals;
  const verdict = rowVerdict(tally, lane, context.spike.triggers);
  return {
    dimension: context.dimension,
    kind,
    value,
    sends: tally.sends,
    permanentBounces: tally.permanentBounces,
    complaints: tally.complaints,
    hardBounceRatio: renderPercent(tally.permanentBounces, tally.sends),
    complaintRatio: renderPercent(tally.complaints, tally.sends),
    sharePercent: renderPercent(tally.sends, lane.recipientSends),
    verdict: kind === 'value' ? verdict : atMostElevated(verdict),
    thresholds: context.thresholds.map((threshold) => ({ ...threshold })),
    fromBucketMs: context.summary.window.fromBucketMs,
    toBucketMs: context.summary.window.toBucketMs,
  };
}

function hasCounts(tally: DimensionTally): boolean {
  return tally.sends + tally.permanentBounces + tally.complaints > 0;
}

function addInto(target: DimensionTally, addition: DimensionTally): void {
  target.sends += addition.sends;
  target.permanentBounces += addition.permanentBounces;
  target.complaints += addition.complaints;
}

function largestFirst([leftValue, left]: [string, DimensionTally], [rightValue, right]: [string, DimensionTally]): number {
  return right.sends - left.sends || compareValueBytes(leftValue, rightValue);
}

/** The ROW_LIMIT largest values of a tag dimension by sends and then by value bytes, so two runs over
 * the same records serialize identically (AC-E19), then the no-value row, then one other row. */
export function buildTagRows(dimension: TagDimension, summary: WindowSummary, spike: LaneSpikeVerdict): EvidenceRow[] {
  const context = rowContext(dimension, summary, spike);
  const ranked = [...summary.dimensions[dimension]].sort(largestFirst);
  const rows = ranked.slice(0, ROW_LIMIT).map(([value, tally]) => rowOf(context, 'value', value, tally));
  const noValue = summary.noValue[dimension];
  if (hasCounts(noValue)) rows.push(rowOf(context, 'no-value', null, noValue));
  const rest = ranked.slice(ROW_LIMIT);
  if (rest.length > 0) {
    const other = { sends: 0, permanentBounces: 0, complaints: 0 };
    for (const [, tally] of rest) addInto(other, tally);
    rows.push(rowOf(context, 'other', null, other));
  }
  return rows;
}

// SPEC R5: mailbox simulator recipients count in the lane ratio and the tag rows, and in no provider
// row, since the simulator is no mailbox provider an operator sends to.
export const SIMULATOR_DOMAIN = 'simulator.amazonses.com';
export const OTHER_PROVIDER = 'other';

export type DnsMxOutcome = { kind: 'records'; exchanges: string[] } | { kind: 'missing' } | { kind: 'unknown' };

export interface ProviderMappingEntry {
  name: string;
  mxSuffixes: readonly string[];
  receivingDomains: readonly string[];
}

// D-57: a receiving domain listed here needs no MX lookup; every other one is placed by its MX hosts.
// Names hold to the SES tag alphabet so a row value can never be a hostname (AC-P3).
export const PROVIDER_MAPPING: readonly ProviderMappingEntry[] = [
  // MX: https://knowledge.workspace.google.com/admin/domains/set-up-mx-records-for-google-workspace (read
  // 2026-10-11): the Workspace MX "is smtp.google.com", values set before 2023 start with aspmx.
  // gmail.com: https://support.google.com/mail/answer/7436150 (read 2026-10-11). googlemail.com is
  // ASSUMED, to confirm.
  { name: 'Google', mxSuffixes: ['google.com'], receivingDomains: ['gmail.com', 'googlemail.com'] },
  // MX: https://learn.microsoft.com/en-us/microsoft-365/enterprise/external-domain-name-system-records
  // (page dated 2026-06-26, read 2026-10-11): "<MX token>.mail.protection.outlook.com". Consumer domains:
  // https://techcommunity.microsoft.com/blog/outlook/strengthening-email-ecosystem-outlook's-new-requirements-for-high-volume-senders/4399730
  // (read 2026-10-11 through a search snippet). That consumer mail uses this MX is ASSUMED, to confirm.
  { name: 'Microsoft', mxSuffixes: ['protection.outlook.com'], receivingDomains: ['outlook.com', 'hotmail.com', 'live.com'] },
  // MX: https://support.apple.com/en-us/102374 (read 2026-10-11): mx01.mail.icloud.com and
  // mx02.mail.icloud.com. icloud.com, me.com and mac.com as Apple's receiving domains are ASSUMED, to confirm.
  { name: 'Apple', mxSuffixes: ['mail.icloud.com'], receivingDomains: ['icloud.com', 'me.com', 'mac.com'] },
  // MX: no Yahoo page publishes it. Published capture, undated, in a thread on https://lists.nanog.org (read
  // 2026-10-11): mta5.am0.yahoodns.net and mta7.am0.yahoodns.net as the yahoo.com MX. aol.com is ASSUMED,
  // to confirm.
  { name: 'Yahoo', mxSuffixes: ['yahoodns.net'], receivingDomains: ['yahoo.com', 'aol.com'] },
];

const PROVIDER_BY_DOMAIN: ReadonlyMap<string, string> = new Map(
  PROVIDER_MAPPING.flatMap((entry) => entry.receivingDomains.map((domain): [string, string] => [domain, entry.name])),
);

function suffixMatches(host: string, suffix: string): boolean {
  return host === suffix || host.endsWith(`.${suffix}`);
}

// MX hosts of two providers name neither: the domain counts in other rather than under a guess.
function providerOfExchanges(exchanges: readonly string[]): string {
  const names = new Set<string>();
  for (const exchange of exchanges) {
    const lower = exchange.toLowerCase();
    const host = lower.endsWith('.') ? lower.slice(0, -1) : lower;
    const entry = PROVIDER_MAPPING.find((candidate) => candidate.mxSuffixes.some((suffix) => suffixMatches(host, suffix)));
    if (entry !== undefined) names.add(entry.name);
  }
  const [only] = names;
  return names.size === 1 && only !== undefined ? only : OTHER_PROVIDER;
}

/** A mapping name, OTHER_PROVIDER, or null for the mailbox simulator, which no provider row holds. */
export function providerOf(receivingDomain: string, mx?: DnsMxOutcome): string | null {
  const domain = receivingDomain.toLowerCase();
  if (domain === SIMULATOR_DOMAIN) return null;
  const listed = PROVIDER_BY_DOMAIN.get(domain);
  if (listed !== undefined) return listed;
  return mx?.kind === 'records' ? providerOfExchanges(mx.exchanges) : OTHER_PROVIDER;
}

export function receivingDomainsNeedingMx(summary: WindowSummary): string[] {
  return [...summary.dimensions.receivingDomain.keys()]
    .filter((domain) => {
      const lower = domain.toLowerCase();
      return lower !== SIMULATOR_DOMAIN && !PROVIDER_BY_DOMAIN.has(lower) && validHostname(domain) !== UNCLASSIFIED;
    })
    .sort(compareValueBytes);
}

/** Receiving-domain tallies by mapping name. Unmapped domains, a missing or unknown MX answer and the
 * receiving-domain no-value tally share one other row, so the rows sum to the lane totals minus the
 * simulator recipients and no receiving domain reaches a row. */
export function buildProviderRows(
  summary: WindowSummary,
  spike: LaneSpikeVerdict,
  mxAnswers: ReadonlyMap<string, DnsMxOutcome>,
): EvidenceRow[] {
  const byProvider = new Map<string, DimensionTally>();
  const other = { ...summary.noValue.receivingDomain };
  for (const [domain, tally] of summary.dimensions.receivingDomain) {
    const provider = providerOf(domain, mxAnswers.get(domain));
    if (provider === null) continue;
    if (provider === OTHER_PROVIDER) {
      addInto(other, tally);
      continue;
    }
    let aggregate = byProvider.get(provider);
    if (aggregate === undefined) {
      aggregate = { sends: 0, permanentBounces: 0, complaints: 0 };
      byProvider.set(provider, aggregate);
    }
    addInto(aggregate, tally);
  }
  const context = rowContext('provider', summary, spike);
  const rows = [...byProvider].sort(largestFirst).map(([name, tally]) => rowOf(context, 'value', name, tally));
  if (hasCounts(other)) rows.push(rowOf(context, 'other', null, other));
  return rows;
}

export interface ShareRow {
  laneCountableEvents: number;
  storedCountableEvents: number;
  percent: string | null;
  label: typeof LANE_SHARE_LABEL;
}

type CountField = Exclude<keyof BucketCount, 'bucketStartMs' | 'complete'>;

// Every counted record lands in exactly one of these, so their sum is the bucket's countable events;
// `satisfies` fails the type gate when BucketCount gains a count this list does not name.
const COUNT_FIELDS = Object.keys({
  send: true,
  delivery: true,
  permanentBounce: true,
  transientBounce: true,
  undeterminedBounce: true,
  complaint: true,
  reject: true,
  deliveryDelay: true,
  suppressedBounce: true,
  suppressedComplaint: true,
  notSpamComplaint: true,
} satisfies Record<CountField, true>) as CountField[];

export function countableEventsOf(summary: WindowSummary): number {
  let total = 0;
  for (const bucket of summary.buckets) for (const field of COUNT_FIELDS) total += bucket[field];
  return total;
}

/** AC-8: a share of what Fothering stores for its lane-map sets, never of the SES account. */
export function buildShareRow(laneSummary: WindowSummary, allLaneSummaries: readonly WindowSummary[]): ShareRow {
  if (!allLaneSummaries.includes(laneSummary)) {
    throw new RangeError('the lane share is taken over every lane-map lane, so the lane summary must be one of the summaries given');
  }
  const laneCountableEvents = countableEventsOf(laneSummary);
  const storedCountableEvents = allLaneSummaries.reduce((sum, summary) => sum + countableEventsOf(summary), 0);
  return {
    laneCountableEvents,
    storedCountableEvents,
    percent: renderPercent(laneCountableEvents, storedCountableEvents),
    label: LANE_SHARE_LABEL,
  };
}
