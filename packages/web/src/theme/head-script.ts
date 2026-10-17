import tokenSource from './tokens.json' with { type: 'json' };

export interface ThemedToken {
  readonly name: string;
  readonly light: string;
  readonly dark: string;
}

export interface StaticToken {
  readonly name: string;
  readonly value: string;
}

export interface TokenSource {
  readonly themed: readonly ThemedToken[];
  readonly static: readonly StaticToken[];
}

export const HEAD_SCRIPT = '';

export function headScriptHash(): string {
  return '';
}

export function parseTokens(raw: unknown): TokenSource {
  return raw as TokenSource;
}

export const TOKENS: TokenSource = parseTokens(tokenSource);

export function themedValue(_tokens: TokenSource, _name: string, _theme: 'light' | 'dark'): string {
  return '';
}

export function renderTokensCss(_tokens: TokenSource = TOKENS): string {
  return '';
}
