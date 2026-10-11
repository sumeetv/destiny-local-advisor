import { z } from "zod";
import type { BungieAuth } from "./auth.js";
import type { BungieConfig } from "./config.js";

// Published DestinyComponentType names are accepted directly by GetProfile:
// https://bungie-net.github.io/multi/schema_Destiny-DestinyComponentType.html
export const PROFILE_COMPONENTS = [
  "Profiles", "ProfileInventories", "ProfileCurrencies", "ProfileProgression",
  "Characters", "CharacterInventories", "CharacterProgressions", "CharacterEquipment", "CharacterLoadouts",
  "ItemInstances", "ItemObjectives", "ItemPerks", "ItemStats", "ItemSockets", "ItemPlugStates", "ItemPlugObjectives", "ItemReusablePlugs",
  "Collectibles", "Records",
] as const;

const membershipSchema = z.object({
  membershipId: z.string().regex(/^\d+$/), membershipType: z.number().int().min(1).max(6),
  crossSaveOverride: z.number().int().optional(),
});
const membershipsSchema = z.object({
  destinyMemberships: z.array(membershipSchema), primaryMembershipId: z.string().nullable().optional(),
});
export type Membership = z.infer<typeof membershipSchema>;
export type MembershipData = z.infer<typeof membershipsSchema>;

export function selectMembership(data: MembershipData, config: Pick<BungieConfig, "membershipId" | "membershipType">): Membership {
  if (config.membershipId && config.membershipType) {
    const chosen = data.destinyMemberships.find((item) => item.membershipId === config.membershipId && item.membershipType === config.membershipType);
    if (!chosen) throw new Error("The configured Destiny membership does not belong to the authenticated Bungie account.");
    return chosen;
  }
  const primary = data.destinyMemberships.find((item) => item.membershipId === data.primaryMembershipId);
  if (primary) return primary;
  const active = data.destinyMemberships.filter((item) => item.crossSaveOverride && item.crossSaveOverride === item.membershipType);
  if (active.length === 1) return active[0]!;
  if (data.destinyMemberships.length === 1) return data.destinyMemberships[0]!;
  if (!data.destinyMemberships.length) throw new Error("No Destiny account was found for the authenticated Bungie user.");
  throw new Error("Multiple Destiny memberships found. Run pnpm destiny memberships, then set BUNGIE_MEMBERSHIP_ID and BUNGIE_MEMBERSHIP_TYPE in .env.local.");
}

export class BungieClient {
  constructor(private config: BungieConfig, private auth: BungieAuth, private fetcher: typeof fetch = fetch) {}

  private async get(endpoint: string): Promise<{ raw: string; response: unknown }> {
    let token = await this.auth.accessToken();
    for (let attempt = 0; attempt < 2; attempt++) {
      let result: Response;
      try {
        result = await this.fetcher(`https://www.bungie.net/Platform${endpoint}`, {
          method: "GET", redirect: "error", signal: AbortSignal.timeout(30_000),
          headers: { "X-API-Key": this.config.apiKey, Authorization: `Bearer ${token}`, "User-Agent": "destiny-local-advisor/0.1" },
        });
      } catch { throw new Error("Bungie API request failed. Check network access and retry."); }
      if (result.status === 401 && attempt === 0) { token = await this.auth.accessToken(true); continue; }
      if (!result.ok) throw new Error(`Bungie API request failed (HTTP ${result.status}). Check authorization, app permissions, or Bungie availability.`);
      let raw: string;
      let envelope: { ErrorCode?: unknown; Response?: unknown; ThrottleSeconds?: unknown };
      try { raw = await result.text(); envelope = JSON.parse(raw); }
      catch { throw new Error("Bungie API returned an invalid JSON response."); }
      if (!envelope || envelope.ErrorCode !== 1 || !envelope.Response) {
        // Do not log Bungie Message/MessageData, request headers, or response bodies.
        const code = typeof envelope?.ErrorCode === "number" ? envelope.ErrorCode : "unknown";
        throw new Error(`Bungie API rejected the request (code ${code}). Check app permissions or Bungie availability and retry.`);
      }
      return { raw, response: envelope.Response };
    }
    throw new Error("Bungie authorization was rejected. Reconnect from the local browser.");
  }

  async memberships(): Promise<MembershipData> {
    const { response } = await this.get("/User/GetMembershipsForCurrentUser/");
    const parsed = membershipsSchema.safeParse(response);
    if (!parsed.success) throw new Error("Bungie returned invalid Destiny membership data.");
    return parsed.data;
  }

  async profile(membership: Membership): Promise<{ raw: string; response: unknown }> {
    const valid = membershipSchema.safeParse(membership);
    if (!valid.success) throw new Error("Invalid Destiny membership selection.");
    return this.get(`/Destiny2/${membership.membershipType}/Profile/${membership.membershipId}/?components=${PROFILE_COMPONENTS.join(",")}`);
  }
}
