const $ = (id) => document.getElementById(id);
function node(tag, text, className) {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  if (className) element.className = className;
  return element;
}
function bullets(values) {
  const list = node("ul");
  values.forEach((value) => list.append(node("li", value)));
  return list;
}
async function load() {
  $("reload").disabled = true;
  $("error").hidden = true;
  try {
    const response = await fetch("/api/new-loot");
    const data = await response.json();
    if (!response.ok) throw new Error(data.error ?? "Unable to analyze new loot.");
    $("since").textContent = data.status === "COMPARED" ? `Since ${new Date(data.previousSnapshot).toLocaleString()} · Current ${new Date(data.currentSnapshot).toLocaleString()}` :
      data.status === "BASELINE" ? "Baseline saved. Refresh or import again after playing to see new loot." : "Snapshots cannot be compared. See evidence and limitations.";
    const c = data.counts;
    $("summary").textContent = `${c.acquired} first seen · ${c.improved} improvements · ${c.keep} keep / protected · ${c.probablyRedundant} probably redundant · ${c.review} review. Vault stacks: ${data.vault.previous ?? "unknown"} → ${data.vault.current}.`;
    $("items").replaceChildren(...data.acquired.map((item) => {
      const card = node("article", undefined, "notice");
      card.append(node("h3", `${item.name} · ${item.recommendation.replaceAll("_", " ")}`), node("p", `${item.location} · ${item.itemId}`), node("p", `Selected: ${item.selectedPerks.join(" + ") || "none recorded"}`));
      for (const improvement of item.improvements) card.append(node("p", `Better for ${improvement.role}${improvement.currentScore === null ? "" : `: ${improvement.previousBest} → ${improvement.currentScore}`}${improvement.provisional ? " (provisional local ratings)" : ""}. Compared with ${improvement.comparedItemIds.join(", ")}.`), bullets(improvement.evidence));
      card.append(bullets(item.reasons));
      if (item.uniqueThings.length) card.append(node("h4", "Unique / preserved evidence"), bullets(item.uniqueThings));
      if (item.unknowns.length) card.append(node("h4", "Needs verification"), bullets(item.unknowns));
      if (item.betterOwnedAlternatives.length) card.append(node("h4", "Better copies you own"), bullets(item.betterOwnedAlternatives.map((a) => `${a.name} [${a.itemId}]: ${a.reasons.join("; ")}`)));
      if (item.buildsAffected.length) card.append(node("p", `Builds referenced: ${item.buildsAffected.join(", ")}`));
      return card;
    }));
    if (!data.acquired.length) $("items").append(node("p", data.status === "COMPARED" ? "No newly seen instanced gear in this comparison." : "No new-item claims until comparable snapshots are available."));
    $("builds").replaceChildren(...data.improvedBuilds.map((b) => node("p", `${b.name}: ${b.previousScore} → ${b.currentScore}${b.newlyReady ? " · newly READY NOW" : ""}`)));
    if (!data.improvedBuilds.length) $("builds").append(node("p", "No build fit improvements established."));
    $("absent-summary").textContent = `${c.currentlyAbsent} currently absent`;
    $("absent").replaceChildren(...data.currentlyAbsent.map((item) => node("li", `${item.name} [${item.itemId}] · previously ${item.location}`)));
    $("limitations").replaceChildren(...data.limitations.map((value) => node("li", value)));
  } catch (error) {
    $("error").textContent = error.message;
    $("error").hidden = false;
    $("summary").textContent = "New loot report unavailable. Reload after resolving the error.";
    // A stale report should never appear to describe a completed refresh.
    ["items", "builds", "absent", "limitations"].forEach((id) => $(id).replaceChildren());
  } finally { $("reload").disabled = false; }
}
$("reload").addEventListener("click", load);
load();
