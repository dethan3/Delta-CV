import type { z } from "zod";
import type { LlmConfig } from "./schema/config.ts";

/** Thrown when the LLM API rate limit is hit and all retries are exhausted. */
export class RateLimitError extends Error {
  constructor() {
    super(
      "LLM API rate limit exceeded after all retries. Run the command again to resume from the last checkpoint.",
    );
    this.name = "RateLimitError";
  }
}

const ANTHROPIC_BASE_URL = "https://api.anthropic.com/v1";
const DEFAULT_OPENAI_BASE_URL = "https://api.deepseek.com/v1";
const DEFAULT_MAX_TOKENS = 4096;

interface OpenAIResponse {
  choices: Array<{ message: { content: string } }>;
  usage: { prompt_tokens: number; completion_tokens: number };
}

interface AnthropicResponse {
  content: Array<{ type: string; text: string }>;
  usage: { input_tokens: number; output_tokens: number };
}

async function callApi(
  config: LlmConfig,
  messages: Array<{ role: string; content: string }>,
  system: string,
  jsonMode: boolean,
): Promise<{ text: string; promptTokens: number; completionTokens: number }> {
  const apiKey = config.apiKey ?? process.env.LLM_API_KEY ?? "";
  if (!apiKey) {
    throw new Error(
      "LLM API key is not set. Provide it in config.json (llm.apiKey) or as LLM_API_KEY env var.",
    );
  }
  const maxRetries = config.maxRetries ?? 2;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let res: Response;
    try {
    if (config.provider === "anthropic") {
      res = await fetch(`${ANTHROPIC_BASE_URL}/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: config.model,
          max_tokens: DEFAULT_MAX_TOKENS,
          system,
          messages,
        }),
      });
    } else {
      const body: Record<string, unknown> = {
        model: config.model,
        messages: [{ role: "system", content: system }, ...messages],
      };
      if (jsonMode) body.response_format = { type: "json_object" };
      res = await fetch(`${config.baseUrl ?? DEFAULT_OPENAI_BASE_URL}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
      });
    }

    } catch (networkErr) {
      if (attempt < maxRetries) {
        await new Promise((r) => setTimeout(r, 2 ** attempt * 1000));
        continue;
      }
      throw new RateLimitError();
    }

    if (res.status === 429) {
      const headerVal = res.headers.get("retry-after");
      const retryAfter =
        headerVal !== null && !Number.isNaN(Number(headerVal)) ? Number(headerVal) : 2 ** attempt;
      await new Promise((r) => setTimeout(r, retryAfter * 1000));
      continue;
    }

    if (!res.ok) {
      const body = await res.text();
      process.stderr.write(`LLM API error body: ${body}\n`);
      throw new Error(
        `LLM API error ${res.status} from ${config.provider} — see stderr for details`,
      );
    }

    if (config.provider === "anthropic") {
      const data = (await res.json()) as AnthropicResponse;
      const text = data.content.find((c) => c.type === "text")?.text ?? "";
      return {
        text,
        promptTokens: data.usage.input_tokens,
        completionTokens: data.usage.output_tokens,
      };
    }
    const data = (await res.json()) as OpenAIResponse;
    const text = data.choices[0]?.message.content ?? "";
    return {
      text,
      promptTokens: data.usage.prompt_tokens,
      completionTokens: data.usage.completion_tokens,
    };
  }
  throw new RateLimitError();
}

/**
 * Generate a structured object validated against a zod schema.
 * Retries up to maxRetries times if schema validation fails, feeding the error back to the model.
 */
export async function generateObject<T>(
  config: LlmConfig,
  schema: z.ZodType<T>,
  system: string,
  user: string,
): Promise<T> {
  const schemaInstruction =
    "\n\nRespond with ONLY valid JSON (no markdown fences, no commentary) matching the schema described above.";
  const messages: Array<{ role: string; content: string }> = [
    { role: "user", content: user + schemaInstruction },
  ];

  const maxRetries = config.maxRetries ?? 2;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const { text } = await callApi(config, messages, system, true);
    try {
      const raw = JSON.parse(stripJsonFences(text));
      return schema.parse(raw);
    } catch (err) {
      if (attempt === maxRetries) throw new Error(`LLM schema validation failed: ${err}`);
      messages.push({ role: "assistant", content: text });
      messages.push({
        role: "user",
        content: `The previous response failed schema validation: ${err}. Please fix and return valid JSON only.`,
      });
    }
  }
  throw new Error("generateObject: exceeded retry limit");
}

/** Generate a plain text completion. */
export async function generateText(
  config: LlmConfig,
  system: string,
  user: string,
): Promise<string> {
  const { text } = await callApi(config, [{ role: "user", content: user }], system, false);
  return text;
}

function stripJsonFences(text: string): string {
  return text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/, "")
    .trim();
}
