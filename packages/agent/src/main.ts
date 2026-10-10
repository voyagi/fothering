import { readLiveSwitch } from '@fothering/providers/live-switch';
import { startNoModelRuntime } from '@fothering/providers/live/agent-runtime-server';
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
// startNoModelRuntime is the only bedrock-agentcore import in the tree, reached through the
// providers wrapper, never the package root.
// The root is built only to fail fast: a malformed port table throws here, before the runtime
// listens. The no-model handler reads no port, so its deps are not passed on yet.
buildAgentRoot({ runtimeContext: 'deployed', switchValue: readLiveSwitch() });
startNoModelRuntime({ port: resolvePort(args), host: resolveHost(process.env.FOTHERING_DEPLOYED_RUNTIME) });
