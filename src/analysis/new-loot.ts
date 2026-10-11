import type { InventorySnapshot, OwnedItem } from "../inventory.js";
import type { CleanupAnalysis, CleanupItem } from "./cleanup.js";
import type { WeaponAnalysis } from "./weapons.js";
import type { BuildAnalysis } from "./builds.js";

type SeenItem = { itemId: string; itemHash: number; name: string; type: OwnedItem["type"]; location: string };
export interface NewLootItem extends SeenItem {
  recommendation: "KEEP" | "PROTECTED" | "REVIEW" | "REVIEW_FOR_DISMANTLE";
  reasons: string[]; unknowns: string[]; selectedPerks: string[]; uniqueThings: string[];
  betterOwnedAlternatives: CleanupItem["betterOwnedAlternatives"]; buildsAffected: string[];
  improvements: { role: string; previousBest: number | null; currentScore: number | null; comparedItemIds: string[]; provisional: boolean; evidence: string[] }[];
}
export interface NewLootAnalysis {
  analysisVersion: "0.8.0"; status: "COMPARED" | "BASELINE" | "INCOMPARABLE";
  previousSnapshot: string | null; currentSnapshot: string;
  provenance: {
    previousSnapshotId: string | null; currentSnapshotId: string;
    previousManifestVersion: string | null; currentManifestVersion: string;
    weaponAnalysisVersion: string; weaponRatingsVersion: string; weaponRatingsMetadata: WeaponAnalysis["ratingsMetadata"];
    buildAnalysisVersion: string; buildDefinitionVersion: string; preferenceVersion: string;
    cleanupAnalysisVersion: string; cleanupConfigVersion: string;
  };
  counts: { acquired: number; currentlyAbsent: number; keep: number; review: number; probablyRedundant: number; improved: number };
  acquired: NewLootItem[]; currentlyAbsent: SeenItem[];
  vault: { previous: number | null; current: number };
  improvedBuilds: { id: string; name: string; previousScore: number; currentScore: number; newlyReady: boolean }[];
  limitations: string[];
}
const stamp = (s: InventorySnapshot) => s.profileTimestamp ?? s.importedAt;
const describe = (i: OwnedItem): SeenItem => ({ itemId: i.id, itemHash: i.itemHash, name: i.name, type: i.type, location: i.locationLabel });
const gear = (i: OwnedItem) => i.quantity > 0 && (i.type === "weapon" || i.type === "armor" || !i.known);
function accountComparable(previous: InventorySnapshot, current: InventorySnapshot): boolean {
  if (previous.source && current.source) return previous.source.membershipId === current.source.membershipId && previous.source.membershipType === current.source.membershipType;
  const chars = (s: InventorySnapshot) => s.characters.map((c) => c.id).sort().join(",");
  return previous.characters.length > 0 && chars(previous) === chars(current);
}
// Ignore generated stack IDs. Ambiguous identities never establish acquisitions or removals.
function identities(snapshot: InventorySnapshot) {
  const grouped = new Map<string, OwnedItem[]>();
  for (const item of snapshot.items.filter(gear)) if (item.instanceId) grouped.set(item.instanceId, [...(grouped.get(item.instanceId) ?? []), item]);
  return grouped;
}

export function analyzeNewLoot(previous: InventorySnapshot | null, current: InventorySnapshot, weapons: WeaponAnalysis,
  priorWeapons: WeaponAnalysis | null, cleanup: CleanupAnalysis, builds: BuildAnalysis, priorBuilds: BuildAnalysis | null): NewLootAnalysis {
  const limitations = ["New means first seen between consecutive successful ingestions; it does not prove a drop source or acquisition time.",
    "Currently absent means previously present and currently absent; no dismantling intent or cause is inferred.",
    "Only uniquely identified instanced weapons, armor and unresolved items are diffed. Known currency, stacks and gear without stable instance IDs are excluded.",
    "Recommendations reuse current cleanup protections and evidence. Junk export still requires explicit selection in Vault Cleanup / DIM.",
    "Role improvements use the same local ratings for both snapshots, compare exact weapon families, and are contextual perk evidence rather than overall superiority. Draft ratings remain provisional.",
    "Armor upgrades are reported only when current cleanup establishes a retained new copy as a strictly better alternative to a previously owned copy. Build fit changes are template evidence, not measured performance."];
  let status: NewLootAnalysis["status"] = previous ? "COMPARED" : "BASELINE";
  if (!previous) limitations.push("First successful snapshot establishes a baseline; no acquisitions are proven yet.");
  else if (previous.inventoryCoverage === "partial" || current.inventoryCoverage === "partial") { status = "INCOMPARABLE"; limitations.push("An inventory snapshot is incomplete; no acquisition or absence claims are made."); }
  else if (!accountComparable(previous, current)) { status = "INCOMPARABLE"; limitations.push("Account identity cannot be confirmed across snapshots; no acquisition or absence claims are made."); }
  else if (!Number.isFinite(Date.parse(stamp(previous))) || !Number.isFinite(Date.parse(stamp(current))) || Date.parse(stamp(current)) < Date.parse(stamp(previous))) {
    status = "INCOMPARABLE"; limitations.push("Snapshot timestamps are invalid or moved backwards; import a current profile to resume comparison.");
  }
  const before = previous ? identities(previous) : new Map<string, OwnedItem[]>(), after = identities(current);
  const ambiguous = new Set([...before, ...after].filter(([, items]) => items.length !== 1).map(([id]) => id));
  for (const [id, items] of after) if (before.has(id) && before.get(id)![0]!.itemHash !== items[0]!.itemHash) ambiguous.add(id);
  if (ambiguous.size) limitations.push(`${ambiguous.size} duplicate or conflicting instance identities excluded from comparison.`);
  const acquired: NewLootItem[] = [];
  const currentlyAbsent: SeenItem[] = [];
  if (status === "COMPARED") {
    for (const [id, items] of before) if (!after.has(id) && !ambiguous.has(id)) currentlyAbsent.push(describe(items[0]!));
    for (const [id, items] of after) if (!before.has(id) && !ambiguous.has(id)) {
      const item = items[0]!, advice = cleanup.items.find((c) => c.itemId === item.id);
      const evaluation = weapons.weapons.find((w) => w.itemId === item.id);
      const improvements: NewLootItem["improvements"] = [];
      const priorFamily = previous!.items.filter((p) => gear(p) && p.itemHash === item.itemHash && p.instanceId && !ambiguous.has(p.instanceId));
      if (evaluation && !evaluation.unknowns.length && priorFamily.length && priorWeapons) {
        const prior = priorFamily.map((p) => priorWeapons.weapons.find((w) => w.itemId === p.id));
        // Missing evidence on any older copy blocks claiming a best copy for that role.
        if (prior.every((p) => p && !p.unknowns.length) && priorFamily.every((p) => p.slot === item.slot && p.damageType === item.damageType && p.ammoType === item.ammoType)) {
          for (const [role, score] of Object.entries(evaluation.roleScores)) {
            const previousBest = Math.max(...prior.map((p) => p!.roleScores[role]?.score ?? 0));
            if (score.score > previousBest) improvements.push({ role, previousBest, currentScore: score.score,
              comparedItemIds: priorFamily.map((p) => p.id).sort(), provisional: weapons.ratingsMetadata.confidence !== "high" || weapons.ratingsMetadata.verifiedAt === null, evidence: ["Selected-perk weight exceeds every previous copy in this recognized role"] });
          }
        }
      }
      if (item.type === "armor" && advice && !advice.unknowns.length && advice.classification !== "DISMANTLE_CANDIDATE") {
        const priorItemIds = new Set([...before].filter(([instanceId]) => !ambiguous.has(instanceId)).flatMap(([, copies]) => copies.map((p) => p.id)));
        // Alternatives can be recorded even when an unresolved socket/configuration blocks
        // definitive cleanup evidence. Only fully evaluated comparisons prove an upgrade.
        const superseded = cleanup.items.filter((c) => !c.unknowns.length && priorItemIds.has(c.itemId) && c.betterOwnedAlternatives.some((a) => a.itemId === item.id));
        if (superseded.length) improvements.push({ role: "exact armor stat distribution", previousBest: null, currentScore: null, comparedItemIds: superseded.map((c) => c.itemId).sort(), provisional: false,
          evidence: [...new Set(superseded.flatMap((c) => c.betterOwnedAlternatives.filter((a) => a.itemId === item.id).flatMap((a) => a.reasons)))] });
      }
      const recommendation = advice?.classification === "DISMANTLE_CANDIDATE" ? "REVIEW_FOR_DISMANTLE" : advice?.classification ?? "REVIEW";
      acquired.push({ ...describe(item), recommendation, reasons: advice?.reasons ?? ["No current cleanup evidence available; review this item."], unknowns: advice?.unknowns ?? ["Missing cleanup analysis"],
        selectedPerks: item.selectedPerks.filter((p) => p.enabled !== false).map((p) => p.name), uniqueThings: advice?.uniqueThings ?? [],
        betterOwnedAlternatives: advice?.betterOwnedAlternatives ?? [], buildsAffected: advice?.buildsAffected ?? [], improvements });
    }
  }
  acquired.sort((a, b) => a.name.localeCompare(b.name) || a.itemId.localeCompare(b.itemId));
  currentlyAbsent.sort((a, b) => a.name.localeCompare(b.name) || a.itemId.localeCompare(b.itemId));
  const improvedBuilds: NewLootAnalysis["improvedBuilds"] = [];
  if (status === "COMPARED" && priorBuilds) for (const build of builds.builds) {
    const prior = priorBuilds.builds.find((b) => b.id === build.id);
    if (prior && (build.score > prior.score || (build.readyNow && !prior.readyNow))) improvedBuilds.push({ id: build.id, name: build.name, previousScore: prior.score, currentScore: build.score, newlyReady: build.readyNow && !prior.readyNow });
  }
  return { analysisVersion: "0.8.0", status, previousSnapshot: previous ? stamp(previous) : null, currentSnapshot: stamp(current),
    provenance: { previousSnapshotId: previous ? previous.history?.current ?? previous.source?.rawSnapshot ?? stamp(previous) : null,
      currentSnapshotId: current.history?.current ?? current.source?.rawSnapshot ?? stamp(current),
      previousManifestVersion: previous?.manifestVersion ?? null, currentManifestVersion: current.manifestVersion,
      weaponAnalysisVersion: weapons.analysisVersion, weaponRatingsVersion: weapons.ratingsVersion, weaponRatingsMetadata: weapons.ratingsMetadata,
      buildAnalysisVersion: builds.analysisVersion, buildDefinitionVersion: builds.buildDefinitionVersion, preferenceVersion: builds.preferenceVersion,
      cleanupAnalysisVersion: cleanup.analysisVersion, cleanupConfigVersion: cleanup.configVersion },
    counts: { acquired: acquired.length, currentlyAbsent: currentlyAbsent.length, keep: acquired.filter((i) => ["KEEP", "PROTECTED"].includes(i.recommendation)).length,
      review: acquired.filter((i) => i.recommendation === "REVIEW").length, probablyRedundant: acquired.filter((i) => i.recommendation === "REVIEW_FOR_DISMANTLE").length,
      improved: acquired.filter((i) => i.improvements.length).length }, acquired, currentlyAbsent, improvedBuilds,
    vault: { previous: status === "COMPARED" ? previous!.items.filter((i) => i.location === "vault").length : null, current: current.items.filter((i) => i.location === "vault").length }, limitations };
}

export function formatNewLoot(analysis: NewLootAnalysis): string {
  const lines = ["New Loot — since your previous successful snapshot", `${analysis.status}: ${analysis.previousSnapshot ?? "no previous snapshot"} → ${analysis.currentSnapshot}`,
    `${analysis.counts.acquired} first seen · ${analysis.counts.improved} improvements · ${analysis.counts.keep} keep/protected · ${analysis.counts.probablyRedundant} probably redundant · ${analysis.counts.review} review`,
    `Vault stacks: ${analysis.vault.previous ?? "unknown"} → ${analysis.vault.current}`, ...analysis.limitations];
  for (const item of analysis.acquired) lines.push("", `${item.recommendation} — ${item.name} [${item.itemId}]`, `  Selected: ${item.selectedPerks.join(" + ") || "none recorded"}`,
    ...item.improvements.map((i) => `  Better for ${i.role}${i.currentScore === null ? "" : `: ${i.previousBest} → ${i.currentScore}`}; compared with ${i.comparedItemIds.join(", ")}${i.provisional ? " (provisional)" : ""} — ${i.evidence.join("; ")}`),
    ...item.reasons.map((r) => `  ${r}`), `  Unique: ${item.uniqueThings.join("; ") || "none established"}`, `  Unknown: ${item.unknowns.join("; ") || "none identified in required fields"}`,
    ...item.betterOwnedAlternatives.map((a) => `  Better owned copy: ${a.name} [${a.itemId}] — ${a.reasons.join("; ")}`));
  for (const build of analysis.improvedBuilds) lines.push(`Build fit: ${build.name} ${build.previousScore} → ${build.currentScore}${build.newlyReady ? " · newly READY_NOW" : ""}`);
  for (const item of analysis.currentlyAbsent) lines.push(`Currently absent: ${item.name} [${item.itemId}] · cause unknown`);
  return lines.join("\n") + "\n";
}
