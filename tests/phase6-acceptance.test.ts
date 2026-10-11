import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { InventorySnapshot, OwnedItem, OwnedPerk } from "../src/inventory.js";
import { analyzeCleanup, formatCleanupAnalysis } from "../src/analysis/cleanup.js";
import { cleanupConfigSchema, defaultCleanupConfig } from "../src/analysis/cleanup-config.js";
import { weaponRatingsSchema, loadWeaponRatings } from "../src/analysis/weapon-config.js";
import { analyzeWeapons } from "../src/analysis/weapons.js";
import { analyzeBuilds } from "../src/analysis/builds.js";
import { loadBuildConfig } from "../src/analysis/build-config.js";
import { loadAnalysisSnapshot } from "../src/analysis/snapshot.js";

// Synthetic vetted facts exercise real candidates independently of bundled draft ratings.
const ratings = weaponRatingsSchema.parse({ version: 1,
  metadata: { confidence: "high", verifiedAt: "2026-10-07", sandboxVersion: "independent-synthetic", sources: ["Independent acceptance fixture"], notes: [] },
  roles: { "ability-loop": { mode: "pve", description: "Ability support" }, "pvp-niche": { mode: "pvp", description: "PvP support" } },
  perks: { Strong: { "ability-loop": 10, "pvp-niche": 10 }, Weak: { "ability-loop": 2, "pvp-niche": 2 }, Duelist: { "ability-loop": 1, "pvp-niche": 15 } }, pairs: [] });
const perk = (name: string, extra: Partial<OwnedPerk> = {}): OwnedPerk => ({ hash: Object.keys(ratings.perks).indexOf(name) + 100,
  name, description: "", category: "trait", known: true, enabled: true, canInsert: true, ...extra });
function weapon(id: string, name = "Weak", extra: Partial<OwnedItem> = {}): OwnedItem {
  const selected = perk(name);
  return { id, instanceId: id, itemHash: 731, name: "Independent Rifle", description: "", known: true, type: "weapon", typeName: "Auto Rifle",
    classType: null, characterId: null, location: "vault", locationLabel: "Vault", equipped: false, locked: false, masterworked: false,
    crafted: false, enhanced: false, exotic: false, quantity: 1, slot: "Energy", ammoType: "Primary", damageType: "Arc",
    power: name === "Strong" ? 2001 : 2000, tier: "Legendary", stats: { range: 50, stability: 50 },
    selectedPerks: [selected], availablePerks: [], sockets: [{ index: 0, visible: true, selected, available: [] }], sourceStatus: "common", ...extra };
}
const copies = () => [weapon("best", "Strong"), weapon("target"), weapon("same-roll")];
const account = (items: OwnedItem[]): InventorySnapshot => ({ schemaVersion: 1, importedAt: "independent", profileTimestamp: "independent",
  manifestVersion: "independent", characters: [], unknownHashes: [], items });
const evaluate = (items: OwnedItem[], config = defaultCleanupConfig, selectedRatings = ratings) => {
  const snapshot = account(items); return analyzeCleanup(snapshot, analyzeWeapons(snapshot, selectedRatings), undefined, config);
};
const target = (result: ReturnType<typeof evaluate>, id = "target") => result.items.find((item) => item.itemId === id)!;
function armor(id: string, value: number, extra: Partial<OwnedItem> = {}): OwnedItem {
  return weapon(id, "Weak", { itemHash: 831, type: "armor", typeName: "Chest Armor", classType: "Titan", slot: "Chest",
    ammoType: null, damageType: null, selectedPerks: [], availablePerks: [], sockets: [], power: value > 10 ? 2001 : 2000,
    stats: Object.fromEntries(defaultCleanupConfig.armorStatHashes.map((axis) => [axis, value])), armorStatsExact: true,
    armorSet: null, armorSetBonus: null, gearTier: "Tier 3", currentSetBonusNeeded: false, ...extra });
}

describe("independent Phase 6 acceptance", () => {
  it("has nonempty explained candidates with confidence and retained, strictly better owned links", () => {
    const result = evaluate(copies());
    expect(result.counts).toEqual({ PROTECTED: 1, KEEP: 0, REVIEW: 0, DISMANTLE_CANDIDATE: 2 });
    const byId = new Map(result.items.map((item) => [item.itemId, item]));
    for (const item of result.items.filter((item) => item.classification === "DISMANTLE_CANDIDATE")) {
      expect(item.reasons.length).toBeGreaterThan(0); expect(item.unknowns).toEqual([]); expect(item.protectionReasons).toEqual([]);
      expect(item.confidence).toBeGreaterThanOrEqual(result.threshold); expect(item.confidence).toBeLessThanOrEqual(100);
      expect(item.betterOwnedAlternatives.map((alternative) => alternative.itemId)).toEqual(["best"]);
      for (const alternative of item.betterOwnedAlternatives) {
        expect(alternative.itemHash).toBe(item.itemHash); expect(alternative.reasons.length).toBeGreaterThan(0);
        expect(byId.get(alternative.itemId)?.classification).not.toBe("DISMANTLE_CANDIDATE");
      }
    }
    const text = formatCleanupAnalysis(result);
    expect(text).toContain("DISMANTLE_CANDIDATE"); expect(text).toContain("[best]"); expect(text).not.toContain("SAFE_TO_DELETE");
  });

  it.each<[string, Partial<OwnedItem>, string]>([
    ["equipped", { equipped: true }, "equipped"], ["locked", { locked: true }, "Locked"],
    ["DIM Favorite", { dim: { tag: "Favorite" } }, "DIM"], ["DIM Keep", { dim: { tag: "Keep" } }, "DIM"],
    ["DIM Archive", { dim: { tag: "Archive" } }, "DIM"], ["case insensitive DIM", { dim: { tag: " favorite " } }, "DIM"],
    ["highest slot Power", { power: 2002 }, "Highest relevant Power"], ["crafted", { crafted: true }, "Crafted"],
    ["enhanced", { enhanced: true }, "Enhanced"], ["masterworked investment", { masterworked: true }, "Masterworked"],
    ["rare source", { sourceStatus: "rare" }, "source"], ["unobtainable source", { sourceStatus: "unobtainable" }, "source"],
    ["legacy source", { sourceStatus: "legacy" }, "source"], ["high value niche", { highValueNiche: true }, "niche"],
  ])("protects %s even when contextual alternatives exist", (_label, changes, reason) => {
    const items = copies(); Object.assign(items[1]!, changes);
    const item = target(evaluate(items, cleanupConfigSchema.parse({ threshold: 85, decisions: { target: "review" } })));
    expect(item.classification).toBe("PROTECTED"); expect(item.protectionReasons.join(" ")).toContain(reason);
  });

  it("protects saved local builds and current recommended loadouts", async () => {
    const saved = target(evaluate(copies(), cleanupConfigSchema.parse({ savedBuilds: [{ id: "my-build", itemIds: ["target"] }] })));
    expect(saved.classification).toBe("PROTECTED"); expect(saved.buildsAffected).toEqual(["my-build"]);
    const snapshot = account(copies()), config = await loadBuildConfig();
    const weapons = analyzeWeapons(snapshot, ratings), builds = analyzeBuilds(snapshot, config.templates, config.preferences, config, weapons);
    builds.builds[0]!.recommendedItemIds = ["target"];
    const recommended = target(analyzeCleanup(snapshot, weapons, builds));
    expect(recommended.classification).toBe("PROTECTED"); expect(recommended.buildsAffected).toContain(builds.builds[0]!.id);
  });

  it("protects only owned exotic and family copies while excluding zero quantity copies", () => {
    const item = weapon("target", "Weak", { exotic: true }), absent = weapon("absent", "Weak", { exotic: true, quantity: 0 });
    const result = evaluate([item, absent, weapon("different-hash", "Strong", { itemHash: 732, exotic: true })]);
    expect(target(result).classification).toBe("PROTECTED"); expect(result.items.some((copy) => copy.itemId === "absent")).toBe(false);
    expect(target(result).protectionReasons.join(" ")).toContain("Only owned copy of this exotic");
    expect(target(result).familyItemIds).toEqual(["target"]);
    expect(target(evaluate([weapon("target"), weapon("other", "Strong", { itemHash: 999 })])).protectionReasons.join(" ")).toContain("Only owned copy of this exact");
  });

  it("preserves unique perk combinations, alternate options and useful PvP role representatives", () => {
    const unique = evaluate(copies().filter((copy) => copy.id !== "same-roll"));
    expect(target(unique).classification).toBe("PROTECTED"); expect(target(unique).uniqueThings).toContain("Unique selected perk combination");
    const options = copies(); options[1]!.availablePerks = [perk("Duelist")]; options[1]!.sockets[0]!.available = options[1]!.availablePerks;
    expect(target(evaluate(options)).classification).toBe("PROTECTED"); expect(target(evaluate(options)).protectionReasons.join(" ")).toContain("Unique available");
    const niche = evaluate([...copies(), weapon("duelist", "Duelist")]);
    expect(target(niche, "duelist").classification).toBe("PROTECTED"); expect(target(niche, "duelist").protectionReasons.join(" ")).toContain("pvp-niche");
  });

  it.each<[string, Partial<OwnedItem>]>([
    ["unknown item", { known: false }], ["missing stats", { stats: null }], ["missing power", { power: null }],
    ["missing source", { sourceStatus: "unknown" }], ["missing instance", { instanceId: null }],
    ["missing slot", { slot: null }], ["missing tier", { tier: null }],
  ])("keeps %s out of candidates and exposes uncertainty for review", (_name, changes) => {
    const items = copies(); Object.assign(items[1]!, changes);
    const item = target(evaluate(items)); expect(item.classification).toBe("REVIEW"); expect(item.unknowns.length).toBeGreaterThan(0);
    expect(item.reasons.length).toBeGreaterThan(0);
  });

  it("draft, undated and explicitly provisional comparisons cannot authorize cleanup", () => {
    for (const metadata of [{ ...ratings.metadata, confidence: "draft" as const }, { ...ratings.metadata, verifiedAt: null }]) {
      expect(target(evaluate(copies(), defaultCleanupConfig, { ...ratings, metadata })).classification).toBe("REVIEW");
    }
    const snapshot = account(copies()), weapons = analyzeWeapons(snapshot, ratings);
    for (const family of weapons.families) for (const comparison of family.comparisons) comparison.provisional = true;
    expect(target(analyzeCleanup(snapshot, weapons)).classification).toBe("REVIEW");
    const stale = analyzeWeapons(snapshot, ratings); stale.manifestVersion = "other-manifest";
    expect(target(analyzeCleanup(snapshot, stale)).classification).toBe("REVIEW");
  });

  it("requires trustworthy retained alternatives and prevents circular or chain removal", () => {
    const items = copies(); delete items[0]!.sourceStatus;
    expect(evaluate(items).counts.DISMANTLE_CANDIDATE).toBe(0);
    const chain = evaluate([armor("highest", 30, { power: 2002 }), armor("middle", 20), armor("lowest", 10)]);
    expect(chain.counts.DISMANTLE_CANDIDATE).toBe(2);
    for (const candidate of chain.items.filter((item) => item.classification === "DISMANTLE_CANDIDATE")) {
      expect(candidate.betterOwnedAlternatives.map((alternative) => alternative.itemId)).toEqual(["highest"]);
    }
  });

  it("supports protect/keep/review decisions and stricter thresholds while retaining hard protection", () => {
    for (const [decision, classification] of [["protect", "PROTECTED"], ["keep", "KEEP"], ["review", "REVIEW"]] as const) {
      expect(target(evaluate(copies(), cleanupConfigSchema.parse({ decisions: { target: decision } }))).classification).toBe(classification);
    }
    expect(target(evaluate(copies(), cleanupConfigSchema.parse({ threshold: 96 }))).classification).toBe("REVIEW");
    expect(cleanupConfigSchema.safeParse({ threshold: 84 }).success).toBe(false);
    const items = copies(); items[1]!.locked = true;
    expect(target(evaluate(items, cleanupConfigSchema.parse({ decisions: { target: "keep" } }))).classification).toBe("PROTECTED");
  });

  it("treats explicit local evidence conservatively and never overwrites protective facts", () => {
    const items = copies(); delete items[1]!.sourceStatus;
    expect(target(evaluate(items)).classification).toBe("REVIEW");
    expect(target(evaluate(items, cleanupConfigSchema.parse({ itemFacts: { target: { sourceStatus: "common" } } }))).classification).toBe("DISMANTLE_CANDIDATE");
    items[1]!.sourceStatus = "legacy";
    expect(target(evaluate(items, cleanupConfigSchema.parse({ itemFacts: { target: { sourceStatus: "common" } } }))).classification).toBe("PROTECTED");
  });

  it("uses all six armor components and preserves stat tradeoffs instead of comparing totals", () => {
    const worse = armor("target", 10), better = armor("best", 20);
    expect(target(evaluate([worse, better])).classification).toBe("DISMANTLE_CANDIDATE");
    const tradeoff = armor("best", 10, { power: 2001 }); tradeoff.stats![defaultCleanupConfig.armorStatHashes[0]!] = 60; tradeoff.stats![defaultCleanupConfig.armorStatHashes[1]!] = 9;
    expect(Object.values(tradeoff.stats!).reduce((a, b) => a + b, 0)).toBeGreaterThan(Object.values(worse.stats!).reduce((a, b) => a + b, 0));
    expect(target(evaluate([worse, tradeoff])).classification).toBe("KEEP");
    const equal = armor("best", 10, { power: 2001 }); expect(target(evaluate([worse, equal])).classification).toBe("KEEP");
  });

  it.each<[string, Partial<OwnedItem>]>([
    ["class", { classType: "Hunter" }], ["slot", { slot: "Helmet" }], ["exotic status", { exotic: true }],
    ["set", { armorSet: "Other", currentSetBonusNeeded: false }], ["set bonus", { armorSetBonus: "Other bonus" }],
    ["gear tier", { gearTier: "Tier 5" }],
  ])("does not substitute armor with a different %s", (_name, difference) => {
    expect(evaluate([armor("target", 10), armor("best", 20, difference)]).counts.DISMANTLE_CANDIDATE).toBe(0);
  });

  it("protects current set pieces and the highest Power item for each armor class", () => {
    const set = evaluate([armor("target", 10, { armorSet: "Needed", armorSetBonus: "2-piece", currentSetBonusNeeded: true }), armor("best", 20)]);
    expect(target(set).classification).toBe("PROTECTED"); expect(target(set).protectionReasons.join(" ")).toContain("set bonus");
    const powers = evaluate([armor("target", 10, { power: 2001 }), armor("titan-copy", 20, { power: 2000 }), armor("hunter", 20, { power: 2010, classType: "Hunter" })]);
    expect(target(powers).classification).toBe("PROTECTED"); expect(target(powers).protectionReasons.join(" ")).toContain("Highest relevant Power");
  });

  it.each<[string, Record<string, unknown>]>([
    ["exact flag", { armorStatsExact: false }], ["missing stats", { stats: null }], ["missing set", { armorSet: undefined }],
    ["missing tier", { gearTier: undefined }],
  ])("reviews armor with %s uncertainty", (_name, changes) => {
    // Assign undefined after construction to model an old normalized export without metadata.
    const items = [armor("target", 10), armor("best", 20)]; Object.assign(items[0]!, changes);
    expect(target(evaluate(items)).classification).toBe("REVIEW");
  });

  it("reviews incomplete armor axes and unresolved or unsupported selected effects", () => {
    const items = [armor("target", 10), armor("best", 20)]; delete items[0]!.stats![defaultCleanupConfig.armorStatHashes[0]!];
    expect(target(evaluate(items)).classification).toBe("REVIEW");
    for (const known of [false, true]) {
      const copies = [armor("target", 10), armor("best", 20)], selected = perk("Weak", { known });
      for (const item of copies) { item.selectedPerks = [selected]; item.sockets = known ? [] : [{ index: 0, visible: true, selected, available: [] }]; }
      expect(target(evaluate(copies)).classification).toBe("REVIEW");
    }
  });

  it("does not infer permanent armor superiority from differing non-gameplay socket plugs", () => {
    const copies = [armor("target", 10), armor("best", 20)];
    for (const [index, item] of copies.entries()) {
      // Normalization preserves stat/mod plugs in sockets while excluding them from selectedPerks.
      const selected = perk("Armor configuration", { hash: 900 + index, category: "stat.armor" });
      item.sockets = [{ index: 0, visible: true, selected, available: [] }];
    }
    expect(target(evaluate(copies)).classification).toBe("REVIEW");
    expect(target(evaluate(copies)).unknowns.join(" ")).toContain("socket");
  });

  it("only permits clearly redundant masterwork with a fully evaluated equally invested replacement", () => {
    expect(target(evaluate([armor("target", 10, { masterworked: true }), armor("best", 20, { masterworked: true })])).classification).toBe("DISMANTLE_CANDIDATE");
    expect(target(evaluate([armor("target", 10, { masterworked: true }), armor("best", 20)])).classification).toBe("PROTECTED");
  });

  it("is deterministic under reordered inventory and preserves input snapshots", () => {
    const items = copies(), before = structuredClone(items), forward = evaluate(items);
    expect(evaluate(items.slice().reverse())).toEqual(forward); expect(items).toEqual(before);
    expect(Object.values(forward.counts).reduce((a, b) => a + b, 0)).toBe(forward.items.length);
  });

  it.skipIf(!existsSync("profile-data.json") || !existsSync("data/manifest"))("conservatively analyzes every real equipment instance without inventing candidates", async () => {
    const snapshot = await loadAnalysisSnapshot("profile-data.json", true), draft = await loadWeaponRatings(), config = await loadBuildConfig();
    const weapons = analyzeWeapons(snapshot, draft), builds = analyzeBuilds(snapshot, config.templates, config.preferences, config, weapons);
    const result = analyzeCleanup(snapshot, weapons, builds);
    expect(result.items.length).toBe(snapshot.items.filter((item) => item.quantity > 0 && (["weapon", "armor"].includes(item.type) || !item.known)).length);
    expect(result.counts.DISMANTLE_CANDIDATE).toBe(0);
    for (const item of result.items) {
      expect(item.reasons.length).toBeGreaterThan(0);
      const owned = snapshot.items.find((copy) => copy.id === item.itemId)!;
      if (owned.locked || owned.equipped) expect(item.classification).toBe("PROTECTED");
      if (item.classification === "REVIEW") expect(item.unknowns.length).toBeGreaterThan(0);
    }
  }, 15000);
});
