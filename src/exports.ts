import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { InventorySnapshot, OwnedItem } from "./inventory.js";
import { applyDimMetadata, loadDimStore } from "./dim.js";
import { withLocalLock } from "./bungie/storage.js";

const headers = ["Instance ID", "Item hash", "Name", "Type", "Tier", "Class", "Slot", "Location", "Equipped", "Locked", "Power", "Quantity", "Ammo", "Damage", "Masterworked", "Crafted", "Enhanced", "Selected perks", "Available perks", "Stats by hash"];

export function csvCell(value: string | number | boolean | null): string {
  // Prevent spreadsheet formula execution; quoting alone does not neutralize it.
  let text = value === null ? "" : String(value);
  if (typeof value === "string" && /^[\s]*[=+@-]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function inventoryCsv(items: OwnedItem[]): string {
  const rows = items.map((item) => [
    item.instanceId, item.itemHash, item.name, item.typeName, item.tier, item.classType, item.slot,
    item.locationLabel, item.equipped, item.locked, item.power, item.quantity, item.ammoType, item.damageType,
    item.masterworked, item.crafted, item.enhanced,
    item.selectedPerks.map((perk) => perk.name).join(" | "), item.availablePerks.map((perk) => perk.name).join(" | "),
    item.stats === null ? null : JSON.stringify(item.stats),
  ]);
  return [headers, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

export async function writeInventoryExports(snapshot: InventorySnapshot, directory: string): Promise<void> {
  return withLocalLock(path.join(directory, "inventory.lock"), async () => {
    snapshot = applyDimMetadata(snapshot, await loadDimStore(directory));
    await mkdir(directory, { recursive: true });
    const historyDirectory = path.join(directory, "snapshot-history");
    await mkdir(historyDirectory, { recursive: true, mode: 0o700 });
    let previous: string | null = null;
    try {
      const prior = JSON.parse(await readFile(path.join(directory, "inventory.json"), "utf8")) as InventorySnapshot;
      if (prior.schemaVersion !== 1 || !Array.isArray(prior.items)) throw new Error("Invalid previous inventory; history was not replaced.");
      // Archive the actual prior export, including migrations from pre-history installations.
      previous = `${randomUUID()}.json`;
      await writeFile(path.join(historyDirectory, previous), JSON.stringify(prior), { flag: "wx", mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const current = `${randomUUID()}.json`;
    snapshot = { ...snapshot, history: { current, previous } };
    await writeFile(path.join(historyDirectory, current), JSON.stringify(snapshot), { flag: "wx", mode: 0o600 });
    const files = [
      ["weapons.csv", inventoryCsv(snapshot.items.filter((item) => item.type === "weapon"))],
      ["armor.csv", inventoryCsv(snapshot.items.filter((item) => item.type === "armor"))],
      // The inventory and its history references become visible in one final atomic rename.
      ["inventory.json", JSON.stringify(snapshot, null, 2) + "\n"],
    ] as const;
    for (const [filename, content] of files) {
      const target = path.join(directory, filename);
      const temporary = `${target}.${process.pid}.tmp`;
      await writeFile(temporary, content, "utf8");
      await rename(temporary, target);
    }
  }, "inventory");
}
