#!/usr/bin/env node
/**
 * Verify that template/.github/workflows/delta.yml references a `uses` tag that
 * matches (or is compatible with) the current package.json major version.
 *
 * Acceptable patterns:
 *   uses: delta-cv/delta@v0          ← major-only pin (recommended during 0.x)
 *   uses: delta-cv/delta@v0.3.1      ← exact pin
 *
 * This script warns (exit 0) when the project is still at 0.0.0 (pre-release),
 * and errors (exit 1) once the major version is released and the template pin
 * is stale.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const root = resolve(__dirname, "..");

const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const version = pkg.version;
const [major] = version.split(".");

const workflowPath = resolve(root, "template/.github/workflows/delta.yml");
const workflow = readFileSync(workflowPath, "utf8");

const usesMatch = workflow.match(/uses:\s*delta-cv\/delta@(v[\w.]+)/);
if (!usesMatch) {
  console.error(
    "ERROR: template/.github/workflows/delta.yml has no 'uses: delta-cv/delta@...' line.",
  );
  process.exit(1);
}

const pin = usesMatch[1];
const pinMajor = pin.replace(/^v/, "").split(".")[0];

if (version === "0.0.0") {
  console.log(`SKIP  Pre-release (${version}) — template pin '${pin}' not validated.`);
  process.exit(0);
}

if (pinMajor !== major) {
  console.error(
    `ERROR: template pin '${pin}' major (${pinMajor}) does not match package.json major (${major}).`,
  );
  process.exit(1);
}

console.log(`OK    template pin '${pin}' matches package.json v${version}`);
