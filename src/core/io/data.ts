import { appendFile, mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  CapabilityClaim,
  CritiqueResult,
  CurateResult,
  JdProfile,
  ProjectMemory,
  ResumeDraft,
  RevisionRecord,
} from "../schema/agent.ts";
import type { EventEnvelope } from "../schema/event.ts";
import type { EvidenceLog } from "../schema/evidence.ts";
import type { ExperienceLog } from "../schema/experience.ts";
import type { NarrativeLog } from "../schema/narrative.ts";
import type { ResumePlan } from "../schema/plan.ts";
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

// ── Evolve checkpoint ─────────────────────────────────────────────────────────

export interface EvolveCheckpoint {
  processedIds: string[];
  entries: unknown[];
  totalClusters: number;
  lastUpdated: string;
}

const CHECKPOINT_PATH = (dataDir: string) => join(dataDir, "_meta", "evolve-checkpoint.json");

export async function readEvolveCheckpoint(dataDir: string): Promise<EvolveCheckpoint | null> {
  try {
    const raw = await readFile(CHECKPOINT_PATH(dataDir), "utf8");
    return JSON.parse(raw) as EvolveCheckpoint;
  } catch {
    return null;
  }
}

export async function writeEvolveCheckpoint(
  dataDir: string,
  checkpoint: EvolveCheckpoint,
): Promise<void> {
  const metaDir = join(dataDir, "_meta");
  await mkdir(metaDir, { recursive: true });
  await writeFile(CHECKPOINT_PATH(dataDir), JSON.stringify(checkpoint, null, 2), "utf8");
}

export async function clearEvolveCheckpoint(dataDir: string): Promise<void> {
  try {
    await unlink(CHECKPOINT_PATH(dataDir));
  } catch {
    // already gone, that's fine
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

/** Write curated projects to data/agent/projects.json. */
export async function writeProjects(dataDir: string, projects: ProjectMemory[]): Promise<void> {
  const agentDir = join(dataDir, "agent");
  await mkdir(agentDir, { recursive: true });
  await writeFile(join(agentDir, "projects.json"), JSON.stringify(projects, null, 2), "utf8");
}

/** Read curated projects from data/agent/projects.json. Returns null if not found. */
export async function readProjects(dataDir: string): Promise<ProjectMemory[] | null> {
  const path = join(dataDir, "agent", "projects.json");
  try {
    const raw = await readFile(path, "utf8");
    const { ProjectMemorySchema } = await import("../schema/agent.ts");
    const parsed = JSON.parse(raw) as unknown[];
    return parsed.map((item) => ProjectMemorySchema.parse(item));
  } catch (err: unknown) {
    if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw err;
  }
}

/** Write capability claims to data/agent/claims.json. */
export async function writeClaims(dataDir: string, claims: CapabilityClaim[]): Promise<void> {
  const agentDir = join(dataDir, "agent");
  await mkdir(agentDir, { recursive: true });
  await writeFile(join(agentDir, "claims.json"), JSON.stringify(claims, null, 2), "utf8");
}

/** Write the full curate result to data/agent/curate.json. */
export async function writeCurateResult(dataDir: string, result: CurateResult): Promise<void> {
  const agentDir = join(dataDir, "agent");
  await mkdir(agentDir, { recursive: true });
  await writeFile(join(agentDir, "curate.json"), JSON.stringify(result, null, 2), "utf8");
}

/** Write a ResumeDraft to data/agent/drafts/<slug>.resume.json. */
export async function writeResumeDraft(
  dataDir: string,
  slug: string,
  draft: ResumeDraft,
): Promise<string> {
  const draftsDir = join(dataDir, "agent", "drafts");
  await mkdir(draftsDir, { recursive: true });
  const filePath = join(draftsDir, `${slug}.resume.json`);
  await writeFile(filePath, JSON.stringify(draft, null, 2), "utf8");
  return filePath;
}

/** Read a ResumeDraft from data/agent/drafts/<slug>.resume.json. Returns null if not found. */
export async function readResumeDraft(dataDir: string, slug: string): Promise<ResumeDraft | null> {
  const filePath = join(dataDir, "agent", "drafts", `${slug}.resume.json`);
  try {
    const raw = await readFile(filePath, "utf8");
    const { ResumeDraftSchema } = await import("../schema/agent.ts");
    return ResumeDraftSchema.parse(JSON.parse(raw));
  } catch (err: unknown) {
    if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw err;
  }
}

/** Write rendered HTML to data/resumes/<slug>.html. */
export async function writeResumeHtml(
  dataDir: string,
  slug: string,
  html: string,
): Promise<string> {
  const resumesDir = join(dataDir, "resumes");
  await mkdir(resumesDir, { recursive: true });
  const filePath = join(resumesDir, `${slug}.html`);
  await writeFile(filePath, html, "utf8");
  return filePath;
}

/** Write rendered Markdown to data/resumes/<slug>.md. */
export async function writeResumeMd(
  dataDir: string,
  slug: string,
  markdown: string,
): Promise<string> {
  const resumesDir = join(dataDir, "resumes");
  await mkdir(resumesDir, { recursive: true });
  const filePath = join(resumesDir, `${slug}.md`);
  await writeFile(filePath, markdown, "utf8");
  return filePath;
}

/** Write a CritiqueResult to data/agent/critiques/<slug>.json. */
export async function writeCritique(
  dataDir: string,
  slug: string,
  critique: CritiqueResult,
): Promise<string> {
  const critiquesDir = join(dataDir, "agent", "critiques");
  await mkdir(critiquesDir, { recursive: true });
  const filePath = join(critiquesDir, `${slug}.json`);
  await writeFile(filePath, JSON.stringify(critique, null, 2), "utf8");
  return filePath;
}

/** Read a CritiqueResult from data/agent/critiques/<slug>.json. Returns null if not found. */
export async function readCritique(dataDir: string, slug: string): Promise<CritiqueResult | null> {
  const filePath = join(dataDir, "agent", "critiques", `${slug}.json`);
  try {
    const raw = await readFile(filePath, "utf8");
    const { CritiqueResultSchema } = await import("../schema/agent.ts");
    return CritiqueResultSchema.parse(JSON.parse(raw));
  } catch (err: unknown) {
    if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw err;
  }
}

/** Write a RevisionRecord to data/agent/drafts/<slug>.revision.json and the updated draft. */
export async function writeRevision(
  dataDir: string,
  record: RevisionRecord,
): Promise<{ draftPath: string; recordPath: string }> {
  const draftsDir = join(dataDir, "agent", "drafts");
  await mkdir(draftsDir, { recursive: true });

  const draftPath = join(draftsDir, `${record.slug}.resume.json`);
  await writeFile(draftPath, JSON.stringify(record.draft, null, 2), "utf8");

  const recordPath = join(draftsDir, `${record.slug}.revision.json`);
  const recordWithoutDraft = { ...record, draft: undefined };
  await writeFile(recordPath, JSON.stringify(recordWithoutDraft, null, 2), "utf8");

  return { draftPath, recordPath };
}

/** Write a JdProfile to data/agent/jd-profiles/<slug>.json. */
export async function writeJdProfile(dataDir: string, profile: JdProfile): Promise<string> {
  const dir = join(dataDir, "agent", "jd-profiles");
  await mkdir(dir, { recursive: true });
  const filePath = join(dir, `${profile.slug}.json`);
  await writeFile(filePath, JSON.stringify(profile, null, 2), "utf8");
  return filePath;
}

/** Read a JdProfile from data/agent/jd-profiles/<slug>.json. Returns null if not found. */
export async function readJdProfile(dataDir: string, slug: string): Promise<JdProfile | null> {
  const filePath = join(dataDir, "agent", "jd-profiles", `${slug}.json`);
  try {
    const raw = await readFile(filePath, "utf8");
    const { JdProfileSchema } = await import("../schema/agent.ts");
    return JdProfileSchema.parse(JSON.parse(raw));
  } catch (err: unknown) {
    if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw err;
  }
}

/** Write an EvidenceLog to data/agent/evidence.json. */
export async function writeEvidence(dataDir: string, log: EvidenceLog): Promise<string> {
  const agentDir = join(dataDir, "agent");
  await mkdir(agentDir, { recursive: true });
  const filePath = join(agentDir, "evidence.json");
  await writeFile(filePath, JSON.stringify(log, null, 2), "utf8");
  return filePath;
}

/** Read an EvidenceLog from data/agent/evidence.json. Returns null if not found. */
export async function readEvidence(dataDir: string): Promise<EvidenceLog | null> {
  const filePath = join(dataDir, "agent", "evidence.json");
  try {
    const raw = await readFile(filePath, "utf8");
    const { EvidenceLogSchema } = await import("../schema/evidence.ts");
    return EvidenceLogSchema.parse(JSON.parse(raw));
  } catch (err: unknown) {
    if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw err;
  }
}

/** Write a NarrativeLog to data/agent/narratives.json. */
export async function writeNarratives(dataDir: string, log: NarrativeLog): Promise<string> {
  const agentDir = join(dataDir, "agent");
  await mkdir(agentDir, { recursive: true });
  const filePath = join(agentDir, "narratives.json");
  await writeFile(filePath, JSON.stringify(log, null, 2), "utf8");
  return filePath;
}

/** Read a NarrativeLog from data/agent/narratives.json. Returns null if not found. */
export async function readNarratives(dataDir: string): Promise<NarrativeLog | null> {
  const filePath = join(dataDir, "agent", "narratives.json");
  try {
    const raw = await readFile(filePath, "utf8");
    const { NarrativeLogSchema } = await import("../schema/narrative.ts");
    return NarrativeLogSchema.parse(JSON.parse(raw));
  } catch (err: unknown) {
    if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw err;
  }
}

/** Write a ResumePlan to data/agent/plan.json. */
export async function writePlan(dataDir: string, plan: ResumePlan): Promise<string> {
  const agentDir = join(dataDir, "agent");
  await mkdir(agentDir, { recursive: true });
  const filePath = join(agentDir, "plan.json");
  await writeFile(filePath, JSON.stringify(plan, null, 2), "utf8");
  return filePath;
}

/** Read a ResumePlan from data/agent/plan.json. Returns null if not found. */
export async function readPlan(dataDir: string): Promise<ResumePlan | null> {
  const filePath = join(dataDir, "agent", "plan.json");
  try {
    const raw = await readFile(filePath, "utf8");
    const { ResumePlanSchema } = await import("../schema/plan.ts");
    return ResumePlanSchema.parse(JSON.parse(raw));
  } catch (err: unknown) {
    if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw err;
  }
}
