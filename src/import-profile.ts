import type { ItemDefinition } from "./manifest.js";
import type { Profile, ProfileItem } from "./profile.js";

const TITAN = 0;
const ARMOR = 2;
const WEAPON = 3;

interface LocatedItem {
  item: ProfileItem;
  characterId?: string;
  location: "vault" | "inventory" | "equipment";
}

export interface ImportSummary {
  characters: number;
  vaultItems: number;
  titanItems: number;
  weapons: number;
  armor: number;
  instancedWeapons: number;
  namedInstancedWeapons: number;
  titanArmor: number;
  namedTitanArmor: number;
  socketPlugs: number;
  resolvedSocketPlugs: number;
  unknownHashes: number[];
}

function definitionFor(definitions: Record<string, ItemDefinition>, hash: number) {
  return definitions[String(hash)];
}

export function summarizeProfile(profile: Profile, definitions: Record<string, ItemDefinition>): ImportSummary {
  const characters = profile.characters?.data ?? {};
  const located: LocatedItem[] = [];

  for (const item of profile.profileInventory?.data?.items ?? []) located.push({ item, location: "vault" });
  for (const [characterId, component] of Object.entries(profile.characterInventories?.data ?? {})) {
    for (const item of component.items) located.push({ item, characterId, location: "inventory" });
  }
  for (const [characterId, component] of Object.entries(profile.characterEquipment?.data ?? {})) {
    for (const item of component.items) located.push({ item, characterId, location: "equipment" });
  }

  const unknown = new Set<number>();
  const items = located.map((entry) => {
    const definition = definitionFor(definitions, entry.item.itemHash);
    if (!definition) unknown.add(entry.item.itemHash);
    return { ...entry, definition };
  });
  const weapons = items.filter(({ definition }) => definition?.itemType === WEAPON);
  const armor = items.filter(({ definition }) => definition?.itemType === ARMOR);
  const instancedWeapons = weapons.filter(({ item }) => item.itemInstanceId);
  const titanCharacterIds = new Set(Object.entries(characters)
    .filter(([, character]) => character.classType === TITAN)
    .map(([id]) => id));
  const titanItems = items.filter(({ characterId }) => characterId && titanCharacterIds.has(characterId));
  const titanArmor = armor.filter(({ definition }) => definition?.classType === TITAN);

  const plugHashes: number[] = [];
  for (const component of Object.values(profile.itemComponents.sockets?.data ?? {})) {
    for (const socket of component.sockets) if (socket.plugHash) plugHashes.push(socket.plugHash);
  }
  for (const component of Object.values(profile.itemComponents.reusablePlugs?.data ?? {})) {
    for (const plugs of Object.values(component.plugs)) {
      for (const plug of plugs) plugHashes.push(plug.plugItemHash);
    }
  }
  for (const hash of plugHashes) if (!definitionFor(definitions, hash)) unknown.add(hash);

  return {
    characters: Object.keys(characters).length,
    vaultItems: items.filter(({ location }) => location === "vault").length,
    titanItems: titanItems.length,
    weapons: weapons.length,
    armor: armor.length,
    instancedWeapons: instancedWeapons.length,
    namedInstancedWeapons: instancedWeapons.filter(({ definition }) => Boolean(definition?.displayProperties?.name)).length,
    titanArmor: titanArmor.length,
    namedTitanArmor: titanArmor.filter(({ definition }) => Boolean(definition?.displayProperties?.name)).length,
    socketPlugs: plugHashes.length,
    resolvedSocketPlugs: plugHashes.filter((hash) => Boolean(definitionFor(definitions, hash))).length,
    unknownHashes: [...unknown].sort((a, b) => a - b),
  };
}
