import { describe, expect, it } from "vitest";
import { summarizeProfile } from "../src/import-profile.js";
import { parseProfile } from "../src/profile.js";

describe("profile import", () => {
  it("joins items, characters, sockets, and reusable plugs", () => {
    const profile = parseProfile({
      profileInventory: { data: { items: [{ itemHash: 10, itemInstanceId: "weapon" }] } },
      characters: { data: { titan: { classType: 0 }, hunter: { classType: 1 } } },
      characterInventories: { data: { titan: { items: [{ itemHash: 20, itemInstanceId: "armor" }] } } },
      characterEquipment: { data: { titan: { items: [] } } },
      itemComponents: {
        instances: { data: { weapon: {}, armor: {} } },
        sockets: { data: { weapon: { sockets: [{ plugHash: 30 }] } } },
        reusablePlugs: { data: { weapon: { plugs: { "0": [{ plugItemHash: 40 }] } } } },
      },
    });
    const result = summarizeProfile(profile, {
      "10": { hash: 10, itemType: 3, displayProperties: { name: "Weapon" } },
      "20": { hash: 20, itemType: 2, classType: 0, displayProperties: { name: "Titan Armor" } },
      "30": { hash: 30, displayProperties: { name: "Perk" } },
    });

    expect(result).toMatchObject({
      characters: 2,
      vaultItems: 1,
      titanItems: 1,
      weapons: 1,
      armor: 1,
      namedInstancedWeapons: 1,
      namedTitanArmor: 1,
      socketPlugs: 2,
      resolvedSocketPlugs: 1,
      unknownHashes: [40],
    });
  });
});
