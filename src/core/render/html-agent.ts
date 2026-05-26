import { generateText } from "../llm.ts";
import { loadPrompt } from "../prompts.ts";
import type { ResumeDraft } from "../schema/agent.ts";
import type { LlmConfig } from "../schema/config.ts";
import { stripMarkdownFences } from "./validate.ts";

function formatDraftForRender(draft: ResumeDraft): string {
  return JSON.stringify(
    {
      login: draft.login,
      headline: draft.headline,
      summary: draft.summary,
      skills: draft.skills,
      selectedProjects: draft.selectedProjects.map((p) => ({
        title: p.title,
        period: `${p.period.from.slice(0, 7)} – ${p.period.to.slice(0, 7)}`,
        stack: p.stack,
        bullets: p.bullets,
      })),
      otherExperience: draft.otherExperience,
    },
    null,
    2,
  );
}

/**
 * Generate a fully custom HTML resume using the LLM.
 *
 * @param llmConfig  - LLM provider configuration
 * @param draft      - Structured resume draft (content to render)
 * @param instruction - Visual style instruction, e.g. "深色极简风格，适合 AI 工程师个人站"
 * @param lang       - Prompt language
 * @returns Self-contained HTML string
 */
export async function renderResumeDraftHtmlAgent(
  llmConfig: LlmConfig,
  draft: ResumeDraft,
  instruction: string,
  lang: "zh" | "en",
): Promise<string> {
  const systemPromptBase = await loadPrompt("render-agent", lang);

  const system = systemPromptBase;
  const user = `Resume data:

${formatDraftForRender(draft)}

Design instruction: ${instruction}`;

  const raw = await generateText(llmConfig, system, user);
  return stripMarkdownFences(raw);
}
