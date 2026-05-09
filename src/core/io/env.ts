import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

export interface LoadLocalEnvOptions {
  cwd?: string;
  files?: string[];
  override?: boolean;
}

export interface LoadedEnvFile {
  path: string;
  keys: string[];
}

const DEFAULT_ENV_FILES = [".env.local", ".env"];

/** Load simple KEY=value files for local development without adding a runtime dependency. */
export async function loadLocalEnv(options: LoadLocalEnvOptions = {}): Promise<LoadedEnvFile[]> {
  const cwd = options.cwd ?? process.cwd();
  const files = options.files ?? DEFAULT_ENV_FILES;
  const loaded: LoadedEnvFile[] = [];

  for (const file of files) {
    const path = resolve(cwd, file);
    let source: string;
    try {
      source = await readFile(path, "utf8");
    } catch {
      continue;
    }

    const keys: string[] = [];
    for (const [key, value] of parseEnv(source)) {
      if (options.override !== true && process.env[key] !== undefined) {
        continue;
      }
      process.env[key] = value;
      keys.push(key);
    }

    loaded.push({ path: file, keys });
  }

  return loaded;
}

function parseEnv(source: string): Array<[string, string]> {
  const entries: Array<[string, string]> = [];

  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) {
      continue;
    }

    const normalized = line.startsWith("export ") ? line.slice("export ".length).trim() : line;
    const equalsIndex = normalized.indexOf("=");
    if (equalsIndex <= 0) {
      continue;
    }

    const key = normalized.slice(0, equalsIndex).trim();
    const rawValue = normalized.slice(equalsIndex + 1).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      continue;
    }

    entries.push([key, stripQuotes(rawValue)]);
  }

  return entries;
}

function stripQuotes(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}
