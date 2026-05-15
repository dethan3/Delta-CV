import type { ResumeDraft } from "../schema/agent.ts";
import { renderResumeDraftHtml } from "./html-clean.ts";
import { renderResumeDraftHtmlCompact } from "./html-compact.ts";
import { renderResumeDraftHtmlDeveloper } from "./html-developer.ts";

/** Static (no-LLM) style names. */
export type StaticHtmlStyle = "clean" | "developer" | "compact";

/** All supported style names, including the LLM-driven "agent" style. */
export type HtmlStyle = StaticHtmlStyle | "agent";

export interface StyleMeta {
  name: HtmlStyle;
  description: string;
  /** Only present for static styles. */
  renderer?: (draft: ResumeDraft) => string;
}

export const HTML_STYLES: Record<HtmlStyle, StyleMeta> = {
  clean: {
    name: "clean",
    description: "Dense, ATS-friendly, restrained visual style. Good default.",
    renderer: renderResumeDraftHtml,
  },
  developer: {
    name: "developer",
    description: "Monospace accents, badge tags, left-border cards. Technical aesthetic.",
    renderer: renderResumeDraftHtmlDeveloper,
  },
  compact: {
    name: "compact",
    description: "Serif font, tight spacing, two-column skills. Print-optimised single page.",
    renderer: renderResumeDraftHtmlCompact,
  },
  agent: {
    name: "agent",
    description:
      "LLM-generated custom style. Requires --instruction. E.g. --instruction '深色极简风格'.",
  },
};

export const HTML_STYLE_NAMES = Object.keys(HTML_STYLES) as HtmlStyle[];

export function isHtmlStyle(s: string): s is HtmlStyle {
  return s in HTML_STYLES;
}

export function isStaticStyle(s: HtmlStyle): s is StaticHtmlStyle {
  return s !== "agent";
}

/**
 * Render a ResumeDraft using a static (non-LLM) HTML style.
 * Throws for "agent" style — use renderResumeDraftHtmlAgent() instead.
 */
export function renderWithStyle(draft: ResumeDraft, style: StaticHtmlStyle): string {
  const meta = HTML_STYLES[style];
  if (!meta.renderer) {
    throw new Error(`Style "${style}" has no static renderer.`);
  }
  return meta.renderer(draft);
}
