import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { loadAsset } from "./io/assets.ts";

/**
 * Load a prompt template by name and language.
 * Checks for a user override at `<cwd>/prompts/<name>.<lang>.md` first,
 * then falls back to the built-in `assets/prompts/<name>.<lang>.md`.
 */
export async function loadPrompt(name: string, lang: "zh" | "en"): Promise<string> {
  const filename = `${name}.${lang}.md`;
  const userOverride = join(process.cwd(), "prompts", filename);
  try {
    return await readFile(userOverride, "utf8");
  } catch {
    // Fall back to bundled asset
  }
  return loadAsset(join("prompts", filename));
}
