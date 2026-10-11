import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

const nonempty = z.string().min(1);
export const buildTemplateSchema = z.object({
  id: nonempty, name: nonempty, class: z.enum(["Titan", "Hunter", "Warlock"]), mode: z.enum(["pve", "pvp"]),
  playstyles: z.array(nonempty).min(1), history: z.array(nonempty),
  required: z.object({ subclass: nonempty, abilities: z.array(nonempty), exoticArmor: nonempty.nullable() }),
  preferred: z.object({ exoticArmor: z.array(nonempty), weaponTraits: z.array(nonempty) }),
  substitutions: z.array(nonempty), ratings: z.record(nonempty, z.number().min(0).max(10)),
  notes: z.array(nonempty), metadata: z.object({ version: z.number().int().positive(), verifiedAt: z.string().nullable(), sandboxVersion: nonempty, confidence: z.enum(["draft", "low", "medium", "high"]), sources: z.array(nonempty).min(1) }),
});
export const preferencesSchema = z.object({
  version: z.number().int().positive(), preferences: z.object({
    class: z.enum(["Titan", "Hunter", "Warlock"]),
    playstyles: z.record(nonempty, z.number().min(0).max(10)),
    favorites: z.object({ weapons: z.array(nonempty), exotics: z.array(nonempty) }),
    history: z.array(nonempty), priorities: z.record(nonempty, z.number().min(0).max(10)),
  }),
});
export type BuildTemplate = z.infer<typeof buildTemplateSchema>;
export type BuildPreferences = z.infer<typeof preferencesSchema>;

/** JSON is a YAML 1.2 subset. Restrict local configs to this subset to avoid a new runtime dependency. */
async function readConfig(filename: string): Promise<unknown> {
  try { return JSON.parse(await readFile(filename, "utf8")); }
  catch { throw new Error(`Cannot parse ${filename}. Build configuration uses JSON-compatible YAML 1.2; check syntax and file access.`); }
}
export async function loadBuildConfig(directory = "config/builds", preferencesFile = "config/preferences.yaml") {
  const names = (await readdir(directory)).filter((name) => /\.ya?ml$/.test(name)).sort();
  const templates = await Promise.all(names.map(async (name) => buildTemplateSchema.parse(await readConfig(path.join(directory, name)))));
  if (!templates.length) throw new Error("No build templates found.");
  if (new Set(templates.map((build) => build.id)).size !== templates.length) throw new Error("Build template IDs must be unique.");
  const preferences = preferencesSchema.parse(await readConfig(preferencesFile));
  return { templates, preferences, buildDefinitionVersion: createHash("sha256").update(JSON.stringify(templates)).digest("hex"), preferenceVersion: createHash("sha256").update(JSON.stringify(preferences)).digest("hex") };
}
