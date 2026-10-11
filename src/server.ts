import { createServer, type Server, type RequestListener, type IncomingMessage } from "node:http";
import { createServer as createHttpsServer, type Server as HttpsServer } from "node:https";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { BungieSync } from "./bungie/sync.js";
import { z } from "zod";
import { currentCleanup, exportDimSelection, readInventoryWithMetadata, withInventoryLock, type AnalysisPaths } from "./dim-service.js";
import { importDimMetadata } from "./dim.js";
import { currentNewLoot } from "./new-loot-service.js";
import { currentAcquisition } from "./acquisition-service.js";
import { formatAcquisition } from "./analysis/acquisition.js";
import { readAdvisorConfig, advisorStatus, type AdvisorConfig } from "./advisor.js";
import { commentaryContext, generateCommentary } from "./commentary-service.js";

export type InventoryServer = Server | HttpsServer;
export interface InventoryServerOptions {
  bungie?: BungieSync;
  tls?: { cert: Buffer; key: Buffer };
  analysisPaths?: AnalysisPaths;
  advisor?: AdvisorConfig;
  advisorFetcher?: typeof fetch;
}

const webDirectory = fileURLToPath(new URL("../web/", import.meta.url));
const assets: Record<string, [string, string]> = {
  "/": [path.join(webDirectory, "index.html"), "text/html; charset=utf-8"],
  "/app.js": [path.join(webDirectory, "app.js"), "text/javascript; charset=utf-8"],
  "/search.js": [path.join(webDirectory, "search.js"), "text/javascript; charset=utf-8"],
  "/styles.css": [path.join(webDirectory, "styles.css"), "text/css; charset=utf-8"],
  "/sync.css": [path.join(webDirectory, "sync.css"), "text/css; charset=utf-8"],
  "/cleanup": [path.join(webDirectory, "cleanup.html"), "text/html; charset=utf-8"],
  "/cleanup.js": [path.join(webDirectory, "cleanup.js"), "text/javascript; charset=utf-8"],
  "/cleanup.css": [path.join(webDirectory, "cleanup.css"), "text/css; charset=utf-8"],
  "/new-loot": [path.join(webDirectory, "new-loot.html"), "text/html; charset=utf-8"],
  "/new-loot.js": [path.join(webDirectory, "new-loot.js"), "text/javascript; charset=utf-8"],
  "/upgrades": [path.join(webDirectory, "upgrades.html"), "text/html; charset=utf-8"],
  "/upgrades.js": [path.join(webDirectory, "upgrades.js"), "text/javascript; charset=utf-8"],
  "/commentary": [path.join(webDirectory, "commentary.html"), "text/html; charset=utf-8"],
  "/commentary.js": [path.join(webDirectory, "commentary.js"), "text/javascript; charset=utf-8"],
};

async function requestJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > 10 * 1024 * 1024) throw new Error("Local request exceeds the 10 MiB limit.");
    chunks.push(Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export function createInventoryServer(outputDirectory: string, options: InventoryServerOptions = {}): InventoryServer {
  const exports: Record<string, [string, string]> = {
    "/api/inventory": [path.join(outputDirectory, "inventory.json"), "application/json; charset=utf-8"],
    "/downloads/inventory.json": [path.join(outputDirectory, "inventory.json"), "application/json; charset=utf-8"],
    "/downloads/weapons.csv": [path.join(outputDirectory, "weapons.csv"), "text/csv; charset=utf-8"],
    "/downloads/armor.csv": [path.join(outputDirectory, "armor.csv"), "text/csv; charset=utf-8"],
  };
  let syncing = false;
  const listener: RequestListener = async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'");
    const host = request.headers.host ?? "";
    let origin: URL;
    try { origin = new URL(`${options.tls ? "https" : "http"}://${host}`); }
    catch { response.writeHead(400).end("Invalid host"); return; }
    if (!["localhost", "127.0.0.1"].includes(origin.hostname) || Number(origin.port || (options.tls ? 443 : 80)) !== request.socket.localPort) {
      response.writeHead(403).end("Localhost access only"); return;
    }
    const url = new URL(request.url ?? "/", origin);
    const pathname = url.pathname;
    if (["/api/commentary", "/api/commentary/status"].includes(pathname)) {
      const isPost = request.method === "POST" && pathname === "/api/commentary";
      if (!isPost && request.method !== "GET") { response.writeHead(405, { Allow: pathname === "/api/commentary" ? "GET, POST" : "GET" }).end("Method not allowed"); return; }
      if (isPost && (request.headers.origin !== origin.origin || request.headers["x-local-request"] !== "1")) { response.writeHead(403).end("Same-origin local request required"); return; }
      try {
        const advisor = options.advisor ?? readAdvisorConfig();
        if (pathname === "/api/commentary/status") {
          const current = await withInventoryLock(outputDirectory, () => currentCleanup(outputDirectory, options.analysisPaths));
          response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" }).end(JSON.stringify({ ...advisorStatus(advisor),
            builds: current.builds.builds.map((build) => ({ id: build.id, name: build.name })),
            items: current.cleanup.items.map((item) => ({ id: item.itemId, name: item.name, classification: item.classification })) }));
          return;
        }
        const requestSchema = z.object({ scope: z.enum(["refresh", "build", "cleanup", "builds"]), target: z.string().min(1).max(200).optional() }).strict();
        const result = isPost ? await (async () => {
          const body = requestSchema.extend({ revision: z.string().length(64), allowCloud: z.boolean().default(false) }).parse(await requestJson(request));
          return generateCommentary(outputDirectory, { scope: body.scope, ...(body.target ? { target: body.target } : {}) }, advisor, options.analysisPaths,
            { revision: body.revision, allowCloud: body.allowCloud, ...(options.advisorFetcher ? { fetcher: options.advisorFetcher } : {}) });
        })() : await (async () => {
          const parsed = requestSchema.parse({ scope: url.searchParams.get("scope") ?? "refresh", ...(url.searchParams.has("target") ? { target: url.searchParams.get("target") } : {}) });
          return commentaryContext(outputDirectory, { scope: parsed.scope, ...(parsed.target ? { target: parsed.target } : {}) }, options.analysisPaths);
        })();
        response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" }).end(JSON.stringify(result));
      } catch (error) {
        const message = error instanceof z.ZodError || error instanceof SyntaxError ? "Invalid commentary request or local configuration." : error instanceof Error ? error.message : "Commentary unavailable.";
        response.writeHead(400, { "Content-Type": "application/json; charset=utf-8" }).end(JSON.stringify({ error: message }));
      }
      return;
    }
    if (["/api/upgrades", "/downloads/upgrades.json", "/downloads/upgrades.txt"].includes(pathname)) {
      if (request.method !== "GET") { response.writeHead(405, { Allow: "GET" }).end("Method not allowed"); return; }
      try {
        const analysis = await currentAcquisition(outputDirectory, options.analysisPaths);
        const plain = pathname.endsWith(".txt");
        if (pathname.startsWith("/downloads/")) response.setHeader("Content-Disposition", `attachment; filename="${plain ? "upgrades.txt" : "upgrades.json"}"`);
        response.writeHead(200, { "Content-Type": plain ? "text/plain; charset=utf-8" : "application/json; charset=utf-8" }).end(plain ? formatAcquisition(analysis) : JSON.stringify(analysis, null, 2));
      } catch (error) {
        response.writeHead(400, { "Content-Type": "application/json; charset=utf-8" }).end(JSON.stringify({ error: error instanceof Error ? error.message : "Unable to analyze acquisition pursuits." }));
      }
      return;
    }
    if (pathname === "/api/new-loot") {
      if (request.method !== "GET") { response.writeHead(405, { Allow: "GET" }).end("Method not allowed"); return; }
      try {
        response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" }).end(JSON.stringify(await currentNewLoot(outputDirectory, options.analysisPaths)));
      } catch (error) {
        response.writeHead(400, { "Content-Type": "application/json; charset=utf-8" }).end(JSON.stringify({ error: error instanceof Error ? error.message : "Unable to analyze new loot." }));
      }
      return;
    }
    if (["/api/cleanup", "/api/dim/import", "/api/dim/export"].includes(pathname)) {
      const isPost = pathname !== "/api/cleanup";
      if (request.method !== (isPost ? "POST" : "GET")) {
        response.writeHead(405, { Allow: isPost ? "POST" : "GET" }).end("Method not allowed"); return;
      }
      if (isPost && (request.headers.origin !== origin.origin || request.headers["x-local-request"] !== "1")) {
        response.writeHead(403).end("Same-origin local request required"); return;
      }
      try {
        if (pathname === "/api/dim/export") {
          const body = z.object({ selectedIds: z.array(z.string().min(1)).min(1).max(2000), revision: z.string().length(64) }).strict().parse(await requestJson(request));
          const csv = await exportDimSelection(outputDirectory, body.selectedIds, options.analysisPaths, body.revision);
          response.writeHead(200, { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": 'attachment; filename="dim-cleanup.csv"' }).end(csv);
          return;
        }
        const result = pathname === "/api/cleanup" ? await withInventoryLock(outputDirectory, async () => {
          const { snapshot, cleanup, revision } = await currentCleanup(outputDirectory, options.analysisPaths);
          return { ...cleanup, revision, metadata: snapshot.items.filter((item) => item.dim).map((item) => ({ itemId: item.id, ...item.dim })) };
        }) : await (async () => {
          const body = z.object({ csv: z.string().max(10 * 1024 * 1024) }).strict().parse(await requestJson(request));
          return withInventoryLock(outputDirectory, async () => importDimMetadata(outputDirectory, await readInventoryWithMetadata(outputDirectory), body.csv));
        })();
        response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" }).end(JSON.stringify(result));
      } catch (error) {
        const message = error instanceof z.ZodError || error instanceof SyntaxError ? "Invalid DIM request or local metadata. Check CSV, selection and file format." : error instanceof Error ? error.message : "DIM operation failed.";
        response.writeHead(400, { "Content-Type": "application/json; charset=utf-8" }).end(JSON.stringify({ error: message }));
      }
      return;
    }
    if (pathname === "/api/auth/status" || pathname === "/api/auth/bungie/start" ||
        pathname === "/api/auth/bungie/callback" || pathname === "/api/sync") {
      const isPost = pathname === "/api/auth/bungie/start" || pathname === "/api/sync";
      if (request.method !== (isPost ? "POST" : "GET")) {
        response.writeHead(405, { Allow: isPost ? "POST" : "GET" }).end("Method not allowed"); return;
      }
      if (isPost && (request.headers.origin !== origin.origin || request.headers["x-local-request"] !== "1")) {
        response.writeHead(403).end("Same-origin local request required"); return;
      }
      const json = (status: number, data: unknown) => {
        response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" }).end(JSON.stringify(data));
      };
      try {
        if (pathname === "/api/auth/status") {
          json(200, options.bungie ? { configured: true, ...await options.bungie.auth.status(), syncing } : { configured: false, connected: false, canRefresh: false, syncing: false });
          return;
        }
        if (!options.bungie) { json(503, { error: "Bungie connection is not configured. Follow the setup instructions in README.md." }); return; }
        if (pathname === "/api/auth/bungie/start") {
          const { url: authorizationUrl, state } = options.bungie.auth.begin();
          response.setHeader("Set-Cookie", `bungie_state=${state}; HttpOnly; SameSite=Lax; Path=/api/auth/bungie; Max-Age=600${options.tls ? "; Secure" : ""}`);
          json(200, { authorizationUrl }); return;
        }
        if (pathname === "/api/auth/bungie/callback") {
          const cookieState = request.headers.cookie?.split(";").map((part) => part.trim()).find((part) => part.startsWith("bungie_state="))?.slice("bungie_state=".length) ?? null;
          response.setHeader("Set-Cookie", `bungie_state=; HttpOnly; SameSite=Lax; Path=/api/auth/bungie; Max-Age=0${options.tls ? "; Secure" : ""}`);
          await options.bungie.auth.finish(url.searchParams.get("state"), cookieState, url.searchParams.get("code"));
          response.writeHead(303, { Location: "/" }).end(); return;
        }
        if (syncing) { json(409, { error: "A Bungie refresh is already in progress." }); return; }
        syncing = true;
        try { json(200, await options.bungie.sync()); }
        finally { syncing = false; }
      } catch (error) {
        json(400, { error: error instanceof Error ? error.message : "Bungie operation failed." });
      }
      return;
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405, { Allow: "GET, HEAD" }).end("Read-only inventory browser");
      return;
    }
    const asset = assets[pathname] ?? exports[pathname];
    if (!asset) { response.writeHead(404).end("Not found"); return; }
    try {
      const content = pathname === "/api/inventory" || pathname === "/downloads/inventory.json" ?
        Buffer.from(JSON.stringify(await readInventoryWithMetadata(outputDirectory))) : await readFile(asset[0]);
      response.setHeader("Content-Type", asset[1]);
      if (pathname.startsWith("/downloads/")) {
        response.setHeader("Content-Disposition", `attachment; filename="${path.basename(asset[0])}"`);
      }
      response.writeHead(200).end(request.method === "HEAD" ? undefined : content);
    } catch (error) {
      const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
      response.writeHead(missing ? 404 : 500, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: missing ? "No inventory export found. Run pnpm destiny import profile-data.json first." : "Unable to read the inventory export." }));
    }
  };
  return options.tls ? createHttpsServer(options.tls, listener) : createServer(listener);
}

export async function startInventoryBrowser(outputDirectory: string, port: number, bungie?: BungieSync, analysisPaths?: AnalysisPaths): Promise<InventoryServer> {
  let tls: InventoryServerOptions["tls"];
  let localUrl = `http://127.0.0.1:${port}`;
  if (bungie) {
    const redirect = new URL(bungie.config.redirectUri);
    if (Number(redirect.port || 443) !== port) throw new Error("The browser port must match the registered BUNGIE_REDIRECT_URI port.");
    if (!bungie.config.tlsCert || !bungie.config.tlsKey) throw new Error("HTTPS sign-in requires BUNGIE_TLS_CERT and BUNGIE_TLS_KEY. See the local certificate setup in README.md.");
    try { tls = { cert: await readFile(bungie.config.tlsCert), key: await readFile(bungie.config.tlsKey) }; }
    catch { throw new Error("Cannot read the local HTTPS certificate or key. See README.md for setup instructions."); }
    localUrl = redirect.origin;
  }
  const server = createInventoryServer(outputDirectory, { ...(bungie ? { bungie } : {}), ...(tls ? { tls } : {}), ...(analysisPaths ? { analysisPaths } : {}) });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  console.log(`Inventory browser: ${localUrl}`);
  console.log("Press Ctrl+C to stop. Re-import and reload to view a newer snapshot.");
  return server;
}
