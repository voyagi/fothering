import { parse } from 'tldts';
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
  type Rational,
} from './verdicts.js';
import type { BucketCount } from './buckets.js';
import { validHostname } from './extract.js';
import { UNCLASSIFIED } from './records.js';
import { AUTH_CORROBORATION_CODES, type ConfigurationRecord, type DimensionTally, type WindowSummary } from './window-fold.js';

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

export type DnsTxtOutcome = { kind: 'records'; records: string[] } | { kind: 'missing' } | { kind: 'unknown' };

export interface IdentityAuthFacts {
  identity: string;
  defaultConfigurationSet?: string;
  dkimStatus?: string;
  dkimSigningEnabled?: boolean;
  mailFromDomain?: string;
  mailFromStatus?: string;
  identityType?: string;
}

// D-58: one MX lookup per unlisted receiving domain plus up to three TXT lookups per from-domain;
// at DNS_LOOKUP_CONCURRENCY in flight and 2 s each the worst case is about 40 s of the detection
// function's 300 s. Past the bound the lane decides unknown (dns-bound) before any lookup runs.
export const MAX_DNS_LOOKUPS_PER_CYCLE = 200;
// D-58: ten in flight keep a cycle's resolver load small while 200 lookups still finish in about 40 s.
export const DNS_LOOKUP_CONCURRENCY = 10;

/**
 * The RFC 7489 organizational domain, from tldts 7.4.18 with the public suffix list as bundled
 * 2026-10-07. tldts answers an unknown TLD with its right-most label and isIcann false, and a host
 * under a private suffix with isIcann false too, so requiring isIcann keeps either from borrowing
 * another party's DMARC record (research Pitfall 14): both read undefined, and the row unknown.
 */
export function organizationalDomain(fromDomain: string): string | undefined {
  const result = parse(fromDomain, { allowPrivateDomains: true });
  if (result.isIp === true || result.isIcann !== true || result.domain === null) return undefined;
  return result.domain;
}

/** D-60: the exact domain identity, else the longest listed parent, as SES inherits DKIM from the
 * parent domain; an email address identity never covers a from-domain. */
export function identityFor(fromDomain: string, identities: readonly IdentityAuthFacts[]): IdentityAuthFacts | undefined {
  const domain = fromDomain.toLowerCase();
  let best: IdentityAuthFacts | undefined;
  for (const facts of identities) {
    const name = facts.identity.toLowerCase();
    if (name.includes('@') || (name !== domain && !domain.endsWith(`.${name}`))) continue;
    if (best === undefined || name.length > best.identity.length) best = facts;
  }
  return best;
}

type ConfigurationState = ConfigurationRow['state'];
type ConfigurationVerdict = ConfigurationRow['verdict'];

interface RowReading {
  state: ConfigurationState;
  lookups: ConfigurationLookup[];
}

const CONFIGURATION_RECORD_ORDER: readonly ConfigurationRecord[] = ['dkim', 'mail-from', 'dmarc', 'spf'];

// D-61 as amended 2026-10-12: a missing record is a cause only when at least half of the window's
// counted permanent bounces, and at least MIN_RATIO_EVENTS of them, carry one of that row's RFC 7372
// codes. Complaints carry no status code, so they never corroborate.
const CORROBORATION_SHARE: Rational = { numerator: 1, denominator: 2 };

const DMARC_RECORD = /^v=DMARC1(?:;|\s|$)/;
const SPF_RECORD = /^v=spf1(?: |$)/;

type TxtReading = 'one' | 'none' | 'many' | 'unknown';

function readTxt(outcome: DnsTxtOutcome | undefined, pattern: RegExp): TxtReading {
  if (outcome === undefined || outcome.kind === 'unknown') return 'unknown';
  if (outcome.kind === 'missing') return 'none';
  const matching = outcome.records.filter((record) => pattern.test(record)).length;
  if (matching === 0) return 'none';
  return matching === 1 ? 'one' : 'many';
}

// Two records at one name are discarded by receivers (RFC 9989 for DMARC, RFC 7208's single record
// for SPF), so they read unknown, and so does a lookup that failed or never ran.
function definiteState(reading: TxtReading): ConfigurationState {
  if (reading === 'one') return 'present';
  return reading === 'none' ? 'missing' : 'unknown';
}

function sesLookup(facts: IdentityAuthFacts | undefined): ConfigurationLookup {
  return { kind: 'ses', operation: 'GetEmailIdentity', identity: facts === undefined ? null : facts.identity.toLowerCase() };
}

function txtLookup(name: string, outcome: DnsTxtOutcome | undefined): ConfigurationLookup {
  return { kind: 'dns', name, recordType: 'TXT', outcome: outcome?.kind ?? 'unknown' };
}

function customMailFromOf(facts: IdentityAuthFacts): string | undefined {
  return facts.mailFromDomain === undefined || facts.mailFromDomain === '' ? undefined : facts.mailFromDomain.toLowerCase();
}

function dkimState(facts: IdentityAuthFacts): ConfigurationState {
  if (facts.dkimStatus === 'FAILED' || facts.dkimSigningEnabled === false) return 'missing';
  return facts.dkimStatus === 'SUCCESS' && facts.dkimSigningEnabled === true ? 'present' : 'unknown';
}

// SES's default MAIL FROM domain is AWS's own, so without a custom one there is nothing of the
// sender's to be missing, and the row can never be a cause.
function mailFromState(facts: IdentityAuthFacts): ConfigurationState {
  if (customMailFromOf(facts) === undefined) return 'not-applicable';
  if (facts.mailFromStatus === 'SUCCESS') return 'present';
  return facts.mailFromStatus === 'FAILED' ? 'missing' : 'unknown';
}

interface DmarcNames {
  fromName: string;
  organizational: string | undefined;
  organizationalName: string | undefined;
}

function dmarcNamesFor(fromDomain: string): DmarcNames {
  const organizational = organizationalDomain(fromDomain);
  return {
    fromName: `_dmarc.${fromDomain}`,
    organizational,
    organizationalName: organizational === undefined || organizational === fromDomain ? undefined : `_dmarc.${organizational}`,
  };
}

function labelCount(name: string): number {
  return name.split('.').length;
}

// RFC 7489 section 6.6.3: the from-domain's own record first, then the organizational domain's.
function dmarcReading(fromDomain: string, answers: ReadonlyMap<string, DnsTxtOutcome>): RowReading {
  const names = dmarcNamesFor(fromDomain);
  const fromAnswer = answers.get(names.fromName);
  const lookups = [txtLookup(names.fromName, fromAnswer)];
  const atFrom = readTxt(fromAnswer, DMARC_RECORD);
  if (atFrom !== 'none') return { state: definiteState(atFrom), lookups };
  if (names.organizational === undefined) return { state: 'unknown', lookups };
  if (names.organizationalName === undefined) return { state: 'missing', lookups };
  const organizationalAnswer = answers.get(names.organizationalName);
  lookups.push(txtLookup(names.organizationalName, organizationalAnswer));
  const atOrganizational = readTxt(organizationalAnswer, DMARC_RECORD);
  if (atOrganizational !== 'none') return { state: definiteState(atOrganizational), lookups };
  // A current receiver (RFC 9989's tree walk) also queries every name between the two, which D-60
  // never reads, so a deeper from-domain could hold a record there: unknown, not a missing record
  // that would send the operator to fix the wrong name (AI-SPEC 1b-1).
  const directChild = labelCount(fromDomain) - labelCount(names.organizational) === 1;
  return { state: directChild ? 'missing' : 'unknown', lookups };
}

function spfReading(facts: IdentityAuthFacts, answers: ReadonlyMap<string, DnsTxtOutcome>): RowReading {
  const mailFrom = customMailFromOf(facts);
  if (mailFrom === undefined) return { state: 'not-applicable', lookups: [sesLookup(facts)] };
  const answer = answers.get(mailFrom);
  return { state: definiteState(readTxt(answer, SPF_RECORD)), lookups: [txtLookup(mailFrom, answer)] };
}

function corroborationOf(record: ConfigurationRecord, totals: WindowSummary['totals']): ConfigurationRow['corroboration'] {
  let corroboratingBounces = 0;
  for (const detail of AUTH_CORROBORATION_CODES[record]) corroboratingBounces += totals.permanentBouncesByAuthCode[detail];
  return { corroboratingBounces, permanentBounces: totals.permanentBounces };
}

function configurationVerdict(state: ConfigurationState, corroboration: ConfigurationRow['corroboration']): ConfigurationVerdict {
  switch (state) {
    case 'present':
      return 'ruled-out';
    case 'unknown':
      return 'unknown';
    case 'not-applicable':
      return 'not-applicable';
    case 'missing':
      return ratioAtOrAbove(corroboration.corroboratingBounces, corroboration.permanentBounces, CORROBORATION_SHARE) ? 'cause' : 'elevated';
  }
}

function readingsFor(fromDomain: string, facts: IdentityAuthFacts | undefined, answers: ReadonlyMap<string, DnsTxtOutcome>) {
  // D-60: with no identity nothing about the sender's records is known, and no DNS read is planned.
  if (facts === undefined) {
    const unknown = (): RowReading => ({ state: 'unknown', lookups: [sesLookup(undefined)] });
    return { dkim: unknown(), 'mail-from': unknown(), dmarc: unknown(), spf: unknown() } satisfies Record<ConfigurationRecord, RowReading>;
  }
  return {
    dkim: { state: dkimState(facts), lookups: [sesLookup(facts)] },
    'mail-from': { state: mailFromState(facts), lookups: [sesLookup(facts)] },
    dmarc: dmarcReading(fromDomain, answers),
    spf: spfReading(facts, answers),
  } satisfies Record<ConfigurationRecord, RowReading>;
}

export interface ConfigurationRowsInput {
  fromDomain: string;
  identities: readonly IdentityAuthFacts[];
  /** Answers by DNS name; a planned name with no answer reads unknown, as a lookup that never ran. */
  txtAnswers: ReadonlyMap<string, DnsTxtOutcome>;
  totals: WindowSummary['totals'];
}

/** The DKIM, MAIL FROM, DMARC and SPF rows of one from-domain, each naming its lookups (AC-9). */
export function buildConfigurationRows(input: ConfigurationRowsInput): ConfigurationRow[] {
  const fromDomain = input.fromDomain.toLowerCase();
  const readings = readingsFor(fromDomain, identityFor(fromDomain, input.identities), input.txtAnswers);
  return CONFIGURATION_RECORD_ORDER.map((record) => {
    const corroboration = corroborationOf(record, input.totals);
    const { state, lookups } = readings[record];
    return { fromDomain, record, state, verdict: configurationVerdict(state, corroboration), lookups, corroboration };
  });
}

/** AC-E24: a lane whose records carry no usable from-domain gets no configuration row. */
export function configurationFromDomains(summary: WindowSummary): string[] {
  return [...summary.dimensions.fromDomain.keys()].filter((domain) => validHostname(domain) !== UNCLASSIFIED).sort(compareValueBytes);
}

export interface LaneConfigurationInput {
  summary: WindowSummary;
  identities: readonly IdentityAuthFacts[];
  txtAnswers: ReadonlyMap<string, DnsTxtOutcome>;
}

export function buildLaneConfigurationRows(input: LaneConfigurationInput): ConfigurationRow[] {
  return configurationFromDomains(input.summary).flatMap((fromDomain) =>
    buildConfigurationRows({ fromDomain, identities: input.identities, txtAnswers: input.txtAnswers, totals: input.summary.totals }),
  );
}

export interface PlannedLookup {
  name: string;
  recordType: 'TXT' | 'MX';
}

export interface DnsLookupPlan {
  lookups: PlannedLookup[];
  bound: 'dns-bound' | null;
}

/** The worst-case lookup list, built before any lookup runs, so the bound is decided on it (D-58). */
export function planDnsLookups(
  fromDomains: readonly string[],
  identities: readonly IdentityAuthFacts[],
  receivingDomainsNeedingMx: readonly string[],
): DnsLookupPlan {
  const lookups: PlannedLookup[] = [];
  const planned = new Set<string>();
  const plan = (name: string, recordType: PlannedLookup['recordType']): void => {
    const key = `${recordType} ${name}`;
    if (planned.has(key)) return;
    planned.add(key);
    lookups.push({ name, recordType });
  };
  for (const raw of fromDomains) {
    const fromDomain = raw.toLowerCase();
    const facts = identityFor(fromDomain, identities);
    if (facts === undefined) continue;
    const names = dmarcNamesFor(fromDomain);
    plan(names.fromName, 'TXT');
    if (names.organizationalName !== undefined) plan(names.organizationalName, 'TXT');
    const mailFrom = customMailFromOf(facts);
    if (mailFrom !== undefined) plan(mailFrom, 'TXT');
  }
  for (const domain of receivingDomainsNeedingMx) plan(domain, 'MX');
  return { lookups, bound: lookups.length > MAX_DNS_LOOKUPS_PER_CYCLE ? 'dns-bound' : null };
}
