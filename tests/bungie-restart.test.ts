import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const run = promisify(execFile);

it("retains authentication and rotated refresh credentials across separate Node processes", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "destiny-process-restart-test-"));
  const config = {
    apiKey: "RESTART-API-KEY", clientId: "12345", clientSecret: "RESTART-CLIENT-SECRET",
    redirectUri: "https://127.0.0.1:3000/api/auth/bungie/callback", dataDirectory: directory,
    tlsCert: null, tlsKey: null, membershipId: null, membershipType: null,
  };
  const script = `
    import { BungieAuth } from "./src/bungie/auth.ts";
    const stage = process.env.RESTART_STAGE;
    const config = JSON.parse(process.env.RESTART_CONFIG);
    const now = stage === "sign-in" ? 1000000 : 4600001;
    let requests = 0;
    const fetcher = async (_url, init) => {
      requests++;
      const body = init.body;
      if (stage === "reuse") throw new Error("Unexpected token request after restart");
      if (stage === "refresh" && (body.get("grant_type") !== "refresh_token" || body.get("refresh_token") !== "RESTART-REFRESH-OLD")) {
        throw new Error("Restart did not reuse persisted refresh credentials");
      }
      return Response.json({
        access_token: stage === "sign-in" ? "RESTART-ACCESS-OLD" : "RESTART-ACCESS-NEW",
        refresh_token: stage === "sign-in" ? "RESTART-REFRESH-OLD" : "RESTART-REFRESH-NEW",
        token_type: "Bearer", expires_in: 3600, refresh_expires_in: 7776000, membership_id: "9000",
      });
    };
    const auth = new BungieAuth(config, fetcher, () => now);
    if (stage === "sign-in") {
      const pending = auth.begin();
      await auth.finish(pending.state, pending.state, "RESTART-AUTH-CODE");
    } else {
      if ((await auth.accessToken()) !== "RESTART-ACCESS-NEW") throw new Error("Persisted access credential mismatch");
    }
    console.log(JSON.stringify({ status: await auth.status(), requests }));
  `;
  try {
    for (const stage of ["sign-in", "refresh", "reuse"]) {
      const { stdout, stderr } = await run(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
        cwd: process.cwd(), env: { ...process.env, RESTART_STAGE: stage, RESTART_CONFIG: JSON.stringify(config) }, timeout: 10_000,
      });
      expect(stderr).toBe("");
      expect(stdout).not.toMatch(/RESTART-(?:ACCESS|REFRESH|API|CLIENT|AUTH)/);
      expect(JSON.parse(stdout)).toEqual({ status: { connected: true, canRefresh: true }, requests: stage === "reuse" ? 0 : 1 });
    }
    const saved = JSON.parse(await readFile(path.join(directory, "auth/bungie.json"), "utf8"));
    expect(saved.refreshToken).toBe("RESTART-REFRESH-NEW");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 20_000);
