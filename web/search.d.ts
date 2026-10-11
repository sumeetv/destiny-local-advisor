import type { OwnedItem } from "../src/inventory.js";
export interface InventoryFilters {
  query?: string;
  type?: string;
  location?: string;
  classType?: string;
  locked?: boolean;
  perkScope?: string;
}
export function filterInventory(items: OwnedItem[], filters?: InventoryFilters): OwnedItem[];
export function sortInventory(items: OwnedItem[], sort?: string): OwnedItem[];
