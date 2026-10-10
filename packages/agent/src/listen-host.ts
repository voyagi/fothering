// Only the stack that deploys the agent runtime sets FOTHERING_DEPLOYED_RUNTIME, and only to this
// exact value. main.ts listens on every interface when it reads it, as the AgentCore HTTP contract
// requires inside the runtime's microVM, and on loopback in every other case, a local start of the
// bundle included: the owner's exception to the loopback-only rule covers that microVM alone.
// Exact match only, like the live switch: a near miss must never widen what the runtime exposes.
export const AGENTCORE_RUNTIME = 'agentcore';

export function inAgentCoreRuntime(deployedRuntime: string | undefined): boolean {
  return deployedRuntime === AGENTCORE_RUNTIME;
}
