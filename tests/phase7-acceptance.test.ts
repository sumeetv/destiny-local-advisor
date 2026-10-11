import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import type { InventorySnapshot, OwnedItem } from "../src/inventory.js";
import { applyDimMetadata, dimCleanupCsv, importDimMetadata, loadDimStore, parseCsv, parseDimCsv } from "../src/dim.js";
import { currentCleanup, exportDimSelection, importDimFile, readInventoryWithMetadata, withInventoryLock } from "../src/dim-service.js";
import { writeInventoryExports } from "../src/exports.js";
import { defaultCleanupConfig } from "../src/analysis/cleanup-config.js";
import { createInventoryServer } from "../src/server.js";

const ids = ["6917529999999999991", "6917529999999999992", "6917529999999999993"];
function armor(id: string, value: number): OwnedItem {
  return { id, instanceId: id, itemHash: 831, name: "Round Trip Armor", description: "", known: true, type: "armor", typeName: "Chest Armor",
    classType: "Titan", characterId: null, location: "vault", locationLabel: "Vault", equipped: false, locked: false, masterworked: false,
    crafted: false, enhanced: false, exotic: false, quantity: 1, slot: "Chest", ammoType: null, damageType: null,
    power: value > 10 ? 2001 : 2000, tier: "Legendary", stats: Object.fromEntries(defaultCleanupConfig.armorStatHashes.map((axis) => [axis, value])),
    sockets: [], selectedPerks: [], availablePerks: [], sourceStatus: "common", armorStatsExact: true,
    armorSet: null, armorSetBonus: null, gearTier: "Tier 3", currentSetBonusNeeded: false };
}
function account(): InventorySnapshot {
  return { schemaVersion: 1, importedAt: "2026-10-07T00:00:00Z", profileTimestamp: "2026-10-07T00:00:00Z", manifestVersion: "round-trip",
    characters: [], unknownHashes: [], items: [armor(ids[0]!, 20), armor(ids[1]!, 10), armor(ids[2]!, 10)] };
}
async function local<T>(action: (directory: string) => Promise<T>) {
  const directory = await mkdtemp(path.join(tmpdir(), "destiny-phase7-"));
  try { await writeInventoryExports(account(), directory); return await action(directory); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

describe("Phase 7 DIM round trip", () => {
  it("reads actual DIM quoted ID cells, BOM, extra/reordered columns and exact multiline notes", () => {
    const csv = '\uFEFFNotes,Future,Hash,Tag,Id\r\n"line 1, \"\"quoted\"\"\r\nline 2",extra,831,keep,"""6917529999999999992"""\r\n';
    expect(parseDimCsv(csv)).toEqual([{ id: ids[1], itemHash: 831, tag: "Keep", notes: 'line 1, "quoted"\r\nline 2' }]);
    expect(parseDimCsv(`Id,Hash,Notes\n${ids[1]},831,note`)[0]).not.toHaveProperty("tag");
    expect(parseDimCsv(`Id,Hash,Tag,Notes\n${ids[1]},831,Keep`)[0]).not.toHaveProperty("notes");
  });

  it.each([
    "Name,Tag\nHelmet,Keep", "Id,Hash\n1,831", "Id,Id,Hash,Tag\n1,1,831,Keep", "Id,Hash,Tag\n6.91753E+18,831,Keep",
    "Id,Hash,Tag\n18446744073709551616,831,Keep", "Id,Hash,Tag\n1,4294967296,Keep", "Id,Hash,Tag\n1,831,unknown",
    'Id,Hash,Notes\n1,831,"unterminated', 'Id,Hash,Notes\n1,831,"note"bad', "Id,Hash,Tag\n1,831,Keep\n1,831,Junk",
  ])("rejects unsafe/ambiguous CSV before mutation: %s", (csv) => { expect(() => parseDimCsv(csv)).toThrow(); });

  it.each(["Favorite", "Keep", "Archive"])("preserves %s across metadata imports, missing columns, refresh and restart", async (tag) => local(async (directory) => {
    const first = `Id,Hash,Tag,Notes\n${ids[1]},831,${tag},original note`;
    await withInventoryLock(directory, () => importDimMetadata(directory, account(), first));
    const file = path.join(directory, "dim.csv");
    await writeFile(file, `Id,Hash,Tag\n${ids[1]},831,Junk`);
    expect(await importDimFile(directory, file)).toMatchObject({ matched: 1, preserved: 1, skipped: [] });
    await writeInventoryExports(account(), directory); // A fresh Bungie/manual snapshot has no DIM fields.
    const current = await readInventoryWithMetadata(directory);
    expect(current.items[1]!.dim).toEqual({ tag, notes: "original note" });
    expect(JSON.parse(await readFile(path.join(directory, "inventory.json"), "utf8")).items[1].dim).toEqual({ tag, notes: "original note" });
    const result = await currentCleanup(directory);
    expect(result.cleanup.items.find((item) => item.itemId === ids[1])!.classification).toBe("PROTECTED");
    await expect(exportDimSelection(directory, [ids[1]!])).rejects.toThrow("eligible");
  }));

  it("joins only unique instance ID AND hash; reports unmatched rows without touching other copies", async () => local(async (directory) => {
    const result = await importDimMetadata(directory, account(), `Id,Hash,Tag\n${ids[1]},999,Keep\n999,831,Favorite\n${ids[2]},831,Archive`);
    expect(result).toMatchObject({ matched: 1, skipped: [ids[1], "999"] });
    const snapshot = applyDimMetadata(account(), await loadDimStore(directory));
    expect(snapshot.items[1]!.dim).toBeUndefined(); expect(snapshot.items[2]!.dim?.tag).toBe("Archive");
    const duplicate = account(); duplicate.items.push({ ...duplicate.items[1]! });
    expect((await importDimMetadata(directory, duplicate, `Id,Hash,Tag\n${ids[1]},831,Keep`)).skipped).toEqual([ids[1]]);
    const otherHash = account(); otherHash.items[2]!.itemHash = 999;
    expect(applyDimMetadata(otherHash, await loadDimStore(directory)).items[2]!.dim).toBeUndefined();
  }));

  it("exports only explicit candidates, preserves notes and long IDs, and never writes Junk into account state", async () => local(async (directory) => {
    const note = '=literal, "quotes"\nsecond line';
    await importDimMetadata(directory, account(), `Id,Hash,Tag,Notes\r\n${ids[1]},831,,"${note.replaceAll('"', '""')}"\r\n`);
    const current = await currentCleanup(directory);
    expect(current.cleanup.counts.DISMANTLE_CANDIDATE).toBe(2);
    await expect(exportDimSelection(directory, [])).rejects.toThrow("Explicitly select");
    const csv = await exportDimSelection(directory, [ids[1]!, ids[1]!], {}, current.revision);
    const rows = parseCsv(csv);
    expect(rows[0]).toEqual(["Id", "Hash", "Tag", "Notes"]); expect(rows).toHaveLength(2);
    expect(rows[1]!.slice(0, 3)).toEqual([ids[1], "831", "Junk"]);
    expect(rows[1]![3]).toContain(note + "\nDestiny Advisor:"); expect(rows[1]![3]).toContain(ids[0]!);
    expect(parseDimCsv(csv)[0]!.id).toBe(ids[1]);
    expect((await readInventoryWithMetadata(directory)).items[1]!.dim).toEqual({ tag: "", notes: note });
    await expect(exportDimSelection(directory, [ids[0]!])).rejects.toThrow("eligible");
    await expect(exportDimSelection(directory, [ids[1]!, "unknown"])).rejects.toThrow("eligible");
    expect(() => dimCleanupCsv({ ...current.snapshot, manifestVersion: "new" }, current.cleanup, [ids[1]!])).toThrow("stale");
  }));

  it("requires positive Tag and Notes evidence before Junk export, allowing partial imports to be combined", async () => local(async (directory) => {
    await expect(exportDimSelection(directory, [ids[1]!])).rejects.toThrow("Import DIM Tag and Notes");
    await importDimMetadata(directory, account(), `Id,Hash,Notes\n${ids[1]},831,known note`);
    await expect(exportDimSelection(directory, [ids[1]!])).rejects.toThrow("Import DIM Tag and Notes");
    await importDimMetadata(directory, account(), `Id,Hash,Tag\n${ids[1]},831,`);
    const csv = await exportDimSelection(directory, [ids[1]!]);
    expect(parseCsv(csv)[1]![3]).toContain("known note");
    await importDimMetadata(directory, account(), `Id,Hash,Tag\n${ids[2]},831,Infuse`);
    await expect(exportDimSelection(directory, [ids[2]!])).rejects.toThrow("Import DIM Tag and Notes");
  }));

  it("invalidates prior selections after same-timestamp tag, lock and config changes", async () => local(async (directory) => {
    const prior = await currentCleanup(directory);
    await importDimMetadata(directory, account(), `Id,Hash,Tag\n${ids[1]},831,Favorite`);
    await expect(exportDimSelection(directory, [ids[1]!], {}, prior.revision)).rejects.toThrow("changed");
    const beforeLock = await currentCleanup(directory), refreshed = account(); refreshed.items[2]!.locked = true;
    await writeInventoryExports(refreshed, directory);
    await expect(exportDimSelection(directory, [ids[2]!], {}, beforeLock.revision)).rejects.toThrow("changed");
    await expect(exportDimSelection(directory, [ids[2]!])).rejects.toThrow("eligible");
    const beforeConfig = await currentCleanup(directory), config = path.join(directory, "cleanup.yaml");
    await writeFile(config, JSON.stringify({ threshold: 100 }));
    await expect(exportDimSelection(directory, [ids[1]!], { cleanupConfig: config }, beforeConfig.revision)).rejects.toThrow("changed");
  }));

  it("preserves prior metadata on malformed input/store and refuses concurrent inventory writers", async () => local(async (directory) => {
    await importDimMetadata(directory, account(), `Id,Hash,Tag\n${ids[1]},831,Keep`);
    const before = await readFile(path.join(directory, "dim-metadata.json"), "utf8");
    await expect(importDimMetadata(directory, account(), `Id,Hash,Tag\n${ids[1]},831,Junk\n${ids[2]},831,bogus`)).rejects.toThrow();
    expect(await readFile(path.join(directory, "dim-metadata.json"), "utf8")).toBe(before);
    await withInventoryLock(directory, async () => { await expect(writeInventoryExports(account(), directory)).rejects.toThrow("in progress"); });
    await writeFile(path.join(directory, "dim-metadata.json"), "bad json");
    await expect(exportDimSelection(directory, [ids[1]!])).rejects.toThrow();
    const inventoryBefore = await readFile(path.join(directory, "inventory.json"), "utf8");
    await expect(writeInventoryExports(account(), directory)).rejects.toThrow();
    expect(await readFile(path.join(directory, "inventory.json"), "utf8")).toBe(inventoryBefore);
  }));

  it("verifies CLI import and explicit export, with no export created on failed selection", async () => local(async (directory) => {
    const run = promisify(execFile), input = path.join(directory, "dim.csv");
    await writeFile(input, `Id,Hash,Tag,Notes\n${ids[1]},831,,CLI note`);
    const cli = (args: string[]) => run(process.execPath, ["--import", "tsx", "src/cli.ts", ...args, "--output", directory]);
    expect((await cli(["dim:import", input])).stdout).toContain("1 matched");
    await expect(cli(["dim:export"])).rejects.toThrow();
    await expect(readFile(path.join(directory, "dim-cleanup.csv"))).rejects.toThrow();
    await cli(["dim:export", "--select", ids[1]!]);
    const csv = await readFile(path.join(directory, "dim-cleanup.csv"), "utf8");
    expect(parseCsv(csv)[1]![0]).toBe(ids[1]); expect(parseCsv(csv)[1]![3]).toContain("CLI note");
    await expect(cli(["dim:export", "--select", ids[0]!])).rejects.toThrow();
    expect(await readFile(path.join(directory, "dim-cleanup.csv"), "utf8")).toBe(csv);
  }), 15000);

  it("serves candidate review and guards metadata/export POSTs against cross-origin and stale selections", async () => local(async (directory) => {
    const server = createInventoryServer(directory);
    try {
      await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const post = (route: string, data: unknown, headers = { Origin: base, "X-Local-Request": "1", "Content-Type": "application/json" }) => fetch(`${base}${route}`, { method: "POST", headers, body: JSON.stringify(data) });
      for (const asset of ["cleanup", "cleanup.js", "cleanup.css"]) expect((await fetch(`${base}/${asset}`)).status).toBe(200);
      expect((await post("/api/dim/import", { csv: `Id,Hash,Tag,Notes\n${ids[1]},831,,\n${ids[2]},831,,` })).status).toBe(200);
      const review = await (await fetch(`${base}/api/cleanup`)).json();
      expect(review.counts.DISMANTLE_CANDIDATE).toBe(2);
      expect((await post("/api/dim/import", { csv: "" }, { Origin: "https://other.example", "X-Local-Request": "1", "Content-Type": "application/json" })).status).toBe(403);
      expect((await post("/api/dim/export", { selectedIds: [ids[1]], revision: review.revision }, { Origin: base, "X-Local-Request": "", "Content-Type": "application/json" })).status).toBe(403);
      expect((await fetch(`${base}/api/dim/export`)).status).toBe(405);
      expect((await post("/api/dim/export", { selectedIds: [], revision: review.revision })).status).toBe(400);
      expect((await post("/api/dim/export", { selectedIds: [ids[1]] })).status).toBe(400);
      const download = await post("/api/dim/export", { selectedIds: [ids[1]], revision: review.revision });
      expect(download.status).toBe(200); expect(download.headers.get("content-disposition")).toContain("dim-cleanup.csv");
      expect(parseCsv(await download.text())[1]!.slice(0, 3)).toEqual([ids[1], "831", "Junk"]);
      expect((await post("/api/dim/import", { csv: `Id,Hash,Tag,Notes\n${ids[1]},831,Keep,my note` })).status).toBe(200);
      expect((await post("/api/dim/export", { selectedIds: [ids[1]], revision: review.revision })).status).toBe(400);
      const downloaded = await (await fetch(`${base}/downloads/inventory.json`)).json();
      expect(downloaded.items[1].dim).toEqual({ tag: "Keep", notes: "my note" });
      expect((await fetch(`${base}/downloads/dim-cleanup.csv`)).status).toBe(404);
      expect((await fetch(`${base}/dim-metadata.json`)).status).toBe(404);
    } finally {
      server.closeAllConnections();
      if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }));
});
