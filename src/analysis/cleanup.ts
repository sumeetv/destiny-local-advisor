import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { InventorySnapshot, OwnedItem } from "../inventory.js";
import type { BuildAnalysis } from "./builds.js";
import type { WeaponAnalysis } from "./weapons.js";
import { cleanupConfigSchema, cleanupConfigVersion, defaultCleanupConfig, type CleanupConfig } from "./cleanup-config.js";

export const CLEANUP_ANALYSIS_VERSION = "0.6.0";
export type CleanupClassification = "PROTECTED" | "KEEP" | "REVIEW" | "DISMANTLE_CANDIDATE";
export interface CleanupAlternative {
  itemId: string; itemHash: number; name: string; reasons: string[];
}
export interface CleanupItem {
  itemId: string; itemHash: number; name: string; type: OwnedItem["type"]; slot: string | null;
  location: OwnedItem["location"]; weaponType: string | null; element: string | null;
  classification: CleanupClassification; confidence: number;
  reasons: string[]; protectionReasons: string[]; unknowns: string[];
  betterOwnedAlternatives: CleanupAlternative[]; uniqueThings: string[];
  buildsAffected: string[]; sourceStatus: string; familyItemIds: string[];
}
export interface CleanupAnalysis {
  analysisVersion: string; snapshotId: string; manifestVersion: string; configVersion: string;
  weaponRatingsVersion: string; threshold: number; counts: Record<CleanupClassification, number>;
  limitations: string[]; items: CleanupItem[];
}
const snapshotId = (snapshot: InventorySnapshot) => snapshot.source?.rawSnapshot ?? snapshot.profileTimestamp ?? snapshot.importedAt;
const activeRoll = (item: OwnedItem) => item.selectedPerks.filter((perk) => perk.enabled !== false).map((perk) => perk.hash).sort((a, b) => a - b).join(",");
const equipment = (item: OwnedItem) => item.quantity > 0 && (item.type === "weapon" || item.type === "armor");
const statEntries = (item: OwnedItem) => Object.entries(item.stats ?? {}).sort(([a], [b]) => a.localeCompare(b));
const sameStats = (left: OwnedItem, right: OwnedItem) => JSON.stringify(statEntries(left)) === JSON.stringify(statEntries(right));
const sourceKnown = (item: OwnedItem) => ["common", "reacquirable", "rare", "unobtainable", "legacy"].includes(item.sourceStatus ?? "");
// Full sockets include armor stat/mod/artifice plugs omitted from gameplay selectedPerks.
// Differing configurations cannot prove that observed stat superiority survives replacement.
const armorSocketSignature = (item: OwnedItem) => JSON.stringify(item.sockets.map((socket) => ({
  index: socket.index, visible: socket.visible,
  selectedHash: socket.selected?.hash ?? null, enabled: socket.selected?.enabled ?? null,
})).sort((a, b) => a.index - b.index));

/** Full componentwise preservation covers grenade, melee, balanced ability and survival vectors.
 * Weighted totals cannot prove this: every stat must be no worse, and one must be better.
 * This also preserves any attainable breakpoint using the replacement in the same loadout.
 */
function armorDominates(better: OwnedItem, item: OwnedItem, config: CleanupConfig): boolean {
  if (!better.known || !better.instanceId || better.armorStatsExact !== true || item.armorStatsExact !== true) return false;
  if (better.itemHash !== item.itemHash || better.type !== "armor" || better.classType !== item.classType || better.slot !== item.slot ||
    better.exotic !== item.exotic || better.tier !== item.tier || better.gearTier !== item.gearTier ||
    better.armorSet !== item.armorSet || better.armorSetBonus !== item.armorSetBonus || activeRoll(better) !== activeRoll(item) ||
    better.crafted !== item.crafted || better.enhanced !== item.enhanced || better.masterworked !== item.masterworked ||
    !Number.isFinite(better.power) || better.power! < item.power!) return false;
  const left = statEntries(better), right = statEntries(item);
  if (!left.length || left.map(([axis]) => axis).join() !== right.map(([axis]) => axis).join() ||
    [...left, ...right].some(([, value]) => !Number.isFinite(value) || value < 0)) return false;
  if (!config.armorStatHashes.every((axis) => typeof better.stats?.[axis] === "number" && typeof item.stats?.[axis] === "number")) return false;
  return right.every(([axis, value]) => better.stats![axis]! >= value) && right.some(([axis, value]) => better.stats![axis]! > value);
}

export function analyzeCleanup(snapshot: InventorySnapshot, weapons: WeaponAnalysis, builds?: BuildAnalysis, inputConfig: CleanupConfig = defaultCleanupConfig): CleanupAnalysis {
  const config = cleanupConfigSchema.parse(inputConfig);
  const metadataConflicts = new Map<string, string[]>();
  const allOwned = snapshot.items.filter((item) => item.quantity > 0).map((item): OwnedItem => {
    const copy = { ...item };
    for (const [field, value] of Object.entries(config.itemFacts[item.id] ?? {})) {
      if (value === undefined) continue;
      const existing = item[field as keyof OwnedItem];
      const protective = ((field === "highValueNiche" || field === "currentSetBonusNeeded") && value === true) || (field === "sourceStatus" && ["rare", "unobtainable", "legacy"].includes(String(value)));
      if (existing === undefined || existing === "unknown" || protective) Object.assign(copy, { [field]: value });
      else if (existing !== value) metadataConflicts.set(item.id, [...(metadataConflicts.get(item.id) ?? []), `Local ${field} fact conflicts with existing inventory evidence; preserve existing evidence`]);
    }
    return copy;
  }).sort((a, b) => a.id.localeCompare(b.id));
  const owned = allOwned.filter((item) => equipment(item) || !item.known);
  const byId = new Map(allOwned.map((item) => [item.id, item]));
  const idCounts = new Map<string, number>();
  for (const item of allOwned) idCounts.set(item.id, (idCounts.get(item.id) ?? 0) + 1);
  const evaluations = new Map(weapons.weapons.map((weapon) => [weapon.itemId, weapon]));
  const currentReferences = new Map<string, string[]>(), savedReferences = new Map<string, string[]>();
  for (const build of builds?.builds ?? []) for (const id of build.recommendedItemIds) currentReferences.set(id, [...(currentReferences.get(id) ?? []), build.id]);
  for (const build of config.savedBuilds) for (const id of build.itemIds) savedReferences.set(id, [...(savedReferences.get(id) ?? []), build.id]);
  const compatibleAnalysis = weapons.snapshotId === snapshotId(snapshot) && weapons.manifestVersion === snapshot.manifestVersion;
  const result: CleanupItem[] = [];
  for (const item of owned) {
    const family = allOwned.filter((copy) => copy.type === item.type && copy.itemHash === item.itemHash);
    const siblings = family.filter((copy) => copy.id !== item.id);
    const protectionReasons: string[] = [], unknowns: string[] = [...(metadataConflicts.get(item.id) ?? [])], uniqueThings: string[] = [];
    const protect = (reason: string) => protectionReasons.push(reason);
    if (item.equipped) protect("Currently equipped");
    if (item.locked) protect("Locked");
    if (["favorite", "keep", "archive"].includes(item.dim?.tag?.trim().toLowerCase() ?? "")) protect(`Existing DIM ${item.dim!.tag} preference`);
    if (config.decisions[item.id] === "protect") protect("Explicit local protection");
    if (savedReferences.has(item.id)) protect(`Referenced by saved local builds: ${savedReferences.get(item.id)!.sort().join(", ")}`);
    if (currentReferences.has(item.id)) protect(`Current recommended build loadout: ${currentReferences.get(item.id)!.sort().join(", ")}`);
    if (item.exotic && !siblings.length) protect("Only owned copy of this exotic");
    if (!siblings.length) protect("Only owned copy of this exact weapon/armor family; no owned replacement");
    const slotPeers = allOwned.filter((copy) => equipment(copy) && copy.type === item.type && copy.slot === item.slot && (item.type !== "armor" || copy.classType === item.classType));
    if (item.slot && Number.isFinite(item.power) && !slotPeers.some((copy) => Number.isFinite(copy.power) && copy.power! > item.power!)) protect("Highest relevant Power item in this slot (including ties)");
    if (item.type === "weapon" && item.crafted) protect("Crafted weapon; retain crafting flexibility");
    if (item.type === "weapon" && item.enhanced) protect("Enhanced weapon; retain invested enhancement");
    const uniqueRoll = activeRoll(item) !== "" && siblings.length > 0 && !siblings.some((copy) => activeRoll(copy) === activeRoll(item));
    if (uniqueRoll) { protect("Unique selected perk combination in this exact family"); uniqueThings.push("Unique selected perk combination"); }
    if (["rare", "unobtainable", "legacy"].includes(item.sourceStatus ?? "")) protect(`Rare, unobtainable or legacy source: ${item.sourceStatus}`);
    if (!sourceKnown(item)) unknowns.push("Acquisition/source status unknown; availability and legacy value are unverified");
    if (item.highValueNiche === true) protect("High-value niche role recorded locally");
    if (!item.known) unknowns.push("Unresolved item definition");
    if (!item.instanceId) unknowns.push("Missing per-instance identity");
    if ((idCounts.get(item.id) ?? 0) > 1) unknowns.push("Duplicate inventory identity; cannot uniquely identify this copy");
    if (!equipment(item)) unknowns.push("Item type unresolved or outside weapon/armor cleanup");
    if (!item.slot || !item.tier || !Number.isFinite(item.power)) unknowns.push("Slot, tier or Power evidence incomplete");
    if ([item.locked, item.equipped, item.crafted, item.enhanced, item.masterworked, item.exotic].some((value) => typeof value !== "boolean")) unknowns.push("Protection state evidence incomplete");
    if (!item.stats || !Object.keys(item.stats).length || Object.values(item.stats).some((value) => !Number.isFinite(value))) unknowns.push("Exact owned stats unavailable or invalid; no stats inferred");
    let alternatives: CleanupAlternative[] = [];
    if (item.type === "weapon") {
      const evaluation = evaluations.get(item.id), weaponFamily = weapons.families.find((entry) => entry.itemHash === item.itemHash);
      if (!compatibleAnalysis) unknowns.push("Weapon analysis snapshot/manifest differs from current inventory");
      if (!evaluation || !weaponFamily) unknowns.push("Weapon role analysis unavailable");
      else {
        unknowns.push(...evaluation.unknowns);
        if (evaluation.preservationEvidence.uniqueAvailableOptions) { protect("Unique available perk options; alternate roll value unmodeled"); uniqueThings.push("Unique available perk options"); }
        const roles = Object.entries(weaponFamily.representatives).filter(([, ids]) => ids.includes(item.id)).map(([role]) => role).sort();
        if (roles.length) protect(`Strong representative of useful roles (preserve diversity): ${roles.join(", ")}`);
        if (weapons.ratingsMetadata.confidence !== "high" || weapons.ratingsMetadata.verifiedAt === null) unknowns.push("Weapon ratings are draft/unverified; provisional dominance cannot justify dismantling");
        if (!weaponFamily.usefulRoles.length) unknowns.push("No useful weapon roles established");
        for (const comparison of weaponFamily.comparisons) {
          const betterId = comparison.outcome === "LEFT_DOMINATES" && comparison.rightItemId === item.id ? comparison.leftItemId :
            comparison.outcome === "RIGHT_DOMINATES" && comparison.leftItemId === item.id ? comparison.rightItemId : null;
          if (!betterId) continue;
          if (comparison.provisional) { unknowns.push("Provisional weapon comparison is not definitive cleanup evidence"); continue; }
          const better = byId.get(betterId), betterEvaluation = evaluations.get(betterId);
          const superior = comparison.roles.map((role) => ({ role: role.role, better: comparison.leftItemId === betterId ? role.leftScore : role.rightScore, worse: comparison.leftItemId === betterId ? role.rightScore : role.leftScore }));
          if (!compatibleAnalysis || !better || better.type !== "weapon" || better.itemHash !== item.itemHash || !better.known || !better.instanceId ||
            !betterEvaluation || betterEvaluation.unknowns.length || better.slot !== item.slot || better.damageType !== item.damageType || better.ammoType !== item.ammoType ||
            better.tier !== item.tier || better.exotic !== item.exotic || !sameStats(better, item) || !Number.isFinite(better.power) || better.power! < item.power! ||
            better.crafted !== item.crafted || better.enhanced !== item.enhanced || better.masterworked !== item.masterworked ||
            superior.length !== weaponFamily.usefulRoles.length || !superior.every((role) => role.better >= role.worse) || !superior.some((role) => role.better > role.worse)) continue;
          alternatives.push({ itemId: better.id, itemHash: better.itemHash, name: better.name, reasons: superior.map((role) => `${role.role}: replacement ${role.better} >= this copy ${role.worse}`) });
        }
        if (weaponFamily.comparisons.some((comparison) => (comparison.leftItemId === item.id || comparison.rightItemId === item.id) && comparison.outcome === "INSUFFICIENT_EVIDENCE")) unknowns.push("At least one family comparison has incomplete evidence; unmodeled alternatives remain");
      }
    } else if (item.type === "armor") {
      if (!item.classType) unknowns.push("Armor class unknown");
      if (item.armorStatsExact !== true || !config.armorStatHashes.every((axis) => typeof item.stats?.[axis] === "number" && Number.isFinite(item.stats[axis]) && item.stats[axis]! >= 0)) unknowns.push("Exact six-axis owned armor distribution unverified; REVIEW rather than inferred stats");
      if (item.armorSet === undefined || item.armorSetBonus === undefined || !item.gearTier) unknowns.push("Armor set, set bonus or gear tier unknown");
      if (item.currentSetBonusNeeded === true || (item.armorSet && item.currentSetBonusNeeded !== false)) protect("Current armor set piece needed or potentially needed for a set bonus");
      if (item.availablePerks.length || item.sockets.some((socket) => socket.available.length)) unknowns.push("Armor socket alternatives and mod compatibility unmodeled");
      if (siblings.some((copy) => armorSocketSignature(copy) !== armorSocketSignature(item))) unknowns.push("Armor socket configurations differ; stat/mod/artifice effects and permanent stat superiority are unmodeled");
      if (item.selectedPerks.some((perk) => perk.enabled !== false && (!perk.known || !item.sockets.some((socket) => socket.visible !== false && socket.selected?.hash === perk.hash && socket.selected.enabled !== false)))) unknowns.push("Armor selected perk or matching active socket evidence unresolved; unique effects cannot be evaluated");
      for (const better of siblings) if (armorDominates(better, item, config)) alternatives.push({ itemId: better.id, itemHash: better.itemHash, name: better.name,
        reasons: ["Same family, class, slot, exotic status, armor set/bonus and gear tier; no unique build purpose", "No lower Power; every owned stat is at least as high and at least one is strictly higher", ...config.armorStatHashes.map((axis) => `Stat ${axis}: replacement ${better.stats![axis]} >= this copy ${item.stats![axis]}`)] });
    }
    const beforeSourceCheck = alternatives.length;
    alternatives = alternatives.filter((alternative) => {
      const better = byId.get(alternative.itemId)!;
      return sourceKnown(better) && (idCounts.get(better.id) ?? 0) === 1 && !metadataConflicts.has(better.id);
    });
    if (beforeSourceCheck > alternatives.length) unknowns.push("A better copy has unknown source, conflicting local facts or ambiguous identity; replacement value is unverified");
    if (item.masterworked && (!alternatives.some((better) => byId.get(better.itemId)?.masterworked) || unknowns.length)) protect("Masterworked investment; no clearly redundant equally masterworked replacement established");
    alternatives = alternatives.sort((a, b) => a.itemId.localeCompare(b.itemId));
    const uniqueUnknowns = [...new Set(unknowns)].sort();
    const confidence = alternatives.length && !uniqueUnknowns.length ? 95 : 0;
    const classification: CleanupClassification = protectionReasons.length ? "PROTECTED" : config.decisions[item.id] === "keep" ? "KEEP" :
      config.decisions[item.id] === "review" || uniqueUnknowns.length ? "REVIEW" : confidence >= config.threshold ? "DISMANTLE_CANDIDATE" : alternatives.length ? "REVIEW" : "KEEP";
    const reasons = classification === "PROTECTED" ? [...protectionReasons] : classification === "DISMANTLE_CANDIDATE" ? [
      `${family.length} owned copies of this exact family; another retained owned copy strictly dominates across every identified useful role/stat axis`,
      "No equipment lock, DIM preservation preference, saved/current build reference, unique roll, niche representative or source/set protection applies",
      "All required evidence is present; replacement preserves Power and relevant contexts", `Conservative evidence score ${confidence} meets threshold ${config.threshold}; advisory only`,
    ] : classification === "REVIEW" ? [...uniqueUnknowns, ...(alternatives.length ? [`Evidence score ${confidence}; threshold ${config.threshold}`] : []), ...(config.decisions[item.id] === "review" ? ["Explicit local review decision"] : [])] :
      [config.decisions[item.id] === "keep" ? "Explicit local keep decision" : "No strict dominance by another owned copy established; retain role/stat diversity"];
    result.push({ itemId: item.id, itemHash: item.itemHash, name: item.name, type: item.type, slot: item.slot, location: item.location,
      weaponType: item.type === "weapon" ? item.typeName : null, element: item.damageType, classification, confidence, reasons,
      protectionReasons, unknowns: uniqueUnknowns, betterOwnedAlternatives: alternatives, uniqueThings,
      buildsAffected: [...new Set([...(savedReferences.get(item.id) ?? []), ...(currentReferences.get(item.id) ?? [])])].sort(),
      sourceStatus: item.sourceStatus ?? "unknown", familyItemIds: family.map((copy) => copy.id).sort() });
  }
  // Every proposed removal must name a replacement that remains outside the candidate set.
  const candidates = new Set(result.filter((item) => item.classification === "DISMANTLE_CANDIDATE").map((item) => item.itemId));
  const resultsById = new Map(result.map((item) => [item.itemId, item]));
  for (const item of result) if (item.classification === "DISMANTLE_CANDIDATE") {
    item.betterOwnedAlternatives = item.betterOwnedAlternatives.filter((alternative) => !candidates.has(alternative.itemId) && resultsById.get(alternative.itemId)?.unknowns.length === 0);
    if (!item.betterOwnedAlternatives.length) { item.classification = "REVIEW"; item.confidence = 0; item.unknowns.push("No retained fully evaluated better owned alternative survives simultaneous cleanup"); item.reasons = [...item.unknowns]; }
  }
  const counts: CleanupAnalysis["counts"] = { PROTECTED: 0, KEEP: 0, REVIEW: 0, DISMANTLE_CANDIDATE: 0 };
  for (const item of result) counts[item.classification]++;
  return { analysisVersion: CLEANUP_ANALYSIS_VERSION, snapshotId: snapshotId(snapshot), manifestVersion: snapshot.manifestVersion,
    configVersion: cleanupConfigVersion(config), weaponRatingsVersion: weapons.ratingsVersion, threshold: config.threshold, counts, items: result,
    limitations: ["Advisory only. No equipment destruction or automatic tagging. DIM Junk export requires explicit selection and current candidate verification.",
      "Confidence is a deterministic evidence score, not a measured probability of safety; the default threshold is 90.",
      "Provisional weapon ratings/comparisons and missing source, stat or armor set/tier evidence cannot establish candidates.",
      "Armor comparison is limited to exact same-family six-axis distributions and matching set/tier contexts; loadout mods and set optimization remain unmodeled.",
      "Local itemFacts are explicit vetted facts, never inferred from names. Existing hard protections always win over local decisions."] };
}

export function formatCleanupAnalysis(analysis: CleanupAnalysis): string {
  const lines = ["Vault cleanup — advisory review", `Analysis ${analysis.analysisVersion}; snapshot ${analysis.snapshotId}; threshold ${analysis.threshold}`,
    ...Object.entries(analysis.counts).map(([classification, count]) => `${classification}: ${count}`), ...analysis.limitations];
  for (const item of analysis.items) {
    lines.push("", `${item.classification} — ${item.name} [${item.itemId}] — evidence ${item.confidence}/100`,
      ...item.reasons.map((reason) => `  ${reason}`), `  Unknowns: ${item.unknowns.join("; ") || "none identified in required fields"}`,
      `  Unique things: ${item.uniqueThings.join("; ") || "none established"}`, `  Builds affected: ${item.buildsAffected.join(", ") || "none referenced"}`, `  Acquisition/source status: ${item.sourceStatus}`,
      "  Better copies you own:", ...(item.betterOwnedAlternatives.length ? item.betterOwnedAlternatives.map((alternative) => `    ${alternative.name} [${alternative.itemId}]: ${alternative.reasons.join("; ")}`) : ["    none established"]));
  }
  return lines.join("\n") + "\n";
}
export async function writeCleanupAnalysis(analysis: CleanupAnalysis, directory: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  for (const [name, content] of [["cleanup.json", JSON.stringify(analysis, null, 2) + "\n"], ["cleanup.txt", formatCleanupAnalysis(analysis)]] as const) {
    const filename = path.join(directory, name), temporary = `${filename}.${process.pid}.tmp`;
    await writeFile(temporary, content, "utf8"); await rename(temporary, filename);
  }
}
