import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { InventorySnapshot, OwnedItem, OwnedPerk } from "../src/inventory.js";
import { loadWeaponRatings, weaponRatingsSchema } from "../src/analysis/weapon-config.js";
import { analyzeWeapons, formatWeaponAnalysis, writeWeaponAnalysis } from "../src/analysis/weapons.js";

const ratings = await loadWeaponRatings();
const hashes = new Map<string, number>();
function perk(name: string): OwnedPerk {
  if (!hashes.has(name)) hashes.set(name, hashes.size + 100);
  return { hash: hashes.get(name)!, name, description: "", category: "traits", known: true, enabled: true, canInsert: null };
}
function weapon(id: string, names: string[], overrides: Partial<OwnedItem> = {}): OwnedItem {
  const selected = names.map(perk);
  return { id, instanceId: id, itemHash: 42, name: "Synthetic Rifle", description: "", known: true, type: "weapon", typeName: "Auto Rifle",
    classType: null, characterId: null, location: "vault", locationLabel: "Vault", equipped: false, locked: false, masterworked: false, crafted: false, enhanced: false,
    exotic: false, quantity: 1, slot: "Energy", ammoType: "Primary", damageType: "Arc", power: 2000, tier: "Legendary", stats: { "1": 50, "2": 40 },
    sockets: selected.map((selected, index) => ({ index, visible: true, selected, available: [] })), selectedPerks: selected, availablePerks: [], ...overrides };
}
function snapshot(items: OwnedItem[]): InventorySnapshot {
  return { schemaVersion: 1, importedAt: "synthetic-time", profileTimestamp: null, manifestVersion: "synthetic-manifest", characters: [], unknownHashes: [], items };
}
function fiveCopies(): OwnedItem[] {
  return [weapon("pve", ["Demolitionist", "Voltshot"]), weapon("lesser", ["Demolitionist"]), weapon("pvp", ["Moving Target", "Tap the Trigger"]), weapon("niche", ["Repulsor Brace", "Destabilizing Rounds"]), weapon("equal", ["Demolitionist", "Voltshot"])];
}

describe("Phase 5 role-aware weapon evaluation", () => {
  it("distinguishes five same-hash copies, preserves PvP and niche diversity, and explains all ten comparisons", () => {
    const result = analyzeWeapons(snapshot(fiveCopies()), ratings), family = result.families[0]!;
    expect(family.itemIds).toHaveLength(5);
    expect(family.comparisons).toHaveLength(10);
    expect(family.usefulRoles).toEqual(expect.arrayContaining(["ability-engine", "arc-synergy", "pvp-dueling", "survivability", "void-synergy"]));
    expect(family.representatives["pvp-dueling"]).toEqual(["pvp"]);
    expect(family.representatives["survivability"]).toEqual(["niche"]);
    expect(result.weapons.find((copy) => copy.itemId === "lesser")!.dominatedBy).toEqual(["equal", "pve"]);
    for (const id of ["pve", "pvp", "niche", "equal"]) expect(result.weapons.find((copy) => copy.itemId === id)!.dominatedBy).toEqual([]);
    for (const comparison of family.comparisons) {
      expect(comparison.roles).toHaveLength(family.usefulRoles.length);
      expect(comparison.roles.every((role) => role.explanation.length > 0)).toBe(true);
      expect(comparison.reasons.length).toBeGreaterThan(0);
      expect(comparison.provisional).toBe(true);
    }
    expect(family.comparisons.some((comparison) => comparison.outcome === "EQUAL_ROLE_SCORES")).toBe(true);
    expect(result.weapons.every((copy) => !("score" in copy))).toBe(true);
  });

  it("adds individual perk values and auditable pair bonuses only from simultaneous selected sockets", () => {
    const input = weapon("pair", ["Demolitionist", "Voltshot"]);
    const result = analyzeWeapons(snapshot([input]), ratings).weapons[0]!;
    expect(result.roleScores["ability-engine"]!.score).toBe(13);
    expect(result.roleScores["ability-engine"]!.evidence).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "pair", value: 3 })]));
    input.sockets = [];
    const noSockets = analyzeWeapons(snapshot([input]), ratings).weapons[0]!;
    expect(noSockets.roleScores["ability-engine"]!.score).toBe(10);
    expect(noSockets.unknowns.join()).toContain("simultaneous selected sockets not established");
  });

  it("never scores available perks as active or infers a pair from alternatives in one socket", () => {
    const available = perk("Voltshot"); available.canInsert = true;
    const input = weapon("alternate", ["Demolitionist"], { availablePerks: [available] });
    input.sockets[0]!.available = [available];
    const result = analyzeWeapons(snapshot([input, weapon("other", ["Demolitionist", "Voltshot"])]), ratings);
    const copy = result.weapons.find((item) => item.itemId === "alternate")!;
    expect(copy.roleScores["arc-synergy"]).toBeUndefined();
    expect(copy.roleScores["ability-engine"]!.score).toBe(10);
    expect(copy.availablePerks[0]).toMatchObject({ name: "Voltshot", canInsert: true });
    expect(result.families[0]!.comparisons[0]!.outcome).toBe("INSUFFICIENT_EVIDENCE");
  });

  it("refuses strict dominance for missing stats, unknown/unrated perks, different stats or unmodeled crafted/enhanced values", () => {
    for (const overrides of [{ stats: null }, { stats: { "1": 49 } }, { crafted: true }, { enhanced: true }, { masterworked: true }, { known: false }, { ammoType: null }, { damageType: null }]) {
      const result = analyzeWeapons(snapshot([weapon("better", ["Demolitionist", "Voltshot"]), weapon("uncertain", ["Demolitionist"], overrides)]), ratings);
      expect(result.families[0]!.comparisons[0]!.outcome).toBe("INSUFFICIENT_EVIDENCE");
      expect(result.weapons.every((item) => item.dominatedBy.length === 0)).toBe(true);
    }
    for (const known of [true, false]) {
      const input = weapon("unrated", ["Unrated Niche"]); input.selectedPerks[0]!.known = known;
      expect(analyzeWeapons(snapshot([input, weapon("better", ["Demolitionist"])]), ratings).families[0]!.comparisons[0]!.outcome).toBe("INSUFFICIENT_EVIDENCE");
    }
  });

  it("retains unique combination and crafted/enhanced facts for future cleanup without creating classifications", () => {
    const inputs = fiveCopies(); inputs[2]!.crafted = true; inputs[2]!.enhanced = true;
    const result = analyzeWeapons(snapshot(inputs), ratings);
    const copy = result.weapons.find((copy) => copy.itemId === "pvp")!;
    expect(copy.preservationEvidence).toMatchObject({ crafted: true, enhanced: true, uniqueSelectedCombination: true });
    expect(copy.nicheEvidence.join()).toContain("Unique selected perk combination");
    expect(result.weapons.every((copy) => !("classification" in copy))).toBe(true);
  });

  it("separates itemHash versions and excludes unowned quantities and armor", () => {
    const result = analyzeWeapons(snapshot([weapon("one", ["Demolitionist"]), weapon("version", ["Voltshot"], { itemHash: 43 }), weapon("empty", [], { quantity: 0 }), weapon("armor", [], { type: "armor" })]), ratings);
    expect(result.families).toHaveLength(2);
    expect(result.families.every((family) => family.comparisons.length === 0)).toBe(true);
    expect(result.weapons).toHaveLength(2);
  });

  it("records reproducible configuration and exports role-by-role human explanations", async () => {
    const input = snapshot(fiveCopies()), result = analyzeWeapons(input, ratings);
    expect(analyzeWeapons(input, ratings)).toEqual(result);
    expect(result.ratingsVersion).toHaveLength(64);
    expect(result.ratingsMetadata).toMatchObject({ confidence: "draft", verifiedAt: null });
    const directory = await mkdtemp(path.join(os.tmpdir(), "destiny-weapon-test-"));
    try {
      await writeWeaponAnalysis(result, directory);
      expect(JSON.parse(await readFile(path.join(directory, "weapon-analysis.json"), "utf8"))).toEqual(result);
      const formatted = formatWeaponAnalysis(result);
      expect(await readFile(path.join(directory, "weapon-analysis.txt"), "utf8")).toBe(formatted);
      expect(formatted).toContain("RIGHT_DOMINATES");
      expect(formatted).toContain("pvp-dueling");
      expect(formatted).toContain("not a dismantling recommendation");
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it("rejects role typos, undefined pair members, duplicated perk/pair definitions and permits explicit negative synergy", () => {
    const invalid = structuredClone(ratings); invalid.perks.Demolitionist = { typo: 10 };
    expect(weaponRatingsSchema.safeParse(invalid).success).toBe(false);
    invalid.perks.Demolitionist = { "ability-engine": 10 }; invalid.pairs[0]!.perks[0] = "Missing";
    expect(weaponRatingsSchema.safeParse(invalid).success).toBe(false);
    const negative = structuredClone(ratings); negative.pairs[0]!.scores["ability-engine"] = -5;
    expect(analyzeWeapons(snapshot([weapon("pair", ["Demolitionist", "Voltshot"])]), negative).weapons[0]!.roleScores["ability-engine"]!.score).toBe(5);
  });
});
