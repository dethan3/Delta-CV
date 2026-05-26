import { z } from "zod";

/**
 * ResumePlan — explicit curation plan produced by the `select` stage.
 *
 * compose() is no longer allowed to silently pick which projects to show or
 * what the positioning is. The plan makes selection, ordering and positioning
 * decisions auditable and reproducible.
 */

export const SkillEmphasisSchema = z.object({
  /** Capability name (e.g. "LLM ops", "Distributed systems"). */
  name: z.string(),
  /**
   * Projects (by projectKey) that prove this capability. MUST be a non-empty
   * subset of ResumePlan.selectedProjectIds — that's how the audit trail
   * works: every emphasized skill is traceable to at least one resume project.
   */
  supportingProjectIds: z.array(z.string()).min(1),
  /** One short sentence explaining the linkage. */
  rationale: z.string().optional(),
});
export type SkillEmphasis = z.infer<typeof SkillEmphasisSchema>;

export const ProjectEmphasisSchema = z.object({
  /** Selected project id this writing guidance applies to. */
  projectId: z.string(),
  /** Why this project matters on the resume, in recruiter-facing terms. */
  whySelected: z.string(),
  /** The primary resume angle to take for this project. */
  resumeAngle: z.string(),
  /** Bullet-level themes the writer should cover. */
  bulletFocus: z.array(z.string()).default([]),
  /** Concrete proof points to prefer when writing bullets. */
  highlightProofPoints: z.array(z.string()).default([]),
  /** Claims or phrasing to avoid for this project. */
  cautionNotes: z.array(z.string()).default([]),
});
export type ProjectEmphasis = z.infer<typeof ProjectEmphasisSchema>;

export const ResumePlanSchema = z.object({
  version: z.literal(1),
  generatedAt: z.string().datetime(),
  /** One-line candidate positioning, e.g. "Backend-leaning full-stack engineer with LLM ops experience". */
  positioning: z.string(),
  /** Optional target role string (free-form). */
  targetRole: z.string().optional(),
  /**
   * ProjectNarrative.projectKey list, in the final desired order.
   * This array IS the order — there is no parallel projectOrder field.
   * compose() must render projects in exactly this sequence.
   */
  selectedProjectIds: z.array(z.string()),
  /** Why these projects were chosen, in narrative form. */
  selectionRationale: z.string(),
  /** Narratives intentionally dropped, for audit. */
  deprioritizedProjectIds: z.array(z.string()).default([]),
  /** Narratives that should appear only as supporting / additional experience. */
  supportingProjectIds: z.array(z.string()).default([]),
  skillEmphasis: z.array(SkillEmphasisSchema).default([]),
  /** Per-project writing guidance consumed by compose. */
  projectEmphasis: z.array(ProjectEmphasisSchema).default([]),
  /** Soft hints for compose: tone, length, audience, etc. */
  styleHints: z.array(z.string()).default([]),
  /** Optional reference to the JdMatch report this plan was built against. */
  jdSlug: z.string().optional(),
});
export type ResumePlan = z.infer<typeof ResumePlanSchema>;

/**
 * JdMatch — semantic alignment between one project and one JD.
 * Produced by `jd-match` stage. Consumed by `select` for re-ranking.
 */
export const JdMatchSchema = z.object({
  projectId: z.string(),
  /** 0..1, model-assigned. */
  relevanceScore: z.number().min(0).max(1),
  /** JD requirements this project can credibly demonstrate. */
  matchedRequirements: z.array(z.string()),
  /** Adjacent strengths that are useful context but should not be hard-claimed. */
  adjacentStrengths: z.array(z.string()).default([]),
  /** Suggested narrative angle for this project given the JD. */
  bestAngle: z.string(),
  /** Things the writer must NOT claim because evidence is insufficient. */
  doNotOverclaim: z.array(z.string()).default([]),
});
export type JdMatch = z.infer<typeof JdMatchSchema>;

export const JdMatchReportSchema = z.object({
  version: z.literal(1),
  generatedAt: z.string().datetime(),
  jdSlug: z.string(),
  matches: z.array(JdMatchSchema),
});
export type JdMatchReport = z.infer<typeof JdMatchReportSchema>;
