import { readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { readCursor, writeCursor } from "./collector/cursor.ts";
import { denoiseEvents } from "./collector/denoise.ts";
import { collectViaGraphQL } from "./collector/github-graphql.ts";
import { collectIssuesViaRest } from "./collector/github-rest.ts";
import { buildCapabilityClaims } from "./agent/capability.ts";
import { composeDraft, type ComposeOptions } from "./agent/compose.ts";
import { critiqueDraft } from "./agent/critique.ts";
import { parseJdProfile } from "./agent/jd-parse.ts";
import { scoreClaimsForJd, scoreProjectsForJd } from "./agent/jd-score.ts";
import { mergeExperienceEntries } from "./agent/merger.ts";
import { reviseDraft, stripRevSuffix } from "./agent/revise.ts";
import { scoreProjects } from "./agent/scorer.ts";
import { renderResumeDraftHtmlAgent } from "./render/html-agent.ts";
import { renderResumeDraftMarkdown } from "./render/markdown-v2.ts";
import { type HtmlStyle, isHtmlStyle, isStaticStyle, renderWithStyle } from "./render/styles.ts";
import { validateGeneratedHtml } from "./render/validate.ts";
import { clusterEvents } from "./engine/cluster.ts";
import { buildTagFrequency, computeFocus } from "./engine/focus.ts";
import { buildSnapshot, diffSnapshots } from "./engine/snapshot.ts";
import { tagEvents } from "./engine/tag.ts";
import { generateEntryBatch } from "./engine/translate.ts";
import { RateLimitError } from "./llm.ts";
import {
  appendEvents,
  clearEvolveCheckpoint,
  readEvolveCheckpoint,
  readEventsSince,
  readExperienceLog,
  readLatestSnapshot,
  readResumeDraft,
  writeClaims,
  writeCritique,
  writeCurateResult,
  writeEvolveCheckpoint,
  writeExperienceLog,
  writeJdProfile,
  writeProjects,
  writeResumeHtml,
  writeResumeMd,
  writeResumeDraft,
  writeRevision,
  writeSnapshot,
  writeTailoredResume,
} from "./io/data.ts";
import type { Config } from "./schema/config.ts";
import type {
  CritiqueResult,
  CurateResult,
  JdProfile,
  ResumeDraft,
  RevisionRecord,
} from "./schema/agent.ts";
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
    concurrency = 3,
  } = config.engine ?? {};

  console.log(`[evolve] ${clusters.length} clusters to translate (concurrency: ${concurrency})`);

  // ── Checkpoint: resume from previous partial run ──────────────────────────
  const checkpoint = await readEvolveCheckpoint(dataDir);
  const doneIds = new Set<string>(checkpoint?.processedIds ?? []);
  const resumedEntries: unknown[] = checkpoint?.entries ?? [];
  if (doneIds.size > 0) {
    console.log(`[evolve] resuming — ${doneIds.size}/${clusters.length} clusters already done`);
  }

  const pendingClusters = clusters.filter((c) => !doneIds.has(c.id));

  // ── Adaptive batching ─────────────────────────────────────────────────────
  // Clusters with ≤ SOLO_THRESHOLD events get merged into batches of up to BATCH_SIZE.
  // Larger clusters get their own LLM call.
  const SOLO_THRESHOLD = 8;
  const BATCH_SIZE = 5;

  const batches: (typeof pendingClusters)[] = [];
  let smallBatch: typeof pendingClusters = [];
  for (const cluster of pendingClusters) {
    if (cluster.events.length > SOLO_THRESHOLD) {
      if (smallBatch.length > 0) { batches.push(smallBatch); smallBatch = []; }
      batches.push([cluster]);
    } else {
      smallBatch.push(cluster);
      if (smallBatch.length >= BATCH_SIZE) { batches.push(smallBatch); smallBatch = []; }
    }
  }
  if (smallBatch.length > 0) batches.push(smallBatch);

  // ── Concurrent pool ───────────────────────────────────────────────────────
  // JS is single-threaded: array/set mutations between awaits are safe.
  // Checkpoint writes may overlap but each writes the full accumulated state,
  // so the last writer always wins with the most up-to-date snapshot.
  const allEntries: unknown[] = [...resumedEntries];
  let processed = doneIds.size;
  let rateLimitHit = false;

  let batchCursor = 0;

  async function worker(): Promise<void> {
    while (batchCursor < batches.length) {
      if (rateLimitHit) return;
      const myIdx = batchCursor++;
      const batch = batches[myIdx]!;

      const batchLabel =
        batch.length === 1
          ? `${batch[0]!.repo} ${batch[0]!.period.from.slice(0, 7)}`
          : `${batch.length} clusters (${batch[0]!.repo} … ${batch[batch.length - 1]!.repo})`;
      const startNum = processed + 1;
      processed += batch.length;
      console.log(
        `[evolve] translating ${startNum}–${processed}/${clusters.length}: ${batchLabel}`,
      );

      try {
        const newEntries = await generateEntryBatch(
          llmConfig,
          batch,
          eventTags,
          lang,
          maxEventsPerCluster,
        );
        allEntries.push(...newEntries);
        for (const c of batch) doneIds.add(c.id);

        await writeEvolveCheckpoint(dataDir, {
          processedIds: [...doneIds],
          entries: allEntries,
          totalClusters: clusters.length,
          lastUpdated: new Date().toISOString(),
        });
      } catch (err) {
        if (err instanceof RateLimitError) {
          rateLimitHit = true;
          return;
        }
        throw err;
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  if (rateLimitHit) {
    console.warn(
      `[evolve] rate limit hit after ${doneIds.size}/${clusters.length} clusters.` +
        ` Checkpoint saved — run 'delta evolve' again to continue.`,
    );
    process.exit(0);
  }

  const { ExperienceEntrySchema } = await import("./schema/experience.ts");
  const entries = allEntries.map((e) => ExperienceEntrySchema.parse(e));
  await clearEvolveCheckpoint(dataDir);

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

/**
 * Curate: merge experience entries by repo, score projects, build capability claims.
 * Pure algorithm — no LLM calls.
 */
export async function curate(dataDir: string, topN = 6): Promise<CurateResult> {
  const log = await readExperienceLog(dataDir);
  if (!log) {
    throw new Error("No experience log found. Run 'delta evolve' first.");
  }

  const drafts = mergeExperienceEntries(log.entries);
  const scored = scoreProjects(drafts);
  const top = scored.slice(0, topN);

  const claims = buildCapabilityClaims(scored);

  const result: CurateResult = {
    version: 1,
    generatedAt: new Date().toISOString(),
    projects: scored,
    claims,
  };

  await writeProjects(dataDir, scored);
  await writeClaims(dataDir, claims);
  await writeCurateResult(dataDir, result);

  console.log(
    `[curate] ${scored.length} projects scored, top ${top.length} selected, ${claims.length} capability claims`,
  );

  return result;
}

export interface ComposeResult {
  draft: ResumeDraft;
  draftPath: string;
  htmlPath: string | null;
  mdPath: string | null;
  jdProfile: JdProfile | null;
  jdProfilePath: string | null;
}

export interface ComposeRunOptions extends ComposeOptions {
  format?: "html" | "md" | "both";
  style?: "clean" | "developer" | "compact";
  slug?: string;
  topN?: number;
}

/**
 * Compose: run curate (if needed) then call LLM once to produce a ResumeDraft,
 * render to HTML and/or Markdown, and persist all outputs.
 *
 * When options.jd is provided:
 *   1. Parse the JD text → JdProfile (one LLM call)
 *   2. Re-score and re-sort projects/claims against the JdProfile
 *   3. Compose the draft with JD context
 *   4. Use JD-derived slug (e.g. "jd-ai-engineer")
 */
export async function compose(
  config: Config,
  dataDir: string,
  options: ComposeRunOptions = { lang: "zh" },
): Promise<ComposeResult> {
  const apiKey = config.llm.apiKey ?? process.env.LLM_API_KEY;
  if (!apiKey) {
    throw new Error("LLM_API_KEY is required. Set it in your environment or .env.local file.");
  }
  const llmConfig = { ...config.llm, apiKey };

  // Run curate inline so compose can be called standalone
  const log = await readExperienceLog(dataDir);
  if (!log) {
    throw new Error("No experience log found. Run 'delta evolve' first.");
  }

  const topN = options.topN ?? 6;
  const drafts = mergeExperienceEntries(log.entries);
  const scored = scoreProjects(drafts);
  const claims = buildCapabilityClaims(scored);

  const lang = config.language === "bilingual" ? "zh" : config.language;

  // ── JD pipeline ────────────────────────────────────────────────────────────
  let jdProfile: JdProfile | null = null;
  let jdProfilePath: string | null = null;
  let finalProjects = scored;
  let finalClaims = claims;

  if (options.jd) {
    jdProfile = await parseJdProfile(llmConfig, options.jd, lang);
    jdProfilePath = await writeJdProfile(dataDir, jdProfile);
    finalProjects = scoreProjectsForJd(scored, jdProfile);
    finalClaims = scoreClaimsForJd(claims, jdProfile);
    console.log(
      `[compose] JD parsed: "${jdProfile.jobTitle}" (${jdProfile.seniority}) — ${jdProfile.requiredSkills.length} required skills`,
    );
  }

  const curateResult: CurateResult = {
    version: 1,
    generatedAt: new Date().toISOString(),
    projects: finalProjects,
    claims: finalClaims,
  };

  const composeOpts: ComposeOptions = { lang, topN };
  if (options.targetRole) {
    composeOpts.targetRole = options.targetRole;
  } else if (jdProfile) {
    composeOpts.targetRole = jdProfile.jobTitle;
  }
  if (options.jd) composeOpts.jd = options.jd;

  const draft = await composeDraft(llmConfig, config.login, curateResult, composeOpts);

  const slug = options.slug ?? (jdProfile ? jdProfile.slug : "default");
  const draftPath = await writeResumeDraft(dataDir, slug, draft);

  const format = options.format ?? "both";
  const style = options.style ?? "clean";
  let htmlPath: string | null = null;
  let mdPath: string | null = null;

  if (format === "html" || format === "both") {
    const html = renderWithStyle(draft, style);
    htmlPath = await writeResumeHtml(dataDir, slug, html);
  }
  if (format === "md" || format === "both") {
    const md = renderResumeDraftMarkdown(draft);
    mdPath = await writeResumeMd(dataDir, slug, md);
  }

  return { draft, draftPath, htmlPath, mdPath, jdProfile, jdProfilePath };
}

export interface CritiqueRunResult {
  critique: CritiqueResult;
  critiquePath: string;
}

/**
 * Critique an existing ResumeDraft and persist the CritiqueResult.
 * Reads the draft by slug, runs one LLM critique call, saves output.
 */
export async function critique(
  config: Config,
  dataDir: string,
  slug = "default",
): Promise<CritiqueRunResult> {
  const apiKey = config.llm.apiKey ?? process.env.LLM_API_KEY;
  if (!apiKey) {
    throw new Error("LLM_API_KEY is required. Set it in your environment or .env.local file.");
  }
  const llmConfig = { ...config.llm, apiKey };

  const draft = await readResumeDraft(dataDir, slug);
  if (!draft) {
    throw new Error(
      `No resume draft found for slug "${slug}". Run 'delta compose' first.`,
    );
  }

  const lang = config.language === "bilingual" ? "zh" : config.language;
  const critiqueResult = await critiqueDraft(llmConfig, draft, slug, lang);
  const critiquePath = await writeCritique(dataDir, slug, critiqueResult);

  return { critique: critiqueResult, critiquePath };
}

export interface ReviseRunResult {
  record: RevisionRecord;
  draftPath: string;
  htmlPath: string | null;
  mdPath: string | null;
}

/**
 * Revise an existing ResumeDraft according to a user instruction.
 * Reads the draft by slug, runs one LLM revise call, persists new draft + renders.
 */
export async function revise(
  config: Config,
  dataDir: string,
  instruction: string,
  options: { slug?: string; format?: "html" | "md" | "both" } = {},
): Promise<ReviseRunResult> {
  const apiKey = config.llm.apiKey ?? process.env.LLM_API_KEY;
  if (!apiKey) {
    throw new Error("LLM_API_KEY is required. Set it in your environment or .env.local file.");
  }
  const llmConfig = { ...config.llm, apiKey };

  const slug = options.slug ?? "default";
  const draft = await readResumeDraft(dataDir, slug);
  if (!draft) {
    throw new Error(
      `No resume draft found for slug "${slug}". Run 'delta compose' first.`,
    );
  }

  const lang = config.language === "bilingual" ? "zh" : config.language;
  const record = await reviseDraft(llmConfig, draft, slug, instruction, lang, dataDir);
  const { draftPath } = await writeRevision(dataDir, record);

  const format = options.format ?? "both";
  let htmlPath: string | null = null;
  let mdPath: string | null = null;

  if (format === "html" || format === "both") {
    const html = renderWithStyle(record.draft, "clean");
    htmlPath = await writeResumeHtml(dataDir, record.slug, html);
  }
  if (format === "md" || format === "both") {
    const md = renderResumeDraftMarkdown(record.draft);
    mdPath = await writeResumeMd(dataDir, record.slug, md);
  }

  return { record, draftPath, htmlPath, mdPath };
}

export interface RenderRunResult {
  style: HtmlStyle;
  format: "html" | "md" | "both";
  htmlPath: string | null;
  mdPath: string | null;
  validationWarnings?: string[];
}

/**
 * Render an existing ResumeDraft to HTML (with chosen style) and/or Markdown.
 * Static styles (clean/developer/compact) do not call the LLM.
 * Agent style requires `config` and `instruction`.
 */
export async function render(
  dataDir: string,
  options: {
    slug?: string;
    style?: string;
    format?: "html" | "md" | "both";
    instruction?: string;
    config?: Config;
  } = {},
): Promise<RenderRunResult> {
  const slug = options.slug ?? "default";
  const format = options.format ?? "both";
  const styleArg = options.style ?? "clean";

  if (!isHtmlStyle(styleArg)) {
    throw new Error(
      `Unknown style "${styleArg}". Available: ${["clean", "developer", "compact", "agent"].join(", ")}`,
    );
  }
  const style: HtmlStyle = styleArg;

  if (style === "agent") {
    if (!options.instruction) {
      throw new Error(
        `--style agent requires --instruction. E.g. --instruction "深色极简风格，适合 AI 工程师"`,
      );
    }
    if (!options.config) {
      throw new Error(`--style agent requires LLM config. Pass config to render().`);
    }
    const apiKey = options.config.llm.apiKey ?? process.env.LLM_API_KEY;
    if (!apiKey) {
      throw new Error("LLM_API_KEY is required for --style agent.");
    }
  }

  const draft = await readResumeDraft(dataDir, slug);
  if (!draft) {
    throw new Error(`No resume draft found for slug "${slug}". Run 'delta compose' first.`);
  }

  let htmlPath: string | null = null;
  let mdPath: string | null = null;
  let validationWarnings: string[] | undefined;

  if (format === "html" || format === "both") {
    let html: string;
    if (style === "agent") {
      const cfg = options.config!;
      const apiKey = cfg.llm.apiKey ?? process.env.LLM_API_KEY ?? "";
      const llmConfig = { ...cfg.llm, apiKey };
      const lang = cfg.language === "bilingual" ? "zh" : cfg.language;
      html = await renderResumeDraftHtmlAgent(llmConfig, draft, options.instruction!, lang);
      const validation = validateGeneratedHtml(html, draft);
      if (!validation.valid) {
        console.warn(`[render] agent HTML validation errors:\n  ${validation.errors.join("\n  ")}`);
      }
      if (validation.warnings.length > 0) {
        console.warn(
          `[render] agent HTML validation warnings:\n  ${validation.warnings.join("\n  ")}`,
        );
      }
      validationWarnings = [...validation.errors, ...validation.warnings];
    } else {
      html = renderWithStyle(draft, style);
    }
    htmlPath = await writeResumeHtml(dataDir, `${slug}-${style}`, html);
  }
  if (format === "md" || format === "both") {
    const md = renderResumeDraftMarkdown(draft);
    mdPath = await writeResumeMd(dataDir, slug, md);
  }

  return { style, format, htmlPath, mdPath, ...(validationWarnings ? { validationWarnings } : {}) };
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

// ── Clean revisions ───────────────────────────────────────────────────────────

export interface CleanOptions {
  /** Base slug to clean revisions for (e.g. "default"). */
  slug: string;
  /** If set, keep this specific revision slug and delete all others. */
  keep?: string;
  /** If true, only print what would be deleted without actually deleting. */
  dryRun?: boolean;
}

export interface CleanResult {
  deleted: string[];
  kept: string[];
}

/**
 * Remove intermediate revision files (resumes/ + agent/drafts/) for a given base slug.
 * Files matching `<base>-rev-*` are removed unless they match `keep`.
 */
export async function cleanRevisions(
  dataDir: string,
  options: CleanOptions,
): Promise<CleanResult> {
  const { slug, keep, dryRun = false } = options;
  const base = stripRevSuffix(slug);
  const revPattern = new RegExp(`^${base}-rev-[\\w-]+\\.(html|md)$`);
  const draftPattern = new RegExp(`^${base}-rev-[\\w-]+\\.(resume|revision)\\.json$`);

  const deleted: string[] = [];
  const kept: string[] = [];

  async function sweepDir(dir: string, pattern: RegExp): Promise<void> {
    let files: string[] = [];
    try { files = await readdir(dir); } catch { return; }
    for (const f of files) {
      if (!pattern.test(f)) continue;
      const stemMatch = f.match(/^(.+?)\.(html|md|resume\.json|revision\.json)$/);
      const fileStem = stemMatch?.[1] ?? f;
      if (keep && (fileStem === keep || f.startsWith(keep + "."))) {
        kept.push(join(dir, f));
        continue;
      }
      if (!dryRun) await unlink(join(dir, f));
      deleted.push(join(dir, f));
    }
  }

  await sweepDir(join(dataDir, "resumes"), revPattern);
  await sweepDir(join(dataDir, "agent", "drafts"), draftPattern);

  return { deleted, kept };
}
