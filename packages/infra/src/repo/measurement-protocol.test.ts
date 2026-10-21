import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseScenarioSource, RECIPIENT_KINDS, SCENARIO_TAG_KINDS, type Scenario, type ScenarioSource } from '@fothering/core/scenarios';

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
const BANNED_DASH_RE = /[‒-―]/;

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
    expect(protocolFindings(good.replace('Text.', 'Café.'))).toContain('line 3 holds a non-ASCII character');
    expect(protocolFindings(good.replace('Text.', 'One — two.'))).toContain('line 3 holds a dash between U+2012 and U+2015');
    expect(protocolFindings(good.replace('Text.', 'One ‒ two.'))).toContain('line 3 holds a dash between U+2012 and U+2015');
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
