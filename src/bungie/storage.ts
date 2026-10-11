import { chmod, mkdir, open, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

export async function privateDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
}

export async function writePrivateJson(filename: string, value: unknown): Promise<void> {
  await privateDirectory(path.dirname(filename));
  const temporary = `${filename}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(value), { flag: "wx", mode: 0o600 });
    await rename(temporary, filename);
  } finally {
    await unlink(temporary).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
  }
}

/** Serialize CLI and browser operations that share rotating refresh tokens or exports. */
export async function withLocalLock<T>(filename: string, action: () => Promise<T>, operation = "Bungie"): Promise<T> {
  await privateDirectory(path.dirname(filename));
  let handle;
  try { handle = await open(filename, "wx", 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(`Another ${operation} operation is in progress. Wait for it to finish and retry. If a process crashed, see the lock recovery instructions in README.md.`);
    }
    throw new Error(`Cannot create the local ${operation} operation lock. Check the data directory permissions.`);
  }
  try {
    await handle.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    return await action();
  } finally {
    await handle.close();
    await unlink(filename);
  }
}

export async function retainRawSnapshot(directory: string, raw: string): Promise<string> {
  await privateDirectory(directory);
  const timestamp = new Date().toISOString().replaceAll(":", "-");
  const filename = path.join(directory, `${timestamp}-${randomUUID()}-profile.json`);
  await writeFile(filename, raw, { flag: "wx", mode: 0o600 });
  return filename;
}
