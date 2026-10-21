import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { closureItemSchema } from '@fothering/core/closure';
import { MIN_SEND_GAP_MS } from '@fothering/core/live-run';
import { MODEL_VALUES, TOKEN_RESERVATION_PER_INVOCATION } from '@fothering/core/model-values';
import { incidentLimitSentence } from '@fothering/core/reopen';
import { parseScenarioSource, RECIPIENT_KINDS, SCENARIO_TAG_KINDS, type Scenario, type ScenarioSource } from '@fothering/core/scenarios';
import {
  COMPLAINT_THRESHOLD,
  COVERAGE_THRESHOLD,
  HARD_BOUNCE_THRESHOLD,
  LANE_MIN_RECIPIENT_SENDS,
  MIN_RATIO_EVENTS,
  ROW_MIN_RECIPIENT_SENDS,
  type Rational,
} from '@fothering/core/verdicts';

// This file lives at packages/infra/src/repo/, four levels below the repo root.
const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const PROTOCOL_PATH = 'docs/measurement-protocol.md';
const SOURCE_PATH = 'docs/measurement-scenarios.json';

const HEADINGS = [
  'Measured interval start',
  'Measured interval end',
  'Per-hop breakdown',
  'Damage count',
  'Thresholds and minimum sample',
  'Scenarios',
  'Contrast design',
  'Pacing and throttles',
  'Every run reported',
  'VDM state',
  'Simulator domains',
  'One caller identity per lane',
  'Incident limit',
  'Spend and what runs while deployed',
  'Switch on from the start',
  'No number on a page',
  'Removal order',
  'Saved files',
] as const;

function readCommitted(path: string): string | undefined {
  const full = join(REPO_ROOT, path);
  return existsSync(full) ? readFileSync(full, 'utf8') : undefined;
}

function committedSource(): ScenarioSource {
  return parseScenarioSource(JSON.parse(readFileSync(join(REPO_ROOT, SOURCE_PATH), 'utf8')));
}

interface Section {
  heading: string;
  body: string;
}

function protocolSections(text: string): Section[] {
  const sections: Section[] = [];
  for (const line of text.split('\n')) {
    if (line.startsWith('## ')) sections.push({ heading: line.slice(3), body: '' });
    else if (sections.length > 0) sections[sections.length - 1]!.body += `${line}\n`;
  }
  return sections;
}

function sectionBody(text: string, heading: string): string {
  return protocolSections(text).find((section) => section.heading === heading)?.body ?? '';
}

// Prose is wrapped at about 100 columns, so a phrase the tests look for may span a line break.
function sectionProse(text: string, heading: string): string {
  return sectionBody(text, heading).replace(/\s+/g, ' ');
}

// U+2012 to U+2015 are the figure, en, em and horizontal-bar dashes the house style bans; they are
// non-ASCII too, but each gets its own finding so a pasted dash is named rather than counted.
const BANNED_DASH_RE = /[\u2012-\u2015]/;

function isAscii(line: string): boolean {
  return [...line].every((character) => character.charCodeAt(0) < 128);
}

function characterFindings(text: string): string[] {
  const findings: string[] = [];
  if (text.includes('\r')) findings.push('the file is not LF');
  text.split('\n').forEach((line, index) => {
    if (BANNED_DASH_RE.test(line)) findings.push(`line ${index + 1} holds a dash between U+2012 and U+2015`);
    else if (!isAscii(line)) findings.push(`line ${index + 1} holds a non-ASCII character`);
  });
  return findings;
}

function headingFindings(text: string): string[] {
  const sections = protocolSections(text);
  const found = sections.map((section) => section.heading);
  const findings: string[] = [];
  for (const heading of HEADINGS) {
    const section = sections.find((candidate) => candidate.heading === heading);
    if (section === undefined) findings.push(`heading "${heading}" is missing`);
    else if (section.body.trim() === '') findings.push(`heading "${heading}" has no text under it`);
  }
  for (const heading of found) {
    if (!(HEADINGS as readonly string[]).includes(heading)) findings.push(`heading "${heading}" is not one of the protocol's sections`);
  }
  const ordered = found.filter((heading) => (HEADINGS as readonly string[]).includes(heading));
  const expectedOrder = HEADINGS.filter((heading) => ordered.includes(heading));
  if (ordered.join('\n') !== expectedOrder.join('\n')) findings.push('the headings are out of order');
  return findings;
}

function protocolFindings(text: string | undefined): string[] {
  if (text === undefined) return ['the file is missing'];
  if (text.trim() === '') return ['the file is empty'];
  return [...characterFindings(text), ...headingFindings(text)];
}

type DocScenario = Omit<Scenario, 'expectedDecision'> & { expectedDecision: unknown };

interface ParsedTables {
  scenarios: DocScenario[];
  problems: string[];
}

function tableRows(lines: readonly string[]): string[][] {
  return lines
    .filter((line) => line.startsWith('|') && !/^\|\s*-/.test(line))
    .map((line) =>
      line
        .slice(1, -1)
        .split('|')
        .map((cell) => cell.trim().replace(/^`|`$/g, '')),
    );
}

const CLOSE_DECISION_RE = /^close, cause tag (\S+) (\S+)$/;
const UNKNOWN_DECISION_RE = /^unknown, reason (\S+)$/;

function decisionOf(text: string): unknown {
  const close = CLOSE_DECISION_RE.exec(text);
  if (close !== null) return { outcome: 'close', dimension: 'tag', tagKind: close[1], value: close[2] };
  const unknown = UNKNOWN_DECISION_RE.exec(text);
  if (unknown !== null) return { outcome: 'unknown', reason: unknown[1] };
  return `unparsed: ${text}`;
}

const ORDER_RE = /^Order: cycle (.+?)(?:; interleave (\S+) after every (\d+))?$/;

function orderOf(line: string | undefined): Pick<Scenario['steps'][number], 'cycle' | 'interleave'> | undefined {
  const match = line === undefined ? null : ORDER_RE.exec(line);
  if (match === null) return undefined;
  const cycle = match[1]!.split(', ').map((slot) => {
    const [group = '', take = ''] = slot.split(' ');
    return { group, take: Number(take) };
  });
  return match[2] === undefined ? { cycle } : { cycle, interleave: { group: match[2], afterEvery: Number(match[3]) } };
}

const GROUP_HEADER = ['Group', 'Lane', 'Tag kind', 'Tag value', 'Recipient', 'Count'];

function stepOf(name: string, lines: readonly string[], problems: string[]): Scenario['steps'][number] {
  const [header, ...rows] = tableRows(lines);
  if (header?.join('|') !== GROUP_HEADER.join('|')) problems.push(`step ${name}: the group table's columns are not ${GROUP_HEADER.join(', ')}`);
  const groups = rows.map(([group = '', lane = '', kind = '', value = '', recipient = '', count = '']) => ({
    name: group,
    lane,
    tag: { kind: kind as (typeof SCENARIO_TAG_KINDS)[number], value },
    recipient: recipient as (typeof RECIPIENT_KINDS)[number],
    count: Number(count),
  }));
  const order = orderOf(lines.find((line) => line.startsWith('Order:')));
  if (order === undefined) problems.push(`step ${name}: no Order line in the form the protocol uses`);
  return { name, groups, ...(order ?? { cycle: [] }) };
}

function fieldsOf(lines: readonly string[]): Map<string, string> {
  const rows = tableRows(lines);
  return new Map(rows.slice(1).map(([field = '', value = '']) => [field, value]));
}

function scenarioOf(heading: string, lines: readonly string[], problems: string[]): DocScenario {
  const firstStep = lines.findIndex((line) => line.startsWith('#### Step '));
  const fields = fieldsOf(firstStep === -1 ? lines : lines.slice(0, firstStep));
  const steps: Scenario['steps'] = [];
  lines.forEach((line, index) => {
    if (!line.startsWith('#### Step ')) return;
    const next = lines.findIndex((candidate, at) => at > index && candidate.startsWith('#### Step '));
    steps.push(stepOf(line.slice('#### Step '.length), lines.slice(index + 1, next === -1 ? undefined : next), problems));
  });
  if (steps.length === 0) problems.push(`${heading}: no step`);
  return {
    run: Number(fields.get('Run')),
    name: fields.get('Name') ?? '',
    lane: fields.get('Lane') ?? '',
    precondition: fields.get('Precondition') ?? '',
    expectedDecision: decisionOf(fields.get('Expected decision') ?? ''),
    steps,
  };
}

const SCENARIO_HEADING_RE = /^### Scenario (\d+): (\S+)$/;

function scenarioTables(section: string): ParsedTables {
  const lines = section.split('\n');
  const problems: string[] = [];
  const scenarios: DocScenario[] = [];
  lines.forEach((line, index) => {
    const heading = SCENARIO_HEADING_RE.exec(line);
    if (heading === null) return;
    const next = lines.findIndex((candidate, at) => at > index && candidate.startsWith('### '));
    const scenario = scenarioOf(line, lines.slice(index + 1, next === -1 ? undefined : next), problems);
    if (String(scenario.run) !== heading[1] || scenario.name !== heading[2]) problems.push(`${line}: the heading disagrees with its table`);
    scenarios.push(scenario);
  });
  return { scenarios, problems };
}

function differences(path: string, doc: unknown, source: unknown, out: string[]): void {
  if (typeof doc === 'object' && doc !== null && typeof source === 'object' && source !== null) {
    if (Array.isArray(doc) !== Array.isArray(source)) {
      out.push(`${path}: the protocol and the source disagree on its shape`);
      return;
    }
    const keys = new Set([...Object.keys(doc), ...Object.keys(source)]);
    for (const key of keys) differences(`${path}.${key}`, (doc as Record<string, unknown>)[key], (source as Record<string, unknown>)[key], out);
    return;
  }
  if (doc !== source) out.push(`${path}: protocol ${JSON.stringify(doc)}, source ${JSON.stringify(source)}`);
}

function scenarioDrift(tables: ParsedTables, source: ScenarioSource): string[] {
  const out = [...tables.problems];
  differences('scenarios', tables.scenarios, source.scenarios, out);
  return out;
}

describe('the measurement protocol has every section, in order, in plain ASCII', () => {
  it('holds the eighteen headings in order, each with text under it', () => {
    expect(protocolFindings(readCommitted(PROTOCOL_PATH)).join('; ')).toBe('');
  });

  it('reports a missing file, an empty file, a missing heading and a heading with no text', () => {
    const good = HEADINGS.map((heading) => `## ${heading}\n\nText.\n`).join('\n');
    expect(protocolFindings(good)).toEqual([]);
    expect(protocolFindings(undefined)).toEqual(['the file is missing']);
    expect(protocolFindings('')).toEqual(['the file is empty']);
    expect(protocolFindings(good.replace('## Incident limit\n', ''))).toContain('heading "Incident limit" is missing');
    expect(protocolFindings(good.replace('## VDM state\n\nText.\n', '## VDM state\n\n'))).toContain('heading "VDM state" has no text under it');
    const swapped = good.replace('## Damage count', '## PLACEHOLDER').replace('## Per-hop breakdown', '## Damage count').replace('## PLACEHOLDER', '## Per-hop breakdown');
    expect(protocolFindings(swapped)).toContain('the headings are out of order');
  });

  it('reports a CRLF copy, a non-ASCII character and a banned dash', () => {
    const good = HEADINGS.map((heading) => `## ${heading}\n\nText.\n`).join('\n');
    expect(protocolFindings(good.replaceAll('\n', '\r\n'))).toContain('the file is not LF');
    expect(protocolFindings(good.replace('Text.', 'Caf\u00e9.'))).toContain('line 3 holds a non-ASCII character');
    expect(protocolFindings(good.replace('Text.', 'One \u2014 two.'))).toContain('line 3 holds a dash between U+2012 and U+2015');
    expect(protocolFindings(good.replace('Text.', 'One \u2012 two.'))).toContain('line 3 holds a dash between U+2012 and U+2015');
  });
});

describe('the protocol scenario tables are the committed scenario source', () => {
  it('lists runs 1, 2 and 3 in order, every field equal to the source', () => {
    const tables = scenarioTables(sectionBody(readCommitted(PROTOCOL_PATH) ?? '', 'Scenarios'));
    expect(tables.scenarios.map((scenario) => scenario.run)).toEqual([1, 2, 3]);
    expect(scenarioDrift(tables, committedSource())).toEqual([]);
  });

  it('reports a changed count and a changed tag value by field', () => {
    const tables = scenarioTables(sectionBody(readCommitted(PROTOCOL_PATH) ?? '', 'Scenarios'));
    const planted = structuredClone(committedSource());
    planted.scenarios[0]!.steps[0]!.groups[1]!.count = 23;
    planted.scenarios[2]!.steps[0]!.groups[1]!.tag.value = 'winback-two';
    const drift = scenarioDrift(tables, planted);
    expect(drift).toContain('scenarios.0.steps.0.groups.1.count: protocol 24, source 23');
    expect(drift).toContain('scenarios.2.steps.0.groups.1.tag.value: protocol "winback", source "winback-two"');
    expect(drift).toHaveLength(2);
  });

  it('says scenario 3 shares the bulk lane with scenario 1 and that a pause scenario needs no open incident', () => {
    const scenarios = sectionProse(readCommitted(PROTOCOL_PATH) ?? '', 'Scenarios');
    expect(scenarios).toContain('Scenario 3 shares `fothering-bulk` with scenario 1');
    expect(scenarios).toContain('A scenario that needs a pause runs only when its lane has no open incident');
  });

  it('names recipients by local part only, never as a whole address', () => {
    expect(readCommitted(PROTOCOL_PATH) ?? '@').not.toContain('@');
  });
});

function protocolText(): string {
  return readCommitted(PROTOCOL_PATH) ?? '';
}

const THRESHOLDS: ReadonlyArray<[string, Rational | number]> = [
  ['HARD_BOUNCE_THRESHOLD', HARD_BOUNCE_THRESHOLD],
  ['COMPLAINT_THRESHOLD', COMPLAINT_THRESHOLD],
  ['MIN_RATIO_EVENTS', MIN_RATIO_EVENTS],
  ['LANE_MIN_RECIPIENT_SENDS', LANE_MIN_RECIPIENT_SENDS],
  ['ROW_MIN_RECIPIENT_SENDS', ROW_MIN_RECIPIENT_SENDS],
  ['COVERAGE_THRESHOLD', COVERAGE_THRESHOLD],
];

function statedValue(value: Rational | number): string {
  return typeof value === 'number' ? String(value) : `${value.numerator}/${value.denominator}`;
}

function thresholdFindings(text: string): string[] {
  const rows = new Map(
    tableRows(sectionBody(text, 'Thresholds and minimum sample').split('\n'))
      .slice(1)
      .map(([name = '', value = '']) => [name, value]),
  );
  const findings: string[] = [];
  for (const [name, value] of THRESHOLDS) {
    const stated = rows.get(name);
    if (stated === undefined) findings.push(`${name} is not in the thresholds table`);
    else if (stated !== statedValue(value)) findings.push(`${name}: protocol "${stated}", verdicts.ts "${statedValue(value)}"`);
  }
  return findings;
}

describe('every threshold the protocol states is the constant verdicts.ts enforces', () => {
  it('states each of the six constants with its value as an integer or an integer fraction', () => {
    expect(thresholdFindings(protocolText()).join('; ')).toBe('');
  });

  it('reports a percentage or a changed fraction in place of a constant', () => {
    expect(thresholdFindings(protocolText().replace('| HARD_BOUNCE_THRESHOLD | 5/100 |', '| HARD_BOUNCE_THRESHOLD | 5% |'))).toEqual([
      'HARD_BOUNCE_THRESHOLD: protocol "5%", verdicts.ts "5/100"',
    ]);
    expect(thresholdFindings(protocolText().replace('| HARD_BOUNCE_THRESHOLD | 5/100 |', '| HARD_BOUNCE_THRESHOLD | 4/100 |'))).toEqual([
      'HARD_BOUNCE_THRESHOLD: protocol "4/100", verdicts.ts "5/100"',
    ]);
    expect(thresholdFindings(protocolText().replace('| MIN_RATIO_EVENTS | 3 |\n', ''))).toEqual(['MIN_RATIO_EVENTS is not in the thresholds table']);
  });
});

describe('pacing, the incident limit and the per-hop fields are the values the code uses', () => {
  it('states the send gap equal to MIN_SEND_GAP_MS and to the scenario source, with no retry', () => {
    const pacing = sectionProse(protocolText(), 'Pacing and throttles');
    expect(committedSource().minGapMs).toBe(MIN_SEND_GAP_MS);
    expect(pacing).toContain(`${MIN_SEND_GAP_MS} milliseconds`);
    expect(pacing).toContain('never retries');
    expect(pacing).toContain('by its error name');
  });

  it('quotes the incident limit sentence for the bulk lane verbatim and logs scenario 3 as not run', () => {
    const limit = sectionProse(protocolText(), 'Incident limit');
    expect(limit).toContain(incidentLimitSentence('fothering-bulk'));
    expect(limit).toContain('logged as not run');
  });

  it('names only closure and email fields the closure schema holds', () => {
    const perHop = sectionProse(protocolText(), 'Per-hop breakdown');
    const closureFields = Object.keys(closureItemSchema.shape);
    const emailFields = Object.keys(closureItemSchema.shape.email.unwrap().shape);
    for (const field of ['pauseRequestedAtMs', 'readBackAtMs', 'holdEndMs', 'holdCheckedAtMs']) {
      expect(perHop).toContain(`\`${field}\``);
      expect(closureFields).toContain(field);
    }
    expect(perHop).toContain('`email.sentAtMs`');
    expect(emailFields).toContain('sentAtMs');
  });
});

function stepTotals(source: ScenarioSource): string[] {
  return source.scenarios.flatMap((scenario) =>
    scenario.steps.map((step) => `Run ${scenario.run}, step ${step.name}: ${step.groups.reduce((sum, group) => sum + group.count, 0)} sends`),
  );
}

const CEILINGS: ReadonlyArray<[string, number]> = [
  ['MODEL_VALUES.perIncidentInvocations', MODEL_VALUES.perIncidentInvocations],
  ['MODEL_VALUES.perDayInvocations', MODEL_VALUES.perDayInvocations],
  ['MODEL_VALUES.perDayTokenReservations', MODEL_VALUES.perDayTokenReservations],
  ['MODEL_VALUES.modelCallCeiling', MODEL_VALUES.modelCallCeiling],
  ['TOKEN_RESERVATION_PER_INVOCATION', TOKEN_RESERVATION_PER_INVOCATION],
];

describe('the spend section states the sends, the model ceilings and what runs while deployed', () => {
  it('states every step total of the scenario source', () => {
    const spend = sectionProse(protocolText(), 'Spend and what runs while deployed');
    for (const total of stepTotals(committedSource())) expect(spend).toContain(total);
  });

  it('names each model ceiling with the value core declares', () => {
    const spend = sectionProse(protocolText(), 'Spend and what runs while deployed');
    for (const [name, value] of CEILINGS) expect(spend).toContain(`\`${name}\` (${value})`);
    const calls = MODEL_VALUES.perDayInvocations * MODEL_VALUES.modelCallCeiling;
    expect(spend).toContain(`${calls * MODEL_VALUES.inputTokenCeiling} input tokens`);
    expect(spend).toContain(`${calls * MODEL_VALUES.maxTokens} output tokens`);
  });

  it('names the budget alarm, the price source marked UNVERIFIED, the five-minute schedules and their end at removal', () => {
    const spend = sectionProse(protocolText(), 'Spend and what runs while deployed');
    for (const phrase of ['USD 10 monthly budget alarm', 'read on 2026-10-17', 'UNVERIFIED', 'every five minutes', 'Removal ends both', '2026-10-31']) {
      expect(spend).toContain(phrase);
    }
  });
});

describe('the caller section states one role per lane and why', () => {
  it('names both roles, their path, the closeability reason, the trust relationship and the From identity rule', () => {
    const callers = sectionProse(protocolText(), 'One caller identity per lane');
    for (const phrase of [
      '`fothering-live-run-transactional`',
      '`fothering-live-run-bulk`',
      '`/fothering-live-run/`',
      'refuses to close a lane whose caller also sends through another configuration set',
      "operator's own administrator identity",
      'maximum session of one hour',
      'If the From address is itself a verified identity',
      'three resources',
    ]) {
      expect(callers).toContain(phrase);
    }
  });
});

// Each step of the removal is one numbered item; the order is the order of the items that first
// name each marker, so a reworded item still has to keep its place.
const REMOVAL_MARKERS = ['read back as sending', 'check-saved', 'FotheringAction', 'FotheringDetection', '/fothering-live-run/', 'after-removal'] as const;

function removalFindings(text: string): string[] {
  const items = sectionBody(text, 'Removal order')
    .split('\n')
    .filter((line) => /^\d+\. /.test(line));
  const positions = REMOVAL_MARKERS.map((marker) => items.findIndex((item) => item.includes(marker)));
  const findings = REMOVAL_MARKERS.filter((_, index) => positions[index] === -1).map((marker) => `no removal step names ${marker}`);
  for (let index = 1; index < positions.length; index += 1) {
    if (positions[index]! < positions[index - 1]!) findings.push(`${REMOVAL_MARKERS[index]} comes before ${REMOVAL_MARKERS[index - 1]}`);
  }
  return findings;
}

describe('the removal order puts every reopen and save before the first destroy', () => {
  it('lists the reopen read-backs, check-saved, FotheringAction, the other stacks, the roles and the reads in that order', () => {
    expect(removalFindings(protocolText())).toEqual([]);
    const removal = sectionProse(protocolText(), 'Removal order');
    for (const stack of ['FotheringRuntime', 'FotheringIngest']) expect(removal).toContain(stack);
    expect(removal).toContain('2026-10-31');
  });

  it('reports a destroy moved ahead of the saved-files check', () => {
    const items = sectionBody(protocolText(), 'Removal order')
      .split('\n')
      .filter((line) => /^\d+\. /.test(line));
    const save = items.find((item) => item.includes('check-saved'))!;
    const destroy = items.find((item) => item.includes('FotheringAction'))!;
    const swapped = protocolText().replace(save, 'SWAP').replace(destroy, save).replace('SWAP', destroy);
    expect(removalFindings(swapped)).toContain('FotheringAction comes before check-saved');
  });
});

const SAVED_PATHS = [
  'run/<step>.account.json',
  'run/<step>.callers.json',
  'run/<step>.attempts.jsonl',
  'aws/saved.jsonl',
  'aws/stacks.json',
  'aws/templates/<StackName>.json',
  'aws/reopen-function.json',
  'aws/items-pointers.json',
  'aws/items-incident.json',
  'aws/items-lane-<set>.json',
  'aws/reopen-result.json',
  'aws/sets-before-removal/<set>.json',
  'aws/after-removal/stack-<StackName>.json',
  'aws/after-removal/resources-<StackName>.json',
  'aws/after-removal/log-groups.json',
  'aws/after-removal/roles.json',
] as const;

describe('the saved files section lists every file of a run folder', () => {
  it('names each run and aws path under reports/live-runs/<runId>/', () => {
    const saved = sectionProse(protocolText(), 'Saved files');
    expect(saved).toContain('`reports/live-runs/<runId>/`');
    for (const path of SAVED_PATHS) expect(saved).toContain(`\`${path}\``);
  });
});

const POLICY_PATHS = { 'fothering-transactional': 'docs/live-run-policy-transactional.json', 'fothering-bulk': 'docs/live-run-policy-bulk.json' } as const;
const ARN_PREFIX = 'arn:aws:ses:eu-central-1:<ACCOUNT_ID>';

function statementFindings(statement: Record<string, unknown>, lane: string): string[] {
  const findings: string[] = [];
  const keys = Object.keys(statement).sort().join(',');
  if (keys !== 'Action,Effect,Resource') findings.push(`the statement holds the keys ${keys}, not Action, Effect and Resource`);
  if (statement['Effect'] !== 'Allow') findings.push(`the effect is ${String(statement['Effect'])}, not Allow`);
  if (statement['Action'] !== 'ses:SendEmail') findings.push(`the action is ${JSON.stringify(statement['Action'])}, not exactly ses:SendEmail`);
  const resources = Array.isArray(statement['Resource']) ? (statement['Resource'] as unknown[]) : [statement['Resource']];
  if (resources.some((resource) => typeof resource !== 'string' || resource.includes('*'))) findings.push('a resource holds a wildcard or is not text');
  const expected = [`${ARN_PREFIX}:configuration-set/${lane}`, `${ARN_PREFIX}:identity/<FROM_DOMAIN>`];
  if (resources.length !== expected.length) findings.push(`the statement holds ${resources.length} resources, not ${expected.length}`);
  for (const arn of expected) if (!resources.includes(arn)) findings.push(`the resource ${arn} is missing`);
  return findings;
}

function lanePolicyFindings(policy: unknown, lane: string): string[] {
  if (typeof policy !== 'object' || policy === null) return ['the policy is not a JSON object'];
  const { Version: version, Statement: statements, ...rest } = policy as Record<string, unknown>;
  const findings: string[] = [];
  if (version !== '2012-10-17') findings.push(`the version is ${String(version)}, not 2012-10-17`);
  if (Object.keys(rest).length > 0) findings.push(`the policy holds the extra keys ${Object.keys(rest).join(', ')}`);
  if (!Array.isArray(statements) || statements.length !== 1) return [...findings, 'the policy does not hold exactly one statement'];
  return [...findings, ...statementFindings(statements[0] as Record<string, unknown>, lane)];
}

function committedPolicy(lane: keyof typeof POLICY_PATHS): unknown {
  return JSON.parse(readCommitted(POLICY_PATHS[lane]) ?? 'null');
}

describe('each lane role policy grants one send action on exactly two resources', () => {
  it.each(Object.keys(POLICY_PATHS) as Array<keyof typeof POLICY_PATHS>)('%s: one Allow statement, ses:SendEmail, its set and the From domain', (lane) => {
    expect(lanePolicyFindings(committedPolicy(lane), lane)).toEqual([]);
    const text = readCommitted(POLICY_PATHS[lane]) ?? '';
    expect(characterFindings(text)).toEqual([]);
    expect(text).not.toMatch(/\d{12}/);
  });

  it('reports a second action, ses:*, a third resource, a wildcard resource and a Deny', () => {
    const lane = 'fothering-bulk';
    const plant = (change: (statement: Record<string, unknown>) => void): string[] => {
      const policy = structuredClone(committedPolicy(lane)) as { Statement: Array<Record<string, unknown>> };
      change(policy.Statement[0]!);
      return lanePolicyFindings(policy, lane);
    };
    expect(plant((statement) => (statement['Action'] = ['ses:SendEmail', 'ses:SendRawEmail']))).toEqual([
      'the action is ["ses:SendEmail","ses:SendRawEmail"], not exactly ses:SendEmail',
    ]);
    expect(plant((statement) => (statement['Action'] = 'ses:*'))).toEqual(['the action is "ses:*", not exactly ses:SendEmail']);
    expect(plant((statement) => (statement['Resource'] as string[]).push(`${ARN_PREFIX}:identity/sender.<FROM_DOMAIN>`))).toEqual([
      'the statement holds 3 resources, not 2',
    ]);
    expect(plant((statement) => ((statement['Resource'] as string[])[0] = `${ARN_PREFIX}:configuration-set/*`))).toEqual([
      'a resource holds a wildcard or is not text',
      `the resource ${ARN_PREFIX}:configuration-set/fothering-bulk is missing`,
    ]);
    expect(plant((statement) => (statement['Effect'] = 'Deny'))).toEqual(['the effect is Deny, not Allow']);
  });
});

const DEPLOY_DOC_PATH = 'docs/deploy-the-site.md';
// Built from its words so this file never holds the deploy phrase as one literal: the machine's
// command guards match that text wherever it appears.
const TOOL = ['wrang', 'ler'].join('');
const DEPLOY_LINE_RE = new RegExp(`\\b${TOOL}(@\\S+)?\\s+${'deploy'}\\b`);
const TOOL_VERSION_RE = new RegExp(`\\b${TOOL}@(\\S+)`, 'g');
const PINNED_TOOL_RE = new RegExp(`\\b${TOOL}@\\S+`);
const EXACT_VERSION_RE = /^\d+\.\d+\.\d+$/;

function deployDocFindings(text: string): string[] {
  const findings: string[] = [];
  const lines = text.split('\n').filter((line) => DEPLOY_LINE_RE.test(line));
  if (lines.length !== 1) findings.push(`${lines.length} lines hold the deploy command, not exactly one`);
  for (const line of lines) {
    if (!line.startsWith('npx ')) findings.push(`the deploy line does not run through npx: ${line}`);
    if (!line.includes('--config wrangler.jsonc')) findings.push(`the deploy line does not name its config file: ${line}`);
  }
  const versions = [...text.matchAll(TOOL_VERSION_RE)].map((match) => match[1] ?? '');
  for (const version of new Set(versions)) {
    if (!EXACT_VERSION_RE.test(version)) findings.push(`${TOOL} version ${version} is not one exact version`);
  }
  if (new Set(versions).size > 1) findings.push(`the document names ${new Set(versions).size} ${TOOL} versions`);
  if (lines.some((line) => !PINNED_TOOL_RE.test(line))) findings.push('the deploy line pins no version');
  return findings;
}

describe('the site deploy document names the build and exactly one pinned deploy command', () => {
  const doc = (): string => readCommitted(DEPLOY_DOC_PATH) ?? '';

  it('holds one deploy line through npx at one exact version against the site config', () => {
    expect(deployDocFindings(doc()).join('; ')).toBe('');
    expect(characterFindings(doc())).toEqual([]);
  });

  it('names the build, the origin setting, its file, the config file and the build output', () => {
    for (const name of ['`npm run build`', '`SITE_ORIGIN`', '`packages/web/src/site/route-list.ts`', '`packages/web/wrangler.jsonc`', '`packages/web/dist`', `${TOOL}@`]) {
      expect(doc()).toContain(name);
    }
    expect(doc()).toMatch(new RegExp(`npx ${TOOL}@\\S+ login`));
  });

  it('reads the origin before the first deploy, replaces a personal-name subdomain and deploys from the origin commit', () => {
    const prose = doc().replace(/\s+/g, ' ');
    for (const phrase of [
      'Before the first deploy',
      'holds a personal name, replace it',
      'Build and deploy from the commit that sets `SITE_ORIGIN`',
      'No script, npm script or CI step in this repository runs the deploy command',
    ]) {
      expect(prose).toContain(phrase);
    }
  });

  it('reports two deploy lines, a version range and an unpinned deploy', () => {
    const text = doc();
    const line = text.split('\n').find((candidate) => DEPLOY_LINE_RE.test(candidate)) ?? '';
    expect(deployDocFindings(`${text}\n${line}\n`)).toContain('2 lines hold the deploy command, not exactly one');
    const version = /@(\S+)/.exec(line)?.[1] ?? '';
    expect(deployDocFindings(text.replaceAll(`@${version}`, `@^${version}`))).toContain(`${TOOL} version ^${version} is not one exact version`);
    expect(deployDocFindings(text.replace(line, line.replace(`@${version}`, '')))).toContain('the deploy line pins no version');
  });
});
