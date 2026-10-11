import { readFile } from "node:fs/promises";
import path from "node:path";
import type { InventorySnapshot } from "../inventory.js";
import { normalizeInventory } from "../inventory.js";
import { loadItemManifest } from "../manifest.js";
import { parseProfile } from "../profile.js";

/** Shared CLI analysis entry point; core analysis sees normalized data only. */
export async function loadAnalysisSnapshot(filename: string, offline = false): Promise<InventorySnapshot> {
  const raw = JSON.parse(await readFile(filename, "utf8")) as unknown;
  if (raw && typeof raw === "object" && "schemaVersion" in raw && "items" in raw) {
    const snapshot = raw as InventorySnapshot;
    if (snapshot.schemaVersion !== 1 || !Array.isArray(snapshot.items) || !Array.isArray(snapshot.characters) || typeof snapshot.manifestVersion !== "string") throw new Error("Invalid normalized inventory snapshot.");
    return snapshot;
  }
  const profile = parseProfile(raw);
  const manifest = await loadItemManifest(path.resolve("data/manifest"), offline);
  return normalizeInventory(profile, manifest.definitions, manifest.version);
}
