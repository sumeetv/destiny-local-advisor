import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { z } from "zod";

export const acquisitionConfigSchema = z.object({
  version: z.literal(1),
  items: z.array(z.object({
    name: z.string().trim().min(1), class: z.enum(["Titan", "Hunter", "Warlock"]),
    availability: z.enum(["unknown", "available", "unavailable"]),
    source: z.string().trim().min(1).nullable(),
    effort: z.enum(["unknown", "low", "moderate", "high"]),
    metadata: z.object({ confidence: z.enum(["draft", "user-estimate", "verified"]),
      verifiedAt: z.iso.datetime().nullable(), sources: z.array(z.string().trim().min(1)), notes: z.array(z.string().min(1)) }).strict(),
  }).strict().superRefine((entry, ctx) => {
    if (entry.metadata.confidence === "verified" && (!entry.metadata.verifiedAt || !entry.metadata.sources.length)) {
      ctx.addIssue({ code: "custom", message: "Verified acquisition facts require a date and sources." });
    }
    if (entry.availability !== "unknown" && entry.metadata.confidence !== "verified") {
      ctx.addIssue({ code: "custom", message: "Availability claims require verified metadata; user estimates may supply effort only." });
    }
  })),
}).strict().superRefine((config, ctx) => {
  const keys = config.items.map((entry) => `${entry.class}:${entry.name.toLowerCase()}`);
  if (new Set(keys).size !== keys.length) ctx.addIssue({ code: "custom", message: "Acquisition item/class entries must be unique." });
});
export type AcquisitionConfig = z.infer<typeof acquisitionConfigSchema>;
export const defaultAcquisitionConfig: AcquisitionConfig = { version: 1, items: [] };
export const acquisitionVersion = (config: AcquisitionConfig): string => createHash("sha256").update(JSON.stringify(config)).digest("hex");
export async function loadAcquisitionConfig(filename = "config/acquisition/default.yaml"): Promise<AcquisitionConfig> {
  return acquisitionConfigSchema.parse(JSON.parse(await readFile(filename, "utf8")));
}
