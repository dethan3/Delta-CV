import { createHash } from "node:crypto";
import type { ExperienceLog } from "../schema/experience.ts";
import type { FocusItem } from "../schema/snapshot.ts";
import type { Snapshot, SnapshotDiff } from "../schema/snapshot.ts";

/**
 * Build a Snapshot from the experience log and pre-computed focus items.
 * The checksum is a short SHA-256 of the serialised log for change detection.
 * tagFrequency is stored verbatim so the next evolve run can compute accurate trends.
 */
export function buildSnapshot(
  log: ExperienceLog,
  date: string,
  focus: FocusItem[],
  tagFrequency: Map<string, number>,
  topTagsLimit = 20,
): Snapshot {
  // Aggregate tag frequencies across all entries
  const freq = new Map<string, number>();
  for (const entry of log.entries) {
    for (const tag of entry.tags) freq.set(tag, (freq.get(tag) ?? 0) + 1);
    for (const h of entry.highlights) {
      for (const tag of h.tags) freq.set(tag, (freq.get(tag) ?? 0) + 1);
    }
  }

  const topTags = [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, topTagsLimit)
    .map(([tag]) => tag);

  const experienceLogChecksum = createHash("sha256")
    .update(JSON.stringify(log))
    .digest("hex")
    .slice(0, 16);

  const tagFrequencyRecord = Object.fromEntries(tagFrequency);
  return { date, focus, topTags, experienceLogChecksum, tagFrequency: tagFrequencyRecord };
}

/**
 * Diff two snapshots to surface capability changes between them.
 */
export function diffSnapshots(prev: Snapshot, next: Snapshot): SnapshotDiff {
  const prevSet = new Set(prev.topTags);
  const nextSet = new Set(next.topTags);

  const newCapabilities = next.topTags.filter((t) => !prevSet.has(t));

  const risingTags = next.focus.filter((f) => f.trend === "rising").map((f) => f.tag);
  const decliningTags = next.focus.filter((f) => f.trend === "declining").map((f) => f.tag);

  // Include tags that dropped out of topTags as declining if not already listed
  const dropped = prev.topTags.filter((t) => !nextSet.has(t));
  for (const t of dropped) {
    if (!decliningTags.includes(t)) decliningTags.push(t);
  }

  return {
    from: prev.date,
    to: next.date,
    newCapabilities,
    risingTags,
    decliningTags,
  };
}
