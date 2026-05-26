import type { EvalDimension, EvalReport } from "../schema/eval.ts";

/**
 * Per-dimension scoring helpers used by the judge model wrapper.
 *
 * The judge is an LLM, but these helpers normalize inputs (e.g. extract bullet
 * texts, count evidence refs) so the judge prompt is small and consistent.
 */

export interface BulletSpecificitySignals {
  totalBullets: number;
  bulletsWithMetric: number;
  bulletsWithLowSignalMetric: number;
  bulletsWithVerbStart: number;
  averageLength: number;
}

const METRIC_RE =
  /(?:\d+(?:\.\d+)?\s*(?:%|x|k|m|ms|s|sec|seconds?|mins?|minutes?|hours?|dau|qps|rps|req\/s|users?))/i;
const LOW_SIGNAL_METRIC_RE =
  /\b\d[\d,]*(?:\.\d+)?\s+lines?\s+of\s+(?:new\s+)?code\b|\blines?\s+of\s+code\b|\bloc\b|\+\d[\d,]*\s+lines?\b|\bover\s+\d[\d,]*(?:,\d{3})*\s+lines?(?:\s+changed)?\b|\b\d[\d,]*(?:,\d{3})*\s+lines?\s+changed\b/i;
const VERB_START_RE =
  /^(built|designed|implemented|refactored|optimized|optimised|migrated|integrated|led|developed|architected|shipped|reduced|created|launched|构建|设计|实现|重构|优化|迁移|集成|主导|开发|搭建|封装|部署|推动)\b/i;

export function computeBulletSpecificity(bullets: string[]): BulletSpecificitySignals {
  const totalBullets = bullets.length;
  const bulletsWithMetric = bullets.filter((b) => METRIC_RE.test(b)).length;
  const bulletsWithLowSignalMetric = bullets.filter((b) => LOW_SIGNAL_METRIC_RE.test(b)).length;
  const bulletsWithVerbStart = bullets.filter((b) => VERB_START_RE.test(b.trim())).length;
  const averageLength =
    totalBullets === 0
      ? 0
      : bullets.reduce((sum, bullet) => sum + bullet.trim().length, 0) / totalBullets;
  return {
    totalBullets,
    bulletsWithMetric,
    bulletsWithLowSignalMetric,
    bulletsWithVerbStart,
    averageLength,
  };
}

export interface FactGroundednessSignals {
  bulletsTotal: number;
  bulletsWithEvidenceRef: number;
  coverage: number;
}

export function computeFactGroundedness(
  bullets: string[],
  evidenceMap: Record<string, string[]>,
): FactGroundednessSignals {
  const bulletsTotal = bullets.length;
  const projectIdsWithEvidence = Object.values(evidenceMap).filter(
    (refs) => refs.length > 0,
  ).length;
  const bulletsWithEvidenceRef = Math.min(
    bulletsTotal,
    projectIdsWithEvidence > 0 ? bulletsTotal : 0,
  );
  return {
    bulletsTotal,
    bulletsWithEvidenceRef,
    coverage: bulletsTotal === 0 ? 1 : bulletsWithEvidenceRef / bulletsTotal,
  };
}

/** Aggregate per-case scores into the report's `aggregate` field. */
export function aggregateScores(
  scores: Array<{ dimension: EvalDimension; score: number }>,
): EvalReport["aggregate"] {
  const dimensions: EvalDimension[] = [
    "selection_quality",
    "positioning_quality",
    "bullet_specificity",
    "fact_groundedness",
    "jd_alignment",
  ];
  return Object.fromEntries(
    dimensions.map((dimension) => {
      const values = scores.filter((s) => s.dimension === dimension).map((s) => s.score);
      const avg =
        values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
      return [dimension, Math.round(avg * 100) / 100];
    }),
  ) as EvalReport["aggregate"];
}
