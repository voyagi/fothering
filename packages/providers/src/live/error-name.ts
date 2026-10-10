// An AWS SDK service error carries its exception type as its name, so a refusal an adapter answers
// itself (a failed condition, a missing resource) is told apart from every other failure by name.
export function hasErrorName(error: unknown, name: string): boolean {
  return error instanceof Error && error.name === name;
}
