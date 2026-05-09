#!/usr/bin/env node
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const root = resolve(__dirname, "..");
const requiredBundles = ["dist/index.js", "dist/cli.js"];

let failed = false;
for (const bundle of requiredBundles) {
  if (existsSync(resolve(root, bundle))) {
    console.log(`OK    ${bundle} exists`);
  } else {
    console.error(`ERROR: ${bundle} not found. Run pnpm build first.`);
    failed = true;
  }
}

if (failed) {
  process.exit(1);
}
