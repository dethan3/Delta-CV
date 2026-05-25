import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compose } from "../pipeline.ts";
import { readResumeDraft, writeNarratives, writePlan } from "../io/data.ts";
import type { NarrativeLog } from "../schema/narrative.ts";
import type { ResumePlan } from "../schema/plan.ts";
import type { ResumeDraft } from "../schema/agent.ts";
import type { Config } from "../schema/config.ts";
import type { EvalCase, EvalDimension, EvalReport } from "../schema/eval.ts";
import { computeBulletSpecificity, computeFactGroundedness, aggregateScores } from "./metrics.ts";
import { verifyDraftFacts } from "../agent/verify-facts.ts";
import type { JdProfile } from "../schema/agent.ts";

export interface EvalRunOptions {
  /** Path to the directory containing fixture cases. */
  fixturesDir: string;
  /** Optional subset of case ids to run. */
  caseIds?: string[];
  /** Override LLM model used as judge. */
  judgeModel?: string;
}

/**
 * Run the full eval suite:
 *   for each EvalCase:
 *     1. seed a temp dataDir with the fixture's input snapshots
 *     2. run the pipeline up to compose (and verify-facts)
 *     3. ask the judge model to score along 5 dimensions
 *   aggregate scores into an EvalReport.
 */
export async function runEval(config: Config, options: EvalRunOptions): Promise<EvalReport> {
  const cases = await loadCases(options.fixturesDir);
  const selectedCases =
    options.caseIds && options.caseIds.length > 0
      ? cases.filter((c) => options.caseIds?.includes(c.id))
      : cases;

  const results: EvalReport["results"] = [];
  const allScores: Array<{ dimension: EvalDimension; score: number }> = [];

  for (const evalCase of selectedCases) {
    const caseDir = join(options.fixturesDir, evalCase.fixturePath);
    const draft = await materializeDraft(config, caseDir, evalCase);
    const narratives = await loadOptionalJson<NarrativeLog>(caseDir, "narratives.json");
    const verify = await verifyDraftFacts(
      { ...config.llm, apiKey: config.llm.apiKey ?? process.env.LLM_API_KEY ?? "" },
      draft,
      narratives?.narratives ?? [],
      {
        lang: config.language === "bilingual" ? "zh" : config.language,
        useLlm: false,
        draftSlug: evalCase.id,
      },
    );

    const bullets = draft.selectedProjects.flatMap((p) => p.bullets);
    const spec = computeBulletSpecificity(bullets);
    const fact = computeFactGroundedness(bullets, draft.evidenceMap);
    const jdProfile = await loadOptionalJson<JdProfile>(caseDir, "jd-profile.json");

    const scores: EvalReport["results"][number]["scores"] = [
      {
        dimension: "selection_quality",
        score: scoreSelectionQuality(draft),
        comment: "Heuristic score based on project count and section balance.",
      },
      {
        dimension: "positioning_quality",
        score: scorePositioningQuality(draft),
        comment: "Heuristic score based on headline clarity and summary completeness.",
      },
      {
        dimension: "bullet_specificity",
        score: scoreBulletSpecificity(spec),
        comment: "Heuristic score based on verbs, metrics, and average bullet length.",
      },
      {
        dimension: "fact_groundedness",
        score: scoreFactGroundedness(fact.coverage, verify.claims.length),
        comment: "Heuristic score based on coverage and verify-facts findings.",
      },
      {
        dimension: "jd_alignment",
        score: scoreJdAlignment(draft, jdProfile, evalCase.jdSlug),
        comment: "Heuristic score based on JD keyword overlap when a JD fixture exists.",
      },
    ];

    results.push({ caseId: evalCase.id, scores, draftSlug: evalCase.id });
    allScores.push(...scores.map((s) => ({ dimension: s.dimension, score: s.score })));
  }

  const report: EvalReport = {
    version: 1,
    generatedAt: new Date().toISOString(),
    results,
    aggregate: aggregateScores(allScores),
  };

  return report;
}

/** Load all EvalCase descriptors from fixturesDir/index.json. */
export async function loadCases(fixturesDir: string): Promise<EvalCase[]> {
  const filePath = join(fixturesDir, "index.json");
  try {
    const raw = await readFile(filePath, "utf8");
    return JSON.parse(raw) as EvalCase[];
  } catch (err: unknown) {
    if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw err;
  }
}

async function loadOptionalJson<T>(caseDir: string, filename: string): Promise<T | null> {
  try {
    const raw = await readFile(join(caseDir, filename), "utf8");
    return JSON.parse(raw) as T;
  } catch (err: unknown) {
    if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw err;
  }
}

async function materializeDraft(config: Config, caseDir: string, evalCase: EvalCase): Promise<ResumeDraft> {
  const prebuiltDraft = await loadOptionalJson<ResumeDraft>(caseDir, "draft.resume.json");
  if (prebuiltDraft) return prebuiltDraft;

  const experienceRaw = await loadOptionalJson<unknown>(caseDir, "experience.json");
  if (!experienceRaw) {
    throw new Error(`Eval case "${evalCase.id}" is missing draft.resume.json and experience.json.`);
  }

  const tmp = await mkdtemp(join(tmpdir(), "delta-eval-"));
  try {
    await mkdir(join(tmp, "_meta"), { recursive: true });
    await writeFile(join(tmp, "_meta", "experience.json"), JSON.stringify(experienceRaw, null, 2), "utf8");

    const narratives = await loadOptionalJson<NarrativeLog>(caseDir, "narratives.json");
    if (narratives) await writeNarratives(tmp, narratives);
    const plan = await loadOptionalJson<ResumePlan>(caseDir, "plan.json");
    if (plan) await writePlan(tmp, plan);

    const jdText = await readOptionalText(join(caseDir, "jd.txt"));
    await compose(config, tmp, {
      lang: config.language === "bilingual" ? "zh" : config.language,
      format: "md",
      slug: evalCase.id,
      ...(jdText ? { jd: jdText } : {}),
    });
    const draft = await readResumeDraft(tmp, evalCase.id);
    if (!draft) {
      throw new Error(`Eval case "${evalCase.id}" did not produce a draft.`);
    }
    return draft;
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

async function readOptionalText(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (err: unknown) {
    if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw err;
  }
}

function clampScore(value: number): number {
  return Math.max(0, Math.min(10, Math.round(value * 100) / 100));
}

function scoreSelectionQuality(draft: ResumeDraft): number {
  const projectCount = draft.selectedProjects.length;
  if (projectCount >= 3 && projectCount <= 6) return 8.5;
  if (projectCount === 2 || projectCount === 7) return 7;
  if (projectCount === 1) return 4;
  return 5;
}

function scorePositioningQuality(draft: ResumeDraft): number {
  const headlineScore = draft.headline.trim().length >= 12 ? 4 : 2.5;
  const summarySentenceCount = draft.summary.split(/[.!?。！？]/).filter((s) => s.trim().length > 0).length;
  const summaryScore = Math.min(4, summarySentenceCount >= 3 ? 4 : summarySentenceCount * 1.25);
  const skillScore = draft.skills.length > 0 ? 2 : 0.5;
  return clampScore(headlineScore + summaryScore + skillScore);
}

function scoreBulletSpecificity(spec: ReturnType<typeof computeBulletSpecificity>): number {
  if (spec.totalBullets === 0) return 0;
  const verbRatio = spec.bulletsWithVerbStart / spec.totalBullets;
  const metricRatio = spec.bulletsWithMetric / spec.totalBullets;
  const lengthFactor = spec.averageLength >= 35 ? 1 : spec.averageLength / 35;
  return clampScore(4 * verbRatio + 3 * metricRatio + 3 * lengthFactor);
}

function scoreFactGroundedness(coverage: number, issueCount: number): number {
  return clampScore(coverage * 10 - issueCount * 1.5);
}

function scoreJdAlignment(
  draft: ResumeDraft,
  jdProfile: JdProfile | null,
  jdSlug?: string,
): number {
  if (!jdSlug) return 5;
  if (!jdProfile) return 4;
  const text = [draft.headline, draft.summary, ...draft.skills.flatMap((s) => s.items), ...draft.selectedProjects.flatMap((p) => p.bullets)]
    .join(" ")
    .toLowerCase();
  const hits = jdProfile.requiredSkills.filter((skill) => text.includes(skill.toLowerCase())).length;
  return clampScore((hits / Math.max(1, jdProfile.requiredSkills.length)) * 10);
}
