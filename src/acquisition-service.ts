import { mkdir, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { readInventoryWithMetadata, withInventoryLock, type AnalysisPaths } from "./dim-service.js";
import { loadBuildConfig } from "./analysis/build-config.js";
import { analyzeBuilds } from "./analysis/builds.js";
import { analyzeAcquisition, formatAcquisition, type AcquisitionAnalysis } from "./analysis/acquisition.js";
import { loadAcquisitionConfig } from "./analysis/acquisition-config.js";

export async function currentAcquisition(directory: string, paths: AnalysisPaths = {}): Promise<AcquisitionAnalysis> {
  return withInventoryLock(directory, async () => {
    const snapshot = await readInventoryWithMetadata(directory), config = await loadBuildConfig(paths.builds, paths.preferences);
    const builds = analyzeBuilds(snapshot, config.templates, config.preferences, config);
    return analyzeAcquisition(snapshot, config.templates, config.preferences, await loadAcquisitionConfig(paths.acquisitionConfig), builds);
  });
}
export async function writeAcquisition(analysis: AcquisitionAnalysis, directory: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  for (const [name, content] of [["upgrades.json", JSON.stringify(analysis, null, 2) + "\n"], ["upgrades.txt", formatAcquisition(analysis)]] as const) {
    const filename = path.join(directory, name), temporary = `${filename}.${randomUUID()}.tmp`;
    await writeFile(temporary, content, { flag: "wx", mode: 0o600 });
    await rename(temporary, filename);
  }
}
