import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { z } from "zod";

const name = z.string().trim().min(1);
export const cleanupFactsSchema = z.object({
  sourceStatus: z.enum(["common", "reacquirable", "rare", "unobtainable", "legacy", "unknown"]).optional(),
  armorSet: name.nullable().optional(), armorSetBonus: name.nullable().optional(), gearTier: name.nullable().optional(),
  armorStatsExact: z.boolean().optional(), currentSetBonusNeeded: z.boolean().optional(), highValueNiche: z.boolean().optional(),
}).strict();

export const cleanupConfigSchema = z.object({
  version: z.literal(1).default(1),
  // Lower thresholds never bypass protections, incomplete evidence, or strict dominance.
  threshold: z.number().int().min(85).max(100).default(90),
  savedBuilds: z.array(z.object({ id: name, itemIds: z.array(name) }).strict()).default([]),
  decisions: z.record(name, z.enum(["protect", "keep", "review"])).default({}),
  itemFacts: z.record(name, cleanupFactsSchema).default({}),
  armorStatHashes: z.array(name).length(6).refine((axes) => new Set(axes).size === 6, "Armor axes must be distinct").default([
    "2996146975", "392767087", "1943323491", "1735777505", "144602215", "4244567218",
  ]),
}).strict();
export type CleanupConfig = z.infer<typeof cleanupConfigSchema>;
export const defaultCleanupConfig = cleanupConfigSchema.parse({});
export const cleanupConfigVersion = (config: CleanupConfig) => createHash("sha256").update(JSON.stringify(config)).digest("hex");

export async function loadCleanupConfig(filename?: string): Promise<CleanupConfig> {
  if (!filename) return cleanupConfigSchema.parse({});
  let raw: unknown;
  try { raw = JSON.parse(await readFile(filename, "utf8")); }
  catch { throw new Error(`Cannot parse ${filename}. Cleanup config uses JSON-compatible YAML 1.2; check syntax and file access.`); }
  return cleanupConfigSchema.parse(raw);
}
