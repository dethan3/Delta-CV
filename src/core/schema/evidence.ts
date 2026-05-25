import { z } from "zod";

/**
 * EvidenceBundle — raw, semi-structured evidence about one chunk of work.
 *
 * Produced by the new evidence-organizer stage (built either directly from
 * raw event clusters, or in PR1 from existing ExperienceEntry as a bridge).
 *
 * Design principles:
 * - Allow uncertainty: outcomes and claims may be tentative.
 * - Preserve project boundaries via workstreamHints so a later interpret
 *   stage can split one repo into multiple narratives or merge multiple
 *   repos into a single narrative.
 * - Do NOT polish into resume-ready bullets. That happens later.
 */
export const EvidencePeriodSchema = z.object({
  from: z.string(),
  to: z.string(),
});

/** A single technical move actually visible in commits / PRs / issues. */
export const TechnicalMoveSchema = z.object({
  /** Short verb-led description, e.g. "introduced retry-with-backoff in fetch layer". */
  text: z.string(),
  /** Optional pointers into the underlying event ids / shas. */
  evidenceRefs: z.array(z.string()).default([]),
  /** Optional tags (lowercase). */
  tags: z.array(z.string()).default([]),
});
export type TechnicalMove = z.infer<typeof TechnicalMoveSchema>;

/** A possible outcome that the model believes is plausible from evidence. */
export const PossibleOutcomeSchema = z.object({
  text: z.string(),
  /** "supported" if evidence is explicit; "inferred" if reasoned from context; "speculative" otherwise. */
  confidence: z.enum(["supported", "inferred", "speculative"]),
  evidenceRefs: z.array(z.string()).default([]),
});
export type PossibleOutcome = z.infer<typeof PossibleOutcomeSchema>;

/**
 * A verbatim excerpt from the underlying evidence with its origin preserved.
 *
 * Why an object instead of a bare string: at verify-facts time we need to
 * answer "which raw event/PR/commit does this proof point trace back to?".
 * A plain string drops that linkage. Each excerpt MUST carry at least one
 * evidenceRef.
 */
export const EvidenceExcerptSchema = z.object({
  /** Verbatim (or minimally trimmed) text from the source. */
  text: z.string(),
  /** Source ids: event id, commit sha, PR/issue url, etc. At least one. */
  evidenceRefs: z.array(z.string()).min(1),
  /** Optional origin kind, e.g. "commit" | "pr-title" | "pr-body" | "issue" | "review". */
  kind: z.string().optional(),
});
export type EvidenceExcerpt = z.infer<typeof EvidenceExcerptSchema>;

export const EvidenceBundleSchema = z.object({
  id: z.string(),
  repo: z.string(),
  period: EvidencePeriodSchema,
  /** Hints about which sub-workstream this belongs to, e.g. "auth-rewrite", "perf-q2". */
  workstreamHints: z.array(z.string()).default([]),
  /** Concrete technical moves. */
  technicalMoves: z.array(TechnicalMoveSchema),
  /** Outcomes the model thinks are plausible. May be empty. */
  possibleOutcomes: z.array(PossibleOutcomeSchema).default([]),
  /** Verbatim evidence excerpts with origin refs preserved. */
  explicitEvidence: z.array(EvidenceExcerptSchema).default([]),
  /** Claims the model wants to flag as uncertain — do not yet promote to resume. */
  uncertainClaims: z.array(z.string()).default([]),
  /** Stack actually visible in this chunk of work. */
  stack: z.array(z.string()).default([]),
  /** Capability tags (lowercase). */
  tags: z.array(z.string()).default([]),
  /** Source evidence entry ids (cluster ids / event ids) for traceability. */
  sourceEventIds: z.array(z.string()).default([]),
});
export type EvidenceBundle = z.infer<typeof EvidenceBundleSchema>;

export const EvidenceLogSchema = z.object({
  version: z.literal(1),
  generatedAt: z.string().datetime(),
  bundles: z.array(EvidenceBundleSchema),
});
export type EvidenceLog = z.infer<typeof EvidenceLogSchema>;
