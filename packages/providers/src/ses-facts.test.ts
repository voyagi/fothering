import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkCloseability, observeLanes, type CloseabilityResult } from '@fothering/core/closeability';
import { parseLaneMap, type LaneMap } from '@fothering/core/lanes';
import type { EventRecord } from '@fothering/core/records';
import { BASE_BUCKET_MS, ONE_HOUR_MS, deliveredMessage } from '@fothering/core/test/closeability-records';
import { createDryRunLog } from './dry-run.js';
import { createFixtureAddressKey } from './fixtures/ingest-ports.js';
import { createFixtureSes } from './fixtures/later-ports.js';
import { FixtureMissError } from './fixtures/recorded.js';
import type { SesConfigurationFacts } from '@fothering/core/closeability';
import type { IdentityAuthFacts } from '@fothering/core/evidence-rows';
import type { EmailIdentityFacts, EventDestinationFact, Recording, SesPort, SesReadPort } from './port-types.js';
import { MAX_IDENTITY_READS, SES_READ_SPACING_MS, readSesFacts, type ReadSesFactsOptions } from './ses-facts.js';
import lanesJson from '../../../lanes.json' with { type: 'json' };

const LANE_MAP = parseLaneMap(lanesJson);
const BULK = 'fothering-bulk';
const LANE_SETS = ['fothering-transactional', 'fothering-bulk', 'fothering-alerts'];

function loadRecordings(name: 'complete' | 'gaps'): Recording[] {
  const raw = readFileSync(new URL(`./fixtures/ses-config/${name}.json`, import.meta.url), 'utf8');
  return (JSON.parse(raw) as { recordings: Recording[] }).recordings;
}

function fixtureSes(recordings: readonly Recording[], lines: string[] = []): SesPort {
  const dryRun = createDryRunLog({ sink: (line) => lines.push(line), addressKey: createFixtureAddressKey(), now: () => 1_000 });
  return createFixtureSes({ recordings, dryRun });
}

const NO_WAIT = async (): Promise<void> => {};

interface ReadFacts {
  facts: SesConfigurationFacts;
  identities: IdentityAuthFacts[];
}

async function readWithinBound(ses: SesReadPort, laneMap: LaneMap = LANE_MAP, options: ReadSesFactsOptions = { wait: NO_WAIT }): Promise<ReadFacts> {
  const result = await readSesFacts(ses, laneMap, options);
  if (!result.ok) throw new Error(`expected facts, got ${result.reason}`);
  return result;
}

function bulkRecords(): EventRecord[] {
  return deliveredMessage({
    configurationSet: BULK,
    bucketStartMs: BASE_BUCKET_MS,
    identity: 'bulk-message',
    fields: { streamTagValue: 'newsletter', callerIdentity: 'bulk-sender' },
  });
}

async function closeabilityOfBulk(recordings: readonly Recording[]): Promise<CloseabilityResult> {
  const ses = (await readWithinBound(fixtureSes(recordings))).facts;
  const observed = observeLanes(bulkRecords(), {
    laneMap: LANE_MAP,
    windowStartMs: BASE_BUCKET_MS - ONE_HOUR_MS,
    nowMs: BASE_BUCKET_MS + ONE_HOUR_MS,
  });
  return checkCloseability(BULK, { laneMap: LANE_MAP, observed, ses });
}

describe('readSesFacts on recorded fixtures', () => {
  it('reads the set list, every identity default and every lane-map set destination list', async () => {
    const { facts } = await readWithinBound(fixtureSes(loadRecordings('complete')));
    expect(facts.configurationSets).toEqual(new Set(LANE_SETS));
    expect(facts.defaultConfigurationSets).toEqual(new Set(['fothering-default']));
    expect([...facts.eventDestinations.keys()].sort()).toEqual([...LANE_SETS].sort());
    expect(facts.eventDestinations.get(BULK)?.[0]?.matchingEventTypes).toContain('DELIVERY_DELAY');
  });

  // D-59: the closeability default and the authentication facts come from the same read.
  it("returns each identity's DKIM and MAIL FROM facts beside the closeability facts, in core's IdentityAuthFacts shape", async () => {
    const { identities } = await readWithinBound(fixtureSes(loadRecordings('gaps')));
    expect(JSON.stringify(identities.map((facts) => facts.identity))).toBe('["example.com","example.org"]');
    expect(identities[1]).toEqual({
      identity: 'example.org',
      dkimStatus: 'FAILED',
      dkimSigningEnabled: true,
      mailFromDomain: 'bounce.example.org',
      mailFromStatus: 'FAILED',
      identityType: 'DOMAIN',
    });
    expect(identities[0]?.defaultConfigurationSet).toBe('fothering-bulk');
  });

  it('leaves an identity SES no longer holds out of the identity facts and the default sets', async () => {
    const gone = (recording: Recording): boolean => recording.operation === 'ses.getEmailIdentity' && recording.request === 'example.com';
    const recordings = loadRecordings('complete').map((recording) => (gone(recording) ? { ...recording, response: undefined } : recording));
    const { facts, identities } = await readWithinBound(fixtureSes(recordings));
    expect(JSON.stringify(identities.map((entry) => entry.identity))).toBe('["example.org"]');
    expect(facts.defaultConfigurationSets.size).toBe(0);
  });

  it('finds the bulk set closeable when no identity defaults to a lane set and its destination covers all six types', async () => {
    expect((await closeabilityOfBulk(loadRecordings('complete'))).state).toBe('closeable');
  });

  it('refuses the bulk set for an identity default and a destination missing DELIVERY_DELAY', async () => {
    const result = await closeabilityOfBulk(loadRecordings('gaps'));
    expect(result).toEqual({ state: 'refused', reasons: ['default-configuration-set', 'destination-missing-event-types'] });
  });

  // Events from a set lanes.json does not list are dropped before storage, so a caller shared with
  // it is invisible to the check; SES's own set list is what shows the set exists.
  it('refuses the bulk set when SES holds a configuration set lanes.json does not list', async () => {
    const recordings = loadRecordings('complete').map((recording) =>
      recording.operation === 'ses.listConfigurationSets'
        ? { ...recording, response: [...LANE_SETS, 'a-set-nobody-declared'] }
        : recording,
    );
    expect(await closeabilityOfBulk(recordings)).toEqual({ state: 'refused', reasons: ['unlisted-configuration-set'] });
  });

  it.each(loadRecordings('complete').map((recording, index) => ({ index, label: `${index + 1} (${JSON.stringify(recording.request)})` })))(
    'rejects with FixtureMissError, never a default answer, when recording $label is missing',
    async ({ index }) => {
      const recordings = loadRecordings('complete').filter((_recording, position) => position !== index);
      await expect(readSesFacts(fixtureSes(recordings), LANE_MAP, { wait: NO_WAIT })).rejects.toThrow(FixtureMissError);
    },
  );

  it('reaches no pause, reopen or send: the fixture writes no dry-run line', async () => {
    const lines: string[] = [];
    await readWithinBound(fixtureSes(loadRecordings('complete'), lines));
    expect(lines).toEqual([]);
  });
});

interface SpyPort {
  port: SesReadPort;
  events: string[];
  maxInFlight: () => number;
}

function spyPort(identities: string[]): SpyPort {
  const events: string[] = [];
  let inFlight = 0;
  let peak = 0;
  async function tracked<T>(label: string, value: T): Promise<T> {
    events.push(label);
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await Promise.resolve();
    inFlight -= 1;
    return value;
  }
  return {
    events,
    maxInFlight: () => peak,
    port: {
      listEmailIdentities: () => tracked('list', identities),
      listConfigurationSets: () => tracked('sets', [...LANE_SETS]),
      getEmailIdentity: (identity) => tracked<EmailIdentityFacts>(`identity ${identity}`, { dkimStatus: 'SUCCESS' }),
      getConfigurationSetEventDestinations: (configurationSet) => tracked(`destinations ${configurationSet}`, [] as EventDestinationFact[]),
    },
  };
}

describe('the SES read quota of one request per second', () => {
  it('reads each list once, each identity once and each lane set once, one at a time, waiting a second before every read after the first', async () => {
    const spy = spyPort(['example.com', 'example.org', 'example.com']);
    const wait = vi.fn(async (ms: number) => {
      spy.events.push(`wait ${ms}`);
    });

    await readSesFacts(spy.port, LANE_MAP, { wait });

    expect(SES_READ_SPACING_MS).toBe(1_000);
    const spacer = 'wait 1000';
    expect(spy.events).toEqual([
      'list',
      spacer,
      'sets',
      spacer,
      'identity example.com',
      spacer,
      'identity example.org',
      spacer,
      ...LANE_SETS.flatMap((set) => [`destinations ${set}`, spacer]).slice(0, -1),
    ]);
    expect(spy.maxInFlight()).toBe(1);
  });

  it('uses a real one second timer between reads when no wait is given', async () => {
    vi.useFakeTimers();
    const spy = spyPort(['example.com']);
    const bulkOnly: LaneMap = { ...LANE_MAP, lanes: LANE_MAP.lanes.filter((lane) => lane.configurationSet === BULK) };

    const pending = readSesFacts(spy.port, bulkOnly);
    await vi.advanceTimersByTimeAsync(0);
    expect(spy.events).toEqual(['list']);
    await vi.advanceTimersByTimeAsync(SES_READ_SPACING_MS - 1);
    expect(spy.events).toEqual(['list']);
    await vi.advanceTimersByTimeAsync(1);
    expect(spy.events).toEqual(['list', 'sets']);
    await vi.advanceTimersByTimeAsync(SES_READ_SPACING_MS);
    expect(spy.events).toEqual(['list', 'sets', 'identity example.com']);
    await vi.advanceTimersByTimeAsync(SES_READ_SPACING_MS);
    expect(spy.events).toEqual(['list', 'sets', 'identity example.com', `destinations ${BULK}`]);
    await pending;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // AC-E23: the injected wait stands in for the clock, so each read's time is the sum of the waits before it.
  it('starts every read, GetEmailIdentity included, at least 1,000 ms after the read before it', async () => {
    const spy = spyPort(['example.com', 'example.org', 'example.net']);
    let clockMs = 0;
    const readTimes: number[] = [];
    function at<T>(read: () => Promise<T>): Promise<T> {
      readTimes.push(clockMs);
      return read();
    }
    const timed: SesReadPort = {
      listEmailIdentities: () => at(() => spy.port.listEmailIdentities()),
      listConfigurationSets: () => at(() => spy.port.listConfigurationSets()),
      getEmailIdentity: (identity) => at(() => spy.port.getEmailIdentity(identity)),
      getConfigurationSetEventDestinations: (set) => at(() => spy.port.getConfigurationSetEventDestinations(set)),
    };

    await readWithinBound(timed, LANE_MAP, {
      wait: async (ms) => {
        clockMs += ms;
      },
    });

    const gaps = readTimes.slice(1).map((time, index) => time - (readTimes[index] ?? 0));
    expect(`${readTimes.length} reads, smallest gap ${Math.min(...gaps)}`).toBe(`${2 + 3 + LANE_SETS.length} reads, smallest gap 1000`);
    expect(spy.events.filter((event) => event.startsWith('identity ')).length).toBe(3);
  });
});

function identityNames(count: number): string[] {
  return Array.from({ length: count }, (_unused, index) => `sender-${index}.example.com`);
}

describe('the identity read bound (D-59, AC-E22)', () => {
  it('is 50 identities: 50 reads at one a second fit inside the 300 s detection timeout', () => {
    expect(MAX_IDENTITY_READS).toBe(50);
  });

  it('reads an account of exactly 50 identities whole, one GetEmailIdentity per identity', async () => {
    const spy = spyPort(identityNames(MAX_IDENTITY_READS));
    const { identities } = await readWithinBound(spy.port);
    expect(spy.events.filter((event) => event.startsWith('identity ')).length).toBe(50);
    expect(identities.length).toBe(50);
  });

  it('answers ses-facts-bound for 51 identities after the list read alone, with no identity read and no partial facts', async () => {
    const spy = spyPort(identityNames(MAX_IDENTITY_READS + 1));
    const result = await readSesFacts(spy.port, LANE_MAP, { wait: NO_WAIT });
    expect(result.ok ? 'facts' : result.reason).toBe('ses-facts-bound');
    expect(result).toEqual({ ok: false, reason: 'ses-facts-bound', identityCount: 51 });
    expect(spy.events.join(' ')).toBe('list');
  });

  it('takes the bound from maxIdentityReads when a caller passes one', async () => {
    const atBound = await readSesFacts(spyPort(identityNames(2)).port, LANE_MAP, { wait: NO_WAIT, maxIdentityReads: 2 });
    const pastBound = await readSesFacts(spyPort(identityNames(3)).port, LANE_MAP, { wait: NO_WAIT, maxIdentityReads: 2 });
    expect(`${atBound.ok} ${pastBound.ok}`).toBe('true false');
  });
});
