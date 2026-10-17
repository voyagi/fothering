import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { replayArtifactSchema, type ReplayArtifact } from '@fothering/core/replay-artifact';
import { describe, expect, it } from 'vitest';
import { PROVENANCE_LABELS } from './labels.js';
import { buildReplayView, loadReplayArtifact } from './replay-view.js';

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const FIXTURES = join(WEB_ROOT, 'src', 'fixtures');

function shippedArtifact(): ReplayArtifact {
  return replayArtifactSchema.parse(JSON.parse(readFileSync(join(FIXTURES, 'replay-incident.json'), 'utf8')));
}

describe('loadReplayArtifact and the tag stamp', () => {
  it('loads the committed artifact from the web project root', () => {
    expect(loadReplayArtifact(WEB_ROOT)).toEqual(shippedArtifact());
  });

  it('stamps and captions the generated artifact from the generated label', () => {
    const view = buildReplayView(loadReplayArtifact(WEB_ROOT));
    expect(view.tag.stamp).toBe(PROVENANCE_LABELS.generated.stamp);
    expect(view.caption).toBe(PROVENANCE_LABELS.generated.caption);
  });

  it('follows a doc-derived copy to the doc-derived stamp and caption', () => {
    const view = buildReplayView({ ...shippedArtifact(), provenance: 'doc-derived' });
    expect(view.tag.stamp).toBe(PROVENANCE_LABELS['doc-derived'].stamp);
    expect(view.caption).toBe(PROVENANCE_LABELS['doc-derived'].caption);
    expect(view.caption).not.toBe(PROVENANCE_LABELS.generated.caption);
  });

  it('follows a simulator-captured copy to a different stamp', () => {
    const view = buildReplayView({ ...shippedArtifact(), provenance: 'simulator-captured' });
    expect(view.tag.stamp).toBe('SIMULATOR RUN');
    expect(view.caption).toBe(PROVENANCE_LABELS['simulator-captured'].caption);
  });
});

describe('the fixtures folder', () => {
  it('holds exactly one replay artifact besides an optional capture manifest', () => {
    const files = readdirSync(FIXTURES).filter((name) => name !== 'capture-manifest.json');
    expect(files).toEqual(['replay-incident.json']);
  });
});
