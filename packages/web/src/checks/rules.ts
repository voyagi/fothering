import {
  ANALYTICS_PATTERNS,
  EXACT_30_DAY_PATTERNS,
  PRE_R6_PATTERNS,
  REGION_CLAIM_PATTERNS,
  THEME_RADIO_LIMIT,
} from '../site/content.js';
import type { SiteRoute } from '../site/route-list.js';
import { textOf, walk, type BuiltElement, type BuiltPage, type BuiltSite } from './built-site.js';

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

export function pageMetadataRule(_site: BuiltSite, _context: CheckContext): Finding[] {
  return [];
}

export function sitemapRule(_site: BuiltSite, _context: CheckContext): Finding[] {
  return [];
}

export function robotsRule(_site: BuiltSite, _context: CheckContext): Finding[] {
  return [];
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
};

// Every rule runs over the whole site and every hit is kept, so one report names them all.
export function runBuiltChecks(site: BuiltSite, context: CheckContext): Finding[] {
  return RULE_IDS.flatMap((id) => RULES[id](site, context));
}
