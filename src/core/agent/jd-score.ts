import type { CapabilityClaim, JdProfile, ProjectMemory } from "../schema/agent.ts";

/**
 * Compute a JD relevance score (0–1) for a single project.
 *
 * Scoring weights:
 *   required skill overlap  0.70
 *   nice-to-have overlap    0.30
 *
 * Skill matching searches the project's stack, tags, category, and
 * highlight text (case-insensitive).
 */
export function scoreProjectForJd(project: ProjectMemory, jd: JdProfile): number {
  const projectText = [
    ...project.stack,
    ...project.tags,
    project.category,
    ...project.highlights.map((h) => h.text),
  ]
    .join(" ")
    .toLowerCase();

  const countMatches = (skills: string[]): number =>
    skills.filter((s) => projectText.includes(s.toLowerCase())).length;

  const reqScore =
    jd.requiredSkills.length > 0 ? countMatches(jd.requiredSkills) / jd.requiredSkills.length : 0;
  const niceScore =
    jd.niceToHaveSkills.length > 0
      ? countMatches(jd.niceToHaveSkills) / jd.niceToHaveSkills.length
      : 0;

  return reqScore * 0.7 + niceScore * 0.3;
}

/**
 * Re-sort projects by a combined score:
 *   combined = signalScore * 0.4 + jdScore * 0.6
 *
 * This ensures JD-relevant projects surface first while still respecting
 * their original evidence quality.
 */
export function scoreProjectsForJd(projects: ProjectMemory[], jd: JdProfile): ProjectMemory[] {
  return projects
    .map((p) => ({
      project: p,
      combined: p.signalScore * 0.4 + scoreProjectForJd(p, jd) * 0.6,
    }))
    .sort((a, b) => b.combined - a.combined)
    .map((s) => s.project);
}

/**
 * Re-sort capability claims by JD relevance.
 * Claims matching required skills are boosted the most.
 */
export function scoreClaimsForJd(claims: CapabilityClaim[], jd: JdProfile): CapabilityClaim[] {
  return claims
    .map((c) => {
      const claimText = [c.claim, c.category, ...c.technologies].join(" ").toLowerCase();
      const reqMatches = jd.requiredSkills.filter((s) =>
        claimText.includes(s.toLowerCase()),
      ).length;
      const niceMatches = jd.niceToHaveSkills.filter((s) =>
        claimText.includes(s.toLowerCase()),
      ).length;
      return { claim: c, score: reqMatches * 2 + niceMatches };
    })
    .sort((a, b) => b.score - a.score)
    .map((s) => s.claim);
}
