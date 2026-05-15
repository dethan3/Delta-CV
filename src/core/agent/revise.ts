import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { generateObject } from "../llm.ts";
import { loadPrompt } from "../prompts.ts";
import type { LlmConfig } from "../schema/config.ts";
import {
  ProjectSectionSchema,
  ResumeDraftSchema,
  SkillGroupSchema,
  type ResumeDraft,
  type RevisionRecord,
} from "../schema/agent.ts";
import { z } from "zod";

const ReviseLlmOutputSchema = z.object({
  headline: z.string().min(1),
  summary: z.string().min(1),
  skills: z.array(SkillGroupSchema),
  selectedProjects: z.array(ProjectSectionSchema),
  otherExperience: z.array(z.string()),
});

const OUTPUT_SCHEMA_DESCRIPTION = `
Output ONLY valid JSON (no markdown fences) matching this exact schema:
{
  "headline": "string",
  "summary": "string",
  "skills": [{ "category": "string", "items": ["string"] }],
  "selectedProjects": [
    {
      "projectId": "string",
      "title": "string",
      "period": { "from": "ISO date string", "to": "ISO date string" },
      "bullets": ["string"],
      "stack": ["string"]
    }
  ],
  "otherExperience": ["string"]
}
Return the COMPLETE revised resume. Do not omit any field.
All projectId values must exactly match those in the input draft.
`;

function formatDraftForRevise(draft: ResumeDraft): string {
  return JSON.stringify(
    {
      headline: draft.headline,
      summary: draft.summary,
      skills: draft.skills,
      selectedProjects: draft.selectedProjects,
      otherExperience: draft.otherExperience,
    },
    null,
    2,
  );
}

/** Strip any trailing -rev-N or -rev-<text> suffix to get the original base slug. */
function stripRevSuffix(slug: string): string {
  return slug.replace(/-rev(-\d+|-[\w-]+)?$/, "").replace(/-rev-.*$/, "");
}

/**
 * Derive a short counter-based revision slug: <originalBase>-rev-1, -rev-2, …
 * Scans data/resumes/ to find the next unused number.
 */
async function makeRevisionSlug(dataDir: string, baseSlug: string): Promise<string> {
  const originalBase = stripRevSuffix(baseSlug);
  let files: string[] = [];
  try {
    files = await readdir(join(dataDir, "resumes"));
  } catch {
    // resumes dir may not exist yet
  }
  const pattern = new RegExp(`^${originalBase}-rev-(\\d+)\\.(html|md|json)$`);
  let maxN = 0;
  for (const f of files) {
    const m = pattern.exec(f);
    if (m) maxN = Math.max(maxN, Number(m[1]));
  }
  return `${originalBase}-rev-${maxN + 1}`;
}

/**
 * Revise a ResumeDraft according to a user instruction.
 * Returns a RevisionRecord containing the new draft and provenance metadata.
 */
export async function reviseDraft(
  llmConfig: LlmConfig,
  draft: ResumeDraft,
  draftSlug: string,
  instruction: string,
  lang: "zh" | "en",
  dataDir = "data",
): Promise<RevisionRecord> {
  const systemPromptBase = await loadPrompt("revise", lang);
  const system = `${systemPromptBase}\n\n${OUTPUT_SCHEMA_DESCRIPTION}`;
  const user = `Current resume draft:\n\n${formatDraftForRevise(draft)}\n\nRevision instruction: ${instruction}`;

  const llmOutput = await generateObject(llmConfig, ReviseLlmOutputSchema, system, user);

  const newSlug = await makeRevisionSlug(dataDir, draftSlug);
  const newDraft: ResumeDraft = {
    version: (draft.version ?? 1) + 1,
    generatedAt: new Date().toISOString(),
    login: draft.login,
    ...llmOutput,
    evidenceMap: draft.evidenceMap,
    ...(draft.styleNotes ? { styleNotes: draft.styleNotes } : {}),
  };

  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    slug: newSlug,
    instruction,
    previousDraftSlug: draftSlug,
    draft: newDraft,
  };
}

export { makeRevisionSlug, stripRevSuffix };
