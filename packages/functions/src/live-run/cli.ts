import { pathToFileURL } from 'node:url';
import { MAX_RATE_MILLI, MIN_SEND_GAP_MS, parseRate, refusalMessage, resolveStep } from '@fothering/core/live-run';
import { resolveProviderMode } from '@fothering/core/mode';
import type { StepPlanEntry } from '@fothering/core/scenarios';
import { createLiveRunPortFactory } from '@fothering/providers/live/live-run-ports';
import { readLiveSwitch } from '@fothering/providers/live-switch';
import { runCheckSaved } from './check-saved.js';
import { buildLiveRunRoot, type LiveRunDeps } from './root.js';
import { refuse, runSendStep } from './send.js';

export const LIVE_RUN_MESSAGES = {
  usage:
    'usage: live-run plan <scenario> <step> <runId>, or live-run send <runId> <scenario> <step> --from <address> --account-profile <name> --lane-profile <set>=<name> [--lane-profile <set>=<name> ...] [--rate <per second>], or live-run check-saved <runId> [--after-removal]',
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
    // A flag in a value slot is an unknown flag, never a profile name or a lane, so it cannot
    // carry a key into the command by standing where a known flag's value goes.
    if (!VALUE_OPTIONS.has(arg) || value === undefined || value.startsWith('--')) return undefined;
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
  deps.io.err(refusalMessage('usage'));
  deps.io.err(LIVE_RUN_MESSAGES.usage);
  return 1;
}

// The From address is checked for shape only; SES decides whether the identity may send.
const ADDRESS_SHAPE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** An absent flag means the cap itself; a flag that does not read as a positive rate is a usage error. */
function rateOf(parsed: ParsedArgs): number | undefined {
  if (!parsed.options.has('--rate')) return MAX_RATE_MILLI;
  const text = single(parsed, '--rate');
  return text === undefined ? undefined : parseRate(text);
}

function plan(args: readonly string[], deps: LiveRunDeps): number {
  const [scenarioName, stepName, runId, ...extra] = args;
  if (scenarioName === undefined || stepName === undefined || runId === undefined || extra.length > 0) return usage(deps);
  const step = resolveStep(deps.scenarios, scenarioName, stepName, runId);
  if (!step.ok) return refuse(deps, step.refusal);
  deps.io.out(LIVE_RUN_MESSAGES.planHeader(scenarioName, stepName, step.entries.length));
  for (const entry of step.entries) deps.io.out(LIVE_RUN_MESSAGES.planLine(entry));
  return 0;
}

async function send(args: readonly string[], deps: LiveRunDeps): Promise<number> {
  if (resolveProviderMode(deps.switchValue) !== 'live') return refuse(deps, { code: 'switch-not-live' });
  const parsed = parseArgs(args);
  if (parsed === undefined) return usage(deps);
  const [runId, scenarioName, stepName, ...extra] = parsed.positionals;
  const from = single(parsed, '--from');
  const accountProfile = single(parsed, '--account-profile');
  const laneProfiles = laneProfilesOf(parsed.options.get('--lane-profile') ?? []);
  const rateMilli = rateOf(parsed);
  if (
    runId === undefined ||
    scenarioName === undefined ||
    stepName === undefined ||
    extra.length > 0 ||
    from === undefined ||
    !ADDRESS_SHAPE.test(from) ||
    accountProfile === undefined ||
    laneProfiles === undefined ||
    rateMilli === undefined
  ) {
    return usage(deps);
  }
  return runSendStep(deps, { runId, scenarioName, stepName, from, accountProfile, laneProfiles, rateMilli });
}

// Its own exact parse: --after-removal takes no value, so parseArgs would read the next argument as one.
function checkSaved(args: readonly string[], deps: LiveRunDeps): number {
  const [runId, flag, ...extra] = args;
  if (runId === undefined || runId.startsWith('--') || extra.length > 0) return usage(deps);
  if (flag !== undefined && flag !== '--after-removal') return usage(deps);
  return runCheckSaved(deps, runId, flag !== undefined);
}

/** Returns the process exit code; every refusal is one line on io.err and exit 1. */
export async function main(argv: readonly string[], deps: LiveRunDeps): Promise<number> {
  const [subcommand, ...rest] = argv;
  if (subcommand === 'plan') return plan(rest, deps);
  if (subcommand === 'send') return send(rest, deps);
  if (subcommand === 'check-saved') return checkSaved(rest, deps);
  return usage(deps);
}

// Bundled into dist/tools/live-run-cli.mjs and run by scripts/live-run.mjs. A test that imports
// this file runs nothing, because its own URL is not the process entry then. The live factory is
// handed over unbuilt: the root calls it only after the switch reads exactly live.
const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  const deps = buildLiveRunRoot({
    runtimeContext: 'deployed',
    switchValue: readLiveSwitch(),
    liveFactory: () => createLiveRunPortFactory(),
    repoRoot: process.cwd(),
  });
  process.exit(await main(process.argv.slice(2), deps));
}
