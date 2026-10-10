import { createLogger, type LogSink, type Logger } from '@fothering/core/log';
import { defaultLineSink, resolvePortTable, type ResolvedPorts } from '@fothering/providers/ports';
import type { DryRunSink, KindTable, LiveClients, RuntimeContext } from '@fothering/providers/port-types';

export interface AgentDeps {
  ports: ResolvedPorts;
  kinds: KindTable;
  log: Logger;
}

export interface BuildAgentRootOptions {
  runtimeContext: RuntimeContext;
  switchValue: string | undefined;
  liveClients?: LiveClients;
  dryRunSink?: DryRunSink;
  logSink?: LogSink;
  // Never set: buildAgentRoot passes this whole object to resolvePortTable, which also reads a
  // planted port table (a test seam) that could swap the gated live rows out of a deployed build.
  table?: never;
}

// The agent runtime's one composition root (D-01): plan 01-16's main.ts calls this in 'deployed'
// with readLiveSwitch(), and never imports bedrock-agentcore itself (D-03, wrapped in
// packages/providers/src/live/). It passes no liveConfig: a row needing configuration throws
// LiveConfigMissingError only if a call reaches it, never at resolution.
export function buildAgentRoot(options: BuildAgentRootOptions): AgentDeps {
  const { ports, kinds } = resolvePortTable(options);
  return { ports, kinds, log: createLogger(options.logSink ?? defaultLineSink(options.runtimeContext)) };
}
