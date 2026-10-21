import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { attemptErrorName, parseRunId } from '@fothering/core/live-run';
import {
  checkSavedFolder,
  expectedRunFolderFiles,
  RUN_FOLDER_ROOT,
  type CheckSavedScenario,
  type SavedFileContent,
} from '@fothering/core/run-folder';
import { readSavedItems } from '@fothering/providers/saved-items';
import type { LiveRunDeps } from './root.js';
import { refuse } from './send.js';

function summaryLine(checked: number, findings: number): string {
  const tail = findings === 0 ? 'no findings' : `${findings} finding${findings === 1 ? '' : 's'}`;
  return `check-saved: ${checked} files checked, ${tail}`;
}

function scenarioOf(deps: LiveRunDeps, runId: string): CheckSavedScenario | undefined {
  const run = parseRunId(runId)?.run;
  const scenario = deps.scenarios.scenarios.find((candidate) => candidate.run === run);
  if (scenario === undefined) return undefined;
  return { lane: scenario.lane, outcome: scenario.expectedDecision.outcome, steps: scenario.steps.map((step) => step.name) };
}

function readContent(path: string, asItems: boolean): SavedFileContent {
  if (!existsSync(path)) return { kind: 'missing' };
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return { kind: 'unreadable' };
  }
  if (!asItems || text.trim() === '') return { kind: 'text', text };
  try {
    return { kind: 'items', items: readSavedItems(text) };
  } catch (error) {
    return { kind: 'items-refused', errorName: attemptErrorName(error) };
  }
}

/** Reads only: it never creates the run folder or any file in it, so a missing folder stays missing. */
export function runCheckSaved(deps: LiveRunDeps, runId: string, afterRemoval: boolean): number {
  const scenario = scenarioOf(deps, runId);
  if (scenario === undefined) return refuse(deps, { code: 'run-id-invalid' });
  const relativeFolder = `${RUN_FOLDER_ROOT}/${runId}`;
  const folder = join(deps.repoRoot, ...relativeFolder.split('/'));
  if (!existsSync(folder)) {
    deps.io.err(`check-saved: ${relativeFolder}: the run folder is missing`);
    deps.io.err(summaryLine(0, 1));
    return 1;
  }

  const sets = deps.laneMap.lanes.map((lane) => lane.configurationSet);
  const expected = expectedRunFolderFiles({ scenario, sets, afterRemoval });
  const files = new Map(expected.map(({ path, file }) => [path, readContent(join(folder, ...path.split('/')), file.format === 'items')]));
  const result = checkSavedFolder({ runId, scenario, sets, afterRemoval, files });
  if (result.ok) {
    deps.io.out(summaryLine(result.checked, 0));
    return 0;
  }
  for (const finding of result.findings) deps.io.err(`check-saved: ${finding}`);
  deps.io.err(summaryLine(result.checked, result.findings.length));
  return 1;
}
