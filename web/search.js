/** Search owned gear names and the gameplay perks actually reported on that instance. */
export function filterInventory(items, filters = {}) {
  const terms = (filters.query ?? "").trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return items.filter((item) => {
    if (filters.type && filters.type !== "all" && item.type !== filters.type) return false;
    if (filters.location && filters.location !== "all" && item.location !== filters.location) return false;
    if (filters.classType && filters.classType !== "all" && item.classType !== filters.classType) return false;
    if (filters.locked && !item.locked) return false;
    const perks = filters.perkScope === "selected" ? item.selectedPerks : [...item.selectedPerks, ...item.availablePerks];
    const searchable = [item.name, item.typeName, item.slot, item.damageType, item.classType,
      ...perks.map((perk) => perk.name)].filter(Boolean).join(" ").toLocaleLowerCase();
    return terms.every((term) => searchable.includes(term));
  });
}

export function sortInventory(items, sort = "name") {
  return [...items].sort((a, b) => {
    if (sort === "power") return (b.power ?? -1) - (a.power ?? -1) || a.name.localeCompare(b.name);
    if (sort === "tier") return Number(b.exotic) - Number(a.exotic) || a.name.localeCompare(b.name);
    return a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
  });
}
