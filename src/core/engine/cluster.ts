import type { EventEnvelope } from "../schema/event.ts";

export interface Cluster {
  id: string;
  repo: string;
  events: EventEnvelope[];
  period: { from: string; to: string };
}

/**
 * Group events into per-repo, per-month clusters sorted by period start.
 * Each cluster represents a distinct unit of work to be summarised by the LLM.
 */
export function clusterEvents(events: EventEnvelope[]): Cluster[] {
  if (events.length === 0) return [];

  // Group by repo → month key (e.g. "2026-05")
  const groups = new Map<string, EventEnvelope[]>();
  for (const event of events) {
    const monthKey = event.ts.slice(0, 7); // "YYYY-MM"
    const key = `${event.repo}::${monthKey}`;
    const existing = groups.get(key);
    if (existing) {
      existing.push(event);
    } else {
      groups.set(key, [event]);
    }
  }

  const clusters: Cluster[] = [];
  for (const [key, clusterEvents] of groups) {
    clusterEvents.sort((a, b) => a.ts.localeCompare(b.ts));
    const [repo, monthKey] = key.split("::");
    if (!repo || !monthKey) continue;
    clusters.push({
      id: `${repo.replace("/", "_")}_${monthKey}`,
      repo,
      events: clusterEvents,
      period: {
        from: clusterEvents[0]?.ts ?? "",
        to: clusterEvents[clusterEvents.length - 1]?.ts ?? "",
      },
    });
  }

  clusters.sort((a, b) => a.period.from.localeCompare(b.period.from));
  return clusters;
}
