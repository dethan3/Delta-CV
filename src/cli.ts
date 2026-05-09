import { readFile } from "node:fs/promises";
import { defineCommand, runMain } from "citty";
import { writeCursor } from "./core/collector/cursor.ts";
import { initRepo } from "./core/init.ts";
import { loadBannedWords } from "./core/io/assets.ts";
import { loadLocalEnv } from "./core/io/env.ts";
import { checkBannedWords } from "./core/lint/banned-words.ts";
import { checkHighlightLimits, checkLineLength } from "./core/lint/line-length.ts";
import { evolve, observe, tailor } from "./core/pipeline.ts";
import { ConfigSchema } from "./core/schema/config.ts";
import { VERSION } from "./version.ts";

const observeCmd = defineCommand({
  meta: {
    name: "observe",
    description: "Collect GitHub events and write to data/events/.",
  },
  args: {
    since: {
      type: "string",
      description: "ISO-8601 start date override (e.g. 2025-01-01)",
    },
    "data-dir": {
      type: "string",
      description: "Path to the data directory",
      default: "data",
    },
    "config-path": {
      type: "string",
      description: "Path to config.json",
      default: "config.json",
    },
  },
  async run({ args }) {
    await loadLocalEnv();

    const configRaw = await readFile(args["config-path"], "utf8");
    const config = ConfigSchema.parse(JSON.parse(configRaw));

    // If --since is provided, override the cursor before running
    if (args.since) {
      const sinceDate = new Date(args.since);
      if (Number.isNaN(sinceDate.getTime())) {
        console.error(`Invalid --since date: ${args.since}`);
        process.exit(1);
      }
      await writeCursor(args["data-dir"], sinceDate.toISOString());
      console.log(`[observe] cursor overridden to ${sinceDate.toISOString()}`);
    }

    const result = await observe(config, args["data-dir"]);
    console.log(`[observe] collected ${result.eventsCollected} events → ${result.dataDir}/events/`);
  },
});

const evolveCmd = defineCommand({
  meta: {
    name: "evolve",
    description: "Process collected events into experience log + snapshot via LLM.",
  },
  args: {
    "data-dir": {
      type: "string",
      description: "Path to the data directory",
      default: "data",
    },
    "config-path": {
      type: "string",
      description: "Path to config.json",
      default: "config.json",
    },
    since: {
      type: "string",
      description: "Only process events at or after this ISO date (default: all collected events)",
      default: "",
    },
  },
  async run({ args }) {
    await loadLocalEnv();

    let config: ReturnType<typeof ConfigSchema.parse>;
    try {
      const configRaw = await readFile(args["config-path"], "utf8");
      config = ConfigSchema.parse(JSON.parse(configRaw));
    } catch (err) {
      const hint = err instanceof Error ? err.message : String(err);
      console.error(`[evolve] Failed to load config from "${args["config-path"]}": ${hint}`);
      process.exit(1);
    }

    const since = args.since || undefined;
    const result = await evolve(config, args["data-dir"], since);
    const entryCount = result.log.entries.length;
    console.log(`[evolve] done — ${entryCount} experience entr${entryCount === 1 ? "y" : "ies"}`);

    if (result.diff) {
      const { newCapabilities, risingTags, decliningTags } = result.diff;
      if (newCapabilities.length)
        console.log(`[evolve] new capabilities: ${newCapabilities.join(", ")}`);
      if (risingTags.length) console.log(`[evolve] rising: ${risingTags.join(", ")}`);
      if (decliningTags.length) console.log(`[evolve] declining: ${decliningTags.join(", ")}`);
    }
  },
});

const tailorCmd = defineCommand({
  meta: {
    name: "tailor",
    description: "Generate a tailored resume, optionally ranked against a job description.",
  },
  args: {
    jd: {
      type: "string",
      description: "Path to a job description text file for relevance ranking",
    },
    "data-dir": {
      type: "string",
      description: "Path to the data directory",
      default: "data",
    },
    "config-path": {
      type: "string",
      description: "Path to config.json",
      default: "config.json",
    },
  },
  async run({ args }) {
    await loadLocalEnv();

    let config: ReturnType<typeof ConfigSchema.parse>;
    try {
      const configRaw = await readFile(args["config-path"], "utf8");
      config = ConfigSchema.parse(JSON.parse(configRaw));
    } catch (err) {
      const hint = err instanceof Error ? err.message : String(err);
      console.error(`[tailor] Failed to load config from "${args["config-path"]}": ${hint}`);
      process.exit(1);
    }

    let jdText: string | undefined;
    if (args.jd) {
      try {
        jdText = await readFile(args.jd, "utf8");
      } catch (err) {
        const hint = err instanceof Error ? err.message : String(err);
        console.error(`[tailor] Failed to read JD file "${args.jd}": ${hint}`);
        process.exit(1);
      }
    }

    const result = await tailor(config, args["data-dir"], jdText);
    console.log(`[tailor] resume written to ${result.outputPath}`);
  },
});

const lintCmd = defineCommand({
  meta: {
    name: "lint",
    description: "Check a resume Markdown file for banned words and structural limits.",
  },
  args: {
    file: {
      type: "string",
      description: "Path to the resume Markdown file to lint",
      required: true,
    },
    lang: {
      type: "string",
      description: "Language for banned words list (zh or en)",
      default: "zh",
    },
  },
  async run({ args }) {
    const markdown = await readFile(args.file, "utf8");
    const lang = args.lang as "zh" | "en";

    const bannedWords = await loadBannedWords(lang);
    const wordViolations = checkBannedWords(markdown, bannedWords);
    const lineViolations = checkLineLength(markdown);
    const structuralViolations = checkHighlightLimits(markdown);

    let hasErrors = false;

    if (wordViolations.length > 0) {
      hasErrors = true;
      console.error(`[lint] ${wordViolations.length} banned word(s) found:`);
      for (const v of wordViolations) {
        console.error(`  line ${v.line}:${v.col} — "${v.word}"`);
      }
    }

    if (lineViolations.length > 0) {
      hasErrors = true;
      console.error(`[lint] ${lineViolations.length} line(s) exceed 120 chars:`);
      for (const v of lineViolations) {
        console.error(`  line ${v.line}:${v.col} — "${v.word}…"`);
      }
    }

    if (structuralViolations.length > 0) {
      hasErrors = true;
      console.error(`[lint] ${structuralViolations.length} structural violation(s):`);
      for (const v of structuralViolations) {
        console.error(`  [${v.section}] ${v.issue}`);
      }
    }

    if (hasErrors) {
      console.error("[lint] FAILED");
      process.exit(1);
    }
    console.log("[lint] PASSED — no violations");
  },
});

const initCmd = defineCommand({
  meta: {
    name: "init",
    description: "Scaffold a new resume repository from the Delta CV template.",
  },
  args: {
    dir: {
      type: "string",
      description: "Target directory (default: current directory)",
      default: ".",
    },
  },
  async run({ args }) {
    const result = await initRepo(args.dir);
    console.log(`[init] scaffolded ${result.files.length} files in ${result.dir}`);
    console.log();
    console.log("Next steps:");
    console.log(`  1. cd ${args.dir === "." ? "." : args.dir}`);
    console.log("  2. Edit config.json — set your GitHub login and LLM provider");
    console.log("  3. Copy .env.local.example to .env.local and fill GITHUB_TOKEN + LLM_API_KEY");
    console.log("  4. Run locally from the Delta source checkout:");
    console.log("       node /path/to/delta/dist/cli.js observe --since 2026-01-01");
    console.log("       node /path/to/delta/dist/cli.js evolve --since 2026-01-01");
    console.log("       node /path/to/delta/dist/cli.js tailor");
    console.log(
      "       node /path/to/delta/dist/cli.js lint --file data/tailored/default.md --lang zh",
    );
    console.log("  5. Optional later: create a private GitHub repo and push this resume repo");
  },
});

const main = defineCommand({
  meta: {
    name: "delta",
    version: VERSION,
    description: "Track your real engineering capabilities through GitHub activity.",
  },
  subCommands: {
    observe: observeCmd,
    evolve: evolveCmd,
    tailor: tailorCmd,
    lint: lintCmd,
    init: initCmd,
  },
});

runMain(main);
