import { describe, expect, it } from 'vitest';
import { bucketStartMs, countRecords } from '@fothering/core/buckets';
import { parseSesEvent } from '@fothering/core/ses-events';
import { createLogger, type LogEntry, type LogSink } from '@fothering/core/log';
import { DOC_EXAMPLE_LANE_MAP, loadSesEventFixture } from '@fothering/providers/fixtures/ses-events/index';
import {
  createFixtureAddressKey,
  createFixtureDeadLetter,
  createFixtureEventStore,
} from '@fothering/providers/fixtures/ingest-ports';
import { PORT_TABLE, resolvePortTable, type PortName, type PortRow } from '@fothering/providers/ports';
import {
  NotBuiltError,
  type DryRunSink,
  type KindTable,
  type LiveClients,
  type LiveConfig,
  type ResolvedKind,
  type RuntimeContext,
  type SendClient,
} from '@fothering/providers/port-types';
import { buildIngestRoot, type IngestDeps } from './root.js';
import { ingestEvent, type IngestResult } from './ingest.js';

const ONE_HOUR_MS = 60 * 60 * 1000;

function fixtureConfigurationSet(): string {
  const parsed = parseSesEvent(loadSesEventFixture('bounce').event);
  if (!parsed.ok) throw new Error('fixture bounce event failed to parse');
  const configurationSet = parsed.event.detail.mail.tags['ses:configuration-set']?.[0];
  if (configurationSet === undefined) throw new Error('fixture bounce event carries no configuration-set tag');
  return configurationSet;
}

function fixtureMailTimestampMs(): number {
  const parsed = parseSesEvent(loadSesEventFixture('bounce').event);
  if (!parsed.ok) throw new Error('fixture bounce event failed to parse');
  return Date.parse(parsed.event.detail.mail.timestamp);
}

describe('the doc-derived Bounce through the ingest composition root', () => {
  it('stores the Bounce once and counts it in its send-time bucket', async () => {
    const nowMs = fixtureMailTimestampMs() + ONE_HOUR_MS;
    const deps: IngestDeps = buildIngestRoot({
      runtimeContext: 'test',
      switchValue: undefined,
      laneMap: DOC_EXAMPLE_LANE_MAP,
      now: () => nowMs,
    });

    const result: IngestResult = await ingestEvent(loadSesEventFixture('bounce').event, deps, { provenance: 'doc-derived' });
    expect(result).toEqual({ outcome: 'stored', stored: 1, duplicates: 0 });

    const configurationSet = fixtureConfigurationSet();
    const bucket = bucketStartMs(fixtureMailTimestampMs());
    const stored = await deps.ports.eventStore.queryLane(configurationSet, bucket, bucket, deps.now());
    expect(countRecords(stored).Bounce).toBe(1);
  });

  it('absorbs a second delivery of the same envelope as a duplicate', async () => {
    const nowMs = fixtureMailTimestampMs() + ONE_HOUR_MS;
    const deps = buildIngestRoot({
      runtimeContext: 'test',
      switchValue: undefined,
      laneMap: DOC_EXAMPLE_LANE_MAP,
      now: () => nowMs,
    });
    const event = loadSesEventFixture('bounce').event;

    await ingestEvent(event, deps, { provenance: 'doc-derived' });
    const second = await ingestEvent(event, deps, { provenance: 'doc-derived' });
    expect(second).toEqual({ outcome: 'stored', stored: 0, duplicates: 1 });

    const configurationSet = fixtureConfigurationSet();
    const bucket = bucketStartMs(fixtureMailTimestampMs());
    const stored = await deps.ports.eventStore.queryLane(configurationSet, bucket, bucket, deps.now());
    expect(stored).toHaveLength(1);
  });

  it('drops an event with no configuration-set tag and logs its message id only', async () => {
    const deps = buildIngestRoot({ runtimeContext: 'test', switchValue: undefined, laneMap: DOC_EXAMPLE_LANE_MAP });
    const raw = structuredClone(loadSesEventFixture('bounce').event) as {
      detail: { mail: { tags: Record<string, string[]> } };
    };
    delete raw.detail.mail.tags['ses:configuration-set'];
    const lines: string[] = [];
    const loggedDeps: IngestDeps = { ...deps, log: createLogger((line) => lines.push(line)) };

    const result = await ingestEvent(raw, loggedDeps, { provenance: 'doc-derived' });

    expect(result).toEqual({ outcome: 'dropped', stored: 0, duplicates: 0 });
    expect(JSON.parse(lines[0] ?? '{}')).toMatchObject({ event: 'dropped-unmapped' });
  });

  it('drops an unparseable event and logs it dropped-unparseable, keeping only a readable message id', async () => {
    const deps = buildIngestRoot({ runtimeContext: 'test', switchValue: undefined, laneMap: DOC_EXAMPLE_LANE_MAP });
    const lines: string[] = [];
    const loggedDeps: IngestDeps = { ...deps, log: createLogger((line) => lines.push(line)) };

    const result = await ingestEvent({ detail: { mail: { messageId: 'm-1' } } }, loggedDeps, { provenance: 'doc-derived' });

    expect(result).toEqual({ outcome: 'dropped', stored: 0, duplicates: 0 });
    expect(JSON.parse(lines[0] ?? '{}')).toEqual({ event: 'dropped-unparseable', messageId: 'm-1' });
  });
});

describe('resolvePortTable in runtimeContext test', () => {
  it.each([undefined, '', 'true', 'LIVE', ' live', 'live'])(
    'resolves every port operation to fixture for switch %j',
    (switchValue) => {
      const { kinds } = resolvePortTable({ runtimeContext: 'test', switchValue });
      for (const row of Object.values(kinds)) {
        for (const kind of Object.values(row)) {
          expect(kind).toBe('fixture');
        }
      }
    },
  );
});

describe('resolvePortTable in runtimeContext deployed with a not-built table', () => {
  function plantedNotBuiltTable(): Record<PortName, PortRow> {
    return {
      eventStore: {
        operations: ['putIfAbsent', 'queryLane', 'queryByRecipient', 'deleteRecord', 'getRecord'],
        mutatingOperations: ['putIfAbsent', 'deleteRecord'],
        fixture: () => createFixtureEventStore(),
        live: { notBuiltUntil: 1 },
      },
      addressKey: {
        operations: ['getKeySet'],
        mutatingOperations: [],
        fixture: () => createFixtureAddressKey(),
        live: { notBuiltUntil: 1 },
      },
      deadLetter: {
        operations: ['send'],
        mutatingOperations: ['send'],
        fixture: () => createFixtureDeadLetter(),
        live: { notBuiltUntil: 1 },
      },
    };
  }

  it('reports not-built-until-phase-1 for every operation and rejects with a named NotBuiltError', async () => {
    const { ports, kinds } = resolvePortTable({
      runtimeContext: 'deployed',
      switchValue: undefined,
      table: plantedNotBuiltTable(),
    });
    for (const row of Object.values(kinds)) {
      for (const kind of Object.values(row)) {
        expect(kind).toBe('not-built-until-phase-1');
      }
    }
    await expect(ports.eventStore.putIfAbsent({} as never)).rejects.toThrow(NotBuiltError);
    await expect(ports.eventStore.putIfAbsent({} as never)).rejects.toThrow('phase 1');
  });
});

describe('buildIngestRoot laneMap defaults', () => {
  it('defaults to the committed lanes.json when no laneMap is given in test', () => {
    const deps = buildIngestRoot({ runtimeContext: 'test', switchValue: undefined });
    expect(deps.laneMap.lanes.map((entry) => entry.lane).sort()).toEqual([
      'fothering-alerts',
      'fothering-bulk',
      'fothering-transactional',
    ]);
  });

  it('refuses a laneMap override outside runtimeContext test', () => {
    expect(() =>
      buildIngestRoot({ runtimeContext: 'deployed', switchValue: undefined, laneMap: DOC_EXAMPLE_LANE_MAP }),
    ).toThrow('runtimeContext test');
  });
});

describe('the port table type contract', () => {
  it('names exactly the three phase 1 ports', () => {
    expect(Object.keys(PORT_TABLE).sort()).toEqual(['addressKey', 'deadLetter', 'eventStore']);
  });

  it('is exactly Record<PortName, PortRow>, so a table missing a row is a type error', () => {
    // @ts-expect-error a table missing the deadLetter row must fail gate:types
    const missingRow: Record<PortName, PortRow> = {
      eventStore: PORT_TABLE.eventStore,
      addressKey: PORT_TABLE.addressKey,
    };
    expect(Object.keys(missingRow).sort()).toEqual(['addressKey', 'eventStore']);
  });
});

describe('createLogger keeps free text out of every line', () => {
  it('drops any key outside the allowed set and downgrades an invalid value to unclassified', () => {
    const lines: string[] = [];
    const logger = createLogger((line) => lines.push(line));
    const hostileEntry = {
      event: 'dropped-unparseable',
      messageId: 'jane@example.com',
      errorName: 'a full sentence is not a name',
      field: 'a field with spaces in it',
      count: -1,
      recipient: 'jane@example.com',
    } as unknown as LogEntry;

    logger.info(hostileEntry);

    expect(JSON.parse(lines[0] ?? '{}')).toEqual({
      event: 'dropped-unparseable',
      messageId: 'unclassified',
      errorName: 'unclassified',
      field: 'unclassified',
    });
  });

  it('keeps a valid messageId, errorName, field and count as given', () => {
    const lines: string[] = [];
    const logger = createLogger((line) => lines.push(line));

    logger.error({ event: 'ingest-failure', messageId: 'abc-123', errorName: 'TypeError', field: 'detail.mail.tags', count: 3 });

    expect(JSON.parse(lines[0] ?? '{}')).toEqual({
      event: 'ingest-failure',
      messageId: 'abc-123',
      errorName: 'TypeError',
      field: 'detail.mail.tags',
      count: 3,
    });
  });
});

describe('provider contract types stay referenced for later plans', () => {
  it('type-checks a minimal SendClient implementation', async () => {
    const client: SendClient = { send: async (command) => command };
    await expect(client.send('ping')).resolves.toBe('ping');
  });

  it('type-checks the runtime context, resolved kind, kind table, live config and sink shapes', () => {
    const context: RuntimeContext = 'test';
    const kind: ResolvedKind = 'fixture';
    const liveClients: LiveClients = {};
    const liveConfig: LiveConfig = {};
    const dryRunSink: DryRunSink = () => {};
    const sink: LogSink = () => {};
    const kinds: KindTable = resolvePortTable({ runtimeContext: 'test', switchValue: undefined }).kinds;

    expect(context).toBe('test');
    expect(kind).toBe('fixture');
    expect(liveClients).toEqual({});
    expect(liveConfig).toEqual({});
    expect(typeof dryRunSink).toBe('function');
    expect(typeof sink).toBe('function');
    expect(kinds.eventStore?.putIfAbsent).toBe('fixture');
  });
});
