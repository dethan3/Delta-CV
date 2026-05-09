import { Eta } from "eta";
import { loadAsset } from "../io/assets.ts";
import type { ExperienceLog } from "../schema/experience.ts";
import type { FocusItem } from "../schema/snapshot.ts";

export interface RenderOptions {
  language: "zh" | "en" | "bilingual";
  templateName?: string | undefined;
  login?: string | undefined;
  focus?: FocusItem[] | undefined;
  topTags?: string[] | undefined;
}

const eta = new Eta({ autoEscape: false });

/** Render an experience log to Markdown using an Eta template. */
export async function renderResume(log: ExperienceLog, options: RenderOptions): Promise<string> {
  const templateName = options.templateName ?? `resume.${options.language}.md.eta`;
  const template = await loadAsset(`resume-templates/${templateName}`);

  const focusRising = options.focus?.filter((f) => f.trend === "rising").map((f) => f.tag) ?? [];
  const focusDeclining =
    options.focus?.filter((f) => f.trend === "declining").map((f) => f.tag) ?? [];

  const data = {
    login: options.login ?? "developer",
    generatedAt: log.generatedAt,
    entries: log.entries,
    topTags: options.topTags ?? [],
    focusRising,
    focusDeclining,
  };

  return eta.renderString(template, data);
}
