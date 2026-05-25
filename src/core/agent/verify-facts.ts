import type { ResumeDraft } from "../schema/agent.ts";
import type { LlmConfig } from "../schema/config.ts";
import type { VerifyFactsReport } from "../schema/eval.ts";
import type { ProjectNarrative } from "../schema/narrative.ts";

export interface VerifyFactsOptions {
  lang: "zh" | "en";
  /** When true, use LLM for the verification pass. When false, only deterministic checks. */
  useLlm?: boolean;
}

/**
 * Cross-check every bullet in a ResumeDraft against the proofPoints of the
 * ProjectNarratives that produced it.
 *
 * Deterministic checks (no LLM):
 * - Every bullet's projectId must map to a narrative.
 * - Every metric-shaped fragment (regex on digits + units / "%" / "x") must
 *   have at least one proofPoint of kind "metric" attached to its project.
 *
 * LLM checks (when useLlm=true):
 * - Detect ownership overclaims ("led", "owned", "drove") not backed by
 *   strengthSignals.
 * - Detect scale / architecture claims not present in proofPoints.
 * - Surface fixes via suggestedFix.
 */
export async function verifyDraftFacts(
  _llmConfig: LlmConfig,
  _draft: ResumeDraft,
  _narratives: ProjectNarrative[],
  _options: VerifyFactsOptions,
): Promise<VerifyFactsReport> {
  // TODO(pr3-agent-verify): implement.
  throw new Error("verifyDraftFacts: not implemented (PR3 skeleton)");
}
