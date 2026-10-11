import { createHash } from "node:crypto";
import type { InventorySnapshot, OwnedItem } from "../inventory.js";
import type { BuildPreferences, BuildTemplate } from "./build-config.js";
import { analyzeBuilds, type BuildAnalysis, type BuildResult } from "./builds.js";
import { acquisitionVersion, defaultAcquisitionConfig, type AcquisitionConfig } from "./acquisition-config.js";

export const ACQUISITION_ANALYSIS_VERSION = "0.9.0";
const key = (value: string) => value.trim().toLowerCase();
const round = (value: number) => Math.round(value * 1000) / 1000;
const owned = (snapshot: InventorySnapshot, name: string, classType: string) => snapshot.items.filter((item) => item.known && item.type === "armor" && item.exotic && item.quantity > 0 && item.classType === classType && key(item.name) === key(name)).sort((a, b) => a.id.localeCompare(b.id));
export interface PursuitImpact {
  buildId: string; buildName: string; kind: "required" | "optional-alternative";
  unlocksReadyBuild: boolean; readinessAfter: BuildResult["readiness"];
  scoreGain: number; magnitude: number; preferenceMatch: number; substituteFactor: number; contribution: number;
  existingSubstitutes: { name: string; itemIds: string[] }[]; blockers: string[]; reasons: string[];
  templateConfidence: BuildTemplate["metadata"]["confidence"];
}
export interface AcquisitionPursuit {
  id: string; name: string; class: string; rank: number;
  buildsUnlocked: number; requiredBuildsImproved: number; optionalAlternatives: number;
  marginalValue: number; valuePerEffort: number | null;
  effort: "unknown" | "low" | "moderate" | "high"; effortUnits: number | null;
  availability: "unknown" | "available" | "unavailable"; source: string | null;
  metadata: AcquisitionConfig["items"][number]["metadata"] | null;
  impacts: PursuitImpact[]; nextSteps: string[];
}
export interface AcquisitionAnalysis {
  schemaVersion: 1; analysisVersion: string; characterClass: string;
  provenance: { snapshotId: string; snapshotDigest: string; manifestVersion: string; buildDefinitionVersion: string; preferenceVersion: string; acquisitionConfigVersion: string; buildAnalysisVersion: string };
  rankingPolicy: string; pursuits: AcquisitionPursuit[];
  verification: { name: string; reasons: string[] }[]; unavailable: AcquisitionPursuit[]; deferred: AcquisitionPursuit[]; limitations: string[];
}

/** Planning-only gear. It never enters ingestion, history, cleanup or a recommended real loadout. */
function hypotheticalArmor(name: string, classType: string): OwnedItem {
  return { id: `planning:${classType}:${key(name)}`, instanceId: null, itemHash: 0, name, description: "Planning only", known: true,
    type: "armor", typeName: "Exotic Armor", classType, characterId: null, location: "other", locationLabel: "Hypothetical",
    equipped: false, locked: false, masterworked: false, crafted: false, enhanced: false, exotic: true, quantity: 1,
    slot: null, ammoType: null, damageType: null, power: null, tier: "Exotic", stats: null, sockets: [], selectedPerks: [], availablePerks: [] };
}

export function analyzeAcquisition(snapshot: InventorySnapshot, templates: BuildTemplate[], preferences: BuildPreferences,
  config: AcquisitionConfig = defaultAcquisitionConfig, suppliedBuilds?: BuildAnalysis): AcquisitionAnalysis {
  const builds = suppliedBuilds ?? analyzeBuilds(snapshot, templates, preferences);
  const classType = preferences.preferences.class;
  const eligible = templates.filter((build) => build.class === classType && build.mode === "pve");
  const names = [...new Set(eligible.flatMap((build) => [build.required.exoticArmor, ...build.preferred.exoticArmor]).filter((name): name is string => Boolean(name)).map(key))].sort();
  const verification: AcquisitionAnalysis["verification"] = [], all: AcquisitionPursuit[] = [];
  for (const normalized of names) {
    const affected = eligible.filter((build) => [build.required.exoticArmor, ...build.preferred.exoticArmor].some((name) => name && key(name) === normalized));
    const name = affected.flatMap((build) => [build.required.exoticArmor, ...build.preferred.exoticArmor]).find((name) => name && key(name) === normalized)!;
    if (owned(snapshot, name, classType).length) continue;
    const absenceReasons = [
      ...(!snapshot.characters.some((character) => character.classType === classType) ? [`No ${classType} character in this snapshot.`] : []),
      ...(snapshot.inventoryCoverage !== "complete" ? ["Complete inventory coverage is not established; absence is unconfirmed."] : []),
      ...(snapshot.items.some((item) => !item.known && item.quantity > 0) ? ["Unresolved inventory items prevent confirming ownership absence."] : []),
    ];
    if (absenceReasons.length) { verification.push({ name, reasons: absenceReasons }); continue; }
    const after = analyzeBuilds({ ...snapshot, items: [...snapshot.items, hypotheticalArmor(name, classType)] }, templates, preferences);
    const impacts = affected.map((template): PursuitImpact => {
      const before = builds.builds.find((build) => build.id === template.id)!, result = after.builds.find((build) => build.id === template.id)!;
      const required = template.required.exoticArmor !== null && key(template.required.exoticArmor) === normalized;
      const substitutes = [...new Set([...template.substitutions, ...template.preferred.exoticArmor, ...(template.required.exoticArmor ? [template.required.exoticArmor] : [])])]
        .filter((entry) => key(entry) !== normalized).flatMap((entry) => {
          const items = owned(snapshot, entry, classType);
          return items.length ? [{ name: entry, itemIds: items.map((item) => item.id) }] : [];
        }).sort((a, b) => a.name.localeCompare(b.name));
      const scoreGain = Math.max(0, result.scoreBreakdown.ownedGear - before.scoreBreakdown.ownedGear);
      // Exact required gear is a major template gap; optional gear is a small alternative concept.
      const magnitude = required ? scoreGain / 35 : 0.15;
      const preferenceMatch = round(before.scoreBreakdown.preferenceMatch / 30);
      const substituteFactor = substitutes.length ? 0.5 : 1;
      const blockers = [...result.missing, ...result.unknown];
      return { buildId: template.id, buildName: template.name, kind: required ? "required" : "optional-alternative",
        unlocksReadyBuild: required && !before.readyNow && result.readyNow, readinessAfter: result.readiness,
        scoreGain, magnitude: round(magnitude), preferenceMatch, substituteFactor,
        contribution: round(magnitude * preferenceMatch * substituteFactor), existingSubstitutes: substitutes, blockers,
        reasons: [required ? `Closes the exact template's required exotic gap (+${scoreGain} gear-fit points).` : `Optional exotic alternative; no exact-template improvement is promised (gear-fit delta ${scoreGain}). Equip only one exotic armor piece.`,
          ...(substitutes.length ? ["Owned alternative concepts halve estimated marginal value; they do not satisfy the exact exotic requirement."] : ["No template-listed owned substitute confirmed."]),
          ...(blockers.length ? ["Gear alone does not establish readiness; verify remaining subclass/ability evidence."] : []),
          ...template.notes], templateConfidence: template.metadata.confidence };
    }).sort((a, b) => a.buildId.localeCompare(b.buildId));
    const fact = config.items.find((entry) => entry.class === classType && key(entry.name) === normalized);
    const usable = fact && fact.metadata.confidence !== "draft";
    const effort = usable ? fact.effort : "unknown", effortUnits = effort === "unknown" ? null : { low: 1, moderate: 3, high: 6 }[effort];
    const availability = fact?.metadata.confidence === "verified" ? fact.availability : "unknown";
    const marginalValue = round(impacts.reduce((sum, impact) => sum + impact.contribution, 0));
    all.push({ id: `${classType.toLowerCase()}:${normalized}`, name, class: classType, rank: 0,
      buildsUnlocked: impacts.filter((impact) => impact.unlocksReadyBuild).length,
      requiredBuildsImproved: impacts.filter((impact) => impact.kind === "required").length,
      optionalAlternatives: impacts.filter((impact) => impact.kind === "optional-alternative").length,
      marginalValue, valuePerEffort: effortUnits ? round(marginalValue / effortUnits) : null, effort, effortUnits, availability,
      source: usable ? fact.source : null, metadata: fact?.metadata ?? null, impacts,
      nextSteps: [availability === "unavailable" ? "Do not farm this item while the configured source is unavailable; recheck the dated source." : availability === "unknown" ? "Verify current acquisition availability and source before farming." : `Check the configured source (${fact?.source ?? "route not specified"}) and your access requirements before farming.`,
        ...(effort === "unknown" ? ["Add a dated, sourced fact or your own effort estimate to the local acquisition config to rank by value per effort."] : []),
        ...(impacts.some((impact) => impact.blockers.length) ? ["Confirm remaining subclass and ability unlocks in game; this pursuit does not promise a ready build."] : []),
        "Review the draft build concept and any exotic perk-roll requirements before pursuing it."] });
  }
  // Known costs are comparable only with known costs. Unknown costs get a separate benefit-only queue.
  const pursuits = all.filter((item) => item.availability !== "unavailable" && item.marginalValue > 0).sort((a, b) =>
    Number(a.valuePerEffort === null) - Number(b.valuePerEffort === null) || (b.valuePerEffort ?? b.marginalValue) - (a.valuePerEffort ?? a.marginalValue) || a.id.localeCompare(b.id));
  pursuits.forEach((item, index) => { item.rank = index + 1; });
  const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
  return { schemaVersion: 1, analysisVersion: ACQUISITION_ANALYSIS_VERSION, characterClass: classType,
    provenance: { snapshotId: snapshot.history?.current ?? builds.snapshotId, snapshotDigest: digest(snapshot), manifestVersion: snapshot.manifestVersion,
      buildDefinitionVersion: builds.buildDefinitionVersion, preferenceVersion: builds.preferenceVersion,
      acquisitionConfigVersion: acquisitionVersion(config), buildAnalysisVersion: builds.analysisVersion },
    rankingPolicy: "Known effort queue first: sum(magnitude × preference match × substitute factor) / effort units (low 1, moderate 3, high 6). Unknown effort queue separately ordered by benefit only; its ranks are not cost comparisons. Required magnitude = gear-fit gain / 35; optional alternative magnitude = 0.15; owned substitutes factor = 0.5, otherwise 1. These are planning assumptions, not measured performance or drop rates.",
    pursuits, verification, unavailable: all.filter((item) => item.availability === "unavailable").sort((a, b) => a.id.localeCompare(b.id)),
    deferred: all.filter((item) => item.availability !== "unavailable" && item.marginalValue === 0).sort((a, b) => a.id.localeCompare(b.id)),
    limitations: ["Scope: missing exotic armor named by your class's PvE build templates. Weapon rolls, armor stat farming and specific exotic class-item spirit combinations are not modeled.",
      "Only complete, resolved inventories establish absence. Unknown subclass/ability unlocks remain blockers; acquiring gear never proves them.",
      "Build counts describe template gaps/alternatives, not guaranteed combat improvement or distinct new playstyles. Template metadata and notes remain authoritative cautions.",
      "Availability and effort remain unknown unless your local catalog supplies reviewed facts or effort estimates. Dates and access prerequisites must be reviewed; this planner does not check live availability.",
      "Owned substitutes reduce value but cannot satisfy a different exact required exotic. Optional alternatives do not stack with another exotic armor piece."] };
}

export function formatAcquisition(analysis: AcquisitionAnalysis): string {
  const lines = [`${analysis.characterClass} acquisition planner`, `Analysis ${analysis.analysisVersion}; snapshot ${analysis.provenance.snapshotId}`, analysis.rankingPolicy];
  for (const item of analysis.pursuits) {
    lines.push("", `${item.rank}. ${item.name}`, `   Unlocks ${item.buildsUnlocked} ready builds; major required-gear gaps improved: ${item.requiredBuildsImproved}; optional alternatives: ${item.optionalAlternatives}`,
      `   Marginal value: ${item.marginalValue}; value/effort: ${item.valuePerEffort ?? "unknown (benefit-only queue)"}`,
      `   Estimated effort: ${item.effort}; availability: ${item.availability}; source: ${item.source ?? "unknown"}; evidence: ${item.metadata?.confidence ?? "unknown"}`,
      ...(item.metadata ? [`   Verified: ${item.metadata.verifiedAt ?? "not verified"}; sources: ${item.metadata.sources.join("; ") || "none"}`, ...item.metadata.notes.map((note) => `   Source note: ${note}`)] : []),
      ...item.impacts.flatMap((impact) => [`   ${impact.buildName}: ${impact.kind}; gear-fit +${impact.scoreGain}; magnitude ${impact.magnitude} × preference ${impact.preferenceMatch} × substitute ${impact.substituteFactor} = ${impact.contribution}`,
        `     Readiness after gear: ${impact.readinessAfter}; blockers: ${impact.blockers.join("; ") || "none in baseline matcher"}`,
        `     Owned alternatives: ${impact.existingSubstitutes.map((entry) => `${entry.name} [${entry.itemIds.join(", ")}]`).join("; ") || "none confirmed"}`,
        ...impact.reasons.map((reason) => `     ${reason}`)]), ...item.nextSteps.map((step) => `   Next: ${step}`));
  }
  if (!analysis.pursuits.length) lines.push("No confirmed missing eligible pursuits.");
  for (const item of analysis.verification) lines.push(`Verify ownership: ${item.name}: ${item.reasons.join("; ")}`);
  for (const item of analysis.unavailable) lines.push(`Excluded unavailable pursuit: ${item.name}; ${item.source ?? "source unspecified"}`);
  for (const item of analysis.deferred) lines.push(`Deferred: ${item.name}; no modeled marginal benefit under current preferences. Review preferences before farming.`);
  lines.push("", ...analysis.limitations.map((line) => `Limit: ${line}`));
  return lines.join("\n") + "\n";
}
