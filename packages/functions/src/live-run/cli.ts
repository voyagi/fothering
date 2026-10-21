import { MIN_SEND_GAP_MS } from '@fothering/core/live-run';
import { stepPlan, type StepPlanEntry } from '@fothering/core/scenarios';
import type { LiveRunDeps } from './root.js';
import { runSendStep } from './send.js';

export const LIVE_RUN_MESSAGES = {
  usage:
    'usage: live-run plan <scenario> <step> <runId>, or live-run send <runId> <scenario> <step> --from <address> --account-profile <name> --lane-profile <set>=<name> [--lane-profile <set>=<name> ...] [--rate <per second>]',
  planHeader: (scenario: string, step: string, sends: number) =>
    `${scenario} ${step}: ${sends} sends, each started at least ${MIN_SEND_GAP_MS} ms after the one before`,
  planLine: (entry: StepPlanEntry) => `${entry.counter} ${entry.lane} ${entry.tagKind}=${entry.tagValue} ${entry.recipientKind}`,
} as const;

const VALUE_OPTIONS = new Set(['--from', '--account-profile', '--lane-profile', '--rate']);

interface ParsedArgs {
  positionals: string[];
  options: Map<string, string[]>;
}

function parseArgs(args: readonly string[]): ParsedArgs | undefined {
  const positionals: string[] = [];
  const options = new Map<string, string[]>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? '';
    if (!arg.startsWith('--')) {
      positionals.push(arg);
      continue;
    }
    const value = args[i + 1];
    if (!VALUE_OPTIONS.has(arg) || value === undefined) return undefined;
    options.set(arg, [...(options.get(arg) ?? []), value]);
    i += 1;
  }
  return { positionals, options };
}

function single(parsed: ParsedArgs, name: string): string | undefined {
  const values = parsed.options.get(name);
  return values?.length === 1 ? values[0] : undefined;
}

function laneProfilesOf(values: readonly string[]): Map<string, string> | undefined {
  const profiles = new Map<string, string>();
  for (const value of values) {
    const separator = value.indexOf('=');
    const lane = value.slice(0, separator);
    const profile = value.slice(separator + 1);
    if (separator < 1 || profile === '' || profiles.has(lane)) return undefined;
    profiles.set(lane, profile);
  }
  return profiles;
}

function usage(deps: LiveRunDeps): number {
  deps.io.err(LIVE_RUN_MESSAGES.usage);
  return 1;
}

function plan(args: readonly string[], deps: LiveRunDeps): number {
  const [scenarioName, stepName, runId, ...extra] = args;
  if (scenarioName === undefined || stepName === undefined || runId === undefined || extra.length > 0) return usage(deps);
  const entries = stepPlan(deps.scenarios, scenarioName, stepName, runId);
  deps.io.out(LIVE_RUN_MESSAGES.planHeader(scenarioName, stepName, entries.length));
  for (const entry of entries) deps.io.out(LIVE_RUN_MESSAGES.planLine(entry));
  return 0;
}

async function send(args: readonly string[], deps: LiveRunDeps): Promise<number> {
  const parsed = parseArgs(args);
  if (parsed === undefined) return usage(deps);
  const [runId, scenarioName, stepName, ...extra] = parsed.positionals;
  const from = single(parsed, '--from');
  const accountProfile = single(parsed, '--account-profile');
  const laneProfiles = laneProfilesOf(parsed.options.get('--lane-profile') ?? []);
  if (
    runId === undefined ||
    scenarioName === undefined ||
    stepName === undefined ||
    extra.length > 0 ||
    from === undefined ||
    accountProfile === undefined ||
    laneProfiles === undefined
  ) {
    return usage(deps);
  }
  return runSendStep(deps, { runId, scenarioName, stepName, from, accountProfile, laneProfiles });
}

/** Returns the process exit code; every refusal is one line on io.err and exit 1. */
export async function main(argv: readonly string[], deps: LiveRunDeps): Promise<number> {
  const [subcommand, ...rest] = argv;
  if (subcommand === 'plan') return plan(rest, deps);
  if (subcommand === 'send') return send(rest, deps);
  return usage(deps);
}
