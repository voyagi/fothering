import { readLiveSwitch } from '@fothering/providers/live-switch';
import { startNoModelRuntime } from '@fothering/providers/live/agent-runtime-server';
import { buildAgentRoot } from './root.js';

const PORT_FLAG = '--port';
const HOST_FLAG = '--host';
const LOCAL_HOST = '127.0.0.1';
const DEPLOYED_PORT = 8080;
const DEPLOYED_HOST = '0.0.0.0';
const DIGITS_ONLY = /^\d+$/;

function flagValue(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

// Overrides exist only for the local runtime test: the AgentCore HTTP contract fixes the port and
// the deployed host inside the microVM, so any value other than the exact local pair falls back
// to those (T-01-44: accepted, required by the platform contract, never reachable from a test).
function resolvePort(args: readonly string[]): number {
  const value = flagValue(args, PORT_FLAG);
  return value !== undefined && DIGITS_ONLY.test(value) ? Number(value) : DEPLOYED_PORT;
}

function resolveHost(args: readonly string[]): string {
  const value = flagValue(args, HOST_FLAG);
  return value === LOCAL_HOST ? value : DEPLOYED_HOST;
}

const args = process.argv.slice(2);

// AGT-11, D-03: buildAgentRoot builds no AWS client here (plan 01-03's lazy adapters), and
// startNoModelRuntime is the only bedrock-agentcore import in the tree, reached through the
// providers wrapper, never the package root.
buildAgentRoot({ runtimeContext: 'deployed', switchValue: readLiveSwitch() });
startNoModelRuntime({ port: resolvePort(args), host: resolveHost(args) });
