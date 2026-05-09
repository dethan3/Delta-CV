import { readFile } from "node:fs/promises";
import { Octokit } from "@octokit/rest";
import { writeCursor } from "./core/collector/cursor.ts";
import { collectChangedFiles, createErrorIssue, createOrUpdatePr } from "./core/github/pr.ts";
import { loadLocalEnv } from "./core/io/env.ts";
import { evolve, observe, tailor } from "./core/pipeline.ts";
import { ConfigSchema } from "./core/schema/config.ts";
import { VERSION } from "./version.ts";

/** Read a GitHub Actions input value from the environment. */
function getInput(name: string): string {
  return process.env[`INPUT_${name.toUpperCase().replace(/-/g, "_")}`] ?? "";
}

async function run(): Promise<void> {
  await loadLocalEnv();
  console.log(`delta-cv v${VERSION}`);

  const mode = getInput("mode") || "incremental";
  const since = getInput("since");
  const includePrivate = getInput("include-private") === "true";
  const dataDir = getInput("data-dir") || "data";
  const configPath = getInput("config-path") || "config.json";
  const githubToken = getInput("github-token") || process.env.GITHUB_TOKEN || "";

  if (!githubToken) {
    throw new Error(
      "github-token is required. Ensure the Action has GITHUB_TOKEN or pass a custom token.",
    );
  }

  // Load and parse config
  const configRaw = await readFile(configPath, "utf8");
  const config = ConfigSchema.parse(JSON.parse(configRaw));

  console.log(`[action] mode=${mode} login=${config.login} language=${config.language}`);

  // Bootstrap mode: override cursor to 3 years ago
  if (mode === "bootstrap") {
    const threeYearsAgo = new Date(Date.now() - 3 * 364 * 24 * 60 * 60 * 1000).toISOString();
    await writeCursor(dataDir, threeYearsAgo);
    console.log(`[action] bootstrap: cursor set to ${threeYearsAgo}`);
  } else if (since) {
    const sinceDate = new Date(since);
    if (!Number.isNaN(sinceDate.getTime())) {
      await writeCursor(dataDir, sinceDate.toISOString());
      console.log(`[action] cursor overridden to ${sinceDate.toISOString()}`);
    }
  }

  // Set GITHUB_TOKEN for collector modules
  process.env.GITHUB_TOKEN = githubToken;
  if (includePrivate) {
    // Collector checks this flag via config; set it in env for the observe step
    process.env.DELTA_INCLUDE_PRIVATE = "true";
  }

  // Run pipeline stages
  console.log("[action] stage 1/3: observe");
  const observeResult = await observe(config, dataDir);
  console.log(`[action] collected ${observeResult.eventsCollected} events`);

  console.log("[action] stage 2/3: evolve");
  const evolveResult = await evolve(config, dataDir);
  console.log(`[action] ${evolveResult.log.entries.length} experience entries`);

  console.log("[action] stage 3/3: tailor");
  const tailorResult = await tailor(config, dataDir);
  console.log(`[action] resume → ${tailorResult.outputPath}`);

  // Collect changed files for PR
  const repoRoot = process.env.GITHUB_WORKSPACE ?? process.cwd();
  const changedFiles = await collectChangedFiles(dataDir, repoRoot);

  // Also include the resume file
  try {
    const resumeContent = await readFile(tailorResult.outputPath, "utf8");
    const resumeRel = tailorResult.outputPath.startsWith(repoRoot)
      ? tailorResult.outputPath.slice(repoRoot.length + 1)
      : `data/tailored/${tailorResult.jdSlug}.md`;
    changedFiles.set(resumeRel, resumeContent);
  } catch {
    // Resume file might be in the dataDir already
  }

  // Build PR body
  const prBody = {
    summary: `Processed ${observeResult.eventsCollected} events → ${evolveResult.log.entries.length} experience entries → resume updated.`,
    newCapabilities: evolveResult.diff?.newCapabilities,
    risingTags: evolveResult.diff?.risingTags,
    decliningTags: evolveResult.diff?.decliningTags,
  };

  // Determine repo owner/name from GITHUB_REPOSITORY env var
  const [owner, repoName] = (process.env.GITHUB_REPOSITORY ?? "").split("/");
  if (!owner || !repoName) {
    throw new Error(
      "GITHUB_REPOSITORY not set. This action must run in a GitHub Actions workflow.",
    );
  }

  const octokit = new Octokit({ auth: githubToken });

  const prTitle =
    mode === "bootstrap"
      ? "chore: initial resume from Delta CV"
      : "chore: weekly resume update (Delta CV)";

  const prResult = await createOrUpdatePr(octokit, owner, repoName, changedFiles, prBody, prTitle);

  console.log(`[action] PR ${prResult.created ? "created" : "updated"}: ${prResult.url}`);
  console.log("[action] done");
}

run().catch(async (err: unknown) => {
  const error = err instanceof Error ? err : new Error(String(err));
  console.error("[action] fatal:", error.message);

  // Try to create an issue with the error details
  try {
    const githubToken = getInput("github-token") || process.env.GITHUB_TOKEN || "";
    const [owner, repoName] = (process.env.GITHUB_REPOSITORY ?? "").split("/");
    if (githubToken && owner && repoName) {
      const octokit = new Octokit({ auth: githubToken });
      const issueUrl = await createErrorIssue(octokit, owner, repoName, error);
      console.error(`[action] error issue: ${issueUrl}`);
    }
  } catch {
    // If we can't create an issue, just exit with the error
  }

  process.exit(1);
});
