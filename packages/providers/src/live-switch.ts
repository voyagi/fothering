// D-04: this is the one literal `process.env.FOTHERING_LIVE` read in the tree. Every deployable's
// composition root calls this once at cold start and hands the value down from there, so gate:env
// sees exactly one place that demands the variable and nothing else reads it directly.
export function readLiveSwitch(): string | undefined {
  return process.env.FOTHERING_LIVE;
}
