import type { IConstruct } from 'constructs';
import { LIVE_SWITCH } from '@fothering/core/mode';

// The only path from a deploy to the live switch on a deployed function or the runtime: the CDK
// context key, and only its exact value. A shell variable, a boolean in cdk.json or a near miss
// such as "LIVE" or "true" gives the deployed code no switch at all, which reads as the unset case.
export function liveSwitchEnvironment(scope: IConstruct): Record<string, string> {
  return scope.node.tryGetContext('fothering:live') === 'live' ? { [LIVE_SWITCH]: 'live' } : {};
}
