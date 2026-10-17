import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { assertPublishable, replayArtifactSchema, reportIssue, type ReplayArtifact } from '@fothering/core/replay-artifact';
import { PROVENANCE_LABELS, type ProvenanceLabel } from './labels.js';
import { readRepoText } from './repo-facts.js';

export const REPLAY_ARTIFACT_PATH = 'packages/web/src/fixtures/replay-incident.json';
const CAPTURE_MANIFEST_PATH = 'packages/web/src/fixtures/capture-manifest.json';
const ARTIFACT_IN_PROJECT = 'src/fixtures/replay-incident.json';
const MANIFEST_IN_PROJECT = 'src/fixtures/capture-manifest.json';

// Prose strings mark code spans with backticks, the way UI-SPEC section 11.5 writes them; the pages
// render each span as code. Tag fields are whole values and carry no backticks.

export interface ReplayTag {
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

export interface SummaryItem {
  time: string;
  text: string;
}

export interface ReplayStep {
  number: 1 | 2 | 3 | 4;
  label: string;
  time: string;
  heading: string;
  paragraphs: string[];
}

export interface ScheduleRow {
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

export interface OperatorEmail {
  subject: string;
  disclosure: string;
  why: string;
  reopen: string;
}

export interface EventLogRow {
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

export function buildReplayView(artifact: ReplayArtifact): ReplayView {
  const label: ProvenanceLabel = PROVENANCE_LABELS[artifact.provenance];
  const held = artifact.holdCheck?.result === 'passed';
  return {
    h1: '',
    intro: '',
    caption: label.caption,
    summary: [],
    steps: [],
    schedule: { caption: '', rows: [], modelRole: '' },
    email: { subject: '', disclosure: '', why: '', reopen: '' },
    reopenCommand: '',
    lanesLines: { paused: '', reopened: '' },
    boardDescriptions: [],
    tag: {
      legend: held ? 'LANE CLOSED' : 'LANE PAUSED',
      lane: artifact.closedLane,
      stamp: label.stamp,
      cause: `${artifact.cause.key}=${artifact.cause.value}`,
      evidence: '',
      readBack: `${artifact.pause.readBack.field}: ${artifact.pause.readBack.value}, ${clockTime(artifact.pause.readBack.atUtc)} UTC`,
      replayReadBack: '',
      reopens: 'Run the reopen command',
      number: '',
    },
    landing: { drawingTitle: '', drawingDescription: '' },
    eventLog: { caption: '', note: '', rows: [] },
  };
}

export function fixtureFindings(fileName: string, text: string): string[] {
  return [];
}
