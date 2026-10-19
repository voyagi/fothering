import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseLaneMap } from '@fothering/core/lanes';
import { replayArtifactHash, replayArtifactSchema, type ReplayArtifact } from '@fothering/core/replay-artifact';
import { afterAll, describe, expect, it } from 'vitest';
import { PROVENANCE_LABELS } from './labels.js';
import { readRepoText, repoRoot } from './repo-facts.js';
import { buildReplayView, fixtureFindings, loadReplayArtifact } from './replay-view.js';

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

  it('stops the load on an artifact holding a real IPv4 or IPv6 address, naming the line and the kind', () => {
    const text = readFileSync(join(FIXTURES, 'replay-incident.json'), 'utf8');
    const plant = (name: string, address: string): string => {
      const planted = text.replace('"Delivered, stream receipts"', `"Delivered, stream receipts, from ${address}"`);
      expect(planted).not.toBe(text);
      return loadError(plantProject(name, planted));
    };
    expect(plant('real-ipv4', '10.1.2.3')).toMatch(/^packages\/web\/src\/fixtures\/replay-incident\.json:\d+: an IP address outside 192\.0\.2\.0\/24/);
    expect(plant('real-ipv6', '2a00:1450:4001:80b::200e')).toMatch(/^packages\/web\/src\/fixtures\/replay-incident\.json:\d+: an IPv6 address outside 2001:db8::\/32\./);
  });

  it('stops the load on a capture manifest holding a real address', () => {
    const artifact = liveArtifact();
    const manifest = { ...manifestFor(artifact), requestIds: ['from 10.1.2.3'] };
    expect(loadError(plantProject('manifest-ipv4', JSON.stringify(artifact), JSON.stringify(manifest)))).toMatch(/^packages\/web\/src\/fixtures\/capture-manifest\.json:\d+: an IP address outside /);
  });

  it('loads a live artifact whose complete manifest pins its hash', () => {
    const artifact = liveArtifact();
    const root = plantProject('live-complete', JSON.stringify(artifact), JSON.stringify(manifestFor(artifact)));
    expect(loadReplayArtifact(root)).toEqual(artifact);
  });
});

describe('buildReplayView order', () => {
  it('renders steps 1 to 4 and the same log whatever order the artifact lists events in', () => {
    const artifact = shippedArtifact();
    const reversed = buildReplayView({ ...artifact, events: [...artifact.events].reverse() });
    expect(reversed.steps.map((step) => step.number)).toEqual([1, 2, 3, 4]);
    expect(reversed.eventLog.rows).toEqual(buildReplayView(artifact).eventLog.rows);
  });

  it('keeps the artifact order for two events with equal times', () => {
    const artifact = shippedArtifact();
    const [first, second, ...rest] = artifact.events;
    if (first === undefined || second === undefined) throw new Error('the shipped artifact has fewer than two events');
    const tieA = { ...first, atUtc: '2026-10-14T14:01:07Z', detail: 'tie A' };
    const tieB = { ...second, atUtc: '2026-10-14T14:01:07Z', detail: 'tie B' };
    const details = (events: ReplayArtifact['events']): string[] =>
      buildReplayView({ ...artifact, events }).eventLog.rows.filter((row) => row.detail.startsWith('tie')).map((row) => row.detail);
    expect(details([tieA, tieB, ...rest])).toEqual(['tie A', 'tie B']);
    expect(details([tieB, tieA, ...rest])).toEqual(['tie B', 'tie A']);
  });
});

describe('buildReplayView step contents', () => {
  it('gives step 2 one schedule row per evidence row with dimension, count, denominator, verdict and threshold', () => {
    const artifact = shippedArtifact();
    const { rows } = buildReplayView(artifact).schedule;
    expect(rows.map((row) => [row.count, row.denominator, row.threshold])).toEqual(
      artifact.evidence.map((row) => [row.count, row.denominator, row.threshold]),
    );
    expect(rows[0]).toMatchObject({ dimension: 'Tag', label: 'Tag `batch=2026-10-14-b`', countText: '31 of 31 hard bounces', verdict: 'Cause' });
    expect(rows.map((row) => row.verdict)).toEqual(['Cause', 'Clean', 'Ruled out', 'Ruled out']);
    expect(rows.map((row) => row.dimension)).toEqual(['Tag', 'Tag', 'Provider', 'Configuration']);
  });

  it('marks a provider row unconfirmed until it carries a confirming source, which becomes its link', () => {
    const artifact = shippedArtifact();
    expect(buildReplayView(artifact).schedule.rows.map((row) => row.unconfirmed)).toEqual([false, false, true, false]);
    const url = 'https://docs.aws.amazon.com/ses/latest/dg/send-email-concepts-deliverability.html';
    const confirmed = artifact.evidence.map((row) => (row.dimension === 'provider' ? { ...row, confirmingSourceUrl: url } : row));
    const provider = buildReplayView({ ...artifact, evidence: confirmed }).schedule.rows[2];
    expect(provider).toMatchObject({ unconfirmed: false, sourceUrl: url });
  });

  it('names the closed lane and every other artifact lane as open in steps 3 and 4', () => {
    expect(buildReplayView(shippedArtifact()).lanesLines).toEqual({
      paused: 'Closed: fothering-bulk. Open: fothering-transactional, fothering-alerts.',
      reopened: 'Reopened: fothering-bulk. Open throughout: fothering-transactional, fothering-alerts.',
    });
  });

  it('reads "Open: <lane>" with one other lane', () => {
    const view = buildReplayView({ ...shippedArtifact(), lanes: ['fothering-transactional', 'fothering-bulk'] });
    expect(view.lanesLines.paused).toBe('Closed: fothering-bulk. Open: fothering-transactional.');
    expect(view.boardDescriptions[2]).toContain('fothering-transactional keeps flowing.');
  });

  it('says closed, LANE CLOSED and the hold check with a passing hold check', () => {
    const view = buildReplayView(shippedArtifact());
    expect(view.tag.legend).toBe('LANE CLOSED');
    expect(view.steps[2]?.heading).toBe('Paused, read back, then held');
    expect(view.steps[2]?.paragraphs.join(' ')).toContain('A hold check finds no send accepted after 14:03 UTC.');
    expect(view.email.subject).toBe('Closed: fothering-bulk, one lane in eu-central-1');
  });

  it('shows the operator email subject the artifact recorded, not one the view builds', () => {
    const artifact = shippedArtifact();
    expect(buildReplayView({ ...artifact, email: { ...artifact.email, subject: 'Paused: fothering-bulk' } }).email.subject).toBe('Paused: fothering-bulk');
    expect(buildReplayView(artifact).email.subject).toBe(artifact.email.subject);
  });

  it('says paused and LANE PAUSED without a hold check, and no view string says closed', () => {
    const { holdCheck: _dropped, ...rest } = shippedArtifact();
    const view = buildReplayView({ ...rest, email: { ...rest.email, subject: 'Paused: fothering-bulk, one lane in eu-central-1' } });
    expect(view.tag.legend).toBe('LANE PAUSED');
    expect(view.steps[2]?.heading).toBe('Paused, then read back');
    expect(view.lanesLines.paused).toMatch(/^Paused: fothering-bulk\./);
    expect(JSON.stringify(view)).not.toMatch(/\bclosed\b/i);
  });

  it('summarises the lane, the cause, the pause with its read-back and the reopen with its read-back', () => {
    expect(buildReplayView(shippedArtifact()).summary).toEqual([
      { time: '14:01', text: 'Hard bounces on fothering-bulk' },
      { time: '14:02', text: 'Cause: batch=2026-10-14-b' },
      { time: '14:03', text: 'Paused, read back false' },
      { time: '15:20', text: 'Reopened by command, read back true' },
    ]);
  });

  it('writes the step texts, the email and the tag from the artifact', () => {
    const view = buildReplayView(shippedArtifact());
    expect(view.h1).toBe('Replay: the fothering-bulk incident');
    expect(view.intro).toBe('One incident, four steps. Times are illustrative.');
    expect(view.steps.map((step) => [step.label, step.time])).toEqual([
      ['Bounces arrive', '14:01'],
      ['Cause named', '14:02'],
      ['Paused, read back', '14:03'],
      ['Reopened by command', '15:20'],
    ]);
    expect(view.steps[0]?.paragraphs).toEqual([
      'Permanent bounces arrive on fothering-bulk. The two logged here read `550 5.1.1` and came from two domains. The other lanes keep delivering.',
    ]);
    expect(view.schedule.caption).toBe('fothering-bulk, 13:01 to 14:01 UTC, 412 sends.');
    expect(view.schedule.modelRole).toBe('Code approved one lane. The agent confirmed that option.');
    expect(view.steps[2]?.paragraphs).toEqual([
      '`PutConfigurationSetSendingOptions` turns sending off for fothering-bulk only. `GetConfigurationSet` reads `SendingOptions.SendingEnabled` as false. A hold check finds no send accepted after 14:03 UTC.',
    ]);
    expect(view.email).toEqual({
      subject: 'Closed: fothering-bulk, one lane in eu-central-1',
      disclosure: "Fothering's AI agent wrote the Why paragraph. Code wrote the rest.",
      why: 'All 31 hard bounces carry batch=2026-10-14-b, and the earlier batch delivered cleanly.',
      reopen: 'Run the reopen command for fothering-bulk.',
    });
    expect(view.reopenCommand).toContain('--configuration-set-name fothering-bulk --sending-enabled');
    expect(view.steps[3]?.paragraphs).toEqual(['`GetConfigurationSet` then read `SendingEnabled` as true.']);
    expect(view.tag).toMatchObject({
      evidence: 'All 31 hard bounces in the window carry that tag. The two in the replay read `550 5.1.1`.',
      readBack: 'SendingOptions.SendingEnabled: false, 14:03 UTC',
      replayReadBack: 'SendingEnabled: false, 14:03 UTC',
      number: 'TAG 001',
    });
    expect(view.boardDescriptions).toEqual([
      'Mail flows on all 3 lanes. Bounce marks appear on fothering-bulk.',
      'Mail still flows on all 3 lanes, with bounce marks on fothering-bulk. Detection code has approved one lane.',
      'fothering-bulk is stopped at a filled valve with a lockout tag, and its outlet is dotted. fothering-transactional, fothering-alerts keep flowing.',
      'fothering-bulk flows again and the tag is off the valve. All 3 lanes flow.',
    ]);
    expect(view.landing.drawingTitle).toBe('Flow drawing of one SES account with 3 sending lanes');
  });

  it('words nothing in the generated view as recorded or captured', () => {
    expect(JSON.stringify(buildReplayView(shippedArtifact()))).not.toMatch(/recorded|recording|captured|capture/i);
  });
});

describe('buildReplayView event log', () => {
  it('follows the step order and leaves an absent SMTP code or receiving domain empty, never a placeholder', () => {
    const { rows } = buildReplayView(shippedArtifact()).eventLog;
    expect(rows.map((row) => row.step)).toEqual([...rows.map((row) => row.step)].sort((a, b) => a - b));
    expect(rows[0]).toMatchObject({ time: '14:01:07', kind: 'Bounce, Permanent', smtpCode: '550 5.1.1', receivingDomain: 'web.de' });
    const evidenceRow = rows.find((row) => row.kind === 'Evidence record');
    expect(evidenceRow).toMatchObject({ smtpCode: '', receivingDomain: '' });
  });

  it('captions the log from the label map and counts the hard bounces it shows', () => {
    const artifact = shippedArtifact();
    const { eventLog } = buildReplayView(artifact);
    expect(eventLog.caption).toBe(PROVENANCE_LABELS.generated.caption);
    expect(eventLog.note).toBe('Showing the first two hard bounces and every decision, call and email.');
    const oneBounce = artifact.events.filter((event, index) => event.kind !== 'bounce' || index === 0);
    expect(buildReplayView({ ...artifact, events: oneBounce }).eventLog.note).toBe('Showing the first hard bounce and every decision, call and email.');
  });

  it('words the tag evidence as a share when not every bounce carries the cause', () => {
    const artifact = shippedArtifact();
    const evidence = artifact.evidence.map((row) => (row.verdict === 'cause' ? { ...row, count: 29 } : row));
    expect(buildReplayView({ ...artifact, evidence }).tag.evidence).toBe('29 of 31 hard bounces in the window carry that tag. The two in the replay read `550 5.1.1`.');
  });

  it('names no open lane and no flowing lane when the artifact has one lane', () => {
    const view = buildReplayView({ ...shippedArtifact(), lanes: ['fothering-bulk'] });
    expect(view.lanesLines).toEqual({ paused: 'Closed: fothering-bulk. No other lane.', reopened: 'Reopened: fothering-bulk. No other lane.' });
    expect(view.boardDescriptions[2]).toBe('fothering-bulk is stopped at a filled valve with a lockout tag, and its outlet is dotted.');
    expect(view.steps[0]?.paragraphs[0]).toMatch(/came from two domains\.$/);
    expect(view.landing.drawingDescription).toBe('fothering-bulk, the only lane from the SES account, is stopped at a closed valve that carries a lockout tag, with a read-back instrument at 14:03 UTC.');
  });

  it('names the open lanes the landing drawing shows flowing', () => {
    expect(buildReplayView(shippedArtifact()).landing.drawingDescription).toBe(
      'Mail flows from the SES account through fothering-transactional, fothering-alerts. fothering-bulk is stopped at a closed valve that carries a lockout tag, with a read-back instrument at 14:03 UTC.',
    );
  });

  it('carries the simulator caption link and a provider-free configuration label', () => {
    const view = buildReplayView({ ...shippedArtifact(), provenance: 'simulator-captured' });
    expect(view.captionLinkHref).toBe(PROVENANCE_LABELS['simulator-captured'].captionLinkHref);
    expect(view.schedule.rows[3]?.label).toBe('DKIM and MAIL FROM');
    expect(buildReplayView(shippedArtifact()).captionLinkHref).toBeUndefined();
  });
});

describe('buildReplayView refusals', () => {
  const artifact = shippedArtifact();
  const cases: [string, ReplayArtifact, RegExp][] = [
    ['a step 3 read-back of true', { ...artifact, pause: { ...artifact.pause, readBack: { ...artifact.pause.readBack, value: 'true' } } }, /: pause\.readBack\.value: /],
    ['a failed hold check', { ...artifact, holdCheck: { atUtc: artifact.pause.atUtc, holdFromUtc: artifact.pause.atUtc, result: 'failed' } }, /: holdCheck\.result: /],
    ['an agent that said unknown', { ...artifact, agent: { ...artifact.agent, outcome: 'unknown' } }, /: agent\.outcome: /],
    ['a reopen read-back of false', { ...artifact, reopen: { ...artifact.reopen, readBack: { ...artifact.reopen.readBack, value: 'false' } } }, /: reopen\.readBack\.value: /],
    ['a step with no event', { ...artifact, events: artifact.events.filter((event) => event.step !== 2) }, /: events: step 2 has no event/],
    ['no evidence row with the verdict cause', { ...artifact, evidence: artifact.evidence.filter((row) => row.verdict !== 'cause') }, /: evidence: no row has the verdict cause/],
    ['no bounce on the closed lane with an SMTP code', { ...artifact, events: artifact.events.map((event) => ({ ...event, smtpCode: undefined })) }, /: events: no bounce on fothering-bulk carries an SMTP code/],
  ];

  it.each(cases)('throws by name for %s', (_name, candidate, pattern) => {
    expect(() => buildReplayView(candidate)).toThrow(/^packages\/web\/src\/fixtures\/replay-incident\.json: /);
    expect(() => buildReplayView(candidate)).toThrow(pattern);
  });
});

// The page heads step one "Hard bounces on one lane", step one gives the one SMTP code the logged
// bounces read and the receiving domains they came from, the tag counts them among the cause row's
// hard bounces in the window, and the summary and steps read in time order. An artifact where any of
// that is false is refused by the claim it would break (WR-03, WR-12).
describe('buildReplayView refuses an artifact the replay copy would misstate', () => {
  const artifact = shippedArtifact();
  const bounceIndexes = artifact.events.flatMap((event, index) => (event.kind === 'bounce' ? [index] : []));
  const secondBounce = bounceIndexes[1] ?? -1;
  const withEvent = (index: number, change: Partial<ReplayArtifact['events'][number]>): ReplayArtifact => ({
    ...artifact,
    events: artifact.events.map((event, at) => (at === index ? { ...event, ...change } : event)),
  });
  const withCause = (change: Partial<ReplayArtifact['evidence'][number]>): ReplayArtifact => ({
    ...artifact,
    evidence: artifact.evidence.map((row) => (row.verdict === 'cause' ? { ...row, ...change } : row)),
  });
  const withBounceType = (bounceType: 'Transient' | 'Undetermined'): ReplayArtifact => ({
    ...artifact,
    events: artifact.events.map((event) => (event.kind === 'bounce' ? { ...event, bounceType } : event)),
  });
  const otherLaneBounce = {
    step: 1 as const,
    atUtc: '2026-10-14T14:01:15Z',
    kind: 'bounce' as const,
    lane: 'fothering-transactional',
    detail: 'Transient bounce, MailboxFull',
    provenance: 'generated' as const,
    bounceType: 'Transient' as const,
    smtpCode: '452 4.2.2',
    receivingDomain: 'outlook.com',
  };
  const at = (time: string): string => `2026-10-14T${time}Z`;
  const cases: [string, ReplayArtifact, RegExp][] = [
    ['a bounce on another lane', { ...artifact, events: [...artifact.events, otherLaneBounce] }, /: events: a bounce sits on fothering-transactional, and the replay heads step one "Hard bounces on one lane"\. Replay an incident whose bounces are all on the paused lane\.$/],
    ['mixed SMTP codes on the closed lane', withEvent(secondBounce, { smtpCode: '552 5.2.2' }), /: events: the bounces on fothering-bulk carry 550 5\.1\.1 and 552 5\.2\.2, and step one says the bounces shown read one code\. /],
    ['a closed-lane bounce with no receiving domain', withEvent(secondBounce, { receivingDomain: undefined }), /: events: a bounce on fothering-bulk has no receiving domain, so the domains the bounces came from cannot be counted\. /],
    ['a cause row that counts sends', withCause({ unit: 'sends' }), /: evidence\[0\]\.unit: is sends, and the step heading, the summary and the tag read the cause as hard bounces\. Replay an incident whose cause row counts hard bounces\.$/],
    ['more closed-lane bounces than the cause row counts', withCause({ count: 1 }), /: events: 2 bounces sit on fothering-bulk, more than the 1 the cause row counts, and the tag puts the replay's bounces among them\. Replay an incident whose cause row counts every bounce it logs\.$/],
    ['a bounce after the window ends', withEvent(secondBounce, { atUtc: at('14:01:31') }), /: events: a bounce on fothering-bulk at 2026-10-14T14:01:31Z is outside the window 2026-10-14T13:01:30Z to 2026-10-14T14:01:30Z, and the tag counts the bounces in the window\. Correct the bounce times or the window so every bounce falls inside it\.$/],
    ['a bounce before the window starts', withEvent(secondBounce, { atUtc: at('13:01:29') }), /: events: a bounce on fothering-bulk at 2026-10-14T13:01:29Z is outside the window /],
    ['a Permanent and a Transient bounce on the closed lane', withEvent(secondBounce, { bounceType: 'Transient' }), /: events: a bounce on fothering-bulk is Transient, and the replay calls the bounces on fothering-bulk hard\. Replay an incident whose bounces on the paused lane are all Permanent\.$/],
    ['only Transient bounces on the closed lane', withBounceType('Transient'), /: events: a bounce on fothering-bulk is Transient, and the replay calls the bounces on fothering-bulk hard\. Replay an incident whose bounces on the paused lane are all Permanent\.$/],
    ['only Undetermined bounces on the closed lane', withBounceType('Undetermined'), /: events: a bounce on fothering-bulk is Undetermined, and the replay calls the bounces on fothering-bulk hard\. /],
    ['a window that starts after it ends', { ...artifact, window: { ...artifact.window, startUtc: at('14:02:00') } }, /: window\.startUtc: 2026-10-14T14:02:00Z is after window\.endUtc 2026-10-14T14:01:30Z\. /],
    ['a pause read-back before the pause', { ...artifact, pause: { ...artifact.pause, readBack: { ...artifact.pause.readBack, atUtc: at('14:02:59') } } }, /: pause\.readBack\.atUtc: 2026-10-14T14:02:59Z is before pause\.atUtc 2026-10-14T14:03:00Z\. /],
    ['a reopen before the pause read-back', { ...artifact, reopen: { ...artifact.reopen, atUtc: at('14:03:01'), readBack: { ...artifact.reopen.readBack, atUtc: at('14:03:01') } } }, /: reopen\.atUtc: 2026-10-14T14:03:01Z is before pause\.readBack\.atUtc 2026-10-14T14:03:02Z\. /],
    ['a reopen read-back before the reopen command', { ...artifact, reopen: { ...artifact.reopen, readBack: { ...artifact.reopen.readBack, atUtc: at('15:19:59') } } }, /: reopen\.readBack\.atUtc: 2026-10-14T15:19:59Z is before reopen\.atUtc 2026-10-14T15:20:00Z\. /],
    ['a step 2 event earlier than a step 1 event', withEvent(artifact.events.findIndex((event) => event.step === 2), { atUtc: at('14:01:00') }), /: events: step 2 has an event at 2026-10-14T14:01:00Z, before a step 1 event at 2026-10-14T14:01:20Z\. /],
  ];

  it('plants each case on the shipped artifact, which itself builds', () => {
    expect(secondBounce).toBeGreaterThan(0);
    expect(() => buildReplayView(artifact)).not.toThrow();
  });

  it('builds a bounce exactly at either end of the window, and a cause row counting exactly the logged bounces', () => {
    const bounceTimes = (candidate: ReplayArtifact): string[] => buildReplayView(candidate).eventLog.rows.filter((row) => row.kind === 'Bounce, Permanent').map((row) => row.time);
    expect(bounceTimes(withEvent(secondBounce, { atUtc: artifact.window.endUtc }))).toEqual(['14:01:07', '14:01:30']);
    expect(bounceTimes(withEvent(secondBounce, { atUtc: artifact.window.startUtc }))).toEqual(['13:01:30', '14:01:07']);
    expect(buildReplayView(withCause({ count: 2 })).tag.evidence).toBe('2 of 31 hard bounces in the window carry that tag. The two in the replay read `550 5.1.1`.');
  });

  it.each(cases)('throws by name for %s', (_name, candidate, pattern) => {
    expect(() => buildReplayView(candidate)).toThrow(/^packages\/web\/src\/fixtures\/replay-incident\.json: /);
    expect(() => buildReplayView(candidate)).toThrow(pattern);
  });
});

// Step one names what it counts: the distinct receiving domains of the logged bounces, case folded,
// never a provider figure (web.de and gmx.net are two domains of one provider group, WR-09).
describe('the domain figure counts the receiving domains of the closed lane bounces', () => {
  const artifact = shippedArtifact();
  const closedBounces = artifact.events.filter((event) => event.kind === 'bounce' && event.lane === artifact.closedLane);
  const extra = (receivingDomain: string): ReplayArtifact['events'][number] => ({ ...(closedBounces[0] ?? artifact.events[0]), atUtc: '2026-10-14T14:01:10Z', receivingDomain } as ReplayArtifact['events'][number]);
  const stepOne = (events: ReplayArtifact['events']): string => buildReplayView({ ...artifact, events }).steps[0]?.paragraphs[0] ?? '';

  it('names that count in step one and leaves it off the tag', () => {
    const view = buildReplayView(artifact);
    expect(view.steps[0]?.paragraphs[0]).toContain(' and came from two domains.');
    expect(view.tag.evidence).not.toMatch(/provider|domain/);
  });

  it('adds one for a new domain and nothing for a repeated one', () => {
    expect(stepOne([...artifact.events, extra('t-online.de')])).toContain(' and came from three domains.');
    expect(stepOne([...artifact.events, extra(closedBounces[0]?.receivingDomain ?? '')])).toContain(' and came from two domains.');
  });

  it('says one domain, singular, for two bounces from one domain', () => {
    const oneDomain = artifact.events.map((event) => (event.kind === 'bounce' ? { ...event, receivingDomain: 'web.de' } : event));
    expect(stepOne(oneDomain)).toBe('Permanent bounces arrive on fothering-bulk. The two logged here read `550 5.1.1` and came from one domain. The other lanes keep delivering.');
  });

  it('counts WEB.DE and web.de as one domain', () => {
    const [first, second] = closedBounces;
    const caseVariants = artifact.events.map((event) => (event === first ? { ...event, receivingDomain: 'WEB.DE' } : event === second ? { ...event, receivingDomain: 'web.de' } : event));
    expect(stepOne(caseVariants)).toContain(' and came from one domain.');
  });

  it('never takes the window-wide provider count', () => {
    const view = buildReplayView({ ...artifact, window: { ...artifact.window, receivingProviders: 40 } });
    expect(JSON.stringify(view)).not.toMatch(/\b40 (providers|domains)\b/);
  });
});

// Step one, the tag and the log note count the bounces the replay logs, never the cause row's window
// count, and every count under ten is a word, the way the log note writes it (IN-21, IN-24).
describe('step one, the tag and the log note count the closed lane bounces the replay logs', () => {
  const artifact = shippedArtifact();
  const closedBounces = artifact.events.filter((event) => event.kind === 'bounce' && event.lane === artifact.closedLane);
  const firstBounce = closedBounces[0];
  if (firstBounce === undefined) throw new Error('the shipped artifact has no bounce on its closed lane');
  const view = (events: ReplayArtifact['events']): ReturnType<typeof buildReplayView> => buildReplayView({ ...artifact, events });
  // n bounces from the first bounce's domain, one second apart from 14:00:00, inside the window.
  const withBounces = (count: number): ReplayArtifact['events'] => [
    ...artifact.events.filter((event) => event.kind !== 'bounce'),
    ...Array.from({ length: count }, (_unused, index) => ({ ...firstBounce, atUtc: `2026-10-14T14:00:${String(index).padStart(2, '0')}Z` })),
  ];

  it('renders the shipped sentences exactly', () => {
    const shipped = buildReplayView(artifact);
    expect(shipped.steps[0]?.paragraphs).toEqual(['Permanent bounces arrive on fothering-bulk. The two logged here read `550 5.1.1` and came from two domains. The other lanes keep delivering.']);
    expect(shipped.tag.evidence).toBe('All 31 hard bounces in the window carry that tag. The two in the replay read `550 5.1.1`.');
    expect(shipped.eventLog.note).toBe('Showing the first two hard bounces and every decision, call and email.');
  });

  it('counts three bounces from two receiving domains as three logged, from two domains', () => {
    const three = view([...artifact.events, { ...firstBounce, atUtc: '2026-10-14T14:01:10Z' }]);
    expect(three.steps[0]?.paragraphs[0]).toBe('Permanent bounces arrive on fothering-bulk. The three logged here read `550 5.1.1` and came from two domains. The other lanes keep delivering.');
    expect(three.tag.evidence).toBe('All 31 hard bounces in the window carry that tag. The three in the replay read `550 5.1.1`.');
    expect(three.eventLog.note).toBe('Showing the first three hard bounces and every decision, call and email.');
  });

  it('words one bounce in the singular in step one, on the tag and in the log note', () => {
    const one = view(artifact.events.filter((event) => event.kind !== 'bounce' || event === firstBounce));
    expect(one.steps[0]?.paragraphs[0]).toBe('Permanent bounces arrive on fothering-bulk. The one logged here reads `550 5.1.1` and came from one domain. The other lanes keep delivering.');
    expect(one.tag.evidence).toBe('All 31 hard bounces in the window carry that tag. The one in the replay reads `550 5.1.1`.');
    expect(one.eventLog.note).toBe('Showing the first hard bounce and every decision, call and email.');
  });

  it('writes nine as a word and 10 and 12 as digits', () => {
    expect(view(withBounces(9)).steps[0]?.paragraphs[0]).toContain('The nine logged here read `550 5.1.1` and came from one domain.');
    expect(view(withBounces(10)).steps[0]?.paragraphs[0]).toContain('The 10 logged here read `550 5.1.1`');
    const twelve = view(withBounces(12));
    expect(twelve.steps[0]?.paragraphs[0]).toContain('The 12 logged here read `550 5.1.1` and came from one domain.');
    expect(twelve.tag.evidence).toBe('All 31 hard bounces in the window carry that tag. The 12 in the replay read `550 5.1.1`.');
    expect(twelve.eventLog.note).toBe('Showing the first 12 hard bounces and every decision, call and email.');
  });

  it('drops "only", "each", "shown" and "providers" from step one', () => {
    expect(buildReplayView(artifact).steps[0]?.paragraphs[0]).not.toMatch(/\bonly\b|\beach\b|\bshown\b|\bproviders?\b/);
  });
});

// "The other lanes keep delivering" is derived from the artifact: it is printed only when every open
// lane has a delivery event, and an artifact without one still builds, with no such sentence (WR-11).
describe('the delivery sentence follows the delivery events', () => {
  const artifact = shippedArtifact();
  const domainSentence = 'Permanent bounces arrive on fothering-bulk. The two logged here read `550 5.1.1` and came from two domains.';
  const stepOne = (candidate: ReplayArtifact): string => buildReplayView(candidate).steps[0]?.paragraphs[0] ?? '';
  const withoutDelivery = (lane: string): ReplayArtifact['events'] => artifact.events.filter((event) => !(event.kind === 'delivery' && event.lane === lane));

  it('says the other lanes keep delivering when every open lane delivered', () => {
    expect(stepOne(artifact)).toBe(`${domainSentence} The other lanes keep delivering.`);
  });

  it('says the other lane keeps delivering for one open lane with a delivery', () => {
    expect(stepOne({ ...artifact, lanes: ['fothering-transactional', 'fothering-bulk'] })).toBe(`${domainSentence} The other lane keeps delivering.`);
  });

  it('prints no delivery sentence, and still builds, when one of two open lanes has no delivery', () => {
    expect(stepOne({ ...artifact, events: withoutDelivery('fothering-alerts') })).toBe(domainSentence);
  });

  it('prints no delivery sentence for one open lane with no delivery', () => {
    expect(stepOne({ ...artifact, lanes: ['fothering-transactional', 'fothering-bulk'], events: withoutDelivery('fothering-transactional') })).toBe(domainSentence);
  });

  it('prints no delivery sentence with no open lane', () => {
    expect(stepOne({ ...artifact, lanes: ['fothering-bulk'] })).toBe(domainSentence);
  });
});

describe('the shipped artifact and lanes.json', () => {
  it('lists exactly the lanes.json configuration sets', () => {
    const laneMap = parseLaneMap(JSON.parse(readRepoText('lanes.json', repoRoot(WEB_ROOT))));
    expect(new Set(shippedArtifact().lanes)).toEqual(new Set(laneMap.lanes.map((lane) => lane.configurationSet)));
  });
});

describe('fixtureFindings', () => {
  const shippedText = readFileSync(join(FIXTURES, 'replay-incident.json'), 'utf8');

  it('passes every committed site fixture', () => {
    const files = readdirSync(FIXTURES);
    expect(files.length).toBeGreaterThan(0);
    for (const name of files) expect(fixtureFindings(name, readFileSync(join(FIXTURES, name), 'utf8'))).toEqual([]);
  });

  it('fails a copy holding an address at a domain that is not reserved', () => {
    const planted = shippedText.replace('"Reopen command run by the operator"', '"Reopen command run by ops@acme-mail.net"');
    expect(planted).not.toBe(shippedText);
    expect(fixtureFindings('replay-incident.json', planted)).toEqual([expect.stringMatching(/^replay-incident\.json:\d+: an email address at acme-mail\.net/)]);
  });

  it('fails a copy holding an IP outside the documentation ranges', () => {
    const planted = shippedText.replace('"Delivered, stream receipts"', '"Delivered, stream receipts, from 10.1.2.3"');
    expect(fixtureFindings('replay-incident.json', planted)).toEqual([expect.stringMatching(/^replay-incident\.json:\d+: an IP address outside /)]);
  });

  it('fails a copy holding an IPv6 address outside the documentation range, and passes one inside it', () => {
    for (const address of ['2a00:1450:4001:80b::200e', '2001:db9::1', '::1', 'fe80:0:0:0:0:0:0:1']) {
      const planted = shippedText.replace('"Delivered, stream receipts"', `"Delivered, stream receipts, from ${address}"`);
      expect(fixtureFindings('replay-incident.json', planted), address).toEqual([expect.stringMatching(/^replay-incident\.json:\d+: an IPv6 address outside 2001:db8::\/32$/)]);
    }
    for (const address of ['2001:db8::25', '2001:0DB8:85a3:0000:0000:8a2e:0370:7334', '2001:db8:ffff::']) {
      const planted = shippedText.replace('"Delivered, stream receipts"', `"Delivered, stream receipts, from ${address}"`);
      expect(fixtureFindings('replay-incident.json', planted), address).toEqual([]);
    }
  });

  it('fails a copy holding a 12-digit number', () => {
    const planted = shippedText.replace('"option-7d2e"', '"option-123456789012"');
    expect(fixtureFindings('replay-incident.json', planted)).toEqual([expect.stringMatching(/^replay-incident\.json:\d+: a 12-digit number /)]);
  });

  it('passes the simulator address, the RFC 2606 names, a documentation IP and a manifest account id', () => {
    const allowed = shippedText.replace(
      '"Reopen command run by the operator"',
      '"Sent to bounce@simulator.amazonses.com, ops@mail.example.org, a@b.test and from 192.0.2.10 and 203.0.113.7"',
    );
    expect(fixtureFindings('replay-incident.json', allowed)).toEqual([]);
    const manifest = JSON.stringify(manifestFor(liveArtifact()));
    expect(fixtureFindings('capture-manifest.json', manifest)).toEqual([]);
    expect(fixtureFindings('replay-incident.json', manifest)).toHaveLength(2);
  });

  it('fails a manifest holding a 12-digit number other than its account id', () => {
    const manifest = { ...manifestFor(liveArtifact()), requestIds: ['444455556666'] };
    expect(fixtureFindings('capture-manifest.json', JSON.stringify(manifest))).toEqual([expect.stringMatching(/a 12-digit number/)]);
  });
});
