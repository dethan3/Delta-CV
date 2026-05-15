import type { ProjectMemory } from "../schema/agent.ts";

interface ScoringWeights {
  depth: number;
  duration: number;
  signal: number;
  recency: number;
  collaboration: number;
}

const DEFAULT_WEIGHTS: ScoringWeights = {
  depth: 0.30,
  duration: 0.20,
  signal: 0.25,
  recency: 0.15,
  collaboration: 0.10,
};

const COLLABORATION_TAGS = new Set([
  "code-review", "review", "open-source", "community", "mentoring",
]);

/** Months between two ISO date strings. Always >= 0. */
function monthsAgo(isoDate: string): number {
  const then = new Date(isoDate);
  const now = new Date();
  return (
    (now.getFullYear() - then.getFullYear()) * 12 +
    (now.getMonth() - then.getMonth())
  );
}

/** Recency score: exponential decay, half-life ≈ 12 months. */
function recencyScore(lastActiveIso: string): number {
  const months = monthsAgo(lastActiveIso);
  return Math.exp((-Math.log(2) * months) / 12);
}

/** Collaboration bonus: +1 if project has review events or open-source tags. */
function collaborationScore(project: Omit<ProjectMemory, "importance">): number {
  const hasCommunityTag = project.tags.some((t) => COLLABORATION_TAGS.has(t.toLowerCase()));
  const hasReviewHighlight = project.highlights.some((h) =>
    h.tags.some((t) => COLLABORATION_TAGS.has(t.toLowerCase())),
  );
  return hasCommunityTag || hasReviewHighlight ? 1 : 0;
}

/**
 * Score all projects and fill in their `importance` value.
 *
 * Each dimension is normalised to [0, 1] across the project set before
 * being combined with the weights, so relative differences between projects
 * drive the final ranking rather than absolute values.
 */
export function scoreProjects(
  drafts: Omit<ProjectMemory, "importance">[],
  weights: ScoringWeights = DEFAULT_WEIGHTS,
): ProjectMemory[] {
  if (drafts.length === 0) return [];

  const maxActiveMonths = Math.max(...drafts.map((p) => p.activeMonths));
  const maxHighlights = Math.max(...drafts.map((p) => p.highlights.length));

  const scored = drafts.map((project) => {
    const depth =
      maxHighlights > 0 ? project.highlights.length / maxHighlights : 0;

    const duration = Math.min(project.activeMonths / Math.max(maxActiveMonths, 1), 1);

    const signal = project.signalScore;

    const recency = recencyScore(project.period.to);

    const collaboration = collaborationScore(project);

    const importance =
      depth * weights.depth +
      duration * weights.duration +
      signal * weights.signal +
      recency * weights.recency +
      collaboration * weights.collaboration;

    return { ...project, importance: Math.round(importance * 1000) / 1000 };
  });

  return scored.sort((a, b) => b.importance - a.importance);
}

/**
 * Select the top-N projects by importance score.
 * Defaults to top 6 as per plan; can be overridden.
 */
export function selectTopProjects(projects: ProjectMemory[], topN = 6): ProjectMemory[] {
  return projects.slice(0, topN);
}
