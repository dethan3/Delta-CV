import { z } from "zod";

export const HighlightSchema = z.object({
  text: z.string(),
  tags: z.array(z.string()),
  evidence: z.array(z.string()).optional(),
});
export type Highlight = z.infer<typeof HighlightSchema>;

export const ExperienceEntrySchema = z.object({
  id: z.string(),
  repo: z.string(),
  period: z.object({ from: z.string(), to: z.string() }),
  title: z.string(),
  highlights: z.array(HighlightSchema),
  stack: z.array(z.string()),
  tags: z.array(z.string()),
});
export type ExperienceEntry = z.infer<typeof ExperienceEntrySchema>;

export const ExperienceLogSchema = z.object({
  version: z.number().int().positive(),
  generatedAt: z.string().datetime(),
  entries: z.array(ExperienceEntrySchema),
});
export type ExperienceLog = z.infer<typeof ExperienceLogSchema>;
