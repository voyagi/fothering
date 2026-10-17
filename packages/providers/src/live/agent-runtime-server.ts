import { BedrockAgentCoreApp } from 'bedrock-agentcore/runtime';

export interface StartAgentRuntimeOptions {
  port: number;
  host: string;
  /** The agent's invocation handler: it takes the request body and returns the runtime result. */
  handler: (payload: unknown) => Promise<unknown>;
}

// D-03: this is the only module in the tree that imports bedrock-agentcore, and only through the
// runtime subpath (the package root points at a file 0.4.4 does not ship). BedrockAgentCoreApp owns
// /ping's status and time_of_last_update, which is why no custom pingHandler is passed here. The
// handler checks the body itself (D-72), so no requestSchema is set, and the request context with its
// logger is not passed on: nothing an invocation holds goes to the request log.
export function startAgentRuntime(options: StartAgentRuntimeOptions): void {
  const app = new BedrockAgentCoreApp({
    invocationHandler: {
      process: (request: unknown) => options.handler(request),
    },
  });
  app.run({ port: options.port, host: options.host });
}
