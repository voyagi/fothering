import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { DEPLOY_STEPS, FORGET_DOC, REMOVAL_STEP_TEXTS, type DeployCommandUse } from './content.js';

const REPO_PACKAGE_NAME = 'fothering';

function packageNameAt(folder: string): string | undefined {
  const file = join(folder, 'package.json');
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null && 'name' in parsed ? String(parsed.name) : undefined;
  } catch {
    throw new Error(`${file}: not valid JSON`);
  }
}

// Callers pass process.cwd(): during an Astro build that is packages/web, whose own package.json
// is the workspace's, so the walk has to look past the nearest manifest to the named root.
export function repoRoot(start: string): string {
  let folder = resolve(start);
  for (;;) {
    if (packageNameAt(folder) === REPO_PACKAGE_NAME) return folder;
    const parent = dirname(folder);
    if (parent === folder) throw new Error(`no package.json named ${REPO_PACKAGE_NAME} at or above ${resolve(start)}`);
    folder = parent;
  }
}

// Pages read committed files through this instead of new URL(..., import.meta.url), which Vite
// would rewrite into a bundled asset reference.
export function readRepoText(relativePath: string, root: string): string {
  const file = resolve(root, relativePath);
  const fromRoot = relative(root, file);
  const escapes = fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot);
  if (isAbsolute(relativePath) || escapes) {
    throw new Error(`${relativePath}: outside the repository root`);
  }
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`${relativePath}: not found`);
    throw error;
  }
  if (text.trim() === '') throw new Error(`${relativePath}: empty`);
  return text;
}

export interface DeployCommand {
  command: string;
  /** The line's trailing `# ...` comment, or null. */
  note: string | null;
}

const DEPLOY_SECTION = '## Deploy and remove';
const README_PREFIX = `README.md: ${DEPLOY_SECTION.slice(3)}`;

function deploySectionLines(readmeText: string): string[] {
  const lines = readmeText.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trimEnd() === DEPLOY_SECTION);
  if (start === -1) throw new Error(`${README_PREFIX}: section not found. Restore the "${DEPLOY_SECTION}" heading.`);
  const next = lines.findIndex((line, index) => index > start && line.startsWith('## '));
  return lines.slice(start + 1, next === -1 ? undefined : next);
}

function commandOf(line: string): DeployCommand | undefined {
  const match = /^(.*?)\s+#\s*(.*)$/.exec(line);
  const command = (match ? (match[1] ?? '') : line).trim();
  if (command === '' || command.startsWith('#')) return undefined;
  const note = match?.[2]?.trim();
  return { command, note: note === undefined || note === '' ? null : note };
}

// The lines inside fenced sh blocks, and whether the last block was left open.
function shBlockLines(lines: readonly string[]): { lines: string[]; open: boolean } {
  const inside: string[] = [];
  let open = false;
  for (const line of lines) {
    const fence = line.trim();
    if (!open && fence === '```sh') open = true;
    else if (open && fence === '```') open = false;
    else if (open) inside.push(line);
  }
  return { lines: inside, open };
}

// A line ending in a backslash continues on the next, as the shell reads it, so a long command the
// README wraps is one command here and never a run of fragments.
function joinContinuations(lines: readonly string[]): string[] {
  const joined: string[] = [];
  let pending: string | undefined;
  for (const line of lines) {
    const text = pending === undefined ? line : `${pending} ${line.trim()}`;
    const continued = /\s*\\$/.exec(text);
    pending = continued ? text.slice(0, continued.index) : undefined;
    if (!continued) joined.push(text);
  }
  if (pending !== undefined) throw new Error(`${README_PREFIX}: a command ends in a backslash with no line after it. Finish the command or drop the backslash.`);
  return joined;
}

export function readDeployCommands(readmeText: string): DeployCommand[] {
  const block = shBlockLines(deploySectionLines(readmeText));
  if (block.open) throw new Error(`${README_PREFIX}: a sh block is not closed. Close it with a line holding three backticks.`);
  const commands = joinContinuations(block.lines).map(commandOf).filter((command): command is DeployCommand => command !== undefined);
  if (commands.length === 0) throw new Error(`${README_PREFIX}: no fenced sh block with a command. Put the deploy commands in sh blocks.`);
  return commands;
}

// The deploy page may show a command only when README offers that exact line or it runs a script
// package.json defines, so a renamed or removed script cannot linger on the page.
export function isOfferedCommand(line: string, commands: readonly DeployCommand[], scripts: readonly string[]): boolean {
  const offered = line.trim();
  if (commands.some(({ command }) => command === offered)) return true;
  const script = /^npm run (\S+)$/.exec(offered)?.[1];
  return script !== undefined && scripts.includes(script);
}

const MODEL_VALUES_PATH = 'packages/core/src/model-values.ts';
const ADR_PATH = 'docs/adr/0001-stack.md';

function distinct(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function idsInModelValues(text: string): string[] {
  return distinct([...text.matchAll(/\binferenceProfileId\s*:\s*(['"`])([^'"`]+)\1/g)].map((match) => match[2] ?? ''));
}

function idsInAdr(text: string): string[] {
  const rows = text.split(/\r?\n/).filter((line) => /^\|\s*Model\s*\|/.test(line));
  return distinct(rows.flatMap((row) => [...row.matchAll(/`([^`]+)`/g)].map((match) => match[1] ?? '')));
}

// model-values.ts, when the branch has it, is the pin the agent itself reads; the ADR row is the
// fallback before that file exists. A phase 2 merge therefore changes the id with no site edit.
export function resolveModelId(sources: { modelValuesText?: string | undefined; adrText: string }): string {
  const ids = sources.modelValuesText === undefined ? idsInAdr(sources.adrText) : idsInModelValues(sources.modelValuesText);
  const [id] = ids;
  if (ids.length !== 1 || id === undefined) {
    throw new Error(`model id: found ${ids.length} ids, expected exactly one in ${MODEL_VALUES_PATH} or ${ADR_PATH}.`);
  }
  return id;
}

function scriptNames(packageText: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(packageText);
  } catch {
    throw new Error('package.json: not valid JSON. Fix the file.');
  }
  const scripts = (parsed as { scripts?: unknown }).scripts;
  if (typeof scripts !== 'object' || scripts === null || Array.isArray(scripts)) {
    throw new Error('package.json: scripts: missing or not an object. Restore the scripts field.');
  }
  return Object.keys(scripts);
}

export interface DeployStep {
  title: string;
  text: string;
  commands: DeployCommand[];
}

export interface RemovalStep {
  text: string;
  commands: DeployCommand[];
}

// What a README line does, read from its CDK verb, so a step shows whichever line the README holds
// for it (a later README that names the stacks instead of --all still lands on the same step).
const COMMAND_USES: Readonly<Record<DeployCommandUse, RegExp>> = {
  'build': /^npm run build$/,
  'bootstrap': /^npx cdk bootstrap\b/,
  'deploy': /^npx cdk deploy\b(?!.*\s(?:-c|--context)\s)/,
  'go-live': /^npx cdk deploy\b.*\s(?:-c|--context)\s/,
  'destroy': /^npx cdk destroy\b/,
};

const STACK_USES: ReadonlySet<DeployCommandUse> = new Set(['deploy', 'go-live', 'destroy']);

// How many stacks a cdk line selects: --all selects every one, otherwise each word that is neither
// an option nor a context value names one. Any other option may take a value (--profile p) or not
// (--exclusively), which no word count can tell apart, so such a line is refused rather than counted.
function stackScope(command: string): number {
  const words = command.split(/\s+/).slice(3);
  if (words.includes('--all')) return Number.POSITIVE_INFINITY;
  let named = 0;
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index] ?? '';
    if (word === '-c' || word === '--context') index += 1;
    else if (word.startsWith('--context=')) continue;
    else if (word.startsWith('-')) {
      throw new Error(`${README_PREFIX}: "${command}" holds the option ${word}, and the deploy sheet counts the stacks a line selects from its words. Keep only --all, -c or --context on that line, or name the stacks.`);
    } else named += 1;
  }
  return named;
}

// A cdk line that selects fewer stacks than another for the same use belongs to a narrower
// procedure (the README's model trial deploys the runtime alone), not to the deploy sheet's step.
function widestScope(found: readonly DeployCommand[]): DeployCommand[] {
  const widest = Math.max(...found.map(({ command }) => stackScope(command)));
  return found.filter(({ command }) => stackScope(command) === widest);
}

function commandsFor(commands: readonly DeployCommand[], use: DeployCommandUse): DeployCommand[] {
  const found = commands.filter(({ command }) => COMMAND_USES[use].test(command));
  if (found.length === 0) throw new Error(`${README_PREFIX}: no ${use} command. Restore the ${use} line in its sh block.`);
  return STACK_USES.has(use) ? widestScope(found) : found;
}

export const fillRegion = (text: string, region: string): string => text.replaceAll('{region}', region);

export function deploySteps(facts: { deployCommands: readonly DeployCommand[]; region: string }): DeployStep[] {
  return DEPLOY_STEPS.map((step) => ({
    title: step.title,
    text: fillRegion(step.text, facts.region),
    commands: step.uses.flatMap((use) => commandsFor(facts.deployCommands, use)),
  }));
}

// Pre-R6: delete the stacks, then the event destinations the operator added. Plan 05-15 puts the
// reopen step in front of these once phase 3's command is on the branch.
export function removalSteps(facts: { deployCommands: readonly DeployCommand[] }): RemovalStep[] {
  return [
    { text: REMOVAL_STEP_TEXTS.destroy, commands: commandsFor(facts.deployCommands, 'destroy') },
    { text: REMOVAL_STEP_TEXTS.destinations, commands: [] },
  ];
}

export function removedByText(commands: readonly DeployCommand[]): string {
  return commandsFor(commands, 'destroy').map(({ command }) => command).join(' and ');
}

export interface ForgetCommand {
  // The command line that runs the forget function, without its arguments.
  readonly command: string;
  // The stack output that names the function the command runs.
  readonly output: string;
}

// The privacy section names the delete-one-recipient command as the doc writes it, so a renamed
// command or function output reaches the page with no edit there. The argument lines carry an
// example address, which no page may show, so only the command and the output name are read.
export function readForgetCommand(docText: string): ForgetCommand {
  const invoke = shBlockLines(docText.split(/\r?\n/)).lines.map((line) => line.trim()).find((line) => line.startsWith('aws lambda invoke'));
  if (invoke === undefined) throw new Error(`${FORGET_DOC}: no aws lambda invoke line in a sh block. Restore the command that runs the forget function.`);
  const output = /<(\w+) stack output>/.exec(docText)?.[1];
  if (output === undefined) throw new Error(`${FORGET_DOC}: no stack output names the function. Restore the --function-name <...> stack output placeholder.`);
  return { command: invoke.replace(/\s*\\$/, ''), output };
}

const CREATE_APP_PATH = 'packages/infra/src/create-app.ts';

// The stacks pin one Region in their env; the deploy sheet names that one rather than a typed copy.
export function readDeployRegion(root: string): string {
  const regions = distinct([...readRepoText(CREATE_APP_PATH, root).matchAll(/\bregion\s*:\s*(['"])([a-z0-9-]+)\1/g)].map((match) => match[2] ?? ''));
  const [region] = regions;
  if (regions.length !== 1 || region === undefined) {
    throw new Error(`${CREATE_APP_PATH}: found ${regions.length} Regions, expected exactly one. Pin the stacks' Region in one env.`);
  }
  return region;
}

export function loadRepoFacts(root: string): { deployCommands: DeployCommand[]; scripts: string[]; modelId: string } {
  const modelValuesText = existsSync(resolve(root, MODEL_VALUES_PATH)) ? readRepoText(MODEL_VALUES_PATH, root) : undefined;
  return {
    deployCommands: readDeployCommands(readRepoText('README.md', root)),
    scripts: scriptNames(readRepoText('package.json', root)),
    modelId: resolveModelId({ modelValuesText, adrText: readRepoText(ADR_PATH, root) }),
  };
}
