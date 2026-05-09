#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

if (!existsSync(".git")) {
  console.log("SKIP  Git hooks not installed because this directory is not a Git repository.");
  process.exit(0);
}

const result = spawnSync("pnpm", ["exec", "simple-git-hooks"], {
  stdio: "inherit",
  shell: process.platform === "win32",
});

process.exit(result.status ?? 1);
