import { createHash } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { InventorySnapshot, OwnedItem } from "../inventory.js";
import type { BuildPreferences, BuildTemplate } from "./build-config.js";
import type { WeaponAnalysis } from "./weapons.js";

export const BUILD_ANALYSIS_VERSION = "0.5.0";
const key = (name: string) => name.trim().toLowerCase();
const TRAITS: Record<string, { perks: string[]; element?: string }> = {
  "grenade-energy": { perks: ["Demolitionist", "Wellspring"] },
  "melee-energy": { perks: ["Pugilist", "Wellspring", "Monte Carlo Method"] },
  "area-damage": { perks: ["Chain Reaction", "Incandescent", "Voltshot", "Destabilizing Rounds", "Headstone", "Hatchling", "Explosive Payload"] },
  "solar-synergy": { perks: ["Incandescent", "Heal Clip"], element: "Solar" },
  "arc-synergy": { perks: ["Voltshot", "Eddy Current"], element: "Arc" },
  "void-synergy": { perks: ["Repulsor Brace", "Destabilizing Rounds"], element: "Void" },
  "stasis-synergy": { perks: ["Headstone", "Chill Clip"], element: "Stasis" },
  "strand-synergy": { perks: ["Hatchling", "Slice"], element: "Strand" },
};
export interface WeaponSuggestion {
  itemId: string; name: string; slot: string; exotic: boolean; score: number;
  reasons: string[]; availablePerkOptions: string[];
  contextualRoles?: Record<string, number>;
}
export interface BuildResult {
  id: string; name: string; score: number;
  readiness: "READY_NOW" | "MISSING_REQUIRED" | "NEEDS_VERIFICATION";
  readyNow: boolean; owned: string[]; missing: string[]; unknown: string[];
  requiredItemIds: string[]; recommendedItemIds: string[];
  substitutions: { name: string; itemIds: string[]; explanation: string }[];
  bestOwnedWeapons: WeaponSuggestion[];
  upgrades: { name: string; reason: string; kind: "gear" | "configuration" | "verification" }[];
  scoreBreakdown: { ownedGear: number; abilityEvidence: number; weaponSynergy: number; preferenceMatch: number };
  fitDetails: { armorSetSynergy: "unknown"; statCompatibility: "unknown"; acquisitionEffort: "unknown" };
  notes: string[]; metadata: BuildTemplate["metadata"];
}
export interface BuildAnalysis {
  analysisVersion: string; manifestVersion: string; snapshotId: string;
  buildDefinitionVersion: string; preferenceVersion: string;
  weaponRatingsVersion?: string;
  characterClass: string; builds: BuildResult[];
}

function ownedArmor(snapshot: InventorySnapshot, name: string, classType: string): OwnedItem[] {
  return snapshot.items.filter((item) => item.known && item.type === "armor" && item.exotic && item.classType === classType && item.quantity > 0 && key(item.name) === key(name)).sort((a, b) => a.id.localeCompare(b.id));
}

/** A small template matcher, not the contextual roll evaluator planned for Phase 5. */
function weaponsFor(snapshot: InventorySnapshot, build: BuildTemplate, preferences: BuildPreferences, weaponAnalysis?: WeaponAnalysis): WeaponSuggestion[] {
  const suggestions = snapshot.items.filter((item) => item.known && item.type === "weapon" && (item.classType === null || item.classType === build.class) && item.quantity > 0 && ["Kinetic", "Energy", "Power"].includes(item.slot ?? "")).map((item): WeaponSuggestion => {
    const selected = new Set(item.selectedPerks.filter((perk) => perk.known && perk.enabled !== false).map((perk) => key(perk.name)));
    const available = item.availablePerks.filter((perk) => perk.known && perk.enabled !== false && perk.canInsert === true);
    const reasons: string[] = [];
    const options = new Set<string>();
    let score = 0;
    for (const trait of build.preferred.weaponTraits) {
      const definition = TRAITS[trait];
      if (!definition) continue;
      const matching = definition.perks.filter((perk) => selected.has(key(perk)));
      if (matching.length) { score += 4; reasons.push(`${trait}: selected ${matching.join(" / ")}`); }
      else if (definition.element && item.damageType === definition.element) { score += 1; reasons.push(`${definition.element} damage matches subclass`); }
      for (const perk of available) if (definition.perks.some((name) => key(name) === key(perk.name)) && !selected.has(key(perk.name))) options.add(perk.name);
    }
    const evaluation = weaponAnalysis?.weapons.find((weapon) => weapon.itemId === item.id);
    const traitRoles: Record<string, string[]> = { "grenade-energy": ["ability-engine"], "melee-energy": ["ability-engine"], "area-damage": ["add-clear"] };
    const relevantRoles = [...new Set(build.preferred.weaponTraits.flatMap((trait) => traitRoles[trait] ?? [trait]))];
    const contextualRoles = evaluation ? Object.fromEntries(relevantRoles.flatMap((role) => evaluation.roleScores[role] ? [[role, evaluation.roleScores[role]!.score]] : [])) : undefined;
    if (evaluation) {
      score += Math.min(4, Object.values(contextualRoles!).reduce((sum, value) => sum + value, 0) / 10);
      for (const [role, value] of Object.entries(contextualRoles!)) reasons.push(`${role}: ${value} draft contextual selected-perk weight`);
      if (evaluation.unknowns.length) reasons.push("Partial roll evidence; see weapon analysis unknowns");
    }
    if (preferences.preferences.favorites.weapons.some((name) => key(name) === key(item.name))) { score += 1; reasons.push("Personal favorite"); }
    if (!reasons.length) reasons.push("Owned slot fallback; no recognized selected-perk synergy");
    return { itemId: item.id, name: item.name, slot: item.slot!, exotic: item.exotic, score, reasons, availablePerkOptions: [...options].sort(), ...(contextualRoles ? { contextualRoles } : {}) };
  }).sort((a, b) => b.score - a.score || a.name.localeCompare(b.name) || a.itemId.localeCompare(b.itemId));
  // Enumerate allowed exotic choices so one greedy slot cannot block a better total loadout.
  const choices = [null, ...suggestions.filter((item) => item.exotic)];
  const loadouts = choices.map((exotic) => ["Kinetic", "Energy", "Power"].flatMap((slot) => {
    const weapon = exotic?.slot === slot ? exotic : suggestions.find((item) => item.slot === slot && !item.exotic);
    return weapon ? [weapon] : [];
  }));
  loadouts.sort((a, b) => b.reduce((sum, item) => sum + item.score, 0) - a.reduce((sum, item) => sum + item.score, 0) || a.map((item) => item.itemId).join().localeCompare(b.map((item) => item.itemId).join()));
  return loadouts[0] ?? [];
}

function preferenceFit(build: BuildTemplate, config: BuildPreferences): number {
  const preferences = config.preferences;
  const style = build.playstyles.reduce((sum, name) => sum + (preferences.playstyles[name] ?? 0), 0) / (10 * build.playstyles.length);
  const priorityWeight = Object.values(preferences.priorities).reduce((sum, weight) => sum + weight, 0);
  const priorities = priorityWeight ? Object.entries(preferences.priorities).reduce((sum, [name, weight]) => sum + weight * (build.ratings[name] ?? 0), 0) / (10 * priorityWeight) : 0;
  const history = build.history.some((name) => preferences.history.includes(name)) ? 1 : 0;
  const exoticNames = [build.required.exoticArmor, ...build.preferred.exoticArmor].filter(Boolean);
  const favorite = preferences.favorites.exotics.some((name) => exoticNames.some((exotic) => exotic && key(name) === key(exotic))) ? 1 : 0;
  return 30 * (style * 0.65 + priorities * 0.2 + history * 0.1 + favorite * 0.05);
}

function evaluateBuild(snapshot: InventorySnapshot, build: BuildTemplate, preferences: BuildPreferences, weaponAnalysis?: WeaponAnalysis): BuildResult {
  const owned: string[] = [], missing: string[] = [], unknown: string[] = [];
  const upgrades: BuildResult["upgrades"] = [];
  const characters = snapshot.characters.filter((character) => character.classType === build.class);
  if (!characters.length) missing.push(`${build.class} character`);
  const capabilities = (snapshot.subclassCapabilities ?? []).filter((entry) => entry.classType === build.class && entry.subclass === build.required.subclass && characters.some((character) => character.id === entry.characterId));
  // All ability requirements must be available to the same character and subclass.
  const byCharacter = new Map<string, Set<string>>();
  for (const entry of capabilities) {
    const abilities = byCharacter.get(entry.characterId) ?? new Set<string>();
    for (const name of entry.abilities) abilities.add(key(name));
    byCharacter.set(entry.characterId, abilities);
  }
  const available = [...byCharacter.entries()].sort(([aid, a], [bid, b]) => build.required.abilities.filter((name) => b.has(key(name))).length - build.required.abilities.filter((name) => a.has(key(name))).length || aid.localeCompare(bid))[0]?.[1];
  if (available) owned.push(`${build.required.subclass} subclass (owned character item)`);
  else unknown.push(`${build.required.subclass} subclass unlock: no positive account evidence`);
  let confirmedAbilities = available ? 1 : 0;
  for (const name of build.required.abilities) {
    if (available?.has(key(name))) { owned.push(name); confirmedAbilities++; }
    else unknown.push(`${name}: unlock not established by this snapshot`);
  }
  const requiredArmor = build.required.exoticArmor ? ownedArmor(snapshot, build.required.exoticArmor, build.class) : [];
  if (build.required.exoticArmor) {
    if (requiredArmor.length) owned.push(`${build.required.exoticArmor} (${requiredArmor.length} owned)`);
    else if (snapshot.items.some((item) => !item.known)) unknown.push(`${build.required.exoticArmor}: unresolved inventory items prevent confirming absence`);
    else missing.push(build.required.exoticArmor);
    if (!requiredArmor.length) upgrades.push({ name: build.required.exoticArmor, reason: "Required exotic for this exact template; obtain or resolve ownership.", kind: "gear" });
  }
  const preferredArmor = build.preferred.exoticArmor.flatMap((name) => ownedArmor(snapshot, name, build.class));
  for (const name of build.preferred.exoticArmor) {
    const matches = ownedArmor(snapshot, name, build.class);
    if (matches.length) owned.push(`${name} (optional exotic alternative)`);
    else upgrades.push({ name, reason: "Optional exotic alternative; equip only one exotic armor piece.", kind: "gear" });
  }
  const substitutions = build.substitutions.flatMap((name) => {
    const items = ownedArmor(snapshot, name, build.class);
    return items.length ? [{ name, itemIds: items.map((item) => item.id), explanation: "Owned alternative concept. Adjust the ability loop; this does not satisfy the exact template's required exotic or unlock evidence." }] : [];
  });
  const bestOwnedWeapons = weaponsFor(snapshot, build, preferences, weaponAnalysis);
  for (const weapon of bestOwnedWeapons) if (weapon.availablePerkOptions.length) upgrades.push({ name: weapon.name, kind: "configuration", reason: `Owned insertable options: ${weapon.availablePerkOptions.join(", ")}. Check socket compatibility before changing the roll.` });
  if (unknown.length) upgrades.push({ name: "Verify subclass abilities", kind: "verification", reason: "Inspect unlocks in game or refresh with subclass socket evidence. Unknown unlocks do not establish ready-now status." });
  upgrades.push({ name: "Armor stats and set bonuses", kind: "verification", reason: "Exact armor loadout, stat breakpoints, mod energy and set bonuses are not evaluated by this baseline matcher." });
  const requiredItemIds = requiredArmor.map((item) => item.id);
  const selectedArmor = requiredArmor[0] ?? preferredArmor.sort((a, b) => a.id.localeCompare(b.id))[0];
  const scoreBreakdown = {
    ownedGear: build.required.exoticArmor ? (requiredArmor.length ? 35 : 0) : 25 + (preferredArmor.length ? 10 : 0),
    abilityEvidence: 25 * confirmedAbilities / (1 + build.required.abilities.length),
    weaponSynergy: Math.min(10, bestOwnedWeapons.reduce((sum, item) => sum + item.score, 0)),
    preferenceMatch: preferenceFit(build, preferences),
  };
  const readiness = missing.length ? "MISSING_REQUIRED" : unknown.length ? "NEEDS_VERIFICATION" : "READY_NOW";
  return {
    id: build.id, name: build.name, score: Math.round(Object.values(scoreBreakdown).reduce((sum, value) => sum + value, 0)),
    readiness, readyNow: readiness === "READY_NOW", owned, missing, unknown, requiredItemIds,
    recommendedItemIds: [...(selectedArmor ? [selectedArmor.id] : []), ...bestOwnedWeapons.map((item) => item.itemId)],
    substitutions, bestOwnedWeapons, upgrades, scoreBreakdown,
    fitDetails: { armorSetSynergy: "unknown", statCompatibility: "unknown", acquisitionEffort: "unknown" },
    notes: [...build.notes, "Ready now means required exotic and ability evidence are present; full armor/mod/stat optimization and current sandbox performance still require review."], metadata: build.metadata,
  };
}

export function analyzeBuilds(snapshot: InventorySnapshot, templates: BuildTemplate[], preferences: BuildPreferences, versions?: { buildDefinitionVersion: string; preferenceVersion: string }, weaponAnalysis?: WeaponAnalysis): BuildAnalysis {
  const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
  return {
    analysisVersion: BUILD_ANALYSIS_VERSION, manifestVersion: snapshot.manifestVersion,
    snapshotId: snapshot.source?.rawSnapshot ?? snapshot.profileTimestamp ?? snapshot.importedAt,
    buildDefinitionVersion: versions?.buildDefinitionVersion ?? digest(templates), preferenceVersion: versions?.preferenceVersion ?? digest(preferences),
    ...(weaponAnalysis ? { weaponRatingsVersion: weaponAnalysis.ratingsVersion } : {}),
    characterClass: preferences.preferences.class,
    builds: templates.filter((build) => build.class === preferences.preferences.class && build.mode === "pve").map((build) => evaluateBuild(snapshot, build, preferences, weaponAnalysis)).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)),
  };
}

export function formatBuildAnalysis(analysis: BuildAnalysis): string {
  const lines = [`${analysis.characterClass} build recommendations`, `Analysis ${analysis.analysisVersion}; snapshot ${analysis.snapshotId}`, "Fit scores express inventory evidence and personal preference, not a sandbox tier list."];
  for (const [index, build] of analysis.builds.entries()) {
    lines.push("", `${index + 1}. ${build.name} — ${build.score}/100`, `   Ready now: ${build.readyNow ? "yes" : "no"} (${build.readiness})`,
      `   Owned: ${build.owned.join("; ") || "none confirmed"}`, `   Missing: ${build.missing.join("; ") || "none confirmed"}`,
      `   Unknown: ${build.unknown.join("; ") || "none"}`, `   Substitutions: ${build.substitutions.map((entry) => `${entry.name} (adjust loop)`).join("; ") || "none owned"}`,
      "   Best currently owned weapons:", ...build.bestOwnedWeapons.map((weapon) => `     ${weapon.slot}: ${weapon.name} [${weapon.itemId}] — ${weapon.reasons.join("; ")}`),
      ...(!build.bestOwnedWeapons.length ? ["     none with resolved slots"] : []), "   Upgrade opportunities:", ...build.upgrades.map((entry) => `     ${entry.name}: ${entry.reason}`),
      `   Template: ${build.metadata.confidence}; sandbox ${build.metadata.sandboxVersion}; verified ${build.metadata.verifiedAt ?? "not verified"}`);
  }
  return lines.join("\n") + "\n";
}

export async function writeBuildAnalysis(analysis: BuildAnalysis, directory: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  for (const [name, content] of [["builds.json", JSON.stringify(analysis, null, 2) + "\n"], ["builds.txt", formatBuildAnalysis(analysis)]] as const) {
    const filename = path.join(directory, name), temporary = `${filename}.${process.pid}.tmp`;
    await writeFile(temporary, content, "utf8");
    await rename(temporary, filename);
  }
}
