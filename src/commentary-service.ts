import { createHash, randomUUID } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { currentCleanup, withInventoryLock, type AnalysisPaths } from "./dim-service.js";
import { currentNewLoot } from "./new-loot-service.js";
import { currentAcquisition } from "./acquisition-service.js";
import { createAdvisor, type AdvisorConfig, type AdvisorOutput, type CommentaryContext, type CommentaryScope } from "./advisor.js";

export interface CommentaryRequest { scope: CommentaryScope; target?: string }
export interface CommentaryReport extends AdvisorOutput { schemaVersion: 1; analysisVersion: "0.10.0"; provider: AdvisorConfig["provider"]; model: string | null; context: CommentaryContext }

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export async function commentaryContext(directory: string, request: CommentaryRequest, paths: AnalysisPaths = {}): Promise<CommentaryContext> {
  if (request.target && !["build", "cleanup"].includes(request.scope)) throw new Error("A commentary target is only supported for build or cleanup scope.");
  const current = await withInventoryLock(directory, () => currentCleanup(directory, paths));
  const facts: CommentaryContext["facts"] = [];
  const add = (text: string) => facts.push({ id: `fact-${facts.length + 1}`, text: text.length > 900 ? text.slice(0, 875) + " [details truncated]" : text });
  const { snapshot, builds, cleanup } = current;
  const limitations = ["Deterministic evidence is authoritative. AI text is commentary only and cannot approve tags, change recommendations or establish ownership.",
    "Facts are selected and bounded, not a full inventory. Missing facts are not evidence of absence. Build templates and weapon ratings may be draft; combat performance and complete armor/mod optimization are unverified.",
    "Owning a named exotic class item does not establish a specific spirit/perk combination. Build readiness is limited to the deterministic baseline matcher's recorded requirements."];
  let title: string;
  const provenance: Record<string, string> = { snapshotId: snapshot.history?.current ?? builds.snapshotId, manifestVersion: snapshot.manifestVersion,
    buildDefinitionVersion: builds.buildDefinitionVersion, preferenceVersion: builds.preferenceVersion,
    cleanupConfigVersion: cleanup.configVersion, weaponRatingsVersion: cleanup.weaponRatingsVersion };
  const buildFacts = (build: typeof builds.builds[number]) => {
    add(`${build.name}: readiness ${build.readiness}; fit ${build.score}/100; template confidence ${build.metadata.confidence}. Fit is inventory/preference evidence, not measured combat performance.`);
    add(`Owned evidence for ${build.name}: ${build.owned.join("; ") || "none established"}.`);
    add(`Remaining blockers for ${build.name}: missing ${build.missing.join("; ") || "none recorded"}; unknown ${build.unknown.join("; ") || "none recorded"}.`);
    add(`Suggested owned weapons for ${build.name}: ${build.bestOwnedWeapons.map((weapon) => weapon.name).join(", ") || "none established"}. Substitutions: ${build.substitutions.map((item) => item.name).join(", ") || "none confirmed"}; substitutions do not satisfy the exact exotic requirement.`);
  };
  if (request.scope === "build") {
    const build = builds.builds.find((item) => item.id === request.target);
    if (!build) throw new Error("Select an existing build template ID for build commentary.");
    title = build.name; buildFacts(build);
  } else if (request.scope === "cleanup") {
    const item = cleanup.items.find((item) => item.itemId === request.target);
    if (!item) throw new Error("Select an existing item ID for cleanup commentary.");
    title = `Review ${item.name}`;
    add(`${item.name}: deterministic classification ${item.classification}; evidence score ${item.confidence}/100. This score is not a measured probability of safety.`);
    // Omit saved-build identifiers, arbitrary DIM notes and copy instance IDs from provider input.
    const clean = (value: string) => {
      let text = value.replace(/(Referenced by saved local builds|Current recommended build loadout):.*/g, "$1");
      for (const copy of snapshot.items) if (copy.instanceId) text = text.replaceAll(copy.instanceId, "[owned copy]");
      return text;
    };
    add(`Recorded protection reasons: ${item.protectionReasons.map(clean).join("; ") || "none recorded"}.`);
    add(`Unknown evidence: ${item.unknowns.map(clean).join("; ") || "none identified in required fields"}. Unique evidence: ${item.uniqueThings.map(clean).join("; ") || "none established"}.`);
    add(`Better retained owned alternatives: ${item.betterOwnedAlternatives.map((copy) => copy.name).join(", ") || "none established"}. Build references: ${item.buildsAffected.length}. Source status: ${item.sourceStatus}.`);
    add("Every candidate requires explicit user review and current deterministic eligibility before a DIM export. Commentary never selects items, writes tags or authorizes removal.");
  } else if (request.scope === "builds") {
    title = "Builds to try";
    add("Suggestions are limited to these existing template concepts. A template with unknown unlock evidence is not confirmed ready; no new template or loadout is created.");
    builds.builds.slice(0, 5).forEach(buildFacts);
  } else {
    title = "Refresh summary";
    const loot = await currentNewLoot(directory, paths), upgrades = await currentAcquisition(directory, paths);
    add(`Snapshot comparison: ${loot.status}. First seen ${loot.counts.acquired}; contextual improvements ${loot.counts.improved}; keep/protected ${loot.counts.keep}; review ${loot.counts.review}; probably redundant for review ${loot.counts.probablyRedundant}.`);
    add(`Currently absent ${loot.counts.currentlyAbsent}; cause unknown. Vault stacks ${loot.vault.previous ?? "unknown"} to ${loot.vault.current}.`);
    for (const item of loot.acquired.slice(0, 6)) add(`${item.name}: ${item.recommendation}; ${item.improvements.length} contextual improvements. Improvement claims can be provisional; unknown evidence entries ${item.unknowns.length}.`);
    loot.improvedBuilds.slice(0, 3).forEach((build) => add(`${build.name}: template fit ${build.previousScore} to ${build.currentScore}; newly ready ${build.newlyReady}.`));
    builds.builds.slice(0, 2).forEach(buildFacts);
    upgrades.pursuits.slice(0, 3).forEach((item) => add(`Pursuit ${item.name}: ready-build unlocks ${item.buildsUnlocked}; required-gear gaps improved ${item.requiredBuildsImproved}; optional alternatives ${item.optionalAlternatives}; effort ${item.effort}; availability ${item.availability}. Gear alone does not confirm unknown subclass abilities.`));
    limitations.push(...loot.limitations, ...upgrades.limitations);
    provenance.acquisitionConfigVersion = upgrades.provenance.acquisitionConfigVersion;
  }
  const latest = await withInventoryLock(directory, () => currentCleanup(directory, paths));
  if (latest.revision !== current.revision) throw new Error("Analysis changed while collecting commentary facts. Reload and try again.");
  return { scope: request.scope, title, facts, limitations, provenance, revision: digest({ request, revision: current.revision, facts, limitations, provenance }) };
}

export async function generateCommentary(directory: string, request: CommentaryRequest, config: AdvisorConfig, paths: AnalysisPaths = {},
  options: { allowCloud?: boolean; revision?: string; fetcher?: typeof fetch } = {}): Promise<CommentaryReport> {
  const context = await commentaryContext(directory, request, paths);
  if (options.revision !== undefined && options.revision !== context.revision) throw new Error("Analysis changed. Reload facts before generating commentary.");
  const advisor = createAdvisor(config, options.allowCloud, options.fetcher);
  const output = request.scope === "build" ? await advisor.explainBuild(context) : request.scope === "cleanup" ? await advisor.explainCleanup(context)
    : request.scope === "builds" ? await advisor.proposeBuilds(context) : await advisor.summarizeRefresh(context);
  const latest = await commentaryContext(directory, request, paths);
  if (latest.revision !== context.revision) throw new Error("Analysis changed during commentary generation. Reload facts and try again.");
  return { ...output, schemaVersion: 1, analysisVersion: "0.10.0", provider: config.provider, model: config.provider === "none" ? null : config.model, context };
}

export function formatCommentary(report: CommentaryReport): string {
  return [report.context.title, `${report.status} · ${report.provider}${report.model ? ` · ${report.model}` : ""}`, report.notice,
    ...report.paragraphs.map((paragraph) => `${paragraph.text} [${paragraph.factIds.join(", ")}]`), "", "Deterministic facts (authoritative)",
    ...report.context.facts.map((fact) => `${fact.id}: ${fact.text}`), "", ...report.context.limitations, `Facts revision: ${report.context.revision}`].join("\n") + "\n";
}
export async function writeCommentary(report: CommentaryReport, directory: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  for (const [name, content] of [["commentary.json", JSON.stringify(report, null, 2) + "\n"], ["commentary.txt", formatCommentary(report)]] as const) {
    const target = path.join(directory, name), temporary = `${target}.${randomUUID()}.tmp`;
    await writeFile(temporary, content, { mode: 0o600, flag: "wx" }); await rename(temporary, target);
  }
}
