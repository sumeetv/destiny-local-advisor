#!/usr/bin/env node
import { readFile, writeFile, rename } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";
import { ZodError } from "zod";
import { summarizeProfile } from "./import-profile.js";
import { loadItemManifest } from "./manifest.js";
import { parseProfile } from "./profile.js";
import { normalizeInventory } from "./inventory.js";
import { writeInventoryExports } from "./exports.js";
import { startInventoryBrowser } from "./server.js";
import { readBungieConfig, requireBungieConfig } from "./bungie/config.js";
import { BungieSync } from "./bungie/sync.js";
import { openSystemBrowser } from "./bungie/browser.js";
import { loadBuildConfig } from "./analysis/build-config.js";
import { analyzeBuilds, formatBuildAnalysis, writeBuildAnalysis } from "./analysis/builds.js";
import { loadAnalysisSnapshot } from "./analysis/snapshot.js";
import { loadWeaponRatings } from "./analysis/weapon-config.js";
import { analyzeWeapons, formatWeaponAnalysis, writeWeaponAnalysis } from "./analysis/weapons.js";
import { loadCleanupConfig } from "./analysis/cleanup-config.js";
import { analyzeCleanup, formatCleanupAnalysis, writeCleanupAnalysis } from "./analysis/cleanup.js";
import { applyDimMetadata, loadDimStore } from "./dim.js";
import { exportDimSelection, importDimFile } from "./dim-service.js";
import { currentNewLoot, writeNewLoot } from "./new-loot-service.js";
import { formatNewLoot } from "./analysis/new-loot.js";
import { retainRawSnapshot } from "./bungie/storage.js";
import { currentAcquisition, writeAcquisition } from "./acquisition-service.js";
import { formatAcquisition } from "./analysis/acquisition.js";
import { readAdvisorConfig } from "./advisor.js";
import { commentaryContext, generateCommentary, formatCommentary, writeCommentary, type CommentaryRequest } from "./commentary-service.js";

function usage(): never {
  console.error("Commentary: pnpm destiny commentary [--scope refresh|build|cleanup|builds] [--target build-or-item-id] [--preview] [--allow-cloud] [same analysis options]");
  console.error("Acquisition: pnpm destiny upgrades [--output output] [--builds config/builds] [--preferences config/preferences.yaml] [--acquisition-config config/acquisition/default.yaml]");
  console.error("New loot: pnpm destiny new-loot [--output output] [same analysis options]");
  console.error("DIM: pnpm destiny dim:import <dim-weapons.csv | dim-armor.csv> [--output output]\n     pnpm destiny dim:export --select <instance-id> [--select <instance-id> ...] [--output output] [same analysis options]");
  console.error("Usage: pnpm destiny import <profile-data.json> [--offline] [--output output]\n       pnpm destiny analyze [profile-data.json | inventory.json] [--offline] [--output output] [--builds config/builds] [--preferences config/preferences.yaml] [--perk-ratings config/perk-ratings/default.yaml] [--cleanup-config config/cleanup.yaml]\n       pnpm destiny cleanup [profile-data.json | inventory.json] [same analysis options]\n       pnpm destiny browse [--port 3000] [--output output]\n       pnpm destiny auth [--no-open]\n       pnpm destiny memberships\n       pnpm destiny sync [--output output]");
  process.exit(1);
}

async function main() {
  const { positionals, values } = parseArgs({ allowPositionals: true, options: {
    offline: { type: "boolean", default: false },
    output: { type: "string", default: "output" },
    port: { type: "string" },
    "no-open": { type: "boolean", default: false },
    builds: { type: "string", default: "config/builds" },
    preferences: { type: "string", default: "config/preferences.yaml" },
    "perk-ratings": { type: "string", default: "config/perk-ratings/default.yaml" },
    "cleanup-config": { type: "string" },
    "acquisition-config": { type: "string", default: "config/acquisition/default.yaml" },
    select: { type: "string", multiple: true },
    scope: { type: "string", default: "refresh" },
    target: { type: "string" },
    "allow-cloud": { type: "boolean", default: false },
    preview: { type: "boolean", default: false },
  } });
  const [command, input] = positionals;
  const outputDirectory = path.resolve(values.output!);
  const analysisPaths = { builds: values.builds!, preferences: values.preferences!, perkRatings: values["perk-ratings"]!,
    acquisitionConfig: values["acquisition-config"]!,
    ...(values["cleanup-config"] ? { cleanupConfig: values["cleanup-config"] } : {}) };
  const reportLoot = async () => {
    const loot = await currentNewLoot(outputDirectory, analysisPaths);
    await writeNewLoot(loot, outputDirectory);
    console.log(formatNewLoot(loot));
  };
  if (command === "commentary" && positionals.length === 1) {
    try { process.loadEnvFile(".env.local"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("Cannot load .env.local. Check permissions and syntax."); }
    const scope = values.scope;
    if (scope !== "refresh" && scope !== "build" && scope !== "cleanup" && scope !== "builds") throw new Error("Commentary scope must be refresh, build, cleanup or builds.");
    const request: CommentaryRequest = { scope, ...(values.target ? { target: values.target } : {}) };
    const advisorConfig = readAdvisorConfig();
    if (values.preview) {
      console.log(formatCommentary({ schemaVersion: 1, analysisVersion: "0.10.0", provider: advisorConfig.provider, model: advisorConfig.model,
        status: "disabled", paragraphs: [], notice: "Facts preview only. No provider request or artifact write was made.", context: await commentaryContext(outputDirectory, request, analysisPaths) }));
      return;
    }
    const report = await generateCommentary(outputDirectory, request, advisorConfig, analysisPaths, { allowCloud: values["allow-cloud"] });
    await writeCommentary(report, outputDirectory);
    console.log(formatCommentary(report));
    console.log(`Commentary exports: ${path.join(outputDirectory, "commentary.json")}, commentary.txt`);
    return;
  }
  if (command === "new-loot" && positionals.length === 1) { await reportLoot(); return; }
  if (command === "upgrades" && positionals.length === 1) {
    const analysis = await currentAcquisition(outputDirectory, analysisPaths);
    await writeAcquisition(analysis, outputDirectory);
    console.log(formatAcquisition(analysis));
    console.log(`Planner exports: ${path.join(outputDirectory, "upgrades.json")}, upgrades.txt`);
    return;
  }
  if (command === "dim:import" && input && positionals.length === 2) {
    const result = await importDimFile(outputDirectory, path.resolve(input));
    console.log(`DIM metadata mapping v${result.mappingVersion}: ${result.matched} matched, ${result.preserved} preservation tags retained, ${result.skipped.length} unmatched/ambiguous rows skipped.`);
    if (result.skipped.length) console.log(`Skipped IDs: ${result.skipped.join(", ")}`);
    console.log("Reload the browser or rerun cleanup to see imported tags and notes.");
    return;
  }
  if (command === "dim:export" && positionals.length === 1) {
    const csv = await exportDimSelection(outputDirectory, values.select ?? [], analysisPaths);
    const filename = path.join(outputDirectory, "dim-cleanup.csv"), temporary = `${filename}.${randomUUID()}.tmp`;
    await writeFile(temporary, csv, { mode: 0o600, flag: "wx" });
    await rename(temporary, filename);
    console.log(`DIM Cleanup CSV: ${filename}\nExplicitly selected: ${new Set(values.select).size}. Import this file in DIM Settings → Import tags/notes from CSV.`);
    return;
  }
  if ((command === "analyze" || command === "cleanup") && positionals.length <= 2) {
    const snapshot = applyDimMetadata(await loadAnalysisSnapshot(path.resolve(input ?? path.join(outputDirectory, "inventory.json")), values.offline), await loadDimStore(outputDirectory));
    const config = await loadBuildConfig(values.builds, values.preferences);
    const weapons = analyzeWeapons(snapshot, await loadWeaponRatings(values["perk-ratings"]));
    const analysis = analyzeBuilds(snapshot, config.templates, config.preferences, config, weapons);
    const cleanup = analyzeCleanup(snapshot, weapons, analysis, await loadCleanupConfig(values["cleanup-config"]));
    await writeBuildAnalysis(analysis, outputDirectory);
    await writeWeaponAnalysis(weapons, outputDirectory);
    await writeCleanupAnalysis(cleanup, outputDirectory);
    if (command === "analyze") {
      console.log(formatBuildAnalysis(analysis));
      console.log(formatWeaponAnalysis(weapons));
    }
    console.log(formatCleanupAnalysis(cleanup));
    console.log(`Build exports: ${path.join(outputDirectory, "builds.json")}, builds.txt`);
    console.log(`Weapon exports: ${path.join(outputDirectory, "weapon-analysis.json")}, weapon-analysis.txt`);
    console.log(`Cleanup exports: ${path.join(outputDirectory, "cleanup.json")}, cleanup.txt`);
    return;
  }
  if (["browse", "auth", "sync", "memberships"].includes(command ?? "") && positionals.length === 1) {
    try { process.loadEnvFile(".env.local"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("Cannot load .env.local. Check file permissions and syntax."); }
    const config = readBungieConfig();
    if (command === "sync" || command === "memberships") {
      if (values.offline) throw new Error("--offline is supported for manual import only; sync requires Bungie access.");
      const bungie = new BungieSync(requireBungieConfig(config), outputDirectory);
      if (command === "memberships") {
        const data = await bungie.client.memberships();
        for (const item of data.destinyMemberships) console.log(`Membership ID: ${item.membershipId}, type: ${item.membershipType}${item.membershipId === data.primaryMembershipId || item.membershipType === item.crossSaveOverride ? " (active)" : ""}`);
        return;
      }
      const result = await bungie.sync();
      console.log(`Characters: ${result.characters}\nItems: ${result.items}\nWeapons: ${result.weapons}\nArmor: ${result.armor}`);
      console.log(`Raw snapshot: ${result.rawSnapshot}`);
      console.log(`Unknown hashes (${result.unknownHashes.length}): ${result.unknownHashes.join(", ") || "none"}`);
      console.log(`Inventory exports updated: ${outputDirectory}`);
      await reportLoot();
      return;
    }
    if (command === "auth") requireBungieConfig(config);
    const bungie = config ? new BungieSync(config, outputDirectory) : undefined;
    const port = Number(values.port ?? (config ? new URL(config.redirectUri).port || "443" : "3000"));
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Port must be an integer between 1 and 65535.");
    const server = await startInventoryBrowser(outputDirectory, port, bungie, analysisPaths);
    const stop = () => { server.closeAllConnections(); server.close(); };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    if (command === "auth") {
      console.log("Connect to Bungie in the system browser. After sign-in, leave this server running or stop it and run pnpm destiny sync.");
      if (!values["no-open"]) openSystemBrowser(`${new URL(config!.redirectUri).origin}/?connect=1`);
    }
    return;
  }
  if (command !== "import" || !input || positionals.length !== 2) usage();

  const inputPath = path.resolve(input);
  const inputText = await readFile(inputPath, "utf8");
  const raw = JSON.parse(inputText) as unknown;
  const profile = parseProfile(raw);
  const cacheDirectory = path.resolve("data/manifest");
  const { definitions, version } = await loadItemManifest(cacheDirectory, values.offline);
  const summary = summarizeProfile(profile, definitions);
  const inventory = normalizeInventory(profile, definitions, version);

  console.log(`Characters: ${summary.characters}`);
  console.log(`Vault items: ${summary.vaultItems}`);
  console.log(`Titan items: ${summary.titanItems}`);
  console.log(`Weapons: ${summary.weapons}`);
  console.log(`Armor: ${summary.armor}`);
  console.log(`Manifest: ${version}`);
  console.log(`Instanced weapon names: ${summary.namedInstancedWeapons}/${summary.instancedWeapons}`);
  console.log(`Titan armor names: ${summary.namedTitanArmor}/${summary.titanArmor}`);
  console.log(`Socket/perk plugs resolved: ${summary.resolvedSocketPlugs}/${summary.socketPlugs}`);

  if (inventory.unknownHashes.length) {
    console.warn(`Unknown hashes (${inventory.unknownHashes.length}): ${inventory.unknownHashes.join(", ")}`);
  } else {
    console.log("Unknown hashes: 0");
  }

  if (summary.namedInstancedWeapons !== summary.instancedWeapons) {
    throw new Error("One or more instanced weapons did not resolve to a human-readable name");
  }
  if (summary.namedTitanArmor !== summary.titanArmor) {
    throw new Error("One or more Titan armor items did not resolve to a human-readable name");
  }
  const rawSnapshot = await retainRawSnapshot(path.join(outputDirectory, "raw-imports"), inputText);
  await writeInventoryExports(inventory, outputDirectory);
  console.log(`Raw import retained: ${rawSnapshot}`);
  await reportLoot();
  console.log(`Exports: ${path.join(outputDirectory, "inventory.json")}, weapons.csv, armor.csv`);
  console.log("Open the local browser with: pnpm destiny browse");
}

main().catch((error: unknown) => {
  if (error instanceof ZodError) console.error(`Invalid Destiny profile export:\n${error.message}`);
  else console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
