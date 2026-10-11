import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { expect, it } from "vitest";
import { createInventoryServer } from "../src/server.js";
import { writeInventoryExports } from "../src/exports.js";
import { normalizeInventory } from "../src/inventory.js";
import { parseProfile } from "../src/profile.js";

it("serves the browser, snapshot, and downloads locally without exposing other files or write routes", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "destiny-browser-test-"));
  const snapshot = normalizeInventory(parseProfile({ itemComponents: {} }), {}, "test-manifest");
  const server = createInventoryServer(directory);
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const missing = await fetch(`${base}/api/inventory`);
    expect(missing.status).toBe(404);
    expect((await missing.json()).error).toContain("pnpm destiny import");
    await writeInventoryExports(snapshot, directory);
    const committed = JSON.parse(await readFile(path.join(directory, "inventory.json"), "utf8"));
    expect(committed).toEqual({ ...snapshot, history: { current: expect.stringMatching(/\.json$/), previous: null } });
    const response = await fetch(`${base}/api/inventory`);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual(committed);
    const html = await fetch(base);
    expect(html.status).toBe(200);
    expect(await html.text()).toContain("Know what you own.");
    for (const asset of ["app.js", "search.js", "styles.css"]) {
      expect((await fetch(`${base}/${asset}`)).status).toBe(200);
    }
    for (const file of ["inventory.json", "weapons.csv", "armor.csv"]) {
      const download = await fetch(`${base}/downloads/${file}`);
      expect(download.status).toBe(200);
      expect(download.headers.get("content-disposition")).toContain(`filename="${file}"`);
    }
    expect((await fetch(`${base}/profile-data.json`)).status).toBe(404);
    expect((await fetch(`${base}/api/inventory`, { method: "POST" })).status).toBe(405);
    expect((await fetch(`${base}/`, { method: "HEAD" })).status).toBe(200);
  } finally {
    server.closeAllConnections();
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
