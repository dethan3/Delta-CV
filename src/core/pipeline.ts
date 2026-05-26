import { readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { buildCapabilityClaims } from "./agent/capability.ts";
import { type ComposeOptions, composeDraft } from "./agent/compose.ts";
import { critiqueDraft } from "./agent/critique.ts";
import { buildEvidenceBundlesFromEntries } from "./agent/evidence.ts";
import { interpretBundles } from "./agent/interpret.ts";
import { matchNarrativesToJd } from "./agent/jd-match.ts";
import { parseJdProfile } from "./agent/jd-parse.ts";
import { scoreClaimsForJd, scoreProjectsForJd } from "./agent/jd-score.ts";
import { mergeExperienceEntries } from "./agent/merger.ts";
import { reviseDraft, stripRevSuffix } from "./agent/revise.ts";
import { scoreProjects } from "./agent/scorer.ts";
import { buildResumePlan, preFilterNarratives } from "./agent/select.ts";
import { verifyDraftFacts } from "./agent/verify-facts.ts";
import { readCursor, writeCursor } from "./collector/cursor.ts";
import { denoiseEvents } from "./collector/denoise.ts";
import { collectViaGraphQL } from "./collector/github-graphql.ts";
import { collectIssuesViaRest } from "./collector/github-rest.ts";
import { clusterEvents } from "./engine/cluster.ts";
import { buildTagFrequency, computeFocus } from "./engine/focus.ts";
import { buildSnapshot, diffSnapshots } from "./engine/snapshot.ts";
import { tagEvents } from "./engine/tag.ts";
import { generateEntryBatch } from "./engine/translate.ts";
import { runEval } from "./eval/runner.ts";
import {
  appendEvents,
  clearEvolveCheckpoint,
  readEventsSince,
  readEvidence,
  readEvolveCheckpoint,
  readExperienceLog,
  readJdMatchReport,
  readLatestSnapshot,
  readNarratives,
  readPlan,
  readResumeDraft,
  writeClaims,
  writeCritique,
  writeCurateResult,
  writeEvalReport,
  writeEvidence,
  writeEvolveCheckpoint,
  writeExperienceLog,
  writeJdMatchReport,
  writeJdProfile,
  writeNarratives,
  writePlan,
  writeProjects,
  writeResumeDraft,
  writeResumeHtml,
  writeResumeMd,
  writeRevision,
  writeSnapshot,
  writeTailoredResume,
  writeVerifyFactsReport,
} from "./io/data.ts";
import { RateLimitError } from "./llm.ts";
import { renderResumeDraftHtmlAgent } from "./render/html-agent.ts";
import { renderResumeDraftMarkdown } from "./render/markdown-v2.ts";
import { HTML_STYLES, type HtmlStyle, isHtmlStyle, isStaticStyle } from "./render/styles.ts";
import { renderBuiltInHtmlTemplate, renderCustomHtmlTemplate } from "./render/template.ts";
import { validateGeneratedHtml } from "./render/validate.ts";
import type {
  CritiqueResult,
  CurateResult,
  JdProfile,
  ResumeDraft,
  RevisionRecord,
} from "./schema/agent.ts";
import type { Config } from "./schema/config.ts";
import type { EvalReport, VerifyFactsReport } from "./schema/eval.ts";
import type { EvidenceLog } from "./schema/evidence.ts";
import type { ExperienceLog } from "./schema/experience.ts";
import type { NarrativeLog } from "./schema/narrative.ts";
import type { JdMatchReport, ResumePlan } from "./schema/plan.ts";
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
      if (smallBatch.length > 0) {
        batches.push(smallBatch);
        smallBatch = [];
      }
      batches.push([cluster]);
    } else {
      smallBatch.push(cluster);
      if (smallBatch.length >= BATCH_SIZE) {
        batches.push(smallBatch);
        smallBatch = [];
      }
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
      const batch = batches[myIdx];
      if (!batch) {
        return;
      }
      const firstCluster = batch[0];
      const lastCluster = batch[batch.length - 1];
      if (!firstCluster || !lastCluster) {
        continue;
      }

      const batchLabel =
        batch.length === 1
          ? `${firstCluster.repo} ${firstCluster.period.from.slice(0, 7)}`
          : `${batch.length} clusters (${firstCluster.repo} … ${lastCluster.repo})`;
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
      `[evolve] rate limit hit after ${doneIds.size}/${clusters.length} clusters. Checkpoint saved — run 'delta evolve' again to continue.`,
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

export interface EvidenceResult {
  log: EvidenceLog;
  evidencePath: string;
}

/**
 * Evidence: turn the existing ExperienceLog into an EvidenceLog (PR1-A bridge).
 *
 * This is a deliberately mechanical conversion with no LLM call. Its only
 * purpose is to land the new intermediate file format so the rest of the new
 * pipeline (interpret → select → compose) can be built and exercised before
 * we rewrite `evolve` to emit EvidenceBundle natively.
 *
 * Acceptance:
 * - Reading `data/_meta/experience.json` must produce `data/agent/evidence.json`
 *   with one EvidenceBundle per ExperienceEntry.
 * - Existing `curate`, `compose`, `tailor` commands continue to work unchanged.
 */
export async function evidence(dataDir: string): Promise<EvidenceResult> {
  const expLog = await readExperienceLog(dataDir);
  if (!expLog) {
    throw new Error("No experience log found. Run 'delta evolve' first.");
  }
  const log = buildEvidenceBundlesFromEntries(expLog.entries);
  const evidencePath = await writeEvidence(dataDir, log);
  console.log(
    `[evidence] wrote ${log.bundles.length} bundle${log.bundles.length === 1 ? "" : "s"} → ${evidencePath}`,
  );
  return { log, evidencePath };
}

export interface InterpretResult {
  log: NarrativeLog;
  narrativesPath: string;
}

export interface InterpretRunOptions {
  lang?: "zh" | "en";
  maxNarratives?: number;
}

/**
 * Interpret: AI-driven step that turns EvidenceBundle[] into ProjectNarrative[].
 *
 * This is the first stage where the LLM is allowed to:
 * - split one repo into multiple narratives (via workstreamHints)
 * - merge multi-repo bundles into a single narrative
 * - drop maintenance-only noise via riskFlags + low resumeWorthiness
 *
 * Reads `data/agent/evidence.json` (run `delta evidence` first) and writes
 * `data/agent/narratives.json`. Does not touch the legacy curate/compose path.
 */
export async function interpret(
  config: Config,
  dataDir: string,
  options: InterpretRunOptions = {},
): Promise<InterpretResult> {
  const apiKey = config.llm.apiKey ?? process.env.LLM_API_KEY;
  if (!apiKey) {
    throw new Error("LLM_API_KEY is required. Set it in your environment or .env.local file.");
  }
  const llmConfig = { ...config.llm, apiKey };

  const evLog = await readEvidence(dataDir);
  if (!evLog) {
    throw new Error("No evidence log found. Run 'delta evidence' first.");
  }
  if (evLog.bundles.length === 0) {
    throw new Error(
      "Evidence log contains zero bundles. Re-run 'delta evolve' then 'delta evidence'.",
    );
  }

  const lang: "zh" | "en" =
    options.lang ?? (config.language === "bilingual" ? "zh" : config.language);

  console.log(
    `[interpret] interpreting ${evLog.bundles.length} bundle${evLog.bundles.length === 1 ? "" : "s"} (lang: ${lang})`,
  );

  const interpretOptions: { lang: "zh" | "en"; maxNarratives?: number } = { lang };
  if (options.maxNarratives !== undefined) interpretOptions.maxNarratives = options.maxNarratives;

  const log = await interpretBundles(llmConfig, evLog.bundles, interpretOptions);
  const narrativesPath = await writeNarratives(dataDir, log);

  console.log(
    `[interpret] produced ${log.narratives.length} narrative${log.narratives.length === 1 ? "" : "s"} → ${narrativesPath}`,
  );
  if (log.narratives.length > 0) {
    for (const n of log.narratives) {
      console.log(
        `  [${n.resumeWorthiness.toFixed(2)}] ${n.title} (${n.repos.join(", ")})  ${n.candidateRole}`,
      );
    }
  }

  return { log, narrativesPath };
}

export interface SelectResult {
  plan: ResumePlan;
  planPath: string;
  prefilterDroppedCount: number;
}

export interface JdMatchResult {
  jdProfile: JdProfile;
  jdProfilePath: string;
  report: JdMatchReport;
  reportPath: string;
}

export interface JdMatchRunOptions {
  lang?: "zh" | "en";
  jdText: string;
  allowAdjacency?: boolean;
}

export interface SelectRunOptions {
  lang?: "zh" | "en";
  topN?: number;
  targetRole?: string;
  userHints?: string[];
  minWorthiness?: number;
  jdMatchSlug?: string;
}

/**
 * Select: LLM step that turns ProjectNarrative[] into a ResumePlan.
 *
 * - Reads `data/agent/narratives.json` (run `delta interpret` first).
 * - Pre-filters maintenance-only and below-floor worthiness deterministically.
 * - Lets the LLM pick selectedProjectIds, write selectionRationale, derive
 *   skillEmphasis. Defensive normalization clamps ids to known projectKeys.
 * - Writes `data/agent/plan.json`.
 *
 */
export async function select(
  config: Config,
  dataDir: string,
  options: SelectRunOptions = {},
): Promise<SelectResult> {
  const apiKey = config.llm.apiKey ?? process.env.LLM_API_KEY;
  if (!apiKey) {
    throw new Error("LLM_API_KEY is required. Set it in your environment or .env.local file.");
  }
  const llmConfig = { ...config.llm, apiKey };

  const narLog = await readNarratives(dataDir);
  if (!narLog) {
    throw new Error("No narratives log found. Run 'delta interpret' first.");
  }
  if (narLog.narratives.length === 0) {
    throw new Error("Narratives log is empty. Re-run 'delta interpret'.");
  }

  const lang: "zh" | "en" =
    options.lang ?? (config.language === "bilingual" ? "zh" : config.language);

  // Pre-filter visibility (the same logic runs again inside buildResumePlan;
  // here we just count for the log).
  const preMinW: { minWorthiness?: number } =
    options.minWorthiness !== undefined ? { minWorthiness: options.minWorthiness } : {};
  const { dropped } = preFilterNarratives(narLog.narratives, preMinW);

  console.log(
    `[select] ${narLog.narratives.length} narrative(s); pre-filter dropped ${dropped.length}; topN=${options.topN ?? 6} (lang: ${lang})`,
  );
  for (const d of dropped) {
    const flags = (d.riskFlags ?? []).map((f) => f.kind).join(",") || "low-worthiness";
    console.log(`  - dropped: ${d.title} [${flags}] worthiness=${d.resumeWorthiness.toFixed(2)}`);
  }

  const selectOptions: Parameters<typeof buildResumePlan>[2] = { lang };
  if (options.topN !== undefined) selectOptions.topN = options.topN;
  if (options.targetRole) selectOptions.targetRole = options.targetRole;
  if (options.userHints && options.userHints.length > 0)
    selectOptions.userHints = options.userHints;
  if (options.minWorthiness !== undefined) selectOptions.minWorthiness = options.minWorthiness;
  if (options.jdMatchSlug) {
    const report = await readJdMatchReport(dataDir, options.jdMatchSlug);
    if (!report) {
      throw new Error(
        `No jd-match report found for slug "${options.jdMatchSlug}". Run 'delta jd-match' first.`,
      );
    }
    selectOptions.jdMatches = report.matches;
    selectOptions.jdSlug = report.jdSlug;
  }

  const plan = await buildResumePlan(llmConfig, narLog.narratives, selectOptions);
  const planPath = await writePlan(dataDir, plan);

  console.log(
    `[select] selected ${plan.selectedProjectIds.length}, deprioritized ${plan.deprioritizedProjectIds.length} → ${planPath}`,
  );
  console.log(`  positioning: ${plan.positioning}`);
  plan.selectedProjectIds.forEach((id, i) => {
    console.log(`  ${i + 1}. ${id}`);
  });
  if (plan.skillEmphasis.length > 0) {
    console.log(`  skillEmphasis: ${plan.skillEmphasis.map((s) => s.name).join(", ")}`);
  }
  if (plan.supportingProjectIds.length > 0) {
    console.log(`  supporting: ${plan.supportingProjectIds.length}`);
  }

  return { plan, planPath, prefilterDroppedCount: dropped.length };
}

/**
 * JD Match: parse a JD, score each narrative against it, and persist the report.
 */
export async function jdMatch(
  config: Config,
  dataDir: string,
  options: JdMatchRunOptions,
): Promise<JdMatchResult> {
  const apiKey = config.llm.apiKey ?? process.env.LLM_API_KEY;
  if (!apiKey) {
    throw new Error("LLM_API_KEY is required. Set it in your environment or .env.local file.");
  }
  const llmConfig = { ...config.llm, apiKey };

  const narLog = await readNarratives(dataDir);
  if (!narLog) {
    throw new Error("No narratives log found. Run 'delta interpret' first.");
  }
  if (narLog.narratives.length === 0) {
    throw new Error("Narratives log is empty. Re-run 'delta interpret'.");
  }

  const lang: "zh" | "en" =
    options.lang ?? (config.language === "bilingual" ? "zh" : config.language);

  const jdProfile = await parseJdProfile(llmConfig, options.jdText, lang);
  const jdProfilePath = await writeJdProfile(dataDir, jdProfile);
  const report = await matchNarrativesToJd(llmConfig, narLog.narratives, jdProfile, {
    lang,
    ...(options.allowAdjacency !== undefined ? { allowAdjacency: options.allowAdjacency } : {}),
  });
  const reportPath = await writeJdMatchReport(dataDir, report);

  console.log(
    `[jd-match] "${jdProfile.jobTitle}" → ${report.matches.length} narrative match(es) written`,
  );

  return { jdProfile, jdProfilePath, report, reportPath };
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
  verifyFacts: VerifyFactsReport | null;
  verifyFactsPath: string | null;
}

export interface ComposeRunOptions extends ComposeOptions {
  format?: "html" | "md" | "both";
  style?: "clean" | "developer" | "compact";
  slug?: string;
  topN?: number;
  legacy?: boolean;
}

/**
 * Compose: default to the new agent path (interpret → select → compose).
 * Falls back to the legacy curate → compose path only when `options.legacy`
 * is explicitly set.
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
  const lang = options.lang ?? (config.language === "bilingual" ? "zh" : config.language);

  if (options.legacy) {
    const log = await readExperienceLog(dataDir);
    if (!log) {
      throw new Error("No experience log found. Run 'delta evolve' first.");
    }

    const topN = options.topN ?? 6;
    const drafts = mergeExperienceEntries(log.entries);
    const scored = scoreProjects(drafts);
    const claims = buildCapabilityClaims(scored);

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
        `[compose:legacy] JD parsed: "${jdProfile.jobTitle}" (${jdProfile.seniority}) — ${jdProfile.requiredSkills.length} required skills`,
      );
    }

    const curateResult: CurateResult = {
      version: 1,
      generatedAt: new Date().toISOString(),
      projects: finalProjects,
      claims: finalClaims,
    };

    const legacyPlan = {
      version: 1 as const,
      generatedAt: new Date().toISOString(),
      positioning: options.targetRole ?? "Generalist software engineer",
      selectedProjectIds: curateResult.projects.slice(0, topN).map((p) => p.id),
      selectionRationale: "Legacy compose path derived selected projects from curate ranking.",
      deprioritizedProjectIds: curateResult.projects.slice(topN).map((p) => p.id),
      supportingProjectIds: [],
      skillEmphasis: [],
      projectEmphasis: [],
      styleHints: [],
      ...(options.targetRole ? { targetRole: options.targetRole } : {}),
      ...(options.jd && jdProfile ? { jdSlug: jdProfile.slug } : {}),
    };

    const legacyNarratives = curateResult.projects.map((project) => ({
      projectKey: project.id,
      title: project.title,
      period: project.period,
      scope: project.highlights
        .map((h) => h.text)
        .slice(0, 2)
        .join(" "),
      candidateRole: "contributor",
      coreProblem: project.highlights[0]?.text ?? project.title,
      solutionShape: project.highlights
        .slice(1, 3)
        .map((h) => h.text)
        .join(" "),
      proofPoints: project.highlights.map((h) => ({
        text: h.text,
        kind: "shipped",
        evidenceRefs: h.evidence && h.evidence.length > 0 ? h.evidence : project.evidenceEntryIds,
        strength: "moderate" as const,
      })),
      techStack: project.stack,
      strengthSignals: project.tags,
      riskFlags: project.weakSignals.map((signal) => ({ kind: signal })),
      resumeWorthiness: project.importance,
      sourceEvidenceIds:
        project.evidenceEntryIds.length > 0 ? project.evidenceEntryIds : [project.id],
      repos: [project.repo],
    }));

    const draft = await composeDraft(llmConfig, config.login, legacyPlan, legacyNarratives, {
      lang,
      ...(options.targetRole ? { targetRole: options.targetRole } : {}),
      ...(options.jd ? { jd: options.jd } : {}),
    });

    const slug = options.slug ?? (jdProfile ? jdProfile.slug : "default");
    const draftPath = await writeResumeDraft(dataDir, slug, draft);
    const verifyFacts = await verifyDraftFacts(llmConfig, draft, legacyNarratives, {
      lang,
      useLlm: false,
      draftSlug: slug,
    });
    const verifyFactsPath = await writeVerifyFactsReport(dataDir, slug, verifyFacts);

    const format = options.format ?? "both";
    const style = options.style ?? "clean";
    let htmlPath: string | null = null;
    let mdPath: string | null = null;

    if (format === "html" || format === "both") {
      const rendered = await renderBuiltInStyleHtml(draft, style);
      htmlPath = await writeResumeHtml(dataDir, slug, rendered.html);
    }
    if (format === "md" || format === "both") {
      const md = renderResumeDraftMarkdown(draft);
      mdPath = await writeResumeMd(dataDir, slug, md);
    }

    return {
      draft,
      draftPath,
      htmlPath,
      mdPath,
      jdProfile,
      jdProfilePath,
      verifyFacts,
      verifyFactsPath,
    };
  }

  let jdProfile: JdProfile | null = null;
  let jdProfilePath: string | null = null;
  let jdMatchReport: JdMatchReport | null = null;

  let narLog = await readNarratives(dataDir);
  if (!narLog) {
    const log = await readExperienceLog(dataDir);
    if (!log) {
      throw new Error("No experience log found. Run 'delta evolve' first.");
    }
    const evidenceLog = buildEvidenceBundlesFromEntries(log.entries);
    await writeEvidence(dataDir, evidenceLog);
    narLog = await interpretBundles(llmConfig, evidenceLog.bundles, { lang });
    await writeNarratives(dataDir, narLog);
    console.log(`[compose] generated ${narLog.narratives.length} narrative(s) from experience log`);
  }
  if (narLog.narratives.length === 0) {
    throw new Error("Narratives log is empty. Run 'delta interpret' again after collecting data.");
  }

  if (options.jd) {
    jdProfile = await parseJdProfile(llmConfig, options.jd, lang);
    jdProfilePath = await writeJdProfile(dataDir, jdProfile);
    jdMatchReport = await matchNarrativesToJd(llmConfig, narLog.narratives, jdProfile, { lang });
    await writeJdMatchReport(dataDir, jdMatchReport);
    console.log(
      `[compose] JD parsed: "${jdProfile.jobTitle}" (${jdProfile.seniority}) — ${jdProfile.requiredSkills.length} required skills; ${jdMatchReport.matches.length} narrative match(es)`,
    );
  }

  const existingPlan = await readPlan(dataDir);
  const shouldRebuildPlan =
    !existingPlan ||
    options.targetRole !== undefined ||
    options.jd !== undefined ||
    (options.topN !== undefined && existingPlan.selectedProjectIds.length > options.topN);

  let plan = shouldRebuildPlan ? null : existingPlan;
  if (!plan) {
    const selectOptions: Parameters<typeof buildResumePlan>[2] = { lang };
    if (options.topN !== undefined) selectOptions.topN = options.topN;
    if (options.targetRole) selectOptions.targetRole = options.targetRole;
    else if (jdProfile) selectOptions.targetRole = jdProfile.jobTitle;
    if (jdProfile) selectOptions.jdSlug = jdProfile.slug;
    if (jdMatchReport) selectOptions.jdMatches = jdMatchReport.matches;
    plan = await buildResumePlan(llmConfig, narLog.narratives, selectOptions);
    await writePlan(dataDir, plan);
    const { dropped } = preFilterNarratives(narLog.narratives);
    console.log(
      `[compose] built plan with ${plan.selectedProjectIds.length} selected project(s); pre-filter dropped ${dropped.length}`,
    );
  }

  const composeOpts: ComposeOptions = { lang };
  if (options.targetRole) composeOpts.targetRole = options.targetRole;
  else if (plan.targetRole) composeOpts.targetRole = plan.targetRole;
  else if (jdProfile) composeOpts.targetRole = jdProfile.jobTitle;
  if (options.jd) composeOpts.jd = options.jd;

  const draft = await composeDraft(llmConfig, config.login, plan, narLog.narratives, composeOpts);

  const slug = options.slug ?? (jdProfile ? jdProfile.slug : "default");
  const draftPath = await writeResumeDraft(dataDir, slug, draft);
  const verifyFacts = await verifyDraftFacts(llmConfig, draft, narLog.narratives, {
    lang,
    useLlm: false,
    draftSlug: slug,
  });
  const verifyFactsPath = await writeVerifyFactsReport(dataDir, slug, verifyFacts);

  const format = options.format ?? "both";
  const style = options.style ?? "clean";
  let htmlPath: string | null = null;
  let mdPath: string | null = null;

  if (format === "html" || format === "both") {
    const rendered = await renderBuiltInStyleHtml(draft, style);
    htmlPath = await writeResumeHtml(dataDir, slug, rendered.html);
  }
  if (format === "md" || format === "both") {
    const md = renderResumeDraftMarkdown(draft);
    mdPath = await writeResumeMd(dataDir, slug, md);
  }

  return {
    draft,
    draftPath,
    htmlPath,
    mdPath,
    jdProfile,
    jdProfilePath,
    verifyFacts,
    verifyFactsPath,
  };
}

export interface CritiqueRunResult {
  critique: CritiqueResult;
  critiquePath: string;
}

export interface VerifyFactsRunResult {
  report: VerifyFactsReport;
  reportPath: string;
}

export interface EvalRunResult {
  report: EvalReport;
  reportPath: string;
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
    throw new Error(`No resume draft found for slug "${slug}". Run 'delta compose' first.`);
  }

  const lang = config.language === "bilingual" ? "zh" : config.language;
  const critiqueResult = await critiqueDraft(llmConfig, draft, slug, lang);
  const critiquePath = await writeCritique(dataDir, slug, critiqueResult);

  return { critique: critiqueResult, critiquePath };
}

/**
 * Verify facts on an existing ResumeDraft and persist the report.
 */
export async function verifyFacts(
  config: Config,
  dataDir: string,
  slug = "default",
  options: { useLlm?: boolean } = {},
): Promise<VerifyFactsRunResult> {
  const apiKey = config.llm.apiKey ?? process.env.LLM_API_KEY;
  if (!apiKey) {
    throw new Error("LLM_API_KEY is required. Set it in your environment or .env.local file.");
  }
  const llmConfig = { ...config.llm, apiKey };
  const draft = await readResumeDraft(dataDir, slug);
  if (!draft) {
    throw new Error(`No resume draft found for slug "${slug}". Run 'delta compose' first.`);
  }

  const narLog = await readNarratives(dataDir);
  if (!narLog) {
    throw new Error("No narratives log found. Run 'delta interpret' first.");
  }

  const lang = config.language === "bilingual" ? "zh" : config.language;
  const report = await verifyDraftFacts(llmConfig, draft, narLog.narratives, {
    lang,
    useLlm: options.useLlm ?? false,
    draftSlug: slug,
  });
  const reportPath = await writeVerifyFactsReport(dataDir, slug, report);
  return { report, reportPath };
}

/**
 * Run regression eval and persist the report.
 */
export async function evalPipeline(
  config: Config,
  dataDir: string,
  options: { fixturesDir: string; caseIds?: string[] } = { fixturesDir: "src/core/eval/fixtures" },
): Promise<EvalRunResult> {
  const report = await runEval(config, {
    fixturesDir: options.fixturesDir,
    ...(options.caseIds && options.caseIds.length > 0 ? { caseIds: options.caseIds } : {}),
  });
  const reportPath = await writeEvalReport(dataDir, "latest", report);
  return { report, reportPath };
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
    throw new Error(`No resume draft found for slug "${slug}". Run 'delta compose' first.`);
  }

  const lang = config.language === "bilingual" ? "zh" : config.language;
  const record = await reviseDraft(llmConfig, draft, slug, instruction, lang, dataDir);
  const { draftPath } = await writeRevision(dataDir, record);

  const format = options.format ?? "both";
  let htmlPath: string | null = null;
  let mdPath: string | null = null;

  if (format === "html" || format === "both") {
    const rendered = await renderBuiltInStyleHtml(record.draft, "clean");
    htmlPath = await writeResumeHtml(dataDir, record.slug, rendered.html);
  }
  if (format === "md" || format === "both") {
    const md = renderResumeDraftMarkdown(record.draft);
    mdPath = await writeResumeMd(dataDir, record.slug, md);
  }

  return { record, draftPath, htmlPath, mdPath };
}

export interface RenderRunResult {
  style: string;
  format: "html" | "md" | "both";
  htmlPath: string | null;
  mdPath: string | null;
  templateName?: string;
  validationWarnings?: string[];
}

async function renderBuiltInStyleHtml(
  draft: ResumeDraft,
  style: "clean" | "developer" | "compact",
) {
  const meta = HTML_STYLES[style];
  if (!meta.templateAssetPath) {
    throw new Error(`Style "${style}" has no template asset configured.`);
  }
  return renderBuiltInHtmlTemplate(draft, meta.templateAssetPath);
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
    template?: string;
    config?: Config;
  } = {},
): Promise<RenderRunResult> {
  const slug = options.slug ?? "default";
  const format = options.format ?? "both";
  const styleArg = options.style ?? "clean";

  if (!options.template && !isHtmlStyle(styleArg)) {
    throw new Error(
      `Unknown style "${styleArg}". Available: ${["clean", "developer", "compact", "agent"].join(", ")}`,
    );
  }
  const style: HtmlStyle = isHtmlStyle(styleArg) ? styleArg : "clean";

  if (!options.template && style === "agent") {
    if (!options.instruction) {
      throw new Error(
        `--style agent requires --instruction. E.g. --instruction "深色极简风格，适合 AI 工程师"`,
      );
    }
    if (!options.config) {
      throw new Error("--style agent requires LLM config. Pass config to render().");
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
  let templateName: string | undefined;
  let validationWarnings: string[] | undefined;

  if (format === "html" || format === "both") {
    let html: string;
    if (options.template) {
      const rendered = await renderCustomHtmlTemplate(draft, options.template);
      html = rendered.html;
      templateName = rendered.templateName;
      const validation = validateGeneratedHtml(html, draft);
      validationWarnings = [...validation.errors, ...validation.warnings];
    } else if (style === "agent") {
      const cfg = options.config;
      const instruction = options.instruction;
      if (!cfg || !instruction) {
        throw new Error("Agent render requires config and instruction.");
      }
      const apiKey = cfg.llm.apiKey ?? process.env.LLM_API_KEY ?? "";
      const llmConfig = { ...cfg.llm, apiKey };
      const lang = cfg.language === "bilingual" ? "zh" : cfg.language;
      html = await renderResumeDraftHtmlAgent(llmConfig, draft, instruction, lang);
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
      const rendered = await renderBuiltInStyleHtml(draft, style);
      html = rendered.html;
      templateName = rendered.templateName;
    }
    const outputSuffix = options.template ? (templateName ?? "custom-template") : style;
    htmlPath = await writeResumeHtml(dataDir, `${slug}-${outputSuffix}`, html);
  }
  if (format === "md" || format === "both") {
    const md = renderResumeDraftMarkdown(draft);
    mdPath = await writeResumeMd(dataDir, slug, md);
  }

  return {
    style: options.template ? `template:${templateName ?? "custom"}` : style,
    format,
    htmlPath,
    mdPath,
    ...(templateName ? { templateName } : {}),
    ...(validationWarnings ? { validationWarnings } : {}),
  };
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
export async function cleanRevisions(dataDir: string, options: CleanOptions): Promise<CleanResult> {
  const { slug, keep, dryRun = false } = options;
  const base = stripRevSuffix(slug);
  const revPattern = new RegExp(`^${base}-rev-[\\w-]+\\.(html|md)$`);
  const draftPattern = new RegExp(`^${base}-rev-[\\w-]+\\.(resume|revision)\\.json$`);

  const deleted: string[] = [];
  const kept: string[] = [];

  async function sweepDir(dir: string, pattern: RegExp): Promise<void> {
    let files: string[] = [];
    try {
      files = await readdir(dir);
    } catch {
      return;
    }
    for (const f of files) {
      if (!pattern.test(f)) continue;
      const stemMatch = f.match(/^(.+?)\.(html|md|resume\.json|revision\.json)$/);
      const fileStem = stemMatch?.[1] ?? f;
      if (keep && (fileStem === keep || f.startsWith(`${keep}.`))) {
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
