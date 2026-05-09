import { graphql } from "@octokit/graphql";
import type { EventEnvelope } from "../schema/event.ts";

export interface CollectOptions {
  login: string;
  token: string;
  since: string;
  to?: string;
  ignoreRepos?: string[];
  includePrivate?: boolean;
}

// ── GraphQL response types ──────────────────────────────────────────────────

interface PageInfo {
  hasNextPage: boolean;
  endCursor: string | null;
}

interface CommitContribNode {
  occurredAt: string;
  commitCount: number;
  repository: { nameWithOwner: string };
}

interface PullRequestNode {
  number: number;
  title: string;
  url: string;
  state: string;
  createdAt: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  mergedAt: string | null;
  repository: { nameWithOwner: string };
}

interface IssueNode {
  number: number;
  title: string;
  url: string;
  state: string;
  createdAt: string;
  repository: { nameWithOwner: string };
}

interface ReviewNode {
  submittedAt: string;
  state: string;
  pullRequest: {
    number: number;
    title: string;
    url: string;
    repository: { nameWithOwner: string };
  };
}

interface ContributionNode<T> {
  occurredAt: string;
  __node: T;
}

interface ContributionsCollection {
  commitContributionsByRepository: Array<{
    repository: { nameWithOwner: string };
    contributions: { totalCount: number; nodes: CommitContribNode[] };
  }>;
  pullRequestContributions: {
    totalCount: number;
    pageInfo: PageInfo;
    nodes: Array<{ occurredAt: string; pullRequest: PullRequestNode }>;
  };
  issueContributions: {
    totalCount: number;
    pageInfo: PageInfo;
    nodes: Array<{ occurredAt: string; issue: IssueNode }>;
  };
  pullRequestReviewContributions: {
    totalCount: number;
    pageInfo: PageInfo;
    nodes: Array<{ occurredAt: string; pullRequest: ReviewNode }>;
  };
}

interface GraphQLResponse {
  user: { contributionsCollection: ContributionsCollection } | null;
}

// ── Queries ─────────────────────────────────────────────────────────────────

const CONTRIBUTIONS_QUERY = `
  query($login: String!, $from: DateTime!, $to: DateTime!, $prAfter: String, $issueAfter: String, $reviewAfter: String) {
    user(login: $login) {
      contributionsCollection(from: $from, to: $to) {
        commitContributionsByRepository(maxRepositories: 100) {
          repository { nameWithOwner }
          contributions(first: 100) {
            totalCount
            nodes {
              occurredAt
              commitCount
              repository { nameWithOwner }
            }
          }
        }
        pullRequestContributions(first: 100, after: $prAfter) {
          totalCount
          pageInfo { hasNextPage endCursor }
          nodes {
            occurredAt
            pullRequest {
              number title url state createdAt
              additions deletions changedFiles mergedAt
              repository { nameWithOwner }
            }
          }
        }
        issueContributions(first: 100, after: $issueAfter) {
          totalCount
          pageInfo { hasNextPage endCursor }
          nodes {
            occurredAt
            issue {
              number title url state createdAt
              repository { nameWithOwner }
            }
          }
        }
        pullRequestReviewContributions(first: 100, after: $reviewAfter) {
          totalCount
          pageInfo { hasNextPage endCursor }
          nodes {
            occurredAt
            pullRequest {
              number title url
              repository { nameWithOwner }
            }
          }
        }
      }
    }
  }
`;

const PR_QUERY = `
  query($login: String!, $from: DateTime!, $to: DateTime!, $after: String) {
    user(login: $login) {
      contributionsCollection(from: $from, to: $to) {
        pullRequestContributions(first: 100, after: $after) {
          pageInfo { hasNextPage endCursor }
          nodes {
            occurredAt
            pullRequest {
              number title url state createdAt
              additions deletions changedFiles mergedAt
              repository { nameWithOwner }
            }
          }
        }
      }
    }
  }
`;

const ISSUE_QUERY = `
  query($login: String!, $from: DateTime!, $to: DateTime!, $after: String) {
    user(login: $login) {
      contributionsCollection(from: $from, to: $to) {
        issueContributions(first: 100, after: $after) {
          pageInfo { hasNextPage endCursor }
          nodes {
            occurredAt
            issue {
              number title url state createdAt
              repository { nameWithOwner }
            }
          }
        }
      }
    }
  }
`;

const REVIEW_QUERY = `
  query($login: String!, $from: DateTime!, $to: DateTime!, $after: String) {
    user(login: $login) {
      contributionsCollection(from: $from, to: $to) {
        pullRequestReviewContributions(first: 100, after: $after) {
          pageInfo { hasNextPage endCursor }
          nodes {
            occurredAt
            pullRequest {
              number title url
              repository { nameWithOwner }
            }
          }
        }
      }
    }
  }
`;

// ── Helpers ─────────────────────────────────────────────────────────────────

const ONE_YEAR_MS = 364 * 24 * 60 * 60 * 1000;

/** Split a date range into windows no larger than 364 days. */
export function splitIntoWindows(from: string, to: string): Array<{ from: string; to: string }> {
  const fromMs = new Date(from).getTime();
  const toMs = new Date(to).getTime();
  if (toMs - fromMs <= ONE_YEAR_MS) {
    return [{ from, to }];
  }

  const windows: Array<{ from: string; to: string }> = [];
  let cursorMs = toMs;

  while (cursorMs > fromMs) {
    const windowFromMs = Math.max(fromMs, cursorMs - ONE_YEAR_MS);
    windows.push({
      from: new Date(windowFromMs).toISOString(),
      to: new Date(cursorMs).toISOString(),
    });
    cursorMs = windowFromMs;
  }

  return windows;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function queryWithRetry<T>(
  gqlFn: typeof graphql,
  query: string,
  variables: Record<string, unknown>,
  maxRetries = 3,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return (await gqlFn(query, variables)) as T;
    } catch (err: unknown) {
      lastError = err;
      if (attempt < maxRetries && err instanceof Error && "status" in err) {
        const status = (err as Error & { status: number }).status;
        if (status === 403 || status === 502 || status === 503) {
          await sleep(1000 * 2 ** attempt);
          continue;
        }
      }
      throw err;
    }
  }
  throw lastError;
}

// ── Mapping functions ───────────────────────────────────────────────────────

function mapCommitsByRepo(
  repos: ContributionsCollection["commitContributionsByRepository"],
): EventEnvelope[] {
  const events: EventEnvelope[] = [];
  for (const repo of repos) {
    for (const contrib of repo.contributions.nodes) {
      events.push({
        kind: "commit",
        repo: repo.repository.nameWithOwner,
        ts: contrib.occurredAt,
        payload: {
          commitCount: contrib.commitCount,
        },
      });
    }
  }
  return events;
}

function mapPRs(
  nodes: Array<{ occurredAt: string; pullRequest: PullRequestNode }>,
): EventEnvelope[] {
  return nodes.map((n) => ({
    kind: "pr" as const,
    repo: n.pullRequest.repository.nameWithOwner,
    ts: n.pullRequest.createdAt,
    payload: {
      number: n.pullRequest.number,
      title: n.pullRequest.title,
      url: n.pullRequest.url,
      state: n.pullRequest.state,
      additions: n.pullRequest.additions,
      deletions: n.pullRequest.deletions,
      changedFiles: n.pullRequest.changedFiles,
      mergedAt: n.pullRequest.mergedAt,
    },
  }));
}

function mapIssues(nodes: Array<{ occurredAt: string; issue: IssueNode }>): EventEnvelope[] {
  return nodes.map((n) => ({
    kind: "issue" as const,
    repo: n.issue.repository.nameWithOwner,
    ts: n.issue.createdAt,
    payload: {
      number: n.issue.number,
      title: n.issue.title,
      url: n.issue.url,
      state: n.issue.state,
    },
  }));
}

function mapReviews(
  nodes: Array<{ occurredAt: string; pullRequest: ReviewNode }>,
): EventEnvelope[] {
  return nodes.map((n) => ({
    kind: "review" as const,
    repo: n.pullRequest.pullRequest.repository.nameWithOwner,
    ts: n.occurredAt,
    payload: {
      prNumber: n.pullRequest.pullRequest.number,
      prTitle: n.pullRequest.pullRequest.title,
      prUrl: n.pullRequest.pullRequest.url,
    },
  }));
}

// ── Main export ─────────────────────────────────────────────────────────────

/** Fetch commits, PRs, issues, reviews via GitHub GraphQL API. */
export async function collectViaGraphQL(options: CollectOptions): Promise<EventEnvelope[]> {
  const { login, token, since, to, ignoreRepos = [] } = options;
  const gqlFn = graphql.defaults({
    headers: { authorization: `token ${token}` },
  });

  const toTime = to ?? new Date().toISOString();
  const windows = splitIntoWindows(since, toTime);
  const allEvents: EventEnvelope[] = [];

  for (const window of windows) {
    const variables: Record<string, unknown> = {
      login,
      from: window.from,
      to: window.to,
      prAfter: null,
      issueAfter: null,
      reviewAfter: null,
    };

    // Initial fetch of all contribution types
    const initial = await queryWithRetry<GraphQLResponse>(gqlFn, CONTRIBUTIONS_QUERY, variables);
    const cc = initial.user?.contributionsCollection;
    if (!cc) continue;

    // Map initial results
    allEvents.push(...mapCommitsByRepo(cc.commitContributionsByRepository));
    allEvents.push(...mapPRs(cc.pullRequestContributions.nodes));
    allEvents.push(...mapIssues(cc.issueContributions.nodes));
    allEvents.push(...mapReviews(cc.pullRequestReviewContributions.nodes));

    // Paginate PRs
    let prCursor = cc.pullRequestContributions.pageInfo.endCursor;
    while (cc.pullRequestContributions.pageInfo.hasNextPage && prCursor) {
      const page = await queryWithRetry<GraphQLResponse>(gqlFn, PR_QUERY, {
        login,
        from: window.from,
        to: window.to,
        after: prCursor,
      });
      const prContribs = page.user?.contributionsCollection.pullRequestContributions;
      if (!prContribs) break;
      allEvents.push(...mapPRs(prContribs.nodes));
      prCursor = prContribs.pageInfo.endCursor;
      if (!prContribs.pageInfo.hasNextPage) break;
    }

    // Paginate Issues
    let issueCursor = cc.issueContributions.pageInfo.endCursor;
    while (cc.issueContributions.pageInfo.hasNextPage && issueCursor) {
      const page = await queryWithRetry<GraphQLResponse>(gqlFn, ISSUE_QUERY, {
        login,
        from: window.from,
        to: window.to,
        after: issueCursor,
      });
      const issueContribs = page.user?.contributionsCollection.issueContributions;
      if (!issueContribs) break;
      allEvents.push(...mapIssues(issueContribs.nodes));
      issueCursor = issueContribs.pageInfo.endCursor;
      if (!issueContribs.pageInfo.hasNextPage) break;
    }

    // Paginate Reviews
    let reviewCursor = cc.pullRequestReviewContributions.pageInfo.endCursor;
    while (cc.pullRequestReviewContributions.pageInfo.hasNextPage && reviewCursor) {
      const page = await queryWithRetry<GraphQLResponse>(gqlFn, REVIEW_QUERY, {
        login,
        from: window.from,
        to: window.to,
        after: reviewCursor,
      });
      const reviewContribs = page.user?.contributionsCollection.pullRequestReviewContributions;
      if (!reviewContribs) break;
      allEvents.push(...mapReviews(reviewContribs.nodes));
      reviewCursor = reviewContribs.pageInfo.endCursor;
      if (!reviewContribs.pageInfo.hasNextPage) break;
    }
  }

  // Filter ignored repos
  if (ignoreRepos.length > 0) {
    return allEvents.filter((e) => !ignoreRepos.includes(e.repo));
  }

  return allEvents;
}
