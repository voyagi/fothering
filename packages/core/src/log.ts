import { UNCLASSIFIED } from './records.js';

// A closed key set is the whole point (T-01-02): every line holds only what is listed below,
// whatever an entry carries beyond it. Building the output object field by field, rather than
// spreading the entry, is what makes an unlisted key impossible to leak, not merely undocumented.

export type LogSink = (line: string) => void;

export interface LogEntry {
  event: string;
  messageId?: string;
  errorName?: string;
  field?: string;
  count?: number;
}

export interface Logger {
  info(entry: LogEntry): void;
  error(entry: LogEntry): void;
}

const EVENT_PATTERN = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const MESSAGE_ID_PATTERN = /^[A-Za-z0-9-]{1,128}$/;
const ERROR_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9]{0,63}$/;
const FIELD_PATTERN = /^[A-Za-z][A-Za-z0-9-]*(\.[A-Za-z][A-Za-z0-9-]*)*$/;
const FIELD_MAX_LENGTH = 128;

function sanitizedLine(entry: LogEntry): Record<string, unknown> {
  const line: Record<string, unknown> = {
    event: EVENT_PATTERN.test(entry.event) ? entry.event : UNCLASSIFIED,
  };
  if (entry.messageId !== undefined) {
    line.messageId = MESSAGE_ID_PATTERN.test(entry.messageId) ? entry.messageId : UNCLASSIFIED;
  }
  if (entry.errorName !== undefined) {
    line.errorName = ERROR_NAME_PATTERN.test(entry.errorName) ? entry.errorName : UNCLASSIFIED;
  }
  if (entry.field !== undefined) {
    line.field = entry.field.length <= FIELD_MAX_LENGTH && FIELD_PATTERN.test(entry.field) ? entry.field : UNCLASSIFIED;
  }
  if (entry.count !== undefined && Number.isInteger(entry.count) && entry.count >= 0) {
    line.count = entry.count;
  }
  return line;
}

export function createLogger(sink: LogSink): Logger {
  return {
    info(entry) {
      sink(JSON.stringify(sanitizedLine(entry)));
    },
    error(entry) {
      sink(JSON.stringify(sanitizedLine(entry)));
    },
  };
}
