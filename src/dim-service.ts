import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { applyDimMetadata, dimCleanupCsv, importDimMetadata, loadDimStore } from "./dim.js";
import { withLocalLock } from "./bungie/storage.js";
import { loadAnalysisSnapshot } from "./analysis/snapshot.js";
import { loadBuildConfig } from "./analysis/build-config.js";
import { loadWeaponRatings } from "./analysis/weapon-config.js";
import { loadCleanupConfig } from "./analysis/cleanup-config.js";
import { analyzeBuilds } from "./analysis/builds.js";
import { analyzeWeapons } from "./analysis/weapons.js";
import { analyzeCleanup } from "./analysis/cleanup.js";
import type { InventorySnapshot } from "./inventory.js";

export interface AnalysisPaths { builds?: string; preferences?: string; perkRatings?: string; cleanupConfig?: string; acquisitionConfig?: string }
export const withInventoryLock = <T>(directory: string, action: () => Promise<T>) => withLocalLock(path.join(directory, "inventory.lock"), action, "inventory");

export async function readInventoryWithMetadata(directory: string): Promise<InventorySnapshot> {
  const snapshot = await loadAnalysisSnapshot(path.join(directory, "inventory.json"), true);
  return applyDimMetadata(snapshot, await loadDimStore(directory));
}

export async function currentCleanup(directory: string, paths: AnalysisPaths = {}) {
  const snapshot = await readInventoryWithMetadata(directory);
  const config = await loadBuildConfig(paths.builds, paths.preferences);
  const weapons = analyzeWeapons(snapshot, await loadWeaponRatings(paths.perkRatings));
  const builds = analyzeBuilds(snapshot, config.templates, config.preferences, config, weapons);
  const cleanup = analyzeCleanup(snapshot, weapons, builds, await loadCleanupConfig(paths.cleanupConfig));
  // Content digest also detects tag, lock, stat, config and rating changes with unchanged timestamps.
  const revision = createHash("sha256").update(JSON.stringify({ snapshot, cleanup, builds })).digest("hex");
  return { snapshot, cleanup, weapons, builds, revision };
}

export async function importDimFile(directory: string, filename: string) {
  const text = await readFile(filename, "utf8");
  return withInventoryLock(directory, async () => importDimMetadata(directory, await readInventoryWithMetadata(directory), text));
}

export async function exportDimSelection(directory: string, selectedIds: string[], paths: AnalysisPaths = {}, revision?: string) {
  return withInventoryLock(directory, async () => {
    const current = await currentCleanup(directory, paths);
    if (revision !== undefined && revision !== current.revision) throw new Error("Inventory, DIM metadata or analysis settings changed. Reload cleanup and select again.");
    return dimCleanupCsv(current.snapshot, current.cleanup, selectedIds);
  });
}
