import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

interface CursorData {
  lastSyncedAt: string;
}

/** Read the last-seen event cursor from data/_meta/cursor.json. */
export async function readCursor(dataDir: string): Promise<string | null> {
  const cursorPath = join(dataDir, "_meta", "cursor.json");
  try {
    const raw = await readFile(cursorPath, "utf8");
    const parsed = JSON.parse(raw) as CursorData;
    if (typeof parsed.lastSyncedAt === "string" && !Number.isNaN(Date.parse(parsed.lastSyncedAt))) {
      return parsed.lastSyncedAt;
    }
    return null;
  } catch (err: unknown) {
    if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw err;
  }
}

/** Write the cursor to data/_meta/cursor.json using atomic rename. */
export async function writeCursor(dataDir: string, cursor: string): Promise<void> {
  const metaDir = join(dataDir, "_meta");
  await mkdir(metaDir, { recursive: true });

  const cursorPath = join(metaDir, "cursor.json");
  const tmpPath = `${cursorPath}.tmp`;
  const data: CursorData = { lastSyncedAt: cursor };

  await writeFile(tmpPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  await rename(tmpPath, cursorPath);
}
