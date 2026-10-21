import { AGENT_UNAVAILABLE_REASONS, INVALID_CHECKS, type RuntimeResult } from './agent-answer.js';
import { CLOSURE_LOG_OUTCOMES, CLOSURE_LOG_REASONS } from './closure.js';
import { DECISION_REASONS } from './evidence-record.js';
import { INCIDENT_TRANSITIONS } from './incident.js';
import { CONFIGURATION_SET_PATTERN } from './lanes.js';
import { SES_ID_PATTERN, UNCLASSIFIED } from './records.js';

// A closed key set is the whole point (T-01-02): every line holds only what is listed below, plus
// the level of the method that wrote it, whatever an entry carries beyond that. Building the output object field by field, rather than
// spreading the entry, is what makes an unlisted key impossible to leak, not merely undocumented.
// This logger is not the only channel into a function's log group: a rethrown error also reaches it
// through the Node Lambda runtime's own error line, which carries the error's message and stack. So
// an error message must never interpolate an address.

export type LogSink = (line: string) => void;

// The detection fields are typed as plain strings and numbers on purpose: the vocabulary is enforced
// where the line is built, so a value that drifted out of it is logged as unclassified, not trusted.
export interface LogEntry {
  event: string;
  messageId?: string;
  errorName?: string;
  field?: string;
  count?: number;
  configurationSet?: string;
  incidentId?: string;
  attempt?: number;
  reason?: string;
  check?: string;
  status?: string;
  /** A closure or reopen outcome; `closed` reaches a line only here, as the outcome itself (D-112). */
  outcome?: string;
  modelCalls?: number;
  inputTokens?: number;
  outputTokens?: number;
}

export interface Logger {
  info(entry: LogEntry): void;
  error(entry: LogEntry): void;
}

const EVENT_PATTERN = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
// The parser's own id pattern, never a copy: an id the parser stores is one the log line can name.
const MESSAGE_ID_PATTERN = SES_ID_PATTERN;
const ERROR_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9]{0,63}$/;
const FIELD_PATTERN = /^[A-Za-z][A-Za-z0-9-]*(\.[A-Za-z][A-Za-z0-9-]*)*$/;
const FIELD_MAX_LENGTH = 128;
const INCIDENT_ID_PATTERN = /^[0-9a-f]{32}$/;

const RUNTIME_STATUSES = ['answered', 'failed', 'refused', 'dry-run'] as const satisfies readonly RuntimeResult['status'][];
// Fails the type gate when the runtime result gains a status this list does not name.
const runtimeStatusesComplete: Exclude<RuntimeResult['status'], (typeof RUNTIME_STATUSES)[number]> extends never ? true : never = true;
void runtimeStatusesComplete;

const REASONS: ReadonlySet<string> = new Set([...DECISION_REASONS, ...AGENT_UNAVAILABLE_REASONS, ...INCIDENT_TRANSITIONS, ...CLOSURE_LOG_REASONS]);
const CHECKS: ReadonlySet<string> = new Set(INVALID_CHECKS);
const STATUSES: ReadonlySet<string> = new Set(RUNTIME_STATUSES);
const OUTCOMES: ReadonlySet<string> = new Set(CLOSURE_LOG_OUTCOMES);

// The level is the method the caller chose, written as a fixed word, never read from the entry:
// without it an info line and an error line are identical, so no reader can tell a failed message
// from a routine drop without knowing every event name.
type LogLevel = 'info' | 'error';

function closedString(value: string | undefined, accepts: (value: string) => boolean): string | undefined {
  if (value === undefined) return undefined;
  return accepts(value) ? value : UNCLASSIFIED;
}

function wholeCount(value: number | undefined): number | undefined {
  return value !== undefined && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function setIfPresent(line: Record<string, unknown>, key: string, value: string | number | undefined): void {
  if (value !== undefined) line[key] = value;
}

function sanitizedLine(entry: LogEntry, level: LogLevel): Record<string, unknown> {
  const line: Record<string, unknown> = {
    event: EVENT_PATTERN.test(entry.event) ? entry.event : UNCLASSIFIED,
    level,
  };
  setIfPresent(line, 'messageId', closedString(entry.messageId, (value) => MESSAGE_ID_PATTERN.test(value)));
  setIfPresent(line, 'errorName', closedString(entry.errorName, (value) => ERROR_NAME_PATTERN.test(value)));
  setIfPresent(line, 'field', closedString(entry.field, (value) => value.length <= FIELD_MAX_LENGTH && FIELD_PATTERN.test(value)));
  setIfPresent(line, 'count', wholeCount(entry.count));
  setIfPresent(line, 'configurationSet', closedString(entry.configurationSet, (value) => CONFIGURATION_SET_PATTERN.test(value)));
  setIfPresent(line, 'incidentId', closedString(entry.incidentId, (value) => INCIDENT_ID_PATTERN.test(value)));
  setIfPresent(line, 'attempt', wholeCount(entry.attempt));
  setIfPresent(line, 'reason', closedString(entry.reason, (value) => REASONS.has(value)));
  setIfPresent(line, 'check', closedString(entry.check, (value) => CHECKS.has(value)));
  setIfPresent(line, 'status', closedString(entry.status, (value) => STATUSES.has(value)));
  setIfPresent(line, 'outcome', closedString(entry.outcome, (value) => OUTCOMES.has(value)));
  setIfPresent(line, 'modelCalls', wholeCount(entry.modelCalls));
  setIfPresent(line, 'inputTokens', wholeCount(entry.inputTokens));
  setIfPresent(line, 'outputTokens', wholeCount(entry.outputTokens));
  return line;
}

export function createLogger(sink: LogSink): Logger {
  return {
    info(entry) {
      sink(JSON.stringify(sanitizedLine(entry, 'info')));
    },
    error(entry) {
      sink(JSON.stringify(sanitizedLine(entry, 'error')));
    },
  };
}
