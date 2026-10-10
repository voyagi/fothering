// The one memoized construction path every live adapter shares (SAFE-01): a composition root
// resolves the whole port table before any request arrives, so building the real AWS client here
// would mean every deployed cold start pays for clients the invocation may never call. Wrapping
// `create` behind a getter defers that cost to the first port method that actually runs, and the
// cached instance means a busy container builds each client exactly once.
export function lazyClient<T>(create: () => T): () => T {
  let cached: { value: T } | undefined;
  return () => {
    cached ??= { value: create() };
    return cached.value;
  };
}
