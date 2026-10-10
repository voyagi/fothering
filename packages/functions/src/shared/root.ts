import { defaultLineSink } from '@fothering/providers/ports';
import { createLogger, type Logger, type LogSink } from '@fothering/core/log';
import type {
  DryRunSink,
  FixtureOptions,
  LiveClients,
  LiveConfig,
  RuntimeContext,
} from '@fothering/providers/port-types';

// The options every composition root in this package takes. Each root hands the whole object to
// resolvePortTable, which reads the port fields and ignores the rest, and adds only its own fields.
export interface RootOptions {
  runtimeContext: RuntimeContext;
  switchValue: string | undefined;
  liveConfig?: LiveConfig;
  liveClients?: LiveClients;
  fixtures?: FixtureOptions;
  logSink?: LogSink;
  dryRunSink?: DryRunSink;
  now?: () => number;
  // resolvePortTable also reads a planted port table, a seam for tests that call it directly, and a
  // root that passed one on could swap the gated live rows out of a deployed build. Since the whole
  // object is passed on, the type is what keeps it out: an options object holding one fails to build.
  table?: never;
}

// A deployed root writes JSON lines to stdout; a test root writes nowhere, since a test wanting to
// inspect log lines already overrides `log` on its own copy of the deps object it gets back.
export function buildRootLogger(runtimeContext: RuntimeContext, override: LogSink | undefined): Logger {
  return createLogger(override ?? defaultLineSink(runtimeContext));
}
