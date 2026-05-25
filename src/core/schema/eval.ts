import { z } from "zod";

/**
 * VerifyFactsReport — output of the new `verify-facts` stage.
 *
 * Runs after compose() and before critique(). Cross-checks every bullet
 * in the draft against evidence refs from ProjectNarrative.proofPoints.
 */

export const FactSeveritySchema = z.enum(["error", "warning", "info"]);
export type FactSeverity = z.infer<typeof FactSeveritySchema>;

export const UnsupportedClaimSchema = z.object({
  severity: FactSeveritySchema,
  location: z.string(),
  /** The raw text fragment being challenged. */
  text: z.string(),
  /** What kind of claim is unsupported: "metric" | "ownership" | "scale" | "architecture" | "other". */
  kind: z.string(),
  reason: z.string(),
  suggestedFix: z.string().optional(),
});
export type UnsupportedClaim = z.infer<typeof UnsupportedClaimSchema>;

export const VerifyFactsReportSchema = z.object({
  version: z.literal(1),
  generatedAt: z.string().datetime(),
  draftSlug: z.string(),
  /**
   * Single source of truth for fact issues. Each item carries its own
   * `severity` (`error` | `warning` | `info`); consumers group by severity
   * for display. Do NOT add parallel arrays — that re-introduces the
   * double-bookkeeping problem.
   */
  claims: z.array(UnsupportedClaimSchema).default([]),
  /** Coverage: proportion of bullets that have at least one evidence ref. */
  coverage: z.number().min(0).max(1),
});
export type VerifyFactsReport = z.infer<typeof VerifyFactsReportSchema>;

/**
 * Eval — minimal regression eval over a small fixed sample set.
 */

export const EvalDimensionSchema = z.enum([
  "selection_quality",
  "positioning_quality",
  "bullet_specificity",
  "fact_groundedness",
  "jd_alignment",
]);
export type EvalDimension = z.infer<typeof EvalDimensionSchema>;

/** One fixed input case for regression. */
export const EvalCaseSchema = z.object({
  id: z.string(),
  /** Path (relative to fixtures dir) to a snapshot of inputs: experience log + JD if any. */
  fixturePath: z.string(),
  /** Free-form description. */
  description: z.string().optional(),
  /** Optional JD slug — when set, this case is JD-targeted. */
  jdSlug: z.string().optional(),
});
export type EvalCase = z.infer<typeof EvalCaseSchema>;

export const EvalScoreSchema = z.object({
  dimension: EvalDimensionSchema,
  score: z.number().min(0).max(10),
  comment: z.string().optional(),
});
export type EvalScore = z.infer<typeof EvalScoreSchema>;

export const EvalCaseResultSchema = z.object({
  caseId: z.string(),
  scores: z.array(EvalScoreSchema),
  draftSlug: z.string(),
});
export type EvalCaseResult = z.infer<typeof EvalCaseResultSchema>;

export const EvalReportSchema = z.object({
  version: z.literal(1),
  generatedAt: z.string().datetime(),
  results: z.array(EvalCaseResultSchema),
  /** Aggregate score per dimension across cases. */
  aggregate: z.record(EvalDimensionSchema, z.number().min(0).max(10)),
});
export type EvalReport = z.infer<typeof EvalReportSchema>;
