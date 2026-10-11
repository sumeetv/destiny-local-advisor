import type { ItemDefinition } from "./manifest.js";
import type { Profile, ProfileItem } from "./profile.js";

const CLASS_NAMES = ["Titan", "Hunter", "Warlock"] as const;
const SLOT_NAMES: Record<number, string> = {
  1498876634: "Kinetic", 2465295065: "Energy", 953998645: "Power",
  3448274439: "Helmet", 3551918588: "Gauntlets", 14239492: "Chest",
  20886954: "Legs", 1585787867: "Class item",
};
const AMMO_NAMES: Record<number, string> = { 1: "Primary", 2: "Special", 3: "Heavy" };
const DAMAGE_NAMES: Record<number, string> = {
  1: "Kinetic", 2: "Arc", 3: "Solar", 4: "Void", 5: "Raid", 6: "Stasis", 7: "Strand",
};
const VAULT_BUCKET = 138197802;
const POSTMASTER_BUCKET = 215593132;

export interface OwnedPerk {
  hash: number;
  name: string;
  description: string;
  category: string | null;
  known: boolean;
  enabled: boolean | null;
  canInsert: boolean | null;
}

export interface OwnedSocket {
  index: number;
  visible: boolean | null;
  selected: OwnedPerk | null;
  available: OwnedPerk[];
}

export interface OwnedItem {
  id: string;
  instanceId: string | null;
  itemHash: number;
  name: string;
  description: string;
  known: boolean;
  type: "weapon" | "armor" | "currency" | "other";
  typeName: string;
  classType: string | null;
  characterId: string | null;
  location: "vault" | "titan" | "hunter" | "warlock" | "postmaster" | "shared" | "other";
  locationLabel: string;
  equipped: boolean;
  locked: boolean;
  masterworked: boolean;
  crafted: boolean;
  enhanced: boolean;
  exotic: boolean;
  quantity: number;
  slot: string | null;
  ammoType: string | null;
  damageType: string | null;
  power: number | null;
  tier: string | null;
  stats: Record<string, number> | null;
  sockets: OwnedSocket[];
  selectedPerks: OwnedPerk[];
  availablePerks: OwnedPerk[];
  /** Optional local/imported evidence. Absent facts remain unknown for cleanup. */
  dim?: { tag?: string; notes?: string };
  sourceStatus?: "common" | "reacquirable" | "rare" | "unobtainable" | "legacy" | "unknown";
  armorSet?: string | null;
  armorSetBonus?: string | null;
  gearTier?: string | null;
  armorStatsExact?: boolean;
  currentSetBonusNeeded?: boolean;
  highValueNiche?: boolean;
}

export interface InventorySnapshot {
  schemaVersion: 1;
  importedAt: string;
  profileTimestamp: string | null;
  manifestVersion: string;
  characters: { id: string; classType: string }[];
  unknownHashes: number[];
  items: OwnedItem[];
  /** Positive evidence only; an absent capability means unknown, never locked/unavailable. */
  subclassCapabilities?: { characterId: string; classType: string; subclass: string; abilities: string[]; evidence: "owned-subclass-sockets" }[];
  source?: { kind: "bungie"; rawSnapshot: string; membershipId: string; membershipType: number };
  /** Immutable normalized history; committed with inventory.json after successful ingestion. */
  history?: { current: string; previous: string | null };
  inventoryCoverage?: "complete" | "partial";
}

/** Keep cosmetics and tracking plugs in sockets, but out of the perk search. */
function isGameplayPerk(perk: OwnedPerk): boolean {
  const category = perk.category ?? "";
  return Boolean(perk.name) && !/^(Empty|Default|Locked)\b/i.test(perk.name) &&
    !/(shader|skin|ornament|tracker|masterwork|infusion|memento|unlock|artifice|stat\.armor)/i.test(category);
}

export function normalizeInventory(profile: Profile, definitions: Record<string, ItemDefinition>, manifestVersion: string): InventorySnapshot {
  const unknown = new Set<number>();
  const resolve = (hash: number) => {
    const definition = definitions[String(hash)];
    if (!definition) unknown.add(hash);
    return definition;
  };
  const perk = (hash: number, enabled: boolean | undefined, canInsert: boolean | undefined): OwnedPerk => {
    const definition = resolve(hash);
    return {
      hash, name: definition?.displayProperties?.name ?? `Unknown plug (${hash})`,
      description: definition?.displayProperties?.description ?? "",
      category: definition?.plug?.plugCategoryIdentifier ?? null,
      known: Boolean(definition), enabled: enabled ?? null, canInsert: canInsert ?? null,
    };
  };
  const items: OwnedItem[] = [];
  const subclassCapabilities: NonNullable<InventorySnapshot["subclassCapabilities"]> = [];
  const add = (raw: ProfileItem, characterId: string | null, equipped: boolean) => {
    const definition = resolve(raw.itemHash);
    const instanceId = raw.itemInstanceId ?? null;
    const instance = instanceId ? profile.itemComponents.instances?.data?.[instanceId] : undefined;
    const selected = instanceId ? profile.itemComponents.sockets?.data?.[instanceId]?.sockets ?? [] : [];
    const reusable = instanceId ? profile.itemComponents.reusablePlugs?.data?.[instanceId]?.plugs ?? {} : {};
    const indexes = new Set([...selected.keys(), ...Object.keys(reusable).map(Number)]);
    const sockets = [...indexes].sort((a, b) => a - b).map((index): OwnedSocket => ({
      index, visible: selected[index]?.isVisible ?? null,
      selected: selected[index]?.plugHash ? perk(selected[index]!.plugHash!, selected[index]?.isEnabled, undefined) : null,
      available: (reusable[String(index)] ?? []).map((plug) => perk(plug.plugItemHash, plug.enabled, plug.canInsert)),
    }));
    const unique = (perks: OwnedPerk[]) => [...new Map(perks.map((value) => [value.hash, value])).values()];
    const className = characterId ? CLASS_NAMES[profile.characters?.data?.[characterId]?.classType ?? -1] : undefined;
    const postmaster = raw.location === 4 || raw.bucketHash === POSTMASTER_BUCKET;
    const vault = !characterId && raw.bucketHash === VAULT_BUCKET;
    const location: OwnedItem["location"] = postmaster ? "postmaster" : vault ? "vault" :
      characterId ? (className?.toLowerCase() as "titan" | "hunter" | "warlock" | undefined) ?? "other" : "shared";
    const type = definition?.itemType === 3 ? "weapon" : definition?.itemType === 2 ? "armor" : definition?.itemType === 1 ? "currency" : "other";
    const stats = instanceId ? profile.itemComponents.stats?.data?.[instanceId]?.stats : undefined;
    const state = raw.state ?? 0;
    const bucket = definition?.equippingBlock?.equipmentSlotTypeHash ?? definition?.inventory?.bucketTypeHash;
    const owned: OwnedItem = {
      id: instanceId ?? `${characterId ?? "account"}:${raw.bucketHash ?? "unknown"}:${raw.itemHash}:${items.length}`,
      instanceId, itemHash: raw.itemHash,
      name: definition?.displayProperties?.name || `Unknown item (${raw.itemHash})`,
      description: definition?.displayProperties?.description ?? "", known: Boolean(definition),
      type, typeName: definition?.itemTypeDisplayName ?? type,
      classType: CLASS_NAMES[definition?.classType ?? -1] ?? null, characterId, location,
      locationLabel: postmaster ? `${className ?? "Character"} · Postmaster` : vault ? "Vault" : className ?? (characterId ? "Character" : "Shared inventory"),
      equipped, locked: Boolean(state & 1), masterworked: Boolean(state & 4), crafted: Boolean(state & 8), enhanced: Boolean(state & 32),
      exotic: definition?.inventory?.tierType === 6, quantity: raw.quantity ?? 1,
      slot: bucket ? SLOT_NAMES[bucket] ?? `Bucket ${bucket}` : null,
      ammoType: type === "weapon" ? AMMO_NAMES[definition?.equippingBlock?.ammoType ?? 0] ?? null : null,
      damageType: type === "weapon" ? DAMAGE_NAMES[instance?.damageType ?? definition?.defaultDamageType ?? 0] ?? null : null,
      power: type === "weapon" || type === "armor" ? instance?.primaryStat?.value ?? null : null,
      tier: definition?.inventory?.tierTypeName ?? null,
      stats: stats ? Object.fromEntries(Object.entries(stats).map(([hash, stat]) => [hash, stat.value])) : null,
      sockets,
      selectedPerks: unique(sockets.filter((socket) => socket.visible !== false && socket.selected?.enabled !== false)
        .flatMap((socket) => socket.selected && isGameplayPerk(socket.selected) ? [socket.selected] : [])),
      availablePerks: unique(sockets.flatMap((socket) => socket.available.filter((plug) => plug.canInsert !== false && isGameplayPerk(plug)))),
    };
    items.push(owned);
    // Item possession and selected/explicitly insertable sockets are account evidence.
    // A manifest definition alone is not evidence of an unlock.
    const titanSubclasses: Record<string, string> = { Sunbreaker: "Solar", Sentinel: "Void", Striker: "Arc", Behemoth: "Stasis", Berserker: "Strand", "Prismatic Titan": "Prismatic" };
    const subclass = titanSubclasses[owned.name];
    if (definition?.itemType === 16 && definition.classType === 0 && className === "Titan" && characterId && subclass) {
      const abilities = unique(sockets.flatMap((socket) => [
        ...(socket.visible !== false && socket.selected?.known && socket.selected.enabled !== false ? [socket.selected] : []),
        ...socket.available.filter((plug) => plug.known && plug.canInsert === true && plug.enabled !== false),
      ])).map((plug) => plug.name).sort();
      subclassCapabilities.push({ characterId, classType: "Titan", subclass, abilities, evidence: "owned-subclass-sockets" });
    }
  };

  for (const item of profile.profileInventory?.data?.items ?? []) add(item, null, false);
  for (const [characterId, component] of Object.entries(profile.characterInventories?.data ?? {})) {
    for (const item of component.items) add(item, characterId, false);
  }
  for (const [characterId, component] of Object.entries(profile.characterEquipment?.data ?? {})) {
    for (const item of component.items) add(item, characterId, true);
  }
  return {
    schemaVersion: 1, importedAt: new Date().toISOString(), profileTimestamp: profile.responseMintedTimestamp ?? null,
    manifestVersion, characters: Object.entries(profile.characters?.data ?? {}).map(([id, character]) => ({
      id, classType: CLASS_NAMES[character.classType] ?? "Unknown",
    })), unknownHashes: [...unknown].sort((a, b) => a - b), items, subclassCapabilities,
    inventoryCoverage: profile.profileInventory?.data && profile.characters?.data && Object.keys(profile.characters.data).length > 0 &&
      Object.keys(profile.characters.data).every((id) => profile.characterInventories?.data?.[id] && profile.characterEquipment?.data?.[id]) ? "complete" : "partial",
  };
}
