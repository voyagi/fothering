import type { Provenance } from '@fothering/core/records';
import {
  accessibilityStatements,
  ANALYTICS_PATTERNS,
  CONTACT_ADDRESS,
  EXACT_30_DAY_PATTERNS,
  FORGET_DOC,
  HAND_CHECK_CRITERIA,
  HAND_CHECK_RESULT_LABELS,
  LANDING_SECTIONS,
  LEDE_TERMS,
  LIMITS_FIXED_ROWS,
  LIMITS_REPLAY_ROW,
  NO_MEASURED_NUMBER_SENTENCE,
  NOT_YET_NOTICE,
  ONE_CALLER_SENTENCE,
  PERMISSION_COLUMNS,
  PRE_R6_PATTERNS,
  REGION_CLAIM_PATTERNS,
  RESOURCE_COLUMNS,
  RESOURCE_REMOVAL,
  THEME_RADIO_LIMIT,
  type ForbiddenClaim,
  type Statement,
} from '../site/content.js';
import { tokenRuns } from '../site/command-units.js';
import { PROVENANCE_LABELS } from '../site/labels.js';
import { hasPauseGrant, permissionKey, permissionSchedules } from '../site/permissions-view.js';
import type { ReplayView } from '../site/replay-view.js';
import { isOfferedCommand, removedByText, type DeployCommand, type ForgetCommand } from '../site/repo-facts.js';
import { resourceRows } from '../site/resources-view.js';
import { sitemapUrls, type SiteRoute } from '../site/route-list.js';
import { scriptHash } from '../theme/head-script.js';
import { normalizeText, NOT_FOUND_ROUTE as NOT_FOUND_PAGE, textOf, walk, type BuiltElement, type BuiltPage, type BuiltSite } from './built-site.js';

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
  'identifier-break',
  'command-pair',
  'deploy-page',
  'deploy-commands',
  'deploy-permissions',
  'deploy-resources',
  'deploy-deny',
  'deploy-notice',
  'one-caller',
  'privacy-page',
  'privacy-statements',
  'stored-field-rows',
  'website-facts',
  'six-rights',
  'forget-command',
  'no-delete-control',
  'model-role-present',
  'model-role-required',
  'model-role-forbidden',
  'model-id',
  'accessibility-page',
  'accessibility-statement',
  'readout-number',
  'font-preload',
  'contact-address',
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
  // The committed sources the deploy page is generated from, which the deploy rules read it against.
  readonly deploy: DeployFacts;
  // The statement lists and repository facts the privacy and AI page is held to.
  readonly privacy: PrivacyFacts;
}

export interface PrivacyFacts {
  // The stored-field map's identifying entries, in map order.
  readonly storedFields: readonly { readonly path: string; readonly identifies: string; readonly row: string }[];
  readonly region: string;
  readonly modelId: string;
  // Each list as the page shows it: the Region filled in and code spans as plain text.
  readonly required: readonly Statement[];
  readonly website: readonly Statement[];
  readonly rights: readonly string[];
  // The runtime-role sentence is in this list only while the snapshot's runtime role holds no data action.
  readonly modelRequired: readonly Statement[];
  readonly modelForbidden: readonly ForbiddenClaim[];
  readonly forget: ForgetCommand;
}

export interface DeployFacts {
  // packages/infra/permissions.json and resources.json as parsed, before any view checks them.
  readonly permissions: readonly unknown[];
  readonly resources: readonly unknown[];
  readonly reasons: Readonly<Record<string, string>>;
  // README's Deploy and remove command lines and the script names package.json defines.
  readonly commands: readonly DeployCommand[];
  readonly scripts: readonly string[];
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

const LABEL_ATTRS = ['aria-label', 'alt', 'title'] as const;
// What a search result or a shared link shows in place of the page.
const SHOWN_METAS: readonly (readonly [string, string])[] = [['name', 'description'], ['property', 'og:title'], ['property', 'og:description']];

// The labels a screen reader speaks, outside any subtree the caller skips.
function labelTexts(element: BuiltElement, skip: (element: BuiltElement) => boolean = () => false): string[] {
  if (skip(element)) return [];
  const own = LABEL_ATTRS.flatMap((name) => (element.attrs[name] === undefined ? [] : [normalizeText(element.attrs[name])]));
  return [...own, ...element.children.flatMap((child) => (typeof child === 'string' ? [] : labelTexts(child, skip)))];
}

function shownMetaTexts(page: BuiltPage): string[] {
  return page.metas.flatMap((meta) =>
    SHOWN_METAS.some(([key, value]) => meta[key] === value) && meta.content !== undefined ? [normalizeText(meta.content)] : []);
}

// A claim a reader meets anywhere counts: the page text, every label, and the shown metas. Each is
// matched on its own, so no phrase is made from the end of one and the start of the next.
const claimTexts = (page: BuiltPage, skip?: (element: BuiltElement) => boolean): string[] =>
  [skip === undefined ? page.text : textOf(page.root, skip), ...labelTexts(page.root, skip), ...shownMetaTexts(page)];

function patternsIn(rule: RuleId, site: BuiltSite, patterns: readonly RegExp[], textsOfPage: (page: BuiltPage) => readonly string[] = (page) => claimTexts(page)): Finding[] {
  return site.pages.flatMap((page) =>
    textsOfPage(page).flatMap((text) => patterns.flatMap((pattern) => matchesIn(rule, page.route, text, pattern))));
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
  return patternsIn('unit-figure', site, UNIT_FIGURES, (page) => claimTexts(page, exempt));
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

// Each file a built @font-face rule loads, with the family it declares.
function fontFaceFiles(site: BuiltSite): Map<string, string> {
  const files = new Map<string, string>();
  for (const sheet of site.css) {
    for (const match of sheet.text.matchAll(/@font-face\s*\{([^}]*)\}/gi)) {
      const body = match[1] ?? '';
      const family = /font-family\s*:\s*([^;]+)/i.exec(body)?.[1]?.trim().replace(/^(['"])(.*)\1$/, '$2');
      if (family !== undefined) for (const url of cssUrls(body)) files.set(url, family);
    }
  }
  return files;
}

// The layout preloads one file per family, because a face that swaps in only once the stylesheet is
// parsed lands after the first paint and shifts the first band (layout shift about 0.2 on /deploy/ and
// /replay/). Read from the built pages, so a layout that stops emitting the links fails: every family
// the built CSS declares is preloaded once, from a file a @font-face rule loads, as a woff2 font with
// crossorigin, without which the browser fetches the font a second time.
export function fontPreloadRule(site: BuiltSite, _context: CheckContext): Finding[] {
  const faces = fontFaceFiles(site);
  const families = [...new Set(faces.values())].sort();
  return site.pages.flatMap((page) => {
    const texts: string[] = [];
    const preloaded = new Map<string, number>();
    const fontPreloads = page.links.filter((link) => (link.rel ?? '').toLowerCase().split(/\s+/).includes('preload') && link.as === 'font');
    for (const link of fontPreloads) {
      const href = link.href ?? '';
      const family = faces.get(href);
      if (family === undefined) texts.push(`the font preload ${clip(href)} names a file no built @font-face rule loads, so it is fetched for nothing`);
      else preloaded.set(family, (preloaded.get(family) ?? 0) + 1);
      if (link.type !== 'font/woff2') texts.push(`the font preload ${clip(href)} does not carry type="font/woff2"`);
      if (link.crossorigin === undefined) texts.push(`the font preload ${clip(href)} has no crossorigin attribute, so the browser fetches the font a second time`);
    }
    for (const family of families) {
      const count = preloaded.get(family) ?? 0;
      if (count === 0) texts.push(`the page preloads no file of the ${family} face, so it swaps in after the first paint and shifts the first band`);
      else if (count > 1) texts.push(`the page preloads ${String(count)} files of the ${family} face, 1 expected, so the others are fetched for nothing`);
    }
    return texts.map((text) => ({ rule: 'font-preload' as const, route: page.route, text }));
  });
}

const REQUIRED_METAS: readonly (readonly [string, string])[] = [
  ['name', 'description'],
  ['property', 'og:title'],
  ['property', 'og:description'],
  ['property', 'og:type'],
  ['property', 'og:image'],
  ['property', 'og:image:alt'],
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
const FIXTURE_PROVENANCES: ReadonlySet<Provenance> = new Set(['doc-derived', 'generated']);

function wordingFindings(page: BuiltPage, provenance: Provenance): string[] {
  const texts = [page.text, ...labelTexts(page.root)].flatMap((text) =>
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

// hidden hides whatever its value, hidden="false" included, since an invalid value is the hidden
// state; aria-hidden hides unless it reads false.
function hidingAttr(element: BuiltElement): string | undefined {
  if (element.attrs.hidden !== undefined) return 'hidden';
  const aria = element.attrs['aria-hidden'];
  return aria !== undefined && aria !== 'false' ? 'aria-hidden' : undefined;
}

// What hides an element from the accessibility tree, the element itself or an ancestor, and by which attribute.
function hiddenBy(element: BuiltElement, parents: ReadonlyMap<BuiltElement, BuiltElement>): { readonly tag: string; readonly attr: string } | undefined {
  const hider = hidingAttr(element) === undefined ? ancestorWith(element, parents, (node) => hidingAttr(node) !== undefined) : element;
  const attr = hider === undefined ? undefined : hidingAttr(hider);
  return hider === undefined || attr === undefined ? undefined : { tag: hider.tag, attr };
}

function panelFindings(page: BuiltPage): string[] {
  const panels = panelsOf(page);
  if (panels.length !== COUNTED_KINDS.length) return [`the replay page has ${String(panels.length)} step panels, 4 expected`];
  const steps = panels.map((panel) => panel.attrs[STEPS] ?? '');
  const texts = steps.join(', ') === '1, 2, 3, 4' ? [] : [`the step panels read ${steps.join(', ')} in HTML order; 1, 2, 3, 4 expected`];
  const parents = parentsOf(page.root);
  panels.forEach((panel, index) => {
    const hidden = hiddenBy(panel, parents);
    if (hidden !== undefined) texts.push(`step panel ${steps[index] ?? ''} is hidden from the accessibility tree by ${hidden.attr} on <${hidden.tag}>`);
  });
  return texts;
}

const CLOCK = 'data-replay-clock';

function clockFindings(page: BuiltPage): string[] {
  const clocks: BuiltElement[] = [];
  walk(page.root, (element) => {
    if (element.attrs[CLOCK] !== undefined) clocks.push(element);
  });
  const [clock] = clocks;
  if (clocks.length !== 1 || clock === undefined) return [`the replay page has ${String(clocks.length)} step clocks (${CLOCK}), 1 expected`];
  if (clock.attrs.role !== 'status') return ['the step clock does not carry role="status", so a screen reader is not told the step changed (WCAG 4.1.3)'];
  const hidden = hiddenBy(clock, parentsOf(page.root));
  return hidden === undefined ? [] : [`the step clock is hidden from the accessibility tree by ${hidden.attr} on <${hidden.tag}>, so its status role announces nothing (WCAG 4.1.3)`];
}

// AC-E7 and AC-10's static half: the four panels sit in the HTML in step order and nothing in the
// markup hides them, so CSS alone decides what shows and removing the js class shows all four. The
// one step clock carries the status role, the method the accessibility page records WCAG 4.1.3
// passed by (05-UAT check 4).
export function replayPanelsRule(site: BuiltSite, _context: CheckContext): Finding[] {
  return onReplay(site, 'replay-panels', (page) => [...panelFindings(page), ...clockFindings(page)]);
}

// AC-63's use half. tokens.css itself writes var(--text-small) for the compact alias, which is a
// declaration, so only the other sheets count as using a name.
export function typeTokenUseRule(site: BuiltSite, _context: CheckContext): Finding[] {
  const sheets = site.css.filter((file) => file.file !== TOKENS_FILE).map((file) => file.text);
  return R14_TYPE_TOKENS.filter(([name]) => !sheets.some((css) => new RegExp(`var\\(\\s*${escapeRegExp(name)}\\s*[,)]`).test(css)))
    .map(([name]) => ({ rule: 'type-token-use' as const, route: fileRoute('*.css'), text: `the built CSS never uses ${name} through var()` }));
}

// AC-65 and AC-E55 (UI-SPEC line 208): an identifier may end a line only at a <wbr> right after a
// dot. The exceptions are word mode (data-identifier-words) in two cells: an API operation name in a
// replay log Detail cell, and an IAM action in a permission schedule's Action cell, which may also
// break after its colon (UI-SPEC section 17 item 2); both may break between capitalised words.
function inWordCell(element: BuiltElement, parents: ReadonlyMap<BuiltElement, BuiltElement>): boolean {
  const cell = ancestorWith(element, parents, (node) => node.tag === 'td');
  const row = cell === undefined ? undefined : parents.get(cell);
  if (row?.tag !== 'tr') return false;
  const column = cell?.attrs['data-col'];
  return (column === 'Detail' && row.attrs['data-log-step'] !== undefined) || (column === 'Action' && row.attrs['data-permission'] !== undefined);
}

function identifierBreakFindings(page: BuiltPage): string[] {
  const parents = parentsOf(page.root);
  const texts: string[] = [];
  walk(page.root, (element) => {
    if (element.attrs['data-identifier'] === undefined) return;
    const wordsAllowed = element.attrs['data-identifier-words'] !== undefined && inWordCell(element, parents);
    let before: BuiltElement | undefined;
    for (const child of element.children) {
      if (typeof child === 'string') continue;
      const part = before === undefined ? '' : textOf(before);
      if (child.tag === 'wbr' && !part.endsWith('.') && !wordsAllowed) {
        const where = element.attrs['data-identifier-words'] === undefined ? '' : ' outside a replay log Detail cell or a permission Action cell';
        texts.push(`the identifier ${textOf(element)} may break after "${part}", and${where} only a dot may end an identifier's line`);
      }
      before = child;
    }
  });
  return texts;
}

export function identifierBreakRule(site: BuiltSite, _context: CheckContext): Finding[] {
  return site.pages.flatMap((page) => identifierBreakFindings(page).map((text) => ({ rule: 'identifier-break' as const, route: page.route, text })));
}

// UI-SPEC line 209 and the 05-12 finish review: a command block wraps only between its units, the
// spans directly inside its code element, and a flag with the value after it is one unit. Between
// units and inside a pair stands one space or a line break and nothing else, and nothing sits
// outside the code element, so the copied text is the command itself. A token offers a line end
// after each colon and equals sign inside it (05-UAT check 1), so a narrow step cuts a stack
// parameter there.
const SEPARATOR = /^[ \n]$/;
const isLoneToken = (text: string): boolean => text !== '' && !/\s/.test(text);

function separatorFindings(element: BuiltElement): string[] {
  return element.children.filter((child): child is string => typeof child === 'string' && !SEPARATOR.test(child))
    .map((text) => `the command block holds ${JSON.stringify(text)} between its units, where only one space or a line break belongs, so the copied text is not the command`);
}

function splitPairFindings(code: BuiltElement): string[] {
  const texts: string[] = [];
  code.children.forEach((child, index) => {
    const between = code.children[index + 1];
    const value = code.children[index + 2];
    if (typeof child === 'string' || between !== ' ' || value === undefined || typeof value === 'string') return;
    const flag = rawText(child);
    const next = rawText(value);
    if (isLoneToken(flag) && flag.startsWith('-') && isLoneToken(next) && !next.startsWith('-')) {
      texts.push(`the command block keeps the flag ${flag} apart from its value ${next}, so a line can end between them`);
    }
  });
  return texts;
}

// A token's runs as rendered: the text between its <wbr>s, at any depth inside it, so a <wbr> inside
// an inline element offers its line end like one directly in the token.
function renderedRuns(token: BuiltElement): string[] {
  const runs = [''];
  const visit = (element: BuiltElement): void => {
    for (const child of element.children) {
      if (typeof child === 'string') runs[runs.length - 1] += child;
      else if (child.tag === 'wbr') runs.push('');
      else visit(child);
    }
  };
  visit(token);
  return runs;
}

// Where each run but the last ends, as an offset into the token's text.
function runEnds(runs: readonly string[]): number[] {
  const ends: number[] = [];
  let end = 0;
  for (const run of runs.slice(0, -1)) {
    end += run.length;
    ends.push(end);
  }
  return ends;
}

// A missing line end and one inside a word are both named, each as what it is.
function tokenBreakFindings(token: BuiltElement): string[] {
  const text = rawText(token);
  const runs = renderedRuns(token);
  const rendered = runEnds(runs);
  const expected = runEnds(tokenRuns(text));
  const missing = expected.some((end) => !rendered.includes(end))
    ? [`the command token ${text} offers no line end after a colon or equals sign inside it, so a narrow column cuts it mid-word`]
    : [];
  const inside = rendered.flatMap((end, index) => (expected.includes(end) ? [] : [`the command token ${text} offers a line end after "${runs[index] ?? ''}", inside a word, so a narrow column cuts it there`]));
  return [...missing, ...inside];
}

function commandBlockFindings(pre: BuiltElement): string[] {
  const codes = pre.children.filter((child): child is BuiltElement => typeof child !== 'string' && child.tag === 'code');
  const outside = pre.children.filter((child) => typeof child === 'string' || child.tag !== 'code').map((child) => (typeof child === 'string' ? child : rawText(child))).join('');
  const texts = outside === '' ? [] : [`the command block holds ${JSON.stringify(outside)} outside its code element, so the copied text is not the command`];
  for (const code of codes) {
    texts.push(...separatorFindings(code), ...splitPairFindings(code));
    // A pair is a unit holding token spans; a single token's span holds its text and its <wbr>s.
    for (const unit of code.children) {
      if (typeof unit === 'string') continue;
      const tokens = unit.children.filter((child): child is BuiltElement => typeof child !== 'string' && child.tag === 'span');
      if (tokens.length > 0) texts.push(...separatorFindings(unit));
      for (const token of tokens.length > 0 ? tokens : [unit]) texts.push(...tokenBreakFindings(token));
    }
  }
  return texts;
}

export function commandPairRule(site: BuiltSite, _context: CheckContext): Finding[] {
  return site.pages.flatMap((page) => {
    const texts: string[] = [];
    walk(page.root, (element) => {
      if (element.tag === 'pre' && (element.attrs.class ?? '').split(/\s+/).includes('command')) texts.push(...commandBlockFindings(element));
    });
    return texts.map((text) => ({ rule: 'command-pair' as const, route: page.route, text }));
  });
}

export const DEPLOY_ROUTE = '/deploy/';

const deployPage = (site: BuiltSite): BuiltPage | undefined => site.pages.find((page) => page.route === DEPLOY_ROUTE);

// As with the replay: while the page is absent the build reports one finding, under deploy-page.
function onDeploy(site: BuiltSite, rule: RuleId, findings: (page: BuiltPage) => string[]): Finding[] {
  const deploy = deployPage(site);
  return deploy === undefined ? [] : findings(deploy).map((text) => ({ rule, route: DEPLOY_ROUTE, text }));
}

export function deployPageRule(site: BuiltSite, _context: CheckContext): Finding[] {
  return deployPage(site) === undefined ? [{ rule: 'deploy-page', route: DEPLOY_ROUTE, text: `the build has no deploy page at ${DEPLOY_ROUTE}` }] : [];
}

// The reader's text collapses line breaks, which a command block keeps as one command per line.
function rawText(element: BuiltElement): string {
  return element.children.map((child) => (typeof child === 'string' ? child : rawText(child))).join('');
}

// Every pre block, and every inline code element that starts with a command word the README uses,
// so a command typed in running text is judged like one in a block.
function commandBlocks(page: BuiltPage, words: ReadonlySet<string>): string[] {
  const parents = parentsOf(page.root);
  const blocks: string[] = [];
  walk(page.root, (element) => {
    if (element.tag === 'pre') blocks.push(rawText(element));
    else if (element.tag === 'code' && ancestorWith(element, parents, (node) => node.tag === 'pre') === undefined) {
      const text = textOf(element);
      if (words.has(text.split(' ')[0] ?? '')) blocks.push(text);
    }
  });
  return blocks;
}

function commandFindings(page: BuiltPage, facts: DeployFacts): string[] {
  const words = new Set(['npm', ...facts.commands.map(({ command }) => command.split(' ')[0] ?? '')]);
  return commandBlocks(page, words)
    .flatMap((block) => block.split('\n').map((line) => line.replace(/\s+/g, ' ').trim()))
    .filter((line) => line !== '' && !isOfferedCommand(line, facts.commands, facts.scripts))
    .map((line) => `the deploy page shows the command "${clip(line)}", which README's Deploy and remove section does not hold and which runs no package.json script`);
}

// AC-32: a command an operator copies is a README line or runs a package.json script.
export function deployCommandsRule(site: BuiltSite, context: CheckContext): Finding[] {
  return onDeploy(site, 'deploy-commands', (page) => commandFindings(page, context.deploy));
}

const PERMISSION_MARK = 'data-permission';
const ROLE_MARK = 'data-permission-role';
const DENY_MARK = 'data-deny';
const RESOURCE_MARK = 'data-resource';

function cellText(row: BuiltElement, column: string): string {
  const cell = row.children.find((child): child is BuiltElement => typeof child !== 'string' && (child.tag === 'th' || child.tag === 'td') && child.attrs['data-col'] === column);
  return cell === undefined ? '' : textOf(cell);
}

interface PermissionReading {
  readonly key: string;
  readonly label: string;
  readonly effect: string;
  readonly why: string;
}

const permissionLabel = (key: string, resource: string, condition: string): string => `${key} on ${resource}${condition === '' ? '' : ` when ${condition}`}`;

// What a marked row says, read from its cells; the marker gives only the stack and the role, which
// sit in the section heading rather than in the row.
function shownPermission(row: BuiltElement): PermissionReading {
  const [kind, action, effect, resource, condition, why] = PERMISSION_COLUMNS.map((column) => cellText(row, column));
  const [stack = '', role = ''] = (row.attrs[PERMISSION_MARK] ?? '').split('/');
  const key = `${stack}/${role}/${kind ?? ''}/${effect ?? ''}/${action ?? ''}`;
  return { key, label: permissionLabel(key, resource ?? '', condition ?? ''), effect: effect ?? '', why: why ?? '' };
}

function expectedPermissions(facts: DeployFacts): PermissionReading[] {
  const rows = permissionSchedules(facts.permissions, facts.reasons).flatMap((schedule) => schedule.rows);
  // Allow rows sit in their role's schedule and Deny rows in the Deny box after them.
  return [...rows.filter((row) => row.effect !== 'Deny'), ...rows.filter((row) => row.effect === 'Deny')].map((row) => {
    const key = permissionKey(row);
    return { key, label: permissionLabel(key, row.resourceOrPrincipal, row.condition), effect: row.effect, why: row.reason };
  });
}

function tally(labels: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const label of labels) counts.set(label, (counts.get(label) ?? 0) + 1);
  return counts;
}

interface CountWording {
  readonly missing: (label: string) => string;
  readonly repeated: (label: string, seen: number, wanted: number) => string;
  readonly unknown: (label: string) => string;
}

const timesExpected = (seen: number, wanted: number): string => `${String(seen)} times, ${wanted === 1 ? 'once' : `${String(wanted)} times`} expected`;

// Each source entry once on the page and no row beyond them, compared as multisets so two entries
// that differ only in a cell the label carries still count as two.
function countFindings(expected: readonly string[], shown: readonly string[], wording: CountWording): string[] {
  const want = tally(expected);
  const have = tally(shown);
  const texts: string[] = [];
  for (const [label, wanted] of want) {
    const seen = have.get(label) ?? 0;
    if (seen === 0) texts.push(wording.missing(label));
    else if (seen !== wanted) texts.push(wording.repeated(label, seen, wanted));
  }
  for (const label of have.keys()) {
    if (!want.has(label)) texts.push(wording.unknown(label));
  }
  return texts;
}

const PERMISSION_WORDING: CountWording = {
  missing: (label) => `the deploy page has no row for ${label}`,
  repeated: (label, seen, wanted) => `the deploy page shows ${label} ${timesExpected(seen, wanted)}`,
  unknown: (label) => `the deploy page shows a row for ${label}, which matches no entry in packages/infra/permissions.json`,
};

const RESOURCE_WORDING: CountWording = {
  missing: (id) => `the deploy page lists no row for ${id}`,
  repeated: (id, seen, wanted) => `the deploy page lists ${id} ${timesExpected(seen, wanted)}`,
  unknown: (id) => `the deploy page lists ${id}, which packages/infra/resources.json does not hold`,
};

function roleSectionFindings(page: BuiltPage): string[] {
  const texts: string[] = [];
  for (const section of page.markers.get(ROLE_MARK) ?? []) {
    const id = section.attrs[ROLE_MARK] ?? '';
    const [stack = '', role = ''] = id.split('/');
    const heading = elementsIn(section, 'h3')[0];
    const headed = heading === undefined ? '' : textOf(heading);
    if (headed !== role) texts.push(`the role section ${id} is headed "${headed}", ${role} expected`);
    if (!textOf(section).includes(stack)) texts.push(`the role section ${id} does not name its stack ${stack}`);
    for (const row of markedIn(section, PERMISSION_MARK)) {
      if (!(row.attrs[PERMISSION_MARK] ?? '').startsWith(`${id}/`)) texts.push(`the role section ${id} holds the row ${row.attrs[PERMISSION_MARK] ?? ''}`);
    }
  }
  return texts;
}

function permissionFindings(page: BuiltPage, facts: DeployFacts): string[] {
  const expected = expectedPermissions(facts);
  const shown = markedIn(page.root, PERMISSION_MARK).map(shownPermission);
  const texts = countFindings(expected.map((row) => row.label), shown.map((row) => row.label), PERMISSION_WORDING);
  const reasons = new Map(expected.map((row) => [row.label, row.why]));
  for (const row of shown) {
    const reason = reasons.get(row.label);
    if (reason !== undefined && row.why !== reason) texts.push(`the row ${row.label} reads "${clip(row.why)}"; the reasons map gives "${clip(reason)}"`);
  }
  if (texts.length === 0 && shown.map((row) => row.label).join('\n') !== expected.map((row) => row.label).join('\n')) {
    texts.push("the permission rows do not follow the snapshot's order");
  }
  return [...texts, ...roleSectionFindings(page)];
}

// AC-33, AC-34, AC-E24 and AC-E26: every snapshot entry renders once, in the snapshot's order,
// with the reason the committed map holds for its key, and no row stands for no entry.
export function deployPermissionsRule(site: BuiltSite, context: CheckContext): Finding[] {
  return onDeploy(site, 'deploy-permissions', (page) => permissionFindings(page, context.deploy));
}

interface ResourceReading {
  readonly id: string;
  readonly cells: readonly string[];
}

function resourceFindings(page: BuiltPage, facts: DeployFacts): string[] {
  const removedBy = `${RESOURCE_REMOVAL.deleted} ${removedByText(facts.commands)}`;
  const expected: ResourceReading[] = resourceRows(facts.resources).map((row) => ({
    id: `${row.stack}/${row.logicalId}`,
    cells: [row.logicalId, row.noun, row.stack, row.deletedOnRemoval ? removedBy : RESOURCE_REMOVAL.kept],
  }));
  const shown: ResourceReading[] = markedIn(page.root, RESOURCE_MARK).map((row) => ({ id: row.attrs[RESOURCE_MARK] ?? '', cells: RESOURCE_COLUMNS.map((column) => cellText(row, column)) }));
  const texts = countFindings(expected.map((row) => row.id), shown.map((row) => row.id), RESOURCE_WORDING);
  const wanted = new Map(expected.map((row) => [row.id, row.cells]));
  for (const row of shown) {
    const cells = wanted.get(row.id);
    RESOURCE_COLUMNS.forEach((column, index) => {
      const want = cells?.[index];
      if (want !== undefined && row.cells[index] !== want) texts.push(`the resource row ${row.id} reads "${clip(row.cells[index] ?? '')}" under ${column}; "${want}" expected`);
    });
  }
  if (texts.length === 0 && shown.map((row) => row.id).join('\n') !== expected.map((row) => row.id).join('\n')) {
    texts.push("the resource rows do not follow the snapshot's order");
  }
  return texts;
}

// AC-35: every resource the synthesized templates hold, once, with what removal does to it.
export function deployResourcesRule(site: BuiltSite, context: CheckContext): Finding[] {
  return onDeploy(site, 'deploy-resources', (page) => resourceFindings(page, context.deploy));
}

function denyFindings(page: BuiltPage, facts: DeployFacts): string[] {
  const expected = expectedPermissions(facts).filter((row) => row.effect === 'Deny');
  const boxes = page.markers.get(DENY_MARK) ?? [];
  const parents = parentsOf(page.root);
  const rows = markedIn(page.root, PERMISSION_MARK).map((element) => ({ element, reading: shownPermission(element) }));
  const inBox = (element: BuiltElement): boolean => ancestorWith(element, parents, (node) => node.attrs[DENY_MARK] !== undefined) !== undefined;
  if (expected.length === 0) {
    return [
      ...(boxes.length > 0 ? ['the snapshot holds no Deny entry, and the deploy page shows a Deny box'] : []),
      ...rows.filter((row) => row.reading.effect === 'Deny').map((row) => `the snapshot holds no Deny entry, and the deploy page shows the Deny row ${row.reading.label}`),
    ];
  }
  const entries = `${String(expected.length)} Deny entr${expected.length === 1 ? 'y' : 'ies'}`;
  if (boxes.length === 0) return [`the snapshot holds ${entries}, and the deploy page has no Deny box`];
  const texts = boxes.length > 1 ? [`the deploy page shows ${String(boxes.length)} Deny boxes, 1 expected`] : [];
  const boxed = new Set(rows.filter((row) => inBox(row.element) && row.reading.effect === 'Deny').map((row) => row.reading.label));
  for (const row of expected) {
    if (!boxed.has(row.label)) texts.push(`the Deny entry ${row.label} has no row in the Deny box`);
  }
  for (const row of rows) {
    if (inBox(row.element) !== (row.reading.effect === 'Deny')) texts.push(`the ${row.reading.effect} row ${row.reading.label} sits ${inBox(row.element) ? 'in' : 'outside'} the Deny box`);
  }
  return texts;
}

// AC-37 and AC-E27: the Deny box and its rows come only from Deny entries in the snapshot.
export function deployDenyRule(site: BuiltSite, context: CheckContext): Finding[] {
  return onDeploy(site, 'deploy-deny', (page) => denyFindings(page, context.deploy));
}

function noticeFindings(page: BuiltPage, facts: DeployFacts): string[] {
  const shown = (page.markers.get('data-notice') ?? []).some((element) => textOf(element).includes(NOT_YET_NOTICE.text));
  if (hasPauseGrant(facts.permissions)) return shown ? ['the template holds a pause grant, and the deploy page still shows the NOT YET notice'] : [];
  return shown ? [] : ['the template holds no ses:PutConfigurationSetSendingOptions grant, and the deploy page shows no NOT YET notice'];
}

// UI-SPEC Q16: the notice stands exactly while no role may pause a lane.
export function deployNoticeRule(site: BuiltSite, context: CheckContext): Finding[] {
  return onDeploy(site, 'deploy-notice', (page) => noticeFindings(page, context.deploy));
}

// AC-36: the one-caller-per-lane sentence and its reason, outside any drawing.
export function oneCallerRule(site: BuiltSite, _context: CheckContext): Finding[] {
  return onDeploy(site, 'one-caller', (page) =>
    (page.textOutsideSvg.includes(ONE_CALLER_SENTENCE) ? [] : ['the deploy page does not say that each lane sends through its own IAM caller identity, and why']));
}

export const PRIVACY_ROUTE = '/privacy-and-ai/';
const PRIVACY_ID = 'privacy';
const AI_ID = 'ai';

interface PagePart {
  readonly text: string;
  readonly elements: readonly BuiltElement[];
}

const holdsId = (element: BuiltElement, id: string): boolean => some(element, (node) => node.attrs.id === id);

// Everything from the element with one id up to the element with the other, in document order, so a
// part spans several rows whether the id sits on a heading or on a wrapper. Null when the start id is
// absent. SVG text stays out, since a drawing's labels are not the page's statements.
function pagePart(page: BuiltPage, startId: string, endId: string | null): PagePart | null {
  const pieces: string[] = [];
  const tops: BuiltElement[] = [];
  let state: 'before' | 'in' | 'after' = 'before';
  const visit = (node: BuiltElement): void => {
    if (state === 'after') return;
    if (state === 'in' && endId !== null && node.attrs.id === endId) {
      state = 'after';
      return;
    }
    if (state === 'before' && node.attrs.id === startId) state = 'in';
    const holdsEnd = endId !== null && holdsId(node, endId);
    if (state === 'in' && !holdsEnd) {
      tops.push(node);
      pieces.push(` ${textOf(node, (inner) => inner.tag === 'svg')} `);
      return;
    }
    if (state === 'before' && !holdsId(node, startId)) return;
    for (const child of node.children) {
      if (typeof child !== 'string') visit(child);
      else if (state === 'in') pieces.push(child);
    }
  };
  visit(page.root);
  if (tops.length === 0) return null;
  const elements: BuiltElement[] = [];
  for (const top of tops) walk(top, (element) => elements.push(element));
  return { text: pieces.join('').replace(/\s+/g, ' ').trim(), elements };
}

const privacyPage = (site: BuiltSite): BuiltPage | undefined => site.pages.find((page) => page.route === PRIVACY_ROUTE);
const privacyPart = (page: BuiltPage): PagePart | null => pagePart(page, PRIVACY_ID, AI_ID);
const aiPart = (page: BuiltPage): PagePart | null => pagePart(page, AI_ID, null);

// The privacy section's text as the page renders it, which the rendered storage check reads the keys
// from; null when the build has no such section.
export function privacySectionText(site: BuiltSite): string | null {
  const page = privacyPage(site);
  return page === undefined ? null : (privacyPart(page)?.text ?? null);
}

// As with the replay and the deploy page: while the page or its part is absent, the build reports one
// finding, under privacy-page, rather than one per rule.
function onPart(site: BuiltSite, rule: RuleId, partOf: (page: BuiltPage) => PagePart | null, findings: (part: PagePart) => string[]): Finding[] {
  const page = privacyPage(site);
  const part = page === undefined ? null : partOf(page);
  return part === null ? [] : findings(part).map((text) => ({ rule, route: PRIVACY_ROUTE, text }));
}

export function privacyPageRule(site: BuiltSite, _context: CheckContext): Finding[] {
  const rule = 'privacy-page' as const;
  const page = privacyPage(site);
  if (page === undefined) return [{ rule, route: PRIVACY_ROUTE, text: `the build has no privacy and AI page at ${PRIVACY_ROUTE}` }];
  return [PRIVACY_ID, AI_ID].filter((id) => !holdsId(page.root, id)).map((id) => ({ rule, route: PRIVACY_ROUTE, text: `the privacy and AI page has no element with id ${id}` }));
}

// A statement counts when the part's text holds it, and one with a link counts only where a block
// element holding it also links to that page (AC-19's Bedrock sentence).
function statementFindings(part: PagePart, statements: readonly Statement[], where: string): string[] {
  return statements.flatMap((statement) => {
    if (!part.text.includes(statement.text)) return [`${where} does not say "${statement.text}"`];
    const { link } = statement;
    if (link === undefined) return [];
    const holders = part.elements.filter((element) => BLOCK_TAGS.has(element.tag) && textOf(element).includes(statement.text));
    return holders.some((element) => linksTo(element, link)) ? [] : [`${where} says "${statement.text}" with no link to ${link} in the same element`];
  });
}

export function privacyStatementsRule(site: BuiltSite, context: CheckContext): Finding[] {
  return onPart(site, 'privacy-statements', privacyPart, (part) => statementFindings(part, context.privacy.required, 'the privacy section'));
}

const STORED_FIELD_MARK = 'data-stored-field';

function storedFieldFindings(part: PagePart, fields: PrivacyFacts['storedFields']): string[] {
  const rows = part.elements.filter((element) => element.attrs[STORED_FIELD_MARK] !== undefined);
  const texts = countFindings(fields.map((field) => field.path), rows.map((row) => row.attrs[STORED_FIELD_MARK] ?? ''), {
    missing: (path) => `the stored-field schedule has no row for ${path}`,
    repeated: (path, seen, wanted) => `the stored-field schedule shows ${path} ${timesExpected(seen, wanted)}`,
    unknown: (path) => `the stored-field schedule has a row for ${path}, which the stored-field map does not class as identifying a recipient or a sender`,
  });
  const byPath = new Map(fields.map((field) => [field.path, field]));
  for (const row of rows) {
    const field = byPath.get(row.attrs[STORED_FIELD_MARK] ?? '');
    if (field === undefined) continue;
    const text = textOf(row);
    if (!text.includes(field.path)) texts.push(`the stored-field row ${field.path} does not name the field`);
    if (!new RegExp(`\\b${field.identifies}\\b`).test(text)) texts.push(`the stored-field row ${field.path} does not say that it identifies a ${field.identifies}`);
    if (!text.includes(field.row)) texts.push(`the stored-field row ${field.path} does not read "${clip(field.row)}"`);
  }
  return texts;
}

// AC-20 and UI-SPEC E8: one row per field the map classes recipient or sender, each naming the field
// and what it identifies, and none for a field the map leaves out.
export function storedFieldRowsRule(site: BuiltSite, context: CheckContext): Finding[] {
  return onPart(site, 'stored-field-rows', privacyPart, (part) => storedFieldFindings(part, context.privacy.storedFields));
}

// AC-21: the controller, the contact route, the legal basis, the complaint right, both DPA lines,
// Cloudflare's transfer safeguard, the visitor IP's retention and the no-cookie and no-analytics sentences.
export function websiteFactsRule(site: BuiltSite, context: CheckContext): Finding[] {
  return onPart(site, 'website-facts', privacyPart, (part) => statementFindings(part, context.privacy.website, 'the website part'));
}

const RIGHT_MARK = 'data-right';

// AC-E16: the six rights as a set, each once, in any order.
export function sixRightsRule(site: BuiltSite, context: CheckContext): Finding[] {
  return onPart(site, 'six-rights', privacyPart, (part) => countFindings(context.privacy.rights, part.elements.filter((element) => element.attrs[RIGHT_MARK] !== undefined).map((element) => textOf(element)), {
    missing: (right) => `the privacy section does not name the right of ${right}`,
    repeated: (right, seen, wanted) => `the privacy section names the right of ${right} ${timesExpected(seen, wanted)}`,
    unknown: (right) => `the privacy section marks "${right}" as a right, which is not one of the six`,
  }));
}

function forgetFindings(part: PagePart, forget: ForgetCommand): string[] {
  const texts: string[] = [];
  if (!part.text.includes(FORGET_DOC)) texts.push(`the privacy section does not name ${FORGET_DOC}`);
  if (!part.text.includes(forget.command)) texts.push(`the privacy section does not name the command ${forget.command} from ${FORGET_DOC}`);
  if (!part.text.includes(forget.output)) texts.push(`the privacy section does not name the stack output ${forget.output} that names the forget function`);
  return texts;
}

// AC-23: deletion is the documented command, named on the privacy section as the doc writes it.
export function forgetCommandRule(site: BuiltSite, context: CheckContext): Finding[] {
  return onPart(site, 'forget-command', privacyPart, (part) => forgetFindings(part, context.privacy.forget));
}

const DELETES_RECIPIENT = /\b(?:delete|deletes|deleting|forget|forgets|forgetting|erase|erases|erasing|remove|removes|removing)\b[\s\S]{0,40}?\b(?:recipients?|address(?:es)?)\b/i;
const CONTROL_LABEL_ATTRS = ['aria-label', 'title', 'value'] as const;

function controlLabel(element: BuiltElement): string {
  return [textOf(element), ...CONTROL_LABEL_ATTRS.map((name) => element.attrs[name] ?? '')].join(' ').replace(/\s+/g, ' ').trim();
}

const isControl = (element: BuiltElement): boolean =>
  ['button', 'a', 'form'].includes(element.tag) || element.attrs.role === 'button' || (element.tag === 'input' && ['submit', 'button'].includes((element.attrs.type ?? '').toLowerCase()));

// AC-23 and AC-P7: no built page offers a control whose text or accessible name deletes a recipient.
export function noDeleteControlRule(site: BuiltSite, _context: CheckContext): Finding[] {
  return site.pages.flatMap((page) => {
    const findings: Finding[] = [];
    walk(page.root, (element) => {
      if (!isControl(element)) return;
      const label = controlLabel(element);
      if (DELETES_RECIPIENT.test(label)) findings.push({ rule: 'no-delete-control', route: page.route, text: `a ${element.tag} offers to delete a recipient: "${clip(label)}"` });
    });
    return findings;
  });
}

const MODEL_ROLE = 'data-model-role';

// A marked element inside another marked element is read once, with its outermost container.
function modelRoleElements(page: BuiltPage): BuiltElement[] {
  const found: BuiltElement[] = [];
  const visit = (element: BuiltElement): void => {
    if (element.attrs[MODEL_ROLE] !== undefined) {
      found.push(element);
      return;
    }
    for (const child of element.children) {
      if (typeof child !== 'string') visit(child);
    }
  };
  visit(page.root);
  return found;
}

// AC-E19: a build where nothing is marked would pass the claims below vacuously, so it fails here.
export function modelRolePresentRule(site: BuiltSite, _context: CheckContext): Finding[] {
  const marked = site.pages.some((page) => modelRoleElements(page).length > 0);
  return marked ? [] : [{ rule: 'model-role-present', route: PRIVACY_ROUTE, text: `no built page carries a ${MODEL_ROLE} element, so what the pages say about the model was not checked` }];
}

// AC-24 and AC-E20: each statement at least once across the marked elements of every page, as a set.
export function modelRoleRequiredRule(site: BuiltSite, context: CheckContext): Finding[] {
  const texts = site.pages.flatMap((page) => modelRoleElements(page).map((element) => outsideSvg(element)));
  return context.privacy.modelRequired.filter((statement) => !texts.some((text) => text.includes(statement.text)))
    .map((statement) => ({ rule: 'model-role-required' as const, route: PRIVACY_ROUTE, text: `no ${MODEL_ROLE} element says "${statement.text}"` }));
}

const MODEL_SUBJECT = 'data-model-subject';

// A list marked as what the model does holds items with no subject ("Adds a lane ..."), so each item
// is judged as a sentence whose subject is the model. Every other marked element is judged as
// written, the list of what the model never does among them: it names the forbidden actions on purpose.
function modelRoleSentences(element: BuiltElement): string[] {
  if (element.attrs[MODEL_SUBJECT] === undefined) return [outsideSvg(element)];
  const items = elementsIn(element, 'li');
  return (items.length === 0 ? [element] : items).map((item) => {
    const text = outsideSvg(item).trim();
    return `The model ${text.charAt(0).toLowerCase()}${text.slice(1)}`;
  });
}

// AC-25: every marked element on every page, each hit named with its route and words.
export function modelRoleForbiddenRule(site: BuiltSite, context: CheckContext): Finding[] {
  return site.pages.flatMap((page) => modelRoleElements(page).flatMap(modelRoleSentences).flatMap((text) =>
    context.privacy.modelForbidden.flatMap(({ claim, pattern }) => {
      const match = new RegExp(pattern.source, pattern.flags.replace('g', '')).exec(text);
      return match === null ? [] : [{ rule: 'model-role-forbidden' as const, route: page.route, text: `a ${MODEL_ROLE} element claims what only code does (${claim}): "${excerpt(text, match.index, match[0].length)}"` }];
    })));
}

const MODEL_ID_MARK = 'data-model-id';

function modelIdFindings(part: PagePart, modelId: string): string[] {
  const shown = part.elements.filter((element) => element.attrs[MODEL_ID_MARK] !== undefined).map((element) => textOf(element));
  if (shown.length === 0) return [`the AI section shows no model id (${MODEL_ID_MARK})`];
  return shown.filter((id) => id !== modelId).map((id) => `the AI section shows the model id ${id}; the repository pins ${modelId}`);
}

// AC-26: the id the AI section shows is the one the repository pins at build time.
export function modelIdRule(site: BuiltSite, context: CheckContext): Finding[] {
  return onPart(site, 'model-id', aiPart, (part) => modelIdFindings(part, context.privacy.modelId));
}

export const ACCESSIBILITY_ROUTE = '/accessibility/';
const CRITERION_MARK = 'data-criterion';

const accessibilityPage = (site: BuiltSite): BuiltPage | undefined => site.pages.find((page) => page.route === ACCESSIBILITY_ROUTE);

export function accessibilityPageRule(site: BuiltSite, _context: CheckContext): Finding[] {
  return accessibilityPage(site) === undefined ? [{ rule: 'accessibility-page', route: ACCESSIBILITY_ROUTE, text: `the build has no accessibility statement at ${ACCESSIBILITY_ROUTE}` }] : [];
}

// Each row is judged by its own recorded result, so a schedule part way through the hand check
// passes as long as every row shows what the record holds for it (UI-SPEC E13, partial).
function criterionFindings(page: BuiltPage): string[] {
  const rows = markedIn(page.root, CRITERION_MARK);
  const texts = countFindings(HAND_CHECK_CRITERIA.map((criterion) => criterion.number), rows.map((row) => row.attrs[CRITERION_MARK] ?? ''), {
    missing: (number) => `the hand-check schedule has no row for ${number}`,
    repeated: (number, seen, wanted) => `the hand-check schedule shows ${number} ${timesExpected(seen, wanted)}`,
    unknown: (number) => `the hand-check schedule has a row for ${number}, which is not one of the criteria axe-core cannot decide`,
  });
  const byNumber = new Map(HAND_CHECK_CRITERIA.map((criterion) => [criterion.number, criterion]));
  for (const row of rows) {
    const criterion = byNumber.get(row.attrs[CRITERION_MARK] ?? '');
    if (criterion === undefined) continue;
    const text = textOf(row);
    const label = HAND_CHECK_RESULT_LABELS[criterion.result];
    if (!text.includes(criterion.name)) texts.push(`the hand-check row ${criterion.number} does not name "${criterion.name}"`);
    if (!text.includes(label)) texts.push(`the hand-check row ${criterion.number} does not show its result "${label}"`);
    if (!text.includes(criterion.how)) texts.push(`the hand-check row ${criterion.number} does not say how it is checked`);
  }
  return texts;
}

// AC-53: the target, the last automated audit, the tool, the limitations, the contact route and one
// row per criterion axe cannot decide. While the page is absent only accessibility-page reports.
export function accessibilityStatementRule(site: BuiltSite, _context: CheckContext): Finding[] {
  const page = accessibilityPage(site);
  if (page === undefined) return [];
  const said = accessibilityStatements().filter((statement) => !page.text.includes(statement.text)).map((statement) => `the accessibility statement does not say "${statement.text}"`);
  return [...said, ...criterionFindings(page)].map((text) => ({ rule: 'accessibility-statement' as const, route: ACCESSIBILITY_ROUTE, text }));
}

// AC-P16: the privacy and accessibility pages show one email address, the controller's. Every @ a reader meets
// there counts, email-shaped or not: the text, each label, the shown metas and every link target, so an address
// put in a page's own markup or in a list beside the controller sentence fails, not only one in that sentence.
const CONTACT_ROUTES: ReadonlySet<string> = new Set([PRIVACY_ROUTE, ACCESSIBILITY_ROUTE]);
const AT_RUN = /\S*@\S*/g;

// Sentence punctuation around a run is not part of it: "email privacy@taranity.com." ends a sentence.
const atRuns = (text: string): string[] => (text.match(AT_RUN) ?? []).map((run) => run.replace(/^[("'[<]+/, '').replace(/[.,;:!?)"'\]>]+$/, ''));

// A link target splits at its scheme and query marks, so mailto:privacy@taranity.com?subject=x gives the address
// alone, while a cc address or a user name before a host still counts on its own.
const hrefRuns = (href: string): string[] => href.split(/[\s:?&=,]+/).filter((piece) => piece.includes('@'));

function atTokens(page: BuiltPage): string[] {
  const fromLinks: string[] = [];
  walk(page.root, (element) => {
    if (element.attrs.href !== undefined) fromLinks.push(...hrefRuns(element.attrs.href));
  });
  return [...claimTexts(page).flatMap(atRuns), ...fromLinks];
}

export function contactAddressRule(site: BuiltSite, _context: CheckContext): Finding[] {
  return site.pages
    .filter((page) => CONTACT_ROUTES.has(page.route))
    .flatMap((page) => atTokens(page)
      .filter((token) => token !== CONTACT_ADDRESS)
      .map((token) => ({ rule: 'contact-address' as const, route: page.route, text: `the page shows "${token}", and the only address it may show is ${CONTACT_ADDRESS}` })));
}

// Workers limits: 20,000 files per version on the Free plan and 25 MiB per file (AC-62). The check
// below uses >= on purpose, so a build must stay at least one file and one byte under each limit.
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

// WCAG 1.4.5 (05-UAT check 4): a readout's digits are drawn segments, an image of text, so the number
// they show is also printed beside them where a reader can see it. The sentence a screen reader is
// given does not count: it is clipped to one pixel. The drawn segments (class seg) are what the rule
// protects, so a segment outside any readout, or drawn digits with no sentence beside them giving
// their number, fails instead of leaving drawn digits nothing checks after a class is renamed.
const hasClass = (element: BuiltElement, name: string): boolean => (element.attrs.class ?? '').split(/\s+/).includes(name);

// Markup text no reader sees on the page: an SVG's title and desc, what script, style and template
// hold, noscript's content while scripts run, and whatever the hidden attribute removes, beside the
// screen-reader sentence.
const UNSHOWN_TAGS = new Set(['title', 'desc', 'script', 'style', 'template', 'noscript']);

function shownText(element: BuiltElement): string {
  if (hasClass(element, 'visually-hidden') || UNSHOWN_TAGS.has(element.tag) || element.attrs.hidden !== undefined) return '';
  return element.children.map((child) => (typeof child === 'string' ? child : shownText(child))).join(' ');
}

// A figure counts as shown only where it stands alone: a digit, colon, dot, hyphen or slash touching it
// makes it part of a clock time, a date or another figure, which no reader takes for the drawn number.
const standsAlone = (text: string, number: string): boolean => new RegExp(`(?<![\\d:./-])${number}(?![\\d:./-])`).test(text);

function drawsSegments(element: BuiltElement): boolean {
  let found = false;
  walk(element, (inner) => {
    if (hasClass(inner, 'seg')) found = true;
  });
  return found;
}

// A readout's window is its child holding the drawn digits, the sentence a screen reader is given for
// them and the label beside them, and the number is read there alone. The readout head counts only
// while that label holds no figure at all, as on the 404 page, whose head names the status drawn.
function windowFindings(readout: BuiltElement, window: BuiltElement): string[] {
  const spoken: string[] = [];
  walk(window, (inner) => {
    if (hasClass(inner, 'visually-hidden')) spoken.push(textOf(inner));
  });
  // Each sentence opens with the figure the digits draw (412 sends on a lane, Status 404), and a lane
  // name may end in digits of its own, so only a sentence's first digit run is the drawn number.
  const numbers = spoken.flatMap((text) => text.match(/\d+/)?.[0] ?? []);
  if (numbers.length === 0) return ['the readout draws digits but no screen-reader sentence beside them gives their number, so nothing checks that a reader can see it'];
  const beside = shownText(window);
  const head = readout.children.find((child): child is BuiltElement => typeof child !== 'string' && hasClass(child, 'readout-head'));
  const shown = /\d/.test(beside) || head === undefined ? beside : `${beside} ${shownText(head)}`;
  return numbers
    .filter((number) => !standsAlone(shown, number))
    .map((number) => `the readout draws ${number} but does not show it as text beside its digits, only to a screen reader`);
}

function readoutFindings(readout: BuiltElement): string[] {
  return readout.children
    .filter((child): child is BuiltElement => typeof child !== 'string' && drawsSegments(child))
    .flatMap((window) => windowFindings(readout, window));
}

export function readoutNumberRule(site: BuiltSite, _context: CheckContext): Finding[] {
  return site.pages.flatMap((page) => {
    const parents = parentsOf(page.root);
    const texts: string[] = [];
    let looseSegments = 0;
    walk(page.root, (element) => {
      if (hasClass(element, 'seg') && ancestorWith(element, parents, (node) => hasClass(node, 'readout')) === undefined) looseSegments += 1;
      if (hasClass(element, 'readout')) texts.push(...readoutFindings(element));
    });
    if (looseSegments > 0) texts.push(`${String(looseSegments)} drawn digit segments sit outside any readout, so no rule checks that their number is shown as text`);
    return texts.map((text) => ({ rule: 'readout-number' as const, route: page.route, text }));
  });
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
  'identifier-break': identifierBreakRule,
  'command-pair': commandPairRule,
  'deploy-page': deployPageRule,
  'deploy-commands': deployCommandsRule,
  'deploy-permissions': deployPermissionsRule,
  'deploy-resources': deployResourcesRule,
  'deploy-deny': deployDenyRule,
  'deploy-notice': deployNoticeRule,
  'one-caller': oneCallerRule,
  'privacy-page': privacyPageRule,
  'privacy-statements': privacyStatementsRule,
  'stored-field-rows': storedFieldRowsRule,
  'website-facts': websiteFactsRule,
  'six-rights': sixRightsRule,
  'forget-command': forgetCommandRule,
  'no-delete-control': noDeleteControlRule,
  'model-role-present': modelRolePresentRule,
  'model-role-required': modelRoleRequiredRule,
  'model-role-forbidden': modelRoleForbiddenRule,
  'model-id': modelIdRule,
  'accessibility-page': accessibilityPageRule,
  'accessibility-statement': accessibilityStatementRule,
  'readout-number': readoutNumberRule,
  'font-preload': fontPreloadRule,
  'contact-address': contactAddressRule,
};

// Every rule runs over the whole site and every hit is kept, so one report names them all.
export function runBuiltChecks(site: BuiltSite, context: CheckContext): Finding[] {
  return RULE_IDS.flatMap((id) => RULES[id](site, context));
}
