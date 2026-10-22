import { createHash } from 'node:crypto';
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

// ES5 on purpose, and one line with no backslash: it runs before every stylesheet, on any engine,
// and its exact text is hashed into the CSP. The storage read sits in its own try/catch, so a
// throwing getter or getItem leaves Device and still lets the step apply. The hash is read as a
// closed set and only the matched digit is written.
export const HEAD_SCRIPT = [
  '(function () {',
  'var root = document.documentElement;',
  "root.classList.add('js');",
  'function read(key) { try { return window.localStorage.getItem(key); } catch (e) { return null; } }',
  'function known(value, choices) { return choices.indexOf(value) >= 0 ? value : null; }',
  "var theme = known(read('fothering-theme'), ['light', 'dark']);",
  "if (theme) root.setAttribute('data-theme', theme);",
  'var step = /^#step-([1-4])$/.exec(location.hash);',
  "if (step) root.setAttribute('data-step', step[1]);",
  '})();',
].join(' ');

export function scriptHash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('base64');
}

export function headScriptHash(): string {
  return scriptHash(HEAD_SCRIPT);
}

const SHAPE_ERROR = 'tokens.json: expected an object with themed and static lists';
const NAME = /^--[a-z0-9]+(?:-[a-z0-9]+)*$/;
// A value is written straight into a declaration, so nothing in it may end the declaration or the
// block, open another, close the style context, open or close a comment that would swallow the
// declarations after it, or escape the character that follows.
const UNSAFE_VALUE = /[;{}<>\\]|\/\*|\*\//;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

// A font stack may quote family names, so quotes are allowed, but only as closed strings: an open
// one would run on into the next declaration. A quote of the other kind inside a string is text.
function quotesBalanced(value: string): boolean {
  let open: string | undefined;
  for (const character of value) {
    if (character !== '"' && character !== "'") continue;
    if (open === undefined) open = character;
    else if (open === character) open = undefined;
  }
  return open === undefined;
}

function checkValue(name: string, value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '' || UNSAFE_VALUE.test(value) || !quotesBalanced(value)) throw new Error(`tokens.json: ${name} has an unsafe value`);
  return value;
}

function checkName(value: unknown, seen: Set<string>): string {
  if (typeof value !== 'string' || !NAME.test(value)) throw new Error(`tokens.json: ${JSON.stringify(value)} is not a custom property name`);
  if (seen.has(value)) throw new Error(`tokens.json: ${value} is declared twice`);
  seen.add(value);
  return value;
}

export function parseTokens(raw: unknown): TokenSource {
  if (!isRecord(raw) || !Array.isArray(raw.themed) || !Array.isArray(raw.static)) throw new Error(SHAPE_ERROR);
  if (raw.themed.length === 0) throw new Error('tokens.json: the themed list is empty');
  const seen = new Set<string>();
  const themed = raw.themed.map((entry: unknown): ThemedToken => {
    const item = isRecord(entry) ? entry : {};
    const name = checkName(item.name, seen);
    return { name, light: checkValue(name, item.light), dark: checkValue(name, item.dark) };
  });
  const statics = raw.static.map((entry: unknown): StaticToken => {
    const item = isRecord(entry) ? entry : {};
    const name = checkName(item.name, seen);
    return { name, value: checkValue(name, item.value) };
  });
  return { themed, static: statics };
}

export const TOKENS: TokenSource = parseTokens(tokenSource);

export function themedValue(tokens: TokenSource, name: string, theme: 'light' | 'dark'): string {
  const token = tokens.themed.find((item) => item.name === name);
  if (token === undefined) throw new Error(`${name} is not a themed token in tokens.json`);
  return token[theme];
}

const block = (selector: string, lines: readonly string[], indent = ''): string =>
  `${indent}${selector} {\n${lines.map((line) => `${indent}  ${line};`).join('\n')}\n${indent}}`;

// color-scheme dark gives the browser's dark canvas and light default text, but no element carries
// a background, and axe failed that text and the default link colours for contrast in the dark and
// device audits. So the page itself paints the ground and the ink the blocks switch (UI-SPEC
// section 4 roles: ground is the page margin, ink the text).
const PAGE_RULE = ['background-color: var(--ground)', 'color: var(--ink)'];

// D-140: light values and the static tokens on :root, then one dark list written twice, under
// R8's two selectors, so the two dark blocks are identical by construction.
export function renderTokensCss(tokens: TokenSource = TOKENS): string {
  const light = ['color-scheme: light', ...tokens.themed.map((token) => `${token.name}: ${token.light}`), ...tokens.static.map((token) => `${token.name}: ${token.value}`)];
  const dark = ['color-scheme: dark', ...tokens.themed.map((token) => `${token.name}: ${token.dark}`)];
  return [
    block(':root', light),
    `@media (prefers-color-scheme: dark) {\n${block(':root:not([data-theme="light"])', dark, '  ')}\n}`,
    block(':root[data-theme="dark"]', dark),
    block('html', PAGE_RULE),
  ].join('\n\n').concat('\n');
}
