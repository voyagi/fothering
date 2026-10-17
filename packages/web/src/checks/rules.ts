import type { BuiltSite } from './built-site.js';

export const RULE_IDS = Object.freeze(['dash'] as const);

export type RuleId = (typeof RULE_IDS)[number];

export interface Finding {
  readonly rule: RuleId;
  readonly route: string;
  readonly text: string;
}

export interface CheckContext {
  readonly repoRoot: string;
}

export function dashRule(_site: BuiltSite, _context: CheckContext): Finding[] {
  return [];
}

export function runBuiltChecks(site: BuiltSite, context: CheckContext): Finding[] {
  return dashRule(site, context);
}
