import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { MODEL_VALUES } from '@fothering/core/model-values';
import { afterAll, describe, expect, it } from 'vitest';
import {
  denyRows,
  hasPauseGrant,
  loadPermissionSnapshot,
  PERMISSION_REASONS,
  permissionKey,
  permissionSchedules,
  runtimeRoleHoldsNoDataAction,
} from './permissions-view.js';
import { DEPLOY_STEPS, REMOVAL_STEP_TEXTS } from './content.js';
import {
  deploySteps,
  isOfferedCommand,
  loadRepoFacts,
  readDeployCommands,
  readDeployRegion,
  readRepoText,
  removalSteps,
  removedByText,
  repoRoot,
  resolveModelId,
} from './repo-facts.js';
import { loadResourceSnapshot, NOT_LISTED, RESOURCE_NOUNS, resourceRows } from './resources-view.js';

const ROOT = repoRoot(process.cwd());

// Planted roots sit under the repo's git-ignored node_modules/.cache, the site tests' convention.
const CACHE = join(ROOT, 'node_modules', '.cache');
mkdirSync(CACHE, { recursive: true });
const PLANT = mkdtempSync(join(CACHE, 'site-deploy-'));

afterAll(() => {
  rmSync(PLANT, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

interface SnapshotResource {
  stack: string;
  logicalId: string;
  type: string;
  deletionPolicy: string;
}

interface SnapshotPermission {
  stack: string;
  role: string;
  kind: string;
  effect: string;
  action: string;
  resource: string | null;
  principal: string | null;
  condition: string | null;
}

function committedResources(): SnapshotResource[] {
  return JSON.parse(readRepoText('packages/infra/resources.json', ROOT)) as SnapshotResource[];
}

function committedPermissions(): SnapshotPermission[] {
  return loadPermissionSnapshot(ROOT) as SnapshotPermission[];
}

function resource(overrides: Partial<SnapshotResource>): SnapshotResource {
  return { stack: 'FotheringIngest', logicalId: 'EventStore165FCE28', type: 'AWS::DynamoDB::Table', deletionPolicy: 'Delete', ...overrides };
}

function permission(overrides: Partial<SnapshotPermission>): SnapshotPermission {
  return {
    stack: 'FotheringIngest',
    role: 'IngestRoleAF8AE6D8',
    kind: 'permission',
    effect: 'Allow',
    action: 'dynamodb:PutItem',
    resource: '{"Fn::GetAtt":["EventStore165FCE28","Arn"]}',
    principal: null,
    condition: null,
    ...overrides,
  };
}

function shuffled<T>(values: readonly T[]): T[] {
  // A fixed interleave rather than a random one, so a failure reproduces.
  const odd = values.filter((_, index) => index % 2 === 1).reverse();
  const even = values.filter((_, index) => index % 2 === 0);
  return [...odd, ...even];
}

function plantFile(relative: string, text: string): void {
  const file = join(PLANT, relative);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
}

describe('the snapshot loaders', () => {
  it('name the file and the snapshot command when a snapshot is not JSON', () => {
    const root = join(PLANT, 'torn-snapshots');
    for (const name of ['permissions', 'resources']) plantFile(`torn-snapshots/packages/infra/${name}.json`, '[{"stack": ');
    expect(() => loadPermissionSnapshot(root)).toThrow(/^packages\/infra\/permissions\.json: not valid JSON \([\s\S]+\)\. Run npm run permissions:snapshot\.$/);
    expect(() => loadResourceSnapshot(root)).toThrow(/^packages\/infra\/resources\.json: not valid JSON \([\s\S]+\)\. Run npm run permissions:snapshot\.$/);
  });
});

describe('the resource schedule', () => {
  it('classes every type in the committed snapshot in exactly one of the noun map and the not-listed map', () => {
    for (const { type } of committedResources()) {
      expect([Object.hasOwn(RESOURCE_NOUNS, type), Object.hasOwn(NOT_LISTED, type)].filter(Boolean), type).toHaveLength(1);
    }
  });

  it('holds no class for a type the committed snapshot lacks', () => {
    const present = new Set(committedResources().map((entry) => entry.type));
    for (const type of [...Object.keys(RESOURCE_NOUNS), ...Object.keys(NOT_LISTED)]) expect(present.has(type), type).toBe(true);
  });

  it('gives every not-listed type a reason', () => {
    for (const reason of Object.values(NOT_LISTED)) expect(reason.trim()).not.toBe('');
  });

  it('returns one row per listed resource of the committed snapshot, in snapshot order', () => {
    const committed = committedResources();
    const listed = committed.filter((entry) => Object.hasOwn(RESOURCE_NOUNS, entry.type));
    const rows = resourceRows(committed);
    expect(rows.map((row) => `${row.stack}/${row.logicalId}`)).toEqual(listed.map((entry) => `${entry.stack}/${entry.logicalId}`));
    expect(rows.length).toBeGreaterThan(0);
  });

  it('throws naming stack, logical id and type for a planted unclassified type', () => {
    const planted = [...committedResources(), resource({ logicalId: 'PlantedTopic', type: 'AWS::SNS::Topic' })];
    expect(() => resourceRows(planted)).toThrow(/FotheringIngest\/PlantedTopic.*AWS::SNS::Topic/);
  });

  it('throws on an empty resource list', () => {
    expect(() => resourceRows([])).toThrow('packages/infra/resources.json: no entries. Run npm run permissions:snapshot.');
  });

  it('reads a Delete policy (the snapshot form of an absent one) as deleted on removal and Retain as kept', () => {
    const [deleted, kept] = resourceRows([resource({ deletionPolicy: 'Delete' }), resource({ logicalId: 'Kept', deletionPolicy: 'Retain' })]);
    expect(deleted?.deletedOnRemoval).toBe(true);
    expect(kept?.deletedOnRemoval).toBe(false);
  });

  it('throws on a removal policy it has no wording for, and names a malformed entry', () => {
    expect(() => resourceRows([resource({ deletionPolicy: 'Snapshot' })])).toThrow(/\[0\]\.deletionPolicy.*Snapshot/);
    expect(() => resourceRows([{ stack: 'FotheringIngest', logicalId: 'X' }])).toThrow(/\[0\]\.type/);
  });

  it('names each listed type with its page noun', () => {
    const table = resourceRows([resource({})])[0];
    expect(table?.noun).toBe('table');
  });
});

describe('the permissions schedules', () => {
  it('returns every committed entry exactly once, grouped per role, with all seven fields', () => {
    const committed = committedPermissions();
    const schedules = permissionSchedules(committed);
    const rows = schedules.flatMap((schedule) => schedule.rows);
    expect(rows).toHaveLength(committed.length);
    expect(rows.map((row) => [row.stack, row.role, row.kind, row.effect, row.action, row.resourceOrPrincipal, row.condition])).toEqual(
      committed.map((entry) => [entry.stack, entry.role, entry.kind, entry.effect, entry.action, entry.resource ?? entry.principal ?? '', entry.condition ?? '']),
    );
    for (const schedule of schedules) {
      for (const row of schedule.rows) expect(`${row.stack}/${row.role}`).toBe(`${schedule.stack}/${schedule.role}`);
    }
    expect(schedules.map((schedule) => schedule.role)).toEqual(['DetectRoleDEDAD076', 'ForgetRole9C1F5950', 'IngestRoleAF8AE6D8', 'RuntimeRoleFD8790A4']);
  });

  it('gives a trust row its principal and an empty condition cell where the entry has none', () => {
    const rows = permissionSchedules(committedPermissions()).flatMap((schedule) => schedule.rows);
    const ingestTrust = rows.find((row) => row.role === 'IngestRoleAF8AE6D8' && row.kind === 'trust');
    expect(ingestTrust?.resourceOrPrincipal).toBe('{"Service":"lambda.amazonaws.com"}');
    expect(ingestTrust?.condition).toBe('');
  });

  it('renders two entries differing only in resource as two rows', () => {
    const second = permission({ resource: '{"Ref":"SecondTable"}' });
    const reasons = { [permissionKey(second)]: 'Planted.' };
    const rows = permissionSchedules([permission({}), second], reasons).flatMap((schedule) => schedule.rows);
    expect(rows.map((row) => row.resourceOrPrincipal)).toEqual(['{"Fn::GetAtt":["EventStore165FCE28","Arn"]}', '{"Ref":"SecondTable"}']);
  });

  it('renders a shuffled copy of the snapshot as the same table', () => {
    const committed = committedPermissions();
    expect(shuffled(committed)).not.toEqual(committed);
    expect(permissionSchedules(shuffled(committed))).toEqual(permissionSchedules(committed));
  });

  it('throws on an empty snapshot with the build message', () => {
    expect(() => permissionSchedules([])).toThrow('packages/infra/permissions.json: no entries. Run npm run permissions:snapshot.');
  });

  it('names the first malformed entry', () => {
    expect(() => permissionSchedules([permission({}), permission({ kind: 'grant' })])).toThrow(/^packages\/infra\/permissions\.json: \[1\]\.kind: /);
    expect(() => permissionSchedules([{ ...permission({}), resource: 3 }])).toThrow(/^packages\/infra\/permissions\.json: \[0\]\.resource: /);
  });
});

describe('the Deny rows', () => {
  it('are empty for the shipped snapshot', () => {
    expect(denyRows(committedPermissions())).toEqual([]);
  });

  it('hold one row per role for a Deny planted on every role', () => {
    const roles = [...new Map(committedPermissions().map((entry) => [`${entry.stack}/${entry.role}`, entry])).values()];
    const denies = roles.map((entry) => permission({ stack: entry.stack, role: entry.role, effect: 'Deny', action: 'ses:PutConfigurationSetSendingOptions', resource: '"*"' }));
    const reasons = { ...PERMISSION_REASONS, ...Object.fromEntries(denies.map((deny) => [permissionKey(deny), 'Planted.'])) };
    expect(denies.length).toBeGreaterThan(1);
    const rows = denyRows([...committedPermissions(), ...denies], reasons);
    expect(rows.map((row) => `${row.effect} ${row.action}`)).toEqual(denies.map(() => 'Deny ses:PutConfigurationSetSendingOptions'));
  });

  it('refuse a Deny that some role lacks, which the heading "Denied on every role" would misstate', () => {
    const deny = permission({ role: 'IngestRoleAF8AE6D8', effect: 'Deny', action: 'ses:PutConfigurationSetSendingOptions', resource: '"*"' });
    const reasons = { ...PERMISSION_REASONS, [permissionKey(deny)]: 'Planted.' };
    expect(() => denyRows([...committedPermissions(), deny], reasons)).toThrow(/: ses:PutConfigurationSetSendingOptions is denied on some roles but not on FotheringDetection\/DetectRole, FotheringIngest\/ForgetRole, FotheringRuntime\/RuntimeRole, and the deploy page heads the Deny box "Denied on every role"\. Deny it on every role, or retitle the box\.$/);
  });
});

describe('the permission reasons', () => {
  it('strips the 8-hex CDK suffix from the role in the key', () => {
    expect(permissionKey(permission({}))).toBe('FotheringIngest/IngestRole/permission/Allow/dynamodb:PutItem');
  });

  it('hold one reason per entry key of the shipped snapshot, and no reason without an entry', () => {
    const keys = new Set(committedPermissions().map(permissionKey));
    expect(new Set(Object.keys(PERMISSION_REASONS))).toEqual(keys);
    for (const reason of Object.values(PERMISSION_REASONS)) expect(reason.trim()).not.toBe('');
  });

  it('fail on a planted entry with no reason, naming its key', () => {
    const planted = [...committedPermissions(), permission({ action: 'dynamodb:DeleteItem' })];
    expect(() => permissionSchedules(planted)).toThrow(
      'permission reasons: no reason for FotheringIngest/IngestRole/permission/Allow/dynamodb:DeleteItem. Add one to the reasons map.',
    );
  });

  it('fail on a planted reason that matches no entry', () => {
    const reasons = { ...PERMISSION_REASONS, 'FotheringIngest/IngestRole/permission/Allow/s3:GetObject': 'Planted.' };
    expect(() => permissionSchedules(committedPermissions(), reasons)).toThrow(/FotheringIngest\/IngestRole\/permission\/Allow\/s3:GetObject/);
  });

  it('attach each reason to its row', () => {
    const rows = permissionSchedules(committedPermissions()).flatMap((schedule) => schedule.rows);
    for (const row of rows) expect(row.reason).toBe(PERMISSION_REASONS[permissionKey(row) as keyof typeof PERMISSION_REASONS]);
  });

  // Counter items change only through conditional updates (port-types.ts), so detection's key reads
  // are a lane's incident marker and an incident's evidence, state and decision items (detect.ts).
  it('never say the detection role reads a counter item by its key', () => {
    const getItem = PERMISSION_REASONS['FotheringDetection/DetectRole/permission/Allow/dynamodb:GetItem'];
    expect(getItem).not.toMatch(/counter/i);
    expect(getItem).toMatch(/incident marker/);
  });
});

describe('the pause grant and runtime role predicates', () => {
  it('report no pause grant in the shipped snapshot', () => {
    expect(hasPauseGrant(committedPermissions())).toBe(false);
  });

  it('report a pause grant for a planted Allow of ses:PutConfigurationSetSendingOptions', () => {
    const planted = [...committedPermissions(), permission({ action: 'ses:PutConfigurationSetSendingOptions', resource: '"*"' })];
    expect(hasPauseGrant(planted)).toBe(true);
  });

  it('refuse one role name in two stacks, which would give two role sections one id', () => {
    const twin = permission({ stack: 'FotheringOther', role: 'IngestRoleABCDEF12' });
    const reasons = { ...PERMISSION_REASONS, [permissionKey(twin)]: 'Planted.' };
    expect(() => permissionSchedules([...committedPermissions(), twin], reasons)).toThrow(/: two roles are named IngestRole, in FotheringIngest and FotheringOther, and the deploy page ids each role section by its name\. Rename one of them\.$/);
    const renamed = permission({ stack: 'FotheringOther', role: 'OtherRoleABCDEF12' });
    expect(() => permissionSchedules([...committedPermissions(), renamed], { ...PERMISSION_REASONS, [permissionKey(renamed)]: 'Planted.' })).not.toThrow();
  });

  it('report a pause grant for a wildcard Allow that covers the action, and none for one that does not', () => {
    for (const action of ['ses:*', '*', 'ses:PutConfigurationSet*', 'SES:putconfigurationsetsendingoptions', 'ses:PutConfigurationSetSendingOption?']) {
      expect(hasPauseGrant([...committedPermissions(), permission({ action, resource: '"*"' })]), action).toBe(true);
    }
    for (const action of ['ses:Get*', 'ses:PutConfigurationSetSendingOptions?', 'dynamodb:*', 'ses:PutConfigurationSet.SendingOptions']) {
      expect(hasPauseGrant([...committedPermissions(), permission({ action, resource: '"*"' })]), action).toBe(false);
    }
  });

  it('report no pause grant for a Deny of it alone', () => {
    const planted = [...committedPermissions(), permission({ effect: 'Deny', action: 'ses:PutConfigurationSetSendingOptions', resource: '"*"' })];
    expect(hasPauseGrant(planted)).toBe(false);
  });

  it('find no SES, DynamoDB or S3 action on the shipped runtime role', () => {
    expect(runtimeRoleHoldsNoDataAction(committedPermissions())).toBe(true);
  });

  it('find a data action planted on the runtime role', () => {
    for (const action of ['ses:SendEmail', 'dynamodb:GetItem', 's3:GetObject', 'S3:GetObject', '*']) {
      const planted = [...committedPermissions(), permission({ stack: 'FotheringRuntime', role: 'RuntimeRoleFD8790A4', action, resource: '"*"' })];
      expect(runtimeRoleHoldsNoDataAction(planted), action).toBe(false);
    }
  });

  it('throws when the snapshot names no runtime role, rather than reading that as holding nothing', () => {
    const withoutRuntime = committedPermissions().filter((entry) => entry.stack !== 'FotheringRuntime');
    expect(() => runtimeRoleHoldsNoDataAction(withoutRuntime)).toThrow(/runtime role/);
  });
});

const README_COMMANDS = [
  { command: 'npm run build', note: null },
  { command: 'npx cdk bootstrap', note: 'once, before the first deploy' },
  { command: 'npx cdk deploy --all', note: null },
  { command: 'npx cdk destroy --all', note: null },
  { command: 'npx cdk deploy --all -c fothering:live=live', note: null },
  { command: 'npx cdk deploy FotheringRuntime -c fothering:live=live', note: null },
  {
    command:
      'aws bedrock-agentcore invoke-agent-runtime --region eu-central-1 --agent-runtime-arn <runtime arn> --runtime-session-id fothering-trial-0000000000000000000001 --payload fileb://record.json --cli-read-timeout 120 response.json',
    note: null,
  },
  { command: 'aws events test-event-pattern --event-pattern file://rule-pattern.json --event file://sample-event.json', note: null },
  { command: 'aws sesv2 get-configuration-set --region eu-central-1 --configuration-set-name <a set from lanes.json>', note: null },
];

describe('the README deploy commands', () => {
  const readme = readRepoText('README.md', ROOT);

  it('returns the command lines of Deploy and remove in order, with the bootstrap note', () => {
    expect(readDeployCommands(readme)).toEqual(README_COMMANDS);
  });

  it('reads a command continued over several lines with backslashes as one command', () => {
    const section = '## Deploy and remove\n\n```sh\naws planted run \\\n  --flag value \\\n  out.json\nnpm run build\n```\n';
    expect(readDeployCommands(section)).toEqual([
      { command: 'aws planted run --flag value out.json', note: null },
      { command: 'npm run build', note: null },
    ]);
  });

  it('throws on a block whose last command still ends in a backslash', () => {
    expect(() => readDeployCommands('## Deploy and remove\n\n```sh\naws planted run \\\n```\n')).toThrow(/ends in a backslash/);
  });

  it('reads a backslash at the end of a comment as comment text, the way the shell does', () => {
    const section = '## Deploy and remove\n\n```sh\nnpx cdk bootstrap  # once \\\n# a note \\\nnpm run build\n```\n';
    expect(readDeployCommands(section)).toEqual([
      { command: 'npx cdk bootstrap', note: 'once \\' },
      { command: 'npm run build', note: null },
    ]);
  });

  it('throws when the Deploy and remove section is missing', () => {
    expect(() => readDeployCommands(readme.replace('## Deploy and remove', '## Install'))).toThrow(/^README\.md: Deploy and remove: section not found/);
  });

  it('throws when the section holds no fenced sh block', () => {
    const section = '# Fothering\n\n## Deploy and remove\n\nRun npm run build.\n\n## Forget one recipient\n\n```sh\nnpm test\n```\n';
    expect(() => readDeployCommands(section)).toThrow(/^README\.md: Deploy and remove: no fenced sh block/);
  });

  it('throws on a block left open', () => {
    expect(() => readDeployCommands('## Deploy and remove\n\n```sh\nnpm run build\n')).toThrow(/not closed/);
  });

  it('reads CRLF line endings the same as LF', () => {
    expect(readDeployCommands(readme.replace(/\r?\n/g, '\r\n'))).toEqual(README_COMMANDS);
  });
});

describe('isOfferedCommand', () => {
  const commands = readDeployCommands(readRepoText('README.md', ROOT));
  const scripts = Object.keys((JSON.parse(readRepoText('package.json', ROOT)) as { scripts: Record<string, string> }).scripts);

  it('accepts each README command line', () => {
    for (const { command } of README_COMMANDS) expect(isOfferedCommand(command, commands, scripts), command).toBe(true);
  });

  it('accepts npm run for a script package.json defines', () => {
    expect(isOfferedCommand('npm run build', commands, scripts)).toBe(true);
    expect(isOfferedCommand('npm run permissions:snapshot', commands, scripts)).toBe(true);
  });

  it('rejects npm run synth and npm run deploy, which no script defines', () => {
    expect(isOfferedCommand('npm run synth', commands, scripts)).toBe(false);
    expect(isOfferedCommand('npm run deploy', commands, scripts)).toBe(false);
  });

  it('rejects a line the README does not hold', () => {
    expect(isOfferedCommand('npx cdk deploy FotheringIngest', commands, scripts)).toBe(false);
    expect(isOfferedCommand('wrangler deploy', commands, scripts)).toBe(false);
  });
});

const ADR_ROW = '| Model | Claude Sonnet 5 through the EU inference profile `eu.anthropic.claude-sonnet-5` | |';
const ZERO_IDS = 'model id: found 0 ids, expected exactly one in packages/core/src/model-values.ts or docs/adr/0001-stack.md.';

describe('resolveModelId', () => {
  const adrText = readRepoText('docs/adr/0001-stack.md', ROOT);

  it('reads the Model row of the committed ADR when model-values.ts is absent', () => {
    expect(resolveModelId({ adrText })).toBe('eu.anthropic.claude-sonnet-4-6');
  });

  it('reads inferenceProfileId from model-values.ts text when it is given', () => {
    const modelValuesText = [
      'export const MODEL_VALUES = {',
      "  inferenceProfileId: 'eu.example-profile.model-1',",
      "  modelId: 'anthropic.model-1',",
      '} as const;',
      'export const PINNED_MODEL_VALUES = { profileId: MODEL_VALUES.inferenceProfileId } as const;',
    ].join('\n');
    expect(resolveModelId({ modelValuesText, adrText })).toBe('eu.example-profile.model-1');
  });

  it('throws on zero ids in model-values.ts text', () => {
    expect(() => resolveModelId({ modelValuesText: 'export const MODEL_VALUES = {} as const;\n', adrText })).toThrow(ZERO_IDS);
  });

  it('throws on two ids in model-values.ts text', () => {
    const modelValuesText = "const a = { inferenceProfileId: 'eu.one' };\nconst b = { inferenceProfileId: 'eu.two' };\n";
    expect(() => resolveModelId({ modelValuesText, adrText })).toThrow(
      'model id: found 2 ids, expected exactly one in packages/core/src/model-values.ts or docs/adr/0001-stack.md.',
    );
  });

  it('throws on an ADR with no Model row, and on a Model row naming two ids', () => {
    expect(() => resolveModelId({ adrText: '| Language | TypeScript | 6.0.3 |\n' })).toThrow(ZERO_IDS);
    expect(() => resolveModelId({ adrText: `${ADR_ROW.replace('` |', '` or `eu.other` |')}\n` })).toThrow(/found 2 ids/);
  });
});

describe('the removal steps (pre-R6)', () => {
  const facts = loadRepoFacts(ROOT);
  // The README's own destroy lines, read here from the README rather than typed.
  const destroyLines = facts.deployCommands.filter(({ command }) => command.split(' ').includes('destroy'));

  it('gives the README destroy command as the first step and the event destinations after it', () => {
    expect(destroyLines.length).toBeGreaterThan(0);
    expect(removalSteps(facts)).toEqual([
      { text: REMOVAL_STEP_TEXTS.destroy, commands: destroyLines },
      { text: REMOVAL_STEP_TEXTS.destinations, commands: [] },
    ]);
  });

  it('shows only commands the README or package.json offers', () => {
    for (const step of removalSteps(facts)) {
      for (const { command } of step.commands) expect(isOfferedCommand(command, facts.deployCommands, facts.scripts), command).toBe(true);
    }
  });

  it('throws when the README holds no destroy line', () => {
    expect(() => removalSteps({ deployCommands: facts.deployCommands.filter((command) => !destroyLines.includes(command)) })).toThrow(
      /^README\.md: Deploy and remove: no destroy command/,
    );
  });

  it('words a deleted resource with the README destroy line', () => {
    expect(removedByText(facts.deployCommands)).toBe(destroyLines.map(({ command }) => command).join(' and '));
  });
});

describe('the deploy steps', () => {
  const facts = loadRepoFacts(ROOT);
  const steps = deploySteps({ deployCommands: facts.deployCommands, region: 'xx-planted-9' });
  const lineOf = (index: number): string | undefined => facts.deployCommands[index]?.command;

  it('gives the five step titles and texts of the content module, with the Region filled in', () => {
    expect(steps.map((step) => step.title)).toEqual(DEPLOY_STEPS.map((step) => step.title));
    expect(steps[0]?.text).toContain('`xx-planted-9`');
    expect(steps.some((step) => step.text.includes('{region}'))).toBe(false);
  });

  it('puts no command on the first two steps', () => {
    expect(steps.slice(0, 2).map((step) => step.commands)).toEqual([[], []]);
  });

  it('takes the build, bootstrap, deploy and go-live lines from the README, notes kept', () => {
    // README order: build, bootstrap, deploy, destroy, then the go-live deploy.
    expect(steps[2]?.commands.map(({ command }) => command)).toEqual([lineOf(0)]);
    expect(steps[3]?.commands).toEqual([facts.deployCommands[1], facts.deployCommands[2]]);
    expect(steps[3]?.commands[0]?.note).not.toBeNull();
    expect(steps[4]?.commands.map(({ command }) => command)).toEqual([lineOf(4)]);
  });

  // The README's model trial deploys one stack with the switch on; it is not the step that turns
  // the switch on for the app.
  it('leaves a cdk line naming fewer stacks off its step, whether the wider line says --all or names every stack', () => {
    const lines = (commands: readonly string[]) => commands.map((command) => ({ command, note: null }));
    const base = ['npm run build', 'npx cdk bootstrap'];
    const withAll = deploySteps({
      deployCommands: lines([...base, 'npx cdk deploy --all', 'npx cdk deploy --all -c fothering:live=live', 'npx cdk deploy B -c fothering:live=live']),
      region: 'xx-planted-9',
    });
    expect(withAll[4]?.commands.map(({ command }) => command)).toEqual(['npx cdk deploy --all -c fothering:live=live']);
    const named = deploySteps({
      deployCommands: lines([...base, 'npx cdk deploy A B C', 'npx cdk deploy B', 'npx cdk deploy A B C --context fothering:live=live', 'npx cdk deploy B -c fothering:live=live']),
      region: 'xx-planted-9',
    });
    expect(named[3]?.commands.map(({ command }) => command)).toEqual(['npx cdk bootstrap', 'npx cdk deploy A B C']);
    expect(named[4]?.commands.map(({ command }) => command)).toEqual(['npx cdk deploy A B C --context fothering:live=live']);
  });

  // Counted as words, --profile p would read as two stacks and tie B's trial with A B; it is refused.
  it('refuses a cdk line naming stacks beside an option other than --all, -c or --context, and reads --context=', () => {
    const lines = (commands: readonly string[]) => commands.map((command) => ({ command, note: null }));
    const base = ['npm run build', 'npx cdk bootstrap', 'npx cdk deploy --all -c fothering:live=live', 'npx cdk destroy --all'];
    expect(() => deploySteps({ deployCommands: lines([...base, 'npx cdk deploy A B', 'npx cdk deploy B --profile p']), region: 'xx-planted-9' })).toThrow(
      /^README\.md: Deploy and remove: "npx cdk deploy B --profile p" holds the option --profile, and the deploy sheet counts the stacks a line selects from its words\. /,
    );
    const steps = deploySteps({ deployCommands: lines([...base, 'npx cdk deploy A B', 'npx cdk deploy B --context=fothering:trial=1']), region: 'xx-planted-9' });
    expect(steps[3]?.commands.map(({ command }) => command)).toEqual(['npx cdk bootstrap', 'npx cdk deploy A B']);
  });

  it('files a go-live line written with --context= under the go-live step, never the deploy step', () => {
    const lines = (commands: readonly string[]) => commands.map((command) => ({ command, note: null }));
    const steps = deploySteps({
      deployCommands: lines(['npm run build', 'npx cdk bootstrap', 'npx cdk deploy --all', 'npx cdk deploy --all --context=fothering:live=live']),
      region: 'xx-planted-9',
    });
    expect(steps[3]?.commands.map(({ command }) => command)).toEqual(['npx cdk bootstrap', 'npx cdk deploy --all']);
    expect(steps[4]?.commands.map(({ command }) => command)).toEqual(['npx cdk deploy --all --context=fothering:live=live']);
  });

  it('shows only commands the README or package.json offers', () => {
    for (const step of steps) {
      for (const { command } of step.commands) expect(isOfferedCommand(command, facts.deployCommands, facts.scripts), command).toBe(true);
    }
  });

  it('throws when the README holds no deploy line for a step that needs one', () => {
    const withoutBootstrap = facts.deployCommands.filter((command) => command !== facts.deployCommands[1]);
    expect(() => deploySteps({ deployCommands: withoutBootstrap, region: 'xx-planted-9' })).toThrow(/^README\.md: Deploy and remove: no bootstrap command/);
  });
});

describe('the deploy Region', () => {
  const CREATE_APP = 'packages/infra/src/create-app.ts';

  it('reads the one Region the stacks pin', () => {
    const region = readDeployRegion(ROOT);
    expect(region).toMatch(/^[a-z]{2}-[a-z]+-\d$/);
    expect(readRepoText(CREATE_APP, ROOT)).toContain(`region: '${region}'`);
  });

  it('reads a planted pin, and throws on none and on two', () => {
    plantFile(`region-one/${CREATE_APP}`, "const ENV = { region: 'xx-planted-9' };\n");
    plantFile(`region-none/${CREATE_APP}`, 'const ENV = {};\n');
    plantFile(`region-two/${CREATE_APP}`, "const A = { region: 'xx-one-1' };\nconst B = { region: 'xx-two-2' };\n");
    expect(readDeployRegion(join(PLANT, 'region-one'))).toBe('xx-planted-9');
    expect(() => readDeployRegion(join(PLANT, 'region-none'))).toThrow(`${CREATE_APP}: found 0 Regions, expected exactly one. Pin the stacks' Region in one env.`);
    expect(() => readDeployRegion(join(PLANT, 'region-two'))).toThrow(/found 2 Regions/);
  });
});

describe('loadRepoFacts', () => {
  it('reads the commands, the script names and the model id from the real repository', () => {
    const facts = loadRepoFacts(ROOT);
    expect(facts.deployCommands).toEqual(README_COMMANDS);
    expect(facts.scripts).toContain('build');
    expect(facts.scripts).not.toContain('deploy');
    expect(facts.modelId).toBe(MODEL_VALUES.inferenceProfileId);
  });

  it('takes the model id from model-values.ts when the file exists', () => {
    plantFile('facts/package.json', JSON.stringify({ name: 'fothering', scripts: { build: 'node build.mjs' } }));
    plantFile('facts/README.md', '## Deploy and remove\n\n```sh\nnpm run build\n```\n');
    plantFile('facts/docs/adr/0001-stack.md', `${ADR_ROW}\n`);
    plantFile('facts/packages/core/src/model-values.ts', "export const MODEL_VALUES = { inferenceProfileId: 'eu.planted-profile' } as const;\n");
    expect(loadRepoFacts(join(PLANT, 'facts'))).toEqual({
      deployCommands: [{ command: 'npm run build', note: null }],
      scripts: ['build'],
      modelId: 'eu.planted-profile',
    });
  });
});
