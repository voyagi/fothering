import { z } from 'zod';

const laneEntrySchema = z.object({
  configurationSet: z.string(),
  lane: z.string(),
  criticality: z.enum(['transactional', 'bulk']),
  declaredStreams: z.array(z.string()),
  streamTagKey: z.string(),
  batchTagKey: z.string(),
  templateTagKey: z.string(),
  campaignTagKey: z.string(),
  tenant: z.string().optional(),
  operatorAlert: z.boolean(),
});

export const laneMapSchema = z.object({
  runIdTagKey: z.string(),
  lanes: z.array(laneEntrySchema),
});

export type LaneEntry = z.infer<typeof laneEntrySchema>;
export type LaneMap = z.infer<typeof laneMapSchema>;

export function parseLaneMap(json: unknown): LaneMap {
  return laneMapSchema.parse(json);
}

// Plan 01-14 adds the stricter validation rules (duplicate names, empty streams, and so on).
// This plan matches by exact string equality only, per the exact-match rule EventBridge itself
// uses on the configuration-set tag.
export function findLane(laneMap: LaneMap, configurationSet: string): LaneEntry | undefined {
  return laneMap.lanes.find((entry) => entry.configurationSet === configurationSet);
}
