import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BungieAuth } from "../src/bungie/auth.js";
import { readBungieConfig, type BungieConfig } from "../src/bungie/config.js";
import { selectMembership } from "../src/bungie/client.js";

const directories: string[] = [];
export async function testConfig(): Promise<BungieConfig> {
  const directory = await mkdtemp(path.join(tmpdir(), "destiny-auth-test-"));
  directories.push(directory);
  return {
    apiKey: "TEST-API-KEY", clientId: "12345", clientSecret: "TEST-CLIENT-SECRET",
    redirectUri: "https://127.0.0.1:3000/api/auth/bungie/callback", dataDirectory: directory,
    tlsCert: null, tlsKey: null, membershipId: null, membershipType: null,
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

const token = (access: string, refresh: string) => ({
  access_token: access, refresh_token: refresh, token_type: "Bearer", expires_in: 3600,
  refresh_expires_in: 7776000, membership_id: "9000",
});

describe("Bungie OAuth", () => {
  it("validates random, cookie-bound, one-use state and persists credentials privately across restart", async () => {
    const config = await testConfig();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(token("ACCESS-SECRET", "REFRESH-SECRET")));
    const auth = new BungieAuth(config, fetcher);
    const pending = auth.begin();
    expect(auth.begin().state).not.toBe(pending.state);
    const url = new URL(pending.url);
    expect(url.origin).toBe("https://www.bungie.net");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.has("scope")).toBe(false);
    await expect(auth.finish(pending.state, "wrong-cookie", "AUTH-CODE")).rejects.toThrow("state");
    expect(fetcher).not.toHaveBeenCalled();
    await auth.finish(pending.state, pending.state, "AUTH-CODE");
    await expect(auth.finish(pending.state, pending.state, "AUTH-CODE")).rejects.toThrow("state");
    const params = fetcher.mock.calls[0]?.[1];
    expect(params?.method).toBe("POST");
    expect(params?.redirect).toBe("error");
    const body = params?.body as URLSearchParams;
    expect(body.get("client_secret")).toBe(config.clientSecret);
    expect(body.get("scope")).toBeNull();
    expect((await stat(path.join(config.dataDirectory, "auth/bungie.json"))).mode & 0o777).toBe(0o600);
    expect((await stat(path.join(config.dataDirectory, "auth"))).mode & 0o777).toBe(0o700);
    const restarted = new BungieAuth(config, fetcher);
    expect(await restarted.status()).toEqual({ connected: true, canRefresh: true });
    expect(await restarted.accessToken()).toBe("ACCESS-SECRET");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(await restarted.status())).not.toContain("SECRET");
  });

  it("refreshes an expired access token after restart and persists rotated refresh tokens", async () => {
    const config = await testConfig();
    let now = 1_000_000;
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(token("ACCESS-OLD", "REFRESH-OLD")))
      .mockResolvedValueOnce(Response.json(token("ACCESS-NEW", "REFRESH-NEW")));
    const auth = new BungieAuth(config, fetcher, () => now);
    const pending = auth.begin();
    await auth.finish(pending.state, pending.state, "AUTH-CODE");
    now += 3_600_000;
    const restarted = new BungieAuth(config, fetcher, () => now);
    expect(await restarted.accessToken()).toBe("ACCESS-NEW");
    const body = fetcher.mock.calls[1]?.[1]?.body as URLSearchParams;
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("refresh_token")).toBe("REFRESH-OLD");
    const saved = JSON.parse(await readFile(path.join(config.dataDirectory, "auth/bungie.json"), "utf8"));
    expect(saved.refreshToken).toBe("REFRESH-NEW");
    expect(saved.accessExpiresAt).toBeGreaterThan(now);
    now += 7776000 * 1000 + 1;
    expect(await restarted.status()).toEqual({ connected: false, canRefresh: false });
    await expect(restarted.accessToken()).rejects.toThrow("expired");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("expires OAuth state without making a token request", async () => {
    const config = await testConfig();
    let now = 1;
    const fetcher = vi.fn<typeof fetch>();
    const auth = new BungieAuth(config, fetcher, () => now);
    const pending = auth.begin();
    now += 600_001;
    await expect(auth.finish(pending.state, pending.state, "AUTH-CODE")).rejects.toThrow("expired");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("withholds token bodies and network error details from surfaced errors and logs", async () => {
    const config = await testConfig();
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ error_description: "ACCESS-SECRET REFRESH-SECRET TEST-CLIENT-SECRET AUTH-CODE" }, { status: 400 }))
      .mockRejectedValueOnce(new Error("TEST-CLIENT-SECRET exposed in a transport error"));
    const logs = [vi.spyOn(console, "log"), vi.spyOn(console, "error"), vi.spyOn(console, "warn")];
    const auth = new BungieAuth(config, fetcher);
    for (const expected of ["HTTP 400", "token request failed"]) {
      const pending = auth.begin();
      const error = await auth.finish(pending.state, pending.state, "AUTH-CODE").catch((value: Error) => value);
      expect(String(error)).toContain(expected);
      expect(String(error)).not.toMatch(/ACCESS-SECRET|REFRESH-SECRET|TEST-CLIENT-SECRET|AUTH-CODE/);
    }
    expect(logs.flatMap((log) => log.mock.calls)).toHaveLength(0);
  });
});

describe("configuration and membership selection", () => {
  it("requires localhost HTTPS and reports missing configuration without echoing values", () => {
    expect(readBungieConfig({})).toBeNull();
    expect(() => readBungieConfig({ BUNGIE_API_KEY: "PRIVATE-VALUE" })).toThrow("BUNGIE_CLIENT_ID");
    expect(() => readBungieConfig({
      BUNGIE_API_KEY: "PRIVATE-VALUE", BUNGIE_CLIENT_ID: "12345", BUNGIE_CLIENT_SECRET: "SECRET",
      BUNGIE_REDIRECT_URI: "https://example.com/api/auth/bungie/callback",
    })).toThrow("127.0.0.1");
  });

  it("selects primary or cross-save membership and requires explicit choice for ambiguity", () => {
    const noChoice = { membershipId: null, membershipType: null };
    const one = { membershipId: "100", membershipType: 1, crossSaveOverride: 3 };
    const three = { membershipId: "300", membershipType: 3, crossSaveOverride: 3 };
    expect(selectMembership({ destinyMemberships: [one, three], primaryMembershipId: "300" }, noChoice)).toEqual(three);
    expect(selectMembership({ destinyMemberships: [one, three] }, noChoice)).toEqual(three);
    expect(selectMembership({ destinyMemberships: [one] }, noChoice)).toEqual(one);
    expect(() => selectMembership({ destinyMemberships: [{ ...one, crossSaveOverride: 0 }, { ...three, crossSaveOverride: 0 }] }, noChoice)).toThrow("Multiple");
    expect(() => selectMembership({ destinyMemberships: [one] }, { membershipId: "900", membershipType: 1 })).toThrow("does not belong");
  });
});
