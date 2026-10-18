import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

// This file lives at packages/infra/src/repo/, four levels below the repo root.
const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const GATE = join(REPO_ROOT, 'scripts', 'check-ai-act.mjs');
const DOCUMENT = join(REPO_ROOT, 'docs', 'ai-act.md');
const PARAGRAPHS = ['1', '2', '3', '4'] as const;
const DETERMINED = '[ai-act] determined:';
// The gate resolves a section's backticked paths against its working directory, so removed-section
// copies are checked from the repo root. They sit under the git-ignored node_modules/.cache rather
// than the system temp folder, whose size slows every file walk below it.
const PLANT_PARENT = join(REPO_ROOT, 'node_modules', '.cache');
const plantRoots: string[] = [];

afterAll(() => {
  for (const root of plantRoots) rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
});

function runGate(...args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [GATE, ...args], { cwd: REPO_ROOT, encoding: 'utf8', windowsHide: true });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function headingPattern(paragraph: string): RegExp {
  return new RegExp(`^##[^\\n]*Article\\s*50\\s*\\(${paragraph}\\)[^\\n]*$`, 'gim');
}

interface Section {
  heading: string;
  start: number;
  end: number;
}

function sectionOf(body: string, paragraph: string): Section {
  const match = headingPattern(paragraph).exec(body);
  if (!match) throw new Error(`docs/ai-act.md has no section for Article 50(${paragraph})`);
  const afterHeading = match.index + match[0].length;
  const next = body.slice(afterHeading).search(/^##\s/m);
  return { heading: match[0], start: match.index, end: next === -1 ? body.length : afterHeading + next };
}

describe('the Article 50 determinations in docs/ai-act.md', () => {
  it('pass the AI Act gate run from the repo root', () => {
    const run = runGate();
    expect(run.stdout.trim().slice(0, DETERMINED.length)).toBe(DETERMINED);
    expect(run.status).toBe(0);
  });

  it.each(PARAGRAPHS)('fail the gate when the Article 50(%s) section is removed', (paragraph) => {
    const body = readFileSync(DOCUMENT, 'utf8');
    const { start, end } = sectionOf(body, paragraph);
    mkdirSync(PLANT_PARENT, { recursive: true });
    const root = mkdtempSync(join(PLANT_PARENT, 'fothering-ai-act-'));
    plantRoots.push(root);
    const copy = join(root, 'ai-act.md');
    writeFileSync(copy, body.slice(0, start) + body.slice(end));

    const run = runGate(copy);
    expect(run.stderr).toContain(`no section heading for Article 50(${paragraph})`);
    expect(run.status).toBe(1);
  });

  it.each(PARAGRAPHS)('give Article 50(%s) exactly one ASCII heading in the form the gate reads', (paragraph) => {
    const body = readFileSync(DOCUMENT, 'utf8');
    const headings = body.match(headingPattern(paragraph)) ?? [];
    expect(headings).toHaveLength(1);
    expect(headings[0]).toMatch(/^## Article 50\(\d\) [\x20-\x7e]+$/);
  });

  it.each(PARAGRAPHS)('keep the word applies out of the Article 50(%s) heading unless its verdict applies', (paragraph) => {
    const body = readFileSync(DOCUMENT, 'utf8');
    const { heading, start, end } = sectionOf(body, paragraph);
    const verdictApplies = /^\*{0,2}Verdict\*{0,2}:?\s*APPLIES/im.test(body.slice(start, end));
    if (!verdictApplies) expect(heading).not.toMatch(/\bapplies\b/i);
  });
});
