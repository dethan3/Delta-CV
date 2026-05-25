import { z } from "zod";
import { generateObject } from "../llm.ts";
import { loadPrompt } from "../prompts.ts";
import type { LlmConfig } from "../schema/config.ts";
import type { ProjectNarrative } from "../schema/narrative.ts";
import type { ResumePlan } from "../schema/plan.ts";
import {
  ProjectSectionSchema,
  SkillGroupSchema,
  type ProjectSection,
  type ResumeDraft,
} from "../schema/agent.ts";

export interface ComposeOptions {
  lang: "zh" | "en";
  targetRole?: string;
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
- selectedProjects.projectId MUST exactly match one of plan.selectedProjectIds.
- Preserve the plan's project order; do not reorder selectedProjects.
- Do not invent projects, technologies, or metrics not present in the input.
`;

const MAX_HEADLINE_WORDS = 25;
const MAX_SUMMARY_SENTENCES = 4;
const LOW_SIGNAL_METRIC_RE =
  /\bwith\s+\d[\d,]*(?:\.\d+)?\s+lines?\s+of\s+(?:new\s+)?code\b|\b\d[\d,]*(?:\.\d+)?\s+lines?\s+of\s+(?:new\s+)?code\b/i;

function formatSelectedNarrativeForPrompt(n: ProjectNarrative): object {
  return {
    projectId: n.projectKey,
    title: n.title,
    period: `${n.period.from.slice(0, 10)} → ${n.period.to.slice(0, 10)}`,
    candidateRole: n.candidateRole,
    scope: n.scope,
    coreProblem: n.coreProblem,
    solutionShape: n.solutionShape,
    proofPoints: n.proofPoints.map((pp) => ({
      text: pp.text,
      kind: pp.kind,
      strength: pp.strength,
      evidenceRefs: pp.evidenceRefs,
    })),
    techStack: n.techStack,
    strengthSignals: n.strengthSignals,
    riskFlags: n.riskFlags,
    repos: n.repos,
  };
}

function formatOtherNarrativeForPrompt(n: ProjectNarrative): object {
  return {
    projectId: n.projectKey,
    title: n.title,
    period: `${n.period.from.slice(0, 10)} → ${n.period.to.slice(0, 10)}`,
    scope: n.scope,
    candidateRole: n.candidateRole,
    techStack: n.techStack,
    repos: n.repos,
  };
}

function buildUserPrompt(
  login: string,
  plan: ResumePlan,
  selectedNarratives: ProjectNarrative[],
  otherNarratives: ProjectNarrative[],
  options: ComposeOptions,
): string {
  const input = {
    candidate: login,
    language: options.lang,
    plan: {
      positioning: plan.positioning,
      targetRole: options.targetRole ?? plan.targetRole ?? null,
      selectedProjectIds: plan.selectedProjectIds,
      selectionRationale: plan.selectionRationale,
      skillEmphasis: plan.skillEmphasis,
      styleHints: plan.styleHints,
      jdSlug: plan.jdSlug ?? null,
    },
    selectedNarratives: selectedNarratives.map(formatSelectedNarrativeForPrompt),
    otherNarratives: otherNarratives.map(formatOtherNarrativeForPrompt),
  };

  return JSON.stringify(input, null, 2);
}

function buildEvidenceMap(selectedNarratives: ProjectNarrative[]): Record<string, string[]> {
  return Object.fromEntries(
    selectedNarratives.map((n) => [
      n.projectKey,
      Array.from(
        new Set([
          ...n.sourceEvidenceIds,
          ...n.proofPoints.flatMap((pp) => pp.evidenceRefs),
        ]),
      ),
    ]),
  );
}

function buildFallbackProjectSection(n: ProjectNarrative): ProjectSection {
  return {
    projectId: n.projectKey,
    title: n.title,
    period: n.period,
    bullets: n.proofPoints.slice(0, 3).map((pp) => pp.text),
    stack: n.techStack,
  };
}

function trimSentence(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function normalizeHeadline(headline: string, plan: ResumePlan, lang: "zh" | "en"): string {
  const raw = trimSentence(headline);
  if (lang === "zh") {
    return raw.length <= 40 ? raw : raw.slice(0, 40).trim();
  }

  const words = raw.split(/\s+/).filter((word) => word.length > 0);
  if (words.length <= MAX_HEADLINE_WORDS) return raw;

  const planWords = trimSentence(plan.positioning).split(/\s+/).filter((word) => word.length > 0);
  const source = planWords.length > 0 ? planWords : words;
  return source.slice(0, MAX_HEADLINE_WORDS).join(" ");
}

function normalizeSummary(summary: string, headline: string): string {
  const normalized = summary.replace(/\s+/g, " ").trim();
  const parts = normalized
    .split(/(?<=[.!?。！？])\s+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

  const out: string[] = [];
  for (const part of parts) {
    if (out.length === 0 && trimSentence(part).toLowerCase() === trimSentence(headline).toLowerCase()) {
      continue;
    }
    out.push(part);
    if (out.length >= MAX_SUMMARY_SENTENCES) break;
  }

  if (out.length === 0) return normalized;
  return out.join(" ");
}

function rewriteLowSignalMetricBullet(bullet: string): string {
  const rewritten = bullet
    .replace(/\s*,?\s*with\s+\d[\d,]*(?:\.\d+)?\s+lines?\s+of\s+(?:new\s+)?code\b/gi, "")
    .replace(/\b\d[\d,]*(?:\.\d+)?\s+lines?\s+of\s+(?:new\s+)?code\b/gi, "substantial implementation work")
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([,.])/g, "$1")
    .trim();
  return rewritten.length > 0 ? rewritten : bullet;
}

function normalizeBullets(bullets: string[]): string[] {
  return bullets.map((bullet) => {
    if (LOW_SIGNAL_METRIC_RE.test(bullet)) {
      return rewriteLowSignalMetricBullet(bullet);
    }
    return bullet;
  });
}

/**
 * Call LLM once to compose a structured ResumeDraft from ResumePlan +
 * ProjectNarrative[].
 * Uses a single generateObject call — no iterative loops beyond schema retries.
 */
export async function composeDraft(
  llmConfig: LlmConfig,
  login: string,
  plan: ResumePlan,
  narratives: ProjectNarrative[],
  options: ComposeOptions,
): Promise<ResumeDraft> {
  const narrativesById = new Map(narratives.map((n) => [n.projectKey, n]));
  const selectedNarratives = plan.selectedProjectIds
    .map((id) => narrativesById.get(id))
    .filter((n): n is ProjectNarrative => Boolean(n));

  if (selectedNarratives.length === 0) {
    throw new Error("compose: plan.selectedProjectIds does not match any available narratives.");
  }

  const selectedIds = new Set(plan.selectedProjectIds);
  const otherNarratives = narratives.filter((n) => !selectedIds.has(n.projectKey));

  const systemPromptBase = await loadPrompt("compose", options.lang);
  const system = `${systemPromptBase}\n\n${OUTPUT_SCHEMA_DESCRIPTION}`;
  const user = buildUserPrompt(login, plan, selectedNarratives, otherNarratives, options);

  const llmOutput = await generateObject(llmConfig, ComposeLlmOutputSchema, system, user);
  const modelSections = new Map(
    llmOutput.selectedProjects.map((section) => [section.projectId, section]),
  );
  const selectedProjects = selectedNarratives.map((n) => {
    const section = modelSections.get(n.projectKey);
    if (!section) return buildFallbackProjectSection(n);
    const stack = section.stack.filter((item) => n.techStack.includes(item));
    return {
      projectId: n.projectKey,
      title: section.title || n.title,
      period: n.period,
      bullets: normalizeBullets(section.bullets.slice(0, 3)),
      stack: stack.length > 0 ? stack : n.techStack,
    };
  });
  const headline = normalizeHeadline(llmOutput.headline, plan, options.lang);
  const summary = normalizeSummary(llmOutput.summary, headline);

  const draft: ResumeDraft = {
    version: 1,
    generatedAt: new Date().toISOString(),
    login,
    ...llmOutput,
    headline,
    summary,
    selectedProjects,
    evidenceMap: buildEvidenceMap(selectedNarratives),
  };

  return draft;
}
