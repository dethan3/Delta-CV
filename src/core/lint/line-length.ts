import type { LintViolation } from "./banned-words.ts";

/** Check that no bullet line in a Markdown resume exceeds maxLen chars. */
export function checkLineLength(markdown: string, maxLen = 120): LintViolation[] {
  const violations: LintViolation[] = [];
  const lines = markdown.split("\n");
  for (const [i, line] of lines.entries()) {
    if (line.length > maxLen) {
      violations.push({ line: i + 1, col: maxLen + 1, word: line.slice(maxLen, maxLen + 20) });
    }
  }
  return violations;
}

export interface StructuralViolation {
  section: string;
  issue: string;
}

/**
 * Check structural limits on a parsed resume:
 * - Each highlight (bullet) must not exceed maxHighlightLines lines.
 * - Each project section must not exceed maxHighlightsPerProject highlights.
 */
export function checkHighlightLimits(
  markdown: string,
  maxHighlightLines = 2,
  maxHighlightsPerProject = 4,
): StructuralViolation[] {
  const violations: StructuralViolation[] = [];
  const lines = markdown.split("\n");

  let currentSection = "";
  let highlightCount = 0;
  let highlightLineCount = 0;
  let inHighlight = false;

  for (const rawLine of lines) {
    const line = rawLine;

    // Detect section headers (## Project Name)
    if (line.startsWith("## ")) {
      // Close previous section
      if (inHighlight && highlightLineCount > maxHighlightLines) {
        violations.push({
          section: currentSection,
          issue: `highlight exceeds ${maxHighlightLines} lines (${highlightLineCount} lines)`,
        });
      }
      if (highlightCount > maxHighlightsPerProject) {
        violations.push({
          section: currentSection,
          issue: `too many highlights (${highlightCount}, max ${maxHighlightsPerProject})`,
        });
      }
      currentSection = line.slice(3).trim();
      highlightCount = 0;
      inHighlight = false;
      highlightLineCount = 0;
      continue;
    }

    // Detect bullet lines (- text)
    if (line.startsWith("- ")) {
      // Close previous highlight
      if (inHighlight && highlightLineCount > maxHighlightLines) {
        violations.push({
          section: currentSection,
          issue: `highlight exceeds ${maxHighlightLines} lines (${highlightLineCount} lines)`,
        });
      }
      highlightCount += 1;
      inHighlight = true;
      highlightLineCount = 1;
      continue;
    }

    // Continuation of a highlight (indented or wrapped)
    if (inHighlight && line.trim().length > 0) {
      highlightLineCount += 1;
    } else if (inHighlight && line.trim().length === 0) {
      // Empty line ends the highlight
      if (highlightLineCount > maxHighlightLines) {
        violations.push({
          section: currentSection,
          issue: `highlight exceeds ${maxHighlightLines} lines (${highlightLineCount} lines)`,
        });
      }
      inHighlight = false;
      highlightLineCount = 0;
    }
  }

  // Check last section
  if (inHighlight && highlightLineCount > maxHighlightLines) {
    violations.push({
      section: currentSection,
      issue: `highlight exceeds ${maxHighlightLines} lines (${highlightLineCount} lines)`,
    });
  }
  if (highlightCount > maxHighlightsPerProject) {
    violations.push({
      section: currentSection,
      issue: `too many highlights (${highlightCount}, max ${maxHighlightsPerProject})`,
    });
  }

  return violations;
}
