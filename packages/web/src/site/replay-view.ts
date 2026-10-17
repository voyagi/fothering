import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  assertPublishable,
  replayArtifactSchema,
  reportIssue,
  type EvidenceRow,
  type ReplayArtifact,
  type ReplayEvent,
} from '@fothering/core/replay-artifact';
import { PROVENANCE_LABELS, type ProvenanceLabel } from './labels.js';
import { readRepoText } from './repo-facts.js';

const REPLAY_ARTIFACT_PATH ='packages/web/src/fixtures/replay-incident.json';
const CAPTURE_MANIFEST_PATH = 'packages/web/src/fixtures/capture-manifest.json';
const ARTIFACT_IN_PROJECT = 'src/fixtures/replay-incident.json';
const MANIFEST_IN_PROJECT = 'src/fixtures/capture-manifest.json';

// Prose strings mark code spans with backticks, the way UI-SPEC section 11.5 writes them; the pages
// render each span as code. Tag fields are whole values and carry no backticks.

interface ReplayTag {
  legend: string;
  lane: string;
  stamp: string;
  cause: string;
  evidence: string;
  readBack: string;
  replayReadBack: string;
  reopens: string;
  number: string;
}

interface SummaryItem {
  time: string;
  text: string;
}

interface ReplayStep {
  number: 1 | 2 | 3 | 4;
  label: string;
  time: string;
  heading: string;
  paragraphs: string[];
}

interface ScheduleRow {
  dimension: string;
  label: string;
  count: number;
  denominator: number;
  countText: string;
  verdict: string;
  threshold: string;
  unconfirmed: boolean;
  sourceUrl?: string;
}

interface OperatorEmail {
  subject: string;
  disclosure: string;
  why: string;
  reopen: string;
}

interface EventLogRow {
  step: number;
  time: string;
  kind: string;
  lane: string;
  detail: string;
  smtpCode: string;
  receivingDomain: string;
}

export interface ReplayView {
  h1: string;
  intro: string;
  caption: string;
  captionLinkHref?: string;
  summary: SummaryItem[];
  steps: ReplayStep[];
  schedule: { caption: string; rows: ScheduleRow[]; modelRole: string };
  email: OperatorEmail;
  reopenCommand: string;
  lanesLines: { paused: string; reopened: string };
  boardDescriptions: string[];
  tag: ReplayTag;
  landing: { drawingTitle: string; drawingDescription: string };
  eventLog: { caption: string; note: string; rows: EventLogRow[] };
}

// Messages name the file by its repository path whatever root was read, so a build log points at
// the committed file to fix.
function readFixture(projectRoot: string, inProject: string, shownAs: string): unknown {
  let text: string;
  try {
    text = readRepoText(inProject, projectRoot);
  } catch (error) {
    const message = (error as Error).message;
    if (!message.startsWith(`${inProject}: `)) throw error;
    throw new Error(`${shownAs}${message.slice(inProject.length)}. Commit the file at that path.`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${shownAs}: not valid JSON (${(error as Error).message}). Fix the syntax.`);
  }
}

// Pages pass process.cwd(), which scripts/astro.mjs keeps at the Astro project root, so a copy of
// the project built elsewhere reads its own fixture rather than this checkout's.
export function loadReplayArtifact(projectRoot: string): ReplayArtifact {
  const parsed = replayArtifactSchema.safeParse(readFixture(projectRoot, ARTIFACT_IN_PROJECT, REPLAY_ARTIFACT_PATH), { reportInput: true });
  if (!parsed.success) {
    const lines = parsed.error.issues.map((issue) => {
      const report = reportIssue(issue);
      const where = report.path === '' ? '' : ` ${report.path}:`;
      return `${REPLAY_ARTIFACT_PATH}:${where} ${report.problem}. ${report.fix}.`;
    });
    throw new Error(lines.join('\n'));
  }
  const manifest = existsSync(join(projectRoot, MANIFEST_IN_PROJECT))
    ? readFixture(projectRoot, MANIFEST_IN_PROJECT, CAPTURE_MANIFEST_PATH)
    : undefined;
  const verdict = assertPublishable(parsed.data, manifest);
  if (!verdict.ok) throw new Error(verdict.errors.map((error) => `${REPLAY_ARTIFACT_PATH}: ${error}`).join('\n'));
  return parsed.data;
}

function clockTime(utc: string): string {
  return utc.slice(11, 16);
}

function secondsTime(utc: string): string {
  return utc.slice(11, 19);
}

function refuse(path: string, problem: string, fix: string): never {
  throw new Error(`${REPLAY_ARTIFACT_PATH}: ${path}: ${problem}. ${fix}.`);
}

const STEP_NUMBERS = [1, 2, 3, 4] as const;
const STEP_LABELS = ['Bounces arrive', 'Cause named', 'Paused, read back', 'Reopened by command'] as const;
const DIMENSION_LABELS: Record<EvidenceRow['dimension'], string> = { tag: 'Tag', provider: 'Provider', configuration: 'Configuration' };
const VERDICT_LABELS: Record<EvidenceRow['verdict'], string> = { cause: 'Cause', clean: 'Clean', 'ruled-out': 'Ruled out' };
const KIND_LABELS: Record<ReplayEvent['kind'], string> = {
  bounce: 'Bounce',
  delivery: 'Delivery',
  'evidence-record': 'Evidence record',
  agent: 'Agent',
  'ses-call': 'SES call',
  'read-back': 'Read-back',
  'hold-check': 'Hold check',
  'email-sent': 'Email sent',
  'reopen-command': 'Reopen command',
};
const COUNT_WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];

// The only replay is a confirmed closure: an artifact that cannot show one is refused at build time
// rather than played back as something it is not (UI-SPEC section 8.2).
function assertReplayable(artifact: ReplayArtifact): void {
  if (artifact.pause.readBack.value !== 'false') {
    refuse('pause.readBack.value', `is ${artifact.pause.readBack.value}, and the replay shows only a pause the read-back confirmed`, 'Replay an incident whose read-back reads false');
  }
  if (artifact.holdCheck?.result === 'failed') {
    refuse('holdCheck.result', 'is failed, so the pause did not hold', 'Replay an incident whose hold check passed, or leave the hold check out');
  }
  if (artifact.agent.outcome !== 'close') {
    refuse('agent.outcome', `is ${artifact.agent.outcome}, and nothing pauses without the agent's close`, 'Replay an incident the agent confirmed');
  }
  if (artifact.reopen.readBack.value !== 'true') {
    refuse('reopen.readBack.value', `is ${artifact.reopen.readBack.value}, so the reopen was not confirmed`, 'Replay an incident whose reopen read back true');
  }
  for (const step of STEP_NUMBERS) {
    if (!artifact.events.some((event) => event.step === step)) refuse('events', `step ${String(step)} has no event`, 'Add the events of every step');
  }
}

// Step first, then time; the index breaks ties so equal times keep the artifact's order.
function orderedEvents(events: readonly ReplayEvent[]): ReplayEvent[] {
  return events
    .map((event, index) => ({ event, index, at: Date.parse(event.atUtc) }))
    .sort((a, b) => a.event.step - b.event.step || a.at - b.at || a.index - b.index)
    .map(({ event }) => event);
}

function causeRow(artifact: ReplayArtifact): EvidenceRow {
  return artifact.evidence.find((row) => row.verdict === 'cause') ?? refuse('evidence', 'no row has the verdict cause', 'Add the row that names the cause');
}

function closedLaneBounce(artifact: ReplayArtifact, events: readonly ReplayEvent[]): ReplayEvent & { smtpCode: string } {
  const bounce = events.find((event) => event.kind === 'bounce' && event.lane === artifact.closedLane && event.smtpCode !== undefined);
  if (bounce?.smtpCode === undefined) {
    return refuse('events', `no bounce on ${artifact.closedLane} carries an SMTP code`, 'Add the SMTP code to the bounces on the paused lane');
  }
  return { ...bounce, smtpCode: bounce.smtpCode };
}

function scheduleRow(row: EvidenceRow): ScheduleRow {
  const dimension = DIMENSION_LABELS[row.dimension];
  return {
    dimension,
    label: row.dimension === 'configuration' ? row.subject : `${dimension} \`${row.subject}\``,
    count: row.count,
    denominator: row.denominator,
    countText: `${String(row.count)} of ${String(row.denominator)} ${row.unit}`,
    verdict: VERDICT_LABELS[row.verdict],
    threshold: row.threshold,
    unconfirmed: row.dimension === 'provider' && row.confirmingSourceUrl === undefined,
    ...(row.confirmingSourceUrl === undefined ? {} : { sourceUrl: row.confirmingSourceUrl }),
  };
}

function logRow(event: ReplayEvent): EventLogRow {
  return {
    step: event.step,
    time: secondsTime(event.atUtc),
    kind: event.kind === 'bounce' ? `${KIND_LABELS.bounce}, ${String(event.bounceType)}` : KIND_LABELS[event.kind],
    lane: event.lane,
    detail: event.detail,
    smtpCode: event.smtpCode ?? '',
    receivingDomain: event.receivingDomain ?? '',
  };
}

function lanesLines(closedLane: string, openLanes: readonly string[], held: boolean): ReplayView['lanesLines'] {
  const others = openLanes.join(', ');
  return {
    paused: `${held ? 'Closed' : 'Paused'}: ${closedLane}. ${openLanes.length === 0 ? 'No other lane.' : `Open: ${others}.`}`,
    reopened: `Reopened: ${closedLane}. ${openLanes.length === 0 ? 'No other lane.' : `Open throughout: ${others}.`}`,
  };
}

function boardDescriptions(closedLane: string, lanes: readonly string[], openLanes: readonly string[]): string[] {
  const all = String(lanes.length);
  const keepFlowing = openLanes.length === 0 ? '' : ` ${openLanes.join(', ')} ${openLanes.length === 1 ? 'keeps' : 'keep'} flowing.`;
  return [
    `Mail flows on all ${all} lanes. Bounce marks appear on ${closedLane}.`,
    `Mail still flows on all ${all} lanes, with bounce marks on ${closedLane}. Detection code has approved one lane.`,
    `${closedLane} is stopped at a filled valve with a lockout tag, and its outlet is dotted.${keepFlowing}`,
    `${closedLane} flows again and the tag is off the valve. All ${all} lanes flow.`,
  ];
}

function firstEventTime(events: readonly ReplayEvent[], step: number): string {
  const event = events.find((candidate) => candidate.step === step);
  return event === undefined ? '' : clockTime(event.atUtc);
}

function stepOneText(artifact: ReplayArtifact, bounce: ReplayEvent & { smtpCode: string }, openLanes: readonly string[]): string {
  const others = openLanes.length === 0 ? '' : openLanes.length === 1 ? ' The other lane keeps delivering.' : ' The other lanes keep delivering.';
  return `${String(bounce.bounceType)} bounces arrive on ${artifact.closedLane} only, each \`${bounce.smtpCode}\`, from ${String(artifact.window.receivingProviders)} providers.${others}`;
}

function stepThreeText(artifact: ReplayArtifact, held: boolean): string {
  const { pause } = artifact;
  const hold = held && artifact.holdCheck !== undefined ? ` A hold check finds no send accepted after ${clockTime(artifact.holdCheck.holdFromUtc)} UTC.` : '';
  return `\`${pause.operation}\` turns sending off for ${artifact.closedLane} only. \`${pause.readBack.operation}\` reads \`${pause.readBack.field}\` as ${pause.readBack.value}.${hold}`;
}

function fieldName(path: string): string {
  return path.slice(path.lastIndexOf('.') + 1);
}

function logNote(hardBounces: number): string {
  if (hardBounces === 0) return 'Showing every decision, call and email.';
  if (hardBounces === 1) return 'Showing the first hard bounce and every decision, call and email.';
  return `Showing the first ${COUNT_WORDS[hardBounces] ?? String(hardBounces)} hard bounces and every decision, call and email.`;
}

function tagEvidence(row: EvidenceRow, smtpCode: string, providers: number): string {
  const share = row.count === row.denominator ? `All ${String(row.count)}` : `${String(row.count)} of ${String(row.denominator)}`;
  return `${share} ${row.unit} in the window carry that tag: \`${smtpCode}\`, ${String(providers)} providers.`;
}

export function buildReplayView(artifact: ReplayArtifact): ReplayView {
  assertReplayable(artifact);
  const label: ProvenanceLabel = PROVENANCE_LABELS[artifact.provenance];
  const held = artifact.holdCheck?.result === 'passed';
  const events = orderedEvents(artifact.events);
  const bounce = closedLaneBounce(artifact, events);
  const cause = `${artifact.cause.key}=${artifact.cause.value}`;
  const openLanes = artifact.lanes.filter((lane) => lane !== artifact.closedLane);
  const pausedAt = clockTime(artifact.pause.readBack.atUtc);
  const times = [firstEventTime(events, 1), firstEventTime(events, 2), pausedAt, clockTime(artifact.reopen.readBack.atUtc)];
  const paragraphs = [
    [stepOneText(artifact, bounce, openLanes)],
    [],
    [stepThreeText(artifact, held)],
    [`\`${artifact.pause.readBack.operation}\` then read \`${fieldName(artifact.pause.readBack.field)}\` as ${artifact.reopen.readBack.value}.`],
  ];
  const headings = ['Hard bounces on one lane', 'The cause, and the counts', held ? 'Paused, read back, then held' : 'Paused, then read back', 'The email, then the reopen'];
  const permanentBounces = events.filter((event) => event.kind === 'bounce' && event.bounceType === 'Permanent').length;
  return {
    h1: `Replay: the ${artifact.closedLane} incident`,
    intro: `One incident, four steps. ${label.timeWording}`,
    caption: label.caption,
    ...(label.captionLinkHref === undefined ? {} : { captionLinkHref: label.captionLinkHref }),
    summary: [
      { time: times[0] ?? '', text: `Hard bounces on ${artifact.closedLane}` },
      { time: times[1] ?? '', text: `Cause: ${cause}` },
      { time: pausedAt, text: `Paused, read back ${artifact.pause.readBack.value}` },
      { time: times[3] ?? '', text: `Reopened by command, read back ${artifact.reopen.readBack.value}` },
    ],
    steps: STEP_NUMBERS.map((number, index) => ({
      number,
      label: STEP_LABELS[index] ?? '',
      time: times[index] ?? '',
      heading: headings[index] ?? '',
      paragraphs: paragraphs[index] ?? [],
    })),
    schedule: {
      caption: `${artifact.closedLane}, ${clockTime(artifact.window.startUtc)} to ${clockTime(artifact.window.endUtc)} UTC, ${String(artifact.window.sends)} sends.`,
      rows: artifact.evidence.map(scheduleRow),
      modelRole: 'Code approved one lane. The agent confirmed that option.',
    },
    email: {
      subject: `${held ? 'Closed' : 'Paused'}: ${artifact.closedLane}, one lane in ${artifact.region}`,
      disclosure: "Fothering's AI agent wrote the Why paragraph. Code wrote the rest.",
      why: artifact.agent.paragraph,
      reopen: `Run the reopen command for ${artifact.closedLane}.`,
    },
    reopenCommand: artifact.reopen.command,
    lanesLines: lanesLines(artifact.closedLane, openLanes, held),
    boardDescriptions: boardDescriptions(artifact.closedLane, artifact.lanes, openLanes),
    tag: {
      legend: held ? 'LANE CLOSED' : 'LANE PAUSED',
      lane: artifact.closedLane,
      stamp: label.stamp,
      cause,
      evidence: tagEvidence(causeRow(artifact), bounce.smtpCode, artifact.window.receivingProviders),
      readBack: `${artifact.pause.readBack.field}: ${artifact.pause.readBack.value}, ${pausedAt} UTC`,
      replayReadBack: `${fieldName(artifact.pause.readBack.field)}: ${artifact.pause.readBack.value}, ${pausedAt} UTC`,
      reopens: 'Run the reopen command',
      number: 'TAG 001',
    },
    landing: {
      drawingTitle: `Flow drawing of one SES account with ${String(artifact.lanes.length)} sending lanes`,
      drawingDescription: `Mail flows from the SES account through ${openLanes.join(', ')}. ${artifact.closedLane} is stopped at a ${held ? 'closed' : 'filled'} valve that carries a lockout tag, with a read-back instrument at ${pausedAt} UTC.`,
    },
    eventLog: {
      caption: label.caption,
      note: logNote(permanentBounces),
      rows: events.map(logRow),
    },
  };
}

// The scrub reads fixture text, not parsed JSON, so a value hidden in any field or a stray key is
// still seen. Findings name the file, line and kind (an address only by its domain), never the
// address, IP or number itself.
const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)/g;
const IPV4_PATTERN = /(?<![\d.])(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?![\d.])/g;
// Letters and digits on either side mean the run is part of a longer token, such as a hash.
const TWELVE_DIGITS_PATTERN = /(?<![0-9A-Za-z])\d{12}(?![0-9A-Za-z])/g;
const RESERVED_TOP_LEVEL = new Set(['test', 'example', 'invalid', 'localhost']);
// RFC 2606 section 3's second-level names, built from parts so the repo's placeholder-address
// check does not read the list itself as a stray placeholder.
const RESERVED_DOMAINS = ['com', 'net', 'org'].map((topLevel) => `example.${topLevel}`);
const DOCUMENTATION_NETWORKS = new Set(['192.0.2', '198.51.100', '203.0.113']);

function allowedMailDomain(domain: string): boolean {
  const lower = domain.toLowerCase();
  if (lower === 'simulator.amazonses.com') return true;
  if (RESERVED_TOP_LEVEL.has(lower.slice(lower.lastIndexOf('.') + 1))) return true;
  return RESERVED_DOMAINS.some((reserved) => lower === reserved || lower.endsWith(`.${reserved}`));
}

function manifestAccountId(fileName: string, text: string): string | undefined {
  if (fileName !== 'capture-manifest.json') return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === 'object' && parsed !== null && 'accountId' in parsed && typeof parsed.accountId === 'string') return parsed.accountId;
  } catch {
    return undefined;
  }
  return undefined;
}

function lineAt(text: string, index: number): number {
  return text.slice(0, index).split('\n').length;
}

export function fixtureFindings(fileName: string, text: string): string[] {
  const findings: { index: number; message: string }[] = [];
  for (const match of text.matchAll(EMAIL_PATTERN)) {
    const domain = match[1] ?? '';
    if (!allowedMailDomain(domain)) findings.push({ index: match.index, message: `an email address at ${domain}, outside simulator.amazonses.com and the RFC 2606 names` });
  }
  for (const match of text.matchAll(IPV4_PATTERN)) {
    const octets = match.slice(1, 5).map(Number);
    if (octets.some((octet) => octet > 255)) continue;
    if (!DOCUMENTATION_NETWORKS.has(octets.slice(0, 3).join('.'))) {
      findings.push({ index: match.index, message: 'an IP address outside 192.0.2.0/24, 198.51.100.0/24 and 203.0.113.0/24' });
    }
  }
  const accountId = manifestAccountId(fileName, text);
  for (const match of text.matchAll(TWELVE_DIGITS_PATTERN)) {
    if (match[0] !== accountId) findings.push({ index: match.index, message: "a 12-digit number outside the capture manifest's accountId" });
  }
  return findings.sort((a, b) => a.index - b.index).map(({ index, message }) => `${fileName}:${String(lineAt(text, index))}: ${message}`);
}
