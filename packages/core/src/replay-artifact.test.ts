import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PROVENANCES } from './records.js';
import {
  assertPublishable,
  issuePath,
  replayArtifactHash,
  replayArtifactSchema,
  reportIssue,
  type ReplayArtifact,
} from './replay-artifact.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const ARTIFACT_FILE = join(REPO_ROOT, 'packages', 'web', 'src', 'fixtures', 'replay-incident.json');

function committedArtifact(): unknown {
  return JSON.parse(readFileSync(ARTIFACT_FILE, 'utf8'));
}

function shipped(): ReplayArtifact {
  return replayArtifactSchema.parse(committedArtifact());
}

function liveCopy(): ReplayArtifact {
  const artifact = shipped();
  return { ...artifact, provenance: 'live', events: artifact.events.map((event) => ({ ...event, provenance: 'live' })) };
}

// 111122223333 is the account id AWS's own documentation uses in example ARNs.
function completeManifest(artifact: ReplayArtifact): Record<string, unknown> {
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

function reorderedEverywhere(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reorderedEverywhere);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(Object.entries(value).reverse().map(([key, nested]) => [key, reorderedEverywhere(nested)]));
}

function errorsOf(result: ReturnType<typeof assertPublishable>): string[] {
  return result.ok ? [] : result.errors;
}

describe('replayArtifactSchema over the committed site artifact', () => {
  it('validates the committed replay artifact without the site framework', () => {
    expect(replayArtifactSchema.safeParse(committedArtifact()).success).toBe(true);
  });

  it('reads the committed artifact and every one of its events as generated', () => {
    const artifact = shipped();
    expect(artifact.provenance).toBe('generated');
    expect(artifact.events.length).toBeGreaterThan(0);
    expect(new Set(artifact.events.map((event) => event.provenance))).toEqual(new Set(['generated']));
  });

  it('offers exactly the PROVENANCES values, in order, on the artifact and on each event', () => {
    expect(replayArtifactSchema.shape.provenance.options).toEqual([...PROVENANCES]);
    expect(replayArtifactSchema.shape.events.element.shape.provenance.options).toEqual([...PROVENANCES]);
  });
});

describe('replayArtifactSchema cross-field rules', () => {
  function issuePaths(candidate: unknown): string[] {
    const result = replayArtifactSchema.safeParse(candidate);
    return result.success ? [] : result.error.issues.map((issue) => issue.path.join('.'));
  }

  it('refuses a closed lane that is not one of the artifact lanes', () => {
    expect(issuePaths({ ...shipped(), closedLane: 'fothering-other' })).toEqual(['closedLane']);
  });

  it('refuses an event on a lane the artifact does not list', () => {
    const artifact = shipped();
    const events = artifact.events.map((event, index) => (index === 2 ? { ...event, lane: 'fothering-other' } : event));
    expect(issuePaths({ ...artifact, events })).toEqual(['events.2.lane']);
  });

  it('refuses a lane listed twice', () => {
    const artifact = shipped();
    expect(issuePaths({ ...artifact, lanes: [...artifact.lanes, 'fothering-bulk'] })).toEqual(['lanes.3']);
  });

  it('refuses a bounce without its bounce type', () => {
    const artifact = shipped();
    const events = artifact.events.map((event, index) => (index === 0 ? { ...event, bounceType: undefined } : event));
    expect(issuePaths({ ...artifact, events })).toEqual(['events.0.bounceType']);
  });

  it('refuses an evidence count above its denominator and accepts one equal to it', () => {
    const artifact = shipped();
    const over = artifact.evidence.map((row, index) => (index === 1 ? { ...row, count: 61 } : row));
    expect(issuePaths({ ...artifact, evidence: over })).toEqual(['evidence.1.count']);
    const equal = artifact.evidence.map((row, index) => (index === 1 ? { ...row, count: 60 } : row));
    expect(issuePaths({ ...artifact, evidence: equal })).toEqual([]);
  });

  it('refuses a time that is not ISO UTC and one that is no calendar time', () => {
    const artifact = shipped();
    expect(issuePaths({ ...artifact, email: { ...artifact.email, sentAtUtc: '2026-10-14 14:04' } })).toEqual(['email.sentAtUtc']);
    expect(issuePaths({ ...artifact, email: { ...artifact.email, sentAtUtc: '2026-10-14T25:61:00Z' } })).toEqual(['email.sentAtUtc']);
  });

  it('refuses a key the schema does not know and a non-integer count', () => {
    const artifact = shipped();
    expect(issuePaths({ ...artifact, rate: '7.5' })).toEqual(['']);
    expect(issuePaths({ ...artifact, window: { ...artifact.window, sends: 412.5 } })).toEqual(['window.sends']);
  });
});

describe('replayArtifactHash', () => {
  it('hashes a copy with keys reordered at every depth equal to the original', () => {
    const artifact = shipped();
    const reordered = reorderedEverywhere(artifact) as ReplayArtifact;
    expect(JSON.stringify(reordered)).not.toBe(JSON.stringify(artifact));
    expect(replayArtifactHash(reordered)).toBe(replayArtifactHash(artifact));
  });

  it('hashes a copy with one changed character in one value differently', () => {
    const artifact = shipped();
    const changed = { ...artifact, agent: { ...artifact.agent, paragraph: `${artifact.agent.paragraph.slice(0, -1)}!` } };
    expect(replayArtifactHash(changed)).not.toBe(replayArtifactHash(artifact));
  });

  it('returns 64 lowercase hex characters', () => {
    expect(replayArtifactHash(shipped())).toMatch(/^[0-9a-f]{64}$/);
  });

  it('hashes the UTF-8 bytes, so a non-ASCII character changes the hash from its ASCII look-alike', () => {
    const artifact = shipped();
    const umlaut = { ...artifact, agent: { ...artifact.agent, paragraph: 'Bounces from gmüx.net.' } };
    const plain = { ...artifact, agent: { ...artifact.agent, paragraph: 'Bounces from gmux.net.' } };
    expect(replayArtifactHash(umlaut)).not.toBe(replayArtifactHash(plain));
  });
});

describe('assertPublishable', () => {
  it('accepts a generated artifact with no capture manifest', () => {
    expect(assertPublishable(shipped(), undefined)).toEqual({ ok: true });
  });

  it('refuses a generated artifact that has a capture manifest beside it', () => {
    const errors = errorsOf(assertPublishable(shipped(), completeManifest(shipped())));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/capture-manifest\.json is present but the artifact's provenance is generated/);
  });

  it('refuses a live artifact with no capture manifest', () => {
    const errors = errorsOf(assertPublishable(liveCopy(), undefined));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/provenance is live but there is no capture-manifest\.json/);
  });

  it('accepts a live artifact whose complete manifest pins its hash', () => {
    const artifact = liveCopy();
    expect(assertPublishable(artifact, completeManifest(artifact))).toEqual({ ok: true });
  });

  it('refuses a live artifact whose manifest names a us-east-1 ARN', () => {
    const artifact = liveCopy();
    const manifest = { ...completeManifest(artifact), arns: ['arn:aws:ses:us-east-1:111122223333:configuration-set/fothering-bulk'] };
    expect(errorsOf(assertPublishable(artifact, manifest))).toEqual([
      expect.stringMatching(/^provenance is live but capture-manifest\.json arns\[0\]: is not an eu-central-1 ARN/),
    ]);
  });

  it('refuses a live artifact whose manifest holds an 11-digit account id', () => {
    const artifact = liveCopy();
    const manifest = { ...completeManifest(artifact), accountId: '11112222333' };
    expect(errorsOf(assertPublishable(artifact, manifest))).toEqual([
      expect.stringMatching(/^provenance is live but capture-manifest\.json accountId: is not a 12-digit account id/),
    ]);
  });

  it('refuses a live artifact whose manifest ARN names another account', () => {
    const artifact = liveCopy();
    const manifest = { ...completeManifest(artifact), arns: ['arn:aws:ses:eu-central-1:444455556666:configuration-set/fothering-bulk'] };
    expect(errorsOf(assertPublishable(artifact, manifest))).toEqual([
      expect.stringMatching(/^provenance is live but capture-manifest\.json arns\[0\]: names account 444455556666, not accountId 111122223333/),
    ]);
  });

  it('refuses a live artifact whose manifest lists no SES message id', () => {
    const artifact = liveCopy();
    const manifest = { ...completeManifest(artifact), sesMessageIds: [] };
    expect(errorsOf(assertPublishable(artifact, manifest))).toEqual([
      expect.stringMatching(/^provenance is live but capture-manifest\.json lists no SES message id\. Add the ids from the capture run, or label the artifact simulator-captured\.$/),
    ]);
  });

  it('refuses a live artifact whose manifest lists no request id', () => {
    const artifact = liveCopy();
    const manifest = { ...completeManifest(artifact), requestIds: [] };
    expect(errorsOf(assertPublishable(artifact, manifest))).toEqual([
      expect.stringMatching(/^provenance is live but capture-manifest\.json lists no request id\./),
    ]);
  });

  it('refuses a live artifact whose manifest hash is not the artifact hash', () => {
    const artifact = liveCopy();
    const manifest = { ...completeManifest(artifact), artifactSha256: replayArtifactHash(shipped()) };
    expect(errorsOf(assertPublishable(artifact, manifest))).toEqual([
      expect.stringMatching(/^provenance is live but capture-manifest\.json artifactSha256: does not equal the artifact's canonical hash/),
    ]);
  });

  it('refuses an artifact labelled live with a generated event, even with a complete manifest', () => {
    const live = liveCopy();
    const artifact = { ...live, events: live.events.map((event, index) => (index === 3 ? { ...event, provenance: 'generated' as const } : event)) };
    expect(errorsOf(assertPublishable(artifact, completeManifest(artifact)))).toEqual([
      expect.stringMatching(/^provenance is live but events\[3\]\.provenance is generated/),
    ]);
  });

  it('reports every failing manifest item, not only the first', () => {
    const artifact = liveCopy();
    const manifest = { ...completeManifest(artifact), sesMessageIds: [], requestIds: [], accountId: '1' };
    expect(errorsOf(assertPublishable(artifact, manifest))).toHaveLength(3);
  });

  it('names a missing manifest field and an unknown manifest key', () => {
    const artifact = liveCopy();
    const { accountId: _dropped, ...withoutAccount } = completeManifest(artifact);
    expect(errorsOf(assertPublishable(artifact, { ...withoutAccount, note: 'x' }))).toEqual([
      expect.stringMatching(/^provenance is live but capture-manifest\.json accountId: is missing\./),
      expect.stringMatching(/^provenance is live but capture-manifest\.json holds the unknown key note\./),
    ]);
  });
});

describe('reportIssue and issuePath', () => {
  function reports(candidate: unknown): ReturnType<typeof reportIssue>[] {
    const result = replayArtifactSchema.safeParse(candidate, { reportInput: true });
    return result.success ? [] : result.error.issues.map(reportIssue);
  }

  it('joins keys with dots and indexes with brackets', () => {
    expect(issuePath(['events', 3, 'provenance'])).toBe('events[3].provenance');
    expect(issuePath([])).toBe('');
  });

  it('reports a wrong literal, a non-integer, null and an array by what was found', () => {
    const artifact = shipped();
    expect(reports({ ...artifact, schemaVersion: 2 })).toEqual([{ path: 'schemaVersion', problem: '2 is not 1', fix: 'Use that value' }]);
    expect(reports({ ...artifact, window: { ...artifact.window, sends: 412.5 } })).toEqual([
      { path: 'window.sends', problem: 'expected an integer, found a number', fix: 'Write it as that type' },
    ]);
    expect(reports({ ...artifact, closedLane: null })).toEqual([{ path: 'closedLane', problem: 'expected a string, found null', fix: 'Write it as that type' }]);
    expect(reports({ ...artifact, closedLane: ['fothering-bulk'] })).toEqual([
      { path: 'closedLane', problem: 'expected a string, found an array', fix: 'Write it as that type' },
    ]);
  });

  it('reports an empty list, an empty text, an unknown key, a format and a cross-field rule', () => {
    const artifact = shipped();
    expect(reports({ ...artifact, events: [] })).toEqual([{ path: 'events', problem: 'is empty', fix: 'Add at least one entry' }]);
    expect(reports({ ...artifact, agent: { ...artifact.agent, paragraph: '' } })[0]).toMatchObject({ path: 'agent.paragraph', fix: 'Correct the value' });
    expect(reports({ ...artifact, rate: '7.5' })).toEqual([{ path: '', problem: 'holds the unknown key rate', fix: 'Remove it' }]);
    expect(reports({ ...artifact, email: { ...artifact.email, sentAtUtc: 'soon' } })).toEqual([
      { path: 'email.sentAtUtc', problem: 'must be an ISO 8601 UTC time such as 2026-10-14T14:01:00Z', fix: 'Correct the value' },
    ]);
    expect(reports({ ...artifact, closedLane: 'fothering-other' })).toEqual([
      { path: 'closedLane', problem: '"fothering-other" is not one of the artifact\'s lanes', fix: 'Correct the value' },
    ]);
  });
});

describe('canonical JSON', () => {
  it('refuses a non-integer number rather than hashing a printed float', () => {
    const artifact = shipped();
    expect(() => replayArtifactHash({ ...artifact, window: { ...artifact.window, sends: 1.5 } })).toThrow(RangeError);
  });

  it('leaves out an absent optional field, so it hashes like a copy without the key', () => {
    const artifact = shipped();
    const { holdCheck: _dropped, ...withoutHold } = artifact;
    expect(replayArtifactHash({ ...artifact, holdCheck: undefined })).toBe(replayArtifactHash(withoutHold));
  });
});
