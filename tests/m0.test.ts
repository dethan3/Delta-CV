import { describe, expect, it } from "vitest";
import { checkLineLength } from "../src/core/lint/line-length.ts";
import { ConfigSchema } from "../src/core/schema/config.ts";

describe("M0 local development contract", () => {
  it("allows config without an inline LLM API key", () => {
    const config = ConfigSchema.parse({
      login: "octocat",
      language: "zh",
      llm: {
        provider: "openai-compatible",
        baseUrl: "https://api.deepseek.com/v1",
        model: "deepseek-chat",
      },
    });

    expect(config.llm.apiKey).toBeUndefined();
  });

  it("keeps the implemented line-length lint helper usable", () => {
    expect(checkLineLength("- short highlight", 120)).toEqual([]);
    expect(checkLineLength(`- ${"x".repeat(130)}`, 120)).toHaveLength(1);
  });
});
