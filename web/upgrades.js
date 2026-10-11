const $ = (id) => document.getElementById(id);
function node(tag, text) {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
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
    const response = await fetch("/api/upgrades"), data = await response.json();
    if (!response.ok) throw new Error(data.error ?? "Unable to analyze acquisition pursuits.");
    $("summary").textContent = `${data.pursuits.length} confirmed missing pursuits · ${data.verification.length} ownership checks · ${data.unavailable.length} unavailable · ${data.deferred.length} without modeled benefit. Current ${data.characterClass} account snapshot.`;
    $("ranking-policy").textContent = data.rankingPolicy;
    $("pursuits").replaceChildren(...data.pursuits.map((item) => {
      const card = node("article"); card.className = "notice";
      card.append(node("h3", `${item.rank}. ${item.name}`),
        node("p", `Unlocks ${item.buildsUnlocked} ready builds · ${item.requiredBuildsImproved} major required-gear gaps · ${item.optionalAlternatives} optional alternatives`),
        node("p", `Estimated effort: ${item.effort} · Value: ${item.marginalValue} · Value / effort: ${item.valuePerEffort ?? "unknown (benefit-only queue)"}`),
        node("p", `Availability: ${item.availability} · Source: ${item.source ?? "unknown"} · Evidence: ${item.metadata?.confidence ?? "unknown"} · Verified: ${item.metadata?.verifiedAt ?? "not verified"}`));
      if (item.metadata) card.append(bullets([...item.metadata.sources.map((source) => `Source evidence: ${source}`), ...item.metadata.notes]));
      for (const impact of item.impacts) {
        const details = node("details");
        details.append(node("summary", `${impact.buildName} · ${impact.kind} · ${impact.unlocksReadyBuild ? "ready after gear" : impact.readinessAfter}`),
          node("p", `Gear-fit +${impact.scoreGain}; magnitude ${impact.magnitude} × preference ${impact.preferenceMatch} × substitute ${impact.substituteFactor} = ${impact.contribution}. Template: ${impact.templateConfidence}.`),
          node("p", `Owned substitutes: ${impact.existingSubstitutes.map((entry) => `${entry.name} [${entry.itemIds.join(", ")}]`).join("; ") || "none confirmed"}`),
          node("p", `Remaining blockers: ${impact.blockers.join("; ") || "none in baseline matcher"}`), bullets(impact.reasons));
        card.append(details);
      }
      card.append(node("h4", "Next steps"), bullets(item.nextSteps));
      return card;
    }));
    if (!data.pursuits.length) $("pursuits").append(node("p", "No confirmed missing eligible items. Check ownership evidence and source exclusions below."));
    $("verification").replaceChildren(...data.verification.map((item) => node("p", `${item.name}: ${item.reasons.join("; ")}`)));
    $("unavailable").replaceChildren(...data.unavailable.map((item) => node("p", `${item.name}: ${item.source ?? "source unspecified"}; verified ${item.metadata?.verifiedAt ?? "unknown"}. ${item.nextSteps[0]}`)));
    $("deferred").replaceChildren(...data.deferred.map((item) => node("p", `${item.name}: no modeled marginal benefit under current preferences. Review your preferences before farming.`)));
    $("provenance").textContent = `Analysis ${data.analysisVersion}; snapshot ${data.provenance.snapshotId}; manifest ${data.provenance.manifestVersion}; config ${data.provenance.acquisitionConfigVersion}. Full reproducibility versions are included in the JSON download.`;
    $("limitations").replaceChildren(...data.limitations.map((value) => node("li", value)));
  } catch (error) {
    $("error").textContent = error.message; $("error").hidden = false;
    $("summary").textContent = "Acquisition planner unavailable. Resolve the error and reload.";
    ["pursuits", "verification", "unavailable", "deferred", "limitations"].forEach((id) => $(id).replaceChildren());
    ["ranking-policy", "provenance"].forEach((id) => { $(id).textContent = ""; });
  } finally { $("reload").disabled = false; }
}
$("reload").addEventListener("click", load);
load();
