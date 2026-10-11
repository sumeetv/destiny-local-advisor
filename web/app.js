import { filterInventory, sortInventory } from "/search.js";

const $ = (id) => document.getElementById(id);
const pageSize = 40;
let snapshot = null;
let type = "all";
let page = 0;
let visible = [];
let syncBusy = false;
let authStatus = null;

function node(tag, text, className) {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = String(text);
  if (className) element.className = className;
  return element;
}

function flags(item) {
  return [item.equipped && "Equipped", item.locked && "Locked", item.crafted && "Crafted",
    item.enhanced && "Enhanced", item.masterworked && "Masterworked"].filter(Boolean);
}

function reset() {
  $("search").value = "";
  $("filters").reset();
  setType("all");
}

function setType(value) {
  type = value;
  document.querySelectorAll("[data-type]").forEach((tab) => {
    const active = tab.dataset.type === value;
    tab.classList.toggle("active", active);
    tab.setAttribute("aria-pressed", String(active));
  });
  render(true);
}

function render(resetPage = false) {
  if (!snapshot) return;
  if (resetPage) page = 0;
  visible = sortInventory(filterInventory(snapshot.items, {
    query: $("search").value, type, location: $("location").value, classType: $("class-type").value,
    perkScope: $("perk-scope").value, locked: $("locked").checked,
  }), $("sort").value);
  const pages = Math.max(1, Math.ceil(visible.length / pageSize));
  page = Math.min(page, pages - 1);
  $("results-count").textContent = `${visible.length.toLocaleString()} ${visible.length === 1 ? "item" : "items"} · ${snapshot.items.length.toLocaleString()} in your account`;
  $("empty").hidden = visible.length > 0;
  $("previous").disabled = page === 0;
  $("next").disabled = page + 1 === pages;
  $("page-count").textContent = `Page ${page + 1} of ${pages}`;
  const rows = visible.slice(page * pageSize, (page + 1) * pageSize).map((item) => {
    const row = node("tr");
    const nameCell = node("td");
    const nameWrap = node("div", undefined, "item-name-wrap");
    const tile = node("span", item.type === "weapon" ? "↗" : item.type === "armor" ? "◇" : "◈", `item-tile ${item.exotic ? "exotic" : ""}`);
    tile.setAttribute("aria-hidden", "true");
    const info = node("div");
    const button = node("button", item.name, "item-name");
    button.type = "button";
    button.addEventListener("click", () => inspect(item));
    info.append(button, node("span", [item.tier, item.typeName, item.classType, item.slot].filter(Boolean).join(" · "), "item-meta"));
    nameWrap.append(tile, info);
    nameCell.append(nameWrap);
    const location = node("td", undefined, "location-cell");
    location.append(node("span", item.locationLabel), node("span", item.equipped ? "Currently equipped" : item.quantity > 1 ? `Quantity ${item.quantity.toLocaleString()}` : "", "item-meta"));
    const power = node("td", item.power ?? "—", "power-cell");
    const perks = node("td");
    const chips = node("div", undefined, "perk-chips");
    item.selectedPerks.slice(0, 3).forEach((perk) => chips.append(node("span", perk.name, "perk-chip")));
    if (item.selectedPerks.length > 3) chips.append(node("span", `+${item.selectedPerks.length - 3}`, "perk-extra"));
    if (!item.selectedPerks.length) chips.append(node("span", "—", "muted"));
    const terms = $("search").value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const matchingAvailable = item.availablePerks.filter((perk) => terms.length && terms.some((term) => perk.name.toLowerCase().includes(term)) && !item.selectedPerks.some((selected) => selected.hash === perk.hash));
    if (matchingAvailable.length) chips.append(node("span", `Available: ${matchingAvailable.map((perk) => perk.name).join(", ")}`, "available-match"));
    perks.append(chips);
    const state = node("td");
    const badges = node("div", undefined, "state-badges");
    flags(item).forEach((flag) => badges.append(node("span", flag, `state-badge ${flag === "Equipped" ? "equipped" : ""}`)));
    state.append(badges);
    row.append(nameCell, location, power, perks, state);
    return row;
  });
  $("items").replaceChildren(...rows);
}

function inspect(item) {
  const content = $("detail-content");
  content.replaceChildren();
  content.append(node("h2", item.name), node("p", [item.tier, item.typeName, item.classType].filter(Boolean).join(" · "), "subtitle"));
  if (item.description) content.append(node("p", item.description));
  const facts = node("dl", undefined, "facts");
  for (const [label, value] of [["Location", item.locationLabel], ["Slot", item.slot], ["Power", item.power],
    ["Damage", item.damageType], ["Ammo", item.ammoType], ["Quantity", item.quantity],
    ["State", flags(item).join(" · ") || "No flags"], ["Instance ID", item.instanceId], ["Item hash", item.itemHash]]) {
    if (value !== null) facts.append(node("dt", label), node("dd", value));
  }
  content.append(facts);
  if (item.dim) {
    content.append(node("h3", "DIM metadata"), node("p", `Tag: ${item.dim.tag || "None"}`));
    if (item.dim.notes) content.append(node("pre", item.dim.notes));
  }
  content.append(node("h3", "Selected perks & mods"));
  const selected = node("div", undefined, "detail-perks");
  item.selectedPerks.forEach((perk) => {
    const block = node("div");
    block.append(node("strong", perk.name));
    if (perk.description) block.append(node("p", perk.description));
    selected.append(block);
  });
  if (!item.selectedPerks.length) selected.append(node("p", "No named gameplay plugs reported for this item.", "muted"));
  content.append(selected, node("h3", "Sockets & available alternatives"), node("p", "Selected plugs come from this snapshot. Alternatives are reported as insertable on this instance; they are not necessarily active.", "muted"));
  for (const socket of item.sockets) {
    const details = node("details", undefined, "socket-detail");
    const current = socket.selected;
    details.append(node("summary", `Socket ${socket.index + 1} · ${current?.name || "Unnamed / empty plug"}${current?.enabled === false ? " (inactive)" : ""}${socket.visible === false ? " (hidden)" : ""}`));
    if (current) details.append(node("p", `Selected hash: ${current.hash} · ${current.category ?? "No category"}`));
    if (current?.description) details.append(node("p", current.description));
    const alternatives = node("ul");
    for (const plug of socket.available) {
      alternatives.append(node("li", `${plug.name || "Unnamed plug"} (${plug.hash})${plug.canInsert === false ? " · cannot insert" : ""}${plug.enabled === false ? " · inactive" : ""}`));
    }
    if (socket.available.length) details.append(alternatives);
    else details.append(node("p", "No alternatives supplied."));
    content.append(details);
  }
  content.append(node("h3", "Item stats"));
  content.append(node("p", item.stats === null ? "Item stats were not included in this export. They have not been inferred from the item definition." : "Reported stat values (keyed by Bungie stat hash):", "muted"));
  if (item.stats !== null) content.append(node("pre", JSON.stringify(item.stats, null, 2)));
  $("detail").showModal();
}

async function load() {
  $("reload").disabled = true;
  $("error").hidden = true;
  try {
    const response = await fetch("/api/inventory");
    if (!response.ok) throw new Error((await response.json()).error ?? "Unable to load inventory.");
    const data = await response.json();
    if (data.schemaVersion !== 1 || !Array.isArray(data.items)) throw new Error("Unsupported inventory export. Re-import your profile to regenerate it.");
    snapshot = data;
    $("weapon-count").textContent = data.items.filter((item) => item.type === "weapon").length.toLocaleString();
    $("armor-count").textContent = data.items.filter((item) => item.type === "armor").length.toLocaleString();
    $("vault-count").textContent = data.items.filter((item) => item.location === "vault").length.toLocaleString();
    $("character-count").textContent = data.characters.length;
    $("character-names").textContent = data.characters.map((character) => character.classType).join(" · ");
    $("snapshot-date").textContent = `Snapshot · ${new Date(data.profileTimestamp ?? data.importedAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}`;
    $("manifest-info").textContent = `${data.unknownHashes.length} unresolved hashes`;
    render();
    await loadNewLoot();
  } catch (error) {
    $("error").textContent = error.message;
    $("error").hidden = false;
    $("results-count").textContent = snapshot ? "Reload failed; showing the previous snapshot." : "Inventory unavailable";
    $("snapshot-date").textContent = "Snapshot unavailable";
  } finally {
    $("reload").disabled = false;
  }
}

async function loadNewLoot() {
  try {
    const response = await fetch("/api/new-loot");
    const data = await response.json();
    if (!response.ok) throw new Error(data.error ?? "New loot analysis unavailable.");
    const message = data.status === "BASELINE" ? "New Loot baseline saved. Refresh after playing to compare." : data.status === "INCOMPARABLE" ? "New Loot snapshots cannot be compared; open New Loot for details." :
      `${data.counts.acquired} first seen · ${data.counts.improved} improvements · ${data.counts.keep} keep / protected · ${data.counts.probablyRedundant} probably redundant · ${data.counts.review} review.`;
    $("new-loot-summary").replaceChildren(node("span", message + " "));
    const link = node("a", "See New Loot"); link.href = "/new-loot";
    $("new-loot-summary").append(link);
  } catch (error) { $("new-loot-summary").textContent = `New Loot report unavailable: ${error.message}`; }
}

document.querySelectorAll("[data-type]").forEach((tab) => tab.addEventListener("click", () => setType(tab.dataset.type)));
document.querySelectorAll("[data-query]").forEach((button) => button.addEventListener("click", () => {
  reset(); $("search").value = button.dataset.query; render(true);
}));
$("search").addEventListener("input", () => render(true));
$("filters").addEventListener("change", () => render(true));
$("filters").addEventListener("submit", (event) => event.preventDefault());
$("clear").addEventListener("click", reset);
$("reload").addEventListener("click", load);
$("connect-bungie").addEventListener("click", connectBungie);
$("sync-bungie").addEventListener("click", syncBungie);
$("previous").addEventListener("click", () => { page--; render(); });
$("next").addEventListener("click", () => { page++; render(); });
$("close-detail").addEventListener("click", () => $("detail").close());
document.addEventListener("keydown", (event) => {
  if (event.key === "/" && !["INPUT", "SELECT", "TEXTAREA"].includes(document.activeElement?.tagName) && !$("detail").open) {
    event.preventDefault(); $("search").focus();
  }
});
load();
connectionStatus().then(() => {
  const params = new URLSearchParams(window.location.search);
  if (params.get("connect") === "1" && authStatus?.configured) {
    window.history.replaceState(null, "", "/");
    connectBungie();
  }
});

async function connectionStatus() {
  try {
    const response = await fetch("/api/auth/status");
    if (!response.ok) throw new Error("Unable to check Bungie connection.");
    authStatus = await response.json();
    $("connect-bungie").disabled = !authStatus.configured || syncBusy;
    $("connect-bungie").textContent = authStatus.connected ? "Reconnect Bungie" : "Connect Bungie";
    $("sync-bungie").disabled = !authStatus.connected || syncBusy || authStatus.syncing;
    $("bungie-status").textContent = !authStatus.configured ? "Bungie connection is not configured. See README.md to connect your account." :
      authStatus.syncing ? "Bungie refresh is in progress." : authStatus.connected ? "Bungie connected · Ready to refresh" : "Connect Bungie to refresh your inventory.";
  } catch {
    $("bungie-status").textContent = "Unable to check Bungie connection. Reload the page to retry.";
  }
}

async function localPost(url) {
  const response = await fetch(url, { method: "POST", headers: { "X-Local-Request": "1" } });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? "Bungie request failed.");
  return body;
}

async function connectBungie() {
  $("connect-bungie").disabled = true;
  try {
    const { authorizationUrl } = await localPost("/api/auth/bungie/start");
    window.location.assign(authorizationUrl);
  } catch (error) {
    $("bungie-status").textContent = error.message;
    $("connect-bungie").disabled = !authStatus?.configured;
  }
}

async function syncBungie() {
  syncBusy = true;
  $("connect-bungie").disabled = true;
  $("sync-bungie").disabled = true;
  $("sync-bungie").textContent = "Refreshing…";
  $("bungie-status").textContent = "Reading your Bungie inventory…";
  try {
    const result = await localPost("/api/sync");
    await load();
    $("bungie-status").textContent = `Refreshed ${result.items} items · ${result.weapons} weapons · ${result.armor} armor · Raw snapshot saved`;
  } catch (error) {
    $("bungie-status").textContent = error.message;
  } finally {
    syncBusy = false;
    $("sync-bungie").textContent = "Refresh from Bungie";
    const message = $("bungie-status").textContent;
    await connectionStatus();
    $("bungie-status").textContent = message;
  }
}
