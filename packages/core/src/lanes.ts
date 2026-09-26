import { z } from 'zod';

// The tag-value pattern also bounds a declared stream name; SES tag values allow the same
// alphanumeric-plus-hyphen-underscore charset up to 256 characters.
const STREAM_VALUE_PATTERN = /^[A-Za-z0-9_-]{1,256}$/;

// SES sets these on every configuration-set event itself (ses:configuration-set,
// ses:source-ip, and so on); an operator-declared tag key can never collide with one.
const SES_AUTOMATIC_TAG_PREFIX = 'ses:';

const laneEntrySchema = z.object({
  configurationSet: z.string(),
  lane: z.string(),
  criticality: z.enum(['transactional', 'bulk']),
  declaredStreams: z.array(z.string().regex(STREAM_VALUE_PATTERN)).min(1),
  streamTagKey: z.string().min(1),
  batchTagKey: z.string().min(1),
  templateTagKey: z.string().min(1),
  campaignTagKey: z.string().min(1),
  tenant: z.string().optional(),
  operatorAlert: z.boolean(),
});

export const laneMapSchema = z
  .object({
    runIdTagKey: z.string(),
    lanes: z.array(laneEntrySchema).min(1),
  })
  .superRefine((map, ctx) => {
    if (map.runIdTagKey.startsWith(SES_AUTOMATIC_TAG_PREFIX)) {
      ctx.addIssue({
        code: 'custom',
        message: `runIdTagKey may not start with the automatic "${SES_AUTOMATIC_TAG_PREFIX}" prefix`,
        path: ['runIdTagKey'],
      });
    }

    map.lanes.forEach((lane, laneIndex) => {
      const seenStreams = new Set<string>();
      lane.declaredStreams.forEach((stream, streamIndex) => {
        if (seenStreams.has(stream)) {
          ctx.addIssue({
            code: 'custom',
            message: `duplicate declared stream "${stream}"`,
            path: ['lanes', laneIndex, 'declaredStreams', streamIndex],
          });
        }
        seenStreams.add(stream);
      });

      const tagKeys: readonly (readonly [string, string])[] = [
        ['streamTagKey', lane.streamTagKey],
        ['batchTagKey', lane.batchTagKey],
        ['templateTagKey', lane.templateTagKey],
        ['campaignTagKey', lane.campaignTagKey],
        ['runIdTagKey', map.runIdTagKey],
      ];

      for (const [field, value] of tagKeys) {
        if (field !== 'runIdTagKey' && value.startsWith(SES_AUTOMATIC_TAG_PREFIX)) {
          ctx.addIssue({
            code: 'custom',
            message: `${field} may not start with the automatic "${SES_AUTOMATIC_TAG_PREFIX}" prefix`,
            path: ['lanes', laneIndex, field],
          });
        }
      }

      for (let i = 0; i < tagKeys.length; i++) {
        for (let j = i + 1; j < tagKeys.length; j++) {
          const first = tagKeys[i];
          const second = tagKeys[j];
          if (first === undefined || second === undefined) continue;
          const [fieldA, valueA] = first;
          const [fieldB, valueB] = second;
          if (valueA === valueB) {
            ctx.addIssue({
              code: 'custom',
              message: `${fieldA} and ${fieldB} must be distinct`,
              path: fieldB === 'runIdTagKey' ? ['runIdTagKey'] : ['lanes', laneIndex, fieldB],
            });
          }
        }
      }
    });
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
