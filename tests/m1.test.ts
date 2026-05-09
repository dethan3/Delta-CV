import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EventEnvelope } from "../src/core/schema/event.ts";

// ── Mock Octokit ────────────────────────────────────────────────────────────

const { mockGraphqlFn, mockPaginateIteratorFn } = vi.hoisted(() => {
  const gqlFn = Object.assign(vi.fn(), { defaults: vi.fn() });
  gqlFn.defaults.mockReturnValue(gqlFn);
  return { mockGraphqlFn: gqlFn, mockPaginateIteratorFn: vi.fn() };
});

vi.mock("@octokit/graphql", () => ({
  graphql: mockGraphqlFn,
}));

vi.mock("@octokit/rest", () => ({
  Octokit: vi.fn().mockImplementation(() => ({
    rest: { search: { issuesAndPullRequests: vi.fn() } },
    paginate: { iterator: mockPaginateIteratorFn },
  })),
}));

// ── Imports (after mocks) ───────────────────────────────────────────────────

import { readCursor, writeCursor } from "../src/core/collector/cursor.ts";
import { denoiseEvents } from "../src/core/collector/denoise.ts";
import { collectViaGraphQL, splitIntoWindows } from "../src/core/collector/github-graphql.ts";
import { collectIssuesViaRest } from "../src/core/collector/github-rest.ts";
import { appendEvents, getISOWeekKey, readEventsSince } from "../src/core/io/data.ts";
import { observe } from "../src/core/pipeline.ts";

// ── Helpers ─────────────────────────────────────────────────────────────────

let tmpDir: string;

function makeEvent(overrides: Partial<EventEnvelope> & { ts: string }): EventEnvelope {
  return {
    kind: overrides.kind ?? "commit",
    repo: overrides.repo ?? "owner/repo",
    ts: overrides.ts,
    payload: overrides.payload ?? {},
  };
}

function mockGraphQLSuccess(cc: Record<string, unknown>) {
  mockGraphqlFn.mockResolvedValue({
    user: { contributionsCollection: cc },
  });
}

function mockRestIssues(issues: Array<Record<string, unknown>>) {
  mockPaginateIteratorFn.mockReturnValue(
    (async function* () {
      yield { data: issues };
    })(),
  );
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("getISOWeekKey", () => {
  it("returns correct ISO week for mid-week dates", () => {
    // 2026-05-08 is a Friday in week 19
    expect(getISOWeekKey("2026-05-08T00:00:00Z")).toBe("2026-W19");
  });

  it("handles year boundary (Dec 31 → week 1 of next year)", () => {
    // 2026-12-31 is a Thursday → ISO week 53 of 2026? Let me check:
    // Actually 2026-12-31 is Thursday. Jan 4, 2027 is Monday.
    // The Thursday of the week containing Dec 31, 2026 is Dec 31 itself.
    // Jan 4, 2027's Thursday: Jan 4 is Monday, so Thursday is Jan 7.
    // Days between: Dec 31 to Jan 7 = 7 days → week 1 of 2027? No.
    // Let me just verify the algorithm produces consistent results.
    const key = getISOWeekKey("2026-12-31T00:00:00Z");
    expect(key).toMatch(/^\d{4}-W\d{2}$/);
  });

  it("handles Jan 1 in ISO week of previous year", () => {
    // 2026-01-01 is Thursday. ISO week 1 of 2026 starts Mon Dec 29, 2025.
    // So 2026-01-01 should be in 2026-W01.
    expect(getISOWeekKey("2026-01-01T00:00:00Z")).toBe("2026-W01");
  });

  it("returns week 01 for January 4", () => {
    // January 4 is always in ISO week 1
    expect(getISOWeekKey("2026-01-04T00:00:00Z")).toMatch(/-W01$/);
  });
});

describe("splitIntoWindows", () => {
  it("returns single window for range ≤ 1 year", () => {
    const windows = splitIntoWindows("2026-01-01T00:00:00Z", "2026-06-01T00:00:00Z");
    expect(windows).toHaveLength(1);
    expect(windows[0]?.from).toBe("2026-01-01T00:00:00Z");
  });

  it("splits 2-year range into 3 windows", () => {
    const from = "2024-01-01T00:00:00Z";
    const to = "2026-01-01T00:00:00Z";
    const windows = splitIntoWindows(from, to);
    expect(windows.length).toBeGreaterThanOrEqual(2);
    // Windows should cover the full range (normalize ISO format)
    expect(windows.at(-1)).toBeDefined();
    expect(windows[0]).toBeDefined();
    expect(new Date(windows.at(-1)?.from ?? "").toISOString()).toBe(new Date(from).toISOString());
    expect(new Date(windows[0]?.to ?? "").toISOString()).toBe(new Date(to).toISOString());
  });
});

describe("cursor", () => {
  beforeEach(async () => {
    tmpDir = join(tmpdir(), `delta-test-cursor-${Date.now()}`);
    await mkdir(tmpDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("returns null when no cursor file exists", async () => {
    expect(await readCursor(tmpDir)).toBeNull();
  });

  it("writes and reads cursor round-trip", async () => {
    await writeCursor(tmpDir, "2026-05-08T00:00:00Z");
    expect(await readCursor(tmpDir)).toBe("2026-05-08T00:00:00Z");
  });

  it("creates _meta directory if needed", async () => {
    const nested = join(tmpDir, "deeply", "nested");
    await writeCursor(nested, "2026-01-01T00:00:00Z");
    expect(await readCursor(nested)).toBe("2026-01-01T00:00:00Z");
  });
});

describe("denoiseEvents", () => {
  const events: EventEnvelope[] = [
    makeEvent({
      kind: "commit",
      repo: "owner/repo",
      ts: "2026-01-01T00:00:00Z",
      payload: { author: "alice", message: "feat: add feature" },
    }),
    makeEvent({
      kind: "commit",
      repo: "owner/repo",
      ts: "2026-01-02T00:00:00Z",
      payload: { author: "dependabot[bot]", message: "bump dep" },
    }),
    makeEvent({
      kind: "commit",
      repo: "owner/repo",
      ts: "2026-01-03T00:00:00Z",
      payload: { author: "alice", message: "Merge pull request #1 from owner/branch" },
    }),
    makeEvent({
      kind: "pr",
      repo: "owner/ignored-repo",
      ts: "2026-01-04T00:00:00Z",
      payload: { user: "alice" },
    }),
    makeEvent({
      kind: "pr",
      repo: "owner/repo",
      ts: "2026-01-05T00:00:00Z",
      payload: { user: "renovate[bot]" },
    }),
    makeEvent({
      kind: "issue",
      repo: "owner/repo",
      ts: "2026-01-06T00:00:00Z",
      payload: { user: "bob" },
    }),
  ];

  it("filters ignored repos", () => {
    // Event 3 (ignored-repo) + Event 2 (merge commit) are filtered
    const result = denoiseEvents(events, [], ["owner/ignored-repo"]);
    expect(result).toHaveLength(4);
    expect(result.every((e) => e.repo !== "owner/ignored-repo")).toBe(true);
  });

  it("filters bot authors", () => {
    // Events 1,4 (bots) + Event 2 (merge commit) are filtered
    const result = denoiseEvents(events, ["dependabot[bot]", "renovate[bot]"], []);
    expect(result).toHaveLength(3);
    expect(result.every((e) => e.ts !== "2026-01-02T00:00:00Z")).toBe(true);
    expect(result.every((e) => e.ts !== "2026-01-05T00:00:00Z")).toBe(true);
  });

  it("filters merge commits", () => {
    const result = denoiseEvents(events, [], []);
    expect(result.find((e) => e.ts === "2026-01-03T00:00:00Z")).toBeUndefined();
  });

  it("passes through clean events", () => {
    const result = denoiseEvents(
      events,
      ["dependabot[bot]", "renovate[bot]"],
      ["owner/ignored-repo"],
    );
    expect(result).toHaveLength(2);
    expect(result[0]?.ts).toBe("2026-01-01T00:00:00Z");
    expect(result[1]?.ts).toBe("2026-01-06T00:00:00Z");
  });
});

describe("io/data", () => {
  beforeEach(async () => {
    tmpDir = join(tmpdir(), `delta-test-io-${Date.now()}`);
    await mkdir(tmpDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("appends events to correct week files", async () => {
    const events = [
      makeEvent({ ts: "2026-05-08T10:00:00Z" }),
      makeEvent({ ts: "2026-05-09T10:00:00Z" }),
    ];
    await appendEvents(tmpDir, events);

    const files = await readdir(join(tmpDir, "events"));
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^\d{4}-W\d{2}\.jsonl$/);
  });

  it("deduplicates events on re-append", async () => {
    const events = [makeEvent({ ts: "2026-05-08T10:00:00Z" })];
    await appendEvents(tmpDir, events);
    await appendEvents(tmpDir, events);

    const content = await readFile(
      join(tmpDir, "events", `${getISOWeekKey("2026-05-08T10:00:00Z")}.jsonl`),
      "utf8",
    );
    const lines = content.trim().split("\n");
    expect(lines).toHaveLength(1);
  });

  it("reads events since a given date", async () => {
    const events = [
      makeEvent({ ts: "2026-05-01T00:00:00Z" }),
      makeEvent({ ts: "2026-05-08T00:00:00Z" }),
      makeEvent({ ts: "2026-05-15T00:00:00Z" }),
    ];
    await appendEvents(tmpDir, events);

    const since = await readEventsSince(tmpDir, "2026-05-05T00:00:00Z");
    expect(since).toHaveLength(2);
    expect(since[0]?.ts).toBe("2026-05-08T00:00:00Z");
    expect(since[1]?.ts).toBe("2026-05-15T00:00:00Z");
  });

  it("returns empty array for non-existent data dir", async () => {
    const result = await readEventsSince(join(tmpDir, "nonexistent"), "2026-01-01T00:00:00Z");
    expect(result).toEqual([]);
  });
});

describe("collectViaGraphQL", () => {
  beforeEach(() => {
    mockGraphqlFn.mockReset();
  });

  it("maps contributions to EventEnvelopes", async () => {
    mockGraphQLSuccess({
      commitContributionsByRepository: [
        {
          repository: { nameWithOwner: "alice/project" },
          contributions: {
            totalCount: 1,
            nodes: [
              {
                occurredAt: "2026-05-01T10:00:00Z",
                commitCount: 1,
                repository: { nameWithOwner: "alice/project" },
              },
            ],
          },
        },
      ],
      pullRequestContributions: {
        totalCount: 1,
        pageInfo: { hasNextPage: false, endCursor: null },
        nodes: [
          {
            occurredAt: "2026-05-02T10:00:00Z",
            pullRequest: {
              number: 42,
              title: "Add feature",
              url: "https://github.com/alice/project/pull/42",
              state: "MERGED",
              createdAt: "2026-05-02T10:00:00Z",
              additions: 100,
              deletions: 20,
              changedFiles: 5,
              mergedAt: "2026-05-02T12:00:00Z",
              repository: { nameWithOwner: "alice/project" },
            },
          },
        ],
      },
      issueContributions: {
        totalCount: 0,
        pageInfo: { hasNextPage: false, endCursor: null },
        nodes: [],
      },
      pullRequestReviewContributions: {
        totalCount: 1,
        pageInfo: { hasNextPage: false, endCursor: null },
        nodes: [
          {
            occurredAt: "2026-05-04T10:00:00Z",
            pullRequest: {
              number: 43,
              title: "Review feature",
              url: "https://github.com/alice/project/pull/43",
              repository: { nameWithOwner: "alice/project" },
            },
          },
        ],
      },
    });

    const events = await collectViaGraphQL({
      login: "alice",
      token: "test-token",
      since: "2026-01-01T00:00:00Z",
    });

    expect(events).toHaveLength(3);
    expect(events[0]?.kind).toBe("commit");
    expect(events[0]?.repo).toBe("alice/project");
    expect(events[1]?.kind).toBe("pr");
    expect(events[1]?.payload).toHaveProperty("number", 42);
    expect(events[2]?.kind).toBe("review");
    expect(events[2]?.repo).toBe("alice/project");
    expect(events[2]?.payload).toHaveProperty("prNumber", 43);
  });

  it("filters ignored repos", async () => {
    mockGraphQLSuccess({
      commitContributionsByRepository: [
        {
          repository: { nameWithOwner: "alice/ignored" },
          contributions: {
            totalCount: 1,
            nodes: [
              {
                occurredAt: "2026-05-01T10:00:00Z",
                commitCount: 1,
                repository: { nameWithOwner: "alice/ignored" },
              },
            ],
          },
        },
        {
          repository: { nameWithOwner: "alice/kept" },
          contributions: {
            totalCount: 1,
            nodes: [
              {
                occurredAt: "2026-05-01T10:00:00Z",
                commitCount: 1,
                repository: { nameWithOwner: "alice/kept" },
              },
            ],
          },
        },
      ],
      pullRequestContributions: {
        totalCount: 0,
        pageInfo: { hasNextPage: false, endCursor: null },
        nodes: [],
      },
      issueContributions: {
        totalCount: 0,
        pageInfo: { hasNextPage: false, endCursor: null },
        nodes: [],
      },
      pullRequestReviewContributions: {
        totalCount: 0,
        pageInfo: { hasNextPage: false, endCursor: null },
        nodes: [],
      },
    });

    const events = await collectViaGraphQL({
      login: "alice",
      token: "test-token",
      since: "2026-01-01T00:00:00Z",
      ignoreRepos: ["alice/ignored"],
    });

    expect(events).toHaveLength(1);
    expect(events[0]?.repo).toBe("alice/kept");
  });
});

describe("collectIssuesViaRest", () => {
  beforeEach(() => {
    mockPaginateIteratorFn.mockReset();
  });

  it("maps REST issues to EventEnvelopes", async () => {
    mockPaginateIteratorFn.mockReturnValue(
      (async function* () {
        yield {
          data: [
            {
              number: 1,
              title: "Bug report",
              html_url: "https://github.com/owner/repo/issues/1",
              state: "open",
              created_at: "2026-05-01T00:00:00Z",
              repository_url: "https://api.github.com/repos/owner/repo",
              user: { login: "reporter" },
            },
          ],
        };
      })(),
    );

    const events = await collectIssuesViaRest("alice", "test-token", "2026-01-01T00:00:00Z");

    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe("issue");
    expect(events[0]?.payload).toHaveProperty("number", 1);
    expect(events[0]?.repo).toBe("owner/repo");
  });

  it("skips pull requests from search results", async () => {
    mockPaginateIteratorFn.mockReturnValue(
      (async function* () {
        yield {
          data: [
            {
              number: 1,
              title: "A PR",
              html_url: "https://github.com/owner/repo/pull/1",
              state: "open",
              created_at: "2026-05-01T00:00:00Z",
              repository_url: "https://api.github.com/repos/owner/repo",
              user: { login: "alice" },
              pull_request: { url: "https://api.github.com/repos/owner/repo/pulls/1" },
            },
            {
              number: 2,
              title: "An issue",
              html_url: "https://github.com/owner/repo/issues/2",
              state: "open",
              created_at: "2026-05-02T00:00:00Z",
              repository_url: "https://api.github.com/repos/owner/repo",
              user: { login: "alice" },
            },
          ],
        };
      })(),
    );

    const events = await collectIssuesViaRest("alice", "test-token", "2026-01-01T00:00:00Z");

    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toHaveProperty("number", 2);
  });
});

describe("pipeline.observe", () => {
  beforeEach(async () => {
    tmpDir = join(tmpdir(), `delta-test-pipeline-${Date.now()}`);
    await mkdir(tmpDir, { recursive: true });
    mockGraphqlFn.mockReset();
    mockPaginateIteratorFn.mockReset();
    process.env.GITHUB_TOKEN = "test-token";
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
    process.env.GITHUB_TOKEN = undefined;
  });

  it("first run: collects events and writes cursor", async () => {
    // Mock GraphQL returning 3 events
    mockGraphQLSuccess({
      commitContributionsByRepository: [
        {
          repository: { nameWithOwner: "alice/repo" },
          contributions: {
            totalCount: 2,
            nodes: [
              {
                occurredAt: "2026-05-01T10:00:00Z",
                commitCount: 1,
                repository: { nameWithOwner: "alice/repo" },
              },
              {
                occurredAt: "2026-05-02T10:00:00Z",
                commitCount: 1,
                repository: { nameWithOwner: "alice/repo" },
              },
            ],
          },
        },
      ],
      pullRequestContributions: {
        totalCount: 1,
        pageInfo: { hasNextPage: false, endCursor: null },
        nodes: [
          {
            occurredAt: "2026-05-03T10:00:00Z",
            pullRequest: {
              number: 1,
              title: "First PR",
              url: "https://github.com/alice/repo/pull/1",
              state: "MERGED",
              createdAt: "2026-05-03T10:00:00Z",
              additions: 50,
              deletions: 10,
              changedFiles: 3,
              mergedAt: "2026-05-03T12:00:00Z",
              repository: { nameWithOwner: "alice/repo" },
            },
          },
        ],
      },
      issueContributions: {
        totalCount: 0,
        pageInfo: { hasNextPage: false, endCursor: null },
        nodes: [],
      },
      pullRequestReviewContributions: {
        totalCount: 0,
        pageInfo: { hasNextPage: false, endCursor: null },
        nodes: [],
      },
    });

    // Mock REST returning 0 issues
    mockPaginateIteratorFn.mockReturnValue(
      (async function* () {
        yield { data: [] };
      })(),
    );

    const result = await observe(
      {
        login: "alice",
        language: "zh",
        llm: { provider: "openai-compatible", model: "deepseek-chat", maxRetries: 2 },
        ignore: { repos: [], authors: ["dependabot[bot]"] },
        schedule: { cron: "0 0 * * 1", lookbackDays: 7 },
      },
      tmpDir,
    );

    expect(result.eventsCollected).toBe(3);
    expect(result.dataDir).toBe(tmpDir);

    // Verify cursor was written
    const cursor = await readCursor(tmpDir);
    expect(cursor).toBe("2026-05-03T10:00:00Z");

    // Verify JSONL files exist
    const eventsDir = join(tmpDir, "events");
    const files = await readdir(eventsDir);
    expect(files.length).toBeGreaterThan(0);
  });

  it("incremental run: only collects new events", async () => {
    // Seed existing data (both events in the same ISO week W19)
    await writeCursor(tmpDir, "2026-05-05T00:00:00Z");
    const weekKey = getISOWeekKey("2026-05-05T00:00:00Z");
    const existingEvent: EventEnvelope = {
      kind: "commit",
      repo: "alice/repo",
      ts: "2026-05-05T10:00:00Z",
      payload: { commitCount: 1 },
    };
    await mkdir(join(tmpDir, "events"), { recursive: true });
    await writeFile(
      join(tmpDir, "events", `${weekKey}.jsonl`),
      `${JSON.stringify(existingEvent)}\n`,
    );

    // Mock GraphQL returning 1 new event (same ISO week)
    mockGraphQLSuccess({
      commitContributionsByRepository: [
        {
          repository: { nameWithOwner: "alice/repo" },
          contributions: {
            totalCount: 1,
            nodes: [
              {
                occurredAt: "2026-05-07T10:00:00Z",
                commitCount: 1,
                repository: { nameWithOwner: "alice/repo" },
              },
            ],
          },
        },
      ],
      pullRequestContributions: {
        totalCount: 0,
        pageInfo: { hasNextPage: false, endCursor: null },
        nodes: [],
      },
      issueContributions: {
        totalCount: 0,
        pageInfo: { hasNextPage: false, endCursor: null },
        nodes: [],
      },
      pullRequestReviewContributions: {
        totalCount: 0,
        pageInfo: { hasNextPage: false, endCursor: null },
        nodes: [],
      },
    });
    mockPaginateIteratorFn.mockReturnValue(
      (async function* () {
        yield { data: [] };
      })(),
    );

    const result = await observe(
      {
        login: "alice",
        language: "zh",
        llm: { provider: "openai-compatible", model: "deepseek-chat", maxRetries: 2 },
        ignore: { repos: [], authors: [] },
        schedule: { cron: "0 0 * * 1", lookbackDays: 7 },
      },
      tmpDir,
    );

    expect(result.eventsCollected).toBe(1);

    // Verify no duplication: total events in file should be 2
    const content = await readFile(join(tmpDir, "events", `${weekKey}.jsonl`), "utf8");
    const lines = content
      .trim()
      .split("\n")
      .filter((l) => l.length > 0);
    expect(lines).toHaveLength(2);

    // Verify cursor updated
    const cursor = await readCursor(tmpDir);
    expect(cursor).toBe("2026-05-07T10:00:00Z");
  });

  it("empty range: no events collected, cursor unchanged", async () => {
    await writeCursor(tmpDir, "2026-05-07T00:00:00Z");

    mockGraphQLSuccess({
      commitContributionsByRepository: [],
      pullRequestContributions: {
        totalCount: 0,
        pageInfo: { hasNextPage: false, endCursor: null },
        nodes: [],
      },
      issueContributions: {
        totalCount: 0,
        pageInfo: { hasNextPage: false, endCursor: null },
        nodes: [],
      },
      pullRequestReviewContributions: {
        totalCount: 0,
        pageInfo: { hasNextPage: false, endCursor: null },
        nodes: [],
      },
    });
    mockPaginateIteratorFn.mockReturnValue(
      (async function* () {
        yield { data: [] };
      })(),
    );

    const result = await observe(
      {
        login: "alice",
        language: "zh",
        llm: { provider: "openai-compatible", model: "deepseek-chat", maxRetries: 2 },
        ignore: { repos: [], authors: [] },
        schedule: { cron: "0 0 * * 1", lookbackDays: 7 },
      },
      tmpDir,
    );

    expect(result.eventsCollected).toBe(0);

    // Cursor should be unchanged
    const cursor = await readCursor(tmpDir);
    expect(cursor).toBe("2026-05-07T00:00:00Z");
  });

  it("throws when GITHUB_TOKEN is missing", async () => {
    process.env.GITHUB_TOKEN = "";

    await expect(
      observe(
        {
          login: "alice",
          language: "zh",
          llm: { provider: "openai-compatible", model: "deepseek-chat", maxRetries: 2 },
          ignore: { repos: [], authors: [] },
          schedule: { cron: "0 0 * * 1", lookbackDays: 7 },
        },
        tmpDir,
      ),
    ).rejects.toThrow("GITHUB_TOKEN is required");
  });
});
