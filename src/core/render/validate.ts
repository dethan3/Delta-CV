import type { ResumeDraft } from "../schema/agent.ts";

export interface HtmlValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

/**
 * Validate that agent-generated HTML satisfies structural and content requirements.
 *
 * Errors (hard failures, should block or warn strongly):
 *   - Missing DOCTYPE
 *   - No inline <style> tag (external assets detected)
 *   - Missing @media print
 *   - Missing headline content
 *   - Missing required project titles
 *
 * Warnings (soft issues):
 *   - External font/CDN links detected
 *   - Missing @media (max-width …) responsive rule
 *   - otherExperience items not found in output
 */
export function validateGeneratedHtml(html: string, draft: ResumeDraft): HtmlValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!html.includes("<!DOCTYPE html") && !html.includes("<!doctype html")) {
    errors.push("Missing <!DOCTYPE html> declaration.");
  }

  if (!html.includes("<style")) {
    errors.push("No <style> tag found — HTML is not self-contained.");
  }

  if (/<link[^>]+rel=["']stylesheet["']/i.test(html)) {
    errors.push("External stylesheet <link> detected — HTML must be self-contained.");
  }

  if (/src=["']https?:\/\//i.test(html)) {
    errors.push("External script or asset src detected — no remote assets allowed.");
  }

  if (/fonts\.googleapis\.com/i.test(html)) {
    warnings.push("Google Fonts URL detected — should use system font stacks only.");
  }

  if (!html.includes("@media print")) {
    errors.push("Missing @media print CSS.");
  }

  if (!html.includes("@media")) {
    warnings.push("No @media query detected — responsive layout may be missing.");
  } else if (!/@media\s*\([^)]*max-width/i.test(html)) {
    warnings.push("No max-width media query found — mobile layout may be missing.");
  }

  const headlineWords = draft.headline.split(/\s+/).slice(0, 4).join(" ");
  const headlineWordsEscaped = headlineWords
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  if (!html.includes(draft.login)) {
    errors.push(`Login "${draft.login}" not found in HTML output.`);
  }
  if (!html.includes(headlineWords) && !html.includes(headlineWordsEscaped)) {
    errors.push(`Headline content ("${headlineWords}…") not found in HTML output.`);
  }

  for (const project of draft.selectedProjects) {
    const titleWords = project.title.split(/\s+/).slice(0, 3).join(" ");
    if (!html.includes(titleWords)) {
      errors.push(`Project title "${project.title}" not found in HTML output.`);
    }
    for (const bullet of project.bullets) {
      const fragment = bullet.slice(0, 30);
      if (!html.includes(fragment)) {
        warnings.push(`Project bullet not found in output: "${fragment}…"`);
      }
    }
  }

  if (draft.otherExperience.length > 0) {
    const firstItem = draft.otherExperience[0];
    if (firstItem) {
      const fragment = firstItem.slice(0, 20);
      if (!html.includes(fragment)) {
        warnings.push(`otherExperience content may be missing: "${fragment}…"`);
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * Strip markdown code fences if the LLM wrapped the HTML output.
 * Handles ```html ... ``` and ``` ... ``` wrappers.
 */
export function stripMarkdownFences(raw: string): string {
  const trimmed = raw.trim();
  const match = trimmed.match(/^```(?:html)?\s*\n([\s\S]*?)\n```\s*$/i);
  if (match?.[1]) return match[1].trim();
  return trimmed;
}
