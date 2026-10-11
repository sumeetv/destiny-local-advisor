import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { InventorySnapshot, OwnedItem } from "./inventory.js";
import type { CleanupAnalysis } from "./analysis/cleanup.js";
import { writePrivateJson } from "./bungie/storage.js";

const identity = z.string().regex(/^[1-9]\d{0,19}$/).refine((id) => BigInt(id) <= 18446744073709551615n);
const hash = z.number().int().positive().max(4294967295);
const tags = ["Favorite", "Keep", "Archive", "Junk", "Infuse", ""] as const;
const rowSchema = z.object({ id: identity, itemHash: hash, tag: z.enum(tags).optional(), notes: z.string().optional() }).strict();
const storeSchema = z.object({ mappingVersion: z.literal(1), rows: z.array(rowSchema) }).strict();
export type DimRow = z.infer<typeof rowSchema>;
export type DimStore = z.infer<typeof storeSchema>;
export const isPreservationTag = (tag?: string) => ["favorite", "keep", "archive"].includes(tag?.trim().toLowerCase() ?? "");
const key = (id: string, itemHash: number) => `${id}:${itemHash}`;

/** RFC 4180 cells, including quoted newlines. Never coerce instance IDs to numbers. */
export function parseCsv(input: string): string[][] {
  const text = input.replace(/^\uFEFF/, "");
  const rows: string[][] = [];
  let row: string[] = [], cell = "", quoted = false, closed = false;
  const endCell = () => { row.push(cell); cell = ""; closed = false; };
  const endRow = () => { endCell(); if (row.some((value) => value !== "")) rows.push(row); row = []; };
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!;
    if (quoted) {
      if (char !== '"') cell += char;
      else if (text[index + 1] === '"') { cell += '"'; index++; }
      else { quoted = false; closed = true; }
    } else if (char === ",") endCell();
    else if (char === "\r" || char === "\n") { endRow(); if (char === "\r" && text[index + 1] === "\n") index++; }
    else if (char === '"' && cell === "" && !closed) quoted = true;
    else if (closed || char === '"') throw new Error("Malformed DIM CSV quoting.");
    else cell += char;
  }
  if (quoted) throw new Error("Unterminated DIM CSV quoted cell.");
  if (cell !== "" || row.length || closed) endRow();
  return rows;
}

/** Mapping v1: unknown columns ignored, optional Tag/Notes columns preserve missing metadata. */
export function parseDimCsv(text: string): DimRow[] {
  const [header, ...data] = parseCsv(text);
  if (!header) throw new Error("DIM CSV is empty.");
  const columns = header.map((name) => name.trim().toLowerCase());
  for (const name of ["id", "hash", "tag", "notes"]) {
    if (columns.filter((column) => column === name).length > 1) throw new Error(`Duplicate DIM CSV ${name} column.`);
  }
  if (!columns.includes("id") || !columns.includes("hash")) throw new Error("DIM CSV needs Id and Hash columns; per-copy identity cannot be inferred.");
  if (!columns.includes("tag") && !columns.includes("notes")) throw new Error("DIM CSV needs a Tag or Notes column.");
  const result = new Map<string, DimRow>();
  for (const [index, cells] of data.entries()) {
    const value = (name: string) => cells[columns.indexOf(name)];
    // DIM exports a literal pair of quotes inside the CSV Id cell to protect 64-bit IDs.
    const rawId = value("id")?.trim() ?? "";
    const id = /^"[1-9]\d*"$/.test(rawId) ? rawId.slice(1, -1) : rawId;
    const rawHash = value("hash")?.trim() ?? "";
    if (!identity.safeParse(id).success || !/^\d+$/.test(rawHash) || !hash.safeParse(Number(rawHash)).success) throw new Error(`Invalid Id/Hash in DIM CSV row ${index + 2}. Export IDs as text, without spreadsheet rounding.`);
    const row: DimRow = { id, itemHash: Number(rawHash) };
    const tag = value("tag");
    if (tag !== undefined) {
      const normalized = tags.find((known) => known.toLowerCase() === tag.trim().toLowerCase());
      if (normalized === undefined) throw new Error(`Unknown DIM tag in row ${index + 2}.`);
      row.tag = normalized;
    }
    const notes = value("notes");
    if (notes !== undefined) row.notes = notes;
    const rowKey = key(id, row.itemHash), previous = result.get(rowKey);
    if (previous && JSON.stringify(previous) !== JSON.stringify(row)) throw new Error(`Conflicting duplicate DIM identity in row ${index + 2}.`);
    result.set(rowKey, row);
  }
  return [...result.values()];
}

export async function loadDimStore(directory: string): Promise<DimStore> {
  let text: string;
  try { text = await readFile(path.join(directory, "dim-metadata.json"), "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { mappingVersion: 1, rows: [] }; throw error; }
  const store = storeSchema.parse(JSON.parse(text));
  if (new Set(store.rows.map((row) => key(row.id, row.itemHash))).size !== store.rows.length) throw new Error("Ambiguous DIM metadata store.");
  return store;
}

function mergeMetadata(existing: OwnedItem["dim"], incoming: OwnedItem["dim"]): NonNullable<OwnedItem["dim"]> {
  const merged = { ...existing, ...incoming };
  if (isPreservationTag(existing?.tag)) merged.tag = existing!.tag!;
  return merged;
}

export function applyDimMetadata(snapshot: InventorySnapshot, store: DimStore): InventorySnapshot {
  const rows = new Map(store.rows.map((row) => [key(row.id, row.itemHash), row]));
  return { ...snapshot, items: snapshot.items.map((item) => {
    const row = item.instanceId ? rows.get(key(item.instanceId, item.itemHash)) : undefined;
    if (!row) return item;
    const metadata: NonNullable<OwnedItem["dim"]> = {};
    if (row.tag !== undefined) metadata.tag = row.tag;
    if (row.notes !== undefined) metadata.notes = row.notes;
    return { ...item, dim: mergeMetadata(item.dim, metadata) };
  }) };
}

/** Caller holds the inventory lock. Persist only exact, uniquely matched owned copies. */
export async function importDimMetadata(directory: string, snapshot: InventorySnapshot, text: string) {
  const parsed = parseDimCsv(text), store = await loadDimStore(directory);
  const current = applyDimMetadata(snapshot, store);
  const rows = new Map(store.rows.map((row) => [key(row.id, row.itemHash), row]));
  let matched = 0, preserved = 0;
  const skipped: string[] = [];
  for (const row of parsed) {
    const copies = current.items.filter((item) => item.instanceId === row.id && item.itemHash === row.itemHash && item.quantity > 0);
    if (copies.length !== 1 || current.items.filter((item) => item.instanceId === row.id).length !== 1) { skipped.push(row.id); continue; }
    const existing = copies[0]!.dim;
    const incoming: NonNullable<OwnedItem["dim"]> = {};
    if (row.tag !== undefined) incoming.tag = row.tag;
    if (row.notes !== undefined) incoming.notes = row.notes;
    const metadata = mergeMetadata(existing, incoming);
    if (isPreservationTag(existing?.tag) && row.tag !== undefined && row.tag !== existing!.tag) preserved++;
    if (metadata.tag !== undefined) metadata.tag = tags.find((tag) => tag.toLowerCase() === metadata.tag!.trim().toLowerCase()) ?? metadata.tag;
    rows.set(key(row.id, row.itemHash), rowSchema.parse({ id: row.id, itemHash: row.itemHash, ...metadata }));
    matched++;
  }
  await writePrivateJson(path.join(directory, "dim-metadata.json"), { mappingVersion: 1, rows: [...rows.values()] });
  return { mappingVersion: 1, matched, preserved, skipped };
}

// Exact DIM text round trip: escape CSV syntax without altering notes via formula prefixes.
const dimCell = (value: string | number) => `"${String(value).replaceAll('"', '""')}"`;
export function dimCleanupCsv(snapshot: InventorySnapshot, cleanup: CleanupAnalysis, selectedIds: string[]): string {
  if (!selectedIds.length) throw new Error("Explicitly select at least one cleanup candidate for DIM Junk export.");
  const expectedSnapshot = snapshot.source?.rawSnapshot ?? snapshot.profileTimestamp ?? snapshot.importedAt;
  if (cleanup.snapshotId !== expectedSnapshot || cleanup.manifestVersion !== snapshot.manifestVersion) throw new Error("Cleanup analysis is stale. Reload and select again.");
  const rows = [...new Set(selectedIds)].map((id) => {
    const copies = snapshot.items.filter((item) => item.id === id);
    const results = cleanup.items.filter((item) => item.itemId === id);
    const item = copies[0], result = results[0];
    if (copies.length !== 1 || results.length !== 1 || !item || !result || item.quantity <= 0 || !identity.safeParse(item.instanceId).success ||
      snapshot.items.filter((copy) => copy.instanceId === item.instanceId).length !== 1 || result.itemHash !== item.itemHash ||
      result.classification !== "DISMANTLE_CANDIDATE" || result.protectionReasons.length || result.unknowns.length ||
      item.locked || item.equipped || isPreservationTag(item.dim?.tag) || !result.betterOwnedAlternatives.length) {
      throw new Error(`Item ${id} is not an eligible current cleanup candidate. Reload and review your selection.`);
    }
    if (typeof item.dim?.tag !== "string" || typeof item.dim.notes !== "string" ||
      !tags.some((tag) => tag.toLowerCase() === item.dim!.tag!.trim().toLowerCase())) {
      throw new Error(`Import DIM Tag and Notes metadata for item ${id} before exporting; unknown existing preferences and notes cannot be overwritten.`);
    }
    const alternatives = result.betterOwnedAlternatives.filter((alternative) => !selectedIds.includes(alternative.itemId) &&
      snapshot.items.some((copy) => copy.id === alternative.itemId && copy.itemHash === item.itemHash && copy.quantity > 0));
    if (!alternatives.length) throw new Error(`Item ${id} has no retained owned replacement.`);
    const explanation = `Destiny Advisor: duplicate; dominated by owned copy ${alternatives.map((copy) => copy.itemId).join(", ")}; evidence ${result.confidence}/100; snapshot ${cleanup.snapshotId}.`;
    const notes = item.dim?.notes ? `${item.dim.notes}\n${explanation}` : explanation;
    return [item.instanceId!, item.itemHash, "Junk", notes].map(dimCell).join(",");
  });
  return "Id,Hash,Tag,Notes\r\n" + rows.join("\r\n") + "\r\n";
}
