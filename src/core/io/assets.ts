import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

let _assetsDir: string | undefined;

/** Locate the assets/ directory by walking up from __dirname. Works in both tsx (src/) and tsup bundle (dist/). */
function getAssetsDir(): string {
  if (_assetsDir) return _assetsDir;
  let dir = __dirname;
  for (let i = 0; i < 8; i++) {
    const candidate = join(dir, "assets");
    if (existsSync(candidate)) {
      _assetsDir = candidate;
      return candidate;
    }
    const parent = resolve(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`Cannot locate assets/ directory (searched from ${__dirname})`);
}

/** Load a text asset from the assets/ directory. */
export async function loadAsset(relativePath: string): Promise<string> {
  const fullPath = join(getAssetsDir(), relativePath);
  return readFile(fullPath, "utf8");
}

/** Load a banned-words list for the given language. Checks user override first. */
export async function loadBannedWords(lang: "zh" | "en"): Promise<string[]> {
  const relPath = `prompts/banned_words.${lang}.txt`;
  // User override: <cwd>/prompts/banned_words.<lang>.txt
  const userPath = join(process.cwd(), relPath);
  let raw: string;
  if (existsSync(userPath)) {
    raw = await readFile(userPath, "utf8");
  } else {
    raw = await loadAsset(relPath);
  }
  return raw
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"));
}
