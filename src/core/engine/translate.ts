import { z } from "zod";
import { generateObject } from "../llm.ts";
import { loadPrompt } from "../prompts.ts";
import type { LlmConfig } from "../schema/config.ts";
import { ExperienceEntrySchema } from "../schema/experience.ts";
import type { ExperienceEntry } from "../schema/experience.ts";
import type { Cluster } from "./cluster.ts";
import type { Tag } from "./tag-vocab.ts";

const SYSTEM_SCHEMA = `
Output ONLY valid JSON (no markdown fences) matching this exact schema:
{
  "id": "string (e.g. 'owner_repo_2026-05')",
  "repo": "string",
  "period": { "from": "ISO date string", "to": "ISO date string" },
  "title": "string (2–8 words describing the work focus)",
  "highlights": [
    { "text": "string (one bullet point)", "tags": ["string"], "evidence": ["string"] }
  ],
  "stack": ["string (specific technologies)"],
  "tags": ["string (capability tags)"]
}
Constraints: 3–6 highlights maximum. Each highlight must start with a strong action verb.
Avoid: "worked on", "was responsible for", "participated in", "assisted with".
`;

function formatEvents(cluster: Cluster, allTags: Map<string, Tag[]>, maxEvents: number): string {
  const lines: string[] = [
    `Repository: ${cluster.repo}`,
    `Period: ${cluster.period.from.slice(0, 10)} → ${cluster.period.to.slice(0, 10)}`,
    `Events (${cluster.events.length} total):`,
  ];

  for (const event of cluster.events.slice(0, maxEvents)) {
    const p = event.payload;
    let summary = `[${event.kind}] ${event.ts.slice(0, 10)}`;
    if (typeof p.title === "string") summary += `: ${p.title}`;
    else if (typeof p.message === "string") summary += `: ${String(p.message).split("\n")[0]}`;
    if (typeof p.additions === "number") summary += ` (+${p.additions}/-${p.deletions})`;
    lines.push(`  - ${summary}`);
  }

  // Aggregate tags from all events in the cluster (union)
  const hintTagSet = new Set<string>();
  for (const event of cluster.events) {
    const tagId = `${event.kind}:${cluster.repo}:${event.ts}`;
    for (const tag of allTags.get(tagId) ?? []) hintTagSet.add(tag);
  }
  if (hintTagSet.size > 0) lines.push(`\nTechnology hints: ${[...hintTagSet].join(", ")}`);

  return lines.join("\n");
}

const BATCH_SYSTEM_SCHEMA = `
Output ONLY a valid JSON array (no markdown fences).
Each element of the array must match this exact schema:
{
  "id": "string (e.g. 'owner_repo_2026-05')",
  "repo": "string",
  "period": { "from": "ISO date string", "to": "ISO date string" },
  "title": "string (2–8 words describing the work focus)",
  "highlights": [
    { "text": "string (one bullet point)", "tags": ["string"], "evidence": ["string"] }
  ],
  "stack": ["string (specific technologies)"],
  "tags": ["string (capability tags)"]
}
Constraints: 3–6 highlights per entry maximum. Each highlight must start with a strong action verb.
Avoid: "worked on", "was responsible for", "participated in", "assisted with".
The array must contain exactly N entries in the same order as the clusters provided.
`;

function formatBatchClusters(
  clusters: Cluster[],
  allTags: Map<string, Tag[]>,
  maxEvents: number,
): string {
  const parts = clusters.map((cluster, i) => {
    const block = formatEvents(cluster, allTags, maxEvents);
    return `--- Cluster ${i + 1}/${clusters.length}: ${cluster.repo} ${cluster.period.from.slice(0, 7)} ---\n${block}`;
  });
  return `${parts.join("\n\n")}\n\nReturn a JSON array with exactly ${clusters.length} entries, one per cluster, in the same order.`;
}

/**
 * Use the LLM to transform a batch of raw event clusters into structured ExperienceEntries.
 * Merges multiple small clusters into a single LLM call to reduce API usage.
 */
export async function generateEntryBatch(
  config: LlmConfig,
  clusters: Cluster[],
  allTags: Map<string, Tag[]>,
  lang: "zh" | "en",
  maxEvents = 40,
): Promise<ExperienceEntry[]> {
  if (clusters.length === 1) {
    const cluster = clusters[0];
    if (!cluster) {
      throw new Error("Expected one cluster when generating a single entry batch.");
    }
    const entry = await generateEntry(config, cluster, allTags, lang, maxEvents);
    return [entry];
  }
  const systemPromptBase = await loadPrompt("evolve", lang);
  const system = `${systemPromptBase}\n${BATCH_SYSTEM_SCHEMA}`;
  const user = formatBatchClusters(clusters, allTags, maxEvents);

  const entries = await generateObject(config, z.array(ExperienceEntrySchema), system, user);
  return entries.map((entry, i) => {
    const cluster = clusters[i];
    if (!cluster) {
      throw new Error(`Missing cluster for batch result at index ${i}.`);
    }
    return { ...entry, id: cluster.id, repo: cluster.repo, period: cluster.period };
  });
}

/**
 * Use the LLM to transform a raw event cluster into a structured ExperienceEntry.
 * The system prompt is loaded from assets/prompts/evolve.<lang>.md (user-overridable).
 */
export async function generateEntry(
  config: LlmConfig,
  cluster: Cluster,
  allTags: Map<string, Tag[]>,
  lang: "zh" | "en",
  maxEvents = 40,
): Promise<ExperienceEntry> {
  const systemPromptBase = await loadPrompt("evolve", lang);
  const system = `${systemPromptBase}\n${SYSTEM_SCHEMA}`;
  const user = formatEvents(cluster, allTags, maxEvents);

  const entry = await generateObject(config, ExperienceEntrySchema, system, user);
  // Ensure id and repo are set correctly in case the LLM drifts
  return { ...entry, id: cluster.id, repo: cluster.repo, period: cluster.period };
}
