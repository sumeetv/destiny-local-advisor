import { readFile } from "node:fs/promises";
import { randomBytes, timingSafeEqual } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import type { BungieConfig } from "./config.js";
import { withLocalLock, writePrivateJson } from "./storage.js";

const TOKEN_URL = "https://www.bungie.net/platform/app/oauth/token/";
const tokenReply = z.object({
  access_token: z.string().min(1), token_type: z.literal("Bearer"), expires_in: z.number().positive(),
  refresh_token: z.string().min(1).optional(), refresh_expires_in: z.number().positive().optional(),
  membership_id: z.string().regex(/^\d+$/),
});
const savedToken = z.object({
  clientId: z.string(), accessToken: z.string().min(1), accessExpiresAt: z.number(),
  refreshToken: z.string().nullable(), refreshExpiresAt: z.number().nullable(), bungieMembershipId: z.string(),
});
type SavedToken = z.infer<typeof savedToken>;

export class BungieAuth {
  private pending = new Map<string, number>();
  private tokenPath: string;

  constructor(readonly config: BungieConfig, private fetcher: typeof fetch = fetch, private now: () => number = Date.now) {
    this.tokenPath = path.join(config.dataDirectory, "auth", "bungie.json");
  }

  begin(): { url: string; state: string } {
    for (const [state, expires] of this.pending) if (expires <= this.now()) this.pending.delete(state);
    if (this.pending.size >= 20) throw new Error("Too many pending Bungie sign-ins. Wait a few minutes before retrying.");
    const state = randomBytes(32).toString("hex");
    this.pending.set(state, this.now() + 10 * 60_000);
    const url = new URL("https://www.bungie.net/en/oauth/authorize");
    url.search = new URLSearchParams({ client_id: this.config.clientId, response_type: "code", state, redirect_uri: this.config.redirectUri }).toString();
    // Bungie scopes are configured in its application portal, never in this URL.
    return { url: url.href, state };
  }

  async finish(state: string | null, cookieState: string | null, code: string | null): Promise<void> {
    const expires = state ? this.pending.get(state) : undefined;
    const actual = Buffer.from(state ?? "");
    const expected = Buffer.from(cookieState ?? "");
    if (!state || !cookieState || !expires || expires <= this.now() ||
        actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      throw new Error("Bungie sign-in state is invalid or expired. Start a new sign-in from the local browser.");
    }
    this.pending.delete(state);
    if (!code) throw new Error("Bungie sign-in was not completed. Start a new sign-in.");
    await withLocalLock(path.join(this.config.dataDirectory, "auth", "token.lock"), async () => {
      await this.exchange({ grant_type: "authorization_code", code, redirect_uri: this.config.redirectUri });
    });
  }

  private async read(): Promise<SavedToken | null> {
    let text: string;
    try { text = await readFile(this.tokenPath, "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw new Error("Cannot read saved Bungie authentication. Check local credential file permissions.");
    }
    let value: SavedToken;
    try { value = savedToken.parse(JSON.parse(text)); }
    catch { throw new Error("Saved Bungie authentication is invalid. Reconnect from the local browser."); }
    if (value.clientId !== this.config.clientId) return null;
    return value;
  }

  async status(): Promise<{ connected: boolean; canRefresh: boolean }> {
    const value = await this.read();
    if (!value) return { connected: false, canRefresh: false };
    const canRefresh = Boolean(value.refreshToken && value.refreshExpiresAt && value.refreshExpiresAt > this.now());
    return { connected: value.accessExpiresAt > this.now() || canRefresh, canRefresh };
  }

  async accessToken(forceRefresh = false): Promise<string> {
    return withLocalLock(path.join(this.config.dataDirectory, "auth", "token.lock"), async () => {
      const current = await this.read();
      if (!current) throw new Error("Bungie is not connected. Run pnpm destiny auth or connect from the local inventory browser.");
      if (!forceRefresh && current.accessExpiresAt > this.now() + 60_000) return current.accessToken;
      if (!current.refreshToken || !current.refreshExpiresAt || current.refreshExpiresAt <= this.now()) {
        if (!forceRefresh && current.accessExpiresAt > this.now()) return current.accessToken;
        throw new Error("Bungie authentication has expired. Reconnect from the local browser.");
      }
      return (await this.exchange({ grant_type: "refresh_token", refresh_token: current.refreshToken }, current)).accessToken;
    });
  }

  private async exchange(parameters: Record<string, string>, previous?: SavedToken): Promise<SavedToken> {
    const startedAt = this.now();
    let response: Response;
    try {
      response = await this.fetcher(TOKEN_URL, {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(30_000),
        headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "destiny-local-advisor/0.1" },
        body: new URLSearchParams({ ...parameters, client_id: this.config.clientId, client_secret: this.config.clientSecret }),
      });
    } catch { throw new Error("Bungie token request failed. Check network access and retry sign-in."); }
    if (!response.ok) throw new Error(`Bungie token request was rejected (HTTP ${response.status}). Check app configuration or reconnect. Token response details were withheld.`);
    let reply: z.infer<typeof tokenReply>;
    try { reply = tokenReply.parse(await response.json()); }
    catch { throw new Error("Bungie returned an invalid token response. Reconnect from the local browser."); }
    const value: SavedToken = {
      clientId: this.config.clientId, accessToken: reply.access_token, accessExpiresAt: startedAt + reply.expires_in * 1000,
      refreshToken: reply.refresh_token ?? previous?.refreshToken ?? null,
      refreshExpiresAt: reply.refresh_expires_in ? startedAt + reply.refresh_expires_in * 1000 : previous?.refreshExpiresAt ?? null,
      bungieMembershipId: reply.membership_id,
    };
    await writePrivateJson(this.tokenPath, value);
    return value;
  }
}
