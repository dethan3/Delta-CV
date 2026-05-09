import type { ExperienceEntry } from "../schema/experience.ts";
import type { FocusItem } from "../schema/snapshot.ts";

const TREND_THRESHOLD = 0.04;

/**
 * Build a tag frequency map from a list of experience entries.
 * Each tag occurrence across all highlights and the top-level tags array is counted.
 */
export function buildTagFrequency(entries: ExperienceEntry[]): Map<string, number> {
  const freq = new Map<string, number>();
  for (const entry of entries) {
    for (const tag of entry.tags) {
      freq.set(tag, (freq.get(tag) ?? 0) + 1);
    }
    for (const h of entry.highlights) {
      for (const tag of h.tags) {
        freq.set(tag, (freq.get(tag) ?? 0) + 1);
      }
    }
  }
  return freq;
}

/**
 * Compute normalised focus scores and rising/stable/declining trends.
 * Results are sorted by score descending.
 * Accepts string keys (not the strict Tag union) so LLM-generated tags are included.
 * @param threshold - Normalised score delta required to call a tag rising/declining (default 0.04).
 */
export function computeFocus(
  tagFrequency: Map<string, number>,
  previousTagFrequency?: Map<string, number>,
  threshold = 0.04,
): FocusItem[] {
  const total = [...tagFrequency.values()].reduce((a, b) => a + b, 0);
  if (total === 0) return [];

  const prevTotal = previousTagFrequency
    ? [...previousTagFrequency.values()].reduce((a, b) => a + b, 0)
    : 0;

  const items: FocusItem[] = [];
  for (const [tag, count] of tagFrequency) {
    const score = count / total;
    const prevCount = previousTagFrequency?.get(tag) ?? 0;
    const prevScore = prevTotal > 0 ? prevCount / prevTotal : 0;
    const delta = score - prevScore;
    const trend: FocusItem["trend"] =
      delta > threshold ? "rising" : delta < -threshold ? "declining" : "stable";
    items.push({ tag, score, trend });
  }

  return items.sort((a, b) => b.score - a.score);
}
