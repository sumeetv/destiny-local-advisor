import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { z } from "zod";

const name = z.string().trim().min(1);
const scores = z.record(name, z.number().min(-20).max(20));
export const weaponRatingsSchema = z.object({
  version: z.number().int().positive(),
  metadata: z.object({ confidence: z.enum(["draft", "low", "medium", "high"]), verifiedAt: name.nullable(), sandboxVersion: name, sources: z.array(name).min(1), notes: z.array(name) }),
  roles: z.record(name, z.object({ mode: z.enum(["pve", "pvp"]), description: name, ammoTypes: z.array(z.enum(["Primary", "Special", "Heavy"])).optional() })),
  perks: z.record(name, scores),
  pairs: z.array(z.object({ perks: z.tuple([name, name]), scores, reason: name })),
}).superRefine((config, context) => {
  const normalized = Object.keys(config.perks).map((value) => value.toLowerCase());
  if (new Set(normalized).size !== normalized.length) context.addIssue({ code: "custom", message: "Perk names must be unique ignoring case." });
  const pairs = new Set<string>();
  for (const pair of config.pairs) {
    const key = pair.perks.map((value) => value.toLowerCase()).sort().join("|");
    if (pair.perks[0].toLowerCase() === pair.perks[1].toLowerCase() || pairs.has(key)) context.addIssue({ code: "custom", message: "Perk pairs must contain two distinct perks and be unique." });
    pairs.add(key);
    for (const perk of pair.perks) if (!normalized.includes(perk.toLowerCase())) context.addIssue({ code: "custom", message: `Pair perk ${perk} has no rating.` });
  }
  for (const values of [...Object.values(config.perks), ...config.pairs.map((pair) => pair.scores)]) for (const role of Object.keys(values)) {
    if (!config.roles[role]) context.addIssue({ code: "custom", message: `Unknown weapon role: ${role}` });
  }
});
export type WeaponRatings = z.infer<typeof weaponRatingsSchema>;
export const weaponRatingsVersion = (ratings: WeaponRatings) => createHash("sha256").update(JSON.stringify(ratings)).digest("hex");
export async function loadWeaponRatings(filename = "config/perk-ratings/default.yaml"): Promise<WeaponRatings> {
  let raw: unknown;
  try { raw = JSON.parse(await readFile(filename, "utf8")); }
  catch { throw new Error(`Cannot parse ${filename}. Perk ratings use JSON-compatible YAML 1.2; check syntax and file access.`); }
  return weaponRatingsSchema.parse(raw);
}
