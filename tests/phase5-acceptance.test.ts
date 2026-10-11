import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadWeaponRatings, weaponRatingsSchema } from "../src/analysis/weapon-config.js";
import { analyzeWeapons, formatWeaponAnalysis } from "../src/analysis/weapons.js";
import { loadAnalysisSnapshot } from "../src/analysis/snapshot.js";
import type { InventorySnapshot, OwnedItem, OwnedPerk } from "../src/inventory.js";

const ratings = await loadWeaponRatings();
const names = Object.keys(ratings.perks);
const perk = (name: string, extra: Partial<OwnedPerk> = {}): OwnedPerk => ({
  hash: names.indexOf(name) + 100, name, description: "", category: "trait",
  known: true, enabled: true, canInsert: true, ...extra,
});
function weapon(id: string, selected: string[], extra: Partial<OwnedItem> = {}): OwnedItem {
  const selectedPerks = selected.map((name) => perk(name));
  return { id, instanceId: id, itemHash: 100, name: "Acceptance Rifle", description: "", known: true,
    type: "weapon", typeName: "Auto Rifle", classType: null, characterId: null, location: "vault", locationLabel: "Vault",
    equipped: false, locked: false, masterworked: false, crafted: false, enhanced: false, exotic: false, quantity: 1,
    slot: "Energy", ammoType: "Primary", damageType: "Arc", power: 2000, tier: "Legendary", stats: { range: 50, stability: 50 },
    sockets: selectedPerks.map((selected, index) => ({ index, visible: true, selected, available: [] })),
    selectedPerks, availablePerks: [], ...extra };
}
function account(items: OwnedItem[]): InventorySnapshot {
  return { schemaVersion: 1, importedAt: "acceptance-fixture", profileTimestamp: "acceptance-fixture", manifestVersion: "acceptance-fixture", characters: [], unknownHashes: [], items };
}
const evaluate = (items: OwnedItem[]) => analyzeWeapons(account(items), ratings);
const strong = (id = "strong") => weapon(id, ["Demolitionist", "Voltshot"]);
const weak = (id = "weak") => weapon(id, ["Wellspring", "Feeding Frenzy"]);

describe("independent Phase 5 acceptance", () => {
  it("compares five same-family copies, preserves PvP and Solar roles, and explains all ten pairs", () => {
    const analysis = evaluate([strong("ability-clear"), weak(), weapon("pvp", ["Moving Target", "Tap the Trigger"]), strong("equal"), weapon("solar", ["Pugilist", "Incandescent"])]);
    const family = analysis.families[0]!;
    expect(family.comparisons).toHaveLength(10);
    expect(family.representatives["pvp-dueling"]).toEqual(["pvp"]);
    expect(family.representatives["solar-synergy"]).toEqual(["solar"]);
    expect(analysis.weapons.find((item) => item.itemId === "weak")?.dominatedBy).toEqual(["ability-clear", "equal", "solar"]);
    expect(analysis.weapons.find((item) => item.itemId === "pvp")?.dominatedBy).toEqual([]);
    expect(family.comparisons.find((pair) => pair.leftItemId === "ability-clear" && pair.rightItemId === "equal")?.outcome).toBe("EQUAL_ROLE_SCORES");
    for (const pair of family.comparisons) {
      expect(pair.reasons.length).toBeGreaterThan(0);
      expect(pair.roles.every((role) => role.explanation.length > 0)).toBe(true);
      expect(pair.provisional).toBe(true);
      if (pair.outcome === "LEFT_DOMINATES") {
        expect(pair.roles.every((role) => role.leftScore >= role.rightScore)).toBe(true);
        expect(pair.roles.some((role) => role.leftScore > role.rightScore)).toBe(true);
      }
    }
    const text = formatWeaponAnalysis(analysis);
    expect(text.match(/Compare \[/g)).toHaveLength(10);
    expect(text).toContain("no authoritative overall god-roll score");
    expect(Object.keys(analysis.weapons[0]!)).not.toContain("score");
  });

  it("never compares different hashes, even when names and rolls match", () => {
    const analysis = evaluate([strong(), weak(), weak("other-version"), weapon("empty", [], { quantity: 0 })]);
    const other = analysis.weapons.find((item) => item.itemId === "other-version")!;
    const independent = analyzeWeapons(account([strong(), weapon("other-version", ["Wellspring", "Feeding Frenzy"], { itemHash: 101 })]), ratings);
    expect(other.itemHash).toBe(100);
    expect(independent.families).toHaveLength(2);
    expect(independent.families.every((family) => family.comparisons.length === 0)).toBe(true);
    expect(independent.weapons.every((item) => item.dominatedBy.length === 0)).toBe(true);
    expect(analysis.weapons.some((item) => item.itemId === "empty")).toBe(false);
  });

  it("does not score available-only PvP perks as selected or infer pair synergy without sockets", () => {
    const item = weak();
    item.availablePerks = [perk("Moving Target"), perk("Tap the Trigger")];
    item.sockets[0]!.available = item.availablePerks;
    const result = evaluate([strong(), item]);
    expect(result.weapons.find((copy) => copy.itemId === item.id)?.roleScores["pvp-dueling"]).toBeUndefined();
    expect(result.families[0]!.comparisons[0]!.outcome).toBe("INSUFFICIENT_EVIDENCE");
    const unsocketed = evaluate([strong("pair-without-sockets")].map((copy) => ({ ...copy, sockets: [] }))).weapons[0]!;
    expect(unsocketed.roleScores["ability-engine"]?.score).toBe(10);
    expect(unsocketed.roleScores["add-clear"]?.score).toBe(13);
    expect(unsocketed.unknowns.join()).toContain("simultaneous selected sockets not established");
  });

  it("blocks dominance for equal flattened options with different socket compatibility", () => {
    const left = strong(), right = weak();
    const choices = [perk("Moving Target"), perk("Tap the Trigger")];
    left.availablePerks = right.availablePerks = choices;
    left.sockets[0]!.available = choices;
    right.sockets[0]!.available = [choices[0]!];
    right.sockets[1]!.available = [choices[1]!];
    const pair = evaluate([left, right]).families[0]!.comparisons[0]!;
    expect(pair.outcome).toBe("INSUFFICIENT_EVIDENCE");
    expect(pair.reasons.join()).toContain("socket layout or compatibility differs");
  });

  it("blocks even matching alternate option sets because all possible loadouts are unevaluated", () => {
    const left = strong(), right = weak();
    const choice = perk("Moving Target");
    for (const item of [left, right]) { item.availablePerks = [choice]; item.sockets[0]!.available = [choice]; }
    const pair = evaluate([left, right]).families[0]!.comparisons[0]!;
    expect(pair.outcome).toBe("INSUFFICIENT_EVIDENCE");
    expect(pair.reasons.join()).toContain("all possible selected loadouts have not been compared");
  });

  it("does not turn missing stats, unknown perks, unverified insertability, or differing stats into dominance", () => {
    const variants = [
      weak("no-stats"), weak("unresolved"), weak("unknown-option"), weak("different-stats"),
    ];
    variants[0]!.stats = null;
    variants[1]!.selectedPerks[0]!.known = false;
    variants[2]!.availablePerks = [perk("Opening Shot", { canInsert: null })];
    variants[3]!.stats = { range: 51, stability: 50 };
    for (const item of variants) {
      const pair = evaluate([strong(), item]).families[0]!.comparisons[0]!;
      expect(pair.outcome).toBe("INSUFFICIENT_EVIDENCE");
    }
  });

  it("rejects disabled or hidden selected socket evidence", () => {
    const disabled = strong("disabled"); disabled.selectedPerks[0]!.enabled = false;
    expect(evaluate([disabled]).weapons[0]!.roleScores["ability-engine"]).toBeUndefined();
    const hidden = strong("hidden"); hidden.sockets[0]!.visible = false;
    const result = evaluate([hidden]).weapons[0]!;
    expect(result.roleScores["ability-engine"]).toBeUndefined();
    expect(result.unknowns.join()).toContain("matching active socket evidence");
  });

  it("records uniqueness and protection signals without converting weapon scores into cleanup classifications", () => {
    const analysis = evaluate([strong(), weak("protected")].map((item) => item.id === "protected" ? { ...item, locked: true, equipped: true, crafted: true, enhanced: true, masterworked: true } : item));
    const result = analysis.weapons.find((item) => item.itemId === "protected")!;
    expect(result.preservationEvidence).toMatchObject({ locked: true, equipped: true, crafted: true, enhanced: true, masterworked: true, uniqueSelectedCombination: true });
    expect(result.dominatedBy).toEqual([]);
    expect(Object.keys(result)).not.toContain("classification");
  });

  it("distinguishes provisional ratings and accepts negative combination weights", () => {
    const verified = weaponRatingsSchema.parse({ ...ratings, metadata: { ...ratings.metadata, confidence: "high", verifiedAt: "2026-10-07" }, pairs: [{ perks: ["Demolitionist", "Voltshot"], scores: { "add-clear": -5 }, reason: "Independent negative synergy fixture" }] });
    const analysis = analyzeWeapons(account([strong(), weak()]), verified);
    expect(analysis.weapons.find((item) => item.itemId === "strong")?.roleScores["add-clear"]?.score).toBe(8);
    expect(analysis.families[0]!.comparisons[0]!.provisional).toBe(false);
    const unverified = { ...verified, metadata: { ...verified.metadata, verifiedAt: null } };
    expect(analyzeWeapons(account([strong(), weak()]), unverified).families[0]!.comparisons[0]!.provisional).toBe(true);
  });

  it.skipIf(!existsSync("profile-data.json") || !existsSync("data/manifest"))("handles the complete real local profile without cross-family alternatives or definitive draft comparisons", async () => {
    const snapshot = await loadAnalysisSnapshot("profile-data.json", true);
    const analysis = analyzeWeapons(snapshot, ratings);
    expect(analysis.weapons).toHaveLength(snapshot.items.filter((item) => item.type === "weapon" && item.quantity > 0).length);
    const byId = new Map(analysis.weapons.map((item) => [item.itemId, item]));
    for (const family of analysis.families) {
      expect(family.comparisons).toHaveLength(family.itemIds.length * (family.itemIds.length - 1) / 2);
      for (const pair of family.comparisons) { expect(pair.provisional).toBe(true); expect(pair.reasons.length).toBeGreaterThan(0); }
      for (const id of family.itemIds) expect(byId.get(id)?.dominatedBy.every((alternative) => byId.get(alternative)?.itemHash === family.itemHash)).toBe(true);
    }
  }, 15000);
});
