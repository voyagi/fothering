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
import type { EventDestinationFact, Recording, SesPort, SesReadPort } from './port-types.js';
import { SES_READ_SPACING_MS, readSesFacts } from './ses-facts.js';
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

function bulkRecords(): EventRecord[] {
  return deliveredMessage({
    configurationSet: BULK,
    bucketStartMs: BASE_BUCKET_MS,
    identity: 'bulk-message',
    fields: { streamTagValue: 'newsletter', callerIdentity: 'bulk-sender' },
  });
}

async function closeabilityOfBulk(recordings: readonly Recording[]): Promise<CloseabilityResult> {
  const ses = await readSesFacts(fixtureSes(recordings), LANE_MAP, { wait: NO_WAIT });
  const observed = observeLanes(bulkRecords(), {
    laneMap: LANE_MAP,
    windowStartMs: BASE_BUCKET_MS - ONE_HOUR_MS,
    nowMs: BASE_BUCKET_MS + ONE_HOUR_MS,
  });
  return checkCloseability(BULK, { laneMap: LANE_MAP, observed, ses });
}

describe('readSesFacts on recorded fixtures', () => {
  it('reads every identity default and every lane-map set destination list', async () => {
    const facts = await readSesFacts(fixtureSes(loadRecordings('complete')), LANE_MAP, { wait: NO_WAIT });
    expect(facts.defaultConfigurationSets).toEqual(new Set(['fothering-default']));
    expect([...facts.eventDestinations.keys()].sort()).toEqual([...LANE_SETS].sort());
    expect(facts.eventDestinations.get(BULK)?.[0]?.matchingEventTypes).toContain('DELIVERY_DELAY');
  });

  it('finds the bulk set closeable when no identity defaults to a lane set and its destination covers all six types', async () => {
    expect((await closeabilityOfBulk(loadRecordings('complete'))).state).toBe('closeable');
  });

  it('refuses the bulk set for an identity default and a destination missing DELIVERY_DELAY', async () => {
    const result = await closeabilityOfBulk(loadRecordings('gaps'));
    expect(result).toEqual({ state: 'refused', reasons: ['default-configuration-set', 'destination-missing-event-types'] });
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
    await readSesFacts(fixtureSes(loadRecordings('complete'), lines), LANE_MAP, { wait: NO_WAIT });
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
      getEmailIdentity: (identity) => tracked(`identity ${identity}`, undefined),
      getConfigurationSetEventDestinations: (configurationSet) => tracked(`destinations ${configurationSet}`, [] as EventDestinationFact[]),
    },
  };
}

describe('the SES read quota of one request per second', () => {
  it('reads the list once, each identity once and each lane set once, one at a time, waiting a second before every read after the first', async () => {
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
    expect(spy.events).toEqual(['list', 'identity example.com']);
    await vi.advanceTimersByTimeAsync(SES_READ_SPACING_MS);
    expect(spy.events).toEqual(['list', 'identity example.com', `destinations ${BULK}`]);
    await pending;
  });

  afterEach(() => {
    vi.useRealTimers();
  });
});
