import { type Options, defineConfig } from "tsup";

const common = {
  format: ["cjs"],
  outDir: "dist",
  target: "node20",
  noExternal: [/.*/], // bundle all dependencies into a single file (like ncc)
  splitting: false,
  minify: false,
  sourcemap: true,
  shims: true,
} satisfies Options;

const actionConfig = {
  ...common,
  entry: { index: "src/action.ts" }, // -> dist/index.js (GitHub Action entry)
  clean: true,
} satisfies Options;

const cliConfig = {
  ...common,
  entry: { cli: "src/cli.ts" }, // -> dist/cli.js (npm bin)
  clean: false,
  banner: { js: "#!/usr/bin/env node" },
} satisfies Options;

const target = process.env.DELTA_BUILD_TARGET;
const configs =
  target === "action" ? [actionConfig] : target === "cli" ? [cliConfig] : [actionConfig, cliConfig];

export default defineConfig(configs);
