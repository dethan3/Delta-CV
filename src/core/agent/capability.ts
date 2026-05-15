import type { CapabilityClaim } from "../schema/agent.ts";
import type { ProjectMemory } from "../schema/agent.ts";

interface CapabilityCategory {
  name: string;
  keywords: string[];
}

const CAPABILITY_CATEGORIES: CapabilityCategory[] = [
  {
    name: "AI/LLM Engineering",
    keywords: [
      "llm", "openai", "anthropic", "agent", "rag", "langchain", "embedding",
      "gpt", "claude", "chatgpt", "ai", "ml", "vector", "semantic", "copilot",
      "huggingface", "transformers", "inference", "prompt", "fine-tuning",
    ],
  },
  {
    name: "Full-Stack Development",
    keywords: [
      "react", "nextjs", "next.js", "vue", "nuxt", "svelte", "angular",
      "typescript", "javascript", "nodejs", "node.js", "express", "fastify",
      "hono", "tailwind", "html", "css", "frontend", "backend", "web",
      "shadcn", "radix", "vite", "webpack",
    ],
  },
  {
    name: "Data Engineering",
    keywords: [
      "postgresql", "postgres", "mysql", "sqlite", "mongodb", "redis",
      "prisma", "drizzle", "sql", "database", "elasticsearch", "kafka",
      "clickhouse", "supabase", "planetscale",
    ],
  },
  {
    name: "DevOps / Infrastructure",
    keywords: [
      "docker", "kubernetes", "k8s", "ci/cd", "github-actions", "deploy",
      "aws", "gcp", "azure", "vercel", "cloudflare", "nginx", "linux",
      "terraform", "ansible", "monitoring", "observability",
    ],
  },
  {
    name: "CLI / Developer Tooling",
    keywords: [
      "cli", "tooling", "plugin", "extension", "sdk", "library", "package",
      "npm", "pnpm", "build-tool", "compiler", "linter", "formatter",
      "dx", "devtools",
    ],
  },
  {
    name: "Open Source / Community",
    keywords: [
      "open-source", "oss", "community", "contribution", "release",
      "documentation", "tutorial", "blog",
    ],
  },
];

/** Normalise a string for keyword matching. */
function normalise(s: string): string {
  return s.toLowerCase().replace(/[-_.]/g, "");
}

/** Count how many category keywords appear in the given token set. */
function countHits(tokens: Set<string>, keywords: string[]): number {
  let hits = 0;
  for (const kw of keywords) {
    if (tokens.has(normalise(kw))) hits++;
  }
  return hits;
}

/**
 * Classify a project into its primary capability category based on stack and tags.
 * Returns the name of the best-matching category, or "General Engineering" if none match.
 */
export function classifyRepo(stack: string[], tags: string[]): string {
  const tokens = new Set([...stack, ...tags].map(normalise));
  let bestCategory = "General Engineering";
  let bestHits = 0;

  for (const cat of CAPABILITY_CATEGORIES) {
    const hits = countHits(tokens, cat.keywords);
    if (hits > bestHits) {
      bestHits = hits;
      bestCategory = cat.name;
    }
  }

  return bestCategory;
}

/**
 * Build CapabilityClaim[] from a set of ProjectMemory records.
 *
 * For each capability category, collect the matching technologies and the
 * projects that contribute to it. Confidence is proportional to how many
 * projects and how many keyword hits the category accumulates.
 */
export function buildCapabilityClaims(projects: ProjectMemory[]): CapabilityClaim[] {
  interface Accumulator {
    techSet: Set<string>;
    projectIds: Set<string>;
    totalHits: number;
  }

  const accum = new Map<string, Accumulator>();

  for (const cat of CAPABILITY_CATEGORIES) {
    accum.set(cat.name, { techSet: new Set(), projectIds: new Set(), totalHits: 0 });
  }

  let globalMaxHits = 0;

  for (const project of projects) {
    const tokens = new Set([...project.stack, ...project.tags].map(normalise));

    for (const cat of CAPABILITY_CATEGORIES) {
      const hits = countHits(tokens, cat.keywords);
      if (hits === 0) continue;

      const entry = accum.get(cat.name);
      if (!entry) continue;

      entry.totalHits += hits;
      entry.projectIds.add(project.id);

      for (const tech of project.stack) {
        const nt = normalise(tech);
        if (cat.keywords.some((kw) => normalise(kw) === nt || nt.includes(normalise(kw)))) {
          entry.techSet.add(tech);
        }
      }

      if (entry.totalHits > globalMaxHits) globalMaxHits = entry.totalHits;
    }
  }

  const claims: CapabilityClaim[] = [];

  for (const cat of CAPABILITY_CATEGORIES) {
    const entry = accum.get(cat.name);
    if (!entry || entry.projectIds.size === 0) continue;

    const confidence =
      globalMaxHits > 0 ? Math.min(entry.totalHits / globalMaxHits, 1) : 0;

    claims.push({
      claim: cat.name,
      category: cat.name,
      technologies: [...entry.techSet].sort(),
      confidence,
      projectIds: [...entry.projectIds],
      resumeUse: confidence >= 0.15 || entry.projectIds.size >= 2,
    });
  }

  return claims.sort((a, b) => b.confidence - a.confidence);
}
