import { BedrockAgentCoreApp } from 'bedrock-agentcore/runtime';

export interface StartNoModelRuntimeOptions {
  port: number;
  host: string;
}

// D-03: this is the only module in the tree that imports bedrock-agentcore, and only through the
// runtime subpath (the package root points at a file 0.4.4 does not ship). No model, no AWS
// client: the invocation handler returns a fixed body and BedrockAgentCoreApp owns /ping's
// status and time_of_last_update, which is why no custom pingHandler is passed here.
export function startNoModelRuntime(options: StartNoModelRuntimeOptions): void {
  const app = new BedrockAgentCoreApp({
    invocationHandler: {
      process: () => ({ status: 'no-model', model: 'none' }),
    },
  });
  app.run({ port: options.port, host: options.host });
}
