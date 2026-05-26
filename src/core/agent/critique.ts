import { z } from "zod";
import { generateObject } from "../llm.ts";
import { loadPrompt } from "../prompts.ts";
import {
  CritiqueIssueCategorySchema,
  CritiqueIssueSeveritySchema,
  type CritiqueResult,
  type ResumeDraft,
} from "../schema/agent.ts";
import type { LlmConfig } from "../schema/config.ts";

const CritiqueLlmOutputSchema = z.object({
  overallScore: z.number().min(0).max(10),
  summary: z.string().min(1),
  issues: z.array(
    z.object({
      severity: CritiqueIssueSeveritySchema,
      category: CritiqueIssueCategorySchema,
      description: z.string(),
      location: z.string().optional(),
      suggestion: z.string(),
    }),
  ),
  passedChecks: z.array(z.string()),
});

const OUTPUT_SCHEMA_DESCRIPTION = `
Output ONLY valid JSON (no markdown fences) matching this exact schema:
{
  "overallScore": number (0-10),
  "summary": "string — 2-3 sentence overall assessment",
  "issues": [
    {
      "severity": "error" | "warning" | "suggestion",
      "category": "structure" | "content" | "language" | "positioning" | "length",
      "description": "string — specific problem found",
      "location": "string — optional, which section/project is affected",
      "suggestion": "string — concrete actionable fix"
    }
  ],
  "passedChecks": ["string — things the resume does well"]
}
Constraints:
- Be specific: name the exact project or section in description/location.
- Issues must have actionable suggestions, not vague advice.
- passedChecks should acknowledge genuine strengths.
`;

function formatDraftForCritique(draft: ResumeDraft): string {
  return JSON.stringify(
    {
      headline: draft.headline,
      summary: draft.summary,
      skills: draft.skills,
      selectedProjects: draft.selectedProjects.map((p) => ({
        title: p.title,
        period: `${p.period.from.slice(0, 7)} ~ ${p.period.to.slice(0, 7)}`,
        bullets: p.bullets,
        stack: p.stack,
      })),
      otherExperience: draft.otherExperience,
    },
    null,
    2,
  );
}

/**
 * Critique a ResumeDraft: evaluate quality, flag issues, assign overall score.
 * Single LLM call.
 */
export async function critiqueDraft(
  llmConfig: LlmConfig,
  draft: ResumeDraft,
  draftSlug: string,
  lang: "zh" | "en",
): Promise<CritiqueResult> {
  const systemPromptBase = await loadPrompt("critique", lang);
  const system = `${systemPromptBase}\n\n${OUTPUT_SCHEMA_DESCRIPTION}`;
  const user = `Please critique this resume draft:\n\n${formatDraftForCritique(draft)}`;

  const llmOutput = await generateObject(llmConfig, CritiqueLlmOutputSchema, system, user);

  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    draftSlug,
    ...llmOutput,
  };
}
