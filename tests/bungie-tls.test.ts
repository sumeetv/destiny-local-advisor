import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { request as httpsRequest } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { createInventoryServer } from "../src/server.js";
import { BungieSync } from "../src/bungie/sync.js";

it.skipIf(spawnSync("openssl", ["version"]).status !== 0)("serves OAuth over verified local TLS and sets a Secure state cookie", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "destiny-tls-test-"));
  const keyFile = path.join(directory, "key.pem");
  const certFile = path.join(directory, "cert.pem");
  const service = new BungieSync({
    apiKey: "TLS-TEST-KEY", clientSecret: "TLS-TEST-SECRET", clientId: "12345",
    redirectUri: "https://127.0.0.1:3000/api/auth/bungie/callback", dataDirectory: directory,
    tlsCert: certFile, tlsKey: keyFile, membershipId: null, membershipType: null,
  }, path.join(directory, "output"), async () => Response.json({
    access_token: "TLS-TEST-ACCESS", refresh_token: "TLS-TEST-REFRESH", token_type: "Bearer", expires_in: 3600, refresh_expires_in: 7776000, membership_id: "9000",
  }));
  let server: ReturnType<typeof createInventoryServer> | undefined;
  try {
    await promisify(execFile)("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", keyFile, "-out", certFile, "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1"]);
    const cert = await readFile(certFile);
    server = createInventoryServer(path.join(directory, "output"), { bungie: service, tls: { key: await readFile(keyFile), cert } });
    await new Promise<void>((resolve, reject) => { server!.once("error", reject); server!.listen(0, "127.0.0.1", resolve); });
    const base = `https://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const request = (route: string, method = "GET", headers: Record<string, string> = {}) =>
      new Promise<{ status: number; headers: import("node:http").IncomingHttpHeaders; text: string }>((resolve, reject) => {
        httpsRequest(`${base}${route}`, { ca: cert, method, headers }, (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => chunks.push(chunk));
          response.on("end", () => resolve({ status: response.statusCode!, headers: response.headers, text: Buffer.concat(chunks).toString("utf8") }));
        }).on("error", reject).end();
      });
    expect((await request("/")).status).toBe(200);
    expect((await request("/api/auth/bungie/start", "POST", { Origin: base.replace("https:", "http:"), "X-Local-Request": "1" })).status).toBe(403);
    const start = await request("/api/auth/bungie/start", "POST", { Origin: base, "X-Local-Request": "1" });
    expect(start.status).toBe(200);
    const cookie = start.headers["set-cookie"]![0]!;
    expect(cookie).toContain("Secure");
    const state = new URL(JSON.parse(start.text).authorizationUrl).searchParams.get("state");
    const callback = await request(`/api/auth/bungie/callback?state=${state}&code=TLS-TEST-CODE`, "GET", { Cookie: cookie.split(";")[0]! });
    expect(callback.status).toBe(303);
    expect(JSON.parse((await request("/api/auth/status")).text).connected).toBe(true);
  } finally {
    if (server) {
      server.closeAllConnections();
      if (server.listening) await new Promise<void>((resolve) => server!.close(() => resolve()));
    }
    await rm(directory, { recursive: true, force: true });
  }
}, 15000);
