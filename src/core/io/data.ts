import { appendFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { EventEnvelope } from "../schema/event.ts";
import type { ExperienceLog } from "../schema/experience.ts";
import type { Snapshot } from "../schema/snapshot.ts";

/** Compute ISO 8601 week key in "yyyy-Www" format (e.g. "2026-W18"). */
export function getISOWeekKey(isoDate: string): string {
  const d = new Date(isoDate);
  // Shift to Thursday of the target week (ISO weeks are defined by their Thursday)
  const dayOfWeek = d.getUTCDay(); // 0=Sun, 1=Mon, ..., 6=Sat
  const thursday = new Date(d);
  thursday.setUTCDate(d.getUTCDate() + 3 - ((dayOfWeek + 6) % 7));

  // January 4th is always in ISO week 1
  const jan4 = new Date(Date.UTC(thursday.getUTCFullYear(), 0, 4));
  const jan4Thursday = new Date(jan4);
  jan4Thursday.setUTCDate(jan4.getUTCDate() + 3 - ((jan4.getUTCDay() + 6) % 7));

  const weekNumber = Math.ceil(
    ((thursday.getTime() - jan4Thursday.getTime()) / 86_400_000 + 1) / 7,
  );
  const isoYear = thursday.getUTCFullYear();

  return `${isoYear}-W${String(weekNumber).padStart(2, "0")}`;
}

function eventIdentity(event: EventEnvelope): string {
  return `${event.kind}:${event.repo}:${event.ts}`;
}

/** Append events to data/events/<yyyy-ww>.jsonl with deduplication. */
export async function appendEvents(dataDir: string, events: EventEnvelope[]): Promise<void> {
  if (events.length === 0) return;

  const eventsDir = join(dataDir, "events");
  await mkdir(eventsDir, { recursive: true });

  // Group events by ISO week
  const byWeek = new Map<string, EventEnvelope[]>();
  for (const event of events) {
    const key = getISOWeekKey(event.ts);
    const group = byWeek.get(key);
    if (group) {
      group.push(event);
    } else {
      byWeek.set(key, [event]);
    }
  }

  for (const [weekKey, weekEvents] of byWeek) {
    const filePath = join(eventsDir, `${weekKey}.jsonl`);

    // Read existing identities for dedup
    const existingIds = new Set<string>();
    try {
      const raw = await readFile(filePath, "utf8");
      for (const line of raw.split("\n")) {
        if (line.trim() === "") continue;
        try {
          const parsed = JSON.parse(line) as EventEnvelope;
          existingIds.add(eventIdentity(parsed));
        } catch {
          // skip malformed lines
        }
      }
    } catch (err: unknown) {
      if (
        err instanceof Error &&
        "code" in err &&
        (err as NodeJS.ErrnoException).code !== "ENOENT"
      ) {
        throw err;
      }
    }

    // Filter out duplicates and append
    const newEvents = weekEvents.filter((e) => !existingIds.has(eventIdentity(e)));
    if (newEvents.length === 0) continue;

    const lines = `${newEvents.map((e) => JSON.stringify(e)).join("\n")}\n`;
    await appendFile(filePath, lines, "utf8");
  }
}

/** Read all events from data/events/ since a given ISO date. */
export async function readEventsSince(dataDir: string, since: string): Promise<EventEnvelope[]> {
  const eventsDir = join(dataDir, "events");
  let files: string[];
  try {
    files = await readdir(eventsDir);
  } catch (err: unknown) {
    if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw err;
  }

  const sinceWeek = getISOWeekKey(since);
  const jsonlFiles = files.filter((f) => f.endsWith(".jsonl") && f >= `${sinceWeek}.jsonl`).sort();

  const events: EventEnvelope[] = [];
  for (const file of jsonlFiles) {
    const raw = await readFile(join(eventsDir, file), "utf8");
    for (const line of raw.split("\n")) {
      if (line.trim() === "") continue;
      try {
        const parsed = JSON.parse(line) as EventEnvelope;
        if (parsed.ts >= since) {
          events.push(parsed);
        }
      } catch {
        // skip malformed lines
      }
    }
  }

  events.sort((a, b) => a.ts.localeCompare(b.ts));
  return events;
}

/** Persist the experience log to data/_meta/experience.json. */
export async function writeExperienceLog(dataDir: string, log: ExperienceLog): Promise<void> {
  const metaDir = join(dataDir, "_meta");
  await mkdir(metaDir, { recursive: true });
  await writeFile(join(metaDir, "experience.json"), JSON.stringify(log, null, 2), "utf8");
}

/** Read the experience log from data/_meta/experience.json. Returns null if not found. */
export async function readExperienceLog(dataDir: string): Promise<ExperienceLog | null> {
  const path = join(dataDir, "_meta", "experience.json");
  try {
    const raw = await readFile(path, "utf8");
    const { ExperienceLogSchema } = await import("../schema/experience.ts");
    return ExperienceLogSchema.parse(JSON.parse(raw));
  } catch (err: unknown) {
    if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw err;
  }
}

/** Persist a snapshot to data/snapshots/<date>.json. */
export async function writeSnapshot(dataDir: string, snapshot: Snapshot): Promise<void> {
  const snapshotsDir = join(dataDir, "snapshots");
  await mkdir(snapshotsDir, { recursive: true });
  await writeFile(
    join(snapshotsDir, `${snapshot.date}.json`),
    JSON.stringify(snapshot, null, 2),
    "utf8",
  );
}

/** Read the most recent snapshot from data/snapshots/. Returns null if none exist. */
export async function readLatestSnapshot(dataDir: string): Promise<Snapshot | null> {
  const snapshotsDir = join(dataDir, "snapshots");
  let files: string[];
  try {
    files = await readdir(snapshotsDir);
  } catch (err: unknown) {
    if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw err;
  }
  const jsonFiles = files.filter((f) => f.endsWith(".json")).sort();
  const latest = jsonFiles[jsonFiles.length - 1];
  if (!latest) return null;
  try {
    const raw = await readFile(join(snapshotsDir, latest), "utf8");
    const { SnapshotSchema } = await import("../schema/snapshot.ts");
    return SnapshotSchema.parse(JSON.parse(raw));
  } catch {
    return null;
  }
}

/** Write a tailored resume to data/tailored/<slug>.md. */
export async function writeTailoredResume(
  dataDir: string,
  slug: string,
  markdown: string,
): Promise<string> {
  const tailoredDir = join(dataDir, "tailored");
  await mkdir(tailoredDir, { recursive: true });
  const filePath = join(tailoredDir, `${slug}.md`);
  await writeFile(filePath, markdown, "utf8");
  return filePath;
}
