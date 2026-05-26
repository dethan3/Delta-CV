import { z } from "zod";
import { generateObject } from "../llm.ts";
import { loadPrompt } from "../prompts.ts";
import type { LlmConfig } from "../schema/config.ts";
import type { EvidenceBundle } from "../schema/evidence.ts";
import {
  type NarrativeLog,
  type ProjectNarrative,
  ProjectNarrativeSchema,
} from "../schema/narrative.ts";

export interface InterpretOptions {
  lang: "zh" | "en";
  /** Soft target: how many narratives to aim for. The LLM may return fewer. */
  maxNarratives?: number;
}

const SYSTEM_SCHEMA = `
Output ONLY valid JSON (no markdown fences) matching this exact schema:
{
  "narratives": [
    {
      "projectKey": "string (stable identifier, snake_case)",
      "title": "string (2-8 words)",
      "period": { "from": "ISO date string", "to": "ISO date string" },
      "scope": "string (1-2 sentences)",
      "candidateRole": "owner | contributor | maintainer | reviewer",
      "coreProblem": "string (the problem this project tried to solve)",
      "solutionShape": "string (architecture / approach / key trade-offs)",
      "proofPoints": [
        {
          "text": "string",
          "kind": "metric | shipped | ownership | design | process",
          "evidenceRefs": ["string (EvidenceBundle.id or move evidenceRef)"],
          "strength": "strong | moderate | soft"
        }
      ],
      "techStack": ["string"],
      "strengthSignals": ["string (e.g. 'cross-team', 'ownership', 'production-impact')"],
      "riskFlags": [{ "kind": "string", "note": "string (optional)" }],
      "resumeWorthiness": "number in [0,1]",
      "sourceEvidenceIds": ["string (must reference input EvidenceBundle.id)"],
      "repos": ["string (at least one)"]
    }
  ]
}
Hard constraints:
- proofPoints[*].evidenceRefs MUST be drawn from the input bundles: either a
  bundle id, or a value already appearing in some technicalMoves[*].evidenceRefs
  / possibleOutcomes[*].evidenceRefs / explicitEvidence[*].evidenceRefs.
  Any unknown ref will be silently dropped by the verifier; a proofPoint with
  zero surviving refs disqualifies the entire narrative.
- sourceEvidenceIds MUST contain at least one id present in the input bundles.
- repos MUST be a subset of the repos present in the input bundles. Do not
  invent repo names.
- projectKey: you may write any placeholder; it will be REPLACED by a
  deterministic key downstream. Do not rely on your value being preserved.
- Maintenance-only narratives: set resumeWorthiness < 0.3 AND include a riskFlag { "kind": "maintenance-only" }.
- Do NOT invent technologies that do not appear in any input bundle's stack or tags.
`;

const LlmOutputSchema = z.object({
  narratives: z.array(ProjectNarrativeSchema),
});
const DOCS_SUPPORT_RE =
  /\b(docs?|documentation|wiki|translation|translated|article|guide|content|community|study group)\b/i;
const LOW_SIGNAL_METRIC_RE =
  /\b\d[\d,]*(?:\.\d+)?\s+lines?\s+of\s+(?:new\s+)?code\b|\+\d[\d,]*\s+lines?\b|\bover\s+\d[\d,]*(?:,\d{3})*\s+lines?(?:\s+changed)?\b|\b\d[\d,]*(?:,\d{3})*\s+lines?\s+changed\b/i;
const DOCS_STACK = new Set(["markdown", "md", "git"]);

/** Slug-safe stable key from sorted repos + optional workstream label. */
export function makeProjectKey(repos: string[], workstream?: string): string {
  const repoPart = [...new Set(repos)]
    .sort()
    .map((r) => r.replace(/[^\w-]/g, "_"))
    .join("__");
  if (!workstream) return repoPart;
  const wsSlug = workstream
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  return wsSlug ? `${repoPart}::${wsSlug}` : repoPart;
}

/**
 * Deterministic projectKey from (repos, sourceEvidenceIds).
 *
 * Goal: given the same set of evidence bundles clustered into the same group,
 * always produce the same projectKey across runs. We do NOT trust the LLM to
 * generate stable keys.
 *
 * Shape: `<repoSlug>::<8charHashOfSortedSourceIds>`.
 * - The repo slug encodes which repos the narrative spans.
 * - The hash disambiguates multiple narratives sharing the same repos
 *   (single-repo workstream splits).
 */
export function makeStableProjectKey(repos: string[], sourceEvidenceIds: string[]): string {
  const base = makeProjectKey(repos);
  // Lightweight non-crypto hash (FNV-1a 32-bit), deterministic and dependency-free.
  const sortedIds = [...sourceEvidenceIds].sort().join("|");
  let h = 0x811c9dc5;
  for (let i = 0; i < sortedIds.length; i++) {
    h ^= sortedIds.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  const hash = h.toString(16).padStart(8, "0").slice(0, 8);
  return `${base}::${hash}`;
}

function formatBundlesForPrompt(bundles: EvidenceBundle[]): string {
  // Keep the prompt compact: only fields the interpreter actually needs.
  const compact = bundles.map((b) => ({
    id: b.id,
    repo: b.repo,
    period: `${b.period.from.slice(0, 10)} → ${b.period.to.slice(0, 10)}`,
    workstreamHints: b.workstreamHints,
    technicalMoves: b.technicalMoves.map((m) => ({
      text: m.text,
      evidenceRefs: m.evidenceRefs,
      tags: m.tags,
    })),
    possibleOutcomes: b.possibleOutcomes.map((o) => ({
      text: o.text,
      confidence: o.confidence,
      evidenceRefs: o.evidenceRefs,
    })),
    explicitEvidence: b.explicitEvidence,
    uncertainClaims: b.uncertainClaims,
    stack: b.stack,
    tags: b.tags,
  }));
  return JSON.stringify({ bundles: compact }, null, 2);
}

function isSupportingDocsNarrative(narrative: {
  title: string;
  scope: string;
  coreProblem: string;
  solutionShape: string;
  proofPoints: Array<{ text: string }>;
  techStack: string[];
}): boolean {
  const text = [
    narrative.title,
    narrative.scope,
    narrative.coreProblem,
    narrative.solutionShape,
    ...narrative.proofPoints.map((pp) => pp.text),
  ]
    .join(" ")
    .toLowerCase();
  const docsStackCount = narrative.techStack.filter((item) =>
    DOCS_STACK.has(item.toLowerCase()),
  ).length;
  return (
    DOCS_SUPPORT_RE.test(text) && docsStackCount >= Math.max(1, narrative.techStack.length - 1)
  );
}

function hasLowSignalMetricProofPoint(proofPoints: Array<{ text: string }>): boolean {
  return proofPoints.some((pp) => LOW_SIGNAL_METRIC_RE.test(pp.text));
}

/**
 * Interpret a set of EvidenceBundle records into ProjectNarrative[].
 *
 * Single LLM call (first implementation). The model receives all bundles at
 * once so it can decide both kinds of regrouping in one pass:
 * - split one repo into multiple narratives via workstreamHints
 * - merge multi-repo bundles into a single narrative
 *
 * Future upgrade: when bundle count grows, cluster bundles first and issue
 * one call per coherent cluster (per redesign doc §8 — avoid mixing weakly
 * related bundles in the same context window).
 */
export async function interpretBundles(
  llmConfig: LlmConfig,
  bundles: EvidenceBundle[],
  options: InterpretOptions,
): Promise<NarrativeLog> {
  if (bundles.length === 0) {
    return {
      version: 1,
      generatedAt: new Date().toISOString(),
      narratives: [],
    };
  }

  const systemBase = await loadPrompt("interpret", options.lang);
  const maxHint = options.maxNarratives
    ? `\nTarget at most ${options.maxNarratives} narratives. Returning fewer is fine.`
    : "";
  const system = `${systemBase}\n${SYSTEM_SCHEMA}${maxHint}`;
  const user = formatBundlesForPrompt(bundles);

  const out = await generateObject(llmConfig, LlmOutputSchema, system, user);

  // ── Defensive normalization ──────────────────────────────────────────────
  // Hard rule: the verify-facts stage will trust whatever lands here, so
  // anything not traceable to the input bundles must not survive.
  //
  //   1. sourceEvidenceIds: drop hallucinated bundle ids; if empty, drop narrative.
  //   2. repos:             clamp to repos actually present in the input bundles.
  //   3. proofPoints:       each must reference at least one known id
  //                         (bundle id OR a technical-move/outcome/excerpt evidenceRef).
  //                         A narrative with zero surviving proofPoints is dropped.
  //   4. projectKey:        re-computed deterministically — never trust the LLM.
  //
  // Also coalesce zod-defaulted array fields explicitly (workaround for the
  // zod `.default([])` × `exactOptionalPropertyTypes: true` interaction).

  const knownIds = new Set(bundles.map((b) => b.id));
  const knownRepos = new Set(bundles.map((b) => b.repo));

  // Refs that can legally appear inside proofPoints[*].evidenceRefs:
  // bundle ids, plus any evidenceRef string already attached to a move /
  // outcome / explicit-evidence excerpt.
  const knownRefs = new Set<string>(knownIds);
  for (const b of bundles) {
    for (const m of b.technicalMoves) for (const r of m.evidenceRefs) knownRefs.add(r);
    for (const o of b.possibleOutcomes) for (const r of o.evidenceRefs) knownRefs.add(r);
    for (const e of b.explicitEvidence) for (const r of e.evidenceRefs) knownRefs.add(r);
  }

  const narratives: ProjectNarrative[] = [];
  let droppedHallucinated = 0;
  let droppedNoProofPoints = 0;

  for (const n of out.narratives) {
    const validSources = n.sourceEvidenceIds.filter((id) => knownIds.has(id));
    if (validSources.length === 0) {
      droppedHallucinated++;
      continue;
    }

    const validRepos = n.repos.filter((r) => knownRepos.has(r));
    // If the LLM produced no recognizable repos, fall back to the repos of
    // its (now validated) source bundles — never invent here.
    const repos =
      validRepos.length > 0
        ? validRepos
        : Array.from(
            new Set(bundles.filter((b) => validSources.includes(b.id)).map((b) => b.repo)),
          );

    const proofPoints = n.proofPoints
      .map((pp) => ({
        ...pp,
        evidenceRefs: pp.evidenceRefs.filter((r) => knownRefs.has(r)),
      }))
      .filter((pp) => pp.evidenceRefs.length > 0);

    if (proofPoints.length === 0) {
      droppedNoProofPoints++;
      continue;
    }

    const riskFlags = [...(n.riskFlags ?? [])];
    let resumeWorthiness = n.resumeWorthiness;

    if (
      isSupportingDocsNarrative({
        title: n.title,
        scope: n.scope,
        coreProblem: n.coreProblem,
        solutionShape: n.solutionShape,
        proofPoints,
        techStack: n.techStack,
      })
    ) {
      if (!riskFlags.some((flag) => flag.kind === "supporting-docs")) {
        riskFlags.push({
          kind: "supporting-docs",
          note: "Documentation, translation, or community content is supporting evidence, not usually a core resume project.",
        });
      }
      resumeWorthiness = Math.min(resumeWorthiness, 0.45);
    }

    if (
      hasLowSignalMetricProofPoint(proofPoints) &&
      !riskFlags.some((flag) => flag.kind === "low-signal-metric")
    ) {
      riskFlags.push({
        kind: "low-signal-metric",
        note: "Proof points rely on code churn or line-count metrics and should be rewritten around functionality or outcome.",
      });
    }

    narratives.push({
      projectKey: makeStableProjectKey(repos, validSources),
      title: n.title,
      period: n.period,
      scope: n.scope,
      candidateRole: n.candidateRole,
      coreProblem: n.coreProblem,
      solutionShape: n.solutionShape,
      proofPoints,
      techStack: n.techStack,
      strengthSignals: n.strengthSignals ?? [],
      riskFlags,
      resumeWorthiness,
      sourceEvidenceIds: validSources,
      repos,
    });
  }

  if (droppedHallucinated > 0 || droppedNoProofPoints > 0) {
    console.warn(
      `[interpret] dropped ${droppedHallucinated} narrative(s) with hallucinated sources, ${droppedNoProofPoints} with zero verifiable proofPoints`,
    );
  }

  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    narratives,
  };
}

export type { ProjectNarrative };
