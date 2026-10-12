import { canonicalJson } from '@fothering/core/evidence-record';
import type { Recording } from '../port-types.js';

// Recordings are keyed through the same canonical JSON as the evidence hash (D-69), so two requests
// built in a different property order name the same recording.
export { canonicalJson };

// The message names the operation and nothing of the request: a request can carry an address or a
// sentence, and this message lands in a test report or a log.
export class FixtureMissError extends Error {
  readonly operation: string;

  constructor(operation: string) {
    super(`no recording answers ${operation}`);
    this.name = 'FixtureMissError';
    this.operation = operation;
  }
}

export interface RecordedPort {
  respond<T>(operation: string, request: unknown): T;
}

function answerKey(operation: string, request: unknown): string {
  return `${operation}\u0000${canonicalJson(request)}`;
}

// A request with no recording throws rather than returning a default, so a test cannot pass on a
// response nobody recorded (D-26). Answers come back as copies: a caller mutating one cannot
// change what the next identical call sees.
export function recordedPort(recordings: readonly Recording[]): RecordedPort {
  const answers = new Map<string, unknown>();
  for (const recording of recordings) {
    const key = answerKey(recording.operation, recording.request);
    if (answers.has(key)) throw new Error(`two recordings answer the same ${recording.operation} request`);
    answers.set(key, recording.response);
  }

  return {
    respond<T>(operation: string, request: unknown): T {
      const key = answerKey(operation, request);
      if (!answers.has(key)) throw new FixtureMissError(operation);
      return structuredClone(answers.get(key)) as T;
    },
  };
}
