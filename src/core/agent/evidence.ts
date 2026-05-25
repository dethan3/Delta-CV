import type { EvidenceBundle, EvidenceLog } from "../schema/evidence.ts";
import type { ExperienceEntry } from "../schema/experience.ts";

/**
 * PR1-A bridge: mechanically convert one ExperienceEntry into an EvidenceBundle.
 *
 * This is intentionally lossy:
 * - `explicitEvidence` is left empty because ExperienceEntry no longer carries
 *   raw event payloads; the upgrade path is to build bundles directly from
 *   the event log, not from the already-polished entry.
 * - `possibleOutcomes` is left empty: we do not promote entry-level highlight
 *   text into outcomes, since highlight text has already been polished and
 *   we cannot distinguish "supported" vs "inferred" anymore.
 * - `workstreamHints` is left empty: the interpret stage will infer splits.
 *
 * Use this as scaffolding only. It exists so the rest of the new pipeline
 * (`interpret`, `select`, new `compose`) can be built end-to-end before we
 * rewrite `evolve` to produce EvidenceBundle natively.
 */
export function entryToEvidenceBundle(entry: ExperienceEntry): EvidenceBundle {
  const technicalMoves = entry.highlights.map((h) => ({
    text: h.text,
    evidenceRefs: h.evidence ?? [],
    tags: h.tags,
  }));

  return {
    id: entry.id,
    repo: entry.repo,
    period: entry.period,
    workstreamHints: [],
    technicalMoves,
    possibleOutcomes: [],
    explicitEvidence: [],
    uncertainClaims: [],
    stack: entry.stack,
    tags: entry.tags,
    sourceEventIds: [entry.id],
  };
}

/**
 * Build an EvidenceLog from an ExperienceLog's entries.
 * No LLM call — this is the PR1-A bridge.
 */
export function buildEvidenceBundlesFromEntries(entries: ExperienceEntry[]): EvidenceLog {
  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    bundles: entries.map(entryToEvidenceBundle),
  };
}
