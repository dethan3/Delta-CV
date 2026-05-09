import { readCursor, writeCursor } from "./collector/cursor.ts";
import { denoiseEvents } from "./collector/denoise.ts";
import { collectViaGraphQL } from "./collector/github-graphql.ts";
import { collectIssuesViaRest } from "./collector/github-rest.ts";
import { clusterEvents } from "./engine/cluster.ts";
import { buildTagFrequency, computeFocus } from "./engine/focus.ts";
import { buildSnapshot, diffSnapshots } from "./engine/snapshot.ts";
import { tagEvents } from "./engine/tag.ts";
import { generateEntry } from "./engine/translate.ts";
import {
  appendEvents,
  readEventsSince,
  readExperienceLog,
  readLatestSnapshot,
  writeExperienceLog,
  writeSnapshot,
  writeTailoredResume,
} from "./io/data.ts";
import type { Config } from "./schema/config.ts";
import type { ExperienceLog } from "./schema/experience.ts";
import type { SnapshotDiff } from "./schema/snapshot.ts";
import { rerankByJd, slugifyJd } from "./tailor/jd-rerank.ts";
import { renderResume } from "./tailor/render.ts";

export interface ObserveResult {
  eventsCollected: number;
  dataDir: string;
}

export interface EvolveResult {
  log: ExperienceLog;
  diff: SnapshotDiff | null;
}

export interface TailorResult {
  outputPath: string;
  jdSlug: string;
}

/** Collect GitHub events → data/events/. */
export async function observe(config: Config, dataDir: string): Promise<ObserveResult> {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    throw new Error("GITHUB_TOKEN is required. Set it in your environment or .env.local file.");
  }

  // Determine time range
  const cursor = await readCursor(dataDir);
  const from = cursor ?? new Date(Date.now() - 364 * 24 * 60 * 60 * 1000).toISOString();
  const to = new Date().toISOString();

  // Fetch from both sources
  const [graphqlEvents, restEvents] = await Promise.all([
    collectViaGraphQL({
      login: config.login,
      token,
      since: from,
      to,
      ignoreRepos: config.ignore.repos,
    }),
    collectIssuesViaRest(config.login, token, from),
  ]);

  // Merge, denoise, sort
  const allEvents = [...graphqlEvents, ...restEvents];
  const denoised = denoiseEvents(allEvents, config.ignore.authors, config.ignore.repos);
  denoised.sort((a, b) => a.ts.localeCompare(b.ts));

  // Write events
  await appendEvents(dataDir, denoised);

  // Update cursor to latest event timestamp
  if (denoised.length > 0) {
    const latestTs = denoised[denoised.length - 1]?.ts;
    if (latestTs) {
      await writeCursor(dataDir, latestTs);
    }
  }

  return { eventsCollected: denoised.length, dataDir };
}

/** ISO timestamp far enough in the past to read all collected events by default. */
const EPOCH = "2000-01-01T00:00:00Z";

/**
 * Process events → experience log + snapshot.
 * @param since - Only include events at or after this ISO timestamp (default: all events).
 */
export async function evolve(
  config: Config,
  dataDir: string,
  since = EPOCH,
): Promise<EvolveResult> {
  const apiKey = config.llm.apiKey ?? process.env.LLM_API_KEY;
  if (!apiKey) {
    throw new Error("LLM_API_KEY is required. Set it in your environment or .env.local file.");
  }
  const llmConfig = { ...config.llm, apiKey };

  // Read collected events from the requested starting point
  const events = await readEventsSince(dataDir, since);
  if (events.length === 0) {
    throw new Error("No events found in data/events/. Run 'delta observe' first.");
  }

  console.log(
    `[evolve] processing ${events.length} events across ${new Set(events.map((e) => e.repo)).size} repos`,
  );

  // Cluster and tag
  const clusters = clusterEvents(events);
  const eventTags = tagEvents(events);
  const lang = config.language === "bilingual" ? "en" : config.language;
  const {
    maxEventsPerCluster = 40,
    trendThreshold = 0.04,
    topTagsLimit = 20,
  } = config.engine ?? {};

  console.log(`[evolve] ${clusters.length} clusters to translate`);

  // Generate experience entries sequentially to stay within LLM rate limits
  const entries = [];
  let clusterIdx = 0;
  for (const cluster of clusters) {
    clusterIdx += 1;
    console.log(
      `[evolve] translating cluster ${clusterIdx}/${clusters.length}: ${cluster.repo} ${cluster.period.from.slice(0, 7)}`,
    );
    const entry = await generateEntry(llmConfig, cluster, eventTags, lang, maxEventsPerCluster);
    entries.push(entry);
  }

  // Build experience log
  const log: ExperienceLog = {
    version: 1,
    generatedAt: new Date().toISOString(),
    entries,
  };
  await writeExperienceLog(dataDir, log);

  // Compute focus: use stored tagFrequency from previous snapshot for accurate trend comparison
  const prevSnapshot = await readLatestSnapshot(dataDir);
  const tagFrequency = buildTagFrequency(entries);
  const prevFreq: Map<string, number> | undefined = prevSnapshot?.tagFrequency
    ? new Map(Object.entries(prevSnapshot.tagFrequency))
    : undefined;

  const focus = computeFocus(tagFrequency, prevFreq, trendThreshold);

  // Build snapshot (stores tagFrequency for next run)
  const today = new Date().toISOString().slice(0, 10);
  const snapshot = buildSnapshot(log, today, focus, tagFrequency, topTagsLimit);
  const diff = prevSnapshot ? diffSnapshots(prevSnapshot, snapshot) : null;
  await writeSnapshot(dataDir, snapshot);

  console.log(`[evolve] wrote experience log (${entries.length} entries) and snapshot ${today}`);
  return { log, diff };
}

/** Tailor resume for a specific JD. Renders resume, optionally reranked by JD relevance. */
export async function tailor(
  config: Config,
  dataDir: string,
  jdText?: string,
): Promise<TailorResult> {
  const log = await readExperienceLog(dataDir);
  if (!log) {
    throw new Error("No experience log found. Run 'delta evolve' first.");
  }

  const snapshot = await readLatestSnapshot(dataDir);
  const lang = config.language === "bilingual" ? "bilingual" : config.language;

  // If JD provided, rerank entries by relevance
  let entries = log.entries;
  if (jdText) {
    entries = rerankByJd(log.entries, jdText);
  }

  const resumeLog = { ...log, entries };
  const markdown = await renderResume(resumeLog, {
    language: lang,
    login: config.login,
    focus: snapshot?.focus,
    topTags: snapshot?.topTags,
  });

  const jdSlug = jdText ? slugifyJd(jdText) : "default";
  const outputPath = await writeTailoredResume(dataDir, jdSlug, markdown);

  console.log(`[tailor] wrote resume → ${outputPath}`);
  return { outputPath, jdSlug };
}
