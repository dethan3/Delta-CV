import { z } from "zod";
import { generateObject } from "../llm.ts";
import { loadPrompt } from "../prompts.ts";
import type { JdProfile } from "../schema/agent.ts";
import type { LlmConfig } from "../schema/config.ts";
import type { ProjectNarrative } from "../schema/narrative.ts";
import { JdMatchSchema, type JdMatchReport } from "../schema/plan.ts";

export interface JdMatchOptions {
  lang: "zh" | "en";
  /** When true, allow LLM to claim adjacent strengths even without direct evidence. */
  allowAdjacency?: boolean;
}

function fallbackBestAngle(title: string, lang: "zh" | "en"): string {
  return lang === "zh"
    ? `${title} 与该岗位的直接证据较弱，若保留应采用保守表述或降级处理。`
    : `${title} has limited direct evidence against this JD, so it should be framed conservatively or deprioritised.`;
}

const SYSTEM_SCHEMA = `
Output ONLY valid JSON (no markdown fences) matching this exact schema:
{
  "matches": [
    {
      "projectId": "string (must equal one input projectKey)",
      "relevanceScore": "number in [0,1]",
      "matchedRequirements": ["string (subset of jd.requiredSkills only)"],
      "adjacentStrengths": ["string"],
      "bestAngle": "string (one sentence)",
      "doNotOverclaim": ["string"]
    }
  ]
}
Hard constraints:
- Return exactly one match object per input narrative.
- projectId MUST be one of the input projectKey values.
- matchedRequirements MUST be drawn only from jd.requiredSkills.
- niceToHaveSkills may influence adjacentStrengths, but MUST NOT appear in matchedRequirements unless they also appear in requiredSkills.
- If evidence is weak, lower relevanceScore instead of stretching matchedRequirements.
- doNotOverclaim should name concrete phrases or claims the writer must avoid.
`;

const JdMatchOutputSchema = z.object({
  matches: z.array(JdMatchSchema),
});

function buildUserPrompt(
  narratives: ProjectNarrative[],
  jd: JdProfile,
  options: JdMatchOptions,
): string {
  return JSON.stringify(
    {
      jd: {
        slug: jd.slug,
        jobTitle: jd.jobTitle,
        seniority: jd.seniority,
        requiredSkills: jd.requiredSkills,
        niceToHaveSkills: jd.niceToHaveSkills,
        keyResponsibilities: jd.keyResponsibilities,
        targetProfile: jd.targetProfile,
      },
      allowAdjacency: options.allowAdjacency ?? false,
      narratives: narratives.map((n) => ({
        projectKey: n.projectKey,
        title: n.title,
        period: `${n.period.from.slice(0, 10)} → ${n.period.to.slice(0, 10)}`,
        candidateRole: n.candidateRole,
        coreProblem: n.coreProblem,
        solutionShape: n.solutionShape,
        proofPoints: n.proofPoints.map((pp) => ({
          text: pp.text,
          kind: pp.kind,
          strength: pp.strength,
        })),
        techStack: n.techStack,
        strengthSignals: n.strengthSignals,
        riskFlags: n.riskFlags,
        resumeWorthiness: n.resumeWorthiness,
      })),
    },
    null,
    2,
  );
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
  llmConfig: LlmConfig,
  narratives: ProjectNarrative[],
  jd: JdProfile,
  options: JdMatchOptions,
): Promise<JdMatchReport> {
  if (narratives.length === 0) {
    return {
      version: 1,
      generatedAt: new Date().toISOString(),
      jdSlug: jd.slug,
      matches: [],
    };
  }

  const systemBase = await loadPrompt("jd-match", options.lang);
  const system = `${systemBase}\n\n${SYSTEM_SCHEMA}`;
  const user = buildUserPrompt(narratives, jd, options);

  const out = await generateObject(llmConfig, JdMatchOutputSchema, system, user);

  const validProjectIds = new Set(narratives.map((n) => n.projectKey));
  const validRequiredSkills = new Set(jd.requiredSkills);
  const byProject = new Map(out.matches.map((m) => [m.projectId, m]));

  const matches = narratives.map((n) => {
    const raw = byProject.get(n.projectKey);
    if (!raw) {
      return {
        projectId: n.projectKey,
        relevanceScore: 0,
        matchedRequirements: [],
        adjacentStrengths: [],
        bestAngle: fallbackBestAngle(n.title, options.lang),
        doNotOverclaim: [],
      };
    }
    return {
      projectId: n.projectKey,
      relevanceScore: Math.max(0, Math.min(1, raw.relevanceScore)),
      matchedRequirements: raw.matchedRequirements.filter((req) => validRequiredSkills.has(req)),
      adjacentStrengths: options.allowAdjacency
        ? Array.from(new Set(raw.adjacentStrengths ?? []))
        : [],
      bestAngle: raw.bestAngle,
      doNotOverclaim: Array.from(new Set(raw.doNotOverclaim ?? [])),
    };
  }).filter((m) => validProjectIds.has(m.projectId));

  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    jdSlug: jd.slug,
    matches,
  };
}
