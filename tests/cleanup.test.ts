import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { InventorySnapshot, OwnedItem, OwnedPerk } from "../src/inventory.js";
import { loadWeaponRatings, type WeaponRatings } from "../src/analysis/weapon-config.js";
import { analyzeWeapons } from "../src/analysis/weapons.js";
import { cleanupConfigSchema, defaultCleanupConfig } from "../src/analysis/cleanup-config.js";
import { analyzeCleanup, formatCleanupAnalysis, writeCleanupAnalysis } from "../src/analysis/cleanup.js";

const draft = await loadWeaponRatings();
const vetted = { ...draft, metadata: { ...draft.metadata, confidence: "high" as const, verifiedAt: "synthetic-verification" } };
const perk = (name: string): OwnedPerk => ({ hash: Object.keys(draft.perks).indexOf(name) + 100, name, description: "", category: "trait", known: true, enabled: true, canInsert: null });
function weapon(id: string, strong = false, extra: Partial<OwnedItem> = {}): OwnedItem {
  const selectedPerks = (strong ? ["Demolitionist", "Voltshot"] : ["Wellspring", "Feeding Frenzy"]).map(perk);
  return { id, instanceId: id, itemHash: 42, name: "Fixture Rifle", description: "", known: true,
    type: "weapon", typeName: "Auto Rifle", classType: null, characterId: null, location: "vault", locationLabel: "Vault", equipped: false, locked: false,
    crafted: false, enhanced: false, masterworked: false, exotic: false, quantity: 1, slot: "Energy", ammoType: "Primary", damageType: "Arc", power: strong ? 2001 : 2000,
    tier: "Legendary", stats: { range: 50, stability: 50 }, selectedPerks, availablePerks: [],
    sockets: selectedPerks.map((selected, index) => ({ index, selected, visible: true, available: [] })), sourceStatus: "common", ...extra };
}
const snapshot = (items: OwnedItem[]): InventorySnapshot => ({ schemaVersion: 1, importedAt: "fixture", profileTimestamp: null, manifestVersion: "fixture", characters: [], unknownHashes: [], items });
const analyze = (items: OwnedItem[], config = defaultCleanupConfig, ratings: WeaponRatings = vetted) => {
  const account = snapshot(items); return analyzeCleanup(account, analyzeWeapons(account, ratings), undefined, config);
};
const copies = () => [weapon("strong", true), weapon("weak-one"), weapon("weak-two")];
const armor = (id: string, amount: number, extra: Partial<OwnedItem> = {}): OwnedItem => weapon(id, false, {
  type: "armor", typeName: "Gauntlets", classType: "Titan", slot: "Gauntlets", ammoType: null, damageType: null,
  power: amount > 10 ? 2001 : 2000, selectedPerks: [], availablePerks: [], sockets: [],
  stats: Object.fromEntries(defaultCleanupConfig.armorStatHashes.map((axis) => [axis, amount])), armorStatsExact: true,
  armorSet: null, armorSetBonus: null, gearTier: "Tier 3", currentSetBonusNeeded: false, ...extra,
});

describe("conservative Phase 6 cleanup", () => {
  it("produces explained positive candidates with retained same-family better alternatives only from vetted comparisons", () => {
    const result = analyze(copies());
    expect(result.counts).toEqual({ PROTECTED: 1, KEEP: 0, REVIEW: 0, DISMANTLE_CANDIDATE: 2 });
    for (const item of result.items.filter((item) => item.classification === "DISMANTLE_CANDIDATE")) {
      expect(item.protectionReasons).toEqual([]); expect(item.unknowns).toEqual([]); expect(item.reasons.length).toBeGreaterThan(1);
      expect(item.betterOwnedAlternatives.map((copy) => copy.itemId)).toEqual(["strong"]);
    }
    expect(analyze(copies(), defaultCleanupConfig, draft).counts.DISMANTLE_CANDIDATE).toBe(0);
    expect(analyze(copies(), defaultCleanupConfig, draft).items.find((copy) => copy.itemId === "weak-one")!.classification).toBe("REVIEW");
  });
  it("preserves locks, equipped, DIM tags, crafting, enhancement, masterwork, legacy and local decisions", () => {
    for (const extra of [{ locked: true }, { equipped: true }, { dim: { tag: "Favorite" } }, { dim: { tag: "Keep" } }, { dim: { tag: "Archive" } },
      { crafted: true }, { enhanced: true }, { masterworked: true }, { sourceStatus: "legacy" as const }, { sourceStatus: "rare" as const }, { sourceStatus: "unobtainable" as const }, { highValueNiche: true }]) {
      const items = copies(); items[1] = { ...items[1]!, ...extra };
      expect(analyze(items).items.find((item) => item.itemId === "weak-one")!.classification).toBe("PROTECTED");
    }
    for (const [decision, classification] of [["protect", "PROTECTED"], ["keep", "KEEP"], ["review", "REVIEW"]] as const) {
      const config = cleanupConfigSchema.parse({ decisions: { "weak-one": decision } });
      expect(analyze(copies(), config).items.find((item) => item.itemId === "weak-one")!.classification).toBe(classification);
    }
  });
  it("blocks unknown source/data, even on the proposed better copy", () => {
    for (const id of ["strong", "weak-one"]) {
      const items = copies(); const item = items.find((copy) => copy.id === id)!; delete item.sourceStatus;
      const result = analyze(items);
      expect(result.items.find((copy) => copy.itemId === "weak-one")!.classification).toBe("REVIEW");
      expect(result.counts.DISMANTLE_CANDIDATE).toBe(id === "strong" ? 0 : 1);
    }
    const items = copies(); items[1]!.stats = null;
    expect(analyze(items).items.find((copy) => copy.itemId === "weak-one")!.classification).toBe("REVIEW");
  });
  it("compares armor by every exact distribution component and same class/slot/set/tier", () => {
    expect(analyze([armor("better", 20), armor("weak", 10)]).items.find((item) => item.itemId === "weak")!.classification).toBe("DISMANTLE_CANDIDATE");
    for (const extra of [{ classType: "Hunter" }, { slot: "Chest" }, { armorSet: "Different set", currentSetBonusNeeded: false }, { gearTier: "Tier 4" }, { stats: null }, { armorStatsExact: false }]) {
      expect(analyze([armor("better", 20), armor("weak", 10, extra)]).counts.DISMANTLE_CANDIDATE).toBe(0);
    }
    const tradeoff = armor("tradeoff", 10); tradeoff.stats![defaultCleanupConfig.armorStatHashes[0]!] = 30;
    expect(analyze([armor("better", 20), tradeoff]).counts.DISMANTLE_CANDIDATE).toBe(0);
    expect(analyze([armor("better", 20), armor("weak", 10, { currentSetBonusNeeded: true, armorSet: "Current set", armorSetBonus: "2-piece" })]).items.find((item) => item.itemId === "weak")!.classification).toBe("PROTECTED");
  });
  it("keeps unknown armor effects in review and masterwork unless proven equally invested replacement", () => {
    const first = armor("better", 20), second = armor("weak", 10), selected = { ...perk("Unknown armor effect"), known: false };
    for (const item of [first, second]) { item.selectedPerks = [selected]; item.sockets = [{ index: 0, visible: true, selected, available: [] }]; }
    expect(analyze([first, second]).items.find((item) => item.itemId === "weak")!.classification).toBe("REVIEW");
    expect(analyze([armor("better", 20, { masterworked: true }), armor("weak", 10, { masterworked: true })]).items.find((item) => item.itemId === "weak")!.classification).toBe("DISMANTLE_CANDIDATE");
    expect(analyze([armor("better", 20), armor("weak", 10, { masterworked: true })]).items.find((item) => item.itemId === "weak")!.classification).toBe("PROTECTED");
  });
  it("supports conservative thresholds and source facts without overriding known protective facts", () => {
    expect(analyze(copies(), cleanupConfigSchema.parse({ threshold: 96 })).counts.DISMANTLE_CANDIDATE).toBe(0);
    expect(cleanupConfigSchema.safeParse({ threshold: 84 }).success).toBe(false);
    const items = copies(); items[1]!.sourceStatus = "legacy";
    const config = cleanupConfigSchema.parse({ itemFacts: { "weak-one": { sourceStatus: "common", highValueNiche: false } } });
    expect(analyze(items, config).items.find((item) => item.itemId === "weak-one")!.classification).toBe("PROTECTED");
  });
  it("does not depend on inventory order and exports the same structured and written evidence", async () => {
    const result = analyze(copies()); expect(analyze(copies().reverse())).toEqual(result);
    const directory = await mkdtemp(path.join(os.tmpdir(), "destiny-cleanup-"));
    try {
      await writeCleanupAnalysis(result, directory);
      expect(JSON.parse(await readFile(path.join(directory, "cleanup.json"), "utf8"))).toEqual(result);
      expect(await readFile(path.join(directory, "cleanup.txt"), "utf8")).toBe(formatCleanupAnalysis(result));
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
