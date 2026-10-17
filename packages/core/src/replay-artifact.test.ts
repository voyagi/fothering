import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PROVENANCES } from './records.js';
import { replayArtifactSchema } from './replay-artifact.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const ARTIFACT_FILE = join(REPO_ROOT, 'packages', 'web', 'src', 'fixtures', 'replay-incident.json');

function committedArtifact(): unknown {
  return JSON.parse(readFileSync(ARTIFACT_FILE, 'utf8'));
}

describe('replayArtifactSchema over the committed site artifact', () => {
  it('validates the committed replay artifact without the site framework', () => {
    expect(replayArtifactSchema.safeParse(committedArtifact()).success).toBe(true);
  });

  it('reads the committed artifact and every one of its events as generated', () => {
    const artifact = replayArtifactSchema.parse(committedArtifact());
    expect(artifact.provenance).toBe('generated');
    expect(artifact.events.length).toBeGreaterThan(0);
    expect(new Set(artifact.events.map((event) => event.provenance))).toEqual(new Set(['generated']));
  });

  it('offers exactly the PROVENANCES values, in order, on the artifact and on each event', () => {
    expect(replayArtifactSchema.shape.provenance.options).toEqual([...PROVENANCES]);
    expect(replayArtifactSchema.shape.events.element.shape.provenance.options).toEqual([...PROVENANCES]);
  });
});
