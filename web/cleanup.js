const $ = (id) => document.getElementById(id);
let analysis = null;
let page = 0;
let busy = false;
const selected = new Set();
const pageSize = 30;
const node = (tag, text) => { const element = document.createElement(tag); if (text !== undefined) element.textContent = text; return element; };

function error(message) { $("cleanup-error").textContent = message; $("cleanup-error").hidden = !message; }
function controls() {
  $("export-dim").disabled = busy || !analysis || !selected.size;
  $("export-dim").textContent = `Download DIM Cleanup CSV (${selected.size} selected)`;
  $("reload-cleanup").disabled = busy;
  $("import-button").disabled = busy;
}

function render() {
  controls();
  if (!analysis) return;
  const query = $("cleanup-query").value.trim().toLowerCase();
  const items = analysis.items.filter((item) => ($("classification").value === "all" || item.classification === $("classification").value) &&
    ($("cleanup-type").value === "all" || item.type === $("cleanup-type").value) &&
    (!query || [item.name, item.itemId, ...item.reasons, ...item.unknowns].join(" ").toLowerCase().includes(query)));
  const pages = Math.max(1, Math.ceil(items.length / pageSize));
  page = Math.min(page, pages - 1);
  $("cleanup-previous").disabled = page === 0;
  $("cleanup-next").disabled = page + 1 >= pages;
  $("cleanup-page").textContent = `${items.length} items · Page ${page + 1} of ${pages}`;
  const metadata = new Map(analysis.metadata.map((entry) => [entry.itemId, entry]));
  const cards = items.slice(page * pageSize, (page + 1) * pageSize).map((item) => {
    const card = node("article"); card.className = "cleanup-card";
    card.append(node("h3", item.name), node("p", `${item.classification} · Evidence ${item.confidence}/100 · ${item.type} · ${item.location} · ID ${item.itemId}`));
    if (item.classification === "DISMANTLE_CANDIDATE") {
      const label = node("label"); const checkbox = node("input"); checkbox.type = "checkbox"; checkbox.checked = selected.has(item.itemId);
      const dim = metadata.get(item.itemId);
      checkbox.disabled = typeof dim?.tag !== "string" || typeof dim?.notes !== "string";
      checkbox.addEventListener("change", () => { checkbox.checked ? selected.add(item.itemId) : selected.delete(item.itemId); controls(); });
      label.append(checkbox, node("span", "Suggest Junk tag for this copy")); card.append(label);
      if (checkbox.disabled) card.append(node("p", "Import DIM CSV with both Tag and Notes columns before selecting this copy."));
    }
    const detail = node("details"); detail.append(node("summary", "Reasons, better owned copies and DIM metadata"));
    const reasons = node("ul"); item.reasons.forEach((reason) => reasons.append(node("li", reason))); detail.append(reasons);
    detail.append(node("h4", "Better copies you own"));
    if (!item.betterOwnedAlternatives.length) detail.append(node("p", "No strictly better retained copy established."));
    for (const copy of item.betterOwnedAlternatives) detail.append(node("p", `${copy.name} [${copy.itemId}]: ${copy.reasons.join("; ")}`));
    detail.append(node("p", `Unique traits: ${item.uniqueThings.join("; ") || "None established"}`),
      node("p", `Builds affected: ${item.buildsAffected.join(", ") || "None identified"}`), node("p", `Source status: ${item.sourceStatus}`));
    const dim = metadata.get(item.itemId);
    detail.append(node("p", `DIM tag: ${dim?.tag || "None"}`)); if (dim?.notes) detail.append(node("pre", dim.notes));
    card.append(detail); return card;
  });
  $("cleanup-items").replaceChildren(...(cards.length ? cards : [node("p", "No items match this filter. Incomplete evidence remains protected or under review.")]));
}

async function load() {
  busy = true; analysis = null; selected.clear(); controls(); error("");
  $("cleanup-items").replaceChildren(); $("cleanup-counts").textContent = "Loading cleanup…";
  try {
    const response = await fetch("/api/cleanup"); const body = await response.json();
    if (!response.ok) throw new Error(body.error || "Unable to load cleanup.");
    analysis = body; page = 0;
    $("cleanup-counts").textContent = Object.entries(body.counts).map(([name, count]) => `${name}: ${count}`).join(" · ");
    $("cleanup-limitations").textContent = body.limitations.join(" ");
  } catch (failure) { error(failure.message); $("cleanup-counts").textContent = "Cleanup unavailable"; }
  finally { busy = false; render(); }
}

async function post(url, body) {
  return fetch(url, { method: "POST", headers: { "Content-Type": "application/json", "X-Local-Request": "1" }, body: JSON.stringify(body) });
}

$("dim-import").addEventListener("submit", async (event) => {
  event.preventDefault();
  const file = $("dim-file").files[0]; if (!file || busy) return;
  busy = true; selected.clear(); controls(); error("");
  try {
    if (file.size > 10 * 1024 * 1024) throw new Error("CSV exceeds the 10 MiB limit.");
    const response = await post("/api/dim/import", { csv: await file.text() }); const body = await response.json();
    if (!response.ok) throw new Error(body.error || "DIM import failed.");
    $("import-status").textContent = `${body.matched} matched · ${body.preserved} preservation tags retained · ${body.skipped.length} unmatched or ambiguous rows skipped${body.skipped.length ? `: ${body.skipped.join(", ")}` : ""}`;
    await load();
  } catch (failure) { error(failure.message); }
  finally { busy = false; controls(); }
});

$("export-dim").addEventListener("click", async () => {
  if (!analysis || !selected.size || busy) return;
  busy = true; controls(); error("");
  try {
    const response = await post("/api/dim/export", { selectedIds: [...selected], revision: analysis.revision });
    if (!response.ok) throw new Error((await response.json()).error || "DIM export failed.");
    const url = URL.createObjectURL(await response.blob()); const link = node("a"); link.href = url; link.download = "dim-cleanup.csv";
    document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (failure) { selected.clear(); render(); error(failure.message); }
  finally { busy = false; controls(); }
});
for (const id of ["classification", "cleanup-type", "cleanup-query"]) $(id).addEventListener(id === "cleanup-query" ? "input" : "change", () => { page = 0; render(); });
$("reload-cleanup").addEventListener("click", load);
$("cleanup-previous").addEventListener("click", () => { page--; render(); });
$("cleanup-next").addEventListener("click", () => { page++; render(); });
load();
