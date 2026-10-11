import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BungieSync } from "../src/bungie/sync.js";
import { PROFILE_COMPONENTS } from "../src/bungie/client.js";
import type { BungieConfig } from "../src/bungie/config.js";
import { parseProfile } from "../src/profile.js";
import { normalizeInventory } from "../src/inventory.js";
import { withLocalLock } from "../src/bungie/storage.js";

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function config(): Promise<BungieConfig> {
  const directory = await mkdtemp(path.join(tmpdir(), "destiny-sync-test-"));
  directories.push(directory);
  return { apiKey: "TEST-API-KEY", clientId: "12345", clientSecret: "TEST-CLIENT-SECRET", redirectUri: "https://127.0.0.1:3000/api/auth/bungie/callback", dataDirectory: directory, tlsCert: null, tlsKey: null, membershipId: null, membershipType: null };
}

const profile = {
  characters: { data: { titan: { classType: 0 } } },
  profileInventory: { data: { items: [{ itemHash: 1, itemInstanceId: "weapon", bucketHash: 138197802 }] } },
  characterInventories: { data: { titan: { items: [] } } },
  characterEquipment: { data: { titan: { items: [] } } },
  itemComponents: { instances: { data: { weapon: { primaryStat: { statHash: 1480404414, value: 300 } } } }, sockets: { data: { weapon: { sockets: [{ plugHash: 2 }] } } } },
};
const definitions = {
  "1": { hash: 1, itemType: 3, displayProperties: { name: "Test weapon" }, sockets: { socketEntries: [{}] } },
  "2": { hash: 2, displayProperties: { name: "Demolitionist" } },
};
const manifest = async () => ({ definitions, version: "fixture" });

async function signIn(sync: BungieSync) {
  const pending = sync.auth.begin();
  await sync.auth.finish(pending.state, pending.state, "TEST-AUTH-CODE");
}

function token(access = "TEST-ACCESS-TOKEN", refresh = "TEST-REFRESH-TOKEN") {
  return { access_token: access, refresh_token: refresh, token_type: "Bearer", expires_in: 3600, refresh_expires_in: 7776000, membership_id: "9000" };
}

describe("Bungie synchronization", () => {
  it("uses read-only bulk requests, retries a 401 with a refreshed token, and retains immutable raw snapshots", async () => {
    const cfg = await config();
    const output = path.join(cfg.dataDirectory, "output");
    const raw = JSON.stringify({ ErrorCode: 1, Response: profile }, null, 2);
    let membershipAttempts = 0;
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url, init) => {
      if (String(url).includes("/oauth/token/")) {
        const refresh = (init?.body as URLSearchParams).get("grant_type") === "refresh_token";
        return Response.json(refresh ? token("ROTATED-ACCESS", "ROTATED-REFRESH") : token());
      }
      if (String(url).includes("GetMembershipsForCurrentUser")) {
        if (++membershipAttempts === 1) return new Response(null, { status: 401 });
        return Response.json({ ErrorCode: 1, Response: { destinyMemberships: [{ membershipId: "300", membershipType: 3 }], primaryMembershipId: "300" } });
      }
      return new Response(raw);
    });
    const sync = new BungieSync(cfg, output, fetcher, manifest);
    await signIn(sync);
    const first = await sync.sync();
    const second = await new BungieSync(cfg, output, fetcher, manifest).sync();
    expect(first).toMatchObject({ characters: 1, items: 1, weapons: 1, armor: 0, unknownHashes: [] });
    expect(first.rawSnapshot).not.toBe(second.rawSnapshot);
    expect(await readFile(first.rawSnapshot, "utf8")).toBe(raw);
    expect(await readFile(second.rawSnapshot, "utf8")).toBe(raw);
    expect((await stat(first.rawSnapshot)).mode & 0o777).toBe(0o600);
    expect(await readdir(path.join(cfg.dataDirectory, "snapshots"))).toHaveLength(2);
    const inventory = JSON.parse(await readFile(path.join(output, "inventory.json"), "utf8"));
    expect(inventory.items).toEqual(normalizeInventory(parseProfile(profile), definitions, "fixture").items);
    expect(inventory.source.rawSnapshot).toBe(path.basename(second.rawSnapshot));
    const apiCalls = fetcher.mock.calls.filter(([url]) => !String(url).includes("/oauth/token/"));
    expect(apiCalls.every(([, init]) => init?.method === "GET")).toBe(true);
    expect(apiCalls.every(([url]) => /GetMembershipsForCurrentUser|\/Profile\//.test(String(url)))).toBe(true);
    const profileCall = apiCalls.find(([url]) => String(url).includes("/Profile/"))!;
    expect(new URL(String(profileCall[0])).searchParams.get("components")?.split(",")).toEqual([...PROFILE_COMPONENTS]);
    expect(profileCall[1]?.headers).toMatchObject({ "X-API-Key": cfg.apiKey, Authorization: "Bearer ROTATED-ACCESS" });
    expect(await readFile(path.join(output, "weapons.csv"), "utf8")).toContain("Demolitionist");
  });

  it("retains a partial response before validation and leaves previous exports intact", async () => {
    const cfg = await config();
    const output = path.join(cfg.dataDirectory, "output");
    let current = profile as unknown;
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url) => {
      if (String(url).includes("/oauth/token/")) return Response.json(token());
      if (String(url).includes("GetMembershipsForCurrentUser")) return Response.json({ ErrorCode: 1, Response: { destinyMemberships: [{ membershipId: "300", membershipType: 3 }] } });
      return Response.json({ ErrorCode: 1, Response: current });
    });
    const sync = new BungieSync(cfg, output, fetcher, manifest);
    await signIn(sync);
    await sync.sync();
    const previous = await readFile(path.join(output, "inventory.json"), "utf8");
    current = { ...profile, profileInventory: { data: null } };
    await expect(sync.sync()).rejects.toThrow("incomplete or private inventory");
    expect(await readFile(path.join(output, "inventory.json"), "utf8")).toBe(previous);
    expect(await readdir(path.join(cfg.dataDirectory, "snapshots"))).toHaveLength(2);
    current = { ...profile, itemComponents: {} };
    await expect(sync.sync()).rejects.toThrow("omitted gear instance or socket");
    expect(await readFile(path.join(output, "inventory.json"), "utf8")).toBe(previous);
    expect(await readdir(path.join(cfg.dataDirectory, "snapshots"))).toHaveLength(3);
  });

  it("does not surface or log Bungie error bodies containing credentials", async () => {
    const cfg = await config();
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url) => String(url).includes("/oauth/token/") ?
      Response.json(token()) : Response.json({ ErrorCode: 99, Message: "TEST-API-KEY TEST-ACCESS-TOKEN TEST-CLIENT-SECRET", MessageData: { secret: "TEST-REFRESH-TOKEN" } }));
    const log = vi.spyOn(console, "log");
    const errorLog = vi.spyOn(console, "error");
    const sync = new BungieSync(cfg, path.join(cfg.dataDirectory, "output"), fetcher, manifest);
    await signIn(sync);
    const error = await sync.sync().catch((value: Error) => value);
    expect(String(error)).toContain("code 99");
    expect(String(error)).not.toMatch(/TEST-API-KEY|TEST-ACCESS-TOKEN|TEST-CLIENT-SECRET|TEST-REFRESH-TOKEN/);
    expect(log).not.toHaveBeenCalled();
    expect(errorLog).not.toHaveBeenCalled();
  });

  it("rejects concurrent writers and releases the lock even after an operation fails", async () => {
    const cfg = await config();
    const lock = path.join(cfg.dataDirectory, "sync.lock");
    await withLocalLock(lock, async () => {
      await expect(withLocalLock(lock, async () => "second")).rejects.toThrow("in progress");
    });
    await expect(withLocalLock(lock, async () => { throw new Error("failure"); })).rejects.toThrow("failure");
    expect(await withLocalLock(lock, async () => "released")).toBe("released");
  });
});
