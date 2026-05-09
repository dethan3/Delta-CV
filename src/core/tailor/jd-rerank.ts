import type { ExperienceEntry } from "../schema/experience.ts";

/** Common stopwords to exclude from JD keyword extraction. */
const STOPWORDS = new Set([
  "a",
  "an",
  "the",
  "and",
  "or",
  "but",
  "in",
  "on",
  "at",
  "to",
  "for",
  "of",
  "with",
  "by",
  "from",
  "as",
  "is",
  "was",
  "are",
  "were",
  "be",
  "been",
  "being",
  "have",
  "has",
  "had",
  "do",
  "does",
  "did",
  "will",
  "would",
  "could",
  "should",
  "may",
  "might",
  "this",
  "that",
  "these",
  "those",
  "it",
  "its",
  "we",
  "our",
  "you",
  "your",
  "they",
  "their",
  "he",
  "she",
  "his",
  "her",
  "not",
  "no",
  "all",
  "each",
  "every",
  "both",
  "few",
  "more",
  "most",
  "other",
  "some",
  "such",
  "than",
  "too",
  "very",
  "can",
  "just",
  "about",
  "above",
  "after",
  "again",
  "also",
  "any",
  "because",
  "before",
  "between",
  "come",
  "day",
  "get",
  "go",
  "here",
  "how",
  "if",
  "into",
  "know",
  "like",
  "make",
  "many",
  "much",
  "new",
  "now",
  "old",
  "only",
  "our",
  "out",
  "over",
  "own",
  "part",
  "put",
  "same",
  "see",
  "so",
  "still",
  "take",
  "tell",
  "there",
  "think",
  "time",
  "up",
  "us",
  "want",
  "way",
  "well",
  "what",
  "when",
  "which",
  "who",
  "why",
  "work",
  "year",
  "experience",
  "working",
  "team",
  "role",
  "position",
  "job",
  "looking",
  "strong",
  "good",
  "great",
  "excellent",
  "ability",
  "skills",
  "knowledge",
  // Chinese common words
  "的",
  "了",
  "和",
  "是",
  "在",
  "有",
  "与",
  "及",
  "或",
  "等",
  "能",
  "对",
  "从",
  "到",
  "也",
  "就",
  "要",
  "会",
  "可以",
  "我们",
  "你",
  "他",
  "她",
  "它",
  "这",
  "那",
]);

/** Extract meaningful keywords from JD text. */
function extractKeywords(jdText: string): string[] {
  const tokens = jdText
    .toLowerCase()
    .replace(/[^\w一-鿿]+/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t));
  return [...new Set(tokens)];
}

/** Score an entry against JD keywords. Higher = more relevant. */
function scoreEntry(entry: ExperienceEntry, keywords: string[]): number {
  let score = 0;
  // Build a text corpus from the entry
  const entryText = [
    entry.title,
    entry.repo,
    ...entry.stack,
    ...entry.tags,
    ...entry.highlights.map((h) => h.text),
    ...entry.highlights.flatMap((h) => h.tags),
  ]
    .join(" ")
    .toLowerCase();

  for (const kw of keywords) {
    if (entryText.includes(kw)) {
      score += 1;
    }
  }
  return score;
}

/** Rerank experience entries by relevance to a job description. No LLM involved. */
export function rerankByJd(entries: ExperienceEntry[], jdText: string): ExperienceEntry[] {
  const keywords = extractKeywords(jdText);
  if (keywords.length === 0) return entries;

  const scored = entries.map((entry) => ({
    entry,
    score: scoreEntry(entry, keywords),
  }));

  scored.sort((a, b) => b.score - a.score);
  return scored.map((s) => s.entry);
}

/** Derive a URL-safe slug from a JD title or first line. */
export function slugifyJd(jdText: string): string {
  const slug = jdText
    .trim()
    .split(/\n/)[0]
    ?.toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "-")
    .slice(0, 60);
  return slug && slug.length > 0 ? slug : "jd";
}
