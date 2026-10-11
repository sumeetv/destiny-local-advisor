import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import type { InventorySnapshot, OwnedItem } from "../src/inventory.js";
import { loadBuildConfig, type BuildPreferences, type BuildTemplate } from "../src/analysis/build-config.js";
import { acquisitionConfigSchema, defaultAcquisitionConfig, loadAcquisitionConfig, type AcquisitionConfig } from "../src/analysis/acquisition-config.js";
import { analyzeAcquisition, formatAcquisition } from "../src/analysis/acquisition.js";
import { currentAcquisition, writeAcquisition } from "../src/acquisition-service.js";
import { importDimMetadata } from "../src/dim.js";
import { currentCleanup, exportDimSelection, withInventoryLock } from "../src/dim-service.js";
import { currentNewLoot } from "../src/new-loot-service.js";
import { writeInventoryExports } from "../src/exports.js";
import { createInventoryServer } from "../src/server.js";

const config = await loadBuildConfig();
const preferences: BuildPreferences = { version: 1, preferences: { class: "Titan", playstyles: { grenade: 10, melee: 5 },
  favorites: { weapons: [], exotics: [] }, history: [], priorities: { fun: 10 } } };
function template(id: string, exoticArmor: string | null, overrides: Partial<BuildTemplate> = {}): BuildTemplate {
  return { id, name: id, class: "Titan", mode: "pve", playstyles: ["grenade"], history: [],
    required: { subclass: "Arc", abilities: ["Touch of Thunder"], exoticArmor },
    preferred: { exoticArmor: [], weaponTraits: [] }, substitutions: [], ratings: { fun: 10 }, notes: [],
    metadata: { version: 1, verifiedAt: null, sandboxVersion: "unverified", confidence: "draft", sources: ["local test fixture"] }, ...overrides };
}
function armor(name: string, overrides: Partial<OwnedItem> = {}): OwnedItem {
  return { id: "6917529999999999991", instanceId: "6917529999999999991", itemHash: 42, name, description: "", known: true,
    type: "armor", typeName: "Chest Armor", classType: "Titan", characterId: null, location: "vault", locationLabel: "Vault",
    equipped: false, locked: false, masterworked: false, crafted: false, enhanced: false, exotic: true, quantity: 1,
    slot: "Chest", ammoType: null, damageType: null, power: 2000, tier: "Exotic", stats: {}, sockets: [], selectedPerks: [], availablePerks: [], ...overrides };
}
function snapshot(items: OwnedItem[] = [], evidence = true): InventorySnapshot {
  return { schemaVersion: 1, importedAt: "2026-10-09T20:00:00Z", profileTimestamp: "2026-10-09T20:00:00Z", manifestVersion: "fixture-manifest", inventoryCoverage: "complete",
    characters: [{ id: "titan", classType: "Titan" }], unknownHashes: [], items,
    ...(evidence ? { subclassCapabilities: [{ characterId: "titan", classType: "Titan", subclass: "Arc", abilities: ["Touch of Thunder"], evidence: "owned-subclass-sockets" as const }] } : {}) };
}
function facts(name: string, effort: "low" | "moderate" | "high", overrides: Partial<AcquisitionConfig["items"][number]> = {}): AcquisitionConfig["items"][number] {
  return { name, class: "Titan", availability: "unknown", source: null, effort,
    metadata: { confidence: "user-estimate", verifiedAt: null, sources: [], notes: ["Personal estimate; no availability claim"] }, ...overrides };
}
async function local<T>(action: (directory: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(path.join(tmpdir(), "destiny-phase9-"));
  try { return await action(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}

describe("Phase 9 marginal account acquisition planner", () => {
  it("deduplicates one pursuit across builds and explains major gaps, confirmed unlocks and reproducible value", () => {
    const result = analyzeAcquisition(snapshot(), [template("a", "Item A"), template("b", "Item A"), template("c", "Item B")], preferences);
    expect(result.pursuits.map((item) => item.name)).toEqual(["Item A", "Item B"]);
    expect(result.pursuits[0]).toMatchObject({ rank: 1, buildsUnlocked: 2, requiredBuildsImproved: 2, optionalAlternatives: 0, marginalValue: 1.7, valuePerEffort: null, effort: "unknown", source: null, availability: "unknown" });
    expect(result.pursuits[0]!.impacts.every((impact) => impact.scoreGain === 35 && impact.contribution === 0.85 && impact.blockers.length === 0)).toBe(true);
    expect(formatAcquisition(result)).toContain("Unlocks 2 ready builds");
    expect(result.provenance).toMatchObject({ manifestVersion: "fixture-manifest", snapshotDigest: expect.stringMatching(/^[0-9a-f]{64}$/), acquisitionConfigVersion: expect.stringMatching(/^[0-9a-f]{64}$/) });
  });

  it("does not recommend already owned eligible exotics in any location, including tagged gear", () => {
    for (const location of ["vault", "titan", "postmaster"] as const) {
      expect(analyzeAcquisition(snapshot([armor(" Item A ", { location, dim: { tag: "favorite" } })]), [template("a", "Item A")], preferences).pursuits).toEqual([]);
    }
    expect(analyzeAcquisition(snapshot([armor("Item A", { classType: "Warlock" })]), [template("a", "Item A")], preferences).pursuits).toHaveLength(1);
    expect(analyzeAcquisition(snapshot([armor("Item A", { quantity: 0 })]), [template("a", "Item A")], preferences).pursuits).toHaveLength(1);
  });

  it("owned substitutes reduce marginal value and priority without satisfying another exact required exotic", () => {
    const templates = [template("a", "Item A", { substitutions: ["Owned alternative"] }), template("b", "Item B")];
    const before = analyzeAcquisition(snapshot(), templates, preferences), after = analyzeAcquisition(snapshot([armor("Owned alternative")]), templates, preferences);
    expect(before.pursuits[0]!.name).toBe("Item A"); expect(after.pursuits[0]!.name).toBe("Item B");
    const reduced = after.pursuits.find((item) => item.name === "Item A")!;
    expect(reduced.marginalValue).toBe(before.pursuits[0]!.marginalValue / 2);
    expect(reduced.impacts[0]).toMatchObject({ scoreGain: 35, unlocksReadyBuild: true, substituteFactor: 0.5, existingSubstitutes: [{ name: "Owned alternative", itemIds: ["6917529999999999991"] }] });
  });

  it("only eligible exotic armor ownership suppresses optional pursuits", () => {
    const build = template("a", null, { preferred: { exoticArmor: ["Optional A"], weaponTraits: [] } });
    for (const override of [{ classType: "Warlock" }, { type: "weapon" as const }, { exotic: false }, { quantity: 0 }]) {
      expect(analyzeAcquisition(snapshot([armor("Optional A", override)]), [build], preferences).pursuits).toHaveLength(1);
    }
    expect(analyzeAcquisition(snapshot([armor("Optional A")]), [build], preferences).pursuits).toEqual([]);
  });

  it("defers zero-benefit items rather than ranking them as farming priorities", () => {
    const zero: BuildPreferences = { version: 1, preferences: { ...preferences.preferences, playstyles: {}, priorities: {}, history: [], favorites: { weapons: [], exotics: [] } } };
    const result = analyzeAcquisition(snapshot(), [template("a", "Item A")], zero);
    expect(result.pursuits).toEqual([]); expect(result.deferred[0]).toMatchObject({ name: "Item A", rank: 0, marginalValue: 0 });
    expect(formatAcquisition(result)).toContain("no modeled marginal benefit under current preferences");
  });

  it("personal playstyle, priority, favorites and history influence ranking", () => {
    const templates = [template("a", "Item A"), template("b", "Item B", { playstyles: ["melee"], history: ["melee-history"], ratings: { fun: 0, bossDamage: 10 } })];
    expect(analyzeAcquisition(snapshot(), templates, preferences).pursuits[0]!.name).toBe("Item A");
    const changed: BuildPreferences = { version: 1, preferences: { ...preferences.preferences, playstyles: { grenade: 0, melee: 10 }, priorities: { bossDamage: 10 }, history: ["melee-history"], favorites: { weapons: [], exotics: ["Item B"] } } };
    const result = analyzeAcquisition(snapshot(), templates, changed);
    expect(result.pursuits[0]!.name).toBe("Item B"); expect(result.pursuits[0]!.impacts[0]!.preferenceMatch).toBe(1);
  });

  it("does not claim unknown unlocks ready or combine ability evidence across characters", () => {
    const templates = [template("a", "Item A")], uncertain = analyzeAcquisition(snapshot([], false), templates, preferences).pursuits[0]!;
    expect(uncertain.buildsUnlocked).toBe(0); expect(uncertain.impacts[0]!.readinessAfter).toBe("NEEDS_VERIFICATION");
    expect(uncertain.impacts[0]!.blockers.join()).toContain("no positive account evidence");
    const divided = snapshot(); divided.characters.push({ id: "second", classType: "Titan" });
    divided.subclassCapabilities!.push({ characterId: "second", classType: "Titan", subclass: "Arc", abilities: ["Knockout"], evidence: "owned-subclass-sockets" });
    const multi = template("a", "Item A", { required: { subclass: "Arc", abilities: ["Touch of Thunder", "Knockout"], exoticArmor: "Item A" } });
    expect(analyzeAcquisition(divided, [multi], preferences).pursuits[0]!.buildsUnlocked).toBe(0);
  });

  it("requires complete resolved inventory and an eligible character before suggesting missing gear", () => {
    const templates = [template("a", "Item A")];
    for (const data of [snapshot([armor("Unknown", { known: false })]), { ...snapshot(), inventoryCoverage: "partial" as const }, { ...snapshot(), inventoryCoverage: undefined }, { ...snapshot(), characters: [] }]) {
      const result = analyzeAcquisition(data as InventorySnapshot, templates, preferences);
      expect(result.pursuits).toEqual([]); expect(result.verification).toHaveLength(1); expect(result.verification[0]!.reasons.length).toBeGreaterThan(0);
    }
  });

  it("optional exotic alternatives have explicit small assumed value and no invented exact-template fit gain/unlock", () => {
    const build = template("a", "Owned required", { preferred: { exoticArmor: ["Optional A"], weaponTraits: [] } });
    const result = analyzeAcquisition(snapshot([armor("Owned required")]), [build], preferences).pursuits[0]!;
    expect(result).toMatchObject({ name: "Optional A", buildsUnlocked: 0, requiredBuildsImproved: 0, optionalAlternatives: 1 });
    expect(result.impacts[0]).toMatchObject({ scoreGain: 0, magnitude: 0.15, substituteFactor: 0.5 });
    expect(result.impacts[0]!.reasons.join()).toContain("no exact-template improvement is promised");
    expect(result.impacts[0]!.reasons.join()).toContain("one exotic armor piece");
    // Duplicate required/preferred references to the same item contribute once.
    expect(analyzeAcquisition(snapshot(), [template("a", "Item A", { preferred: { exoticArmor: ["Item A", "Item A"], weaponTraits: [] } })], preferences).pursuits[0]!.impacts).toHaveLength(1);
  });

  it("specific Stoicism spirit rolls stay outside name-based pursuit readiness claims", () => {
    const result = analyzeAcquisition(snapshot([], false), config.templates, config.preferences);
    const stoicism = result.pursuits.find((item) => item.name === "Stoicism")!;
    expect(stoicism.buildsUnlocked).toBe(0);
    expect(stoicism.impacts[0]!.reasons.join()).toContain("owning Stoicism does not confirm a specific spirit combination");
    expect(result.limitations.join()).toContain("spirit combinations are not modeled");
  });

  it("effort estimates materially reorder pursuits and unknown effort has no fabricated denominator", () => {
    const templates = [template("a", "Item A"), template("b", "Item A"), template("c", "Item B"), template("d", "Item C")];
    const result = analyzeAcquisition(snapshot(), templates, preferences, { version: 1, items: [facts("Item A", "high"), facts("Item B", "low")] });
    expect(result.pursuits.map((item) => item.name)).toEqual(["Item B", "Item A", "Item C"]);
    expect(result.pursuits[0]).toMatchObject({ valuePerEffort: 0.85, effortUnits: 1, availability: "unknown" });
    expect(result.pursuits[1]).toMatchObject({ valuePerEffort: 0.283, effortUnits: 6 });
    expect(result.pursuits[2]).toMatchObject({ valuePerEffort: null, effortUnits: null, effort: "unknown" });
    expect(result.rankingPolicy).toContain("Unknown effort queue separately ordered by benefit only");
  });

  it("ignores draft effort/source facts and excludes verified unavailable pursuits", () => {
    const verified = { confidence: "verified" as const, verifiedAt: "2026-10-01T00:00:00Z", sources: ["local:fixture-source"], notes: ["Fixture, not a Destiny availability claim"] };
    const result = analyzeAcquisition(snapshot(), [template("a", "Item A"), template("b", "Item B")], preferences, { version: 1, items: [
      facts("Item A", "low", { source: "Draft route", metadata: { ...verified, confidence: "draft" }, availability: "unknown" }),
      facts("Item B", "moderate", { availability: "unavailable", source: "Fixture unavailable", metadata: verified }),
    ] });
    expect(result.pursuits[0]).toMatchObject({ effort: "unknown", source: null, valuePerEffort: null, availability: "unknown", metadata: { confidence: "draft" } });
    expect(result.unavailable[0]).toMatchObject({ name: "Item B", rank: 0, availability: "unavailable" });
    expect(formatAcquisition(result)).toContain("Excluded unavailable pursuit: Item B");
  });

  it("validates config provenance, schema versions, availability authority and duplicate keys", async () => {
    expect(await loadAcquisitionConfig()).toEqual(defaultAcquisitionConfig);
    expect(acquisitionConfigSchema.safeParse({ version: 2, items: [] }).success).toBe(false);
    expect(acquisitionConfigSchema.safeParse({ version: 1, items: [facts("A", "low"), facts(" a ", "moderate")] }).success).toBe(false);
    expect(acquisitionConfigSchema.safeParse({ version: 1, items: [facts("A", "low", { availability: "available" })] }).success).toBe(false);
    expect(acquisitionConfigSchema.safeParse({ version: 1, items: [facts("A", "low", { metadata: { confidence: "verified", verifiedAt: null, sources: [], notes: [] } })] }).success).toBe(false);
  });

  it("ranks deterministic ties by identity, filters class/PvP and records changed config/preferences/snapshot versions", () => {
    const templates = [template("z", "Z"), template("a", "A"), template("pvp", "P", { mode: "pvp" }), template("hunter", "H", { class: "Hunter" })];
    const before = snapshot(), bytes = JSON.stringify(before);
    const result = analyzeAcquisition(before, templates, preferences);
    expect(result.pursuits.map((item) => item.name)).toEqual(["A", "Z"]);
    expect(analyzeAcquisition(before, templates, preferences)).toEqual(result);
    expect(JSON.stringify(before)).toBe(bytes); expect(before.items).toEqual([]);
    expect(analyzeAcquisition(before, templates, preferences, { version: 1, items: [facts("A", "low")] }).provenance.acquisitionConfigVersion).not.toBe(result.provenance.acquisitionConfigVersion);
    expect(analyzeAcquisition(before, templates, { ...preferences, version: 2 }).provenance.preferenceVersion).not.toBe(result.provenance.preferenceVersion);
    expect(analyzeAcquisition({ ...before, importedAt: "2026-10-10T00:00:00Z" }, templates, preferences).provenance.snapshotDigest).not.toBe(result.provenance.snapshotDigest);
  });

  it("exports versioned reproducible JSON/text while preserving inventory, histories, DIM and cleanup safety", async () => local(async (directory) => {
    await writeInventoryExports(snapshot([armor("Synthoceps")]), directory);
    const before = await readFile(path.join(directory, "inventory.json"), "utf8"), history = await readdir(path.join(directory, "snapshot-history"));
    const inventory = JSON.parse(before) as InventorySnapshot;
    await importDimMetadata(directory, inventory, 'Id,Hash,Tag,Notes\n6917529999999999991,42,favorite,preserve me\n');
    const cleanup = await currentCleanup(directory), loot = await currentNewLoot(directory), report = await currentAcquisition(directory);
    expect(report.pursuits.some((item) => item.name === "Synthoceps")).toBe(false);
    await writeAcquisition(report, directory);
    expect(JSON.parse(await readFile(path.join(directory, "upgrades.json"), "utf8"))).toEqual(report);
    expect(await readFile(path.join(directory, "upgrades.txt"), "utf8")).toBe(formatAcquisition(report));
    expect(await currentAcquisition(directory)).toEqual(report);
    expect(await readFile(path.join(directory, "inventory.json"), "utf8")).toBe(before);
    expect(await readdir(path.join(directory, "snapshot-history"))).toEqual(history);
    expect(await currentNewLoot(directory)).toEqual(loot); expect(await currentCleanup(directory)).toEqual(cleanup);
    await expect(exportDimSelection(directory, ["6917529999999999991"])).rejects.toThrow();
    expect(cleanup.snapshot.items[0]!.dim?.tag).toBe("Favorite");
    expect(cleanup.cleanup.items.every((item) => !item.itemId.startsWith("planning:"))).toBe(true);
  }));

  it("shares inventory locking and refuses missing/corrupt snapshot or acquisition configuration", async () => local(async (directory) => {
    await expect(currentAcquisition(directory)).rejects.toThrow();
    await writeInventoryExports(snapshot(), directory);
    await withInventoryLock(directory, async () => { await expect(currentAcquisition(directory)).rejects.toThrow("in progress"); });
    const filename = path.join(directory, "bad.yaml"); await writeFile(filename, "broken");
    await expect(currentAcquisition(directory, { acquisitionConfig: filename })).rejects.toThrow();
    await writeFile(path.join(directory, "inventory.json"), "broken");
    await expect(currentAcquisition(directory)).rejects.toThrow();
  }));

  it("runs the upgrades CLI with custom effort settings and writes valid reports", async () => local(async (directory) => {
    await writeInventoryExports(snapshot(), directory);
    const filename = path.join(directory, "acquisition.yaml");
    await writeFile(filename, JSON.stringify({ version: 1, items: [facts("Synthoceps", "low")] }));
    const result = await promisify(execFile)(process.execPath, ["node_modules/tsx/dist/cli.mjs", "src/cli.ts", "upgrades", "--output", directory, "--acquisition-config", filename]);
    expect(result.stdout).toContain("acquisition planner"); expect(result.stdout).toContain("Estimated effort: low");
    const data = JSON.parse(await readFile(path.join(directory, "upgrades.json"), "utf8"));
    expect(data.schemaVersion).toBe(1); expect(data.pursuits[0].name).toBe("Synthoceps");
  }));

  it("serves fresh local planner, downloads and navigable UI with current custom settings", async () => local(async (directory) => {
    await writeInventoryExports(snapshot(), directory);
    const filename = path.join(directory, "acquisition.yaml");
    await writeFile(filename, JSON.stringify({ version: 1, items: [facts("Synthoceps", "low")] }));
    const server = createInventoryServer(directory, { analysisPaths: { acquisitionConfig: filename } });
    try {
      await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const response = await fetch(`${base}/api/upgrades`), report = await response.json();
      expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("no-store");
      expect(report.pursuits[0].name).toBe("Synthoceps");
      expect(await (await fetch(`${base}/downloads/upgrades.json`)).json()).toEqual(report);
      expect(await (await fetch(`${base}/downloads/upgrades.txt`)).text()).toBe(formatAcquisition(report));
      expect(await (await fetch(`${base}/upgrades`)).text()).toContain('src="/upgrades.js"');
      expect(await (await fetch(base)).text()).toContain('href="/upgrades"');
      expect((await fetch(`${base}/api/upgrades`, { method: "POST" })).status).toBe(405);
      await writeInventoryExports(snapshot([armor("Synthoceps")]), directory);
      expect((await (await fetch(`${base}/api/upgrades`)).json()).pursuits.some((item: { name: string }) => item.name === "Synthoceps")).toBe(false);
      await writeFile(filename, "broken");
      expect((await fetch(`${base}/api/upgrades`)).status).toBe(400);
    } finally { server.closeAllConnections(); if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve())); }
  }));

  it("renders report names/evidence as safe text and clears stale data after failed reload", async () => {
    class Element {
      textContent = ""; hidden = false; disabled = false; children: Element[] = []; listeners = new Map<string, () => Promise<void>>();
      append(...items: Element[]) { this.children.push(...items); }
      replaceChildren(...items: Element[]) { this.children = items; }
      addEventListener(event: string, callback: () => Promise<void>) { this.listeners.set(event, callback); }
    }
    const elements = new Map<string, Element>(), get = (id: string) => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id)!; };
    const report = analyzeAcquisition(snapshot(), [template("a", '<img src=x onerror="alert(1)">')], preferences);
    let fail = false;
    runInNewContext(await readFile("web/upgrades.js", "utf8"), {
      document: { getElementById: get, createElement: () => new Element() },
      fetch: async () => ({ ok: !fail, json: async () => fail ? { error: "Config failed" } : report }),
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(get("summary").textContent).toContain("1 confirmed missing");
    expect(get("pursuits").children[0]!.children[0]!.textContent).toContain('<img src=x onerror="alert(1)">');
    fail = true; await get("reload").listeners.get("click")!();
    expect(get("error").textContent).toBe("Config failed"); expect(get("error").hidden).toBe(false);
    expect(get("pursuits").children).toEqual([]); expect(get("provenance").textContent).toBe(""); expect(get("reload").disabled).toBe(false);
  });
});
