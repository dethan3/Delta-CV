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
  bulletsWithVerbStart: number;
  averageLength: number;
}

export function computeBulletSpecificity(_bullets: string[]): BulletSpecificitySignals {
  // TODO(pr3-eval): regex-based shallow signals to feed the judge.
  throw new Error("computeBulletSpecificity: not implemented (PR3 skeleton)");
}

export interface FactGroundednessSignals {
  bulletsTotal: number;
  bulletsWithEvidenceRef: number;
  coverage: number;
}

export function computeFactGroundedness(
  _bullets: string[],
  _evidenceMap: Record<string, string[]>,
): FactGroundednessSignals {
  // TODO(pr3-eval): pure computation, no LLM.
  throw new Error("computeFactGroundedness: not implemented (PR3 skeleton)");
}

/** Aggregate per-case scores into the report's `aggregate` field. */
export function aggregateScores(
  _scores: Array<{ dimension: EvalDimension; score: number }>,
): EvalReport["aggregate"] {
  // TODO(pr3-eval): simple mean per dimension.
  throw new Error("aggregateScores: not implemented (PR3 skeleton)");
}
