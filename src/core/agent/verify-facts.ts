import { z } from "zod";
import { generateObject } from "../llm.ts";
import { loadPrompt } from "../prompts.ts";
import type { ResumeDraft } from "../schema/agent.ts";
import type { LlmConfig } from "../schema/config.ts";
import type { VerifyFactsReport } from "../schema/eval.ts";
import type { ProjectNarrative } from "../schema/narrative.ts";

export interface VerifyFactsOptions {
  lang: "zh" | "en";
  /** When true, use LLM for the verification pass. When false, only deterministic checks. */
  useLlm?: boolean;
  draftSlug?: string;
}

const METRIC_RE = /(?:\d+(?:\.\d+)?\s*(?:%|x|k|m|ms|s|sec|seconds?|mins?|minutes?|hours?|dau|qps|rps|req\/s|users?|fps|mb|gb))/i;
const LOW_SIGNAL_METRIC_RE =
  /\b\d[\d,]*(?:\.\d+)?\s+lines?\s+of\s+(?:new\s+)?code\b|\blines?\s+of\s+code\b|\bloc\b/i;
const OWNERSHIP_RE =
  /\b(led|owned|drove|spearheaded|directed|主导|负责|牵头|owner|ownership)\b/i;
const SCALE_RE =
  /\b(production-scale|high-throughput|high availability|high-traffic|large-scale|real-time|60fps|高并发|生产级|大规模|实时)\b/i;
const ARCH_RE = /\b(distributed|multi-tenant|event-driven|virtual scrolling|微服务|分布式|事件驱动|虚拟滚动)\b/i;

const VerifyFactsLlmIssueSchema = z.object({
  severity: z.enum(["error", "warning", "info"]),
  location: z.string(),
  text: z.string(),
  kind: z.string(),
  reason: z.string(),
  suggestedFix: z.string().optional(),
});

const VerifyFactsLlmOutputSchema = z.object({
  claims: z.array(VerifyFactsLlmIssueSchema),
});

const VERIFY_SCHEMA = `
Output ONLY valid JSON (no markdown fences) matching this exact schema:
{
  "claims": [
    {
      "severity": "error" | "warning" | "info",
      "location": "string",
      "text": "string",
      "kind": "metric" | "ownership" | "scale" | "architecture" | "other",
      "reason": "string",
      "suggestedFix": "string (optional)"
    }
  ]
}
`;

function hasEvidenceRefs(narrative: ProjectNarrative): boolean {
  return narrative.proofPoints.some((pp) => pp.evidenceRefs.length > 0);
}

function hasMetricSupport(narrative: ProjectNarrative): boolean {
  return narrative.proofPoints.some((pp) => pp.kind === "metric" && pp.evidenceRefs.length > 0);
}

function getBulletMetricSupport(
  narrative: ProjectNarrative,
  bullet: string,
): { supported: boolean; strongestStrength: "strong" | "moderate" | "soft" | null } {
  const metricToken = bullet.match(METRIC_RE)?.[0]?.toLowerCase();
  const metricProofPoints = narrative.proofPoints.filter(
    (pp) => pp.kind === "metric" && pp.evidenceRefs.length > 0,
  );
  if (metricProofPoints.length === 0) {
    return { supported: false, strongestStrength: null };
  }
  if (!metricToken) {
    const strongestStrength = metricProofPoints.some((pp) => pp.strength === "strong")
      ? "strong"
      : metricProofPoints.some((pp) => pp.strength === "moderate")
        ? "moderate"
        : "soft";
    return { supported: true, strongestStrength };
  }
  const matches = metricProofPoints.filter((pp) => pp.text.toLowerCase().includes(metricToken));
  if (matches.length === 0) {
    return { supported: false, strongestStrength: null };
  }
  const strongestStrength = matches.some((pp) => pp.strength === "strong")
    ? "strong"
    : matches.some((pp) => pp.strength === "moderate")
      ? "moderate"
      : "soft";
  return { supported: true, strongestStrength };
}

function hasOwnershipSupport(narrative: ProjectNarrative): boolean {
  return narrative.candidateRole === "owner" || narrative.strengthSignals.includes("ownership");
}

function hasKeywordSupport(narrative: ProjectNarrative, bullet: string): boolean {
  const lower = bullet.toLowerCase();
  const compactTokens = lower
    .replace(/[^\w\s%-]/g, " ")
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 4 || /\d/.test(token));

  const haystacks = [
    ...narrative.proofPoints.map((pp) => pp.text.toLowerCase()),
    narrative.solutionShape.toLowerCase(),
    narrative.coreProblem.toLowerCase(),
    narrative.scope.toLowerCase(),
  ];

  return compactTokens.some((token) => haystacks.some((haystack) => haystack.includes(token)));
}

function fallbackFix(kind: string, lang: "zh" | "en"): string {
  if (lang === "zh") {
    if (kind === "metric") return "去掉具体数字，改写为更保守的定性结果。";
    if (kind === "ownership") return "弱化 ownership 表述，改为“参与推动”或“支持实现”。";
    if (kind === "scale") return "去掉规模化措辞，改写为具体实现或优化动作。";
    if (kind === "architecture") return "避免架构级定性，直接描述已证明的实现方式。";
    return "补充可追溯证据，或删除这条表述。";
  }
  if (kind === "metric") return "Remove the explicit metric and rewrite it as a conservative qualitative outcome.";
  if (kind === "ownership")
    return "Soften the ownership claim to contribution-oriented wording.";
  if (kind === "scale") return "Drop the scale language and describe the concrete implementation instead.";
  if (kind === "architecture")
    return "Avoid architecture-level claims and describe only the proven implementation details.";
  return "Add traceable evidence or remove the claim.";
}

function dedupeClaims(claims: VerifyFactsReport["claims"]): VerifyFactsReport["claims"] {
  const seen = new Set<string>();
  const out: VerifyFactsReport["claims"] = [];
  for (const claim of claims) {
    const key = `${claim.location}::${claim.kind}::${claim.text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(claim);
  }
  return out;
}

/**
 * Cross-check every bullet in a ResumeDraft against the proofPoints of the
 * ProjectNarratives that produced it.
 *
 * Deterministic checks (no LLM):
 * - Every bullet's projectId must map to a narrative.
 * - Every metric-shaped fragment (regex on digits + units / "%" / "x") must
 *   have at least one proofPoint of kind "metric" attached to its project.
 *
 * LLM checks (when useLlm=true):
 * - Detect ownership overclaims ("led", "owned", "drove") not backed by
 *   strengthSignals.
 * - Detect scale / architecture claims not present in proofPoints.
 * - Surface fixes via suggestedFix.
 */
export async function verifyDraftFacts(
  llmConfig: LlmConfig,
  draft: ResumeDraft,
  narratives: ProjectNarrative[],
  options: VerifyFactsOptions,
): Promise<VerifyFactsReport> {
  const byProject = new Map(narratives.map((n) => [n.projectKey, n]));
  const claims: VerifyFactsReport["claims"] = [];
  let bulletsTotal = 0;
  let bulletsWithEvidence = 0;

  for (const project of draft.selectedProjects) {
    const narrative = byProject.get(project.projectId);
    for (const bullet of project.bullets) {
      bulletsTotal += 1;
      const location = `${project.title}`;

      if (!narrative) {
        claims.push({
          severity: "error",
          location,
          text: bullet,
          kind: "other",
          reason: "No matching ProjectNarrative was found for this resume project.",
          suggestedFix: fallbackFix("other", options.lang),
        });
        continue;
      }

      if (hasEvidenceRefs(narrative)) bulletsWithEvidence += 1;

      if (!hasEvidenceRefs(narrative)) {
        claims.push({
          severity: "warning",
          location,
          text: bullet,
          kind: "other",
          reason: "This project has no verifiable proofPoints with evidenceRefs.",
          suggestedFix: fallbackFix("other", options.lang),
        });
      }
      if (METRIC_RE.test(bullet)) {
        const metricSupport = getBulletMetricSupport(narrative, bullet);
        if (!metricSupport.supported) {
          claims.push({
            severity: "error",
            location,
            text: bullet,
            kind: "metric",
            reason: "The bullet contains a metric-shaped claim without metric proof support.",
            suggestedFix: fallbackFix("metric", options.lang),
          });
        } else if (metricSupport.strongestStrength !== "strong") {
          claims.push({
            severity: "warning",
            location,
            text: bullet,
            kind: "metric",
            reason: "The metric claim is only backed by moderate or soft evidence and should be phrased more conservatively.",
            suggestedFix: fallbackFix("metric", options.lang),
          });
        }
      }
      if (LOW_SIGNAL_METRIC_RE.test(bullet)) {
        claims.push({
          severity: "warning",
          location,
          text: bullet,
          kind: "metric",
          reason: "Lines-of-code style metrics are low-signal and usually weaker than outcome or usage evidence.",
          suggestedFix: fallbackFix("metric", options.lang),
        });
      }
      if (OWNERSHIP_RE.test(bullet) && !hasOwnershipSupport(narrative)) {
        claims.push({
          severity: "error",
          location,
          text: bullet,
          kind: "ownership",
          reason: "The bullet implies ownership or leadership that the narrative does not prove.",
          suggestedFix: fallbackFix("ownership", options.lang),
        });
      }
      if (SCALE_RE.test(bullet) && !hasKeywordSupport(narrative, bullet)) {
        claims.push({
          severity: "warning",
          location,
          text: bullet,
          kind: "scale",
          reason: "The bullet makes a scale claim that is not directly grounded in the narrative.",
          suggestedFix: fallbackFix("scale", options.lang),
        });
      }
      if (ARCH_RE.test(bullet) && !hasKeywordSupport(narrative, bullet)) {
        claims.push({
          severity: "warning",
          location,
          text: bullet,
          kind: "architecture",
          reason: "The bullet uses architecture terminology that is not directly grounded in the narrative.",
          suggestedFix: fallbackFix("architecture", options.lang),
        });
      }
    }
  }

  if (options.useLlm) {
    const systemBase = await loadPrompt("verify-facts", options.lang);
    const system = `${systemBase}\n\n${VERIFY_SCHEMA}`;
    const user = JSON.stringify(
      {
        draft: {
          headline: draft.headline,
          summary: draft.summary,
          selectedProjects: draft.selectedProjects,
        },
        narratives: narratives.map((n) => ({
          projectKey: n.projectKey,
          title: n.title,
          candidateRole: n.candidateRole,
          proofPoints: n.proofPoints,
          strengthSignals: n.strengthSignals,
          solutionShape: n.solutionShape,
          coreProblem: n.coreProblem,
        })),
      },
      null,
      2,
    );
    const llmOut = await generateObject(llmConfig, VerifyFactsLlmOutputSchema, system, user);
    for (const claim of llmOut.claims) {
      claims.push({
        severity: claim.severity,
        location: claim.location,
        text: claim.text,
        kind: claim.kind,
        reason: claim.reason,
        ...(claim.suggestedFix ? { suggestedFix: claim.suggestedFix } : {}),
      });
    }
  }

  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    draftSlug: options.draftSlug ?? "default",
    claims: dedupeClaims(claims),
    coverage: bulletsTotal === 0 ? 1 : bulletsWithEvidence / bulletsTotal,
  };
}
