import type { ProjectMemory } from "../schema/agent.ts";
import type { ExperienceEntry, Highlight } from "../schema/experience.ts";
import { classifyRepo } from "./capability.ts";
import { analyseEntrySignals, computeProjectSignalScore } from "./signal.ts";

/**
 * Merge all ExperienceEntry records that belong to the same repo into a
 * single ProjectMemory object.
 *
 * Strategy:
 * - period = [min(from), max(to)] across all entries
 * - activeMonths = number of distinct entries (each entry represents ~1 month)
 * - highlights = strong + neutral highlights from all entries, deduped by text
 * - weakSignals = weak highlight texts collected for audit
 * - stack = union of all stack arrays, deduped and sorted
 * - tags = union of all tags arrays, deduped and sorted
 * - title = taken from the entry with the most highlights (most representative)
 * - signalScore = weighted average across entries
 */
export function mergeEntriesForRepo(
  repo: string,
  entries: ExperienceEntry[],
): Omit<ProjectMemory, "importance"> {
  if (entries.length === 0) {
    throw new Error(`mergeEntriesForRepo called with empty entries for repo "${repo}"`);
  }

  const sorted = [...entries].sort((a, b) => a.period.from.localeCompare(b.period.from));

  const periodFrom = sorted[0]?.period.from ?? "";
  const periodTo = sorted.reduce(
    (max, e) => (e.period.to > max ? e.period.to : max),
    sorted[0]?.period.to ?? "",
  );

  const seenHighlights = new Set<string>();
  const mergedHighlights: Highlight[] = [];
  const weakTexts: string[] = [];

  for (const entry of sorted) {
    const { strongHighlights, weakTexts: wt } = analyseEntrySignals(entry);
    for (const h of strongHighlights) {
      const key = h.text.trim().toLowerCase();
      if (!seenHighlights.has(key)) {
        seenHighlights.add(key);
        mergedHighlights.push(h);
      }
    }
    for (const w of wt) {
      weakTexts.push(w);
    }
  }

  const stackSet = new Set<string>();
  const tagSet = new Set<string>();
  for (const entry of entries) {
    for (const s of entry.stack) stackSet.add(s);
    for (const t of entry.tags) tagSet.add(t);
  }

  const bestEntry = [...entries].sort(
    (a, b) => b.highlights.length - a.highlights.length,
  )[0] as ExperienceEntry;

  const signalScore = computeProjectSignalScore(entries);

  const stack = [...stackSet].sort();
  const tags = [...tagSet].sort();
  const category = classifyRepo(stack, tags);

  return {
    id: repo.replace("/", "_"),
    repo,
    title: bestEntry.title,
    period: { from: periodFrom, to: periodTo },
    activeMonths: entries.length,
    category,
    signalScore,
    highlights: mergedHighlights,
    weakSignals: weakTexts,
    stack,
    tags,
    evidenceEntryIds: entries.map((e) => e.id),
  };
}

/**
 * Group all entries by repo and merge each group.
 * Returns one ProjectMemory per repo (importance is set to 0; scorer will fill it).
 */
export function mergeExperienceEntries(
  entries: ExperienceEntry[],
): Omit<ProjectMemory, "importance">[] {
  const byRepo = new Map<string, ExperienceEntry[]>();
  for (const entry of entries) {
    const group = byRepo.get(entry.repo);
    if (group) {
      group.push(entry);
    } else {
      byRepo.set(entry.repo, [entry]);
    }
  }

  const results: Omit<ProjectMemory, "importance">[] = [];
  for (const [repo, repoEntries] of byRepo) {
    results.push(mergeEntriesForRepo(repo, repoEntries));
  }
  return results;
}
