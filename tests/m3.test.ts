import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExperienceEntry } from "../src/core/schema/experience.ts";

// ── Imports ──────────────────────────────────────────────────────────────────

import { loadBannedWords } from "../src/core/io/assets.ts";
import {
  readExperienceLog,
  readLatestSnapshot,
  writeExperienceLog,
  writeSnapshot,
} from "../src/core/io/data.ts";
import { checkBannedWords } from "../src/core/lint/banned-words.ts";
import { checkHighlightLimits, checkLineLength } from "../src/core/lint/line-length.ts";
import { ExperienceEntrySchema, ExperienceLogSchema } from "../src/core/schema/experience.ts";
import { rerankByJd, slugifyJd } from "../src/core/tailor/jd-rerank.ts";
import { renderResume } from "../src/core/tailor/render.ts";

// ── Helpers ──────────────────────────────────────────────────────────────────

let tmpDir: string;

function makeEntry(overrides: Partial<ExperienceEntry> = {}): ExperienceEntry {
  return ExperienceEntrySchema.parse({
    id: overrides.id ?? "alice_project_2026-05",
    repo: overrides.repo ?? "alice/project",
    period: overrides.period ?? { from: "2026-05-01", to: "2026-05-31" },
    title: overrides.title ?? "Implement feature X",
    highlights: overrides.highlights ?? [
      { text: "Built a new API endpoint for user data", tags: ["typescript", "rest"] },
      { text: "Reduced response time by 40%", tags: ["performance"] },
    ],
    stack: overrides.stack ?? ["TypeScript", "Node.js"],
    tags: overrides.tags ?? ["typescript", "rest"],
  });
}

function makeLog(entries: ExperienceEntry[] = [makeEntry()]) {
  return ExperienceLogSchema.parse({
    version: 1,
    generatedAt: "2026-05-09T00:00:00Z",
    entries,
  });
}

beforeEach(async () => {
  tmpDir = join(tmpdir(), `delta-m3-test-${Date.now()}`);
  await mkdir(tmpDir, { recursive: true });
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// ── Lint: banned-words ───────────────────────────────────────────────────────

describe("checkBannedWords", () => {
  it("returns no violations for clean text", () => {
    const violations = checkBannedWords("Built a distributed system", [
      "responsible for",
      "worked on",
    ]);
    expect(violations).toEqual([]);
  });

  it("detects banned words with line and column", () => {
    const violations = checkBannedWords(
      "I was responsible for the API\nand worked on the frontend",
      ["responsible for", "worked on"],
    );
    expect(violations).toHaveLength(2);
    expect(violations[0]).toEqual({ line: 1, col: 7, word: "responsible for" });
    expect(violations[1]).toEqual({ line: 2, col: 5, word: "worked on" });
  });

  it("handles empty banned words list", () => {
    const violations = checkBannedWords("any text", []);
    expect(violations).toEqual([]);
  });

  it("handles empty markdown", () => {
    const violations = checkBannedWords("", ["banned"]);
    expect(violations).toEqual([]);
  });
});

// ── Lint: line-length ────────────────────────────────────────────────────────

describe("checkLineLength", () => {
  it("returns no violations for short lines", () => {
    const violations = checkLineLength("short line\nanother line");
    expect(violations).toEqual([]);
  });

  it("detects lines exceeding maxLen", () => {
    const longLine = "a".repeat(121);
    const violations = checkLineLength(longLine, 120);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.line).toBe(1);
    expect(violations[0]?.col).toBe(121);
  });
});

describe("checkHighlightLimits", () => {
  it("returns no violations for valid resume", () => {
    const md = `## Project A

- Highlight one
- Highlight two
- Highlight three

## Project B

- Highlight one`;
    const violations = checkHighlightLimits(md);
    expect(violations).toEqual([]);
  });

  it("detects too many highlights in a project", () => {
    const md = `## Project A

- Highlight one
- Highlight two
- Highlight three
- Highlight four
- Highlight five`;
    const violations = checkHighlightLimits(md, 2, 4);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.section).toBe("Project A");
    expect(violations[0]?.issue).toContain("too many highlights");
  });

  it("detects highlight exceeding line limit", () => {
    const md = `## Project A

- This is a very long highlight that spans
  multiple lines because it continues here
  and even more on this third line`;
    const violations = checkHighlightLimits(md, 2, 4);
    expect(violations.length).toBeGreaterThanOrEqual(1);
    expect(violations.some((v) => v.issue.includes("exceeds"))).toBe(true);
  });
});

// ── Assets: loadBannedWords ──────────────────────────────────────────────────

describe("loadBannedWords", () => {
  it("loads Chinese banned words from assets", async () => {
    const words = await loadBannedWords("zh");
    expect(words.length).toBeGreaterThan(0);
    expect(words).toContain("负责");
    // Should not contain comments
    expect(words.every((w) => !w.startsWith("#"))).toBe(true);
  });

  it("loads English banned words from assets", async () => {
    const words = await loadBannedWords("en");
    expect(words.length).toBeGreaterThan(0);
    expect(words).toContain("responsible for");
  });

  it("loads user override when available", async () => {
    const promptsDir = join(tmpDir, "prompts");
    await mkdir(promptsDir, { recursive: true });
    await writeFile(
      join(promptsDir, "banned_words.en.txt"),
      "# custom\nmy-banned-word\nanother-word\n",
    );

    const origCwd = process.cwd();
    process.chdir(tmpDir);
    try {
      const words = await loadBannedWords("en");
      expect(words).toEqual(["my-banned-word", "another-word"]);
    } finally {
      process.chdir(origCwd);
    }
  });
});

// ── Tailor: renderResume ─────────────────────────────────────────────────────

describe("renderResume", () => {
  it("renders Chinese template with entries", async () => {
    const log = makeLog();
    const md = await renderResume(log, { language: "zh", login: "alice" });
    expect(md).toContain("# alice — 技术简历");
    expect(md).toContain("Implement feature X");
    expect(md).toContain("Built a new API endpoint");
    expect(md).toContain("TypeScript, Node.js");
  });

  it("renders English template with entries", async () => {
    const log = makeLog();
    const md = await renderResume(log, { language: "en", login: "bob" });
    expect(md).toContain("# bob — Engineering Resume");
    expect(md).toContain("Implement feature X");
  });

  it("renders bilingual template", async () => {
    const log = makeLog();
    const md = await renderResume(log, { language: "bilingual" });
    expect(md).toContain("技术简历 / Engineering Resume");
  });

  it("includes focus trends when provided", async () => {
    const log = makeLog();
    const md = await renderResume(log, {
      language: "en",
      focus: [
        { tag: "typescript", score: 0.8, trend: "rising" },
        { tag: "python", score: 0.3, trend: "declining" },
      ],
      topTags: ["typescript", "node.js"],
    });
    expect(md).toContain("Rising Trends");
    expect(md).toContain("typescript");
    expect(md).toContain("Declining Trends");
    expect(md).toContain("Core Focus Areas");
  });

  it("renders timeline sorted by period", async () => {
    const entries = [
      makeEntry({
        id: "e1",
        period: { from: "2026-03-01", to: "2026-03-31" },
        title: "Later project",
      }),
      makeEntry({
        id: "e2",
        period: { from: "2026-01-01", to: "2026-01-31" },
        title: "Earlier project",
      }),
    ];
    const log = makeLog(entries);
    const md = await renderResume(log, { language: "en" });
    const earlierIdx = md.indexOf("Earlier project");
    const laterIdx = md.indexOf("Later project");
    // In the timeline section, earlier should come before later
    // But in the projects section, order is preserved
    // Timeline section should have earlier first
    const timelineSection = md.slice(md.indexOf("## Timeline"));
    const teIdx = timelineSection.indexOf("Earlier project");
    const tlIdx = timelineSection.indexOf("Later project");
    expect(teIdx).toBeLessThan(tlIdx);
  });
});

// ── Tailor: rerankByJd ───────────────────────────────────────────────────────

describe("rerankByJd", () => {
  it("reranks entries by keyword match", () => {
    const entries = [
      makeEntry({
        id: "e1",
        title: "Python data pipeline",
        tags: ["python", "data"],
        stack: ["Python", "Pandas"],
        highlights: [{ text: "Built ETL pipeline with pandas", tags: [] }],
      }),
      makeEntry({
        id: "e2",
        title: "TypeScript API development",
        tags: ["typescript", "rest", "node.js"],
        stack: ["TypeScript", "Node.js"],
        highlights: [{ text: "Developed REST API endpoints with authentication", tags: [] }],
      }),
    ];
    const jdText = "We are looking for a TypeScript developer with REST API experience";
    const reranked = rerankByJd(entries, jdText);
    // TypeScript entry should rank higher
    expect(reranked[0]?.id).toBe("e2");
  });

  it("returns all entries when no keywords match", () => {
    const entries = [makeEntry({ id: "e1" }), makeEntry({ id: "e2" })];
    const reranked = rerankByJd(entries, "zzzz zzzz");
    expect(reranked).toHaveLength(2);
  });

  it("handles empty JD text", () => {
    const entries = [makeEntry()];
    const reranked = rerankByJd(entries, "");
    expect(reranked).toHaveLength(1);
  });

  it("matches against highlight text", () => {
    const entries = [
      makeEntry({
        id: "e1",
        highlights: [{ text: "Built a REST API with authentication", tags: [] }],
      }),
      makeEntry({
        id: "e2",
        highlights: [{ text: "Wrote unit tests for the module", tags: [] }],
      }),
    ];
    const reranked = rerankByJd(entries, "REST API developer");
    expect(reranked[0]?.id).toBe("e1");
  });
});

describe("slugifyJd", () => {
  it("creates a slug from the first line", () => {
    expect(slugifyJd("Senior TypeScript Developer\nRemote")).toBe("senior-typescript-developer");
  });

  it("truncates to 60 chars", () => {
    const longTitle = "a".repeat(100);
    expect(slugifyJd(longTitle).length).toBeLessThanOrEqual(60);
  });

  it("returns 'jd' for empty input", () => {
    expect(slugifyJd("")).toBe("jd");
  });
});

// ── Pipeline: tailor integration ─────────────────────────────────────────────

describe("pipeline.tailor", () => {
  it("generates resume from experience log", async () => {
    // Set up data dir with experience log
    const dataDir = join(tmpDir, "data");
    const log = makeLog();
    await writeExperienceLog(dataDir, log);

    const { tailor } = await import("../src/core/pipeline.ts");
    const config = {
      login: "testuser",
      language: "zh" as const,
      llm: { provider: "openai-compatible" as const, model: "test", maxRetries: 2 },
      ignore: { repos: [], authors: [] },
      schedule: { cron: "0 0 * * 1", lookbackDays: 7 },
    };

    const result = await tailor(config, dataDir);
    expect(result.jdSlug).toBe("default");
    expect(result.outputPath).toContain("tailored");
    expect(result.outputPath).toContain(".md");

    // Verify the file was written
    const { readFile } = await import("node:fs/promises");
    const content = await readFile(result.outputPath, "utf8");
    expect(content).toContain("testuser");
    expect(content).toContain("Implement feature X");
  });

  it("reranks entries when JD is provided", async () => {
    const dataDir = join(tmpDir, "data");
    const entries = [
      makeEntry({
        id: "e1",
        title: "Python ETL pipeline",
        tags: ["python", "data"],
        stack: ["Python"],
        highlights: [{ text: "Built data pipeline with pandas", tags: [] }],
      }),
      makeEntry({
        id: "e2",
        title: "TypeScript API",
        tags: ["typescript", "rest"],
        stack: ["TypeScript"],
        highlights: [{ text: "Developed REST endpoints", tags: [] }],
      }),
    ];
    await writeExperienceLog(dataDir, makeLog(entries));

    const { tailor } = await import("../src/core/pipeline.ts");
    const config = {
      login: "testuser",
      language: "en" as const,
      llm: { provider: "openai-compatible" as const, model: "test", maxRetries: 2 },
      ignore: { repos: [], authors: [] },
      schedule: { cron: "0 0 * * 1", lookbackDays: 7 },
    };

    const result = await tailor(config, dataDir, "Looking for a TypeScript REST API developer");
    expect(result.jdSlug).toBe("looking-for-a-typescript-rest-api-developer");

    const { readFile } = await import("node:fs/promises");
    const content = await readFile(result.outputPath, "utf8");
    // TypeScript entry should appear first in the resume
    expect(content.indexOf("TypeScript API")).toBeLessThan(content.indexOf("Python ETL"));
  });

  it("throws when no experience log exists", async () => {
    const { tailor } = await import("../src/core/pipeline.ts");
    const config = {
      login: "testuser",
      language: "zh" as const,
      llm: { provider: "openai-compatible" as const, model: "test", maxRetries: 2 },
      ignore: { repos: [], authors: [] },
      schedule: { cron: "0 0 * * 1", lookbackDays: 7 },
    };
    await expect(tailor(config, join(tmpDir, "empty"))).rejects.toThrow("No experience log found");
  });
});

// ── IO: writeTailoredResume ──────────────────────────────────────────────────

describe("writeTailoredResume", () => {
  it("creates tailored directory and writes file", async () => {
    const { writeTailoredResume } = await import("../src/core/io/data.ts");
    const dataDir = join(tmpDir, "data");
    const path = await writeTailoredResume(dataDir, "my-jd", "# Resume\nContent");
    expect(path).toContain("tailored/my-jd.md");

    const { readFile } = await import("node:fs/promises");
    const content = await readFile(path, "utf8");
    expect(content).toBe("# Resume\nContent");
  });
});
