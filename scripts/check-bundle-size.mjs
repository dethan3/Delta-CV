#!/usr/bin/env node
import { statSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const root = resolve(__dirname, "..");
const MAX_BYTES = 5 * 1024 * 1024; // 5 MB

const bundles = ["dist/index.js", "dist/cli.js"];
let failed = false;

for (const bundle of bundles) {
  const abs = resolve(root, bundle);
  let size;
  try {
    size = statSync(abs).size;
  } catch {
    console.error(`ERROR: ${bundle} not found. Run pnpm build first.`);
    failed = true;
    continue;
  }
  const mb = (size / 1024 / 1024).toFixed(2);
  if (size > MAX_BYTES) {
    console.error(`ERROR: ${bundle} is ${mb} MB — exceeds 5 MB limit.`);
    failed = true;
  } else {
    console.log(`OK    ${bundle} — ${mb} MB`);
  }
}

if (failed) process.exit(1);
