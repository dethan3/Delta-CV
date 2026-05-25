import type { JdProfile } from "../schema/agent.ts";
import type { LlmConfig } from "../schema/config.ts";
import type { ProjectNarrative } from "../schema/narrative.ts";
import type { JdMatchReport } from "../schema/plan.ts";

export interface JdMatchOptions {
  lang: "zh" | "en";
  /** When true, allow LLM to claim adjacent strengths even without direct evidence. */
  allowAdjacency?: boolean;
}

/**
 * Score every narrative against a parsed JD profile via LLM.
 *
 * The model is asked to answer, per project:
 * - Which JD requirements does this project credibly demonstrate?
 * - Which JD requirements are merely adjacent (related but not proven)?
 * - What angle should the writer take when describing this project?
 * - What should the writer NOT claim because evidence is insufficient?
 *
 * Output is consumed by `select` for re-ranking and by `compose` for
 * controlling overclaim risk.
 */
export async function matchNarrativesToJd(
  _llmConfig: LlmConfig,
  _narratives: ProjectNarrative[],
  _jd: JdProfile,
  _options: JdMatchOptions,
): Promise<JdMatchReport> {
  // TODO(pr2-agent-jd-match): implement.
  throw new Error("matchNarrativesToJd: not implemented (PR2 skeleton)");
}
