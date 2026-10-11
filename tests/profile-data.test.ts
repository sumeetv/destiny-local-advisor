import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { loadItemManifest } from "../src/manifest.js";
import { parseProfile } from "../src/profile.js";
import { normalizeInventory } from "../src/inventory.js";
import { filterInventory } from "../web/search.js";
import { BungieSync } from "../src/bungie/sync.js";

// The private profile and downloaded definitions stay local. Run after an import.
it.skipIf(!existsSync("profile-data.json") || !existsSync("data/manifest"))(
  "finds the Phase 2 acceptance items and perks in the supplied account export",
  async () => {
    const { definitions, version } = await loadItemManifest(path.resolve("data/manifest"), true);
    const profile = parseProfile(JSON.parse(await readFile("profile-data.json", "utf8")));
    const snapshot = normalizeInventory(profile, definitions, version);
    expect(new Set(snapshot.items.map((item) => item.id)).size).toBe(snapshot.items.length);
    for (const query of ["Witherhoard", "Synthoceps", "Heart of Inmost Light", "Demolitionist", "Voltshot"]) {
      expect(filterInventory(snapshot.items, { query }), `No owned gear found for ${query}`).not.toHaveLength(0);
    }
    const demolitionist = filterInventory(snapshot.items, { query: "Demolitionist", perkScope: "selected" });
    expect(demolitionist.length).toBeGreaterThan(0);
    expect(demolitionist.every((item) => item.selectedPerks.some((perk) => /demolitionist/i.test(perk.name)))).toBe(true);
  },
  15000,
);

it.skipIf(!existsSync("profile-data.json") || !existsSync("data/manifest"))(
  "normalizes a mocked authenticated GetProfile response identically to the real manual export",
  async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "destiny-real-profile-sync-test-"));
    try {
      const cached = await loadItemManifest(path.resolve("data/manifest"), true);
      const rawProfile = await readFile("profile-data.json", "utf8");
      const rawResponse = `{"ErrorCode":1,"Response":${rawProfile}}`;
      const fetcher: typeof fetch = async (url) => {
        if (String(url).includes("/oauth/token/")) return Response.json({ access_token: "FIXTURE-ACCESS", refresh_token: "FIXTURE-REFRESH", token_type: "Bearer", expires_in: 3600, refresh_expires_in: 7776000, membership_id: "9000" });
        if (String(url).includes("GetMembershipsForCurrentUser")) return Response.json({ ErrorCode: 1, Response: { destinyMemberships: [{ membershipId: "300", membershipType: 3 }] } });
        return new Response(rawResponse);
      };
      const output = path.join(directory, "output");
      const config = { apiKey: "FIXTURE-KEY", clientId: "12345", clientSecret: "FIXTURE-SECRET", redirectUri: "https://127.0.0.1:3000/api/auth/bungie/callback", dataDirectory: directory, tlsCert: null, tlsKey: null, membershipId: null, membershipType: null };
      const sync = new BungieSync(config, output, fetcher, async () => cached);
      const auth = sync.auth.begin();
      await sync.auth.finish(auth.state, auth.state, "FIXTURE-CODE");
      const result = await new BungieSync(config, output, fetcher, async () => cached).sync();
      const actual = JSON.parse(await readFile(path.join(output, "inventory.json"), "utf8"));
      const expected = normalizeInventory(parseProfile(JSON.parse(rawProfile)), cached.definitions, cached.version);
      expect(actual.items).toEqual(expected.items);
      expect(actual.characters).toEqual(expected.characters);
      expect(actual.unknownHashes).toEqual(expected.unknownHashes);
      expect(result.items).toBe(expected.items.length);
      expect(await readFile(result.rawSnapshot, "utf8")).toBe(rawResponse);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
  20000,
);
