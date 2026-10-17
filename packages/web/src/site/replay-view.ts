import { replayArtifactSchema, type ReplayArtifact } from '@fothering/core/replay-artifact';
import { PROVENANCE_LABELS, type ProvenanceLabel } from './labels.js';
import { readRepoText } from './repo-facts.js';

const ARTIFACT_IN_PROJECT = 'src/fixtures/replay-incident.json';

export interface ReplayTag {
  legend: string;
  lane: string;
  stamp: string;
  cause: string;
  readBack: string;
  reopens: string;
}

export interface ReplayView {
  caption: string;
  tag: ReplayTag;
}

// Pages pass process.cwd(), which scripts/astro.mjs keeps at the Astro project root, so a copy of
// the project built elsewhere reads its own fixture rather than this checkout's.
export function loadReplayArtifact(projectRoot: string): ReplayArtifact {
  return replayArtifactSchema.parse(JSON.parse(readRepoText(ARTIFACT_IN_PROJECT, projectRoot)));
}

function clockTime(utc: string): string {
  return utc.slice(11, 16);
}

export function buildReplayView(artifact: ReplayArtifact): ReplayView {
  const label: ProvenanceLabel = PROVENANCE_LABELS[artifact.provenance];
  const held = artifact.holdCheck?.result === 'passed';
  return {
    caption: label.caption,
    tag: {
      legend: held ? 'LANE CLOSED' : 'LANE PAUSED',
      lane: artifact.closedLane,
      stamp: label.stamp,
      cause: `${artifact.cause.key}=${artifact.cause.value}`,
      readBack: `${artifact.pause.readBack.field}: ${artifact.pause.readBack.value}, ${clockTime(artifact.pause.readBack.atUtc)} UTC`,
      reopens: 'Run the reopen command',
    },
  };
}
