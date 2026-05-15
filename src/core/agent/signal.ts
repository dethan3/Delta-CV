import type { ExperienceEntry, Highlight } from "../schema/experience.ts";

const WEAK_TITLE_PATTERNS = [
  /^chore[:(]/i,
  /^deps[:(]/i,
  /^build[:(]/i,
  /^ci[:(]/i,
  /\bbump\b/i,
  /\bupgrade\b.*\bdependenc/i,
  /\bupdate\b.*\bdependenc/i,
  /\brenovate\b/i,
  /\btypo\b/i,
  /\bfix lint\b/i,
  /\bfix format\b/i,
  /\bprettier\b/i,
  /\beslint\b/i,
  /\badd\.gitignore\b/i,
  /^initial commit/i,
  /^init(ial)? repo/i,
  /\bupdate readme\b/i,
  /\badd readme\b/i,
];

const STRONG_TITLE_PATTERNS = [
  /^feat[:(]/i,
  /^feature[:(]/i,
  /^refactor[:(]/i,
  /^perf[:(]/i,
  /\bimplement\b/i,
  /\barchitect\b/i,
  /\bmigrat\b/i,
  /\bintegrat\b/i,
  /\boptimiz\b/i,
  /\bscale\b/i,
  /\bdeploy\b/i,
  /\blaunch\b/i,
  /\bship\b/i,
];

const STRONG_TAGS = new Set([
  "architecture",
  "refactor",
  "performance",
  "api",
  "feature",
  "system-design",
  "migration",
  "integration",
  "deploy",
  "testing",
  "security",
  "ai",
  "llm",
  "agent",
  "open-source",
]);

export interface SignalResult {
  isWeak: boolean;
  isStrong: boolean;
  reason: string;
}

/** Classify a single highlight as strong, weak, or neutral. */
export function classifyHighlight(highlight: Highlight): SignalResult {
  const text = highlight.text.toLowerCase();

  for (const pattern of WEAK_TITLE_PATTERNS) {
    if (pattern.test(text)) {
      return { isWeak: true, isStrong: false, reason: `matches weak pattern: ${pattern.source}` };
    }
  }

  const hasStrongTag = highlight.tags.some((t) => STRONG_TAGS.has(t.toLowerCase()));
  if (hasStrongTag) {
    return { isWeak: false, isStrong: true, reason: "has strong capability tag" };
  }

  for (const pattern of STRONG_TITLE_PATTERNS) {
    if (pattern.test(text)) {
      return { isWeak: false, isStrong: true, reason: `matches strong pattern: ${pattern.source}` };
    }
  }

  return { isWeak: false, isStrong: false, reason: "neutral" };
}

export interface EntrySummary {
  strongCount: number;
  weakCount: number;
  neutralCount: number;
  signalScore: number;
  strongHighlights: Highlight[];
  weakTexts: string[];
}

/**
 * Analyse the highlights of a single ExperienceEntry.
 * signalScore = strongCount / max(totalCount, 1), in range [0, 1].
 */
export function analyseEntrySignals(entry: ExperienceEntry): EntrySummary {
  let strongCount = 0;
  let weakCount = 0;
  let neutralCount = 0;
  const strongHighlights: Highlight[] = [];
  const weakTexts: string[] = [];

  for (const h of entry.highlights) {
    const result = classifyHighlight(h);
    if (result.isWeak) {
      weakCount++;
      weakTexts.push(h.text);
    } else if (result.isStrong) {
      strongCount++;
      strongHighlights.push(h);
    } else {
      neutralCount++;
      strongHighlights.push(h);
    }
  }

  const total = entry.highlights.length;
  const signalScore = total === 0 ? 0 : (strongCount + neutralCount * 0.5) / total;

  return { strongCount, weakCount, neutralCount, signalScore, strongHighlights, weakTexts };
}

/**
 * Compute the aggregate signal score across all entries of a project.
 * Returns a value in [0, 1].
 */
export function computeProjectSignalScore(entries: ExperienceEntry[]): number {
  if (entries.length === 0) return 0;
  const scores = entries.map((e) => analyseEntrySignals(e).signalScore);
  return scores.reduce((a, b) => a + b, 0) / scores.length;
}
