import { Octokit } from "@octokit/rest";
import type { EventEnvelope } from "../schema/event.ts";

/** Fetch issues via REST search API (covers assigned/commented, not just created). */
export async function collectIssuesViaRest(
  login: string,
  token: string,
  since: string,
): Promise<EventEnvelope[]> {
  const octokit = new Octokit({ auth: token });

  const query = `involves:${login}+created:>${since}+type:issue`;
  const events: EventEnvelope[] = [];

  for await (const response of octokit.paginate.iterator(
    octokit.rest.search.issuesAndPullRequests,
    {
      q: query,
      sort: "created",
      order: "asc",
      per_page: 100,
    },
  )) {
    for (const issue of response.data) {
      // Skip pull requests (search API returns both)
      if ("pull_request" in issue) continue;

      // Extract repo from URL: https://api.github.com/repos/owner/repo/...
      const repoMatch = issue.repository_url.match(/repos\/([^/]+\/[^/]+)/);
      const repo = repoMatch?.[1] ?? "unknown";

      events.push({
        kind: "issue",
        repo,
        ts: issue.created_at,
        payload: {
          number: issue.number,
          title: issue.title,
          url: issue.html_url,
          state: issue.state,
          user: issue.user?.login ?? null,
        },
      });
    }
  }

  return events;
}
