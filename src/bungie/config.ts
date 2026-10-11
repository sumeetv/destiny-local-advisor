import path from "node:path";

export interface BungieConfig {
  apiKey: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  dataDirectory: string;
  tlsCert: string | null;
  tlsKey: string | null;
  membershipId: string | null;
  membershipType: number | null;
}

export function readBungieConfig(env: NodeJS.ProcessEnv = process.env): BungieConfig | null {
  const required = ["BUNGIE_API_KEY", "BUNGIE_CLIENT_ID", "BUNGIE_CLIENT_SECRET", "BUNGIE_REDIRECT_URI"] as const;
  if (!required.some((key) => env[key])) return null;
  const missing = required.filter((key) => !env[key]?.trim());
  if (missing.length) throw new Error(`Bungie configuration is incomplete. Set ${missing.join(", ")} in .env.local.`);
  let redirect: URL;
  try { redirect = new URL(env.BUNGIE_REDIRECT_URI!); }
  catch { throw new Error("BUNGIE_REDIRECT_URI must be a valid localhost callback URL."); }
  if (redirect.protocol !== "https:" || !["localhost", "127.0.0.1"].includes(redirect.hostname) ||
      redirect.pathname !== "/api/auth/bungie/callback" || redirect.search || redirect.hash || redirect.username || redirect.password) {
    throw new Error("Use https://127.0.0.1:3000/api/auth/bungie/callback (or localhost) as BUNGIE_REDIRECT_URI, matching the registered Bungie application.");
  }
  if (!/^\d+$/.test(env.BUNGIE_CLIENT_ID!)) throw new Error("BUNGIE_CLIENT_ID must be the numeric OAuth client ID.");
  const membershipId = env.BUNGIE_MEMBERSHIP_ID?.trim() || null;
  const membershipType = env.BUNGIE_MEMBERSHIP_TYPE ? Number(env.BUNGIE_MEMBERSHIP_TYPE) : null;
  if (Boolean(membershipId) !== (membershipType !== null) ||
      (membershipId && !/^\d+$/.test(membershipId)) ||
      (membershipType !== null && (!Number.isInteger(membershipType) || membershipType < 1 || membershipType > 6))) {
    throw new Error("Set both BUNGIE_MEMBERSHIP_ID (numeric string) and BUNGIE_MEMBERSHIP_TYPE (1–6), or leave both unset for automatic account selection.");
  }
  return {
    apiKey: env.BUNGIE_API_KEY!, clientId: env.BUNGIE_CLIENT_ID!, clientSecret: env.BUNGIE_CLIENT_SECRET!,
    redirectUri: redirect.href, dataDirectory: path.resolve("data"),
    tlsCert: env.BUNGIE_TLS_CERT ? path.resolve(env.BUNGIE_TLS_CERT) : null,
    tlsKey: env.BUNGIE_TLS_KEY ? path.resolve(env.BUNGIE_TLS_KEY) : null,
    membershipId, membershipType,
  };
}

export function requireBungieConfig(config: BungieConfig | null): BungieConfig {
  if (!config) throw new Error("Bungie is not configured. Copy .env.example to .env.local and supply your private app credentials before signing in.");
  return config;
}
