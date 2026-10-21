import * as z from 'zod';
import type { LaneMap } from './lanes.js';
import type { StepPlanEntry } from './scenarios.js';

export const MIN_SEND_GAP_MS = 1250;

export interface LiveRunTag {
  name: string;
  value: string;
}

export interface LiveRunRequest {
  from: string;
  to: string;
  subject: string;
  text: string;
  configurationSetName: string;
  tags: LiveRunTag[];
}

const tagSchema = z.strictObject({ name: z.string(), value: z.string() });

export const attemptRecordSchema = z.strictObject({
  lane: z.string(),
  tags: z.array(tagSchema),
  recipient: z.string(),
  startUtc: z.string(),
  endUtc: z.string(),
  messageId: z.string(),
  requestId: z.string(),
});

export type AttemptRecord = z.infer<typeof attemptRecordSchema>;

export function buildLiveRunRequest(_entry: StepPlanEntry, _laneMap: LaneMap, _runId: string, _from: string): LiveRunRequest {
  throw new Error('not implemented');
}
