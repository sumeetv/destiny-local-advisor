import { mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const MANIFEST_URL = "https://www.bungie.net/Platform/Destiny2/Manifest/";
const BUNGIE_ROOT = "https://www.bungie.net";

export interface ItemDefinition {
  hash: number;
  displayProperties?: { name?: string; description?: string };
  itemType?: number;
  itemTypeDisplayName?: string;
  classType?: number;
  inventory?: { bucketTypeHash?: number; tierType?: number; tierTypeName?: string };
  equippingBlock?: { ammoType?: number; equipmentSlotTypeHash?: number };
  defaultDamageType?: number;
  plug?: { plugCategoryIdentifier?: string };
  sockets?: { socketEntries?: unknown[] };
}

type ManifestIndex = Record<string, ItemDefinition>;

interface ManifestMetadata {
  Response?: {
    version?: string;
    jsonWorldComponentContentPaths?: {
      en?: { DestinyInventoryItemDefinition?: string };
    };
  };
}

async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url, { headers: { "User-Agent": "destiny-local-advisor/0.1" } });
  if (!response.ok) throw new Error(`Bungie request failed (${response.status} ${response.statusText}): ${url}`);
  return response.json();
}

export async function loadItemManifest(cacheDirectory: string, offline = false): Promise<{ definitions: ManifestIndex; version: string }> {
  if (offline) {
    let files: string[];
    try {
      files = (await readdir(cacheDirectory)).filter((name) => /^DestinyInventoryItemDefinition-.+\.json$/.test(name));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      files = [];
    }
    const candidates = await Promise.all(files.map(async (name) => ({ name, modified: (await stat(path.join(cacheDirectory, name))).mtimeMs })));
    const latest = candidates.sort((a, b) => b.modified - a.modified)[0];
    if (!latest) throw new Error("No cached manifest found. Run the import once without --offline to download Bungie's definitions.");
    return {
      definitions: JSON.parse(await readFile(path.join(cacheDirectory, latest.name), "utf8")) as ManifestIndex,
      version: latest.name.slice("DestinyInventoryItemDefinition-".length, -".json".length),
    };
  }
  const metadata = await fetchJson(MANIFEST_URL) as ManifestMetadata;
  const version = metadata.Response?.version;
  const definitionPath = metadata.Response?.jsonWorldComponentContentPaths?.en?.DestinyInventoryItemDefinition;
  if (!version || !definitionPath) throw new Error("Bungie manifest metadata did not include the English inventory item definitions");

  await mkdir(cacheDirectory, { recursive: true });
  const safeVersion = version.replace(/[^a-zA-Z0-9._-]/g, "_");
  const cachePath = path.join(cacheDirectory, `DestinyInventoryItemDefinition-${safeVersion}.json`);

  let contents: string;
  try {
    contents = await readFile(cachePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    process.stderr.write(`Downloading Bungie manifest ${version}...\n`);
    const response = await fetch(`${BUNGIE_ROOT}${definitionPath}`, { headers: { "User-Agent": "destiny-local-advisor/0.1" } });
    if (!response.ok) throw new Error(`Bungie manifest download failed (${response.status} ${response.statusText})`);
    contents = await response.text();
    const temporaryPath = `${cachePath}.${process.pid}.tmp`;
    await writeFile(temporaryPath, contents);
    await rename(temporaryPath, cachePath);
  }

  return { definitions: JSON.parse(contents) as ManifestIndex, version };
}
