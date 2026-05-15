import { readFile } from "node:fs/promises";
import { defineCommand, runMain } from "citty";
import { writeCursor } from "./core/collector/cursor.ts";
import { initRepo } from "./core/init.ts";
import { loadBannedWords } from "./core/io/assets.ts";
import { loadLocalEnv } from "./core/io/env.ts";
import { checkBannedWords } from "./core/lint/banned-words.ts";
import { checkHighlightLimits, checkLineLength } from "./core/lint/line-length.ts";
import { cleanRevisions, compose, critique, curate, evolve, observe, render, revise, tailor } from "./core/pipeline.ts";
import { HTML_STYLES, HTML_STYLE_NAMES } from "./core/render/styles.ts";
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

const composeCmd = defineCommand({
  meta: {
    name: "compose",
    description: "Generate a polished resume draft via LLM from curated project data.",
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
    format: {
      type: "string",
      description: "Output format: html, md, or both (default: both)",
      default: "both",
    },
    lang: {
      type: "string",
      description: "Output language: zh or en (overrides config)",
    },
    role: {
      type: "string",
      description: "Target role hint, e.g. 'AI 工程师' or 'Full-Stack Engineer'",
    },
    "top-n": {
      type: "string",
      description: "Number of top projects to include (default: 6)",
      default: "6",
    },
    jd: {
      type: "string",
      description: "Path to a job description file for targeted resume",
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
      console.error(`[compose] Failed to load config from "${args["config-path"]}": ${hint}`);
      process.exit(1);
    }

    const format = args.format as "html" | "md" | "both";
    if (!["html", "md", "both"].includes(format)) {
      console.error(`[compose] --format must be one of: html, md, both`);
      process.exit(1);
    }

    const topN = Number.parseInt(args["top-n"], 10);
    if (Number.isNaN(topN) || topN < 1) {
      console.error("[compose] --top-n must be a positive integer");
      process.exit(1);
    }

    let slug = "default";
    let targetRole: string | undefined;
    if (args.role) targetRole = args.role;

    let jdText: string | undefined;
    if (args.jd) {
      try {
        jdText = await readFile(args.jd, "utf8");
        const firstLine = jdText.trim().split("\n")[0] ?? "jd";
        slug = firstLine
          .toLowerCase()
          .replace(/[^\w\s-]/g, "")
          .replace(/\s+/g, "-")
          .slice(0, 40);
        if (!targetRole) targetRole = firstLine.slice(0, 80);
      } catch (err) {
        const hint = err instanceof Error ? err.message : String(err);
        console.error(`[compose] Failed to read JD file "${args.jd}": ${hint}`);
        process.exit(1);
      }
    }

    const langOverride = args.lang as "zh" | "en" | undefined;
    const effectiveLang: "zh" | "en" =
      langOverride === "zh" || langOverride === "en"
        ? langOverride
        : config.language === "bilingual"
          ? "zh"
          : config.language;

    console.log(`[compose] running — lang: ${effectiveLang}, format: ${format}, top-n: ${topN}`);
    if (targetRole) console.log(`[compose] target role: ${targetRole}`);

    const result = await compose(config, args["data-dir"], {
      lang: effectiveLang,
      format,
      slug,
      topN,
      ...(targetRole ? { targetRole } : {}),
    });

    console.log(`[compose] draft → ${result.draftPath}`);
    if (result.htmlPath) console.log(`[compose] HTML  → ${result.htmlPath}`);
    if (result.mdPath) console.log(`[compose] MD    → ${result.mdPath}`);
    console.log(`\nHeadline: ${result.draft.headline}`);
  },
});

const critiqueCmd = defineCommand({
  meta: {
    name: "critique",
    description: "Critique an existing resume draft and report issues with improvement suggestions.",
  },
  args: {
    "data-dir": { type: "string", description: "Path to the data directory", default: "data" },
    "config-path": { type: "string", description: "Path to config.json", default: "config.json" },
    slug: {
      type: "string",
      description: "Resume draft slug to critique (default: default)",
      default: "default",
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
      console.error(`[critique] Failed to load config: ${hint}`);
      process.exit(1);
    }

    const result = await critique(config, args["data-dir"], args.slug);
    const { critique: cr } = result;

    console.log(`\n[critique] Overall score: ${cr.overallScore}/10`);
    console.log(`[critique] ${cr.summary}\n`);

    if (cr.issues.length > 0) {
      console.log("Issues:");
      for (const issue of cr.issues) {
        const icon = issue.severity === "error" ? "✗" : issue.severity === "warning" ? "⚠" : "ℹ";
        const loc = issue.location ? ` [${issue.location}]` : "";
        console.log(`  ${icon} [${issue.category}]${loc} ${issue.description}`);
        console.log(`    → ${issue.suggestion}`);
      }
    }

    if (cr.passedChecks.length > 0) {
      console.log("\nPassed checks:");
      for (const check of cr.passedChecks) {
        console.log(`  ✓ ${check}`);
      }
    }

    console.log(`\n[critique] saved → ${result.critiquePath}`);
  },
});

const reviseCmd = defineCommand({
  meta: {
    name: "revise",
    description: "Revise a resume draft with a natural-language instruction.",
  },
  args: {
    "data-dir": { type: "string", description: "Path to the data directory", default: "data" },
    "config-path": { type: "string", description: "Path to config.json", default: "config.json" },
    slug: {
      type: "string",
      description: "Source draft slug (default: default)",
      default: "default",
    },
    instruction: {
      type: "string",
      description: "Revision instruction, e.g. '更偏 AI 工程师' or 'compress to one page'",
      required: true,
    },
    format: {
      type: "string",
      description: "Output format: html, md, or both (default: both)",
      default: "both",
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
      console.error(`[revise] Failed to load config: ${hint}`);
      process.exit(1);
    }

    const format = args.format as "html" | "md" | "both";
    if (!["html", "md", "both"].includes(format)) {
      console.error(`[revise] --format must be one of: html, md, both`);
      process.exit(1);
    }

    console.log(`[revise] instruction: "${args.instruction}"`);
    const result = await revise(config, args["data-dir"], args.instruction, {
      slug: args.slug,
      format,
    });

    console.log(`[revise] new draft  → ${result.draftPath}`);
    if (result.htmlPath) console.log(`[revise] HTML       → ${result.htmlPath}`);
    if (result.mdPath) console.log(`[revise] MD         → ${result.mdPath}`);
    console.log(`\nNew headline: ${result.record.draft.headline}`);
  },
});

const renderCmd = defineCommand({
  meta: {
    name: "render",
    description: "Render an existing resume draft to HTML and/or Markdown with a chosen style.",
  },
  args: {
    "data-dir": { type: "string", description: "Path to the data directory", default: "data" },
    "config-path": { type: "string", description: "Path to config.json", default: "config.json" },
    slug: {
      type: "string",
      description: "Resume draft slug to render (default: default)",
      default: "default",
    },
    style: {
      type: "string",
      description: `HTML style: ${HTML_STYLE_NAMES.join(", ")} (default: clean)`,
      default: "clean",
    },
    format: {
      type: "string",
      description: "Output format: html, md, or both (default: html)",
      default: "html",
    },
    instruction: {
      type: "string",
      description: "Design instruction for --style agent. E.g. '深色极简风格，适合 AI 工程师'",
    },
  },
  async run({ args }) {
    const format = args.format as "html" | "md" | "both";
    if (!["html", "md", "both"].includes(format)) {
      console.error(`[render] --format must be one of: html, md, both`);
      process.exit(1);
    }

    let config: ReturnType<typeof ConfigSchema.parse> | undefined;
    if (args.style === "agent") {
      await loadLocalEnv();
      try {
        const configRaw = await readFile(args["config-path"], "utf8");
        config = ConfigSchema.parse(JSON.parse(configRaw));
      } catch (err) {
        const hint = err instanceof Error ? err.message : String(err);
        console.error(`[render] Failed to load config: ${hint}`);
        process.exit(1);
      }
      if (!args.instruction) {
        console.error(`[render] --style agent requires --instruction`);
        process.exit(1);
      }
    }

    const result = await render(args["data-dir"], {
      slug: args.slug,
      style: args.style,
      format,
      ...(args.instruction ? { instruction: args.instruction } : {}),
      ...(config ? { config } : {}),
    });

    if (result.htmlPath) console.log(`[render] HTML → ${result.htmlPath}`);
    if (result.mdPath) console.log(`[render] MD   → ${result.mdPath}`);
    if (result.validationWarnings?.length) {
      console.log(`\n[render] validation notices:`);
      for (const w of result.validationWarnings) {
        console.log(`  ⚠ ${w}`);
      }
    }
  },
});

const stylesCmd = defineCommand({
  meta: {
    name: "styles",
    description: "List available HTML resume styles.",
  },
  args: {},
  async run() {
    console.log("\nAvailable HTML styles:\n");
    for (const name of HTML_STYLE_NAMES) {
      const meta = HTML_STYLES[name];
      console.log(`  ${name.padEnd(12)} ${meta.description}`);
    }
    console.log(`\nUsage: delta render --style <name>`);
  },
});

const curateCmd = defineCommand({
  meta: {
    name: "curate",
    description:
      "Analyse experience log: merge projects, score importance, extract capability claims.",
  },
  args: {
    "data-dir": {
      type: "string",
      description: "Path to the data directory",
      default: "data",
    },
    "top-n": {
      type: "string",
      description: "Maximum number of top projects to highlight (default: 6)",
      default: "6",
    },
  },
  async run({ args }) {
    const topN = Number.parseInt(args["top-n"], 10);
    if (Number.isNaN(topN) || topN < 1) {
      console.error("[curate] --top-n must be a positive integer");
      process.exit(1);
    }

    const result = await curate(args["data-dir"], topN);
    const top = result.projects.slice(0, topN);

    console.log(`\nTop ${topN} projects:`);
    for (const p of top) {
      console.log(`  [${p.importance.toFixed(3)}] ${p.repo}  (${p.category}, ${p.activeMonths}mo)`);
    }

    const usable = result.claims.filter((c) => c.resumeUse);
    console.log(`\nCapability claims (resume-use):`);
    for (const c of usable) {
      console.log(`  ${c.claim}  [conf: ${c.confidence.toFixed(2)}]  — ${c.technologies.slice(0, 5).join(", ")}`);
    }

    console.log(`\n[curate] written to ${args["data-dir"]}/agent/`);
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
      type: "positional",
      description: "Target directory (default: current directory)",
      default: ".",
      required: false,
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

const cleanCmd = defineCommand({
  meta: {
    name: "clean",
    description: "Remove intermediate revision files for a given base slug.",
  },
  args: {
    slug: {
      type: "string",
      description: "Base resume slug to clean revisions for (e.g. 'default')",
      default: "default",
    },
    keep: {
      type: "string",
      description: "Revision slug to keep (e.g. 'default-rev-3'); others are deleted",
    },
    "data-dir": {
      type: "string",
      description: "Data directory",
      default: "data",
    },
    "dry-run": {
      type: "boolean",
      description: "Print what would be deleted without actually deleting",
      default: false,
    },
  },
  async run({ args }) {
    const dataDir = args["data-dir"];
    const dryRun = args["dry-run"];
    const result = await cleanRevisions(dataDir, {
      slug: args.slug,
      keep: args.keep,
      dryRun,
    });
    if (result.deleted.length === 0 && result.kept.length === 0) {
      console.log(`[clean] no revision files found for slug "${args.slug}"`);
      return;
    }
    if (dryRun) {
      console.log(`[clean] dry-run — would delete ${result.deleted.length} file(s):`);
    } else {
      console.log(`[clean] deleted ${result.deleted.length} file(s):`);
    }
    for (const f of result.deleted) console.log(`  - ${f}`);
    if (result.kept.length > 0) {
      console.log(`[clean] kept ${result.kept.length} file(s):`);
      for (const f of result.kept) console.log(`  + ${f}`);
    }
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
    curate: curateCmd,
    compose: composeCmd,
    critique: critiqueCmd,
    revise: reviseCmd,
    render: renderCmd,
    styles: stylesCmd,
    tailor: tailorCmd,
    lint: lintCmd,
    init: initCmd,
    clean: cleanCmd,
  },
});

runMain(main);
