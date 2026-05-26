import { readFile } from "node:fs/promises";
import { basename, extname, resolve } from "node:path";
import { Eta } from "eta";
import { loadAsset } from "../io/assets.ts";
import type { ResumeDraft } from "../schema/agent.ts";
import { buildResumeTemplateData } from "./template-data.ts";
import { esc } from "./utils.ts";

const eta = new Eta({ autoEscape: false });

export interface TemplateRenderResult {
  html: string;
  templateName: string;
}

function normalizeTemplateName(pathLike: string): string {
  return basename(pathLike, extname(pathLike)).replace(/\.html$/i, "");
}

export async function renderBuiltInHtmlTemplate(
  draft: ResumeDraft,
  templateAssetPath: string,
): Promise<TemplateRenderResult> {
  const template = await loadAsset(templateAssetPath);
  return {
    html: renderTemplateString(template, draft),
    templateName: normalizeTemplateName(templateAssetPath),
  };
}

export async function renderCustomHtmlTemplate(
  draft: ResumeDraft,
  templatePath: string,
): Promise<TemplateRenderResult> {
  const resolvedPath = resolve(templatePath);
  const template = await readFile(resolvedPath, "utf8");
  return {
    html: renderTemplateString(template, draft),
    templateName: normalizeTemplateName(resolvedPath),
  };
}

function renderTemplateString(template: string, draft: ResumeDraft): string {
  const view = buildResumeTemplateData(draft);
  return eta.renderString(template, {
    draft,
    view,
    esc,
  });
}
