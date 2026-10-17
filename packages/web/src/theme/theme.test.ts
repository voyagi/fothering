import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../test/planted-dist.js';
import { GET as tokensGet } from '../pages/tokens.css.js';
import { HEAD_SCRIPT, headScriptHash, parseTokens, renderTokensCss, themedValue, TOKENS, type TokenSource } from './head-script.js';

const TOKEN_FILE = join(REPO_ROOT, 'packages', 'web', 'src', 'theme', 'tokens.json');
const HEADERS_FILE = join(REPO_ROOT, 'packages', 'web', 'public', '_headers');
const tokensFromFile = (): unknown => JSON.parse(readFileSync(TOKEN_FILE, 'utf8'));

const declarations = (body: string): string[] => body.split(';').map((item) => item.trim()).filter((item) => item !== '');

// The three blocks of D-140 in the order the file must hold them: light on :root, then the two
// dark blocks under R8's selectors.
function blocksOf(css: string): { root: string[]; media: string[]; pinned: string[]; order: number[] } {
  const root = /(?:^|\n):root \{([^}]*)\}/.exec(css);
  const media = /@media \(prefers-color-scheme: dark\) \{\s*:root:not\(\[data-theme="light"\]\) \{([^}]*)\}\s*\}/.exec(css);
  const pinned = /(?:^|\n):root\[data-theme="dark"\] \{([^}]*)\}/.exec(css);
  if (root === null || media === null || pinned === null) throw new Error(`tokens.css lacks a block: ${css.slice(0, 200)}`);
  return {
    root: declarations(root[1] ?? ''),
    media: declarations(media[1] ?? ''),
    pinned: declarations(pinned[1] ?? ''),
    order: [root.index, media.index, pinned.index],
  };
}

describe('the token source and tokens.css (D-140, AC-39, AC-63)', () => {
  const source = parseTokens(tokensFromFile());
  const blocks = (): ReturnType<typeof blocksOf> => blocksOf(renderTokensCss(source));

  it('declares color-scheme light, every themed light value and every static token on :root', () => {
    expect(blocks().root).toEqual([
      'color-scheme: light',
      ...source.themed.map((token) => `${token.name}: ${token.light}`),
      ...source.static.map((token) => `${token.name}: ${token.value}`),
    ]);
  });

  it('declares color-scheme dark and every themed dark value under the media block for :root:not([data-theme="light"])', () => {
    expect(blocks().media).toEqual(['color-scheme: dark', ...source.themed.map((token) => `${token.name}: ${token.dark}`)]);
  });

  it('declares the identical dark list under :root[data-theme="dark"]', () => {
    const { media, pinned } = blocks();
    expect(pinned).toEqual(media);
    expect(pinned.length).toBe(source.themed.length + 1);
  });

  it('writes the light block first, then the media block, then the pinned dark block', () => {
    const [root, media, pinned] = blocks().order;
    expect(root).toBeLessThan(media ?? -1);
    expect(media).toBeLessThan(pinned ?? -1);
  });

  it('paints the page with the ground and ink tokens after the blocks, so the canvas color-scheme switches is never left uncoloured', () => {
    const css = renderTokensCss(source);
    const page = /\nhtml \{([^}]*)\}\n$/.exec(css);
    expect(declarations(page?.[1] ?? '')).toEqual(['background-color: var(--ground)', 'color: var(--ink)']);
    expect(page?.index).toBeGreaterThan(blocks().order[2] ?? Number.POSITIVE_INFINITY);
  });

  it('holds the six R14 type tokens, the 46ch measure and the tag literals equal in both themes', () => {
    const statics = new Map(source.static.map((token) => [token.name, token.value]));
    expect(statics.get('--text-small')).toBe('0.9375rem');
    expect(statics.get('--text-mono-value')).toBe('0.8125rem');
    for (const name of ['--text-lede', '--text-intro', '--text-narrative-headline', '--text-schedule-compact']) expect(statics.has(name), name).toBe(true);
    expect(statics.get('--measure')).toBe('46ch');
    const tags = source.themed.filter((token) => token.name.startsWith('--tag-'));
    expect(tags.map((token) => token.name)).toEqual(['--tag-red', '--tag-card', '--tag-ink', '--tag-field']);
    for (const tag of tags) expect(tag.dark, tag.name).toBe(tag.light);
  });

  it('TOKENS is the parsed tokens.json and themedValue reads one token in one theme', () => {
    expect(TOKENS).toEqual(source);
    expect(themedValue(TOKENS, '--ground', 'light')).toBe('#F5F7F8');
    expect(themedValue(TOKENS, '--ground', 'dark')).toBe('#0F1316');
    expect(() => themedValue(TOKENS, '--no-such-token', 'dark')).toThrow('--no-such-token is not a themed token in tokens.json');
  });

  it('the tokens.css endpoint returns the rendered CSS as text/css', async () => {
    const response = tokensGet();
    expect(response.headers.get('Content-Type')).toBe('text/css; charset=utf-8');
    expect(await response.text()).toBe(renderTokensCss(TOKENS));
  });
});

describe('parseTokens refuses a token source it cannot render safely', () => {
  const valid = (): { themed: unknown[]; static: unknown[] } => ({ themed: [{ name: '--ground', light: '#FFF', dark: '#000' }], static: [{ name: '--measure', value: '46ch' }] });

  it('accepts a minimal valid source', () => {
    expect(parseTokens(valid())).toEqual(valid());
  });

  it('refuses a source that is not an object with two lists', () => {
    expect(() => parseTokens(null)).toThrow('tokens.json: expected an object with themed and static lists');
    expect(() => parseTokens({ themed: [] })).toThrow('tokens.json: expected an object with themed and static lists');
  });

  it('refuses an empty themed list', () => {
    expect(() => parseTokens({ ...valid(), themed: [] })).toThrow('tokens.json: the themed list is empty');
  });

  it('refuses a name that is not a custom property', () => {
    const bad: TokenSource = { themed: [{ name: 'ground', light: '#FFF', dark: '#000' }], static: [] };
    expect(() => parseTokens(bad)).toThrow('tokens.json: "ground" is not a custom property name');
  });

  it('refuses a value that could close or open a declaration', () => {
    for (const value of ['#FFF; color: red', '#FFF }', '{', '</style>']) {
      expect(() => parseTokens({ ...valid(), static: [{ name: '--measure', value }] }), value).toThrow(/tokens\.json: --measure has an unsafe value/);
    }
  });

  it('refuses a missing value and a duplicate name', () => {
    expect(() => parseTokens({ ...valid(), themed: [{ name: '--ground', light: '#FFF' }] })).toThrow('tokens.json: --ground has an unsafe value');
    expect(() => parseTokens({ ...valid(), static: [{ name: '--ground', value: '1px' }] })).toThrow('tokens.json: --ground is declared twice');
  });
});

interface StandIn {
  readonly attrs: Map<string, string>;
  readonly classes: Set<string>;
  readonly context: Record<string, unknown>;
}

type StorageMode = 'works' | 'getItem-throws' | 'getter-throws';

// A browser reduced to what the head script touches. The store map is shared when two stand-ins
// model two tabs of one origin.
function standIn(store: Map<string, string>, options: { hash?: string; storage?: StorageMode } = {}): StandIn {
  const attrs = new Map<string, string>();
  const classes = new Set<string>();
  const storage = {
    getItem: (key: string): string | null => {
      if (options.storage === 'getItem-throws') throw new Error('SecurityError');
      return store.get(key) ?? null;
    },
    setItem: (key: string, value: string): void => {
      store.set(key, String(value));
    },
  };
  const documentElement = {
    classList: { add: (name: string): void => { classes.add(name); } },
    setAttribute: (name: string, value: string): void => { attrs.set(name, String(value)); },
    getAttribute: (name: string): string | null => attrs.get(name) ?? null,
  };
  const context: Record<string, unknown> = {
    document: { documentElement },
    location: { hash: options.hash ?? '' },
    matchMedia: () => ({ matches: false }),
  };
  Object.defineProperty(context, 'localStorage', {
    get: () => {
      if (options.storage === 'getter-throws') throw new Error('SecurityError');
      return storage;
    },
  });
  context.window = context;
  return { attrs, classes, context };
}

function run(store: Map<string, string>, options: { hash?: string; storage?: StorageMode } = {}): StandIn {
  const tab = standIn(store, options);
  runInNewContext(HEAD_SCRIPT, tab.context);
  return tab;
}

const stored = (entries: Record<string, string>): Map<string, string> => new Map(Object.entries(entries));

describe('HEAD_SCRIPT in node:vm (AC-40, AC-E29, AC-E5, AC-E17)', () => {
  it('stored dark sets data-theme dark', () => {
    expect(run(stored({ 'fothering-theme': 'dark' })).attrs.get('data-theme')).toBe('dark');
  });

  it('stored light sets data-theme light', () => {
    expect(run(stored({ 'fothering-theme': 'light' })).attrs.get('data-theme')).toBe('light');
  });

  it.each(['blue', '', 'DARK', 'device'])('stored theme %j sets no data-theme, so Device applies', (value) => {
    expect(run(stored({ 'fothering-theme': value })).attrs.has('data-theme')).toBe(false);
  });

  it('a getItem that throws leaves data-theme unset and throws nothing', () => {
    let tab: StandIn | undefined;
    expect(() => { tab = run(stored({ 'fothering-theme': 'dark' }), { storage: 'getItem-throws' }); }).not.toThrow();
    expect(tab?.attrs.has('data-theme')).toBe(false);
  });

  it('a localStorage getter that throws leaves data-theme unset and throws nothing', () => {
    let tab: StandIn | undefined;
    expect(() => { tab = run(stored({ 'fothering-theme': 'dark' }), { storage: 'getter-throws' }); }).not.toThrow();
    expect(tab?.attrs.has('data-theme')).toBe(false);
  });

  it('adds the js class in every case, storage throwing included', () => {
    const cases: readonly { entries: Record<string, string>; storage?: StorageMode; hash?: string }[] = [
      { entries: {} },
      { entries: { 'fothering-theme': 'dark' } },
      { entries: { 'fothering-theme': 'blue' } },
      { entries: { 'fothering-theme': 'dark' }, storage: 'getItem-throws' },
      { entries: { 'fothering-theme': 'dark' }, storage: 'getter-throws' },
      { entries: {}, hash: '#step-9' },
    ];
    for (const item of cases) {
      const options = { ...(item.storage === undefined ? {} : { storage: item.storage }), ...(item.hash === undefined ? {} : { hash: item.hash }) };
      expect([...run(stored(item.entries), options).classes], JSON.stringify(item)).toEqual(['js']);
    }
  });

  it.each(['stopped', 'running'])('stored flow %s sets data-flow', (value) => {
    expect(run(stored({ 'fothering-flow': value })).attrs.get('data-flow')).toBe(value);
  });

  it.each(['paused', '', 'STOPPED'])('stored flow %j sets no data-flow', (value) => {
    expect(run(stored({ 'fothering-flow': value })).attrs.has('data-flow')).toBe(false);
  });

  it('applies the stored flow even when the stored theme is junk, and the theme when the flow is', () => {
    const tab = run(stored({ 'fothering-theme': 'blue', 'fothering-flow': 'stopped' }));
    expect(tab.attrs.get('data-flow')).toBe('stopped');
    expect(run(stored({ 'fothering-theme': 'dark', 'fothering-flow': 'x' })).attrs.get('data-theme')).toBe('dark');
  });

  it.each(['1', '2', '3', '4'])('hash #step-%s sets data-step to the digit', (digit) => {
    expect(run(new Map(), { hash: `#step-${digit}` }).attrs.get('data-step')).toBe(digit);
  });

  it.each(['#step-0', '#step-5', '#step-01', '#step-1x', '#step-', '', '#step-1#step-2', '#STEP-1'])('hash %j sets no data-step', (hash) => {
    expect(run(new Map(), { hash }).attrs.has('data-step')).toBe(false);
  });

  it('two tabs sharing one storage both apply a Dark the first one stored', () => {
    const shared = new Map<string, string>();
    const first = standIn(shared);
    (first.context.localStorage as { setItem: (key: string, value: string) => void }).setItem('fothering-theme', 'dark');
    runInNewContext(HEAD_SCRIPT, first.context);
    const second = run(shared);
    expect(first.attrs.get('data-theme')).toBe('dark');
    expect(second.attrs.get('data-theme')).toBe('dark');
  });

  it('is ES5 text: no arrow function, let, const, class or template literal', () => {
    expect(HEAD_SCRIPT).not.toMatch(/=>|\blet\b|\bconst\b|\bclass\b|`/);
    expect(HEAD_SCRIPT.trim()).toBe(HEAD_SCRIPT);
  });
});

describe('the response headers file (D-149, T-05-21, T-05-23, T-05-24)', () => {
  const text = (): string => readFileSync(HEADERS_FILE, 'utf8');

  it('headScriptHash is the base64 SHA-256 of HEAD_SCRIPT', () => {
    expect(HEAD_SCRIPT).not.toBe('');
    expect(headScriptHash()).toBe(createHash('sha256').update(HEAD_SCRIPT, 'utf8').digest('base64'));
  });

  it('holds exactly one sha256 value, and it is the hash of HEAD_SCRIPT', () => {
    const hashes = [...text().matchAll(/'sha256-([A-Za-z0-9+/=]+)'/g)].map((match) => match[1]);
    expect(hashes).toEqual([headScriptHash()]);
  });

  it('holds one /* rule with exactly the four headers of D-149', () => {
    const lines = text().split(/\r?\n/).filter((line) => line.trim() !== '');
    expect(lines[0]).toBe('/*');
    const headers = lines.slice(1).map((line) => {
      expect(line, line).toMatch(/^ {2}\S/);
      const colon = line.indexOf(':');
      return [line.slice(0, colon).trim(), line.slice(colon + 1).trim()];
    });
    expect(headers).toEqual([
      ['X-Content-Type-Options', 'nosniff'],
      ['Referrer-Policy', 'no-referrer'],
      ['X-Frame-Options', 'DENY'],
      ['Content-Security-Policy', `default-src 'self'; script-src 'self' 'sha256-${headScriptHash()}'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`],
    ]);
  });

  it('allows no unsafe keyword', () => {
    expect(text()).not.toMatch(/unsafe-/);
  });
});
