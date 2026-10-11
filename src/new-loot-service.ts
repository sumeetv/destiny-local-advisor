import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { currentCleanup, withInventoryLock, type AnalysisPaths } from "./dim-service.js";
import { loadAnalysisSnapshot } from "./analysis/snapshot.js";
import { applyDimMetadata, loadDimStore } from "./dim.js";
import { loadBuildConfig } from "./analysis/build-config.js";
import { loadWeaponRatings } from "./analysis/weapon-config.js";
import { analyzeWeapons } from "./analysis/weapons.js";
import { analyzeBuilds } from "./analysis/builds.js";
import { analyzeNewLoot, formatNewLoot, type NewLootAnalysis } from "./analysis/new-loot.js";

export async function currentNewLoot(directory: string, paths: AnalysisPaths = {}): Promise<NewLootAnalysis> {
  return withInventoryLock(directory, async () => {
    const { snapshot, cleanup, weapons, builds } = await currentCleanup(directory, paths);
    let previous = null;
    const history = snapshot.history, validReference = (value: unknown) => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$/.test(value);
    if (history !== undefined && (!history || !validReference(history.current) || (history.previous !== null && !validReference(history.previous)))) {
      throw new Error("Invalid local snapshot history reference.");
    }
    if (history?.previous) {
      const reference = history.previous;
      // Missing/corrupt history is an explicit error, never an invented empty baseline.
      previous = applyDimMetadata(await loadAnalysisSnapshot(path.join(directory, "snapshot-history", reference), true), await loadDimStore(directory));
    }
    const config = await loadBuildConfig(paths.builds, paths.preferences), ratings = await loadWeaponRatings(paths.perkRatings);
    const priorWeapons = previous ? analyzeWeapons(previous, ratings) : null;
    const priorBuilds = previous ? analyzeBuilds(previous, config.templates, config.preferences, config, priorWeapons!) : null;
    return analyzeNewLoot(previous, snapshot, weapons, priorWeapons, cleanup, builds, priorBuilds);
  });
}

export async function writeNewLoot(analysis: NewLootAnalysis, directory: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  for (const [name, content] of [["new-loot.json", JSON.stringify(analysis, null, 2) + "\n"], ["new-loot.txt", formatNewLoot(analysis)]] as const) {
    const filename = path.join(directory, name), temporary = `${filename}.${randomUUID()}.tmp`;
    await writeFile(temporary, content, { flag: "wx", mode: 0o600 });
    await rename(temporary, filename);
  }
}
