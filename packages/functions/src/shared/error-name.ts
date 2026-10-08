// A log line names a failure by its error's name only, never its message, which may carry an
// address or other free text. A thrown value that is not an Error is named Error.
export function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'Error';
}
