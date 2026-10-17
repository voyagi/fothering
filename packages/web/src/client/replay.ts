export type StepNumber = 1 | 2 | 3 | 4;

export interface ReplayDeps {
  readonly document: Document;
  readonly window: Window;
  readonly location: Location;
  readonly history: History;
}

export function parseStep(_hash: string): StepNumber {
  return 1;
}

export function initReplay(_deps: ReplayDeps): void {}
