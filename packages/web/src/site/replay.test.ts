import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { replayArtifactHash, replayArtifactSchema, type ReplayArtifact } from '@fothering/core/replay-artifact';
import { afterAll, describe, expect, it } from 'vitest';
import { PROVENANCE_LABELS } from './labels.js';
import { buildReplayView, loadReplayArtifact } from './replay-view.js';

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const REPO_ROOT = resolve(WEB_ROOT, '../..');
const FIXTURES = join(WEB_ROOT, 'src', 'fixtures');
const ARTIFACT_PATH = 'packages/web/src/fixtures/replay-incident.json';

// Planted project roots live under the repo's git-ignored node_modules/.cache, never the system
// temp folder, the same convention as the harness and repo-facts tests.
const CACHE = join(REPO_ROOT, 'node_modules', '.cache');
mkdirSync(CACHE, { recursive: true });
const PLANT = mkdtempSync(join(CACHE, 'site-replay-'));

afterAll(() => {
  rmSync(PLANT, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

function shippedArtifact(): ReplayArtifact {
  return replayArtifactSchema.parse(JSON.parse(readFileSync(join(FIXTURES, 'replay-incident.json'), 'utf8')));
}

function shippedJson(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(FIXTURES, 'replay-incident.json'), 'utf8')) as Record<string, unknown>;
}

function plantProject(name: string, artifactText: string | undefined, manifestText?: string): string {
  const root = join(PLANT, name);
  mkdirSync(join(root, 'src', 'fixtures'), { recursive: true });
  if (artifactText !== undefined) writeFileSync(join(root, 'src', 'fixtures', 'replay-incident.json'), artifactText);
  if (manifestText !== undefined) writeFileSync(join(root, 'src', 'fixtures', 'capture-manifest.json'), manifestText);
  return root;
}

function liveArtifact(): ReplayArtifact {
  const artifact = shippedArtifact();
  return { ...artifact, provenance: 'live', events: artifact.events.map((event) => ({ ...event, provenance: 'live' })) };
}

function manifestFor(artifact: ReplayArtifact): Record<string, unknown> {
  return {
    artifact: 'replay-incident.json',
    artifactSha256: replayArtifactHash(artifact),
    region: 'eu-central-1',
    accountId: '111122223333',
    arns: ['arn:aws:ses:eu-central-1:111122223333:configuration-set/fothering-bulk'],
    sesMessageIds: ['0100019a2b3c4d5e-7f8e9d0c-1a2b-4c3d-9e8f-7a6b5c4d3e2f-000000'],
    requestIds: ['b1c2d3e4-5f60-4718-9a2b-3c4d5e6f7a8b'],
  };
}

function loadError(root: string): string {
  try {
    loadReplayArtifact(root);
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error(`loadReplayArtifact(${root}) returned an artifact`);
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

describe('provenance label wording', () => {
  const fixtureLabels = [PROVENANCE_LABELS['doc-derived'], PROVENANCE_LABELS.generated];

  it('never words a doc-derived or generated label as recorded or captured', () => {
    for (const label of fixtureLabels) {
      for (const field of Object.values(label)) expect(field).not.toMatch(/recorded|recording|captured|capture/i);
    }
  });

  it('calls doc-derived and generated times illustrative', () => {
    for (const label of fixtureLabels) expect(label.timeWording).toContain('illustrative');
  });

  it('keeps the SES reputation page link with the simulator caption', () => {
    expect(PROVENANCE_LABELS['simulator-captured'].captionLinkHref).toBe('https://docs.aws.amazon.com/ses/latest/dg/reputationdashboardmessages.html');
  });
});

describe('loadReplayArtifact refusals', () => {
  it('names a missing artifact file', () => {
    expect(loadError(plantProject('missing', undefined))).toMatch(/^packages\/web\/src\/fixtures\/replay-incident\.json: not found\./);
  });

  it('names an empty artifact file', () => {
    expect(loadError(plantProject('empty', ' \n'))).toMatch(/^packages\/web\/src\/fixtures\/replay-incident\.json: empty\./);
  });

  it('names an artifact that is not valid JSON', () => {
    expect(loadError(plantProject('invalid-json', '{ "schemaVersion": 1,'))).toMatch(
      /^packages\/web\/src\/fixtures\/replay-incident\.json: not valid JSON/,
    );
  });

  it('names an artifact with no events', () => {
    const message = loadError(plantProject('no-events', JSON.stringify({ ...shippedJson(), events: [] })));
    expect(message).toMatch(/^packages\/web\/src\/fixtures\/replay-incident\.json: events: /);
  });

  it('names an artifact with no provenance field', () => {
    const { provenance: _dropped, ...rest } = shippedJson();
    const message = loadError(plantProject('no-provenance', JSON.stringify(rest)));
    expect(message).toMatch(/^packages\/web\/src\/fixtures\/replay-incident\.json: provenance: is missing\./);
  });

  it('names a missing required field by its path', () => {
    const json = shippedJson();
    const window = { ...(json.window as Record<string, unknown>) };
    delete window.sends;
    const message = loadError(plantProject('missing-field', JSON.stringify({ ...json, window })));
    expect(message).toMatch(/^packages\/web\/src\/fixtures\/replay-incident\.json: window\.sends: is missing\./);
  });

  it('names a field of the wrong type by its path', () => {
    const json = shippedJson();
    const message = loadError(plantProject('wrong-type', JSON.stringify({ ...json, window: { ...(json.window as object), sends: '412' } })));
    expect(message).toMatch(/^packages\/web\/src\/fixtures\/replay-incident\.json: window\.sends: expected a number, found a string\./);
  });

  it('names an unknown provenance value on an event in the UI-SPEC build message shape', () => {
    const json = shippedJson();
    const events = (json.events as Record<string, unknown>[]).map((event, index) => (index === 3 ? { ...event, provenance: 'measured' } : event));
    expect(loadError(plantProject('unknown-provenance', JSON.stringify({ ...json, events })))).toBe(
      "packages/web/src/fixtures/replay-incident.json: events[3].provenance: 'measured' is not one of doc-derived, simulator-captured, live, generated. Use one of those values.",
    );
  });

  it('throws the publishability errors for a live artifact with an incomplete manifest', () => {
    const artifact = liveArtifact();
    const manifest = { ...manifestFor(artifact), sesMessageIds: [] };
    const message = loadError(plantProject('live-incomplete', JSON.stringify(artifact), JSON.stringify(manifest)));
    expect(message).toBe(
      `${ARTIFACT_PATH}: provenance is live but capture-manifest.json lists no SES message id. Add the ids from the capture run, or label the artifact simulator-captured.`,
    );
  });

  it('throws for a generated artifact with a stray manifest rather than loading it', () => {
    const artifact = shippedArtifact();
    const message = loadError(plantProject('stray-manifest', JSON.stringify(artifact), JSON.stringify(manifestFor(artifact))));
    expect(message).toMatch(/capture-manifest\.json is present but the artifact's provenance is generated/);
  });

  it('names a capture manifest that is not valid JSON', () => {
    const message = loadError(plantProject('manifest-json', JSON.stringify(liveArtifact()), '{ nope'));
    expect(message).toMatch(/^packages\/web\/src\/fixtures\/capture-manifest\.json: not valid JSON/);
  });

  it('loads a live artifact whose complete manifest pins its hash', () => {
    const artifact = liveArtifact();
    const root = plantProject('live-complete', JSON.stringify(artifact), JSON.stringify(manifestFor(artifact)));
    expect(loadReplayArtifact(root)).toEqual(artifact);
  });
});
