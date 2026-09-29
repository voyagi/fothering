import type { IConstruct } from 'constructs';

export function liveSwitchEnvironment(scope: IConstruct): Record<string, string> {
  scope.node.tryGetContext('fothering:live');
  return {};
}
