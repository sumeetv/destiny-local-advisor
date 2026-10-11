import path from "node:path";
import { BungieAuth } from "./auth.js";
import { BungieClient, selectMembership } from "./client.js";
import type { BungieConfig } from "./config.js";
import { retainRawSnapshot, withLocalLock } from "./storage.js";
import { loadItemManifest } from "../manifest.js";
import { parseProfile, type Profile } from "../profile.js";
import { normalizeInventory, type InventorySnapshot } from "../inventory.js";
import { writeInventoryExports } from "../exports.js";

export interface SyncResult {
  rawSnapshot: string;
  characters: number;
  items: number;
  weapons: number;
  armor: number;
  unknownHashes: number[];
}

function requireInventoryComponents(profile: Profile): void {
  if (!profile.characters?.data || !Object.keys(profile.characters.data).length ||
      !profile.profileInventory?.data || !profile.characterInventories?.data || !profile.characterEquipment?.data) {
    throw new Error("Bungie returned an incomplete or private inventory. Reconnect with ReadDestinyInventoryAndVault permission. The raw response was retained; existing exports were preserved.");
  }
  for (const id of Object.keys(profile.characters.data)) {
    if (!profile.characterInventories.data[id] || !profile.characterEquipment.data[id]) {
      throw new Error("Bungie did not return inventory and equipment for every character. The raw response was retained; existing exports were preserved.");
    }
  }
}

export class BungieSync {
  readonly auth: BungieAuth;
  readonly client: BungieClient;
  constructor(readonly config: BungieConfig, readonly outputDirectory: string,
    fetcher: typeof fetch = fetch, private manifestLoader = loadItemManifest) {
    this.auth = new BungieAuth(config, fetcher);
    this.client = new BungieClient(config, this.auth, fetcher);
  }

  async sync(): Promise<SyncResult> {
    return withLocalLock(path.join(this.config.dataDirectory, "sync.lock"), async () => {
      const membership = selectMembership(await this.client.memberships(), this.config);
      const { raw, response } = await this.client.profile(membership);
      const rawSnapshot = await retainRawSnapshot(path.join(this.config.dataDirectory, "snapshots"), raw);
      let profile: Profile;
      try { profile = parseProfile(response); }
      catch { throw new Error("The Bungie profile did not match the expected schema. The raw response was retained; existing exports were preserved."); }
      requireInventoryComponents(profile);
      const { definitions, version } = await this.manifestLoader(path.join(this.config.dataDirectory, "manifest"));
      const inventory: InventorySnapshot = normalizeInventory(profile, definitions, version);
      const gear = inventory.items.filter((item) => item.type === "weapon" || item.type === "armor");
      if (gear.some((item) => !item.instanceId || !profile.itemComponents.instances?.data?.[item.instanceId] ||
          ((definitions[String(item.itemHash)]?.sockets?.socketEntries?.length ?? 0) > 0 && !profile.itemComponents.sockets?.data?.[item.instanceId]))) {
        throw new Error("Bungie omitted gear instance or socket components. The raw response was retained; existing exports were preserved.");
      }
      inventory.source = { kind: "bungie", rawSnapshot: path.basename(rawSnapshot), membershipId: membership.membershipId, membershipType: membership.membershipType };
      await writeInventoryExports(inventory, this.outputDirectory);
      return {
        rawSnapshot, characters: inventory.characters.length, items: inventory.items.length,
        weapons: inventory.items.filter((item) => item.type === "weapon").length,
        armor: inventory.items.filter((item) => item.type === "armor").length, unknownHashes: inventory.unknownHashes,
      };
    });
  }
}
