import { z } from "zod";

export const LlmProviderSchema = z.enum(["openai-compatible", "anthropic"]);
export type LlmProvider = z.infer<typeof LlmProviderSchema>;

export const LlmConfigSchema = z.object({
  provider: LlmProviderSchema.default("openai-compatible"),
  /** Defaults to DeepSeek; override via config.json for other providers. */
  baseUrl: z.string().url().optional(),
  model: z.string().default("deepseek-chat"),
  /** Optional during local development; runtime code resolves LLM_API_KEY from .env.local/env. */
  apiKey: z.string().min(1).optional(),
  maxRetries: z.number().int().min(0).max(5).default(2),
});
export type LlmConfig = z.infer<typeof LlmConfigSchema>;

export const EngineConfigSchema = z.object({
  /** Max events per cluster sent to the LLM in a single prompt. */
  maxEventsPerCluster: z.number().int().positive().default(40),
  /** Normalised score delta required to classify a tag trend as rising/declining. */
  trendThreshold: z.number().min(0).max(1).default(0.04),
  /** Maximum number of tags stored in the topTags list of a snapshot. */
  topTagsLimit: z.number().int().positive().default(20),
  /** Number of LLM batch requests to run concurrently during evolve. */
  concurrency: z.number().int().min(1).max(10).default(3),
});
export type EngineConfig = z.infer<typeof EngineConfigSchema>;

export const ConfigSchema = z.object({
  /** GitHub login of the target user. */
  login: z.string().min(1),
  /** Output language for resume content. */
  language: z.enum(["zh", "en", "bilingual"]).default("zh"),
  llm: LlmConfigSchema,
  engine: EngineConfigSchema.optional(),
  ignore: z
    .object({
      repos: z.array(z.string()).default([]),
      authors: z.array(z.string()).default([]),
    })
    .default({}),
  schedule: z
    .object({
      cron: z.string().default("0 0 * * 1"),
      lookbackDays: z.number().int().positive().default(7),
    })
    .default({}),
});
export type Config = z.infer<typeof ConfigSchema>;
