import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

let _templateDir: string | undefined;

/** Locate the template/ directory by walking up from __dirname. */
function getTemplateDir(): string {
  if (_templateDir) return _templateDir;
  let dir = __dirname;
  for (let i = 0; i < 8; i++) {
    const candidate = join(dir, "template");
    if (existsSync(join(candidate, "config.json"))) {
      _templateDir = candidate;
      return candidate;
    }
    const parent = resolve(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`Cannot locate template/ directory (searched from ${__dirname})`);
}

export interface InitResult {
  dir: string;
  files: string[];
}

/**
 * Scaffold a new resume repository from the template.
 * Copies template/ contents to targetDir, runs git init, and creates an initial commit.
 */
export async function initRepo(targetDir: string): Promise<InitResult> {
  const templateDir = getTemplateDir();
  const absTarget = resolve(targetDir);

  if (existsSync(absTarget)) {
    const entries = await readdir(absTarget);
    const nonGitEntries = entries.filter((e) => e !== ".git");
    if (nonGitEntries.length > 0) {
      throw new Error(
        `Directory "${targetDir}" already exists and is not empty. Remove it first or choose a different name.`,
      );
    }
  }

  await mkdir(absTarget, { recursive: true });

  // Copy template contents recursively
  const copiedFiles: string[] = [];
  async function copyDir(src: string, dest: string): Promise<void> {
    const entries = await readdir(src, { withFileTypes: true });
    for (const entry of entries) {
      const srcPath = join(src, entry.name);
      const destPath = join(dest, entry.name);
      if (entry.isDirectory()) {
        await mkdir(destPath, { recursive: true });
        await copyDir(srcPath, destPath);
      } else {
        const content = await readFile(srcPath);
        await writeFile(destPath, content);
        copiedFiles.push(destPath);
      }
    }
  }

  await copyDir(templateDir, absTarget);

  // git init + initial commit
  if (!existsSync(join(absTarget, ".git"))) {
    execSync("git init", { cwd: absTarget, stdio: "pipe" });
    execSync("git add -A", { cwd: absTarget, stdio: "pipe" });
    execSync('git commit -m "chore: initial scaffold from delta-cv/delta"', {
      cwd: absTarget,
      stdio: "pipe",
    });
  }

  return { dir: absTarget, files: copiedFiles };
}
