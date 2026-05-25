import { z } from "zod";

/**
 * ProjectNarrative — an AI-interpreted, resume-worthy project view.
 *
 * Output of the new `interpret` stage. The interpreter is allowed to:
 * - Split a single repo into multiple narratives when sub-projects exist.
 * - Merge multiple repos into one narrative when they belong to the same project.
 * - Drop bundles that look like maintenance noise (recorded in riskFlags).
 *
 * This is NOT a final resume entry. It is the canonical "what is this project,
 * from the candidate's perspective, and is it worth showing?" record.
 */

/** A proof point: a concrete, evidence-backed claim safe to surface on a resume. */
export const ProofPointSchema = z.object({
  text: z.string(),
  /** "metric" | "shipped" | "ownership" | "design" | "process" — flexible vocabulary. */
  kind: z.string(),
  /** Refs into source EvidenceBundle ids / event ids. */
  evidenceRefs: z.array(z.string()).min(1),
  /** Whether this proof point is safe to use verbatim, or needs softer phrasing. */
  strength: z.enum(["strong", "moderate", "soft"]),
});
export type ProofPoint = z.infer<typeof ProofPointSchema>;

/** Risk flag: something that might disqualify or weaken this narrative. */
export const RiskFlagSchema = z.object({
  /** e.g. "maintenance-only", "ambiguous-ownership", "no-quantifiable-outcome". */
  kind: z.string(),
  note: z.string().optional(),
});
export type RiskFlag = z.infer<typeof RiskFlagSchema>;

export const ProjectNarrativeSchema = z.object({
  /** Stable key across runs. Often derived from primary repo + workstream label. */
  projectKey: z.string(),
  title: z.string(),
  period: z.object({ from: z.string(), to: z.string() }),
  /** Short statement of what this project covered. */
  scope: z.string(),
  /** What role did the candidate play (owner / contributor / maintainer / etc.). */
  candidateRole: z.string(),
  /** The problem this project tried to solve. */
  coreProblem: z.string(),
  /** Shape of the solution: architecture, approach, key trade-offs. */
  solutionShape: z.string(),
  proofPoints: z.array(ProofPointSchema),
  techStack: z.array(z.string()),
  /** Tags describing seniority / impact signals, e.g. "ownership", "cross-team". */
  strengthSignals: z.array(z.string()).default([]),
  riskFlags: z.array(RiskFlagSchema).default([]),
  /** 0..1 score the interpreter assigns for resume-worthiness. */
  resumeWorthiness: z.number().min(0).max(1),
  /** EvidenceBundle ids this narrative was synthesized from. */
  sourceEvidenceIds: z.array(z.string()).min(1),
  /** Primary repos involved (one narrative may span multiple). */
  repos: z.array(z.string()).min(1),
});
export type ProjectNarrative = z.infer<typeof ProjectNarrativeSchema>;

export const NarrativeLogSchema = z.object({
  version: z.literal(1),
  generatedAt: z.string().datetime(),
  narratives: z.array(ProjectNarrativeSchema),
});
export type NarrativeLog = z.infer<typeof NarrativeLogSchema>;
