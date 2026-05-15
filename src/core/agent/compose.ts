import { z } from "zod";
import { generateObject } from "../llm.ts";
import { loadPrompt } from "../prompts.ts";
import type { LlmConfig } from "../schema/config.ts";
import {
  ProjectSectionSchema,
  SkillGroupSchema,
  type CapabilityClaim,
  type CurateResult,
  type ProjectMemory,
  type ResumeDraft,
} from "../schema/agent.ts";

export interface ComposeOptions {
  lang: "zh" | "en";
  targetRole?: string;
  topN?: number;
  jd?: string;
}

const ComposeLlmOutputSchema = z.object({
  headline: z.string().min(1),
  summary: z.string().min(1),
  skills: z.array(SkillGroupSchema),
  selectedProjects: z.array(ProjectSectionSchema),
  otherExperience: z.array(z.string()),
});

const OUTPUT_SCHEMA_DESCRIPTION = `
Output ONLY valid JSON (no markdown fences) matching this exact schema:
{
  "headline": "string — one-line candidate positioning (≤ 25 words)",
  "summary": "string — 3-4 sentence narrative paragraph",
  "skills": [
    { "category": "string", "items": ["string"] }
  ],
  "selectedProjects": [
    {
      "projectId": "string",
      "title": "string",
      "period": { "from": "ISO date string", "to": "ISO date string" },
      "bullets": ["string — starts with strong action verb"],
      "stack": ["string"]
    }
  ],
  "otherExperience": ["string — one-line description per minor project"]
}
Constraints:
- selectedProjects: 2–3 bullets each, maximum 3 bullets.
- skills: group by capability area, each group has 3–8 items.
- All text content in the requested language.
- Do not invent projects, technologies, or metrics not present in the input.
`;

function formatProjectForPrompt(p: ProjectMemory): object {
  return {
    id: p.id,
    repo: p.repo,
    title: p.title,
    period: `${p.period.from.slice(0, 7)} ~ ${p.period.to.slice(0, 7)}`,
    activeMonths: p.activeMonths,
    category: p.category,
    importance: p.importance,
    highlights: p.highlights.slice(0, 6).map((h) => h.text),
    stack: p.stack.slice(0, 10),
  };
}

function formatClaimForPrompt(c: CapabilityClaim): object {
  return {
    category: c.category,
    technologies: c.technologies.slice(0, 8),
    confidence: Math.round(c.confidence * 100) / 100,
  };
}

function buildUserPrompt(
  login: string,
  topProjects: ProjectMemory[],
  otherProjects: ProjectMemory[],
  claims: CapabilityClaim[],
  options: ComposeOptions,
): string {
  const input = {
    candidate: login,
    language: options.lang,
    targetRole: options.targetRole ?? null,
    topProjects: topProjects.map(formatProjectForPrompt),
    otherProjects: otherProjects.map((p) => ({
      id: p.id,
      repo: p.repo,
      title: p.title,
      period: `${p.period.from.slice(0, 7)} ~ ${p.period.to.slice(0, 7)}`,
      category: p.category,
    })),
    capabilityClaims: claims.filter((c) => c.resumeUse).map(formatClaimForPrompt),
  };

  return JSON.stringify(input, null, 2);
}

/**
 * Call LLM once to compose a structured ResumeDraft from curated project data.
 * Uses a single generateObject call — no iterative loops beyond schema retries.
 */
export async function composeDraft(
  llmConfig: LlmConfig,
  login: string,
  curateResult: CurateResult,
  options: ComposeOptions,
): Promise<ResumeDraft> {
  const topN = options.topN ?? 6;
  const topProjects = curateResult.projects.slice(0, topN);
  const otherProjects = curateResult.projects.slice(topN);

  const systemPromptBase = await loadPrompt("compose", options.lang);
  const system = `${systemPromptBase}\n\n${OUTPUT_SCHEMA_DESCRIPTION}`;
  const user = buildUserPrompt(login, topProjects, otherProjects, curateResult.claims, options);

  const llmOutput = await generateObject(llmConfig, ComposeLlmOutputSchema, system, user);

  const draft: ResumeDraft = {
    version: 1,
    generatedAt: new Date().toISOString(),
    login,
    ...llmOutput,
    evidenceMap: Object.fromEntries(
      llmOutput.selectedProjects.map((sp) => {
        const project = curateResult.projects.find((p) => p.id === sp.projectId);
        return [sp.projectId, project?.evidenceEntryIds ?? []];
      }),
    ),
  };

  return draft;
}
