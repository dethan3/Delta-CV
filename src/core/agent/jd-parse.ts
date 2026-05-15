import { z } from "zod";
import { generateObject } from "../llm.ts";
import { loadPrompt } from "../prompts.ts";
import type { LlmConfig } from "../schema/config.ts";
import { JdSenioritySchema, type JdProfile } from "../schema/agent.ts";

const JdParseOutputSchema = z.object({
  jobTitle: z.string(),
  seniority: JdSenioritySchema,
  requiredSkills: z.array(z.string()),
  niceToHaveSkills: z.array(z.string()),
  keyResponsibilities: z.array(z.string()),
  targetProfile: z.string(),
});

/**
 * Derive a URL-safe slug from a job title.
 * E.g. "Senior AI Engineer" → "jd-senior-ai-engineer"
 */
export function makeJdSlug(jobTitle: string): string {
  return (
    "jd-" +
    jobTitle
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, "")
      .trim()
      .replace(/\s+/g, "-")
      .slice(0, 40)
  );
}

/**
 * Parse a raw JD text into a structured JdProfile using the LLM.
 */
export async function parseJdProfile(
  llmConfig: LlmConfig,
  jdText: string,
  lang: "zh" | "en",
): Promise<JdProfile> {
  const systemPrompt = await loadPrompt("jd-parse", lang);

  const parsed = await generateObject(
    llmConfig,
    JdParseOutputSchema,
    systemPrompt,
    `Job description to parse:\n\n${jdText}`,
  );

  const slug = makeJdSlug(parsed.jobTitle);

  return {
    version: 1,
    parsedAt: new Date().toISOString(),
    slug,
    ...parsed,
  };
}
