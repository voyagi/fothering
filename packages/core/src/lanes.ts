import { z } from 'zod';

// The SES MessageTag rule, the same for a tag's name and its value: "ASCII letters (a-z, A-Z),
// numbers (0-9), underscores (_), or dashes (-)", "no more than 256 characters". A declared tag key
// or stream outside it can never match a tag SES publishes, so its field would silently never be
// stored. The rule also keeps out the tags SES sets itself (ses:configuration-set, ses:source-ip
// and so on): their colon is outside the charset, so an operator key can never collide with one.
const SES_TAG_PATTERN = /^[A-Za-z0-9_-]{1,256}$/;
const SES_TAG_NAME_MESSAGE =
  'a tag key must be 1 to 256 ASCII letters, digits, underscores or dashes, the SES message tag rule (so never an automatic "ses:" tag)';

const tagKeySchema = z.string().regex(SES_TAG_PATTERN, SES_TAG_NAME_MESSAGE);

// AWS's own configuration-set naming rule: "up to 64 alphanumeric characters, including
// letters, numbers, hyphens (-) and underscores (_) only."
const CONFIGURATION_SET_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

const laneEntrySchema = z.object({
  configurationSet: z.string().regex(CONFIGURATION_SET_PATTERN),
  lane: z.string().min(1),
  criticality: z.enum(['transactional', 'bulk']),
  declaredStreams: z.array(z.string().regex(SES_TAG_PATTERN)).min(1),
  streamTagKey: tagKeySchema,
  batchTagKey: tagKeySchema,
  templateTagKey: tagKeySchema,
  campaignTagKey: tagKeySchema,
  tenant: z.string().min(1).optional(),
  operatorAlert: z.boolean(),
});

export const laneMapSchema = z
  .object({
    runIdTagKey: tagKeySchema,
    lanes: z.array(laneEntrySchema).min(1),
  })
  .superRefine((map, ctx) => {
    const seenConfigurationSets = new Map<string, number>();
    map.lanes.forEach((lane, laneIndex) => {
      const normalizedConfigurationSet = lane.configurationSet.toLowerCase();
      if (seenConfigurationSets.has(normalizedConfigurationSet)) {
        ctx.addIssue({
          code: 'custom',
          message: `configurationSet "${lane.configurationSet}" collides with lane ${seenConfigurationSets.get(normalizedConfigurationSet)}`,
          path: ['lanes', laneIndex, 'configurationSet'],
        });
      } else {
        seenConfigurationSets.set(normalizedConfigurationSet, laneIndex);
      }

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

      for (let i = 0; i < tagKeys.length; i++) {
        for (let j = i + 1; j < tagKeys.length; j++) {
          const first = tagKeys[i];
          const second = tagKeys[j];
          if (first === undefined || second === undefined) continue;
          const [fieldA, valueA] = first;
          const [fieldB, valueB] = second;
          // runIdTagKey sits on the map, so its issue path names no lane: the message does instead.
          if (valueA === valueB) {
            ctx.addIssue(
              fieldB === 'runIdTagKey'
                ? { code: 'custom', message: `lanes[${laneIndex}].${fieldA} and runIdTagKey must be distinct`, path: ['runIdTagKey'] }
                : { code: 'custom', message: `${fieldA} and ${fieldB} must be distinct`, path: ['lanes', laneIndex, fieldB] },
            );
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

// Exact string equality only, matching the rule EventBridge itself uses on the
// configuration-set tag (AC-E14): a value differing by case or a suffix never matches.
export function findLane(laneMap: LaneMap, configurationSet: string): LaneEntry | undefined {
  return laneMap.lanes.find((entry) => entry.configurationSet === configurationSet);
}
