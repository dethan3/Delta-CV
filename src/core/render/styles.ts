/** Static (no-LLM) style names. */
export type StaticHtmlStyle = "clean" | "developer" | "compact";

/** All supported style names, including the LLM-driven "agent" style. */
export type HtmlStyle = StaticHtmlStyle | "agent";

export interface StyleMeta {
  name: HtmlStyle;
  description: string;
  /** Built-in Eta template asset path for static styles. */
  templateAssetPath?: string;
}

export const HTML_STYLES: Record<HtmlStyle, StyleMeta> = {
  clean: {
    name: "clean",
    description: "Dense, ATS-friendly, restrained visual style. Good default.",
    templateAssetPath: "html-templates/clean.eta",
  },
  developer: {
    name: "developer",
    description: "Monospace accents, badge tags, left-border cards. Technical aesthetic.",
    templateAssetPath: "html-templates/developer.eta",
  },
  compact: {
    name: "compact",
    description: "Serif font, tight spacing, two-column skills. Print-optimised single page.",
    templateAssetPath: "html-templates/compact.eta",
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
