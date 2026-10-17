import {
  ANALYTICS_PATTERNS,
  EXACT_30_DAY_PATTERNS,
  PRE_R6_PATTERNS,
  REGION_CLAIM_PATTERNS,
  THEME_RADIO_LIMIT,
} from '../site/content.js';
import { sitemapUrls, type SiteRoute } from '../site/route-list.js';
import { scriptHash } from '../theme/head-script.js';
import { NOT_FOUND_ROUTE as NOT_FOUND_PAGE, textOf, walk, type BuiltElement, type BuiltPage, type BuiltSite } from './built-site.js';

// Later plans' expected-red tracers name these ids, so an id is never renamed once a plan names it.
export const RULE_IDS = Object.freeze([
  'dash',
  'ses-rate-wording',
  'ses-percentage-link',
  'reply-promise',
  'console-delete',
  'unit-figure',
  'banned-name',
  'region-claim',
  'exact-30-days',
  'pre-r6-words',
  'forms-cookies-analytics',
  'third-party-reference',
  'page-metadata',
  'sitemap',
  'robots',
  'theme-token-blocks',
  'head-script-order',
  'script-hash',
  'no-inline-style',
  'type-token-declared',
] as const);

export type RuleId = (typeof RULE_IDS)[number];

const REGISTERED: ReadonlySet<string> = new Set(RULE_IDS);

export function isRegisteredRule(id: string): id is RuleId {
  return REGISTERED.has(id);
}

export interface Finding {
  readonly rule: RuleId;
  readonly route: string;
  readonly text: string;
}

export interface CheckContext {
  readonly repoRoot: string;
  readonly reputationPageUrl: string;
  readonly replyPromisePhrases: readonly string[];
  readonly consoleDeletePhrases: readonly string[];
  readonly bannedNames: readonly string[];
  readonly siteOrigin: string;
  readonly routes: readonly SiteRoute[];
  // The one inline script the layout may ship, compared by its exact text (AC-40).
  readonly headScript: string;
}

const EXCERPT_RADIUS = 40;
const CLIP_LENGTH = 160;

function excerpt(text: string, index: number, length: number): string {
  const start = Math.max(0, index - EXCERPT_RADIUS);
  const end = Math.min(text.length, index + length + EXCERPT_RADIUS);
  return `${start > 0 ? '...' : ''}${text.slice(start, end)}${end < text.length ? '...' : ''}`;
}

const clip = (text: string): string => (text.length > CLIP_LENGTH ? `${text.slice(0, CLIP_LENGTH)}...` : text);
const fileRoute = (file: string): string => `file:${file}`;

function matchesIn(rule: RuleId, route: string, text: string, pattern: RegExp): Finding[] {
  const global = new RegExp(pattern.source, `${pattern.flags.replace('g', '')}g`);
  return [...text.matchAll(global)].map((match) => ({ rule, route, text: excerpt(text, match.index, match[0].length) }));
}

function patternsIn(rule: RuleId, site: BuiltSite, patterns: readonly RegExp[], textOfPage: (page: BuiltPage) => string = (page) => page.text): Finding[] {
  return site.pages.flatMap((page) => {
    const text = textOfPage(page);
    return patterns.flatMap((pattern) => matchesIn(rule, page.route, text, pattern));
  });
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Any run of whitespace between the words, so a phrase split by a line break or a non-breaking
// space still matches; the reader has already collapsed both to one space.
function phrasePatterns(phrases: readonly string[]): RegExp[] {
  return phrases.map((phrase) => new RegExp(`\\b${phrase.trim().split(/\s+/).map(escapeRegExp).join('\\s+')}`, 'i'));
}

// U+2012 figure dash to U+2015 horizontal bar, built from their code points so this source holds
// none of them. The reader decodes entities, so &mdash; and &#8211; arrive as the characters.
const DASHES = new RegExp(`[${String.fromCharCode(0x2012)}-${String.fromCharCode(0x2015)}]`);

export function dashRule(site: BuiltSite, _context: CheckContext): Finding[] {
  return patternsIn('dash', site, [DASHES]);
}

const SES_RATE_WORDING = /\byour\s+(?:SES\s+)?(?:bounce|complaint)\s+rate\b/i;

export function sesRateWordingRule(site: BuiltSite, _context: CheckContext): Finding[] {
  return patternsIn('ses-rate-wording', site, [SES_RATE_WORDING]);
}

const BLOCK_TAGS = new Set(['p', 'li', 'td', 'th', 'dd', 'dt', 'caption', 'figcaption', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
const NAMES_SES = /\bSES\b/;
const PERCENTAGE = /\d+(?:\.\d+)?\s?(?:%|percent\b)/i;

function quotesSesPercentage(element: BuiltElement): boolean {
  if (!BLOCK_TAGS.has(element.tag)) return false;
  const text = textOf(element);
  return NAMES_SES.test(text) && PERCENTAGE.test(text);
}

function some(element: BuiltElement, test: (element: BuiltElement) => boolean): boolean {
  let found = false;
  walk(element, (node) => {
    if (!found && test(node)) found = true;
  });
  return found;
}

const linksTo = (element: BuiltElement, url: string): boolean => some(element, (node) => node.tag === 'a' && node.attrs.href === url);

const quotesInside = (element: BuiltElement): boolean =>
  element.children.some((child) => typeof child !== 'string' && some(child, quotesSesPercentage));

export function sesPercentageLinkRule(site: BuiltSite, context: CheckContext): Finding[] {
  return site.pages.flatMap((page) => {
    const findings: Finding[] = [];
    walk(page.root, (element) => {
      if (!quotesSesPercentage(element) || linksTo(element, context.reputationPageUrl)) return;
      // A list item holding the paragraph that quotes the figure is reported once, at the paragraph.
      if (quotesInside(element)) return;
      findings.push({ rule: 'ses-percentage-link', route: page.route, text: clip(textOf(element)) });
    });
    return findings;
  });
}

export function replyPromiseRule(site: BuiltSite, context: CheckContext): Finding[] {
  return patternsIn('reply-promise', site, phrasePatterns(context.replyPromisePhrases));
}

export function consoleDeleteRule(site: BuiltSite, context: CheckContext): Finding[] {
  return patternsIn('console-delete', site, phrasePatterns(context.consoleDeletePhrases));
}

// Euro, pound and yen, from their code points so this source stays ASCII.
const CURRENCY = `$${String.fromCharCode(0x20ac, 0xa3, 0xa5)}`;
const UNIT_FIGURES: readonly RegExp[] = [
  /(?<![\w.])\d+(?:[.,]\d+)*\s?(?:%|percent\b|ms\b|s\b|sec\b|seconds\b|min\b|minutes\b|USD\b|EUR\b)/i,
  /\b(?:USD|EUR)\s?\d/,
  new RegExp(`[${escapeRegExp(CURRENCY)}]\\s?\\d|\\d\\s?[${escapeRegExp(CURRENCY)}]`),
];

// Artifact values under their provenance label and SES thresholds beside the reputation link are
// the only figures a page may show (AC-E4).
export function unitFigureRule(site: BuiltSite, context: CheckContext): Finding[] {
  const exempt = (element: BuiltElement): boolean =>
    element.attrs['data-provenance'] !== undefined || (BLOCK_TAGS.has(element.tag) && linksTo(element, context.reputationPageUrl));
  return patternsIn('unit-figure', site, UNIT_FIGURES, (page) => textOf(page.root, exempt));
}

export function bannedNameRule(site: BuiltSite, context: CheckContext): Finding[] {
  return patternsIn('banned-name', site, phrasePatterns(context.bannedNames));
}

export function regionClaimRule(site: BuiltSite, _context: CheckContext): Finding[] {
  return patternsIn('region-claim', site, REGION_CLAIM_PATTERNS);
}

export function exactThirtyDaysRule(site: BuiltSite, _context: CheckContext): Finding[] {
  return patternsIn('exact-30-days', site, EXACT_30_DAY_PATTERNS);
}

export function preR6WordsRule(site: BuiltSite, _context: CheckContext): Finding[] {
  const inReferences = site.pages.flatMap((page) =>
    page.references
      .filter((reference) => PRE_R6_PATTERNS.some((pattern) => pattern.test(reference.value)))
      .map((reference) => ({ rule: 'pre-r6-words' as const, route: page.route, text: `${reference.tag} ${reference.attr}="${clip(reference.value)}"` })),
  );
  return [...patternsIn('pre-r6-words', site, PRE_R6_PATTERNS), ...inReferences];
}

const COOKIE_WRITE = /document\.cookie\s*=(?!=)/;
const SET_COOKIE = /^\s*set-cookie\s*:/im;
const isAnalytics = (text: string): boolean => ANALYTICS_PATTERNS.some((pattern) => pattern.test(text));

function inputFindings(page: BuiltPage): string[] {
  const texts: string[] = [];
  const types = page.inputs.map((input) => (input.type ?? 'text').toLowerCase());
  for (const type of types) {
    if (type !== 'radio') texts.push(`an input of type ${type}`);
  }
  const radios = types.filter((type) => type === 'radio').length;
  if (radios > THEME_RADIO_LIMIT) texts.push(`${radios} radio inputs; the theme switch is the only one allowed, with ${THEME_RADIO_LIMIT}`);
  return texts;
}

function scriptFindings(page: BuiltPage): string[] {
  const texts: string[] = [];
  for (const script of page.scripts) {
    if (COOKIE_WRITE.test(script.text)) texts.push('an inline script writes document.cookie');
    if (script.src !== null && isAnalytics(script.src)) texts.push(`a script loads an analytics or tag-manager source: ${clip(script.src)}`);
    if (isAnalytics(script.text)) texts.push(`an inline script calls an analytics or tag-manager source: ${clip(script.text)}`);
  }
  for (const link of page.links) {
    if (isAnalytics(link.href ?? '')) texts.push(`a link references an analytics or tag-manager source: ${clip(link.href ?? '')}`);
  }
  return texts;
}

export function formsCookiesAnalyticsRule(site: BuiltSite, _context: CheckContext): Finding[] {
  const rule = 'forms-cookies-analytics' as const;
  const onPages = site.pages.flatMap((page) =>
    [...page.forms.map(() => 'a form element'), ...inputFindings(page), ...scriptFindings(page)].map((text) => ({ rule, route: page.route, text })),
  );
  const inFiles = site.scripts.flatMap((file) => [
    ...(COOKIE_WRITE.test(file.text) ? [{ rule, route: fileRoute(file.file), text: 'the script writes document.cookie' }] : []),
    ...(isAnalytics(file.text) ? [{ rule, route: fileRoute(file.file), text: 'the script references an analytics or tag-manager source' }] : []),
  ]);
  const inHeaders = site.headers !== null && SET_COOKIE.test(site.headers) ? [{ rule, route: fileRoute('_headers'), text: 'a Set-Cookie header' }] : [];
  return [...onPages, ...inFiles, ...inHeaders];
}

// Every attribute that makes the browser fetch something. Anchor hrefs are navigation, not
// requests, and stay outside the rule; a canonical link names the page, it loads nothing.
const RESOURCE_ATTRS: Readonly<Record<string, readonly string[]>> = {
  link: ['href'],
  script: ['src'],
  img: ['src', 'srcset'],
  source: ['src', 'srcset'],
  iframe: ['src'],
  embed: ['src'],
  object: ['data'],
  video: ['src', 'poster'],
  audio: ['src'],
  track: ['src'],
  input: ['src'],
  image: ['href'],
  use: ['href'],
  feImage: ['href'],
};

const isCanonical = (rel: string | null): boolean => (rel ?? '').toLowerCase().split(/\s+/).includes('canonical');

function urlsOf(attr: string, value: string): string[] {
  if (attr !== 'srcset') return [value];
  return value.split(',').map((candidate) => candidate.trim().split(/\s+/)[0] ?? '').filter((url) => url !== '');
}

// A protocol-relative URL reaches another host as surely as an absolute one; data: is inline.
export function isThirdParty(url: string): boolean {
  const trimmed = url.trim();
  if (trimmed.startsWith('//')) return true;
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(trimmed);
  return scheme !== null && scheme[1]?.toLowerCase() !== 'data';
}

function cssUrls(css: string): string[] {
  const urls = [...css.matchAll(/url\(\s*(['"]?)([^'")]*)\1\s*\)/gi)].map((match) => match[2] ?? '');
  const imports = [...css.matchAll(/@import\s+(['"])([^'"]+)\1/gi)].map((match) => match[2] ?? '');
  return [...urls, ...imports];
}

function inlineCss(page: BuiltPage): string[] {
  const css: string[] = [];
  walk(page.root, (element) => {
    if (element.tag === 'style') css.push(element.children.filter((child): child is string => typeof child === 'string').join(''));
    if (element.attrs.style !== undefined) css.push(element.attrs.style);
  });
  return css;
}

export function thirdPartyReferenceRule(site: BuiltSite, _context: CheckContext): Finding[] {
  const rule = 'third-party-reference' as const;
  const onPages = site.pages.flatMap((page) => {
    const fromAttrs = page.references
      .filter((reference) => (RESOURCE_ATTRS[reference.tag] ?? []).includes(reference.attr) && !(reference.tag === 'link' && isCanonical(reference.rel)))
      .flatMap((reference) => urlsOf(reference.attr, reference.value).filter(isThirdParty).map((url) => `${reference.tag} ${reference.attr} ${clip(url)}`));
    const fromCss = inlineCss(page).flatMap(cssUrls).filter(isThirdParty).map((url) => `inline CSS url ${clip(url)}`);
    return [...fromAttrs, ...fromCss].map((text) => ({ rule, route: page.route, text }));
  });
  const inCss = site.css.flatMap((file) => cssUrls(file.text).filter(isThirdParty).map((url) => ({ rule, route: fileRoute(file.file), text: `CSS url ${clip(url)}` })));
  return [...onPages, ...inCss];
}

const REQUIRED_METAS: readonly (readonly [string, string])[] = [
  ['name', 'description'],
  ['property', 'og:title'],
  ['property', 'og:description'],
  ['property', 'og:type'],
  ['name', 'twitter:card'],
];

// A drawing's SVG <title> is its accessible name, not the page's title.
function headTitle(page: BuiltPage): string {
  let title = '';
  walk(page.root, (element) => {
    if (title === '' && element.tag === 'title' && !element.inSvg) title = textOf(element);
  });
  return title;
}

const metaContent = (page: BuiltPage, key: string, value: string): string => (page.metas.find((meta) => meta[key] === value)?.content ?? '').trim();

export function pageMetadataRule(site: BuiltSite, _context: CheckContext): Finding[] {
  const rule = 'page-metadata' as const;
  const findings: Finding[] = [];
  const firstWith = { title: new Map<string, string>(), description: new Map<string, string>() };
  const noteShared = (kind: keyof typeof firstWith, value: string, route: string): void => {
    if (value === '') return;
    const first = firstWith[kind].get(value);
    if (first === undefined) firstWith[kind].set(value, route);
    else findings.push({ rule, route, text: `the ${kind} "${clip(value)}" is also the ${kind} of ${first}` });
  };
  for (const page of site.pages) {
    const title = headTitle(page);
    if (title === '') findings.push({ rule, route: page.route, text: 'the page has no title' });
    for (const [key, value] of REQUIRED_METAS) {
      if (metaContent(page, key, value) === '') findings.push({ rule, route: page.route, text: `the page has no meta ${key}="${value}" with content` });
    }
    noteShared('title', title, page.route);
    noteShared('description', metaContent(page, 'name', 'description'), page.route);
  }
  return findings;
}

// Workers answers /404 and /404/ with the 404 page and redirects /404.html there.
const NOT_FOUND_PATHS: ReadonlySet<string> = new Set(['/404', '/404/', '/404.html']);

function sitemapPaths(urls: readonly string[], origin: string, report: (text: string) => void): Map<string, number> {
  const counts = new Map<string, number>();
  for (const url of urls) {
    if (!url.startsWith(`${origin}/`)) {
      report(`${clip(url)} is not an absolute URL on ${origin}`);
      continue;
    }
    const path = url.slice(origin.length);
    counts.set(path, (counts.get(path) ?? 0) + 1);
  }
  return counts;
}

// The sitemap and the built pages are compared as sets from the same build, so a page added
// without its route-list entry, or an entry with no page, fails here (AC-E39).
export function sitemapRule(site: BuiltSite, context: CheckContext): Finding[] {
  const rule = 'sitemap' as const;
  const route = fileRoute('sitemap.xml');
  if (site.sitemap === null) return [{ rule, route, text: 'dist/sitemap.xml is missing' }];
  const urls = sitemapUrls(site.sitemap);
  if (urls.length === 0) return [{ rule, route, text: 'the sitemap lists zero URLs' }];
  const findings: Finding[] = [];
  const report = (text: string): void => {
    findings.push({ rule, route, text });
  };
  const counts = sitemapPaths(urls, context.siteOrigin, report);
  const notIndexable = new Set(context.routes.filter((entry) => !entry.indexable).map((entry) => entry.path));
  const built = new Set(site.pages.map((page) => page.route).filter((path) => path !== NOT_FOUND_PAGE && !notIndexable.has(path)));
  for (const [path, count] of counts) {
    if (count > 1) report(`the sitemap lists ${path} ${count} times`);
    if (NOT_FOUND_PATHS.has(path)) report(`the sitemap lists the 404 page at ${path}`);
    else if (!built.has(path)) report(`the sitemap lists ${path}, which the build lacks`);
  }
  for (const path of built) {
    if (!counts.has(path)) findings.push({ rule, route: path, text: `${path} is a built route missing from the sitemap` });
  }
  return findings;
}

export function robotsRule(site: BuiltSite, context: CheckContext): Finding[] {
  const rule = 'robots' as const;
  const route = fileRoute('robots.txt');
  if (site.robots === null) return [{ rule, route, text: 'dist/robots.txt is missing' }];
  const lines = site.robots.split(/\r?\n/).map((line) => line.trim());
  const sitemapUrl = `${context.siteOrigin}/sitemap.xml`;
  const required: readonly (readonly [RegExp, string])[] = [
    [/^user-agent:\s*\*$/i, 'robots.txt has no "User-agent: *" line'],
    [/^allow:\s*\/$/i, 'robots.txt has no "Allow: /" line'],
    [new RegExp(`^sitemap:\\s*${escapeRegExp(sitemapUrl)}$`, 'i'), `robots.txt does not name the sitemap at ${sitemapUrl}`],
  ];
  return required.filter(([pattern]) => !lines.some((line) => pattern.test(line))).map(([, text]) => ({ rule, route, text }));
}

interface CssRule {
  readonly selector: string;
  readonly declarations: readonly string[];
}

const squash = (text: string): string => text.replace(/\s+/g, ' ').trim();

// A brace-matching read of generated CSS: each rule's selector is joined to its enclosing at-rule
// preludes, so the dark block reads as one key under its media query. tokens.css holds no comment
// or string, so neither is handled.
function cssRules(css: string): CssRule[] {
  const rules: CssRule[] = [];
  const preludes: string[] = [];
  let buffer = '';
  for (const char of css) {
    if (char === '{') {
      preludes.push(squash(buffer));
      buffer = '';
    } else if (char === '}') {
      const declarations = buffer.split(';').map((item) => {
        const colon = item.indexOf(':');
        return colon < 0 ? squash(item) : `${item.slice(0, colon).trim()}: ${squash(item.slice(colon + 1))}`;
      }).filter((item) => item !== '');
      const selector = [...preludes].join(' ');
      preludes.pop();
      if (declarations.length > 0) rules.push({ selector, declarations });
      buffer = '';
    } else {
      buffer += char;
    }
  }
  return rules;
}

const TOKENS_FILE = 'tokens.css';
const LIGHT_SELECTOR = ':root';
const MEDIA_SELECTOR = '@media (prefers-color-scheme: dark) :root:not([data-theme="light"])';
const PINNED_SELECTOR = ':root[data-theme="dark"]';
const nameOf = (declaration: string): string => declaration.slice(0, declaration.indexOf(':'));

function tokenRules(site: BuiltSite): Map<string, readonly string[]> | null {
  const file = site.css.find((item) => item.file === TOKENS_FILE);
  if (file === undefined) return null;
  return new Map(cssRules(file.text).map((rule) => [rule.selector, rule.declarations]));
}

// AC-39: the dark values written twice must be the same list, under both R8 selectors, each block
// also switching color-scheme, and every dark token must override one the light block declares.
export function themeTokenBlocksRule(site: BuiltSite, _context: CheckContext): Finding[] {
  const rule = 'theme-token-blocks' as const;
  const route = fileRoute(TOKENS_FILE);
  const rules = tokenRules(site);
  if (rules === null) return [{ rule, route, text: 'dist/tokens.css is missing' }];
  const texts: string[] = [];
  const light = rules.get(LIGHT_SELECTOR) ?? [];
  const media = rules.get(MEDIA_SELECTOR);
  const pinned = rules.get(PINNED_SELECTOR);
  if (!light.includes('color-scheme: light')) texts.push('the :root block does not declare color-scheme: light');
  if (media === undefined) texts.push('tokens.css has no :root:not([data-theme="light"]) block under @media (prefers-color-scheme: dark)');
  if (pinned === undefined) texts.push('tokens.css has no :root[data-theme="dark"] block');
  if (media !== undefined && pinned !== undefined) {
    if (media.join(';') !== pinned.join(';')) texts.push('the dark blocks under the media query and under :root[data-theme="dark"] differ');
    else if (!media.includes('color-scheme: dark')) texts.push('the dark blocks do not declare color-scheme: dark');
    const lightNames = new Set(light.map(nameOf));
    for (const name of media.map(nameOf)) {
      if (name !== 'color-scheme' && !lightNames.has(name)) texts.push(`the dark blocks declare ${name}, which the :root block does not`);
    }
  }
  return texts.map((text) => ({ rule, route, text }));
}

// AC-63 names six type steps the built CSS must carry; two of them are fixed sizes (UI-SPEC 6).
const R14_TYPE_TOKENS: readonly (readonly [string, string | null])[] = [
  ['--text-lede', null],
  ['--text-intro', null],
  ['--text-narrative-headline', null],
  ['--text-small', '0.9375rem'],
  ['--text-mono-value', '0.8125rem'],
  ['--text-schedule-compact', null],
];

export function typeTokenDeclaredRule(site: BuiltSite, _context: CheckContext): Finding[] {
  const rule = 'type-token-declared' as const;
  const route = fileRoute(TOKENS_FILE);
  const rules = tokenRules(site);
  if (rules === null) return [{ rule, route, text: 'dist/tokens.css is missing' }];
  const values = new Map((rules.get(LIGHT_SELECTOR) ?? []).map((declaration) => [nameOf(declaration), declaration.slice(declaration.indexOf(':') + 1).trim()]));
  return R14_TYPE_TOKENS.flatMap(([name, expected]): Finding[] => {
    const value = values.get(name);
    if (value === undefined || value === '') return [{ rule, route, text: `tokens.css declares no ${name} on :root` }];
    return expected === null || value === expected ? [] : [{ rule, route, text: `${name} is ${value}, ${expected} expected` }];
  });
}

const isStylesheet = (element: BuiltElement): boolean => element.tag === 'link' && (element.attrs.rel ?? '').toLowerCase().split(/\s+/).includes('stylesheet');
const isInlineScript = (element: BuiltElement): boolean => element.tag === 'script' && element.attrs.src === undefined;
const scriptText = (element: BuiltElement): string => element.children.filter((child): child is string => typeof child === 'string').join('');
const headOf = (page: BuiltPage): BuiltElement | undefined =>
  page.root.children.find((child): child is BuiltElement => typeof child !== 'string' && child.tag === 'head');

function headFindings(page: BuiltPage, headScript: string): string[] {
  const head = headOf(page);
  let order = 0;
  let firstSheet = Number.POSITIVE_INFINITY;
  let theme: { readonly order: number; readonly element: BuiltElement } | undefined;
  if (head !== undefined) {
    walk(head, (element) => {
      order += 1;
      if (isStylesheet(element)) firstSheet = Math.min(firstSheet, order);
      if (theme === undefined && isInlineScript(element)) theme = { order, element };
    });
  }
  if (theme === undefined) return ['the head holds no inline theme script'];
  const texts: string[] = [];
  const { attrs } = theme.element;
  if (scriptText(theme.element) !== headScript) texts.push('the inline head script is not the HEAD_SCRIPT text');
  if (attrs.defer !== undefined) texts.push('the theme script carries defer');
  if (attrs.async !== undefined) texts.push('the theme script carries async');
  if ((attrs.type ?? '').trim().toLowerCase() === 'module') texts.push('the theme script carries type="module"');
  if (firstSheet < theme.order) texts.push('the theme script follows a stylesheet link');
  return texts;
}

// AC-40 and Pitfall 4: the stored theme applies before first paint only if the head script runs,
// in parsing order, before the first stylesheet, on every page.
export function headScriptOrderRule(site: BuiltSite, context: CheckContext): Finding[] {
  return site.pages.flatMap((page) => headFindings(page, context.headScript).map((text) => ({ rule: 'head-script-order' as const, route: page.route, text })));
}

const CSP_HASH = /'sha256-([A-Za-z0-9+/=]+)'/g;

function listedHashes(headers: string): Set<string> {
  const policy = headers.split(/\r?\n/).find((line) => /^\s*content-security-policy\s*:/i.test(line)) ?? '';
  const scriptSrc = policy.split(';').find((directive) => directive.trim().toLowerCase().startsWith('script-src')) ?? '';
  return new Set([...scriptSrc.matchAll(CSP_HASH)].map((match) => match[1] ?? ''));
}

// D-149 both ways: every inline script the build ships is allowed by exactly a hash _headers lists,
// and _headers allows nothing the build does not ship.
export function scriptHashRule(site: BuiltSite, _context: CheckContext): Finding[] {
  const rule = 'script-hash' as const;
  if (site.headers === null) return [{ rule, route: fileRoute('_headers'), text: 'dist/_headers is missing' }];
  const listed = listedHashes(site.headers);
  const shipped = new Set<string>();
  const findings: Finding[] = [];
  for (const page of site.pages) {
    for (const script of page.scripts) {
      if (script.src !== null) continue;
      const hash = scriptHash(script.text);
      shipped.add(hash);
      if (!listed.has(hash)) findings.push({ rule, route: page.route, text: `an inline script hashes to sha256-${hash}, which _headers does not list` });
    }
  }
  for (const hash of listed) {
    if (!shipped.has(hash)) findings.push({ rule, route: fileRoute('_headers'), text: `_headers lists sha256-${hash}, which no inline script has` });
  }
  return findings;
}

const isDataUrl = (url: string): boolean => url.trim().toLowerCase().startsWith('data:');

// C6: under default-src 'self' the browser blocks a style attribute, a style element and a data:
// asset, so each would break only on the real host; the built files are checked for all three.
export function noInlineStyleRule(site: BuiltSite, _context: CheckContext): Finding[] {
  const rule = 'no-inline-style' as const;
  const onPages = site.pages.flatMap((page) => {
    const texts: string[] = [];
    walk(page.root, (element) => {
      if (element.attrs.style !== undefined) texts.push(`a style attribute on <${element.tag}>`);
      if (element.tag === 'style') texts.push('a style element');
    });
    for (const reference of page.references) {
      if (urlsOf(reference.attr, reference.value).some(isDataUrl)) texts.push(`${reference.tag} ${reference.attr} holds a data: URL`);
    }
    return texts.map((text) => ({ rule, route: page.route, text }));
  });
  const inCss = site.css.flatMap((file) => (cssUrls(file.text).some(isDataUrl) ? [{ rule, route: fileRoute(file.file), text: 'a CSS url() holds a data: URL' }] : []));
  return [...onPages, ...inCss];
}

// Workers limits: 20,000 files per version on the Free plan and 25 MiB per file (AC-62).
const MAX_FILES = 20_000;
const MAX_FILE_BYTES = 25 * 1024 * 1024;

export type BudgetViolation =
  | { readonly kind: 'count'; readonly count: number; readonly limit: number }
  | { readonly kind: 'size'; readonly path: string; readonly bytes: number; readonly limit: number };

export function checkFileBudget(files: readonly { readonly path: string; readonly bytes: number }[]): BudgetViolation[] {
  const violations: BudgetViolation[] = [];
  if (files.length >= MAX_FILES) violations.push({ kind: 'count', count: files.length, limit: MAX_FILES });
  for (const file of files) {
    if (file.bytes >= MAX_FILE_BYTES) violations.push({ kind: 'size', path: file.path, bytes: file.bytes, limit: MAX_FILE_BYTES });
  }
  return violations;
}

type Rule = (site: BuiltSite, context: CheckContext) => Finding[];

const RULES: Readonly<Record<RuleId, Rule>> = {
  'dash': dashRule,
  'ses-rate-wording': sesRateWordingRule,
  'ses-percentage-link': sesPercentageLinkRule,
  'reply-promise': replyPromiseRule,
  'console-delete': consoleDeleteRule,
  'unit-figure': unitFigureRule,
  'banned-name': bannedNameRule,
  'region-claim': regionClaimRule,
  'exact-30-days': exactThirtyDaysRule,
  'pre-r6-words': preR6WordsRule,
  'forms-cookies-analytics': formsCookiesAnalyticsRule,
  'third-party-reference': thirdPartyReferenceRule,
  'page-metadata': pageMetadataRule,
  'sitemap': sitemapRule,
  'robots': robotsRule,
  'theme-token-blocks': themeTokenBlocksRule,
  'head-script-order': headScriptOrderRule,
  'script-hash': scriptHashRule,
  'no-inline-style': noInlineStyleRule,
  'type-token-declared': typeTokenDeclaredRule,
};

// Every rule runs over the whole site and every hit is kept, so one report names them all.
export function runBuiltChecks(site: BuiltSite, context: CheckContext): Finding[] {
  return RULE_IDS.flatMap((id) => RULES[id](site, context));
}
