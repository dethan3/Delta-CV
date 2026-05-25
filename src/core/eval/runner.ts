import type { Config } from "../schema/config.ts";
import type { EvalCase, EvalReport } from "../schema/eval.ts";

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
export async function runEval(_config: Config, _options: EvalRunOptions): Promise<EvalReport> {
  // TODO(pr3-eval): implement.
  throw new Error("runEval: not implemented (PR3 skeleton)");
}

/** Load all EvalCase descriptors from fixturesDir/index.json. */
export async function loadCases(_fixturesDir: string): Promise<EvalCase[]> {
  // TODO(pr3-eval): implement.
  throw new Error("loadCases: not implemented (PR3 skeleton)");
}
