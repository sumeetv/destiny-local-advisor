import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { InventorySnapshot, OwnedItem } from "../inventory.js";
import { weaponRatingsVersion, type WeaponRatings } from "./weapon-config.js";

export const WEAPON_ANALYSIS_VERSION = "0.5.0";
const key = (value: string) => value.trim().toLowerCase();
const signature = (value: unknown) => JSON.stringify(value);
export interface WeaponRoleScore {
  score: number; mode: "pve" | "pvp";
  evidence: { kind: "perk" | "pair"; perks: string[]; value: number; reason: string }[];
}
export interface WeaponEvaluation {
  itemId: string; itemHash: number; name: string;
  selectedPerks: { hash: number; name: string; known: boolean }[];
  availablePerks: { hash: number; name: string; known: boolean; enabled: boolean | null; canInsert: boolean | null }[];
  roleScores: Record<string, WeaponRoleScore>; usefulRoles: string[];
  unknowns: string[]; nicheEvidence: string[];
  preservationEvidence: { equipped: boolean; locked: boolean; crafted: boolean; enhanced: boolean; masterworked: boolean; exotic: boolean; uniqueSelectedCombination: boolean; uniqueAvailableOptions: boolean; missingStats: boolean };
  dominatedBy: string[];
}
export interface WeaponComparison {
  leftItemId: string; rightItemId: string;
  outcome: "LEFT_DOMINATES" | "RIGHT_DOMINATES" | "DISTINCT_ROLES" | "EQUAL_ROLE_SCORES" | "INSUFFICIENT_EVIDENCE";
  roles: { role: string; leftScore: number; rightScore: number; explanation: string }[];
  reasons: string[];
  provisional: boolean;
}
export interface WeaponFamily {
  itemHash: number; name: string; itemIds: string[]; usefulRoles: string[];
  representatives: Record<string, string[]>; comparisons: WeaponComparison[];
}
export interface WeaponAnalysis {
  analysisVersion: string; snapshotId: string; manifestVersion: string; ratingsVersion: string;
  ratingsMetadata: WeaponRatings["metadata"]; limitations: string[];
  weapons: WeaponEvaluation[]; families: WeaponFamily[];
}

const active = (item: OwnedItem) => item.selectedPerks.filter((perk) => perk.enabled !== false);
const options = (item: OwnedItem) => item.availablePerks.filter((perk) => perk.enabled !== false && perk.canInsert !== false);
const rollSignature = (item: OwnedItem) => active(item).map((perk) => perk.hash).sort((a, b) => a - b).join(",");
const optionSignature = (item: OwnedItem) => options(item).map((perk) => `${perk.hash}:${perk.canInsert}`).sort().join(",");
const socketOptionSignature = (item: OwnedItem) => signature(item.sockets.filter((socket) => socket.available.length).map((socket) => ({ index: socket.index, visible: socket.visible, available: socket.available.map((perk) => `${perk.hash}:${perk.enabled}:${perk.canInsert}`).sort() })).sort((a, b) => a.index - b.index));

function evaluate(item: OwnedItem, siblings: OwnedItem[], ratings: WeaponRatings): WeaponEvaluation {
  const selected = active(item);
  const supported = selected.filter((perk) => !item.sockets.length || item.sockets.some((socket) => socket.visible !== false && socket.selected?.hash === perk.hash && socket.selected.enabled !== false));
  const names = new Set(supported.filter((perk) => perk.known).map((perk) => key(perk.name)));
  const config = new Map(Object.entries(ratings.perks).map(([name, values]) => [key(name), values]));
  const unknowns: string[] = [];
  if (!item.known) unknowns.push("Item definition unresolved");
  if (!selected.length) unknowns.push("No selected gameplay perks recorded");
  for (const perk of selected) {
    if (!perk.known) unknowns.push(`Unresolved selected perk: ${perk.name} (${perk.hash})`);
    else if (!config.has(key(perk.name))) unknowns.push(`Unrated selected perk: ${perk.name}`);
    if (item.sockets.length && !item.sockets.some((socket) => socket.visible !== false && socket.selected?.hash === perk.hash && socket.selected.enabled !== false)) unknowns.push(`Selected perk lacks matching active socket evidence: ${perk.name}`);
  }
  if (!item.ammoType) unknowns.push("Ammo type missing; ammo-restricted roles cannot be evaluated");
  if (!item.stats || !Object.keys(item.stats).length) unknowns.push("Owned weapon stats missing; perk scores are partial evidence");
  if (options(item).some((perk) => !perk.known || perk.canInsert === null)) unknowns.push("Available options contain unresolved definitions or uncertain insertability");
  const roleScores: Record<string, WeaponRoleScore> = {};
  for (const [role, definition] of Object.entries(ratings.roles).sort(([a], [b]) => a.localeCompare(b))) {
    if (definition.ammoTypes && (!item.ammoType || !definition.ammoTypes.some((ammo) => ammo === item.ammoType))) continue;
    const evidence: WeaponRoleScore["evidence"] = [];
    for (const name of [...names].sort()) {
      const value = config.get(name)?.[role];
      if (value !== undefined && value !== 0) evidence.push({ kind: "perk", perks: [selected.find((perk) => key(perk.name) === name)!.name], value, reason: `Selected perk contextual weight for ${role}` });
    }
    for (const pair of ratings.pairs) if (pair.perks.every((name) => names.has(key(name)))) {
      const indexes = pair.perks.map((name) => item.sockets.filter((socket) => socket.visible !== false && socket.selected?.known && socket.selected.enabled !== false && key(socket.selected.name) === key(name)).map((socket) => socket.index));
      if (!indexes[0]!.some((index) => indexes[1]!.some((other) => other !== index))) {
        const reason = `Perk pair ${pair.perks.join(" + ")}: simultaneous selected sockets not established`;
        if (!unknowns.includes(reason)) unknowns.push(reason);
        continue;
      }
      const value = pair.scores[role];
      if (value !== undefined && value !== 0) evidence.push({ kind: "pair", perks: pair.perks, value, reason: pair.reason });
    }
    if (evidence.length) roleScores[role] = { score: Math.max(0, evidence.reduce((sum, entry) => sum + entry.value, 0)), mode: definition.mode, evidence };
  }
  const usefulRoles = Object.keys(roleScores).filter((role) => roleScores[role]!.score > 0).sort();
  const uniqueSelectedCombination = siblings.length > 1 && !siblings.some((copy) => copy.id !== item.id && rollSignature(copy) === rollSignature(item));
  const uniqueAvailableOptions = options(item).length > 0 && siblings.length > 1 && !siblings.some((copy) => copy.id !== item.id && optionSignature(copy) === optionSignature(item));
  const nicheEvidence = usefulRoles.map((role) => `${role}: ${roleScores[role]!.score} local draft weight`);
  if (uniqueSelectedCombination) nicheEvidence.push("Unique selected perk combination in this family; preserve for cleanup review even if role scores are dominated");
  if (uniqueAvailableOptions) nicheEvidence.push("Unique available perk options in this family; alternative roll value has not been scored");
  if (item.crafted) nicheEvidence.push("Crafted weapon: crafting flexibility not scored");
  if (item.enhanced) nicheEvidence.push("Enhanced weapon: enhanced benefit not inferred or scored");
  return {
    itemId: item.id, itemHash: item.itemHash, name: item.name,
    selectedPerks: selected.map(({ hash, name, known }) => ({ hash, name, known })),
    availablePerks: options(item).map(({ hash, name, known, enabled, canInsert }) => ({ hash, name, known, enabled, canInsert })),
    roleScores, usefulRoles, unknowns, nicheEvidence,
    preservationEvidence: { equipped: item.equipped, locked: item.locked, crafted: item.crafted, enhanced: item.enhanced, masterworked: item.masterworked, exotic: item.exotic, uniqueSelectedCombination, uniqueAvailableOptions, missingStats: !item.stats || !Object.keys(item.stats).length },
    dominatedBy: [],
  };
}

function compare(left: WeaponEvaluation, right: WeaponEvaluation, leftItem: OwnedItem, rightItem: OwnedItem, familyRoles: string[], ratings: WeaponRatings): WeaponComparison {
  const roles = familyRoles.map((role) => {
    const leftScore = left.roleScores[role]?.score ?? 0, rightScore = right.roleScores[role]?.score ?? 0;
    return { role, leftScore, rightScore, explanation: leftScore === rightScore ? "Equal modeled selected-perk value" : `${leftScore > rightScore ? left.name + " [" + left.itemId + "]" : right.name + " [" + right.itemId + "]"} has more modeled selected-perk value` };
  });
  const reasons = [...left.unknowns.map((reason) => `Left: ${reason}`), ...right.unknowns.map((reason) => `Right: ${reason}`)];
  const sortedStats = (item: OwnedItem) => Object.entries(item.stats ?? {}).sort(([a], [b]) => a.localeCompare(b));
  if (signature(sortedStats(leftItem)) !== signature(sortedStats(rightItem))) reasons.push("Owned stats differ; raw stat totals do not establish role superiority");
  if (leftItem.ammoType !== rightItem.ammoType || leftItem.damageType !== rightItem.damageType || leftItem.slot !== rightItem.slot) reasons.push("Weapon slot, element, or ammo contexts differ or are unresolved");
  if (!leftItem.slot || !leftItem.damageType) reasons.push("Weapon slot or element missing");
  if (optionSignature(leftItem) !== optionSignature(rightItem)) reasons.push("Available perk options differ; selected-roll scores cannot establish superiority across possible alternate rolls");
  if (socketOptionSignature(leftItem) !== socketOptionSignature(rightItem)) reasons.push("Available socket layout or compatibility differs; possible alternate loadouts are unevaluated");
  if ([leftItem, rightItem].some((item) => options(item).some((perk) => !active(item).some((selected) => selected.hash === perk.hash)))) reasons.push("An alternate perk roll is available; all possible selected loadouts have not been compared");
  if (leftItem.crafted !== rightItem.crafted || leftItem.enhanced !== rightItem.enhanced || leftItem.masterworked !== rightItem.masterworked) reasons.push("Crafted, enhanced, or masterworked states differ; their value is not inferred");
  if (!roles.length) reasons.push("No useful roles identified by these ratings");
  let outcome: WeaponComparison["outcome"] = "INSUFFICIENT_EVIDENCE";
  if (!reasons.length) {
    const leftBetter = roles.some((role) => role.leftScore > role.rightScore), rightBetter = roles.some((role) => role.rightScore > role.leftScore);
    outcome = leftBetter && !rightBetter ? "LEFT_DOMINATES" : rightBetter && !leftBetter ? "RIGHT_DOMINATES" : leftBetter && rightBetter ? "DISTINCT_ROLES" : "EQUAL_ROLE_SCORES";
    reasons.push(outcome === "LEFT_DOMINATES" || outcome === "RIGHT_DOMINATES" ? "One copy is at least as strong in every family role and strictly stronger in at least one; this is contextual perk dominance only" : outcome === "DISTINCT_ROLES" ? "Each copy has an advantage in a different role; preserve role diversity" : "Equal role scores provide no strict dominance evidence");
  }
  reasons.push("Local ratings omit unmodeled niches and current sandbox validation; this comparison is not a dismantling recommendation");
  return { leftItemId: left.itemId, rightItemId: right.itemId, outcome, roles, reasons, provisional: ratings.metadata.confidence !== "high" || ratings.metadata.verifiedAt === null };
}

export function analyzeWeapons(snapshot: InventorySnapshot, ratings: WeaponRatings): WeaponAnalysis {
  const owned = snapshot.items.filter((item) => item.type === "weapon" && item.quantity > 0).sort((a, b) => a.itemHash - b.itemHash || a.id.localeCompare(b.id));
  const grouped = new Map<number, OwnedItem[]>();
  for (const item of owned) grouped.set(item.itemHash, [...(grouped.get(item.itemHash) ?? []), item]);
  const weapons: WeaponEvaluation[] = [], families: WeaponFamily[] = [];
  for (const [itemHash, items] of grouped) {
    const evaluations = items.map((item) => evaluate(item, items, ratings));
    const usefulRoles = [...new Set(evaluations.flatMap((item) => item.usefulRoles))].sort();
    const comparisons: WeaponComparison[] = [];
    for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) {
      const result = compare(evaluations[i]!, evaluations[j]!, items[i]!, items[j]!, usefulRoles, ratings);
      if (result.outcome === "LEFT_DOMINATES") evaluations[j]!.dominatedBy.push(items[i]!.id);
      if (result.outcome === "RIGHT_DOMINATES") evaluations[i]!.dominatedBy.push(items[j]!.id);
      comparisons.push(result);
    }
    const representatives = Object.fromEntries(usefulRoles.map((role) => {
      const best = Math.max(...evaluations.map((item) => item.roleScores[role]?.score ?? 0));
      return [role, evaluations.filter((item) => item.roleScores[role]?.score === best).map((item) => item.itemId)];
    }));
    families.push({ itemHash, name: items[0]!.name, itemIds: items.map((item) => item.id), usefulRoles, representatives, comparisons });
    weapons.push(...evaluations);
  }
  return { analysisVersion: WEAPON_ANALYSIS_VERSION, snapshotId: snapshot.source?.rawSnapshot ?? snapshot.profileTimestamp ?? snapshot.importedAt, manifestVersion: snapshot.manifestVersion, ratingsVersion: weaponRatingsVersion(ratings), ratingsMetadata: ratings.metadata,
    limitations: ["Contextual selected-perk weights only; no authoritative overall god-roll score.", "Available options are recorded separately, never scored as active or combined into inferred rolls.", "Strict dominance means no worse in any identified family role and better in at least one. Missing/unrated data, differing stats/options or unmodeled crafted/enhanced/masterwork value block dominance.", "Unique combinations, role representatives, and preservation evidence remain available for later conservative cleanup. No cleanup classifications or destruction actions are implemented."], weapons, families };
}

export function formatWeaponAnalysis(analysis: WeaponAnalysis): string {
  const lines = ["Weapon role evaluation", `Analysis ${analysis.analysisVersion}; ratings ${analysis.ratingsMetadata.confidence}; sandbox ${analysis.ratingsMetadata.sandboxVersion}`, ...analysis.limitations];
  for (const family of analysis.families) {
    lines.push("", `${family.name} (${family.itemHash}) — ${family.itemIds.length} owned`, `  Useful roles: ${family.usefulRoles.join(", ") || "none recognized"}`);
    for (const id of family.itemIds) {
      const weapon = analysis.weapons.find((item) => item.itemId === id)!;
      lines.push(`  [${id}] Selected: ${weapon.selectedPerks.map((perk) => perk.name).join(" + ") || "missing"}`, `    Available options (not active): ${weapon.availablePerks.map((perk) => `${perk.name} (${perk.canInsert === true ? "insertable" : "insertability unknown"})`).join("; ") || "none recorded"}`);
      for (const [role, value] of Object.entries(weapon.roleScores)) lines.push(`    ${role} (${value.mode}): ${value.score} — ${value.evidence.map((entry) => `${entry.perks.join(" + ")}: ${entry.value} (${entry.reason})`).join("; ")}`);
      lines.push(`    Unknown: ${weapon.unknowns.join("; ") || "none identified in modeled fields"}`, `    Contextually dominated by: ${weapon.dominatedBy.join(", ") || "none established"}`, `    Preserve/review evidence: ${weapon.nicheEvidence.join("; ") || "none identified"}`);
    }
    for (const comparison of family.comparisons) {
      lines.push(`  Compare [${comparison.leftItemId}] vs [${comparison.rightItemId}]: ${comparison.outcome}`, ...comparison.roles.map((role) => `    ${role.role}: ${role.leftScore} vs ${role.rightScore} — ${role.explanation}`), ...comparison.reasons.map((reason) => `    ${reason}`));
    }
  }
  return lines.join("\n") + "\n";
}
export async function writeWeaponAnalysis(analysis: WeaponAnalysis, directory: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  for (const [name, content] of [["weapon-analysis.json", JSON.stringify(analysis, null, 2) + "\n"], ["weapon-analysis.txt", formatWeaponAnalysis(analysis)]] as const) {
    const filename = path.join(directory, name), temporary = `${filename}.${process.pid}.tmp`;
    await writeFile(temporary, content, "utf8"); await rename(temporary, filename);
  }
}
