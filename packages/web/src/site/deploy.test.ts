import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
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
import { isOfferedCommand, loadRepoFacts, readDeployCommands, readRepoText, repoRoot, resolveModelId } from './repo-facts.js';
import { NOT_LISTED, RESOURCE_NOUNS, resourceRows } from './resources-view.js';

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
    expect(schedules.map((schedule) => schedule.role)).toEqual(['ForgetRole9C1F5950', 'IngestRoleAF8AE6D8', 'RuntimeRoleFD8790A4']);
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

  it('hold exactly one row for a planted snapshot with one Deny entry', () => {
    const deny = permission({ role: 'IngestRoleAF8AE6D8', effect: 'Deny', action: 'ses:PutConfigurationSetSendingOptions', resource: '"*"' });
    const reasons = { ...PERMISSION_REASONS, [permissionKey(deny)]: 'Planted.' };
    const rows = denyRows([...committedPermissions(), deny], reasons);
    expect(rows.map((row) => `${row.effect} ${row.action}`)).toEqual(['Deny ses:PutConfigurationSetSendingOptions']);
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
});

describe('the pause grant and runtime role predicates', () => {
  it('report no pause grant in the shipped snapshot', () => {
    expect(hasPauseGrant(committedPermissions())).toBe(false);
  });

  it('report a pause grant for a planted Allow of ses:PutConfigurationSetSendingOptions', () => {
    const planted = [...committedPermissions(), permission({ action: 'ses:PutConfigurationSetSendingOptions', resource: '"*"' })];
    expect(hasPauseGrant(planted)).toBe(true);
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

const SEVEN_COMMANDS = [
  { command: 'npm run build', note: null },
  { command: 'npx cdk bootstrap', note: 'once, before the first deploy' },
  { command: 'npx cdk deploy --all', note: null },
  { command: 'npx cdk destroy --all', note: null },
  { command: 'npx cdk deploy --all -c fothering:live=live', note: null },
  { command: 'aws events test-event-pattern --event-pattern file://rule-pattern.json --event file://sample-event.json', note: null },
  { command: 'aws sesv2 get-configuration-set --region eu-central-1 --configuration-set-name <a set from lanes.json>', note: null },
];

describe('the README deploy commands', () => {
  const readme = readRepoText('README.md', ROOT);

  it('returns the seven command lines of Deploy and remove in order, with the bootstrap note', () => {
    expect(readDeployCommands(readme)).toEqual(SEVEN_COMMANDS);
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
    expect(readDeployCommands(readme.replace(/\r?\n/g, '\r\n'))).toEqual(SEVEN_COMMANDS);
  });
});

describe('isOfferedCommand', () => {
  const commands = readDeployCommands(readRepoText('README.md', ROOT));
  const scripts = Object.keys((JSON.parse(readRepoText('package.json', ROOT)) as { scripts: Record<string, string> }).scripts);

  it('accepts each README command line', () => {
    for (const { command } of SEVEN_COMMANDS) expect(isOfferedCommand(command, commands, scripts), command).toBe(true);
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
    expect(resolveModelId({ adrText })).toBe('eu.anthropic.claude-sonnet-5');
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

describe('loadRepoFacts', () => {
  it('reads the commands, the script names and the model id from the real repository', () => {
    const facts = loadRepoFacts(ROOT);
    expect(facts.deployCommands).toEqual(SEVEN_COMMANDS);
    expect(facts.scripts).toContain('build');
    expect(facts.scripts).not.toContain('deploy');
    expect(facts.modelId).toBe('eu.anthropic.claude-sonnet-5');
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
