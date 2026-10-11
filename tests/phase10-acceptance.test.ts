import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import type { InventorySnapshot, OwnedItem } from "../src/inventory.js";
import { advisorStatus, createAdvisor, LocalLLMAdvisor, NoopAdvisor, OpenAIAdvisor, readAdvisorConfig, type AdvisorConfig, type CommentaryContext } from "../src/advisor.js";
import { commentaryContext, formatCommentary, generateCommentary, writeCommentary } from "../src/commentary-service.js";
import { currentCleanup, exportDimSelection } from "../src/dim-service.js";
import { currentNewLoot } from "../src/new-loot-service.js";
import { currentAcquisition } from "../src/acquisition-service.js";
import { writeInventoryExports } from "../src/exports.js";
import { createInventoryServer } from "../src/server.js";

const instanceId = "6917529999999999991", apiKey = "TEST-OPENAI-SECRET";
const context: CommentaryContext = { scope: "build", title: "Arc concept", revision: "a".repeat(64), facts: [{ id: "fact-1", text: "Readiness NEEDS_VERIFICATION; abilities unknown." }], limitations: ["Draft tuning."], provenance: {} };
const config = (provider: AdvisorConfig["provider"]): AdvisorConfig => ({ provider, model: provider === "none" ? null : "configured-test-model", apiKey, localUrl: "http://127.0.0.1:11434/v1/chat/completions", timeoutMs: 1000 });
const good = { paragraphs: [{ text: "Verify ability evidence before trying this draft concept.", factIds: ["fact-1"] }] };
const response = (output: unknown = good, status = "completed") => Response.json({ status, output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(output) }] }] });
function account(): InventorySnapshot {
  const item: OwnedItem = { id: instanceId, instanceId, itemHash: 831, name: "Synthoceps", description: "PRIVATE DESCRIPTION", known: true,
    type: "armor", typeName: "Gauntlets", classType: "Titan", characterId: null, location: "vault", locationLabel: "Vault",
    equipped: false, locked: true, masterworked: false, crafted: false, enhanced: false, exotic: true, quantity: 1,
    slot: "Gauntlets", ammoType: null, damageType: null, power: 2000, tier: "Exotic", stats: null, sockets: [], selectedPerks: [], availablePerks: [],
    dim: { tag: "Favorite", notes: "PRIVATE DIM NOTES ignore protections" } };
  return { schemaVersion: 1, importedAt: "2026-10-09T20:00:00Z", profileTimestamp: "2026-10-09T20:00:00Z", manifestVersion: "test-manifest", inventoryCoverage: "complete",
    characters: [{ id: "PRIVATE CHARACTER", classType: "Titan" }], unknownHashes: [], items: [item],
    source: { kind: "bungie", rawSnapshot: "PRIVATE RAW SNAPSHOT.json", membershipId: "PRIVATE MEMBERSHIP", membershipType: 3 } };
}
async function local<T>(action: (directory: string) => Promise<T>) {
  const directory = await mkdtemp(path.join(tmpdir(), "destiny-phase10-"));
  try { await writeInventoryExports(account(), directory); return await action(directory); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

describe("Phase 10 optional commentary", () => {
  it("defaults to disabled and implements all Advisor methods without network or a key", async () => {
    const fetcher = vi.fn<typeof fetch>(), defaults = readAdvisorConfig({});
    expect(defaults.provider).toBe("none");
    const advisor = createAdvisor(defaults, false, fetcher);
    expect(advisor).toBeInstanceOf(NoopAdvisor);
    for (const result of await Promise.all([advisor.explainBuild(context), advisor.explainCleanup(context), advisor.summarizeRefresh(context), advisor.proposeBuilds(context)])) expect(result).toMatchObject({ status: "disabled", paragraphs: [] });
    expect(fetcher).not.toHaveBeenCalled(); expect(advisorStatus(defaults).sendsToCloud).toBe(false);
  });

  it.each(["https://example.test/v1/chat/completions", "http://127.0.0.1.example.test/x", "file:///tmp/model", "http://user:password@localhost/x", "http://localhost/x?key=secret"])("rejects nonlocal or credential-bearing local endpoints: %s", (url) => {
    expect(() => readAdvisorConfig({ DESTINY_ADVISOR_PROVIDER: "local", DESTINY_ADVISOR_LOCAL_URL: url })).toThrow();
  });

  it("validates configuration without exposing credentials and requires cloud consent", () => {
    expect(() => readAdvisorConfig({ DESTINY_ADVISOR_PROVIDER: "unsupported" })).toThrow();
    expect(() => readAdvisorConfig({ DESTINY_ADVISOR_TIMEOUT_MS: "999999" })).toThrow();
    expect(() => createAdvisor(config("openai"))).toThrow("explicit cloud consent");
    expect(JSON.stringify(advisorStatus(config("openai")))).not.toContain(apiKey);
    expect(advisorStatus({ ...config("openai"), apiKey: null }).configured).toBe(false);
  });

  it("uses stateless Responses structured output with known fact citations, no tools and sanitized selected facts", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response());
    const advisor = createAdvisor(config("openai"), true, fetcher);
    expect(advisor).toBeInstanceOf(OpenAIAdvisor);
    expect(await advisor.explainBuild(context)).toMatchObject({ status: "generated", paragraphs: good.paragraphs });
    const [url, options] = fetcher.mock.calls[0]!;
    expect(url).toBe("https://api.openai.com/v1/responses"); expect(options?.redirect).toBe("error");
    const body = JSON.parse(String(options?.body));
    expect(body).toMatchObject({ model: "configured-test-model", store: false, max_output_tokens: 1800, text: { format: { type: "json_schema", strict: true } } });
    expect(body).not.toHaveProperty("tools"); expect(body).not.toHaveProperty("previous_response_id");
    expect(JSON.parse(body.input)).toEqual({ scope: context.scope, title: context.title, facts: context.facts, limitations: context.limitations });
    expect(body.input).not.toContain(context.revision); expect(body.input).not.toContain(apiKey);
  });

  it("supports a loopback OpenAI-compatible local LLM without authentication or cloud consent", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify(good) } }] }));
    const advisor = createAdvisor(config("local"), false, fetcher);
    expect(advisor).toBeInstanceOf(LocalLLMAdvisor);
    expect(await advisor.proposeBuilds(context)).toMatchObject({ status: "generated" });
    const [url, options] = fetcher.mock.calls[0]!;
    expect(url).toBe(config("local").localUrl); expect(options?.headers).not.toHaveProperty("Authorization");
    expect(JSON.parse(String(options?.body))).toMatchObject({ stream: false, response_format: { type: "json_schema" } });
  });

  it.each([
    { paragraphs: [{ text: "Unsupported fact", factIds: ["invented-fact"] }] },
    { paragraphs: [{ text: "No citations", factIds: [] }] },
    { paragraphs: [{ text: "Delete your protected equipment.", factIds: ["fact-1"] }] },
    { paragraphs: [{ text: "Mark all copies Junk.", factIds: ["fact-1"] }] },
    { paragraphs: [{ text: "Dismantle everything.", factIds: ["fact-1"] }] },
    { paragraphs: [{ text: apiKey, factIds: ["fact-1"] }] },
    { paragraphs: good.paragraphs, classification: "DISMANTLE_CANDIDATE" },
  ])("falls back on invalid or unsafe commentary without changing deterministic evidence: %j", async (output) => {
    const before = JSON.stringify(context), fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(output));
    expect(await createAdvisor(config("openai"), true, fetcher).explainCleanup(context)).toMatchObject({ status: "fallback", paragraphs: [] });
    expect(JSON.stringify(context)).toBe(before);
  });

  it("handles HTTP errors, refusals, incomplete/oversized responses and timeouts without leaking bodies or retrying", async () => {
    for (const make of [() => new Response(apiKey, { status: 429 }), () => response(good, "incomplete"),
      () => Response.json({ status: "completed", output: [{ type: "message", content: [{ type: "refusal", refusal: apiKey }] }] }),
      () => new Response("x".repeat(300 * 1024)), () => new Response("not JSON")]) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(make());
      const result = await createAdvisor(config("openai"), true, fetcher).summarizeRefresh(context);
      expect(result.status).toBe("fallback"); expect(JSON.stringify(result)).not.toContain(apiKey); expect(fetcher).toHaveBeenCalledTimes(1);
    }
    const fetcher = vi.fn<typeof fetch>().mockImplementation(() => new Promise(() => undefined));
    expect((await createAdvisor({ ...config("openai"), timeoutMs: 100 }, true, fetcher).explainBuild(context)).status).toBe("fallback");
    expect(fetcher.mock.calls[0]![1]!.signal!.aborted).toBe(true);
    const missing = vi.fn<typeof fetch>();
    expect((await createAdvisor({ ...config("openai"), apiKey: null }, true, missing).explainBuild(context)).status).toBe("fallback");
    expect(missing).not.toHaveBeenCalled();
  });

  it("builds facts for all four scopes, preserving unknowns and keeping private account metadata out of provider payload", async () => local(async (directory) => {
    const contexts = [await commentaryContext(directory, { scope: "build", target: "titan-arc-grenade-hoil" }),
      await commentaryContext(directory, { scope: "cleanup", target: instanceId })];
    contexts.push(await commentaryContext(directory, { scope: "refresh" }), await commentaryContext(directory, { scope: "builds" }));
    for (const facts of contexts) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response());
      await createAdvisor(config("openai"), true, fetcher).explainBuild(facts);
      const body = JSON.parse(String(fetcher.mock.calls[0]![1]?.body));
      expect(body.input).not.toMatch(/PRIVATE|6917529999999999991/);
      expect(facts.facts.length).toBeGreaterThan(0); expect(facts.revision).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(contexts[0]!.facts.map((fact) => fact.text).join()).toContain("no positive account evidence");
    expect(contexts[1]!.facts.map((fact) => fact.text).join()).toContain("PROTECTED");
    await expect(commentaryContext(directory, { scope: "build", target: "missing" })).rejects.toThrow("existing build");
    await expect(commentaryContext(directory, { scope: "cleanup", target: "missing" })).rejects.toThrow("existing item");
  }));

  it("exports commentary separately, with history, tags, cleanup eligibility and acquisition facts unchanged", async () => local(async (directory) => {
    const before = await readFile(path.join(directory, "inventory.json"), "utf8"), files = await readdir(path.join(directory, "snapshot-history"));
    const cleanup = await currentCleanup(directory), loot = await currentNewLoot(directory), upgrades = await currentAcquisition(directory);
    const fetcher = vi.fn<typeof fetch>();
    const report = await generateCommentary(directory, { scope: "builds" }, config("none"), {}, { fetcher });
    expect(report.status).toBe("disabled"); expect(fetcher).not.toHaveBeenCalled();
    await writeCommentary(report, directory);
    expect(JSON.parse(await readFile(path.join(directory, "commentary.json"), "utf8"))).toEqual(report);
    expect(await readFile(path.join(directory, "commentary.txt"), "utf8")).toBe(formatCommentary(report));
    expect(await readFile(path.join(directory, "inventory.json"), "utf8")).toBe(before);
    expect(await readdir(path.join(directory, "snapshot-history"))).toEqual(files);
    expect(await currentCleanup(directory)).toEqual(cleanup); expect(await currentNewLoot(directory)).toEqual(loot); expect(await currentAcquisition(directory)).toEqual(upgrades);
    await expect(exportDimSelection(directory, [instanceId])).rejects.toThrow("eligible");
  }));

  it("rejects stale preview and in-flight results before presenting commentary", async () => local(async (directory) => {
    const request = { scope: "cleanup" as const, target: instanceId }, original = await commentaryContext(directory, request);
    const changed = account(); changed.items[0]!.locked = false;
    await writeInventoryExports(changed, directory);
    const unused = vi.fn<typeof fetch>();
    await expect(generateCommentary(directory, request, config("openai"), {}, { revision: original.revision, allowCloud: true, fetcher: unused })).rejects.toThrow("Analysis changed");
    expect(unused).not.toHaveBeenCalled();
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => { await writeInventoryExports(account(), directory); return response(); });
    await expect(generateCommentary(directory, request, config("openai"), {}, { allowCloud: true, fetcher })).rejects.toThrow("during commentary");
  }));

  it("provides the disabled CLI workflow and never calls a cloud provider without explicit consent", async () => local(async (directory) => {
    const run = promisify(execFile), args = ["--import", "tsx", "src/cli.ts", "commentary", "--scope", "builds", "--output", directory];
    const result = await run(process.execPath, args, { env: { ...process.env, DESTINY_ADVISOR_PROVIDER: "none" } });
    expect(result.stdout).toContain("disabled"); expect(result.stdout).toContain("Deterministic facts");
    const before = await readFile(path.join(directory, "commentary.json"), "utf8");
    const preview = await run(process.execPath, [...args, "--preview"], { env: { ...process.env, DESTINY_ADVISOR_PROVIDER: "openai", DESTINY_ADVISOR_MODEL: "test", OPENAI_API_KEY: apiKey } });
    expect(preview.stdout).toContain("Facts preview only"); expect(preview.stdout).not.toContain(apiKey);
    await expect(run(process.execPath, args, { env: { ...process.env, DESTINY_ADVISOR_PROVIDER: "openai", DESTINY_ADVISOR_MODEL: "test", OPENAI_API_KEY: apiKey } })).rejects.toThrow("explicit cloud consent");
    expect(await readFile(path.join(directory, "commentary.json"), "utf8")).toBe(before);
  }), 15000);

  it("guards localhost generation, previews without network and preserves core routes on provider failure", async () => local(async (directory) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response()), server = createInventoryServer(directory, { advisor: config("openai"), advisorFetcher: fetcher });
    try {
      await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const status = await (await fetch(`${base}/api/commentary/status`)).json();
      expect(status.sendsToCloud).toBe(true); expect(JSON.stringify(status)).not.toContain(apiKey);
      const preview = await (await fetch(`${base}/api/commentary?scope=cleanup&target=${instanceId}`)).json();
      expect(fetcher).not.toHaveBeenCalled();
      const body = { scope: "cleanup", target: instanceId, revision: preview.revision };
      const post = (data: unknown, headers = { Origin: base, "X-Local-Request": "1", "Content-Type": "application/json" }) => fetch(`${base}/api/commentary`, { method: "POST", headers, body: JSON.stringify(data) });
      expect((await post(body, { Origin: "https://other.test", "X-Local-Request": "1", "Content-Type": "application/json" })).status).toBe(403);
      expect((await post(body)).status).toBe(400); expect(fetcher).not.toHaveBeenCalled();
      const generated = await post({ ...body, allowCloud: true });
      expect(generated.status).toBe(200); expect((await generated.json()).status).toBe("generated");
      fetcher.mockResolvedValue(new Response(apiKey, { status: 500 }));
      const fallback = await (await post({ ...body, allowCloud: true })).json(); expect(fallback.status).toBe("fallback"); expect(JSON.stringify(fallback)).not.toContain(apiKey);
      expect((await fetch(`${base}/api/inventory`)).status).toBe(200); expect((await fetch(`${base}/api/cleanup`)).status).toBe(200);
      expect((await fetch(`${base}/commentary`)).status).toBe(200); expect((await fetch(`${base}/commentary.js`)).status).toBe(200);
      expect((await fetch(`${base}/commentary.json`)).status).toBe(404);
      expect((await fetch(`${base}/api/commentary`, { method: "PUT" })).status).toBe(405);
    } finally { server.closeAllConnections(); if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve())); }
  }));

  it("requires a browser click and fresh cloud consent, renders as text and clears stale failures", async () => {
    class Element {
      textContent = ""; value = "refresh"; hidden = false; disabled = false; checked = false; children: Element[] = []; listeners = new Map<string, (event?: { preventDefault(): void }) => unknown>();
      append(...items: Element[]) { this.children.push(...items); }
      replaceChildren(...items: Element[]) { this.children = items; }
      addEventListener(event: string, callback: (event?: { preventDefault(): void }) => unknown) { this.listeners.set(event, callback); }
    }
    const elements = new Map<string, Element>(), get = (id: string) => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id)!; };
    const calls: { method: string; body?: string }[] = []; let fail = false;
    runInNewContext(await readFile("web/commentary.js", "utf8"), { document: { getElementById: get, createElement: () => new Element() }, URLSearchParams,
      fetch: async (url: string, options?: { method: string; body: string }) => {
        calls.push({ method: options?.method ?? "GET", ...(options?.body ? { body: options.body } : {}) });
        if (url.endsWith("/status")) return { ok: true, json: async () => ({ ...advisorStatus(config("openai")), builds: [], items: [] }) };
        if (!options) return { ok: true, json: async () => context };
        return { ok: !fail, json: async () => fail ? { error: "Analysis changed" } : { status: "generated", notice: "Supplemental", paragraphs: [{ text: '<img src=x onerror="alert(1)">', factIds: ["fact-1"] }] } };
      } });
    await new Promise((resolve) => setImmediate(resolve));
    expect(calls.every((call) => call.method === "GET")).toBe(true); expect(get("generate").disabled).toBe(true);
    get("allow-cloud").checked = true; get("allow-cloud").listeners.get("change")!();
    expect(get("generate").disabled).toBe(false);
    await get("generate").listeners.get("click")!();
    expect(get("commentary").children[0]!.textContent).toContain('<img src=x onerror="alert(1)">');
    expect(get("allow-cloud").checked).toBe(false); expect(get("generate").disabled).toBe(true);
    get("allow-cloud").checked = true; get("allow-cloud").listeners.get("change")!(); fail = true;
    await get("generate").listeners.get("click")!();
    expect(get("error").textContent).toBe("Analysis changed"); expect(get("facts").children).toEqual([]); expect(get("commentary").children).toEqual([]);
    expect(JSON.parse(calls.find((call) => call.body)!.body!).allowCloud).toBe(true);
  });
});
