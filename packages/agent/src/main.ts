// First, so the SDK logger is silenced (handler.ts, D-73) before any other module can log through it.
import { createInvocationHandler } from './handler.js';
import { readLiveSwitch } from '@fothering/providers/live-switch';
import { startAgentRuntime } from '@fothering/providers/live/agent-runtime-server';
import { inAgentCoreRuntime } from './listen-host.js';
import { buildAgentRoot } from './root.js';

const PORT_FLAG = '--port';
const LOCAL_HOST = '127.0.0.1';
const DEPLOYED_PORT = 8080;
const DEPLOYED_HOST = '0.0.0.0';
const DIGITS_ONLY = /^\d+$/;

function flagValue(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

// The override exists only for the local runtime test: the AgentCore HTTP contract fixes the port.
function resolvePort(args: readonly string[]): number {
  const value = flagValue(args, PORT_FLAG);
  return value !== undefined && DIGITS_ONLY.test(value) ? Number(value) : DEPLOYED_PORT;
}

// Every interface only when the deploying stack says this is the AgentCore microVM (listen-host.ts
// says why); loopback for every other run, a local start of the bundle included.
function resolveHost(deployedRuntime: string | undefined): string {
  return inAgentCoreRuntime(deployedRuntime) ? DEPLOYED_HOST : LOCAL_HOST;
}

const args = process.argv.slice(2);

// AGT-11, D-03: buildAgentRoot builds no AWS client here (plan 01-03's lazy adapters), and
// startAgentRuntime is the only bedrock-agentcore import in the tree, reached through the
// providers wrapper, never the package root. The root is built once, before the runtime listens, so
// a malformed port table fails the start instead of the first invocation.
const deps = buildAgentRoot({ runtimeContext: 'deployed', switchValue: readLiveSwitch() });
startAgentRuntime({
  port: resolvePort(args),
  host: resolveHost(process.env.FOTHERING_DEPLOYED_RUNTIME),
  handler: createInvocationHandler(deps),
});
