// A deployed function builds its composition root once per container, never per invocation
// (SAFE-01): none of a root's inputs change within a container's lifetime. Written once here so
// every handler's memo reads the same way instead of restating its own `let cached` guard.
export function memoPerContainer<T>(build: () => T): () => T {
  let cached: T | undefined;
  return () => {
    if (cached === undefined) cached = build();
    return cached;
  };
}
