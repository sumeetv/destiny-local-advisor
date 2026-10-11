import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import type { InventorySnapshot, OwnedItem, OwnedPerk } from "../src/inventory.js";
import { loadBuildConfig } from "../src/analysis/build-config.js";
import { analyzeBuilds } from "../src/analysis/builds.js";
import { defaultCleanupConfig } from "../src/analysis/cleanup-config.js";
import { analyzeCleanup } from "../src/analysis/cleanup.js";
import { analyzeNewLoot, formatNewLoot } from "../src/analysis/new-loot.js";
import { loadWeaponRatings } from "../src/analysis/weapon-config.js";
import { analyzeWeapons } from "../src/analysis/weapons.js";
import { importDimMetadata } from "../src/dim.js";
import { exportDimSelection, withInventoryLock } from "../src/dim-service.js";
import { writeInventoryExports } from "../src/exports.js";
import { currentNewLoot } from "../src/new-loot-service.js";
import { createInventoryServer } from "../src/server.js";

const config = await loadBuildConfig(), ratings = await loadWeaponRatings();
const ids = ["6917529999999999991", "6917529999999999992", "6917529999999999993"];
function armor(id: string, value = 10, overrides: Partial<OwnedItem> = {}): OwnedItem {
  return { id, instanceId: id, itemHash: 831, name: "Session Armor", description: "", known: true,
    type: "armor", typeName: "Chest Armor", classType: "Titan", characterId: null, location: "vault", locationLabel: "Vault",
    equipped: false, locked: false, masterworked: false, crafted: false, enhanced: false, exotic: false, quantity: 1,
    slot: "Chest", ammoType: null, damageType: null, power: value > 10 ? 2001 : 2000, tier: "Legendary",
    stats: Object.fromEntries(defaultCleanupConfig.armorStatHashes.map((axis) => [axis, value])), sockets: [], selectedPerks: [], availablePerks: [],
    sourceStatus: "common", armorStatsExact: true, armorSet: null, armorSetBonus: null, gearTier: "Tier 3", currentSetBonusNeeded: false, ...overrides };
}
function weapon(id: string, names: string[], overrides: Partial<OwnedItem> = {}): OwnedItem {
  const selected = names.map((name, index): OwnedPerk => ({ hash: 100 + index, name, description: "", known: true, category: "traits", enabled: true, canInsert: null }));
  return armor(id, 10, { itemHash: 42, name: "Session Rifle", type: "weapon", typeName: "Auto Rifle", classType: null,
    slot: "Energy", ammoType: "Primary", damageType: "Arc", selectedPerks: selected,
    sockets: selected.map((perk, index) => ({ index, visible: true, selected: perk, available: [] })), ...overrides });
}
function snapshot(items: OwnedItem[], time = "2026-10-08T20:00:00Z"): InventorySnapshot {
  return { schemaVersion: 1, importedAt: time, profileTimestamp: time, manifestVersion: "session-manifest", inventoryCoverage: "complete",
    characters: [{ id: "titan", classType: "Titan" }], unknownHashes: [], items };
}
function compare(previous: InventorySnapshot | null, current: InventorySnapshot) {
  const weapons = analyzeWeapons(current, ratings), builds = analyzeBuilds(current, config.templates, config.preferences, config, weapons);
  const priorWeapons = previous ? analyzeWeapons(previous, ratings) : null;
  const priorBuilds = previous ? analyzeBuilds(previous, config.templates, config.preferences, config, priorWeapons!) : null;
  return analyzeNewLoot(previous, current, weapons, priorWeapons, analyzeCleanup(current, weapons, builds), builds, priorBuilds);
}
async function local<T>(action: (directory: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(path.join(tmpdir(), "destiny-phase8-"));
  try { return await action(directory); }
  finally { await rm(directory, { recursive: true, force: true }); }
}
const readInventory = async (directory: string): Promise<InventorySnapshot> => JSON.parse(await readFile(path.join(directory, "inventory.json"), "utf8"));

describe("Phase 8 consecutive-session loot", () => {
  it("establishes a baseline instead of declaring the entire existing account newly acquired", () => {
    const result = compare(null, snapshot([armor(ids[0]!), weapon(ids[1]!, ["Voltshot"])]));
    expect(result.status).toBe("BASELINE");
    expect(result.counts.acquired).toBe(0); expect(result.currentlyAbsent).toEqual([]);
    expect(result.vault).toEqual({ previous: null, current: 2 });
    expect(formatNewLoot(result)).toContain("First successful snapshot establishes a baseline");
  });

  it("shows what appeared, componentwise armor improvement, preserved gear and probably redundant copies with reasons", () => {
    const previous = snapshot([armor(ids[0]!)]), current = snapshot([armor(ids[0]!), armor(ids[1]!, 20), armor(ids[2]!)], "2026-10-09T20:00:00Z");
    const result = compare(previous, current);
    expect(result.status).toBe("COMPARED");
    expect(result.counts).toMatchObject({ acquired: 2, keep: 1, improved: 1, probablyRedundant: 1, review: 0 });
    const upgrade = result.acquired.find((i) => i.itemId === ids[1])!, redundant = result.acquired.find((i) => i.itemId === ids[2])!;
    expect(upgrade.recommendation).toBe("PROTECTED");
    expect(upgrade.improvements).toEqual([expect.objectContaining({ role: "exact armor stat distribution", previousBest: null, currentScore: null,
      comparedItemIds: [ids[0]], provisional: false, evidence: expect.arrayContaining([expect.stringContaining("stat")]) })]);
    expect(redundant.recommendation).toBe("REVIEW_FOR_DISMANTLE"); expect(redundant.reasons.length).toBeGreaterThan(0);
    expect(redundant.betterOwnedAlternatives.map((i) => i.itemId)).toEqual([ids[1]]);
    expect(formatNewLoot(result)).toContain("REVIEW_FOR_DISMANTLE — Session Armor");
    expect(result.provenance).toMatchObject({ currentManifestVersion: "session-manifest", previousManifestVersion: "session-manifest",
      weaponRatingsVersion: expect.stringMatching(/^[0-9a-f]{64}$/), buildDefinitionVersion: config.buildDefinitionVersion,
      preferenceVersion: config.preferenceVersion, cleanupConfigVersion: expect.stringMatching(/^[0-9a-f]{64}$/) });
  });

  it("ignores transfers, equipment/lock/perk changes, stack quantities and generated noninstance IDs", () => {
    const old = weapon(ids[0]!, ["Demolitionist"]), stack = armor("generated-stack", 10, { instanceId: null, quantity: 3 });
    const prior = snapshot([old, stack]), current = snapshot([weapon(ids[0]!, ["Voltshot"], { location: "titan", locationLabel: "Titan", characterId: "titan", equipped: true, locked: true }),
      { ...stack, id: "generated-other", quantity: 50 }, armor("other-generated", 10, { instanceId: null })]);
    const result = compare(prior, current);
    expect(result.counts.acquired).toBe(0); expect(result.currentlyAbsent).toEqual([]);
  });

  it("excludes duplicate and conflicting instance identities from both acquisition and absence claims", () => {
    const prior = snapshot([armor(ids[0]!), armor(ids[1]!), armor(ids[1]!)]);
    const current = snapshot([armor(ids[0]!, 10, { itemHash: 999 }), armor(ids[2]!), armor(ids[2]!)]);
    const result = compare(prior, current);
    expect(result.acquired).toEqual([]); expect(result.currentlyAbsent).toEqual([]);
    expect(result.limitations).toContain("3 duplicate or conflicting instance identities excluded from comparison.");
  });

  it("shows newly seen unresolved instanced items with explicit unknown evidence while retaining hard protection", () => {
    const unknown = armor(ids[1]!, 10, { known: false, type: "other", name: "Unknown item #999", itemHash: 999, stats: null, power: null, slot: null, sourceStatus: "unknown" });
    const result = compare(snapshot([]), snapshot([unknown]));
    expect(result.counts.acquired).toBe(1);
    expect(result.acquired[0]!.unknowns).toContain("Unresolved item definition");
    expect(["PROTECTED", "REVIEW"]).toContain(result.acquired[0]!.recommendation);
    expect(result.acquired[0]!.improvements).toEqual([]);
  });

  it("reports absence with unknown cause and never invents dismantling", () => {
    const result = compare(snapshot([armor(ids[0]!)]), snapshot([]));
    expect(result.currentlyAbsent.map((i) => i.itemId)).toEqual([ids[0]]);
    expect(formatNewLoot(result)).toContain(`Currently absent: Session Armor [${ids[0]}] · cause unknown`);
  });

  it("gates different accounts, unconfirmed identity, partial inventories and backwards/invalid timestamps", () => {
    const prior = snapshot([armor(ids[0]!)]), current = snapshot([armor(ids[1]!)]);
    const source = { kind: "bungie" as const, rawSnapshot: "one.json", membershipId: "123", membershipType: 3 };
    for (const [before, after] of [
      [{ ...prior, source }, { ...current, source: { ...source, membershipId: "456" } }],
      [{ ...prior, source }, { ...current, source: { ...source, membershipType: 1 } }],
      [prior, { ...current, characters: [{ id: "someone-else", classType: "Titan" }] }],
      [{ ...prior, characters: [] }, { ...current, characters: [] }],
      [{ ...prior, inventoryCoverage: "partial" as const }, current],
      [prior, { ...current, inventoryCoverage: "partial" as const }],
      [prior, { ...current, profileTimestamp: "2026-10-07T20:00:00Z" }],
      [prior, { ...current, profileTimestamp: "invalid" }],
    ]) {
      const result = compare(before!, after!);
      expect(result.status).toBe("INCOMPARABLE"); expect(result.acquired).toEqual([]); expect(result.currentlyAbsent).toEqual([]); expect(result.improvedBuilds).toEqual([]);
    }
    // Matching Bungie membership survives character roster changes; IDs remain strings.
    expect(compare({ ...prior, source }, { ...current, source, characters: [] }).status).toBe("COMPARED");
  });

  it("reports contextual draft weapon role gains over every previous exact-family copy without global superiority", () => {
    const prior = snapshot([weapon(ids[0]!, ["Demolitionist"])]);
    const current = snapshot([...prior.items, weapon(ids[1]!, ["Demolitionist", "Voltshot"])]);
    const result = compare(prior, current), improvements = result.acquired[0]!.improvements;
    expect(improvements.length).toBeGreaterThan(0);
    expect(improvements.every((i) => i.provisional && i.comparedItemIds.join() === ids[0] && i.currentScore! > i.previousBest!)).toBe(true);
    expect(formatNewLoot(result)).toContain("(provisional)");
    const betterPrior = snapshot([...prior.items, weapon(ids[2]!, ["Demolitionist", "Voltshot"])]);
    expect(compare(betterPrior, snapshot([...betterPrior.items, current.items[1]!])).acquired[0]!.improvements).toEqual([]);
    const missing = snapshot([weapon(ids[0]!, ["Demolitionist"], { stats: null })]);
    expect(compare(missing, current).acquired[0]!.improvements).toEqual([]);
    expect(compare(prior, snapshot([...prior.items, weapon(ids[1]!, ["Demolitionist", "Voltshot"], { itemHash: 999 })])).acquired[0]!.improvements).toEqual([]);
  });

  it("never labels armor tradeoffs, unverified exact stats or different sockets as improvements", () => {
    const prior = snapshot([armor(ids[0]!)]);
    const tradeoff = armor(ids[1]!, 20); tradeoff.stats![defaultCleanupConfig.armorStatHashes[0]!] = 5;
    const plug: OwnedPerk = { hash: 7, name: "Unmodeled stat mod", description: "", known: true, enabled: true, canInsert: null, category: "armor mods" };
    for (const item of [tradeoff, armor(ids[1]!, 20, { armorStatsExact: false }), armor(ids[1]!, 20, { sockets: [{ index: 0, visible: true, selected: plug, available: [] }] })]) {
      expect(compare(prior, snapshot([...prior.items, item])).acquired[0]!.improvements).toEqual([]);
    }
  });

  it("shows affected builds becoming ready from new required gear with positive ability evidence", () => {
    const prior = snapshot([]);
    prior.subclassCapabilities = [{ characterId: "titan", classType: "Titan", subclass: "Arc", abilities: ["Touch of Thunder"], evidence: "owned-subclass-sockets" }];
    const current = { ...prior, items: [armor(ids[0]!, 10, { exotic: true, name: "Heart of Inmost Light", tier: "Exotic" })] };
    const result = compare(prior, current);
    expect(result.improvedBuilds).toContainEqual(expect.objectContaining({ id: "titan-arc-grenade-hoil", newlyReady: true }));
    expect(result.acquired[0]!.buildsAffected).toContain("titan-arc-grenade-hoil");
    expect(result.acquired[0]!.recommendation).toBe("PROTECTED");
  });

  it("retains immutable consecutive history across service restarts and reanalysis; third ingestion advances once", async () => local(async (directory) => {
    await writeInventoryExports(snapshot([armor(ids[0]!)]), directory);
    expect((await currentNewLoot(directory)).status).toBe("BASELINE");
    const first = await readInventory(directory), firstBytes = await readFile(path.join(directory, "snapshot-history", first.history!.current), "utf8");
    await writeInventoryExports(snapshot([armor(ids[0]!), armor(ids[1]!, 20)], "2026-10-09T20:00:00Z"), directory);
    const second = await readInventory(directory), before = await readFile(path.join(directory, "inventory.json"), "utf8");
    const result = await currentNewLoot(directory);
    expect(result.counts.acquired).toBe(1); expect(result.acquired[0]!.itemId).toBe(ids[1]);
    expect(await currentNewLoot(directory)).toEqual(result);
    expect(await readFile(path.join(directory, "inventory.json"), "utf8")).toBe(before);
    expect(await readFile(path.join(directory, "snapshot-history", first.history!.current), "utf8")).toBe(firstBytes);
    expect(result.provenance.currentSnapshotId).toBe(second.history!.current);
    await writeInventoryExports(snapshot([...second.items, armor(ids[2]!)], "2026-10-10T20:00:00Z"), directory);
    expect((await currentNewLoot(directory)).acquired.map((i) => i.itemId)).toEqual([ids[2]]);
    expect((await readdir(path.join(directory, "snapshot-history"))).length).toBe(5);
  }));

  it("preserves the committed inventory and history when ingestion fails or is concurrent", async () => local(async (directory) => {
    await writeInventoryExports(snapshot([armor(ids[0]!)]), directory);
    await writeInventoryExports(snapshot([armor(ids[0]!), armor(ids[1]!, 20)]), directory);
    const before = await readFile(path.join(directory, "inventory.json"), "utf8"), files = await readdir(path.join(directory, "snapshot-history"));
    await withInventoryLock(directory, async () => { await expect(writeInventoryExports(snapshot([]), directory)).rejects.toThrow("in progress"); });
    await writeFile(path.join(directory, "dim-metadata.json"), "broken json");
    await expect(writeInventoryExports(snapshot([]), directory)).rejects.toThrow();
    expect(await readFile(path.join(directory, "inventory.json"), "utf8")).toBe(before);
    expect(await readdir(path.join(directory, "snapshot-history"))).toEqual(files);
  }));

  it("refuses missing/corrupt/path-traversing history rather than inventing an empty baseline", async () => local(async (directory) => {
    await writeInventoryExports(snapshot([armor(ids[0]!)]), directory);
    await writeInventoryExports(snapshot([armor(ids[0]!), armor(ids[1]!, 20)]), directory);
    const current = await readInventory(directory), historyFile = path.join(directory, "snapshot-history", current.history!.previous!);
    await writeFile(historyFile, "broken json");
    await expect(currentNewLoot(directory)).rejects.toThrow();
    await rm(historyFile);
    await expect(currentNewLoot(directory)).rejects.toThrow();
    current.history!.previous = "../../profile-data.json";
    await writeFile(path.join(directory, "inventory.json"), JSON.stringify(current));
    await expect(currentNewLoot(directory)).rejects.toThrow("Invalid local snapshot history reference");
    for (const history of [{ current: current.history!.current }, { current: current.history!.current, previous: "" }, null]) {
      await writeFile(path.join(directory, "inventory.json"), JSON.stringify({ ...current, history }));
      await expect(currentNewLoot(directory)).rejects.toThrow("Invalid local snapshot history reference");
    }
  }));

  it("migrates an existing pre-history inventory without calling old owned gear new", async () => local(async (directory) => {
    await writeFile(path.join(directory, "inventory.json"), JSON.stringify(snapshot([armor(ids[0]!)])));
    expect((await currentNewLoot(directory)).status).toBe("BASELINE");
    await writeInventoryExports(snapshot([armor(ids[0]!), armor(ids[1]!, 20)]), directory);
    expect((await currentNewLoot(directory)).acquired.map((item) => item.itemId)).toEqual([ids[1]]);
  }));

  it.each(["Favorite", "Keep", "Archive"])("uses current DIM %s protections and never selects or tags new redundant gear Junk", async (tag) => local(async (directory) => {
    await writeInventoryExports(snapshot([armor(ids[0]!, 20)]), directory);
    const current = snapshot([armor(ids[0]!, 20), armor(ids[1]!)]);
    await writeInventoryExports(current, directory);
    expect((await currentNewLoot(directory)).acquired[0]!.recommendation).toBe("REVIEW_FOR_DISMANTLE");
    await expect(exportDimSelection(directory, [])).rejects.toThrow("Explicitly select");
    await importDimMetadata(directory, current, `Id,Hash,Tag,Notes\n${ids[1]},831,${tag},keep my notes`);
    const result = await currentNewLoot(directory);
    expect(result.acquired[0]!.recommendation).toBe("PROTECTED");
    await expect(exportDimSelection(directory, [ids[1]!])).rejects.toThrow("eligible");
    expect((await readInventory(directory)).items[1]!.dim).toBeUndefined(); // Overlay leaves archived account evidence immutable.
    await expect(readFile(path.join(directory, "dim-cleanup.csv"))).rejects.toThrow();
  }));

  it("provides persistent CLI reports without advancing history and leaves successful state on failed import", async () => local(async (directory) => {
    await writeInventoryExports(snapshot([armor(ids[0]!)]), directory);
    await writeInventoryExports(snapshot([armor(ids[0]!), armor(ids[1]!, 20)], "2026-10-09T20:00:00Z"), directory);
    const run = promisify(execFile), before = await readFile(path.join(directory, "inventory.json"), "utf8");
    const cli = (args: string[]) => run(process.execPath, ["--import", "tsx", "src/cli.ts", ...args, "--output", directory]);
    const output = await cli(["new-loot"]);
    expect(output.stdout).toContain("1 first seen"); expect(output.stdout).toContain(ids[1]);
    const report = JSON.parse(await readFile(path.join(directory, "new-loot.json"), "utf8"));
    expect(report).toEqual(await currentNewLoot(directory));
    expect(await readFile(path.join(directory, "new-loot.txt"), "utf8")).toBe(formatNewLoot(report));
    expect(await readFile(path.join(directory, "inventory.json"), "utf8")).toBe(before);
    const invalid = path.join(directory, "bad-profile.json"); await writeFile(invalid, "bad json");
    await expect(cli(["import", invalid, "--offline"])).rejects.toThrow();
    expect(await readFile(path.join(directory, "inventory.json"), "utf8")).toBe(before);
    expect(await currentNewLoot(directory)).toEqual(report);
  }), 15000);

  it("serves fresh read-only localhost reports and UI links without exposing history", async () => local(async (directory) => {
    await writeInventoryExports(snapshot([armor(ids[0]!)]), directory);
    const server = createInventoryServer(directory);
    try {
      await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      expect((await (await fetch(`${base}/api/new-loot`)).json()).status).toBe("BASELINE");
      await writeInventoryExports(snapshot([armor(ids[0]!), armor(ids[1]!, 20)]), directory);
      const response = await fetch(`${base}/api/new-loot`);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toEqual(await currentNewLoot(directory));
      expect((await fetch(`${base}/api/new-loot`, { method: "POST" })).status).toBe(405);
      expect((await (await fetch(`${base}/new-loot`)).text())).toContain('href="/cleanup"');
      expect((await fetch(`${base}/new-loot.js`)).status).toBe(200);
      const committed = await readInventory(directory);
      expect((await fetch(`${base}/snapshot-history/${committed.history!.previous}`)).status).toBe(404);
      expect((await fetch(`${base}/downloads/new-loot.json`)).status).toBe(404);
    } finally {
      server.closeAllConnections();
      if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }));

  it("renders loot text safely and clears stale report details after a failed reload", async () => {
    class Element {
      textContent = ""; hidden = false; disabled = false; children: Element[] = []; listeners = new Map<string, () => Promise<void>>();
      append(...items: Element[]) { this.children.push(...items); }
      replaceChildren(...items: Element[]) { this.children = items; }
      addEventListener(event: string, callback: () => Promise<void>) { this.listeners.set(event, callback); }
    }
    const elements = new Map<string, Element>(), get = (id: string) => {
      if (!elements.has(id)) elements.set(id, new Element());
      return elements.get(id)!;
    };
    const report = compare(snapshot([]), snapshot([armor(ids[0]!, 20, { name: '<img src=x onerror="alert(1)">' })]));
    let fail = false;
    runInNewContext(await readFile("web/new-loot.js", "utf8"), {
      document: { getElementById: get, createElement: () => new Element() },
      fetch: async () => ({ ok: !fail, json: async () => fail ? { error: "Refresh failed" } : report }),
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(get("summary").textContent).toContain("1 first seen");
    expect(get("items").children[0]!.children[0]!.textContent).toContain('<img src=x onerror="alert(1)">');
    fail = true; await get("reload").listeners.get("click")!();
    expect(get("error").hidden).toBe(false); expect(get("error").textContent).toBe("Refresh failed");
    expect(get("summary").textContent).toContain("unavailable");
    expect(get("items").children).toEqual([]); expect(get("reload").disabled).toBe(false);
  });

  it("surfaces fresh loot counts and a report link immediately after the inventory UI refresh", async () => {
    class Element {
      textContent = ""; value = ""; hidden = false; disabled = false; href = ""; children: Element[] = []; listeners = new Map<string, () => Promise<void>>();
      append(...items: Element[]) { this.children.push(...items); }
      replaceChildren(...items: Element[]) { this.children = items; }
      setAttribute() {}
      addEventListener(event: string, callback: () => Promise<void>) { this.listeners.set(event, callback); }
    }
    const elements = new Map<string, Element>(), get = (id: string) => {
      if (!elements.has(id)) elements.set(id, new Element());
      return elements.get(id)!;
    };
    const previous = snapshot([armor(ids[0]!)]) ; let inventory = previous;
    let report = compare(null, previous);
    const calls: string[] = [];
    const source = (await readFile("web/app.js", "utf8")).replace(/^import[^\n]+\n/, "");
    runInNewContext(source, {
      document: { getElementById: get, createElement: () => new Element(), querySelectorAll: () => [], addEventListener() {} },
      window: { location: { search: "" } }, URLSearchParams,
      filterInventory: (items: OwnedItem[]) => items, sortInventory: (items: OwnedItem[]) => items,
      fetch: async (route: string) => {
        calls.push(route);
        if (route === "/api/sync") { inventory = snapshot([...previous.items, armor(ids[1]!, 20)]); report = compare(previous, inventory); }
        return { ok: true, json: async () => route === "/api/inventory" ? inventory : route === "/api/new-loot" ? report :
          route === "/api/auth/status" ? { configured: true, connected: true, syncing: false } : { items: 2, weapons: 0, armor: 2 } };
      },
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(get("new-loot-summary").children[0]!.textContent).toContain("baseline saved");
    calls.length = 0;
    await get("sync-bungie").listeners.get("click")!();
    expect(calls.slice(0, 3)).toEqual(["/api/sync", "/api/inventory", "/api/new-loot"]);
    expect(get("new-loot-summary").children[0]!.textContent).toContain("1 first seen · 1 improvements");
    expect(get("new-loot-summary").children[1]!.href).toBe("/new-loot");
    expect(get("sync-bungie").disabled).toBe(false);
  });
});
