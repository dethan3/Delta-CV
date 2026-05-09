import { z } from "zod";

export const FocusItemSchema = z.object({
  tag: z.string(),
  score: z.number(),
  trend: z.enum(["rising", "stable", "declining"]),
});
export type FocusItem = z.infer<typeof FocusItemSchema>;

export const SnapshotSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  focus: z.array(FocusItemSchema),
  topTags: z.array(z.string()),
  experienceLogChecksum: z.string(),
  /** Raw tag frequencies stored for accurate trend computation on the next evolve run. */
  tagFrequency: z.record(z.number()).optional(),
});
export type Snapshot = z.infer<typeof SnapshotSchema>;

export const SnapshotDiffSchema = z.object({
  from: z.string(),
  to: z.string(),
  newCapabilities: z.array(z.string()),
  risingTags: z.array(z.string()),
  decliningTags: z.array(z.string()),
});
export type SnapshotDiff = z.infer<typeof SnapshotDiffSchema>;
