export const THEME_CHOICES = ['device', 'light', 'dark'] as const;
export const FLOW_CHOICES = ['stopped', 'running'] as const;

export interface ChromeDeps {
  readonly document: Document;
  readonly window: Window;
  readonly storage: () => Storage;
}

export function known<T extends string>(_value: unknown, _choices: readonly T[]): T | null {
  return null;
}

export function initThemeSwitch(_deps: ChromeDeps): void {}

export function initFlowSwitch(_deps: ChromeDeps): void {}
