import type { BuiltSite } from './built-site.js';

// Later plans' expected-red tracers name these ids, so an id is never renamed once a plan names it.
export const RULE_IDS = Object.freeze(['dash'] as const);

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
}

const EXCERPT_RADIUS = 40;

function excerpt(text: string, index: number, length: number): string {
  const start = Math.max(0, index - EXCERPT_RADIUS);
  const end = Math.min(text.length, index + length + EXCERPT_RADIUS);
  return `${start > 0 ? '...' : ''}${text.slice(start, end)}${end < text.length ? '...' : ''}`;
}

function matchesIn(rule: RuleId, route: string, text: string, pattern: RegExp): Finding[] {
  const global = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
  return [...text.matchAll(global)].map((match) => ({ rule, route, text: excerpt(text, match.index, match[0].length) }));
}

// U+2012 figure dash to U+2015 horizontal bar. The reader decodes entities, so &mdash; and &#8211;
// arrive here as the characters themselves.
const DASHES = /[‒-―]/;

export function dashRule(site: BuiltSite, _context: CheckContext): Finding[] {
  return site.pages.flatMap((page) => matchesIn('dash', page.route, page.text, DASHES));
}

type Rule = (site: BuiltSite, context: CheckContext) => Finding[];

const RULES: Readonly<Record<RuleId, Rule>> = {
  dash: dashRule,
};

export function runBuiltChecks(site: BuiltSite, context: CheckContext): Finding[] {
  return RULE_IDS.flatMap((id) => RULES[id](site, context));
}
