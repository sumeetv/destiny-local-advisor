import { describe, expect, it } from "vitest";
import { normalizeInventory } from "../src/inventory.js";
import { parseProfile } from "../src/profile.js";
import { csvCell, inventoryCsv } from "../src/exports.js";
import { filterInventory, sortInventory } from "../web/search.js";

const profile = parseProfile({
  responseMintedTimestamp: "2026-10-08T00:21:11.345Z",
  characters: { data: { titan: { classType: 0 }, hunter: { classType: 1 } } },
  profileInventory: { data: { items: [
    { itemHash: 1, itemInstanceId: "6917529629599222829", bucketHash: 138197802, state: 41 },
    { itemHash: 99, quantity: 100, bucketHash: 1469714392 },
  ] } },
  characterEquipment: { data: { titan: { items: [{ itemHash: 2, itemInstanceId: "armor", state: 5 }] } } },
  characterInventories: { data: { titan: { items: [{ itemHash: 1, itemInstanceId: "mail", bucketHash: 215593132 }] } } },
  itemComponents: {
    instances: { data: { "6917529629599222829": { primaryStat: { statHash: 1480404414, value: 325 }, damageType: 2 } } },
    sockets: { data: { "6917529629599222829": { sockets: [
      { plugHash: 10, isVisible: true, isEnabled: true },
      { plugHash: 12, isVisible: true, isEnabled: true },
      { plugHash: 15, isVisible: true, isEnabled: false },
    ] } } },
    reusablePlugs: { data: { "6917529629599222829": { plugs: {
      "0": [{ plugItemHash: 10, canInsert: true }, { plugItemHash: 11, canInsert: true }, { plugItemHash: 13, canInsert: false }],
      "4": [{ plugItemHash: 14, canInsert: true }],
    } } } },
  },
});

const definitions = {
  "1": { hash: 1, itemType: 3, classType: 3, displayProperties: { name: 'Test "Rifle", Mk II' }, itemTypeDisplayName: "Auto Rifle", inventory: { bucketTypeHash: 1498876634, tierType: 5 }, equippingBlock: { ammoType: 1 } },
  "2": { hash: 2, itemType: 2, classType: 0, displayProperties: { name: "Synthoceps" }, inventory: { bucketTypeHash: 3551918588, tierType: 6 } },
  "10": { hash: 10, displayProperties: { name: "Demolitionist" }, plug: { plugCategoryIdentifier: "frames" } },
  "11": { hash: 11, displayProperties: { name: "Voltshot" }, plug: { plugCategoryIdentifier: "frames" } },
  "12": { hash: 12, displayProperties: { name: "Voltshot Shader" }, plug: { plugCategoryIdentifier: "shader" } },
  "13": { hash: 13, displayProperties: { name: "Unavailable perk" }, plug: { plugCategoryIdentifier: "frames" } },
  "15": { hash: 15, displayProperties: { name: "Inactive perk" }, plug: { plugCategoryIdentifier: "frames" } },
};

describe("normalized inventory", () => {
  it("preserves instance identity, locations, state flags, socket indexes, and missing stats", () => {
    const snapshot = normalizeInventory(profile, definitions, "fixture");
    expect(snapshot.items).toHaveLength(4);
    expect(snapshot.items[0]).toMatchObject({
      instanceId: "6917529629599222829", location: "vault", slot: "Kinetic", damageType: "Arc",
      power: 325, locked: true, crafted: true, enhanced: true, masterworked: false, stats: null,
    });
    expect(snapshot.items.find((item) => item.instanceId === "armor")).toMatchObject({
      type: "armor", classType: "Titan", equipped: true, locked: true, masterworked: true, slot: "Gauntlets",
    });
    expect(snapshot.items.find((item) => item.instanceId === "mail")).toMatchObject({ location: "postmaster", locationLabel: "Titan · Postmaster" });
    expect(snapshot.items.find((item) => item.itemHash === 99)).toMatchObject({ known: false, location: "shared", quantity: 100 });
    expect(snapshot.unknownHashes).toEqual([14, 99]);
    expect(snapshot.items[0]?.sockets.map((socket) => socket.index)).toEqual([0, 1, 2, 4]);
    expect(snapshot.items[0]?.sockets[3]?.selected).toBeNull();
  });

  it("searches selected and insertable perks, excludes cosmetics, and supports combined filters", () => {
    const items = normalizeInventory(profile, definitions, "fixture").items;
    expect(filterInventory(items, { query: "demolitionist" }).map((item) => item.instanceId)).toEqual(["6917529629599222829"]);
    expect(filterInventory(items, { query: "Voltshot" })).toHaveLength(1);
    expect(filterInventory(items, { query: "Voltshot", perkScope: "selected" })).toHaveLength(0);
    expect(filterInventory(items, { query: "Unavailable perk" })).toHaveLength(0);
    expect(filterInventory(items, { query: "Inactive perk" })).toHaveLength(0);
    expect(filterInventory(items, { query: "rifle demolitionist", location: "vault", locked: true })).toHaveLength(1);
    expect(filterInventory(items, { type: "armor", classType: "Titan", location: "titan" })).toHaveLength(1);
    expect(filterInventory(items, { query: "nothing matches" })).toHaveLength(0);
    expect(sortInventory(items, "power")[0]?.power).toBe(325);
  });

  it("exports escaped CSV with distinct perk columns and neutralizes spreadsheet formulas", () => {
    const csv = inventoryCsv(normalizeInventory(profile, definitions, "fixture").items.filter((item) => item.type === "weapon"));
    expect(csv).toContain('"Test ""Rifle"", Mk II"');
    expect(csv).toContain("Selected perks,Available perks");
    expect(csv).toContain("Demolitionist,Demolitionist | Voltshot | Unknown plug (14)");
    expect(csv).toContain("6917529629599222829");
    expect(csvCell("=HYPERLINK(\"bad\")")).toBe('"\'=HYPERLINK(""bad"")"');
    expect(csvCell("a\nb")).toBe('"a\nb"');
  });

  it("accepts the API response envelope and keeps reported instance stats without using definition defaults", () => {
    const wrapped = parseProfile({ Response: {
      ...profile,
      itemComponents: { ...profile.itemComponents, stats: { data: { armor: { stats: { "392767087": { statHash: 392767087, value: 25 } } } } } },
    } });
    const snapshot = normalizeInventory(wrapped, definitions, "fixture");
    expect(snapshot.items.find((item) => item.instanceId === "armor")?.stats).toEqual({ "392767087": 25 });
  });
});
