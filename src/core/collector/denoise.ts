import type { EventEnvelope } from "../schema/event.ts";

/** Filter out bot commits, merge commits, and ignored repos. */
export function denoiseEvents(
  events: EventEnvelope[],
  ignoreAuthors: string[],
  ignoreRepos: string[],
): EventEnvelope[] {
  return events.filter((event) => {
    if (ignoreRepos.includes(event.repo)) {
      return false;
    }

    const author = String(event.payload.author ?? event.payload.user ?? "");
    if (ignoreAuthors.some((bot) => author.includes(bot))) {
      return false;
    }

    if (event.kind === "commit") {
      const msg = String(event.payload.message ?? "");
      if (msg.startsWith("Merge pull request") || msg.startsWith("Merge branch")) {
        return false;
      }
    }

    return true;
  });
}
