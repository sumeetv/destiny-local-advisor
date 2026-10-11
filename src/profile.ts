import { z } from "zod";

const itemSchema = z.object({
  itemHash: z.number().int().nonnegative(),
  itemInstanceId: z.string().optional(),
  quantity: z.number().int().nonnegative().optional(),
  bucketHash: z.number().int().nonnegative().optional(),
  location: z.number().int().optional(),
  state: z.number().int().nonnegative().optional(),
}).passthrough();

const characterSchema = z.object({
  classType: z.number().int(),
}).passthrough();

const componentSchema = <T extends z.ZodTypeAny>(value: T) =>
  z.object({ data: value.nullable().optional() }).passthrough().optional();

const itemMapSchema = z.record(z.string(), z.object({
  items: z.array(itemSchema),
}).passthrough());

const socketComponentSchema = z.record(z.string(), z.object({
  sockets: z.array(z.object({
    plugHash: z.number().int().nonnegative().optional(),
    isEnabled: z.boolean().optional(),
    isVisible: z.boolean().optional(),
  }).passthrough()),
}).passthrough());

const reusablePlugComponentSchema = z.record(z.string(), z.object({
  plugs: z.record(
    z.string(),
    z.array(z.object({
      plugItemHash: z.number().int().nonnegative(),
      canInsert: z.boolean().optional(),
      enabled: z.boolean().optional(),
    }).passthrough()),
  ),
}).passthrough());

export const profileSchema = z.object({
  responseMintedTimestamp: z.string().optional(),
  profileInventory: componentSchema(z.object({ items: z.array(itemSchema) }).passthrough()),
  characters: componentSchema(z.record(z.string(), characterSchema)),
  characterInventories: componentSchema(itemMapSchema),
  characterEquipment: componentSchema(itemMapSchema),
  itemComponents: z.object({
    instances: componentSchema(z.record(z.string(), z.object({
      primaryStat: z.object({ statHash: z.number().int(), value: z.number() }).optional(),
      damageType: z.number().int().optional(),
      isEquipped: z.boolean().optional(),
    }).passthrough())),
    stats: componentSchema(z.record(z.string(), z.object({
      stats: z.record(z.string(), z.object({ statHash: z.number().int(), value: z.number() })),
    }).passthrough())),
    sockets: componentSchema(socketComponentSchema),
    reusablePlugs: componentSchema(reusablePlugComponentSchema),
  }).passthrough(),
}).passthrough();

export type Profile = z.infer<typeof profileSchema>;
export type ProfileItem = z.infer<typeof itemSchema>;

export function parseProfile(value: unknown): Profile {
  const input = value && typeof value === "object" && "Response" in value ? value.Response : value;
  return profileSchema.parse(input);
}
