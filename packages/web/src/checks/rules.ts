import type { Provenance } from '@fothering/core/records';
import {
  ANALYTICS_PATTERNS,
  EXACT_30_DAY_PATTERNS,
  LANDING_SECTIONS,
  LEDE_TERMS,
  LIMITS_FIXED_ROWS,
  LIMITS_REPLAY_ROW,
  NO_MEASURED_NUMBER_SENTENCE,
  PRE_R6_PATTERNS,
  REGION_CLAIM_PATTERNS,
  THEME_RADIO_LIMIT,
} from '../site/content.js';
import { PROVENANCE_LABELS } from '../site/labels.js';
import type { ReplayView } from '../site/replay-view.js';
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
  'switch-markup',
  'lede',
  'landing-sections',
  'limits',
  'no-ellipsis',
  'replay-page',
  'replay-word-count',
  'replay-summary',
  'replay-lanes',
  'provenance-wording',
  'provider-label',
  'replay-panels',
  'type-token-use',
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
  // The committed replay artifact's provenance, which names the limits table's replay state.
  readonly provenance: Provenance;
  // The replay view of that artifact, which the replay rules hold the built page to.
  readonly replay: ReplayView;
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

const THEME_CHOICES: readonly (readonly [string, string])[] = [['device', 'Device'], ['light', 'Light'], ['dark', 'Dark']];

function elementsIn(root: BuiltElement, tag: string): BuiltElement[] {
  const found: BuiltElement[] = [];
  walk(root, (element) => {
    if (element.tag === tag && !element.inSvg && element !== root) found.push(element);
  });
  return found;
}

interface ThemeRadio {
  readonly attrs: Readonly<Record<string, string>>;
  readonly label: string;
}

// A radio's label is the label wrapping it or the one whose for names its id.
function themeRadios(fieldset: BuiltElement, page: BuiltPage): ThemeRadio[] {
  const forLabels = new Map(elementsIn(page.root, 'label').filter((label) => label.attrs.for !== undefined).map((label) => [label.attrs.for ?? '', textOf(label)]));
  const radios: ThemeRadio[] = [];
  const visit = (element: BuiltElement, wrapping: BuiltElement | null): void => {
    const label = element.tag === 'label' ? element : wrapping;
    if (element.tag === 'input' && (element.attrs.type ?? '').toLowerCase() === 'radio') {
      const byFor = element.attrs.id === undefined ? undefined : forLabels.get(element.attrs.id);
      radios.push({ attrs: element.attrs, label: byFor ?? (label === null ? '' : textOf(label)) });
    }
    for (const child of element.children) {
      if (typeof child !== 'string') visit(child, label);
    }
  };
  visit(fieldset, null);
  return radios;
}

function radioFindings(radios: readonly ThemeRadio[]): string[] {
  if (radios.length !== THEME_CHOICES.length) return [`the theme fieldset holds ${radios.length} radio inputs, ${THEME_CHOICES.length} expected`];
  const labels = radios.map((radio) => radio.label);
  const expectedLabels = THEME_CHOICES.map(([, label]) => label);
  if (labels.join(', ') !== expectedLabels.join(', ')) return [`the theme radios read ${labels.join(', ')}; ${expectedLabels.join(', ')} expected`];
  const texts: string[] = [];
  radios.forEach((radio, index) => {
    const [value, label] = THEME_CHOICES[index] ?? ['', ''];
    if (radio.attrs.name !== 'theme') texts.push(`the ${label} radio is not named theme`);
    if (radio.attrs.value !== value) texts.push(`the ${label} radio has the value ${radio.attrs.value ?? 'none'}, ${value} expected`);
    const checked = radio.attrs.checked !== undefined;
    if (value === 'device' && !checked) texts.push('the Device radio is not checked in the markup');
    if (value !== 'device' && checked) texts.push(`the ${label} radio is checked in the markup`);
  });
  return texts;
}

function switchFindings(page: BuiltPage): string[] {
  const headers = elementsIn(page.root, 'header');
  if (headers.length === 0) return ['the page has no header element'];
  const fieldsets = headers.flatMap((header) => elementsIn(header, 'fieldset'));
  if (fieldsets.length === 0) return ['the header holds no theme fieldset'];
  if (fieldsets.length > 1) return [`the header holds ${fieldsets.length} fieldsets, 1 expected`];
  const [fieldset] = fieldsets;
  if (fieldset === undefined) return [];
  const legend = fieldset.children.find((child): child is BuiltElement => typeof child !== 'string' && child.tag === 'legend');
  const texts = legend === undefined || textOf(legend) === '' ? ['the theme fieldset has no legend'] : [];
  return [...texts, ...radioFindings(themeRadios(fieldset, page))];
}

// AC-38: Device sits first and checked in the markup, so a visitor with nothing stored, or with
// JavaScript off, reads the switch as following the OS.
export function switchMarkupRule(site: BuiltSite, _context: CheckContext): Finding[] {
  return site.pages.flatMap((page) => switchFindings(page).map((text) => ({ rule: 'switch-markup' as const, route: page.route, text })));
}

const LANDING_ROUTE = '/';

// A rule about the landing reports its absence rather than passing a build that has no landing.
function onLanding(site: BuiltSite, rule: RuleId, findings: (page: BuiltPage) => string[]): Finding[] {
  const landing = site.pages.find((page) => page.route === LANDING_ROUTE);
  const texts = landing === undefined ? [`the build has no landing page at ${LANDING_ROUTE}`] : findings(landing);
  return texts.map((text) => ({ rule, route: LANDING_ROUTE, text }));
}

// A letter, digit or underscore on either side means the term sits inside a longer word, so agents
// and reagent do not name agent. The reader has already collapsed spaces and line breaks to one.
const WORD_CHAR = '[\\p{L}\\p{N}_]';
const wholePhrase = (term: string): RegExp =>
  new RegExp(`(?<!${WORD_CHAR})${term.split(/\s+/).map(escapeRegExp).join(' ')}(?!${WORD_CHAR})`, 'u');

function ledeFindings(page: BuiltPage): string[] {
  const ledes = page.markers.get('data-lede') ?? [];
  const [lede] = ledes;
  if (lede === undefined) return ['the landing has no data-lede element'];
  if (ledes.length > 1) return [`the landing has ${ledes.length} data-lede elements, 1 expected`];
  const text = textOf(lede);
  if (text === '') return ['the lede element is empty'];
  return LEDE_TERMS.filter((term) => !wholePhrase(term).test(text)).map((term) => `the lede does not name ${term} as a whole phrase`);
}

// AC-2, AC-E1 to AC-E3: matched on the lede's rendered text, so entities, non-breaking spaces,
// line breaks and inline elements between the words never decide the verdict.
export function ledeRule(site: BuiltSite, _context: CheckContext): Finding[] {
  return onLanding(site, 'lede', ledeFindings);
}

const hasMarker = (element: BuiltElement, marker: string): boolean => some(element, (node) => node.attrs[marker] !== undefined);

function sectionFindings(page: BuiltPage): string[] {
  const texts: string[] = [];
  for (const section of LANDING_SECTIONS) {
    const count = elementsIn(page.root, section.level).filter((heading) => textOf(heading) === section.heading).length;
    if (count === 0) texts.push(`the landing has no ${section.level} reading "${section.heading}"`);
    else if (count > 1) texts.push(`the landing has ${count} ${section.level} headings reading "${section.heading}", 1 expected`);
  }
  const tables = elementsIn(page.root, 'table');
  const others = tables.filter((table) => !hasMarker(table, 'data-limits-row')).length;
  if (others > 0) texts.push(`the landing holds ${others} table${others === 1 ? '' : 's'} besides the limits table`);
  if (tables.length - others > 1) texts.push(`the landing holds ${tables.length - others} limits tables, 1 expected`);
  return texts;
}

// AC-1 and AC-P15: the four headed sections, and no comparison table beside the limits table.
export function landingSectionsRule(site: BuiltSite, _context: CheckContext): Finding[] {
  return onLanding(site, 'landing-sections', sectionFindings);
}

function markedIn(root: BuiltElement, marker: string): BuiltElement[] {
  const found: BuiltElement[] = [];
  walk(root, (element) => {
    if (element.attrs[marker] !== undefined) found.push(element);
  });
  return found;
}

const LIMITS_PARTS = [LIMITS_REPLAY_ROW.id, ...LIMITS_FIXED_ROWS.map((row) => row.id)];

function rowState(row: BuiltElement): string {
  const [state] = markedIn(row, 'data-limits-state');
  return state === undefined ? '' : textOf(state);
}

function limitsFindings(page: BuiltPage, provenance: Provenance): string[] {
  const sections = page.markers.get('data-limits') ?? [];
  const [section] = sections;
  if (section === undefined) return ['the landing has no limits section (data-limits)'];
  if (sections.length > 1) return [`the landing has ${sections.length} limits sections, 1 expected`];
  const texts = textOf(section).includes(NO_MEASURED_NUMBER_SENTENCE) ? [] : ['the limits section does not say that this site carries no measured number'];
  const rows = markedIn(section, 'data-limits-row');
  const idOf = (row: BuiltElement): string => row.attrs['data-limits-row'] ?? '';
  for (const part of LIMITS_PARTS) {
    const count = rows.filter((row) => idOf(row) === part).length;
    if (count === 0) texts.push(`the limits section has no row for ${part}`);
    else if (count > 1) texts.push(`the limits section has ${count} rows for ${part}, 1 expected`);
  }
  for (const row of rows) {
    if (!LIMITS_PARTS.includes(idOf(row))) texts.push(`the limits section has a row for ${idOf(row) || 'an unnamed part'}, which is not a listed part`);
    if (rowState(row) === '') texts.push(`the limits row ${idOf(row)} has no state`);
  }
  const replay = rows.find((row) => idOf(row) === LIMITS_REPLAY_ROW.id);
  const expected = PROVENANCE_LABELS[provenance].limitsState;
  const state = replay === undefined ? '' : rowState(replay);
  if (state !== '' && state !== expected) texts.push(`the replay row reads ${state}; the label map gives ${expected} for a ${provenance} artifact`);
  return texts;
}

// AC-3: one row per part, each with a state, the replay row's state from the label map for the
// committed artifact, and the sentence that the site carries no measured number.
export function limitsRule(site: BuiltSite, context: CheckContext): Finding[] {
  return onLanding(site, 'limits', (page) => limitsFindings(page, context.provenance));
}

const TRUNCATIONS: readonly (readonly [RegExp, string])[] = [
  [/text-overflow\s*:[^;}]*\bellipsis\b/i, 'text-overflow: ellipsis'],
  [/(?:^|[\s;{])(?:-webkit-)?line-clamp\s*:/i, 'a line clamp'],
];

// UI-SPEC E14: long text wraps; nothing on the site is cut short behind an ellipsis.
export function noEllipsisRule(site: BuiltSite, _context: CheckContext): Finding[] {
  return site.css.flatMap((file) =>
    TRUNCATIONS.filter(([pattern]) => pattern.test(file.text)).map(([, what]) => ({ rule: 'no-ellipsis' as const, route: fileRoute(file.file), text: `the CSS truncates text with ${what}` })));
}

export const REPLAY_ROUTE = '/replay/';
export const REPLAY_WORD_CAP = 238;

const COUNTED_KINDS = ['summary', 'step', 'tag', 'caption'] as const;
const COUNTED = 'data-wordcount';
const STEPS = 'data-steps';
const outsideSvg = (element: BuiltElement): string => textOf(element, (node) => node.tag === 'svg');

const replayPage = (site: BuiltSite): BuiltPage | undefined => site.pages.find((page) => page.route === REPLAY_ROUTE);

// The other replay rules stay silent while the page is absent, so a build without it reports one
// finding, under replay-page, rather than one per rule.
function onReplay(site: BuiltSite, rule: RuleId, findings: (page: BuiltPage) => string[]): Finding[] {
  const replay = replayPage(site);
  return replay === undefined ? [] : findings(replay).map((text) => ({ rule, route: REPLAY_ROUTE, text }));
}

export function replayPageRule(site: BuiltSite, _context: CheckContext): Finding[] {
  return replayPage(site) === undefined ? [{ rule: 'replay-page', route: REPLAY_ROUTE, text: `the build has no replay page at ${REPLAY_ROUTE}` }] : [];
}

// AC-E9: the reader has stripped tags and decoded entities, so a word is what lies between runs of
// whitespace (JavaScript's \s takes in the non-breaking space), and an identifier with dots or
// hyphens stays one word.
export function countWords(text: string): number {
  const normalized = text.replace(/\s+/g, ' ').trim();
  return normalized === '' ? 0 : normalized.split(' ').length;
}

// A counted element inside another counted element is counted once, with its outermost container.
function outermostCounted(root: BuiltElement): BuiltElement[] {
  const found: BuiltElement[] = [];
  const visit = (element: BuiltElement): void => {
    if (element.attrs[COUNTED] !== undefined) {
      found.push(element);
      return;
    }
    for (const child of element.children) {
      if (typeof child !== 'string') visit(child);
    }
  };
  visit(root);
  return found;
}

export function countReplayWords(page: BuiltPage): number {
  return outermostCounted(page.root).reduce((sum, element) => sum + countWords(outsideSvg(element)), 0);
}

function wordCountFindings(page: BuiltPage): string[] {
  const counted = page.markers.get(COUNTED) ?? [];
  if (counted.length === 0) return [`the replay page has no counted element (${COUNTED})`];
  const kinds = counted.map((element) => element.attrs[COUNTED] ?? '');
  const texts = kinds.filter((kind) => !(COUNTED_KINDS as readonly string[]).includes(kind))
    .map((kind) => `${COUNTED}="${kind}" is not one of ${COUNTED_KINDS.join(', ')}`);
  for (const kind of COUNTED_KINDS) {
    if (!kinds.includes(kind)) texts.push(`the replay page counts no ${kind} (${COUNTED}="${kind}")`);
  }
  const words = countReplayWords(page);
  if (words > REPLAY_WORD_CAP) texts.push(`the replay counts ${String(words)} words, ${String(REPLAY_WORD_CAP)} at most`);
  return texts;
}

// AC-11: the summary, the four step containers, the tag and the caption, SVG text excluded.
export function replayWordCountRule(site: BuiltSite, _context: CheckContext): Finding[] {
  return onReplay(site, 'replay-word-count', wordCountFindings);
}

function parentsOf(root: BuiltElement): Map<BuiltElement, BuiltElement> {
  const parents = new Map<BuiltElement, BuiltElement>();
  walk(root, (element) => {
    for (const child of element.children) {
      if (typeof child !== 'string') parents.set(child, element);
    }
  });
  return parents;
}

function ancestorWith(element: BuiltElement, parents: ReadonlyMap<BuiltElement, BuiltElement>, test: (node: BuiltElement) => boolean): BuiltElement | undefined {
  for (let node = parents.get(element); node !== undefined; node = parents.get(node)) {
    if (test(node)) return node;
  }
  return undefined;
}

const countedAs = (page: BuiltPage, kind: string): BuiltElement[] => (page.markers.get(COUNTED) ?? []).filter((element) => element.attrs[COUNTED] === kind);

function summaryFindings(page: BuiltPage, view: ReplayView): string[] {
  const summaries = countedAs(page, 'summary');
  const [summary] = summaries;
  if (summary === undefined) return [`the replay page has no summary (${COUNTED}="summary")`];
  if (summaries.length > 1) return [`the replay page has ${String(summaries.length)} summaries, 1 expected`];
  const texts: string[] = [];
  if (ancestorWith(summary, parentsOf(page.root), (node) => node.attrs[STEPS] !== undefined) !== undefined) {
    texts.push('the summary sits inside a step panel, so it does not show on every step');
  }
  const text = outsideSvg(summary);
  const [, , pause, reopen] = view.summary;
  if (!text.includes(view.tag.lane)) texts.push(`the summary does not name the lane ${view.tag.lane}`);
  if (!text.includes(view.tag.cause)) texts.push(`the summary does not name the cause ${view.tag.cause}`);
  if (pause !== undefined && !text.includes(pause.text)) texts.push(`the summary does not name the pause with its read-back: "${pause.text}"`);
  if (reopen !== undefined && !text.includes(reopen.text)) texts.push(`the summary does not name the reopen with its read-back: "${reopen.text}"`);
  return texts;
}

// AC-5: one summary, outside every step panel, naming the lane, the cause, the pause with its
// read-back and the reopen with its read-back.
export function replaySummaryRule(site: BuiltSite, context: CheckContext): Finding[] {
  return onReplay(site, 'replay-summary', (page) => summaryFindings(page, context.replay));
}

const panelsOf = (page: BuiltPage): BuiltElement[] => countedAs(page, 'step');

function lanesFindings(page: BuiltPage, view: ReplayView): string[] {
  const panels = panelsOf(page);
  const expected: readonly (readonly [string, string])[] = [['3', view.lanesLines.paused], ['4', view.lanesLines.reopened]];
  return expected.flatMap(([step, line]) => {
    const panel = panels.find((element) => element.attrs[STEPS] === step);
    if (panel === undefined) return [`the replay page has no step ${step} panel`];
    return outsideSvg(panel).includes(line) ? [] : [`step ${step} does not read "${line}" outside the drawing`];
  });
}

// AC-9: steps 3 and 4 name the paused lane and every other artifact lane as open in page text,
// never only in the drawing, so the lanes line carries the lane schedule.
export function replayLanesRule(site: BuiltSite, context: CheckContext): Finding[] {
  return onReplay(site, 'replay-lanes', (page) => lanesFindings(page, context.replay));
}

const CAPTURE_WORDS = /\b(?:record(?:ed|ing)|captur(?:e|ed|es|ing))\b/gi;
const LABEL_ATTRS = ['aria-label', 'alt', 'title'] as const;
const FIXTURE_PROVENANCES: ReadonlySet<Provenance> = new Set(['doc-derived', 'generated']);

function labelTexts(page: BuiltPage): string[] {
  const labels: string[] = [];
  walk(page.root, (element) => {
    for (const name of LABEL_ATTRS) {
      const value = element.attrs[name];
      if (value !== undefined) labels.push(value);
    }
  });
  return labels;
}

function wordingFindings(page: BuiltPage, provenance: Provenance): string[] {
  const texts = [page.text, ...labelTexts(page)].flatMap((text) =>
    [...text.matchAll(CAPTURE_WORDS)].map((match) => `the replay page says "${excerpt(text, match.index, match[0].length)}" about a ${provenance} artifact`));
  const { timeWording } = PROVENANCE_LABELS[provenance];
  if (!page.textOutsideSvg.includes(timeWording)) texts.push(`the replay page does not carry the time wording "${timeWording}"`);
  return texts;
}

// AC-16, AC-P1, AC-P4: a fixture is never called recorded or captured anywhere on the replay, in
// text or in a label, and its times are called illustrative. A simulator or live artifact carries
// its own label map wording.
export function provenanceWordingRule(site: BuiltSite, context: CheckContext): Finding[] {
  if (!FIXTURE_PROVENANCES.has(context.provenance)) return [];
  return onReplay(site, 'provenance-wording', (page) => wordingFindings(page, context.provenance));
}

const UNCONFIRMED = /\bunconfirmed\b/i;

function providerFindings(page: BuiltPage, view: ReplayView): string[] {
  const expected = view.schedule.rows.filter((row) => row.dimension === 'Provider');
  const marked = page.markers.get('data-provider-row') ?? [];
  if (marked.length !== expected.length) return [`the replay page marks ${String(marked.length)} provider row(s); the artifact has ${String(expected.length)}`];
  // Rows render in the artifact's order, so the nth marked row is the nth provider row.
  return expected.flatMap((row, index) => {
    const element = marked[index];
    if (element === undefined) return [];
    const text = clip(outsideSvg(element));
    if (row.sourceUrl === undefined) return UNCONFIRMED.test(text) ? [] : [`the provider row "${text}" has no confirming source and no unconfirmed label`];
    return linksTo(element, row.sourceUrl) ? [] : [`the provider row "${text}" shows its confirming source ${row.sourceUrl} as plain text, not a link`];
  });
}

// AC-18 and AC-P13: an unconfirmed provider mapping says so, and a confirmed one links its source.
export function providerLabelRule(site: BuiltSite, context: CheckContext): Finding[] {
  return onReplay(site, 'provider-label', (page) => providerFindings(page, context.replay));
}

const HIDING_ATTRS = ['hidden', 'aria-hidden'] as const;
const hidingAttr = (element: BuiltElement): string | undefined => HIDING_ATTRS.find((name) => element.attrs[name] !== undefined && element.attrs[name] !== 'false');

function panelFindings(page: BuiltPage): string[] {
  const panels = panelsOf(page);
  if (panels.length !== COUNTED_KINDS.length) return [`the replay page has ${String(panels.length)} step panels, 4 expected`];
  const steps = panels.map((panel) => panel.attrs[STEPS] ?? '');
  const texts = steps.join(', ') === '1, 2, 3, 4' ? [] : [`the step panels read ${steps.join(', ')} in HTML order; 1, 2, 3, 4 expected`];
  const parents = parentsOf(page.root);
  panels.forEach((panel, index) => {
    const hider = hidingAttr(panel) === undefined ? ancestorWith(panel, parents, (node) => hidingAttr(node) !== undefined) : panel;
    const attr = hider === undefined ? undefined : hidingAttr(hider);
    if (hider !== undefined && attr !== undefined) texts.push(`step panel ${steps[index] ?? ''} is hidden from the accessibility tree by ${attr} on <${hider.tag}>`);
  });
  return texts;
}

// AC-E7 and AC-10's static half: the four panels sit in the HTML in step order and nothing in the
// markup hides them, so CSS alone decides what shows and removing the js class shows all four.
export function replayPanelsRule(site: BuiltSite, _context: CheckContext): Finding[] {
  return onReplay(site, 'replay-panels', panelFindings);
}

// AC-63's use half. tokens.css itself writes var(--text-small) for the compact alias, which is a
// declaration, so only the other sheets count as using a name.
export function typeTokenUseRule(site: BuiltSite, _context: CheckContext): Finding[] {
  const sheets = site.css.filter((file) => file.file !== TOKENS_FILE).map((file) => file.text);
  return R14_TYPE_TOKENS.filter(([name]) => !sheets.some((css) => new RegExp(`var\\(\\s*${escapeRegExp(name)}\\s*[,)]`).test(css)))
    .map(([name]) => ({ rule: 'type-token-use' as const, route: fileRoute('*.css'), text: `the built CSS never uses ${name} through var()` }));
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
  'switch-markup': switchMarkupRule,
  'lede': ledeRule,
  'landing-sections': landingSectionsRule,
  'limits': limitsRule,
  'no-ellipsis': noEllipsisRule,
  'replay-page': replayPageRule,
  'replay-word-count': replayWordCountRule,
  'replay-summary': replaySummaryRule,
  'replay-lanes': replayLanesRule,
  'provenance-wording': provenanceWordingRule,
  'provider-label': providerLabelRule,
  'replay-panels': replayPanelsRule,
  'type-token-use': typeTokenUseRule,
};

// Every rule runs over the whole site and every hit is kept, so one report names them all.
export function runBuiltChecks(site: BuiltSite, context: CheckContext): Finding[] {
  return RULE_IDS.flatMap((id) => RULES[id](site, context));
}
