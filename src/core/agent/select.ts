import { z } from "zod";
import { generateObject } from "../llm.ts";
import { loadPrompt } from "../prompts.ts";
import type { LlmConfig } from "../schema/config.ts";
import type { ProjectNarrative } from "../schema/narrative.ts";
import { type JdMatch, type ResumePlan, SkillEmphasisSchema } from "../schema/plan.ts";

export interface SelectOptions {
  lang: "zh" | "en";
  /** Final number of selected projects. */
  topN?: number;
  /** When provided, jd-match data biases positioning and ordering. */
  jdMatches?: JdMatch[];
  /** Optional JD slug to stamp into the plan for traceability. */
  jdSlug?: string;
  /** One-line target role to bias positioning. */
  targetRole?: string;
  /** Free-form user hints (e.g. "我想突出 LLM ops"). */
  userHints?: string[];
  /** Floor for resumeWorthiness; strictly below this is pre-filtered. */
  minWorthiness?: number;
}

const DEFAULT_TOP_N = 6;
const DEFAULT_MIN_WORTHINESS = 0.2;

const SYSTEM_SCHEMA = `
Output ONLY valid JSON (no markdown fences) matching this exact schema:
{
  "positioning": "string (one-line candidate positioning)",
  "targetRole": "string (optional, echo back only if user provided one)",
  "selectedProjectIds": ["string (projectKey from input, in final desired order)"],
  "selectionRationale": "string (why these projects, why this order — 2-4 sentences)",
  "deprioritizedProjectIds": ["string (projectKeys intentionally dropped)"],
  "skillEmphasis": [
    {
      "name": "string (capability name)",
      "rationale": "string (one short sentence pointing to which projects prove it)",
      "supportingProjectIds": ["string (subset of selectedProjectIds)"]
    }
  ],
  "styleHints": ["string (soft hints for the compose stage)"]
}
Hard constraints:
- selectedProjectIds MUST be a subset of input projectKey values; never invent keys.
- Every input narrative gets a verdict: it appears in EITHER selectedProjectIds OR
  deprioritizedProjectIds — not both, not neither.
- selectedProjectIds.length MUST be <= topN.
- skillEmphasis[*].supportingProjectIds MUST be a subset of selectedProjectIds.
- DO NOT select any narrative whose riskFlags contain { "kind": "maintenance-only" }
  (these are pre-filtered out anyway).
- selectionRationale must be substantive — not a one-line placeholder.
`;

const LlmOutputSchema = z.object({
  positioning: z.string(),
  targetRole: z.string().optional(),
  selectedProjectIds: z.array(z.string()),
  selectionRationale: z.string(),
  deprioritizedProjectIds: z.array(z.string()).default([]),
  skillEmphasis: z.array(SkillEmphasisSchema).default([]),
  styleHints: z.array(z.string()).default([]),
});

export interface PreFilterResult {
  kept: ProjectNarrative[];
  dropped: ProjectNarrative[];
}

/**
 * Deterministic pre-filter (no LLM). Removes narratives unambiguously unfit
 * for the resume so the LLM doesn't waste context arguing about them.
 *
 * Drop rules:
 * - riskFlags contains { kind: "maintenance-only" }
 * - resumeWorthiness strictly below `minWorthiness` (default 0.2)
 *
 * Borderline narratives (worthiness in [0.2, 0.5), or higher with concerning
 * flags) are kept and surfaced to the LLM; the LLM may still deprioritize
 * them, leaving an audit trail in deprioritizedProjectIds.
 */
export function preFilterNarratives(
  narratives: ProjectNarrative[],
  options: { minWorthiness?: number } = {},
): PreFilterResult {
  const minW = options.minWorthiness ?? DEFAULT_MIN_WORTHINESS;
  const kept: ProjectNarrative[] = [];
  const dropped: ProjectNarrative[] = [];
  for (const n of narratives) {
    const isMaintenanceOnly = n.riskFlags?.some((f) => f.kind === "maintenance-only") ?? false;
    const tooWeak = n.resumeWorthiness < minW;
    if (isMaintenanceOnly || tooWeak) {
      dropped.push(n);
    } else {
      kept.push(n);
    }
  }
  return { kept, dropped };
}

function formatNarrativesForPrompt(
  narratives: ProjectNarrative[],
  options: SelectOptions & { topN: number },
): string {
  const compact = narratives.map((n) => ({
    projectKey: n.projectKey,
    title: n.title,
    period: `${n.period.from.slice(0, 10)} → ${n.period.to.slice(0, 10)}`,
    repos: n.repos,
    candidateRole: n.candidateRole,
    coreProblem: n.coreProblem,
    solutionShape: n.solutionShape,
    proofPoints: n.proofPoints.map((pp) => ({
      text: pp.text,
      kind: pp.kind,
      strength: pp.strength,
    })),
    techStack: n.techStack,
    strengthSignals: n.strengthSignals,
    riskFlags: n.riskFlags,
    resumeWorthiness: n.resumeWorthiness,
  }));
  const meta: Record<string, unknown> = { topN: options.topN };
  if (options.targetRole) meta.targetRole = options.targetRole;
  if (options.userHints && options.userHints.length > 0) meta.userHints = options.userHints;
  if (options.jdMatches && options.jdMatches.length > 0) {
    meta.jdMatches = options.jdMatches.map((m) => ({
      projectId: m.projectId,
      relevanceScore: m.relevanceScore,
      matchedRequirements: m.matchedRequirements,
      adjacentStrengths: m.adjacentStrengths,
      bestAngle: m.bestAngle,
      doNotOverclaim: m.doNotOverclaim,
    }));
  }
  return JSON.stringify({ ...meta, narratives: compact }, null, 2);
}

/**
 * Decide which narratives appear on the final resume, in what order, and the
 * candidate's overall positioning.
 *
 * Flow:
 *   1. Pre-filter (deterministic): drop maintenance-only + below-floor worthiness.
 *   2. LLM call (single): pick selectedProjectIds, write selectionRationale,
 *      derive skillEmphasis.
 *   3. Normalize: clamp ids to known projectKeys, ensure every kept narrative
 *      has a verdict, truncate to topN, derive skillEmphasis support set.
 *
 * Notes:
 * - pre-filtered narratives are NOT surfaced to the LLM and do NOT appear in
 *   deprioritizedProjectIds — the audit trail for those is in preFilterNarratives.
 * - When jdMatches is given the model biases positioning, but doNotOverclaim
 *   enforcement is the verify-facts stage's job, not select's.
 */
export async function buildResumePlan(
  llmConfig: LlmConfig,
  narratives: ProjectNarrative[],
  options: SelectOptions,
): Promise<ResumePlan> {
  const topN = options.topN ?? DEFAULT_TOP_N;
  const { kept } = preFilterNarratives(narratives, {
    ...(options.minWorthiness !== undefined ? { minWorthiness: options.minWorthiness } : {}),
  });

  if (kept.length === 0) {
    throw new Error(
      "select: no narratives survived pre-filter. Lower --min-worthiness or re-run interpret.",
    );
  }

  const systemBase = await loadPrompt("select", options.lang);
  const system = `${systemBase}\n${SYSTEM_SCHEMA}\nThe topN ceiling for this run is ${topN}.`;
  const user = formatNarrativesForPrompt(kept, { ...options, topN });

  const out = await generateObject(llmConfig, LlmOutputSchema, system, user);

  // ── Defensive normalization ──────────────────────────────────────────────
  const knownKeys = new Set(kept.map((n) => n.projectKey));

  // Clamp selected ids: must be known, dedupe, preserve order, truncate to topN.
  const selectedSeen = new Set<string>();
  const selectedProjectIds: string[] = [];
  for (const id of out.selectedProjectIds) {
    if (!knownKeys.has(id) || selectedSeen.has(id)) continue;
    selectedSeen.add(id);
    selectedProjectIds.push(id);
    if (selectedProjectIds.length >= topN) break;
  }

  // Clamp deprioritized: must be known and not also selected.
  const deprioritizedSeen = new Set<string>();
  const deprioritizedProjectIds: string[] = [];
  for (const id of out.deprioritizedProjectIds ?? []) {
    if (!knownKeys.has(id) || selectedSeen.has(id) || deprioritizedSeen.has(id)) continue;
    deprioritizedSeen.add(id);
    deprioritizedProjectIds.push(id);
  }

  // Every kept narrative must have a verdict. Force missing into deprioritized.
  for (const n of kept) {
    if (!selectedSeen.has(n.projectKey) && !deprioritizedSeen.has(n.projectKey)) {
      deprioritizedSeen.add(n.projectKey);
      deprioritizedProjectIds.push(n.projectKey);
    }
  }

  if (selectedProjectIds.length === 0) {
    throw new Error(
      "select: LLM returned no valid selectedProjectIds. Check that projectKeys in the input match what the model echoed back.",
    );
  }

  // skillEmphasis: drop entries whose supportingProjectIds, after clamping,
  // are not a non-empty subset of selectedProjectIds.
  const skillEmphasis = (out.skillEmphasis ?? [])
    .map((s) => ({
      name: s.name,
      rationale: s.rationale,
      supportingProjectIds: (s.supportingProjectIds ?? []).filter((id) => selectedSeen.has(id)),
    }))
    .filter((s) => s.supportingProjectIds.length > 0);

  const plan: ResumePlan = {
    version: 1,
    generatedAt: new Date().toISOString(),
    positioning: out.positioning,
    selectedProjectIds,
    selectionRationale: out.selectionRationale,
    deprioritizedProjectIds,
    skillEmphasis,
    styleHints: out.styleHints ?? [],
  };
  if (options.targetRole) plan.targetRole = options.targetRole;
  else if (out.targetRole) plan.targetRole = out.targetRole;
  if (options.jdSlug) plan.jdSlug = options.jdSlug;

  return plan;
}
