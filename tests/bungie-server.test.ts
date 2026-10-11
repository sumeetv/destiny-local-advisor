import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { request as httpRequest } from "node:http";
import { expect, it, vi } from "vitest";
import { createInventoryServer } from "../src/server.js";
import { BungieSync } from "../src/bungie/sync.js";

it("protects browser OAuth and refresh routes, binds callbacks to the initiating cookie, and hides credentials", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "destiny-oauth-http-test-"));
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({
    access_token: "PRIVATE-ACCESS", refresh_token: "PRIVATE-REFRESH", token_type: "Bearer",
    expires_in: 3600, refresh_expires_in: 7776000, membership_id: "9000",
  }));
  const service = new BungieSync({
    apiKey: "PRIVATE-API-KEY", clientSecret: "PRIVATE-CLIENT-SECRET", clientId: "12345",
    redirectUri: "https://127.0.0.1:3000/api/auth/bungie/callback", dataDirectory: directory,
    tlsCert: null, tlsKey: null, membershipId: null, membershipType: null,
  }, path.join(directory, "output"), fetcher);
  const server = createInventoryServer(path.join(directory, "output"), { bungie: service });
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const post = (route: string, origin = base, localHeader = true) => fetch(`${base}${route}`, {
      method: "POST", headers: { Origin: origin, ...(localHeader ? { "X-Local-Request": "1" } : {}) },
    });
    expect(await (await fetch(`${base}/api/auth/status`)).json()).toMatchObject({ connected: false });
    expect((await post("/api/auth/bungie/start", "https://evil.example")).status).toBe(403);
    expect((await post("/api/auth/bungie/start", base, false)).status).toBe(403);
    expect((await fetch(`${base}/api/sync`)).status).toBe(405);
    // Node fetch replaces Host; use a raw HTTP request to exercise this guard.
    const maliciousHostStatus = await new Promise<number>((resolve, reject) => {
      httpRequest(base, { headers: { Host: "evil.example" } }, (response) => {
        response.resume(); resolve(response.statusCode!);
      }).on("error", reject).end();
    });
    expect(maliciousHostStatus).toBe(403);
    const started = await post("/api/auth/bungie/start");
    const cookie = started.headers.get("set-cookie")!.split(";")[0]!;
    expect(started.headers.get("set-cookie")).toContain("HttpOnly");
    expect(started.headers.get("set-cookie")).toContain("SameSite=Lax");
    const authorization = new URL((await started.json()).authorizationUrl);
    expect(authorization.searchParams.has("scope")).toBe(false);
    const state = authorization.searchParams.get("state")!;
    const callback = `${base}/api/auth/bungie/callback?code=PRIVATE-CODE&state=${state}`;
    expect((await fetch(callback, { redirect: "manual" })).status).toBe(400);
    expect(fetcher).not.toHaveBeenCalled();
    const completed = await fetch(callback, { headers: { Cookie: cookie }, redirect: "manual" });
    expect(completed.status).toBe(303);
    expect(completed.headers.get("location")).toBe("/");
    expect(completed.headers.get("referrer-policy")).toBe("no-referrer");
    expect((await fetch(callback, { headers: { Cookie: cookie }, redirect: "manual" })).status).toBe(400);
    const status = await (await fetch(`${base}/api/auth/status`)).text();
    expect(JSON.parse(status)).toMatchObject({ configured: true, connected: true });
    expect(status).not.toContain("PRIVATE-");
    expect((await fetch(`${base}/data/auth/bungie.json`)).status).toBe(404);
    expect((await post("/api/sync", "https://evil.example")).status).toBe(403);
    const sync = vi.spyOn(service, "sync").mockResolvedValue({ rawSnapshot: "snapshot.json", characters: 3, items: 923, weapons: 422, armor: 244, unknownHashes: [] });
    expect(await (await post("/api/sync")).json()).toMatchObject({ items: 923 });
    expect(sync).toHaveBeenCalledTimes(1);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
