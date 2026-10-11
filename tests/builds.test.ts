import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadBuildConfig } from "../src/analysis/build-config.js";
import { analyzeBuilds, formatBuildAnalysis, writeBuildAnalysis } from "../src/analysis/builds.js";
import type { InventorySnapshot, OwnedItem, OwnedPerk } from "../src/inventory.js";
import { normalizeInventory } from "../src/inventory.js";
import { parseProfile } from "../src/profile.js";

const config = await loadBuildConfig();
const arc = config.templates.find((build) => build.id === "titan-arc-grenade-hoil")!;
const bonk = config.templates.find((build) => build.id === "titan-solar-bonk")!;
function item(id: string, overrides: Partial<OwnedItem> = {}): OwnedItem {
  return { id, instanceId: id, itemHash: 1, name: "Heart of Inmost Light", description: "", known: true,
    type: "armor", typeName: "Exotic Chest Armor", classType: "Titan", characterId: null, location: "vault", locationLabel: "Vault",
    equipped: false, locked: false, masterworked: false, crafted: false, enhanced: false, exotic: true, quantity: 1,
    slot: "Chest", ammoType: null, damageType: null, power: null, tier: "Exotic", stats: null,
    sockets: [], selectedPerks: [], availablePerks: [], ...overrides };
}
function snapshot(items: OwnedItem[] = [item("armor")]): InventorySnapshot {
  return { schemaVersion: 1, importedAt: "fixture-time", profileTimestamp: "profile-time", manifestVersion: "fixture",
    characters: [{ id: "titan", classType: "Titan" }], unknownHashes: [], items,
    subclassCapabilities: [{ characterId: "titan", classType: "Titan", subclass: "Arc", abilities: ["Touch of Thunder"], evidence: "owned-subclass-sockets" }] };
}
function perk(name: string, overrides: Partial<OwnedPerk> = {}): OwnedPerk {
  return { hash: 1, name, description: "", known: true, category: "frames", enabled: true, canInsert: null, ...overrides };
}
const analyze = (input: InventorySnapshot) => analyzeBuilds(input, [arc], config.preferences).builds[0]!;

describe("Phase 4 build acceptance", () => {
  it("loads all ten distinct Titan PvE templates with honest metadata and stated preferences", () => {
    expect(config.templates).toHaveLength(10);
    expect(new Set(config.templates.map((build) => build.id)).size).toBe(10);
    expect(config.templates.every((build) => build.class === "Titan" && build.mode === "pve")).toBe(true);
    expect(config.templates.every((build) => build.metadata.verifiedAt === null && build.metadata.confidence === "draft")).toBe(true);
    expect(config.preferences.preferences.playstyles.flashy).toBe(10);
    expect(config.preferences.preferences.history).toEqual(expect.arrayContaining(["solar-bonk", "arc-grenade-spam", "void-devour"]));
  });

  it("confirms ready only from owned eligible exotic and same-character subclass evidence", () => {
    const result = analyze(snapshot());
    expect(result.readiness).toBe("READY_NOW");
    expect(result.owned).toEqual(expect.arrayContaining(["Touch of Thunder", "Heart of Inmost Light (1 owned)"]));
    expect(result.missing).toEqual([]);
    expect(result.unknown).toEqual([]);
    expect(result.recommendedItemIds).toContain("armor");
    expect(result.fitDetails.statCompatibility).toBe("unknown");
  });

  it("keeps legacy/absent unlock evidence unknown rather than inventing availability", () => {
    const input = snapshot();
    delete input.subclassCapabilities;
    const result = analyze(input);
    expect(result.readyNow).toBe(false);
    expect(result.readiness).toBe("NEEDS_VERIFICATION");
    expect(result.missing).toEqual([]);
    expect(result.unknown).toHaveLength(2);
  });

  it("does not combine required abilities across characters", () => {
    const input = snapshot();
    input.characters.push({ id: "second", classType: "Titan" });
    input.subclassCapabilities = [
      { characterId: "titan", classType: "Titan", subclass: "Solar", abilities: ["Throwing Hammer"], evidence: "owned-subclass-sockets" },
      { characterId: "second", classType: "Titan", subclass: "Solar", abilities: ["Sol Invictus", "Roaring Flames"], evidence: "owned-subclass-sockets" },
    ];
    const result = analyzeBuilds(input, [bonk], config.preferences).builds[0]!;
    expect(result.readyNow).toBe(false);
    expect(result.unknown).toHaveLength(1);
  });

  it("rejects wrong-class, nonexotic, unknown and zero-quantity gear for required ownership", () => {
    for (const overrides of [{ classType: "Warlock" }, { exotic: false }, { known: false }, { quantity: 0 }]) {
      expect(analyze(snapshot([item("ineligible", overrides)])).readyNow).toBe(false);
    }
    const wrongClass = analyze(snapshot([item("wrong", { classType: "Warlock" })]));
    expect(wrongClass.missing).toContain("Heart of Inmost Light");
    expect(analyze(snapshot([item("unknown", { known: false })])).unknown.join()).toContain("unresolved inventory");
  });

  it("reports missing gear and owned substitutions without declaring the exact build ready", () => {
    const result = analyze(snapshot([item("sub", { name: "Armamentarium" })]));
    expect(result.readiness).toBe("MISSING_REQUIRED");
    expect(result.missing).toContain("Heart of Inmost Light");
    expect(result.substitutions[0]).toMatchObject({ name: "Armamentarium", itemIds: ["sub"] });
    expect(result.upgrades.some((upgrade) => upgrade.name === "Heart of Inmost Light")).toBe(true);
  });

  it("requires an owned Titan character even when gear and orphan capability evidence exist", () => {
    const input = snapshot(); input.characters = [{ id: "titan", classType: "Hunter" }];
    const result = analyze(input);
    expect(result.missing).toContain("Titan character");
    expect(result.readyNow).toBe(false);
  });

  it("matches selected known perks and offers explicitly insertable alternatives without assuming active synergy", () => {
    const weapon = item("weapon", { name: "Arc Rifle", type: "weapon", classType: null, exotic: false, slot: "Energy", damageType: "Arc",
      selectedPerks: [perk("Demolitionist", { enabled: false }), perk("Voltshot", { known: false })],
      availablePerks: [perk("Demolitionist", { canInsert: true }), perk("Voltshot", { canInsert: false }), perk("Chain Reaction", { canInsert: null })] });
    const result = analyze(snapshot([item("armor"), weapon]));
    expect(result.bestOwnedWeapons[0]?.availablePerkOptions).toEqual(["Demolitionist"]);
    expect(result.bestOwnedWeapons[0]?.reasons.join()).not.toContain("selected");
    weapon.selectedPerks = [perk("Demolitionist")];
    expect(analyze(snapshot([item("armor"), weapon])).bestOwnedWeapons[0]?.reasons.join()).toContain("selected Demolitionist");
  });

  it("recommends at most one exotic weapon and one exotic armor, preserves slots and owned IDs", () => {
    const weapons = ["Kinetic", "Energy", "Power"].flatMap((slot, i) => [
      item(`exotic${i}`, { name: `Exotic ${i}`, type: "weapon", classType: null, slot, selectedPerks: [perk("Demolitionist"), perk("Voltshot")] }),
      item(`legendary${i}`, { name: `Legendary ${i}`, type: "weapon", classType: null, slot, exotic: false, selectedPerks: [perk("Demolitionist")] }),
    ]);
    const result = analyze(snapshot([item("armor"), ...weapons]));
    expect(result.bestOwnedWeapons).toHaveLength(3);
    expect(result.bestOwnedWeapons.filter((weapon) => weapon.exotic)).toHaveLength(1);
    expect(new Set(result.bestOwnedWeapons.map((weapon) => weapon.slot)).size).toBe(3);
    expect(result.recommendedItemIds.filter((id) => id === "armor")).toHaveLength(1);
  });

  it("changes ranking with user playstyles and history, deterministically for repeated inputs", () => {
    const input = snapshot();
    input.subclassCapabilities!.push({ characterId: "titan", classType: "Titan", subclass: "Solar", abilities: bonk.required.abilities, evidence: "owned-subclass-sockets" });
    input.items.push(item("bonk", { name: "Synthoceps" }));
    const arcPref = structuredClone(config.preferences), solarPref = structuredClone(config.preferences);
    arcPref.preferences.playstyles = { grenade: 10 }; arcPref.preferences.history = ["arc-grenade-spam"]; arcPref.preferences.priorities = {};
    solarPref.preferences.playstyles = { melee: 10 }; solarPref.preferences.history = ["solar-bonk"]; solarPref.preferences.priorities = {};
    const arcResult = analyzeBuilds(input, [arc, bonk], arcPref);
    const solarResult = analyzeBuilds(input, [arc, bonk], solarPref);
    expect(arcResult.builds[0]?.id).toBe(arc.id);
    expect(solarResult.builds[0]?.id).toBe(bonk.id);
    expect(analyzeBuilds(input, [arc, bonk], solarPref)).toEqual(solarResult);
  });

  it("normalizes selected subclass socket evidence, ignoring disabled/unknown/noninsertable plugs", () => {
    const profile = parseProfile({ characters: { data: { titan: { classType: 0 } } },
      characterEquipment: { data: { titan: { items: [{ itemHash: 10, itemInstanceId: "subclass" }] } } },
      itemComponents: { sockets: { data: { subclass: { sockets: [{ plugHash: 11, isEnabled: true }, { plugHash: 12, isEnabled: false }, { plugHash: 99 }] } } },
        reusablePlugs: { data: { subclass: { plugs: { "0": [{ plugItemHash: 13, canInsert: true }, { plugItemHash: 14 }, { plugItemHash: 15, canInsert: false }] } } } } } });
    const definitions = Object.fromEntries([10,11,12,13,14,15].map((hash) => [String(hash), { hash, itemType: hash === 10 ? 16 : 0, classType: 0, displayProperties: { name: hash === 10 ? "Behemoth" : `Ability ${hash}` } }]));
    const normalized = normalizeInventory(profile, definitions, "fixture");
    expect(normalized.subclassCapabilities).toEqual([{ characterId: "titan", classType: "Titan", subclass: "Stasis", abilities: ["Ability 11", "Ability 13"], evidence: "owned-subclass-sockets" }]);
  });

  it("exports each acceptance field and reproducibility versions to human-readable and JSON files", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "destiny-builds-"));
    try {
      const analysis = analyzeBuilds(snapshot(), config.templates, config.preferences, config);
      await writeBuildAnalysis(analysis, directory);
      const json = JSON.parse(await readFile(path.join(directory, "builds.json"), "utf8"));
      expect(json.builds).toHaveLength(10);
      expect(json.buildDefinitionVersion).toHaveLength(64);
      expect(json.preferenceVersion).toHaveLength(64);
      const text = formatBuildAnalysis(analysis);
      for (const label of ["Ready now:", "Owned:", "Missing:", "Unknown:", "Substitutions:", "Best currently owned weapons:", "Upgrade opportunities:"]) expect(text).toContain(label);
      expect(await readFile(path.join(directory, "builds.txt"), "utf8")).toBe(text);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
