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

  it('holds the six R14 type tokens, the 54ch measure, and the lane, stop, note and drawing colours and the board (not its edge) in both themes', () => {
    const statics = new Map(source.static.map((token) => [token.name, token.value]));
    expect(statics.get('--text-small')).toBe('0.9375rem');
    expect(statics.get('--text-mono-value')).toBe('0.8125rem');
    for (const name of ['--text-lede', '--text-intro', '--text-narrative-headline', '--text-schedule-compact']) expect(statics.has(name), name).toBe(true);
    // The e2e LINES check measures every rendered line in Mona Sans against its limit of 80
    // characters (2026-10-23, 1440 px: the longest of 776 prose blocks ran 76), so a wider measure
    // fails there first.
    expect(statics.get('--measure')).toBe('54ch');
    // The night board is a screen: it, its lanes and the red that closes one look the same on either
    // page, and so do the notes and the drawings. Only the board's edge changes, so it shows on navy.
    const fixed = [
      '--board', '--board-ink', '--board-label', '--board-rule', '--board-slot',
      '--lane-1', '--lane-2', '--lane-3', '--stop', '--note', '--note-ink', '--note-tape',
      '--d-blue', '--d-sky', '--d-coral', '--d-sun', '--d-pink', '--d-mint', '--d-cloth', '--d-ink', '--d-paper', '--d-mist',
    ];
    const themed = new Map(source.themed.map((token) => [token.name, token]));
    for (const name of fixed) {
      const token = themed.get(name);
      expect(token, name).toEqual(expect.objectContaining({ name }));
      expect(token?.dark, name).toBe(token?.light);
    }
    const edge = themed.get('--board-edge');
    expect(edge?.light).toBe(themed.get('--board')?.light);
    expect(edge?.dark).not.toBe(edge?.light);
  });

  it('TOKENS is the parsed tokens.json and themedValue reads one token in one theme', () => {
    expect(TOKENS).toEqual(source);
    expect(themedValue(TOKENS, '--ground', 'light')).toBe('#FFFFFF');
    expect(themedValue(TOKENS, '--ground', 'dark')).toBe('#121B33');
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

  it('refuses a value holding a comment opener or closer, a backslash or an unbalanced quote', () => {
    const backslash = String.fromCharCode(92);
    for (const value of ['1px /* x', '1px */', `"A${backslash}"B", serif`, `a${backslash}9`, '"Inter, sans-serif', "'Inter, sans-serif", `"Inter', sans-serif`, '"Inter" "Plex']) {
      expect(() => parseTokens({ ...valid(), static: [{ name: '--measure', value }] }), value).toThrow(/tokens\.json: --measure has an unsafe value/);
    }
  });

  it('accepts a font stack whose quotes are balanced', () => {
    for (const value of ['"IBM Plex Sans", system-ui, sans-serif', "'Inter', 'Plex Mono', monospace", `"It's Mono", monospace`]) {
      expect(parseTokens({ ...valid(), static: [{ name: '--measure', value }] }).static[0]?.value, value).toBe(value);
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

  // A visitor from before the flow switch went may still hold its key; it must change nothing.
  it('ignores a leftover fothering-flow entry: no data-flow, and the stored theme still applies', () => {
    const tab = run(stored({ 'fothering-theme': 'dark', 'fothering-flow': 'stopped' }));
    expect(tab.attrs.get('data-theme')).toBe('dark');
    expect(tab.attrs.has('data-flow')).toBe(false);
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

// Mona Sans ships its width axis, so its faces come from wdth.css (which carries font-stretch);
// Source Code Pro from wght.css.
const FACE_PACKAGES = [
  { name: 'mona-sans', family: 'Mona Sans', css: 'wdth.css' },
  { name: 'source-code-pro', family: 'Source Code Pro', css: 'wght.css' },
] as const;
// Only the latin and latin-ext normal files ship; the packages also install cyrillic, greek and
// vietnamese rules, which the site leaves out.
const SHIPPED_FILE = /-(?:latin|latin-ext)-(?:wght|wdth)-normal\.woff2$/;
const FONTSOURCE = join(REPO_ROOT, 'node_modules', '@fontsource-variable');
const SITE_CSS = join(REPO_ROOT, 'packages', 'web', 'src', 'styles', 'site.css');
const LICENCES_FILE = join(REPO_ROOT, 'packages', 'web', 'public', 'font-licences.txt');
const unixText = (text: string): string => text.replace(/\r\n/g, '\n');

interface FaceRule {
  readonly descriptors: ReadonlyMap<string, string>;
  readonly url: string;
  readonly format: string;
}

function fontFaces(css: string): FaceRule[] {
  return [...css.matchAll(/@font-face\s*\{([^}]*)\}/g)].map((match) => {
    const descriptors = new Map(declarations(match[1] ?? '').map((item) => {
      const colon = item.indexOf(':');
      return [item.slice(0, colon).trim(), item.slice(colon + 1).trim()] as const;
    }));
    const src = /^url\((['"]?)([^'")]+)\1\)\s+format\((['"])([^'"]+)\3\)$/.exec(descriptors.get('src') ?? '');
    return { descriptors, url: src?.[2] ?? '', format: src?.[4] ?? '' };
  });
}

const fileName = (url: string): string => url.slice(url.lastIndexOf('/') + 1);
const unquoted = (value: string | undefined): string => (value ?? '').replace(/^(['"])(.*)\1$/, '$2');

// The installed CSS of each package, its latin and latin-ext normal rules keyed by the woff2 file
// each names.
function installedFaces(): Map<string, { readonly family: string; readonly rule: FaceRule }> {
  const faces = new Map<string, { family: string; rule: FaceRule }>();
  for (const face of FACE_PACKAGES) {
    for (const rule of fontFaces(readFileSync(join(FONTSOURCE, face.name, face.css), 'utf8'))) {
      if (SHIPPED_FILE.test(rule.url)) faces.set(fileName(rule.url), { family: face.family, rule });
    }
  }
  return faces;
}

// A bare package path resolves under node_modules, any other path from the stylesheet's folder.
const resolvedFace = (url: string): string => (url.startsWith('@fontsource-variable/') ? join(REPO_ROOT, 'node_modules', url) : join(SITE_CSS, '..', url));

describe('the self-hosted faces (D-134, AC-59)', () => {
  const ours = (): FaceRule[] => fontFaces(readFileSync(SITE_CSS, 'utf8'));

  it('declares one @font-face for each latin and latin-ext normal file the two packages install, and no other', () => {
    const installed = installedFaces();
    expect(installed.size).toBe(4);
    expect(ours().map((rule) => fileName(rule.url)).sort()).toEqual([...installed.keys()].sort());
  });

  it('names each family exactly Mona Sans or Source Code Pro, with font-display swap', () => {
    const installed = installedFaces();
    const rules = ours();
    expect(rules.length).toBeGreaterThan(0);
    for (const rule of rules) {
      expect(unquoted(rule.descriptors.get('font-family')), rule.url).toBe(installed.get(fileName(rule.url))?.family);
      expect(rule.descriptors.get('font-display'), rule.url).toBe('swap');
    }
  });

  it('copies font-weight, font-style, font-stretch, unicode-range and the src format from the installed rule of the same file', () => {
    const installed = installedFaces();
    const rules = ours();
    expect(rules.length).toBeGreaterThan(0);
    // Mona Sans's width axis rides on font-stretch, so a rule that lost it would set every width at 100%.
    expect(rules.filter((rule) => rule.descriptors.has('font-stretch')).length).toBe(2);
    for (const rule of rules) {
      const source = installed.get(fileName(rule.url))?.rule;
      for (const descriptor of ['font-weight', 'font-style', 'font-stretch', 'unicode-range']) {
        expect(rule.descriptors.get(descriptor), `${rule.url} ${descriptor}`).toBe(source?.descriptors.get(descriptor));
      }
      expect(rule.format, rule.url).toBe(source?.format);
    }
  });

  // A preload naming a file no @font-face uses would be fetched twice: once preloaded, once by the rule.
  it('preloads from the layout exactly one latin face per family, each a file site.css declares', () => {
    const layout = readFileSync(join(REPO_ROOT, 'packages', 'web', 'src', 'layouts', 'Sheet.astro'), 'utf8');
    const preloaded = [...layout.matchAll(/^import \w+ from '([^']+\.woff2)\?url';$/gm)].map((match) => match[1] ?? '');
    const declared = new Map(ours().map((rule) => [rule.url, unquoted(rule.descriptors.get('font-family'))]));
    expect(preloaded.filter((url) => /-latin-(?:wght|wdth)-normal\.woff2$/.test(url))).toEqual(preloaded);
    expect(preloaded.map((url) => declared.get(url)).sort()).toEqual(FACE_PACKAGES.map((face) => face.family).sort());
  });

  it('points every src at an installed latin or latin-ext normal woff2 file, never italic, never another origin', () => {
    const rules = ours();
    expect(rules.length).toBeGreaterThan(0);
    for (const rule of rules) {
      expect(rule.url).toMatch(/^(?:@fontsource-variable\/|\.\.?\/)[^:]*-(?:latin|latin-ext)-(?:wght|wdth)-normal\.woff2$/);
      expect(readFileSync(resolvedFace(rule.url)).length, rule.url).toBeGreaterThan(0);
    }
  });
});

describe('the font licences file (D-134)', () => {
  const HEADER = /^(@fontsource-variable\/[a-z-]+) (\d+\.\d+\.\d+)\n=+\n/gm;

  function sections(text: string): Map<string, { readonly version: string; readonly body: string }> {
    const found = new Map<string, { version: string; body: string }>();
    const heads = [...text.matchAll(HEADER)];
    heads.forEach((head, index) => {
      const start = head.index + head[0].length;
      const end = heads[index + 1]?.index ?? text.length;
      found.set(head[1] ?? '', { version: head[2] ?? '', body: text.slice(start, end).trim() });
    });
    return found;
  }

  it('holds one section per face package, headed by its name and installed version, equal to its installed LICENSE', () => {
    const found = sections(unixText(readFileSync(LICENCES_FILE, 'utf8')));
    expect([...found.keys()].sort()).toEqual(FACE_PACKAGES.map((face) => `@fontsource-variable/${face.name}`).sort());
    for (const face of FACE_PACKAGES) {
      const folder = join(FONTSOURCE, face.name);
      const section = found.get(`@fontsource-variable/${face.name}`);
      expect(section?.version, face.name).toBe((JSON.parse(readFileSync(join(folder, 'package.json'), 'utf8')) as { version: string }).version);
      expect(section?.body, face.name).toBe(unixText(readFileSync(join(folder, 'LICENSE'), 'utf8')).trim());
    }
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

  // HSTS joins D-149's four once the site has a custom domain: a .dev host is on the browsers' HTTPS-only
  // preload list, a custom host is not.
  it('holds one /* rule with exactly the four headers of D-149 plus HSTS', () => {
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
      ['Strict-Transport-Security', 'max-age=31536000; includeSubDomains'],
    ]);
  });

  it('allows no unsafe keyword', () => {
    expect(text()).not.toMatch(/unsafe-/);
  });
});
