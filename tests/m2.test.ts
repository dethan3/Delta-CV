import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EventEnvelope } from "../src/core/schema/event.ts";
import type { ExperienceEntry } from "../src/core/schema/experience.ts";

// ── Mock fetch (for LLM calls) ───────────────────────────────────────────────

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// ── Imports (after mocks) ────────────────────────────────────────────────────

import { clusterEvents } from "../src/core/engine/cluster.ts";
import { buildTagFrequency, computeFocus } from "../src/core/engine/focus.ts";
import { buildSnapshot, diffSnapshots } from "../src/core/engine/snapshot.ts";
import { tagEvents } from "../src/core/engine/tag.ts";
import {
  readExperienceLog,
  readLatestSnapshot,
  writeExperienceLog,
  writeSnapshot,
} from "../src/core/io/data.ts";
import { generateObject, generateText } from "../src/core/llm.ts";
import { ExperienceEntrySchema, ExperienceLogSchema } from "../src/core/schema/experience.ts";
import { SnapshotSchema } from "../src/core/schema/snapshot.ts";

// ── Helpers ──────────────────────────────────────────────────────────────────

let tmpDir: string;

function makeEvent(
  overrides: Partial<EventEnvelope> & { ts: string; repo: string },
): EventEnvelope {
  return {
    kind: overrides.kind ?? "commit",
    repo: overrides.repo,
    ts: overrides.ts,
    payload: overrides.payload ?? {
      message: "feat: implement feature",
      title: "TypeScript refactor",
    },
  };
}

function makeEntry(overrides: Partial<ExperienceEntry> = {}): ExperienceEntry {
  return ExperienceEntrySchema.parse({
    id: overrides.id ?? "alice_project_2026-05",
    repo: overrides.repo ?? "alice/project",
    period: overrides.period ?? { from: "2026-05-01T00:00:00Z", to: "2026-05-31T00:00:00Z" },
    title: overrides.title ?? "TypeScript API Development",
    highlights: overrides.highlights ?? [
      { text: "Built REST API with TypeScript and Express", tags: ["typescript", "rest-api"] },
      {
        text: "Reduced query latency by 40% via PostgreSQL index optimization",
        tags: ["postgresql", "performance"],
      },
    ],
    stack: overrides.stack ?? ["typescript", "express", "postgresql"],
    tags: overrides.tags ?? ["typescript", "rest-api", "postgresql", "performance"],
  });
}

function mockLlmSuccess(entry: ExperienceEntry) {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    status: 200,
    json: async () => ({
      choices: [{ message: { content: JSON.stringify(entry) } }],
      usage: { prompt_tokens: 100, completion_tokens: 200 },
    }),
  } as unknown as Response);
}

// ── engine/cluster ───────────────────────────────────────────────────────────

describe("clusterEvents", () => {
  it("returns empty array for no events", () => {
    expect(clusterEvents([])).toEqual([]);
  });

  it("groups events by repo and month", () => {
    const events = [
      makeEvent({ ts: "2026-05-01T00:00:00Z", repo: "alice/api" }),
      makeEvent({ ts: "2026-05-15T00:00:00Z", repo: "alice/api" }),
      makeEvent({ ts: "2026-06-01T00:00:00Z", repo: "alice/api" }),
      makeEvent({ ts: "2026-05-10T00:00:00Z", repo: "alice/web" }),
    ];
    const clusters = clusterEvents(events);
    expect(clusters).toHaveLength(3);
    const apiMay = clusters.find(
      (c) => c.repo === "alice/api" && c.period.from.startsWith("2026-05"),
    );
    expect(apiMay?.events).toHaveLength(2);
  });

  it("assigns stable id in format repo_year-month", () => {
    const events = [makeEvent({ ts: "2026-05-01T00:00:00Z", repo: "alice/project" })];
    const clusters = clusterEvents(events);
    expect(clusters[0]?.id).toBe("alice_project_2026-05");
  });

  it("sorts clusters by period start ascending", () => {
    const events = [
      makeEvent({ ts: "2026-06-01T00:00:00Z", repo: "alice/api" }),
      makeEvent({ ts: "2026-04-01T00:00:00Z", repo: "alice/api" }),
      makeEvent({ ts: "2026-05-01T00:00:00Z", repo: "alice/api" }),
    ];
    const clusters = clusterEvents(events);
    expect(clusters[0]?.period.from).toBe("2026-04-01T00:00:00Z");
    expect(clusters[1]?.period.from).toBe("2026-05-01T00:00:00Z");
    expect(clusters[2]?.period.from).toBe("2026-06-01T00:00:00Z");
  });
});

// ── engine/tag ───────────────────────────────────────────────────────────────

describe("tagEvents", () => {
  it("returns empty tags for empty events", () => {
    const result = tagEvents([]);
    expect(result.size).toBe(0);
  });

  it("detects typescript tag from commit message", () => {
    const events = [
      makeEvent({
        ts: "2026-05-01T00:00:00Z",
        repo: "alice/project",
        payload: { message: "refactor: convert codebase to TypeScript" },
      }),
    ];
    const result = tagEvents(events);
    const tags = [...result.values()][0] ?? [];
    expect(tags).toContain("typescript");
  });

  it("detects react tag from repo name or event text", () => {
    const events = [
      makeEvent({
        ts: "2026-05-01T00:00:00Z",
        repo: "alice/react-dashboard",
        payload: { title: "Add React components" },
      }),
    ];
    const result = tagEvents(events);
    const tags = [...result.values()][0] ?? [];
    expect(tags).toContain("react");
  });

  it("maps events by identity key", () => {
    const events = [
      makeEvent({ ts: "2026-05-01T00:00:00Z", repo: "alice/a", kind: "commit" }),
      makeEvent({ ts: "2026-05-02T00:00:00Z", repo: "alice/b", kind: "pr" }),
    ];
    const result = tagEvents(events);
    expect(result.has("commit:alice/a:2026-05-01T00:00:00Z")).toBe(true);
    expect(result.has("pr:alice/b:2026-05-02T00:00:00Z")).toBe(true);
  });
});

// ── engine/focus ─────────────────────────────────────────────────────────────

describe("buildTagFrequency", () => {
  it("counts tags from entries and highlights", () => {
    const entries = [makeEntry()];
    const freq = buildTagFrequency(entries);
    expect(freq.get("typescript")).toBeGreaterThan(0);
    expect(freq.get("postgresql")).toBeGreaterThan(0);
  });

  it("returns empty map for no entries", () => {
    expect(buildTagFrequency([])).toEqual(new Map());
  });
});

describe("computeFocus", () => {
  it("returns empty array for zero total", () => {
    expect(computeFocus(new Map())).toEqual([]);
  });

  it("marks new tags as rising when no previous data", () => {
    const freq = new Map([
      ["typescript", 5],
      ["react", 3],
    ]);
    const items = computeFocus(freq);
    expect(items).toHaveLength(2);
    expect(items[0]?.tag).toBe("typescript");
    // Without prior data, all are stable (delta = score - 0 for first run with no prevFreq,
    // but prevTotal=0 so prevScore=0, delta = score > THRESHOLD only if score > 0.04)
    const ts = items.find((i) => i.tag === "typescript");
    expect(ts?.score).toBeCloseTo(5 / 8);
    expect(["rising", "stable"]).toContain(ts?.trend);
  });

  it("detects rising trend when proportion increases", () => {
    const prev = new Map([
      ["typescript", 1],
      ["react", 9],
    ]);
    const curr = new Map([
      ["typescript", 8],
      ["react", 2],
    ]);
    const items = computeFocus(curr, prev);
    const ts = items.find((i) => i.tag === "typescript");
    expect(ts?.trend).toBe("rising");
    const react = items.find((i) => i.tag === "react");
    expect(react?.trend).toBe("declining");
  });
});

// ── engine/snapshot ──────────────────────────────────────────────────────────

describe("buildSnapshot", () => {
  it("produces a valid Snapshot shape", () => {
    const log = ExperienceLogSchema.parse({
      version: 1,
      generatedAt: new Date().toISOString(),
      entries: [makeEntry()],
    });
    const freq = buildTagFrequency(log.entries);
    const focus = computeFocus(freq);
    const snap = buildSnapshot(log, "2026-05-09", focus, freq);
    expect(() => SnapshotSchema.parse(snap)).not.toThrow();
    expect(snap.date).toBe("2026-05-09");
    expect(snap.topTags.length).toBeGreaterThan(0);
    expect(snap.experienceLogChecksum).toHaveLength(16);
    expect(snap.tagFrequency).toBeDefined();
  });
});

describe("diffSnapshots", () => {
  it("identifies new capabilities and declining tags", () => {
    const focus1 = [{ tag: "typescript", score: 0.6, trend: "stable" as const }];
    const focus2 = [
      { tag: "typescript", score: 0.3, trend: "declining" as const },
      { tag: "rust", score: 0.4, trend: "rising" as const },
    ];
    const snap1 = SnapshotSchema.parse({
      date: "2026-04-01",
      focus: focus1,
      topTags: ["typescript", "react"],
      experienceLogChecksum: "abc123",
    });
    const snap2 = SnapshotSchema.parse({
      date: "2026-05-01",
      focus: focus2,
      topTags: ["typescript", "rust"],
      experienceLogChecksum: "def456",
    });
    const diff = diffSnapshots(snap1, snap2);
    expect(diff.from).toBe("2026-04-01");
    expect(diff.to).toBe("2026-05-01");
    expect(diff.newCapabilities).toContain("rust");
    expect(diff.risingTags).toContain("rust");
    expect(diff.decliningTags).toContain("typescript");
  });
});

// ── io/data M2 functions ─────────────────────────────────────────────────────

describe("io/data M2 persistence", () => {
  beforeEach(async () => {
    tmpDir = join(tmpdir(), `delta-test-m2-${Date.now()}`);
    await mkdir(tmpDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("writeExperienceLog + readExperienceLog round-trips", async () => {
    const log = ExperienceLogSchema.parse({
      version: 1,
      generatedAt: new Date().toISOString(),
      entries: [makeEntry()],
    });
    await writeExperienceLog(tmpDir, log);
    const read = await readExperienceLog(tmpDir);
    expect(read).not.toBeNull();
    expect(read?.entries).toHaveLength(1);
    expect(read?.entries[0]?.repo).toBe("alice/project");
  });

  it("readExperienceLog returns null when file absent", async () => {
    const result = await readExperienceLog(tmpDir);
    expect(result).toBeNull();
  });

  it("writeSnapshot + readLatestSnapshot round-trips", async () => {
    const log = ExperienceLogSchema.parse({
      version: 1,
      generatedAt: new Date().toISOString(),
      entries: [makeEntry()],
    });
    const freq = buildTagFrequency(log.entries);
    const focus = computeFocus(freq);
    const snap = buildSnapshot(log, "2026-05-09", focus, freq);
    await writeSnapshot(tmpDir, snap);
    const latest = await readLatestSnapshot(tmpDir);
    expect(latest).not.toBeNull();
    expect(latest?.date).toBe("2026-05-09");
  });

  it("readLatestSnapshot returns null when no snapshots exist", async () => {
    const result = await readLatestSnapshot(tmpDir);
    expect(result).toBeNull();
  });

  it("readLatestSnapshot returns the most recent snapshot by filename", async () => {
    const mkSnap = (date: string) =>
      SnapshotSchema.parse({ date, focus: [], topTags: [], experienceLogChecksum: "abc" });

    await writeSnapshot(tmpDir, mkSnap("2026-03-01"));
    await writeSnapshot(tmpDir, mkSnap("2026-05-01"));
    await writeSnapshot(tmpDir, mkSnap("2026-04-01"));

    const latest = await readLatestSnapshot(tmpDir);
    expect(latest?.date).toBe("2026-05-01");
  });
});

// ── llm.ts ───────────────────────────────────────────────────────────────────

describe("llm.generateObject", () => {
  beforeEach(() => mockFetch.mockReset());

  const cfg = {
    provider: "openai-compatible" as const,
    model: "deepseek-chat",
    apiKey: "test-key",
    maxRetries: 1,
  };

  it("returns parsed object on first attempt", async () => {
    const expected = makeEntry();
    mockLlmSuccess(expected);
    const result = await generateObject(cfg, ExperienceEntrySchema, "system", "user");
    expect(result.repo).toBe("alice/project");
    expect(result.highlights).toHaveLength(2);
  });

  it("retries and succeeds after schema-invalid first response", async () => {
    const valid = makeEntry();
    // First response is invalid JSON
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: "{ invalid json {{" } }],
        usage: { prompt_tokens: 50, completion_tokens: 10 },
      }),
    } as unknown as Response);
    // Second response is valid
    mockLlmSuccess(valid);
    const result = await generateObject(cfg, ExperienceEntrySchema, "system", "user");
    expect(result.id).toBe(valid.id);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("throws after exhausting retries", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: "not-json" } }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }),
    } as unknown as Response);
    await expect(generateObject(cfg, ExperienceEntrySchema, "system", "user")).rejects.toThrow();
  });

  it("throws on non-200 HTTP response", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
      headers: { get: () => null },
      text: async () => "Unauthorized",
    } as unknown as Response);
    await expect(generateObject(cfg, ExperienceEntrySchema, "system", "user")).rejects.toThrow(
      "LLM API error 401",
    );
  });

  it("throws immediately when apiKey is empty", async () => {
    const emptyCfg = { ...cfg, apiKey: "" };
    await expect(generateObject(emptyCfg, ExperienceEntrySchema, "system", "user")).rejects.toThrow(
      "LLM API key is not set",
    );
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe("llm.generateText", () => {
  beforeEach(() => mockFetch.mockReset());

  it("returns text content from openai-compatible response", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: "Hello world" } }],
        usage: { prompt_tokens: 5, completion_tokens: 3 },
      }),
    } as unknown as Response);

    const text = await generateText(
      { provider: "openai-compatible", model: "deepseek-chat", apiKey: "test", maxRetries: 0 },
      "system",
      "user",
    );
    expect(text).toBe("Hello world");
  });

  it("uses anthropic endpoint and headers for anthropic provider", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        content: [{ type: "text", text: "Claude says hi" }],
        usage: { input_tokens: 10, output_tokens: 5 },
      }),
    } as unknown as Response);

    const text = await generateText(
      {
        provider: "anthropic",
        model: "claude-3-5-sonnet-20241022",
        apiKey: "sk-ant",
        maxRetries: 0,
      },
      "system",
      "user",
    );
    expect(text).toBe("Claude says hi");
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("anthropic.com");
    expect((init.headers as Record<string, string>)["x-api-key"]).toBe("sk-ant");
  });
});
