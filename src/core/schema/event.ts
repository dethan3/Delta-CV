import { z } from "zod";

export const EventKindSchema = z.enum(["commit", "pr", "issue", "review"]);
export type EventKind = z.infer<typeof EventKindSchema>;

/** Unified event envelope written to data/events/<yyyy-ww>.jsonl */
export const EventEnvelopeSchema = z.object({
  kind: EventKindSchema,
  repo: z.string(),
  ts: z.string().datetime(),
  payload: z.record(z.string(), z.unknown()),
});
export type EventEnvelope = z.infer<typeof EventEnvelopeSchema>;
