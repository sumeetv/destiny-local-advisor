import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadBuildConfig } from "../src/analysis/build-config.js";
import { analyzeBuilds } from "../src/analysis/builds.js";
import { loadAnalysisSnapshot } from "../src/analysis/snapshot.js";
import type { InventorySnapshot, OwnedItem, OwnedPerk } from "../src/inventory.js";

const config = await loadBuildConfig();
const arc = config.templates.find((build) => build.id === "titan-arc-grenade-hoil")!;
const prismatic = config.templates.find((build) => build.id === "titan-prismatic-consecration-synthoceps")!;
const perk = (name: string): OwnedPerk => ({ hash: 1, name, description: "", category: "frames", known: true, enabled: true, canInsert: null });
function weapon(id: string, overrides: Partial<OwnedItem> = {}): OwnedItem {
  return { id, instanceId: id, itemHash: 1, name: id, description: "", known: true,
    type: "weapon", typeName: "Weapon", classType: null, characterId: null, location: "vault", locationLabel: "Vault",
    equipped: false, locked: false, masterworked: false, crafted: false, enhanced: false, exotic: false, quantity: 1,
    slot: "Power", ammoType: "Heavy", damageType: null, power: null, tier: "Legendary", stats: null,
    sockets: [], selectedPerks: [], availablePerks: [], ...overrides };
}
function account(items: OwnedItem[]): InventorySnapshot {
  return { schemaVersion: 1, importedAt: "fixture", profileTimestamp: "fixture", manifestVersion: "fixture",
    characters: [{ id: "titan", classType: "Titan" }], unknownHashes: [], items,
    subclassCapabilities: [{ characterId: "titan", classType: "Titan", subclass: "Arc", abilities: ["Touch of Thunder"], evidence: "owned-subclass-sockets" }] };
}
const evaluate = (items: OwnedItem[]) => analyzeBuilds(account(items), [arc], config.preferences).builds[0]!;

describe("independent Phase 4 regressions", () => {
  it("excludes class-restricted, unresolved, zero-quantity, and invalid-slot weapon alternatives", () => {
    const synergy = [perk("Demolitionist"), perk("Voltshot")];
    const eligible = weapon("titan-sword", { classType: "Titan", selectedPerks: [perk("Chain Reaction")] });
    const result = evaluate([
      eligible,
      weapon("hunter-sword", { classType: "Hunter", selectedPerks: synergy }),
      weapon("warlock-sword", { classType: "Warlock", selectedPerks: synergy }),
      weapon("unknown", { known: false, selectedPerks: synergy }),
      weapon("zero", { quantity: 0, selectedPerks: synergy }),
      weapon("unresolved-slot", { slot: null, selectedPerks: synergy }),
    ]);
    expect(result.bestOwnedWeapons.map((item) => item.itemId)).toEqual([eligible.id]);
  });

  it("does not treat Taken enemy bonus damage as an area-damage perk", () => {
    const result = evaluate([weapon("taken-bonus", { selectedPerks: [perk("Taken Predator")] })]);
    expect(result.bestOwnedWeapons[0]?.score).toBe(0);
    expect(result.bestOwnedWeapons[0]?.reasons.join()).not.toContain("area-damage");
  });

  it("chooses the exotic slot with the greatest total loadout benefit rather than greedily taking the first exotic", () => {
    const result = evaluate([
      weapon("kinetic-exotic", { slot: "Kinetic", exotic: true, selectedPerks: [perk("Demolitionist"), perk("Chain Reaction")] }),
      weapon("kinetic-legendary", { slot: "Kinetic", selectedPerks: [perk("Chain Reaction")] }),
      weapon("energy-exotic", { slot: "Energy", exotic: true, selectedPerks: [perk("Demolitionist"), perk("Voltshot")] }),
      weapon("energy-legendary", { slot: "Energy" }),
      weapon("power-legendary", { selectedPerks: [perk("Chain Reaction")] }),
    ]);
    expect(result.bestOwnedWeapons.map((item) => item.itemId)).toEqual(["kinetic-legendary", "energy-exotic", "power-legendary"]);
    expect(result.bestOwnedWeapons.reduce((sum, item) => sum + item.score, 0)).toBe(20);
  });

  it("keeps an ability unlocked on another subclass out of Prismatic readiness", () => {
    const snapshot = account([weapon("synthoceps", { type: "armor", name: "Synthoceps", exotic: true, classType: "Titan", slot: "Gauntlets" })]);
    snapshot.subclassCapabilities = [
      { characterId: "titan", classType: "Titan", subclass: "Arc", abilities: ["Knockout"], evidence: "owned-subclass-sockets" },
      { characterId: "titan", classType: "Titan", subclass: "Strand", abilities: ["Frenzied Blade"], evidence: "owned-subclass-sockets" },
      { characterId: "titan", classType: "Titan", subclass: "Prismatic", abilities: ["Consecration"], evidence: "owned-subclass-sockets" },
    ];
    const result = analyzeBuilds(snapshot, [prismatic], config.preferences).builds[0]!;
    expect(result.readyNow).toBe(false);
    expect(result.unknown.join()).toContain("Knockout");
    expect(result.unknown.join()).toContain("Frenzied Blade");
    expect(result.owned).toContain("Consecration");
  });

  it.skipIf(!existsSync("profile-data.json") || !existsSync("data/manifest"))(
    "reports the ten account-specific builds with conservative real subclass evidence and legal owned suggestions",
    async () => {
      const snapshot = await loadAnalysisSnapshot("profile-data.json", true);
      const analysis = analyzeBuilds(snapshot, config.templates, config.preferences, config);
      expect(analysis.builds).toHaveLength(10);
      expect(analysis.builds.filter((build) => build.readyNow).map((build) => build.id)).toEqual([
        "titan-arc-grenade-hoil", "titan-void-devour-hoil", "titan-solar-bonk",
      ]);
      expect(analysis.builds.find((build) => build.id === prismatic.id)?.unknown.join()).toContain("Frenzied Blade");
      expect(snapshot.subclassCapabilities?.map((entry) => entry.subclass).sort()).toEqual(["Arc", "Prismatic", "Solar", "Stasis", "Strand", "Void"]);
      for (const result of analysis.builds) {
        expect(result.score).toBeGreaterThanOrEqual(0);
        expect(result.score).toBeLessThanOrEqual(100);
        expect(result.upgrades.length).toBeGreaterThan(0);
        expect(result.bestOwnedWeapons.filter((item) => item.exotic).length).toBeLessThanOrEqual(1);
        expect(new Set(result.bestOwnedWeapons.map((item) => item.slot)).size).toBe(result.bestOwnedWeapons.length);
        expect(result.recommendedItemIds.every((id) => snapshot.items.some((item) => item.id === id && item.known))).toBe(true);
        if (result.readyNow) { expect(result.missing).toEqual([]); expect(result.unknown).toEqual([]); }
      }
    }, 15000,
  );
});
